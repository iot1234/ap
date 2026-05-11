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

  // --- Slip auto-verify ------------------------------------------------
  // SlipOK (https://slipok.com/) — Thai aggregator that decodes the slip
  // QR + queries the bank API to confirm the transaction is real. Most
  // common choice for Thai dorm operators.
  { key: 'SLIPOK_API_KEY', group: 'slipverify', label: 'SlipOK API Key',
    description: 'จาก slipok.com → API → x-authorization', kind: 'password' },
  { key: 'SLIPOK_BRANCH_ID', group: 'slipverify', label: 'SlipOK Branch ID',
    description: 'จำเป็นเฉพาะแผนที่มีหลาย branch (เว้นว่างได้สำหรับแผน single-branch)',
    kind: 'text' },
  // EasySlip (https://easyslip.com/) — alternative aggregator with
  // different pricing model. Providers can be chained in features.slipUpload.providers.
  { key: 'EASYSLIP_API_KEY', group: 'slipverify', label: 'EasySlip API Key',
    description: 'จาก EasySlip API → ใช้แทน SlipOK ก็ได้ (เลือก provider ที่หน้า Features)',
    kind: 'password' },
  { key: 'SLIP2GO_API_KEY', group: 'slipverify', label: 'Slip2Go API Secret',
    description: 'Secret Key จาก Slip2Go API Connect → ใช้กับ Authorization: Bearer',
    kind: 'password' },
  { key: 'SLIP2GO_API_URL', group: 'slipverify', label: 'Slip2Go API URL',
    description: 'Base URL จากหน้า Slip2Go API Connect เช่น https://... (ไม่ต้องใส่ /api/verify-slip)',
    kind: 'text' },
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
 *
 * We trim whitespace + strip control chars on read too — operators who
 * pasted a token with a trailing newline before the input-time validation
 * shipped would otherwise stay broken until they re-saved manually.
 */
function get(key) {
  let v;
  if (key in process.env && process.env[key] !== '') {
    v = process.env[key];
  } else {
    v = _cache.get(key);
  }
  if (typeof v !== 'string') return v;
  // Trim + strip CR/LF/tab + DEL/control chars. Keep printable ASCII +
  // anything ≥ 0x20 (covers all valid LINE/SMTP/R2 token characters).
  return v.trim().replace(/[\x00-\x1F\x7F]/g, '');
}

/**
 * Set or clear a secret. Pass null/undefined to delete.
 */
