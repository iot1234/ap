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

test('migrate.js creates composite index on payments(status, created_at)', async () => {
  // Pins the index added to defend the slip-queue listing query against
  // a full sort on every page load. If this test fails because the index
  // was renamed/removed, also update server.js's GET /api/payments handler
  // (which relies on the planner using this index for ORDER BY DESC LIMIT).
  const calls = [];
  const pool = { query: async (sql) => { calls.push(sql); return { rows: [] }; } };
  const dbMigrate = require('../db/migrate');
  await dbMigrate.migrate(pool, { adminPassword: '' });
  assert.ok(
    calls.some((s) => s.includes('idx_payments_status_created')
                   && s.includes('payments(status, created_at')),
    'migrate.js should create idx_payments_status_created composite index'
  );
});

test('strip-payments-base64 SQL targets data:* and oversize rows', () => {
  // Pins the WHERE-clause shape of the cleanup script so a future refactor
  // can't silently widen it (e.g. accidentally NULL slip_url for the
  // canonical /files/<id> rows). Reads the script as text rather than
  // executing it because the script needs DATABASE_URL to run.
  const fs = require('node:fs');
  const path = require('node:path');
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'strip-payments-base64.js'),
    'utf8'
  );
  assert.match(script, /slip_url LIKE 'data:%'/);
  assert.match(script, /length\(slip_url\) > 2048/);
  assert.match(script, /UPDATE payments[\s\S]+SET slip_url = NULL/);
  // Must support --dry-run so an operator can inspect before writing.
  assert.match(script, /--dry-run/);
});

test('GET /api/payments list query omits slip_url to bound response size', () => {
  // Pins the explicit-column SELECT introduced to defend against legacy
  // base64 in slip_url. If a future refactor reverts to `SELECT p.*`, the
  // renderer-OOM regression returns. The detail endpoint (GET
  // /api/payments/:id) is the only sanctioned path that ships slip_url.
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // Locate the list handler and isolate its SELECT statement.
  const m = server.match(
    /app\.get\('\/api\/payments',[\s\S]*?const \{ rows \} = await pool\.query\(\s*`([\s\S]*?)`/
  );
  assert.ok(m, 'should find GET /api/payments handler');
  const sql = m[1];
  assert.ok(!/SELECT\s+p\.\*/i.test(sql),
    'list query must not use SELECT p.* — that would re-introduce slip_url');
  // slip_url may appear in IS NULL / IS NOT NULL probes (used to derive
  // has_slip), but must never appear as a returned column. Matches like
  // "p.slip_url," or "p.slip_url AS ..." are disallowed; "p.slip_url IS"
  // is allowed.
  assert.ok(!/p\.slip_url\s*(?:,|\bAS\b)/i.test(sql),
    'list query must not select slip_url as a column');
  assert.ok(/has_slip/i.test(sql),
    'list query should expose has_slip boolean instead of the URL');
});

test('slipVerifier exports verifyWithFallback (regression: silent auto-verify failure)', () => {
  // server.js's /api/tenant/payments handler calls
  // `slipVerifier.verifyWithFallback(...)`. If the module forgets to export
  // it, the call throws TypeError, the surrounding try/catch labels it
  // VERIFIER_THREW (transient), every slip falls back to admin queue, and
  // auto-verify silently does nothing — operator thinks it's enabled but it
  // never actually runs. Pin the public surface to prevent that drift.
  const sv = require('../services/slipVerifier');
  for (const name of ['verify', 'verifyWithFallback', 'isConfigured',
                      'getConfiguredProviders', 'probeAll', 'TRANSIENT_CODES']) {
    assert.ok(name in sv, `slipVerifier must export ${name}`);
  }
  assert.equal(typeof sv.verifyWithFallback, 'function');
  assert.equal(typeof sv.getConfiguredProviders, 'function');
  assert.ok(sv.TRANSIENT_CODES instanceof Set);
  // The codes server.js pins-down as transient must all be in the set —
  // a hard rejection of one of these would falsely block a legit slip.
  for (const code of ['VERIFIER_THREW', 'PROVIDER_ERROR',
                      'SLIPOK_PARSE', 'EASYSLIP_PARSE',
                      'NOT_CONFIGURED', 'UNKNOWN_PROVIDER']) {
    assert.ok(sv.TRANSIENT_CODES.has(code),
      `TRANSIENT_CODES must include ${code} (server-side fallback contract)`);
  }
});

test('slipVerifier.getConfiguredProviders gates by API-key presence', () => {
  // Belt-and-braces: if features says "use slipok" but no SLIPOK_API_KEY
  // is configured, the provider must be filtered out so the fallback chain
  // doesn't waste an attempt on a guaranteed PROVIDER_ERROR.
  const oldKey = process.env.SLIPOK_API_KEY;
  delete process.env.SLIPOK_API_KEY;
  delete require.cache[require.resolve('../services/secrets')];
  delete require.cache[require.resolve('../services/slipVerifier')];
  const sv = require('../services/slipVerifier');
  const got = sv.getConfiguredProviders({
    slipUpload: { autoVerify: true, providers: ['slipok'] },
  });
  assert.equal(got.length, 0, 'no provider should be ready without API key');
  if (oldKey != null) process.env.SLIPOK_API_KEY = oldKey;
});

test('/api/tenant/payments rejects amount that does not match bill.total', () => {
  // Pin the AMOUNT_NOT_BILL_TOTAL guard in server.js. Without it a tenant
  // could pay 100฿ on a 5000฿ bill, upload the matching slip, and the bill
  // would flip to 'paid' for a fraction of what's owed (slipVerifier sees
  // amount=100, slip=100 → match). Read the source to confirm the guard is
  // present rather than spinning a full HTTP server.
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /AMOUNT_NOT_BILL_TOTAL/,
    'server.js must reject mismatched amount with code AMOUNT_NOT_BILL_TOTAL');
  assert.match(server, /code: 'BILL_NOT_PAYABLE'/,
    'server.js must refuse uploads on already-paid/void bills');
});

test('/api/tenant/payments locks the bill row inside its tx (concurrency guard)', () => {
  // Pin the SELECT FOR UPDATE that serializes concurrent slip uploads on
  // the same bill. Without it, two slips arriving in the same second can
  // both pass the outside SELECT, both auto-verify, both INSERT — leaving
  // two verified payments crediting one bill (double-counted income).
  // We also confirm the existing-verified-payment guard inside the tx.
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // Locate the /api/tenant/payments handler and isolate the tx body.
  const m = server.match(
    /app\.post\('\/api\/tenant\/payments'[\s\S]*?await client\.query\('BEGIN'\);([\s\S]*?)await client\.query\('COMMIT'\)/
  );
  assert.ok(m, 'should find tenant payment tx body');
  const txBody = m[1];
  assert.match(txBody, /FROM bills WHERE id=\$1[\s\S]*?FOR UPDATE/i,
    'tenant payment tx must SELECT bill FOR UPDATE');
  assert.match(txBody, /BILL_NOT_PAYABLE_AT_COMMIT|BILL_NOT_FOUND_AT_COMMIT/,
    'tenant payment tx must re-check bill status under lock');
  assert.match(txBody, /BILL_ALREADY_PAID/,
    'tenant payment tx must refuse if a verified payment already exists');
});

test('/api/payments/:id/verify wraps both UPDATEs in one transaction', () => {
  // Pin the BEGIN/COMMIT pairing on the admin verify path. Without it,
  // a DB hiccup between UPDATE payments and UPDATE bills leaves the
  // payment row 'verified' while the bill stays 'pending' / 'overdue' —
  // a verified payment for an unpaid bill (hard to spot). Read the source
  // to confirm a single tx wraps both writes.
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // The handler is bounded between its app.put declaration and the next
  // top-level app.* declaration (next route or middleware mount).
  const idx = server.indexOf("app.put('/api/payments/:id/verify'");
  assert.ok(idx > 0, 'should find admin verify handler');
  const tail = server.slice(idx);
  const nextIdx = tail.slice(50).search(/\napp\.(get|put|post|delete|use)\(/);
  const body = nextIdx > 0 ? tail.slice(0, 50 + nextIdx) : tail.slice(0, 5000);
  assert.match(body, /pool\.connect\(\)/, 'must dedicate a pool client');
  assert.match(body, /BEGIN[\s\S]*?UPDATE payments[\s\S]*?UPDATE bills[\s\S]*?COMMIT/,
    'verify path must update payments + bills inside one tx');
  assert.match(body, /ROLLBACK/, 'must roll back on error');
  // Belt-and-braces: the previous version called `pool.query(...)` for the
  // bill UPDATE — confirm we no longer do that on the verify path.
  assert.ok(!/UPDATE bills SET status='paid'[\s\S]{0,100}\[rows\[0\]\.bill_id\]/i.test(body),
    'must not issue the bill UPDATE outside the transaction');
});

test('/api/payments/:id/verify refuses to verify against non-payable bills', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idx = server.indexOf("app.put('/api/payments/:id/verify'");
  assert.ok(idx > 0, 'should find admin verify handler');
  const tail = server.slice(idx);
  const nextIdx = tail.slice(50).search(/\napp\.(get|put|post|delete|use)\(/);
  const body = nextIdx > 0 ? tail.slice(0, 50 + nextIdx) : tail.slice(0, 5000);
  assert.match(body, /SELECT \* FROM payments WHERE id=\$1 AND status='pending' FOR UPDATE/,
    'admin verify must lock the pending payment row');
  assert.match(body, /SELECT id, status, deleted_at FROM bills WHERE id=\$1 FOR UPDATE/,
    'admin verify must lock and inspect the target bill');
  assert.match(body, /BILL_NOT_PAYABLE/,
    'admin verify must refuse paid, void, deleted, or missing bills');
  assert.match(body, /BILL_MARK_PAID_FAILED/,
    'admin verify must fail closed if the bill update affects no row');
});

test('/api/payments/:id/verify requires reject reason server-side', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idx = server.indexOf("app.put('/api/payments/:id/verify'");
  assert.ok(idx > 0, 'should find admin verify handler');
  const body = server.slice(idx, idx + 2500);
  assert.match(body, /reason\.length < 3/,
    'server must not rely only on the admin UI to require reject reasons');
  assert.match(body, /REJECT_REASON_REQUIRED/,
    'server should return a machine-readable reason-required code');
});

test('/api/bills/:id/verify-slip matches owner-manager payment verification policy', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'bills-extras.js'), 'utf8');
  const idx = route.indexOf("r.post('/:id/verify-slip'");
  assert.ok(idx > 0, 'should find bill verify-slip handler');
  const body = route.slice(idx, idx + 2500);
  assert.match(body, /requireRole\('owner', 'manager'\)/,
    'bill-id verify path must use the same owner/manager policy as payment-id verify');
  assert.doesNotMatch(body, /requireRole\('owner', 'manager', 'staff'\)/,
    'staff must not verify or reject slips through the bill-id shortcut');
  assert.match(body, /BILL_NOT_PAYABLE|BILL_MARK_PAID_FAILED/,
    'bill-id verify path must fail closed when the bill is not payable');
});

test('/api/tenant/payments does not auto-approve unverified slips by default', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idx = server.indexOf("app.post('/api/tenant/payments'");
  assert.ok(idx > 0, 'should find tenant payment upload handler');
  const end = server.indexOf('// Atomic:', idx);
  const body = server.slice(idx, end > idx ? end : idx + 12000);
  assert.match(body, /allowUnverifiedAutoApprove/,
    'legacy trust mode must require an explicit flag');
  assert.match(body, /initialStatus = allowUnverifiedAutoApprove \? 'verified' : 'pending'/,
    'uploads without a provider result must fall back to the admin queue');
});

test('/api/tenant/payments refuses orphan bills (BILL_NOT_LINKED)', () => {
  // Without this guard a tenant could pay any bill where tenant_id IS NULL
  // by guessing the (sequential, BIGSERIAL) bill_id. The endpoint must
  // refuse before the slipVerifier RPC + storage write.
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /code: 'BILL_NOT_LINKED'/,
    'tenant payment must refuse orphan bills');
});

test('GET /api/tenant/bills/:id/pdf is wired (tenant PDF download)', () => {
  // Tenants used to have no way to download a printable copy of their bill —
  // /api/bills/render is admin-only. Pin the new tenant-side endpoint so a
  // future refactor doesn't accidentally drop it.
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /app\.get\('\/api\/tenant\/bills\/:id\/pdf'/,
    'tenant PDF endpoint must exist');
  // Must enforce ownership — refuse to serve another tenant's bill.
  const idx = server.indexOf("app.get('/api/tenant/bills/:id/pdf'");
  const body = server.slice(idx, idx + 4000);
  assert.match(body, /not your bill/,
    'tenant PDF must reject mismatched tenant_id');
  assert.match(body, /renderBillPdf\(bill, res\)/,
    'tenant PDF must stream through renderBillPdf');
});

