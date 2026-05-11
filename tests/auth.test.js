// tests/auth.test.js
// Unit tests for the bits of auth that don't need an HTTP server:
// role-rank middleware behaviour.
//   node --test tests/auth.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

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
