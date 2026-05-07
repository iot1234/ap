// tests/auth.test.js
// Unit tests for the bits of auth that don't need an HTTP server: trivial
// PIN detection + role-rank middleware behaviour.
//   node --test tests/auth.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// Test the actual implementation — services/pinPolicy.js is the single
// source of truth, also imported by server.js and routes/tenant-ops.js.
const { isTrivialPin } = require('../services/pinPolicy');

test('rejects 0000 / 1111 / 1234 / 9999', () => {
  for (const p of ['0000', '1111', '1234', '9999', '4321']) {
    assert.equal(isTrivialPin(p), true, `should reject ${p}`);
  }
});
test('rejects all-same-digit PINs', () => {
  for (const p of ['00000', '5555555', '88888888']) {
    assert.equal(isTrivialPin(p), true, `should reject ${p}`);
  }
});
test('accepts non-trivial PINs', () => {
  for (const p of ['4729', '8203', '917365', '38172']) {
    assert.equal(isTrivialPin(p), false, `should accept ${p}`);
  }
});
test('rejects sequence PINs (long form)', () => {
  for (const p of ['012345', '345678']) {
    assert.equal(isTrivialPin(p), true, `should reject ${p}`);
  }
});
test('rejects non-digit input', () => {
  for (const p of ['abcd', '12-34', '12 34']) {
    assert.equal(isTrivialPin(p), false);
  }
});

// === Role rank ============================================================
const { ROLE_RANK } = require('../middleware/auth');
test('owner outranks staff', () => {
  assert.ok(ROLE_RANK.owner > ROLE_RANK.staff);
});
test('readonly is the lowest', () => {
  assert.ok(ROLE_RANK.readonly < ROLE_RANK.staff);
  assert.ok(ROLE_RANK.readonly < ROLE_RANK.manager);
  assert.ok(ROLE_RANK.readonly < ROLE_RANK.owner);
});
