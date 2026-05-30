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

function lineBindingError(message, code, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

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

async function syncTenantLineCacheFromLatest(client, tenantId) {
  const latest = await client.query(
    `SELECT line_user_id, oa_id
       FROM line_bindings
      WHERE tenant_id=$1
        AND status='bound'
        AND line_user_id IS NOT NULL
      ORDER BY bound_at DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    [tenantId]
  );
  const row = latest.rows[0] || null;
  await client.query(
    `UPDATE tenants
        SET line_user_id=$1,
            line_oa_id=$2,
            updated_at=NOW()
      WHERE id=$3`,
    [row ? row.line_user_id : null, row ? row.oa_id || null : null, tenantId]
  );
  return row;
}

/**
 * Issue a new binding code for a tenant. By default it revokes old pending
 * tenant codes first; pass replacePending=false when issuing an additional
 * code for another LINE account in the same room.
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {number} [opts.ttlDays=7]
 * @param {string} [opts.createdBy]
 * @param {boolean} [opts.replacePending=true]
 * @param {number} [opts.targetOaId] - Hint: tenant should send to THIS OA.
 *        If set, only that OA's webhook will accept the code (binding
 *        enforces the match). If null/undefined, code accepts any OA.
 * @returns {Promise<{ code, expiresAt, tenantId, targetOaId? }>}
 */
async function issue(pool, { tenantId, ttlDays, createdBy, targetOaId, replacePending = true } = {}) {
  const tid = Number(tenantId);
  if (!Number.isInteger(tid) || tid < 1) {
    throw lineBindingError('invalid tenant id', 'INVALID_TENANT_ID');
  }
  const ttl = Number(ttlDays || DEFAULT_TTL_DAYS);
  if (!Number.isFinite(ttl) || ttl < 1 || ttl > 30) {
    throw lineBindingError('ttlDays must be 1-30', 'INVALID_TTL_DAYS');
  }
  let target = null;
  if (targetOaId != null && targetOaId !== '' && Number(targetOaId) !== 0) {
    target = Number(targetOaId);
    if (!Number.isInteger(target) || target < 1) {
      throw lineBindingError('invalid target LINE OA', 'INVALID_TARGET_OA');
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Refuse if tenant is blocked
    const t = await client.query(
      `SELECT id, full_name, line_binding_blocked, status, current_room_id
         FROM tenants
         WHERE id=$1 AND deleted_at IS NULL
         FOR UPDATE`,
      [tid]
    );
    if (!t.rows.length) {
      await client.query('ROLLBACK');
      throw lineBindingError('tenant not found', 'TENANT_NOT_FOUND', 404);
    }
    if (t.rows[0].line_binding_blocked) {
      await client.query('ROLLBACK');
      throw lineBindingError('tenant is blocked from LINE binding', 'TENANT_LINE_BINDING_BLOCKED');
    }
    if (t.rows[0].status !== 'active' || !t.rows[0].current_room_id) {
      await client.query('ROLLBACK');
      throw lineBindingError('tenant is not active for LINE binding', 'TENANT_NOT_ACTIVE_FOR_LINE');
    }
    // If a target OA was specified, verify it exists and is enabled.
    if (target != null) {
      const oa = await client.query(
        `SELECT id, enabled FROM line_oas WHERE id=$1 AND deleted_at IS NULL`,
        [target]
      );
      if (!oa.rows.length || !oa.rows[0].enabled) {
        await client.query('ROLLBACK');
        throw lineBindingError('OA ที่เลือกไม่มีอยู่หรือถูกปิดอยู่', 'TARGET_OA_NOT_AVAILABLE');
      }
    }
    if (replacePending) {
      await client.query(
        `UPDATE line_bindings SET status='revoked', updated_at=NOW()
           WHERE tenant_id=$1 AND status='pending'`,
        [tid]
      );
    }
    // Create new code (loop in the rare case of hex collision)
    let code, attempt = 0;
    while (attempt < 5) {
      code = generateCode();
      try {
        const ins = await client.query(
          `INSERT INTO line_bindings (tenant_id, code, status, expires_at, created_by, target_oa_id)
           VALUES ($1, $2, 'pending', NOW() + ($3::int || ' days')::interval, $4, $5)
           ON CONFLICT (code) DO NOTHING
           RETURNING id, code, expires_at, target_oa_id, created_at`,
          [tid, code, ttl, createdBy || null, target]
        );
        if (!ins.rows.length) {
          attempt++;
          continue;
        }
        await client.query('COMMIT');
        return {
          id: ins.rows[0].id, code, expiresAt: ins.rows[0].expires_at,
          createdAt: ins.rows[0].created_at,
          tenantId: tid, targetOaId: ins.rows[0].target_oa_id,
        };
      } catch (err) {
        if (err.code === '23505' && err.constraint === 'uq_line_bindings_pending_per_tenant') {
          throw lineBindingError(
            'database migration required: multiple pending LINE codes per room are still blocked',
            'LINE_BINDING_PENDING_UNIQUE_MIGRATION_REQUIRED',
            409
          );
        }
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
 * Revoke one bound LINE account without removing the other LINE accounts on
 * the same room. tenants.line_user_id is only a cache; after the revoke it is
 * pointed at the newest remaining bound account, or cleared if none remain.
 */
async function revokeAccount(pool, { tenantId, bindingId } = {}) {
  const tid = Number(tenantId);
  const bid = Number(bindingId);
  if (!Number.isInteger(tid) || tid < 1 || !Number.isInteger(bid) || bid < 1) {
    throw new Error('tenantId and bindingId required');
  }
  const client = await pool.connect();
  let affectedOaIds = [];
  let result = null;
  try {
    await client.query('BEGIN');
    const before = await client.query(
      `SELECT id, tenant_id, line_user_id, oa_id, status
         FROM line_bindings
        WHERE id=$1
          AND tenant_id=$2
          AND status='bound'
        FOR UPDATE`,
      [bid, tid]
    );
    if (!before.rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }
    const revoked = before.rows[0];
    affectedOaIds.push(revoked.oa_id);
    await client.query(
      `UPDATE line_bindings
          SET status='revoked', updated_at=NOW()
        WHERE id=$1
          AND tenant_id=$2
          AND status='bound'`,
      [bid, tid]
    );
    const latest = await syncTenantLineCacheFromLatest(client, tid);
    affectedOaIds.push(latest && latest.oa_id);
    const countRes = await client.query(
      `SELECT COUNT(*)::int AS bound_count
         FROM line_bindings
        WHERE tenant_id=$1
          AND status='bound'
          AND line_user_id IS NOT NULL`,
      [tid]
    );
    result = {
      ok: true,
      tenantId: tid,
      bindingId: bid,
      revokedLineUserId: revoked.line_user_id || null,
      remainingBoundCount: Number(countRes.rows[0]?.bound_count) || 0,
      activeLineUserId: latest ? latest.line_user_id : null,
      activeOaId: latest ? latest.oa_id || null : null,
    };
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await refreshOaBoundCounts(pool, affectedOaIds);
  return result;
}

/**
 * Revoke one unused pending key. This intentionally does not touch bound LINE
 * accounts or tenants.line_user_id. If the key was already consumed/revoked/
 * expired by another request, callers get a clean not_pending result.
 */
async function revokePendingCode(pool, { tenantId, bindingId } = {}) {
  const tid = Number(tenantId);
  const bid = Number(bindingId);
  if (!Number.isInteger(tid) || tid < 1 || !Number.isInteger(bid) || bid < 1) {
    throw lineBindingError('tenantId and bindingId required', 'INVALID_BINDING_ID');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT id, tenant_id, code, status, expires_at, created_at, target_oa_id
         FROM line_bindings
        WHERE id=$1
          AND tenant_id=$2
        FOR UPDATE`,
      [bid, tid]
    );
    if (!existing.rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not_found', tenantId: tid, bindingId: bid };
    }
    const row = existing.rows[0];
    if (row.status !== 'pending') {
      await client.query('ROLLBACK');
      return {
        ok: false,
        reason: 'not_pending',
        status: row.status,
        tenantId: tid,
        bindingId: bid,
        code: row.code,
      };
    }
    const revoked = await client.query(
      `UPDATE line_bindings
          SET status='revoked',
              updated_at=NOW()
        WHERE id=$1
          AND tenant_id=$2
          AND status='pending'
        RETURNING id, code, status, expires_at, created_at, target_oa_id`,
      [bid, tid]
    );
    if (revoked.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not_pending', tenantId: tid, bindingId: bid, code: row.code };
    }
    await client.query('COMMIT');
    return {
      ok: true,
      tenantId: tid,
      bindingId: bid,
      code: revoked.rows[0].code,
      status: revoked.rows[0].status,
      expiresAt: revoked.rows[0].expires_at,
      createdAt: revoked.rows[0].created_at,
      targetOaId: revoked.rows[0].target_oa_id,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
           ON CONFLICT (code) DO NOTHING
           RETURNING id, code, expires_at, target_oa_id, created_at`,
          [id, code, ttl, createdBy || 'public-booking', target]
        );
        if (!ins.rows.length) {
          attempt++;
          continue;
        }
        await client.query('COMMIT');
        return {
          id: ins.rows[0].id,
          code,
          expiresAt: ins.rows[0].expires_at,
          createdAt: ins.rows[0].created_at,
          bookingId: id,
          targetOaId: ins.rows[0].target_oa_id,
        };
      } catch (err) {
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
       LIMIT 200`,
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
  const boundAccounts = await pool.query(
    `SELECT b.id, b.code, b.line_user_id, b.oa_id, b.bound_at, b.created_at, b.expires_at,
            o.name AS oa_name, o.slug AS oa_slug
       FROM line_bindings b
       LEFT JOIN line_oas o ON o.id = b.oa_id AND o.deleted_at IS NULL
      WHERE b.tenant_id=$1
        AND b.status='bound'
        AND b.line_user_id IS NOT NULL
      ORDER BY b.bound_at DESC NULLS LAST, b.updated_at DESC NULLS LAST, b.id DESC
      LIMIT 200`,
    [tenantId]
  );
  const boundCount = Number(countRes.rows[0]?.bound_count) || 0;
  return {
    tenant,
    pending: b.rows.find((r) => r.status === 'pending') || null,
    pendingCodes: b.rows.filter((r) => r.status === 'pending'),
    bound: b.rows.find((r) => r.status === 'bound') || null,
    boundCount,
    boundAccounts: boundAccounts.rows,
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

/**
 * Revoke every LINE binding that belongs to a public booking when that
 * booking has been cancelled/rejected. Layered defence:
 *
 *   - tryBind() already refuses to bind a code whose booking is in a
 *     terminal status (services/lineBinding.js, the JOIN on bookings +
 *     booking_status check). So this revoke is NOT a security fix — the
 *     binding can't actually be used.
 *
 *   - What it IS for: cleaning up stale rows that would otherwise count
 *     toward the partial unique index `uq_line_bindings_active_user_per_oa`
 *     (status='bound' bindings whose booking was cancelled AFTER bind but
 *     BEFORE quick-invite transferred them). Without revoke, a follow-up
 *     booking on the same OA could collide on the same line_user_id and
 *     fail to issue a fresh code. Also keeps the admin /admin#line-bindings
 *     queue tidy (no orphan "bound but booking_id points at cancelled").
 *
 * Scope:
 *   - `booking_id = $1 AND tenant_id IS NULL` — only bindings still anchored
 *     at the booking. transferBookingBindings (during quick-invite) clears
 *     booking_id and sets tenant_id, so a transferred binding represents a
 *     live tenant relationship that must NOT be touched here.
 *   - `status IN ('pending', 'bound')` — the only states where revoke is
 *     meaningful. 'blocked' and 'revoked' are already terminal-equivalent
 *     and don't count toward the per-OA active-user uniqueness; touching
 *     them would just re-stamp updated_at for no reason.
 *
 * Idempotent: calling twice on the same bookingId returns `revoked: 0` on
 * the second call (WHERE filter no longer matches).
 *
 * @param {object} pool       - pg pool
 * @param {object} opts
 * @param {string} opts.bookingId - the external_id of the cancelled/rejected
 *                                  booking (e.g. "BK-PUB-abc123")
 * @returns {Promise<{ revoked: number, oaIds: number[] }>} — count + the
 *                                  OA ids whose bound_count was refreshed
 */
async function revokeBookingBindings(pool, { bookingId } = {}) {
  const bid = String(bookingId || '').slice(0, 64);
  if (!bid) throw new Error('bookingId required');
  const client = await pool.connect();
  let affectedOaIds = [];
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE line_bindings
          SET status='revoked', updated_at=NOW()
        WHERE booking_id=$1
          AND tenant_id IS NULL
          AND status IN ('pending', 'bound')
        RETURNING oa_id`,
      [bid]
    );
    affectedOaIds = result.rows.map((r) => r.oa_id).filter(Boolean);
    await client.query('COMMIT');
    // Refresh per-OA bound_count after commit so admin /admin#line-oas
    // sees the right total. Best-effort: a refresh failure doesn't undo
    // the revoke (the count is a denormalised cache the next refresh will
    // self-correct anyway).
    if (affectedOaIds.length) {
      await refreshOaBoundCounts(pool, affectedOaIds).catch(() => {});
    }
    return { revoked: result.rowCount, oaIds: affectedOaIds };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
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
      b.created_at, b.expires_at, b.bound_at, b.oa_id, b.target_oa_id,
      COALESCE(bc.bound_count, 0)::int AS bound_count,
      o.name  AS oa_name,        o.slug  AS oa_slug,
      tg.name AS target_oa_name, tg.slug AS target_oa_slug
    FROM tenants t
    LEFT JOIN LATERAL (
      SELECT id, code, status, created_at, expires_at, bound_at, oa_id, target_oa_id
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
  issue, issueBooking, revoke, revokeAccount, revokePendingCode, revokeBookingBindings,
  block, unblock, getStatus, tryBind,
  transferBookingBindings, listTenantRecipients, listBookingRecipients, listAll,
  CODE_PREFIX, generateCode,
};
