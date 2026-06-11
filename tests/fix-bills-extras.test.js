// tests/fix-bills-extras.test.js
// Pins the bills-extras regeneration/resubmit safety fixes:
//   - rerun must NOT wipe the scheduler-accrued late_fee (it is not drift)
//   - rerun must NOT drop one_off charges consumed by the first run
//   - due_date moved off "past due" resets the fee and downgrades a stale
//     'overdue' back to 'pending'
//   - void-then-recreate climbs a bill_no suffix instead of dead-ending
//   - drift override survives Zod stripping via the pre-validation stash
//   - reminder cooldown is an atomic claim, not check-then-act
//   - bulk-generate rolls a passed due day forward for the CURRENT period
//     only (scheduler parity)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const billsExtras = require('../routes/bills-extras');
const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'bills-extras.js'), 'utf8');

// --- regenPreservedLateFeeAndStatus (pure) ---------------------------------

test('regen preserves the accrued late fee while the bill is still past due', () => {
  const out = billsExtras._regenPreservedLateFeeAndStatus(
    { late_fee: 875, status: 'overdue' },
    '2026-05-07',
    new Date('2026-06-11T12:00:00+07:00')
  );
  assert.equal(out.lateFee, 875, 'accrued fee must survive the rerun');
  assert.equal(out.status, 'overdue');
});

test('regen resets the fee and downgrades overdue → pending when the due date moves into the future', () => {
  const out = billsExtras._regenPreservedLateFeeAndStatus(
    { late_fee: 875, status: 'overdue' },
    '2026-06-15',
    new Date('2026-06-08T12:00:00+07:00')
  );
  assert.equal(out.lateFee, 0, 'no longer late → no fee');
  assert.equal(out.status, 'pending', 'stale overdue must flip back');
});

test('regen never upgrades pending → overdue (that flip belongs to the scheduler tick)', () => {
  const out = billsExtras._regenPreservedLateFeeAndStatus(
    { late_fee: 0, status: 'pending' },
    '2026-05-07',
    new Date('2026-06-11T12:00:00+07:00')
  );
  assert.equal(out.status, 'pending');
  // a pending bill has no accrued fee to preserve
  assert.equal(out.lateFee, 0);
});

// --- matchConsumedOneOffLines (pure) ---------------------------------------

test('rerun resurrects a consumed one_off line backed by an inactive charge row', () => {
  const kept = billsExtras._matchConsumedOneOffLines(
    [{ label: 'ค่ากุญแจหาย', amount: 300 }, { label: 'ค่าส่วนกลาง', amount: 150 }],
    [],                                        // current run no longer sees the one_off
    [{ label: 'ค่ากุญแจหาย', amount: 300 }]    // inactive row proves it was consumed
  );
  assert.deepEqual(kept, [{ label: 'ค่ากุญแจหาย', amount: 300 }]);
});

test('rerun does not double a line the current run already produces', () => {
  const kept = billsExtras._matchConsumedOneOffLines(
    [{ label: 'ค่าจอดรถ', amount: 300 }],
    [{ label: 'ค่าจอดรถ', amount: 300 }],     // still active → already in this run
    [{ label: 'ค่าจอดรถ', amount: 300 }]
  );
  assert.deepEqual(kept, [], 'line already present must not be duplicated');
});

test('display-only lines with no backing one_off row are not resurrected as charges', () => {
  const kept = billsExtras._matchConsumedOneOffLines(
    [{ label: 'ค่าส่วนกลาง', amount: 150 }],
    [],
    []
  );
  assert.deepEqual(kept, []);
});

test('stored JSON-string `other` is parsed before matching', () => {
  const kept = billsExtras._matchConsumedOneOffLines(
    JSON.stringify([{ label: 'ค่าทำความสะอาด', amount: 500 }]),
    [],
    [{ label: 'ค่าทำความสะอาด', amount: '500' }]
  );
  assert.deepEqual(kept, [{ label: 'ค่าทำความสะอาด', amount: 500 }]);
});

// --- source pins (wiring that fake-pool tests can't reach) -----------------

test('POST upsert preserves bills.late_fee instead of EXCLUDED.late_fee', () => {
  assert.match(src, /late_fee=CASE WHEN EXCLUDED\.due_date < CURRENT_DATE\s*THEN bills\.late_fee ELSE 0 END/,
    'DO UPDATE must keep the scheduler-accrued fee while past due');
  assert.match(src, /status=CASE WHEN bills\.status='overdue' AND EXCLUDED\.due_date >= CURRENT_DATE\s*THEN 'pending' ELSE bills\.status END/,
    'DO UPDATE must downgrade a stale overdue when the due date moves forward');
  assert.ok(!/late_fee=EXCLUDED\.late_fee/.test(src),
    'the old fee-wiping assignment must be gone');
});

test('drift override is stashed before Zod strips it', () => {
  assert.match(src, /req\.billDriftOverride = \{/,
    'pre-validation middleware must stash manualOverride/overrideReason');
  assert.match(src, /req\.billDriftOverride\?\.manualOverride !== true/,
    'drift gate must read the stash, not the stripped body');
});

test('void-then-recreate climbs a bill_no suffix instead of BILL_LOCKED_FOR_LEDGER', () => {
  assert.match(src, /current\.status === 'void' \|\| current\.deleted_at != null/,
    'single-bill path must detect a void/deleted blocker');
  assert.match(src, /blocking\.status === 'void' \|\| blocking\.deleted_at != null/,
    'bulk path must detect a void/deleted blocker');
  assert.match(src, /billing\.makeBillNo\(bill\.roomId, period, \{ attempt \}\)/,
    'bulk retry must disambiguate via the attempt suffix');
});

test('reminder cooldown is an atomic conditional UPDATE claimed before enqueueing', () => {
  const claim = src.match(/UPDATE bills\s*SET last_reminded_at=NOW\(\),\s*reminder_count = COALESCE\(reminder_count, 0\) \+ 1\s*WHERE id=\$1\s*AND \(\$2::boolean[\s\S]{0,220}RETURNING last_reminded_at/);
  assert.ok(claim, 'conditional claim with force bypass + RETURNING must exist');
  const claimIdx = src.indexOf('RETURNING last_reminded_at');
  const enqueueIdx = src.indexOf("enqueued.push({ channel: 'line'");
  assert.ok(claimIdx > 0 && enqueueIdx > claimIdx,
    'claim must run BEFORE the first enqueue, not after');
});

test('compute path only stores admin-passed recurring lines when the flag is on', () => {
  assert.match(src, /flags\.recurringCharges\?\.enabled && Array\.isArray\(b\.recurring\)\s*\? b\.recurring : \[\]/,
    'recurringList copy must mirror buildBill\'s feature gate');
});

test('bulk-generate rolls the due date forward only for the current period (scheduler parity)', () => {
  assert.match(src, /period === billing\.formatPeriodNow\(\)\s*\? billGenDueDateFor\(new Date\(\), due\)\s*: billing\.formatYMD\(periodYear, periodMonth, due\.day\)/,
    'current period rolls via billGenDueDateFor; back-filled periods keep the in-period date');
});

test('unmark-paid subtracts the carry already frozen in next period\'s bill', () => {
  assert.match(src, /findConsumedCarriedLateFees\(client, id\)/,
    'unmark-paid/void must look up consumed carries');
  assert.match(src, /consumedCarriedLateFee,\s*\}\);/,
    'restored amounts must receive the consumed carry to subtract');
});
