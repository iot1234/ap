// tests/schemas.test.js
//   node --test tests/schemas.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { schemas } = require('../schemas');

test('login: valid', () => {
  const r = schemas.login.safeParse({ username: 'admin', password: 'longenoughpw1' });
  assert.equal(r.success, true);
});
test('login: empty password rejected', () => {
  const r = schemas.login.safeParse({ username: 'admin', password: '' });
  assert.equal(r.success, false);
});
test('login: too-long username rejected', () => {
  const r = schemas.login.safeParse({ username: 'x'.repeat(100), password: 'pw' });
  assert.equal(r.success, false);
});

test('changePassword: requires current password and strong new password', () => {
  assert.equal(schemas.changePassword.safeParse({ newPassword: 'longenoughpw1' }).success, false);
  assert.equal(schemas.changePassword.safeParse({ currentPassword: 'old', newPassword: 'short' }).success, false);
  assert.equal(schemas.changePassword.safeParse({ currentPassword: 'old', newPassword: 'newlongenoughpw1' }).success, true);
});

test('publicBooking: tenantName required', () => {
  const r = schemas.publicBooking.safeParse({ phone: '0812345678' });
  assert.equal(r.success, false);
});
test('publicBooking: roomId optional', () => {
  const r = schemas.publicBooking.safeParse({ tenantName: 'Foo' });
  assert.equal(r.success, true);
});
test('publicBooking: bad roomType rejected', () => {
  const r = schemas.publicBooking.safeParse({ tenantName: 'Foo', roomType: 'penthouse' });
  assert.equal(r.success, false);
});

test('createTicket: valid', () => {
  const r = schemas.createTicket.safeParse({
    roomId: '101', category: 'electrical', title: 'ไฟดับ',
  });
  assert.equal(r.success, true);
  assert.equal(r.data.priority, undefined);   // optional, no default
});
test('createTicket: invalid category', () => {
  const r = schemas.createTicket.safeParse({
    roomId: '101', category: 'magic', title: 'foo',
  });
  assert.equal(r.success, false);
});

test('rateTicket: 1-5 inclusive', () => {
  for (const r of [1, 2, 3, 4, 5]) {
    const v = schemas.rateTicket.safeParse({ rating: r, phone: '0812345678' });
    assert.equal(v.success, true);
  }
  assert.equal(schemas.rateTicket.safeParse({ rating: 0, phone: '0812345678' }).success, false);
  assert.equal(schemas.rateTicket.safeParse({ rating: 6, phone: '0812345678' }).success, false);
});

test('tenantLogin: phone normalised (strip dashes/spaces)', () => {
  const r = schemas.tenantLogin.safeParse({ phone: '081-234-5678' });
  assert.equal(r.success, true);
  assert.equal(r.data.phone, '0812345678');
});
test('tenantLogin: PIN field is rejected after phone-only login change', () => {
  const r = schemas.tenantLogin.safeParse({ phone: '081-234-5678', pin: '4729' });
  assert.equal(r.success, false);
});

test('adminCreateUser: weak password rejected', () => {
  const r = schemas.adminCreateUser.safeParse({ username: 'foo', password: 'short' });
  assert.equal(r.success, false);
});
test('adminCreateUser: bad role rejected', () => {
  const r = schemas.adminCreateUser.safeParse({ username: 'foo', password: 'longenoughpw1', role: 'superduperadmin' });
  assert.equal(r.success, false);
});
test('adminCreateUser: valid', () => {
  const r = schemas.adminCreateUser.safeParse({ username: 'foo', password: 'longenoughpw1', role: 'staff' });
  assert.equal(r.success, true);
});
test('adminCreateUser: username regex rejects spaces', () => {
  const r = schemas.adminCreateUser.safeParse({ username: 'foo bar', password: 'longenoughpw1' });
  assert.equal(r.success, false);
});
test('adminCreateUser: username regex rejects unicode/non-ascii', () => {
  const r = schemas.adminCreateUser.safeParse({ username: 'แอดมิน', password: 'longenoughpw1' });
  assert.equal(r.success, false);
});
test('adminUpdateUser: currentPassword optional (other-owner reset path)', () => {
  const r = schemas.adminUpdateUser.safeParse({ password: 'newlongenoughpw1' });
  assert.equal(r.success, true);
});
test('adminUpdateUser: rejects extra fields like username via zod strict-ish parse', () => {
  // Schema doesn't include username — extra fields are silently dropped by
  // default. Confirm role/password are the only writable surface.
  const r = schemas.adminUpdateUser.safeParse({
    role: 'staff', password: 'newlongenoughpw1', username: 'evil',
  });
  assert.equal(r.success, true);
  assert.equal(r.data.username, undefined);
});
test('adminUpdateUser: role enum tight (no admin/root)', () => {
  for (const bad of ['admin', 'root', 'superuser', 'OWNER']) {
    const r = schemas.adminUpdateUser.safeParse({ role: bad });
    assert.equal(r.success, false, `should reject role=${bad}`);
  }
});

