// routes/tenant-ops.js
// Every /api/tenants/* endpoint lives here. The Wave 1 refactor moved
// /api/bills extras + reports out of server.js; this round consolidates
// the tenants surface so the CRUD, history, identity, citizen-id lookup,
// notify, checkin, and checkout endpoints all sit in one file.
//
// Endpoints (mounted at /api/tenants in routes/index.js):
//   - POST   /notify                       — send admin-composed message to tenant
//   - GET    /                             — list tenants (filters: q, status)
//   - GET    /:id(\d+)                     — read tenant by id (admin)
//   - GET    /lookup-by-citizen-id         — pre-create dedup lookup
//   - GET    /:id/history                  — full audit/history view
//   - POST   /                             — create tenant (admin)
//   - PUT    /:id                          — update tenant fields
//   - DELETE /:id                          — soft (or hard) delete
//   - POST   /:id/identity                 — upload citizen-ID images + encrypted #
//   - GET    /:id/identity                 — read identity image links
//   - POST   /:id/checkin                  — atomic check-in (legacy from this file)
//   - POST   /:id/checkout                 — atomic check-out (legacy from this file)
//
// Specific routes (/notify, /lookup-by-citizen-id) are registered BEFORE
// /:id(\d+) so Express's router doesn't swallow them as ids. The numeric
// constraint on :id ensures /lookup-by-citizen-id can't match the catch-all
// either (test integration.test.js#4128 enforces both invariants).

const express = require('express');
const { schemas } = require('../schemas');
const { validateBody } = require('../middleware/validate');
const billing = require('../services/billing');
const billPayments = require('../services/billPayments');
const features = require('../services/features');
const pricing = require('../services/pricing');
const notifier = require('../services/notifier');
const cryptoSvc = require('../services/crypto');
const lineNotify = require('../services/line');
const lineBinding = require('../services/lineBinding');
const storage = require('../services/storage');
const { isVacantStatus } = require('../services/roomSync');
const meter = require('../services/meter');

// === Internal helpers =====================================================
// VALID_TENANT_STATUS + maskTenantOut were defined in server.js but used
// only by tenant endpoints — moved here so the file is self-contained.
const VALID_TENANT_STATUS = new Set(['active', 'moved_out', 'blacklist']);
const ACTIVE_ROOM_CONSTRAINT = 'uq_tenants_active_room';
const CARRIED_LATE_FEE_LABEL_PREFIX = billPayments._carriedLateFeeLabelPrefix
  || 'ค่าปรับล่าช้าค้างจากรอบ ';
const CARRIED_LATE_FEE_NOTE_MARKER = billPayments._carriedLateFeeNoteMarker
  || '[system:late_fee_carry]';

function isActiveRoomUniqueViolation(err) {
  return err && err.code === '23505' && err.constraint === ACTIVE_ROOM_CONSTRAINT;
}

function maskTenantOut(t) {
  if (!t) return t;
  const out = { ...t };
  if (out.citizen_id_encrypted) {
    delete out.citizen_id_encrypted;
    out.citizen_id_masked = out.citizen_id_tail ? `***-${out.citizen_id_tail}` : '***';
  }
  delete out.pin_hash;
  return out;
}

function addContractMonths(startYmd, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(startYmd || ''));
  const n = Number(months);
  if (!m || !Number.isInteger(n) || n < 1) return null;
  const sy = Number(m[1]);
  const sm = Number(m[2]);
  const sd = Number(m[3]);
  const totalMonths = (sy * 12 + (sm - 1)) + n;
  const ey = Math.floor(totalMonths / 12);
  const em = (totalMonths % 12) + 1;
  const lastDom = new Date(Date.UTC(ey, em, 0)).getUTCDate();
  const ed = Math.min(sd, lastDom);
  return `${ey}-${String(em).padStart(2, '0')}-${String(ed).padStart(2, '0')}`;
}

function estimateContractMonths(startYmd, endYmd, maxMonths = 60) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startYmd || ''))
      || !/^\d{4}-\d{2}-\d{2}$/.test(String(endYmd || ''))
      || String(endYmd) < String(startYmd)) {
    return null;
  }
  const max = Math.max(1, Math.min(120, Number(maxMonths) || 60));
  for (let i = 1; i <= max; i += 1) {
    if (addContractMonths(startYmd, i) === endYmd) return i;
  }
  return null;
}

