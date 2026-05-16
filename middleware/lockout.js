// middleware/lockout.js
// Per-account login lockout backed by login_lockouts table (DB-persistent so
// it survives restarts). Tracks consecutive failures + temporary lockouts:
// after FAIL_THRESHOLD bad attempts within FAIL_WINDOW, lock the account
// for LOCKOUT_DURATION. Successful login resets the counter.
//
// Use:
//   const lockout = makeLockout(pool);
//   await lockout.check('admin:nick');         // throws if locked
//   await lockout.recordFailure('admin:nick');
//   await lockout.reset('admin:nick');         // on successful login

const FAIL_THRESHOLD = 5;
const FAIL_WINDOW_MS = 15 * 60_000;
const LOCKOUT_DURATION_MS = 30 * 60_000;

class LockedOutError extends Error {
  constructor(retryAfterMs) {
    super('account temporarily locked');
    this.code = 'LOCKED_OUT';
    this.retryAfterMs = retryAfterMs;
  }
}

// Canonical-form the principal so attackers can't fork the lockout counter
// by varying case/whitespace ("admin:Nick", "admin:nick ", "admin:NICK" all
// resolve to the same lockout row). Caller is expected to pass an already-
// shaped key like `admin:${username}` / `tenant:${phone}`, but we still
// normalize defensively here as a single source of truth.
function normalizePrincipal(p) {
  return String(p || '').trim().toLowerCase().slice(0, 256);
}

function makeLockout(pool) {
  /**
   * Throws LockedOutError if the principal is currently locked. Pass the
   * canonical key, e.g. `admin:${username}` or `tenant:${phone}`.
   */
  async function check(principal) {
    const { rows } = await pool.query(
      `SELECT locked_until FROM login_lockouts WHERE principal=$1`,
      [normalizePrincipal(principal)]
    );
    if (!rows.length || !rows[0].locked_until) return;
    const until = new Date(rows[0].locked_until).getTime();
    const now = Date.now();
    if (until > now) {
      throw new LockedOutError(until - now);
    }
  }

  async function recordFailure(principal, kind = 'admin') {
    const key = normalizePrincipal(principal);
    // Atomic upsert: if first_fail_at is older than FAIL_WINDOW we restart
    // the counter; otherwise increment. When we hit threshold, set
    // locked_until and reset the counter.
    await pool.query(
      `INSERT INTO login_lockouts (principal, kind, fail_count, first_fail_at, last_fail_at)
       VALUES ($1, $2, 1, NOW(), NOW())
       ON CONFLICT (principal) DO UPDATE SET
         kind = EXCLUDED.kind,
         fail_count = CASE
           WHEN login_lockouts.first_fail_at < NOW() - ($3::int || ' milliseconds')::interval
             THEN 1
           ELSE login_lockouts.fail_count + 1
         END,
         first_fail_at = CASE
           WHEN login_lockouts.first_fail_at < NOW() - ($3::int || ' milliseconds')::interval
             THEN NOW()
           ELSE login_lockouts.first_fail_at
         END,
         last_fail_at = NOW(),
         locked_until = CASE
           WHEN (CASE
                   WHEN login_lockouts.first_fail_at < NOW() - ($3::int || ' milliseconds')::interval
                     THEN 1
                   ELSE login_lockouts.fail_count + 1
                 END) >= $4
             THEN NOW() + ($5::int || ' milliseconds')::interval
           ELSE login_lockouts.locked_until
         END`,
      [key, kind, FAIL_WINDOW_MS, FAIL_THRESHOLD, LOCKOUT_DURATION_MS]
    );
  }

  async function reset(principal) {
    await pool.query(
      `DELETE FROM login_lockouts WHERE principal=$1`,
      [normalizePrincipal(principal)]
    );
  }

  return { check, recordFailure, reset };
}

module.exports = { makeLockout, LockedOutError, normalizePrincipal, FAIL_THRESHOLD, FAIL_WINDOW_MS, LOCKOUT_DURATION_MS };
