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

function isConfigured() {
  return !!process.env.LINE_CHANNEL_ACCESS_TOKEN;
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
          Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
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
  const owner = process.env.LINE_OWNER_USER_ID;
  if (!owner) return false;
  return pushText(owner, text);
}

module.exports = { isConfigured, pushText, pushFlex, notifyOwner };
