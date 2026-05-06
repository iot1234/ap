// === admin/shared.jsx =====================================================
// ค่าคงที่ทั้งหมด, ข้อมูลตัวอย่าง, ฟังก์ชันช่วย, localStorage layer
// โหลดเป็นไฟล์แรก — ไฟล์อื่นๆ เรียกใช้ผ่าน window.X
// ===========================================================================

// --- Color palette --------------------------------------------------------
const ADMIN_C = {
  bg:          '#f5efe3',
  surface:     '#ffffff',
  surfaceAlt:  '#faf6ee',
  surfaceMuted:'#f7f0e1',
  ink:         '#2c241b',
  ink2:        '#5b4f40',
  muted:       '#8a7d6b',
  border:      '#ece4d4',
  borderSoft:  '#f3ece0',
  borderStrong:'#dccfb6',
  accent:      '#c46a3e',
  accentDark:  '#a4542d',
  accentSoft:  '#f8e8db',
  accentInk:   '#7a3a1a',
  dark:        '#2c241b',

  // Sidebar (dark theme)
  navBg:       '#1f1813',
  navBgAlt:    '#181210',
  navInk:      '#ebe1cc',
  navInkSoft:  '#bcaf95',
  navMuted:    '#7a6e58',
  navBorder:   '#2d231a',
  navHover:    '#2a201a',
  navActive:   '#3a2d20',
  navAccent:   '#e08a5a',

  // Status semantic
  success:     '#2e9b6a', successSoft: '#e6f4ec', successInk: '#0e3a25',
  warning:     '#c98a2b', warningSoft: '#fbf1de', warningInk: '#5a3a0d',
  danger:      '#b54639', dangerSoft:  '#f9e7e3', dangerInk:  '#5a1a13',
  info:        '#3a6b8a', infoSoft:    '#e3edf5', infoInk:    '#1c3850',
  neutral:     '#5b4f40', neutralSoft: '#eef1f5', neutralInk: '#1f2937',
  purple:      '#7a4f8a', purpleSoft:  '#efe6f3', purpleInk:  '#3a1d44',
};

// --- Status definitions ---------------------------------------------------
const ADMIN_STATUS = {
  vacant:     { th: 'ว่าง',       en: 'Vacant',      dot: '#2e9b6a', soft: '#e6f4ec', ink: '#0e3a25' },
  occupied:   { th: 'มีผู้เช่า',  en: 'Occupied',    dot: '#475569', soft: '#eef1f5', ink: '#1f2937' },
  reserved:   { th: 'จองแล้ว',    en: 'Reserved',    dot: '#c98a2b', soft: '#fbf1de', ink: '#5a3a0d' },
  overdue:    { th: 'ค้างชำระ',  en: 'Overdue',     dot: '#b54639', soft: '#f9e7e3', ink: '#5a1a13' },
  maintenance:{ th: 'ปรับปรุง',  en: 'Maintenance', dot: '#7a6c54', soft: '#efeae0', ink: '#3a3326' },
};
const ADMIN_STATUS_KEYS = ['vacant', 'occupied', 'reserved', 'overdue', 'maintenance'];

// --- Room types -----------------------------------------------------------
const ADMIN_ROOM_TYPES = {
  standard: { th: 'ห้องมาตรฐาน',     size: 24, baseRent: 4500, beds: 1, ac: false, accent: '#9c8970' },
  deluxe:   { th: 'ห้องดีลักซ์',      size: 28, baseRent: 5800, beds: 1, ac: true,  accent: '#c46a3e' },
  suite:    { th: 'ห้องสวีท',           size: 36, baseRent: 7500, beds: 2, ac: true,  accent: '#7a4f8a' },
  studio:   { th: 'สตูดิโอพรีเมียม',  size: 32, baseRent: 6800, beds: 1, ac: true,  accent: '#3a6b8a' },
};
const ADMIN_ROOM_TYPE_KEYS = ['standard', 'deluxe', 'suite', 'studio'];

