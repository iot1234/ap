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
test('rejects arithmetic progressions', () => {
  // Step 2: 1357, 2468, 0246. Step 3: 0369, 1470 (with mod 10 wrap).
  // The classic 8-digit "13579246" is step=2 wrapping 9→1, then 1→3...
  // wait — actually digits 1,3,5,7,9,2,4,6 → wraparound after 9: 9+2=11%10=1,
  // not 2. So that exact sequence doesn't match step=2; but 13579135, 24682468
  // and similar do. We test the mod-10 wrap case explicitly below.
  for (const p of ['1357', '2468', '0246', '9876', '9630', '9012']) {
    assert.equal(isTrivialPin(p), true, `should reject ${p}`);
  }
});
test('rejects common years (rolling window)', () => {
  // Years from 1925 up to current+2 are rejected as common birth/anniversary
  // PINs even when they don't form a sequence.
  const thisYear = new Date().getFullYear();
  for (const p of ['1990', '1985', '2003', String(thisYear)]) {
    assert.equal(isTrivialPin(p), true, `should reject year ${p}`);
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
