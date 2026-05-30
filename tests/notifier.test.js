// tests/notifier.test.js
// Unit tests for the config.notify.channels master gate — the Settings toggles
// (LINE / Email / SMS) must hard-disable a channel in the dispatcher, not be
// placebo. Default/absent → allowed (preserve behavior).
//
//   node --test tests/notifier.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const notifier = require('../services/notifier');

function fakePool(configValue) {
  return {
    query: async () => ({ rows: configValue === undefined ? [] : [{ value: configValue }] }),
  };
}

test('loadNotifyChannelGate: absent/empty config → every channel allowed', async () => {
  const gate = await notifier.loadNotifyChannelGate({ pool: fakePool(undefined) });
  assert.deepEqual(gate, { line: true, email: true, sms: true });
});

test('loadNotifyChannelGate: explicit false hard-disables that channel only', async () => {
  const gate = await notifier.loadNotifyChannelGate({
    pool: fakePool({ notify: { channels: { line: true, email: false, sms: false } } }),
  });
  assert.deepEqual(gate, { line: true, email: false, sms: false });
});

test('loadNotifyChannelGate: missing channels key → allowed (older configs keep working)', async () => {
  const gate = await notifier.loadNotifyChannelGate({
    pool: fakePool({ notify: { dueOnDay: 7 } }),
  });
  assert.deepEqual(gate, { line: true, email: true, sms: true });
});

test('loadNotifyChannelGate: only an exact boolean false blocks (truthy/other → allowed)', async () => {
  const gate = await notifier.loadNotifyChannelGate({
    pool: fakePool({ notify: { channels: { line: 0, email: null, sms: 'no' } } }),
  });
  // None are strictly === false, so all remain allowed (avoids accidental
  // disable from loosely-falsy stored values).
  assert.deepEqual(gate, { line: true, email: true, sms: true });
});

test('loadNotifyChannelGate: ctx.channels shortcut bypasses the DB read', async () => {
  let queried = false;
  const pool = { query: async () => { queried = true; return { rows: [] }; } };
  const gate = await notifier.loadNotifyChannelGate({ pool, channels: { line: false } });
  assert.deepEqual(gate, { line: false, email: true, sms: true });
  assert.equal(queried, false, 'ctx.channels must short-circuit the DB read');
});

test('loadNotifyChannelGate: DB error fails open (all channels allowed)', async () => {
  const pool = { query: async () => { throw new Error('db down'); } };
  const gate = await notifier.loadNotifyChannelGate({ pool });
  assert.deepEqual(gate, { line: true, email: true, sms: true });
});

test('notifier source: both dispatchers honor the channel gate', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'notifier.js'), 'utf8');
  // The gate must be loaded and applied to LINE, email and SMS sends.
  assert.match(src, /chGate\.line &&/, 'LINE sends must be gated');
  assert.match(src, /chGate\.email &&/, 'email sends must be gated');
  assert.match(src, /chGate\.sms &&/, 'SMS sends must be gated');
  assert.match(src, /loadNotifyChannelGate\(ctx\)/, 'both dispatchers must load the gate');
});
