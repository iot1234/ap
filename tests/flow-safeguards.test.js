// tests/flow-safeguards.test.js
// Regression tests for the booking→contract→billing flow audit fixes:
//   1. App pool pins SQL session timezone to Asia/Bangkok (CURRENT_DATE in
//      late-fee / reminders / contract-expiry must match the JS ICT clock).
//   2. meter.record() refuses backward readings unless explicitly confirmed
//      (typos no longer silently become next month's billing input).
//   3. Bill generation (bulk + scheduler) skips rooms whose blob shows a
//      tenant but the tenants table has no ACTIVE tenant — instead of
//      creating orphan bills (tenant_id NULL) nobody sees or pays.
//   4. Contract auto-expiry stamps the closed_* audit fields and skips
//      soft-deleted contracts (asserted in integration.test.js).
//   5. Invitation approval refuses blacklisted tenants (the one onboarding
//      door that wasn't guarded) and validates contract dates.
//   6. PUT /api/data/:key supports optimistic locking via baseUpdatedAt →
//      409 STALE_WRITE instead of last-write-wins clobbering concurrent
//      booking/scheduler/admin writes; api-client tracks the version.
//   node --test tests/flow-safeguards.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// === 1. SQL session timezone ===============================================

test('server pool pins every SQL session to Asia/Bangkok on connect', () => {
  const server = read('server.js');
  // The fix must live on the pool server.js actually uses (db/pool.js has the
  // same handler but is only a fallback pool not used by the app).
  assert.match(server, /pool\.on\('connect',[\s\S]{0,200}SET timezone='Asia\/Bangkok'/,
    'app pool must SET timezone on connect — otherwise scheduler CURRENT_DATE runs in UTC, 7h behind the JS clock');
});

// === 2. Meter rollback guard ===============================================

test('meter.record refuses a backward reading without allowRollback', async () => {
  const meter = require('../services/meter');
  let insertAttempted = false;
  const pool = {
    async query(sql) {
      if (/INSERT INTO meter_readings/.test(sql)) {
        insertAttempted = true;
        return { rows: [{ id: 1 }] };
      }
      // latestBeforePeriod / latest lookup → previous reading is 1500
      return { rows: [{ reading: 1500, reading_at: '2026-05-16T02:00:00Z' }] };
    },
  };
  await assert.rejects(
    () => meter.record(pool, { roomId: '201', meterType: 'elec', reading: 999, period: '2026-06' }),
    (err) => {
      assert.equal(err.code, 'METER_ROLLBACK');
      assert.equal(err.lastReading, 1500);
      assert.equal(err.attemptedReading, 999);
      return true;
    }
  );
  assert.equal(insertAttempted, false, 'the bad reading must never reach the table');
});

test('meter.record allows a backward reading when allowRollback=true (meter replaced)', async () => {
  const meter = require('../services/meter');
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push(sql);
      if (/INSERT INTO meter_readings/.test(sql)) {
        return { rows: [{ id: 7, room_id: params[0], meter_type: params[1], reading: params[2] }] };
      }
      return { rows: [{ reading: 1500, reading_at: '2026-05-16T02:00:00Z' }] };
    },
  };
  const out = await meter.record(pool, {
    roomId: '201', meterType: 'elec', reading: 10, period: '2026-06', allowRollback: true,
  });
  assert.equal(out.id, 7);
  assert.equal(out.delta, 0, 'rollback delta clamps to 0 — never a negative bill');
  assert.ok(calls.some((s) => /INSERT INTO meter_readings/.test(s)), 'reading stored after explicit consent');
});

test('meter.record still accepts a normal increasing reading', async () => {
  const meter = require('../services/meter');
  const pool = {
    async query(sql, params) {
      if (/INSERT INTO meter_readings/.test(sql)) {
        return { rows: [{ id: 8, reading: params[2] }] };
      }
      return { rows: [{ reading: 1500, reading_at: '2026-05-16T02:00:00Z' }] };
    },
  };
  const out = await meter.record(pool, { roomId: '201', meterType: 'elec', reading: 1625, period: '2026-06' });
  assert.equal(out.delta, 125);
});

test('admin meter endpoint exposes the rollback consent + audit', () => {
  const server = read('server.js');
  assert.match(server, /allowRollback: req\.body && req\.body\.allowRollback === true/,
    'route must pass explicit rollback consent through to meter.record');
  assert.match(server, /code: 'METER_ROLLBACK'/,
    'route must surface the structured 409 so the UI can offer a confirm-retry');
  assert.match(server, /meter\.rollback_confirmed/,
    'confirmed rollbacks must be audit-logged');
  const metersPage = read('project', 'admin', 'page-meters.jsx');
  assert.match(metersPage, /allowRollback: true/,
    'meters page must resend with consent after the admin confirms a real meter reset');
});

test('check-in meter baseline keeps its own backward guard (force-escapable)', () => {
  const ops = read('routes', 'tenant-ops.js');
  assert.match(ops, /METER_START_BACKWARD/,
    'check-in must keep refusing backward start readings unless forced');
  assert.match(ops, /source: 'checkin', createdBy: req\.session\.user\.username,[\s\S]{0,400}allowRollback: true/,
    'check-in record() call opts out of the double-check — its own guard already ran');
});

// === 3. Orphan-bill guard (bulk + scheduler) ================================

