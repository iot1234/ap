// Regression guards for the LINE webhook reply policy.
// Unknown normal text must stay silent; only verifiable keys and explicit
// commands may trigger a bot reply.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhooks.js'), 'utf8');
const handlerStart = src.indexOf('async function handleEvent');
const helperStart = src.indexOf('// --- intent helpers');
const handleEventBlock = src.slice(handlerStart, helperStart);

test('LINE webhook recognises only verified keys and explicit commands', () => {
  assert.match(handleEventBlock, /ownerClaim\.isClaimCode\(text\)/,
    'owner claim keys must stay recognised');
  assert.match(handleEventBlock, /\^BIND-\[A-F0-9\]\{4,16\}/,
    'tenant binding keys must stay recognised');
  assert.match(handleEventBlock, /\^\(help\|/,
    'help/menu command must stay recognised');
  assert.match(handleEventBlock, /bills\?\|invoice/,
    'bill command must stay recognised');
  assert.match(handleEventBlock, /status\|/,
    'status command must stay recognised');
  assert.match(handleEventBlock, /maintenance\|[\s\S]{0,80}repair/,
    'maintenance command must stay recognised');
});

test('LINE webhook is silent for unrecognised normal text', () => {
  assert.match(handleEventBlock, /Unknown normal text is intentionally silent/,
    'the no-reply policy must be explicit in the handler');
  assert.doesNotMatch(handleEventBlock, /if \(text\.length < 200\)/,
    'short free-form text must not use the old auto-reply fallback');
  assert.doesNotMatch(handleEventBlock, /\u0e02\u0e2d\u0e1a\u0e04\u0e38\u0e13\u0e04\u0e48\u0e30/,
    'unknown text must not reply with the old generic thank-you fallback');
  assert.match(handleEventBlock, /return;\s*\}\s*$/,
    'the final unrecognised-text path must terminate silently');
});
