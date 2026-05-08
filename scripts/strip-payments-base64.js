#!/usr/bin/env node
// scripts/strip-payments-base64.js
// One-shot fix for the renderer-hung-on-/admin#payments incident.
//
// Symptom: clicking the "สลิป/การชำระเงิน" menu froze or crashed the admin
// tab. Other menus loaded fine.
//
// Root cause(s) — see commit message and `analysis` log for details:
//   1) page-payments.jsx had no fetch timeout / abort / globals guard
//   2) GET /api/payments did `SELECT p.*` which dumped slip_url into the
//      list response. Pre-storage-service rows can have a multi-MB base64
//      data URL in slip_url (instead of the canonical /files/<id>) — 200 of
//      those is enough to OOM the renderer.
//
// Permanent fix is in three layers (already shipped):
//   1) project/admin/page-payments.jsx — guards/timeout/abort/error UI
//   2) server.js — list endpoint omits slip_url + new GET /api/payments/:id
//      caps slip_url length and rejects data: URLs at the response boundary
//   3) db/migrate.js — composite (status, created_at DESC) index
//
// This script is the FOURTH layer: a one-time clean of the existing bloated
// rows so production stops bleeding memory immediately, without waiting for
// rows to age out naturally.
//
// Strategy: NULL out slip_url for rows where it's a data URL or > 2048
// chars. This breaks the in-modal preview for those specific historical
// rows — admin can no longer view the slip image — but the payment row
// itself (amount, status, audit trail) is preserved. The trade-off is
// intentional: we'd rather lose a stale image preview than lose the admin's
// ability to load the payments queue at all.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/strip-payments-base64.js
//   # or:    node scripts/strip-payments-base64.js --dry-run
//
// Always prints a summary. Exits non-zero on failure.

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
    // Inspect current state — find rows that look like the OOM trigger.
    // length(slip_url) > 2048 catches both base64 data URLs (typically
    // 100KB+) and any other accidentally-fat strings; the data: prefix
    // check catches the canonical bad pattern even when small.
    const before = await pool.query(
      `SELECT id, status, length(slip_url) AS sz, left(slip_url, 30) AS preview
         FROM payments
        WHERE slip_url IS NOT NULL
          AND (slip_url LIKE 'data:%' OR length(slip_url) > 2048)
        ORDER BY length(slip_url) DESC
        LIMIT 20`
    );
    if (!before.rows.length) {
      console.log('No bloated slip_url rows found — nothing to do.');
      return;
    }
    const totalRow = await pool.query(
      `SELECT COUNT(*)::int AS n,
              COALESCE(SUM(length(slip_url)), 0)::bigint AS bytes
         FROM payments
        WHERE slip_url IS NOT NULL
          AND (slip_url LIKE 'data:%' OR length(slip_url) > 2048)`
    );
    const total = totalRow.rows[0];
    const totalBytes = Number(total.bytes);
    const totalMb = (totalBytes / 1_048_576).toFixed(2);
    console.log(`Found ${total.n} bloated rows totaling ${totalBytes.toLocaleString()} bytes (${totalMb} MB)`);
    console.log('Sample (top 20 by size):');
    for (const r of before.rows) {
      const sz = Number(r.sz);
      const tag = String(r.preview || '').startsWith('data:') ? '[data:]' : '[long]';
      console.log(`  id=${r.id} status=${r.status} ${tag} ${sz.toLocaleString()} bytes — ${r.preview}...`);
    }

    if (dryRun) {
      console.log('--dry-run set — not writing back. Re-run without the flag to apply.');
      return;
    }

    // NULL the offending column. Keep the row + slip_hash so dedup still
    // protects against re-uploads of the same image; the loss is purely
    // cosmetic (modal will say "ไม่มีรูปสลิป" for these historical rows).
    const upd = await pool.query(
      `UPDATE payments
          SET slip_url = NULL
        WHERE slip_url IS NOT NULL
          AND (slip_url LIKE 'data:%' OR length(slip_url) > 2048)`
    );
    console.log(`Updated ${upd.rowCount} rows — slip_url set to NULL.`);

    const after = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM payments
        WHERE slip_url IS NOT NULL
          AND (slip_url LIKE 'data:%' OR length(slip_url) > 2048)`
    );
    if (after.rows[0].n > 0) {
      console.warn(`WARNING: ${after.rows[0].n} bloated rows still present after update — investigate.`);
      process.exit(1);
    }
    console.log('Verified: no bloated slip_url rows remain.');
    console.log('Done. Tell affected admins to refresh /admin#payments.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