test('backupImport: bad PromptPay rejected', () => {
  const r = schemas.backupImport.safeParse({
    config: { payment: { promptpayTarget: '12345' } },
  });
  assert.equal(r.success, false);
});
test('backupImport: valid PromptPay accepted', () => {
  const r = schemas.backupImport.safeParse({
    schemaVersion: 1,
    config: { payment: { promptpayTarget: '0812345678' } },
  });
  assert.equal(r.success, true);
});

test('generateBill: computed bill can omit period/total because server derives them', () => {
  const r = schemas.generateBill.safeParse({ roomId: '101', compute: true });
  assert.equal(r.success, true);
});

test('generateBill: manual bill requires positive total and ledger fields', () => {
  const missing = schemas.generateBill.safeParse({ roomId: '101' });
  assert.equal(missing.success, false);
  const zero = schemas.generateBill.safeParse({
    roomId: '101',
    billNo: 'INV-1',
    period: '2026-05',
    dueDate: '2026-05-15',
    total: 0,
  });
  assert.equal(zero.success, false);
  const bad = schemas.generateBill.safeParse({
    roomId: '101',
    billNo: 'INV-1',
    period: '2026-05',
    dueDate: '2026-05-15',
    total: 100,
    rent: -1,
  });
  assert.equal(bad.success, false);
});

test('generateBill: manual bill preserves meter reading snapshots', () => {
  const r = schemas.generateBill.safeParse({
    roomId: '101',
    billNo: 'INV-1',
    period: '2026-05',
    dueDate: '2026-05-15',
    total: 100,
    waterPrevReading: '120',
    waterCurrentReading: '135.5',
    elecPrevReading: 1500,
    elecCurrentReading: 1625,
  });
  assert.equal(r.success, true);
  assert.equal(r.data.waterPrevReading, 120);
  assert.equal(r.data.waterCurrentReading, 135.5);
  assert.equal(r.data.elecPrevReading, 1500);
  assert.equal(r.data.elecCurrentReading, 1625);

  const bad = schemas.generateBill.safeParse({
    roomId: '101',
    billNo: 'INV-1',
    period: '2026-05',
    dueDate: '2026-05-15',
    total: 100,
    waterPrevReading: -1,
  });
  assert.equal(bad.success, false);
});

test('generateBill: manual bill preserves line item qty and detail', () => {
  const r = schemas.generateBill.safeParse({
    roomId: '101',
    billNo: 'INV-1',
    period: '2026-05',
    dueDate: '2026-05-15',
    total: 100.25,
    other: [{
      label: 'payment reference',
      qty: '',
      detail: 'unique cents for reconciliation',
      amount: 0.25,
    }],
  });
  assert.equal(r.success, true);
  assert.equal(r.data.other[0].detail, 'unique cents for reconciliation');
  assert.equal(r.data.other[0].qty, '');
});

test('rooms schema accepts nullable per-room rent override fields', () => {
  const base = {
    floor: 1,
    roomNo: 1,
    roomType: 'standard',
    rentPrice: 4500,
    depositPrice: 9000,
  };
  const withOverride = schemas.createRoom.safeParse({
    ...base,
    rentOverride: '4200.50',
    rentOverrideReason: 'promo',
  });
  assert.equal(withOverride.success, true);
  assert.equal(withOverride.data.rentOverride, 4200.5);

  const cleared = schemas.updateRoom.safeParse({ rentOverride: null, rentOverrideReason: '' });
  assert.equal(cleared.success, true);
  assert.equal(cleared.data.rentOverride, null);
  assert.equal(cleared.data.rentOverrideReason, null);
});
