// tests/encryption.test.js
//   node --test tests/encryption.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// Two distinct keys for rotation testing.
process.env.ENCRYPTION_KEY_V1 = Buffer.alloc(32, 1).toString('base64');
process.env.ENCRYPTION_KEY_V2 = Buffer.alloc(32, 2).toString('base64');
process.env.ENCRYPTION_KEY_CURRENT = '2';
const enc = require('../services/encryption');

test('round-trip with current version', () => {
  const cipher = enc.encryptString('hello');
  assert.match(cipher, /^v2\$/);
  assert.equal(enc.decryptString(cipher), 'hello');
});

test('decrypt with old version still works', () => {
  // Manually craft a v1 ciphertext using legacy crypto (which falls through
  // to whatever key is set for the encryption module).
  // Easiest: set CURRENT=1, encrypt, set CURRENT=2, decrypt.
  process.env.ENCRYPTION_KEY_CURRENT = '1';
  // Force re-init by clearing the cached state
  delete require.cache[require.resolve('../services/encryption')];
  const e1 = require('../services/encryption');
  const cipher = e1.encryptString('legacy');
  assert.match(cipher, /^v1\$/);

  // Now switch to v2 + decrypt v1 ciphertext
  process.env.ENCRYPTION_KEY_CURRENT = '2';
  delete require.cache[require.resolve('../services/encryption')];
  const e2 = require('../services/encryption');
  assert.equal(e2.decryptString(cipher), 'legacy');
});

test('null/empty passthrough', () => {
  delete require.cache[require.resolve('../services/encryption')];
  const e = require('../services/encryption');
  assert.equal(e.encryptString(null), null);
  assert.equal(e.encryptString(''), '');
});

test('currentVersion + loadedVersions reflect env', () => {
  delete require.cache[require.resolve('../services/encryption')];
  const e = require('../services/encryption');
  assert.deepEqual(e.loadedVersions(), [1, 2]);
  assert.equal(e.currentVersion(), 2);
});
