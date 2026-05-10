#!/usr/bin/env node
// Backfill/synchronise rooms_v2 from app_data['baankarn_rooms_v1'].
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/sync-rooms-v2-from-jsonb.js
//   DATABASE_URL=postgres://... node scripts/sync-rooms-v2-from-jsonb.js --apply
//
// Default is dry-run. Pass --apply to write. The script upserts only room
// inventory/status; it never links bills, tenants, contracts, or payments.

const { Pool } = require('pg');
const roomSync = require('../services/roomSync');

async function main() {
  const dryRun = !process.argv.includes('--apply');
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL env var is required');
    process.exit(1);
  }
  const isLocal =
    process.env.DATABASE_URL.includes('localhost') ||
    process.env.DATABASE_URL.includes('127.0.0.1');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: Number(process.env.PGCONNECT_TIMEOUT || 10) * 1000,
    statement_timeout: 30_000,
  });

  try {
    const result = await roomSync.upsertRoomsV2FromJsonb(pool, {
      dryRun,
      updatedBy: dryRun ? 'script:sync-rooms-v2-dry-run' : 'script:sync-rooms-v2',
    });
    console.log(JSON.stringify(result, null, 2));
    if (dryRun) {
      console.log('--dry-run default: no rows changed. Re-run with --apply to write rooms_v2.');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('SYNC_ROOMS_V2_FAILED:', err.message);
  process.exit(1);
});
