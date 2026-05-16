// services/anomalyScanner.js
// Detects unusual / suspicious data across every billing-touching domain
// and returns a structured list admins can act on. Read-only — never
// mutates anything.
//
// Output shape:
//   {
//     scannedAt: ISO string,
//     summary: { critical, warn, info, total },
//     items: [
//       {
//         id:        'BILL_TINY_AMOUNT',          stable code for UI / dedup
//         severity:  'critical'|'warn'|'info',
//         domain:    'bill'|'tenant'|'room'|'contract'|'pricing'|'utility'|'payment'|'system',
//         message:   'X รายการ ...',              short Thai for the badge
//         detail:    'รายละเอียดเพิ่มเติม',         long Thai for the panel
//         count:     N,                            how many records affected
//         items:     [{ id, label, ... }],         sample (capped at 10)
//         fix:       '/admin#billing?...',         hint URL or steps
//       }
//     ]
//   }
//
// Severity meaning:
//   critical — bills/payments will be wrong; admin should fix today
//   warn     — operational drift; admin should fix this week
//   info     — informational; nothing broken, just notable
//
// Add new detectors at the bottom + register in DETECTORS.

const pricing = require('./pricing');

const SEVERITY_RANK = { info: 0, warn: 1, critical: 2 };

// === DETECTORS ============================================================

