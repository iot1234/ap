// tests/adminBooking.test.js
// Admin books on a customer's behalf (walk-in / phone booking) via
// POST /api/bookings — flexibility AND the same protections as the public
// form. Pins:
//   - schema shape (phone required, months bounds, deposit attestation)
//   - the endpoint reuses the public path's locks + room guards
//   - blacklist / duplicate refusals exist at the door
//   - the reservation uses its own mode and is NEVER swept by the
//     public-hold expiry sweeper
//   - dual-write into relational bookings with source='admin-manual'
//   - admin UI + live-poll integration
//   node --test tests/adminBooking.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { schemas } = require('../schemas');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// === Schema behaviour =======================================================

test('adminBooking schema: accepts a typical walk-in payload + normalises phone', () => {
  const out = schemas.adminBooking.parse({
    tenantName: '  สมชาย ใจดี ',
    phone: '081-234-5678',
    roomId: '203',
    checkInDate: '2026-07-01',
    months: '12',
    depositCollected: true,
    depositPaymentMethod: 'cash',
  });
  assert.equal(out.tenantName, 'สมชาย ใจดี');
  assert.equal(out.phone, '0812345678', 'dashes/spaces must be stripped');
  assert.equal(out.months, 12, 'months must coerce to int');
  assert.equal(out.depositCollected, true);
});

test('adminBooking schema: phone is REQUIRED (dedup/blacklist checks need it)', () => {
  assert.throws(() => schemas.adminBooking.parse({ tenantName: 'A' }));
  assert.throws(() => schemas.adminBooking.parse({ tenantName: 'A', phone: 'abc' }));
});

test('adminBooking schema: months bounded 1-60, roomType whitelisted', () => {
  assert.throws(() => schemas.adminBooking.parse({ tenantName: 'A', phone: '0812345678', months: 0 }));
  assert.throws(() => schemas.adminBooking.parse({ tenantName: 'A', phone: '0812345678', months: 61 }));
  assert.throws(() => schemas.adminBooking.parse({ tenantName: 'A', phone: '0812345678', roomType: 'penthouse' }));
  const ok = schemas.adminBooking.parse({ tenantName: 'A', phone: '0812345678', roomType: 'deluxe', floor: 2 });
  assert.equal(ok.roomType, 'deluxe');
  assert.equal(ok.floor, '2', 'floor coerces to string for the want-filter');
});

test('adminBooking schema: empty-string optionals normalise to undefined', () => {
  const out = schemas.adminBooking.parse({
    tenantName: 'A', phone: '0812345678', roomId: '', email: '', checkInDate: '',
  });
  assert.equal(out.roomId, undefined);
  assert.equal(out.email, undefined);
  assert.equal(out.checkInDate, undefined);
});

// === Endpoint guards ========================================================