// --- Sample tenants -------------------------------------------------------
const ADMIN_TENANTS = [
  { name: 'คุณสมศรี ใจดี',       occupation: 'นักศึกษา ม.เชียงใหม่ ปี 3', phone: '081-234-5678', email: 'somsri.j@gmail.com',  score: 'A' },
  { name: 'คุณวีรพล อนันต์',     occupation: 'พนักงานออฟฟิศ บ.NTT',         phone: '082-345-6789', email: 'verapon.a@ntt.co.th', score: 'A' },
  { name: 'คุณอารยา สุวรรณ',     occupation: 'นศ.ปริญญาโท วิศวกรรมฯ',       phone: '083-456-7890', email: 'araya.s@cmu.ac.th',   score: 'A' },
  { name: 'คุณธนภัทร เจริญสุข',  occupation: 'ฟรีแลนซ์ดีไซเนอร์',           phone: '084-567-8901', email: 'thanapat.c@gmail.com',score: 'B' },
  { name: 'คุณพิมพ์ชนก ทวีสุข',  occupation: 'แพทย์ใช้ทุน รพ.มหาราช',     phone: '085-678-9012', email: 'pimchanok.t@hotmail.com', score: 'A' },
  { name: 'คุณกิตติ ศรีสุข',       occupation: 'วิศวกรซอฟต์แวร์',              phone: '086-789-0123', email: 'kitti.s@dev.com',     score: 'A' },
  { name: 'คุณนิภาพร วงษา',     occupation: 'อาจารย์มหาวิทยาลัย',         phone: '087-890-1234', email: 'nipaporn.w@cmu.ac.th',score: 'A' },
  { name: 'คุณภูมิ สถาพร',         occupation: 'นักศึกษา ปี 2',                  phone: '088-901-2345', email: 'phum.s@student.cmu.ac.th', score: 'B' },
  { name: 'คุณชลธิชา รุ่งเรือง',  occupation: 'พยาบาลวิชาชีพ',                phone: '089-012-3456', email: 'chonticha.r@gmail.com', score: 'A' },
  { name: 'คุณอนุชา ชัยวัฒน์',   occupation: 'เจ้าหน้าที่ราชการ',             phone: '090-123-4567', email: 'anucha.c@cmu.go.th',  score: 'A' },
  { name: 'คุณสุพิชชา เกษมสุข',  occupation: 'นศ.ปริญญาเอก',                  phone: '091-234-5678', email: 'supitcha.k@cmu.ac.th',score: 'A' },
  { name: 'คุณรณกร ภักดี',         occupation: 'พนักงานธนาคาร',                phone: '092-345-6789', email: 'ronakorn.p@scb.co.th',score: 'B' },
];

// --- View premium options -------------------------------------------------
const ADMIN_VIEWS = ['วิวภูเขา', 'วิวเมือง', 'วิวสวน', 'วิวถนน'];

// --- Default config (pricing engine) -------------------------------------
const DEFAULT_CONFIG = {
  rates: {
    standard: { rent: 4500, deposit: 9000 },
    deluxe:   { rent: 5800, deposit: 11600 },
    suite:    { rent: 7500, deposit: 15000 },
    studio:   { rent: 6800, deposit: 13600 },
  },
  floorPremium: { 1: 0, 2: 200, 3: 400, 4: 600, 5: 900 },
  viewPremium:  { 'วิวภูเขา': 500, 'วิวเมือง': 300, 'วิวสวน': 200, 'วิวถนน': 0 },
  featurePremium: { balcony: 300, ac: 400, parking: 500, kitchen: 600 },
  utilities: {
    waterRate: 18, elecRate: 8, wifi: 250,
    waterMin: 0, elecMin: 0,
    commonFee: 200,
  },
  discounts: {
    sixMonth: 5, twelveMonth: 10, twentyFourMonth: 15,
    firstMonth: 0, referral: 500, loyaltyPerYear: 200,
  },
  fees: {
    contract: 500, cleaning: 1500, latePenaltyPerDay: 50,
    rekey: 300, parkingMonthly: 0,
  },
  building: {
    name:    'บ้านกาญจน์ เรสซิเดนซ์',
    address: '123/45 ถ.นิมมานเหมินทร์ ต.สุเทพ อ.เมือง จ.เชียงใหม่ 50200',
    phone:   '053-123-4567',
    email:   'baankarn.cnx@gmail.com',
    line:    '@baankarn',
    floors:  5,
    roomsPerFloor: 8,
    open:    '24 ชั่วโมง',
    rules:   'ห้ามสูบบุหรี่และเลี้ยงสัตว์ในห้องพัก',
  },
  payment: {
    promptpay:  '0801234567',
    bank:       'ไทยพาณิชย์',
    bankAcc:    '123-456789-0',
    bankName:   'นางกาญจนา ศรีสุข',
    linePay:    false,
    truemoney:  false,
    creditCard: false,
  },
  notify: {
    billOnDay: 1, dueOnDay: 7,
    reminder1: 5, reminder2: 10,
    contractEndDays: 30,
    channels: { line: true, email: true, sms: false },
  },
  automation: {
    autoBill:        true,
    autoReminder:    true,
    autoLatePenalty: true,
    autoBackup:      true,
    backupHour:      3,
  },
};

