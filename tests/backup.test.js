// tests/backup.test.js
//   node --test tests/backup.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.DATABASE_URL = 'postgres://fake/fake';
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `bk-upload-root-${process.pid}`);
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

test('materializeFileBlobs restores uploaded file bytes and marks rows local', async () => {
  const content = Buffer.from('stored bytes');
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      return { rowCount: 1, rows: [] };
    },
  };
  const out = await backup.materializeFileBlobs(pool, {
    fileBlobs: [{
      id: 12,
      category: 'slip',
      filename: 'restore-test.bin',
      contentBase64: content.toString('base64'),
    }],
  });
  const restored = path.join(require('../services/storage').rootPath(), 'slip', 'restore-test.bin');
  assert.equal(out.restored, 1);
  assert.equal(fs.readFileSync(restored).toString(), 'stored bytes');
  assert.ok(calls.some((c) => /UPDATE file_uploads/i.test(c.sql)
    && c.params[0] === 12
    && c.params[1] === 'slip'
    && c.params[2] === 'restore-test.bin'));
  fs.rmSync(restored, { force: true });
});

test('materializeFileBlobs reports bad file blobs without throwing', async () => {
  const pool = {
    query: async () => {
      throw new Error('query should not run for invalid file path');
    },
  };
  const out = await backup.materializeFileBlobs(pool, {
    fileBlobs: [{
      id: 99,
      category: '../bad',
      filename: 'escape.bin',
      contentBase64: Buffer.from('x').toString('base64'),
    }],
  });
  assert.equal(out.restored, 0);
  assert.equal(out.failed, 1);
  assert.match(out.errors[0], /invalid file blob path/);
});
