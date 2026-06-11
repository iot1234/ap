// services/storage.js
// File storage: accepts a base64-encoded file (data URL or raw base64),
// validates size + mime type, writes it under uploads/ on local disk, and
// records a row in file_uploads. Optional S3-compatible upload if R2_*
// env vars are set (lazy-loaded so the dep isn't required when off).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const secrets = require('./secrets');
const ssrfGuard = require('./ssrfGuard');
const encryption = require('./encryption');

// Encrypt every uploaded file at rest (AES-256-GCM, see services/encryption.js
// buffer format). Citizen-ID scans, payment slips, and signatures must not be
// readable by anyone holding the raw disk / S3 bucket — DB role-gating on
// /files/:id protects the HTTP path, this protects the storage itself.
// Default ON; FILE_ENCRYPTION=off opts out (e.g. while debugging). Files
// written before this landed stay readable: decryptBuffer passes plaintext
// (non-magic) buffers through unchanged.
const FILE_ENCRYPTION_OFF = String(process.env.FILE_ENCRYPTION || '').toLowerCase() === 'off';

// Lazy-loaded S3 client, only created when R2 credentials are present.
// Re-using the client across uploads avoids paying connection setup per file.
let _s3Client = null;
let _s3ClientKey = '';
function getS3Client() {
  const id = secrets.get('R2_ACCESS_KEY_ID');
  const sec = secrets.get('R2_SECRET_ACCESS_KEY');
  const ep = secrets.get('R2_ENDPOINT');
  const region = secrets.get('R2_REGION') || 'auto';
  if (!id || !sec || !ep) return null;
  // SSRF guard: R2_ENDPOINT is operator-supplied free text and is used as the
  // S3 endpoint for uploads/reads/backups (and is reachable on demand via the
  // "test connection" button). Reject https-less / internal targets so it can't
  // be pointed at cloud metadata or the platform's private network (which would
  // also exfiltrate uploaded slips/citizen-ID images to an attacker endpoint).
  try { ssrfGuard.assertSafeUrl(ep); }
  catch (e) { console.error('[storage] R2_ENDPOINT rejected (SSRF guard):', e.message); return null; }
  const cacheKey = `${id}|${ep}|${region}`;
  if (_s3Client && _s3ClientKey === cacheKey) return _s3Client;
  let lib;
  try { lib = require('@aws-sdk/client-s3'); }
  catch { return null; }
  _s3Client = new lib.S3Client({
    region, endpoint: ep, forcePathStyle: true,
    credentials: { accessKeyId: id, secretAccessKey: sec },
  });
  _s3Client._lib = lib;
  _s3ClientKey = cacheKey;
  return _s3Client;
}

function s3Configured() {
  return !!(secrets.get('R2_ACCESS_KEY_ID')
    && secrets.get('R2_SECRET_ACCESS_KEY')
    && secrets.get('R2_ENDPOINT')
    && secrets.get('R2_BUCKET'));
}

function isProductionLikeRuntime() {
  const nodeEnv = process.env.NODE_ENV || 'production';
  return nodeEnv === 'production'
    || !!process.env.RAILWAY_ENVIRONMENT
    || !!process.env.RAILWAY_PROJECT_ID
    || !!process.env.RAILWAY_SERVICE_ID;
}

// Allow operators to point uploads at a Railway/Docker mounted volume so
// files survive container restarts. Falls back to ./uploads in dev.
const UPLOAD_ROOT = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '..', 'uploads');

function storageStatus() {
  const usingS3 = s3Configured();
  const hasExplicitUploadDir = !!process.env.UPLOAD_DIR;
  const productionLike = isProductionLikeRuntime();
  return {
    storageMode: usingS3 ? 's3' : 'local',
    s3Configured: usingS3,
    uploadRoot: UPLOAD_ROOT,
    hasExplicitUploadDir,
    productionLike,
    localUploadMayBeEphemeral: !usingS3 && productionLike && !hasExplicitUploadDir,
    fileEncryption: FILE_ENCRYPTION_OFF ? 'off' : 'on',
  };
}

// Whitelisted mime → extension. Anything else is rejected.
const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Parse a data URL or raw base64. Returns { mime, buffer } or throws.
 *   "data:image/png;base64,iVBOR..."  →  { mime: 'image/png', buffer }
 *   "iVBOR..."                        →  { mime: null, buffer }
 */