// --- Helper functions -----------------------------------------------------
function fmt(n) {
  if (n == null || isNaN(n)) return '0';
  return Number(n).toLocaleString('th-TH');
}
function fmtCurrency(n) { return '฿' + fmt(Math.round(n || 0)); }
function fmtPercent(n) { return Math.round(n) + '%'; }
function fmtDateTH(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return '-';
  const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  return `${dt.getDate()} ${months[dt.getMonth()]} ${dt.getFullYear() + 543}`;
}
function fmtMonthTH(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return '-';
  const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  return `${months[dt.getMonth()]} ${dt.getFullYear() + 543}`;
}
function relTime(iso) {
  const dt = new Date(iso);
  const diffMs = Date.now() - dt.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1)  return 'เมื่อกี้';
  if (min < 60) return `${min} นาทีก่อน`;
  const hr = Math.floor(min / 60);
  if (hr < 24)  return `${hr} ชั่วโมงก่อน`;
  const d  = Math.floor(hr / 24);
  if (d < 7)    return `${d} วันก่อน`;
  if (d < 30)   return `${Math.floor(d/7)} สัปดาห์ก่อน`;
  return fmtDateTH(dt);
}
function seedRand(seed) { const x = Math.sin(seed) * 10000; return x - Math.floor(x); }

// --- Data builder ---------------------------------------------------------
// บางห้องถูก force ให้สถานะเฉพาะ เพื่อ demo ให้เห็นทุกสถานะอย่างน้อย 1 ห้อง
const FORCED_STATUS = {
  '207': 'overdue',
  '305': 'overdue',
  '405': 'overdue',
  '102': 'reserved',
  '503': 'reserved',
  '408': 'maintenance',
  '502': 'maintenance',
};

function buildAdminRooms() {
  const rooms = {};
  [1,2,3,4,5].forEach(f => {
    for (let r = 1; r <= 8; r++) {
      const id = `${f}${r.toString().padStart(2,'0')}`;
      const seed = f * 17 + r * 31;
      const rnd  = seedRand(seed);
      const rnd2 = seedRand(seed + 7);

      let type = 'standard';
      if (f === 5 && rnd > 0.3)         type = 'studio';
      else if (f >= 4 && rnd > 0.5)     type = 'suite';
      else if (f >= 3 && rnd > 0.55)    type = 'deluxe';
      else if (rnd > 0.78)              type = 'deluxe';

      let status;
      if (rnd2 < 0.32)      status = 'vacant';
      else if (rnd2 < 0.82) status = 'occupied';
      else if (rnd2 < 0.90) status = 'reserved';
      else if (rnd2 < 0.96) status = 'overdue';
      else                  status = 'maintenance';

      // Force specific rooms to ensure all statuses are represented in demo
      if (FORCED_STATUS[id]) status = FORCED_STATUS[id];

      const t = ADMIN_ROOM_TYPES[type];
      const rent = t.baseRent + (f - 1) * 200;
      const tIdx = Math.floor(seedRand(seed + 13) * ADMIN_TENANTS.length);
      const tenant = (status === 'occupied' || status === 'overdue' || status === 'reserved')
        ? { ...ADMIN_TENANTS[tIdx] } : null;

      const monthsTH = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
      const sinceDay = 1 + Math.floor(seedRand(seed+19)*28);
      const sinceMo  = Math.floor(seedRand(seed+23)*12);
      const sinceYr  = 2565 + Math.floor(seedRand(seed+29)*4);
      const since    = tenant ? `${sinceDay} ${monthsTH[sinceMo]} ${sinceYr}` : null;

      const waterUnits = Math.round(8 + seedRand(seed+37)*22);
      const elecUnits  = Math.round(40 + seedRand(seed+41)*120);

      rooms[id] = {
        id, floor: f, no: r, type, status, rent,
        tenant, since,
        deposit: rent * 2,
        water:    waterUnits * 18,
        elec:     elecUnits  * 8,
        waterUnits, elecUnits,
        wifi:     250,
        contractEnd: tenant
          ? `${15 + Math.floor(seedRand(seed+43)*15)}/${1+Math.floor(seedRand(seed+47)*12)}/${2567 + Math.floor(seedRand(seed+53)*3)}`
          : null,
        photos:  [],
        notes:   '',
        view:    f >= 3 ? (r <= 4 ? 'วิวภูเขา' : 'วิวเมือง') : (r <= 4 ? 'วิวสวน' : 'วิวถนน'),
        balcony: type !== 'standard',
        parking: type === 'suite' || type === 'studio',
        kitchen: type === 'suite',
        lastCleaned: `${1 + Math.floor(seedRand(seed+59)*28)} เม.ย. 2569`,
        lastBillDate: status === 'occupied' || status === 'overdue'
          ? `1 พ.ค. 2569` : null,
        billStatus: status === 'overdue' ? 'unpaid' : (status === 'occupied' ? 'paid' : 'none'),
        overdueDays: status === 'overdue' ? Math.ceil(seedRand(seed+61)*14) + 3 : 0,
      };
    }
  });
  return rooms;
}

