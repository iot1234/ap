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

test('buildBill: VAT applied when enabled', () => {
  const flags = { lateFee: { enabled: false }, vat: { enabled: true, ratePct: 7 } };
  const bill = billing.buildBill({ room: baseRoom, config: baseConfig, features: flags });
  // 6140 + 7% = 6569.8
  assert.equal(bill.subtotal, 6140);
  assert.equal(bill.vat, 429.8);
  assert.equal(bill.total, 6569.8);
});

test('buildBill: late fee from previous overdue', () => {
  const flags = { lateFee: { enabled: true, ratePctPerMonth: 1.5, gracePeriodDays: 0 }, vat: { enabled: false } };
  const past = new Date(); past.setDate(past.getDate() - 30);
  const previous = { total: 6000, dueDate: past.toISOString().slice(0, 10), status: 'overdue' };
  const bill = billing.buildBill({ room: baseRoom, config: baseConfig, features: flags, previous });
  assert.ok(bill.lateFee > 0, 'late fee should be > 0');
  // Roughly 6000 × 1.5% × (30/30) = 90 (give or take grace handling)
  assert.ok(bill.lateFee >= 80 && bill.lateFee <= 100);
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
  const future = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  assert.equal(billing.statusOf({ paid_at: null, due_date: future }), 'pending');
});

test('makeBillNo is deterministic for room+period', () => {
  assert.equal(billing.makeBillNo('201', '2026-05'), 'INV-2026-05-201');
});
