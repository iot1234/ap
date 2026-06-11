// services/slipVerifier.js
// Pluggable slip verification — turn a tenant-uploaded slip image into a
// confirmed bank-transaction record so the system can mark a bill paid
// WITHOUT admin manual review. Architecture mirrors services/sms.js:
// the abstraction is bundled, but each concrete provider (SlipOK, EasySlip,
// Slip2Go, future bank webhooks) is opt-in by installing creds + flipping the
// feature flag.
//
// HOW IT WORKS
// 1. Tenant scans the printed slip QR (or screenshots it) and uploads the
//    image to /api/tenant/payments along with the bill id + amount.
// 2. Server calls slipVerifier.verify(buffer, expected) — the buffer is
//    the slip image bytes already saved by services/storage.js.
// 3. The configured provider does ONE of:
//    a) Decode the QR client-side and call the bank's read-only API to
//       resolve the transRef → real transaction details (SlipOK, EasySlip, Slip2Go)
//    b) Match against an inbound webhook log of bank push notifications
//       (Phase 2 — needs bank business agreement)
// 4. Returns { ok, transRef, amount, sender, receiver, transDate, raw }
//    OR { ok: false, error } so the caller can decide:
//      - amount within ±1฿ of expected → accept
//      - receiver account tail matches our PROMPTPAY_TARGET → accept
//      - transaction date is recent (≤7 days old by default) → accept;
//        an older/unreadable date PARKS in the admin queue (transient)
//      - transRef has not been seen before (DB unique check) → accept
//    All of these must hold for auto-verify; one mismatch → reject with
//    a specific reason the tenant can act on ("ยอดไม่ตรง", "บัญชีปลายทาง
//    ไม่ใช่หอพัก", "สลิปนี้ใช้ไปแล้ว").
//
// CURRENT PROVIDERS
//   - 'slipok'   : https://slipok.com/   (Thai aggregator — most common)
//   - 'easyslip' : https://easyslip.com/  (alternative aggregator)
//   - 'slip2go'  : https://slip2go.com/   (alternative aggregator)
//   - null/off   : no auto-verify; falls back to admin queue
//
// SETUP CHECKLIST (operator)
//   1) Subscribe to a provider, get an API key.
//   2) Set feature flag slipUpload.autoVerify = true and slipUpload.provider
//      = 'slipok' | 'easyslip' | 'slip2go' in /admin#features.
//   3) Save the provider's API key in /admin#secrets:
//        SLIPOK_API_KEY (+ SLIPOK_BRANCH_ID for some plans)
//        EASYSLIP_API_KEY
//        SLIP2GO_API_KEY + SLIP2GO_API_URL
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

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const secrets = require('./secrets');
const ssrfGuard = require('./ssrfGuard');

const TIMEOUT_MS = 10_000;

// Provider catalog — central registry so the rest of the codebase
// can iterate, list, and probe individual providers without
// duplicating the per-provider key check.
const PROVIDERS = {
  slipok:   { keys: ['SLIPOK_API_KEY'],   label: 'SlipOK',   call: 'verifyViaSlipOK' },
  easyslip: { keys: ['EASYSLIP_API_KEY'], label: 'EasySlip', call: 'verifyViaEasySlip' },
  slip2go:  { keys: ['SLIP2GO_API_KEY', 'SLIP2GO_API_URL'], label: 'Slip2Go', call: 'verifyViaSlip2Go' },
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
  'SLIP2GO_PARSE',      // Slip2Go returned non-JSON
  'SLIP_PENDING',       // provider accepted the image but bank data is not ready yet
  'NOT_CONFIGURED',     // provider key missing (caller already gates, defensive)
  'UNKNOWN_PROVIDER',   // typo in features.slipUpload.providers
  // strictReceiverTail mode: the receiver DID match, but on fewer than 6
  // digits — statistically weaker evidence. Transient by design: the next
  // provider in the chain may return more digits, and if none does the slip
  // parks in the admin queue (a human confirms) instead of false-rejecting
  // a tenant who genuinely paid.
  'RECEIVER_TAIL_WEAK',
  // The provider confirmed the slip is REAL but the receiver account it
  // returned is missing / too masked / aligned ambiguously — we can neither
  // confirm nor confidently deny it's our account. Same reasoning as above:
  // try the next provider (it may reveal more digits), else park for a
  // human. A genuine payment must never be auto-rejected because a provider
  // masked the account too aggressively.
  'RECEIVER_UNREADABLE',
  // The slip's bank-transaction date is stale (older than the freshness
  // window), in the future, or unreadable. Transient by design: an old slip
  // is the classic replay vector (last month's GENUINE transfer re-uploaded
  // against this month's bill — invisible to slip_hash/transaction_ref dedup
  // when the original was recorded at the counter without a slip), but it
  // can also be a tenant who paid early and uploaded late. The verifier
  // can't tell those apart, so park for a human — never auto-verify, never
  // falsely reject. Also where Slip2Go's server-side date condition (code
  // 200403) lands if one is ever sent.
  'DATE_MISMATCH',
]);