// --- Sample bookings (pending approvals) ---------------------------------
function buildBookings() {
  return [
    { id: 'BK-2569-0123', name: 'คุณนภัสสร พันธ์ทอง',  phone: '094-321-0987', wantType: 'deluxe',   wantFloor: 3, moveIn: '2569-05-15', months: 12, deposit: 11600, status: 'pending',  createdAt: '2026-05-01T09:32:00' },
    { id: 'BK-2569-0124', name: 'คุณภัทรพล อิ่มสุข',    phone: '095-222-1188', wantType: 'standard', wantFloor: 2, moveIn: '2569-05-20', months: 6,  deposit: 9000,  status: 'pending',  createdAt: '2026-05-01T14:08:00' },
    { id: 'BK-2569-0125', name: 'คุณกานต์ธิดา ดวงใจ',  phone: '096-543-7766', wantType: 'studio',   wantFloor: 5, moveIn: '2569-06-01', months: 12, deposit: 13600, status: 'reviewing', createdAt: '2026-05-02T10:12:00' },
    { id: 'BK-2569-0126', name: 'คุณชนาธิป สถิตย์',    phone: '097-808-4422', wantType: 'suite',    wantFloor: 4, moveIn: '2569-05-25', months: 24, deposit: 15000, status: 'pending',  createdAt: '2026-05-02T15:45:00' },
    { id: 'BK-2569-0127', name: 'คุณวรางคณา รักดี',    phone: '098-111-2233', wantType: 'standard', wantFloor: 1, moveIn: '2569-05-10', months: 12, deposit: 9000,  status: 'approved', createdAt: '2026-04-29T08:12:00' },
  ];
}

// --- Sample activities (audit log / activity feed) ------------------------
function buildActivities() {
  const now = Date.now();
  const ago = (m) => new Date(now - m*60000).toISOString();
  return [
    { time: ago(8),    type: 'payment', text: 'รับชำระบิลห้อง 305 จำนวน ฿7,420', icon: '💳' },
    { time: ago(45),   type: 'booking', text: 'การจองใหม่ #BK-2569-0126 จากคุณชนาธิป', icon: '📋' },
    { time: ago(120),  type: 'maint',   text: 'แจ้งซ่อมแอร์ห้อง 408 จากผู้เช่า', icon: '🔧' },
    { time: ago(240),  type: 'payment', text: 'รับชำระบิลห้อง 201 จำนวน ฿5,920', icon: '💳' },
    { time: ago(720),  type: 'contract',text: 'สัญญาห้อง 502 ใกล้หมดอายุ (อีก 30 วัน)', icon: '📄' },
    { time: ago(1440), type: 'tenant',  text: 'อนุมัติผู้เช่าใหม่ห้อง 103 — คุณวรางคณา', icon: '👤' },
    { time: ago(2880), type: 'system',  text: 'ระบบสำรองข้อมูลรายวันสำเร็จ', icon: '💾' },
    { time: ago(4320), type: 'overdue', text: 'แจ้งเตือนค้างชำระห้อง 207 (ครั้งที่ 2)', icon: '⚠️' },
  ];
}

