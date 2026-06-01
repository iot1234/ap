// tests/features.test.js
// Tests withDefaults / deepMerge behavior of services/features.js without
// touching a real database.
//   node --test tests/features.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const features = require('../services/features');

test('withDefaults returns all keys when stored is null', () => {
  const f = features.withDefaults(null);
  assert.ok('tenantPortal' in f);
  assert.ok('lateFee' in f);
  assert.equal(f.tenantPortal.enabled, false);
  assert.equal(f.lateFee.enabled, true);
});

test('withDefaults shallow-merges enabled flags', () => {
  const f = features.withDefaults({ tenantPortal: { enabled: true } });
  assert.equal(f.tenantPortal.enabled, true);
  // Other defaults preserved
  assert.equal(f.tenantPortal.sessionDays, 30);
  assert.equal(f.lateFee.enabled, true);
});

test('withDefaults preserves nested config', () => {
  const f = features.withDefaults({ lateFee: { ratePctPerMonth: 2.0 } });
  assert.equal(f.lateFee.enabled, true);
  assert.equal(f.lateFee.ratePctPerMonth, 2.0);
  assert.equal(f.lateFee.gracePeriodDays, 7);
  assert.equal(f.lateFee.minLateFeeBaht, 0);
  assert.equal(f.lateFee.maxPctOfPrincipal, 0);
  assert.equal(f.lateFee.maxLateFeeBaht, 0);
});

test('validateConfig validates late-fee caps', () => {
  assert.deepEqual(
    features.validateConfig({ lateFee: { minLateFeeBaht: 20, maxPctOfPrincipal: 50, maxLateFeeBaht: 500 } }),
    []
  );
  const bad = features.validateConfig({
    lateFee: { minLateFeeBaht: -1, maxPctOfPrincipal: 101, maxLateFeeBaht: -1 },
  });
  assert.equal(bad.length, 3);
  assert.ok(bad.some((e) => e.field === 'minLateFeeBaht'));
  assert.ok(bad.some((e) => e.field === 'maxPctOfPrincipal'));
  assert.ok(bad.some((e) => e.field === 'maxLateFeeBaht'));
});

test('slipUpload does not trust tenant uploads by default', () => {
  const f = features.withDefaults({ slipUpload: { enabled: true, requireVerification: false } });
  assert.equal(f.slipUpload.allowUnverifiedAutoApprove, false);
});

test('disabledPayload returns a structured client-facing error', () => {
  const out = features.disabledPayload('meterIot', { id: 'req-123' });
  assert.equal(out.code, 'FEATURE_DISABLED');
  assert.equal(out.feature, 'meterIot');
  assert.equal(out.enabled, false);
  assert.equal(out.requestId, 'req-123');
  assert.match(out.hint, /\/admin#features/);
});

test('DEFAULTS keys are stable (regression guard)', () => {
  const expected = ['tenantPortal','slipUpload','photoUpload','meterIot','accessControl',
    'recurringCharges','lateFee','vat','email','sms','i18n','darkMode','softDelete',
    'citizenIdEncryption','errorTracking','autoBackup','billAutoGenerate'];
  for (const k of expected) {
    assert.ok(k in features.DEFAULTS, `missing default flag: ${k}`);
  }
});
