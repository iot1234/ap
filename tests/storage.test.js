// tests/storage.test.js
// Tests parseBase64 + path safety. The full saveBase64 round-trip requires
// a live pool — covered separately in integration tests.
//   node --test tests/storage.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const storage = require('../services/storage');

test('parseBase64 with data URL', () => {
  const out = storage.parseBase64('data:image/png;base64,iVBORw0KGgo=');
  assert.equal(out.mime, 'image/png');
  assert.ok(Buffer.isBuffer(out.buffer));
});

test('parseBase64 with raw base64', () => {
  const out = storage.parseBase64(Buffer.from('hello').toString('base64'));
  assert.equal(out.mime, null);
  assert.equal(out.buffer.toString(), 'hello');
});

test('parseBase64 throws on non-string', () => {
  assert.throws(() => storage.parseBase64(123));
});

test('storage status exposes durability and local-file guard helpers', () => {
  const status = storage.storageStatus();
  assert.ok(status.uploadRoot);
  assert.ok(['local', 's3'].includes(status.storageMode));
  assert.equal(typeof status.localUploadMayBeEphemeral, 'boolean');
  assert.equal(
    storage.localFileExists({ storage: 'local', category: '..', filename: 'x.png' }),
    false
  );
});