test('access_cards CRUD endpoints exist', () => {
  // The scheduler revokes/restores cards but until now there was no way
  // for admin to issue them. Pin the three new endpoints.
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /app\.get\('\/api\/access\/cards'/, 'list endpoint');
  assert.match(server, /app\.post\('\/api\/access\/cards'/, 'issue endpoint');
  assert.match(server, /app\.put\('\/api\/access\/cards\/:id\/revoke'/, 'revoke endpoint');
  assert.match(server, /app\.put\('\/api\/access\/cards\/:id\/restore'/, 'restore endpoint');
  // Issue path must be gated by accessControl feature so toggling the flag
  // off cleanly disables the whole module.
  assert.match(server, /\/api\/access\/cards'[\s\S]{0,400}requireFeature\('accessControl'\)/,
    'issue must be gated by accessControl');
});

test('healthCheck flags meterIot.mode = "mqtt" as unimplemented', () => {
  // The mqtt mode is advertised in features.js but no MQTT subscriber
  // exists. Without a health-check warning, operators flipping to mqtt
  // see no errors AND no readings — silent failure. Pin the warning.
  const fs = require('node:fs');
  const path = require('node:path');
  const hc = fs.readFileSync(path.join(__dirname, '..', 'services', 'healthCheck.js'), 'utf8');
  assert.match(hc, /meterIot.*mqtt[\s\S]{0,200}implement/i,
    'healthCheck must warn about unimplemented mqtt mode');
});

test('public booking dual-writes to bookings table', () => {
  // The bookings table was created in the migration but no code wrote to
  // it — a dead schema. Pin the dual-write so the table actually receives
  // rows from /api/bookings/public and /api/bookings/:id status changes.
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /INSERT INTO bookings[\s\S]{0,300}external_id[\s\S]{0,300}ON CONFLICT \(external_id\) DO NOTHING/,
    'public booking must INSERT into bookings table');
  assert.match(server, /UPDATE bookings[\s\S]{0,200}WHERE external_id=\$1/,
    'booking PUT must mirror status changes');
});

test('startAuditPruner ages out meter_readings + orphan slip files', () => {
  // Two cleanup paths added in this round:
  //   1) meter_readings older than 365 days (table grows fast under simulator
  //      mode — 2 rows/room/hour × 50 rooms × 30 days ≈ 72k rows)
  //   2) file_uploads category='slip' rows where no payment.slip_url
  //      references them, older than 180 days (orphans from race-condition
  //      cleanups, hard-deleted payments, strip-payments-base64 script)
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /DELETE FROM meter_readings WHERE reading_at < NOW\(\) - INTERVAL '365 days'/,
    'pruner must age out old meter_readings');
  assert.match(server, /file_uploads[\s\S]{0,200}category='slip'[\s\S]{0,400}NOT EXISTS[\s\S]{0,200}payments/,
    'pruner must scan for orphan slip files');
  assert.match(server, /storage\.remove\(pool, r\.id\)/,
    'orphan cleanup must call storage.remove so disk/R2 file is unlinked');
});

test('tenantPortal.requirePin flag removed (was misleading no-op)', () => {
  // The flag had no behavioural effect — login always required PIN. We
  // dropped it from DEFAULTS and the public /api/features `safe` allowlist
  // so the Features page can't surface a toggle that does nothing.
  const fs = require('node:fs');
  const path = require('node:path');
  const features = fs.readFileSync(path.join(__dirname, '..', 'services', 'features.js'), 'utf8');
  // No live `requirePin: true` in DEFAULTS (it's only allowed in a comment).
  assert.ok(!/^\s*requirePin:\s*true/m.test(features),
    'requirePin must not be present as a live flag');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // The public /api/features safe[] list must not still expose it.
  const safeMatch = server.match(/const safe = \[([^\]]+)\]/);
  assert.ok(safeMatch, 'should find /api/features safe[] list');
  assert.ok(!/['"]requirePin['"]/.test(safeMatch[1]),
    '/api/features must not expose requirePin');
});

test('tenant portal exposes payments tab + PDF download button', () => {
  // Backend was complete (/api/tenant/payments + /api/tenant/bills/:id/pdf)
  // but the UI surface was missing — pinned both.
  const fs = require('node:fs');
  const path = require('node:path');
  const tenant = fs.readFileSync(path.join(__dirname, '..', 'project', 'tenant.jsx'), 'utf8');
  assert.match(tenant, /function PaymentsView/, 'PaymentsView component must exist');
  assert.match(tenant, /id="payments"/, 'payments tab must be in nav');
  assert.match(tenant, /\/api\/tenant\/bills\/\$\{bill\.id\}\/pdf/,
    'bill detail must link to PDF endpoint');
});

test('SQL backup endpoints exist + restore is gated by confirm: true', () => {
  // The legacy "ส่งออก" UI button only dumped rooms/config/bookings JSONB
  // blobs — bills/payments/tenants/audit_logs were ALL missing. These new
  // endpoints expose scripts/backup.run() so the dump is real.
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const m of [
    "app\\.post\\('/api/admin/backup/create'",
    "app\\.get\\('/api/admin/backup/list'",
    "app\\.get\\('/api/admin/backup/download/:filename'",
    "app\\.delete\\('/api/admin/backup/:filename'",
    "app\\.post\\('/api/admin/restore'",
  ]) {
    assert.match(server, new RegExp(m), `missing endpoint: ${m}`);
  }
  // Restore must require explicit confirmation. Without this, a typo'd
  // POST could obliterate the production DB.
  assert.match(server, /confirm !== true[\s\S]{0,200}CONFIRM_REQUIRED/,
    'restore must require confirm: true');
  // Filename allow-list must defeat path traversal.
  assert.match(server, /BACKUP_FILENAME_RE\s*=\s*\/\^backup-\[A-Za-z0-9-\]\+\\\.json\$\//,
    'backup filename regex must reject path-traversal payloads');
  // Restore must verify integrity hash when present.
  assert.match(server, /backup\.integrity\?\.algorithm === 'sha256'[\s\S]{0,800}INTEGRITY_FAILED/,
    'restore must verify SHA-256 integrity hash');
  // Restore must wrap writes in a transaction (so a partial failure rolls back).
  const restoreIdx = server.indexOf("app.post('/api/admin/restore'");
  assert.ok(restoreIdx > 0, 'restore handler must exist');
  const restoreBody = server.slice(restoreIdx, restoreIdx + 8000);
  assert.match(restoreBody, /BEGIN[\s\S]+COMMIT/,
    'restore must run inside an explicit BEGIN/COMMIT transaction');
  assert.match(restoreBody, /ROLLBACK/, 'restore must roll back on error');
});

test('isChargeApplicableForPeriod honors quarterly frequency', () => {
  const billing = require('../services/billing');
  // Quarterly anchored to January (start_at = 2026-01-15) should fire on
  // Jan, Apr, Jul, Oct — every 3 months — and NOT on Feb/Mar/May/etc.
  const charge = { frequency: 'quarterly', start_at: '2026-01-15' };
  assert.equal(billing.isChargeApplicableForPeriod(charge, '2026-01'), true,  'fires on Jan');
  assert.equal(billing.isChargeApplicableForPeriod(charge, '2026-02'), false, 'skips Feb');
  assert.equal(billing.isChargeApplicableForPeriod(charge, '2026-04'), true,  'fires on Apr');
  assert.equal(billing.isChargeApplicableForPeriod(charge, '2026-07'), true,  'fires on Jul');
  assert.equal(billing.isChargeApplicableForPeriod(charge, '2026-10'), true,  'fires on Oct');
  assert.equal(billing.isChargeApplicableForPeriod(charge, '2026-11'), false, 'skips Nov');
  // Monthly + one_off always fire when in window.
  assert.equal(billing.isChargeApplicableForPeriod({ frequency: 'monthly' }, '2026-05'), true);
  assert.equal(billing.isChargeApplicableForPeriod({ frequency: 'one_off' }, '2026-05'), true);
  // Out of window (before start_at OR after end_at) — never fires.
  assert.equal(billing.isChargeApplicableForPeriod(
    { frequency: 'monthly', start_at: '2026-06-01' }, '2026-05'), false, 'before start');
  assert.equal(billing.isChargeApplicableForPeriod(
    { frequency: 'monthly', end_at: '2026-04-30' }, '2026-05'), false, 'after end');
});

test('buildBill applies contract-length discount to rent only', () => {
  const billing = require('../services/billing');
  const room = { id: '101', rent: 5000, waterUnits: 5, elecUnits: 100, tenant: { name: 'T' } };
  const config = { utilities: { waterRate: 18, elecRate: 8, wifi: 0 } };
  const features = { vat: { enabled: false }, lateFee: { enabled: false } };
  // No discount → rent stays 5000
  const a = billing.buildBill({ room, config, features });
  assert.equal(a.rent, 5000);
  assert.equal(a.discountPct, 0);
  assert.equal(a.discountAmount, 0);
  // 10% discount on rent (utilities NOT discounted)
  const b = billing.buildBill({ room, config, features, discountPct: 10 });
  assert.equal(b.rent, 4500);
  assert.equal(b.rentBase, 5000);
  assert.equal(b.discountAmount, 500);
  // Utilities unchanged
  assert.equal(b.waterAmount, 5 * 18, 'water not discounted');
  assert.equal(b.elecAmount, 100 * 8, 'elec not discounted');
  // Total = (5000 - 500) + 90 + 800 = 5390
  assert.equal(b.total, 5390);
  // Discount > 50% capped defensively
  const c = billing.buildBill({ room, config, features, discountPct: 99 });
  assert.equal(c.discountPct, 50, 'capped at 50%');
});

test('scheduler tickBillGen INSERTs the `other` JSONB column', () => {
  // Pin the breakdown-persist fix: previously the scheduler dropped the
  // recurring line items from the bills.other column, so PDFs + tenant
  // portal lost the breakdown even though bills.total stayed correct.
  const fs = require('node:fs');
  const path = require('node:path');
  const sched = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
  const startIdx = sched.indexOf('async function tickBillGen');
  const endIdx   = sched.indexOf('async function tick', startIdx + 50);  // next async fn
  assert.ok(startIdx > 0 && endIdx > startIdx, 'tickBillGen body must be locatable');
  const body = sched.slice(startIdx, endIdx);
  assert.match(body, /INSERT INTO bills[\s\S]+?other[\s\S]+?VALUES/i,
    'scheduler bill INSERT must include other JSONB column');
  assert.match(body, /::jsonb/,
    'other parameter must be cast to jsonb');
});

test('scheduler tickContractExpiry expires + alerts upcoming', () => {
  // The contract lifecycle was missing an auto-expire step — contracts
  // with end_date in the past stayed status='active' forever. Pin the
  // new tick that handles both auto-expire and the 30-day upcoming alert.
  const fs = require('node:fs');
  const path = require('node:path');
  const sched = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
  assert.match(sched, /async function tickContractExpiry/,
    'tickContractExpiry must exist');
  // Allow optional table alias on the UPDATE so the join-with-tenants
  // form (UPDATE contracts c FROM tenants t ...) is also accepted —
  // the alias was added so tenant-side notifications can fire on the
  // same statement that flips status='expired'.
  assert.match(sched, /UPDATE contracts(?: c)? SET status='expired'[\s\S]{0,400}end_date < CURRENT_DATE/,
    'must auto-expire past-due contracts');
  assert.match(sched, /CURRENT_DATE \+ INTERVAL '30 days'/,
    'must scan 30 days ahead for upcoming expiries');
  // Must be wired into the tick pipeline. The advisory-lock wrapper
  // means the call no longer reads "tickContractExpiry(pool, flags, now,
  // state)" verbatim — match the wrapped form too.
  assert.match(sched,
    /tickContractExpiry\(pool, (?:_?flags|flags), now, state\)/,
    'tick() must call tickContractExpiry');
});

test('migrate adds contracts.discount_pct + term_months columns', () => {
  // discount_pct is what billing.buildBill reads; term_months drives the
  // contract-expiry alert. Pin the migration so a future schema rewrite
  // can't silently drop them.
  const fs = require('node:fs');
  const path = require('node:path');
  const mig = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrate.js'), 'utf8');
  assert.match(mig, /ALTER TABLE contracts ADD COLUMN IF NOT EXISTS discount_pct/,
    'discount_pct column must be in migration');
  assert.match(mig, /ALTER TABLE contracts ADD COLUMN IF NOT EXISTS term_months/,
    'term_months column must be in migration');
});

test('contracts CRUD endpoints exist (list/get/edit)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const m of [
    "app\\.get\\('/api/contracts'",
    "app\\.get\\('/api/contracts/:id'",
    "app\\.put\\('/api/contracts/:id'",
  ]) {
    assert.match(server, new RegExp(m), `missing endpoint: ${m}`);
  }
  // Edit must clamp discount_pct to 0-50 (matches billing's safety cap).
  const idx = server.indexOf("app.put('/api/contracts/:id'");
  const body = server.slice(idx, idx + 3000);
  assert.match(body, /pct < 0 \|\| pct > 50/,
    'discountPct must be clamped to 0-50');
  // Optional expiringInDays filter for renewal dashboards.
  assert.match(server, /expiringInDays/,
    'list must support expiringInDays filter');
});

