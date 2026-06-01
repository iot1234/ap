// tests/notifier.test.js
// Unit tests for the config.notify.channels master gate — the Settings toggles
// (LINE / Email / SMS) must hard-disable a channel in the dispatcher, not be
// placebo. Default/absent → allowed (preserve behavior).
//
//   node --test tests/notifier.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const notifier = require('../services/notifier');
const notifQueue = require('../services/notificationQueue');

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

// === F1: the channel gate must also cover the QUEUE path =====================
// bill-gen / payment reminders / the manual "ส่ง" button enqueue notifications
// DIRECTLY (bypassing notifier), so the gate has to be enforced in the queue
// dispatcher too — otherwise a disabled channel still goes out.

test('queue loadChannelGate: explicit false disables that channel (queue path)', async () => {
  const gate = await notifQueue._loadChannelGate(fakePool({ notify: { channels: { email: false } } }));
  assert.equal(gate.email, false);
  assert.equal(gate.line, true);
  assert.equal(gate.sms, true);
});

test('queue loadChannelGate: absent config / DB error → all allowed (backward compatible)', async () => {
  assert.deepEqual(await notifQueue._loadChannelGate(fakePool(undefined)), { line: true, email: true, sms: true });
  const boom = { query: async () => { throw new Error('db down'); } };
  assert.deepEqual(await notifQueue._loadChannelGate(boom), { line: true, email: true, sms: true });
});

test('queue dispatch: a gated-off channel is suppressed before any send (fatal)', async () => {
  await assert.rejects(
    () => notifQueue._dispatch({}, {}, { channel: 'email', recipient: 'a@b.com' }, { line: true, email: false, sms: true }),
    /disabled in settings/,
    'email must be suppressed when config.notify.channels.email=false, even for a directly-enqueued row',
  );
  await assert.rejects(
    () => notifQueue._dispatch({}, {}, { channel: 'line', recipient: 'U0123456789' }, { line: false }),
    /disabled in settings/,
    'line must be suppressed when gated off',
  );
});

test('queue dispatch: allowed/absent gate does NOT block (falls through to normal config check)', async () => {
  // gate email:true → passes the gate, then hits the real "not configured"
  // check (features empty) — proving the gate itself did not block.
  await assert.rejects(
    () => notifQueue._dispatch({ query: async () => ({ rows: [] }) }, {}, { channel: 'email', recipient: 'a@b.com' }, { email: true }),
    /email not configured/,
    'an allowed channel must proceed past the gate to the normal config check',
  );
  // No gate object at all → must stay backward compatible (no gating).
  await assert.rejects(
    () => notifQueue._dispatch({ query: async () => ({ rows: [] }) }, {}, { channel: 'sms', recipient: '0810000000' }, undefined),
    /SMS provider not configured/,
    'absent gate must not block',
  );
});

test('queue source: tick loads the channel gate and threads it into dispatch', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'notificationQueue.js'), 'utf8');
  assert.match(src, /const gate = await loadChannelGate\(pool\)/, 'tick must load the gate once');
  assert.match(src, /processOne\(pool, features, row, gate\)/, 'tick must pass the gate to processOne');
  assert.match(src, /dispatch\(pool, features, row, gate\)/, 'processOne must pass the gate to dispatch');
  assert.match(src, /if \(gate && gate\[channel\] === false\)/, 'dispatch must enforce the gate');
});

test('queue source: bill LINE rows without payload.messages are rebuilt as QR Flex messages', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'notificationQueue.js'), 'utf8');
  assert.match(src, /require\('\.\/billLineMessages'\)/,
    'queue dispatcher must load the bill LINE message builder');
  assert.match(src, /payload\.billId != null[\s\S]{0,220}buildQueuedBillLineMessages\(pool, row, payload\)/,
    'queue dispatcher must rebuild rich bill LINE messages from payload.billId when older jobs are text-only');
  assert.match(src, /pushMessagesStrict\(oa, row\.recipient, messages/,
    'rebuilt bill messages must be sent via LINE rich-message push');
});

test('notifyTenant sends provided LINE rich messages instead of flattening to text', async () => {
  const line = require('../services/line');
  const lineOa = require('../services/lineOa');
  const lineBinding = require('../services/lineBinding');
  const originals = {
    pushMessagesStrict: line.pushMessagesStrict,
    pushText: line.pushText,
    resolveForTenant: lineOa.resolveForTenant,
    listTenantRecipients: lineBinding.listTenantRecipients,
  };
  const seen = {};
  try {
    line.pushMessagesStrict = async (oa, userId, messages) => {
      seen.oa = oa;
      seen.userId = userId;
      seen.messages = messages;
    };
    line.pushText = async () => {
      throw new Error('pushText should not be used for rich LINE payloads');
    };
    lineOa.resolveForTenant = async () => ({
      id: 7,
      slug: 'test-oa',
      enabled: true,
      channelAccessToken: 'token',
    });
    lineBinding.listTenantRecipients = async () => [];
    const messages = [
      { type: 'flex', altText: 'bill', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [] } } },
      { type: 'text', text: 'fallback' },
    ];
    const out = await notifier.notifyTenant({ pool: fakePool(undefined), features: {} }, {
      id: 1,
      status: 'active',
      line_user_id: `U${'1'.repeat(32)}`,
      line_oa_id: 7,
    }, {
      subject: 'Bill',
      text: 'fallback text',
      messages,
    });
    assert.equal(out.ok, true);
    assert.equal(out.channel, 'line');
    assert.equal(seen.userId, `U${'1'.repeat(32)}`);
    assert.deepEqual(seen.messages, messages);
  } finally {
    line.pushMessagesStrict = originals.pushMessagesStrict;
    line.pushText = originals.pushText;
    lineOa.resolveForTenant = originals.resolveForTenant;
    lineBinding.listTenantRecipients = originals.listTenantRecipients;
  }
});

// === F4: owner email recipient must fall back to SMTP_FROM ====================
test('notifier source: owner email falls back to SMTP_FROM (not gated on features.email.from)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'notifier.js'), 'utf8');
  assert.match(src, /const ownerEmailTo = secrets\.get\('OWNER_EMAIL'\)[\s\S]{0,200}secrets\.get\('SMTP_FROM'\)/,
    'owner email recipient must resolve OWNER_EMAIL → features.email.from → SMTP_FROM');
  assert.match(src, /email\.isConfigured\(features\) && ownerEmailTo/,
    'owner email must be gated on a resolved recipient, not features.email.from');
  assert.doesNotMatch(src, /email\.isConfigured\(features\) && features\.email && features\.email\.from/,
    'inline owner email must no longer require features.email.from');
  assert.doesNotMatch(src, /email\.isConfigured\(features\) && features\?\.email\?\.from/,
    'queued owner email must no longer require features.email.from');
});
