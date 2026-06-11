// tests/localDate.test.js
// Guards the Asia/Bangkok "what day is it" convention.
//
// The server runs with process.env.TZ = Asia/Bangkok (server.js sets it at
// boot). new Date().toISOString().slice(0, 10) is the UTC date — between
// 00:00 and 06:59 local time that is *yesterday*, which skewed move-in
// window validation, contract-expiry warnings, and tenant `since` dates.
// All call sites must go through billing.localTodayYmd() instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const billing = require('../services/billing');

test('localTodayYmd returns the LOCAL date, not the UTC date', () => {
  // 01:30 Bangkok on 2026-06-11 = 18:30 UTC on 2026-06-10. The local date
  // must win. (Node test runs inherit the ambient TZ; derive expectations
  // from the same Date instance so the assert holds in any zone.)
  const now = new Date();
  const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  assert.equal(billing.localTodayYmd(now), expected);
  assert.match(billing.localTodayYmd(), /^\d{4}-\d{2}-\d{2}$/);
});

test('localTodayYmd differs from the UTC date for an early-morning Bangkok instant', () => {
  // Fixed instant: 2026-06-11T01:30 in UTC+7 == 2026-06-10T18:30Z.
  // If this process is running in a UTC+7 zone (the production default),
  // the helper must say 2026-06-11 while toISOString says 2026-06-10.
  const instant = new Date('2026-06-10T18:30:00Z');
  const utcYmd = instant.toISOString().slice(0, 10);
  assert.equal(utcYmd, '2026-06-10');
  const local = billing.localTodayYmd(instant);
  const offsetMin = -instant.getTimezoneOffset();
  if (offsetMin >= 330) {
    // any zone at or east of UTC+5:30 has rolled to the next day by 18:30Z
    assert.equal(local, '2026-06-11');
  } else {
    assert.match(local, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('no backend "today" goes through toISOString UTC truncation', () => {
  const roots = ['server.js',
    ...fs.readdirSync(path.join(__dirname, '..', 'routes')).map((f) => path.join('routes', f)),
    ...fs.readdirSync(path.join(__dirname, '..', 'services')).map((f) => path.join('services', f)),
  ].filter((f) => f.endsWith('.js'));
  const offenders = [];
  for (const rel of roots) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const re = /new Date\(\)\s*\.\s*toISOString\(\)\s*\.\s*(?:slice|substring|substr)\(\s*0\s*,\s*10\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
      offenders.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepEqual(offenders, [],
    `UTC-today pattern found — use billing.localTodayYmd() instead: ${offenders.join(', ')}`);
});
