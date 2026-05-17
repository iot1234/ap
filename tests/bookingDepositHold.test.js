const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('roomBooking feature defaults define deposit and 15-minute hold policy', () => {
  const { DEFAULTS } = require('../services/features');
  assert.equal(DEFAULTS.roomBooking.enabled, true);
  assert.equal(DEFAULTS.roomBooking.requireDeposit, false);
  assert.equal(DEFAULTS.roomBooking.depositAmount, 500);
  assert.equal(DEFAULTS.roomBooking.requireSlip, true);
  assert.equal(DEFAULTS.roomBooking.holdMinutes, 15);
});

test('booking migration stores deposit slip and hold audit fields', () => {
  const migrate = read('db/migrate.js');
  for (const col of [
    'deposit_required',
    'booking_fee',
    'deposit_status',
    'deposit_slip_file_id',
    'deposit_slip_hash',
    'hold_token_hash',
    'hold_expires_at',
    'reserved_at',
  ]) {
    assert.match(migrate, new RegExp(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS ${col}`),
      `migration must add bookings.${col}`);
  }
  assert.match(migrate, /uq_bookings_deposit_slip_hash/,
    'booking deposit slip hash must be unique when present');
});

test('public booking schema accepts hold token and deposit slip', () => {
  const schema = read('schemas/index.js');
  assert.match(schema, /holdToken:\s*z\.string\(\)\.max\(200\)\.optional\(\)/,
    'public booking schema must accept a room hold token');
  assert.match(schema, /depositSlip:\s*z\.string\(\)\.min\(20\)\.max\(3_000_000\)\.optional\(\)/,
    'public booking schema must accept a bounded deposit slip data URL');
});

test('public booking supports expiring room holds before deposit submission', () => {
  const server = read('server.js');
  assert.match(server, /app\.post\('\/api\/bookings\/public\/hold'/,
    'public hold endpoint must exist');
  assert.match(server, /reservationExpiresAt: expiresAt\.toISOString\(\)/,
    'hold must stamp an expiry on the room reservation');
  assert.match(server, /reservedBy: `hold:\$\{tokenHash\}`/,
    'hold must store only the token hash, not the raw token');
  assert.match(server, /releaseExpiredPublicBookingHolds/,
    'expired holds must be releasable by shared cleanup');
  assert.match(server, /startBookingHoldSweeper/,
    'server must run a background sweeper for expired holds');
  assert.match(server, /setInterval\(sweep, 60 \* 1000\)/,
    'sweeper should run about once per minute');
});

test('public booking deposit requires a room, a slip, and deduplicates slips', () => {
  const server = read('server.js');
  assert.match(server, /ROOM_REQUIRED_FOR_BOOKING_DEPOSIT/,
    'deposit booking must require a specific room so it can lock the right room');
  assert.match(server, /BOOKING_DEPOSIT_SLIP_REQUIRED/,
    'deposit booking must require a slip when configured');
  assert.match(server, /SELECT id FROM payments WHERE slip_hash=\$1 LIMIT 1/,
    'booking deposit slip must be checked against payment slips');
  assert.match(server, /SELECT external_id FROM bookings WHERE deposit_slip_hash=\$1 LIMIT 1/,
    'booking deposit slip must be checked against prior booking slips');
  assert.match(server, /DUPLICATE_BOOKING_DEPOSIT_SLIP/,
    'duplicate booking deposit slip must return a stable error code');
  assert.match(server, /uploadedBy: `public-booking:\$\{bookingId\}`/,
    'booking deposit slip upload must be attributable to the booking id');
  assert.match(server, /reservationMode: bookingSettings\.requireDeposit \? 'public_booking_deposit' : 'public_booking'/,
    'successful booking must convert the hold into a real booking reservation');
});

test('rejected public booking reservations release their room lock', () => {
  const server = read('server.js');
  assert.match(server, /shouldReleaseTerminalBookingRoom = \['cancelled', 'rejected'\]\.includes\(updated\.status\)/,
    'terminal rejected bookings must enter the same room-release path as cancellations');
  assert.match(server, /pending\/reviewing → rejected: public booking reservation is freed/,
    'the release path must document the public booking reservation case');
  assert.match(server, /room\.reservedBy === id/,
    'room release must still be guarded by reservedBy=booking id');
});

test('orphan slip cleanup preserves booking deposit slips', () => {
  const server = read('server.js');
  const scheduler = read('services/scheduler.js');
  assert.match(server, /b\.deposit_slip_file_id = file_uploads\.id/,
    'boot pruner must not delete slips referenced by booking deposits');
  assert.match(scheduler, /LEFT JOIN bookings b ON b\.deposit_slip_file_id = fu\.id/,
    'scheduler orphan-slip prune must join booking deposit slips');
  assert.match(scheduler, /AND b\.id IS NULL/,
    'scheduler must only prune slip files with no booking reference');
});

test('public booking page and admin features expose deposit controls', () => {
  const booking = read('project/booking.html');
  const features = read('project/admin/page-features.jsx');
  const adminBookings = read('project/admin/page-bookings.jsx');
  assert.match(booking, /\/api\/bookings\/public\/config/,
    'public page must load deposit config');
  assert.match(booking, /\/api\/bookings\/public\/hold/,
    'public page must create a room hold');
  assert.match(booking, /id="depositSlip"/,
    'public page must let the booker attach a deposit slip');
  assert.match(booking, /data\.holdToken = holdToken/,
    'public page must submit the hold token with the booking');
  assert.match(features, /<Row id="roomBooking"/,
    'admin features page must expose room booking settings');
  assert.match(features, /field="depositAmount"/,
    'admin must be able to set the booking deposit amount');
  assert.match(features, /field="holdMinutes"/,
    'admin must be able to set the room hold duration');
  assert.match(adminBookings, /depositStatusLabel/,
    'admin booking page must show booking deposit status');
  assert.match(adminBookings, /depositSlipUrl/,
    'admin booking detail must link the deposit slip when present');
});
