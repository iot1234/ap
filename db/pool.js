// db/pool.js
// Postgres connection pool with:
//   - automatic SSL detection (Railway-internal vs external)
//   - per-query 10s timeout (prevents slow-query DoS)
//   - circuit breaker: after 5 failures within 60s, all queries return 503
//     until the next successful test query (probed every 30s)
//   - sanitised error logging so DB password never leaks via stack traces

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set');
  process.exit(1);
}

function sanitizeError(err) {
  const msg = String((err && err.message) || err);
  return msg.replace(/(\b[a-z]+:\/\/)[^@\s]+@/gi, '$1***@');
}

const useSSL = !/\.railway\.internal/i.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  max: 10,
  // Prevent stalled-DB requests from hanging indefinitely.
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30_000,
  // statement_timeout = abort any query > 10s. Keeps a buggy slow query from
  // tying up a connection slot.
  statement_timeout: 10_000,
  // Same idea for transactions waiting on a lock.
  lock_timeout: 5_000,
});

pool.on('error', (err) => console.error('[pg] pool error:', sanitizeError(err)));

// === Circuit breaker ======================================================
// Track recent failures. If we exceed `THRESHOLD` failures within
// `WINDOW_MS`, open the circuit — incoming queries return a 503-style error
// without hitting the DB. A periodic probe re-tests the connection; if it
// succeeds we close the circuit again.
const CB = {
  state: 'closed',          // closed | open | half-open
  failures: [],
  THRESHOLD: 5,
  WINDOW_MS: 60_000,
  PROBE_MS: 30_000,
  openedAt: 0,
};

function recordFailure() {
  const now = Date.now();
  CB.failures = CB.failures.filter((t) => now - t < CB.WINDOW_MS);
  CB.failures.push(now);
  if (CB.state === 'closed' && CB.failures.length >= CB.THRESHOLD) {
    CB.state = 'open';
    CB.openedAt = now;
    console.error(`[pg] circuit OPEN (${CB.failures.length} failures in window)`);
    scheduleProbe();
  }
}
function recordSuccess() {
  if (CB.state === 'half-open' || CB.state === 'open') {
    CB.state = 'closed';
    CB.failures = [];
    console.log('[pg] circuit CLOSED');
  } else if (CB.failures.length) {
    // Closed-state success drains the rolling window so an old transient
    // failure doesn't combine with a new one to trip the breaker on
    // otherwise-healthy traffic.
    const now = Date.now();
    CB.failures = CB.failures.filter((t) => now - t < CB.WINDOW_MS / 2);
  }
}
let _probeTimer = null;
function scheduleProbe() {
  if (_probeTimer) return;
  _probeTimer = setTimeout(async () => {
    _probeTimer = null;
    CB.state = 'half-open';
    try {
      await pool.query('SELECT 1');
      recordSuccess();
    } catch (err) {
      console.error('[pg] probe failed:', sanitizeError(err));
      CB.state = 'open';
      scheduleProbe();
    }
  }, CB.PROBE_MS).unref();
}

class CircuitOpenError extends Error {
  constructor() { super('database unavailable'); this.code = 'DB_CIRCUIT_OPEN'; }
}

/**
 * Wrap pool.query so the circuit breaker can intercept and so we count
 * failures. Use `safeQuery` for any code path where you want graceful
 * degradation; existing callers can keep using `pool.query` directly and
 * skip the breaker for read-only paths that are OK to fail loud.
 */
async function safeQuery(text, params) {
  if (CB.state === 'open') throw new CircuitOpenError();
  try {
    const r = await pool.query(text, params);
    // Successful query: drain the failure window. Without this, a slow drip
    // of failures keeps `failures.length` near THRESHOLD even when most
    // queries succeed — one bad query at the wrong moment then trips the
    // breaker on otherwise-healthy traffic. recordSuccess() handles the
    // closed-state cleanup too (no-op if there's nothing to clear).
    recordSuccess();
    return r;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

// Postgres SQLSTATE codes that are safe to retry. They indicate the request
// itself was fine but a concurrent transaction interfered — running again
// usually wins.
//   40001 = serialization_failure
//   40P01 = deadlock_detected
//   57P03 = cannot_connect_now
//   53300 = too_many_connections (transient under burst)
const RETRY_CODES = new Set(['40001', '40P01', '57P03', '53300']);

/**
 * Retry-aware query. Use for non-idempotent INSERTs/UPDATEs that could lose
 * a deadlock against a parallel admin action. Read paths don't need this —
 * they'll surface as 500 and the user retries from the UI.
 *
 * @param {string} text
 * @param {Array} params
 * @param {object} [opts] - { attempts: 3, baseDelayMs: 50 }
 */
async function queryWithRetry(text, params, opts = {}) {
  // Allow caller to pass their own pool (server.js owns the singleton in
  // this codebase; db/pool.js's `pool` is a fallback for callers that
  // don't have direct access).
  const p = opts.pool || pool;
  const attempts = Math.max(1, opts.attempts || 3);
  const baseDelayMs = opts.baseDelayMs || 50;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await p.query(text, params);
    } catch (err) {
      lastErr = err;
      if (!RETRY_CODES.has(err.code)) throw err;       // non-transient → bail
      if (i === attempts - 1) throw err;                // last attempt → bail
      // Exponential backoff with jitter so two clients fighting the same
      // deadlock don't retry in lockstep.
      const wait = baseDelayMs * Math.pow(2, i) + Math.floor(Math.random() * 50);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

function status() {
  return {
    state: CB.state,
    recentFailures: CB.failures.length,
    openedAt: CB.openedAt ? new Date(CB.openedAt).toISOString() : null,
  };
}

module.exports = { pool, safeQuery, queryWithRetry, sanitizeError, status, CircuitOpenError, RETRY_CODES };
