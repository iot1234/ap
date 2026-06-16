#!/usr/bin/env node
// scripts/backup.js
// Dump all PostgreSQL operational tables managed by this app as JSON.
// Designed to run from cron or manually. By default writes to
// ./backups/<timestamp>.json.enc when backup encryption is available. If R2_*
// credentials are set, also uploads via S3-compatible API.
//
// Usage:
//   DATABASE_URL=... node scripts/backup.js
//
// Optional env (for upload):
//   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET
//   (any S3-compatible endpoint works — Cloudflare R2, AWS S3, etc.)
//
// To run nightly on Railway, add a Cron service or use Railway's built-in
// scheduled jobs and point it at this script.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Encrypt backups at rest — the dump contains every tenant row, phone number,
// and notification body, making the JSON file the largest single PII artifact
// in the system. AES-256-GCM via services/encryption.js (APENC1 buffer
// format; key = ENCRYPTION_KEY_V* or the legacy CITIZEN_ID_KEY /
// SESSION_SECRET-derived key). BACKUP_ENCRYPTION=off opts out. If no key
// material exists at all we warn loudly and write plaintext rather than fail
// — a missing backup is worse than a plaintext one.
const _encryption = (() => {
  try { return require('../services/encryption'); } catch { return null; }
})();

function encodeBackup(backupObj) {
  const json = JSON.stringify(backupObj, null, 2);
  const wantPlain = String(process.env.BACKUP_ENCRYPTION || '').toLowerCase() === 'off';
  if (wantPlain || !_encryption) {
    return { body: Buffer.from(json, 'utf8'), ext: '.json', encrypted: false };
  }
  try {
    return {
      body: _encryption.encryptBuffer(Buffer.from(json, 'utf8')),
      ext: '.json.enc',
      encrypted: true,
    };
  } catch (err) {
    console.warn(`[backup] encryption unavailable (${err.message}) — writing PLAINTEXT backup`);
    return { body: Buffer.from(json, 'utf8'), ext: '.json', encrypted: false };
  }
}

// Decrypt-aware reader — works for both plaintext .json and encrypted
// .json.enc files, so verify/restore handle either format.
function readBackupBuffer(buffer) {
  let raw = Buffer.from(buffer);
  if (_encryption && _encryption.isEncryptedBuffer(raw)) {
    raw = _encryption.decryptBuffer(raw);
  }
  return JSON.parse(raw.toString('utf8'));
}

function readBackupFile(filePath) {
  return readBackupBuffer(fs.readFileSync(filePath));
}

const _isBackupName = (f) => f.startsWith('backup-')
  && (f.endsWith('.json') || f.endsWith('.json.enc'));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL not set');
  process.exit(1);
}
const useSSL = !/\.railway\.internal/i.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

// All app-owned tables. v1 + v2 — anything missing from this list is
// silently dropped on restore, so adding a new table requires updating
// here AND in server.js's RESTORABLE_TABLES (the two must agree, or
// restore silently won't repopulate something the dump captured).
const TABLES = [
  // v1
  'app_data', 'auth_users', 'maintenance_tickets', 'audit_logs',
  // v2 — financial / tenancy
  'tenants', 'contracts', 'bills', 'payments',
  'recurring_charges', 'parcels',
  // v2 — relational rooms + booking-deposit reconciliation
  'rooms_v2', 'booking_deposit_orphans',
  // v2 — IoT / hardware / access
  'meter_readings', 'access_logs', 'access_cards', 'access_devices',
  // v2 — notifications + LINE multi-OA + bindings
  'notifications_log', 'notifications_queue',
  'line_oas', 'line_bindings', 'admin_line_recipients',
  // v2 — files / sessions / lockouts / settings / bookings
  'file_uploads', 'tenant_sessions', 'login_lockouts',
  'system_settings', 'bookings',
  // v3 — contract templates + tenant self-fill invitations
  'contract_templates', 'contract_invitations',
];

// Validate table name against a strict allowlist regex before string-
// interpolating into SQL — pg-node has no first-class identifier escape, so
// we lean on the regex to prevent injection through a tampered TABLES list.
function _validateTableName(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`invalid table name: ${name}`);
  }
}

