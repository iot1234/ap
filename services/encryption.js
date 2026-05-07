// services/encryption.js
// AES-256-GCM with key versioning. Wraps services/crypto.js with a versioned
// payload header so we can rotate keys without losing access to old data.
//
// On-disk format (base64):
//   v<KEY_VERSION>$<iv(12)+tag(16)+ciphertext>
//
// Multiple keys may be configured at once via:
//   ENCRYPTION_KEY_V1=<base64-32-bytes>
//   ENCRYPTION_KEY_V2=<base64-32-bytes>
//   ENCRYPTION_KEY_CURRENT=2
//
// New encryptions use the CURRENT version; old ciphertexts decrypt with
// whichever version is in their prefix. Without ENCRYPTION_KEY_V* set, this
// module falls through to services/crypto.js so existing data still works.

const crypto = require('crypto');
const legacyCrypto = require('./crypto');

let _keys = null;
let _current = null;

function loadKeys() {
  if (_keys) return _keys;
  _keys = new Map();
  for (const [k, v] of Object.entries(process.env)) {
    const m = k.match(/^ENCRYPTION_KEY_V(\d+)$/);
    if (!m) continue;
    const ver = Number(m[1]);
    const buf = Buffer.from(v, 'base64');
    if (buf.length !== 32) {
      console.warn(`[encryption] ENCRYPTION_KEY_V${ver} is not 32 bytes — ignored`);
      continue;
    }
    _keys.set(ver, buf);
  }
  _current = Number(process.env.ENCRYPTION_KEY_CURRENT || 0)
    || (_keys.size ? Math.max(...Array.from(_keys.keys())) : 0);
  return _keys;
}

function encryptString(plain) {
  if (plain == null || plain === '') return plain;
  loadKeys();
  if (!_current) {
    // Fall through to legacy single-key path
    return legacyCrypto.encryptString(plain);
  }
  const key = _keys.get(_current);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, ct]).toString('base64');
  return `v${_current}$${payload}`;
}

function decryptString(stored) {
  if (stored == null || stored === '') return stored;
  const s = String(stored);
  const m = s.match(/^v(\d+)\$(.+)$/);
  if (!m) {
    // No version prefix → legacy ciphertext
    return legacyCrypto.decryptString(s);
  }
  loadKeys();
  const ver = Number(m[1]);
  const key = _keys.get(ver);
  if (!key) throw new Error(`encryption key v${ver} not loaded`);
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 12 + 16 + 1) throw new Error('ciphertext too short');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function currentVersion() { loadKeys(); return _current; }
function loadedVersions() { loadKeys(); return Array.from(_keys.keys()).sort(); }

module.exports = {
  encryptString,
  decryptString,
  currentVersion,
  loadedVersions,
  // Re-export helpers from legacy for callers that want masking/HMAC
  maskTail: legacyCrypto.maskTail,
  hmac: legacyCrypto.hmac,
};
