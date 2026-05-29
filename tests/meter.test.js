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

test('attachBillingReadingsForPeriod uses the selected billing month', async () => {
  const pool = {
    async query(sql, params) {
      assert.match(params[2] ? String(params[2]) : '', /^2026-05$|^$/);
      const type = params[1];
      const isPrev = /period IS NOT NULL AND period < \$3/.test(sql);
      if (type === 'water' && !isPrev) return { rows: [{ meter_type: 'water', reading: 135.5, period: '2026-05' }] };
      if (type === 'water' && isPrev) return { rows: [{ meter_type: 'water', reading: 120, period: '2026-04' }] };
      if (type === 'elec' && !isPrev) return { rows: [{ meter_type: 'elec', reading: 1625, period: '2026-05' }] };
      if (type === 'elec' && isPrev) return { rows: [{ meter_type: 'elec', reading: 1500, period: '2026-04' }] };
      return { rows: [] };
    },
  };
  const out = await meter.attachBillingReadingsForPeriod(pool, {
    id: '201',
    waterUnits: 999,
    elecUnits: 999,
  }, '2026-05');
  assert.equal(out.waterPrevReading, 120);
  assert.equal(out.waterCurrentReading, 135.5);
  assert.equal(out.waterUnits, 15.5);
  assert.equal(out.elecPrevReading, 1500);
  assert.equal(out.elecCurrentReading, 1625);
  assert.equal(out.elecUnits, 125);
});

test('record period reading upserts by month and does not mutate room units', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push(sql);
      if (/SELECT \* FROM meter_readings/.test(sql)) {
        return { rows: [{ reading: 1500, period: '2026-04' }] };
      }
      if (/INSERT INTO meter_readings/.test(sql)) {
        assert.match(sql, /period, reading_at/);
        assert.match(sql, /ON CONFLICT \(room_id, meter_type, period\)/);
        assert.equal(params[5], '2026-05');
        return { rows: [{ id: 1, room_id: '201', meter_type: 'elec', reading: 1625, period: '2026-05' }] };
      }
      throw new Error('unexpected query: ' + sql);
    },
  };
  const out = await meter.record(pool, {
    roomId: '201',
    meterType: 'elec',
    reading: 1625,
    period: '2026-05',
    createdBy: 'admin',
  });
  assert.equal(out.delta, 125);
  assert.equal(calls.some((sql) => /UPDATE app_data/.test(sql)), false,
    'period-scoped meter entry must not overwrite room-level monthly units');
});

// --- detectAnomaly — previously untested; also pins the sample-variance fix ---
// Mock pool returns readings in DESC order (as the SQL ORDER BY reading_at DESC
// would); detectAnomaly reverses them to oldest→newest internally.
function poolFromReadings(oldestToNewest) {
  const rowsDesc = oldestToNewest
    .map((reading, i) => ({ reading, reading_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` }))
    .reverse();
  return { async query() { return { rows: rowsDesc }; } };
}

test('detectAnomaly: too few readings → null', async () => {
  assert.equal(await meter.detectAnomaly(poolFromReadings([100]), '201', 'elec', 3), null);
});

test('detectAnomaly: meter rollback (negative delta) flagged regardless of history', async () => {
  const a = await meter.detectAnomaly(poolFromReadings([100, 110, 120, 130, 140, 135]), '201', 'elec', 3);
  assert.ok(a && a.kind === 'rollback', 'a reading lower than the previous one is a rollback');
  assert.ok(a.last < 0);
});

test('detectAnomaly: steady consumption → no anomaly', async () => {
  const a = await meter.detectAnomaly(poolFromReadings([100, 110, 120, 130, 140, 150]), '201', 'elec', 3);
  assert.equal(a, null);
});

test('detectAnomaly: zero-variance baseline then a jump → zero-variance anomaly', async () => {
  const a = await meter.detectAnomaly(poolFromReadings([100, 110, 120, 130, 140, 200]), '201', 'elec', 3);
  assert.ok(a && a.kind === 'zero-variance', 'flat baseline broken by a jump');
});

test('detectAnomaly: clear outlier on a varied baseline → sigma anomaly', async () => {
  // prior deltas 10,12,8,11,9 (mean 10), then a +100 jump
  const a = await meter.detectAnomaly(poolFromReadings([100, 110, 122, 130, 141, 150, 250]), '201', 'elec', 3);
  assert.ok(a && a.kind === 'sigma', 'a large outlier should trip the n-σ test');
  assert.ok(Math.abs(a.z) >= 3);
});

test('detectAnomaly: young meter (<5 readings) uses 5x heuristic', async () => {
  assert.ok((await meter.detectAnomaly(poolFromReadings([100, 110, 600]), '201', 'elec', 3))?.kind === 'jump');
  assert.equal(await meter.detectAnomaly(poolFromReadings([100, 110, 120]), '201', 'elec', 3), null);
});

test('detectAnomaly: sample variance — borderline case must NOT false-positive', async () => {
  // prior deltas 8,10,12,10 (mean 10); last delta 14.5.
  //   population σ (÷n=4)  → 1.414 → z=3.18  → would FALSE-flag (the old bug)
  //   sample σ     (÷n-1=3) → 1.633 → z=2.76 → correctly NOT flagged
  const a = await meter.detectAnomaly(poolFromReadings([0, 8, 18, 30, 40, 54.5]), '201', 'elec', 3);
  assert.equal(a, null, 'sample variance must not flag a borderline 2.76σ delta at 3σ');
});
