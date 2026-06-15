// services/notificationQueue.js
// Persistent retry queue for outbound notifications. Inserts go into
// notifications_queue with status='pending'; a periodic worker picks rows
// whose next_attempt_at <= NOW(), tries to dispatch, and either marks
// status='sent' (success) or schedules the next retry with exponential
// backoff. After 3 failed attempts the row is parked at status='failed'.

const lineNotify = require('./line');
const lineOa = require('./lineOa');
const email = require('./email');
const sms = require('./sms');
const crypto = require('crypto');
const billLineMessages = require('./billLineMessages');

const MAX_RETRY = 3;
const BACKOFF_MIN = [60_000, 5 * 60_000, 30 * 60_000]; // 1m, 5m, 30m
// Per-dispatch ceiling. LINE pushes already time out at ~5s internally, but
// email (nodemailer) and SMS have no enforced limit — a hung SMTP connect on
// one row stalls the whole sequential batch until the 10-minute reaper flips
// it back to 'pending', and a sibling re-dispatches it (duplicate email/SMS,
// which have no retry-key dedup). Bounding each dispatch to 30s (well under
// the reap window) keeps one slow row from stalling the batch; a timeout is
// non-fatal so the row just falls into normal backoff.
const DISPATCH_TIMEOUT_MS = 30_000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label} timed out after ${ms}ms`);
      e.timeout = true;
      reject(e);
    }, ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function diagnoseFailure(row) {
  const channel = String(row?.channel || '').toLowerCase();
  const err = String(row?.last_error || '').trim();
  const lower = err.toLowerCase();
  if (!err) return null;
  if (channel === 'email' && /email not configured|smtp .*not configured|smtp host\/user\/pass/.test(lower)) {
    return {
      code: 'EMAIL_NOT_CONFIGURED',
      title: 'ยังไม่ได้ตั้งค่าอีเมล',
      hint: 'ตั้งค่า SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM และ OWNER_EMAIL ที่ Settings > API/Keys แล้วค่อย Retry รายการนี้',
      retryAfterFix: true,
    };
  }
  if (channel === 'line' && /line not configured|oa resolve failed|token rejected|401|403/.test(lower)) {
    return {
      code: 'LINE_NOT_CONFIGURED',
      title: 'LINE OA ต้องตรวจสอบ',
      hint: 'ตรวจ default LINE OA, channel access token, channel secret และการผูก LINE ของผู้เช่าก่อน Retry',
      retryAfterFix: true,
    };
  }
  if (channel === 'line' && /invalid line recipient|recipient missing|invalid .*user\s?id|userid shape/.test(lower)) {
    return {
      code: 'LINE_RECIPIENT_INVALID',
      title: 'ผู้รับ LINE ไม่ถูกต้อง / ยังไม่ผูก',
      hint: 'ผู้เช่ายังไม่ได้ผูก LINE (line_user_id ว่างหรือไม่ใช่ userId ที่ถูกต้อง) — ให้ผู้เช่าผูก LINE ใหม่ผ่านพอร์ทัล/สแกน QR แล้วค่อย Retry (การตั้งค่า OA ไม่ช่วยกรณีนี้)',
      retryAfterFix: true,
    };
  }
  if (channel === 'sms' && /sms provider not configured|not implemented|provider .*not configured/.test(lower)) {
    return {
      code: 'SMS_NOT_CONFIGURED',
      title: 'ยังไม่ได้ตั้งค่า SMS',
      hint: 'ติดตั้ง/ตั้งค่า SMS provider ที่รองรับและ credentials ให้ครบก่อน Retry รายการ SMS',
      retryAfterFix: true,
    };
  }
  if (/rate limit|429/.test(lower)) {
    return {
      code: 'PROVIDER_RATE_LIMIT',
      title: 'ผู้ให้บริการจำกัดจำนวนส่ง',
      hint: 'รอให้ provider reset รอบ limit แล้วค่อย Retry หรือปล่อยให้คิว retry ตามรอบ',
      retryAfterFix: false,
    };
  }
  return {
    code: 'DELIVERY_FAILED',
    title: 'ส่งแจ้งเตือนไม่สำเร็จ',
    hint: 'ตรวจการตั้งค่าช่องทางแจ้งเตือนและบันทึกระบบของช่วงเวลาที่ส่ง แก้สาเหตุหลักแล้วค่อยกดส่งซ้ำ',
    retryAfterFix: true,
  };
}

function retryKeyForRowId(rowId) {
  const hex = crypto
    .createHash('sha256')
    .update(`notifications_queue:${rowId}`)
    .digest('hex');
  const variant = (8 + (parseInt(hex.slice(16, 17), 16) % 4)).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

const PAYABLE_BILL_STATUSES = new Set(['pending', 'overdue']);

function normalizePayload(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function fatalBillQueueError(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  err.fatal = true;
  return err;
}

// Structural dispatch errors that CANNOT improve by retrying within the backoff
// window (channel not configured, malformed recipient, unknown channel). Mark
// them fatal so the row parks at 'failed' on the FIRST attempt with a clear
// reason instead of burning all 3 retries on a condition only an admin can fix
// (e.g. configure SMTP / add a LINE OA). diagnoseFailure() turns these into
// actionable hints, and the row can be retried from the admin queue after the
// fix. Transient causes ("send returned false", OA resolve/DB hiccup, 5xx/429)
// are intentionally NOT marked fatal so they still get the retry/backoff.
function fatalDispatchError(message) {
  const err = new Error(message);
  err.fatal = true;
  return err;
}

function formatPaidAt(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toLocaleString('th-TH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function paidBillNoticeText(row, state) {
  return [
    '✅ บิลนี้ชำระแล้ว',
    row.subject ? String(row.subject) : null,
    state?.paid_at ? `เวลาชำระ: ${formatPaidAt(state.paid_at) || state.paid_at}` : null,
    'ไม่ต้องสแกน QR โอนเงิน หรือส่งสลิปเพิ่ม',
  ].filter(Boolean).join('\n');
}

function paidBillStatusBox(state) {
  const paidAt = formatPaidAt(state?.paid_at);
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: '#e8f5ec',
    cornerRadius: 'md',
    paddingAll: 'lg',
    margin: 'md',
    spacing: 'xs',
    contents: [
      { type: 'text', text: 'ชำระแล้ว', weight: 'bold', size: 'xl', align: 'center', color: '#1f7a3f' },
      {
        type: 'text',
        text: paidAt ? `ตรวจพบการชำระเมื่อ ${paidAt}` : 'ตรวจพบว่าบิลนี้ชำระแล้ว',
        size: 'sm',
        align: 'center',
        color: '#5f5448',
        wrap: true,
      },
      { type: 'text', text: 'ไม่ต้องสแกน QR หรือส่งสลิปเพิ่ม', size: 'sm', align: 'center', color: '#5f5448', wrap: true },
    ],
  };
}

function sanitizePaidBillLineMessages(messages, row, state) {
  const paidText = { type: 'text', text: paidBillNoticeText(row, state) };
  const source = Array.isArray(messages) ? messages : [];
  const flex = source.find((msg) => msg && msg.type === 'flex' && msg.contents);
  if (!flex) return [paidText];
  let clone;
  try {
    clone = JSON.parse(JSON.stringify(flex));
  } catch {
    return [paidText];
  }
  const body = clone?.contents?.body;
  if (!body || !Array.isArray(body.contents)) return [paidText];
  const retained = body.contents.slice(0, 3);
  body.contents = [
    ...retained,
    { type: 'separator', margin: 'lg' },
    paidBillStatusBox(state),
  ];
  if (clone.contents?.footer?.contents?.[0]?.action) {
    clone.contents.footer.contents[0].action.label = 'ดูรายละเอียดบิล';
  }
  clone.altText = 'บิลนี้ชำระแล้ว';
  return [clone, paidText];
}

async function loadBillNotificationState(pool, billId) {
  const id = Number(billId);
  if (!Number.isInteger(id) || id < 1) {
    throw fatalBillQueueError('INVALID_BILL_ID', 'notification payload has an invalid billId');
  }
  const { rows } = await pool.query(
    `SELECT id, status, paid_at, deleted_at
       FROM bills
      WHERE id=$1
      LIMIT 1`,
    [id]
  );
  if (!rows.length || rows[0].deleted_at) {
    throw fatalBillQueueError('BILL_NOT_FOUND', `bill ${id} no longer exists`);
  }
  return rows[0];
}

async function guardBillNotificationPayload(pool, row, payload) {
  const rawBillId = payload?.billId;
  if (rawBillId == null || rawBillId === '') {
    return { payload, subject: row.subject, body: row.body };
  }
  const billId = Number(rawBillId);
  if (!Number.isInteger(billId) || billId < 1) {
    throw fatalBillQueueError('INVALID_BILL_ID', 'notification payload has an invalid billId');
  }
  const state = await loadBillNotificationState(pool, billId);
  const status = String(state.status || '').toLowerCase();
  if (status === 'paid') {
    const body = paidBillNoticeText(row, state);
    return {
      payload: {
        ...payload,
        billStatus: 'paid',
        messages: sanitizePaidBillLineMessages(payload.messages, row, state),
      },
      subject: row.subject || 'บิลนี้ชำระแล้ว',
      body,
    };
  }
  if (!PAYABLE_BILL_STATUSES.has(status)) {
    throw fatalBillQueueError('BILL_NOT_PAYABLE', `bill ${billId} is ${status || 'unknown'}, notification blocked`);
  }
  return { payload, subject: row.subject, body: row.body };
}

async function logResult(pool, row, result, error) {
  try {
    await pool.query(
      `INSERT INTO notifications_log (channel, recipient, subject, body, status, error)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [row.channel, row.recipient || '', row.subject || null,
       (row.body || '').slice(0, 4000), result, error || null]
    );
  } catch (err) {
    console.error('[notif-queue] log insert failed:', err.message);
  }
}

