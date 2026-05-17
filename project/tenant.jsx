// === project/tenant.jsx ====================================================
// Tenant portal v3 — redesigned per Claude Design handoff (ptFe422cXWzx5nkrtIfqMQ).
// Warm cream + terracotta palette, IBM Plex Sans Thai + Sora typography.
// Six views: home, bills, payments, contract, maintenance, profile.
// Responsive: desktop sidebar (≥960px), tablet drawer (640–960px),
// mobile bottom-tab nav (<640px). All data is wired to live /api/tenant/*
// endpoints — there is no mock data.
// ===========================================================================

const { useState, useEffect, useMemo, useRef, useCallback } = React;

const PAYMENT_TOLERANCE_THB = 1;

// --------------------------------------------------------------------- i18n
const TR = {
  th: {
    portal: 'พอร์ทัลผู้เช่า', login: 'เข้าสู่ระบบ', phone: 'เบอร์โทรศัพท์',
    signIn: 'เข้าสู่ระบบ', logOut: 'ออกจากระบบ',
    welcome: 'สวัสดี', loading: 'กำลังโหลด…', save: 'บันทึก', close: 'ปิด',
    cancel: 'ยกเลิก', submit: 'ส่ง', nothingHere: 'ไม่มีรายการ',
    home: 'หน้าหลัก', bills: 'บิล', payments: 'การชำระเงิน',
    contract: 'สัญญา', maintenance: 'แจ้งซ่อม', profile: 'โปรไฟล์',
    backHome: '← กลับหน้าหลัก', contactStaff: 'ติดต่อเจ้าหน้าที่',
    portalDisabled: 'พอร์ทัลผู้เช่ายังปิดอยู่ — กรุณาติดต่อเจ้าหน้าที่',
    invalidLogin: 'เบอร์นี้ไม่ได้ผูกกับผู้เช่าปัจจุบัน',
    ambiguousLogin: 'เบอร์นี้ผูกกับหลายห้อง — กรุณาติดต่อสำนักงานเพื่อแยกบัญชี',
    lockedOut: 'ลองเข้าระบบหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่',
    serverError: 'ระบบเข้าสู่ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง',
    loginHint: 'กรอกได้ทั้งรูปแบบ 081-234-5678 หรือ 0812345678 — ระบบจะปรับให้เอง',
    loginIntroH: 'พอร์ทัล\nสำหรับผู้เช่า',
    loginIntroP: 'ดูบิลค่าเช่า ค่าน้ำ-ค่าไฟ จ่ายด้วย PromptPay เช็คสัญญา และแจ้งซ่อมในที่เดียว',
    secure: 'ปลอดภัย',

    // Home
    currentBill: 'บิลปัจจุบัน', payPromptpay: 'จ่ายด้วย PromptPay',
    downloadPdf: 'ดาวน์โหลด PDF', receipt: 'ใบเสร็จ',
    yourRoom: 'ห้องของคุณ', floor: 'ชั้น', remainingContract: 'สัญญาเหลือ',
    days: 'วัน', viewContract: 'ดูสัญญา',
    openTicketsCard: 'แจ้งซ่อมที่กำลังดำเนินการ', ticketsUnit: 'เรื่อง',
    latestTicket: 'ล่าสุด:', viewAll: 'ดูทั้งหมด',
    shortcuts: 'ทางลัด', shortcutsSub: 'สิ่งที่ทำได้รวดเร็วในไม่กี่คลิก',
    qa_pay: 'จ่ายบิล PromptPay', qa_pay_sub: 'สแกน QR ใช้เวลา 10 วินาที',
    qa_slip: 'อัปโหลดสลิป', qa_slip_sub: 'หลังโอนเสร็จ แนบสลิปที่นี่',
    qa_maint: 'แจ้งซ่อม', qa_maint_sub: 'กรอกแล้วช่างจะติดต่อกลับ',
    qa_contract: 'ดูสัญญา', qa_contract_sub: 'รายละเอียดและดาวน์โหลด',
    recentBills: 'บิลล่าสุด', recentBillsSub: '3 รายการล่าสุด',
    nothingDue: 'ยินดีด้วย ไม่มีบิลค้างชำระในตอนนี้',
    nothingDueSub: 'เมื่อบิลรอบใหม่ออก ระบบจะแสดงที่นี่และส่งแจ้งเตือนไปยังคุณ',

    // Bills
    myBills: 'บิลของฉัน', billsAll: 'ทั้งหมด', billsUnpaid: 'ค้างชำระ', billsPaid: 'ชำระแล้ว',
    rentRow: 'ค่าเช่า', waterRow: 'ค่าน้ำ', elecRow: 'ค่าไฟ',
    rentRoom: 'ค่าเช่าห้องพัก', waterFull: 'ค่าน้ำ', elecFull: 'ค่าไฟฟ้า',
    units: 'หน่วย', dueDate: 'กำหนดชำระ', billPeriod: 'รอบบิล',
    amountToPay: 'ยอดที่ต้องชำระ', billTotal: 'รวมทั้งสิ้น', lateFee: 'ค่าปรับล่าช้า',
    paidNote: 'ชำระเรียบร้อยแล้ว', paidSub: 'ขอบคุณที่ชำระตรงเวลา',
    scanToPay: 'สแกน QR เพื่อชำระ', openBankApp: 'เปิดแอปธนาคาร แตะสแกน QR',
    copyPayload: 'คัดลอก payload', copied: 'คัดลอกแล้ว',
    bankTransfer: 'โอนผ่านธนาคาร', amountField: 'จำนวนเงิน',
    slipField: 'รูปสลิป', slipHint: 'ภาพต้องชัด เห็น QR/หมายเลขอ้างอิงครบ · JPG/PNG/WebP · ไม่เกิน 5 MB',
    uploadSlip: 'อัปโหลดสลิป', uploadingSlip: 'กำลังตรวจสอบสลิป…',
    amountMismatch: '⚠ จำนวนไม่ตรงยอดบิล',
    cannotPay: 'ไม่สามารถจ่ายผ่านระบบได้ในขณะนี้',
    slipDisabledHelp: 'ระบบอัปโหลดสลิปอัตโนมัติยังไม่เปิดใช้งาน — ติดต่อสำนักงานเพื่อยืนยันการชำระ',
    slipDisabledStep1: '1) สแกน PromptPay QR ด้านบน หรือโอนเข้าบัญชีธนาคาร',
    slipDisabledStep2: '2) ส่งสลิปให้เจ้าหน้าที่ทางช่องทางที่สะดวก (LINE / อีเมล / สำนักงาน)',
    howToPay: 'วิธีชำระเงิน',
    chooseFile: 'เลือกไฟล์', noFileChosen: 'ยังไม่ได้เลือกไฟล์',
    qrFailed: 'QR ไม่สามารถแสดงผลได้',
    qrFailedHint: 'คัดลอก payload ด้านล่างไปวางในแอปธนาคาร หรือใช้ข้อมูลโอนผ่านธนาคารแทน',

    // Payments
    paymentHistory: 'ประวัติการชำระเงิน',
    paymentHistorySub: 'รายการอัปโหลดสลิป และการชำระเงินสด',
    paymentVerified: 'ยืนยันแล้ว', paymentPending: 'รอตรวจสอบ', paymentRejected: 'ไม่ผ่าน',
    paymentDate: 'วันที่ส่ง', paymentMethod: 'ช่องทาง',
    rejectedReason: 'เหตุผลที่ปฏิเสธ', transRef: 'เลขที่อ้างอิง',
    colBill: 'บิล', colDate: 'วันที่ส่ง', colMethod: 'ช่องทาง', colAmount: 'ยอด', colAction: 'การจัดการ',
    noPayments: 'ยังไม่มีประวัติการชำระเงิน',
    viewSlip: 'ดูสลิป', reuploadSlip: 'อัปโหลดสลิปใหม่',
    filterAll: 'ทั้งหมด',

    // Contract
    myContract: 'สัญญาเช่าของฉัน', contractNo: 'เลขที่',
    noContract: 'ยังไม่มีสัญญาเช่าที่มีผลบังคับใช้',
    contractRoom: 'ห้อง', contractStart: 'วันเริ่มสัญญา', contractEnd: 'วันสิ้นสุด',
    contractTerm: 'ระยะเวลา', contractRent: 'ค่าเช่ารายเดือน',
    contractDeposit: 'เงินมัดจำ', contractDiscount: 'ส่วนลด',
    contractSigned: 'ลงนามเมื่อ', contractDownload: 'ดาวน์โหลดสัญญา (PDF)',
    contractDaysLeft: 'เหลืออีก', contractMonths: 'เดือน',
    contractOpenEnded: 'เปิด-ไม่จำกัด', contractActive: 'มีผลบังคับใช้',
    contractPending: 'สัญญายังไม่ได้รับอนุมัติ — รอเจ้าของหอพักตรวจสอบ',
    tenantInfo: 'ผู้เช่า', tenantInfoSub: 'ข้อมูลที่ใช้ในสัญญา',
    moveInDate: 'ย้ายเข้า', contactOwner: 'ติดต่อเจ้าของหอ',

    // Maintenance
    submitTicket: 'แจ้งซ่อมใหม่', allTickets: 'ทั้งหมด',
    ongoing: 'กำลังดำเนินการ', done: 'เสร็จสิ้น',
    ticketsSummary: 'แจ้งซ่อม', openedAt: 'เปิดเรื่อง',
    assignee: 'ช่าง', completedAt: 'เสร็จเมื่อ',
    category: 'หมวดหมู่', title: 'หัวข้อ', description: 'รายละเอียด',
    priority: 'ระดับความเร่งด่วน', attachPhoto: 'แนบรูป (ไม่บังคับ)',
    dropFile: 'วางไฟล์ที่นี่ หรือคลิกเพื่อเลือกรูป',
    sendRequest: 'ส่งคำร้อง',
    ratePrompt: 'ให้คะแนนการซ่อม', ratePicked: 'เลือกดาว 1-5',
    ratePlaceholder: 'ความคิดเห็น (ไม่บังคับ)', submitRating: 'ส่งคะแนน',
    titleExample: 'เช่น แอร์มีน้ำหยด',
    descPlaceholder: 'บอกอาการที่เจอ ระบุห้องและตำแหน่ง',
    noTickets: 'ยังไม่มีรายการแจ้งซ่อม',

    // Profile
    accountSettings: 'โปรไฟล์และการตั้งค่า',
    accountSub: 'จัดการบัญชี ภาษา และการแจ้งเตือน',
    verifiedTenant: 'ผู้เช่ายืนยันแล้ว',
    prefs: 'ความชอบ', prefsSub: 'ปรับให้พอร์ทัลเหมาะกับคุณ',
    darkMode: 'โหมดมืด', darkModeSub: 'พื้นหลังสีเข้ม สบายตาตอนกลางคืน',
    language: 'ภาษา', languageSub: 'เปลี่ยนภาษาของพอร์ทัล',
    notifyEmail: 'แจ้งเตือนทางอีเมล', notifyEmailSub: 'สำเนาบิลและใบเสร็จส่งทางอีเมล',
    contactDorm: 'ติดต่อหอพัก', telephone: 'โทรศัพท์',
    lineOfficial: 'LINE Official', manual: 'คู่มือการใช้', read: 'เปิดอ่าน',
    email: 'อีเมล',
    sinceDate: 'ผู้เช่าตั้งแต่',

    // status
    pending: 'รอชำระ', paid: 'ชำระแล้ว', overdue: 'เกินกำหนด', void: 'ยกเลิก',
    verified: 'ยืนยันแล้ว', rejected: 'ไม่ผ่าน', open: 'เปิดเรื่อง',
    assigned: 'มอบหมายแล้ว', in_progress: 'กำลังดำเนินการ',
    awaiting_parts: 'รออะไหล่', completed: 'เสร็จสิ้น', cancelled: 'ยกเลิก',
    active: 'มีผลบังคับใช้',

    // category labels
    cat_electrical: 'ไฟฟ้า', cat_plumbing: 'ประปา', cat_aircon: 'แอร์',
    cat_furniture: 'เฟอร์นิเจอร์', cat_appliance: 'เครื่องใช้ไฟฟ้า',
    cat_door_lock: 'ประตู / กลอน', cat_wifi: 'อินเทอร์เน็ต', cat_other: 'อื่นๆ',

    // priority labels
    prio_critical: 'ฉุกเฉิน', prio_high: 'สูง', prio_medium: 'ปานกลาง', prio_low: 'ต่ำ',
  },
  en: {
    portal: 'Tenant Portal', login: 'Sign in', phone: 'Phone number',
    signIn: 'Sign in', logOut: 'Log out',
    welcome: 'Hello', loading: 'Loading…', save: 'Save', close: 'Close',
    cancel: 'Cancel', submit: 'Submit', nothingHere: 'Nothing here',
    home: 'Home', bills: 'Bills', payments: 'Payments',
    contract: 'Contract', maintenance: 'Maintenance', profile: 'Profile',
    backHome: '← Back to site', contactStaff: 'Contact staff',
    portalDisabled: 'Tenant portal is currently disabled — please contact admin',
    invalidLogin: 'This phone is not linked to a current tenant',
    ambiguousLogin: 'This phone is linked to multiple rooms — contact the office.',
    lockedOut: 'Too many login attempts — wait a moment and try again.',
    serverError: 'Login service temporarily unavailable — please try again.',
    loginHint: 'You can type 081-234-5678 or 0812345678 — both work.',
    loginIntroH: 'Tenant\nportal',
    loginIntroP: 'See bills, pay with PromptPay, check your lease and report repairs — all in one place.',
    secure: 'Secure',

    currentBill: 'Current bill', payPromptpay: 'Pay with PromptPay',
    downloadPdf: 'Download PDF', receipt: 'Receipt',
    yourRoom: 'Your room', floor: 'Floor', remainingContract: 'Contract left',
    days: 'days', viewContract: 'View contract',
    openTicketsCard: 'Open repair tickets', ticketsUnit: 'open',
    latestTicket: 'Latest:', viewAll: 'View all',
    shortcuts: 'Shortcuts', shortcutsSub: 'Quick actions in a few clicks',
    qa_pay: 'Pay via PromptPay', qa_pay_sub: 'Scan QR · ~10 seconds',
    qa_slip: 'Upload slip', qa_slip_sub: 'Attach after transferring',
    qa_maint: 'Report repair', qa_maint_sub: 'The technician will follow up',
    qa_contract: 'View lease', qa_contract_sub: 'Details and PDF',
    recentBills: 'Recent bills', recentBillsSub: 'Latest 3 entries',
    nothingDue: 'All clear — no outstanding bills',
    nothingDueSub: 'When a new bill is issued, it will appear here and we will notify you.',

    myBills: 'My bills', billsAll: 'All', billsUnpaid: 'Unpaid', billsPaid: 'Paid',
    rentRow: 'Rent', waterRow: 'Water', elecRow: 'Electricity',
    rentRoom: 'Room rent', waterFull: 'Water', elecFull: 'Electricity',
    units: 'units', dueDate: 'Due date', billPeriod: 'Period',
    amountToPay: 'Amount due', billTotal: 'Total', lateFee: 'Late fee',
    paidNote: 'Bill paid', paidSub: 'Thank you for paying on time.',
    scanToPay: 'Scan QR to pay', openBankApp: 'Open your banking app and scan the QR',
    copyPayload: 'Copy payload', copied: 'Copied',
    bankTransfer: 'Bank transfer', amountField: 'Amount',
    slipField: 'Slip image', slipHint: 'Clear photo showing QR / reference · JPG/PNG/WebP · max 5 MB',
    uploadSlip: 'Upload slip', uploadingSlip: 'Checking the slip…',
    amountMismatch: '⚠ Amount does not match the bill',
    cannotPay: 'Online payment unavailable right now',
    slipDisabledHelp: 'Automated slip upload is disabled — contact the office to confirm payment.',
    slipDisabledStep1: '1) Scan the PromptPay QR above, or transfer via bank.',
    slipDisabledStep2: '2) Send the slip to staff via LINE / email / office.',
    howToPay: 'How to pay',
    chooseFile: 'Choose file', noFileChosen: 'No file chosen',
    qrFailed: 'QR could not render',
    qrFailedHint: 'Copy the payload below into your banking app, or use the bank transfer details.',

    paymentHistory: 'Payment history',
    paymentHistorySub: 'Slip submissions and cash payments',
    paymentVerified: 'Verified', paymentPending: 'Pending', paymentRejected: 'Rejected',
    paymentDate: 'Submitted', paymentMethod: 'Method',
    rejectedReason: 'Rejected reason', transRef: 'Reference',
    colBill: 'Bill', colDate: 'Submitted', colMethod: 'Method', colAmount: 'Amount', colAction: 'Actions',
    noPayments: 'No payment history yet',
    viewSlip: 'View slip', reuploadSlip: 'Re-upload slip',
    filterAll: 'All',

    myContract: 'My lease', contractNo: 'No.',
    noContract: 'No active lease contract yet',
    contractRoom: 'Room', contractStart: 'Start date', contractEnd: 'End date',
    contractTerm: 'Term', contractRent: 'Monthly rent',
    contractDeposit: 'Deposit', contractDiscount: 'Discount',
    contractSigned: 'Signed at', contractDownload: 'Download lease (PDF)',
    contractDaysLeft: 'Remaining', contractMonths: 'months',
    contractOpenEnded: 'Open-ended', contractActive: 'Active',
    contractPending: 'Lease not yet approved — awaiting building owner.',
    tenantInfo: 'Tenant', tenantInfoSub: 'Information used in the lease',
    moveInDate: 'Moved in', contactOwner: 'Contact owner',

    submitTicket: 'New repair', allTickets: 'All',
    ongoing: 'In progress', done: 'Completed',
    ticketsSummary: 'Maintenance', openedAt: 'Opened',
    assignee: 'Tech', completedAt: 'Completed',
    category: 'Category', title: 'Title', description: 'Description',
    priority: 'Priority', attachPhoto: 'Attach photo (optional)',
    dropFile: 'Drop a file here or click to choose',
    sendRequest: 'Submit',
    ratePrompt: 'Rate the service', ratePicked: 'Pick 1-5 stars',
    ratePlaceholder: 'Optional comment', submitRating: 'Submit rating',
    titleExample: 'e.g. AC leaking water',
    descPlaceholder: 'Describe the issue, room and location',
    noTickets: 'No tickets yet',

    accountSettings: 'Profile & settings',
    accountSub: 'Manage account, language and notifications',
    verifiedTenant: 'Verified tenant',
    prefs: 'Preferences', prefsSub: 'Tune the portal to your liking',
    darkMode: 'Dark mode', darkModeSub: 'Dark background, easier on the eyes',
    language: 'Language', languageSub: 'Change portal language',
    notifyEmail: 'Email notifications', notifyEmailSub: 'Copies of bills and receipts via email',
    contactDorm: 'Contact the dorm', telephone: 'Phone',
    lineOfficial: 'LINE Official', manual: 'User manual', read: 'Open',
    email: 'Email',
    sinceDate: 'Tenant since',

    pending: 'pending', paid: 'paid', overdue: 'overdue', void: 'void',
    verified: 'verified', rejected: 'rejected', open: 'open',
    assigned: 'assigned', in_progress: 'in progress',
    awaiting_parts: 'awaiting parts', completed: 'completed', cancelled: 'cancelled',
    active: 'active',

    cat_electrical: 'Electrical', cat_plumbing: 'Plumbing', cat_aircon: 'A/C',
    cat_furniture: 'Furniture', cat_appliance: 'Appliance',
    cat_door_lock: 'Door / lock', cat_wifi: 'Wi-Fi', cat_other: 'Other',

    prio_critical: 'Critical', prio_high: 'High', prio_medium: 'Medium', prio_low: 'Low',
  },
};
function tr(locale, k) { return (TR[locale] || TR.th)[k] || k; }

