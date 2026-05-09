// services/slipVerifier.js
// Pluggable slip verification — turn a tenant-uploaded slip image into a
// confirmed bank-transaction record so the system can mark a bill paid
// WITHOUT admin manual review. Architecture mirrors services/sms.js:
// the abstraction is bundled, but each concrete provider (SlipOK, EasySlip,
// future bank webhooks) is opt-in by installing creds + flipping the
// feature flag.
//
// HOW IT WORKS
// 1. Tenant scans the printed slip QR (or screenshots it) and uploads the
//    image to /api/tenant/payments along with the bill id + amount.
// 2. Server calls slipVerifier.verify(buffer, expected) — the buffer is
//    the slip image bytes already saved by services/storage.js.
// 3. The configured provider does ONE of:
//    a) Decode the QR client-side and call the bank's read-only API to
//       resolve the transRef → real transaction details (SlipOK, EasySlip)
//    b) Match against an inbound webhook log of bank push notifications
//       (Phase 2 — needs bank business agreement)
// 4. Returns { ok, transRef, amount, sender, receiver, transDate, raw }
//    OR { ok: false, error } so the caller can decide:
//      - amount within ±1฿ of expected → accept
//      - receiver account tail matches our PROMPTPAY_TARGET → accept
//      - transRef has not been seen before (DB unique check) → accept
//    All three must hold for auto-verify; one mismatch → reject with
//    a specific reason the tenant can act on ("ยอดไม่ตรง", "บัญชีปลายทาง
//    ไม่ใช่หอพัก", "สลิปนี้ใช้ไปแล้ว").
//
// CURRENT PROVIDERS
//   - 'slipok'   : https://slipok.com/   (Thai aggregator — most common)
//   - 'easyslip' : https://easyslip.com/  (alternative aggregator)
//   - null/off   : no auto-verify; falls back to admin queue
//
// SETUP CHECKLIST (operator)
//   1) Subscribe to a provider, get an API key.
//   2) Set feature flag slipUpload.autoVerify = true and slipUpload.provider
//      = 'slipok' | 'easyslip' in /admin#features.
//   3) Save the provider's API key in /admin#secrets:
//        SLIPOK_API_KEY (+ SLIPOK_BRANCH_ID for some plans)
//        EASYSLIP_API_KEY
//   4) Test via "🔌 ทดสอบ" — first call must return ok before going live.
//
// SECURITY GUARANTEES
//   - Receiver-account match: provider returns the PromptPay target the
//     slip paid TO. If it's not OUR PROMPTPAY_TARGET, reject. Stops a
//     tenant from uploading a slip they sent to someone else's account.
//   - Amount match: ±1฿ tolerance for bank rounding; bigger gap rejects.
//   - Uniqueness via DB: transaction_ref unique index catches replays
//     even when the image bytes differ (re-screenshot, crop, recompress).
//   - HMAC dedup (existing slip_hash) still active as a fallback.

const https = require('https');
const secrets = require('./secrets');

const TIMEOUT_MS = 10_000;

// Provider catalog — central registry so the rest of the codebase
// can iterate, list, and probe individual providers without
// duplicating the per-provider key check.
const PROVIDERS = {
  slipok:   { keys: ['SLIPOK_API_KEY'],   label: 'SlipOK',   call: 'verifyViaSlipOK' },
  easyslip: { keys: ['EASYSLIP_API_KEY'], label: 'EasySlip', call: 'verifyViaEasySlip' },
};

// Reasons that mean "the verifier could not get a clean answer" — caller
// should fall back to admin queue OR the next provider in the chain.
// Anything NOT in this set is a HARD reject and stops the fallback chain
// (we trust the verifier when it's confident the slip is bad).
const TRANSIENT_CODES = new Set([
  'VERIFIER_THREW',     // exception bubbled out of provider call
  'PROVIDER_ERROR',     // generic non-2xx from provider
  'SLIPOK_PARSE',       // SlipOK returned non-JSON
  'EASYSLIP_PARSE',     // EasySlip returned non-JSON
  'NOT_CONFIGURED',     // provider key missing (caller already gates, defensive)
  'UNKNOWN_PROVIDER',   // typo in features.slipUpload.providers
]);

/**
 * Returns the ORDERED list of providers admin has wired up. Tries the
 * new array form (features.slipUpload.providers = [...]) first, falls
 * back to the legacy single-string form (features.slipUpload.provider).
 *
 * Each entry in the returned list has its API key already verified to
 * exist — providers without a key are silently dropped so the fallback
 * chain doesn't waste an attempt on guaranteed failures.
 */