/**
 * Enqueue a notification for delivery. Returns the inserted row id.
 *
 * @param {object} pool
 * @param {object} msg - { channel, recipient, subject, body, payload }
 *                       channel: 'line' | 'email' | 'sms'
 *                       payload: any extra dispatch context (e.g. flex bubble)
 */
async function enqueue(pool, msg) {
  const { rows } = await pool.query(
    `INSERT INTO notifications_queue (channel, recipient, subject, body, payload)
     VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
    [
      String(msg.channel || 'line').slice(0, 16),
      String(msg.recipient || '').slice(0, 200),
      msg.subject ? String(msg.subject).slice(0, 200) : null,
      msg.body ? String(msg.body).slice(0, 4000) : null,
      JSON.stringify(msg.payload || {}),
    ]
  );
  return rows[0].id;
}

// Master per-channel gate from config.notify.channels (Settings → ช่องทาง
// การแจ้งเตือน). Mirrors notifier.loadNotifyChannelGate but kept self-contained
// here to avoid a notifier↔queue require cycle. An explicit `false` hard-disables
// the channel; absent/unset → allowed. Loaded once per tick and threaded into
// dispatch so directly-enqueued rows (bill-gen / reminders / manual "ส่ง" — which
// bypass notifier's own gate) still honor the toggle.
async function loadChannelGate(pool) {
  try {
    const { rows } = await pool.query(
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

/**
 * Try to dispatch one row. Caller passes the loaded features map (so we
 * don't query the DB twice per row) and the per-channel gate.
 */
async function dispatch(pool, features, row, gate) {
  const channel = row.channel;
  // Honor the master per-channel gate. When a channel is switched OFF in
  // Settings, suppress delivery even for rows enqueued directly (those skip
  // notifier's gate). Park as fatal (no retry) with a clear reason — same
  // treatment as a disabled OA; admin can re-enable + retry from the queue UI.
  if (gate && gate[channel] === false) {
    throw fatalDispatchError(`channel '${channel}' disabled in settings (ช่องทางการแจ้งเตือนถูกปิดในตั้งค่า)`);
  }
  if (channel === 'line') {
    if (!row.recipient) throw fatalDispatchError('LINE recipient missing');
    if (!lineNotify.isLikelyUserId(row.recipient)) throw fatalDispatchError('invalid LINE recipient');
    // Multi-OA aware: payload.oaId picks which OA to push through.
    // Falls back to the default OA when payload doesn't carry one (e.g.
    // owner-channel notifications) or when no DB OA is registered yet
    // (legacy env-OA deploys).
    let payload = normalizePayload(row.payload);
    const guarded = await guardBillNotificationPayload(pool, row, payload);
    payload = guarded.payload;
    const oaIdHint = payload.oaId != null ? Number(payload.oaId) : null;
    let oa = null;
    try {
      oa = oaIdHint
        ? await lineOa.resolveForTenant(pool, oaIdHint, { withSecrets: true })
        : await lineOa.getDefault(pool, { withSecrets: true });
    } catch (err) {
      throw new Error(`LINE OA resolve failed: ${err.message}`);
    }
    if (!oa || !oa.channelAccessToken) throw fatalDispatchError('LINE not configured');
    // Refuse dispatch through a disabled OA. Admin may have disabled the
    // OA mid-flight (e.g. migrating tenants off it, suspected compromise),
    // but enqueued rows from before still point at it. Pushing anyway
    // would defeat the disable. Mark as fatal so the row parks at 'failed'
    // immediately instead of burning retry attempts — admin needs to
    // re-route the tenant's binding before the message can go through.
    if (oa.enabled === false) {
      const fatalErr = new Error(`LINE OA disabled (id=${oa.id || 'env'})`);
      fatalErr.fatal = true;
      throw fatalErr;
    }
    // Idempotency: send a stable retry key derived from the queue row id
    // so LINE dedupes duplicate retries. Without this, a successful push
    // whose response was truncated mid-read would be retried and the
    // tenant would receive the same message twice (or more). LINE caches
    // results per retry key for ~10 minutes.
    const retryKey = retryKeyForRowId(row.id);
    // Rich-message path: payload.messages is the raw LINE messages array
    // (Flex bubble + text fallback for bill reminders). Bundled as ONE
    // push toward the rate limit so we don't double-count for the same
    // notification. When older/automatic bill jobs only carry payload.billId,
    // rebuild the rich QR payload at dispatch time, then fall back to plain
    // pushText only if the public QR/link cannot be composed.
    //
    // Use the *Strict variants so HTTP status flows back as err.status
    // (instead of being flattened to "returned false"). processOne uses
    // the status to fast-fail 401 and apply a longer backoff on 429.
    let messages = Array.isArray(payload.messages) && payload.messages.length > 0
      ? payload.messages
      : null;
    if (!messages && payload.billId != null) {
      try {
        messages = await billLineMessages.buildQueuedBillLineMessages(pool, row, payload);
      } catch (err) {
        console.warn('[notif-queue] bill LINE rich payload rebuild failed:', err.message);
      }
    }
    if (Array.isArray(messages) && messages.length > 0) {
      await lineNotify.pushMessagesStrict(oa, row.recipient, messages, { retryKey });
      return;
    }
    await lineNotify.pushTextStrict(oa, row.recipient, guarded.body || guarded.subject || '', { retryKey });
    return;
  }
  if (channel === 'email') {
    if (!email.isConfigured(features)) throw fatalDispatchError('email not configured');
    const payload = normalizePayload(row.payload);
    const guarded = await guardBillNotificationPayload(pool, row, payload);
    const ok = await email.send(features, {
      to: row.recipient,
      subject: guarded.subject || '(no subject)',
      text: guarded.body || '',
      // Stable per-row Message-ID so a reaper-induced re-dispatch (the row flips
      // back to 'pending' while a slow SMTP send is still in flight) carries the
      // SAME id — receiving servers dedupe on Message-ID and duplicates stay
      // identifiable. This is email's equivalent of LINE's X-Line-Retry-Key.
      // (The SMS providers here expose no idempotency hook, so SMS remains
      // at-least-once by provider limitation — documented in processOne.)
      messageId: `<baankarn-notif-${row.id}@baankarn.local>`,
    });
    if (!ok) throw new Error('email send returned false');
    return;
  }
  if (channel === 'sms') {
    if (!sms.isConfigured(features)) throw fatalDispatchError('SMS provider not configured');
    const payload = normalizePayload(row.payload);
    const guarded = await guardBillNotificationPayload(pool, row, payload);
    const ok = await sms.send(features, { to: row.recipient, text: guarded.body || guarded.subject || '' });
    if (!ok) throw new Error('SMS send returned false');
    return;
  }
  throw fatalDispatchError(`unknown channel: ${channel}`);
}

async function processOne(pool, features, row, gate) {
  try {
    await withTimeout(
      dispatch(pool, features, row, gate),
      DISPATCH_TIMEOUT_MS,
      `dispatch ${row.channel} #${row.id}`
    );
    // Only mark sent if WE still own this claim — the reaper may have flipped
    // the row back to 'pending' if our dispatch hung past 10 minutes, and a
    // sibling worker may have picked it up. Without the status guard we'd
    // overwrite a sibling's progress (their retry_count, their last_error)
    // and lock the row at 'sent' even though our dispatch never returned
    // before being reaped. The dispatch ALSO sent twice in that case, but
    // LINE's X-Line-Retry-Key catches the duplicate within 10 min; email/SMS
    // get no such dedup so this guard is the only line of defense.
    const upd = await pool.query(
      `UPDATE notifications_queue
         SET status='sent', sent_at=NOW(), last_error=NULL
         WHERE id=$1 AND status='processing'`,
      [row.id]
    );
    if (upd.rowCount === 0) {
      console.warn(`[notif-queue] row ${row.id} no longer 'processing' on success — likely reaped mid-dispatch`);
      return;
    }
    await logResult(pool, row, 'sent', null);
  } catch (err) {
    // nextRetry is computed from the snapshot at CLAIM TIME, but the
    // DB-side UPDATE below uses `retry_count + 1` so a concurrent reaper
    // that bumped retry_count between claim and now isn't silently
    // overwritten. We still use `nextRetry` for the BACKOFF index choice
    // and for the MAX_RETRY threshold — close enough for backoff math.
    const nextRetry = row.retry_count + 1;
    const errMsg = String(err.message || err).slice(0, 1000);
    // Fatal errors (401 invalid token, configured-as-invalid OA, malformed
    // recipient) won't get better with retries — they need admin to fix
    // the OA config or the tenant binding. Park immediately at 'failed'
    // so the row surfaces in the admin queue and stops burning attempts.
    const status = Number(err.status) || null;
    const isFatal = err.fatal === true || status === 401 || status === 403 || status === 400;
    if (isFatal) {
      await pool.query(
        `UPDATE notifications_queue
           SET status='failed',
               retry_count = retry_count + 1,
               last_error=$2
           WHERE id=$1`,
        [row.id, errMsg]
      );
      await logResult(pool, row, 'failed', errMsg);
      return;
    }
    if (nextRetry >= MAX_RETRY) {
      await pool.query(
        `UPDATE notifications_queue
           SET status='failed',
               retry_count = retry_count + 1,
               last_error=$2
           WHERE id=$1`,
        [row.id, errMsg]
      );
      await logResult(pool, row, 'failed', errMsg);
    } else {
      // Index by `nextRetry - 1` so the FIRST retry uses BACKOFF_MIN[0]
      // (1m). Previously this read BACKOFF_MIN[1] (5m) on the first retry,
      // skipping the 1-minute step entirely → effective backoffs were
      // 5m, 30m instead of the intended 1m, 5m, 30m.
      let wait = BACKOFF_MIN[Math.min(nextRetry - 1, BACKOFF_MIN.length - 1)];
      // Rate limit / service-unavailable: honor Retry-After header from
      // the provider so we don't hammer past the window. We pick the
      // LARGER of (default backoff, Retry-After) so a tiny Retry-After
      // value can't shrink our intended backoff.
      if ((status === 429 || status === 503) && err.retryAfterSeconds > 0) {
        const raMs = err.retryAfterSeconds * 1000;
        if (raMs > wait) wait = raMs;
      } else if (status === 429) {
        // 429 without Retry-After — be conservative.
        wait = Math.max(wait, 5 * 60 * 1000);
      }
      // Multiply integer parameter by a fixed-unit interval — avoids the
      // implicit text-cast that the `int || 'milliseconds'` form depends
      // on (works in PG 9.5+ but reads ambiguous; this version is plain
      // SQL standard arithmetic).
      //
      // Atomic increment (`retry_count + 1`) preserves any reaper bump
      // that happened concurrently between this worker's claim and now.
      // Previously this wrote `retry_count=$2` (the captured snapshot+1),
      // which could overwrite a reaper increment and let a poison
      // message slip past MAX_RETRY.
      await pool.query(
        `UPDATE notifications_queue
           SET status='pending',
               retry_count = retry_count + 1,
               last_error=$2,
               next_attempt_at=NOW() + ($3::int * INTERVAL '1 millisecond')
           WHERE id=$1`,
        [row.id, errMsg, wait]
      );
    }
  }
}

