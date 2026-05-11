// services/promptpay.js
// Wrap promptpay-qr + qrcode to produce PNG / data-URL / EMV string for a
// PromptPay payment. Target can be a Thai phone number (10 digits) or a
// 13-digit citizen ID. Amount is in THB, optional.
//
// Renderer redundancy: the primary renderer is the `qrcode` package (PNG
// buffer output). A backup renderer using `qrcode-svg` (pure-JS, no native
// deps) sits behind a try/catch so a primary failure (package corrupted,
// PNG encoder threw OOM, surprise upstream regression) silently falls
// through to the SVG path — browsers render SVG in <img> tags fine and
// Thai bank apps scan SVG QR identically to PNG (it's a vector, often
// cleaner). The caller's Content-Type is set to whichever renderer
// answered, so HTTP semantics remain correct.

const generatePayload = require('promptpay-qr');
const QRCode = require('qrcode');
const QRCodeSvg = require('qrcode-svg');

const MAX_AMOUNT = 999999;
const DEMO_TARGET = '0801234567';

function normaliseTarget(target) {
  if (!target || typeof target !== 'string') {
    throw new Error('PromptPay target required');
  }
  const clean = target.replace(/[-\s]/g, '');
  if (!/^0\d{9}$/.test(clean) && !/^\d{13}$/.test(clean)) {
    throw new Error('PromptPay target must be a 10-digit Thai phone (0XXXXXXXXX) or 13-digit citizen ID');
  }
  return clean;
}

function normaliseAmount(amount) {
  if (amount == null || amount === '') return undefined;
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT) {
    throw new Error(`PromptPay amount must be greater than 0 and <= ${MAX_AMOUNT}`);
  }
  return Math.round(n * 100) / 100;
}

function isDemoTarget(target) {
  try {
    return normaliseTarget(target) === DEMO_TARGET;
  } catch {
    return false;
  }
}

/**
 * Build the EMV-compliant PromptPay payload string.
 * @param {string} target - Phone number (10 digits) or citizen ID (13 digits).
 * @param {number} [amount] - Amount in THB. Omit for any-amount QR.
 * @returns {string} EMV payload that any Thai bank app can scan.
 */
function buildPayload(target, amount) {
  const clean = normaliseTarget(target);
  const opts = {};
  const safeAmount = normaliseAmount(amount);
  if (safeAmount != null) {
    opts.amount = safeAmount;
  }
  return generatePayload(clean, opts);
}

/**
 * Render a PromptPay QR as a PNG buffer.
 * @param {string} target - PromptPay target.
 * @param {number} [amount] - Amount in THB.
 * @param {object} [opts] - QR rendering opts (width, margin, ...).
 * @returns {Promise<Buffer>} PNG buffer.
 */
async function renderQrPng(target, amount, opts = {}) {
  const payload = buildPayload(target, amount);
  return QRCode.toBuffer(payload, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: opts.width || 480,
    color: { dark: '#2c241b', light: '#ffffff' },
  });
}

/**
 * Render a PromptPay QR as a data URL string (data:image/png;base64,...).
 */
async function renderQrDataUrl(target, amount, opts = {}) {
  const payload = buildPayload(target, amount);
  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: opts.width || 480,
    color: { dark: '#2c241b', light: '#ffffff' },
  });
}

/**
 * Render a PromptPay QR as SVG (string). Pure-JS encoder — no native bindings,
 * no PNG canvas — so it survives the most common qrcode-package failure mode
 * (PNG encoder regression or environment without canvas support). Output is
 * scannable by every Thai banking app we've tested.
 */
function renderQrSvg(target, amount, opts = {}) {
  const payload = buildPayload(target, amount);
  // qrcode-svg's defaults pick a default ECC and quiet zone that match what
  // PromptPay slips publish, so we don't have to tune it. The size matches
  // our PNG path so client layouts don't shift on fallback.
  const qr = new QRCodeSvg({
    content: payload,
    padding: 2,
    width: opts.width || 480,
    height: opts.width || 480,
    color: '#2c241b',
    background: '#ffffff',
    ecl: 'M',
    join: true,                 // optimise path commands, smaller SVG
  });
  return qr.svg();
}

/**
 * Render a QR with renderer fallback. Try the primary qrcode → PNG buffer
 * path first; if anything throws (package broken, OOM, native binding
 * trouble), fall back to qrcode-svg → SVG string. Returns:
 *   { body: Buffer|string, contentType: 'image/png'|'image/svg+xml',
 *     renderer: 'qrcode'|'qrcode-svg', primaryError?: string }
 * Throws only when BOTH renderers fail — at that point the caller should
 * surface the EMV payload text fallback (paste-to-pay) instead.
 */
async function renderQrWithFallback(target, amount, opts = {}) {
  try {
    const buffer = await renderQrPng(target, amount, opts);
    return { body: buffer, contentType: 'image/png', renderer: 'qrcode' };
  } catch (primaryErr) {
    // Log primary failure so health checks + Sentry pick it up — without
    // this the fallback silently masks a deteriorating primary renderer
    // (it might keep failing every request while SVG covers each time).
    console.warn('[promptpay] primary renderer failed, falling back to SVG:', primaryErr.message);
    try {
      const svg = renderQrSvg(target, amount, opts);
      return {
        body: svg, contentType: 'image/svg+xml',
        renderer: 'qrcode-svg', primaryError: primaryErr.message,
      };
    } catch (fallbackErr) {
      // Both renderers down — re-throw so caller can return 500 + payload
      // text fallback. Wrap so the caller sees both error messages.
      const err = new Error(
        `QR render failed on both engines — primary: ${primaryErr.message}; ` +
        `fallback: ${fallbackErr.message}`
      );
      err.code = 'QR_BOTH_RENDERERS_FAILED';
      err.primaryError = primaryErr.message;
      err.fallbackError = fallbackErr.message;
      throw err;
    }
  }
}

module.exports = {
  buildPayload,
  renderQrPng,
  renderQrDataUrl,
  renderQrSvg,
  renderQrWithFallback,
  normaliseTarget,
  normaliseAmount,
  isDemoTarget,
  MAX_AMOUNT,
  DEMO_TARGET,
};
