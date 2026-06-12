const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(...parts) {
  return fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
}

test('access log page is resilient to hung save/load requests', () => {
  const src = read('project', 'admin', 'page-access.jsx');
  assert.match(src, /const ACCESS_API_TIMEOUT_MS = 15_000/);
  assert.match(src, /const \[saving, setSaving\] = useState\(false\)/);
  assert.match(src, /!window\.apiCall && !window\.requireApiCall && !window\.apiFetch && !window\.requireApiFetch/);
  assert.match(src, /timeoutMs: ACCESS_API_TIMEOUT_MS/);
  assert.match(src, /window\.toastError\(setToast, e2, \{ action: 'บันทึก log เข้า-ออก' \}\)/);
  assert.match(src, /disabled=\{saving \|\| loading\}/);
  assert.match(src, /กำลังบันทึก\.\.\./);
  assert.match(src, /get timedOut\(\) \{ return timedOut; \}/);
  assert.match(src, /req\.timedOut/);
  assert.match(src, /if \(abortRef\.current === req\)[\s\S]{0,120}setLoading\(false\)/);
});

test('access device token page uses timeout-aware API helpers and busy states', () => {
  const src = read('project', 'admin', 'page-access-devices.jsx');
  assert.match(src, /const ACCESS_DEVICE_API_TIMEOUT_MS = 15_000/);
  assert.match(src, /const \[loading, setLoading\] = useState\(false\)/);
  assert.match(src, /const \[deletingId, setDeletingId\] = useState\(null\)/);
  assert.match(src, /window\.toastError\(setToast, err, \{ action \}\)/);
  assert.match(src, /async function fetchJsonWithTimeout/);
  assert.match(src, /e\.code = 'TIMEOUT'/);
  assert.match(src, /timeoutMs: ACCESS_DEVICE_API_TIMEOUT_MS/);
  assert.match(src, /apiFetch\('\/api\/admin\/access-devices', \{\s*timeoutMs: ACCESS_DEVICE_API_TIMEOUT_MS,\s*\}\)/);
  assert.match(src, /d = await fetchJsonWithTimeout\('\/api\/admin\/access-devices'\)/);
  assert.match(src, /กำลังโหลด API Tokens/);
  assert.match(src, /disabled=\{deletingId === d\.id \|\| busy\}/);
  assert.match(src, /กำลังลบ\.\.\./);
  assert.match(src, /กำลังสร้าง\.\.\./);
});
