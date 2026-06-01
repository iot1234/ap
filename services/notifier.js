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
const lineBinding = require('./lineBinding');
// Lazy-required to avoid a circular module-load cycle (notificationQueue
// dispatches via line/email/sms — which never reach back into notifier,
// but Node still evaluates the require eagerly at top-of-file).
let _notifQueue = null;
function getQueue() {
  if (_notifQueue) return _notifQueue;
  try { _notifQueue = require('./notificationQueue'); }
  catch { _notifQueue = null; }
  return _notifQueue;
}

// Per-tenant LINE dispatch: figure out which OA the tenant is bound on,
// load that OA's credentials, push through it. Falls back to env-OA when
// tenant.line_oa_id is null (legacy bindings predating multi-OA).
async function pushLineToTenant(pool, tenant, text, messages) {
  const lineId = tenant.line_user_id || tenant.lineUserId || null;
  if (!lineId) return { ok: false, reason: 'no_line_id' };
  if (!lineNotify.isLikelyUserId(lineId)) return { ok: false, reason: 'invalid_line_id' };
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
  if (Array.isArray(messages) && messages.length > 0) {
    try {
      await lineNotify.pushMessagesStrict(oa, lineId, messages);
      return { ok: true, oaId: oa.id, oaSlug: oa.slug, lineId, rich: true };
    } catch (err) {
      return { ok: false, reason: err.fatal ? 'line_rich_fatal' : 'line_rich_failed', error: err.message };
    }
  }
  const ok = await lineNotify.pushText(oa, lineId, text);
  return { ok, oaId: oa.id, oaSlug: oa.slug, lineId };
}

async function getTenantLineRecipients(pool, tenant) {
  const tenantId = tenant && (tenant.id || tenant.tenant_id || tenant.tenantId);
  const rows = tenantId ? await lineBinding.listTenantRecipients(pool, tenantId).catch(() => []) : [];
  const recipients = [];
  const seen = new Set();
  const add = (lineUserId, lineOaId) => {
    const lineId = lineNotify.isLikelyUserId(lineUserId) ? String(lineUserId).trim() : null;
    if (!lineId) return;
    const oaId = lineOaId != null ? lineOaId : null;
    const key = `${oaId == null ? 0 : oaId}:${lineId}`;
    if (seen.has(key)) return;
    seen.add(key);
    recipients.push({ line_user_id: lineId, line_oa_id: oaId });
  };
  for (const row of rows) add(row.line_user_id, row.oa_id);
  if (Array.isArray(tenant?.lineRecipients)) {
    for (const row of tenant.lineRecipients) {
      add(row.line_user_id || row.lineUserId, row.oa_id ?? row.line_oa_id);
    }
  }
  add(tenant?.line_user_id || tenant?.lineUserId, tenant?.line_oa_id);
  return recipients;
}

