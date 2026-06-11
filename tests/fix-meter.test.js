// tests/fix-meter.test.js
// Regression: latestBeforePeriod must rank previous-reading candidates by
// observation time, not period-first. The old ORDER BY
// COALESCE(period, '0000-00') DESC let a stale period-scoped baseline (e.g. a
// check-in reading) permanently outrank every newer UNSCOPED reading, so the
// billing baseline froze and already-billed consumption was re-billed each
// month.
//   node --test tests/fix-meter.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const meter = require('../services/meter');

// --- mini evaluator -------------------------------------------------------
// Instead of returning canned rows (which would not exercise the ordering at
// all), the fake pool applies the query's actual WHERE/ORDER BY semantics to
// an in-memory fixture, faithfully to Postgres. Only the expressions these
// two queries have ever used are supported; anything else throws so a future
// SQL change can't silently pass.

function splitTopLevel(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function orderKeyFns(orderByClause, params) {
  return splitTopLevel(orderByClause).map((term) => {
    const desc = /\sDESC$/i.test(term);
    const expr = term.replace(/\s+(ASC|DESC)$/i, '').trim();
    let fn;
    if (expr === 'reading_at') fn = (r) => Date.parse(r.reading_at);
    else if (expr === '(period IS NOT NULL)') fn = (r) => (r.period != null ? 1 : 0);
    else if (expr === "COALESCE(period, '0000-00')") fn = (r) => (r.period != null ? r.period : '0000-00');
    else if (expr === '(period=$3)') fn = (r) => (r.period === params[2] ? 1 : 0);
    else throw new Error('unsupported ORDER BY expr in test evaluator: ' + expr);
    return { fn, desc };
  });
}

function sortRows(rows, orderByClause, params) {
  const keys = orderKeyFns(orderByClause, params);
  return [...rows].sort((a, b) => {
    for (const { fn, desc } of keys) {
      const av = fn(a);
      const bv = fn(b);
      if (av < bv) return desc ? 1 : -1;
      if (av > bv) return desc ? -1 : 1;
    }
    return 0;
  });
}

function fakePool(allRows) {
  return {
    async query(sql, params) {
      const rows = allRows.filter((r) => r.room_id === params[0] && r.meter_type === params[1]);
      let filtered;
      if (/period IS NOT NULL AND period < \$3/.test(sql)) {
        // latestBeforePeriod: scoped rows from earlier periods, unscoped rows
        // before the period's Bangkok start instant.
        filtered = rows.filter((r) => (r.period != null && r.period < params[2])
          || (r.period == null && Date.parse(r.reading_at) < Date.parse(params[3])));
      } else if (/period=\$3/.test(sql)) {
        // readingPairForPeriod current: the period's scoped row, or unscoped
        // rows inside the period window.
        filtered = rows.filter((r) => r.period === params[2]
          || (r.period == null
              && Date.parse(r.reading_at) >= Date.parse(params[3])
              && Date.parse(r.reading_at) < Date.parse(params[4])));
      } else {
        throw new Error('unexpected query: ' + sql);
      }
      const m = /ORDER BY\s+([\s\S]*?)\s+LIMIT/i.exec(sql);
      assert.ok(m, 'period lookup queries must ORDER BY ... LIMIT');
      const sorted = sortRows(filtered, m[1], params);
      return { rows: sorted.slice(0, /LIMIT 1/.test(sql) ? 1 : sorted.length) };
    },
  };
}

// Mixed scoped/unscoped fixture from the audit's worked example: check-in
// records a scoped June baseline (record() stamps scoped rows at the last ms
// of their period, Asia/Bangkok), then the IoT simulator records UNSCOPED
// readings each month.
const mixedRows = [
  { room_id: '201', meter_type: 'elec', period: '2026-06', reading: 1500, reading_at: '2026-06-30T16:59:59.999Z' },
  { room_id: '201', meter_type: 'elec', period: null, reading: 1560, reading_at: '2026-06-30T10:00:00.000Z' },
  { room_id: '201', meter_type: 'elec', period: null, reading: 1640, reading_at: '2026-07-31T10:00:00.000Z' },
  { room_id: '201', meter_type: 'elec', period: null, reading: 1700, reading_at: '2026-08-31T10:00:00.000Z' },
];

test('latestBeforePeriod: newer unscoped reading beats older scoped baseline', async () => {
  const prev = await meter.latestBeforePeriod(fakePool(mixedRows), '201', 'elec', '2026-08');
  assert.ok(prev, 'a previous reading exists');
  assert.equal(Number(prev.reading), 1640,
    'August baseline must be the July 31 unscoped reading, not the frozen June check-in baseline');
});

test('latestBeforePeriod: scoped month-end row still wins over earlier same-month unscoped rows', async () => {
  // For July's bill the June scoped baseline (stamped at the very end of
  // June) must outrank the simulator's June 30 daytime reading — scoped rows
  // are the source of truth for their month.
  const prev = await meter.latestBeforePeriod(fakePool(mixedRows), '201', 'elec', '2026-07');
  assert.equal(Number(prev.reading), 1500);
});

test('latestBeforePeriod: same-instant tie prefers the scoped row', async () => {
  const rows = [
    { room_id: '201', meter_type: 'elec', period: '2026-07', reading: 1640, reading_at: '2026-07-31T16:59:59.999Z' },
    { room_id: '201', meter_type: 'elec', period: null, reading: 1639, reading_at: '2026-07-31T16:59:59.999Z' },
  ];
  const prev = await meter.latestBeforePeriod(fakePool(rows), '201', 'elec', '2026-08');
  assert.equal(prev.period, '2026-07');
  assert.equal(Number(prev.reading), 1640);
});

test('latestBeforePeriod: pure scoped history still resolves the immediately previous month', async () => {
  const rows = [
    { room_id: '201', meter_type: 'elec', period: '2026-06', reading: 1500, reading_at: '2026-06-30T16:59:59.999Z' },
    { room_id: '201', meter_type: 'elec', period: '2026-07', reading: 1640, reading_at: '2026-07-31T16:59:59.999Z' },
  ];
  const prev = await meter.latestBeforePeriod(fakePool(rows), '201', 'elec', '2026-08');
  assert.equal(prev.period, '2026-07');
});

test('attachBillingReadingsForPeriod: baseline advances month over month (no cumulative re-bill)', async () => {
  const pool = fakePool(mixedRows);
  const july = await meter.attachBillingReadingsForPeriod(pool, { id: '201' }, '2026-07');
  assert.equal(july.elecPrevReading, 1500);
  assert.equal(july.elecCurrentReading, 1640);
  assert.equal(july.elecUnits, 140);

  const august = await meter.attachBillingReadingsForPeriod(pool, { id: '201' }, '2026-08');
  assert.equal(august.elecPrevReading, 1640,
    'August must start where July ended');
  assert.equal(august.elecCurrentReading, 1700);
  assert.equal(august.elecUnits, 60,
    'old ordering re-billed July consumption: 200 units instead of 60');
});

test('evaluator sanity: the old period-first ORDER BY reproduces the bug on this fixture', () => {
  // Proves the fixture/evaluator are sensitive to the fix — under the old
  // clause the stale scoped baseline (1500) would win for August.
  const candidates = mixedRows.filter((r) => (r.period != null && r.period < '2026-08')
    || (r.period == null && Date.parse(r.reading_at) < Date.parse('2026-07-31T17:00:00.000Z')));
  const old = sortRows(candidates, "COALESCE(period, '0000-00') DESC, reading_at DESC", []);
  assert.equal(Number(old[0].reading), 1500);
});

test('wiring: latestBeforePeriod orders by observation time, not period-first', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'meter.js'), 'utf8');
  assert.doesNotMatch(src, /COALESCE\(period, '0000-00'\)/,
    'period-first ordering freezes the billing baseline behind any scoped row');
  assert.match(src, /ORDER BY reading_at DESC, \(period IS NOT NULL\) DESC/,
    'previous-reading lookup must rank by reading_at with scoped rows winning ties');
});