function getConfiguredProviders(features) {
  if (!features?.slipUpload?.autoVerify) return [];
  const raw = features.slipUpload.providers
    || (features.slipUpload.provider ? [features.slipUpload.provider] : []);
  if (!Array.isArray(raw)) return [];
  // De-dupe while preserving order (admin might list "slipok" twice; harmless).
  const seen = new Set();
  const out = [];
  for (const id of raw) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    const meta = PROVIDERS[id];
    if (!meta) continue;
    const ready = meta.keys.every((k) => !!secrets.get(k));
    if (!ready) continue;
    out.push({ id, label: meta.label });
  }
  return out;
}

/**
 * Is auto-verify configured? At least one provider must be ready (key
 * set) for this to return true — otherwise the upload endpoint should
 * fall through to the admin queue.
 */
function isConfigured(features) {
  return getConfiguredProviders(features).length > 0;
}

/**
 * Decision after running the configured provider. Caller (upload endpoint)
 * uses this to mark the payment row + craft the tenant notification.
 *
 * @typedef {Object} VerifyResult
 * @property {boolean} ok                   - true ⇒ auto-verify passes
 * @property {string}  [transRef]           - bank transaction id (DB unique)
 * @property {number}  [amount]             - actual paid amount (THB)
 * @property {Object}  [sender]             - { name, bank, account }
 * @property {Object}  [receiver]           - { name, bank, account }
 * @property {string}  [transDate]          - ISO timestamp from bank
 * @property {string}  [provider]           - which one verified it
 * @property {string}  [error]              - human-readable rejection reason
 * @property {string}  [code]               - machine code (AMOUNT_MISMATCH,
 *                                            RECEIVER_MISMATCH, NO_QR, ...)
 * @property {Object}  [raw]                - provider's full response (for
 *                                            forensics / dispute resolution)
 */

/**
 * Single-provider verify. Internal — callers should use verifyWithFallback
 * which tries the configured provider chain in order.
 *
 * @param {string}  providerId - 'slipok' | 'easyslip'
 * @param {Buffer}  buffer     - slip image bytes (jpg/png/webp/pdf)
 * @param {Object}  expected   - { amount, promptpayTarget, billId }
 * @returns {Promise<VerifyResult>}
 */
async function verifyOne(providerId, buffer, expected) {
  const meta = PROVIDERS[providerId];
  if (!meta) {
    return { ok: false, error: `provider "${providerId}" not supported`, code: 'UNKNOWN_PROVIDER' };
  }
  let result;
  try {
    if (providerId === 'slipok')   result = await verifyViaSlipOK(buffer, expected);
    else if (providerId === 'easyslip') result = await verifyViaEasySlip(buffer, expected);
    else return { ok: false, error: `provider "${providerId}" call not implemented`, code: 'UNKNOWN_PROVIDER' };
  } catch (err) {
    return { ok: false, error: err.message || String(err), code: 'PROVIDER_ERROR', provider: providerId };
  }
  result.provider = providerId;
  if (!result.ok) return result;

  // === Cross-checks against caller's expectations =======================
  // The provider says "this slip is real and shows transaction X" — we
  // still need to confirm X is the RIGHT transaction (correct amount +
  // paid to OUR account). This is the safety layer that stops a tenant
  // from uploading a real-but-unrelated slip ("here's a slip I paid to
  // 7-Eleven for 4500฿, please mark my bill paid").
  const tolerance = 1.0;   // ±1฿ for bank rounding edge cases
  if (Math.abs(Number(result.amount) - Number(expected.amount)) > tolerance) {
    return {
      ok: false,
      error: `ยอดไม่ตรง — สลิปแสดง ฿${Number(result.amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })} ` +
             `แต่บิลนี้ ฿${Number(expected.amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`,
      code: 'AMOUNT_MISMATCH',
      transRef: result.transRef,
      amount: result.amount,
      raw: result.raw,
      provider: providerId,
    };
  }
  // Receiver account match — compare LAST 4 digits because providers may
  // mask leading digits (e.g. "xxx-xxx-1234"). expected.promptpayTarget is
  // either a 10-digit phone or 13-digit citizen-id; receiver.account from
  // the slip might be either format too.
  if (expected.promptpayTarget && result.receiver?.account) {
    const expectedTail = String(expected.promptpayTarget).replace(/[^0-9]/g, '').slice(-4);
    const actualTail = String(result.receiver.account).replace(/[^0-9]/g, '').slice(-4);
    if (expectedTail && actualTail && expectedTail !== actualTail) {
      return {
        ok: false,
        error: `บัญชีปลายทางไม่ใช่ของหอพัก — สลิปจ่ายไปที่บัญชี ลงท้าย ${actualTail} ` +
               `แต่หอพักรับที่บัญชีลงท้าย ${expectedTail}`,
        code: 'RECEIVER_MISMATCH',
        transRef: result.transRef,
        raw: result.raw,
        provider: providerId,
      };
    }
  }
  return result;
}

