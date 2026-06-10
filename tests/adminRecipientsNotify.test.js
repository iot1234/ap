// tests/adminRecipientsNotify.test.js
// Multi-admin notification recipients — unlimited staff LINE accounts that
// receive every system alert alongside the legacy owner contact, with
// enable/disable (mute), relabel, terminal revoke, and re-issue via fresh
// ADMIN-XXXXXXXX codes. Plus the event-coverage additions: payment received
// (3 admin paths), move-in (check-in), move-out (checkout).
//   node --test tests/adminRecipientsNotify.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const adminRecipients = require('../services/adminRecipients');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// === Service behaviour (stub pool — no DB) ==================================

test('code namespace is ADMIN-{8 hex} and never collides with OWNER-/BIND-', () => {
  const code = adminRecipients.generateCode();
  assert.match(code, /^ADMIN-[A-F0-9]{8}$/);
  assert.ok(adminRecipients.isClaimCode('admin-deadbeef'), 'case-insensitive');
  assert.ok(!adminRecipients.isClaimCode('OWNER-DEADBEEF'), 'owner namespace excluded');
  assert.ok(!adminRecipients.isClaimCode('BIND-DEADBEEF'), 'tenant namespace excluded');
  assert.ok(!adminRecipients.isClaimCode('ADMIN-XYZ'), 'wrong shape rejected');
});

test('maskLineUserId never exposes the full id', () => {
  assert.equal(adminRecipients.maskLineUserId('U4af4980629abcdef0123456789abcdef'), 'U4af…abcdef');
  assert.equal(adminRecipients.maskLineUserId('short'), '...hort');
  assert.equal(adminRecipients.maskLineUserId(''), '');
});

function stubClient(handlers) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [re, result] of handlers) {
        if (re.test(sql)) return typeof result === 'function' ? result(sql, params) : result;
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
}

test('tryClaim: valid pending token creates an enabled recipient + consumes the token', async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const client = stubClient([
    [/SELECT id, status, oa_id, label, expires_at/i,
      { rows: [{ id: 7, status: 'pending', oa_id: 2, label: 'ผู้จัดการ เอ', expires_at: future }] }],
    [/SELECT id, enabled FROM admin_line_recipients/i, { rows: [] }],
    [/INSERT INTO admin_line_recipients/i, { rows: [{ id: 99 }] }],
  ]);
  const pool = { connect: async () => client };
  const out = await adminRecipients.tryClaim(pool, {
    code: 'ADMIN-DEADBEEF', lineUserId: 'U1234567890abcdef1234567890abcdef', oaId: 2,
  });
  assert.equal(out.ok, true);
  assert.equal(out.recipientId, 99);
  assert.equal(out.label, 'ผู้จัดการ เอ');
  assert.equal(out.already, false);
  const sqls = client.calls.map((c) => c.sql).join('\n');
  assert.match(sqls, /INSERT INTO admin_line_recipients/);
  assert.match(sqls, /SET status='claimed'/, 'token must be single-use');
  assert.match(sqls, /COMMIT/);
});

test('tryClaim: re-typing a code while already active is idempotent (re-enables, no dup row)', async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const client = stubClient([
    [/SELECT id, status, oa_id, label, expires_at/i,
      { rows: [{ id: 8, status: 'pending', oa_id: null, label: null, expires_at: future }] }],
    [/SELECT id, enabled FROM admin_line_recipients/i, { rows: [{ id: 55, enabled: false }] }],
  ]);
  const pool = { connect: async () => client };
  const out = await adminRecipients.tryClaim(pool, {
    code: 'ADMIN-CAFEBABE', lineUserId: 'U1234567890abcdef1234567890abcdef', oaId: null,
  });
  assert.equal(out.ok, true);
  assert.equal(out.already, true);
  assert.equal(out.recipientId, 55);
  const sqls = client.calls.map((c) => c.sql).join('\n');
  assert.match(sqls, /UPDATE admin_line_recipients[\s\S]*enabled = TRUE/,
    're-claim must re-enable a muted binding');
  assert.doesNotMatch(sqls, /INSERT INTO admin_line_recipients/,
    'no duplicate active row for the same (OA, LINE account)');
});

