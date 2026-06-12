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
const pricing = require('./pricing');

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
  const host = secrets.get('SMTP_HOST') || features.email.smtpHost;
  const user = secrets.get('SMTP_USER') || features.email.smtpUser;
  const pass = secrets.get('SMTP_PASS');
  if (!host || !user || !pass) {
    return { status: 'warn', message: 'Email enabled but SMTP host/user/pass not fully set' };
  }
  let nm;
  try { nm = require('nodemailer'); }
  catch { return { status: 'warn', message: 'nodemailer not installed' }; }
  try {
    const t = nm.createTransport({
      host, port: Number(secrets.get('SMTP_PORT') || features.email.smtpPort || 587),
      secure: Number(secrets.get('SMTP_PORT') || features.email.smtpPort) === 465,
      auth: { user, pass },
      connectionTimeout: 6000,
    });
    // withTimeout NEVER rejects — it resolves to {timedOut} / {thrown} on
    // failure. Must inspect the result (like checkDatabase) or a dead/wrong-
    // credential SMTP host would report green while email silently fails.
    const r = await withTimeout(t.verify(), 6000, 'smtp');
    if (r?.timedOut) return { status: 'error', message: 'SMTP verify timed out (6s)' };
    if (r?.thrown)   return { status: 'error', message: `SMTP verify failed: ${r.message}` };
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
    // Same as checkSmtp: inspect the withTimeout result or a 403/wrong-bucket/
    // DNS failure on HeadBucket would report green while uploads silently fail.
    const r = await withTimeout(client.send(new lib.HeadBucketCommand({ Bucket: bucket })), 6000, 'r2');
    if (r?.timedOut) return { status: 'error', message: 'R2 HeadBucket timed out (6s)' };
    if (r?.thrown)   return { status: 'error', message: `R2 unreachable: ${r.message}` };
    return { status: 'ok', message: `R2 bucket "${bucket}" reachable` };
  } catch (err) {
    return { status: 'error', message: `R2 unreachable: ${err.message}` };
  }
}

async function checkUploadStorage(pool) {
  const storage = require('./storage');
  const status = storage.storageStatus();
  const detail = {
    mode: status.storageMode,
    s3Configured: status.s3Configured,
    uploadRoot: status.uploadRoot,
    hasExplicitUploadDir: status.hasExplicitUploadDir,
    productionLike: status.productionLike,
    localUploadMayBeEphemeral: status.localUploadMayBeEphemeral,
    counts: {},
    missingLocalFileSamples: [],
  };
  const errors = [];
  const warnings = [];

  try {
    if (status.storageMode === 'local') {
      const rootExists = fs.existsSync(status.uploadRoot);
      const accessPath = rootExists ? status.uploadRoot : path.dirname(status.uploadRoot);
      detail.localAccess = { rootExists, checkedPath: accessPath, ok: false };
      try {
        fs.accessSync(accessPath, fs.constants.R_OK | fs.constants.W_OK);
        detail.localAccess.ok = true;
      } catch (err) {
        detail.localAccess.error = err.message;
        errors.push(`local upload path is not readable/writable: ${accessPath}`);
      }
      if (status.localUploadMayBeEphemeral) {
        warnings.push(
          'production-like runtime is storing uploads on app-local disk without R2/S3 or explicit UPLOAD_DIR; legal files may disappear after redeploy'
        );
      }
    }

    const countsQ = await pool.query(`
      WITH invitation_files AS (
        SELECT ci.id AS invitation_id, ci.draft->>'signatureFileId' AS file_id,
               'contract_signature'::text AS expected_category, NULL::text AS expected_side
          FROM contract_invitations ci
         WHERE ci.status IN ('pending','submitted')
        UNION ALL
        SELECT ci.id, ci.draft->>'citizenIdFrontFileId',
               'citizen_id_image'::text, 'front'::text
          FROM contract_invitations ci
         WHERE ci.status IN ('pending','submitted')
        UNION ALL
        SELECT ci.id, ci.draft->>'citizenIdBackFileId',
               'citizen_id_image'::text, 'back'::text
          FROM contract_invitations ci
         WHERE ci.status IN ('pending','submitted')
      )
      SELECT
        (SELECT COUNT(*)::int FROM file_uploads) AS file_rows,
        (SELECT COUNT(*)::int FROM file_uploads WHERE storage='local') AS local_file_rows,
        (SELECT COUNT(*)::int FROM file_uploads WHERE storage='s3') AS s3_file_rows,
        (SELECT COUNT(*)::int FROM contracts c
          WHERE c.deleted_at IS NULL
            AND c.locked_at IS NOT NULL
            AND c.signature_image_id IS NULL) AS locked_contracts_missing_signature,
        (SELECT COUNT(*)::int FROM contracts c
          WHERE c.deleted_at IS NULL
            AND c.signature_image_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM file_uploads f WHERE f.id = c.signature_image_id
            )) AS contract_signature_file_rows_missing,
        (SELECT COUNT(*)::int FROM contracts c
          JOIN file_uploads f ON f.id = c.signature_image_id
         WHERE c.deleted_at IS NULL
           AND (
             f.category <> 'contract_signature'
             OR COALESCE(f.ref_id, '') <> c.id::text
           )) AS contract_signature_file_rows_mismatched,
        (SELECT COUNT(*)::int FROM tenants t
          WHERE t.deleted_at IS NULL
            AND t.citizen_id_image_front_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM file_uploads f WHERE f.id = t.citizen_id_image_front_id
            )) +
        (SELECT COUNT(*)::int FROM tenants t
          WHERE t.deleted_at IS NULL
            AND t.citizen_id_image_back_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM file_uploads f WHERE f.id = t.citizen_id_image_back_id
            )) AS tenant_identity_file_rows_missing,
        (SELECT COUNT(*)::int FROM tenants t
          JOIN file_uploads f ON f.id = t.citizen_id_image_front_id
         WHERE t.deleted_at IS NULL
           AND (
             f.category <> 'citizen_id_image'
             OR COALESCE(f.ref_id, '') <> t.id::text
             OR (f.side IS NOT NULL AND f.side <> 'front')
           )) +
        (SELECT COUNT(*)::int FROM tenants t
          JOIN file_uploads f ON f.id = t.citizen_id_image_back_id
         WHERE t.deleted_at IS NULL
           AND (
             f.category <> 'citizen_id_image'
             OR COALESCE(f.ref_id, '') <> t.id::text
             OR (f.side IS NOT NULL AND f.side <> 'back')
           )) AS tenant_identity_file_rows_mismatched,
        (SELECT COUNT(*)::int
           FROM invitation_files x
          WHERE NULLIF(x.file_id, '') IS NOT NULL
            AND (
              x.file_id !~ '^[0-9]+$'
              OR NOT EXISTS (
                SELECT 1 FROM file_uploads f
                 WHERE f.id = CASE
                   WHEN x.file_id ~ '^[0-9]+$' THEN x.file_id::bigint
                   ELSE NULL
                 END
                   AND f.category = x.expected_category
                   AND f.ref_id = 'invitation-' || x.invitation_id::text
                   AND (
                     x.expected_side IS NULL
                     OR f.side = x.expected_side
                     OR f.side IS NULL
                   )
              )
            )) AS invitation_draft_file_invalid`);
    const counts = countsQ.rows[0] || {};
    detail.counts = {
      file_rows: Number(counts.file_rows) || 0,
      local_file_rows: Number(counts.local_file_rows) || 0,
      s3_file_rows: Number(counts.s3_file_rows) || 0,
      locked_contracts_missing_signature: Number(counts.locked_contracts_missing_signature) || 0,
      contract_signature_file_rows_missing: Number(counts.contract_signature_file_rows_missing) || 0,
      contract_signature_file_rows_mismatched: Number(counts.contract_signature_file_rows_mismatched) || 0,
      tenant_identity_file_rows_missing: Number(counts.tenant_identity_file_rows_missing) || 0,
      tenant_identity_file_rows_mismatched: Number(counts.tenant_identity_file_rows_mismatched) || 0,
      invitation_draft_file_invalid: Number(counts.invitation_draft_file_invalid) || 0,
    };

    if (!status.s3Configured && detail.counts.s3_file_rows > 0) {
      errors.push(`${detail.counts.s3_file_rows} uploaded file row(s) are stored as s3 but R2/S3 secrets are not fully configured`);
    }
    if (detail.counts.locked_contracts_missing_signature > 0) {
      errors.push(`${detail.counts.locked_contracts_missing_signature} locked contract(s) have no signature_image_id`);
    }
    if (detail.counts.contract_signature_file_rows_missing > 0) {
      errors.push(`${detail.counts.contract_signature_file_rows_missing} contract signature reference(s) point to missing file_uploads rows`);
    }
    if (detail.counts.contract_signature_file_rows_mismatched > 0) {
      errors.push(`${detail.counts.contract_signature_file_rows_mismatched} contract signature file row(s) have wrong category/ref_id`);
    }
    if (detail.counts.tenant_identity_file_rows_missing > 0) {
      errors.push(`${detail.counts.tenant_identity_file_rows_missing} tenant citizen-ID file reference(s) point to missing file_uploads rows`);
    }
    if (detail.counts.tenant_identity_file_rows_mismatched > 0) {
      errors.push(`${detail.counts.tenant_identity_file_rows_mismatched} tenant citizen-ID file row(s) have wrong category/ref_id/side`);
    }
    if (detail.counts.invitation_draft_file_invalid > 0) {
      errors.push(`${detail.counts.invitation_draft_file_invalid} pending/submitted contract invitation draft file reference(s) are invalid`);
    }

    if (status.storageMode === 'local') {
      const localFilesQ = await pool.query(`
        SELECT id, category, ref_id, filename, storage, uploaded_at
          FROM file_uploads
         WHERE storage='local'
           AND category IN ('contract_signature','citizen_id_image','slip')
         ORDER BY id DESC
         LIMIT 200`);
      const missing = (localFilesQ.rows || []).filter((row) => !storage.localFileExists(row));
      detail.sampledLocalFiles = localFilesQ.rows.length;
      detail.missingLocalFileSamples = missing.slice(0, 10).map((row) => ({
        id: row.id,
        category: row.category,
        refId: row.ref_id,
        filename: row.filename,
        uploadedAt: row.uploaded_at,
      }));
      if (missing.length > 0) {
        errors.push(`${missing.length} sampled local legal/payment file(s) are missing from disk`);
      }
    }

    if (errors.length) {
      return { status: 'error', message: `${errors.length} upload storage error(s)`, detail: { ...detail, errors, warnings } };
    }
    if (warnings.length) {
      return { status: 'warn', message: `${warnings.length} upload storage warning(s)`, detail: { ...detail, warnings } };
    }
    return {
      status: 'ok',
      message: `Upload storage OK (${detail.counts.file_rows} file row(s), mode=${status.storageMode})`,
      detail,
    };
  } catch (err) {
    return { status: 'error', message: `Upload storage check failed: ${err.message}`, detail };
  }
}

