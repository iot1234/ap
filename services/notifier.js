// services/notifier.js
// Unified notification dispatcher. Picks channel per feature flags,
// records every attempt in notifications_log, and falls back across
// channels on failure (LINE → Email → SMS).
//
// All functions are non-throwing — a failed notify never breaks the
// originating request.

const lineNotify = require('./line');
const lineOa = require('./lineOa');
const email = require('./email');
const sms = require('./sms');
const secrets = require('./secrets');

// Per-tenant LINE dispatch: figure out which OA the tenant is bound on,
// load that OA's credentials, push through it. Falls back to env-OA when
// tenant.line_oa_id is null (legacy bindings predating multi-OA).
async function pushLineToTenant(pool, tenant, text) {
  const lineId = tenant.line_user_id || tenant.lineUserId || null;
  if (!lineId) return { ok: false, reason: 'no_line_id' };
  const oaId = tenant.line_oa_id != null ? tenant.line_oa_id : null;
  let oa;
  try {
    oa = await lineOa.resolveForTenant(pool, oaId, { withSecrets: true });
  } catch (err) {
    return { ok: false, reason: 'oa_lookup_failed', error: err.message };
  }
  if (!oa || !oa.channelAccessToken) {
    return { ok: false, reason: 'oa_not_configured' };
  }
  if (oa.enabled === false) {
    return { ok: false, reason: 'oa_disabled' };
  }
  const ok = await lineNotify.pushText(oa, lineId, text);
  return { ok, oaId: oa.id, oaSlug: oa.slug, lineId };
}

async function logResult(pool, row) {
  try {
    await pool.query(
      `INSERT INTO notifications_log (channel, recipient, subject, body, status, error)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [row.channel, row.recipient || '', row.subject || null,
       (row.body || '').slice(0, 4000), row.status, row.error || null]
    );
  } catch (err) {
    console.error('[notifier] log insert failed:', err.message);
  }
}

/**
 * Notify the owner / admin via the first available channel.
 * Used for system events (new booking, new ticket, slip uploaded).
 *
 * @param {object} ctx - { pool, features }
 * @param {object} msg - { subject, text, html?, line?: string }
 * @returns {Promise<{ channel: string, ok: boolean }>}
 */
async function notifyOwner(ctx, msg) {
  const { pool, features } = ctx;
  const text = msg.text || msg.subject || '';
  const subject = msg.subject || 'แจ้งเตือนระบบ';

  // 1. LINE — try the default OA's owner first, then fall back to env owner.
  // Each OA can have its own ownerUserId so a multi-building deployment can
  // send "OA #1 events" to OA #1's owner contact and "OA #2 events" to its
  // own contact, but for system-wide messages we just use the default OA.
  let oaForOwner = null;
  try { oaForOwner = await lineOa.getDefault(pool, { withSecrets: true }); }
  catch { /* env OA still works below */ }
  const lineOwner = (oaForOwner && oaForOwner.ownerUserId) || secrets.get('LINE_OWNER_USER_ID');
  if (oaForOwner && oaForOwner.channelAccessToken && lineOwner) {
    const ok = await lineNotify.pushText(oaForOwner, lineOwner, text);
    await logResult(pool, {
      channel: 'line',
      recipient: lineOwner,
      subject, body: `[oa:${oaForOwner.slug}] ${text}`,
      status: ok ? 'sent' : 'failed',
    });
    if (ok) return { channel: 'line', ok: true, oa: oaForOwner.slug };
  }

  // 2. Email (fallback)
  if (email.isConfigured(features) && features.email && features.email.from) {
    const to = secrets.get('OWNER_EMAIL') || features.email.from;
    const ok = await email.send(features, {
      to, subject,
      text,
      html: msg.html,
    });
    await logResult(pool, {
      channel: 'email', recipient: to, subject, body: text,
      status: ok ? 'sent' : 'failed',
    });
    if (ok) return { channel: 'email', ok: true };
  }

  // 3. None worked → log skip
  await logResult(pool, {
    channel: 'none', recipient: '', subject, body: text,
    status: 'failed', error: 'no channel configured',
  });
  return { channel: 'none', ok: false };
}

/**
 * Notify a specific tenant. Tries email first if enabled and address known,
 * otherwise LINE userId if known.
 */
async function notifyTenant(ctx, tenant, msg) {
  const { pool, features } = ctx;
  if (!tenant) return { channel: 'none', ok: false };
  const subject = msg.subject || 'แจ้งเตือน';
  const text = msg.text || subject;
  // Accept both DB shape (snake_case from `tenants` table) and the legacy
  // rooms.tenant blob shape (camelCase). Earlier versions only matched
  // snake_case, so callers reading from rooms.tenant got nothing dispatched.
  const lineId = tenant.line_user_id || tenant.lineUserId || null;
  const phone = tenant.phone || null;
  const mail = tenant.email || null;

  // Don't push to ex-tenants. The "moved_out" / "blacklist" / soft-deleted
  // states all silence delivery. This is the user-facing safety mentioned in
  // the spec: "ผู้เช่าออกระบบก็จะไม่ส่งแล้ว". The caller can still set
  // `force=true` on msg if they need a one-off message (e.g. final bill).
  const status = tenant.status || tenant.tenant_status || 'active';
  const isInactive = status !== 'active' || tenant.deleted_at;
  if (isInactive && !msg.force) {
    await logResult(pool, {
      channel: 'none', recipient: phone || mail || '',
      subject, body: text, status: 'skipped',
      error: `tenant inactive (status=${status})`,
    });
    return { channel: 'none', ok: false, skipped: true, reason: 'inactive' };
  }

  if (lineId) {
    const result = await pushLineToTenant(pool, tenant, text);
    await logResult(pool, {
      channel: 'line', recipient: lineId,
      subject,
      body: result.oaSlug ? `[oa:${result.oaSlug}] ${text}` : text,
      status: result.ok ? 'sent' : 'failed',
      error: result.ok ? null : (result.reason || result.error || 'failed'),
    });
    if (result.ok) return { channel: 'line', ok: true, oa: result.oaSlug };
  }

  if (mail && email.isConfigured(features)) {
    const ok = await email.send(features, {
      to: mail, subject, text, html: msg.html,
    });
    await logResult(pool, {
      channel: 'email', recipient: mail,
      subject, body: text, status: ok ? 'sent' : 'failed',
    });
    if (ok) return { channel: 'email', ok: true };
  }

  // SMS — final fallback. Skipped (with a clear log row) when no SMS
  // provider is configured, so a half-implemented stub doesn't make every
  // notification look failed. C1.
  if (phone && sms.isConfigured(features)) {
    try {
      const ok = await sms.send(features, { to: phone, text });
      await logResult(pool, {
        channel: 'sms', recipient: phone,
        subject, body: text, status: ok ? 'sent' : 'failed',
      });
      if (ok) return { channel: 'sms', ok: true };
    } catch (err) {
      await logResult(pool, {
        channel: 'sms', recipient: phone, subject, body: text,
        status: 'failed', error: err.message,
      });
    }
  }

  await logResult(pool, {
    channel: 'none', recipient: phone || '', subject, body: text,
    status: 'failed', error: 'tenant has no reachable channel',
  });
  return { channel: 'none', ok: false };
}

module.exports = { notifyOwner, notifyTenant };