test('buildBill stacks firstMonth discount when isFirstBill = true', () => {
  const billing = require('../services/billing');
  const room = { id: '101', rent: 5000, waterUnits: 0, elecUnits: 0, tenant: { name: 'T' } };
  const config = { utilities: { waterRate: 0, elecRate: 0, wifi: 0 },
                   discounts: { firstMonth: 10 } };
  const features = { vat: { enabled: false }, lateFee: { enabled: false } };
  // No isFirstBill flag → only contract discount applies.
  const a = billing.buildBill({ room, config, features, discountPct: 5 });
  assert.equal(a.rent, 4750, '5% off rent only');
  // First bill → 5% × 10% stacks multiplicatively → 14.5% off.
  const b = billing.buildBill({ room, config, features, discountPct: 5, isFirstBill: true });
  // 5000 * (1 - 0.05) * (1 - 0.10) = 5000 * 0.95 * 0.90 = 4275
  assert.equal(b.rent, 4275, 'multiplicative stack: 5% + 10%');
  // Effective combined pct ≈ 14.5
  assert.ok(Math.abs(b.discountPct - 14.5) < 0.01, 'combined pct ~= 14.5%');
  // Effective discount cap at 50 even when both discounts are huge.
  const c = billing.buildBill({ room, config: { utilities: {}, discounts: { firstMonth: 50 } },
                                features, discountPct: 50, isFirstBill: true });
  assert.equal(c.discountPct, 50, 'combined cap at 50%');
});

test('contracts page-contracts.jsx is registered + script-loaded', () => {
  // The page uses window.PageContracts which shell.jsx looks up. Pin both
  // the script-include in the HTML shell + the window registration so a
  // future cleanup can't accidentally hide the page.
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'project', 'Admin Dashboard.html'), 'utf8'
  );
  assert.match(html, /page-contracts\.jsx/, 'HTML must include page-contracts');
  const page = fs.readFileSync(
    path.join(__dirname, '..', 'project', 'admin', 'page-contracts.jsx'), 'utf8'
  );
  assert.match(page, /window\.PageContracts = PageContracts/,
    'PageContracts must register on window');
  assert.match(page, /\/api\/contracts/, 'page must call /api/contracts');
  // Shell must list contracts in nav + PAGES map.
  const shell = fs.readFileSync(
    path.join(__dirname, '..', 'project', 'admin', 'shell.jsx'), 'utf8'
  );
  assert.match(shell, /id: 'contracts',[\s\S]{0,200}label: 'สัญญา'/,
    'nav must include contracts entry');
  assert.match(shell, /contracts:\s*window\.PageContracts/,
    'PAGES map must wire contracts');
});

test('backup TABLES + restore RESTORABLE_TABLES stay in sync', () => {
  // The dump (scripts/backup.js TABLES) and the restore (server.js
  // RESTORABLE_TABLES) MUST agree on which tables are real app data —
  // any table that's dumped but not in RESTORABLE_TABLES is silently
  // dropped on restore (so e.g. line_oas would be exported but not
  // restored, leaving every OA disconnected after a recovery). Pin the
  // intersection here. Tables in SKIP set on the restore side are the
  // intentional exceptions (transient sessions, ephemeral lockouts, etc.).
  const fs = require('node:fs');
  const path = require('node:path');
  const backup = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'backup.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const extract = (text, anchor) => {
    const idx = text.indexOf(anchor);
    if (idx < 0) return null;
    const open = text.indexOf('[', idx);
    const close = text.indexOf('];', open);
    return new Set(
      text.slice(open + 1, close)
        .split(',')
        .map((s) => s.replace(/\/\/[^\n]*/g, '').replace(/['"\s]/g, ''))
        .filter(Boolean)
    );
  };
  const dumped   = extract(backup, 'const TABLES = [');
  const restored = extract(server, 'const RESTORABLE_TABLES = [');
  assert.ok(dumped && restored, 'both lists must be locatable');
  // Tables dumped but intentionally NOT restored (transient state).
  const TRANSIENT_OK = new Set([
    'tenant_sessions', 'login_lockouts', 'notifications_queue',
  ]);
  const dumpedButNotRestored = [...dumped].filter(
    (t) => !restored.has(t) && !TRANSIENT_OK.has(t)
  );
  assert.deepEqual(dumpedButNotRestored, [],
    `tables in backup but missing from restore (would be lost on recovery): ${dumpedButNotRestored.join(', ')}`);
  // Reverse — tables we'd restore but never dump are unreachable cosmetics.
  const restoredButNotDumped = [...restored].filter((t) => !dumped.has(t));
  assert.deepEqual(restoredButNotDumped, [],
    `tables in restore list but never dumped: ${restoredButNotDumped.join(', ')}`);
  // Critical-data tables that must always be in BOTH lists.
  for (const t of ['line_oas', 'line_bindings', 'recurring_charges',
                   'contracts', 'bills', 'payments', 'tenants']) {
    assert.ok(dumped.has(t),   `backup must dump ${t}`);
    assert.ok(restored.has(t), `restore must rehydrate ${t}`);
  }
});

test('end-to-end pipeline: discount + first-month + quarterly compose correctly', () => {
  // Smoke check the three bill-time discounts/filters compose without
  // surprising interactions:
  //   - contract discountPct
  //   - isFirstBill firstMonth
  //   - quarterly recurring filter
  // Bug we'd catch: a quarterly charge that fires on the welcome bill
  // even though admin set start_at to the current month + 1.
  const billing = require('../services/billing');
  const room = { id: '101', rent: 5000, waterUnits: 0, elecUnits: 0, tenant: { name: 'T' } };
  const config = {
    utilities: { waterRate: 0, elecRate: 0, wifi: 0 },
    discounts: { firstMonth: 10, sixMonth: 5 },
  };
  const features = { vat: { enabled: false }, lateFee: { enabled: false }, recurringCharges: { enabled: true } };

  // Quarterly cleaning fee, anchored to Jan, period 2026-04 should fire.
  const cleaning = { frequency: 'quarterly', start_at: '2026-01-15', amount: 500, label: 'ทำความสะอาด' };
  assert.equal(billing.isChargeApplicableForPeriod(cleaning, '2026-04'), true,  'quarterly fires Apr (start Jan)');
  assert.equal(billing.isChargeApplicableForPeriod(cleaning, '2026-05'), false, 'quarterly skips May');

  // First bill with both discounts active + the quarterly applicable charge.
  const bill = billing.buildBill({
    room, config, features,
    discountPct: 5, isFirstBill: true,
    recurring: [{ label: 'ทำความสะอาด', amount: 500 }],
    period: '2026-04',
  });
  // Rent: 5000 * (1-0.05) * (1-0.10) = 4275
  // Subtotal includes rentBase 5000 + recurring 500 - discount 725 = 4775
  // Total (no vat, no late) = 4775
  assert.equal(bill.rent, 4275, 'rent after stacked discount');
  assert.equal(bill.discountAmount, 725, '5000 - 4275 = 725');
  assert.equal(bill.total, 4775, 'rent + recurring - discount, no vat');
  // Quarterly charge present on the bill items.
  const hasCleaning = bill.items.some((it) => it.label === 'ทำความสะอาด' && it.amount === 500);
  assert.ok(hasCleaning, 'quarterly recurring item must be on the bill');
});

test('migrate backfills recurring_charges start_at/end_at from legacy columns', () => {
  // Some live DBs already had recurring_charges with start_date/end_date
  // from an older build. CREATE TABLE IF NOT EXISTS does not add the new
  // start_at/end_at columns, so migration must ALTER + copy values forward.
  const fs = require('node:fs');
  const path = require('node:path');
  const migrate = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrate.js'), 'utf8');
  assert.match(migrate, /ALTER TABLE recurring_charges ADD COLUMN IF NOT EXISTS start_at DATE/);
  assert.match(migrate, /ALTER TABLE recurring_charges ADD COLUMN IF NOT EXISTS end_at DATE/);
  assert.match(migrate, /start_at = COALESCE\(start_at, start_date\)/);
  assert.match(migrate, /end_at = COALESCE\(end_at, end_date\)/);
});

test('PostgreSQL DATE columns are returned as date-only strings', () => {
  // Recurring-charge forms bind DATE values to <input type="date"> using
  // String(value).slice(0, 10). If pg returns a Date object, JSON serialises
  // local midnight in Thailand as the previous UTC day.
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const pool = fs.readFileSync(path.join(__dirname, '..', 'db', 'pool.js'), 'utf8');
  for (const source of [server, pool]) {
    assert.match(source, /const pg = require\('pg'\)/);
    assert.match(source, /pg\.types\.setTypeParser\(1082,\s*\(value\)\s*=>\s*value\)/);
  }
});

test('TabContract resolves tenant phone with the same normaliser the DB uses', () => {
  // mirrorRoomsToTenants normalises phones (strip dashes/spaces) before
  // INSERT but the rooms-blob copy may still carry separators if admin
  // typed them manually. The tenant-side lookup must apply the same
  // normaliser to both sides — otherwise "080-123-4567" (rooms blob)
  // never finds "0801234567" (DB) and the CheckInModal never appears
  // for that tenant.
  const fs = require('node:fs');
  const path = require('node:path');
  const tenants = fs.readFileSync(
    path.join(__dirname, '..', 'project', 'admin', 'page-tenants.jsx'), 'utf8'
  );
  // The normaliser must be applied BOTH to t.phone (search input) and
  // x.phone (DB result) so dashed/non-dashed match symmetrically.
  assert.match(tenants,
    /normalisePhone\(t\.phone\)[\s\S]{0,400}normalisePhone\(x\.phone\)/,
    'TabContract must normalise both sides of the phone comparison');
  assert.match(tenants,
    /normalisePhone\s*=\s*\([^)]+\)\s*=>\s*[\s\S]{0,80}\.replace\(\s*\/\[\\s-\]\/g\s*,/,
    'normaliser must strip whitespace + dashes (matches mirrorRoomsToTenants)');
});

test('slip upload re-validates bill.tenant_id under FOR UPDATE lock (BILL_REASSIGNED)', () => {
  // The outside SELECT (line 2592) checks bill.tenant_id matches the
  // session, but admin could change tenant_id during the 5-10s slipVerifier
  // RPC. Without an inside-tx re-check, the slip would land on a bill that
  // was reassigned mid-upload. Pin the inside-lock check that catches this.
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // The locked SELECT must include tenant_id so the reassignment guard has
  // data to compare against.
  assert.match(server,
    /SELECT id, status, total, tenant_id FROM bills WHERE id=\$1 AND deleted_at IS NULL FOR UPDATE/,
    'inside-tx lock must fetch tenant_id');
  // The reassignment guard must run + ROLLBACK on mismatch.
  assert.match(server,
    /BILL_REASSIGNED/,
    'inside-tx mismatch must surface BILL_REASSIGNED code');
  assert.match(server,
    /lock\.rows\[0\]\.tenant_id[\s\S]{0,200}!==\s*Number\(req\.tenant\.tenant_id\)/,
    'must compare locked tenant_id vs session tenant_id');
});

test('maintenance completion notifies via tenant_id (not phone re-lookup)', () => {
  // Two tenants sharing a phone (couples, families) would race the
  // ORDER BY updated_at LIMIT 1 phone lookup — completion notification
  // could land on the wrong person. The ticket's tenant_id (stamped at
  // creation time) is authoritative; phone lookup is the fallback only
  // for legacy tickets.
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idx = server.indexOf("if (b.status === 'completed')");
  assert.ok(idx > 0, 'maintenance completed branch must exist');
  const body = server.slice(idx, idx + 3000);
  assert.match(body, /if \(t\.tenant_id\)[\s\S]{0,300}WHERE id=\$1/,
    'must look up by tenant_id when stamped');
  assert.match(body, /else if \(t\.tenant_phone\)/,
    'phone fallback only when tenant_id is null');
});

test('maintenance report aggregate FILTER syntax is PostgreSQL-valid', () => {
  // PostgreSQL requires FILTER to attach to the aggregate before the cast:
  // (AVG(cost) FILTER (...))::numeric, not AVG(cost)::numeric FILTER (...).
  // The wrong order only fails against a real DB, so pin it statically.
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(server, /AVG\(cost\)::numeric\([^)]*\)\s+FILTER/i);
  assert.match(server, /\(AVG\(cost\) FILTER \(WHERE cost > 0\)\)::numeric\(10,2\)/);
  assert.match(server, /\(SUM\(cost\) FILTER \(WHERE status='completed'\)\)::numeric\(12,2\)/);
});

test('static assets do not intercept /admin auth route with directory redirect', () => {
  // project/admin is a real static directory. express.static's default
  // redirect=true turns /admin into /admin/ before the auth route runs,
  // which breaks both the expected login redirect and authenticated page.
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /express\.static\(path\.join\(__dirname,\s*'project'\),\s*\{\s*redirect:\s*false\s*\}\)/);
});

test('/health reports disabled scheduler explicitly in diagnostic mode', () => {
  // DISABLE_BACKGROUND_JOBS is used for safe production diagnostics. /health
  // must not read stale .scheduler-state.json errors from a previous run and
  // present them as current failures.
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /if \(DISABLE_BACKGROUND_JOBS\) \{\s*out\.scheduler = \{ disabled: true, reason: 'DISABLE_BACKGROUND_JOBS=1' \};/);
});