// Tables we know carry an integer `id` PK we can paginate by. Anything not
// in this set falls back to a single SELECT * (assumed small). audit_logs
// + meter_readings + notifications_log can grow into millions on long-lived
// deployments — without paging they OOM the Railway hobby tier (512MB)
// during the in-process scheduler-driven backup.
const PAGINATABLE_BY_ID = new Set([
  'audit_logs', 'meter_readings', 'access_logs',
  'notifications_log', 'notifications_queue',
  'bills', 'payments', 'maintenance_tickets', 'parcels', 'file_uploads',
  'bookings', 'rooms_v2', 'booking_deposit_orphans',
]);

const PAGE_SIZE = 5000;

async function dumpTable(client, name) {
  _validateTableName(name);
  // Skip tables that don't exist (e.g. older deploy without v2 migration).
  // Treats "relation does not exist" as a non-fatal warning rather than
  // failing the whole backup.
  try {
    if (PAGINATABLE_BY_ID.has(name)) {
      // Page by id ascending. Streams in PAGE_SIZE chunks so peak memory is
      // bounded by ~PAGE_SIZE rows × row size (a few MB at most) regardless
      // of how big the table grew. For dumps headed straight to disk this
      // is preferable to loading everything via SELECT *.
      const out = [];
      let lastId = 0;
      // Bail-out cap: 10M rows × small row size = ~OK, but anything larger
      // should be archived/truncated, not dumped to a single JSON.
      const HARD_LIMIT = 10_000_000;
      while (out.length < HARD_LIMIT) {
        const { rows } = await client.query(
          `SELECT * FROM ${name} WHERE id > $1 ORDER BY id ASC LIMIT $2`,
          [lastId, PAGE_SIZE]
        );
        if (!rows.length) break;
        for (const r of rows) out.push(r);
        lastId = rows[rows.length - 1].id;
        if (rows.length < PAGE_SIZE) break;
      }
      return out;
    }
    const { rows } = await client.query(`SELECT * FROM ${name}`);
    return rows;
  } catch (err) {
    if (err.code === '42P01') {
      return { __skipped: 'table does not exist' };
    }
    throw err;
  }
}

function fileBlobName(row) {
  const category = String(row && row.category || '');
  const filename = String(row && row.filename || '');
  if (!/^[a-z_][a-z0-9_]*$/i.test(category)) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) return null;
  return { category, filename };
}

async function dumpFileBlobs(fileRows) {
  const rows = Array.isArray(fileRows) ? fileRows : [];
  const out = [];
  const errors = [];
  if (!rows.length) return { files: out, errors };
  let storage;
  try { storage = require('../services/storage'); }
  catch (err) {
    return { files: out, errors: [`storage service unavailable: ${err.message}`] };
  }
  for (const row of rows) {
    const safe = fileBlobName(row);
    if (!safe) {
      errors.push(`file_uploads:${row && row.id ? row.id : '?'} invalid category/filename`);
      continue;
    }
    try {
      const buf = await storage.readFileRaw(row);
      if (!buf || !Buffer.isBuffer(buf)) {
        errors.push(`file_uploads:${row.id} missing stored bytes`);
        continue;
      }
      out.push({
        id: row.id,
        category: safe.category,
        filename: safe.filename,
        storage: row.storage || 'local',
        size: buf.length,
        contentBase64: buf.toString('base64'),
      });
    } catch (err) {
      errors.push(`file_uploads:${row.id} ${String(err.message || err).slice(0, 160)}`);
    }
  }
  return { files: out, errors };
}

function materializeLocalFileBlob(blob) {
  const safe = fileBlobName(blob);
  if (!safe) throw new Error('invalid file blob path');
  if (!blob.contentBase64 || typeof blob.contentBase64 !== 'string') {
    throw new Error('missing file content');
  }
  const storage = require('../services/storage');
  const root = storage.rootPath();
  const dir = path.join(root, safe.category);
  storage.ensureDir(dir);
  const target = path.resolve(path.join(dir, safe.filename));
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (!target.startsWith(rootWithSep)) throw new Error('file blob path escapes upload root');
  fs.writeFileSync(target, Buffer.from(blob.contentBase64, 'base64'));
  return safe;
}