module.exports = function buildTenantOpsRouter(ctx) {
  const { pool, requireAuth, requireRole, sameOrigin, csrfGuard, audit, signBillPayToken } = ctx;
  const r = express.Router();

  // === POST /api/tenants/notify ===========================================
  // Admin-composed message to a tenant by phone OR roomId. Used by the
  // admin UI's "ส่งข้อความ" button. Picks the best channel via notifier
  // (LINE → email fallback). 409 NO_TENANT_CHANNEL surfaces when no
  // reachable channel exists so admin sees a clear error instead of a
  // silent drop.
  r.post('/notify', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager', 'staff'), async (req, res) => {
    const b = req.body || {};
    const phone = String(b.phone || '').replace(/[\s-]/g, '').slice(0, 32);
    const roomId = String(b.roomId || '').slice(0, 32).trim();
    const message = String(b.message || '').trim().slice(0, 1000);
    if (!message || message.length < 2) {
      return res.status(400).json({ error: 'message required', code: 'MESSAGE_REQUIRED' });
    }
    if (!phone && !roomId) {
      return res.status(400).json({ error: 'phone or roomId required', code: 'TENANT_TARGET_REQUIRED' });
    }
    try {
      const params = [];
      const where = [`deleted_at IS NULL`, `status='active'`];
      if (phone) { params.push(phone); where.push(`phone=$${params.length}`); }
      if (roomId) { params.push(roomId); where.push(`current_room_id=$${params.length}`); }
      const { rows } = await pool.query(
        `SELECT id, full_name, phone, email, line_user_id, line_oa_id,
                current_room_id, status
           FROM tenants
          WHERE ${where.join(' AND ')}
          ORDER BY updated_at DESC
          LIMIT 1`,
        params
      );
      if (!rows.length) {
        return res.status(404).json({
          error: 'active tenant not found for this room/phone',
          code: 'TENANT_NOT_FOUND',
        });
      }
      const tenant = rows[0];
      const flags = await features.load(pool);
      const subject = String(b.subject || 'ข้อความจากหอพัก').slice(0, 200);
      const text = [
        subject,
        `ผู้เช่า: ${tenant.full_name || '-'}`,
        tenant.current_room_id ? `ห้อง: ${tenant.current_room_id}` : null,
        '',
        message,
      ].filter((x) => x !== null).join('\n');
      const out = await notifier.notifyTenant({ pool, features: flags }, tenant, {
        subject,
        text,
      });
      audit(req, 'tenant.notify', 'tenant', String(tenant.id), {
        roomId: tenant.current_room_id,
        channel: out.channel,
        ok: out.ok,
        queued: !!out.queued,
      });
      if (!out.ok && !out.queued) {
        return res.status(409).json({
          error: 'tenant has no reachable notification channel',
          code: 'NO_TENANT_CHANNEL',
          channel: out.channel,
          reason: out.reason || null,
        });
      }
      return res.json({
        ok: true,
        tenantId: tenant.id,
        channel: out.channel,
        queued: !!out.queued,
      });
    } catch (err) {
      console.error('tenant notify error:', err.message);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // === GET /api/tenants ===================================================
  // List tenants (admin). Filters: q (substring on name/phone/email),
  // status (active/moved_out/blacklist). Soft-deleted rows excluded.
  r.get('/', requireAuth, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase();
      const status = req.query.status;
      const params = [];
      const where = ['t.deleted_at IS NULL'];
      if (status && VALID_TENANT_STATUS.has(String(status))) {
        params.push(status); where.push(`t.status = $${params.length}`);
      }
      if (q) {
        params.push(`%${q}%`);
        where.push(`(
          LOWER(t.full_name) LIKE $${params.length}
          OR t.phone LIKE $${params.length}
          OR LOWER(COALESCE(t.email,'')) LIKE $${params.length}
          OR LOWER(COALESCE(lc.room_id,'')) LIKE $${params.length}
          OR LOWER(COALESCE(lc.contract_no,'')) LIKE $${params.length}
        )`);
      }
      const { rows } = await pool.query(
        `SELECT t.id, t.full_name, t.phone, t.email, t.line_user_id,
                t.current_room_id, t.status, t.citizen_id_tail, t.locale,
                t.created_at, t.updated_at,
                lc.room_id AS last_room_id,
                lc.contract_no AS last_contract_no,
                lc.start_date AS last_contract_start_date,
                lc.end_date AS last_contract_end_date,
                lc.status AS last_contract_status,
                lc.monthly_rent AS last_monthly_rent,
                COALESCE(ledger.outstanding_count, 0) AS outstanding_count,
                COALESCE(ledger.outstanding_total, 0) AS outstanding_total
           FROM tenants t
           LEFT JOIN LATERAL (
             SELECT c.room_id, c.contract_no, c.start_date, c.end_date,
                    c.status, c.monthly_rent, c.created_at
               FROM contracts c
              WHERE c.tenant_id = t.id
                AND c.deleted_at IS NULL
              ORDER BY
                CASE c.status WHEN 'active' THEN 0 WHEN 'expired' THEN 1 ELSE 2 END,
                c.start_date DESC NULLS LAST,
                c.created_at DESC
              LIMIT 1
           ) lc ON TRUE
           LEFT JOIN LATERAL (
             SELECT COUNT(*)::int AS outstanding_count,
                    COALESCE(SUM(b.total), 0)::numeric AS outstanding_total
               FROM bills b
              WHERE b.tenant_id = t.id
                AND b.deleted_at IS NULL
                AND b.status IN ('pending','overdue')
           ) ledger ON TRUE
           WHERE ${where.join(' AND ')}
           ORDER BY t.created_at DESC LIMIT 500`,
        params
      );
      res.json({ ok: true, tenants: rows });
    } catch (err) {
      console.error('tenants list error:', err);
      res.status(500).json({
        error: 'โหลดรายชื่อผู้เช่าไม่สำเร็จ',
        code: 'DB_ERROR',
        hint: 'ตรวจการเชื่อมต่อฐานข้อมูลและตาราง tenants/contracts/bills แล้วลองรีเฟรชหน้าแอดมินอีกครั้ง',
      });
    }
  });

  // === GET /api/tenants/lookup-by-citizen-id ==============================
  // Admin types a 13-digit citizen ID before creating a new tenant. We hash
  // it the same way as on tenant create + return any existing record
  // matching the hash — even moved_out / blacklist tenants. Use case: a
  // person who lived here last year wants to re-rent a room. Without this
  // lookup admin would create a duplicate row and the partial unique index
  // would block them; with it, admin sees the prior record + can reactivate.
  //
  // Owner / manager only — citizen ID is sensitive even at a hash level.
  // MUST be registered BEFORE /:id(\d+) so the param route doesn't swallow
  // it — the numeric \d+ constraint also blocks the collision, but ordering
  // is the belt + braces.
  r.get('/lookup-by-citizen-id', requireAuth, requireRole('owner', 'manager'),
    async (req, res) => {
      const raw = String(req.query.citizenId || '').trim();
      if (!raw) return res.status(400).json({ error: 'citizenId required' });
      const thaiId = require('../services/thaiId');
      const norm = thaiId.normalize(raw);
      if (!norm) return res.status(400).json({ error: 'เลขบัตรประชาชนต้องเป็น 13 หลัก', code: 'INVALID_CITIZEN_ID' });
      if (!thaiId.validateChecksum(norm)) {
        // Don't 400 here — admin might be looking up a legacy record that
        // failed the checksum at creation. Surface a hint instead.
        console.warn('[lookup] caller queried with checksum-invalid ID');
      }
      const hash = thaiId.hashForLookup(norm);
      if (!hash) return res.status(400).json({ error: 'cannot hash input' });
      try {
        // Match by hash AND by tail — if the operator's deploy predates the
        // hash rollout, prior tenants may have only a tail saved. Tail-only
        // match is widened on purpose so admin still sees a hit (with a
        // confidence flag the UI can show).
        const byHash = await pool.query(
          `SELECT id, full_name, phone, status, current_room_id,
                  citizen_id_tail, created_at, updated_at, deleted_at
             FROM tenants
            WHERE citizen_id_hash=$1
            ORDER BY (status='active') DESC, updated_at DESC LIMIT 5`,
          [hash]
        ).catch((err) => {
          if (err.code === '42703') return { rows: [] };  // pre-migration
          throw err;
        });
        const byTail = await pool.query(
          `SELECT id, full_name, phone, status, current_room_id,
                  citizen_id_tail, created_at, updated_at, deleted_at
             FROM tenants
            WHERE citizen_id_tail=$1 AND deleted_at IS NULL
              AND id NOT IN (
                SELECT id FROM tenants WHERE citizen_id_hash=$2
              )
            ORDER BY (status='active') DESC, updated_at DESC LIMIT 5`,
          [norm.slice(-4), hash]
        ).catch(() => ({ rows: [] }));
        audit(req, 'tenant.citizen_lookup', 'tenant', null,
          { tail: norm.slice(-4), hashHits: byHash.rows.length, tailHits: byTail.rows.length });
        res.json({
          ok: true,
          // High-confidence: hash matches.
          matchedByHash: byHash.rows.map((row) => ({ ...row, matchType: 'hash' })),
          // Lower-confidence: tail matches (legacy data without hash).
          matchedByTailOnly: byTail.rows.map((row) => ({ ...row, matchType: 'tail-only' })),
          checksumValid: thaiId.validateChecksum(norm),
        });
      } catch (err) {
        console.error('citizen lookup error:', err);
        res.status(500).json({ error: 'internal error' });
      }
    });

  // === GET /api/tenants/:id(\d+) ==========================================
  // Admin tenant detail. Numeric :id constraint prevents this catching the
  // sibling /lookup-by-citizen-id (and any future /<word> route). Decrypts
  // the citizen ID only when query includeCitizen=1 AND the caller is
  // owner/manager (sibling endpoint /api/tenants/lookup-by-citizen-id is
  // already owner/manager — this gate matches that surface).
  r.get('/:id(\\d+)', requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    try {
      // Pull every tenant column the admin UI needs in one round-trip,
      // including the new identity / address / emergency contact fields.
      // Older deploys without those columns get a SELECT * fallback so the
      // endpoint keeps working mid-migration.
      let rows;
      try {
        ({ rows } = await pool.query(
          `SELECT id, full_name, phone, email, line_user_id, line_oa_id,
                  current_room_id, status,
                  citizen_id_encrypted, citizen_id_tail, citizen_id_hash,
                  citizen_id_image_front_id, citizen_id_image_back_id,
                  address, emergency_contact_name, emergency_contact_phone,
                  emergency_contact_relation,
                  notes, locale, blacklist_reason,
                  created_at, updated_at
             FROM tenants WHERE id=$1 AND deleted_at IS NULL`,
          [id]
        ));
      } catch (err) {
        if (err.code !== '42703') throw err;  // pre-migration deploy
        ({ rows } = await pool.query(
          `SELECT id, full_name, phone, email, line_user_id, current_room_id, status,
                  citizen_id_encrypted, citizen_id_tail, notes, locale, blacklist_reason,
                  created_at, updated_at
             FROM tenants WHERE id=$1 AND deleted_at IS NULL`,
          [id]
        ));
      }
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      const flags = await features.load(pool);
      const out = maskTenantOut(rows[0]);
      // Don't echo the hash either — it's internal dedup state.
      delete out.citizen_id_hash;
      // Decrypt for admin if encryption is on AND the request asks.
      // Role-gated: only owner/manager can pull the cleartext citizen ID,
      // because the route itself is requireAuth (so staff + readonly can
      // browse tenant cards) — but the sibling identity endpoint at
      // /api/tenants/lookup-by-citizen-id already requires owner/manager,
      // and this decryption path was missed. ROLE_RANK: manager=3, owner=4.
      if (req.query.includeCitizen === '1') {
        const role = req.session.user && req.session.user.role;
        const rank = ({ owner: 4, manager: 3, staff: 2, readonly: 1 })[role] || 0;
        if (rank < 3) {
          return res.status(403).json({
            error: 'forbidden — citizen ID requires owner or manager role',
            code: 'FORBIDDEN_CITIZEN_ID',
          });
        }
        if (rows[0].citizen_id_encrypted) {
          const encOn = !!(flags.citizenIdEncryption && flags.citizenIdEncryption.enabled);
          const raw = String(rows[0].citizen_id_encrypted);
          if (encOn) {
            try {
              out.citizen_id = cryptoSvc.decryptString(raw);
            } catch (_e) {
              // Not valid ciphertext under the current key — most commonly a row
              // written while encryption was OFF (plaintext), or a key change.
              // Show it only if it is actually a 13-digit ID; never echo raw
              // ciphertext as the "citizen id".
              out.citizen_id = /^\d{13}$/.test(raw) ? raw : null;
            }
          } else {
            // Encryption disabled → the column stores plaintext. Return it when
            // it is a real 13-digit ID (don't echo leftover ciphertext from a
            // prior encrypted-mode row). Previously this whole branch was missing,
            // so reveal silently returned nothing whenever encryption was off.
            out.citizen_id = /^\d{13}$/.test(raw) ? raw : null;
          }
          // Audit every successful full-citizen-ID reveal regardless of storage
          // mode — pulling cleartext national-ID PII must leave a forensic trail,
          // mirroring the weaker tail-only lookup audit (tenant.citizen_lookup).
          if (out.citizen_id != null) {
            audit(req, 'tenant.citizen_reveal', 'tenant', String(rows[0].id),
              { by: req.session?.user?.username });
          }
        }
      }
      res.json({ ok: true, tenant: out });
    } catch (err) {
      console.error('tenant get error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // === GET /api/tenants/:id/history =======================================
  // One-stop view of every record tied to a tenant — works on active OR
  // moved-out tenants. Used by the admin "history" tab so legal / audit
  // queries don't have to fan out to multiple endpoints.
  //
  // Returns: tenant row + all contracts + all bills + all payments +
  // maintenance tickets + access cards + identity images + recent audit
  // log entries. Soft-deleted rows are EXCLUDED so accidentally-removed
  // data doesn't leak — admin can still inspect via the audit log.
  r.get('/:id/history', requireAuth, requireRole('owner', 'manager'),
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
      try {
        // Allow even soft-deleted tenants here so admin can audit a deleted
        // record. The masking still hides citizen_id_encrypted and any legacy
        // credential hash columns that may exist on older deployments.
        const tQ = await pool.query(
          `SELECT * FROM tenants WHERE id=$1`,
          [id]
        );
        if (!tQ.rows.length) return res.status(404).json({ error: 'tenant not found' });
        const tenant = maskTenantOut(tQ.rows[0]);
        delete tenant.citizen_id_hash;

        // Contracts (active + ended + expired). Ordered by most recent so
        // the current contract is first. Soft-deleted excluded.
        const contracts = await pool.query(
          `SELECT id, contract_no, room_id, start_date, end_date, term_months,
                  monthly_rent, deposit, deposit_returned, deposit_returned_at,
                  deposit_return_reason, discount_pct, status, signed_at,
                  signature_image_id, agreed_terms_at, agreed_terms_version,
                  created_at
             FROM contracts
            WHERE tenant_id=$1 AND deleted_at IS NULL
            ORDER BY start_date DESC, created_at DESC`,
          [id]
        ).catch(async (err) => {
          if (err.code !== '42703') throw err;
          // Pre-migration fallback
          return await pool.query(
            `SELECT id, contract_no, room_id, start_date, end_date,
                    monthly_rent, deposit, status, signed_at, created_at
               FROM contracts WHERE tenant_id=$1 AND deleted_at IS NULL
               ORDER BY start_date DESC, created_at DESC`,
            [id]
          );
        });

        // Bills (every status, soft-deleted excluded). Latest first.
        const bills = await pool.query(
          `SELECT id, bill_no, tenant_id,
                  $2::text AS bill_tenant_name,
                  $3::text AS bill_tenant_phone,
                  $4::text AS bill_tenant_status,
                  room_id, period, total, due_date, paid_at, status,
                  rent, water_amount, elec_amount, wifi, late_fee, vat,
                  created_at
             FROM bills
            WHERE tenant_id=$1 AND deleted_at IS NULL
            ORDER BY created_at DESC LIMIT 200`,
          [id, tQ.rows[0].full_name || '', tQ.rows[0].phone || '', tQ.rows[0].status || '']
        );

        // Payments (joined to bill_no for display).
        const payments = await pool.query(
          `SELECT p.id, p.bill_id, b.bill_no, p.amount, p.method, p.ref,
                  p.status, p.verified_by, p.verified_at, p.verify_provider,
                  p.created_at
             FROM payments p
             LEFT JOIN bills b ON b.id = p.bill_id
            WHERE p.tenant_id=$1
            ORDER BY p.created_at DESC LIMIT 200`,
          [id]
        );

        // Maintenance tickets — owned by this tenant (tenant_id stamped at
        // create time, or matched via phone for legacy public submissions).
        const tickets = await pool.query(
          `SELECT id, ticket_no, room_id, category, priority, status, title,
                  rating, rating_comment, created_at, completed_at
             FROM maintenance_tickets
            WHERE tenant_id=$1
            ORDER BY created_at DESC LIMIT 100`,
          [id]
        );

        // Access cards (active + revoked, gives a complete history).
        const cards = await pool.query(
          `SELECT id, card_id, room_id, status, issued_at, revoked_at, revoke_reason
             FROM access_cards
            WHERE tenant_id=$1
            ORDER BY issued_at DESC`,
          [id]
        );

        // Identity images URL (front+back) — same shape as /identity GET.
        const identity = await pool.query(
          `SELECT t.citizen_id_tail,
                  t.citizen_id_image_front_id, t.citizen_id_image_back_id,
                  ff.url AS front_url, bf.url AS back_url,
                  ff.uploaded_at AS front_uploaded_at, bf.uploaded_at AS back_uploaded_at
             FROM tenants t
             LEFT JOIN file_uploads ff ON ff.id = t.citizen_id_image_front_id
             LEFT JOIN file_uploads bf ON bf.id = t.citizen_id_image_back_id
            WHERE t.id=$1`,
          [id]
        ).catch((err) => {
          if (err.code === '42703') return { rows: [{ citizen_id_tail: tenant.citizen_id_tail }] };
          throw err;
        });

        // Recent audit log entries that mention this tenant. Last 100 events.
        // (Local variable renamed `auditEntries` to avoid shadowing the outer
        // `audit(...)` helper which is in scope here.)
        const auditEntries = await pool.query(
          `SELECT id, user_id, action, entity_type, entity_id, detail, created_at
             FROM audit_logs
            WHERE (entity_type='tenant' AND entity_id=$1)
               OR (action LIKE 'tenant.%' AND entity_id=$1)
               OR (action LIKE 'contract.%' AND entity_id IN (
                   SELECT id::text FROM contracts WHERE tenant_id=$2 AND deleted_at IS NULL
                 ))
               OR (action LIKE 'bill.%' AND entity_id IN (
                   SELECT id::text FROM bills WHERE tenant_id=$2 AND deleted_at IS NULL
                 ))
            ORDER BY created_at DESC LIMIT 100`,
          [String(id), id]
        );

        // Aggregate totals so admin sees the bottom line at a glance.
        const totals = {
          contracts: contracts.rows.length,
          bills: bills.rows.length,
          billsPaid: bills.rows.filter((b) => b.status === 'paid').length,
          billsOutstanding: bills.rows
            .filter((b) => b.status === 'pending' || b.status === 'overdue')
            .reduce((s, b) => s + Number(b.total || 0), 0),
          payments: payments.rows.length,
          paymentsTotal: payments.rows
            .filter((p) => p.status === 'verified')
            .reduce((s, p) => s + Number(p.amount || 0), 0),
          tickets: tickets.rows.length,
          ticketsOpen: tickets.rows.filter((t) => t.status !== 'completed' && t.status !== 'cancelled').length,
          accessCardsActive: cards.rows.filter((c) => c.status === 'active').length,
          accessCardsRevoked: cards.rows.filter((c) => c.status === 'revoked').length,
        };

        res.json({
          ok: true,
          tenant,
          identity: identity.rows[0] || {},
          contracts: contracts.rows,
          bills: bills.rows,
          payments: payments.rows,
          tickets: tickets.rows,
          accessCards: cards.rows,
          auditLog: auditEntries.rows,
          totals,
        });
      } catch (err) {
        console.error('tenant history error:', err);
        res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
      }
    });

  // === POST /api/tenants ==================================================
  // Admin creates a new tenant row. When roomId is supplied the row is
  // atomically also linked to that room (claimRoomForTenant runs an
  // advisory lock + SELECT FOR UPDATE against other active rows for the
  // room). Citizen-ID handling: optional but when present must pass the
  // mod-11 checksum, with a force=true escape hatch for legacy data.
  r.post('/', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'), async (req, res) => {
    const b = req.body || {};
    const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
    const fullName = str(b.fullName, 200).trim();
    // Normalise phone the same way schemas.phoneStr does (strip dashes +
    // spaces) so admin-entered "081-234-5678" matches the tenant-typed
    // "0812345678" at login. Three-way drift between admin-create (raw),
    // schemas.phoneStr (stripped), and tenant-login (raw) was the root
    // cause of "tenant can't log in even though admin created the row".
    const rawPhone = str(b.phone, 32).trim();
    const phone = rawPhone.replace(/[\s-]/g, '');
    if (!fullName || !phone) {
      return res.status(400).json({ error: 'fullName and phone required' });
    }
    // Reject obvious junk after normalisation so we don't store "abcdef" as a
    // phone number (matches the schemas.phoneStr regex shape).
    if (!/^[\d+]{8,20}$/.test(phone)) {
      return res.status(400).json({ error: 'เบอร์โทรไม่ถูกต้อง', code: 'INVALID_PHONE' });
    }
    const flags = await features.load(pool);
    const thaiId = require('../services/thaiId');
    // Normalise + validate Thai citizen ID. The mod-11 checksum catches typo
    // errors at create-time so admin doesn't end up with a row that can never
    // match anyone (and that the dedup index can't compare against). When
    // checksum fails AND the operator passes `force: true` we accept the
    // value but skip the hash (no dedup possible) — this preserves the
    // legacy edge case where existing data was entered without a check
    // digit but is otherwise meaningful.
    const citizenIdNorm = thaiId.normalize(str(b.citizenId, 32));
    let citizenEnc = null, citizenTail = null, citizenHash = null;
    if (b.citizenId && !citizenIdNorm) {
      return res.status(400).json({
        error: 'เลขบัตรประชาชนต้องเป็น 13 หลัก (ใส่ขีดได้)',
        code: 'INVALID_CITIZEN_ID',
      });
    }
    if (citizenIdNorm) {
      if (!thaiId.validateChecksum(citizenIdNorm) && b.force !== true) {
        return res.status(400).json({
          error: 'เลขบัตรประชาชนไม่ผ่านการตรวจสอบ check digit (mod-11)',
          code: 'INVALID_CHECKSUM',
          hint: 'ตรวจดูเลขที่ป้อนอีกครั้ง หรือส่ง { force: true } ถ้ายืนยัน (audit-logged)',
        });
      }
      citizenTail = citizenIdNorm.slice(-4);
      citizenHash = thaiId.validateChecksum(citizenIdNorm)
        ? thaiId.hashForLookup(citizenIdNorm)
        : null;  // skip hash if checksum failed but force=true (no dedup)
      if (flags.citizenIdEncryption && flags.citizenIdEncryption.enabled) {
        try { citizenEnc = cryptoSvc.encryptString(citizenIdNorm); }
        catch (e) {
          return res.status(500).json({ error: 'crypto unavailable: ' + e.message });
        }
      } else {
        citizenEnc = citizenIdNorm; // plaintext — not recommended
      }
    }
    // Pre-flight dedup check. Two cohorts to look at:
    //   1. citizen_id_hash matches (high confidence) — the partial unique
    //      index catches this at INSERT time too, but a 409 with the prior
    //      tenant's id is more actionable than a generic 23505.
    //   2. citizen_id_tail matches BUT hash is NULL on the prior row. This
    //      catches the dedup escape where tenant A was created with a
    //      checksum-invalid id + force=true (we set hash=NULL there to
    //      preserve the legacy data path), and tenant B comes along with a
    //      valid id whose tail matches A. Without this check, B would slip
    //      past pre-flight + the partial unique because A's hash is NULL.
    if (citizenIdNorm && b.force !== true) {
      try {
        let dup = null;
        if (citizenHash) {
          const dr = await pool.query(
            `SELECT id, full_name, status FROM tenants
               WHERE citizen_id_hash=$1 AND deleted_at IS NULL AND status='active' LIMIT 1`,
            [citizenHash]
          );
          dup = dr.rows[0] || null;
        }
        if (!dup) {
          const dr = await pool.query(
            `SELECT id, full_name, status FROM tenants
               WHERE citizen_id_tail=$1 AND deleted_at IS NULL AND status='active' LIMIT 1`,
            [citizenTail]
          );
          dup = dr.rows[0] || null;
        }
        if (dup) {
          return res.status(409).json({
            error: 'เลขบัตรนี้ถูกบันทึกในระบบแล้วกับผู้เช่ารายอื่น',
            code: 'CITIZEN_ID_DUPLICATE',
            conflict: dup,
            hint: 'ส่ง { force: true } ถ้ายืนยันว่าเป็นคนเดิม (audit-logged)',
          });
        }
      } catch (err) {
        // Older deploys without the column fall through silently.
        if (err.code !== '42703') console.warn('[tenant create] dedup check skipped:', err.message);
      }
    }
    // Optional address + emergency contact (admin can leave blank — the
    // checkin endpoint enforces presence when generating contracts).
    const address = str(b.address, 500) || null;
    const ecName    = str(b.emergencyContactName, 200) || null;
    const ecPhone   = str(b.emergencyContactPhone, 32) || null;
    const ecRel     = str(b.emergencyContactRelation, 64) || null;
    // Normalise emergency phone the same way as primary phone.
    const ecPhoneNorm = ecPhone ? ecPhone.trim().replace(/[\s-]/g, '') : null;
    if (ecPhoneNorm && !/^[\d+]{8,20}$/.test(ecPhoneNorm)) {
      return res.status(400).json({
        error: 'เบอร์โทรผู้ติดต่อฉุกเฉินไม่ถูกต้อง',
        code: 'INVALID_EMERGENCY_PHONE',
      });
    }
    const lineUserId = str(b.lineUserId, 64).trim() || null;
    if (lineUserId && !lineNotify.isLikelyUserId(lineUserId)) {
      return res.status(400).json({
        error: 'invalid LINE userId',
        code: 'INVALID_LINE_USER_ID',
      });
    }
    const requestedRoomId = str(b.roomId, 32).trim() || null;
    const tenantStatus = requestedRoomId
      ? 'active'
      : (VALID_TENANT_STATUS.has(b.status) ? b.status : 'active');
    const roomLockKey = (rid) => {
      let h = 0x811c9dc5;
      const s = String(rid || '');
      for (let j = 0; j < s.length; j++) {
        h ^= s.charCodeAt(j);
        h = Math.imul(h, 0x01000193);
      }
      return (h >>> 0) & 0x7fffffff;
    };
    const httpErr = (status, code, error, extra = {}) =>
      Object.assign(new Error(error), { httpStatus: status, publicCode: code, publicError: error, extra });

    async function insertTenantRow(db, useSavepoint = false) {
      if (useSavepoint) {
        await db.query('SAVEPOINT tenant_insert_schema');
      }
      try {
        const { rows } = await db.query(
          `INSERT INTO tenants
            (full_name, phone, citizen_id_encrypted, citizen_id_tail, citizen_id_hash,
             email, line_user_id, current_room_id, status, notes, locale,
             address, emergency_contact_name, emergency_contact_phone, emergency_contact_relation)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING id, full_name, phone, email, current_room_id, status, created_at`,
          [
            fullName, phone, citizenEnc, citizenTail, citizenHash,
            str(b.email, 200) || null,
            lineUserId,
            requestedRoomId,
            tenantStatus,
            str(b.notes, 1000) || null,
            ['th', 'en'].includes(b.locale) ? b.locale : 'th',
            address, ecName, ecPhoneNorm, ecRel,
          ]
        );
        if (useSavepoint) {
          await db.query('RELEASE SAVEPOINT tenant_insert_schema');
        }
        return rows;
      } catch (err) {
        if (isActiveRoomUniqueViolation(err)) {
          if (useSavepoint) {
            await db.query('ROLLBACK TO SAVEPOINT tenant_insert_schema').catch(() => {});
          }
          let occupant = null;
          if (requestedRoomId) {
            const occ = await db.query(
              `SELECT id, full_name, phone, current_room_id
                 FROM tenants
                WHERE current_room_id=$1
                  AND status='active'
                  AND deleted_at IS NULL
                ORDER BY updated_at DESC, id DESC
                LIMIT 1`,
              [requestedRoomId]
            ).catch(() => ({ rows: [] }));
            occupant = occ.rows[0] || null;
          }
          throw httpErr(409, 'ROOM_OCCUPIED',
            `ห้อง ${requestedRoomId || ''} มีผู้เช่า active อยู่แล้ว`,
            {
              roomId: requestedRoomId,
              occupant,
              hint: 'ตรวจห้องนี้ในหน้า ผู้เช่า/สัญญา แล้ว checkout หรือปิดสัญญาเดิมก่อนเพิ่มผู้เช่าใหม่',
            });
        }
        if (err.code === '23505' && err.constraint === 'uq_tenants_citizen_id_hash_active') {
          throw httpErr(409, 'CITIZEN_ID_DUPLICATE',
            'เลขบัตรนี้ผูกกับผู้เช่ารายอื่นแล้ว (race)');
        }
        // Older deploys without the new columns fall back to the legacy INSERT.
        if (err.code === '42703') {
          if (useSavepoint) {
            await db.query('ROLLBACK TO SAVEPOINT tenant_insert_schema');
          }
          const { rows } = await db.query(
            `INSERT INTO tenants
              (full_name, phone, citizen_id_encrypted, citizen_id_tail, email, line_user_id,
               current_room_id, status, notes, locale)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             RETURNING id, full_name, phone, email, current_room_id, status, created_at`,
            [
              fullName, phone, citizenEnc, citizenTail,
              str(b.email, 200) || null,
              lineUserId,
              requestedRoomId,
              tenantStatus,
              str(b.notes, 1000) || null,
              ['th', 'en'].includes(b.locale) ? b.locale : 'th',
            ]
          );
          if (useSavepoint) {
            await db.query('RELEASE SAVEPOINT tenant_insert_schema');
          }
          return rows;
        }
        throw err;
      }
    }

    async function claimRoomForTenant(client, roomId, tenantRow) {
      await client.query(
        'SELECT pg_advisory_xact_lock($1::int, $2::int)',
        [0x54454e54, roomLockKey(roomId)] // "TENT": tenant assignment namespace
      );

      const occupants = await client.query(
        `SELECT id, full_name FROM tenants
           WHERE current_room_id=$1 AND status='active' AND deleted_at IS NULL
             AND id <> $2
           LIMIT 1
           FOR UPDATE`,
        [roomId, tenantRow.id]
      );
      if (occupants.rows.length) {
        throw httpErr(409, 'ROOM_OCCUPIED',
          `ห้อง ${roomId} มีผู้เช่ารายอื่นอยู่แล้ว`,
          { occupant: occupants.rows[0], roomId });
      }

      await client.query(
        `INSERT INTO app_data (key, value, updated_by)
         VALUES ('baankarn_rooms_v1', '{}'::jsonb, 'system')
         ON CONFLICT (key) DO NOTHING`
      );
      const roomBlob = await client.query(
        `SELECT value FROM app_data WHERE key='baankarn_rooms_v1' FOR UPDATE`
      );
      const roomsObj = roomBlob.rows[0]?.value && typeof roomBlob.rows[0].value === 'object'
        ? roomBlob.rows[0].value
        : {};
      const blobRoom = roomsObj[roomId] || null;
      let roomV2 = null;
      try {
        const v2 = await client.query(
          `SELECT room_code, status FROM rooms_v2
             WHERE room_code=$1 AND deleted_at IS NULL
             FOR UPDATE`,
          [roomId]
        );
        roomV2 = v2.rows[0] || null;
      } catch (err) {
        if (err.code !== '42P01') throw err;
      }

      if (!blobRoom && !roomV2) {
        throw httpErr(404, 'ROOM_NOT_FOUND',
          `ไม่พบห้อง ${roomId} ในระบบ`, { roomId });
      }
      // Use isVacantStatus (not a bare `!== 'vacant'`) so a legacy blob room
      // stored as 'available'/'empty'/'free' is still recognised as bookable —
      // otherwise admin can't move a tenant into a genuinely-free room.
      const blockingStatus = [blobRoom?.status, roomV2?.status]
        .filter(Boolean)
        .find((s) => !isVacantStatus(s));
      if (blockingStatus) {
        throw httpErr(409,
          blockingStatus === 'occupied' ? 'ROOM_OCCUPIED' : 'ROOM_UNAVAILABLE',
          `ห้อง ${roomId} ไม่พร้อมใช้งาน (${blockingStatus})`,
          { roomId, currentStatus: blockingStatus });
      }

      const today = billing.localTodayYmd();
      const blobTenant = {
        name: tenantRow.full_name || fullName,
        phone: tenantRow.phone || phone,
        email: tenantRow.email || '',
        occupation: str(b.occupation, 200) || '',
        score: 'A',
        tenantId: tenantRow.id,
        since: today,
      };
      await client.query(
        `UPDATE app_data
            SET value = value || jsonb_build_object(
                          $1::text,
                          COALESCE(value->$1, '{}'::jsonb)
                            || jsonb_build_object(
                                 'id', $1,
                                 'status', 'occupied',
                                 'tenant', $2::jsonb,
                                 'since', $3::text
                               )
                        ),
                updated_at=NOW(),
                updated_by=$4
          WHERE key='baankarn_rooms_v1'`,
        [roomId, JSON.stringify(blobTenant), today, req.session.user.username]
      );
      try {
        await client.query(
          `UPDATE rooms_v2 SET status='occupied', updated_at=NOW()
             WHERE room_code=$1 AND deleted_at IS NULL`,
          [roomId]
        );
      } catch (err) {
        if (err.code !== '42P01') throw err;
      }
    }
    try {
      let rows;
      let lineBindingCarryover = null;
      if (requestedRoomId) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          rows = await insertTenantRow(client, true);
          await claimRoomForTenant(client, requestedRoomId, rows[0]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      } else {
        rows = await insertTenantRow(pool);
      }
      // Optional: carry over the citizen ID photo from a public booking the
      // applicant submitted earlier. Without this hand-off the photo would
      // sit in file_uploads with refId='public-booking-pending' forever +
      // admin would have to re-take it at the office. With bookingId set,
      // we re-target the file row + link it on the new tenant.
      if (b.bookingId) {
        try {
          const bookingId = String(b.bookingId).slice(0, 64);
          let fid = null;
          try {
            const bk = await pool.query(
              `SELECT citizen_id_image_front_id FROM bookings WHERE external_id=$1 LIMIT 1`,
              [bookingId]
            );
            fid = bk.rows[0] && bk.rows[0].citizen_id_image_front_id;
          } catch (err) {
            // 42703 = pre-migration column absent. 42P01 = bookings table
            // missing entirely (legacy deploy). Both are expected on older
            // installs — skip carry-over silently. Anything else is a real
            // error that should be visible.
            if (err.code !== '42703' && err.code !== '42P01') throw err;
          }
          if (fid) {
            // Verify the file is actually a citizen-ID image with the
            // public-booking-pending placeholder ref_id we wrote at upload
            // time. Without this, a corrupted booking row pointing at the
            // wrong file_uploads.id (e.g. an unrelated contract_signature)
            // would get re-targeted onto the tenant's identity FK column.
            const fileQ = await pool.query(
              `SELECT id FROM file_uploads
                 WHERE id=$1 AND category='citizen_id_image'
                   AND (ref_id='public-booking-pending' OR ref_id IS NULL)
                 LIMIT 1`,
              [fid]
            );
            if (fileQ.rows.length) {
              await pool.query(
                `UPDATE tenants SET citizen_id_image_front_id=$1, updated_at=NOW() WHERE id=$2`,
                [fid, rows[0].id]
              );
              await pool.query(
                `UPDATE file_uploads SET ref_id=$1 WHERE id=$2 AND category='citizen_id_image'`,
                [String(rows[0].id), fid]
              );
            } else {
              console.warn('[tenant.create] booking photo skipped — wrong category or ref_id');
            }
          }
        } catch (err) {
          console.warn('[tenant.create] booking photo link skipped:', err.message);
        }
      }
      if (b.bookingId) {
        try {
          const bookingId = String(b.bookingId).slice(0, 64);
          lineBindingCarryover = await lineBinding.transferBookingBindings(pool, {
            bookingId,
            tenantId: rows[0].id,
          });
        } catch (err) {
          console.warn('[tenant.create] booking LINE binding carry-over skipped:', err.message);
          lineBindingCarryover = { ok: false, error: err.message };
        }
      }
      audit(req, 'tenant.create', 'tenant', String(rows[0].id),
        { hasIdentity: !!(b.citizenIdImageFront || b.citizenIdImageBack),
          linkedFromBooking: b.bookingId || null, lineBindingCarryover,
          force: b.force === true });
      res.json({
        ok: true, tenant: rows[0],
        lineBindingCarryover,
        // Hint to UI: if citizen ID images were sent in the same payload,
        // POST them to /identity now using the returned id. Keeping the
        // upload separate avoids 3MB-per-tenant-create payloads.
        identityUploadHint: (b.citizenIdImageFront || b.citizenIdImageBack)
          ? `POST /api/tenants/${rows[0].id}/identity` : null,
      });
    } catch (err) {
      if (err && err.httpStatus) {
        return res.status(err.httpStatus).json({
          error: err.publicError || err.message,
          code: err.publicCode || 'TENANT_CREATE_FAILED',
          ...(err.extra || {}),
        });
      }
      console.error('tenant create error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // === PUT /api/tenants/:id ===============================================
  // Patch tenant fields. Optimistic locking via b.version (= last
  // updated_at). The status='moved_out' path is BLOCKED unless force=true
  // when the tenant still has live links (room/contract/cards) — that
  // cascade belongs in POST /:id/checkout. Without this guard, admin's
  // "edit tenant → change status dropdown" left orphan contracts.
  r.put('/:id', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    const b = req.body || {};
    const fields = [];
    const params = [];
    let i = 1;
    const set = (col, val) => { fields.push(`${col} = $${i++}`); params.push(val); };
    const requestedStatus = b.status !== undefined ? String(b.status) : undefined;
    const requestedRoomId = b.roomId !== undefined
      ? (b.roomId ? String(b.roomId).slice(0, 32).trim() : null)
      : undefined;
    const statusTouched = requestedStatus !== undefined || requestedRoomId !== undefined;
    const rawStatusForceReason = b.forceReason !== undefined
      ? b.forceReason
      : (b.statusReason !== undefined ? b.statusReason : b.reason);
    const statusForceReason = rawStatusForceReason == null
      ? ''
      : String(rawStatusForceReason).trim().slice(0, 500);
    let statusContext = null;
    const loadStatusContext = async () => {
      if (statusContext) return statusContext;
      const cur = await pool.query(
        `SELECT t.status AS tenant_status, t.current_room_id,
                (SELECT COUNT(*)::int FROM contracts
                   WHERE tenant_id=t.id AND status='active' AND deleted_at IS NULL) AS active_contracts,
                (SELECT COUNT(*)::int FROM access_cards
                   WHERE tenant_id=t.id AND status='active') AS active_cards
           FROM tenants t
          WHERE t.id=$1 AND t.deleted_at IS NULL`,
        [id]
      );
      statusContext = cur.rows[0] || null;
      return statusContext;
    };
    if (b.fullName !== undefined) set('full_name', String(b.fullName).slice(0, 200));
    if (b.phone !== undefined) {
      // Normalise on update too — without this, admin's "fix the phone format"
      // edit silently re-introduces dashes that block tenant login.
      const normPhone = String(b.phone).slice(0, 32).trim().replace(/[\s-]/g, '');
      if (!/^[\d+]{8,20}$/.test(normPhone)) {
        return res.status(400).json({ error: 'เบอร์โทรไม่ถูกต้อง', code: 'INVALID_PHONE' });
      }
      set('phone', normPhone);
    }
    if (b.email !== undefined) set('email', b.email ? String(b.email).slice(0, 200) : null);
    if (b.lineUserId !== undefined) {
      const lineUserId = b.lineUserId ? String(b.lineUserId).slice(0, 64).trim() : null;
      if (lineUserId && !lineNotify.isLikelyUserId(lineUserId)) {
        return res.status(400).json({ error: 'invalid LINE userId', code: 'INVALID_LINE_USER_ID' });
      }
      set('line_user_id', lineUserId);
    }
    if (requestedStatus !== undefined && !VALID_TENANT_STATUS.has(requestedStatus)) {
      return res.status(400).json({
        error: 'สถานะผู้เช่าไม่ถูกต้อง',
        code: 'TENANT_STATUS_INVALID',
        allowed: Array.from(VALID_TENANT_STATUS),
      });
    }
    if (statusTouched) {
      let row;
      try {
        row = await loadStatusContext();
      } catch (err) {
        console.error('[tenant.put] status precheck failed:', err.message);
        return res.status(500).json({
          error: 'ตรวจสถานะปัจจุบันไม่สำเร็จ — ยังไม่อัปเดตข้อมูลเพื่อป้องกันสถานะผิด',
          code: 'TENANT_STATUS_PRECHECK_FAILED',
        });
      }
      if (!row) return res.status(404).json({ error: 'not found', code: 'NOT_FOUND' });
      const finalStatus = requestedStatus !== undefined ? requestedStatus : row.tenant_status;
      const finalRoomId = requestedRoomId !== undefined ? requestedRoomId : row.current_room_id;
      if (b.force === true && statusForceReason.length < 8) {
        return res.status(400).json({
          error: 'ใช้ force เพื่อเปลี่ยนสถานะ/ห้องไม่ได้ เพราะยังไม่ได้ระบุเหตุผลที่ชัดเจน',
          code: 'TENANT_STATUS_FORCE_REASON_REQUIRED',
          detail: {
            currentStatus: row.tenant_status,
            currentRoom: row.current_room_id,
            requestedStatus: finalStatus,
            requestedRoom: finalRoomId,
            reasonLength: statusForceReason.length,
          },
          hint: 'กรอก forceReason หรือ statusReason อย่างน้อย 8 ตัวอักษร เช่น cleanup ghost row หลัง checkout สำเร็จแล้ว',
          impact: 'ระบบยังไม่บันทึกการเปลี่ยนแปลง เพื่อป้องกันการย้ายสถานะ/ห้องผิดคนและให้ audit log ตรวจย้อนหลังได้',
          nextActions: {
            hint: finalStatus === 'moved_out' || finalStatus === 'blacklist'
              ? 'ถ้าเป็นการย้ายออกจริง ให้ใช้ checkout แทน force; ถ้าเป็นงาน cleanup/migrate ให้ใส่เหตุผลว่าตรวจอะไรแล้วจึงต้อง force'
              : 'ตรวจว่าผู้เช่า ห้อง และสถานะถูกต้องก่อน แล้วใส่เหตุผลว่าทำไมต้อง force',
          },
        });
      }
      if (finalStatus === 'active') {
        if (!finalRoomId) {
          return res.status(409).json({
            error: 'ตั้งผู้เช่าเป็น active ไม่ได้ เพราะยังไม่มีห้องปัจจุบัน',
            code: 'TENANT_ACTIVE_ROOM_REQUIRED',
            detail: {
              currentStatus: row.tenant_status,
              currentRoom: row.current_room_id,
              requestedStatus: finalStatus,
              requestedRoom: finalRoomId,
            },
            hint: 'เลือกห้องให้ผู้เช่าก่อน หรือใช้ flow check-in/สร้างสัญญาเพื่อผูกห้องและสถานะให้ครบ',
          });
        }
        const conflict = await pool.query(
          `SELECT id, full_name, current_room_id
             FROM tenants
            WHERE current_room_id=$1
              AND status='active'
              AND deleted_at IS NULL
              AND id<>$2
            LIMIT 1`,
          [finalRoomId, id]
        );
        if (conflict.rows.length) {
          return res.status(409).json({
            error: `ห้อง ${finalRoomId} มีผู้เช่า active อยู่แล้ว`,
            code: 'ROOM_OCCUPIED',
            roomId: finalRoomId,
            conflict: conflict.rows[0],
            hint: 'checkout ผู้เช่าปัจจุบันของห้องนี้ก่อน หรือเลือกห้องอื่น',
            nextActions: {
              checkoutExistingTenantUrl: `/admin#tenants/${conflict.rows[0].id}?tab=contract`,
            },
          });
        }
      } else if (finalStatus === 'moved_out' || finalStatus === 'blacklist') {
        if (requestedRoomId) {
          return res.status(409).json({
            error: `สถานะ ${finalStatus} ต้องไม่ผูก current_room_id`,
            code: 'TENANT_NONACTIVE_ROOM_FORBIDDEN',
            detail: {
              currentStatus: row.tenant_status,
              currentRoom: row.current_room_id,
              requestedStatus: finalStatus,
              requestedRoom: requestedRoomId,
            },
            hint: 'ถ้าผู้เช่ายังอยู่ ให้ใช้สถานะ active; ถ้าจะย้ายออก/blacklist ให้ checkout หรือปล่อย roomId ว่าง',
          });
        }
        if (row.tenant_status === 'active'
            && (row.current_room_id || row.active_contracts > 0 || row.active_cards > 0)
            && b.force !== true) {
          const issueSummary = [
            row.current_room_id ? {
              label: 'ยังผูกห้องอยู่',
              value: row.current_room_id,
              fix: 'ใช้ checkout เพื่อคืนห้องและซิงก์สถานะห้อง',
            } : null,
            row.active_contracts > 0 ? {
              label: 'ยังมีสัญญา active',
              value: row.active_contracts,
              fix: 'checkout จะปิดสัญญาให้ครบก่อนเปลี่ยนสถานะ',
            } : null,
            row.active_cards > 0 ? {
              label: 'ยังมีบัตร active',
              value: row.active_cards,
              fix: 'checkout จะเพิกถอนบัตรและล้าง session ผู้เช่า',
            } : null,
          ].filter(Boolean);
          return res.status(409).json({
            error: `ผู้เช่ายัง active อยู่ (ห้อง/สัญญา/บัตร) — ใช้ POST /api/tenants/:id/checkout เพื่ออัปเดตสถานะครบชุดก่อนเปลี่ยนเป็น ${finalStatus}`,
            code: 'USE_CHECKOUT_ENDPOINT',
            checkoutUrl: `/api/tenants/${id}/checkout`,
            adminUrl: `/admin#tenants/${id}?tab=contract`,
            issueSummary,
            impact: 'ถ้าเปลี่ยนสถานะตรง ๆ ห้อง/สัญญา/บัตรอาจไม่ตรงกัน ทำให้บิลหรือสิทธิ์ผู้เช่าผิดคนได้',
            detail: {
              currentStatus: row.tenant_status,
              requestedStatus: finalStatus,
              currentRoom: row.current_room_id,
              activeContracts: row.active_contracts,
              activeCards: row.active_cards,
            },
            nextActions: {
              hint: 'ใช้ checkout เพื่อปิดสัญญา คืนห้อง เพิกถอนบัตร และล้าง session ผู้เช่าในรายการเดียว',
              checkoutUrl: `/api/tenants/${id}/checkout`,
              adminUrl: `/admin#tenants/${id}?tab=contract`,
            },
          });
        }
        if (requestedRoomId === undefined && row.current_room_id) {
          set('current_room_id', null);
        }
      }
    }
    if (requestedRoomId !== undefined) set('current_room_id', requestedRoomId);
    if (requestedStatus !== undefined) {
      set('status', requestedStatus);
      if (requestedStatus === 'blacklist' && b.blacklistReason) set('blacklist_reason', String(b.blacklistReason).slice(0, 500));
    }
    if (b.notes !== undefined) set('notes', b.notes ? String(b.notes).slice(0, 1000) : null);
    if (b.locale !== undefined && ['th', 'en'].includes(b.locale)) set('locale', b.locale);
    if (b.citizenId !== undefined) {
      const thaiId = require('../services/thaiId');
      const norm = thaiId.normalize(b.citizenId || '');
      if (b.citizenId && !norm) {
        return res.status(400).json({ error: 'เลขบัตรประชาชนต้องเป็น 13 หลัก', code: 'INVALID_CITIZEN_ID' });
      }
      if (norm) {
        if (!thaiId.validateChecksum(norm) && b.force !== true) {
          return res.status(400).json({
            error: 'เลขบัตรประชาชนไม่ผ่าน check digit (mod-11)',
            code: 'INVALID_CHECKSUM',
          });
        }
        const flags = await features.load(pool);
        try {
          const enc = (flags.citizenIdEncryption && flags.citizenIdEncryption.enabled)
            ? cryptoSvc.encryptString(norm) : norm;
          set('citizen_id_encrypted', enc);
          set('citizen_id_tail', norm.slice(-4));
          // Recompute hash on update so dedup index reflects the new value.
          // Skip when checksum failed but operator forced — same policy as create.
          if (thaiId.validateChecksum(norm)) {
            const newHash = thaiId.hashForLookup(norm);
            // Pre-flight dup check (advisory unless force=true).
            if (newHash && b.force !== true) {
              const dup = await pool.query(
                `SELECT id, full_name FROM tenants
                   WHERE citizen_id_hash=$1 AND id<>$2 AND deleted_at IS NULL AND status='active' LIMIT 1`,
                [newHash, id]
              ).catch(() => ({ rows: [] }));
              if (dup.rows.length) {
                return res.status(409).json({
                  error: 'เลขบัตรนี้ผูกกับผู้เช่ารายอื่นแล้ว',
                  code: 'CITIZEN_ID_DUPLICATE',
                  conflict: dup.rows[0],
                });
              }
            }
            set('citizen_id_hash', newHash);
          } else {
            set('citizen_id_hash', null);  // checksum forced — drop dedup
          }
        } catch (e) { return res.status(500).json({ error: 'crypto: ' + e.message }); }
      } else {
        set('citizen_id_encrypted', null);
        set('citizen_id_tail', null);
        set('citizen_id_hash', null);
      }
    }
    // Address + emergency contact updates. All optional; empty string clears.
    if (b.address !== undefined) {
      set('address', b.address ? String(b.address).slice(0, 500) : null);
    }
    if (b.emergencyContactName !== undefined) {
      set('emergency_contact_name', b.emergencyContactName ? String(b.emergencyContactName).slice(0, 200) : null);
    }
    if (b.emergencyContactPhone !== undefined) {
      const ec = b.emergencyContactPhone
        ? String(b.emergencyContactPhone).slice(0, 32).trim().replace(/[\s-]/g, '') : null;
      if (ec && !/^[\d+]{8,20}$/.test(ec)) {
        return res.status(400).json({ error: 'เบอร์โทรผู้ติดต่อฉุกเฉินไม่ถูกต้อง', code: 'INVALID_EMERGENCY_PHONE' });
      }
      set('emergency_contact_phone', ec);
    }
    if (b.emergencyContactRelation !== undefined) {
      set('emergency_contact_relation', b.emergencyContactRelation ? String(b.emergencyContactRelation).slice(0, 64) : null);
    }
    if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
    fields.push('updated_at = NOW()');
    // Optimistic locking: if the client sent a `version` (= server's last
    // updated_at), we add it to the WHERE clause. Two concurrent edits → the
    // second UPDATE returns 0 rows → 409 with the current state so the UI
    // can prompt the user to reload before retrying. Without `version` we
    // fall back to last-write-wins (preserves backwards compat).
    let lockClause = '';
    if (b.version) {
      params.push(b.version);
      lockClause = ` AND updated_at = $${params.length}`;
    }
    params.push(id);
    try {
      const { rows } = await pool.query(
        `UPDATE tenants SET ${fields.join(', ')}
           WHERE id=$${params.length} AND deleted_at IS NULL${lockClause}
           RETURNING id, updated_at`,
        params
      );
      if (!rows.length) {
        if (b.version) {
          // Either the row is gone or the version is stale. Look up to tell apart.
          const cur = await pool.query(
            `SELECT id, full_name, phone, email, current_room_id, status, updated_at
               FROM tenants WHERE id=$1 AND deleted_at IS NULL`,
            [id]
          );
          if (cur.rows.length) {
            return res.status(409).json({
              error: 'ผู้ใช้อื่นแก้ไขข้อมูลนี้ไปแล้ว — โปรดโหลดข้อมูลใหม่ก่อนแก้ไข',
              code: 'VERSION_CONFLICT',
              current: cur.rows[0],
            });
          }
        }
        return res.status(404).json({ error: 'not found', code: 'NOT_FOUND' });
      }
      if (requestedStatus === 'moved_out' || requestedStatus === 'blacklist') {
        await pool.query(`DELETE FROM tenant_sessions WHERE tenant_id=$1`, [id]).catch((err) => {
          console.warn('[tenant.update] session cleanup failed:', err.message);
        });
      }
      const previousStatus = statusContext?.tenant_status || null;
      const previousRoomId = statusContext?.current_room_id || null;
      const finalStatus = requestedStatus !== undefined ? requestedStatus : previousStatus;
      const finalRoomId = requestedRoomId !== undefined
        ? requestedRoomId
        : ((requestedStatus === 'moved_out' || requestedStatus === 'blacklist') ? null : previousRoomId);
      const warnings = [];
      const roomSync = [];
      if (statusTouched) {
        const roomsToSync = new Set();
        if (previousRoomId) roomsToSync.add(String(previousRoomId));
        if (finalRoomId) roomsToSync.add(String(finalRoomId));
        if (roomsToSync.size > 0) {
          const { syncRoom } = require('../services/roomStatus');
          for (const roomId of roomsToSync) {
            try {
              await syncRoom(pool, roomId, { reason: 'tenant-update-status' });
              roomSync.push({ roomId, ok: true });
            } catch (err) {
              console.warn('[tenant.update] room sync failed:', roomId, err.message);
              roomSync.push({ roomId, ok: false, error: err.message });
              warnings.push({
                code: 'ROOM_STATUS_SYNC_FAILED',
                msg: `อัปเดตผู้เช่าสำเร็จ แต่ซิงก์สถานะห้อง ${roomId} ไม่สำเร็จ`,
                fix: 'เปิดหน้าห้องพักหรือสถานะระบบเพื่อตรวจ data integrity แล้วลองซิงก์อีกครั้ง',
              });
            }
          }
        }
      }
      // Audit the change. Include a 'forced' flag when admin bypassed the
      // checkout cascade — that's the breadcrumb if a moved_out tenant later
      // shows up with an orphan contract because of this PUT.
      audit(req, 'tenant.update', 'tenant', String(id), {
        fields: Object.keys(b),
        statusUpdate: statusTouched ? {
          from: previousStatus,
          to: finalStatus,
          previousRoomId,
          roomId: finalRoomId,
        } : undefined,
        forcedStatusUpdate: statusTouched && b.force === true ? {
          to: finalStatus,
          reason: statusForceReason,
        } : undefined,
      });
      res.json({
        ok: true,
        id,
        updated_at: rows[0].updated_at,
        statusUpdate: statusTouched ? {
          from: previousStatus,
          to: finalStatus,
          previousRoomId,
          roomId: finalRoomId,
          roomSync,
          warnings,
        } : undefined,
        warnings,
      });
    } catch (err) {
      if (isActiveRoomUniqueViolation(err)) {
        return res.status(409).json({
          error: 'ห้องนี้มีผู้เช่า active อยู่แล้ว — ไม่สามารถผูกผู้เช่าซ้ำได้',
          code: 'ROOM_OCCUPIED',
          constraint: ACTIVE_ROOM_CONSTRAINT,
          hint: 'เปิดหน้า ผู้เช่า แล้วตรวจห้องที่ซ้ำ จากนั้น checkout/ย้ายออกผู้เช่าเดิมก่อนบันทึกอีกครั้ง',
        });
      }
      console.error('tenant update error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // === DELETE /api/tenants/:id ============================================
  // Owner-only. Soft-delete when the softDelete feature is on; otherwise a
  // hard DELETE which surfaces FK-blocked references as a 409 TENANT_HAS_REFS
  // instead of a generic 500.
  r.delete('/:id', sameOrigin, csrfGuard, requireAuth, requireRole('owner'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    const force = !!(req.body && req.body.force === true);
    try {
      const flags = await features.load(pool);
      // Guard (mirrors the PUT→moved_out precheck): refuse to delete a tenant
      // that still has live links. A bare delete — soft OR hard — does NOT
      // cascade, so it would orphan the active contract (the room stays
      // "occupied" via uq_contracts_active_room, blocking re-rental and 500'ing
      // the next check-in on that room), leave access cards valid, and keep
      // recurring charges billing a ghost. Route admin through checkout first;
      // force:true keeps a migration / cleanup escape hatch (audit-logged).
      if (!force) {
        try {
          const cur = await pool.query(
            `SELECT t.status AS tenant_status, t.current_room_id,
                    (SELECT COUNT(*)::int FROM contracts
                       WHERE tenant_id=t.id AND status='active' AND deleted_at IS NULL) AS active_contracts,
                    (SELECT COUNT(*)::int FROM access_cards
                       WHERE tenant_id=t.id AND status='active') AS active_cards
               FROM tenants t
              WHERE t.id=$1 AND t.deleted_at IS NULL`,
            [id]
          );
          const row = cur.rows[0];
          if (row && row.tenant_status === 'active'
              && (row.current_room_id || row.active_contracts > 0 || row.active_cards > 0)) {
            return res.status(409).json({
              error: 'ลบไม่ได้ — ผู้เช่ายัง active อยู่ (ห้อง/สัญญา/บัตร) ใช้ POST /api/tenants/:id/checkout เพื่อปิดสัญญา + คืนห้อง + เพิกถอนบัตรก่อน',
              code: 'USE_CHECKOUT_ENDPOINT',
              checkoutUrl: `/api/tenants/${id}/checkout`,
              detail: {
                currentRoom: row.current_room_id,
                activeContracts: row.active_contracts,
                activeCards: row.active_cards,
              },
              hint: 'ถ้าต้องการลบเฉพาะข้อมูล (migrate / cleanup ghost) ส่ง { force: true } พร้อม audit log',
            });
          }
        } catch (err) {
          console.error('[tenant.delete] live-link precheck failed:', err.message);
          return res.status(500).json({
            error: 'ตรวจสถานะปัจจุบันไม่สำเร็จ — ลองใหม่หรือใช้ /checkout endpoint',
            code: 'DELETE_PRECHECK_FAILED',
          });
        }
      }
      if (flags.softDelete && flags.softDelete.enabled) {
        await pool.query(`UPDATE tenants SET deleted_at=NOW() WHERE id=$1`, [id]);
      } else {
        // Hard delete is dangerous: tenants(id) has FK references from bills,
        // contracts, payments, access_cards, line_bindings (CASCADE),
        // recurring_charges (CASCADE), tenant_sessions (NOT NULL).
        // Most FKs are ON DELETE NO ACTION → the DELETE fails with 23503 and
        // the tenant stays orphaned. Surface that as a clear 409 instead of
        // a generic 500 so admin knows to use soft-delete (or clean refs first).
        try {
          await pool.query(`DELETE FROM tenants WHERE id=$1`, [id]);
        } catch (err) {
          if (err.code === '23503') {
            return res.status(409).json({
              error: 'ลบไม่ได้ — ผู้เช่ายังมีบิล/สัญญา/บัตรเข้า-ออกเชื่อมโยง โปรดเปิด softDelete หรือลบข้อมูลที่เชื่อมโยงก่อน',
              code: 'TENANT_HAS_REFS',
            });
          }
          throw err;
        }
      }
      audit(req, 'tenant.delete', 'tenant', String(id), { force });
      res.json({ ok: true });
    } catch (err) {
      console.error('tenant delete error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // === POST /api/tenants/:id/identity =====================================
  // Upload citizen-ID images (front/back) + optionally the cleartext number.
  // The number, if supplied, is encrypted via cryptoSvc when the feature
  // flag is on; the hash is stored for the partial-unique dedup index.
  // Photo storage is sequential so we can roll back the first if the second
  // fails (avoids half-linked records). Owner-notify on success creates the
  // legal trail (see test integration.test.js#4161).
  r.post('/:id/identity', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    features.requireFeature('photoUpload'),
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
      const b = req.body || {};
      const front = b.frontDataUrl;
      const back  = b.backDataUrl;
      const citizenIdRaw = b.citizenId != null ? String(b.citizenId) : null;
      if (!front && !back && !citizenIdRaw) {
        return res.status(400).json({
          error: 'ต้องส่งภาพหน้าหรือหลังของบัตรอย่างน้อย 1 ด้าน หรือเลขบัตร 13 หลัก',
          code: 'NOTHING_TO_SAVE',
        });
      }

      // Optional Thai citizen-ID validation. If supplied, MUST pass checksum —
      // typing 13 random digits should fail loudly rather than silently store.
      const thaiId = require('../services/thaiId');
      let citizenId = null;
      let citizenTail = null;
      let citizenEnc = null;
      let citizenHash = null;
      if (citizenIdRaw) {
        const norm = thaiId.normalize(citizenIdRaw);
        if (!norm) {
          return res.status(400).json({
            error: 'เลขบัตรประชาชนต้องเป็น 13 หลัก',
            code: 'INVALID_CITIZEN_ID',
          });
        }
        if (!thaiId.validateChecksum(norm)) {
          return res.status(400).json({
            error: 'เลขบัตรประชาชนไม่ผ่านการตรวจสอบ check digit (mod-11)',
            code: 'INVALID_CHECKSUM',
          });
        }
        citizenId = norm;
        citizenTail = norm.slice(-4);
        citizenHash = thaiId.hashForLookup(norm);
        // Encrypt under the configured citizen-ID encryption flag (matches
        // the existing POST /api/tenants behaviour).
        try {
          const flags = await features.load(pool);
          if (flags.citizenIdEncryption && flags.citizenIdEncryption.enabled) {
            citizenEnc = cryptoSvc.encryptString(norm);
          } else {
            citizenEnc = norm;  // plaintext fallback (not recommended)
          }
        } catch (e) {
          return res.status(500).json({ error: 'crypto unavailable: ' + e.message });
        }
      }

      // Verify the tenant exists BEFORE storing the photos so we don't leave
      // orphan file_uploads on a 404. Pull existing image FK ids too so we can
      // remove them when the admin replaces a side (otherwise old files leak
      // on disk + bloat file_uploads).
      const t = await pool.query(
        `SELECT id, citizen_id_image_front_id, citizen_id_image_back_id
           FROM tenants WHERE id=$1 AND deleted_at IS NULL`,
        [id]
      );
      if (!t.rows.length) return res.status(404).json({ error: 'tenant not found' });
      const existingFrontId = t.rows[0].citizen_id_image_front_id;
      const existingBackId  = t.rows[0].citizen_id_image_back_id;

      // Pre-flight dedup check on citizen_id_hash so admin sees a clear
      // duplicate-detected response instead of a 23505 from the partial
      // unique index. Advisory only when force=true is set in the body.
      if (citizenHash) {
        const dup = await pool.query(
          `SELECT id, full_name, status FROM tenants
             WHERE citizen_id_hash=$1 AND deleted_at IS NULL AND status='active' AND id<>$2
             LIMIT 1`,
          [citizenHash, id]
        );
        if (dup.rows.length && b.force !== true) {
          return res.status(409).json({
            error: 'เลขบัตรนี้ถูกบันทึกในระบบแล้วกับผู้เช่ารายอื่น',
            code: 'CITIZEN_ID_DUPLICATE',
            conflict: dup.rows[0],
            hint: 'ส่ง { force: true } ถ้ายืนยันว่าเป็นคนเดิมและต้องการอัปเดตข้อมูล (audit-logged)',
          });
        }
      }

      const maxBytes = (req.features.photoUpload && req.features.photoUpload.maxBytes) || 1_500_000;
      const username = req.session.user.username;

      // Photos are saved sequentially so a failure mid-flight leaves the
      // tenant row consistent (we only commit the FK update once we know
      // both successful uploads landed).
      let frontFile = null, backFile = null;
      try {
        if (front) {
          frontFile = await storage.saveBase64({
            pool, category: 'citizen_id_image',
            dataUrl: front, refId: String(id), uploadedBy: username,
            maxBytes, side: 'front',
          });
        }
        if (back) {
          backFile = await storage.saveBase64({
            pool, category: 'citizen_id_image',
            dataUrl: back, refId: String(id), uploadedBy: username,
            maxBytes, side: 'back',
          });
        }
      } catch (err) {
        // Roll back any successful upload so we don't leave a half-linked record.
        if (frontFile) await storage.remove(pool, frontFile.id).catch(() => {});
        if (backFile)  await storage.remove(pool, backFile.id).catch(() => {});
        return res.status(400).json({ error: err.message || 'upload failed', code: 'UPLOAD_FAILED' });
      }

      // Link to tenant + write citizen ID fields if provided. All in ONE
      // statement so the partial unique index runs against a coherent row.
      const sets = []; const params = [];
      let i = 1;
      if (frontFile) { sets.push(`citizen_id_image_front_id=$${i++}`); params.push(frontFile.id); }
      if (backFile)  { sets.push(`citizen_id_image_back_id=$${i++}`);  params.push(backFile.id); }
      if (citizenEnc != null) { sets.push(`citizen_id_encrypted=$${i++}`); params.push(citizenEnc); }
      if (citizenTail != null) { sets.push(`citizen_id_tail=$${i++}`); params.push(citizenTail); }
      if (citizenHash != null) { sets.push(`citizen_id_hash=$${i++}`); params.push(citizenHash); }
      if (sets.length) {
        sets.push('updated_at = NOW()');
        params.push(id);
        try {
          await pool.query(
            `UPDATE tenants SET ${sets.join(', ')} WHERE id=$${i}`,
            params
          );
        } catch (err) {
          // 23505 = race against another concurrent identity write hitting
          // the same hash. Tear down photos so the next attempt isn't
          // double-storing.
          if (frontFile) await storage.remove(pool, frontFile.id).catch(() => {});
          if (backFile)  await storage.remove(pool, backFile.id).catch(() => {});
          if (err.code === '23505') {
            return res.status(409).json({
              error: 'เลขบัตรนี้ผูกกับผู้เช่ารายอื่นแล้ว (race)',
              code: 'CITIZEN_ID_DUPLICATE',
            });
          }
          throw err;
        }
      }

      // After successful link, remove the OLD files (if admin is replacing).
      // Best-effort — failure here doesn't fail the request because the new
      // file is already linked; the orphan would just sit around.
      if (frontFile && existingFrontId && existingFrontId !== frontFile.id) {
        await storage.remove(pool, existingFrontId).catch((err) => {
          console.warn('[identity] old front cleanup failed:', err.message);
        });
      }
      if (backFile && existingBackId && existingBackId !== backFile.id) {
        await storage.remove(pool, existingBackId).catch((err) => {
          console.warn('[identity] old back cleanup failed:', err.message);
        });
      }

      audit(req, 'tenant.identity', 'tenant', String(id), {
        hasFront: !!frontFile, hasBack: !!backFile,
        citizenTail, force: b.force === true,
        replacedFrontId: existingFrontId !== frontFile?.id ? existingFrontId : null,
        replacedBackId: existingBackId !== backFile?.id ? existingBackId : null,
      });
      // Owner notify so a third party sees identity-capture activity. Reduces
      // inside-job risk where a single admin could fabricate tenant records;
      // the owner gets a paper trail in LINE/email.
      try {
        const flags = await features.load(pool);
        const sides = [
          frontFile ? 'หน้า' : null,
          backFile ? 'หลัง' : null,
        ].filter(Boolean).join('+');
        notifier.notifyOwner({ pool, features: flags }, {
          category: 'security',
          subject: `📇 บันทึกบัตรประชาชน — tenant id=${id}`,
          text: `admin ${req.session.user.username} บันทึกภาพบัตร${sides ? ' (' + sides + ')' : ''}`
            + (citizenTail ? `\nหมายเลข: ***-${citizenTail}` : '')
            + (b.force === true ? '\n⚠️ ใช้ force=true bypass dedup' : ''),
        }).catch(() => {});
      } catch { /* notify failure must not break the request */ }
      res.json({
        ok: true,
        tenantId: id,
        front: frontFile ? { id: frontFile.id, url: frontFile.url, side: 'front' } : null,
        back:  backFile  ? { id: backFile.id,  url: backFile.url,  side: 'back'  } : null,
        citizenIdHashSet: !!citizenHash,
        replacedFrontId: existingFrontId && frontFile && existingFrontId !== frontFile.id ? existingFrontId : null,
        replacedBackId: existingBackId && backFile && existingBackId !== backFile.id ? existingBackId : null,
      });
    });

  // === GET /api/tenants/:id/identity ======================================
  // Return the current image links + masked citizen ID. Owner/manager only —
  // staff has read on tenant rows but not citizen ID; we explicitly gate
  // this endpoint.
  r.get('/:id/identity', requireAuth, requireRole('owner', 'manager'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    try {
      const { rows } = await pool.query(
        `SELECT t.id, t.full_name, t.citizen_id_tail,
                t.citizen_id_image_front_id, t.citizen_id_image_back_id,
                ff.url AS front_url, bf.url AS back_url,
                ff.uploaded_at AS front_uploaded_at, bf.uploaded_at AS back_uploaded_at
           FROM tenants t
           LEFT JOIN file_uploads ff ON ff.id = t.citizen_id_image_front_id
           LEFT JOIN file_uploads bf ON bf.id = t.citizen_id_image_back_id
          WHERE t.id=$1 AND t.deleted_at IS NULL LIMIT 1`,
        [id]
      );
      if (!rows.length) return res.status(404).json({ error: 'tenant not found' });
      const row = rows[0];
      res.json({
        ok: true,
        tenantId: row.id,
        fullName: row.full_name,
        citizenIdTail: row.citizen_id_tail,  // last 4 only
        front: row.citizen_id_image_front_id ? {
          id: row.citizen_id_image_front_id, url: row.front_url, uploadedAt: row.front_uploaded_at,
        } : null,
        back: row.citizen_id_image_back_id ? {
          id: row.citizen_id_image_back_id, url: row.back_url, uploadedAt: row.back_uploaded_at,
        } : null,
      });
    } catch (err) {
      console.error('identity get error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

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
              termMonths, endDate: explicitEndDate, discountPct: explicitDiscount,
              agreedTermsVersion, force } = req.body;
      const isForced = force === true;
      const requestedEndDate = explicitEndDate || null;
      if (requestedEndDate && requestedEndDate < moveInDate) {
        return res.status(400).json({
          error: 'วันสิ้นสุดสัญญาต้องไม่ก่อนวันที่เข้าพัก',
          code: 'INVALID_END_DATE',
          moveInDate,
          endDate: requestedEndDate,
        });
      }
      const maxEndDate = addContractMonths(moveInDate, 60);
      if (requestedEndDate && maxEndDate && requestedEndDate > maxEndDate) {
        return res.status(400).json({
          error: 'วันสิ้นสุดสัญญาเกิน 60 เดือนจากวันที่เข้าพัก',
          code: 'END_DATE_TOO_FAR',
          moveInDate,
          endDate: requestedEndDate,
          maxEndDate,
        });
      }
      const effectiveTermMonths = termMonths
        || (requestedEndDate ? estimateContractMonths(moveInDate, requestedEndDate, 60) : null);

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
      const todayStr = billing.localTodayYmd();
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
      // Enforced INSIDE the transaction below against the DERIVED deposit
      // that actually lands on the contract — the request's depositAmount is
      // advisory once the room's own pricing resolves (same rule as
      // monthlyRent), so validating it here would let an over-cap derived
      // value through (or hard-block a request whose derived value is fine).
      const depositMaxMonths = Number(tenancy.depositMaxMonths ?? 3);

      // (2.5) Starting meter readings — capture the room's CURRENT meter value
      // at move-in so the first real bill measures THIS tenant's consumption
      // from their own baseline (not the previous tenant's reading or 0). Each
      // room differs → entered per check-in. Basic shape validation here (fail
      // fast); the backward-reading + policy checks run under the txn lock below
      // once we can read the room's last reading. tenancyContract.meterStartPolicy
      // controls strictness: 'optional' (default) | 'required' | 'off'.
      const meterStartPolicy = ['optional', 'required', 'off'].includes(tenancy.meterStartPolicy)
        ? tenancy.meterStartPolicy : 'optional';
      const parseMeterStart = (v) => (v == null || v === '' ? null : Number(v));
      const waterStart = meterStartPolicy === 'off' ? null : parseMeterStart(req.body.waterStartReading);
      const elecStart  = meterStartPolicy === 'off' ? null : parseMeterStart(req.body.elecStartReading);
      const METER_START_MAX = 9_999_999;
      for (const [label, val] of [['waterStartReading', waterStart], ['elecStartReading', elecStart]]) {
        if (val == null) continue;
        if (!Number.isFinite(val) || val < 0 || val > METER_START_MAX) {
          return res.status(400).json({
            error: `${label} ต้องเป็นเลขมิเตอร์ 0–${METER_START_MAX.toLocaleString('th-TH')} (เลขที่อ่านได้จากหน้ามิเตอร์ของห้องตอนนี้)`,
            code: 'INVALID_METER_START',
            hint: 'กรอกเลขมิเตอร์ปัจจุบันของห้อง (น้ำ/ไฟ) เพื่อใช้เป็นเลขตั้งต้นของผู้เช่ารายนี้',
          });
        }
      }

      // Resolve discount % from term length when admin didn't pass an
      // explicit override. Reads config.discounts.{sixMonth/twelveMonth/
      // twentyFourMonth} from the same JSONB blob the pricing UI writes —
      // closes the loop where those numbers used to be configured but
      // never applied to bills.
      let resolvedDiscountPct = 0;
      if (explicitDiscount != null) {
        resolvedDiscountPct = Number(explicitDiscount) || 0;
      } else if (effectiveTermMonths) {
        try {
          const { rows: cfgRows } = await pool.query(
            `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
          );
          const discounts = cfgRows[0]?.value?.discounts || {};
          if (effectiveTermMonths >= 24 && Number(discounts.twentyFourMonth) > 0) {
            resolvedDiscountPct = Number(discounts.twentyFourMonth);
          } else if (effectiveTermMonths >= 12 && Number(discounts.twelveMonth) > 0) {
            resolvedDiscountPct = Number(discounts.twelveMonth);
          } else if (effectiveTermMonths >= 6 && Number(discounts.sixMonth) > 0) {
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
      let endDate = requestedEndDate;
      if (!endDate && effectiveTermMonths) {
        endDate = addContractMonths(moveInDate, Number(effectiveTermMonths));
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
        if (!isForced && existing.status === 'active' && existing.current_room_id === roomId) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `ผู้เช่ารายนี้ย้ายเข้าห้อง ${roomId} อยู่แล้ว`,
            code: 'TENANT_ALREADY_CHECKED_IN',
            currentRoom: existing.current_room_id,
            hint: 'ใช้สัญญาเดิม/หน้าสัญญาเดิมต่อ หรือ check-out ก่อนหากต้องการเริ่มสัญญาใหม่',
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

        // (5) Rent sanity against the locked room price. Positive-but-tiny
        // values (201/555) are more dangerous than 0 because they pass the
        // old "must be >0" checks and then become the legal monthly_rent.
        // Compare the entered rent with the room resolver reference before
        // writing tenant/room/contract state.
        let pricingConfig = {};
        try {
          const cfgQ = await client.query(
            `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
          );
          pricingConfig = cfgQ.rows[0]?.value || {};
        } catch { /* keep default pricing reference */ }
        let blobRoomForRent = null;
        const roomBlobQ = await client.query(
          `SELECT value FROM app_data WHERE key='baankarn_rooms_v1' FOR UPDATE`
        );
        const roomsForRent = roomBlobQ.rows.length && roomBlobQ.rows[0].value
          && typeof roomBlobQ.rows[0].value === 'object'
          ? roomBlobQ.rows[0].value
          : {};
        blobRoomForRent = roomsForRent[roomId] || null;
        let roomV2ForRent = null;
        try {
          const roomV2Q = await client.query(
            `SELECT room_code, room_type, floor, room_no, rent_price, deposit_price,
                    wifi_fee, status, rent_override, rent_override_reason,
                    view_type, has_balcony, has_parking, has_kitchen, has_ac
               FROM rooms_v2
              WHERE room_code=$1 AND deleted_at IS NULL
              FOR UPDATE`,
            [roomId]
          );
          roomV2ForRent = roomV2Q.rows[0] || null;
        } catch (err) {
          if (err.code !== '42P01') throw err;
        }
        if (!blobRoomForRent && !roomV2ForRent && !isForced) {
          await client.query('ROLLBACK');
          return res.status(404).json({
            error: `ไม่พบห้อง ${roomId} ในระบบ — ตรวจเลขห้องก่อน check-in`,
            code: 'ROOM_NOT_FOUND',
            requestedRoom: roomId,
          });
        }
        let activeRoomContract = null;
        try {
          const cQ = await client.query(
            `SELECT id, contract_no, tenant_id, locked_at
               FROM contracts
              WHERE room_id=$1 AND status='active' AND deleted_at IS NULL
              ORDER BY locked_at DESC NULLS LAST, created_at DESC
              LIMIT 1
              FOR UPDATE`,
            [roomId]
          );
          activeRoomContract = cQ.rows[0] || null;
        } catch (err) {
          if (err.code !== '42P01') throw err;
        }
        if (activeRoomContract) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `ห้อง ${roomId} มีสัญญา active อยู่แล้ว (${activeRoomContract.contract_no || activeRoomContract.id})`,
            code: 'ROOM_CONTRACT_EXISTS',
            conflict: activeRoomContract,
            hint: 'ใช้สัญญาเดิม ปิด/ยกเลิกสัญญาเดิม หรือ reconcile ห้องก่อน check-in เพื่อป้องกันห้องเดียวมีหลายสัญญา',
            nextActions: {
              contractsUrl: `/admin#contracts?room=${encodeURIComponent(roomId)}&contract=${encodeURIComponent(activeRoomContract.id)}`,
              roomUrl: `/admin#rooms?room=${encodeURIComponent(roomId)}`,
            },
          });
        }
        const checkinRoomStatuses = [blobRoomForRent?.status, roomV2ForRent?.status]
          .filter(Boolean)
          .map((s) => String(s));
        const blockingRoomStatus = checkinRoomStatuses.find((s) => !isVacantStatus(s));
        if (!isForced && blockingRoomStatus) {
          const reservedBy = blobRoomForRent?.reservedBy ? String(blobRoomForRent.reservedBy) : null;
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: blockingRoomStatus === 'reserved'
              ? `ห้อง ${roomId} ถูกล็อก/จองไว้แล้ว`
              : `ห้อง ${roomId} ไม่พร้อมย้ายเข้า (${blockingRoomStatus})`,
            code: blockingRoomStatus === 'reserved'
              ? 'ROOM_RESERVED'
              : (blockingRoomStatus === 'occupied' ? 'ROOM_OCCUPIED' : 'ROOM_UNAVAILABLE'),
            currentStatus: blockingRoomStatus,
            reservedBy,
            hint: reservedBy
              ? 'เปิดรายการจองหรือสัญญาที่ล็อกห้องนี้ไว้ แล้วอนุมัติ/ยกเลิก/ปิดรายการเดิมก่อน check-in'
              : 'ตรวจสถานะห้องให้ว่างก่อน check-in หรือใช้ force=true เฉพาะงานแก้ข้อมูลย้อนหลังที่ตรวจสอบแล้ว',
            nextActions: {
              roomUrl: `/admin#rooms?room=${encodeURIComponent(roomId)}`,
              bookingsUrl: `/admin#bookings?room=${encodeURIComponent(roomId)}`,
              contractsUrl: `/admin#contracts?room=${encodeURIComponent(roomId)}`,
            },
          });
        }
        const resolvedCheckinRent = pricing.resolveBillingRent({
          room: blobRoomForRent || roomV2ForRent,
          config: pricingConfig,
        });
        const resolvedCheckinRentValue = Number(resolvedCheckinRent.rent);
        const effectiveMonthlyRent = Number.isFinite(resolvedCheckinRentValue) && resolvedCheckinRentValue > 0
          ? resolvedCheckinRentValue
          : Number(monthlyRent);
        // Deposit follows the same contract-pricing resolver used by the
        // pricing impact guard: current /admin#pricing deposit template first,
        // then a room-level deposit snapshot, then the 2-month convention. The
        // request's depositAmount remains only a last legacy fallback.
        const resolvedCheckinDeposit = pricing.resolveContractDeposit({
          room: blobRoomForRent || roomV2ForRent,
          config: pricingConfig,
          rent: effectiveMonthlyRent,
        });
        const resolvedCheckinDepositValue = Number(resolvedCheckinDeposit.deposit);
        const effectiveDepositAmount = Number.isFinite(resolvedCheckinDepositValue) && resolvedCheckinDepositValue >= 0
          ? resolvedCheckinDepositValue
          : Number(depositAmount);
        const rentAssessment = pricing.assessContractRent({
          monthlyRent: effectiveMonthlyRent,
          room: blobRoomForRent || roomV2ForRent,
          config: pricingConfig,
        });
        if (!isForced && !rentAssessment.ok) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: rentAssessment.referenceRent > 0
              ? `ค่าเช่า ${effectiveMonthlyRent} ต่ำผิดปกติสำหรับห้อง ${roomId} (ราคาอ้างอิง ${rentAssessment.referenceRent}, ขั้นต่ำที่ยอมรับ ${rentAssessment.minimumRent})`
              : `ค่าเช่า ${effectiveMonthlyRent} ต่ำผิดปกติ (ขั้นต่ำที่ยอมรับ ${rentAssessment.minimumRent})`,
            code: rentAssessment.code || 'CONTRACT_RENT_TOO_LOW',
            field: rentAssessment.field,
            monthlyRent: rentAssessment.rent,
            minimumRent: rentAssessment.minimumRent,
            referenceRent: rentAssessment.referenceRent,
            referenceSource: rentAssessment.referenceSource,
            hint: 'ตรวจว่าพิมพ์ตกศูนย์หรือไม่ ถ้าเป็นงาน migrate ข้อมูลเก่าจริง ๆ ให้ส่ง { force: true } และระบบจะ audit-log',
          });
        }
        // (2 continued) Deposit cap on the value that will actually be
        // stored. Refusing (instead of storing an over-cap deposit) keeps
        // the contract honest with the operator's own configured maximum —
        // fix the room's deposit_price / the cap, or force for specials.
        const maxDeposit = depositMaxMonths * effectiveMonthlyRent;
        if (!isForced && effectiveDepositAmount > maxDeposit) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `เงินมัดจำ (${effectiveDepositAmount}) มากกว่า ${depositMaxMonths} เท่าของค่าเช่ารายเดือน (สูงสุด ${maxDeposit})`,
            code: 'DEPOSIT_TOO_LARGE',
            monthlyRent: effectiveMonthlyRent,
            depositAmount: effectiveDepositAmount,
            maxDeposit, depositMaxMonths,
            hint: 'ปรับมัดจำของห้อง (deposit_price) หรือเพดาน depositMaxMonths ให้สอดคล้องกัน หรือส่ง { force: true } ถ้าเป็น deposit พิเศษ',
          });
        }

        // (6) Identity / address / emergency contact required when the
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
        // Disambiguate contract_no per tenancy. A tenant who moved out and
        // re-checks in the SAME calendar year would otherwise collide on
        // `C-<year>-<id>`, and the ON CONFLICT DO NOTHING below silently created
        // NO contract — leaving the tenant active + room occupied + a welcome
        // bill but with no active contract row, so a later checkout closes 0 rows
        // (no closing bill, deposit refund never recorded). Suffix with the count
        // of this tenant's prior contracts so each tenancy gets a distinct number.
        const _cyear = new Date().getFullYear();
        const _priorContracts = await client.query(
          `SELECT COUNT(*)::int AS n FROM contracts WHERE tenant_id=$1`, [id]
        );
        const _cseq = (_priorContracts.rows[0]?.n || 0) + 1;
        const contractNo = _cseq > 1
          ? `C-${_cyear}-${String(id).padStart(4, '0')}-${_cseq}`
          : `C-${_cyear}-${String(id).padStart(4, '0')}`;
        const termsVersion = agreedTermsVersion || tenancy.termsVersion || null;
        let contractIns;
        try {
          contractIns = await client.query(
            `INSERT INTO contracts (contract_no, tenant_id, room_id, start_date, end_date,
                                    monthly_rent, deposit, status, term_months, discount_pct,
                                    agreed_terms_at, agreed_terms_version)
             VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, 'active', $8, $9,
                     CASE WHEN $10::text IS NOT NULL THEN NOW() ELSE NULL END, $10)
             ON CONFLICT (contract_no) DO NOTHING
             RETURNING id`,
            [contractNo, id, roomId, moveInDate, endDate,
             effectiveMonthlyRent, effectiveDepositAmount, effectiveTermMonths || null, resolvedDiscountPct,
             termsVersion]
          );
        } catch (err) {
          if (err.code !== '42703') throw err;  // pre-migration deploy
          contractIns = await client.query(
            `INSERT INTO contracts (contract_no, tenant_id, room_id, start_date, end_date,
                                    monthly_rent, deposit, status, term_months, discount_pct)
             VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, 'active', $8, $9)
             ON CONFLICT (contract_no) DO NOTHING
             RETURNING id`,
            [contractNo, id, roomId, moveInDate, endDate,
             effectiveMonthlyRent, effectiveDepositAmount, effectiveTermMonths || null, resolvedDiscountPct]
          );
        }
        if (!contractIns.rows.length) {
          // The per-tenancy suffix should make this impossible, but never proceed
          // with a contract-less "active" tenancy — fail loudly instead of the
          // old silent no-op.
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'ไม่สามารถสร้างสัญญา (เลขที่สัญญาซ้ำ) — กรุณาลองใหม่',
            code: 'CONTRACT_NO_CONFLICT',
          });
        }

        // Create welcome bill draft for the move-in period (NOT wallclock).
        // If a tenant moved in on Jan 31 but admin processes the checkin at
        // 00:05 Feb 1, using `new Date()` stamps the welcome bill as period
        // 2026-02 — wrong: tenant gets a Jan-period bill they never received,
        // and the Feb auto-bill uses the same room+period and either dups or
        // is blocked by uq_bills_room_period_tenant_active.
        //
        // If config.discounts.firstMonth is set, stack it on top of the
        // contract discount we just resolved (multiplicative — 10% + 5% =
        // 14.5%, not 15%, capped at 50%). This is what makes the
        // "first-month-X%-off" promotion in /admin#pricing actually fire.
        const moveInMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(moveInDate);
        const period = moveInMatch
          ? `${moveInMatch[1]}-${moveInMatch[2]}`
          : `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
        let billNo = billing.makeBillNo(roomId, period);
        const billNoCheck = await client.query(
          `SELECT tenant_id FROM bills
             WHERE bill_no=$1 AND deleted_at IS NULL
             LIMIT 1
             FOR UPDATE`,
          [billNo]
        );
        const existingBillTenantId = billNoCheck.rows[0]?.tenant_id;
        if (billNoCheck.rows.length && Number(existingBillTenantId || 0) !== Number(id)) {
          billNo = billing.makeBillNo(roomId, period, { tenantId: id });
        }
        // Load config once — due day, first-month discount, and proration all
        // come from it. A missing blob degrades to defaults (full rent, day 15).
        let cfgVal = null;
        try {
          const { rows: cfgR } = await client.query(
            `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
          );
          cfgVal = cfgR[0]?.value || null;
        } catch { /* config blob missing — use defaults below */ }
        // Due day from config.notify.dueOnDay (clamped 1-28, default 15) so the
        // move-in bill agrees with recurring bills + the signed contract PDF —
        // previously hardcoded to 15, contradicting an operator's configured day.
        // NOTE: a check-in-created contract has no terms snapshot yet (it locks
        // later, at sign/approve, capturing the SAME config value) — so config
        // IS the signed day here. The per-contract precedence
        // (billing.resolveBillDueDay) applies from the first recurring bill on.
        const rawDueDay = Number(cfgVal?.notify?.dueOnDay);
        const dueDay = Number.isFinite(rawDueDay) ? Math.max(1, Math.min(28, rawDueDay)) : 15;
        // Build dueDate from the period (not wallclock) using the same
        // formatYMD path scheduler/bulk-generate use, so back-dated check-ins
        // produce a due date in the move-in month rather than the current
        // calendar month.
        let dueDate = moveInMatch
          ? billing.formatYMD(Number(moveInMatch[1]), Number(moveInMatch[2]), dueDay)
          : billing.formatDueDate(dueDay);
        // Floor: the welcome bill must never be born overdue. A move-in after
        // the configured due day — or a back-dated check-in (allowed up to
        // moveInPastDays) — would otherwise mint a bill that tickLateFee
        // flips to 'overdue' + fines on its next daily tick, a penalty the
        // tenant never had a chance to avoid. When the period's due day is
        // already behind the later of move-in/today, give the same 7-day pay
        // window the checkout closing bill uses.
        const dueFloorBase = [moveInDate, billing.localTodayYmd()]
          .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')))
          .sort()
          .pop();
        if (dueFloorBase && dueDate < dueFloorBase) {
          const floored = new Date(new Date(`${dueFloorBase}T00:00:00Z`).getTime() + 7 * 86_400_000);
          dueDate = billing.formatYMD(
            floored.getUTCFullYear(), floored.getUTCMonth() + 1, floored.getUTCDate()
          );
        }

        // === Capture starting meter readings for THIS tenancy ================
        // A room reused from a previous tenant already shows a meter value. By
        // storing the move-in reading as the baseline (period = move-in period),
        // the next bill measures THIS tenant's consumption (nextReading −
        // startReading), never the previous tenant's. Stored inside the same
        // transaction as the check-in so it commits atomically. Flat-mode
        // utilities skip this (they aren't metered). Robust guards:
        //   • backward reading (start < room's last reading) → refuse unless force
        //   • policy 'required' + metered utility with no start → refuse unless force
        const billRoomObj = (roomsForRent && typeof roomsForRent === 'object' && roomsForRent[roomId])
          ? roomsForRent[roomId] : {};
        const meterStartResult = { water: null, elec: null };
        for (const mt of ['water', 'elec']) {
          const label = mt === 'water' ? 'น้ำ' : 'ไฟ';
          if (billing.isFlatUtilityConfigured(billRoomObj, mt)) {
            meterStartResult[mt] = { skipped: 'flat_mode' };  // เหมาจ่าย — ไม่ต้องใช้เลขมิเตอร์
            continue;
          }
          const startVal = mt === 'water' ? waterStart : elecStart;
          let prevReading = null;
          try { prevReading = await meter.latestBeforePeriod(client, roomId, mt, period); }
          catch (err) { if (err.code !== '42P01') throw err; }
          // Guard against the room's LAST reading, not just last-before-period:
          // a reading already recorded in the move-in month (e.g. by the
          // previous tenant's checkout) is invisible to latestBeforePeriod, so
          // a too-low baseline would pass and record()'s same-period upsert
          // would silently overwrite (destroy) it. Compare against whichever
          // known reading is highest — meters only count up.
          let latestReading = null;
          try { latestReading = await meter.latest(client, roomId, mt); }
          catch (err) { if (err.code !== '42P01') throw err; }
          const guardReading = [prevReading, latestReading]
            .filter((r) => r && Number.isFinite(Number(r.reading)))
            .sort((a, b) => Number(b.reading) - Number(a.reading))[0] || null;
          if (startVal == null) {
            if (meterStartPolicy === 'required' && !isForced) {
              await client.query('ROLLBACK');
              return res.status(400).json({
                error: `ต้องระบุเลขมิเตอร์${label}ตั้งต้นของห้อง ${roomId} (นโยบายตั้งค่าเป็น "บังคับ")`,
                code: 'METER_START_REQUIRED',
                meterType: mt,
                hint: 'กรอกเลขมิเตอร์ปัจจุบันที่อ่านจากหน้าห้อง หรือส่ง force=true ถ้าต้องการข้าม',
              });
            }
            meterStartResult[mt] = { skipped: 'not_provided' };
            continue;
          }
          if (guardReading && Number(guardReading.reading) > startVal && !isForced) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: `เลขมิเตอร์${label}ตั้งต้น (${startVal}) น้อยกว่าเลขล่าสุดของห้อง (${guardReading.reading}) — มิเตอร์ไม่ควรถอยหลัง`,
              code: 'METER_START_BACKWARD',
              meterType: mt,
              lastReading: Number(guardReading.reading),
              hint: 'ตรวจเลขที่กรอกอีกครั้ง — ถ้ามิเตอร์ถูกเปลี่ยน/รีเซ็ตจริง ส่ง force=true',
            });
          }
          try {
            await meter.record(client, {
              roomId, meterType: mt, reading: startVal,
              period, source: 'checkin', createdBy: req.session.user.username,
              // Backward-reading policy is enforced by the METER_START_BACKWARD
              // guard above (force-escapable + audit-logged) — don't double-block
              // a forced reset inside record().
              allowRollback: true,
            });
            meterStartResult[mt] = {
              reading: startVal, stored: true,
              prev: prevReading ? Number(prevReading.reading) : null,
            };
          } catch (err) {
            await client.query('ROLLBACK');
            console.error(`[checkin] meter start (${mt}) failed:`, err.message);
            return res.status(500).json({
              error: `บันทึกเลขมิเตอร์${label}ตั้งต้นไม่สำเร็จ — ลองใหม่`,
              code: 'METER_START_STORE_FAILED',
            });
          }
        }

        let welcomeRent = Number(effectiveMonthlyRent) || 0;
        // Days-lived fraction for the move-in month. Flat charges (wifi / common
        // fee / flat-mode utilities) are prorated by occupancy so a mid-month
        // move-in pays only for the days lived (operator-chosen policy). Rent
        // proration stays opt-in via config.billing.prorateFirstMonth. Metered
        // water/elec are NOT on the welcome bill — their first consumption is
        // measured next cycle from the baseline captured above.
        let flatFrac = 1;
        if (moveInMatch) {
          const _dim = new Date(Date.UTC(Number(moveInMatch[1]), Number(moveInMatch[2]), 0)).getUTCDate();
          flatFrac = billing.firstMonthProrationFraction({
            moveInDay: Number(moveInMatch[3]), daysInMonth: _dim, prorate: true,
          });
        }
        {
          const firstMonthPct = Math.max(0, Math.min(50,
            Number(cfgVal?.discounts?.firstMonth) || 0));
          const contractPct = Math.max(0, Math.min(50, resolvedDiscountPct));
          const combinedPct = Math.min(50,
            100 * (1 - (1 - contractPct / 100) * (1 - firstMonthPct / 100)));
          welcomeRent = Math.round(welcomeRent * (1 - combinedPct / 100) * 100) / 100;
          if (cfgVal?.billing?.prorateFirstMonth === true && moveInMatch) {
            welcomeRent = Math.round(welcomeRent * flatFrac * 100) / 100;
          }
        }
        // Resolve the room's flat (non-metered) charges, mirroring buildBill's
        // override→global precedence, then prorate by days lived.
        const _util = (cfgVal && typeof cfgVal.utilities === 'object') ? cfgVal.utilities : {};
        const _pickNum = (...vals) => {
          for (const v of vals) {
            if (v != null && v !== '' && Number.isFinite(Number(v))) return Math.max(0, Number(v));
          }
          return 0;
        };
        const r2 = (n) => Math.round(n * 100) / 100;
        const wifiAmt = r2(_pickNum(billRoomObj.wifiOverride, billRoomObj.wifi_override, billRoomObj.wifi, _util.wifi) * flatFrac);
        const commonAmt = r2(_pickNum(billRoomObj.commonFeeOverride, billRoomObj.common_fee_override, billRoomObj.commonFee, billRoomObj.common_fee, _util.commonFee) * flatFrac);
        const waterAmt = r2((billing.isFlatUtilityConfigured(billRoomObj, 'water')
          ? _pickNum(billRoomObj.waterFlatAmount, billRoomObj.water_flat_amount) : 0) * flatFrac);
        const elecAmt = r2((billing.isFlatUtilityConfigured(billRoomObj, 'elec')
          ? _pickNum(billRoomObj.elecFlatAmount, billRoomObj.elec_flat_amount) : 0) * flatFrac);
        const welcomeOther = commonAmt > 0
          ? [{ label: `ค่าส่วนกลาง${flatFrac < 1 ? ' (ตามวันที่อยู่)' : ''}`, amount: commonAmt }]
          : [];
        const welcomeSubtotal = r2(welcomeRent + wifiAmt + waterAmt + elecAmt + commonAmt);
        // VAT parity with billing.buildBill (R1): rent + utilities + wifi +
        // common fee are the vatable revenue stream, so the move-in month
        // must carry VAT exactly like every recurring bill — otherwise a
        // VAT-registered operator under-collects on every check-in.
        const welcomeVat = flags?.vat?.enabled
          ? r2(welcomeSubtotal * (Number(flags.vat.ratePct || 0) / 100))
          : 0;
        const welcomeTotal = r2(welcomeSubtotal + welcomeVat);
        // Skip a zero-total welcome bill (e.g. free first month) — the bills
        // CHECK requires total > 0, and there's nothing to collect anyway.
        let welcomeBillSkipped = null;
        if (welcomeSubtotal > 0) {
          // A same-month checkout already left this tenant a non-void bill
          // for (room, period) — e.g. the '-X' closing bill when the tenant
          // changes their mind and re-checks in. A fresh bill_no does NOT
          // escape uq_bills_room_period_tenant_active (room_id, period,
          // tenant_id), so inserting would 23505 and roll back the whole
          // check-in. Skip the welcome bill instead — the period is already
          // billed for this tenant — and surface that in the response.
          const periodBill = await client.query(
            `SELECT bill_no FROM bills
               WHERE room_id=$1 AND period=$2 AND tenant_id=$3
                 AND deleted_at IS NULL AND status<>'void'
               LIMIT 1
               FOR UPDATE`,
            [roomId, period, id]
          );
          if (periodBill.rows.length) {
            welcomeBillSkipped = {
              reason: 'period_already_billed',
              existingBillNo: periodBill.rows[0].bill_no,
            };
          } else {
            const wIns = await client.query(
              `INSERT INTO bills
                 (bill_no, tenant_id, room_id, period, rent,
                  water_amount, elec_amount, wifi, other,
                  subtotal, vat, late_fee, total, due_date, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, 0, $12, $13, 'pending')
               ON CONFLICT (bill_no) DO NOTHING
               RETURNING id`,
              [billNo, id, roomId, period, welcomeRent,
               waterAmt, elecAmt, wifiAmt, JSON.stringify(welcomeOther),
               welcomeSubtotal, welcomeVat, welcomeTotal, dueDate]
            );
            // The period pre-check above ignores VOID bills, but a void bill
            // still owns its bill_no — the ON CONFLICT skip would otherwise
            // leave the tenant with NO first bill and nobody told. Surface
            // it the same way as period_already_billed so the admin sees
            // "ออกบิลแรกเองที่หน้า บิล" instead of assuming it exists.
            if (wIns.rowCount === 0) {
              welcomeBillSkipped = {
                reason: 'bill_no_conflict',
                existingBillNo: billNo,
              };
            }
          }
        }

        await client.query('COMMIT');
        // Cascade room status post-commit. The blob + rooms_v2 updates above
        // set the room to 'occupied' directly, but if a cron tick raced the
        // checkin and saw a stale state (e.g. an old contract still 'active'),
        // the room could drift. syncRoom re-derives from authoritative sources
        // (contracts + active bills + reservation pointer) so the result
        // matches what /admin#rooms shows.
        require('../services/roomStatus').syncRoom(pool, roomId, { reason: 'tenant-checkin' })
          .catch((err) => console.warn(`[checkin] room sync failed:`, err.message));
        audit(req, 'tenant.checkin', 'tenant', String(id),
          { roomId, depositAmount: effectiveDepositAmount, monthlyRent: effectiveMonthlyRent, contractNo,
            forced: isForced, missingAtCheckin: missing });
        if (isForced) {
          // Surface forced bypasses to admin via owner notify so the
          // operator who clicked "force anyway" can be reviewed later.
          notifier.notifyOwner({ pool, features: flags }, {
            category: 'security',
            subject: '⚠️ checkin ใช้ force=true bypass safety guards',
            text: `tenantId=${id} room=${roomId} by=${req.session.user.username}\n`
              + `missing=${missing.join(',') || 'none'}\n`
              + `monthlyRent=${effectiveMonthlyRent} deposit=${effectiveDepositAmount}`,
          }).catch(() => {});
        }
        // Move-in event for the whole admin team (owner + every bound admin
        // recipient): which room, who, on what terms. Fires for EVERY
        // check-in — the force alert above stays a separate security signal.
        notifier.notifyOwner({ pool, features: flags }, {
          category: 'tenancy',
          subject: `🏠 ย้ายเข้า — ห้อง ${roomId}`,
          text: [
            `ผู้เช่า: ${existing.full_name || `#${id}`}${existing.phone ? ` (${existing.phone})` : ''}`,
            `ห้อง: ${roomId} · เข้าพัก: ${moveInDate}`,
            `ค่าเช่า: ฿${Number(effectiveMonthlyRent).toLocaleString('th-TH')}/เดือน · มัดจำ: ฿${Number(effectiveDepositAmount).toLocaleString('th-TH')}`,
            `สัญญา: ${contractNo}${endDate ? ` (ถึง ${endDate})` : ' (ไม่กำหนดวันสิ้นสุด)'}`,
            welcomeBillSkipped
              ? (welcomeBillSkipped.reason === 'bill_no_conflict'
                ? `⚠️ บิลแรกไม่ถูกสร้าง — เลขบิล ${welcomeBillSkipped.existingBillNo} ชนกับบิลที่ถูกยกเลิก (void) ไว้ · ออกบิลเองที่ /admin#billing`
                : `บิลแรก: ใช้บิลเดิม ${welcomeBillSkipped.existingBillNo} (รอบ ${period} ออกบิลแล้ว)`)
              : `บิลแรก: ${billNo} รอบ ${period} ครบกำหนด ${dueDate}`,
            `ดำเนินการโดย: ${req.session.user.username}`,
          ].join('\n'),
        }).catch(() => {});

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
          // Skip when no welcome bill was created (period already billed by a
          // same-month closing bill) — don't tell the tenant a bill number
          // that doesn't exist.
          if (tQ.rows.length && !welcomeBillSkipped) {
            const amtStr = Number(welcomeRent).toLocaleString(
              'th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }
            );
            const discountNote = welcomeRent < Number(effectiveMonthlyRent)
              ? `\n💸 รวมส่วนลด — ปกติ ฿${Number(effectiveMonthlyRent).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`
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
                `   1) เข้าพอร์ทัลผู้เช่าที่ /tenant ด้วยเบอร์โทรที่ผูกกับห้อง`,
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

        res.json({
          ok: true, tenant, contractNo,
          billNo: welcomeBillSkipped ? null : billNo,
          welcomeBillSkipped,
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (isActiveRoomUniqueViolation(err)) {
          return res.status(409).json({
            error: `ห้อง ${roomId} มีผู้เช่า active อยู่แล้ว — check-in ซ้ำไม่ได้`,
            code: 'ROOM_OCCUPIED',
            constraint: ACTIVE_ROOM_CONSTRAINT,
            roomId,
            hint: 'ตรวจรายชื่อผู้เช่าของห้องนี้ แล้ว checkout/ปิดสัญญาเดิมก่อน check-in ผู้เช่าใหม่',
          });
        }
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
      const reason = String(req.body.reason || '').trim();
      if (reason.length < 5) {
        return res.status(400).json({
          error: 'reason is required when checking out or cancelling a contract',
          code: 'CONTRACT_CLOSE_REASON_REQUIRED',
          hint: 'ระบุเหตุผลอย่างน้อย 5 ตัวอักษร เช่น ผู้เช่าออกก่อนกำหนด / ยกเลิกตามตกลง / หมดอายุตามกำหนด',
        });
      }
      const refund = req.body.finalDepositReturn != null ? Number(req.body.finalDepositReturn) : null;
      // Default true so admin doesn't have to opt-in for the common case.
      // Admin can pass generateClosingBill:false on the last-day-of-month
      // case where the regular monthly bill already covers the full period.
      const wantClosingBill = req.body.generateClosingBill !== false;
      // Feature flags drive VAT on the closing bill (parity with buildBill).
      let flags;
      try { flags = await features.load(pool); }
      catch { flags = {}; }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tres = await client.query(
          `SELECT id, full_name, current_room_id, line_user_id, line_oa_id, email, phone, status
             FROM tenants WHERE id=$1 AND deleted_at IS NULL
             FOR UPDATE`,
          [id]
        );
        if (!tres.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'tenant not found' });
        }
        const tenant = tres.rows[0];
        const tenantCurrentRoom = tenant.current_room_id ? String(tenant.current_room_id) : null;

        // Mark tenant moved_out
        await client.query(
          `UPDATE tenants SET status='moved_out', current_room_id=NULL, updated_at=NOW(),
             notes = COALESCE(notes,'') || CASE WHEN $2::text IS NOT NULL THEN E'\n[checkout] ' || $2::text ELSE '' END
           WHERE id=$1`,
          [id, reason]
        );
        await client.query(`DELETE FROM tenant_sessions WHERE tenant_id=$1`, [id]);

        // Close active contract + persist refund amount on the row so it
        // appears in reports / aged-receivable views without joining audit_logs.
        // deposit_returned is CLAMPED to the contract's own deposit (LEAST) so a
        // typo'd over-refund (finalDepositReturn > deposit) can't push the
        // "deposit retained = deposit − returned" reconciliation negative.
        // The refund lands on exactly ONE contract: force-checkin can leave a
        // tenant with two active contracts (room migration), and stamping the
        // same payout on every row double-counts it in deposit-retained
        // reconciliation. Prefer the contract for the room the tenant
        // currently occupies; fall back to the most recent tenancy.
        const refundTargetQ = await client.query(
          `SELECT id FROM contracts
             WHERE tenant_id=$1 AND status='active'
             ORDER BY (room_id = $2) DESC NULLS LAST,
                      start_date DESC NULLS LAST, id DESC
             LIMIT 1
             FOR UPDATE`,
          [id, tenantCurrentRoom]
        );
        const refundContractId = refundTargetQ.rows[0] ? Number(refundTargetQ.rows[0].id) : null;
        const contractRes = await client.query(
          `UPDATE contracts SET status='ended', end_date=CURRENT_DATE,
              closed_at = COALESCE(closed_at, NOW()),
              closed_by = $4,
              closed_reason = $3,
              closed_type = 'tenant_checkout',
              deposit_returned = CASE WHEN $2::numeric IS NOT NULL AND id=$5 THEN LEAST($2::numeric, deposit) ELSE NULL END,
              deposit_returned_at = CASE WHEN $2::numeric IS NOT NULL AND id=$5 THEN NOW() ELSE NULL END,
              deposit_return_reason = CASE WHEN id=$5 THEN $3 ELSE NULL END
             WHERE tenant_id=$1 AND status='active'
           RETURNING id, contract_no, room_id, start_date, monthly_rent, deposit, deposit_returned, discount_pct`,
          [id, refund, reason, req.session.user.username, refundContractId]
        );
        const closedContracts = contractRes.rows || [];
        // RETURNING order is unspecified — pin the refund-bearing contract as
        // the primary one so the response/closing-bill use the right room.
        const closedContract = closedContracts.find((c) => Number(c.id) === refundContractId)
          || closedContracts[0] || null;
        // Report the refund that was ACTUALLY persisted (clamped, and only when
        // a contract was really closed this call) — not the raw request body. A
        // double-submitted checkout closes 0 contracts the second time, so it
        // must not re-report a phantom refund in the response / audit / message.
        const effectiveRefund = closedContract && closedContract.deposit_returned != null
          ? Number(closedContract.deposit_returned)
          : null;
        const closedContractIds = closedContracts
          .map((c) => Number(c.id))
          .filter((n) => Number.isInteger(n) && n > 0);
        const contractRooms = closedContracts
          .map((c) => c.room_id ? String(c.room_id) : '')
          .filter(Boolean);
        const releaseRoomIds = Array.from(new Set([
          tenantCurrentRoom,
          ...contractRooms,
        ].filter(Boolean)));
        const oldRoom = tenantCurrentRoom || contractRooms[0] || null;
        const roomRelease = { released: [], skipped: [] };
        const revokedInvitations = closedContractIds.length
          ? await client.query(
              `UPDATE contract_invitations
                  SET status='revoked', revoked_at=NOW(), revoked_by=$2, updated_at=NOW()
                WHERE contract_id = ANY($1::bigint[])
                  AND status IN ('pending','submitted')
                RETURNING id`,
              [closedContractIds, req.session.user.username]
            ).catch((err) => {
              if (err.code === '42P01' || err.code === '42703') return { rowCount: 0, rows: [] };
              throw err;
            })
          : { rowCount: 0, rows: [] };

        // Flip room status to vacant in BOTH JSONB blob and rooms_v2.
        const normalizedTenantPhone = String(tenant.phone || '').replace(/[\s-]/g, '');
        const contractReservationKeys = closedContractIds.map((cid) => `contract:${cid}`);
        for (const roomToRelease of releaseRoomIds) {
          // Status='vacant' AND remove room.tenant so notifications can't
          // leak to the moved-out tenant on the next bill cycle (e.g.
          // bulk-send pulled from blob → SMS to old tenant). The `-`
          // operator drops the 'tenant' top-level key from the room object.
          const blobRelease = await client.query(
            `UPDATE app_data
                SET value = jsonb_set(
                              value,
                              ARRAY[$1::text],
                              ((value->$1) - 'tenant') || jsonb_build_object('status', 'vacant')
                            ),
                    updated_at=NOW()
              WHERE key='baankarn_rooms_v1'
                AND value ? $1
                AND (
                  ((value->$1)->'tenant') IS NULL
                  OR ((value->$1)->'tenant'->>'tenantId') = $2
                  OR replace(replace(COALESCE(((value->$1)->'tenant'->>'phone'), ''), ' ', ''), '-', '') = $3
                  OR ((value->$1)->>'reservedBy') = ANY($4::text[])
                )`,
            [roomToRelease, String(id), normalizedTenantPhone, contractReservationKeys]
          );
          let roomV2Rows = 0;
          try {
            const roomV2Release = await client.query(
              `UPDATE rooms_v2 SET status='vacant', updated_at=NOW()
                 WHERE room_code=$1 AND deleted_at IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM tenants tx
                      WHERE tx.current_room_id=$1
                        AND tx.status='active'
                        AND tx.deleted_at IS NULL
                        AND tx.id<>$2
                   )`,
              [roomToRelease, id]
            );
            roomV2Rows = roomV2Release.rowCount || 0;
          } catch (err) {
            if (err.code !== '42P01') throw err;
          }
          if ((blobRelease.rowCount || 0) > 0 || roomV2Rows > 0) {
            roomRelease.released.push(roomToRelease);
          } else {
            roomRelease.skipped.push({
              roomId: roomToRelease,
              reason: 'room_not_found_or_belongs_to_another_active_tenant',
            });
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
        // Carried late fees (one_off charges an admin created via the 'carry'
        // decision) must NOT silently vanish on checkout — fold them into the
        // closing bill below so the tenant still pays what they owe. Capture
        // them first, then EXCLUDE them from the bulk auto-deactivation so they
        // survive to be folded in (or stay collectible if no closing bill runs).
        const carriedLateFeeLabelLike = `${CARRIED_LATE_FEE_LABEL_PREFIX}%`;
        const carriedLateFeeMarkerLike = `%${CARRIED_LATE_FEE_NOTE_MARKER}%`;
        const carriedLF = await client.query(
          `SELECT id, amount FROM recurring_charges
            WHERE tenant_id=$1 AND active=TRUE AND frequency='one_off'
              AND label LIKE $2
              AND (
                notes LIKE $3
                OR notes LIKE 'ยกค่าปรับล่าช้า%จากบิลรอบ%'
              )`,
          [id, carriedLateFeeLabelLike, carriedLateFeeMarkerLike]
        ).catch((err) => { if (err.code === '42P01') return { rows: [] }; throw err; });
        const carriedLateFeeRows = carriedLF.rows || [];
        const carriedLateFeeTotal = Math.round(
          carriedLateFeeRows.reduce((s, r) => s + (Number(r.amount) || 0), 0) * 100
        ) / 100;

        const deactivatedRecurring = await client.query(
          `UPDATE recurring_charges
              SET active=FALSE, updated_at=NOW(),
                  notes = COALESCE(notes,'') || E'\n[auto] deactivated on checkout at ' || NOW()::text
            WHERE tenant_id=$1 AND active=TRUE
              AND NOT (
                frequency='one_off'
                AND label LIKE $2
                AND (
                  notes LIKE $3
                  OR notes LIKE 'ยกค่าปรับล่าช้า%จากบิลรอบ%'
                )
              )
            RETURNING id, label, frequency`,
          [id, carriedLateFeeLabelLike, carriedLateFeeMarkerLike]
        ).catch((err) => {
          if (err.code === '42P01') return { rowCount: 0, rows: [] };
          throw err;
        });

        // Asia/Bangkok local-time components — checkout at 00:30 ICT
        // (UTC 17:30 prev day) on a UTC-deployed Railway server would
        // otherwise read the previous day, off-by-one'ing pro-rate +
        // potentially picking the wrong period at month boundaries.
        // The same pattern as bills (Asia/Bangkok offset +07:00 baked in).
        // Hoisted above the meter block — final readings are stamped with
        // the same period the closing bill uses.
        const utc = new Date();
        const bkk = new Date(utc.getTime() + 7 * 3600 * 1000);
        const ty = bkk.getUTCFullYear();
        const tm = bkk.getUTCMonth() + 1;
        const td = bkk.getUTCDate();
        const period = `${ty}-${String(tm).padStart(2, '0')}`;

        const billingRoom = closedContract && closedContract.room_id
          ? String(closedContract.room_id)
          : oldRoom;

        // Config + room object for utility rates / flat-mode detection. The
        // room release above only touched status/tenant, so overrides and
        // flat-amount fields are still intact here.
        let cfgVal = null;
        let billRoomObj = {};
        if (billingRoom) {
          try {
            const { rows: cfgR } = await client.query(
              `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
            );
            cfgVal = cfgR[0]?.value || null;
          } catch { /* config blob missing — fall back to defaults */ }
          try {
            const { rows: roomR } = await client.query(
              `SELECT value->$1 AS room FROM app_data WHERE key='baankarn_rooms_v1' LIMIT 1`,
              [billingRoom]
            );
            billRoomObj = roomR[0]?.room || {};
          } catch { /* rooms blob missing — treat as no overrides */ }
        }
        const utilCfg = (cfgVal && cfgVal.utilities) || {};

        // === Final meter readings for THIS tenancy ==========================
        // Mirror of check-in's baseline capture: the move-out reading closes
        // the consumption window (lastReading → endReading = the units this
        // tenant still owes). Without it the final partial period is never
        // billed — the next tenant's move-in baseline silently absorbs it.
        // Recorded inside the same transaction so a failed checkout doesn't
        // leave orphan readings. Flat-mode utilities skip (not metered).
        const allowMeterRollback = req.body.allowMeterRollback === true;
        const meterEndInput = {
          water: req.body.waterEndReading != null ? Number(req.body.waterEndReading) : null,
          elec: req.body.elecEndReading != null ? Number(req.body.elecEndReading) : null,
        };
        const meterFinal = { water: null, elec: null };
        const meterCharges = { water: 0, elec: 0 };
        if (billingRoom) {
          for (const mt of ['water', 'elec']) {
            const label = mt === 'water' ? 'น้ำ' : 'ไฟ';
            if (billing.isFlatUtilityConfigured(billRoomObj, mt)) {
              meterFinal[mt] = { skipped: 'flat_mode' };
              continue;
            }
            const endVal = meterEndInput[mt];
            let prevRow = null;
            try { prevRow = await meter.latest(client, billingRoom, mt); }
            catch (err) { if (err.code !== '42P01') throw err; }
            if (endVal == null) {
              meterFinal[mt] = {
                skipped: 'not_provided',
                lastReading: prevRow ? Number(prevRow.reading) : null,
              };
              continue;
            }
            if (prevRow && Number(prevRow.reading) > endVal && !allowMeterRollback) {
              await client.query('ROLLBACK');
              return res.status(409).json({
                error: `เลขมิเตอร์${label}สุดท้าย (${endVal}) น้อยกว่าเลขล่าสุดของห้อง (${prevRow.reading}) — มิเตอร์ไม่ควรถอยหลัง`,
                code: 'METER_END_BACKWARD',
                meterType: mt,
                lastReading: Number(prevRow.reading),
                hint: 'ตรวจเลขที่กรอกอีกครั้ง — ถ้ามิเตอร์ถูกเปลี่ยน/รีเซ็ตจริง ส่ง allowMeterRollback=true',
              });
            }
            try {
              await meter.record(client, {
                roomId: billingRoom, meterType: mt, reading: endVal,
                period, source: 'checkout', createdBy: req.session.user.username,
                // Backward readings already passed the explicit guard above.
                allowRollback: true,
              });
            } catch (err) {
              await client.query('ROLLBACK');
              console.error(`[checkout] meter end (${mt}) failed:`, err.message);
              return res.status(500).json({
                error: `บันทึกเลขมิเตอร์${label}สุดท้ายไม่สำเร็จ — ลองใหม่`,
                code: 'METER_END_STORE_FAILED',
              });
            }
            const prevNum = prevRow ? Number(prevRow.reading) : null;
            const units = prevNum != null
              ? Math.max(0, Math.round((endVal - prevNum) * 100) / 100)
              : 0;
            const globalRate = mt === 'water'
              ? Number(utilCfg.waterRate ?? 18)
              : Number(utilCfg.elecRate ?? 8);
            const overrideRaw = mt === 'water'
              ? (billRoomObj.waterRateOverride ?? billRoomObj.water_rate_override)
              : (billRoomObj.elecRateOverride ?? billRoomObj.elec_rate_override);
            const overrideNum = Number(overrideRaw);
            const rate = Number.isFinite(overrideNum) && overrideNum > 0
              ? overrideNum
              : (Number.isFinite(globalRate) && globalRate > 0 ? globalRate : 0);
            const amount = Math.round(units * rate * 100) / 100;
            meterCharges[mt] = amount;
            meterFinal[mt] = { reading: endVal, prev: prevNum, units, rate, amount, stored: true };
          }
        }
        // Metered utilities the admin left blank — surfaced in the response,
        // owner alert, and audit so "ลืมจดมิเตอร์" is loud instead of silent
        // lost revenue.
        const meterSkippedTypes = ['water', 'elec'].filter(
          (mt) => meterFinal[mt] && meterFinal[mt].skipped === 'not_provided'
        );

        // Pro-rate closing bill: rent × (days_lived_this_period / days_in_month)
        // + final metered consumption + prorated flat charges (wifi / common
        // fee / flat-mode utilities), mirroring the welcome bill's treatment
        // of flat charges so move-in and move-out months are symmetric.
        // Only generate when there's no monthly bill already covering this
        // period — the partial-unique index uq_bills_room_period_tenant_active
        // would block a duplicate anyway, but we want a clean result not
        // a 23505 error.
        let closingBill = null;
        let closingBillDetail = null;
        if (wantClosingBill && billingRoom && closedContract) {
          // Skip only if this tenant already has a closing bill for the
          // room+period. Another tenant can legitimately have a bill for the
          // same room+period after a mid-month move.
          const dup = await client.query(
            `SELECT id FROM bills
               WHERE room_id=$1 AND period=$2 AND tenant_id=$3
                 AND deleted_at IS NULL AND status<>'void'
               LIMIT 1`,
            [billingRoom, period, id]
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
            const billNo = billing.makeBillNo(`${billingRoom}-X`, period, { tenantId: id });
            const dueDate = billing.formatYMD(ty, tm, Math.min(daysInMonth, daysLived + 7));
            // Utility charges for the final partial month, mirroring the
            // welcome bill: metered water/elec use the consumption computed
            // from the final readings above (full charge — usage is usage);
            // flat-mode utilities + wifi + common fee are prorated by days
            // lived so the move-out month is charged the same way the
            // move-in month was.
            const r2 = (n) => Math.round(n * 100) / 100;
            const pickNum = (...vals) => {
              for (const v of vals) {
                const n = Number(v);
                if (Number.isFinite(n) && n > 0) return n;
              }
              return 0;
            };
            const closingWater = billing.isFlatUtilityConfigured(billRoomObj, 'water')
              ? r2(pickNum(billRoomObj.waterFlatAmount, billRoomObj.water_flat_amount) * fraction)
              : meterCharges.water;
            const closingElec = billing.isFlatUtilityConfigured(billRoomObj, 'elec')
              ? r2(pickNum(billRoomObj.elecFlatAmount, billRoomObj.elec_flat_amount) * fraction)
              : meterCharges.elec;
            const closingWifi = r2(pickNum(
              billRoomObj.wifiOverride, billRoomObj.wifi_override,
              billRoomObj.wifi, utilCfg.wifi
            ) * fraction);
            const closingCommon = r2(pickNum(
              billRoomObj.commonFeeOverride, billRoomObj.common_fee_override,
              billRoomObj.commonFee, billRoomObj.common_fee, utilCfg.commonFee
            ) * fraction);
            // Carried late fees are folded onto the closing bill as PRINCIPAL
            // (inside subtotal), NOT into the late_fee column. tickLateFee
            // derives its recomputable penalty from `base = total - late_fee`,
            // so a carried fee parked in late_fee gets silently overwritten (and
            // lost) the first time the closing bill flips overdue. Keeping it in
            // subtotal preserves it, and late_fee=0 still lets the closing bill
            // accrue its own late fee later if it goes unpaid.
            const closingLateFee = carriedLateFeeTotal > 0 ? carriedLateFeeTotal : 0;
            const closingSubtotal = r2(
              proRatedRent + closingWater + closingElec + closingWifi + closingCommon + closingLateFee
            );
            // VAT parity with billing.buildBill (R1): the final partial month
            // carries the same rent/utility/wifi/common VAT as every recurring
            // bill. The carried late fee is a penalty (ค่าปรับ) — outside the
            // Thai VAT base — even though it rides inside subtotal as principal.
            const closingVatBase = r2(
              proRatedRent + closingWater + closingElec + closingWifi + closingCommon
            );
            const closingVat = flags?.vat?.enabled
              ? r2(closingVatBase * (Number(flags.vat.ratePct || 0) / 100))
              : 0;
            const closingTotal = r2(closingSubtotal + closingVat);
            // The prorated rent already lives in the rent column, so we do NOT
            // add a duplicate 'pro-rate' line (it double-counted rent in the
            // itemised PDF). Only charges without a dedicated column (common
            // fee, carried late fee) get display lines.
            const otherLines = [];
            if (closingCommon > 0) {
              otherLines.push({ label: 'ค่าส่วนกลาง (ตามวันที่อยู่)', amount: closingCommon, daysLived, daysInMonth });
            }
            if (closingLateFee > 0) {
              otherLines.push({ label: 'ค่าปรับล่าช้าค้างยกมา', amount: closingLateFee, daysLived, daysInMonth });
            }
            // A 100% discount (or a rent×fraction that rounds to ฿0.00) with no
            // carried late fee makes closingTotal=0, which violates the bills
            // `total > 0` CHECK constraint. The INSERT would throw 23514 and —
            // since the catch below only swallows 23505 — abort the ENTIRE
            // checkout transaction, leaving the tenant un-checkout-able. There
            // is nothing to charge, so skip the bill and let checkout proceed.
            if (closingTotal > 0) {
              try {
                const ins = await client.query(
                  `INSERT INTO bills
                     (bill_no, tenant_id, room_id, period, rent,
                      water_amount, elec_amount, wifi,
                      subtotal, vat, late_fee, total, due_date, status,
                      other)
                   VALUES ($1,$2,$3,$4,$5,$11,$12,$13,$8,$14,$9,$10,$6,'pending',$7::jsonb)
                   ON CONFLICT (bill_no) DO NOTHING
                   RETURNING id, bill_no, total, due_date`,
                  [billNo, id, billingRoom, period, proRatedRent, dueDate,
                   JSON.stringify(otherLines), closingSubtotal, 0, closingTotal,
                   closingWater, closingElec, closingWifi, closingVat]
                );
                closingBill = ins.rows[0] || null;
                if (closingBill) {
                  closingBillDetail = {
                    rent: proRatedRent,
                    water: closingWater,
                    elec: closingElec,
                    wifi: closingWifi,
                    common: closingCommon,
                    vat: closingVat,
                    carriedLateFee: closingLateFee,
                    daysLived,
                    daysInMonth,
                  };
                }
                // Only deactivate the carried charges once they are safely folded
                // into a created closing bill (don't lose them on an ON CONFLICT
                // skip). If no closing bill was created, they stay active so admin
                // can still collect them.
                if (closingBill && closingLateFee > 0 && carriedLateFeeRows.length) {
                  await client.query(
                    `UPDATE recurring_charges
                        SET active=FALSE, updated_at=NOW(),
                            notes = COALESCE(notes,'') || E'\n[auto] folded into closing bill ' || $2
                      WHERE id = ANY($1::bigint[]) AND active=TRUE`,
                    [carriedLateFeeRows.map((r) => Number(r.id)), String(closingBill.bill_no || closingBill.id)]
                  ).catch(() => { /* best-effort — leave active if this fails */ });
                }
              } catch (err) {
                if (err.code !== '23505') throw err;
                // Race against partial-unique — fine, just skip.
              }
            }
          }
        }

        await client.query('COMMIT');
        // Cascade room status. Checkout set status='vacant' inline, but the
        // closing bill (if generated) is in 'pending' state and could fire a
        // late-fee tick concurrently — syncRoom re-derives the final state
        // (vacant when no active contract + no payable bills) so an admin
        // looking at /admin#rooms right after checkout sees the right thing.
        for (const roomId of releaseRoomIds) {
          require('../services/roomStatus').syncRoom(pool, roomId, { reason: 'tenant-checkout' })
            .catch((err) => console.warn(`[checkout] room sync failed:`, err.message));
        }
        // Outstanding (pending/overdue) bills survive checkout by design —
        // the debt follows the tenant, not the room. Surface them in the
        // response so the admin UI can warn "ยังมีบิลค้าง ฿X" at the moment
        // of checkout instead of the admin discovering it later in reports.
        // Includes the closing bill just created above (it's 'pending').
        let outstandingBills = [];
        let outstandingTotal = 0;
        try {
          const ob = await pool.query(
            `SELECT id, bill_no, period, total, status, due_date
               FROM bills
              WHERE tenant_id=$1 AND status IN ('pending','overdue') AND deleted_at IS NULL
              ORDER BY period, id`,
            [id]
          );
          outstandingBills = ob.rows;
          outstandingTotal = Math.round(
            ob.rows.reduce((sum, row) => sum + (Number(row.total) || 0), 0) * 100
          ) / 100;
        } catch (err) {
          console.warn('[checkout] outstanding bill lookup failed:', err.message);
        }
        const depositHeld = closedContract ? Number(closedContract.deposit) || 0 : null;
        audit(req, 'tenant.checkout', 'tenant', String(id),
          { oldRoom, releaseRoomIds, roomRelease, reason, refund: effectiveRefund,
            closedContracts: closedContracts.map((c) => c.contract_no || c.id),
            invitationsRevoked: revokedInvitations.rowCount || 0,
            cardsRevoked: revokedCards.rows.map((c) => c.card_id),
            recurringDeactivated: deactivatedRecurring.rows.map((rc) => rc.label),
            closingBill: closingBill ? closingBill.bill_no : null,
            closingBillDetail,
            meterFinal,
            meterSkipped: meterSkippedTypes,
            outstandingTotal,
            outstandingBillCount: outstandingBills.length });
        // Per-entity audit rows for the cascade side effects, so the access
        // card / recurring charge histories answer "when was this revoked /
        // stopped, and why" without digging through tenant.checkout details.
        for (const card of revokedCards.rows) {
          audit(req, 'access_card.revoke', 'access_card', String(card.card_id || card.id),
            { tenantId: id, reason: 'auto:checkout' });
        }
        for (const rc of deactivatedRecurring.rows) {
          audit(req, 'recurring_charge.deactivate', 'recurring_charge', String(rc.id),
            { tenantId: id, label: rc.label, frequency: rc.frequency, reason: 'auto:checkout' });
        }

        // Move-out event for the whole admin team (owner + every bound admin
        // recipient): which room freed up, deposit settlement, and whether
        // debt is still outstanding (the number that decides if anyone needs
        // to chase the ex-tenant).
        try {
          const flags = await features.load(pool);
          notifier.notifyOwner({ pool, features: flags }, {
            category: 'tenancy',
            subject: `🚪 ย้ายออก — ห้อง ${releaseRoomIds.join(', ') || oldRoom || '-'}`,
            text: [
              `ผู้เช่า: ${tenant.full_name || `#${id}`}${tenant.phone ? ` (${tenant.phone})` : ''}`,
              `ห้องที่ปล่อยว่าง: ${releaseRoomIds.join(', ') || oldRoom || '-'}`,
              `เหตุผล: ${reason}`,
              effectiveRefund != null && Number.isFinite(effectiveRefund)
                ? `คืนเงินมัดจำ: ฿${Number(effectiveRefund).toLocaleString('th-TH', { minimumFractionDigits: 2 })}${depositHeld != null ? ` (จากมัดจำ ฿${depositHeld.toLocaleString('th-TH')})` : ''}`
                : 'ไม่ได้บันทึกการคืนมัดจำในระบบ',
              closingBill
                ? `บิลปิดบัญชี: ${closingBill.bill_no} ฿${Number(closingBill.total).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`
                : null,
              closingBillDetail && (closingBillDetail.water > 0 || closingBillDetail.elec > 0)
                ? `  • ค่าน้ำงวดสุดท้าย ฿${Number(closingBillDetail.water).toLocaleString('th-TH')} · ค่าไฟงวดสุดท้าย ฿${Number(closingBillDetail.elec).toLocaleString('th-TH')}`
                : null,
              meterFinal.water && meterFinal.water.stored
                ? `มิเตอร์น้ำสุดท้าย: ${meterFinal.water.reading} (ใช้ ${meterFinal.water.units} หน่วย)`
                : null,
              meterFinal.elec && meterFinal.elec.stored
                ? `มิเตอร์ไฟสุดท้าย: ${meterFinal.elec.reading} (ใช้ ${meterFinal.elec.units} หน่วย)`
                : null,
              meterSkippedTypes.length > 0
                ? `⚠️ ไม่ได้จดเลขมิเตอร์${meterSkippedTypes.map((mt) => (mt === 'water' ? 'น้ำ' : 'ไฟ')).join('/')}ตอนเช็คเอาท์ — ค่า${meterSkippedTypes.map((mt) => (mt === 'water' ? 'น้ำ' : 'ไฟ')).join('/')}งวดสุดท้ายไม่ได้เรียกเก็บ`
                : null,
              outstandingBills.length > 0
                ? `⚠️ ค้างชำระรวม: ฿${outstandingTotal.toLocaleString('th-TH', { minimumFractionDigits: 2 })} (${outstandingBills.length} บิล) — ติดตามเก็บก่อนคืนส่วนต่าง`
                : 'ไม่มีบิลค้างชำระ ✓',
              `ดำเนินการโดย: ${req.session.user.username}`,
            ].filter(Boolean).join('\n'),
          }).catch(() => {});
        } catch { /* team alert must not break checkout */ }

        // Fire-and-forget notify so the tenant knows their access has been
        // revoked + the closing bill (if any) is waiting.
        try {
          const flags = await features.load(pool);
          const publicUrl = (process.env.PUBLIC_URL
            || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
            || '').replace(/\/+$/, '');
          const closingPayToken = closingBill && publicUrl && typeof signBillPayToken === 'function'
            ? signBillPayToken(closingBill.id)
            : null;
          const closingBillPayUrl = closingBill && publicUrl && closingPayToken
            ? `${publicUrl}/pay/${encodeURIComponent(closingBill.id)}?t=${encodeURIComponent(closingPayToken)}`
            : null;
          const lines = [
            `เรียน คุณ${tenant.full_name}`,
            ``,
            `ระบบยืนยันการ check-out เรียบร้อยแล้ว`,
          ];
          if (releaseRoomIds.length) lines.push(`ห้อง: ${releaseRoomIds.join(', ')}`);
          if (revokedCards.rowCount > 0) {
            lines.push(`บัตรเข้า-ออกถูกเพิกถอน (${revokedCards.rowCount} ใบ)`);
          }
          if (effectiveRefund != null && Number.isFinite(effectiveRefund)) {
            lines.push(`คืนเงินมัดจำ: ฿${Number(effectiveRefund).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`);
          }
          if (closingBill) {
            if (closingBillPayUrl) {
              lines.push(`ลิงก์ชำระเงิน: ${closingBillPayUrl}`);
            }
            lines.push(``);
            lines.push(`📋 บิลปิดบัญชี: ${closingBill.bill_no}`);
            if (closingBillDetail) {
              const fmtB = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2 });
              lines.push(`  ค่าเช่า (${closingBillDetail.daysLived}/${closingBillDetail.daysInMonth} วัน): ฿${fmtB(closingBillDetail.rent)}`);
              if (closingBillDetail.water > 0) lines.push(`  ค่าน้ำ: ฿${fmtB(closingBillDetail.water)}`);
              if (closingBillDetail.elec > 0) lines.push(`  ค่าไฟ: ฿${fmtB(closingBillDetail.elec)}`);
              if (closingBillDetail.wifi > 0) lines.push(`  ค่าอินเทอร์เน็ต: ฿${fmtB(closingBillDetail.wifi)}`);
              if (closingBillDetail.common > 0) lines.push(`  ค่าส่วนกลาง: ฿${fmtB(closingBillDetail.common)}`);
              if (closingBillDetail.carriedLateFee > 0) lines.push(`  ค่าปรับค้างยกมา: ฿${fmtB(closingBillDetail.carriedLateFee)}`);
              if (closingBillDetail.vat > 0) lines.push(`  ภาษีมูลค่าเพิ่ม: ฿${fmtB(closingBillDetail.vat)}`);
            }
            lines.push(`ยอด: ฿${Number(closingBill.total).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`);
            lines.push(`ครบกำหนด: ${closingBill.due_date}`);
          }
          // Total owed across ALL open bills (old pending/overdue + the
          // closing bill) so the tenant sees one final number, not just the
          // closing bill — pre-existing debt was previously easy to miss.
          if (outstandingBills.length > 0) {
            lines.push(``);
            lines.push(`ยอดค้างชำระรวมทั้งหมด: ฿${outstandingTotal.toLocaleString('th-TH', { minimumFractionDigits: 2 })} (${outstandingBills.length} บิล)`);
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
          ok: true, tenantId: id, oldRoom, refund: effectiveRefund,
          depositHeld,
          releasedRooms: roomRelease.released,
          skippedRooms: roomRelease.skipped,
          invitationsRevoked: revokedInvitations.rowCount || 0,
          cardsRevoked: revokedCards.rowCount,
          closingBill,
          closingBillDetail,
          meterFinal,
          meterSkipped: meterSkippedTypes,
          outstandingBills,
          outstandingTotal,
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('checkout error:', err);
        res.status(500).json({
          error: 'ยกเลิกสัญญา/ย้ายออกไม่สำเร็จ ระบบย้อนรายการทั้งหมดให้แล้ว จึงยังไม่มีข้อมูลถูกบันทึกแบบครึ่งทาง',
          code: 'CHECKOUT_FAILED',
          hint: 'รีเฟรชหน้าแล้วลองทำรายการอีกครั้ง หากยังไม่สำเร็จ ให้เปิดหน้าสุขภาพระบบเพื่อตรวจฐานข้อมูล/ตาราง และแจ้งเวลาที่ทำรายการให้ผู้ดูแลระบบตรวจบันทึกระบบ',
        });
      } finally {
        client.release();
      }
    }
  );

  return r;
};
