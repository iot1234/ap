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
    margins: { top: 48, bottom: 48, left: 48, right: 48 },
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

  // --- Header band ---
  const buildingName = bill.building?.name || 'บ้านกาญจน์ เรสซิเดนซ์';
  const buildingAddr = bill.building?.address || '';
  const buildingPhone = bill.building?.phone || '';

  doc
    .fillColor(C.ink)
    .font('th-bold').fontSize(20).text(buildingName, 48, 48)
    .font('th').fontSize(10).fillColor(C.muted)
    .text(buildingAddr || '', 48, doc.y + 2)
    .text(buildingPhone ? `โทร. ${buildingPhone}` : '', 48, doc.y + 2);

  // Right side: title + bill no + date
  doc
    .fillColor(C.ink).font('th-bold').fontSize(16)
    .text('ใบแจ้งหนี้', 360, 48, { width: 200, align: 'right' })
    .font('th').fontSize(10).fillColor(C.ink2)
    .text(`เลขที่: ${bill.billNo || '—'}`, 360, doc.y + 4, { width: 200, align: 'right' })
    .text(`วันที่ออก: ${fmtThaiDate(new Date())}`, 360, doc.y + 2, { width: 200, align: 'right' });

  // Divider
  doc
    .moveTo(48, 130).lineTo(547, 130)
    .lineWidth(1).strokeColor(C.border).stroke();

  // --- Tenant block ---
  let y = 148;
  doc
    .fontSize(10).fillColor(C.muted).text('เรียกเก็บจาก', 48, y)
    .font('th-bold').fontSize(12).fillColor(C.ink).text(bill.tenantName || '—', 48, y + 14);
  if (bill.tenantPhone) {
    doc.font('th').fontSize(10).fillColor(C.ink2)
      .text(`โทร. ${bill.tenantPhone}`, 48, doc.y + 2);
  }

  // Right side
  doc
    .font('th').fontSize(10).fillColor(C.muted)
    .text('ห้องเลขที่', 360, y, { width: 200, align: 'right' })
    .font('th-bold').fontSize(12).fillColor(C.ink)
    .text(bill.roomId || '—', 360, y + 14, { width: 200, align: 'right' });
  if (bill.period) {
    doc.font('th').fontSize(10).fillColor(C.ink2)
      .text(`รอบบิล ${bill.period}`, 360, doc.y + 2, { width: 200, align: 'right' });
  }

  // --- Items table ---
  y = 220;
  const rowH = 26;
  const colX = { label: 60, qty: 360, amount: 460 };
  const colW = { label: 290, qty: 90, amount: 90 };

  // Header
  doc
    .roundedRect(48, y, 499, rowH, 6).fill(C.bg);
  doc
    .fillColor(C.ink2).font('th-bold').fontSize(10)
    .text('รายการ', colX.label, y + 8, { width: colW.label })
    .text('จำนวน', colX.qty, y + 8, { width: colW.qty, align: 'center' })
    .text('จำนวนเงิน (บาท)', colX.amount, y + 8, { width: colW.amount, align: 'right' });

  y += rowH + 6;
  doc.font('th').fontSize(11).fillColor(C.ink);

  const items = Array.isArray(bill.items) ? bill.items : [];
  for (const it of items) {
    doc.text(it.label || '', colX.label, y, { width: colW.label });
    doc.text(it.qty || '', colX.qty, y, { width: colW.qty, align: 'center' });
    doc.text(fmtCurrency(it.amount), colX.amount, y, { width: colW.amount, align: 'right' });
    y += 22;
  }

  // Divider before total
  y += 8;
  doc.moveTo(48, y).lineTo(547, y).lineWidth(0.5).strokeColor(C.border).stroke();
  y += 12;

  // Total
  doc.font('th-bold').fontSize(13).fillColor(C.ink)
    .text('ยอดรวมทั้งสิ้น', colX.label, y, { width: colW.label })
    .text(`฿ ${fmtCurrency(bill.total)}`, colX.amount, y, { width: colW.amount, align: 'right' });
  y += 30;

  // Due date
  if (bill.dueDate) {
    doc.font('th').fontSize(10).fillColor(C.muted)
      .text(`กำหนดชำระ: ${bill.dueDate}`, colX.label, y);
    y += 18;
  }

  // --- Payment options block (right column) ---
  // Renders: PromptPay QR card → bank transfer card → other channels list.
  // The block is anchored at y (after the totals) so it scales with item count.
  const payX = 330;
  const payW = 220;
  let payY = y + 24;

  const qrAmount = Number(bill.total);
  if (bill.promptpayTarget && Number.isFinite(qrAmount) && qrAmount > 0) {
    try {
      const qrPng = await renderQrPng(bill.promptpayTarget, qrAmount, { width: 360 });
      const qrSize = 130;
      doc.roundedRect(payX, payY - 12, payW, qrSize + 70, 10).fill(C.bg);
      doc.fillColor(C.ink2).font('th-bold').fontSize(10)
        .text('สแกนเพื่อชำระ (PromptPay)', payX + 10, payY - 4, { width: payW - 20, align: 'center' });
      doc.image(qrPng, payX + (payW - qrSize) / 2, payY + 14, { width: qrSize, height: qrSize });
      doc.font('th').fontSize(9).fillColor(C.muted)
        .text(
          bill.promptpayName ? `${bill.promptpayName} · อ้างอิง ${bill.billNo || '—'}` : `อ้างอิง: ${bill.billNo || '—'}`,
          payX + 10, payY + qrSize + 18,
          { width: payW - 20, align: 'center' }
        );
      payY += qrSize + 80;
    } catch (err) {
      console.error('[pdf] QR render failed:', err.message);
    }
  } else if (bill.promptpayTarget) {
    console.warn('[pdf] QR skipped: bill total must be greater than 0');
  }

  // Bank transfer card
  if (bill.bankInfo && bill.bankInfo.account) {
    const cardH = 76;
    doc.roundedRect(payX, payY, payW, cardH, 10).fill(C.bg);
    doc.fillColor(C.ink2).font('th-bold').fontSize(10)
      .text('โอนผ่านธนาคาร', payX + 12, payY + 8, { width: payW - 24 });
    doc.font('th').fontSize(10).fillColor(C.ink)
      .text(bill.bankInfo.bank || '—', payX + 12, payY + 24, { width: payW - 24 });
    doc.font('th-bold').fontSize(11).fillColor(C.ink)
      .text(bill.bankInfo.account, payX + 12, payY + 40, { width: payW - 24 });
    if (bill.bankInfo.name) {
      doc.font('th').fontSize(9).fillColor(C.muted)
        .text(bill.bankInfo.name, payX + 12, payY + 58, { width: payW - 24 });
    }
    payY += cardH + 8;
  }

  // Additional accepted channels (LINE Pay, TrueMoney, credit card, etc.)
  const extraMethods = (bill.paymentMethods || [])
    .filter((m) => m && m.enabled && m.key !== 'promptpay' && m.key !== 'bank');
  if (extraMethods.length > 0) {
    const cardH = 18 + extraMethods.length * 13;
    doc.roundedRect(payX, payY, payW, cardH, 10).fill(C.bg);
    doc.fillColor(C.ink2).font('th-bold').fontSize(10)
      .text('ช่องทางที่รับชำระอื่น', payX + 12, payY + 6, { width: payW - 24 });
    let lineY = payY + 22;
    doc.font('th').fontSize(9).fillColor(C.ink2);
    for (const m of extraMethods) {
      doc.text(`• ${m.label}`, payX + 12, lineY, { width: payW - 24 });
      lineY += 13;
    }
    payY += cardH + 8;
  }

  // --- Footer ---
  const footerY = 750;
  doc
    .fontSize(9).fillColor(C.muted)
    .text('กรุณาชำระเงินภายในกำหนด หากมีข้อสงสัยติดต่อเจ้าหน้าที่', 48, footerY, {
      width: 499, align: 'center',
    });

  doc.end();

  // Wait for pipe to finish
  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

module.exports = { renderBillPdf };
