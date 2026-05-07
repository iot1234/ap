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
// queryWithRetry retries serialization/deadlock errors (40001, 40P01, 57P03,
// 53300). bulk-generate inserts ~30+ bills in a tight loop — most likely
// path to hit a deadlock against the scheduler's auto-gen running parallel.
const { queryWithRetry } = require('../db/pool');

module.exports = function buildBillsExtrasRouter(ctx) {
  const { pool, requireAuth, requireRole, sameOrigin, csrfGuard, audit } = ctx;
  const r = express.Router();

  // POST /api/bills/bulk-generate
  // body (optional): { period: "YYYY-MM", dueDay: 15 }
  r.post('/bulk-generate', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    async (req, res) => {
      const now = new Date();
      const period = String(req.body?.period
        || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`).slice(0, 7);
      const dueDay = Number(req.body?.dueDay || 15);
      try {
        const flags = await features.load(pool);
        const [roomsRow, configRow] = await Promise.all([
          pool.query(`SELECT value FROM app_data WHERE key='baankarn_rooms_v1'`),
          pool.query(`SELECT value FROM app_data WHERE key='baankarn_config_v1'`),
        ]);
        const rooms = Object.values(roomsRow.rows.length ? roomsRow.rows[0].value : {});
        const config = configRow.rows.length ? configRow.rows[0].value : {};
        const dueDate = new Date(now.getFullYear(), now.getMonth(), dueDay).toISOString().slice(0, 10);
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
          try {
            const params = [];
            const ors = [];
            if (tenantIdForRoom) { params.push(tenantIdForRoom); ors.push(`tenant_id = $${params.length}`); }
            params.push(room.id); ors.push(`room_id = $${params.length}`);
            const rc = await pool.query(
              `SELECT label, amount FROM recurring_charges
                 WHERE active = TRUE AND (${ors.join(' OR ')})
                   AND (start_at IS NULL OR start_at <= CURRENT_DATE)
                   AND (end_at IS NULL OR end_at >= CURRENT_DATE)`,
              params
            );
            recurring = rc.rows.map((x) => ({ label: x.label, amount: Number(x.amount) }));
          } catch { /* table may not exist on older deployments */ }
          const bill = billing.buildBill({ room, config, features: flags, previous, recurring, period, dueDate });
          try {
            const { rowCount } = await queryWithRetry(
              `INSERT INTO bills
                 (bill_no, tenant_id, room_id, period, rent,
                  water_units, water_rate, water_amount,
                  elec_units, elec_rate, elec_amount, wifi, subtotal, vat, late_fee, total, due_date, status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'pending')
               ON CONFLICT (bill_no) DO NOTHING`,
              [
                bill.billNo, tenantIdForRoom, bill.roomId, bill.period,
                bill.rent, bill.waterUnits, bill.waterRate, bill.waterAmount,
                bill.elecUnits, bill.elecRate, bill.elecAmount,
                bill.wifi, bill.subtotal, bill.vat, bill.lateFee, bill.total,
                bill.dueDate,
              ],
              { pool, attempts: 3 }
            );
            if (rowCount) made++; else skipped++;
          } catch (e) {
            // A7 — partial unique on (room_id, period) also blocks duplicates
            // when the two paths produce different bill_nos for same period.
            if (e.code !== '23505') console.error('[bulk-generate] insert failed:', e.message);
            skipped++;
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
  async function enqueueBillNotifications(billId) {
    const billQ = await pool.query(
      `SELECT b.*, t.full_name AS tenant_name, t.phone AS tenant_phone, t.line_user_id, t.email
         FROM bills b LEFT JOIN tenants t ON t.id = b.tenant_id
         WHERE b.id=$1 AND b.deleted_at IS NULL`,
      [billId]
    );
    if (!billQ.rows.length) return { ok: false, error: 'not found' };
    if (billQ.rows[0].status === 'void') return { ok: false, error: 'bill is void' };
    const b = billQ.rows[0];
    const subject = `บิลรอบ ${b.period} — ห้อง ${b.room_id}`;
    const body = `บิลใหม่\nผู้เช่า: ${b.tenant_name || '-'}\nห้อง: ${b.room_id}\nรอบ: ${b.period}\nยอด: ฿${Number(b.total).toLocaleString('th-TH', { minimumFractionDigits: 2 })}\nกำหนดชำระ: ${b.due_date}`;
    const enqueued = [];
    if (b.line_user_id) {
      const qid = await notifQueue.enqueue(pool, { channel: 'line', recipient: b.line_user_id, subject, body });
      enqueued.push({ channel: 'line', id: qid });
    } else {
      const lineOwner = require('../services/secrets').get('LINE_OWNER_USER_ID');
      if (lineOwner) {
        const qid = await notifQueue.enqueue(pool, {
          channel: 'line', recipient: lineOwner, subject, body,
        });
        enqueued.push({ channel: 'line', id: qid });
      }
    }
    if (b.email) {
      const qid = await notifQueue.enqueue(pool, { channel: 'email', recipient: b.email, subject, body });
      enqueued.push({ channel: 'email', id: qid });
    }
    return { ok: true, enqueued };
  }

  // POST /api/bills/:id/send — enqueue LINE/email
  r.post('/:id/send', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
      try {
        const out = await enqueueBillNotifications(id);
        if (!out.ok) return res.status(404).json({ error: out.error });
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

  // POST /api/bills/:id/verify-slip — admin marks the latest slip verified.
  // Equivalent to PUT /api/payments/:id/verify but takes a bill id instead.
  r.post('/:id/verify-slip', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager', 'staff'),
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
      const accept = req.body?.accept !== false;
      const reason = String(req.body?.reason || '').slice(0, 500);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const pres = await client.query(
          `SELECT id FROM payments
             WHERE bill_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1`,
          [id]
        );
        if (!pres.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'no pending slip for this bill' });
        }
        const pid = pres.rows[0].id;
        if (accept) {
          await client.query(
            `UPDATE payments SET status='verified', verified_by=$1, verified_at=NOW() WHERE id=$2`,
            [req.session.user.username, pid]
          );
          await client.query(
            `UPDATE bills SET status='paid', paid_at=NOW() WHERE id=$1 AND status<>'paid'`,
            [id]
          );
        } else {
          await client.query(
            `UPDATE payments SET status='rejected', verified_by=$1, verified_at=NOW(), rejected_reason=$2
               WHERE id=$3`,
            [req.session.user.username, reason, pid]
          );
        }
        await client.query('COMMIT');
        audit(req, accept ? 'slip.verify' : 'slip.reject', 'bill', String(id), { paymentId: pid, reason });
        // Fire-and-forget tenant notification with the verdict
        try {
          const pq = await pool.query(
            `SELECT p.*, t.id AS t_id, t.full_name, t.phone, t.email, t.line_user_id
               FROM payments p LEFT JOIN tenants t ON t.id=p.tenant_id
               WHERE p.id=$1`, [pid]
          );
          if (pq.rows.length && pq.rows[0].t_id) {
            const flags = await features.load(pool);
            const subject = accept ? '✅ ตรวจสอบการชำระเงินแล้ว' : '❌ สลิปไม่ผ่านการตรวจสอบ';
            const text = accept
              ? `ชำระเงินบิล #${id} ได้รับการยืนยันแล้ว`
              : `สลิปสำหรับบิล #${id} ไม่ผ่านการตรวจสอบ${reason ? `\nเหตุผล: ${reason}` : ''}`;
            notifier.notifyTenant({ pool, features: flags },
              { id: pq.rows[0].t_id, line_user_id: pq.rows[0].line_user_id,
                phone: pq.rows[0].phone, email: pq.rows[0].email, full_name: pq.rows[0].full_name },
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
