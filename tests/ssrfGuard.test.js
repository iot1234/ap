// tests/ssrfGuard.test.js
// Locks down the SSRF guard against IPv4-in-IPv6 evasion. Regression test for
// the bypass where new URL() normalises ::ffff:127.0.0.1 to the hex form
// ::ffff:7f00:1, defeating a dotted-decimal-only check and letting an
// operator-supplied URL reach loopback / cloud metadata / NAT64 targets.

const { test } = require('node:test');
const assert = require('node:assert');
const guard = require('../services/ssrfGuard');

function blocked(url) {
  try { guard.assertSafeUrl(url); return false; }
  catch { return true; }
}

test('ssrfGuard blocks literal private/reserved IPv4', () => {
  for (const u of [
    'https://127.0.0.1/x',
    'https://10.0.0.5/x',
    'https://192.168.1.1/x',
    'https://169.254.169.254/latest/meta-data/', // cloud metadata
    'https://172.16.0.1/x',
    'https://100.64.0.1/x',                        // CGNAT
  ]) {
    assert.equal(blocked(u), true, `should block ${u}`);
  }
});

test('ssrfGuard blocks IPv6 loopback / link-local / unique-local', () => {
  for (const u of ['https://[::1]/x', 'https://[fe80::1]/x', 'https://[fc00::1]/x', 'https://[fd12::1]/x']) {
    assert.equal(blocked(u), true, `should block ${u}`);
  }
});

test('ssrfGuard blocks IPv4-mapped IPv6 in BOTH dotted and hex form', () => {
  // new URL() compresses the dotted form to hex; both must be blocked.
  assert.equal(blocked('https://[::ffff:127.0.0.1]/x'), true, 'dotted mapped loopback');
  assert.equal(blocked('https://[::ffff:7f00:1]/x'), true, 'hex mapped loopback');
  assert.equal(blocked('https://[::ffff:a9fe:a9fe]/x'), true, 'hex mapped 169.254.169.254 metadata');
  assert.equal(blocked('https://[::ffff:10.0.0.1]/x'), true, 'mapped private');
});

test('ssrfGuard blocks NAT64 and IPv4-compatible embeddings of private IPs', () => {
  assert.equal(blocked('https://[64:ff9b::7f00:1]/x'), true, 'NAT64 -> 127.0.0.1');
  assert.equal(blocked('https://[64:ff9b::a9fe:a9fe]/x'), true, 'NAT64 -> metadata');
  assert.equal(blocked('https://[::7f00:1]/x'), true, 'IPv4-compatible -> 127.0.0.1');
});

test('ssrfGuard still ALLOWS public hosts and public IPv6', () => {
  assert.equal(blocked('https://example.com/x'), false, 'public hostname');
  assert.equal(blocked('https://[2606:4700:4700::1111]/x'), false, 'public IPv6 (Cloudflare DNS)');
  // A mapped *public* IPv4 should remain reachable (only private/reserved are blocked).
  assert.equal(blocked('https://[::ffff:8.8.8.8]/x'), false, 'mapped public 8.8.8.8');
});

test('ssrfGuard rejects non-https and hostless URLs', () => {
  assert.equal(blocked('http://example.com/x'), true, 'http rejected by default');
  assert.equal(blocked('ftp://example.com/x'), true, 'ftp rejected');
  assert.equal(blocked('not a url'), true, 'garbage rejected');
});

test('ssrfGuard blocks internal/reserved hostnames', () => {
  for (const u of [
    'https://localhost/x',
    'https://db.internal/x',
    'https://service.local/x',
    'https://foo.localhost/x',
  ]) {
    assert.equal(blocked(u), true, `should block ${u}`);
  }
});

test('isBlockedIp helper agrees on the embedded-IPv4 cases', () => {
  assert.equal(guard.isBlockedIp('::ffff:7f00:1'), true);
  assert.equal(guard.isBlockedIp('::ffff:a9fe:a9fe'), true);
  assert.equal(guard.isBlockedIp('64:ff9b::7f00:1'), true);
  assert.equal(guard.isBlockedIp('::ffff:8.8.8.8'), false);
  assert.equal(guard.isBlockedIp('2606:4700:4700::1111'), false);
});