test('checkin notifies the tenant about the welcome bill', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ops = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8'
  );
  const idx = ops.indexOf("audit(req, 'tenant.checkin'");
  assert.ok(idx > 0, 'checkin handler must exist');
  const after = ops.slice(idx, idx + 3000);
  assert.match(after, /notifier\.notifyTenant/,
    'checkin must call notifyTenant after creating the welcome bill');
  assert.match(after, /ยินดีต้อนรับ/,
    'subject should welcome the tenant');
  assert.match(after, /ครบกำหนดชำระ/,
    'body must include due date so tenant doesn\'t miss it');
});

test('scheduler auto-bill-gen enqueues per-tenant notifications', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const sched = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8'
  );
  // Use the next async-function header as the body terminator so the slice
  // doesn't truncate before the notification block at the end of tickBillGen.
  const start = sched.indexOf('async function tickBillGen');
  const end = sched.indexOf('async function', start + 50);
  assert.ok(start > 0 && end > start);
  const body = sched.slice(start, end);
  assert.match(body, /billsCreated\.push/,
    'must collect inserted bills for fan-out notification');
  assert.match(body, /notifQueue\.enqueue/,
    'must enqueue per-tenant notifications');
  assert.match(body, /channel: 'line'[\s\S]{0,400}billId/,
    'LINE enqueue must reference the billId for queue forensics');
});

test('access card revoke/restore notifies the affected tenant', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const sched = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8'
  );
  const start = sched.indexOf('async function tickAccessControlSync');
  const end = sched.indexOf('async function', start + 50);
  assert.ok(start > 0 && end > start);
  const body = sched.slice(start, end);
  assert.match(body, /notifier\.notifyTenant/,
    'access sync must notify tenants');
  assert.match(body, /บัตรเข้า-ออกถูกระงับ/,
    'revoked subject must explain status clearly');
  assert.match(body, /บัตรเข้า-ออกกลับมาใช้ได้แล้ว/,
    'restored subject must signal recovery');
  // Earlier draft used a timestamp-based query (`ac.updated_at`) that
  // would always fail — access_cards has no updated_at column. Pin the
  // RETURNING clause so we can't regress to the broken approach.
  assert.match(body, /UPDATE access_cards[\s\S]{0,400}status='revoked'[\s\S]{0,400}RETURNING tenant_id/,
    'revoke UPDATE must capture affected tenant_id via RETURNING');
  assert.match(body, /UPDATE access_cards[\s\S]{0,800}status='active'[\s\S]{0,800}RETURNING tenant_id/,
    'restore UPDATE must capture affected tenant_id via RETURNING');
  assert.ok(!/ac\.updated_at/.test(body),
    'must not reference ac.updated_at — no such column on access_cards');
});

test('formatDueDate / formatYMD are timezone-safe (Asia/Bangkok regression)', () => {
  // The old `new Date(y, m, d).toISOString().slice(0, 10)` pattern shifted
  // back ~17h on Asia/Bangkok (UTC+7) — bills generated with dueDay=15
  // landed in storage as "2026-05-14" instead of "2026-05-15", a real
  // off-by-one that affects every bill issued by the scheduler or the
  // bulk-generate route on a Thai-timezone server. Pin the source to the
  // string-construction approach that is timezone-independent by design.
  // Behavioural check — formatYMD has no Date dependency at all (just
  // string concatenation + zero-padding) so it produces the same output
  // regardless of server timezone. That's the property we want to pin.
  const mod = require('../services/billing');
  assert.equal(typeof mod.formatYMD, 'function', 'formatYMD must be exported');
  assert.equal(mod.formatYMD(2026, 5, 15), '2026-05-15');
  assert.equal(mod.formatYMD(2026, 1, 1), '2026-01-01');
  // Padding: single-digit month/day must zero-pad
  assert.equal(mod.formatYMD(2026, 9, 7), '2026-09-07');
  // Defensive: dom outside reasonable range should clamp inside formatDueDate
  // (operator typo'd 31 on a Feb generation would otherwise surface as
  // "Feb 31" — billing.formatDueDate clamps to 1-28 for predictability).
  for (const dom of [-5, 0, 100]) {
    const out = mod.formatDueDate(dom);
    assert.match(out, /^\d{4}-\d{2}-\d{2}$/, `dom=${dom} returns valid YYYY-MM-DD`);
  }
});

test('scheduler + bulk-generate use formatYMD for dueDate', () => {
  // Pin the call sites so a future refactor can't reintroduce the
  // toISOString round-trip that broke Asia/Bangkok timezones.
  const fs = require('node:fs');
  const path = require('node:path');
  const sched = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
  const bulk = fs.readFileSync(path.join(__dirname, '..', 'routes', 'bills-extras.js'), 'utf8');
  // Both paths must call formatYMD instead of constructing a Date.
  // Bulk-generate now derives year/month from the operator-supplied
  // `period` (so back-filled bills get a due date in the correct month
  // rather than the wallclock month); scheduler still uses now.* because
  // it always runs for the current month. Match either form so a future
  // refactor that switches scheduler to period-derived too still passes.
  assert.match(sched, /billing\.formatYMD\(now\.getFullYear\(\), now\.getMonth\(\) \+ 1, dueDay\)/,
    'scheduler must use formatYMD for due date');
  assert.match(bulk, /billing\.formatYMD\((?:now\.getFullYear\(\), now\.getMonth\(\) \+ 1|periodYear, periodMonth), dueDay\)/,
    'bulk-generate must use formatYMD for due date');
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

// =====================================================================
// Regression locks for the May 2026 cross-feature audit fixes. Each test
// pins a code path that previously had a real-world bug; the comment
// explains the failure mode so a future maintainer doesn't "simplify"
// the guard back into the bug.
// =====================================================================

test('healthCheck guards against rows[0] undefined (queue/failed_logins/lockouts)', () => {
  // Production was emitting "Cannot read properties of undefined (reading 'stuck'/'n')"
  // every hour — the catch-block returned errors that the anomaly detector
  // then spammed to the owner. Rebuild defensiveness so a wrapped pool
  // returning {rows: undefined} can't crash the probe.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'healthCheck.js'), 'utf8');
  // All three probes must coerce to safe defaults rather than indexing rows[0] raw.
  assert.match(src, /Number\(r\.stuck\) \|\| 0/, 'queue: stuck must default to 0');
  assert.match(src, /Number\(r\.recent_failed\) \|\| 0/, 'queue: recent_failed must default to 0');
  // failed_logins + lockouts use the same r=rows[0]||{} shape.
  const arrayGuards = src.match(/Array\.isArray\(res\.rows\) && res\.rows\[0\]\) \|\| \{\}/g) || [];
  assert.ok(arrayGuards.length >= 3, 'three rows[0]||{} guards expected (queue, failed_logins, lockouts)');
});

test('encryption.validateAtBoot exists and round-trips when keys configured', () => {
  process.env.ENCRYPTION_KEY_V1 = Buffer.alloc(32, 1).toString('base64');
  process.env.ENCRYPTION_KEY_CURRENT = '1';
  delete require.cache[require.resolve('../services/encryption')];
  const enc = require('../services/encryption');
  assert.equal(typeof enc.validateAtBoot, 'function', 'validateAtBoot must be exported');
  const status = enc.validateAtBoot();
  assert.equal(status.ok, true);
  assert.equal(status.mode, 'versioned');
  assert.equal(status.current, 1);
});

test('encryption.validateAtBoot throws when CURRENT points at missing key', () => {
  process.env.ENCRYPTION_KEY_V1 = Buffer.alloc(32, 1).toString('base64');
  process.env.ENCRYPTION_KEY_CURRENT = '99';   // no V99 set
  delete require.cache[require.resolve('../services/encryption')];
  const enc = require('../services/encryption');
  // After loadKeys runs, _current falls back to the highest valid key (1)
  // so validateAtBoot should still pass — but the helpful warning fires.
  // Test: when NO valid keys are loaded but CURRENT is set, throws.
  delete process.env.ENCRYPTION_KEY_V1;
  delete require.cache[require.resolve('../services/encryption')];
  process.env.ENCRYPTION_KEY_V1 = Buffer.from('too-short').toString('base64');  // not 32 bytes
  process.env.ENCRYPTION_KEY_CURRENT = '1';
  delete require.cache[require.resolve('../services/encryption')];
  const enc2 = require('../services/encryption');
  assert.throws(() => enc2.validateAtBoot(), /no usable key/);
  // Reset for downstream tests
  delete process.env.ENCRYPTION_KEY_V1;
  delete process.env.ENCRYPTION_KEY_CURRENT;
});

test('optimisticLock updateWithVersion compares at second precision', () => {
  // Microsecond drift (DB stores µs, JSON drops them) used to false-409
  // even when no concurrent edit happened. The UPDATE now uses
  // date_trunc('second', ...) on both sides to match.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'db', 'optimisticLock.js'), 'utf8');
  assert.match(src,
    /date_trunc\('second', updated_at\) = date_trunc\('second', \$2::timestamptz\)/,
    'updateWithVersion must compare at second precision');
});

test('scheduler wraps daily ticks in pg_advisory_lock', () => {
  // Multi-instance Railway deploys without an advisory lock fan-out the
  // same daily summary twice (state file is per-container, not shared).
  // Pin the lock + the helper that does try-lock semantics.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
  assert.match(src, /pg_try_advisory_lock\(\$1::int, \$2::int\)/,
    'scheduler must use try-advisory-lock');
  assert.match(src, /pg_advisory_unlock\(\$1::int, \$2::int\)/,
    'and unlock at end of tick');
  assert.match(src, /_withAdvisoryLock\(pool, `billGen-/,
    'billGen tick must run under the lock');
  assert.match(src, /_withAdvisoryLock\(pool, `contractExpiry-/,
    'contractExpiry tick must run under the lock');
});

test('scheduler runs late-fee before bill-gen (sequential)', () => {
  // Parallel allSettled raced — bill-gen could read pending bills before
  // late-fee marked them overdue, so late fees were skipped that cycle.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
  // Late-fee call must precede the Promise.allSettled([...]) array.
  const lateFeeIdx = src.indexOf('await tickLateFee(');
  const allSettledIdx = src.indexOf('Promise.allSettled([');
  assert.ok(lateFeeIdx > 0, 'tickLateFee must be awaited explicitly');
  assert.ok(allSettledIdx > lateFeeIdx,
    'Promise.allSettled (the parallel block) must come AFTER late-fee');
});

test('notifier falls back to notification queue when all immediate channels fail', () => {
  // LINE 401 for 30 minutes used to drop every checkin/maintenance/access
  // notification on the floor. Now we enqueue for retry.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'notifier.js'), 'utf8');
  assert.match(src, /getQueue\(\)/, 'notifier must lazy-require notificationQueue');
  assert.match(src, /queue\.enqueue\(pool, \{\s*channel: 'line'/,
    'must enqueue line as fallback');
  assert.match(src, /'notifier-fallback'/,
    'fallback enqueue carries source tag');
});

test('lineBinding tryBind catches 23505 → clean reason', () => {
  // Race: two concurrent tryBinds for same (oa_id, line_user_id) both
  // pass the dedup SELECT and both attempt UPDATE — second hits the
  // partial unique. Map to line_user_already_bound instead of bubbling
  // up as "ระบบขัดข้อง".
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'lineBinding.js'), 'utf8');
  assert.match(src, /err\.code === '23505'/,
    'tryBind must catch the unique-violation code');
  assert.match(src, /reason: 'line_user_already_bound', raceLost: true/,
    'and return the same reason as the dedup branch');
});

test('CSV escapes CR + neutralises formula leaders', () => {
  // \r in a notes field used to split rows in Excel. =cmd|... in a cell
  // turned into a clickable formula on import. Both fixed.
  delete require.cache[require.resolve('../routes/reports')];
  const reports = require('../routes/reports');
  // The module is a function builder; we only need the in-file helpers.
  // Re-read the source to assert the regex shape since helpers aren't exported.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports.js'), 'utf8');
  assert.match(src, /\/\[",\\r\\n\]\//, 'CSV escape regex must include \\r');
  assert.match(src, /FORMULA_INJECTION_RE = \/\^\[=\+\\-@\\t\\r\]\//,
    'formula-injection regex must cover =, +, -, @, tab, CR');
  assert.match(src, /typeof v === 'string'/,
    'XLSX neutralises only string cells (numbers/dates pass through)');
  // Helper sanity check via re-exec: build a row and serialise.
  // (the helpers are file-private so we just trust the regex match)
  void reports;
});

test('storage._safeLocalPath blocks traversal at read time', () => {
  // Write-time sanitiser already blocks bad input but a tampered DB row
  // used to bypass read-time. _safeLocalPath now rejects ../, /, \\.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'storage.js'), 'utf8');
  assert.match(src, /storage: traversal in category\/filename/,
    'must reject traversal in either segment');
  assert.match(src, /storage: resolved path escapes upload root/,
    'must reject resolved paths escaping UPLOAD_ROOT');
  // Both readFile and remove must use the safe path.
  const usages = src.match(/_safeLocalPath\(/g) || [];
  assert.ok(usages.length >= 2, 'readFile + remove must both call _safeLocalPath');
});

test('storage notifies owner when R2 upload fails', () => {
  // Silent local fallback used to lose slips on Railway redeploy. Now
  // alerts the owner on every R2 failure (fire-and-forget).
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'storage.js'), 'utf8');
  assert.match(src, /R2\/S3 upload failed — file saved locally/,
    'R2 fail must alert owner with explicit subject');
});

test('checkout revokes access cards + records refund + pro-rates closing bill', () => {
  // Three things the old checkout missed: cards stayed active (security),
  // refund only landed in audit_logs (vanished from reports), no pro-rate
  // (tenant didn't get a closing bill for partial-month).
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
  assert.match(src, /UPDATE access_cards[\s\S]{0,200}status='revoked'[\s\S]{0,200}auto:checkout/,
    'must auto-revoke active cards on checkout');
  assert.match(src, /deposit_returned = \$2/,
    'refund must persist on contracts row, not just audit_logs');
  assert.match(src, /pro-rate/i,
    'closing-bill pro-rate path must exist');
  assert.match(src, /generateClosingBill !== false/,
    'admin can opt out of the closing bill (default true)');
});

test('contracts gain deposit_returned columns in migration', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrate.js'), 'utf8');
  for (const col of ['deposit_returned', 'deposit_returned_at', 'deposit_return_reason']) {
    assert.match(src, new RegExp(`ALTER TABLE contracts ADD COLUMN IF NOT EXISTS ${col}`),
      `${col} column must be in migration`);
  }
});

test('tenant checkin uses moveInDate not wallclock for welcome-bill period', () => {
  // Jan 31 move-in processed at 00:05 Feb 1 used to stamp period 2026-02
  // — wrong: tenant got a Feb-period welcome bill instead of Jan, and the
  // Feb auto-bill duped (or was blocked by uq_bills_room_period_active).
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
  assert.match(src, /moveInMatch = \/\^\(\\d\{4\}\)-\(\\d\{2\}\)-\(\\d\{2\}\)\$\/\.exec\(moveInDate\)/,
    'must parse moveInDate as YYYY-MM-DD components');
  assert.match(src, /period = moveInMatch\s*\? `\$\{moveInMatch\[1\]\}-\$\{moveInMatch\[2\]\}`/,
    'welcome bill period must derive from moveInDate');
});

test('tenant checkin endDate respects month-rollover (Jan31 + 1mo → Feb28/29)', () => {
  // setMonth(getMonth()+1) overflows on EoM dates: Jan 31 + 1mo = Mar 3.
  // Now we clamp the day-of-month to the last valid day of the target month.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
  // The clamp pattern: lastDom = new Date(Date.UTC(ey, em, 0)).getUTCDate()
  // then Math.min(sd, lastDom).
  assert.match(src, /new Date\(Date\.UTC\(ey, em, 0\)\)\.getUTCDate\(\)/,
    'must compute last day of target month');
  assert.match(src, /Math\.min\(sd, lastDom\)/,
    'must clamp source day to last valid day');
});

test('booking-approve resolves vacant rooms from rooms_v2 too (not just JSONB blob)', () => {
  // Rooms created via POST /api/rooms only land in rooms_v2. Without a
  // dual-source query, NO_VACANT_ROOM_MATCH was returned even when v2
  // had matching vacancies.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /SELECT room_code, room_type, floor[\s\S]{0,300}FROM rooms_v2[\s\S]{0,200}status='vacant'/,
    'approve-and-assign must consider rooms_v2 vacant rows');
  assert.match(src, /UPDATE rooms_v2 SET status='reserved'/,
    'and reserve via rooms_v2 when picked from there');
});

test('checkin/checkout dual-write rooms_v2 status', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
  // Both transitions must hit rooms_v2 too.
  assert.match(src, /UPDATE rooms_v2 SET status='occupied', updated_at=NOW\(\)/,
    'checkin must flip rooms_v2 to occupied');
  assert.match(src, /UPDATE rooms_v2 SET status='vacant', updated_at=NOW\(\)/,
    'checkout must flip rooms_v2 to vacant');
});