function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return 'image/jpeg';
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
  if (buffer.length >= 8
      && buffer[0] === 0x89 && buffer[1] === 0x50
      && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png';
  if (buffer.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buffer.length >= 12
      && buffer.slice(0, 4).toString('ascii') === 'RIFF'
      && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

function imageExtFromMime(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

function multipartField(boundary, name, value) {
  return Buffer.from(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="${name}"\r\n\r\n`
    + `${String(value)}\r\n`
  );
}

function multipartFile(boundary, name, filename, mime, buffer) {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`
      + `Content-Type: ${mime}\r\n\r\n`
    ),
    buffer,
    Buffer.from('\r\n'),
  ]);
}

function buildMultipartForm({ fields, file }) {
  const boundary = '----ap-slipverify-' + crypto.randomBytes(12).toString('hex');
  const parts = [];
  for (const [name, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(multipartField(boundary, name, value));
  }
  parts.push(multipartFile(boundary, file.name, file.filename, file.mime, file.buffer));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function pickLocalizedName(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return value.displayName
    || value.nameTh
    || value.nameEn
    || value.th
    || value.en
    || pickLocalizedName(value.name)
    || null;
}

function pickBankShort(bank) {
  if (!bank) return null;
  if (typeof bank === 'string') return bank;
  return bank.short || bank.shortCode || bank.code || bank.id || bank.name || null;
}

function pickAccountValue(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return value.value
    || value.account
    || value.bankNumber
    || value.number
    || value.bank?.account
    || value.proxy?.account
    || null;
}

function mapProviderParty(party, matchedAccount) {
  const account = party?.account || null;
  return {
    name: pickLocalizedName(account) || pickLocalizedName(party) || pickLocalizedName(matchedAccount),
    bank: pickBankShort(party?.bank) || pickBankShort(matchedAccount?.bank),
    account: pickAccountValue(account) || pickAccountValue(party) || pickAccountValue(matchedAccount),
  };
}

// Separator characters banks/providers embed for display — NOT masks.
// Stripped before any comparison so '123-4-56789-0' and '1234567890' agree.
const ACCOUNT_SEPARATORS_RE = /[\s\-./]/g;

/**
 * Normalise a provider receiver-account string into a comparable pattern:
 * digits survive as-is, separators vanish, and EVERY other character
 * (x, X, *, •, ●, #, ?, letters from "N/A"-style placeholders…) becomes the
 * canonical mask '*'. Returns the pattern plus how many real digits it
 * reveals — the caller's confidence currency.
 */
function normalizeMaskedAccount(raw) {
  const s = String(raw || '').replace(ACCOUNT_SEPARATORS_RE, '');
  let pattern = '';
  let revealed = 0;
  for (const ch of s) {
    if (ch >= '0' && ch <= '9') { pattern += ch; revealed++; }
    else pattern += '*';
  }
  return { pattern, revealed };
}

// Compare one normalised pattern against one expected account.
// Returns { kind: 'match'|'conflict'|'ambiguous', matchedDigits, mode, ... }.
//
// Three comparison modes, picked by what the data allows:
//   'tail'        — pattern is pure digits (provider sent the tail or the
//                   full number). Longest common tail, capped at 6.
//   'positional'  — pattern has masks AND the same length as the expected
//                   account → every revealed digit must equal the expected
//                   digit at ITS OWN position ('12**5***99' style).
//   'right-align' — pattern has masks but a different length (separator
//                   variations, partial captures). Right-align and compare
//                   the overlap. A conflict here is only 'ambiguous', never
//                   'conflict': the alignment is a guess, and a guessed
//                   alignment must not produce a confident rejection.
function compareAccountPattern(expectedDigits, pattern, revealed) {
  if (!revealed) return { kind: 'ambiguous', matchedDigits: 0, mode: 'none' };
  const hasMask = pattern.includes('*');
  if (!hasMask) {
    const compareLen = Math.min(6, expectedDigits.length, pattern.length);
    // Fewer than 4 contiguous digits is too little signal to confirm OR
    // confidently deny — ambiguous, a human decides.
    if (compareLen < 4) return { kind: 'ambiguous', matchedDigits: compareLen, mode: 'tail' };
    const expectedTail = expectedDigits.slice(-compareLen);
    const actualTail = pattern.slice(-compareLen);
    return expectedTail === actualTail
      ? { kind: 'match', matchedDigits: compareLen, mode: 'tail', expectedTail, actualTail }
      : { kind: 'conflict', matchedDigits: 0, mode: 'tail', expectedTail, actualTail };
  }
  const confident = pattern.length === expectedDigits.length;
  const offset = expectedDigits.length - pattern.length;   // 0 when confident
  const mode = confident ? 'positional' : 'right-align';
  let matched = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') continue;
    const j = i + offset;
    if (j < 0 || j >= expectedDigits.length) {
      // Revealed digit lands outside the expected account under this
      // alignment — the alignment itself is wrong; can't judge.
      return { kind: 'ambiguous', matchedDigits: 0, mode };
    }
    if (expectedDigits[j] !== ch) {
      // Equal-length positional disagreement is real evidence of a wrong
      // account; a right-aligned guess disagreeing proves nothing.
      return { kind: confident ? 'conflict' : 'ambiguous', matchedDigits: 0, mode };
    }
    matched++;
  }
  // All revealed digits agree. Require ≥4 of them before calling it a
  // match — '*9********' agreeing on one digit is 1-in-10 luck, not proof.
  if (matched < 4) return { kind: 'ambiguous', matchedDigits: matched, mode };
  return { kind: 'match', matchedDigits: matched, mode };
}

/**
 * Pure receiver-account matcher — extracted from verifyOne so the comparison
 * rules are unit-testable without a live provider. Handles every masking
 * shape providers send back:
 *   - pure tail / full number:  '345678', '1234567899'
 *   - leading mask:             'xxx-x-x345678'
 *   - SCATTERED mask:           '12**5***99', '1*3*5****9'
 * Decision policy (รัดกุมทั้งสองทาง):
 *   - confident agreement   → 'match' (or 'weak' under strict with <6 digits)
 *   - confident disagreement→ 'mismatch'  (hard reject downstream)
 *   - anything uncertain    → 'unreadable' (parks in the admin queue —
 *     never auto-verifies, never falsely accuses the tenant)
 *
 * @param {Object} opts
 * @param {Array}  opts.acceptableTargets - [{ digits, method, label }]
 * @param {string} opts.actualAccount     - receiver account string from provider
 * @param {boolean} [opts.strict]         - strictReceiverTail mode: a match on
 *   fewer than 6 revealed digits is downgraded to outcome 'weak' (caller
 *   parks the slip for admin review instead of auto-verifying)
 * @returns {{ outcome: 'skip'|'unreadable'|'match'|'weak'|'mismatch',
 *             detail?: Object, actualTail?: string, expectedTails?: string[],
 *             reason?: string }}
 */
function matchReceiverTail({ acceptableTargets, actualAccount, strict = false }) {
  const targets = Array.isArray(acceptableTargets) ? acceptableTargets.filter((t) => t && t.digits) : [];
  if (!targets.length) return { outcome: 'skip' };
  if (!String(actualAccount || '').trim()) {
    return { outcome: 'unreadable', reason: 'no_account' };
  }
  const { pattern, revealed } = normalizeMaskedAccount(actualAccount);
  if (!revealed) {
    return { outcome: 'unreadable', reason: 'no_account' };
  }
  let best = null;            // strongest confident match across targets
  let sawAmbiguous = false;   // at least one target couldn't be judged
  const expectedTails = [];
  for (const target of targets) {
    const expectedDigits = target.digits;
    expectedTails.push(expectedDigits.slice(-Math.min(6, expectedDigits.length)));
    const cmp = compareAccountPattern(expectedDigits, pattern, revealed);
    if (cmp.kind === 'match') {
      const detail = {
        method: target.method || null,
        label: target.label || null,
        compareLen: cmp.matchedDigits,
        mode: cmp.mode,
        ...(cmp.expectedTail ? { expectedTail: cmp.expectedTail, actualTail: cmp.actualTail } : {}),
      };
      if (!best || detail.compareLen > best.compareLen) best = detail;
    } else if (cmp.kind === 'ambiguous') {
      sawAmbiguous = true;
    }
    // 'conflict' carries no state — it only becomes a mismatch when EVERY
    // target conflicts confidently (checked below).
  }
  if (best) {
    // Strict mode: a 4-5 digit agreement is real evidence but not the
    // 6-digit confidence the operator asked for — park it for a human.
    if (strict && best.compareLen < 6) {
      return { outcome: 'weak', detail: best };
    }
    return { outcome: 'match', detail: best };
  }
  if (sawAmbiguous) {
    // No confident match, and at least one comparison couldn't be judged —
    // too little signal to accuse the tenant of paying the wrong account.
    return { outcome: 'unreadable', reason: 'insufficient_digits', revealedDigits: revealed };
  }
  return {
    outcome: 'mismatch',
    actualTail: pattern.replace(/\*/g, '').slice(-6),
    expectedTails,
  };
}

// === Slip transaction-date freshness ======================================
// A provider 'ok' proves the slip maps to a REAL bank transaction — not that
// the transaction belongs to THIS bill. Amount + receiver checks can't
// distinguish last month's genuine 4,500฿ rent transfer from this month's,
// and the dedup layers (slip_hash, transaction_ref) miss replays whose
// original payment was recorded manually at the counter (no hash/ref
// stored). The transaction date is the remaining signal: a slip older than
// the window below (or dated in the future, or with no readable date) must
// not auto-verify. It parks in the admin queue rather than hard-rejecting —
// see DATE_MISMATCH in TRANSIENT_CODES for the reasoning.
const SLIP_MAX_AGE_DAYS = 7;     // look-back window for auto-verify
const SLIP_MAX_FUTURE_DAYS = 1;  // forward clock-skew allowance
const DAY_MS = 24 * 60 * 60 * 1000;

// Parse the timestamp shapes Thai slip providers actually return: ISO
// ("2026-06-11T09:30:00+07:00"), "YYYY-MM-DD HH:mm:ss", bare dates, epoch
// millis, and SlipOK's compact "20260611". Buddhist-era years (พ.ศ. 2569)
// appear in some bank payloads — convert them so a BE date isn't read as
// 543 years in the future. Returns a Date, or null when unparseable.
function parseSlipTransDate(raw) {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  let s = String(raw || '').trim();
  if (!s) return null;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (compact) s = `${compact[1]}-${compact[2]}-${compact[3]}`;
  // "YYYY-MM-DD HH:mm:ss" → ISO-ish so it parses as local (Asia/Bangkok)
  if (/^\d{4}-\d{2}-\d{2} \d/.test(s)) s = s.replace(' ', 'T');
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getFullYear() >= 2400) d.setFullYear(d.getFullYear() - 543);
  return d;
}

/**
 * Freshness verdict on a slip's bank-transaction timestamp. Pure —
 * exported so the window/parsing rules are unit-testable.
 *
 * @param {*} transDate - provider-returned timestamp (any shape)
 * @param {Object} [opts]
 * @param {Date}   [opts.now]           - injection point for tests
 * @param {number} [opts.maxAgeDays]    - look-back window (default 7)
 * @param {number} [opts.maxFutureDays] - forward skew allowance (default 1)
 * @returns {{ outcome: 'fresh'|'stale'|'future'|'unreadable', ageDays?: number }}
 */
function assessSlipTransDate(transDate, { now, maxAgeDays, maxFutureDays } = {}) {
  const parsed = parseSlipTransDate(transDate);
  if (!parsed) return { outcome: 'unreadable' };
  const ref = now instanceof Date ? now : new Date();
  const back = Number.isFinite(Number(maxAgeDays)) && Number(maxAgeDays) > 0
    ? Number(maxAgeDays) : SLIP_MAX_AGE_DAYS;
  const fwd = Number.isFinite(Number(maxFutureDays)) && Number(maxFutureDays) >= 0
    ? Number(maxFutureDays) : SLIP_MAX_FUTURE_DAYS;
  const ageDays = (ref.getTime() - parsed.getTime()) / DAY_MS;
  if (ageDays > back) return { outcome: 'stale', ageDays: Math.floor(ageDays) };
  if (ageDays < -fwd) return { outcome: 'future', ageDays: Math.floor(ageDays) };
  return { outcome: 'fresh', ageDays: Math.floor(ageDays) };
}

function normalizeHttpBaseUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  // SSRF guard: require https + reject internal/reserved hosts. This is a
  // payment-verification API the tenant slip-upload path calls with a bearer
  // token, so an internal target would leak the token + enable blind SSRF.
  const parsed = ssrfGuard.assertSafeUrl(withScheme);
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function endpointFromBase(baseUrl, path) {
  const normalized = normalizeHttpBaseUrl(baseUrl);
  if (!normalized) throw new Error('SLIP2GO_API_URL not configured');
  return new URL(path, normalized + '/');
}

function requestModuleFor(endpoint) {
  return endpoint.protocol === 'http:' ? http : https;
}

function providerConfigProblems(id, meta) {
  const missing = meta.keys.filter((k) => !secrets.get(k));
  const invalid = [];
  if (missing.length === 0 && id === 'slip2go') {
    try {
      normalizeHttpBaseUrl(secrets.get('SLIP2GO_API_URL'));
    } catch {
      invalid.push('SLIP2GO_API_URL');
    }
  }
  return { missing, invalid };
}

function isProviderReady(id, meta) {
  const problems = providerConfigProblems(id, meta);
  return problems.missing.length === 0 && problems.invalid.length === 0;
}

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
    if (!isProviderReady(id, meta)) continue;
    out.push({ id, label: meta.label });
  }
  return out;
}

