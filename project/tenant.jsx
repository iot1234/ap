// === project/tenant.jsx ====================================================
// Tenant portal SPA. Logs in with the phone number bound to the active room, then shows:
//   - Dashboard (current room, latest bill, ticket count)
//   - Bills (list + detail + slip upload)
//   - Maintenance (submit + own ticket history)
//   - Profile (locale, dark mode toggle)
//
// Gated by features.tenantPortal — when off, the login API returns 503.
// ===========================================================================

const { useState, useEffect, useMemo, useRef } = React;
const PAYMENT_TOLERANCE_THB = 1;

// ------------------------------------------------------------------ i18n ---
const TR = {
  th: {
    portal: 'พอร์ทัลผู้เช่า', login: 'เข้าสู่ระบบ', phone: 'เบอร์โทรศัพท์',
    signIn: 'เข้าสู่ระบบ', logOut: 'ออกจากระบบ',
    bills: 'บิล', maintenance: 'แจ้งซ่อม', profile: 'โปรไฟล์',
    home: 'หน้าหลัก', welcome: 'สวัสดี', noBills: 'ยังไม่มีบิล',
    bill: 'บิล', period: 'รอบบิล', total: 'ยอดรวม', dueDate: 'กำหนดชำระ',
    status: 'สถานะ', uploadSlip: 'อัปโหลดสลิป', viewBill: 'ดูบิล',
    submitTicket: 'แจ้งซ่อม', myTickets: 'ประวัติแจ้งซ่อม',
    title: 'หัวข้อ', description: 'รายละเอียด', category: 'หมวดหมู่',
    priority: 'ระดับความเร่งด่วน', submit: 'ส่ง', cancel: 'ยกเลิก',
    pending: 'รอดำเนินการ', paid: 'ชำระแล้ว', overdue: 'ค้างชำระ',
    void: 'ยกเลิก', open: 'เปิด', completed: 'เสร็จสิ้น', in_progress: 'กำลังดำเนินการ',
    assigned: 'มอบหมายแล้ว', awaiting_parts: 'รออะไหล่', cancelled: 'ยกเลิก',
    darkMode: 'โหมดมืด', language: 'ภาษา', close: 'ปิด',
    portalDisabled: 'พอร์ทัลผู้เช่ายังปิดอยู่ — กรุณาติดต่อเจ้าหน้าที่',
    invalidLogin: 'เบอร์นี้ไม่ได้ผูกกับผู้เช่าปัจจุบัน',
    chooseFile: 'เลือกไฟล์สลิป', amount: 'จำนวนเงิน', uploadOk: 'อัปโหลดสลิปสำเร็จ',
    nothingHere: 'ไม่มีรายการ', loading: 'กำลังโหลด…', save: 'บันทึก',
    // Maintenance categories
    cat_electrical: 'ไฟฟ้า', cat_plumbing: 'ประปา', cat_aircon: 'แอร์',
    cat_furniture: 'เฟอร์นิเจอร์', cat_appliance: 'เครื่องใช้ไฟฟ้า',
    cat_door_lock: 'ประตู / กลอน', cat_wifi: 'อินเทอร์เน็ต', cat_other: 'อื่นๆ',
    // Priority labels
    prio_critical: 'ฉุกเฉิน', prio_high: 'สูง', prio_medium: 'ปานกลาง', prio_low: 'ต่ำ',
    // Rate ticket
    ratePrompt: 'ให้คะแนนการซ่อม', ratePicked: 'เลือกดาว 1-5',
    ratePlaceholder: 'ความคิดเห็น (ไม่บังคับ)', submitRating: 'ส่งคะแนน',
    backLink: 'ย้อนกลับ',
    amountMismatchWarn: '⚠ จำนวนไม่ตรงยอดบิล',
    downloadPdf: 'ดาวน์โหลด PDF',
    receipt: 'ใบเสร็จ',
    payments: 'การชำระเงิน',
    paymentHistory: 'ประวัติการชำระเงิน',
    paymentVerified: 'ยืนยันแล้ว',
    paymentPending: 'รอตรวจสอบ',
    paymentRejected: 'ไม่ผ่าน',
    paymentDate: 'วันที่ส่ง',
    paymentMethod: 'ช่องทาง',
    rejectedReason: 'เหตุผลที่ปฏิเสธ',
    transRef: 'เลขที่อ้างอิง',
    viewSlip: 'ดูสลิป',
    // Contract view
    contract: 'สัญญา',
    myContract: 'สัญญาเช่าของฉัน',
    noContract: 'ยังไม่มีสัญญาเช่าที่มีผลบังคับใช้',
    contractNo: 'เลขที่สัญญา',
    contractRoom: 'ห้อง',
    contractStart: 'วันเริ่มสัญญา',
    contractEnd: 'วันสิ้นสุด',
    contractTerm: 'ระยะเวลา',
    contractRent: 'ค่าเช่ารายเดือน',
    contractDeposit: 'เงินมัดจำ',
    contractDiscount: 'ส่วนลด',
    contractSigned: 'ลงนามเมื่อ',
    contractDownload: 'ดาวน์โหลดสัญญา (PDF)',
    contractDaysLeft: 'เหลืออีก',
    contractDays: 'วัน',
    contractMonths: 'เดือน',
    contractPending: 'สัญญายังไม่ได้รับอนุมัติ — รอเจ้าของหอพักตรวจสอบ',
    contractOpenEnded: 'เปิด-ไม่จำกัด',
    contractActive: 'มีผลบังคับใช้',
  },
  en: {
    portal: 'Tenant Portal', login: 'Sign in', phone: 'Phone number',
    signIn: 'Sign in', logOut: 'Log out',
    bills: 'Bills', maintenance: 'Maintenance', profile: 'Profile',
    home: 'Home', welcome: 'Hello', noBills: 'No bills yet',
    bill: 'Bill', period: 'Period', total: 'Total', dueDate: 'Due date',
    status: 'Status', uploadSlip: 'Upload slip', viewBill: 'View bill',
    submitTicket: 'Submit ticket', myTickets: 'My tickets',
    title: 'Title', description: 'Description', category: 'Category',
    priority: 'Priority', submit: 'Submit', cancel: 'Cancel',
    pending: 'pending', paid: 'paid', overdue: 'overdue',
    void: 'void', open: 'open', completed: 'completed', in_progress: 'in progress',
    assigned: 'assigned', awaiting_parts: 'awaiting parts', cancelled: 'cancelled',
    darkMode: 'Dark mode', language: 'Language', close: 'Close',
    portalDisabled: 'Tenant portal is currently disabled — please contact admin',
    invalidLogin: 'This phone is not linked to a current tenant',
    chooseFile: 'Choose slip image', amount: 'Amount', uploadOk: 'Slip uploaded',
    nothingHere: 'Nothing here', loading: 'Loading…', save: 'Save',
    cat_electrical: 'Electrical', cat_plumbing: 'Plumbing', cat_aircon: 'A/C',
    cat_furniture: 'Furniture', cat_appliance: 'Appliance',
    cat_door_lock: 'Door / Lock', cat_wifi: 'Wi-Fi', cat_other: 'Other',
    prio_critical: 'Critical', prio_high: 'High', prio_medium: 'Medium', prio_low: 'Low',
    ratePrompt: 'Rate the service', ratePicked: 'Pick 1-5 stars',
    ratePlaceholder: 'Optional comment', submitRating: 'Submit rating',
    backLink: 'Back',
    amountMismatchWarn: '⚠ Amount does not match the bill',
    downloadPdf: 'Download PDF',
    receipt: 'Receipt',
    payments: 'Payments',
    paymentHistory: 'Payment history',
    paymentVerified: 'Verified',
    paymentPending: 'Pending',
    paymentRejected: 'Rejected',
    paymentDate: 'Submitted',
    paymentMethod: 'Method',
    rejectedReason: 'Rejected reason',
    transRef: 'Reference',
    viewSlip: 'View slip',
    // Contract view
    contract: 'Contract',
    myContract: 'My lease contract',
    noContract: 'No active lease contract yet',
    contractNo: 'Contract no.',
    contractRoom: 'Room',
    contractStart: 'Start date',
    contractEnd: 'End date',
    contractTerm: 'Term',
    contractRent: 'Monthly rent',
    contractDeposit: 'Deposit',
    contractDiscount: 'Discount',
    contractSigned: 'Signed at',
    contractDownload: 'Download contract (PDF)',
    contractDaysLeft: 'Remaining',
    contractDays: 'days',
    contractMonths: 'months',
    contractPending: 'Contract not yet approved — awaiting building owner review',
    contractOpenEnded: 'Open-ended',
    contractActive: 'Active',
  },
};
function tr(locale, k) { return (TR[locale] || TR.th)[k] || k; }

function numOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmtQty(n) {
  const value = Number(n) || 0;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function billUtilityDetail(bill, prefix, locale) {
  // Tenant should always see how the unit count was derived, even when the
  // bill is missing one or both meter readings (legacy data / admin manual
  // entry). Renders "—" for missing sides so the bill stays auditable.
  const prev = numOrNull(bill?.[`${prefix}_prev_reading`]);
  const current = numOrNull(bill?.[`${prefix}_current_reading`]);
  const rawUnits = Number(bill?.[`${prefix}_units`]);
  const units = Number.isFinite(rawUnits) ? Math.max(0, rawUnits) : 0;
  const rawRate = Number(bill?.[`${prefix}_rate`]);
  const rate = Number.isFinite(rawRate) ? Math.max(0, rawRate) : 0;
  const rawAmount = Number(bill?.[`${prefix}_amount`]);
  const amount = Number.isFinite(rawAmount) ? rawAmount : 0;
  const isEn = locale === 'en';
  const unitsLabel = isEn ? 'units' : 'หน่วย';
  const fr = (v) => v == null ? '—' : fmtQty(v);
  const rateTail = rate > 0 ? ` × ${fmtQty(rate)}` : '';

  // Flat (เหมา) mode detection — no readings + no units + no rate but
  // amount > 0 can only mean a flat-mode bill. The bill row doesn't store
  // a `mode` column; this combination is unreachable from the metered
  // path (amount = units × rate, so amount > 0 requires either units or
  // rate > 0). Showing "ค่าเหมา" instead of "ไม่มีการใช้งาน" stops the
  // tenant disputing "why charged X when nothing was used".
  const isFlat = prev == null && current == null && units === 0 && rate === 0 && amount > 0;
  if (isFlat) {
    return isEn
      ? `Flat monthly rate (no metering)`
      : `ค่าเหมารายเดือน — ไม่นับตามเลขมิเตอร์`;
  }

  if (prev == null && current == null) {
    if (units <= 0) return isEn ? 'No usage' : 'ไม่มีการใช้งาน';
    return isEn
      ? `${fmtQty(units)} ${unitsLabel}${rateTail} (no meter reading)`
      : `${fmtQty(units)} ${unitsLabel}${rateTail} (ไม่มีเลขมิเตอร์)`;
  }
  const partial = prev == null || current == null;
  const flagged = !partial && Number.isFinite(prev) && Number.isFinite(current) && current < prev;
  const baseTh = `เลขก่อน ${fr(prev)}  เลขหลัง ${fr(current)}  ใช้ ${fmtQty(units)} ${unitsLabel}${rateTail}`;
  const baseEn = `Before ${fr(prev)}  After ${fr(current)}  Used ${fmtQty(units)} ${unitsLabel}${rateTail}`;
  const suffix = partial
    ? (isEn ? ' (incomplete)' : ' (ข้อมูลไม่ครบ)')
    : (flagged ? (isEn ? ' (meter went down)' : ' (มิเตอร์ลดลง)') : '');
  return (isEn ? baseEn : baseTh) + suffix;
}

// --------------------------------------------------------- helpers / api ---
// CSRF: tenant routes that go through csrfGuard need X-CSRF-Token. We
// fetch it once and reuse — the cookie+token pair is bound to the session.
let _csrf = null;
let _csrfPromise = null;
async function getCsrf(forceRefresh = false) {
  if (_csrf && !forceRefresh) return _csrf;
  if (_csrfPromise && !forceRefresh) return _csrfPromise;
  _csrfPromise = (async () => {
    const r = await fetch('/api/csrf-token', { credentials: 'same-origin' });
    if (!r.ok) return null;
    const j = await r.json().catch(() => ({}));
    _csrf = j.csrfToken || null;
    return _csrf;
  })();
  try {
    return await _csrfPromise;
  } catch { return null; }
  finally { _csrfPromise = null; }
}

// Subscribers notified when a 401 / 403 lands — typically the App resets
// to LoginView so the tenant doesn't stare at stale data after the session
// expired mid-session.
const _authListeners = new Set();
function onAuthExpired(fn) { _authListeners.add(fn); return () => _authListeners.delete(fn); }
function fireAuthExpired() { for (const fn of _authListeners) try { fn(); } catch {} }

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const method = (opts.method || 'GET').toUpperCase();
  const csrfProtected = method !== 'GET' && method !== 'HEAD' && !path.includes('/api/tenant/login');
  if (csrfProtected) {
    const t = await getCsrf();
    if (t) headers['X-CSRF-Token'] = t;
  }
  // 30s timeout protects mobile users on flaky networks — they get a clear
  // error instead of a forever-spinning UI. Override via opts.timeoutMs.
  const timeoutMs = opts.timeoutMs == null ? 30_000 : opts.timeoutMs;
  let controller, timer;
  let signal = opts.signal;
  if (!signal && Number.isFinite(timeoutMs)) {
    controller = new AbortController();
    signal = controller.signal;
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  let r;
  try {
    r = await fetch(path, { credentials: 'same-origin', ...opts, signal, headers });
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (err.name === 'AbortError') {
      const e = new Error('คำขอใช้เวลานานเกินกำหนด');
      e.code = 'TIMEOUT';
      throw e;
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (r.status === 403 && csrfProtected && !opts._csrfRetried) {
    const data = await r.clone().json().catch(() => ({}));
    if (data && (data.code === 'CSRF_INVALID' || /csrf/i.test(String(data.error || '')))) {
      _csrf = null;
      const fresh = await getCsrf(true);
      if (fresh) {
        r = await fetch(path, {
          credentials: 'same-origin',
          ...opts,
          headers: { ...headers, 'X-CSRF-Token': fresh },
          _csrfRetried: true,
        });
      }
    }
  }
  if (r.ok && path.includes('/api/tenant/login')) {
    _csrf = null;
  }
  // Session expiry: clear local CSRF token + tell the App to re-login.
  // We exclude the login + me endpoints — 401 there is a normal "wrong
  // credentials" response, not a session expiry.
  if (r.status === 401
      && !path.includes('/login') && !path.includes('/csrf-token') && !path.endsWith('/me')) {
    _csrf = null;
    fireAuthExpired();
  }
  let data = null;
  try { data = await r.json(); } catch { /* ignore */ }
  if (!r.ok) {
    const err = new Error((data && data.error) || `HTTP ${r.status}`);
    err.status = r.status; err.data = data;
    throw err;
  }
  return data;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function fmtCurrency(n) {
  return Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Translate developer-tagged rejection reasons into tenant-friendly Thai.
// The server writes structured codes like "superseded_by_void: ..." or
// "superseded_by_verified_sibling" into payments.rejected_reason so admin
// + audit forensics see exactly why a row was rejected, but a tenant
// staring at "superseded_by_verified_sibling" in their payment history
// has no idea what that means. The map covers the codes the server can
// produce; anything else (admin-typed free-text reasons) falls through
// unchanged.
function tenantRejectedReason(raw) {
  if (!raw) return raw;
  const s = String(raw);
  if (s.startsWith('superseded_by_verified_sibling')) {
    return 'ระบบรับสลิปอีกใบสำหรับบิลนี้ไปแล้ว';
  }
  if (s.startsWith('superseded_by_manual_pay')) {
    return 'แอดมินบันทึกการชำระเงินด้วยช่องทางอื่น (เงินสด/โอน) แล้ว';
  }
  if (s.startsWith('superseded_by_void')) {
    return 'บิลนี้ถูกยกเลิกแล้ว — โปรดติดต่อแอดมิน';
  }
  if (s.startsWith('unmark_paid_correction')) {
    return 'แอดมินยกเลิกการบันทึกชำระ — โปรดติดต่อแอดมิน';
  }
  return s;
}
window.tenantRejectedReason = tenantRejectedReason;

function partyText(party) {
  if (!party) return '';
  return [party.name, party.bank, party.account ? `...${String(party.account).slice(-6)}` : null]
    .filter(Boolean).join(' / ');
}

function noticeStyle(kind) {
  if (kind === 'success') {
    return { background: '#eef8f1', border: '1px solid #bee4ca', color: 'var(--green)' };
  }
  if (kind === 'error') {
    return { background: '#fff4f1', border: '1px solid #f3c2b8', color: 'var(--red)' };
  }
  if (kind === 'processing' || kind === 'pending') {
    return { background: '#fffbe8', border: '1px solid #f0e3a7', color: '#6b5b1a' };
  }
  return { background: '#f3f7ff', border: '1px solid #c7d8f5', color: '#315a9c' };
}

function paymentNoticeFromResponse(out, locale) {
  const th = locale !== 'en';
  const v = out && out.verification ? out.verification : null;
  const payment = out && out.payment ? out.payment : {};
  const status = (v && v.status) || payment.status;
  const kind = status === 'verified' ? 'success' : status === 'rejected' ? 'error' : 'pending';
  const title = (v && v.title) || (status === 'verified'
    ? (th ? 'ชำระเงินสำเร็จ' : 'Payment verified')
    : status === 'rejected'
      ? (th ? 'สลิปไม่ผ่านการตรวจสอบ' : 'Slip rejected')
      : (th ? 'รับสลิปแล้ว รอตรวจสอบ' : 'Slip received, awaiting review'));
  const message = (v && v.message)
    || tenantRejectedReason(payment.rejected_reason)
    || (status === 'verified'
      ? (th ? 'ระบบตรวจสอบสลิปและอัปเดตบิลแล้ว' : 'The slip was verified and the bill was updated.')
      : status === 'rejected'
        ? (th ? 'กรุณาตรวจสอบยอด บัญชีปลายทาง และ QR code แล้วอัปโหลดใหม่ หากยังไม่ผ่านให้ติดต่อแอดมิน' : 'Check the amount, receiver account, and QR code, then upload again or contact admin.')
        : (th ? 'สลิปถูกส่งให้แอดมินตรวจสอบ ระบบจะแจ้งผลเมื่ออนุมัติหรือปฏิเสธ' : 'The slip is queued for admin review.'));
  const details = [];
  if (v && v.provider) details.push(`${th ? 'บริการตรวจสลิป' : 'Verifier'}: ${v.provider}`);
  if (v && v.code) details.push(`${th ? 'รหัสอ้างอิงสำหรับแจ้งแอดมิน' : 'Admin reference code'}: ${v.code}`);
  if (v && v.transactionRef) details.push(`${th ? 'เลขอ้างอิง' : 'Reference'}: ${v.transactionRef}`);
  if (v && v.amount != null) details.push(`${th ? 'ยอดที่อ่านจากสลิป' : 'Slip amount'}: ฿${fmtCurrency(v.amount)}`);
  const sender = partyText(v && v.sender);
  const receiver = partyText(v && v.receiver);
  if (sender) details.push(`${th ? 'ผู้โอน' : 'Sender'}: ${sender}`);
  if (receiver) details.push(`${th ? 'ผู้รับ' : 'Receiver'}: ${receiver}`);
  if (v && v.nextAction) details.push(`${th ? 'ขั้นตอนถัดไป' : 'Next'}: ${v.nextAction}`);
  if (out && out.upload) {
    details.push(`${th ? 'จำนวนครั้งที่อัปโหลด' : 'Upload attempts'}: ${out.upload.used}/${out.upload.max}`);
  }
  return { kind, title, message, details };
}

function paymentNoticeFromError(err, locale) {
  const th = locale !== 'en';
  if (err && err.data && err.data.verification) {
    return paymentNoticeFromResponse(err.data, locale);
  }
  const code = err && (err.code || err.data?.code);
  const message = (err && err.message) || (th ? 'อัปโหลดสลิปไม่สำเร็จ' : 'Slip upload failed');
  const byCode = {
    CSRF_INVALID: th
      ? 'ระบบยืนยันความปลอดภัยหมดอายุ กรุณากดอัปโหลดอีกครั้งหรือรีเฟรชหน้า'
      : 'The security token expired. Upload again or refresh the page.',
    INVALID_SLIP: th
      ? 'ไฟล์สลิปไม่ถูกต้องหรืออ่านไม่ได้ กรุณาอัปโหลดรูป JPG/PNG/WebP ที่ชัดเจน'
      : 'Invalid slip file. Upload a clear JPG/PNG/WebP image.',
    AMOUNT_NOT_BILL_TOTAL: th
      ? 'ยอดที่กรอกไม่ตรงกับยอดบิล กรุณาตรวจยอดแล้วอัปโหลดใหม่'
      : 'The entered amount does not match the bill total.',
    DUPLICATE_SLIP_HASH: th
      ? 'สลิปนี้ถูกใช้ไปแล้ว กรุณาอัปโหลดสลิปของรายการโอนใหม่หรือติดต่อแอดมิน'
      : 'This slip was already used. Upload another transfer slip or contact admin.',
    DUPLICATE_TRANSACTION: th
      ? 'เลขอ้างอิงรายการโอนซ้ำ กรุณาใช้สลิปรายการใหม่หรือติดต่อแอดมิน'
      : 'Duplicate transfer reference. Upload a new transfer slip or contact admin.',
    PAYMENT_UNDER_REVIEW: th
      ? 'มีสลิปรอตรวจสอบอยู่แล้ว กรุณารอแอดมินอนุมัติหรือติดต่อแอดมิน'
      : 'A slip is already under review. Wait for admin approval or contact admin.',
    SLIP_UPLOAD_LIMIT_REACHED: th
      ? 'อัปโหลดครบ 3 ครั้งแล้ว ระบบไม่รับสลิปเพิ่ม กรุณาติดต่อแอดมิน'
      : 'The upload limit has been reached. Contact admin.',
  };
  const details = [];
  if (code) details.push(`${th ? 'รหัสข้อผิดพลาด' : 'Error code'}: ${code}`);
  if (err && err.data && err.data.upload) {
    details.push(`${th ? 'จำนวนครั้งที่อัปโหลด' : 'Upload attempts'}: ${err.data.upload.used}/${err.data.upload.max}`);
  }
  return {
    kind: 'error',
    title: th ? 'อัปโหลดสลิปไม่สำเร็จ' : 'Slip upload failed',
    message: byCode[code] || message,
    details,
  };
}

const STATUS_COLOR = {
  pending: '#c08a2a', overdue: '#b94a48', paid: '#2f8f5b', void: '#8a7d6b',
  open: '#c08a2a', assigned: '#3a7bba', in_progress: '#3a7bba',
  awaiting_parts: '#c08a2a', completed: '#2f8f5b', cancelled: '#8a7d6b',
};

// ------------------------------------------------------------- views ------

function LoginView({ locale, setLocale, onLoggedIn, portalEnabled }) {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const t = (k) => tr(locale, k);

  async function submit(e) {
    e.preventDefault();
    setErr(''); setBusy(true);
    // Strip the visual separators a tenant might paste in (081-234-5678,
    // 081 234 5678, 081.234.5678) so the same digits match the stored
    // phone regardless of how the tenant typed them. Server already accepts
    // 0XXXXXXXXX but the form previously sent the dashed version verbatim,
    // and a tenant who tried "081-234-5678" got "invalid login" even when
    // "0812345678" was correct.
    const normalizedPhone = String(phone || '').replace(/[\s\-.()]/g, '');
    try {
      const out = await api('/api/tenant/login', {
        method: 'POST', body: JSON.stringify({ phone: normalizedPhone }),
      });
      onLoggedIn(out.tenant);
    } catch (e2) {
      setErr(e2.status === 503 ? t('portalDisabled') : t('invalidLogin'));
    } finally { setBusy(false); }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <form onSubmit={submit} style={{
        background: 'var(--card)', color: 'var(--ink)', borderRadius: 16,
        padding: '36px 28px', width: '100%', maxWidth: 380,
        boxShadow: '0 20px 60px -20px rgba(0,0,0,0.25)',
      }}>
        <div style={{
          width: 56, height: 56, borderRadius: 14, marginBottom: 16,
          background: 'linear-gradient(135deg,#c46a3e,#a4542d)', color: '#fff',
          display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 24,
        }}>บก</div>
        <h1 style={{ margin: 0, fontFamily: 'Sora', fontWeight: 600, fontSize: 22 }}>{t('portal')}</h1>
        <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 22 }}>
          {portalEnabled === false ? t('portalDisabled') : 'บ้านกาญจน์ เรสซิเดนซ์'}
        </p>
        <fieldset disabled={portalEnabled === false || busy} style={{ border: 0, padding: 0, margin: 0 }}>
          <label style={lbl}>{t('phone')}</label>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} required
            type="tel" inputMode="tel" autoComplete="tel"
            maxLength={32} style={inp} placeholder="081-234-5678" />
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
            กรอกได้ทั้งรูปแบบ 081-234-5678 หรือ 0812345678 — ระบบจะปรับให้เอง
          </div>
          {err ? <div style={{ color: 'var(--red)', fontSize: 13, marginTop: 8 }}>{err}</div> : null}
          <button type="submit" style={btnPrimary}>{busy ? '…' : t('signIn')}</button>
        </fieldset>
        <div style={{ marginTop: 18, display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
          <a href="/" style={{ color: 'var(--muted)' }}>← กลับหน้าหลัก</a>
          <select value={locale} onChange={(e) => setLocale(e.target.value)}
            style={{ background: 'transparent', color: 'var(--muted)', border: 0 }}>
            <option value="th">ไทย</option>
            <option value="en">English</option>
          </select>
        </div>
      </form>
    </div>
  );
}

function Tab({ id, page, setPage, children }) {
  const active = page === id;
  return (
    <button onClick={() => setPage(id)} style={{
      flex: 1, padding: '14px 8px', border: 0, background: 'transparent',
      color: active ? 'var(--accent)' : 'var(--muted)',
      borderTop: active ? '2px solid var(--accent)' : '2px solid transparent',
      fontSize: 13, fontWeight: 500, cursor: 'pointer',
      fontFamily: 'inherit',
    }}>{children}</button>
  );
}

function HomeView({ tenant, locale, bills, tickets }) {
  const t = (k) => tr(locale, k);
  const latestBill = bills.find((b) => b.status === 'pending' || b.status === 'overdue');
  const openTickets = tickets.filter((x) => !['completed', 'cancelled'].includes(x.status)).length;
  return (
    <div style={{ padding: 20 }}>
      <h2 style={h2}>{t('welcome')}, {tenant.fullName}</h2>
      {tenant.roomId ? <p style={{ color: 'var(--muted)', margin: '4px 0 16px' }}>ห้อง {tenant.roomId}</p> : null}
      <div style={cardGrid}>
        <Stat label={t('bills')} value={bills.filter((b) => b.status !== 'paid' && b.status !== 'void').length} />
        <Stat label={t('maintenance')} value={openTickets} />
        <Stat label="รวมที่ค้าง"
          value={`฿${fmtCurrency(bills.filter((b) => ['pending', 'overdue'].includes(b.status)).reduce((s, x) => s + Number(x.total || 0), 0))}`} />
      </div>
      {latestBill ? (
        <div style={{ ...card, marginTop: 16 }}>
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>{t('bill')} {latestBill.bill_no}</div>
          <div style={{ fontFamily: 'Sora', fontSize: 22, fontWeight: 600, marginTop: 4 }}>฿{fmtCurrency(latestBill.total)}</div>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 6 }}>
            {t('dueDate')}: {latestBill.due_date} · <Pill color={STATUS_COLOR[latestBill.status]}>{t(latestBill.status)}</Pill>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={card}>
      <div style={{ color: 'var(--muted)', fontSize: 12 }}>{label}</div>
      <div style={{ fontFamily: 'Sora', fontWeight: 600, fontSize: 22, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function Pill({ children, color }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 999,
      fontSize: 11.5, fontWeight: 500, background: (color || '#888') + '22',
      color: color || 'var(--muted)',
    }}>{children}</span>
  );
}

function BillsView({ locale, bills, refresh, slipFeature }) {
  const t = (k) => tr(locale, k);
  const [openId, setOpenId] = useState(null);
  // Poll the bills list every 20s while the view is mounted. Without this,
  // a tenant who left /tenant#bills open would never see an admin's "ผ่าน"
  // decision (or a scheduler-flipped 'overdue' status) until they manually
  // navigated away and back. 20s is the same cadence as /admin#payments and
  // is well below the LINE/email notification round-trip — by the time the
  // tenant gets the LINE push, the list has already refreshed in the tab
  // they had open. Skip when a bill detail modal is open (that has its own
  // tighter 5s poll) to avoid double-firing.
  React.useEffect(() => {
    if (openId != null) return undefined;
    if (typeof refresh !== 'function') return undefined;
    const id = setInterval(() => refresh(), 20000);
    return () => clearInterval(id);
  }, [openId, refresh]);
  // Auto-open the bill detail when the tenant arrives via the LINE/email
  // deep link (/tenant?bill=ID). The notification body now embeds this
  // link so tapping it lands on the right bill instead of dropping the
  // tenant on the bill list. Only triggers once per mount + only when the
  // ?bill= bill actually belongs to this tenant (the list comes from
  // /api/tenant/bills which already filters by tenant_id, so a bill in
  // `bills` is implicitly owned).
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const params = new URLSearchParams(window.location.search);
      const wanted = Number(params.get('bill'));
      if (Number.isInteger(wanted) && wanted > 0 && bills.some((b) => b.id === wanted)) {
        setOpenId(wanted);
        // Clean the URL so refresh doesn't re-open after the tenant
        // dismisses the modal. Use history.replaceState to avoid a nav.
        params.delete('bill');
        const qs = params.toString();
        const newUrl = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
        window.history.replaceState({}, '', newUrl);
      }
    } catch { /* tolerate browsers without URLSearchParams */ }
    // bills.length used as dep so the effect re-runs once the bills array
    // arrives from the API (initial render has bills=[]).
  }, [bills.length]);
  const open = bills.find((b) => b.id === openId);
  return (
    <div style={{ padding: 20 }}>
      <h2 style={h2}>{t('bills')}</h2>
      {bills.length === 0 ? <p style={{ color: 'var(--muted)' }}>{t('noBills')}</p> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {bills.map((b) => (
            <div key={b.id} style={{ ...card, cursor: 'pointer' }} onClick={() => setOpenId(b.id)}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontFamily: 'Sora', fontWeight: 600 }}>{b.bill_no}</div>
                  <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>{t('period')} {b.period} · {t('dueDate')} {b.due_date}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: 'Sora', fontWeight: 600 }}>฿{fmtCurrency(b.total)}</div>
                  <Pill color={STATUS_COLOR[b.status]}>{t(b.status)}</Pill>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {open ? <BillDetail bill={open} locale={locale} onClose={() => setOpenId(null)}
        slipFeature={slipFeature} refresh={refresh} /> : null}
    </div>
  );
}

function BillDetail({ bill, locale, onClose, slipFeature, refresh }) {
  const t = (k) => tr(locale, k);
  const [amount, setAmount] = useState(String(bill.total));
  const [file, setFile] = useState(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [pay, setPay] = useState(null);
  const [paymentInfoError, setPaymentInfoError] = useState(null);
  // pay-readiness: server-side preflight that tells us which channels are
  // actually working for THIS bill + why others don't. Used to gate the
  // QR/slip UI and show a single info banner ("ทำไม QR ไม่ขึ้น") so the
  // tenant isn't left guessing why a button is missing.
  const [readiness, setReadiness] = useState(null);
  const [readinessError, setReadinessError] = useState(null);
  // qrFallback holds the EMV payload string returned by ?format=json when
  // the PNG <img> load fails. Banking apps accept the raw payload via
  // "scan from clipboard" / "paste payload to pay" — so even if our
  // qrcode-rendering pipeline crashes, the tenant can still pay by copying
  // this string into their banking app. Null until onError fires.
  const [qrFallback, setQrFallback] = useState(null);
  const [copied, setCopied] = useState(false);
  React.useEffect(() => {
    let cancelled = false;
    setReadiness(null);
    setReadinessError(null);
    setPay(null);
    setPaymentInfoError(null);
    fetch('/api/tenant/payment-info', { credentials: 'same-origin' })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        return d;
      })
      .then((d) => {
        if (!cancelled && d && d.payment) {
          setPay(d.payment);
          setPaymentInfoError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setPaymentInfoError(err.message || 'โหลดช่องทางชำระเงินไม่สำเร็จ');
        }
      });
    fetch(`/api/tenant/pay-readiness/${encodeURIComponent(bill.id)}`, { credentials: 'same-origin' })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (r.ok && d && d.ok) {
          setReadiness(d);
          setReadinessError(null);
          return;
        }
        setReadiness(null);
        setReadinessError({
          sev: r.status >= 500 ? 'med' : 'high',
          code: d.code || `HTTP_${r.status}`,
          msg: d.error || `HTTP ${r.status}`,
          fix: r.status >= 500
            ? (locale === 'th'
              ? 'ลองใหม่อีกครั้ง หากยังไม่สำเร็จให้ติดต่อสำนักงาน'
              : 'Try again. Contact the office if it still fails.')
            : null,
        });
      })
      .catch((err) => {
        if (!cancelled) {
          setReadinessError({
            sev: 'med',
            code: 'READINESS_FAILED',
            msg: err.message || (locale === 'th' ? 'ตรวจสอบช่องทางชำระเงินไม่สำเร็จ' : 'Payment preflight failed'),
            fix: locale === 'th'
              ? 'ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่'
              : 'Check your connection and try again.',
          });
        }
      });
    return () => { cancelled = true; };
  }, [bill.id, locale]);
  React.useEffect(() => {
    if (bill.status === 'paid' || bill.status === 'void') return undefined;
    const timer = setInterval(() => {
      if (typeof refresh === 'function') refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [bill.id, bill.status, refresh]);
  // Prefer the server-side channels.qr flag — it incorporates checks the
  // browser can't see (PromptPay shape valid, not the demo target, amount
  // within MAX_AMOUNT).
  const qrUrl = (readiness?.channels?.qr === true)
    ? `/api/tenant/bills/${encodeURIComponent(bill.id)}/qr`
    : null;
  const billTotal = Number(bill.total);
  const paymentAmount = Number(amount);
  const amountInvalid = !Number.isFinite(paymentAmount) || paymentAmount <= 0;
  const amountMismatch = !amountInvalid
    && Number.isFinite(billTotal)
    && Math.abs(paymentAmount - billTotal) > PAYMENT_TOLERANCE_THB;
  const readinessHardError = readinessError && readinessError.sev === 'high';
  const blockingIssues = readiness
    ? (readiness.issues || []).filter((i) => i.sev === 'high')
    : [];
  if (readinessHardError) blockingIssues.push(readinessError);
  const advisoryIssues = readiness
    ? (readiness.issues || []).filter((i) => i.sev !== 'high' && i.code !== 'BILL_ALREADY_PAID')
    : [];
  if (readinessError && !readinessHardError) advisoryIssues.push(readinessError);
  const readinessLoading = !readiness && !readinessError;
  const slipUploadBlocked = readinessLoading
    || readiness?.channels?.slip === false
    || !!readinessHardError
    || amountInvalid
    || amountMismatch;
  async function upload() {
    if (amountInvalid) {
      setNotice({ kind: 'error', title: locale === 'th' ? 'จำนวนเงินไม่ถูกต้อง' : 'Invalid amount', message: locale === 'th' ? 'กรุณาระบุจำนวนเงินให้ถูกต้อง' : 'Enter a valid payment amount.' });
      return;
    }
    if (amountMismatch) {
      setNotice({ kind: 'error', title: locale === 'th' ? 'ยอดไม่ตรงกับบิล' : 'Amount mismatch', message: `${t('amountMismatchWarn')} (฿${fmtCurrency(bill.total)})` });
      return;
    }
    if (readinessHardError) {
      setNotice({ kind: 'error', title: locale === 'th' ? 'ยังชำระผ่านระบบไม่ได้' : 'Payment unavailable', message: readinessError.msg || 'Payment is not available for this bill.' });
      return;
    }
    if (readinessLoading) {
      setNotice({
        kind: 'pending',
        title: locale === 'th' ? 'กำลังตรวจสอบช่องทางชำระเงิน' : 'Checking payment readiness',
        message: locale === 'th'
          ? 'กรุณารอสักครู่ ระบบกำลังตรวจสอบว่าบิลนี้รับสลิปได้หรือไม่'
          : 'Please wait while the system checks whether this bill can accept slips.',
      });
      return;
    }
    if (readiness?.channels?.slip === false) {
      const first = blockingIssues[0] || advisoryIssues[0];
      setNotice({ kind: 'error', title: locale === 'th' ? 'อัปโหลดสลิปไม่ได้' : 'Slip upload unavailable', message: first?.msg || 'Slip upload is not available for this bill.' });
      return;
    }
    if (!file) {
      setNotice({ kind: 'error', title: t('chooseFile'), message: locale === 'th' ? 'กรุณาแนบรูปสลิปก่อนกดยืนยัน' : 'Attach a slip image before submitting.' });
      return;
    }
    // Pre-flight using the readiness probe. Confirm if there's anything
    // unusual (different account configured, autoVerify not ready, etc.)
    // so the tenant gets a chance to read the reason before submitting.
    if (readiness && blockingIssues.length > 0) {
      const lines = blockingIssues.map((i, idx) => {
        const fix = i.fix ? `\n   → ${i.fix}` : '';
        return `${idx + 1}. 🔴 ${i.msg}${fix}`;
      }).join('\n\n');
      const ok = window.confirm(
        `⚠️ พบ ${blockingIssues.length} ปัญหาที่อาจทำให้ส่งสลิปไม่สำเร็จ:\n\n` +
        lines +
        `\n\n📌 ยืนยันส่งสลิปต่อหรือไม่?\n` +
        `   • กดยกเลิก → ติดต่อสำนักงานก่อน (แนะนำ)\n` +
        `   • กดตกลง → ส่งต่อ (อาจถูกปฏิเสธ)`
      );
      if (!ok) return;
    }
    setBusy(true);
    setNotice({
      kind: 'processing',
      title: locale === 'th' ? 'กำลังตรวจสอบสลิป' : 'Checking slip',
      message: locale === 'th'
        ? 'ระบบกำลังอัปโหลดและส่งสลิปไปตรวจสอบกับบริการตรวจสลิป กรุณารอสักครู่'
        : 'Uploading and verifying the slip. Please wait.',
    });
    try {
      const dataUrl = await fileToDataUrl(file);
      const out = await api('/api/tenant/payments', {
        method: 'POST',
        body: JSON.stringify({ billId: bill.id, amount: Number(amount), slip: dataUrl }),
      });
      setNotice(paymentNoticeFromResponse(out, locale));
      setFile(null);
      setFileInputKey((x) => x + 1);
      if (typeof refresh === 'function') refresh();
    } catch (e) {
      setNotice(paymentNoticeFromError(e, locale));
      if (typeof refresh === 'function') refresh();
    } finally { setBusy(false); }
  }
  return (
    <div style={modalBg} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0, fontFamily: 'Sora', fontWeight: 600 }}>{bill.bill_no}</h3>
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>{t('period')} {bill.period}</p>
        <div style={{ ...card, marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '4px 0' }}>
            <span>{t('total')}</span><strong>฿{fmtCurrency(bill.total)}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '4px 0' }}>
            <span>{t('dueDate')}</span><span>{bill.due_date}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '4px 0' }}>
            <span>{t('status')}</span><Pill color={STATUS_COLOR[bill.status]}>{t(bill.status)}</Pill>
          </div>
          <div style={{ borderTop: '1px dashed var(--border)', marginTop: 8, paddingTop: 8, fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>
            <div>{locale === 'en' ? 'Water' : 'ค่าน้ำ'}: {billUtilityDetail(bill, 'water', locale)}</div>
            <div>{locale === 'en' ? 'Electricity' : 'ค่าไฟ'}: {billUtilityDetail(bill, 'elec', locale)}</div>
          </div>
        </div>
        {/* Server-side blocking issues (PromptPay misconfigured, bill not
            payable, etc.). Render as a prominent banner so the tenant sees
            the reason WHY a QR/slip button might be missing instead of
            silently wondering. Includes a fix hint where applicable. */}
        {blockingIssues.length > 0 ? (
          <div style={{
            marginTop: 12, padding: 12,
            background: '#fff4f1',
            border: '1px solid #f5c0b4',
            borderRadius: 8,
            fontSize: 13, color: '#7a2920', lineHeight: 1.6,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>⚠️ ไม่สามารถจ่ายผ่านระบบได้ในขณะนี้</div>
            {blockingIssues.map((i, idx) => (
              <div key={idx} style={{ marginBottom: 4 }}>
                • {i.msg}
                {i.fix ? <div style={{ fontSize: 12, color: '#5b3022', marginLeft: 12 }}>→ {i.fix}</div> : null}
              </div>
            ))}
          </div>
        ) : null}
        {bill.status !== 'paid' && bill.status !== 'void' && (pay || qrUrl || qrFallback || paymentInfoError) ? (
          <div style={{ ...card, marginTop: 12 }}>
            <div style={{ fontFamily: 'Sora', fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
              ช่องทางชำระเงิน
            </div>
            {paymentInfoError ? (
              <div style={{
                marginBottom: 10, padding: 10,
                background: '#fffbe8', border: '1px solid #f0e3a7',
                borderRadius: 8, fontSize: 12.5, color: '#6b5b1a', lineHeight: 1.5,
              }}>
                โหลดรายละเอียดช่องทางชำระเงินไม่ครบ: {paymentInfoError}
                {qrUrl ? <div>ยังสามารถสแกน QR ด้านล่างได้ หาก QR แสดงผลปกติ</div> : null}
              </div>
            ) : null}
            {qrUrl && !qrFallback ? (
              <div style={{ textAlign: 'center', marginBottom: 12 }}>
                <img
                  src={qrUrl} alt="PromptPay QR" width="180" height="180"
                  style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 6, background: '#fff' }}
                  onError={(e) => {
                    // Image render failed (renderer crash / network blip /
                    // 5xx mid-stream). Hide the broken image and fetch the
                    // raw EMV payload so the tenant has a paste-to-pay
                    // fallback — most Thai bank apps accept the EMV string
                    // directly via "paste payload" UI.
                    e.currentTarget.style.display = 'none';
                    fetch(`${qrUrl}?format=json`, { credentials: 'same-origin' })
                      .then((r) => r.ok ? r.json() : null)
                      .then((d) => { if (d && d.payload) setQrFallback(d); })
                      .catch(() => { /* fall back to bank info card only */ });
                  }}
                />
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                  สแกน PromptPay {pay?.promptpayName ? `· ${pay.promptpayName}` : ''}
                </div>
              </div>
            ) : null}
            {qrFallback ? (
              <div style={{
                marginBottom: 12, padding: 12,
                background: '#fffbe8', border: '1px solid #f0e3a7',
                borderRadius: 8,
              }}>
                <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 4 }}>
                  ⚠ QR ไม่สามารถแสดงผลได้
                </div>
                <div style={{ fontSize: 12.5, color: '#6b5b1a', lineHeight: 1.6, marginBottom: 8 }}>
                  คัดลอกข้อความด้านล่างนำไป paste ในแอปธนาคารหัวข้อ "วาง PromptPay payload"
                  หรือใช้ข้อมูลโอนผ่านธนาคารด้านล่างแทน
                </div>
                <textarea
                  readOnly
                  value={qrFallback.payload}
                  onClick={(e) => e.target.select()}
                  style={{
                    width: '100%', minHeight: 60,
                    padding: 8, fontSize: 11,
                    fontFamily: 'JetBrains Mono, monospace',
                    border: '1px solid var(--border)', borderRadius: 6,
                    background: '#fff', resize: 'none',
                  }}
                />
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(qrFallback.payload);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    } catch {
                      // Old browsers / insecure contexts — instruct manual
                      // copy. The textarea is already select-on-click above
                      // so admin can ⌘C/Ctrl+C themselves.
                      setCopied('manual');
                      setTimeout(() => setCopied(false), 3000);
                    }
                  }}
                  style={{
                    marginTop: 8, padding: '6px 14px',
                    borderRadius: 6, border: 0, cursor: 'pointer',
                    background: copied === true ? '#2f8f5b' : 'var(--accent, #c46a3e)',
                    color: '#fff', fontFamily: 'inherit', fontSize: 13, fontWeight: 500,
                  }}
                >
                  {copied === true ? '✓ คัดลอกแล้ว'
                    : copied === 'manual' ? 'คัดลอกด้วย ⌘C / Ctrl+C'
                    : '📋 คัดลอก payload'}
                </button>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                  ยอด ฿{fmtCurrency(qrFallback.amount)}
                  {qrFallback.target ? ` · บัญชี …${String(qrFallback.target).slice(-4)}` : ''}
                </div>
              </div>
            ) : null}
            {pay?.bankInfo && pay.bankInfo.account ? (
              <div style={{ padding: 10, background: 'var(--card-alt, #f5efe3)', borderRadius: 8, marginBottom: 8 }}>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>โอนผ่านธนาคาร</div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{pay.bankInfo.bank}</div>
                <div style={{ fontSize: 14, fontFamily: 'JetBrains Mono, monospace' }}>{pay.bankInfo.account}</div>
                {pay.bankInfo.name ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>{pay.bankInfo.name}</div> : null}
              </div>
            ) : null}
            {(pay?.paymentMethods || [])
              .filter((m) => m.key !== 'promptpay' && m.key !== 'bank')
              .length > 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                ช่องทางอื่น: {(pay?.paymentMethods || [])
                  .filter((m) => m.key !== 'promptpay' && m.key !== 'bank')
                  .map((m) => m.label).join(', ')}
              </div>
            ) : null}
          </div>
        ) : null}
        {bill.status !== 'paid' && bill.status !== 'void' && slipFeature?.enabled ? (
          <div style={{ marginTop: 16 }}>
            <label style={lbl}>{t('amount')}</label>
            <input value={amount} onChange={(e) => setAmount(e.target.value)}
              type="number" step="0.01" style={inp} />
            {amountInvalid || amountMismatch ? (
              <div style={{ marginTop: 4, color: 'var(--red)', fontSize: 12.5 }}>
                {amountInvalid
                  ? (locale === 'th' ? 'กรุณาระบุจำนวนเงินให้ถูกต้อง' : 'Enter a valid payment amount.')
                  : `${t('amountMismatchWarn')} (฿${fmtCurrency(bill.total)})`}
              </div>
            ) : null}
            <label style={lbl}>{t('chooseFile')}</label>
            <input key={fileInputKey} type="file" accept="image/jpeg,image/png,image/webp"
              onChange={(e) => {
                // Reject too-big files up front instead of letting the server
                // 413 us — tenants on 4G shouldn't waste 30s uploading a 10MB
                // photo only to be told to try again.
                const f = e.target.files[0];
                if (f && f.size > 5 * 1024 * 1024) {
                  alert('ไฟล์ใหญ่เกินไป (เกิน 5 MB) — โปรดถ่ายใหม่หรือลดขนาดภาพก่อน');
                  e.target.value = '';
                  setFile(null);
                  return;
                }
                setFile(f);
              }}
              style={{ marginBottom: 6 }} />
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 12 }}>
              ภาพต้องชัด เห็น QR/หมายเลขอ้างอิงครบ · JPG/PNG/WebP · ไม่เกิน 5 MB
            </div>
            {/* Advisory notices (autoVerify ไม่พร้อม, ไม่ผูก LINE/email, ฯลฯ).
                Show inline above the submit so the tenant knows what to expect
                — e.g., "สลิปต้องรอ admin ตรวจสอบ < 24 ชม." instead of expecting
                instant verification. */}
            {advisoryIssues.length > 0 ? (
              <div style={{
                marginBottom: 10, padding: 10,
                background: '#fffbe8', border: '1px solid #f0e3a7',
                borderRadius: 8, fontSize: 12.5, color: '#6b5b1a', lineHeight: 1.5,
              }}>
                {advisoryIssues.map((i, idx) => (
                  <div key={idx} style={{ marginBottom: 2 }}>
                    {i.sev === 'med' ? '🟡' : 'ℹ️'} {i.msg}
                    {i.fix ? <span style={{ color: '#8a7a25' }}> — {i.fix}</span> : null}
                  </div>
                ))}
              </div>
            ) : null}
            {readinessLoading ? (
              <div style={{
                marginBottom: 10, padding: 10,
                background: '#eef5ff', border: '1px solid #b9d7ff',
                borderRadius: 8, fontSize: 12.5, color: '#214d78', lineHeight: 1.5,
              }}>
                กำลังตรวจสอบความพร้อมของบิลนี้ ระบบจะเปิดปุ่มอัปโหลดเมื่อยืนยันแล้วว่าสามารถรับสลิปได้
              </div>
            ) : null}
            <button onClick={upload} disabled={busy || slipUploadBlocked} style={btnPrimary}>{busy ? '…' : t('uploadSlip')}</button>
            {notice ? (
              <div style={{
                marginTop: 10, padding: 12, borderRadius: 8,
                fontSize: 13, lineHeight: 1.55,
                ...noticeStyle(notice.kind),
              }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>{notice.title}</div>
                <div>{notice.message}</div>
                {notice.details && notice.details.length ? (
                  <div style={{ marginTop: 8, fontSize: 12.5 }}>
                    {notice.details.map((line, idx) => <div key={idx}>- {line}</div>)}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {/* When slip upload is gated off, the tenant still sees this bill
            but has NO obvious payment channel — leading to "I see ฿4500
            owed but how do I pay?" tickets. Surface a fallback explainer
            with the QR + bank info that's already rendered above as the
            answer + a path to reach the operator. */}
        {bill.status !== 'paid' && bill.status !== 'void' && !slipFeature?.enabled ? (
          <div style={{
            marginTop: 16, padding: 12,
            background: 'var(--bg-soft, #faf6ee)',
            border: '1px solid var(--border, #ece4d4)',
            borderRadius: 8,
            fontSize: 13, color: 'var(--ink2, #5b4f40)', lineHeight: 1.6,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>📌 วิธีชำระเงิน</div>
            <div>1) สแกน PromptPay QR ด้านบน หรือโอนเข้าบัญชีธนาคาร</div>
            <div>2) ส่งสลิปให้เจ้าหน้าที่ทางช่องทางที่สะดวก (LINE, อีเมล หรือ ติดต่อสำนักงาน)</div>
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted, #8a7d6b)' }}>
              ℹ️ ระบบอัปโหลดสลิปอัตโนมัติยังไม่เปิดใช้งาน — ติดต่อสำนักงานเพื่อยืนยันการชำระ
            </div>
          </div>
        ) : null}
        {/* Always offer PDF download — paid bills become receipts, unpaid
            bills become a printable invoice tenants can save offline. The
            backend at /api/tenant/bills/:id/pdf re-renders from the stored
            row so amounts are authoritative even if the on-screen rate
            cards changed. Use a real <a target="_blank"> so the browser
            handles streaming + native PDF viewer. */}
        <a
          href={`/api/tenant/bills/${bill.id}/pdf`}
          target="_blank"
          rel="noopener"
          style={{ ...btnLink, display: 'inline-block', marginRight: 12, textDecoration: 'none' }}
        >
          📄 {bill.status === 'paid' ? t('receipt') : t('downloadPdf')}
        </a>
        <button onClick={onClose} style={btnLink}>{t('close')}</button>
      </div>
    </div>
  );
}

// PaymentsView — tenant-side history of slip submissions. Pulls from
// GET /api/tenant/payments which already returns the per-bill metadata
// (status, transRef, rejected reason). Without this view, a tenant who
// uploaded a slip earlier can't see whether it was accepted/rejected
// without scrolling through their LINE/email — and there's no record of
// rejected slips at all once the modal toast disappears.
function PaymentsView({ locale }) {
  const t = (k) => tr(locale, k);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  React.useEffect(() => {
    let cancelled = false;
    api('/api/tenant/payments')
      .then((d) => { if (!cancelled) setItems(d.payments || []); })
      .catch((e) => { if (!cancelled) setErr(e.message || 'failed'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  const STATUS_LABEL = {
    verified: t('paymentVerified'),
    pending: t('paymentPending'),
    rejected: t('paymentRejected'),
  };
  const STATUS_PILL = {
    verified: 'green', pending: 'amber', rejected: 'red',
  };
  return (
    <div style={{ padding: 20 }}>
      <h2 style={h2}>{t('paymentHistory')}</h2>
      {loading ? <p style={{ color: 'var(--muted)' }}>{t('loading')}</p> : null}
      {err ? <p style={{ color: 'var(--red)' }}>{err}</p> : null}
      {!loading && items.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>{t('nothingHere')}</p>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map((p) => (
          <div key={p.id} style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontWeight: 600 }}>
                  {p.bill_no || `#${p.bill_id}`}
                  {p.period ? <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · {p.period}</span> : null}
                </div>
                <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
                  {t('paymentDate')}: {p.created_at ? new Date(p.created_at).toLocaleString(locale === 'th' ? 'th-TH' : 'en-US') : '-'}
                </div>
              </div>
              <Pill color={STATUS_PILL[p.status] || 'gray'}>
                {STATUS_LABEL[p.status] || p.status}
              </Pill>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 14 }}>
              <span>{t('total')}</span>
              <strong>฿{fmtCurrency(p.amount)}</strong>
            </div>
            {p.method ? (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--muted)' }}>
                <span>{t('paymentMethod')}</span>
                <span>{p.method}</span>
              </div>
            ) : null}
            {p.status === 'rejected' && p.rejected_reason ? (
              <div style={{ marginTop: 6, fontSize: 13, color: 'var(--red)', lineHeight: 1.4 }}>
                <strong>{t('rejectedReason')}:</strong> {tenantRejectedReason(p.rejected_reason)}
              </div>
            ) : null}
            {p.transaction_ref ? (
              <div style={{ marginTop: 4, fontSize: 12, color: 'var(--muted)', fontFamily: 'JetBrains Mono, monospace' }}>
                {t('transRef')}: {p.transaction_ref}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function MaintenanceView({ locale, tenant, tickets, refresh }) {
  const t = (k) => tr(locale, k);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ category: 'electrical', priority: 'medium', title: '', description: '' });
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/maintenance', {
        method: 'POST',
        body: JSON.stringify({
          roomId: tenant.roomId, tenantName: tenant.fullName, tenantPhone: tenant.phone,
          category: form.category, priority: form.priority, title: form.title, description: form.description,
        }),
      });
      setShowForm(false);
      setForm({ category: 'electrical', priority: 'medium', title: '', description: '' });
      refresh();
    } catch (e2) { alert(e2.message); }
    finally { setBusy(false); }
  }
  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ ...h2, marginBottom: 0 }}>{t('maintenance')}</h2>
        <button onClick={() => setShowForm(true)} style={btnPrimarySmall}>+ {t('submitTicket')}</button>
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>{t('myTickets')} ({tickets.length})</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {tickets.map((x) => (
          <div key={x.id} style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontWeight: 600 }}>{x.title}</div>
                <div style={{ color: 'var(--muted)', fontSize: 12 }}>{x.ticket_no} · {x.category}</div>
              </div>
              <Pill color={STATUS_COLOR[x.status]}>{t(x.status)}</Pill>
            </div>
            {x.status === 'completed' && x.rating == null ? (
              <RateTicket ticketId={x.id} locale={locale} onDone={refresh} />
            ) : null}
            {x.rating != null ? (
              <div style={{ marginTop: 8, fontSize: 13, color: 'var(--muted)' }}>
                ⭐ {x.rating}/5{x.rating_comment ? ` · "${x.rating_comment}"` : ''}
              </div>
            ) : null}
          </div>
        ))}
        {tickets.length === 0 ? <p style={{ color: 'var(--muted)' }}>{t('nothingHere')}</p> : null}
      </div>
      {showForm ? (
        <div style={modalBg} onClick={() => setShowForm(false)}>
          <form style={modal} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
            <h3 style={{ margin: 0, fontFamily: 'Sora' }}>{t('submitTicket')}</h3>
            <label style={lbl}>{t('category')}</label>
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} style={inp}>
              {['electrical', 'plumbing', 'aircon', 'furniture', 'appliance', 'door_lock', 'wifi', 'other']
                .map((c) => <option key={c} value={c}>{t('cat_' + c)}</option>)}
            </select>
            <label style={lbl}>{t('priority')}</label>
            <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} style={inp}>
              {['critical', 'high', 'medium', 'low'].map((p) => (
                <option key={p} value={p}>{t('prio_' + p)}</option>
              ))}
            </select>
            <label style={lbl}>{t('title')}</label>
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required style={inp} />
            <label style={lbl}>{t('description')}</label>
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={4} style={{ ...inp, resize: 'vertical' }} />
            <button type="submit" disabled={busy} style={btnPrimary}>{busy ? '…' : t('submit')}</button>
            <button type="button" onClick={() => setShowForm(false)} style={btnLink}>{t('cancel')}</button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function RateTicket({ ticketId, locale, onDone }) {
  const t = (k) => tr(locale || 'th', k);
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function submit() {
    if (!stars) { setErr(t('ratePicked')); return; }
    setBusy(true); setErr('');
    try {
      await api(`/api/tenant/maintenance/${ticketId}/rate`, {
        method: 'POST',
        body: JSON.stringify({ rating: stars, comment: comment.trim() || undefined }),
      });
      onDone && onDone();
    } catch (e) {
      setErr(e.message || 'failed');
    } finally { setBusy(false); }
  }
  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
      <div style={{ fontSize: 13, color: 'var(--ink2)', marginBottom: 4 }}>{t('ratePrompt')}</div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 6 }} role="radiogroup" aria-label={t('ratePrompt')}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" onClick={() => setStars(n)}
            role="radio" aria-checked={n === stars} aria-label={`${n} ★`}
            style={{
              background: 'transparent', border: 0, fontSize: 26, cursor: 'pointer',
              color: n <= stars ? '#f1b32d' : 'var(--border)',
              minWidth: 44, minHeight: 44,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              padding: 0,
            }}>
            ★
          </button>
        ))}
      </div>
      <input value={comment} onChange={(e) => setComment(e.target.value)}
        placeholder={t('ratePlaceholder')} maxLength={500} style={inp} />
      {err ? <div style={{ color: 'var(--red)', fontSize: 12 }}>{err}</div> : null}
      <button onClick={submit} disabled={busy} style={{ ...btnPrimarySmall, marginTop: 6, minHeight: 44 }}>
        {busy ? '…' : t('submitRating')}
      </button>
    </div>
  );
}

