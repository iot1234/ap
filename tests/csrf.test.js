const test = require('node:test');
const assert = require('node:assert/strict');

const { makeCsrf } = require('../middleware/csrf');

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    cookies: {},
    cookie(name, value) {
      this.cookies[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('csrfErrorHandler maps message-shaped invalid CSRF errors to 403 JSON', () => {
  const csrf = makeCsrf({ secret: 'test-secret-for-csrf-handler', secure: false });
  const res = fakeRes();
  let nextErr = null;

  csrf.csrfErrorHandler(new Error('invalid csrf token'), {}, res, (err) => {
    nextErr = err;
  });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, {
    error: 'invalid CSRF token',
    code: 'CSRF_INVALID',
  });
});

test('csrfErrorHandler preserves unrelated errors for the global handler', () => {
  const csrf = makeCsrf({ secret: 'test-secret-for-csrf-handler', secure: false });
  const res = fakeRes();
  const err = new Error('database down');
  let nextErr = null;

  csrf.csrfErrorHandler(err, {}, res, (e) => {
    nextErr = e;
  });

  assert.equal(nextErr, err);
  assert.equal(res.statusCode, null);
});

test('token endpoint (overwrite=false) is idempotent so two client caches do not invalidate each other', () => {
  // Regression: api-client.js and hooks.jsx each keep their own CSRF token
  // cache, both fetched from GET /api/csrf-token. When that endpoint used
  // overwrite=true it rotated the shared cookie on every call, so the second
  // cache's fetch invalidated the first cache's token -> a follow-up request
  // (e.g. activity-log PUT after a notify send) failed with HTTP 403.
  const csrf = makeCsrf({ secret: 'test-secret-for-csrf-handler', secure: false });

  // First fetch (e.g. api-client) — no cookie yet, mints a fresh pair.
  const res1 = fakeRes();
  const req1 = { headers: {}, cookies: {}, ip: '127.0.0.1' };
  const tokenA = csrf.generateCsrfToken(req1, res1, false, false);
  const cookieA = res1.cookies['csrf-token'];

  // Second fetch (e.g. hooks.jsx apiFetch) — same session, existing cookie
  // present. With overwrite=false it must REUSE the cookie and return the
  // same token rather than rotating it.
  const res2 = fakeRes();
  const req2 = { headers: {}, cookies: { 'csrf-token': cookieA }, ip: '127.0.0.1' };
  const tokenB = csrf.generateCsrfToken(req2, res2, false, false);

  assert.equal(tokenB, tokenA, 'second fetch must return the same token');
  assert.equal(res2.cookies['csrf-token'], cookieA, 'second fetch must not rotate the cookie');
});

test('generateCsrfToken overwrite refreshes token when session identifier changes', () => {
  const csrf = makeCsrf({ secret: 'test-secret-for-csrf-handler', secure: false });
  const anonReq = { headers: {}, cookies: {}, ip: '127.0.0.1' };
  const anonRes = fakeRes();
  csrf.generateCsrfToken(anonReq, anonRes);

  const tenantReq = {
    headers: { cookie: 'tenant_sid=tenant-session-raw-value' },
    cookies: { 'csrf-token': anonRes.cookies['csrf-token'] },
    ip: '127.0.0.1',
  };
  const tenantRes = fakeRes();

  assert.throws(() => csrf.generateCsrfToken(tenantReq, tenantRes), /invalid csrf token/);
  assert.doesNotThrow(() => csrf.generateCsrfToken(tenantReq, tenantRes, true));
  assert.ok(tenantRes.cookies['csrf-token']);
});
