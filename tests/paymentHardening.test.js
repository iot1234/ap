// tests/paymentHardening.test.js
// Payment-system hardening upgrades:
//   A) slipUpload.providerReceiverCheck — opt-in provider-side receiver
//      verification (EasySlip matchAccount / Slip2Go checkReceiver) passed
//      through every verify call site.
//   B) slipUpload.strictReceiverTail — a receiver tail match on fewer than
//      6 digits parks in the admin queue (RECEIVER_TAIL_WEAK, transient)
//      instead of auto-verifying. Matcher extracted to a pure function.
//   C) scheduler tickPendingSlipAlert — per-slip escalation when uploads
//      sit in the verify queue past slipUpload.pendingSlipAlertHours.
//   D) config PUT warns when the payment receiver changes while unpaid
//      bills are in flight (stale QR / bank info already sent to tenants).
//   E) healthCheck surfaces aged pending slips.
//   node --test tests/paymentHardening.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const features = require('../services/features');
const slipVerifier = require('../services/slipVerifier');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// === Feature defaults =======================================================

test('new slipUpload hardening flags default OFF / sane', () => {
  const f = features.withDefaults({});
  assert.equal(f.slipUpload.providerReceiverCheck, false,
    'provider-side receiver check is opt-in (needs provider-side setup)');
  assert.equal(f.slipUpload.strictReceiverTail, false,
    'strict tail is opt-in (default keeps long-standing ≥4-digit behaviour)');
  assert.equal(f.slipUpload.pendingSlipAlertHours, 12,
    'pending-slip escalation defaults to 12h');
});

test('operator overrides on the new flags survive deep-merge', () => {
  const f = features.withDefaults({
    slipUpload: { enabled: true, strictReceiverTail: true, pendingSlipAlertHours: 4 },
  });
  assert.equal(f.slipUpload.strictReceiverTail, true);
  assert.equal(f.slipUpload.pendingSlipAlertHours, 4);
  assert.equal(f.slipUpload.requireVerification, true, 'untouched defaults intact');
});

// === B) Pure receiver-tail matcher =========================================

const T = (digits, method = 'promptpay') => ({ digits, method, label: method });

test('matchReceiverTail: full 6-digit tail match passes (strict or not)', () => {
  for (const strict of [false, true]) {
    const out = slipVerifier.matchReceiverTail({
      acceptableTargets: [T('0812345678')],
      // Classic Thai bank display: 5 mask chars + 6 tail digits = 11 chars,
      // LONGER than the 10-digit account → right-aligned comparison.
      actualAccount: 'xxx-x-x345678',
      strict,
    });
    assert.equal(out.outcome, 'match', `strict=${strict}`);
    assert.equal(out.detail.compareLen, 6);
    assert.equal(out.detail.mode, 'right-align',
      'length-mismatched masked string compares via right alignment');
  }
});

test('matchReceiverTail: pure digit tails still work (provider sent tail only)', () => {
  const out = slipVerifier.matchReceiverTail({
    acceptableTargets: [T('0812345678')],
    actualAccount: '345678',
    strict: true,
  });
  assert.equal(out.outcome, 'match');
  assert.equal(out.detail.mode, 'tail');
  assert.equal(out.detail.expectedTail, '345678');
});

test('matchReceiverTail: 4-digit match passes normally but parks under strict', () => {
  const base = {
    acceptableTargets: [T('0812345678')],
    actualAccount: 'xxxxxx5678',   // provider masked down to 4 digits
  };
  const normal = slipVerifier.matchReceiverTail({ ...base, strict: false });
  assert.equal(normal.outcome, 'match');
  assert.equal(normal.detail.compareLen, 4);
  const strict = slipVerifier.matchReceiverTail({ ...base, strict: true });
  assert.equal(strict.outcome, 'weak',
    'strict mode downgrades a statistically weaker match to admin review');
  assert.equal(strict.detail.compareLen, 4);
});

test('matchReceiverTail: mismatch and unreadable outcomes', () => {
  const mismatch = slipVerifier.matchReceiverTail({
    acceptableTargets: [T('0812345678'), T('1234567890123', 'transfer')],
    actualAccount: '999999',
    strict: false,
  });
  assert.equal(mismatch.outcome, 'mismatch');
  assert.deepEqual(mismatch.expectedTails, ['345678', '890123']);
  assert.equal(mismatch.actualTail, '999999');

  assert.equal(slipVerifier.matchReceiverTail({
    acceptableTargets: [T('0812345678')], actualAccount: '', strict: false,
  }).outcome, 'unreadable');
  // Provider revealed only 2 digits — too little to confirm OR deny.
  // Parks for a human instead of accusing the tenant.
  const short = slipVerifier.matchReceiverTail({
    acceptableTargets: [T('0812345678')], actualAccount: 'x78', strict: false,
  });
  assert.equal(short.outcome, 'unreadable');
  assert.equal(short.reason, 'insufficient_digits');
  // Placeholder garbage ("N/A", "NOT PROVIDED") → no digits at all.
  assert.equal(slipVerifier.matchReceiverTail({
    acceptableTargets: [T('0812345678')], actualAccount: 'NOT PROVIDED', strict: false,
  }).reason, 'no_account');
});

