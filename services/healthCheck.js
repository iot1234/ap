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
    // Slip auto-verify columns added in commit 972dc23. Without these,
    // POST /api/tenant/payments crashes with "column does not exist"
    // when slipUpload.autoVerify is enabled — the upload request reaches
    // INSERT before the missing-column error surfaces.
    ['payments',        'transaction_ref'],
    ['payments',        'verify_provider'],
    ['payments',        'verify_payload'],
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
    const res = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='pending')                        AS pending,
        COUNT(*) FILTER (WHERE status='pending' AND next_attempt_at < NOW() - INTERVAL '15 minutes') AS stuck,
        COUNT(*) FILTER (WHERE status='failed' AND created_at > NOW() - INTERVAL '1 hour') AS recent_failed
      FROM notifications_queue`);
    // Defense-in-depth: a few wrapped pool implementations (or a partially
    // initialised circuit-breaker shim) can return a result object whose
    // `rows` array is missing/empty even when the SQL succeeded. Treat that
    // as "no data" rather than crashing with TypeError on rows[0].stuck.
    const r = (res && Array.isArray(res.rows) && res.rows[0]) || {};
    const stuck = Number(r.stuck) || 0;
    const failed = Number(r.recent_failed) || 0;
    const pending = Number(r.pending) || 0;
    const detail = { pending, stuck, recent_failed: failed };
    if (stuck > 5)  return { status: 'error', message: `${stuck} notifications stuck > 15min — queue worker may be wedged`, detail };
    if (failed > 20) return { status: 'warn', message: `${failed} notifications failed in the last hour`, detail };
    return { status: 'ok', message: `Queue healthy (${pending} pending)`, detail };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

async function checkRecentFailedLogins(pool) {
  try {
    const res = await pool.query(`
      SELECT COUNT(*) AS n FROM audit_logs
      WHERE action IN ('auth.login_failed','tenant.login_failed','auth.login_locked')
        AND created_at > NOW() - INTERVAL '15 minutes'`);
    const r = (res && Array.isArray(res.rows) && res.rows[0]) || {};
    const n = Number(r.n) || 0;
    if (n > 30) return { status: 'error', message: `${n} failed login attempts in 15min — possible brute-force in progress`, detail: { n } };
    if (n > 10) return { status: 'warn',  message: `${n} failed login attempts in 15min`, detail: { n } };
    return { status: 'ok', message: `${n} failed logins (15min window)`, detail: { n } };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

async function checkActiveLockouts(pool) {
  try {
    const res = await pool.query(`
      SELECT COUNT(*) AS n FROM login_lockouts WHERE locked_until > NOW()`);
    const r = (res && Array.isArray(res.rows) && res.rows[0]) || {};
    const n = Number(r.n) || 0;
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

// Cross-feature dependency audit. Each entry below describes a flag combination
// that's silently broken. Returns warnings so admin sees them in the health
// dashboard + anomalyDetector pings them in the nightly Health alert.
//
// This catches the class of bug where admin toggles flag A on without
// realising flag B (or some env/secret) is required — currently the symptom
// is a silent feature failure: clicks happen, nothing breaks visibly, but
// notifications never arrive / cards never revoke / slips can't upload.
async function checkFeatureDependencies(features) {
  const warnings = [];

  // slipUpload requires tenantPortal — tenants must have a session to upload.
  // Without tenantPortal, /api/tenant/payments returns 401 even though the
  // slipUpload flag is on, and the admin UI's slip queue stays empty forever.
  if (features?.slipUpload?.enabled && !features?.tenantPortal?.enabled) {
    warnings.push({
      flag: 'slipUpload',
      issue: 'slipUpload เปิด แต่ tenantPortal ปิด — ผู้เช่าจะ upload สลิปไม่ได้ (login ไม่ได้)',
      fix: 'เปิด tenantPortal ในหน้า Features',
    });
  }

  // accessControl auto-revoke needs bills with tenant_id. If admin only uses
  // the legacy rooms blob (no tenant rows), bills will have NULL tenant_id
  // and the scheduler's revoke query never matches anyone.
  if (features?.accessControl?.enabled && features?.accessControl?.requirePaymentForCard
      && !features?.tenantPortal?.enabled) {
    warnings.push({
      flag: 'accessControl',
      issue: 'accessControl.requirePaymentForCard ON แต่ tenantPortal ปิด — บัตรจะไม่ถูกเพิกถอนอัตโนมัติเมื่อค้างชำระ (ต้องมี tenant rows)',
      fix: 'เปิด tenantPortal เพื่อสร้าง tenant rows + bills.tenant_id ที่จำเป็น',
    });
  }

  // email channel: flag on but SMTP_PASS missing. Email never sends, but
  // notifier's fallback chain would be expected by admin to work.
  if (features?.email?.enabled) {
    const host = secrets.get('SMTP_HOST');
    const pass = secrets.get('SMTP_PASS');
    if (!host || !pass) {
      warnings.push({
        flag: 'email',
        issue: 'email เปิด แต่ SMTP_HOST/SMTP_PASS ยังไม่ครบ — ส่งอีเมล fallback ไม่ได้',
        fix: 'ตั้งค่าใน Settings → Secrets',
      });
    }
  }

  // SMS provider: flag on but provider not configured / SDK not installed.
  if (features?.sms?.enabled) {
    const provider = features.sms.provider || '';
    let configured = false;
    if (provider === 'twilio') {
      configured = !!(secrets.get('TWILIO_ACCOUNT_SID') && secrets.get('TWILIO_AUTH_TOKEN') && secrets.get('TWILIO_FROM'));
      if (configured) {
        try { require.resolve('twilio'); }
        catch { warnings.push({ flag: 'sms', issue: 'sms=twilio แต่ SDK ไม่ได้ติดตั้ง', fix: 'รัน `npm i twilio`' }); }
      }
    } else if (provider === 'thsms') {
      configured = !!(secrets.get('THSMS_API_KEY') && secrets.get('THSMS_API_SECRET'));
    }
    if (!configured) {
      warnings.push({
        flag: 'sms',
        issue: `sms เปิด แต่ provider "${provider || '?'}" ยังไม่ได้ตั้งค่า credentials`,
        fix: 'ตั้งค่าใน Settings → Secrets หรือเลือก provider ใหม่',
      });
    }
  }

  // autoBackup without R2 secrets: backup runs locally only — Railway disk is
  // ephemeral and resets on every redeploy, so "auto-backup is on" gives a
  // false sense of safety.
  if (features?.autoBackup?.enabled) {
    const r2Set = !!(secrets.get('R2_ACCESS_KEY_ID') && secrets.get('R2_BUCKET'));
    if (!r2Set) {
      warnings.push({
        flag: 'autoBackup',
        issue: 'autoBackup เปิด แต่ R2 ไม่ได้ตั้งค่า — backup จะอยู่บนดิสก์ container (หายเมื่อ redeploy)',
        fix: 'ตั้งค่า R2_* ในหน้า Secrets เพื่อ upload ขึ้น cloud',
      });
    }
  }

  // errorTracking: flag on but no SENTRY_DSN.
  if (features?.errorTracking?.enabled
      && !secrets.get('SENTRY_DSN') && !process.env.SENTRY_DSN) {
    warnings.push({
      flag: 'errorTracking',
      issue: 'errorTracking เปิด แต่ SENTRY_DSN ยังไม่ตั้งค่า',
      fix: 'ใส่ DSN ในหน้า Secrets',
    });
  }

  // meterIot.mode = 'mqtt' is advertised in the Features UI but no MQTT
  // subscriber is wired in this build. Operators flipping to mqtt see no
  // readings arrive — same effect as 'manual' but without the operator
  // realising they need to enter readings by hand. Surface this so the
  // mismatch is visible on /admin#health rather than silently broken.
  if (features?.meterIot?.enabled && features?.meterIot?.mode === 'mqtt') {
    warnings.push({
      flag: 'meterIot',
      issue: 'meterIot.mode = "mqtt" — MQTT subscriber ยังไม่ implement ในระบบนี้ จะไม่มี reading เข้ามาอัตโนมัติ',
      fix: 'เปลี่ยนเป็น "manual" และให้ผู้ดูแลกรอกค่ามิเตอร์เอง หรือรอ MQTT integration',
    });
  }

  // recurringCharges flag on but billAutoGenerate off → charges defined but
  // never applied automatically. Manual bill gen still works, so this is a
  // soft warning.
  if (features?.recurringCharges?.enabled && !features?.billAutoGenerate?.enabled) {
    warnings.push({
      flag: 'recurringCharges',
      issue: 'recurringCharges เปิด แต่ billAutoGenerate ปิด — ต้องสร้างบิลด้วยมือทุกเดือนถึงจะรวม recurring',
      fix: 'เปิด billAutoGenerate ถ้าต้องการ schedule อัตโนมัติ',
    });
  }

  // slipUpload.autoVerify ON but no provider key → silently never auto-
  // verifies anything (every slip falls back to admin queue). Operator
  // expects "instant payment" but actually nothing changed. Surface this.
  // Use the verifier's own getConfiguredProviders so multi-provider config
  // (features.slipUpload.providers = ['slipok','easyslip']) is checked too —
  // not just the legacy single provider field.
  if (features?.slipUpload?.enabled && features?.slipUpload?.autoVerify) {
    let slipVerifier;
    try { slipVerifier = require('./slipVerifier'); } catch { /* ignore */ }
    const ready = slipVerifier?.getConfiguredProviders
      ? slipVerifier.getConfiguredProviders(features)
      : [];
    // Compute the operator's INTENDED list (regardless of key presence) so
    // the warning can name the missing key precisely.
    const intended = Array.isArray(features.slipUpload.providers)
      ? features.slipUpload.providers
      : (features.slipUpload.provider ? [features.slipUpload.provider] : ['slipok']);
    const KEY_BY_PROVIDER = { slipok: 'SLIPOK_API_KEY', easyslip: 'EASYSLIP_API_KEY' };
    const missing = intended.filter((p) => {
      const k = KEY_BY_PROVIDER[p];
      return k ? !secrets.get(k) : true;     // unknown provider name → "missing"
    });
    if (ready.length === 0) {
      warnings.push({
        flag: 'slipUpload.autoVerify',
        issue: `autoVerify เปิด แต่ไม่มี provider พร้อมใช้ (${intended.join(', ') || 'none'}) — สลิปจะตกเข้าคิว admin เหมือนเดิม`,
        fix: missing.length
          ? `ตั้งค่า key สำหรับ ${missing.map((p) => KEY_BY_PROVIDER[p] || `provider:${p}`).join(', ')} ใน Settings → Secrets`
          : 'ตรวจรายชื่อ provider ใน features.slipUpload.providers',
      });
    } else if (missing.length > 0) {
      // Some providers ready, some not — fallback chain still works on the
      // ready ones, but surface the partial config so the operator can
      // either complete it or remove the unused name.
      warnings.push({
        flag: 'slipUpload.autoVerify',
        issue: `provider ${missing.join(', ')} ตั้งชื่อไว้แต่ key ยังไม่มา — ใช้ได้แค่ ${ready.map((p) => p.id).join(', ')}`,
        fix: `ตั้ง ${missing.map((p) => KEY_BY_PROVIDER[p] || `key:${p}`).join(', ')} ใน Settings → Secrets หรือเอาชื่อนี้ออกจาก providers`,
      });
    }
    // Receiver-account match needs PROMPTPAY_TARGET to be set — without it
    // we can't safely auto-accept (any slip paid to ANY account would pass
    // amount-only check).
    if (ready.length > 0 && !secrets.get('PROMPTPAY_TARGET')) {
      warnings.push({
        flag: 'slipUpload.autoVerify',
        issue: 'autoVerify เปิด แต่ PROMPTPAY_TARGET ไม่ตั้ง — auto-verify ไม่สามารถตรวจสอบบัญชีปลายทาง',
        fix: 'ตั้ง PROMPTPAY_TARGET ใน Secrets เพื่อให้ระบบยืนยันว่าโอนเข้าบัญชีหอพัก',
      });
    }
  }

  if (warnings.length === 0) {
    return { status: 'ok', message: 'Feature dependencies look consistent' };
  }
  return {
    status: 'warn',
    message: `พบความไม่สอดคล้องระหว่าง flag ${warnings.length} จุด`,
    detail: { warnings },
  };
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
  { id: 'feature_deps',        label: 'Feature dependencies',  fn: (_p, f) => checkFeatureDependencies(f) },
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
