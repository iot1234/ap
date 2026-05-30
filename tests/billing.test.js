// tests/billing.test.js
// Pure-function tests for services/billing.js — no DB needed.
//
//   node --test tests/billing.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const billing = require('../services/billing');

const baseConfig = {
  utilities: { waterRate: 18, elecRate: 8, wifi: 250 },
  building: { name: 'Test' },
  payment: { promptpayTarget: '0812345678' },
};
const baseRoom = {
  id: '201', rent: 5000, waterUnits: 5, elecUnits: 100,
  tenant: { name: 'นาย ก', phone: '0811234567' },
};

test('buildBill: basic line items + total', () => {
  const flags = { lateFee: { enabled: false }, vat: { enabled: false } };
  const bill = billing.buildBill({ room: baseRoom, config: baseConfig, features: flags });
  assert.equal(bill.roomId, '201');
  assert.equal(bill.rent, 5000);
  assert.equal(bill.waterAmount, 90);   // 5 × 18
  assert.equal(bill.elecAmount, 800);   // 100 × 8
  assert.equal(bill.wifi, 250);
  assert.equal(bill.subtotal, 6140);
  assert.equal(bill.total, 6140);
  assert.equal(bill.vat, 0);
  assert.equal(bill.lateFee, 0);
  assert.ok(bill.billNo.startsWith('INV-'));
});

test('buildBill: minimum billable units floor (utilities.waterMin / elecMin)', () => {
  const flags = { lateFee: { enabled: false }, vat: { enabled: false } };
  // Tenant used only 1 water unit + 3 elec units; operator set minimums 5 / 50.
  const lowUseRoom = { ...baseRoom, waterUnits: 1, elecUnits: 3 };
  const cfgMin = { ...baseConfig, utilities: { ...baseConfig.utilities, waterMin: 5, elecMin: 50 } };
  const bill = billing.buildBill({ room: lowUseRoom, config: cfgMin, features: flags });
  // Billed at the minimum, not the (lower) actual usage.
  assert.equal(bill.waterUnits, 5, 'water billed units floored to the minimum');
  assert.equal(bill.waterAmount, 90, '5 × 18 = 90 (min applied)');
  assert.equal(bill.elecUnits, 50, 'elec billed units floored to the minimum');
  assert.equal(bill.elecAmount, 400, '50 × 8 = 400 (min applied)');
  // Actual usage + applied flags surfaced for the UI note.
  assert.equal(bill.waterActualUnits, 1);
  assert.equal(bill.waterMinApplied, true);
  assert.equal(bill.elecActualUnits, 3);
  assert.equal(bill.elecMinApplied, true);
  // The line item explains the minimum to the tenant.
  assert.ok(bill.items.some((it) => /ค่าน้ำ/.test(it.label) && /ขั้นต่ำ 5/.test(it.detail || '')),
    'water line must note the applied minimum');

  // Usage ABOVE the minimum bills actual; flags stay false.
  const highUse = billing.buildBill({ room: { ...baseRoom, waterUnits: 9 }, config: cfgMin, features: flags });
  assert.equal(highUse.waterUnits, 9, 'actual usage above minimum bills actual');
  assert.equal(highUse.waterMinApplied, false);

  // Default config (waterMin/elecMin = 0) → no floor, unchanged behavior.
  const noMin = billing.buildBill({ room: lowUseRoom, config: baseConfig, features: flags });
  assert.equal(noMin.waterUnits, 1);
  assert.equal(noMin.waterMinApplied, false);

  // applyMinUnits:false disables the floor even when minimums are set.
  const disabled = billing.buildBill({
    room: lowUseRoom,
    config: { ...baseConfig, utilities: { ...baseConfig.utilities, waterMin: 5, elecMin: 50, applyMinUnits: false } },
    features: flags,
  });
  assert.equal(disabled.waterUnits, 1, 'applyMinUnits:false → actual usage');
  assert.equal(disabled.waterMinApplied, false);

  // Flat-mode rooms ignore the minimum (fixed monthly amount).
  const flatRoom = { ...baseRoom, waterMode: 'flat', waterFlatAmount: 120, waterUnits: 1 };
  const flatBill = billing.buildBill({ room: flatRoom, config: cfgMin, features: flags });
  assert.equal(flatBill.waterAmount, 120, 'flat amount unaffected by minimum');
  assert.equal(flatBill.waterMinApplied, false);
});

test('buildBill: common-area fee billed as a flat monthly item (ungated by recurringCharges)', () => {
  const cfg = { ...baseConfig, utilities: { ...baseConfig.utilities, commonFee: 200 } };
  const flags = { lateFee: { enabled: false }, vat: { enabled: false }, recurringCharges: { enabled: false } };
  const bill = billing.buildBill({ room: baseRoom, config: cfg, features: flags });
  assert.equal(bill.commonFee, 200);
  assert.equal(bill.subtotal, 6340);   // 5000 + 90 + 800 + 250 + 200
  assert.equal(bill.total, 6340);
  assert.ok(bill.items.some((it) => /ส่วนกลาง/.test(it.label) && it.amount === 200),
    'bill items must include a ค่าส่วนกลาง line');

  // absent/zero commonFee → no line, no charge (rooms that don't set it)
  const noCf = billing.buildBill({ room: baseRoom, config: baseConfig, features: flags });
  assert.equal(noCf.commonFee, 0);
  assert.ok(!noCf.items.some((it) => /ส่วนกลาง/.test(it.label)));

  // per-room override beats the global rate
  const ov = billing.buildBill({ room: { ...baseRoom, commonFeeOverride: 350 }, config: cfg, features: flags });
  assert.equal(ov.commonFee, 350);
  assert.equal(ov.commonFeeSource, 'override');

  // VAT applies to the common fee (it sits inside vatBase, like wifi)
  const vbill = billing.buildBill({ room: baseRoom, config: cfg, features: { vat: { enabled: true, ratePct: 7 }, lateFee: { enabled: false } } });
  assert.equal(vbill.subtotal, 6340);
  assert.equal(vbill.vat, 443.8);      // round2(6340 * 7%)
  assert.equal(vbill.total, 6783.8);
});

test('buildBill: utility readings use before/after meter deltas', () => {
  const flags = { lateFee: { enabled: false }, vat: { enabled: false } };
  const bill = billing.buildBill({
    room: {
      ...baseRoom,
      waterUnits: 999,
      waterPrevReading: 120,
      waterCurrentReading: 135.5,
      elecUnits: 999,
      elecPrevReading: 1500,
      elecCurrentReading: 1625,
    },
    config: baseConfig,
    features: flags,
  });
  assert.equal(bill.waterUnits, 15.5);
  assert.equal(bill.waterAmount, 279);
  assert.equal(bill.elecUnits, 125);
  assert.equal(bill.elecAmount, 1000);
  const waterItem = bill.items.find((it) => it.label === 'ค่าน้ำ');
  const elecItem = bill.items.find((it) => it.label === 'ค่าไฟฟ้า');
  assert.match(waterItem.detail, /เลขก่อน 120/);
  assert.match(waterItem.detail, /เลขหลัง 135\.50/);
  assert.match(elecItem.qty, /125 หน่วย × 8/);
});

