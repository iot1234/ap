// tests/meter.test.js
// consumption() is pure-function — easily testable without DB.
//   node --test tests/meter.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const meter = require('../services/meter');

test('consumption: positive delta', () => {
  assert.equal(meter.consumption({ reading: 100 }, { reading: 150 }), 50);
});

test('consumption: zero or negative returns 0 (no rollover handling)', () => {
  assert.equal(meter.consumption({ reading: 200 }, { reading: 100 }), 0);
  assert.equal(meter.consumption({ reading: 100 }, { reading: 100 }), 0);
});

test('consumption: missing arg returns 0', () => {
  assert.equal(meter.consumption(null, { reading: 100 }), 0);
  assert.equal(meter.consumption({ reading: 100 }, null), 0);
});

test('ALLOWED_TYPES exports', () => {
  assert.ok(meter.ALLOWED_TYPES.has('water'));
  assert.ok(meter.ALLOWED_TYPES.has('elec'));
  assert.ok(!meter.ALLOWED_TYPES.has('gas'));
});
