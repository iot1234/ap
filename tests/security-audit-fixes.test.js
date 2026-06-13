// tests/security-audit-fixes.test.js
// Pins the June 2026 multi-agent security/bug audit fixes so they can't
// silently regress:
//   1. Citizen-ID PII canary at boot (silent SESSION_SECRET-rotation PII loss)
//   2. secrets.js R2 "test connection" routes through the SSRF-guarded factory
//   3. healthCheck.checkR2 routes through the SSRF-guarded factory
//   4. owner-claim / admin-recipient: null-scoped (env) tokens stay env-scoped
//      instead of silently rebinding the concrete DB OA they were typed into
//   5. citizenIdEncryption disable-guard uses a real 13-digit discriminator
//   6. CSRF custom extractor uses the option name csrf-csrf actually reads
//
//   node --test tests/security-audit-fixes.test.js

// Must be set BEFORE requiring crypto/encryption — crypto.js caches the key on
// first use. (node --test isolates each file in its own process.)
process.env.CITIZEN_ID_KEY = Buffer.alloc(32, 9).toString('base64');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const ownerClaim = require('../services/ownerClaim');
const adminRecipients = require('../services/adminRecipients');
const encryption = require('../services/encryption');

// Shared stub: a connect()-style pool whose client records every query.
function stubClient(handlers) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [re, result] of handlers) {
        if (re.test(sql)) return typeof result === 'function' ? result(sql, params) : result;
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
}

// === 1. Citizen-ID PII canary ==============================================

