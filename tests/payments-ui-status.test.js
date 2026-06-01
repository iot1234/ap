const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'project', 'admin', 'page-payments.jsx'),
  'utf8',
);

test('admin payments page separates slip and bill status with clear color metadata', () => {
  assert.match(src, /function paymentStatusMeta\(C, status\)/,
    'slip statuses should have a dedicated metadata helper');
  assert.match(src, /function billStatusMeta\(C, status\)/,
    'bill statuses should have a dedicated metadata helper');
  assert.match(src, /ต้องตรวจสลิป/,
    'pending slips must explain that admin action is required');
  assert.match(src, /สลิปไม่ผ่าน/,
    'rejected slips must have a clear red-state label');
  assert.match(src, /บิลถูกยกเลิก ไม่ควรรับชำระเพิ่ม/,
    'void bills must explain why payment should not continue');
  assert.match(src, /<StatusBadge meta=\{slipMeta\} prefix="สลิป" \/>/,
    'each row should label the slip status separately');
  assert.match(src, /<StatusBadge meta=\{billMeta\} prefix="บิล" \/>/,
    'each row should label the bill status separately');
  assert.match(src, /<StatusInfoPanel title="สถานะสลิป" meta=\{slipMeta\}/,
    'modal should surface slip status before admin decisions');
  assert.match(src, /<StatusInfoPanel title="สถานะบิล" meta=\{billMeta\}/,
    'modal should surface bill status before admin decisions');
});

test('admin payments page keeps filtering and empty states understandable', () => {
  assert.match(src, /placeholder="เลขบิล ห้อง ผู้เช่า เบอร์ ยอด หรือสถานะ"/,
    'search box should say what fields it searches');
  assert.match(src, /aria-label="กรองสถานะสลิป"/,
    'status filter should be explicit for operators and assistive tech');
  assert.match(src, /แสดง \{visibleList\.length\} จาก \{list\.length\} รายการในมุมมอง \{activeFilterLabel\}/,
    'toolbar should show how many rows are currently visible');
  assert.match(src, /title=\{searchTerm \? 'ไม่พบรายการที่ค้นหา' : 'ไม่มีรายการในสถานะนี้'\}/,
    'empty state should distinguish a search miss from an empty status queue');
  assert.match(src, /คลิกแถวเพื่อดูสลิปและรายละเอียดบิล/,
    'list header should explain the row interaction');
});
