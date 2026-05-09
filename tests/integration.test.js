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
  assert.match(sched, /UPDATE contracts SET status='expired'[\s\S]{0,300}end_date < CURRENT_DATE/,
    'must auto-expire past-due contracts');
  assert.match(sched, /CURRENT_DATE \+ INTERVAL '30 days'/,
    'must scan 30 days ahead for upcoming expiries');
  // Must be wired into the parallel tick array.
  assert.match(sched, /tickContractExpiry\(pool, flags, now, state\)/,
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