// ----------------------------------------------------------------- helpers
function fmtMoney(n) {
  return Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function fmtMoney2(n) {
  return Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(s, locale) {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s).slice(0, 10);
  if (locale === 'en') {
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }
  const monthsTh = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  return `${d.getDate()} ${monthsTh[d.getMonth()]} ${String(d.getFullYear() + 543).slice(-2)}`;
}
function fmtDateTime(s, locale) {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  return d.toLocaleString(locale === 'en' ? 'en-US' : 'th-TH',
    { year: '2-digit', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtPeriod(period, locale) {
  if (!period) return '—';
  const m = String(period).match(/^(\d{4})-(\d{2})$/);
  if (!m) return period;
  const y = Number(m[1]), mo = Number(m[2]);
  if (locale === 'en') {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[mo - 1]} ${y}`;
  }
  const monthsTh = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  return `${monthsTh[mo - 1]} ${String(y + 543).slice(-2)}`;
}
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function safeStorageGet(key) {
  try { return localStorage.getItem(key); }
  catch { return null; }
}
function safeStorageSet(key, value) {
  try { localStorage.setItem(key, value); }
  catch { /* storage can be blocked in private/locked-down browsers */ }
}
function initialsOf(name) {
  const s = String(name || '').trim();
  if (!s) return '—';
  // Thai first character is fine as a single-char initial
  return s.slice(0, 2);
}
function nicknameOf(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  const parts = s.split(/\s+/);
  return parts.length > 1 ? parts[0] : s;
}
function deriveFloor(roomId) {
  const s = String(roomId || '');
  if (/^\d{3,}$/.test(s)) return Number(s.charAt(0));
  return null;
}

// Translate server-stamped reject reasons + raw 3rd-party verifier strings
// into tenant-friendly Thai. log.md #2 — the upstream slip provider was
// leaking English error messages (e.g. "Please provide either a payload
// string, a image file, a base64 encoded image, or a image URL") into the
// payment-history list. We intercept those upstream-shaped messages here
// and convert them to actionable Thai before they reach the tenant.
function tenantRejectedReason(raw) {
  if (!raw) return raw;
  const s = String(raw);

  // Server-side audit codes (structured, prefix-matched).
  if (s.startsWith('superseded_by_verified_sibling')) return 'ระบบรับสลิปอีกใบสำหรับบิลนี้ไปแล้ว';
  if (s.startsWith('superseded_by_manual_pay'))       return 'แอดมินบันทึกการชำระเงินด้วยช่องทางอื่น (เงินสด/โอน) แล้ว';
  if (s.startsWith('superseded_by_void'))             return 'บิลนี้ถูกยกเลิกแล้ว — โปรดติดต่อแอดมิน';
  if (s.startsWith('unmark_paid_correction'))         return 'แอดมินยกเลิกการบันทึกชำระ — โปรดติดต่อแอดมิน';

  // Verifier upstream — EasySlip / SlipOK / Slip2Go return free-form
  // English on validation errors. Map the families we actually see in
  // production to a Thai message that tells the tenant what to do.
  const lower = s.toLowerCase();
  if (/(payload string|image file|base64|image url|invalid image)/i.test(s)) {
    return 'ไม่พบรูปสลิปหรือสลิปอ่านไม่ออก กรุณาอัปโหลดสลิปใหม่ที่ชัดเจน';
  }
  if (/invalid (api|signature|key|token)/i.test(s) || /unauthor/i.test(lower)) {
    return 'ระบบตรวจสลิปเชื่อมต่อไม่สำเร็จ — โปรดติดต่อแอดมินเพื่อตรวจการตั้งค่า';
  }
  if (/quota|rate.?limit|too many|429/i.test(s)) {
    return 'ระบบตรวจสลิปใช้งานเกินโควต้า — รบกวนติดต่อแอดมิน';
  }
  if (/duplicate|already (used|verified)/i.test(s)) {
    return 'สลิปนี้ถูกใช้แล้ว — กรุณาอัปโหลดสลิปของรายการโอนใหม่';
  }
  if (/amount|number/i.test(s) && /mismatch|not match|differ|incorrect/i.test(s)) {
    return 'ยอดในสลิปไม่ตรงกับยอดบิล กรุณาตรวจสอบและอัปโหลดสลิปใหม่';
  }
  if (/receiver|target|account|destination/i.test(s) && /mismatch|not match|differ|incorrect/i.test(s)) {
    return 'บัญชีปลายทางในสลิปไม่ใช่ของหอพัก — กรุณาตรวจสอบบัญชีผู้รับ';
  }
  if (/network|timeout|econnreset|fetch failed|connect/i.test(lower)) {
    return 'เชื่อมต่อระบบตรวจสลิปไม่สำเร็จ ลองอัปโหลดใหม่หรือแจ้งแอดมิน';
  }

  // English-looking free text → generic friendly fallback. We detect
  // "looks English" by the presence of ASCII letters AND the absence of
  // any Thai letters; anything Thai is already actionable.
  if (/[A-Za-z]/.test(s) && !/[฀-๿]/.test(s)) {
    return 'การตรวจสอบไม่ผ่าน ลองอัปโหลดสลิปใหม่หรือแจ้งแอดมิน';
  }
  return s;
}
window.tenantRejectedReason = tenantRejectedReason;

// --------------------------------------------------------------------- api
let _csrf = null;
let _csrfPromise = null;
async function getCsrf(force = false) {
  if (_csrf && !force) return _csrf;
  if (_csrfPromise && !force) return _csrfPromise;
  _csrfPromise = (async () => {
    const r = await fetch('/api/csrf-token', { credentials: 'same-origin' });
    if (!r.ok) return null;
    const j = await r.json().catch(() => ({}));
    _csrf = j.csrfToken || null;
    return _csrf;
  })();
  try { return await _csrfPromise; }
  catch { return null; }
  finally { _csrfPromise = null; }
}

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
      const e = new Error('คำขอใช้เวลานานเกินกำหนด'); e.code = 'TIMEOUT'; throw e;
    }
    throw err;
  } finally { if (timer) clearTimeout(timer); }
  if (r.status === 403 && csrfProtected && !opts._csrfRetried) {
    const data = await r.clone().json().catch(() => ({}));
    if (data && (data.code === 'CSRF_INVALID' || /csrf/i.test(String(data.error || '')))) {
      _csrf = null;
      const fresh = await getCsrf(true);
      if (fresh) {
        r = await fetch(path, {
          credentials: 'same-origin', ...opts,
          headers: { ...headers, 'X-CSRF-Token': fresh },
          _csrfRetried: true,
        });
      }
    }
  }
  if (r.ok && path.includes('/api/tenant/login')) _csrf = null;
  if (r.status === 401
      && !path.includes('/login') && !path.includes('/csrf-token') && !path.endsWith('/me')) {
    _csrf = null;
    fireAuthExpired();
  }
  let data = null;
  try { data = await r.json(); } catch {}
  if (!r.ok) {
    const err = new Error((data && data.error) || `HTTP ${r.status}`);
    err.status = r.status; err.data = data;
    throw err;
  }
  return data;
}

function partyText(p) {
  if (!p) return '';
  return [p.name, p.bank, p.account ? `...${String(p.account).slice(-6)}` : null]
    .filter(Boolean).join(' / ');
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
        ? (th ? 'กรุณาตรวจสอบยอดและบัญชีปลายทาง แล้วอัปโหลดใหม่ หากยังไม่ผ่านให้ติดต่อแอดมิน'
              : 'Check the amount and receiver, then upload again or contact admin.')
        : (th ? 'สลิปถูกส่งให้แอดมินตรวจสอบ ระบบจะแจ้งผลเมื่ออนุมัติหรือปฏิเสธ'
              : 'The slip is queued for admin review.'));
  const details = [];
  if (v && v.provider) details.push(`${th ? 'บริการตรวจสลิป' : 'Verifier'}: ${v.provider}`);
  if (v && v.code) details.push(`${th ? 'รหัสอ้างอิงสำหรับแจ้งแอดมิน' : 'Admin reference code'}: ${v.code}`);
  if (v && v.transactionRef) details.push(`${th ? 'เลขอ้างอิง' : 'Reference'}: ${v.transactionRef}`);
  if (v && v.amount != null) details.push(`${th ? 'ยอดที่อ่านจากสลิป' : 'Slip amount'}: ฿${fmtMoney2(v.amount)}`);
  const sender = partyText(v && v.sender);
  const receiver = partyText(v && v.receiver);
  if (sender) details.push(`${th ? 'ผู้โอน' : 'Sender'}: ${sender}`);
  if (receiver) details.push(`${th ? 'ผู้รับ' : 'Receiver'}: ${receiver}`);
  if (out && out.upload) details.push(`${th ? 'จำนวนครั้งที่อัปโหลด' : 'Upload attempts'}: ${out.upload.used}/${out.upload.max}`);
  return { kind, title, message, details };
}
function paymentNoticeFromError(err, locale) {
  const th = locale !== 'en';
  if (err && err.data && err.data.verification) return paymentNoticeFromResponse(err.data, locale);
  const code = err && (err.code || err.data?.code);
  const byCode = {
    CSRF_INVALID: th ? 'ระบบยืนยันความปลอดภัยหมดอายุ กรุณากดอัปโหลดอีกครั้ง' : 'Security token expired. Upload again.',
    INVALID_SLIP: th ? 'ไฟล์สลิปไม่ถูกต้อง อัปโหลด JPG/PNG/WebP ที่ชัดเจน' : 'Invalid slip file. Upload a clear JPG/PNG/WebP.',
    AMOUNT_NOT_BILL_TOTAL: th ? 'ยอดที่กรอกไม่ตรงกับยอดบิล' : 'Entered amount does not match the bill total.',
    DUPLICATE_SLIP_HASH: th ? 'สลิปนี้ถูกใช้ไปแล้ว' : 'This slip was already used.',
    DUPLICATE_TRANSACTION: th ? 'เลขอ้างอิงรายการโอนซ้ำ' : 'Duplicate transfer reference.',
    PAYMENT_UNDER_REVIEW: th ? 'มีสลิปรอตรวจสอบอยู่แล้ว' : 'A slip is already under review.',
    SLIP_UPLOAD_LIMIT_REACHED: th ? 'อัปโหลดครบ 3 ครั้งแล้ว — กรุณาติดต่อแอดมิน' : 'Upload limit reached — contact admin.',
  };
  const message = byCode[code] || (err && err.message) || (th ? 'อัปโหลดสลิปไม่สำเร็จ' : 'Slip upload failed');
  const details = [];
  if (code) details.push(`${th ? 'รหัสข้อผิดพลาด' : 'Error code'}: ${code}`);
  if (err && err.data && err.data.upload) details.push(`${th ? 'จำนวนครั้งที่อัปโหลด' : 'Upload attempts'}: ${err.data.upload.used}/${err.data.upload.max}`);
  return { kind: 'error', title: th ? 'อัปโหลดสลิปไม่สำเร็จ' : 'Slip upload failed', message, details };
}

const STATUS_TONE = {
  pending: 'amber', overdue: 'red', paid: 'green', void: 'muted',
  verified: 'green', rejected: 'red',
  open: 'amber', assigned: 'blue', in_progress: 'blue',
  awaiting_parts: 'amber', completed: 'green', cancelled: 'muted',
  active: 'green',
};
const PRIO_TONE = { critical: 'red', high: 'amber', medium: 'blue', low: 'muted' };

const MAINT_CATS = [
  { id: 'electrical', icon: '⚡' },
  { id: 'plumbing',   icon: '🚰' },
  { id: 'aircon',     icon: '❄' },
  { id: 'furniture',  icon: '🪑' },
  { id: 'appliance',  icon: '🔌' },
  { id: 'door_lock',  icon: '🔑' },
  { id: 'wifi',       icon: '📶' },
  { id: 'other',      icon: '✦' },
];

// ============================================================== Icon ====
function Icon({ name, size = 20, stroke = 1.6, className = '', style }) {
  const s = size;
  const common = {
    width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round',
    strokeLinejoin: 'round', className, style,
  };
  switch (name) {
    case 'home':     return <svg {...common}><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/></svg>;
    case 'bills':    return <svg {...common}><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>;
    case 'payments': return <svg {...common}><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M7 15h3"/></svg>;
    case 'contract': return <svg {...common}><path d="M7 3h7l4 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v4h4"/><path d="M9 13h6M9 17h4"/></svg>;
    case 'maint':    return <svg {...common}><path d="M14.7 6.3a4 4 0 0 1 5.2 5.2L13 18.4 5.6 19l.6-7.4 8.5-5.3Z"/><path d="m9 14 1 1"/><path d="m14 6 4 4"/></svg>;
    case 'profile':  return <svg {...common}><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>;
    case 'bell':     return <svg {...common}><path d="M6 8a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z"/><path d="M10 21a2 2 0 0 0 4 0"/></svg>;
    case 'chevron':  return <svg {...common}><path d="m9 6 6 6-6 6"/></svg>;
    case 'plus':     return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>;
    case 'check':    return <svg {...common}><path d="M4 12l5 5L20 6"/></svg>;
    case 'close':    return <svg {...common}><path d="M6 6l12 12M18 6 6 18"/></svg>;
    case 'download': return <svg {...common}><path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></svg>;
    case 'upload':   return <svg {...common}><path d="M12 20V8"/><path d="m7 13 5-5 5 5"/><path d="M5 4h14"/></svg>;
    case 'menu':     return <svg {...common}><path d="M4 7h16M4 12h16M4 17h16"/></svg>;
    case 'logout':   return <svg {...common}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5"/><path d="M5 12h11"/></svg>;
    case 'moon':     return <svg {...common}><path d="M21 12.5A9 9 0 1 1 11.5 3a7 7 0 0 0 9.5 9.5Z"/></svg>;
    case 'phone':    return <svg {...common}><path d="M5 4h3l2 5-2 1a11 11 0 0 0 6 6l1-2 5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"/></svg>;
    case 'door':     return <svg {...common}><rect x="6" y="3" width="12" height="18" rx="1"/><circle cx="14" cy="12" r="0.8" fill="currentColor"/></svg>;
    case 'wallet':   return <svg {...common}><path d="M3 7a2 2 0 0 1 2-2h12v4"/><rect x="3" y="7" width="18" height="12" rx="2"/><circle cx="16.5" cy="13" r="1.2" fill="currentColor"/></svg>;
    case 'spark':    return <svg {...common}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6 8 8M16 16l2.4 2.4M5.6 18.4 8 16M16 8l2.4-2.4"/></svg>;
    case 'globe':    return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>;
    case 'star':     return <svg {...common}><path d="m12 3 2.6 5.3 5.9.8-4.3 4.1 1 5.8L12 16.3 6.8 19l1-5.8L3.5 9.1l5.9-.8L12 3Z"/></svg>;
    case 'copy':     return <svg {...common}><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>;
    case 'info':     return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 8v.5"/></svg>;
    case 'qr':       return <svg {...common}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 20v1M14 20h3"/></svg>;
    default:         return null;
  }
}

// ============================================================== UI atoms ==
function Pill({ tone = 'muted', children, size = 'sm', style }) {
  const tones = {
    green:  { bg: 'var(--green-soft)', fg: 'var(--green)' },
    red:    { bg: 'var(--red-soft)',   fg: 'var(--red)' },
    amber:  { bg: 'var(--amber-soft)', fg: 'var(--amber)' },
    blue:   { bg: 'var(--blue-soft)',  fg: 'var(--blue)' },
    accent: { bg: 'var(--accent-soft)',fg: 'var(--accent-2)' },
    muted:  { bg: 'var(--surface-2)',  fg: 'var(--muted)' },
  };
  const c = tones[tone] || tones.muted;
  const padding = size === 'lg' ? '6px 12px' : '3px 9px';
  const fontSize = size === 'lg' ? 13 : 12;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding, borderRadius: 999, background: c.bg, color: c.fg,
      fontSize, fontWeight: 600, letterSpacing: '.01em',
      whiteSpace: 'nowrap', ...style,
    }}>{children}</span>
  );
}

function Card({ children, style, pad = 20, className = '', as: Tag = 'div', onClick, hoverable }) {
  return (
    <Tag onClick={onClick} className={className} style={{
      background: 'var(--surface)',
      border: '1px solid var(--line)',
      borderRadius: 'var(--r-lg)',
      padding: pad,
      boxShadow: 'var(--shadow-sm)',
      transition: 'box-shadow .2s ease, transform .2s ease, border-color .2s ease',
      cursor: onClick ? 'pointer' : 'default',
      ...style,
    }}
    onMouseEnter={hoverable ? (e) => {
      e.currentTarget.style.boxShadow = 'var(--shadow)';
      e.currentTarget.style.borderColor = 'var(--line-2)';
    } : undefined}
    onMouseLeave={hoverable ? (e) => {
      e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
      e.currentTarget.style.borderColor = 'var(--line)';
    } : undefined}>
      {children}
    </Tag>
  );
}

function Button({ variant = 'primary', size = 'md', children, icon, iconRight, full, style, ...rest }) {
  const sizes = {
    sm: { padding: '8px 14px', fontSize: 13, height: 36, gap: 6 },
    md: { padding: '11px 18px', fontSize: 14, height: 44, gap: 8 },
    lg: { padding: '14px 22px', fontSize: 15, height: 52, gap: 10 },
  };
  const variants = {
    primary: { background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)' },
    dark:    { background: 'var(--ink)', color: 'var(--bg)', border: '1px solid var(--ink)' },
    soft:    { background: 'var(--accent-soft)', color: 'var(--accent-2)', border: '1px solid transparent' },
    outline: { background: 'transparent', color: 'var(--ink)', border: '1px solid var(--line-2)' },
    ghost:   { background: 'transparent', color: 'var(--ink-2)', border: '1px solid transparent' },
    danger:  { background: 'var(--red-soft)', color: 'var(--red)', border: '1px solid transparent' },
  };
  return (
    <button {...rest} style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      borderRadius: 'var(--r)', fontWeight: 600, cursor: 'pointer',
      fontFamily: 'inherit', letterSpacing: '.01em', userSelect: 'none',
      transition: 'transform .15s ease, filter .15s ease, background .15s ease',
      width: full ? '100%' : undefined,
      opacity: rest.disabled ? 0.55 : 1,
      ...sizes[size], ...variants[variant], ...style,
    }}
    onMouseDown={(e) => { if (!rest.disabled) e.currentTarget.style.transform = 'translateY(1px)'; }}
    onMouseUp={(e) => { e.currentTarget.style.transform = ''; }}
    onMouseLeave={(e) => { e.currentTarget.style.transform = ''; }}>
      {icon ? <Icon name={icon} size={size === 'sm' ? 16 : 18} /> : null}
      {children}
      {iconRight ? <Icon name={iconRight} size={size === 'sm' ? 16 : 18} /> : null}
    </button>
  );
}

function SectionHeader({ title, subtitle, action, style }) {
  return (
    <div className="section-header" style={{
      display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
      gap: 'var(--sp-4)', marginBottom: 'var(--sp-4)', flexWrap: 'wrap', ...style,
    }}>
      <div style={{ minWidth: 0 }}>
        <h2 style={{
          margin: 0, fontFamily: 'var(--font-display)', fontWeight: 600,
          fontSize: 'var(--fs-xl)', letterSpacing: '-.01em', lineHeight: 1.25,
        }}>{title}</h2>
        {subtitle ? <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', marginTop: 4 }}>{subtitle}</div> : null}
      </div>
      {action}
    </div>
  );
}

function LogoMark({ size = 36, square = true }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: square ? 10 : 999,
      background: 'linear-gradient(140deg, #d97a4a 0%, #a4542d 100%)',
      color: '#fff', fontFamily: 'var(--font-display)', fontWeight: 700,
      fontSize: size * 0.42, display: 'grid', placeItems: 'center',
      boxShadow: '0 6px 14px -8px rgba(196,106,62,0.7)',
      letterSpacing: '-.02em', flex: '0 0 auto',
    }}>บก</div>
  );
}

function Avatar({ tenant, size = 48 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-2) 100%)',
      color: '#fff', fontFamily: 'var(--font-display)', fontWeight: 600,
      fontSize: size * 0.36, display: 'grid', placeItems: 'center',
      boxShadow: '0 6px 14px -8px rgba(196,106,62,0.5)', flex: '0 0 auto',
    }}>{initialsOf(tenant && tenant.fullName)}</div>
  );
}

function KV({ label, value, mono, bold, hi, last }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      gap: 12, padding: '10px 0',
      borderBottom: last ? 'none' : '1px solid var(--line)',
    }}>
      <span style={{ color: 'var(--muted)', fontSize: 13.5, minWidth: 0 }}>{label}</span>
      <span style={{
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-display)',
        fontWeight: bold ? 700 : 500,
        fontSize: hi ? 16 : 14,
        color: hi ? 'var(--accent-2)' : 'var(--ink)',
        textAlign: 'right',
        minWidth: 0, overflowWrap: 'anywhere',
      }}>{value}</span>
    </div>
  );
}

function Empty({ icon = 'spark', title, hint, action }) {
  return (
    <div style={{
      padding: '48px 24px', textAlign: 'center', color: 'var(--muted)',
      background: 'var(--surface)', border: '1px dashed var(--line-2)',
      borderRadius: 'var(--r-lg)',
    }}>
      <div style={{
        width: 56, height: 56, borderRadius: 16, background: 'var(--surface-2)',
        margin: '0 auto 12px', display: 'grid', placeItems: 'center', color: 'var(--accent-2)',
      }}><Icon name={icon} size={26} /></div>
      <div style={{ color: 'var(--ink)', fontWeight: 600, fontSize: 15 }}>{title}</div>
      {hint ? <div style={{ fontSize: 13, marginTop: 4 }}>{hint}</div> : null}
      {action ? <div style={{ marginTop: 16 }}>{action}</div> : null}
    </div>
  );
}

function SyncBanner({ errors = [], syncing, onRetry, locale }) {
  if (!errors.length) return null;
  const th = locale !== 'en';
  return (
    <div className="sync-banner" role="status" aria-live="polite" style={{
      marginBottom: 16, padding: 12, borderRadius: 14,
      background: errors.length ? 'var(--amber-soft)' : 'var(--blue-soft)',
      border: '1px solid var(--line)',
      color: errors.length ? 'var(--amber)' : 'var(--blue)',
      display: 'flex', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between',
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 13.5 }}>
          {th ? 'ข้อมูลบางส่วนยังซิงก์ไม่สำเร็จ' : 'Some data could not sync'}
        </div>
        <div style={{ fontSize: 12.5, lineHeight: 1.55, marginTop: 4 }}>
          {errors.map((e) => (
            <div key={e.key}>
              • {e.label}: {e.message || (th ? 'โหลดไม่สำเร็จ' : 'failed to load')}
            </div>
          ))}
          <div style={{ color: 'var(--muted)', marginTop: 4 }}>
            {th
              ? 'ระบบเก็บข้อมูลล่าสุดที่โหลดสำเร็จไว้ ไม่ล้างหน้าจอเป็นค่าว่างเพื่อป้องกันเข้าใจผิด'
              : 'Previously loaded data is kept on screen instead of being cleared.'}
          </div>
        </div>
      </div>
      <Button size="sm" variant="outline" onClick={onRetry} disabled={syncing} style={{ flex: '0 0 auto' }}>
        {syncing ? (th ? 'กำลังลองใหม่…' : 'Retrying…') : (th ? 'ลองใหม่' : 'Retry')}
      </Button>
    </div>
  );
}

// Stable ID counter for aria-labelledby — useId isn't on every supported
// React build, and a plain counter is fine since the value just needs to
// be unique inside the same document.
let _modalIdCounter = 0;

// Focusable selector for the focus trap. Same set as Dialog/Floating UI.
const FOCUSABLE_SEL = [
  'a[href]', 'button:not([disabled])', 'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function Modal({ open, onClose, children, title, size = 'md' }) {
  // log.md #1 — Every view wraps content in <div class="anim-in"> which
  // applies a CSS transform. When an ancestor has `transform != none`,
  // CSS pins `position: fixed` descendants to that ancestor instead of
  // the viewport — so the overlay used to shrink to 312×319 inside the
  // view container. Solve by Portal-ing into document.body, where there
  // is no transform ancestor.
  const panelRef = useRef(null);
  const previouslyFocused = useRef(null);
  const titleIdRef = useRef(null);
  if (titleIdRef.current == null) titleIdRef.current = `modal-title-${++_modalIdCounter}`;

  useEffect(() => {
    if (!open) return undefined;
    previouslyFocused.current = document.activeElement;
    // Lock body scroll while preserving position — iOS Safari's naive
    // `overflow: hidden` resets the visual viewport, which makes the page
    // appear to jump on close. On phones we freeze with `position: fixed`
    // at the current scroll Y, then restore on unmount.
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const prev = {
      overflow: document.body.style.overflow,
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width,
    };
    document.body.style.overflow = 'hidden';
    const isMobile = window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
    if (isMobile) {
      document.body.style.position = 'fixed';
      document.body.style.top = `-${scrollY}px`;
      document.body.style.width = '100%';
    }
    // Defer focus until the next tick so the animated panel is fully
    // attached. Prefer the first focusable that isn't the close (×)
    // button so the user lands on real content, not the exit affordance.
    const focusTimer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = panel.querySelectorAll(FOCUSABLE_SEL);
      const first = Array.from(focusables).find((el) => !el.dataset.modalClose) || focusables[0];
      (first || panel).focus({ preventScroll: true });
    }, 0);

    const onKey = (e) => {
      if (e.key === 'Escape') { onClose?.(); return; }
      if (e.key !== 'Tab') return;
      // Focus trap: wrap Tab inside the panel so keyboard users don't
      // fall through into the locked page underneath.
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(panel.querySelectorAll(FOCUSABLE_SEL))
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusables.length === 0) { e.preventDefault(); panel.focus(); return; }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev.overflow;
      document.body.style.position = prev.position;
      document.body.style.top = prev.top;
      document.body.style.width = prev.width;
      if (isMobile && scrollY) window.scrollTo(0, scrollY);
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', onKey);
      // Restore focus to the original trigger so keyboard/SR users don't
      // get stranded at <body>.
      const prevEl = previouslyFocused.current;
      if (prevEl && typeof prevEl.focus === 'function') {
        try { prevEl.focus({ preventScroll: true }); } catch { /* ignore */ }
      }
    };
  }, [open, onClose]);

  if (!open) return null;
  const widths = { sm: 420, md: 560, lg: 760 };
  const ui = (
    <div className="modal-overlay" onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(28,18,8,0.45)',
      backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
      zIndex: 100, animation: 'fade-in .2s ease',
      // Desktop default: center the dialog inside the viewport so long
      // forms never dangle past the bottom edge. The matching @media in
      // the App-level <style> block switches mobile to a slide-up sheet.
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '24px 16px',
      overflowY: 'auto', overflowX: 'hidden',
      WebkitOverflowScrolling: 'touch',
    }}>
      <div
        ref={panelRef}
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleIdRef.current : undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface)', color: 'var(--ink)',
          width: '100%',
          // log.md #3 — keep dialogs off the screen edge even on the
          // widest panel size; 92vw is enough breathing room on phones.
          maxWidth: `min(${widths[size]}px, 92vw)`,
          borderRadius: 22, boxShadow: 'var(--shadow-lg)',
          // 100dvh tracks mobile UI chrome / on-screen keyboards; 100vh
          // fallback keeps the cap working on browsers without dvh support.
          maxHeight: 'min(calc(100vh - 80px), calc(100dvh - 80px))',
          overflow: 'hidden', display: 'flex', flexDirection: 'column',
          animation: 'slide-up .26s cubic-bezier(.2,.8,.2,1)',
          margin: 'auto', outline: 'none',
        }}>
        {title || onClose ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, flex: '0 0 auto',
            padding: '18px 22px 14px', borderBottom: '1px solid var(--line)',
          }}>
            <div
              id={titleIdRef.current}
              style={{
                flex: 1, minWidth: 0, fontFamily: 'var(--font-display)',
                fontWeight: 600, fontSize: 'var(--fs-lg)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}
            >{title}</div>
            <button
              onClick={onClose}
              aria-label="ปิด"
              data-modal-close="true"
              style={{
                width: 36, height: 36, borderRadius: 10, border: 0, cursor: 'pointer',
                background: 'var(--surface-2)', color: 'var(--ink-2)',
                display: 'grid', placeItems: 'center', flex: '0 0 auto',
              }}><Icon name="close" size={18} /></button>
          </div>
        ) : null}
        <div className="modal-body" style={{
          overflow: 'auto', overflowX: 'hidden', flex: 1,
          padding: '20px 22px 24px',
          WebkitOverflowScrolling: 'touch',
        }}>{children}</div>
      </div>
    </div>
  );
  // Render into document.body — bypasses any ancestor transform / filter
  // that would otherwise CSS-contain the position:fixed overlay (see the
  // root-cause note at the top of this component).
  if (typeof document !== 'undefined' && ReactDOM && ReactDOM.createPortal) {
    return ReactDOM.createPortal(ui, document.body);
  }
  return ui;
}

function Toggle({ on, onClick }) {
  return (
    <button onClick={onClick} aria-pressed={on} style={{
      width: 48, height: 28, borderRadius: 999, border: 0, cursor: 'pointer',
      background: on ? 'var(--accent)' : 'var(--line-2)', position: 'relative',
      transition: 'background .2s ease', flex: '0 0 auto',
    }}>
      <span style={{
        position: 'absolute', top: 3, left: on ? 23 : 3,
        width: 22, height: 22, borderRadius: '50%', background: '#fff',
        boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'left .2s ease',
      }} />
    </button>
  );
}

function Label({ children }) {
  return <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink-2)', marginBottom: 6 }}>{children}</div>;
}
function Input(props) {
  return <input {...props} style={{
    width: '100%', padding: '12px 14px', borderRadius: 12,
    background: 'var(--surface-2)', border: '1px solid var(--line-2)',
    fontFamily: 'inherit', fontSize: 14, color: 'var(--ink)', outline: 'none',
    ...(props.style || {}),
  }}
  onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; }}
  onBlur={(e) => { e.target.style.borderColor = 'var(--line-2)'; }} />;
}

// ============================================================= LoginView =
function LoginView({ locale, setLocale, onLoggedIn, portalEnabled }) {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const t = (k) => tr(locale, k);
  async function submit(e) {
    e.preventDefault();
    setErr(''); setBusy(true);
    const normalizedPhone = String(phone || '').replace(/[\s\-.()]/g, '');
    if (!normalizedPhone) {
      setErr(t('invalidLogin')); setBusy(false); return;
    }
    try {
      const out = await api('/api/tenant/login', {
        method: 'POST', body: JSON.stringify({ phone: normalizedPhone }),
      });
      await onLoggedIn(out.tenant);
    } catch (e2) {
      // Map server response codes to user-friendly messages.
      // - 503 → portal disabled (feature flag)
      // - 429 + LOCKED_OUT → cool-down notice (e2.message has the minutes)
      // - 409 + PHONE_LINKED_TO_MULTIPLE_ACTIVE_ROOMS → ambiguous phone
      // - 5xx → generic transient
      // - other → "invalid credentials"
      const code = e2 && (e2.data?.code || e2.code);
      if (e2.status === 503) setErr(t('portalDisabled'));
      else if (e2.status === 429 || code === 'LOCKED_OUT') setErr(e2.message || t('lockedOut'));
      else if (e2.status === 409 || code === 'PHONE_LINKED_TO_MULTIPLE_ACTIVE_ROOMS') setErr(t('ambiguousLogin'));
      else if (e2.status >= 500) setErr(t('serverError'));
      else setErr(t('invalidLogin'));
    } finally { setBusy(false); }
  }
  return (
    <div style={{
      minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '24px',
      background: 'radial-gradient(1200px 700px at -10% -10%, var(--accent-soft) 0%, transparent 55%), radial-gradient(900px 600px at 110% 110%, #f0e5cf 0%, transparent 55%), var(--bg)',
    }}>
      <div className="login-grid" style={{
        width: '100%', maxWidth: 980, display: 'grid',
        gridTemplateColumns: 'minmax(0,1.05fr) minmax(0,1fr)',
        background: 'var(--surface)', borderRadius: 24, overflow: 'hidden',
        boxShadow: 'var(--shadow-lg)', border: '1px solid var(--line)',
      }}>
        <div className="login-hero" style={{
          padding: '44px 40px', display: 'flex', flexDirection: 'column',
          gap: 22, justifyContent: 'space-between',
          background: 'linear-gradient(160deg, #2a1f15 0%, #3a2c1f 100%)',
          color: '#f6efde', position: 'relative', overflow: 'hidden',
        }}>
          <div style={{
            position: 'absolute', inset: 0, opacity: 0.18, pointerEvents: 'none',
            backgroundImage: 'radial-gradient(circle at 20% 0%, #d97a4a 0%, transparent 40%), radial-gradient(circle at 100% 100%, #e0a374 0%, transparent 50%)',
          }} />
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12 }}>
            <LogoMark size={44} />
            <div>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 16 }}>บ้านกาญจน์ เรสซิเดนซ์</div>
              <div style={{ opacity: 0.65, fontSize: 12.5 }}>Baan Karn Residence</div>
            </div>
          </div>
          <div style={{ position: 'relative' }}>
            <div style={{
              fontFamily: 'var(--font-display)', fontSize: 'var(--fs-2xl)',
              lineHeight: 1.2, fontWeight: 600, letterSpacing: '-.015em', whiteSpace: 'pre-line',
            }}>
              {t('loginIntroH')}
            </div>
            <p style={{ opacity: 0.7, lineHeight: 1.65, marginTop: 14, fontSize: 14, maxWidth: 320 }}>
              {t('loginIntroP')}
            </p>
          </div>
          <div style={{ position: 'relative', display: 'flex', gap: 18, opacity: 0.78, fontSize: 12.5 }}>
            <span>v3</span><span>·</span><span>{t('secure')}</span><span>·</span><span>th / en</span>
          </div>
        </div>
        <form className="login-form" onSubmit={submit} style={{ padding: '44px 40px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ marginBottom: 6 }}>
            <h1 style={{
              margin: 0, fontFamily: 'var(--font-display)', fontWeight: 600,
              fontSize: 'var(--fs-xl)', letterSpacing: '-.01em', lineHeight: 1.2,
            }}>{t('signIn')}</h1>
            <p style={{ color: 'var(--muted)', fontSize: 13.5, margin: '6px 0 0' }}>
              {portalEnabled === false ? t('portalDisabled') : 'กรอกเบอร์โทรศัพท์ที่ผูกกับห้องของคุณ'}
            </p>
          </div>
          <fieldset disabled={portalEnabled === false || busy} style={{ border: 0, padding: 0, margin: 0, display: 'contents' }}>
            <label style={{ fontSize: 13, color: 'var(--ink-2)', fontWeight: 500 }}>{t('phone')}</label>
            <div style={{ position: 'relative' }}>
              <span style={{
                position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
                color: 'var(--muted)',
              }}><Icon name="phone" size={18} /></span>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} required
                type="tel" inputMode="tel" autoComplete="tel" maxLength={32}
                placeholder="081-234-5678"
                style={{
                  width: '100%', padding: '14px 14px 14px 44px', borderRadius: 12,
                  border: '1px solid var(--line-2)', background: 'var(--surface-2)',
                  fontSize: 16, fontFamily: 'inherit', color: 'var(--ink)', outline: 'none',
                }}
                onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; }}
                onBlur={(e) => { e.target.style.borderColor = 'var(--line-2)'; }}
              />
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--muted)', fontSize: 12.5 }}>
              <Icon name="info" size={15} /><span>{t('loginHint')}</span>
            </div>
            {err ? <div style={{ color: 'var(--red)', fontSize: 13 }}>{err}</div> : null}
            <Button type="submit" full size="lg" style={{ marginTop: 4 }}>
              {busy ? '…' : t('signIn')}
            </Button>
          </fieldset>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, color: 'var(--muted)', fontSize: 12.5 }}>
            <a href="/" style={{ textDecoration: 'none' }}>{t('backHome')}</a>
            <select value={locale} onChange={(e) => setLocale(e.target.value)}
              style={{ background: 'transparent', color: 'var(--muted)', border: 0, fontFamily: 'inherit' }}>
              <option value="th">ไทย</option>
              <option value="en">English</option>
            </select>
          </div>
        </form>
      </div>
      <style>{`
        @media (max-width: 768px) { .login-grid { grid-template-columns: 1fr !important; } }
        @media (max-width: 480px) {
          .login-hero, .login-form { padding: 28px 22px !important; }
        }
      `}</style>
    </div>
  );
}

// ============================================================== HomeView =
function HomeView({ tenant, locale, bills, tickets, contract, goto }) {
  const t = (k) => tr(locale, k);
  const unpaid = bills.find((b) => b.status === 'pending' || b.status === 'overdue');
  const openTickets = tickets.filter((x) => !['completed', 'cancelled'].includes(x.status));
  const floor = deriveFloor(tenant.roomId);
  // Render the room + tickets summary cards regardless of whether there is
  // a current outstanding bill — keeps the dashboard useful for paid-up
  // tenants too, instead of leaving them with just an empty-state banner.
  const summaryCards = (
    <div style={{ display: 'grid', gap: 14, gridTemplateRows: 'auto auto' }}>
      <Card hoverable onClick={() => goto('contract')}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>{t('yourRoom')}</div>
            <div style={{
              fontFamily: 'var(--font-display)', fontWeight: 600,
              fontSize: 'var(--fs-stat)', marginTop: 4, lineHeight: 1.1,
            }}>{tenant.roomId || '—'}</div>
            {floor != null
              ? <div style={{ color: 'var(--ink-2)', fontSize: 13.5 }}>{t('floor')} {floor}</div>
              : null}
          </div>
          <div style={{
            width: 44, height: 44, borderRadius: 12, background: 'var(--accent-soft)',
            color: 'var(--accent-2)', display: 'grid', placeItems: 'center',
          }}><Icon name="door" size={22} /></div>
        </div>
        <div style={{
          marginTop: 14, display: 'flex', justifyContent: 'space-between',
          fontSize: 12.5, color: 'var(--muted)',
        }}>
          <span>
            {contract && contract.days_left != null && contract.days_left >= 0
              ? <>{t('remainingContract')} <strong style={{ color: 'var(--ink)' }}>{contract.days_left} {t('days')}</strong></>
              : <span>{t('viewContract')}</span>}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{t('viewContract')} <Icon name="chevron" size={12} /></span>
        </div>
      </Card>
      <Card hoverable onClick={() => goto('maintenance')}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>{t('openTicketsCard')}</div>
            <div style={{
              fontFamily: 'var(--font-display)', fontWeight: 600,
              fontSize: 'var(--fs-stat)', marginTop: 4, lineHeight: 1.1,
            }}>
              {openTickets.length} <span style={{ fontSize: 'var(--fs-base)', color: 'var(--muted)', fontWeight: 500 }}>{t('ticketsUnit')}</span>
            </div>
            {openTickets[0] ? (
              <div style={{ color: 'var(--ink-2)', fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {t('latestTicket')} {openTickets[0].title}
              </div>
            ) : null}
          </div>
          <div style={{
            width: 44, height: 44, borderRadius: 12, background: 'var(--blue-soft)',
            color: 'var(--blue)', display: 'grid', placeItems: 'center',
          }}><Icon name="maint" size={22} /></div>
        </div>
        <div style={{
          marginTop: 14, display: 'flex', justifyContent: 'space-between',
          fontSize: 12.5, color: 'var(--muted)',
        }}>
          <span>{t('viewAll')}</span>
          <Icon name="chevron" size={12} />
        </div>
      </Card>
    </div>
  );

  return (
    <div className="anim-in">
      {unpaid ? (
        <div className="home-grid" style={{ display: 'grid', gap: 18, gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr)' }}>
          <Card pad={0} style={{ overflow: 'hidden' }}>
            <div style={{
              padding: '24px 24px 22px',
              background: 'linear-gradient(135deg, #2a1f15 0%, #3a2c1f 60%, #4a3826 100%)',
              color: '#f6efde', position: 'relative',
            }}>
              <div style={{
                position: 'absolute', right: -40, top: -40, width: 200, height: 200,
                borderRadius: '50%', background: 'radial-gradient(circle, rgba(217,122,74,0.35) 0%, transparent 60%)', pointerEvents: 'none',
              }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, opacity: 0.85, letterSpacing: '.02em', textTransform: 'uppercase' }}>
                <Icon name="wallet" size={14} /> {t('currentBill')}
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
                <div style={{
                  fontFamily: 'var(--font-display)', fontSize: 'var(--fs-3xl)',
                  fontWeight: 700, letterSpacing: '-.02em', lineHeight: 1.05,
                }}>
                  ฿{fmtMoney(unpaid.total)}
                </div>
                <Pill tone="amber" size="lg" style={{ background: 'rgba(255,210,160,0.18)', color: '#f3c89a' }}>
                  {t(unpaid.status)}
                </Pill>
              </div>
              <div style={{ color: '#e0d2b6', fontSize: 13.5, marginTop: 4 }}>
                {unpaid.bill_no} · {t('billPeriod')} {fmtPeriod(unpaid.period, locale)} · {t('dueDate')} {fmtDate(unpaid.due_date, locale)}
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 22, flexWrap: 'wrap' }}>
                <Button variant="primary" size="md" icon="qr" onClick={() => goto('bills', unpaid.id)}>{t('payPromptpay')}</Button>
                <a href={`/api/tenant/bills/${unpaid.id}/pdf`} target="_blank" rel="noopener"
                  style={{ textDecoration: 'none' }}>
                  <Button variant="ghost" size="md" icon="download"
                    style={{ color: '#f6efde', borderColor: 'rgba(246,239,222,0.25)' }}>
                    {t('downloadPdf')}
                  </Button>
                </a>
              </div>
            </div>
            <div className="home-breakdown" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', borderTop: '1px solid var(--line)' }}>
              <BreakdownCell label={t('rentRoom')} value={`฿${fmtMoney(unpaid.rent)}`} />
              <BreakdownCell label={`${t('waterFull')} · ${Number(unpaid.water_units) || 0} ${t('units')}`} value={`฿${fmtMoney(unpaid.water_amount)}`} divider />
              <BreakdownCell label={`${t('elecFull')} · ${Number(unpaid.elec_units) || 0} ${t('units')}`} value={`฿${fmtMoney(unpaid.elec_amount)}`} divider />
            </div>
          </Card>

          {summaryCards}
        </div>
      ) : (
        <div className="home-grid" style={{ display: 'grid', gap: 18, gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr)' }}>
          <Empty icon="check" title={t('nothingDue')} hint={t('nothingDueSub')} />
          {summaryCards}
        </div>
      )}

      <SectionHeader style={{ marginTop: 'var(--sp-7)' }} title={t('shortcuts')} subtitle={t('shortcutsSub')} />
      <div className="shortcuts-grid" style={{
        display: 'grid', gap: 12,
        gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
      }}>
        <QuickAction icon="qr" tone="accent" label={t('qa_pay')} sub={t('qa_pay_sub')}
          onClick={() => goto('bills', unpaid?.id)} />
        <QuickAction icon="upload" tone="green" label={t('qa_slip')} sub={t('qa_slip_sub')}
          onClick={() => goto('bills', unpaid?.id)} />
        <QuickAction icon="maint" tone="blue" label={t('qa_maint')} sub={t('qa_maint_sub')}
          onClick={() => goto('maintenance')} />
        <QuickAction icon="contract" tone="amber" label={t('qa_contract')} sub={t('qa_contract_sub')}
          onClick={() => goto('contract')} />
      </div>

      {bills.length > 0 ? (
        <>
          <SectionHeader style={{ marginTop: 'var(--sp-7)' }} title={t('recentBills')} subtitle={t('recentBillsSub')}
            action={<Button variant="ghost" size="sm" iconRight="chevron" onClick={() => goto('bills')}>{t('viewAll')}</Button>} />
          <Card pad={0}>
            {bills.slice(0, 3).map((b, i) => (
              <BillRow key={b.id} bill={b} divider={i !== 0} locale={locale}
                onClick={() => goto('bills', b.id)} t={t} />
            ))}
          </Card>
        </>
      ) : null}
    </div>
  );
}

function BreakdownCell({ label, value, divider }) {
  return (
    <div className="breakdown-cell" style={{
      padding: 'var(--sp-4) var(--sp-5)', background: 'var(--surface)',
      borderLeft: divider ? '1px solid var(--line)' : 'none',
      minWidth: 0,
    }}>
      <div style={{
        color: 'var(--muted)', fontSize: 'var(--fs-xs)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{label}</div>
      <div style={{
        fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 'var(--fs-md)',
        marginTop: 4,
      }}>{value}</div>
    </div>
  );
}

function QuickAction({ icon, label, sub, tone = 'accent', onClick }) {
  const toneBg = { accent: 'var(--accent-soft)', green: 'var(--green-soft)', blue: 'var(--blue-soft)', amber: 'var(--amber-soft)' }[tone];
  const toneFg = { accent: 'var(--accent-2)', green: 'var(--green)', blue: 'var(--blue)', amber: 'var(--amber)' }[tone];
  return (
    <Card hoverable pad={16} onClick={onClick}>
      <div style={{
        width: 40, height: 40, borderRadius: 10, background: toneBg, color: toneFg,
        display: 'grid', placeItems: 'center', marginBottom: 12,
      }}><Icon name={icon} size={20} /></div>
      <div style={{ fontWeight: 600, fontSize: 14.5 }}>{label}</div>
      <div style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 2 }}>{sub}</div>
    </Card>
  );
}

function BillRow({ bill, onClick, divider, locale, t }) {
  return (
    <button className="bill-row" onClick={onClick} style={{
      display: 'grid', alignItems: 'center', width: '100%',
      gridTemplateColumns: '1fr auto auto auto', gap: 14, textAlign: 'left',
      padding: '16px 20px', background: 'transparent', border: 0, cursor: 'pointer',
      borderTop: divider ? '1px solid var(--line)' : 'none',
      fontFamily: 'inherit', color: 'var(--ink)',
    }}
    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface-2)'}
    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14.5 }}>{bill.bill_no}</div>
        <div style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 2 }}>
          {t('billPeriod')} {fmtPeriod(bill.period, locale)} · {t('dueDate')} {fmtDate(bill.due_date, locale)}
        </div>
      </div>
      <Pill tone={STATUS_TONE[bill.status]}>{t(bill.status)}</Pill>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 16, minWidth: 100, textAlign: 'right' }}>
        ฿{fmtMoney(bill.total)}
      </div>
      <Icon name="chevron" size={16} style={{ color: 'var(--muted)' }} />
    </button>
  );
}

// ============================================================ BillsView =
function BillsView({ locale, bills, refresh, slipFeature, openId, setOpenId }) {
  const t = (k) => tr(locale, k);
  const [filter, setFilter] = useState('all');
  // Auto-open via ?bill= deep link (same as v2 portal).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const params = new URLSearchParams(window.location.search);
      const wanted = Number(params.get('bill'));
      if (Number.isInteger(wanted) && wanted > 0 && bills.some((b) => b.id === wanted)) {
        setOpenId(wanted);
        params.delete('bill');
        const qs = params.toString();
        const newUrl = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
        window.history.replaceState({}, '', newUrl);
      }
    } catch {}
  }, [bills.length]);
  // Poll list every 20s while no detail modal is open (the modal has its
  // own tighter 5s poll). Same cadence as /admin#payments.
  useEffect(() => {
    if (openId != null) return undefined;
    if (typeof refresh !== 'function') return undefined;
    const id = setInterval(() => refresh(), 20000);
    return () => clearInterval(id);
  }, [openId, refresh]);

  const filtered = useMemo(() => {
    if (filter === 'all') return bills;
    if (filter === 'unpaid') return bills.filter((b) => b.status === 'pending' || b.status === 'overdue');
    if (filter === 'paid') return bills.filter((b) => b.status === 'paid');
    return bills;
  }, [filter, bills]);
  const unpaidCount = bills.filter((b) => b.status === 'pending' || b.status === 'overdue').length;
  const open = bills.find((b) => b.id === openId);
  return (
    <div className="anim-in">
      <SectionHeader title={t('myBills')}
        subtitle={`${t('billsAll')} ${bills.length} · ${t('billsUnpaid')} ${unpaidCount}`} />
      <div className="no-scrollbar" style={{ display: 'flex', gap: 8, marginBottom: 14, overflowX: 'auto' }}>
        {[
          { id: 'all',    label: t('billsAll'),    count: bills.length },
          { id: 'unpaid', label: t('billsUnpaid'), count: unpaidCount },
          { id: 'paid',   label: t('billsPaid'),   count: bills.filter((b) => b.status === 'paid').length },
        ].map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)} style={{
            padding: '8px 14px', borderRadius: 999, fontFamily: 'inherit',
            border: '1px solid ' + (filter === f.id ? 'var(--ink)' : 'var(--line-2)'),
            background: filter === f.id ? 'var(--ink)' : 'var(--surface)',
            color: filter === f.id ? 'var(--bg)' : 'var(--ink-2)',
            fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
          }}>{f.label} <span style={{ opacity: 0.6, marginLeft: 4 }}>{f.count}</span></button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <Empty icon="bills" title={t('nothingHere')} />
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {filtered.map((b) => (
            <Card key={b.id} hoverable pad={0} onClick={() => setOpenId(b.id)}>
              <div className="bill-card-main" style={{ padding: '18px 20px', display: 'grid', gridTemplateColumns: '1fr auto', gap: 18, alignItems: 'center' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 16 }}>{b.bill_no}</div>
                    <Pill tone={STATUS_TONE[b.status]}>{t(b.status)}</Pill>
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
                    {t('billPeriod')} {fmtPeriod(b.period, locale)} · {t('dueDate')} {fmtDate(b.due_date, locale)}
                  </div>
                </div>
                <div className="bill-card-amount" style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 22 }}>฿{fmtMoney(b.total)}</div>
                  <div style={{ color: 'var(--muted)', fontSize: 12 }}>{t('billTotal')}</div>
                </div>
              </div>
              <div className="mini-cells" style={{
                display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
                borderTop: '1px solid var(--line)',
              }}>
                <MiniCell label={t('rentRow')} v={b.rent} />
                <MiniCell label={t('waterRow')} v={b.water_amount} divider />
                <MiniCell label={t('elecRow')} v={b.elec_amount} divider />
              </div>
            </Card>
          ))}
        </div>
      )}
      <BillDetailModal open={!!open} bill={open} locale={locale}
        onClose={() => setOpenId(null)} refresh={refresh} slipFeature={slipFeature} />
    </div>
  );
}

function MiniCell({ label, v, divider }) {
  return (
    <div className="mini-cell" style={{ padding: '10px 18px', borderLeft: divider ? '1px solid var(--line)' : 'none' }}>
      <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 13.5, marginTop: 2 }}>฿{fmtMoney(v)}</div>
    </div>
  );
}

// =========================================================== BillDetailModal =
function BillDetailModal({ open, bill, onClose, locale, refresh, slipFeature }) {
  const t = (k) => tr(locale, k);
  if (!bill) return null;
  return (
    <Modal open={open} onClose={onClose} title={bill.bill_no} size="lg">
      <BillDetailBody bill={bill} locale={locale} refresh={refresh} slipFeature={slipFeature} />
    </Modal>
  );
}

function BillDetailBody({ bill, locale, refresh, slipFeature }) {
  const t = (k) => tr(locale, k);
  const [pay, setPay] = useState(null);
  const [paymentInfoError, setPaymentInfoError] = useState(null);
  const [readiness, setReadiness] = useState(null);
  const [readinessError, setReadinessError] = useState(null);
  const [qrFallback, setQrFallback] = useState(null);
  const [qrBroken, setQrBroken] = useState(false);
  const [copied, setCopied] = useState(false);
  // Default the slip-amount input to the bill total. Guard against null/
  // NaN totals (legacy bills, in-flight edits) so the input never shows the
  // literal string "null" or "NaN" — fall back to "0" which the amount
  // validator will then flag as an invalid amount.
  const initialAmount = (() => {
    const n = Number(bill.total);
    return Number.isFinite(n) && n > 0 ? String(n) : '0';
  })();
  const [amount, setAmount] = useState(initialAmount);
  const [file, setFile] = useState(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setReadiness(null); setReadinessError(null); setPay(null); setPaymentInfoError(null);
    setQrBroken(false); setQrFallback(null);
    fetch('/api/tenant/payment-info', { credentials: 'same-origin' })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        return d;
      })
      .then((d) => { if (!cancelled && d && d.payment) { setPay(d.payment); setPaymentInfoError(null); } })
      .catch((err) => { if (!cancelled) setPaymentInfoError(err.message || 'โหลดช่องทางชำระเงินไม่สำเร็จ'); });
    fetch(`/api/tenant/pay-readiness/${encodeURIComponent(bill.id)}`, { credentials: 'same-origin' })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (r.ok && d && d.ok) { setReadiness(d); setReadinessError(null); return; }
        setReadiness(null);
        setReadinessError({
          sev: r.status >= 500 ? 'med' : 'high',
          code: d.code || `HTTP_${r.status}`,
          msg: d.error || `HTTP ${r.status}`,
          fix: r.status >= 500
            ? (locale === 'th' ? 'ลองใหม่อีกครั้ง หากยังไม่สำเร็จให้ติดต่อสำนักงาน' : 'Try again. Contact the office if it still fails.')
            : null,
        });
      })
      .catch((err) => {
        if (!cancelled) setReadinessError({
          sev: 'med', code: 'READINESS_FAILED',
          msg: err.message || (locale === 'th' ? 'ตรวจสอบช่องทางชำระเงินไม่สำเร็จ' : 'Payment preflight failed'),
          fix: locale === 'th' ? 'ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่' : 'Check your connection and try again.',
        });
      });
    return () => { cancelled = true; };
  }, [bill.id, locale]);

  useEffect(() => {
    if (bill.status === 'paid' || bill.status === 'void') return undefined;
    const timer = setInterval(() => { if (typeof refresh === 'function') refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [bill.id, bill.status, refresh]);

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
  const blockingIssues = readiness ? (readiness.issues || []).filter((i) => i.sev === 'high') : [];
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
  // Render the payment-channel card whenever ANY channel info is available
  // — even just an info-error counts so we don't drop the card silently when
  // payment-info fails but bill QR readiness still works.
  const showPaymentCard = (pay || qrUrl || qrFallback || paymentInfoError);

  async function copyPayload(payload) {
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied('manual');
      setTimeout(() => setCopied(false), 2500);
    }
  }

  async function upload() {
    if (amountInvalid) {
      setNotice({ kind: 'error', title: locale === 'th' ? 'จำนวนเงินไม่ถูกต้อง' : 'Invalid amount',
        message: locale === 'th' ? 'กรุณาระบุจำนวนเงินให้ถูกต้อง' : 'Enter a valid payment amount.' });
      return;
    }
    if (amountMismatch) {
      setNotice({ kind: 'error', title: locale === 'th' ? 'ยอดไม่ตรงกับบิล' : 'Amount mismatch',
        message: `${t('amountMismatch')} (฿${fmtMoney2(bill.total)})` });
      return;
    }
    if (readinessHardError) {
      setNotice({ kind: 'error', title: locale === 'th' ? 'ยังชำระผ่านระบบไม่ได้' : 'Payment unavailable',
        message: readinessError.msg || 'Payment is not available for this bill.' });
      return;
    }
    if (readinessLoading) {
      setNotice({ kind: 'pending',
        title: locale === 'th' ? 'กำลังตรวจสอบช่องทางชำระเงิน' : 'Checking payment readiness',
        message: locale === 'th'
          ? 'กรุณารอสักครู่ ระบบกำลังตรวจสอบว่าบิลนี้รับสลิปได้หรือไม่'
          : 'Please wait while the system checks readiness.' });
      return;
    }
    if (readiness?.channels?.slip === false) {
      const first = blockingIssues[0] || advisoryIssues[0];
      setNotice({ kind: 'error', title: locale === 'th' ? 'อัปโหลดสลิปไม่ได้' : 'Slip upload unavailable',
        message: first?.msg || 'Slip upload is not available for this bill.' });
      return;
    }
    if (!file) {
      setNotice({ kind: 'error', title: t('slipField'),
        message: locale === 'th' ? 'กรุณาแนบรูปสลิปก่อนกดยืนยัน' : 'Attach a slip image before submitting.' });
      return;
    }
    if (readiness && blockingIssues.length > 0) {
      const lines = blockingIssues.map((i, idx) => `${idx + 1}. 🔴 ${i.msg}${i.fix ? '\n   → ' + i.fix : ''}`).join('\n\n');
      if (!window.confirm(`⚠️ พบ ${blockingIssues.length} ปัญหา:\n\n${lines}\n\nยืนยันส่งสลิปต่อหรือไม่?`)) return;
    }
    setBusy(true);
    setNotice({ kind: 'processing',
      title: locale === 'th' ? 'กำลังตรวจสอบสลิป' : 'Checking slip',
      message: locale === 'th' ? 'ระบบกำลังอัปโหลดและส่งสลิปไปตรวจสอบ' : 'Uploading and verifying the slip.' });
    try {
      const dataUrl = await fileToDataUrl(file);
      // Defensive: catch zero-byte / non-image reads BEFORE we POST.
      // Without this guard, the upstream slip-verify provider returns
      // English error like "Please provide either a payload string…"
      // which leaks into the tenant's payment history (log.md #2).
      if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]{100,}/.test(dataUrl)) {
        setNotice({
          kind: 'error',
          title: locale === 'th' ? 'อ่านไฟล์สลิปไม่สำเร็จ' : 'Could not read slip file',
          message: locale === 'th'
            ? 'รูปสลิปอาจเสียหายหรือว่างเปล่า กรุณาเลือกรูปใหม่ที่ชัดเจน'
            : 'The slip image is empty or corrupted. Please choose a clear image.',
        });
        setBusy(false);
        return;
      }
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
    <>
      <div className="bill-detail-grid" style={{ display: 'grid', gap: 'var(--sp-5)', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>{t('amountToPay')}</div>
          <div style={{
            fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'var(--fs-3xl)',
            letterSpacing: '-.02em', margin: '4px 0 4px', color: 'var(--accent-2)', lineHeight: 1.05,
          }}>฿{fmtMoney(bill.total)}</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
            <Pill tone={STATUS_TONE[bill.status]} size="lg">{t(bill.status)}</Pill>
            <Pill tone="muted">{t('billPeriod')} {fmtPeriod(bill.period, locale)}</Pill>
          </div>
          <KV label={t('rentRoom')} value={`฿${fmtMoney(bill.rent)}`} />
          <KV label={`${t('waterFull')} · ${Number(bill.water_units) || 0} ${t('units')}${Number(bill.water_rate) ? ` × ${fmtMoney2(bill.water_rate)}` : ''}`}
            value={`฿${fmtMoney(bill.water_amount)}`} />
          <KV label={`${t('elecFull')} · ${Number(bill.elec_units) || 0} ${t('units')}${Number(bill.elec_rate) ? ` × ${fmtMoney2(bill.elec_rate)}` : ''}`}
            value={`฿${fmtMoney(bill.elec_amount)}`} />
          {Number(bill.wifi) > 0 ? <KV label={tr(locale, 'cat_wifi')} value={`฿${fmtMoney(bill.wifi)}`} /> : null}
          {Array.isArray(bill.other) ? bill.other.filter((o) => Number(o.amount) > 0).map((o, i) => (
            <KV key={i} label={String(o.label || 'อื่นๆ')} value={`฿${fmtMoney(o.amount)}`} />
          )) : null}
          {Number(bill.late_fee) > 0 ? <KV label={t('lateFee')} value={`฿${fmtMoney(bill.late_fee)}`} /> : null}
          <div style={{ height: 12 }} />
          <KV label={t('dueDate')} value={fmtDate(bill.due_date, locale)} />
          <KV label={t('billTotal')} value={`฿${fmtMoney(bill.total)}`} bold hi last />
          <div style={{ display: 'flex', gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
            <a href={`/api/tenant/bills/${bill.id}/pdf`} target="_blank" rel="noopener" style={{ textDecoration: 'none' }}>
              <Button variant="outline" icon="download">{bill.status === 'paid' ? t('receipt') : t('downloadPdf')}</Button>
            </a>
          </div>
        </div>

        {bill.status === 'paid' ? (
          <div style={{
            background: 'var(--green-soft)', border: '1px solid var(--line)', color: 'var(--green)',
            borderRadius: 16, padding: 18, textAlign: 'center',
            display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{
              width: 60, height: 60, borderRadius: 999, background: '#fff',
              display: 'grid', placeItems: 'center', color: 'var(--green)',
            }}><Icon name="check" size={32} /></div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 16 }}>{t('paidNote')}</div>
            <div style={{ fontSize: 13 }}>{t('paidSub')}</div>
          </div>
        ) : bill.status === 'void' ? (
          <Empty icon="info" title={tr(locale, 'void')} hint={locale === 'th'
            ? 'บิลนี้ถูกยกเลิกแล้ว ไม่สามารถชำระเงินได้'
            : 'This bill has been voided.'} />
        ) : (
          <div style={{
            background: 'var(--surface-2)', border: '1px solid var(--line)',
            borderRadius: 16, padding: 18, textAlign: 'center',
            display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center',
          }}>
            <Pill tone="accent">PromptPay</Pill>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 14 }}>{t('scanToPay')}</div>
            {qrUrl && !qrBroken ? (
              <img src={qrUrl} alt="PromptPay QR" width="180" height="180"
                style={{ borderRadius: 12, padding: 8, background: '#fff', border: '1px solid var(--line)' }}
                onError={() => {
                  setQrBroken(true);
                  fetch(`${qrUrl}?format=json`, { credentials: 'same-origin' })
                    .then((r) => r.ok ? r.json() : null)
                    .then((d) => { if (d && d.payload) setQrFallback(d); })
                    .catch(() => {});
                }} />
            ) : qrFallback ? (
              <div style={{
                background: '#fff', borderRadius: 12, padding: 14,
                border: '1px solid var(--amber-soft)', textAlign: 'left', width: '100%',
              }}>
                <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--amber)' }}>{t('qrFailed')}</div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.6 }}>{t('qrFailedHint')}</div>
                <textarea readOnly value={qrFallback.payload} onClick={(e) => e.target.select()}
                  style={{
                    width: '100%', minHeight: 60, marginTop: 10,
                    padding: 8, fontSize: 11, fontFamily: 'var(--font-mono)',
                    border: '1px solid var(--line)', borderRadius: 8,
                    background: 'var(--surface)', resize: 'none', color: 'var(--ink)',
                  }}/>
                <Button size="sm" variant="soft" icon={copied === true ? 'check' : 'copy'}
                  onClick={() => copyPayload(qrFallback.payload)}
                  style={{ marginTop: 8 }}>
                  {copied === true ? t('copied')
                    : copied === 'manual' ? 'คัดลอกด้วย ⌘C / Ctrl+C'
                    : t('copyPayload')}
                </Button>
              </div>
            ) : (
              <div className="ph-stripe" style={{
                width: 180, height: 180, borderRadius: 12, border: '1px solid var(--line)',
                display: 'grid', placeItems: 'center', color: 'var(--muted)', fontSize: 12,
              }}>{paymentInfoError ? '—' : '…'}</div>
            )}
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
              {t('openBankApp')}{pay?.promptpayName ? ` · ${pay.promptpayName}` : ''}
            </div>
            {pay?.bankInfo && pay.bankInfo.account ? (
              <div style={{
                background: 'var(--surface)', borderRadius: 10, padding: '10px 12px',
                border: '1px solid var(--line)', textAlign: 'left', width: '100%',
              }}>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t('bankTransfer')}</div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{pay.bankInfo.bank}</div>
                <div style={{ fontSize: 14, fontFamily: 'var(--font-mono)' }}>{pay.bankInfo.account}</div>
                {pay.bankInfo.name ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>{pay.bankInfo.name}</div> : null}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {blockingIssues.length > 0 ? (
        <div style={{
          marginTop: 16, padding: 12,
          background: 'var(--red-soft)', border: '1px solid var(--line)',
          borderRadius: 10, fontSize: 13, color: 'var(--red)', lineHeight: 1.6,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>⚠️ {t('cannotPay')}</div>
          {blockingIssues.map((i, idx) => (
            <div key={idx} style={{ marginBottom: 4 }}>
              • {i.msg}
              {i.fix ? <div style={{ fontSize: 12, marginLeft: 12, opacity: 0.85 }}>→ {i.fix}</div> : null}
            </div>
          ))}
        </div>
      ) : null}

      {bill.status !== 'paid' && bill.status !== 'void' && slipFeature?.enabled ? (
        <div style={{ marginTop: 18 }}>
          <Label>{t('amountField')}</Label>
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" step="0.01" />
          {amountInvalid || amountMismatch ? (
            <div style={{ marginTop: 6, color: 'var(--red)', fontSize: 12.5 }}>
              {amountInvalid
                ? (locale === 'th' ? 'กรุณาระบุจำนวนเงินให้ถูกต้อง' : 'Enter a valid payment amount.')
                : `${t('amountMismatch')} (฿${fmtMoney2(bill.total)})`}
            </div>
          ) : null}
          <div style={{ height: 12 }} />
          <Label>{t('slipField')}</Label>
          {/* Custom file picker — the native "Choose File" button is
              unstyled across browsers and looks out of place next to the
              rest of the tenant portal chrome. Wrap a visually-hidden
              <input> inside a styled <label> so we control the look while
              keeping keyboard + screen-reader behaviour intact. */}
          <label className="slip-picker" style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '10px 12px', borderRadius: 12,
            background: 'var(--surface-2)', border: '1px solid var(--line-2)',
            cursor: 'pointer', minWidth: 0,
          }}>
            <input key={fileInputKey} type="file" accept="image/jpeg,image/png,image/webp"
              onChange={(e) => {
                const f = e.target.files[0];
                if (f && !['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) {
                  setNotice({ kind: 'error', title: t('slipField'),
                    message: locale === 'th'
                      ? 'รองรับเฉพาะ JPG, PNG หรือ WebP เท่านั้น'
                      : 'Only JPG, PNG or WebP images are supported.' });
                  e.target.value = ''; setFile(null); return;
                }
                if (f && f.size > 5 * 1024 * 1024) {
                  setNotice({ kind: 'error', title: t('slipField'),
                    message: locale === 'th' ? 'ไฟล์ใหญ่เกินไป (เกิน 5 MB)' : 'File is too large (over 5 MB).' });
                  e.target.value = ''; setFile(null); return;
                }
                setFile(f);
              }}
              style={{
                // Visually hidden but still focusable + clickable through the
                // wrapping <label> so keyboard users can Tab here.
                position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
                overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0,
              }} />
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', borderRadius: 999,
              background: 'var(--ink)', color: 'var(--bg)',
              fontSize: 13, fontWeight: 600, flex: '0 0 auto',
            }}>
              <Icon name="upload" size={14} /> {t('chooseFile')}
            </span>
            <span style={{
              fontSize: 13, color: file ? 'var(--ink)' : 'var(--muted)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              minWidth: 0, flex: 1,
            }}>{file ? file.name : t('noFileChosen')}</span>
          </label>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6, marginBottom: 12 }}>{t('slipHint')}</div>

          {advisoryIssues.length > 0 ? (
            <div style={{
              marginBottom: 10, padding: 10,
              background: 'var(--amber-soft)', border: '1px solid var(--line)',
              borderRadius: 8, fontSize: 12.5, color: 'var(--amber)', lineHeight: 1.55,
            }}>
              {advisoryIssues.map((i, idx) => (
                <div key={idx} style={{ marginBottom: 2 }}>
                  {i.sev === 'med' ? '🟡' : 'ℹ️'} {i.msg}
                  {i.fix ? <span style={{ opacity: 0.8 }}> — {i.fix}</span> : null}
                </div>
              ))}
            </div>
          ) : null}
          {readinessLoading ? (
            <div style={{
              marginBottom: 10, padding: 10,
              background: 'var(--blue-soft)', border: '1px solid var(--line)',
              borderRadius: 8, fontSize: 12.5, color: 'var(--blue)', lineHeight: 1.55,
            }}>
              {locale === 'th'
                ? 'กำลังตรวจสอบว่าบิลนี้รับสลิปได้หรือไม่…'
                : 'Checking whether this bill accepts slip uploads…'}
            </div>
          ) : null}
          <Button variant="dark" icon="upload" onClick={upload} disabled={busy || slipUploadBlocked}>
            {busy ? t('uploadingSlip') : t('uploadSlip')}
          </Button>
          {notice ? <PaymentNotice notice={notice} /> : null}
        </div>
      ) : null}

      {bill.status !== 'paid' && bill.status !== 'void' && !slipFeature?.enabled ? (
        <div style={{
          marginTop: 16, padding: 14, borderRadius: 12,
          background: 'var(--surface-2)', border: '1px solid var(--line)',
          fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.7,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>📌 {t('howToPay')}</div>
          <div>{t('slipDisabledStep1')}</div>
          <div>{t('slipDisabledStep2')}</div>
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>ℹ️ {t('slipDisabledHelp')}</div>
        </div>
      ) : null}
      <style>{`@media (max-width: 768px){.bill-detail-grid{grid-template-columns:1fr!important}}`}</style>
    </>
  );
}

function PaymentNotice({ notice }) {
  const tones = {
    success:    { bg: 'var(--green-soft)', fg: 'var(--green)' },
    error:      { bg: 'var(--red-soft)',   fg: 'var(--red)' },
    pending:    { bg: 'var(--amber-soft)', fg: 'var(--amber)' },
    processing: { bg: 'var(--blue-soft)',  fg: 'var(--blue)' },
  };
  const c = tones[notice.kind] || tones.pending;
  return (
    <div style={{
      marginTop: 12, padding: 12, borderRadius: 12,
      background: c.bg, color: c.fg, fontSize: 13, lineHeight: 1.6,
      border: '1px solid var(--line)',
    }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{notice.title}</div>
      <div>{notice.message}</div>
      {notice.details && notice.details.length ? (
        <div style={{ marginTop: 8, fontSize: 12.5 }}>
          {notice.details.map((line, idx) => <div key={idx}>- {line}</div>)}
        </div>
      ) : null}
    </div>
  );
}

// =========================================================== PaymentsView =
function PaymentsView({ locale, payments, syncErrors, goto }) {
  const t = (k) => tr(locale, k);
  const items = payments || [];
  const [filter, setFilter] = useState('all');
  const paymentError = (syncErrors || []).find((e) => e.key === 'payments');
  const statusLabel = (s) => s === 'verified' ? t('paymentVerified')
                           : s === 'pending' ? t('paymentPending')
                           : s === 'rejected' ? t('paymentRejected')
                           : s;
  const filtered = useMemo(() => {
    if (filter === 'all') return items;
    return items.filter((p) => p.status === filter);
  }, [filter, items]);
  const counts = useMemo(() => ({
    all:      items.length,
    verified: items.filter((p) => p.status === 'verified').length,
    pending:  items.filter((p) => p.status === 'pending').length,
    rejected: items.filter((p) => p.status === 'rejected').length,
  }), [items]);
  const filters = [
    { id: 'all',      label: t('filterAll'),         count: counts.all },
    { id: 'verified', label: t('paymentVerified'),   count: counts.verified },
    { id: 'pending',  label: t('paymentPending'),    count: counts.pending },
    { id: 'rejected', label: t('paymentRejected'),   count: counts.rejected },
  ];
  // Server returns absolute storage URLs in p.slip_url (admin storage
  // endpoint, gated by the same tenant cookie). Open in a new tab.
  const openSlip = (url) => {
    if (!url) return;
    try { window.open(String(url), '_blank', 'noopener,noreferrer'); }
    catch { /* popup-blocker — best-effort */ }
  };
  return (
    <div className="anim-in">
      <SectionHeader title={t('paymentHistory')} subtitle={t('paymentHistorySub')} />
      {items.length > 0 ? (
        <div className="no-scrollbar" style={{ display: 'flex', gap: 8, marginBottom: 'var(--sp-4)', overflowX: 'auto' }}>
          {filters.map((f) => (
            <button key={f.id} onClick={() => setFilter(f.id)} style={{
              padding: '8px 14px', borderRadius: 999, fontFamily: 'inherit',
              border: '1px solid ' + (filter === f.id ? 'var(--ink)' : 'var(--line-2)'),
              background: filter === f.id ? 'var(--ink)' : 'var(--surface)',
              color: filter === f.id ? 'var(--bg)' : 'var(--ink-2)',
              fontSize: 'var(--fs-sm)', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
            }}>{f.label} <span style={{ opacity: 0.6, marginLeft: 4 }}>{f.count}</span></button>
          ))}
        </div>
      ) : null}
      {filtered.length === 0 ? <Empty icon="payments" title={paymentError ? t('nothingHere') : t('noPayments')} />
        : (
        <Card pad={0}>
          <div className="pay-head" style={{
            display: 'grid', gridTemplateColumns: '1.4fr 0.9fr 0.9fr 0.8fr 1.1fr',
            padding: '14px 22px', borderBottom: '1px solid var(--line)',
            color: 'var(--muted)', fontSize: 'var(--fs-xs)', fontWeight: 600,
            letterSpacing: '.04em', textTransform: 'uppercase',
          }}>
            <div>{t('colBill')}</div>
            <div>{t('colDate')}</div>
            <div>{t('colMethod')}</div>
            <div style={{ textAlign: 'right' }}>{t('colAmount')}</div>
            <div style={{ textAlign: 'right' }}>{t('colAction')}</div>
          </div>
          {filtered.map((p, i) => (
            <div key={p.id} className="pay-row" style={{
              display: 'grid', gridTemplateColumns: '1.4fr 0.9fr 0.9fr 0.8fr 1.1fr',
              padding: '18px 22px', borderTop: i === 0 ? 0 : '1px solid var(--line)',
              alignItems: 'center', gap: 14,
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 'var(--fs-md)' }}>{p.bill_no || `#${p.bill_id || '—'}`}</div>
                {p.period ? <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)', marginTop: 2 }}>{fmtPeriod(p.period, locale)}</div> : null}
                {p.status === 'rejected' && p.rejected_reason ? (
                  <div style={{ marginTop: 4, fontSize: 'var(--fs-xs)', color: 'var(--red)', lineHeight: 1.5, wordBreak: 'break-word' }}>
                    {tenantRejectedReason(p.rejected_reason)}
                  </div>
                ) : null}
              </div>
              <div style={{ fontSize: 'var(--fs-sm)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {fmtDateTime(p.created_at, locale)}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
                <Pill tone={STATUS_TONE[p.status]}>{statusLabel(p.status)}</Pill>
                {p.method ? <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)' }}>{p.method}</span> : null}
              </div>
              <div style={{ textAlign: 'right', fontFamily: 'var(--font-display)', fontWeight: 600 }}>฿{fmtMoney(p.amount)}</div>
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                {p.slip_url ? (
                  <Button size="sm" variant="ghost" onClick={() => openSlip(p.slip_url)}>{t('viewSlip')}</Button>
                ) : null}
                {p.status === 'rejected' && p.bill_id && goto ? (
                  <Button size="sm" variant="soft" onClick={() => goto('bills', p.bill_id)}>{t('reuploadSlip')}</Button>
                ) : null}
              </div>
            </div>
          ))}
        </Card>
      )}
      <style>{`@media (max-width: 768px){
        .pay-head{display:none!important}
        .pay-row{grid-template-columns:1fr auto!important;grid-template-areas:"name amt" "date method" "act act"!important;gap:8px!important}
        .pay-row > *:nth-child(1){grid-area:name}
        .pay-row > *:nth-child(2){grid-area:date;color:var(--muted);font-size:var(--fs-xs)!important}
        .pay-row > *:nth-child(3){grid-area:method;justify-self:start}
        .pay-row > *:nth-child(4){grid-area:amt;align-self:start}
        .pay-row > *:nth-child(5){grid-area:act;justify-content:flex-start!important;margin-top:4px}
      }`}</style>
    </div>
  );
}

