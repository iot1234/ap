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
// 12 standard Thai dorm tenancy clauses. Operators get a working contract
// out of the box; admin can override via system_settings or simply append
// custom clauses. Each clause has an `id` so admin diffing custom vs default
// stays meaningful even after inserts/reorders. The variables in {{...}}
// are interpolated against the contract context (rent, deposit, room, etc).
const DEFAULT_CLAUSES = Object.freeze([
  {
    id: 'rental',
    title: 'การเช่า',
    body: 'ผู้เช่าตกลงเช่าห้องพักเลขที่ {{roomId}} ของ {{lessorName}} ตามที่ปรากฏในสัญญานี้ และยินยอมปฏิบัติตามข้อบังคับของหอพักทุกประการ',
  },
  {
    id: 'rent_payment',
    title: 'ค่าเช่าและกำหนดชำระ',
    body: 'ผู้เช่าจะชำระค่าเช่ารายเดือน ๆ ละ {{monthlyRent}} บาท ภายในวันที่ {{dueDay}} ของทุกเดือน หากชำระล่าช้าจะคิดค่าปรับ {{lateFeeRate}}% ต่อเดือนของยอดค้างชำระ และต้องชำระค่าน้ำ-ค่าไฟตามมิเตอร์จริง',
  },
  {
    id: 'deposit',
    title: 'เงินมัดจำ',
    body: 'ผู้เช่าวางเงินมัดจำจำนวน {{depositAmount}} บาท เพื่อเป็นหลักประกันความเสียหายของห้องพักและการชำระเงินตามสัญญา ผู้ให้เช่าจะคืนเงินมัดจำภายใน 30 วันหลังคืนห้องและไม่มีหนี้สินค้างชำระ โดยอาจหักค่าซ่อมแซมความเสียหายตามจริง',
  },
  {
    id: 'term',
    title: 'ระยะเวลาเช่า',
    body: 'สัญญานี้มีผลตั้งแต่วันที่ {{startDate}} {{endDateClause}} หากผู้เช่าประสงค์จะต่อสัญญา ต้องแจ้งให้ผู้ให้เช่าทราบล่วงหน้าไม่น้อยกว่า 30 วันก่อนสิ้นสุดสัญญา',
  },
  {
    id: 'utilities',
    title: 'ค่าสาธารณูปโภค',
    body: 'ค่าน้ำ-ค่าไฟ คิดตามมิเตอร์ที่อ่านจริงในแต่ละรอบบิล อัตราตามที่ผู้ให้เช่าประกาศ ผู้เช่ามีหน้าที่ชำระร่วมกับค่าเช่าตามรอบบิลรายเดือน',
  },
  {
    id: 'usage',
    title: 'การใช้ห้องพัก',
    body: 'ผู้เช่าใช้ห้องพักเพื่ออยู่อาศัยเท่านั้น ห้ามใช้ประกอบกิจการที่ผิดกฎหมาย ห้ามดัดแปลงโครงสร้างห้อง ห้ามสูบบุหรี่ภายในห้อง และห้ามเลี้ยงสัตว์ทุกชนิด เว้นแต่ได้รับอนุญาตเป็นลายลักษณ์อักษรจากผู้ให้เช่า',
  },
  {
    id: 'maintenance',
    title: 'การบำรุงรักษา',
    body: 'ผู้เช่าต้องดูแลรักษาห้องพักและทรัพย์สินภายในห้องให้อยู่ในสภาพดี ความเสียหายที่เกิดจากการใช้งานปกติ ผู้ให้เช่ารับผิดชอบ ความเสียหายจากผู้เช่าหรือบุคคลในความรับผิดชอบของผู้เช่า ผู้เช่าต้องชดใช้ตามจริง',
  },
  {
    id: 'noise',
    title: 'ความสงบและเสียงรบกวน',
    body: 'ผู้เช่าต้องไม่ส่งเสียงดังรบกวนผู้พักอาศัยรายอื่นโดยเฉพาะระหว่างเวลา 22.00 น. ถึง 06.00 น. การจัดงานเลี้ยงหรือกิจกรรมที่อาจรบกวนต้องได้รับอนุญาตล่วงหน้า',
  },
  {
    id: 'visitors',
    title: 'ผู้มาเยี่ยม',
    body: 'ผู้เช่าสามารถรับผู้มาเยี่ยมได้ในเวลาที่กำหนด แต่ผู้มาเยี่ยมต้องไม่พักค้างคืนเกิน 3 คืนต่อเดือนโดยไม่แจ้งผู้ให้เช่า ผู้เช่าต้องรับผิดชอบต่อพฤติกรรมของผู้มาเยี่ยมทุกประการ',
  },
  {
    id: 'termination',
    title: 'การยกเลิกสัญญาก่อนกำหนด',
    body: 'หากฝ่ายใดประสงค์ยกเลิกสัญญาก่อนสิ้นสุด ต้องแจ้งล่วงหน้าไม่น้อยกว่า 30 วัน หากผู้เช่ายกเลิกโดยไม่แจ้งล่วงหน้า ผู้ให้เช่าอาจริบเงินมัดจำตามสมควร ผู้ให้เช่าสามารถยกเลิกได้ทันทีหากผู้เช่าผิดสัญญาหรือค้างชำระเกิน 30 วัน',
  },
  {
    id: 'return',
    title: 'การคืนห้องพัก',
    body: 'เมื่อสิ้นสุดสัญญา ผู้เช่าต้องคืนห้องพักในสภาพดี ทำความสะอาด ไม่มีของส่วนตัวค้างไว้ และส่งคืนกุญแจ/บัตรเข้าออกแก่ผู้ให้เช่า ค่าเสียหายและค่าทำความสะอาดจะถูกหักจากเงินมัดจำตามจริง',
  },
  {
    id: 'misc',
    title: 'ข้อตกลงเพิ่มเติม',
    body: 'หากเกิดข้อพิพาทใด ๆ เกี่ยวกับสัญญานี้ คู่สัญญาตกลงเจรจาด้วยความสุจริตก่อน หากตกลงไม่ได้ให้ใช้กฎหมายไทยและศาลที่มีเขตอำนาจในประเทศไทยเป็นผู้พิจารณา ผู้เช่ายืนยันว่าได้อ่านและเข้าใจข้อความในสัญญานี้ครบถ้วนแล้ว',
  },
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
    if (doc.y + neededHeight > CONTENT_BOTTOM) {
      doc.addPage();
      doc.y = CONTENT_TOP;
    }
  }
  function hr(yOpt) {
    const y = yOpt != null ? yOpt : doc.y;
    doc.moveTo(MARGIN, y).lineTo(PAGE_W - MARGIN, y)
      .lineWidth(0.5).strokeColor(C.border).stroke();
  }

  // =============== Page 1 — Header + parties + property =================

  // Header band
  doc.fillColor(C.ink).font(FONT_B).fontSize(13)
    .text(building?.name || 'บ้านกาญจน์ เรสซิเดนซ์', MARGIN, MARGIN, { width: CONTENT_W });
  doc.font(FONT).fontSize(10).fillColor(C.muted);
  if (building?.address) doc.text(building.address, MARGIN, doc.y + 2, { width: CONTENT_W });
  if (building?.phone) doc.text(`โทร. ${building.phone}`, MARGIN, doc.y + 2, { width: CONTENT_W });
  if (building?.taxId) doc.text(`เลขประจำตัวผู้เสียภาษี ${building.taxId}`, MARGIN, doc.y + 2, { width: CONTENT_W });
  // Optional header note from template — admin can add a tagline,
  // promotional text, or compliance notice (e.g. "เลขทะเบียนหอพัก ...").
  if (sections.headerNote) {
    doc.font(FONT).fontSize(9).fillColor(C.accent)
      .text(sections.headerNote, MARGIN, doc.y + 2, { width: CONTENT_W });
  }
  hr(doc.y + 8);
  doc.y = doc.y + 16;

  // Title
  doc.font(FONT_B).fontSize(18).fillColor(C.ink)
    .text('สัญญาเช่าห้องพัก', MARGIN, doc.y, { width: CONTENT_W, align: 'center' });
  doc.y += 8;

  // Contract meta line
  doc.font(FONT).fontSize(10).fillColor(C.ink2)
    .text(
      `เลขที่สัญญา: ${contract.contractNo || '—'}    `
      + `วันที่ทำสัญญา: ${fmtThaiDate(contract.signedAt || new Date())}`,
      MARGIN, doc.y, { width: CONTENT_W, align: 'center' }
    );
  doc.y += 16;

  // Lead paragraph: "วันที่ ... ระหว่าง ... กับ ..."
  const lessorName = building?.ownerName || building?.name || '—';
  const tenantName = tenant?.fullName || '—';
  doc.font(FONT).fontSize(11).fillColor(C.ink)
    .text(
      `สัญญาฉบับนี้ทำขึ้นเมื่อ ${fmtThaiDate(contract.signedAt || new Date())} `
      + `ระหว่าง ${lessorName} (ซึ่งต่อไปในสัญญานี้เรียกว่า "ผู้ให้เช่า") `
      + `กับ ${tenantName} (ซึ่งต่อไปในสัญญานี้เรียกว่า "ผู้เช่า") `
      + `ทั้งสองฝ่ายตกลงทำสัญญาเช่าห้องพักดังนี้`,
      MARGIN, doc.y,
      { width: CONTENT_W, align: 'justify', lineGap: 2 }
    );
  doc.y += 12;

  // === Parties block (two-column) ===
  // Defensive layout: if either column overruns, we advance doc.y by the
  // taller column so the next section starts below both blocks.
  const partyColW = (CONTENT_W - 16) / 2;
  const partyTopY = doc.y;
  // Left: ผู้ให้เช่า
  doc.font(FONT_B).fontSize(11).fillColor(C.ink)
    .text('ผู้ให้เช่า', MARGIN, partyTopY);
  doc.font(FONT).fontSize(10).fillColor(C.ink2);
  doc.text(`ชื่อ: ${lessorName}`, MARGIN, doc.y + 2, { width: partyColW });
  if (building?.address) doc.text(`ที่อยู่: ${building.address}`, MARGIN, doc.y + 2, { width: partyColW });
  if (building?.phone) doc.text(`โทรศัพท์: ${building.phone}`, MARGIN, doc.y + 2, { width: partyColW });
  if (building?.taxId) doc.text(`เลขประจำตัวผู้เสียภาษี: ${building.taxId}`, MARGIN, doc.y + 2, { width: partyColW });
  const leftEndY = doc.y;

  // Right: ผู้เช่า
  doc.font(FONT_B).fontSize(11).fillColor(C.ink)
    .text('ผู้เช่า', MARGIN + partyColW + 16, partyTopY);
  doc.font(FONT).fontSize(10).fillColor(C.ink2);
  let ry = partyTopY + doc.currentLineHeight() + 2;
  doc.text(`ชื่อ: ${tenantName}`, MARGIN + partyColW + 16, ry, { width: partyColW });
  ry = doc.y + 2;
  if (tenant?.citizenIdMasked) {
    doc.text(`เลขบัตร ปชช.: ${tenant.citizenIdMasked}`, MARGIN + partyColW + 16, ry, { width: partyColW });
    ry = doc.y + 2;
  }
  if (tenant?.phone) {
    doc.text(`โทรศัพท์: ${tenant.phone}`, MARGIN + partyColW + 16, ry, { width: partyColW });
    ry = doc.y + 2;
  }
  if (tenant?.address) {
    doc.text(`ที่อยู่: ${tenant.address}`, MARGIN + partyColW + 16, ry, { width: partyColW });
    ry = doc.y + 2;
  }
  if (sections.showEmergencyContact && tenant?.emergencyContactName) {
    doc.text(
      `ติดต่อฉุกเฉิน: ${tenant.emergencyContactName}`
        + (tenant.emergencyContactPhone ? ` · ${tenant.emergencyContactPhone}` : '')
        + (tenant.emergencyContactRelation ? ` (${tenant.emergencyContactRelation})` : ''),
      MARGIN + partyColW + 16, ry, { width: partyColW }
    );
    ry = doc.y + 2;
  }
  const rightEndY = doc.y;

  doc.y = Math.max(leftEndY, rightEndY) + 12;
  ensureRoom(120);

  // === Property + financial summary ===
  // Sections can be hidden via template — admin renting commercial space
  // might want to skip the rich amenity list, e.g.
  if (sections.showPropertyDetails || sections.showFinancialTable) {
    const tableTop = doc.y;
    doc.font(FONT_B).fontSize(11).fillColor(C.ink)
      .text('รายละเอียดห้องพักและการเงิน', MARGIN, tableTop);
    doc.y = tableTop + 18;

    const rowH = 22;
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

    for (const [k, v] of rows) {
      ensureRoom(rowH);
      doc.font(FONT).fontSize(10).fillColor(C.muted)
        .text(k, MARGIN, doc.y + 6, { width: labelW });
      doc.font(FONT).fontSize(10).fillColor(C.ink)
        .text(v, MARGIN + labelW, doc.y - doc.currentLineHeight(), { width: valW });
      hr(doc.y + 4);
      doc.y += 6;
    }
    doc.y += 8;
  }

  // =============== Clauses (numbered, auto page break) ==================
  ensureRoom(40);
  doc.font(FONT_B).fontSize(13).fillColor(C.ink)
    .text('ข้อตกลงและกฎข้อบังคับ', MARGIN, doc.y, { width: CONTENT_W });
  doc.y += 8;

  // Resolve clause list — defaults vs custom mode (admin choice).
  const clauses = resolveClauses(opts.termsTemplate);
  // Interpolation context — built-in keys plus any custom variables the
  // template defined. Built-ins always win on key collisions so admin
  // can't accidentally shadow {{monthlyRent}} with a stale literal.
  const ctx = {
    // Custom variables first (so they're overridable by the built-ins).
    ...tmplVars,
    // Built-in context.
    roomId: room?.id || '—',
    roomType: room?.type || '—',
    roomFloor: room?.floor != null ? String(room.floor) : '—',
    roomSize: room?.size != null ? String(room.size) : '—',
    lessorName,
    tenantName,
    monthlyRent: fmtCurrency(contract.monthlyRent),
    depositAmount: fmtCurrency(contract.deposit),
    dueDay: String(opts.dueDay || 15),
    lateFeeRate: String(opts.lateFeeRate ?? 1.5),
    startDate: fmtThaiDate(contract.startDate),
    endDate: contract.endDate ? fmtThaiDate(contract.endDate) : '—',
    endDateClause: contract.endDate
      ? `และมีกำหนดสิ้นสุดในวันที่ ${fmtThaiDate(contract.endDate)}`
      : 'และเป็นสัญญาต่อเนื่องรายเดือนจนกว่าจะมีการบอกเลิก',
  };

  for (let i = 0; i < clauses.length; i++) {
    const cl = clauses[i] || {};
    const title = String(cl.title || '').slice(0, 200);
    const body = interpolate(cl.body, ctx).slice(0, 4000);
    // Estimate: title 16pt + body lines (10pt each).
    const bodyLines = Math.ceil(body.length / 100) + 1;
    const estimate = 18 + bodyLines * 14;
    ensureRoom(estimate + 8);
    doc.font(FONT_B).fontSize(11).fillColor(C.ink)
      .text(`ข้อ ${thaiNumber(i + 1)}. ${title}`, MARGIN, doc.y,
            { width: CONTENT_W });
    doc.y += 2;
    doc.font(FONT).fontSize(10).fillColor(C.ink2)
      .text(body, MARGIN + 16, doc.y,
            { width: CONTENT_W - 16, align: 'justify', lineGap: 2 });
    doc.y += 8;
  }

  // =============== Signature block ======================================
  // Reserve enough room for the WHOLE block — acknowledgment line (~20pt)
  // + signature boxes (sigBoxH+labels = ~120pt) + witness block when
  // enabled (~80pt). 240pt covers worst case so we never split across
  // pages mid-witness — that's the legal ambiguity the comment guards.
  const SIG_BLOCK_H = sections.showWitnesses ? 240 : 160;
  ensureRoom(SIG_BLOCK_H);

  // Acknowledgement line above signatures — admin can override the wording
  // via template.sections.acknowledgmentText (e.g. omit "ต่อหน้าพยาน" when
  // not using witnesses).
  doc.y += 8;
  doc.font(FONT).fontSize(10).fillColor(C.ink2)
    .text(sections.acknowledgmentText, MARGIN, doc.y,
      { width: CONTENT_W, align: 'center' });
  doc.y += 16;

  // Two signature columns — lessor on the left, lessee on the right.
  const sigColW = (CONTENT_W - 32) / 2;
  const sigTopY = doc.y + 4;
  const sigBoxH = 56;

  function drawSignatureBox(x, y, label, name, signatureBuf, dateLabel) {
    // Box border
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
      .text(label, x, lblY + 28, { width: sigColW, align: 'center' });
    doc.text(dateLabel, x, lblY + 42, { width: sigColW, align: 'center' });
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
    const witnessTopY = sigTopY + sigBoxH + 60;
    doc.y = witnessTopY;
    doc.font(FONT_B).fontSize(10).fillColor(C.ink)
      .text('พยาน', MARGIN, doc.y, { width: CONTENT_W });
    doc.y += 14;
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
};