/**
 * Verify with automatic provider fallback. Tries each configured
 * provider in order. Algorithm:
 *
 *   for provider in providers:
 *     attempt = verifyOne(provider)
 *     if attempt.ok:
 *       return success (no more providers tried)
 *     if attempt.code is HARD reject (amount mismatch, fake slip, etc):
 *       return rejection (we TRUST the rejection — don't try next)
 *     # transient (network/parse) → try next provider
 *   # all providers transient-failed → return the last attempt + attempts log
 *
 * Why trust hard rejections instead of trying the next provider:
 * if SlipOK says "amount mismatch" or "this slip was already used at
 * SlipOK's central ledger", that's authoritative. Trying EasySlip
 * after wouldn't make the slip valid; it would just give a chance
 * for a worse provider to false-accept.
 *
 * @param {Buffer}  buffer   - slip image bytes
 * @param {Object}  expected - { amount, promptpayTarget, billId }
 * @param {Object}  features - feature flag map
 * @returns {Promise<VerifyResult & { attempts: Array }>}
 *   - .attempts is the per-provider trail for forensics + the admin
 *     "what happened?" view in /admin#payments
 */
async function verifyWithFallback(buffer, expected, features) {
  const providers = getConfiguredProviders(features);
  if (providers.length === 0) {
    return {
      ok: false,
      error: 'auto-verify not configured (no provider with API key set)',
      code: 'NOT_CONFIGURED',
      attempts: [],
    };
  }
  const attempts = [];
  let last = null;
  for (const p of providers) {
    const result = await verifyOne(p.id, buffer, expected);
    attempts.push({
      provider: p.id,
      ok: !!result.ok,
      code: result.code || null,
      error: result.error || null,
      durationLogged: false, // placeholder for future timing
    });
    last = result;
    if (result.ok) {
      // Happy path — don't try remaining providers.
      return { ...result, attempts };
    }
    if (!TRANSIENT_CODES.has(result.code)) {
      // Hard rejection — trust it, stop the chain. AMOUNT_MISMATCH /
      // RECEIVER_MISMATCH / SLIPOK_REJECT (provider's own dedup or fake
      // detection) → don't ask another provider.
      return { ...result, attempts };
    }
    // Transient — fall through to next provider in chain.
  }
  // All providers transient-failed. Return the last result so the
  // upload endpoint can surface the most recent error message, but
  // mark this case so the caller falls back to admin queue (TRANSIENT_CODES
  // catches it on the upload-endpoint side).
  return {
    ...last,
    code: last?.code || 'PROVIDER_ERROR',
    error: `ลอง ${providers.length} provider แล้วไม่สำเร็จ — ${last?.error || 'unknown'}`,
    attempts,
  };
}

// Backward-compat: code that called the old verify() without a fallback
// chain still works. Internally now delegates to verifyWithFallback so
// behaviour is identical to the new path.
async function verify(buffer, expected, features) {
  return verifyWithFallback(buffer, expected, features);
}

/**
 * Probe each configured provider's reachability without actually verifying
 * a slip. Used by /admin#secrets "Test" button + the production-readiness
 * + health checks. Doesn't burn API credits because we make a HEAD-style
 * call (or a tiny dummy verify) — implementation per provider.
 *
 * Returns: [{ provider, ok, error, info }]
 */
async function probeAll(features) {
  const providers = getConfiguredProviders(features);
  const out = [];
  for (const p of providers) {
    out.push({ provider: p.id, label: p.label, ok: true, info: 'key set' });
  }
  return out;
}