test('buildBill: VAT applied when enabled', () => {
  const flags = { lateFee: { enabled: false }, vat: { enabled: true, ratePct: 7 } };
  const bill = billing.buildBill({ room: baseRoom, config: baseConfig, features: flags });
  // 6140 + 7% = 6569.8
  assert.equal(bill.subtotal, 6140);
  assert.equal(bill.vat, 429.8);
  assert.equal(bill.total, 6569.8);
});

test('computeLateFee: late fee from previous overdue', () => {
  const flags = { lateFee: { enabled: true, ratePctPerMonth: 1.5, gracePeriodDays: 0 }, vat: { enabled: false } };
  const past = new Date(); past.setDate(past.getDate() - 30);
  const fee = billing.computeLateFee({
    base: 6000,
    dueDate: past.toISOString().slice(0, 10),
    ratePctPerMonth: flags.lateFee.ratePctPerMonth,
    gracePeriodDays: flags.lateFee.gracePeriodDays,
    now: new Date(),
  });
  assert.ok(fee.lateFee > 0, 'late fee should be > 0');
  // Roughly 6000 × 1.5% × (30/30) = 90 (give or take grace handling)
  assert.ok(fee.lateFee >= 80 && fee.lateFee <= 100);
  const bill = billing.buildBill({ room: baseRoom, config: baseConfig, features: flags, previous: { total: 6000 } });
  assert.equal(bill.lateFee, 0, 'buildBill keeps late fees on the overdue bill, not the new bill');
});

test('buildBill: recurring charges only when enabled', () => {
  const off = { lateFee: { enabled: false }, vat: { enabled: false }, recurringCharges: { enabled: false } };
  const on  = { lateFee: { enabled: false }, vat: { enabled: false }, recurringCharges: { enabled: true } };
  const r = [{ label: 'parking', amount: 500 }];
  const billOff = billing.buildBill({ room: baseRoom, config: baseConfig, features: off, recurring: r });
  const billOn  = billing.buildBill({ room: baseRoom, config: baseConfig, features: on,  recurring: r });
  assert.equal(billOff.total, 6140);
  assert.equal(billOn.total, 6640);
});

test('statusOf: paid > overdue > pending', () => {
  assert.equal(billing.statusOf({ paid_at: '2025-01-01' }), 'paid');
  assert.equal(billing.statusOf({ paid_at: null, due_date: '2020-01-01' }), 'overdue');
  // +7 days, not +1: statusOf parses due_date as LOCAL midnight while
  // toISOString() yields a UTC date. At +1 day, in a UTC+7 timezone during the
  // early-morning hours the UTC "tomorrow" resolves to the LOCAL "today",
  // making the bill read overdue and flaking the test. 7 days clears any
  // timezone skew so the due date is unambiguously in the future.
  const future = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
  assert.equal(billing.statusOf({ paid_at: null, due_date: future }), 'pending');
});

test('makeBillNo is deterministic for room+period', () => {
  assert.equal(billing.makeBillNo('201', '2026-05'), 'INV-2026-05-201');
});

// --- R4 — makeBillNo with tenant suffix ------------------------------------
// When a room changes tenants mid-period (one moves out, another moves in
// within the same calendar month), the default INV-${period}-${roomId}
// collides — both tenants need a separate bill for the same room+period.
// makeBillNo's opts.tenantId appends -T${id} so the partial unique
// uq_bills_room_period_tenant_active accommodates both.

test('makeBillNo: with tenantId appends -T${id}', () => {
  assert.equal(billing.makeBillNo('201', '2026-05', { tenantId: 42 }), 'INV-2026-05-201-T42');
});

test('makeBillNo: invalid/empty tenantId falls back to default shape', () => {
  assert.equal(billing.makeBillNo('201', '2026-05', { tenantId: null }), 'INV-2026-05-201');
  assert.equal(billing.makeBillNo('201', '2026-05', { tenantId: '' }), 'INV-2026-05-201');
  assert.equal(billing.makeBillNo('201', '2026-05', { tenantId: -1 }), 'INV-2026-05-201');
  assert.equal(billing.makeBillNo('201', '2026-05', { tenantId: 'oops' }), 'INV-2026-05-201');
});

test('makeBillNo: attempt suffix for rare double-collision', () => {
  assert.equal(billing.makeBillNo('201', '2026-05', { tenantId: 42, attempt: 1 }), 'INV-2026-05-201-T42');
  assert.equal(billing.makeBillNo('201', '2026-05', { tenantId: 42, attempt: 2 }), 'INV-2026-05-201-T42-2');
});

// --- R2 — computeLateFee edge cases ----------------------------------------
// services/scheduler.js#tickLateFee calls billing.computeLateFee to keep
// the math centralised. These pin the contract so a future refactor can't
// silently drift (off-by-one on grace, base coercion, NaN propagation).

test('computeLateFee: zero/invalid inputs → 0 (defensive)', () => {
  assert.equal(billing.computeLateFee({}).lateFee, 0);
  assert.equal(billing.computeLateFee({ base: 0, dueDate: '2026-01-01', ratePctPerMonth: 1.5 }).lateFee, 0);
  assert.equal(billing.computeLateFee({ base: 5000, dueDate: '2026-01-01' }).lateFee, 0, 'no rate → 0');
  assert.equal(billing.computeLateFee({ base: 'oops', dueDate: '2026-01-01', ratePctPerMonth: 1.5 }).lateFee, 0);
  assert.equal(billing.computeLateFee({ base: 5000, dueDate: 'not-a-date', ratePctPerMonth: 1.5 }).lateFee, 0);
});

test('computeLateFee: due in future → 0 (not yet overdue)', () => {
  const future = new Date(Date.now() + 7 * 86_400_000);
  const r = billing.computeLateFee({ base: 5000, dueDate: future, ratePctPerMonth: 1.5 });
  assert.equal(r.lateFee, 0);
  assert.equal(r.daysOver, 0);
});

test('computeLateFee: grace period absorbs short delay', () => {
  const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000);
  const r = billing.computeLateFee({ base: 5000, dueDate: fiveDaysAgo, ratePctPerMonth: 1.5, gracePeriodDays: 7 });
  assert.equal(r.lateFee, 0);
});

test('computeLateFee: idempotent — same inputs → same output', () => {
  // tickLateFee re-runs daily; must converge, not compound.
  const due = new Date(Date.now() - 53 * 86_400_000);
  const fixedNow = new Date();
  const a = billing.computeLateFee({ base: 5000, dueDate: due, ratePctPerMonth: 1.5, gracePeriodDays: 7, now: fixedNow });
  const b = billing.computeLateFee({ base: 5000, dueDate: due, ratePctPerMonth: 1.5, gracePeriodDays: 7, now: fixedNow });
  assert.equal(a.lateFee, b.lateFee);
  assert.equal(a.daysOver, b.daysOver);
});

