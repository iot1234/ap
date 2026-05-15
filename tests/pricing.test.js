// tests/pricing.test.js
// Covers the resolver priority and the formula derivation.

const { test } = require('node:test');
const assert = require('node:assert');
const pricing = require('../services/pricing');

// === computeFromFormula ===================================================

test('formula: defaults to type baseRent when config has no rates', () => {
  const r = pricing.computeFromFormula({ type: 'deluxe', floor: 1, view: 'none' }, {});
  assert.strictEqual(r, 5800);    // deluxe default
});

test('formula: uses config.rates over hardcoded default', () => {
  const cfg = { rates: { deluxe: { rent: 6500 } } };
  const r = pricing.computeFromFormula({ type: 'deluxe', floor: 1 }, cfg);
  assert.strictEqual(r, 6500);
});

test('formula: stacks floorPremium + viewPremium + featurePremium', () => {
  const cfg = {
    rates: { deluxe: { rent: 6000 } },
    floorPremium: { 4: 200 },
    viewPremium:  { pool: 300 },
    featurePremium: { balcony: 500, ac: 200, parking: 100, kitchen: 0 },
  };
  const room = {
    type: 'deluxe', floor: 4, view: 'pool',
    balcony: true, ac: true, parking: true, kitchen: false,
  };
  assert.strictEqual(pricing.computeFromFormula(room, cfg), 6000 + 200 + 300 + 500 + 200 + 100);
});

test('formula: room type default AC applies when room has no explicit ac field', () => {
  const cfg = { rates: { deluxe: { rent: 6000 } }, featurePremium: { ac: 200 } };
  assert.strictEqual(pricing.computeFromFormula({ type: 'deluxe', floor: 1 }, cfg), 6200);
  assert.strictEqual(pricing.computeFromFormula({ type: 'deluxe', floor: 1, has_ac: false }, cfg), 6000);
});

test('formula: accepts both blob-shape (balcony) and rooms_v2-shape (has_balcony)', () => {
  const cfg = { rates: { deluxe: { rent: 6000 } }, featurePremium: { balcony: 500 } };
  const blob = { type: 'deluxe', floor: 1, balcony: true };
  const v2   = { room_type: 'deluxe', floor: 1, has_balcony: true };
  assert.strictEqual(pricing.computeFromFormula(blob, cfg), 6500);
  assert.strictEqual(pricing.computeFromFormula(v2, cfg),   6500);
});

test('formula: unknown room type → falls back to standard default', () => {
  const r = pricing.computeFromFormula({ type: 'penthouse', floor: 1 }, {});
  assert.strictEqual(r, 4500);    // standard default (no penthouse entry)
});

test('formula: rounds to 2 decimals', () => {
  const cfg = { rates: { standard: { rent: 4500.123 } } };
  const r = pricing.computeFromFormula({ type: 'standard', floor: 1 }, cfg);
  assert.strictEqual(r, 4500.12);
});

// === resolveBillingRent priority ===========================================

test('resolver: contract wins over override + formula', () => {
  const out = pricing.resolveBillingRent({
    room:     { type: 'deluxe', floor: 1, rent_override: 9999 },
    contract: { id: 42, status: 'active', monthly_rent: 6175 },
    config:   { rates: { deluxe: { rent: 6500 } } },
  });
  assert.strictEqual(out.rent, 6175);
  assert.strictEqual(out.source, 'contract');
  assert.strictEqual(out.contractId, 42);
});

test('resolver: inactive contract is ignored', () => {
  const out = pricing.resolveBillingRent({
    room:     { type: 'deluxe', floor: 1 },
    contract: { id: 42, status: 'ended', monthly_rent: 6175 },
    config:   { rates: { deluxe: { rent: 6500 } } },
  });
  assert.strictEqual(out.source, 'formula');
  assert.strictEqual(out.rent, 6500);
});

test('resolver: contract with monthly_rent=0 falls through to next source', () => {
  // Edge: contract row exists but rent is null/0 (data corruption or
  // legacy contract pre-monthly_rent column). Don't bill ฿0 — fall through.
  const out = pricing.resolveBillingRent({
    room:     { type: 'deluxe', floor: 1 },
    contract: { id: 1, status: 'active', monthly_rent: 0 },
    config:   { rates: { deluxe: { rent: 6500 } } },
  });
  assert.strictEqual(out.source, 'formula');
  assert.strictEqual(out.rent, 6500);
});

test('resolver: override wins over formula (no contract)', () => {
  const out = pricing.resolveBillingRent({
    room:   { type: 'deluxe', floor: 1, rent_override: 5500, rent_override_reason: 'damaged' },
    config: { rates: { deluxe: { rent: 6500 } } },
  });
  assert.strictEqual(out.rent, 5500);
  assert.strictEqual(out.source, 'override');
  assert.strictEqual(out.reason, 'damaged');
});

test('resolver: blob-shape override (rentOverride camelCase) works too', () => {
  const out = pricing.resolveBillingRent({
    room:   { type: 'deluxe', floor: 1, rentOverride: 5500, rentOverrideReason: 'promo' },
    config: { rates: { deluxe: { rent: 6500 } } },
  });
  assert.strictEqual(out.rent, 5500);
  assert.strictEqual(out.source, 'override');
  assert.strictEqual(out.reason, 'promo');
});