test('tryClaim: expired / used / revoked / wrong-OA codes are refused', async () => {
  const mk = (row) => ({ connect: async () => stubClient([
    [/SELECT id, status, oa_id, label, expires_at/i, { rows: row ? [row] : [] }],
  ]) });
  assert.equal((await adminRecipients.tryClaim(mk(null), { code: 'ADMIN-00000000', lineUserId: 'Ux', oaId: 1 })).reason, 'invalid');
  assert.equal((await adminRecipients.tryClaim(
    mk({ id: 1, status: 'claimed', oa_id: 1, expires_at: new Date(Date.now() + 9e5).toISOString() }),
    { code: 'ADMIN-00000001', lineUserId: 'Uxxxxx', oaId: 1 })).reason, 'already_used');
  assert.equal((await adminRecipients.tryClaim(
    mk({ id: 2, status: 'revoked', oa_id: 1, expires_at: new Date(Date.now() + 9e5).toISOString() }),
    { code: 'ADMIN-00000002', lineUserId: 'Uxxxxx', oaId: 1 })).reason, 'revoked');
  assert.equal((await adminRecipients.tryClaim(
    mk({ id: 3, status: 'pending', oa_id: 1, expires_at: new Date(Date.now() - 1000).toISOString() }),
    { code: 'ADMIN-00000003', lineUserId: 'Uxxxxx', oaId: 1 })).reason, 'expired');
  assert.equal((await adminRecipients.tryClaim(
    mk({ id: 4, status: 'pending', oa_id: 9, expires_at: new Date(Date.now() + 9e5).toISOString() }),
    { code: 'ADMIN-00000004', lineUserId: 'Uxxxxx', oaId: 2 })).reason, 'wrong_oa');
});

test('listActiveRecipients fails soft on pre-migration deploys (42P01 → [])', async () => {
  const pool = { query: async () => { const e = new Error('no table'); e.code = '42P01'; throw e; } };
  assert.deepEqual(await adminRecipients.listActiveRecipients(pool), []);
});

// === Per-recipient notification categories ==================================

test('CATEGORIES catalog covers the operational event families', () => {
  const keys = adminRecipients.CATEGORIES.map((c) => c.key);
  assert.deepEqual(keys,
    ['booking', 'payment', 'billing', 'tenancy', 'maintenance', 'security', 'system']);
  for (const c of adminRecipients.CATEGORIES) {
    assert.ok(c.label && c.desc, `${c.key} must carry operator-facing label + desc`);
  }
});

test('validateMutedCategories: whitelists, dedupes, and names every bad key', () => {
  const ok = adminRecipients.validateMutedCategories(['payment', 'payment', 'booking']);
  assert.deepEqual(ok, { ok: true, list: ['payment', 'booking'] });
  assert.deepEqual(adminRecipients.validateMutedCategories(null), { ok: true, list: [] });
  assert.deepEqual(adminRecipients.validateMutedCategories(undefined), { ok: true, list: [] });
  const bad = adminRecipients.validateMutedCategories(['payment', 'paymnt', 'DROP TABLE', 42]);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.invalid, ['paymnt', 'DROP TABLE', '42']);
  assert.equal(adminRecipients.validateMutedCategories('payment').ok, false,
    'a bare string is not an array — rejected, not coerced');
});

test('wantsCategory: mute semantics with fail-open defences', () => {
  assert.equal(adminRecipients.wantsCategory([], 'payment'), true, 'empty mute = everything');
  assert.equal(adminRecipients.wantsCategory(['payment'], 'payment'), false, 'muted category filtered');
  assert.equal(adminRecipients.wantsCategory(['payment'], 'booking'), true, 'others unaffected');
  // A typo'd category at a CALL SITE normalises to 'system' — the alert
  // still goes out (to everyone not muting 'system') instead of vanishing.
  assert.equal(adminRecipients.wantsCategory([], 'paymnt-typo'), true);
  assert.equal(adminRecipients.wantsCategory(['system'], 'paymnt-typo'), false,
    'unknown categories ride the system channel');
  // Malformed muted list from a manual DB edit → deliver (fail-open).
  assert.equal(adminRecipients.wantsCategory('garbage', 'payment'), true);
  assert.equal(adminRecipients.wantsCategory(null, 'payment'), true);
});

