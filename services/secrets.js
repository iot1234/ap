// services/secrets.js
// Configurable secret store backed by the `secrets` table. Values are
// encrypted at rest with AES-256-GCM (services/encryption.js).
//
// Access pattern:
//   1. process.env.<KEY>     — env always wins (lets ops override per-deploy)
//   2. in-memory cache       — populated by preload(pool) at boot
//   3. (cache miss → undefined; callers should treat this as "not configured")
//
// All consumers (line.js, email.js, sentry.js, backup.js) call get(key)
// synchronously after preload, so changes via the admin UI propagate
// instantly because set() updates the cache before resolving.
//
// What we DON'T store here:
//   - DATABASE_URL — must stay in env (we need it before any DB call works)
//   - SESSION_SECRET — same reason; cookies are signed before any DB I/O
//   - ENCRYPTION_KEY_V* — chicken-and-egg; needed to decrypt this very table
//   - CITIZEN_ID_KEY (legacy alias) — same

const encryption = require('./encryption');

// Catalog of every key the admin UI knows about. Keep this list aligned
// with the page-secrets.jsx field groups so adding a key is a one-line
// change in two places. `description` shows up in the admin form.
const CATALOG = Object.freeze([
  // --- LINE Messaging API ----------------------------------------------
  { key: 'LINE_CHANNEL_ACCESS_TOKEN', group: 'line', label: 'Channel Access Token',
    description: 'Long-lived token จาก LINE Developers Console', kind: 'password' },
  { key: 'LINE_CHANNEL_SECRET', group: 'line', label: 'Channel Secret',
    description: 'ใช้ตรวจ HMAC ของ webhook', kind: 'password' },
  { key: 'LINE_OWNER_USER_ID', group: 'line', label: 'Owner User ID',
    description: 'ผู้รับ system notifications (ขึ้นต้นด้วย U)', kind: 'text' },

  // --- SMTP (email channel) --------------------------------------------
  { key: 'SMTP_HOST', group: 'smtp', label: 'SMTP Host', description: 'เช่น smtp.gmail.com', kind: 'text' },
  { key: 'SMTP_PORT', group: 'smtp', label: 'SMTP Port', description: 'ปกติ 587 (TLS) หรือ 465 (SSL)', kind: 'number', default: '587' },
  { key: 'SMTP_USER', group: 'smtp', label: 'SMTP User', description: 'อีเมลที่ใช้ login', kind: 'text' },
  { key: 'SMTP_PASS', group: 'smtp', label: 'SMTP Password', description: 'หรือ App Password ของ Gmail', kind: 'password' },
  { key: 'SMTP_FROM', group: 'smtp', label: 'From Address', description: 'อีเมลผู้ส่งที่จะแสดง', kind: 'text' },
  { key: 'OWNER_EMAIL', group: 'smtp', label: 'Owner Email (fallback)', description: 'รับ system notifications เมื่อ LINE ส่งไม่ได้', kind: 'text' },

  // --- PromptPay --------------------------------------------------------
  { key: 'PROMPTPAY_TARGET', group: 'promptpay', label: 'Target',
    description: 'เบอร์โทร 10 หลัก หรือ เลขบัตร ปชช. 13 หลัก', kind: 'text' },

  // --- Sentry (error tracking) -----------------------------------------
  { key: 'SENTRY_DSN', group: 'sentry', label: 'Sentry DSN',
    description: 'จาก Sentry → Project Settings → Client Keys', kind: 'password' },

  // --- R2 / S3-compatible backup target --------------------------------
  { key: 'R2_ACCESS_KEY_ID', group: 'r2', label: 'Access Key ID', kind: 'text' },
  { key: 'R2_SECRET_ACCESS_KEY', group: 'r2', label: 'Secret Access Key', kind: 'password' },
  { key: 'R2_ENDPOINT', group: 'r2', label: 'Endpoint',
    description: 'เช่น https://<account>.r2.cloudflarestorage.com', kind: 'text' },
  { key: 'R2_BUCKET', group: 'r2', label: 'Bucket Name', kind: 'text' },
  { key: 'R2_REGION', group: 'r2', label: 'Region', kind: 'text', default: 'auto' },
]);
const CATALOG_BY_KEY = Object.fromEntries(CATALOG.map((c) => [c.key, c]));

// In-memory cache of decrypted values. Populated by preload(); kept in
// sync by set(). Reads are synchronous so the existing line.js/email.js
// callers don't have to become async.
const _cache = new Map();
let _loaded = false;

/**
 * Load every secret from the DB into memory. Call once at boot.
 */
async function preload(pool) {
  try {
    const { rows } = await pool.query('SELECT key, value_encrypted FROM secrets');
    for (const row of rows) {
      try {
        const v = encryption.decryptString(row.value_encrypted);
        if (v != null) _cache.set(row.key, v);
      } catch (err) {
        console.warn(`[secrets] decrypt failed for ${row.key}:`, err.message);
      }
    }
    _loaded = true;
    console.log(`[secrets] loaded ${rows.length} secret(s) from DB`);
  } catch (err) {
    // Table missing or DB down: don't crash boot — env vars still work.
    console.warn('[secrets] preload skipped:', err.message);
  }
}

/**
 * Synchronously read a secret. Env wins over DB so ops can pin a value
 * via Railway Variables when they need to override the UI's setting.
 */
