// === admin/shared.jsx =====================================================
// ค่าคงที่ทั้งหมด, ข้อมูลตัวอย่าง, ฟังก์ชันช่วย, localStorage layer
// โหลดเป็นไฟล์แรก — ไฟล์อื่นๆ เรียกใช้ผ่าน window.X
// ===========================================================================

// --- Color palette --------------------------------------------------------
// Updated 2026-05 to match the Admin Console redesign:
//   - cool surfaces (was warm beige) with clean white cards
//   - blue accent (was orange) sourced from the 'rooms' category hue
//   - dark navy sidebar (was dark brown)
//   - status colors from the same lightness/chroma family so the UI
//     feels unified instead of one tone fighting another
// Key NAMES are unchanged so the 31 pages that consume ADMIN_C continue
// to render without edits — only the values shift.
const ADMIN_C = {
  bg:          '#F5F6FA',
  surface:     '#FFFFFF',
  surfaceAlt:  '#F9FAFC',
  surfaceMuted:'#F0F2F7',
  ink:         '#0B1220',
  ink2:        '#2A3142',
  muted:       '#6B7280',
  border:      '#E5E8EF',
  borderSoft:  '#EFF1F6',
  borderStrong:'#CFD3DE',
  accent:      '#2563EB',
  accentDark:  '#1D4ED8',
  accentSoft:  '#E8F0FE',
  accentInk:   '#1E3A8A',
  dark:        '#0B1220',

  // Sidebar (dark navy theme — was dark brown)
  navBg:       '#0B1220',
  navBgAlt:    '#131B2C',
  navInk:      '#E8EBF0',
  navInkSoft:  '#B5BCC9',
  navMuted:    '#6F7787',
  navBorder:   'rgba(255,255,255,0.07)',
  navHover:    'rgba(255,255,255,0.045)',
  navActive:   'rgba(37,99,235,0.18)',
  navAccent:   '#2563EB',

  // Status semantic — pulled from same family as category palette
  success:     '#059669', successSoft: '#E3F5EC', successInk: '#064E3B',
  warning:     '#D97706', warningSoft: '#FCEFDB', warningInk: '#78350F',
  danger:      '#DC2626', dangerSoft:  '#FCE7E7', dangerInk:  '#7F1D1D',
  info:        '#2563EB', infoSoft:    '#E8F0FE', infoInk:    '#1E3A8A',
  neutral:     '#475569', neutralSoft: '#EEF1F5', neutralInk: '#1F2937',
  purple:      '#7C3AED', purpleSoft:  '#EFE7FB', purpleInk:  '#4C1D95',
};

// --- Categorical tone tokens ----------------------------------------------
// Each admin section maps to ONE category. Components that take a `tone`
// prop pull color + soft from here so the whole page (header rail, badge,
// active button, list dot) shares a single hue. Unified palette →
// admin instantly knows which area they're in without reading labels.
const TONES = {
  overview: { color: '#475569', soft: '#EEF1F5', label: 'ภาพรวม' },
  rooms:    { color: '#2563EB', soft: '#E8F0FE', label: 'ห้องพัก & ผู้เช่า' },
  finance:  { color: '#059669', soft: '#E3F5EC', label: 'การเงิน' },
  service:  { color: '#D97706', soft: '#FCEFDB', label: 'บริการ' },
  system:   { color: '#7C3AED', soft: '#EFE7FB', label: 'ระบบ' },
};

// Single source of truth: page id → category tone.
// Pages added in the future should be registered here too.
const PAGE_TONE = {
  // Overview
  overview: 'overview', health: 'overview', 'production-readiness': 'overview',
  // Rooms & tenants
  rooms: 'rooms', tenants: 'rooms', bookings: 'rooms', 'booking-deposit-settings': 'rooms',
  contracts: 'rooms', 'contract-templates': 'rooms', 'contract-invitations': 'rooms',
  'line-bindings': 'rooms', 'line-oas': 'rooms',
  // Finance
  billing: 'finance', payments: 'finance', 'slip-verify': 'finance',
  pricing: 'finance', recurring: 'finance', 'recurring-charges': 'finance',
  reports: 'finance', 'reports-v2': 'finance',
  // Service
  maintenance: 'service', parcels: 'service', meters: 'service',
  access: 'service', 'access-devices': 'service',
  // System
  notifications: 'system', 'notifications-queue': 'system',
  'security-events': 'system',
  features: 'system', secrets: 'system', settings: 'system',
};

