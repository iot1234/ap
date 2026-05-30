// Regression guards for admin-triggered LINE binding lifecycle notices.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-line-bindings.js'), 'utf8');

test('admin LINE binding route can push lifecycle notices to revoked accounts', () => {
  assert.match(src, /const lineOa = require\('\.\.\/services\/lineOa'\)/,
    'route must be able to resolve the OA that owns the revoked binding');
  assert.match(src, /const lineSvc = require\('\.\.\/services\/line'\)/,
    'route must be able to push a direct LINE notice');
  assert.match(src, /async function notifyLineBindingAccounts/,
    'shared lifecycle notice helper must exist');
  assert.match(src, /lineSvc\.isLikelyUserId\(lineUserId\)/,
    'invalid LINE userIds must be skipped instead of pushed');
  assert.match(src, /lineOa\.resolveForTenant\(pool, oaId, \{ withSecrets: true \}\)/,
    'notice must use the same OA as the revoked account');
  assert.match(src, /lineSvc\.pushText\(oa, lineUserId, text\)/,
    'notice must push to the account before it disappears from normal fan-out');
  assert.match(src, /VALUES \('line-binding-admin'/,
    'notice results must be persisted in notifications_log');
});

test('admin full unbind and block notify every account that was bound before the change', () => {
  assert.match(src,
    /const before = await lineBinding\.getStatus\(pool, id\)[\s\S]{0,300}await lineBinding\.revoke\(pool/,
    'full unbind must capture bound accounts before revoking them');
  assert.match(src,
    /await lineBinding\.revoke\(pool[\s\S]{0,500}notifyLineBindingAccounts\(\s*before\?\.boundAccounts \|\| \[\]/,
    'full unbind must notify every previously bound account');
  assert.match(src,
    /await lineBinding\.block\(pool[\s\S]{0,500}notifyLineBindingAccounts\(\s*before\?\.boundAccounts \|\| \[\]/,
    'blocking LINE binding must notify every account removed by the block');
  assert.match(src, /revokedAccounts: before\?\.boundAccounts\?\.length \|\| 0/,
    'audit trail must include how many accounts were affected');
});

test('admin per-account revoke notifies exactly the removed LINE account', () => {
  assert.match(src,
    /const account = boundAccountFromStatus\(before, bindingId\)[\s\S]{0,300}lineBinding\.revokeAccount\(pool/,
    'per-account revoke must capture the target account before revoking');
  assert.match(src,
    /lineBinding\.revokeAccount\(pool[\s\S]{0,500}notifyLineBindingAccounts\(\s*account \? \[account\] : \[\]/,
    'per-account revoke must notify only the removed account');
  assert.match(src, /res\.json\(\{ \.\.\.result, notified \}\)/,
    'API response must expose notification delivery status');
});
