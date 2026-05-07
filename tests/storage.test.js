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