// --- Status definitions ---------------------------------------------------
// Colors updated to match the redesign palette — same family as ADMIN_C
// status tokens so badges, dots, and inks stay coherent.
const ADMIN_STATUS = {
  vacant:     { th: 'ว่าง',       en: 'Vacant',      dot: '#059669', soft: '#E3F5EC', ink: '#064E3B' },
  occupied:   { th: 'มีผู้เช่า',  en: 'Occupied',    dot: '#2563EB', soft: '#E8F0FE', ink: '#1E3A8A' },
  reserved:   { th: 'จองแล้ว',    en: 'Reserved',    dot: '#D97706', soft: '#FCEFDB', ink: '#78350F' },
  overdue:    { th: 'ค้างชำระ',  en: 'Overdue',     dot: '#DC2626', soft: '#FCE7E7', ink: '#7F1D1D' },
  maintenance:{ th: 'ปรับปรุง',  en: 'Maintenance', dot: '#7C3AED', soft: '#EFE7FB', ink: '#4C1D95' },
};
const ADMIN_STATUS_KEYS = ['vacant', 'occupied', 'reserved', 'overdue', 'maintenance'];

// --- Room types -----------------------------------------------------------
// Accent colors map to the category palette so room-type chips read as
// part of the same system, not random colors.
const ADMIN_ROOM_TYPES = {
  standard: { th: 'ห้องมาตรฐาน',     size: 24, baseRent: 4500, beds: 1, ac: false, accent: '#475569' },
  deluxe:   { th: 'ห้องดีลักซ์',      size: 28, baseRent: 5800, beds: 1, ac: true,  accent: '#2563EB' },
  suite:    { th: 'ห้องสวีท',           size: 36, baseRent: 7500, beds: 2, ac: true,  accent: '#7C3AED' },
  studio:   { th: 'สตูดิโอพรีเมียม',  size: 32, baseRent: 6800, beds: 1, ac: true,  accent: '#059669' },
};
const ADMIN_ROOM_TYPE_KEYS = ['standard', 'deluxe', 'suite', 'studio'];