async function materializeFileBlobs(poolLike, backup) {
  const blobs = Array.isArray(backup && backup.fileBlobs) ? backup.fileBlobs : [];
  const stats = { incoming: blobs.length, restored: 0, skipped: 0, failed: 0, errors: [] };
  if (!blobs.length) return stats;
  for (const blob of blobs) {
    try {
      const safe = materializeLocalFileBlob(blob);
      const id = Number(blob.id);
      let updated = 0;
      if (Number.isFinite(id) && id > 0) {
        const r = await poolLike.query(
          `UPDATE file_uploads
              SET storage='local',
                  url=CASE WHEN COALESCE(url,'')='' THEN '/files/' || id::text ELSE url END
            WHERE id=$1 AND category=$2 AND filename=$3`,
          [id, safe.category, safe.filename]
        );
        updated = r.rowCount || 0;
      }
      if (!updated) {
        await poolLike.query(
          `UPDATE file_uploads
              SET storage='local',
                  url=CASE WHEN COALESCE(url,'')='' THEN '/files/' || id::text ELSE url END
            WHERE category=$1 AND filename=$2`,
          [safe.category, safe.filename]
        );
      }
      stats.restored++;
    } catch (err) {
      stats.failed++;
      stats.errors.push(String(err.message || err).slice(0, 180));
    }
  }
  stats.errors = stats.errors.slice(0, 30);
  return stats;
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    tables: {},
  };

  console.log(`[backup] starting dump @ ${stamp}`);
  for (const t of TABLES) {
    try {
      const rows = await dumpTable(pool, t);
      backup.tables[t] = rows;
      console.log(`[backup] ${t}: ${Array.isArray(rows) ? rows.length : '(skipped)'} rows`);
    } catch (err) {
      console.warn(`[backup] ${t} failed: ${err.message}`);
      backup.tables[t] = { __error: err.message };
    }
  }
  const dumpedFiles = await dumpFileBlobs(backup.tables.file_uploads);
  backup.fileBlobs = dumpedFiles.files;
  backup.fileBlobErrors = dumpedFiles.errors;
  if (dumpedFiles.files.length || dumpedFiles.errors.length) {
    console.log(`[backup] file blobs: ${dumpedFiles.files.length} included, ${dumpedFiles.errors.length} failed`);
  }

  const outDir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(outDir, { recursive: true });
  const enc = encodeBackup(backup);
  const file = path.join(outDir, `backup-${stamp}${enc.ext}`);
  fs.writeFileSync(file, enc.body);
  console.log(`[backup] wrote ${file} (${(fs.statSync(file).size / 1024).toFixed(1)} KB${enc.encrypted ? ', encrypted' : ', PLAINTEXT'})`);

  // Optional: rotate — keep last 30 local files
  const files = fs.readdirSync(outDir)
    .filter(_isBackupName)
    .sort();
  while (files.length > 30) {
    const old = files.shift();
    fs.unlinkSync(path.join(outDir, old));
    console.log(`[backup] rotated out ${old}`);
  }

  // Optional: upload to S3-compatible storage if credentials present.
  // ใช้ S3 client กลางจาก services/storage (secrets-store/env + SSRF guard +
  // DNS pinning) — เดิมไฟล์นี้สร้าง S3Client ดิบจาก env เอง ซึ่ง "ไม่มี"
  // SSRF guard: R2_ENDPOINT ที่ถูกชี้ไป URL ภายในจะพาเนื้อหาฐานข้อมูล
  // ทั้งก้อนออกไปหา endpoint แปลกปลอมได้
  const _secrets = (() => { try { return require('../services/secrets'); } catch { return null; } })();
  const _bucket = (_secrets && _secrets.get('R2_BUCKET')) || process.env.R2_BUCKET;
  if (_bucket) {
    let client = null;
    try {
      client = require('../services/storage').getS3Client();
    } catch (err) {
      console.error('[backup] storage service unavailable:', err.message);
    }
    if (!client) {
      // getS3Client คืน null เมื่อ R2_* ไม่ครบ, @aws-sdk/client-s3 ไม่ได้ติดตั้ง
      // หรือ endpoint ไม่ผ่าน SSRF guard (เหตุผลถูก log จาก storage แล้ว)
      console.log('[backup] R2 client not available — skipping cloud upload; local backup file is still good.');
    } else {
      try {
        await client.send(new client._lib.PutObjectCommand({
          Bucket: _bucket,
          Key: `backup-${stamp}${enc.ext}`,
          Body: fs.readFileSync(file),
          ContentType: enc.encrypted ? 'application/octet-stream' : 'application/json',
        }));
        console.log(`[backup] uploaded to ${_bucket}/backup-${stamp}${enc.ext}`);
      } catch (err) {
        console.error('[backup] upload failed:', err.message);
      }
    }
  } else {
    console.log('[backup] R2_* env not set — skipping cloud upload');
  }

  await pool.end();
  console.log('[backup] done');
}

