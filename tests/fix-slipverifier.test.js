// tests/fix-slipverifier.test.js
// Pins three slip-verifier fixes:
//   1) Transaction-date freshness — a provider-confirmed REAL slip that is
//      simply OLD (e.g. last month's rent transfer, originally recorded at
//      the counter so no slip_hash/transaction_ref dedup exists) must not
//      auto-verify a new bill. It parks in the admin queue (DATE_MISMATCH,
//      transient) — never auto-accepts, never hard-rejects.
//   2) EasySlip 401/403/429 (bad key, quota, rate limit) are operator-side
//      problems → PROVIDER_ERROR (transient), so the provider fallback
//      chain continues and genuine slips are not rejected as fake.
//   3) Provider-side exact amount matching (SlipOK amount, EasySlip
//      matchAmount, Slip2Go checkAmount eq) is opt-in only. verifyOne's local
//      dynamic tolerance is canonical: whole-baht bills keep the 1 THB
//      allowance, while satang-reference bills require satang-level matching.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('https');
const { EventEmitter } = require('node:events');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDaysAgo = (days) => new Date(Date.now() - days * DAY_MS).toISOString();
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]);

const PROVIDER_ENV = ['SLIPOK_API_KEY', 'SLIPOK_BRANCH_ID', 'EASYSLIP_API_KEY',
  'SLIP2GO_API_KEY', 'SLIP2GO_API_URL'];

// Same harness pattern as deep-functional.test.js: secrets fall back to
// process.env, so set keys + bust the require cache for a fresh module.
function freshVerifier(env = {}) {
  for (const k of PROVIDER_ENV) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../services/secrets')];
  delete require.cache[require.resolve('../services/slipVerifier')];
  return require('../services/slipVerifier');
}

function cleanupEnv() {
  for (const k of PROVIDER_ENV) delete process.env[k];
}

// Patch https.request and route by hostname. Each route is a function
// (requestBody, options) → { statusCode, body } or a static object.
function mockHttps(routes) {
  const original = https.request;
  const captured = [];
  https.request = (options, cb) => {
    const route = routes[options.hostname];
    const chunks = [];
    const req = new EventEmitter();
    req.write = (c) => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); };
    req.destroy = () => {};
    req.end = () => {
      if (!route) throw new Error(`unexpected host ${options.hostname}`);
      const body = Buffer.concat(chunks);
      captured.push({ host: options.hostname, options, body });
      const reply = typeof route === 'function' ? route(body, options) : route;
      const res = new EventEmitter();
      res.statusCode = reply.statusCode;
      process.nextTick(() => {
        cb(res);
        res.emit('data', typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
        res.emit('end');
      });
    };
    return req;
  };
  return { captured, restore: () => { https.request = original; } };
}

const features = (...ids) => ({ slipUpload: { autoVerify: true, providers: ids } });

const slipokSuccess = (data = {}) => ({
  statusCode: 200,
  body: {
    success: true,
    data: {
      transRef: 'TX-001',
      amount: 4500,
      sender: { displayName: 'ผู้เช่า', bank: { short: 'KBANK' }, account: { value: 'xxx-1234' } },
      receiver: { displayName: 'หอพัก', bank: { short: 'SCB' }, account: { value: 'xxx-x-x345678' } },
      transDate: isoDaysAgo(0.5),
      ...data,
    },
  },
});

// === 1) Date freshness — pure rules ========================================

