// tests/webhookSignature.test.js
// Direct tests for services/line.verifyWebhookSignature. The webhook route
// itself is harder to exercise without spinning up Express + DB; this test
// pins the HMAC contract that the route depends on so a refactor to
// verifyWebhookSignature is caught immediately.
//   node --test tests/webhookSignature.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { verifyWebhookSignature } = require('../services/line');

const SECRET = 'test-channel-secret-32-bytes-long-xx';
const oa = { channelSecret: SECRET };

function sign(body, secret = SECRET) {
  return crypto.createHmac('sha256', secret).update(body).digest('base64');
}

test('accepts a correctly-signed body (per-OA form)', () => {
  const body = JSON.stringify({ events: [{ type: 'message' }] });
  assert.equal(verifyWebhookSignature(oa, body, sign(body)), true);
});

test('rejects a tampered body', () => {
  const body = JSON.stringify({ events: [{ type: 'message' }] });
  const sig = sign(body);
  const tampered = body.replace('message', 'follow');
  assert.equal(verifyWebhookSignature(oa, tampered, sig), false);
});

test('rejects a wrong-secret signature', () => {
  const body = JSON.stringify({ events: [] });
  const wrong = sign(body, 'a-different-secret-32-bytes-long-yy');
  assert.equal(verifyWebhookSignature(oa, body, wrong), false);
});

test('rejects when signature is missing', () => {
  const body = JSON.stringify({ events: [] });
  assert.equal(verifyWebhookSignature(oa, body, null), false);
  assert.equal(verifyWebhookSignature(oa, body, ''), false);
  assert.equal(verifyWebhookSignature(oa, body, undefined), false);
});

test('rejects when secret is missing', () => {
  const body = JSON.stringify({ events: [] });
  assert.equal(verifyWebhookSignature({}, body, sign(body)), false);
  assert.equal(verifyWebhookSignature({ channelSecret: '' }, body, sign(body)), false);
});

test('a secret-less DB OA does NOT fall back to the global env channel secret', () => {
  // Regression for the per-OA isolation breach: when an OA object is passed
  // (DB OA) but has no channelSecret, verification must fail closed even if a
  // global LINE_CHANNEL_SECRET is configured in the environment. Otherwise a
  // single shared/leaked global secret could sign forged webhooks into every
  // secret-less OA.
  const prev = process.env.LINE_CHANNEL_SECRET;
  process.env.LINE_CHANNEL_SECRET = 'global-env-secret-32-bytes-long-zzzz';
  try {
    const body = JSON.stringify({ events: [] });
    // Signed with the GLOBAL secret — would verify only if the buggy env
    // fallback were still in place.
    const sigWithEnv = sign(body, process.env.LINE_CHANNEL_SECRET);
    assert.equal(verifyWebhookSignature({ id: 7, channelSecret: null }, body, sigWithEnv), false);
    assert.equal(verifyWebhookSignature({ id: 7, channelSecret: '' }, body, sigWithEnv), false);
    assert.equal(verifyWebhookSignature({ id: 7 }, body, sigWithEnv), false);
  } finally {
    if (prev === undefined) delete process.env.LINE_CHANNEL_SECRET;
    else process.env.LINE_CHANNEL_SECRET = prev;
  }
});

test('signature length mismatch returns false (not a crash)', () => {
  // A signature of the wrong length used to crash crypto.timingSafeEqual
  // — the implementation must guard with a try/catch.
  const body = JSON.stringify({ events: [] });
  assert.equal(verifyWebhookSignature(oa, body, 'short'), false);
  assert.equal(verifyWebhookSignature(oa, body, 'a'.repeat(200)), false);
});

test('byte-identical body produces the same signature regardless of formatting', () => {
  // The webhook handler sees req.rawBody captured in the express.json verify
  // callback. Two semantically-equivalent JSON bodies with different
  // whitespace produce DIFFERENT signatures — that's why rawBody is
  // captured raw, and why this test exists (regression guard).
  const a = '{"events":[]}';
  const b = '{ "events": [] }';
  const sigA = sign(a);
  assert.equal(verifyWebhookSignature(oa, a, sigA), true);
  assert.equal(verifyWebhookSignature(oa, b, sigA), false);
});