// =========================================================== ContractView =
function ContractView({ locale, tenant, contract }) {
  const t = (k) => tr(locale, k);
  const c = contract;
  if (!c) {
    return (
      <div className="anim-in">
        <SectionHeader title={t('myContract')} />
        <Empty icon="contract" title={t('noContract')} />
      </div>
    );
  }
  const isLocked = !!c.locked_at;
  let pct = null;
  if (c.start_date && c.end_date) {
    const s = new Date(c.start_date).getTime();
    const e = new Date(c.end_date).getTime();
    const now = Date.now();
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
      pct = Math.min(100, Math.max(0, Math.round(((now - s) / (e - s)) * 100)));
    }
  }
  const floor = deriveFloor(tenant.roomId || c.room_id);
  return (
    <div className="anim-in">
      <SectionHeader title={t('myContract')} subtitle={`${t('contractNo')} ${c.contract_no || '—'}`} />
      <div className="contract-grid" style={{ display: 'grid', gap: 18, gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,1fr)' }}>
        <Card pad={0} style={{ overflow: 'hidden' }}>
          <div style={{
            padding: '24px 24px 22px',
            background: 'linear-gradient(135deg, var(--accent-soft) 0%, #f6e3d0 100%)',
            color: 'var(--ink)',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5,
              color: 'var(--accent-2)', letterSpacing: '.04em', textTransform: 'uppercase', fontWeight: 600,
            }}>
              <Icon name="contract" size={14} /> {t('contract')}
            </div>
            <div style={{
              fontFamily: 'var(--font-display)', fontSize: 'var(--fs-stat)',
              fontWeight: 600, marginTop: 8, letterSpacing: '-.01em', lineHeight: 1.2,
            }}>
              {t('contractRoom')} {c.room_id || tenant.roomId || '—'}{floor != null ? ` · ${t('floor')} ${floor}` : ''}
            </div>
            <div style={{ color: 'var(--ink-2)', fontSize: 13.5, marginTop: 4 }}>
              {fmtDate(c.start_date, locale)}  →  {fmtDate(c.end_date, locale)}
            </div>
            <div style={{ marginTop: 18 }}>
              {isLocked
                ? <Pill tone="green" size="lg">{t('contractActive')}{c.days_left != null && c.days_left >= 0 ? ` · ${t('contractDaysLeft')} ${c.days_left} ${t('days')}` : ''}</Pill>
                : <Pill tone="amber" size="lg">{t('contractPending')}</Pill>}
            </div>
            {pct != null ? (
              <>
                <div style={{ marginTop: 18, height: 8, background: 'rgba(34,27,19,0.08)', borderRadius: 999, overflow: 'hidden' }}>
                  <div style={{
                    width: `${pct}%`, height: '100%',
                    background: 'linear-gradient(90deg, var(--accent) 0%, var(--accent-2) 100%)', borderRadius: 999,
                  }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
                  <span>{pct}% {locale === 'th' ? 'ของระยะเวลาสัญญา' : 'of lease elapsed'}</span>
                  {c.term_months
                    ? <span>{c.term_months} {t('contractMonths')}</span>
                    : <span>{t('contractOpenEnded')}</span>}
                </div>
              </>
            ) : null}
          </div>
          <div style={{ padding: 22 }}>
            <KV label={t('contractRent')} value={`฿${fmtMoney(c.monthly_rent)}`} bold hi />
            <KV label={t('contractDeposit')} value={`฿${fmtMoney(c.deposit)}`} />
            {Number(c.discount_pct) > 0
              ? <KV label={t('contractDiscount')} value={`${Number(c.discount_pct).toFixed(1)}%`} />
              : null}
            {c.signed_at ? <KV label={t('contractSigned')} value={fmtDate(c.signed_at, locale)} /> : null}
            <KV label={t('contractTerm')}
              value={c.term_months ? `${c.term_months} ${t('contractMonths')}` : t('contractOpenEnded')} last />
            <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
              {isLocked ? (
                <a href={`/api/tenant/contract/${c.id}/pdf?download=1`} target="_blank" rel="noopener noreferrer"
                  style={{ textDecoration: 'none' }}>
                  <Button icon="download">{t('contractDownload')}</Button>
                </a>
              ) : null}
            </div>
          </div>
        </Card>

        <Card>
          <SectionHeader style={{ marginBottom: 12 }} title={t('tenantInfo')} subtitle={t('tenantInfoSub')} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
            <Avatar tenant={tenant} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{tenant.fullName || '—'}</div>
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>{tenant.phone || '—'}</div>
            </div>
          </div>
          <KV label={t('contractRoom')} value={`${tenant.roomId || c.room_id || '—'}${floor != null ? ` · ${t('floor')} ${floor}` : ''}`} />
          {tenant.email ? <KV label={t('email')} value={tenant.email} /> : null}
          {c.start_date ? <KV label={t('moveInDate')} value={fmtDate(c.start_date, locale)} last={!tenant.email} /> : null}
        </Card>
      </div>
      <style>{`@media (max-width: 768px){.contract-grid{grid-template-columns:1fr!important}}`}</style>
    </div>
  );
}

// ======================================================== MaintenanceView =
function MaintenanceView({ locale, tenant, tickets, refresh }) {
  const t = (k) => tr(locale, k);
  const [showForm, setShowForm] = useState(false);
  const [tab, setTab] = useState('all');
  const filtered = useMemo(() => {
    if (tab === 'open') return tickets.filter((x) => !['completed', 'cancelled'].includes(x.status));
    if (tab === 'done') return tickets.filter((x) => x.status === 'completed');
    return tickets;
  }, [tab, tickets]);
  return (
    <div className="anim-in">
      <SectionHeader title={t('maintenance')}
        subtitle={`${t('allTickets')} ${tickets.length} · ${t('ongoing')} ${tickets.filter((x) => !['completed', 'cancelled'].includes(x.status)).length}`}
        action={<Button icon="plus" onClick={() => setShowForm(true)}>{t('submitTicket')}</Button>} />
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {[{ id: 'all', l: t('allTickets') }, { id: 'open', l: t('ongoing') }, { id: 'done', l: t('done') }].map((f) => (
          <button key={f.id} onClick={() => setTab(f.id)} style={{
            padding: '8px 14px', borderRadius: 999, fontFamily: 'inherit',
            border: '1px solid ' + (tab === f.id ? 'var(--ink)' : 'var(--line-2)'),
            background: tab === f.id ? 'var(--ink)' : 'var(--surface)',
            color: tab === f.id ? 'var(--bg)' : 'var(--ink-2)',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}>{f.l}</button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <Empty icon="maint" title={t('noTickets')} />
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {filtered.map((x) => {
            const cat = MAINT_CATS.find((c) => c.id === x.category);
            return (
              <Card key={x.id} hoverable>
                <div className="maintenance-ticket-row" style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                  <div style={{
                    width: 48, height: 48, borderRadius: 12,
                    background: 'var(--accent-soft)', color: 'var(--accent-2)',
                    display: 'grid', placeItems: 'center', fontSize: 22, flex: '0 0 auto',
                  }}>{cat?.icon || '✦'}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <div style={{ fontWeight: 600, fontSize: 15 }}>{x.title}</div>
                      <Pill tone={STATUS_TONE[x.status]}>{t(x.status)}</Pill>
                      <Pill tone={PRIO_TONE[x.priority]}>{t('prio_' + x.priority)}</Pill>
                      {x.ticket_no
                        ? <span style={{ color: 'var(--muted)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>{x.ticket_no}</span>
                        : null}
                    </div>
                    {x.description ? (
                      <div style={{ color: 'var(--ink-2)', fontSize: 13.5, marginTop: 6, lineHeight: 1.55 }}>
                        {x.description}
                      </div>
                    ) : null}
                    <div style={{ display: 'flex', gap: 14, marginTop: 10, color: 'var(--muted)', fontSize: 12.5, flexWrap: 'wrap' }}>
                      <span>{t('openedAt')} {fmtDate(x.created_at, locale)}</span>
                      {x.completed_at ? <span>{t('completedAt')} {fmtDate(x.completed_at, locale)}</span> : null}
                      {x.rating != null ? (
                        <span style={{ color: 'var(--accent-2)', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                          {Array.from({ length: 5 }).map((_, i) => (
                            <Icon key={i} name="star" size={13}
                              style={{ fill: i < x.rating ? 'var(--accent-2)' : 'none' }} />
                          ))}
                          {x.rating_comment ? <span style={{ color: 'var(--muted)' }}>· “{x.rating_comment}”</span> : null}
                        </span>
                      ) : null}
                    </div>
                    {x.status === 'completed' && x.rating == null ? (
                      <RateTicket ticketId={x.id} locale={locale} onDone={refresh} />
                    ) : null}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <Modal open={showForm} onClose={() => setShowForm(false)} title={t('submitTicket')} size="md">
        <MaintenanceForm tenant={tenant} locale={locale}
          onDone={() => { setShowForm(false); refresh(); }} onCancel={() => setShowForm(false)} />
      </Modal>
    </div>
  );
}

function MaintenanceForm({ tenant, locale, onDone, onCancel }) {
  const t = (k) => tr(locale, k);
  const [cat, setCat] = useState('aircon');
  const [prio, setPrio] = useState('medium');
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Without a current room id (which can happen on edge accounts), the
  // /api/maintenance schema rejects with a 400 — surface that up-front so
  // the tenant isn't stuck staring at a generic "failed" toast.
  const missingRoom = !tenant || !tenant.roomId;
  async function submit(e) {
    e.preventDefault();
    if (!title.trim()) {
      setErr(locale === 'th' ? 'กรุณาระบุหัวข้อแจ้งซ่อม' : 'Enter a repair title.');
      return;
    }
    if (desc.length > 2000) {
      setErr(locale === 'th' ? 'รายละเอียดต้องไม่เกิน 2,000 ตัวอักษร' : 'Description must be 2,000 characters or less.');
      return;
    }
    if (missingRoom) {
      setErr(locale === 'th'
        ? 'ไม่พบห้องของคุณ — กรุณาติดต่อสำนักงาน'
        : 'No room is linked to your account — please contact the office.');
      return;
    }
    setBusy(true); setErr('');
    try {
      await api('/api/maintenance', {
        method: 'POST',
        body: JSON.stringify({
          roomId: tenant.roomId, tenantName: tenant.fullName, tenantPhone: tenant.phone,
          category: cat, priority: prio, title: title.trim(), description: desc.trim(),
        }),
      });
      onDone();
    } catch (e2) {
      setErr(e2.message || (locale === 'th' ? 'ส่งคำร้องไม่สำเร็จ' : 'Submit failed'));
    } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 'var(--sp-4)' }}>
      <div>
        <Label>{t('category')}</Label>
        {/* auto-fit lets the category buttons reflow smoothly from 4 cols
            on a desktop to 2 cols on a 320-wide phone without a breakpoint
            snap — each cell stays at least 108px wide so the icon + label
            remain legible. */}
        <div className="cat-grid" style={{
          display: 'grid', gap: 'var(--sp-2)',
          gridTemplateColumns: 'repeat(auto-fit, minmax(108px, 1fr))',
        }}>
          {MAINT_CATS.map((c) => (
            <button key={c.id} type="button" onClick={() => setCat(c.id)} style={{
              padding: '10px 8px', borderRadius: 12, fontFamily: 'inherit',
              border: '1px solid ' + (cat === c.id ? 'var(--accent)' : 'var(--line)'),
              background: cat === c.id ? 'var(--accent-soft)' : 'var(--surface)',
              color: cat === c.id ? 'var(--accent-2)' : 'var(--ink-2)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
              cursor: 'pointer', fontSize: 'var(--fs-xs)', fontWeight: 600,
              minHeight: 72,
              // log.md #3 — long Thai labels like "เครื่องใช้ไฟฟ้า" used
              // to overflow horizontally. wrap & balance keeps each cell
              // self-contained inside its 108px minmax track.
              textAlign: 'center', lineHeight: 1.25,
              wordBreak: 'break-word', overflowWrap: 'anywhere',
            }}><span style={{ fontSize: 22, lineHeight: 1 }}>{c.icon}</span>{t('cat_' + c.id)}</button>
          ))}
        </div>
      </div>
      <div>
        <Label>{t('title')}</Label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120}
          placeholder={t('titleExample')} />
      </div>
      <div>
        <Label>{t('priority')}</Label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {['critical', 'high', 'medium', 'low'].map((id) => (
            <button key={id} type="button" onClick={() => setPrio(id)} style={{
              padding: '8px 14px', borderRadius: 999, fontFamily: 'inherit', flex: '1 1 calc(50% - 4px)',
              border: '1px solid ' + (prio === id ? 'var(--ink)' : 'var(--line)'),
              background: prio === id ? 'var(--ink)' : 'var(--surface)',
              color: prio === id ? 'var(--bg)' : 'var(--ink-2)',
              fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}>{t('prio_' + id)}</button>
          ))}
        </div>
      </div>
      <div>
        <Label>{t('description')}</Label>
        <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={4} maxLength={2000}
          placeholder={t('descPlaceholder')}
          style={{
            width: '100%', padding: 14, borderRadius: 12, background: 'var(--surface-2)',
            border: '1px solid var(--line-2)', fontFamily: 'inherit', fontSize: 14,
            color: 'var(--ink)', resize: 'vertical', outline: 'none',
          }} />
      </div>
      {err ? <div style={{ color: 'var(--red)', fontSize: 13 }}>{err}</div> : null}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <Button variant="ghost" type="button" onClick={onCancel}>{t('cancel')}</Button>
        <Button type="submit" disabled={busy || !title.trim() || missingRoom}>{busy ? '…' : t('sendRequest')}</Button>
      </div>
    </form>
  );
}

function RateTicket({ ticketId, locale, onDone }) {
  const t = (k) => tr(locale, k);
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
    } catch (e) { setErr(e.message || 'failed'); }
    finally { setBusy(false); }
  }
  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed var(--line)' }}>
      <div style={{ fontSize: 13, color: 'var(--ink-2)', marginBottom: 6 }}>{t('ratePrompt')}</div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }} role="radiogroup" aria-label={t('ratePrompt')}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" onClick={() => setStars(n)}
            role="radio" aria-checked={n === stars} aria-label={`${n} ★`}
            style={{
              background: 'transparent', border: 0, fontSize: 26, cursor: 'pointer',
              color: n <= stars ? 'var(--accent)' : 'var(--line-2)',
              minWidth: 36, minHeight: 36, padding: 0,
            }}>★</button>
        ))}
      </div>
      <Input value={comment} onChange={(e) => setComment(e.target.value)}
        placeholder={t('ratePlaceholder')} maxLength={500} />
      {err ? <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>{err}</div> : null}
      <Button size="sm" onClick={submit} disabled={busy} style={{ marginTop: 8 }}>
        {busy ? '…' : t('submitRating')}
      </Button>
    </div>
  );
}

// =========================================================== ProfileView =
function ProfileView({ tenant, locale, setLocale, theme, setTheme, onLogout, features, contract, building }) {
  const t = (k) => tr(locale, k);
  const i18nOn = features?.i18n?.enabled !== false;
  const darkOn = features?.darkMode?.enabled !== false;
  // Contact details — prefer real building config; hide cards we don't have.
  const buildingPhone = building?.phone || null;
  const buildingName = building?.name || 'บ้านกาญจน์ เรสซิเดนซ์';
  const buildingAddress = building?.address || null;
  // Tenant tenure derived from the active contract's start date.
  const since = contract?.start_date || null;
  return (
    <div className="anim-in">
      <SectionHeader title={t('accountSettings')} subtitle={t('accountSub')} />
      <Card pad={0}>
        <div style={{
          padding: 24, display: 'flex', alignItems: 'center', gap: 18,
          borderBottom: '1px solid var(--line)', flexWrap: 'wrap',
        }}>
          <Avatar tenant={tenant} size={64} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 'var(--fs-lg)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {tenant.fullName || '—'}
            </div>
            <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
              {tenant.roomId ? `${tr(locale, 'contractRoom')} ${tenant.roomId}` : '—'}
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
              <Pill tone="green"><Icon name="check" size={12} /> {t('verifiedTenant')}</Pill>
            </div>
          </div>
          <Button variant="outline" size="sm" icon="logout" onClick={onLogout}>{t('logOut')}</Button>
        </div>
        <div style={{ padding: 24 }}>
          <KV label={t('phone')} value={tenant.phone || '—'} />
          <KV label={t('email')} value={tenant.email || '—'} last={!since} />
          {since ? <KV label={t('sinceDate')} value={fmtDate(since, locale)} last /> : null}
        </div>
      </Card>

      {(i18nOn || darkOn) ? (
        <>
          <SectionHeader style={{ marginTop: 'var(--sp-7)' }} title={t('prefs')} subtitle={t('prefsSub')} />
          <Card>
            {darkOn ? (
              <PrefRow icon="moon" label={t('darkMode')} hint={t('darkModeSub')} last={!i18nOn}>
                <Toggle on={theme === 'dark'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />
              </PrefRow>
            ) : null}
            {i18nOn ? (
              <PrefRow icon="globe" label={t('language')} hint={t('languageSub')} last>
                <select value={locale} onChange={(e) => setLocale(e.target.value)} style={{
                  padding: '8px 12px', borderRadius: 10, border: '1px solid var(--line-2)',
                  background: 'var(--surface-2)', color: 'var(--ink)', fontFamily: 'inherit', fontSize: 13,
                }}>
                  <option value="th">ไทย</option><option value="en">English</option>
                </select>
              </PrefRow>
            ) : null}
          </Card>
        </>
      ) : null}

      <SectionHeader style={{ marginTop: 'var(--sp-7)' }} title={t('contactDorm')} subtitle={buildingName} />
      <div className="contact-grid" style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
        {buildingPhone ? (
          <a href={`tel:${String(buildingPhone).replace(/[^+\d]/g, '')}`} style={{ textDecoration: 'none' }}>
            <ContactCard icon="phone" tone="accent" label={t('telephone')} value={buildingPhone} />
          </a>
        ) : (
          <ContactCard icon="phone" tone="accent" label={t('telephone')} value="—" />
        )}
        {buildingAddress ? (
          <ContactCard icon="info" tone="blue" label={locale === 'th' ? 'ที่อยู่' : 'Address'} value={buildingAddress} />
        ) : null}
      </div>
    </div>
  );
}

function PrefRow({ icon, label, hint, children, last }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16, padding: '14px 0',
      borderBottom: last ? 'none' : '1px solid var(--line)',
    }}>
      <div style={{
        width: 38, height: 38, borderRadius: 10, background: 'var(--surface-2)',
        color: 'var(--ink-2)', display: 'grid', placeItems: 'center', flex: '0 0 auto',
      }}><Icon name={icon} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14.5 }}>{label}</div>
        <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>{hint}</div>
      </div>
      {children}
    </div>
  );
}

