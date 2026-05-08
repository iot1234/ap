#!/usr/bin/env node
// scripts/strip-rooms-photos.js
// One-shot fix for the OOM-on-/admin#billing incident.
//
// Symptom: Chrome renderer crashed with "Aw, Snap! Out of Memory" when an
// admin opened /admin#billing on production. Other pages worked fine.
//
// Root cause: project/app.jsx readAsDataURL'd uploaded photos straight into
// `room.photos[]` and the wrapped localStorage.setItem flushed the rooms
// blob (now containing 12 × multi-MB base64 strings × dozens of rooms) back
// to /api/data/baankarn_rooms_v1. Subsequent page loads parsed the 50-100 MB
// JSON twice (api-client hydrate + admin React state) which exceeded V8's
// per-renderer memory budget.
//
// Permanent fix is in three layers (already shipped):
//   1) project/app.jsx — per-file 1.5 MB cap at upload time
//   2) project/admin/shared.jsx — stripDataUrls() on every load + save
//   3) project/api-client.js + server.js — 5/6 MB hard cap on /api/data PUTs
//
// This script does the FOURTH layer: a one-time clean of the existing
// bloated DB row so production stops OOM'ing immediately, without waiting
// for an admin to hit save in the UI (which would have triggered the new
// stripper anyway, but only after they could load the page — chicken/egg).
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/strip-rooms-photos.js
//   # or:    node scripts/strip-rooms-photos.js --dry-run
//
// Always prints before/after byte counts. Exits non-zero on failure.

const { Pool } = require('pg');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
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
    const before = await pool.query(
      `SELECT octet_length(value::text) AS n,
              pg_column_size(value)     AS jb
         FROM app_data WHERE key='baankarn_rooms_v1'`
    );
    if (!before.rows.length) {
      console.log('No baankarn_rooms_v1 row found — nothing to do.');
      return;
    }
    const beforeBytes = before.rows[0].n;
    const beforeJsonb = before.rows[0].jb;
    console.log(`Before: ${beforeBytes.toLocaleString()} bytes JSON / ${beforeJsonb.toLocaleString()} bytes JSONB`);

    const { rows } = await pool.query(
      `SELECT value FROM app_data WHERE key='baankarn_rooms_v1'`
    );
    const rooms = rows[0].value;
    if (!rooms || typeof rooms !== 'object') {
      console.error('rooms blob is not an object — aborting');
      process.exit(1);
    }

    let droppedPhotos = 0, droppedTenantImages = 0;
    for (const id of Object.keys(rooms)) {
      const r = rooms[id];
      if (!r || typeof r !== 'object') continue;
      if (Array.isArray(r.photos)) {
        const before = r.photos.length;
        r.photos = r.photos.filter((p) => typeof p === 'string' && !p.startsWith('data:'));
        droppedPhotos += before - r.photos.length;
      }
      if (r.tenant && typeof r.tenant === 'object') {
        for (const k of ['idCardImage', 'signatureImage', 'avatar']) {
          if (typeof r.tenant[k] === 'string' && r.tenant[k].startsWith('data:')) {
            delete r.tenant[k];
            droppedTenantImages++;
          }
        }
      }
    }
    console.log(`Stripped: ${droppedPhotos} room photos + ${droppedTenantImages} tenant images`);

    const cleaned = JSON.stringify(rooms);
    console.log(`After:  ${cleaned.length.toLocaleString()} bytes JSON`);
    if (cleaned.length >= beforeBytes) {
      console.log('No size reduction — nothing to write.');
      return;
    }
    const reductionMb = ((beforeBytes - cleaned.length) / 1_048_576).toFixed(2);
    console.log(`Reduction: ${reductionMb} MB`);

    if (dryRun) {
      console.log('--dry-run set — not writing back. Re-run without the flag to apply.');
      return;
    }
    await pool.query(
      `UPDATE app_data
          SET value = $1::jsonb,
              updated_at = NOW(),
              updated_by = COALESCE(updated_by, 'cleanup-script')
        WHERE key='baankarn_rooms_v1'`,
      [cleaned]
    );
    const after = await pool.query(
      `SELECT octet_length(value::text) AS n,
              pg_column_size(value)     AS jb
         FROM app_data WHERE key='baankarn_rooms_v1'`
    );
    console.log(`Verified after write: ${after.rows[0].n.toLocaleString()} bytes JSON / ${after.rows[0].jb.toLocaleString()} bytes JSONB`);
    console.log('Done. Tell the affected admin to clear localStorage (DevTools → Application → Storage → Clear site data) so their stale cache doesn\'t re-poison the row.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
