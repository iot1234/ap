// tests/rateLimit.test.js
//   node --test tests/rateLimit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeIpLimiter, clientIp } = require('../middleware/rateLimit');

function fakeReqRes(ip = '1.2.3.4', headers = {}) {
  const setHeaders = {};
  return {
    req: { ip, headers, method: 'POST' },
    res: {
      setHeader: (k, v) => { setHeaders[k] = v; },
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
      get headers() { return setHeaders; },
    },
  };
}

test('allows up to max within window', () => {
  const lim = makeIpLimiter({ windowMs: 60_000, max: 3 });
  let nextCalls = 0;
  const next = () => { nextCalls++; };
  for (let i = 0; i < 3; i++) {
    const { req, res } = fakeReqRes();
    lim(req, res, next);
  }
  assert.equal(nextCalls, 3);
});

test('blocks the (max+1)th request with 429', () => {
  const lim = makeIpLimiter({ windowMs: 60_000, max: 2 });
  const next = () => {};
  let last;
  for (let i = 0; i < 3; i++) {
    const f = fakeReqRes();
    lim(f.req, f.res, next);
    last = f.res;
  }
  assert.equal(last.statusCode, 429);
  assert.equal(last.body.code, 'RATE_LIMIT');
});

test('rate-limit headers exposed', () => {
  const lim = makeIpLimiter({ windowMs: 60_000, max: 5 });
  const f = fakeReqRes();
  lim(f.req, f.res, () => {});
  assert.equal(f.res.headers['X-RateLimit-Limit'], 5);
  assert.equal(f.res.headers['X-RateLimit-Remaining'], 4);
});

test('clientIp prefers req.ip', () => {
  assert.equal(clientIp({ ip: '1.1.1.1', headers: { 'x-forwarded-for': '2.2.2.2' } }), '1.1.1.1');
});
test('clientIp falls back to first XFF entry', () => {
  assert.equal(clientIp({ ip: null, headers: { 'x-forwarded-for': '5.5.5.5, 6.6.6.6' } }), '5.5.5.5');
});
test('clientIp returns null when nothing available', () => {
  assert.equal(clientIp({ headers: {} }), null);
});