test('POST /api/bookings exists, staff-allowed, schema-validated, CSRF-guarded', () => {
  const server = read('server.js');
  assert.match(server,
    /app\.post\('\/api\/bookings', sameOrigin, csrfGuard, requireAuth,\s*requireRole\('owner', 'manager', 'staff'\), validateBody\(schemas\.adminBooking\)/,
    'admin create endpoint must run the full write pipeline');
});

test('admin booking endpoint refuses blacklisted phones at the door', () => {
  const server = read('server.js');
  const idx = server.indexOf("app.post('/api/bookings',");
  assert.ok(idx > 0);
  const body = server.slice(idx, idx + 22_000);
  assert.match(body, /status='blacklist'/,
    'must look up blacklisted tenants by phone');
  assert.match(body, /TENANT_BLACKLISTED/,
    'must refuse with the same code the approve paths use');
});

test('admin booking endpoint blocks duplicate open bookings (same phone+room)', () => {
  const server = read('server.js');
  const idx = server.indexOf("app.post('/api/bookings',");
  const body = server.slice(idx, idx + 22_000);
  assert.match(body, /DUPLICATE_BOOKING/,
    'double-submit must be refused, not silently double-reserved');
  assert.match(body, /\['pending', 'reviewing', 'approved'\]/,
    'only OPEN bookings count as duplicates — cancelled/rejected do not block rebooking');
});

test('admin booking reserves the room under the same locks as the public path', () => {
  const server = read('server.js');
  const idx = server.indexOf("app.post('/api/bookings',");
  const body = server.slice(idx, idx + 22_000);
  assert.match(body, /SELECT value FROM app_data WHERE key=\$1 FOR UPDATE/,
    'bookings blob must be locked');
  assert.match(body, /SELECT value FROM app_data WHERE key='baankarn_rooms_v1' FOR UPDATE/,
    'rooms blob must be locked in the same transaction');
  assert.match(body, /isVacantStatus\(room\.status\) && \(!v2Room \|\| isVacantStatus\(v2Room\.status\)\)/,
    'room must be vacant in BOTH the blob and rooms_v2');
  assert.match(body, /reservationMode: 'admin_booking'/,
    'admin reservations carry their own mode');
  assert.match(body, /UPDATE rooms_v2 SET status='reserved'[\s\S]{0,120}status='vacant'/,
    'rooms_v2 reservation must compare-and-swap from vacant');
  assert.match(body, /releaseExpiredPublicBookingHolds\(client\)/,
    'expired public holds must be released before the vacancy check');
});

test('admin reservation is NOT sweepable by the public-hold expiry sweeper', () => {
  const server = read('server.js');
  // The sweeper only releases rooms whose reservedBy starts with 'hold:' —
  // pin that so a future refactor can't accidentally release admin/booking
  // reservations on a timer.
  assert.match(server, /reservedBy\.startsWith\('hold:'\)/,
    'isPublicHoldRoom must remain hold-token scoped');
});

test('admin booking dual-writes relational row with source=admin-manual + legacy fallback', () => {
  const server = read('server.js');
  const idx = server.indexOf("app.post('/api/bookings',");
  const body = server.slice(idx, idx + 22_000);
  assert.match(body, /'pending','admin-manual'/,
    'relational row must record the admin source');
  assert.match(body, /ON CONFLICT \(external_id\) DO NOTHING/,
    'dual-write must stay idempotent');
  const fallbacks = body.match(/'admin-manual'/g) || [];
  assert.ok(fallbacks.length >= 2,
    'legacy-deploy column fallback insert must exist too');
  assert.match(body, /list\.slice\(0, 500\)/,
    'blob must stay capped at 500 entries');
  assert.match(body, /audit\(req, 'booking\.create', 'booking', bookingId/,
    'creation must be audit-logged');
});

test('deposit attestation maps to the states the approve checklist understands', () => {
  const server = read('server.js');
  const idx = server.indexOf("app.post('/api/bookings',");
  const body = server.slice(idx, idx + 22_000);
  assert.match(body, /depositStatus: depositCollected \? 'verified' : 'not_required'/,
    "collected → 'verified', not collected → 'not_required' (never the stuck 'awaiting_slip')");
  assert.match(body, /depositVerifyProvider: depositCollected \? 'manual' : null/,
    'manual provider marks an admin attestation, not a slip verification');
});

// === UI integration =========================================================

test('bookings page gets a create modal that POSTs the admin endpoint', () => {
  const page = read('project', 'admin', 'page-bookings.jsx');
  assert.match(page, /function CreateBookingModal/,
    'create modal must exist');
  assert.match(page, /apiCall\('\/api\/bookings', \{\s*method: 'POST'/,
    'modal must POST the admin endpoint (NOT write the blob from the client)');
  assert.match(page, /จองให้ลูกค้า/,
    'header must offer the create action');
  assert.match(page, /แอดมินจอง/,
    'admin-created bookings must be visually tagged');
  assert.match(page, /VACANT_WORDS/,
    'room picker must list vacant rooms only');
});

test('shell live-poll merges admin-manual bookings from other tabs/devices', () => {
  const shell = read('project', 'admin', 'shell.jsx');
  assert.match(shell, /b\.source === 'public-form' \|\| b\.source === 'admin-manual'/,
    'poll merge must include colleague-created bookings');
});