function ProfileView({ tenant, locale, setLocale, theme, setTheme, onLogout, features }) {
  const t = (k) => tr(locale, k);
  return (
    <div style={{ padding: 20 }}>
      <h2 style={h2}>{t('profile')}</h2>
      <div style={card}>
        <div style={{ fontFamily: 'Sora', fontWeight: 600, fontSize: 18 }}>{tenant.fullName}</div>
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>{tenant.phone}</div>
        {tenant.email ? <div style={{ color: 'var(--muted)', fontSize: 13 }}>{tenant.email}</div> : null}
        {tenant.roomId ? <div style={{ marginTop: 6 }}>ห้อง {tenant.roomId}</div> : null}
      </div>
      <div style={{ ...card, marginTop: 12 }}>
        {features?.i18n?.enabled ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span>{t('language')}</span>
            <select value={locale} onChange={(e) => setLocale(e.target.value)} style={{ ...inp, width: 'auto', margin: 0 }}>
              <option value="th">ไทย</option>
              <option value="en">English</option>
            </select>
          </div>
        ) : null}
        {features?.darkMode?.enabled ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{t('darkMode')}</span>
            <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} style={btnLink}>
              {theme === 'dark' ? '🌙 ON' : '☀️ OFF'}
            </button>
          </div>
        ) : null}
      </div>
      <button onClick={onLogout} style={{ ...btnPrimary, background: 'transparent', color: 'var(--accent)', border: '1px solid var(--accent)', marginTop: 12 }}>
        {t('logOut')}
      </button>
    </div>
  );
}

