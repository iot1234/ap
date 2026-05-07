// services/notifier.js
// Unified notification dispatcher. Picks channel per feature flags,
// records every attempt in notifications_log, and falls back across
// channels on failure (LINE → Email → SMS).
//
// All functions are non-throwing — a failed notify never breaks the
// originating request.

const lineNotify = require('./line');
const email = require('./email');
const sms = require('./sms');
const secrets = require('./secrets');

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

  // 1. LINE (primary)
  const lineOwner = secrets.get('LINE_OWNER_USER_ID');
  if (lineNotify.isConfigured() && lineOwner) {
    const ok = await lineNotify.notifyOwner(text);
    await logResult(pool, {
      channel: 'line',
      recipient: lineOwner,
      subject, body: text,
      status: ok ? 'sent' : 'failed',
    });
    if (ok) return { channel: 'line', ok: true };
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

  if (lineId && lineNotify.isConfigured()) {
    const ok = await lineNotify.pushText(lineId, text);
    await logResult(pool, {
      channel: 'line', recipient: lineId,
      subject, body: text, status: ok ? 'sent' : 'failed',
    });
    if (ok) return { channel: 'line', ok: true };
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