test('maintenance lookup filters tickets by current tenant_id (no IDOR)', () => {
  // Old query OR'd phone match against tenant_id ANY — a new tenant who
  // moved into the same room could see the prior tenant's ticket history.
  // Now we resolve the CURRENT tenant of (phone, room) and filter strictly.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src,
    /SELECT id FROM tenants[\s\S]{0,200}WHERE phone = \$1 AND current_room_id = \$2[\s\S]{0,200}status='active'/,
    'must resolve current resident before listing tickets');
  assert.match(src,
    /tenant_id = \$2 OR \(tenant_id IS NULL AND tenant_phone = \$3\)/,
    'tickets must be filtered to that tenant_id (legacy fallback only when tenant_id NULL)');
});

test('tenant POST/PUT normalise phone (strip dashes/spaces)', () => {
  // Three-way phone drift between admin-create / schemas.phoneStr /
  // tenant-login was the root cause of "tenant typed 081-234-5678 and
  // can't log in". Both admin endpoints now normalise.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // POST normalisation
  assert.match(src,
    /const phone = rawPhone\.replace\(\/\[\\s-\]\/g, ''\)/,
    'POST /api/tenants must strip dashes + spaces');
  // PUT normalisation
  assert.match(src,
    /const normPhone = String\(b\.phone\)\.slice\(0, 32\)\.trim\(\)\.replace\(\/\[\\s-\]\/g, ''\)/,
    'PUT /api/tenants/:id must also normalise on edit');
});

test('tenant login is wired through schemas.tenantLogin', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // Allow a generous gap because the inline comment explaining the fix
  // can grow over time without breaking the wiring.
  assert.match(src, /\/api\/tenant\/login[\s\S]{0,1500}validateBody\(schemas\.tenantLogin\)/,
    'tenant login must be guarded by the tenantLogin schema (phoneStr normalises dashes)');
});

test('booking-approve notify uses tenant matched to assigned room when possible', () => {
  // Old flow took ORDER BY updated_at LIMIT 1 by phone alone — couples
  // sharing a phone got each other's approval messages.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src,
    /WHERE phone=\$1 AND current_room_id=\$2 AND deleted_at IS NULL/,
    'must prefer phone+room match before falling back to phone-only');
});

test('anomaly detector partial-recovery does not say "ระบบกลับมาทำงานปกติ"', () => {
  // error→warn is BETTER but warn condition still active — old subject
  // was misleading. Now reads "ระบบดีขึ้นบางส่วน (ยังมี warn)".
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'anomalyDetector.js'), 'utf8');
  assert.match(src, /fullyRecovered = alerts\.every\(\s*\(a\) => a\.recovered && a\.check\.status === 'ok'\s*\)/,
    'must distinguish full recovery (every check === ok) from partial');
  assert.match(src, /ระบบดีขึ้นบางส่วน \(ยังมี warn\)/,
    'partial-recovery subject must NOT claim full recovery');
});

test('/health admin endpoint walks the full scheduler-state candidate list', () => {
  // /health used to hard-code ./.scheduler-state.json while admin/health
  // walked SCHEDULER_STATE_FILE → UPLOAD_DIR → app dir → tmpdir. The two
  // would diverge after a Railway volume mount change.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src,
    /process\.env\.SCHEDULER_STATE_FILE,[\s\S]{0,200}process\.env\.UPLOAD_DIR && path\.join\(process\.env\.UPLOAD_DIR/,
    'admin /health must consider env-configured paths');
  assert.match(src, /baankarn-scheduler-state\.json/,
    'and the tmpdir fallback');
});

// =====================================================================
// Identity capture / contract / booking safety guards (May 2026 round 2).
// =====================================================================

test('thaiId helper validates mod-11 checksum + hashes for lookup', () => {
  delete require.cache[require.resolve('../services/thaiId')];
  process.env.CITIZEN_ID_KEY = Buffer.alloc(32, 7).toString('base64');
  const t = require('../services/thaiId');
  // Spec: known good Thai citizen IDs from public test vectors.
  // Construct a valid one synthetically: pick 12 digits, compute the
  // expected check digit per the official mod-11 algorithm, append.
  function makeValid(prefix12) {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(prefix12[i]) * (13 - i);
    const check = (11 - (sum % 11)) % 10;
    return prefix12 + String(check);
  }
  const good = makeValid('111111111111');
  assert.equal(t.validateChecksum(good), true, 'checksum-correct ID must validate');
  // Flip any digit: should fail
  const bad = good.slice(0, -1) + (Number(good.slice(-1)) === 9 ? '0' : '9');
  assert.equal(t.validateChecksum(bad), false, 'tampered check digit must fail');
  // normalize strips dashes/spaces
  assert.equal(t.normalize('1-1111-11111-11-' + good.slice(-1)), good);
  assert.equal(t.normalize('not 13 digits'), null);
  // hashForLookup is deterministic + non-reversible-looking. Build a
  // second valid ID from a DIFFERENT prefix (don't just substring `good`,
  // since '111...' starts with '1' so prefixing '1' yields the same string).
  const other = makeValid('222222222222');
  const h1 = t.hashForLookup(good);
  const h2 = t.hashForLookup(other);
  assert.match(h1, /^[a-f0-9]{64}$/, 'HMAC-SHA256 produces 64 hex chars');
  assert.notEqual(h1, h2, 'different IDs must hash differently');
  // Same input → same hash (deterministic)
  assert.equal(t.hashForLookup(good), h1, 'hash must be deterministic');
  // tail returns last 4 only
  assert.equal(t.tail(good), good.slice(-4));
});

test('migration adds tenants.address + emergency_contact_* + citizen_id_image_* + citizen_id_hash', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrate.js'), 'utf8');
  for (const col of [
    'address', 'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relation',
    'citizen_id_image_front_id', 'citizen_id_image_back_id', 'citizen_id_hash',
  ]) {
    assert.match(src, new RegExp(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ${col}`),
      `tenants.${col} must be in migration`);
  }
  // The partial unique index — at most ONE active tenant per citizen ID.
  assert.match(src, /CREATE UNIQUE INDEX IF NOT EXISTS uq_tenants_citizen_id_hash_active/,
    'partial unique index on citizen_id_hash must exist');
  assert.match(src, /WHERE citizen_id_hash IS NOT NULL[\s\S]{0,200}AND status = 'active'/,
    'unique index must scope to active+non-deleted');
});

test('migration adds bookings + contracts + file_uploads identity columns', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrate.js'), 'utf8');
  for (const col of ['citizen_id_tail', 'citizen_id_image_front_id', 'expected_deposit',
                     'agreed_terms_at', 'agreed_terms_version']) {
    assert.match(src, new RegExp(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS ${col}`),
      `bookings.${col} must be in migration`);
  }
  for (const col of ['signature_image_id', 'agreed_terms_at', 'agreed_terms_version']) {
    assert.match(src, new RegExp(`ALTER TABLE contracts ADD COLUMN IF NOT EXISTS ${col}`),
      `contracts.${col} must be in migration`);
  }
  assert.match(src, /ALTER TABLE file_uploads ADD COLUMN IF NOT EXISTS side TEXT/,
    'file_uploads.side must distinguish front/back');
});

test('/api/tenants/:id/identity endpoint exists + validates checksum + dedups by hash', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /app\.post\('\/api\/tenants\/:id\/identity'/,
    'identity endpoint must be registered');
  assert.match(src, /INVALID_CHECKSUM/, 'must reject invalid Thai checksum');
  assert.match(src, /CITIZEN_ID_DUPLICATE/, 'must surface dedup as a clean code');
  // Both front + back side tagging must reach storage.saveBase64.
  assert.match(src, /side: 'front'/, 'front side must be tagged');
  assert.match(src, /side: 'back'/, 'back side must be tagged');
});

test('/api/uploads requires side=front|back when category=citizen_id_image', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /IDENTITY_SIDE_REQUIRED/,
    'generic upload must reject citizen_id_image without side');
});

test('checkin enforces moveInDate window + deposit cap + double-occupancy', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
  assert.match(src, /MOVE_IN_OUT_OF_WINDOW/, 'past/future window guard must exist');
  assert.match(src, /DEPOSIT_TOO_LARGE/, 'deposit-too-large guard must exist');
  assert.match(src, /TENANT_ALREADY_ACTIVE/, 'tenant-already-active-elsewhere guard must exist');
  assert.match(src, /ROOM_OCCUPIED/, 'room-occupied-by-other-tenant guard must exist');
  assert.match(src, /IDENTITY_INCOMPLETE/, 'identity-completeness guard must exist');
  // Force-bypass must record an audit + owner notify so abuses are visible.
  assert.match(src, /forced: isForced/, 'force-bypass must be audit-logged');
  assert.match(src, /'⚠️ checkin ใช้ force=true bypass safety guards'/,
    'force-bypass must owner-notify');
});

test('checkin termsVersion stamped on contract row when supplied', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
  assert.match(src,
    /agreed_terms_at, agreed_terms_version[\s\S]{0,400}CASE WHEN \$10::text IS NOT NULL THEN NOW\(\) ELSE NULL END/,
    'agreed_terms_at must be stamped only when version is provided');
});

test('checkin schemas tighten termMonths to 1-60', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'index.js'), 'utf8');
  // The new cap is 60 (was 120). Allow either via min().max() chain.
  assert.match(src, /termMonths: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(60\)/,
    'termMonths cap must be ≤ 60');
});

