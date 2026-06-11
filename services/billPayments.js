// services/billPayments.js
// Shared notification helpers for the payment-verify flows.
//
// Extracted from server.js so the same logic can be reached from both the
// /api/payments/:id/verify path (still in server.js) and the bill-side
// /api/bills/:id/void + /:id/unmark-paid handlers (moved to
// routes/bills-extras.js). Without this extraction the two places either
// duplicated the lookup or one of them silently skipped the tenant push.

const features = require('./features');
const notifier = require('./notifier');

const CARRIED_LATE_FEE_LABEL_PREFIX = 'ค่าปรับล่าช้าค้างจากรอบ ';
const CARRIED_LATE_FEE_NOTE_MARKER = '[system:late_fee_carry]';
// Stamped onto a carry's notes when WE deactivate it during a void/unmark
// reversal — distinguishes "reversed before billing" from "consumed by
// bill-gen" (both end up active=FALSE, but only consumed ones live inside
// an issued bill). findConsumedCarriedLateFees filters on this.
const CARRIED_LATE_FEE_REVERSED_MARKER = '[system:late_fee_carry_reversed]';

// Small cached helper — building name shows up in every tenant-facing
// notification so they know who's writing. Lookup the building config
// once per call (rooms + config blob); for high-volume notification
// flows this could be cached but the in-process notifier queue is
// already deduplicating retries.
async function loadBuildingName(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
    );
    const cfg = rows.length ? rows[0].value : {};
    return (cfg && cfg.building && cfg.building.name)
      || 'ที่พักของคุณ';
  } catch { return 'ที่พักของคุณ'; }
}

// Helper for both verify endpoints — pushes a notification to the tenant
// when their slip is verified, rejected, or reversed. Fire-and-forget;
// logs to notifications_log via notifier.
//
// Message is intentionally formal + actionable. For verify=accept the
// tenant gets a friendly receipt with bill no, period, and amount; for
// reject they get the rejection reason + clear next-step instructions
// (re-upload slip / contact admin) so the failure isn't a dead end.
//
// `ctx` carries the shared pool reference so callers don't need to thread
// it through every queryWithRetry / features.load — passing it once as
// part of the routes/ ctx object keeps server.js + bills-extras.js DRY.
async function notifyTenantOnPayment(ctx, payment, outcome, reason) {
  const pool = ctx && ctx.pool;
  if (!pool || !payment || !payment.tenant_id) return;
  try {
    const flags = await features.load(pool);
    const [{ rows: tRows }, { rows: bRows }] = await Promise.all([
      pool.query(
        `SELECT id, full_name, phone, email, line_user_id, line_oa_id
           FROM tenants
           WHERE id=$1 AND deleted_at IS NULL`,
        [payment.tenant_id]
      ),
      payment.bill_id ? pool.query(
        `SELECT bill_no, period, total, due_date FROM bills WHERE id=$1 LIMIT 1`,
        [payment.bill_id]
      ) : Promise.resolve({ rows: [] }),
    ]);
    if (!tRows.length) return;
    const t = tRows[0];
    const b = bRows[0] || {};
    const billLabel = b.bill_no || (payment.bill_id ? `#${payment.bill_id}` : '-');
    const period = b.period || '';
    const amt = Number(payment.amount);
    const amtStr = Number.isFinite(amt) ? amt.toLocaleString('th-TH', { minimumFractionDigits: 2 }) : '-';
    const buildingName = await loadBuildingName(pool);

    let subject, lines;
    if (outcome === 'verified') {
      subject = '✅ ชำระเงินเรียบร้อยแล้ว — ขอบคุณ';
      lines = [
        `เรียน คุณ${t.full_name}`,
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
      ];
    } else if (outcome === 'reversed') {
      // Admin reversed a previously-verified payment (unmark-paid or
      // bill void with force). Tenant must know — without this push
      // they would only find out when the next overdue reminder
      // arrives, which is confusing ("but I already paid?!"). Reason
      // text comes from the admin's input.
      subject = '⚠️ การชำระถูกยกเลิก — โปรดติดต่อแอดมิน';
      lines = [
        `เรียน คุณ${t.full_name}`,
        ``,
        `แอดมินได้ยกเลิกการบันทึกชำระสำหรับบิลด้านล่าง`,
        ``,
        `บิล: ${billLabel}${period ? ` (รอบ ${period})` : ''}`,
        `จำนวน: ฿${amtStr}`,
        `สถานะ: ยังไม่ชำระ`,
        reason ? `\nเหตุผล: ${reason}` : null,
        ``,
        `📋 ขั้นตอนถัดไป:`,
        `   1) ตรวจสอบกับแอดมินว่าการชำระไปอยู่บิลใด`,
        `   2) ถ้าเป็นความเข้าใจผิด ติดต่อ ${buildingName}`,
      ].filter(Boolean);
    } else {
      // Rejected — surface the reason + concrete next steps so the tenant
      // knows what to do. "ติดต่อเจ้าหน้าที่" alone leaves them stuck.
      subject = '❌ สลิปไม่ผ่านการตรวจสอบ — กรุณาส่งใหม่';
      lines = [
        `เรียน คุณ${t.full_name}`,
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
      ].filter(Boolean);
    }
    await notifier.notifyTenant({ pool, features: flags }, t, {
      subject, text: lines.join('\n'),
    });
  } catch (err) {
    console.error('[notifyTenantOnPayment]', err.message);
  }
}

