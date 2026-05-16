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
    query: async () => ({ rows: [{ key: 'SMTP_HOST' }] }),
  };
  // Put a DB-only secret in the cache (use a non-hidden key)
  await secrets.set(
    { query: async () => ({ rowCount: 1 }) },
    'SMTP_HOST',
    'smtp.example.com',
    't'
  );
  const items = await secrets.listMetadata(fakePool);
  const lineRow = items.find((i) => i.key === 'LINE_CHANNEL_ACCESS_TOKEN');
  assert.equal(lineRow.source, 'env');
  assert.equal(lineRow.readOnly, true);   // env-managed → readOnly
  assert.match(lineRow.maskedTail, /••••....$/);
  const smtpRow = items.find((i) => i.key === 'SMTP_HOST');
  assert.equal(smtpRow.source, 'db');
  assert.equal(smtpRow.readOnly, false);
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
});

test('listMetadata hides PROMPTPAY_TARGET from the secrets UI', async () => {
  // PromptPay is set ONLY via Settings → Payment tab. Backend resolver
  // still reads secrets.get('PROMPTPAY_TARGET') as a fallback (env + legacy
  // DB rows), but the admin secrets page must not surface it as a writable
  // row — that's the duplicate-write-path bug this guards against.
  const fakePool = { query: async () => ({ rows: [] }) };
  const items = await secrets.listMetadata(fakePool);
  assert.equal(items.find((i) => i.key === 'PROMPTPAY_TARGET'), undefined,
    'PROMPTPAY_TARGET must not appear in listMetadata output');
});

test('PROMPTPAY_TARGET still usable via get() (env-fallback path)', () => {
  process.env.PROMPTPAY_TARGET = '0899999999';
  assert.equal(secrets.get('PROMPTPAY_TARGET'), '0899999999',
    'env-override of hidden key must still resolve so ops can pin via Railway Variables');
  delete process.env.PROMPTPAY_TARGET;
});

test('CATALOG entry for PROMPTPAY_TARGET carries hidden: true', () => {
  // Routes use this flag to block SET-via-API and keep the "one canonical
  // write surface" invariant — if this flag drifts to false the API would
  // re-open the duplicate-write-paths bug.
  const entry = secrets.CATALOG_BY_KEY.PROMPTPAY_TARGET;
  assert.ok(entry, 'PROMPTPAY_TARGET must stay in CATALOG so env-fallback + legacy DB rows keep resolving');
  assert.equal(entry.hidden, true, 'PROMPTPAY_TARGET must be marked hidden');
});

test('hidden flag is opt-in (other keys are not hidden)', () => {
  // Sanity guard — making sure the filter logic in listMetadata isn't
  // accidentally hiding every key.
  const visible = secrets.CATALOG.filter((c) => !c.hidden);
  assert.ok(visible.length >= 10, `expected most keys to remain visible, got ${visible.length}`);
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