// Sample-tenant list removed — the app now reads real tenant data from the
// DB-backed app_data['baankarn_rooms_v1'] blob (and the relational tenants
// table). Demo seeding has been retired; admins enter real tenants through
// the rooms UI on first run.

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
    // Minimum billable units (ขั้นต่ำหน่วย): when metered usage is below this,
    // the bill charges the minimum. 0 = no minimum. applyMinUnits master-gates
    // the floor (default on) so it can be disabled without clearing the numbers.
    waterMin: 0, elecMin: 0, applyMinUnits: true,
    commonFee: 200,
  },
  discounts: {
    sixMonth: 5, twelveMonth: 10, twentyFourMonth: 15,
    firstMonth: 0,
  },
  billing: {
    // When true, a mid-month move-in's first-month rent is prorated by the
    // number of days actually lived (move-in day → end of month), matching the
    // move-out closing bill which already prorates. When false (default), the
    // first month is charged in full, preserving the historical behavior.
    prorateFirstMonth: false,
    // Rooms (by room id) that never accrue a late fee even when the late-fee
    // feature is on — "เก็บ/ไม่เก็บค่าล่าช้า" per room. Empty = all rooms accrue.
    lateFeeExemptRooms: [],
  },
  building: {
    name:    'ที่พักของคุณ',
    address: '',
    phone:   '',
    email:   '',
    line:    '',
    lineAddFriendUrl: '',
    floors:  5,
    roomsPerFloor: 8,
    open:    '24 ชั่วโมง',
    rules:   '',
  },
  payment: {
    // Empty defaults — admin fills these in via Settings → การชำระเงิน on
    // first run. Bills + tenant portal won't show payment instructions until
    // these are populated, which is intentional (pushes setup to operator).
    promptpay:  '',
    bank:       '',
    bankAcc:    '',
    bankName:   '',
    linePay:    false,
    truemoney:  false,
    truemoneyPhone: '',
    truemoneyName:  '',
    truemoneyNote:  '',
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
function fmtCurrency(n) {
  const value = Number(n || 0);
  if (!Number.isFinite(value)) return '฿0.00';
  return '฿' + value.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
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
// R4 — format bill_no for display. Backend's services/billing.js#makeBillNo
// can emit:
//   INV-2026-05-201            (single-tenant, single-bill case — the default)
//   INV-2026-05-201-T42        (two-tenant-in-same-room-period collision case)
//   INV-2026-05-201-T42-2      (rare double collision attempt)
// Showing the raw bill_no with -T42 suffix confuses tenants (they don't
// know what "T42" means). For TENANT-FACING UI, strip the suffix and add
// a friendlier "(ผู้เช่า: คุณ X)" hint when the surrounding context has
// the tenant name. ADMIN UI keeps the raw value for unambiguous lookup
// — admin needs to be able to copy/search the full bill_no.
function fmtBillNoDisplay(billNo, opts = {}) {
  const raw = String(billNo || '');
  if (!raw) return '';
  if (opts.context === 'admin') return raw;     // admin sees the full id
  // Strip "-T${id}" and any trailing attempt suffix. The roomId may legally
  // contain digits + hyphens (e.g. "B-101") so we anchor on the literal
  // "-T" + digits sentinel, which the room id never carries.
  return raw.replace(/-T\d+(?:-\d+)?$/, '');
}
function contractTodayYmd() {
  const dt = new Date();
  dt.setMinutes(dt.getMinutes() - dt.getTimezoneOffset());
  return dt.toISOString().slice(0, 10);
}
function addContractMonths(startYmd, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(startYmd || ''));
  const n = Number(months);
  if (!m || !Number.isInteger(n) || n < 1) return '';
  const sy = Number(m[1]);
  const sm = Number(m[2]);
  const sd = Number(m[3]);
  const totalMonths = (sy * 12 + (sm - 1)) + n;
  const ey = Math.floor(totalMonths / 12);
  const em = (totalMonths % 12) + 1;
  const lastDom = new Date(Date.UTC(ey, em, 0)).getUTCDate();
  const ed = Math.min(sd, lastDom);
  return `${ey}-${String(em).padStart(2, '0')}-${String(ed).padStart(2, '0')}`;
}
function estimateContractMonths(startYmd, endYmd, maxMonths = 120) {
  const sm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(startYmd || ''));
  const em = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(endYmd || ''));
  const max = Math.max(1, Math.min(240, Number(maxMonths) || 120));
  if (!sm || !em || String(endYmd) < String(startYmd)) return null;
  for (let i = 1; i <= max; i += 1) {
    if (addContractMonths(startYmd, i) === endYmd) return i;
  }
  const sy = Number(sm[1]);
  const sMonth = Number(sm[2]);
  const sd = Number(sm[3]);
  const ey = Number(em[1]);
  const eMonth = Number(em[2]);
  const ed = Number(em[3]);
  let diff = (ey - sy) * 12 + (eMonth - sMonth);
  if (ed < sd) diff -= 1;
  return diff >= 1 && diff <= max ? diff : null;
}
function contractDateSummary(startYmd, termMonths, endYmd) {
  const term = Number(termMonths);
  const computedEnd = endYmd || addContractMonths(startYmd, term);
  if (!startYmd || !computedEnd) return 'ระบุวันเริ่มและระยะสัญญาเพื่อให้ระบบคำนวณวันสิ้นสุด';
  if (computedEnd < startYmd) return 'วันสิ้นสุดต้องไม่ก่อนวันเริ่มสัญญา';
  const months = Number.isInteger(term) && term > 0
    ? term
    : estimateContractMonths(startYmd, computedEnd);
  return months
    ? `เริ่ม ${fmtDateTH(startYmd)} ถึง ${fmtDateTH(computedEnd)} (${months} เดือน)`
    : `เริ่ม ${fmtDateTH(startYmd)} ถึง ${fmtDateTH(computedEnd)}`;
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
// seedRand was used by the demo data builder; kept exported (no-op now) so
// any external caller still resolves the symbol. The demo room/tenant
// generator has been removed — admins seed real rooms via the rooms UI.
function seedRand(seed) { const x = Math.sin(seed) * 10000; return x - Math.floor(x); }

// --- Empty room scaffold (5 floors × 8 rooms) -----------------------------
// Replaces the demo `buildAdminRooms()` that used to ship 40 rooms with
// random tenants/statuses. The app now starts with 40 vacant rooms, no
// tenants, no occupancy data — admin enters reality from there.
function buildAdminRooms() {
  const rooms = {};
  [1,2,3,4,5].forEach((f) => {
    for (let r = 1; r <= 8; r++) {
      const id = `${f}${r.toString().padStart(2,'0')}`;
      const t = ADMIN_ROOM_TYPES.standard;
      rooms[id] = {
        id, floor: f, no: r, type: 'standard', status: 'vacant',
        rent: t.baseRent + (f - 1) * 200,
        tenant: null, since: null,
        deposit: (t.baseRent + (f - 1) * 200) * 2,
        water: 0, elec: 0, waterUnits: 0, elecUnits: 0,
        wifi: 250,
        contractEnd: null,
        photos: [], notes: '',
        view: f >= 3 ? 'วิวเมือง' : 'วิวสวน',
        balcony: false, parking: false, kitchen: false,
        lastCleaned: null, lastBillDate: null,
        billStatus: 'none', overdueDays: 0,
      };
    }
  });
  return rooms;
}

// Demo bookings + activities removed. Real entries arrive via:
//   - Public POST /api/bookings/public (pending row appears)
//   - Audit log → activities derivation in the admin overview
function buildBookings() { return []; }
function buildActivities() { return []; }

// --- Config surface map (single source of truth) ------------------------
// Where every "ตั้งค่า X" lives in the admin UI, after the May 2026
// consolidation. Each row maps a config domain → the admin route that
// edits it. The goal: ONE place to set anything, no duplicate UIs.
//
//   Domain                     UI route                Storage
//   ----------------------     ------------------      ------------------
//   ข้อมูลตึก                  /admin#settings (tab)   app_data.baankarn_config_v1.building
//   ลิงก์แอด LINE ผู้จอง       /admin#settings (tab)   app_data.baankarn_config_v1.building.lineAddFriendUrl
//   วิธีรับเงิน (PromptPay/bank) /admin#settings (tab) app_data.baankarn_config_v1.payment
//   อัตราค่าเช่า + ส่วนเพิ่ม   /admin#settings (tab)   app_data.baankarn_config_v1.rates+premium+...
//   เทมเพลตแจ้งเตือน          /admin#settings (tab)   app_data.baankarn_config_v1.notify
//   ออกบิลอัตโนมัติ            /admin#settings (tab)   app_data.baankarn_features_v1.billAutoGenerate
//   ค่าจอง/มัดจำห้อง           /admin#settings (tab) + /admin#booking-deposit-settings
//                                                     app_data.baankarn_features_v1.roomBooking
//   ฟีเจอร์ระบบ                /admin#settings (tab)   app_data.baankarn_features_v1.*
//   API / Keys (secrets)       /admin#settings (tab)   secrets table (AES-256-GCM)
//   ผู้ใช้งาน (admin staff)     /admin#settings (tab)   auth_users
//   Audit log (read-only)      /admin#settings (tab)   audit_logs
//   ระบบ (reset / export)      /admin#settings (tab)   utilities, no storage
//
// Per-record settings (NOT in Settings hub — context-specific):
//   ราคาห้องเฉพาะ (override)   /admin#rooms (per room) rooms_v2.rent_override
//   ผู้เช่าเฉพาะ (PIN/locale)  /admin#tenants (row)    tenants.*
//   LINE OA webhook/token     /admin#line-oas         line_oas.channel_secret_encrypted
//
// Legacy hash routes (/admin#pricing, #features, #secrets) still resolve
// to the standalone page components for bookmarks / external links.
const STORAGE_KEYS = {
  rooms:      'baankarn_rooms_v1',
  config:     'baankarn_config_v1',
  bookings:   'baankarn_bookings_v1',
  activities: 'baankarn_activities_v1',
  // users: removed — the Users page talks to /api/admin/users (auth_users)
  // directly; api-client.js no longer syncs baankarn_users_v1 either.
};

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

// Hard cap on raw localStorage strings BEFORE they reach JSON.parse. V8 hangs
// the renderer trying to parse strings past ~30-50 MB even on desktop hardware
// (Chrome reports it as RESULT_CODE_HUNG, not OOM, because the renderer never
// finishes — it just stops responding to the OS). The earlier `stripDataUrls()`
// runs AFTER parse, so it can't help here. If we see an oversized blob we drop
// it via AP.localBypass.removeItem (which DOESN'T trigger a server DELETE on
// the cleaner row that was about to be re-hydrated).
const MAX_RAW_BYTES = 5 * 1024 * 1024;
function bailOnOversize(key, raw) {
  if (raw == null || raw.length <= MAX_RAW_BYTES) return raw;
  console.warn(
    `[shared] localStorage[${key}] is ${raw.length.toLocaleString()} bytes ` +
    `(cap ${MAX_RAW_BYTES.toLocaleString()}) — discarding stale cache to avoid ` +
    `JSON.parse hanging the renderer. Will re-hydrate from server on next load.`
  );
  try {
    if (window.AP && window.AP.localBypass && window.AP.localBypass.removeItem) {
      window.AP.localBypass.removeItem(key);
    } else {
      // Fallback: api-client.js hasn't loaded yet (shouldn't happen given the
      // <script> order in Admin Dashboard.html, but defensive). The wrapped
      // removeItem in that case is just the native one — no DELETE-to-server
      // side effect to worry about.
      localStorage.removeItem(key);
    }
  } catch {}
  return null;
}

// One-shot sanitiser. The tenant-side photo uploader at project/app.jsx
// readsAsDataURL() and pushed `data:image/jpeg;base64,…` strings straight
// into rooms[id].photos[]. With 12 photos × 40 rooms × 1-3 MB each, the
// rooms blob ballooned past 50 MB — Chrome OOM'd the renderer when /admin#billing
// re-parsed + closed-over the whole tree. Stripping here means the next
// load gets a small blob; the next save (any room edit) will persist the
// trimmed version back to the server, and the storage.js URL-ref pipeline
// will be used for new uploads.
function stripDataUrls(rooms) {
  if (!rooms || typeof rooms !== 'object') return rooms;
  let droppedCount = 0;
  for (const id of Object.keys(rooms)) {
    const r = rooms[id];
    if (r && Array.isArray(r.photos)) {
      const before = r.photos.length;
      r.photos = r.photos.filter((p) => typeof p === 'string' && !p.startsWith('data:'));
      droppedCount += before - r.photos.length;
    }
    // Same defense for any tenant-attached base64 fields seen in the wild.
    if (r && r.tenant && typeof r.tenant === 'object') {
      for (const k of ['idCardImage', 'signatureImage', 'avatar']) {
        if (typeof r.tenant[k] === 'string' && r.tenant[k].startsWith('data:')) {
          delete r.tenant[k];
          droppedCount++;
        }
      }
    }
  }
  if (droppedCount > 0) {
    console.warn(`[shared] stripped ${droppedCount} embedded base64 image(s) from rooms blob`);
  }
  return rooms;
}
function loadRooms() {
  if (typeof localStorage === 'undefined') return buildAdminRooms();
  let raw = localStorage.getItem(STORAGE_KEYS.rooms);
  raw = bailOnOversize(STORAGE_KEYS.rooms, raw);
  if (!raw) return buildAdminRooms();
  const parsed = safeParse(raw, null);
  if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
    return buildAdminRooms();
  }
  return stripDataUrls(parsed);
}
function saveRooms(rooms) {
  try {
    // Strip again on save — belt + braces. Keeps any code path that mutated
    // photos in-memory (e.g. legacy app.jsx still writing data URLs from a
    // stale tab) from re-poisoning the server-side blob.
    const safe = stripDataUrls(rooms);
    localStorage.setItem(STORAGE_KEYS.rooms, JSON.stringify(safe));
  } catch (e) { console.warn('saveRooms failed', e); }
}
function loadConfig() {
  if (typeof localStorage === 'undefined') return DEFAULT_CONFIG;
  let raw = localStorage.getItem(STORAGE_KEYS.config);
  raw = bailOnOversize(STORAGE_KEYS.config, raw);
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
  let raw = localStorage.getItem(STORAGE_KEYS.bookings);
  raw = bailOnOversize(STORAGE_KEYS.bookings, raw);
  if (!raw) return buildBookings();
  return safeParse(raw, buildBookings());
}
function saveBookings(b) {
  try { localStorage.setItem(STORAGE_KEYS.bookings, JSON.stringify(b)); }
  catch (e) { console.warn('saveBookings failed', e); }
}
function loadActivities() {
  if (typeof localStorage === 'undefined') return buildActivities();
  let raw = localStorage.getItem(STORAGE_KEYS.activities);
  raw = bailOnOversize(STORAGE_KEYS.activities, raw);
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
  const cfg = config || DEFAULT_CONFIG || {};
  const defaults = ADMIN_ROOM_TYPES[type] || ADMIN_ROOM_TYPES.standard;
  const base    = ((cfg.rates || {})[type] || {}).rent ?? defaults.baseRent;
  const fp      = (cfg.floorPremium || {})[floor] || 0;
  const vp      = (cfg.viewPremium || {})[view]   || 0;
  const premiums = cfg.featurePremium || {};
  const balcony = features?.balcony ? (premiums.balcony || 0) : 0;
  const ac      = features?.ac      ? (premiums.ac      || 0) : 0;
  const parking = features?.parking ? (premiums.parking || 0) : 0;
  const kitchen = features?.kitchen ? (premiums.kitchen || 0) : 0;
  return Math.round((base + fp + vp + balcony + ac + parking + kitchen) * 100) / 100;
}

function positiveMoneyOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function nonNegativeMoneyOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function resolveRoomRent(room, config) {
  if (!room || typeof room !== 'object') {
    return { rent: 0, source: 'legacy', formula: 0, override: null };
  }
  const type = room.type || room.room_type || room.roomType || 'standard';
  const typeDefault = ADMIN_ROOM_TYPES[type] || ADMIN_ROOM_TYPES.standard;
  const acRaw = room.ac ?? room.hasAc ?? room.has_ac;
  const features = {
    balcony: !!(room.balcony || room.hasBalcony || room.has_balcony),
    ac: acRaw === undefined ? !!typeDefault.ac : !!acRaw,
    parking: !!(room.parking || room.hasParking || room.has_parking),
    kitchen: !!(room.kitchen || room.hasKitchen || room.has_kitchen),
  };
  const formula = computeRoomRent(
    type,
    room.floor,
    room.view ?? room.viewType ?? room.view_type,
    features,
    config
  );
  const snakeOverride = positiveMoneyOrNull(room.rent_override);
  const camelOverride = positiveMoneyOrNull(room.rentOverride);
  const override = snakeOverride ?? camelOverride;
  if (override !== null) {
    return { rent: override, source: 'override', formula, override };
  }
  if (Number.isFinite(Number(formula)) && Number(formula) > 0) {
    return { rent: Number(formula), source: 'formula', formula, override: null };
  }
  const legacy = positiveMoneyOrNull(room.rent ?? room.rentPrice ?? room.rent_price) || 0;
  return { rent: legacy, source: 'legacy', formula, override: null };
}

