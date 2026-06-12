// services/crypto.js
// AES-256-GCM helpers for encrypting sensitive PII at rest (citizen IDs,
// optionally future fields). Uses a master key from env.
//
// Key sourcing (in order):
//   1. process.env.CITIZEN_ID_KEY         — base64 32-byte key (preferred)
//   2. process.env.SESSION_SECRET (legacy) — derived via HKDF for backwards
//      compatibility; warn at startup so operators rotate to a real key.
//
// Output format: base64( iv (12) || authTag (16) || ciphertext )
// The single base64 string is what we persist in the DB column.

const crypto = require('crypto');

let _key = null;

function getKey() {
  if (_key) return _key;
  const raw = process.env.CITIZEN_ID_KEY;
  if (raw) {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== 32) {
      throw new Error('CITIZEN_ID_KEY must be base64 of exactly 32 bytes');
    }
    _key = buf;
    return _key;
  }
  // Fall back to a key derived from SESSION_SECRET. We previously refused
  // this in production because rotating SESSION_SECRET silently destroys
  // every encrypted citizen ID — but blocking the secrets-management UI
  // entirely (which is how every operator first touches the system) made
  // the app effectively unusable on a fresh deploy. We now warn loudly +
  // continue. Set CITIZEN_ID_KEY explicitly to opt out of the warning.
  //
  // Hard-fail behaviour can be restored by setting STRICT_PII_KEY=1 — for
  // operators who would rather crash than encrypt with a derived key.
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('CITIZEN_ID_KEY (preferred) or SESSION_SECRET must be set for crypto');
  }
  if (process.env.STRICT_PII_KEY === '1' &&
      (process.env.NODE_ENV || 'production') === 'production') {
    throw new Error(
      'CITIZEN_ID_KEY is required when STRICT_PII_KEY=1. Generate one with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))" ' +
      '— set it as a Railway env var, then redeploy.'
    );
  }
  if (!_warnedDerived) {
    _warnedDerived = true;
    const where = (process.env.NODE_ENV || 'production') === 'production' ? 'PRODUCTION' : 'dev';
    console.warn(
      `[crypto] ${where}: no CITIZEN_ID_KEY set — deriving from SESSION_SECRET via HKDF. ` +
      `Encrypted data will become unreadable if SESSION_SECRET is rotated. ` +
      `With EXISTING data do NOT set a random key (decrypt + dedup HMACs share this key, ` +
      `no fallback) — pin the current derived key instead: ` +
      `node -e "const c=require('crypto');console.log(Buffer.from(c.hkdfSync('sha256',` +
      `Buffer.from(process.env.S),Buffer.alloc(0),'baankarn-pii-v1',32)).toString('base64'))" ` +
      `(run with S=<current SESSION_SECRET>), then set the output as CITIZEN_ID_KEY.`
    );
  }
  _key = crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), 'baankarn-pii-v1', 32);
  return _key;
}
let _warnedDerived = false;

/**
 * Encrypt UTF-8 plaintext. Returns a single base64 string suitable for storing
 * in TEXT columns. Returns null/empty unchanged so callers can pass optional fields.
 */
function encryptString(plain) {
  if (plain == null || plain === '') return plain;
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/**
 * Decrypt back to the original UTF-8 string. Returns null/empty unchanged.
 * Throws if the ciphertext is truncated or the auth tag fails.
 */
function decryptString(b64) {
  if (b64 == null || b64 === '') return b64;
  const buf = Buffer.from(String(b64), 'base64');
  if (buf.length < 12 + 16 + 1) throw new Error('ciphertext too short');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const key = getKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Show only the last 4 of an ID (e.g. citizen ID) for display. Doesn't
 * decrypt — for masked display we go through decrypt then mask in API code.
 */
function maskTail(s, keep = 4) {
  if (!s) return '';
  const str = String(s);
  if (str.length <= keep) return '*'.repeat(str.length);
  return '*'.repeat(str.length - keep) + str.slice(-keep);
}

/**
 * Quick HMAC-SHA256 for non-reversible references (e.g. dedupe key for slips).
 */
function hmac(s) {
  const key = getKey();
  return crypto.createHmac('sha256', key).update(String(s)).digest('hex');
}

module.exports = {
  encryptString, decryptString, maskTail, hmac,
  // Internal: exposes the resolved 32-byte master key so services/encryption.js
  // can encrypt BINARY payloads (files, backups) with the same legacy key when
  // no versioned ENCRYPTION_KEY_V* is configured. Not for general use.
  _getKey: getKey,
};
