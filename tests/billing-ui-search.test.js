const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'project', 'admin', 'page-billing.jsx'),
  'utf8',
);

test('billing UI overlays a single real DB bill before leaving an estimate row', () => {
  assert.match(src, /const dbBillsGroupedByRoom = \{\};/,
    'billing page must group DB bills by room inside the reconciliation pass');
  assert.match(src, /roomBills\.find\(\(candidate\) => dbBillMatchesUiBill\(candidate, est\)\)/,
    'estimate rows should try the explicit DB bill matcher before falling back');
  assert.match(src, /roomBills\.length === 1/,
    'a single DB bill for the room should replace the confusing estimate row');
  assert.match(src, /_matchWarning: 'จับคู่จากห้องเพราะมีบิลจริงใบเดียวในรอบนี้'/,
    'room-only reconciliation must leave a visible operator note');
  assert.match(src, /if \(!real\) return \{ \.\.\.est, _source: est\._source \|\| 'estimate' \};/,
    'estimate wording must remain only when no real DB bill can be matched');
});

test('billing UI exposes searchable bill rows with clear no-result feedback', () => {
  assert.match(src, /const \[billSearch, setBillSearch\] = useState\(''\)/,
    'billing page must keep search state');
  assert.match(src, /const tabRows = useMemo\(\(\) => \{/,
    'search should filter inside the selected billing tab');
  assert.match(src, /const q = billSearch\.trim\(\)\.toLowerCase\(\)/,
    'search query should be normalized before filtering');
  assert.match(src, /placeholder="ค้นหาเลขบิล ห้อง ผู้เช่า เบอร์ โทร สถานะ"/,
    'search input should explain searchable fields');
  assert.match(src, /billStatusMeta\(b\)\.label/,
    'search must include human-readable bill status');
  assert.match(src, /tenantStatusUiLabel\(b\.tenantStatus\)/,
    'search must include tenant status');
  assert.match(src, /พบ \{fmt\(filtered\.length\)\} จาก \{fmt\(tabRows\.length\)\} รายการในแท็บนี้/,
    'toolbar should show filtered count for the current tab');
  assert.match(src, /title="ไม่พบรายการที่ค้นหา"/,
    'empty state should distinguish search no-results from missing bills');
});
