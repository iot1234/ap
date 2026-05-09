// services/thaiId.js
// Thailand citizen-ID utilities:
//   - validateChecksum(s)   : verify the 13-digit ID's check digit (mod-11)
//   - normalize(s)          : strip dashes/spaces, return 13 digits or null
//   - hashForLookup(s)      : HMAC-SHA256 of the normalised digits, used as
//                             a searchable dedup key without ever decrypting
//
// The mod-11 algorithm is the official spec from กรมการปกครอง: multiply each
// of the first 12 digits by 13..2, sum, take mod 11, subtract from 11, mod 10.
// Implementation chosen for clarity over micro-optimisation.

const cryptoSvc = require('./crypto');

/**
 * Strip dashes/spaces and return the 13-digit string. Returns null if the
 * input doesn't normalise to exactly 13 digits.
 */
function normalize(input) {
  if (input == null) return null;
  const digits = String(input).replace(/[\s-]/g, '');
  if (!/^\d{13}$/.test(digits)) return null;
  return digits;
}

/**
 * Validate the mod-11 check digit. Returns true iff the input is exactly
 * 13 digits AND the 13th matches the computed check digit.
 *
 * Note: for compatibility with pre-existing data in the wild that may have
 * been entered by hand without the official checksum, callers should treat
 * a `false` return as a soft warning (advisory) — except at admin-create
 * time where typo prevention matters most.
 */
function validateChecksum(input) {
  const s = normalize(input);
  if (!s) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(s[i]) * (13 - i);
  }
  const check = (11 - (sum % 11)) % 10;
  return check === Number(s[12]);
}

/**
 * Searchable HMAC of the full ID. Storing the hash on `tenants.citizen_id_hash`
 * lets us put a partial unique index on it (catching "same person registered
 * twice") without ever exposing the plaintext digits to a SELECT.
 *
 * Returns null when input doesn't normalise — callers must treat null as
 * "no hash available, no dedup possible" rather than colliding on null.
 */
function hashForLookup(input) {
  const s = normalize(input);
  if (!s) return null;
  return cryptoSvc.hmac(`thai-id:${s}`);
}

/**
 * Last four digits, used for the no-PIN-yet first-login flow + display
 * masking. Shorter helper around String#slice with explicit normalisation.
 */
function tail(input, n = 4) {
  const s = normalize(input);
  if (!s) return null;
  return s.slice(-n);
}

module.exports = { normalize, validateChecksum, hashForLookup, tail };
