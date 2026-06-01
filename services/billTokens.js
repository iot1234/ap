// Shared signing helpers for public bill payment and QR links.
//
// server.js owns the runtime session secret (env SESSION_SECRET in production,
// random ephemeral in dev). It calls configureRuntimeSecret() once during boot
// so background workers can sign the same links that server routes verify.

const crypto = require('crypto');

const BILL_QR_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BILL_PAY_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let runtimeSecret = process.env.SESSION_SECRET || null;
const fallbackRuntimeSecret = runtimeSecret || crypto.randomBytes(48).toString('base64');

function configureRuntimeSecret(secret) {
  if (secret) runtimeSecret = String(secret);
}

function currentSecret() {
  return runtimeSecret || process.env.SESSION_SECRET || fallbackRuntimeSecret;
}

function signingKey(scope) {
  return crypto.createHash('sha256').update(`${currentSecret()}|${scope}`).digest();
}

function toUrlSafeBase64(buf) {
  return buf.toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signScopedToken(scope, ttlMs, billId, expiresAt) {
  const exp = Math.floor((expiresAt || Date.now() + ttlMs) / 1000);
  const payload = `${billId}.${exp}`;
  const sig = toUrlSafeBase64(crypto.createHmac('sha256', signingKey(scope)).update(payload).digest());
  return `${exp}.${sig}`;
}

function verifyScopedToken(scope, billId, token) {
  if (!token || typeof token !== 'string') return false;
  const [expStr, sig] = String(token).split('.');
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= 0) return false;
  if (Date.now() > exp * 1000) return false;
  const expected = toUrlSafeBase64(
    crypto.createHmac('sha256', signingKey(scope)).update(`${billId}.${exp}`).digest()
  );
  try {
    return crypto.timingSafeEqual(Buffer.from(sig || ''), Buffer.from(expected));
  } catch {
    return false;
  }
}

function signBillQrToken(billId, expiresAt) {
  return signScopedToken('bill-qr', BILL_QR_TOKEN_TTL_MS, billId, expiresAt);
}

function verifyBillQrToken(billId, token) {
  return verifyScopedToken('bill-qr', billId, token);
}

function signBillPayToken(billId, expiresAt) {
  return signScopedToken('bill-pay', BILL_PAY_TOKEN_TTL_MS, billId, expiresAt);
}

function verifyBillPayToken(billId, token) {
  return verifyScopedToken('bill-pay', billId, token);
}

module.exports = {
  BILL_QR_TOKEN_TTL_MS,
  BILL_PAY_TOKEN_TTL_MS,
  configureRuntimeSecret,
  signBillQrToken,
  verifyBillQrToken,
  signBillPayToken,
  verifyBillPayToken,
};
