// services/contractInvitation.js
// Token-based "let the tenant fill the contract themselves" workflow.
//
// Invitations live in `contract_invitations`. Each carries an opaque token
// (base64url, 32 bytes random) — the URL the tenant clicks. We store ONLY
// sha256(token) in the DB so a leaked DB row can't be replayed against the
// live endpoint without also knowing the URL.
//
// Status state machine:
//   pending    — tenant opened/saving drafts; admin can revoke
//   submitted  — tenant clicked "ส่งให้ตรวจสอบ"; awaiting admin review
//   approved   — admin accepted; draft applied to tenants/contracts; LOCKED
//   rejected   — admin sent back with reason; tenant edits → pending again
//   revoked    — admin killed the link
//   expired    — past expires_at (lazy: set on read)
//
// `approved`, `revoked`, `expired` are terminal — token rejected at the
// gateway. Active states are `pending` (mutable) and `submitted` (frozen
// pending review).

const crypto = require('crypto');

const ACTIVE_STATUSES = new Set(['pending', 'submitted']);
const TERMINAL_STATUSES = new Set(['approved', 'rejected', 'revoked', 'expired']);

// Default expiry: 7 days from generation. Admin can override at create time.
const DEFAULT_EXPIRY_HOURS = 7 * 24;

/**
 * Generate a fresh URL-safe token + its sha256 hash. Token is what we
 * surface in the URL the tenant clicks; hash is what we persist + index.
 */
function generateToken() {
  const buf = crypto.randomBytes(32);
  // base64url so the token is URL-safe without %-encoding (cleaner copy/paste).
  const token = buf.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  return { token, hash };
}

/**
 * Hash an incoming token for DB lookup. Decodes base64url then sha256s.
 * Returns null on bad input (caller treats as 404 not crash).
 */
