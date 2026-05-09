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
  // Resolve _current carefully: an explicit ENCRYPTION_KEY_CURRENT that
  // points at a version which failed the 32-byte check would otherwise
  // make encryptString crash on first write (createCipheriv called with
  // `undefined`). Fall back to the highest valid loaded version, or 0
  // (legacy single-key path) if nothing valid is loaded.
  const explicit = Number(process.env.ENCRYPTION_KEY_CURRENT || 0);
  if (explicit && _keys.has(explicit)) {
    _current = explicit;
  } else {
    if (explicit && !_keys.has(explicit)) {
      console.warn(
        `[encryption] ENCRYPTION_KEY_CURRENT=${explicit} but ENCRYPTION_KEY_V${explicit} is missing/invalid — ` +
        `falling back to highest loaded key`
      );
    }
    _current = _keys.size ? Math.max(...Array.from(_keys.keys())) : 0;
  }
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
  if (!key) {
    // Defensive: should be unreachable after loadKeys() validation, but the
    // cost of being wrong is "silently corrupt encrypted column" so guard
    // anyway. Fall through to legacy rather than throwing inside a write.
    console.warn('[encryption] _current points at a missing key — falling through to legacy crypto');
    return legacyCrypto.encryptString(plain);
  }
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

/**
 * Boot-time self-test. Throws if encryption is configured but broken so a
 * misconfigured deploy fails fast at startup instead of crashing the first
 * write to `secrets` / `line_oas.channel_access_token_encrypted`.
 *
 * Returns a status object suitable for /api/admin/health.
 */
function validateAtBoot() {
  loadKeys();
  // Versioned-key mode is "selected" by the operator setting any
  // ENCRYPTION_KEY_V* env var (even an invalid one) OR ENCRYPTION_KEY_CURRENT.
  // We detect that intent across the env directly so we can distinguish
  // "operator never set anything → fall through to legacy" from "operator
  // tried to set keys but they're all invalid → fail boot loudly."
  const versionedIntent = Object.keys(process.env).some(
    (k) => /^ENCRYPTION_KEY_V\d+$/.test(k) || k === 'ENCRYPTION_KEY_CURRENT'
  );
  if (_keys.size === 0) {
    if (versionedIntent) {
      throw new Error(
        '[encryption] no usable key for encrypting (loaded=none). ' +
        'Operator set ENCRYPTION_KEY_V*/ENCRYPTION_KEY_CURRENT but every value failed the 32-byte check. ' +
        'Provide a valid 32-byte base64-encoded key (generate with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))").'
      );
    }
    return { ok: true, mode: 'legacy', message: 'No ENCRYPTION_KEY_V* set — using legacy single-key crypto.' };
  }
  if (!_current || !_keys.has(_current)) {
    throw new Error(
      `[encryption] no usable key for encrypting (_current=${_current}, loaded=${Array.from(_keys.keys()).join(',') || 'none'}). ` +
      `Set ENCRYPTION_KEY_CURRENT to a version whose ENCRYPTION_KEY_V<N> env var is a valid 32-byte base64 string.`
    );
  }
  // Round-trip a probe so misconfigured AES keys (corrupted base64 etc.)
  // surface here, not on a user-visible write.
  const probe = 'encryption-self-test-' + Math.random().toString(36).slice(2, 8);
  const enc = encryptString(probe);
  const dec = decryptString(enc);
  if (dec !== probe) {
    throw new Error('[encryption] self-test round-trip failed — encryption is misconfigured');
  }
  return { ok: true, mode: 'versioned', current: _current, loaded: Array.from(_keys.keys()) };
}

module.exports = {
  encryptString,
  decryptString,
  currentVersion,
  loadedVersions,
  validateAtBoot,
  // Re-export helpers from legacy for callers that want masking/HMAC
  maskTail: legacyCrypto.maskTail,
  hmac: legacyCrypto.hmac,
};
