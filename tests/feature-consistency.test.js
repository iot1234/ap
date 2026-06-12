// tests/feature-consistency.test.js
// Covers the feature-flag safety pass: numeric/enum config validation
// (features.validateConfig), the enriched cross-feature dependency audit with
// severity (healthCheck.checkFeatureDependencies), and the wiring that surfaces
// both at toggle-time (PUT/GET /api/admin/features + the Features page banner).

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'x'.repeat(48);
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'pwd-at-least-12-chars';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake/fake';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const features = require('../services/features');
const hc = require('../services/healthCheck');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const configPool = (value) => ({
  query: async () => ({ rows: [{ value }] }),
});

// ---- features.validateConfig ------------------------------------------------
test('validateConfig: a plain toggle and the full DEFAULTS object validate clean', () => {
  assert.equal(features.validateConfig({ slipUpload: { enabled: true } }).length, 0);
  assert.equal(features.validateConfig(features.DEFAULTS).length, 0, 'every default must be in-bounds');
  assert.equal(features.validateConfig(null).length, 0, 'null tolerated, no throw');
  assert.equal(features.validateConfig('nope').length, 0, 'non-object tolerated');
});

test('validateConfig: rejects out-of-range numbers and bad enums', () => {
  const bad = [
    [{ vat: { ratePct: 700 } }, 'ratePct'],
    [{ vat: { ratePct: -1 } }, 'ratePct'],
    [{ lateFee: { ratePctPerMonth: 999 } }, 'ratePctPerMonth'],
    [{ lateFee: { gracePeriodDays: 2.5 } }, 'gracePeriodDays'],
    [{ tenantPortal: { sessionDays: 0 } }, 'sessionDays'],
    [{ meterIot: { anomalySigmas: 99 } }, 'anomalySigmas'],
    [{ roomBooking: { holdMinutes: 0 } }, 'holdMinutes'],
    [{ roomBooking: { depositAmount: -5 } }, 'depositAmount'],
    [{ accessControl: { overdueDaysThreshold: -1 } }, 'overdueDaysThreshold'],
    [{ autoBackup: { hourUtc: 24 } }, 'hourUtc'],
    [{ billAutoGenerate: { dayOfMonth: 31 } }, 'dayOfMonth'],
    [{ slipUpload: { maxBytes: 50 } }, 'maxBytes'],
    [{ slipUpload: { maxBytes: 99_000_000 } }, 'maxBytes'],
    [{ slipUpload: { provider: 'bogus' } }, 'provider'],
    [{ sms: { provider: 'nope' } }, 'provider'],
    [{ i18n: { defaultLocale: 'fr' } }, 'defaultLocale'],
  ];
  for (const [partial, field] of bad) {
    const errs = features.validateConfig(partial);
    assert.ok(errs.some((e) => e.field === field), `expected a ${field} error for ${JSON.stringify(partial)}`);
  }
});

test('validateConfig: accepts valid values', () => {
  assert.equal(features.validateConfig({ vat: { ratePct: 7 } }).length, 0);
  assert.equal(features.validateConfig({ lateFee: { ratePctPerMonth: 1.5, gracePeriodDays: 7 } }).length, 0);
  assert.equal(features.validateConfig({ autoBackup: { hourUtc: 19, retainDays: 30 } }).length, 0);
  assert.equal(features.validateConfig({ slipUpload: { provider: 'easyslip', maxBytes: 1_500_000 } }).length, 0);
});

// ---- healthCheck.checkFeatureDependencies (enriched + severity) -------------
test('checkFeatureDependencies: slipUpload without tenantPortal is CRITICAL', async () => {
  const d = await hc.checkFeatureDependencies({ slipUpload: { enabled: true }, tenantPortal: { enabled: false } });
  const w = d.detail.warnings.find((x) => x.flag === 'slipUpload');
  assert.ok(w && w.severity === 'critical', 'must be critical');
  assert.ok(w.issue && w.fix, 'must carry a clear issue + fix');
});

test('checkFeatureDependencies: parcelNotifications without tenantPortal is CRITICAL', async () => {
  const d = await hc.checkFeatureDependencies({ parcelNotifications: { enabled: true }, tenantPortal: { enabled: false } });
  const w = d.detail.warnings.find((x) => x.flag === 'parcelNotifications');
  assert.ok(w && w.severity === 'critical', 'tenant-side parcel list must be critical without portal');
  assert.match(w.issue, /parcelNotifications/);
  assert.match(w.issue, /tenantPortal/);
});

