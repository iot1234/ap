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
const notifier = require('../services/notifier');
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
              termMonths, discountPct: explicitDiscount,
              agreedTermsVersion, force } = req.body;
      const isForced = force === true;

      // ============================ SAFETY GUARDS ===========================
      // Each guard surfaces a structured error code so the admin UI can show
      // a precise message + a "force anyway" button (audit-logged). All can
      // be bypassed via { force: true } in the body for migrations / legacy
      // data — but the bypass is recorded in audit_logs for accountability.
      let flags;
      try { flags = await features.load(pool); }
      catch { flags = {}; }
      const tenancy = (flags.tenancyContract) || {};

      // (1) moveInDate sanity — within configured past/future window.
      // Catches typos like "2027-..." and prevents back-dated checkins
      // older than the operator-allowed grace window. Bypass with force.
      const todayStr = new Date().toISOString().slice(0, 10);
      const today = new Date(todayStr + 'T00:00:00Z');
      const target = new Date(moveInDate + 'T00:00:00Z');
      if (Number.isFinite(target.getTime())) {
        const diffDays = Math.round((target - today) / 86_400_000);
        const past = Number(tenancy.moveInPastDays ?? 30);
        const future = Number(tenancy.moveInFutureDays ?? 90);
        if (!isForced && (diffDays < -Math.abs(past) || diffDays > Math.abs(future))) {
          return res.status(400).json({
            error: `วันเข้าพัก (${moveInDate}) อยู่นอกช่วงที่ตั้งไว้ (อดีต ≤ ${past} วัน / อนาคต ≤ ${future} วัน)`,
            code: 'MOVE_IN_OUT_OF_WINDOW',
            today: todayStr, requested: moveInDate, diffDays,
            hint: 'ตรวจสอบอีกครั้งหรือส่ง { force: true } ถ้ายืนยัน',
          });
        }
      }

      // (2) Deposit sanity — at most depositMaxMonths × monthlyRent.
      // Catches the common "typed an extra zero" error that would otherwise
      // produce a contract claiming 50,000฿ deposit on a 5,000฿/mo room.
      const depositMaxMonths = Number(tenancy.depositMaxMonths ?? 3);
      const maxDeposit = depositMaxMonths * Number(monthlyRent);
      if (!isForced && Number(depositAmount) > maxDeposit) {
        return res.status(400).json({
          error: `เงินมัดจำ (${depositAmount}) มากกว่า ${depositMaxMonths} เท่าของค่าเช่ารายเดือน (สูงสุด ${maxDeposit})`,
          code: 'DEPOSIT_TOO_LARGE',
          monthlyRent, depositAmount, maxDeposit, depositMaxMonths,
          hint: 'ตรวจค่าอีกครั้งหรือส่ง { force: true } ถ้าเป็น deposit พิเศษ',
        });
      }

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
      //
      // setMonth() rolls over end-of-month edge cases incorrectly: Jan 31
      // + 1 month → Mar 3 (because Feb 31 doesn't exist, JS adds the
      // overflow days). Fix by clamping the day-of-month to the last valid
      // day of the target month so Jan 31 + 1mo → Feb 28/29.
      let endDate = null;
      if (termMonths) {
        // Parse YYYY-MM-DD as components rather than relying on Date()
        // timezone parsing which interprets the bare string as UTC and
        // can shift one day on Asia/Bangkok.
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(moveInDate);
        if (m) {
          const sy = Number(m[1]);
          const sm = Number(m[2]);
          const sd = Number(m[3]);
          // Add termMonths to (year, month). Compute target month using
          // 0-indexed math, then clamp day to the last day of that month.
          const totalMonths = (sy * 12 + (sm - 1)) + Number(termMonths);
          const ey = Math.floor(totalMonths / 12);
          const em = (totalMonths % 12) + 1;  // 1..12
          // Last day of (ey, em) — day 0 of the NEXT month.
          const lastDom = new Date(Date.UTC(ey, em, 0)).getUTCDate();
          const ed = Math.min(sd, lastDom);
          endDate = `${ey}-${String(em).padStart(2, '0')}-${String(ed).padStart(2, '0')}`;
        }
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Lock the tenant row so the SELECT we use for the safety checks
        // sees a consistent state, and a parallel checkin against the same
        // tenant is serialised. Without FOR UPDATE, two near-simultaneous
        // checkin requests could both pass the "not already active" check.
        const tCheck = await client.query(
          `SELECT id, full_name, phone, email, status, current_room_id,
                  citizen_id_image_front_id, citizen_id_image_back_id,
                  address, emergency_contact_name, emergency_contact_phone
             FROM tenants WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
          [id]
        );
        if (!tCheck.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'tenant not found' });
        }
        const existing = tCheck.rows[0];

        // (3) Tenant must not be active in a DIFFERENT room already.
        // Without this guard, calling checkin on an already-active tenant
        // silently moves them to the new room without ending the old
        // contract or releasing the previous room. Result: two rooms
        // claim the same tenant, two contracts both 'active'.
        if (!isForced && existing.status === 'active'
            && existing.current_room_id && existing.current_room_id !== roomId) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `ผู้เช่ายังเช่าอยู่ห้อง ${existing.current_room_id} — ต้อง check-out ก่อน`,
            code: 'TENANT_ALREADY_ACTIVE',
            currentRoom: existing.current_room_id,
            hint: 'ทำการ check-out จากห้องเก่าก่อน หรือส่ง { force: true } ถ้าเป็นการ migrate ข้อมูล',
          });
        }

        // (4) Room must not be currently occupied by a DIFFERENT tenant.
        // Two layers of protection against the parallel-checkin race:
        //
        //   (a) pg_advisory_xact_lock keyed on the room_id hash, taken
        //       BEFORE the occupancy SELECT. Two parallel transactions
        //       targeting the same room are now serialised — the second
        //       blocks until the first commits, then sees the updated
        //       state.
        //   (b) Belt-and-braces SELECT FOR UPDATE on every active tenant
        //       row currently assigned to this room. SELECT-without-FOR-
        //       UPDATE used to let two parallel checkins both see the
        //       room as vacant.
        //
        // The advisory lock is xact-scoped so it auto-releases on commit/
        // rollback. The hash is FNV-1a of the room id string, clamped to
        // int32 (Postgres advisory locks accept (int4, int4) signatures).
        if (!isForced) {
          // Hash room_id → int32 advisory key (see scheduler's _lockKeyFor).
          let h = 0x811c9dc5;
          const s = String(roomId);
          for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
          }
          const lockKey = (h >>> 0) & 0x7fffffff;
          // Namespace 0x434b494e ("CKIN" — checkin) so advisory locks from
          // unrelated subsystems can't collide.
          await client.query(
            'SELECT pg_advisory_xact_lock($1::int, $2::int)',
            [0x434b494e, lockKey]
          );
          const occupants = await client.query(
            `SELECT id, full_name FROM tenants
               WHERE current_room_id=$1 AND status='active' AND deleted_at IS NULL AND id<>$2
               LIMIT 1
               FOR UPDATE`,
            [roomId, id]
          );
          if (occupants.rows.length) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: `ห้อง ${roomId} มีผู้เช่ารายอื่นอยู่แล้ว (id=${occupants.rows[0].id})`,
              code: 'ROOM_OCCUPIED',
              occupant: occupants.rows[0],
              hint: 'ทำการ check-out ผู้เช่าเดิมก่อน หรือส่ง { force: true } ถ้าเป็นการ migrate',
            });
          }
        }

        // (5) Identity / address / emergency contact required when the
        // feature flag insists. Lookup uses the FOR UPDATE-locked row.
        // Identity images: split into two distinct missing markers so admin
        // knows which side still needs uploading (the most common confusion
        // in v1 was "I uploaded the front, why won't checkin let me proceed?"
        // — admin had simply forgotten the back).
        const missing = [];
        if (tenancy.requireIdentityImages !== false) {
          if (!existing.citizen_id_image_front_id) missing.push('citizenIdFront');
          if (!existing.citizen_id_image_back_id)  missing.push('citizenIdBack');
        }
        if (tenancy.requireAddress !== false && !existing.address) {
          missing.push('address');
        }
        if (tenancy.requireEmergencyContact !== false
            && (!existing.emergency_contact_name || !existing.emergency_contact_phone)) {
          missing.push('emergencyContact');
        }
        if (!isForced && missing.length > 0) {
          await client.query('ROLLBACK');
          // Build a human-friendly hint that lists each missing item by
          // name so admin doesn't have to map error codes back to fields.
          const labels = {
            citizenIdFront: 'รูปบัตรประชาชนด้านหน้า',
            citizenIdBack:  'รูปบัตรประชาชนด้านหลัง',
            address:        'ที่อยู่ผู้เช่า',
            emergencyContact: 'ผู้ติดต่อฉุกเฉิน (ชื่อ + เบอร์)',
          };
          return res.status(412).json({
            error: `ผู้เช่ายังกรอกข้อมูลไม่ครบ — ขาด: ${missing.map((k) => labels[k] || k).join(', ')}`,
            code: 'IDENTITY_INCOMPLETE',
            missing,
            hint: missing.some((m) => m.startsWith('citizenId'))
              ? 'อัปโหลดภาพบัตรที่ POST /api/tenants/:id/identity (ส่ง frontDataUrl + backDataUrl)'
              : 'กรอกที่อยู่ + ผู้ติดต่อฉุกเฉินที่ /api/tenants/:id (PUT) ก่อน',
          });
        }

        // Promote tenant to active + assign room.
        const tres = await client.query(
          `UPDATE tenants
              SET current_room_id=$1, status='active', updated_at=NOW()
            WHERE id=$2 AND deleted_at IS NULL
            RETURNING id, full_name, phone, email`,
          [roomId, id]
        );
        const tenant = tres.rows[0];

        // Flip room status in BOTH the legacy JSONB blob and the relational
        // rooms_v2 table. Without the dual-write, rooms created via the new
        // POST /api/rooms (which writes only to rooms_v2) stayed status=
        // 'vacant' forever after a tenant moved in — breaking
        // GET /api/rooms?status=occupied and the booking-approve flow's
        // "find a vacant room matching the request" logic.
        // Write tenant info INTO the blob's room.tenant alongside flipping
        // status. UPSERT pattern: the room may exist only in rooms_v2
        // (created via POST /api/rooms) and not in the JSONB blob — the
        // old `WHERE value ? $1` clause made the UPDATE a no-op in that
        // case, breaking scheduler.tickBillGen which iterates the blob.
        const blobTenant = {
          name: tenant.full_name || '',
          phone: tenant.phone || '',
          email: tenant.email || '',
          since: moveInDate,
        };
        await client.query(
          `INSERT INTO app_data (key, value, updated_by)
           VALUES ('baankarn_rooms_v1', '{}'::jsonb, 'system')
           ON CONFLICT (key) DO NOTHING`
        );
        await client.query(
          `UPDATE app_data
              SET value = value || jsonb_build_object(
                            $1::text,
                            COALESCE(value->$1, '{}'::jsonb)
                              || jsonb_build_object(
                                   'id', $1,
                                   'status', 'occupied',
                                   'tenant', $2::jsonb
                                 )
                          ),
                  updated_at=NOW()
            WHERE key='baankarn_rooms_v1'`,
          [roomId, JSON.stringify(blobTenant)]
        );
        try {
          await client.query(
            `UPDATE rooms_v2 SET status='occupied', updated_at=NOW()
               WHERE room_code=$1 AND deleted_at IS NULL`,
            [roomId]
          );
        } catch (err) {
          // Older deployments without rooms_v2 fall through silently.
          if (err.code !== '42P01') throw err;
        }

        // Create a contract row. Stamp the terms-version + agreed_at so
        // we have a legal trail for which T&C wording the tenant accepted.
        // Falls back gracefully on older deploys without those columns.
        const contractNo = `C-${new Date().getFullYear()}-${String(id).padStart(4, '0')}`;
        const termsVersion = agreedTermsVersion || tenancy.termsVersion || null;
        try {
          await client.query(
            `INSERT INTO contracts (contract_no, tenant_id, room_id, start_date, end_date,
                                    monthly_rent, deposit, status, term_months, discount_pct,
                                    agreed_terms_at, agreed_terms_version)
             VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, 'active', $8, $9,
                     CASE WHEN $10::text IS NOT NULL THEN NOW() ELSE NULL END, $10)
             ON CONFLICT (contract_no) DO NOTHING`,
            [contractNo, id, roomId, moveInDate, endDate,
             monthlyRent, depositAmount, termMonths || null, resolvedDiscountPct,
             termsVersion]
          );
        } catch (err) {
          if (err.code !== '42703') throw err;  // pre-migration deploy
          await client.query(
            `INSERT INTO contracts (contract_no, tenant_id, room_id, start_date, end_date,
                                    monthly_rent, deposit, status, term_months, discount_pct)
             VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, 'active', $8, $9)
             ON CONFLICT (contract_no) DO NOTHING`,
            [contractNo, id, roomId, moveInDate, endDate,
             monthlyRent, depositAmount, termMonths || null, resolvedDiscountPct]
          );
        }

        // Create welcome bill draft for the move-in period (NOT wallclock).
        // If a tenant moved in on Jan 31 but admin processes the checkin at
        // 00:05 Feb 1, using `new Date()` stamps the welcome bill as period
        // 2026-02 — wrong: tenant gets a Jan-period bill they never received,
        // and the Feb auto-bill uses the same room+period and either dups or
        // is blocked by uq_bills_room_period_active.
        //
        // If config.discounts.firstMonth is set, stack it on top of the
        // contract discount we just resolved (multiplicative — 10% + 5% =
        // 14.5%, not 15%, capped at 50%). This is what makes the
        // "first-month-X%-off" promotion in /admin#pricing actually fire.
        const moveInMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(moveInDate);
        const period = moveInMatch
          ? `${moveInMatch[1]}-${moveInMatch[2]}`
          : `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
        const billNo = billing.makeBillNo(roomId, period);
        // Build dueDate from the period (not wallclock) using the same
        // formatYMD path scheduler/bulk-generate use, so back-dated check-ins
        // produce a due date in the move-in month rather than the current
        // calendar month.
        const dueDay = 15;
        const dueDate = moveInMatch
          ? billing.formatYMD(Number(moveInMatch[1]), Number(moveInMatch[2]), dueDay)
          : billing.formatDueDate(dueDay);
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
          { roomId, depositAmount, monthlyRent, contractNo,
            forced: isForced, missingAtCheckin: missing });
        if (isForced) {
          // Surface forced bypasses to admin via owner notify so the
          // operator who clicked "force anyway" can be reviewed later.
          notifier.notifyOwner({ pool, features: flags }, {
            subject: '⚠️ checkin ใช้ force=true bypass safety guards',
            text: `tenantId=${id} room=${roomId} by=${req.session.user.username}\n`
              + `missing=${missing.join(',') || 'none'}\n`
              + `monthlyRent=${monthlyRent} deposit=${depositAmount}`,
          }).catch(() => {});
        }

        // Notify the new tenant about their welcome bill so they don't have
        // to log in to discover they owe money. Without this, tenants miss
        // the first-month due date because nobody told them a bill exists.
        // Fire-and-forget — never block the checkin response on a stuck
        // LINE/email server.
        try {
          const flags = await features.load(pool);
          // Resolve the tenant's bound LINE channel + email so notifyTenant
          // can pick the best channel. tenants returned by checkin only has
          // id/name/phone/email; pull line_user_id + line_oa_id separately.
          const tQ = await pool.query(
            `SELECT id, full_name, phone, email, line_user_id, line_oa_id, status
               FROM tenants WHERE id=$1 AND deleted_at IS NULL`,
            [id]
          );
          if (tQ.rows.length) {
            const amtStr = Number(welcomeRent).toLocaleString(
              'th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }
            );
            const discountNote = welcomeRent < Number(monthlyRent)
              ? `\n💸 รวมส่วนลด — ปกติ ฿${Number(monthlyRent).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`
              : '';
            notifier.notifyTenant({ pool, features: flags }, tQ.rows[0], {
              subject: `🏠 ยินดีต้อนรับ — บิลรอบแรกของคุณ`,
              text: [
                `ยินดีต้อนรับสู่ห้อง ${roomId}`,
                ``,
                `เลขที่บิล: ${billNo}`,
                `รอบบิล: ${period}`,
                `ค่าเช่าเดือนแรก: ฿${amtStr}${discountNote}`,
                `ครบกำหนดชำระ: ${dueDate}`,
                ``,
                `📋 ขั้นตอนถัดไป:`,
                `   1) ตั้ง PIN ครั้งแรกที่พอร์ทัลผู้เช่า /tenant`,
                `   2) ผูกบัญชี LINE OA (ถ้ายังไม่ผูก)`,
                `   3) ดูบิลทั้งหมด + ชำระผ่าน QR ที่พอร์ทัล`,
              ].join('\n'),
            }).catch((err) => {
              console.warn('[checkin] welcome notify failed:', err.message);
            });
          }
        } catch (err) {
          console.warn('[checkin] welcome notify outer error:', err.message);
        }

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
  // body: { reason?, finalDepositReturn?, generateClosingBill? }
  //
  // Atomic checkout: tenant moved_out + contract ended + room vacant +
  // active access cards revoked + deposit refund recorded on contract +
  // (optional) pro-rated closing bill for the days into the current period.
  // The previous version only audit-logged the refund (vanished from
  // reports), left cards active (moved-out tenant still had door access),
  // and never produced a closing bill.
  r.post('/:id/checkout', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    validateBody(schemas.checkOut),
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
      const reason = req.body.reason || null;
      const refund = req.body.finalDepositReturn != null ? Number(req.body.finalDepositReturn) : null;
      // Default true so admin doesn't have to opt-in for the common case.
      // Admin can pass generateClosingBill:false on the last-day-of-month
      // case where the regular monthly bill already covers the full period.
      const wantClosingBill = req.body.generateClosingBill !== false;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tres = await client.query(
          `SELECT id, full_name, current_room_id, line_user_id, line_oa_id, email, phone, status
             FROM tenants WHERE id=$1 AND deleted_at IS NULL`,
          [id]
        );
        if (!tres.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'tenant not found' });
        }
        const tenant = tres.rows[0];
        const oldRoom = tenant.current_room_id;

        // Mark tenant moved_out
        await client.query(
          `UPDATE tenants SET status='moved_out', current_room_id=NULL, updated_at=NOW(),
             notes = COALESCE(notes,'') || CASE WHEN $2::text IS NOT NULL THEN E'\n[checkout] ' || $2::text ELSE '' END
           WHERE id=$1`,
          [id, reason]
        );

        // Close active contract + persist refund amount on the row so it
        // appears in reports / aged-receivable views without joining audit_logs.
        const contractRes = await client.query(
          `UPDATE contracts SET status='ended', end_date=CURRENT_DATE,
              deposit_returned = $2,
              deposit_returned_at = CASE WHEN $2 IS NOT NULL THEN NOW() ELSE NULL END,
              deposit_return_reason = $3
             WHERE tenant_id=$1 AND status='active'
           RETURNING id, contract_no, start_date, monthly_rent, deposit, discount_pct`,
          [id, refund, reason]
        );
        const closedContract = contractRes.rows[0] || null;

        // Flip room status to vacant in BOTH JSONB blob and rooms_v2.
        if (oldRoom) {
          // Status='vacant' AND remove room.tenant so notifications can't
          // leak to the moved-out tenant on the next bill cycle (e.g.
          // bulk-send pulled from blob → SMS to old tenant). The `-`
          // operator drops the 'tenant' top-level key from the room object.
          await client.query(
            `UPDATE app_data
                SET value = jsonb_set(
                              value,
                              ARRAY[$1::text],
                              (value->$1 - 'tenant') || jsonb_build_object('status', 'vacant')
                            ),
                    updated_at=NOW()
              WHERE key='baankarn_rooms_v1' AND value ? $1`,
            [oldRoom]
          );
          try {
            await client.query(
              `UPDATE rooms_v2 SET status='vacant', updated_at=NOW()
                 WHERE room_code=$1 AND deleted_at IS NULL`,
              [oldRoom]
            );
          } catch (err) {
            if (err.code !== '42P01') throw err;
          }
        }

        // Auto-revoke any active access cards for this tenant. A moved-out
        // tenant retaining card access until the next overdue cycle was a
        // real security gap. Capture the tenant_ids touched so we can
        // notify after the transaction commits.
        const revokedCards = await client.query(
          `UPDATE access_cards
              SET status='revoked', revoked_at=NOW(), revoke_reason=$2
            WHERE tenant_id=$1 AND status='active'
            RETURNING id, card_id`,
          [id, 'auto:checkout']
        );

        // Auto-deactivate tenant-scoped recurring charges. Without this,
        // the scheduler / bulk-generate would keep billing the moved-out
        // tenant's per-tenant fees (parking, internet, locker) every
        // cycle. Room-scoped recurring charges (room_id set, tenant_id
        // null) stay active because they belong to the unit, not the
        // person — the next tenant inherits them.
        const deactivatedRecurring = await client.query(
          `UPDATE recurring_charges
              SET active=FALSE, updated_at=NOW(),
                  notes = COALESCE(notes,'') || E'\n[auto] deactivated on checkout at ' || NOW()::text
            WHERE tenant_id=$1 AND active=TRUE
            RETURNING id, label, frequency`,
          [id]
        ).catch((err) => {
          if (err.code === '42P01') return { rowCount: 0, rows: [] };
          throw err;
        });

        // Pro-rate closing bill: rent × (days_lived_this_period / days_in_month).
        // Only generate when there's no monthly bill already covering this
        // period — the partial-unique index uq_bills_room_period_active
        // would block a duplicate anyway, but we want a clean result not
        // a 23505 error.
        let closingBill = null;
        if (wantClosingBill && oldRoom && closedContract) {
          // Asia/Bangkok local-time components — checkout at 00:30 ICT
          // (UTC 17:30 prev day) on a UTC-deployed Railway server would
          // otherwise read the previous day, off-by-one'ing pro-rate +
          // potentially picking the wrong period at month boundaries.
          // The same pattern as bills (Asia/Bangkok offset +07:00 baked in).
          const utc = new Date();
          const bkk = new Date(utc.getTime() + 7 * 3600 * 1000);
          const ty = bkk.getUTCFullYear();
          const tm = bkk.getUTCMonth() + 1;
          const td = bkk.getUTCDate();
          const period = `${ty}-${String(tm).padStart(2, '0')}`;
          // Skip if a bill already exists for this room+period (active).
          const dup = await client.query(
            `SELECT id FROM bills
               WHERE room_id=$1 AND period=$2 AND deleted_at IS NULL AND status<>'void'
               LIMIT 1`,
            [oldRoom, period]
          );
          if (!dup.rows.length) {
            // daysInMonth: day 0 of next month is the last day of this month.
            // Use UTC math against the Bangkok-shifted date so DST/local-zone
            // edge cases stay consistent with bills.
            const daysInMonth = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
            const daysLived = td;   // 1..daysInMonth (Bangkok day-of-month)
            const fraction = Math.min(1, Math.max(0, daysLived / daysInMonth));
            const baseRent = Number(closedContract.monthly_rent) || 0;
            const discount = Number(closedContract.discount_pct) || 0;
            const proRatedRent = Math.round(
              baseRent * fraction * (1 - discount / 100) * 100
            ) / 100;
            const billNo = billing.makeBillNo(oldRoom, period) + '-X';
            const dueDate = billing.formatYMD(ty, tm, Math.min(daysInMonth, daysLived + 7));
            try {
              const ins = await client.query(
                `INSERT INTO bills
                   (bill_no, tenant_id, room_id, period, rent, subtotal, total, due_date, status,
                    other)
                 VALUES ($1,$2,$3,$4,$5,$5,$5,$6,'pending',$7::jsonb)
                 ON CONFLICT (bill_no) DO NOTHING
                 RETURNING id, bill_no, total, due_date`,
                [billNo, id, oldRoom, period, proRatedRent, dueDate,
                 JSON.stringify([{ label: 'pro-rate', amount: proRatedRent, daysLived, daysInMonth }])]
              );
              closingBill = ins.rows[0] || null;
            } catch (err) {
              if (err.code !== '23505') throw err;
              // Race against partial-unique — fine, just skip.
            }
          }
        }

        await client.query('COMMIT');
        audit(req, 'tenant.checkout', 'tenant', String(id),
          { oldRoom, reason, refund,
            cardsRevoked: revokedCards.rows.map((c) => c.card_id),
            recurringDeactivated: deactivatedRecurring.rows.map((r) => r.label),
            closingBill: closingBill ? closingBill.bill_no : null });

        // Fire-and-forget notify so the tenant knows their access has been
        // revoked + the closing bill (if any) is waiting.
        try {
          const flags = await features.load(pool);
          const lines = [
            `เรียน คุณ${tenant.full_name}`,
            ``,
            `ระบบยืนยันการ check-out เรียบร้อยแล้ว`,
          ];
          if (oldRoom) lines.push(`ห้อง: ${oldRoom}`);
          if (revokedCards.rowCount > 0) {
            lines.push(`บัตรเข้า-ออกถูกเพิกถอน (${revokedCards.rowCount} ใบ)`);
          }
          if (refund != null && Number.isFinite(refund)) {
            lines.push(`คืนเงินมัดจำ: ฿${Number(refund).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`);
          }
          if (closingBill) {
            lines.push(``);
            lines.push(`📋 บิลปิดบัญชี: ${closingBill.bill_no}`);
            lines.push(`ยอด: ฿${Number(closingBill.total).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`);
            lines.push(`ครบกำหนด: ${closingBill.due_date}`);
          }
          lines.push(``);
          lines.push(`ขอบคุณที่ใช้บริการ`);
          // force=true so the message reaches the just-moved-out tenant
          // (notifyTenant otherwise refuses to send to status<>'active').
          notifier.notifyTenant({ pool, features: flags },
            { id: tenant.id, full_name: tenant.full_name, phone: tenant.phone, email: tenant.email,
              line_user_id: tenant.line_user_id, line_oa_id: tenant.line_oa_id, status: 'active' },
            { subject: 'ยืนยันการ check-out', text: lines.join('\n'), force: true }
          ).catch(() => {});
        } catch { /* notify failures don't fail request */ }

        res.json({
          ok: true, tenantId: id, oldRoom, refund,
          cardsRevoked: revokedCards.rowCount,
          closingBill,
        });
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