// --------------------------------------------------------- styles --------
const lbl = { display: 'block', fontSize: 12.5, fontWeight: 500, color: 'var(--ink2)', margin: '12px 0 6px' };
const inp = {
  width: '100%', padding: '11px 14px', borderRadius: 10, border: '1px solid var(--border)',
  background: 'var(--bg)', color: 'var(--ink)', fontSize: 14.5, fontFamily: 'inherit',
  marginBottom: 4,
};
const btnPrimary = {
  width: '100%', padding: '12px 14px', marginTop: 16, borderRadius: 10,
  border: 0, background: 'var(--accent)', color: '#fff', fontWeight: 600, fontSize: 14,
  cursor: 'pointer', fontFamily: 'inherit',
};
const btnPrimarySmall = { ...btnPrimary, width: 'auto', marginTop: 0, padding: '8px 14px', fontSize: 13 };
const btnLink = {
  display: 'block', width: '100%', marginTop: 8, background: 'transparent',
  border: 0, color: 'var(--muted)', cursor: 'pointer', padding: 6, fontFamily: 'inherit', fontSize: 13,
};
const card = {
  background: 'var(--card)', border: '1px solid var(--border)',
  borderRadius: 12, padding: 16,
};
const cardGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(110px,1fr))', gap: 10 };
const h2 = { fontFamily: 'Sora', fontSize: 22, fontWeight: 600, margin: '0 0 12px' };
const modalBg = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
  display: 'grid', placeItems: 'center', zIndex: 100, padding: 16,
};
const modal = {
  background: 'var(--card)', color: 'var(--ink)', borderRadius: 16,
  padding: 24, width: '100%', maxWidth: 420,
  // On small screens a tall maintenance form (4+ fields) used to clip
  // below the viewport without a way to scroll. Cap height + scroll the
  // body inside the dialog.
  maxHeight: 'calc(100vh - 32px)', overflowY: 'auto',
};

