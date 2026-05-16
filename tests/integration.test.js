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

test('room sync bridges legacy JSONB rooms and rooms_v2 both directions', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const roomsRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'rooms.js'), 'utf8');
  assert.match(server, /roomSync\.upsertRoomsV2FromJsonb/,
    'PUT /api/data/baankarn_rooms_v1 must backfill rooms_v2');
  assert.match(roomsRoute, /\/migrate-from-jsonb/,
    'rooms router must expose the documented bulk migration endpoint');
  assert.match(roomsRoute, /upsertJsonbRoomFromV2/,
    'rooms_v2 create/update/restore must mirror back into the legacy room blob');
  assert.match(roomsRoute, /rentOverrideFromBody/,
    'rooms_v2 create/update must preserve per-room rent override fields');
  assert.match(roomsRoute, /rent_override/,
    'rooms_v2 SQL must write rent_override so special room prices do not disappear');
  assert.match(roomsRoute, /ROOM_HAS_REFS/,
    'room delete/rename must refuse active references instead of orphaning rows');
});

test('app_data JSONB writes reject parsed null and audit logs are circular-safe', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idx = server.indexOf("app.put('/api/data/:key'");
  assert.ok(idx > 0, 'should find app_data PUT handler');
  const block = server.slice(idx, server.indexOf("app.delete('/api/data/:key'", idx));

  assert.match(server, /function safeAuditJson\(value, maxBytes = 16_000\)/,
    'audit helper must stringify circular/error details without breaking the request');
  assert.match(server, /safeAuditJson\(detail\)/,
    'audit() must use the circular-safe JSON helper');
  assert.match(server, /truncated: true[\s\S]{0,120}originalLength[\s\S]{0,120}preview/,
    'oversized audit detail must stay valid JSON after truncation');
  assert.match(block, /JSON\.parse\(value\)[\s\S]{0,450}code: 'NULL_VALUE'/,
    'PUT /api/data must reject JSON strings that parse to null');
  assert.match(block, /value === null \|\| typeof value !== 'object' \|\| Array\.isArray\(value\)/,
    'object-shaped app_data keys must not accept null after parsing');
});

test('rooms edit drawer stages type/feature changes and explains pricing impact', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const roomsPage = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-rooms.jsx'), 'utf8');
  const shared = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'shared.jsx'), 'utf8');

  assert.match(roomsPage, /const \[editDraft, setEditDraft\]/,
    'room edit drawer must stage edits in a draft instead of mutating rooms immediately');
  assert.match(roomsPage, /function RoomEditForm\(\{ room, originalRoom, onUpdate, onServerPatch, config \}\)/,
    'RoomEditForm must receive originalRoom for before/after pricing impact');
  assert.match(roomsPage, /disabled=\{!editDirty\}/,
    'save button must only commit when the draft changed');
  assert.match(roomsPage, /ทิ้งการแก้ไขที่ยังไม่ได้บันทึก/,
    'closing/cancel should warn before discarding unsaved room edits');
  assert.match(roomsPage, /ประเภท\/วิว\/คุณสมบัติใช้คำนวณราคาตามสูตร/,
    'type/view/feature controls must tell admin what they are used for');
  assert.match(roomsPage, /ราคาตามสูตร: \{fmtCurrency\(originalComputedRent\)\} →/,
    'UI must show before/after formula rent when toggles move the number');
  assert.match(roomsPage, /key: 'ac', label: 'แอร์'/,
    'rooms UI must expose the AC feature because pricing has featurePremium.ac');
  assert.match(roomsPage, /ac: !!data\.ac/,
    'new rooms and bulk-added rooms must persist the AC feature flag');
  assert.match(roomsPage, /onServerPatch\(patch\)/,
    'server-side reconcile must still update real room state while normal edits stay staged');
  assert.match(shared, /label: 'แอร์'/,
    'room CSV export must include AC so feature flags are not hidden outside the drawer');
});

test('rooms edit drawer rejects event-like patches before dirty comparison', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const roomsPage = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-rooms.jsx'), 'utf8');

  assert.match(roomsPage, /function sanitizeRoomPatch\(patch\)/,
    'room edits must sanitize patches before they enter draft state');
  assert.match(roomsPage, /function isReactEventLike\(value\)/,
    'room edits must detect React click/change events');
  assert.match(roomsPage, /value\.currentTarget && value\.target/,
    'React event objects with DOM currentTarget/target must be blocked');
  assert.match(roomsPage, /key\.startsWith\('__react'\)|key === '_owner'|key === 'stateNode'/,
    'React fiber references must be stripped from room snapshots');
  assert.match(roomsPage, /const editDirty = !!\(editing && editDraft[\s\S]{0,140}safeRoomFingerprint\(editDraft\) !== safeRoomFingerprint\(editing\)/,
    'dirty comparison must use circular-safe room fingerprints');
  assert.doesNotMatch(roomsPage, /JSON\.stringify\(editDraft\)/,
    'dirty comparison must not stringify a possibly polluted draft directly');
  assert.match(roomsPage, /const safePatch = sanitizeRoomPatch\(patch\);[\s\S]{0,220}setEditDraft\(prev => \(\{ \.\.\.safeRoomSnapshot\(prev \|\| editing \|\| \{\}\), \.\.\.safePatch \}\)\)/,
    'draft updates must merge only sanitized room patches');
  assert.match(roomsPage, /Blocked non-serializable room patch/,
    'invalid event patches must produce an operator-visible guarded failure path');
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

test('pricing reset only resets pricing sections', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-pricing.jsx'), 'utf8');
  assert.match(src, /PRICING_CONFIG_KEYS/);
  assert.match(src, /function resetPricingSections/);
  assert.match(src, /resetPricingSections\(config\)/);
  assert.doesNotMatch(src, /setConfig\(DEFAULT_CONFIG\)/,
    'Pricing reset must not overwrite unrelated Settings/Features config');
  assert.doesNotMatch(src, /setDraft\(DEFAULT_CONFIG\)/,
    'Pricing draft reset must not wipe unrelated config sections');
});

test('pricing save validates issues and shows impact review before commit', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const pricing = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-pricing.jsx'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  assert.match(pricing, /function buildPricingReview\(draft, current, rooms\)/,
    'pricing page must run a review before saving config');
  assert.match(pricing, /review\.issues\.length/,
    'pricing review must block abnormal values before save');
  assert.match(pricing, /setConfirmSave\(true\)/,
    'pricing page must open a confirmation modal when warnings or room impact exist');
  assert.match(pricing, /review\.impact\.slice\(0, 8\)/,
    'pricing confirmation must show examples of affected rooms');
  assert.match(pricing, /if \(!cur\[parts\[i\]\] \|\| typeof cur\[parts\[i\]\] !== 'object'\) cur\[parts\[i\]\] = \{\}/,
    'pricing updatePath must create missing nested config sections instead of crashing');
  assert.match(server, /ระบบจะไม่รับค่าราคาที่ผิดปกติเพื่อป้องกันสัญญาและบิลผิด/,
    'server INVALID_CONFIG hint must not advertise a non-existent unsafe force override');
});

test('room add flows use pricing formula and preserve manual rent overrides', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const roomsPage = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-rooms.jsx'), 'utf8');
  const shared = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'shared.jsx'), 'utf8');

  assert.match(roomsPage, /<AddRoomModal[\s\S]*config=\{config\}/,
    'AddRoomModal must receive current pricing config');
  assert.match(roomsPage, /<BulkAddFloorModal[\s\S]*config=\{config\}/,
    'BulkAddFloorModal must receive current pricing config');
  assert.match(roomsPage, /const defaultAddRent = computeRoomRent/,
    'single-room create should default to the active pricing formula');
  assert.match(roomsPage, /const defaultBulkRent = computeRoomRent/,
    'bulk floor create should default to the active pricing formula');
  assert.match(roomsPage, /rentOverride: rentIsOverride \? rent : null/,
    'manual prices on new rooms must be persisted as rentOverride so billing/contracts use them');
  assert.match(roomsPage, /Premium ที่ตั้งไว้/,
    'special-property toggles must explain configured premium impact');
  assert.match(roomsPage, /ใช้ราคาตามสูตร/,
    'admin must be able to return a manual price back to the formula');
  assert.match(roomsPage, /ตรวจสอบก่อนเพิ่มห้อง/,
    'new-room create must warn before committing abnormal/manual pricing');
  assert.match(roomsPage, /ตรวจสอบก่อนเพิ่มชั้น/,
    'bulk create must warn before committing abnormal/manual pricing');
  assert.match(roomsPage, /ตรวจสอบก่อนบันทึกห้อง/,
    'room edit save must warn before applying pricing-sensitive changes');
  assert.match(shared, /Math\.round\(\(base \+ fp \+ vp \+ balcony \+ ac \+ parking \+ kitchen\) \* 100\) \/ 100/,
    'client formula rounding must match the server-side pricing calculation');
});

test('settings automation tab defers scheduler controls to feature flags', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-settings.jsx'), 'utf8');
  assert.match(src, /window\.location\.hash = 'features'/,
    'Settings automation tab should send admins to the actual feature flag controls');
  assert.match(src, /features\.autoBackup\.hourUtc/,
    'UI copy should point to the scheduler-backed autoBackup setting');
  assert.doesNotMatch(src, /updatePath\('automation\./,
    'legacy Settings automation keys are not read by services/scheduler.js');
  assert.doesNotMatch(src, /draft\.automation\./,
    'the tab must not render toggles backed by the legacy automation object');
});

test('settings bill schedule does not expose dead auto-bill date control', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-settings.jsx'), 'utf8');
  assert.doesNotMatch(src, /notify\.billOnDay/,
    'bill issue date is controlled by features.billAutoGenerate, not legacy notify.billOnDay');
  assert.match(src, /billAutoGenerate/,
    'Settings should point admins to the scheduler-backed billAutoGenerate controls');
  assert.match(src, /notify\.dueOnDay/,
    'manual bill due-day default remains editable for the Billing page');
});

test('bill generation honors recurringCharges.autoIncludeOnBillGen', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const scheduler = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
  const extras = fs.readFileSync(path.join(__dirname, '..', 'routes', 'bills-extras.js'), 'utf8');
  // Single-bill POST /api/bills now lives in routes/bills-extras.js (was in
  // server.js before the bills surface was consolidated). Both POST / and
  // POST /bulk-generate gate on the same flag in the same file.
  assert.match(extras, /recurringCharges\?\.enabled && flags\.recurringCharges\?\.autoIncludeOnBillGen !== false && !b\.recurring/,
    'single bill create must not auto-load recurring rows when autoIncludeOnBillGen is false');
  assert.match(scheduler, /recurringCharges\?\.enabled && flags\.recurringCharges\?\.autoIncludeOnBillGen !== false/,
    'scheduler auto bill generation must respect autoIncludeOnBillGen');
  assert.match(extras, /recurringCharges\?\.enabled && flags\.recurringCharges\?\.autoIncludeOnBillGen !== false/,
    'bulk-generate must respect autoIncludeOnBillGen');
});

test('bulk bill generation warns when flat utility mode falls back to metered', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const extras = fs.readFileSync(path.join(__dirname, '..', 'routes', 'bills-extras.js'), 'utf8');
  const billingPage = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-billing.jsx'), 'utf8');
  assert.match(extras, /const flatFellBack = \[\]/,
    'bulk-generate must collect rooms where flat utility mode fell back');
  assert.match(extras, /bill\.waterFlatFellBack \|\| bill\.elecFlatFellBack/,
    'bulk-generate must detect both water and electricity flat fallback flags');
  assert.match(extras, /res\.json\(\{ ok: true, period, made, skipped, flatFellBack \}\)/,
    'bulk-generate response must expose flat fallback details to the UI');
  assert.match(billingPage, /Array\.isArray\(d\.flatFellBack\)/,
    'billing UI must read flat fallback details');
  assert.match(billingPage, /ตั้งโหมดเหมาไว้แต่ยังไม่กรอกจำนวน/,
    'billing UI must warn the operator in plain language');
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
                      'SLIPOK_PARSE', 'EASYSLIP_PARSE', 'SLIP2GO_PARSE',
                      'SLIP_PENDING', 'NOT_CONFIGURED',
                      'UNKNOWN_PROVIDER']) {
    assert.ok(sv.TRANSIENT_CODES.has(code),
      `TRANSIENT_CODES must include ${code} (server-side fallback contract)`);
  }
});

test('slipVerifier Slip2Go integration uses multipart image endpoint', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'slipVerifier.js'), 'utf8');

  assert.match(src, /slip2go:\s*\{\s*keys:\s*\['SLIP2GO_API_KEY', 'SLIP2GO_API_URL'\]/,
    'Slip2Go must require both API key and base URL');
  assert.match(src, /endpointFromBase\(secrets\.get\('SLIP2GO_API_URL'\), '\/api\/verify-slip\/qr-image\/info'\)/,
    'Slip2Go must call the documented qr-image endpoint');
  assert.match(src, /name:\s*'file'/,
    'Slip2Go multipart image field must be named file');
  assert.match(src, /fields:\s*\{\s*payload:\s*JSON\.stringify\(payload\)/,
    'Slip2Go multipart payload field must be a JSON string');
  assert.match(src, /checkDuplicate:\s*true/,
    'Slip2Go should ask provider to flag duplicate/reused slips');
  assert.match(src, /checkAmount\s*=\s*\{\s*type:\s*'eq'/,
    'Slip2Go should pass expected amount to provider-side matching');
  assert.match(src, /\['200000', '200200'\]\.includes\(responseCode\)/,
    'Slip2Go must accept both Slip Found and Slip is Valid success codes');
  assert.match(src, /c === '200501'.*DUPLICATE_SLIP/s,
    'Slip2Go duplicate response must be a hard rejection');
});

test('slipVerifier EasySlip integration uses v2 bank image multipart API', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'slipVerifier.js'), 'utf8');

  assert.match(src, /hostname:\s*'api\.easyslip\.com'/,
    'EasySlip must use the current api.easyslip.com host');
  assert.match(src, /path:\s*'\/v2\/verify\/bank'/,
    'EasySlip must call POST /v2/verify/bank');
  assert.match(src, /multipart\/form-data; boundary=\$\{boundary\}/,
    'EasySlip image verify must send multipart/form-data');
  assert.match(src, /name:\s*'image'/,
    'EasySlip multipart file field must be named image');
  assert.match(src, /fields\.matchAmount/,
    'EasySlip should pass expected amount to provider-side matching');
  assert.match(src, /checkDuplicate:\s*'true'/,
    'EasySlip should ask provider to flag duplicate/reused slips');
  assert.match(src, /d\.rawSlip/,
    'EasySlip v2 response mapper must read data.rawSlip');
  assert.match(src, /d\.amountInSlip/,
    'EasySlip v2 response mapper must read data.amountInSlip');
  assert.match(src, /d\.isDuplicate === true/,
    'EasySlip duplicate result must be a hard rejection');
  assert.doesNotMatch(src, /developer\.easyslip\.com/,
    'legacy EasySlip v1 developer host must not be used');
  assert.doesNotMatch(src, /\/api\/v1\/verify/,
    'legacy EasySlip v1 endpoint must not be used');
});

test('slipVerifier rejects auto-verify when provider omits receiver account', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'slipVerifier.js'), 'utf8');

  assert.match(src, /acceptableTargets\.length && !result\.receiver\?\.account/,
    'auto-verify must require a provider receiver account when any receiver target is configured');
  assert.match(src, /code:\s*'RECEIVER_UNREADABLE'/,
    'missing receiver account should be classified as RECEIVER_UNREADABLE');
});

test('slipVerifier accepts the configured bank account as a secondary receiver target', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'slipVerifier.js'), 'utf8');

  // The invoice's bank account (config.payment.bankAcc) must be forwarded
  // to slipVerifier as a fallback receiver, so a tenant who pays the bank
  // account directly (instead of scanning the PromptPay QR) isn't falsely
  // rejected with RECEIVER_MISMATCH.
  assert.match(server, /paymentBlock\.bankInfo && paymentBlock\.bankInfo\.account/,
    'upload handler must read the invoice bank account from paymentBlock');
  assert.match(server, /additionalReceiverTargets:\s*extraTargets/,
    'upload handler must pass extra receiver targets to slipVerifier');
  assert.match(src, /additionalReceiverTargets/,
    'slipVerifier must accept additionalReceiverTargets in expected');
  assert.match(src, /acceptableTargets\.push/,
    'slipVerifier must accumulate every acceptable receiver target before matching');
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

test('slipVerifier.getConfiguredProviders requires Slip2Go key and API URL', () => {
  const oldKey = process.env.SLIP2GO_API_KEY;
  const oldUrl = process.env.SLIP2GO_API_URL;
  process.env.SLIP2GO_API_KEY = 'k1';
  delete process.env.SLIP2GO_API_URL;
  delete require.cache[require.resolve('../services/secrets')];
  delete require.cache[require.resolve('../services/slipVerifier')];
  let sv = require('../services/slipVerifier');
  let got = sv.getConfiguredProviders({
    slipUpload: { autoVerify: true, providers: ['slip2go'] },
  });
  assert.equal(got.length, 0, 'Slip2Go should not be ready without SLIP2GO_API_URL');

  process.env.SLIP2GO_API_URL = '::::';
  delete require.cache[require.resolve('../services/secrets')];
  delete require.cache[require.resolve('../services/slipVerifier')];
  sv = require('../services/slipVerifier');
  got = sv.getConfiguredProviders({
    slipUpload: { autoVerify: true, providers: ['slip2go'] },
  });
  assert.equal(got.length, 0, 'Slip2Go should not be ready with an invalid SLIP2GO_API_URL');

  process.env.SLIP2GO_API_URL = 'https://example.slip2go.test';
  delete require.cache[require.resolve('../services/secrets')];
  delete require.cache[require.resolve('../services/slipVerifier')];
  sv = require('../services/slipVerifier');
  got = sv.getConfiguredProviders({
    slipUpload: { autoVerify: true, providers: ['slip2go'] },
  });
  assert.equal(got.length, 1);
  assert.equal(got[0].id, 'slip2go');

  if (oldKey != null) process.env.SLIP2GO_API_KEY = oldKey; else delete process.env.SLIP2GO_API_KEY;
  if (oldUrl != null) process.env.SLIP2GO_API_URL = oldUrl; else delete process.env.SLIP2GO_API_URL;
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
  // Locate the shared tenant payment handler and isolate the tx body.
  const m = server.match(
    /async function tenantPaymentUploadHandler[\s\S]*?await client\.query\('BEGIN'\);([\s\S]*?)await client\.query\('COMMIT'\)/
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
  assert.match(body, /SELECT id, status, total, deleted_at FROM bills WHERE id=\$1 FOR UPDATE/,
    'admin verify must lock and inspect the target bill total');
  assert.match(body, /BILL_NOT_PAYABLE/,
    'admin verify must refuse paid, void, deleted, or missing bills');
  assert.match(body, /BILL_MARK_PAID_FAILED/,
    'admin verify must fail closed if the bill update affects no row');
});

test('/api/payments/:id/verify rejects amount mismatches before marking paid', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idx = server.indexOf("app.put('/api/payments/:id/verify'");
  assert.ok(idx > 0, 'should find admin verify handler');
  const tail = server.slice(idx);
  const nextIdx = tail.slice(50).search(/\napp\.(get|put|post|delete|use)\(/);
  const body = nextIdx > 0 ? tail.slice(0, 50 + nextIdx) : tail.slice(0, 5000);
  assert.match(body, /Number\(bill\.rows\[0\]\.total\)/,
    'verify path must read the bill total under lock');
  // Tolerance lives in services/billing.PAYMENT_TOLERANCE_THB so the four
  // enforcement points (tenant upload, payment verify, bill verify-slip,
  // manual pay) stay in sync. The check must reference the shared constant
  // rather than a hard-coded literal — pin that here.
  assert.match(body, /Math\.abs\(paymentAmount - billTotal\) > billing\.PAYMENT_TOLERANCE_THB/,
    'verify path must compare payment amount to bill total via shared constant');
  assert.match(body, /PAYMENT_AMOUNT_MISMATCH/,
    'verify path must fail closed on amount mismatch');
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
  // 4000 char window — handler grew when REJECT_REASON_TOO_LONG validation
  // + verifier session-fallback guard were added. The handler boundary is
  // the next `r.post(` or end-of-file, but slicing a generous fixed window
  // keeps the test simple while still bounded.
  const body = route.slice(idx, idx + 4000);
  assert.match(body, /requireRole\('owner', 'manager'\)/,
    'bill-id verify path must use the same owner/manager policy as payment-id verify');
  assert.doesNotMatch(body, /requireRole\('owner', 'manager', 'staff'\)/,
    'staff must not verify or reject slips through the bill-id shortcut');
  assert.match(body, /BILL_NOT_PAYABLE|BILL_MARK_PAID_FAILED/,
    'bill-id verify path must fail closed when the bill is not payable');
  assert.match(body, /PAYMENT_AMOUNT_MISMATCH/,
    'bill-id verify path must reject amount mismatches');
});

test('/api/bills/:id/pay records offline payments in the payment ledger', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'bills-extras.js'), 'utf8');
  const idx = route.indexOf("r.post('/:id/pay'");
  assert.ok(idx > 0, 'should find bill manual-pay handler');
  // 8000 char window — the handler grew when we added optional slip upload
  // (storage.saveBase64 call + rollback cleanup) ahead of the INSERT.
  const body = route.slice(idx, idx + 8000);
  assert.match(body, /requireRole\('owner', 'manager'\)/,
    'manual pay must be owner/manager only');
  assert.match(body, /SELECT id, bill_no, period, total, status, tenant_id[\s\S]*FOR UPDATE/,
    'manual pay must lock the bill and read total');
  assert.match(body, /INSERT INTO payments[\s\S]*'verified'/,
    'manual pay must create a verified payment row');
  assert.match(body, /UPDATE bills SET status='paid', paid_at=NOW\(\)/,
    'manual pay must mark the bill paid in the same handler');
  assert.match(body, /PAYMENT_AMOUNT_MISMATCH|BILL_ALREADY_PAID/,
    'manual pay must reject mismatches and duplicate verified payments');
  assert.match(body, /notifyManualPayment/,
    'manual pay must notify tenant after recording an offline payment');
});

