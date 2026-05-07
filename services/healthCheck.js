// services/healthCheck.js
// Aggregate health probe for every subsystem the dorm app depends on.
// Returns an array of { id, label, status, severity, message, detail, lastCheckedAt }
// where status ∈ ok | warn | error and severity is the worst rung observed.
//
// Two consumers:
//   GET /api/admin/health  — admin dashboard (project/admin/page-health.jsx)
//   anomalyDetector.tick   — fires LINE/email alert to owner on transitions
//
// Design notes:
//   - Each check has a strict timeout so a single hung dependency can't
//     wedge the whole probe. Default 4s; LINE/SMTP/R2 get a real network
//     budget of 6s.
//   - Read-only. No writes; safe to call from scheduler + admin UI.
//   - Cheap. Total cost ≈ 1 DB roundtrip + 0..3 outbound HTTPS calls.

const fs = require('fs');
const path = require('path');
const features = require('./features');
const secrets = require('./secrets');

const SEVERITY_RANK = { ok: 0, warn: 1, error: 2 };

function withTimeout(promise, ms, label) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({
      timedOut: true, message: `timeout after ${ms}ms`, label,
    }), ms);
    timer.unref?.();
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); resolve({ thrown: true, message: String(e?.message || e) }); }
    );
  });
}

// --- Individual probes ----------------------------------------------------

