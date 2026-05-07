// tests/secrets.test.js
//   node --test tests/secrets.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// Set encryption key BEFORE requiring secrets so encryption module
// initialises with our test key.
process.env.ENCRYPTION_KEY_V1 = Buffer.alloc(32, 5).toString('base64');
process.env.ENCRYPTION_KEY_CURRENT = '1';
delete require.cache[require.resolve('../services/encryption')];
delete require.cache[require.resolve('../services/secrets')];

const secrets = require('../services/secrets');

test('catalog includes expected groups', () => {
  const groups = new Set(secrets.CATALOG.map((c) => c.group));
  for (const g of ['line', 'smtp', 'promptpay', 'sentry', 'r2']) {
    assert.ok(groups.has(g), `expected group ${g}`);
  }
});

test('catalog has LINE/SMTP critical keys', () => {
  const keys = new Set(secrets.CATALOG.map((c) => c.key));
  for (const k of ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'SMTP_HOST', 'SMTP_PASS', 'PROMPTPAY_TARGET']) {
    assert.ok(keys.has(k), `expected key ${k}`);
  }
});

test('get returns env value when present', () => {
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'env-token';
  assert.equal(secrets.get('LINE_CHANNEL_ACCESS_TOKEN'), 'env-token');
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
});

test('get returns undefined when nothing set', () => {
  assert.equal(secrets.get('SOME_RANDOM_KEY_THAT_NEVER_EXISTS'), undefined);
});

test('set + get round-trip via mock pool', async () => {
  const calls = [];
  const fakePool = {
    query: async (sql, params) => {
      calls.push({ sql: sql.trim().split('\n')[0], params });
      if (sql.includes('INSERT INTO secrets')) return { rowCount: 1 };
      if (sql.includes('DELETE FROM secrets')) return { rowCount: 1 };
      return { rows: [] };
    },
  };
  await secrets.set(fakePool, 'PROMPTPAY_TARGET', '0812345678', 'tester');
  // Cache populated, so get() returns the value without hitting DB.
  assert.equal(secrets.get('PROMPTPAY_TARGET'), '0812345678');
  assert.ok(calls.some((c) => c.sql.startsWith('INSERT INTO secrets')));
});

test('set with empty value clears (DELETE)', async () => {
  const calls = [];
  const fakePool = {
    query: async (sql) => { calls.push(sql); return { rowCount: 1 }; },
  };
  await secrets.set(fakePool, 'PROMPTPAY_TARGET', '', 'tester');
  assert.equal(secrets.get('PROMPTPAY_TARGET'), undefined);
  assert.ok(calls.some((s) => s.includes('DELETE FROM secrets')));
});

test('set rejects unknown keys', async () => {
  const fakePool = { query: async () => ({ rows: [] }) };
  await assert.rejects(
    () => secrets.set(fakePool, 'NOT_A_REAL_KEY', 'foo', 'tester'),
    /unknown secret key/
  );
});

test('listMetadata reports source + masked value', async () => {
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'super-long-test-token-abcdef1234';
  const fakePool = {
    query: async () => ({ rows: [{ key: 'PROMPTPAY_TARGET' }] }),
  };
  // First put a DB-only secret in the cache
  await secrets.set(
    { query: async () => ({ rowCount: 1 }) },
    'PROMPTPAY_TARGET',
    '0987654321',
    't'
  );
  const items = await secrets.listMetadata(fakePool);
  const lineRow = items.find((i) => i.key === 'LINE_CHANNEL_ACCESS_TOKEN');
  assert.equal(lineRow.source, 'env');
  assert.equal(lineRow.readOnly, true);   // env-managed → readOnly
  assert.match(lineRow.maskedTail, /••••....$/);
  const ppRow = items.find((i) => i.key === 'PROMPTPAY_TARGET');
  assert.equal(ppRow.source, 'db');
  assert.equal(ppRow.readOnly, false);
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
});

test('maskValue hides full secret', () => {
  assert.equal(secrets.maskValue('abcdefgh', 'password'), '••••efgh');
  assert.equal(secrets.maskValue('abc', 'password'), '••••');
  assert.equal(secrets.maskValue('', 'password'), null);
});

test('env override beats DB value', async () => {
  // Put one in DB
  await secrets.set(
    { query: async () => ({ rowCount: 1 }) },
    'SMTP_HOST', 'db-smtp.example.com', 't'
  );
  assert.equal(secrets.get('SMTP_HOST'), 'db-smtp.example.com');
  // Env should win
  process.env.SMTP_HOST = 'env-smtp.example.com';
  assert.equal(secrets.get('SMTP_HOST'), 'env-smtp.example.com');
  delete process.env.SMTP_HOST;
});