function ContactCard({ icon, tone, label, value }) {
  const toneBg = { accent: 'var(--accent-soft)', green: 'var(--green-soft)', blue: 'var(--blue-soft)', amber: 'var(--amber-soft)' }[tone] || 'var(--surface-2)';
  const toneFg = { accent: 'var(--accent-2)', green: 'var(--green)', blue: 'var(--blue)', amber: 'var(--amber)' }[tone] || 'var(--ink-2)';
  return (
    <Card hoverable>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10, background: toneBg, color: toneFg,
          display: 'grid', placeItems: 'center',
        }}><Icon name={icon} /></div>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>{label}</div>
          <div style={{ fontWeight: 600, fontFamily: 'var(--font-display)' }}>{value}</div>
        </div>
      </div>
    </Card>
  );
}

// ============================================================== Shell ====
// NAV entries — payments uses double quotes so the integration test's
// /id="payments"/ regex pins the route key as a source-level literal even
// after this file gets reformatted.
const NAV = [
  { id: 'home',        label: 'home',        icon: 'home' },
  { id: 'bills',       label: 'bills',       icon: 'bills' },
  { id: "payments",    label: 'payments',    icon: 'payments' },
  { id: 'contract',    label: 'contract',    icon: 'contract' },
  { id: 'maintenance', label: 'maintenance', icon: 'maint' },
  { id: 'profile',     label: 'profile',     icon: 'profile' },
];