// --------------------------------------------------------- App ----------
// Tenant-side contract view. Read-only: tenant verifies their own terms
// (rent, deposit, end date) without calling the office. Downloads PDF
// from /api/tenant/contract/:id/pdf — requires locked_at on the server
// side, so drafts won't leak. Returns a "not approved yet" notice if
// there's an invitation in pending/submitted but no locked contract.
function ContractView({ locale }) {
  const tt = (k) => tr(locale, k);
  const [state, setState] = useState({ loading: true, contract: null, error: null });

  useEffect(() => {
    let cancel = false;
    api('/api/tenant/contract')
      .then((d) => {
        if (cancel) return;
        setState({ loading: false, contract: d.contract, error: null });
      })
      .catch((err) => {
        if (cancel) return;
        setState({ loading: false, contract: null, error: err.message || 'load failed' });
      });
    return () => { cancel = true; };
  }, []);

  const fmtDate = (s) => {
    if (!s) return '—';
    try {
      return new Date(s).toLocaleDateString(locale === 'en' ? 'en-US' : 'th-TH',
        { year: 'numeric', month: 'short', day: 'numeric' });
    } catch { return String(s).slice(0, 10); }
  };

  if (state.loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>{tt('loading')}</div>;
  }

  const c = state.contract;
  if (!c) {
    return (
      <div style={{ padding: 20 }}>
        <h2 style={h2}>{tt('myContract')}</h2>
        <div style={{ ...card, marginTop: 12, color: 'var(--muted)', textAlign: 'center', padding: 28 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📜</div>
          {tt('noContract')}
        </div>
      </div>
    );
  }

  // The contract row carries locked_at via the /api/tenant/contract view.
  // PDF endpoint server-side requires locked_at — show a pending notice
  // instead of a dead "download" button when the contract is still draft.
  const isLocked = !!c.locked_at;

  return (
    <div style={{ padding: 20 }}>
      <h2 style={h2}>{tt('myContract')}</h2>
      <div style={{ ...card, marginTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <span style={{ fontSize: 22 }}>📄</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'Sora', fontSize: 16, fontWeight: 600 }}>
              {c.contract_no || '—'}
            </div>
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>
              {tt('contractRoom')} {c.room_id || '—'}
            </div>
          </div>
          {isLocked
            ? <Pill color="var(--green)">🔒 {tt('contractActive')}</Pill>
            : <Pill color="var(--amber)">{tt('contractPending')}</Pill>
          }
        </div>

        <ContractKV label={tt('contractStart')} value={fmtDate(c.start_date)} />
        <ContractKV label={tt('contractEnd')} value={fmtDate(c.end_date)} />
        <ContractKV
          label={tt('contractTerm')}
          value={c.term_months ? `${c.term_months} ${tt('contractMonths')}` : tt('contractOpenEnded')}
        />
        {c.days_left != null && c.days_left >= 0 ? (
          <ContractKV
            label={tt('contractDaysLeft')}
            value={`${c.days_left} ${tt('contractDays')}`}
            highlight={c.days_left <= 30}
          />
        ) : null}
        <ContractKV
          label={tt('contractRent')}
          value={`฿ ${fmtCurrency(c.monthly_rent)} / ${tt('contractMonths')}`}
          bold
        />
        {Number(c.discount_pct) > 0 ? (
          <ContractKV
            label={tt('contractDiscount')}
            value={`${Number(c.discount_pct).toFixed(1)}%`}
          />
        ) : null}
        <ContractKV label={tt('contractDeposit')} value={`฿ ${fmtCurrency(c.deposit)}`} />
        {c.signed_at ? (
          <ContractKV label={tt('contractSigned')} value={fmtDate(c.signed_at)} />
        ) : null}
      </div>

      {isLocked ? (
        <a
          href={`/api/tenant/contract/${c.id}/pdf?download=1`}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'block', textAlign: 'center', textDecoration: 'none',
            padding: '14px 18px', borderRadius: 12,
            background: 'var(--accent)', color: '#fff',
            fontFamily: 'Sora', fontWeight: 600, fontSize: 15,
            marginTop: 16,
          }}
        >
          📥 {tt('contractDownload')}
        </a>
      ) : null}
    </div>
  );
}

