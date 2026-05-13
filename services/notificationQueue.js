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

const MAX_RETRY = 3;
const BACKOFF_MIN = [60_000, 5 * 60_000, 30 * 60_000]; // 1m, 5m, 30m

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

/**
 * Try to dispatch one row. Caller passes the loaded features map (so we
 * don't query the DB twice per row).
 */
async function dispatch(pool, features, row) {
  const channel = row.channel;
  if (channel === 'line') {
    if (!row.recipient) throw new Error('LINE recipient missing');
    if (!lineNotify.isLikelyUserId(row.recipient)) throw new Error('invalid LINE recipient');
    // Multi-OA aware: payload.oaId picks which OA to push through.
    // Falls back to the default OA when payload doesn't carry one (e.g.
    // owner-channel notifications) or when no DB OA is registered yet
    // (legacy env-OA deploys).
    const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
    const oaIdHint = payload.oaId != null ? Number(payload.oaId) : null;
    let oa = null;
    try {
      oa = oaIdHint
        ? await lineOa.resolveForTenant(pool, oaIdHint, { withSecrets: true })
        : await lineOa.getDefault(pool, { withSecrets: true });
    } catch (err) {
      throw new Error(`LINE OA resolve failed: ${err.message}`);
    }
    if (!oa || !oa.channelAccessToken) throw new Error('LINE not configured');
    // Idempotency: send a stable retry key derived from the queue row id
    // so LINE dedupes duplicate retries. Without this, a successful push
    // whose response was truncated mid-read would be retried and the
    // tenant would receive the same message twice (or more). LINE caches
    // results per retry key for ~10 minutes.
    const retryKey = retryKeyForRowId(row.id);
    // Rich-message path: payload.messages is the raw LINE messages array
    // (Flex bubble + text fallback for bill reminders). Bundled as ONE
    // push toward the rate limit so we don't double-count for the same
    // notification. Falls back to plain pushText when the enqueueing
    // caller didn't compose a rich payload.
    //
    // Use the *Strict variants so HTTP status flows back as err.status
    // (instead of being flattened to "returned false"). processOne uses
    // the status to fast-fail 401 and apply a longer backoff on 429.
    if (Array.isArray(payload.messages) && payload.messages.length > 0) {
      await lineNotify.pushMessagesStrict(oa, row.recipient, payload.messages, { retryKey });
      return;
    }
    await lineNotify.pushTextStrict(oa, row.recipient, row.body || row.subject || '', { retryKey });
    return;
  }
  if (channel === 'email') {
    if (!email.isConfigured(features)) throw new Error('email not configured');
    const ok = await email.send(features, {
      to: row.recipient,
      subject: row.subject || '(no subject)',
      text: row.body || '',
    });
    if (!ok) throw new Error('email send returned false');
    return;
  }
  if (channel === 'sms') {
    if (!sms.isConfigured(features)) throw new Error('SMS provider not configured');
    const ok = await sms.send(features, { to: row.recipient, text: row.body || row.subject || '' });
    if (!ok) throw new Error('SMS send returned false');
    return;
  }
  throw new Error(`unknown channel: ${channel}`);
}

async function processOne(pool, features, row) {
  try {
    await dispatch(pool, features, row);
    await pool.query(
      `UPDATE notifications_queue
         SET status='sent', sent_at=NOW(), last_error=NULL
         WHERE id=$1`,
      [row.id]
    );
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
  for (const row of rows) await processOne(pool, features, row);
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
  await pool.query(
    `UPDATE notifications_queue
       SET status='pending', next_attempt_at=NOW(), retry_count=0, last_error=NULL
       WHERE id=$1`,
    [id]
  );
}

module.exports = { enqueue, tick, start, stop, retryById, _retryKeyForRowId: retryKeyForRowId };
