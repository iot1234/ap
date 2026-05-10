// services/promptpay.js
// Wrap promptpay-qr + qrcode to produce PNG / data-URL / EMV string for a
// PromptPay payment. Target can be a Thai phone number (10 digits) or a
// 13-digit citizen ID. Amount is in THB, optional.

const generatePayload = require('promptpay-qr');
const QRCode = require('qrcode');

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

module.exports = {
  buildPayload,
  renderQrPng,
  renderQrDataUrl,
  normaliseTarget,
  normaliseAmount,
  isDemoTarget,
  MAX_AMOUNT,
  DEMO_TARGET,
};