async function checkDatabase(pool) {
  const start = Date.now();
  try {
    const r = await withTimeout(pool.query('SELECT 1 AS ok'), 4000, 'db');
    if (r?.timedOut) return { status: 'error', message: 'DB query timed out (4s)' };
    if (r?.thrown)   return { status: 'error', message: r.message };
    const ms = Date.now() - start;
    if (ms > 1500) return { status: 'warn', message: `DB ping slow (${ms}ms)`, detail: { ms } };
    return { status: 'ok', message: `DB ping OK (${ms}ms)`, detail: { ms } };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

async function checkSchemaSanity(pool) {
  // Verifies the critical tables + new columns are present. A missing
  // column from a partial migration is the kind of silent breakage that
  // shows up much later as a 500 on a specific endpoint.
  const required = [
    ['tenants',         'line_oa_id'],
    ['line_oas',        'is_default'],
    ['line_bindings',   'oa_id'],
    ['recurring_charges','start_at'],
    ['bills',           'deleted_at'],
  ];
  const missing = [];
  try {
    for (const [tbl, col] of required) {
      const r = await pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2 LIMIT 1`,
        [tbl, col]
      );
      if (!r.rows.length) missing.push(`${tbl}.${col}`);
    }
    if (missing.length) {
      return { status: 'error', message: `Schema missing: ${missing.join(', ')}`, detail: { missing } };
    }
    return { status: 'ok', message: 'Schema columns present' };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

async function checkLineOa(pool) {
  // Test the DEFAULT OA only — testing every OA on every tick would be
  // expensive + LINE rate-limits the bot/info endpoint.
  let oa;
  try {
    const lineOa = require('./lineOa');
    oa = await lineOa.getDefault(pool, { withSecrets: true });
  } catch (err) {
    return { status: 'error', message: `OA lookup failed: ${err.message}` };
  }
  if (!oa || !oa.channelAccessToken) {
    return { status: 'warn', message: 'No LINE OA configured (notifications disabled)' };
  }
  return new Promise((resolve) => {
    const https = require('https');
    const req = https.request({
      hostname: 'api.line.me', path: '/v2/bot/info', method: 'GET',
      headers: { Authorization: `Bearer ${oa.channelAccessToken.trim()}` },
      timeout: 6000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const j = JSON.parse(buf);
            resolve({ status: 'ok', message: `LINE OA "${j.displayName || oa.slug}" reachable`,
              detail: { displayName: j.displayName, basicId: j.basicId, oaId: oa.id } });
          } catch { resolve({ status: 'ok', message: 'LINE OA reachable' }); }
        } else if (res.statusCode === 401) {
          resolve({ status: 'error', message: 'LINE token rejected (401) — rotate the channel access token' });
        } else {
          resolve({ status: 'warn', message: `LINE API returned ${res.statusCode}`, detail: { status: res.statusCode, body: buf.slice(0, 200) } });
        }
      });
    });
    req.on('error', (e) => resolve({ status: 'error', message: `LINE unreachable: ${e.message}` }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 'error', message: 'LINE timeout (6s)' }); });
    req.end();
  });
}

async function checkSmtp(features) {
  if (!features?.email?.enabled) return { status: 'ok', message: 'Email channel disabled (skipped)' };
  const host = secrets.get('SMTP_HOST');
  const user = secrets.get('SMTP_USER');
  const pass = secrets.get('SMTP_PASS');
  if (!host || !user || !pass) {
    return { status: 'warn', message: 'Email enabled but SMTP host/user/pass not fully set' };
  }
  let nm;
  try { nm = require('nodemailer'); }
  catch { return { status: 'warn', message: 'nodemailer not installed' }; }
  try {
    const t = nm.createTransport({
      host, port: Number(secrets.get('SMTP_PORT') || 587),
      secure: Number(secrets.get('SMTP_PORT')) === 465,
      auth: { user, pass },
      connectionTimeout: 6000,
    });
    await withTimeout(t.verify(), 6000, 'smtp');
    return { status: 'ok', message: `SMTP ${host} OK` };
  } catch (err) {
    return { status: 'error', message: `SMTP verify failed: ${err.message}` };
  }
}

async function checkR2() {
  const id = secrets.get('R2_ACCESS_KEY_ID');
  const sec = secrets.get('R2_SECRET_ACCESS_KEY');
  const ep = secrets.get('R2_ENDPOINT');
  const bucket = secrets.get('R2_BUCKET');
  if (!id || !sec || !ep || !bucket) {
    return { status: 'ok', message: 'R2 not configured (uploads stay on local disk)' };
  }
  let lib;
  try { lib = require('@aws-sdk/client-s3'); }
  catch { return { status: 'warn', message: '@aws-sdk/client-s3 not installed' }; }
  try {
    const client = new lib.S3Client({
      region: secrets.get('R2_REGION') || 'auto',
      endpoint: ep, forcePathStyle: true,
      credentials: { accessKeyId: id, secretAccessKey: sec },
      requestHandler: { connectionTimeout: 4000, requestTimeout: 6000 },
    });
    await withTimeout(client.send(new lib.HeadBucketCommand({ Bucket: bucket })), 6000, 'r2');
    return { status: 'ok', message: `R2 bucket "${bucket}" reachable` };
  } catch (err) {
    return { status: 'error', message: `R2 unreachable: ${err.message}` };
  }
}

async function checkNotificationQueue(pool) {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='pending')                        AS pending,
        COUNT(*) FILTER (WHERE status='pending' AND next_attempt_at < NOW() - INTERVAL '15 minutes') AS stuck,
        COUNT(*) FILTER (WHERE status='failed' AND created_at > NOW() - INTERVAL '1 hour') AS recent_failed
      FROM notifications_queue`);
    const r = rows[0];
    const stuck = Number(r.stuck);
    const failed = Number(r.recent_failed);
    if (stuck > 5)  return { status: 'error', message: `${stuck} notifications stuck > 15min — queue worker may be wedged`, detail: r };
    if (failed > 20) return { status: 'warn', message: `${failed} notifications failed in the last hour`, detail: r };
    return { status: 'ok', message: `Queue healthy (${r.pending} pending)`, detail: r };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

async function checkRecentFailedLogins(pool) {
  try {
    const { rows } = await pool.query(`
      SELECT COUNT(*) AS n FROM audit_logs
      WHERE action IN ('auth.login_failed','tenant.login_failed','auth.login_locked')
        AND created_at > NOW() - INTERVAL '15 minutes'`);
    const n = Number(rows[0].n);
    if (n > 30) return { status: 'error', message: `${n} failed login attempts in 15min — possible brute-force in progress`, detail: { n } };
    if (n > 10) return { status: 'warn',  message: `${n} failed login attempts in 15min`, detail: { n } };
    return { status: 'ok', message: `${n} failed logins (15min window)`, detail: { n } };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

async function checkActiveLockouts(pool) {
  try {
    const { rows } = await pool.query(`
      SELECT COUNT(*) AS n FROM login_lockouts WHERE locked_until > NOW()`);
    const n = Number(rows[0].n);
    if (n > 5)  return { status: 'warn', message: `${n} accounts currently locked out`, detail: { n } };
    return { status: 'ok', message: `${n} active lockouts`, detail: { n } };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

async function checkSchedulerHeartbeat() {
  // The scheduler writes lastBackup / lastBillPeriod / lastSimHour to a
  // state file. Check that *something* has been written in the last 24h
  // (the file is touched on every successful tick that does work).
  try {
    const candidates = [
      process.env.SCHEDULER_STATE_FILE,
      process.env.UPLOAD_DIR && path.join(process.env.UPLOAD_DIR, 'scheduler-state.json'),
      path.join(__dirname, '..', '.scheduler-state.json'),
      path.join(require('os').tmpdir(), 'baankarn-scheduler-state.json'),
    ].filter(Boolean);
    for (const p of candidates) {
      try {
        const st = fs.statSync(p);
        const ageMin = (Date.now() - st.mtimeMs) / 60_000;
        if (ageMin < 90) return { status: 'ok', message: `Scheduler state fresh (${ageMin.toFixed(1)}min ago)`, detail: { path: p, ageMin } };
        if (ageMin < 1440) return { status: 'warn', message: `Scheduler state stale (${ageMin.toFixed(0)}min ago)`, detail: { path: p, ageMin } };
        return { status: 'error', message: `Scheduler state > 24h old`, detail: { path: p, ageMin } };
      } catch { /* try next */ }
    }
    return { status: 'warn', message: 'Scheduler state file not found yet (fresh deploy?)' };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

async function checkBootConfig() {
  // Soft validations that don't block boot but are worth nagging about.
  const issues = [];
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.CITIZEN_ID_KEY && !process.env.ENCRYPTION_KEY_V1) {
      issues.push('No CITIZEN_ID_KEY / ENCRYPTION_KEY_V1 — falling back to HKDF(SESSION_SECRET)');
    }
    if (!process.env.SENTRY_DSN && (!secrets.get('SENTRY_DSN'))) {
      // Sentry is optional; only warn when errorTracking flag is on.
      // Lazily check via features — but we don't have flags here.
    }
    const adminPw = process.env.ADMIN_PASSWORD || '';
    if (adminPw && adminPw.length < 12) issues.push('ADMIN_PASSWORD shorter than 12 chars');
  }
  if (!process.env.LINE_CHANNEL_SECRET && !secrets.get('LINE_CHANNEL_SECRET')) {
    // Check if any DB OA has its own secret instead — multi-OA deploys
    // don't need the env var.
    // We can't access pool here so just report this as a hint, not an error.
  }
  if (issues.length === 0) return { status: 'ok', message: 'Boot config looks healthy' };
  return { status: 'warn', message: `${issues.length} config issue(s)`, detail: { issues } };
}

async function checkPoolStats(pool) {
  try {
    const total = pool.totalCount ?? 0;
    const idle  = pool.idleCount  ?? 0;
    const waiting = pool.waitingCount ?? 0;
    if (waiting > 5) return { status: 'error', message: `${waiting} queries waiting on a free connection`, detail: { total, idle, waiting } };
    if (waiting > 0) return { status: 'warn',  message: `${waiting} queries waiting`, detail: { total, idle, waiting } };
    return { status: 'ok', message: `Pool ${idle}/${total} idle`, detail: { total, idle, waiting } };
  } catch (err) {
    return { status: 'ok', message: 'Pool stats unavailable' };
  }
}

// --- Aggregate ------------------------------------------------------------

const CHECKS = [
  { id: 'database',            label: 'PostgreSQL ping',       fn: (p) => checkDatabase(p) },
  { id: 'schema',              label: 'Schema sanity',         fn: (p) => checkSchemaSanity(p) },
  { id: 'pool',                label: 'Connection pool',       fn: (p) => checkPoolStats(p) },
  { id: 'line_oa',             label: 'LINE OA reachability',  fn: (p) => checkLineOa(p) },
  { id: 'smtp',                label: 'SMTP transport',        fn: (_p, f) => checkSmtp(f) },
  { id: 'r2',                  label: 'R2 / S3 storage',       fn: () => checkR2() },
  { id: 'queue',               label: 'Notification queue',    fn: (p) => checkNotificationQueue(p) },
  { id: 'failed_logins',       label: 'Failed logins (15min)', fn: (p) => checkRecentFailedLogins(p) },
  { id: 'lockouts',            label: 'Active lockouts',       fn: (p) => checkActiveLockouts(p) },
  { id: 'scheduler',           label: 'Scheduler heartbeat',   fn: () => checkSchedulerHeartbeat() },
  { id: 'config',              label: 'Boot configuration',    fn: () => checkBootConfig() },
];

/**
 * Run every check in parallel. Each individual check is internally bounded
 * by a per-probe timeout so one slow dependency can't stall the report.
 *
 * @param {object} pool
 * @returns {Promise<{ok:boolean, severity:'ok'|'warn'|'error', checkedAt:string, checks:Array}>}
 */
async function runChecks(pool) {
  let flags = {};
  try { flags = await features.load(pool); } catch { /* keep going with empty flags */ }
  const results = await Promise.all(
    CHECKS.map(async (c) => {
      const start = Date.now();
      let res;
      try {
        res = await c.fn(pool, flags);
      } catch (err) {
        res = { status: 'error', message: err.message };
      }
      return {
        id: c.id,
        label: c.label,
        status: res.status || 'ok',
        message: res.message || '',
        detail: res.detail || null,
        durationMs: Date.now() - start,
      };
    })
  );
  // Worst rung wins — surfaces the highest severity for badge / alerting.
  const worst = results.reduce(
    (acc, r) => (SEVERITY_RANK[r.status] > SEVERITY_RANK[acc] ? r.status : acc),
    'ok'
  );
  return {
    ok: worst === 'ok',
    severity: worst,
    checkedAt: new Date().toISOString(),
    checks: results,
  };
}

module.exports = { runChecks, CHECKS };
