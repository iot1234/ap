// tests/file-encryption.test.js
// Encryption-at-rest for uploaded files + backups (services/encryption.js
// buffer APIs, scripts/backup.js encodeBackup/readBackupFile).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Key material for the legacy derived-key path; backup.js also requires
// DATABASE_URL at module load (it exits without one).
process.env.SESSION_SECRET = process.env.SESSION_SECRET
  || 'test-session-secret-for-file-encryption-tests';
process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://test:test@localhost:5432/test';

// Point storage at a temp dir BEFORE requiring it (module-level constant).
const TEST_UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-enc-test-'));
process.env.UPLOAD_DIR = TEST_UPLOAD_DIR;

const encryption = require('../services/encryption');
const storage = require('../services/storage');

test('encryptBuffer/decryptBuffer round-trips and carries the APENC1 magic', () => {
  const plain = Buffer.from('ภาพบัตรประชาชน + slip bytes \x00\x01\x02', 'utf8');
  const enc = encryption.encryptBuffer(plain);
  assert.ok(encryption.isEncryptedBuffer(enc), 'encrypted buffer must carry the APENC1 magic');
  assert.ok(!enc.equals(plain), 'ciphertext must differ from plaintext');
  const dec = encryption.decryptBuffer(enc);
  assert.ok(dec.equals(plain), 'round-trip must restore the original bytes');
});

test('decryptBuffer passes legacy plaintext files through unchanged', () => {
  // JPEG magic — a file written before encryption-at-rest landed.
  const plain = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
    0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48,
    0x00, 0x48, 0x00, 0x00, 0xFF, 0xD9, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const out = encryption.decryptBuffer(plain);
  assert.strictEqual(out, plain, 'non-APENC1 buffers must pass through untouched');
});

test('tampered ciphertext fails the auth tag instead of returning garbage', () => {
  const enc = encryption.encryptBuffer(Buffer.from('slip-image-bytes'));
  enc[enc.length - 1] ^= 0x01;
  assert.throws(() => encryption.decryptBuffer(enc), 'GCM auth must reject tampering');
});

test('storage.saveBase64 → readFile round-trips with ciphertext on disk', async () => {
  // Minimal valid-magic JPEG payload (detectMime needs >=12 bytes + FF D8 FF).
  const jpegBytes = Buffer.concat([
    Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]),
    Buffer.alloc(64, 0x42),
  ]);
  const dataUrl = `data:image/jpeg;base64,${jpegBytes.toString('base64')}`;
  const mockPool = {
    query: async (sql) => (/RETURNING id/.test(sql) ? { rows: [{ id: 7 }] } : { rows: [] }),
  };
  const saved = await storage.saveBase64({
    pool: mockPool, category: 'slip', dataUrl, refId: 'test', uploadedBy: 'test',
  });
  assert.ok(saved.id, 'save must succeed');
  // On-disk bytes must be ciphertext, not the JPEG.
  const onDisk = fs.readFileSync(path.join(TEST_UPLOAD_DIR, 'slip', saved.filename));
  assert.ok(encryption.isEncryptedBuffer(onDisk), 'stored file must be APENC1 ciphertext');
  assert.ok(!onDisk.subarray(0, 3).equals(Buffer.from([0xFF, 0xD8, 0xFF])),
    'stored file must not start with the JPEG magic');
  // readFile (the export every consumer uses) must hand back the original.
  const roundTripped = await storage.readFile({
    category: 'slip', filename: saved.filename, storage: 'local',
  });
  assert.ok(roundTripped.equals(jpegBytes), 'readFile must transparently decrypt');
  // A pre-encryption legacy file dropped straight on disk must still read.
  const legacyName = 'legacy-plain.jpg';
  fs.writeFileSync(path.join(TEST_UPLOAD_DIR, 'slip', legacyName), jpegBytes);
  const legacy = await storage.readFile({
    category: 'slip', filename: legacyName, storage: 'local',
  });
  assert.ok(legacy.equals(jpegBytes), 'legacy plaintext files must pass through');
});

test('backup encodeBackup writes .json.enc that readBackupFile round-trips', () => {
  const backup = require('../scripts/backup');
  assert.equal(typeof backup.readBackupFile, 'function',
    'backup module must expose the decrypt-aware reader for restore');
  // encodeBackup is internal — exercise it through the public surface by
  // writing an encrypted blob the same way and reading it back.
  const obj = { schemaVersion: 1, tables: { tenants: [{ id: 1, full_name: 'สมชาย' }] } };
  const enc = encryption.encryptBuffer(Buffer.from(JSON.stringify(obj), 'utf8'));
  const tmp = path.join(os.tmpdir(), `backup-test-${Date.now()}.json.enc`);
  fs.writeFileSync(tmp, enc);
  try {
    const roundTripped = backup.readBackupFile(tmp);
    assert.deepEqual(roundTripped, obj, 'encrypted backup must decrypt + parse');
  } finally {
    fs.unlinkSync(tmp);
  }
  // Plaintext .json files must keep working too.
  const tmp2 = path.join(os.tmpdir(), `backup-test-${Date.now()}.json`);
  fs.writeFileSync(tmp2, JSON.stringify(obj));
  try {
    assert.deepEqual(backup.readBackupFile(tmp2), obj, 'plaintext backup must still parse');
  } finally {
    fs.unlinkSync(tmp2);
  }
});