// === Scattered-mask patterns (the formats banks actually send) =============

test('matchReceiverTail: scattered masks match by position — 12**5***99 style', () => {
  // Account 1234567899 masked as 12**5***99 (revealed: positions 1,2,5,9,10)
  const out = slipVerifier.matchReceiverTail({
    acceptableTargets: [T('1234567899')],
    actualAccount: '12**5***99',
    strict: false,
  });
  assert.equal(out.outcome, 'match');
  assert.equal(out.detail.mode, 'positional');
  assert.equal(out.detail.compareLen, 5, 'five revealed digits all agree');

  // Even sparser: 1*3*5****9 (four revealed digits)
  const sparse = slipVerifier.matchReceiverTail({
    acceptableTargets: [T('1234567899')],
    actualAccount: '1*3*5****9',
    strict: false,
  });
  assert.equal(sparse.outcome, 'match');
  assert.equal(sparse.detail.compareLen, 4);

  // Under strict mode the same 4-digit evidence parks for a human instead.
  const sparseStrict = slipVerifier.matchReceiverTail({
    acceptableTargets: [T('1234567899')],
    actualAccount: '1*3*5****9',
    strict: true,
  });
  assert.equal(sparseStrict.outcome, 'weak');
});

test('matchReceiverTail: the OLD digit-stripping approach would have false-rejected these', () => {
  // Regression: stripping masks from 12**5***99 gives "12599" whose TAIL
  // never equals any tail of 1234567899 — the old comparator hard-rejected
  // a genuine payment. The positional comparator must accept it.
  const out = slipVerifier.matchReceiverTail({
    acceptableTargets: [T('1234567899')],
    actualAccount: '12**5***99',
    strict: false,
  });
  assert.equal(out.outcome, 'match',
    'scattered-mask slips paid to OUR account must not be rejected');
});

test('matchReceiverTail: equal-length positional CONFLICT is a confident mismatch', () => {
  // Same shape as a real match but one revealed digit disagrees (5→6):
  // that is genuine evidence of a different account → hard mismatch.
  const out = slipVerifier.matchReceiverTail({
    acceptableTargets: [T('1234567899')],
    actualAccount: '12**6***99',
    strict: false,
  });
  assert.equal(out.outcome, 'mismatch');
});

test('matchReceiverTail: masked with different length right-aligns; conflicts there only park', () => {
  // '***7899' (7 chars) right-aligned onto 1234567899 → tail digits agree.
  const ok = slipVerifier.matchReceiverTail({
    acceptableTargets: [T('1234567899')],
    actualAccount: '***7899',
    strict: false,
  });
  assert.equal(ok.outcome, 'match');
  assert.equal(ok.detail.mode, 'right-align');
  // '99**1' under a GUESSED alignment disagrees — but a guessed alignment
  // must never produce a confident rejection: park for a human instead.
  const guess = slipVerifier.matchReceiverTail({
    acceptableTargets: [T('1234567899')],
    actualAccount: '99**1',
    strict: false,
  });
  assert.equal(guess.outcome, 'unreadable');
  assert.equal(guess.reason, 'insufficient_digits');
});

test('matchReceiverTail: ambiguous on one target + conflict on another stays parked (no false reject)', () => {
  const out = slipVerifier.matchReceiverTail({
    acceptableTargets: [T('1234567899'), T('0812345678', 'transfer')],
    actualAccount: '99**1',          // ambiguous vs target 1, ambiguous vs target 2
    strict: false,
  });
  assert.equal(out.outcome, 'unreadable',
    'uncertainty on ANY target blocks a confident mismatch verdict');
});

test('matchReceiverTail: multiple receiver channels — ANY match wins', () => {
  const out = slipVerifier.matchReceiverTail({
    acceptableTargets: [T('0812345678'), T('7771234567', 'transfer')],
    actualAccount: '234567',    // matches the bank account, not PromptPay
    strict: false,
  });
  assert.equal(out.outcome, 'match');
  assert.equal(out.detail.method, 'transfer');
});

test('RECEIVER_TAIL_WEAK is transient — parks, never tenant-rejects, chain continues', () => {
  assert.ok(slipVerifier.TRANSIENT_CODES.has('RECEIVER_TAIL_WEAK'),
    'weak match must map to pending (admin queue), not a tenant-facing rejection');
});

