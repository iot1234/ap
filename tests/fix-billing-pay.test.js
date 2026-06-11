// tests/fix-billing-pay.test.js
// Regression tests for two confirmed billing/payment bugs:
//
// 1. buildBill treated the rooms-API default wifi=0 as an explicit free-wifi
//    override, silently dropping config.utilities.wifi from every bill for
//    rooms touched via /api/rooms (rooms_v2.wifi_fee DEFAULT 0 → roomSync
//    emits wifi:0 into the blob). Explicit zero now only counts on the
//    dedicated wifiOverride / wifi_override keys.
//
// 2. A carried late fee already consumed by next-period bill-gen was
//    unreversible: void/unmark-paid re-accrued (or kept) the same fee while
//    it also sat frozen inside the next period's issued bill — double-charge.
//    billPayments.findConsumedCarriedLateFees now reports consumed carries
//    (excluding ones we reversed ourselves, via a notes marker stamped by
//    deactivateCarriedLateFees) and computeRestoredBillAmounts subtracts the
//    consumed amount from the restored fee.
//
//   node --test tests/fix-billing-pay.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const billing = require('../services/billing');
const billPayments = require('../services/billPayments');

const baseConfig = {
  utilities: { waterRate: 18, elecRate: 8, wifi: 250 },
  building: { name: 'Test' },
  payment: { promptpayTarget: '0812345678' },
};
const baseRoom = {
  id: '305', rent: 5000, waterUnits: 5, elecUnits: 100,
  tenant: { name: 'นาย ก', phone: '0811234567' },
};
const flags = { lateFee: { enabled: false }, vat: { enabled: false } };

// --- Fix 1: wifi=0 default must not masquerade as a free-wifi override ------

test('buildBill: legacy wifi=0 (rooms-API default) falls back to the global wifi fee', () => {
  // roomSync emits wifi:0 for every room whose rooms_v2.wifi_fee was never
  // set — that's "not configured", not "free wifi for this unit".
  const room = { ...baseRoom, wifi: 0 };
  const bill = billing.buildBill({ room, config: baseConfig, features: flags });
  assert.equal(bill.wifi, 250, 'building-wide fee must be billed');
  assert.equal(bill.wifiFeeSource, 'global');
  const line = bill.items.find((it) => it.label === 'ค่าอินเทอร์เน็ต');
  assert.ok(line, 'internet line item must be on the bill');
  assert.equal(line.amount, 250);
  // Total includes the wifi fee: 5000 + 90 + 800 + 250.
  assert.equal(bill.total, 6140);
});

test('buildBill: dedicated wifiOverride=0 still means genuinely free wifi', () => {
  const room = { ...baseRoom, wifiOverride: 0 };
  const bill = billing.buildBill({ room, config: baseConfig, features: flags });
  assert.equal(bill.wifi, 0);
  assert.equal(bill.wifiFeeSource, 'override');
  assert.equal(bill.items.find((it) => it.label === 'ค่าอินเทอร์เน็ต'), undefined,
    'free wifi → no line item');
});

test('buildBill: snake_case wifi_override=0 also means free wifi (rooms_v2 shape)', () => {
  const room = { ...baseRoom, wifi_override: 0, wifi: 0 };
  const bill = billing.buildBill({ room, config: baseConfig, features: flags });
  assert.equal(bill.wifi, 0);
  assert.equal(bill.wifiFeeSource, 'override');
});

test('buildBill: legacy wifi>0 still acts as a per-room fee', () => {
  const room = { ...baseRoom, wifi: 500 };
  const bill = billing.buildBill({ room, config: baseConfig, features: flags });
  assert.equal(bill.wifi, 500);
  assert.equal(bill.wifiFeeSource, 'override');
});

test('buildBill: wifiOverride beats legacy wifi key when both present', () => {
  // Blob round-trip can leave both keys — the dedicated override wins.
  const room = { ...baseRoom, wifiOverride: 100, wifi: 0 };
  const bill = billing.buildBill({ room, config: baseConfig, features: flags });
  assert.equal(bill.wifi, 100);
});

// --- Fix 2a: computeRestoredBillAmounts must not re-accrue a consumed carry --

test('computeRestoredBillAmounts: consumed carried fee is subtracted from the restored fee', () => {
  // Principal 5000, 1.5%/mo, 24 days over → recomputed fee = 60. A carried
  // fee of 25 already sits inside next period's issued bill → only the
  // growth (35) belongs on the restored bill.
  const out = billing.computeRestoredBillAmounts({
    subtotal: 5000, vat: 0, lateFee: 0, total: 5000,
    dueDate: '2026-06-01', now: new Date(2026, 5, 25),
    lateFeeEnabled: true, ratePctPerMonth: 1.5, gracePeriodDays: 0,
    consumedCarriedLateFee: 25,
  });
  assert.equal(out.status, 'overdue');
  assert.equal(out.principal, 5000);
  assert.equal(out.lateFee, 35);
  assert.equal(out.total, 5035);
});

test('computeRestoredBillAmounts: consumed carry >= recomputed fee → fee fully owed next period', () => {
  // The June fee (90) was carried and billed into July. Restoring June must
  // NOT recreate it — the tenant already owes it on July's issued bill.
  const out = billing.computeRestoredBillAmounts({
    subtotal: 5000, vat: 0, lateFee: 0, total: 5000,
    dueDate: '2026-06-01', now: new Date(2026, 5, 25),
    lateFeeEnabled: true, ratePctPerMonth: 1.5, gracePeriodDays: 0,
    consumedCarriedLateFee: 90,
  });
  assert.equal(out.status, 'overdue');
  assert.equal(out.lateFee, 0, 'no double-charge: fee stays in next period\'s bill');
  assert.equal(out.total, 5000);
});