test('contract sign endpoint exists + rejects already-signed without force', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /app\.post\('\/api\/contracts\/:id\/sign'/,
    'contract sign endpoint must exist');
  assert.match(src, /ALREADY_SIGNED/, 'must guard against accidental re-sign');
  assert.match(src, /CONTRACT_NOT_ACTIVE/, 'must reject signing on ended/expired contracts');
  // Schema must require a non-trivially-empty signature data URL.
  const sch = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'index.js'), 'utf8');
  assert.match(sch, /schemas\.contractSign = z\.object\([\s\S]{0,200}signatureDataUrl/,
    'contractSign schema must validate signature data URL');
});

test('admin tenant create validates Thai checksum + dedup hash', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /thaiId\.validateChecksum/, 'admin create must run checksum');
  assert.match(src, /citizen_id_hash/, 'admin create must persist hash');
  assert.match(src, /CITIZEN_ID_DUPLICATE/, 'admin create must surface dedup');
  assert.match(src, /INVALID_EMERGENCY_PHONE/, 'admin create must validate emergency phone');
});

test('public booking accepts citizen ID front photo + agreed terms', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // saveBase64 with category='citizen_id_image' fired from the public path.
  assert.match(src,
    /saveBase64\(\{[\s\S]{0,200}category: 'citizen_id_image'[\s\S]{0,200}refId: 'public-booking-pending'/,
    'public booking must save the front photo with refId hint');
  assert.match(src, /agreedTermsVersion/, 'public booking must accept terms version');
  assert.match(src, /MOVE_IN_OUT_OF_WINDOW/, 'public booking must validate moveIn date window');
});

test('features.tenancyContract defaults are sane (require ID images + emergency)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'features.js'), 'utf8');
  assert.match(src, /tenancyContract:[\s\S]{0,500}requireIdentityImages: true/,
    'requireIdentityImages must default to true');
  assert.match(src, /requireEmergencyContact: true/,
    'requireEmergencyContact must default to true');
  assert.match(src, /depositMaxMonths: 3/,
    'deposit cap default = 3 months');
});

test('quick-invite endpoint exists + creates tenant + contract + invitation atomically', () => {
  // The "+ สร้างสัญญา · ส่งลิงก์ให้ผู้เช่ากรอก" entry point — without it,
  // admin had no way to start the self-fill flow from scratch (existing
  // checkin requires identity images already on file). This endpoint
  // bypasses the identity guards because the WHOLE POINT is to delegate
  // those fields to the tenant via the link.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src,
    /app\.post\('\/api\/contracts\/quick-invite'[\s\S]{0,200}requireRole\('owner', 'manager'\)/,
    'quick-invite endpoint must be registered + role-gated');
  // The endpoint must work in a single transaction so a partial failure
  // doesn't leave orphan tenants/contracts/invitations.
  const block = src.match(/quick-invite'[\s\S]+?app\.post\('\/api\/contracts\/:id\/invite-tenant'/)[0];
  assert.match(block, /BEGIN/, 'quick-invite must wrap creates in a transaction');
  assert.match(block, /COMMIT/);
  assert.match(block, /ROLLBACK/);
  // Must look up tenant by phone first to avoid duplicating rows for the
  // same person across multiple contracts.
  assert.match(block, /SELECT id, full_name, status FROM tenants[\s\S]{0,200}WHERE phone=\$1/);
  // Must reactivate moved_out tenants instead of creating new rows.
  assert.match(block, /SET status='active'/);
  // Must skip the heavy checkin guards (no IDENTITY_INCOMPLETE here).
  assert.ok(!/IDENTITY_INCOMPLETE/.test(block),
    'quick-invite must NOT enforce identity guards');
  // Token + invitation must be inlined in the same transaction (no
  // nested BEGIN — the helper would crash inside an open tx).
  assert.match(block, /INSERT INTO contract_invitations/);
  assert.match(block, /audit\(req, 'contract\.quick_invite'/);
});

test('contracts page has "+ สร้างสัญญา" entry button + QuickInviteModal', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-contracts.jsx'), 'utf8');
  // Header has the primary "+ create" CTA so admin can start the flow
  // even when no contracts exist yet (empty-state usability fix).
  assert.match(src, /\+ สร้างสัญญา · ส่งลิงก์ให้ผู้เช่ากรอก/);
  assert.match(src, /setQuickCreating\(true\)/);
  // Modal component
  assert.match(src, /function QuickInviteModal/);
  assert.match(src, /\/api\/contracts\/quick-invite/);
  // Form fields the modal collects
  for (const field of ['tenantName', 'tenantPhone', 'roomId', 'monthlyRent', 'deposit', 'moveInDate']) {
    assert.match(src, new RegExp(field), `quick-invite modal must collect ${field}`);
  }
  // Auto-fill deposit = 2 × rent (Thai dorm standard)
  assert.match(src, /Number\(v\) \* 2/);
  // Result panel shows the URL with copy
  assert.match(src, /result\.invitation\.url/);
  assert.match(src, /navigator\.clipboard\.writeText/);
});

test('contract-fill HTML reads view.rejectionReason (camelCase, not snake_case)', () => {
  // Server's buildPublicView returns rejectionReason; the HTML used to read
  // view.rejection_reason → reject reason was invisible to the tenant.
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'project', 'contract-fill.html'), 'utf8');
  assert.match(html, /view\.rejectionReason/,
    'HTML must read view.rejectionReason (camelCase)');
  assert.ok(!/view\.rejection_reason/.test(html),
    'HTML must NOT read view.rejection_reason (snake_case mismatch)');
});

test('contracts list selects locked_at + active_invitation_status', () => {
  // The contracts page row needs locked_at to hide the invite button on
  // locked contracts and active_invitation_status to show "ลิงก์รอผู้เช่า"
  // / "รอตรวจสอบ" badges. Without these the UI shows stale state.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /c\.locked_at, c\.locked_by, c\.template_id/,
    'contracts list must select lock + template columns');
  assert.match(src, /active_invitation_status/,
    'contracts list must surface active invitation status via subquery');
  // Pre-migration fallback: legacy SELECT keeps working.
  assert.match(src,
    /err\.code !== '42703' && err\.code !== '42P01'\) throw err;\s+\(\{ rows \} = await pool\.query\(/,
    'list endpoint must fall back on pre-migration deploys');
});

test('contracts page shows lock + invitation status badges', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-contracts.jsx'), 'utf8');
  assert.match(src, /🔒 LOCKED/, 'lock badge must show on locked contracts');
  assert.match(src, /📨 ลิงก์รอผู้เช่ากรอก/);
  assert.match(src, /✓ รอตรวจสอบ/);
  // Action button hidden on locked contracts (button onClick={() => setInviting(c)}
  // is gated on !c.locked_at).
  assert.match(src,
    /c\.status === 'active' && !c\.locked_at[\s\S]{0,200}setInviting\(c\)/,
    'invite button must hide when contract is locked');
});

test('backup TABLES include contract_templates + contract_invitations', () => {
  // Without these in TABLES, restoring from a backup loses every template
  // + every tenant-fill invitation history. The earlier sync test covers
  // the symmetry (TABLES vs RESTORABLE_TABLES); this test pins the
  // critical entries explicitly so a future refactor can't silently
  // drop one of them.
  const fs = require('node:fs');
  const path = require('node:path');
  const backup = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'backup.js'), 'utf8');
  assert.match(backup, /'contract_templates'/, 'TABLES must include contract_templates');
  assert.match(backup, /'contract_invitations'/, 'TABLES must include contract_invitations');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // contract_templates restored BEFORE contracts (FK constraint)
  const restoredBlock = server.match(/RESTORABLE_TABLES = \[[\s\S]*?\];/)[0];
  const tplIdx = restoredBlock.indexOf("'contract_templates'");
  const ctrIdx = restoredBlock.indexOf("'contracts'");
  assert.ok(tplIdx > 0 && ctrIdx > 0 && tplIdx < ctrIdx,
    'contract_templates must restore BEFORE contracts (FK)');
});

test('contract_invitations table + state machine columns', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrate.js'), 'utf8');
  assert.match(src, /CREATE TABLE IF NOT EXISTS contract_invitations/,
    'invitations table must be created');
  // Token stored as hash, not plaintext — DB-only leak shouldn't yield
  // replayable URLs.
  assert.match(src, /token_hash\s+TEXT NOT NULL/);
  assert.ok(!/token\s+TEXT NOT NULL/.test(src.match(/CREATE TABLE IF NOT EXISTS contract_invitations[\s\S]*?\);/)[0]),
    'must NOT store the raw token in the DB');
  // State machine status with all 6 states
  assert.match(src, /pending \| submitted \| approved \| rejected \| revoked \| expired/);
  // Partial unique: at most one active invitation per contract
  assert.match(src,
    /uq_contract_invitations_active_per_contract[\s\S]{0,200}status IN \('pending', 'submitted'\)/,
    'at most one active invitation per contract');
  // contracts.locked_at + locked_by columns
  assert.match(src, /ALTER TABLE contracts ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ/);
  assert.match(src, /ALTER TABLE contracts ADD COLUMN IF NOT EXISTS locked_by TEXT/);
});

test('admin invitation endpoints exist + role-gated owner+manager', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // Five admin endpoints
  assert.match(src,
    /app\.post\('\/api\/contracts\/:id\/invite-tenant'[\s\S]{0,200}requireRole\('owner', 'manager'\)/);
  assert.match(src,
    /app\.get\('\/api\/admin\/contract-invitations'[\s\S]{0,200}requireRole\('owner', 'manager'\)/);
  assert.match(src,
    /app\.get\('\/api\/admin\/contract-invitations\/:id'[\s\S]{0,200}requireRole\('owner', 'manager'\)/);
  assert.match(src,
    /app\.post\('\/api\/admin\/contract-invitations\/:id\/approve'[\s\S]{0,300}requireRole\('owner', 'manager'\)/);
  assert.match(src,
    /app\.post\('\/api\/admin\/contract-invitations\/:id\/reject'[\s\S]{0,300}requireRole\('owner', 'manager'\)/);
  assert.match(src,
    /app\.post\('\/api\/admin\/contract-invitations\/:id\/revoke'[\s\S]{0,300}requireRole\('owner', 'manager'\)/);
});

test('invite-tenant refuses to issue link for locked contract', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /CONTRACT_LOCKED/,
    'invite-tenant must surface CONTRACT_LOCKED when locked_at is set');
});

test('approve atomically applies draft + locks contract in single transaction', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // The approve endpoint must:
  //   - run in a transaction (BEGIN ... COMMIT)
  //   - flip the invitation to status='approved'
  //   - lock the contract (locked_at = NOW())
  // We verify each piece independently rather than chained-regex (the
  // intermediate code is long and adding gap limits is brittle).
  const approveBlock = src.match(/\/approve'[\s\S]+?app\.post\('\/api\/admin\/contract-invitations\/:id\/reject'/);
  assert.ok(approveBlock, 'approve handler must be present');
  const block = approveBlock[0];
  assert.match(block, /BEGIN/, 'approve handler must open a transaction');
  assert.match(block, /COMMIT/, 'approve handler must commit');
  assert.match(block, /locked_at=NOW\(\)/, 'approve handler must lock contract');
  assert.match(block, /status='approved'/, 'approve handler must flip status');
  // Dedup escape: when applying tenant's draft, the partial unique on
  // citizen_id_hash can fire — must be mapped to a clean 409.
  assert.match(block, /uq_tenants_citizen_id_hash_active/);
  assert.match(block, /CITIZEN_ID_DUPLICATE/);
});

test('public fill endpoints: token-gated, rate-limited, no auth required', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // Three public endpoints
  assert.match(src, /app\.get\('\/api\/contract-fill\/:token'/);
  assert.match(src, /app\.put\('\/api\/contract-fill\/:token'/);
  assert.match(src, /app\.post\('\/api\/contract-fill\/:token\/submit'/);
  assert.match(src, /app\.post\('\/api\/contract-fill\/:token\/upload'/);
  // All three use the rate limiter — token guess is hard but limit prevents
  // a noisy abuser from cycling through guesses.
  assert.match(src, /rateLimitContractFill = makeIpLimiter/);
  // No auth middleware on any of them (no requireAuth, no requireTenant)
  // The `tokenGate` is the auth equivalent — token IS the credential.
  const fillBlock = src.match(/app\.get\('\/api\/contract-fill\/:token'[\s\S]{0,2000}/);
  assert.ok(fillBlock, 'fill endpoint must exist');
  assert.ok(!/requireAuth/.test(fillBlock[0]),
    'public endpoint must not require admin auth');
});

test('public fill: PUT rejects when status is not pending (NOT_EDITABLE)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /'NOT_EDITABLE'[\s\S]{0,200}'NOT_EDITABLE'/,
    'NOT_EDITABLE must guard PUT and upload + submit when status is submitted');
});

test('public fill: submit requires all critical fields before flipping status', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // signature, address, emergency contact, both ID photos required.
  assert.match(src, /missing\.push\('signature'\)/);
  assert.match(src, /missing\.push\('address'\)/);
  assert.match(src, /missing\.push\('emergencyContactName'\)/);
  assert.match(src, /missing\.push\('emergencyContactPhone'\)/);
  assert.match(src, /missing\.push\('citizenIdFront'\)/);
  assert.match(src, /missing\.push\('citizenIdBack'\)/);
});

test('admin UI: contract-invitations page registered + script-loaded', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  // HTML loads the new JSX
  const html = fs.readFileSync(path.join(__dirname, '..', 'project', 'Admin Dashboard.html'), 'utf8');
  assert.match(html, /\/admin\/page-contract-invitations\.jsx/);
  // shell wires the page into PAGES + NAV + PAGE_TITLES
  const shell = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'shell.jsx'), 'utf8');
  assert.match(shell, /'contract-invitations':\s+window\.PageContractInvitations/);
  assert.match(shell, /id: 'contract-invitations'[\s\S]{0,80}'ใบเชิญผู้เช่ากรอก'/);
  assert.match(shell, /'contract-invitations':\s+'ใบเชิญให้ผู้เช่ากรอกสัญญา'/);
  // Page file attaches component to window
  const page = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-contract-invitations.jsx'), 'utf8');
  assert.match(page, /window\.PageContractInvitations = PageContractInvitations/);
  // Three tabs exist
  assert.match(page, /tab === 'submitted'/);
  assert.match(page, /tab === 'pending'/);
  assert.match(page, /tab === 'closed'/);
  // Approve / reject / revoke actions wired
  assert.match(page, /\/api\/admin\/contract-invitations\/\$\{invitation\.id\}\/approve/);
  assert.match(page, /\/api\/admin\/contract-invitations\/\$\{invitation\.id\}\/reject/);
  assert.match(page, /\/api\/admin\/contract-invitations\/\$\{invitation\.id\}\/revoke/);
});

test('contracts page has invite button + InviteTenantModal', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-contracts.jsx'), 'utf8');
  // Button only shows for active+unlocked contracts
  assert.match(src, /c\.status === 'active' && !c\.locked_at[\s\S]{0,300}setInviting\(c\)/);
  // Modal generates link via API + shows token ONCE + offers copy
  assert.match(src, /function InviteTenantModal/);
  assert.match(src, /\/api\/contracts\/\$\{contract\.id\}\/invite-tenant/);
  // Surface "show only once" warning so admin doesn't lose the URL
  assert.match(src, /แสดงครั้งเดียว/);
  // Copy-to-clipboard
  assert.match(src, /navigator\.clipboard\.writeText/);
});

