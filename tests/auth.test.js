// tests/auth.test.js
// Unit tests for the bits of auth that don't need an HTTP server: trivial
// PIN detection + role-rank middleware behaviour.
//   node --test tests/auth.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// isTrivialPin lives inside server.js; reproduce the canonical impl here so
// we don't have to spin up the server. If you change the rules in server.js,
// mirror the change here.
const TRIVIAL_PINS_4 = new Set([
  '0000','1111','2222','3333','4444','5555','6666','7777','8888','9999',
  '1234','4321','2580','1010','1212','1313','2024','2025','2026','2027',
]);
function isTrivialPin(s) {
  const str = String(s || '');
  if (!/^\d{4,8}$/.test(str)) return false;
  if (str.length === 4 && TRIVIAL_PINS_4.has(str)) return true;
  if (/^(\d)\1+$/.test(str)) return true;
  if (/^(0123|1234|2345|3456|4567|5678|6789|9876|8765|7654|6543|5432|4321)/.test(str)) return true;
  return false;
}

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
