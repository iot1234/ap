// tests/fix-scheduler.test.js
//   node --test tests/fix-scheduler.test.js
// Pins the scheduler fixes:
//   1. tickLateFee only suppresses the per-bill "บิลเลยกำหนด" tenant alert
//      for tenants whose card is still ACTIVE (i.e. access-sync will message
//      them today) — tenants whose cards were revoked on a previous day (or
//      who own no card) still get the alert instead of total silence.
//   2. Auto-generated bills can't be born overdue: a resolved due day that
//      already passed this month rolls to the same day NEXT month.
//   3. _withAdvisoryLock dbLatch — once-per-key marker shared via app_data
//      so staggered multi-replica deploys can't double-send daily digests
//      (the advisory lock is a mutex, not a memory).
//   4. Late-fee phases gate on the flag only — contract-locked rates apply
//      even when the global ratePctPerMonth is 0.
//   5. Bill-gen tenant notify fan-out survives a per-bill lookup failure
//      instead of dropping every remaining tenant's push.
//   6. autoBackup.hourUtc=0 (midnight UTC) is honored — `??`, not `||`.
//   7. payment-reminder is chained after bill-gen settles, matching the
//      comment that promised that ordering.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Keep the scheduler's state-file writes out of the repo: point it at a temp
// path BEFORE the module computes its candidate list at require time.
process.env.SCHEDULER_STATE_FILE = path.join(
  os.tmpdir(), `fix-scheduler-test-state-${process.pid}.json`);
// scripts/backup.js exits the process at require time without DATABASE_URL;
// give it a dummy one (same trick as tests/backup.test.js) so the autoBackup
// test below can patch backup.run before the scheduler lazy-requires it.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake/fake';

const scheduler = require('../services/scheduler');
const notifier = require('../services/notifier');
const backup = require('../scripts/backup');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');

// === harness ================================================================

// Fake pg pool: `route(sql, params)` returns a result for SQL it recognizes;
// everything else (BEGIN/COMMIT, audit inserts, roomStatus cascade queries)
// resolves to an empty result. connect() hands back the same dispatcher so
// transactional code paths work too.
function makePool(route) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    return route(sql, params) || { rows: [], rowCount: 0 };
  };
  return { query, connect: async () => ({ query, release: () => {} }), calls };
}

// notifier is a shared module object — the scheduler holds the same
// reference, so swapping notifyTenant here intercepts its calls.
async function withNotifyTenantCapture(fn) {
  const calls = [];
  const orig = notifier.notifyTenant;
  notifier.notifyTenant = async (_ctx, tenant, msg) => {
    calls.push({ tenant, msg });
    return { ok: true };
  };
  try { await fn(calls); }
  finally { notifier.notifyTenant = orig; }
}

const flippedBillRow = (over = {}) => ({
  id: 11, room_id: 'B2', tenant_id: 9, total: '4500', late_fee: '0',
  subtotal: '4500', vat: '0', due_date: '2026-06-15', bill_no: 'INV-2026-06-B2',
  period: '2026-06', full_name: 'สมหญิง', phone: null, email: null,
  line_user_id: null, line_oa_id: null, tenant_status: 'active',
  deleted_at: null, contract_late_fee_rate: null, pending_slip_count: 0,
  ...over,
});

// === 1. Overdue alert vs access-sync dedupe ================================

test('tickLateFee: tenant with NO active card still gets the freshly-overdue alert', async () => {
  // Emulate the DB: tenant 9 has an old >= threshold overdue bill but ZERO
  // active access cards (revoked on a previous day). The fixed dedupe query
  // (EXISTS active card) returns no rows; the old query returned the tenant
  // and suppressed the alert even though access-sync would message nobody.
  let dedupeSql = null;
  const pool = makePool((sql) => {
    if (/WITH bumped AS/.test(sql)) return { rows: [flippedBillRow()], rowCount: 1 };
    if (/SELECT DISTINCT tenant_id FROM bills/.test(sql)) {
      dedupeSql = sql;
      return /access_cards/.test(sql)
        ? { rows: [] }                      // no active card -> no row
        : { rows: [{ tenant_id: 9 }] };     // buggy shape would suppress
    }
    return null;
  });
  const flags = { accessControl: { enabled: true, requirePaymentForCard: true, overdueDaysThreshold: 30 } };
  await withNotifyTenantCapture(async (calls) => {
    await scheduler.tickLateFee(pool, flags, new Date(2026, 5, 16), {});
    assert.ok(dedupeSql, 'dedupe query must run when access control is on');
    assert.match(dedupeSql, /EXISTS[\s\S]*access_cards[\s\S]*status = 'active'/,
      'dedupe must be restricted to tenants whose card will actually transition today');
    assert.equal(calls.length, 1, 'per-bill overdue alert must be sent');
    assert.equal(calls[0].tenant.id, 9);
    assert.match(calls[0].msg.subject, /เลยกำหนดชำระ/);
  });
});

