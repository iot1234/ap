// services/lineBinding.js
// LINE OA binding code lifecycle. Handles issue, revoke, block, and the
// match-on-message flow that the webhook calls when a tenant sends their
// code in chat.
//
// Code format: BIND-XXXXXXXX (8 hex chars, uppercase). 4 bytes = 4.3 billion
// combinations. Combined with per-tenant uniqueness + 7-day expiry +
// rate-limited webhook, brute force is infeasible.

const crypto = require('crypto');

const CODE_PREFIX = 'BIND-';
const CODE_LEN = 8;       // hex chars
const DEFAULT_TTL_DAYS = 7;

function generateCode() {
  return CODE_PREFIX + crypto.randomBytes(CODE_LEN / 2).toString('hex').toUpperCase();
}

/**
 * Issue a new binding code for a tenant. If a pending code already exists
 * it is revoked (status='revoked') and a new one created — admin always
 * has at most one active code per tenant.
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {number} [opts.ttlDays=7]
 * @param {string} [opts.createdBy]
 * @param {number} [opts.targetOaId] - Hint: tenant should send to THIS OA.
 *        If set, only that OA's webhook will accept the code (binding
 *        enforces the match). If null/undefined, code accepts any OA.
 * @returns {Promise<{ code, expiresAt, tenantId, targetOaId? }>}
 */