function parseBase64(input) {
  if (typeof input !== 'string') throw new Error('expected string');
  const m = input.match(/^data:([^;]+);base64,(.+)$/);
  if (m) {
    return { mime: m[1].toLowerCase(), buffer: Buffer.from(m[2], 'base64') };
  }
  return { mime: null, buffer: Buffer.from(input, 'base64') };
}

/**
 * Detect file type from magic bytes. Returns canonical mime or null.
 * Used to defend against attackers spoofing the MIME header (e.g. uploading
 * an HTML file claiming to be image/png — admin viewing it would trigger XSS
 * if served with the wrong Content-Type).
 */
function detectMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  // WEBP: 'RIFF' .... 'WEBP'
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  // PDF: '%PDF-'
  if (buf.slice(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  return null;
}

/**
 * Save a base64 file to local disk and record in DB.
 * @param {object} opts
 * @param {import('pg').Pool} opts.pool
 * @param {string} opts.category - room_photo | slip | contract_signature | citizen_id_image
 * @param {string} opts.dataUrl - data URL or raw base64
 * @param {string} [opts.refId] - foreign id (room_id, bill_id, etc.)
 * @param {string} [opts.uploadedBy]
 * @param {number} [opts.maxBytes]
 * @param {string[]} [opts.allowedMimes]
 * @param {string} [opts.declaredMime] - if no data: prefix, must declare mime
 * @returns {Promise<{ id: number, url: string, filename: string, size: number }>}
 */
async function saveBase64({
  pool,
  category,
  dataUrl,
  refId = null,
  uploadedBy = null,
  maxBytes = 1_500_000,
  allowedMimes = ['image/jpeg', 'image/png', 'image/webp'],
  declaredMime = null,
  // Optional 'front'/'back' tag — only used for citizen_id_image today,
  // but generic enough that future categories (e.g. utility-meter photo
  // before/after) can reuse it without a schema change.
  side = null,
}) {
  const parsed = parseBase64(dataUrl);
  const declared = (parsed.mime || declaredMime || '').toLowerCase();
  // Sniff actual content. Reject anything where declared and detected disagree
  // — that's the spoofing attempt we want to catch.
  const detected = detectMime(parsed.buffer);
  if (!detected) throw new Error('unrecognized file type');
  if (declared && declared !== detected) {
    throw new Error(`mime mismatch (declared ${declared} vs actual ${detected})`);
  }
  const mime = detected;
  if (!allowedMimes.includes(mime)) {
    throw new Error('mime not allowed: ' + mime);
  }
  if (!MIME_EXT[mime]) throw new Error('unknown mime: ' + mime);
  if (parsed.buffer.length > maxBytes) {
    throw new Error('file too large');
  }
  const ext = MIME_EXT[mime];
  const fileId = crypto.randomBytes(8).toString('hex');
  const safeCategory = String(category || 'misc').replace(/[^a-z_]/gi, '_').slice(0, 32);
  const filename = `${Date.now().toString(36)}-${fileId}.${ext}`;

  // Encrypt-at-rest. Validation (mime sniff, size) ran on the plaintext
  // above; only the stored bytes are wrapped. If encryption is unavailable
  // (no key material at all), refuse rather than silently writing PII in
  // the clear — the operator opts out explicitly with FILE_ENCRYPTION=off.
  let storedBuffer = parsed.buffer;
  let encryptedAtRest = false;
  if (!FILE_ENCRYPTION_OFF) {
    storedBuffer = encryption.encryptBuffer(parsed.buffer);
    encryptedAtRest = true;
  }

  // Decide storage backend at write time. R2 is preferred when configured
  // because local disk on Railway is ephemeral (resets on redeploy) — slips
  // and citizen-ID images would vanish on the next push.
  let storageMode = 'local';
  let s3Key = null;
  let s3FailureMsg = null;
  if (s3Configured()) {
    const client = getS3Client();
    const bucket = secrets.get('R2_BUCKET');
    if (client && bucket) {
      s3Key = `${safeCategory}/${filename}`;
      try {
        await client.send(new client._lib.PutObjectCommand({
          Bucket: bucket,
          Key: s3Key,
          Body: storedBuffer,
          // Encrypted bodies are not the declared image/pdf any more —
          // label them opaque so bucket tooling can't mis-render them.
          // The real mime stays in file_uploads.mime_type for serving.
          ContentType: encryptedAtRest ? 'application/octet-stream' : mime,
        }));
        storageMode = 's3';
      } catch (err) {
        s3FailureMsg = err.message;
        console.error('[storage] R2 upload failed, falling back to local:', err.message);
        s3Key = null;
      }
    }
  }
  if (storageMode === 'local') {
    const dir = path.join(UPLOAD_ROOT, safeCategory);
    ensureDir(dir);
    const fullPath = path.join(dir, filename);
    fs.writeFileSync(fullPath, storedBuffer);
    // R2 was configured + failed → alert the owner. Without this the slip
    // ends up on Railway's ephemeral disk and is lost at next redeploy
    // with no signal to anyone. Fire-and-forget so a notify outage can't
    // wedge an upload.
    if (s3FailureMsg) {
      try {
        const notifier = require('./notifier');
        const features = require('./features');
        const flags = await features.load(pool).catch(() => ({}));
        notifier.notifyOwner({ pool, features: flags }, {
          category: 'system',
          subject: 'อัปโหลดไฟล์ขึ้น R2/S3 ไม่สำเร็จ — ระบบบันทึกไว้ในเครื่องชั่วคราว',
          text: `ไฟล์ ${safeCategory}/${filename} ยังส่งขึ้นพื้นที่เก็บไฟล์ถาวรไม่ได้\n\n`
            + `สาเหตุจากระบบ: ${s3FailureMsg}\n\n`
            + `ตอนนี้ไฟล์อยู่บนพื้นที่ชั่วคราวของเครื่องเซิร์ฟเวอร์ หากมีการ redeploy ไฟล์อาจหายได้ ` +
              `กรุณาตรวจสอบข้อมูล R2/S3 ใน /admin#secrets`,
        }).catch(() => {});
      } catch { /* ignore */ }
    }
  }

  // Insert first, then build the URL using the row id so admins get
  // /files/<id> (auth-gated). Two-step: insert with placeholder url, then
  // update — but a single INSERT ... RETURNING gives us the id we need to
  // build the url and we can patch it post-insert in one extra UPDATE.
  //
  // `side` is only set when the caller explicitly passed it (citizen ID
  // front/back) — older deployments without the column fall through via
  // the partial-update path below.
  const safeSide = (side === 'front' || side === 'back') ? side : null;
  let ins;
  try {
    ins = await pool.query(
      `INSERT INTO file_uploads (category, ref_id, filename, mime_type, size_bytes, storage, url, uploaded_by, side)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [safeCategory, refId, filename, mime, parsed.buffer.length, storageMode, '', uploadedBy, safeSide]
    );
  } catch (err) {
    // Older deploys may not have the `side` column yet (mid-migration).
    // Fall back to the no-side INSERT so existing flows keep working.
    if (err.code === '42703') {  // undefined_column
      ins = await pool.query(
        `INSERT INTO file_uploads (category, ref_id, filename, mime_type, size_bytes, storage, url, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [safeCategory, refId, filename, mime, parsed.buffer.length, storageMode, '', uploadedBy]
      );
    } else {
      throw err;
    }
  }
  const id = ins.rows[0].id;
  const url = `/files/${id}`;
  await pool.query(`UPDATE file_uploads SET url=$1 WHERE id=$2`, [url, id]);

  return { id, url, filename, size: parsed.buffer.length, mime, buffer: parsed.buffer, storage: storageMode };
}

// Defense-in-depth: defend against a tampered DB row whose `category` or
// `filename` contains "../" or backslashes that path.join would happily
// resolve OUTSIDE UPLOAD_ROOT. The write-time sanitiser at saveBase64
// already strips bad characters, but a manually-mutated row (DBA edit, SQL
// injection elsewhere, restored backup with malicious data) could still
// carry traversal segments. Resolve the joined path and require it to start
// with UPLOAD_ROOT — refuse to read anything outside.
function _safeLocalPath(category, filename) {
  // Reject obvious traversal attempts before path.join even sees them so
  // the error message is actionable rather than "Bucket is required" -ish.
  if (typeof category !== 'string' || typeof filename !== 'string') {
    throw new Error('storage: invalid category/filename');
  }
  if (category.includes('..') || filename.includes('..')
      || category.includes('/') || category.includes('\\')
      || filename.includes('/') || filename.includes('\\')) {
    throw new Error('storage: traversal in category/filename');
  }
  const resolved = path.resolve(path.join(UPLOAD_ROOT, category, filename));
  // Require the resolved path to be inside UPLOAD_ROOT. Trailing path.sep
  // ensures `/uploads-evil` doesn't match `/uploads`.
  const root = UPLOAD_ROOT.endsWith(path.sep) ? UPLOAD_ROOT : UPLOAD_ROOT + path.sep;
  if (!resolved.startsWith(root) && resolved !== UPLOAD_ROOT) {
    throw new Error('storage: resolved path escapes upload root');
  }
  return resolved;
}

function localFileExists(rec) {
  if (!rec || rec.storage === 's3') return null;
  try {
    return fs.existsSync(_safeLocalPath(rec.category, rec.filename));
  } catch {
    return false;
  }
}

// Read a stored file's bytes back. Used by the auth-gated /files/:id
// route so it can stream from either backend without leaking the URL
// shape to clients.
async function readFile(rec) {
  if (!rec || !rec.filename || !rec.category) return null;
  if (rec.storage === 's3') {
    const client = getS3Client();
    if (!client) throw new Error('R2 credentials missing — cannot read s3-stored file');
    const bucket = secrets.get('R2_BUCKET');
    // Bucket can be cleared independently of access keys (admin removes
    // R2_BUCKET from secrets but leaves the keys in place). Without this
    // check the AWS SDK throws a less-helpful "Bucket is required" error.
    if (!bucket) throw new Error('R2_BUCKET not configured — cannot read s3-stored file');
    const key = `${rec.category}/${rec.filename}`;
    const out = await client.send(new client._lib.GetObjectCommand({ Bucket: bucket, Key: key }));
    const chunks = [];
    for await (const chunk of out.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  // local
  const fp = _safeLocalPath(rec.category, rec.filename);
  if (!fs.existsSync(fp)) return null;
  return fs.readFileSync(fp);
}

// Transparent decrypt for both backends: files written after encryption-at-
// rest landed carry the APENC1 magic and are unwrapped here; older plaintext
// files pass through untouched. Kept as a wrapper so every consumer of
// readFile (the /files/:id proxy, slip auto-verify, PDF embedding) gets the
// plaintext bytes it always got.
const _readRaw = readFile;
async function readFileDecrypted(rec) {
  const buf = await _readRaw(rec);
  if (!buf) return buf;
  try {
    return encryption.decryptBuffer(buf);
  } catch (err) {
    // Wrong/missing key — surface a precise error instead of streaming
    // ciphertext garbage to the admin's browser.
    throw new Error(`stored file is encrypted but cannot be decrypted (${err.message}) — check ENCRYPTION_KEY_V*/CITIZEN_ID_KEY/SESSION_SECRET`);
  }
}

/**
 * Delete a file row + its on-disk file. Best-effort: missing files are not fatal.
 */
async function remove(pool, id) {
  const { rows } = await pool.query('SELECT category, filename, storage FROM file_uploads WHERE id=$1', [id]);
  if (!rows.length) return false;
  const r = rows[0];
  if (r.storage === 's3' && s3Configured()) {
    try {
      const client = getS3Client();
      const bucket = secrets.get('R2_BUCKET');
      if (client && bucket) {
        await client.send(new client._lib.DeleteObjectCommand({
          Bucket: bucket, Key: `${r.category}/${r.filename}`,
        }));
      }
    } catch (err) { console.warn('[storage] R2 delete failed:', err.message); }
  } else {
    // Same traversal guard as readFile — never let a malicious row delete
    // outside the upload root (e.g. /etc/passwd via filename='../../etc/passwd').
    try {
      const fp = _safeLocalPath(r.category, r.filename);
      fs.unlinkSync(fp);
    } catch { /* ignore — guarded path or already gone */ }
  }
  await pool.query('DELETE FROM file_uploads WHERE id=$1', [id]);
  return true;
}

/**
 * Returns absolute path to the upload root so server can mount static.
 */
function rootPath() { return UPLOAD_ROOT; }

module.exports = {
  saveBase64,
  remove,
  // Every consumer gets transparently-decrypted bytes; the raw variant is
  // for diagnostics only (e.g. checking whether a stored file is encrypted).
  readFile: readFileDecrypted,
  readFileRaw: _readRaw,
  rootPath,
  parseBase64,
  detectMime,
  ensureDir,
  s3Configured,
  storageStatus,
  localFileExists,
};
