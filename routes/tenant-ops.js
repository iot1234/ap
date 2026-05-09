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

// PIN trivial-reject — single source of truth.
const { TRIVIAL_PINS_4, isTrivialPin } = require('../services/pinPolicy');

module.exports = function buildTenantOpsRouter(ctx) {
  const { pool, requireAuth, requireRole, sameOrigin, csrfGuard, audit, requireTenant,
          lockout, makeIpLimiter } = ctx;
  // Brute-force defenses for the unauthenticated PIN init endpoint. Without
  // these an attacker who knows a phone number can try all 10,000 possible
  // 4-digit citizen-id tails freely. IP-level limiter caps scripted attempts;
  // per-phone lockout makes rotating IPs ineffective too.
  const pinInitIpLimiter = makeIpLimiter
    ? makeIpLimiter({ windowMs: 15 * 60_000, max: 8, message: 'too many PIN init attempts' })
    : (_req, _res, next) => next();
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
      const { roomId, moveInDate, depositAmount, monthlyRent,
              termMonths, discountPct: explicitDiscount } = req.body;

      // Resolve discount % from term length when admin didn't pass an
      // explicit override. Reads config.discounts.{sixMonth/twelveMonth/
      // twentyFourMonth} from the same JSONB blob the pricing UI writes —
      // closes the loop where those numbers used to be configured but
      // never applied to bills.
      let resolvedDiscountPct = 0;
      if (explicitDiscount != null) {
        resolvedDiscountPct = Number(explicitDiscount) || 0;
      } else if (termMonths) {
        try {
          const { rows: cfgRows } = await pool.query(
            `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
          );
          const discounts = cfgRows[0]?.value?.discounts || {};
          if (termMonths >= 24 && Number(discounts.twentyFourMonth) > 0) {
            resolvedDiscountPct = Number(discounts.twentyFourMonth);
          } else if (termMonths >= 12 && Number(discounts.twelveMonth) > 0) {
            resolvedDiscountPct = Number(discounts.twelveMonth);
          } else if (termMonths >= 6 && Number(discounts.sixMonth) > 0) {
            resolvedDiscountPct = Number(discounts.sixMonth);
          }
        } catch { /* config blob missing — leave at 0 */ }
      }

      // Compute end_date from termMonths so the contract-expiry scheduler
      // has something concrete to fire on. Open-ended contracts (no
      // termMonths) leave end_date NULL — handled by scheduler as "no
      // expiry alert needed".
      let endDate = null;
      if (termMonths) {
        const start = new Date(moveInDate);
        if (Number.isFinite(start.getTime())) {
          const end = new Date(start);
          end.setMonth(end.getMonth() + Number(termMonths));
          endDate = end.toISOString().slice(0, 10);
        }
      }

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

        // Create a contract row.
        const contractNo = `C-${new Date().getFullYear()}-${String(id).padStart(4, '0')}`;
        await client.query(
          `INSERT INTO contracts (contract_no, tenant_id, room_id, start_date, end_date,
                                  monthly_rent, deposit, status, term_months, discount_pct)
           VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, 'active', $8, $9)
           ON CONFLICT (contract_no) DO NOTHING`,
          [contractNo, id, roomId, moveInDate, endDate,
           monthlyRent, depositAmount, termMonths || null, resolvedDiscountPct]
        );

        // Create welcome bill draft for current period. If
        // config.discounts.firstMonth is set, stack it on top of the
        // contract discount we just resolved (multiplicative — 10% + 5% =
        // 14.5%, not 15%, capped at 50%). This is what makes the
        // "first-month-X%-off" promotion in /admin#pricing actually fire.
        const period = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
        const billNo = billing.makeBillNo(roomId, period);
        const dueDate = billing.formatDueDate(15);
        let welcomeRent = Number(monthlyRent) || 0;
        try {
          const { rows: cfgR } = await client.query(
            `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
          );
          const firstMonthPct = Math.max(0, Math.min(50,
            Number(cfgR[0]?.value?.discounts?.firstMonth) || 0));
          const contractPct = Math.max(0, Math.min(50, resolvedDiscountPct));
          const combinedPct = Math.min(50,
            100 * (1 - (1 - contractPct / 100) * (1 - firstMonthPct / 100)));
          welcomeRent = Math.round(welcomeRent * (1 - combinedPct / 100) * 100) / 100;
        } catch { /* config blob missing — fall back to full monthlyRent */ }
        await client.query(
          `INSERT INTO bills
             (bill_no, tenant_id, room_id, period, rent, subtotal, total, due_date, status)
           VALUES ($1, $2, $3, $4, $5, $5, $5, $6, 'pending')
           ON CONFLICT (bill_no) DO NOTHING`,
          [billNo, id, roomId, period, welcomeRent, dueDate]
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
        // Invalidate all other sessions for this tenant. tenant_sessions.sid
        // now stores sha256(raw cookie), so hash before comparing.
        const sid = (req.headers.cookie || '').match(/(?:^|;\s*)tenant_sid=([^;]+)/)?.[1];
        if (sid) {
          const sidHash = require('crypto').createHash('sha256').update(sid).digest('hex');
          await pool.query(
            `DELETE FROM tenant_sessions WHERE tenant_id=$1 AND sid_hash<>$2`,
            [req.tenant.tenant_id, sidHash]
          );
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
  // Hardened: IP rate limiter (~8/15min) + per-phone lockout (5 wrong
  // tails → 30min lockout) so brute-forcing 10,000 tails isn't feasible.
  r.post('/_tenant/pin/init', sameOrigin, csrfGuard, pinInitIpLimiter,
    validateBody(schemas.tenantSetPin),
    async (req, res) => {
      const { phone, citizenIdTail, newPin } = req.body;
      if (isTrivialPin(newPin)) {
        return res.status(400).json({ error: 'PIN ไม่ปลอดภัย — เลี่ยงรูปแบบที่คาดเดาง่าย', code: 'WEAK_PIN' });
      }
      const principal = `pin_init:${String(phone).slice(0, 32)}`;
      try {
        // Per-phone lockout check first so a locked attacker can't even
        // see DB lookup timing.
        if (lockout) {
          try { await lockout.check(principal); }
          catch (err) {
            if (err.code === 'LOCKED_OUT') {
              const minutes = Math.ceil((err.retryAfterMs || 0) / 60_000);
              audit(req, 'tenant.pin_init_locked', 'tenant', phone, null, phone).catch(() => {});
              return res.status(429).json({
                error: `ลองใหม่ใน ${minutes} นาที`, code: 'LOCKED_OUT',
              });
            }
            throw err;
          }
        }

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
          if (lockout) lockout.recordFailure(principal, 'tenant').catch(() => {});
          audit(req, 'tenant.pin_init_failed', 'tenant', phone,
            { reason: !rows.length ? 'no_tenant' : 'already_set' }, phone).catch(() => {});
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
          if (lockout) lockout.recordFailure(principal, 'tenant').catch(() => {});
          audit(req, 'tenant.pin_init_failed', 'tenant', String(t.id),
            { reason: 'bad_tail' }, phone).catch(() => {});
          return res.status(401).json({ error: 'ข้อมูลไม่ตรงกัน' });
        }
        const hash = await bcrypt.hash(newPin, 10);
        await pool.query(`UPDATE tenants SET pin_hash=$1, updated_at=NOW() WHERE id=$2`,
          [hash, t.id]);
        // Successful init → clear failure counter for this phone.
        if (lockout) lockout.reset(principal).catch(() => {});
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
