// tests/configValidation.test.js
// Server-side semantic validation for baankarn_config_v1 PUTs.
// Mirrors the inline validator in server.js — if the validator changes,
// these tests must be updated together. The point is to lock in the
// "rate=1฿ typo" defense found in production (May 2026) without blocking
// deliberate special pricing.

const { test } = require('node:test');
const assert = require('node:assert');

// === Pure validator extracted to test shape ===========================
// The actual server.js implementation is inline in the PUT handler; this
// reimplements the same logic here so we can unit-test it without
// spinning up a server. If you change one, change the other.
function validateConfig(value) {
  const issues = [];
  const warnings = [];
  const MIN_RENT = 100;
  const MIN_DEPOSIT = 100;
  const MIN_UTILITY = 1;
  const rates = value.rates && typeof value.rates === 'object' ? value.rates : {};
  for (const [type, r] of Object.entries(rates)) {
    if (!r || typeof r !== 'object') continue;
    const rent = Number(r.rent);
    if (Number.isFinite(rent) && rent > 0 && rent < MIN_RENT) {
      warnings.push(`rates.${type}.rent = ${rent}`);
    }
    const dep = Number(r.deposit);
    if (Number.isFinite(dep) && dep > 0 && dep < MIN_DEPOSIT) {
      warnings.push(`rates.${type}.deposit = ${dep}`);
    }
  }
  const u = value.utilities && typeof value.utilities === 'object' ? value.utilities : {};
  for (const k of ['waterRate', 'elecRate']) {
    const v = Number(u[k]);
    if (Number.isFinite(v) && v > 0 && v < MIN_UTILITY) {
      warnings.push(`utilities.${k} = ${v}`);
    }
  }
  for (const k of ['floorPremium', 'viewPremium', 'featurePremium']) {
    const obj = value[k];
    if (!obj || typeof obj !== 'object') continue;
    for (const [name, raw] of Object.entries(obj)) {
      const n = Number(raw);
      if (Number.isFinite(n) && n < 0) warnings.push(`${k}.${name} = ${n}`);
    }
  }
  return { issues, warnings };
}

// === The actual prod typo we caught ====================================
test('warns but allows rates.standard.rent=1 (the May 2026 prod bug)', () => {
  const cfg = {
    rates: {
      suite:    { rent: 7500, deposit: 15000 },
      deluxe:   { rent: 5800, deposit: 11600 },
      studio:   { rent: 6800, deposit: 13600 },
      standard: { rent: 1,    deposit: 2 },
    },
  };
  const result = validateConfig(cfg);
  // Two warnings: rent=1 AND deposit=2 (both below thresholds), but no hard block.
  assert.deepStrictEqual(result.issues, []);
  assert.ok(result.warnings.length >= 2);
  assert.ok(result.warnings.some((i) => i.includes('standard.rent')));
  assert.ok(result.warnings.some((i) => i.includes('standard.deposit')));
});

// === Allow 0 (explicit "not configured") and warn on 1..99 ================
test('accepts rates.standard.rent=0 (means "not configured")', () => {
  const cfg = { rates: { standard: { rent: 0, deposit: 0 } } };
  assert.deepStrictEqual(validateConfig(cfg), { issues: [], warnings: [] });
});

test('warns rates.standard.rent=99 (right below threshold)', () => {
  const cfg = { rates: { standard: { rent: 99, deposit: 9000 } } };
  const result = validateConfig(cfg);
  assert.deepStrictEqual(result.issues, []);
  assert.strictEqual(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes('standard.rent'));
});

test('accepts rates.standard.rent=100 (at threshold)', () => {
  const cfg = { rates: { standard: { rent: 100, deposit: 200 } } };
  assert.deepStrictEqual(validateConfig(cfg), { issues: [], warnings: [] });
});

test('accepts normal-looking config', () => {
  const cfg = {
    rates: {
      suite:    { rent: 7500, deposit: 15000 },
      deluxe:   { rent: 5800, deposit: 11600 },
      studio:   { rent: 6800, deposit: 13600 },
      standard: { rent: 4500, deposit: 9000 },
    },
    utilities: { waterRate: 18, elecRate: 8, wifi: 250 },
    floorPremium: { 1: 0, 2: 0, 3: 400, 4: 600, 5: 900 },
    viewPremium: { 'วิวสวน': 200, 'วิวเมือง': 300 },
    featurePremium: { ac: 400, balcony: 300, kitchen: 600, parking: 500 },
  };
  assert.deepStrictEqual(validateConfig(cfg), { issues: [], warnings: [] });
});

// === Utility rates ====================================================
test('warns utilities.waterRate=0.5 (below 1)', () => {
  const cfg = { utilities: { waterRate: 0.5, elecRate: 8 } };
  const result = validateConfig(cfg);
  assert.deepStrictEqual(result.issues, []);
  assert.strictEqual(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes('waterRate'));
});

test('accepts utilities.waterRate=0 (explicit "not billing for water")', () => {
  const cfg = { utilities: { waterRate: 0, elecRate: 8 } };
  assert.deepStrictEqual(validateConfig(cfg), { issues: [], warnings: [] });
});

// === Negative premiums =================================================
test('warns negative floorPremium', () => {
  const cfg = { floorPremium: { 1: -100 } };
  const result = validateConfig(cfg);
  assert.deepStrictEqual(result.issues, []);
  assert.strictEqual(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes('floorPremium'));
});

test('accepts zero floorPremium', () => {
  const cfg = { floorPremium: { 1: 0, 2: 0, 3: 400 } };
  assert.deepStrictEqual(validateConfig(cfg), { issues: [], warnings: [] });
});

test('warns negative featurePremium', () => {
  const cfg = { featurePremium: { ac: 400, balcony: -50 } };
  const result = validateConfig(cfg);
  assert.deepStrictEqual(result.issues, []);
  assert.strictEqual(result.warnings.length, 1);
});

// === Empty / missing sections handled gracefully =======================
test('accepts empty config (admin has not configured anything)', () => {
  assert.deepStrictEqual(validateConfig({}), { issues: [], warnings: [] });
});

test('accepts config with only some sections', () => {
  const cfg = { rates: { standard: { rent: 4500 } } };
  assert.deepStrictEqual(validateConfig(cfg), { issues: [], warnings: [] });
});

test('ignores non-object rate entries', () => {
  const cfg = { rates: { standard: null, deluxe: 'wrong' } };
  assert.deepStrictEqual(validateConfig(cfg), { issues: [], warnings: [] });
});