test('/api/bills create validates input and refuses to mutate paid/verified ledger rows', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  // POST /api/bills moved into routes/bills-extras.js when the bill surface
  // was consolidated. Look for the router declaration there rather than the
  // old `app.post(...)` form that used to live in server.js.
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'bills-extras.js'), 'utf8');
  const idx = route.indexOf("r.post('/', sameOrigin");
  assert.ok(idx > 0, 'should find bill create handler');
  const body = route.slice(idx, idx + 12000);
  assert.match(body, /validateBody\(schemas\.generateBill\)/,
    'bill create must use request schema validation');
  assert.match(body, /WHERE bills\.status IN \('pending','overdue'\)/,
    'bill update-on-conflict must only edit pending/overdue bills');
  assert.match(body, /NOT EXISTS[\s\S]*payments p[\s\S]*p\.status='verified'/,
    'bill update-on-conflict must refuse bills with verified payments');
  assert.match(body, /BILL_LOCKED_FOR_LEDGER/,
    'locked ledger rows should return a machine-readable conflict');
  assert.match(body, /JSON\.stringify\(otherForStorage/,
    'computed recurring line items must be persisted in bills.other');
});

test('/api/notify/bill resolves the tenant instead of notifying only the owner', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idx = server.indexOf("app.post('/api/notify/bill'");
  assert.ok(idx > 0, 'should find legacy bill notify handler');
  const body = server.slice(idx, idx + 2500);
  assert.match(body, /FROM tenants[\s\S]*current_room_id=\$1/,
    'legacy bill notify must look up the active tenant by room');
  assert.match(body, /notifier\.notifyTenant/,
    'legacy bill notify must send to tenant channels');
  assert.match(body, /NO_TENANT_CHANNEL/,
    'legacy bill notify must fail clearly when no tenant channel exists');
});

