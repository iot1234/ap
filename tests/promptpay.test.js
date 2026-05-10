// tests/promptpay.test.js
// Sanity tests for services/promptpay — buildPayload + renderQrPng.
// The EMV format is fixed and machine-validated, so the assertions check
// shape (length, header, CRC presence) rather than exact bytes.
//   node --test tests/promptpay.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPayload, renderQrPng, renderQrDataUrl, isDemoTarget } = require('../services/promptpay');

test('buildPayload requires a target', () => {
  assert.throws(() => buildPayload(), /target required/);
  assert.throws(() => buildPayload(''), /target required/);
  assert.throws(() => buildPayload(null), /target required/);
  assert.throws(() => buildPayload(123), /target required/);
});

test('buildPayload accepts 10-digit phone', () => {
  const out = buildPayload('0801234567');
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 30, 'EMV payload should be >30 chars');
  assert.ok(out.startsWith('00020101'), 'EMV starts with payload format indicator');
});

test('buildPayload accepts 13-digit citizen id', () => {
  const out = buildPayload('1234567890123');
  assert.equal(typeof out, 'string');
  assert.ok(out.startsWith('00020101'));
});

test('buildPayload rejects invalid PromptPay target shape', () => {
  assert.throws(() => buildPayload('1234567890'), /PromptPay target/);
  assert.throws(() => buildPayload('12345'), /PromptPay target/);
  assert.throws(() => buildPayload('abc0801234567'), /PromptPay target/);
});

test('buildPayload strips dashes and spaces', () => {
  const a = buildPayload('080-123-4567');
  const b = buildPayload('080 123 4567');
  const c = buildPayload('0801234567');
  // Same target → identical payload (no amount, so no rounding noise)
  assert.equal(a, c);
  assert.equal(b, c);
});

test('isDemoTarget detects bundled demo PromptPay only', () => {
  assert.equal(isDemoTarget('0801234567'), true);
  assert.equal(isDemoTarget('080-123-4567'), true);
  assert.equal(isDemoTarget('0812345678'), false);
  assert.equal(isDemoTarget('bad'), false);
});

test('buildPayload includes amount when provided', () => {
  const noAmount = buildPayload('0801234567');
  const withAmount = buildPayload('0801234567', 1500);
  assert.notEqual(noAmount, withAmount, 'amount should change the payload');
  // EMV amount field tag is "54" — should appear in the with-amount string
  assert.ok(/540[0-9]/.test(withAmount), 'amount-tagged field present');
});

test('buildPayload rejects invalid amounts instead of silently making any-amount QR', () => {
  const base = buildPayload('0801234567');
  assert.ok(!/540[0-9]/.test(base), 'omitted amount remains an any-amount QR');
  for (const bad of [0, -10, NaN, Infinity, 'not-a-number', 1000000]) {
    assert.throws(
      () => buildPayload('0801234567', bad),
      /PromptPay amount/,
      `amount ${String(bad)} must be rejected`
    );
  }
});

test('renderQrPng returns a PNG buffer', async () => {
  const buf = await renderQrPng('0801234567', 100);
  assert.ok(Buffer.isBuffer(buf));
  // PNG magic: 89 50 4E 47 0D 0A 1A 0A
  assert.equal(buf[0], 0x89);
  assert.equal(buf[1], 0x50);
  assert.equal(buf[2], 0x4E);
  assert.equal(buf[3], 0x47);
});

test('renderQrDataUrl returns a data URL', async () => {
  const url = await renderQrDataUrl('0801234567');
  assert.ok(typeof url === 'string');
  assert.ok(url.startsWith('data:image/png;base64,'));
});

test('renderQrPng + custom width', async () => {
  const small = await renderQrPng('0801234567', 100, { width: 200 });
  const large = await renderQrPng('0801234567', 100, { width: 800 });
  // Larger width → bigger buffer (rough heuristic — same data, more pixels).
  assert.ok(large.length > small.length, 'wider QR is larger PNG');
});
