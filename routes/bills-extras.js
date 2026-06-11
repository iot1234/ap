// routes/bills-extras.js
// Every /api/bills/* endpoint, in one place. Previously most of these
// lived inline in server.js (GET list, POST create, /render, /void,
// /unmark-paid) while the bulk + send + slip helpers lived here — the
// split made it hard to see which path a bill takes from creation to
// payment to void. They're consolidated here so search-by-route lands
// in the same file every time.
//
// Endpoints (mount = '/api/bills' from routes/index.js):
//   GET  /                         — admin list (+ optional withPayments)
//   POST /                         — admin create (compute or persist)
//   POST /render                   — admin PDF render
//   PUT  /:id/void                 — admin voids a bill (reverses verified)
//   POST /:id/unmark-paid          — admin reverses a paid → pending/overdue
//   POST /:id/pay                  — admin records offline payment
//   POST /:id/send                 — enqueue LINE/email for one bill
//   POST /:id/verify-slip          — admin verifies/rejects latest slip
//   GET  /:id/send-readiness       — preflight (issues + history)
//   GET  /send-readiness-batch     — bulk preflight by period
//   POST /bulk-generate            — generate bills for occupied rooms
//   POST /bulk-send                — enqueue notifications for all overdue
//
// Helpers that travelled with the moved endpoints: getRenderBillId,
// buildStoredBillPdfObject, numOrNull, storedUtilityUsage,
// loadRecurringFor, notifyBillVoided. Cross-file helpers
// (acquirePdfSlot, loadEffectivePaymentBlock, sanitizeError) are wired
// in via ctx so we don't duplicate them — server.js still uses the same
// originals for tenant-side PDFs, QR endpoints, and config fetches.

const express = require('express');
const billing = require('../services/billing');
const features = require('../services/features');
const meter = require('../services/meter');
const notifier = require('../services/notifier');
const email = require('../services/email');
const notifQueue = require('../services/notificationQueue');
const promptpay = require('../services/promptpay');
const { MAX_AMOUNT } = promptpay;
const lineNotify = require('../services/line');
// Manual mark-paid (POST /api/bills/:id/pay) now accepts an optional slip
// dataUrl so admin can attach a receipt photo even for cash / external
// transfers. Same storage path the tenant slip upload uses.
const storage = require('../services/storage');
const { renderBillPdf } = require('../services/pdf');
const { schemas } = require('../schemas');
const { validateBody } = require('../middleware/validate');
const billPayments = require('../services/billPayments');
// Pure due-date helper shared with the scheduler so bulk-generate and the
// nightly auto-gen agree on "due day already passed this month" handling
// (services/scheduler.js exports it side-effect-free; jobs start only via
// start()).
const { billGenDueDateFor } = require('../services/scheduler');

function billEmailReady(flags) {
  return email.isConfigured(flags || {});
}

function billEmailConfigIssue(tenantName) {
  return {
    sev: 'high',
    code: 'EMAIL_NOT_CONFIGURED',
    msg: `ผู้เช่า "${tenantName || '-'}" มีอีเมล แต่ระบบอีเมลยังไม่พร้อมใช้งาน`,
    fix: 'เปิด email.enabled และตั้งค่า SMTP_HOST / SMTP_USER / SMTP_PASS / SMTP_FROM ให้ครบก่อนส่งทางอีเมล หรือผูก LINE ให้ผู้เช่า',
  };
}

// ---- Small helpers that only POST /render + GET /:id (PDF rebuild) use --
function numOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Adapter for bills-table snake_case rows. Delegates to billing service so
// the readings normalisation (anomaly flags, NaN guards) is shared with the
// tenant-side renderer in server.js.
function storedUtilityUsage(b, prefix) {
  return billing.resolveUtilityUsageFromBillRow(b, prefix);
}

function getRenderBillId(req, bill) {
  const candidates = [
    req.body?.billId,
    req.body?.dbBillId,
    bill?.dbBillId,
    bill?.billId,
  ];
  for (const value of candidates) {
    const id = Number(value);
    if (Number.isInteger(id) && id > 0) return id;
  }
  return null;
}