async function issue(pool, { tenantId, ttlDays, createdBy, targetOaId } = {}) {
  const ttl = Number(ttlDays || DEFAULT_TTL_DAYS);
  if (!Number.isFinite(ttl) || ttl < 1 || ttl > 30) {
    throw new Error('ttlDays must be 1-30');
  }
  const target = (targetOaId == null || targetOaId === '' || Number(targetOaId) === 0)
    ? null
    : Number(targetOaId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Refuse if tenant is blocked
    const t = await client.query(
      `SELECT id, full_name, line_binding_blocked FROM tenants
         WHERE id=$1 AND deleted_at IS NULL`,
      [tenantId]
    );
    if (!t.rows.length) {
      await client.query('ROLLBACK');
      throw new Error('tenant not found');
    }
    if (t.rows[0].line_binding_blocked) {
      await client.query('ROLLBACK');
      throw new Error('tenant is blocked from LINE binding');
    }
    // If a target OA was specified, verify it exists and is enabled.
    if (target != null) {
      const oa = await client.query(
        `SELECT id, enabled FROM line_oas WHERE id=$1 AND deleted_at IS NULL`,
        [target]
      );
      if (!oa.rows.length || !oa.rows[0].enabled) {
        await client.query('ROLLBACK');
        throw new Error('OA ที่เลือกไม่มีอยู่หรือถูกปิดอยู่');
      }
    }
    // Revoke any existing pending code
    await client.query(
      `UPDATE line_bindings SET status='revoked', updated_at=NOW()
         WHERE tenant_id=$1 AND status='pending'`,
      [tenantId]
    );
    // Create new code (loop in the rare case of hex collision)
    let code, attempt = 0;
    while (attempt < 5) {
      code = generateCode();
      try {
        const ins = await client.query(
          `INSERT INTO line_bindings (tenant_id, code, status, expires_at, created_by, target_oa_id)
           VALUES ($1, $2, 'pending', NOW() + ($3::int || ' days')::interval, $4, $5)
           RETURNING id, code, expires_at, target_oa_id`,
          [tenantId, code, ttl, createdBy || null, target]
        );
        await client.query('COMMIT');
        return {
          id: ins.rows[0].id, code, expiresAt: ins.rows[0].expires_at,
          tenantId, targetOaId: ins.rows[0].target_oa_id,
        };
      } catch (err) {
        if (err.code === '23505') { attempt++; continue; }   // unique violation → retry
        throw err;
      }
    }
    await client.query('ROLLBACK');
    throw new Error('could not generate unique code');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Revoke any pending code AND clear bound LINE userId. Use this when admin
 * wants to unbind without blocking future re-bind attempts.
 */
async function revoke(pool, { tenantId }) {
  const client = await pool.connect();
  let prevOaId = null;
  try {
    await client.query('BEGIN');
    // Capture which OA the tenant was bound on so we can refresh its count
    const before = await client.query(
      `SELECT line_oa_id FROM tenants WHERE id=$1`,
      [tenantId]
    );
    prevOaId = before.rows[0]?.line_oa_id || null;
    await client.query(
      `UPDATE line_bindings SET status='revoked', updated_at=NOW()
         WHERE tenant_id=$1 AND status='pending'`,
      [tenantId]
    );
    await client.query(
      `UPDATE line_bindings SET status='revoked', updated_at=NOW()
         WHERE tenant_id=$1 AND status='bound'`,
      [tenantId]
    );
    await client.query(
      `UPDATE tenants SET line_user_id=NULL, line_oa_id=NULL, updated_at=NOW()
         WHERE id=$1`,
      [tenantId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (prevOaId) {
    pool.query(
      `UPDATE line_oas SET bound_count = (
          SELECT COUNT(*) FROM line_bindings WHERE oa_id=$1 AND status='bound'
        ), updated_at=NOW() WHERE id=$1`,
      [prevOaId]
    ).catch(() => {});
  }
}

/**
 * Block a tenant from LINE binding entirely. Revokes their codes too.
 */
async function block(pool, { tenantId, reason }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE tenants
          SET line_binding_blocked=TRUE,
              line_binding_blocked_at=NOW(),
              line_binding_blocked_reason=$2,
              line_user_id=NULL,
              line_oa_id=NULL,
              updated_at=NOW()
        WHERE id=$1`,
      [tenantId, String(reason || '').slice(0, 500) || null]
    );
    await client.query(
      `UPDATE line_bindings
          SET status='blocked', blocked_at=NOW(),
              blocked_reason=$2, updated_at=NOW()
        WHERE tenant_id=$1 AND status IN ('pending', 'bound')`,
      [tenantId, String(reason || '').slice(0, 500) || null]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function unblock(pool, { tenantId }) {
  await pool.query(
    `UPDATE tenants
        SET line_binding_blocked=FALSE,
            line_binding_blocked_at=NULL,
            line_binding_blocked_reason=NULL,
            updated_at=NOW()
      WHERE id=$1`,
    [tenantId]
  );
}

/**
 * Look up the tenant's current binding state. Returns null if nothing.
 */
async function getStatus(pool, tenantId) {
  const t = await pool.query(
    `SELECT id, full_name, phone, line_user_id, line_oa_id, line_binding_blocked,
            line_binding_blocked_at, line_binding_blocked_reason, current_room_id
       FROM tenants WHERE id=$1 AND deleted_at IS NULL`,
    [tenantId]
  );
  if (!t.rows.length) return null;
  const tenant = t.rows[0];
  const b = await pool.query(
    `SELECT b.id, b.code, b.status, b.line_user_id, b.expires_at, b.bound_at,
            b.blocked_at, b.blocked_reason, b.created_at,
            b.oa_id, b.target_oa_id,
            o.name AS oa_name, o.slug AS oa_slug,
            tg.name AS target_oa_name, tg.slug AS target_oa_slug
       FROM line_bindings b
       LEFT JOIN line_oas o  ON o.id  = b.oa_id        AND o.deleted_at  IS NULL
       LEFT JOIN line_oas tg ON tg.id = b.target_oa_id AND tg.deleted_at IS NULL
       WHERE b.tenant_id=$1
       ORDER BY (CASE b.status WHEN 'pending' THEN 0 WHEN 'bound' THEN 1 ELSE 2 END), b.created_at DESC
       LIMIT 10`,
    [tenantId]
  );
  return {
    tenant,
    pending: b.rows.find((r) => r.status === 'pending') || null,
    bound: b.rows.find((r) => r.status === 'bound') || null,
    history: b.rows,
  };
}

/**
 * The webhook calls this when a tenant sends a candidate code in chat.
 *
 * @param {object} opts
 * @param {string} opts.code        — text the tenant sent
 * @param {string} opts.lineUserId  — source.userId from the LINE event
 * @param {number} [opts.oaId]      — id of the OA whose webhook received the
 *        message (NULL/0 = legacy env-OA). Recorded on the binding so
 *        notifier can route future pushes back through the same OA.
 * @returns {Promise<{ ok, tenantId?, fullName?, roomId?, oaId?, reason? }>}
 */
async function tryBind(pool, { code, lineUserId, oaId } = {}) {
  const cleaned = String(code || '').trim().toUpperCase();
  if (!cleaned.startsWith(CODE_PREFIX)) {
    return { ok: false, reason: 'invalid' };
  }
  const oaIdNum = (oaId == null || Number(oaId) === 0) ? null : Number(oaId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lookup = await client.query(
      `SELECT b.id, b.tenant_id, b.status, b.expires_at, b.target_oa_id,
              t.full_name, t.current_room_id, t.line_binding_blocked
         FROM line_bindings b JOIN tenants t ON t.id = b.tenant_id
         WHERE b.code = $1 LIMIT 1`,
      [cleaned]
    );
    if (!lookup.rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'invalid' };
    }
    const row = lookup.rows[0];
    if (row.line_binding_blocked) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'tenant_blocked' };
    }
    if (row.status === 'blocked' || row.status === 'revoked') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'invalid' };
    }
    if (row.status === 'bound') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'already_bound' };
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await client.query(
        `UPDATE line_bindings SET status='expired', updated_at=NOW() WHERE id=$1`,
        [row.id]
      );
      await client.query('COMMIT');
      return { ok: false, reason: 'expired' };
    }
    // If admin issued the code with a specific target OA, enforce it: the
    // tenant must have sent the code to that OA's webhook. This prevents
    // accidental cross-OA binding and lets admin segregate buildings.
    if (row.target_oa_id != null && row.target_oa_id !== oaIdNum) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'wrong_oa', expectedOaId: row.target_oa_id };
    }
    // Refuse if this LINE userId is already bound to a different tenant on
    // the same OA. Different OAs see different userIds for the same human
    // (LINE quirk), so cross-OA dedup would be wrong.
    const dup = await client.query(
      `SELECT tenant_id FROM line_bindings
         WHERE line_user_id=$1
           AND COALESCE(oa_id, 0) = COALESCE($2::bigint, 0)
           AND status='bound'
           AND tenant_id <> $3
         LIMIT 1`,
      [lineUserId, oaIdNum, row.tenant_id]
    );
    if (dup.rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'line_user_already_bound', otherTenantId: dup.rows[0].tenant_id };
    }
    // If the same tenant has a previous "bound" row on a DIFFERENT OA,
    // revoke it so the tenant only receives notifications via the latest
    // channel they confirmed. Prevents duplicate sends to the same person
    // who re-bound through another OA.
    await client.query(
      `UPDATE line_bindings
          SET status='revoked', updated_at=NOW()
        WHERE tenant_id=$1 AND status='bound' AND id <> $2`,
      [row.tenant_id, row.id]
    );
    // Bind!
    await client.query(
      `UPDATE line_bindings
          SET status='bound', line_user_id=$1, oa_id=$2, bound_at=NOW(), updated_at=NOW()
        WHERE id=$3`,
      [lineUserId, oaIdNum, row.id]
    );
    await client.query(
      `UPDATE tenants
          SET line_user_id=$1, line_oa_id=$2, updated_at=NOW()
        WHERE id=$3`,
      [lineUserId, oaIdNum, row.tenant_id]
    );
    await client.query('COMMIT');
    // Update OA bound_count outside the transaction (best-effort, eventual-
    // consistency UI counter only). Recomputed via SELECT COUNT so even if a
    // previous update failed silently, the next bind self-heals the count.
    // Concurrent binds may race here but the SUBQUERY recounts the truth, so
    // the final state always converges to the actual bound row count rather
    // than incrementing a stale field. Safe to fire-and-forget.
    if (oaIdNum != null) {
      pool.query(
        `UPDATE line_oas SET bound_count = (
            SELECT COUNT(*) FROM line_bindings WHERE oa_id=$1 AND status='bound'
          ), last_seen_at=NOW(), updated_at=NOW() WHERE id=$1`,
        [oaIdNum]
      ).catch((err) => console.warn('[line] bound_count update failed:', err.message));
    }
    return {
      ok: true,
      tenantId: row.tenant_id,
      fullName: row.full_name,
      roomId: row.current_room_id,
      oaId: oaIdNum,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Admin overview: every tenant + their current binding state. Used by the
 * page-line-bindings.jsx table. Returns sorted by binding status priority
 * (pending first, then bound, then unbound) so admin sees actionable rows
 * at the top.
 */
async function listAll(pool) {
  const { rows } = await pool.query(`
    SELECT
      t.id AS tenant_id, t.full_name, t.phone, t.current_room_id,
      t.line_user_id, t.line_oa_id, t.line_binding_blocked,
      t.status AS tenant_status,
      b.id AS binding_id, b.code, b.status AS binding_status,
      b.expires_at, b.bound_at, b.oa_id, b.target_oa_id,
      o.name  AS oa_name,        o.slug  AS oa_slug,
      tg.name AS target_oa_name, tg.slug AS target_oa_slug
    FROM tenants t
    LEFT JOIN LATERAL (
      SELECT id, code, status, expires_at, bound_at, oa_id, target_oa_id
        FROM line_bindings
        WHERE tenant_id = t.id
          AND status IN ('pending', 'bound')
        ORDER BY (CASE status WHEN 'pending' THEN 0 ELSE 1 END), created_at DESC
        LIMIT 1
    ) b ON TRUE
    LEFT JOIN line_oas o  ON o.id  = b.oa_id        AND o.deleted_at  IS NULL
    LEFT JOIN line_oas tg ON tg.id = b.target_oa_id AND tg.deleted_at IS NULL
    WHERE t.deleted_at IS NULL
    ORDER BY
      CASE
        WHEN b.status = 'pending' THEN 0
        WHEN t.line_user_id IS NULL AND NOT t.line_binding_blocked THEN 1
        WHEN t.line_user_id IS NOT NULL THEN 2
        ELSE 3
      END,
      t.full_name ASC
  `);
  return rows;
}

module.exports = {
  issue, revoke, block, unblock, getStatus, tryBind, listAll,
  CODE_PREFIX, generateCode,
};
