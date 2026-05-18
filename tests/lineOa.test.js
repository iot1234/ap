// tests/lineOa.test.js
//   node --test tests/lineOa.test.js
//
// Pure-function + mocked-pool tests for services/lineOa.js. Encryption uses a
// real key set via env (HKDF fallback from SESSION_SECRET) so the round-trip
// works without depending on services/secrets DB state.

const test = require('node:test');
const assert = require('node:assert/strict');

// Provide a deterministic 32-byte key so encryption.encryptString round-trips
// without depending on NODE_ENV / DB state. Same approach as crypto.test.js.
process.env.CITIZEN_ID_KEY = process.env.CITIZEN_ID_KEY ||
  Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET = process.env.SESSION_SECRET ||
  'a'.repeat(48);

const lineOa = require('../services/lineOa');
const line = require('../services/line');

function buildFakePool(scenarios = {}) {
  const calls = [];
  async function query(sql, params) {
    calls.push({ sql: sql.trim(), params });
    for (const [pattern, fn] of Object.entries(scenarios)) {
      if (sql.includes(pattern)) return fn(sql, params);
    }
    return { rows: [], rowCount: 0 };
  }
  async function connect() {
    return { query, release() {} };
  }
  return { query, connect, _calls: calls };
}

// ---- slug helpers --------------------------------------------------------

test('normalizeSlug: lowercases + strips non-allowed chars', () => {
  assert.equal(lineOa.normalizeSlug('Main OA #1'), 'main-oa-1');
  assert.equal(lineOa.normalizeSlug('Branch_2'), 'branch_2');
  assert.equal(lineOa.normalizeSlug('  weird/path/!! '), 'weird-path');
});

test('isValidSlug: 2-40 chars, allows alnum + _ -', () => {
  assert.equal(lineOa.isValidSlug('main'), true);
  assert.equal(lineOa.isValidSlug('a1'), true);
  assert.equal(lineOa.isValidSlug('a'), false);          // too short
  assert.equal(lineOa.isValidSlug(''), false);
  assert.equal(lineOa.isValidSlug('-bad'), false);       // starts with -
  assert.equal(lineOa.isValidSlug('bad-'), false);       // ends with -
  assert.equal(lineOa.isValidSlug('a'.repeat(41)), false);
});

test('LINE add-friend URL helpers accept only LINE HTTPS links', () => {
  assert.equal(lineOa.normaliseLineAddUrl('https://lin.ee/abc123'), 'https://lin.ee/abc123');
  assert.equal(lineOa.normaliseLineAddUrl('https://line.me/R/ti/p/@demo'), 'https://line.me/R/ti/p/@demo');
  assert.equal(lineOa.normaliseLineAddUrl('http://line.me/R/ti/p/@demo'), null);
  assert.equal(lineOa.normaliseLineAddUrl('javascript:alert(1)'), null);
  assert.equal(lineOa.normaliseLineAddUrl('https://example.com/line'), null);
  assert.equal(lineOa.buildLineAddUrl('@baankarn'), 'https://line.me/R/ti/p/@baankarn');
  assert.equal(lineOa.buildLineAddUrl('baankarn'), 'https://line.me/R/ti/p/@baankarn');
});

test('LINE OA message URL helper opens chat with optional prefilled key', () => {
  assert.equal(
    lineOa.buildLineOaMessageUrl('@baankarn'),
    'https://line.me/R/oaMessage/%40baankarn/'
  );
  assert.equal(
    lineOa.buildLineOaMessageUrl('baankarn', 'BIND-ABCD1234'),
    'https://line.me/R/oaMessage/%40baankarn/?BIND-ABCD1234'
  );
  assert.equal(lineOa.buildLineOaMessageUrl('bad/id', 'BIND-ABCD1234'), null);
});

// ---- list / getById / getDefault: env fallback --------------------------

