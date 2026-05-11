const test = require('node:test');
const assert = require('node:assert/strict');

const { makeCsrf } = require('../middleware/csrf');

function fakeRes() {
  return {
    statusCode: null,
    body: null,
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