test('resolver: override=0 is ignored (use formula)', () => {
  const out = pricing.resolveBillingRent({
    room:   { type: 'deluxe', floor: 1, rent_override: 0 },
    config: { rates: { deluxe: { rent: 6500 } } },
  });
  assert.strictEqual(out.source, 'formula');
});

test('resolver: raw rooms_v2 row shape uses room_type + rent_price fallback', () => {
  const withConfig = pricing.resolveBillingRent({
    room: {
      room_code: '305',
      room_type: 'studio',
      floor: 3,
      rent_price: '6800.00',
      has_ac: true,
    },
    config: { rates: { studio: { rent: 7000 } }, floorPremium: { 3: 200 }, featurePremium: { ac: 300 } },
  });
  assert.strictEqual(withConfig.source, 'formula');
  assert.strictEqual(withConfig.rent, 7500);

  const withoutConfig = pricing.resolveBillingRent({
    room: { room_code: '305', room_type: 'studio', floor: 3, rent_price: '6800.00' },
    config: { rates: {} },
  });
  assert.strictEqual(withoutConfig.source, 'legacy');
  assert.strictEqual(withoutConfig.rent, 6800);
});

test('resolver: formula when no contract + no override', () => {
  const out = pricing.resolveBillingRent({
    room:   { type: 'deluxe', floor: 4, balcony: true },
    config: {
      rates: { deluxe: { rent: 6000 } },
      floorPremium: { 4: 200 },
      featurePremium: { balcony: 500 },
    },
  });
  assert.strictEqual(out.rent, 6700);
  assert.strictEqual(out.source, 'formula');
});

test('resolver: legacy fallback when formula returns 0 AND room.rent is set', () => {
  // To hit this branch we need config to actively override the type
  // default to 0 (admin explicitly entered 0) AND no premiums apply.
  const out = pricing.resolveBillingRent({
    room:   { type: 'standard', rent: 5000, floor: 1 },
    config: { rates: { standard: { rent: 0 } } },
  });
  assert.strictEqual(out.source, 'legacy');
  assert.strictEqual(out.rent, 5000);
});

test('resolver: hardcoded type default acts as safety net (never bills ฿0)', () => {
  // No config at all (fresh deploy before admin touched /admin#pricing),
  // no room.rent. Formula still gives a sensible number from the hardcoded
  // type defaults — prevents accidental ฿0 bills on day 1.
  const out = pricing.resolveBillingRent({
    room:   { type: 'standard', floor: 1 },
    config: {},
  });
  assert.strictEqual(out.source, 'formula');
  assert.strictEqual(out.rent, 4500);     // standard default
});

test('resolver: nothing usable anywhere → returns 0 (signals caller to skip)', () => {
  // Pathological: no room type, config explicitly zeros standard, no
  // legacy rent. Resolver returns 0 + legacy so the caller can decide
  // ("skip this room" vs "bill ฿0").
  const out = pricing.resolveBillingRent({
    room:   {},
    config: { rates: { standard: { rent: 0 } } },
  });
  assert.strictEqual(out.rent, 0);
  assert.strictEqual(out.source, 'legacy');
});

// === previewImpact ========================================================

test('previewImpact: lists rooms whose formula rent changes', () => {
  const rooms = [
    { id: '101', type: 'deluxe', floor: 1 },
    { id: '102', type: 'deluxe', floor: 2 },
    { id: '201', type: 'standard', floor: 2 },
  ];
  const oldCfg = { rates: { deluxe: { rent: 5800 }, standard: { rent: 4500 } } };
  const newCfg = { rates: { deluxe: { rent: 6500 }, standard: { rent: 4500 } } };
  const impact = pricing.previewImpact(rooms, oldCfg, newCfg);
  assert.strictEqual(impact.unchanged, 1);            // standard unchanged
  assert.strictEqual(impact.willChange.length, 2);     // 2 deluxe rooms
  assert.strictEqual(impact.willChange[0].oldRent, 5800);
  assert.strictEqual(impact.willChange[0].newRent, 6500);
});

test('previewImpact: handles object-shape rooms blob too', () => {
  const rooms = {
    101: { id: '101', type: 'deluxe', floor: 1 },
    102: { id: '102', type: 'standard', floor: 1 },
  };
  const oldCfg = { rates: { deluxe: { rent: 5800 }, standard: { rent: 4500 } } };
  const newCfg = { rates: { deluxe: { rent: 5800 }, standard: { rent: 5000 } } };
  const impact = pricing.previewImpact(rooms, oldCfg, newCfg);
  assert.strictEqual(impact.unchanged, 1);
  assert.strictEqual(impact.willChange.length, 1);
  assert.strictEqual(impact.willChange[0].roomId, '102');
});

test('previewImpact: per-room override is not reported as formula impact', () => {
  const rooms = [
    { id: '101', type: 'deluxe', floor: 1, rentOverride: 5500 },
    { id: '102', type: 'deluxe', floor: 1 },
  ];
  const oldCfg = { rates: { deluxe: { rent: 5800 } } };
  const newCfg = { rates: { deluxe: { rent: 6500 } } };
  const impact = pricing.previewImpact(rooms, oldCfg, newCfg);
  assert.strictEqual(impact.unchanged, 1);
  assert.deepStrictEqual(impact.willChange.map((x) => x.roomId), ['102']);
});