function ContractKV({ label, value, bold, highlight }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between',
      padding: '8px 0', borderBottom: '1px solid var(--border)',
      fontSize: 14,
    }}>
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span style={{
        fontWeight: bold ? 600 : 500,
        color: highlight ? 'var(--amber)' : 'var(--ink)',
        fontFamily: bold ? 'Sora' : 'inherit',
      }}>{value}</span>
    </div>
  );
}

function App() {
  const [tenant, setTenant] = useState(null);
  const [loading, setLoading] = useState(true);
  const [features, setFeatures] = useState(null);
  // B7 — whitelist values read from localStorage. Without this an attacker
  // who controls localStorage (XSS or shared device) could inject arbitrary
  // strings — most paths sanitise downstream but defense in depth is cheap.
  const ALLOWED_LOCALES = ['th', 'en'];
  const ALLOWED_THEMES = ['light', 'dark'];
  const _initLocale = localStorage.getItem('tenant_locale');
  const _initTheme = localStorage.getItem('tenant_theme');
  const [locale, setLocaleRaw] = useState(ALLOWED_LOCALES.includes(_initLocale) ? _initLocale : 'th');
  const [theme, setThemeRaw] = useState(ALLOWED_THEMES.includes(_initTheme) ? _initTheme : 'light');
  const [page, setPage] = useState('home');
  const [bills, setBills] = useState([]);
  const [tickets, setTickets] = useState([]);

  const setLocale = (v) => {
    setLocaleRaw(v);
    localStorage.setItem('tenant_locale', v);
    // Persist to server so the preference follows the tenant across
    // devices / cookie clears. Fail-soft: the localStorage copy still
    // works locally if the server call fails.
    if (tenant) {
      api('/api/tenant/me', {
        method: 'PUT', body: JSON.stringify({ locale: v }),
      }).catch(() => {});
    }
  };
  const setTheme = (v) => {
    setThemeRaw(v);
    document.body.dataset.theme = v;
    localStorage.setItem('tenant_theme', v);
  };

  useEffect(() => { document.body.dataset.theme = theme; }, [theme]);

  // Watch for session expiry from any api() call → log out cleanly so the
  // tenant doesn't stare at stale data with broken actions. Token cache
  // already cleared inside api().
  useEffect(() => {
    return onAuthExpired(() => {
      setTenant(null);
      setBills([]);
      setTickets([]);
      setPage('home');
    });
  }, []);

  useEffect(() => {
    (async () => {
      try {
        // credentials: 'same-origin' is required so the tenant_sid cookie
        // travels on the GET — without it /api/tenant/me always returns
        // null and the portal lands on the login screen even after a
        // valid login persisted by the previous session.
        const [me, f] = await Promise.all([
          fetch('/api/tenant/me', { credentials: 'same-origin' })
            .then((r) => r.json()).catch(() => ({ tenant: null })),
          fetch('/api/features', { credentials: 'same-origin' })
            .then((r) => r.json()).catch(() => ({ features: {} })),
        ]);
        setFeatures(f.features || {});
        if (me.tenant) {
          setTenant(me.tenant);
          if (me.tenant.locale) setLocale(me.tenant.locale);
          await refresh(me.tenant);
        }
      } finally { setLoading(false); }
    })();
  }, []);

  async function refresh(currentTenant) {
    const t = currentTenant || tenant;
    if (!t) return;
    try {
      const [billsR, ticketsR] = await Promise.all([
        api('/api/tenant/bills').catch(() => ({ bills: [] })),
        api('/api/tenant/maintenance').catch(() => ({ tickets: [] })),
      ]);
      setBills(billsR.bills || []);
      setTickets(ticketsR.tickets || []);
    } catch (e) { /* ignore */ }
  }

  async function onLoggedIn(t) {
    const me = await fetch('/api/tenant/me', { credentials: 'same-origin' })
      .then((r) => r.json());
    setTenant(me.tenant);
    await refresh(me.tenant);
    setPage('home');
  }
  async function onLogout() {
    // /api/tenant/logout went under csrfGuard — must use the api() wrapper
    // so X-CSRF-Token + cookie are attached. Raw fetch was 403'ing and
    // the session never actually closed.
    try { await api('/api/tenant/logout', { method: 'POST' }); }
    catch { /* clear local state regardless of server response */ }
    setTenant(null); setBills([]); setTickets([]); setPage('home');
  }

  if (loading) return <div style={{ padding: 40, textAlign: 'center' }}>{tr(locale, 'loading')}</div>;
  if (!tenant) return <LoginView locale={locale} setLocale={setLocale}
    onLoggedIn={onLoggedIn} portalEnabled={features?.tenantPortal?.enabled !== false} />;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <main style={{ flex: 1, paddingBottom: 64, maxWidth: 720, margin: '0 auto', width: '100%' }}>
        {page === 'home' && <HomeView tenant={tenant} locale={locale} bills={bills} tickets={tickets} />}
        {page === 'bills' && <BillsView locale={locale} bills={bills}
          refresh={() => refresh(tenant)} slipFeature={features?.slipUpload} />}
        {page === 'payments' && <PaymentsView locale={locale} />}
        {page === 'contract' && <ContractView locale={locale} />}
        {page === 'maintenance' && <MaintenanceView locale={locale} tenant={tenant}
          tickets={tickets} refresh={() => refresh(tenant)} />}
        {page === 'profile' && <ProfileView tenant={tenant} locale={locale} setLocale={setLocale}
          theme={theme} setTheme={setTheme} onLogout={onLogout} features={features} />}
      </main>
      <nav style={{
        position: 'sticky', bottom: 0, background: 'var(--card)',
        borderTop: '1px solid var(--border)', display: 'flex',
      }}>
        <Tab id="home" page={page} setPage={setPage}>{tr(locale, 'home')}</Tab>
        <Tab id="bills" page={page} setPage={setPage}>{tr(locale, 'bills')}</Tab>
        <Tab id="payments" page={page} setPage={setPage}>{tr(locale, 'payments')}</Tab>
        <Tab id="contract" page={page} setPage={setPage}>{tr(locale, 'contract')}</Tab>
        <Tab id="maintenance" page={page} setPage={setPage}>{tr(locale, 'maintenance')}</Tab>
        <Tab id="profile" page={page} setPage={setPage}>{tr(locale, 'profile')}</Tab>
      </nav>
    </div>
  );
}

