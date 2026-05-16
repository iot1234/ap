// services/contractPdf.js
// Render a Thai-language tenancy contract as A4 PDF using PDFKit.
// Designed to be both printed (paper signing) AND signed online (signature
// image embedded into the signature box). Auto page-breaks long clause
// lists. Default clauses are built-in; admin can override via
// system_settings['contract.terms_template'].
//
// Layout (A4 portrait, 595×842 pt, 48pt margins):
//   Page 1
//     - Header band                            ~60pt
//     - Title (สัญญาเช่าห้องพัก)                ~30pt
//     - Contract metadata (no, date)            ~30pt
//     - Parties (lessor + lessee)               ~140pt
//     - Property + financial summary table      ~180pt
//   Page 1+ (flow)
//     - Numbered clause list                    variable
//   Last page
//     - Signature block (lessor + lessee)       ~140pt
//     - Witness block (optional)                ~80pt
//     - Footer (page numbers, contract no)
//
// Buffers fonts on first call. Crashes gracefully when fonts are missing
// (falls back to PDFKit's Helvetica, which renders Thai as boxes — but
// at least doesn't throw).

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const FONT_DIR = path.join(__dirname, '..', 'server-assets', 'fonts');
const FONT_REGULAR = path.join(FONT_DIR, 'Sarabun-Regular.ttf');
const FONT_BOLD    = path.join(FONT_DIR, 'Sarabun-Bold.ttf');

const C = {
  ink:    '#2c241b',
  ink2:   '#5b4f40',
  muted:  '#8a7d6b',
  border: '#ece4d4',
  accent: '#c46a3e',
  bg:     '#faf6ee',
  hairline: '#cdc4b3',
};

// A4 portrait in points (PDFKit default unit).
const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;
const CONTENT_TOP = MARGIN;
// Reserve space at the bottom of every page for the page-number footer.
const CONTENT_BOTTOM = PAGE_H - MARGIN - 24;

