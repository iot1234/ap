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
  assert.match(src, /const ACCESS_RESPONSE_MAX_BYTES = 1 \* 1024 \* 1024/);
  assert.match(src, /function readAccessJson\(res, label\)/);
  assert.match(src, /readAccessJson\(r, '\/api\/access\/logs'\)/);
  assert.match(src, /const \[saving, setSaving\] = useState\(false\)/);
  assert.match(src, /!window\.apiCall && !window\.requireApiCall && !window\.apiFetch && !window\.requireApiFetch/);
  assert.match(src, /timeoutMs: ACCESS_API_TIMEOUT_MS/);
  assert.match(src, /maxResponseBytes: ACCESS_RESPONSE_MAX_BYTES/);
  assert.match(src, /window\.toastError\(setToast, e2, \{ action: 'บันทึก log เข้า-ออก' \}\)/);
  assert.match(src, /disabled=\{saving \|\| loading\}/);
  assert.match(src, /กำลังบันทึก\.\.\./);
  assert.match(src, /get timedOut\(\) \{ return timedOut; \}/);
  assert.match(src, /req\.timedOut/);
  assert.match(src, /if \(abortRef\.current === req\)[\s\S]{0,120}setLoading\(false\)/);
});

test('admin JSON readers cap large access responses before parsing', () => {
  const hooks = read('project', 'admin', 'hooks.jsx');
  const access = read('project', 'admin', 'page-access.jsx');
  const devices = read('project', 'admin', 'page-access-devices.jsx');
  const shell = read('project', 'admin', 'shell.jsx');
  assert.match(hooks, /const JSON_RESPONSE_MAX_BYTES = 8 \* 1024 \* 1024/);
  assert.match(hooks, /async function readJsonWithByteLimit\(res, maxBytes = JSON_RESPONSE_MAX_BYTES, label = 'response'\)/);
  assert.match(hooks, /res\.body\.getReader\(\)/);
  assert.match(hooks, /total > maxBytes/);
  assert.match(hooks, /opts\.maxResponseBytes \|\| JSON_RESPONSE_MAX_BYTES/);
  assert.match(hooks, /window\.readJsonWithByteLimit = readJsonWithByteLimit/);
  assert.match(hooks, /function emitDiagnostic\(payload\)/);
  assert.match(hooks, /new CustomEvent\('ap:diagnostic'/);
  assert.match(access, /window\.readJsonWithByteLimit\(res, ACCESS_RESPONSE_MAX_BYTES/);
  assert.match(devices, /const ACCESS_DEVICE_RESPONSE_MAX_BYTES = 512 \* 1024/);
  assert.match(devices, /const ACCESS_DEVICE_RENDER_LIMIT = 100/);
  assert.match(devices, /window\.readJsonWithByteLimit\(res, ACCESS_DEVICE_RESPONSE_MAX_BYTES/);
  assert.match(devices, /function normaliseAccessDevices\(rows\)/);
  assert.match(devices, /function emitAccessDeviceDiagnostic\(payload\)/);
  assert.match(devices, /window\.PageAccessDevicesInner = PageAccessDevices/);
  assert.match(shell, /function DiagnosticBanner\(\{ diagnostic, onDismiss \}\)/);
  assert.match(shell, /const CRASH_MARKER_KEY = '__admin_alive_marker_v1'/);
  assert.match(shell, /window\.addEventListener\('ap:diagnostic', onDiagnostic\)/);
  assert.match(shell, /code: 'MEMORY_PRESSURE'/);
  assert.match(shell, /if \(isLowWorkRoute\(\)\) return/);
  assert.match(shell, /const isLowWorkPage = page === 'access' \|\| page === 'access-devices'/);
  assert.match(shell, /if \(isLowWorkPage\) return \[\]/);
  assert.match(shell, /readShellJson\(bRes, '\/api\/data\/baankarn_bookings_v1'\)/);
  assert.match(shell, /readShellJson\(res, '\/api\/data\/baankarn_rooms_v1'\)/);
});

test('admin hydrate is protected from oversized app_data payloads before JSON parse', () => {
  const client = read('project', 'api-client.js');
  assert.match(client, /const HYDRATE_RESPONSE_MAX_BYTES = 8 \* 1024 \* 1024/);
  assert.match(client, /async function readJsonWithByteLimit\(res, maxBytes, label\)/);
  assert.match(client, /headers\.get\('content-length'\)/);
  assert.match(client, /res\.body\.getReader\(\)/);
  assert.match(client, /total > maxBytes/);
  assert.match(client, /readJsonWithByteLimit\(res, HYDRATE_RESPONSE_MAX_BYTES, '\/api\/data hydrate'\)/);
  assert.match(client, /const metaOmitted = \(data\.__meta && data\.__meta\.omitted\) \|\| \{\}/);
});

test('server omits oversized app_data values before returning admin hydrate data', () => {
  const server = read('server.js');
  assert.match(server, /const APP_DATA_RESPONSE_VALUE_MAX_BYTES = 5 \* 1024 \* 1024/);
  assert.match(server, /SELECT updated_at, octet_length\(value::text\) AS payload_bytes FROM app_data WHERE key=\$1/);
  assert.match(server, /if \(oversizedAppDataPayload\(sizeQ\.rows\[0\]\)\)[\s\S]{0,360}value: null/);
  assert.match(server, /SELECT key, updated_at, octet_length\(value::text\) AS payload_bytes FROM app_data WHERE key = ANY\(\$1\)/);
  assert.match(server, /const safeKeys = sizeRows\.rows[\s\S]{0,160}!oversizedAppDataPayload\(r\)/);
  assert.match(server, /SELECT key, value, updated_at FROM app_data WHERE key = ANY\(\$1\)/);
  assert.match(server, /meta\.omitted\[sizeRow\.key\] = info/);
  assert.match(server, /releaseExpiredPublicBookingHolds\(pool, \{ skipOversized: true \}\)/);
  const helperStart = server.indexOf('async function releaseExpiredPublicBookingHolds');
  const helperEnd = server.indexOf('async function publicBookingDepositInfo', helperStart);
  assert.ok(helperStart > 0);
  assert.ok(helperEnd > helperStart);
  const helperBlock = server.slice(helperStart, helperEnd);
  assert.match(helperBlock, /opts\.skipOversized/);
  assert.match(helperBlock, /SELECT octet_length\(value::text\) AS payload_bytes FROM app_data WHERE key='baankarn_rooms_v1'/);
  assert.match(helperBlock, /SELECT value FROM app_data WHERE key='baankarn_rooms_v1' FOR UPDATE/);
  assert.ok(
    helperBlock.indexOf('opts.skipOversized') <
    helperBlock.indexOf("SELECT value FROM app_data WHERE key='baankarn_rooms_v1' FOR UPDATE")
  );
});

test('server truncates legacy access text before returning list responses', () => {
  const server = read('server.js');
  assert.match(server, /NULLIF\(left\(COALESCE\(room_id, ''\), 32\), ''\) AS room_id/);
  assert.match(server, /left\(COALESCE\(device, ''\), 64\) AS device/);
  assert.match(server, /left\(COALESCE\(method, ''\), 16\) AS method/);
  assert.match(server, /NULLIF\(left\(COALESCE\(card_id, ''\), 64\), ''\) AS card_id/);
  assert.match(server, /NULLIF\(left\(COALESCE\(reason, ''\), 200\), ''\) AS reason/);
  assert.match(server, /FROM access_logs ORDER BY occurred_at DESC LIMIT \$1/);
  assert.match(server, /left\(COALESCE\(device_id, ''\), 64\) AS device_id/);
  assert.match(server, /NULLIF\(left\(COALESCE\(description, ''\), 200\), ''\) AS description/);
  assert.match(server, /const limit = Math\.min\(Math\.max\(Number\(req\.query\.limit\) \|\| 100, 1\), 100\)/);
  assert.match(server, /FROM access_devices ORDER BY created_at DESC LIMIT \$1/);
  assert.match(server, /\[limit\]/);
});

test('access device token page uses timeout-aware API helpers and busy states', () => {
  const src = read('project', 'admin', 'page-access-devices.jsx');
  assert.match(src, /const ACCESS_DEVICE_API_TIMEOUT_MS = 15_000/);
  assert.match(src, /const ACCESS_DEVICE_RENDER_LIMIT = 100/);
  assert.match(src, /const \[loading, setLoading\] = useState\(false\)/);
  assert.match(src, /const \[loadError, setLoadError\] = useState\(null\)/);
  assert.match(src, /const \[deletingId, setDeletingId\] = useState\(null\)/);
  assert.match(src, /window\.toastError\(setToast, err, \{ action \}\)/);
  assert.match(src, /async function fetchJsonWithTimeout/);
  assert.match(src, /e\.code = 'TIMEOUT'/);
  assert.match(src, /timeoutMs: ACCESS_DEVICE_API_TIMEOUT_MS/);
  assert.match(src, /const endpoint = `\/api\/admin\/access-devices\?limit=\$\{ACCESS_DEVICE_RENDER_LIMIT\}`/);
  assert.match(src, /apiFetch\(endpoint, \{\s*timeoutMs: ACCESS_DEVICE_API_TIMEOUT_MS,\s*\}\)/);
  assert.match(src, /d = await fetchJsonWithTimeout\(endpoint\)/);
  assert.match(src, /setDevices\(normaliseAccessDevices\(d\.devices\)\)/);
  assert.match(src, /setLoadError\(message\)/);
  assert.match(src, /emitAccessDeviceDiagnostic\(\{/);
  assert.match(src, /กำลังโหลด API Tokens/);
  assert.match(src, /disabled=\{deletingId === d\.id \|\| busy\}/);
  assert.match(src, /กำลังลบ\.\.\./);
  assert.match(src, /กำลังสร้าง\.\.\./);
});

test('access page embeds the raw API token tab and reports a missing module', () => {
  const src = read('project', 'admin', 'page-access.jsx');
  assert.match(src, /const AccessDevicesPage = window\.PageAccessDevicesInner \|\| window\.PageAccessDevices/);
  assert.match(src, /code: 'ACCESS_DEVICES_MODULE_MISSING'/);
  assert.match(src, /<AccessDevicesPage setToast=\{setToast\} embedded \/>/);
});