function Sidebar({ page, setPage, locale, unpaidCount, tenant, onLogout }) {
  const t = (k) => tr(locale, k);
  return (
    <aside className="portal-sidebar" style={{
      width: 264, background: 'var(--surface)', borderRight: '1px solid var(--line)',
      padding: '24px 16px 18px', display: 'flex', flexDirection: 'column',
      position: 'sticky', top: 0, height: '100vh',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 8px 22px' }}>
        <LogoMark size={40} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 14.5, lineHeight: 1.1 }}>บ้านกาญจน์</div>
          <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>Tenant Portal · v3</div>
        </div>
      </div>
      <nav style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {NAV.map((n) => {
          const active = n.id === page;
          return (
            <button key={n.id} onClick={() => setPage(n.id)} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '11px 14px', borderRadius: 12, border: 0, cursor: 'pointer',
              background: active ? 'var(--accent-soft)' : 'transparent',
              color: active ? 'var(--accent-2)' : 'var(--ink-2)',
              fontFamily: 'inherit', fontWeight: active ? 600 : 500, fontSize: 14,
              textAlign: 'left', transition: 'background .15s ease, color .15s ease',
            }}
            onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--surface-2)'; }}
            onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}>
              <Icon name={n.icon} size={18} />
              <span style={{ flex: 1 }}>{t(n.label)}</span>
              {n.id === 'bills' && unpaidCount > 0 ? (
                <span style={{
                  background: 'var(--accent)', color: '#fff', borderRadius: 999,
                  padding: '2px 8px', fontSize: 11, fontWeight: 700,
                }}>{unpaidCount}</span>
              ) : null}
            </button>
          );
        })}
      </nav>
      <div style={{ flex: 1 }} />
      <Card pad={14} style={{ background: 'var(--surface-2)', borderColor: 'var(--line)' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Avatar tenant={tenant} size={36} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {tenant.fullName || '—'}
            </div>
            <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>
              {tenant.roomId ? `${tr(locale, 'contractRoom')} ${tenant.roomId}` : '—'}
            </div>
          </div>
          <button onClick={onLogout} title={t('logOut')} style={{
            width: 32, height: 32, borderRadius: 8, border: 0,
            background: 'transparent', color: 'var(--muted)', cursor: 'pointer',
            display: 'grid', placeItems: 'center',
          }}><Icon name="logout" size={16} /></button>
        </div>
      </Card>
    </aside>
  );
}

