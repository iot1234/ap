#!/usr/bin/env node
// scripts/promote-to-owner.js
// Emergency recovery: promote a user to role='owner' so they regain access to
// the admin console after a role-related lockout (e.g. legacy 'admin' value
// that the RBAC ladder doesn't recognise).
//
// Usage (locally):
//   DATABASE_URL=postgres://... node scripts/promote-to-owner.js admin
//
// Usage on Railway:
//   railway run node scripts/promote-to-owner.js admin
//   # or open the deployed shell and run the same command
//
// The script connects, looks up the username, prints the current role, and
// updates to 'owner'. No-op if already owner. Exits non-zero on failure so
// CI/scripts can detect problems.

const { Pool } = require('pg');

async function main() {
  const username = process.argv[2];
  if (!username) {
    console.error('Usage: node scripts/promote-to-owner.js <username>');
    console.error('Example: node scripts/promote-to-owner.js admin');
    process.exit(2);
  }

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
      `SELECT id, username, role FROM auth_users WHERE username=$1`,
      [username]
    );
    if (!before.rows.length) {
      console.error(`No user '${username}' found.`);
      const all = await pool.query(`SELECT id, username, role FROM auth_users ORDER BY id`);
      console.error(`Existing users (${all.rows.length}):`);
      for (const u of all.rows) console.error(`  - id=${u.id}  ${u.username}  (role=${u.role})`);
      process.exit(1);
    }
    const u = before.rows[0];
    console.log(`Found user id=${u.id}  username=${u.username}  current role=${u.role}`);
    if (u.role === 'owner') {
      console.log('Already an owner — nothing to do.');
      return;
    }
    const after = await pool.query(
      `UPDATE auth_users SET role='owner' WHERE id=$1 RETURNING id, username, role`,
      [u.id]
    );
    console.log(`Promoted: id=${after.rows[0].id}  username=${after.rows[0].username}  new role=${after.rows[0].role}`);
    console.log('Done. Log out + log back in for the new role to take effect.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