test('assessSlipTransDate: fresh / stale / future / custom window', () => {
  const sv = freshVerifier();
  const now = new Date('2026-06-11T12:00:00+07:00');
  assert.equal(sv.assessSlipTransDate('2026-06-10T09:00:00+07:00', { now }).outcome, 'fresh');
  // 6 days back is inside the default 7-day window
  assert.equal(sv.assessSlipTransDate('2026-06-05T12:00:00+07:00', { now }).outcome, 'fresh');
  // last month's slip — the replay scenario — is stale
  const stale = sv.assessSlipTransDate('2026-05-05T09:00:00+07:00', { now });
  assert.equal(stale.outcome, 'stale');
  assert.ok(stale.ageDays >= 30, 'reports the age for the admin-queue message');
  // just past the window
  assert.equal(sv.assessSlipTransDate('2026-06-03T11:00:00+07:00', { now }).outcome, 'stale');
  // forward clock skew under 1 day is tolerated; beyond is suspicious
  assert.equal(sv.assessSlipTransDate('2026-06-12T06:00:00+07:00', { now }).outcome, 'fresh');
  assert.equal(sv.assessSlipTransDate('2026-06-14T12:00:00+07:00', { now }).outcome, 'future');
  // caller can tighten the window (hook for billing-period-aware callers)
  assert.equal(
    sv.assessSlipTransDate('2026-06-06T12:00:00+07:00', { now, maxAgeDays: 3 }).outcome,
    'stale');
  cleanupEnv();
});

test('assessSlipTransDate: parses the timestamp shapes providers send', () => {
  const sv = freshVerifier();
  const now = new Date('2026-06-11T12:00:00+07:00');
  // SlipOK compact YYYYMMDD
  assert.equal(sv.assessSlipTransDate('20260610', { now }).outcome, 'fresh');
  // space-separated datetime (parsed as Asia/Bangkok local)
  assert.equal(sv.assessSlipTransDate('2026-06-10 09:00:00', { now }).outcome, 'fresh');
  // Buddhist-era years must not read as 543 years in the future
  assert.equal(sv.assessSlipTransDate('2569-06-10T09:00:00+07:00', { now }).outcome, 'fresh');
  assert.equal(sv.assessSlipTransDate('25690610', { now }).outcome, 'fresh');
  // unreadable shapes park for a human — never silently pass
  for (const bad of ['N/A', '', null, undefined, 'ไม่ระบุ']) {
    assert.equal(sv.assessSlipTransDate(bad, { now }).outcome, 'unreadable',
      `${JSON.stringify(bad)} must be unreadable`);
  }
  cleanupEnv();
});

test('DATE_MISMATCH is transient — parks in admin queue, never tenant-rejects', () => {
  const sv = freshVerifier();
  // server.js classifies pending-vs-rejected purely from this exported set
  // (single source of truth), so membership IS the admin-queue guarantee.
  assert.ok(sv.TRANSIENT_CODES.has('DATE_MISMATCH'));
  cleanupEnv();
});

// === 1) Date freshness — wired into verifyOne ==============================

test('a real-but-old slip no longer auto-verifies — parks as DATE_MISMATCH', async () => {
  const sv = freshVerifier({ SLIPOK_API_KEY: 'k' });
  // Genuine June transfer (amount + receiver both match) uploaded against
  // the next month's bill: provider confirms it is real, but it is 35 days
  // old. Before the fix this auto-verified and the dorm lost a month's rent.
  const mock = mockHttps({
    'api.slipok.com': slipokSuccess({ transDate: isoDaysAgo(35) }),
  });
  try {
    const out = await sv.verifyWithFallback(JPEG,
      { amount: 4500, promptpayTarget: '0812345678' }, features('slipok'));
    assert.equal(out.ok, false);
    assert.equal(out.code, 'DATE_MISMATCH');
    assert.ok(sv.TRANSIENT_CODES.has(out.code), 'must park, not hard-reject');
    assert.equal(out.transRef, 'TX-001', 'keeps the ref for admin forensics');
  } finally {
    mock.restore();
    cleanupEnv();
  }
});

test('a slip with no readable transaction date parks instead of verifying', async () => {
  const sv = freshVerifier({ SLIPOK_API_KEY: 'k' });
  const mock = mockHttps({
    'api.slipok.com': slipokSuccess({ transDate: undefined }),
  });
  try {
    const out = await sv.verifyWithFallback(JPEG,
      { amount: 4500, promptpayTarget: '0812345678' }, features('slipok'));
    assert.equal(out.ok, false);
    assert.equal(out.code, 'DATE_MISMATCH',
      'missing date must not silently bypass the freshness check');
  } finally {
    mock.restore();
    cleanupEnv();
  }
});

// === 2) EasySlip operator-side errors ======================================

