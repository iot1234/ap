// LINE Flex messages for bill notifications.
//
// Manual admin sends already enqueue rich payload.messages. This module lets
// queue workers rebuild the same rich QR/bank-transfer payload for older or
// automatic bill notifications that only carry payload.billId.

const billing = require('./billing');
const promptpay = require('./promptpay');
const lineNotify = require('./line');
const lineBinding = require('./lineBinding');
const secrets = require('./secrets');
const billTokens = require('./billTokens');

function publicUrlFromEnv() {
  return (process.env.PUBLIC_URL
    || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
    || '').replace(/\/+$/, '');
}

function buildEffectivePaymentBlock(config) {
  const block = billing.buildPaymentBlock(config || {});
  if (!block.promptpayTarget) {
    const envPp = secrets.get('PROMPTPAY_TARGET');
    if (envPp) {
      block.promptpayTarget = envPp;
      if (!Array.isArray(block.paymentMethods)) block.paymentMethods = [];
      if (!block.paymentMethods.find((m) => m && m.key === 'promptpay')) {
        block.paymentMethods.unshift({ key: 'promptpay', label: 'PromptPay', enabled: true });
      }
    }
  }
  return block;
}

async function loadEffectivePaymentBlock(pool) {
  const { rows } = await pool.query(
    `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
  );
  const config = rows[0]?.value || {};
  return { config, paymentBlock: buildEffectivePaymentBlock(config) };
}

function promptPayQrUsable(paymentBlock, amount) {
  const total = Number(amount);
  if (!Number.isFinite(total) || total <= 0 || total > promptpay.MAX_AMOUNT) return false;
  if (!paymentBlock || !paymentBlock.promptpayTarget) return false;
  try {
    const normalizedPromptPay = promptpay.normaliseTarget(paymentBlock.promptpayTarget);
    return !promptpay.isDemoTarget(normalizedPromptPay);
  } catch {
    return false;
  }
}

function formatDueDate(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return String(value);
  return d.toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });
}

function rowKV(label, value, bold) {
  return {
    type: 'box', layout: 'baseline', spacing: 'sm', contents: [
      { type: 'text', text: label, color: '#8a7d6b', size: 'sm', flex: 2 },
      {
        type: 'text',
        text: String(value || '-'),
        color: bold ? '#c46a3e' : '#2c241b',
        weight: bold ? 'bold' : 'regular',
        size: bold ? 'md' : 'sm',
        flex: 4,
        wrap: true,
      },
    ],
  };
}

function buildBillLineMessages(b, opts = {}) {
  const { publicUrl, billLink, dueDateStr, qrToken, qrVersion, bankInfo, lineCount } = opts;
  const total = Number(b.total) || 0;
  const totalStr = total.toLocaleString('th-TH', { minimumFractionDigits: 2 });
  const billStatus = String(b.status || 'pending').toLowerCase();
  const isPaid = billStatus === 'paid';
  const isPayable = billStatus === 'pending' || billStatus === 'overdue';
  const billStatusLabel = isPaid
    ? 'ชำระแล้ว'
    : (isPayable ? 'ยังไม่ชำระ' : 'ไม่อยู่ในสถานะที่ชำระได้');
  const hasBankInfo = isPayable && !isPaid && !!(bankInfo && bankInfo.account);
  const qrCacheVersion = qrVersion || `${billStatus}-${Date.now()}`;
  const qrUrl = isPayable && publicUrl && qrToken
    ? `${publicUrl}/p/bill-qr/${encodeURIComponent(b.id)}?t=${encodeURIComponent(qrToken)}&v=${encodeURIComponent(qrCacheVersion)}`
    : null;
  const statusNoticeBox = (title, detail, titleColor, backgroundColor) => ({
    type: 'box',
    layout: 'vertical',
    backgroundColor,
    cornerRadius: 'md',
    paddingAll: 'lg',
    margin: 'md',
    spacing: 'xs',
    contents: [
      { type: 'text', text: title, weight: 'bold', size: 'xl', align: 'center', color: titleColor },
      { type: 'text', text: detail, size: 'sm', align: 'center', color: '#5f5448', wrap: true },
    ],
  });

  const flexBody = [
    { type: 'text', text: '📋 บิลใหม่', weight: 'bold', size: 'lg', color: '#c46a3e' },
    { type: 'separator', margin: 'md' },
    {
      type: 'box',
      layout: 'vertical',
      margin: 'md',
      spacing: 'sm',
      contents: [
        rowKV('ห้อง', String(b.room_id || '-')),
        rowKV('รอบ', String(b.period || '-')),
        rowKV('กำหนดชำระ', String(dueDateStr || '-')),
        rowKV('ยอดชำระ', `฿${totalStr}`, true),
        rowKV('LINE ที่ผูก', `${Number(lineCount) || 0} บัญชี`),
      ],
    },
  ];
  const summaryBox = flexBody.find((part) =>
    part && part.type === 'box' && part.layout === 'vertical' && Array.isArray(part.contents));
  if (summaryBox) summaryBox.contents.push(rowKV('สถานะ', billStatusLabel, isPaid || !isPayable));
  if (isPaid) {
    flexBody.push(
      { type: 'separator', margin: 'lg' },
      statusNoticeBox('ชำระแล้ว', 'ไม่ต้องสแกน QR หรือส่งสลิปเพิ่ม', '#1f7a3f', '#e8f5ec'));
  } else if (!isPayable) {
    flexBody.push(
      { type: 'separator', margin: 'lg' },
      statusNoticeBox('ชำระไม่ได้', `สถานะปัจจุบัน: ${billStatus || '-'}`, '#8a4b12', '#fff4d8'));
  }
  if (qrUrl) {
    flexBody.push(
      { type: 'separator', margin: 'lg' },
      {
        type: 'text',
        text: 'สแกน PromptPay เพื่อชำระ',
        size: 'sm',
        color: '#8a7d6b',
        align: 'center',
        margin: 'md',
      },
      {
        type: 'image',
        url: qrUrl,
        size: 'full',
        aspectRatio: '1:1',
        aspectMode: 'cover',
        margin: 'sm',
      });
  }
  if (hasBankInfo) {
    flexBody.push(
      { type: 'separator', margin: 'lg' },
      { type: 'text', text: 'หรือโอนเข้าบัญชีธนาคาร', size: 'sm', color: '#8a7d6b', weight: 'bold', margin: 'md' },
      {
        type: 'box',
        layout: 'vertical',
        margin: 'sm',
        spacing: 'xs',
        contents: [
          rowKV('ธนาคาร', bankInfo.bank || '-'),
          rowKV('เลขบัญชี', bankInfo.account, true),
          bankInfo.name ? rowKV('ชื่อบัญชี', bankInfo.name) : null,
        ].filter(Boolean),
      });
  }
  if (qrUrl || hasBankInfo) {
    flexBody.push({
      type: 'text',
      text: 'หลังชำระแล้ว กดปุ่มด้านล่างเพื่อส่งสลิปให้แอดมินตรวจ',
      size: 'xs',
      color: '#8a7d6b',
      wrap: true,
      margin: 'md',
    });
  }
  const bubble = {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: flexBody },
    footer: billLink ? {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#c46a3e',
          action: { type: 'uri', label: 'ดูบิล + ส่งสลิป', uri: billLink },
        },
      ],
    } : undefined,
  };
  if (bubble.footer?.contents?.[0]?.action && (isPaid || !isPayable)) {
    bubble.footer.contents[0].action.label = 'ดูรายละเอียดบิล';
  }
  const flexMsg = {
    type: 'flex',
    altText: `บิลใหม่ห้อง ${b.room_id} ยอด ฿${totalStr}`,
    contents: bubble,
  };
  if (isPaid) flexMsg.altText = `บิลห้อง ${b.room_id} ชำระแล้ว`;
  else if (!isPayable) flexMsg.altText = `บิลห้อง ${b.room_id} ยังชำระไม่ได้`;

  const textMsg = isPaid ? {
    type: 'text',
    text: [
      `✅ บิลนี้ชำระแล้ว — ${b.period || '-'}`,
      '',
      `ห้อง: ${b.room_id || '-'}`,
      `ยอดบิล: ฿${totalStr}`,
      'สถานะ: ชำระแล้ว',
      'ไม่ต้องสแกน QR หรือส่งสลิปเพิ่ม',
      billLink ? `\nดูรายละเอียดบิล:\n👉 ${billLink}` : null,
    ].filter(Boolean).join('\n'),
  } : (!isPayable ? {
    type: 'text',
    text: [
      `⚠️ บิลนี้ยังชำระผ่านลิงก์ไม่ได้ — ${b.period || '-'}`,
      '',
      `ห้อง: ${b.room_id || '-'}`,
      `ยอดบิล: ฿${totalStr}`,
      `สถานะปัจจุบัน: ${billStatus || '-'}`,
      'กรุณาติดต่อแอดมินก่อนชำระเงิน',
      billLink ? `\nดูรายละเอียดบิล:\n👉 ${billLink}` : null,
    ].filter(Boolean).join('\n'),
  } : {
    type: 'text',
    text: [
      `📋 บิลใหม่ — ${b.period || '-'}`,
      '',
      `ห้อง: ${b.room_id || '-'}`,
      `ยอดชำระ: ฿${totalStr}`,
      `กำหนดชำระ: ${dueDateStr || '-'}`,
      `LINE ที่ผูกกับห้องนี้: ${Number(lineCount) || 0} บัญชี`,
      '',
      'วิธีชำระเงิน:',
      qrUrl ? '1) สแกน QR PromptPay ในข้อความนี้' : null,
      hasBankInfo ? [
        `${qrUrl ? '2' : '1'}) โอนเข้าบัญชีธนาคาร`,
        `   ธนาคาร: ${bankInfo.bank || '-'}`,
        `   เลขบัญชี: ${bankInfo.account}`,
        bankInfo.name ? `   ชื่อบัญชี: ${bankInfo.name}` : null,
      ].filter(Boolean).join('\n') : null,
      billLink ? `\nส่งสลิป / ดูบิล:\n👉 ${billLink}` : null,
    ].filter(Boolean).join('\n'),
  });
  return [flexMsg, textMsg];
}

async function loadBillForLineMessage(pool, billId) {
  const { rows } = await pool.query(
    `SELECT b.id, b.bill_no, b.period, b.total, b.due_date, b.status, b.room_id, b.tenant_id,
            t.id AS tenant_row_id, t.line_user_id, t.line_oa_id
       FROM bills b
       LEFT JOIN tenants t
         ON t.id = b.tenant_id
        AND t.deleted_at IS NULL
      WHERE b.id=$1 AND b.deleted_at IS NULL
      LIMIT 1`,
    [billId]
  );
  return rows[0] || null;
}

async function countTenantLineRecipients(pool, bill) {
  const tenantId = bill?.tenant_row_id || bill?.tenant_id || null;
  const recipients = [];
  const seen = new Set();
  const add = (lineUserId, lineOaId) => {
    const lineId = lineNotify.isLikelyUserId(lineUserId) ? String(lineUserId).trim() : null;
    if (!lineId) return;
    const key = `${lineOaId == null ? 0 : lineOaId}:${lineId}`;
    if (seen.has(key)) return;
    seen.add(key);
    recipients.push(lineId);
  };
  if (tenantId) {
    const rows = await lineBinding.listTenantRecipients(pool, tenantId).catch(() => []);
    for (const row of rows) add(row.line_user_id, row.oa_id);
  }
  add(bill?.line_user_id, bill?.line_oa_id);
  return recipients.length;
}

async function buildQueuedBillLineMessages(pool, row, payload = {}) {
  if (Array.isArray(payload.messages) && payload.messages.length > 0) {
    return payload.messages;
  }
  const billId = Number(payload.billId);
  if (!Number.isInteger(billId) || billId < 1) return null;
  const publicUrl = publicUrlFromEnv();
  if (!publicUrl) return null;
  const bill = await loadBillForLineMessage(pool, billId);
  if (!bill) return null;
  const { paymentBlock } = await loadEffectivePaymentBlock(pool);
  const bankInfo = paymentBlock.bankInfo && paymentBlock.bankInfo.account
    ? paymentBlock.bankInfo
    : null;
  const canEmbedPromptPayQr = promptPayQrUsable(paymentBlock, bill.total);
  if (!canEmbedPromptPayQr && !bankInfo) return null;
  const payToken = billTokens.signBillPayToken(billId);
  const qrToken = canEmbedPromptPayQr ? billTokens.signBillQrToken(billId) : null;
  const qrVersion = `${billId}-${String(bill.status || 'pending')}-${Date.now()}`;
  const billLink = `${publicUrl}/pay/${encodeURIComponent(billId)}?t=${encodeURIComponent(payToken)}`;
  const lineCount = Number(payload.lineCount);
  return buildBillLineMessages(bill, {
    publicUrl,
    billLink,
    dueDateStr: formatDueDate(bill.due_date),
    qrToken,
    qrVersion: qrToken ? qrVersion : null,
    bankInfo,
    lineCount: Number.isFinite(lineCount) ? lineCount : await countTenantLineRecipients(pool, bill),
  });
}

module.exports = {
  publicUrlFromEnv,
  buildEffectivePaymentBlock,
  buildBillLineMessages,
  buildQueuedBillLineMessages,
  _test: {
    promptPayQrUsable,
    formatDueDate,
    countTenantLineRecipients,
  },
};
