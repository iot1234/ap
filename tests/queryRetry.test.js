// tests/queryRetry.test.js
//   node --test tests/queryRetry.test.js
//
// Tests the retry-on-transient-error path of db/pool.js without a real DB.
// We mock the module's pool import so we can script failures.

const test = require('node:test');
const assert = require('node:assert/strict');

// Stub DATABASE_URL so requiring db/pool.js doesn't process.exit
process.env.DATABASE_URL = 'postgres://fake/fake';

// Replace pg.Pool BEFORE the pool module loads so it gets our mock.
const Module = require('module');
const origResolve = Module._resolveFilename;
const calls = [];
let scenario = [];
const fakePoolInstance = {
  on() {},
  async query(text) {
    calls.push(text);
    const next = scenario.shift();
    if (typeof next === 'object' && next && next.code) {
      // Throw a real Error with a code property so assert.rejects's regex
      // can match against err.message (plain object → "[object Object]").
      const err = new Error(next.message || 'pg error');
      err.code = next.code;
      throw err;
    }
    return { rows: [{ ok: 1 }], rowCount: 1 };
  },
};
require.cache[require.resolve('pg')] = {
  id: 'pg', filename: 'pg', loaded: true,
  exports: { Pool: function () { return fakePoolInstance; } },
};

// Now load the module fresh
delete require.cache[require.resolve('../db/pool')];
const pool = require('../db/pool');

test('queryWithRetry: passes through when query succeeds first try', async () => {
  scenario = [];
  calls.length = 0;
  const r = await pool.queryWithRetry('SELECT 1', []);
  assert.equal(r.rows[0].ok, 1);
  assert.equal(calls.length, 1);
});

test('queryWithRetry: retries on serialization_failure (40001)', async () => {
  scenario = [{ code: '40001', message: 'serialization' }];
  calls.length = 0;
  const r = await pool.queryWithRetry('SELECT 1', [], { attempts: 3, baseDelayMs: 1 });
  assert.equal(r.rows[0].ok, 1);
  assert.equal(calls.length, 2);
});

test('queryWithRetry: retries on deadlock_detected (40P01)', async () => {
  scenario = [{ code: '40P01', message: 'deadlock' }, { code: '40P01', message: 'deadlock' }];
  calls.length = 0;
  const r = await pool.queryWithRetry('SELECT 1', [], { attempts: 3, baseDelayMs: 1 });
  assert.equal(r.rows[0].ok, 1);
  assert.equal(calls.length, 3);
});

test('queryWithRetry: bails on non-transient error', async () => {
  scenario = [{ code: '23505', message: 'unique violation' }];
  calls.length = 0;
  await assert.rejects(
    () => pool.queryWithRetry('INSERT', [], { attempts: 5, baseDelayMs: 1 }),
    /unique/
  );
  assert.equal(calls.length, 1);
});

test('queryWithRetry: gives up after attempts exhausted', async () => {
  scenario = [
    { code: '40001', message: 'a' },
    { code: '40001', message: 'b' },
    { code: '40001', message: 'c' },
  ];
  calls.length = 0;
  await assert.rejects(
    () => pool.queryWithRetry('SELECT 1', [], { attempts: 3, baseDelayMs: 1 }),
    /a|b|c/
  );
  assert.equal(calls.length, 3);
});

test('RETRY_CODES set includes the four transient codes', () => {
  for (const c of ['40001', '40P01', '57P03', '53300']) {
    assert.ok(pool.RETRY_CODES.has(c), 'should include ' + c);
  }
});