test('EasySlip 429/401/403 classify as PROVIDER_ERROR (transient), not a fake-slip reject', async () => {
  for (const [statusCode, message] of [[429, 'too_many_request'], [401, 'unauthorized'], [403, 'quota_exceeded']]) {
    const sv = freshVerifier({ EASYSLIP_API_KEY: 'k' });
    const mock = mockHttps({
      'api.easyslip.com': { statusCode, body: { status: statusCode, message } },
    });
    try {
      const out = await sv.verifyWithFallback(JPEG,
        { amount: 4500, promptpayTarget: '0812345678' }, features('easyslip'));
      assert.equal(out.ok, false);
      assert.equal(out.code, 'PROVIDER_ERROR', `HTTP ${statusCode} is operator-side`);
      assert.ok(sv.TRANSIENT_CODES.has(out.code));
    } finally {
      mock.restore();
      cleanupEnv();
    }
  }
});

test('EasySlip quota outage falls through to the next configured provider', async () => {
  const sv = freshVerifier({ EASYSLIP_API_KEY: 'k', SLIPOK_API_KEY: 'k2' });
  const mock = mockHttps({
    'api.easyslip.com': { statusCode: 429, body: { status: 429, message: 'too_many_request' } },
    'api.slipok.com': slipokSuccess(),
  });
  try {
    const out = await sv.verifyWithFallback(JPEG,
      { amount: 4500, promptpayTarget: '0812345678' }, features('easyslip', 'slipok'));
    assert.equal(out.ok, true, 'working provider must still get its turn');
    assert.equal(out.provider, 'slipok');
    assert.equal(out.attempts.length, 2);
    assert.equal(out.attempts[0].code, 'PROVIDER_ERROR');
  } finally {
    mock.restore();
    cleanupEnv();
  }
});

test('EasySlip tenant-actionable 400 still hard-rejects and stops the chain', async () => {
  const sv = freshVerifier({ EASYSLIP_API_KEY: 'k', SLIPOK_API_KEY: 'k2' });
  const mock = mockHttps({
    'api.easyslip.com': { statusCode: 400, body: { status: 400, message: 'invalid_image' } },
    'api.slipok.com': slipokSuccess(),
  });
  try {
    const out = await sv.verifyWithFallback(JPEG,
      { amount: 4500, promptpayTarget: '0812345678' }, features('easyslip', 'slipok'));
    assert.equal(out.ok, false);
    assert.equal(out.code, 'EASYSLIP_REJECT', 'a bad image is the tenant\'s to fix');
    assert.equal(out.attempts.length, 1, 'hard rejection is trusted — chain stops');
  } finally {
    mock.restore();
    cleanupEnv();
  }
});

// === 3) Provider-side exact-amount checks are opt-in =======================

test('whole-baht bank-rounded amount (plus 1 THB) auto-verifies; no exact amount sent to SlipOK', async () => {
  const sv = freshVerifier({ SLIPOK_API_KEY: 'k' });
  // Whole-baht legacy bill total 4,815; tenant transferred 4,816.00.
  // PAYMENT_TOLERANCE_THB=1.0 still accepts this for bills without satang.
  const mock = mockHttps({
    'api.slipok.com': slipokSuccess({ amount: 4816.00 }),
  });
  try {
    const out = await sv.verifyWithFallback(JPEG,
      { amount: 4815, promptpayTarget: '0812345678' }, features('slipok'));
    assert.equal(out.ok, true, '1 THB drift is within the documented tolerance for whole-baht bills');
    const sent = JSON.parse(mock.captured[0].body.toString());
    assert.ok(!('amount' in sent),
      'must not ask SlipOK for exact-equality matching by default — it would pre-empt the tolerance');
    assert.ok(sent.files, 'image still sent');
  } finally {
    mock.restore();
    cleanupEnv();
  }
});

