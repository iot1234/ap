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

async function refreshOaBoundCounts(pool, oaIds = []) {
  const unique = [...new Set(oaIds.filter((id) => id != null).map(Number).filter(Number.isFinite))];
  for (const oaId of unique) {
    await pool.query(
      `UPDATE line_oas SET bound_count = (
          SELECT COUNT(*) FROM line_bindings
           WHERE oa_id=$1
             AND status='bound'
             AND line_user_id IS NOT NULL
        ), last_seen_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [oaId]
    ).catch((err) => console.warn('[line] bound_count update failed:', err.message));
  }
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
      `SELECT id, full_name, line_binding_blocked, status, current_room_id
         FROM tenants
         WHERE id=$1 AND deleted_at IS NULL
         FOR UPDATE`,
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
    if (t.rows[0].status !== 'active' || !t.rows[0].current_room_id) {
      await client.query('ROLLBACK');
      throw new Error('tenant is not active for LINE binding');
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
  let prevOaIds = [];
  try {
    await client.query('BEGIN');
    // Capture which OA the tenant was bound on so we can refresh its count
    const before = await client.query(
      `SELECT line_oa_id FROM tenants WHERE id=$1`,
      [tenantId]
    );
    const boundOas = await client.query(
      `SELECT DISTINCT oa_id FROM line_bindings
         WHERE tenant_id=$1 AND status='bound' AND oa_id IS NOT NULL`,
      [tenantId]
    );
    prevOaIds = [
      before.rows[0]?.line_oa_id || null,
      ...boundOas.rows.map((r) => r.oa_id),
    ];
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
  await refreshOaBoundCounts(pool, prevOaIds);
}

/**
 * Issue a booking-stage binding code before a tenant row exists. The code is
 * tied to bookings.external_id and later transferred to the tenant created by
 * quick-invite. This avoids creating fake active tenants just to receive LINE.
 */
async function issueBooking(pool, { bookingId, ttlDays, createdBy, targetOaId } = {}) {
  const id = String(bookingId || '').slice(0, 64);
  if (!id) throw new Error('bookingId required');
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
    const b = await client.query(
      `SELECT external_id, status, phone, name
         FROM bookings
        WHERE external_id=$1
        FOR UPDATE`,
      [id]
    ).catch((err) => {
      if (err.code === '42P01' || err.code === '42703') return { rows: [] };
      throw err;
    });
    if (b.rows.length && ['rejected', 'cancelled', 'completed'].includes(String(b.rows[0].status || ''))) {
      await client.query('ROLLBACK');
      throw new Error('booking is not active for LINE binding');
    }
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
    await client.query(
      `UPDATE line_bindings SET status='revoked', updated_at=NOW()
         WHERE booking_id=$1 AND tenant_id IS NULL AND status='pending'`,
      [id]
    );
    let code, attempt = 0;
    while (attempt < 5) {
      code = generateCode();
      try {
        const ins = await client.query(
          `INSERT INTO line_bindings (tenant_id, booking_id, code, status, expires_at, created_by, target_oa_id)
           VALUES (NULL, $1, $2, 'pending', NOW() + ($3::int || ' days')::interval, $4, $5)
           RETURNING id, code, expires_at, target_oa_id`,
          [id, code, ttl, createdBy || 'public-booking', target]
        );
        await client.query('COMMIT');
        return {
          id: ins.rows[0].id,
          code,
          expiresAt: ins.rows[0].expires_at,
          bookingId: id,
          targetOaId: ins.rows[0].target_oa_id,
        };
      } catch (err) {
        if (err.code === '23505') { attempt++; continue; }
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
 * Block a tenant from LINE binding entirely. Revokes their codes too.
 */
async function block(pool, { tenantId, reason }) {
  const client = await pool.connect();
  let prevOaIds = [];
  try {
    await client.query('BEGIN');
    const before = await client.query(
      `SELECT line_oa_id FROM tenants WHERE id=$1`,
      [tenantId]
    );
    const boundOas = await client.query(
      `SELECT DISTINCT oa_id FROM line_bindings
         WHERE tenant_id=$1 AND status='bound' AND oa_id IS NOT NULL`,
      [tenantId]
    );
    prevOaIds = [
      before.rows[0]?.line_oa_id || null,
      ...boundOas.rows.map((r) => r.oa_id),
    ];
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
  await refreshOaBoundCounts(pool, prevOaIds);
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
  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS bound_count
       FROM line_bindings
      WHERE tenant_id=$1
        AND status='bound'
        AND line_user_id IS NOT NULL`,
    [tenantId]
  );
  const boundCount = Number(countRes.rows[0]?.bound_count) || 0;
  return {
    tenant,
    pending: b.rows.find((r) => r.status === 'pending') || null,
    bound: b.rows.find((r) => r.status === 'bound') || null,
    boundCount,
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
      `SELECT b.id, b.tenant_id, b.booking_id, b.status, b.expires_at, b.target_oa_id,
              t.full_name, t.current_room_id, t.status AS tenant_status,
              t.line_binding_blocked,
              bk.name AS booking_name, bk.room_id AS booking_room_id,
              bk.status AS booking_status
         FROM line_bindings b
         LEFT JOIN tenants t ON t.id = b.tenant_id AND t.deleted_at IS NULL
         LEFT JOIN bookings bk ON bk.external_id = b.booking_id
         WHERE b.code = $1
           AND (b.tenant_id IS NULL OR t.id IS NOT NULL)
         LIMIT 1
         FOR UPDATE OF b`,
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
    const isBookingBinding = !row.tenant_id && !!row.booking_id;
    if (!isBookingBinding && (row.tenant_status !== 'active' || !row.current_room_id)) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'tenant_not_active' };
    }
    if (isBookingBinding && ['rejected', 'cancelled', 'completed'].includes(String(row.booking_status || ''))) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'booking_not_active' };
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
    // Refuse if this LINE userId is already bound to another tenant/booking
    // on the same OA. Different OAs see different userIds for the same human
    // (LINE quirk), so cross-OA dedup would be wrong.
    const dup = await client.query(
      `SELECT tenant_id, booking_id FROM line_bindings
         WHERE line_user_id=$1
           AND COALESCE(oa_id, 0) = COALESCE($2::bigint, 0)
           AND status='bound'
           AND id <> $3
         LIMIT 1`,
      [lineUserId, oaIdNum, row.id]
    );
    if (dup.rows.length) {
      const sameTenant = row.tenant_id != null
        && dup.rows[0].tenant_id != null
        && String(dup.rows[0].tenant_id) === String(row.tenant_id);
      const sameBooking = row.booking_id != null
        && dup.rows[0].booking_id != null
        && String(dup.rows[0].booking_id) === String(row.booking_id);
      await client.query('ROLLBACK');
      return {
        ok: false,
        reason: sameTenant || sameBooking ? 'already_bound' : 'line_user_already_bound',
        otherTenantId: dup.rows[0].tenant_id || null,
        otherBookingId: dup.rows[0].booking_id || null,
      };
    }
    // Bind!
    const bound = await client.query(
      `UPDATE line_bindings
          SET status='bound', line_user_id=$1, oa_id=$2, bound_at=NOW(), updated_at=NOW()
        WHERE id=$3 AND status='pending'
        RETURNING id`,
      [lineUserId, oaIdNum, row.id]
    );
    if (bound.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'already_bound' };
    }
    if (row.tenant_id) {
      // Keep the latest bound LINE in tenants.* as a primary/backward-
      // compatibility cache. The complete recipient list lives in
      // line_bindings and is used for fan-out notifications.
      await client.query(
        `UPDATE tenants
            SET line_user_id=$1, line_oa_id=$2, updated_at=NOW()
          WHERE id=$3`,
        [lineUserId, oaIdNum, row.tenant_id]
      );
    }
    await client.query('COMMIT');
    // Update OA bound_count outside the transaction (best-effort, eventual-
    // consistency UI counter only). Recomputed via SELECT COUNT so even if a
    // previous update failed silently, the next bind self-heals the count.
    // Concurrent binds may race here but the SUBQUERY recounts the truth, so
    // the final state always converges to the actual bound row count rather
    // than incrementing a stale field. Safe to fire-and-forget.
    await refreshOaBoundCounts(pool, [oaIdNum]);
    return {
      ok: true,
      tenantId: row.tenant_id || null,
      bookingId: row.booking_id || null,
      fullName: row.full_name || row.booking_name,
      roomId: row.current_room_id || row.booking_room_id,
      oaId: oaIdNum,
      pendingTenantLink: isBookingBinding,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Race: two concurrent tryBinds for the same (oa_id, line_user_id) from
    // different pending codes both pass the dedup SELECT and both attempt
    // the UPDATE that flips status='bound'. The partial unique index
    // uq_line_bindings_active_user_per_oa rejects the second with 23505.
    // Map this to the same clean reason the dedup branch returns rather
    // than letting the error bubble up as a generic 500 / "ระบบขัดข้อง".
    if (err && err.code === '23505') {
      return { ok: false, reason: 'line_user_already_bound', raceLost: true };
    }
    throw err;
  } finally {
    client.release();
  }
}

