// tests/contractInvitation.test.js
// Unit tests for the tenant self-fill invitation service. Pure-function
// helpers (token gen, hash, sanitise, public-view shape) — no DB needed.

const test = require('node:test');
const assert = require('node:assert/strict');

// Token gen + hash require CITIZEN_ID_KEY since contractInvitation pulls
// crypto via services/crypto. Set env before requiring.
process.env.CITIZEN_ID_KEY = Buffer.alloc(32, 7).toString('base64');
delete require.cache[require.resolve('../services/crypto')];

const inv = require('../services/contractInvitation');

test('generateToken returns base64url + 32-byte sha256 hash', () => {
  const t = inv.generateToken();
  assert.ok(typeof t.token === 'string');
  // 32 bytes → 43 base64url chars (no padding)
  assert.ok(t.token.length >= 40 && t.token.length <= 50,
    `token length should be ~43, got ${t.token.length}`);
  // base64url: only A-Z a-z 0-9 _ -
  assert.ok(/^[A-Za-z0-9_-]+$/.test(t.token));
  // sha256 → 64 hex
  assert.match(t.hash, /^[a-f0-9]{64}$/);
});

test('generateToken produces unique tokens (collision-free)', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const t = inv.generateToken();
    assert.ok(!seen.has(t.token), 'tokens must be unique');
    seen.add(t.token);
  }
});

test('hashToken matches generateToken hash for the same input', () => {
  const t = inv.generateToken();
  const h2 = inv.hashToken(t.token);
  assert.equal(h2, t.hash, 'hashToken(token) must equal stored hash');
});

test('hashToken returns null on malformed inputs (404 path, no crash)', () => {
  assert.equal(inv.hashToken(null), null);
  assert.equal(inv.hashToken(''), null);
  assert.equal(inv.hashToken(123), null);
  assert.equal(inv.hashToken('!!! not base64url'), null);
  assert.equal(inv.hashToken('short'), null);
  // Wrong-length base64url that decodes to NOT 32 bytes
  // 'A'.repeat(20) → 15 bytes (≠ 32) → null
  assert.equal(inv.hashToken('A'.repeat(20)), null);
  // 'A'.repeat(80) is too long for our format regex (max 80 chars)
  // and 90+ chars would fail the regex outright
  assert.equal(inv.hashToken('A'.repeat(90)), null);
});

test('sanitiseDraft caps strings + drops unknown keys', () => {
  const out = inv.sanitiseDraft({
    address: 'a'.repeat(1000),
    emergencyContactName: 'b'.repeat(500),
    emergencyContactPhone: '081-234-5678',
    emergencyContactRelation: 'แม่',
    citizenId: '1-1111-11111-11-1XX',     // dashes + extra → cleaned to digits
    citizenIdImageFrontId: '5',
    citizenIdImageBackId: 6,
    signatureFileId: 7,
    notes: 'x'.repeat(2000),
    // Unknown keys must be dropped
    secretKey: 'attacker',
    __proto__: { evil: true },
  });
  assert.equal(out.address.length, 500);
  assert.equal(out.emergencyContactName.length, 200);
  assert.equal(out.emergencyContactPhone, '0812345678', 'phone must be normalised');
  assert.equal(out.emergencyContactRelation, 'แม่');
  // citizen ID: digits only, max 13
  assert.equal(out.citizenId, '1111111111111');
  // FK ids coerced to integers
  assert.equal(out.citizenIdImageFrontId, 5);
  assert.equal(out.citizenIdImageBackId, 6);
  assert.equal(out.signatureFileId, 7);
  assert.equal(out.notes.length, 1000);
  // Unknown keys dropped
  assert.equal(out.secretKey, undefined);
});

test('sanitiseDraft handles undefined / null fields safely', () => {
  const out = inv.sanitiseDraft({});
  assert.deepEqual(Object.keys(out), [], 'empty input → empty output');
  // null inputs explicitly cleared
  const out2 = inv.sanitiseDraft({ address: null, citizenIdImageFrontId: 'not-a-number' });
  assert.equal(out2.address, null);
  assert.equal(out2.citizenIdImageFrontId, null);
});

test('sanitiseDraft phone normalisation matches admin tenant CRUD', () => {
  // The same phoneStr regex used elsewhere — strip dashes + spaces.
  const out = inv.sanitiseDraft({ emergencyContactPhone: '081 234 5678' });
  assert.equal(out.emergencyContactPhone, '0812345678');
  const out2 = inv.sanitiseDraft({ emergencyContactPhone: '081-234-5678' });
  assert.equal(out2.emergencyContactPhone, '0812345678');
});

test('buildPublicView excludes sensitive fields', () => {
  const fakeInvitation = {
    id: 1, status: 'pending',
    expires_at: new Date(),
    contract_no: 'C-1', room_id: '101',
    monthly_rent: 5000, deposit: 10000,
    start_date: '2026-05-01', end_date: '2027-04-30',
    term_months: 12, discount_pct: 5,
    tenant_id: 99, tenant_name: 'Test', tenant_phone: '0812345678', tenant_email: 'a@b.c',
    rejection_reason: null,
    draft: { address: '123 ถ.สุขุมวิท' },
    // Sensitive — must NOT be exposed to the tenant via this view
    token_hash: 'should-not-leak',
    created_by: 'admin',
    approved_by: null,
  };
  const view = inv.buildPublicView(fakeInvitation, { name: 'หอพัก' });
  // Exposed
  assert.equal(view.contract.contractNo, 'C-1');
  assert.equal(view.contract.roomId, '101');
  assert.equal(view.draft.address, '123 ถ.สุขุมวิท');
  // NOT exposed
  assert.equal(view.token_hash, undefined);
  assert.equal(view.created_by, undefined);
  assert.equal(view.approved_by, undefined);
});

test('ACTIVE_STATUSES vs TERMINAL_STATUSES are disjoint + complete', () => {
  // The state machine: pending|submitted active; approved|rejected|revoked|expired terminal.
  for (const s of ['pending', 'submitted']) assert.ok(inv.ACTIVE_STATUSES.has(s));
  for (const s of ['approved', 'rejected', 'revoked', 'expired'])
    assert.ok(inv.TERMINAL_STATUSES.has(s));
  // No overlap
  for (const s of inv.ACTIVE_STATUSES)
    assert.ok(!inv.TERMINAL_STATUSES.has(s),
      `${s} can't be both active and terminal`);
});
