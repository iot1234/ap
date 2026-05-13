// routes/bills-extras.js
// Bulk bill operations + send-via-LINE + slip verification helpers that
// extend the existing /api/bills routes in server.js.
//
//   POST /api/bills/bulk-generate   — generate bills for every occupied room
//   POST /api/bills/bulk-send       — enqueue notifications for every pending/overdue bill
//   POST /api/bills/:id/send        — enqueue notification for one bill
//   POST /api/bills/:id/verify-slip — admin marks slip as verified

const express = require('express');
const billing = require('../services/billing');
const features = require('../services/features');
const notifier = require('../services/notifier');
const notifQueue = require('../services/notificationQueue');
const promptpay = require('../services/promptpay');
const lineNotify = require('../services/line');
// Manual mark-paid (POST /api/bills/:id/pay) now accepts an optional slip
// dataUrl so admin can attach a receipt photo even for cash / external
// transfers. Same storage path the tenant slip upload uses.
const storage = require('../services/storage');
// queryWithRetry retries serialization/deadlock errors (40001, 40P01, 57P03,
// 53300). bulk-generate inserts ~30+ bills in a tight loop — most likely
// path to hit a deadlock against the scheduler's auto-gen running parallel.
const { queryWithRetry } = require('../db/pool');

module.exports = function buildBillsExtrasRouter(ctx) {
  const { pool, requireAuth, requireRole, sameOrigin, csrfGuard, audit, signBillQrToken, signBillPayToken } = ctx;
  const r = express.Router();

  // Compose the LINE Messages array for a bill notification. Two messages:
  //   1. Flex bubble: bill summary header + QR image + bank info card + button
  //   2. Text fallback: same info as plaintext so LINE clients that can't
  //      render Flex (old versions, web preview) still get the gist.
  // Counts as ONE push toward LINE's rate limit (Messaging API bundles
  // up to 5 messages per push).
  function buildBillLineMessages(b, opts = {}) {
    const { publicUrl, billLink, dueDateStr, billNo, qrToken, bankInfo } = opts;
    const total = Number(b.total) || 0;
    const totalStr = total.toLocaleString('th-TH', { minimumFractionDigits: 2 });
    const hasBankInfo = !!(bankInfo && bankInfo.account);
    // QR image URL — public endpoint with HMAC token so LINE Platform can
    // fetch it without auth. signBillQrToken is injected via ctx so this
    // module doesn't need to know about session secrets.
    const qrUrl = publicUrl && qrToken
      ? `${publicUrl}/p/bill-qr/${encodeURIComponent(b.id)}?t=${encodeURIComponent(qrToken)}`
      : null;
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
      ]},
    ];
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
    const flexMsg = {
      type: 'flex',
      altText: `บิลใหม่ห้อง ${b.room_id} ยอด ฿${totalStr}`,
      contents: bubble,
    };
    // Plain-text fallback message for clients that won't render Flex. Sent
    // alongside the Flex so the user always gets the text version too —
    // tracks better in LINE search and is copyable.
    const textMsg = {
      type: 'text',
      text: [
        `📋 บิลใหม่ — ${b.period || '-'}`,
        ``,
        `ห้อง: ${b.room_id || '-'}`,
        `ยอดชำระ: ฿${totalStr}`,
        `กำหนดชำระ: ${dueDateStr || '-'}`,
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
    };
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
      const dueDay = Number(req.body?.dueDay || 15);
      const force = req.body?.force === true;
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
        const ppTarget = config?.payment?.promptpay
          || config?.payment?.promptpayTarget
          || require('../services/secrets').get('PROMPTPAY_TARGET');
        if (!ppTarget) {
          issues.push({ sev: 'high', code: 'NO_PROMPTPAY',
            msg: 'PROMPTPAY_TARGET ไม่ตั้ง — บิล PDF จะไม่มี QR' });
        } else if (promptpay.isDemoTarget(ppTarget)) {
          issues.push({ sev: 'high', code: 'DEMO_PROMPTPAY',
            msg: 'PromptPay ยังเป็นค่า demo — เปลี่ยนเป็นบัญชีรับเงินจริงก่อนออกบิล' });
        }
        const wRate = Number(config?.utilities?.waterRate);
        const eRate = Number(config?.utilities?.elecRate);
        if (!Number.isFinite(wRate) || wRate <= 0) {
          issues.push({ sev: 'high', code: 'NO_WATER_RATE',
            msg: 'อัตราค่าน้ำต่อหน่วยไม่ตั้ง — ยอดค่าน้ำในบิลจะ ฿0' });
        }
        if (!Number.isFinite(eRate) || eRate <= 0) {
          issues.push({ sev: 'high', code: 'NO_ELEC_RATE',
            msg: 'อัตราค่าไฟต่อหน่วยไม่ตั้ง — ยอดค่าไฟในบิลจะ ฿0' });
        }
        const eligibleRooms = rooms.filter((r) => r && r.tenant
          && (r.status === 'occupied' || r.status === 'overdue'));
        if (eligibleRooms.length === 0) {
          issues.push({ sev: 'high', code: 'NO_ELIGIBLE_ROOMS',
            msg: 'ไม่มีห้องที่มีผู้เช่าแสดงสถานะ occupied/overdue — จะออกบิล 0 ใบ' });
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
        if (force && hardIssues.length > 0) {
          // Audit the override so we can track operators who routinely
          // bypass — useful when a tenant disputes a malformed bill later.
          audit(req, 'bill.bulk_generate.forced', 'period', period, {
            issues: hardIssues.map((i) => i.code),
            forcedBy: req.session.user.username,
          });
        }

        // Build YYYY-MM-DD from the operator-supplied PERIOD (not "now") so
        // back-filled bills (admin generates April from May 5th) carry the
        // intended month, not the wallclock month. Match scheduler.tickBillGen
        // by using formatYMD directly so Asia/Bangkok timezone offset can't
        // shift the day back via toISOString().
        const periodMatch = /^(\d{4})-(\d{2})$/.exec(period);
        const periodYear = periodMatch ? Number(periodMatch[1]) : now.getFullYear();
        const periodMonth = periodMatch ? Number(periodMatch[2]) : (now.getMonth() + 1);
        const dueDate = billing.formatYMD(periodYear, periodMonth, dueDay);
        let made = 0, skipped = 0;
        for (const room of rooms) {
          if (!room || !room.tenant) { skipped++; continue; }
          if (room.status !== 'occupied' && room.status !== 'overdue') { skipped++; continue; }
          // pull previous overdue bill for late-fee. Filter soft-deleted
          // so a void+restored bill can't pile up phantom late fees.
          const prevQ = await pool.query(
            `SELECT total, due_date, paid_at, status FROM bills
              WHERE room_id=$1 AND status IN ('pending','overdue') AND deleted_at IS NULL
              ORDER BY created_at DESC LIMIT 1`,
            [room.id]
          );
          const previous = prevQ.rows[0] ? {
            total: Number(prevQ.rows[0].total),
            dueDate: prevQ.rows[0].due_date,
            status: prevQ.rows[0].status,
          } : null;
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
          // Match the manual + scheduler paths: pull discount_pct from the
          // active contract so bulk-generate honors the contract-length
          // discount the admin recorded at check-in.
          let discountPct = 0;
          try {
            const cq = await pool.query(
              `SELECT discount_pct FROM contracts
                 WHERE room_id=$1 AND status='active' AND deleted_at IS NULL
                 ORDER BY start_date DESC LIMIT 1`,
              [room.id]
            );
            if (cq.rows[0]) discountPct = Number(cq.rows[0].discount_pct) || 0;
          } catch { /* legacy deploys */ }
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
            try {
              const params = [];
              const ors = [];
              if (tenantIdForRoom) { params.push(tenantIdForRoom); ors.push(`tenant_id = $${params.length}`); }
              params.push(room.id); ors.push(`room_id = $${params.length}`);
              const rc = await billClient.query(
                `SELECT id, label, amount, frequency, start_at, end_at FROM recurring_charges
                   WHERE active = TRUE AND (${ors.join(' OR ')})
                     AND (start_at IS NULL OR start_at <= CURRENT_DATE)
                     AND (end_at IS NULL OR end_at >= CURRENT_DATE)
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
            const bill = billing.buildBill({ room, config, features: flags, previous, recurring, period, dueDate, discountPct });
            const otherJson = JSON.stringify(recurring || []);
            const ins = await billClient.query(
              `INSERT INTO bills
                 (bill_no, tenant_id, room_id, period, rent,
                  water_units, water_rate, water_amount,
                  elec_units, elec_rate, elec_amount, wifi, other,
                  subtotal, vat, late_fee, total, due_date, status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,
                       $14,$15,$16,$17,$18,'pending')
               ON CONFLICT (bill_no) DO NOTHING`,
              [
                bill.billNo, tenantIdForRoom, bill.roomId, bill.period,
                bill.rent, bill.waterUnits, bill.waterRate, bill.waterAmount,
                bill.elecUnits, bill.elecRate, bill.elecAmount,
                bill.wifi, otherJson,
                bill.subtotal, bill.vat, bill.lateFee, bill.total,
                bill.dueDate,
              ]
            );
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
              skipped++;
            }
          } catch (e) {
            await billClient.query('ROLLBACK').catch(() => {});
            // A7 — partial unique on (room_id, period) also blocks duplicates
            // when the two paths produce different bill_nos for same period.
            if (e.code !== '23505') console.error('[bulk-generate] insert failed:', e.message);
            skipped++;
          } finally {
            billClient.release();
          }
        }
        audit(req, 'bill.bulk_generate', 'period', period, { made, skipped });
        res.json({ ok: true, period, made, skipped });
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
    // No hard debounce — admin can resend immediately. The send-readiness
    // endpoint surfaces last_reminded_at + reminder_count so the confirm
    // modal can show "ส่งไปแล้ว N ครั้ง · ล่าสุด X นาทีก่อน" BEFORE the
    // admin clicks. Removing the block here means an intentional resend
    // (tenant called saying they didn't see the first message) works
    // without forcing admin to wait 60 min.
    const b = billQ.rows[0];
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
    if (b.tenant_status && b.tenant_status !== 'active') {
      return {
        ok: false,
        error: `ผู้เช่าสถานะ "${b.tenant_status}" — ไม่ใช่ผู้เช่าปัจจุบันของห้อง`,
        code: 'TENANT_NOT_ACTIVE',
        tenantStatus: b.tenant_status,
        hint: 'ส่งบิลให้ผู้เช่าปัจจุบันแทน หรือติดต่อผู้เช่าเก่าโดยตรง',
      };
    }
    if (b.tenant_current_room && String(b.tenant_current_room) !== String(b.room_id)) {
      // The tenant the bill points at has since moved to a different room
      // (admin re-assigned them mid-period). Sending the bill notification
      // would reach the right person but reference the wrong room, which
      // confuses tenants and triggers "นี่ไม่ใช่ห้องของผม" complaints.
      return {
        ok: false,
        error: `ผู้เช่าย้ายห้องไปแล้ว (ปัจจุบันอยู่ห้อง ${b.tenant_current_room}, บิลเป็นของห้อง ${b.room_id})`,
        code: 'TENANT_MOVED_ROOM',
        currentRoom: b.tenant_current_room,
        billRoom: b.room_id,
        hint: 'ตรวจสอบว่าบิลห้องเก่าควรส่งให้ผู้เช่าคนใหม่ของห้อง — ไม่ใช่ผู้เช่าเก่าที่ย้าย',
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
    const billLink = (publicUrl && payToken)
      ? `${publicUrl}/pay/${encodeURIComponent(billId)}?t=${encodeURIComponent(payToken)}`
      : `${publicUrl}/tenant?bill=${encodeURIComponent(billId)}`;
    const dueDateStr = b.due_date
      ? new Date(b.due_date).toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' })
      : '-';
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
      ``,
      `วิธีชำระเงิน:`,
      paymentChoices.length ? paymentChoices.join('\n') : `เปิดหน้าบิลเพื่อตรวจสอบช่องทางชำระเงิน`,
      ``,
      `👉 ดูบิล + ส่งสลิป:`,
      billLink,
      ``,
      `(หากกดลิงก์ไม่ได้ ให้เข้า ${publicUrl || 'พอร์ทัล'}/tenant แล้วเลือกบิล ${b.bill_no || `#${billId}`})`,
    ].join('\n');
    const enqueued = [];
    const hasLine = lineNotify.isLikelyUserId(b.line_user_id);
    if (!hasLine && !b.email) {
      const flags = await features.load(pool);
      const owner = await notifier.notifyOwner({ pool, features: flags }, {
        subject: 'Bill send skipped: no tenant channel',
        text: [
          `Bill was not sent because the tenant has no LINE or email.`,
          `Bill: ${b.bill_no || b.id}`,
          `Room: ${b.room_id}`,
          b.tenant_name ? `Tenant: ${b.tenant_name}` : null,
          `Amount: THB ${Number(b.total).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`,
        ].filter(Boolean).join('\n'),
      });
      return {
        ok: false,
        error: 'tenant has no reachable channel',
        code: 'NO_TENANT_CHANNEL',
        enqueued,
        ownerNotified: !!(owner.ok || owner.queued),
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
            bankInfo,
          })
        : null;
      const qid = await notifQueue.enqueue(pool, {
        channel: 'line', recipient: b.line_user_id, subject, body,
        // payload.messages carries the raw LINE message array; the queue
        // dispatcher uses pushMessages when this is present, falling back
        // to plain pushText when absent. Keep `body` populated either way
        // as a safety net + for the email channel duplicated below.
        payload: {
          oaId: b.line_oa_id || null,
          billId,
          messages: lineMessages,
        },
      });
      enqueued.push({ channel: 'line', id: qid });
    } else if (!b.email) {
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
    if (b.email) {
      const qid = await notifQueue.enqueue(pool, {
        channel: 'email', recipient: b.email, subject, body,
        payload: { billId },
      });
      enqueued.push({ channel: 'email', id: qid });
    }
    // Stamp last_reminded_at + bump reminder_count so the next time admin
    // opens the send modal they see "ส่งไปแล้ว N ครั้ง · ล่าสุด ...".
    // Only stamp when we actually enqueued something — NO_TENANT_CHANNEL
    // already returned above so we only reach here on a real send.
    if (enqueued.length > 0) {
      await pool.query(
        `UPDATE bills
           SET last_reminded_at=NOW(),
               reminder_count = COALESCE(reminder_count, 0) + 1
         WHERE id=$1`,
        [billId]
      ).catch((err) => console.warn('[enqueueBillNotifications] stamp last_reminded_at failed:', err.message));
    }
    return { ok: true, enqueued };
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
                  t.line_user_id, t.email,
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
          } else if (b.tenant_status !== 'active') {
            blockCode = 'TENANT_NOT_ACTIVE';
            blockMsg = `ผู้เช่าสถานะ "${b.tenant_status}"`;
          } else if (b.tenant_current_room && String(b.tenant_current_room) !== String(b.room_id)) {
            blockCode = 'TENANT_MOVED_ROOM';
            blockMsg = `ย้ายไปห้อง ${b.tenant_current_room}`;
          } else {
            const hasLine = lineNotify.isLikelyUserId(b.line_user_id);
            if (!hasLine && !b.email) {
              blockCode = 'NO_TENANT_CHANNEL';
              blockMsg = 'ไม่ผูก LINE + ไม่มีอีเมล';
            }
          }
          const channels = {
            line: lineNotify.isLikelyUserId(b.line_user_id),
            email: !!b.email,
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
            warnCode: !blockCode && !channels.line && channels.email ? 'EMAIL_ONLY' : null,
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
        const issues = [];
        const channels = { line: false, email: false, lineOa: null };

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
        } else if (b.tenant_status !== 'active') {
          issues.push({ sev: 'high', code: 'TENANT_NOT_ACTIVE',
            msg: `ผู้เช่า "${b.tenant_name}" สถานะ "${b.tenant_status}" — ไม่ใช่ผู้เช่าปัจจุบัน`,
            fix: 'ผู้เช่าออกไปแล้ว — ติดต่อโดยตรง หรือออกบิลให้ผู้เช่าใหม่' });
        } else if (b.tenant_current_room && String(b.tenant_current_room) !== String(b.room_id)) {
          issues.push({ sev: 'high', code: 'TENANT_MOVED_ROOM',
            msg: `ผู้เช่าย้ายห้องไปแล้ว — ปัจจุบันอยู่ห้อง ${b.tenant_current_room} แต่บิลเป็นของห้อง ${b.room_id}`,
            fix: 'ผู้เช่าใหม่ของห้อง ' + b.room_id + ' ควรเป็นคนรับบิลนี้' });
        }

        // Channel availability — only when tenant is otherwise valid
        if (b.tenant_row_id && b.tenant_status === 'active'
            && (!b.tenant_current_room || String(b.tenant_current_room) === String(b.room_id))) {
          const hasLine = lineNotify.isLikelyUserId(b.line_user_id);
          channels.line = !!hasLine;
          channels.email = !!b.email;
          channels.lineOa = b.line_oa_id || null;
          if (!hasLine && !b.email) {
            issues.push({ sev: 'high', code: 'NO_TENANT_CHANNEL',
              msg: `ผู้เช่า "${b.tenant_name}" ยังไม่ผูก LINE และไม่ใส่อีเมล`,
              fix: '/admin#tenants → tab "Portal Access" ผูก LINE หรือใส่อีเมล' });
          } else if (!hasLine && b.email) {
            issues.push({ sev: 'med', code: 'EMAIL_ONLY',
              msg: 'ผู้เช่าไม่ผูก LINE — จะส่งทางอีเมลอย่างเดียว (อาจไปกล่อง spam)',
              fix: 'แนะนำผูก LINE ที่ /admin#tenants → Portal Access' });
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
            email: b.email, hasLine: !!b.line_user_id, status: b.tenant_status,
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
      try {
        const out = await enqueueBillNotifications(id);
        if (!out.ok) {
          const status = out.code === 'NO_TENANT_CHANNEL' ? 409 : 404;
          return res.status(status).json({
            error: out.error,
            code: out.code,
            ownerNotified: out.ownerNotified,
            enqueued: out.enqueued || [],
          });
        }
        audit(req, 'bill.send', 'bill', String(id), { enqueued: out.enqueued });
        res.json({ ok: true, enqueued: out.enqueued });
      } catch (err) {
        console.error('bill send error:', err);
        res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
      }
    });

  // POST /api/bills/bulk-send — enqueue all pending/overdue. Calls the
  // shared helper directly (no self-HTTP) so admin session and CSRF token
  // don't need to round-trip.
  r.post('/bulk-send', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    async (req, res) => {
      try {
        const { rows } = await pool.query(
          `SELECT id FROM bills WHERE deleted_at IS NULL AND status IN ('pending','overdue')`
        );
        let enqueued = 0, failed = 0;
        for (const row of rows) {
          try {
            const out = await enqueueBillNotifications(row.id);
            if (out.ok) enqueued++; else failed++;
          } catch { failed++; }
        }
        audit(req, 'bill.bulk_send', null, null, { attempted: rows.length, enqueued, failed });
        res.json({ ok: true, attempted: rows.length, enqueued, failed });
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
      try {
        await client.query('BEGIN');
        const bill = await client.query(
          `SELECT id, bill_no, period, total, status, tenant_id
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
        if (row.status !== 'pending' && row.status !== 'overdue') {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'bill is not payable',
            code: 'BILL_NOT_PAYABLE',
            billStatus: row.status,
          });
        }
        const billTotal = Number(row.total);
        if (!Number.isFinite(billTotal) || billTotal <= 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'bill total is invalid', code: 'INVALID_BILL_TOTAL' });
        }
        if (Math.abs(requestedAmount - billTotal) > billing.PAYMENT_TOLERANCE_THB) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'payment amount does not match bill total',
            code: 'PAYMENT_AMOUNT_MISMATCH',
            billTotal,
            paymentAmount: requestedAmount,
          });
        }
        const existing = await client.query(
          `SELECT id FROM payments WHERE bill_id=$1 AND status='verified' LIMIT 1`,
          [id]
        );
        if (existing.rows.length) {
          await client.query('ROLLBACK');
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
            billTotal,
            method,
            ref,
            slipUrl,
            verifier,
            JSON.stringify({ source: 'admin-billing', requestedAmount }),
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
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'bill was not marked paid',
            code: 'BILL_MARK_PAID_FAILED',
          });
        }
        await client.query('COMMIT');
        audit(req, 'bill.manual_pay', 'bill', String(id), {
          paymentId: payment.rows[0].id,
          amount: billTotal,
          method,
          supersededPaymentIds: supersededPending.rows.map((r) => r.id),
        });
        notifyManualPayment(
          payment.rows[0],
          paid.rows[0] || row,
          verifier,
          supersededPending.rows.length
        ).catch(() => {});
        // Auto-recompute room status — if this was the last overdue bill,
        // the room flips overdue → occupied without admin clicking.
        // paid.rows[0].room_id comes from the RETURNING * above.
        const billRoomId = paid.rows[0]?.room_id;
        if (billRoomId) {
          require('../services/roomStatus').syncRoom(pool, billRoomId, { reason: 'manual-pay' })
            .catch((err) => console.warn(`[bills.pay] room sync failed:`, err.message));
        }
        res.json({ ok: true, bill: paid.rows[0], payment: payment.rows[0] });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('bill manual pay error:', err);
        // If we uploaded a slip before the transaction failed, scrub the
        // orphan file so R2 doesn't accumulate unattached evidence.
        if (slipUploadId) {
          storage.remove(pool, slipUploadId)
            .catch((e) => console.warn('[bill.pay] orphan slip cleanup failed:', e.message));
        }
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
      try {
        await client.query('BEGIN');
        const bill = await client.query(
          `SELECT id, status, total, deleted_at FROM bills WHERE id=$1 FOR UPDATE`,
          [id]
        );
        if (!bill.rows.length || bill.rows[0].deleted_at) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'bill not found' });
        }
        const pres = await client.query(
          `SELECT id, amount FROM payments
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
          const billTotal = Number(bill.rows[0].total);
          const paymentAmount = Number(pres.rows[0].amount);
          if (!Number.isFinite(billTotal) || !Number.isFinite(paymentAmount)
              || Math.abs(paymentAmount - billTotal) > billing.PAYMENT_TOLERANCE_THB) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: 'payment amount does not match bill total',
              code: 'PAYMENT_AMOUNT_MISMATCH',
              billTotal,
              paymentAmount,
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
               RETURNING id`,
            [id]
          );
          if (paid.rowCount !== 1) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: 'bill was not marked paid',
              code: 'BILL_MARK_PAID_FAILED',
            });
          }
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
        // we already have the bill row in scope (status='paid' after the
        // UPDATE), so look up the room and sync. Reject path doesn't change
        // the bill state so room status doesn't move.
        if (accept) {
          try {
            const rQ = await pool.query(`SELECT room_id FROM bills WHERE id=$1 LIMIT 1`, [id]);
            const rid = rQ.rows[0]?.room_id;
            if (rid) {
              require('../services/roomStatus').syncRoom(pool, rid, { reason: 'slip-verify' })
                .catch((err) => console.warn(`[bills.verify-slip] room sync failed:`, err.message));
            }
          } catch (err) {
            console.warn(`[bills.verify-slip] room lookup failed:`, err.message);
          }
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
            let buildingName = 'บ้านกาญจน์ เรสซิเดนซ์';
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
