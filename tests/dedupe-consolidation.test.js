// กันงานรวมโค้ดซ้ำถอยหลังกลับ: helper ที่ถูกรวมเป็น "ที่เดียว" แล้ว
// ต้องไม่งอกสำเนาใหม่ และจุดที่เคยทำงาน/แสดงผลซ้ำต้องไม่กลับมา
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('admin image read/compress helpers live in shared.jsx only', () => {
  const shared = read('project', 'admin', 'shared.jsx');
  assert.match(shared, /async function prepareImageForUpload/,
    'shared.jsx must own the image compress pipeline');
  assert.match(shared, /function readImageFileAsDataUrl/,
    'shared.jsx must own the file→dataURL reader');
  assert.match(shared, /readImageFileAsDataUrl,\s*\n\s*prepareImageForUpload,/,
    'both helpers must be exposed on window');

  // หน้าเหล่านี้เคยถือสำเนา FileReader สำหรับ "รูปภาพ" ของตัวเอง — ตอนนี้
  // ต้อง delegate ไป helper กลางเท่านั้น (page-rooms ยังมี FileReader ได้
  // 1 จุดสำหรับ CSV import ซึ่งเป็นคนละหน้าที่)
  for (const page of ['page-parcels.jsx', 'page-tenants.jsx', 'page-contracts.jsx', 'page-billing.jsx']) {
    const src = read('project', 'admin', page);
    assert.doesNotMatch(src, /new FileReader\(/,
      `${page} must not keep a private FileReader copy`);
  }
  assert.match(read('project', 'admin', 'page-parcels.jsx'), /window\.prepareImageForUpload\(file\)/);
  assert.match(read('project', 'admin', 'page-tenants.jsx'), /window\.prepareImageForUpload\(file/);
  assert.match(read('project', 'admin', 'page-contracts.jsx'), /window\.prepareImageForUpload\(f/);
  assert.match(read('project', 'admin', 'page-billing.jsx'), /window\.readImageFileAsDataUrl\(f\)/);

  // rooms: รูปเกินเพดาน 1.5MB ต้องถูกย่ออัตโนมัติ ไม่ reject ผู้ใช้ทิ้ง
  const rooms = read('project', 'admin', 'page-rooms.jsx');
  assert.match(rooms, /file\.size > ROOM_PHOTO_MAX_BYTES\s*\n?\s*\? await window\.prepareImageForUpload\(file\)/,
    'oversized room photos must auto-compress instead of throwing');
  assert.match(rooms, /window\.readImageFileAsDataUrl\(file\)/,
    'room photo reads must go through the shared reader');
});

test('tenant + public pay share one rejected-reason dictionary', () => {
  const sharedSrc = read('project', 'tenant-shared.js');
  assert.match(sharedSrc, /function tenantRejectedReason/,
    'tenant-shared.js must own the dictionary');
  assert.match(sharedSrc, /window\.tenantRejectedReason = tenantRejectedReason/);
  assert.match(sharedSrc, /window\.fileToDataUrl = fileToDataUrl/);
  assert.match(sharedSrc, /superseded_by_verified_sibling/,
    'server audit codes must be translated in the shared dictionary');

  // ทั้งสองบันเดิลต้อง "ไม่ถือสำเนา dictionary" อีกต่อไป (consume จาก window
  // พร้อม fallback identity) — ถ้าคำว่า superseded_by โผล่กลับมาแปลว่ามีคน
  // copy กลับเข้าไปใหม่
  const tenant = read('project', 'tenant.jsx');
  const pay = read('project', 'pay.jsx');
  for (const [name, src] of [['tenant.jsx', tenant], ['pay.jsx', pay]]) {
    assert.match(src, /window\.tenantRejectedReason \|\|/,
      `${name} must consume the shared dictionary`);
    assert.match(src, /window\.fileToDataUrl \|\|/,
      `${name} must consume the shared file reader`);
    assert.doesNotMatch(src, /superseded_by_verified_sibling/,
      `${name} must not re-inline the dictionary`);
  }

  // ทั้งสองหน้า HTML ต้องโหลดสคริปต์แชร์ก่อนบันเดิล
  assert.match(read('project', 'tenant.html'), /<script src="\/tenant-shared\.js"><\/script>/);
  assert.match(read('project', 'pay.html'), /<script src="\/tenant-shared\.js"><\/script>/);
});

test('tenant unpaid/open/waiting predicates are defined once and reused', () => {
  const tenant = read('project', 'tenant.jsx');
  assert.match(tenant, /function isUnpaidBill\(b\)/);
  assert.match(tenant, /function isOpenTicket\(tk\)/);
  assert.match(tenant, /function isWaitingParcel\(p\)/);
  // ห้ามมี literal นิยามค้างชำระ/งานค้าง/รอรับ กระจายนอก predicate อีก
  const literalUnpaid = tenant.match(/b\.status === 'pending' \|\| b\.status === 'overdue'/g) || [];
  assert.equal(literalUnpaid.length, 1,
    'unpaid-bill literal must appear only inside isUnpaidBill');
  const literalOpen = tenant.match(/!\['completed', 'cancelled'\]\.includes/g) || [];
  assert.equal(literalOpen.length, 1,
    'open-ticket literal must appear only inside isOpenTicket');
  const literalWaiting = tenant.match(/\.status === 'waiting_pickup'/g) || [];
  // อนุญาตใน isWaitingParcel + เงื่อนไขสไตล์ไอคอน 2 จุดใน ParcelsView (สี/พื้นหลัง)
  assert.ok(literalWaiting.length <= 3,
    `waiting_pickup literal should not spread beyond the predicate + icon styling (found ${literalWaiting.length})`);
});

test('backend single-source constants and clients stay single-source', () => {
  // เพดานสลิป default มีที่เดียวใน features.slipMaxBytes
  const features = read('services', 'features.js');
  assert.match(features, /function slipMaxBytes\(flags\)/);
  const server = read('server.js');
  assert.match(server, /maxBytes: features\.slipMaxBytes\(req\.features\)/,
    'tenant slip upload must read the cap via features.slipMaxBytes');
  const webhooks = read('routes', 'webhooks.js');
  assert.match(webhooks, /maxBytes: features\.slipMaxBytes\(flags\)/,
    'LINE slip download must read the cap via features.slipMaxBytes');
  assert.doesNotMatch(webhooks, /slipUpload\.maxBytes\) \|\| 1_500_000/,
    'webhooks must not re-hardcode the slip cap fallback');
  const billsExtras = read('routes', 'bills-extras.js');
  assert.match(billsExtras, /const maxBytes = features\.slipMaxBytes\(flags\)/,
    'admin manual-pay slip upload must read the cap via features.slipMaxBytes');
  assert.doesNotMatch(billsExtras, /slipUpload\?\.maxBytes \|\| 1_500_000/,
    'admin manual-pay slip upload must not re-hardcode the slip cap fallback');

  // backup ต้องใช้ S3 client กลาง (มี SSRF guard) — ห้ามสร้าง S3Client ดิบ
  const backup = read('scripts', 'backup.js');
  assert.match(backup, /require\('\.\.\/services\/storage'\)\.getS3Client\(\)/,
    'backup must use the guarded shared S3 client');
  assert.doesNotMatch(backup, /new S3Client\(/,
    'backup must not build a raw unguarded S3 client');
  const storage = read('services', 'storage.js');
  assert.match(storage, /getS3Client,/,
    'storage must export the shared client factory');

  // orphan-file cleanup รวมที่ storage.removeQuietly
  assert.match(storage, /function removeQuietly\(pool, id, label\)/);
  assert.match(server, /removeQuietly\(pool, slip\.id, '\[slip-upload\] orphan file/,
    'slip upload orphan cleanup must use storage.removeQuietly');
  const parcels = read('routes', 'parcels.js');
  assert.match(parcels, /storage\.removeQuietly\(pool, proofFile\.id/,
    'parcel pickup orphan cleanup must use storage.removeQuietly');
  assert.doesNotMatch(parcels, /storage\.remove\(pool, [a-zA-Z.]+\)\.catch/,
    'parcels must not keep ad-hoc fire-and-forget remove().catch copies');
  assert.match(billsExtras, /storage\.removeQuietly\(pool, orphanId, '\[bill\.pay\] orphan slip'\)/,
    'admin manual-pay orphan cleanup must use storage.removeQuietly');

  // scheduler: วันที่ local ICT delegate ไป billing.localTodayYmd + lock hash มี cache
  const scheduler = read('services', 'scheduler.js');
  assert.match(scheduler, /return billing\.localTodayYmd\(now\);/,
    'scheduler localDateKey must delegate to billing.localTodayYmd');
  assert.match(scheduler, /_lockKeyCache/,
    'advisory lock hash must be cached per job name');

  // /files/:id ต้อง lookup tenant session แค่ครั้งเดียวต่อคำขอ
  assert.match(server, /const loadTenantSession = async \(\) => \{/,
    'file access route must memoize tenantSessionLookup');
  assert.match(server, /if \(!tSessionChecked\)/,
    'memoized lookup must be guarded by a checked flag');
});

test('parcel list load error shows on one surface only (inline banner)', () => {
  const page = read('project', 'admin', 'page-parcels.jsx');
  // load() ล้มเหลว → แบนเนอร์ inline (มีปุ่มลองใหม่) เท่านั้น ห้ามยิง toast ซ้อน
  assert.doesNotMatch(page, /toastError\(setToast, e, \{ action: 'โหลดรายการพัสดุ' \}\)/,
    'list-load failures must not double-report via toast on top of the inline banner');
});
