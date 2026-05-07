// tests/backup.test.js
//   node --test tests/backup.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.DATABASE_URL = 'postgres://fake/fake';
const backup = require('../scripts/backup');

function tmpFile(content) {
  const f = path.join(os.tmpdir(), `bk-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, content);
  return f;
}

test('verify: detects missing integrity block', () => {
  const f = tmpFile(JSON.stringify({ schemaVersion: 1, tables: {} }));
  const r = backup.verify(f);
  fs.unlinkSync(f);
  assert.equal(r.ok, false);
  assert.match(r.error, /no integrity block/);
});

test('verify: detects tampered hash', () => {
  const obj = {
    schemaVersion: 1, createdAt: '2026-05-07T00:00:00Z',
    tables: { foo: [{ id: 1 }] },
    integrity: { algorithm: 'sha256', digest: 'deadbeef', rowCounts: { foo: 1 } },
  };
  const f = tmpFile(JSON.stringify(obj));
  const r = backup.verify(f);
  fs.unlinkSync(f);
  assert.equal(r.ok, false);
  assert.match(r.error, /hash mismatch/);
});

test('verify: accepts a backup with correct hash', () => {
  const stored = {
    schemaVersion: 1, createdAt: '2026-05-07T00:00:00Z',
    tables: { foo: [{ id: 1 }] },
  };
  const digest = require('crypto').createHash('sha256')
    .update(JSON.stringify(stored)).digest('hex');
  const obj = { ...stored, integrity: { algorithm: 'sha256', digest, rowCounts: { foo: 1 } } };
  const f = tmpFile(JSON.stringify(obj));
  const r = backup.verify(f);
  fs.unlinkSync(f);
  assert.equal(r.ok, true);
  assert.equal(r.counts.foo, 1);
});

test('verify: handles invalid JSON', () => {
  const f = tmpFile('not valid json');
  const r = backup.verify(f);
  fs.unlinkSync(f);
  assert.equal(r.ok, false);
});