test('RECEIVER_UNREADABLE is transient — masked-beyond-recognition slips park for admin', () => {
  // The provider confirmed the slip is REAL; only the receiver field was
  // unreadable/over-masked. The fallback chain may reveal more digits via
  // another provider; failing that, a human decides. Hard-rejecting here
  // would punish tenants for their bank's masking style.
  assert.ok(slipVerifier.TRANSIENT_CODES.has('RECEIVER_UNREADABLE'),
    'unreadable receiver must park in the admin queue, not reject the tenant');
});

// === A) Call sites pass the hardening flags =================================

test('bill-slip and booking-deposit verify calls pass the opt-in flags', () => {
  const server = read('server.js');
  const occurrences = server.match(/strictReceiverTail: (?:req\.features|bookingFlags)\?\.slipUpload\?\.strictReceiverTail === true/g) || [];
  assert.ok(occurrences.length >= 2,
    'both verify call sites (tenant bill slip + booking deposit) must pass strictReceiverTail');
  const prc = server.match(/easyslipMatchAccount: (?:req\.features|bookingFlags)\?\.slipUpload\?\.providerReceiverCheck === true/g) || [];
  assert.ok(prc.length >= 2,
    'both verify call sites must pass providerReceiverCheck to EasySlip');
  const s2g = server.match(/slip2goCheckReceiver: (?:req\.features|bookingFlags)\?\.slipUpload\?\.providerReceiverCheck === true/g) || [];
  assert.ok(s2g.length >= 2,
    'both verify call sites must pass providerReceiverCheck to Slip2Go');
});

// === C) Pending-slip escalation tick ========================================

test('tickPendingSlipAlert: gated off cleanly (flag off / hours=0) — no DB touch', async () => {
  const sched = require('../services/scheduler');
  // Not exported directly — behavioural gate is pinned via source; the
  // public surface is the registered job (below). Source assertions:
  const src = read('services', 'scheduler.js');
  assert.match(src, /async function tickPendingSlipAlert\(pool, flags, now, state\)/,
    'tick must exist with the standard signature');
  assert.match(src, /if \(!flags\?\.slipUpload\?\.enabled\) return;/,
    'feature-gated');
  assert.match(src, /if \(!Number\.isFinite\(rawHours\) \|\| rawHours <= 0\) return;/,
    '0/absent threshold disables the alert');
  assert.match(src, /Math\.max\(1, Math\.min\(168, Math\.trunc\(rawHours\)\)\)/,
    'threshold clamped to 1-168h');
  assert.ok(sched, 'scheduler module loads');
});

test('tickPendingSlipAlert: alerts once per payment and prunes resolved latches', () => {
  const src = read('services', 'scheduler.js');
  assert.match(src, /state\.alertedPendingSlips/,
    'per-payment latch must persist in scheduler state');
  assert.match(src, /SELECT id FROM payments WHERE status='pending'/,
    'latch pruned against the FULL live pending set (so re-uploads can re-alert)');
  assert.match(src, /created_at <= NOW\(\) - make_interval\(hours => \$1\)/,
    'aging computed in SQL against absolute timestamps');
  assert.match(src, /pendingSlipAlert-\$\{localHourKey\(now\)\}/,
    'hour-scoped advisory lock — hourly cadence, replica-safe');
  assert.match(src, /'pending-slip-alert': 'สลิป/,
    'job registered in the failure-impact map');
});

// === D) Receiver-change warning ============================================

test('config PUT warns when the receiving account changes with unpaid bills in flight', () => {
  const server = read('server.js');
  assert.match(server, /const receiverKeys = \['promptpay', 'bankAcc', 'truemoneyPhone'\]/,
    'all three receiver channels compared');
  assert.match(server, /SELECT COUNT\(\*\)::int AS n FROM bills\s+WHERE status IN \('pending','overdue'\) AND deleted_at IS NULL/,
    'warning only fires when unpaid bills exist');
  assert.match(server, /เปลี่ยนบัญชีรับเงิน \(\$\{changed\.join\(', '\)\}\) ขณะมีบิลค้างชำระ/,
    'operator-facing warning text present');
  // It must be a WARNING (non-blocking) — pushed to warnings, not hardIssues.
  const idx = server.indexOf('เปลี่ยนบัญชีรับเงิน (');
  const before = server.slice(Math.max(0, idx - 400), idx);
  assert.match(before, /warnings\.push\(/,
    'receiver change is advisory — never blocks a legitimate bank switch');
  assert.doesNotMatch(before, /hardIssues\.push\(/,
    'must not be wired into the blocking hardIssues path');
});

// === E) healthCheck visibility =============================================

test('healthCheck counts + warns on aged pending slips', () => {
  const hc = read('services', 'healthCheck.js');
  assert.match(hc, /AS aged_pending_slips/,
    'integrity counts must include the aged queue');
  assert.match(hc, /aged_pending_slips: Number\(counts\.aged_pending_slips\) \|\| 0/,
    'count exposed in detail.counts');
  assert.match(hc, /slip\(s\) waiting in the verify queue for over 12h/,
    'surfaced as an operator warning');
});