const THAI_MONTHS = [
  'มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
  'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม',
];
function fmtThaiDate(d) {
  if (!d) return '—';
  const dt = (d instanceof Date) ? d : new Date(d);
  if (!Number.isFinite(dt.getTime())) return '—';
  return `${dt.getDate()} ${THAI_MONTHS[dt.getMonth()]} ${dt.getFullYear() + 543}`;
}
function fmtCurrency(n) {
  if (n == null || !Number.isFinite(Number(n))) return '0.00';
  return Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function thaiNumber(n) {
  // Convert to Thai-Arabic numerals where appropriate. The Thai contract
  // tradition uses Arabic numerals for amounts, so this only converts the
  // ordinals on numbered clauses (ข้อ 1, ข้อ 2, ...).
  return String(n);
}

// === Default clauses ======================================================
// Standard Thai dorm tenancy clauses. Operators get a working contract
// out of the box; admin can override via system_settings or simply append
// custom clauses. Each clause has an `id` so admin diffing custom vs default
// stays meaningful even after inserts/reorders. The variables in {{...}}
// are interpolated against the contract context (rent, deposit, room, etc).
const DEFAULT_CLAUSES = Object.freeze([
  {
    id: 'rental',
    title: 'การเช่า',
    body: 'ผู้ให้เช่าตกลงให้ผู้เช่าเช่าห้องพักเลขที่ {{roomId}} ของ {{lessorName}} เพื่อการอยู่อาศัยเท่านั้น โดยผู้เช่ารับทราบสภาพห้อง รายละเอียดทรัพย์สิน และข้อบังคับของหอพักตามสัญญานี้ครบถ้วนแล้ว',
  },
  {
    id: 'term',
    title: 'ระยะเวลาเช่า',
    body: 'สัญญานี้มีผลตั้งแต่วันที่ {{startDate}} {{endDateClause}} หากผู้เช่าประสงค์จะต่อสัญญา ต้องแจ้งให้ผู้ให้เช่าทราบล่วงหน้าไม่น้อยกว่า 30 วันก่อนสิ้นสุดสัญญา หรือภายในระยะเวลาที่ผู้ให้เช่าประกาศไว้เป็นลายลักษณ์อักษร',
  },
  {
    id: 'rent_payment',
    title: 'ค่าเช่าและกำหนดชำระ',
    body: 'ผู้เช่าจะชำระค่าเช่ารายเดือน ๆ ละ {{monthlyRent}} บาท ภายในวันที่ {{dueDay}} ของทุกเดือน ผ่านช่องทางที่ผู้ให้เช่ากำหนด หากชำระล่าช้าจะคิดค่าปรับ {{lateFeeRate}}% ต่อเดือนของยอดค้างชำระ หรือตามอัตราที่ระบุในใบแจ้งหนี้/ประกาศของหอพัก',
  },
  {
    id: 'deposit',
    title: 'เงินมัดจำ',
    body: 'ผู้เช่าวางเงินมัดจำจำนวน {{depositAmount}} บาท เพื่อเป็นหลักประกันความเสียหายของห้องพัก ทรัพย์สิน กุญแจ/บัตรเข้าออก และหนี้ตามสัญญา ผู้ให้เช่าจะคืนเงินมัดจำภายใน 30 วันหลังคืนห้อง ตรวจสภาพห้อง และหักค่าใช้จ่ายที่ค้างชำระหรือค่าเสียหายตามจริงแล้ว',
  },
  {
    id: 'utilities',
    title: 'ค่าสาธารณูปโภค',
    body: 'ค่าน้ำ ค่าไฟ อินเทอร์เน็ต ค่าส่วนกลาง และค่าใช้จ่ายประจำอื่น ๆ คิดตามอัตราที่ผู้ให้เช่าประกาศหรือระบุในใบแจ้งหนี้ โดยค่าน้ำและค่าไฟอาจคิดจากมิเตอร์ที่อ่านจริงในแต่ละรอบบิล ผู้เช่าต้องชำระพร้อมค่าเช่าตามกำหนด',
  },
  {
    id: 'occupancy',
    title: 'ผู้พักอาศัยและการโอนสิทธิ',
    body: 'ผู้เช่าต้องเป็นผู้พักอาศัยหลักตามสัญญานี้ ห้ามโอนสิทธิการเช่า ให้เช่าช่วง เปลี่ยนผู้พักอาศัยหลัก หรือให้บุคคลอื่นเข้าพักแทนโดยไม่ได้รับอนุญาตเป็นลายลักษณ์อักษรจากผู้ให้เช่า',
  },
  {
    id: 'usage',
    title: 'การใช้ห้องพัก',
    body: 'ผู้เช่าใช้ห้องพักเพื่ออยู่อาศัยเท่านั้น ห้ามใช้ประกอบกิจการผิดกฎหมาย การพนัน ยาเสพติด การค้าประเวณี การเก็บของผิดกฎหมาย หรือกิจกรรมใดที่ก่อให้เกิดอันตรายหรือเดือดร้อนแก่ผู้อื่น',
  },
  {
    id: 'alteration',
    title: 'การดัดแปลง ติดตั้ง และเคลื่อนย้ายทรัพย์สิน',
    body: 'ผู้เช่าห้ามเจาะ ตอก ทาสี ดัดแปลงโครงสร้าง ระบบไฟฟ้า ระบบประปา ประตู หน้าต่าง เฟอร์นิเจอร์ หรือย้ายทรัพย์สินของหอพักออกจากห้อง เว้นแต่ได้รับอนุญาตจากผู้ให้เช่า ผู้เช่าต้องรับผิดชอบค่าแก้ไขคืนสภาพเดิมตามจริง',
  },
  {
    id: 'condition_inventory',
    title: 'สภาพห้องและรายการทรัพย์สิน',
    body: 'ผู้เช่ารับทราบสภาพห้องและรายการทรัพย์สิน ณ วันเริ่มเช่า หากพบความชำรุดที่มีมาก่อนต้องแจ้งผู้ให้เช่าภายใน 7 วันนับจากวันเข้าพัก หากไม่แจ้งให้ถือว่าห้องและทรัพย์สินอยู่ในสภาพเรียบร้อย',
  },
  {
    id: 'maintenance',
    title: 'การบำรุงรักษา',
    body: 'ผู้เช่าต้องดูแลรักษาห้องพักและทรัพย์สินภายในห้องให้อยู่ในสภาพดี ความเสียหายจากการใช้งานปกติให้แจ้งผู้ให้เช่าซ่อมแซม ความเสียหายจากผู้เช่า ผู้มาเยี่ยม หรือบุคคลในความรับผิดชอบของผู้เช่า ผู้เช่าต้องชดใช้ค่าเสียหายตามจริง',
  },
  {
    id: 'inspection_entry',
    title: 'การเข้าตรวจห้องและเหตุฉุกเฉิน',
    body: 'ผู้ให้เช่าหรือผู้แทนสามารถเข้าตรวจ ซ่อมแซม หรือดูแลระบบอาคารโดยแจ้งผู้เช่าล่วงหน้าตามสมควร ยกเว้นเหตุฉุกเฉิน เช่น ไฟไหม้ น้ำรั่ว กลิ่นไหม้ เหตุอันตราย หรือเหตุที่อาจกระทบผู้พักอาศัยอื่น สามารถเข้าดำเนินการได้ทันที',
  },
  {
    id: 'keys_access',
    title: 'กุญแจ บัตรเข้าออก และสิทธิการเข้าพื้นที่',
    body: 'กุญแจ บัตรเข้าออก รีโมต หรืออุปกรณ์เข้าพื้นที่เป็นทรัพย์สินของผู้ให้เช่า ผู้เช่าห้ามทำสำเนาหรือส่งมอบให้บุคคลอื่น หากสูญหาย ชำรุด หรือไม่คืนเมื่อสิ้นสุดสัญญา ผู้เช่าต้องชำระค่าทดแทนตามจริง',
  },
  {
    id: 'safety',
    title: 'ความปลอดภัยและของต้องห้าม',
    body: 'ผู้เช่าต้องปฏิบัติตามมาตรการความปลอดภัยของหอพัก ห้ามเก็บวัตถุไวไฟ วัตถุระเบิด อาวุธ สิ่งผิดกฎหมาย หรือใช้อุปกรณ์ไฟฟ้าที่เสี่ยงต่ออัคคีภัย ห้ามรบกวนหรือปิดกั้นทางหนีไฟ ทางเดิน อุปกรณ์ดับเพลิง และพื้นที่ส่วนกลาง',
  },
  {
    id: 'noise',
    title: 'ความสงบและเสียงรบกวน',
    body: 'ผู้เช่าต้องไม่ส่งเสียงดังรบกวนผู้พักอาศัยรายอื่นโดยเฉพาะระหว่างเวลา 22.00 น. ถึง 06.00 น. การจัดงานเลี้ยงหรือกิจกรรมที่อาจรบกวนต้องได้รับอนุญาตล่วงหน้า',
  },
  {
    id: 'visitors',
    title: 'ผู้มาเยี่ยม',
    body: 'ผู้เช่าสามารถรับผู้มาเยี่ยมได้ในเวลาที่หอพักกำหนด ผู้มาเยี่ยมต้องปฏิบัติตามกฎของหอพัก และห้ามพักค้างคืนเกิน 3 คืนต่อเดือนโดยไม่แจ้งผู้ให้เช่า ผู้เช่าต้องรับผิดชอบต่อพฤติกรรม ความเสียหาย และค่าใช้จ่ายที่เกิดจากผู้มาเยี่ยมทุกประการ',
  },
  {
    id: 'cleanliness',
    title: 'ความสะอาด ขยะ และพื้นที่ส่วนกลาง',
    body: 'ผู้เช่าต้องรักษาความสะอาดภายในห้องและพื้นที่ส่วนกลาง ทิ้งขยะในจุดที่กำหนด ห้ามวางสิ่งของกีดขวางทางเดิน บันได ทางหนีไฟ หรือพื้นที่ส่วนกลาง และต้องไม่กระทำการใดที่ก่อกลิ่น เสียง หรือความสกปรกรบกวนผู้อื่น',
  },
  {
    id: 'parking_common_area',
    title: 'ที่จอดรถและพื้นที่ส่วนกลาง',
    body: 'การใช้ที่จอดรถและพื้นที่ส่วนกลางต้องเป็นไปตามสิทธิและเงื่อนไขที่ผู้ให้เช่ากำหนด ผู้เช่าห้ามจอดรถกีดขวาง ใช้พื้นที่ส่วนกลางเพื่อเก็บของส่วนตัว หรือกระทำการที่กระทบสิทธิของผู้พักอาศัยรายอื่น',
  },
  {
    id: 'pets_smoking',
    title: 'สัตว์เลี้ยง การสูบบุหรี่ และสิ่งรบกวน',
    body: 'ห้ามเลี้ยงสัตว์ สูบบุหรี่ บุหรี่ไฟฟ้า หรือก่อกลิ่นควันภายในห้องและพื้นที่ห้ามสูบ เว้นแต่ได้รับอนุญาตเป็นลายลักษณ์อักษรจากผู้ให้เช่า หากฝ่าฝืนผู้เช่าต้องรับผิดชอบค่าทำความสะอาด ค่าเสียหาย และผลกระทบต่อผู้พักอาศัยอื่น',
  },
  {
    id: 'notices_data',
    title: 'การแจ้งเตือนและข้อมูลส่วนบุคคล',
    body: 'ผู้เช่ายินยอมให้ผู้ให้เช่าใช้ข้อมูลติดต่อของผู้เช่าเพื่อการบริหารสัญญา การออกบิล การติดตามชำระเงิน การแจ้งซ่อม การแจ้งเหตุฉุกเฉิน และการแจ้งข้อมูลที่เกี่ยวข้องกับการอยู่อาศัย โดยผู้เช่าต้องแจ้งเมื่อมีการเปลี่ยนเบอร์โทรศัพท์ อีเมล หรือช่องทางติดต่อ',
  },
  {
    id: 'breach',
    title: 'การผิดสัญญาและการระงับบริการ',
    body: 'หากผู้เช่าค้างชำระ ฝ่าฝืนกฎหอพัก สร้างความเสียหาย หรือกระทำการที่เป็นอันตราย ผู้ให้เช่าสามารถแจ้งเตือน เรียกค่าเสียหาย ระงับบริการที่ไม่จำเป็นตามสมควร หรือดำเนินการตามสิทธิในสัญญาและกฎหมายที่เกี่ยวข้อง',
  },
  {
    id: 'termination',
    title: 'การยกเลิกสัญญาก่อนกำหนด',
    body: 'หากฝ่ายใดประสงค์ยกเลิกสัญญาก่อนสิ้นสุด ต้องแจ้งล่วงหน้าไม่น้อยกว่า 30 วัน เว้นแต่มีเหตุผิดสัญญาร้ายแรงหรือเหตุฉุกเฉิน หากผู้เช่ายกเลิกโดยไม่แจ้งล่วงหน้า ผู้ให้เช่าอาจหักค่าใช้จ่ายหรือค่าเสียหายจากเงินมัดจำตามจริงและตามสมควร',
  },
  {
    id: 'return',
    title: 'การคืนห้องพัก',
    body: 'เมื่อสิ้นสุดสัญญา ผู้เช่าต้องคืนห้องพักในสภาพดี ทำความสะอาด ไม่มีของส่วนตัวค้างไว้ ชำระหนี้ทั้งหมด และส่งคืนกุญแจ/บัตรเข้าออกแก่ผู้ให้เช่า ค่าเสียหาย ค่าทำความสะอาด ค่าขนย้ายของทิ้ง และค่าใช้จ่ายค้างชำระจะถูกหักจากเงินมัดจำตามจริง',
  },
  {
    id: 'misc',
    title: 'ข้อตกลงเพิ่มเติม',
    body: 'ข้อตกลงหรือประกาศของหอพักที่ไม่ขัดต่อสัญญานี้ถือเป็นส่วนหนึ่งของสัญญา หากเกิดข้อพิพาท คู่สัญญาตกลงเจรจาด้วยความสุจริตก่อน หากตกลงไม่ได้ให้ใช้กฎหมายไทยและศาลที่มีเขตอำนาจในประเทศไทยเป็นผู้พิจารณา ผู้เช่ายืนยันว่าได้อ่าน เข้าใจ และยอมรับข้อความในสัญญานี้ครบถ้วนแล้ว',
  },
]);

const SYSTEM_VARIABLES = Object.freeze([
  { key: 'lessorName', label: 'ชื่อผู้ให้เช่า', group: 'party' },
  { key: 'tenantName', label: 'ชื่อผู้เช่า', group: 'party' },
  { key: 'tenantPhone', label: 'เบอร์ผู้เช่า', group: 'party' },
  { key: 'tenantEmail', label: 'อีเมลผู้เช่า', group: 'party' },
  { key: 'tenantCitizenId', label: 'เลขบัตรผู้เช่าแบบปิดบัง', group: 'party' },
  { key: 'tenantAddress', label: 'ที่อยู่ผู้เช่า', group: 'party' },
  { key: 'emergencyContactName', label: 'ชื่อผู้ติดต่อฉุกเฉิน', group: 'party' },
  { key: 'emergencyContactPhone', label: 'เบอร์ผู้ติดต่อฉุกเฉิน', group: 'party' },
  { key: 'emergencyContactRelation', label: 'ความสัมพันธ์ผู้ติดต่อฉุกเฉิน', group: 'party' },

  { key: 'buildingName', label: 'ชื่อหอพัก/อาคาร', group: 'building' },
  { key: 'buildingAddress', label: 'ที่อยู่หอพัก', group: 'building' },
  { key: 'buildingPhone', label: 'เบอร์หอพัก', group: 'building' },
  { key: 'buildingTaxId', label: 'เลขผู้เสียภาษีผู้ให้เช่า', group: 'building' },

  { key: 'roomId', label: 'เลขห้อง', group: 'room' },
  { key: 'roomType', label: 'ประเภทห้อง', group: 'room' },
  { key: 'roomFloor', label: 'ชั้น', group: 'room' },
  { key: 'roomSize', label: 'ขนาดห้อง', group: 'room' },
  { key: 'roomAddress', label: 'ที่ตั้งห้อง', group: 'room' },
  { key: 'roomAmenities', label: 'สิ่งอำนวยความสะดวก', group: 'room' },

  { key: 'contractNo', label: 'เลขที่สัญญา', group: 'contract' },
  { key: 'signedDate', label: 'วันที่ทำสัญญา', group: 'contract' },
  { key: 'startDate', label: 'วันเริ่มเช่า', group: 'contract' },
  { key: 'endDate', label: 'วันสิ้นสุดสัญญา', group: 'contract' },
  { key: 'endDateClause', label: 'ข้อความวันสิ้นสุดสัญญา', group: 'contract' },
  { key: 'termMonths', label: 'จำนวนเดือนสัญญา', group: 'contract' },

  { key: 'monthlyRent', label: 'ค่าเช่ารายเดือน', group: 'money' },
  { key: 'depositAmount', label: 'เงินมัดจำ', group: 'money' },
  { key: 'discountPct', label: 'ส่วนลด (%)', group: 'money' },
  { key: 'dueDay', label: 'วันที่ครบกำหนดชำระ', group: 'money' },
  { key: 'lateFeeRate', label: 'ค่าปรับล่าช้า (%)', group: 'money' },
]);

/**
 * Substitute {{key}} placeholders against `vars`. Missing keys render as
 * an em-dash so a partially-filled contract still prints sensibly.
 *
 * Custom variables (template.variables) are merged on top of the built-in
 * context, so an admin who defines {{wifi_password}} in their template can
 * reference it from any clause without editing the renderer.
 */
function interpolate(template, vars) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = vars[k];
    if (v == null || v === '') return '—';
    return String(v);
  });
}