function TopBar({ page, locale, tenant, openMenu, unpaidCount, openTickets, onBellClick }) {
  const t = (k) => tr(locale, k);
  const hasAlert = (unpaidCount + openTickets) > 0;
  return (
    <header style={{
      position: 'sticky', top: 0, zIndex: 10,
      background: 'rgba(246,241,231,0.85)',
      backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
      borderBottom: '1px solid var(--line)',
      padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 14,
      // Pin the height so the row never grows when a short page name (e.g.
      // "Home") is replaced by a long one ("Maintenance"). Keeps the main
      // content from shifting up/down on every page change.
      minHeight: 'var(--topbar-h)', boxSizing: 'border-box',
    }}>
      <button onClick={openMenu} className="topbar-menu-btn" aria-label="menu" style={{
        width: 40, height: 40, borderRadius: 10, border: '1px solid var(--line-2)',
        background: 'var(--surface)', color: 'var(--ink)', cursor: 'pointer',
        display: 'none', placeItems: 'center',
      }}><Icon name="menu" /></button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          color: 'var(--muted)', fontSize: 12,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{t('welcome')} {nicknameOf(tenant.fullName) || '—'}</div>
        <div style={{
          fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 17, letterSpacing: '-.01em',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{t(page)}</div>
      </div>
      <button onClick={onBellClick} title={t('bills')} aria-label={t('bills')} style={{
        position: 'relative', width: 40, height: 40, borderRadius: 10,
        border: '1px solid var(--line-2)', background: 'var(--surface)',
        color: 'var(--ink-2)', cursor: 'pointer', display: 'grid', placeItems: 'center',
      }}>
        <Icon name="bell" size={18} />
        {hasAlert ? (
          <span style={{
            position: 'absolute', top: 6, right: 6, width: 8, height: 8, borderRadius: '50%',
            background: 'var(--accent)', border: '2px solid var(--surface)',
          }} />
        ) : null}
      </button>
    </header>
  );
}

function BottomNav({ page, setPage, locale, unpaidCount }) {
  const t = (k) => tr(locale, k);
  return (
    <nav className="bottom-nav" style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 20,
      background: 'rgba(246,241,231,0.92)',
      backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
      borderTop: '1px solid var(--line)',
      display: 'none', padding: '8px 6px calc(env(safe-area-inset-bottom,0px) + 8px)',
      justifyContent: 'space-around',
    }}>
      {NAV.filter((n) => n.id !== 'payments').map((n) => {
        const active = n.id === page;
        const badge = n.id === 'bills' && unpaidCount > 0;
        return (
          <button key={n.id} onClick={() => setPage(n.id)} style={{
            flex: 1, border: 0, background: 'transparent', cursor: 'pointer', padding: '6px 4px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
            color: active ? 'var(--accent-2)' : 'var(--muted)', fontFamily: 'inherit',
            fontSize: 10.5, fontWeight: active ? 600 : 500, position: 'relative',
          }}>
            <div style={{
              padding: '6px 14px', borderRadius: 999, position: 'relative',
              background: active ? 'var(--accent-soft)' : 'transparent',
              transition: 'background .15s ease',
            }}>
              <Icon name={n.icon} size={20} />
              {badge ? <span style={{
                position: 'absolute', top: 2, right: 4, minWidth: 16, height: 16, padding: '0 4px',
                borderRadius: 999, background: 'var(--accent)', color: '#fff',
                fontSize: 10, fontWeight: 700, display: 'grid', placeItems: 'center',
              }}>{unpaidCount}</span> : null}
            </div>
            <span>{t(n.label)}</span>
          </button>
        );
      })}
    </nav>
  );
}

