// services/promptpay.js
// Wrap promptpay-qr + qrcode to produce PNG / data-URL / EMV string for a
// PromptPay payment. Target can be a Thai phone number (10 digits) or a
// 13-digit citizen ID. Amount is in THB, optional.

const generatePayload = require('promptpay-qr');
const QRCode = require('qrcode');

/**
 * Build the EMV-compliant PromptPay payload string.
 * @param {string} target - Phone number (10 digits) or citizen ID (13 digits).
 * @param {number} [amount] - Amount in THB. Omit for any-amount QR.
 * @returns {string} EMV payload that any Thai bank app can scan.
 */
function buildPayload(target, amount) {
  if (!target || typeof target !== 'string') {
    throw new Error('PromptPay target required');
  }
  // promptpay-qr accepts phone numbers (10-digit) and citizen IDs (13-digit)
  // automatically. Normalize: strip dashes/spaces.
  const clean = target.replace(/[-\s]/g, '');
  const opts = {};
  if (typeof amount === 'number' && amount > 0 && Number.isFinite(amount)) {
    opts.amount = amount;
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

module.exports = { buildPayload, renderQrPng, renderQrDataUrl };