async function checkNotificationQueue(pool) {
  try {
    const res = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='pending')                        AS pending,
        COUNT(*) FILTER (WHERE status='pending' AND next_attempt_at < NOW() - INTERVAL '15 minutes') AS stuck,
        COUNT(*) FILTER (WHERE status='failed' AND created_at > NOW() - INTERVAL '1 hour') AS recent_failed,
        COUNT(*) FILTER (WHERE status='failed') AS failed_total
      FROM notifications_queue`);
    // Defense-in-depth: a few wrapped pool implementations (or a partially
    // initialised circuit-breaker shim) can return a result object whose
    // `rows` array is missing/empty even when the SQL succeeded. Treat that
    // as "no data" rather than crashing with TypeError on rows[0].stuck.
    const r = (res && Array.isArray(res.rows) && res.rows[0]) || {};
    const stuck = Number(r.stuck) || 0;
    const failed = Number(r.recent_failed) || 0;
    const failedTotal = Number(r.failed_total) || 0;
    const pending = Number(r.pending) || 0;
    const detail = { pending, stuck, recent_failed: failed, failed_total: failedTotal };
    const failedBreakdown = await pool.query(`
      SELECT
        channel,
        left(coalesce(last_error, ''), 120) AS error,
        COUNT(*)::int AS count
      FROM notifications_queue
      WHERE status='failed'
        AND created_at > NOW() - INTERVAL '24 hours'
      GROUP BY channel, left(coalesce(last_error, ''), 120)
      ORDER BY count DESC, channel ASC
      LIMIT 8`);
    const breakdown = (
      failedBreakdown && Array.isArray(failedBreakdown.rows) ? failedBreakdown.rows : []
    ).map((x) => ({
      channel: x.channel || 'unknown',
      error: x.error || '',
      count: Number(x.count) || 0,
    }));
    detail.recent_failed_breakdown = breakdown;
    const configFailures = breakdown.filter((x) => /not configured|not implemented|host\/user\/pass/i.test(x.error));
    if (configFailures.length > 0) {
      return {
        status: 'warn',
        message: `มีการแจ้งเตือนส่งไม่สำเร็จ ${configFailures.reduce((sum, x) => sum + x.count, 0)} รายการ เพราะยังตั้งค่าช่องทางส่งไม่ครบ`,
        detail: {
          ...detail,
          nextAction: 'เปิดเมนูตั้งค่า > API/Keys กรอกข้อมูล LINE/SMTP/SMS ให้ครบ แล้วกลับไปกดส่งซ้ำในคิวแจ้งเตือน',
        },
      };
    }
    // Distinct from provider-config failures: the channel works, but the
    // recipient has no valid LINE binding. Fixing API keys won't help — the
    // tenant must (re-)link LINE. Surfacing this separately tells the operator
    // exactly which lever to pull instead of lumping it into "review provider".
    const recipientFailures = breakdown.filter((x) => /invalid .*recipient|recipient missing|invalid .*user\s?id|userid shape/i.test(x.error));
    if (recipientFailures.length > 0) {
      return {
        status: 'warn',
        message: `มีการแจ้งเตือนส่งไม่ถึงผู้รับ ${recipientFailures.reduce((sum, x) => sum + x.count, 0)} รายการ เพราะผู้รับยังไม่ได้ผูก LINE หรือข้อมูล LINE ไม่ถูกต้อง`,
        detail: {
          ...detail,
          nextAction: 'ให้ผู้เช่าผูก LINE ใหม่ผ่านพอร์ทัลผู้เช่าหรือสแกน QR ของ LINE OA แล้วค่อยส่งซ้ำ การแก้ API key อย่างเดียวไม่ช่วยกรณีนี้',
        },
      };
    }
    if (stuck > 5)  return { status: 'error', message: `มีการแจ้งเตือนค้างเกิน 15 นาที ${stuck} รายการ ควรตรวจคิวส่งแจ้งเตือน`, detail };
    if (failed > 20) return { status: 'warn', message: `มีการแจ้งเตือนส่งไม่สำเร็จในชั่วโมงล่าสุด ${failed} รายการ`, detail };
    if (failedTotal > 50) return { status: 'warn', message: `มีการแจ้งเตือนล้มเหลวค้างในระบบ ${failedTotal} รายการ ควรตรวจ provider/secrets ก่อนพึ่งพาการแจ้งเตือน`, detail };
    return { status: 'ok', message: `คิวแจ้งเตือนปกติ (รอส่ง ${pending} รายการ)`, detail };
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
    // Citizen-ID PII is encrypted by services/crypto.js, which reads ONLY
    // CITIZEN_ID_KEY (or derives from SESSION_SECRET via HKDF). It does NOT
    // read ENCRYPTION_KEY_V* — those feed services/encryption.js (secrets
    // table + LINE OA tokens), a SEPARATE key system. Treating ENCRYPTION_KEY_V1
    // as covering citizen IDs gave a false "healthy" signal: an operator who
    // set only ENCRYPTION_KEY_V1 still had citizen IDs bound to SESSION_SECRET,
    // so rotating SESSION_SECRET silently made every stored citizen ID
    // permanently undecryptable. Only CITIZEN_ID_KEY clears this warning.
    if (!process.env.CITIZEN_ID_KEY) {
      issues.push(
        'Citizen-ID PII has no dedicated key (CITIZEN_ID_KEY unset) — it is derived from '
        + 'SESSION_SECRET via HKDF. Rotating SESSION_SECRET will make all stored citizen IDs '
        + 'undecryptable. With EXISTING data, do NOT generate a random key (same key also feeds '
        + 'the dedup HMACs; there is no multi-key fallback) — pin the CURRENT derived key instead: '
        + 'node -e "const c=require(\'crypto\');console.log(Buffer.from(c.hkdfSync(\'sha256\','
        + 'Buffer.from(process.env.S),Buffer.alloc(0),\'baankarn-pii-v1\',32)).toString(\'base64\'))" '
        + '(run with S=<current SESSION_SECRET>), then set the output as CITIZEN_ID_KEY. '
        + 'NOTE: ENCRYPTION_KEY_V* does NOT protect citizen IDs — it only covers the secrets/OA-token store.'
      );
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
async function checkFeatureDependencies(features, pool) {
  const warnings = [];
  let appConfigLoaded = false;
  let appConfig = {};
  const loadAppConfig = async () => {
    if (appConfigLoaded) return appConfig;
    appConfigLoaded = true;
    if (!pool) return appConfig;
    try {
      const cfgQ = await pool.query(
        `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
      );
      appConfig = cfgQ.rows[0]?.value || {};
    } catch {
      appConfig = {};
    }
    return appConfig;
  };

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

  if (features?.slipUpload?.enabled) {
    if (features.slipUpload.allowUnverifiedAutoApprove === true) {
      warnings.push({
        flag: 'slipUpload.allowUnverifiedAutoApprove',
        issue: 'tenant uploads can mark bills paid without provider/admin verification',
        fix: 'turn this off unless this is an intentional legacy trust mode',
      });
    } else if (features.slipUpload.requireVerification === false && !features.slipUpload.autoVerify) {
      warnings.push({
        flag: 'slipUpload.requireVerification',
        issue: 'requireVerification is off but autoVerify is off too; slips will still wait for admin review',
        fix: 'turn on autoVerify with provider keys, or turn requireVerification back on',
      });
    }
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
    const host = secrets.get('SMTP_HOST') || features.email.smtpHost;
    const user = secrets.get('SMTP_USER') || features.email.smtpUser;
    const pass = secrets.get('SMTP_PASS');
    if (!host || !user || !pass) {
      warnings.push({
        flag: 'email',
        issue: 'email เปิด แต่ SMTP_HOST/SMTP_USER/SMTP_PASS ยังไม่ครบ — ส่งอีเมล fallback ไม่ได้',
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
      fix: 'เปลี่ยนเป็น "manual" และให้ผู้ดูแลกรอกค่ามิเตอร์เอง',
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

  // Public booking deposits are a cross-feature flow: roomBooking controls the
  // hold/slip requirement, while Settings -> payment supplies the receiver the
  // public page shows. If deposit+slip is on with no receiver, the hold/submit
  // endpoints intentionally block with BOOKING_DEPOSIT_PAYMENT_NOT_CONFIGURED.
  // Surface that before applicants hit the public page.
  if (features?.roomBooking?.enabled !== false && features?.roomBooking?.requireDeposit === true) {
    const rawAmount = Number(features.roomBooking.depositAmount);
    const rawMinimum = Number(features.roomBooking.minimumAmount);
    const depositAmount = Number.isFinite(rawAmount) && rawAmount >= 0 ? rawAmount : 500;
    const minimumAmount = Number.isFinite(rawMinimum) && rawMinimum > 0 ? rawMinimum : 0;
    const effectiveAmount = minimumAmount > 0 ? Math.max(depositAmount, minimumAmount) : depositAmount;
    if (!(effectiveAmount > 0)) {
      warnings.push({
        flag: 'roomBooking.depositAmount',
        issue: 'roomBooking.requireDeposit เปิด แต่ยอดค่าจองที่ใช้จริงเป็น 0 — ผู้จองจะล็อกห้อง/ชำระค่าจองไม่ได้ถูกต้อง',
        fix: 'ตั้ง depositAmount หรือ minimumAmount ให้มากกว่า 0 ในหน้าตั้งค่าจอง/มัดจำ',
      });
    } else if (features.roomBooking.requireSlip !== false) {
      let paymentReady = false;
      try {
        const billing = require('./billing');
        const promptpay = require('./promptpay');
        const cfg = await loadAppConfig();
        const block = billing.buildPaymentBlock(cfg || {});
        if (!block.promptpayTarget) {
          const envPp = secrets.get('PROMPTPAY_TARGET');
          if (envPp) block.promptpayTarget = envPp;
        }
        let promptpayReady = false;
        if (block.promptpayTarget) {
          try {
            const target = promptpay.normaliseTarget(block.promptpayTarget);
            promptpayReady = !promptpay.isDemoTarget(target);
          } catch {
            promptpayReady = false;
          }
        }
        paymentReady = !!(
          promptpayReady
          || (block.bankInfo && block.bankInfo.account)
          || (block.walletInfo && block.walletInfo.phone)
        );
      } catch {
        paymentReady = false;
      }
      if (!paymentReady) {
        warnings.push({
          flag: 'roomBooking.requireDeposit',
          issue: 'roomBooking.requireDeposit + requireSlip เปิด แต่ยังไม่มี PromptPay/บัญชีธนาคาร/TrueMoney ที่พร้อมรับเงิน — หน้า booking จะบล็อกการล็อกห้องและส่งคำขอ',
          fix: 'ตั้งค่าช่องทางรับเงินใน Settings → การชำระเงิน หรือปิด requireSlip เพื่อรับจองแบบ manual review',
        });
      }
    }
  }

  // The payment-reminder scheduler currently delivers only LINE and email.
  // If LINE is explicitly disabled and email is either disabled or not
  // configured, enabling paymentReminder creates a daily job that can never
  // reach tenants.
  if (features?.paymentReminder?.enabled) {
    const cfg = await loadAppConfig();
    const channels = cfg?.notify?.channels || {};
    const lineAllowed = channels.line !== false;
    const emailAllowed = channels.email !== false;
    const emailReady = !!(features?.email?.enabled
      && (secrets.get('SMTP_HOST') || features.email.smtpHost)
      && (secrets.get('SMTP_USER') || features.email.smtpUser)
      && secrets.get('SMTP_PASS'));
    if (!lineAllowed && (!emailAllowed || !emailReady)) {
      warnings.push({
        flag: 'paymentReminder',
        issue: 'paymentReminder เปิด แต่ LINE ถูกปิด และอีเมลไม่พร้อมใช้งาน — reminder ก่อนครบกำหนดจะไม่ถึงผู้เช่า',
        fix: 'เปิด notify.channels.line หรือเปิด/ตั้งค่า email SMTP ให้ครบก่อนใช้ paymentReminder',
      });
    }
  }

  // slipUpload.autoVerify ON but no provider key → silently never auto-
  // verifies anything (every slip falls back to admin queue). Operator
  // expects "instant payment" but actually nothing changed. Surface this.
  // Use the verifier's own getConfiguredProviders so multi-provider config
  // (features.slipUpload.providers = ['slipok','easyslip','slip2go']) is checked too —
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
    const KEYS_BY_PROVIDER = {
      slipok: ['SLIPOK_API_KEY'],
      easyslip: ['EASYSLIP_API_KEY'],
      slip2go: ['SLIP2GO_API_KEY', 'SLIP2GO_API_URL'],
    };
    const isHttpUrl = (value) => {
      try {
        const raw = String(value || '').trim();
        if (!raw) return false;
        const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    };
    const missing = intended.filter((p) => {
      const keys = KEYS_BY_PROVIDER[p];
      if (!keys) return true;     // unknown provider name → "missing"
      if (keys.some((k) => !secrets.get(k))) return true;
      if (p === 'slip2go') return !isHttpUrl(secrets.get('SLIP2GO_API_URL'));
      return false;
    });
    const labelKeys = (p) => {
      if (p === 'slip2go'
        && secrets.get('SLIP2GO_API_URL')
        && !isHttpUrl(secrets.get('SLIP2GO_API_URL'))) {
        return 'SLIP2GO_API_URL (URL ไม่ถูกต้อง)';
      }
      return (KEYS_BY_PROVIDER[p] || [`provider:${p}`]).join(' + ');
    };
    if (ready.length === 0) {
      warnings.push({
        flag: 'slipUpload.autoVerify',
        issue: `autoVerify เปิด แต่ไม่มี provider พร้อมใช้ (${intended.join(', ') || 'none'}) — สลิปจะตกเข้าคิว admin เหมือนเดิม`,
        fix: missing.length
          ? `ตั้งค่า key สำหรับ ${missing.map(labelKeys).join(', ')} ใน Settings → Secrets`
          : 'ตรวจรายชื่อ provider ใน features.slipUpload.providers',
      });
    } else if (missing.length > 0) {
      // Some providers ready, some not — fallback chain still works on the
      // ready ones, but surface the partial config so the operator can
      // either complete it or remove the unused name.
      warnings.push({
        flag: 'slipUpload.autoVerify',
        issue: `provider ${missing.join(', ')} ตั้งชื่อไว้แต่ key ยังไม่มา — ใช้ได้แค่ ${ready.map((p) => p.id).join(', ')}`,
        fix: `ตั้ง ${missing.map(labelKeys).join(', ')} ใน Settings → Secrets หรือเอาชื่อนี้ออกจาก providers`,
      });
    }
    // Receiver-account match needs at least one configured receiver target.
    // PromptPay is ideal for QR, but bank transfer and TrueMoney Wallet are
    // valid manual receivers too. Keep this aligned with server.js
    // paymentBlockReceiverTargets() so health diagnostics match upload
    // behaviour.
    const receiverTargets = [];
    const addReceiverDigits = (value) => {
      const digits = String(value || '').replace(/[^0-9]/g, '');
      if (digits.length >= 4) receiverTargets.push(digits);
    };
    addReceiverDigits(secrets.get('PROMPTPAY_TARGET'));
    if (pool) {
      try {
        const cfg = await loadAppConfig();
        addReceiverDigits(cfg?.payment?.promptpay || cfg?.payment?.promptpayTarget || null);
        addReceiverDigits(cfg?.payment?.bankAcc || null);
        if (cfg?.payment?.truemoney === true) {
          addReceiverDigits(
            cfg?.payment?.truemoneyPhone
            || cfg?.payment?.trueMoneyPhone
            || cfg?.payment?.walletPhone
            || null
          );
        }
      } catch { /* keep env fallback result */ }
    }
    if (ready.length > 0 && receiverTargets.length === 0) {
      warnings.push({
        flag: 'slipUpload.autoVerify',
        issue: 'autoVerify เปิด แต่ยังไม่มี PromptPay/บัญชีธนาคาร/TrueMoney Wallet ที่ตรวจเป็นปลายทางรับเงินได้ — auto-verify ไม่สามารถตรวจสอบบัญชีปลายทาง',
        fix: 'ตั้ง PromptPay, บัญชีธนาคาร หรือ TrueMoney Wallet ใน Settings → การชำระเงิน เพื่อให้ระบบยืนยันว่าโอนเข้าบัญชีหอพัก',
      });
    }
  }

  // vat enabled but rate ≤ 0 → every bill's VAT line is 0; the operator almost
  // certainly meant 7%. Surface rather than silently billing without tax.
  if (features?.vat?.enabled && !(Number(features.vat.ratePct) > 0)) {
    warnings.push({
      flag: 'vat',
      issue: 'vat เปิด แต่ ratePct ≤ 0 — ทุกบิลจะคิด VAT = 0',
      fix: 'ตั้ง vat.ratePct (เช่น 7) ในหน้า Features',
    });
  }

  // lateFee enabled but rate ≤ 0 → bills still flip to 'overdue' but the penalty
  // is always 0, so the feature does nothing the operator can see.
  if (features?.lateFee?.enabled && !(Number(features.lateFee.ratePctPerMonth) > 0)) {
    warnings.push({
      flag: 'lateFee',
      issue: 'lateFee เปิด แต่ ratePctPerMonth ≤ 0 — บิลค้างจะไม่ถูกคิดค่าปรับ',
      fix: 'ตั้ง lateFee.ratePctPerMonth (เช่น 1.5) หรือปิด lateFee',
    });
  }

  // citizenIdEncryption on but no dedicated key → the key is HKDF-derived from
  // SESSION_SECRET. It works, but rotating SESSION_SECRET later makes every
  // stored citizen ID undecryptable. Same gap the boot log warns about; surface
  // it where the operator toggles features too.
  // Only CITIZEN_ID_KEY clears this — services/crypto.js (citizen-ID PII) reads
  // ONLY CITIZEN_ID_KEY (else HKDF from SESSION_SECRET); it never reads
  // ENCRYPTION_KEY_V* (those feed services/encryption.js: secrets/OA tokens, a
  // separate key system). Treating ENCRYPTION_KEY_V1 as covering citizen IDs
  // gave a false "safe" signal — matches the checkBootConfig fix.
  if (features?.citizenIdEncryption?.enabled && !process.env.CITIZEN_ID_KEY) {
    warnings.push({
      flag: 'citizenIdEncryption',
      issue: 'citizenIdEncryption เปิด แต่ไม่ได้ตั้ง CITIZEN_ID_KEY — ใช้คีย์ที่ derive จาก SESSION_SECRET ถ้าเปลี่ยน SESSION_SECRET ภายหลัง ข้อมูลบัตรเดิมจะถอดรหัสไม่ได้ (กู้คืนไม่ได้) — หมายเหตุ: ENCRYPTION_KEY_V1 เป็นคนละระบบ ไม่ครอบคลุมข้อมูลบัตร',
      // IMPORTANT: if citizen IDs already exist, a RANDOM new key bricks
      // them all (decrypt + dedup HMACs use this same key, no multi-key
      // fallback). The safe move is to pin the CURRENT derived key.
      fix: 'ระบบมีข้อมูลบัตรอยู่แล้ว → ห้ามสุ่มคีย์ใหม่ ให้ตั้ง CITIZEN_ID_KEY เป็น "คีย์เดิมที่ derive อยู่" : รันในเครื่อง node -e "const c=require(\'crypto\');console.log(Buffer.from(c.hkdfSync(\'sha256\',Buffer.from(process.env.S),Buffer.alloc(0),\'baankarn-pii-v1\',32)).toString(\'base64\'))" โดยตั้งตัวแปร S เป็น SESSION_SECRET ปัจจุบันก่อนรัน แล้วนำผลลัพธ์ไปตั้งเป็น CITIZEN_ID_KEY ใน env ของ deploy (ข้อมูลเดิมอ่านได้ต่อเนื่อง และเปลี่ยน SESSION_SECRET ภายหลังได้ปลอดภัย) · ระบบใหม่ที่ยังไม่มีข้อมูลบัตร → สุ่มได้เลย: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    });
  }

  // tenancyContract requires ID images at checkin, but photoUpload (the gate on
  // /api/uploads) is off → admin literally cannot upload the required images,
  // so every checkin is blocked.
  if (features?.tenancyContract?.requireIdentityImages && !features?.photoUpload?.enabled) {
    warnings.push({
      flag: 'tenancyContract',
      issue: 'tenancyContract.requireIdentityImages เปิด แต่ photoUpload ปิด — อัปโหลดรูปบัตรไม่ได้ ทำให้ checkin ค้างทุกครั้ง',
      fix: 'เปิด photoUpload หรือปิด requireIdentityImages',
    });
  }

  // Severity tagging so the UI + nightly alert can prioritise. Critical = a
  // security exposure, irreversible-data risk, or a feature that is completely
  // non-functional as configured. Everything else stays a 'warning'. Each
  // distinct issue above uses a distinct `flag` string, so keying off it is
  // precise.
  const CRITICAL_FLAGS = new Set([
    'slipUpload',                            // tenants literally can't upload (no portal)
    'slipUpload.allowUnverifiedAutoApprove', // bills paid with zero verification
    'roomBooking.depositAmount',             // deposit flow cannot collect a valid amount
    'roomBooking.requireDeposit',            // public booking deposits block at payment setup
    'paymentReminder',                       // configured channels cannot deliver reminders
    'citizenIdEncryption',                   // SESSION_SECRET rotation => unrecoverable PII
    'tenancyContract',                       // checkin blocked
  ]);
  for (const w of warnings) {
    if (!w.severity) w.severity = CRITICAL_FLAGS.has(w.flag) ? 'critical' : 'warning';
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

async function checkDataIntegrity(pool) {
  try {
    const countsQ = await pool.query(`
      SELECT
        COALESCE((
          SELECT COUNT(*)::int
            FROM app_data ad
            CROSS JOIN LATERAL jsonb_object_keys(
              CASE WHEN jsonb_typeof(ad.value)='object' THEN ad.value ELSE '{}'::jsonb END
            ) AS k(room_code)
           WHERE ad.key='baankarn_rooms_v1'
        ), 0)::int AS legacy_rooms,
        (SELECT COUNT(*)::int FROM rooms_v2 WHERE deleted_at IS NULL) AS rooms_v2,
        (SELECT COUNT(*)::int FROM bills
          WHERE deleted_at IS NULL
            AND status IN ('pending','overdue')
            AND tenant_id IS NULL) AS orphan_payable_bills,
        (SELECT COUNT(*)::int FROM payments p
          JOIN bills b ON b.id=p.bill_id
          WHERE p.status='verified'
            AND b.deleted_at IS NULL
            AND (b.status <> 'paid' OR b.paid_at IS NULL)) AS verified_payment_unpaid_bills,
        -- Tolerance matches the ±1฿ accepted by /api/tenant/payments,
        -- /api/payments/:id/verify, and /api/bills/:id/pay. A tighter
        -- value here would flag rounding-difference rows that the payment
        -- endpoints already accept as valid → false-positive dashboard noise.
        (SELECT COUNT(*)::int FROM payments p
          JOIN bills b ON b.id=p.bill_id
          WHERE p.status IN ('pending','verified')
            AND b.deleted_at IS NULL
            AND ABS(p.amount - b.total) > 1.0) AS payment_amount_mismatch,
        (SELECT COUNT(*)::int FROM (
          SELECT bill_id
            FROM payments
           WHERE bill_id IS NOT NULL AND status='verified'
           GROUP BY bill_id
          HAVING COUNT(*) > 1
        ) d) AS duplicate_verified_payments_per_bill,
        (SELECT COUNT(*)::int FROM bills
          WHERE deleted_at IS NULL
            AND (status NOT IN ('pending','paid','overdue','void')
                 OR total <= 0 OR subtotal < 0)) AS invalid_bill_rows,
        -- R2-followup — invariant: total = subtotal + vat + late_fee.
        -- scheduler.tickLateFee updates late_fee + total atomically; this
        -- check catches any path that drifts the trio (manual SQL fix,
        -- partial migration, future refactor that forgets to keep them in
        -- sync). Tolerance 0.02 absorbs the worst case of two-direction
        -- round2() drift on the three components.
        (SELECT COUNT(*)::int FROM bills
          WHERE deleted_at IS NULL
            AND ABS(total - (COALESCE(subtotal,0) + COALESCE(vat,0) + COALESCE(late_fee,0))) > 0.02
        ) AS bills_with_total_breakdown_mismatch,
        (SELECT COUNT(*)::int FROM payments
          WHERE status NOT IN ('pending','verified','rejected')
             OR amount <= 0) AS invalid_payment_rows,
        -- Slips waiting in the admin queue past 12h. The scheduler's
        -- pending-slip alert escalates per slip; this count puts the same
        -- signal on /admin#health so an operator landing there sees the
        -- backlog without waiting for the next LINE message.
        (SELECT COUNT(*)::int FROM payments
          WHERE status='pending'
            AND created_at <= NOW() - INTERVAL '12 hours') AS aged_pending_slips,
        (SELECT COUNT(*)::int FROM tenants t
           JOIN rooms_v2 rv
             ON rv.room_code = t.current_room_id
            AND rv.deleted_at IS NULL
          WHERE t.deleted_at IS NULL
            AND t.status = 'active'
            AND t.current_room_id IS NOT NULL
            AND t.current_room_id <> ''
            AND rv.status NOT IN ('occupied','overdue')) AS active_tenant_room_status_mismatch,
        (SELECT COUNT(*)::int FROM tenants t
          WHERE t.deleted_at IS NULL
            AND t.status = 'active'
            AND (t.current_room_id IS NULL OR t.current_room_id = '')) AS active_tenants_without_room,
        (SELECT COUNT(*)::int FROM rooms_v2 rv
          WHERE rv.deleted_at IS NULL
            AND rv.status IN ('occupied','overdue')
            AND NOT EXISTS (
              SELECT 1 FROM tenants t
               WHERE t.deleted_at IS NULL
                 AND t.status = 'active'
                 AND t.current_room_id = rv.room_code
            )) AS busy_rooms_without_active_tenant,
        (SELECT COUNT(*)::int FROM rooms_v2 rv
          WHERE rv.deleted_at IS NULL
            AND rv.status = 'reserved'
            AND NOT EXISTS (
              SELECT 1 FROM tenants t
               WHERE t.deleted_at IS NULL
                 AND t.status = 'active'
                 AND t.current_room_id = rv.room_code
            )
            AND NOT EXISTS (
              SELECT 1 FROM bookings b
               WHERE b.room_id = rv.room_code
                 AND b.status IN ('pending','reviewing','approved')
            )
            AND NOT EXISTS (
              SELECT 1 FROM contracts c
               WHERE c.room_id = rv.room_code
                 AND c.deleted_at IS NULL
                 AND c.status = 'active'
                 AND c.locked_at IS NULL
            )) AS reserved_rooms_without_hold,
        -- Moved-out tenants whose contract is still flagged 'active'. Symptom:
        -- room shows occupied in /api/rooms, recurring charges keep billing,
        -- access cards still valid. Root cause: admin used PUT /api/tenants/:id
        -- to flip status without the checkout cascade. The PUT endpoint now
        -- blocks this path but pre-fix rows linger — surface them here so
        -- ops can reconcile (run the checkout endpoint with force=true or
        -- close the contract manually).
        (SELECT COUNT(*)::int FROM tenants t
           JOIN contracts c ON c.tenant_id = t.id
          WHERE t.deleted_at IS NULL
            AND t.status = 'moved_out'
            AND c.deleted_at IS NULL
            AND c.status = 'active') AS moved_out_with_active_contract,
        (SELECT COUNT(*)::int FROM contracts c
           JOIN tenants t ON t.id = c.tenant_id AND t.deleted_at IS NULL
          WHERE c.deleted_at IS NULL
            AND c.status = 'active'
            AND (
              NULLIF(BTRIM(COALESCE(t.address, '')), '') IS NULL
              OR NULLIF(BTRIM(COALESCE(t.emergency_contact_name, '')), '') IS NULL
              OR NULLIF(BTRIM(COALESCE(t.emergency_contact_phone, '')), '') IS NULL
              OR t.citizen_id_image_front_id IS NULL
              OR t.citizen_id_image_back_id IS NULL
            )) AS active_contract_identity_incomplete,
        (SELECT COUNT(*)::int FROM contracts
          WHERE deleted_at IS NULL
            AND locked_at IS NOT NULL
            AND terms_template_snapshot IS NULL) AS locked_contract_missing_terms_snapshot,
        (SELECT COUNT(*)::int FROM contract_invitations
          WHERE status='pending'
            AND expires_at IS NOT NULL
            AND expires_at <= NOW()) AS expired_pending_contract_invitations,
        (WITH blob_rooms AS (
           SELECT rec.key AS room_code, rec.val AS room
             FROM app_data ad
             CROSS JOIN LATERAL jsonb_each(ad.value) AS rec(key, val)
            WHERE ad.key='baankarn_rooms_v1'
              AND jsonb_typeof(ad.value) = 'object'
         ), contract_refs AS (
           SELECT c.id, c.monthly_rent::numeric AS monthly_rent,
                  COALESCE(
                    CASE WHEN (br.room->>'rent') ~ '^[0-9]+(\\.[0-9]+)?$' THEN (br.room->>'rent')::numeric END,
                    rv.rent_price::numeric,
                    0
                  ) AS reference_rent
             FROM contracts c
             LEFT JOIN rooms_v2 rv ON rv.room_code = c.room_id AND rv.deleted_at IS NULL
             LEFT JOIN blob_rooms br ON br.room_code = c.room_id
            WHERE c.deleted_at IS NULL
              AND c.status = 'active'
         )
         SELECT COUNT(*)::int FROM contract_refs
          WHERE monthly_rent > 0
            AND (
              monthly_rent < $1::numeric
              OR (reference_rent > 0 AND monthly_rent < reference_rent * $2::numeric)
            )
        ) AS active_contract_low_rent,
        (SELECT COUNT(*)::int FROM contracts
          WHERE deleted_at IS NULL
            AND status = 'active'
            AND signed_at IS NOT NULL
            AND locked_at IS NULL) AS signed_unlocked_contracts,
        (SELECT CASE WHEN EXISTS (
                  SELECT 1 FROM contract_templates
                   WHERE deleted_at IS NULL AND enabled = TRUE
                )
                AND NOT EXISTS (
                  SELECT 1 FROM contract_templates
                   WHERE deleted_at IS NULL AND enabled = TRUE AND is_default = TRUE
                )
                THEN 1 ELSE 0 END)::int AS missing_default_contract_template,
        -- Rooms whose legacy JSONB blob shows a tenant attached but no
        -- active tenant currently points at that room. This is the "ห้องยังขึ้นมีคน
        -- หลังย้ายออก" symptom — the rooms page reads from the blob so
        -- it lies until reconciled. Fix via
         -- POST /api/admin/rooms/:roomId/reconcile.
         (WITH blob_rooms AS (
           SELECT rec.key AS room_code, rec.val AS room
             FROM app_data ad
             CROSS JOIN LATERAL jsonb_each(ad.value) AS rec(key, val)
            WHERE ad.key='baankarn_rooms_v1'
              AND jsonb_typeof(ad.value) = 'object'
         )
         SELECT COUNT(*)::int FROM blob_rooms br
          WHERE br.room ? 'tenant'
            AND br.room->'tenant' IS NOT NULL
            AND br.room->'tenant' <> 'null'::jsonb
            AND br.room->'tenant' <> '{}'::jsonb
            AND NOT EXISTS (
              SELECT 1 FROM tenants t
               WHERE t.current_room_id = br.room_code
                 AND t.status = 'active'
                 AND t.deleted_at IS NULL
            )
        ) AS stranded_occupied_rooms,
        -- Rooms reserved by "contract:N" where N is no longer an active
        -- contract. Cause: a 'completed' booking was cancelled but the
        -- code didn't clear the contract: pointer, OR the contract was
        -- closed by some other path that left the blob untouched. The
        -- booking-cancel handler now cleans these inline, but pre-fix
        -- rooms linger — surface them here so ops can reconcile.
        (WITH blob_rooms AS (
           SELECT rec.key AS room_code, rec.val AS room
             FROM app_data ad
             CROSS JOIN LATERAL jsonb_each(ad.value) AS rec(key, val)
            WHERE ad.key='baankarn_rooms_v1'
              AND jsonb_typeof(ad.value) = 'object'
         )
         SELECT COUNT(*)::int FROM blob_rooms br
          WHERE br.room->>'status' = 'reserved'
            AND br.room->>'reservedBy' LIKE 'contract:%'
            AND NOT EXISTS (
              SELECT 1 FROM contracts c
               WHERE c.id = NULLIF(SUBSTRING(br.room->>'reservedBy' FROM 10), '')::bigint
                 AND c.status = 'active'
                 AND c.deleted_at IS NULL
            )
        ) AS rooms_reserved_by_ghost_contract`,
      [pricing.MIN_SENSIBLE_CONTRACT_RENT, pricing.CONTRACT_RENT_REFERENCE_RATIO]
    );
    const counts = countsQ.rows[0] || {};

    const dupRoomsQ = await pool.query(`
      SELECT current_room_id AS room_id, COUNT(*)::int AS tenants
        FROM tenants
       WHERE deleted_at IS NULL
         AND status='active'
         AND current_room_id IS NOT NULL
         AND current_room_id <> ''
       GROUP BY current_room_id
      HAVING COUNT(*) > 1
       ORDER BY tenants DESC, current_room_id ASC
       LIMIT 10`);

    const activeTenantRoomStatusQ = await pool.query(`
      SELECT t.id, t.full_name, t.current_room_id, rv.status AS room_status
        FROM tenants t
        JOIN rooms_v2 rv
          ON rv.room_code = t.current_room_id
         AND rv.deleted_at IS NULL
       WHERE t.deleted_at IS NULL
         AND t.status='active'
         AND t.current_room_id IS NOT NULL
         AND t.current_room_id <> ''
         AND rv.status NOT IN ('occupied','overdue')
       ORDER BY t.id ASC
       LIMIT 10`);

    const activeTenantsWithoutRoomQ = await pool.query(`
      SELECT id, full_name, phone, status
        FROM tenants
       WHERE deleted_at IS NULL
         AND status='active'
         AND (current_room_id IS NULL OR current_room_id='')
       ORDER BY id ASC
       LIMIT 10`);

    const busyRoomsWithoutTenantQ = await pool.query(`
      SELECT rv.room_code, rv.status
        FROM rooms_v2 rv
       WHERE rv.deleted_at IS NULL
         AND rv.status IN ('occupied','overdue')
         AND NOT EXISTS (
           SELECT 1 FROM tenants t
            WHERE t.deleted_at IS NULL
              AND t.status='active'
              AND t.current_room_id=rv.room_code
         )
       ORDER BY rv.room_code ASC
       LIMIT 10`);

    const reservedRoomsWithoutHoldQ = await pool.query(`
      SELECT rv.room_code, rv.status
        FROM rooms_v2 rv
       WHERE rv.deleted_at IS NULL
         AND rv.status='reserved'
         AND NOT EXISTS (
           SELECT 1 FROM tenants t
            WHERE t.deleted_at IS NULL
              AND t.status='active'
              AND t.current_room_id=rv.room_code
         )
         AND NOT EXISTS (
           SELECT 1 FROM bookings b
            WHERE b.room_id=rv.room_code
              AND b.status IN ('pending','reviewing','approved')
         )
         AND NOT EXISTS (
           SELECT 1 FROM contracts c
            WHERE c.room_id=rv.room_code
              AND c.deleted_at IS NULL
              AND c.status='active'
              AND c.locked_at IS NULL
         )
       ORDER BY rv.room_code ASC
       LIMIT 10`);

    const missingRoomsQ = await pool.query(`
      WITH blob AS (
        SELECT COALESCE((
          SELECT value FROM app_data WHERE key='baankarn_rooms_v1' LIMIT 1
        ), '{}'::jsonb) AS rooms
      )
      SELECT t.id, t.full_name, t.current_room_id
        FROM tenants t
        CROSS JOIN blob
        LEFT JOIN rooms_v2 rv
          ON rv.room_code=t.current_room_id AND rv.deleted_at IS NULL
       WHERE t.deleted_at IS NULL
         AND t.status='active'
         AND t.current_room_id IS NOT NULL
         AND t.current_room_id <> ''
         AND rv.room_code IS NULL
         AND NOT (blob.rooms ? t.current_room_id)
       ORDER BY t.id ASC
       LIMIT 10`);

    const orphanBillsQ = await pool.query(`
      SELECT id, bill_no, room_id, total, status
        FROM bills
       WHERE deleted_at IS NULL
         AND status IN ('pending','overdue')
         AND tenant_id IS NULL
       ORDER BY due_date ASC, id ASC
       LIMIT 10`);

    const activeContractLowRentQ = await pool.query(`
      WITH blob_rooms AS (
        SELECT rec.key AS room_code, rec.val AS room
          FROM app_data ad
          CROSS JOIN LATERAL jsonb_each(ad.value) AS rec(key, val)
         WHERE ad.key='baankarn_rooms_v1'
           AND jsonb_typeof(ad.value) = 'object'
      ), contract_refs AS (
        SELECT c.id, c.contract_no, c.room_id, c.tenant_id,
               c.monthly_rent::numeric AS monthly_rent,
               COALESCE(
                 CASE WHEN (br.room->>'rent') ~ '^[0-9]+(\\.[0-9]+)?$' THEN (br.room->>'rent')::numeric END,
                 rv.rent_price::numeric,
                 0
               ) AS reference_rent
          FROM contracts c
          LEFT JOIN rooms_v2 rv ON rv.room_code = c.room_id AND rv.deleted_at IS NULL
          LEFT JOIN blob_rooms br ON br.room_code = c.room_id
         WHERE c.deleted_at IS NULL
           AND c.status = 'active'
      )
      SELECT *
        FROM contract_refs
       WHERE monthly_rent > 0
         AND (
           monthly_rent < $1::numeric
           OR (reference_rent > 0 AND monthly_rent < reference_rent * $2::numeric)
         )
       ORDER BY id ASC
       LIMIT 10`,
      [pricing.MIN_SENSIBLE_CONTRACT_RENT, pricing.CONTRACT_RENT_REFERENCE_RATIO]
    );

    const signedUnlockedContractsQ = await pool.query(`
      SELECT id, contract_no, room_id, tenant_id, signed_at
        FROM contracts
       WHERE deleted_at IS NULL
         AND status='active'
         AND signed_at IS NOT NULL
         AND locked_at IS NULL
       ORDER BY signed_at ASC
       LIMIT 10`);

    const detail = {
      counts: {
        legacy_rooms: Number(counts.legacy_rooms) || 0,
        rooms_v2: Number(counts.rooms_v2) || 0,
        orphan_payable_bills: Number(counts.orphan_payable_bills) || 0,
        verified_payment_unpaid_bills: Number(counts.verified_payment_unpaid_bills) || 0,
        payment_amount_mismatch: Number(counts.payment_amount_mismatch) || 0,
        duplicate_verified_payments_per_bill: Number(counts.duplicate_verified_payments_per_bill) || 0,
        invalid_bill_rows: Number(counts.invalid_bill_rows) || 0,
        // R2-followup — invariant total = subtotal + vat + late_fee.
        bills_with_total_breakdown_mismatch: Number(counts.bills_with_total_breakdown_mismatch) || 0,
        invalid_payment_rows: Number(counts.invalid_payment_rows) || 0,
        aged_pending_slips: Number(counts.aged_pending_slips) || 0,
        active_tenant_room_status_mismatch: Number(counts.active_tenant_room_status_mismatch) || 0,
        active_tenants_without_room: Number(counts.active_tenants_without_room) || 0,
        busy_rooms_without_active_tenant: Number(counts.busy_rooms_without_active_tenant) || 0,
        reserved_rooms_without_hold: Number(counts.reserved_rooms_without_hold) || 0,
        moved_out_with_active_contract: Number(counts.moved_out_with_active_contract) || 0,
        active_contract_identity_incomplete: Number(counts.active_contract_identity_incomplete) || 0,
        locked_contract_missing_terms_snapshot: Number(counts.locked_contract_missing_terms_snapshot) || 0,
        expired_pending_contract_invitations: Number(counts.expired_pending_contract_invitations) || 0,
        active_contract_low_rent: Number(counts.active_contract_low_rent) || 0,
        signed_unlocked_contracts: Number(counts.signed_unlocked_contracts) || 0,
        missing_default_contract_template: Number(counts.missing_default_contract_template) || 0,
        stranded_occupied_rooms: Number(counts.stranded_occupied_rooms) || 0,
        rooms_reserved_by_ghost_contract: Number(counts.rooms_reserved_by_ghost_contract) || 0,
      },
      duplicate_active_room_assignments: dupRoomsQ.rows,
      active_tenant_room_status_mismatch_samples: activeTenantRoomStatusQ.rows,
      active_tenants_without_room_samples: activeTenantsWithoutRoomQ.rows,
      busy_rooms_without_active_tenant_samples: busyRoomsWithoutTenantQ.rows,
      reserved_rooms_without_hold_samples: reservedRoomsWithoutHoldQ.rows,
      active_tenants_missing_room: missingRoomsQ.rows,
      orphan_payable_bill_samples: orphanBillsQ.rows,
      active_contract_low_rent_samples: activeContractLowRentQ.rows,
      signed_unlocked_contract_samples: signedUnlockedContractsQ.rows,
    };

    // Sample list of the orphaned contract pairs so admin can act directly
    // (the count alone makes it hard to find which tenants to fix). Limit
    // 10 so a runaway state doesn't blow up the response.
    try {
      const orphans = await pool.query(`
        SELECT t.id AS tenant_id, t.full_name, c.id AS contract_id, c.contract_no, c.room_id
          FROM tenants t
          JOIN contracts c ON c.tenant_id = t.id
         WHERE t.deleted_at IS NULL AND t.status='moved_out'
           AND c.deleted_at IS NULL AND c.status='active'
         ORDER BY c.id DESC
         LIMIT 10`);
      detail.moved_out_active_contract_samples = orphans.rows;
    } catch { /* tolerate older schemas */ }

    try {
      const contractRisks = await pool.query(`
        SELECT c.id AS contract_id, c.contract_no, c.room_id, c.locked_at,
               t.id AS tenant_id, t.full_name,
               ARRAY_REMOVE(ARRAY[
                 CASE WHEN NULLIF(BTRIM(COALESCE(t.address, '')), '') IS NULL THEN 'address' END,
                 CASE WHEN NULLIF(BTRIM(COALESCE(t.emergency_contact_name, '')), '') IS NULL THEN 'emergency_contact_name' END,
                 CASE WHEN NULLIF(BTRIM(COALESCE(t.emergency_contact_phone, '')), '') IS NULL THEN 'emergency_contact_phone' END,
                 CASE WHEN t.citizen_id_image_front_id IS NULL THEN 'citizen_id_image_front_id' END,
                 CASE WHEN t.citizen_id_image_back_id IS NULL THEN 'citizen_id_image_back_id' END
               ], NULL) AS missing
          FROM contracts c
          JOIN tenants t ON t.id = c.tenant_id AND t.deleted_at IS NULL
         WHERE c.deleted_at IS NULL
           AND c.status='active'
           AND (
             NULLIF(BTRIM(COALESCE(t.address, '')), '') IS NULL
             OR NULLIF(BTRIM(COALESCE(t.emergency_contact_name, '')), '') IS NULL
             OR NULLIF(BTRIM(COALESCE(t.emergency_contact_phone, '')), '') IS NULL
             OR t.citizen_id_image_front_id IS NULL
             OR t.citizen_id_image_back_id IS NULL
           )
         ORDER BY c.locked_at DESC NULLS LAST, c.id ASC
         LIMIT 10`);
      detail.active_contract_identity_incomplete_samples = contractRisks.rows;
    } catch { /* tolerate older schemas */ }

    try {
      const staleInvites = await pool.query(`
        SELECT id, contract_id, tenant_id, expires_at
          FROM contract_invitations
         WHERE status='pending'
           AND expires_at IS NOT NULL
           AND expires_at <= NOW()
         ORDER BY expires_at ASC
         LIMIT 10`);
      detail.expired_pending_contract_invitation_samples = staleInvites.rows;
    } catch { /* tolerate older schemas */ }

    const errors = [];
    const warnings = [];
    if (detail.counts.verified_payment_unpaid_bills > 0) {
      errors.push('verified payments exist while their bill is not marked paid');
    }
    if (detail.counts.payment_amount_mismatch > 0) {
      errors.push('pending/verified payment amount differs from bill total');
    }
    if (detail.counts.duplicate_verified_payments_per_bill > 0) {
      errors.push('more than one verified payment exists for the same bill');
    }
    if (detail.counts.invalid_bill_rows > 0) {
      errors.push('bill rows contain invalid statuses or non-positive/nonnegative amount fields');
    }
    if (detail.counts.bills_with_total_breakdown_mismatch > 0) {
      // R2-followup — total != subtotal + vat + late_fee indicates a row
      // touched outside the supported paths (manual SQL fix, broken
      // migration, future refactor forgetting to keep the trio in sync).
      // Surfaces in /admin#health so ops can locate + fix before the
      // discrepancy reaches a tenant's PDF.
      errors.push('bills have total inconsistent with subtotal + vat + late_fee breakdown');
    }
    if (detail.counts.invalid_payment_rows > 0) {
      errors.push('payment rows contain invalid statuses or non-positive amounts');
    }
    if (detail.counts.aged_pending_slips > 0) {
      // Warning, not error: the data is consistent — a human just hasn't
      // clicked verify yet. Tenants who already paid are waiting on it.
      warnings.push(
        `${detail.counts.aged_pending_slips} slip(s) waiting in the verify queue for over 12h - ` +
        `review at /admin#payments (tenants who paid are waiting for confirmation)`
      );
    }
    if (detail.counts.active_tenant_room_status_mismatch > 0) {
      errors.push('active tenants are assigned to rooms not marked occupied/overdue');
    }
    if (detail.counts.active_tenants_without_room > 0) {
      errors.push(
        `${detail.counts.active_tenants_without_room} active tenant(s) have no current_room_id - ` +
        `tenant portal, billing targeting, and room reconciliation cannot work until assigned or checked out`
      );
    }
    if (detail.counts.busy_rooms_without_active_tenant > 0) {
      errors.push('rooms are marked occupied/overdue without an active tenant');
    }
    if (dupRoomsQ.rows.length > 0) {
      errors.push('more than one active tenant assigned to the same room');
    }
    if (detail.counts.stranded_occupied_rooms > 0) {
      errors.push(
        `${detail.counts.stranded_occupied_rooms} room(s) show tenant data in the rooms blob but have no active current tenant - ` +
        `run POST /api/admin/rooms/:roomId/reconcile for each (admin UI shows a "Reconcile" button on the room card)`
      );
    }
    if (detail.counts.rooms_reserved_by_ghost_contract > 0) {
      // Warn rather than error — this is cosmetic-only (the room is just
      // wrongly flagged "reserved"; no money is lost), but it still blocks
      // the room from being re-rented because the rooms-page UI treats
      // reserved as unavailable.
      warnings.push(
        `${detail.counts.rooms_reserved_by_ghost_contract} room(s) are flagged 'reserved' by a contract that is no longer active — ` +
        `cancel-then-recreate-booking or call POST /api/admin/rooms/:roomId/reconcile`
      );
    }
    if (detail.counts.moved_out_with_active_contract > 0) {
      // Hard error — bills will keep auto-generating against a moved-out
      // tenant and the room shows occupied. Quote the count so the dashboard
      // tells admin exactly how many rows to reconcile.
      errors.push(
        `${detail.counts.moved_out_with_active_contract} moved_out tenant(s) still have an active contract — ` +
        `close via PUT /api/contracts/:id { status: 'ended' } or re-run /api/tenants/:id/checkout`
      );
    }
    if (detail.counts.locked_contract_missing_terms_snapshot > 0) {
      errors.push(
        `${detail.counts.locked_contract_missing_terms_snapshot} locked contract(s) are missing terms_template_snapshot — ` +
        `PDF terms may change after template edits; backfill the intended snapshot before relying on the PDF as immutable evidence`
      );
    }
    if (detail.counts.active_contract_low_rent > 0) {
      errors.push(
        `${detail.counts.active_contract_low_rent} active contract(s) have suspiciously low monthly_rent - ` +
        `future bills will inherit the bad contract amount unless the contract is corrected`
      );
    }
    if (detail.counts.signed_unlocked_contracts > 0) {
      warnings.push(
        `${detail.counts.signed_unlocked_contracts} active contract(s) are signed but not locked - ` +
        `approve/reject/expire the invitation so the legal snapshot and room state stop drifting`
      );
    }
    if (detail.counts.active_contract_identity_incomplete > 0) {
      warnings.push(
        `${detail.counts.active_contract_identity_incomplete} active contract(s) are missing address/emergency/ID image fields — ` +
        `new approvals are blocked until complete; legacy rows should be backfilled or explicitly accepted as legacy`
      );
    }
    if (detail.counts.expired_pending_contract_invitations > 0) {
      warnings.push(
        `${detail.counts.expired_pending_contract_invitations} pending contract invitation(s) already expired — ` +
        `admin list/API will flip stale pending links to expired and a fresh link should be issued if still needed`
      );
    }
    if (detail.counts.missing_default_contract_template > 0) {
      warnings.push(
        `contract_templates has enabled rows but no default template — ` +
        `unassigned contracts fall back to legacy/default terms until an owner sets a default`
      );
    }
    if (detail.counts.legacy_rooms > 0 && detail.counts.rooms_v2 === 0) {
      warnings.push('legacy rooms exist but rooms_v2 is empty; run scripts/sync-rooms-v2-from-jsonb.js --apply');
    }
    if (detail.counts.orphan_payable_bills > 0) {
      warnings.push('payable bills without tenant_id are blocked from tenant payments until reconciled');
    }
    if (detail.counts.reserved_rooms_without_hold > 0) {
      warnings.push('rooms are marked reserved without an active booking or draft contract hold');
    }
    if (missingRoomsQ.rows.length > 0) {
      warnings.push('active tenants reference rooms missing from both legacy JSONB and rooms_v2');
    }

    if (errors.length) return { status: 'error', message: `${errors.length} data integrity error(s)`, detail: { ...detail, errors, warnings } };
    if (warnings.length) return { status: 'warn', message: `${warnings.length} data integrity warning(s)`, detail: { ...detail, warnings } };
    return { status: 'ok', message: 'Core data relationships look consistent', detail };
  } catch (err) {
    return { status: 'warn', message: `Data integrity check skipped: ${err.message}` };
  }
}

// Probe BOTH PromptPay QR rendering engines (primary qrcode → PNG, backup
// qrcode-svg → SVG). The tenant endpoint falls through to SVG when PNG
// fails, so the system stays up as long as ONE engine works — but we still
// want to surface PARTIAL degradation (PNG broken, SVG working) as a
// warning so the operator notices the primary failing before SVG also
// breaks. Test against the bundled demo target with 1฿ — no real account
// touched and no network call.
async function checkPromptpayRender() {
  const promptpay = require('./promptpay');
  const results = { primary: null, fallback: null };
  // --- Primary: qrcode → PNG buffer
  try {
    const png = await promptpay.renderQrPng(promptpay.DEMO_TARGET, 1, { width: 64 });
    if (!Buffer.isBuffer(png) || png.length < 100) {
      results.primary = { ok: false, error: `empty/suspect buffer (${png?.length || 0} bytes)` };
    } else {
      results.primary = { ok: true, bytes: png.length };
    }
  } catch (err) {
    results.primary = { ok: false, error: err.message };
  }
  // --- Fallback: qrcode-svg → SVG string
  try {
    const svg = promptpay.renderQrSvg(promptpay.DEMO_TARGET, 1, { width: 64 });
    if (typeof svg !== 'string' || !svg.startsWith('<') || svg.length < 100) {
      results.fallback = { ok: false, error: `empty/suspect SVG (${svg?.length || 0} chars)` };
    } else {
      results.fallback = { ok: true, bytes: svg.length };
    }
  } catch (err) {
    results.fallback = { ok: false, error: err.message };
  }
  // --- Roll up to a single severity
  const both = results.primary?.ok && results.fallback?.ok;
  const either = results.primary?.ok || results.fallback?.ok;
  if (both) {
    return {
      status: 'ok',
      message: `QR renderers OK (PNG ${results.primary.bytes}b, SVG ${results.fallback.bytes}b)`,
      detail: results,
    };
  }
  if (!either) {
    // Both engines down — tenant /qr endpoint will 500 + payload text
    // fallback only. This is paging-worthy.
    return {
      status: 'error',
      message: `QR renderers BOTH broken — primary: ${results.primary?.error}; fallback: ${results.fallback?.error}`,
      detail: results,
    };
  }
  // One engine still works — system is up but degraded. Warn so the
  // operator fixes the primary before the fallback also dies.
  return {
    status: 'warn',
    message: results.primary?.ok
      ? `Primary QR renderer OK; fallback SVG broken: ${results.fallback?.error}`
      : `Primary QR renderer broken (${results.primary?.error}); SVG fallback still serves`,
    detail: results,
  };
}

// Detect drift between billing-time rent and what /admin#pricing would
// currently compute. After the pricing resolver lands, active bills
// SHOULD match either:
//   - the active contract's monthly_rent (locked at signing), or
//   - the room's rent_override, or
//   - computeFromFormula(room, config) with current config
//
// Any active room whose CURRENT formula differs from what's actually
// being billed signals one of:
//   - admin edited /admin#pricing without realising existing contracts
//     are grandfathered (expected behaviour, just surface it so admin
//     can decide whether to renegotiate)
//   - a contract row is missing monthly_rent (resolver fell back to
//     formula, then formula changed under it — backfill needed)
//   - the override on the room doesn't match the contract's rate (the
//     admin set both and they conflict — confusing, surface it)
//
// Returns 'ok' when no drift, 'warn' for small numbers, 'error' if
// >10 rooms drift (likely admin needs to act).
async function checkPricingDrift(pool) {
  try {
    const pricing = require('./pricing');
    const [roomsRow, configRow] = await Promise.all([
      pool.query(`SELECT value FROM app_data WHERE key='baankarn_rooms_v1' LIMIT 1`),
      pool.query(`SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`),
    ]);
    const rooms = (roomsRow.rows[0]?.value && typeof roomsRow.rows[0].value === 'object')
      ? roomsRow.rows[0].value : {};
    const config = configRow.rows[0]?.value || {};

    const occupiedRoomIds = Object.values(rooms)
      .filter((r) => r && r.tenant && (r.status === 'occupied' || r.status === 'overdue'))
      .map((r) => r.id);
    if (occupiedRoomIds.length === 0) {
      return { status: 'ok', message: 'No occupied rooms to check' };
    }
    const { rows: contracts } = await pool.query(
      `SELECT room_id, monthly_rent
         FROM contracts
        WHERE status='active'
          AND deleted_at IS NULL
          AND room_id = ANY($1)`,
      [occupiedRoomIds]
    );
    const contractByRoom = new Map(contracts.map((c) => [c.room_id, c]));

    const drift = [];
    const missingContractRate = [];
    for (const room of Object.values(rooms)) {
      if (!room || !room.tenant) continue;
      if (room.status !== 'occupied' && room.status !== 'overdue') continue;
      const contract = contractByRoom.get(room.id);
      const formula = pricing.computeFromFormula(room, config);
      const billing = pricing.resolveBillingRent({ room, contract, config });
      // Contract exists but rent is 0/null → resolver falls through to
      // formula and admin's intent is fuzzy. Flag for backfill.
      if (contract && (!contract.monthly_rent || Number(contract.monthly_rent) <= 0)) {
        missingContractRate.push({ roomId: room.id });
        continue;
      }
      // Compare what billing WILL charge vs what /admin#pricing CURRENTLY
      // shows for this room. Diff >50฿ is noise (rounding, premium edge);
      // >0 means admin's price isn't applied to this tenant.
      if (formula > 0 && Math.abs(billing.rent - formula) > 50) {
        drift.push({
          roomId: room.id,
          billingRent: billing.rent,
          formulaRent: formula,
          source: billing.source,
        });
      }
    }

    if (drift.length === 0 && missingContractRate.length === 0) {
      return {
        status: 'ok',
        message: `${occupiedRoomIds.length} occupied rooms — pricing in sync`,
      };
    }
    const issues = [];
    if (missingContractRate.length) {
      issues.push(`${missingContractRate.length} contracts missing monthly_rent (run scripts/backfill-contract-rents.js)`);
    }
    if (drift.length) {
      const sample = drift.slice(0, 5).map((d) =>
        `${d.roomId}: ฿${d.billingRent} (${d.source}) vs formula ฿${d.formulaRent}`
      ).join('; ');
      issues.push(`${drift.length} rooms drift between billing rate and current formula: ${sample}${drift.length > 5 ? '…' : ''}`);
    }
    // Drift is INFORMATIONAL (contracts are supposed to be locked), but
    // ≥10 rooms suggests admin made a big change and might want to either
    // renegotiate or knowingly grandfather everyone.
    const total = drift.length + missingContractRate.length;
    return {
      status: total >= 10 || missingContractRate.length > 0 ? 'warn' : 'ok',
      message: issues.join(' · '),
      detail: { drift: drift.slice(0, 20), missingContractRate: missingContractRate.slice(0, 20) },
    };
  } catch (err) {
    return { status: 'warn', message: `pricing drift check failed: ${err.message}` };
  }
}

// Surface obviously-broken config values (rent=1, utility=0 etc.) before
// admin discovers them via mis-priced bills. Companion to the PUT-time
// validation in server.js — that one BLOCKS new bad writes, this probe
// CATCHES existing bad data sitting in DB from before validation landed.
async function checkConfigSanity(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
    );
    if (!rows.length) {
      return { status: 'warn', message: 'baankarn_config_v1 not in app_data — admin has not configured pricing yet' };
    }
    const cfg = rows[0].value || {};
    const issues = [];
    const MIN_RENT = pricing.MIN_SENSIBLE_RENT;
    const rates = cfg.rates || {};
    for (const [type, r] of Object.entries(rates)) {
      if (!r || typeof r !== 'object') continue;
      const rent = Number(r.rent);
      if (Number.isFinite(rent) && rent > 0 && rent < MIN_RENT) {
        issues.push(`rates.${type}.rent=${rent} (น่าจะพิมพ์ผิด — ค่าเช่าจริงควร ≥ ${MIN_RENT}฿)`);
      }
    }
    const u = cfg.utilities || {};
    if (Number(u.waterRate) === 0 || u.waterRate == null) issues.push('utilities.waterRate ไม่ได้ตั้ง — บิลค่าน้ำจะเป็น 0');
    if (Number(u.elecRate)  === 0 || u.elecRate  == null) issues.push('utilities.elecRate ไม่ได้ตั้ง — บิลค่าไฟจะเป็น 0');
    if (issues.length === 0) {
      return { status: 'ok', message: 'pricing config sane' };
    }
    // Warn (not error) — the resolver's contract-lock still protects
    // existing tenants. New contracts / vacant rooms ARE at risk though,
    // so admin should see this in /admin#health and fix.
    return {
      status: 'warn',
      message: `${issues.length} suspicious config value(s): ${issues.join('; ')}`,
      detail: { issues },
    };
  } catch (err) {
    return { status: 'warn', message: `config sanity check failed: ${err.message}` };
  }
}

async function checkPoolStats(pool) {
  try {
    // Standard pg.Pool exposes totalCount/idleCount/waitingCount. If a
    // wrapper or different driver is in use these may be missing — flag
    // as 'warn' (not 'ok') so operators notice the metrics are blind
    // before pool contention surfaces as user-facing 500s with no signal.
    const hasMetrics = pool.totalCount != null && pool.idleCount != null && pool.waitingCount != null;
    if (!hasMetrics) {
      return {
        status: 'warn',
        message: 'Pool stats unavailable — pg.Pool counters missing (custom wrapper?)',
        detail: {
          totalCount: pool.totalCount ?? null,
          idleCount: pool.idleCount ?? null,
          waitingCount: pool.waitingCount ?? null,
        },
      };
    }
    const total = pool.totalCount;
    const idle  = pool.idleCount;
    const waiting = pool.waitingCount;
    if (waiting > 5) return { status: 'error', message: `${waiting} queries waiting on a free connection`, detail: { total, idle, waiting } };
    if (waiting > 0) return { status: 'warn',  message: `${waiting} queries waiting`, detail: { total, idle, waiting } };
    return { status: 'ok', message: `Pool ${idle}/${total} idle`, detail: { total, idle, waiting } };
  } catch (err) {
    return { status: 'warn', message: `Pool stats threw: ${err.message}` };
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
  { id: 'upload_storage',      label: 'Upload storage guard',  fn: (p) => checkUploadStorage(p) },
  { id: 'queue',               label: 'Notification queue',    fn: (p) => checkNotificationQueue(p) },
  { id: 'failed_logins',       label: 'Failed logins (15min)', fn: (p) => checkRecentFailedLogins(p) },
  { id: 'lockouts',            label: 'Active lockouts',       fn: (p) => checkActiveLockouts(p) },
  { id: 'scheduler',           label: 'Scheduler heartbeat',   fn: () => checkSchedulerHeartbeat() },
  { id: 'config',              label: 'Boot configuration',    fn: () => checkBootConfig() },
  { id: 'feature_deps',        label: 'Feature dependencies',  fn: (p, f) => checkFeatureDependencies(f, p) },
  { id: 'data_integrity',       label: 'Data integrity',        fn: (p) => checkDataIntegrity(p) },
  { id: 'pricing_drift',       label: 'Pricing drift',         fn: (p) => checkPricingDrift(p) },
  { id: 'config_sanity',       label: 'Pricing config sanity', fn: (p) => checkConfigSanity(p) },
  { id: 'qr_renderer',         label: 'PromptPay QR renderer', fn: () => checkPromptpayRender() },
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
  const runOne = async (c) => {
    const start = Date.now();
    let res;
    try {
      res = await c.fn(pool, flags);
    } catch (err) {
      res = { status: 'error', message: err.message };
    }
    if (!res || typeof res !== 'object') res = { status: 'warn', message: 'check returned no result' };
    // Fail safe: an unknown/missing status must NOT be scored green. Defaulting
    // a statusless result to 'ok' silently false-greens the badge and suppresses
    // alerting precisely when a probe is misbehaving. Only the three known rungs
    // pass through; anything else degrades to 'warn'.
    const status = ['ok', 'warn', 'error'].includes(res.status) ? res.status : 'warn';
    return {
      id: c.id,
      label: c.label,
      status,
      message: res.message || '',
      detail: res.detail || null,
      durationMs: Date.now() - start,
    };
  };

  // Measure pool contention before this health probe fans out DB queries;
  // otherwise the probe can warn about the queue it created itself.
  const poolCheck = CHECKS.find((c) => c.id === 'pool');
  const poolResult = poolCheck ? await runOne(poolCheck) : null;
  const parallelResults = await Promise.all(
    CHECKS.filter((c) => c.id !== 'pool').map(runOne)
  );
  const byId = new Map(parallelResults.map((r) => [r.id, r]));
  if (poolResult) byId.set('pool', poolResult);
  const results = CHECKS.map((c) => byId.get(c.id)).filter(Boolean);
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

module.exports = { runChecks, CHECKS, checkUploadStorage, checkFeatureDependencies };