function canaryPool() {
  // In-memory app_data; jsonb column returns a PARSED object like real pg.
  const store = new Map();
  return {
    store,
    async query(sql, params) {
      if (/SELECT value FROM app_data WHERE key=\$1/i.test(sql)) {
        const v = store.get(params[0]);
        return { rows: v ? [{ value: v }] : [] };
      }
      if (/INSERT INTO app_data/i.test(sql)) {
        if (!store.has(params[0])) store.set(params[0], JSON.parse(params[1]));
        return { rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test('PII canary: first boot creates, second boot verifies', async () => {
  const pool = canaryPool();
  const first = await encryption.validateCitizenIdCanary(pool);
  assert.equal(first.ok, true);
  assert.equal(first.mode, 'created');
  const second = await encryption.validateCitizenIdCanary(pool);
  assert.equal(second.ok, true);
  assert.equal(second.mode, 'verified');
});

test('PII canary: a stored ciphertext from a DIFFERENT key fails (the silent-loss case)', async () => {
  const pool = canaryPool();
  // Simulate SESSION_SECRET rotated away from the key that wrote the canary:
  // the stored ciphertext no longer decrypts under the current PII key.
  pool.store.set('citizenid_canary_v1', { ciphertext: 'A'.repeat(64), createdAt: '2026-01-01' });
  const r = await encryption.validateCitizenIdCanary(pool);
  assert.equal(r.ok, false, 'unreadable canary must report ok:false, not pass silently');
  assert.match(r.reason, /citizen-id canary/i);
});

test('PII canary: a DB error never gates boot (fails soft)', async () => {
  const pool = { async query() { throw new Error('db down'); } };
  const r = await encryption.validateCitizenIdCanary(pool);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'db-skip');
});

test('PII canary is exported and wired into boot, gated on the feature flag', () => {
  const enc = read('services', 'encryption.js');
  assert.match(enc, /async function validateCitizenIdCanary\(pool\)/);
  assert.match(enc, /\n  validateCitizenIdCanary,/, 'must be exported');
  const server = read('server.js');
  assert.match(server, /enc\.validateCitizenIdCanary\(pool\)/, 'boot must run the PII canary');
  assert.match(server, /encFlags\.citizenIdEncryption\.enabled/, 'PII canary must be gated on the flag');
});

// === 2 + 3. R2 SSRF: both probes use the guarded shared client =============

test('secrets.js R2 test-connection uses the SSRF-guarded shared S3 client', () => {
  const src = read('services', 'secrets.js');
  assert.match(src, /require\('\.\/storage'\)\.getS3Client\(\)/,
    'r2 test must route through storage.getS3Client()');
  assert.doesNotMatch(src, /new lib\.S3Client\(/,
    'r2 test must not build a raw unguarded S3Client');
});

test('healthCheck.checkR2 uses the SSRF-guarded shared S3 client', () => {
  const src = read('services', 'healthCheck.js');
  assert.match(src, /require\('\.\/storage'\)\.getS3Client\(\)/,
    'checkR2 must route through storage.getS3Client()');
  assert.doesNotMatch(src, /new lib\.S3Client\(/,
    'checkR2 must not build a raw unguarded S3Client');
});

test('getS3Client cache key includes the secret so a rotated key busts the cache', () => {
  const src = read('services', 'storage.js');
  assert.match(src, /\$\{id\}\|\$\{ep\}\|\$\{region\}\|\$\{sec\}/,
    'cache key must include the secret');
});

// === 4. Null-scoped claim tokens stay env-scoped ===========================

const FUTURE = () => new Date(Date.now() + 60_000).toISOString();
const LU = 'U1234567890abcdef1234567890abcdef';

test('owner-claim: env-scoped token (oa_id NULL) does NOT rebind the chat OA', async () => {
  const client = stubClient([
    [/SELECT id, status, oa_id, expires_at/i,
      { rows: [{ id: 7, status: 'pending', oa_id: null, expires_at: FUTURE() }] }],
  ]);
  const pool = { connect: async () => client };
  const setCalls = [];
  const secretsModule = { set: async (_p, k, v) => { setCalls.push({ k, v }); } };
  const out = await ownerClaim.tryClaim(pool, {
    code: 'OWNER-DEADBEEFDEADBEEF', lineUserId: LU, oaId: 5, secretsModule,
  });
  assert.equal(out.ok, true);
  assert.equal(out.oaId, null, 'env token must resolve persistTo=null, not the chat OA');
  const sqls = client.calls.map((c) => c.sql).join('\n');
  assert.doesNotMatch(sqls, /UPDATE line_oas SET owner_user_id/,
    'env-scoped token must not silently bind a concrete DB OA');
  assert.equal(setCalls.length, 1, 'env token must fall through to the global owner secret');
  assert.equal(setCalls[0].k, 'LINE_OWNER_USER_ID');
});

test('owner-claim: per-OA token still binds its own OA (no regression)', async () => {
  const client = stubClient([
    [/SELECT id, status, oa_id, expires_at/i,
      { rows: [{ id: 8, status: 'pending', oa_id: 5, expires_at: FUTURE() }] }],
  ]);
  const pool = { connect: async () => client };
  const setCalls = [];
  const secretsModule = { set: async (_p, k, v) => { setCalls.push({ k, v }); } };
  const out = await ownerClaim.tryClaim(pool, {
    code: 'OWNER-DEADBEEFDEADBEEF', lineUserId: LU, oaId: 5, secretsModule,
  });
  assert.equal(out.ok, true);
  assert.equal(out.oaId, 5);
  const sqls = client.calls.map((c) => c.sql).join('\n');
  assert.match(sqls, /UPDATE line_oas SET owner_user_id/, 'per-OA token must bind its OA');
  assert.equal(setCalls.length, 0, 'per-OA token must not also write the global secret');
});

test('admin-recipient: env-scoped token binds line_oa_id NULL, not the chat OA', async () => {
  const client = stubClient([
    [/SELECT id, status, oa_id, label, expires_at/i,
      { rows: [{ id: 9, status: 'pending', oa_id: null, label: null, expires_at: FUTURE() }] }],
    [/SELECT id, enabled FROM admin_line_recipients/i, { rows: [] }],
    [/INSERT INTO admin_line_recipients/i, { rows: [{ id: 42 }] }],
  ]);
  const pool = { connect: async () => client };
  const out = await adminRecipients.tryClaim(pool, { code: 'ADMIN-DEADBEEF', lineUserId: LU, oaId: 5 });
  assert.equal(out.ok, true);
  assert.equal(out.oaId, null, 'env token must resolve effectiveOaId=null, not the chat OA');
  const insert = client.calls.find((c) => /INSERT INTO admin_line_recipients/i.test(c.sql));
  assert.equal(insert.params[1], null, 'inserted recipient line_oa_id must be NULL (rides default OA)');
});

// === 5. citizenIdEncryption disable-guard discriminator ====================

test('disable-guard no longer uses the wrong NOT LIKE \'1%\' heuristic', () => {
  const server = read('server.js');
  assert.doesNotMatch(server, /citizen_id_encrypted NOT LIKE '1%'/,
    'first-char heuristic mis-classifies plaintext (2-8) and ciphertext (starts 1)');
  assert.match(server, /citizen_id_encrypted !~ '\^\[0-9\]\{13\}\$'/,
    'guard must classify by the real 13-digit plaintext shape');
});

// === 6. CSRF extractor option name =========================================

test('CSRF passes the extractor under the name csrf-csrf actually reads', () => {
  const csrf = read('middleware', 'csrf.js');
  assert.match(csrf, /getTokenFromRequest:\s*\(req\)/,
    'must use getTokenFromRequest (the key csrf-csrf 3.x destructures)');
  assert.doesNotMatch(csrf, /getCsrfTokenFromRequest\s*:/,
    'the misspelled key (silently ignored by the lib) must not be used as an option');
  // and the intended header + body + query fallback is still expressed
  assert.match(csrf, /req\.headers\['x-csrf-token'\]/);
  assert.match(csrf, /req\.body && req\.body\._csrf/);
});