function nextPeriodStartDate(period) {
  const m = String(period || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  const next = new Date(Date.UTC(year, month, 1));
  return next.toISOString().slice(0, 10);
}

function carriedLateFeeLabel(period) {
  return `${CARRIED_LATE_FEE_LABEL_PREFIX}${period || '-'}`;
}

/**
 * Carry an outstanding late fee onto next month's bill instead of forgiving it.
 *
 * Used when an admin settles a principal-only payment with action:'carry'. We
 * mark the current bill paid at principal (the caller does that) and record the
 * unpaid late fee as a one-off recurring charge scoped to the tenant. The next
 * bill-gen (scheduler or manual) auto-includes one-off charges then deactivates
 * them, so the fee is collected exactly once next cycle — no partial/top-up
 * payment needed. Tenant-scoped so it follows the tenant and deactivates on
 * checkout (it won't leak onto the next occupant of the room).
 *
 * MUST run inside the same transaction (pass the tx client) that settles the
 * bill, so the carry-charge and the settle commit atomically.
 *
 * @param {import('pg').PoolClient} client - active transaction client
 * @param {object} opts
 * @param {number|string} opts.tenantId   - tenant the fee belongs to (required
 *   unless roomId is given; the table CHECK needs at least one target)
 * @param {string} [opts.roomId]          - room fallback target
 * @param {number} opts.amount            - the late fee to carry (THB)
 * @param {string} [opts.fromPeriod]      - the period it originated from (label)
 * @param {string} [opts.createdBy]       - audit actor
 * @returns {Promise<number|null>} the new recurring_charges id, or null if no-op
 */
async function carryLateFeeToNextBill(client, { tenantId, roomId, amount, fromPeriod, createdBy } = {}) {
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(amt) || amt <= 0) return null;
  // The table CHECK requires room_id OR tenant_id. Prefer tenant scoping.
  if (tenantId == null && !roomId) return null;
  const periodLabel = fromPeriod || '-';
  const startAt = nextPeriodStartDate(fromPeriod);
  if (!startAt) return null;
  const ins = await client.query(
    `INSERT INTO recurring_charges
       (room_id, tenant_id, label, amount, frequency, active, start_at, notes, created_by)
     VALUES ($1, $2, $3, $4, 'one_off', TRUE, $5::date, $6, $7)
     RETURNING id`,
    [
      tenantId != null ? null : (roomId || null),  // tenant-scope when we can
      tenantId != null ? tenantId : null,
      carriedLateFeeLabel(periodLabel),
      amt,
      startAt,
      `${CARRIED_LATE_FEE_NOTE_MARKER} ยกค่าปรับล่าช้า ฿${amt.toLocaleString('th-TH')} จากบิลรอบ ${periodLabel} มาเก็บในบิลรอบถัดไป`,
      createdBy || 'system',
    ]
  );
  return ins.rows[0]?.id || null;
}

// Every carry path audit-logs action=bill.late_fee_carried_forward_on_
// principal_payment with carriedChargeId in detail — this resolves the set
// of carry charge ids ever created for a bill. Shared by the reversal
// (deactivate) and the consumed-carry report below.
async function carriedChargeIdsForBill(client, billId) {
  const audit = await client.query(
    `SELECT DISTINCT (detail->>'carriedChargeId') AS cid
       FROM audit_logs
      WHERE entity_type='bill'
        AND entity_id=$1
        AND action='bill.late_fee_carried_forward_on_principal_payment'
        AND detail ? 'carriedChargeId'
        AND detail->>'carriedChargeId' IS NOT NULL`,
    [String(billId)]
  );
  return audit.rows.map((r) => Number(r.cid)).filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Reverse a carried-forward late fee when its source bill is voided or
 * unmark-paid before next month bill-gen consumes it. We look up the bill's
 * carry charge ids and deactivate any STILL-ACTIVE one_off (already-consumed
 * carries are active=false, left untouched — see findConsumedCarriedLateFees
 * for surfacing those). Reversed rows get CARRIED_LATE_FEE_REVERSED_MARKER
 * stamped into notes so a later reversal can't mistake them for consumed.
 * MUST run inside the reversal transaction (pass the tx client).
 */
async function deactivateCarriedLateFees(client, billId) {
  const ids = await carriedChargeIdsForBill(client, billId);
  if (!ids.length) return [];
  const upd = await client.query(
    `UPDATE recurring_charges
        SET active=FALSE,
            notes=TRIM(COALESCE(notes,'') || ' ' || $2),
            updated_at=NOW()
      WHERE id = ANY($1::bigint[])
        AND frequency='one_off'
        AND active=TRUE
    RETURNING id`,
    [ids, CARRIED_LATE_FEE_REVERSED_MARKER]
  );
  return upd.rows.map((r) => Number(r.id));
}

/**
 * Report a bill's carried late fees that were ALREADY consumed by next-period
 * bill-gen (active=FALSE after being snapshotted into the new bill's items —
 * the amount is frozen inside an ISSUED bill and can't be silently reversed).
 * Reversal callers (void / unmark-paid) need this to
 *   a) avoid re-accruing the same fee on the restored bill (pass the summed
 *      amount as consumedCarriedLateFee to billing.computeRestoredBillAmounts)
 *   b) warn the admin that the next period's bill still carries the line so
 *      they can adjust it — failing toward review, never a silent double-charge.
 * Carries we reversed ourselves (marker in notes) are excluded — they were
 * never billed. Call BEFORE deactivateCarriedLateFees in the same transaction.
 *
 * @returns {Promise<Array<{id:number, amount:number, label:string, startAt:string|null}>>}
 */
async function findConsumedCarriedLateFees(client, billId) {
  const ids = await carriedChargeIdsForBill(client, billId);
  if (!ids.length) return [];
  const { rows } = await client.query(
    `SELECT id, amount, label, start_at
       FROM recurring_charges
      WHERE id = ANY($1::bigint[])
        AND frequency='one_off'
        AND active=FALSE
        AND POSITION($2 IN COALESCE(notes,'')) = 0`,
    [ids, CARRIED_LATE_FEE_REVERSED_MARKER]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    amount: Math.round(Number(r.amount) * 100) / 100,
    label: r.label || '',
    startAt: r.start_at || null,
  }));
}

