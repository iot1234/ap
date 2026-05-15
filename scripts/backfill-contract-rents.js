#!/usr/bin/env node
// scripts/backfill-contract-rents.js
//
// One-time migration to lock existing tenants' rent rates. After the
// pricing resolver lands (services/pricing.js), billing reads
// contracts.monthly_rent FIRST. Active contracts that pre-date the
// resolver may have monthly_rent set incorrectly (or 0) — that would
// cause the resolver to fall through to the formula, and a subsequent
// admin change to /admin#pricing would silently rewrite their bills.
//
// This script copies the CURRENT room rent (from the legacy JSONB blob
// rooms[id].rent) into contracts.monthly_rent for every active contract
// whose monthly_rent is null/zero/missing — locking in what the tenant
// was paying at the moment the resolver shipped.
//
// Dry-run by default. Add --apply to write.
//
//   DATABASE_URL=... node scripts/backfill-contract-rents.js
//   DATABASE_URL=... node scripts/backfill-contract-rents.js --apply

const { Pool } = require('pg');

async function main() {
  const apply = process.argv.includes('--apply');
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL env var is required');
    process.exit(2);
  }
  const isLocal =
    process.env.DATABASE_URL.includes('localhost') ||
    process.env.DATABASE_URL.includes('127.0.0.1');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });

  try {
    // Find every active contract whose monthly_rent looks wrong AND
    // whose room blob has a usable rent. We INTENTIONALLY do not touch
    // contracts where admin already set monthly_rent — even if it
    // diverges from the blob, admin's value is authoritative.
    const { rows } = await pool.query(`
      WITH blob AS (
        SELECT key, value FROM app_data WHERE key='baankarn_rooms_v1' LIMIT 1
      )
      SELECT c.id, c.room_id, c.tenant_id, c.monthly_rent,
             (blob.value->c.room_id->>'rent')::numeric AS blob_rent,
             (blob.value->c.room_id->>'type')        AS blob_type
        FROM contracts c
        CROSS JOIN blob
       WHERE c.status='active'
         AND c.deleted_at IS NULL
         AND (c.monthly_rent IS NULL OR c.monthly_rent <= 0)
         AND blob.value ? c.room_id
         AND (blob.value->c.room_id->>'rent') IS NOT NULL
         AND (blob.value->c.room_id->>'rent')::numeric > 0
       ORDER BY c.id
    `);

    if (rows.length === 0) {
      console.log('✓ No contracts need backfill. Every active contract '
        + 'either has a non-zero monthly_rent or the matching room blob '
        + 'has no usable rent.');
      return;
    }

    console.log(`Contracts to backfill: ${rows.length}`);
    console.log('-'.repeat(80));
    for (const r of rows) {
      const cur = r.monthly_rent == null ? 'NULL' : String(r.monthly_rent);
      console.log(`  contract id=${r.id}  room=${r.room_id} `
        + `(${r.blob_type || '?'})  monthly_rent: ${cur} → ${r.blob_rent}`);
    }
    console.log('-'.repeat(80));

    if (!apply) {
      console.log('\nDRY-RUN — no changes written.');
      console.log('To apply: re-run with --apply');
      return;
    }

    // Use a single transaction so partial failure doesn't leave half the
    // contracts with new rates and half with old. Update WHERE clause
    // matches the SELECT above so a contract that was modified between
    // select and update (admin set monthly_rent in another tab) is
    // safely skipped.
    const client = await pool.connect();
    let updated = 0;
    try {
      await client.query('BEGIN');
      for (const r of rows) {
        const res = await client.query(
          `UPDATE contracts
              SET monthly_rent=$2,
                  updated_at=NOW()
            WHERE id=$1
              AND status='active'
              AND deleted_at IS NULL
              AND (monthly_rent IS NULL OR monthly_rent <= 0)`,
          [r.id, r.blob_rent]
        );
        updated += res.rowCount;
      }
      // Audit-log the backfill as a single bulk action so a future
      // operator can see "everyone got a snapshot at this time".
      await client.query(
        `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail)
         VALUES ($1, 'contract.backfill_monthly_rent', 'contract', 'bulk', $2::jsonb)`,
        ['backfill-script', JSON.stringify({
          considered: rows.length,
          updated,
          contracts: rows.map((r) => ({
            id: r.id, room: r.room_id, was: r.monthly_rent, now: Number(r.blob_rent),
          })).slice(0, 100),  // cap detail for huge backfills
        })]
      );
      await client.query('COMMIT');
      console.log(`\n✓ Updated ${updated} of ${rows.length} contracts.`);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      console.error('FAILED — transaction rolled back:', err.message);
      process.exit(1);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
