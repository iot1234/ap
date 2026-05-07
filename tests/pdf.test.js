// tests/pdf.test.js
// Smoke tests for services/pdf.renderBillPdf. Generates a real PDF into a
// memory buffer and verifies the magic bytes + non-empty payload. Visual
// regression isn't possible without a renderer, but this catches outright
// crashes from the layout code (e.g. a missing field on the bill object,
// undefined deref on payment block, font registration errors).
//   node --test tests/pdf.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');

const { renderBillPdf } = require('../services/pdf');

function memSink() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, enc, cb) { chunks.push(chunk); cb(); },
  });
  stream.getBuffer = () => Buffer.concat(chunks);
  return stream;
}

const minimalBill = {
  billNo: 'TEST-001',
  roomId: '305',
  tenantName: 'คุณทดสอบ',
  tenantPhone: '0801234567',
  period: 'พฤษภาคม 2569',
  dueDate: '15/05/2026',
  items: [
    { label: 'ค่าเช่าห้อง', amount: 5000 },
    { label: 'ค่าน้ำ',     amount: 200 },
    { label: 'ค่าไฟ',     amount: 800 },
  ],
  total: 6000,
  building: { name: 'บ้านกาญจน์ เรสซิเดนซ์' },
};

test('renderBillPdf produces a valid PDF for a minimal bill', async () => {
  const sink = memSink();
  await renderBillPdf({ ...minimalBill }, sink);
  const buf = sink.getBuffer();
  assert.ok(buf.length > 1000, 'PDF should be at least 1KB');
  // PDF magic: %PDF-
  assert.equal(buf.slice(0, 5).toString('ascii'), '%PDF-');
  // PDF tail: %%EOF (trailing newline optional)
  assert.ok(buf.slice(-10).toString('ascii').includes('%%EOF'));
});

test('renderBillPdf works without optional payment block', async () => {
  const sink = memSink();
  await renderBillPdf({ ...minimalBill }, sink);
  assert.ok(sink.getBuffer().length > 0);
});

test('renderBillPdf with PromptPay target embeds QR', async () => {
  const sink = memSink();
  await renderBillPdf(
    { ...minimalBill, promptpayTarget: '0801234567', promptpayName: 'นาง ก.' },
    sink
  );
  const buf = sink.getBuffer();
  // QR adds image data — should make the PDF noticeably larger than the
  // minimal version (loose lower bound; exact size depends on PDFKit).
  assert.ok(buf.length > 3000, 'PDF with QR should be >3KB');
});

test('renderBillPdf with bank info renders without throwing', async () => {
  const sink = memSink();
  await renderBillPdf({
    ...minimalBill,
    bankInfo: { bank: 'ไทยพาณิชย์', account: '123-456789-0', name: 'นาง ก.' },
  }, sink);
  assert.ok(sink.getBuffer().length > 1000);
});

test('renderBillPdf with paymentMethods list renders without throwing', async () => {
  const sink = memSink();
  await renderBillPdf({
    ...minimalBill,
    paymentMethods: [
      { key: 'promptpay', label: 'PromptPay', enabled: true },
      { key: 'bank', label: 'SCB 123-456789-0', enabled: true },
      { key: 'linePay', label: 'LINE Pay', enabled: true },
    ],
  }, sink);
  assert.ok(sink.getBuffer().length > 1000);
});

test('renderBillPdf handles empty items array', async () => {
  const sink = memSink();
  await renderBillPdf({ ...minimalBill, items: [], total: 0 }, sink);
  assert.ok(sink.getBuffer().length > 500);
});