// === Error boundary + offline banner ======================================
// Catches render-time exceptions in any view so a single bad bill/ticket
// row doesn't blank the whole portal. Reports to /api/client-error so the
// admin can see what blew up.
class TenantErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) {
    // Stringify only primitive fields. We never serialize the full err
    // object — React errors often contain DOM nodes / fibers / event refs
    // that JSON.stringify can't handle (the original "Converting circular
    // structure to JSON" we're trying to report would otherwise re-throw
    // and the report itself fails silently).
    try {
      fetch('/api/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          message: String(err && err.message ? err.message : err).slice(0, 1000),
          stack: String((err && err.stack) || '').slice(0, 4000),
          componentStack: String((info && info.componentStack) || '').slice(0, 4000),
          url: window.location.href,
        }),
      });
    } catch { /* ignore */ }
  }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{
        padding: 32, margin: 16, borderRadius: 16,
        background: 'var(--card)', color: 'var(--ink)', textAlign: 'center',
      }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
        <h2 style={{ margin: 0, fontFamily: 'Sora', fontWeight: 600, fontSize: 18 }}>
          เกิดข้อผิดพลาด
        </h2>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 8, marginBottom: 16 }}>
          {String(this.state.err?.message || 'unknown')}
        </p>
        <button
          onClick={() => this.setState({ err: null })}
          style={{
            padding: '10px 24px', borderRadius: 10, border: 0,
            background: 'var(--accent)', color: '#fff', fontWeight: 600,
            cursor: 'pointer', fontFamily: 'inherit',
          }}
        >ลองใหม่</button>
        <button
          onClick={() => window.location.href = '/tenant'}
          style={{
            display: 'block', margin: '12px auto 0', background: 'transparent',
            color: 'var(--muted)', border: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
          }}
        >โหลดหน้าใหม่</button>
      </div>
    );
  }
}

