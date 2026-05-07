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

// Trim + reject control chars in a token before it goes into an HTTP header.
// Without this, a token with a stray newline or whitespace surfaces as
// "Invalid character in header content [\"Authorization\"]" which is opaque
// to operators. Strip whitespace + control bytes; throw a clear error if
// what's left is empty or still illegal.
function sanitiseToken(raw) {
  if (typeof raw !== 'string') throw new Error('LINE token missing or wrong type');
  const cleaned = raw.trim().replace(/[\x00-\x1F\x7F]/g, '');
  if (!cleaned) throw new Error('LINE token is empty after trim');
  // HTTP header values must stay in 0x20-0x7E (printable ASCII). Anything
  // else means the operator pasted a token that includes a non-token char.
  if (/[^\x20-\x7E]/.test(cleaned)) {
    throw new Error('LINE token contains non-ASCII characters — re-paste');
  }
  return cleaned;
}

// --- HTTP helpers ---------------------------------------------------------
function postJson(oa, pathname, body) {
  return new Promise((resolve, reject) => {
    if (!oa || !oa.channelAccessToken) {
      return reject(new Error('LINE OA not configured'));
    }
    let token;
    try { token = sanitiseToken(oa.channelAccessToken); }
    catch (err) { return reject(err); }
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request(
      {
        hostname: 'api.line.me', port: 443, path: pathname, method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
          Authorization: `Bearer ${token}`,
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

module.exports = {
  isConfigured, pushText, replyText, verifyWebhookSignature,
  _resolveOa, // exported for tests
};