test('checkFeatureDependencies: new vat / lateFee zero-rate checks fire', async () => {
  const dv = await hc.checkFeatureDependencies({ vat: { enabled: true, ratePct: 0 } });
  assert.ok(dv.detail.warnings.some((w) => w.flag === 'vat'), 'vat rate 0 warned');
  const dl = await hc.checkFeatureDependencies({ lateFee: { enabled: true, ratePctPerMonth: 0 } });
  assert.ok(dl.detail.warnings.some((w) => w.flag === 'lateFee'), 'lateFee rate 0 warned');
});

test('checkFeatureDependencies: requireIdentityImages without photoUpload is CRITICAL', async () => {
  const d = await hc.checkFeatureDependencies({ tenancyContract: { requireIdentityImages: true }, photoUpload: { enabled: false } });
  const w = d.detail.warnings.find((x) => x.flag === 'tenancyContract');
  assert.ok(w && w.severity === 'critical', 'checkin-blocked must be critical');
});

test('checkFeatureDependencies: citizenIdEncryption w/o dedicated key is CRITICAL', async () => {
  const savedKey = process.env.CITIZEN_ID_KEY;
  const savedV1 = process.env.ENCRYPTION_KEY_V1;
  delete process.env.CITIZEN_ID_KEY;
  delete process.env.ENCRYPTION_KEY_V1;
  try {
    const d = await hc.checkFeatureDependencies({ citizenIdEncryption: { enabled: true } });
    const w = d.detail.warnings.find((x) => x.flag === 'citizenIdEncryption');
    assert.ok(w && w.severity === 'critical', 'HKDF-fallback must be flagged critical');
  } finally {
    if (savedKey !== undefined) process.env.CITIZEN_ID_KEY = savedKey;
    if (savedV1 !== undefined) process.env.ENCRYPTION_KEY_V1 = savedV1;
  }
});