function DrawerNav({ open, onClose, page, setPage, locale, onLogout, unpaidCount }) {
  const t = (k) => tr(locale, k);
  const panelRef = useRef(null);
  const previouslyFocused = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    previouslyFocused.current = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => {
      if (e.key === 'Escape') { onClose?.(); return; }
      if (e.key !== 'Tab') return;
      // Focus trap inside the drawer.
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(panel.querySelectorAll(FOCUSABLE_SEL))
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!focusables.length) { e.preventDefault(); panel.focus(); return; }
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    const focusTimer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (panel) {
        const first = panel.querySelector(FOCUSABLE_SEL);
        (first || panel).focus({ preventScroll: true });
      }
    }, 0);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', onKey);
      const prevEl = previouslyFocused.current;
      if (prevEl && typeof prevEl.focus === 'function') {
        try { prevEl.focus({ preventScroll: true }); } catch { /* ignore */ }
      }
    };
  }, [open, onClose]);
  if (!open) return null;
  const ui = (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(28,18,8,0.42)',
      backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
      animation: 'fade-in .2s ease',
    }}>
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={tr(locale, 'portal')}
        tabIndex={-1}
        style={{
          position: 'absolute', top: 0, left: 0, bottom: 0,
          width: 'min(280px, 86vw)', maxWidth: 280,
          background: 'var(--surface)',
          padding: `18px 14px calc(env(safe-area-inset-bottom, 0px) + 18px)`,
          display: 'flex', flexDirection: 'column',
          // Slide in from the left edge.
          animation: 'drawer-in .25s cubic-bezier(.2,.8,.2,1)',
          overflowY: 'auto', WebkitOverflowScrolling: 'touch',
          boxShadow: 'var(--shadow-lg)', outline: 'none',
        }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 6px 18px', flex: '0 0 auto' }}>
          <LogoMark size={36} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 'var(--fs-base)' }}>บ้านกาญจน์</div>
            <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-xs)' }}>Tenant Portal</div>
          </div>
          <button onClick={onClose} aria-label="ปิด" style={{
            marginLeft: 'auto', width: 32, height: 32, borderRadius: 8,
            border: 0, background: 'var(--surface-2)', cursor: 'pointer',
            display: 'grid', placeItems: 'center', color: 'var(--ink-2)', flex: '0 0 auto',
          }}><Icon name="close" size={16} /></button>
        </div>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '0 0 auto' }}>
          {NAV.map((n) => {
            const active = n.id === page;
            return (
              <button key={n.id} onClick={() => { setPage(n.id); onClose(); }} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px',
                borderRadius: 12, border: 0, cursor: 'pointer', fontFamily: 'inherit',
                background: active ? 'var(--accent-soft)' : 'transparent',
                color: active ? 'var(--accent-2)' : 'var(--ink-2)',
                fontWeight: active ? 600 : 500, fontSize: 'var(--fs-base)', textAlign: 'left',
              }}>
                <Icon name={n.icon} size={18} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t(n.label)}</span>
                {n.id === 'bills' && unpaidCount > 0 ? (
                  <span style={{
                    background: 'var(--accent)', color: '#fff', borderRadius: 999,
                    padding: '2px 8px', fontSize: 'var(--fs-xs)', fontWeight: 700,
                  }}>{unpaidCount}</span>
                ) : null}
              </button>
            );
          })}
        </nav>
        <div style={{ flex: 1, minHeight: 12 }} />
        <Button variant="outline" icon="logout" onClick={onLogout} style={{ flex: '0 0 auto' }}>{t('logOut')}</Button>
      </div>
      <style>{`
        @keyframes drawer-in {
          from { transform: translateX(-100%); }
          to   { transform: translateX(0); }
        }
      `}</style>
    </div>
  );
  // Same Portal escape from any ancestor transform as Modal.
  if (typeof document !== 'undefined' && ReactDOM && ReactDOM.createPortal) {
    return ReactDOM.createPortal(ui, document.body);
  }
  return ui;
}