function hashToken(token) {
  if (typeof token !== 'string' || !token) return null;
  // Reject obviously malformed tokens before touching the DB.
  if (!/^[A-Za-z0-9_-]{40,80}$/.test(token)) return null;
  // Reverse the base64url → base64 transformation so Buffer.from accepts it.
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch { return null; }
  if (buf.length !== 32) return null;
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Resolve an invitation row by token. Returns null when:
 *   - token format invalid
 *   - no matching row
 *   - row is in a terminal status (approved / rejected / revoked / expired)
 *   - row is PENDING past expires_at (lazy-flips status to 'expired')
 *
 * Submitted invitations are NEVER lazy-expired — the tenant has done their
 * part and admin needs unlimited time to review. Without this exemption,
 * a tenant who took >7 days to fill (or one returning to verify their
 * submission) would hit a confusing 404 even though their data is safe
 * in the system.
 *
 * Successful return shape: full row with `status` ∈ ACTIVE_STATUSES.
 */
async function resolveActiveByToken(pool, token) {
  const hash = hashToken(token);
  if (!hash) return null;
  const { rows } = await pool.query(
    `SELECT i.*, c.contract_no, c.room_id, c.start_date, c.end_date,
            c.monthly_rent, c.deposit, c.term_months, c.discount_pct,
            c.locked_at,
            t.full_name AS tenant_name, t.phone AS tenant_phone, t.email AS tenant_email
       FROM contract_invitations i
       LEFT JOIN contracts c ON c.id = i.contract_id
       LEFT JOIN tenants   t ON t.id = i.tenant_id
      WHERE i.token_hash = $1
      LIMIT 1`,
    [hash]
  );
  if (!rows.length) return null;
  const row = rows[0];
  // Lazy expire — pending only. Submitted rows stay accessible so admin
  // can approve and tenant can revisit. The cleanup of stale pending rows
  // keeps admin's "active" list accurate without a sweep job.
  // Use DB NOW() instead of JS Date.now() so expiration comparison runs
  // in the same clock as the one that stamped expires_at. A side-by-side
  // JS-vs-DB comparison drifts whenever the host running this process
  // isn't aligned to the DB's timezone — small but real on operator
  // machines running in Asia/Bangkok while DB stores UTC.
  if (row.status === 'pending' && row.expires_at) {
    const { rows: expRows } = await pool.query(
      `SELECT (expires_at < NOW()) AS is_expired FROM contract_invitations WHERE id=$1`,
      [row.id]
    );
    if (expRows.length && expRows[0].is_expired) {
      try {
        await pool.query(
          `UPDATE contract_invitations SET status='expired', updated_at=NOW() WHERE id=$1`,
          [row.id]
        );
      } catch { /* best-effort; don't block the read on the flip */ }
      return null;
    }
  }
  if (!ACTIVE_STATUSES.has(row.status)) return null;
  return row;
}

/**
 * Inspect the raw row state for a token regardless of expiry / status.
 * Used by handlers that need to distinguish causes (revoked vs expired
 * vs already-submitted vs approved) for friendly error messages — the
 * resolveActiveByToken null return collapses all of these into "404".
 *
 * Returns { status, rejection_reason } or null on bad-format / no row.
 */
async function inspectByToken(pool, token) {
  const hash = hashToken(token);
  if (!hash) return null;
  const { rows } = await pool.query(
    `SELECT id, status, rejection_reason, expires_at
       FROM contract_invitations WHERE token_hash = $1 LIMIT 1`,
    [hash]
  );
  return rows[0] || null;
}

/**
 * Create a fresh invitation for a contract. Closes any prior active
 * invitation (sets status='revoked') so the partial unique on
 * uq_contract_invitations_active_per_contract doesn't 23505. Returns
 * { token, hash, expiresAt, id } — caller surfaces `token` to admin in
 * the response and never persists it raw.
 */
async function createInvitation(pool, {
  contractId, tenantId, expiresInHours, createdBy,
}) {
  const hours = Number.isFinite(Number(expiresInHours))
    ? Math.max(1, Math.min(720, Number(expiresInHours)))   // 1h … 30 days
    : DEFAULT_EXPIRY_HOURS;
  const { token, hash } = generateToken();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Revoke any prior active invitation on this contract so the partial
    // unique stays satisfied + admin's intent ("send a fresh link") wins.
    await client.query(
      `UPDATE contract_invitations
          SET status='revoked', revoked_at=NOW(), revoked_by=$2, updated_at=NOW()
        WHERE contract_id=$1 AND status IN ('pending','submitted')`,
      [contractId, createdBy || 'system']
    );
    // Use DB NOW() + INTERVAL instead of JS Date.now() so expiry math stays
    // consistent with the resolveActiveByToken() side that compares against
    // DB NOW(). Mixing JS wallclock (could be UTC, could be Asia/Bangkok
    // depending on the host) with DB-side timestamps drifts the expiration
    // window by whatever the host clock offset is — small but real for
    // operators running this on a non-UTC server.
    const { rows } = await client.query(
      `INSERT INTO contract_invitations
          (contract_id, tenant_id, token_hash, expires_at, created_by)
       VALUES ($1, $2, $3, NOW() + ($4::int || ' hours')::interval, $5)
       RETURNING id, contract_id, tenant_id, status, expires_at, created_at`,
      [contractId, tenantId || null, hash, hours, createdBy || 'system']
    );
    await client.query('COMMIT');
    return {
      id: rows[0].id,
      token,           // raw — return ONCE to admin
      hash,            // for tests / logs
      expiresAt: rows[0].expires_at,
      contractId, tenantId,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Validate the structure of a draft payload coming from the public fill
 * endpoint. Strict sanitisation so a malicious public client can't smuggle
 * extra keys, oversized strings, or non-numeric data. Returns a sanitised
 * object suitable for storing as the `draft` JSONB.
 */
function sanitiseDraft(input) {
  const b = input && typeof input === 'object' ? input : {};
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
  const out = {};
  if (b.address !== undefined) out.address = str(b.address, 500);
  if (b.emergencyContactName !== undefined)
    out.emergencyContactName = str(b.emergencyContactName, 200);
  if (b.emergencyContactPhone !== undefined) {
    const ec = b.emergencyContactPhone
      ? String(b.emergencyContactPhone).slice(0, 32).trim().replace(/[\s-]/g, '')
      : null;
    out.emergencyContactPhone = ec;
  }
  if (b.emergencyContactRelation !== undefined)
    out.emergencyContactRelation = str(b.emergencyContactRelation, 64);
  // Citizen ID — only the digits (we'll re-validate checksum on submit).
  if (b.citizenId !== undefined) {
    const cid = b.citizenId ? String(b.citizenId).replace(/[^0-9]/g, '').slice(0, 13) : null;
    out.citizenId = cid;
  }
  // File upload ids (admin pre-validated these via /api/contract-fill/:token/upload).
  for (const k of ['citizenIdImageFrontId', 'citizenIdImageBackId', 'signatureFileId']) {
    if (b[k] !== undefined) {
      const n = Number(b[k]);
      out[k] = Number.isInteger(n) && n > 0 ? n : null;
    }
  }
  if (b.agreedTermsVersion !== undefined)
    out.agreedTermsVersion = str(b.agreedTermsVersion, 64);
  if (b.notes !== undefined)
    out.notes = str(b.notes, 1000);
  return out;
}

/**
 * Public form view payload — what the tenant sees when they open the URL.
 * Excludes anything sensitive (no full citizen ID even if already stored on
 * the tenant row from a prior submission).
 */
function buildPublicView(invitation, building) {
  return {
    invitationId: invitation.id,
    status: invitation.status,
    expiresAt: invitation.expires_at,
    rejectionReason: invitation.rejection_reason || null,
    contract: {
      contractNo: invitation.contract_no,
      roomId: invitation.room_id,
      startDate: invitation.start_date,
      endDate: invitation.end_date,
      monthlyRent: invitation.monthly_rent,
      deposit: invitation.deposit,
      termMonths: invitation.term_months,
      discountPct: invitation.discount_pct,
    },
    tenant: invitation.tenant_id ? {
      fullName: invitation.tenant_name,
      phone: invitation.tenant_phone,
      email: invitation.tenant_email,
    } : null,
    building: building ? {
      name: building.name || null,
      address: building.address || null,
      phone: building.phone || null,
    } : null,
    draft: invitation.draft || {},
  };
}

module.exports = {
  generateToken,
  hashToken,
  resolveActiveByToken,
  inspectByToken,
  createInvitation,
  sanitiseDraft,
  buildPublicView,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  DEFAULT_EXPIRY_HOURS,
};