// --- localStorage layer ---------------------------------------------------
const STORAGE_KEYS = {
  rooms:      'baankarn_rooms_v1',
  config:     'baankarn_config_v1',
  bookings:   'baankarn_bookings_v1',
  activities: 'baankarn_activities_v1',
  users:      'baankarn_users_v1',
};

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch (e) { return fallback; }
}
function loadRooms() {
  if (typeof localStorage === 'undefined') return buildAdminRooms();
  const raw = localStorage.getItem(STORAGE_KEYS.rooms);
  if (!raw) return buildAdminRooms();
  const parsed = safeParse(raw, null);
  return parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0
    ? parsed : buildAdminRooms();
}
function saveRooms(rooms) {
  try { localStorage.setItem(STORAGE_KEYS.rooms, JSON.stringify(rooms)); }
  catch (e) { console.warn('saveRooms failed', e); }
}
function loadConfig() {
  if (typeof localStorage === 'undefined') return DEFAULT_CONFIG;
  const raw = localStorage.getItem(STORAGE_KEYS.config);
  if (!raw) return DEFAULT_CONFIG;
  const parsed = safeParse(raw, null);
  return parsed ? deepMerge(DEFAULT_CONFIG, parsed) : DEFAULT_CONFIG;
}
function saveConfig(cfg) {
  try { localStorage.setItem(STORAGE_KEYS.config, JSON.stringify(cfg)); }
  catch (e) { console.warn('saveConfig failed', e); }
}
function loadBookings() {
  if (typeof localStorage === 'undefined') return buildBookings();
  const raw = localStorage.getItem(STORAGE_KEYS.bookings);
  if (!raw) return buildBookings();
  return safeParse(raw, buildBookings());
}
function saveBookings(b) {
  try { localStorage.setItem(STORAGE_KEYS.bookings, JSON.stringify(b)); }
  catch (e) { console.warn('saveBookings failed', e); }
}
function loadActivities() {
  if (typeof localStorage === 'undefined') return buildActivities();
  const raw = localStorage.getItem(STORAGE_KEYS.activities);
  if (!raw) return buildActivities();
  return safeParse(raw, buildActivities());
}
function saveActivities(a) {
  try { localStorage.setItem(STORAGE_KEYS.activities, JSON.stringify(a)); }
  catch (e) { console.warn('saveActivities failed', e); }
}
function resetAll() {
  try {
    Object.values(STORAGE_KEYS).forEach(k => localStorage.removeItem(k));
  } catch (e) {}
}

function deepMerge(a, b) {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return b ?? a;
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return b ?? a;
  const out = { ...a };
  Object.keys(b).forEach(k => { out[k] = deepMerge(a[k], b[k]); });
  return out;
}

// --- Computed price for a single room (used by Pricing preview) -----------
function computeRoomRent(type, floor, view, features, config) {
  const base    = (config.rates[type] || {}).rent || ADMIN_ROOM_TYPES[type].baseRent;
  const fp      = config.floorPremium[floor] || 0;
  const vp      = config.viewPremium[view]   || 0;
  const balcony = features?.balcony ? (config.featurePremium.balcony || 0) : 0;
  const ac      = features?.ac      ? (config.featurePremium.ac      || 0) : 0;
  const parking = features?.parking ? (config.featurePremium.parking || 0) : 0;
  const kitchen = features?.kitchen ? (config.featurePremium.kitchen || 0) : 0;
  return base + fp + vp + balcony + ac + parking + kitchen;
}