// --- R2-followup — validatePaymentAmount two-tier acceptance --------------
// Slip payment uploaded BEFORE scheduler.tickLateFee fires must still be
// accepted when admin verifies AFTER tickLateFee has added a penalty.
// Tier matrix:
//   - 'exact'     → amount ≈ current bills.total (post late_fee)
//   - 'principal' → amount ≈ subtotal+vat (paid in good faith before fee)
//   - 'none'      → neither tier matched → reject

test('validatePaymentAmount: exact match → tier="exact" (no late_fee)', () => {
  const r = billing.validatePaymentAmount({ amount: 5000, total: 5000, lateFee: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'exact');
  assert.equal(r.lateFeeOutstanding, 0);
});

test('validatePaymentAmount: exact match with late_fee already paid → tier="exact"', () => {
  // Tenant pays full total (5000 + 90 late_fee = 5090).
  const r = billing.validatePaymentAmount({ amount: 5090, total: 5090, lateFee: 90 });
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'exact');
  assert.equal(r.lateFeeOutstanding, 0);
});

test('validatePaymentAmount: principal-tier match → tier="principal", outstanding=late_fee', () => {
  // Bill total grew from 5000 to 5090 after late_fee. Tenant paid 5000
  // (the original total they saw before tickLateFee fired).
  const r = billing.validatePaymentAmount({ amount: 5000, total: 5090, lateFee: 90 });
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'principal');
  assert.equal(r.principal, 5000);
  assert.equal(r.lateFeeOutstanding, 90);
});

test('validatePaymentAmount: amount in middle → reject, report closer reference', () => {
  // 5045 is between principal (5000) and total (5090) — not close enough
  // to either within 1฿ tolerance → reject.
  const r = billing.validatePaymentAmount({ amount: 5045, total: 5090, lateFee: 90 });
  assert.equal(r.ok, false);
  assert.equal(r.tier, 'none');
  // Closest reference (whichever is nearer) reported back for clearer error.
  assert.ok(r.closest === 5000 || r.closest === 5090);
});

test('validatePaymentAmount: bank-rounding tolerance ±1฿', () => {
  // PromptPay rounds 0.50, some processors ±1.00. We allow 1฿ either way.
  assert.equal(billing.validatePaymentAmount({ amount: 5000.5, total: 5000, lateFee: 0 }).ok, true);
  assert.equal(billing.validatePaymentAmount({ amount: 4999.5, total: 5000, lateFee: 0 }).ok, true);
  assert.equal(billing.validatePaymentAmount({ amount: 5001.5, total: 5000, lateFee: 0 }).ok, false);
});

test('validatePaymentAmount: when late_fee=0, principal tier collapses to exact', () => {
  // No late_fee → principal == total → only one path to match.
  const r = billing.validatePaymentAmount({ amount: 5000, total: 5000, lateFee: 0 });
  assert.equal(r.tier, 'exact');
  // The reverse case (amount far from total, no late_fee) is unambiguous reject.
  const bad = billing.validatePaymentAmount({ amount: 100, total: 5000, lateFee: 0 });
  assert.equal(bad.ok, false);
  assert.equal(bad.tier, 'none');
});

test('validatePaymentAmount: invalid inputs → safe reject (no NaN propagation)', () => {
  assert.equal(billing.validatePaymentAmount({}).ok, false);
  assert.equal(billing.validatePaymentAmount({ amount: NaN, total: 5000 }).ok, false);
  assert.equal(billing.validatePaymentAmount({ amount: 5000, total: 0 }).ok, false);
  assert.equal(billing.validatePaymentAmount({ amount: -100, total: 5000 }).ok, false);
});

test('validatePaymentAmount: custom tolerance honoured', () => {
  // Caller can tighten/loosen the tolerance for special cases. Tightening
  // to 0 means strict equality (no float drift allowed).
  assert.equal(billing.validatePaymentAmount({ amount: 5000.5, total: 5000, lateFee: 0, tolerance: 0 }).ok, false);
  // Loosening to 50 (e.g. legacy migration tolerating bigger drift).
  assert.equal(billing.validatePaymentAmount({ amount: 5040, total: 5000, lateFee: 0, tolerance: 50 }).ok, true);
});

test('validatePaymentAmount: accepts exact total and principal before late fee', () => {
  const exact = billing.validatePaymentAmount({ amount: 5090, total: 5090, lateFee: 90 });
  assert.equal(exact.ok, true);
  assert.equal(exact.tier, 'exact');
  assert.equal(exact.lateFeeOutstanding, 0);

  const principal = billing.validatePaymentAmount({ amount: 5000, total: 5090, lateFee: 90 });
  assert.equal(principal.ok, true);
  assert.equal(principal.tier, 'principal');
  assert.equal(principal.principal, 5000);
  assert.equal(principal.lateFeeOutstanding, 90);

  const mismatch = billing.validatePaymentAmount({ amount: 100, total: 5090, lateFee: 90 });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.tier, 'none');
});

