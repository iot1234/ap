// Pure-ish tests for queued bill LINE rich-message reconstruction.
//
//   node --test tests/billLineMessages.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const billTokens = require('../services/billTokens');
const billLineMessages = require('../services/billLineMessages');
const lineBinding = require('../services/lineBinding');

test('bill token service signs and verifies QR/payment tokens with the configured runtime secret', () => {
  billTokens.configureRuntimeSecret('test-secret-for-bill-links');
  const qrToken = billTokens.signBillQrToken(42, Date.now() + 60_000);
  const payToken = billTokens.signBillPayToken(42, Date.now() + 60_000);
  assert.equal(billTokens.verifyBillQrToken(42, qrToken), true);
  assert.equal(billTokens.verifyBillQrToken(43, qrToken), false);
  assert.equal(billTokens.verifyBillPayToken(42, payToken), true);
  assert.equal(billTokens.verifyBillPayToken(43, payToken), false);
});

test('buildQueuedBillLineMessages rebuilds Flex + QR + bank details from payload.billId', async () => {
  const oldPublicUrl = process.env.PUBLIC_URL;
  const originalList = lineBinding.listTenantRecipients;
  process.env.PUBLIC_URL = 'https://example.test';
  billTokens.configureRuntimeSecret('test-secret-for-bill-links');
  lineBinding.listTenantRecipients = async () => [
    { line_user_id: `U${'2'.repeat(32)}`, oa_id: 1 },
  ];
  const pool = {
    query: async (sql) => {
      if (/FROM app_data/.test(sql)) {
        return {
          rows: [{
            value: {
              payment: {
                promptpay: '0812345678',
                bank: 'Test Bank',
                bankAcc: '123-4-56789-0',
                bankName: 'Dorm Owner',
              },
            },
          }],
        };
      }
      if (/FROM bills b/.test(sql)) {
        return {
          rows: [{
            id: 42,
            bill_no: 'INV-2026-06-A101',
            period: '2026-06',
            total: 1234.5,
            due_date: '2026-06-15',
            status: 'pending',
            room_id: 'A101',
            tenant_id: 9,
            tenant_row_id: 9,
            line_user_id: `U${'1'.repeat(32)}`,
            line_oa_id: 1,
          }],
        };
      }
      return { rows: [] };
    },
  };
  try {
    const messages = await billLineMessages.buildQueuedBillLineMessages(pool, {
      id: 99,
      subject: 'Bill',
      body: 'text fallback',
    }, { billId: 42 });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].type, 'flex');
    const body = messages[0].contents.body.contents;
    const image = body.find((item) => item.type === 'image');
    assert.ok(image, 'Flex body should include the PromptPay QR image');
    assert.match(image.url, /^https:\/\/example\.test\/p\/bill-qr\/42\?t=/);
    assert.match(messages[0].contents.footer.contents[0].action.uri, /^https:\/\/example\.test\/pay\/42\?t=/);
    assert.match(messages[1].text, /QR PromptPay/);
    assert.match(messages[1].text, /123-4-56789-0/);
  } finally {
    if (oldPublicUrl == null) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = oldPublicUrl;
    lineBinding.listTenantRecipients = originalList;
  }
});