// --- Aggregate stats for dashboard ----------------------------------------
// ใช้ config มา recompute ค่าน้ำ/ค่าไฟ ตามเรทปัจจุบัน (ไม่ใช่ที่ฝังในห้อง)
function computeStats(rooms, config) {
  const list = Object.values(rooms);
  const total = list.length;
  const counts = { vacant: 0, occupied: 0, reserved: 0, overdue: 0, maintenance: 0 };
  let revenue = 0, overdueAmt = 0;
  const waterRate = config?.utilities?.waterRate ?? 18;
  const elecRate  = config?.utilities?.elecRate  ?? 8;
  const wifiFee   = config?.utilities?.wifi      ?? 250;
  list.forEach(r => {
    counts[r.status] = (counts[r.status] || 0) + 1;
    if (r.status === 'occupied' || r.status === 'overdue') {
      const water = (r.waterUnits || 0) * waterRate;
      const elec  = (r.elecUnits  || 0) * elecRate;
      const wifi  = (r.wifi != null && r.wifi !== 0) ? r.wifi : wifiFee;
      const t = (r.rent || 0) + water + elec + wifi;
      revenue += t;
      if (r.status === 'overdue') overdueAmt += t;
    }
  });
  const occupancy = total ? Math.round(((counts.occupied + counts.overdue + counts.reserved) / total) * 100) : 0;
  return { total, counts, revenue, overdueAmt, occupancy };
}

// --- File export/import helpers ------------------------------------------
function downloadFile(filename, content, mime) {
  try {
    const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 500);
    return true;
  } catch (e) { console.warn('downloadFile failed', e); return false; }
}
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function exportCSV(filename, rows, columns) {
  // columns = [{ key, label?, get?(row) }]
  const header = columns.map(c => csvEscape(c.label || c.key)).join(',');
  const body = rows.map(r => columns.map(c => csvEscape(c.get ? c.get(r) : r[c.key])).join(',')).join('\r\n');
  // ﻿ = BOM for Excel to recognize UTF-8 (Thai characters)
  return downloadFile(filename, '﻿' + header + '\r\n' + body, 'text/csv;charset=utf-8');
}
function exportJSON(filename, data) {
  return downloadFile(filename, JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
}
function importJSON(callback, onError) {
  try {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try { callback(JSON.parse(reader.result)); }
        catch (err) { onError ? onError(err) : alert('ไฟล์ไม่ถูกต้อง: ' + err.message); }
      };
      reader.onerror = () => onError ? onError(reader.error) : alert('อ่านไฟล์ไม่ได้');
      reader.readAsText(file);
    };
    inp.click();
  } catch (e) { onError && onError(e); }
}

