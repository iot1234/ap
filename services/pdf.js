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
  // Guard invalid dates (e.g. an unparseable bill.paidAt from the client-
  // supplied render body) — without this, THAI_MONTHS[NaN] prints the literal
  // "NaN undefined NaN" on a customer-facing receipt. Mirrors contractPdf.
  if (!(d instanceof Date) || !Number.isFinite(d.getTime())) return '—';
  return `${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${d.getFullYear() + 543}`;
}

function fmtCurrency(n) {
  // Guard non-finite (Infinity/NaN/1e21) so a bad client-supplied amount can't
  // print "∞" or a 22-digit string on the receipt. Mirrors contractPdf.
  if (!Number.isFinite(Number(n))) return '0.00';
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
      Author: bill.building?.name || 'ที่พักของคุณ',
    },
  });

  // Register Thai fonts
  if (fs.existsSync(FONT_REGULAR)) doc.registerFont('th', FONT_REGULAR);
  if (fs.existsSync(FONT_BOLD)) doc.registerFont('th-bold', FONT_BOLD);
  doc.font('th');

  doc.pipe(stream);

  const buildingName = bill.building?.name || 'ที่พักของคุณ';
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

  function measuredTextHeight(fontName, fontSize, text, width, options = {}) {
    doc.font(fontName).fontSize(fontSize);
    return doc.heightOfString(String(text || ' '), { width, ...options });
  }

  function cappedTextHeight(fontName, fontSize, text, width, maxHeight, options = {}) {
    return Math.min(measuredTextHeight(fontName, fontSize, text, width, options), maxHeight);
  }

  function truncateText(value, maxChars) {
    const text = String(value || '');
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  }

  function drawHeader() {
    const headerY = MARGIN;
    const headerH = 108;
    const leftW = 290;
    const rightX = 360;
    const rightW = 187;

    doc
      .fillColor(C.ink)
      .font('th-bold').fontSize(20)
      .text(truncateText(buildingName, 72), MARGIN, headerY, { width: leftW, height: 46, ellipsis: true })
      .font('th').fontSize(10).fillColor(C.muted)
      .text(truncateText(buildingAddr || '', 90), MARGIN, headerY + 52, { width: leftW, height: 28, ellipsis: true })
      .text(buildingPhone ? truncateText(`โทร. ${buildingPhone}`, 54) : '', MARGIN, headerY + 84, { width: leftW, height: 16, ellipsis: true });

    doc
      .fillColor(C.ink).font('th-bold').fontSize(16)
      .text(isPaid ? 'ใบเสร็จรับเงิน' : 'ใบแจ้งหนี้', rightX, headerY, { width: rightW, height: 24, align: 'right', ellipsis: true })
      .font('th').fontSize(10).fillColor(C.ink2)
      .text(truncateText(`เลขที่: ${bill.billNo || '—'}`, 52), rightX, headerY + 32, { width: rightW, height: 28, align: 'right', ellipsis: true })
      .text(`วันที่ออก: ${fmtThaiDate(new Date())}`, rightX, headerY + 64, { width: rightW, height: 16, align: 'right', ellipsis: true });
    if (isPaid && bill.paidAt) {
      doc.font('th').fontSize(10).fillColor('#2f8f5b')
        .text(`ชำระเมื่อ: ${fmtThaiDate(new Date(bill.paidAt))}`, rightX, headerY + 84,
          { width: rightW, height: 18, align: 'right', ellipsis: true });
    }

    const lineY = headerY + headerH;
    doc
      .moveTo(MARGIN, lineY).lineTo(PAGE_W - MARGIN, lineY)
      .lineWidth(1).strokeColor(C.border).stroke();
    return lineY + 16;
  }

  function drawTenantBlock(startY) {
    const pad = 10;
    const leftW = 290;
    const rightX = 360;
    const rightW = 187;
    const tenantNameText = truncateText(bill.tenantName || '—', 72);
    const tenantNameH = cappedTextHeight('th-bold', 12, tenantNameText, leftW, 34);
    const phoneText = bill.tenantPhone ? truncateText(`โทร. ${bill.tenantPhone}`, 70) : '';
    const phoneH = phoneText ? cappedTextHeight('th', 10, phoneText, leftW, 28) : 0;
    const roomText = truncateText(bill.roomId || '—', 58);
    const roomH = cappedTextHeight('th-bold', 12, roomText, rightW, 34, { align: 'right' });
    const periodText = bill.period ? truncateText(`รอบบิล ${bill.period}`, 66) : '';
    const periodH = periodText ? cappedTextHeight('th', 10, periodText, rightW, 30, { align: 'right' }) : 0;
    const leftH = 12 + 4 + tenantNameH + (phoneH ? 3 + phoneH : 0);
    const rightH = 12 + 4 + roomH + (periodH ? 3 + periodH : 0);
    const tenantBlockH = Math.max(66, leftH, rightH) + pad * 2;
    const y = startY + pad;

    doc.roundedRect(MARGIN, startY, CONTENT_W, tenantBlockH, 7).fill('#fffdf8');
    doc.roundedRect(MARGIN, startY, CONTENT_W, tenantBlockH, 7)
      .lineWidth(0.5).strokeColor(C.border).stroke();
    doc
      .fontSize(10).fillColor(C.muted).text('เรียกเก็บจาก', MARGIN, y)
      .font('th-bold').fontSize(12).fillColor(C.ink)
      .text(tenantNameText, MARGIN, y + 16, { width: leftW, height: tenantNameH, ellipsis: true });
    if (phoneText) {
      doc.font('th').fontSize(10).fillColor(C.ink2)
        .text(phoneText, MARGIN, y + 16 + tenantNameH + 3, { width: leftW, height: phoneH, ellipsis: true });
    }

    doc
      .font('th').fontSize(10).fillColor(C.muted)
      .text('ห้องเลขที่', rightX, y, { width: rightW, align: 'right' })
      .font('th-bold').fontSize(12).fillColor(C.ink)
      .text(roomText, rightX, y + 16, { width: rightW, height: roomH, align: 'right', ellipsis: true });
    if (periodText) {
      doc.font('th').fontSize(10).fillColor(C.ink2)
        .text(periodText, rightX, y + 16 + roomH + 3, { width: rightW, height: periodH, align: 'right', ellipsis: true });
    }
    return startY + tenantBlockH + 18;
  }

  function drawContinuationHeader() {
    doc.font('th-bold').fontSize(13).fillColor(C.ink)
      .text(isPaid ? 'ใบเสร็จรับเงิน' : 'ใบแจ้งหนี้', MARGIN, MARGIN, { width: 240 });
    const continuationText = truncateText(`เลขที่ ${bill.billNo || '—'} · ห้อง ${bill.roomId || '—'}`, 80);
    doc.font('th').fontSize(9).fillColor(C.muted)
      .text(continuationText, MARGIN, doc.y + 2, { width: 300, height: 24, ellipsis: true });
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

  let y = drawHeader();
  y = drawTenantBlock(y);
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
    const label = truncateText(it.label || '', 84);
    const detail = truncateText(it.detail || '', 100);
    const qty = truncateText(it.qty || '', 44);
    const amount = fmtCurrency(it.amount);
    const labelH = cappedTextHeight('th', 10, label || ' ', colW.label, 36);
    const detailH = detail ? cappedTextHeight('th', 8.5, detail, colW.label, 30) : 0;
    const qtyH = cappedTextHeight('th', 10, qty || ' ', colW.qty, 30, { align: 'center' });
    const amountH = cappedTextHeight('th', 10, amount, colW.amount, 18, { align: 'right' });
    const labelBlockH = labelH + (detail ? detailH + 2 : 0);
    const rowH = Math.max(22, labelBlockH, qtyH, amountH) + 8;
    if (y + rowH > CONTENT_BOTTOM) addPageWithTableHeader();
    doc.font('th').fontSize(10).fillColor(C.ink)
      .text(label, colX.label, y + 4, { width: colW.label, height: labelH, ellipsis: true });
    if (detail) {
      doc.font('th').fontSize(8.5).fillColor(C.muted)
        .text(detail, colX.label, y + 4 + labelH + 2, { width: colW.label, height: detailH, ellipsis: true });
    }
    doc.font('th').fontSize(10).fillColor(C.ink)
      .text(qty, colX.qty, y + 4, { width: colW.qty, height: qtyH, align: 'center', ellipsis: true })
      .text(amount, colX.amount, y + 4, { width: colW.amount, height: amountH, align: 'right', ellipsis: true });
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
  const paymentRightW = qrPng ? CONTENT_W - 238 - 16 : CONTENT_W;
  const paymentTextW = paymentRightW - 24;
  const bankTitleH = hasBank ? measuredTextHeight('th-bold', 10, 'โอนผ่านธนาคาร', paymentTextW) : 0;
  const bankNameText = hasBank ? truncateText(bill.bankInfo.bank || '—', 92) : '';
  const bankAccountText = hasBank ? truncateText(bill.bankInfo.account, 86) : '';
  const bankOwnerText = hasBank && bill.bankInfo.name ? truncateText(bill.bankInfo.name, 96) : '';
  const bankNameH = hasBank ? cappedTextHeight('th', 10, bankNameText, paymentTextW, 36) : 0;
  const bankAccountH = hasBank ? cappedTextHeight('th-bold', 11, bankAccountText, paymentTextW, 38) : 0;
  const bankOwnerH = bankOwnerText
    ? cappedTextHeight('th', 9, bankOwnerText, paymentTextW, 30)
    : 0;
  const bankCardH = hasBank
    ? Math.max(76, 18 + bankTitleH + 4 + bankNameH + 3 + bankAccountH + (bankOwnerH ? 3 + bankOwnerH : 0) + 10)
    : 0;
  const extraTitleH = extraMethods.length
    ? measuredTextHeight('th-bold', 10, 'ช่องทางที่รับชำระอื่น', paymentTextW)
    : 0;
  const extraMethodHeights = extraMethods.map((m) => (
    cappedTextHeight('th', 9, `• ${truncateText(m.label || '—', 96)}`, paymentTextW, 28, { lineGap: 1 })
  ));
  const extraCardH = extraMethods.length
    ? Math.max(42, 12 + extraTitleH + 4 + extraMethodHeights.reduce((sum, h) => sum + h + 3, 0) + 8)
    : 0;
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
      let bankLineY = doc.y + 4;
      doc.font('th').fontSize(10).fillColor(C.ink)
        .text(bankNameText, rightX + 12, bankLineY, { width: rightW - 24, height: bankNameH, ellipsis: true });
      bankLineY = doc.y + 3;
      doc.font('th-bold').fontSize(11).fillColor(C.ink)
        .text(bankAccountText, rightX + 12, bankLineY, { width: rightW - 24, height: bankAccountH, ellipsis: true });
      if (bankOwnerText) {
        bankLineY = doc.y + 3;
        doc.font('th').fontSize(9).fillColor(C.muted)
          .text(bankOwnerText, rightX + 12, bankLineY, { width: rightW - 24, height: bankOwnerH, ellipsis: true });
      }
      rightY += bankCardH + 8;
    }

    if (extraMethods.length > 0) {
      doc.roundedRect(rightX, rightY, rightW, extraCardH, 10).fill(C.bg);
      doc.fillColor(C.ink2).font('th-bold').fontSize(10)
        .text('ช่องทางที่รับชำระอื่น', rightX + 12, rightY + 6, { width: rightW - 24 });
      let lineY = doc.y + 4;
      doc.font('th').fontSize(9).fillColor(C.ink2);
      extraMethods.forEach((m, idx) => {
        doc.text(`• ${truncateText(m.label || '—', 96)}`, rightX + 12, lineY,
          { width: rightW - 24, height: extraMethodHeights[idx], ellipsis: true, lineGap: 1 });
        lineY = doc.y + 3;
      });
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
