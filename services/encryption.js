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

/**
 * Async canary check against the DB. Catches the most dangerous operator
 * mistake: overwriting an existing ENCRYPTION_KEY_V<N> in place (instead of
 * adding a new V<N+1>). The synchronous validateAtBoot() only round-trips
 * with the CURRENT key, so a same-version key replacement would pass it
 * cleanly while every old ciphertext in the DB becomes unreadable.
 *
 * On first boot: encrypts a known plaintext + persists to app_data.
 * On later boots: decrypts the stored canary; if it fails, the current
 * key set can't read existing ciphertexts (keys were rotated incorrectly).
 *
 * Caller is expected to halt boot when this returns ok:false in production.
 */
async function validateCanary(pool) {
  if (!pool) return { ok: true, mode: 'skipped' };
  loadKeys();
  if (_keys.size === 0) return { ok: true, mode: 'legacy', reason: 'no versioned keys' };
  const KEY = 'encryption_canary_v1';
  const CANARY_PLAINTEXT = 'baankarn-encryption-canary-v1';
  try {
    const { rows } = await pool.query(
      `SELECT value FROM app_data WHERE key=$1 LIMIT 1`,
      [KEY]
    );
    if (!rows.length) {
      const encoded = encryptString(CANARY_PLAINTEXT);
      await pool.query(
        `INSERT INTO app_data (key, value, updated_at)
           VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO NOTHING`,
        [KEY, JSON.stringify({ ciphertext: encoded, createdAt: new Date().toISOString() })]
      );
      return { ok: true, mode: 'created' };
    }
    const stored = rows[0].value;
    const ciphertext = stored && stored.ciphertext;
    if (!ciphertext) return { ok: true, mode: 'no-canary' };
    const decoded = decryptString(ciphertext);
    if (decoded !== CANARY_PLAINTEXT) {
      return {
        ok: false,
        reason: 'canary decrypted but plaintext mismatch — keys were rotated incorrectly',
      };
    }
    return { ok: true, mode: 'verified', version: ciphertext.match(/^v(\d+)\$/)?.[1] || 'legacy' };
  } catch (err) {
    return {
      ok: false,
      reason: `canary decrypt failed: ${err.message}. ` +
              'Existing ciphertexts (secrets, citizen_id) will be unreadable. ' +
              'If you intended to rotate keys, ADD a new ENCRYPTION_KEY_V<N+1> ' +
              'and set ENCRYPTION_KEY_CURRENT=<N+1> — do NOT overwrite an existing V<N>.',
    };
  }
}

// --- Binary (file) encryption -----------------------------------------------
// AES-256-GCM over raw bytes — used for uploaded files (citizen-ID images,
// payment slips, signatures) and database backups at rest. Same key registry
// as encryptString: versioned ENCRYPTION_KEY_V* when configured, else the
// legacy single key (CITIZEN_ID_KEY / SESSION_SECRET-derived).
//
// On-disk format:
//   'APENC1' (6 bytes) || keyVersion uint8 (0 = legacy key) ||
//   iv (12) || authTag (16) || ciphertext
//
// decryptBuffer passes non-magic buffers through unchanged so files written
// before encryption landed keep being readable with zero migration.
const FILE_MAGIC = Buffer.from('APENC1', 'ascii');

function _bufferKey(ver) {
  loadKeys();
  if (ver === 0) return legacyCrypto._getKey();
  const key = _keys.get(ver);
  if (!key) throw new Error(`encryption key v${ver} not loaded`);
  return key;
}

function isEncryptedBuffer(buf) {
  return Buffer.isBuffer(buf)
    && buf.length > FILE_MAGIC.length + 1 + 12 + 16
    && buf.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC);
}

function encryptBuffer(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('encryptBuffer expects a Buffer');
  loadKeys();
  const ver = _current || 0;   // 0 → legacy single-key path
  const key = _bufferKey(ver);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([FILE_MAGIC, Buffer.from([ver & 0xff]), iv, tag, ct]);
}