test('decimal reference amount rejects whole-baht rounded slip locally', async () => {
  const sv = freshVerifier({ SLIPOK_API_KEY: 'k' });
  const mock = mockHttps({
    'api.slipok.com': slipokSuccess({ amount: 4816.00 }),
  });
  try {
    const out = await sv.verifyWithFallback(JPEG,
      { amount: 4815.75, promptpayTarget: '0812345678' }, features('slipok'));
    assert.equal(out.ok, false);
    assert.equal(out.code, 'AMOUNT_MISMATCH');
    const sent = JSON.parse(mock.captured[0].body.toString());
    assert.ok(!('amount' in sent),
      'provider exact-amount matching remains opt-in; the stricter satang check is local');
  } finally {
    mock.restore();
    cleanupEnv();
  }
});

test('amount beyond tolerance still hard-rejects locally (AMOUNT_MISMATCH)', async () => {
  const sv = freshVerifier({ SLIPOK_API_KEY: 'k' });
  const mock = mockHttps({
    'api.slipok.com': slipokSuccess({ amount: 4503 }),
  });
  try {
    const out = await sv.verifyWithFallback(JPEG,
      { amount: 4500, promptpayTarget: '0812345678' }, features('slipok'));
    assert.equal(out.ok, false);
    assert.equal(out.code, 'AMOUNT_MISMATCH');
    assert.ok(!sv.TRANSIENT_CODES.has(out.code), 'a 3฿ gap is a confident reject');
  } finally {
    mock.restore();
    cleanupEnv();
  }
});

test('EasySlip matchAmount omitted by default, sent only when opted in', async () => {
  const easyslipSuccess = {
    statusCode: 200,
    body: {
      success: true,
      data: {
        transRef: 'ES-1',
        amountInSlip: 4816.00,
        rawSlip: {
          transRef: 'ES-1',
          date: isoDaysAgo(0.2),
          sender: { account: { name: 'ผู้เช่า' }, bank: { short: 'KBANK' } },
          receiver: { account: { value: 'xxx-x-x345678' }, bank: { short: 'SCB' } },
        },
      },
    },
  };
  const sv = freshVerifier({ EASYSLIP_API_KEY: 'k' });
  const mock = mockHttps({ 'api.easyslip.com': easyslipSuccess });
  try {
    const expected = { amount: 4815, promptpayTarget: '0812345678' };
    const out = await sv.verifyWithFallback(JPEG, expected, features('easyslip'));
    assert.equal(out.ok, true, 'whole-baht within-tolerance drift verifies via the local check');
    const defaultBody = mock.captured[0].body.toString('latin1');
    assert.ok(!defaultBody.includes('name="matchAmount"'),
      'exact-equality matchAmount must not be sent by default');
    assert.ok(defaultBody.includes('name="checkDuplicate"'),
      'duplicate detection (no tolerance issue) stays on');

    await sv.verifyWithFallback(JPEG,
      { ...expected, providerExactAmountCheck: true }, features('easyslip'));
    assert.ok(mock.captured[1].body.toString('latin1').includes('name="matchAmount"'),
      'operators can still opt in to provider-side exact matching');
  } finally {
    mock.restore();
    cleanupEnv();
  }
});

// === Wiring guarantees (source text) =======================================

test('all three providers gate exact-amount matching behind providerExactAmountCheck', () => {
  const src = read('services', 'slipVerifier.js');
  const gates = src.match(/expected\?\.providerExactAmountCheck === true/g) || [];
  assert.equal(gates.length, 3, 'one opt-in gate each for SlipOK, EasySlip, Slip2Go');
  // Slip2Go's eq constraint (their 200402 → hard AMOUNT_MISMATCH) sits
  // behind the gate so the default path can't be pre-empted upstream.
  assert.match(src, /providerExactAmountCheck === true[\s\S]{0,160}payload\.checkAmount = \{ type: 'eq'/,
    'Slip2Go checkAmount eq must be inside the opt-in branch');
  assert.doesNotMatch(src, /amount: expected\.amount,\s*\/\/ optional cross-check/,
    'the old unconditional SlipOK amount field must be gone');
  // Date freshness is checked on the provider-read transDate in verifyOne.
  assert.match(src, /assessSlipTransDate\(result\.transDate/,
    'verifyOne must validate the slip transaction date');
});
