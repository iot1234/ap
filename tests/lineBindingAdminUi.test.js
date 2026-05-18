// tests/lineBindingAdminUi.test.js
//   node --test tests/lineBindingAdminUi.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

test('admin LINE binding keys show lifecycle status and protected revoke controls', () => {
  const page = read(path.join('project', 'admin', 'page-line-bindings.jsx'));
  const route = read(path.join('routes', 'admin-line-bindings.js'));
  const service = read(path.join('services', 'lineBinding.js'));

  assert.match(page, /setShowIssueModal\(\{ tenantId: id, replacePending, issued \}\)/,
    'issue modal must stay open as a result screen after key creation');
  assert.match(page, /คีย์ LINE ที่สร้างสำเร็จ/,
    'admin must see a clear successful-key modal title');
  assert.match(page, /ระบบสร้างคีย์แล้วและจะแสดงค้างในกล่องนี้/,
    'admin must be told the generated key will stay visible');
  assert.match(page, /ออกเมื่อ/,
    'UI must show when a key was issued');
  assert.match(page, /หมดอายุ/,
    'UI must show when a key expires');
  assert.match(page, /statusLabel/,
    'UI must translate raw key statuses into admin-readable labels');
  assert.match(page, /keyMetaText/,
    'UI must render detailed lifecycle text for each key');
  assert.match(page, /ผูกแล้ว/,
    'UI must clearly show keys and accounts that are already bound');
  assert.match(page, /คีย์ที่ใช้ผูก/,
    'bound account rows must tell admin which key was used');
  assert.match(page, /function revokePendingCode/,
    'UI must expose a scoped pending-key delete action');
  assert.match(page, /\/codes\/\$\{bid\}/,
    'pending-key delete must call the scoped per-key API');
  assert.match(page, /ลบคีย์นี้/,
    'latest pending key must have an explicit delete button');
  assert.match(page, /ระบบจะยกเลิกเฉพาะคีย์ที่ยังรอผูกเท่านั้น/,
    'delete confirmation must warn that bound LINE accounts are not removed');

  assert.match(route, /\/tenants\/:id\/codes\/:bindingId/,
    'admin API must expose a per-key pending revoke endpoint');
  assert.match(route, /lineBinding\.revokePendingCode/,
    'route must call the service method that scopes pending-key deletion');
  assert.match(route, /LINE_BINDING_CODE_NOT_PENDING/,
    'route must return a clear conflict when a key is already bound/revoked/expired');
  assert.match(route, /line_binding\.revoke_pending_code/,
    'pending-key deletes must be audited separately from full unbinds');

  assert.match(service, /async function revokePendingCode/,
    'service must implement scoped pending-key revoke');
  assert.match(service, /FOR UPDATE/,
    'service must lock the key row before deciding whether it can be deleted');
  assert.match(service, /AND status='pending'/,
    'service must only revoke keys that are still pending');
  assert.match(service, /createdAt: ins\.rows\[0\]\.created_at/,
    'issue responses must include the DB-created timestamp');
  assert.match(service, /RETURNING id, code, expires_at, target_oa_id, created_at/,
    'issued keys must return created_at so refresh does not hide the issue time');
});
