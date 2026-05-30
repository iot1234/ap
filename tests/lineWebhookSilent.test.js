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
const lookupStart = src.indexOf('// Lookup must include');
const intentHelpersBlock = src.slice(helperStart, lookupStart);

test('LINE webhook recognises only verified keys and explicit commands', () => {
  assert.match(handleEventBlock, /ownerClaim\.isClaimCode\(text\)/,
    'owner claim keys must stay recognised');
  assert.match(handleEventBlock, /isBindCode\(text\)/,
    'tenant binding keys must stay recognised');
  assert.match(handleEventBlock, /isHelpCommand\(text\)/,
    'help/menu command must stay recognised');
  assert.match(handleEventBlock, /isBillCommand\(text\)/,
    'bill command must stay recognised');
  assert.match(handleEventBlock, /isRoomStatusCommand\(text\)/,
    'status command must stay recognised');
  assert.match(handleEventBlock, /isMaintenanceCommand\(text\)/,
    'maintenance command must stay recognised');
  assert.match(intentHelpersBlock, /\^BIND-\[A-F0-9\]\{4,16\}/,
    'binding keys must still require the strict BIND-hex shape');
  assert.match(intentHelpersBlock, /bills\?\|invoice/,
    'bill aliases must stay explicit');
  assert.match(intentHelpersBlock, /maintenance\|[\s\S]{0,80}repair/,
    'maintenance aliases must stay explicit');
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

test('LINE webhook avoids DB lookups until a bound-only command is confirmed', () => {
  const helpIdx = handleEventBlock.indexOf('if (isHelpCommand(text))');
  const maintenanceIdx = handleEventBlock.indexOf('if (isMaintenanceCommand(text))');
  const billIdx = handleEventBlock.indexOf('if (isBillCommand(text))');
  const statusIdx = handleEventBlock.indexOf('if (isRoomStatusCommand(text))');
  const silentIdx = handleEventBlock.indexOf('Unknown normal text is intentionally silent');

  assert.ok(helpIdx > 0, 'help command dispatch must exist');
  assert.ok(maintenanceIdx > helpIdx, 'maintenance command should be handled before DB-bound commands');
  assert.ok(billIdx > maintenanceIdx, 'bill command dispatch must exist after non-DB commands');
  assert.ok(statusIdx > billIdx, 'status command dispatch must exist');
  assert.ok(silentIdx > statusIdx, 'silent fallback must remain the final text path');

  assert.doesNotMatch(handleEventBlock.slice(0, billIdx), /getBoundTenant/,
    'free-form/help/maintenance text must not query tenant binding state');
  assert.match(handleEventBlock.slice(billIdx, statusIdx), /await getBoundTenant/,
    'bill command must still load the bound tenant');
  assert.match(handleEventBlock.slice(statusIdx, silentIdx), /await getBoundTenant/,
    'status command must still load the bound tenant');
});

test('LINE text is normalised before command matching', () => {
  assert.match(handleEventBlock, /normaliseLineText\(ev\.message\.text\)/,
    'handler must normalise inbound text before command checks');
  assert.match(intentHelpersBlock, /\.normalize\('NFKC'\)/,
    'normalisation must collapse full-width command/key characters');
  assert.match(intentHelpersBlock, /\\u200B-\\u200D\\uFEFF/,
    'normalisation must remove invisible zero-width characters');
});