function resolveRoomDeposit(room, config, rentInput) {
  const type = room?.type || room?.room_type || room?.roomType || 'standard';
  const configured = nonNegativeMoneyOrNull((config?.rates || {})[type]?.deposit);
  if (configured !== null) {
    return { deposit: Math.round(configured * 100) / 100, source: 'pricing_config', sourceLabel: 'เมนูตั้งราคา' };
  }

  const roomDeposit = nonNegativeMoneyOrNull(room?.deposit ?? room?.depositPrice ?? room?.deposit_price);
  if (roomDeposit !== null) {
    return { deposit: Math.round(roomDeposit * 100) / 100, source: 'room_snapshot', sourceLabel: 'ค่า fallback ของห้อง' };
  }

  const rent = nonNegativeMoneyOrNull(rentInput);
  if (rent !== null) {
    return { deposit: Math.round(rent * 2 * 100) / 100, source: 'rent_x2', sourceLabel: 'ค่าเช่า x 2' };
  }

  return { deposit: 0, source: 'none', sourceLabel: 'ยังไม่ได้กำหนด' };
}

// --- Aggregate stats for dashboard ----------------------------------------
// Room blobs only carry latest/legacy meter units. Financial screens that
// need water/electric totals must use period bills; this fallback aggregate
// therefore counts only fixed monthly charges (rent + wifi).
function computeStats(rooms, config) {
  const list = Object.values(rooms);
  const total = list.length;
  const counts = { vacant: 0, occupied: 0, reserved: 0, overdue: 0, maintenance: 0 };
  let revenue = 0, overdueAmt = 0;
  const wifiFee   = config?.utilities?.wifi      ?? 250;
  list.forEach(r => {
    counts[r.status] = (counts[r.status] || 0) + 1;
    if (r.status === 'occupied' || r.status === 'overdue') {
      const wifi  = (r.wifi != null && r.wifi !== 0) ? r.wifi : wifiFee;
      const rentInfo = resolveRoomRent(r, config);
      const t = (rentInfo.rent || 0) + wifi;
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
    { key: 'ac',          label: 'แอร์', get: r => (r.ac ?? r.hasAc ?? r.has_ac ?? ADMIN_ROOM_TYPES[r.type]?.ac) ? 'มี' : 'ไม่มี' },
    { key: 'balcony',     label: 'ระเบียง', get: r => r.balcony ? 'มี' : 'ไม่มี' },
    { key: 'parking',     label: 'ที่จอดรถ', get: r => r.parking ? 'มี' : 'ไม่มี' },
    { key: 'kitchen',     label: 'ครัวในห้อง', get: r => r.kitchen ? 'มี' : 'ไม่มี' },
    { key: 'tenantName',  label: 'ผู้เช่า', get: r => r.tenant?.name || '' },
    { key: 'tenantPhone', label: 'เบอร์โทร', get: r => r.tenant?.phone || '' },
    { key: 'tenantEmail', label: 'อีเมล',     get: r => r.tenant?.email || '' },
    { key: 'since',       label: 'เข้าพัก' },
    { key: 'contractEnd', label: 'สิ้นสุดสัญญา' },
    { key: 'waterUnits',  label: 'น้ำ(หน่วยล่าสุด)' },
    { key: 'elecUnits',   label: 'ไฟ(หน่วยล่าสุด)' },
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

// --- Audit log Thai labels --------------------------------------------------
// audit_logs.action keys are machine strings ('tenant.checkin'). History
// views render them through this map so admins read events in Thai instead
// of decoding API verbs. Unknown keys fall back to the raw string — never
// hide an event just because it isn't mapped yet.
const AUDIT_ACTION_TH = {
  'booking.public_create': 'ผู้สนใจส่งคำขอจองจากหน้าเว็บ',
  'booking.hold_create': 'ล็อกห้องระหว่างชำระค่าจอง',
  'booking.hold_release': 'ปล่อยห้องที่ล็อกไว้',
  'booking.create': 'แอดมินสร้างการจอง',
  'booking.approve': 'อนุมัติการจอง + จัดห้อง',
  'booking.update': 'เปลี่ยนสถานะ/แก้ไขการจอง',
  'booking.stale_cancel': 'ระบบยกเลิกการจองค้างอัตโนมัติ',
  'booking.stale_complete': 'ระบบปิดการจองเป็นเสร็จสิ้น (มีสัญญาแล้ว)',
  'access_card.suspension_warned': 'เตือนผู้เช่าก่อนระงับบัตร 1 วัน',
  'contract.invitation_expiry_warned': 'เตือนลิงก์กรอกสัญญาใกล้หมดอายุ',
  'access_card.bulk_sync': 'ระบบระงับ/คืนสิทธิ์บัตรตามยอดค้าง (รายวัน)',
  'booking_deposit_settings.update': 'แก้ตั้งค่าค่าจอง/มัดจำ',
  'contract.quick_invite': 'สร้างสัญญา + ส่งลิงก์ให้ผู้เช่ากรอก',
  'contract.invite_tenant': 'ส่งลิงก์กรอกสัญญา',
  'contract.invitation_approve': 'อนุมัติสัญญาที่ผู้เช่ากรอก (lock)',
  'contract.invitation_reject': 'ส่งสัญญากลับให้ผู้เช่าแก้',
  'contract.invitation_revoke': 'ยกเลิกลิงก์กรอกสัญญา',
  'contract.sign': 'ลงนามสัญญา',
  'contract.update': 'แก้ไขสัญญา',
  'contract.cancel': 'ปิด/ยกเลิกสัญญา',
  'contract.template_create': 'สร้างเทมเพลตสัญญา',
  'contract.template_update': 'แก้ไขเทมเพลตสัญญา',
  'contract.template_delete': 'ลบเทมเพลตสัญญา',
  'contract.template_set_default': 'ตั้งเทมเพลตสัญญาเริ่มต้น',
  'contract.template_assign': 'ผูกเทมเพลตกับสัญญา',
  'contract.terms_update': 'แก้ข้อกำหนดสัญญากลาง',
  'contract.terms_reset': 'รีเซ็ตข้อกำหนดสัญญากลาง',
  'contract.pdf_view': 'เปิดดู PDF สัญญา',
  'tenant.create': 'สร้างผู้เช่า',
  'tenant.update': 'แก้ไขข้อมูลผู้เช่า',
  'tenant.delete': 'ลบผู้เช่า',
  'tenant.identity': 'บันทึกบัตรประชาชน',
  'tenant.notify': 'ส่งข้อความถึงผู้เช่า',
  'tenant.login': 'ผู้เช่าเข้าสู่ระบบ',
  'tenant.login_failed': 'ผู้เช่าเข้าสู่ระบบไม่สำเร็จ',
  'tenant.login_blocked_ambiguous_phone': 'ระบบกันล็อกอิน (เบอร์ซ้ำหลายคน)',
  'tenant.login_blocked_inactive': 'ระบบกันล็อกอิน (ผู้เช่าไม่ active)',
  'tenant.profile_update': 'ผู้เช่าแก้โปรไฟล์',
  'tenant.slip_upload': 'ผู้เช่าส่งสลิปชำระเงิน',
  'tenant.checkin': 'เช็คอิน/ย้ายเข้า',
  'tenant.checkout': 'เช็คเอาท์/ย้ายออก',
  'bill.create': 'ออกบิล',
  'bill.void': 'ยกเลิกบิล',
  'bill.unmark_paid': 'ถอนสถานะชำระแล้วของบิล',
  'payment.verify': 'ยืนยันการชำระเงิน',
  'payment.reject': 'ปฏิเสธสลิป',
  'room.update': 'แก้ไขห้อง',
  'room.delete': 'ลบห้อง',
  'room.reconcile': 'ปรับสถานะห้อง (reconcile)',
  'room.status_sync': 'ระบบปรับสถานะห้องอัตโนมัติ',
  'access_card.revoke': 'เพิกถอนบัตรเข้าออก',
  'recurring_charge.deactivate': 'หยุดค่าใช้จ่ายประจำ',
  'user.create': 'สร้างผู้ใช้แอดมิน',
  'user.update': 'แก้ไขผู้ใช้แอดมิน',
  'user.delete': 'ลบผู้ใช้แอดมิน',
  'setting.update': 'แก้ตั้งค่าระบบ',
  'setting.reset': 'รีเซ็ตตั้งค่าระบบ',
};

function auditActionTH(action) {
  const key = String(action || '');
  if (!key) return '-';
  if (AUDIT_ACTION_TH[key]) return AUDIT_ACTION_TH[key];
  if (key.startsWith('bill.late_fee')) return 'ปรับปรุงค่าปรับล่าช้า';
  return key;
}

// One-line human summary of audit_logs.detail (JSONB → object). Pulls the
// fields admins actually ask about (room, contract, amounts, reason, state
// transition) and ignores the machine bookkeeping keys.
function describeAuditDetail(entry) {
  const d = entry && typeof entry.detail === 'object' && entry.detail ? entry.detail : {};
  const money = (v) => `฿${Number(v).toLocaleString('th-TH')}`;
  const parts = [];
  if (d.roomId) parts.push(`ห้อง ${d.roomId}`);
  else if (d.oldRoom) parts.push(`ห้อง ${d.oldRoom}`);
  else if (d.assignedRoomId) parts.push(`ห้อง ${d.assignedRoomId}`);
  if (d.contractNo) parts.push(`สัญญา ${d.contractNo}`);
  if (d.before != null && d.after != null) parts.push(`${d.before || '-'} → ${d.after}`);
  else if (d.from != null && d.to != null) parts.push(`${d.from || '-'} → ${d.to}`);
  if (d.monthlyRent != null) parts.push(`ค่าเช่า ${money(d.monthlyRent)}`);
  if (d.depositAmount != null) parts.push(`มัดจำ ${money(d.depositAmount)}`);
  if (d.refund != null) parts.push(`คืนมัดจำ ${money(d.refund)}`);
  if (d.amount != null) parts.push(money(d.amount));
  if (d.closingBill) parts.push(`บิลปิดยอด ${d.closingBill}`);
  if (d.label) parts.push(String(d.label).slice(0, 60));
  const reasonText = d.reason || d.closeReason || d.rejection_reason;
  if (reasonText) parts.push(`เหตุผล: ${String(reasonText).slice(0, 80)}`);
  if (d.forced === true || d.force === true) parts.push('⚠️ ใช้ force ข้ามการตรวจ');
  return parts.join(' · ');
}

// --- Expose to window -----------------------------------------------------
// ADMIN_TENANTS used to live here but was removed when tenants moved into
// the relational `tenants` table. The reference left in this exposure list
// kept throwing "ADMIN_TENANTS is not defined" at module load — which then
// stopped every page-*.jsx file below from registering window.PageX, so
// every admin route showed skeleton-forever instead of its component.
Object.assign(window, {
  ADMIN_C, TONES, PAGE_TONE,
  ADMIN_STATUS, ADMIN_STATUS_KEYS,
  ADMIN_ROOM_TYPES, ADMIN_ROOM_TYPE_KEYS,
  ADMIN_VIEWS,
  DEFAULT_CONFIG, STORAGE_KEYS,
  fmt, fmtCurrency, fmtPercent, fmtDateTH, fmtMonthTH, relTime, seedRand,
  contractTodayYmd, addContractMonths, estimateContractMonths, contractDateSummary,
  buildAdminRooms, buildBookings, buildActivities,
  loadRooms, saveRooms, loadConfig, saveConfig,
  loadBookings, saveBookings, loadActivities, saveActivities,
  resetAll, deepMerge,
  computeRoomRent, resolveRoomRent, resolveRoomDeposit, computeStats,
  // export/import
  downloadFile, exportCSV, exportJSON, importJSON,
  exportRoomsCSV, exportTenantsCSV, exportBookingsCSV, exportBillsCSV, exportFullBackup,
  printPage,
  AUDIT_ACTION_TH, auditActionTH, describeAuditDetail,
});

// --- Image upload helpers (ใช้ร่วมทุกหน้าแอดมิน) ---------------------------
// เดิมแต่ละหน้า (parcels / rooms / tenants / billing / contracts) เขียน
// FileReader + ตรวจชนิด/ขนาดของตัวเอง และมีแค่หน้าพัสดุที่ย่อรูปใหญ่
// อัตโนมัติ — รวมไว้ที่นี่ที่เดียว: รูปจากกล้องมือถือ (2-8 MB) ถูกย่อผ่าน
// canvas (ลดด้านยาว + ไล่ลดคุณภาพ) จนต่ำกว่าเพดานเซิร์ฟเวอร์ แทนการ
// reject ทิ้งให้ผู้ใช้ติดทางตัน
const IMAGE_UPLOAD_DEFAULT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const IMAGE_UPLOAD_TARGET_BYTES = 1_400_000; // เผื่อ headroom จากเพดานเซิร์ฟเวอร์ 1.5 MB
const IMAGE_UPLOAD_MAX_INPUT_BYTES = 15_000_000;

function estimateDataUrlBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  return Math.floor((dataUrl.length - (comma >= 0 ? comma + 1 : 0)) * 0.75);
}

function readImageFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('อ่านไฟล์รูปไม่สำเร็จ กรุณาเลือกรูปใหม่'));
    reader.readAsDataURL(file);
  });
}

function loadImageElementFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('ไฟล์รูปเสียหรือเปิดไม่ได้ กรุณาเลือกหรือถ่ายรูปใหม่'));
    img.src = dataUrl;
  });
}

async function prepareImageForUpload(file, opts = {}) {
  const allowedTypes = opts.allowedTypes || IMAGE_UPLOAD_DEFAULT_TYPES;
  const targetBytes = opts.targetBytes || IMAGE_UPLOAD_TARGET_BYTES;
  const maxInputBytes = opts.maxInputBytes || IMAGE_UPLOAD_MAX_INPUT_BYTES;
  const typeErrorText = opts.typeErrorText || 'รองรับเฉพาะรูป JPG, PNG หรือ WebP';
  if (!file) throw new Error('ไม่พบไฟล์รูป กรุณาเลือกรูปใหม่');
  if (!allowedTypes.includes(file.type)) throw new Error(typeErrorText);
  if (file.size > maxInputBytes) {
    throw new Error(`รูปใหญ่เกิน ${Math.round(maxInputBytes / 1_000_000)} MB ระบบย่อให้ไม่ไหว กรุณาเลือกรูปที่เล็กกว่านี้`);
  }
  const original = await readImageFileAsDataUrl(file);
  if (file.size <= targetBytes) return original;
  const img = await loadImageElementFromDataUrl(original);
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  if (!srcW || !srcH) throw new Error('อ่านขนาดรูปไม่ได้ กรุณาเลือกรูปใหม่');
  for (const maxDim of [1600, 1280, 1024, 800]) {
    const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) break;
    // พื้นขาวกัน PNG โปร่งใสกลายเป็นพื้นดำตอนแปลงเป็น JPEG
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    for (const quality of [0.82, 0.68, 0.55]) {
      const out = canvas.toDataURL('image/jpeg', quality);
      if (out.startsWith('data:image/jpeg') && estimateDataUrlBytes(out) <= targetBytes) {
        return out;
      }
    }
  }
  throw new Error('ย่อรูปอัตโนมัติแล้วยังใหญ่เกินไป กรุณาถ่ายหรือเลือกรูปความละเอียดต่ำลง');
}

Object.assign(window, {
  readImageFileAsDataUrl,
  prepareImageForUpload,
});