test('list: returns env OA when DB empty + env vars set', async () => {
  // Set env-OA env vars so secrets.get() returns them
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'env-token-xxx';
  process.env.LINE_CHANNEL_SECRET = 'env-secret';
  const pool = buildFakePool({
    'FROM line_oas': () => ({ rows: [] }),
  });
  const items = await lineOa.list(pool);
  assert.equal(items.length, 1, 'env OA should be exposed when DB has nothing');
  assert.equal(items[0].id, 0);
  assert.equal(items[0].isEnvOa, true);
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  delete process.env.LINE_CHANNEL_SECRET;
});

test('list: returns DB OAs when present', async () => {
  const pool = buildFakePool({
    'FROM line_oas': () => ({
      rows: [{
        id: 1, slug: 'main', name: 'Main', enabled: true, is_default: true,
        created_at: new Date(), updated_at: new Date(),
      }],
    }),
  });
  const items = await lineOa.list(pool);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 1);
  assert.equal(items[0].slug, 'main');
});

test('list: uses live tenant-linked count and exposes stale counter drift', async () => {
  const lastBoundAt = new Date();
  const pool = buildFakePool({
    'FROM line_oas o': () => ({
      rows: [{
        id: 1, slug: 'main', name: 'Main', enabled: true, is_default: true,
        bound_count: 1,
        tenant_linked_count: 2,
        binding_bound_count: 3,
        pending_count: 4,
        last_bound_at: lastBoundAt,
        created_at: new Date(), updated_at: new Date(),
      }],
    }),
  });
  const items = await lineOa.list(pool);
  assert.equal(items[0].boundCount, 2);
  assert.equal(items[0].tenantLinkedCount, 2);
  assert.equal(items[0].bindingBoundCount, 3);
  assert.equal(items[0].storedBoundCount, 1);
  assert.equal(items[0].pendingCount, 4);
  assert.equal(items[0].counterDrift, 1);
  assert.equal(items[0].bindingMismatch, -1);
  assert.equal(items[0].hasCountDrift, true);
  assert.equal(items[0].hasBindingMismatch, true);
  assert.equal(items[0].lastBoundAt, lastBoundAt);
});

test('getBindingStats: returns current linked tenants, binding rows, and pending codes', async () => {
  const lastBoundAt = new Date();
  const pool = buildFakePool({
    'tenant_linked_count': (_sql, params) => {
      assert.deepEqual(params, [7]);
      return {
        rows: [{
          tenant_linked_count: '5',
          binding_bound_count: '4',
          pending_count: '2',
          stored_bound_count: '3',
          last_bound_at: lastBoundAt,
        }],
      };
    },
  });
  const stats = await lineOa.getBindingStats(pool, 7);
  assert.equal(stats.boundCount, 5);
  assert.equal(stats.tenantLinkedCount, 5);
  assert.equal(stats.bindingBoundCount, 4);
  assert.equal(stats.pendingCount, 2);
  assert.equal(stats.storedBoundCount, 3);
  assert.equal(stats.counterDrift, 2);
  assert.equal(stats.bindingMismatch, 1);
  assert.equal(stats.hasCountDrift, true);
  assert.equal(stats.hasBindingMismatch, true);
  assert.equal(stats.lastBoundAt, lastBoundAt);
});

test('getById(0) returns env OA without hitting DB', async () => {
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'env-token-xxx';
  let dbCalled = false;
  const pool = {
    query: async () => { dbCalled = true; return { rows: [] }; },
    connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
  };
  const oa = await lineOa.getById(pool, 0);
  assert.ok(oa);
  assert.equal(oa.id, 0);
  assert.equal(dbCalled, false);
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
});

test('getDefault: prefers DB row with is_default=TRUE', async () => {
  const pool = buildFakePool({
    'FROM line_oas': () => ({
      rows: [{
        id: 7, slug: 'main', name: 'Main', enabled: true, is_default: true,
        created_at: new Date(), updated_at: new Date(),
      }],
    }),
  });
  const oa = await lineOa.getDefault(pool);
  assert.equal(oa.id, 7);
  assert.equal(oa.slug, 'main');
});

