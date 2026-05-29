// tests/security-fixes.test.js
// Regression guards for the correctness/security fixes applied in this pass.
// Behavioral coverage for the two biggest fixes lives in ssrfGuard.test.js and
// billing.test.js (timezone). The handlers below live in server.js (which
// can't be required without booting app.listen) and in routers whose full HTTP
// pipeline is heavy to stand up, so — matching this repo's existing convention
// (integration.test.js pins SHAPE via source assertions) — these pin that each
// guard is present and correctly wired so a future edit can't silently drop it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const server = read('server.js');

test('GET /api/bookings/:id strips citizen-ID image for non-owner/manager', () => {
  const idx = server.indexOf("app.get('/api/bookings/:id'");
  assert.ok(idx > 0, 'bookings detail handler present');
  const block = server.slice(idx, idx + 3000);
  assert.match(block, /viewerRole !== 'owner' && viewerRole !== 'manager'/,
    'must role-gate the citizen-ID image');
  assert.match(block, /citizen_id_image_front_url/, 'must target the front image url');
  assert.match(block, /delete booking\[k\]/, 'must delete the sensitive keys from the response');
});

test('GET /api/notifications/log is owner/manager only', () => {
  assert.match(
    server,
    /app\.get\(\s*'\/api\/notifications\/log',\s*requireAuth,\s*requireRole\('owner',\s*'manager'\)/,
    'notifications log must require owner/manager, not just requireAuth');
});

test('DELETE /api/data production-data guard fails CLOSED on DB error', () => {
  const idx = server.indexOf("app.delete('/api/data/:key'");
  assert.ok(idx > 0, 'data DELETE handler present');
  const block = server.slice(idx, idx + 2500);
  assert.match(block, /PRODUCTION_DATA_CHECK_FAILED/, 'must surface a check-failed code');
  assert.match(block, /res\.status\(503\)/, 'must refuse (503) when the guard query throws');
  // The old fail-open behavior just warned and fell through to DELETE.
  assert.doesNotMatch(block, /production-data check skipped/,
    'must not silently skip the guard and delete');
});

test('POST /api/meters/:roomId/readings rejects unknown rooms', () => {
  const idx = server.indexOf("app.post('/api/meters/:roomId/readings'");
  assert.ok(idx > 0, 'meter readings handler present');
  const block = server.slice(idx, idx + 2000);
  assert.match(block, /ROOM_NOT_FOUND/, 'must 404 unknown rooms');
  assert.match(block, /rooms_v2 WHERE room_code=\$1/, 'must check rooms_v2');
  assert.match(block, /baankarn_rooms_v1' AND value \? \$1/, 'must also check the legacy blob');
});

test('POST /api/bills enforces total = subtotal + vat + late_fee invariant', () => {
  const bills = read('routes', 'bills-extras.js');
  assert.match(bills, /BILL_TOTAL_MISMATCH/, 'must reject inconsistent totals');
  assert.match(bills, /subtotalAmount \+ vatN \+ lateN/, 'invariant must sum the parts');
  assert.match(bills, /relying on ledger invariant/,
    'missing-room recompute-skip must note the invariant still guards it');
});

test('LINE webhook rejects requests with no raw body (no JSON.stringify fallback)', () => {
  const wh = read('routes', 'webhooks.js');
  assert.match(wh, /NO_RAW_BODY/, 'must reject when rawBody is absent');
  assert.match(wh, /const raw = req\.rawBody;/, 'must use the captured raw bytes only');
  assert.doesNotMatch(wh, /req\.rawBody \|\| JSON\.stringify/,
    'must not HMAC a re-stringified body');
});

test('features.deepMerge guards against prototype pollution', () => {
  const feat = read('services', 'features.js');
  const idx = feat.indexOf('function deepMerge');
  const block = feat.slice(idx, idx + 600);
  assert.match(block, /__proto__'[\s\S]{0,60}continue/,
    'deepMerge must skip __proto__/constructor/prototype');
  // Behavioral: merging a polluting key must not touch Object.prototype.
  const features = require('../services/features');
  features.withDefaults(JSON.parse('{"__proto__":{"pwned":1}}'));
  assert.equal(({}).pwned, undefined, 'Object.prototype must stay clean');
});

test('notification queue bounds each dispatch with a timeout', () => {
  const q = read('services', 'notificationQueue.js');
  assert.match(q, /DISPATCH_TIMEOUT_MS/, 'must define a per-dispatch timeout');
  assert.match(q, /withTimeout\(\s*[\s\S]{0,40}dispatch\(pool, features, row\)/,
    'processOne must wrap dispatch in the timeout');
});

test('cashflow projection uses the recent 90-day SUM, not all-time avg × count', () => {
  const reports = read('routes', 'reports.js');
  assert.match(reports, /recent_sum/, 'must sum recent paid revenue');
  assert.match(reports, /Number\(a\.recent_sum\) \|\| 0\) \/ 3/, 'monthly est = recent_sum / 3');
  assert.doesNotMatch(reports, /avg_per_bill\) \|\| 0\) \* \(a\.recent_count/,
    'must not mix all-time average with recent count');
});

test('slipVerifier amount cross-check rejects a non-finite slip amount (no NaN bypass)', () => {
  const sv = read('services', 'slipVerifier.js');
  assert.match(sv, /!Number\.isFinite\(slipAmt\)\s*\|\|\s*!Number\.isFinite\(expAmt\)/,
    'amount check must require both amounts finite, not rely on Math.abs(NaN) > tol');
  assert.doesNotMatch(sv, /Math\.abs\(Number\(result\.amount\) - Number\(expected\.amount\)\) > PAYMENT_TOLERANCE_THB/,
    'the old NaN-skippable comparison must be gone');
});

test('quick-invite contract number uses a CSPRNG, not Math.random', () => {
  const idx = server.indexOf('const contractNo = `C-${new Date().getFullYear()}');
  assert.ok(idx > 0, 'quick-invite contractNo present');
  const block = server.slice(idx, idx + 220);
  assert.match(block, /require\('crypto'\)\.randomBytes\(\d\)\.toString\('hex'\)/,
    'contract number suffix must come from crypto.randomBytes');
  assert.doesNotMatch(block, /Math\.random\(\)\.toString\(36\)/,
    'must not use Math.random for the contract number');
});