test('bulk-generate skips rooms with a blob tenant but no active tenants row', () => {
  const routes = read('routes', 'bills-extras.js');
  assert.match(routes, /relationalTenantsInUse/,
    'bulk-generate must detect whether the deployment uses the tenants table');
  assert.match(routes, /bumpSkip\('noActiveTenantRecord'\)/,
    'the drift case must be counted as an explicit skip reason');
  assert.match(routes, /tenantlessSkipped/,
    'skipped rooms must be surfaced back to the admin UI');
});

test('scheduler tickBillGen skips + alerts instead of creating orphan bills', () => {
  const sched = read('services', 'scheduler.js');
  assert.match(sched, /relationalTenantsInUse/,
    'scheduler bill-gen must detect whether the tenants table is in use');
  assert.match(sched, /billGenTenantlessSkipped_/,
    'owner alert must be latched once per period');
  assert.match(sched, /ไม่พบผู้เช่า active ในระบบ/,
    'owner alert must explain the skip in operator language');
});

// === 5. Contract approval guards ===========================================

test('invitation approval refuses blacklisted tenants', () => {
  const server = read('server.js');
  // The guard must read tenant status under the same FOR UPDATE lock that
  // the approve transaction already takes.
  assert.match(server, /SELECT id, status FROM tenants WHERE id=\$1 AND deleted_at IS NULL FOR UPDATE/,
    'tenant guard must read status under lock');
  assert.match(server, /tenantGuard\.rows\[0\]\.status === 'blacklist'/,
    'approval must check the blacklist status');
  const idx = server.indexOf("tenantGuard.rows[0].status === 'blacklist'");
  const after = server.slice(idx, idx + 600);
  assert.match(after, /TENANT_BLACKLISTED/,
    'blacklist refusal must use the same code as the booking-approve guard');
});

test('contract approval validates end_date >= start_date', () => {
  const server = read('server.js');
  assert.match(server, /CONTRACT_DATES_INVALID/,
    'approval target validation must include the date sanity issue');
});

// === 6. Optimistic locking on the shared JSONB blobs ========================

test('PUT /api/data/:key supports baseUpdatedAt → 409 STALE_WRITE', () => {
  const server = read('server.js');
  assert.match(server, /baseUpdatedAt/,
    'PUT must read the client base version');
  assert.match(server, /code: 'STALE_WRITE'/,
    'stale writes must be refused with a structured 409');
  assert.match(server, /INVALID_BASE_UPDATED_AT/,
    'unparseable base versions must 400, not silently bypass the check');
  // The version check has to be atomic with the write — same transaction,
  // row locked.
  assert.match(server, /SELECT updated_at, updated_by FROM app_data WHERE key=\$1 FOR UPDATE/,
    'version check must run under the row lock');
  // The saved row version must round-trip so clients can chain saves.
  assert.match(server, /RETURNING updated_at/,
    'PUT must return the fresh updated_at');
});

test('GET /api/data exposes per-key row versions for the lock handshake', () => {
  const server = read('server.js');
  assert.match(server, /SELECT value, updated_at FROM app_data WHERE key=\$1/,
    'single-key GET must read updated_at');
  assert.match(server, /res\.json\(\{ key, value, updatedAt \}\)/,
    'single-key GET must return updatedAt');
  assert.match(server, /out\.__meta = meta/,
    'bulk GET must expose per-key versions under __meta (additive, old clients unaffected)');
});

test('api-client tracks base versions, serialises PUTs, and recovers from 409', () => {
  const client = read('project', 'api-client.js');
  assert.match(client, /const baseVersions = new Map\(\)/,
    'client must track per-key base versions');
  assert.match(client, /body\.baseUpdatedAt = base/,
    'client must send the base version on PUT');
  assert.match(client, /STALE_WRITE/,
    'client must handle the stale-write refusal');
  assert.match(client, /async function rehydrateKey\(key\)/,
    'client must re-pull the fresh server copy after a conflict');
  assert.match(client, /latestQueued/,
    'PUTs must be serialised per key so same-tab saves chain on fresh versions');
  assert.match(client, /data\.__meta && data\.__meta\.updatedAt/,
    'hydrate must capture versions from the bulk GET');
});

test('stale PUT with identical content is accepted as a no-op (echo tolerance)', () => {
  const server = read('server.js');
  // Admin flows patch local state after a server endpoint already mutated the
  // same blob, then the localStorage mirror echoes the whole blob back with
  // an old base. When the content is jsonb-identical the server must accept
  // it quietly (returning the current version) instead of crying conflict.
  assert.match(server, /SELECT \(value = \$2::jsonb\) AS same FROM app_data WHERE key=\$1/,
    'stale writes must be content-compared before refusing');
  assert.match(server, /noop: true/,
    'identical echo must resolve as a successful no-op');
  const shell = read('project', 'admin', 'shell.jsx');
  assert.match(shell, /setBaseVersion\('baankarn_bookings_v1', bd\.updatedAt\)/,
    'bookings live-poll must re-base the lock before merging new bookings');
});

test('pricing + settings pages join the optimistic-lock handshake', () => {
  for (const page of ['page-pricing.jsx', 'page-settings.jsx']) {
    const src = read('project', 'admin', page);
    assert.match(src, /getBaseVersion\('baankarn_config_v1'\)/,
      `${page} must read the config base version`);
    assert.match(src, /baseUpdatedAt/,
      `${page} must attach baseUpdatedAt to its config save`);
  }
  const hooks = read('project', 'admin', 'hooks.jsx');
  assert.match(hooks, /STALE_WRITE: \{/,
    'admin error map must explain the stale-write refusal');
  assert.match(hooks, /METER_ROLLBACK: \{/,
    'admin error map must explain the meter rollback refusal');
});