/**
 * Drain up to `batchSize` due rows. Returns count processed.
 *
 * Multi-instance safe: claims rows inside a transaction with `FOR UPDATE
 * SKIP LOCKED`, then immediately marks them `status='processing'` so a
 * second worker (different pod / different node) can't pick the same id.
 * Without this, every replica would emit duplicate LINE pushes / SMS texts
 * for every message in a 60s window.
 *
 * If the worker process dies between claim and dispatch, the row stays
 * stuck at `processing` forever — the cleanup query at the top of each
 * tick reaps any `processing` row whose claim is older than 10 minutes
 * (much longer than the 5s LINE timeout × 25 batch worst case).
 */
async function tick(pool, features, batchSize = 25) {
  const client = await pool.connect();
  let rows;
  try {
    // Reaper: messages stuck `processing` for >10 min are presumed orphaned
    // (worker died). The CTE+SKIP LOCKED pattern prevents two replicas
    // from both bumping retry_count on the same row when their tick
    // happens to overlap on the reaper sweep — previous version was a
    // bare UPDATE which Postgres still serialized but applied BOTH
    // bumps, double-aging a stuck row.
    //
    // We also set next_attempt_at to NOW() + 1m so a reaped row doesn't
    // immediately re-fire (which would burst-retry through the same
    // broken dispatch). Without this delay reaped rows landed in the
    // very next tick with no backoff applied, defeating the retry
    // schedule for crash-during-dispatch cases.
    // The reaper tips the row to 'failed' when its bump would cross
    // MAX_RETRY. Without this guard, a row whose worker keeps crashing
    // mid-dispatch would reap forever — reap bumps retry_count and
    // resets status='pending', next claim crashes again, reap, …
    // Status is computed in SQL so the bumped retry_count and the
    // status assignment stay consistent without a second round-trip.
    await client.query(
      `WITH stuck AS (
         SELECT id, retry_count FROM notifications_queue
          WHERE status='processing' AND sent_at IS NULL
            AND next_attempt_at < NOW() - INTERVAL '10 minutes'
          FOR UPDATE SKIP LOCKED
       )
       UPDATE notifications_queue q
          SET status = CASE
                WHEN stuck.retry_count + 1 >= $1 THEN 'failed'
                ELSE 'pending'
              END,
              retry_count = stuck.retry_count + 1,
              next_attempt_at = NOW() + INTERVAL '1 minute',
              last_error = COALESCE(q.last_error, '') || ' [reaped after stuck processing]'
         FROM stuck
        WHERE q.id = stuck.id`,
      [MAX_RETRY]
    );

    await client.query('BEGIN');
    const claim = await client.query(
      `SELECT id, channel, recipient, subject, body, payload, retry_count
         FROM notifications_queue
         WHERE status='pending' AND next_attempt_at <= NOW()
         ORDER BY next_attempt_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
      [batchSize]
    );
    rows = claim.rows;
    if (rows.length) {
      await client.query(
        `UPDATE notifications_queue
           SET status='processing', next_attempt_at=NOW()
         WHERE id = ANY($1::bigint[])`,
        [rows.map((r) => r.id)]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
  const gate = await loadChannelGate(pool);
  for (const row of rows) await processOne(pool, features, row, gate);
  return rows.length;
}

let _interval = null;
function start(pool, getFeatures) {
  if (_interval) return;
  const run = async () => {
    try {
      const features = await getFeatures();
      await tick(pool, features);
    } catch (err) {
      console.error('[notif-queue] tick error:', err.message);
    }
  };
  // Run shortly after boot, then every minute.
  setTimeout(run, 5_000).unref();
  _interval = setInterval(run, 60_000);
  _interval.unref();
}
function stop() { if (_interval) clearInterval(_interval); _interval = null; }

async function retryById(pool, id) {
  // Manual "retry now". Only RESET the backoff counter for terminal 'failed'
  // rows (the operator is giving an exhausted send a fresh start). For a row
  // that's still 'pending' (mid exponential backoff), just pull its next
  // attempt forward to NOW() and KEEP retry_count/last_error — otherwise a
  // permanently-broken recipient could be reset to attempt 0 on every click,
  // burning the full retry cycle again and again.
  await pool.query(
    `UPDATE notifications_queue
       SET status='pending',
           next_attempt_at=NOW(),
           retry_count = CASE WHEN status='failed' THEN 0 ELSE retry_count END,
           last_error  = CASE WHEN status='failed' THEN NULL ELSE last_error END
       WHERE id=$1`,
    [id]
  );
}

module.exports = {
  enqueue,
  tick,
  start,
  stop,
  retryById,
  diagnoseFailure,
  _retryKeyForRowId: retryKeyForRowId,
  _sanitizePaidBillLineMessages: sanitizePaidBillLineMessages,
  _guardBillNotificationPayload: guardBillNotificationPayload,
  _dispatch: dispatch,
  _loadChannelGate: loadChannelGate,
};
