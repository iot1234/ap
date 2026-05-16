// services/pdf.js
// Render Thai-language rental/utility bills as PDF using PDFKit.
// Embeds Sarabun TTF for proper Thai glyph rendering and overlays a PromptPay
// QR code so the tenant can scan-to-pay directly from the invoice.

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { renderQrPng } = require('./promptpay');

const FONT_DIR = path.join(__dirname, '..', 'server-assets', 'fonts');
const FONT_REGULAR = path.join(FONT_DIR, 'Sarabun-Regular.ttf');
const FONT_BOLD = path.join(FONT_DIR, 'Sarabun-Bold.ttf');

const C = {
  ink:    '#2c241b',
  ink2:   '#5b4f40',
  muted:  '#8a7d6b',
  border: '#ece4d4',
  accent: '#c46a3e',
  bg:     '#faf6ee',
};

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;
const CONTENT_BOTTOM = PAGE_H - MARGIN - 34;
const FOOTER_Y = PAGE_H - MARGIN - 14;

const THAI_MONTHS = [
  'มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
  'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม',
];

function fmtThaiDate(d = new Date()) {
  return `${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${d.getFullYear() + 543}`;
}

function fmtCurrency(n) {
  return Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Render a bill to PDF and pipe to a writable stream (typically res).
 *
 * @param {object} bill - Bill data.
 * @param {string} bill.billNo - Bill number, e.g. "INV-2025-12-201".
 * @param {string} bill.roomId - e.g. "201".
 * @param {string} bill.tenantName - Tenant full name.
 * @param {string} [bill.tenantPhone] - Tenant phone.
 * @param {string} [bill.period] - "ธันวาคม 2568" or any human-readable period.
 * @param {string} [bill.dueDate] - Due date as 'YYYY-MM-DD' or formatted string.
 * @param {Array<{label:string, qty?:string, amount:number}>} bill.items
 * @param {number} bill.total - Total amount in THB.
 * @param {object} [bill.building] - { name, address, phone }.
 * @param {string} [bill.promptpayTarget] - phone/citizen-id for QR. If omitted, no QR.
 * @param {string} [bill.promptpayName] - display name shown above the QR.
 * @param {object} [bill.bankInfo] - { bank, account, name } for bank-transfer card.
 * @param {Array<{key:string,label:string,enabled:boolean}>} [bill.paymentMethods]
 * @param {WritableStream} stream - Where to pipe the PDF.
 * @returns {Promise<void>} resolves when stream finishes.
 */
async function renderBillPdf(bill, stream) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: {
      Title: `Bill ${bill.billNo || ''}`,
      Author: bill.building?.name || 'บ้านกาญจน์ เรสซิเดนซ์',
    },
  });

  // Register Thai fonts
  if (fs.existsSync(FONT_REGULAR)) doc.registerFont('th', FONT_REGULAR);
  if (fs.existsSync(FONT_BOLD)) doc.registerFont('th-bold', FONT_BOLD);
  doc.font('th');

  doc.pipe(stream);

  const buildingName = bill.building?.name || 'บ้านกาญจน์ เรสซิเดนซ์';
  const buildingAddr = bill.building?.address || '';
  const buildingPhone = bill.building?.phone || '';
  const isPaid = String(bill.status || '').toLowerCase() === 'paid';
  const colX = { label: MARGIN + 12, qty: 360, amount: 460 };
  const colW = { label: 286, qty: 88, amount: 88 };
  const tableW = CONTENT_W;
  const items = Array.isArray(bill.items) ? bill.items : [];
  const qrAmount = Number(bill.total);
  let qrPng = null;
  if (bill.promptpayTarget && Number.isFinite(qrAmount) && qrAmount > 0) {
    try {
      qrPng = await renderQrPng(bill.promptpayTarget, qrAmount, { width: 360 });
    } catch (err) {
      console.error('[pdf] QR render failed:', err.message);
    }
  } else if (bill.promptpayTarget) {
    console.warn('[pdf] QR skipped: bill total must be greater than 0');
  }

  function drawHeader() {
    doc
      .fillColor(C.ink)
      .font('th-bold').fontSize(20).text(buildingName, MARGIN, MARGIN, { width: 290 })
      .font('th').fontSize(10).fillColor(C.muted)
      .text(buildingAddr || '', MARGIN, doc.y + 2, { width: 290 })
      .text(buildingPhone ? `โทร. ${buildingPhone}` : '', MARGIN, doc.y + 2, { width: 290 });

    doc
      .fillColor(C.ink).font('th-bold').fontSize(16)
      .text(isPaid ? 'ใบเสร็จรับเงิน' : 'ใบแจ้งหนี้', 360, MARGIN, { width: 187, align: 'right' })
      .font('th').fontSize(10).fillColor(C.ink2)
      .text(`เลขที่: ${bill.billNo || '—'}`, 360, doc.y + 4, { width: 187, align: 'right' })
      .text(`วันที่ออก: ${fmtThaiDate(new Date())}`, 360, doc.y + 2, { width: 187, align: 'right' });
    if (isPaid && bill.paidAt) {
      doc.font('th').fontSize(10).fillColor('#2f8f5b')
        .text(`ชำระเมื่อ: ${fmtThaiDate(new Date(bill.paidAt))}`, 360, doc.y + 2,
          { width: 187, align: 'right' });
    }

    doc
      .moveTo(MARGIN, 130).lineTo(PAGE_W - MARGIN, 130)
      .lineWidth(1).strokeColor(C.border).stroke();
  }

  function drawTenantBlock() {
    const y = 148;
    doc
      .fontSize(10).fillColor(C.muted).text('เรียกเก็บจาก', MARGIN, y)
      .font('th-bold').fontSize(12).fillColor(C.ink).text(bill.tenantName || '—', MARGIN, y + 14, { width: 290 });
    if (bill.tenantPhone) {
      doc.font('th').fontSize(10).fillColor(C.ink2)
        .text(`โทร. ${bill.tenantPhone}`, MARGIN, doc.y + 2, { width: 290 });
    }

    doc
      .font('th').fontSize(10).fillColor(C.muted)
      .text('ห้องเลขที่', 360, y, { width: 187, align: 'right' })
      .font('th-bold').fontSize(12).fillColor(C.ink)
      .text(bill.roomId || '—', 360, y + 14, { width: 187, align: 'right' });
    if (bill.period) {
      doc.font('th').fontSize(10).fillColor(C.ink2)
        .text(`รอบบิล ${bill.period}`, 360, doc.y + 2, { width: 187, align: 'right' });
    }
  }

  function drawContinuationHeader() {
    doc.font('th-bold').fontSize(13).fillColor(C.ink)
      .text(isPaid ? 'ใบเสร็จรับเงิน' : 'ใบแจ้งหนี้', MARGIN, MARGIN, { width: 240 });
    doc.font('th').fontSize(9).fillColor(C.muted)
      .text(`เลขที่ ${bill.billNo || '—'} · ห้อง ${bill.roomId || '—'}`, MARGIN, doc.y + 2, { width: 300 });
    doc.moveTo(MARGIN, 86).lineTo(PAGE_W - MARGIN, 86)
      .lineWidth(0.5).strokeColor(C.border).stroke();
    return 104;
  }

  function drawTableHeader(y) {
    doc.roundedRect(MARGIN, y, tableW, 24, 6).fill(C.bg);
    doc.fillColor(C.ink2).font('th-bold').fontSize(10)
      .text('รายการ', colX.label, y + 7, { width: colW.label })
      .text('จำนวน', colX.qty, y + 7, { width: colW.qty, align: 'center' })
      .text('จำนวนเงิน (บาท)', colX.amount, y + 7, { width: colW.amount, align: 'right' });
    return y + 30;
  }

  let y = 220;
  drawHeader();
  drawTenantBlock();
  y = drawTableHeader(y);

  function addPageWithTableHeader() {
    doc.addPage();
    y = drawContinuationHeader();
    y = drawTableHeader(y);
  }

  function ensureRoom(height, withTableHeader = false) {
    if (y + height <= CONTENT_BOTTOM) return;
    doc.addPage();
    y = drawContinuationHeader();
    if (withTableHeader) y = drawTableHeader(y);
  }

  for (const it of items) {
    doc.font('th').fontSize(10);
    const label = String(it.label || '');
    const qty = String(it.qty || '');
    const amount = fmtCurrency(it.amount);
    const labelH = doc.heightOfString(label || ' ', { width: colW.label });
    const qtyH = doc.heightOfString(qty || ' ', { width: colW.qty, align: 'center' });
    const amountH = doc.heightOfString(amount, { width: colW.amount, align: 'right' });
    const rowH = Math.max(22, labelH, qtyH, amountH) + 8;
    if (y + rowH > CONTENT_BOTTOM) addPageWithTableHeader();
    doc.font('th').fontSize(10).fillColor(C.ink)
      .text(label, colX.label, y + 4, { width: colW.label })
      .text(qty, colX.qty, y + 4, { width: colW.qty, align: 'center' })
      .text(amount, colX.amount, y + 4, { width: colW.amount, align: 'right' });
    y += rowH;
  }

  ensureRoom(68);
  y += 6;
  doc.moveTo(MARGIN, y).lineTo(PAGE_W - MARGIN, y).lineWidth(0.5).strokeColor(C.border).stroke();
  y += 12;
  doc.font('th-bold').fontSize(13).fillColor(C.ink)
    .text('ยอดรวมทั้งสิ้น', colX.label, y, { width: colW.label })
    .text(`฿ ${fmtCurrency(bill.total)}`, colX.amount, y, { width: colW.amount, align: 'right' });
  y += 26;
  if (bill.dueDate) {
    doc.font('th').fontSize(10).fillColor(C.muted)
      .text(`กำหนดชำระ: ${bill.dueDate}`, colX.label, y, { width: 300 });
    y += 18;
  }

  const extraMethods = (bill.paymentMethods || [])
    .filter((m) => m && m.enabled && m.key !== 'promptpay' && m.key !== 'bank');
  const hasBank = !!(bill.bankInfo && bill.bankInfo.account);
  const qrCardH = qrPng ? 192 : 0;
  const bankCardH = hasBank ? 76 : 0;
  const extraCardH = extraMethods.length ? 22 + extraMethods.length * 13 : 0;
  const rightH = [bankCardH, extraCardH].filter(Boolean).reduce((s, h) => s + h + (s ? 8 : 0), 0);
  const paymentH = Math.max(qrCardH, rightH);
  if (paymentH > 0) {
    ensureRoom(paymentH + 26);
    y += 12;
    const payTop = y;
    const leftX = MARGIN;
    const leftW = qrPng ? 238 : 0;
    const rightX = qrPng ? MARGIN + leftW + 16 : MARGIN;
    const rightW = qrPng ? CONTENT_W - leftW - 16 : CONTENT_W;

    if (qrPng) {
      const qrSize = 118;
      doc.roundedRect(leftX, payTop, leftW, qrCardH, 10).fill(C.bg);
      doc.fillColor(C.ink2).font('th-bold').fontSize(10)
        .text('สแกนเพื่อชำระ (PromptPay)', leftX + 10, payTop + 10, { width: leftW - 20, align: 'center' });
      doc.image(qrPng, leftX + (leftW - qrSize) / 2, payTop + 32, { width: qrSize, height: qrSize });
      doc.font('th').fontSize(9).fillColor(C.muted)
        .text(
          bill.promptpayName ? `${bill.promptpayName} · อ้างอิง ${bill.billNo || '—'}` : `อ้างอิง: ${bill.billNo || '—'}`,
          leftX + 10, payTop + 156,
          { width: leftW - 20, align: 'center' }
        );
    }

    let rightY = payTop;
    if (hasBank) {
      doc.roundedRect(rightX, rightY, rightW, bankCardH, 10).fill(C.bg);
      doc.fillColor(C.ink2).font('th-bold').fontSize(10)
        .text('โอนผ่านธนาคาร', rightX + 12, rightY + 8, { width: rightW - 24 });
      doc.font('th').fontSize(10).fillColor(C.ink)
        .text(bill.bankInfo.bank || '—', rightX + 12, rightY + 24, { width: rightW - 24 });
      doc.font('th-bold').fontSize(11).fillColor(C.ink)
        .text(bill.bankInfo.account, rightX + 12, rightY + 40, { width: rightW - 24 });
      if (bill.bankInfo.name) {
        doc.font('th').fontSize(9).fillColor(C.muted)
          .text(bill.bankInfo.name, rightX + 12, rightY + 58, { width: rightW - 24 });
      }
      rightY += bankCardH + 8;
    }

    if (extraMethods.length > 0) {
      doc.roundedRect(rightX, rightY, rightW, extraCardH, 10).fill(C.bg);
      doc.fillColor(C.ink2).font('th-bold').fontSize(10)
        .text('ช่องทางที่รับชำระอื่น', rightX + 12, rightY + 6, { width: rightW - 24 });
      let lineY = rightY + 22;
      doc.font('th').fontSize(9).fillColor(C.ink2);
      for (const m of extraMethods) {
        doc.text(`• ${m.label}`, rightX + 12, lineY, { width: rightW - 24 });
        lineY += 13;
      }
    }
    y += paymentH + 8;
  }

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    if (isPaid) {
      doc.save();
      doc.opacity(0.13);
      doc.rotate(-22, { origin: [PAGE_W / 2, 400] });
      doc.font('th-bold').fontSize(92).fillColor('#2f8f5b')
        .text('ชำระแล้ว', 0, 360, { width: PAGE_W, align: 'center' });
      doc.restore();
    }
    doc.font('th').fontSize(9).fillColor(C.muted)
      .text(
        isPaid
          ? `บิลนี้ชำระเรียบร้อยแล้ว — ${bill.paidAt ? `เมื่อ ${fmtThaiDate(new Date(bill.paidAt))}` : ''} ขอบคุณที่ใช้บริการ`
          : 'กรุณาชำระเงินภายในกำหนด หากมีข้อสงสัยติดต่อเจ้าหน้าที่',
        MARGIN, FOOTER_Y,
        { width: CONTENT_W - 80, align: 'left' }
      )
      .text(`หน้า ${i + 1} จาก ${range.count}`, PAGE_W - MARGIN - 80, FOOTER_Y, { width: 80, align: 'right' });
  }

  doc.end();

  // Wait for pipe to finish
  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

module.exports = { renderBillPdf };