async function restoreAccessCardsAfterPayment(pool, tenantId, flagsHint, reason) {
  if (!tenantId) return;
  try {
    const flags = flagsHint || await features.load(pool).catch(() => ({}));
    const rawThreshold = Number(flags?.accessControl?.overdueDaysThreshold);
    const threshold = Number.isFinite(rawThreshold) ? rawThreshold : 30;
    await require('../services/scheduler').restoreAccessCardsForTenantIfClear(pool, tenantId, {
      threshold,
      notifier,
      flags,
      audit: async (entry) => {
        await pool.query(
          `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [entry.actor, entry.action, entry.entity, entry.entityId, JSON.stringify(entry.details || {})]
        ).catch(() => {});
      },
    });
  } catch (err) {
    console.warn(`[bills.${reason || 'payment'}] access-card restore failed:`, err.message);
  }
}

function buildStoredBillPdfObject(b, config, paymentBlock) {
  const items = [
    { label: 'ค่าเช่าห้องพัก', qty: '1 เดือน', amount: Number(b.rent) || 0 },
    billing.buildUtilityItem('ค่าน้ำ', storedUtilityUsage(b, 'water'), Number(b.water_rate) || 0, Number(b.water_amount) || 0),
    billing.buildUtilityItem('ค่าไฟฟ้า', storedUtilityUsage(b, 'elec'), Number(b.elec_rate) || 0, Number(b.elec_amount) || 0),
  ];
  if (Number(b.wifi) > 0) {
    items.push({ label: 'ค่าอินเทอร์เน็ต', qty: '1 เดือน', amount: Number(b.wifi) });
  }
  let otherList = Array.isArray(b.other) ? b.other : [];
  if (!Array.isArray(b.other) && typeof b.other === 'string') {
    try {
      const parsed = JSON.parse(b.other);
      if (Array.isArray(parsed)) otherList = parsed;
    } catch { /* keep empty */ }
  }
  for (const it of otherList) {
    const amt = Number(it.amount) || 0;
    if (amt > 0) {
      items.push({
        label: String(it.label || 'อื่นๆ'),
        qty: it.qty == null ? '' : String(it.qty),
        detail: it.detail ? String(it.detail) : '',
        amount: amt,
      });
    }
  }
  if (Number(b.late_fee) > 0) {
    items.push({ label: 'ค่าปรับชำระล่าช้า', qty: '', amount: Number(b.late_fee) });
  }
  if (Number(b.vat) > 0) {
    items.push({ label: 'ภาษีมูลค่าเพิ่ม', qty: '', amount: Number(b.vat) });
  }
  return {
    billNo: b.bill_no,
    roomId: b.room_id,
    tenantName: b.tenant_name || '',
    tenantPhone: b.tenant_phone || '',
    period: b.period,
    dueDate: b.due_date,
    items,
    rent: Number(b.rent) || 0,
    waterUnits: Number(b.water_units) || 0,
    waterRate: Number(b.water_rate) || 0,
    waterAmount: Number(b.water_amount) || 0,
    waterPrevReading: numOrNull(b.water_prev_reading),
    waterCurrentReading: numOrNull(b.water_current_reading),
    elecUnits: Number(b.elec_units) || 0,
    elecRate: Number(b.elec_rate) || 0,
    elecAmount: Number(b.elec_amount) || 0,
    elecPrevReading: numOrNull(b.elec_prev_reading),
    elecCurrentReading: numOrNull(b.elec_current_reading),
    wifi: Number(b.wifi) || 0,
    subtotal: Number(b.subtotal) || 0,
    vat: Number(b.vat) || 0,
    lateFee: Number(b.late_fee) || 0,
    total: Number(b.total) || 0,
    status: b.status,
    paidAt: b.paid_at,
    building: (config && config.building) || {},
    ...paymentBlock,
  };
}

// Helper used by bill generation (manual + scheduler) to load active
// charges that apply to a given (tenantId, roomId) combo. one_off charges
// are returned only if they haven't been billed yet (we mark them
// inactive after their first inclusion — see POST / below).
async function loadRecurringFor(pool, { tenantId, roomId }) {
  const params = [];
  const where = ['active = TRUE'];
  const ors = [];
  if (tenantId) { params.push(tenantId); ors.push(`tenant_id = $${params.length}`); }
  if (roomId)   { params.push(roomId);   ors.push(`room_id = $${params.length}`); }
  if (!ors.length) return [];
  where.push(`(${ors.join(' OR ')})`);
  const { rows } = await pool.query(
    `SELECT id, label, amount, frequency, start_at, end_at FROM recurring_charges
       WHERE ${where.join(' AND ')} ORDER BY created_at ASC`,
    params
  );
  return rows;
}

// Rerun/resubmit safety for one_off charges. The FIRST generation run folds
// a one_off into the bill and flips it active=FALSE; a rerun's active=TRUE
// recurring load no longer sees it, so the recomputed bill would silently
// drop the line while the charge row stays inactive — the amount would never
// be billed anywhere. A line is resurrected only when it is BOTH on the
// existing bill's `other` AND backed by an inactive one_off row for the same
// tenant/room (one row backs one line). Lines the current run already
// produces (charge still active / admin-reactivated) are never doubled, and
// unmatched display lines (e.g. 'ค่าส่วนกลาง') pass through untouched.
function matchConsumedOneOffLines(existingOther, currentList, inactiveOneOffs) {
  let existingItems = Array.isArray(existingOther) ? existingOther : [];
  if (!Array.isArray(existingOther) && typeof existingOther === 'string') {
    try {
      const parsed = JSON.parse(existingOther);
      existingItems = Array.isArray(parsed) ? parsed : [];
    } catch { existingItems = []; }
  }
  const sameLine = (a, b) =>
    String(a?.label || '') === String(b?.label || '')
    && Math.abs((Number(a?.amount) || 0) - (Number(b?.amount) || 0)) <= billing.PAYMENT_TOLERANCE_THB;
  const candidates = (Array.isArray(inactiveOneOffs) ? inactiveOneOffs : [])
    .map((r) => ({ label: r.label, amount: Number(r.amount) || 0 }));
  const current = Array.isArray(currentList) ? [...currentList] : [];
  const kept = [];
  for (const item of existingItems) {
    const dupIdx = current.findIndex((x) => sameLine(x, item));
    if (dupIdx !== -1) { current.splice(dupIdx, 1); continue; }
    const matchIdx = candidates.findIndex((x) => sameLine(x, item));
    if (matchIdx === -1) continue;
    candidates.splice(matchIdx, 1);
    kept.push({ label: String(item.label || ''), amount: Number(item.amount) || 0 });
  }
  return kept;
}

// DB side of the merge above: pull this tenant/room's inactive one_offs and
// match them against the existing bill's stored lines. Carries reversed by
// void/unmark-paid carry the reversed marker in notes and stay gone — their
// source bill no longer owes them (carries consumed by bill-gen have no
// marker, so a legitimately billed carry line survives the rerun).
async function consumedOneOffLinesForBill(client, { tenantId, roomId, existingOther, currentList }) {
  const params = [];
  const ors = [];
  if (tenantId) { params.push(tenantId); ors.push(`tenant_id = $${params.length}`); }
  if (roomId)   { params.push(roomId);   ors.push(`room_id = $${params.length}`); }
  if (!ors.length) return [];
  params.push(billPayments._carriedLateFeeReversedMarker);
  try {
    const { rows } = await client.query(
      `SELECT label, amount FROM recurring_charges
         WHERE active = FALSE AND frequency = 'one_off'
           AND (${ors.join(' OR ')})
           AND POSITION($${params.length} IN COALESCE(notes, '')) = 0`,
      params
    );
    return matchConsumedOneOffLines(existingOther, currentList, rows);
  } catch (err) {
    if (err.code === '42P01') return [];   // legacy deploy without the table
    throw err;
  }
}

// Late fees are OWNED by scheduler.tickLateFee and accrue in-place on the
// existing bill — buildBill always returns lateFee:0, so regenerating a bill
// must carry the accrued fee over instead of treating it as drift (which
// silently waived the fee with no waive decision and no audit entry). The
// fee survives while the bill stays past due; a due date moved to today or
// the future means the bill is no longer late, so the fee resets and a
// stale 'overdue' flips back to 'pending'. pending → overdue is NOT done
// here: that flip stays with the scheduler tick, which also notifies the
// tenant and assesses the initial fee.
function regenPreservedLateFeeAndStatus(existing, dueDate, now = new Date()) {
  const dueDateStatus = billing.statusOf({ paid_at: null, due_date: dueDate }, now);
  const lateFee = dueDateStatus === 'overdue' ? (Number(existing?.late_fee) || 0) : 0;
  const status = (existing?.status === 'overdue' && dueDateStatus === 'pending')
    ? 'pending'
    : existing?.status;
  return { lateFee, status };
}

function billTenantCanReceiveDebtNotice(status) {
  return status === 'active' || status === 'moved_out';
}

function billTenantRoomStillMatches(b) {
  if (b.tenant_status === 'moved_out') return true;
  if (b.tenant_status !== 'active') return false;
  if (!b.tenant_current_room) return false;
  return String(b.tenant_current_room) === String(b.room_id);
}

function billTenantRoomMismatchMessage(b) {
  if (!b?.tenant_current_room) {
    return 'ผู้เช่าสถานะ active แต่ยังไม่ได้ผูกห้องปัจจุบัน (current_room_id ว่าง)';
  }
  return `ผู้เช่าย้ายห้องไปแล้ว (ปัจจุบันอยู่ห้อง ${b.tenant_current_room}, บิลเป็นของห้อง ${b.room_id})`;
}

function billTenantRoomMismatchHint(b) {
  if (!b?.tenant_current_room) {
    return 'ไปที่ /admin#tenants แล้วผูกผู้เช่ากับห้องปัจจุบันก่อนส่งบิล';
  }
  return 'ตรวจสอบว่าบิลห้องเก่าควรส่งให้ผู้เช่าคนใหม่ของห้อง — ไม่ใช่ผู้เช่าเก่าที่ย้าย';
}

module.exports = function buildBillsExtrasRouter(ctx) {
  const {
    pool, requireAuth, requireRole, sameOrigin, csrfGuard, audit,
    signBillQrToken, signBillPayToken,
    // Server-side singletons handed through ctx so we don't duplicate
    // the PDF concurrency latch or the payment-block builder.
    acquirePdfSlot, releasePdfSlot,
    loadBillingConfig, loadEffectivePaymentBlock, buildEffectivePaymentBlock,
    sanitizeError,
  } = ctx;
  const r = express.Router();

  function parseBillingPeriod(raw) {
    const period = raw != null ? String(raw).trim().slice(0, 16) : billing.formatPeriodNow();
    const m = period.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
    if (!m) return null;
    const year = Number(m[1]);
    if (year < 2020 || year > 2100) return null;
    return { period, year, month: Number(m[2]) };
  }

  async function activeTenantForRoom(client, roomId, blobTenant) {
    try {
      const tq = await client.query(
        `SELECT id, full_name, phone
           FROM tenants
          WHERE current_room_id=$1 AND status='active' AND deleted_at IS NULL
          ORDER BY updated_at DESC LIMIT 1`,
        [roomId]
      );
      if (tq.rows[0]) {
        return {
          id: tq.rows[0].id,
          name: tq.rows[0].full_name || blobTenant?.name || '',
          phone: tq.rows[0].phone || blobTenant?.phone || '',
        };
      }
    } catch { /* legacy deploy without tenants table */ }
    return blobTenant || null;
  }

  async function activeContractForRoom(client, roomId, period = null) {
    // start_date filter: a queued RENEWAL contract (created ahead of time,
    // starting after the current one ends) must not hijack this period's
    // rent/discount/due-day before it actually begins. Callers that don't
    // know the period keep the legacy newest-first behavior.
    const periodFilter = /^\d{4}-\d{2}$/.test(String(period || '')) ? String(period) : null;
    try {
      const cq = await client.query(
        // contract_due_day: the due day the tenant SIGNED (printed on the
        // contract PDF). Only locked contracts carry the snapshot — an
        // unsigned draft must not override the operator's setting yet.
        // resolveBillDueDay validates/clamps; NULL falls through.
        `SELECT id, monthly_rent, discount_pct, status, start_date,
                CASE WHEN locked_at IS NOT NULL
                     THEN (terms_template_snapshot->'financials'->>'dueDay')::numeric
                END AS contract_due_day
           FROM contracts
          WHERE room_id=$1 AND status='active' AND deleted_at IS NULL
            AND ($2::text IS NULL OR start_date IS NULL OR to_char(start_date, 'YYYY-MM') <= $2)
          ORDER BY start_date DESC LIMIT 1`,
        [roomId, periodFilter]
      );
      return cq.rows[0] || null;
    } catch {
      return null;
    }
  }

  // Expired-contract continuation for the bulk/preview paths — a tenant who
  // stayed past a fixed term (no renewal yet) keeps their SIGNED rate and
  // SIGNED due day, exactly like the scheduler + single-bill paths already
  // do. Without this, bulk-generate silently jumped a stay-on tenant's rent
  // to the current formula the day their contract expired. Scoped to the
  // resident tenant so a previous tenant's old contract can't leak into a
  // new occupant's bill.
  async function expiredContractForRoom(client, roomId, tenantId) {
    try {
      const eq = await client.query(
        `SELECT id, monthly_rent, discount_pct, status,
                CASE WHEN locked_at IS NOT NULL
                     THEN (terms_template_snapshot->'financials'->>'dueDay')::numeric
                END AS contract_due_day
           FROM contracts
          WHERE room_id=$1 AND status='expired' AND deleted_at IS NULL
            AND ($2::bigint IS NULL OR tenant_id=$2)
          ORDER BY end_date DESC NULLS LAST, start_date DESC LIMIT 1`,
        [roomId, tenantId || null]
      );
      const row = eq.rows[0];
      return row && Number(row.monthly_rent) > 0 ? row : null;
    } catch {
      return null;
    }
  }

  function firstMonthBillingIssue(period, rooms) {
    return {
      sev: 'info',
      code: 'FIRST_MONTH_WELCOME_BILL',
      msg: `${rooms.length} ห้องเป็นเดือนแรกของสัญญา — ระบบจะไม่ออกบิลรายเดือนซ้ำ เพราะบิลย้ายเข้าและเลขมิเตอร์ตั้งต้นดูแลรอบนี้แล้ว`,
      fix: 'ตรวจบิลย้ายเข้าที่แท็บบิล หรือออกบิลด้วยมือเฉพาะกรณีพิเศษ',
      detail: { period, count: rooms.length, rooms: rooms.slice(0, 20) },
    };
  }

  async function firstMonthRoomsForPeriod(client, eligibleRooms, period) {
    const roomIds = eligibleRooms.map((r) => String(r?.id || '')).filter(Boolean);
    if (!roomIds.length) return { ids: new Set(), rooms: [] };
    try {
      const cq = await client.query(
        `SELECT DISTINCT ON (room_id) id, room_id, tenant_id, start_date
           FROM contracts
          WHERE room_id = ANY($1::text[])
            AND status='active' AND deleted_at IS NULL
          ORDER BY room_id, start_date DESC NULLS LAST, id DESC`,
        [roomIds]
      );
      const ids = new Set();
      const rooms = [];
      for (const contract of cq.rows || []) {
        if (!billing.contractStartsInPeriod(contract, period)) continue;
        const room = eligibleRooms.find((r) => String(r?.id || '') === String(contract.room_id || ''));
        ids.add(String(contract.room_id));
        rooms.push({
          roomId: String(contract.room_id),
          tenant: room?.tenant?.name || '',
          contractId: contract.id || null,
          tenantId: contract.tenant_id || null,
        });
      }
      return { ids, rooms };
    } catch (err) {
      if (err.code !== '42P01' && err.code !== '42703') throw err;
      return { ids: new Set(), rooms: [] };
    }
  }

  function billPreviewPayload(bill, recurringList, room, periodDisplay) {
    const previewCharges = Number(bill.paymentReferenceCents) > 0
      ? billing.appendPaymentReferenceLine(recurringList, bill.paymentReferenceCents)
      : (Array.isArray(recurringList) ? recurringList : []);
    return {
      id: bill.billNo || `INV-${bill.period}-${bill.roomId}`,
      billNo: bill.billNo,
      roomId: bill.roomId,
      tenantId: room?.tenant?.id || null,
      tenant: bill.tenantName,
      phone: bill.tenantPhone,
      period: bill.period,
      periodDisplay,
      rent: bill.rent,
      rentBase: bill.rentBase,
      rentSource: bill.rentSource,
      rentSourceContractId: bill.rentSourceContractId,
      rentSourceReason: bill.rentSourceReason,
      water: bill.waterAmount,
      waterUnits: bill.waterUnits,
      waterRate: bill.waterRate,
      waterMode: bill.waterMode,
      waterFlatFellBack: bill.waterFlatFellBack,
      waterPrevReading: bill.waterPrevReading,
      waterCurrentReading: bill.waterCurrentReading,
      elec: bill.elecAmount,
      elecUnits: bill.elecUnits,
      elecRate: bill.elecRate,
      elecMode: bill.elecMode,
      elecFlatFellBack: bill.elecFlatFellBack,
      elecPrevReading: bill.elecPrevReading,
      elecCurrentReading: bill.elecCurrentReading,
      wifi: bill.wifi,
      commonFee: bill.commonFee || 0,
      charges: previewCharges,
      chargesTotal: previewCharges.reduce((sum, x) => sum + (Number(x.amount) || 0), 0),
      subtotal: bill.subtotal,
      vat: bill.vat,
      penalty: bill.lateFee,
      lateFee: bill.lateFee,
      total: bill.total,
      paymentReferenceCents: bill.paymentReferenceCents || 0,
      dueDate: bill.dueDate,
      dueDateDisplay: bill.dueDate,
      status: room?.billPaidAt ? 'paid' : 'unpaid',
      overdueDays: room?.overdueDays || 0,
      _source: 'server-preview',
    };
  }

  // notifyBillVoided lives in the closure (not module scope) because it
  // captures `pool` via the ctx pattern — keeping it here avoids passing
  // pool to a stand-alone helper. Sole caller: PUT /:id/void below.
  async function notifyBillVoided(bill, reason, actor) {
    if (!bill) return;
    const flags = await features.load(pool);
    const amount = Number(bill.total);
    const amountText = Number.isFinite(amount)
      ? amount.toLocaleString('th-TH', { minimumFractionDigits: 2 })
      : '-';
    const lines = [
      `Bill voided: ${bill.bill_no || bill.id}`,
      `Room: ${bill.room_id || '-'}`,
      bill.period ? `Period: ${bill.period}` : null,
      `Amount: THB ${amountText}`,
      reason ? `Reason: ${reason}` : null,
      actor ? `By: ${actor}` : null,
    ].filter(Boolean);

    if (bill.tenant_id) {
      const { rows } = await pool.query(
        `SELECT id, full_name, phone, email, line_user_id, line_oa_id, status
           FROM tenants
          WHERE id=$1 AND deleted_at IS NULL
          LIMIT 1`,
        [bill.tenant_id]
      );
      if (rows.length) {
        await notifier.notifyTenant({ pool, features: flags }, rows[0], {
          subject: 'Bill cancelled',
          text: [
            `Dear ${rows[0].full_name || 'tenant'},`,
            '',
            ...lines,
            '',
            'Please ignore the cancelled bill. Contact the office if you already paid or have questions.',
          ].join('\n'),
          force: true,
        });
      }
    }

    await notifier.notifyOwner({ pool, features: flags }, {
      category: 'billing',
      subject: 'Bill voided',
      text: lines.join('\n'),
    });
  }

  // GET /api/bills — admin list. Filters by status / roomId / period and
  // paginates. `withPayments=1` joins a small per-bill slip summary so the
  // admin billing page can render badges without a second round-trip.
  r.get('/', requireAuth, async (req, res) => {
    const status = req.query.status;
    const params = [];
    const where = ['b.deleted_at IS NULL'];
    if (status && ['pending', 'paid', 'overdue', 'void'].includes(String(status))) {
      params.push(status); where.push(`b.status=$${params.length}`);
    }
    if (req.query.roomId) {
      params.push(String(req.query.roomId).slice(0, 32));
      where.push(`b.room_id=$${params.length}`);
    }
    if (req.query.tenantId) {
      const tenantId = Number(req.query.tenantId);
      if (!Number.isInteger(tenantId) || tenantId < 1) {
        return res.status(400).json({
          error: 'tenantId must be a positive integer',
          code: 'INVALID_TENANT_ID',
          hint: 'ใช้ tenant_id จาก /api/tenants หรือปล่อยว่างแล้วใช้ roomId เฉพาะข้อมูล legacy เท่านั้น',
        });
      }
      params.push(tenantId);
      where.push(`b.tenant_id=$${params.length}`);
    }
    if (req.query.period) {
      params.push(String(req.query.period).slice(0, 16));
      where.push(`b.period=$${params.length}`);
    }
    // Pagination so admins working with > 500 historical bills can page
    // through them. Default 200/page; max 500 (preserves the previous cap).
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    params.push(limit, offset);
    // Opt-in payment summary so the admin billing page can show per-row
    // "📥 สลิปรอตรวจ" / "🤖 ออโต้" / "👤 admin" badges without firing a
    // second request per row. Off by default for backward compat — older
    // callers (reports, exports, CSV) still get the bare bills shape.
    const withPayments = String(req.query.withPayments || '').toLowerCase() === '1'
                       || String(req.query.withPayments || '').toLowerCase() === 'true';
    try {
      const sql = withPayments
        ? `SELECT b.*,
                  t.id AS bill_tenant_id,
                  t.full_name AS bill_tenant_name,
                  t.phone AS bill_tenant_phone,
                  t.email AS bill_tenant_email,
                  t.status AS bill_tenant_status,
                  t.current_room_id AS bill_tenant_current_room_id,
                  t.deleted_at AS bill_tenant_deleted_at,
                  COUNT(p.id) FILTER (WHERE p.status='pending')::int  AS pending_slip_count,
                  COUNT(p.id) FILTER (WHERE p.status='verified')::int AS verified_slip_count,
                  COUNT(p.id) FILTER (WHERE p.status='rejected')::int AS rejected_slip_count,
                  (
                    SELECT verified_by FROM payments
                     WHERE bill_id=b.id AND status='verified'
                     ORDER BY verified_at DESC LIMIT 1
                  ) AS latest_paid_by,
                  (
                    SELECT verified_at FROM payments
                     WHERE bill_id=b.id AND status='verified'
                     ORDER BY verified_at DESC LIMIT 1
                  ) AS latest_paid_at,
                  (
                    SELECT verify_provider FROM payments
                     WHERE bill_id=b.id AND status='verified' AND verify_provider IS NOT NULL
                     ORDER BY verified_at DESC LIMIT 1
                  ) AS latest_paid_provider
             FROM bills b
             LEFT JOIN tenants t ON t.id = b.tenant_id
             LEFT JOIN payments p ON p.bill_id = b.id
            WHERE ${where.join(' AND ')}
            GROUP BY b.id, t.id, t.full_name, t.phone, t.email, t.status,
                     t.current_room_id, t.deleted_at
            ORDER BY b.created_at DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}`
        : `SELECT b.*,
                  t.id AS bill_tenant_id,
                  t.full_name AS bill_tenant_name,
                  t.phone AS bill_tenant_phone,
                  t.email AS bill_tenant_email,
                  t.status AS bill_tenant_status,
                  t.current_room_id AS bill_tenant_current_room_id,
                  t.deleted_at AS bill_tenant_deleted_at
             FROM bills b
             LEFT JOIN tenants t ON t.id = b.tenant_id
            WHERE ${where.join(' AND ')}
            ORDER BY b.created_at DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}`;
      const { rows } = await pool.query(sql, params);
      res.json({ ok: true, bills: rows, limit, offset });
    } catch (err) {
      console.error('bills list error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // POST /api/bills — admin create/upsert. Two modes:
  //   1. `compute:true` with roomId → server reads rooms+config+contract,
  //      pulls recurring rows, runs billing.buildBill, then inserts.
  //   2. fully-formed bill → strict validation then INSERT.
  // The ON CONFLICT path only updates pending/overdue bills with NO
  // verified payments — anything paid/void/locked is refused with
  // BILL_LOCKED_FOR_LEDGER so admin can't silently overwrite a ledger row.
  r.post('/', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    // schemas.generateBill strips unknown keys (Zod default object mode) and
    // validateBody replaces req.body with the stripped result — stash the
    // drift-override escape hatch BEFORE validation runs, otherwise the
    // documented `{ manualOverride: true, overrideReason }` resend is
    // silently discarded and BILL_TOTAL_DRIFT becomes an unrecoverable loop.
    (req, _res, next) => {
      req.billDriftOverride = {
        manualOverride: req.body?.manualOverride === true,
        overrideReason: typeof req.body?.overrideReason === 'string'
          ? req.body.overrideReason : '',
      };
      next();
    },
    validateBody(schemas.generateBill), async (req, res) => {
    const b = req.body || {};
    const flags = await features.load(pool);
    // Admin sends either a fully-formed bill, or roomId+period and we compute it.
    let computed = b;
    // Track which one_off recurring rows we used so we can deactivate them
    // after a successful insert (so they don't appear on next month's bill).
    let usedOneOffIds = [];
    let otherForStorage = Array.isArray(b.other) ? b.other : [];
    // R3 — Defensive recompute: when admin submits a fully-formed bill (no
    // `compute:true`), the server previously trusted every field as-is.
    // A buggy client / curl typo / replayed payload could land bills in the
    // DB with totals that don't match the resolver. We mark this drift
    // below and reject unless admin explicitly opts into manual override.
    //
    // The drift report is attached to the audit log so a tenant dispute
    // "why is my bill X฿?" months later can be traced to who clicked
    // "force submit" with what override reason.
    let driftReport = null;
    if (b.compute && b.roomId) {
      const [roomsRow, configRow] = await Promise.all([
        pool.query(`SELECT value FROM app_data WHERE key='baankarn_rooms_v1'`),
        pool.query(`SELECT value FROM app_data WHERE key='baankarn_config_v1'`),
      ]);
      const roomsObj = roomsRow.rows.length ? roomsRow.rows[0].value : {};
      const config = configRow.rows.length ? configRow.rows[0].value : {};
      const room = roomsObj[b.roomId] || (Object.values(roomsObj || {}).find((r) => r.id === b.roomId));
      if (!room) return res.status(404).json({ error: 'room not found' });
      // R2 — previous overdue bill lookup is GONE. Late fees are owned by
      // scheduler.tickLateFee and live on the old bill (updated in-place).
      // Every new bill starts with late_fee=0; carrying penalties forward
      // confused tenants who saw a stale total on the OLD bill that
      // didn't match what was actually owed.
      // B1 — auto-load recurring charges if recurringCharges flag on and the
      // caller didn't explicitly pass `recurring`. Resolve the active tenant
      // first so per-tenant charges (parking, cleaning) match the right person.
      // buildBill folds recurring amounts into subtotal/total ONLY when the
      // recurringCharges flag is on — mirror that gate here, otherwise the
      // stored bill (and its PDF reconstruction) renders `other` line items
      // whose amounts are NOT in the total the tenant is asked to pay.
      let recurringList = flags.recurringCharges?.enabled && Array.isArray(b.recurring)
        ? b.recurring : [];
      if (Array.isArray(b.recurring) && !Array.isArray(b.other)) {
        otherForStorage = recurringList;
      }
      // Resident tenant for this room — resolved once and reused for both the
      // recurring-charge lookup and the expired-contract rate fallback below.
      // Hoisted to this scope (was previously local to the recurringCharges
      // block) so the expired-contract lookup can scope to the right tenant.
      let tid = b.tenantId || null;
      if (!tid) {
        try {
          const tq = await pool.query(
            `SELECT id FROM tenants WHERE current_room_id=$1 AND status='active' AND deleted_at IS NULL
               ORDER BY updated_at DESC LIMIT 1`,
            [b.roomId]
          );
          if (tq.rows.length) tid = tq.rows[0].id;
        } catch { /* ignore */ }
      }
      if (flags.recurringCharges?.enabled && flags.recurringCharges?.autoIncludeOnBillGen !== false && !b.recurring) {
        const dbRecurring = await loadRecurringFor(pool, { tenantId: tid, roomId: b.roomId });
        // Honor `frequency` so quarterly charges only land on bills for the
        // appropriate quarter (every 3 months from start_at) — previously
        // every recurring row was added every month regardless of frequency,
        // silently overcharging tenants with quarterly fees.
        const periodForFilter = b.period || billing.formatPeriodNow();
        const applicable = dbRecurring.filter((r) => billing.isChargeApplicableForPeriod(r, periodForFilter));
        recurringList = applicable.map((r) => ({ label: r.label, amount: Number(r.amount) }));
        otherForStorage = recurringList;
        // Only deactivate one_off charges that actually got billed this period.
        usedOneOffIds = applicable.filter((r) => r.frequency === 'one_off').map((r) => r.id);
        // Resubmit/double-click safety: a one_off consumed by an earlier
        // submission for this slot is active=FALSE now, so it vanished from
        // the load above — resurrect the line items the existing bill
        // already carries, or the ON CONFLICT update would rewrite the bill
        // without them and the charge would never be billed anywhere.
        const slotQ = await pool.query(
          `SELECT other FROM bills
            WHERE room_id=$1 AND period=$2
              AND COALESCE(tenant_id, 0)=COALESCE($3::bigint, 0)
              AND deleted_at IS NULL AND status <> 'void'
            ORDER BY created_at DESC LIMIT 1`,
          [b.roomId, periodForFilter, tid]
        );
        if (slotQ.rows[0]) {
          const consumedLines = await consumedOneOffLinesForBill(pool, {
            tenantId: tid, roomId: b.roomId,
            existingOther: slotQ.rows[0].other, currentList: recurringList,
          });
          if (consumedLines.length) {
            recurringList = [...recurringList, ...consumedLines];
            otherForStorage = recurringList;
          }
        }
      }
      // Resolve the active contract for BOTH discount_pct (legacy: contract-
      // length discount) AND monthly_rent (NEW: locked rate from signing —
      // services/pricing.js prefers this over room.rent/formula so admin
      // changing /admin#pricing mid-contract doesn't break existing tenants).
      // Shared helpers keep this path's SQL identical to preview/bulk —
      // including the contract_due_day snapshot column.
      const activeContract = await activeContractForRoom(pool, b.roomId, b.period || billing.formatPeriodNow());
      const expiredContract = activeContract
        ? null
        : await expiredContractForRoom(pool, b.roomId, tid || null);
      const contractForBill = activeContract || expiredContract;
      const discountPct = Number(contractForBill?.discount_pct) || 0;
      // Due date: an explicit b.dueDate from the admin form is a deliberate
      // per-bill decision and wins. When absent, the signed due day governs,
      // then config.notify.dueOnDay — same precedence as every other path.
      let dueDateForBill = b.dueDate;
      if (!dueDateForBill) {
        const due = billing.resolveBillDueDay({
          contractDueDay: contractForBill?.contract_due_day,
          configDueDay: config?.notify?.dueOnDay,
        });
        const pm = String(b.period || billing.formatPeriodNow()).match(/^(\d{4})-(\d{2})$/);
        dueDateForBill = pm
          ? billing.formatYMD(Number(pm[1]), Number(pm[2]), due.day)
          : billing.formatDueDate(due.day);
      }
      const roomForBilling = await meter.attachBillingReadingsForPeriod(pool, room, b.period);
      computed = billing.buildBill({
        room: roomForBilling, contract: activeContract, expiredContract, config, features: flags,
        recurring: recurringList,
        period: b.period, dueDate: dueDateForBill,
        discountPct,
      });
    } else if (b.roomId && b.period && !b.compute) {
      // R3 — Recompute path for fully-formed submissions. Pull the same
      // inputs the compute path would, run buildBill, compare to admin's
      // submitted totals. If they drift beyond PAYMENT_TOLERANCE_THB on
      // any leg (rent / subtotal / vat / late_fee / total), refuse unless
      // admin explicitly sets `manualOverride: true` AND provides a reason.
      // This catches: stale client form, client-side calc bugs, replayed
      // payloads against a room whose contract changed since admin opened
      // the form. False positives are surfaced with the full breakdown so
      // admin can decide intentionally to override (with audit trail).
      try {
        const [roomsRowCheck, configRowCheck] = await Promise.all([
          pool.query(`SELECT value FROM app_data WHERE key='baankarn_rooms_v1'`),
          pool.query(`SELECT value FROM app_data WHERE key='baankarn_config_v1'`),
        ]);
        const roomsObjCheck = roomsRowCheck.rows.length ? roomsRowCheck.rows[0].value : {};
        const configCheck = configRowCheck.rows.length ? configRowCheck.rows[0].value : {};
        const roomCheck = roomsObjCheck[b.roomId]
          || (Object.values(roomsObjCheck || {}).find((r) => r.id === b.roomId));
        if (roomCheck) {
          // Resolve the resident tenant FIRST (same query as the compute
          // path) — tenant-scoped recurring rows (carried late fees are
          // always tenant-scoped) and the stay-on contract fallback below
          // both need it, otherwise a bill that exactly matches what
          // generation produces gets a false BILL_TOTAL_DRIFT.
          let tidCheck = b.tenantId || null;
          if (!tidCheck) {
            try {
              const tq = await pool.query(
                `SELECT id FROM tenants WHERE current_room_id=$1 AND status='active' AND deleted_at IS NULL
                   ORDER BY updated_at DESC LIMIT 1`,
                [b.roomId]
              );
              if (tq.rows.length) tidCheck = tq.rows[0].id;
            } catch { /* legacy: no tenants table */ }
          }
          // Same contract resolution as compute/preview/bulk — INCLUDING the
          // expired-contract continuation, so a stay-on tenant's SIGNED rent
          // isn't flagged as drift against the current formula rate.
          const activeContractCheck = await activeContractForRoom(pool, b.roomId, b.period);
          const expiredContractCheck = activeContractCheck
            ? null
            : await expiredContractForRoom(pool, b.roomId, tidCheck);
          const contractForCheck = activeContractCheck || expiredContractCheck;
          const discountPctCheck = Number(contractForCheck?.discount_pct) || 0;
          let recurringForRecompute = Array.isArray(b.recurring) ? b.recurring : [];
          // Load DB recurring if caller didn't pass any AND flag is on — match
          // the compute:true path's behaviour so the comparison is apples-to-apples.
          if (flags.recurringCharges?.enabled
              && flags.recurringCharges?.autoIncludeOnBillGen !== false
              && !b.recurring) {
            try {
              const dbRec = await loadRecurringFor(pool, { tenantId: tidCheck, roomId: b.roomId });
              const applicable = dbRec.filter((r) => billing.isChargeApplicableForPeriod(r, b.period));
              recurringForRecompute = applicable.map((r) => ({ label: r.label, amount: Number(r.amount) }));
              // One_offs consumed by an earlier run stay part of what
              // generation produces (see the bulk rerun merge) — include
              // them here too so resubmitting that bill doesn't drift.
              const slotQ = await pool.query(
                `SELECT other FROM bills
                  WHERE room_id=$1 AND period=$2
                    AND COALESCE(tenant_id, 0)=COALESCE($3::bigint, 0)
                    AND deleted_at IS NULL AND status <> 'void'
                  ORDER BY created_at DESC LIMIT 1`,
                [b.roomId, b.period, tidCheck]
              );
              if (slotQ.rows[0]) {
                const consumedLines = await consumedOneOffLinesForBill(pool, {
                  tenantId: tidCheck, roomId: b.roomId,
                  existingOther: slotQ.rows[0].other, currentList: recurringForRecompute,
                });
                if (consumedLines.length) {
                  recurringForRecompute = [...recurringForRecompute, ...consumedLines];
                }
              }
            } catch { /* fall back to no recurring */ }
          }
          const roomForBillingCheck = await meter.attachBillingReadingsForPeriod(pool, roomCheck, b.period);
          const recomputed = billing.buildBill({
            room: roomForBillingCheck,
            contract: activeContractCheck,
            expiredContract: expiredContractCheck,
            config: configCheck,
            features: flags,
            recurring: recurringForRecompute,
            period: b.period,
            dueDate: b.dueDate,
            discountPct: discountPctCheck,
          });
          const tol = billing.PAYMENT_TOLERANCE_THB;
          const drifts = [];
          const fields = ['rent', 'subtotal', 'vat', 'lateFee', 'total',
                          'waterAmount', 'elecAmount', 'wifi'];
          for (const f of fields) {
            const submitted = Number(b[f] || 0);
            const expected = Number(recomputed[f] || 0);
            if (Math.abs(submitted - expected) > tol) {
              drifts.push({ field: f, submitted, expected, diff: billing.round2(submitted - expected) });
            }
          }
          if (drifts.length > 0) {
            // Block unless admin opted in. The override flag MUST be paired
            // with a non-trivial reason so the audit log explains WHY the
            // operator chose to bypass — useful for tenant disputes later.
            // Read from the pre-validation stash (see middleware above) —
            // Zod already stripped these keys from req.body.
            if (req.billDriftOverride?.manualOverride !== true) {
              return res.status(412).json({
                error: 'ตัวเลขในบิลที่ส่งไม่ตรงกับที่ระบบคำนวณได้ — ตรวจสอบยอดอีกครั้งก่อนยืนยัน',
                code: 'BILL_TOTAL_DRIFT',
                drifts,
                hint: 'หากตั้งใจส่งค่าที่ต่างจากระบบ (เช่น มี discount พิเศษนอกระบบ) ส่ง { manualOverride: true, overrideReason: "..." } พร้อมคำอธิบาย — ระบบจะ audit log ไว้',
                expected: {
                  rent: recomputed.rent,
                  subtotal: recomputed.subtotal,
                  vat: recomputed.vat,
                  lateFee: recomputed.lateFee,
                  total: recomputed.total,
                },
              });
            }
            const reason = String(req.billDriftOverride?.overrideReason || '').trim();
            if (reason.length < 5) {
              return res.status(400).json({
                error: 'ต้องระบุ overrideReason อย่างน้อย 5 ตัวอักษรเมื่อใช้ manualOverride',
                code: 'OVERRIDE_REASON_REQUIRED',
              });
            }
            // Override accepted — record the drift for the audit log below.
            driftReport = { drifts, reason: reason.slice(0, 500) };
          }
        } else {
          // Room not found in the blob (deleted/renamed since the form was
          // opened, or a crafted roomId). We can't drift-check against a
          // recompute here, but the total = subtotal + vat + late_fee
          // invariant below still guards the ledger from an inconsistent total.
          console.warn(`[bill.create] recompute skipped — room ${b.roomId} not found in blob; relying on ledger invariant`);
        }
      } catch (err) {
        // Defensive — if recompute itself errored, refuse to silently
        // accept the submitted numbers. Operator gets a clear hint to
        // retry with `compute: true`.
        console.warn('[bill.create] recompute check failed:', err.message);
        return res.status(500).json({
          error: 'ไม่สามารถตรวจสอบยอดบิลกับระบบได้ — ลองส่งใหม่ด้วย { compute: true } หรือติดต่อผู้ดูแล',
          code: 'BILL_RECOMPUTE_FAILED',
        });
      }
    }
    billing.applyPaymentReferenceCents(computed, { maxTotal: MAX_AMOUNT });
    // Persist the common-area fee as a visible line in `other` so the stored
    // bill + its PDF reconstruction show it. It is ALREADY folded into
    // computed.subtotal/total by buildBill (so the total=subtotal+vat+late_fee
    // invariant is unaffected); this only adds the display line. Guard against
    // a double-append (ON CONFLICT update re-runs this handler body once).
    const commonFeeAmt = Number(computed.commonFee) || 0;
    if (commonFeeAmt > 0 && !otherForStorage.some((x) => /ส่วนกลาง/.test(String((x && x.label) || '')))) {
      otherForStorage = [...otherForStorage, { label: 'ค่าส่วนกลาง', amount: commonFeeAmt }];
    }
    const paymentRefAmt = Number(computed.paymentReferenceCents) || 0;
    if (paymentRefAmt > 0) {
      otherForStorage = billing.appendPaymentReferenceLine(otherForStorage, paymentRefAmt);
    }
    const totalAmount = Number(computed.total);
    const subtotalAmount = computed.subtotal == null ? totalAmount : Number(computed.subtotal);
    if (!computed.billNo || !computed.roomId || !computed.period || !computed.dueDate
        || !Number.isFinite(totalAmount) || totalAmount <= 0 || totalAmount > MAX_AMOUNT
        || !Number.isFinite(subtotalAmount) || subtotalAmount < 0) {
      return res.status(400).json({
        error: 'billNo, roomId, period, dueDate and a positive total are required',
        code: 'INVALID_BILL_TOTAL',
      });
    }
    const amountFields = [
      'rent', 'waterUnits', 'waterRate', 'waterAmount',
      'elecUnits', 'elecRate', 'elecAmount', 'wifi',
      'vat', 'lateFee',
    ];
    for (const field of amountFields) {
      const n = Number(computed[field] || 0);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({
          error: `invalid nonnegative bill field: ${field}`,
          code: 'INVALID_BILL_AMOUNT',
        });
      }
    }
    // Ledger invariant: a well-formed bill always has total = subtotal + vat +
    // late_fee. Enforce it (within payment tolerance) so a manual / override
    // bill — or one whose drift recompute was skipped because the room is gone
    // — can't persist a total that doesn't match its parts (which would let a
    // tiny payment close a large bill). Only checked when subtotal is explicit;
    // legacy rows that never sent subtotal fall back to total and are skipped.
    if (computed.subtotal != null) {
      const vatN = Number(computed.vat || 0);
      const lateN = Number(computed.lateFee || 0);
      const partsSum = billing.round2(subtotalAmount + vatN + lateN);
      if (Number.isFinite(partsSum)
          && Math.abs(totalAmount - partsSum) > billing.PAYMENT_TOLERANCE_THB) {
        return res.status(400).json({
          error: `ยอดรวมไม่สอดคล้อง: total (${totalAmount}) ≠ subtotal+vat+lateFee (${partsSum})`,
          code: 'BILL_TOTAL_MISMATCH',
        });
      }
    }
    for (const field of ['waterPrevReading', 'waterCurrentReading', 'elecPrevReading', 'elecCurrentReading']) {
      if (computed[field] == null || computed[field] === '') continue;
      const n = Number(computed[field]);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({
          error: `invalid nonnegative bill field: ${field}`,
          code: 'INVALID_BILL_AMOUNT',
        });
      }
    }
    // Auto-link to tenant: if caller didn't pass tenantId explicitly, look up
    // the active tenant currently in this room. This is what makes bills
    // visible in the tenant portal — without it tenant_id stays NULL.
    let tenantId = b.tenantId || null;
    if (!tenantId && computed.roomId) {
      try {
        const t = await pool.query(
          `SELECT id FROM tenants
              WHERE current_room_id=$1 AND status='active' AND deleted_at IS NULL
              ORDER BY updated_at DESC LIMIT 1`,
          [computed.roomId]
        );
        if (t.rows.length) tenantId = t.rows[0].id;
      } catch (err) {
        console.warn('[bill] tenant lookup failed:', err.message);
      }
    }
    const billClient = await pool.connect();
    try {
      await billClient.query('BEGIN');
      let billNoForInsert = computed.billNo;
      if (tenantId && computed.billNo) {
        const existingBillNo = await billClient.query(
          `SELECT tenant_id FROM bills
            WHERE bill_no=$1 AND deleted_at IS NULL
            LIMIT 1
            FOR UPDATE`,
          [computed.billNo]
        );
        const existingTenantId = existingBillNo.rows[0]?.tenant_id;
        if (existingTenantId != null && Number(existingTenantId) !== Number(tenantId)) {
          billNoForInsert = billing.makeBillNo(computed.roomId, computed.period, { tenantId });
          computed.billNo = billNoForInsert;
        }
      }
      // DO UPDATE keeps bills.late_fee — late fees are owned by
      // scheduler.tickLateFee and accrue in-place on the row; a resubmit
      // (buildBill always sends late_fee=0) must not wipe the accrued fee.
      // When the new due date is not past, the bill is no longer late at
      // all, so the fee resets and a stale 'overdue' flips back to
      // 'pending' (total = subtotal + vat + late_fee holds either way).
      const insertBillRow = (billNoArg) => billClient.query(
        `INSERT INTO bills
         (bill_no, tenant_id, room_id, period, rent,
          water_prev_reading, water_current_reading, water_units, water_rate, water_amount,
          elec_prev_reading, elec_current_reading, elec_units, elec_rate, elec_amount,
          wifi, other, subtotal, vat, late_fee, total, due_date, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,$21,$22,'pending')
         ON CONFLICT (bill_no) DO UPDATE SET
           tenant_id=COALESCE(EXCLUDED.tenant_id, bills.tenant_id),
           rent=EXCLUDED.rent,
           water_prev_reading=EXCLUDED.water_prev_reading,
           water_current_reading=EXCLUDED.water_current_reading,
           water_units=EXCLUDED.water_units, water_rate=EXCLUDED.water_rate,
           water_amount=EXCLUDED.water_amount,
           elec_prev_reading=EXCLUDED.elec_prev_reading,
           elec_current_reading=EXCLUDED.elec_current_reading,
           elec_units=EXCLUDED.elec_units,
           elec_rate=EXCLUDED.elec_rate, elec_amount=EXCLUDED.elec_amount,
           wifi=EXCLUDED.wifi, other=EXCLUDED.other,
           subtotal=EXCLUDED.subtotal, vat=EXCLUDED.vat,
           late_fee=CASE WHEN EXCLUDED.due_date < CURRENT_DATE
                         THEN bills.late_fee ELSE 0 END,
           total=EXCLUDED.subtotal + EXCLUDED.vat
                 + (CASE WHEN EXCLUDED.due_date < CURRENT_DATE
                         THEN bills.late_fee ELSE 0 END),
           due_date=EXCLUDED.due_date,
           status=CASE WHEN bills.status='overdue' AND EXCLUDED.due_date >= CURRENT_DATE
                       THEN 'pending' ELSE bills.status END
         WHERE bills.status IN ('pending','overdue')
           AND bills.deleted_at IS NULL
           AND (
             (EXCLUDED.tenant_id IS NULL AND bills.tenant_id IS NULL)
             OR (EXCLUDED.tenant_id IS NOT NULL AND (bills.tenant_id IS NULL OR bills.tenant_id = EXCLUDED.tenant_id))
           )
           AND NOT EXISTS (
             SELECT 1 FROM payments p
              WHERE p.bill_id=bills.id AND p.status='verified'
           )
         RETURNING *`,
        [
          billNoArg, tenantId, computed.roomId, computed.period,
          computed.rent || 0,
          computed.waterPrevReading, computed.waterCurrentReading,
          computed.waterUnits || 0, computed.waterRate || 0, computed.waterAmount || 0,
          computed.elecPrevReading, computed.elecCurrentReading,
          computed.elecUnits || 0, computed.elecRate || 0, computed.elecAmount || 0,
          computed.wifi || 0,
          JSON.stringify(otherForStorage || []),
          subtotalAmount, computed.vat || 0, computed.lateFee || 0,
          totalAmount, computed.dueDate,
        ]
      );
      let { rows } = await insertBillRow(billNoForInsert);
      if (!rows.length) {
        const locked = await billClient.query(
          `SELECT b.id, b.status, b.deleted_at,
                  EXISTS (
                    SELECT 1 FROM payments p
                     WHERE p.bill_id=b.id AND p.status='verified'
                     LIMIT 1
                  ) AS has_verified_payment
             FROM bills b
            WHERE b.bill_no=$1
            LIMIT 1`,
          [computed.billNo]
        );
        const current = locked.rows[0] || {};
        // A void/deleted row keeps its bill_no forever (bill_no is a FULL
        // unique constraint) even though the room/period guard index ignores
        // it — and void-then-recreate is the documented correction flow
        // ("ทำการ void ก่อนถ้าต้องการสร้างใหม่"). Climb a numbered suffix
        // instead of dead-ending the operator with BILL_LOCKED_FOR_LEDGER.
        if (current.status === 'void' || current.deleted_at != null) {
          for (let attempt = 2; attempt <= 5 && !rows.length; attempt++) {
            const retryBillNo = `${computed.billNo}-${attempt}`;
            const retry = await insertBillRow(retryBillNo);
            if (retry.rows.length) {
              rows = retry.rows;
              computed.billNo = retryBillNo;
            }
          }
        }
        if (!rows.length) {
          await billClient.query('ROLLBACK');
          return res.status(409).json({
            error: 'existing bill is locked because it is paid, void, deleted, or has a verified payment',
            code: 'BILL_LOCKED_FOR_LEDGER',
            billId: current.id,
            billStatus: current.status,
            hasVerifiedPayment: !!current.has_verified_payment,
          });
        }
      }
      // B1 — mark consumed one_off recurring charges inactive so they don't
      // appear on next month's bill. This MUST commit atomically with the bill
      // insert: previously it ran as a separate autocommit query AFTER the bill
      // was already committed, so a crash / connection drop in between left the
      // one_off `active=TRUE` and it was billed AGAIN next cycle — a silent
      // double-charge to the tenant. Inside the transaction, a failure here
      // rolls the bill back too, so admin simply retries and stays consistent.
      if (usedOneOffIds.length) {
        await billClient.query(
          `UPDATE recurring_charges SET active=FALSE, updated_at=NOW() WHERE id = ANY($1::bigint[])`,
          [usedOneOffIds]
        );
      }
      await billClient.query('COMMIT');
      audit(req, 'bill.create', 'bill', String(rows[0].id), {
        tenantId,
        autoLinked: !b.tenantId && tenantId,
        // R3 — when manualOverride was used, surface the drift in the
        // audit log so a future dispute can trace WHO accepted WHAT
        // discrepancy and WHY. Without this, the bill row alone wouldn't
        // explain why its total disagrees with the resolver.
        manualOverride: driftReport ? { reason: driftReport.reason, drifts: driftReport.drifts } : null,
      });
      // An upsert can flip a stale 'overdue' back to 'pending' (due date
      // moved into the future) — cascade to the room card immediately,
      // same pattern as /void, instead of waiting for the daily tick.
      if (rows[0].room_id) {
        require('../services/roomStatus').syncRoom(pool, rows[0].room_id, { reason: 'bill-upsert' })
          .catch((err) => console.warn('[bill.create] room sync failed:', err.message));
      }
      res.json({ ok: true, bill: rows[0], computed });
    } catch (err) {
      await billClient.query('ROLLBACK').catch(() => {});
      // A7 — translate the partial-unique constraint into a clear 409 so
      // the admin UI can show "already generated" instead of a generic 500.
      // Match the `uq_bills_room_period` PREFIX, not the full legacy name:
      // R4 renamed the index to uq_bills_room_period_tenant_active (the
      // `_tenant_` infix means the old literal `uq_bills_room_period_active`
      // is no longer a substring), so the previous exact-name regex silently
      // fell through to a generic 500. The prefix matches both names.
      if (err.code === '23505' && /uq_bills_room_period/.test(err.constraint || '')) {
        return res.status(409).json({
          error: 'มีบิลของรอบนี้อยู่แล้ว — ทำการ void ก่อนถ้าต้องการสร้างใหม่',
          code: 'BILL_DUPLICATE',
        });
      }
      console.error('bill create error:', err);
      res.status(500).json({ error: 'internal error' });
    } finally {
      billClient.release();
    }
  });

  // POST /api/bills/render — owner/manager PDF rendering. Prefer a persisted
  // billId so amount and payment details come from DB + server config.
  r.post('/render', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    async (req, res) => {
    let bill = req.body && req.body.bill ? req.body.bill : req.body;
    const renderBillId = getRenderBillId(req, bill);
    if (renderBillId) {
      try {
        const { rows } = await pool.query(
          `SELECT b.*, t.full_name AS tenant_name, t.phone AS tenant_phone
             FROM bills b
             LEFT JOIN tenants t ON t.id = b.tenant_id
            WHERE b.id=$1 AND b.deleted_at IS NULL`,
          [renderBillId]
        );
        if (!rows.length) {
          return res.status(404).json({
            error: 'ไม่พบบิลนี้ในระบบ (อาจถูกลบหรือเลขบิลผิด)',
            code: 'BILL_NOT_FOUND',
            billId: renderBillId,
          });
        }
        // Refuse to render PDFs for voided bills. The PromptPay QR in the
        // rendered PDF is still scannable; a tenant who got the void
        // notification but didn't read it could pay against a dead bill.
        // Admin can still download via the source-of-truth payments page.
        if (rows[0].status === 'void') {
          return res.status(410).json({
            error: 'บิลนี้ถูกยกเลิกแล้ว ไม่สามารถสร้าง PDF ได้',
            code: 'BILL_VOID',
          });
        }
        const { config, paymentBlock } = await loadEffectivePaymentBlock();
        bill = buildStoredBillPdfObject(rows[0], config, paymentBlock);
      } catch (err) {
        console.error(`[${req.id}] bill render load error:`, sanitizeError(err));
        return res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
      }
    }
    if (!bill || !bill.tenantName || bill.total == null) {
      return res.status(400).json({
        error: 'bill.tenantName and bill.total required',
        code: 'BILL_FIELDS_REQUIRED',
      });
    }
    const billTotal = Number(bill.total);
    if (!Number.isFinite(billTotal) || billTotal <= 0 || billTotal > MAX_AMOUNT) {
      return res.status(400).json({
        error: 'bill.total must be greater than 0 and within PromptPay limit',
        code: 'INVALID_BILL_TOTAL',
      });
    }
    if (!renderBillId) {
      const storedConfig = await loadBillingConfig().catch(() => ({}));
      const requestConfig = req.body && req.body.config ? req.body.config : {};
      const config = Object.keys(storedConfig || {}).length ? storedConfig : requestConfig;
      const paymentBlock = buildEffectivePaymentBlock(config);
      bill = {
        ...bill,
        total: Math.round(billTotal * 100) / 100,
        building: (config && config.building) || bill.building || {},
        promptpayTarget: paymentBlock.promptpayTarget,
        promptpayName: paymentBlock.promptpayName,
        bankInfo: paymentBlock.bankInfo,
        paymentMethods: paymentBlock.paymentMethods,
      };
    }
    // Client-supplied payment fields are never trusted. Estimates are rendered
    // with server-side payment config, and persisted bills are rebuilt from DB.
    let acquired = false;
    try {
      await acquirePdfSlot();
      acquired = true;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="bill-${(bill.billNo || 'invoice').replace(/[^A-Za-z0-9_-]/g, '')}.pdf"`
      );
      await renderBillPdf(bill, res);
    } catch (err) {
      console.error(`[${req.id}] bill render error:`, sanitizeError(err));
      if (!res.headersSent) {
        const code = String(err.message || '').includes('PDF queue timeout') ? 503 : 500;
        res.status(code).json({ error: 'pdf render failed', code: code === 503 ? 'BUSY' : 'PDF_ERROR' });
      }
    } finally {
      if (acquired) releasePdfSlot();
    }
  });

  // PUT /api/bills/:id/void — admin voids a bill. Single transaction with
  // GET /api/bills/preview-period?period=YYYY-MM
  // Canonical bill preview for the admin billing page. It uses the same
  // server-side inputs as actual bill generation: active contract rent,
  // period-scoped meter readings, recurring charge frequency, feature flags,
  // and payment config. The browser keeps its old local estimate only as a
  // degraded fallback when this endpoint is unavailable.
  r.get('/preview-period', requireAuth, requireRole('owner', 'manager'), async (req, res) => {
    try {
      const parsed = parseBillingPeriod(req.query.period);
      if (!parsed) {
        return res.status(400).json({ error: 'period must be YYYY-MM', code: 'INVALID_PERIOD' });
      }
      const [flags, roomsRow, configRow] = await Promise.all([
        features.load(pool),
        pool.query(`SELECT value FROM app_data WHERE key='baankarn_rooms_v1'`),
        pool.query(`SELECT value FROM app_data WHERE key='baankarn_config_v1'`),
      ]);
      const roomsObj = roomsRow.rows.length ? roomsRow.rows[0].value : {};
      const rooms = Object.values(roomsObj || {});
      const config = configRow.rows.length ? configRow.rows[0].value : {};
      const configuredDue = Number(config?.notify?.dueOnDay);
      const requestedDue = Number(req.query.dueDay);
      const dueDay = Number.isFinite(requestedDue) && requestedDue >= 1 && requestedDue <= 28
        ? requestedDue
        : (Number.isFinite(configuredDue) && configuredDue >= 1 && configuredDue <= 28
          ? configuredDue
          // Fall back to 7 — the SAME default the bulk-generate UI sends
          // (page-billing.jsx: dueOnDay || 7). Defaulting to 15 here made the
          // preview show a due date the issued bill would not actually use when
          // notify.dueOnDay is unconfigured.
          : 7);
      const dueDate = billing.formatYMD(parsed.year, parsed.month, dueDay);
      const periodDisplay = parsed.period;
      const previewBills = [];
      const issues = [];

      for (const rawRoom of rooms) {
        if (!rawRoom || !rawRoom.tenant) continue;
        if (rawRoom.status !== 'occupied' && rawRoom.status !== 'overdue') continue;
        const roomId = String(rawRoom.id || '').slice(0, 64);
        if (!roomId) continue;
        const tenant = await activeTenantForRoom(pool, roomId, rawRoom.tenant);
        if (!tenant) {
          issues.push({
            sev: 'high',
            code: 'NO_ACTIVE_TENANT',
            roomId,
            msg: `room ${roomId} has a tenant blob but no active tenant row`,
          });
          continue;
        }
        const room = { ...rawRoom, tenant };
        const activeContract = await activeContractForRoom(pool, roomId, parsed.period);
        if (billing.contractStartsInPeriod(activeContract, parsed.period)) {
          issues.push(firstMonthBillingIssue(parsed.period, [{
            roomId,
            tenant: tenant.name || '',
            contractId: activeContract.id || null,
            tenantId: tenant.id || null,
          }]));
          continue;
        }
        // Stay-on tenants past a fixed term keep their signed terms — match
        // the scheduler/single-bill paths so the preview shows the SAME rent
        // and due date the generate step will produce.
        const expiredContract = activeContract
          ? null
          : await expiredContractForRoom(pool, roomId, tenant.id || null);
        const contractForBill = activeContract || expiredContract;
        const due = billing.resolveBillDueDay({
          contractDueDay: contractForBill?.contract_due_day,
          requestedDueDay: requestedDue,
          configDueDay: configuredDue,
          fallback: 7,   // matches the bulk UI default (page-billing.jsx dueOnDay || 7)
        });
        const roomDueDate = billing.formatYMD(parsed.year, parsed.month, due.day);
        const recurringRows = flags.recurringCharges?.enabled
          && flags.recurringCharges?.autoIncludeOnBillGen !== false
          ? await loadRecurringFor(pool, { tenantId: tenant.id || null, roomId })
          : [];
        const applicableRecurring = recurringRows
          .filter((x) => billing.isChargeApplicableForPeriod(x, parsed.period));
        const recurringList = applicableRecurring
          .map((x) => ({ label: x.label, amount: Number(x.amount) || 0 }));
        const roomForBilling = await meter.attachBillingReadingsForPeriod(pool, room, parsed.period);
        const bill = billing.buildBill({
          room: roomForBilling,
          contract: activeContract,
          expiredContract,
          config,
          features: flags,
          recurring: recurringList,
          period: parsed.period,
          dueDate: roomDueDate,
          discountPct: Number(contractForBill?.discount_pct) || 0,
        });
        billing.applyPaymentReferenceCents(bill, { tenantId: tenant.id || null, maxTotal: MAX_AMOUNT });
        const missingFields = [];
        if (!billing.isFlatUtilityConfigured(roomForBilling, 'water')
            && bill.waterCurrentReading == null) missingFields.push('water');
        if (!billing.isFlatUtilityConfigured(roomForBilling, 'elec')
            && bill.elecCurrentReading == null) missingFields.push('elec');
        const payload = billPreviewPayload(bill, recurringList, room, periodDisplay);
        // Where this room's due date came from — 'contract' rows are pinned
        // by the signed snapshot and ignore the per-run dueDay selector, so
        // the operator can see (not guess) why a row differs from the rest.
        payload.dueDateSource = due.source;
        if (missingFields.length) {
          payload.issues = [{
            sev: 'high',
            code: 'NO_METER_READINGS',
            fields: missingFields,
          }];
          issues.push({
            sev: 'high',
            code: 'NO_METER_READINGS',
            roomId,
            tenant: tenant.name || '',
            fields: missingFields,
          });
        }
        previewBills.push(payload);
      }

      res.json({
        ok: true,
        period: parsed.period,
        dueDate,
        bills: previewBills,
        summary: {
          billableRooms: previewBills.length,
          issues: issues.length,
          total: previewBills.reduce((sum, b) => sum + (Number(b.total) || 0), 0),
        },
        issues: issues.slice(0, 100),
      });
    } catch (err) {
      console.error('bill preview-period error:', err);
      res.status(500).json({
        error: 'สร้างตัวอย่างบิลของงวดนี้ไม่สำเร็จ — ลองใหม่อีกครั้ง ถ้ายังพังให้ตรวจ log ฝั่งเซิร์ฟเวอร์',
        code: 'PREVIEW_FAILED',
      });
    }
  });

  // FOR UPDATE locks: previously the "any verified payment?" check and the
  // UPDATE-to-void ran as two separate pool queries. A concurrent /pay or
  // slip /verify could land a verified payment row between the two queries
  // — admin's force:true then voided a bill that had just been paid,
  // leaving a verified payments row pointing at a void bill (accounting
  // drift: money received, no live bill). Now we hold a row lock on the
  // bill across the whole flow and re-read the verified-payments list
  // under the lock, then atomically void the bill AND mark the verified
  // payments as rejected (reason: superseded_by_void) AND clear paid_at so
  // the bill is no longer treated as paid for stats.
  r.put('/:id/void', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    const reason = String(req.body?.reason || '').slice(0, 500);
    const force = req.body && req.body.force === true;
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      const billLock = await client.query(
        `SELECT id, status, room_id, paid_at FROM bills
          WHERE id=$1 AND deleted_at IS NULL
          FOR UPDATE`,
        [id]
      );
      if (!billLock.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'ไม่พบบิลนี้ในระบบ', code: 'BILL_NOT_FOUND' });
      }
      if (billLock.rows[0].status === 'void') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'already void', code: 'BILL_ALREADY_VOID' });
      }
      const verified = await client.query(
        `SELECT id, amount FROM payments
          WHERE bill_id=$1 AND status='verified'
          FOR UPDATE`,
        [id]
      );
      if (verified.rows.length && !force) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'บิลนี้มีสลิปที่ยืนยันแล้ว — โปรดยืนยันการ void ก่อนทำต่อ',
          code: 'BILL_HAS_VERIFIED_PAYMENT',
          verifiedPaymentId: verified.rows[0].id,
          verifiedAmount: Number(verified.rows[0].amount),
          hint: 'ส่ง { force: true } เพื่อยืนยันการ void ทั้งที่มีการชำระแล้ว',
        });
      }
      // Reject the verified payment(s) in the same tx. We use status='rejected'
      // with a structured rejected_reason so the audit trail makes clear this
      // wasn't an admin reviewing a slip — it was a forced reversal driven by
      // the bill void. Refund handling (if money has to be returned) is a
      // business decision outside the DB; this just makes the ledger consistent.
      let reversedPayments = [];
      if (verified.rows.length) {
        // Stamp verified_by/verified_at to the voider so a future "show
        // me all verifies by Alice" report doesn't count this row as a
        // successful verification by Alice. The original verifier remains
        // in audit_logs (action='payment.verify'); we don't lose history,
        // we just stop counting reversed payments as verifications. This
        // matches the standard reject pattern used elsewhere in the file
        // (one actor column repurposed for "who decided", with the
        // decision encoded by status + rejected_reason).
        const voider = req.session?.user?.username || 'admin:unknown';
        const reversed = await client.query(
          `UPDATE payments
              SET status='rejected',
                  verified_by=$3,
                  verified_at=NOW(),
                  rejected_reason=$2
            WHERE bill_id=$1 AND status='verified'
          RETURNING id, amount`,
          [id, `superseded_by_void: ${reason || '(no reason)'}`, voider]
        );
        reversedPayments = reversed.rows.map((p) => ({
          id: p.id, amount: Number(p.amount),
        }));
      }
      const voided = await client.query(
        `UPDATE bills
            SET status='void',
                void_reason=$1,
                paid_at=NULL
          WHERE id=$2
        RETURNING *`,
        [reason, id]
      );
      if (!voided.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'not found' });
      }
      // Reverse any carried-forward late fee: a one_off recurring charge created
      // when this bill's payment was settled with action='carry' must not bill
      // the tenant next month for a now-voided bill. A carry ALREADY consumed
      // by next-period bill-gen is frozen inside that issued bill — report it
      // (find must run BEFORE deactivate: deactivate stamps the reversed
      // marker that find excludes) and warn the admin instead of silently
      // editing the issued next-period bill.
      const consumedCarries = await billPayments.findConsumedCarriedLateFees(client, id);
      const deactivatedCarries = await billPayments.deactivateCarriedLateFees(client, id);
      await client.query('COMMIT');
      result = { bill: voided.rows[0], reversedPayments, deactivatedCarries, consumedCarries };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('bill void error:', err);
      return res.status(500).json({ error: 'internal error' });
    } finally {
      client.release();
    }
    audit(req, 'bill.void', 'bill', String(id), {
      reason,
      force: !!force,
      reversedPayments: result.reversedPayments,
      deactivatedCarries: result.deactivatedCarries,
      consumedCarries: result.consumedCarries,
    });
    notifyBillVoided(result.bill, reason, req.session.user.username).catch(() => {});
    // Notify tenant if their verified payment was reversed by this void.
    // notifyBillVoided already pushes "bill voided" but doesn't address
    // the money side — tenant deserves an explicit "your payment is no
    // longer recorded" message so they can challenge if needed.
    if (result.bill.tenant_id && result.reversedPayments.length > 0) {
      for (const p of result.reversedPayments) {
        billPayments.notifyTenantOnPayment({ pool }, {
          tenant_id: result.bill.tenant_id,
          bill_id: id,
          amount: p.amount,
        }, 'reversed', `บิลถูกยกเลิก: ${reason || '(ไม่ระบุ)'}`).catch(() => {});
      }
    }
    // Voiding the last overdue bill should flip the room out of 'overdue'
    // — without this cascade the room kept showing 'overdue' until the
    // daily safety-net tick, so admins clicking "void" then expecting
    // the room to free up immediately saw stale state.
    if (result.bill.room_id) {
      require('../services/roomStatus').syncRoom(pool, result.bill.room_id, { reason: 'bill-void' })
        .catch((err) => console.warn(`[bill.void] room sync failed:`, err.message));
    }
    // consumedCarryWarning fails toward admin review: the carried fee is
    // already a line inside next period's ISSUED bill, which we never edit
    // silently — the operator must adjust (or void) that bill themselves.
    const consumedCarrySum = billing.round2(
      result.consumedCarries.reduce((sum, c) => sum + (Number(c.amount) || 0), 0)
    );
    res.json({
      ok: true,
      bill: result.bill,
      reversedPayments: result.reversedPayments,
      consumedCarries: result.consumedCarries,
      warning: result.consumedCarries.length
        ? `บิลรอบถัดไปยังมีค่าปรับยกมา ฿${consumedCarrySum.toLocaleString('th-TH')} จากบิลที่ถูกยกเลิก — โปรดปรับบิลรอบถัดไปเอง`
        : undefined,
    });
  });

  // POST /api/bills/:id/unmark-paid — admin correction path: undo a "paid"
  // decision when admin recorded the payment in error (typo, wrong bill,
  // duplicate receipt). Reverses the most recent verified payment AND
  // flips the bill back to pending. We require an explicit reason and
  // capture it in the audit log so the trail explains why a paid bill
  // un-paid. Refund of actual money to the tenant is a business action
  // outside the DB; this only fixes the ledger state so future operations
  // work correctly.
  //
  // NOT a refund endpoint — for a true refund (money sent back) a separate
  // payment row with negative amount would be the right model. This is
  // strictly for clerical-error corrections within the office.
  r.post('/:id/unmark-paid',
    sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ error: 'invalid id' });
      }
      const reason = String(req.body?.reason || '').trim().slice(0, 500);
      if (reason.length < 5) {
        return res.status(400).json({
          error: 'ต้องระบุเหตุผลอย่างน้อย 5 ตัวอักษร',
          code: 'REASON_REQUIRED',
        });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const bill = await client.query(
          // subtotal/vat/late_fee are REQUIRED here: the restore math derives
          // the principal (subtotal+vat) and must know the existing late_fee
          // so it never recomputes a fee on a total that already contains one.
          // Omitting them silently treated late_fee as 0 and recomputed on the
          // full total → fee-on-fee compounding + broken total invariant.
          `SELECT id, bill_no, room_id, total, subtotal, vat, late_fee,
                  status, due_date, tenant_id
             FROM bills
            WHERE id=$1 AND deleted_at IS NULL
            FOR UPDATE`,
          [id]
        );
        if (!bill.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'bill not found' });
        }
        const row = bill.rows[0];
        if (row.status !== 'paid') {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `บิลนี้ยังไม่ได้สถานะ "ชำระแล้ว" — ปัจจุบันคือ "${row.status}"`,
            code: 'BILL_NOT_PAID',
            billStatus: row.status,
          });
        }
        const payments = await client.query(
          `SELECT id, amount, method, ref FROM payments
            WHERE bill_id=$1 AND status='verified'
            FOR UPDATE`,
          [id]
        );
        if (!payments.rows.length) {
          // Bill is paid with no verified payment row — that's a data anomaly
          // (legacy mark-paid before audit hooks?). Allow the flip but log it.
          console.warn(`[bill.unmark-paid] bill #${id} is paid but has no verified payment row`);
        }
        // See void path: stamp the unmarker as the new verified_by so
        // counts of "verifications by X" don't double-count reversed rows.
        // Original verifier is still in audit_logs.
        const unmarker = req.session?.user?.username || 'admin:unknown';
        const reversed = payments.rows.length
          ? await client.query(
              `UPDATE payments
                  SET status='rejected',
                      verified_by=$3,
                      verified_at=NOW(),
                      rejected_reason=$2
                WHERE bill_id=$1 AND status='verified'
              RETURNING id, amount, method, ref`,
              [id, `unmark_paid_correction: ${reason}`, unmarker]
            )
          : { rows: [] };
        // Restore the bill status + amounts. Status mirrors the daily overdue
        // tick (due_date past → 'overdue', else 'pending'). The late_fee is
        // recomputed from the PRINCIPAL (subtotal+vat), never from `total`
        // (which on an exact-tier payment still has the previous late_fee
        // folded in) — see billing.computeRestoredBillAmounts. We re-read the
        // current lateFee config because the policy may have changed between
        // verify and unmark; on a load failure the fee already on the bill is
        // preserved rather than silently forgiven.
        const now = new Date();
        let lateFeeEnabled = false;
        let ratePctPerMonth = 0;
        let gracePeriodDays = 0;
        let minLateFeeBaht = 0;
        let maxLateFeeBaht = 0;
        let maxPctOfPrincipal = 0;
        try {
          const flags = await features.load(pool).catch(() => ({}));
          if (flags.lateFee?.enabled) {
            lateFeeEnabled = true;
            ratePctPerMonth = Number(flags.lateFee.ratePctPerMonth) || 0;
            gracePeriodDays = Number(flags.lateFee.gracePeriodDays) || 0;
            minLateFeeBaht = Number(flags.lateFee.minLateFeeBaht) || 0;
            maxLateFeeBaht = Number(flags.lateFee.maxLateFeeBaht) || 0;
            maxPctOfPrincipal = Number(flags.lateFee.maxPctOfPrincipal) || 0;
          }
        } catch { /* feature load failure → preserve the fee already on the bill */ }
        // The rate the tenant SIGNED wins over the global rate — mirror
        // scheduler.tickLateFee's resolveBillRate, otherwise unmark-paid
        // re-assesses a penalty a locked contract forbids (snapshot rate 0
        // is honored: rate 0 takes the preserve-prior-fee path below, and
        // Phase B never lowers a fee, so a wrong restore would stick).
        if (lateFeeEnabled && row.tenant_id != null) {
          try {
            const crq = await client.query(
              `SELECT (c.terms_template_snapshot->'financials'->>'lateFeeRate')::numeric AS contract_late_fee_rate
                 FROM contracts c
                WHERE c.room_id = $1 AND c.tenant_id = $2
                  AND c.locked_at IS NOT NULL
                  AND c.terms_template_snapshot IS NOT NULL
                ORDER BY c.start_date DESC NULLS LAST, c.id DESC
                LIMIT 1`,
              [row.room_id, row.tenant_id]
            );
            const cr = Number(crq.rows[0]?.contract_late_fee_rate);
            if (crq.rows[0]?.contract_late_fee_rate != null && Number.isFinite(cr) && cr >= 0) {
              ratePctPerMonth = cr;
            }
          } catch { /* legacy deploy without contracts → keep the global rate */ }
        }
        // Per-room exemption (config.billing.lateFeeExemptRooms) — same set
        // tickLateFee honors. Disabling here takes the preserve-the-existing-
        // fee path in computeRestoredBillAmounts (normally 0 on exempt rooms)
        // instead of recomputing a fee the room is configured not to pay.
        if (lateFeeEnabled) {
          try {
            const { rows: cfgRows } = await client.query(
              `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
            );
            const exempt = cfgRows[0]?.value?.billing?.lateFeeExemptRooms;
            if (Array.isArray(exempt) && exempt.map((x) => String(x)).includes(String(row.room_id))) {
              lateFeeEnabled = false;
            }
          } catch { /* config blob missing — no exemptions */ }
        }
        // A carry already consumed by next-period bill-gen is frozen inside
        // that ISSUED bill. Find those BEFORE deactivateCarriedLateFees runs
        // (it stamps the reversed marker that this lookup excludes) and
        // subtract the already-billed amount from the restored fee so the
        // same lateness is never owed twice.
        const consumedCarries = await billPayments.findConsumedCarriedLateFees(client, id);
        const consumedCarriedLateFee = billing.round2(
          consumedCarries.reduce((sum, c) => sum + (Number(c.amount) || 0), 0)
        );
        const restore = billing.computeRestoredBillAmounts({
          subtotal: row.subtotal,
          vat: row.vat,
          lateFee: row.late_fee,
          total: row.total,
          dueDate: row.due_date,
          now,
          lateFeeEnabled,
          ratePctPerMonth,
          gracePeriodDays,
          minLateFeeBaht,
          maxLateFeeBaht,
          maxPctOfPrincipal,
          consumedCarriedLateFee,
        });
        const restoredStatus = restore.status;
        const restoredLateFee = restore.lateFee;
        const restoredTotal = restore.total;
        // The paid -> unpaid transition invalidates the previous reminder's
        // QR image/cache state. Clear the short resend cooldown so admin can
        // immediately send a fresh bill message with a new QR URL.
        const restored = await client.query(
          `UPDATE bills
              SET status=$2,
                  paid_at=NULL,
                  late_fee=$3::numeric,
                  total=$4::numeric,
                  last_reminded_at=NULL
            WHERE id=$1
          RETURNING *`,
          [id, restoredStatus, restoredLateFee, restoredTotal]
        );
        // Reverse any carried-forward late fee from the original 'carry'
        // settlement. The restored bill re-accrues its own late fee (above), so
        // leaving the carried one_off active would double-charge the tenant next
        // month. Deactivate only still-active carries (already-billed ones stay).
        const deactivatedCarries = await billPayments.deactivateCarriedLateFees(client, id);
        await client.query('COMMIT');
        audit(req, 'bill.unmark_paid', 'bill', String(id), {
          reason,
          restoredStatus,
          deactivatedCarries,
          consumedCarries,
          consumedCarriedLateFee,
          reversedPayments: reversed.rows.map((p) => ({
            id: p.id, amount: Number(p.amount), method: p.method, ref: p.ref,
          })),
        });
        // Notify the tenant of the reversal so they don't first hear
        // about it via an overdue reminder. Fire-and-forget — a
        // notification failure doesn't undo the unmark-paid.
        for (const p of reversed.rows) {
          billPayments.notifyTenantOnPayment({ pool }, {
            tenant_id: row.tenant_id,
            bill_id: id,
            amount: p.amount,
          }, 'reversed', reason).catch(() => {});
        }
        // Room status may flip back to 'overdue' if this was the bill keeping
        // the room "occupied". Same cascade pattern as /void.
        if (row.room_id) {
          require('../services/roomStatus')
            .syncRoom(pool, row.room_id, { reason: 'bill-unmark-paid' })
            .catch((err) => console.warn(`[bill.unmark-paid] room sync failed:`, err.message));
        }
        res.json({
          ok: true,
          bill: restored.rows[0],
          reversedPayments: reversed.rows.map((p) => ({
            id: p.id, amount: Number(p.amount), method: p.method, ref: p.ref,
          })),
          consumedCarries,
          warning: consumedCarries.length
            ? `ค่าปรับยกมา ฿${consumedCarriedLateFee.toLocaleString('th-TH')} ถูกเก็บในบิลรอบถัดไปที่ออกแล้ว — ระบบหักส่วนนี้ออกจากค่าปรับที่คืนให้บิลนี้แล้ว`
            : undefined,
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('bill unmark-paid error:', err);
        res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
      } finally {
        client.release();
      }
    });

  // Compose the LINE Messages array for a bill notification. Two messages:
  //   1. Flex bubble: bill summary header + QR image + bank info card + button
  //   2. Text fallback: same info as plaintext so LINE clients that can't
  //      render Flex (old versions, web preview) still get the gist.
  // Counts as ONE push toward LINE's rate limit (Messaging API bundles
  // up to 5 messages per push).
  function buildBillLineMessages(b, opts = {}) {
    const { publicUrl, billLink, dueDateStr, billNo, qrToken, qrVersion, bankInfo, lineCount } = opts;
    const total = Number(b.total) || 0;
    const totalStr = total.toLocaleString('th-TH', { minimumFractionDigits: 2 });
    const billStatus = String(b.status || 'pending').toLowerCase();
    const isPaid = billStatus === 'paid';
    const isPayable = billStatus === 'pending' || billStatus === 'overdue';
    const billStatusLabel = isPaid
      ? 'ชำระแล้ว'
      : (isPayable ? 'ยังไม่ชำระ' : 'ไม่อยู่ในสถานะที่ชำระได้');
    const hasBankInfo = isPayable && !isPaid && !!(bankInfo && bankInfo.account);
    // QR image URL — public endpoint with HMAC token so LINE Platform can
    // fetch it without auth. signBillQrToken is injected via ctx so this
    // module doesn't need to know about session secrets.
    const qrCacheVersion = qrVersion || `${billStatus}-${Date.now()}`;
    const qrUrl = isPayable && publicUrl && qrToken
      ? `${publicUrl}/p/bill-qr/${encodeURIComponent(b.id)}?t=${encodeURIComponent(qrToken)}&v=${encodeURIComponent(qrCacheVersion)}`
      : null;
    const statusNoticeBox = (title, detail, titleColor, backgroundColor) => ({
      type: 'box',
      layout: 'vertical',
      backgroundColor,
      cornerRadius: 'md',
      paddingAll: 'lg',
      margin: 'md',
      spacing: 'xs',
      contents: [
        { type: 'text', text: title, weight: 'bold', size: 'xl', align: 'center', color: titleColor },
        { type: 'text', text: detail, size: 'sm', align: 'center', color: '#5f5448', wrap: true },
      ],
    });
    // Flex bubble layout — single column, top-down:
    //   ▸ "บิลใหม่" header band (accent colour)
    //   ▸ Room + period + due date + amount block
    //   ▸ QR image (if available) — tappable, opens fullscreen in LINE
    //   ▸ "ดูบิล + จ่ายเลย" button → opens portal deep link
    // Falls back to text-only when QR can't be served (no PUBLIC_URL).
    const flexBody = [
      { type: 'text', text: '📋 บิลใหม่', weight: 'bold', size: 'lg', color: '#c46a3e' },
      { type: 'separator', margin: 'md' },
      { type: 'box', layout: 'vertical', margin: 'md', spacing: 'sm', contents: [
        rowKV('ห้อง', String(b.room_id || '-')),
        rowKV('รอบ', String(b.period || '-')),
        rowKV('กำหนดชำระ', String(dueDateStr || '-')),
        rowKV('ยอดชำระ', `฿${totalStr}`, true),
        rowKV('LINE ที่ผูก', `${Number(lineCount) || 0} บัญชี`),
      ]},
    ];
    const summaryBox = flexBody.find((part) =>
      part && part.type === 'box' && part.layout === 'vertical' && Array.isArray(part.contents));
    if (summaryBox) summaryBox.contents.push(rowKV('สถานะ', billStatusLabel, isPaid || !isPayable));
    if (isPaid) {
      flexBody.push(
        { type: 'separator', margin: 'lg' },
        statusNoticeBox('ชำระแล้ว', 'ไม่ต้องสแกน QR หรือส่งสลิปเพิ่ม', '#1f7a3f', '#e8f5ec'));
    } else if (!isPayable) {
      flexBody.push(
        { type: 'separator', margin: 'lg' },
        statusNoticeBox('ชำระไม่ได้', `สถานะปัจจุบัน: ${billStatus || '-'}`, '#8a4b12', '#fff4d8'));
    }
    if (qrUrl) {
      flexBody.push(
        { type: 'separator', margin: 'lg' },
        { type: 'text', text: 'สแกน PromptPay เพื่อชำระ', size: 'sm', color: '#8a7d6b',
          align: 'center', margin: 'md' },
        { type: 'image', url: qrUrl, size: 'full', aspectRatio: '1:1', aspectMode: 'cover',
          margin: 'sm' });
    }
    if (hasBankInfo) {
      flexBody.push(
        { type: 'separator', margin: 'lg' },
        { type: 'text', text: 'หรือโอนเข้าบัญชีธนาคาร', size: 'sm', color: '#8a7d6b',
          weight: 'bold', margin: 'md' },
        { type: 'box', layout: 'vertical', margin: 'sm', spacing: 'xs', contents: [
          rowKV('ธนาคาร', bankInfo.bank || '-'),
          rowKV('เลขบัญชี', bankInfo.account, true),
          bankInfo.name ? rowKV('ชื่อบัญชี', bankInfo.name) : null,
        ].filter(Boolean) });
    }
    if (qrUrl || hasBankInfo) {
      flexBody.push(
        { type: 'text', text: 'หลังชำระแล้ว กดปุ่มด้านล่างเพื่อส่งสลิปให้แอดมินตรวจ',
          size: 'xs', color: '#8a7d6b', wrap: true, margin: 'md' });
    }
    const bubble = {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', contents: flexBody },
      footer: billLink ? {
        type: 'box', layout: 'vertical', spacing: 'sm', contents: [
          { type: 'button', style: 'primary', color: '#c46a3e',
            action: { type: 'uri', label: 'ดูบิล + ส่งสลิป', uri: billLink } },
        ],
      } : undefined,
    };
    if (bubble.footer?.contents?.[0]?.action && (isPaid || !isPayable)) {
      bubble.footer.contents[0].action.label = 'ดูรายละเอียดบิล';
    }
    const flexMsg = {
      type: 'flex',
      altText: `บิลใหม่ห้อง ${b.room_id} ยอด ฿${totalStr}`,
      contents: bubble,
    };
    if (isPaid) flexMsg.altText = `บิลห้อง ${b.room_id} ชำระแล้ว`;
    else if (!isPayable) flexMsg.altText = `บิลห้อง ${b.room_id} ยังชำระไม่ได้`;
    // Plain-text fallback message for clients that won't render Flex. Sent
    // alongside the Flex so the user always gets the text version too —
    // tracks better in LINE search and is copyable.
    const textMsg = isPaid ? {
      type: 'text',
      text: [
        `✅ บิลนี้ชำระแล้ว — ${b.period || '-'}`,
        ``,
        `ห้อง: ${b.room_id || '-'}`,
        `ยอดบิล: ฿${totalStr}`,
        `สถานะ: ชำระแล้ว`,
        `ไม่ต้องสแกน QR หรือส่งสลิปเพิ่ม`,
        billLink ? `\nดูรายละเอียดบิล:\n👉 ${billLink}` : null,
      ].filter(Boolean).join('\n'),
    } : (!isPayable ? {
      type: 'text',
      text: [
        `⚠️ บิลนี้ยังชำระผ่านลิงก์ไม่ได้ — ${b.period || '-'}`,
        ``,
        `ห้อง: ${b.room_id || '-'}`,
        `ยอดบิล: ฿${totalStr}`,
        `สถานะปัจจุบัน: ${billStatus || '-'}`,
        `กรุณาติดต่อแอดมินก่อนชำระเงิน`,
        billLink ? `\nดูรายละเอียดบิล:\n👉 ${billLink}` : null,
      ].filter(Boolean).join('\n'),
    } : {
      type: 'text',
      text: [
        `📋 บิลใหม่ — ${b.period || '-'}`,
        ``,
        `ห้อง: ${b.room_id || '-'}`,
        `ยอดชำระ: ฿${totalStr}`,
        `กำหนดชำระ: ${dueDateStr || '-'}`,
        `LINE ที่ผูกกับห้องนี้: ${Number(lineCount) || 0} บัญชี`,
        ``,
        `วิธีชำระเงิน:`,
        qrUrl ? `1) สแกน QR PromptPay ในข้อความนี้` : null,
        hasBankInfo ? [
          `${qrUrl ? '2' : '1'}) โอนเข้าบัญชีธนาคาร`,
          `   ธนาคาร: ${bankInfo.bank || '-'}`,
          `   เลขบัญชี: ${bankInfo.account}`,
          bankInfo.name ? `   ชื่อบัญชี: ${bankInfo.name}` : null,
        ].filter(Boolean).join('\n') : null,
        billLink ? `\nส่งสลิป / ดูบิล:\n👉 ${billLink}` : null,
      ].filter(Boolean).join('\n'),
    });
    return [flexMsg, textMsg];
  }
  function rowKV(label, value, bold) {
    return {
      type: 'box', layout: 'baseline', spacing: 'sm', contents: [
        { type: 'text', text: label, color: '#8a7d6b', size: 'sm', flex: 2 },
        { type: 'text', text: String(value || '-'),
          color: bold ? '#c46a3e' : '#2c241b',
          weight: bold ? 'bold' : 'regular',
          size: bold ? 'md' : 'sm', flex: 4, wrap: true },
      ],
    };
  }

  // POST /api/bills/bulk-generate
  // body (optional): { period: "YYYY-MM", dueDay: 15, force: false }
  // body.force=true bypasses server-side config validation (admin already
  // confirmed the issues client-side). When force is missing/false and
  // critical config is missing, returns 412 PRECONDITION_FAILED with the
  // exact issue list so the UI can show actionable warnings.
  r.post('/bulk-generate', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    async (req, res) => {
      const now = new Date();
      const period = String(req.body?.period
        || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`).slice(0, 7);
      // Strict period validation — the regex `^\d{4}-\d{2}$` matches
      // "2026-13" and "2026-00" since it only checks digit count, so we
      // also clamp the month range. Without this the bill_no string is
      // valid but the SQL DATE cast on dueDate (`2026-13-15`::date) blows
      // up the transaction halfway through bulk-generate — the operator
      // gets a 500 instead of a clean 400. Year range guards typos like
      // 9999-12 / 0001-01.
      const periodMatch = /^(\d{4})-(\d{2})$/.exec(period);
      if (!periodMatch) {
        return res.status(400).json({
          error: 'period must be YYYY-MM',
          code: 'INVALID_PERIOD',
        });
      }
      const periodYear = Number(periodMatch[1]);
      const periodMonth = Number(periodMatch[2]);
      if (periodMonth < 1 || periodMonth > 12 || periodYear < 2020 || periodYear > 2100) {
        return res.status(400).json({
          error: 'period month must be 01-12 and year 2020-2100',
          code: 'INVALID_PERIOD',
          period,
        });
      }
      // Per-run due-day override. Validation + the full precedence chain
      // (contract snapshot > this request value > config.notify.dueOnDay >
      // 7) live in billing.resolveBillDueDay, evaluated PER ROOM inside the
      // loop so contract-locked rooms keep their signed day.
      const rawDueDay = req.body?.dueDay;
      const force = req.body?.force === true;
      const forceReason = String(req.body?.forceReason || req.body?.overrideReason || '').trim().slice(0, 500);
      try {
        const flags = await features.load(pool);
        const [roomsRow, configRow] = await Promise.all([
          pool.query(`SELECT value FROM app_data WHERE key='baankarn_rooms_v1'`),
          pool.query(`SELECT value FROM app_data WHERE key='baankarn_config_v1'`),
        ]);
        const rooms = Object.values(roomsRow.rows.length ? roomsRow.rows[0].value : {});
        const config = configRow.rows.length ? configRow.rows[0].value : {};

        // === Server-side config validation =================================
        // Belt-and-braces: even when admin clicks past the client-side warn,
        // refuse to silently produce broken bills if a HIGH-severity issue
        // exists. The client UI now sends `force:true` after admin confirms
        // the warning explicitly. Without that flag we 412 with details so
        // a 3rd-party caller (cron, script, future mobile app) can't blindly
        // generate empty bills either.
        const issues = [];
        const paymentBlock = billing.buildPaymentBlock(config);
        const ppTarget = paymentBlock.promptpayTarget
          || require('../services/secrets').get('PROMPTPAY_TARGET');
        const hasManualPaymentChannel = !!(
          (paymentBlock.bankInfo && paymentBlock.bankInfo.account)
          || (paymentBlock.walletInfo && paymentBlock.walletInfo.phone)
        );
        if (!ppTarget) {
          issues.push({ sev: hasManualPaymentChannel ? 'med' : 'high', code: 'NO_PROMPTPAY',
            msg: hasManualPaymentChannel
              ? 'PROMPTPAY_TARGET ไม่ตั้ง — บิล PDF จะไม่มี QR แต่ยังมีบัญชีโอน/วอลเล็ต manual ให้ผู้เช่าใช้'
              : 'PROMPTPAY_TARGET ไม่ตั้ง และยังไม่มีบัญชีโอน/วอลเล็ต manual — ผู้เช่าจะไม่มีปลายทางรับเงินที่ชัดเจน',
            fix: hasManualPaymentChannel
              ? '/admin#settings → การชำระเงิน หากต้องการ QR ให้ตั้ง PromptPay เพิ่ม'
              : '/admin#settings → การชำระเงิน ตั้ง PromptPay หรือบัญชีธนาคาร/TrueMoney Wallet',
            detail: { manualChannelConfigured: hasManualPaymentChannel } });
        } else if (promptpay.isDemoTarget(ppTarget)) {
          issues.push({ sev: 'high', code: 'DEMO_PROMPTPAY',
            msg: 'PromptPay ยังเป็นค่า demo — เปลี่ยนเป็นบัญชีรับเงินจริงก่อนออกบิล',
            fix: '/admin#settings → การชำระเงิน เป็นเบอร์/บัตรประชาชนจริง' });
        }
        const eligibleRooms = rooms.filter((r) => r && r.tenant
          && (r.status === 'occupied' || r.status === 'overdue'));
        const wRate = Number(config?.utilities?.waterRate);
        const eRate = Number(config?.utilities?.elecRate);
        const issueRoom = (r, fields = []) => ({
          roomId: String(r?.id || '-'),
          tenant: r?.tenant?.name || '',
          ...(fields.length ? { fields } : {}),
        });
        const isFlatModeRequested = (r, prefix) =>
          String(r?.[`${prefix}Mode`] ?? r?.[`${prefix}_mode`] ?? '').toLowerCase() === 'flat';
        const firstMonth = await firstMonthRoomsForPeriod(pool, eligibleRooms, period);
        const monthlyEligibleRooms = eligibleRooms
          .filter((r) => !firstMonth.ids.has(String(r?.id || '')));
        if (firstMonth.rooms.length > 0) {
          issues.push(firstMonthBillingIssue(period, firstMonth.rooms));
        }
        const meteredWaterRooms = monthlyEligibleRooms.filter((r) => !billing.isFlatUtilityConfigured(r, 'water'));
        const meteredElecRooms = monthlyEligibleRooms.filter((r) => !billing.isFlatUtilityConfigured(r, 'elec'));
        const flatMisconfigured = monthlyEligibleRooms
          .map((r) => {
            const fields = [];
            if (isFlatModeRequested(r, 'water') && !billing.isFlatUtilityConfigured(r, 'water')) fields.push('water');
            if (isFlatModeRequested(r, 'elec') && !billing.isFlatUtilityConfigured(r, 'elec')) fields.push('elec');
            return fields.length ? issueRoom(r, fields) : null;
          })
          .filter(Boolean);
        const anyMeteredWater = monthlyEligibleRooms.some((r) => !billing.isFlatUtilityConfigured(r, 'water'));
        const anyMeteredElec = monthlyEligibleRooms.some((r) => !billing.isFlatUtilityConfigured(r, 'elec'));
        if (flatMisconfigured.length > 0) {
          issues.push({ sev: 'med', code: 'FLAT_AMOUNT_MISSING',
            msg: `${flatMisconfigured.length} ห้องตั้งค่าน้ำ/ไฟแบบเหมา แต่ยังไม่ได้ใส่จำนวนเหมา ระบบจะ fallback ไปคิดตามมิเตอร์`,
            fix: '/admin#rooms → เปิดห้องที่แจ้งเตือน แล้วใส่จำนวนเหมาน้ำ/ไฟ หรือเปลี่ยนกลับเป็นคิดตามมิเตอร์',
            detail: { period, count: flatMisconfigured.length, rooms: flatMisconfigured.slice(0, 20) } });
        }
        if (anyMeteredWater && (!Number.isFinite(wRate) || wRate <= 0)) {
          issues.push({ sev: 'high', code: 'NO_WATER_RATE',
            msg: 'อัตราค่าน้ำต่อหน่วยไม่ตั้ง — ยอดค่าน้ำในบิลจะ ฿0 สำหรับห้องที่คิดตามมิเตอร์',
            fix: '/admin#pricing → ค่าน้ำ-ไฟ หรือ ตั้งค่าน้ำแบบเหมาในทุกห้องที่ไม่ใช้มิเตอร์',
            detail: { period, count: meteredWaterRooms.length, rooms: meteredWaterRooms.map((r) => issueRoom(r, ['water'])).slice(0, 20) } });
        }
        if (anyMeteredElec && (!Number.isFinite(eRate) || eRate <= 0)) {
          issues.push({ sev: 'high', code: 'NO_ELEC_RATE',
            msg: 'อัตราค่าไฟต่อหน่วยไม่ตั้ง — ยอดค่าไฟในบิลจะ ฿0 สำหรับห้องที่คิดตามมิเตอร์',
            fix: '/admin#pricing → ค่าน้ำ-ไฟ หรือ ตั้งค่าไฟแบบเหมาในทุกห้องที่ไม่ใช้มิเตอร์',
            detail: { period, count: meteredElecRooms.length, rooms: meteredElecRooms.map((r) => issueRoom(r, ['elec'])).slice(0, 20) } });
        }
        const periodMeters = await meter.buildPeriodSummary(pool, rooms, period);
        const hasPeriodReading = (r, prefix) => {
          const m = periodMeters[String(r?.id || '')] || {};
          return m[`${prefix}CurrentReading`] != null;
        };
        const missingMeterRooms = monthlyEligibleRooms
          .map((r) => {
            const fields = [];
            if (!billing.isFlatUtilityConfigured(r, 'water') && !hasPeriodReading(r, 'water')) fields.push('water');
            if (!billing.isFlatUtilityConfigured(r, 'elec') && !hasPeriodReading(r, 'elec')) fields.push('elec');
            return fields.length ? issueRoom(r, fields) : null;
          })
          .filter(Boolean);
        if (missingMeterRooms.length > 0) {
          issues.push({ sev: 'high', code: 'NO_METER_READINGS',
            msg: `${missingMeterRooms.length} ห้องยังไม่มีเลขมิเตอร์ครบสำหรับรอบ ${period} — ระบบจะไม่ออกบิลเงียบ ๆ ด้วยหน่วยเก่าหรือยอด 0`,
            fix: `/admin#meters → เลือกรอบ ${period} แล้วบันทึกเลขมิเตอร์ก่อนออกบิล หรือ force:true เฉพาะกรณีตั้งใจใช้ค่าปัจจุบัน`,
            detail: { period, count: missingMeterRooms.length, rooms: missingMeterRooms.slice(0, 20) } });
        }
        if (eligibleRooms.length === 0) {
          issues.push({ sev: 'high', code: 'NO_ELIGIBLE_ROOMS',
            msg: 'ไม่มีห้องที่มีผู้เช่าแสดงสถานะ occupied/overdue — จะออกบิล 0 ใบ',
            fix: '/admin#rooms → กำหนดผู้เช่าให้ห้อง และตั้งสถานะเป็น occupied หรือ overdue' });
        }
        // High-severity issues block unless force=true; medium/low are
        // returned as warnings in the response (informational, doesn't block).
        const hardIssues = issues.filter((i) => i.sev === 'high');
        if (hardIssues.length > 0 && !force) {
          return res.status(412).json({
            error: `ตั้งค่าระบบไม่ครบสำหรับการออกบิล (${hardIssues.length} ข้อสำคัญ)`,
            code: 'PRECONDITION_FAILED',
            issues,
            hint: 'แก้ปัญหาด้านบนแล้วลองใหม่ — หรือส่ง { force: true } เพื่อออกบิลทั้งที่ค่ายังไม่ครบ (audit-logged)',
          });
        }
        if (force && hardIssues.length > 0 && forceReason.length < 8) {
          return res.status(400).json({
            error: 'ต้องระบุเหตุผลก่อน force ออกบิลทั้งที่มีปัญหาสำคัญ',
            code: 'BILL_FORCE_REASON_REQUIRED',
            issues: hardIssues,
            hint: 'ส่ง forceReason อย่างน้อย 8 ตัวอักษร เช่น "ออกบิลด้วยยอดปัจจุบันหลังตรวจเลขมิเตอร์แล้ว"',
            impact: 'ระบบยังไม่ออกบิล เพื่อป้องกันบิลที่ QR/ยอดน้ำไฟ/เลขมิเตอร์ผิดถูกส่งให้ผู้เช่าโดยไม่มีเหตุผลใน audit log',
            nextActions: {
              hint: 'แนะนำแก้รายการ sev=high ก่อน ถ้าจำเป็นต้องออกบิลทันทีให้ใส่เหตุผลที่ตรวจย้อนหลังได้',
            },
          });
        }
        if (force && hardIssues.length > 0) {
          // Audit the override so we can track operators who routinely
          // bypass — useful when a tenant disputes a malformed bill later.
          audit(req, 'bill.bulk_generate.forced', 'period', period, {
            issues: hardIssues.map((i) => i.code),
            reason: forceReason,
            forcedBy: req.session.user.username,
          });
        }

        // Due dates are built from the operator-supplied PERIOD (not "now")
        // so back-filled bills (admin generates April from May 5th) carry
        // the intended month — computed PER ROOM inside the loop via
        // resolveBillDueDay so contract-locked due days win. formatYMD keeps
        // Asia/Bangkok offsets from shifting the day via toISOString().
        const dueDaySources = {};
        let made = 0, updated = 0, skipped = 0;
        const skipReasons = {
          noTenant: 0,
          notBillableStatus: 0,
          firstMonth: 0,
          unchanged: 0,
          locked: 0,
          duplicate: 0,
          error: 0,
        };
        const bumpSkip = (key) => {
          skipped++;
          skipReasons[key] = (skipReasons[key] || 0) + 1;
        };
        // Track rooms that asked for flat (เหมา) mode but didn't have a
        // valid amount — services/billing.js#resolveFlatMode silently falls
        // back to metered in this case, which can issue a wrong bill if
        // admin forgot to type the flat amount. Surface those rooms back
        // in the response so the /admin#billing toast can show "ห้อง A101
        // กลับไปคิดตามมิเตอร์เพราะยังไม่ตั้งจำนวนเหมา".
        const flatFellBack = [];
        const firstMonthSkipped = [];
        // Distinguish "deployment that never uses the tenants table" (legacy
        // blob-only mode — billing with tenant_id NULL is the designed
        // fallback) from "tenants table is in use but THIS room has no active
        // tenant" (blob/relational drift — e.g. tenant checked out, blob room
        // still shows them). In the drift case a generated bill would be an
        // orphan: invisible in the tenant portal, no LINE/email recipient,
        // and late fees accrue on it forever. Skip + surface instead.
        let relationalTenantsInUse = false;
        try {
          const probe = await pool.query(
            `SELECT 1 FROM tenants WHERE deleted_at IS NULL LIMIT 1`
          );
          relationalTenantsInUse = probe.rows.length > 0;
        } catch { /* table absent on legacy deploys → blob-only mode */ }
        const tenantlessSkipped = [];
        for (const room of rooms) {
          if (!room || !room.tenant) { bumpSkip('noTenant'); continue; }
          if (room.status !== 'occupied' && room.status !== 'overdue') { bumpSkip('notBillableStatus'); continue; }
          // R2 — previous overdue bill lookup is GONE. Late fees are owned by
          // scheduler.tickLateFee and live on the old bill (updated in-place
          // when it flips pending → overdue). New bills always start with
          // late_fee=0 — no carry-over.
          // Pull active recurring charges for this room AND its current
          // tenant — without the tenant_id branch, parking/cleaning charges
          // billed to the person (not the unit) would be silently dropped.
          let recurring = [];
          let tenantIdForRoom = null;
          try {
            const tq = await pool.query(
              `SELECT id FROM tenants
                 WHERE current_room_id=$1 AND status='active' AND deleted_at IS NULL
                 ORDER BY updated_at DESC LIMIT 1`,
              [room.id]
            );
            if (tq.rows.length) tenantIdForRoom = tq.rows[0].id;
          } catch { /* ignore */ }
          if (relationalTenantsInUse && !tenantIdForRoom) {
            tenantlessSkipped.push({
              roomId: String(room.id || ''),
              blobTenantName: String(room.tenant?.name || ''),
            });
            bumpSkip('noActiveTenantRecord');
            continue;
          }
          // Match the manual + scheduler paths: pull discount_pct from the
          // active contract so bulk-generate honors the contract-length
          // discount the admin recorded at check-in.
          // Pull the active contract for this room. Used for BOTH:
          //   - discount_pct (legacy: contract-length discount honored)
          //   - monthly_rent (NEW: locked rate from signing — bill engine
          //     prefers this over room.rent/formula so admin changing
          //     /admin#pricing mid-contract doesn't break existing tenants)
          // See services/pricing.js#resolveBillingRent for the priority.
          const activeContract = await activeContractForRoom(pool, room.id, period);
          // Stay-on tenants past a fixed term keep their SIGNED rate + due
          // day — match the scheduler/single-bill paths (bulk previously
          // skipped this lookup and jumped a stay-on tenant's rent to the
          // current formula the day their contract expired).
          const expiredContract = activeContract
            ? null
            : await expiredContractForRoom(pool, room.id, tenantIdForRoom);
          const contractForBill = activeContract || expiredContract;
          const discountPct = Number(contractForBill?.discount_pct) || 0;
          if (billing.contractStartsInPeriod(activeContract, period)) {
            firstMonthSkipped.push({
              roomId: String(room.id || ''),
              tenantId: tenantIdForRoom || null,
              contractId: activeContract.id || null,
            });
            bumpSkip('firstMonth');
            continue;
          }
          // Per-room due date: the day the tenant SIGNED wins over the
          // operator's per-run selector and the global config. Same
          // precedence rule as the rent + late-fee rate.
          const due = billing.resolveBillDueDay({
            contractDueDay: contractForBill?.contract_due_day,
            requestedDueDay: rawDueDay,
            configDueDay: config?.notify?.dueOnDay,
            fallback: 7,   // matches the bulk UI default (page-billing.jsx dueOnDay || 7)
          });
          // Scheduler parity: generating for the CURRENT period after the due
          // day already passed must roll the due date forward (same
          // billGenDueDateFor policy as the nightly job) so the bill isn't
          // born overdue and accruing a fee for days before it existed.
          // Back-filled historical periods (and future ones) keep their
          // in-period due date: billing.formatYMD(periodYear, periodMonth,
          // due.day) — the date the tenant actually owed back then.
          const roomDueDate = period === billing.formatPeriodNow()
            ? billGenDueDateFor(new Date(), due)
            : billing.formatYMD(periodYear, periodMonth, due.day);
          dueDaySources[due.source] = (dueDaySources[due.source] || 0) + 1;
          // Single transaction per room: lock+read recurring_charges,
          // INSERT bill, deactivate one_offs. Reading recurring INSIDE
          // the tx with FOR UPDATE means an admin editing/deleting a
          // recurring row in another tab waits for our tx to commit —
          // otherwise admin's PUT could land between our SELECT and
          // INSERT, and the tenant got billed for the stale amount
          // while admin thinks their edit took effect.
          // queryWithRetry was useful for transient connection drops,
          // but inside a tx a transient drop also rolls back the bill,
          // so admin re-runs bulk-generate (the ON CONFLICT clause
          // makes the rerun idempotent on bill_no).
          const billClient = await pool.connect();
          // Track one_off charges so we can flip active=FALSE after a
          // successful insert. Without this, an admin running bulk-generate
          // would re-bill the same one_off charge every month forever.
          let usedOneOffIds = [];
          try {
            await billClient.query('BEGIN');
            if (flags.recurringCharges?.enabled && flags.recurringCharges?.autoIncludeOnBillGen !== false) {
              try {
                const params = [];
                const ors = [];
                if (tenantIdForRoom) { params.push(tenantIdForRoom); ors.push(`tenant_id = $${params.length}`); }
                params.push(room.id); ors.push(`room_id = $${params.length}`);
                const rc = await billClient.query(
                  `SELECT id, label, amount, frequency, start_at, end_at FROM recurring_charges
                     WHERE active = TRUE AND (${ors.join(' OR ')})
                     FOR UPDATE`,
                  params
                );
                // Honor `frequency` — quarterly charges only fire every 3 months
                // anchored to start_at. Without this the bulk-generate path
                // re-billed quarterly fees every month.
                const applicable = rc.rows.filter((x) => billing.isChargeApplicableForPeriod(x, period));
                recurring = applicable.map((x) => ({ label: x.label, amount: Number(x.amount) }));
                usedOneOffIds = applicable.filter((x) => x.frequency === 'one_off').map((x) => x.id);
              } catch (rcErr) {
                // table may not exist on older deployments — leave recurring=[]
                if (rcErr.code !== '42P01') throw rcErr;
              }
            }
            // Lock the existing same-slot bill (if any) BEFORE recomputing:
            // one_off charges the FIRST run consumed are active=FALSE now, so
            // they vanished from `recurring` — resurrect the lines the
            // existing bill already carries (matched against inactive one_off
            // rows, reversed carries excluded), otherwise the rerun rewrites
            // the bill without them and the amount is never billed anywhere.
            const existingSlot = await billClient.query(
              `SELECT b.id, b.bill_no, b.status, b.rent,
                      b.water_prev_reading, b.water_current_reading, b.water_units, b.water_rate, b.water_amount,
                      b.elec_prev_reading, b.elec_current_reading, b.elec_units, b.elec_rate, b.elec_amount,
                      b.wifi, b.other, b.subtotal, b.vat, b.late_fee, b.total, b.due_date,
                      EXISTS (
                        SELECT 1 FROM payments p
                         WHERE p.bill_id=b.id AND p.status='verified'
                      ) AS has_verified_payment
                 FROM bills b
                WHERE b.room_id=$1 AND b.period=$2
                  AND COALESCE(b.tenant_id, 0)=COALESCE($3::bigint, 0)
                  AND b.deleted_at IS NULL AND b.status <> 'void'
                ORDER BY b.created_at DESC
                LIMIT 1
                FOR UPDATE`,
              [room.id, period, tenantIdForRoom]
            );
            const existing = existingSlot.rows[0] || null;
            if (existing) {
              const consumedLines = await consumedOneOffLinesForBill(billClient, {
                tenantId: tenantIdForRoom, roomId: room.id,
                existingOther: existing.other, currentList: recurring,
              });
              if (consumedLines.length) recurring = [...recurring, ...consumedLines];
            }
            const roomForBilling = await meter.attachBillingReadingsForPeriod(billClient, room, period);
            const bill = billing.buildBill({ room: roomForBilling, contract: activeContract, expiredContract, config, features: flags, recurring, period, dueDate: roomDueDate, discountPct });
            billing.applyPaymentReferenceCents(bill, { tenantId: tenantIdForRoom, maxTotal: MAX_AMOUNT });
            // Capture which utilities silently fell back from flat → metered
            // for this room. waterFlatFellBack/elecFlatFellBack are set by
            // services/billing.js#resolveFlatMode when mode='flat' but the
            // flatAmount is missing/<=0/NaN. Admin gets these back in the
            // bulk-generate response so they don't ship dozens of bills at
            // the wrong rate without knowing.
            if (bill.waterFlatFellBack || bill.elecFlatFellBack) {
              flatFellBack.push({
                roomId: room.id,
                water: !!bill.waterFlatFellBack,
                elec: !!bill.elecFlatFellBack,
              });
            }
            // Include the common-area fee as a visible `other` line (it's
            // already in bill.subtotal/total via buildBill; this is for display
            // + PDF reconstruction parity with the single-bill path).
            let otherItems = Array.isArray(recurring) ? [...recurring] : [];
            if (Number(bill.commonFee) > 0
                && !otherItems.some((x) => /ส่วนกลาง/.test(String((x && x.label) || '')))) {
              otherItems.push({ label: 'ค่าส่วนกลาง', amount: Number(bill.commonFee) });
            }
            if (Number(bill.paymentReferenceCents) > 0) {
              otherItems = billing.appendPaymentReferenceLine(otherItems, bill.paymentReferenceCents);
            }
            const otherJson = JSON.stringify(otherItems);
            const moneyDiffers = (left, right) =>
              Math.abs((Number(left) || 0) - (Number(right) || 0)) > billing.PAYMENT_TOLERANCE_THB;
            const nullableNumberDiffers = (left, right) => {
              const l = numOrNull(left);
              const r = numOrNull(right);
              if (l == null || r == null) return l !== r;
              return Math.abs(l - r) > billing.PAYMENT_TOLERANCE_THB;
            };
            const ymd = (value) => {
              if (!value) return '';
              if (value instanceof Date) return value.toISOString().slice(0, 10);
              return String(value).slice(0, 10);
            };
            const stableOtherJson = (value) => {
              if (value == null) return '[]';
              if (typeof value === 'string') {
                try { return JSON.stringify(JSON.parse(value)); } catch { return value; }
              }
              return JSON.stringify(value);
            };
            if (existing) {
              const payableStatus = existing.status === 'pending' || existing.status === 'overdue';
              // Scheduler-accrued late_fee is NOT drift — see
              // regenPreservedLateFeeAndStatus. The recomputed principal
              // coexists with the preserved fee (total = subtotal + vat +
              // late_fee holds), and only a due date moved off 'past due'
              // resets the fee + downgrades a stale 'overdue'.
              const preserved = regenPreservedLateFeeAndStatus(existing, bill.dueDate);
              const totalWithFee = billing.round2(
                (Number(bill.subtotal) || 0) + (Number(bill.vat) || 0) + preserved.lateFee
              );
              const changed =
                moneyDiffers(existing.rent, bill.rent) ||
                nullableNumberDiffers(existing.water_prev_reading, bill.waterPrevReading) ||
                nullableNumberDiffers(existing.water_current_reading, bill.waterCurrentReading) ||
                moneyDiffers(existing.water_units, bill.waterUnits) ||
                moneyDiffers(existing.water_rate, bill.waterRate) ||
                moneyDiffers(existing.water_amount, bill.waterAmount) ||
                nullableNumberDiffers(existing.elec_prev_reading, bill.elecPrevReading) ||
                nullableNumberDiffers(existing.elec_current_reading, bill.elecCurrentReading) ||
                moneyDiffers(existing.elec_units, bill.elecUnits) ||
                moneyDiffers(existing.elec_rate, bill.elecRate) ||
                moneyDiffers(existing.elec_amount, bill.elecAmount) ||
                moneyDiffers(existing.wifi, bill.wifi) ||
                stableOtherJson(existing.other) !== otherJson ||
                moneyDiffers(existing.subtotal, bill.subtotal) ||
                moneyDiffers(existing.vat, bill.vat) ||
                moneyDiffers(existing.late_fee, preserved.lateFee) ||
                moneyDiffers(existing.total, totalWithFee) ||
                ymd(existing.due_date) !== ymd(bill.dueDate);
              if (!payableStatus || existing.has_verified_payment) {
                await billClient.query('COMMIT');
                bumpSkip('locked');
                continue;
              }
              if (!changed) {
                await billClient.query('COMMIT');
                bumpSkip('unchanged');
                continue;
              }
              await billClient.query(
                `UPDATE bills SET
                    tenant_id=$2,
                    rent=$3,
                    water_prev_reading=$4, water_current_reading=$5,
                    water_units=$6, water_rate=$7, water_amount=$8,
                    elec_prev_reading=$9, elec_current_reading=$10,
                    elec_units=$11, elec_rate=$12, elec_amount=$13,
                    wifi=$14, other=$15::jsonb,
                    subtotal=$16, vat=$17, late_fee=$18, total=$19, due_date=$20,
                    status=$21
                  WHERE id=$1`,
                [
                  existing.id, tenantIdForRoom, bill.rent,
                  bill.waterPrevReading, bill.waterCurrentReading,
                  bill.waterUnits, bill.waterRate, bill.waterAmount,
                  bill.elecPrevReading, bill.elecCurrentReading,
                  bill.elecUnits, bill.elecRate, bill.elecAmount,
                  bill.wifi, otherJson,
                  bill.subtotal, bill.vat, preserved.lateFee, totalWithFee,
                  bill.dueDate, preserved.status,
                ]
              );
              if (usedOneOffIds.length) {
                await billClient.query(
                  `UPDATE recurring_charges SET active=FALSE, updated_at=NOW()
                     WHERE id = ANY($1::bigint[])`,
                  [usedOneOffIds]
                );
              }
              await billClient.query('COMMIT');
              if (preserved.status !== existing.status) {
                // overdue → pending downgrade must cascade to the room card
                // immediately — same pattern as /void's post-commit sync.
                require('../services/roomStatus')
                  .syncRoom(pool, room.id, { reason: 'bill-bulk-regenerate' })
                  .catch((err) => console.warn('[bulk-generate] room sync failed:', err.message));
              }
              updated++;
              continue;
            }
            // R4 — try the default bill_no first; on collision retry once
            // with the `-T${tenantId}` suffix (only when there's actually
            // a different tenant taking up the room+period slot). Keeps the
            // single-tenant case's bill_no shape stable for backward compat.
            const buildInsert = (billNoForInsert) => billClient.query(
              `INSERT INTO bills
                 (bill_no, tenant_id, room_id, period, rent,
                  water_prev_reading, water_current_reading, water_units, water_rate, water_amount,
                  elec_prev_reading, elec_current_reading, elec_units, elec_rate, elec_amount,
                  wifi, other,
                  subtotal, vat, late_fee, total, due_date, status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,
                       $18,$19,$20,$21,$22,'pending')
               ON CONFLICT (bill_no) DO NOTHING
               RETURNING id, bill_no`,
              [
                billNoForInsert, tenantIdForRoom, bill.roomId, bill.period,
                bill.rent,
                bill.waterPrevReading, bill.waterCurrentReading,
                bill.waterUnits, bill.waterRate, bill.waterAmount,
                bill.elecPrevReading, bill.elecCurrentReading,
                bill.elecUnits, bill.elecRate, bill.elecAmount,
                bill.wifi, otherJson,
                bill.subtotal, bill.vat, bill.lateFee, bill.total,
                bill.dueDate,
              ]
            );
            let ins = await buildInsert(bill.billNo);
            if (ins.rowCount === 0) {
              const probe = await billClient.query(
                `SELECT tenant_id, status, deleted_at FROM bills
                  WHERE bill_no = $1 LIMIT 1`,
                [bill.billNo]
              );
              const blocking = probe.rows[0];
              const existingTenantId = blocking?.deleted_at == null ? blocking?.tenant_id : null;
              if (tenantIdForRoom && existingTenantId != null
                  && Number(existingTenantId) !== Number(tenantIdForRoom)) {
                const suffixed = billing.makeBillNo(bill.roomId, period, { tenantId: tenantIdForRoom });
                ins = await buildInsert(suffixed);
              } else if (blocking && (blocking.status === 'void' || blocking.deleted_at != null)) {
                // bill_no is globally UNIQUE *including* void rows, but the
                // room/period guard index ignores them — void-then-regenerate
                // is the documented correction flow, so climb the attempt
                // suffix instead of miscounting the room as 'duplicate'.
                for (let attempt = 2; attempt <= 5 && ins.rowCount === 0; attempt++) {
                  ins = await buildInsert(billing.makeBillNo(bill.roomId, period, { attempt }));
                }
              }
            }
            if (ins.rowCount) {
              if (usedOneOffIds.length) {
                await billClient.query(
                  `UPDATE recurring_charges SET active=FALSE, updated_at=NOW()
                     WHERE id = ANY($1::bigint[])`,
                  [usedOneOffIds]
                );
              }
              await billClient.query('COMMIT');
              made++;
            } else {
              // ON CONFLICT DO NOTHING returns 0 when the bill_no
              // collided — the bill wasn't created this run, so we
              // mustn't mark one_offs inactive. COMMIT (no-op) and skip.
              await billClient.query('COMMIT');
              bumpSkip('duplicate');
            }
          } catch (e) {
            await billClient.query('ROLLBACK').catch(() => {});
            // A7 — partial unique on (room_id, period) also blocks duplicates
            // when the two paths produce different bill_nos for same period.
            if (e.code !== '23505') console.error('[bulk-generate] insert failed:', e.message);
            bumpSkip(e.code === '23505' ? 'duplicate' : 'error');
          } finally {
            billClient.release();
          }
        }
        const skipSummary = Object.fromEntries(
          Object.entries(skipReasons).filter(([, count]) => count > 0)
        );
        audit(req, 'bill.bulk_generate', 'period', period, {
          made, updated, skipped,
          firstMonthSkipped: firstMonthSkipped.length,
          tenantlessSkipped: tenantlessSkipped.length,
          dueDaySources,
          skipSummary,
        });
        res.json({ ok: true, period, made, updated, skipped, flatFellBack,
          skipSummary,
          firstMonthSkipped,
          tenantlessSkipped,
          // How many rooms used which due-day source ('contract' = pinned by
          // the signed snapshot; those ignore the per-run dueDay selector).
          dueDaySources,
          warnings: issues.filter((i) => i.sev !== 'high') });
      } catch (err) {
        console.error('bulk-generate error:', err);
        res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
      }
    });

  // Internal helper used by both /:id/send and /bulk-send so neither path
  // round-trips through HTTP. Previously bulk-send self-fetched localhost
  // without admin session/CSRF, so it always enqueued 0.
  //
  // Earlier version refused a second reminder within 60 minutes via a hard
  // 409 REMINDER_DEBOUNCED. Admin asked for this to be informational
  // instead — they want to be able to resend immediately (e.g. tenant
  // calls saying they didn't see the first message), with only a warning
  // shown ahead of time. The function still STAMPS last_reminded_at +
  // bumps reminder_count so the UI can display "ส่งไปแล้ว N ครั้ง · ล่า
  // สุดเมื่อ X" the next time admin opens the confirm modal.
  //
  // R7-followup — hard 1-minute cooldown to protect against tenant spam
  // when scheduler.tickPaymentReminder and admin /send race within seconds
  // of each other. The scheduler check (`last_reminded_at < CURRENT_DATE`)
  // protects the daily cron; this guard protects the manual path. Pass
  // `opts.force = true` to override (e.g. admin explicitly said "I know,
  // send again" in a confirm modal) — exposed via the existing /send
  // endpoint's `force` field.
  async function enqueueBillNotifications(billId, _opts = {}) {
    // Filter the tenant join on deleted_at AND status — without these we
    // happily pushed bill reminders to soft-deleted tenants (whose
    // line_user_id was still in the row) and to ex-tenants who had
    // moved_out months ago. Verify the tenant's current room too, so an
    // admin clicking "ส่งเตือน" on a 6-month-old bill doesn't ping the
    // person now living in a different unit.
    const billQ = await pool.query(
      `SELECT b.*, t.id AS tenant_row_id, t.full_name AS tenant_name, t.phone AS tenant_phone,
              t.line_user_id, t.line_oa_id, t.email,
              t.status AS tenant_status, t.current_room_id AS tenant_current_room
         FROM bills b
         LEFT JOIN tenants t
           ON t.id = b.tenant_id
          AND t.deleted_at IS NULL
         WHERE b.id=$1 AND b.deleted_at IS NULL`,
      [billId]
    );
    if (!billQ.rows.length) return { ok: false, error: 'not found' };
    if (billQ.rows[0].status === 'void') return { ok: false, error: 'bill is void' };
    // Refuse to re-send reminders for bills that have already been paid.
    // Without this guard, admin could re-trigger "ขอเตือนชำระค่าเช่า" on
    // a row that was paid hours ago — the tenant gets a confusing
    // "please pay" message after they already did, and support tickets
    // pile up. This protects BOTH the single-bill /:id/send route AND
    // the bulk-send loop (which technically filters by status, but
    // belt-and-braces in the shared helper closes any future caller too).
    if (billQ.rows[0].status === 'paid') {
      return {
        ok: false,
        error: 'บิลนี้ชำระเรียบร้อยแล้ว ไม่ต้องส่งเตือนอีก',
        code: 'BILL_ALREADY_PAID',
        paidAt: billQ.rows[0].paid_at,
        hint: 'ตรวจสอบที่ /admin#payments ว่าใครเป็นคนยืนยัน',
      };
    }
    // R7-followup — 1-minute cooldown to bullet-proof against the scheduler
    // racing the admin. tickPaymentReminder fires daily; if admin clicks
    // /send within the same minute the scheduler did, both would enqueue
    // and the tenant receives 2 LINE pushes for the same bill. The cooldown
    // blocks the second send unless the caller explicitly opts in with
    // `force: true`. The send-readiness endpoint surfaces last_reminded_at
    // + reminder_count so the admin UI can show "ส่งไปแล้ว N ครั้ง · ล่าสุด
    // X นาทีก่อน" and a "บังคับส่งซ้ำ" checkbox to set force=true.
    const REMINDER_COOLDOWN_MS = 60_000;   // 1 minute
    if (!_opts.force && billQ.rows[0].last_reminded_at) {
      const since = Date.now() - new Date(billQ.rows[0].last_reminded_at).getTime();
      if (Number.isFinite(since) && since >= 0 && since < REMINDER_COOLDOWN_MS) {
        return {
          ok: false,
          error: `เพิ่งส่งเตือนไปเมื่อ ${Math.max(1, Math.ceil(since / 1000))} วินาทีก่อน — รออย่างน้อย ${Math.ceil(REMINDER_COOLDOWN_MS / 1000)} วินาทีก่อนส่งซ้ำ หรือส่ง force:true เพื่อข้าม`,
          code: 'REMINDER_COOLDOWN',
          cooldownMs: REMINDER_COOLDOWN_MS - since,
          lastRemindedAt: billQ.rows[0].last_reminded_at,
          hint: 'ใช้ตอน admin คลิก "บังคับส่งซ้ำ" ในกล่องยืนยัน',
        };
      }
    }
    // No daily-level debounce — admin can still resend manually within the
    // hour (just not within the same minute). The send-readiness
    // endpoint surfaces last_reminded_at + reminder_count so the confirm
    // modal can show "ส่งไปแล้ว N ครั้ง · ล่าสุด X นาทีก่อน" BEFORE the
    // admin clicks. Removing the block here means an intentional resend
    // (tenant called saying they didn't see the first message) works
    // without forcing admin to wait 60 min.
    const b = billQ.rows[0];
    const flags = await features.load(pool).catch(() => ({}));
    const emailReady = billEmailReady(flags);
    const configRow = await pool.query(
      `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
    );
    const paymentBlock = billing.buildPaymentBlock(configRow.rows[0]?.value || {});
    const bankInfo = paymentBlock.bankInfo && paymentBlock.bankInfo.account
      ? paymentBlock.bankInfo
      : null;
    let canShowPromptPayQr = false;
    if (paymentBlock.promptpayTarget) {
      try {
        const normalizedPromptPay = promptpay.normaliseTarget(paymentBlock.promptpayTarget);
        canShowPromptPayQr = !promptpay.isDemoTarget(normalizedPromptPay);
      } catch {
        canShowPromptPayQr = false;
      }
    }
    const paymentChoices = [];
    // Refuse to send when the bill isn't linked to a live tenant. The
    // earlier code reached this state via several silent paths (orphan
    // bill with tenant_id NULL, tenant soft-deleted after bill creation,
    // tenant moved_out without checkout closing the contract). Surface
    // each one with a distinct code so the admin UI can explain it.
    if (b.tenant_id == null) {
      return {
        ok: false,
        error: 'บิลนี้ไม่ได้ผูกกับผู้เช่า (tenant_id IS NULL)',
        code: 'BILL_NOT_LINKED',
        hint: 'ผูกผู้เช่าให้บิลก่อน หรือ void บิลถ้าตัดสินใจไม่เก็บ',
      };
    }
    if (!b.tenant_row_id) {
      return {
        ok: false,
        error: 'ผู้เช่าที่ผูกกับบิลนี้ถูกลบไปแล้ว',
        code: 'TENANT_DELETED',
        hint: 'void บิลนี้ แล้วออกบิลใหม่ให้ผู้เช่าปัจจุบัน',
      };
    }
    if (!billTenantCanReceiveDebtNotice(b.tenant_status)) {
      return {
        ok: false,
        error: `ผู้เช่าสถานะ "${b.tenant_status}" — ไม่ใช่ผู้เช่าปัจจุบันของห้อง`,
        code: 'TENANT_NOT_ACTIVE',
        tenantStatus: b.tenant_status,
        hint: 'ส่งบิลให้ผู้เช่าปัจจุบันแทน หรือติดต่อผู้เช่าเก่าโดยตรง',
      };
    }
    if (!billTenantRoomStillMatches(b)) {
      // The tenant the bill points at has since moved to a different room
      // (admin re-assigned them mid-period). Sending the bill notification
      // would reach the right person but reference the wrong room, which
      // confuses tenants and triggers "นี่ไม่ใช่ห้องของผม" complaints.
      return {
        ok: false,
        error: billTenantRoomMismatchMessage(b),
        code: 'TENANT_MOVED_ROOM',
        currentRoom: b.tenant_current_room,
        billRoom: b.room_id,
        hint: billTenantRoomMismatchHint(b),
      };
    }
    const subject = `บิลรอบ ${b.period} — ห้อง ${b.room_id}`;
    // Deep link to the bill detail in the tenant portal. With this, tapping
    // the LINE/email notification opens the bill modal directly — no need
    // for the tenant to manually navigate /tenant → find the right bill in
    // the list. PUBLIC_URL is set by the deploy (Railway sets it
    // automatically as RAILWAY_PUBLIC_DOMAIN; we fall back to empty string
    // so dev runs without the env var still produce a relative link the
    // tenant.jsx side can route on). The `?bill=ID` query param is what
    // the BillsView reads to auto-open the matching modal.
    const publicUrl = (process.env.PUBLIC_URL
      || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
      || '').replace(/\/+$/, '');
    const payToken = (publicUrl && typeof signBillPayToken === 'function')
      ? signBillPayToken(billId)
      : null;
    const qrToken = typeof signBillQrToken === 'function'
      ? signBillQrToken(billId)
      : null;
    const canEmbedPromptPayQr = !!(publicUrl && qrToken && canShowPromptPayQr);
    const qrVersion = `${billId}-${String(b.status || 'pending')}-${Date.now()}`;
    const billLink = (publicUrl && payToken)
      ? `${publicUrl}/pay/${encodeURIComponent(billId)}?t=${encodeURIComponent(payToken)}`
      : (b.tenant_status === 'moved_out'
          ? 'ติดต่อแอดมินเพื่อขอลิงก์ชำระเงินใหม่'
          : `${publicUrl}/tenant?bill=${encodeURIComponent(billId)}`);
    const dueDateStr = b.due_date
      ? new Date(b.due_date).toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' })
      : '-';
    const fallbackHelp = b.tenant_status === 'moved_out'
      ? `หากลิงก์ชำระเงินเปิดไม่ได้ กรุณาติดต่อแอดมินและแจ้งบิล ${b.bill_no || `#${billId}`}`
      : null;
    const lineRecipients = await notifier.getTenantLineRecipients(pool, {
      id: b.tenant_row_id,
      line_user_id: b.line_user_id,
      line_oa_id: b.line_oa_id,
    });
    const lineBindingCount = lineRecipients.length;
    if (canShowPromptPayQr) {
      paymentChoices.push(canEmbedPromptPayQr
        ? `1) สแกน QR PromptPay ใน LINE/หน้าบิล`
        : `1) สแกน QR PromptPay ในหน้าบิล`);
    }
    if (bankInfo) {
      paymentChoices.push([
        `${paymentChoices.length + 1}) โอนเข้าบัญชีธนาคาร`,
        `   ธนาคาร: ${bankInfo.bank || '-'}`,
        `   เลขบัญชี: ${bankInfo.account}`,
        bankInfo.name ? `   ชื่อบัญชี: ${bankInfo.name}` : null,
      ].filter(Boolean).join('\n'));
    }
    const body = [
      `📋 บิลใหม่ — ${b.period}`,
      ``,
      `ห้อง: ${b.room_id}`,
      `ยอดชำระ: ฿${Number(b.total).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`,
      `กำหนดชำระ: ${dueDateStr}`,
      `LINE ที่ผูกกับห้องนี้: ${lineBindingCount} บัญชี`,
      ``,
      `วิธีชำระเงิน:`,
      paymentChoices.length ? paymentChoices.join('\n') : `เปิดหน้าบิลเพื่อตรวจสอบช่องทางชำระเงิน`,
      ``,
      `👉 ดูบิล + ส่งสลิป:`,
      billLink,
      ``,
      fallbackHelp ||
      `(หากกดลิงก์ไม่ได้ ให้เข้า ${publicUrl || 'พอร์ทัล'}/tenant แล้วเลือกบิล ${b.bill_no || `#${billId}`})`,
    ].join('\n');
    const enqueued = [];
    const hasLine = lineRecipients.length > 0;
    const canEmailTenant = !!b.email && emailReady;
    if (!hasLine && !canEmailTenant) {
      const owner = await notifier.notifyOwner({ pool, features: flags }, {
        category: 'billing',
        subject: b.email
          ? 'Bill send skipped: email not configured'
          : 'Bill send skipped: no tenant channel',
        text: [
          b.email
            ? `Bill was not sent because SMTP/email is not configured.`
            : `Bill was not sent because the tenant has no LINE or email.`,
          `Bill: ${b.bill_no || b.id}`,
          `Room: ${b.room_id}`,
          b.tenant_name ? `Tenant: ${b.tenant_name}` : null,
          b.email ? `Email: ${b.email}` : null,
          `Amount: THB ${Number(b.total).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`,
        ].filter(Boolean).join('\n'),
      });
      return {
        ok: false,
        error: b.email
          ? 'tenant has email but SMTP/email is not configured'
          : 'tenant has no reachable channel',
        code: b.email ? 'EMAIL_NOT_CONFIGURED' : 'NO_TENANT_CHANNEL',
        enqueued,
        lineCount: lineBindingCount,
        ownerNotified: !!(owner.ok || owner.queued),
      };
    }
    // R7-followup-2 — ATOMIC cooldown claim. The SELECT-based check above is
    // a fast-fail for friendly error copy; this conditional UPDATE is the
    // actual race guard: two concurrent callers (scheduler tickPaymentReminder
    // racing an admin /send, bulk-send racing a single send, or a
    // double-click) can BOTH pass the stale read, but only one wins this
    // stamp. force:true still claims, so the next caller's window restarts.
    // Claimed before enqueueing — every no-channel/validation path has
    // already returned above. If an enqueue throws after the claim, the cost
    // is a 60s cooldown on retry (or force:true), which is strictly better
    // than the duplicate LINE push this guard exists to prevent.
    const claim = await pool.query(
      `UPDATE bills
         SET last_reminded_at=NOW(),
             reminder_count = COALESCE(reminder_count, 0) + 1
       WHERE id=$1
         AND ($2::boolean
              OR last_reminded_at IS NULL
              OR last_reminded_at < NOW() - ($3::int * INTERVAL '1 millisecond'))
       RETURNING last_reminded_at`,
      [billId, !!_opts.force, REMINDER_COOLDOWN_MS]
    );
    if (!claim.rows.length) {
      return {
        ok: false,
        error: 'มีคำขอส่งเตือนบิลนี้ซ้อนกันจากอีกช่องทาง — ระบบกันส่งซ้ำให้แล้ว',
        code: 'REMINDER_COOLDOWN',
        cooldownMs: REMINDER_COOLDOWN_MS,
        lastRemindedAt: b.last_reminded_at,
        hint: 'อีกคำขอเพิ่งส่งสำเร็จภายในไม่กี่วินาที — ไม่ต้องส่งซ้ำ หรือส่ง force:true ถ้าตั้งใจ',
      };
    }
    if (hasLine) {
      // Build a Flex Message bundle (Flex bubble + text fallback) so the
      // tenant sees the bill summary + QR image + "จ่ายเลย" button in the
      // LINE chat directly — no need to open the portal first to scan QR.
      // Falls back to text-only when signBillQrToken isn't available
      // (legacy startup without ctx wiring) or PUBLIC_URL isn't set.
      const lineMessages = (publicUrl && (canEmbedPromptPayQr || bankInfo))
        ? buildBillLineMessages(b, {
            publicUrl,
            billLink,
            dueDateStr,
            billNo: b.bill_no,
            qrToken: canEmbedPromptPayQr ? qrToken : null,
            qrVersion: canEmbedPromptPayQr ? qrVersion : null,
            bankInfo,
            lineCount: lineBindingCount,
          })
        : null;
      for (const recipient of lineRecipients) {
        const qid = await notifQueue.enqueue(pool, {
          channel: 'line', recipient: recipient.line_user_id, subject, body,
          // payload.messages carries the raw LINE message array; the queue
          // dispatcher uses pushMessages when this is present, falling back
          // to plain pushText when absent. Keep `body` populated either way
          // as a safety net + for the email channel duplicated below.
          payload: {
            oaId: recipient.line_oa_id || null,
            billId,
            messages: lineMessages,
          },
        });
        enqueued.push({ channel: 'line', id: qid, recipient: recipient.line_user_id });
      }
    } else if (!canEmailTenant) {
      const lineOwner = require('../services/secrets').get('LINE_OWNER_USER_ID');
      if (lineNotify.isLikelyUserId(lineOwner)) {
        // Owner channel — falls back to default OA via getDefault().
        const qid = await notifQueue.enqueue(pool, {
          channel: 'line', recipient: lineOwner, subject, body,
          payload: { oaId: null, billId, target: 'owner' },
        });
        enqueued.push({ channel: 'line', id: qid });
      }
    }
    if (canEmailTenant) {
      const qid = await notifQueue.enqueue(pool, {
        channel: 'email', recipient: b.email, subject, body,
        payload: { billId },
      });
      enqueued.push({ channel: 'email', id: qid });
    }
    // last_reminded_at + reminder_count were already stamped by the atomic
    // claim above (BEFORE enqueueing) — the send modal's "ส่งไปแล้ว N ครั้ง ·
    // ล่าสุด ..." copy reads those same columns.
    return { ok: true, enqueued, lineCount: lineBindingCount };
  }

  // POST /api/bills/:id/send — enqueue LINE/email
  // supersededCount: number of pending slips that this manual-pay
  // auto-rejected as siblings. When > 0 we mention it in the message
  // so the tenant understands their "รอตรวจสอบ" slip status changed.
  // Without this hint the tenant might open /tenant later and see a
  // surprise "rejected" badge on a slip they thought was still queued.
  async function notifyManualPayment(payment, bill, actor, supersededCount = 0) {
    if (!payment || !payment.tenant_id) return;
    const { rows } = await pool.query(
      `SELECT id, full_name, phone, email, line_user_id, line_oa_id, status
         FROM tenants
        WHERE id=$1 AND deleted_at IS NULL
        LIMIT 1`,
      [payment.tenant_id]
    );
    if (!rows.length) return;
    const flags = await features.load(pool);
    const amount = Number(payment.amount);
    const amountText = Number.isFinite(amount)
      ? amount.toLocaleString('th-TH', { minimumFractionDigits: 2 })
      : '-';
    // Translate the payment method code into the Thai label the tenant
    // expects to see. "transfer" was the old hardcoded value when admin
    // had no method picker; the new UI lets admin choose cash/transfer/
    // promptpay, and the tenant's confirmation reads in plain Thai so
    // there's no ambiguity about how the bill was recorded as paid.
    const methodTh = ({
      cash: '💵 รับเงินสดที่สำนักงาน',
      transfer: '🏦 โอนผ่านธนาคาร',
      promptpay: '📱 PromptPay',
      manual: '👤 บันทึกโดยเจ้าหน้าที่',
    })[String(payment.method || 'manual').toLowerCase()]
      || `ช่องทางอื่น (${payment.method || 'manual'})`;
    const supersededLine = supersededCount > 0
      ? `\n📝 ระบบยกเลิกสลิปที่รออยู่ ${supersededCount} ใบ (เพราะบิลนี้ชำระเรียบร้อยแล้ว)`
      : null;
    await notifier.notifyTenant({ pool, features: flags }, rows[0], {
      subject: '✅ ยืนยันการชำระเงินเรียบร้อยแล้ว',
      text: [
        `เรียน คุณ${rows[0].full_name || ''}`,
        '',
        '🎉 ระบบบันทึกการชำระเงินของคุณเรียบร้อยแล้ว',
        '',
        `📄 บิล: ${bill?.bill_no || `#${payment.bill_id}` || '-'}${bill?.period ? ` (รอบ ${bill.period})` : ''}`,
        `💰 จำนวน: ฿${amountText}`,
        `💳 ช่องทางชำระ: ${methodTh}`,
        payment.ref ? `🔖 อ้างอิง: ${payment.ref}` : null,
        actor ? `👤 บันทึกโดย: ${actor}` : null,
        supersededLine,
        '',
        'สถานะ: ชำระแล้ว ✓',
        'ใบเสร็จ: ดูได้ที่พอร์ทัลผู้เช่า /tenant',
      ].filter(Boolean).join('\n'),
      force: true,
    });
  }

  // GET /api/bills/send-readiness-batch?period=YYYY-MM — bulk preflight.
  // Returns a compact map { billId → { canSend, blockCode, channels } } for
  // every pending/overdue bill in the period so the admin UI can render
  // per-row status icons without N round-trips. Uses the same join+filter
  // logic as enqueueBillNotifications but stops at status detection
  // (no notifications enqueued).
  r.get('/send-readiness-batch', requireAuth, requireRole('owner', 'manager'),
    async (req, res) => {
      const period = String(req.query.period || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(period)) {
        return res.status(400).json({ error: 'period required (YYYY-MM)', code: 'INVALID_PERIOD' });
      }
      try {
        // One query joining bills + tenants + their move-in room.
        // last_reminded_at / reminder_count are pulled too so the table
        // can render per-row "ส่งแล้ว N ครั้ง · X ชม.ก่อน" without an
        // extra round-trip per bill.
        const { rows } = await pool.query(
          `SELECT b.id, b.bill_no, b.room_id, b.status AS bill_status,
                  b.tenant_id, b.last_reminded_at, b.reminder_count,
                  t.id AS tenant_row_id, t.full_name AS tenant_name,
                  t.line_user_id, t.line_oa_id, t.email,
                  t.status AS tenant_status, t.current_room_id AS tenant_current_room
             FROM bills b
             LEFT JOIN tenants t
               ON t.id = b.tenant_id
              AND t.deleted_at IS NULL
            WHERE b.period = $1
              AND b.deleted_at IS NULL
              AND b.status IN ('pending','overdue')
            ORDER BY b.id ASC`,
          [period]
        );
        const billsMap = {};
        const issueCounts = {};      // code → count for summary
        let canSendCount = 0, blockedCount = 0;
        const flags = await features.load(pool).catch(() => ({}));
        const emailReady = billEmailReady(flags);
        for (const b of rows) {
          // Compute one "block" code per bill so the UI shows the most
          // urgent reason. Order mirrors enqueueBillNotifications' early-
          // return chain (most specific → least).
          let blockCode = null;
          let blockMsg = null;
          if (b.tenant_id == null) {
            blockCode = 'BILL_NOT_LINKED';
            blockMsg = 'บิลไม่ได้ผูกผู้เช่า';
          } else if (!b.tenant_row_id) {
            blockCode = 'TENANT_DELETED';
            blockMsg = 'ผู้เช่าถูกลบไปแล้ว';
          } else if (!billTenantCanReceiveDebtNotice(b.tenant_status)) {
            blockCode = 'TENANT_NOT_ACTIVE';
            blockMsg = `ผู้เช่าสถานะ "${b.tenant_status}"`;
          } else if (!billTenantRoomStillMatches(b)) {
            blockCode = 'TENANT_MOVED_ROOM';
            blockMsg = b.tenant_current_room
              ? `ย้ายไปห้อง ${b.tenant_current_room}`
              : 'active แต่ไม่ผูกห้องปัจจุบัน';
          } else {
            const lineRecipients = await notifier.getTenantLineRecipients(pool, {
              id: b.tenant_row_id,
              line_user_id: b.line_user_id,
              line_oa_id: b.line_oa_id,
            });
            b._lineRecipients = lineRecipients;
            const hasLine = lineRecipients.length > 0;
            if (!hasLine && !b.email) {
              blockCode = 'NO_TENANT_CHANNEL';
              blockMsg = 'ไม่ผูก LINE + ไม่มีอีเมล';
            } else if (!hasLine && b.email && !emailReady) {
              blockCode = 'EMAIL_NOT_CONFIGURED';
              blockMsg = 'มีอีเมล แต่ระบบ SMTP ยังไม่พร้อม';
            }
          }
          const lineRecipients = Array.isArray(b._lineRecipients) ? b._lineRecipients : [];
          const channels = {
            line: lineRecipients.length > 0,
            lineCount: lineRecipients.length,
            email: !!b.email && emailReady,
            emailAddress: b.email || null,
            emailConfigured: emailReady,
          };
          const reminderCount = Number(b.reminder_count) || 0;
          const minutesAgo = b.last_reminded_at
            ? Math.max(0, Math.round(
                (Date.now() - new Date(b.last_reminded_at).getTime()) / 60_000))
            : null;
          billsMap[b.id] = {
            canSend: !blockCode,
            blockCode,
            blockMsg,
            channels,
            tenantName: b.tenant_name || null,
            tenantStatus: b.tenant_status || null,
            tenantCurrentRoom: b.tenant_current_room || null,
            billRoom: b.room_id || null,
            warnCode: !blockCode && b.tenant_status === 'moved_out'
              ? 'EX_TENANT_BILL'
              : (!blockCode && !channels.line && channels.email ? 'EMAIL_ONLY'
                  : (!blockCode && channels.line && channels.emailAddress && !channels.email ? 'EMAIL_DISABLED' : null)),
            reminderCount,
            lastRemindedAt: b.last_reminded_at,
            minutesAgo,
          };
          if (blockCode) {
            blockedCount++;
            issueCounts[blockCode] = (issueCounts[blockCode] || 0) + 1;
          } else {
            canSendCount++;
          }
        }
        res.json({
          ok: true,
          period,
          summary: {
            total: rows.length,
            canSend: canSendCount,
            blocked: blockedCount,
            issueCounts,    // { NO_TENANT_CHANNEL: 3, TENANT_MOVED_ROOM: 1, ... }
          },
          bills: billsMap,
        });
      } catch (err) {
        console.error('send-readiness-batch error:', err);
        res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
      }
    });

  // GET /api/bills/:id/send-readiness — preflight that returns structured
  // issues so the admin UI can render a confirm modal BEFORE firing
  // /:id/send. Without this the UI either silently failed (bill sent to a
  // moved-out tenant) or relied on window.confirm with rough hints.
  // Returns { ok, summary: { canSend, blocked, channels }, issues[] }.
  r.get('/:id/send-readiness', requireAuth, requireRole('owner', 'manager'),
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
      try {
        const billQ = await pool.query(
          `SELECT b.id, b.bill_no, b.room_id, b.period, b.total, b.status, b.due_date,
                  b.tenant_id, b.last_reminded_at, b.reminder_count,
                  t.id AS tenant_row_id, t.full_name AS tenant_name, t.phone AS tenant_phone,
                  t.line_user_id, t.line_oa_id, t.email, t.status AS tenant_status,
                  t.current_room_id AS tenant_current_room
             FROM bills b
             LEFT JOIN tenants t
               ON t.id = b.tenant_id
              AND t.deleted_at IS NULL
            WHERE b.id=$1 AND b.deleted_at IS NULL`,
          [id]
        );
        if (!billQ.rows.length) return res.status(404).json({ error: 'bill not found' });
        const b = billQ.rows[0];
        const flags = await features.load(pool).catch(() => ({}));
        const emailReady = billEmailReady(flags);
        const issues = [];
        const channels = {
          line: false,
          lineCount: 0,
          email: false,
          emailAddress: b.email || null,
          emailConfigured: emailReady,
          lineOa: null,
        };

        // Bill state
        if (b.status === 'void') {
          issues.push({ sev: 'high', code: 'BILL_VOID',
            msg: 'บิลนี้ถูก void แล้ว — ไม่ควรส่งให้ผู้เช่า',
            fix: 'ออกบิลใหม่แทน' });
        } else if (b.status === 'paid') {
          issues.push({ sev: 'med', code: 'BILL_ALREADY_PAID',
            msg: 'บิลนี้ชำระแล้ว — ส่งซ้ำอาจทำให้ผู้เช่าสับสน',
            fix: 'หากต้องการส่งใบเสร็จ ใช้ปุ่ม PDF แทน' });
        }

        // Tenant validity
        if (b.tenant_id == null) {
          issues.push({ sev: 'high', code: 'BILL_NOT_LINKED',
            msg: 'บิลนี้ไม่มีผู้เช่าผูกอยู่ (tenant_id IS NULL)',
            fix: 'ผูกผู้เช่าที่หน้า /admin#billing ก่อน หรือ void บิล' });
        } else if (!b.tenant_row_id) {
          issues.push({ sev: 'high', code: 'TENANT_DELETED',
            msg: 'ผู้เช่าที่ผูกกับบิลถูกลบ (soft-deleted) ไปแล้ว',
            fix: 'void บิลแล้วออกใหม่ให้ผู้เช่าปัจจุบัน' });
        } else if (b.tenant_status === 'moved_out') {
          issues.push({ sev: 'med', code: 'EX_TENANT_BILL',
            msg: `บิลค้างของผู้เช่าที่ย้ายออก "${b.tenant_name}"`,
            fix: 'ส่งลิงก์ชำระเงินแบบมี token ให้ผู้เช่าเก่า โดยไม่เปิดสิทธิ์พอร์ทัลผู้เช่ากลับ' });
        } else if (!billTenantCanReceiveDebtNotice(b.tenant_status)) {
          issues.push({ sev: 'high', code: 'TENANT_NOT_ACTIVE',
            msg: `ผู้เช่า "${b.tenant_name}" สถานะ "${b.tenant_status}" — ไม่ใช่ผู้เช่าปัจจุบัน`,
            fix: 'ตรวจสถานะผู้เช่าใน /admin#tenants ก่อนส่งบิล หากยังอยู่ให้แก้เป็น active และผูกห้องให้ตรง' });
        } else if (!billTenantRoomStillMatches(b)) {
          issues.push({ sev: 'high', code: 'TENANT_MOVED_ROOM',
            msg: billTenantRoomMismatchMessage(b),
            fix: billTenantRoomMismatchHint(b) });
        }

        // Channel availability — only when tenant is otherwise valid
        if (b.tenant_row_id && billTenantCanReceiveDebtNotice(b.tenant_status)
            && billTenantRoomStillMatches(b)) {
          const lineRecipients = await notifier.getTenantLineRecipients(pool, {
            id: b.tenant_row_id,
            line_user_id: b.line_user_id,
            line_oa_id: b.line_oa_id,
          });
          const hasLine = lineRecipients.length > 0;
          channels.line = !!hasLine;
          channels.lineCount = lineRecipients.length;
          channels.email = !!b.email && emailReady;
          channels.lineOa = lineRecipients[0]?.line_oa_id || b.line_oa_id || null;
          if (!hasLine && !b.email) {
            issues.push({ sev: 'high', code: 'NO_TENANT_CHANNEL',
              msg: `ผู้เช่า "${b.tenant_name}" ยังไม่ผูก LINE และไม่ใส่อีเมล`,
              fix: '/admin#tenants → tab "Portal Access" ผูก LINE หรือใส่อีเมล' });
          } else if (!hasLine && b.email && !emailReady) {
            issues.push(billEmailConfigIssue(b.tenant_name));
          } else if (!hasLine && b.email) {
            issues.push({ sev: 'med', code: 'EMAIL_ONLY',
              msg: 'ผู้เช่าไม่ผูก LINE — จะส่งทางอีเมลอย่างเดียว (อาจไปกล่อง spam)',
              fix: 'แนะนำผูก LINE ที่ /admin#tenants → Portal Access' });
          } else if (hasLine && b.email && !emailReady) {
            issues.push({ sev: 'med', code: 'EMAIL_DISABLED',
              msg: 'ผู้เช่ามีอีเมล แต่ระบบอีเมลยังไม่พร้อม — รอบนี้จะส่งทาง LINE เท่านั้น',
              fix: 'ตั้งค่า SMTP หากต้องการส่งอีเมลสำรองด้วย' });
          }
        }

        // Surface previous send history so the admin's confirm modal can
        // show "ส่งไปแล้ว N ครั้ง · ล่าสุดเมื่อ X นาทีก่อน". The hard
        // debounce was removed in favor of admin judgment — resend works
        // immediately if admin confirms.
        //
        // Three layers of history are returned so the modal can answer
        // "did this tenant just hear from us?" at multiple scopes:
        //   count            — total reminders for THIS bill (all time)
        //   monthCount       — messages this tenant got THIS calendar
        //                      month across ALL their bills. Catches the
        //                      "tenant has 3 overdue bills and admin
        //                      bulk-resends every day" pattern that a
        //                      single-bill counter misses.
        //   recentSends      — last 5 enqueue rows for THIS bill, with
        //                      channel + status so admin sees the actual
        //                      timeline (10:30 LINE, 14:20 email, ...).
        const reminderCount = Number(b.reminder_count) || 0;
        let sendHistory = null;
        if (b.last_reminded_at || reminderCount > 0) {
          const minutesAgo = b.last_reminded_at
            ? Math.max(0, Math.round((Date.now() - new Date(b.last_reminded_at).getTime()) / 60_000))
            : null;
          sendHistory = {
            count: reminderCount,
            lastSentAt: b.last_reminded_at,
            minutesAgo,
            recently: minutesAgo != null && minutesAgo < 60,
            veryRecently: minutesAgo != null && minutesAgo < 5,
          };
        }

        // Cross-bill, this-month count for the tenant. We join the queue
        // back to bills via payload.billId so the count includes EVERY
        // enqueue for any of this tenant's bills in the current calendar
        // month — not just resends of the bill admin is currently looking
        // at. If the tenant lookup is unresolved (tenant_id null/deleted),
        // skip the query and leave monthCount=0.
        //
        // We count distinct (billId, second) groups instead of raw queue
        // rows. One admin click that fans out to LINE + email creates 2
        // queue rows in the same millisecond; counting them as one
        // "send action" matches what admin actually did and keeps the
        // number consistent with bills.reminder_count (which bumps per
        // action, not per channel).
        if (b.tenant_id) {
          try {
            const monthRes = await pool.query(
              `SELECT COUNT(*)::int AS n,
                      MAX(t) AS last_at
                 FROM (
                   SELECT (q.payload->>'billId') AS bid,
                          date_trunc('second', q.created_at) AS t
                     FROM notifications_queue q
                    WHERE q.created_at >= date_trunc('month', NOW())
                      AND (q.payload->>'billId') IS NOT NULL
                      AND (q.payload->>'billId') ~ '^[0-9]+$'
                      AND (q.payload->>'billId')::bigint IN (
                        SELECT id FROM bills
                         WHERE tenant_id = $1
                           AND deleted_at IS NULL
                      )
                    GROUP BY 1, 2
                 ) g`,
              [b.tenant_id]
            );
            const n = monthRes.rows[0]?.n || 0;
            if (n > 0) {
              sendHistory = sendHistory || { count: reminderCount };
              sendHistory.monthCount = n;
              sendHistory.monthLastSentAt = monthRes.rows[0].last_at;
            } else if (sendHistory) {
              sendHistory.monthCount = 0;
            }
          } catch (err) {
            // notifications_queue might be missing in a fresh schema or
            // payload->>'billId' could be malformed in legacy rows.
            // Don't fail readiness — just omit the monthly stat.
            console.warn('[send-readiness] monthCount query failed:',
              err.message);
          }
        }

        // Per-bill recent timeline — last 5 enqueues so admin sees a real
        // timeline rather than just one "last sent" timestamp. We pull
        // from notifications_queue (every channel that was enqueued for
        // this bill_id gets a row, even if it later failed). The regex
        // guard prevents the cast from blowing up on legacy payload rows
        // where billId might be a non-numeric string.
        try {
          const recentRes = await pool.query(
            `SELECT id, channel, created_at, status
               FROM notifications_queue
              WHERE (payload->>'billId') IS NOT NULL
                AND (payload->>'billId') ~ '^[0-9]+$'
                AND (payload->>'billId')::bigint = $1
              ORDER BY id DESC
              LIMIT 5`,
            [id]
          );
          if (recentRes.rows.length > 0) {
            sendHistory = sendHistory || { count: reminderCount };
            sendHistory.recentSends = recentRes.rows.map((row) => ({
              at: row.created_at,
              channel: row.channel,
              status: row.status,
            }));
          }
        } catch (err) {
          console.warn('[send-readiness] recentSends query failed:',
            err.message);
        }

        const blockingHigh = issues.filter((i) => i.sev === 'high');
        const canSend = blockingHigh.length === 0;
        res.json({
          ok: true,
          summary: {
            canSend,
            blocked: !canSend,
            issueCount: issues.length,
            highCount: blockingHigh.length,
            channels,
            sendHistory,
          },
          bill: {
            id: b.id, billNo: b.bill_no, roomId: b.room_id, period: b.period,
            total: Number(b.total), status: b.status, dueDate: b.due_date,
            lastRemindedAt: b.last_reminded_at,
            reminderCount,
          },
          tenant: b.tenant_row_id ? {
            id: b.tenant_row_id, name: b.tenant_name, phone: b.tenant_phone,
            email: b.email, hasLine: channels.line, lineCount: channels.lineCount,
            status: b.tenant_status,
            currentRoom: b.tenant_current_room,
          } : null,
          issues,
        });
      } catch (err) {
        console.error('send-readiness error:', err);
        res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
      }
    });

  r.post('/:id/send', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
      // R7-followup — admin's "บังคับส่งซ้ำ" checkbox sets force=true to
      // bypass the 1-min cooldown that protects against tickPaymentReminder
      // races. Without force, two sends within the same minute return 429.
      const force = req.body?.force === true;
      try {
        const out = await enqueueBillNotifications(id, { force });
        if (!out.ok) {
          // Map cooldown to 429 (rate-limit-like) so the admin UI can show
          // a "ส่งซ้ำตอนนี้?" prompt instead of a generic error.
          const status = out.code === 'REMINDER_COOLDOWN' ? 429
            : out.code === 'EMAIL_NOT_CONFIGURED' ? 409
            : out.code === 'NO_TENANT_CHANNEL' ? 409
            : 404;
          return res.status(status).json({
            error: out.error,
            code: out.code,
            ownerNotified: out.ownerNotified,
            enqueued: out.enqueued || [],
            cooldownMs: out.cooldownMs,
            lastRemindedAt: out.lastRemindedAt,
            hint: out.hint,
          });
        }
        audit(req, 'bill.send', 'bill', String(id), { enqueued: out.enqueued, force });
        res.json({ ok: true, enqueued: out.enqueued });
      } catch (err) {
        console.error('bill send error:', err);
        res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
      }
    });

  // POST /api/bills/bulk-send — enqueue pending/overdue bill reminders for a
  // deliberate scope: { period }, { billIds }, or { all:true }. Requiring a
  // scope keeps the billing page from showing one period in the preview and
  // accidentally blasting every unpaid historical bill in the system.
  r.post('/bulk-send', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    async (req, res) => {
      try {
        const b = req.body || {};
        const rawIds = Array.isArray(b.billIds) ? b.billIds : [];
        const billIds = Array.from(new Set(rawIds
          .map((x) => Number(x))
          .filter((x) => Number.isInteger(x) && x > 0)));
        if (rawIds.length && billIds.length !== rawIds.length) {
          return res.status(400).json({
            error: 'billIds must contain only positive integers',
            code: 'INVALID_BILL_IDS',
          });
        }
        if (billIds.length > 500) {
          return res.status(400).json({
            error: 'billIds limit is 500 per bulk-send request',
            code: 'BILL_IDS_LIMIT',
          });
        }
        const period = b.period != null ? String(b.period).trim().slice(0, 16) : null;
        if (period && !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
          return res.status(400).json({
            error: 'period must be YYYY-MM',
            code: 'INVALID_PERIOD',
          });
        }
        const sendAll = b.all === true;
        if (!billIds.length && !period && !sendAll) {
          return res.status(400).json({
            error: 'bulk-send requires a scope: period, billIds, or all:true',
            code: 'BULK_SEND_SCOPE_REQUIRED',
            hint: 'Pass { period: "YYYY-MM" } from the billing page, { billIds:[...] } for selected rows, or { all:true } only for an intentional system-wide reminder.',
          });
        }

        let rows = [];
        let scope = null;
        if (billIds.length) {
          const q = await pool.query(
            `SELECT id FROM bills
              WHERE deleted_at IS NULL
                AND status IN ('pending','overdue')
                AND id = ANY($1::bigint[])
              ORDER BY due_date NULLS LAST, id ASC`,
            [billIds]
          );
          rows = q.rows;
          scope = { billIds };
        } else if (period) {
          const q = await pool.query(
            `SELECT id FROM bills
              WHERE deleted_at IS NULL
                AND status IN ('pending','overdue')
                AND period=$1
              ORDER BY due_date NULLS LAST, id ASC`,
            [period]
          );
          rows = q.rows;
          scope = { period };
        } else {
          const q = await pool.query(
            `SELECT id FROM bills
              WHERE deleted_at IS NULL
                AND status IN ('pending','overdue')
              ORDER BY due_date NULLS LAST, id ASC`
          );
          rows = q.rows;
          scope = { all: true };
        }
        let enqueued = 0, failed = 0;
        for (const row of rows) {
          try {
            const out = await enqueueBillNotifications(row.id);
            if (out.ok) enqueued++; else failed++;
          } catch { failed++; }
        }
        audit(req, 'bill.bulk_send', null, null, { scope, attempted: rows.length, enqueued, failed });
        res.json({ ok: true, scope, attempted: rows.length, enqueued, failed });
      } catch (err) {
        console.error('bulk-send error:', err);
        res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
      }
    });

  // POST /api/bills/:id/pay - owner/manager records an offline payment.
  // Inserts a verified payment row and marks the bill paid atomically.
  r.post('/:id/pay', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
      // Amount is required. Previously a missing amount silently fell
      // through to "pay billTotal", so an admin curl/script that
      // forgot the field paid the full bill without operator
      // confirmation — and the audit log captured only the resulting
      // amount, not the fact that no amount was specified. The current
      // admin UI always sends amount (page-billing.jsx:329), so this
      // tightening doesn't change the human flow.
      if (req.body?.amount == null) {
        return res.status(400).json({
          error: 'ต้องระบุยอดชำระ (amount)',
          code: 'AMOUNT_REQUIRED',
          hint: 'ส่ง amount ในตัว body — ระบบจะเทียบกับยอดบิลก่อนบันทึก',
        });
      }
      const requestedAmount = Number(req.body.amount);
      if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
        return res.status(400).json({ error: 'invalid amount', code: 'INVALID_AMOUNT' });
      }
      const methodRaw = String(req.body?.method || 'transfer').toLowerCase();
      const method = ['cash', 'transfer', 'promptpay'].includes(methodRaw) ? methodRaw : 'transfer';
      const ref = String(req.body?.ref || 'admin-manual').slice(0, 200);
      // Optional slip image — admin attaches a photo of the bank transfer
      // receipt, a hand-written cash receipt, or any other evidence. Same
      // base64 data URL format the tenant slip upload uses, so we can
      // pipe it through the existing storage.saveBase64 helper.
      const rawSlip = req.body?.slip ? String(req.body.slip) : null;
      // Defensive: requireAuth already gates this, but if session was reaped
      // between the middleware and here, req.session.user could be falsy.
      // Audit trail demands a non-null verifier name — fall back to a
      // sentinel so the INSERT doesn't violate NOT NULL on verified_by.
      const verifier = req.session?.user?.username || 'admin:unknown';
      // Save the optional slip to storage BEFORE opening the transaction so
      // a slow R2 upload doesn't hold a DB connection. If it fails, return
      // a clear error before any DB write happens.
      let slipUrl = null;
      let slipUploadId = null;
      if (rawSlip) {
        try {
          const flags = await features.load(pool).catch(() => ({}));
          const maxBytes = flags?.slipUpload?.maxBytes || 1_500_000;
          const allowedMimes = flags?.slipUpload?.allowedMimes
            || ['image/jpeg', 'image/png', 'image/webp'];
          const saved = await storage.saveBase64({
            pool,
            category: 'slip',
            dataUrl: rawSlip,
            refId: String(id),
            uploadedBy: `admin-manual:${verifier}`,
            maxBytes,
            allowedMimes,
          });
          slipUrl = saved.url;
          slipUploadId = saved.id;
        } catch (err) {
          return res.status(400).json({
            error: `อัปโหลดสลิปไม่สำเร็จ: ${err.message || 'unknown'}`,
            code: 'SLIP_UPLOAD_FAILED',
          });
        }
      }
      const client = await pool.connect();
      const cleanupUploadedSlip = () => {
        if (!slipUploadId) return;
        const orphanId = slipUploadId;
        slipUploadId = null;
        storage.remove(pool, orphanId)
          .catch((e) => console.warn('[bill.pay] orphan slip cleanup failed:', e.message));
      };
      const rollbackManualPay = async () => {
        await client.query('ROLLBACK').catch(() => {});
        cleanupUploadedSlip();
      };
      try {
        await client.query('BEGIN');
        const bill = await client.query(
          `SELECT id, bill_no, period, total, late_fee, subtotal, vat, status, tenant_id, room_id
             FROM bills
            WHERE id=$1 AND deleted_at IS NULL
            FOR UPDATE`,
          [id]
        );
        if (!bill.rows.length) {
          await rollbackManualPay();
          return res.status(404).json({ error: 'bill not found' });
        }
        const row = bill.rows[0];
        if (row.status !== 'pending' && row.status !== 'overdue') {
          await rollbackManualPay();
          return res.status(409).json({
            error: 'bill is not payable',
            code: 'BILL_NOT_PAYABLE',
            billStatus: row.status,
          });
        }
        // Round bill total to 2 decimals so legacy rows with sub-cent drift
        // (e.g. 5000.0000000001 from older code) don't propagate into the
        // payments ledger. Without this round2, payments.amount can have
        // float dust that breaks downstream reconciliation against
        // bills.total (and against tenant-displayed amounts).
        const billTotal = billing.round2(Number(row.total));
        const billLateFee = billing.round2(Number(row.late_fee || 0));
        if (!Number.isFinite(billTotal) || billTotal <= 0) {
          await rollbackManualPay();
          return res.status(409).json({ error: 'bill total is invalid', code: 'INVALID_BILL_TOTAL' });
        }
        // R2-followup — accept the offline payment in two tiers:
        // tier='exact' = matches current total; tier='principal' = matches
        // (subtotal+vat), i.e. the amount the tenant committed to BEFORE
        // scheduler.tickLateFee added the penalty. Manual /pay is used
        // when admin receives cash / bank transfer directly, often AFTER
        // the late_fee already accrued — accepting principal lets admin
        // record the actual collected amount + waive the late_fee in
        // good faith. Audit-logged either way.
        const amountCheck = billing.validatePaymentAmount({
          amount: requestedAmount,
          total: billTotal,
          lateFee: billLateFee,
        });
        if (!amountCheck.ok) {
          await rollbackManualPay();
          return res.status(409).json({
            error: 'payment amount does not match bill total',
            code: 'PAYMENT_AMOUNT_MISMATCH',
            billTotal,
            billPrincipal: amountCheck.principal,
            billLateFee,
            paymentAmount: requestedAmount,
          });
        }
        let waivedLateFee = 0;
        let carriedLateFee = 0;
        let effectiveTotal = billTotal;
        let carriedChargeId = null;
        // Late-fee policy (services/billing.js#resolvePrincipalLateFee). Recording
        // an offline/counter payment that only covers the principal requires an
        // explicit admin choice via lateFeeAction: 'waive' forgives; 'carry'
        // settles + bills the fee next month. Legacy waiveLateFee:true → 'waive'.
        // (To collect the late fee at the counter NOW, the admin simply records
        //  the FULL amount incl. late fee — that's tier='exact', no decision.)
        const lateFeeAction = (req.body && req.body.lateFeeAction)
          || (req.body && req.body.waiveLateFee === true ? 'waive' : undefined);
        const lateFeePolicy = billing.resolvePrincipalLateFee({
          tier: amountCheck.tier, lateFee: billLateFee, action: lateFeeAction,
        });
        if (lateFeePolicy.applies && !lateFeePolicy.settle) {
          await rollbackManualPay();
          return res.status(409).json({
            error: 'ยอดที่บันทึกเท่ากับยอดก่อนค่าปรับ — เลือกจัดการค่าปรับ: ยกค่าปรับ / เก็บรอบหน้า หรือบันทึกยอดเต็มรวมค่าปรับ',
            code: 'LATE_FEE_DECISION_REQUIRED',
            billTotal,
            billPrincipal: amountCheck.principal,
            billLateFee,
            paymentAmount: requestedAmount,
          });
        }
        if (lateFeePolicy.applies && lateFeePolicy.settle) {
          if (lateFeePolicy.action === 'carry') {
            const carryFlags = await features.load(pool).catch(() => ({}));
            if (!(carryFlags.recurringCharges && carryFlags.recurringCharges.enabled)) {
              await rollbackManualPay();
              return res.status(409).json({
                error: 'ต้องเปิดฟีเจอร์ "ค่าใช้จ่ายประจำ" ก่อนจึงจะเก็บค่าปรับรอบหน้าได้ — หรือเลือกยกค่าปรับแทน',
                code: 'RECURRING_CHARGES_REQUIRED_FOR_CARRY',
              });
            }
          }
          waivedLateFee = lateFeePolicy.action === 'waive' ? billLateFee : 0;
          carriedLateFee = lateFeePolicy.action === 'carry' ? billLateFee : 0;
          effectiveTotal = amountCheck.principal;
          await client.query(
            `UPDATE bills
                SET late_fee = 0,
                    total    = $2::numeric
              WHERE id = $1 AND deleted_at IS NULL`,
            [id, amountCheck.principal]
          );
          if (lateFeePolicy.action === 'carry') {
            carriedChargeId = await billPayments.carryLateFeeToNextBill(client, {
              tenantId: bill.rows[0].tenant_id,
              roomId: bill.rows[0].room_id,
              amount: billLateFee,
              fromPeriod: bill.rows[0].period,
              createdBy: verifier,
            });
            if (!carriedChargeId) {
              await rollbackManualPay();
              return res.status(409).json({
                error: 'ไม่สามารถสร้างรายการเก็บค่าปรับรอบหน้าได้ กรุณาตรวจข้อมูลผู้เช่า/ห้อง หรือเลือกยกค่าปรับแทน',
                code: 'LATE_FEE_CARRY_FAILED',
              });
            }
          }
          const auditAction = lateFeePolicy.action === 'carry'
            ? 'bill.late_fee_carried_forward_on_principal_payment'
            : 'bill.late_fee_waived_on_principal_payment';
          await client.query(
            `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [verifier, auditAction, 'bill', String(id),
             JSON.stringify({
               lateFee: billLateFee,
               action: lateFeePolicy.action,
               carriedChargeId,
               paymentAmount: requestedAmount,
               principalAtVerify: amountCheck.principal,
               billTotalBeforeSettle: billTotal,
               method,
             })]
          ).catch(() => { /* audit best-effort */ });
        }
        const paidLedgerCheck = billing.validatePaidLedger({
          paymentAmount: requestedAmount,
          billTotal: effectiveTotal,
        });
        if (!paidLedgerCheck.ok) {
          await rollbackManualPay();
          return res.status(409).json({
            error: 'payment ledger does not reconcile with bill total',
            code: 'PAID_LEDGER_INCONSISTENT',
            paymentAmount: paidLedgerCheck.paymentAmount,
            billTotal: paidLedgerCheck.billTotal,
            diff: paidLedgerCheck.diff,
            tolerance: paidLedgerCheck.tolerance,
          });
        }
        const existing = await client.query(
          `SELECT id FROM payments WHERE bill_id=$1 AND status='verified' LIMIT 1`,
          [id]
        );
        if (existing.rows.length) {
          await rollbackManualPay();
          return res.status(409).json({
            error: 'bill already has a verified payment',
            code: 'BILL_ALREADY_PAID',
            existingPaymentId: existing.rows[0].id,
          });
        }
        const payment = await client.query(
          `INSERT INTO payments
             (bill_id, tenant_id, amount, method, ref, slip_url, status,
              verified_by, verified_at, verify_provider, verify_payload)
           VALUES ($1,$2,$3,$4,$5,$6,'verified',$7,NOW(),'manual',$8::jsonb)
           RETURNING *`,
          [
            id,
            row.tenant_id || null,
            // Record the actual collected amount, not bill total — bank
            // reconciliation needs the cents tenant transferred. When
            // tier='principal' bills.total was already updated above.
            requestedAmount,
            method,
            ref,
            slipUrl,
            verifier,
            JSON.stringify({
              source: 'admin-billing',
              requestedAmount,
              amountTier: amountCheck.tier,
              billTotalAtVerify: billTotal,
              billLateFeeAtVerify: billLateFee,
              principalAtVerify: amountCheck.principal,
              waivedLateFee,
              carriedLateFee,
              lateFeeAction: lateFeePolicy.action,
              carriedChargeId,
            }),
          ]
        );
        // Reject sibling pending slips that the tenant uploaded before
        // admin recorded this offline payment. Without this, admin opens
        // the queued slip in /admin#payments later and gets a
        // 409 BILL_ALREADY_PAID with no way to clear the row — the
        // pending payment never gets resolved. Mark them rejected with
        // a structured reason so the queue empties and the slip preview
        // remains intact for forensic review.
        // verified_by/verified_at record the actor + decision time of
        // this rejection, matching the standard slip-reject pattern at
        // server.js per-payment verify.
        const supersededPending = await client.query(
          `UPDATE payments
              SET status='rejected',
                  verified_by=$3,
                  verified_at=NOW(),
                  rejected_reason=$2
            WHERE bill_id=$1 AND status='pending'
          RETURNING id`,
          [id, `superseded_by_manual_pay: ${method} ${ref}`, verifier]
        );
        const paid = await client.query(
          `UPDATE bills SET status='paid', paid_at=NOW()
             WHERE id=$1 AND status IN ('pending','overdue')
             RETURNING *`,
          [id]
        );
        if (paid.rowCount !== 1) {
          await rollbackManualPay();
          return res.status(409).json({
            error: 'bill was not marked paid',
            code: 'BILL_MARK_PAID_FAILED',
          });
        }
        await client.query('COMMIT');
        notifyManualPayment(
          payment.rows[0],
          paid.rows[0] || row,
          verifier,
          supersededPending.rows.length
        ).catch((err) => {
          // Payment is committed — only the tenant "ชำระแล้ว" confirmation
          // failed. Leave a loud log trail so a dead SMTP/LINE token doesn't
          // silently eat every receipt.
          console.warn(`[bill.pay] paid-confirmation notify failed for bill ${row.bill_no || id}:`, err.message);
        });
        audit(req, 'bill.manual_pay', 'bill', String(id), {
          paymentId: payment.rows[0].id,
          amount: Number(payment.rows[0].amount),
          requestedAmount,
          amountTier: amountCheck.tier,
          waivedLateFee,
          carriedLateFee,
          lateFeeAction: lateFeePolicy.action,
          carriedChargeId,
          method,
          supersededPaymentIds: supersededPending.rows.map((r) => r.id),
        });
        // Auto-recompute room status — if this was the last overdue bill,
        // the room flips overdue → occupied without admin clicking.
        // paid.rows[0].room_id comes from the RETURNING * above.
        const billRoomId = paid.rows[0]?.room_id;
        if (billRoomId) {
          require('../services/roomStatus').syncRoom(pool, billRoomId, { reason: 'manual-pay' })
            .catch((err) => console.warn(`[bills.pay] room sync failed:`, err.message));
        }
        restoreAccessCardsAfterPayment(pool, row.tenant_id, null, 'pay').catch(() => {});
        billPayments.notifyOwnerPaymentReceived(pool, {
          billId: id, amount: payment.rows[0].amount,
          method, source: 'manual-pay', actor: verifier,
        }).catch(() => {});
        res.json({ ok: true, bill: paid.rows[0], payment: payment.rows[0] });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('bill manual pay error:', err);
        // If we uploaded a slip before the transaction failed, scrub the
        // orphan file so R2 doesn't accumulate unattached evidence.
        cleanupUploadedSlip();
        res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
      } finally {
        client.release();
      }
    });

  // POST /api/bills/:id/verify-slip — admin marks the latest slip verified.
  // Equivalent to PUT /api/payments/:id/verify but takes a bill id instead.
  r.post('/:id/verify-slip', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
      const accept = req.body?.accept !== false;
      const reasonRaw = String(req.body?.reason || '').trim();
      // Reject explicit length errors instead of silently slicing to 500.
      // Silent truncation cut off the URL/instructions on long reasons,
      // leaving the tenant with an incomplete message. The admin UI gets
      // a clear REJECT_REASON_TOO_LONG so it can show a character counter.
      if (reasonRaw.length > 500) {
        return res.status(400).json({
          error: 'เหตุผลที่ปฏิเสธยาวเกินไป (สูงสุด 500 ตัวอักษร)',
          code: 'REJECT_REASON_TOO_LONG',
          maxLength: 500,
          actualLength: reasonRaw.length,
        });
      }
      const reason = reasonRaw;
      if (!accept && reason.length < 3) {
        return res.status(400).json({
          error: 'reject reason is required',
          code: 'REJECT_REASON_REQUIRED',
        });
      }
      // Same defensive guard as /:id/pay — session could be reaped between
      // requireAuth and here. Audit columns are NOT NULL so a null username
      // would crash the UPDATE with 500.
      const verifier = req.session?.user?.username || 'admin:unknown';
      const client = await pool.connect();
      let paidRoomId = null;
      let paidTenantId = null;
      try {
        await client.query('BEGIN');
        const bill = await client.query(
          `SELECT id, status, total, late_fee, subtotal, vat, deleted_at, room_id, period FROM bills WHERE id=$1 FOR UPDATE`,
          [id]
        );
        if (!bill.rows.length || bill.rows[0].deleted_at) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'bill not found' });
        }
        const pres = await client.query(
          `SELECT id, amount, tenant_id FROM payments
             WHERE bill_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1
             FOR UPDATE`,
          [id]
        );
        if (!pres.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'no pending slip for this bill' });
        }
        const pid = pres.rows[0].id;
        if (accept) {
          if (bill.rows[0].status !== 'pending' && bill.rows[0].status !== 'overdue') {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: 'bill is not payable',
              code: 'BILL_NOT_PAYABLE',
              billStatus: bill.rows[0].status,
            });
          }
          // R2-followup — two-tier acceptance (see services/billing.js#validatePaymentAmount).
          // tier='exact' matches bill.total at verify time; tier='principal'
          // matches (subtotal+vat), i.e. the amount the tenant committed to
          // BEFORE scheduler.tickLateFee added the penalty. Waive late_fee
          // on principal-tier matches so the tenant isn't punished for the
          // scheduler's timing.
          const billTotal = Number(bill.rows[0].total);
          const billLateFee = Number(bill.rows[0].late_fee || 0);
          const paymentAmount = Number(pres.rows[0].amount);
          const amountCheck = billing.validatePaymentAmount({
            amount: paymentAmount,
            total: billTotal,
            lateFee: billLateFee,
          });
          if (!Number.isFinite(billTotal) || !Number.isFinite(paymentAmount) || !amountCheck.ok) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: 'payment amount does not match bill total',
              code: 'PAYMENT_AMOUNT_MISMATCH',
              billTotal,
              billPrincipal: amountCheck.principal,
              billLateFee,
              paymentAmount,
            });
          }
          // Late-fee policy (services/billing.js#resolvePrincipalLateFee): admin
          // must explicitly choose on a principal-only payment. waiveLateFee:true
          // waives; otherwise return LATE_FEE_DECISION_REQUIRED for the UI prompt.
          // Admin decides via lateFeeAction: 'waive' forgives; 'carry' settles
          // at principal + bills the fee next month. Legacy waiveLateFee:true →
          // 'waive'. No decision → LATE_FEE_DECISION_REQUIRED.
          const lateFeeAction = (req.body && req.body.lateFeeAction)
            || (req.body && req.body.waiveLateFee === true ? 'waive' : undefined);
          const lateFeePolicy = billing.resolvePrincipalLateFee({
            tier: amountCheck.tier, lateFee: billLateFee, action: lateFeeAction,
          });
          if (lateFeePolicy.applies && !lateFeePolicy.settle) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: 'ผู้เช่าชำระเฉพาะยอดก่อนค่าปรับ — เลือกจัดการค่าปรับ: ยกค่าปรับ / เก็บรอบหน้า หรือปฏิเสธให้จ่ายเพิ่ม',
              code: 'LATE_FEE_DECISION_REQUIRED',
              billTotal,
              billPrincipal: amountCheck.principal,
              billLateFee,
              paymentAmount,
            });
          }
          if (lateFeePolicy.applies && lateFeePolicy.settle) {
            if (lateFeePolicy.action === 'carry') {
              const flags = await features.load(pool).catch(() => ({}));
              if (!(flags.recurringCharges && flags.recurringCharges.enabled)) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                  error: 'ต้องเปิดฟีเจอร์ "ค่าใช้จ่ายประจำ" ก่อนจึงจะเก็บค่าปรับรอบหน้าได้ — หรือเลือกยกค่าปรับแทน',
                  code: 'RECURRING_CHARGES_REQUIRED_FOR_CARRY',
                });
              }
            }
            await client.query(
              `UPDATE bills
                  SET late_fee = 0,
                      total    = $2::numeric
                WHERE id = $1 AND deleted_at IS NULL`,
              [id, amountCheck.principal]
            );
            let carriedChargeId = null;
            if (lateFeePolicy.action === 'carry') {
              carriedChargeId = await billPayments.carryLateFeeToNextBill(client, {
                tenantId: pres.rows[0].tenant_id,
                roomId: bill.rows[0].room_id,
                amount: billLateFee,
                fromPeriod: bill.rows[0].period,
                createdBy: verifier,
              });
              if (!carriedChargeId) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                  error: 'ไม่สามารถสร้างรายการเก็บค่าปรับรอบหน้าได้ กรุณาตรวจข้อมูลผู้เช่า/ห้อง หรือเลือกยกค่าปรับแทน',
                  code: 'LATE_FEE_CARRY_FAILED',
                });
              }
            }
            const auditAction = lateFeePolicy.action === 'carry'
              ? 'bill.late_fee_carried_forward_on_principal_payment'
              : 'bill.late_fee_waived_on_principal_payment';
            await client.query(
              `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail)
               VALUES ($1, $2, $3, $4, $5::jsonb)`,
              [verifier, auditAction, 'bill', String(id),
               JSON.stringify({
                 lateFee: billLateFee,
                 action: lateFeePolicy.action,
                 carriedChargeId,
                 paymentId: pid,
                 paymentAmount,
                 principalAtVerify: amountCheck.principal,
                 billTotalBeforeSettle: billTotal,
              })]
            ).catch(() => { /* audit best-effort */ });
          }
          const settledBillTotal = amountCheck.tier === 'principal' && billLateFee > 0
            ? amountCheck.principal
            : billTotal;
          const paidLedgerCheck = billing.validatePaidLedger({
            paymentAmount,
            billTotal: settledBillTotal,
          });
          if (!paidLedgerCheck.ok) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: 'payment ledger does not reconcile with bill total',
              code: 'PAID_LEDGER_INCONSISTENT',
              paymentAmount: paidLedgerCheck.paymentAmount,
              billTotal: paidLedgerCheck.billTotal,
              diff: paidLedgerCheck.diff,
              tolerance: paidLedgerCheck.tolerance,
            });
          }
          const upd = await client.query(
            `UPDATE payments SET status='verified', verified_by=$1, verified_at=NOW()
               WHERE id=$2 AND status='pending' RETURNING *`,
            [verifier, pid]
          );
          if (!upd.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'no pending slip for this bill' });
          }
          paidTenantId = upd.rows[0].tenant_id || pres.rows[0].tenant_id || null;
          // Reject any OTHER pending payments on this bill in the same
          // transaction. The handler previously selected only the most
          // recent pending row and verified it — if the tenant uploaded
          // two slips before admin reviewed (e.g. retry after suspected
          // submit failure), the older one stayed `pending` forever and
          // showed up in the slip queue as an unresolvable orphan.
          await client.query(
            `UPDATE payments
                SET status='rejected',
                    verified_by=$1,
                    verified_at=NOW(),
                    rejected_reason='superseded_by_verified_sibling'
              WHERE bill_id=$2 AND status='pending' AND id<>$3`,
            [verifier, id, pid]
          );
          const paid = await client.query(
            // Only flip pending/overdue → paid. status<>'paid' would also
            // match 'void', re-animating a bill the admin already cancelled.
            `UPDATE bills SET status='paid', paid_at=NOW()
               WHERE id=$1 AND status IN ('pending','overdue')
               RETURNING id, room_id`,
            [id]
          );
          if (paid.rowCount !== 1) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: 'bill was not marked paid',
              code: 'BILL_MARK_PAID_FAILED',
            });
          }
          paidRoomId = paid.rows[0]?.room_id || null;
        } else {
          const rejected = await client.query(
            `UPDATE payments SET status='rejected', verified_by=$1, verified_at=NOW(), rejected_reason=$2
               WHERE id=$3 AND status='pending' RETURNING id`,
            [verifier, reason, pid]
          );
          if (!rejected.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'no pending slip for this bill' });
          }
        }
        await client.query('COMMIT');
        audit(req, accept ? 'slip.verify' : 'slip.reject', 'bill', String(id), { paymentId: pid, reason });
        // Auto-cascade room status when a bill was accepted/paid. The
        // verify-slip endpoint's bill id maps to the room via bills.room_id;
        // capture it from UPDATE ... RETURNING so the post-commit sync uses
        // the same paid row and doesn't need a second lookup. Reject path
        // doesn't change the bill state so room/access status doesn't move.
        if (accept) {
          if (paidRoomId) {
            require('../services/roomStatus').syncRoom(pool, paidRoomId, { reason: 'slip-verify' })
              .catch((err) => console.warn(`[bills.verify-slip] room sync failed:`, err.message));
          }
          restoreAccessCardsAfterPayment(pool, paidTenantId, null, 'verify-slip').catch(() => {});
          billPayments.notifyOwnerPaymentReceived(pool, {
            billId: id, amount: pres.rows[0].amount,
            method: 'slip', source: 'verify-slip', actor: verifier,
          }).catch(() => {});
        }
        // Fire-and-forget tenant notification with the verdict
        try {
          // Filter t.deleted_at IS NULL so we don't push "slip verified"
          // notifications to ex-tenants who've been soft-deleted between
          // upload and verify. Pull line_oa_id so the notifier routes the
          // push through the OA the tenant actually bound to (multi-OA
          // tenants see different userIds per OA — wrong OA = silent drop).
          const pq = await pool.query(
            `SELECT p.*, t.id AS t_id, t.full_name, t.phone, t.email,
                    t.line_user_id, t.line_oa_id
               FROM payments p
               LEFT JOIN tenants t ON t.id = p.tenant_id AND t.deleted_at IS NULL
               WHERE p.id=$1`, [pid]
          );
          if (pq.rows.length && pq.rows[0].t_id) {
            // Build the same friendly receipt that server.js'
            // notifyTenantOnPayment uses for the /api/payments/:id/verify
            // path — keeps the two verify entry points consistent so a
            // tenant gets the same wording regardless of which admin
            // button was pressed.
            const flags = await features.load(pool);
            const billQ = await pool.query(
              `SELECT bill_no, period FROM bills WHERE id=$1 LIMIT 1`,
              [id]
            );
            const billLabel = billQ.rows[0]?.bill_no || `#${id}`;
            const period = billQ.rows[0]?.period || '';
            const amt = Number(pq.rows[0].amount);
            const amtStr = Number.isFinite(amt)
              ? amt.toLocaleString('th-TH', { minimumFractionDigits: 2 }) : '-';
            // Cheap building-name lookup — config blob is one row, hot in
            // pg cache. Fallback to default if the blob isn't initialised.
            let buildingName = 'ที่พักของคุณ';
            try {
              const cfgQ = await pool.query(
                `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
              );
              const cfg = cfgQ.rows[0]?.value;
              if (cfg && cfg.building && cfg.building.name) buildingName = cfg.building.name;
            } catch { /* keep default */ }

            let subject, text;
            if (accept) {
              subject = '✅ ชำระเงินเรียบร้อยแล้ว — ขอบคุณ';
              text = [
                `เรียน คุณ${pq.rows[0].full_name || ''}`,
                ``,
                `🎉 ขอบคุณที่ชำระเงินตรงเวลา`,
                ``,
                `บิล: ${billLabel}${period ? ` (รอบ ${period})` : ''}`,
                `จำนวน: ฿${amtStr}`,
                `สถานะ: ชำระแล้ว ✓`,
                ``,
                `ใบเสร็จ: ดูได้ที่พอร์ทัลผู้เช่า /tenant`,
                ``,
                `${buildingName}`,
              ].join('\n');
            } else {
              subject = '❌ สลิปไม่ผ่านการตรวจสอบ — กรุณาส่งใหม่';
              text = [
                `เรียน คุณ${pq.rows[0].full_name || ''}`,
                ``,
                `เสียใจที่ต้องแจ้งให้ทราบ — สลิปที่ส่งสำหรับบิลด้านล่างไม่ผ่านการตรวจสอบ`,
                ``,
                `บิล: ${billLabel}${period ? ` (รอบ ${period})` : ''}`,
                `จำนวน: ฿${amtStr}`,
                `สถานะ: ยังไม่ชำระ`,
                reason ? `\nเหตุผลที่ปฏิเสธ:\n${reason}` : null,
                ``,
                `📋 ขั้นตอนถัดไป:`,
                `   1) ตรวจสอบสลิปและจำนวนเงินอีกครั้ง`,
                `   2) อัปโหลดสลิปใหม่ที่พอร์ทัลผู้เช่า /tenant`,
                `   3) หากไม่แน่ใจ ติดต่อ ${buildingName}`,
              ].filter(Boolean).join('\n');
            }
            notifier.notifyTenant({ pool, features: flags },
              { id: pq.rows[0].t_id,
                line_user_id: pq.rows[0].line_user_id,
                line_oa_id: pq.rows[0].line_oa_id,
                phone: pq.rows[0].phone,
                email: pq.rows[0].email,
                full_name: pq.rows[0].full_name },
              { subject, text }
            ).catch(() => {});
          }
        } catch { /* notifier failures don't fail request */ }
        res.json({ ok: true });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('verify-slip error:', err);
        res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
      } finally {
        client.release();
      }
    });

  return r;
};

// Pure helpers exposed for unit tests only (module.exports stays the router
// factory above; routes/index.js is unaffected by these properties).
module.exports._matchConsumedOneOffLines = matchConsumedOneOffLines;
module.exports._consumedOneOffLinesForBill = consumedOneOffLinesForBill;
module.exports._regenPreservedLateFeeAndStatus = regenPreservedLateFeeAndStatus;
