// services/line.js
// LINE Messaging API push notifications. Lightweight wrapper using the
// built-in `https` module (no extra dependency). Fire-and-forget — caller
// awaits if it cares, but errors are caught and logged so a failed push
// never blocks the request that triggered it.
//
// Configure via env:
//   LINE_CHANNEL_ACCESS_TOKEN - long-lived channel access token
//   LINE_OWNER_USER_ID        - default recipient (admin/owner) for system events
//
// If LINE_CHANNEL_ACCESS_TOKEN is missing, all push functions become no-ops
// (return false) so the rest of the app keeps working in dev/staging without
// LINE configured.

const https = require('https');
const secrets = require('./secrets');

function isConfigured() {
  return !!secrets.get('LINE_CHANNEL_ACCESS_TOKEN');
}

function postJson(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request(
      {
        hostname: 'api.line.me',
        port: 443,
        path: pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
          Authorization: `Bearer ${secrets.get('LINE_CHANNEL_ACCESS_TOKEN')}`,
        },
        timeout: 5000,
      },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => { buf += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, status: res.statusCode, body: buf });
          } else {
            reject(new Error(`LINE API ${res.statusCode}: ${buf}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('LINE API timeout'));
    });
    req.write(data);
    req.end();
  });
}

/**
 * Push a plain text message to a single user.
 * @returns {Promise<boolean>} true if pushed, false if not configured / failed.
 */
async function pushText(userId, text) {
  if (!isConfigured() || !userId || !text) return false;
  try {
    await postJson('/v2/bot/message/push', {
      to: userId,
      messages: [{ type: 'text', text: String(text).slice(0, 5000) }],
    });
    return true;
  } catch (err) {
    console.error('[line] push failed:', err.message);
    return false;
  }
}

/**
 * Push a Flex Message (rich layout) to a user.
 * @param {string} userId
 * @param {string} altText - shown in chat list / push notification body
 * @param {object} flex - Flex Message bubble JSON per LINE spec
 */
async function pushFlex(userId, altText, flex) {
  if (!isConfigured() || !userId || !flex) return false;
  try {
    await postJson('/v2/bot/message/push', {
      to: userId,
      messages: [
        { type: 'flex', altText: String(altText).slice(0, 400), contents: flex },
      ],
    });
    return true;
  } catch (err) {
    console.error('[line] flex push failed:', err.message);
    return false;
  }
}

/**
 * Convenience: notify the configured owner about an event with a plain text
 * message. Use for low-stakes notifications (new booking, bill issued, etc.).
 */
async function notifyOwner(text) {
  const owner = secrets.get('LINE_OWNER_USER_ID');
  if (!owner) return false;
  return pushText(owner, text);
}

/**
 * Reply to a LINE webhook event. Uses the one-shot replyToken from the
 * incoming event — must be called within ~30s of receiving the webhook.
 */
async function replyText(replyToken, text) {
  if (!isConfigured() || !replyToken || !text) return false;
  try {
    await postJson('/v2/bot/message/reply', {
      replyToken,
      messages: [{ type: 'text', text: String(text).slice(0, 5000) }],
    });
    return true;
  } catch (err) {
    console.error('[line] reply failed:', err.message);
    return false;
  }
}

async function replyFlex(replyToken, altText, flex) {
  if (!isConfigured() || !replyToken || !flex) return false;
  try {
    await postJson('/v2/bot/message/reply', {
      replyToken,
      messages: [{ type: 'flex', altText: String(altText).slice(0, 400), contents: flex }],
    });
    return true;
  } catch (err) {
    console.error('[line] reply flex failed:', err.message);
    return false;
  }
}

// === LINE webhook signature verification =================================
// Validates the X-Line-Signature header against LINE_CHANNEL_SECRET. Use
// this on the /webhook/line route before consuming the body.
function verifyWebhookSignature(rawBody, signature) {
  const secret = secrets.get('LINE_CHANNEL_SECRET');
  if (!secret || !signature) return false;
  const crypto = require('crypto');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch { return false; }
}

// === Flex message template — bill =========================================
// Returns a LINE Flex bubble for a bill. Renders a clean card with
// header (room + period), itemised total, and a CTA button that links to
// the tenant portal.
function buildBillFlex({ tenantName, roomId, period, total, dueDate, billNo, portalUrl }) {
  const fmt = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: '#c46a3e', paddingAll: '20px',
      contents: [
        { type: 'text', text: 'ใบแจ้งหนี้', color: '#ffffff', weight: 'bold', size: 'sm' },
        { type: 'text', text: `ห้อง ${roomId || '-'}`, color: '#ffffff', weight: 'bold', size: 'xl', margin: 'sm' },
        { type: 'text', text: `รอบ ${period || '-'}`, color: '#ffffffdd', size: 'xs' },
      ],
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'md',
      contents: [
        { type: 'text', text: `ผู้เช่า: ${tenantName || '-'}`, size: 'sm', color: '#5b4f40' },
        { type: 'box', layout: 'baseline', spacing: 'sm', margin: 'md',
          contents: [
            { type: 'text', text: 'ยอดรวม', size: 'sm', color: '#8a7d6b', flex: 0 },
            { type: 'text', text: `฿${fmt(total)}`, size: 'xl', weight: 'bold', color: '#2c241b', align: 'end' },
          ],
        },
        { type: 'box', layout: 'baseline', spacing: 'sm',
          contents: [
            { type: 'text', text: 'กำหนดชำระ', size: 'sm', color: '#8a7d6b', flex: 0 },
            { type: 'text', text: String(dueDate || '-'), size: 'sm', align: 'end', color: '#2c241b' },
          ],
        },
        billNo ? { type: 'box', layout: 'baseline', spacing: 'sm',
          contents: [
            { type: 'text', text: 'เลขที่บิล', size: 'xs', color: '#8a7d6b', flex: 0 },
            { type: 'text', text: String(billNo), size: 'xs', align: 'end', color: '#5b4f40' },
          ],
        } : null,
      ].filter(Boolean),
    },
    footer: portalUrl ? {
      type: 'box', layout: 'vertical',
      contents: [{
        type: 'button', style: 'primary', color: '#c46a3e', height: 'sm',
        action: { type: 'uri', label: 'ดูบิล + ชำระ', uri: portalUrl },
      }],
    } : undefined,
  };
}

module.exports = {
  isConfigured, pushText, pushFlex, replyText, replyFlex,
  notifyOwner, verifyWebhookSignature, buildBillFlex,
};
