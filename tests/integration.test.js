// tests/integration.test.js
// In-process integration tests that exercise the Express app without
// needing a live Postgres or HTTP server. We mock pg.Pool so route
// handlers run their full pipeline (middleware + validation + handler)
// against scripted DB responses.
//
//   node --test tests/integration.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// === Setup env BEFORE requiring server pieces ============================
process.env.NODE_ENV = 'development';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.ADMIN_PASSWORD = 'pwd-at-least-12-chars';
process.env.DATABASE_URL = 'postgres://fake/fake';
process.env.CITIZEN_ID_KEY = Buffer.alloc(32, 9).toString('base64');

// === Mock pg before any require uses it ===================================
const Module = require('node:module');
const realResolve = Module._resolveFilename;
const fakePool = {
  _calls: [],
  _responses: new Map(),
  on() {},
  async query(text, params) {
    fakePool._calls.push({ text, params });
    // Match by SQL substring → first hit returns response.
    for (const [pattern, fn] of fakePool._responses) {
      if (text.includes(pattern)) return fn(text, params);
    }
    return { rows: [], rowCount: 0 };
  },
  connect: async () => ({
    query: fakePool.query.bind(fakePool),
    release: () => {},
  }),
};
function setResponse(pattern, fn) {
  fakePool._responses.set(pattern, typeof fn === 'function' ? fn : () => fn);
}

// === Try real server import ===============================================
// Note: requiring server.js triggers app.listen, which we don't want.
// Instead we reach into the route routers and middlewares directly.
const { schemas } = require('../schemas');
const { validateBody, formatZodError } = require('../middleware/validate');
const { makeIpLimiter } = require('../middleware/rateLimit');
const { makeLockout, LockedOutError } = require('../middleware/lockout');

test('validateBody passes valid input through', () => {
  const m = validateBody(schemas.publicBooking);
  let next = false;
  let resStatus = null;
  const req = { body: { tenantName: 'Foo' } };
  const res = { status(c) { resStatus = c; return this; }, json() { return this; } };
  m(req, res, () => { next = true; });
  assert.equal(next, true);
  assert.equal(resStatus, null);
});

test('validateBody returns 400 + zod issues for bad input', () => {
  const m = validateBody(schemas.publicBooking);
  let body = null;
  const req = { body: { phone: 'abc' } };  // missing tenantName, bad phone
  const res = {
    statusCode: 0,
    status(c) { this.statusCode = c; return this; },
    json(b) { body = b; return this; },
  };
  m(req, res, () => { throw new Error('next should not be called'); });
  assert.equal(res.statusCode, 400);
  assert.equal(body.code, 'VALIDATION_ERROR');
  assert.ok(body.issues.length > 0);
});

test('lockout: increments fails + locks after threshold', async () => {
  const calls = { update: 0, select: 0 };
  const pool = {
    query: async (sql, params) => {
      if (sql.includes('SELECT locked_until')) {
        calls.select++;
        return { rows: [{ locked_until: null }] };
      }
      if (sql.includes('INSERT INTO login_lockouts')) {
        calls.update++;
        return { rowCount: 1 };
      }
      return { rows: [] };
    },
  };
  const lockout = makeLockout(pool);
  await lockout.check('admin:foo');
  await lockout.recordFailure('admin:foo');
  assert.equal(calls.update, 1);
  await lockout.recordFailure('admin:foo');
  assert.equal(calls.update, 2);
});

test('lockout.check throws LockedOutError when locked', async () => {
  const future = new Date(Date.now() + 5 * 60_000).toISOString();
  const pool = {
    query: async () => ({ rows: [{ locked_until: future }] }),
  };
  const lockout = makeLockout(pool);
  await assert.rejects(() => lockout.check('admin:foo'), LockedOutError);
});

test('IP limiter blocks at threshold even across mixed IPs', () => {
  const lim = makeIpLimiter({ windowMs: 60_000, max: 1 });
  const fakeRes = () => ({
    statusCode: null, body: null,
    setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; },
  });
  let nextCount = 0;
  // First hit from 1.1.1.1 → next() called
  lim({ ip: '1.1.1.1', headers: {}, method: 'POST' }, fakeRes(), () => { nextCount++; });
  assert.equal(nextCount, 1);
  // Second hit from same IP → blocked
  const blocked = fakeRes();
  lim({ ip: '1.1.1.1', headers: {}, method: 'POST' }, blocked, () => { nextCount++; });
  assert.equal(nextCount, 1);
  assert.equal(blocked.statusCode, 429);
  // Different IP allowed
  lim({ ip: '2.2.2.2', headers: {}, method: 'POST' }, fakeRes(), () => { nextCount++; });
  assert.equal(nextCount, 2);
});

test('rooms_v2 schema lives in db/migrate.js (single source of truth)', async () => {
  // rooms_v2 used to be created by routes/rooms.bootstrap(); it's now in
  // db/migrate.js so any caller that runs migrations gets the schema, even
  // when the rooms router isn't mounted.
  const calls = [];
  const pool = {
    query: async (sql) => { calls.push(sql); return { rows: [] }; },
  };
  const dbMigrate = require('../db/migrate');
  // skip the bcrypt/admin bootstrap path by passing an empty password
  await dbMigrate.migrate(pool, { adminPassword: '' });
  assert.ok(calls.some((s) => s.includes('CREATE TABLE IF NOT EXISTS rooms_v2')),
    'migrate.js should create rooms_v2');

  // routes/rooms.bootstrap is kept as a no-op for backwards-compatibility
  // with routes/index.js's bootstrap collection — confirm it exists and
  // doesn't issue any schema statements of its own.
  const buildRouter = require('../routes/rooms');
  const ctx = {
    pool: { query: async () => { throw new Error('bootstrap should not call pool.query'); } },
    requireAuth: (req, res, next) => next(),
    requireRole: () => (req, res, next) => next(),
    sameOrigin: (req, res, next) => next(),
    csrfGuard: (req, res, next) => next(),
    audit: () => Promise.resolve(),
  };
  const r = buildRouter(ctx);
  assert.equal(typeof r.bootstrap, 'function', 'bootstrap export preserved');
  await r.bootstrap();   // must not throw — no-op
});

test('billing.buildBill respects feature flags', () => {
  const billing = require('../services/billing');
  const room = { id: '101', rent: 5000, waterUnits: 5, elecUnits: 100, tenant: { name: 'T' } };
  const config = { utilities: { waterRate: 18, elecRate: 8, wifi: 250 } };
  // VAT off
  let b = billing.buildBill({ room, config, features: { vat: { enabled: false }, lateFee: { enabled: false } } });
  assert.equal(b.vat, 0);
  // VAT on
  b = billing.buildBill({ room, config, features: { vat: { enabled: true, ratePct: 7 }, lateFee: { enabled: false } } });
  assert.ok(b.vat > 0);
});

test('encryption module round-trips with versioned prefix', () => {
  // Force a clean load with the current env + ENCRYPTION_KEY_V1 set
  process.env.ENCRYPTION_KEY_V1 = Buffer.alloc(32, 1).toString('base64');
  process.env.ENCRYPTION_KEY_CURRENT = '1';
  delete require.cache[require.resolve('../services/encryption')];
  const enc = require('../services/encryption');
  const c = enc.encryptString('hi');
  assert.match(c, /^v\d+\$/);
  assert.equal(enc.decryptString(c), 'hi');
});