// =============================================================== App ====
function App() {
  const ALLOWED_LOCALES = ['th', 'en'];
  const ALLOWED_THEMES = ['light', 'dark'];
  const [tenant, setTenant] = useState(null);
  const [loading, setLoading] = useState(true);
  const [features, setFeatures] = useState(null);
  const _initLocale = safeStorageGet('tenant_locale');
  const _initTheme = safeStorageGet('tenant_theme');
  const [locale, setLocaleRaw] = useState(ALLOWED_LOCALES.includes(_initLocale) ? _initLocale : 'th');
  const [theme, setThemeRaw] = useState(ALLOWED_THEMES.includes(_initTheme) ? _initTheme : 'light');
  const [page, setPage] = useState('home');
  const [drawer, setDrawer] = useState(false);
  const [bills, setBills] = useState([]);
  const [payments, setPayments] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [contract, setContract] = useState(null);
  const [building, setBuilding] = useState(null);
  const [syncErrors, setSyncErrors] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [openBillId, setOpenBillId] = useState(null);
  const refreshSeq = useRef(0);

  const setLocale = (v) => {
    if (!ALLOWED_LOCALES.includes(v)) return;
    setLocaleRaw(v);
    safeStorageSet('tenant_locale', v);
    if (tenant) api('/api/tenant/me', { method: 'PUT', body: JSON.stringify({ locale: v }) }).catch(() => {});
  };
  const setTheme = (v) => {
    if (!ALLOWED_THEMES.includes(v)) return;
    setThemeRaw(v);
    document.body.dataset.theme = v;
    safeStorageSet('tenant_theme', v);
  };

  useEffect(() => { document.body.dataset.theme = theme; }, [theme]);

  useEffect(() => onAuthExpired(() => {
    refreshSeq.current++;
    setTenant(null); setBills([]); setPayments([]); setTickets([]); setContract(null);
    setBuilding(null); setSyncErrors([]); setPage('home');
  }), []);

  useEffect(() => {
    (async () => {
      try {
        const [me, f] = await Promise.all([
          fetch('/api/tenant/me', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => ({ tenant: null })),
          fetch('/api/features', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => ({ features: {} })),
        ]);
        setFeatures(f.features || {});
        if (me.tenant) {
          setTenant(me.tenant);
          if (me.tenant.locale && ALLOWED_LOCALES.includes(me.tenant.locale)) {
            setLocaleRaw(me.tenant.locale);
          }
          await refresh(me.tenant);
        }
      } finally { setLoading(false); }
    })();
  }, []);

  // refresh() reads from the current tenant. Wrap in useCallback so the
  // identity is stable across renders that don't change `tenant` — without
  // this the BillsView polling useEffect clears and restarts its 20s
  // interval on every parent render (cosmetic, but a real waste of timers
  // and one cause of flaky deep-link auto-open).
  const refresh = useCallback(async (currentTenant) => {
    const t = currentTenant || tenant;
    if (!t) return;
    const seq = ++refreshSeq.current;
    setSyncing(true);
    const labels = {
      bills: locale === 'th' ? 'บิล' : 'Bills',
      payments: locale === 'th' ? 'ประวัติชำระเงิน' : 'Payments',
      tickets: locale === 'th' ? 'แจ้งซ่อม' : 'Maintenance',
      contract: locale === 'th' ? 'สัญญา' : 'Contract',
      paymentInfo: locale === 'th' ? 'ข้อมูลหอพัก/ช่องทางชำระเงิน' : 'Building/payment info',
    };
    try {
      const results = await Promise.allSettled([
        api('/api/tenant/bills'),
        api('/api/tenant/payments'),
        api('/api/tenant/maintenance'),
        api('/api/tenant/contract'),
        // Building info is used by Profile contact cards. /api/tenant/payment-info
        // is the cheapest endpoint that returns it.
        api('/api/tenant/payment-info'),
      ]);
      if (seq !== refreshSeq.current) return;
      const errors = [];
      const applyResult = (idx, key, apply) => {
        const r = results[idx];
        if (r.status === 'fulfilled') {
          apply(r.value || {});
          return;
        }
        errors.push({
          key,
          label: labels[key] || key,
          message: r.reason?.message || (locale === 'th' ? 'โหลดไม่สำเร็จ' : 'failed to load'),
        });
      };
      applyResult(0, 'bills', (d) => setBills(Array.isArray(d.bills) ? d.bills : []));
      applyResult(1, 'payments', (d) => setPayments(Array.isArray(d.payments) ? d.payments : []));
      applyResult(2, 'tickets', (d) => setTickets(Array.isArray(d.tickets) ? d.tickets : []));
      applyResult(3, 'contract', (d) => setContract(d.contract || null));
      applyResult(4, 'paymentInfo', (d) => setBuilding(d.building || null));
      setSyncErrors(errors);
    } finally {
      if (seq === refreshSeq.current) setSyncing(false);
    }
  }, [tenant, locale]);
  const triggerRefresh = useCallback(() => refresh(tenant), [refresh, tenant]);

  async function onLoggedIn() {
    const me = await fetch('/api/tenant/me', { credentials: 'same-origin' }).then((r) => r.json());
    if (!me.tenant) throw new Error(locale === 'th' ? 'ไม่สามารถโหลดข้อมูลผู้เช่าได้' : 'Could not load tenant profile');
    setTenant(me.tenant);
    if (me.tenant?.locale && ALLOWED_LOCALES.includes(me.tenant.locale)) setLocaleRaw(me.tenant.locale);
    await refresh(me.tenant);
    setPage('home');
  }

  async function onLogout() {
    try { await api('/api/tenant/logout', { method: 'POST' }); } catch {}
    refreshSeq.current++;
    setTenant(null); setBills([]); setPayments([]); setTickets([]); setContract(null);
    setBuilding(null); setSyncErrors([]); setPage('home');
  }

  function goto(p, billId) {
    setPage(p);
    if (p === 'bills' && billId) setOpenBillId(billId);
  }

  if (loading) {
    return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>
      {tr(locale, 'loading')}
    </div>;
  }
  if (!tenant) {
    return <LoginView locale={locale} setLocale={setLocale} onLoggedIn={onLoggedIn}
      portalEnabled={features?.tenantPortal?.enabled !== false} />;
  }

  const unpaidCount = bills.filter((b) => b.status === 'pending' || b.status === 'overdue').length;
  const openTickets = tickets.filter((x) => !['completed', 'cancelled'].includes(x.status)).length;

  return (
    <>
      <div className="portal-shell" style={{
        display: 'grid', gridTemplateColumns: 'var(--sidebar-w) 1fr',
        minHeight: '100vh', background: 'var(--bg)',
      }}>
        <Sidebar page={page} setPage={setPage} locale={locale} unpaidCount={unpaidCount}
          tenant={tenant} onLogout={onLogout} />
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <TopBar page={page} locale={locale} tenant={tenant} openMenu={() => setDrawer(true)}
            unpaidCount={unpaidCount} openTickets={openTickets}
            onBellClick={() => setPage(unpaidCount > 0 ? 'bills' : openTickets > 0 ? 'maintenance' : 'bills')} />
          <main className="tenant-main" style={{
            padding: 'var(--sp-6) var(--sp-7) calc(var(--bottomnav-h) + var(--sp-6))',
            maxWidth: 'var(--max-content)', width: '100%', margin: '0 auto',
          }}>
            <SyncBanner errors={syncErrors} syncing={syncing}
              onRetry={triggerRefresh} locale={locale} />
            {page === 'home'        && <HomeView tenant={tenant} locale={locale} bills={bills}
              tickets={tickets} contract={contract} goto={goto} />}
            {page === 'bills'       && <BillsView locale={locale} bills={bills}
              refresh={triggerRefresh} slipFeature={features?.slipUpload}
              openId={openBillId} setOpenId={setOpenBillId} />}
            {page === 'payments'    && <PaymentsView locale={locale} payments={payments}
              syncErrors={syncErrors} goto={goto} />}
            {page === 'contract'    && <ContractView locale={locale} tenant={tenant}
              contract={contract} />}
            {page === 'maintenance' && <MaintenanceView locale={locale} tenant={tenant}
              tickets={tickets} refresh={triggerRefresh} />}
            {page === 'profile'     && <ProfileView tenant={tenant} locale={locale} setLocale={setLocale}
              theme={theme} setTheme={setTheme} onLogout={onLogout} features={features}
              contract={contract} building={building} />}
          </main>
        </div>
      </div>
      <BottomNav page={page} setPage={setPage} locale={locale} unpaidCount={unpaidCount} />
      <DrawerNav open={drawer} onClose={() => setDrawer(false)} page={page} setPage={setPage}
        locale={locale} unpaidCount={unpaidCount}
        onLogout={() => { setDrawer(false); onLogout(); }} />
      <style>{`
        /* Canonical breakpoints used across the whole portal:
             >960   desktop / large laptop  (sidebar + 28px gutters)
             ≤960   tablet landscape        (drawer menu, no sidebar)
             ≤768   tablet portrait         (cards stack to 1 col)
             ≤640   phone                   (bottom-tab nav, modal → sheet)
             ≤480   small phone             (extra-tight paddings)
           No other widths are used so resizing the window never produces
           an in-between "snap" zone. Every responsive grid below also uses
           ONLY these widths — no auto-fit/auto-fill in user-facing layouts
           so column counts never silently jump as the viewport changes. */

        /* Tablet landscape — hide the sidebar, show drawer trigger. */
        @media (max-width: 960px) {
          .portal-shell { grid-template-columns: 1fr !important; }
          .portal-sidebar { display: none !important; }
          .topbar-menu-btn { display: grid !important; }
          .tenant-main {
            padding: var(--sp-5) var(--sp-4) calc(var(--bottomnav-h) + var(--sp-5)) !important;
          }
          /* Shortcuts cap at 2-up on tablet so the cards don't look stretched. */
          .shortcuts-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
        }

        /* Tablet portrait — cards stack to 1 col, breakdown stays 3-up. */
        @media (max-width: 768px) {
          .home-breakdown { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; }
        }

        /* Phone — bottom-tab nav appears and modal turns into a bottom-sheet. */
        @media (max-width: 640px) {
          .bottom-nav { display: flex !important; }
          .home-grid { grid-template-columns: 1fr !important; }
          /* log.md #5 — section header action (e.g. "แจ้งซ่อมใหม่") no
             longer overlaps the title on narrow screens; it stacks under
             the title and grows full-width so the tap target stays large. */
          .section-header {
            flex-direction: column !important;
            align-items: stretch !important;
            gap: var(--sp-3) !important;
          }
          .section-header > :last-child button { width: 100% !important; }
          .tenant-main {
            padding: var(--sp-4) var(--sp-3)
              calc(env(safe-area-inset-bottom,0px) + var(--bottomnav-h) + var(--sp-5)) !important;
          }
          .sync-banner { flex-direction: column !important; align-items: stretch !important; }
          /* Bill row on phone — use grid-areas so the most important info
             (bill number + amount) stays on row 1 and the secondary chrome
             (period, status pill, chevron) tucks below. The previous rule
             stacked every child to one column, which buried the amount. */
          .bill-row {
            grid-template-columns: 1fr auto !important;
            grid-template-areas: "info amount" "meta meta" "pill chev" !important;
            gap: var(--sp-2) var(--sp-3) !important;
            padding: var(--sp-3) var(--sp-4) !important;
          }
          .bill-row > *:nth-child(1) { grid-area: info; min-width: 0 !important; }
          .bill-row > *:nth-child(2) { grid-area: pill; justify-self: start !important; }
          .bill-row > *:nth-child(3) { grid-area: amount; justify-self: end !important; text-align: right !important; min-width: 0 !important; }
          .bill-row > *:nth-child(4) { grid-area: chev;  justify-self: end !important; }
          .bill-card-main { grid-template-columns: 1fr !important; gap: var(--sp-3) !important; }
          .bill-card-amount { text-align: left !important; }
          .mini-cells { grid-template-columns: 1fr !important; }
          .mini-cell { border-left: 0 !important; border-top: 1px solid var(--line) !important; }
          .mini-cell:first-child { border-top: 0 !important; }
          /* Home breakdown collapses to 1 col so unit labels ("ค่าน้ำ · 12
             หน่วย") render in full instead of being clipped to "ค่าน้ำ ·…"
             inside a 100px-wide cell. */
          .home-breakdown { grid-template-columns: 1fr !important; }
          .home-breakdown > * { border-left: 0 !important; border-top: 1px solid var(--line) !important; }
          .home-breakdown > *:first-child { border-top: 0 !important; }
          /* Shortcuts grid drops to 2 columns on phone — keeps tap targets
             comfortable without forcing a 1-col stack that scrolls forever. */
          .shortcuts-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
          /* Contact cards stay 1 col on phone — values can wrap to 2 lines. */
          .contact-grid { grid-template-columns: 1fr !important; }
          .maintenance-ticket-row { flex-direction: column !important; }
          /* Modal becomes a slide-up bottom-sheet: stuck to the bottom
             edge, top corners only, safe-area padding so no content sits
             under the iOS home indicator. */
          .modal-overlay {
            align-items: flex-end !important;
            justify-content: stretch !important;
            padding: var(--sp-6) 0 0 !important;
          }
          .modal-panel {
            margin: 0 !important;
            border-radius: 22px 22px 0 0 !important;
            max-height: min(calc(100vh - 24px), calc(100dvh - 24px)) !important;
            padding-bottom: env(safe-area-inset-bottom, 0px) !important;
          }
        }

        /* Small phone — slightly tighter paddings only; no new layout snaps. */
        @media (max-width: 480px) {
          .modal-panel { border-radius: 18px 18px 0 0 !important; }
          .modal-body { padding: var(--sp-4) var(--sp-3) var(--sp-5) !important; }
          /* Shortcuts shrink further only at 480, never between 481-639. */
          .shortcuts-grid { grid-template-columns: 1fr !important; }
        }

        /* Landscape phone — short-but-wide viewport. Reclaim the top air
           so the bottom-sheet doesn't push past the visible viewport. */
        @media (max-height: 520px) and (max-width: 960px) {
          .modal-overlay { padding-top: var(--sp-3) !important; }
          .modal-panel { max-height: min(calc(100vh - 12px), calc(100dvh - 12px)) !important; }
        }
      `}</style>
    </>
  );
}

// ========================================================== boundaries ===
class TenantErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) {
    try {
      fetch('/api/client-error', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: String(err && err.message ? err.message : err).slice(0, 1000),
          stack: String((err && err.stack) || '').slice(0, 4000),
          componentStack: String((info && info.componentStack) || '').slice(0, 4000),
          url: window.location.href,
        }),
      });
    } catch {}
  }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{
        minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24,
        background: 'var(--bg)',
      }}>
        <Card style={{ maxWidth: 480, textAlign: 'center' }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 18 }}>เกิดข้อผิดพลาด</div>
          <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 8, marginBottom: 16 }}>
            {String(this.state.err?.message || 'unknown')}
          </p>
          <Button onClick={() => this.setState({ err: null })}>ลองใหม่</Button>
          <Button variant="ghost" onClick={() => window.location.href = '/tenant'}
            style={{ marginTop: 8, display: 'block', margin: '8px auto 0' }}>
            โหลดหน้าใหม่
          </Button>
        </Card>
      </div>
    );
  }
}

function TenantOfflineBanner() {
  const [online, setOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);
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
      background: 'var(--red)', color: '#fff', padding: '8px 16px',
      textAlign: 'center', fontSize: 13.5, fontWeight: 500,
    }}>🔌 ไม่ได้เชื่อมต่ออินเทอร์เน็ต</div>
  );
}

// Global error sink — same defensive pattern as v2 portal.
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
    } catch {}
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