/**
 * Given the admin's terms template (or null) + contract context, return the
 * final array of clauses to render. Admin can:
 *   - omit `clauses` entirely → use DEFAULT_CLAUSES verbatim
 *   - supply { clauses: [...] } → use those exclusively
 *   - supply { mode: 'append', clauses: [...] } → DEFAULT + admin's
 *   - supply { mode: 'override', clauses: [...] } → admin's only
 *
 * Each clause: { id?, title, body }. Title is bold; body is wrapped paragraph.
 */
function resolveClauses(template) {
  if (!template || typeof template !== 'object') return [...DEFAULT_CLAUSES];
  const mode = template.mode || (Array.isArray(template.clauses) ? 'override' : 'default');
  const custom = Array.isArray(template.clauses) ? template.clauses : [];
  if (mode === 'append') return [...DEFAULT_CLAUSES, ...custom];
  if (mode === 'override' && custom.length > 0) return [...custom];
  return [...DEFAULT_CLAUSES];
}

/**
 * Render the contract.
 *
 * @param {object} contract - {
 *     contractNo, startDate, endDate, monthlyRent, deposit, discountPct,
 *     termMonths, signedAt, agreedTermsVersion, status,
 * }
 * @param {object} tenant - { fullName, phone, email, citizenIdMasked, address,
 *                            emergencyContactName, emergencyContactPhone }
 * @param {object} room - { id, address?, type? }
 * @param {object} building - { name, address, phone, taxId, ownerName }
 * @param {object} options - {
 *     termsTemplate?: { mode, clauses } | null,
 *     signatures?: { lessorBuf?: Buffer, tenantBuf?: Buffer },
 *     dueDay?: number,
 *     lateFeeRate?: number,
 * }
 * @param {WritableStream} stream
 */
