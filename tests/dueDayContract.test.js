// tests/dueDayContract.test.js
// Contract-locked due day honored across every bill-generation path, with
// the same precedence rule the system already uses for rent and the
// late-fee rate: what the tenant SIGNED beats today's global setting.
// Also pins the bulk/preview expired-contract continuation fix (stay-on
// tenants keep their signed rate in EVERY path, not just scheduler/manual).
//   node --test tests/dueDayContract.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const billing = require('../services/billing');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// === Pure precedence helper ==================================================

test('resolveBillDueDay: contract > request > config > fallback', () => {
  assert.deepEqual(
    billing.resolveBillDueDay({ contractDueDay: 5, requestedDueDay: 10, configDueDay: 15 }),
    { day: 5, source: 'contract' });
  assert.deepEqual(
    billing.resolveBillDueDay({ requestedDueDay: 10, configDueDay: 15 }),
    { day: 10, source: 'request' });
  assert.deepEqual(
    billing.resolveBillDueDay({ configDueDay: 15 }),
    { day: 15, source: 'config' });
  assert.deepEqual(
    billing.resolveBillDueDay({}),
    { day: 15, source: 'default' });
  assert.deepEqual(
    billing.resolveBillDueDay({ fallback: 7 }),
    { day: 7, source: 'default' });
});

test('resolveBillDueDay: invalid candidates FALL THROUGH instead of clamping', () => {
  // A corrupted snapshot (0, 31, NaN, '') must not drag every due date to
  // the 1st/28th — it loses its vote and the next source decides.
  assert.deepEqual(
    billing.resolveBillDueDay({ contractDueDay: 31, configDueDay: 10 }),
    { day: 10, source: 'config' });
  assert.deepEqual(
    billing.resolveBillDueDay({ contractDueDay: 0, requestedDueDay: 'abc', configDueDay: 12 }),
    { day: 12, source: 'config' });
  assert.deepEqual(
    billing.resolveBillDueDay({ contractDueDay: null, configDueDay: '' }),
    { day: 15, source: 'default' });
  // Numeric strings from the JSONB ->> extraction parse fine; floats truncate.
  assert.deepEqual(
    billing.resolveBillDueDay({ contractDueDay: '5' }),
    { day: 5, source: 'contract' });
  assert.deepEqual(
    billing.resolveBillDueDay({ contractDueDay: 9.9 }),
    { day: 9, source: 'contract' });
});

// === Wiring pins =============================================================

test('scheduler bill-gen resolves the due date per room with the signed day first', () => {
  const sched = read('services', 'scheduler.js');
  assert.match(sched, /CASE WHEN locked_at IS NOT NULL[\s\S]{0,120}financials'->>'dueDay'/,
    'contract SELECT must expose the snapshot due day (locked contracts only)');
  assert.match(sched, /resolveBillDueDay\(\{\s*contractDueDay: \(activeContract \|\| expiredContract\)\?\.contract_due_day/,
    'per-room resolution must consider both active and stay-on contracts');
  const lockedCount = (sched.match(/THEN \(terms_template_snapshot->'financials'->>'dueDay'\)::numeric/g) || []).length;
  assert.ok(lockedCount >= 2, 'both the active AND expired contract lookups carry the due day');
});

test('bulk-generate + preview use shared contract helpers with due day + expired continuation', () => {
  const routes = read('routes', 'bills-extras.js');
  assert.match(routes, /async function expiredContractForRoom/,
    'expired-continuation helper exists for bulk/preview');
  assert.match(routes, /END AS contract_due_day[\s\S]{0,200}status='active'/,
    'activeContractForRoom exposes the snapshot due day');
  // Bulk: per-room due date + source counting + expired contract in buildBill.
  assert.match(routes, /dueDaySources\[due\.source\] = \(dueDaySources\[due\.source\] \|\| 0\) \+ 1/,
    'bulk counts where each due date came from');
  assert.match(routes, /expiredContract, config, features: flags, recurring, period, dueDate: roomDueDate/,
    'bulk buildBill receives the stay-on contract and the per-room due date');
  // Preview: must mirror generate (same helper, same source label per row).
  assert.match(routes, /payload\.dueDateSource = due\.source/,
    'preview rows carry the due-date source so contract-pinned rows are explained');
  assert.match(routes, /const expiredContract = activeContract\s*\?\s*null\s*:\s*await expiredContractForRoom\(pool, roomId, tenant\.id \|\| null\)/,
    'preview applies the same stay-on continuation as generate');
});

test('manual single-bill compute path honors the signed due day when none is supplied', () => {
  const routes = read('routes', 'bills-extras.js');
  assert.match(routes, /let dueDateForBill = b\.dueDate;[\s\S]{0,400}resolveBillDueDay/,
    'explicit admin dueDate wins; otherwise contract > config decides');
  assert.match(routes, /dueDate: dueDateForBill/,
    'buildBill receives the resolved value');
});

test('invitation-approve welcome bill uses the due day of the snapshot being signed', () => {
  const server = read('server.js');
  assert.match(server, /contractDueDay: termsSnapshot\?\.snapshot\?\.financials\?\.dueDay/,
    'the welcome bill must match the PDF the tenant just signed');
});

test('bulk response surfaces dueDaySources for operator visibility', () => {
  const routes = read('routes', 'bills-extras.js');
  const idx = routes.indexOf("res.json({ ok: true, period, made, updated, skipped, flatFellBack");
  assert.ok(idx > 0, 'bulk response anchor');
  assert.match(routes.slice(idx, idx + 600), /dueDaySources/,
    'bulk response includes the per-source counts');
});
