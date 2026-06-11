// tests/lineBinding.test.js
//   node --test tests/lineBinding.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const lb = require('../services/lineBinding');

// Build a fake pool that records calls + returns scripted responses.
function buildFakePool(scenarios = {}) {
  const calls = [];
  async function query(sql, params) {
    // Store the full SQL so multi-line statements can be matched in
    // assertions (e.g. `UPDATE tenants\n  SET line_user_id=...`).
    calls.push({ sql: sql.trim(), params });
    for (const [pattern, fn] of Object.entries(scenarios)) {
      if (sql.includes(pattern)) return fn(sql, params);
    }
    if (/UPDATE line_bindings[\s\S]+SET status='bound'/.test(sql)) {
      return { rows: [{ id: params?.[2] || 1 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  // Connect returns a transaction-capable client.
  async function connect() {
    return {
      query,
      release() {},
    };
  }
  return { query, connect, _calls: calls };
}

test('generateCode produces BIND- prefix + 12 hex', () => {
  const c = lb.generateCode();
  assert.match(c, /^BIND-[A-F0-9]{12}$/);
});

test('issue: throws if tenant not found', async () => {
  const pool = buildFakePool({
    'SELECT id, full_name': () => ({ rows: [] }),
  });
  await assert.rejects(
    () => lb.issue(pool, { tenantId: 99, ttlDays: 7 }),
    /tenant not found/
  );
});

test('issue: throws if tenant is blocked', async () => {
  const pool = buildFakePool({
    'SELECT id, full_name': () => ({ rows: [{ id: 1, full_name: 'X', line_binding_blocked: true }] }),
  });
  await assert.rejects(
    () => lb.issue(pool, { tenantId: 1, ttlDays: 7 }),
    /blocked/
  );
});

test('issue: ttl validation rejects out-of-range', async () => {
  const pool = buildFakePool();
  await assert.rejects(() => lb.issue(pool, { tenantId: 1, ttlDays: 0 }));
  await assert.rejects(() => lb.issue(pool, { tenantId: 1, ttlDays: 365 }));
  await assert.rejects(() => lb.issue(pool, { tenantId: 1, ttlDays: 'abc' }));
});

test('issue: validates tenant and OA inputs before opening a transaction', async () => {
  const pool = {
    connect() {
      throw new Error('should not connect');
    },
  };
  await assert.rejects(
    () => lb.issue(pool, { tenantId: 0, ttlDays: 7 }),
    { code: 'INVALID_TENANT_ID' }
  );
  await assert.rejects(
    () => lb.issue(pool, { tenantId: 1, ttlDays: 7, targetOaId: 'abc' }),
    { code: 'INVALID_TARGET_OA' }
  );
});

test('issue: revokes prior pending then creates new', async () => {
  const createdAt = new Date('2026-05-18T09:00:00Z');
  const pool = buildFakePool({
    'SELECT id, full_name': () => ({
      rows: [{ id: 1, full_name: 'X', line_binding_blocked: false, status: 'active', current_room_id: '101' }],
    }),
    'INSERT INTO line_bindings': () => ({ rows: [{ id: 42, code: 'BIND-AAAAAAAA', expires_at: new Date(), created_at: createdAt }] }),
  });
  const out = await lb.issue(pool, { tenantId: 1, ttlDays: 7, createdBy: 'admin' });
  assert.equal(out.id, 42);
  assert.equal(out.createdAt, createdAt);
  assert.match(out.code, /^BIND-/);
  // Verify the revoke step happened before insert
  const sequence = pool._calls.map((c) => c.sql);
  const revokeIdx = sequence.findIndex((s) => s.startsWith('UPDATE line_bindings SET status='));
  const insertIdx = sequence.findIndex((s) => s.startsWith('INSERT INTO line_bindings'));
  assert.ok(revokeIdx >= 0 && insertIdx > revokeIdx, 'revoke should come before insert');
  const tenantSelect = sequence.find((s) => s.includes('FROM tenants'));
  assert.match(tenantSelect, /FOR UPDATE/, 'issuing tenant codes must lock the tenant row');
});

test('issue: retries code collision without aborting the transaction', async () => {
  let inserts = 0;
  const pool = buildFakePool({
    'SELECT id, full_name': () => ({
      rows: [{ id: 1, full_name: 'X', line_binding_blocked: false, status: 'active', current_room_id: '101' }],
    }),
    'INSERT INTO line_bindings': () => {
      inserts++;
      if (inserts === 1) return { rows: [], rowCount: 0 };
      return { rows: [{ id: 44, code: 'BIND-CCCCCCCC', expires_at: new Date(), created_at: new Date() }], rowCount: 1 };
    },
  });
  const out = await lb.issue(pool, { tenantId: 1, ttlDays: 7, createdBy: 'admin' });
  assert.equal(out.id, 44);
  assert.equal(inserts, 2, 'a code conflict should retry with a new code');
  const insertCalls = pool._calls.filter((c) => c.sql.startsWith('INSERT INTO line_bindings'));
  assert.ok(insertCalls.every((c) => c.sql.includes('ON CONFLICT (code) DO NOTHING')),
    'code collisions must not poison the PostgreSQL transaction');
  assert.equal(pool._calls.some((c) => c.sql === 'ROLLBACK'), false);
  assert.equal(pool._calls.some((c) => c.sql === 'COMMIT'), true);
});

test('issue: can create an additional pending code for another LINE account', async () => {
  const pool = buildFakePool({
    'SELECT id, full_name': () => ({
      rows: [{ id: 1, full_name: 'X', line_binding_blocked: false, status: 'active', current_room_id: '101' }],
    }),
    'INSERT INTO line_bindings': () => ({ rows: [{ id: 43, code: 'BIND-BBBBBBBB', expires_at: new Date() }] }),
  });
  const out = await lb.issue(pool, {
    tenantId: 1,
    ttlDays: 7,
    createdBy: 'admin',
    replacePending: false,
  });
  assert.equal(out.id, 43);
  const calls = pool._calls.map((c) => c.sql.replace(/\s+/g, ' '));
  assert.equal(
    calls.some((s) => s.includes("UPDATE line_bindings SET status='revoked'") && s.includes("status='pending'")),
    false,
    'additional LINE account codes must not revoke other pending room codes'
  );
  assert.ok(calls.some((s) => s.startsWith('INSERT INTO line_bindings')));
});

test('issue: reports old pending-per-tenant unique index as migration-required', async () => {
  const pool = buildFakePool({
    'SELECT id, full_name': () => ({
      rows: [{ id: 1, full_name: 'X', line_binding_blocked: false, status: 'active', current_room_id: '101' }],
    }),
    'INSERT INTO line_bindings': () => {
      const err = new Error('duplicate key');
      err.code = '23505';
      err.constraint = 'uq_line_bindings_pending_per_tenant';
      throw err;
    },
  });
  await assert.rejects(
    () => lb.issue(pool, { tenantId: 1, ttlDays: 7, createdBy: 'admin', replacePending: false }),
    { code: 'LINE_BINDING_PENDING_UNIQUE_MIGRATION_REQUIRED', status: 409 }
  );
});

test('tryBind: invalid format returns ok=false', async () => {
  const pool = buildFakePool();
  const r = await lb.tryBind(pool, { code: 'XYZ123', lineUserId: 'U1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
});

test('tryBind: unknown code returns invalid', async () => {
  const pool = buildFakePool({
    'FROM line_bindings b': () => ({ rows: [] }),
  });
  const r = await lb.tryBind(pool, { code: 'BIND-DEADBEEF', lineUserId: 'U1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
});

test('tryBind: blocked tenant returns tenant_blocked', async () => {
  const pool = buildFakePool({
    'FROM line_bindings b': () => ({
      rows: [{
        id: 1, tenant_id: 5, status: 'pending',
        expires_at: new Date(Date.now() + 86400000),
        full_name: 'X', current_room_id: '101',
        line_binding_blocked: true,
      }],
    }),
  });
  const r = await lb.tryBind(pool, { code: 'BIND-DEADBEEF', lineUserId: 'U1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'tenant_blocked');
});

test('tryBind: expired code returns expired', async () => {
  const pool = buildFakePool({
    'FROM line_bindings b': () => ({
      rows: [{
        id: 1, tenant_id: 5, status: 'pending',
        expires_at: new Date(Date.now() - 86400000), // yesterday
        full_name: 'X', current_room_id: '101', tenant_status: 'active',
        line_binding_blocked: false,
      }],
    }),
  });
  const r = await lb.tryBind(pool, { code: 'BIND-DEADBEEF', lineUserId: 'U1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expired');
});

test('tryBind: already-bound code returns already_bound', async () => {
  const pool = buildFakePool({
    'FROM line_bindings b': () => ({
      rows: [{
        id: 1, tenant_id: 5, status: 'bound',
        expires_at: new Date(Date.now() + 86400000),
        full_name: 'X', current_room_id: '101', tenant_status: 'active',
        line_binding_blocked: false,
      }],
    }),
  });
  const r = await lb.tryBind(pool, { code: 'BIND-DEADBEEF', lineUserId: 'U1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'already_bound');
});

test('tryBind: detects LINE userId already bound to other tenant', async () => {
  const pool = buildFakePool({
    'FROM line_bindings b': () => ({
      rows: [{
        id: 1, tenant_id: 5, status: 'pending',
        expires_at: new Date(Date.now() + 86400000),
        full_name: 'X', current_room_id: '101', tenant_status: 'active',
        line_binding_blocked: false,
      }],
    }),
    "WHERE line_user_id=$1": () => ({
      rows: [{ tenant_id: 99 }],
    }),
  });
  const r = await lb.tryBind(pool, { code: 'BIND-DEADBEEF', lineUserId: 'U1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'line_user_already_bound');
  assert.equal(r.otherTenantId, 99);
});

test('tryBind: success — updates binding + tenant', async () => {
  const pool = buildFakePool({
    'FROM line_bindings b': () => ({
      rows: [{
        id: 1, tenant_id: 5, status: 'pending',
        expires_at: new Date(Date.now() + 86400000),
        full_name: 'Mr. T', current_room_id: '305', tenant_status: 'active',
        line_binding_blocked: false,
      }],
    }),
    "WHERE line_user_id=$1": () => ({ rows: [] }),
  });
  const r = await lb.tryBind(pool, { code: 'BIND-DEADBEEF', lineUserId: 'Uabc123' });
  assert.equal(r.ok, true);
  assert.equal(r.tenantId, 5);
  assert.equal(r.fullName, 'Mr. T');
  assert.equal(r.roomId, '305');
  // Verify both the binding and the tenant were updated
  const calls = pool._calls.map((c) => c.sql);
  assert.ok(calls.some((s) => s.startsWith('UPDATE line_bindings')));
  // SQL may span multiple lines (e.g. "UPDATE tenants\n  SET line_user_id=$1")
  // — normalize whitespace before substring-match so the test stays robust
  // against multi-OA refactors that reformat the query.
  assert.ok(calls.some((s) => s.replace(/\s+/g, ' ').includes('UPDATE tenants SET line_user_id')));
  const lookup = pool._calls.find((c) => c.sql.includes('FROM line_bindings b'));
  assert.match(lookup.sql, /FOR UPDATE OF b/, 'tryBind must lock the binding row before consuming a code');
  const update = pool._calls.find((c) => c.sql.includes('UPDATE line_bindings'));
  assert.match(update.sql, /WHERE id=\$3 AND status='pending'/,
    'tryBind must only consume codes that are still pending after any concurrent bind');
});

test('issueBooking: creates a booking-scoped code without a tenant row', async () => {
  const pool = buildFakePool({
    'SELECT external_id, status': () => ({
      rows: [{ external_id: 'BK-1', status: 'pending', phone: '0811111111', name: 'Booker' }],
    }),
    'INSERT INTO line_bindings': () => ({
      rows: [{ id: 77, code: 'BIND-AAAA1111', expires_at: new Date(), target_oa_id: null }],
    }),
  });
  const out = await lb.issueBooking(pool, { bookingId: 'BK-1', ttlDays: 7, createdBy: 'public-booking' });
  assert.equal(out.id, 77);
  assert.equal(out.bookingId, 'BK-1');
  assert.equal(out.tenantId, undefined);
  const calls = pool._calls.map((c) => c.sql.replace(/\s+/g, ' '));
  assert.ok(calls.some((s) =>
    s.includes("UPDATE line_bindings SET status='revoked'") &&
    s.includes('WHERE booking_id=$1 AND tenant_id IS NULL AND status=')));
  assert.ok(calls.some((s) =>
    s.includes('INSERT INTO line_bindings (tenant_id, booking_id, code') &&
    s.includes('VALUES (NULL, $1, $2')));
  const bookingSelect = pool._calls.find((c) => c.sql.includes('FROM bookings'));
  assert.match(bookingSelect.sql, /FOR UPDATE/,
    'issuing booking-stage codes must lock the booking row under concurrent submits');
});

test('issueBooking: retries code collision without swallowing other unique errors', async () => {
  let inserts = 0;
  const pool = buildFakePool({
    'SELECT external_id, status': () => ({
      rows: [{ external_id: 'BK-1', status: 'pending', phone: '0811111111', name: 'Booker' }],
    }),
    'INSERT INTO line_bindings': () => {
      inserts++;
      if (inserts === 1) return { rows: [], rowCount: 0 };
      return { rows: [{ id: 78, code: 'BIND-BBBB2222', expires_at: new Date(), target_oa_id: null }], rowCount: 1 };
    },
  });
  const out = await lb.issueBooking(pool, { bookingId: 'BK-1', ttlDays: 7, createdBy: 'public-booking' });
  assert.equal(out.id, 78);
  assert.equal(inserts, 2);
  const insertCalls = pool._calls.filter((c) => c.sql.startsWith('INSERT INTO line_bindings'));
  assert.ok(insertCalls.every((c) => c.sql.includes('ON CONFLICT (code) DO NOTHING')));
  assert.equal(pool._calls.some((c) => c.sql === 'ROLLBACK'), false);
  assert.equal(pool._calls.some((c) => c.sql === 'COMMIT'), true);
});

test('tryBind: concurrent code consumption returns already_bound cleanly', async () => {
  const pool = buildFakePool({
    'FROM line_bindings b': () => ({
      rows: [{
        id: 31, tenant_id: 5, status: 'pending',
        expires_at: new Date(Date.now() + 86400000),
        full_name: 'Race Guard', current_room_id: '701', tenant_status: 'active',
        line_binding_blocked: false,
      }],
    }),
    'WHERE line_user_id=$1': () => ({ rows: [] }),
    "UPDATE line_bindings\n          SET status='bound'": () => ({ rows: [], rowCount: 0 }),
  });
  const r = await lb.tryBind(pool, { code: 'BIND-DEADBEEF', lineUserId: 'Urace', oaId: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'already_bound');
  const tenantUpdate = pool._calls.some((c) =>
    c.sql.replace(/\s+/g, ' ').includes('UPDATE tenants SET line_user_id'));
  assert.equal(tenantUpdate, false, 'tenant cache must not be overwritten if the code was consumed concurrently');
});

test('tryBind: booking-stage code binds before tenant creation', async () => {
  const pool = buildFakePool({
    'FROM line_bindings b': () => ({
      rows: [{
        id: 11,
        tenant_id: null,
        booking_id: 'BK-2',
        status: 'pending',
        target_oa_id: null,
        expires_at: new Date(Date.now() + 86400000),
        booking_name: 'Booker',
        booking_room_id: '402',
        booking_status: 'pending',
      }],
    }),
    'WHERE line_user_id=$1': () => ({ rows: [] }),
  });
  const r = await lb.tryBind(pool, { code: 'BIND-DEADBEEF', lineUserId: 'Ubooking', oaId: 9 });
  assert.equal(r.ok, true);
  assert.equal(r.tenantId, null);
  assert.equal(r.bookingId, 'BK-2');
  assert.equal(r.fullName, 'Booker');
  assert.equal(r.roomId, '402');
  assert.equal(r.pendingTenantLink, true);
  const tenantUpdate = pool._calls.some((c) =>
    c.sql.replace(/\s+/g, ' ').includes('UPDATE tenants SET line_user_id'));
  assert.equal(tenantUpdate, false, 'booking pre-bind must not update tenants before a tenant exists');
});

test('tryBind: keeps existing same-tenant bindings for unlimited LINE recipients', async () => {
  const pool = buildFakePool({
    'FROM line_bindings b': () => ({
      rows: [{
        id: 21, tenant_id: 5, status: 'pending',
        expires_at: new Date(Date.now() + 86400000),
        full_name: 'Multi Line', current_room_id: '501', tenant_status: 'active',
        line_binding_blocked: false,
      }],
    }),
    'WHERE line_user_id=$1': () => ({ rows: [] }),
  });
  const r = await lb.tryBind(pool, { code: 'BIND-DEADBEEF', lineUserId: 'Unew', oaId: 3 });
  assert.equal(r.ok, true);
  const revokedOtherBoundRows = pool._calls.some((c) => {
    const sql = c.sql.replace(/\s+/g, ' ');
    return sql.includes('UPDATE line_bindings') &&
      sql.includes("status='revoked'") &&
      sql.includes("status='bound'") &&
      sql.includes('id <>');
  });
  assert.equal(revokedOtherBoundRows, false, 'binding a new LINE must not revoke older bound rows');
});

test('transferBookingBindings: moves booking-bound LINE rows onto the created tenant', async () => {
  const pool = buildFakePool({
    'UPDATE line_bindings': () => ({
      rowCount: 3,
      rows: [
        { line_user_id: 'Uold', oa_id: 2, status: 'bound', bound_at: new Date('2026-01-01T00:00:00Z') },
        { line_user_id: null, oa_id: null, status: 'pending', bound_at: null },
        { line_user_id: 'Unew', oa_id: 4, status: 'bound', bound_at: new Date('2026-01-02T00:00:00Z') },
      ],
    }),
  });
  const out = await lb.transferBookingBindings(pool, { bookingId: 'BK-3', tenantId: 8 });
  assert.deepEqual({ moved: out.moved, bound: out.bound, pending: out.pending }, {
    moved: 3, bound: 2, pending: 1,
  });
  const tenantUpdate = pool._calls.find((c) =>
    c.sql.replace(/\s+/g, ' ').includes('UPDATE tenants SET line_user_id'));
  assert.ok(tenantUpdate, 'latest bound LINE should be cached on tenants.* for backward compatibility');
  assert.equal(tenantUpdate.params[0], 'Unew');
  assert.equal(tenantUpdate.params[1], 4);
  assert.equal(tenantUpdate.params[2], 8);
});

test('revokeBookingBindings revokes only booking-scoped LINE rows', async () => {
  const pool = buildFakePool({
    'UPDATE line_bindings': () => ({
      rowCount: 2,
      rows: [{ oa_id: 2 }, { oa_id: null }],
    }),
  });
  const out = await lb.revokeBookingBindings(pool, { bookingId: 'BK-9' });
  assert.equal(out.revoked, 2);
  const update = pool._calls.find((c) => c.sql.includes('UPDATE line_bindings'));
  const sql = update.sql.replace(/\s+/g, ' ');
  assert.match(sql, /WHERE booking_id=\$1/);
  assert.match(sql, /tenant_id IS NULL/);
  assert.match(sql, /status IN \('pending', 'bound'\)/);
});

test('getStatus/listAll expose bound LINE account counts per tenant room', async () => {
  const statusPool = buildFakePool({
    'FROM tenants WHERE id=$1': () => ({
      rows: [{ id: 1, full_name: 'Counter', phone: '0811111111', current_room_id: 'A1' }],
    }),
    'FROM line_bindings b': () => ({
      rows: [
        { id: 10, status: 'pending', line_user_id: null, code: 'BIND-BBBB1111' },
        { id: 11, status: 'pending', line_user_id: null, code: 'BIND-CCCC1111' },
        { id: 9, status: 'bound', line_user_id: 'U1', code: 'BIND-AAAA1111' },
      ],
    }),
    'COUNT(*)::int AS bound_count': () => ({ rows: [{ bound_count: 2 }] }),
  });
  const listPool = buildFakePool({
    'COALESCE(bc.bound_count': () => ({
      rows: [{ tenant_id: 1, full_name: 'Counter', line_user_id: null, bound_count: 3 }],
    }),
  });

  const status = await lb.getStatus(statusPool, 1);
  assert.equal(status.boundCount, 2);
  assert.equal(status.pendingCodes.length, 2);

  const rows = await lb.listAll(listPool);
  assert.equal(rows[0].bound_count, 3);
});

test('revokeAccount removes one LINE account and keeps remaining account cached', async () => {
  const pool = buildFakePool({
    'SELECT id, tenant_id, line_user_id, oa_id, status': () => ({
      rows: [{ id: 91, tenant_id: 7, line_user_id: 'Uold', oa_id: 2, status: 'bound' }],
    }),
    'UPDATE line_bindings': () => ({ rows: [], rowCount: 1 }),
    'SELECT line_user_id, oa_id': () => ({
      rows: [{ line_user_id: 'Uremain', oa_id: 4 }],
    }),
    'COUNT(*)::int AS bound_count': () => ({ rows: [{ bound_count: 1 }] }),
  });
  const out = await lb.revokeAccount(pool, { tenantId: 7, bindingId: 91 });
  assert.equal(out.ok, true);
  assert.equal(out.remainingBoundCount, 1);
  assert.equal(out.activeLineUserId, 'Uremain');
  const calls = pool._calls.map((c) => c.sql.replace(/\s+/g, ' '));
  assert.ok(calls.some((s) => s.includes("WHERE id=$1 AND tenant_id=$2 AND status='bound'")),
    'single-account revoke must be scoped to one tenant and one bound binding');
  const tenantUpdate = pool._calls.find((c) =>
    c.sql.replace(/\s+/g, ' ').includes('UPDATE tenants SET line_user_id=$1'));
  assert.ok(tenantUpdate, 'tenant LINE cache must be repointed after a single-account revoke');
  assert.equal(tenantUpdate.params[0], 'Uremain');
  assert.equal(tenantUpdate.params[1], 4);
  assert.equal(tenantUpdate.params[2], 7);
});

test('revokePendingCode revokes only one unused tenant key', async () => {
  const createdAt = new Date('2026-05-18T09:00:00Z');
  const expiresAt = new Date('2026-05-25T09:00:00Z');
  const pool = buildFakePool({
    'SELECT id, tenant_id, code, status': () => ({
      rows: [{
        id: 55,
        tenant_id: 7,
        code: 'BIND-PENDING1',
        status: 'pending',
        expires_at: expiresAt,
        created_at: createdAt,
        target_oa_id: 2,
      }],
    }),
    'UPDATE line_bindings': () => ({
      rowCount: 1,
      rows: [{
        id: 55,
        code: 'BIND-PENDING1',
        status: 'revoked',
        expires_at: expiresAt,
        created_at: createdAt,
        target_oa_id: 2,
      }],
    }),
  });
  const out = await lb.revokePendingCode(pool, { tenantId: 7, bindingId: 55 });
  assert.equal(out.ok, true);
  assert.equal(out.bindingId, 55);
  assert.equal(out.code, 'BIND-PENDING1');
  assert.equal(out.createdAt, createdAt);
  assert.equal(out.expiresAt, expiresAt);
  const select = pool._calls.find((c) => c.sql.includes('FROM line_bindings') && c.sql.includes('FOR UPDATE'));
  assert.match(select.sql, /WHERE id=\$1/);
  assert.match(select.sql, /tenant_id=\$2/);
  const update = pool._calls.find((c) => c.sql.includes('UPDATE line_bindings'));
  const sql = update.sql.replace(/\s+/g, ' ');
  assert.match(sql, /WHERE id=\$1/);
  assert.match(sql, /tenant_id=\$2/);
  assert.match(sql, /status='pending'/);
});

test('revokePendingCode refuses keys that are already bound or gone', async () => {
  const boundPool = buildFakePool({
    'SELECT id, tenant_id, code, status': () => ({
      rows: [{ id: 56, tenant_id: 7, code: 'BIND-BOUND001', status: 'bound' }],
    }),
  });
  const bound = await lb.revokePendingCode(boundPool, { tenantId: 7, bindingId: 56 });
  assert.equal(bound.ok, false);
  assert.equal(bound.reason, 'not_pending');
  assert.equal(bound.status, 'bound');
  assert.equal(boundPool._calls.some((c) => c.sql.includes('UPDATE line_bindings')), false);

  const missingPool = buildFakePool({
    'SELECT id, tenant_id, code, status': () => ({ rows: [] }),
  });
  const missing = await lb.revokePendingCode(missingPool, { tenantId: 7, bindingId: 999 });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'not_found');
});

test('CODE_PREFIX is BIND-', () => {
  assert.equal(lb.CODE_PREFIX, 'BIND-');
});

// ===== Multi-OA tests ======================================================

test('issue: rejects targetOaId pointing to non-existent OA', async () => {
  const pool = buildFakePool({
    'SELECT id, full_name': () => ({
      rows: [{ id: 1, full_name: 'X', line_binding_blocked: false, status: 'active', current_room_id: '101' }],
    }),
    'SELECT id, enabled FROM line_oas': () => ({ rows: [] }),
  });
  await assert.rejects(
    () => lb.issue(pool, { tenantId: 1, ttlDays: 7, targetOaId: 999 }),
    /OA ที่เลือกไม่มี/
  );
});

test('issue: targetOaId=0 is treated as "any OA" (legacy env)', async () => {
  const pool = buildFakePool({
    'SELECT id, full_name': () => ({
      rows: [{ id: 1, full_name: 'X', line_binding_blocked: false, status: 'active', current_room_id: '101' }],
    }),
    'INSERT INTO line_bindings': () => ({ rows: [{ id: 1, code: 'BIND-AAAA0000', expires_at: new Date(), target_oa_id: null }] }),
  });
  // Should not call SELECT line_oas because 0 = any-OA
  const out = await lb.issue(pool, { tenantId: 1, ttlDays: 7, targetOaId: 0 });
  assert.equal(out.targetOaId, null);
  const calledOaCheck = pool._calls.some((c) => c.sql.includes('SELECT id, enabled FROM line_oas'));
  assert.equal(calledOaCheck, false, 'should skip OA validation when targetOaId=0');
});

test('tryBind: enforces target_oa_id when set on the binding', async () => {
  const pool = buildFakePool({
    'FROM line_bindings b': () => ({
      rows: [{
        id: 1, tenant_id: 5, status: 'pending',
        target_oa_id: 7,    // code was issued for OA #7
        expires_at: new Date(Date.now() + 86400000),
        full_name: 'X', current_room_id: '101', tenant_status: 'active',
        line_binding_blocked: false,
      }],
    }),
  });
  // Tenant sent the code to OA #3 (wrong target)
  const r = await lb.tryBind(pool, { code: 'BIND-DEADBEEF', lineUserId: 'U1', oaId: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrong_oa');
  assert.equal(r.expectedOaId, 7);
});

test('tryBind: dedup is per-OA (same userId on different OAs is OK)', async () => {
  // Scenario: tenant 5 has pending code; SAME LINE userId already bound to
  // tenant 99 — but that bind is on a different OA (oa_id=2 vs current oa=5).
  // Should NOT collide because LINE userIds are scoped per-OA.
  const pool = buildFakePool({
    'FROM line_bindings b': () => ({
      rows: [{
        id: 1, tenant_id: 5, status: 'pending',
        target_oa_id: null,
        expires_at: new Date(Date.now() + 86400000),
        full_name: 'X', current_room_id: '101', tenant_status: 'active',
        line_binding_blocked: false,
      }],
    }),
    // The dedup query is scoped to oa_id matching, so no other bound row found
    "WHERE line_user_id=$1": () => ({ rows: [] }),
  });
  const r = await lb.tryBind(pool, { code: 'BIND-DEADBEEF', lineUserId: 'Uabc', oaId: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.oaId, 5);
});

test('tryBind: records oa_id on success', async () => {
  const pool = buildFakePool({
    'FROM line_bindings b': () => ({
      rows: [{
        id: 1, tenant_id: 5, status: 'pending', target_oa_id: null,
        expires_at: new Date(Date.now() + 86400000),
        full_name: 'A', current_room_id: '201', tenant_status: 'active',
        line_binding_blocked: false,
      }],
    }),
    "WHERE line_user_id=$1": () => ({ rows: [] }),
  });
  await lb.tryBind(pool, { code: 'BIND-DEADBEEF', lineUserId: 'U1', oaId: 42 });
  // Find the UPDATE line_bindings ... SET ... oa_id=$2 call
  const updateBinding = pool._calls.find((c) =>
    c.sql.includes('UPDATE line_bindings') && c.sql.includes('oa_id'));
  assert.ok(updateBinding, 'should UPDATE line_bindings with oa_id');
  // Find the UPDATE tenants ... line_oa_id=$2
  const updateTenant = pool._calls.find((c) =>
    c.sql.replace(/\s+/g, ' ').includes('UPDATE tenants') &&
    c.sql.includes('line_oa_id'));
  assert.ok(updateTenant, 'should UPDATE tenants with line_oa_id');
});
