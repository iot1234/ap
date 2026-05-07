// tests/crypto.test.js
// Verifies AES-256-GCM round-trip and tamper detection.
//   node --test tests/crypto.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// Set a key BEFORE require so the module's lazy init picks it up.
process.env.CITIZEN_ID_KEY = Buffer.alloc(32, 7).toString('base64');
const c = require('../services/crypto');

test('encrypt → decrypt round trip', () => {
  const plain = '1234567890123';
  const enc = c.encryptString(plain);
  assert.notEqual(enc, plain);
  assert.equal(c.decryptString(enc), plain);
});

test('encrypt of null/empty is passthrough', () => {
  assert.equal(c.encryptString(null), null);
  assert.equal(c.encryptString(''), '');
});

test('two encryptions of same plaintext differ (random IV)', () => {
  const a = c.encryptString('hello');
  const b = c.encryptString('hello');
  assert.notEqual(a, b);
});

test('tampering with ciphertext throws', () => {
  const enc = c.encryptString('secret');
  const bad = enc.slice(0, -4) + 'AAAA';
  assert.throws(() => c.decryptString(bad));
});

test('maskTail keeps last 4', () => {
  assert.equal(c.maskTail('1234567890123'), '*********0123');
  assert.equal(c.maskTail('123', 4), '***');
});

test('hmac is deterministic', () => {
  const a = c.hmac('abc'); const b = c.hmac('abc');
  assert.equal(a, b);
  assert.notEqual(a, c.hmac('abd'));
});