// 1. Pricing config: typo-tier values that would produce nonsense bills.
//    Companion to PUT-time validator in server.js — this one catches
//    bad values already sitting in DB from before the validator landed.
async function detectPricingConfig(pool) {
  const items = [];
  const { rows } = await pool.query(
    `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
  );
  if (!rows.length) {
    return [{
      id: 'CONFIG_MISSING',
      severity: 'warn',
      domain: 'pricing',
      message: 'ยังไม่ได้ตั้งค่าราคา',
      detail: 'baankarn_config_v1 ไม่อยู่ใน DB — admin ยังไม่ได้บันทึก /admin#pricing ครั้งแรก',
      count: 1, items: [], fix: '/admin#pricing',
    }];
  }
  const cfg = rows[0].value || {};
  const rates = cfg.rates || {};
  const lowRent = [];
  for (const [type, r] of Object.entries(rates)) {
    if (!r || typeof r !== 'object') continue;
    const rent = Number(r.rent);
    if (Number.isFinite(rent) && rent > 0 && rent < 100) {
      lowRent.push({ id: type, label: `${type} = ฿${rent}` });
    }
  }
  if (lowRent.length) {
    items.push({
      id: 'PRICING_RENT_TOO_LOW',
      severity: 'critical',
      domain: 'pricing',
      message: `${lowRent.length} ประเภทห้องราคาต่ำผิดปกติ (${lowRent.map((i) => i.id).join(', ')})`,
      detail: 'ค่าเช่าจริงควร ≥ 100฿ — น่าจะพิมพ์ผิด (เช่น "1" แทน "4500"). ถ้าตั้งใจไม่เก็บค่าเช่าตั้ง = 0 แทน. บิลที่จะออกในอนาคตของห้องประเภทนี้ที่ไม่มีสัญญา lock จะใช้ราคานี้',
      count: lowRent.length, items: lowRent, fix: '/admin#pricing',
    });
  }
  // Utilities check — water/elec rate = 0 means bills get ฿0 water/elec
  const u = cfg.utilities || {};
  const zeroUtil = [];
  if (Number(u.waterRate) === 0 || u.waterRate == null) zeroUtil.push({ id: 'water', label: 'ค่าน้ำ/หน่วย ไม่ได้ตั้ง' });
  if (Number(u.elecRate)  === 0 || u.elecRate  == null) zeroUtil.push({ id: 'elec',  label: 'ค่าไฟ/หน่วย ไม่ได้ตั้ง' });
  if (zeroUtil.length) {
    items.push({
      id: 'UTILITY_RATE_ZERO',
      severity: 'critical',
      domain: 'utility',
      message: `${zeroUtil.length} อัตราค่าสาธารณูปโภคไม่ได้ตั้ง`,
      detail: 'ค่าน้ำ/ไฟใน /admin#pricing ยังไม่ได้กำหนดอัตราต่อหน่วย — บิลจะคำนวณค่าน้ำ/ไฟเป็น 0 ทั้งที่มีการใช้',
      count: zeroUtil.length, items: zeroUtil, fix: '/admin#pricing',
    });
  }
  return items;
}

// 2. Bills with suspicious amounts.
//    - Total < 100฿ (almost certainly wrong — typical rent is thousands)
//    - Total > 100,000฿ (unusually high for a single-room bill)
//    - Bill rent significantly diverges from contract.monthly_rent
//      (caught by resolver in new flows but legacy bills may have drift)
async function detectBillAnomalies(pool) {
  const items = [];
  // Tiny bills (excluding ฿0 which usually means data-entry-in-progress)
  const tiny = await pool.query(`
    SELECT b.id, b.bill_no, b.room_id, b.total::numeric AS total, b.status, b.created_at::date AS d
      FROM bills b
     WHERE b.deleted_at IS NULL
       AND b.total > 0 AND b.total < 100
       AND b.status IN ('pending','overdue')
     ORDER BY b.created_at DESC LIMIT 20`);
  if (tiny.rows.length) {
    items.push({
      id: 'BILL_TOTAL_TOO_LOW',
      severity: 'critical',
      domain: 'bill',
      message: `${tiny.rows.length} บิลยอดต่ำผิดปกติ (< ฿100)`,
      detail: 'อาจเกิดจาก rates ใน /admin#pricing ที่ถูกตั้งผิด หรือ buildBill ขาดข้อมูล. ตรวจดูราคาบิลเทียบสัญญา/สูตร',
      count: tiny.rows.length,
      items: tiny.rows.slice(0, 10).map((r) => ({ id: r.bill_no, label: `${r.bill_no} ห้อง ${r.room_id} — ฿${r.total} (${r.status})` })),
      fix: '/admin#billing',
    });
  }
  // Huge bills — sanity check on single-month total
  const huge = await pool.query(`
    SELECT b.id, b.bill_no, b.room_id, b.total::numeric AS total, b.status
      FROM bills b
     WHERE b.deleted_at IS NULL
       AND b.total > 100000
       AND b.status IN ('pending','overdue')
     ORDER BY b.created_at DESC LIMIT 20`);
  if (huge.rows.length) {
    items.push({
      id: 'BILL_TOTAL_TOO_HIGH',
      severity: 'warn',
      domain: 'bill',
      message: `${huge.rows.length} บิลยอดสูงผิดปกติ (> ฿100,000)`,
      detail: 'บิลห้องเดียวต่อเดือนเกิน ฿100,000 — ตรวจว่า water/elec units ถูก, recurring charges ไม่ duplicate',
      count: huge.rows.length,
      items: huge.rows.slice(0, 10).map((r) => ({ id: r.bill_no, label: `${r.bill_no} ห้อง ${r.room_id} — ฿${r.total}` })),
      fix: '/admin#billing',
    });
  }
  // Bills without tenant_id — can't be paid from tenant portal
  const orphan = await pool.query(`
    SELECT b.id, b.bill_no, b.room_id, b.total::numeric AS total
      FROM bills b
     WHERE b.deleted_at IS NULL AND b.tenant_id IS NULL
       AND b.status IN ('pending','overdue')
     ORDER BY b.created_at DESC LIMIT 20`);
  if (orphan.rows.length) {
    items.push({
      id: 'BILL_NO_TENANT',
      severity: 'warn',
      domain: 'bill',
      message: `${orphan.rows.length} บิลค้างชำระไม่มี tenant_id`,
      detail: 'ผู้เช่าใน portal มองไม่เห็นบิล (tenant_id เป็น NULL). น่าจะออกบิลก่อนเช็คอินหรือผู้เช่าย้ายออก',
      count: orphan.rows.length,
      items: orphan.rows.slice(0, 10).map((r) => ({ id: r.bill_no, label: `${r.bill_no} ห้อง ${r.room_id} — ฿${r.total}` })),
      fix: '/admin#billing',
    });
  }
  return items;
}

// 3. Tenant data anomalies — orphans, status drift.
async function detectTenantAnomalies(pool) {
  const items = [];
  // Active tenants without current_room_id
  const noRoom = await pool.query(`
    SELECT id, full_name, phone, created_at::date AS d
      FROM tenants
     WHERE status='active' AND deleted_at IS NULL
       AND (current_room_id IS NULL OR current_room_id='')
     ORDER BY created_at DESC LIMIT 20`);
  if (noRoom.rows.length) {
    items.push({
      id: 'TENANT_ACTIVE_NO_ROOM',
      severity: 'warn',
      domain: 'tenant',
      message: `${noRoom.rows.length} ผู้เช่า active แต่ไม่มีห้อง`,
      detail: 'น่าจะ checkin ค้าง หรือ admin ลบ current_room_id โดยไม่ checkout — ผู้เช่าจะเข้า portal ไม่ได้',
      count: noRoom.rows.length,
      items: noRoom.rows.slice(0, 10).map((t) => ({ id: t.id, label: `id=${t.id} ${t.full_name || ''} (${t.phone})` })),
      fix: '/admin#tenants',
    });
  }
  // Active tenants in room with status != occupied/overdue
  const wrongRoom = await pool.query(`
    SELECT t.id, t.full_name, t.current_room_id, rv.status AS room_status
      FROM tenants t JOIN rooms_v2 rv ON rv.room_code=t.current_room_id
     WHERE t.status='active' AND t.deleted_at IS NULL AND rv.deleted_at IS NULL
       AND rv.status NOT IN ('occupied','overdue')
     LIMIT 20`);
  if (wrongRoom.rows.length) {
    items.push({
      id: 'TENANT_ROOM_STATUS_DRIFT',
      severity: 'warn',
      domain: 'tenant',
      message: `${wrongRoom.rows.length} ผู้เช่าอยู่ห้องที่สถานะไม่ตรง`,
      detail: 'ผู้เช่า status=active แต่ห้องไม่ใช่ occupied/overdue — admin reconcile ห้องนี้',
      count: wrongRoom.rows.length,
      items: wrongRoom.rows.slice(0, 10).map((t) => ({ id: t.id, label: `id=${t.id} ${t.full_name} ห้อง ${t.current_room_id} status=${t.room_status}` })),
      fix: '/admin#rooms',
    });
  }
  // Multiple active contracts on same tenant
  const dupContract = await pool.query(`
    SELECT tenant_id, COUNT(*)::int AS n
      FROM contracts
     WHERE status='active' AND deleted_at IS NULL AND tenant_id IS NOT NULL
     GROUP BY tenant_id HAVING COUNT(*) > 1`);
  if (dupContract.rows.length) {
    items.push({
      id: 'TENANT_MULTI_CONTRACT',
      severity: 'critical',
      domain: 'contract',
      message: `${dupContract.rows.length} ผู้เช่ามีสัญญา active หลายฉบับพร้อมกัน`,
      detail: 'ผิดปกติ — ผู้เช่าหนึ่งคนควรมีสัญญา active เพียงฉบับเดียว. อาจ checkout ไม่ครบ → contract เก่าไม่ปิด',
      count: dupContract.rows.length,
      items: dupContract.rows.slice(0, 10).map((r) => ({ id: r.tenant_id, label: `tenant_id=${r.tenant_id} มี ${r.n} สัญญา active` })),
      fix: '/admin#contracts',
    });
  }
  return items;
}

// 4. Contract anomalies — missing rent, past end_date still active.
async function detectContractAnomalies(pool) {
  const items = [];
  // Active contract with monthly_rent = 0 or NULL
  const noRent = await pool.query(`
    SELECT id, contract_no, tenant_id, room_id
      FROM contracts
     WHERE status='active' AND deleted_at IS NULL
       AND (monthly_rent IS NULL OR monthly_rent <= 0)
     LIMIT 20`);
  if (noRent.rows.length) {
    items.push({
      id: 'CONTRACT_NO_RENT',
      severity: 'critical',
      domain: 'contract',
      message: `${noRent.rows.length} สัญญา active ไม่มี monthly_rent`,
      detail: 'บิลที่ออกจากสัญญานี้ resolver จะ fall ไป formula/legacy — ราคาอาจไม่ตรงกับที่ผู้เช่าตกลง. รัน scripts/backfill-contract-rents.js',
      count: noRent.rows.length,
      items: noRent.rows.slice(0, 10).map((c) => ({ id: c.contract_no, label: `${c.contract_no} ห้อง ${c.room_id}` })),
      fix: 'railway run node scripts/backfill-contract-rents.js --apply',
    });
  }
  // Active contract past end_date by > 7 days
  const expired = await pool.query(`
    SELECT id, contract_no, room_id, end_date
      FROM contracts
     WHERE status='active' AND deleted_at IS NULL
       AND end_date IS NOT NULL AND end_date < CURRENT_DATE - INTERVAL '7 days'
     ORDER BY end_date ASC LIMIT 20`);
  if (expired.rows.length) {
    items.push({
      id: 'CONTRACT_EXPIRED_ACTIVE',
      severity: 'warn',
      domain: 'contract',
      message: `${expired.rows.length} สัญญาหมดอายุแล้วแต่ยัง active`,
      detail: 'สัญญาที่ end_date ผ่านไปแล้ว 7+ วัน แต่ status ยัง active — ควร renew (สร้างสัญญาใหม่) หรือ checkout',
      count: expired.rows.length,
      items: expired.rows.slice(0, 10).map((c) => ({ id: c.contract_no, label: `${c.contract_no} ห้อง ${c.room_id} หมดอายุ ${c.end_date}` })),
      fix: '/admin#contracts',
    });
  }
  return items;
}

// 5. Room anomalies — status drift, override without reason.
async function detectRoomAnomalies(pool) {
  const items = [];
  // Rooms with override but no reason — admin set special rate but didn't say why
  const orphanOverride = await pool.query(`
    SELECT room_code, rent_override, rent_override_by
      FROM rooms_v2
     WHERE deleted_at IS NULL
       AND rent_override IS NOT NULL
       AND (rent_override_reason IS NULL OR rent_override_reason = '')
     LIMIT 20`);
  if (orphanOverride.rows.length) {
    items.push({
      id: 'ROOM_OVERRIDE_NO_REASON',
      severity: 'info',
      domain: 'room',
      message: `${orphanOverride.rows.length} ห้องมีราคาพิเศษแต่ไม่ระบุเหตุผล`,
      detail: 'แนะนำให้ใส่ "เหตุผล" ใน rent_override_reason — ช่วยให้ admin คนถัดมาเข้าใจที่มา',
      count: orphanOverride.rows.length,
      items: orphanOverride.rows.slice(0, 10).map((r) => ({ id: r.room_code, label: `ห้อง ${r.room_code} = ฿${r.rent_override} (ตั้งโดย ${r.rent_override_by || 'unknown'})` })),
      fix: '/admin#rooms',
    });
  }
  // Rooms occupied/overdue but no active tenant
  const ghostOccupied = await pool.query(`
    SELECT rv.room_code, rv.status
      FROM rooms_v2 rv
     WHERE rv.deleted_at IS NULL
       AND rv.status IN ('occupied','overdue')
       AND NOT EXISTS (
         SELECT 1 FROM tenants t
          WHERE t.deleted_at IS NULL AND t.status='active' AND t.current_room_id=rv.room_code
       )
     LIMIT 20`);
  if (ghostOccupied.rows.length) {
    items.push({
      id: 'ROOM_GHOST_OCCUPIED',
      severity: 'warn',
      domain: 'room',
      message: `${ghostOccupied.rows.length} ห้องสถานะ occupied แต่ไม่มีผู้เช่า`,
      detail: 'ผู้เช่าย้ายออกแต่ admin ไม่ได้ปรับสถานะห้อง — ใช้ปุ่ม "Reconcile" ในหน้าห้อง',
      count: ghostOccupied.rows.length,
      items: ghostOccupied.rows.slice(0, 10).map((r) => ({ id: r.room_code, label: `ห้อง ${r.room_code} status=${r.status}` })),
      fix: '/admin#rooms',
    });
  }
  // Legacy JSONB room card still has a tenant snapshot, but no active tenant
  // currently points at that room. This is the exact "moved out, paid final
  // bill, but rooms still shows old tenant data" drift.
  const blobGhostTenant = await pool.query(`
    WITH blob_rooms AS (
      SELECT rec.key AS room_code, rec.val AS room
        FROM app_data ad
        CROSS JOIN LATERAL jsonb_each(ad.value) AS rec(key, val)
       WHERE ad.key='baankarn_rooms_v1'
         AND jsonb_typeof(ad.value)='object'
    )
    SELECT br.room_code, br.room->>'status' AS status
      FROM blob_rooms br
     WHERE br.room ? 'tenant'
       AND br.room->'tenant' IS NOT NULL
       AND br.room->'tenant' <> 'null'::jsonb
       AND br.room->'tenant' <> '{}'::jsonb
       AND NOT EXISTS (
         SELECT 1 FROM tenants t
          WHERE t.deleted_at IS NULL
            AND t.status='active'
            AND t.current_room_id=br.room_code
       )
     LIMIT 20`);
  if (blobGhostTenant.rows.length) {
    items.push({
      id: 'ROOM_BLOB_STALE_TENANT',
      severity: 'warn',
      domain: 'room',
      message: `${blobGhostTenant.rows.length} room card(s) still show stale tenant data`,
      detail: 'The room JSONB card has room.tenant, but no active tenant currently points at that room. Run room reconcile; payment/checkout sync now scrubs this automatically.',
      count: blobGhostTenant.rows.length,
      items: blobGhostTenant.rows.slice(0, 10).map((r) => ({ id: r.room_code, label: `room ${r.room_code} status=${r.status || '-'}` })),
      fix: '/admin#rooms',
    });
  }
  return items;
}

// 6. Payment anomalies — verified-but-bill-unpaid, stuck pending slips.
async function detectPaymentAnomalies(pool) {
  const items = [];
  const stuck = await pool.query(`
    SELECT p.id, p.bill_id, p.amount::numeric AS amount, p.created_at::date AS d, b.bill_no
      FROM payments p JOIN bills b ON b.id=p.bill_id
     WHERE p.status='pending' AND p.created_at < NOW() - INTERVAL '48 hours'
     ORDER BY p.created_at ASC LIMIT 20`);
  if (stuck.rows.length) {
    items.push({
      id: 'PAYMENT_STUCK_PENDING',
      severity: 'warn',
      domain: 'payment',
      message: `${stuck.rows.length} สลิปค้าง pending > 48 ชั่วโมง`,
      detail: 'สลิปที่อัปโหลดแล้วยังไม่ได้รับการตรวจสอบ — ผู้เช่าอาจรอนาน ตรวจสอบให้ครบ',
      count: stuck.rows.length,
      items: stuck.rows.slice(0, 10).map((p) => ({ id: p.id, label: `payment id=${p.id} bill=${p.bill_no} ฿${p.amount} (อัปโหลด ${p.d})` })),
      fix: '/admin#payments',
    });
  }
  return items;
}

// === RUN ALL ==============================================================
const DETECTORS = [
  { id: 'pricing',   fn: detectPricingConfig },
  { id: 'bill',      fn: detectBillAnomalies },
  { id: 'tenant',    fn: detectTenantAnomalies },
  { id: 'contract',  fn: detectContractAnomalies },
  { id: 'room',      fn: detectRoomAnomalies },
  { id: 'payment',   fn: detectPaymentAnomalies },
];

async function scan(pool) {
  const all = [];
  for (const d of DETECTORS) {
    try {
      const found = await d.fn(pool);
      if (Array.isArray(found)) all.push(...found);
    } catch (err) {
      all.push({
        id: 'SCAN_FAILED_' + d.id.toUpperCase(),
        severity: 'warn',
        domain: 'system',
        message: `ตรวจ ${d.id} ไม่สำเร็จ`,
        detail: err.message,
        count: 1, items: [],
        fix: '/admin#health',
      });
    }
  }
  const summary = { critical: 0, warn: 0, info: 0, total: all.length };
  for (const a of all) summary[a.severity] = (summary[a.severity] || 0) + 1;
  return {
    scannedAt: new Date().toISOString(),
    summary,
    items: all.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]),
  };
}

module.exports = { scan, DETECTORS, SEVERITY_RANK };