test('computeRestoredBillAmounts: behavior unchanged when no carry was consumed', () => {
  const args = {
    subtotal: 5000, vat: 0, lateFee: 0, total: 5000,
    dueDate: '2026-06-01', now: new Date(2026, 5, 25),
    lateFeeEnabled: true, ratePctPerMonth: 1.5, gracePeriodDays: 0,
  };
  const without = billing.computeRestoredBillAmounts(args);
  const withZero = billing.computeRestoredBillAmounts({ ...args, consumedCarriedLateFee: 0 });
  assert.deepEqual(withZero, without);
  assert.equal(without.lateFee, 60);
  assert.equal(without.total, 5060);
});

// --- Fix 2b: findConsumedCarriedLateFees -------------------------------------

test('findConsumedCarriedLateFees reports already-billed carries with amounts', async () => {
  const calls = [];
  const fakeClient = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM audit_logs/.test(sql)) return { rows: [{ cid: '42' }, { cid: '43' }, { cid: null }] };
    if (/FROM recurring_charges/.test(sql)) {
      return { rows: [{ id: '42', amount: '90.00', label: 'ค่าปรับล่าช้าค้างจากรอบ 2026-06', start_at: '2026-07-01' }] };
    }
    return { rows: [] };
  } };
  const out = await billPayments.findConsumedCarriedLateFees(fakeClient, 99);
  assert.deepEqual(out, [{
    id: 42, amount: 90, label: 'ค่าปรับล่าช้าค้างจากรอบ 2026-06', startAt: '2026-07-01',
  }]);
  const sel = calls.find((c) => /FROM recurring_charges/.test(c.sql));
  assert.ok(sel, 'must look up the carry rows');
  assert.match(sel.sql, /active=FALSE/, 'consumed = already deactivated by bill-gen');
  assert.match(sel.sql, /frequency='one_off'/, 'only one_off carries');
  assert.match(sel.sql, /POSITION\(\$2 IN COALESCE\(notes,''\)\) = 0/,
    'must exclude carries we reversed ourselves');
  assert.deepEqual(sel.params[0], [42, 43], 'parsed carriedChargeIds, null filtered out');
  assert.equal(sel.params[1], billPayments._carriedLateFeeReversedMarker);
});

test('findConsumedCarriedLateFees returns [] when the bill never carried a fee', async () => {
  const fakeClient = { query: async (sql) => {
    if (/FROM audit_logs/.test(sql)) return { rows: [] };
    throw new Error('must not query recurring_charges without carry ids');
  } };
  assert.deepEqual(await billPayments.findConsumedCarriedLateFees(fakeClient, 7), []);
});

test('reversal round-trip: a carry deactivated by us is never misreported as consumed', async () => {
  // Stateful fake: id 42 still active (never billed), id 43 already consumed
  // by bill-gen (active=FALSE, no reversal marker).
  const charges = new Map([
    [42, { id: 42, amount: 90, label: 'a', start_at: '2026-07-01', frequency: 'one_off', active: true,  notes: '[system:late_fee_carry] x' }],
    [43, { id: 43, amount: 60, label: 'b', start_at: '2026-07-01', frequency: 'one_off', active: false, notes: '[system:late_fee_carry] y' }],
  ]);
  const fake = { query: async (sql, params) => {
    if (/FROM audit_logs/.test(sql)) return { rows: [{ cid: '42' }, { cid: '43' }] };
    if (/UPDATE recurring_charges/.test(sql)) {
      const rows = [];
      for (const id of params[0]) {
        const c = charges.get(Number(id));
        if (c && c.frequency === 'one_off' && c.active) {
          c.active = false;
          c.notes = `${c.notes || ''} ${params[1]}`.trim();
          rows.push({ id: c.id });
        }
      }
      return { rows };
    }
    if (/FROM recurring_charges/.test(sql)) {
      const rows = params[0]
        .map((id) => charges.get(Number(id)))
        .filter((c) => c && c.frequency === 'one_off' && !c.active
          && !String(c.notes || '').includes(params[1]))
        .map((c) => ({ id: c.id, amount: c.amount, label: c.label, start_at: c.start_at }));
      return { rows };
    }
    return { rows: [] };
  } };

  // Before the reversal: only the bill-gen-consumed carry is reported.
  const before = await billPayments.findConsumedCarriedLateFees(fake, 9);
  assert.deepEqual(before.map((c) => c.id), [43]);
  assert.equal(before[0].amount, 60);

  // Reverse: deactivates the still-active carry, stamping the marker.
  const deactivated = await billPayments.deactivateCarriedLateFees(fake, 9);
  assert.deepEqual(deactivated, [42]);
  assert.match(charges.get(42).notes, /\[system:late_fee_carry_reversed\]/);

  // After: the reversed carry must NOT appear as consumed (a second
  // unmark-paid would otherwise wrongly shrink the restored fee).
  const after = await billPayments.findConsumedCarriedLateFees(fake, 9);
  assert.deepEqual(after.map((c) => c.id), [43]);
});

test('deactivateCarriedLateFees keeps its array return shape (route/audit back-compat)', async () => {
  const calls = [];
  const fakeClient = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM audit_logs/.test(sql)) return { rows: [{ cid: '42' }] };
    if (/UPDATE recurring_charges/.test(sql)) return { rows: [{ id: 42 }] };
    return { rows: [] };
  } };
  const out = await billPayments.deactivateCarriedLateFees(fakeClient, 5);
  assert.deepEqual(out, [42]);
  const upd = calls.find((c) => /UPDATE recurring_charges/.test(c.sql));
  assert.match(upd.sql, /active=TRUE/, 'still only flips still-active carries');
  assert.equal(upd.params[1], billPayments._carriedLateFeeReversedMarker,
    'reversal marker is stamped into notes');
});