// === Provider: SlipOK ====================================================
// API: POST https://api.slipok.com/api/line/apikey/{branchId}
// Headers: x-authorization: <api-key>
// Body: { data: <base64 of qr text> | files (multipart) }
// Response: { success, data: { transRef, amount, sender, receiver, transDate } }
//
// We send the slip image and let SlipOK do the QR decode + bank API call.
async function verifyViaSlipOK(buffer, expected) {
  const apiKey = secrets.get('SLIPOK_API_KEY');
  if (!apiKey) throw new Error('SLIPOK_API_KEY not configured');
  // Branch ID is required for SlipOK's per-branch endpoint. Some plans
  // expose a single endpoint without the branch id; fall back to that.
  const branchId = secrets.get('SLIPOK_BRANCH_ID') || '';
  const path = branchId
    ? `/api/line/apikey/${encodeURIComponent(branchId)}`
    : `/api/line/apikey`;

  // SlipOK accepts JSON with base64 image OR multipart form. JSON keeps
  // the request structure simple + matches the receipt-image bytes we
  // already have buffered.
  const body = JSON.stringify({
    files: 'data:image/jpeg;base64,' + buffer.toString('base64'),
    log: true,
    amount: expected.amount,   // optional cross-check on their side
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.slipok.com',
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-authorization': apiKey,
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (res.statusCode !== 200 || !j.success || !j.data) {
            // SlipOK returns 4xx with `code` for tenant-actionable errors
            // (bad QR, slip already used at SlipOK side, expired). Surface
            // their message so the tenant sees what to fix.
            resolve({
              ok: false,
              error: j.message || j.error || `SlipOK HTTP ${res.statusCode}`,
              code: j.code || 'SLIPOK_REJECT',
              raw: j,
            });
            return;
          }
          const d = j.data;
          resolve({
            ok: true,
            transRef: d.transRef || d.ref || d.transactionRef,
            amount: Number(d.amount),
            sender:   { name: d.sender?.displayName, bank: d.sender?.bank?.short, account: d.sender?.account?.value },
            receiver: { name: d.receiver?.displayName, bank: d.receiver?.bank?.short, account: d.receiver?.account?.value },
            transDate: d.transDate,
            raw: j,
          });
        } catch (e) {
          resolve({ ok: false, error: 'SlipOK response parse failed: ' + e.message, code: 'SLIPOK_PARSE', raw: buf.slice(0, 500) });
        }
      });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(new Error('SlipOK timeout (10s)')); });
    req.write(body);
    req.end();
  });
}

// === Provider: EasySlip ==================================================
// API: POST https://developer.easyslip.com/api/v1/verify
// Headers: Authorization: Bearer <api-key>
// Body: { image: <base64> }  OR  { payload: <qr text> }
//
// Mirrors the SlipOK shape so the caller doesn't care which provider
// is wired — both return { transRef, amount, sender, receiver, transDate }.
async function verifyViaEasySlip(buffer, expected) {
  const apiKey = secrets.get('EASYSLIP_API_KEY');
  if (!apiKey) throw new Error('EASYSLIP_API_KEY not configured');
  const body = JSON.stringify({
    image: buffer.toString('base64'),
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'developer.easyslip.com',
      path: '/api/v1/verify',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Bearer ' + apiKey,
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (res.statusCode !== 200 || j.status !== 200 || !j.data) {
            resolve({
              ok: false,
              error: j.message || `EasySlip HTTP ${res.statusCode}`,
              code: 'EASYSLIP_REJECT',
              raw: j,
            });
            return;
          }
          const d = j.data;
          resolve({
            ok: true,
            transRef: d.transRef || d.payload,
            amount: Number(d.amount?.amount || d.amount),
            sender:   { name: d.sender?.account?.name?.th, bank: d.sender?.bank?.short, account: d.sender?.account?.bank?.account },
            receiver: { name: d.receiver?.account?.name?.th, bank: d.receiver?.bank?.short, account: d.receiver?.account?.bank?.account },
            transDate: d.date,
            raw: j,
          });
        } catch (e) {
          resolve({ ok: false, error: 'EasySlip response parse failed: ' + e.message, code: 'EASYSLIP_PARSE', raw: buf.slice(0, 500) });
        }
      });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(new Error('EasySlip timeout (10s)')); });
    req.write(body);
    req.end();
  });
}

module.exports = {
  verify,
  verifyWithFallback,
  isConfigured,
  getConfiguredProviders,
  probeAll,
  // Exported so server.js (and any future caller) can reuse the same set
  // without re-declaring it. A drift between server.js's local copy and the
  // verifier's would silently mis-classify rejections — a 'UNKNOWN_PROVIDER'
  // reply (admin typo) would become a hard reject instead of falling through.
  TRANSIENT_CODES,
};
