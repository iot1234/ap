// tests/contractPdf.test.js
// Smoke tests for the contract PDF renderer + the resolveClauses helper.
// Renders a full contract into a memory stream and asserts the result is
// a valid PDF (header + non-trivial size). Doesn't visually verify layout
// (PDF is binary) but catches every "the renderer crashes" regression.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');

const contractPdf = require('../services/contractPdf');

function memStream() {
  const chunks = [];
  const s = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
  });
  s._chunks = chunks;
  s.toBuffer = () => Buffer.concat(chunks);
  return s;
}

const SAMPLE_CONTRACT = {
  contractNo: 'C-2026-0001',
  startDate: '2026-05-15',
  endDate: '2027-05-14',
  monthlyRent: 5500,
  deposit: 11000,
  discountPct: 5,
  termMonths: 12,
  signedAt: null,
  agreedTermsVersion: 'v1.0-2026-01',
  status: 'active',
};
const SAMPLE_TENANT = {
  fullName: 'สมชาย ใจดี',
  phone: '0812345678',
  email: 'somchai@example.com',
  citizenIdMasked: '***-***-1234',
  address: '99/9 ถนนสุขุมวิท แขวงคลองตันเหนือ เขตวัฒนา กรุงเทพฯ 10110',
  emergencyContactName: 'แม่สมชาย',
  emergencyContactPhone: '0898765432',
};
const SAMPLE_ROOM = { id: '203' };
const SAMPLE_BUILDING = {
  name: 'บ้านกาญจน์ เรสซิเดนซ์',
  address: '88/8 ถ.พหลโยธิน',
  phone: '02-555-1234',
  taxId: '0105550012345',
  ownerName: 'นายเจ้าของ ใจดี',
};

test('renderContractPdf: produces a valid PDF buffer', async () => {
  const stream = memStream();
  await contractPdf.renderContractPdf(
    SAMPLE_CONTRACT, SAMPLE_TENANT, SAMPLE_ROOM, SAMPLE_BUILDING,
    {}, stream
  );
  const buf = stream.toBuffer();
  assert.ok(buf.length > 1000, 'PDF must have non-trivial size');
  assert.equal(buf.slice(0, 4).toString('ascii'), '%PDF',
    'PDF magic bytes must be present');
});

test('renderContractPdf: works without optional building fields', async () => {
  const stream = memStream();
  await contractPdf.renderContractPdf(
    SAMPLE_CONTRACT, SAMPLE_TENANT, SAMPLE_ROOM, {}, {}, stream
  );
  assert.ok(stream.toBuffer().length > 1000);
});

test('renderContractPdf: works without endDate (open-ended contract)', async () => {
  const stream = memStream();
  await contractPdf.renderContractPdf(
    { ...SAMPLE_CONTRACT, endDate: null, termMonths: null },
    SAMPLE_TENANT, SAMPLE_ROOM, SAMPLE_BUILDING, {}, stream
  );
  assert.ok(stream.toBuffer().length > 1000);
});

test('renderContractPdf: embeds online signature buffer when supplied', async () => {
  const stream = memStream();
  // 1×1 PNG (the smallest valid PNG) — black pixel.
  const tinyPng = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000d49444154789c6300010000000005000158a0a89e0000000049454e44ae426082',
    'hex'
  );
  await contractPdf.renderContractPdf(
    { ...SAMPLE_CONTRACT, signedAt: '2026-05-15T10:00:00Z' },
    SAMPLE_TENANT, SAMPLE_ROOM, SAMPLE_BUILDING,
    { signatures: { tenantBuf: tinyPng } },
    stream
  );
  const buf = stream.toBuffer();
  assert.ok(buf.length > 1000, 'must produce a valid PDF');
  assert.equal(buf.slice(0, 4).toString('ascii'), '%PDF',
    'PDF magic bytes must still be present after embedding signature');
  // PDFKit output size is non-deterministic (compression streams), so we
  // can't assert "with-image is bigger than without". The smoke test is
  // just: it doesn't throw + still produces a valid PDF.
});

