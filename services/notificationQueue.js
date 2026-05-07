// services/notificationQueue.js
// Persistent retry queue for outbound notifications. Inserts go into
// notifications_queue with status='pending'; a periodic worker picks rows
// whose next_attempt_at <= NOW(), tries to dispatch, and either marks
// status='sent' (success) or schedules the next retry with exponential
// backoff. After 3 failed attempts the row is parked at status='failed'.

const lineNotify = require('./line');
const email = require('./email');
const sms = require('./sms');

const MAX_RETRY = 3;
const BACKOFF_MIN = [60_000, 5 * 60_000, 30 * 60_000]; // 1m, 5m, 30m

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
    if (!lineNotify.isConfigured()) throw new Error('LINE not configured');
    if (!row.recipient) throw new Error('LINE recipient missing');
    const ok = await lineNotify.pushText(row.recipient, row.body || row.subject || '');
    if (!ok) throw new Error('LINE push returned false');
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
    const nextRetry = row.retry_count + 1;
    const errMsg = String(err.message || err).slice(0, 1000);
    if (nextRetry >= MAX_RETRY) {
      await pool.query(
        `UPDATE notifications_queue
           SET status='failed', retry_count=$2, last_error=$3
           WHERE id=$1`,
        [row.id, nextRetry, errMsg]
      );
      await logResult(pool, row, 'failed', errMsg);
    } else {
      const wait = BACKOFF_MIN[Math.min(nextRetry, BACKOFF_MIN.length - 1)];
      await pool.query(
        `UPDATE notifications_queue
           SET retry_count=$2, last_error=$3,
               next_attempt_at=NOW() + ($4::int || ' milliseconds')::interval
           WHERE id=$1`,
        [row.id, nextRetry, errMsg, wait]
      );
    }
  }
}

/**
 * Drain up to `batchSize` due rows. Returns count processed.
 */
async function tick(pool, features, batchSize = 25) {
  const { rows } = await pool.query(
    `SELECT id, channel, recipient, subject, body, payload, retry_count
       FROM notifications_queue
       WHERE status='pending' AND next_attempt_at <= NOW()
       ORDER BY next_attempt_at ASC LIMIT $1`,
    [batchSize]
  );
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

module.exports = { enqueue, tick, start, stop, retryById };