async function transferBookingBindings(pool, { bookingId, tenantId } = {}) {
  const bid = String(bookingId || '').slice(0, 64);
  const tid = Number(tenantId);
  if (!bid || !Number.isInteger(tid) || tid < 1) {
    throw new Error('bookingId and tenantId required');
  }
  const client = await pool.connect();
  let affectedOaIds = [];
  try {
    await client.query('BEGIN');
    const moved = await client.query(
      `UPDATE line_bindings
          SET tenant_id=$2,
              booking_id=NULL,
              updated_at=NOW()
        WHERE booking_id=$1
          AND tenant_id IS NULL
          AND status IN ('pending', 'bound')
        RETURNING line_user_id, oa_id, status, bound_at`,
      [bid, tid]
    );
    affectedOaIds = moved.rows.map((r) => r.oa_id);
    const latestBound = moved.rows
      .filter((r) => r.status === 'bound' && r.line_user_id)
      .sort((a, b) => new Date(b.bound_at || 0) - new Date(a.bound_at || 0))[0];
    if (latestBound) {
      await client.query(
        `UPDATE tenants
            SET line_user_id=$1, line_oa_id=$2, updated_at=NOW()
          WHERE id=$3`,
        [latestBound.line_user_id, latestBound.oa_id || null, tid]
      );
    }
    await client.query('COMMIT');
    await refreshOaBoundCounts(pool, affectedOaIds);
    return {
      ok: true,
      moved: moved.rowCount,
      bound: moved.rows.filter((r) => r.status === 'bound').length,
      pending: moved.rows.filter((r) => r.status === 'pending').length,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function listTenantRecipients(pool, tenantId) {
  const tid = Number(tenantId);
  if (!Number.isInteger(tid) || tid < 1) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (COALESCE(oa_id, 0), line_user_id)
            line_user_id, oa_id, bound_at
       FROM line_bindings
      WHERE tenant_id=$1
        AND status='bound'
        AND line_user_id IS NOT NULL
      ORDER BY COALESCE(oa_id, 0), line_user_id, bound_at DESC NULLS LAST`,
    [tid]
  );
  return rows;
}

async function listBookingRecipients(pool, bookingId) {
  const bid = String(bookingId || '').slice(0, 64);
  if (!bid) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (COALESCE(oa_id, 0), line_user_id)
            line_user_id, oa_id, bound_at
       FROM line_bindings
      WHERE booking_id=$1
        AND tenant_id IS NULL
        AND status='bound'
        AND line_user_id IS NOT NULL
      ORDER BY COALESCE(oa_id, 0), line_user_id, bound_at DESC NULLS LAST`,
    [bid]
  );
  return rows;
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
      COALESCE(bc.bound_count, 0)::int AS bound_count,
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
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS bound_count
        FROM line_bindings
       WHERE tenant_id = t.id
         AND status='bound'
         AND line_user_id IS NOT NULL
    ) bc ON TRUE
    LEFT JOIN line_oas o  ON o.id  = b.oa_id        AND o.deleted_at  IS NULL
    LEFT JOIN line_oas tg ON tg.id = b.target_oa_id AND tg.deleted_at IS NULL
    WHERE t.deleted_at IS NULL
      ORDER BY
        CASE
          WHEN b.status = 'pending' THEN 0
        WHEN COALESCE(bc.bound_count, 0) = 0 AND t.line_user_id IS NULL AND NOT t.line_binding_blocked THEN 1
        WHEN COALESCE(bc.bound_count, 0) > 0 OR t.line_user_id IS NOT NULL THEN 2
        ELSE 3
      END,
      t.full_name ASC
  `);
  return rows;
}

module.exports = {
  issue, issueBooking, revoke, block, unblock, getStatus, tryBind,
  transferBookingBindings, listTenantRecipients, listBookingRecipients, listAll,
  CODE_PREFIX, generateCode,
};
