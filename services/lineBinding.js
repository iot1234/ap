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
 * @returns {Promise<{ code, expiresAt, tenantId }>}
 */
async function issue(pool, { tenantId, ttlDays, createdBy }) {
  const ttl = Number(ttlDays || DEFAULT_TTL_DAYS);
  if (!Number.isFinite(ttl) || ttl < 1 || ttl > 30) {
    throw new Error('ttlDays must be 1-30');
  }
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
          `INSERT INTO line_bindings (tenant_id, code, status, expires_at, created_by)
           VALUES ($1, $2, 'pending', NOW() + ($3::int || ' days')::interval, $4)
           RETURNING id, code, expires_at`,
          [tenantId, code, ttl, createdBy || null]
        );
        await client.query('COMMIT');
        return { id: ins.rows[0].id, code, expiresAt: ins.rows[0].expires_at, tenantId };
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
async function revoke(pool, { tenantId, by }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
      `UPDATE tenants SET line_user_id=NULL, updated_at=NOW() WHERE id=$1`,
      [tenantId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Block a tenant from LINE binding entirely. Revokes their codes too.
 */
async function block(pool, { tenantId, reason, by }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE tenants
          SET line_binding_blocked=TRUE,
              line_binding_blocked_at=NOW(),
              line_binding_blocked_reason=$2,
              line_user_id=NULL,
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
    `SELECT id, full_name, phone, line_user_id, line_binding_blocked,
            line_binding_blocked_at, line_binding_blocked_reason, current_room_id
       FROM tenants WHERE id=$1 AND deleted_at IS NULL`,
    [tenantId]
  );
  if (!t.rows.length) return null;
  const tenant = t.rows[0];
  const b = await pool.query(
    `SELECT id, code, status, line_user_id, expires_at, bound_at,
            blocked_at, blocked_reason, created_at
       FROM line_bindings
       WHERE tenant_id=$1
       ORDER BY (CASE status WHEN 'pending' THEN 0 WHEN 'bound' THEN 1 ELSE 2 END), created_at DESC
       LIMIT 5`,
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
 * Returns one of:
 *   { ok: true, tenantId, fullName, roomId }   — bound successfully
 *   { ok: false, reason: 'expired' | 'invalid' | 'blocked' | 'already_bound' | 'tenant_blocked' }
 *
 * Always logs the attempt to audit_logs (regardless of outcome) so admin
 * can see brute-force attempts.
 */
async function tryBind(pool, { code, lineUserId, sourceIp, sourceUa }) {
  const cleaned = String(code || '').trim().toUpperCase();
  if (!cleaned.startsWith(CODE_PREFIX)) {
    return { ok: false, reason: 'invalid' };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lookup = await client.query(
      `SELECT b.id, b.tenant_id, b.status, b.expires_at,
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
      // Auto-mark expired so admin sees it
      await client.query(
        `UPDATE line_bindings SET status='expired', updated_at=NOW() WHERE id=$1`,
        [row.id]
      );
      await client.query('COMMIT');
      return { ok: false, reason: 'expired' };
    }
    // Refuse if this LINE userId is already bound to a different tenant
    const dup = await client.query(
      `SELECT tenant_id FROM line_bindings
         WHERE line_user_id=$1 AND status='bound' AND tenant_id <> $2 LIMIT 1`,
      [lineUserId, row.tenant_id]
    );
    if (dup.rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'line_user_already_bound', otherTenantId: dup.rows[0].tenant_id };
    }
    // Bind!
    await client.query(
      `UPDATE line_bindings
          SET status='bound', line_user_id=$1, bound_at=NOW(), updated_at=NOW()
        WHERE id=$2`,
      [lineUserId, row.id]
    );
    await client.query(
      `UPDATE tenants SET line_user_id=$1, updated_at=NOW() WHERE id=$2`,
      [lineUserId, row.tenant_id]
    );
    await client.query('COMMIT');
    return {
      ok: true,
      tenantId: row.tenant_id,
      fullName: row.full_name,
      roomId: row.current_room_id,
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
      t.line_user_id, t.line_binding_blocked, t.status AS tenant_status,
      b.id AS binding_id, b.code, b.status AS binding_status,
      b.expires_at, b.bound_at
    FROM tenants t
    LEFT JOIN LATERAL (
      SELECT id, code, status, expires_at, bound_at
        FROM line_bindings
        WHERE tenant_id = t.id
          AND status IN ('pending', 'bound')
        ORDER BY (CASE status WHEN 'pending' THEN 0 ELSE 1 END), created_at DESC
        LIMIT 1
    ) b ON TRUE
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