// Importable entrypoint: pass an existing pg.Pool + retainDays. Used by
// services/scheduler.js so the daily auto-backup runs in-process without
// needing a separate Railway cron service.
async function run({ pool: externalPool, retainDays }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = { schemaVersion: 1, createdAt: new Date().toISOString(), tables: {} };
  const counts = {};
  for (const t of TABLES) {
    try {
      const rows = await dumpTable(externalPool, t);
      backup.tables[t] = rows;
      counts[t] = Array.isArray(rows) ? rows.length : 0;
    } catch (err) {
      if (err.code === '42P01') {
        backup.tables[t] = { __skipped: 'table does not exist' };
      } else {
        backup.tables[t] = { __error: err.message };
      }
    }
  }
  const dumpedFiles = await dumpFileBlobs(backup.tables.file_uploads);
  backup.fileBlobs = dumpedFiles.files;
  backup.fileBlobErrors = dumpedFiles.errors;
  counts.fileBlobs = dumpedFiles.files.length;
  counts.fileBlobErrors = dumpedFiles.errors.length;

  // Integrity hash — admin can verify a backup file hasn't been tampered
  // with (or corrupted in transit) before restoring. SHA-256 of the
  // serialized payload BEFORE the hash field is added, so the hash is
  // stable across multiple restores.
  const crypto = require('crypto');
  const payload = JSON.stringify(backup);
  backup.integrity = {
    algorithm: 'sha256',
    digest: crypto.createHash('sha256').update(payload).digest('hex'),
    rowCounts: counts,
  };

  const outDir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(outDir, { recursive: true });
  const enc = encodeBackup(backup);
  const file = path.join(outDir, `backup-${stamp}${enc.ext}`);
  fs.writeFileSync(file, enc.body);
  // Rotate
  const keep = Number(retainDays) || 30;
  const files = fs.readdirSync(outDir)
    .filter(_isBackupName).sort();
  while (files.length > keep) {
    const old = files.shift();
    try { fs.unlinkSync(path.join(outDir, old)); } catch {}
  }
  return {
    file,
    size: fs.statSync(file).size,
    digest: backup.integrity.digest,
    rowCounts: counts,
    fileBlobErrors: dumpedFiles.errors,
  };
}

/**
 * Verify a backup file's integrity hash without restoring anything.
 * Returns { ok: true, counts } when valid, { ok: false, error } otherwise.
 */
function verify(filePath) {
  try {
    const obj = readBackupFile(filePath);
    if (!obj || !obj.integrity || obj.integrity.algorithm !== 'sha256') {
      return { ok: false, error: 'no integrity block (older backup format)' };
    }
    const expected = obj.integrity.digest;
    const stored = { ...obj };
    delete stored.integrity;
    const actual = require('crypto').createHash('sha256')
      .update(JSON.stringify(stored)).digest('hex');
    if (actual !== expected) {
      return { ok: false, error: 'hash mismatch — file may be tampered or truncated' };
    }
    return { ok: true, counts: obj.integrity.rowCounts || {}, createdAt: obj.createdAt };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  run,
  verify,
  readBackupFile,
  readBackupBuffer,
  dumpFileBlobs,
  materializeFileBlobs,
  TABLES,
};

// CLI mode: only execute when invoked directly (node scripts/backup.js)
if (require.main === module) {
  main().catch((err) => {
    console.error('[backup] FAILED:', err);
    process.exit(1);
  });
}
