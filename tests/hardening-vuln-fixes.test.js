// tests/hardening-vuln-fixes.test.js
// Pins the vulnerability fixes from the June 2026 security hardening pass:
//   1. ssrfGuard.safeLookup — connect-time DNS pinning (DNS-rebinding TOCTOU)
//   2. Slip2Go + R2/S3 outbound calls route through the pinned resolver
//   3. LINE BIND / owner-claim code entropy bumps
//   4. Permissions-Policy response header
//   5. slip replay-after-reversal guard in the payment upload path

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ssrf = require('../services/ssrfGuard');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// --- 1. safeLookup: blocks literal internal targets, fails closed ----------

function lookup(host, opts = { all: false }) {
  return new Promise((resolve) => {
    ssrf.safeLookup(host, opts, (err, addr, fam) => resolve({ err, addr, fam }));
  });
}

test('safeLookup is exported as a function', () => {
  assert.equal(typeof ssrf.safeLookup, 'function');
});

test('safeLookup blocks loopback / metadata / private literal IPs', async () => {
  for (const ip of ['127.0.0.1', '169.254.169.254', '10.1.2.3', '192.168.0.5', '172.16.9.9', '0.0.0.0']) {
    const { err } = await lookup(ip);
    assert.ok(err, `${ip} must be blocked`);
  }
});

test('safeLookup blocks IPv6 loopback and IPv4-mapped loopback literals', async () => {
  for (const ip of ['::1', '::ffff:127.0.0.1']) {
    const { err } = await lookup(ip);
    assert.ok(err, `${ip} must be blocked`);
  }
});

test('safeLookup passes a public literal IP straight through (no DNS)', async () => {
  const { err, addr } = await lookup('8.8.8.8');
  assert.ifError(err);
  assert.equal(addr, '8.8.8.8');
});

test('safeLookup with {all:true} returns an array for a public literal', async () => {
  const { err, addr } = await lookup('1.1.1.1', { all: true });
  assert.ifError(err);
  assert.ok(Array.isArray(addr) && addr[0].address === '1.1.1.1');
});

test('safeLookup fails closed when the host cannot be resolved', async () => {
  // No outbound DNS in the sandbox → resolution error → blocked (never silently allowed)
  const { err, addr } = await lookup('this-name-should-not-resolve.invalid');
  assert.ok(err, 'unresolvable host must error, not return an address');
  assert.equal(addr, undefined);
});

// --- 2. outbound calls use the pinned resolver -----------------------------

test('Slip2Go request pins DNS via ssrfGuard.safeLookup', () => {
  const src = read('services/slipVerifier.js');
  assert.match(src, /lookup:\s*ssrfGuard\.safeLookup/, 'Slip2Go request must set lookup: ssrfGuard.safeLookup');
  // and still validate with the resolving assert beforehand
  assert.match(src, /assertSafeUrlResolved/);
});

test('R2/S3 client pins DNS on its https agent', () => {
  const src = read('services/storage.js');
  assert.match(src, /new https\.Agent\(\{[^}]*lookup:\s*ssrfGuard\.safeLookup/);
  assert.match(src, /NodeHttpHandler/);
});

// --- 3. code entropy -------------------------------------------------------

test('LINE BIND codes are now 12 hex chars (48-bit)', () => {
  const lb = require('../services/lineBinding');
  for (let i = 0; i < 20; i++) {
    assert.match(lb.generateCode(), /^BIND-[A-F0-9]{12}$/);
  }
});

test('owner-claim codes are now 16 hex chars (64-bit) and still recognised', () => {
  const oc = require('../services/ownerClaim');
  for (let i = 0; i < 20; i++) {
    const c = oc.generateCode();
    assert.match(c, /^OWNER-[A-F0-9]{16}$/);
    assert.ok(oc.isClaimCode(c), 'new 16-hex code must be recognised');
  }
  // legacy 8-hex codes still validate (any unexpired ones in flight)
  assert.ok(oc.isClaimCode('OWNER-DEADBEEF'));
});

// --- 4. Permissions-Policy header ------------------------------------------

test('server sets a locked-down Permissions-Policy header', () => {
  const src = read('server.js');
  assert.match(src, /res\.setHeader\(\s*'Permissions-Policy'/);
  assert.match(src, /camera=\(\)/);
  assert.match(src, /geolocation=\(\)/);
});

// --- 5. slip replay-after-reversal guard -----------------------------------

test('payment upload routes reversed-ref slips to admin review, not auto-verify', () => {
  const src = read('server.js');
  assert.match(src, /Replay-after-reversal guard/);
  assert.match(src, /superseded_by_void:%/);
  assert.match(src, /unmark_paid_correction:%/);
  // it must downgrade to pending (review), never silently keep 'verified'
  const block = src.slice(src.indexOf('Replay-after-reversal guard'), src.indexOf('Replay-after-reversal guard') + 2600);
  assert.match(block, /initialStatus = 'pending'/);
});

test('void and unmark-paid still stamp the distinguishing rejected_reason the guard keys on', () => {
  const src = read('routes/bills-extras.js');
  assert.match(src, /superseded_by_void:/);
  assert.match(src, /unmark_paid_correction:/);
});
