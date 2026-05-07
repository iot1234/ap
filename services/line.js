// services/line.js
// LINE Messaging API push notifications. Now multi-OA aware:
//   - pushText(oa, userId, text)        — push via specific OA
//   - pushText(userId, text)            — backward-compat: uses env-OA
// Pass an `oa` object as the first arg to route through that channel.
//
// Backward compatibility: if the first arg looks like a userId string (starts
// with 'U' for LINE user, or just a long string), we treat the call as legacy
// "single OA via env vars" and resolve credentials from secrets.js.

const https = require('https');
const secrets = require('./secrets');

// --- OA resolution --------------------------------------------------------
// Anything we accept as an "OA-shaped" object must expose channelAccessToken
// (string) for outbound calls. We synthesize an env-OA from secrets.js if no
// OA was passed in — preserves the previous single-OA call signature.
function _resolveOa(maybeOa) {
  if (maybeOa && typeof maybeOa === 'object' && maybeOa.channelAccessToken) {
    return maybeOa;
  }
  const token = secrets.get('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) return null;
  return {
    id: 0, slug: 'env', isEnvOa: true,
    channelAccessToken: token,
    channelSecret: secrets.get('LINE_CHANNEL_SECRET') || null,
    ownerUserId: secrets.get('LINE_OWNER_USER_ID') || null,
  };
}

// Heuristic: the legacy call was pushText(userId, text); the new call is
// pushText(oa, userId, text). We disambiguate by the shape of the first arg.
function _splitArgs(args, fnLen /* expected: oa-form arg count */) {
  if (args.length === fnLen && args[0] && typeof args[0] === 'object') {
    return { oa: args[0], rest: args.slice(1) };
  }
  // Legacy form: no oa supplied
  return { oa: null, rest: args };
}

// --- HTTP helpers ---------------------------------------------------------
function postJson(oa, pathname, body) {
  return new Promise((resolve, reject) => {
    if (!oa || !oa.channelAccessToken) {
      return reject(new Error('LINE OA not configured'));
    }
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request(
      {
        hostname: 'api.line.me', port: 443, path: pathname, method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
          Authorization: `Bearer ${oa.channelAccessToken}`,
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
    req.on('timeout', () => req.destroy(new Error('LINE API timeout')));
    req.write(data);
    req.end();
  });
}

// --- Public API -----------------------------------------------------------

function isConfigured(oa) {
  const resolved = _resolveOa(oa);
  return !!(resolved && resolved.channelAccessToken);
}

/**
 * Push a plain text message.
 *   pushText(oa, userId, text)  — preferred, multi-OA aware
 *   pushText(userId, text)      — legacy, uses env OA
 */
async function pushText(...args) {
  const { oa, rest } = _splitArgs(args, 3);
  const [userId, text] = rest;
  const resolved = _resolveOa(oa);
  if (!resolved || !userId || !text) return false;
  try {
    await postJson(resolved, '/v2/bot/message/push', {
      to: userId,
      messages: [{ type: 'text', text: String(text).slice(0, 5000) }],
    });
    return true;
  } catch (err) {
    console.error(`[line:${resolved.slug || resolved.id}] push failed:`, err.message);
    return false;
  }
}

/**
 * Push a Flex message.
 *   pushFlex(oa, userId, altText, flex)
 *   pushFlex(userId, altText, flex)   — legacy
 */
async function pushFlex(...args) {
  const { oa, rest } = _splitArgs(args, 4);
  const [userId, altText, flex] = rest;
  const resolved = _resolveOa(oa);
  if (!resolved || !userId || !flex) return false;
  try {
    await postJson(resolved, '/v2/bot/message/push', {
      to: userId,
      messages: [{ type: 'flex', altText: String(altText).slice(0, 400), contents: flex }],
    });
    return true;
  } catch (err) {
    console.error(`[line:${resolved.slug || resolved.id}] flex push failed:`, err.message);
    return false;
  }
}

/**
 * Reply to a webhook event using the one-shot replyToken.
 *   replyText(oa, replyToken, text)
 *   replyText(replyToken, text)   — legacy
 */
async function replyText(...args) {
  const { oa, rest } = _splitArgs(args, 3);
  const [replyToken, text] = rest;
  const resolved = _resolveOa(oa);
  if (!resolved || !replyToken || !text) return false;
  try {
    await postJson(resolved, '/v2/bot/message/reply', {
      replyToken,
      messages: [{ type: 'text', text: String(text).slice(0, 5000) }],
    });
    return true;
  } catch (err) {
    console.error(`[line:${resolved.slug || resolved.id}] reply failed:`, err.message);
    return false;
  }
}

async function replyFlex(...args) {
  const { oa, rest } = _splitArgs(args, 4);
  const [replyToken, altText, flex] = rest;
  const resolved = _resolveOa(oa);
  if (!resolved || !replyToken || !flex) return false;
  try {
    await postJson(resolved, '/v2/bot/message/reply', {
      replyToken,
      messages: [{ type: 'flex', altText: String(altText).slice(0, 400), contents: flex }],
    });
    return true;
  } catch (err) {
    console.error(`[line:${resolved.slug || resolved.id}] reply flex failed:`, err.message);
    return false;
  }
}

/**
 * Notify the OA's owner (or the env owner if no OA passed) about a system
 * event. Uses the OA's `ownerUserId` field if present, falling back to the
 * env-level LINE_OWNER_USER_ID.
 */
async function notifyOwner(...args) {
  const { oa, rest } = _splitArgs(args, 2);
  const [text] = rest;
  const resolved = _resolveOa(oa);
  if (!resolved) return false;
  const owner = resolved.ownerUserId || secrets.get('LINE_OWNER_USER_ID');
  if (!owner) return false;
  return pushText(resolved, owner, text);
}

/**
 * Verify the X-Line-Signature header. Per-OA: each OA has its own channel
 * secret, so the slug-based webhook MUST pass its own OA in.
 *   verifyWebhookSignature(oa, rawBody, sig)
 *   verifyWebhookSignature(rawBody, sig)   — legacy: uses env secret
 */
function verifyWebhookSignature(...args) {
  let oa, rawBody, signature;
  if (args.length === 3 && args[0] && typeof args[0] === 'object') {
    [oa, rawBody, signature] = args;
  } else {
    [rawBody, signature] = args;
    oa = _resolveOa(null);
  }
  const secret = (oa && oa.channelSecret) || secrets.get('LINE_CHANNEL_SECRET');
  if (!secret || !signature) return false;
  const crypto = require('crypto');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch { return false; }
}

// --- Flex template (unchanged) -------------------------------------------
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
  _resolveOa, // exported for tests
};