async function renderContractPdf(contract, tenant, room, building, options, stream) {
  const opts = options || {};
  // Section visibility flags from the template (with sane defaults). Admin
  // can hide witnesses, hide the property-details table, or override the
  // acknowledgment text without touching code. Unknown keys are ignored.
  const tmplSections = (opts.termsTemplate && typeof opts.termsTemplate.sections === 'object')
    ? opts.termsTemplate.sections : {};
  const sections = {
    showWitnesses:        tmplSections.showWitnesses        !== false,
    showEmergencyContact: tmplSections.showEmergencyContact !== false,
    showPropertyDetails:  tmplSections.showPropertyDetails  !== false,
    showFinancialTable:   tmplSections.showFinancialTable   !== false,
    showRoomAmenities:    tmplSections.showRoomAmenities    !== false,
    acknowledgmentText:   typeof tmplSections.acknowledgmentText === 'string'
      ? tmplSections.acknowledgmentText
      : 'คู่สัญญาทั้งสองฝ่ายได้อ่านและเข้าใจข้อความในสัญญานี้โดยตลอดแล้ว '
        + 'จึงได้ลงลายมือชื่อไว้เป็นหลักฐานต่อหน้าพยาน',
    headerNote: typeof tmplSections.headerNote === 'string' ? tmplSections.headerNote : null,
  };
  // Custom variables defined on the template are merged into the
  // interpolation context below — admin can reference {{wifi_password}}
  // etc. from any clause without touching the renderer.
  const tmplVars = (opts.termsTemplate && typeof opts.termsTemplate.variables === 'object')
    ? opts.termsTemplate.variables : {};
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    // Required so doc.bufferedPageRange() returns ALL pages and
    // doc.switchToPage(i) works for the page-number footer pass below.
    // Without this, PDFKit only buffers the current page; multi-page
    // contracts (12+ clauses → 2+ pages) crash on the footer iteration
    // with "Cannot switch to a page that's already finalized."
    bufferPages: true,
    info: {
      Title: `Contract ${contract.contractNo || ''}`,
      Author: building?.name || 'บ้านกาญจน์ เรสซิเดนซ์',
      Subject: 'Tenancy contract',
    },
  });

  // Register Thai fonts. PDFKit happily renders boxes if missing — we'd
  // rather emit a usable-if-ugly PDF than crash, but warn loudly.
  let fontsOk = true;
  try {
    if (fs.existsSync(FONT_REGULAR)) doc.registerFont('th', FONT_REGULAR);
    else fontsOk = false;
    if (fs.existsSync(FONT_BOLD)) doc.registerFont('th-bold', FONT_BOLD);
    else fontsOk = false;
  } catch {
    fontsOk = false;
  }
  if (!fontsOk) {
    console.warn('[contractPdf] Thai fonts missing — falling back to Helvetica');
  }
  const FONT       = fontsOk ? 'th'       : 'Helvetica';
  const FONT_B     = fontsOk ? 'th-bold'  : 'Helvetica-Bold';
  doc.font(FONT);

  doc.pipe(stream);

  // =============== Helpers (page-aware text writers) ====================
  // PDFKit's `text(...)` automatically advances doc.y — but it doesn't
  // know about our custom CONTENT_BOTTOM (we reserve space for the page
  // number footer). When the cursor would cross that line, we addPage()
  // first so the next clause starts at the top of a fresh page.
  function ensureRoom(neededHeight) {
    const pageBodyH = CONTENT_BOTTOM - CONTENT_TOP;
    const reserve = Math.min(Number(neededHeight) || 0, pageBodyH);
    if (doc.y + reserve > CONTENT_BOTTOM) {
      doc.addPage();
      doc.y = CONTENT_TOP;
    }
  }
  function hr(yOpt) {
    const y = yOpt != null ? yOpt : doc.y;
    doc.moveTo(MARGIN, y).lineTo(PAGE_W - MARGIN, y)
      .lineWidth(0.5).strokeColor(C.border).stroke();
  }
  function drawSectionTitle(title) {
    ensureRoom(28);
    const y = doc.y;
    doc.roundedRect(MARGIN, y, CONTENT_W, 20, 5).fill(C.bg);
    doc.rect(MARGIN, y, 4, 20).fill(C.accent);
    doc.font(FONT_B).fontSize(10.5).fillColor(C.ink)
      .text(title, MARGIN + 12, y + 5, { width: CONTENT_W - 24 });
    doc.y = y + 26;
  }
  function infoBoxHeight(title, lines, width) {
    doc.font(FONT_B).fontSize(10);
    const titleH = doc.heightOfString(title || ' ', { width: width - 20 });
    doc.font(FONT).fontSize(9);
    const bodyH = lines.reduce((sum, line) => (
      sum + doc.heightOfString(line || ' ', { width: width - 20 }) + 3
    ), 0);
    return Math.max(62, 10 + titleH + 6 + bodyH + 6);
  }
  function drawInfoBox(x, y, width, title, lines) {
    const height = infoBoxHeight(title, lines, width);
    doc.roundedRect(x, y, width, height, 7).fill('#fffdf8');
    doc.roundedRect(x, y, width, height, 7).lineWidth(0.5).strokeColor(C.border).stroke();
    doc.font(FONT_B).fontSize(10).fillColor(C.ink)
      .text(title, x + 10, y + 7, { width: width - 20 });
    let lineY = doc.y + 4;
    doc.font(FONT).fontSize(9).fillColor(C.ink2);
    for (const line of lines) {
      doc.text(line || '—', x + 10, lineY, { width: width - 20, lineGap: 1 });
      lineY = doc.y + 3;
    }
    return height;
  }

  // =============== Page 1 — Header + parties + property =================
  const lessorName = building?.ownerName || building?.name || '—';
  const tenantName = tenant?.fullName || '—';

  // Header band
  const headerY = MARGIN;
  doc.roundedRect(MARGIN, headerY, CONTENT_W, 68, 8).fill(C.bg);
  doc.rect(MARGIN, headerY, 6, 68).fill(C.accent);
  doc.font(FONT_B).fontSize(15).fillColor(C.ink)
    .text(building?.name || 'บ้านกาญจน์ เรสซิเดนซ์', MARGIN + 14, headerY + 12, { width: 290 });
  doc.font(FONT).fontSize(9.5).fillColor(C.ink2);
  let headerLineY = doc.y + 2;
  if (building?.address) {
    doc.text(building.address, MARGIN + 14, headerLineY, { width: 290 });
    headerLineY = doc.y + 2;
  }
  if (building?.phone) {
    doc.text(`โทร. ${building.phone}`, MARGIN + 14, headerLineY, { width: 290 });
    headerLineY = doc.y + 2;
  }
  if (building?.taxId) {
    doc.text(`เลขประจำตัวผู้เสียภาษี ${building.taxId}`, MARGIN + 14, headerLineY, { width: 290 });
    headerLineY = doc.y + 2;
  }
  if (sections.headerNote) {
    doc.font(FONT).fontSize(9).fillColor(C.accent)
      .text(sections.headerNote, MARGIN + 14, headerLineY, { width: 290 });
  }
  const metaX = MARGIN + CONTENT_W - 176;
  doc.roundedRect(metaX, headerY + 10, 162, 48, 6).fill('#ffffff');
  doc.roundedRect(metaX, headerY + 10, 162, 48, 6).lineWidth(0.5).strokeColor(C.border).stroke();
  doc.font(FONT).fontSize(8.5).fillColor(C.muted)
    .text('เลขที่สัญญา', metaX + 10, headerY + 17, { width: 142 });
  doc.font(FONT_B).fontSize(11).fillColor(C.ink)
    .text(contract.contractNo || '—', metaX + 10, headerY + 29, { width: 142 });
  doc.font(FONT).fontSize(8.5).fillColor(C.muted)
    .text(fmtThaiDate(contract.signedAt || new Date()), metaX + 10, headerY + 44, { width: 142 });
  doc.y = headerY + 80;

  // Title
  doc.font(FONT_B).fontSize(18).fillColor(C.ink)
    .text('สัญญาเช่าห้องพัก', MARGIN, doc.y, { width: CONTENT_W, align: 'center' });
  doc.y += 8;

  // Contract meta line
  doc.font(FONT).fontSize(10).fillColor(C.ink2)
    .text(
      `ห้อง ${room?.id || '—'}    ผู้เช่า ${tenantName}`,
      MARGIN, doc.y, { width: CONTENT_W, align: 'center' }
    );
  doc.y += 16;

  // Lead paragraph: "วันที่ ... ระหว่าง ... กับ ..."
  const leadText =
    `สัญญาฉบับนี้ทำขึ้นเมื่อ ${fmtThaiDate(contract.signedAt || new Date())} `
    + `ระหว่าง ${lessorName} (ซึ่งต่อไปในสัญญานี้เรียกว่า "ผู้ให้เช่า") `
    + `กับ ${tenantName} (ซึ่งต่อไปในสัญญานี้เรียกว่า "ผู้เช่า") `
    + `ทั้งสองฝ่ายตกลงทำสัญญาเช่าห้องพักดังนี้`;
  doc.font(FONT).fontSize(10.5);
  const leadH = doc.heightOfString(leadText, { width: CONTENT_W - 20, align: 'justify', lineGap: 2 }) + 18;
  ensureRoom(leadH + 12);
  const leadY = doc.y;
  doc.roundedRect(MARGIN, leadY, CONTENT_W, leadH, 7).fill('#fffdf8');
  doc.roundedRect(MARGIN, leadY, CONTENT_W, leadH, 7).lineWidth(0.5).strokeColor(C.border).stroke();
  doc.font(FONT).fontSize(11).fillColor(C.ink)
    .text(leadText, MARGIN + 10, leadY + 9,
      { width: CONTENT_W - 20, align: 'justify', lineGap: 2 });
  doc.y = leadY + leadH + 12;

  // === Parties block (two-column) ===
  drawSectionTitle('คู่สัญญา');
  const partyColW = (CONTENT_W - 16) / 2;
  const partyTopY = doc.y;
  const lessorLines = [
    `ชื่อ: ${lessorName}`,
    building?.address ? `ที่อยู่: ${building.address}` : null,
    building?.phone ? `โทรศัพท์: ${building.phone}` : null,
    building?.taxId ? `เลขประจำตัวผู้เสียภาษี: ${building.taxId}` : null,
  ].filter(Boolean);
  const tenantLines = [
    `ชื่อ: ${tenantName}`,
    tenant?.citizenIdMasked ? `เลขบัตร ปชช.: ${tenant.citizenIdMasked}` : null,
    tenant?.phone ? `โทรศัพท์: ${tenant.phone}` : null,
    tenant?.address ? `ที่อยู่: ${tenant.address}` : null,
    sections.showEmergencyContact && tenant?.emergencyContactName
      ? `ติดต่อฉุกเฉิน: ${tenant.emergencyContactName}`
          + (tenant.emergencyContactPhone ? ` · ${tenant.emergencyContactPhone}` : '')
          + (tenant.emergencyContactRelation ? ` (${tenant.emergencyContactRelation})` : '')
      : null,
  ].filter(Boolean);
  const leftH = drawInfoBox(MARGIN, partyTopY, partyColW, 'ผู้ให้เช่า', lessorLines);
  const rightH = drawInfoBox(MARGIN + partyColW + 16, partyTopY, partyColW, 'ผู้เช่า', tenantLines);

  doc.y = partyTopY + Math.max(leftH, rightH) + 14;
  ensureRoom(120);

  // === Property + financial summary ===
  // Sections can be hidden via template — admin renting commercial space
  // might want to skip the rich amenity list, e.g.
  if (sections.showPropertyDetails || sections.showFinancialTable) {
    drawSectionTitle('รายละเอียดห้องพักและการเงิน');

    const rowH = 16;
    const labelW = 160;
    const valW = CONTENT_W - labelW;
    const rows = [];

    if (sections.showPropertyDetails) {
      // Build a friendly room-summary string from whatever the caller
      // resolved (rooms_v2 or JSONB blob). All fields optional — missing
      // values turn into em-dashes so partial data still prints well.
      rows.push(['ห้องเลขที่', room?.id || '—']);
      // Compose "ประเภท · ชั้น X · ขนาด Y ตร.ม." line.
      const typeBits = [];
      if (room?.type)     typeBits.push(`ประเภท ${room.type}`);
      if (room?.floor != null) typeBits.push(`ชั้น ${room.floor}`);
      if (room?.size != null) typeBits.push(`ขนาด ${room.size} ตร.ม.`);
      if (room?.bedCount) typeBits.push(`${room.bedCount} เตียง`);
      if (typeBits.length) rows.push(['รายละเอียดห้อง', typeBits.join(' · ')]);
      // View / location
      if (room?.view) rows.push(['วิวห้อง', room.view]);
      // Amenities — only shown if the section flag is on AND there's data.
      if (sections.showRoomAmenities && Array.isArray(room?.amenities) && room.amenities.length) {
        rows.push(['สิ่งอำนวยความสะดวก', room.amenities.join(' · ')]);
      }
      rows.push(['ที่ตั้งห้อง', room?.address || building?.address || '—']);
    }

    if (sections.showFinancialTable) {
      rows.push(['ค่าเช่ารายเดือน', `${fmtCurrency(contract.monthlyRent)} บาท`
        + (Number(contract.discountPct) > 0
            ? ` (รวมส่วนลด ${Number(contract.discountPct).toFixed(2)}%)` : '')]);
      rows.push(['เงินมัดจำ', `${fmtCurrency(contract.deposit)} บาท`]);
      // Wifi fee surfaced when room data carried one — printed contracts
      // are easier to read when monthly cost is itemised.
      if (room?.wifiFee && Number(room.wifiFee) > 0) {
        rows.push(['ค่า WiFi รายเดือน', `${fmtCurrency(room.wifiFee)} บาท`]);
      }
      rows.push(['กำหนดชำระค่าเช่า', `วันที่ ${opts.dueDay || 15} ของทุกเดือน`]);
      rows.push(['ค่าปรับเมื่อชำระล่าช้า',
        `${(opts.lateFeeRate ?? 1.5)}% ต่อเดือน ของยอดค้างชำระ`]);
      rows.push(['วันเริ่มเช่า', fmtThaiDate(contract.startDate)]);
      rows.push(['วันสิ้นสุดสัญญา', contract.endDate ? fmtThaiDate(contract.endDate)
        : 'ไม่กำหนดล่วงหน้า (ต่อสัญญาอัตโนมัติรายเดือน)']);
      rows.push(['ระยะเวลาเช่า', contract.termMonths
        ? `${contract.termMonths} เดือน` : 'ไม่กำหนดล่วงหน้า']);
    }

    rows.forEach(([k, v], idx) => {
      doc.font(FONT).fontSize(10);
      const labelH = doc.heightOfString(k, { width: labelW });
      const valueH = doc.heightOfString(String(v || '—'), { width: valW });
      const actualRowH = Math.max(rowH, labelH, valueH) + 4;
      ensureRoom(actualRowH);
      const rowTop = doc.y;
      doc.roundedRect(MARGIN, rowTop, CONTENT_W, actualRowH - 1, 3)
        .fill(idx % 2 === 0 ? '#fffdf8' : C.bg);
      doc.font(FONT).fontSize(10).fillColor(C.muted)
        .text(k, MARGIN, rowTop + 3, { width: labelW });
      doc.font(FONT).fontSize(10).fillColor(C.ink)
        .text(v, MARGIN + labelW, rowTop + 3, { width: valW });
      hr(rowTop + actualRowH - 1);
      doc.y = rowTop + actualRowH;
    });
    doc.y += 8;
  }

  // =============== Clauses (numbered, auto page break) ==================
  drawSectionTitle('ข้อตกลงและกฎข้อบังคับ');

  // Resolve clause list — defaults vs custom mode (admin choice).
  const clauses = resolveClauses(opts.termsTemplate);
  // Interpolation context — built-in keys plus any custom variables the
  // template defined. Built-ins always win on key collisions so admin
  // can't accidentally shadow {{monthlyRent}} with a stale literal.
  const ctx = {
    // Custom variables first (so they're overridable by the built-ins).
    ...tmplVars,
    // Built-in context.
    monthlyRent: fmtCurrency(contract.monthlyRent),
    depositAmount: fmtCurrency(contract.deposit),
    dueDay: String(opts.dueDay || 15),
    lateFeeRate: String(opts.lateFeeRate ?? 1.5),
    startDate: fmtThaiDate(contract.startDate),
    endDate: contract.endDate ? fmtThaiDate(contract.endDate) : '—',
    endDateClause: contract.endDate
      ? `และมีกำหนดสิ้นสุดในวันที่ ${fmtThaiDate(contract.endDate)}`
      : 'และเป็นสัญญาต่อเนื่องรายเดือนจนกว่าจะมีการบอกเลิก',
    contractNo: contract.contractNo || '—',
    signedDate: fmtThaiDate(contract.signedAt || new Date()),
    buildingName: building?.name || '—',
    buildingAddress: building?.address || '—',
    buildingPhone: building?.phone || '—',
    buildingTaxId: building?.taxId || '—',
    roomId: room?.id || '—',
    roomType: room?.type || '—',
    roomFloor: room?.floor != null ? String(room.floor) : '—',
    roomSize: room?.size != null ? String(room.size) : '—',
    roomAddress: room?.address || building?.address || '—',
    roomAmenities: Array.isArray(room?.amenities) && room.amenities.length
      ? room.amenities.join(' · ')
      : '—',
    lessorName,
    tenantName,
    tenantPhone: tenant?.phone || '—',
    tenantEmail: tenant?.email || '—',
    tenantCitizenId: tenant?.citizenIdMasked || '—',
    tenantAddress: tenant?.address || '—',
    emergencyContactName: tenant?.emergencyContactName || '—',
    emergencyContactPhone: tenant?.emergencyContactPhone || '—',
    emergencyContactRelation: tenant?.emergencyContactRelation || '—',
    discountPct: Number.isFinite(Number(contract.discountPct))
      ? Number(contract.discountPct).toFixed(2)
      : '0.00',
    termMonths: contract.termMonths ? String(contract.termMonths) : '—',
  };

  for (let i = 0; i < clauses.length; i++) {
    const cl = clauses[i] || {};
    const title = String(cl.title || '').slice(0, 200);
    const body = interpolate(cl.body, ctx).slice(0, 4000);
    const titleText = `ข้อ ${thaiNumber(i + 1)}. ${title}`;
    doc.font(FONT_B).fontSize(11);
    const titleH = doc.heightOfString(titleText, { width: CONTENT_W });
    doc.font(FONT).fontSize(10);
    const bodyH = doc.heightOfString(body || ' ', {
      width: CONTENT_W - 16,
      align: 'justify',
      lineGap: 2,
    });
    ensureRoom(titleH + bodyH + 16);
    const clauseY = doc.y;
    doc.rect(MARGIN, clauseY + 2, 3, titleH + bodyH + 8).fill(C.accent);
    doc.font(FONT_B).fontSize(11).fillColor(C.ink)
      .text(titleText, MARGIN + 10, doc.y,
            { width: CONTENT_W - 10 });
    doc.y += 2;
    doc.font(FONT).fontSize(10).fillColor(C.ink2)
      .text(body, MARGIN + 16, doc.y,
            { width: CONTENT_W - 16, align: 'justify', lineGap: 2 });
    doc.y += 10;
  }

  // =============== Signature block ======================================
  const sigColW = (CONTENT_W - 32) / 2;
  const sigBoxH = 50;
  doc.font(FONT).fontSize(10);
  const ackH = doc.heightOfString(sections.acknowledgmentText || ' ', {
    width: CONTENT_W,
    align: 'center',
  });
  // Reserve the actual rendered height for the signature cluster. The old
  // fixed 240pt reservation frequently pushed signatures to a new page while
  // 150-200pt still remained, producing a visually empty tail page.
  const signatureLabelsH = 50;
  const witnessH = sections.showWitnesses ? 56 + 12 + 50 : 0;
  const signatureBlockH = 26 + (ackH + 10) + 10 + 4 + sigBoxH + Math.max(signatureLabelsH, witnessH) + 6;
  ensureRoom(signatureBlockH);

  // Acknowledgement line above signatures — admin can override the wording
  // via template.sections.acknowledgmentText (e.g. omit "ต่อหน้าพยาน" when
  // not using witnesses).
  drawSectionTitle('ลงนาม');
  const ackY = doc.y;
  const ackBoxH = ackH + 10;
  doc.roundedRect(MARGIN, ackY, CONTENT_W, ackBoxH, 7).fill('#fffdf8');
  doc.roundedRect(MARGIN, ackY, CONTENT_W, ackBoxH, 7).lineWidth(0.5).strokeColor(C.border).stroke();
  doc.font(FONT).fontSize(10).fillColor(C.ink2)
    .text(sections.acknowledgmentText, MARGIN + 10, ackY + 5,
      { width: CONTENT_W - 20, align: 'center' });
  doc.y = ackY + ackBoxH + 10;

  // Two signature columns — lessor on the left, lessee on the right.
  const sigTopY = doc.y + 4;

  function drawSignatureBox(x, y, label, name, signatureBuf, dateLabel) {
    // Box border
    doc.roundedRect(x, y, sigColW, sigBoxH, 4).fill('#fffdf8');
    doc.lineWidth(0.5).strokeColor(C.hairline)
      .roundedRect(x, y, sigColW, sigBoxH, 4).stroke();
    // Embed signature image if provided (online sign path)
    if (signatureBuf) {
      try {
        // Reserve a 4pt inner padding; preserve aspect with `fit`.
        doc.image(signatureBuf, x + 4, y + 4,
          { fit: [sigColW - 8, sigBoxH - 8], align: 'center', valign: 'center' });
      } catch (err) {
        console.warn('[contractPdf] embed signature failed:', err.message);
      }
    }
    // Label below the box
    const lblY = y + sigBoxH + 4;
    doc.font(FONT).fontSize(9).fillColor(C.muted)
      .text('ลงชื่อ ........................................................',
            x, lblY, { width: sigColW, align: 'center' });
    doc.font(FONT_B).fontSize(10).fillColor(C.ink)
      .text(`(${name || '—'})`, x, lblY + 14,
            { width: sigColW, align: 'center' });
    doc.font(FONT).fontSize(9).fillColor(C.muted)
      .text(label, x, lblY + 27, { width: sigColW, align: 'center' });
    doc.text(dateLabel, x, lblY + 39, { width: sigColW, align: 'center' });
  }

  drawSignatureBox(
    MARGIN, sigTopY,
    'ผู้ให้เช่า', lessorName,
    opts.signatures?.lessorBuf,
    `วันที่ ${fmtThaiDate(contract.signedAt || new Date())}`
  );
  drawSignatureBox(
    MARGIN + sigColW + 32, sigTopY,
    'ผู้เช่า', tenantName,
    opts.signatures?.tenantBuf,
    contract.signedAt
      ? `ลงนามเมื่อ ${fmtThaiDate(contract.signedAt)}`
      : 'วันที่ ............ / ............ / ............'
  );

  // Witness lines — admin can hide via template.sections.showWitnesses=false
  // (e.g. for short-stay contracts that don't need witnesses).
  if (sections.showWitnesses) {
    const witnessTopY = sigTopY + sigBoxH + 56;
    doc.y = witnessTopY;
    doc.font(FONT_B).fontSize(10).fillColor(C.ink)
      .text('พยาน', MARGIN, doc.y, { width: CONTENT_W });
    doc.y += 12;
    for (let i = 0; i < 2; i++) {
      doc.font(FONT).fontSize(9).fillColor(C.muted)
        .text('ลงชื่อ ............................................................. พยาน',
              MARGIN, doc.y, { width: sigColW });
      doc.text('(...........................................................)',
              MARGIN, doc.y + 12, { width: sigColW });
      if (i === 0) {
        doc.text('ลงชื่อ ............................................................. พยาน',
              MARGIN + sigColW + 32, doc.y - 12, { width: sigColW });
        doc.text('(...........................................................)',
              MARGIN + sigColW + 32, doc.y, { width: sigColW });
      }
      doc.y += 28;
    }
  }

  // === Page footers (page numbers + contract no) ========================
  // Add to every page after content is placed. PDFKit exposes an internal
  // bufferedPageRange so we can iterate all pages.
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const pageNo = i + 1;
    const total = range.count;
    doc.font(FONT).fontSize(9).fillColor(C.muted);
    // Center: contract no + version. Right: page x of y.
    doc.text(
      `${contract.contractNo || ''}`
      + (contract.agreedTermsVersion ? ` · เงื่อนไขเวอร์ชัน ${contract.agreedTermsVersion}` : ''),
      MARGIN, PAGE_H - MARGIN - 12,
      { width: CONTENT_W - 80, align: 'left' }
    );
    doc.text(
      `หน้า ${pageNo} จาก ${total}`,
      PAGE_W - MARGIN - 80, PAGE_H - MARGIN - 12,
      { width: 80, align: 'right' }
    );
  }

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

module.exports = {
  renderContractPdf,
  resolveClauses,
  DEFAULT_CLAUSES,
  SYSTEM_VARIABLES,
};