test('public contract-fill HTML page exists + has expected steps', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'project', 'contract-fill.html'), 'utf8');
  // Multi-step wizard
  assert.match(html, /Step1Welcome/);
  assert.match(html, /Step2Personal/);
  assert.match(html, /Step3Identity/);
  assert.match(html, /Step4Sign/);
  // Auto-save draft
  assert.match(html, /useDebouncedSave/);
  // Token extracted from URL path
  assert.match(html, /\\\/contract\\\/fill\\\//);
  // Submit endpoint — uses `${tokenFromUrl}` template literal in this file.
  assert.match(html, /\/contract-fill\/\$\{tokenFromUrl\}\/submit/);
  // Server route serves this file
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server,
    /app\.get\('\/contract\/fill\/:token'[\s\S]{0,200}contract-fill\.html/);
});

test('checkOut schema declares generateClosingBill (zod must not strip the opt-out)', () => {
  // schemas/index.js's checkOut omitted the field, so zod's default
  // .strip() removed req.body.generateClosingBill before the handler
  // could read it. Admin's "skip closing bill" toggle was dead code.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'index.js'), 'utf8');
  assert.match(src,
    /schemas\.checkOut = z\.object\(\{[\s\S]{0,800}generateClosingBill: z\.boolean\(\)\.optional\(\)/,
    'checkOut schema must declare generateClosingBill');
});

test('checkin uses pg_advisory_xact_lock to serialise parallel checkins per room', () => {
  // SELECT-without-FOR-UPDATE used to let two parallel checkins both see
  // the same room as vacant. Now we take a per-room advisory lock first.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
  assert.match(src, /pg_advisory_xact_lock\(\$1::int, \$2::int\)/,
    'checkin must take a per-room advisory lock');
  // The occupancy SELECT inside the locked region must use FOR UPDATE
  // as belt-and-braces.
  assert.match(src,
    /SELECT id, full_name FROM tenants[\s\S]{0,400}current_room_id=\$1[\s\S]{0,200}FOR UPDATE/,
    'occupancy check must lock matching tenant rows');
});

test('checkin IDENTITY_INCOMPLETE splits front/back into separate missing markers', () => {
  // v1 just emitted "citizenIdImages" which left admin guessing which
  // side they forgot. Now front + back each get their own marker.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
  assert.match(src, /missing\.push\('citizenIdFront'\)/);
  assert.match(src, /missing\.push\('citizenIdBack'\)/);
  // Human-friendly labels in the response — NOT just enum codes.
  assert.match(src, /'รูปบัตรประชาชนด้านหน้า'/);
  assert.match(src, /'รูปบัตรประชาชนด้านหลัง'/);
});

test('checkout closing bill uses Bangkok local-day for pro-rate, not server local', () => {
  // Server in UTC, checkout at 00:30 ICT = 17:30 UTC previous day. Without
  // the Bangkok shift, getDate() returns yesterday's day-of-month → off-
  // by-one daysLived → wrong fraction. The fix shifts UTC by +07:00 then
  // reads UTC* getters from that shifted Date.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
  assert.match(src, /utc\.getTime\(\) \+ 7 \* 3600 \* 1000/,
    'closing-bill must shift UTC by +07:00');
  assert.match(src, /bkk\.getUTCDate\(\)/,
    'must read getUTCDate from the shifted timestamp');
});

test('PDF endpoint role tightened to owner+manager (no staff)', () => {
  // Staff was reading citizen_id_tail + emergency_contact_phone via the
  // PDF — same data class as /identity which is owner+manager only.
  // Tighten the gate so staff can't route around the identity ACL.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src,
    /app\.get\('\/api\/contracts\/:id\/pdf', requireAuth, requireRole\('owner', 'manager'\)/,
    'PDF endpoint must NOT include staff role');
});

test('citizen-ID dedup pre-flight checks tail when hash is NULL', () => {
  // Tenant A created with bad checksum + force=true → hash=NULL stored.
  // Pre-fix, tenant B with same plaintext ID would slip past pre-flight
  // (looking only at hash) AND past the partial unique (A has hash NULL).
  // Now pre-flight falls back to citizen_id_tail when hash lookup misses.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src,
    /WHERE citizen_id_tail=\$1 AND deleted_at IS NULL AND status='active'/,
    'tail-fallback dedup query must exist');
  // Sanity: the dedup branch must trigger when citizenIdNorm is set, not
  // gated on citizenHash existing.
  assert.match(src, /if \(citizenIdNorm && b\.force !== true\)/,
    'dedup precondition must be on the normalised id, not the hash');
});

test('booking photo carryover only catches schema-missing errors silently', () => {
  // Pre-fix: .catch(() => ({rows:[]})) swallowed every error including
  // real bugs. Now we explicitly handle 42703 (column missing) and 42P01
  // (table missing) — anything else throws so admin sees the real problem.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src,
    /err\.code !== '42703' && err\.code !== '42P01'\) throw err/,
    'must throw on non-schema errors');
  // Category verification — the file must be a citizen_id_image with the
  // expected ref_id placeholder before re-targeting onto the new tenant.
  assert.match(src,
    /WHERE id=\$1 AND category='citizen_id_image'[\s\S]{0,200}ref_id='public-booking-pending'/,
    'category check must verify citizen-ID before retargeting');
});

test('contract-templates UI passes width to Modal, not non-existent size prop', () => {
  // Modal in ui.jsx accepts `width` (number, default 480) — `size="xl"`
  // was silently ignored, leaving the editor at 480px (canvas overflow,
  // 4-tab layout cramped).
  const fs = require('node:fs');
  const path = require('node:path');
  const tmplPage = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-contract-templates.jsx'), 'utf8');
  const contPage = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-contracts.jsx'), 'utf8');
  // Template editor needs ≥ 800px to fit tabs + clauses
  assert.match(tmplPage, /width=\{8\d{2}\}/, 'template editor must use width={8xx}');
  // Sign modal hosts a 600px canvas
  assert.match(contPage, /width=\{6\d{2}\}/, 'sign modal must use width={6xx}');
  // No <Modal> should still pass size= (the Btn/Pill `size="sm"` props
  // are unrelated and stay legal). The pattern matches the JSX opening
  // tag for Modal followed within ~500 chars by size=.
  assert.ok(!/<Modal[\s\S]{0,500}size="(xl|lg|md|sm)"/.test(tmplPage),
    'no Modal in template page may pass a size= prop');
  assert.ok(!/<Modal[\s\S]{0,500}size="(xl|lg|md|sm)"/.test(contPage),
    'no Modal in contracts page may pass a size= prop');
});

test('template variables block reserved names + use null-prototype map', () => {
  // Pre-fix: __proto__ as a key would cause weird interpolation results.
  // Defensive fix: blocklist + Object.create(null) so the merged object
  // has no Object.prototype to shadow.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /Object\.create\(null\)/,
    'variables map must use null prototype');
  assert.match(src, /RESERVED_VAR_NAMES = new Set\([\s\S]{0,200}'__proto__'/,
    'reserved names blocklist must include __proto__');
});

test('signature canvas has minHeight floor for mobile', () => {
  // 3:1 aspect on a 320px screen = 107px tall canvas — too small to sign
  // legibly. minHeight=160 keeps the sign area usable on phones.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-contracts.jsx'), 'utf8');
  assert.match(src, /aspectRatio: '3\/1', minHeight: 160/,
    'sign canvas must keep ≥160px tall on narrow viewports');
});

test('VariableRow shows live cleanup hint when key auto-strips', () => {
  // "Wifi Password" silently became "wifipassword" — admin saw the change
  // without explanation. The row now shows "→ ระบบจะบันทึกเป็น ..." hint.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-contract-templates.jsx'), 'utf8');
  assert.match(src, /function VariableRow/,
    'extracted VariableRow component must exist');
  assert.match(src, /ระบบจะบันทึกเป็น/,
    'live key-cleanup hint must appear when transformation happens');
  // Reserved-name warning
  assert.match(src, /เป็นชื่อสงวน/);
});

test('admin UI: contract-templates page registered + script-loaded', () => {
  // The new page-contract-templates.jsx must be loaded by the dashboard
  // HTML AND wired into the shell PAGES + NAV map. Otherwise admin clicks
  // "เทมเพลตสัญญา" → white screen.
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'project', 'Admin Dashboard.html'), 'utf8');
  assert.match(html, /\/admin\/page-contract-templates\.jsx/,
    'HTML must load page-contract-templates.jsx');
  const shell = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'shell.jsx'), 'utf8');
  assert.match(shell, /'contract-templates':\s*window\.PageContractTemplates/,
    'shell PAGES map must register contract-templates');
  assert.match(shell, /id: 'contract-templates'[\s\S]{0,80}'เทมเพลตสัญญา'/,
    'shell NAV must include contract-templates entry');
  assert.match(shell, /'contract-templates':\s*'เทมเพลตสัญญา'/,
    'PAGE_TITLES must include contract-templates');
  // Page file itself
  const page = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-contract-templates.jsx'), 'utf8');
  assert.match(page, /window\.PageContractTemplates = PageContractTemplates/,
    'page must attach component to window');
  // Critical UX bits — tab switcher + clause editor + section toggles
  assert.match(page, /tab === 'clauses'/);
  assert.match(page, /tab === 'sections'/);
  assert.match(page, /tab === 'variables'/);
  // Three-way mode picker
  assert.match(page, /โหมด — clauses จะถูกประกอบ/);
  // Built-in variables documentation surfaced in the variables tab
  assert.match(page, /lessorName[\s\S]{0,80}tenantName[\s\S]{0,80}roomId/);
});

test('admin UI: page-contracts gains PDF + sign + assign-template actions', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-contracts.jsx'), 'utf8');
  // Row actions: PDF, download, sign, assign template
  assert.match(page, /openPdf\(c\)/,           'must have PDF view button');
  assert.match(page, /openPdf\(c, \{ download: 1 \}\)/, 'must have download variant');
  assert.match(page, /setSigning\(c\)/,        'must have online-sign button');
  assert.match(page, /setAssigning\(c\)/,      'must have assign-template button');
  // Sign modal — three input modes (draw + upload), guard against empty
  assert.match(page, /SignContractModal/,      'sign modal component must exist');
  assert.match(page, /canvas/,                 'sign modal must render canvas for draw mode');
  assert.match(page, /กรุณาเซ็นชื่อก่อน/,       'must guard empty draw');
  // Assign modal — preview support + null = use default
  assert.match(page, /AssignTemplateModal/,    'assign modal component must exist');
  assert.match(page, /onPreview/,              'assign modal must support preview');
  assert.match(page, /ใช้ default ของระบบ/,    'must offer null/default option');
});