function decryptBuffer(buf) {
  if (!isEncryptedBuffer(buf)) return buf;   // legacy plaintext passthrough
  const ver = buf[FILE_MAGIC.length];
  const off = FILE_MAGIC.length + 1;
  const iv = buf.subarray(off, off + 12);
  const tag = buf.subarray(off + 12, off + 28);
  const ct = buf.subarray(off + 28);
  const key = _bufferKey(ver);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Citizen-ID PII canary — the sibling validateCanary() above only round-trips
 * the versioned ENCRYPTION_KEY_V* registry. Citizen IDs (and their dedup HMAC)
 * are keyed SEPARATELY by services/crypto.js (CITIZEN_ID_KEY, or by default an
 * HKDF derivation of the rotatable SESSION_SECRET). Without this check, an
 * operator who rotates SESSION_SECRET without pinning CITIZEN_ID_KEY makes
 * every stored citizen_id_encrypted permanently undecryptable and breaks dedup
 * — while boot still reports "verified/legacy". This stores a known probe at
 * first boot and re-decrypts it on every later boot through the SAME PII key
 * path, so that silent loss becomes loud.
 *
 * Caller decides the response (we keep boot alive on mismatch — see server.js —
 * so a PII-display fault never takes rent/billing offline; it just alarms).
 */
async function validateCitizenIdCanary(pool) {
  if (!pool) return { ok: true, mode: 'skipped' };
  const KEY = 'citizenid_canary_v1';
  const CANARY_PLAINTEXT = 'baankarn-citizenid-canary-v1';
  let probe;
  try {
    probe = legacyCrypto.encryptString(CANARY_PLAINTEXT);
  } catch (err) {
    // No resolvable PII key (neither CITIZEN_ID_KEY nor SESSION_SECRET). The
    // first real citizen-id write would fail anyway; surface as info, not a
    // key-rotation mismatch, so we don't false-alarm on an unconfigured box.
    return { ok: true, mode: 'no-key', reason: err.message };
  }
  try {
    const { rows } = await pool.query(
      `SELECT value FROM app_data WHERE key=$1 LIMIT 1`,
      [KEY]
    );
    if (!rows.length) {
      await pool.query(
        `INSERT INTO app_data (key, value, updated_at)
           VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO NOTHING`,
        [KEY, JSON.stringify({ ciphertext: probe, createdAt: new Date().toISOString() })]
      );
      return { ok: true, mode: 'created' };
    }
    const ciphertext = rows[0].value && rows[0].value.ciphertext;
    if (!ciphertext) return { ok: true, mode: 'no-canary' };
    let decoded;
    try {
      decoded = legacyCrypto.decryptString(ciphertext);
    } catch (err) {
      return {
        ok: false,
        reason: `citizen-id canary decrypt failed: ${err.message}. The PII key changed `
          + '(SESSION_SECRET rotated without pinning CITIZEN_ID_KEY?) — existing citizen_id_encrypted '
          + 'is now unreadable and dedup is broken.',
      };
    }
    if (decoded !== CANARY_PLAINTEXT) {
      return {
        ok: false,
        reason: 'citizen-id canary plaintext mismatch — the PII key changed; existing citizen IDs are unreadable.',
      };
    }
    return { ok: true, mode: 'verified' };
  } catch (err) {
    // A DB hiccup must not gate boot — treat as skip, like validateCanary's
    // own outer behaviour for transient errors.
    return { ok: true, mode: 'db-skip', reason: err.message };
  }
}

module.exports = {
  encryptString,
  decryptString,
  encryptBuffer,
  decryptBuffer,
  isEncryptedBuffer,
  currentVersion,
  loadedVersions,
  validateAtBoot,
  validateCanary,
  validateCitizenIdCanary,
  // Re-export helpers from legacy for callers that want masking/HMAC
  maskTail: legacyCrypto.maskTail,
  hmac: legacyCrypto.hmac,
};