test('tickLateFee: tenant WITH an active card is deduped (access-sync covers them)', async () => {
  const pool = makePool((sql) => {
    if (/WITH bumped AS/.test(sql)) return { rows: [flippedBillRow()], rowCount: 1 };
    if (/SELECT DISTINCT tenant_id FROM bills/.test(sql)) {
      // Active card exists -> the fixed query DOES return the tenant.
      return { rows: [{ tenant_id: 9 }] };
    }
    return null;
  });
  const flags = { accessControl: { enabled: true, requirePaymentForCard: true, overdueDaysThreshold: 30 } };
  await withNotifyTenantCapture(async (calls) => {
    await scheduler.tickLateFee(pool, flags, new Date(2026, 5, 16), {});
    assert.equal(calls.length, 0,
      'tenant getting the comprehensive card-suspended message must not be double-pinged');
  });
});

// === 2. Bill-gen due date roll-forward ======================================

test('billGenDueDateFor: due day already past this month rolls to next month', () => {
  // dayOfMonth=20, signed dueDay=1 -> the 1st of NEXT month, not 19 days ago.
  assert.equal(scheduler.billGenDueDateFor(new Date(2026, 5, 20), { day: 1 }), '2026-07-01');
  // Year rollover: generated Dec 20, due day 5 -> Jan 5 next year.
  assert.equal(scheduler.billGenDueDateFor(new Date(2026, 11, 20), { day: 5 }), '2027-01-05');
});

test('billGenDueDateFor: same-day and future due days stay in this month', () => {
  // Due today is a valid window (dueOnDay == bill-gen day).
  assert.equal(scheduler.billGenDueDateFor(new Date(2026, 5, 20), { day: 20 }), '2026-06-20');
  assert.equal(scheduler.billGenDueDateFor(new Date(2026, 5, 1), { day: 15 }), '2026-06-15');
});

test('tickBillGen uses the roll-forward helper for the per-room due date', () => {
  assert.match(SRC, /const dueDate = billGenDueDateFor\(now, due\);/,
    'scheduler bill-gen must build due dates through the roll-forward helper');
});

// === 3. Cross-replica db latch ==============================================

