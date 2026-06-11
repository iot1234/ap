// services/ownerClaim.js
// One-time claim flow for binding an admin's personal LINE userId as the
// "owner" recipient for a LINE OA's system notifications. Replaces the
// manual paste-userId-into-secrets step that was confusing operators.
//
// Flow:
//   1. Admin clicks "🔗 Auto-detect" → POST /api/admin/line/owner-claim
//      generates OWNER-XXXXXXXX, stores in owner_claim_tokens with 5-min TTL.
//   2. Admin opens their LINE chat with the OA and sends the code.
//   3. webhook receives the message → calls tryClaim(pool, code, lineUserId,
//      oaId). On success it updates line_oas.owner_user_id (or
//      secrets.LINE_OWNER_USER_ID for the env-fallback path) and marks the
//      token claimed.
//   4. Admin UI polls GET /api/admin/line/owner-claim/:id until status flips
//      from pending → claimed (or expired).
//
// Security:
//   - Token is single-use + expires after 5 min.
//   - One pending token per OA at a time (uq_owner_claim_pending_per_oa).
//   - Admin must be owner-role to create tokens (route enforces).
//   - Code namespace is OWNER-{8..16 hex} → distinct from tenant BIND-{...}
//     so a tenant's binding flow can't trip the owner-claim webhook branch.

const crypto = require('crypto');

const CODE_RE = /^OWNER-[A-F0-9]{8,16}$/i;  // accept legacy 8-hex + new 16-hex
const TTL_MS = 5 * 60 * 1000;          // 5 minutes

function generateCode() {
  // 8 random bytes → 16 hex chars (uppercased): 64-bit, single-use, 5-min
  // window. Pasted from the issuing screen into LINE chat, so length is not a
  // typing burden.
  return 'OWNER-' + crypto.randomBytes(8).toString('hex').toUpperCase();
}

function isClaimCode(text) {
  return CODE_RE.test(String(text || '').trim());
}

/**
 * Create a fresh claim token for the given OA. Revokes any existing pending
 * token for the same OA first (one-active-per-OA invariant). Returns
 * { id, code, expiresAt }.
 */
async function createToken(pool, { oaId, createdBy }) {
  // Revoke any pending token on this OA so the partial-unique index never
  // collides — clearer than catching 23505. The admin UI calls this when
  // the operator says "actually let me try again, give me a fresh code".
  await pool.query(
    `UPDATE owner_claim_tokens SET status='revoked', updated_at=NOW()
       WHERE status='pending' AND COALESCE(oa_id, 0) = COALESCE($1::bigint, 0)`,
    [oaId || null]
  );
  // Retry-on-collision in the extreme unlikely case two tokens hash to the
  // same code (1-in-4-billion per attempt). 3 attempts is more than enough.
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateCode();
    try {
      const { rows } = await pool.query(
        `INSERT INTO owner_claim_tokens (code, oa_id, expires_at, created_by, status)
         VALUES ($1, $2, NOW() + INTERVAL '${Math.floor(TTL_MS / 1000)} seconds', $3, 'pending')
         RETURNING id, code, expires_at`,
        [code, oaId || null, createdBy || 'admin']
      );
      return {
        id: rows[0].id,
        code: rows[0].code,
        expiresAt: rows[0].expires_at,
        ttlMs: TTL_MS,
      };
    } catch (err) {
      if (err.code === '23505' && attempt < 2) continue;
      throw err;
    }
  }
  throw new Error('failed to generate unique claim code after retries');
}

/**
 * Look up a token by id. Used by the admin UI poll loop.
 */
async function getToken(pool, id) {
  const { rows } = await pool.query(
    `SELECT id, code, oa_id, status, claimed_user_id, claimed_at,
            expires_at, created_at
       FROM owner_claim_tokens WHERE id=$1 LIMIT 1`,
    [id]
  );
  if (!rows.length) return null;
  const t = rows[0];
  // Lazy-expire pending tokens that have aged out. Cheap UPDATE so the
  // poll path returns the right status without waiting for an external
  // sweep job.
  if (t.status === 'pending' && new Date(t.expires_at).getTime() < Date.now()) {
    await pool.query(
      `UPDATE owner_claim_tokens SET status='expired', updated_at=NOW()
         WHERE id=$1 AND status='pending'`,
      [id]
    );
    t.status = 'expired';
  }
  return t;
}

/**
 * Webhook entry — called when the LINE webhook receives an OWNER-XXXXXXXX
 * code. Atomically validates the token, marks it claimed, and writes the
 * userId to line_oas.owner_user_id (or, when oa_id is null, to the
 * legacy LINE_OWNER_USER_ID secret).
 *
 * Returns { ok, reason } so the webhook can craft a Thai-language reply.
 */
async function tryClaim(pool, { code, lineUserId, oaId, secretsModule }) {
  if (!isClaimCode(code)) return { ok: false, reason: 'invalid' };
  if (!lineUserId || typeof lineUserId !== 'string') return { ok: false, reason: 'invalid' };
  const cleanCode = String(code).trim().toUpperCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, status, oa_id, expires_at
         FROM owner_claim_tokens WHERE code=$1 FOR UPDATE`,
      [cleanCode]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'invalid' };
    }
    const t = rows[0];
    if (t.status === 'claimed') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'already_used' };
    }
    if (t.status === 'revoked') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'revoked' };
    }
    if (new Date(t.expires_at).getTime() < Date.now()) {
      await client.query(
        `UPDATE owner_claim_tokens SET status='expired', updated_at=NOW()
           WHERE id=$1`,
        [t.id]
      );
      await client.query('COMMIT');
      return { ok: false, reason: 'expired' };
    }
    // Constrain: if the token specified an oa_id, the inbound webhook must
    // be the SAME OA. Operator using a 2-OA setup can issue per-OA tokens
    // and we want the right OA to receive the credit.
    if (t.oa_id && oaId && Number(t.oa_id) !== Number(oaId)) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'wrong_oa' };
    }
    // Mark token claimed.
    await client.query(
      `UPDATE owner_claim_tokens
          SET status='claimed', claimed_user_id=$2, claimed_at=NOW(), updated_at=NOW()
        WHERE id=$1`,
      [t.id, lineUserId]
    );
    // Persist the resolved userId where notifyOwner reads it.
    // Per-OA: write line_oas.owner_user_id. Env-fallback (oa_id NULL):
    // write the LINE_OWNER_USER_ID secret via the standard secrets module
    // (encrypts + caches).
    const persistTo = t.oa_id || oaId || null;
    if (persistTo) {
      await client.query(
        `UPDATE line_oas SET owner_user_id=$2, updated_at=NOW()
           WHERE id=$1`,
        [persistTo, lineUserId]
      );
    }
    await client.query('COMMIT');
    // Secret write happens outside the tx because secrets module uses its
    // own pool.query and the cache invalidation. Fire even when persistTo
    // is set so the legacy LINE_OWNER_USER_ID stays useful for env-only
    // deploys without a registered OA row.
    if (!persistTo && secretsModule && typeof secretsModule.set === 'function') {
      try {
        await secretsModule.set(pool, 'LINE_OWNER_USER_ID', lineUserId, 'owner-claim');
      } catch (err) {
        console.warn('[ownerClaim] secrets.set failed:', err.message);
      }
    }
    return { ok: true, oaId: persistTo, userId: lineUserId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[ownerClaim] tryClaim error:', err.message);
    return { ok: false, reason: 'error', error: err.message };
  } finally {
    client.release();
  }
}

module.exports = {
  generateCode, isClaimCode, createToken, getToken, tryClaim, TTL_MS,
};