function TenantOfflineBanner() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  if (online) return null;
  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1000,
      background: '#b94a48', color: '#fff', padding: '8px 16px',
      textAlign: 'center', fontSize: 13.5, fontWeight: 500,
    }}>🔌 ไม่ได้เชื่อมต่ออินเทอร์เน็ต</div>
  );
}

// Global error sink — same pattern as admin/hooks.jsx. ErrorBoundary covers
// render errors; these listeners cover sync exceptions + unhandled async.
//
// safeStringify drops circular refs + DOM nodes + React fibers so reporting
// an error doesn't itself throw "Converting circular structure to JSON" —
// which was producing a confusing fallback page on tenant portal.
function _tenantSafeStringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, function (key, value) {
    if (typeof key === 'string' && key.startsWith('__react')) return '[ReactFiber]';
    if (value === window) return '[Window]';
    if (typeof Element !== 'undefined' && value instanceof Element) return '[DOM:' + value.tagName + ']';
    if (typeof Event !== 'undefined' && value instanceof Event) return '[Event:' + value.type + ']';
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  });
}
if (typeof window !== 'undefined' && !window.__tenant_err_bound) {
  window.__tenant_err_bound = true;
  let _lastReport = 0;
  function reportTenantError(payload) {
    const now = Date.now();
    if (now - _lastReport < 1000) return;
    _lastReport = now;
    let body;
    try { body = _tenantSafeStringify(payload); }
    catch { body = JSON.stringify({ message: 'unstringifiable payload' }); }
    try {
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon
        ? navigator.sendBeacon('/api/client-error', blob)
        : fetch('/api/client-error', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body, keepalive: true,
          });
    } catch { /* ignore */ }
  }
  window.addEventListener('error', (ev) => {
    reportTenantError({
      message: String(ev.message || 'window.onerror'),
      stack: String((ev.error && ev.error.stack) || '').slice(0, 4000),
      url: window.location.href, source: ev.filename, line: ev.lineno,
    });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    reportTenantError({
      message: 'unhandledrejection: ' + String((r && r.message) || r),
      stack: String((r && r.stack) || '').slice(0, 4000),
      url: window.location.href,
    });
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <>
    <TenantOfflineBanner />
    <TenantErrorBoundary>
      <App />
    </TenantErrorBoundary>
  </>
);