/**
 * Audit the provider config and surface every problem (unknown provider
 * names, missing keys). Used by health check + /api/admin/billing-readiness
 * so operators can see WHY auto-verify is silent instead of just "not
 * configured". Returns:
 *   { ready: [{id,label}], unknown: ['slipo'], missingKeys: [{id,keys:[]}] }
 * Empty arrays mean "no problem in that bucket".
 */
function auditProviders(features) {
  const ready = [];
  const unknown = [];
  const missingKeys = [];
  if (!features?.slipUpload?.autoVerify) {
    return { ready, unknown, missingKeys, autoVerifyEnabled: false };
  }
  const raw = features.slipUpload.providers
    || (features.slipUpload.provider ? [features.slipUpload.provider] : []);
  if (!Array.isArray(raw)) return { ready, unknown, missingKeys, autoVerifyEnabled: true };
  const seen = new Set();
  for (const id of raw) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    const meta = PROVIDERS[id];
    if (!meta) {
      unknown.push(id);
      continue;
    }
    const problems = providerConfigProblems(id, meta);
    const missing = [
      ...problems.missing,
      ...problems.invalid.map((k) => `${k} (invalid URL)`),
    ];
    if (missing.length) {
      missingKeys.push({ id, label: meta.label, keys: missing });
    } else {
      ready.push({ id, label: meta.label });
    }
  }
  return { ready, unknown, missingKeys, autoVerifyEnabled: true };
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
 * @param {string}  providerId - 'slipok' | 'easyslip' | 'slip2go'
 * @param {Buffer}  buffer     - slip image bytes (jpg/png/webp/pdf)
 * @param {Object}  expected   - { amount, promptpayTarget, billId,
 *                                 maxSlipAgeDays?, providerExactAmountCheck? }
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
    else if (providerId === 'slip2go') result = await verifyViaSlip2Go(buffer, expected);
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
  // Shared with /api/tenant/payments, /api/payments/:id/verify, etc. so
  // a tightening here automatically applies everywhere. See services/billing.js.
  const { PAYMENT_TOLERANCE_THB } = require('./billing');
  const slipAmt = Number(result.amount);
  const expAmt = Number(expected.amount);
  // A non-finite slip amount must FAIL this check, not skip it: Math.abs(NaN) >
  // tol is false, so a provider returning ok:true with a missing/garbage amount
  // would otherwise bypass the amount cross-check entirely and let an unrelated
  // slip mark a bill paid. Reject unless BOTH amounts are finite AND within tol.
  if (!Number.isFinite(slipAmt) || !Number.isFinite(expAmt)
      || Math.abs(slipAmt - expAmt) > PAYMENT_TOLERANCE_THB) {
    const slipShown = Number.isFinite(slipAmt)
      ? `฿${slipAmt.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`
      : '(อ่านยอดจากสลิปไม่ได้)';
    const expShown = Number.isFinite(expAmt)
      ? `฿${expAmt.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`
      : '(ไม่ทราบยอดบิล)';
    return {
      ok: false,
      error: `ยอดไม่ตรง — สลิปแสดง ${slipShown} แต่บิลนี้ ${expShown}`,
      code: 'AMOUNT_MISMATCH',
      transRef: result.transRef,
      amount: result.amount,
      raw: result.raw,
      provider: providerId,
    };
  }
  // Receiver account match — providers mask leading digits ("xxx-xxx-1234")
  // so we can only compare the tail. We used to compare the last 4 digits
  // alone, which has a ~1-in-10,000 collision chance (a tenant's friend's
  // PromptPay ending in the same 4 digits would silently pass). Now we
  // compare as many digits as both sides provide, up to the last 6, and
  // refuse to verify when the provider returned fewer than 4 (too short
  // to be a meaningful tail — could be all-zero placeholder).
  // Build the set of acceptable receiver tails. Operators can publish
  // BOTH a PromptPay number AND a regular bank account on the invoice
  // (config.payment.promptpay + config.payment.bankAcc). A tenant who
  // copies the bank account number instead of scanning the PromptPay QR
  // will produce a slip whose receiver.account is the bank account, NOT
  // the PromptPay digits — so we need to accept either. Caller passes
  // any extras via expected.additionalReceiverTargets. Entries may be raw
  // strings or objects ({ target/account/phone, method }) so callers can
  // audit which visible payment channel actually matched the slip.
  const acceptableTargets = [];
  const addAcceptableTarget = (value, meta = {}) => {
    const raw = value && typeof value === 'object'
      ? (value.target || value.account || value.phone || value.value)
      : value;
    const digits = String(raw || '').replace(/[^0-9]/g, '');
    if (!digits) return;
    acceptableTargets.push({
      digits,
      method: meta.method || (value && typeof value === 'object' ? value.method : null) || null,
      label: meta.label || (value && typeof value === 'object' ? value.label : null) || null,
    });
  };
  if (expected.promptpayTarget) addAcceptableTarget(expected.promptpayTarget, { method: 'promptpay', label: 'PromptPay' });
  if (Array.isArray(expected.additionalReceiverTargets)) {
    for (const t of expected.additionalReceiverTargets) {
      addAcceptableTarget(t);
    }
  }

  const tailCheck = matchReceiverTail({
    acceptableTargets,
    actualAccount: result.receiver?.account,
    strict: expected.strictReceiverTail === true,
  });
  if (tailCheck.outcome === 'unreadable') {
    return {
      ok: false,
      error: tailCheck.reason === 'insufficient_digits'
        ? `เลขบัญชีบนสลิปถูกปิดบังจนเทียบไม่ได้ (อ่านได้ ${tailCheck.revealedDigits} หลัก) — ส่งเข้าคิวแอดมินตรวจยืนยัน`
        : 'ไม่สามารถยืนยันบัญชีปลายทางจากสลิปได้ — ส่งเข้าคิวแอดมินตรวจยืนยัน',
      code: 'RECEIVER_UNREADABLE',
      transRef: result.transRef,
      amount: result.amount,
      raw: result.raw,
      provider: providerId,
    };
  }
  if (tailCheck.outcome === 'mismatch') {
    return {
      ok: false,
      error: `บัญชีปลายทางไม่ใช่ของหอพัก — สลิปจ่ายไปที่บัญชีลงท้าย ${tailCheck.actualTail} ` +
             `แต่หอพักรับที่บัญชีลงท้าย ${tailCheck.expectedTails.join(' หรือ ')}`,
      code: 'RECEIVER_MISMATCH',
      transRef: result.transRef,
      raw: result.raw,
      provider: providerId,
    };
  }
  if (tailCheck.outcome === 'weak') {
    // Receiver matched, but on fewer digits than strict mode demands. The
    // slip is PROBABLY fine — park for a human instead of auto-verifying
    // (TRANSIENT code: the fallback chain may try a provider that returns
    // more digits, and the upload endpoint maps it to 'pending', never to
    // a tenant-facing rejection).
    return {
      ok: false,
      error: `บัญชีปลายทางตรงเพียง ${tailCheck.detail.compareLen} หลักที่อ่านได้ (โหมดเข้มงวดต้องการ 6) — ส่งเข้าคิวแอดมินตรวจยืนยัน`,
      code: 'RECEIVER_TAIL_WEAK',
      transRef: result.transRef,
      amount: result.amount,
      receiverMatch: tailCheck.detail,
      raw: result.raw,
      provider: providerId,
    };
  }
  if (tailCheck.outcome === 'match') {
    result.receiverMatch = tailCheck.detail;
  }
  // Transaction-date freshness — see assessSlipTransDate. Runs LAST so the
  // harder evidence (wrong amount / wrong account) wins the error the
  // tenant sees. DATE_MISMATCH is TRANSIENT: the slip parks in the admin
  // queue instead of hard-rejecting, because a stale date can be either a
  // replayed old slip or a genuine payment uploaded late — a human decides.
  const dateCheck = assessSlipTransDate(result.transDate, {
    maxAgeDays: expected.maxSlipAgeDays,
  });
  if (dateCheck.outcome !== 'fresh') {
    const why = dateCheck.outcome === 'stale'
      ? `สลิปนี้เป็นรายการโอนเก่า (ประมาณ ${dateCheck.ageDays} วันก่อน)`
      : dateCheck.outcome === 'future'
        ? 'เวลารายการในสลิปอยู่ในอนาคต'
        : 'อ่านเวลารายการจากสลิปไม่ได้';
    return {
      ok: false,
      error: `${why} — ส่งเข้าคิวแอดมินตรวจยืนยัน`,
      code: 'DATE_MISMATCH',
      transRef: result.transRef,
      amount: result.amount,
      transDate: result.transDate,
      raw: result.raw,
      provider: providerId,
    };
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
  const bodyFields = {
    files: 'data:image/jpeg;base64,' + buffer.toString('base64'),
    log: true,
  };
  // Provider-side amount matching is EXACT equality on SlipOK's side, which
  // would hard-reject the bank-rounding drift (±0.25–1฿) that
  // PAYMENT_TOLERANCE_THB (services/billing.js) requires every enforcement
  // point to accept — so it's opt-in. verifyOne's local ±tolerance
  // cross-check on the provider-read amount stays canonical.
  if (expected?.providerExactAmountCheck === true) bodyFields.amount = expected.amount;
  const body = JSON.stringify(bodyFields);

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
            //
            // 5xx (and 4xx without a SlipOK error code) means SlipOK itself
            // is having trouble — classify as PROVIDER_ERROR so the
            // multi-provider fallback chain keeps going to EasySlip/Slip2Go.
            // Previously a SlipOK 503 was tagged SLIPOK_REJECT, which the
            // fallback treated as "tenant fault, stop trying" — so a
            // SlipOK outage left tenants unable to upload slips even
            // though other providers were configured.
            const isProviderError = res.statusCode >= 500
              || (res.statusCode >= 400 && !j.code);
            resolve({
              ok: false,
              error: j.message || j.error || `SlipOK HTTP ${res.statusCode}`,
              code: isProviderError ? 'PROVIDER_ERROR' : (j.code || 'SLIPOK_REJECT'),
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
// API: POST https://api.easyslip.com/v2/verify/bank
// Headers: Authorization: Bearer <api-key>
// Body: multipart/form-data with file field "image"
//
// Mirrors the SlipOK shape so the caller doesn't care which provider
// is wired — both return { transRef, amount, sender, receiver, transDate }.
async function verifyViaEasySlip(buffer, expected) {
  const apiKey = secrets.get('EASYSLIP_API_KEY');
  if (!apiKey) throw new Error('EASYSLIP_API_KEY not configured');
  const expectedAmount = Number(expected?.amount);
  const fields = { checkDuplicate: 'true' };
  // matchAmount is EXACT equality on EasySlip's side — opt-in only, or a
  // slip with ordinary bank rounding (±0.25–1฿) would fail their check and
  // hard-reject what the ±PAYMENT_TOLERANCE_THB contract (services/
  // billing.js) accepts. verifyOne's local cross-check stays canonical.
  if (expected?.providerExactAmountCheck === true
      && Number.isFinite(expectedAmount) && expectedAmount > 0) {
    fields.matchAmount = String(expectedAmount);
  }
  if (expected?.billId !== undefined && expected?.billId !== null) {
    fields.remark = `bill:${String(expected.billId).slice(0, 240)}`;
  }
  // EasySlip's matchAccount checks accounts registered inside EasySlip.
  // Keep it opt-in; our local PromptPay tail check remains canonical.
  if (expected?.easyslipMatchAccount === true) {
    fields.matchAccount = 'true';
  }
  const mime = detectImageMime(buffer);
  const { body, contentType } = buildMultipartForm({
    fields,
    file: {
      name: 'image',
      filename: `slip.${imageExtFromMime(mime)}`,
      mime,
      buffer,
    },
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.easyslip.com',
      path: '/v2/verify/bank',
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': body.length,
        'Authorization': 'Bearer ' + apiKey,
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (res.statusCode !== 200 || j.success !== true || !j.data) {
            const providerCode = j.error?.code || j.code || null;
            // 401/403/429 are operator-side problems (expired/invalid key,
            // plan quota, rate limit) — never evidence the tenant's slip is
            // bad. EasySlip puts the detail in `message`, not `code`, so
            // without this they'd fall through to EASYSLIP_REJECT: a hard
            // reject that stops the provider fallback chain and shows the
            // tenant a fake-slip message. Classify as PROVIDER_ERROR
            // (transient) so the chain continues / the slip parks in the
            // admin queue — mirrors mapSlip2GoRejectCode's 429 handling.
            const operatorSide = res.statusCode >= 500
              || res.statusCode === 401
              || res.statusCode === 403
              || res.statusCode === 429;
            resolve({
              ok: false,
              error: j.error?.message || j.message || `EasySlip HTTP ${res.statusCode}`,
              code: operatorSide ? 'PROVIDER_ERROR' : (providerCode || 'EASYSLIP_REJECT'),
              raw: j,
            });
            return;
          }
          const d = j.data;
          const rawSlip = d.rawSlip || {};
          const transRef = rawSlip.transRef || d.transRef || rawSlip.payload || d.payload;
          const amount = Number(d.amountInSlip ?? rawSlip.amount?.amount ?? rawSlip.amount ?? d.amount);
          if (!transRef || !Number.isFinite(amount)) {
            // Provider answered 200 but the response shape is incomplete —
            // we don't know if the slip is genuine or if EasySlip changed
            // their field names. Classify as PROVIDER_ERROR (transient) so
            // the slip falls into the admin review queue instead of telling
            // the tenant their slip is fake. Tenants who genuinely paid
            // shouldn't have their bill stranded because of a provider-side
            // schema drift.
            resolve({
              ok: false,
              error: 'EasySlip response missing transaction reference or amount',
              code: 'PROVIDER_ERROR',
              raw: j,
            });
            return;
          }
          if (d.isDuplicate === true) {
            resolve({
              ok: false,
              error: 'สลิปนี้ถูกตรวจสอบหรือใช้งานแล้ว',
              code: 'DUPLICATE_SLIP',
              transRef,
              amount: Number.isFinite(amount) ? amount : undefined,
              raw: j,
            });
            return;
          }
          resolve({
            ok: true,
            transRef,
            amount,
            sender: mapProviderParty(rawSlip.sender),
            receiver: mapProviderParty(rawSlip.receiver, d.matchedAccount),
            transDate: rawSlip.date || d.date,
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

function buildSlip2GoReceiver(expected) {
  const digits = String(expected?.promptpayTarget || '').replace(/[^0-9]/g, '');
  if (!digits) return null;
  const out = { accountNumber: digits };
  if (/^0\d{9}$/.test(digits)) out.accountType = '02001';      // PromptPay phone
  else if (/^\d{13}$/.test(digits)) out.accountType = '02003'; // PromptPay citizen ID
  return out;
}

function mapSlip2GoRejectCode(code, httpStatus) {
  const c = String(code || '');
  if (httpStatus === 429 || httpStatus >= 500) return 'PROVIDER_ERROR';
  if (c === '200401') return 'RECEIVER_MISMATCH';
  if (c === '200402') return 'AMOUNT_MISMATCH';
  if (c === '200403') return 'DATE_MISMATCH';
  if (c === '200501') return 'DUPLICATE_SLIP';
  if (c === '200404' || c === '200500') return 'SLIP2GO_REJECT';
  return c || 'SLIP2GO_REJECT';
}

// === Provider: Slip2Go ===================================================
// API: POST {SLIP2GO_API_URL}/api/verify-slip/qr-image/info
// Headers: Authorization: Bearer <secretKey>
// Body: multipart/form-data with "file" image and "payload" JSON string.
async function verifyViaSlip2Go(buffer, expected) {
  const apiKey = secrets.get('SLIP2GO_API_KEY');
  if (!apiKey) throw new Error('SLIP2GO_API_KEY not configured');
  const endpoint = endpointFromBase(secrets.get('SLIP2GO_API_URL'), '/api/verify-slip/qr-image/info');
  // Re-validate at request time WITH DNS resolution — this path is reachable
  // by any tenant uploading a slip, so a hostname that (re)resolves to an
  // internal IP must be blocked before we send the bearer token to it.
  await ssrfGuard.assertSafeUrlResolved(endpoint.href);
  const expectedAmount = Number(expected?.amount);
  const payload = { checkDuplicate: true };
  // checkAmount type 'eq' is EXACT equality on Slip2Go's side (their 200402
  // → AMOUNT_MISMATCH is a hard reject) — opt-in only, or bank-rounded
  // slips (±0.25–1฿) would be rejected where the ±PAYMENT_TOLERANCE_THB
  // contract (services/billing.js) accepts them. verifyOne's local
  // cross-check stays canonical.
  if (expected?.providerExactAmountCheck === true
      && Number.isFinite(expectedAmount) && expectedAmount > 0) {
    payload.checkAmount = { type: 'eq', amount: Number(expectedAmount.toFixed(2)) };
  }
  if (expected?.slip2goCheckReceiver === true) {
    const receiver = buildSlip2GoReceiver(expected);
    if (receiver) payload.checkReceiver = [receiver];
  }
  const mime = detectImageMime(buffer);
  const { body, contentType } = buildMultipartForm({
    fields: { payload: JSON.stringify(payload) },
    file: {
      name: 'file',
      filename: `slip.${imageExtFromMime(mime)}`,
      mime,
      buffer,
    },
  });

  return new Promise((resolve, reject) => {
    const req = requestModuleFor(endpoint).request({
      hostname: endpoint.hostname,
      port: endpoint.port || undefined,
      path: endpoint.pathname + endpoint.search,
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': body.length,
        'Authorization': 'Bearer ' + apiKey,
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          const responseCode = String(j.code || '');
          const d = j.data || {};
          if (res.statusCode !== 200 || !['200000', '200200'].includes(responseCode) || !j.data) {
            resolve({
              ok: false,
              error: j.message || `Slip2Go HTTP ${res.statusCode}`,
              code: mapSlip2GoRejectCode(responseCode, res.statusCode || 0),
              transRef: d.transRef || d.referenceId,
              amount: Number.isFinite(Number(d.amount)) ? Number(d.amount) : undefined,
              raw: j,
            });
            return;
          }
          const transRef = d.transRef || d.referenceId || d.decode;
          const amount = Number(d.amount);
          if (!transRef || !Number.isFinite(amount)) {
            // 200 OK + incomplete shape — same reasoning as the EasySlip
            // case above: don't accuse the tenant of a fake slip when the
            // problem is on the provider side. Fall back to admin queue.
            resolve({
              ok: false,
              error: 'Slip2Go response missing transaction reference or amount',
              code: 'PROVIDER_ERROR',
              raw: j,
            });
            return;
          }
          resolve({
            ok: true,
            transRef,
            amount,
            sender: mapProviderParty(d.sender),
            receiver: mapProviderParty(d.receiver),
            transDate: d.dateTime || d.transDate || d.verifyDate,
            raw: j,
          });
        } catch (e) {
          resolve({ ok: false, error: 'Slip2Go response parse failed: ' + e.message, code: 'SLIP2GO_PARSE', raw: buf.slice(0, 500) });
        }
      });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(new Error('Slip2Go timeout (10s)')); });
    req.write(body);
    req.end();
  });
}

module.exports = {
  verify,
  verifyWithFallback,
  isConfigured,
  getConfiguredProviders,
  auditProviders,
  probeAll,
  // Pure tail matcher — exported for unit tests so the comparison rules
  // (mask handling, 6-digit cap, strict weak-match downgrade) are pinned
  // without a live provider call.
  matchReceiverTail,
  // Pure date-freshness verdict — exported for unit tests so the window,
  // BE-year conversion, and compact-format parsing are pinned.
  assessSlipTransDate,
  // Exported so server.js (and any future caller) can reuse the same set
  // without re-declaring it. A drift between server.js's local copy and the
  // verifier's would silently mis-classify rejections — a 'UNKNOWN_PROVIDER'
  // reply (admin typo) would become a hard reject instead of falling through.
  TRANSIENT_CODES,
};
