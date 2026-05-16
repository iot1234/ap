// tests/meter.test.js
// consumption() is pure-function — easily testable without DB.
//   node --test tests/meter.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const meter = require('../services/meter');

test('consumption: positive delta', () => {
  assert.equal(meter.consumption({ reading: 100 }, { reading: 150 }), 50);
});

test('consumption: zero or negative returns 0 (no rollover handling)', () => {
  assert.equal(meter.consumption({ reading: 200 }, { reading: 100 }), 0);
  assert.equal(meter.consumption({ reading: 100 }, { reading: 100 }), 0);
});

test('consumption: missing arg returns 0', () => {
  assert.equal(meter.consumption(null, { reading: 100 }), 0);
  assert.equal(meter.consumption({ reading: 100 }, null), 0);
});

test('ALLOWED_TYPES exports', () => {
  assert.ok(meter.ALLOWED_TYPES.has('water'));
  assert.ok(meter.ALLOWED_TYPES.has('elec'));
  assert.ok(!meter.ALLOWED_TYPES.has('gas'));
});

test('attachLatestBillingReadings adds before/after readings and computed units', async () => {
  const pool = {
    async query(sql, params) {
      assert.match(sql, /ROW_NUMBER\(\) OVER \(PARTITION BY meter_type ORDER BY reading_at DESC\)/);
      assert.deepEqual(params, ['201']);
      return {
        rows: [
          { meter_type: 'elec', reading: 1625, reading_at: '2026-05-16T02:00:00Z' },
          { meter_type: 'elec', reading: 1500, reading_at: '2026-04-16T02:00:00Z' },
          { meter_type: 'water', reading: 135.5, reading_at: '2026-05-16T02:00:00Z' },
          { meter_type: 'water', reading: 120, reading_at: '2026-04-16T02:00:00Z' },
        ],
      };
    },
  };
  const out = await meter.attachLatestBillingReadings(pool, {
    id: '201',
    waterUnits: 1,
    elecUnits: 1,
  });
  assert.equal(out.waterPrevReading, 120);
  assert.equal(out.waterCurrentReading, 135.5);
  assert.equal(out.waterUnits, 15.5);
  assert.equal(out.elecPrevReading, 1500);
  assert.equal(out.elecCurrentReading, 1625);
  assert.equal(out.elecUnits, 125);
});
