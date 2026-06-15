const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('roomBooking feature defaults define deposit and 15-minute hold policy', () => {
  const { DEFAULTS } = require('../services/features');
  assert.equal(DEFAULTS.roomBooking.enabled, true);
  assert.equal(DEFAULTS.roomBooking.openAt, null);
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
  for (const col of [
    'deposit_verify_provider',
    'deposit_verify_code',
    'deposit_verify_reason',
    'deposit_verify_attempts',
    'deposit_verified_at',
    'deposit_transaction_ref',
    'deposit_payment_method',
  ]) {
    assert.match(migrate, new RegExp(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS ${col}`),
      `migration must add bookings.${col}`);
  }
  assert.match(migrate, /uq_bookings_deposit_transaction_ref/,
    'booking deposit transaction reference must be unique when verifier returns one');
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
  assert.match(server, /const rateLimitBookingHold = makeIpLimiter\(\{[\s\S]{0,90}max: 12/,
    'room holds must allow normal room selection retries without exhausting booking submission quota');
  assert.match(server, /const rateLimitBookingSubmit = makeIpLimiter\(\{[\s\S]{0,110}max: 8/,
    'booking submission must have its own limiter instead of sharing the hold limiter');
  assert.match(server, /app\.post\('\/api\/bookings\/public\/hold', sameOrigin, rateLimitBookingHold/,
    'public hold endpoint must use the hold-specific limiter');
  assert.match(server, /app\.post\('\/api\/bookings\/public\/hold\/release', sameOrigin, rateLimitBookingHold/,
    'public hold release endpoint must let the browser free a held room when the booker changes room');
  assert.match(server, /BOOKING_HOLD_NOT_OWNED/,
    'hold release must be token-guarded and idempotent when the browser no longer owns the room');
  assert.match(server, /booking\.hold_release/,
    'explicit hold release must be audit logged');
  assert.match(server, /app\.post\('\/api\/bookings\/public', sameOrigin, rateLimitBookingSubmit/,
    'public booking submission must use the submit-specific limiter');
  assert.match(server, /retryAfterSeconds/,
    'rate-limited booking responses must tell the UI how long to wait before retrying');
  assert.match(server, /app\.get\('\/api\/bookings\/public\/rooms'/,
    'public booking page must have a safe vacant-room feed');
  assert.match(server, /disabledNotice: openState\.enabled \? null : roomBookingDisabledPayload\(openState\)/,
    'public booking config must expose a clear disabled notice when online booking is closed');
  assert.match(server, /app\.get\('\/api\/bookings\/public\/rooms'[\s\S]{0,900}enabled: false[\s\S]{0,120}rooms: \[\][\s\S]{0,160}\.\.\.roomBookingDisabledPayload\(openState\)/,
    'public room feed must hide inventory and return a stable disabled code when booking is closed');
  assert.match(server, /ROOM_BOOKING_NOT_OPEN_YET/,
    'public booking schedule must return a stable not-open-yet code before opening time');
  assert.match(server, /return res\.status\(503\)\.json\(roomBookingDisabledPayload\([^)]*OpenState[^)]*\)\);/,
    'public hold and submit endpoints must block writes with the same disabled-booking response');
  assert.match(server, /function publicBookableRooms/,
    'public vacant-room feed must be centralized and testable');
  assert.match(server, /relationalStatus && !isVacantStatus\(relationalStatus\)/,
    'public vacant-room feed must not publish rooms that rooms_v2 marks unavailable');
  assert.match(server, /reservationExpiresAt: expiresAt\.toISOString\(\)/,
    'hold must stamp an expiry on the room reservation');
  assert.match(server, /reservedBy: `hold:\$\{tokenHash\}`/,
    'hold must store only the token hash, not the raw token');
  assert.match(server, /releaseExpiredPublicBookingHolds/,
    'expired holds must be releasable by shared cleanup');
  assert.match(server, /typeof dbOrClient\.release !== 'function'/,
    'expired-hold cleanup must not reconnect an already checked-out pg client inside hold/submit transactions');
  assert.match(server, /startBookingHoldSweeper/,
    'server must run a background sweeper for expired holds');
  assert.match(server, /setInterval\(sweep, 60 \* 1000\)/,
    'sweeper should run about once per minute');
});

test('public booking deposit requires a room, a slip, and deduplicates slips', () => {
  const server = read('server.js');
  assert.match(server, /ROOM_REQUIRED_FOR_BOOKING_DEPOSIT/,
    'deposit booking must require a specific room so it can lock the right room');
  assert.match(server, /BOOKING_HOLD_REQUIRED/,
    'deposit booking must require a server-issued hold token and not trust client-only room selection');
  assert.match(server, /BOOKING_DEPOSIT_SLIP_REQUIRED/,
    'deposit booking must require a slip when configured');
  assert.match(server, /settings\.requireDeposit && settings\.requireSlip && payment && payment\.ready === false/,
    'room holds should only block on missing payment setup when slip upload is required');
  assert.match(server, /bookingSettings\.requireSlip && bookingPayment && bookingPayment\.ready === false/,
    'manual-review booking deposits must not be blocked by missing payment setup');
  assert.match(server, /SELECT id FROM payments WHERE slip_hash=\$1 LIMIT 1/,
    'booking deposit slip must be checked against payment slips');
  assert.match(server, /SELECT external_id FROM bookings WHERE deposit_slip_hash=\$1 LIMIT 1/,
    'booking deposit slip must be checked against prior booking slips');
  assert.match(server, /DUPLICATE_BOOKING_DEPOSIT_SLIP/,
    'duplicate booking deposit slip must return a stable error code');
  assert.match(server, /slipVerifier\.verifyWithFallback/,
    'booking deposit slips must use the same auto-verifier as bill payments when configured');
  assert.match(server, /paymentBlockReceiverTargetEntries\(bookingPaymentBlock\)/,
    'booking deposit verification must accept the visible PromptPay, bank, or wallet receiver targets');
  assert.match(server, /depositVerificationStatus = bookingFlags\?\.slipUpload\?\.requireVerification/,
    'auto-verified booking deposits must respect the admin-confirmation setting');
  assert.match(server, /deposit_transaction_ref/,
    'verified booking deposits must persist the bank transaction reference for replay protection');
  assert.match(server, /BOOKING_DEPOSIT_NOT_READY/,
    'admin approval must guard bookings whose required deposit slip is missing or rejected');
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
  assert.match(server, /function bookingDepositStatus\(settings, hasSlip, verification = \{\}\)/,
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
  assert.match(server, /BOOKING_OPEN_AT_INVALID/,
    'server must reject invalid scheduled booking open timestamps');
  assert.match(server, /BOOKING_OPEN_AT_RANGE/,
    'server must reject booking open timestamps too far in the future');
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

test('cancelled bookings require a reason and notify with it', () => {
  const server = read('server.js');
  const hooks = read('project/admin/hooks.jsx');
  assert.match(server, /code: 'CANCEL_REASON_REQUIRED'/,
    'server must reject cancellation without a visible reason');
  assert.match(server, /b\.adminNotes = cancelReason\.slice\(0, 1000\)/,
    'cancel reason must be reused as the applicant-facing status note');
  assert.match(server, /cancelled: `[\s\S]{0,160}\+ \(updated\.adminNotes \? `เหตุผล: \$\{updated\.adminNotes\}\\n` : ''\)/,
    'cancel notification must include the admin-provided reason');
  assert.match(server, /terminalReason: \['cancelled', 'rejected'\]\.includes\(updated\.status\)/,
    'terminal booking audit must carry the cancellation/rejection reason');
  assert.match(hooks, /CANCEL_REASON_REQUIRED/,
    'admin UI must render a clear reason-required error from the backend');
});

test('booking approval and contract handoff understand preclaimed deposit bookings', () => {
  const server = read('server.js');
  assert.match(server, /preclaimedCandidate/,
    'approval must accept a room already reserved by the same public booking');
  assert.match(server, /String\(candidateRoom\.reservedBy \|\| ''\) === id/,
    'preclaimed approval must still be guarded by reservedBy=booking id');
  assert.match(server, /bookingFeeCredit = bookingFeeAppliesToDeposit[\s\S]{0,120}Math\.min\(bookingFeeForDepositCredit, Math\.max\(contractDeposit, 0\)\)/,
    'quick-invite must convert credited booking fees into a bounded resolved-deposit credit');
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
  const publicApp = read('project/app.jsx');
  const features = read('project/admin/page-features.jsx');
  const depositSettings = read('project/admin/page-booking-deposit-settings.jsx');
  const adminHtml = read('project/Admin Dashboard.html');
  const shell = read('project/admin/shell.jsx');
  const settings = read('project/admin/page-settings.jsx');
  const adminBookings = read('project/admin/page-bookings.jsx');
  assert.match(booking, /\/api\/bookings\/public\/config/,
    'public page must load deposit config');
  assert.match(booking, /\/api\/bookings\/public\/rooms/,
    'public page must load selectable vacant rooms');
  assert.match(booking, /id="roomPicker"/,
    'public page must render a vacant-room picker');
  assert.match(booking, /function selectBookingRoom/,
    'public page must bind room selection to the booking form');
  assert.match(booking, /id="startPaymentBtn"/,
    'public page must use an explicit payment-step action before locking a room');
  assert.match(booking, /syncPaymentStepUi/,
    'public page must hide the payment/slip step until a room hold is active');
  assert.match(booking, /releaseCurrentHold/,
    'public page must release a previous hold when a booker changes room after entering payment');
  assert.match(booking, /setRoomPickerDisabled/,
    'public page must block room switching while a booking submission is being finalized');
  assert.match(booking, /loadAvailableRooms\(\{ autoHold: false \}\)/,
    'public page must refresh room inventory after hold conflicts without immediately re-holding the same room');
  assert.match(booking, /AbortController/,
    'public page must timeout room inventory loading instead of leaving the picker stuck forever');
  assert.match(booking, /roomPickerRetryBtn/,
    'public page must offer a manual retry when room inventory loading fails');
  assert.match(booking, /BOOKING_DISABLED_FALLBACK/,
    'public page must keep a fallback disabled-booking message');
  assert.match(booking, /function bookingDisabledMessage/,
    'public page must normalize disabled-booking notices from config, room feed, hold, and submit responses');
  assert.match(booking, /function setBookingDisabled/,
    'public page must centralize the disabled-booking UI lockout');
  assert.match(booking, /function isBookingClosedResponse/,
    'public page must centralize closed/scheduled booking responses');
  assert.match(booking, /out\.code === 'ROOM_BOOKING_NOT_OPEN_YET'/,
    'public page must treat scheduled-not-open responses as a temporary closed state');
  assert.match(booking, /out\.enabled === false/,
    'public room feed loader must stop and render a closed-booking notice when inventory is disabled');
  assert.match(booking, /bookingDisabledReason = d\.booking\.enabled === false \? bookingDisabledMessage\(d\.booking\) : ''/,
    'public page must use the server disabled notice before loading rooms');
  assert.match(booking, /setBookingDisabled\(bookingDisabledMessage\(result\), result\)/,
    'public submit flow must lock the UI if booking is disabled during submission');
  assert.match(booking, /rateLimitMessage/,
    'public page must turn 429 responses into actionable wait-and-retry guidance');
  assert.match(booking, /fetchJsonWithTimeout/,
    'public page must timeout hold and submit requests instead of leaving the UI stuck');
  assert.match(booking, /REQUEST_TIMEOUT/,
    'public page must surface timeout failures with a stable client-side code path');
  assert.match(booking, /id="holdRetryBtn"/,
    'public page must offer an explicit hold retry action after recoverable hold failures');
  assert.match(booking, /\/api\/bookings\/public\/hold/,
    'public page must create a room hold');
  assert.match(booking, /\/api\/bookings\/public\/hold\/release/,
    'public page must release an owned hold instead of leaving the room locked until timeout');
  assert.match(booking, /requestRoomHold\(selectedRoomId\(\)\)/,
    'public page must create the hold only from the explicit payment-step action');
  assert.match(booking, /validateHoldReadyForSubmit/,
    'public page must revalidate an active, unexpired hold at submit time');
  assert.doesNotMatch(booking, /requestRoomHold\(room\.id\)/,
    'public page must not lock a room while the booker is only browsing/selecting rooms');
  assert.match(publicApp, /bookingHref\(room, \{ includeRoomId: canBookRoom \}\)/,
    'public room detail must only deep-link a concrete room when it is vacant');
  assert.match(publicApp, /useState\('vacant'\)/,
    'public room board should land visitors on available rooms first');
  assert.match(booking, /id="depositSlip"/,
    'public page must let the booker attach a deposit slip');
  assert.match(booking, /depositSlipReading/,
    'public page must block submit while the selected slip file is still being read');
  assert.match(booking, /successDepositNotice/,
    'public page must explain what happened after the transfer/slip submission succeeds');
  assert.match(booking, /slipAutoVerify/,
    'public page must explain whether the booking slip will be auto-verified or admin-reviewed');
  assert.match(booking, /data\.holdToken = holdToken/,
    'public page must submit the hold token with the booking');
  assert.match(booking, /id="bookingCountdown"/,
    'public page must render a countdown container before scheduled booking opens');
  assert.match(booking, /function startBookingCountdown/,
    'public page must start a realtime countdown for scheduled booking openings');
  assert.match(booking, /syncServerClock\(d\.booking\.serverNow\)/,
    'public countdown must use the server clock from config');
  assert.match(booking, /loadBookingConfig\(\{ afterCountdown: true \}\)/,
    'public countdown must reload config automatically when it reaches zero');
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
  assert.match(shell, /id: 'booking-deposit-settings'[\s\S]{0,140}minRole: 'manager'/,
    'admin sidebar must expose a direct booking deposit settings entry to managers and owners');
  assert.match(settings, /bookingDeposit/,
    'settings hub must expose booking deposit settings as a first-class tab');
  assert.match(settings, /บันทึกจากกล่องจอง\/มัดจำด้านล่าง/,
    'settings hub must not show the unrelated global save button on the booking-deposit tab');
  assert.match(depositSettings, /function PageBookingDepositSettings/,
    'dedicated admin page must register a booking deposit settings component');
  assert.match(depositSettings, /\/api\/admin\/booking-deposit-settings/,
    'dedicated admin page must persist through the guarded booking deposit settings API');
  assert.match(depositSettings, /next\.enabled && bookingDepositNeedsPaymentSetup/,
    'dedicated admin page must not warn about payment setup when online booking is deliberately closed');
  assert.match(depositSettings, /ปิดรับจองออนไลน์แล้ว/,
    'dedicated admin page must confirm that closing booking prevents public submissions');
  assert.match(depositSettings, /ไม่ต้องใช้ปุ่มบันทึกของตั้งค่าระบบ/,
    'embedded booking deposit settings must render its own save action instead of hiding it with the page header');
  assert.match(depositSettings, /bookingDepositCanEditRole/,
    'dedicated admin page must keep owner-manager edit permissions aligned with the API');
  assert.doesNotMatch(depositSettings, /PUT'[\s\S]{0,120}\/api\/admin\/features/,
    'dedicated admin page must not bypass booking-deposit validation by saving directly to generic features');
  assert.match(depositSettings, /minimumAmount/,
    'dedicated admin page must expose the no-minimum or minimum booking-fee rule');
  assert.match(depositSettings, /openAt/,
    'dedicated admin page must expose the scheduled public booking open time');
  assert.match(depositSettings, /type="datetime-local"/,
    'dedicated admin page must let admins choose the exact open date and time');
  assert.match(depositSettings, /เปิดรับจองทันที/,
    'dedicated admin page must provide a one-click open-now action');
  assert.match(depositSettings, /ปิดรับจองทันที/,
    'dedicated admin page must provide a one-click close-now action');
  assert.match(depositSettings, /applyBookingFeeToDeposit/,
    'dedicated admin page must expose the booking-fee-to-contract-deposit policy');
  assert.match(depositSettings, /bookingDepositEffectiveAmount/,
    'dedicated admin page must show the effective amount after minimum policy');
  assert.match(depositSettings, /maxBytes/,
    'dedicated admin page must expose the slip upload size limit');
  assert.match(booking, /applyBookingFeeToDeposit/,
    'public page must explain whether the booking fee is credited to deposit');
  assert.match(booking, /bookingDepositNeedsPaymentSetup/,
    'public page must surface missing payment setup before a slip-required booking hold');
  assert.match(adminBookings, /depositStatusLabel/,
    'admin booking page must show booking deposit status');
  assert.match(adminBookings, /manual_review/,
    'admin booking page must label no-slip deposit bookings as manual review');
  assert.match(adminBookings, /depositSlipUrl/,
    'admin booking detail must link the deposit slip when present');
  assert.match(adminBookings, /depositTransactionRef/,
    'admin booking detail must show the booking deposit transaction reference when verifier returns it');
  assert.match(adminBookings, /depositBalanceDue/,
    'admin booking detail must show the remaining deposit balance');
});