function appendLineRecipientCount(text, count) {
  const base = String(text || '');
  const n = Number(count);
  if (!Number.isFinite(n) || n < 0) return base;
  if (
    base.includes('LINE ที่ผูก') ||
    base.includes('ห้องนี้ผูก LINE') ||
    base.includes('ห้อง/การจองนี้ผูก LINE')
  ) {
    return base;
  }
  return `${base}\n\nLINE ที่ผูกกับห้องนี้: ${Math.trunc(n)} บัญชี`;
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
// Master per-channel gate from config.notify.channels (Settings → การแจ้งเตือน →
// ช่องทางการแจ้งเตือน). These toggles used to be placebo: turning OFF อีเมล/LINE
// in Settings did nothing because the dispatcher only consulted feature flags +
// bindings. Now an explicit `false` hard-disables that channel here. Absent /
// unset → allowed (true), so older configs and partial blobs keep working. The
// caller can pass ctx.channels to skip the per-call DB read (e.g. the queue).
async function loadNotifyChannelGate(ctx) {
  if (ctx && ctx.channels && typeof ctx.channels === 'object') {
    const c = ctx.channels;
    return { line: c.line !== false, email: c.email !== false, sms: c.sms !== false };
  }
  try {
    const { rows } = await ctx.pool.query(
      `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
    );
    const ch = rows[0] && rows[0].value && rows[0].value.notify && rows[0].value.notify.channels;
    return {
      line: !(ch && ch.line === false),
      email: !(ch && ch.email === false),
      sms: !(ch && ch.sms === false),
    };
  } catch {
    return { line: true, email: true, sms: true };
  }
}

async function notifyOwner(ctx, msg) {
  const { pool, features } = ctx;
  const chGate = await loadNotifyChannelGate(ctx);
  const text = msg.text || msg.subject || '';
  const subject = msg.subject || 'แจ้งเตือนระบบ';
  // Owner email recipient: prefer an explicit OWNER_EMAIL secret, then the
  // configured From address, then the SMTP_FROM secret. We must NOT gate the
  // attempt on features.email.from — email.send() resolves its own From
  // (SMTP_FROM/smtpUser), so an SMTP setup done entirely via secrets (with no
  // features.email.from) was silently dropping every owner alert.
  const ownerEmailTo = secrets.get('OWNER_EMAIL')
    || (features && features.email && features.email.from)
    || secrets.get('SMTP_FROM');

  // 1. LINE — try the default OA's owner first, then fall back to env owner.
  // Each OA can have its own ownerUserId so a multi-building deployment can
  // send "OA #1 events" to OA #1's owner contact and "OA #2 events" to its
  // own contact, but for system-wide messages we just use the default OA.
  let oaForOwner = null;
  try { oaForOwner = await lineOa.getDefault(pool, { withSecrets: true }); }
  catch { /* env OA still works below */ }
  const rawLineOwner = (oaForOwner && oaForOwner.ownerUserId) || secrets.get('LINE_OWNER_USER_ID');
  const lineOwner = lineNotify.isLikelyUserId(rawLineOwner) ? String(rawLineOwner).trim() : null;
  if (rawLineOwner && !lineOwner) {
    await logResult(pool, {
      channel: 'line',
      recipient: String(rawLineOwner).slice(0, 200),
      subject,
      body: text,
      status: 'skipped',
      error: 'invalid owner LINE userId shape',
    });
  }
  // Track which channels we've already attempted inline so the queue
  // fallback below doesn't re-fire the same broken channel. Previously
  // a failed LINE push got logged as 'failed' AND re-enqueued through
  // the SAME OA — the worker retried 3× through the same channel access
  // token, generating 4 failure log rows for one alert.
  let lineInlineTried = false;
  // Transient = network / timeout / 429 / 5xx — the alert can still be
  // delivered later, so we re-queue it. Structural = bad token / OA disabled /
  // invalid userId / 4xx — won't fix itself, so re-queuing would only burn
  // retries on a broken channel. We branch the queue fallback on this.
  let lineTransientFail = false;
  let emailInlineTried = false;
  if (chGate.line && oaForOwner && oaForOwner.channelAccessToken && lineOwner) {
    lineInlineTried = true;
    try {
      // pushTextStrict THROWS on failure with .status / .fatal attached, so we
      // can classify the failure. (The boolean pushText collapsed every cause
      // to false, which is why transient LINE blips used to be dropped here.)
      await lineNotify.pushTextStrict(oaForOwner, lineOwner, text);
      await logResult(pool, {
        channel: 'line',
        recipient: lineOwner,
        subject, body: `[oa:${oaForOwner.slug}] ${text}`,
        status: 'sent',
      });
      return { channel: 'line', ok: true, oa: oaForOwner.slug };
    } catch (err) {
      const status = Number(err && err.status);
      const structural = (err && err.fatal === true)
        || (Number.isFinite(status) && status >= 400 && status < 500 && status !== 429);
      lineTransientFail = !structural;
      await logResult(pool, {
        channel: 'line',
        recipient: lineOwner,
        subject, body: `[oa:${oaForOwner.slug}] ${text}`,
        status: 'failed',
        error: `${structural ? 'structural' : 'transient'}: ${(err && err.message) || 'push failed'}`
          + (Number.isFinite(status) ? ` (HTTP ${status})` : ''),
      });
    }
  }

  // 2. Email (fallback)
  if (chGate.email && email.isConfigured(features) && ownerEmailTo) {
    emailInlineTried = true;
    const to = ownerEmailTo;
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

  // 3. Queue fallback. We re-queue LINE when it was either NOT attempted
  // inline, OR attempted and failed *transiently* (network/timeout/429/5xx) —
  // those are exactly what the queue's retry/backoff exists to ride out, so a
  // brief LINE outage never silently drops a high-priority owner alert. We do
  // NOT re-queue a *structural* failure (bad token, OA disabled, 4xx): it
  // won't fix itself and re-queuing would just burn retries and spam the log.
  //
  // Owner alerts are the highest-priority class (anomaly detector, contract
  // expiry, slip queue summary), so silent loss on a transient blip is bad —
  // but duplicate-spam through a broken channel is worse for signal/noise.
  const queue = getQueue();
  if (queue) {
    if (chGate.line && oaForOwner && oaForOwner.channelAccessToken && lineOwner && (!lineInlineTried || lineTransientFail)) {
      try {
        await queue.enqueue(pool, {
          channel: 'line', recipient: lineOwner, subject, body: text,
          payload: { oaId: oaForOwner.id, source: 'notifier-owner-fallback' },
        });
        await logResult(pool, {
          channel: 'queue', recipient: lineOwner, subject, body: text,
          status: 'queued',
          error: lineTransientFail
            ? 'owner LINE failed transiently — re-queued for retry'
            : 'owner LINE not attempted inline — enqueued',
        });
        return { channel: 'queue', ok: false, queued: true };
      } catch { /* fall through */ }
    }
    if (chGate.email && email.isConfigured(features) && ownerEmailTo && !emailInlineTried) {
      const to = ownerEmailTo;
      try {
        await queue.enqueue(pool, {
          channel: 'email', recipient: to, subject, body: text,
          payload: { source: 'notifier-owner-fallback' },
        });
        await logResult(pool, {
          channel: 'queue', recipient: to, subject, body: text,
          status: 'queued', error: 'owner email not attempted inline — enqueued',
        });
        return { channel: 'queue', ok: false, queued: true };
      } catch { /* fall through */ }
    }
  }

  // 4. None worked → log skip
  const allOwnerGatedOff = !chGate.line && !chGate.email;
  await logResult(pool, {
    channel: 'none', recipient: '', subject, body: text,
    status: 'failed',
    error: allOwnerGatedOff
      ? 'ช่องทางแจ้งเตือนเจ้าของถูกปิดในตั้งค่า (Settings → ช่องทางการแจ้งเตือน)'
      : 'no channel configured',
  });
  return { channel: 'none', ok: false, channelsDisabled: allOwnerGatedOff };
}

/**
 * Notify a specific tenant. Sends LINE to every active binding for this
 * tenant/room, then falls back to email/SMS only if no LINE delivery works.
 */
async function notifyTenant(ctx, tenant, msg) {
  const { pool, features } = ctx;
  if (!tenant) return { channel: 'none', ok: false };
  const chGate = await loadNotifyChannelGate(ctx);
  const subject = msg.subject || 'แจ้งเตือน';
  const rawText = msg.text || subject;
  const lineMessages = Array.isArray(msg.messages) && msg.messages.length > 0
    ? msg.messages
    : (Array.isArray(msg.lineMessages) && msg.lineMessages.length > 0 ? msg.lineMessages : null);
  // Accept both DB shape (snake_case from `tenants` table) and the legacy
  // rooms.tenant blob shape (camelCase). Earlier versions only matched
  // snake_case, so callers reading from rooms.tenant got nothing dispatched.
  const rawLineId = tenant.line_user_id || tenant.lineUserId || null;
  const lineId = lineNotify.isLikelyUserId(rawLineId) ? String(rawLineId).trim() : null;
  const phone = tenant.phone || null;
  const mail = tenant.email || null;
  const lineRecipients = await getTenantLineRecipients(pool, tenant);
  const lineRecipientCount = lineRecipients.length;
  const text = appendLineRecipientCount(rawText, lineRecipientCount);
  if (rawLineId && !lineId) {
    await logResult(pool, {
      channel: 'line', recipient: String(rawLineId).slice(0, 200),
      subject, body: text, status: 'skipped',
      error: 'invalid LINE userId shape',
    });
  }

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
    return { channel: 'none', ok: false, skipped: true, reason: 'inactive', lineRecipientCount };
  }

  if (chGate.line && lineRecipients.length) {
    let sent = 0;
    let failed = 0;
    let firstOa = null;
    for (const recipient of lineRecipients) {
      const result = await pushLineToTenant(pool, {
        ...tenant,
        line_user_id: recipient.line_user_id,
        line_oa_id: recipient.line_oa_id,
      }, text, lineMessages);
      if (result.ok) {
        sent++;
        if (!firstOa) firstOa = result.oaSlug || result.oaId || null;
      } else {
        failed++;
      }
      await logResult(pool, {
        channel: 'line', recipient: recipient.line_user_id,
        subject,
        body: result.oaSlug ? `[oa:${result.oaSlug}] ${text}` : text,
        status: result.ok ? 'sent' : 'failed',
        error: result.ok ? null : (result.reason || result.error || 'failed'),
      });
    }
    if (sent > 0) {
      return {
        channel: 'line',
        ok: true,
        oa: firstOa,
        recipients: sent,
        failedRecipients: failed,
        lineRecipientCount,
      };
    }
  }

  if (chGate.email && mail && email.isConfigured(features)) {
    const ok = await email.send(features, {
      to: mail, subject, text, html: msg.html,
    });
    await logResult(pool, {
      channel: 'email', recipient: mail,
      subject, body: text, status: ok ? 'sent' : 'failed',
    });
    if (ok) return { channel: 'email', ok: true, lineRecipientCount };
  }

  // SMS — final fallback. Skipped (with a clear log row) when no SMS
  // provider is configured, so a half-implemented stub doesn't make every
  // notification look failed. C1.
  if (chGate.sms && phone && sms.isConfigured(features)) {
    try {
      const ok = await sms.send(features, { to: phone, text });
      await logResult(pool, {
        channel: 'sms', recipient: phone,
        subject, body: text, status: ok ? 'sent' : 'failed',
      });
      if (ok) return { channel: 'sms', ok: true, lineRecipientCount };
    } catch (err) {
      await logResult(pool, {
        channel: 'sms', recipient: phone, subject, body: text,
        status: 'failed', error: err.message,
      });
    }
  }

  // Last-resort: enqueue for later retry instead of dropping the message
  // on the floor. This catches the common "LINE token went 401 for 30
  // minutes" failure mode where the immediate push fails but the channel
  // recovers within the queue retry window. Without this fallback every
  // checkin/maintenance/access-card notify fired during the outage was
  // permanently lost.
  //
  // Queue is best-effort — if the table doesn't exist (legacy deploy) or
  // the enqueue itself fails, we still log + return false so the caller
  // sees the same shape as before.
  const queue = getQueue();
  if (queue) {
    let enqueued = false;
    let queuedRecipient = '';
    if (chGate.line && lineRecipients.length) {
      for (const recipient of lineRecipients) {
        try {
          await queue.enqueue(pool, {
            channel: 'line', recipient: recipient.line_user_id, subject, body: text,
            payload: {
              oaId: recipient.line_oa_id || null,
              source: 'notifier-fallback',
              ...(lineMessages ? { messages: lineMessages } : {}),
            },
          });
          enqueued = true;
          queuedRecipient = queuedRecipient || recipient.line_user_id;
        } catch { /* ignore — try next channel */ }
      }
    }
    if (!enqueued && chGate.email && mail && email.isConfigured(features)) {
      try {
        await queue.enqueue(pool, {
          channel: 'email', recipient: mail, subject, body: text,
          payload: { source: 'notifier-fallback' },
        });
        enqueued = true;
      } catch { /* ignore */ }
    }
    if (!enqueued && chGate.sms && phone && sms.isConfigured(features)) {
      try {
        await queue.enqueue(pool, {
          channel: 'sms', recipient: phone, subject, body: text,
          payload: { source: 'notifier-fallback' },
        });
        enqueued = true;
      } catch { /* ignore */ }
    }
    if (enqueued) {
      await logResult(pool, {
        channel: 'queue', recipient: queuedRecipient || mail || phone || '',
        subject, body: text, status: 'queued',
        error: 'all immediate channels failed — enqueued for retry',
      });
      return { channel: 'queue', ok: false, queued: true, recipients: lineRecipientCount || undefined, lineRecipientCount };
    }
  }

  const allGatedOff = !chGate.line && !chGate.email && !chGate.sms;
  await logResult(pool, {
    channel: 'none', recipient: phone || '', subject, body: text,
    status: 'failed',
    error: allGatedOff
      ? 'ทุกช่องทางแจ้งเตือนถูกปิดในตั้งค่า (Settings → ช่องทางการแจ้งเตือน) — เปิดอย่างน้อย 1 ช่องทาง'
      : 'tenant has no reachable channel',
  });
  return { channel: 'none', ok: false, lineRecipientCount, channelsDisabled: allGatedOff };
}

module.exports = { notifyOwner, notifyTenant, getTenantLineRecipients, loadNotifyChannelGate };
