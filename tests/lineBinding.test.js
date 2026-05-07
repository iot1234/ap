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

test('generateCode produces BIND- prefix + 8 hex', () => {
  const c = lb.generateCode();
  assert.match(c, /^BIND-[A-F0-9]{8}$/);
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

test('issue: revokes prior pending then creates new', async () => {
  const pool = buildFakePool({
    'SELECT id, full_name': () => ({ rows: [{ id: 1, full_name: 'X', line_binding_blocked: false }] }),
    'INSERT INTO line_bindings': () => ({ rows: [{ id: 42, code: 'BIND-AAAAAAAA', expires_at: new Date() }] }),
  });
  const out = await lb.issue(pool, { tenantId: 1, ttlDays: 7, createdBy: 'admin' });
  assert.equal(out.id, 42);
  assert.match(out.code, /^BIND-/);
  // Verify the revoke step happened before insert
  const sequence = pool._calls.map((c) => c.sql);
  const revokeIdx = sequence.findIndex((s) => s.startsWith('UPDATE line_bindings SET status='));
  const insertIdx = sequence.findIndex((s) => s.startsWith('INSERT INTO line_bindings'));
  assert.ok(revokeIdx >= 0 && insertIdx > revokeIdx, 'revoke should come before insert');
});

test('tryBind: invalid format returns ok=false', async () => {
  const pool = buildFakePool();
  const r = await lb.tryBind(pool, { code: 'XYZ123', lineUserId: 'U1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
});

test('tryBind: unknown code returns invalid', async () => {
  const pool = buildFakePool({
    'FROM line_bindings b JOIN tenants': () => ({ rows: [] }),
  });
  const r = await lb.tryBind(pool, { code: 'BIND-DEADBEEF', lineUserId: 'U1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
});

test('tryBind: blocked tenant returns tenant_blocked', async () => {
  const pool = buildFakePool({
    'FROM line_bindings b JOIN tenants': () => ({
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
    'FROM line_bindings b JOIN tenants': () => ({
      rows: [{
        id: 1, tenant_id: 5, status: 'pending',
        expires_at: new Date(Date.now() - 86400000), // yesterday
        full_name: 'X', current_room_id: '101',
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
    'FROM line_bindings b JOIN tenants': () => ({
      rows: [{
        id: 1, tenant_id: 5, status: 'bound',
        expires_at: new Date(Date.now() + 86400000),
        full_name: 'X', current_room_id: '101',
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
    'FROM line_bindings b JOIN tenants': () => ({
      rows: [{
        id: 1, tenant_id: 5, status: 'pending',
        expires_at: new Date(Date.now() + 86400000),
        full_name: 'X', current_room_id: '101',
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
    'FROM line_bindings b JOIN tenants': () => ({
      rows: [{
        id: 1, tenant_id: 5, status: 'pending',
        expires_at: new Date(Date.now() + 86400000),
        full_name: 'Mr. T', current_room_id: '305',
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
});

test('CODE_PREFIX is BIND-', () => {
  assert.equal(lb.CODE_PREFIX, 'BIND-');
});
