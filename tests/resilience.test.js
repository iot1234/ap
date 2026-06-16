// tests/resilience.test.js
// Data-I/O resilience guards: external responses and exports must not be able
// to exhaust process memory. Source-pattern pins (the repo convention).
//   node --test tests/resilience.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('slip-verify providers cap the response body size (no unbounded accumulation -> OOM)', () => {
  const src = read('services', 'slipVerifier.js');
  assert.match(src, /const MAX_PROVIDER_RESPONSE_BYTES = 1_000_000/,
    'a per-provider response byte cap must be defined');
  // The cap must be enforced inside the data handler that accumulates the body,
  // aborting the request when exceeded — for ALL THREE providers.
  const aborts = src.match(/respBytes > MAX_PROVIDER_RESPONSE_BYTES\)\s*\{\s*req\.destroy/g) || [];
  assert.ok(aborts.length >= 3,
    `each slip-verify provider must abort an over-cap response (found ${aborts.length}, expected >= 3)`);
  // The old unbounded pattern must be gone.
  assert.doesNotMatch(src, /res\.on\('data', \(c\) => \{ buf \+= c; \}\)/,
    'the unbounded buf += c accumulation must be replaced by the capped reader');
});

test('report exports fail loud instead of buffering an unbounded result set', () => {
  const src = read('routes', 'reports.js');
  assert.match(src, /const EXPORT_MAX_ROWS = 100_000/,
    'a max export row count must be defined');
  assert.match(src, /rows\.length > EXPORT_MAX_ROWS[\s\S]{0,500}EXPORT_TOO_LARGE/,
    'send() must reject (not silently truncate) an over-cap export so data stays complete');
});