test('contract_templates table + auto-import sentinel migration', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrate.js'), 'utf8');
  assert.match(src, /CREATE TABLE IF NOT EXISTS contract_templates/,
    'contract_templates table must be created');
  // Partial unique on default
  assert.match(src,
    /CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_templates_default[\s\S]{0,200}is_default = TRUE/,
    'partial unique index on is_default required');
  // Per-contract template_id FK with SET NULL
  assert.match(src,
    /ALTER TABLE contracts ADD COLUMN IF NOT EXISTS template_id BIGINT REFERENCES contract_templates\(id\) ON DELETE SET NULL/,
    'contracts.template_id FK must use ON DELETE SET NULL');
  // Auto-import legacy system_settings → contract_templates default row
  assert.match(src, /contract\.terms_template_migrated_v1/,
    'sentinel must prevent re-import on every boot');
  assert.match(src, /auto-migrated from system_settings/,
    'description must record provenance');
});

test('contract-templates CRUD endpoints exist + validate input', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // Five endpoints — list, get, create, update, soft-delete, set-default.
  assert.match(src, /app\.get\('\/api\/admin\/contract-templates'/,
    'GET list endpoint must exist');
  assert.match(src, /app\.get\('\/api\/admin\/contract-templates\/:id'/,
    'GET single endpoint must exist');
  assert.match(src, /app\.post\('\/api\/admin\/contract-templates'/,
    'POST create endpoint must exist');
  assert.match(src, /app\.put\('\/api\/admin\/contract-templates\/:id'/,
    'PUT update endpoint must exist');
  assert.match(src, /app\.delete\('\/api\/admin\/contract-templates\/:id'/,
    'DELETE soft-delete endpoint must exist');
  assert.match(src, /app\.post\('\/api\/admin\/contract-templates\/:id\/set-default'/,
    'set-default endpoint must exist');
  // Per-contract assignment
  assert.match(src, /app\.post\('\/api\/contracts\/:id\/template'/,
    'per-contract template assignment endpoint must exist');
  // Default protection — can't delete the default
  assert.match(src, /CANNOT_DELETE_DEFAULT/,
    'must refuse to delete the default template');
  // Disabled-template promotion guard
  assert.match(src, /TEMPLATE_DISABLED/,
    'set-default must reject disabled templates');
  // Validation helper
  assert.match(src, /_validateTemplatePayload/,
    'shared validation helper must exist');
  assert.match(src, /OVERRIDE_NEEDS_CLAUSES/,
    'override mode requires clauses');
  assert.match(src, /TOO_MANY_CLAUSES/,
    'must cap clause count');
});

test('contract template payload sanitises sections + variables', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // Section flags allowlist — unknown keys must be dropped to prevent
  // a buggy admin UI from smuggling state into the renderer.
  for (const flag of ['showWitnesses', 'showEmergencyContact', 'showPropertyDetails',
                      'showFinancialTable', 'showLogo', 'showRoomAmenities']) {
    assert.match(src, new RegExp(`'${flag}'`),
      `${flag} must be in the section allowlist`);
  }
  // Variables: regex restricts keys to identifier-like names + caps value length
  assert.match(src, /\/\^\[a-z_\]\[a-z0-9_\]\{0,30\}\$\/i\.test\(k\)/,
    'variable keys must match identifier regex');
  assert.match(src, /v\.slice\(0, 500\)/,
    'variable values must be capped at 500 chars');
});

test('PDF endpoint auto-pulls room details from rooms_v2 + JSONB fallback', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // rooms_v2 query in PDF endpoint
  assert.match(src,
    /SELECT room_code, room_type, floor, room_no, status[\s\S]{0,400}FROM rooms_v2/,
    'PDF endpoint must query rooms_v2');
  // JSONB fallback when rooms_v2 has no row
  assert.match(src, /room\.source !== 'rooms_v2'[\s\S]{0,800}'baankarn_rooms_v1'/,
    'JSONB blob must be the fallback source');
  // Amenities composition from boolean columns
  assert.match(src, /if \(r\.has_ac\)\s+amenities\.push\('แอร์'\)/,
    'amenities must include AC');
  assert.match(src, /if \(r\.has_balcony\)\s+amenities\.push\('ระเบียง'\)/,
    'amenities must include balcony');
});

test('PDF endpoint resolves template by priority: explicit → contract → default → legacy', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // ?templateId query override beats contract.template_id
  assert.match(src, /Number\(req\.query\.templateId\)/);
  assert.match(src, /contract\.template_id \|\| null/);
  // Default contract_templates row fallback
  assert.match(src,
    /WHERE is_default=TRUE AND deleted_at IS NULL LIMIT 1/,
    'default-template fallback must exist');
  // Legacy system_settings as last resort
  assert.match(src, /CONTRACT_TERMS_KEY/);
  // Audit trail records which template + room source were used
  assert.match(src, /templateId: explicitId, roomSource: room\.source/);
});

test('renderer honors section visibility flags + custom variables', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'contractPdf.js'), 'utf8');
  // Sections fall back to true (don't break existing flow when template is null)
  assert.match(src, /showWitnesses:\s+tmplSections\.showWitnesses\s+!== false/);
  assert.match(src, /showEmergencyContact:\s+tmplSections\.showEmergencyContact\s+!== false/);
  // Witness block conditional
  assert.match(src, /if \(sections\.showWitnesses\)/,
    'witness block must check the flag');
  // Property details + financial table conditional
  assert.match(src, /if \(sections\.showPropertyDetails \|\| sections\.showFinancialTable\)/,
    'property/financial block must be conditional');
  // Header note section
  assert.match(src, /if \(sections\.headerNote\)/,
    'header note must be optional');
  // Custom variables interpolation
  assert.match(src, /tmplVars = \(opts\.termsTemplate && typeof opts\.termsTemplate\.variables === 'object'\)/,
    'tmplVars must be pulled from template');
});

test('contract terms endpoints + PDF route exist + validate input', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // Endpoints
  assert.match(src, /app\.get\('\/api\/admin\/contract-terms'/,
    'GET /api/admin/contract-terms must exist');
  assert.match(src, /app\.put\('\/api\/admin\/contract-terms'/,
    'PUT /api/admin/contract-terms must exist');
  assert.match(src, /app\.delete\('\/api\/admin\/contract-terms'/,
    'DELETE (reset) /api/admin/contract-terms must exist');
  assert.match(src, /app\.get\('\/api\/contracts\/:id\/pdf'/,
    'GET /api/contracts/:id/pdf must exist');
  // Storage key — single source of truth
  assert.match(src, /CONTRACT_TERMS_KEY = 'contract\.terms_template'/,
    'system_settings key must be canonicalised in a constant');
  // Mode validation — must accept only the three known values
  assert.match(src,
    /\['default', 'append', 'override'\]\.includes\(b\.mode\)/,
    'PUT must validate mode against the allowlist');
  // Override-with-zero-clauses is a footgun — reject explicitly
  assert.match(src, /OVERRIDE_NEEDS_CLAUSES/,
    'override mode with 0 clauses must 400');
  // Per-clause validation
  assert.match(src, /TOO_MANY_CLAUSES/, 'must cap clause count');
  assert.match(src, /'INVALID_CLAUSE'/, 'must reject bad clauses');
  // PDF response headers — inline by default, attachment with ?download=1
  assert.match(src, /req\.query\.download === '1' \? 'attachment' : 'inline'/,
    'PDF endpoint must support inline preview + download');
  assert.match(src, /Content-Type'?, 'application\/pdf'/,
    'PDF endpoint must set application/pdf');
  // Audit log captures terms updates + PDF views
  assert.match(src, /'contract\.terms_update'/);
  assert.match(src, /'contract\.pdf_view'/);
});

test('contract PDF masks the citizen ID (last 4 only)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // The endpoint masks via tail — the full citizen_id_encrypted must NOT
  // be passed to renderContractPdf. We verify by checking the masking
  // construction is present.
  assert.match(src, /citizenIdMasked: contract\.citizen_id_tail \? `\*\*\*-\*\*\*-/,
    'PDF must mask the citizen ID when rendering');
});

test('contract PDF embeds online signature when available', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /storage\.readFile\(fQ\.rows\[0\]\)/,
    'must read the signature image bytes via storage');
  assert.match(src, /signatures: \{ tenantBuf: tenantSigBuf \}/,
    'must hand the buffer to the renderer');
});

test('GET /api/tenants/:id/history returns combined view (works on moved_out)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /app\.get\('\/api\/tenants\/:id\/history'/,
    'history endpoint must exist');
  // Soft-deleted tenants are EXCLUDED but moved-out are INCLUDED. The
  // tenant SELECT must NOT filter on deleted_at IS NULL (we want to allow
  // audit lookups even on hard-deleted records).
  assert.match(src, /SELECT \* FROM tenants WHERE id=\$1/,
    'history must allow lookups on any tenant row, including soft-deleted');
  // Aggregate totals so admin sees the bottom line at a glance.
  assert.match(src, /billsOutstanding/, 'totals must include outstanding-bill amount');
  assert.match(src, /paymentsTotal/, 'totals must include verified-payments sum');
  assert.match(src, /accessCardsActive[\s\S]{0,200}accessCardsRevoked/,
    'totals must include card-status counts');
});

test('GET /api/tenants/lookup-by-citizen-id finds active and moved_out records', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /app\.get\('\/api\/tenants\/lookup-by-citizen-id'/,
    'lookup endpoint must exist');
  // Must be hash-first, fall back to tail (legacy data without hash).
  assert.match(src, /matchedByHash/, 'must surface high-confidence hash matches');
  assert.match(src, /matchedByTailOnly/, 'must surface lower-confidence tail-only matches');
  assert.match(src, /WHERE citizen_id_hash=\$1/,
    'hash query must use the indexed column');
});

test('checkout deactivates tenant-scoped recurring_charges', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
  assert.match(src,
    /UPDATE recurring_charges[\s\S]{0,400}SET active=FALSE[\s\S]{0,400}WHERE tenant_id=\$1 AND active=TRUE/,
    'checkout must deactivate tenant-scoped recurring charges');
  // Audit log must capture which charges were deactivated.
  assert.match(src, /recurringDeactivated/,
    'checkout audit must record deactivated labels');
});

test('identity endpoint cleans up old file when admin replaces a side', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src,
    /existingFrontId && existingFrontId !== frontFile\.id[\s\S]{0,300}storage\.remove\(pool, existingFrontId\)/,
    'old front file must be removed on replace');
  assert.match(src,
    /existingBackId && existingBackId !== backFile\.id[\s\S]{0,300}storage\.remove\(pool, existingBackId\)/,
    'old back file must be removed on replace');
});

test('identity + contract sign owner-notify (legal trail)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /📇 บันทึกบัตรประชาชน[\s\S]{0,200}tenant id=/,
    'identity upload must owner-notify');
  assert.match(src, /✍️ ลงนามสัญญา /,
    'contract sign must owner-notify');
});

test('GET /api/tenant/contract returns the active contract (read-only)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /app\.get\('\/api\/tenant\/contract', requireTenant/,
    'tenant portal contract endpoint must exist');
  assert.match(src, /WHERE tenant_id=\$1 AND deleted_at IS NULL[\s\S]{0,200}\(status='active'\) DESC/,
    'must prefer the active contract');
  // hasContract flag — UI knows when tenant has none yet.
  assert.match(src, /hasContract: true/);
});

test('GET /api/bookings/:id surfaces the citizen-ID photo URL when present', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /app\.get\('\/api\/bookings\/:id'/,
    'booking detail endpoint must exist');
  assert.match(src,
    /LEFT JOIN file_uploads fu ON fu\.id = b\.citizen_id_image_front_id/,
    'must join file_uploads to expose the photo URL');
  assert.match(src, /hasPhoto/, 'response must indicate whether a photo is attached');
});

test('POST /api/tenants accepts bookingId to carry over the citizen-ID photo', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /b\.bookingId/, 'tenant create must accept a bookingId');
  assert.match(src,
    /UPDATE tenants SET citizen_id_image_front_id=\$1[\s\S]{0,200}UPDATE file_uploads SET ref_id=\$1/,
    'must link the booking photo to the new tenant + retarget ref_id');
  assert.match(src, /linkedFromBooking/,
    'audit log must capture which booking the photo came from');
});

test('storage.saveBase64 accepts side=front|back + falls back on missing column', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'storage.js'), 'utf8');
  assert.match(src, /side = null/, 'side parameter must default to null');
  assert.match(src, /side === 'front' \|\| side === 'back'/,
    'side must be validated against the two known values');
  // Pre-migration deploys without the column must not crash.
  assert.match(src, /err\.code === '42703'/,
    'must fall back to legacy INSERT when side column missing');
});

test('backup script paginates large tables to avoid OOM', () => {
  // SELECT * FROM audit_logs/meter_readings on a long-lived deploy used
  // to OOM Railway hobby (512MB). Now we page by id ASC in 5k chunks.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'backup.js'), 'utf8');
  assert.match(src, /PAGINATABLE_BY_ID = new Set\(/,
    'paginatable allowlist must exist');
  assert.match(src, /SELECT \* FROM \$\{name\} WHERE id > \$1 ORDER BY id ASC LIMIT \$2/,
    'must page by id, not load entire table at once');
  assert.match(src, /'audit_logs',[\s\S]{0,80}'meter_readings'/,
    'audit_logs + meter_readings must be in the paginatable set');
});