test('tenant drawer send-message button calls real tenant notify endpoint', () => {
  // Regression: the button used to show "sent via LINE" without touching the
  // backend. It must prompt for a message and POST to a server route that
  // resolves the active tenant and dispatches via notifier.notifyTenant.
  const fs = require('node:fs');
  const path = require('node:path');
  // The /api/tenants surface lives in routes/tenant-ops.js (round 9 consolidation).
  // Extract the notify handler block via the next router declaration as the
  // upper bound so we don't accidentally pick up assertions from neighbouring
  // routes.
  const ops = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
  const route = ops.match(/r\.post\('\/notify'[\s\S]+?r\.(get|post|put|delete)\(/)[0];
  assert.match(route, /requireRole\('owner', 'manager', 'staff'\)/,
    'tenant message endpoint must be role-gated');
  assert.match(route, /status='active'/,
    'endpoint must only target active tenants');
  assert.match(route, /notifier\.notifyTenant\(\{ pool, features: flags \}, tenant/,
    'endpoint must dispatch through the unified tenant notifier');
  assert.match(route, /NO_TENANT_CHANNEL/,
    'endpoint must surface no-channel failures instead of pretending success');

  const ui = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-tenants.jsx'), 'utf8');
  assert.match(ui, /window\.prompt\(`ส่งข้อความถึง \$\{t\.name\}/,
    'UI must collect an actual message');
  assert.match(ui, /apiFetch\('\/api\/tenants\/notify'/,
    'UI button must POST to the real notify endpoint');
  assert.doesNotMatch(ui, /ส่งข้อความถึง \$\{active\.name\} ทาง LINE แล้ว/,
    'UI must not show the old fake LINE-sent toast');
});

test('/api/bills/:id/send fails closed when tenant has no reachable channel', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'bills-extras.js'), 'utf8');
  const idx = route.indexOf('async function enqueueBillNotifications');
  assert.ok(idx > 0, 'should find bill send helper');
  const helperEnd = route.indexOf('  // POST /api/bills/:id/send', idx);
  const helperBody = route.slice(idx, helperEnd > idx ? helperEnd : idx + 14000);
  assert.match(helperBody, /NO_TENANT_CHANNEL/,
    'bill send helper must return a no-channel code');
  assert.match(helperBody, /Bill send skipped: no tenant channel/,
    'bill send helper must alert owner/admin when tenant cannot be reached');
  const postIdx = route.indexOf("r.post('/:id/send'", helperEnd > idx ? helperEnd : idx);
  assert.ok(postIdx > 0, 'should find single bill send route');
  const postBody = route.slice(postIdx, postIdx + 2000);
  assert.match(postBody, /out\.code === 'NO_TENANT_CHANNEL' \? 409 : 404/,
    'single-send route must surface no-channel as a conflict, not success');
});

test('LINE bill notification offers both PromptPay QR and bank transfer details', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'bills-extras.js'), 'utf8');
  const msgStart = route.indexOf('function buildBillLineMessages');
  assert.ok(msgStart > 0, 'should find LINE bill message builder');
  const msgBody = route.slice(msgStart, route.indexOf('  function rowKV', msgStart));
  assert.match(msgBody, /bankInfo/,
    'LINE Flex builder must accept bankInfo');
  assert.match(msgBody, /หรือโอนเข้าบัญชีธนาคาร/,
    'LINE Flex body must show bank-transfer as an alternative to QR');
  assert.match(msgBody, /เลขบัญชี/,
    'LINE text fallback must include the bank account number');
  assert.match(msgBody, /ส่งสลิป/,
    'LINE message must tell tenant where to send the slip after paying');

  const helperStart = route.indexOf('async function enqueueBillNotifications');
  assert.ok(helperStart > 0, 'should find bill send helper');
  const helperBody = route.slice(helperStart, route.indexOf('  // POST /api/bills/:id/send', helperStart));
  assert.match(helperBody, /billing\.buildPaymentBlock\(configRow\.rows\[0\]\?\.value \|\| \{\}\)/,
    'bill send helper must load configured payment block before composing LINE');
  assert.match(helperBody, /buildBillLineMessages\(b,[\s\S]{0,200}bankInfo/,
    'bill send helper must pass bankInfo into LINE messages');
});

test('LINE bill notification only advertises usable PromptPay QR', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'bills-extras.js'), 'utf8');
  const helperStart = route.indexOf('async function enqueueBillNotifications');
  assert.ok(helperStart > 0, 'should find bill send helper');
  const helperBody = route.slice(helperStart, route.indexOf('  // POST /api/bills/:id/send', helperStart));

  assert.match(helperBody, /normaliseTarget\(paymentBlock\.promptpayTarget\)/,
    'helper must validate PromptPay target before advertising QR');
  assert.match(helperBody, /isDemoTarget\(normalizedPromptPay\)/,
    'helper must hide demo PromptPay QR from tenant notifications');
  assert.match(helperBody, /if \(canShowPromptPayQr\) \{[\s\S]{0,180}paymentChoices\.push/,
    'QR payment choice must be gated by PromptPay readiness');
  assert.match(helperBody, /const canEmbedPromptPayQr = !!\(publicUrl && qrToken && canShowPromptPayQr\)/,
    'LINE QR image requires public URL, signed token, and a usable PromptPay target');
  assert.match(helperBody, /qrToken: canEmbedPromptPayQr \? qrToken : null/,
    'Flex builder must not receive a QR token when QR should be hidden');
  assert.match(helperBody, /publicUrl && \(canEmbedPromptPayQr \|\| bankInfo\)/,
    'bank-transfer-only LINE Flex should still be allowed when a public URL exists');
});

test('healthCheck flags duplicate verified payments and invalid ledger rows', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'healthCheck.js'), 'utf8');
  assert.match(src, /duplicate_verified_payments_per_bill/,
    'health check must count bills with multiple verified payments');
  assert.match(src, /invalid_bill_rows/,
    'health check must count invalid bill status/amount rows');
  assert.match(src, /invalid_payment_rows/,
    'health check must count invalid payment status/amount rows');
});

test('/api/tenant/payments does not auto-approve unverified slips by default', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idx = server.indexOf('async function tenantPaymentUploadHandler');
  assert.ok(idx > 0, 'should find tenant payment upload handler');
  const end = server.indexOf('// Atomic:', idx);
  const body = server.slice(idx, end > idx ? end : idx + 12000);
  assert.match(body, /allowUnverifiedAutoApprove/,
    'legacy trust mode must require an explicit flag');
  assert.match(body, /initialStatus = allowUnverifiedAutoApprove \? 'verified' : 'pending'/,
    'uploads without a provider result must fall back to the admin queue');
});

test('/api/tenant/payments auto-verify checks the effective PromptPay target', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idx = server.indexOf('async function tenantPaymentUploadHandler');
  assert.ok(idx > 0, 'should find tenant payment upload handler');
  const end = server.indexOf('// Decide the payment row', idx);
  const body = server.slice(idx, end > idx ? end : idx + 14000);
  assert.match(body, /loadEffectivePaymentBlock\(\)/,
    'auto-verify must use the same effective payment config as QR/PDF');
  assert.match(body, /normaliseTarget\(paymentBlock\.promptpayTarget\)/,
    'auto-verify must normalize and validate the configured receiver target');
  assert.match(body, /promptpayTarget: ppTarget/,
    'auto-verify must pass the verified receiver target to slipVerifier');
  assert.doesNotMatch(body, /const ppTarget = require\('\.\/services\/secrets'\)\.get\('PROMPTPAY_TARGET'\)/,
    'auto-verify must not ignore Settings payment config');
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

test('public bill payment link is tokenized and does not require tenant login', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const billsExtras = fs.readFileSync(path.join(__dirname, '..', 'routes', 'bills-extras.js'), 'utf8');
  const payHtml = fs.readFileSync(path.join(__dirname, '..', 'project', 'pay.html'), 'utf8');
  assert.match(server, /function signBillPayToken\(billId/,
    'server must sign a dedicated public bill-payment token');
  assert.match(server, /function verifyBillPayToken\(billId, token\)/,
    'server must verify public bill-payment tokens');
  assert.match(server, /app\.get\('\/pay\/:billId'/,
    'public pay page must be served without tenant auth');
  assert.match(server, /app\.get\('\/api\/public\/bills\/:billId\/payment'/,
    'public payment info endpoint must exist');
  assert.match(server, /app\.post\('\/api\/public\/bills\/:billId\/payments'/,
    'public slip upload endpoint must exist');
  assert.match(server, /verifyBillPayToken\(id, token\)/,
    'public endpoints must reject invalid or expired tokens');
  assert.match(server, /tenantPaymentUploadHandler\(req, res\)/,
    'public upload must reuse the same slip validation/payment handler');
  assert.match(billsExtras, /signBillPayToken\(billId\)/,
    'bill notifications must generate public pay links');
  assert.match(billsExtras, /\/pay\/\$\{encodeURIComponent\(billId\)\}\?t=/,
    'bill notifications must link to /pay/:billId with token');
  assert.match(payHtml, /<meta name="referrer" content="same-origin"\/>/,
    'public token page must not leak the full token URL as cross-origin referer');
});

test('public bill QR has a token-gated payload fallback and never trusts query target/amount', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idx = server.indexOf("app.get('/p/bill-qr/:billId'");
  assert.ok(idx > 0, 'public bill QR endpoint must exist');
  const end = server.indexOf("app.get('/pay/:billId'", idx);
  const body = server.slice(idx, end > idx ? end : idx + 4500);
  assert.match(body, /verifyBillQrToken\(id, token\)/,
    'public QR fallback must stay behind the signed QR token');
  assert.match(body, /SELECT id, total, status, tenant_id FROM bills/,
    'public QR must read the amount from the persisted bill row');
  assert.match(body, /bill\.status !== 'pending' && bill\.status !== 'overdue'/,
    'public QR must refuse paid/void/stale bill links');
  assert.match(body, /format === 'json' \|\| format === 'payload'/,
    'public QR must expose a JSON/payload fallback for broken images');
  assert.match(body, /buildPromptPayPayload\(paymentBlock\.promptpayTarget, amount\)/,
    'payload fallback must be generated from server payment config and DB amount');
  assert.match(body, /renderQrDataUrl\(paymentBlock\.promptpayTarget, amount\)/,
    'JSON fallback should still try to return a renderable image');
  assert.match(body, /renderQrSvg\(paymentBlock\.promptpayTarget, amount\)/,
    'JSON fallback should have an SVG renderer fallback');
  assert.match(body, /targetLast4/,
    'public JSON must avoid sending the full receiver target as a separate field');
  assert.match(body, /Cache-Control', 'no-store'/,
    'public QR responses must not be cached after a bill changes status');
  assert.doesNotMatch(body, /req\.query\.(?:amount|target)/,
    'public QR must not accept caller-supplied amount or target');
});

test('public payment page falls back to payload when QR image loading fails', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const pay = fs.readFileSync(path.join(__dirname, '..', 'project', 'pay.jsx'), 'utf8');
  assert.match(pay, /const \[qrFallback, setQrFallback\]/,
    'public payment UI must track QR fallback state');
  assert.match(pay, /appendQuery\(data\.qrUrl, \{ format: 'json' \}\)/,
    'public payment UI must request the tokenized JSON fallback without corrupting existing query params');
  assert.match(pay, /onError=\{\(e\) => \{/,
    'public QR image must detect render/load failures');
  assert.match(pay, /navigator\.clipboard\.writeText\(qrFallback\.payload\)/,
    'fallback payload must be copyable for bank-app paste-to-pay');
  assert.doesNotMatch(pay, /dangerouslySetInnerHTML/,
    'public QR fallback must not inject SVG as raw HTML');
});

test('public bill payment upload has retry limit + admin-visible diagnostics', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const pay = fs.readFileSync(path.join(__dirname, '..', 'project', 'pay.jsx'), 'utf8');
  const adminPayments = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-payments.jsx'), 'utf8');

  assert.match(server, /PUBLIC_SLIP_UPLOAD_MAX_ATTEMPTS\s*=\s*3/,
    'public payment link must cap slip uploads at 3 attempts');
  assert.match(server, /loadBillPaymentAttemptSummary/,
    'server must expose persisted upload attempt state from payments rows');
  assert.match(server, /PAYMENT_UNDER_REVIEW/,
    'server must block another upload while a slip is pending admin review');
  assert.match(server, /SLIP_UPLOAD_LIMIT_REACHED/,
    'server must block uploads after the retry limit is reached');
  assert.match(server, /SLIP_UPLOAD_DISABLED/,
    'tenant/public upload paths must return a stable disabled code');
  assert.match(server, /อัปโหลดสลิปล้มเหลว/,
    'public upload fallback errors must be user-facing Thai, not raw English');
  assert.match(server, /upload:\s*\{/,
    'public payment APIs must return upload attempt details to the page');
  const handlerIdx = server.indexOf('async function tenantPaymentUploadHandler');
  const retryGate = server.slice(handlerIdx, server.indexOf('// Hash the actual slip bytes', handlerIdx));
  assert.match(retryGate, /const attemptsBeforeUpload = await loadBillPaymentAttemptSummary/,
    'shared upload handler must load attempt state before accepting any slip');
  assert.ok(
    retryGate.indexOf('const attemptsBeforeUpload = await loadBillPaymentAttemptSummary')
      < retryGate.indexOf('if (req.publicPayment)'),
    'retry gate must apply before the public-link-only metadata branch so tenant portal uploads are capped too'
  );
  assert.match(pay, /redirect:\s*'manual'/,
    'public pay page must not silently follow an auth/login redirect during upload');
  assert.match(pay, /กำลังประมวลผลสลิป/,
    'public pay page must show a processing state while the slip is uploading');
  assert.match(pay, /contactAdminMessage/,
    'public pay page must show contact-admin guidance on failed uploads');
  assert.match(adminPayments, /อัปโหลดสลิป:/,
    'admin slip modal must show upload attempts');
  assert.match(adminPayments, /สถานะบิล:/,
    'admin slip modal must show whether the bill is still unpaid/paid');
  assert.match(adminPayments, /รหัสตรวจสลิป:/,
    'admin slip modal must surface verifier failure codes for detailed review');
});

test('slip upload returns structured verifier results to tenant/public UIs', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const tenant = fs.readFileSync(path.join(__dirname, '..', 'project', 'tenant.jsx'), 'utf8');
  const pay = fs.readFileSync(path.join(__dirname, '..', 'project', 'pay.jsx'), 'utf8');

  assert.match(server, /function buildSlipVerificationNotice/,
    'server must build a structured tenant-facing verifier notice');
  assert.match(server, /verification:\s*buildSlipVerificationNotice/,
    'upload response must include the verifier notice');
  assert.match(server, /AMOUNT_MISMATCH[\s\S]{0,300}ยอดในสลิปไม่ตรงกับยอดบิล/,
    'server notice must explain amount mismatches');
  assert.match(server, /RECEIVER_MISMATCH[\s\S]{0,300}บัญชีปลายทางไม่ตรงกับที่ตั้งไว้/,
    'server notice must explain receiver mismatches');
  assert.match(server, /attempts:\s*Array\.isArray\(verifyResult\?\.attempts\)/,
    'server notice must include provider attempt trail');
  assert.match(server, /const verifyDetailLines = \[/,
    'owner payment notification must build a detailed verifier section');
  assert.match(server, /ยอดที่บริการอ่านจากสลิป/,
    'owner payment notification must include the provider-read amount');
  assert.match(server, /ผู้รับในสลิป/,
    'owner payment notification must include the slip receiver detail');
  assert.match(server, /เส้นทาง provider/,
    'owner payment notification must include provider fallback trail');

  assert.match(tenant, /paymentNoticeFromResponse/,
    'tenant portal must render structured verification response');
  assert.match(tenant, /setNotice\(paymentNoticeFromResponse\(out, locale\)\)/,
    'tenant upload must show verifier outcome from the API');
  assert.match(tenant, /บริการตรวจสลิป/,
    'tenant notice must include provider detail');
  assert.match(tenant, /รหัสอ้างอิงสำหรับแจ้งแอดมิน/,
    'tenant notice should present verifier codes as admin reference, not user-facing jargon');
  assert.doesNotMatch(tenant, /setMsg\(t\('uploadOk'\)\)/,
    'tenant upload must not collapse every outcome to a generic success string');
  assert.doesNotMatch(tenant, /setTimeout\(\(\) => \{ onClose\(\); refresh\(\); \}, 800\)/,
    'tenant modal must stay open long enough to show the upload result');

  assert.match(pay, /verificationMessage/,
    'public pay link must render structured verification response');
  assert.match(pay, /ยอดที่อ่านจากสลิป/,
    'public pay link must show the provider-read amount when available');
  assert.match(pay, /รหัสอ้างอิงสำหรับแจ้งแอดมิน/,
    'public pay link should present verifier codes as an admin reference');
});

test('/api/payments exposes admin queue summary counts', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const adminPayments = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-payments.jsx'), 'utf8');

  assert.match(server, /summaryRes\s*=\s*await pool\.query/,
    'payments list endpoint must query global payment status summary');
  assert.match(server, /const summary = \{\s*pending:\s*\{ count: 0, amount: 0 \}/,
    'payments list endpoint must return a stable pending/verified/rejected summary shape');
  assert.match(server, /res\.json\(\{ ok: true, payments: rows, summary, limit, offset \}\)/,
    'payments list response must include summary');
  assert.match(adminPayments, /const \[summary, setSummary\]/,
    'admin payments page must track queue summary state');
  assert.match(adminPayments, /const \[filter, setFilter\] = useState\(FILTER_ALL\)/,
    'admin payments page must open on the all-status queue, not pending-only');
  assert.match(adminPayments, /const \[search, setSearch\] = useState\(''\)/,
    'admin payments page must provide local search across the loaded queue');
  assert.match(adminPayments, /filter === FILTER_ALL \? PAYMENT_STATUS_ORDER : \[filter\]/,
    'all-status mode must load every payment status instead of hiding verified/rejected rows');
  assert.match(adminPayments, /Promise\.all\(statuses\.map/,
    'all-status mode should load status batches together so the queue stays responsive');
  assert.match(adminPayments, /sortPaymentsNewestFirst\(payments\)/,
    'admin payments page must normalize ordering with newest slips first');
  assert.match(adminPayments, /visibleList\.map/,
    'admin payments page must render the filtered/searched list, not the raw status response');
  assert.match(adminPayments, /<option value=\{FILTER_ALL\}>/,
    'admin payments page must expose an all-status filter option');
  assert.match(adminPayments, /countFor\(status\)/,
    'admin payments page must display per-status counts');
  assert.match(adminPayments, /เส้นทางตรวจ:/,
    'admin payment modal must show provider attempt trail');
  assert.match(adminPayments, /function paymentStatusLabel/,
    'admin payments page must translate payment statuses into Thai labels');
  assert.match(adminPayments, /function billStatusLabel/,
    'admin payments page must translate bill statuses into Thai labels');
  assert.match(adminPayments, /formatVerifyAttempt/,
    'admin payment modal must translate provider attempt trail for operators');
  assert.match(adminPayments, /ผู้โอนในสลิป/,
    'admin payment modal must show sender details when verifier provides them');
});

test('LINE image messages can submit slips through the shared payment handler', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const webhooks = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhooks.js'), 'utf8');
  const line = fs.readFileSync(path.join(__dirname, '..', 'services', 'line.js'), 'utf8');
  assert.match(line, /async function getMessageContent/,
    'LINE service must download message image content');
  assert.match(webhooks, /ev\.message\?\.type === 'image'/,
    'webhook must branch on LINE image messages');
  assert.match(webhooks, /handleSlipImageMessage/,
    'webhook must route images to a slip handler');
  assert.match(webhooks, /lineSvc\.getMessageContent\(oa, ev\.message\.id/,
    'LINE image handler must download the image bytes from LINE');
  assert.match(webhooks, /processTenantSlipUpload\(\{/,
    'LINE image handler must reuse the shared payment upload handler');
  assert.match(webhooks, /skipTenantAck: true/,
    'LINE image handler should reply in-chat instead of sending a duplicate tenant ack');
  const handlerIdx = server.indexOf('async function tenantPaymentUploadHandler');
  const ackBlock = server.slice(handlerIdx, server.indexOf('const attemptSummary = await loadBillPaymentAttemptSummary', handlerIdx));
  assert.match(ackBlock, /if \(!req\.skipTenantAck\) \{\s*try \{/,
    'shared slip handler must suppress tenant ack when LINE webhook already replies in-chat');
  assert.match(webhooks, /bills\.length > 1/,
    'LINE image handler must refuse ambiguous multiple payable bills');
});

test('bill upload UIs refresh status and hide upload controls after paid', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tenant = fs.readFileSync(path.join(__dirname, '..', 'project', 'tenant.jsx'), 'utf8');
  const pay = fs.readFileSync(path.join(__dirname, '..', 'project', 'pay.jsx'), 'utf8');
  assert.match(tenant, /setInterval\(\(\) => \{\s*if \(typeof refresh === 'function'\) refresh\(\);[\s\S]*5000/,
    'tenant bill modal must poll for payment status changes while open');
  assert.match(pay, /const paid = !!\(data && data\.paid\)/,
    'public pay page must derive a paid state');
  assert.match(pay, /const canUpload = !!\(data && data\.channels && data\.channels\.slip && !paid && \(!uploadState \|\| uploadState\.canUpload !== false\)\)/,
    'public pay page must disable upload controls once paid');
  assert.match(pay, /setInterval\(\(\) => load\(true\), 5000\)/,
    'public pay page must poll for near-real-time status updates');
  assert.match(tenant, /const \[fileInputKey, setFileInputKey\]/,
    'tenant upload UI must track a file input reset key');
  assert.match(tenant, /<input key=\{fileInputKey\} type="file"/,
    'tenant upload UI must clear the file input after a handled upload');
  assert.match(pay, /const \[fileInputKey, setFileInputKey\]/,
    'public pay UI must track a file input reset key');
  assert.match(pay, /<input key=\{fileInputKey\} type="file"/,
    'public pay UI must clear the file input after a handled upload');
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
  const body = server.slice(idx, idx + 5000);
  assert.match(body, /not your bill/,
    'tenant PDF must reject mismatched tenant_id');
  assert.match(body, /BILL_VOID/,
    'tenant PDF must refuse void bills (so tenants do not pay via QR on a dead bill)');
  assert.match(body, /renderBillPdf\(bill, res\)/,
    'tenant PDF must stream through renderBillPdf');
});

test('bill PDFs include before/after utility meter snapshots', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const migrate = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrate.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const billingSvc = fs.readFileSync(path.join(__dirname, '..', 'services', 'billing.js'), 'utf8');

  for (const col of ['water_prev_reading', 'water_current_reading', 'elec_prev_reading', 'elec_current_reading']) {
    assert.match(migrate, new RegExp(`ALTER TABLE bills ADD COLUMN IF NOT EXISTS ${col}`),
      `migration must add ${col}`);
    assert.match(server, new RegExp(col),
      `bill routes must persist/select ${col}`);
  }
  assert.match(billingSvc, /resolveUtilityUsage\(room, 'water'\)/,
    'bill calculation must derive water units from before/after readings when available');
  assert.match(billingSvc, /buildUtilityItem\('ค่าไฟฟ้า'/,
    'utility line items must carry readable meter math for PDF rendering');
  assert.match(server, /billing\.buildUtilityItem\('ค่าน้ำ', storedUtilityUsage\(b, 'water'\)/,
    'stored bill PDF rebuild must include water meter detail');
});

test('legacy /api/promptpay/qr endpoint is removed (no query-string QR)', () => {
  // The generic /api/promptpay/qr accepted target+amount from the query
  // string — useful only as an admin convenience, but a real attack
  // surface (anyone within rate-limit headroom could render a QR for
  // any account). It's been deleted; the tenant flow now uses
  // /api/tenant/bills/:id/qr which loads amount from the DB row.
  // Pin the removal so a future refactor doesn't re-add it accidentally.
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(server, /app\.get\(\s*['"]\/api\/promptpay\/qr['"]/,
    'generic /api/promptpay/qr must not be re-registered');
});

test('GET /api/tenant/bills/:id/qr uses DB bill total, not browser query amount', () => {
  // Tenant-side QR must be generated from the stored bill row. If the UI
  // passes target+amount through /api/promptpay/qr, a stale React state or
  // hand-edited query string can show a QR for the wrong amount even though
  // slip upload later rejects it. Pin the source of truth to bills.total.
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idx = server.indexOf("app.get('/api/tenant/bills/:id/qr'");
  assert.ok(idx > 0, 'tenant bill QR endpoint must exist');
  const tail = server.slice(idx);
  const nextIdx = tail.slice(50).search(/\napp\.(get|put|post|delete|use)\(/);
  const body = nextIdx > 0 ? tail.slice(0, 50 + nextIdx) : tail.slice(0, 5000);
  assert.match(body, /requireTenant/, 'tenant bill QR must require tenant auth');
  assert.match(body, /SELECT id, total, status, tenant_id[\s\S]*FROM bills/,
    'tenant bill QR must read total/status/tenant_id from bills');
  assert.match(body, /not your bill/,
    'tenant bill QR must enforce bill ownership');
  assert.match(body, /const amount = Number\(bill\.total\)/,
    'tenant bill QR amount must come from bills.total');
  assert.match(body, /renderQrWithFallback\(paymentBlock\.promptpayTarget, amount\)/,
    'tenant bill QR must render with DB amount');
  assert.doesNotMatch(body, /req\.query\.(?:amount|target)/,
    'tenant bill QR must not trust query amount or target');
});

test('/api/bills/render is owner-manager and rebuilds persisted bills server-side', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  // POST /api/bills/render moved into routes/bills-extras.js alongside the
  // other /api/bills/* endpoints. Helpers getRenderBillId +
  // buildStoredBillPdfObject travelled with it.
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'bills-extras.js'), 'utf8');
  const idx = route.indexOf("r.post('/render'");
  assert.ok(idx > 0, 'should find admin bill PDF render handler');
  const body = route.slice(idx, idx + 5000);
  assert.match(body, /requireRole\('owner', 'manager'\)/,
    'bill PDF render must not allow staff');
  assert.match(body, /getRenderBillId\(req, bill\)/,
    'bill PDF render must accept a persisted bill id');
  assert.match(body, /SELECT b\.\*, t\.full_name AS tenant_name, t\.phone AS tenant_phone/,
    'persisted bill PDF must load bill data from DB');
  assert.match(body, /buildStoredBillPdfObject\(rows\[0\], config, paymentBlock\)/,
    'persisted bill PDF must rebuild the PDF payload server-side');
  assert.match(body, /promptpayTarget: paymentBlock\.promptpayTarget/,
    'estimate PDF payment target must be overwritten from server config');
});

test('admin billing mark-paid uses the bill payment endpoint, not the rooms blob', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-billing.jsx'), 'utf8');
  const idx = src.indexOf('const handleMarkPaid = async');
  assert.ok(idx > 0, 'should find handleMarkPaid');
  const body = src.slice(idx, src.indexOf('const handleUnmarkPaid', idx));
  assert.match(body, /\/api\/bills\/\$\{bill\.dbBillId\}\/pay/,
    'mark-paid must call the server ledger endpoint');
  assert.match(body, /bill\._source !== 'db'/,
    'mark-paid must require an issued DB bill');
  assert.doesNotMatch(body, /setRooms\(/,
    'mark-paid must not fake payment status by mutating rooms');
});

test('admin billing mark-paid slip upload validates client-side and uses inline alerts', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-billing.jsx'), 'utf8');
  const idx = src.indexOf('<input type="file" accept="image/jpeg,image/png,image/webp"');
  assert.ok(idx > 0, 'should find mark-paid slip upload input');
  const block = src.slice(idx, src.indexOf('reader.readAsDataURL(f)', idx) + 120);
  assert.match(block, /allowed = \['image\/jpeg', 'image\/png', 'image\/webp'\]/,
    'admin mark-paid should reject unsupported slip MIME types before reading the file');
  assert.match(block, /slipError/,
    'file validation errors should be stored inline in the modal state');
  assert.match(block, /setToast && setToast\(\{ kind: 'warning'/,
    'oversized/unsupported file errors should use the app notification surface');
  assert.doesNotMatch(block, /alert\(/,
    'mark-paid slip upload must not use blocking window.alert');
  assert.match(src, /<div role="alert"[\s\S]{0,520}\{markPaidPrompt\.slipError\}/,
    'modal must render file validation errors with an accessible alert');
});

test('admin billing selected period drives estimates and bulk generation', () => {
  // The period selector is authoritative. When admin views a back-filled
  // month, both the preview rows and /api/bills/bulk-generate payload must
  // use that selected YYYY-MM, not the browser wall-clock month.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-billing.jsx'), 'utf8');

  const billsIdx = src.indexOf('const bills = useMemo');
  assert.ok(billsIdx > 0, 'should find bills useMemo');
  const billsBlock = src.slice(billsIdx, src.indexOf('const filtered = useMemo', billsIdx));
  assert.match(billsBlock, /const periodDisplay = fmtMonthTH\(currentPeriodDate\)/,
    'estimate display month must follow selected period');
  assert.match(billsBlock, /const dueIso = `\$\{currentPeriod\}-\$\{String\(dueDay\)\.padStart\(2, '0'\)\}`/,
    'estimate due date must be inside selected period');
  assert.match(billsBlock, /const periodIso = currentPeriod;/,
    'estimate bill id/API period must use selected period');
  // activeRecurring was added so the client preview mirrors the same
  // recurring_charges merge the server does — admin sees the same line
  // items pre- and post-issue. The deps must include it so the memo
  // re-runs when a row is added/removed mid-session.
  assert.match(billsBlock, /\[rooms, config, realBillsByRoom, currentPeriod, currentPeriodDate, activeRecurring(,\s*\w+)*\]/,
    'estimate must recompute after period changes + when recurring charges refresh');

  const genIdx = src.indexOf('const handleGenerate = async');
  assert.ok(genIdx > 0, 'should find handleGenerate');
  const generateBlock = src.slice(genIdx, src.indexOf('// Bulk-send all pending', genIdx));
  assert.match(generateBlock, /const period = currentPeriod;/,
    'bulk-generate payload must use the selected period');
  assert.doesNotMatch(generateBlock, /const now = new Date\(\)[\s\S]{0,120}const period =/,
    'bulk generation must not silently switch back to wall-clock month');
});

test('admin billing UI uses text labels instead of ambiguous icon-only controls', () => {
  // Operators complained the billing icons were unclear. Keep the billing
  // page text-first: no IconBtn rows, no icon prop on primary controls/KPIs,
  // and no emoji-only status text for the main billing workflow.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-billing.jsx'), 'utf8');

  assert.doesNotMatch(src, /\bIconBtn\b/,
    'billing page should not use icon-only buttons');
  assert.doesNotMatch(src, /<Btn[\s\S]{0,160}\sicon=/,
    'billing page buttons should use text labels, not icon props');
  assert.doesNotMatch(src, /<KpiCard[\s\S]{0,180}\sicon=/,
    'billing KPI cards should not depend on icons');
  assert.doesNotMatch(src, /<Pill[\s\S]{0,120}\sicon=/,
    'billing status pills should use readable words');
  assert.doesNotMatch(src, /[🔴🟡⚪ℹ🚫⚠✅⏱📤📌💡💵🏦📱📧📥📨📋🔔👁🤖👤🏠✨💰🎉🧾⏳]/u,
    'billing page should not show ambiguous emoji icons in labels/statuses');
});

test('tenant bill modal uses bill-owned QR endpoint', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tenant = fs.readFileSync(path.join(__dirname, '..', 'project', 'tenant.jsx'), 'utf8');
  assert.match(tenant, /\/api\/tenant\/bills\/\$\{encodeURIComponent\(bill\.id\)\}\/qr/,
    'tenant UI must request server-owned bill QR');
  assert.doesNotMatch(tenant, /\/api\/promptpay\/qr\?target=\$\{encodeURIComponent\(pay\.promptpayTarget\)\}&amount=\$\{encodeURIComponent\(bill\.total\)\}/,
    'tenant UI must not build payment QR from browser-side target+amount');
});

test('tenant payment readiness controls QR and slip upload state', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const routeIdx = server.indexOf("app.get('/api/tenant/pay-readiness/:billId'");
  assert.ok(routeIdx > 0, 'tenant pay-readiness endpoint must exist');
  const route = server.slice(routeIdx, server.indexOf('// GET /api/admin/billing-readiness', routeIdx));
  assert.match(route, /requireTenant/, 'pay-readiness must require tenant auth');
  assert.match(route, /Number\(bill\.tenant_id\) !== Number\(req\.tenant\.tenant_id\)/,
    'pay-readiness must enforce bill ownership');
  assert.match(route, /promptpayReadyForPayment = true/,
    'readiness must only mark PromptPay ready after validation');
  assert.match(route, /flags\.slipUpload\.autoVerify && ready\.length > 0 && promptpayReadyForPayment/,
    'autoVerify channel must require a validated real PromptPay target');
  assert.match(route, /loadBillPaymentAttemptSummary/,
    'readiness must load persisted slip upload attempts');
  assert.match(route, /slipBlockReadinessIssue/,
    'readiness must surface pending/limit slip blocks before the upload button is enabled');
  assert.match(route, /upload: uploadAttempts/,
    'readiness must return upload attempt state to the tenant UI');
  assert.doesNotMatch(route, /ready\.length > 0 && paymentBlock\.promptpayTarget/,
    'autoVerify must not rely on raw promptpay presence');

  const tenant = fs.readFileSync(path.join(__dirname, '..', 'project', 'tenant.jsx'), 'utf8');
  assert.match(tenant, /readiness\?\.channels\?\.qr === true/,
    'tenant UI must wait for server readiness before showing QR');
  assert.match(tenant, /readiness\?\.channels\?\.slip === false/,
    'tenant UI must block slip upload when readiness says the bill is not payable');
  assert.doesNotMatch(tenant, /readiness \? readiness\.channels\.qr : \(pay && pay\.promptpayTarget\)/,
    'tenant UI must not fall back to browser payment-info for QR visibility');
  assert.match(tenant, /const \[paymentInfoError, setPaymentInfoError\] = useState\(null\)/,
    'tenant UI must keep payment-info failures visible');
  assert.match(tenant, /setPaymentInfoError\(err\.message \|\|/,
    'tenant UI must report payment-info load failures instead of dropping them');
  assert.match(tenant, /\(pay \|\| qrUrl \|\| qrFallback \|\| paymentInfoError\)/,
    'payment card must not disappear when payment-info fails but bill QR readiness still works');
  assert.match(tenant, /const readinessLoading = !readiness && !readinessError/,
    'tenant UI must model the readiness-loading state explicitly');
  assert.match(tenant, /const slipUploadBlocked = readinessLoading[\s\S]{0,180}amountMismatch/,
    'tenant upload button must stay disabled until readiness returns');
  assert.match(tenant, /if \(readinessLoading\) \{[\s\S]{0,240}kind: 'pending'/,
    'clicking upload while readiness is loading must explain the wait');
});

test('tenant bill modal blocks bad payment steps before slip upload', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tenant = fs.readFileSync(path.join(__dirname, '..', 'project', 'tenant.jsx'), 'utf8');

  assert.match(tenant, /const PAYMENT_TOLERANCE_THB = 1/,
    'tenant UI must share the same 1 THB mismatch tolerance as the server guard');
  assert.match(tenant, /setReadinessError/,
    'tenant UI must keep readiness API failures visible instead of dropping them');
  assert.match(tenant, /const d = await r\.json\(\)\.catch\(\(\) => \(\{\}\)\)/,
    'tenant UI must parse readiness error payloads such as BILL_NOT_LINKED');
  assert.match(tenant, /readinessHardError/,
    'tenant UI must classify hard readiness failures before upload');
  assert.match(tenant, /Math\.abs\(paymentAmount - billTotal\) > PAYMENT_TOLERANCE_THB/,
    'tenant UI must block amount mismatches before reading/uploading the slip image');
  assert.match(tenant, /const slipUploadBlocked =[\s\S]{0,220}amountMismatch/,
    'tenant UI must disable the upload action when the amount cannot pass the server');
  assert.match(tenant, /disabled=\{busy \|\| slipUploadBlocked\}/,
    'tenant upload button must use the combined step gate');
});

test('tenant portal sync is partial-failure safe and user-visible', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tenant = fs.readFileSync(path.join(__dirname, '..', 'project', 'tenant.jsx'), 'utf8');

  assert.match(tenant, /const \[syncErrors, setSyncErrors\]/,
    'tenant portal must track sync errors instead of silently hiding backend failures');
  assert.match(tenant, /Promise\.allSettled\(\[/,
    'tenant refresh must let one endpoint fail without failing the whole portal sync');
  assert.match(tenant, /api\('\/api\/tenant\/payments'\)/,
    'tenant refresh must include payment history so slip uploads and payment tab stay in sync');
  assert.match(tenant, /setPayments\(Array\.isArray\(d\.payments\) \? d\.payments : \[\]\)/,
    'tenant refresh must update payment history from the live backend response');
  assert.match(tenant, /setSyncErrors\(errors\)/,
    'tenant refresh must surface failed backend sections to the UI');
  assert.match(tenant, /function SyncBanner\(/,
    'tenant portal must render a sync warning banner');
  assert.match(tenant, /ระบบเก็บข้อมูลล่าสุดที่โหลดสำเร็จไว้|Previously loaded data is kept/,
    'sync warning must explain that stale visible data is preserved');
  assert.match(tenant, /refreshSeq\.current\+\+/,
    'tenant refresh must invalidate stale async responses on logout/session expiry');
  assert.doesNotMatch(tenant, /api\('\/api\/tenant\/bills'\)\.catch\(\(\) => \(\{ bills: \[\] \}\)\)/,
    'tenant refresh must not turn a failed bills API call into an empty bill list');
});

test('tenant portal mobile layout and client-side guards cover common failures', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tenant = fs.readFileSync(path.join(__dirname, '..', 'project', 'tenant.jsx'), 'utf8');

  for (const cls of [
    '.tenant-main',
    '.sync-banner',
    '.bill-row',
    '.bill-card-main',
    '.mini-cells',
    '.maintenance-ticket-row',
    '.modal-panel',
    '.modal-body',
  ]) {
    assert.match(tenant, new RegExp(cls.replace('.', '\\.')),
      `tenant portal CSS must include responsive rule for ${cls}`);
  }
  assert.match(tenant, /100dvh/,
    'tenant modal must use dynamic viewport height on mobile browsers');
  assert.match(tenant, /safeStorageGet\('tenant_locale'\)/,
    'tenant portal must not crash when localStorage is blocked');
  assert.match(tenant, /safeStorageSet\('tenant_theme', v\)/,
    'tenant portal must write preferences through a guarded storage helper');
  assert.match(tenant, /Only JPG, PNG or WebP images are supported/,
    'tenant slip upload must reject unsupported file types before reading/uploading');
  assert.match(tenant, /maxLength=\{2000\}/,
    'tenant maintenance description must match the backend schema limit');
});

test('tenant API does not send tenants back to login on CSRF retryable 403', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tenant = fs.readFileSync(path.join(__dirname, '..', 'project', 'tenant.jsx'), 'utf8');

  assert.match(tenant, /!path\.includes\('\/api\/tenant\/login'\)/,
    'tenant login must not pre-cache an anonymous CSRF token before tenant_sid is set');
  assert.match(tenant, /data\.code === 'CSRF_INVALID'/,
    'tenant API must recognize CSRF_INVALID responses');
  assert.match(tenant, /getCsrf\(true\)/,
    'tenant API must retry state-changing requests once with a fresh CSRF token');
  assert.match(tenant, /if \(r\.status === 401/,
    'tenant UI should only force login on real unauthorized responses');
  assert.doesNotMatch(tenant, /r\.status === 401\s*\|\|\s*r\.status === 403/,
    'tenant UI must not treat every 403 as session expiry');
});

test('csrf token endpoint overwrites stale anonymous token after tenant login', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = server.match(/app\.get\('\/api\/csrf-token'[\s\S]{0,650}?res\.json\(\{ csrfToken: token \}\);\s*\}\);/);
  assert.ok(route, 'csrf-token route must exist');
  assert.match(route[0], /generateCsrfToken\(req,\s*res,\s*true\)/,
    'csrf-token route must force overwrite stale cookies when session identity changes');
});

test('tenant payment readiness reports orphan bills with BILL_NOT_LINKED', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idx = server.indexOf("app.get('/api/tenant/pay-readiness/:billId'");
  assert.ok(idx > 0, 'tenant pay-readiness endpoint must exist');
  const body = server.slice(idx, server.indexOf('// GET /api/admin/billing-readiness', idx));
  assert.match(body, /if \(!bill\.tenant_id\)[\s\S]{0,250}code: 'BILL_NOT_LINKED'/,
    'pay-readiness must mirror tenant payment upload and report orphan bills explicitly');
  assert.ok(body.indexOf('BILL_NOT_LINKED') < body.indexOf('not your bill'),
    'orphan bills must be handled before ownership mismatch');
});

test('admin billing readiness backs bill issue and payment preflights', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idx = server.indexOf("app.get('/api/admin/billing-readiness'");
  assert.ok(idx > 0, 'admin billing-readiness endpoint must exist');
  const route = server.slice(idx, server.indexOf('// GET /api/tenant/bills/:id/qr', idx));
  assert.match(route, /requireAuth, requireRole\('owner', 'manager'\)/,
    'billing-readiness must be admin-gated');
  assert.match(route, /loadEffectivePaymentBlock\(\)/,
    'billing-readiness must use the effective payment config');
  assert.match(route, /meter\.normalisePeriod\(req\.query\.period\)/,
    'billing-readiness must validate and honor the selected billing period');
  assert.match(route, /meter\.buildPeriodSummary\(pool, rooms, readinessPeriod\)/,
    'billing-readiness must check meter readings for the same period being issued');
  for (const code of [
    'NO_PROMPTPAY',
    'NO_WATER_RATE',
    'NO_ELEC_RATE',
    'AUTOVERIFY_NO_PROVIDER',
    'NO_LINE_OA',
    'BIG_VERIFY_QUEUE',
  ]) {
    assert.match(route, new RegExp(code), `billing-readiness must report ${code}`);
  }

  const billingPage = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-billing.jsx'), 'utf8');
  assert.match(billingPage, /\/api\/admin\/billing-readiness\?period=\$\{encodeURIComponent\(currentPeriod\)\}/,
    'admin billing page must call readiness for the selected period');
  assert.match(billingPage, /formatReadinessIssues\(readiness, 'payment'\)/,
    'mark-paid flow must surface payment readiness issues');
  assert.match(billingPage, /i\.area\.includes\('issue'\)/,
    'bill issue flow must filter readiness issues by issue area');
  assert.match(billingPage, /force: issues\.length > 0/,
    'bill generation must explicitly force only after the admin accepts warnings');
});

test('admin slip-verify setup clears stale test results after config changes', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-slip-verify.jsx'), 'utf8');

  const saveFeatureIdx = src.indexOf('async function saveFeature');
  const saveSecretIdx = src.indexOf('async function saveSecret');
  assert.ok(saveFeatureIdx > 0 && saveSecretIdx > saveFeatureIdx,
    'slip verify page must have saveFeature and saveSecret handlers');
  const saveFeature = src.slice(saveFeatureIdx, saveSecretIdx);
  const saveSecret = src.slice(saveSecretIdx, src.indexOf('async function runTest', saveSecretIdx));

  for (const key of ['provider', 'providers', 'autoVerify', 'enabled']) {
    assert.match(saveFeature, new RegExp(`'${key}' in partial\\.slipUpload`),
      `changing slipUpload.${key} must invalidate the previous provider test`);
  }
  assert.match(saveFeature, /setTestResult\(null\)/,
    'feature changes must clear the cached provider test result');
  assert.match(saveSecret, /setTestResult\(null\)/,
    'API key changes must clear the cached provider test result');
});

test('payment verification uses canonical bill-before-payment lock order', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idx = server.indexOf("app.put('/api/payments/:id/verify'");
  assert.ok(idx > 0, 'payment verify endpoint must exist');
  const body = server.slice(idx, server.indexOf('// Helper for both verify endpoints', idx));
  assert.match(body, /SELECT bill_id FROM payments WHERE id=\$1 AND status='pending'/,
    'verify flow must peek payment bill_id before taking locks');
  assert.match(body, /SELECT id, status, total, deleted_at FROM bills WHERE id=\$1 FOR UPDATE/,
    'verify flow must lock the bill before locking the payment row');
  assert.match(body, /SELECT \* FROM payments WHERE id=\$1 AND status='pending' FOR UPDATE/,
    'verify flow must re-lock/re-check the payment after locking bill');
  assert.ok(
    body.indexOf('SELECT id, status, total, deleted_at FROM bills WHERE id=$1 FOR UPDATE')
      < body.indexOf("SELECT * FROM payments WHERE id=$1 AND status='pending' FOR UPDATE"),
    'bill lock must appear before payment row lock to avoid deadlocks with bill verify-slip');
  assert.match(body, /code: 'PAYMENT_BILL_CHANGED'/,
    'verify flow must fail closed if the payment bill link changes mid-flight');
});

test('bill payment helpers keep non-null verifier audit values', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'bills-extras.js'), 'utf8');
  assert.match(src, /const verifier = req\.session\?\.user\?\.username \|\| 'admin:unknown'/,
    'bill helpers must fall back to a non-null verifier sentinel');
  assert.match(src, /verified_by, verified_at[\s\S]{0,600}ref,\s*slipUrl,\s*verifier,\s*JSON\.stringify/,
    'manual pay insert must include optional slipUrl column + verifier variable');
  assert.match(src, /UPDATE payments SET status='verified', verified_by=\$1[\s\S]{0,160}\[verifier, pid\]/,
    'verify-slip accept path must use the verifier variable');
  assert.match(src, /UPDATE payments SET status='rejected', verified_by=\$1[\s\S]{0,180}\[verifier, reason, pid\]/,
    'verify-slip reject path must use the verifier variable');
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
  assert.match(server, /app\.get\('\/api\/access\/cards', requireAuth, features\.requireFeature\('accessControl'\)/,
    'list must be gated by accessControl');
  assert.match(server, /app\.put\('\/api\/access\/cards\/:id\/revoke'[\s\S]{0,180}features\.requireFeature\('accessControl'\)/,
    'revoke must be gated by accessControl');
  assert.match(server, /app\.put\('\/api\/access\/cards\/:id\/restore'[\s\S]{0,180}features\.requireFeature\('accessControl'\)/,
    'restore must be gated by accessControl');
});

test('feature-gated modules fail closed with structured errors', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const featureSvc = fs.readFileSync(path.join(__dirname, '..', 'services', 'features.js'), 'utf8');

  assert.match(featureSvc, /code: 'FEATURE_DISABLED'/,
    'disabled features must return a stable machine-readable code');
  assert.match(featureSvc, /feature: name/,
    'disabled feature payload must identify which feature blocked the request');
  assert.match(featureSvc, /requestId/,
    'disabled feature payload should carry requestId for support/audit');
  assert.match(server, /tenantPortalDisabled[\s\S]{0,220}disabledPayload\('tenantPortal'/,
    'tenant portal session routes must return FEATURE_DISABLED when the flag is off');
  assert.match(server, /app\.get\('\/api\/meters\/:roomId\/readings', requireAuth, features\.requireFeature\('meterIot'\)/,
    'meter read API must be gated, not only meter write API');
  assert.match(server, /app\.get\('\/api\/access\/logs', requireAuth, features\.requireFeature\('accessControl'\)/,
    'access log read API must be gated with the accessControl flag');
});

test('monthly meter readings drive billing period instead of room edit units', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const meterSvc = fs.readFileSync(path.join(__dirname, '..', 'services', 'meter.js'), 'utf8');
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'bills-extras.js'), 'utf8');
  const scheduler = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
  const roomsPage = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-rooms.jsx'), 'utf8');
  const metersPage = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-meters.jsx'), 'utf8');
  const billingPage = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-billing.jsx'), 'utf8');
  const migration = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrate.js'), 'utf8');

  assert.match(migration, /ALTER TABLE meter_readings ADD COLUMN IF NOT EXISTS period TEXT/,
    'meter readings need an explicit billing period column');
  assert.match(meterSvc, /function normalisePeriod\(period\)/,
    'meter service must validate YYYY-MM periods');
  assert.match(meterSvc, /ON CONFLICT \(room_id, meter_type, period\)/,
    'saving a monthly reading must update that room/type/month instead of creating duplicates');
  assert.match(meterSvc, /async function attachBillingReadingsForPeriod/,
    'billing must be able to read the meter pair for a selected period');
  assert.match(server, /period-summary/,
    'admin UI needs a month-scoped meter summary endpoint');
  assert.match(server, /const \{ meterType, reading, period \} = req\.body/,
    'meter write endpoint must accept period from the monthly entry page');
  assert.match(routes, /attachBillingReadingsForPeriod\(pool, room, b\.period\)/,
    'single bill generation must use the requested bill period');
  assert.match(routes, /attachBillingReadingsForPeriod\(billClient, room, period\)/,
    'bulk bill generation must use the selected period');
  assert.match(scheduler, /attachBillingReadingsForPeriod\(billClient, room, period\)/,
    'scheduler auto-billing must use the period it is generating');
  assert.match(metersPage, /type="month"/,
    'meter page must let admin choose the billing month');
  assert.match(metersPage, /JSON\.stringify\(\{ meterType: type, reading: newVal, source: 'manual', period \}\)/,
    'meter page must submit the selected period');
  assert.match(billingPage, /\/api\/meters\/period-summary\?period=/,
    'billing preview must read meter values for the selected month');
  assert.match(roomsPage, /label="ค่าไฟ \(หน่วยล่าสุด\)"[\s\S]{0,180}disabled/,
    'room edit must not be the monthly electricity input surface');
  assert.match(roomsPage, /window\.location\.hash = 'meters'/,
    'room edit should route admins to the correct meter page');
});

test('financial reports do not price utilities from room meter snapshots', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const reportsRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports.js'), 'utf8');
  const overviewPage = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-overview.jsx'), 'utf8');
  const reportsPage = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-reports.jsx'), 'utf8');
  const shared = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'shared.jsx'), 'utf8');
  const publicApp = fs.readFileSync(path.join(__dirname, '..', 'project', 'app.jsx'), 'utf8');
  const webhooks = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhooks.js'), 'utf8');

  const xlsxIdx = reportsRoute.indexOf("r.get('/bills.xlsx'");
  assert.ok(xlsxIdx > 0, 'bills workbook route must exist');
  const xlsxRoute = reportsRoute.slice(xlsxIdx, reportsRoute.indexOf('  // GET /api/reports/maintenance', xlsxIdx));
  assert.match(xlsxRoute, /FROM bills b/,
    'bill workbook must export issued bills');
  assert.match(xlsxRoute, /b\.period = \$1/,
    'bill workbook must be scoped to the selected billing period');
  assert.doesNotMatch(xlsxRoute, /baankarn_rooms_v1|rm\.waterUnits|rm\.elecUnits|waterRate\s*=|elecRate\s*=/,
    'bill workbook must not rebuild utility charges from room snapshots');

  assert.match(overviewPage, /\/api\/bills\?period=\$\{encodeURIComponent\(currentPeriod\)\}&limit=500/,
    'overview top rooms must load issued bills for the current period');
  const overviewTopIdx = overviewPage.indexOf('const topRooms = useMemo');
  const overviewTop = overviewPage.slice(overviewTopIdx, overviewPage.indexOf('const topMax', overviewTopIdx));
  assert.doesNotMatch(overviewTop, /waterUnits|elecUnits|config\.utilities/,
    'overview top rooms must not rank from room meter snapshots');

  assert.match(reportsPage, /\/api\/reports\/bills\.xlsx\?period=\$\{encodeURIComponent\(currentPeriod\)\}/,
    'reports export button must request the selected/current period explicitly');
  const reportRevenueIdx = reportsPage.indexOf('const revenueByType = useMemo');
  const reportRevenue = reportsPage.slice(reportRevenueIdx, reportsPage.indexOf('// Floor performance', reportRevenueIdx));
  assert.doesNotMatch(reportRevenue, /waterUnits|elecUnits|\(r\.water\|\|0\)|\(r\.elec\|\|0\)/,
    'report charts must aggregate from issued bills instead of legacy room utility amounts');

  const statsIdx = shared.indexOf('function computeStats');
  const statsSlice = shared.slice(statsIdx, shared.indexOf('// --- File export/import helpers', statsIdx));
  assert.doesNotMatch(statsSlice, /waterUnits|elecUnits/,
    'fallback room stats must not calculate money from latest meter units');

  const publicDetailIdx = publicApp.indexOf('function DetailPanel');
  const publicDetail = publicApp.slice(publicDetailIdx, publicApp.indexOf('{tab ===', publicDetailIdx));
  assert.doesNotMatch(publicDetail, /room\.waterUnits|room\.elecUnits|Number\(room\.water\)|Number\(room\.elec\)/,
    'public room detail must not present stale room units as monthly utility charges');

  const roomStatusIdx = webhooks.indexOf('async function replyRoomStatus');
  const roomStatus = webhooks.slice(roomStatusIdx, webhooks.indexOf('  return r;', roomStatusIdx));
  assert.doesNotMatch(roomStatus, /r\.elecUnits|r\.waterUnits/,
    'LINE room status must not send stale room utility units');
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

test('admin feature settings block unsupported meter MQTT mode', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idx = server.indexOf("app.put('/api/admin/features'");
  assert.ok(idx > 0, 'admin features save endpoint must exist');
  const body = server.slice(idx, server.indexOf('// === v2: Tenants', idx));
  assert.match(body, /partial\.meterIot && partial\.meterIot\.mode === 'mqtt'/,
    'server must reject mqtt mode until an MQTT subscriber exists');
  assert.match(body, /code: 'METER_MQTT_UNAVAILABLE'/,
    'server must return a stable mqtt-unavailable code');
  assert.match(body, /PRODUCTION_SIMULATOR_BLOCKED/,
    'production simulator guard must remain in place');

  const page = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-features.jsx'), 'utf8');
  assert.match(page, /\['mqtt', 'MQTT \(ยังไม่รองรับ\)', true\]/,
    'features UI must show mqtt as unsupported/disabled');
  assert.match(page, /disabled=\{!!disabled\}/,
    'SelectField must honor disabled options');
});

test('admin feature settings are owner-editable only and explain every switch', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-features.jsx'), 'utf8');
  const shell = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'shell.jsx'), 'utf8');
  const settings = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-settings.jsx'), 'utf8');

  const getIdx = server.indexOf("app.get('/api/admin/features'");
  const getBlock = server.slice(getIdx, server.indexOf("app.put('/api/admin/features'", getIdx));
  assert.match(getBlock, /canEdit:\s*role === 'owner'/,
    'GET /api/admin/features must tell the UI whether the current role can edit');
  assert.match(getBlock, /role,/,
    'GET /api/admin/features must return the role for read-only messaging');

  assert.match(shell, /currentUser,/,
    'shell must pass currentUser into page props so embedded feature settings know the role');
  assert.match(settings, /PageFeatures[\s\S]{0,120}currentUser=\{currentUser\}/,
    'Settings > Features must forward currentUser to the embedded feature page');
  assert.match(page, /currentUser = null/,
    'PageFeatures must accept the current user');
  assert.match(page, /readOnlyReason/,
    'PageFeatures must render a clear read-only reason for manager/staff');
  assert.match(page, /disabled=\{busy \|\| !canEdit\}/,
    'feature switches must be disabled before a non-owner can click into a 403');
  assert.match(page, /role="switch"[\s\S]{0,80}aria-checked/,
    'feature switches must expose switch semantics and state');
  assert.match(page, /FEATURE_HELP/,
    'feature switches must have inline explanations instead of unlabeled toggles');
  assert.match(page, /SectionHeading title="ฝั่งผู้เช่า"/,
    'section headings must use the actual SectionHeading API');
  assert.match(page, /Row id="autoReconcileRooms"/,
    'autoReconcileRooms must not be a hidden feature flag');
  assert.match(page, /field="requireIdentityImages"/,
    'tenancy contract identity guard must be visible and configurable');
  assert.match(page, /field="moveInPastDays"/,
    'tenancy contract date-window guard must be visible and configurable');
});

test('room special-property toggles explain pricing impact', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const rooms = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-rooms.jsx'), 'utf8');
  const pricing = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-pricing.jsx'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'ui.jsx'), 'utf8');

  assert.match(rooms, /const featureToggleRows = \[/,
    'room drawer must define special-property toggles in one auditable list');
  assert.match(rooms, /deltaOnToggle: nextRent - computedRent/,
    'each room special-property toggle must calculate the immediate rent impact');
  assert.match(rooms, /Premium ที่ตั้งไว้/,
    'room drawer must tell admin which Pricing premium backs the toggle');
  assert.match(rooms, /สัญญาที่ lock แล้ว\/บิลที่ออกแล้วจะไม่ถูกแก้ย้อนหลัง/,
    'room drawer must warn that locked contracts and issued bills are not retroactively changed');
  assert.match(pricing, /const featurePremiumItems = \[/,
    'pricing page must use the same special-property list for preview toggles');
  assert.match(pricing, /\+\{fmtCurrency\(premium\)\}/,
    'pricing preview toggles must show how much each special property adds');
  assert.match(ui, /role="switch"[\s\S]{0,120}aria-checked=\{!!checked\}/,
    'shared Toggle must expose switch semantics for every button-like toggle');
});

test('healthCheck surfaces data integrity and failed notification backlog', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const hc = fs.readFileSync(path.join(__dirname, '..', 'services', 'healthCheck.js'), 'utf8');
  assert.match(hc, /failed_total/,
    'notification queue check must count old failed backlog, not only recent failures');
  assert.match(hc, /recent_failed_breakdown/,
    'notification queue check must include a grouped recent-failure breakdown');
  assert.match(hc, /not configured\|not implemented\|host\\\/user\\\/pass/,
    'notification queue health must warn on provider configuration failures even when the count is small');
  assert.match(hc, /Settings > API\/Keys/,
    'notification queue health must tell admins exactly where to fix missing provider credentials');
  assert.match(hc, /id: 'data_integrity'/,
    'health checks must include core data integrity probe');
  assert.match(hc, /orphan_payable_bills/,
    'data integrity probe must flag payable bills with tenant_id=NULL');
  assert.match(hc, /active_tenant_room_status_mismatch/,
    'data integrity probe must flag active tenants whose room is still reserved/vacant');
  assert.match(hc, /busy_rooms_without_active_tenant/,
    'data integrity probe must flag occupied/overdue rooms without an active tenant');
  assert.match(hc, /reserved_rooms_without_hold/,
    'data integrity probe must flag stale reservations without booking or draft contract hold');
  assert.match(hc, /rooms_reserved_by_ghost_contract/,
    'data integrity probe must flag reservations pointing at inactive/missing contracts');
  assert.match(hc, /SELECT rec\.key AS room_code/,
    'JSONB room scan must qualify rec.key so app_data.key is not ambiguous in PostgreSQL');
  assert.match(hc, /legacy rooms exist but rooms_v2 is empty/,
    'data integrity probe must flag unsynced legacy room inventory');
  assert.match(hc, /active_contract_identity_incomplete/,
    'data integrity probe must flag active contracts missing legal identity fields');
  assert.match(hc, /locked_contract_missing_terms_snapshot/,
    'data integrity probe must flag locked contracts missing immutable terms snapshot');
  assert.match(hc, /expired_pending_contract_invitations/,
    'data integrity probe must flag expired pending contract invitations');
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

test('tenantPortal.requirePin flag stays removed for phone-only login', () => {
  // Tenant portal login is phone-only now. Keep requirePin out of DEFAULTS
  // and the public /api/features `safe` allowlist so the Features page
  // cannot surface a stale toggle.
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
  assert.match(tenant, /id:\s*"payments"/, 'payments tab must be in nav');
  assert.match(tenant, /\/api\/tenant\/bills\/\$\{bill\.id\}\/pdf/,
    'bill detail must link to PDF endpoint');
});

test('public room dashboard is read-only, not an admin management surface', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const app = fs.readFileSync(path.join(__dirname, '..', 'project', 'app.jsx'), 'utf8');
  const shell = fs.readFileSync(path.join(__dirname, '..', 'project', 'Dorm Status Dashboard.html'), 'utf8');
  assert.doesNotMatch(app, /\['actions'/, 'public dashboard must not expose a management tab');
  assert.doesNotMatch(app, /function setStatus/, 'public dashboard must not mutate room status');
  assert.doesNotMatch(app, /type="file"/, 'public dashboard must not upload room photos');
  assert.doesNotMatch(app, /onUpdate=\{updateRoom\}/, 'public detail panel must not receive mutation callbacks');
  assert.doesNotMatch(app, /localStorage\.setItem\('baankarn_rooms_v1'/,
    'public dashboard must not persist room data from the viewer browser');
  assert.doesNotMatch(app + shell, /TweaksPanel|tweaks-panel/,
    'public dashboard must not ship the dev tweaks panel');
});

test('admin overview uses real contracts for upcoming expiry alerts', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const overview = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-overview.jsx'), 'utf8');
  assert.match(overview, /\/api\/contracts\?status=active&expiringInDays=60/,
    'overview must query the contracts table for expiring contracts');
  assert.doesNotMatch(overview, /r\.tenant && r\.contractEnd/,
    'overview must not derive contract expiry alerts from the legacy rooms blob');
  assert.match(overview, /location\.hash = 'contracts'/,
    'expiry alert should take admin to the contracts page');
});

test('admin write pages use central CSRF-aware API helpers', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const adminDir = path.join(__dirname, '..', 'project', 'admin');
  const hooks = fs.readFileSync(path.join(adminDir, 'hooks.jsx'), 'utf8');
  assert.match(hooks, /window\.requireApiFetch = requireApiFetch/,
    'admin hooks must expose a required CSRF-aware fetch helper');
  assert.match(hooks, /window\.requireApiCall = requireApiCall/,
    'admin hooks must expose a required JSON API helper');

  for (const file of fs.readdirSync(adminDir).filter((f) => /^page-.*\.jsx$/.test(f))) {
    const src = fs.readFileSync(path.join(adminDir, file), 'utf8');
    assert.doesNotMatch(src, /window\.apiFetch\s*\|\|/,
      `${file} must not fall back to raw fetch when CSRF helper is unavailable`);
    assert.doesNotMatch(src, /const\s+apiFetch\s*=\s*window\.apiFetch\b/,
      `${file} must call requireApiFetch() before using apiFetch`);
    assert.doesNotMatch(src, /const\s+apiCall\s*=\s*window\.apiCall\b/,
      `${file} must call requireApiCall() before using apiCall`);
    assert.doesNotMatch(src, /await\s+window\.api(?:Call|Fetch)\(/,
      `${file} must not call window.apiCall/apiFetch directly`);
  }

  const bookings = fs.readFileSync(path.join(adminDir, 'page-bookings.jsx'), 'utf8');
  assert.match(bookings, /window\.requireApiCall \? window\.requireApiCall\(\) : window\.apiCall/,
    'booking status changes must use apiCall');
  assert.equal(bookings.includes('falling back to legacy approve'), false,
    'booking approval must not fall back to client-only legacy approve');
  assert.equal(bookings.includes('fetch(`/api/bookings/${encodeURIComponent(id)}`'), false,
    'booking status changes must not bypass apiCall');
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

test('admin booking-to-contract handoff preserves booking reservation context', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const bookings = fs.readFileSync(
    path.join(__dirname, '..', 'project', 'admin', 'page-bookings.jsx'), 'utf8'
  );
  const tenants = fs.readFileSync(
    path.join(__dirname, '..', 'project', 'admin', 'page-tenants.jsx'), 'utf8'
  );
  const rooms = fs.readFileSync(
    path.join(__dirname, '..', 'project', 'admin', 'page-rooms.jsx'), 'utf8'
  );
  const shell = fs.readFileSync(
    path.join(__dirname, '..', 'project', 'admin', 'shell.jsx'), 'utf8'
  );

  assert.match(bookings, /#tenants\?room=\$\{encodeURIComponent\(assignedRoomId\)\}&tab=contract&booking=/,
    'approve toast must deep-link to the tenant contract tab for the assigned room');
  assert.match(bookings, /active\.status === 'approved'[\s\S]{0,500}สร้างสัญญา/,
    'approved booking drawer must keep a visible create-contract next step');
  assert.match(bookings, /#tenants\?room=\$\{encodeURIComponent\(roomId\)\}&tab=contract&booking=\$\{encodeURIComponent\(active\.id\)\}/,
    'approved booking create-contract button must preserve booking context');
  assert.match(shell, /raw\.split\('\?'\)\[0\]\.split\('\/'\)\[0\]/,
    'hash router must preserve query params such as room/tab/booking');
  assert.match(tenants, /const bookingId = reservedBy && !reservedBy\.startsWith\('contract:'\) \? reservedBy : null/,
    'tenant contract flow must infer bookingId from room.reservedBy');
  assert.match(tenants, /if \(bookingId\) payload\.bookingId = bookingId/,
    'quick-invite payload must pass bookingId so reserved booking rooms can become contracts');
  assert.match(rooms, /#tenants\?add=1&room=\$\{encodeURIComponent\(room\.id\)\}/,
    'rooms page tenant add must route through the tenants workflow');
  assert.doesNotMatch(rooms, /setConfirmRemove\(true\)/,
    'rooms page must not expose local blob-only move-out as the normal action');
  assert.match(tenants, /<input type="number" min="1" max="60" value=\{form\.termMonths\}/,
    'check-in UI must match the server termMonths cap');
});

test('recurring charges page fails soft instead of hanging on tenant-list load', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'project', 'admin', 'page-recurring-charges.jsx'), 'utf8'
  );

  assert.match(src, /Promise\.allSettled/,
    'charges list must not be blocked by tenant-list failure');
  assert.match(src, /apiCall\('\/api\/recurring-charges'[\s\S]{0,180}timeoutMs:\s*API_TIMEOUT_MS/,
    'charges load must use the structured API helper with a bounded timeout');
  assert.match(src, /apiCall\('\/api\/tenants\?status=active'[\s\S]{0,180}timeoutMs:\s*API_TIMEOUT_MS/,
    'tenant lookup must be bounded and scoped to active tenants');
  assert.match(src, /apiCall\('\/api\/rooms'[\s\S]{0,180}timeoutMs:\s*API_TIMEOUT_MS/,
    'room lookup must be loaded so admins do not have to type room IDs blindly');
  assert.match(src, /tenantLoadWarning/,
    'tenant-list failure must be surfaced without hiding existing charges');
  assert.match(src, /roomLoadWarning/,
    'room-list failure must be surfaced without hiding existing charges');
  assert.match(src, /role="status"[\s\S]{0,520}กำลังโหลดค่าใช้จ่ายประจำ/,
    'initial load must show an explicit loading state');
  assert.match(src, /window\.PageRecurringCharges = PageRecurringCharges/,
    'management page must remain usable even when auto-inclusion is disabled');
  assert.doesNotMatch(src, /window\.FeatureGate[\s\S]{0,160}PageRecurringCharges/,
    'feature flag should warn about billing inclusion, not block the management page');
  assert.doesNotMatch(src, /Promise\.all\(\[/,
    'one slow side request must not freeze the entire page');
  assert.doesNotMatch(src, /apiFetch\(/,
    'page should use apiCall so errors/timeouts are normalized');
});

test('recurring charges API validates targets before saving', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'recurring-charges.js'), 'utf8');

  assert.match(src, /Boolean\(v\.roomId\) !== Boolean\(v\.tenantId\)/,
    'create must require exactly one target: room or tenant');
  assert.match(src, /async function validateRecurringTarget/,
    'route must centralize target validation for create/update');
  assert.match(src, /WHERE id=\$1 AND status='active' AND deleted_at IS NULL/,
    'tenant-scoped charges must point at an active tenant');
  assert.match(src, /FROM rooms_v2 WHERE room_code=\$1 AND deleted_at IS NULL/,
    'room-scoped charges must verify rooms_v2 first');
  assert.match(src, /baankarn_rooms_v1' AND value \? \$1/,
    'room validation must fall back to the legacy room blob');
  assert.match(src, /INVALID_RECURRING_TARGET|TENANT_NOT_ACTIVE|ROOM_NOT_FOUND/,
    'target validation must return actionable error codes');
});

test('billing preview includes tenant-scoped recurring charges', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-billing.jsx'), 'utf8');

  assert.match(src, /fetch\('\/api\/recurring-charges\?active=true'/,
    'billing preview must load active recurring charges');
  assert.match(src, /fetch\('\/api\/tenants\?status=active'/,
    'billing preview must resolve tenant-scoped charges to current rooms');
  assert.match(src, /tenantById\[String\(t\.id\)\] = String\(t\.current_room_id\)/,
    'active tenant current_room_id must be indexed by tenant id');
  assert.match(src, /c\.room_id \|\| c\.roomId \|\| tenantById\[String\(c\.tenant_id \|\| c\.tenantId/,
    'tenant-scoped recurring rows must be grouped into the preview room totals');
});

test('recurring charges form wraps multi-sibling ternary in a Fragment (no babel crash)', () => {
  // Earlier shape had `{scope === 'tenant' ? (<select/>...{warn})...` —
  // multiple JSX siblings inside a ternary branch without a Fragment
  // wrapper. Babel-standalone parses this fine in isolation but the live
  // page fails to render with no actionable error, so admin sees a blank
  // /admin#recurring panel. The fix is `<React.Fragment>` (or `<>`).
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'project', 'admin', 'page-recurring-charges.jsx'), 'utf8'
  );
  const scopeBranch = src.match(/scope === 'tenant' \? \(([\s\S]+?)\) : \(/);
  assert.ok(scopeBranch, 'tenant scope ternary must exist');
  // The truthy branch must either be a single root element OR wrap its
  // siblings in <React.Fragment>...</React.Fragment> (or <>...</>).
  // Reject the case where a <select>...</select> is followed by another
  // sibling JSX expression (`{...}`) without a fragment.
  const branchBody = scopeBranch[1];
  const hasFragment = /React\.Fragment|<>[\s\S]*<\/>/.test(branchBody);
  const hasMultipleRoots = /<\/select>\s*\{/.test(branchBody);
  if (hasMultipleRoots) {
    assert.ok(hasFragment,
      'multi-sibling ternary branch must be wrapped in React.Fragment to avoid silent JSX parse failure');
  }
});

test('admin shell canonicalizes legacy recurring charges hash route', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const shell = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'shell.jsx'), 'utf8');
  const shared = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'shared.jsx'), 'utf8');

  assert.match(shell, /const PAGE_ALIASES = \{[\s\S]{0,120}'recurring-charges': 'recurring'/,
    'old #recurring-charges links must land on the current recurring page');
  assert.match(shell, /const pageId = canonicalPageId\(base\)[\s\S]{0,120}PAGE_TITLES\[pageId\]/,
    'hash parser must resolve aliases before checking page titles');
  assert.match(shell, /const \[page, setPageState\] = useState\(pageFromHash\)[\s\S]{0,160}const setPage = \(next\) => setPageState\(canonicalPageId\(next\)\)/,
    'programmatic navigation must also canonicalize page ids');
  assert.match(shared, /pricing: 'finance', recurring: 'finance', 'recurring-charges': 'finance'/,
    'recurring page must keep the finance tone after route rename');
});

test('admin shell live poll surfaces stale-data failures', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const shell = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'shell.jsx'), 'utf8');
  const idx = shell.indexOf('// --- Live data polling');
  assert.ok(idx > 0, 'live data polling block must exist');
  const block = shell.slice(idx, shell.indexOf('// --- Auth', idx));

  assert.match(block, /let warnedLiveError = false/,
    'live poll must throttle visible stale-data warnings');
  assert.match(block, /\(bRes\.status === 401 \|\| tRes\.status === 401\)/,
    'both live endpoints must surface session expiry');
  assert.match(block, /const liveErrors = \[/,
    'non-401 live endpoint failures must be collected');
  assert.match(block, /kind: 'warning'[\s\S]{0,240}liveErrors\.join/,
    'HTTP live poll failures must show an admin-facing warning');
  assert.match(block, /catch \(err\)[\s\S]{0,300}setToast && setToast\(\{[\s\S]{0,120}kind: 'warning'/,
    'network live poll failures must show an admin-facing warning');
  assert.match(block, /if \(bRes\.ok && tRes\.ok\)[\s\S]{0,140}warnedLiveError = false/,
    'live poll warnings should be allowed again after recovery');
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
  const reportsRoute = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'reports.js'), 'utf8'
  );
  assert.doesNotMatch(reportsRoute, /AVG\(cost\)::numeric\([^)]*\)\s+FILTER/i);
  assert.match(reportsRoute, /\(AVG\(cost\) FILTER \(WHERE cost > 0\)\)::numeric\(10,2\)/);
  assert.match(reportsRoute, /\(SUM\(cost\) FILTER \(WHERE status='completed'\)\)::numeric\(12,2\)/);
});

test('reports v2 maintenance tab exports CSV and Excel', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const reportsUi = fs.readFileSync(
    path.join(__dirname, '..', 'project', 'admin', 'page-reports-v2.jsx'), 'utf8'
  );
  const reportsRoute = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'reports.js'), 'utf8'
  );

  assert.match(reportsUi, /tab === 'maintenance' \? `\/api\/reports\/maintenance\/stats\?format=\$\{format\}`/,
    'maintenance tab export buttons must call the maintenance stats endpoint');
  assert.doesNotMatch(reportsUi, /tab !== 'maintenance'/,
    'maintenance tab must not hide CSV/Excel buttons');
  assert.match(reportsRoute, /if \(format === 'csv' \|\| format === 'xlsx'\)[\s\S]{0,900}send\(req, res, exportRows, 'maintenance-stats'\)/,
    'maintenance stats route must return export rows via the shared report sender');
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
  assert.match(body, /due_date <= CURRENT_DATE - \(\$1::int \* INTERVAL '1 day'\)/,
    'revoke threshold must trigger when a bill reaches the configured day count, not one day late');
  assert.match(body, /b\.due_date <= CURRENT_DATE - \(\$2::int \* INTERVAL '1 day'\)/,
    'restore threshold check must use the same inclusive boundary as revoke');
  assert.ok(!/ac\.updated_at/.test(body),
    'must not reference ac.updated_at — no such column on access_cards');
  const restoreStart = sched.indexOf('async function restoreAccessCardsForTenantIfClear');
  const restoreEnd = sched.indexOf('// B2', restoreStart);
  assert.ok(restoreStart > 0 && restoreEnd > restoreStart);
  const restoreBody = sched.slice(restoreStart, restoreEnd);
  assert.match(restoreBody, /tenantIdNum < 1/,
    'immediate payment restore helper must reject null/empty tenant ids instead of treating them as tenant 0');
  assert.match(restoreBody, /Number\.isFinite\(rawThreshold\)/,
    'immediate payment restore helper must clamp thresholds consistently with daily cron');
  assert.match(restoreBody, /b\.due_date <= CURRENT_DATE - \(\$3::int \* INTERVAL '1 day'\)/,
    'immediate payment restore helper must use the same inclusive overdue boundary');
});

test('scheduler runs access-card sync before overdue owner digest', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const sched = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8'
  );
  const start = sched.indexOf('async function tick(pool)');
  const end = sched.indexOf('let _interval', start);
  assert.ok(start > 0 && end > start);
  const body = sched.slice(start, end);
  const accessIdx = body.indexOf("await _withAdvisoryLock(pool, `accessSync-${todayKey}`");
  const accessResultIdx = body.indexOf("const accessResult = await _withAdvisoryLock(pool, `accessSync-${todayKey}`");
  const jobsIdx = body.indexOf('const jobs = [');
  const parallelIdx = body.indexOf('const results = await Promise.allSettled');
  const digestIdx = body.indexOf("`overdueDigest-${todayKey}`");
  const effectiveAccessIdx = accessIdx > 0 ? accessIdx : accessResultIdx;
  assert.ok(effectiveAccessIdx > 0 && effectiveAccessIdx < jobsIdx && jobsIdx < digestIdx && digestIdx < parallelIdx,
    'overdue digest reads state.todaysAccessSync, so access sync must finish before the parallel digest batch');
});

test('audit log inserts target the audit_logs table with canonical columns', () => {
  // Regression guard: a previous version of access-card audit inserts
  // used singular `audit_log` with renamed columns (actor / entity /
  // details). The table is actually `audit_logs` (plural) with columns
  // (user_id, action, entity_type, entity_id, detail) — see db/migrate.js.
  // The wrong-table INSERT silently failed with 42P01 ("relation does not
  // exist") and the audit trail stayed empty even though tests passed.
  // This guard scans both server.js and services/scheduler.js for the
  // bad pattern so the same mistake can't recur.
  const fs = require('node:fs');
  const path = require('node:path');
  for (const rel of ['server.js', 'services/scheduler.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    // Strip block + line comments so the regression note inside a
    // comment doesn't trip the assertion.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    assert.doesNotMatch(code, /INSERT\s+INTO\s+audit_log\s*\(/i,
      `${rel} must INSERT into audit_logs (plural), not audit_log`);
    assert.doesNotMatch(code, /INSERT\s+INTO\s+audit_logs\s*\([^)]*\bdetails\b/i,
      `${rel} must use detail (singular) column, not details`);
    assert.doesNotMatch(code, /INSERT\s+INTO\s+audit_logs\s*\([^)]*\bactor\b/i,
      `${rel} must use user_id column, not actor`);
    assert.doesNotMatch(code, /INSERT\s+INTO\s+audit_logs\s*\([^)]*\bentity\b(?!_)/i,
      `${rel} must use entity_type column, not entity`);
  }
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

test('auto billing guards against demo PromptPay target', () => {
  // The bundled default 0801234567 is useful for demos but dangerous in
  // production: invoices would contain a real-looking QR for the wrong
  // receiver. Bulk-generate and scheduler must flag it before bills go out.
  const fs = require('node:fs');
  const path = require('node:path');
  const sched = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
  const bulk = fs.readFileSync(path.join(__dirname, '..', 'routes', 'bills-extras.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(sched, /isDemoTarget\(ppTarget\)/,
    'scheduler must warn/block when PromptPay is still demo');
  assert.match(bulk, /DEMO_PROMPTPAY/,
    'bulk-generate must return a precondition issue for demo PromptPay');
  assert.match(server, /isDemoTarget\(ppDb \|\| ppEnv\)/,
    'production-readiness must fail demo PromptPay');
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

test('healthCheck samples pool stats before parallel probes', () => {
  // Pool stats used to run inside the same Promise.all as every DB-heavy
  // health probe. On small pools, /health warned about waiting queries that
  // the health probe itself had just created.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'healthCheck.js'), 'utf8');
  assert.match(src, /const poolResult = poolCheck \? await runOne\(poolCheck\) : null/,
    'pool stats must be sampled before the fan-out starts');
  assert.match(src, /CHECKS\.filter\(\(c\) => c\.id !== 'pool'\)\.map\(runOne\)/,
    'non-pool checks may still run in parallel after the pool sample');
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
  const allSettledIdx = src.indexOf('Promise.allSettled(jobs.map');
  assert.ok(lateFeeIdx > 0, 'tickLateFee must be awaited explicitly');
  assert.ok(allSettledIdx > lateFeeIdx,
    'Promise.allSettled (the parallel block) must come AFTER late-fee');
});

test('scheduler failures notify owner with throttled actionable alerts', () => {
  // Background jobs used to fail with only a console.error. In production
  // that means the owner may never learn that bill-gen/expiry/reconcile did
  // not run. Pin the shared failure reporter and the fan-in checks.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
  assert.match(src, /SCHEDULER_FAILURE_RE_ALERT_MIN = 60/,
    'scheduler failure alerts must be throttled');
  assert.match(src, /async function notifySchedulerFailure/,
    'scheduler must have a shared owner-alert path');
  assert.match(src, /notifier\.notifyOwner[\s\S]{0,700}\/admin#health/,
    'failure alert must tell admin where to investigate');
  assert.match(src, /features load failed[\s\S]{0,180}notifySchedulerFailure\(pool, \{\}, state, 'features-load'/,
    'features-load failure must not be swallowed silently');
  assert.match(src, /lateFeeResult[\s\S]{0,180}notifySchedulerFailure\(pool, flags, state, 'late-fee'/,
    'late-fee failure must notify owner');
  assert.match(src, /const jobs = \[[\s\S]{0,1600}job: 'bill-gen'[\s\S]{0,1600}job: 'orphan-slip-prune'/,
    'parallel scheduler jobs must carry stable alert names');
  assert.match(src, /r\.value && r\.value\.error[\s\S]{0,120}notifySchedulerFailure\(pool, flags, state, job, r\.value\)/,
    'fulfilled-but-error job results must still alert');
  const returnedErrors = src.match(/return \{ error: err\.message \}/g) || [];
  assert.ok(returnedErrors.length >= 8,
    'top-level scheduler job catches must return structured errors to the fan-in');
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

test('admin notification queue exposes failure diagnostics and retry guidance', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const routeIdx = server.indexOf("app.get('/api/admin/notifications'");
  assert.ok(routeIdx > 0, 'admin notification queue endpoint must exist');
  const route = server.slice(routeIdx, server.indexOf("app.post('/api/admin/notifications/:id/retry'", routeIdx));
  assert.match(route, /notifQueue\.diagnoseFailure\(row\)/,
    'notification API must attach structured diagnostics for failed rows');
  assert.match(route, /diagnostic: row\.last_error/,
    'diagnostics should only be attached when a row has an actual failure');

  const page = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-notifications-queue.jsx'), 'utf8');
  assert.match(page, /x\.diagnostic\.hint/,
    'notification queue UI must show the actionable failure hint');
  assert.match(page, /Retry หลังแก้ config/,
    'retry button must make config-dependent retry timing clear');
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

test('LINE binding only works for active current tenants', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'lineBinding.js'), 'utf8');
  assert.match(src, /SELECT id, full_name, line_binding_blocked, status, current_room_id/,
    'issue() must load tenant status and room before issuing a bind code');
  assert.match(src, /status !== 'active' \|\| !t\.rows\[0\]\.current_room_id/,
    'issue() must refuse moved-out or roomless tenants');
  assert.match(src, /t\.status AS tenant_status/,
    'tryBind() must load tenant status at bind time too');
  assert.match(src, /reason: 'tenant_not_active'/,
    'tryBind() must fail cleanly if the tenant moved out after code issue');
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

test('/files route delegates all local and S3 reads through storage.readFile', () => {
  // A tampered file_uploads row must not bypass storage._safeLocalPath by
  // joining category/filename directly in server.js.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idx = src.indexOf("app.get('/files/:id'");
  assert.ok(idx > 0, '/files route must exist');
  const end = src.indexOf("app.get('/',", idx);
  const route = src.slice(idx, end);
  assert.match(route, /storage\.readFile\(f\)/,
    '/files must use the storage service read guard');
  assert.doesNotMatch(route, /path\.join\(storage\.rootPath\(\), f\.category, f\.filename\)/,
    '/files must not rebuild local paths directly');
  assert.doesNotMatch(route, /res\.sendFile\(fp/,
    '/files must not send unchecked local paths');
});

test('public config mask does not expose raw PromptPay targets', () => {
  // Public room-board config only needs display metadata. The real target can
  // be a phone number or citizen ID and must stay behind tenant/admin payment
  // endpoints that already enforce session/token checks.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idx = src.indexOf('function maskConfigPublic');
  assert.ok(idx > 0, 'maskConfigPublic must exist');
  const end = src.indexOf("app.get('/api/data/:key'", idx);
  const fn = src.slice(idx, end);
  assert.match(fn, /promptpayDisplayName/,
    'public config may expose payment display name');
  assert.doesNotMatch(fn, /promptpayTarget\s*:/,
    'public config must not expose the raw PromptPay target');
  assert.doesNotMatch(fn, /cfg\.payment\.(?:promptpayTarget|promptpay)\b/,
    'public mask must not copy raw PromptPay fields');
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
  assert.match(src, /closed_at = COALESCE\(closed_at, NOW\(\)\)/,
    'checkout must stamp contract closure time');
  assert.match(src, /closed_reason = \$3/,
    'checkout reason must persist on the contract row');
  assert.match(src, /closed_type = 'tenant_checkout'/,
    'checkout path must identify the closure source');
  assert.match(src, /RETURNING id, contract_no, room_id,/,
    'checkout must keep the closed contract room_id for drift-safe room release');
  assert.match(src, /const releaseRoomIds = Array\.from\(new Set\(\[[\s\S]{0,140}tenantCurrentRoom,[\s\S]{0,80}\.\.\.contractRooms/,
    'checkout must release both tenant.current_room_id and active contracts.room_id when they drift');
  assert.match(src, /room_not_found_or_belongs_to_another_active_tenant/,
    'checkout must guard against clearing a room that now belongs to another tenant');
  assert.match(src, /UPDATE contract_invitations[\s\S]{0,260}status='revoked'/,
    'checkout must revoke pending/submitted contract invitations for closed contracts');
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

test('contracts gain close audit columns in migration', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrate.js'), 'utf8');
  for (const col of ['closed_at', 'closed_by', 'closed_reason', 'closed_type']) {
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

test('contract date helpers support month count and explicit end-date modes', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const shared = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'shared.jsx'), 'utf8');
  assert.match(shared, /function contractTodayYmd\(\)/,
    'admin UI must use local today for contract default start date');
  assert.match(shared, /function addContractMonths\(startYmd, months\)/,
    'admin UI must expose a reusable month-to-end-date helper');
  assert.match(shared, /new Date\(Date\.UTC\(ey, em, 0\)\)\.getUTCDate\(\)/,
    'helper must clamp end-of-month dates');
  assert.match(shared, /function estimateContractMonths\(startYmd, endYmd/,
    'admin UI must infer month count when admin edits endDate directly');
  assert.match(shared, /contractTodayYmd, addContractMonths, estimateContractMonths, contractDateSummary/,
    'helpers must be exported to page-contracts and page-tenants');
});

test('contract admin UIs auto-calculate endDate and send it to the APIs', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const contracts = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-contracts.jsx'), 'utf8');
  const tenants = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-tenants.jsx'), 'utf8');
  const quickInvite = contracts.match(/function QuickInviteModal[\s\S]+?<\/Modal>\s*\);\s*\}/)[0];
  assert.match(quickInvite, /endDate: addContractMonths\(initialStartDate, 12\)/,
    'quick-invite must default endDate from 12 months');
  assert.match(quickInvite, /const setMoveInDate = \(value\)[\s\S]{0,180}addContractMonths\(value, Number\(f\.termMonths\)\)/,
    'changing start date must recompute endDate');
  assert.match(quickInvite, /const setEndDate = \(value\)[\s\S]{0,220}estimateContractMonths\(f\.moveInDate, value, 60\)/,
    'editing endDate must infer termMonths when possible');
  assert.match(quickInvite, /endDate: form\.endDate \|\| null/,
    'quick-invite API payload must include explicit endDate');

  const checkin = tenants.match(/function CheckInModal[\s\S]+?function ContractQuickEditModal/)[0];
  assert.match(checkin, /endDate: addContractMonths\(initialStartDate, 12\)/,
    'tenant check-in modal must default endDate from 12 months');
  assert.match(checkin, /if \(form\.endDate\) payload\.endDate = form\.endDate/,
    'tenant check-in must send endDate to the server');

  const quickEdit = tenants.match(/function ContractQuickEditModal[\s\S]+?const inLbl/)[0];
  assert.match(quickEdit, /const contractStartDate = contract\.start_date/,
    'quick contract editor must calculate against immutable start_date');
  assert.match(quickEdit, /setTermMonths[\s\S]{0,260}addContractMonths\(contractStartDate, Number\(value\)\)/,
    'quick contract editor must recompute endDate from termMonths');
});

test('contract APIs validate explicit endDate and keep term_months/end_date consistent', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'index.js'), 'utf8');
  const tenantOps = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(schema, /endDate: z\.string\(\)\.regex\(/,
    'checkin schema must accept an explicit contract endDate');
  assert.match(tenantOps, /endDate: explicitEndDate/,
    'tenant checkin must read endDate from the request');
  assert.match(tenantOps, /const effectiveTermMonths = termMonths[\s\S]{0,160}estimateContractMonths\(moveInDate, requestedEndDate, 60\)/,
    'tenant checkin must infer termMonths from explicit endDate when exact');
  assert.match(tenantOps, /END_DATE_TOO_FAR/,
    'tenant checkin must reject accidental far-future end dates');
  const quickInvite = server.match(/app\.post\('\/api\/contracts\/quick-invite'[\s\S]+?app\.post\('\/api\/contracts\/:id\/invite-tenant'/)[0];
  assert.match(quickInvite, /const requestedEndDate = b\.endDate/,
    'quick-invite must accept explicit endDate');
  assert.match(quickInvite, /effectiveTermMonths \|\| null/,
    'quick-invite must persist inferred term_months');
  const edit = server.match(/app\.put\('\/api\/contracts\/:id'[\s\S]+?app\.post\('\/api\/contracts\/:id\/sign'/)[0];
  assert.match(edit, /addContractMonths\(startDateYmd, Number\(b\.termMonths\)\)/,
    'contract edit endpoint must derive end_date when only termMonths changes');
  assert.match(edit, /estimateContractMonths\(startDateYmd, String\(b\.endDate\), 120\)/,
    'contract edit endpoint must derive term_months when only endDate changes');
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

test('booking approval keeps JSONB and rooms_v2 room locks consistent', () => {
  // A room can exist in both the legacy rooms blob and rooms_v2. If the
  // candidate comes from the blob, rooms_v2 still has to flip to reserved;
  // otherwise another approval can see rooms_v2=vacant and double-assign it.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = src.match(/app\.post\('\/api\/bookings\/:id\/approve-and-assign'[\s\S]+?app\.put\('\/api\/bookings\/:id'/)[0];
  assert.match(block, /SELECT status FROM rooms_v2[\s\S]{0,200}FOR UPDATE/,
    'blob candidates must check the matching rooms_v2 row under lock');
  assert.match(block, /v2State\.rows\.length && v2State\.rows\[0\]\.status !== 'vacant'[\s\S]{0,80}continue/,
    'stale JSONB vacancies must be skipped when rooms_v2 is not vacant');
  assert.match(block,
    /UPDATE rooms_v2 SET status='reserved', updated_at=NOW\(\)[\s\S]{0,120}WHERE room_code=\$1 AND status='vacant'/,
    'rooms_v2 must be reserved even when the selected candidate came from JSONB');
});

test('booking cancellation releases only its own reserved room', () => {
  // Approved bookings reserve a room. If admin cancels before contract
  // handoff, the room must become vacant again, but only when reservedBy
  // matches this booking id so we never free someone else's room.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = src.match(/app\.put\('\/api\/bookings\/:id'[\s\S]+?\/\/ === v2: Recurring charges helper/)[0];
  assert.match(block, /SELECT value FROM app_data WHERE key='baankarn_bookings_v1' FOR UPDATE/,
    'booking updates must lock the booking blob');
  assert.match(block, /if \(room && room\.status === 'reserved'\)/,
    'room release must only consider reserved rooms');
  assert.match(block, /room\.reservedBy === id/,
    'approved booking release must be guarded by reservedBy=booking id');
  assert.match(block, /BOOKING_HAS_ACTIVE_CONTRACT/,
    'completed booking cancellation must refuse release while a linked contract is active');
  assert.match(block, /const \{ tenant, reservedBy, reservedAt,[\s\S]{0,80}\} = room/,
    'release must drop stale tenant/reservation metadata from the room blob');
  assert.match(block,
    /UPDATE rooms_v2 SET status='vacant', updated_at=NOW\(\)[\s\S]{0,120}WHERE room_code=\$1 AND status='reserved'/,
    'rooms_v2 must be released only from reserved status');
  assert.match(block, /COMMIT/,
    'booking status update and room release must be atomic');
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
  // (Endpoints moved to routes/tenant-ops.js in round 9.)
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
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

test('tenant portal access is limited to active tenants with a current room', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /function tenantCanUsePortal\(t\)[\s\S]{0,180}t\.status === 'active'[\s\S]{0,180}current_room_id/,
    'tenant sessions must require active status and current room');
  assert.match(server, /if \(!tenantCanUsePortal\(session\)\) \{[\s\S]{0,180}DELETE FROM tenant_sessions WHERE sid_hash=\$1/,
    'stale sessions for moved-out tenants must be invalidated on lookup');
  assert.match(server, /SELECT id, full_name, status, current_room_id[\s\S]{0,350}WHERE phone=\$1[\s\S]{0,200}status='active'[\s\S]{0,200}current_room_id IS NOT NULL/,
    'tenant login must load only active current tenants for the registered phone');
  assert.match(server, /PHONE_LINKED_TO_MULTIPLE_ACTIVE_ROOMS/,
    'phone-only login must refuse ambiguous shared-phone active-room matches');
  assert.match(server, /if \(!tenantCanUsePortal\(matched\)\) \{[\s\S]{0,500}TENANT_NOT_ACTIVE/,
    'tenant login must reject a tenant that already moved out or has no room');

  const ops = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
  assert.match(ops, /DELETE FROM tenant_sessions WHERE tenant_id=\$1/,
    'checkout must revoke active tenant portal sessions immediately');
  assert.equal(ops.includes('/_tenant/pin/'), false,
    'tenant PIN management endpoints must not remain mounted');
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
  // Endpoint lives in routes/tenant-ops.js (round 9). The router mounts at
  // /api/tenants, so the local path is /:id/identity.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
  assert.match(src, /r\.post\('\/:id\/identity'/,
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
  const block = src.match(/app\.post\('\/api\/contracts\/:id\/sign'[\s\S]+?\/\/ === v2: Contract templates/)[0];
  assert.match(block,
    /UPDATE contracts[\s\S]{0,600}signature_image_id IS NULL OR \$5::boolean/,
    'signature update must re-check signature_image_id atomically to close double-click/admin race');
  assert.match(block, /CONTRACT_SIGN_CONFLICT/,
    'sign race must return a clean conflict instead of silently overwriting');
  // Schema must require a non-trivially-empty signature data URL.
  const sch = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'index.js'), 'utf8');
  assert.match(sch, /schemas\.contractSign = z\.object\([\s\S]{0,200}signatureDataUrl/,
    'contractSign schema must validate signature data URL');
});

test('admin tenant create validates Thai checksum + dedup hash', () => {
  // POST /api/tenants moved to routes/tenant-ops.js in round 9.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
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

test('quick-invite refuses duplicate unsigned drafts for same tenant', () => {
  // Two parallel quick-invites for the same tenant produce two ghost
  // contracts. Once one is approved + locked, the other stays as orphan
  // state forever. Now blocked with DRAFT_CONTRACT_EXISTS 409 unless
  // admin explicitly forces.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = src.match(/quick-invite'[\s\S]+?app\.post\('\/api\/contracts\/:id\/invite-tenant'/)[0];
  assert.match(block,
    /SELECT id, contract_no, room_id FROM contracts[\s\S]{0,300}WHERE tenant_id=\$1 AND status='active' AND locked_at IS NULL/,
    'duplicate-draft check must scope to unsigned active contracts');
  assert.match(block, /DRAFT_CONTRACT_EXISTS/);
  // Force-bypass remains available
  assert.match(block, /if \(!isForced\) \{[\s\S]{0,200}dupContract/,
    'duplicate-draft check is gated on !isForced');
});

test('quick-invite locks the requested room before creating a draft contract', () => {
  // Quick-invite creates an unsigned active contract. That is still a room
  // claim, so the backend must prevent drafts on occupied rooms, rooms with
  // another active contract, or reservations owned by another booking.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = src.match(/quick-invite'[\s\S]+?app\.post\('\/api\/contracts\/:id\/invite-tenant'/)[0];
  assert.match(block,
    /SELECT id, full_name FROM tenants[\s\S]{0,250}current_room_id=\$1[\s\S]{0,160}id <> \$2[\s\S]{0,120}FOR UPDATE/,
    'must lock/check active occupant by room before drafting');
  assert.match(block, /ROOM_CONTRACT_EXISTS/,
    'must block a second active contract or draft on the same room');
  assert.match(block, /TENANT_ROOM_CONTRACT_EXISTS/,
    'must block creating a new invite on top of the same tenant-room locked contract');
  assert.match(block, /ROOM_RESERVED/,
    'must block reservations owned by another booking/contract');
  assert.match(block, /TENANT_ALREADY_ACTIVE/,
    'must block quick-invite when the reused tenant is still active in another room');
  assert.match(block, /ROOM_NOT_FOUND/,
    'must reject unknown room ids instead of creating phantom rooms in the blob');
  assert.match(block, /roomStatuses\.includes\('occupied'\)[\s\S]{0,160}roomStatuses\.includes\('reserved'\)/,
    'rooms_v2 occupied/reserved state must override stale vacant JSONB');
  assert.match(block, /SELECT value FROM app_data WHERE key='baankarn_bookings_v1' FOR UPDATE[\s\S]{0,3000}SELECT value FROM app_data WHERE key='baankarn_rooms_v1' FOR UPDATE/,
    'must lock booking blob before room blob to keep the app_data lock order stable');
  assert.match(block, /reservedBy: `contract:\$\{contract\.id\}`/,
    'draft contract must own the room reservation');
  assert.match(block,
    /UPDATE rooms_v2 SET status='reserved', updated_at=NOW\(\)[\s\S]{0,160}WHERE room_code=\$1 AND status = ANY\(\$2::text\[\]\)/,
    'draft reservation must be mirrored to rooms_v2 for allowed source statuses');
  assert.match(block,
    /LEFT JOIN tenants t ON t\.id = c\.tenant_id[\s\S]{0,180}FOR UPDATE OF c/,
    'room-contract conflict query must lock only contracts; plain FOR UPDATE crashes on LEFT JOIN nullable side');
  assert.doesNotMatch(block,
    /LEFT JOIN tenants t ON t\.id = c\.tenant_id[\s\S]{0,180}FOR UPDATE\s*(?:`|,)/,
    'quick-invite must not use plain FOR UPDATE after LEFT JOIN tenants');
});

test('quick-invite converts same-tenant preclaimed rooms into draft reservations', () => {
  // The Add Tenant modal can create a tenant and preclaim a room before the
  // admin clicks "create contract". Quick-invite must not dead-end on its
  // own preclaim as ROOM_OCCUPIED; it should turn that state into the normal
  // pending contract reservation and wait until approval to write
  // tenants.current_room_id.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = src.match(/quick-invite'[\s\S]+?app\.post\('\/api\/contracts\/:id\/invite-tenant'/)[0];
  assert.match(block, /sameTenantPreclaimedRoom = tQ\.rows\[0\]\.status === 'active'[\s\S]{0,120}current_room_id === roomId/,
    'quick-invite must recognise a room already preclaimed by the same tenant');
  assert.match(block, /roomState === 'occupied' && !sameTenantPreclaimedRoom/,
    'occupied rooms are blocked unless the occupying tenant is the invite tenant');
  assert.match(block, /UPDATE tenants[\s\S]{0,120}SET current_room_id=NULL/,
    'same-tenant preclaim must be cleared until the invitation is approved');
  assert.match(block, /sameTenantPreclaimedRoom[\s\S]{0,120}\['vacant', 'occupied'\]/,
    'rooms_v2 may move occupied→reserved only for the same-tenant preclaim case');
});

test('PUT /api/contracts/:id status=ended cascades tenant + room state', () => {
  // Pre-fix: admin manually flipped contracts.status='ended' via the
  // contracts editor — but tenant.status stayed 'active', current_room_id
  // stayed set, room.status stayed 'occupied'. Bills kept generating.
  // Now: status='ended'/'expired' triggers the same cascade as checkout.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = src.match(/app\.put\('\/api\/contracts\/:id'[\s\S]+?app\.post\('\/api\/contracts\/:id\/sign'/)[0];
  assert.match(block, /isClosingContract = requestedStatus === 'ended' \|\| requestedStatus === 'expired'/);
  assert.match(block,
    /UPDATE tenants SET status='moved_out', current_room_id=NULL/,
    'tenant must be moved out when contract closes');
  assert.match(block,
    /\(\(value->\$1\) - 'tenant'\) \|\| jsonb_build_object\('status', 'vacant'\)/,
    'room.tenant must be dropped + status=vacant on cascade; parens on (value->$1) '
    + 'are required so PG evaluates the JSONB arrow before the minus operator');
  // Wrapped in transaction so the cascade is atomic with the contract update
  assert.match(block, /BEGIN/);
  assert.match(block, /COMMIT/);
  assert.match(block, /ROLLBACK/);
  assert.match(block, /reservedBy[\s\S]{0,120}`contract:\$\{contract\.id\}`/,
    'closing an unsigned draft contract must release its contract-owned reservation too');
  assert.match(block,
    /UPDATE rooms_v2 SET status='vacant', updated_at=NOW\(\)[\s\S]{0,120}WHERE room_code=\$1 AND status='reserved'/,
    'draft close must release rooms_v2 only from reserved status');
});

test('contract close requires reason and performs full lifecycle cleanup', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = src.match(/app\.put\('\/api\/contracts\/:id'[\s\S]+?app\.post\('\/api\/contracts\/:id\/sign'/)[0];
  assert.match(block, /CONTRACT_CLOSE_REASON_REQUIRED/);
  assert.match(block, /CONTRACT_REOPEN_BLOCKED/);
  assert.match(block, /CONTRACT_CLOSE_TYPE_INVALID/);
  assert.match(block, /closed_at=COALESCE\(closed_at, NOW\(\)\)/);
  assert.match(block, /closed_reason=\$/);
  assert.match(block, /params\.push\(closeReason\)/);
  assert.match(block, /end_date=CURRENT_DATE/);
  assert.match(block, /UPDATE contract_invitations[\s\S]{0,260}status='revoked'/);
  assert.match(block, /DELETE FROM tenant_sessions/);
  assert.match(block, /UPDATE access_cards[\s\S]{0,260}auto:contract-close/);
  assert.match(block, /UPDATE recurring_charges[\s\S]{0,420}deactivated on contract close/);
  assert.match(block, /notifyOwner[\s\S]{0,400}ปิดสัญญา/);
  assert.match(block, /notifyTenant[\s\S]{0,500}แจ้งปิดสัญญา/);
});

test('approve ROOM_OCCUPIED + CITIZEN_ID_DUPLICATE return nextActions for self-recovery', () => {
  // Pre-fix: admin saw "ห้องมีผู้เช่ารายอื่น" but no link to checkout.
  // Now both errors include nextActions URLs admin can click.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = src.match(/\/approve'[\s\S]+?app\.post\('\/api\/admin\/contract-invitations\/:id\/reject'/)[0];
  // ROOM_OCCUPIED nextActions
  assert.match(block,
    /ROOM_OCCUPIED[\s\S]{0,500}checkoutExistingTenantUrl: `\/admin#tenants\/\$\{roomConflict\.id\}`/,
    'ROOM_OCCUPIED must surface a checkout URL for the existing occupant');
  // CITIZEN_ID_DUPLICATE hint via lookup endpoint
  assert.match(block,
    /CITIZEN_ID_DUPLICATE[\s\S]{0,500}lookup-by-citizen-id/,
    'CITIZEN_ID_DUPLICATE must point admin at the lookup endpoint');
});

test('booking status machine forces approve-and-assign before contract handoff', () => {
  // Pre-fix: quick-invite UPDATE bookings SET status='completed' but
  // PUT /api/bookings/:id rejected it (BOOKING_STATUSES set didn't list
  // 'completed'). Admin couldn't edit completed bookings.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src,
    /BOOKING_STATUSES = new Set\(\[[\s\S]{0,200}'completed'\]\)/,
    'BOOKING_STATUSES must include completed');
  // Direct PUT must not approve a booking, because approval has to reserve
  // a room in the same transaction via /approve-and-assign.
  assert.doesNotMatch(src, /pending:\s*\[[^\]]*'approved'/,
    'pending → approved must not be a direct PUT transition');
  assert.doesNotMatch(src, /reviewing:\s*\[[^\]]*'approved'/,
    'reviewing → approved must not be a direct PUT transition');
  assert.match(src, /APPROVAL_REQUIRES_ASSIGNMENT_FLOW/,
    'direct approval attempts must return an actionable error code');
  // Transitions after the locked approval step: approved → completed is
  // allowed only from quick-invite; completed → cancelled remains open for
  // tenant backs-out cases where no active contract remains.
  assert.match(src, /approved:\s*\['completed', 'cancelled'\]/,
    'approved must allow → completed (quick-invite handoff)');
  assert.match(src, /completed: \['cancelled'\]/,
    'completed must still allow → cancelled (tenant backs out)');
});

test('admin toastError explains booking-to-contract guard codes with next actions', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const hooks = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'hooks.jsx'), 'utf8');
  for (const code of [
    'APPROVAL_REQUIRES_ASSIGNMENT_FLOW',
    'BOOKING_NOT_APPROVED',
    'BOOKING_ROOM_MISMATCH',
    'BOOKING_ROOM_NOT_RESERVED',
    'BOOKING_TENANT_MISMATCH',
    'ROOM_RESERVED',
    'ROOM_OCCUPIED',
    'ROOM_STRANDED_CONTRACT',
    'CONTRACT_APPROVAL_PRECHECK_FAILED',
    'CONTRACT_APPROVAL_TARGET_INVALID',
    'CITIZEN_ID_DUPLICATE',
  ]) {
    assert.match(hooks, new RegExp(`${code}:\\s*\\{`),
      `toastError must map ${code} to a clear Thai message`);
  }
  assert.match(hooks, /function extraGuidanceFromRaw/,
    'toastError must have a generic hint/nextActions formatter');
  assert.match(hooks, /raw\.nextActions/,
    'generic fallback must surface backend nextActions instead of hiding them');
  assert.match(hooks, /reconcileUrl/,
    'generic fallback must surface reconcile links from backend errors');
});

test('bookings admin UI handles terminal statuses and uses valid reopen/cancel transitions', () => {
  // Completed/cancelled bookings can appear in the "all" tab after contract
  // handoff or no-show cancellation. The UI must render them safely and must
  // not call backend-forbidden transitions such as approved → pending or
  // rejected → pending.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-bookings.jsx'), 'utf8');
  assert.match(src, /completed:\s*\{\s*label:[\s\S]{0,80}color: 'neutral'/,
    'completed must have a status pill');
  assert.match(src, /cancelled:\s*\{\s*label:[\s\S]{0,80}color: 'neutral'/,
    'cancelled must have a status pill');
  assert.match(src, /const meta = statusMap\[b\.status\] \|\|/,
    'unknown/legacy booking statuses must not crash the table or drawer');
  assert.match(src, /active\.status === 'approved'[\s\S]{0,900}updateStatus\(active\.id, 'cancelled'\)/,
    'approved booking button must cancel/release, not return to pending');
  assert.doesNotMatch(src, /active\.status === 'approved'[\s\S]{0,900}updateStatus\(active\.id, 'pending'\)/,
    'approved → pending is forbidden by the backend state machine');
  assert.match(src, /active\.status === 'rejected'[\s\S]{0,260}type: 'reopen'/,
    'rejected booking reopen must open a reason-confirmation flow');
  assert.match(src, /const handleReopen = async \(id\) => \{[\s\S]{0,500}updateStatus\(id, 'reviewing', \{ reopenReason \}\)/,
    'rejected booking reopen must go through reviewing with an explicit reason');
  assert.match(src, /actionReason\.trim\(\)\.length < 5/,
    'rejected booking reopen must block short/empty reasons before calling the API');
});

test('quick-invite refuses blacklisted tenant without force=true', () => {
  // Pre-fix: quick-invite silently flipped a blacklist tenant back to
  // 'active'. A hijacked admin session could re-onboard banned tenants
  // without a paper trail. Now refuses with TENANT_BLACKLISTED + 409;
  // explicit force=true required to override (audit-logged).
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = src.match(/quick-invite'[\s\S]+?app\.post\('\/api\/contracts\/:id\/invite-tenant'/)[0];
  assert.match(block,
    /tQ\.rows\[0\]\.status === 'blacklist' && !isForced/,
    'must explicitly check blacklist before reactivating');
  assert.match(block, /TENANT_BLACKLISTED/,
    'must surface a clean error code');
});

test('checkout removes room.tenant from blob (no notification leak)', () => {
  // Pre-fix: checkout flipped status='vacant' but left the moved-out
  // tenant's name/phone/email in the blob's room.tenant. The next bulk-
  // send pulled those stale values and SMS'd the previous occupant.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
  assert.match(src,
    /\(\(value->\$1\) - 'tenant'\) \|\| jsonb_build_object\('status', 'vacant'\)/,
    'checkout must drop the tenant key alongside flipping status; (value->$1) '
    + 'must be parenthesised so the JSONB arrow binds tighter than the - operator');
});

test('rooms-blob tenant-key drop never expands to "text - unknown" 42883', () => {
  // Regression: PostgreSQL operator precedence parses `value->$1 - 'tenant'`
  // as `value -> ($1 - 'tenant')` because the arithmetic `-` binds tighter
  // than the user-defined `->` arrow. Result: PG tries `text - unknown`
  // (subtract literal from $1::text) → 42883 "operator does not exist",
  // which surfaced in production as "ยกเลิกสัญญาไม่ได้". Every site that
  // drops a tenant key from the rooms blob must parenthesise the arrow.
  const fs = require('node:fs');
  const path = require('node:path');
  for (const rel of ['server.js', 'routes/tenant-ops.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    // The bare unparenthesised form must NOT appear anywhere.
    assert.ok(
      !/\(value->\$1 - 'tenant'\)/.test(src),
      `${rel}: bare "(value->$1 - 'tenant')" still present — would crash with 42883`
    );
  }
});

test('approve also notifies the tenant (closes the "send PDF to me" loop)', () => {
  // Pre-fix: only owner got notified after approve. Tenant heard nothing
  // until they checked the portal. Now they get a "✅ สัญญาเช่าได้รับ
  // การอนุมัติแล้ว" message with next-steps.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = src.match(/\/approve'[\s\S]+?app\.post\('\/api\/admin\/contract-invitations\/:id\/reject'/)[0];
  assert.match(block, /notifyTenant\(\{ pool, features: flags \}/,
    'approve must call notifyTenant');
  assert.match(block, /สัญญาเช่าได้รับการอนุมัติแล้ว/,
    'tenant message must announce approval');
});

test('approve writes room.tenant into JSONB blob (so scheduler can auto-bill)', () => {
  // scheduler.tickBillGen iterates the baankarn_rooms_v1 blob and skips
  // any room where !room.tenant — so just flipping status='occupied'
  // wasn't enough. Without this nested jsonb_set the auto-billing never
  // fires for tenants approved via the invitation flow → admin discovers
  // the bug only when the next month rolls around with zero bills.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = src.match(/\/approve'[\s\S]+?app\.post\('\/api\/admin\/contract-invitations\/:id\/reject'/)[0];
  // UPSERT pattern (jsonb_build_object) merges status + tenant into the
  // room object. Matches the room-only-in-rooms_v2 case where the blob
  // didn't have the room key yet.
  assert.match(block,
    /value \|\| jsonb_build_object\([\s\S]{0,400}'status', 'occupied'[\s\S]{0,200}'tenant', \$2::jsonb/,
    'approve must UPSERT {status, tenant} into the blob room');
  // Also the data shape — pulled fresh from FOR-UPDATE-locked tenant row.
  assert.match(block, /SELECT full_name, phone, email FROM tenants WHERE id=\$1/);
  assert.match(block, /blobTenant = \{/);
  // INSERT...ON CONFLICT bootstrap so brand-new deployments without the
  // app_data row still work.
  assert.match(block,
    /INSERT INTO app_data \(key, value, updated_by\)\s*VALUES \('baankarn_rooms_v1'/,
    'must bootstrap the app_data row before UPSERT');
});

test('checkin also writes room.tenant into JSONB blob', () => {
  // Same scheduler-skip risk as approve. Pin the same UPSERT pattern for
  // the checkin path so both onboarding flows stay consistent — and the
  // INSERT...ON CONFLICT bootstrap covers brand-new deployments.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
  assert.match(src,
    /value \|\| jsonb_build_object\([\s\S]{0,400}'status', 'occupied'[\s\S]{0,200}'tenant', \$2::jsonb/,
    'checkin must UPSERT {status, tenant} into the blob room');
  assert.match(src, /blobTenant = \{[\s\S]{0,200}name: tenant\.full_name/);
  assert.match(src,
    /INSERT INTO app_data \(key, value, updated_by\)\s*VALUES \('baankarn_rooms_v1'/,
    'checkin must bootstrap the app_data row before UPSERT');
});

test('quick-invite has moveInDate window + deposit cap (parity with checkin)', () => {
  // Pre-fix: quick-invite accepted any future date (admin could pick
  // 2030 by mistake) and any deposit amount (extra zero typos).
  // Now mirrors checkin's tenancyContract guards — same defaults
  // (30/90 day window, 3× rent cap), same { force: true } bypass.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = src.match(/quick-invite'[\s\S]+?app\.post\('\/api\/contracts\/:id\/invite-tenant'/)[0];
  assert.match(block, /MOVE_IN_OUT_OF_WINDOW/,
    'quick-invite must surface MOVE_IN_OUT_OF_WINDOW like checkin');
  assert.match(block, /DEPOSIT_TOO_LARGE/,
    'quick-invite must surface DEPOSIT_TOO_LARGE like checkin');
  assert.match(block, /tenancy\.moveInPastDays \?\? 30/);
  assert.match(block, /tenancy\.depositMaxMonths \?\? 3/);
  // Force-bypass mirrors checkin
  assert.match(block, /isForced = b\.force === true/);
});

test('quick-invite carries booking photo + marks booking completed', () => {
  // When admin sends invite from an already-approved booking, the
  // public form's citizen-ID front photo should auto-link instead of
  // forcing the tenant to re-upload. The booking row is also marked
  // completed so it disappears from the pending queue.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = src.match(/quick-invite'[\s\S]+?app\.post\('\/api\/contracts\/:id\/invite-tenant'/)[0];
  // Booking lookup with pre-migration tolerance
  assert.match(block,
    /SELECT citizen_id_image_front_id FROM bookings WHERE external_id=\$1/);
  // Category + ref_id verification before retargeting (defense in depth)
  assert.match(block,
    /WHERE id=\$1 AND category='citizen_id_image'[\s\S]{0,200}ref_id='public-booking-pending'/);
  // Booking marked completed — with status guard so rejected/cancelled
  // bookings can't be silently resurrected as 'completed'. The guard
  // uses `status = ANY($2::text[])` against the allowedFromForQuickInvite
  // list (approved only); the bare SET form was the bug.
  assert.match(block, /UPDATE bookings[\s\S]{0,80}SET status='completed'/);
  assert.match(block,
    /WHERE external_id=\$1[\s\S]{0,80}AND status = ANY\(\$2::text\[\]\)/,
    'quick-invite UPDATE must guard against forbidden source statuses');
  assert.match(block, /BOOKING_NOT_APPROVED/,
    'quick-invite must reject booking carry-over before approve-and-assign');
  assert.match(block, /BOOKING_ROOM_MISMATCH/,
    'quick-invite must reject a bookingId that belongs to another room');
  assert.match(block, /BOOKING_ROOM_NOT_RESERVED/,
    'quick-invite must require the room reservation to still point at the booking');
  assert.match(block, /BOOKING_TENANT_MISMATCH/,
    'quick-invite must reject using one applicant booking to create another tenant contract');
  assert.match(block, /bookingPhone && tenantPhone && bookingPhone !== tenantPhone/,
    'booking carry-over identity guard must compare applicant phone to contract phone');
  assert.match(block, /const allowedFromForQuickInvite = \['approved'\]/,
    'only approved bookings may be marked completed by quick-invite');
  assert.match(block, /SELECT value FROM app_data WHERE key='baankarn_bookings_v1' FOR UPDATE/,
    'quick-invite must lock the JSONB booking list before marking it completed');
  assert.match(block, /status: 'completed'[\s\S]{0,220}contractId: contract\.id/,
    'quick-invite must mark the JSONB booking completed and link the contract');
  assert.match(block, /'baankarn_bookings_v1', JSON\.stringify\(bookingCarryoverList\)/,
    'quick-invite must persist the completed status back to the JSONB booking list');
});

test('approve invitation links tenant ↔ room (current_room_id + rooms_v2 + JSONB)', () => {
  // Without this integration, approve would mark the contract as signed
  // but bills wouldn't auto-generate (scheduler can't find the tenant in
  // a room) and /api/rooms?status=vacant would still show the room as
  // available — letting another admin double-assign it. Pin the four
  // critical writes that close the loop.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = src.match(/\/approve'[\s\S]+?app\.post\('\/api\/admin\/contract-invitations\/:id\/reject'/)[0];
  // 1. SET tenant.current_room_id (so scheduler.tickBillGen can find them)
  assert.match(block,
    /UPDATE tenants[\s\S]{0,400}SET current_room_id=\$1[\s\S]{0,200}status='active'/,
    'approve must set tenant.current_room_id + reactivate');
  // 2. Free old room if tenant is moving from a different room
  assert.match(block,
    /if \(oldRoomId && oldRoomId !== contract\.room_id\)[\s\S]{0,300}'vacant'/,
    'approve must free the old room when tenant is moving');
  // 3. Occupy the new room — both rooms_v2 + the JSONB blob (dual-write)
  // The blob update went UPSERT (jsonb_build_object so rooms-only-in-rooms_v2
  // also get the entry). 'occupied' is now a literal value in the merged object.
  assert.match(block,
    /'status', 'occupied'[\s\S]{0,400}'baankarn_rooms_v1'/,
    'approve must UPSERT room into JSONB blob with status=occupied');
  assert.match(block,
    /UPDATE rooms_v2 SET status='occupied'[\s\S]{0,200}WHERE room_code=\$1/,
    'approve must update rooms_v2 to occupied');
  // 4. Refuse if room already occupied by ANOTHER active tenant (prevents
  // race when two admins approve into the same room).
  assert.match(block,
    /SELECT id, full_name FROM tenants[\s\S]{0,300}current_room_id=\$1[\s\S]{0,200}id <> \$2[\s\S]{0,200}FOR UPDATE/,
    'approve must check for room conflict before flipping');
  assert.match(block, /code: 'ROOM_OCCUPIED'/,
    'room conflict must surface as ROOM_OCCUPIED 409');
});

test('approve invitation welcome bill cannot poison approve transaction', () => {
  // Welcome-bill creation is best-effort inside the approve transaction.
  // If INSERT hits a unique/schema error, Postgres marks the transaction
  // aborted unless the code rolls back to a savepoint. Without this guard,
  // admin can see a successful approve response while COMMIT actually rolls
  // back the tenant/room/contract writes.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = src.match(/\/approve'[\s\S]+?app\.post\('\/api\/admin\/contract-invitations\/:id\/reject'/)[0];
  assert.match(block, /SAVEPOINT welcome_bill/,
    'welcome-bill block must use a transaction savepoint');
  assert.match(block, /ROLLBACK TO SAVEPOINT welcome_bill/,
    'welcome-bill failure must clear the aborted transaction state');
  assert.match(block, /ON CONFLICT DO NOTHING/,
    'welcome-bill insert must tolerate both bill_no and room-period uniqueness');
});

test('approve owner notify includes contract details + PDF link', () => {
  // Old notification was generic "อนุมัติ invitation #N" — owner had to
  // dig through 3 pages to verify. Now message includes contract no,
  // room id, rent, lock confirmation, and a direct PDF URL.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = src.match(/\/approve'[\s\S]+?app\.post\('\/api\/admin\/contract-invitations\/:id\/reject'/)[0];
  // Subject mentions contract_no + room
  assert.match(block, /อนุมัติสัญญา.*\$\{contract\.contract_no/);
  assert.match(block, /ห้อง.*\$\{contract\.room_id/);
  // Body has rent + PDF URL
  assert.match(block, /\$\{Number\(contract\.monthly_rent\)/);
  assert.match(block, /\/api\/contracts\/\$\{contract\.id\}\/pdf/);
});

test('approve response includes nextActions for admin UI to follow', () => {
  // After approval, admin needs an immediate "what next?" prompt — see PDF
  // or generate first bill. The response carries the URLs so the UI can
  // show buttons without a separate fetch.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = src.match(/\/approve'[\s\S]+?app\.post\('\/api\/admin\/contract-invitations\/:id\/reject'/)[0];
  assert.match(block, /nextActions: \{[\s\S]{0,200}pdfUrl[\s\S]{0,200}billingUrl/);
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
  assert.match(block, /SELECT id, full_name, phone, email, line_user_id, line_oa_id,[\s\S]{0,120}status, current_room_id[\s\S]{0,200}WHERE phone=\$1/);
  // Must reactivate moved_out tenants instead of creating new rows.
  assert.match(block, /SET status='active'/);
  // Must skip the heavy checkin guards (no IDENTITY_INCOMPLETE here).
  assert.ok(!/IDENTITY_INCOMPLETE/.test(block),
    'quick-invite must NOT enforce identity guards');
  // Token + invitation must be inlined in the same transaction (no
  // nested BEGIN — the helper would crash inside an open tx).
  assert.match(block, /INSERT INTO contract_invitations/);
  assert.match(block, /tryNotifyTenantContractInvitation/,
    'quick-invite must attempt to send the generated link after commit');
  assert.match(block, /delivery,[\s\S]{0,120}invitation:/,
    'quick-invite response must include delivery status for the UI');
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
  assert.match(src, /inviteDeliverySummary\(result\.delivery\)/,
    'quick-invite result must show whether the link was sent automatically');
  assert.match(src, /inviteErrorMessage\('สร้างสัญญา\/ส่งลิงก์ล้มเหลว'/,
    'quick-invite errors should include structured hints/codes');
  assert.match(src, /navigator\.clipboard\.writeText/);
});

test('contracts quick-invite uses vacant room inventory and auto-fills room pricing', () => {
  // Quick contract creation is a stock-locking workflow, so the UI should not
  // make the operator type arbitrary room IDs when it already has the rooms
  // inventory from the admin shell.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-contracts.jsx'), 'utf8');
  assert.match(src, /function PageContracts\(\{ setToast, addActivity, rooms = \{\}, config \}\)/,
    'contracts page must accept rooms from shell props');
  assert.match(src, /<QuickInviteModal[\s\S]{0,160}rooms=\{rooms\}[\s\S]{0,80}config=\{config\}/,
    'quick-invite modal must receive room inventory');

  const start = src.indexOf('function QuickInviteModal');
  assert.ok(start > 0, 'should find QuickInviteModal');
  const modal = src.slice(start, src.indexOf('const lbl =', start));
  assert.match(modal, /function QuickInviteModal\(\{ rooms = \{\}, config, onClose, onSaved, onError \}\)/);
  assert.match(modal, /resolveRoomRent\(room, config\)/,
    'quick-invite rent must use the same formula-or-override resolver as billing');
  assert.match(modal, /const roomList = useMemo\(\(\) => Object\.values\(rooms \|\| \{\}\)/,
    'modal must derive room list from inventory');
  assert.match(modal, /const availableRooms = useMemo\(\(\) => roomList\.filter/,
    'modal must derive available rooms');
  assert.match(modal, /String\(r\.status \|\| 'vacant'\) === 'vacant' && !r\.tenant/,
    'modal must only offer vacant rooms with no tenant');
  assert.match(modal, /<select style=\{inp\} value=\{form\.roomId\}/,
    'room field should become a select when inventory exists');
  assert.match(modal, /onChange=\{\(e\) => setRoomId\(e\.target\.value\)\}/,
    'choosing a room must run the default-fill handler');
  assert.match(modal, /monthlyRent: Number\.isFinite\(rent\) && rent > 0 \? String\(rent\)/,
    'room rent should auto-fill monthlyRent');
  assert.match(modal, /String\(rent \* 2\)/,
    'missing room deposit should fall back to 2x rent');
  assert.match(modal, /&& roomAvailable/,
    'submit must be disabled when selected room is not available');
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
  assert.match(src, /ALTER TABLE contracts ADD COLUMN IF NOT EXISTS terms_template_snapshot JSONB/);
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

test('contract invite links are sent or surfaced with delivery status', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /function contractInvitationDeliveryText/,
    'server must build a tenant-facing contract invitation message');
  assert.match(src, /async function tryNotifyTenantContractInvitation/,
    'server must centralize best-effort invitation delivery');
  const block = src.match(/app\.post\('\/api\/contracts\/:id\/invite-tenant'[\s\S]+?\/\/ GET \/api\/admin\/contract-invitations/)[0];
  assert.match(block, /LEFT JOIN tenants t ON t\.id = c\.tenant_id/,
    'invite-tenant should load tenant contact details in the same lookup');
  assert.match(block, /tryNotifyTenantContractInvitation/,
    'invite-tenant should attempt LINE/email/SMS delivery after link creation');
  assert.match(block, /res\.json\(\{[\s\S]{0,120}delivery,[\s\S]{0,180}invitation:/,
    'invite-tenant response must tell the UI whether auto-delivery happened');
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
  assert.match(block, /WHERE id=\$1 AND deleted_at IS NULL AND locked_at IS NULL/,
    'approve handler must refuse stale approvals against already-locked contracts');
  assert.match(block, /loadContractTermsSnapshot\(client, cLock\.rows\[0\]\)/,
    'approve handler must freeze the effective terms template before locking');
  assert.match(block, /terms_template_snapshot=\$3::jsonb/,
    'approve handler must persist the immutable PDF terms snapshot');
  assert.match(block, /agreed_terms_at = COALESCE\(agreed_terms_at, NOW\(\)\)/,
    'approve handler must stamp agreed_terms_at when a signature is accepted');
  assert.match(block, /tenant-fill-v1/,
    'approve handler must default a terms version for public tenant signatures');
  assert.match(block, /status='approved'/, 'approve handler must flip status');
  // Dedup escape: when applying tenant's draft, the partial unique on
  // citizen_id_hash can fire — must be mapped to a clean 409.
  assert.match(block, /uq_tenants_citizen_id_hash_active/);
  assert.match(block, /CITIZEN_ID_DUPLICATE/);
});

test('approve preflight blocks incomplete tenant submissions before locking', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const approveBlock = src.match(/\/approve'[\s\S]+?app\.post\('\/api\/admin\/contract-invitations\/:id\/reject'/);
  assert.ok(approveBlock, 'approve handler must be present');
  const block = approveBlock[0];
  assert.match(src, /function validateContractApprovalDraft/);
  assert.match(block, /validateContractApprovalDraft\(draft\)/);
  assert.match(block, /CONTRACT_APPROVAL_PRECHECK_FAILED/);
  assert.match(block, /draftIssues\.map\(\(x\) => x\.consequence\)/);
  assert.match(src, /signatureFileId/);
  assert.match(src, /citizenIdImageFrontId/);
  assert.match(src, /citizenIdImageBackId/);
});

test('approve preflight blocks invalid contract targets before tenant-room sync', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const approveBlock = src.match(/\/approve'[\s\S]+?app\.post\('\/api\/admin\/contract-invitations\/:id\/reject'/);
  assert.ok(approveBlock, 'approve handler must be present');
  const block = approveBlock[0];
  assert.match(src, /function validateContractApprovalTarget/);
  assert.match(block, /validateContractApprovalTarget\(inv, cLock\.rows\[0\]\)/);
  assert.match(block, /CONTRACT_APPROVAL_TARGET_INVALID/);
  assert.match(src, /CONTRACT_TENANT_MISMATCH/);
  assert.match(src, /CONTRACT_RENT_INVALID/);
});

test('contract admin lists expire stale pending invites and return warnings', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /function expirePendingContractInvitations/);
  assert.match(src, /status='expired'[\s\S]{0,200}status='pending'/);
  assert.match(src, /await expirePendingContractInvitations\(pool\)/);
  assert.match(src, /function buildContractWarnings/);
  assert.match(src, /TENANT_ROOM_MISMATCH/);
  assert.match(src, /CONTRACT_IDENTITY_INCOMPLETE/);
  assert.match(src, /LOCKED_CONTRACT_MISSING_TERMS_SNAPSHOT/);
  assert.match(src, /warning_severity: contractWarningSeverity\(warnings\)/);
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
  // PUT + upload + submit must each guard with NOT_EDITABLE when the
  // invitation status has progressed past 'pending'. Count occurrences
  // rather than requiring textual adjacency — the error messages diverged
  // when we hardened friendly Thai copy per endpoint.
  const count = (src.match(/'NOT_EDITABLE'/g) || []).length;
  assert.ok(count >= 3,
    `NOT_EDITABLE must guard PUT + upload + submit (found ${count}, need ≥ 3)`);
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

test('public fill: uploads are persisted into draft before submit can race', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const uploadBlock = src.match(/\/upload'[\s\S]+?\/\/ POST \/api\/contract-fill\/:token\/submit/);
  assert.ok(uploadBlock, 'upload handler must be present');
  const block = uploadBlock[0];
  assert.match(block, /jsonb_build_object\(\$2::text, \$3::int\)/,
    'upload handler must merge the new file id into invitation draft atomically');
  assert.match(block, /RETURNING draft/,
    'upload response must return the persisted draft');
  assert.match(block, /storage\.remove\(pool, out\.id\)/,
    'upload handler must clean up the saved file if draft persistence fails');
  assert.match(block, /storage\.remove\(pool, previousFileId\)/,
    'upload handler must clean up replaced files after a successful replacement');
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

test('admin UI: contract review shows approval consequences and disables incomplete approvals', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-contract-invitations.jsx'), 'utf8');
  assert.match(page, /function approvalPrecheckWarnings/);
  assert.match(page, /approvalWarnings\.length/);
  assert.match(page, /disabled=\{busy \|\| approvalWarnings\.length > 0\}/);
  assert.match(page, /ถ้าฝืนอนุมัติ/);
  assert.match(page, /ผลที่จะเกิดขึ้น/);
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
  assert.match(src, /setResult\(d\)/,
    'InviteTenantModal must keep the full response so delivery status is not lost');
  assert.match(src, /inviteDeliverySummary\(result\.delivery\)/,
    'InviteTenantModal must display auto-delivery status');
  // Surface "show only once" warning so admin doesn't lose the URL
  assert.match(src, /แสดงครั้งเดียว/);
  // Copy-to-clipboard
  assert.match(src, /navigator\.clipboard\.writeText/);
});

test('contracts page displays server-side contract warnings', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-contracts.jsx'), 'utf8');
  assert.match(src, /counts\.warnings/);
  assert.match(src, /Array\.isArray\(c\.warnings\)/);
  assert.match(src, /c\.warning_severity === 'error'/);
  assert.match(src, /w\.consequence/);
});

test('contracts edit modal keeps locked contracts closable without material edits', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-contracts.jsx'), 'utf8');
  const block = src.match(/function ContractEditModal[\s\S]+?function QuickInviteModal/);
  assert.ok(block, 'ContractEditModal must exist');
  assert.match(block[0], /const isLocked = !!contract\.locked_at/);
  assert.match(block[0], /if \(!isLocked && !closingRequested\) \{[\s\S]{0,500}payload\.discountPct/);
  assert.match(block[0], /if \(form\.status !== original\.status\) payload\.status = form\.status/);
  assert.match(block[0], /disabled=\{materialDisabled\}/,
    'locked contracts must disable material term inputs');
  assert.match(block[0], /disabled=\{busy \|\| !canSave\}/,
    'save button should be disabled until a valid change is present');
});

test('contracts edit modal requires close type and reason before closing', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-contracts.jsx'), 'utf8');
  const block = src.match(/function ContractEditModal[\s\S]+?function QuickInviteModal/);
  assert.ok(block, 'ContractEditModal must exist');
  assert.match(block[0], /closingRequested/);
  assert.match(block[0], /closeReasonReady/);
  assert.match(block[0], /payload\.closeType = form\.closeType/);
  assert.match(block[0], /payload\.closeReason = closeReason/);
  assert.match(block[0], /disabled=\{materialDisabled\}/);
  assert.match(block[0], /contract \+ audit log/);
});

test('tenant contract cancel UI uses checkout cascade for early move-out', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-tenants.jsx'), 'utf8');
  const block = src.match(/const cancelContract = async \(\) => \{[\s\S]+?const rejectSubmitted/);
  assert.ok(block, 'tenant cancelContract handler must exist');
  assert.match(block[0], /apiCall\(`\/api\/tenants\/\$\{tenantDbId\}\/checkout`/,
    'tenant-page contract cancel should use checkout when tenantDbId is known');
  assert.match(block[0], /generateClosingBill: true/,
    'early move-out should generate a closing bill by default');
  assert.match(block[0], /apiCall\(`\/api\/contracts\/\$\{contract\.id\}`[\s\S]{0,260}closeType: 'early_move_out'/,
    'legacy rows without tenantDbId should still close the contract with an explicit type');
  assert.match(block[0], /closeReason: reason/,
    'cancel reason must flow into the close audit trail');
  assert.match(block[0], /reason\.length < 5/,
    'tenant-page cancellation must require a useful audit reason before submit');
  assert.match(block[0], /window\.toastError\(setToast, err, \{ action: 'ยกเลิกสัญญา' \}\)/,
    'tenant-page cancellation must render structured API errors instead of a generic message');
});

test('contracts page hides manual signing for locked contracts', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-contracts.jsx'), 'utf8');
  assert.match(src, /c\.status === 'active' && !c\.signed_at && !c\.locked_at[\s\S]{0,120}setSigning\(c\)/,
    'locked contracts must not offer manual signature replacement');
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

test('public contract-fill submit sends the just-uploaded signature id', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'project', 'contract-fill.html'), 'utf8');
  assert.match(html, /const submit = async \(draftOverride = null\)/,
    'submit must accept an override draft from the signature step');
  assert.match(html, /body: draftOverride \|\| draft/,
    'submit must post the override draft when supplied');
  assert.match(html, /if \(hasInk\)[\s\S]{0,120}saveSignature\(\)/,
    'redrawing the signature must upload a fresh signature even when an old id exists');
  assert.match(html, /signatureFileId: sigId/,
    'submit override must carry the newly uploaded signature id');
  assert.match(html, /agreedTermsVersion: draft\.agreedTermsVersion \|\| 'tenant-fill-v1'/,
    'submit override must carry a durable terms version');
  assert.match(html, /\(!hasInk && !draft\.signatureFileId\)/,
    'existing saved signatures must allow submit after page reload');
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
  // (POST /api/tenants moved to routes/tenant-ops.js in round 9.)
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
  assert.match(src,
    /WHERE citizen_id_tail=\$1 AND deleted_at IS NULL AND status='active'/,
    'tail-fallback dedup query must exist');
  // Sanity: the dedup branch must trigger when citizenIdNorm is set, not
  // gated on citizenHash existing.
  assert.match(src, /if \(citizenIdNorm && b\.force !== true\)/,
    'dedup precondition must be on the normalised id, not the hash');
});

test('tenant create with room atomically claims room in tenants + room stores', () => {
  // The tenants page can create a tenant and pick a room in one modal. That
  // must not leave tenants.current_room_id set while rooms_v2 / the legacy
  // rooms blob still say the room is vacant, or booking/contract flows can
  // double-assign the room after reload.
  // (Endpoints moved to routes/tenant-ops.js in round 9; pattern adapted
  // to the router form r.post('/') ... r.put('/:id') with mount path stripped.)
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
  const block = src.match(/r\.post\('\/'[\s\S]+?r\.put\('\/:id'/)[0];
  assert.match(block, /pg_advisory_xact_lock\(\$1::int, \$2::int\)/,
    'room assignment must be serialized per room');
  assert.match(block,
    /SELECT id, full_name FROM tenants[\s\S]{0,350}current_room_id=\$1[\s\S]{0,200}FOR UPDATE/,
    'must lock and reject existing active occupants');
  assert.match(block, /ROOM_OCCUPIED/,
    'must return a clear occupied-room code');
  assert.match(block, /SELECT value FROM app_data WHERE key='baankarn_rooms_v1' FOR UPDATE/,
    'legacy room blob must be locked before writing room.tenant');
  assert.match(block,
    /value = value \|\| jsonb_build_object\([\s\S]{0,450}'status', 'occupied'[\s\S]{0,220}'tenant', \$2::jsonb/,
    'legacy room blob must get status=occupied + tenant details');
  assert.match(block, /UPDATE rooms_v2 SET status='occupied', updated_at=NOW\(\)/,
    'rooms_v2 must be flipped to occupied too');
  assert.match(block, /requestedRoomId[\s\S]{0,100}tenantStatus[\s\S]{0,120}'active'/,
    'assigning a room must force the tenant row to active');
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

test('admin UI: contract template variables insert by button instead of manual tokens', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-contract-templates.jsx'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const pdf = fs.readFileSync(path.join(__dirname, '..', 'services', 'contractPdf.js'), 'utf8');

  assert.match(pdf, /SYSTEM_VARIABLES = Object\.freeze/,
    'renderer must expose a canonical variable list');
  assert.match(server, /systemVariables: contractPdf\.SYSTEM_VARIABLES/,
    'contract-template APIs must return the canonical variable list');
  assert.match(page, /const \[systemVariables, setSystemVariables\]/,
    'admin page must store variables from the API');
  assert.match(page, /function ClauseVariablePicker/,
    'clause editor must render a clickable variable picker');
  assert.match(page, /selectionStart[\s\S]{0,1200}setSelectionRange/,
    'clicking a variable must insert at the textarea cursor');
  assert.match(page, /placeholderFor\(key\)/,
    'UI must build {{variable}} tokens for admin instead of requiring manual typing');
  assert.match(page, /COMMON_SYSTEM_VARIABLE_KEYS = new Set\([\s\S]{0,120}'lessorName'[\s\S]{0,80}'tenantName'[\s\S]{0,80}'roomId'/,
    'common buttons must include lessor, tenant, and room variables');
  assert.match(page, /CUSTOM_VARIABLE_PRESETS = Object\.freeze/,
    'custom variables should have preset buttons for common dorm settings');
  assert.match(page, /VariableReferencePanel/,
    'variables tab must show a click/copy reference panel');
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

test('admin UI: contract templates can be opened in read-only detail view', () => {
  // Admin asked to click and inspect what a dorm contract template contains
  // before editing/setting default. The list row needs an explicit view
  // action and a modal that displays the resolved clauses from the GET
  // single-template endpoint.
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'project', 'admin', 'page-contract-templates.jsx'), 'utf8');
  assert.match(page, /const \[viewing, setViewing\]/,
    'page must track the template detail modal state');
  assert.match(page, /const openDetails = async \(tpl\)/,
    'page must load template details on demand');
  assert.match(page, /\/api\/admin\/contract-templates\/\$\{tpl\.id\}/,
    'detail action must call the single-template endpoint');
  assert.match(page, /function TemplateDetailsModal/,
    'read-only detail modal must exist');
  assert.match(page, /const resolvedClauseCount = \(tpl\)/,
    'template list must show effective clause count, not only custom clauses');
  assert.match(page, /ข้อสัญญาที่ใช้จริง/,
    'detail modal must show the resolved clause list admin will actually use');
  assert.match(page, /onClick=\{\(\) => openDetails\(t\)\}>ดู<\/Btn>/,
    'template list must expose a visible ดู button');
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

test('migration seeds a visible standard dorm contract template', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrate.js'), 'utf8');
  assert.match(src, /require\('\.\.\/services\/contractPdf'\)/,
    'migration must reuse the canonical DEFAULT_CLAUSES');
  assert.match(src, /สัญญาหอพักมาตรฐาน/,
    'standard dorm contract template must be seeded');
  assert.match(src, /JSON\.stringify\(contractPdf\.DEFAULT_CLAUSES\)/,
    'seeded template must contain the full baseline clauses, not an empty default-mode row');
  assert.match(src, /created_by='system'/,
    'seed must be idempotent by system-created standard row');
  assert.match(src, /promoted standard dorm contract template to default/,
    'if no default exists, migration must promote the standard template');
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

test('locked contracts use immutable terms snapshot for PDFs and edits are blocked', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /async function loadContractTermsSnapshot/,
    'server must define the terms snapshot builder');
  assert.match(src, /snapshotVersion: 'contract-terms-snapshot-v1'/,
    'snapshot should carry an explicit schema marker');
  const snapIdx = src.indexOf('async function loadContractTermsSnapshot');
  const snapBody = src.slice(snapIdx, src.indexOf('// --- Schema migration', snapIdx));
  assert.doesNotMatch(snapBody, /req\.skipTenantAck/,
    'contract terms snapshot builder must not reference request-scoped slip-upload flags');
  assert.match(src, /contract\.locked_at && contract\.terms_template_snapshot[\s\S]{0,120}template = contract\.terms_template_snapshot/,
    'PDF endpoints must prefer the immutable snapshot for locked contracts');
  assert.match(src, /PDF template override is disabled/,
    'admin PDF template overrides must be refused after lock');
  assert.match(src, /materialEditRequested[\s\S]{0,1800}current\.locked_at/,
    'material contract edits must check locked_at under row lock');
  assert.match(src, /contract is locked; material terms cannot be edited/,
    'locked contracts must reject material term edits');
  assert.match(src, /contract is locked; template cannot be changed/,
    'locked contracts must reject template reassignment');
  assert.match(src, /contract is locked; signature cannot be changed/,
    'locked contracts must reject signature replacement');
  assert.match(src, /AND locked_at IS NULL[\s\S]{0,120}AND \(status='active' OR \$5::boolean\)/,
    'contract signing update must re-check locked_at atomically');
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
  // Moved to routes/tenant-ops.js in round 9.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
  assert.match(src, /r\.get\('\/:id\/history'/,
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
  // Endpoint moved to routes/tenant-ops.js in round 9. The /:id(\d+) numeric
  // constraint still guarantees /lookup-by-citizen-id can't be swallowed
  // by the param route — express also respects the route registration
  // order, and we registered /lookup-by-citizen-id BEFORE /:id(\d+).
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
  assert.match(src, /r\.get\('\/lookup-by-citizen-id'/,
    'lookup endpoint must exist');
  assert.match(src, /r\.get\('\/:id\(\\\\d\+\)'/,
    'numeric tenant detail route must not swallow /lookup-by-citizen-id');
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
  // Identity endpoint moved to routes/tenant-ops.js in round 9.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
  assert.match(src,
    /existingFrontId && existingFrontId !== frontFile\.id[\s\S]{0,300}storage\.remove\(pool, existingFrontId\)/,
    'old front file must be removed on replace');
  assert.match(src,
    /existingBackId && existingBackId !== backFile\.id[\s\S]{0,300}storage\.remove\(pool, existingBackId\)/,
    'old back file must be removed on replace');
});

test('identity + contract sign owner-notify (legal trail)', () => {
  // Identity endpoint lives in routes/tenant-ops.js; contract sign stays
  // in server.js. Assert each against its home file.
  const fs = require('node:fs');
  const path = require('node:path');
  const ops = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(ops, /📇 บันทึกบัตรประชาชน[\s\S]{0,200}tenant id=/,
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
  // POST /api/tenants moved to routes/tenant-ops.js in round 9.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
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

test('LINE notifications validate userId shape before push or queue retry', () => {
  // INVALID_LINE_USER_ID was raised by POST/PUT /api/tenants in server.js;
  // those endpoints moved to routes/tenant-ops.js in round 9, so we assert
  // the code surface there.
  const fs = require('node:fs');
  const path = require('node:path');
  const line = fs.readFileSync(path.join(__dirname, '..', 'services', 'line.js'), 'utf8');
  const notifier = fs.readFileSync(path.join(__dirname, '..', 'services', 'notifier.js'), 'utf8');
  const queue = fs.readFileSync(path.join(__dirname, '..', 'services', 'notificationQueue.js'), 'utf8');
  const tenantOps = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8');
  const scheduler = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
  assert.match(line, /function isLikelyUserId/);
  assert.match(line, /if \(!isLikelyUserId\(userId\)\) return false/);
  assert.match(notifier, /invalid owner LINE userId shape/);
  assert.match(notifier, /invalid LINE userId shape/);
  assert.match(queue, /invalid LINE recipient/);
  assert.match(tenantOps, /INVALID_LINE_USER_ID/);
  assert.match(scheduler, /lineNotify\.isLikelyUserId\(t\.line_user_id\)/);
});
