// routes/tenant-ops.js
// Multi-step tenant operations that need a DB transaction:
//   - checkIn:  create tenant (or use existing) + flip room to occupied + draft welcome bill
//   - checkOut: close tenant + flip room to vacant + finalize bill (pro-rate)
//   - PIN management: change PIN (current PIN required) + first-time set (phone + id_card4)

const express = require('express');
const bcrypt = require('bcryptjs');
const { schemas } = require('../schemas');
const { validateBody } = require('../middleware/validate');
const billing = require('../services/billing');
const features = require('../services/features');
const cryptoSvc = require('../services/crypto');

// PIN trivial-reject — kept identical to server.js
const TRIVIAL_PINS_4 = new Set([
  '0000','1111','2222','3333','4444','5555','6666','7777','8888','9999',
  '1234','4321','2580','1010','1212','1313',
]);
function isTrivialPin(s) {
  const str = String(s || '');
  if (!/^\d{4,8}$/.test(str)) return false;
  if (str.length === 4 && TRIVIAL_PINS_4.has(str)) return true;
  if (/^(\d)\1+$/.test(str)) return true;
  if (/^(0123|1234|2345|3456|4567|5678|6789|9876|8765|7654)/.test(str)) return true;
  return false;
}

module.exports = function buildTenantOpsRouter(ctx) {
  const { pool, requireAuth, requireRole, sameOrigin, csrfGuard, audit, requireTenant } = ctx;
  const r = express.Router();

  // === checkIn ============================================================
  // POST /api/tenants/:id/checkin
  // body: { roomId, moveInDate, depositAmount, monthlyRent }
  // Atomic: tenant.current_room_id + tenant.status='active' + room.status='occupied'
  // (in app_data blob if present) + create welcome bill draft for the period.
  r.post('/:id/checkin', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    validateBody(schemas.checkIn),
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
      const { roomId, moveInDate, depositAmount, monthlyRent } = req.body;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Update tenant
        const tres = await client.query(
          `UPDATE tenants
              SET current_room_id=$1, status='active', updated_at=NOW()
            WHERE id=$2 AND deleted_at IS NULL
            RETURNING id, full_name, phone, email`,
          [roomId, id]
        );
        if (!tres.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'tenant not found' });
        }
        const tenant = tres.rows[0];

        // Flip room status in app_data if the blob has this room.
        await client.query(
          `UPDATE app_data
              SET value = jsonb_set(value, ARRAY[$1::text, 'status'], to_jsonb('occupied'::text)),
                  updated_at=NOW()
            WHERE key='baankarn_rooms_v1' AND value ? $1`,
          [roomId]
        );

        // Create a contract row
        const contractNo = `C-${new Date().getFullYear()}-${String(id).padStart(4, '0')}`;
        await client.query(
          `INSERT INTO contracts (contract_no, tenant_id, room_id, start_date, monthly_rent, deposit, status)
           VALUES ($1, $2, $3, $4::date, $5, $6, 'active')
           ON CONFLICT (contract_no) DO NOTHING`,
          [contractNo, id, roomId, moveInDate, monthlyRent, depositAmount]
        );

        // Create welcome bill draft for current period
        const period = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
        const billNo = billing.makeBillNo(roomId, period);
        const dueDate = billing.formatDueDate(15);
        await client.query(
          `INSERT INTO bills
             (bill_no, tenant_id, room_id, period, rent, subtotal, total, due_date, status)
           VALUES ($1, $2, $3, $4, $5, $5, $5, $6, 'pending')
           ON CONFLICT (bill_no) DO NOTHING`,
          [billNo, id, roomId, period, monthlyRent, dueDate]
        );

        await client.query('COMMIT');
        audit(req, 'tenant.checkin', 'tenant', String(id),
          { roomId, depositAmount, monthlyRent, contractNo });
        res.json({ ok: true, tenant, contractNo, billNo });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('checkin error:', err);
        res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
      } finally {
        client.release();
      }
    }
  );

  // === checkOut ===========================================================
  // POST /api/tenants/:id/checkout
  // body: { reason?, finalDepositReturn? }
  r.post('/:id/checkout', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    validateBody(schemas.checkOut),
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
      const reason = req.body.reason || null;
      const refund = req.body.finalDepositReturn != null ? Number(req.body.finalDepositReturn) : null;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tres = await client.query(
          `SELECT id, current_room_id FROM tenants WHERE id=$1 AND deleted_at IS NULL`,
          [id]
        );
        if (!tres.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'tenant not found' });
        }
        const oldRoom = tres.rows[0].current_room_id;

        // Mark tenant moved_out
        await client.query(
          `UPDATE tenants SET status='moved_out', current_room_id=NULL, updated_at=NOW(),
             notes = COALESCE(notes,'') || CASE WHEN $2::text IS NOT NULL THEN E'\n[checkout] ' || $2::text ELSE '' END
           WHERE id=$1`,
          [id, reason]
        );

        // Close active contract
        await client.query(
          `UPDATE contracts SET status='ended', end_date=CURRENT_DATE
             WHERE tenant_id=$1 AND status='active'`,
          [id]
        );

        // Flip room status to vacant
        if (oldRoom) {
          await client.query(
            `UPDATE app_data
                SET value = jsonb_set(value, ARRAY[$1::text, 'status'], to_jsonb('vacant'::text)),
                    updated_at=NOW()
              WHERE key='baankarn_rooms_v1' AND value ? $1`,
            [oldRoom]
          );
        }

        await client.query('COMMIT');
        audit(req, 'tenant.checkout', 'tenant', String(id),
          { oldRoom, reason, refund });
        res.json({ ok: true, tenantId: id, oldRoom, refund });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('checkout error:', err);
        res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
      } finally {
        client.release();
      }
    }
  );

  // === Tenant portal — change PIN ========================================
  r.post('/_tenant/pin/change', sameOrigin, csrfGuard, requireTenant,
    validateBody(schemas.tenantChangePin),
    async (req, res) => {
      const { oldPin, newPin } = req.body;
      if (isTrivialPin(newPin)) {
        return res.status(400).json({ error: 'PIN ใหม่ไม่ปลอดภัย — เลี่ยงรูปแบบที่คาดเดาง่าย', code: 'WEAK_PIN' });
      }
      try {
        const { rows } = await pool.query(
          `SELECT pin_hash FROM tenants WHERE id=$1 AND deleted_at IS NULL`,
          [req.tenant.tenant_id]
        );
        if (!rows.length || !rows[0].pin_hash) {
          return res.status(401).json({ error: 'invalid credentials' });
        }
        const ok = await bcrypt.compare(oldPin, rows[0].pin_hash);
        if (!ok) return res.status(401).json({ error: 'รหัส PIN เดิมไม่ถูกต้อง' });
        const newHash = await bcrypt.hash(newPin, 10);
        await pool.query(`UPDATE tenants SET pin_hash=$1, updated_at=NOW() WHERE id=$2`,
          [newHash, req.tenant.tenant_id]);
        // Invalidate all other sessions for this tenant
        const sid = (req.headers.cookie || '').match(/(?:^|;\s*)tenant_sid=([^;]+)/)?.[1];
        if (sid) {
          await pool.query(`DELETE FROM tenant_sessions WHERE tenant_id=$1 AND sid<>$2`,
            [req.tenant.tenant_id, sid]);
        }
        audit(req, 'tenant.pin_change', 'tenant', String(req.tenant.tenant_id));
        res.json({ ok: true });
      } catch (err) {
        console.error('change pin error:', err);
        res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
      }
    }
  );

  // === Tenant portal — first-time set PIN with phone + last4(id_card) =====
  // Used when tenant has never logged in (pin_hash is NULL). The id_card
  // tail is used as a one-time secret — admin entered it during checkin.
  r.post('/_tenant/pin/init', sameOrigin, csrfGuard,
    validateBody(schemas.tenantSetPin),
    async (req, res) => {
      const { phone, citizenIdTail, newPin } = req.body;
      if (isTrivialPin(newPin)) {
        return res.status(400).json({ error: 'PIN ไม่ปลอดภัย — เลี่ยงรูปแบบที่คาดเดาง่าย', code: 'WEAK_PIN' });
      }
      try {
        const { rows } = await pool.query(
          `SELECT id, pin_hash, citizen_id_encrypted, citizen_id_tail
             FROM tenants WHERE phone=$1 AND deleted_at IS NULL AND status<>'blacklist' LIMIT 1`,
          [phone]
        );
        // Always run dummy bcrypt to keep timing constant
        const fakeHash = '$2a$10$' + 'X'.repeat(53);
        await bcrypt.compare(citizenIdTail, fakeHash).catch(() => {});

        if (!rows.length || rows[0].pin_hash) {
          // No tenant OR PIN already set — refuse without leaking which case.
          return res.status(401).json({ error: 'ข้อมูลไม่ตรงกัน' });
        }
        const t = rows[0];
        // Verify last 4 of citizen ID. Prefer comparing against tail field;
        // fall back to decrypting if tail was not stored.
        let storedTail = t.citizen_id_tail;
        if (!storedTail && t.citizen_id_encrypted) {
          try {
            storedTail = (cryptoSvc.decryptString(t.citizen_id_encrypted) || '').slice(-4);
          } catch { /* ignore */ }
        }
        if (!storedTail || storedTail !== citizenIdTail) {
          return res.status(401).json({ error: 'ข้อมูลไม่ตรงกัน' });
        }
        const hash = await bcrypt.hash(newPin, 10);
        await pool.query(`UPDATE tenants SET pin_hash=$1, updated_at=NOW() WHERE id=$2`,
          [hash, t.id]);
        audit(req, 'tenant.pin_init', 'tenant', String(t.id));
        res.json({ ok: true });
      } catch (err) {
        console.error('init pin error:', err);
        res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
      }
    }
  );

  return r;
};
