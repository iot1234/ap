// services/storage.js
// File storage: accepts a base64-encoded file (data URL or raw base64),
// validates size + mime type, writes it under uploads/ on local disk, and
// records a row in file_uploads. Optional S3-compatible upload if R2_*
// env vars are set (lazy-loaded so the dep isn't required when off).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const secrets = require('./secrets');

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

// Allow operators to point uploads at a Railway/Docker mounted volume so
// files survive container restarts. Falls back to ./uploads in dev.
const UPLOAD_ROOT = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '..', 'uploads');

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

  // Decide storage backend at write time. R2 is preferred when configured
  // because local disk on Railway is ephemeral (resets on redeploy) — slips
  // and citizen-ID images would vanish on the next push.
  let storageMode = 'local';
  let s3Key = null;
  if (s3Configured()) {
    const client = getS3Client();
    const bucket = secrets.get('R2_BUCKET');
    if (client && bucket) {
      s3Key = `${safeCategory}/${filename}`;
      try {
        await client.send(new client._lib.PutObjectCommand({
          Bucket: bucket,
          Key: s3Key,
          Body: parsed.buffer,
          ContentType: mime,
        }));
        storageMode = 's3';
      } catch (err) {
        console.error('[storage] R2 upload failed, falling back to local:', err.message);
        s3Key = null;
      }
    }
  }
  if (storageMode === 'local') {
    const dir = path.join(UPLOAD_ROOT, safeCategory);
    ensureDir(dir);
    const fullPath = path.join(dir, filename);
    fs.writeFileSync(fullPath, parsed.buffer);
  }

  // Insert first, then build the URL using the row id so admins get
  // /files/<id> (auth-gated). Two-step: insert with placeholder url, then
  // update — but a single INSERT ... RETURNING gives us the id we need to
  // build the url and we can patch it post-insert in one extra UPDATE.
  const ins = await pool.query(
    `INSERT INTO file_uploads (category, ref_id, filename, mime_type, size_bytes, storage, url, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [safeCategory, refId, filename, mime, parsed.buffer.length, storageMode, '', uploadedBy]
  );
  const id = ins.rows[0].id;
  const url = `/files/${id}`;
  await pool.query(`UPDATE file_uploads SET url=$1 WHERE id=$2`, [url, id]);

  return { id, url, filename, size: parsed.buffer.length, mime, buffer: parsed.buffer, storage: storageMode };
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
  const fp = path.join(UPLOAD_ROOT, rec.category, rec.filename);
  if (!fs.existsSync(fp)) return null;
  return fs.readFileSync(fp);
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
    const fp = path.join(UPLOAD_ROOT, r.category, r.filename);
    try { fs.unlinkSync(fp); } catch { /* ignore */ }
  }
  await pool.query('DELETE FROM file_uploads WHERE id=$1', [id]);
  return true;
}

/**
 * Returns absolute path to the upload root so server can mount static.
 */
function rootPath() { return UPLOAD_ROOT; }

module.exports = { saveBase64, remove, readFile, rootPath, parseBase64, detectMime, ensureDir, s3Configured };