// Quick CSV export builders (so each page doesn't have to duplicate column mapping)
function exportRoomsCSV(rooms) {
  const list = Object.values(rooms).sort((a,b) => a.id.localeCompare(b.id));
  return exportCSV('rooms_' + new Date().toISOString().slice(0,10) + '.csv', list, [
    { key: 'id',          label: 'เลขห้อง' },
    { key: 'floor',       label: 'ชั้น' },
    { key: 'type',        label: 'ประเภท', get: r => ADMIN_ROOM_TYPES[r.type]?.th || r.type },
    { key: 'status',      label: 'สถานะ',  get: r => ADMIN_STATUS[r.status]?.th || r.status },
    { key: 'rent',        label: 'ค่าเช่า' },
    { key: 'deposit',     label: 'มัดจำ' },
    { key: 'view',        label: 'วิว' },
    { key: 'balcony',     label: 'ระเบียง', get: r => r.balcony ? 'มี' : 'ไม่มี' },
    { key: 'parking',     label: 'ที่จอดรถ', get: r => r.parking ? 'มี' : 'ไม่มี' },
    { key: 'tenantName',  label: 'ผู้เช่า', get: r => r.tenant?.name || '' },
    { key: 'tenantPhone', label: 'เบอร์โทร', get: r => r.tenant?.phone || '' },
    { key: 'tenantEmail', label: 'อีเมล',     get: r => r.tenant?.email || '' },
    { key: 'since',       label: 'เข้าพัก' },
    { key: 'contractEnd', label: 'สิ้นสุดสัญญา' },
    { key: 'waterUnits',  label: 'น้ำ(หน่วย)' },
    { key: 'elecUnits',   label: 'ไฟ(หน่วย)' },
    { key: 'wifi',        label: 'wifi' },
    { key: 'notes',       label: 'หมายเหตุ' },
  ]);
}
function exportTenantsCSV(rooms) {
  const list = Object.values(rooms).filter(r => r.tenant);
  return exportCSV('tenants_' + new Date().toISOString().slice(0,10) + '.csv', list, [
    { key: 'name',        label: 'ชื่อ',          get: r => r.tenant.name },
    { key: 'occupation',  label: 'อาชีพ',        get: r => r.tenant.occupation },
    { key: 'phone',       label: 'เบอร์โทร',     get: r => r.tenant.phone },
    { key: 'email',       label: 'อีเมล',          get: r => r.tenant.email },
    { key: 'roomId',      label: 'เลขห้อง',     get: r => r.id },
    { key: 'floor',       label: 'ชั้น' },
    { key: 'rent',        label: 'ค่าเช่า' },
    { key: 'since',       label: 'เข้าพักตั้งแต่' },
    { key: 'contractEnd', label: 'สิ้นสุดสัญญา' },
    { key: 'score',       label: 'เครดิต',         get: r => r.tenant.score },
    { key: 'status',      label: 'สถานะ',         get: r => ADMIN_STATUS[r.status]?.th || r.status },
  ]);
}
function exportBookingsCSV(bookings) {
  return exportCSV('bookings_' + new Date().toISOString().slice(0,10) + '.csv', bookings, [
    { key: 'id',         label: 'รหัสจอง' },
    { key: 'name',       label: 'ผู้จอง' },
    { key: 'phone',      label: 'เบอร์โทร' },
    { key: 'wantType',   label: 'ประเภทห้อง', get: b => ADMIN_ROOM_TYPES[b.wantType]?.th },
    { key: 'wantFloor',  label: 'ชั้น' },
    { key: 'months',     label: 'ระยะเวลา(เดือน)' },
    { key: 'moveIn',     label: 'วันที่ย้ายเข้า' },
    { key: 'deposit',    label: 'มัดจำ' },
    { key: 'status',     label: 'สถานะ' },
    { key: 'createdAt',  label: 'จองเมื่อ' },
  ]);
}
function exportBillsCSV(bills) {
  return exportCSV('bills_' + new Date().toISOString().slice(0,10) + '.csv', bills, [
    { key: 'id',          label: 'เลขที่บิล' },
    { key: 'roomId',      label: 'ห้อง' },
    { key: 'tenant',      label: 'ผู้เช่า' },
    { key: 'phone',       label: 'เบอร์โทร' },
    { key: 'period',      label: 'งวด' },
    { key: 'rent',        label: 'ค่าเช่า' },
    { key: 'water',       label: 'ค่าน้ำ' },
    { key: 'elec',        label: 'ค่าไฟ' },
    { key: 'wifi',        label: 'wifi' },
    { key: 'penalty',     label: 'ค่าปรับ' },
    { key: 'total',       label: 'รวม' },
    { key: 'dueDate',     label: 'ครบกำหนด' },
    { key: 'status',      label: 'สถานะ' },
    { key: 'overdueDays', label: 'วันที่ค้าง' },
  ]);
}
function exportFullBackup(rooms, config, bookings, activities) {
  return exportJSON('baankarn_backup_' + new Date().toISOString().slice(0,10) + '.json', {
    version: 1,
    exportedAt: new Date().toISOString(),
    rooms, config, bookings, activities,
  });
}

// Print helper — opens print dialog (browser will save to PDF)
function printPage() { try { window.print(); return true; } catch (e) { return false; } }

// --- Expose to window -----------------------------------------------------
Object.assign(window, {
  ADMIN_C, ADMIN_STATUS, ADMIN_STATUS_KEYS,
  ADMIN_ROOM_TYPES, ADMIN_ROOM_TYPE_KEYS,
  ADMIN_TENANTS, ADMIN_VIEWS,
  DEFAULT_CONFIG, STORAGE_KEYS,
  fmt, fmtCurrency, fmtPercent, fmtDateTH, fmtMonthTH, relTime, seedRand,
  buildAdminRooms, buildBookings, buildActivities,
  loadRooms, saveRooms, loadConfig, saveConfig,
  loadBookings, saveBookings, loadActivities, saveActivities,
  resetAll, deepMerge,
  computeRoomRent, computeStats,
  // export/import
  downloadFile, exportCSV, exportJSON, importJSON,
  exportRoomsCSV, exportTenantsCSV, exportBookingsCSV, exportBillsCSV, exportFullBackup,
  printPage,
});