test('resolveForTenant(null) returns env OA', async () => {
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'env-token-xxx';
  const pool = buildFakePool();
  const oa = await lineOa.resolveForTenant(pool, null);
  assert.ok(oa);
  assert.equal(oa.isEnvOa, true);
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
});

// ---- create / update validation -----------------------------------------

test('create: rejects bad slug', async () => {
  const pool = buildFakePool();
  await assert.rejects(
    () => lineOa.create(pool, { slug: 'a', name: 'X' }, 'admin'),
    /slug ไม่ถูกต้อง/
  );
});

test('create: requires name', async () => {
  const pool = buildFakePool();
  await assert.rejects(
    () => lineOa.create(pool, { slug: 'main' }, 'admin'),
    /name required/
  );
});

test('create: encrypts tokens before insert', async () => {
  const pool = buildFakePool({
    'INSERT INTO line_oas': (_sql, params) => ({
      rows: [{
        id: 1, slug: 'main', name: 'Main', enabled: true, is_default: false,
        created_at: new Date(), updated_at: new Date(),
        channel_access_token_encrypted: params[6],   // capture encrypted token
        channel_secret_encrypted: params[5],
      }],
    }),
  });
  const oa = await lineOa.create(pool, {
    slug: 'main', name: 'Main',
    channelAccessToken: 'plaintext-token',
    channelSecret: 'plaintext-secret',
  }, 'admin');
  assert.ok(oa);
  // Find the insert call's params
  const insertCall = pool._calls.find((c) => c.sql.startsWith('INSERT INTO line_oas'));
  assert.ok(insertCall);
  // params[6] is access token, params[5] is secret per the SQL column order
  assert.notEqual(insertCall.params[6], 'plaintext-token', 'token must be encrypted');
  assert.notEqual(insertCall.params[5], 'plaintext-secret', 'secret must be encrypted');
});

test('create: rejects non-LINE add friend URLs', async () => {
  const pool = buildFakePool();
  await assert.rejects(
    () => lineOa.create(pool, {
      slug: 'main',
      name: 'Main',
      addFriendUrl: 'https://example.com/not-line',
    }, 'admin'),
    /LINE add friend URL/
  );
});

// ---- HMAC verify --------------------------------------------------------

test('verifyWebhookSignature: matches HMAC over rawBody', () => {
  const crypto = require('crypto');
  const secret = 'my-channel-secret';
  const body = JSON.stringify({ events: [] });
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64');
  const oa = { channelSecret: secret };
  assert.equal(lineOa.verifyWebhookSignature(oa, body, sig), true);
  assert.equal(lineOa.verifyWebhookSignature(oa, body, 'wrong'), false);
  assert.equal(lineOa.verifyWebhookSignature(null, body, sig), false);
  assert.equal(lineOa.verifyWebhookSignature(oa, body, null), false);
});

// ---- line.js multi-OA dispatch ------------------------------------------

test('line._resolveOa: returns passed OA when shape is valid', () => {
  const oa = { channelAccessToken: 'tok', slug: 'main' };
  const r = line._resolveOa(oa);
  assert.equal(r.channelAccessToken, 'tok');
});

test('line._resolveOa: falls back to env when no OA passed', () => {
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'env-token-fallback';
  const r = line._resolveOa(null);
  assert.ok(r);
  assert.equal(r.channelAccessToken, 'env-token-fallback');
  assert.equal(r.isEnvOa, true);
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
});

test('line.verifyWebhookSignature: per-OA path uses oa.channelSecret', () => {
  const crypto = require('crypto');
  const secret = 'oa-specific-secret';
  const body = '{}';
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64');
  const oa = { channelSecret: secret };
  assert.equal(line.verifyWebhookSignature(oa, body, sig), true);
  // Wrong-secret case
  assert.equal(
    line.verifyWebhookSignature({ channelSecret: 'other' }, body, sig),
    false
  );
});
