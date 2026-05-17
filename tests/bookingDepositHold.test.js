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
  assert.equal(DEFAULTS.roomBooking.minimumAmount, 0);
  assert.equal(DEFAULTS.roomBooking.applyBookingFeeToDeposit, false);
  assert.equal(DEFAULTS.roomBooking.requireSlip, true);
  assert.equal(DEFAULTS.roomBooking.holdMinutes, 15);
});

test('booking migration stores deposit slip and hold audit fields', () => {
  const migrate = read('db/migrate.js');
  for (const col of [
    'deposit_required',
    'booking_fee',
    'booking_fee_applies_to_deposit',
    'deposit_credit_amount',
    'deposit_balance_due',
    'deposit_minimum_amount',
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
  assert.match(migrate, /ALTER TABLE contracts ADD COLUMN IF NOT EXISTS booking_fee_credit/,
    'contracts must remember how much booking fee was credited to the deposit');
  assert.match(migrate, /ALTER TABLE contracts ADD COLUMN IF NOT EXISTS deposit_balance_due/,
    'contracts must remember the remaining security-deposit balance');
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
  assert.match(server, /bookingFeeAppliesToDeposit: bookingSettings\.applyBookingFeeToDeposit/,
    'booking rows must snapshot whether the booking fee is credited to contract deposit');
  assert.match(server, /depositMinimumAmount: bookingSettings\.minimumAmount/,
    'booking rows must snapshot the minimum booking-fee policy');
  assert.match(server, /depositCreditAmount = bookingSettings\.requireDeposit && bookingSettings\.applyBookingFeeToDeposit/,
    'public booking must estimate the deposit credit when the policy is enabled');
  assert.match(server, /function bookingDepositStatus\(settings, hasSlip\)/,
    'deposit status must be centralised so no-slip booking deposits get a clear state');
  assert.match(server, /settings\.requireSlip \? 'awaiting_slip' : 'manual_review'/,
    'when slips are optional, deposit bookings must be marked for manual review, not waiting for a slip');
  assert.match(server, /app\.get\('\/api\/admin\/booking-deposit-settings'/,
    'admin must have a dedicated booking deposit settings read endpoint');
  assert.match(server, /app\.put\('\/api\/admin\/booking-deposit-settings'[\s\S]{0,120}requireRole\('owner', 'manager'\)/,
    'dedicated booking deposit settings save must support owner and manager roles');
  assert.match(server, /parseRoomBookingEditableSettings/,
    'dedicated booking deposit settings must validate and normalize input before saving');
  assert.match(server, /bookingDepositAdminPaymentReadiness/,
    'admin settings page must preflight payment readiness before operators enable deposits');
  assert.match(server, /BOOKING_DEPOSIT_SETTINGS_INVALID/,
    'invalid booking deposit settings must return a stable error code');
  assert.match(server, /BOOKING_DEPOSIT_AMOUNT_REQUIRED/,
    'server must reject enabling deposits with an effective zero amount');
  assert.match(server, /BOOKING_DEPOSIT_HOLD_MINUTES_RANGE/,
    'server must guard the room hold duration range');
  assert.match(server, /BOOKING_DEPOSIT_MAX_BYTES_RANGE/,
    'server must guard the slip upload size range');
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

test('booking approval and contract handoff understand preclaimed deposit bookings', () => {
  const server = read('server.js');
  assert.match(server, /preclaimedCandidate/,
    'approval must accept a room already reserved by the same public booking');
  assert.match(server, /String\(candidateRoom\.reservedBy \|\| ''\) === id/,
    'preclaimed approval must still be guarded by reservedBy=booking id');
  assert.match(server, /bookingFeeCredit = creditToDeposit \? Math\.min\(bookingFee, Math\.max\(deposit, 0\)\) : 0/,
    'quick-invite must convert credited booking fees into a bounded deposit credit');
  assert.match(server, /booking_fee_credit, deposit_balance_due/,
    'quick-invite must persist deposit credit and remaining balance on contracts');
  assert.match(server, /deposit_credit_amount=\$3,[\s\S]{0,80}deposit_balance_due=\$4/,
    'booking completion must persist credited amount and balance for audit');
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
  const depositSettings = read('project/admin/page-booking-deposit-settings.jsx');
  const adminHtml = read('project/Admin Dashboard.html');
  const shell = read('project/admin/shell.jsx');
  const settings = read('project/admin/page-settings.jsx');
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
  assert.match(features, /field="minimumAmount"/,
    'admin must be able to set no minimum or a booking-fee minimum');
  assert.match(features, /field="applyBookingFeeToDeposit"/,
    'admin must be able to choose whether booking fee credits contract deposit');
  assert.match(features, /field="holdMinutes"/,
    'admin must be able to set the room hold duration');
  assert.match(adminHtml, /page-booking-deposit-settings\.jsx/,
    'admin dashboard must load the dedicated booking deposit settings page');
  assert.match(shell, /'booking-deposit-settings': window\.PageBookingDepositSettings/,
    'admin shell must route the dedicated booking deposit settings page');
  assert.match(shell, /id: 'booking-deposit-settings'/,
    'admin sidebar must expose a direct booking deposit settings entry');
  assert.match(settings, /bookingDeposit/,
    'settings hub must expose booking deposit settings as a first-class tab');
  assert.match(depositSettings, /function PageBookingDepositSettings/,
    'dedicated admin page must register a booking deposit settings component');
  assert.match(depositSettings, /\/api\/admin\/booking-deposit-settings/,
    'dedicated admin page must persist through the guarded booking deposit settings API');
  assert.doesNotMatch(depositSettings, /PUT'[\s\S]{0,120}\/api\/admin\/features/,
    'dedicated admin page must not bypass booking-deposit validation by saving directly to generic features');
  assert.match(depositSettings, /minimumAmount/,
    'dedicated admin page must expose the no-minimum or minimum booking-fee rule');
  assert.match(depositSettings, /applyBookingFeeToDeposit/,
    'dedicated admin page must expose the booking-fee-to-contract-deposit policy');
  assert.match(depositSettings, /bookingDepositEffectiveAmount/,
    'dedicated admin page must show the effective amount after minimum policy');
  assert.match(depositSettings, /maxBytes/,
    'dedicated admin page must expose the slip upload size limit');
  assert.match(booking, /applyBookingFeeToDeposit/,
    'public page must explain whether the booking fee is credited to deposit');
  assert.match(adminBookings, /depositStatusLabel/,
    'admin booking page must show booking deposit status');
  assert.match(adminBookings, /manual_review/,
    'admin booking page must label no-slip deposit bookings as manual review');
  assert.match(adminBookings, /depositSlipUrl/,
    'admin booking detail must link the deposit slip when present');
  assert.match(adminBookings, /depositBalanceDue/,
    'admin booking detail must show the remaining deposit balance');
});