function get(key) {
  if (key in process.env && process.env[key] !== '') return process.env[key];
  return _cache.get(key);
}

/**
 * Set or clear a secret. Pass null/undefined to delete.
 */
async function set(pool, key, value, updatedBy) {
  if (!CATALOG_BY_KEY[key]) {
    throw new Error(`unknown secret key: ${key}`);
  }
  if (value == null || value === '') {
    await pool.query('DELETE FROM secrets WHERE key=$1', [key]);
    _cache.delete(key);
    return { key, deleted: true };
  }
  const enc = encryption.encryptString(String(value));
  const desc = CATALOG_BY_KEY[key].description || null;
  await pool.query(
    `INSERT INTO secrets (key, value_encrypted, description, updated_by)
       VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE SET
       value_encrypted = EXCLUDED.value_encrypted,
       description = COALESCE(EXCLUDED.description, secrets.description),
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [key, enc, desc, updatedBy || 'system']
  );
  _cache.set(key, String(value));
  return { key, set: true };
}

/**
 * Returns metadata about every catalog key (no values). For each key we
 * report: source (env|db|null), isSet, masked tail for visual confirm.
 * Used by the admin UI's secrets page.
 */
async function listMetadata(pool) {
  // Always re-read DB so the page shows fresh state after another admin
  // edits a value in another tab.
  const dbRows = new Set();
  try {
    const { rows } = await pool.query('SELECT key FROM secrets');
    for (const r of rows) dbRows.add(r.key);
  } catch { /* ignore */ }

  return CATALOG.map((c) => {
    const env = process.env[c.key];
    const inEnv = env !== undefined && env !== '';
    const inDb = dbRows.has(c.key);
    const value = inEnv ? env : (_cache.has(c.key) ? _cache.get(c.key) : null);
    return {
      key: c.key,
      group: c.group,
      label: c.label,
      description: c.description || null,
      kind: c.kind,
      default: c.default || null,
      source: inEnv ? 'env' : (inDb ? 'db' : null),
      isSet: !!value,
      maskedTail: value ? maskValue(value, c.kind) : null,
      // env-managed keys can't be cleared via the UI (would have no effect)
      readOnly: inEnv,
    };
  });
}

function maskValue(v, kind) {
  if (!v) return null;
  if (kind === 'number') return String(v);
  const s = String(v);
  if (s.length <= 4) return '••••';
  return '••••' + s.slice(-4);
}

/**
 * Actively probe whether a secret group is reachable. Used by the UI's
 * "Test connection" button so admins know their config works without
 * needing to wait for a real notification to fire.
 */
async function testGroup(group) {
  if (group === 'line') {
    const tok = get('LINE_CHANNEL_ACCESS_TOKEN');
    const owner = get('LINE_OWNER_USER_ID');
    if (!tok) return { ok: false, error: 'LINE_CHANNEL_ACCESS_TOKEN ไม่ได้ตั้ง' };
    // Lightweight: hit /v2/bot/info which validates the token without
    // sending a message.
    return new Promise((resolve) => {
      const https = require('https');
      const req = https.request({
        hostname: 'api.line.me', path: '/v2/bot/info', method: 'GET',
        headers: { Authorization: `Bearer ${tok}` }, timeout: 5000,
      }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const j = JSON.parse(buf);
              resolve({ ok: true, info: { displayName: j.displayName, basicId: j.basicId } });
            } catch { resolve({ ok: true }); }
          } else {
            resolve({ ok: false, error: `HTTP ${res.statusCode}: ${buf.slice(0, 200)}` });
          }
        });
      });
      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
      req.end();
    });
  }
  if (group === 'smtp') {
    const host = get('SMTP_HOST'), user = get('SMTP_USER'), pass = get('SMTP_PASS');
    if (!host || !user || !pass) return { ok: false, error: 'SMTP host/user/pass ยังไม่ครบ' };
    try {
      const nm = require('nodemailer');
      const t = nm.createTransport({
        host, port: Number(get('SMTP_PORT') || 587), secure: Number(get('SMTP_PORT')) === 465,
        auth: { user, pass },
      });
      await t.verify();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  if (group === 'r2') {
    const id = get('R2_ACCESS_KEY_ID'), sec = get('R2_SECRET_ACCESS_KEY');
    const ep = get('R2_ENDPOINT'), bucket = get('R2_BUCKET');
    if (!id || !sec || !ep || !bucket) {
      return { ok: false, error: 'R2 credentials/endpoint/bucket ยังไม่ครบ' };
    }
    let lib;
    try { lib = require('@aws-sdk/client-s3'); }
    catch { return { ok: false, error: '@aws-sdk/client-s3 ไม่ได้ติดตั้ง — `npm i @aws-sdk/client-s3`' }; }
    try {
      const client = new lib.S3Client({
        region: get('R2_REGION') || 'auto',
        endpoint: ep, forcePathStyle: true,
        credentials: { accessKeyId: id, secretAccessKey: sec },
      });
      // HeadBucket validates credentials + bucket existence cheaply.
      await client.send(new lib.HeadBucketCommand({ Bucket: bucket }));
      return { ok: true, bucket };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  return { ok: false, error: 'unknown group' };
}

module.exports = { preload, get, set, listMetadata, testGroup, CATALOG, CATALOG_BY_KEY, maskValue };