test('setMutedCategories re-validates at the DB layer (defence in depth)', async () => {
  await assert.rejects(
    () => adminRecipients.setMutedCategories({ query: async () => ({ rows: [] }) }, 1, ['nope']),
    (err) => err.code === 'INVALID_CATEGORIES'
  );
});

test('notifyOwner filters admin recipients by category — legacy owner never filtered', () => {
  const src = read('services', 'notifier.js');
  assert.match(src, /const category = msg\.category \|\| 'system'/,
    'untagged call sites ride the system channel');
  assert.match(src, /wantsCategory\(r\.muted_categories, category\)/,
    'per-recipient mute applied while building the target list');
  const ownerIdx = src.indexOf("addTarget(lineOwner, null, 'owner')");
  const filterIdx = src.indexOf('wantsCategory(r.muted_categories');
  assert.ok(ownerIdx > 0 && filterIdx > ownerIdx,
    'owner target added unconditionally BEFORE the filtered admin loop');
});

test('every notifyOwner call site is category-tagged', () => {
  const files = [
    'server.js', 'routes/bills-extras.js', 'routes/tenant-ops.js',
    'routes/webhooks.js', 'services/scheduler.js', 'services/billPayments.js',
    'services/storage.js', 'services/anomalyDetector.js',
  ];
  for (const f of files) {
    const src = read(...f.split('/'));
    // Each notifyOwner message object must carry a category within the
    // next few lines (or via the {category, ...msg} passthrough form).
    const re = /notifyOwner\((?:\{ pool[^}]*\}|ctx), \{/g;
    let m;
    while ((m = re.exec(src))) {
      const window = src.slice(m.index, m.index + 400);
      assert.match(window, /category(?::| ?')/,
        `${f} @${m.index}: notifyOwner call missing category tag`);
    }
  }
});

test('PUT endpoint validates categories against the same whitelist the UI renders', () => {
  const server = read('server.js');
  assert.match(server, /validateMutedCategories\(req\.body\.mutedCategories\)/);
  assert.match(server, /code: 'INVALID_CATEGORIES'/);
  assert.match(server, /allowed: adminRecipients\.CATEGORIES\.map\(\(c\) => c\.key\)/,
    '400 names the allowed keys so a stale UI self-explains');
  assert.match(server, /categories: adminRecipients\.CATEGORIES/,
    'GET list ships the catalog — UI renders chips from the server whitelist');
  assert.match(server, /line\.admin_recipient\.categories/,
    'category changes audited');
});

test('migration adds muted_categories with fail-open default', () => {
  const mig = read('db', 'migrate.js');
  assert.match(mig, /ADD COLUMN IF NOT EXISTS muted_categories JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
});

test('recipients card renders per-category bell chips', () => {
  const page = read('project', 'admin', 'page-line-oas.jsx');
  assert.match(page, /toggleCategory/, 'chip click toggles one category');
  assert.match(page, /mutedCategories: next/, 'full-list replace semantics');
  assert.match(page, /🔔/, 'receiving state visible');
  assert.match(page, /🔕/, 'muted state visible');
  assert.match(page, /รับทุกหมวด/, 'summary pill for the default state');
});

// === Notifier fan-out =======================================================

test('notifyOwner fans out to every enabled admin recipient + legacy owner, deduped', () => {
  const src = read('services', 'notifier.js');
  assert.match(src, /adminRecipients\.listActiveRecipients\(pool\)/,
    'owner alerts must load the multi-admin recipient set');
  assert.match(src, /addTarget\(lineOwner, null, 'owner'\)/,
    'legacy single owner contact must stay first-class');
  assert.match(src, /seen\.has\(key\)/,
    'an owner who also bound as admin recipient gets ONE message, not two');
  assert.match(src, /recipients: lineSent, failedRecipients: lineFailed/,
    'callers can see the fan-out result');
  assert.match(src, /queueCandidates\.push\(\{ target, oa \}\)/,
    'transient per-recipient failures must be re-queued (stragglers not dropped)');
  assert.match(src, /if \(lineSent > 0\)/,
    'email stays a fallback for when LINE reached nobody');
});

// === Webhook claim branch ====================================================

test('webhook handles ADMIN- codes before tenant BIND- codes', () => {
  const src = read('routes', 'webhooks.js');
  const adminIdx = src.indexOf('adminRecipients.isClaimCode(text)');
  const bindIdx = src.indexOf('isBindCode(text)');
  const ownerIdx = src.indexOf('ownerClaim.isClaimCode(text)');
  assert.ok(adminIdx > 0, 'admin claim branch exists');
  assert.ok(ownerIdx < adminIdx && adminIdx < bindIdx,
    'namespace check order: OWNER- → ADMIN- → BIND-');
  assert.match(src, /ผูกบัญชีนี้เป็นผู้รับแจ้งเตือนแอดมิน/,
    'success reply tells the staff member what they just joined');
  assert.match(src, /มีผู้รับแจ้งเตือนแอดมินคนใหม่/,
    'existing recipients are told when someone new joins (security signal)');
});

// === REST endpoints + schema =================================================

test('admin-recipient endpoints are owner-gated with full lifecycle', () => {
  const server = read('server.js');
  assert.match(server, /app\.get\('\/api\/admin\/line\/admin-recipients',\s*requireAuth, requireRole\('owner'\)/);
  assert.match(server, /app\.post\('\/api\/admin\/line\/admin-recipients\/tokens',\s*sameOrigin, csrfGuard, requireAuth, requireRole\('owner'\)/);
  assert.match(server, /app\.put\('\/api\/admin\/line\/admin-recipients\/:id'/, 'enable/disable + relabel');
  assert.match(server, /app\.delete\('\/api\/admin\/line\/admin-recipients\/:id'/, 'terminal revoke');
  assert.match(server, /line\.admin_recipient\.revoke/, 'lifecycle actions audited');
});

test('migration creates both tables with the one-active-binding invariant', () => {
  const mig = read('db', 'migrate.js');
  assert.match(mig, /CREATE TABLE IF NOT EXISTS admin_line_recipients/);
  assert.match(mig, /CREATE TABLE IF NOT EXISTS admin_recipient_tokens/);
  assert.match(mig, /uq_admin_line_recipients_active[\s\S]{0,200}WHERE revoked_at IS NULL/,
    'revoked rows are history; re-binding after revoke must not collide');
});

test('LINE OA page renders the recipients management card', () => {
  const page = read('project', 'admin', 'page-line-oas.jsx');
  assert.match(page, /function AdminRecipientsCard/);
  assert.match(page, /ผู้รับแจ้งเตือนแอดมิน \(ผูกได้ไม่จำกัด\)/);
  assert.match(page, /ออกรหัสผูกแอดมิน/);
  assert.match(page, /<AdminRecipientsCard oas=\{items\} setToast=\{setToast\} \/>/,
    'card mounted on the page');
  assert.match(page, /ปิดชั่วคราว/, 'mute state visible');
});

// === Event coverage: payment received / move-in / move-out ==================

test('every admin-side verified-payment path fires the "เงินเข้า" team alert', () => {
  const billPayments = read('services', 'billPayments.js');
  assert.match(billPayments, /async function notifyOwnerPaymentReceived/,
    'shared helper lives in billPayments (same module as the tenant-side notify)');
  const bills = read('routes', 'bills-extras.js');
  assert.match(bills, /source: 'manual-pay'/, 'counter payment (/pay)');
  assert.match(bills, /source: 'verify-slip'/, 'bill-side slip verify');
  const server = read('server.js');
  assert.match(server, /source: 'payment-verify'/, 'payment-queue verify');
  // The tenant auto-verify upload path already sends its own detailed
  // owner alert (✅ ผ่านอัตโนมัติ) — pin that it still exists so removing
  // it later would have to consciously rewire this coverage.
  assert.match(server, /ผ่านอัตโนมัติ/, 'auto-verified upload alert still present');
});

test('move-in and move-out fire team alerts with room + money context', () => {
  const ops = read('routes', 'tenant-ops.js');
  assert.match(ops, /subject: `🏠 ย้ายเข้า — ห้อง \$\{roomId\}`/,
    'check-in notifies which room + terms');
  assert.match(ops, /subject: `🚪 ย้ายออก — ห้อง /,
    'checkout notifies room freed + settlement');
  assert.match(ops, /ติดตามเก็บก่อนคืนส่วนต่าง/,
    'move-out alert flags outstanding debt for follow-up');
});
