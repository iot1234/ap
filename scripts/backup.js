#!/usr/bin/env node
// scripts/backup.js
// Dump all PostgreSQL tables managed by this app (app_data, auth_users,
// maintenance_tickets, audit_logs) as JSON. Designed to run from cron or
// manually. By default writes to ./backups/<timestamp>.json. If R2_*
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
  'recurring_charges',
  // v2 — IoT / hardware / access
  'meter_readings', 'access_logs', 'access_cards', 'access_devices',
  // v2 — notifications + LINE multi-OA + bindings
  'notifications_log', 'notifications_queue',
  'line_oas', 'line_bindings',
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
  'bills', 'payments', 'maintenance_tickets', 'file_uploads',
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

  const outDir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `backup-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(backup, null, 2));
  console.log(`[backup] wrote ${file} (${(fs.statSync(file).size / 1024).toFixed(1)} KB)`);

  // Optional: rotate — keep last 30 local files
  const files = fs.readdirSync(outDir)
    .filter((f) => f.startsWith('backup-') && f.endsWith('.json'))
    .sort();
  while (files.length > 30) {
    const old = files.shift();
    fs.unlinkSync(path.join(outDir, old));
    console.log(`[backup] rotated out ${old}`);
  }

  // Optional: upload to S3-compatible storage if credentials present.
  // Read from secrets store (admin UI) or env (legacy).
  const _secrets = (() => { try { return require('../services/secrets'); } catch { return null; } })();
  const _r2 = {
    accessKeyId: (_secrets && _secrets.get('R2_ACCESS_KEY_ID')) || process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: (_secrets && _secrets.get('R2_SECRET_ACCESS_KEY')) || process.env.R2_SECRET_ACCESS_KEY,
    endpoint: (_secrets && _secrets.get('R2_ENDPOINT')) || process.env.R2_ENDPOINT,
    bucket: (_secrets && _secrets.get('R2_BUCKET')) || process.env.R2_BUCKET,
    region: (_secrets && _secrets.get('R2_REGION')) || process.env.R2_REGION || 'auto',
  };
  if (_r2.accessKeyId && _r2.bucket) {
    let S3Client, PutObjectCommand;
    try {
      ({ S3Client, PutObjectCommand } = require('@aws-sdk/client-s3'));
    } catch (err) {
      console.error('[backup] @aws-sdk/client-s3 is not installed.');
      console.error('  Run: npm install @aws-sdk/client-s3');
      console.error('  (it is intentionally not in default deps to keep the prod image small)');
      console.error('  Skipping cloud upload; local backup file is still good.');
      await pool.end();
      return;
    }
    try {
      const client = new S3Client({
        endpoint: _r2.endpoint,
        region: _r2.region,
        credentials: {
          accessKeyId: _r2.accessKeyId,
          secretAccessKey: _r2.secretAccessKey,
        },
      });
      await client.send(new PutObjectCommand({
        Bucket: _r2.bucket,
        Key: `backup-${stamp}.json`,
        Body: fs.readFileSync(file),
        ContentType: 'application/json',
      }));
      console.log(`[backup] uploaded to ${_r2.bucket}/backup-${stamp}.json`);
    } catch (err) {
      console.error('[backup] upload failed:', err.message);
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
  const file = path.join(outDir, `backup-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(backup, null, 2));
  // Rotate
  const keep = Number(retainDays) || 30;
  const files = fs.readdirSync(outDir)
    .filter((f) => f.startsWith('backup-') && f.endsWith('.json')).sort();
  while (files.length > keep) {
    const old = files.shift();
    try { fs.unlinkSync(path.join(outDir, old)); } catch {}
  }
  return {
    file,
    size: fs.statSync(file).size,
    digest: backup.integrity.digest,
    rowCounts: counts,
  };
}

/**
 * Verify a backup file's integrity hash without restoring anything.
 * Returns { ok: true, counts } when valid, { ok: false, error } otherwise.
 */
function verify(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const obj = JSON.parse(raw);
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

module.exports = { run, verify };

// CLI mode: only execute when invoked directly (node scripts/backup.js)
if (require.main === module) {
  main().catch((err) => {
    console.error('[backup] FAILED:', err);
    process.exit(1);
  });
}
