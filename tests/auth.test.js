// tests/auth.test.js
// Unit tests for the bits of auth that don't need an HTTP server:
// role-rank middleware behaviour.
//   node --test tests/auth.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// === Role rank ============================================================
const { makeAuth, ROLE_RANK } = require('../middleware/auth');
test('owner outranks staff', () => {
  assert.ok(ROLE_RANK.owner > ROLE_RANK.staff);
});
test('readonly is the lowest', () => {
  assert.ok(ROLE_RANK.readonly < ROLE_RANK.staff);
  assert.ok(ROLE_RANK.readonly < ROLE_RANK.manager);
  assert.ok(ROLE_RANK.readonly < ROLE_RANK.owner);
});

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function reqWithSecuritySink(overrides = {}) {
  const events = [];
  const req = {
    method: 'GET',
    url: '/api/admin/users',
    originalUrl: '/api/admin/users',
    app: {
      get(name) {
        if (name !== 'securityEvent') return null;
        return (_req, action, detail) => { events.push({ action, detail }); };
      },
    },
    ...overrides,
  };
  return { req, events };
}

test('requireAuth records unauthorized admin access attempts', async () => {
  const { requireAuth } = makeAuth({ query: async () => ({ rows: [] }) });
  const { req, events } = reqWithSecuritySink({ session: null });
  const res = fakeRes();
  let nextCalled = false;
  await requireAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'security.admin_unauthorized');
  assert.equal(events[0].detail.reason, 'missing_admin_session');
});

test('requireRole records forbidden role attempts', async () => {
  const { requireRole } = makeAuth({ query: async () => ({ rows: [] }) });
  const { req, events } = reqWithSecuritySink({
    session: { user: { username: 'viewer', role: 'readonly' } },
  });
  const res = fakeRes();
  let nextCalled = false;
  await requireRole('owner', 'manager')(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'security.admin_forbidden_role');
  assert.equal(events[0].detail.actual, 'readonly');
});

test('requireDeviceOrAdmin records rejected bearer token attempts', async () => {
  const pool = { query: async () => ({ rows: [] }) };
  const { requireDeviceOrAdmin } = makeAuth(pool);
  const { req, events } = reqWithSecuritySink({
    headers: { authorization: 'Bearer wrong-token' },
    method: 'POST',
    url: '/api/access/log',
    originalUrl: '/api/access/log',
  });
  const res = fakeRes();
  let nextCalled = false;
  await requireDeviceOrAdmin(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'security.device_token_rejected');
  assert.equal(events[0].detail.reason, 'hash_not_found_or_disabled');
});