async function set(pool, key, value, updatedBy) {
  if (!CATALOG_BY_KEY[key]) {
    throw new Error(`unknown secret key: ${key}`);
  }
  // Sanitise: strip surrounding whitespace + reject embedded control chars
  // (CR/LF/tab/non-printable). Operators frequently paste tokens with a
  // trailing newline from the LINE/SMTP UI, and that single \n inside the
  // saved token then breaks every outbound request — Node's http module
  // refuses to put a header line containing CR/LF into the wire ("Invalid
  // character in header content"). Catch it at write time so the value
  // never makes it to the DB in a broken state.
  let cleaned = value;
  if (cleaned != null && cleaned !== '') {
    cleaned = String(cleaned).trim();
    if (/[\r\n\t]/.test(cleaned)) {
      throw new Error('ค่าห้ามมีขึ้นบรรทัดใหม่หรือ tab — copy-paste ใหม่โดยไม่ติดบรรทัดใหม่');
    }
    if (/[\x00-\x1F\x7F]/.test(cleaned)) {
      throw new Error('ค่ามีอักขระที่ใช้ใน HTTP header ไม่ได้ — โปรดตรวจสอบ');
    }
    if (cleaned.length === 0) {
      // Was all-whitespace; treat as delete.
      cleaned = '';
    }
  }
  if (cleaned == null || cleaned === '') {
    await pool.query('DELETE FROM secrets WHERE key=$1', [key]);
    _cache.delete(key);
    return { key, deleted: true };
  }
  const enc = encryption.encryptString(cleaned);
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
  _cache.set(key, cleaned);
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

function isHttpUrl(value) {
  try {
    const raw = String(value || '').trim();
    if (!raw) return false;
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Actively probe whether a secret group is reachable. Used by the UI's
 * "Test connection" button so admins know their config works without
 * needing to wait for a real notification to fire.
 */
async function testGroup(group) {
  if (group === 'line') {
    const tok = get('LINE_CHANNEL_ACCESS_TOKEN');
    if (!tok) return { ok: false, error: 'LINE_CHANNEL_ACCESS_TOKEN ไม่ได้ตั้ง' };
    // Defence-in-depth: secrets.get() already strips ASCII control chars,
    // but a non-ASCII char or unicode whitespace would still trip Node's
    // http header validator with a synchronous throw. Pre-flight here
    // returns a clean Thai-language error instead of a 500.
    if (/[^\x20-\x7E]/.test(tok)) {
      return { ok: false, error: 'access token มีอักขระที่ไม่ใช่ ASCII printable — โปรดวางใหม่' };
    }
    // Lightweight: hit /v2/bot/info which validates the token without
    // sending a message.
    return new Promise((resolve) => {
      const https = require('https');
      let req;
      try {
        req = https.request({
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
      } catch (err) {
        // https.request throws synchronously on illegal header content.
        // Without this catch the error escapes the Promise and lands as a
        // 500 with no Thai context for the operator.
        resolve({ ok: false, error: 'header invalid: ' + err.message });
        return;
      }
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
  if (group === 'slipverify') {
    // Report per-provider readiness so the UI can show each one's state
    // independently. We deliberately don't submit a real slip image (would
    // burn provider credit + we have no test slip) — readiness here means
    // "key is set and the right shape". The actual end-to-end probe happens
    // on the first real tenant upload.
    const slipokKey = get('SLIPOK_API_KEY');
    const easyslipKey = get('EASYSLIP_API_KEY');
    const slip2goKey = get('SLIP2GO_API_KEY');
    const slip2goUrl = get('SLIP2GO_API_URL');
    const slip2goUrlOk = isHttpUrl(slip2goUrl);
    const branchId = get('SLIPOK_BRANCH_ID');
    const providers = [
      {
        id: 'slipok',
        label: 'SlipOK',
        keySet: !!slipokKey,
        ready: !!slipokKey,
        detail: slipokKey
          ? { branchId: branchId || '(single-branch plan)' }
          : { hint: 'ตั้งค่า SLIPOK_API_KEY ก่อน' },
      },
      {
        id: 'easyslip',
        label: 'EasySlip',
        keySet: !!easyslipKey,
        ready: !!easyslipKey,
        detail: easyslipKey ? {} : { hint: 'ตั้งค่า EASYSLIP_API_KEY ก่อน' },
      },
      {
        id: 'slip2go',
        label: 'Slip2Go',
        keySet: !!slip2goKey,
        ready: !!slip2goKey && slip2goUrlOk,
        detail: slip2goKey && slip2goUrlOk
          ? { apiUrl: slip2goUrl }
          : { hint: slip2goUrl && !slip2goUrlOk
              ? 'SLIP2GO_API_URL ไม่ถูกต้อง — ใช้ URL จาก Slip2Go API Connect'
              : 'ตั้งค่า SLIP2GO_API_KEY และ SLIP2GO_API_URL ก่อน' },
      },
    ];
    const readyCount = providers.filter((p) => p.ready).length;
    if (readyCount === 0) {
      return {
        ok: false,
        error: 'ยังไม่มี slip verification provider พร้อมใช้ — ตั้ง SlipOK, EasySlip หรือ Slip2Go อย่างน้อย 1 ตัวก่อน',
        providers,
      };
    }
    // Pick the primary for legacy callers that read `info.provider`.
    const primaryId = providers.find((p) => p.ready)?.id || 'slipok';
    return {
      ok: true,
      info: {
        provider: primaryId,
        branchId: primaryId === 'slipok' ? (branchId || '(single-branch plan)') : null,
        ready: true,
        // Failover is "active" when at least two providers are ready AND
        // verifyWithFallback can iterate them. The features layer decides
        // chain order; this probe just confirms credentials are present.
        failoverReady: readyCount >= 2,
      },
      providers,
      readyCount,
    };
  }
  if (group === 'promptpay') {
    // Lightweight format check + try-build the EMV payload. Catches the
    // common "saved 9-digit phone" / "saved citizen-id with dashes" mistakes
    // before bills go out with a broken QR. We don't render the actual PNG
    // here — the visual is generated per-bill at /api/tenant/bills/:id/qr.
    const target = get('PROMPTPAY_TARGET');
    if (!target) return { ok: false, error: 'PROMPTPAY_TARGET ยังไม่ตั้ง' };
    const cleaned = String(target).replace(/[\s-]/g, '');
    const isPhone = /^0\d{9}$/.test(cleaned);
    const isCitizen = /^\d{13}$/.test(cleaned);
    if (!isPhone && !isCitizen) {
      return {
        ok: false,
        error: `รูปแบบไม่ถูกต้อง — ต้องเป็นเบอร์โทร 10 หลัก (0XXXXXXXXX) หรือเลขบัตร ปชช. 13 หลัก`,
        detail: { saved: target.length + ' chars', cleaned: cleaned.length + ' digits' },
      };
    }
    try {
      const { buildPayload } = require('./promptpay');
      // Build a payload with a small test amount — proves the underlying
      // EMV encoder accepts the target without surprises.
      const payload = buildPayload(cleaned, 1);
      // EMV PromptPay payloads start with "00020101" (Payload Format Indicator
      // + Point of Initiation Method static). If the encoder produced
      // something completely different, surface that instead of "ok".
      if (!payload || !payload.startsWith('0002')) {
        return { ok: false, error: 'EMV payload looks malformed', detail: { head: payload?.slice(0, 16) } };
      }
      return {
        ok: true,
        info: {
          format: isPhone ? 'phone' : 'citizen_id',
          masked: isPhone
            ? cleaned.slice(0, 3) + '-XXX-' + cleaned.slice(-4)
            : cleaned.slice(0, 4) + '-XXXXX-' + cleaned.slice(-4),
        },
      };
    } catch (err) {
      return { ok: false, error: 'EMV encode failed: ' + err.message };
    }
  }
  return { ok: false, error: 'unknown group' };
}

module.exports = { preload, get, set, listMetadata, testGroup, CATALOG, CATALOG_BY_KEY, maskValue };