// Owner/admin-side "เงินเข้า" alert — fired post-commit from EVERY path that
// lands a verified payment (tenant slip auto-verify, admin verify-slip,
// admin payment-queue verify, counter /pay). With multi-admin recipients
// wired into notifier.notifyOwner, this is what keeps the whole team aware
// of money coming in without opening /admin#payments. Fire-and-forget.
async function notifyOwnerPaymentReceived(pool, { billId, amount, method, source, actor } = {}) {
  try {
    const flags = await features.load(pool).catch(() => ({}));
    let bill = null;
    if (billId) {
      const { rows } = await pool.query(
        `SELECT b.bill_no, b.room_id, b.period, b.total, b.status,
                t.full_name AS tenant_name
           FROM bills b
           LEFT JOIN tenants t ON t.id = b.tenant_id
          WHERE b.id=$1 LIMIT 1`,
        [billId]
      );
      bill = rows[0] || null;
    }
    const amt = Number(amount);
    const amtText = Number.isFinite(amt)
      ? amt.toLocaleString('th-TH', { minimumFractionDigits: 2 }) : '-';
    const methodTh = ({
      cash: 'เงินสด',
      transfer: 'โอนธนาคาร',
      promptpay: 'PromptPay',
      slip: 'สลิปโอน',
      manual: 'บันทึกโดยเจ้าหน้าที่',
    })[String(method || '').toLowerCase()] || (method || '-');
    const sourceTh = ({
      'auto-verify': 'ตรวจสลิปอัตโนมัติ',
      'verify-slip': 'แอดมินยืนยันสลิป',
      'payment-verify': 'แอดมินยืนยันสลิป (คิวชำระเงิน)',
      'manual-pay': 'บันทึกรับเงินที่เคาน์เตอร์',
    })[source] || source || '-';
    await notifier.notifyOwner({ pool, features: flags }, {
      category: 'payment',
      subject: `💰 รับเงินแล้ว — ห้อง ${bill?.room_id || '-'} ฿${amtText}`,
      text: [
        `ห้อง: ${bill?.room_id || '-'}${bill?.tenant_name ? ` · ${bill.tenant_name}` : ''}`,
        `บิล: ${bill?.bill_no || (billId ? `#${billId}` : '-')}${bill?.period ? ` (รอบ ${bill.period})` : ''}`,
        `จำนวน: ฿${amtText} · ช่องทาง: ${methodTh}`,
        `ยืนยันโดย: ${sourceTh}${actor ? ` (${actor})` : ''}`,
        bill?.status === 'paid' ? 'สถานะบิล: ชำระแล้ว ✓' : null,
      ].filter(Boolean).join('\n'),
    });
  } catch (err) {
    console.warn('[notifyOwnerPaymentReceived]', err.message);
  }
}

module.exports = {
  loadBuildingName,
  notifyTenantOnPayment,
  notifyOwnerPaymentReceived,
  carryLateFeeToNextBill,
  deactivateCarriedLateFees,
  findConsumedCarriedLateFees,
  _carriedLateFeeLabelPrefix: CARRIED_LATE_FEE_LABEL_PREFIX,
  _carriedLateFeeNoteMarker: CARRIED_LATE_FEE_NOTE_MARKER,
  _carriedLateFeeReversedMarker: CARRIED_LATE_FEE_REVERSED_MARKER,
  _carriedLateFeeLabel: carriedLateFeeLabel,
  _nextPeriodStartDate: nextPeriodStartDate,
};
