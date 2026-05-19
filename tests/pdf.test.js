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
function pageCount(buf) {
  return (buf.toString('binary').match(/\/Type\s*\/Page\b/g) || []).length;
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

test('renderBillPdf renders utility reading detail rows without throwing', async () => {
  const sink = memSink();
  await renderBillPdf({
    ...minimalBill,
    items: [
      { label: 'ค่าเช่าห้องพัก', qty: '1 เดือน', amount: 5000 },
      {
        label: 'ค่าน้ำ',
        qty: '15.50 หน่วย × 18',
        detail: 'เลขก่อน 120  เลขหลัง 135.50  ใช้ 15.50 หน่วย',
        amount: 279,
      },
      {
        label: 'ค่าไฟฟ้า',
        qty: '125 หน่วย × 8',
        detail: 'เลขก่อน 1500  เลขหลัง 1625  ใช้ 125 หน่วย',
        amount: 1000,
      },
    ],
    total: 6279,
  }, sink);
  const buf = sink.getBuffer();
  assert.equal(buf.slice(0, 5).toString('ascii'), '%PDF-');
  assert.ok(pageCount(buf) <= 2, 'meter detail should not force blank pages');
});

test('renderBillPdf with paymentMethods list renders without throwing', async () => {
  const sink = memSink();
  await renderBillPdf({
    ...minimalBill,
    paymentMethods: [
      { key: 'promptpay', label: 'PromptPay', enabled: true },
      { key: 'bank', label: 'SCB 123-456789-0', enabled: true },
      { key: 'linePay', label: 'LINE Pay', enabled: true },
      { key: 'truemoney', label: 'TrueMoney Wallet • 0812345678', enabled: true },
    ],
  }, sink);
  assert.ok(sink.getBuffer().length > 1000);
});

test('renderBillPdf handles empty items array', async () => {
  const sink = memSink();
  await renderBillPdf({ ...minimalBill, items: [], total: 0 }, sink);
  assert.ok(sink.getBuffer().length > 500);
});

test('renderBillPdf paginates long item tables without blank-page explosion', async () => {
  const sink = memSink();
  await renderBillPdf({
    ...minimalBill,
    items: Array.from({ length: 28 }, (_, i) => ({
      label: `ค่าบริการเพิ่มเติม ${i + 1}`,
      qty: '1',
      amount: 100 + i,
    })),
    total: 4000,
    bankInfo: { bank: 'ไทยพาณิชย์', account: '123-456789-0', name: 'นาง ก.' },
    paymentMethods: [
      { key: 'linePay', label: 'LINE Pay', enabled: true },
      { key: 'cash', label: 'เงินสดที่สำนักงาน', enabled: true },
    ],
  }, sink);
  const buf = sink.getBuffer();
  assert.equal(buf.slice(0, 5).toString('ascii'), '%PDF-');
  assert.ok(pageCount(buf) <= 3,
    '28 line items should paginate to a few dense pages, not many mostly blank pages');
});

test('renderBillPdf handles long header, tenant, and payment text without throwing', async () => {
  const long = 'Long customer facing text for PDF layout wrapping '.repeat(10);
  const sink = memSink();
  await renderBillPdf({
    ...minimalBill,
    billNo: `INV-${long}`,
    roomId: `ROOM-${long}`,
    tenantName: `Tenant ${long}`,
    tenantPhone: `080-123-4567 ${long}`,
    period: `May 2026 ${long}`,
    building: {
      name: `Building ${long}`,
      address: `Address ${long}`,
      phone: `02-555-1234 ${long}`,
    },
    items: Array.from({ length: 8 }, (_, i) => ({
      label: `Service ${i + 1} ${long}`,
      qty: `quantity ${long}`,
      detail: `detail ${long}`,
      amount: 1000 + i,
    })),
    total: 12000,
    bankInfo: {
      bank: `Bank ${long}`,
      account: `Account ${long}`,
      name: `Account owner ${long}`,
    },
    paymentMethods: [
      { key: 'linePay', label: `LINE Pay ${long}`, enabled: true },
      { key: 'cash', label: `Cash at office ${long}`, enabled: true },
      { key: 'wallet', label: `Wallet transfer ${long}`, enabled: true },
    ],
  }, sink);
  const buf = sink.getBuffer();
  assert.equal(buf.slice(0, 5).toString('ascii'), '%PDF-');
  assert.ok(pageCount(buf) <= 4, 'long text should wrap inside blocks without page explosion');
});

test('renderBillPdf layout uses measured blocks instead of fixed overlapping positions', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'pdf.js'), 'utf8');
  assert.match(src, /function drawTenantBlock\(startY\)/,
    'tenant block must start from the measured header bottom');
  assert.match(src, /const tenantBlockH = Math\.max/,
    'tenant block height must be based on rendered text');
  assert.match(src, /let y = drawHeader\(\);/,
    'table flow must start after the dynamic header');
  assert.match(src, /const continuationText = truncateText/,
    'continuation-page header must cap long bill and room identifiers');
  assert.match(src, /const extraMethodHeights = extraMethods\.map/,
    'payment method rows must measure wrapped labels');
  assert.match(src, /const bankCardH = hasBank\s*\?\s*Math\.max/,
    'bank transfer card must expand beyond the old fixed height');
  assert.doesNotMatch(src, /let y = 220;/,
    'fixed table start overlapped long header and tenant details');
  assert.doesNotMatch(src, /const bankCardH = hasBank \? 76 : 0;/,
    'fixed bank-card height clips long bank account text');
});