test('checkFeatureDependencies: email warns when SMTP user is missing', async () => {
  const savedHost = process.env.SMTP_HOST;
  const savedUser = process.env.SMTP_USER;
  const savedPass = process.env.SMTP_PASS;
  process.env.SMTP_HOST = 'smtp.example.test';
  delete process.env.SMTP_USER;
  process.env.SMTP_PASS = 'secret';
  try {
    const d = await hc.checkFeatureDependencies({ email: { enabled: true } });
    const w = d.detail.warnings.find((x) => x.flag === 'email');
    assert.ok(w, 'email dependency must require SMTP_USER too');
    assert.match(w.issue, /SMTP_USER/);
  } finally {
    if (savedHost === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = savedHost;
    if (savedUser === undefined) delete process.env.SMTP_USER; else process.env.SMTP_USER = savedUser;
    if (savedPass === undefined) delete process.env.SMTP_PASS; else process.env.SMTP_PASS = savedPass;
  }
});

test('health SMTP check accepts DB-stored host/user plus secret password', () => {
  const health = read('services', 'healthCheck.js');
  const smtpIdx = health.indexOf('async function checkSmtp');
  const smtpBlock = health.slice(smtpIdx, health.indexOf('async function checkR2', smtpIdx));
  assert.match(smtpBlock, /secrets\.get\('SMTP_HOST'\) \|\| features\.email\.smtpHost/,
    'SMTP health check must honor feature-stored host');
  assert.match(smtpBlock, /secrets\.get\('SMTP_USER'\) \|\| features\.email\.smtpUser/,
    'SMTP health check must honor feature-stored user');
  assert.match(smtpBlock, /secrets\.get\('SMTP_PORT'\) \|\| features\.email\.smtpPort/,
    'SMTP health check must honor feature-stored port');
});

test('checkFeatureDependencies: booking deposit with required slip needs a payment receiver', async () => {
  const savedPromptpay = process.env.PROMPTPAY_TARGET;
  delete process.env.PROMPTPAY_TARGET;
  try {
    const d = await hc.checkFeatureDependencies({
      roomBooking: {
        enabled: true,
        requireDeposit: true,
        requireSlip: true,
        depositAmount: 500,
        minimumAmount: 0,
      },
    }, configPool({ payment: {} }));
    const w = d.detail.warnings.find((x) => x.flag === 'roomBooking.requireDeposit');
    assert.ok(w && w.severity === 'critical', 'slip-required deposit booking must be critical without a receiver');
  } finally {
    if (savedPromptpay === undefined) delete process.env.PROMPTPAY_TARGET;
    else process.env.PROMPTPAY_TARGET = savedPromptpay;
  }
});

test('checkFeatureDependencies: zero booking deposit amount is critical', async () => {
  const d = await hc.checkFeatureDependencies({
    roomBooking: {
      enabled: true,
      requireDeposit: true,
      requireSlip: false,
      depositAmount: 0,
      minimumAmount: 0,
    },
  }, configPool({ payment: { bank: 'KBank', bankAcc: '111-2-22222-2' } }));
  const w = d.detail.warnings.find((x) => x.flag === 'roomBooking.depositAmount');
  assert.ok(w && w.severity === 'critical', 'zero deposit amount must be critical');
});

test('checkFeatureDependencies: paymentReminder warns when no delivery channel can work', async () => {
  const savedHost = process.env.SMTP_HOST;
  const savedUser = process.env.SMTP_USER;
  const savedPass = process.env.SMTP_PASS;
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  try {
    const d = await hc.checkFeatureDependencies({
      paymentReminder: { enabled: true },
      email: { enabled: false },
    }, configPool({ notify: { channels: { line: false, email: true } } }));
    const w = d.detail.warnings.find((x) => x.flag === 'paymentReminder');
    assert.ok(w && w.severity === 'critical', 'reminder must be critical when LINE is off and email cannot send');
  } finally {
    if (savedHost === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = savedHost;
    if (savedUser === undefined) delete process.env.SMTP_USER; else process.env.SMTP_USER = savedUser;
    if (savedPass === undefined) delete process.env.SMTP_PASS; else process.env.SMTP_PASS = savedPass;
  }
});

test('checkFeatureDependencies: every warning carries severity; consistent config => ok', async () => {
  const d = await hc.checkFeatureDependencies({ slipUpload: { enabled: true }, tenantPortal: { enabled: false }, vat: { enabled: true, ratePct: 0 } });
  for (const w of d.detail.warnings) assert.ok(['critical', 'warning'].includes(w.severity), 'severity set');
  const ok = await hc.checkFeatureDependencies({ lateFee: { enabled: true, ratePctPerMonth: 1.5 } });
  assert.equal(ok.status, 'ok');
});

// ---- wiring (source guards: server.js handlers + page render) ---------------
test('PUT /api/admin/features validates config and returns warnings', () => {
  const server = read('server.js');
  const idx = server.indexOf("app.put('/api/admin/features'");
  const body = server.slice(idx, server.indexOf('// === v2: Tenants', idx));
  assert.match(body, /features\.validateConfig\(partial\)/, 'must validate config before save');
  assert.match(body, /INVALID_FEATURE_CONFIG/, 'must return a stable invalid-config code');
  assert.match(body, /checkFeatureDependencies\(next, pool\)/, 'must compute warnings on the saved config');
  assert.match(body, /res\.json\(\{ ok: true, features: next, warnings \}\)/, 'PUT must return warnings');
  // pinned guards must remain
  assert.match(body, /PRODUCTION_SIMULATOR_BLOCKED/);
  assert.match(body, /METER_MQTT_UNAVAILABLE/);
});

test('GET /api/admin/features returns warnings without dropping canEdit/role', () => {
  const server = read('server.js');
  const getIdx = server.indexOf("app.get('/api/admin/features'");
  const getBlock = server.slice(getIdx, server.indexOf("app.put('/api/admin/features'", getIdx));
  assert.match(getBlock, /checkFeatureDependencies\(f, pool\)/, 'GET computes current warnings');
  assert.match(getBlock, /warnings,/, 'GET returns warnings');
  assert.match(getBlock, /canEdit: role === 'owner'/, 'canEdit preserved');
  assert.match(getBlock, /role,/, 'role preserved');
});

test('Features page prefers server warnings and renders severity', () => {
  const page = read('project', 'admin', 'page-features.jsx');
  assert.match(page, /setServerWarnings\(Array\.isArray\(d\.warnings\)/, 'load + save capture server warnings');
  assert.match(page, /if \(Array\.isArray\(serverWarnings\)\)/, 'server warnings take precedence over the client mirror');
  assert.match(page, /criticalWarnCount/, 'banner counts critical warnings');
  assert.match(page, /มีฟีเจอร์ที่เปิดอยู่แต่ flow ยังไม่พร้อม/, 'banner explains the feature-flow impact');
  assert.match(page, /ต้องแก้ก่อนใช้ flow/, 'critical warnings use explicit operator wording');
  assert.match(page, /<b style=\{\{ color: C\.ink \}\}>ปัญหา:<\/b>/, 'each warning separates problem from fix');
});