function makeLatchPool() {
  const latchRows = new Set();
  const client = {
    query: async (sql, params) => {
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ got: true }] };
      if (/pg_advisory_unlock/.test(sql)) return { rows: [] };
      if (/SELECT 1 FROM app_data WHERE key=\$1/.test(sql)) {
        return { rows: latchRows.has(params[0]) ? [{ ok: 1 }] : [] };
      }
      if (/INSERT INTO app_data/.test(sql)) {
        latchRows.add(params[0]);
        return { rowCount: 1, rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  return { pool: { connect: async () => client }, latchRows };
}

test('_withAdvisoryLock dbLatch: second run of the same key skips (replica-safe)', async () => {
  const { pool, latchRows } = makeLatchPool();
  let runs = 0;
  const r1 = await scheduler._withAdvisoryLock(pool, 'overdueDigest-2026-06-11',
    async () => { runs++; return { sent: 1 }; }, { dbLatch: true });
  assert.equal(runs, 1);
  assert.equal(r1.sent, 1);
  assert.ok(latchRows.has('sched_done:overdueDigest-2026-06-11'),
    'successful run must persist the shared latch');
  // Same key from "another replica" (lock free, fresh state file) — must skip.
  const r2 = await scheduler._withAdvisoryLock(pool, 'overdueDigest-2026-06-11',
    async () => { runs++; }, { dbLatch: true });
  assert.equal(runs, 1, 'latched key must not re-run the job');
  assert.equal(r2.skipped, true);
  assert.equal(r2.reason, 'db-latch');
});

test('_withAdvisoryLock dbLatch: failed run is NOT latched — retried next tick', async () => {
  const { pool, latchRows } = makeLatchPool();
  let runs = 0;
  await scheduler._withAdvisoryLock(pool, 'contractExpiry-2026-06-11',
    async () => { runs++; return { error: 'db down' }; }, { dbLatch: true });
  assert.equal(latchRows.has('sched_done:contractExpiry-2026-06-11'), false,
    'a run that reported an error must stay retryable');
  await scheduler._withAdvisoryLock(pool, 'contractExpiry-2026-06-11',
    async () => { runs++; }, { dbLatch: true });
  assert.equal(runs, 2, 'job must re-run after a failed attempt');
});

test('dbLatch wired onto the notification-only jobs + latch rows pruned', () => {
  const latched = {
    contractExpiry: 'tickContractExpiry',
    overdueDigest: 'tickOverdueDigest',
    autoReconcile: 'tickAutoReconcileRooms',
    pendingSlipAlert: 'tickPendingSlipAlert',
  };
  for (const [lockName, fnName] of Object.entries(latched)) {
    const re = new RegExp(
      `${lockName}-[^\`]*\`, \\(\\) => ${fnName}\\(pool, flags, now, state\\), \\{ dbLatch: true \\}`);
    assert.match(SRC, re, `${lockName} must pass { dbLatch: true }`);
  }
  // DB-guarded jobs keep their retry-friendly behavior (no latch).
  assert.doesNotMatch(SRC, /billGen-\$\{todayKey\}[^\n]*dbLatch/,
    'bill-gen is ON CONFLICT-guarded; latch would block intra-day retries');
  assert.doesNotMatch(SRC, /autoBackup-\$\{todayKey\}[^\n]*dbLatch/,
    'auto-backup gates on hourUtc internally; a latch on the early-return no-op would suppress the real run');
  assert.match(SRC, /DELETE FROM app_data\s+WHERE key LIKE 'sched_done:%'/,
    'latch rows must be pruned so app_data stays bounded');
  assert.match(SRC, /if \(dbLatch && !\(result && result\.error\)\)/,
    'latch must be written only after a non-error run');
});

// === 4. Contract-locked late fee with global rate 0 ========================

test('tickLateFee: contract-locked rate applies when global ratePctPerMonth is 0', async () => {
  const updates = [];
  const bill = flippedBillRow({
    id: 21, room_id: 'C3', tenant_id: 5, total: '5000', subtotal: '5000',
    due_date: '2026-05-02', bill_no: 'INV-2026-05-C3', period: '2026-05',
    full_name: 'สมชาย', contract_late_fee_rate: '2',
  });
  const pool = makePool((sql, params) => {
    if (/WITH bumped AS/.test(sql)) return { rows: [bill], rowCount: 1 };
    if (/UPDATE bills\s+SET late_fee/.test(sql)) {
      updates.push(params);
      return { rowCount: 1, rows: [] };
    }
    return null;
  });
  const flags = { lateFee: { enabled: true, ratePctPerMonth: 0 } };
  await withNotifyTenantCapture(async () => {
    await scheduler.tickLateFee(pool, flags, new Date(2026, 5, 11), {});
  });
  assert.equal(updates.length, 1, 'Phase A must reach the per-bill rate resolution');
  // 40 days over, 2%/month on 5000 principal: 5000 * 0.02 * (40/30) = 133.33
  assert.deepEqual(updates[0], [21, 133.33, 5000]);
  assert.doesNotMatch(SRC, /lateFeeEnabled && ratePctMonth > 0/,
    'phases must gate on the flag only — the global rate is just the fallback');
});

// === 5. Bill-gen notify fan-out per-bill guard ==============================

test('bill-gen tenant notify loop guards each bill (one failure cannot drop the rest)', () => {
  const loopIdx = SRC.indexOf('for (const b of billsCreated)');
  assert.ok(loopIdx > 0, 'fan-out loop exists');
  const seg = SRC.slice(loopIdx, loopIdx + 3000);
  assert.match(seg, /try \{[\s\S]*?SELECT id, line_user_id/,
    'the per-bill tenant lookup must sit inside a per-iteration try');
  assert.match(seg, /catch \(err\) \{[\s\S]*?tenant notify enqueue failed for bill/,
    'per-bill catch must log and continue — lastBillPeriod is already latched, so a dropped bill is never retried');
});

// === 6. autoBackup.hourUtc = 0 ==============================================

test('tickAutoBackup: hourUtc=0 fires at 00:xx UTC, not the 19:00 fallback', async () => {
  const calls = [];
  const origRun = backup.run;
  backup.run = async (opts) => { calls.push(opts); };
  try {
    const flags = { autoBackup: { enabled: true, hourUtc: 0, retainDays: 5 } };
    // 19:00 UTC is the old `|| 19` fallback hour — must NOT fire.
    await scheduler.tickAutoBackup(makePool(() => null), flags,
      new Date(Date.UTC(2026, 5, 11, 19, 5)), {});
    assert.equal(calls.length, 0, 'configured hourUtc=0 must not be overridden to 19');
    // 00:30 UTC is the configured window — must fire.
    const state = {};
    await scheduler.tickAutoBackup(makePool(() => null), flags,
      new Date(Date.UTC(2026, 5, 11, 0, 30)), state);
    assert.equal(calls.length, 1, 'backup must fire at the configured hour');
    assert.equal(calls[0].retainDays, 5);
    assert.ok(state.lastBackup, 'fired day must latch');
  } finally {
    backup.run = origRun;
  }
});

// === 7. payment-reminder ordered after bill-gen =============================

test('payment-reminder is chained off the bill-gen promise, not raced in parallel', () => {
  assert.match(SRC, /\{ job: 'bill-gen', promise: billGenPromise \}/,
    'bill-gen promise must be shared so the reminder can sequence on it');
  assert.match(SRC, /promise: billGenPromise\.catch\(\(\) => \{\}\)\.then\(\s*\(\) => _withAdvisoryLock\(pool, `paymentReminder-\$\{todayKey\}`/,
    'reminder must wait for bill-gen to settle so same-day-due bills are committed before the due_date = CURRENT_DATE query runs');
});