test('validatePaidLedger: accepts settled ledger within payment tolerance', () => {
  const r = billing.validatePaidLedger({ paymentAmount: 5000.5, billTotal: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.code, 'OK');
  assert.equal(r.diff, 0.5);
});

test('validatePaidLedger: rejects paid bill/payment drift', () => {
  const r = billing.validatePaidLedger({ paymentAmount: 5000, billTotal: 5090 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PAID_LEDGER_INCONSISTENT');
  assert.equal(r.paymentAmount, 5000);
  assert.equal(r.billTotal, 5090);
});

test('validatePaidLedger: invalid inputs fail closed', () => {
  assert.equal(billing.validatePaidLedger({}).ok, false);
  assert.equal(billing.validatePaidLedger({ paymentAmount: NaN, billTotal: 5000 }).code, 'INVALID_PAID_LEDGER');
  assert.equal(billing.validatePaidLedger({ paymentAmount: 5000, billTotal: 0 }).code, 'INVALID_PAID_LEDGER');
  assert.equal(billing.validatePaidLedger({ paymentAmount: -100, billTotal: 5000 }).code, 'INVALID_PAID_LEDGER');
});

// --- Unmark-paid restore math ----------------------------------------------
// POST /api/bills/:id/unmark-paid reverses a paid bill. The restored late_fee
// must be recomputed from the PRINCIPAL (subtotal+vat), never from `total`
// (which on an exact-tier payment still contains the previous fee). The
// regression these guard against: recomputing on total → fee-on-fee +
// total ≠ subtotal+vat+late_fee. Reference bill: principal 5000 (4900+100 vat),
// 30 days overdue, 3%/month, grace 0 → fee = 5000 × 0.03 × 1 = 150.
const DAY = 86_400_000;
const dueT0 = '2026-01-01';
const now30 = new Date(new Date(dueT0).getTime() + 30 * DAY);

test('computeRestoredBillAmounts: exact-tier paid → overdue recomputes fee from principal (no fee-on-fee)', () => {
  // Bill was paid in full incl. a 100฿ late_fee (total 5100). On unmark the
  // fee must be recomputed on principal 5000 → 150, NOT on 5100 (→153) and
  // NOT 5100+153.
  const r = billing.computeRestoredBillAmounts({
    subtotal: 4900, vat: 100, lateFee: 100, total: 5100,
    dueDate: dueT0, now: now30,
    lateFeeEnabled: true, ratePctPerMonth: 3, gracePeriodDays: 0,
  });
  assert.equal(r.status, 'overdue');
  assert.equal(r.principal, 5000);
  assert.equal(r.lateFee, 150);
  assert.equal(r.total, 5150);
  // Invariant holds: total === principal + lateFee.
  assert.equal(r.total, r.principal + r.lateFee);
});

test('computeRestoredBillAmounts: principal-tier paid (fee waived) → overdue re-applies fee', () => {
  // Previous verify waived the fee (late_fee 0, total 5000). Restoring an
  // overdue bill re-applies the fee from principal.
  const r = billing.computeRestoredBillAmounts({
    subtotal: 4900, vat: 100, lateFee: 0, total: 5000,
    dueDate: dueT0, now: now30,
    lateFeeEnabled: true, ratePctPerMonth: 3, gracePeriodDays: 0,
  });
  assert.equal(r.lateFee, 150);
  assert.equal(r.total, 5150);
});

test('computeRestoredBillAmounts: late-fee feature OFF preserves the assessed fee, keeps invariant', () => {
  // Feature off → don't recompute, but don't silently forgive the fee that
  // was already on the bill. Preserve 100 and keep total = principal + fee.
  const r = billing.computeRestoredBillAmounts({
    subtotal: 4900, vat: 100, lateFee: 100, total: 5100,
    dueDate: dueT0, now: now30,
    lateFeeEnabled: false,
  });
  assert.equal(r.status, 'overdue');
  assert.equal(r.principal, 5000);
  assert.equal(r.lateFee, 100);
  assert.equal(r.total, 5100);
});

test('computeRestoredBillAmounts: not yet past due → pending, no late fee', () => {
  const future = '2999-01-01';
  const r = billing.computeRestoredBillAmounts({
    subtotal: 5000, vat: 0, lateFee: 0, total: 5000,
    dueDate: future, now: new Date('2026-05-23'),
    lateFeeEnabled: true, ratePctPerMonth: 3, gracePeriodDays: 0,
  });
  assert.equal(r.status, 'pending');
  assert.equal(r.lateFee, 0);
  assert.equal(r.total, 5000);
});

test('computeRestoredBillAmounts: legacy row without subtotal/vat falls back to total - late_fee', () => {
  // Pre-migration bills never persisted subtotal/vat. Principal must fall
  // back to total - late_fee (5100 - 100 = 5000), not collapse to 0.
  const r = billing.computeRestoredBillAmounts({
    subtotal: 0, vat: 0, lateFee: 100, total: 5100,
    dueDate: dueT0, now: now30,
    lateFeeEnabled: true, ratePctPerMonth: 3, gracePeriodDays: 0,
  });
  assert.equal(r.principal, 5000);
  assert.equal(r.lateFee, 150);
  assert.equal(r.total, 5150);
});

test('computeRestoredBillAmounts: within grace window → fee 0 even when overdue', () => {
  // 5 days overdue but 7-day grace → no fee yet.
  const now5 = new Date(new Date(dueT0).getTime() + 5 * DAY);
  const r = billing.computeRestoredBillAmounts({
    subtotal: 4900, vat: 100, lateFee: 0, total: 5000,
    dueDate: dueT0, now: now5,
    lateFeeEnabled: true, ratePctPerMonth: 3, gracePeriodDays: 7,
  });
  assert.equal(r.status, 'overdue');
  assert.equal(r.lateFee, 0);
  assert.equal(r.total, 5000);
});

// --- Defensive readings handling -------------------------------------------
// The bill PDF + tenant portal must always show before/after meter info
// (even when one or both readings are missing) so the customer can audit
// the unit count. Defaults to "—" for missing sides + flags anomalies
// (meter reset, units mismatch) so admin can fix before the bill goes out.

test('buildUtilityItem: both readings → normal เลขก่อน/หลัง detail', () => {
  const usage = { units: 10, prevReading: 100, currentReading: 110, hasReadings: true };
  const item = billing.buildUtilityItem('ค่าน้ำ', usage, 18, 180);
  assert.match(item.detail, /เลขก่อน 100/);
  assert.match(item.detail, /เลขหลัง 110/);
  assert.match(item.detail, /ใช้ 10 หน่วย/);
  assert.doesNotMatch(item.detail, /ไม่ครบ|ลดลง|ไม่ตรง/);
});

test('buildUtilityItem: only prev reading → marked incomplete with dash', () => {
  const usage = { units: 0, prevReading: 100, currentReading: null, hasReadings: false };
  const item = billing.buildUtilityItem('ค่าน้ำ', usage, 18, 0);
  assert.match(item.detail, /เลขก่อน 100/);
  assert.match(item.detail, /เลขหลัง —/);
  assert.match(item.detail, /ข้อมูลไม่ครบ/);
});

test('buildUtilityItem: only current reading → marked incomplete with dash', () => {
  const usage = { units: 0, prevReading: null, currentReading: 110, hasReadings: false };
  const item = billing.buildUtilityItem('ค่าน้ำ', usage, 18, 0);
  assert.match(item.detail, /เลขก่อน —/);
  assert.match(item.detail, /เลขหลัง 110/);
  assert.match(item.detail, /ข้อมูลไม่ครบ/);
});

test('buildUtilityItem: no readings but units > 0 → "ไม่ได้บันทึกเลขมิเตอร์"', () => {
  const usage = { units: 5, prevReading: null, currentReading: null, hasReadings: false };
  const item = billing.buildUtilityItem('ค่าน้ำ', usage, 18, 90);
  assert.match(item.detail, /ใช้ 5 หน่วย/);
  assert.match(item.detail, /ไม่ได้บันทึกเลขมิเตอร์/);
});

test('buildUtilityItem: no readings + no usage → "ไม่มีการใช้งาน"', () => {
  const usage = { units: 0, prevReading: null, currentReading: null, hasReadings: false };
  const item = billing.buildUtilityItem('ค่าน้ำ', usage, 18, 0);
  assert.equal(item.detail, 'ไม่มีการใช้งาน');
});

test('buildUtilityItem: meter went backwards → flagged with warning', () => {
  // Common cause: meter rolled over (digital reset) or admin typo. Don't
  // silently bill a negative number — surface the anomaly in the detail
  // line so admin sees it before sending. Caller is expected to clamp
  // units to 0 (resolveUtilityUsage does this).
  const usage = { units: 0, prevReading: 200, currentReading: 100, hasReadings: true };
  const item = billing.buildUtilityItem('ค่าน้ำ', usage, 18, 0);
  assert.match(item.detail, /มิเตอร์ลดลง/);
});

test('buildUtilityItem: units mismatch derived (admin override) → flagged', () => {
  // Stored units=50 but readings imply 10 — admin manually overrode.
  // The bill prints stored units (the legal record) but the detail line
  // shows the mismatch so admin sees it.
  const usage = { units: 50, prevReading: 100, currentReading: 110, hasReadings: true };
  const item = billing.buildUtilityItem('ค่าน้ำ', usage, 18, 900);
  assert.match(item.detail, /หน่วยไม่ตรงกับเลขมิเตอร์/);
  assert.match(item.detail, /คำนวณได้ 10/);
});

test('buildUtilityItem: NaN/null rate → drops × rate tail without crash', () => {
  const usage = { units: 5, prevReading: 100, currentReading: 105, hasReadings: true };
  // null rate → no × tail in qty
  const item = billing.buildUtilityItem('ค่าน้ำ', usage, null, 0);
  assert.equal(item.qty, '5 หน่วย');
  // NaN amount → coerced to 0
  const itemNaN = billing.buildUtilityItem('ค่าน้ำ', usage, NaN, NaN);
  assert.equal(itemNaN.amount, 0);
});

test('buildUtilityItem: undefined usage → safe defaults (no crash)', () => {
  const item = billing.buildUtilityItem('ค่าน้ำ', undefined, 18, 0);
  assert.equal(item.qty, '0 หน่วย × 18');
  assert.equal(item.amount, 0);
  assert.equal(item.detail, 'ไม่มีการใช้งาน');
});

test('resolveUtilityUsage: clamps negative readings delta to 0', () => {
  // Defence-in-depth — buildUtilityItem also flags this, but the resolver
  // must not bill the tenant for negative units even when called directly.
  const room = { waterPrevReading: 200, waterCurrentReading: 100, waterUnits: 999 };
  const u = billing.resolveUtilityUsage(room, 'water');
  assert.equal(u.units, 0);
  assert.equal(u.prevReading, 200);
  assert.equal(u.currentReading, 100);
});

test('resolveUtilityUsage: missing room object → zero-shape (no crash)', () => {
  const u = billing.resolveUtilityUsage(null, 'water');
  assert.equal(u.units, 0);
  assert.equal(u.prevReading, null);
  assert.equal(u.currentReading, null);
  assert.equal(u.hasReadings, false);
});

test('resolveUtilityUsageFromBillRow: snake_case fields → same shape', () => {
  const row = {
    water_prev_reading: 100,
    water_current_reading: 110,
    water_units: 10,
  };
  const u = billing.resolveUtilityUsageFromBillRow(row, 'water');
  assert.equal(u.units, 10);
  assert.equal(u.prevReading, 100);
  assert.equal(u.currentReading, 110);
  assert.equal(u.hasReadings, true);
});

test('resolveUtilityUsageFromBillRow: NaN/missing fields → defensive zero-shape', () => {
  const u1 = billing.resolveUtilityUsageFromBillRow({}, 'water');
  assert.equal(u1.units, 0);
  assert.equal(u1.hasReadings, false);
  const u2 = billing.resolveUtilityUsageFromBillRow(null, 'elec');
  assert.equal(u2.units, 0);
  // NaN-coerced units come back as 0, not NaN
  const u3 = billing.resolveUtilityUsageFromBillRow({ water_units: 'oops' }, 'water');
  assert.equal(u3.units, 0);
});

// --- Per-room utility rate override ----------------------------------------
// Each room may set its own water/elec rate (and wifi fee) — useful when
// admin runs two tariff tiers in the same building. Override priority:
// room.{water,elec}RateOverride / room.wifiOverride (or snake_case) → falls
// back to config.utilities. Negative / NaN / empty strings slip back to
// global so a typo can't accidentally credit the tenant.

test('buildBill: per-room waterRateOverride beats config.utilities.waterRate', () => {
  const flags = { lateFee: { enabled: false }, vat: { enabled: false } };
  const room = { ...baseRoom, waterRateOverride: 25 };  // global=18
  const bill = billing.buildBill({ room, config: baseConfig, features: flags });
  // 5 units × 25 = 125 (not 5 × 18 = 90)
  assert.equal(bill.waterRate, 25);
  assert.equal(bill.waterAmount, 125);
  assert.equal(bill.waterRateSource, 'override');
});

test('buildBill: per-room elecRateOverride beats config.utilities.elecRate', () => {
  const flags = { lateFee: { enabled: false }, vat: { enabled: false } };
  const room = { ...baseRoom, elecRateOverride: 12 };
  const bill = billing.buildBill({ room, config: baseConfig, features: flags });
  // 100 units × 12 = 1200
  assert.equal(bill.elecRate, 12);
  assert.equal(bill.elecAmount, 1200);
  assert.equal(bill.elecRateSource, 'override');
});

test('buildBill: per-room wifi override honors zero (free wifi for this unit)', () => {
  const flags = { lateFee: { enabled: false }, vat: { enabled: false } };
  const room = { ...baseRoom, wifi: 0 };  // explicit 0 = free wifi
  const bill = billing.buildBill({ room, config: baseConfig, features: flags });
  assert.equal(bill.wifi, 0);
  assert.equal(bill.wifiFeeSource, 'override');
  // wifi=0 → no line item on the bill (preserves prior behaviour)
  assert.equal(bill.items.find((it) => it.label === 'ค่าอินเทอร์เน็ต'), undefined);
});

test('buildBill: per-room wifi override accepts higher number', () => {
  const flags = { lateFee: { enabled: false }, vat: { enabled: false } };
  const room = { ...baseRoom, wifi: 500 };  // global=250
  const bill = billing.buildBill({ room, config: baseConfig, features: flags });
  assert.equal(bill.wifi, 500);
  assert.equal(bill.wifiFeeSource, 'override');
});

test('buildBill: negative/NaN override falls back to global rate (no typo discount)', () => {
  const flags = { lateFee: { enabled: false }, vat: { enabled: false } };
  // Negative → fallback to global
  const r1 = { ...baseRoom, waterRateOverride: -5 };
  const b1 = billing.buildBill({ room: r1, config: baseConfig, features: flags });
  assert.equal(b1.waterRate, 18, 'negative override must fall back to global');
  assert.equal(b1.waterRateSource, 'global');
  // NaN → fallback
  const r2 = { ...baseRoom, elecRateOverride: 'not-a-number' };
  const b2 = billing.buildBill({ room: r2, config: baseConfig, features: flags });
  assert.equal(b2.elecRate, 8);
  assert.equal(b2.elecRateSource, 'global');
  // Empty string → fallback
  const r3 = { ...baseRoom, waterRateOverride: '' };
  const b3 = billing.buildBill({ room: r3, config: baseConfig, features: flags });
  assert.equal(b3.waterRate, 18);
});

test('buildBill: snake_case override keys also work (rooms_v2 column shape)', () => {
  const flags = { lateFee: { enabled: false }, vat: { enabled: false } };
  const room = { ...baseRoom, water_rate_override: 20, elec_rate_override: 10 };
  const bill = billing.buildBill({ room, config: baseConfig, features: flags });
  assert.equal(bill.waterRate, 20);
  assert.equal(bill.elecRate, 10);
});

test('buildBill: no override → both source = global, rates match config', () => {
  const flags = { lateFee: { enabled: false }, vat: { enabled: false } };
  const bill = billing.buildBill({ room: baseRoom, config: baseConfig, features: flags });
  assert.equal(bill.waterRate, 18);
  assert.equal(bill.elecRate, 8);
  assert.equal(bill.waterRateSource, 'global');
  assert.equal(bill.elecRateSource, 'global');
  assert.equal(bill.wifiFeeSource, 'global');
});

// --- Flat (เหมา) billing mode ---------------------------------------------
// Some rooms don't have a real meter — admin bundles water/elec as a flat
// monthly fee. Toggled per-room at /admin#rooms, so one building can mix
// metered + flat rooms freely. Bill must surface "ค่าน้ำเหมา" so the
// tenant doesn't dispute "why charged 300 when meter says 5 units".

test('buildBill: water flat mode → charges flat amount, zero units/rate', () => {
  const flags = { lateFee: { enabled: false }, vat: { enabled: false } };
  const room = { ...baseRoom, waterMode: 'flat', waterFlatAmount: 300, waterUnits: 999 };
  const bill = billing.buildBill({ room, config: baseConfig, features: flags });
  assert.equal(bill.waterAmount, 300);
  assert.equal(bill.waterUnits, 0, 'flat mode drops units (legal record)');
  assert.equal(bill.waterRate, 0, 'flat mode zeros rate so qty line not "× 0"');
  assert.equal(bill.waterMode, 'flat');
  // No prev/current readings on flat — clears the audit trail noise.
  assert.equal(bill.waterPrevReading, null);
  assert.equal(bill.waterCurrentReading, null);
  // Item label includes "(เหมา)" so the bill PDF + tenant view make
  // the billing mode explicit.
  const waterItem = bill.items.find((it) => /ค่าน้ำ/.test(it.label));
  assert.match(waterItem.label, /เหมา/);
  assert.match(waterItem.detail, /เหมารายเดือน/);
});

test('buildBill: elec flat mode is independent from water', () => {
  // Same room can have metered water + flat elec (or vice-versa) — common
  // for older units where elec meter exists but water is shared.
  const flags = { lateFee: { enabled: false }, vat: { enabled: false } };
  const room = {
    ...baseRoom,
    waterMode: 'metered', waterUnits: 5,
    elecMode: 'flat', elecFlatAmount: 500,
  };
  const bill = billing.buildBill({ room, config: baseConfig, features: flags });
  assert.equal(bill.waterMode, 'metered');
  assert.equal(bill.waterAmount, 90);  // 5 × 18
  assert.equal(bill.elecMode, 'flat');
  assert.equal(bill.elecAmount, 500);
});

test('buildBill: flat mode with missing amount → falls back to metered + flag', () => {
  // Safety: if admin selected flat but never typed an amount, don't charge 0
  // — fall back to the metered formula and surface waterFlatFellBack so
  // /admin#billing can warn admin to set the amount.
  const flags = { lateFee: { enabled: false }, vat: { enabled: false } };
  const room = { ...baseRoom, waterMode: 'flat', waterFlatAmount: null };
  const bill = billing.buildBill({ room, config: baseConfig, features: flags });
  assert.equal(bill.waterMode, 'metered', 'falls back when amount missing');
  assert.equal(bill.waterFlatFellBack, true, 'fellBack flag set for admin to notice');
  assert.equal(bill.waterAmount, 90);  // metered path: 5 × 18
});

test('buildBill: flat mode with negative amount → falls back to metered + flag', () => {
  const flags = { lateFee: { enabled: false }, vat: { enabled: false } };
  const room = { ...baseRoom, elecMode: 'flat', elecFlatAmount: -100 };
  const bill = billing.buildBill({ room, config: baseConfig, features: flags });
  assert.equal(bill.elecMode, 'metered');
  assert.equal(bill.elecFlatFellBack, true);
});

test('buildBill: flat mode with snake_case keys (rooms_v2 column shape)', () => {
  const flags = { lateFee: { enabled: false }, vat: { enabled: false } };
  const room = { ...baseRoom, water_mode: 'flat', water_flat_amount: 250 };
  const bill = billing.buildBill({ room, config: baseConfig, features: flags });
  assert.equal(bill.waterMode, 'flat');
  assert.equal(bill.waterAmount, 250);
});

test('isFlatUtilityConfigured requires mode=flat and a positive amount', () => {
  assert.equal(billing.isFlatUtilityConfigured({ waterMode: 'flat', waterFlatAmount: 300 }, 'water'), true);
  assert.equal(billing.isFlatUtilityConfigured({ water_mode: 'flat', water_flat_amount: 300 }, 'water'), true);
  assert.equal(billing.isFlatUtilityConfigured({ waterMode: 'flat', waterFlatAmount: 0 }, 'water'), false);
  assert.equal(billing.isFlatUtilityConfigured({ waterMode: 'flat', waterFlatAmount: null }, 'water'), false);
  assert.equal(billing.isFlatUtilityConfigured({ waterMode: 'metered', waterFlatAmount: 300 }, 'water'), false);
});

test('buildBill: default mode (no field) → metered (backward compat)', () => {
  const flags = { lateFee: { enabled: false }, vat: { enabled: false } };
  const bill = billing.buildBill({ room: baseRoom, config: baseConfig, features: flags });
  assert.equal(bill.waterMode, 'metered');
  assert.equal(bill.elecMode, 'metered');
});

// --- Flat-mode stored-bill round-trip --------------------------------------
// New bills are generated through buildBill (which has direct access to the
// mode flag), but admin / tenant later VIEW the same bill from the DB row.
// The bills table doesn't carry a `mode` column; the renderer must infer
// flat from value shape (amount > 0, rate = 0, units = 0, no readings) so
// stored flat bills render with the same "ค่าเหมา" message as freshly-
// generated ones.

test('buildUtilityItem: stored flat bill (no readings, rate=0, units=0, amount>0) renders เหมา', () => {
  const usage = billing.resolveUtilityUsageFromBillRow({
    water_units: 0,
    water_rate: 0,
    water_prev_reading: null,
    water_current_reading: null,
  }, 'water');
  const item = billing.buildUtilityItem('ค่าน้ำ', usage, 0, 300);
  assert.match(item.detail, /ค่าเหมารายเดือน/);
  assert.equal(item.qty, '1 เดือน');
  assert.equal(item.amount, 300);
});

test('buildUtilityItem: zero-amount + zero-everything still says "ไม่มีการใช้งาน" not "เหมา"', () => {
  // Critical distinction: amount=0 means no charge (legitimately no usage).
  // Only amount > 0 with the rest at zero indicates flat mode.
  const usage = { units: 0, prevReading: null, currentReading: null, hasReadings: false };
  const item = billing.buildUtilityItem('ค่าน้ำ', usage, 0, 0);
  assert.equal(item.detail, 'ไม่มีการใช้งาน');
  assert.doesNotMatch(item.detail, /เหมา/);
});

test('buildUtilityItem: metered bill with readings is not misclassified as flat', () => {
  // amount > 0 + rate > 0 + readings present → metered, never flat.
  const usage = { units: 5, prevReading: 100, currentReading: 105, hasReadings: true };
  const item = billing.buildUtilityItem('ค่าน้ำ', usage, 18, 90);
  assert.doesNotMatch(item.detail, /เหมา/);
  assert.match(item.detail, /เลขก่อน 100/);
});

test('buildBill: flat amount + late fee + VAT all compose into the right total', () => {
  // Integration check: flat row participates in subtotal so VAT / late-fee
  // computations downstream see the right total. Without flat in subtotal
  // a tenant on a 300฿ water-flat + VAT 7% deal would underpay by ~21฿.
  const flags = { lateFee: { enabled: false }, vat: { enabled: true, ratePct: 7 } };
  const room = { ...baseRoom, waterMode: 'flat', waterFlatAmount: 300, elecUnits: 0, waterUnits: 0 };
  const cfg = { ...baseConfig, utilities: { waterRate: 0, elecRate: 0, wifi: 0 } };
  const bill = billing.buildBill({ room, config: cfg, features: flags });
  // rent 5000 + water flat 300 + elec 0 = subtotal 5300
  assert.equal(bill.subtotal, 5300);
  // VAT 7% on 5300 = 371
  assert.equal(bill.vat, 371);
  assert.equal(bill.total, 5671);
});

test('isChargeApplicableForPeriod: rejects YYYY-13 / YYYY-00 outside 01-12', () => {
  // Bill period must be a real Gregorian month. The matching regex in
  // /api/bills/bulk-generate accepts only digit count, so the recurring
  // filter is the last line of defence — reject 2026-13 / 2026-00 here
  // so quarterly anchor math doesn't wrap silently.
  const charge = { frequency: 'monthly' };
  assert.equal(billing.isChargeApplicableForPeriod(charge, '2026-13'), false);
  assert.equal(billing.isChargeApplicableForPeriod(charge, '2026-00'), false);
  assert.equal(billing.isChargeApplicableForPeriod(charge, '2026-05'), true);
});

test('buildPaymentBlock: payment.promptpay (form key) wins over legacy promptpayTarget', () => {
  const block = billing.buildPaymentBlock({ payment: { promptpay: '0801234567', promptpayTarget: '0900000000' } });
  assert.equal(block.promptpayTarget, '0801234567');
});

test('buildPaymentBlock: legacy promptpayTarget still works when payment.promptpay missing', () => {
  const block = billing.buildPaymentBlock({ payment: { promptpayTarget: '0812345678' } });
  assert.equal(block.promptpayTarget, '0812345678');
});

test('buildPaymentBlock: bank info + extra channels surface in paymentMethods', () => {
  const block = billing.buildPaymentBlock({
    payment: {
      promptpay: '0801234567',
      bank: 'ไทยพาณิชย์', bankAcc: '123-456789-0', bankName: 'นางกาญจนา ศรีสุข',
      linePay: true, truemoney: false, creditCard: true,
    },
  });
  assert.deepEqual(block.bankInfo, { bank: 'ไทยพาณิชย์', account: '123-456789-0', name: 'นางกาญจนา ศรีสุข' });
  const keys = block.paymentMethods.map((m) => m.key);
  assert.deepEqual(keys, ['promptpay', 'bank', 'linePay', 'creditCard']);
  assert.equal(block.promptpayName, 'นางกาญจนา ศรีสุข');
});

test('buildPaymentBlock: TrueMoney Wallet requires toggle plus valid phone', () => {
  const off = billing.buildPaymentBlock({
    payment: { truemoney: false, truemoneyPhone: '0812345678' },
  });
  assert.equal(off.walletInfo, null);
  assert.equal(off.paymentMethods.some((m) => m.key === 'truemoney'), false);

  const missingPhone = billing.buildPaymentBlock({
    payment: { truemoney: true, truemoneyPhone: '' },
  });
  assert.equal(missingPhone.walletInfo, null);
  assert.equal(missingPhone.paymentMethods.find((m) => m.key === 'truemoney').enabled, false);

  const ready = billing.buildPaymentBlock({
    payment: {
      truemoney: true,
      truemoneyPhone: '081-234-5678',
      truemoneyName: 'หอพัก ก.',
      truemoneyNote: 'โอนแล้วแนบสลิป',
    },
  });
  assert.deepEqual(ready.walletInfo, {
    provider: 'TrueMoney Wallet',
    phone: '0812345678',
    name: 'หอพัก ก.',
    note: 'โอนแล้วแนบสลิป',
  });
  const method = ready.paymentMethods.find((m) => m.key === 'truemoney');
  assert.equal(method.enabled, true);
  assert.equal(method.manualOnly, true);
  assert.equal(method.requiresSlip, true);
  assert.match(method.label, /0812345678/);
});

test('buildPaymentBlock: empty config returns empty block (no nulls in spread)', () => {
  const block = billing.buildPaymentBlock({});
  assert.equal(block.promptpayTarget, undefined);
  assert.equal(block.bankInfo, null);
  assert.equal(block.walletInfo, null);
  assert.deepEqual(block.paymentMethods, []);
});

test('buildBill: includes paymentMethods + bankInfo from config.payment', () => {
  const flags = { lateFee: { enabled: false }, vat: { enabled: false } };
  const cfg = {
    ...baseConfig,
    payment: { promptpay: '0801234567', bank: 'KBank', bankAcc: '111-2-22222-2', bankName: 'A B', linePay: true },
  };
  const bill = billing.buildBill({ room: baseRoom, config: cfg, features: flags });
  assert.equal(bill.promptpayTarget, '0801234567');
  assert.equal(bill.bankInfo.account, '111-2-22222-2');
  assert.ok(bill.paymentMethods.find((m) => m.key === 'linePay'));
});

// --- Timezone stability — late fee must not oscillate by tick hour ----------
// db/pool.js returns DATE columns as raw "YYYY-MM-DD" strings. Parsing those
// as UTC midnight (the old bug) made daysOver/lateFee jump by ±1 depending on
// the hour the hourly scheduler ran, during the 00:00–07:00 Asia/Bangkok
// window. parseDueDateLocal anchors to LOCAL midnight so the count is stable
// for the whole calendar day. These tests force TZ-sensitive instants.
test('computeLateFee: daysOver is stable across the local day (no UTC off-by-one)', () => {
  const prevTZ = process.env.TZ;
  process.env.TZ = 'Asia/Bangkok';
  try {
    const dueDate = '2026-05-29'; // string, exactly as it comes back from pg
    const at = (iso) => billing.computeLateFee({
      base: 5000, dueDate, ratePctPerMonth: 10, gracePeriodDays: 0, now: new Date(iso),
    }).daysOver;
    // Every hour of May 30 (Bangkok) must report the SAME 1 day overdue.
    assert.equal(at('2026-05-30T00:30:00+07:00'), 1, '00:30 ICT');
    assert.equal(at('2026-05-30T06:59:00+07:00'), 1, '06:59 ICT (was 0 under the UTC bug)');
    assert.equal(at('2026-05-30T12:00:00+07:00'), 1, '12:00 ICT');
    assert.equal(at('2026-05-30T23:59:00+07:00'), 1, '23:59 ICT');
    // Due date itself → 0; the next calendar day → 2.
    assert.equal(at('2026-05-29T15:00:00+07:00'), 0, 'on the due date');
    assert.equal(at('2026-05-31T01:00:00+07:00'), 2, 'two days later');
  } finally {
    process.env.TZ = prevTZ;
  }
});

test('parseDueDateLocal: string → local midnight; Date → passthrough; junk → null', () => {
  const d = billing.parseDueDateLocal('2026-05-29');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 4); // May (0-indexed)
  assert.equal(d.getDate(), 29);
  assert.equal(d.getHours(), 0, 'anchored to local midnight');
  const real = new Date('2026-01-02T03:04:05Z');
  assert.equal(billing.parseDueDateLocal(real), real, 'Date instance passes through');
  assert.equal(billing.parseDueDateLocal('not-a-date'), null);
  assert.equal(billing.parseDueDateLocal(''), null);
  assert.equal(billing.parseDueDateLocal(null), null);
});

// --- resolvePrincipalLateFee (admin-choice late-fee policy) ----------------
test('resolvePrincipalLateFee: not a principal-with-late-fee situation → no-op', () => {
  const noop = { applies: false, settle: false, action: null };
  assert.deepEqual(billing.resolvePrincipalLateFee({ tier: 'exact', lateFee: 90 }), noop);
  assert.deepEqual(billing.resolvePrincipalLateFee({ tier: 'principal', lateFee: 0 }), noop);
  assert.deepEqual(billing.resolvePrincipalLateFee({ tier: 'none', lateFee: 90 }), noop);
});

test('resolvePrincipalLateFee: principal+lateFee requires an explicit decision', () => {
  // Default: applies but does NOT settle (admin must choose / slip parks pending)
  assert.deepEqual(
    billing.resolvePrincipalLateFee({ tier: 'principal', lateFee: 90 }),
    { applies: true, settle: false, action: null });
  // Each explicit admin action settles this bill at principal
  for (const action of ['waive', 'carry']) {
    assert.deepEqual(
      billing.resolvePrincipalLateFee({ tier: 'principal', lateFee: 90, action }),
      { applies: true, settle: true, action },
      `action '${action}' must settle this bill`);
  }
  // Legacy adminWaive:true alias still waives
  assert.deepEqual(
    billing.resolvePrincipalLateFee({ tier: 'principal', lateFee: 90, adminWaive: true }),
    { applies: true, settle: true, action: 'waive' });
  // Operator opted into auto-waive (tenant auto-verify path) → waive
  assert.deepEqual(
    billing.resolvePrincipalLateFee({ tier: 'principal', lateFee: 90, autoWaive: true }),
    { applies: true, settle: true, action: 'waive' });
  // Only a strict boolean true / known action settles — truthy strings / bogus must not
  assert.equal(
    billing.resolvePrincipalLateFee({ tier: 'principal', lateFee: 90, adminWaive: 'yes' }).settle,
    false);
  assert.equal(
    billing.resolvePrincipalLateFee({ tier: 'principal', lateFee: 90, action: 'bogus' }).settle,
    false);
});

// --- firstMonthProrationFraction (symmetric move-in proration) -------------
test('firstMonthProrationFraction: off (default) always charges the full month', () => {
  assert.equal(billing.firstMonthProrationFraction({ moveInDay: 20, daysInMonth: 30 }), 1);
  assert.equal(billing.firstMonthProrationFraction({ moveInDay: 1, daysInMonth: 31, prorate: false }), 1);
});

test('firstMonthProrationFraction: on → days lived (inclusive of move-in day)', () => {
  // Move in on the 1st → full month
  assert.equal(billing.firstMonthProrationFraction({ moveInDay: 1, daysInMonth: 30, prorate: true }), 1);
  // Move in on the 20th of a 30-day month → 11 days lived (20..30 inclusive)
  assert.equal(billing.firstMonthProrationFraction({ moveInDay: 20, daysInMonth: 30, prorate: true }), 11 / 30);
  // Last day of a 31-day month → 1/31
  assert.equal(billing.firstMonthProrationFraction({ moveInDay: 31, daysInMonth: 31, prorate: true }), 1 / 31);
});

test('firstMonthProrationFraction: invalid inputs fall back to full month', () => {
  assert.equal(billing.firstMonthProrationFraction({ moveInDay: NaN, daysInMonth: 30, prorate: true }), 1);
  assert.equal(billing.firstMonthProrationFraction({ moveInDay: 10, daysInMonth: 0, prorate: true }), 1);
  // Day beyond the month is clamped to 0 charged days (never negative)
  assert.equal(billing.firstMonthProrationFraction({ moveInDay: 40, daysInMonth: 30, prorate: true }), 0);
});

test("computeLateFee: caps (maxPctOfPrincipal / maxBaht) bound runaway accrual", () => {
  // 10,000 principal, 1.5%/mo, no grace, 300 days overdue → ~10 months → ~1,500.
  const opts = { base: 10000, dueDate: "2026-01-01", ratePctPerMonth: 1.5, gracePeriodDays: 0, now: new Date("2026-10-28T00:00:00Z") };
  const uncapped = billing.computeLateFee(opts);
  assert.ok(uncapped.lateFee > 1400, "uncapped fee accrues with time");
  assert.equal(uncapped.capped, false);
  // Cap at 5% of principal = 500.
  const cappedPct = billing.computeLateFee({ ...opts, maxPctOfPrincipal: 5 });
  assert.equal(cappedPct.lateFee, 500, "capped at 5% of principal");
  assert.equal(cappedPct.uncappedLateFee, uncapped.lateFee, "keeps the uncapped amount for audit/display");
  assert.equal(cappedPct.capped, true);
  // Absolute ฿300 cap wins when lower.
  const cappedBaht = billing.computeLateFee({ ...opts, maxBaht: 300 });
  assert.equal(cappedBaht.lateFee, 300, "capped at the absolute ฿ ceiling");
  assert.equal(cappedBaht.capped, true);
  // Both set → lower ceiling wins (5% = 500 vs ฿300 → 300).
  const both = billing.computeLateFee({ ...opts, maxPctOfPrincipal: 5, maxBaht: 300 });
  assert.equal(both.lateFee, 300);
  // Caps of 0 = no cap (default behavior preserved).
  const noCap = billing.computeLateFee({ ...opts, maxPctOfPrincipal: 0, maxBaht: 0 });
  assert.equal(noCap.lateFee, uncapped.lateFee);
  assert.equal(noCap.capped, false);
  // A cap higher than the accrued fee does not reduce it.
  const highCap = billing.computeLateFee({ ...opts, maxBaht: 999999 });
  assert.equal(highCap.lateFee, uncapped.lateFee);
  assert.equal(highCap.capped, false);
});