test('renderContractPdf: handles a long terms list across pages', async () => {
  // 30 clauses → forces multiple pages.
  const longTerms = {
    mode: 'override',
    clauses: Array.from({ length: 30 }, (_, i) => ({
      id: `c${i + 1}`,
      title: `ข้อบังคับเสริม ${i + 1}`,
      body: 'นี่คือข้อความทดสอบเนื้อหายาว '.repeat(20),
    })),
  };
  const stream = memStream();
  await contractPdf.renderContractPdf(
    SAMPLE_CONTRACT, SAMPLE_TENANT, SAMPLE_ROOM, SAMPLE_BUILDING,
    { termsTemplate: longTerms }, stream
  );
  const buf = stream.toBuffer();
  assert.ok(buf.length > 5000, 'multi-page contract must be >5kb');
  // Crude page-count check via the /Page object marker.
  const text = buf.toString('binary');
  const pageMatches = text.match(/\/Type\s*\/Page\b/g) || [];
  assert.ok(pageMatches.length >= 2, 'long contract must span ≥ 2 pages');
});

test('resolveClauses: null/empty template returns defaults', () => {
  const r1 = contractPdf.resolveClauses(null);
  const r2 = contractPdf.resolveClauses(undefined);
  const r3 = contractPdf.resolveClauses({});
  assert.equal(r1.length, contractPdf.DEFAULT_CLAUSES.length);
  assert.equal(r2.length, contractPdf.DEFAULT_CLAUSES.length);
  assert.equal(r3.length, contractPdf.DEFAULT_CLAUSES.length);
});

test('resolveClauses: append mode adds custom after defaults', () => {
  const out = contractPdf.resolveClauses({
    mode: 'append',
    clauses: [{ title: 'X', body: 'y' }],
  });
  assert.equal(out.length, contractPdf.DEFAULT_CLAUSES.length + 1);
  assert.equal(out[out.length - 1].title, 'X');
  // First clause must still be the first default.
  assert.equal(out[0].title, contractPdf.DEFAULT_CLAUSES[0].title);
});

test('resolveClauses: override mode replaces defaults entirely', () => {
  const out = contractPdf.resolveClauses({
    mode: 'override',
    clauses: [
      { title: 'A', body: 'a' },
      { title: 'B', body: 'b' },
    ],
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'A');
});

test('resolveClauses: override with empty clauses falls back to defaults', () => {
  // Renderer-side safety: an admin who toggles override but submits zero
  // clauses shouldn't get a contract with zero rules. The endpoint already
  // 400s on this, but defense-in-depth at the renderer level too.
  const out = contractPdf.resolveClauses({ mode: 'override', clauses: [] });
  assert.equal(out.length, contractPdf.DEFAULT_CLAUSES.length);
});

test('DEFAULT_CLAUSES: each clause has id + title + body', () => {
  for (const c of contractPdf.DEFAULT_CLAUSES) {
    assert.ok(c.id, 'clause must have stable id');
    assert.ok(c.title, 'clause must have title');
    assert.ok(c.body && c.body.length > 20, 'clause body must be substantive');
  }
});

test('DEFAULT_CLAUSES: covers the standard Thai dorm contract topics', () => {
  // Pin the list of essential topics so a refactor can't accidentally
  // drop e.g. "deposit" or "termination".
  const ids = new Set(contractPdf.DEFAULT_CLAUSES.map((c) => c.id));
  for (const required of ['rental', 'rent_payment', 'deposit', 'term',
                          'utilities', 'usage', 'maintenance', 'noise',
                          'visitors', 'termination', 'return']) {
    assert.ok(ids.has(required), `default clauses must cover ${required}`);
  }
});

test('renderContractPdf: missing fonts falls back gracefully (no throw)', async () => {
  // Mock fs.existsSync briefly to simulate missing font files. PDFKit
  // should still produce a PDF using Helvetica.
  const fs = require('node:fs');
  const realExists = fs.existsSync;
  fs.existsSync = (p) => /Sarabun/.test(p) ? false : realExists(p);
  try {
    const stream = memStream();
    await contractPdf.renderContractPdf(
      SAMPLE_CONTRACT, SAMPLE_TENANT, SAMPLE_ROOM, SAMPLE_BUILDING, {}, stream
    );
    assert.ok(stream.toBuffer().length > 500,
      'must produce SOMETHING even without the Thai font');
  } finally {
    fs.existsSync = realExists;
  }
});
