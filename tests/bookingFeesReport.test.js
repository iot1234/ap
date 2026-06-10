// tests/bookingFeesReport.test.js
// Booking-fee money visibility: collected booking fees are deposits (a
// liability, not revenue) but they are REAL money in the owner's account
// that previously appeared in no financial view. Pins:
//   - aggregateBookingFees() bucketing semantics (pure function)
//   - GET /api/reports/booking-fees endpoint (manager+)
//   - approve-and-assign promotes review-state deposit slips to 'verified'
//     (the approving admin IS the human verification) + relational mirror
//   - reports page renders the new section
//   node --test tests/bookingFeesReport.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { aggregateBookingFees } = require('../routes/reports');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('aggregateBookingFees: verified fees bucket by month of the money event', () => {
  const { rows, byMethod } = aggregateBookingFees([
    { bookingFee: 3000, depositStatus: 'verified', depositVerifiedAt: '2026-03-05T10:00:00Z',
      depositPaymentMethod: 'cash', status: 'approved' },
    { bookingFee: 3000, depositStatus: 'verified', depositVerifiedAt: '2026-03-20T10:00:00Z',
      depositPaymentMethod: 'promptpay', status: 'completed' },
    { bookingFee: 2500, depositStatus: 'verified', depositVerifiedAt: '2026-04-01T10:00:00Z',
      depositPaymentMethod: 'transfer', status: 'approved' },
  ], 2026);
  const mar = rows.find((r) => r.period === '2026-03');
  const apr = rows.find((r) => r.period === '2026-04');
  assert.equal(mar.verified_count, 2);
  assert.equal(mar.verified_amount, 6000);
  assert.equal(apr.verified_count, 1);
  assert.equal(apr.verified_amount, 2500);
  assert.deepEqual(byMethod, { cash: 3000, promptpay: 3000, transfer: 2500 });
});

test('aggregateBookingFees: review states count as pending, no-money states excluded', () => {
  const { rows } = aggregateBookingFees([
    { bookingFee: 3000, depositStatus: 'pending_review', createdAt: '2026-05-01T00:00:00Z' },
    { bookingFee: 3000, depositStatus: 'manual_review', createdAt: '2026-05-02T00:00:00Z' },
    { bookingFee: 3000, depositStatus: 'submitted', createdAt: '2026-05-03T00:00:00Z' },
    // No money yet / refused / not applicable — must not count anywhere:
    { bookingFee: 3000, depositStatus: 'awaiting_slip', createdAt: '2026-05-04T00:00:00Z' },
    { bookingFee: 3000, depositStatus: 'rejected', createdAt: '2026-05-05T00:00:00Z' },
    { bookingFee: 0, depositStatus: 'verified', depositVerifiedAt: '2026-05-06T00:00:00Z' },
    { bookingFee: 3000, depositStatus: 'not_required', createdAt: '2026-05-07T00:00:00Z' },
  ], 2026);
  const may = rows.find((r) => r.period === '2026-05');
  assert.equal(may.pending_count, 3);
  assert.equal(may.pending_amount, 9000);
  assert.equal(may.verified_count, 0);
  assert.equal(may.verified_amount, 0);
});

test('aggregateBookingFees: cancelled-after-collect stays in totals but is flagged', () => {
  const { rows } = aggregateBookingFees([
    { bookingFee: 3000, depositStatus: 'verified', depositVerifiedAt: '2026-06-01T00:00:00Z',
      status: 'cancelled' },
    { bookingFee: 3000, depositStatus: 'verified', depositVerifiedAt: '2026-06-02T00:00:00Z',
      status: 'rejected' },
    { bookingFee: 3000, depositStatus: 'verified', depositVerifiedAt: '2026-06-03T00:00:00Z',
      status: 'approved' },
  ], 2026);
  const jun = rows.find((r) => r.period === '2026-06');
  assert.equal(jun.verified_count, 3, 'money WAS received on all three');
  assert.equal(jun.verified_amount, 9000);
  assert.equal(jun.cancelled_collected_count, 2, 'two need refund reconciliation');
  assert.equal(jun.cancelled_collected_amount, 6000);
});

test('aggregateBookingFees: other years + malformed entries are ignored, 12 rows always', () => {
  const { rows } = aggregateBookingFees([
    { bookingFee: 3000, depositStatus: 'verified', depositVerifiedAt: '2025-12-31T00:00:00Z' },
    null,
    'garbage',
    { bookingFee: 'NaN', depositStatus: 'verified', depositVerifiedAt: '2026-01-01T00:00:00Z' },
    { bookingFee: 3000, depositStatus: 'verified' /* no usable date */ },
  ], 2026);
  assert.equal(rows.length, 12, 'full-year series for charts');
  assert.ok(rows.every((r) => r.verified_count === 0 && r.pending_count === 0));
});

test('aggregateBookingFees: falls back reservedAt → createdAt for the bucket date', () => {
  const { rows } = aggregateBookingFees([
    { bookingFee: 1000, depositStatus: 'verified', reservedAt: '2026-02-10T00:00:00Z' },
    { bookingFee: 1000, depositStatus: 'pending_review', createdAt: '2026-02-11T00:00:00Z' },
  ], 2026);
  const feb = rows.find((r) => r.period === '2026-02');
  assert.equal(feb.verified_count, 1);
  assert.equal(feb.pending_count, 1);
});

// === Endpoint + integration pins ===========================================

test('GET /api/reports/booking-fees exists and is manager+ gated', () => {
  const reports = read('routes', 'reports.js');
  assert.match(reports, /r\.get\('\/booking-fees', requireAuth, managerOrOwner/,
    'booking-fee money is commercially sensitive — same gate as revenue');
  assert.match(reports, /booking-fees-\$\{year\}/,
    'csv/xlsx export must work like the other financial reports');
});

test('approve-and-assign promotes review-state deposits to verified + mirrors to SQL', () => {
  const server = read('server.js');
  assert.match(server, /DEPOSIT_REVIEW_STATES = new Set\(\['pending_review', 'manual_review', 'submitted'\]\)/,
    'only slips a human actually reviewed get promoted — awaiting_slip/rejected stay blocked by the approve guard');
  assert.match(server, /ยืนยันพร้อมการอนุมัติการจองโดย/,
    'the stamp records WHO confirmed by approving');
  assert.match(server, /SET deposit_status=\$2,\s*deposit_verified_at=NOW\(\)/,
    'relational bookings row must mirror the promotion');
  assert.match(server, /depositVerifiedOnApprove: stampDepositVerified \|\| undefined/,
    'audit log must record that the deposit was verified via approval');
});

test('reports page fetches + renders the booking-fee section', () => {
  const page = read('project', 'admin', 'page-reports.jsx');
  assert.match(page, /\/api\/reports\/booking-fees\?year=/,
    'page must fetch the new report');
  assert.match(page, /เงินค่าจองที่เก็บได้/,
    'section heading must render');
  assert.match(page, /จองที่ยกเลิกหลังเก็บเงิน/,
    'refund-reconciliation flag must be visible to the owner');
});
