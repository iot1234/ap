// services/features.js
// Feature flag system. All new features are gated by flags stored in
// app_data['baankarn_features_v1'] (JSONB). Admin can toggle each flag from
// the Features page. Server reads flags fresh on each request (no cache —
// the JSONB read is cheap and avoids stale state after toggles).
//
// Each flag is one object: { enabled: boolean, ...config }.
// Adding a new flag: add it to DEFAULTS below + a UI row in
// project/admin/page-features.jsx.

const FEATURES_KEY = 'baankarn_features_v1';

// Built-in defaults. The DB row, when present, is shallow-merged on top so
// a deployed instance gets new flags automatically without manual migration.
const DEFAULTS = Object.freeze({
  tenantPortal: {
    enabled: false,
    // requirePin used to live here but had no reliable effect. Tenant portal
    // login is phone-only and limited to active tenants with a current room.
    // Do not add a UI toggle unless the server flow is actually wired for it.
    sessionDays: 30,
  },
  slipUpload: {
    enabled: false,
    requireVerification: true,   // admin must verify before bill is marked paid
    maxBytes: 1_500_000,         // 1.5MB base64 budget
    allowedMimes: ['image/jpeg', 'image/png', 'image/webp'],
    // Auto-verify: when ON + a provider is configured (SLIPOK_API_KEY,
    // EASYSLIP_API_KEY, or SLIP2GO_API_KEY + SLIP2GO_API_URL in secrets),
    // uploaded slips are sent to that service
    // for instant verification. Bills auto-flip to paid + tenant gets a
    // "ชำระเงินสำเร็จ" push within seconds — no admin step needed for the
    // happy path. Safety: receiver-account match + amount match + DB
    // transaction_ref uniqueness are checked before accepting.
    // requireVerification still acts as a server-side override — when ON,
    // even auto-verified slips can be set to 'pending' instead of 'verified'
    // (operator chooses). Sensible production combo:
    //   autoVerify: true, requireVerification: false  → fully automatic
    //   autoVerify: true, requireVerification: true   → auto-verify is
    //     advisory; admin still confirms (paranoid mode)
    autoVerify: false,
    provider: 'slipok',          // 'slipok' | 'easyslip' | 'slip2go' (operator choice)
    // Emergency/legacy escape hatch only. When false, uploaded slips stay in
    // the admin queue unless a configured provider actually verifies them.
    allowUnverifiedAutoApprove: false,
  },
  photoUpload: {
    enabled: true,
    maxBytes: 1_500_000,
    storage: 'local',            // local | s3
  },
  roomBooking: {
    enabled: true,
    // Public booking deposit. When requireDeposit=true, the public form
    // must hold a specific room, collect exactly this booking fee, and
    // attach a slip before the booking becomes pending for admin review.
    requireDeposit: false,
    depositAmount: 500,
    minimumAmount: 0,             // 0 = no minimum; positive values are at least 1 baht
    applyBookingFeeToDeposit: false,
    requireSlip: true,
    holdMinutes: 15,
    maxBytes: 1_500_000,
    allowedMimes: ['image/jpeg', 'image/png', 'image/webp'],
  },
  meterIot: {
    enabled: false,
    mode: 'manual',              // manual | simulator; mqtt is reserved until integration exists
    anomalySigmas: 3,            // alert when reading > 3σ from rolling avg
  },
  accessControl: {
    enabled: false,
    requirePaymentForCard: true, // disable card after 30+ days overdue
    overdueDaysThreshold: 30,    // how many days past due before card auto-revoked
  },
  recurringCharges: {
    enabled: false,              // parking, internet, etc. line items per tenant
    autoIncludeOnBillGen: true,  // when true, scheduler/manual bill includes active rows
  },
  lateFee: {
    enabled: true,
    ratePctPerMonth: 1.5,
    gracePeriodDays: 7,
  },
  vat: {
    enabled: false,
    ratePct: 7,
  },
  email: {
    enabled: false,
    from: '',
    smtpHost: '',
    smtpPort: 587,
    smtpUser: '',
    // smtpPass is read from process.env.SMTP_PASS — never persisted in DB.
  },
  sms: {
    enabled: false,
    provider: 'thsms',           // thsms | twilio
    // SMS provider SDK is NOT bundled — neither `twilio` nor any thsms client
    // is in package.json. Toggling this on alone changes nothing visible:
    // services/sms.isConfigured() returns false until an operator runs
    // `npm i twilio` (or installs a thsms client) and supplies credentials
    // via the secrets registry. Surfaced in the admin Features page as
    // "needs operator install" so this isn't surprising.
    requiresOperatorSetup: true,
  },
  i18n: {
    enabled: true,
    defaultLocale: 'th',         // th | en
    available: ['th', 'en'],
  },
  darkMode: {
    enabled: true,
    // Currently consumed by the tenant portal (tenant.jsx) only — admin
    // shell does not implement a dark theme, so toggling this OFF only
    // hides the tenant-side switch. Marked here so the Features page can
    // surface scope honestly.
    scope: 'tenant',
  },
  softDelete: {
    enabled: true,               // delete keeps row + sets deleted_at
  },
  citizenIdEncryption: {
    enabled: true,               // ALWAYS recommended on; can disable in dev
  },
  errorTracking: {
    enabled: false,
    // dsn read from SENTRY_DSN env
  },
  autoBackup: {
    enabled: false,
    hourUtc: 19,                 // 02:00 ICT = 19:00 UTC
    retainDays: 30,
  },
  // Auto-reconcile stranded rooms. When enabled, the daily scheduler tick
  // automatically closes orphan active contracts and frees room state when
  // the orphan tenant is ALREADY moved_out (the unambiguous case). Disabled
  // by default — operators should review the first few cycles' alerts to
  // see what would have been auto-fixed before flipping this on. Detection
  // + owner notification ALWAYS run regardless of this flag (so an operator
  // who never opens /admin#health still finds out about stranded rooms via
  // the daily owner message + Health → Anomaly LINE alert).
  autoReconcileRooms: {
    enabled: false,
  },
  billAutoGenerate: {
    enabled: false,
    dayOfMonth: 1,               // run on the 1st of each month
    // dueDay lives in config.notify.dueOnDay so manual + auto share it.
  },
  // R7 — daily pre-due payment reminder. Default OFF so existing deploys
  // don't suddenly start sending extra LINE pushes to tenants without an
  // explicit opt-in. Once enabled, the scheduler.tickPaymentReminder pings
  // tenants whose bill's due_date matches CURRENT_DATE + offset for each
  // offset in `daysBeforeDue`. Idempotent per day via bills.last_reminded_at.
  paymentReminder: {
    enabled: false,
    // [3, 0] = remind 3 days before due, then on the due date itself.
    // Operators wanting an earlier nudge can pass [7, 3, 0]; safety-clamped
    // to integers in [0, 30] (negatives are "overdue" territory handled by
    // tickLateFee; >30 days is almost always a typo on a ~15-day bill window).
    daysBeforeDue: [3, 0],
    // When true, also remind tenants daily for bills already in 'overdue'
    // status until paid. Default false because tickLateFee already handles
    // the flip-day notification + access-sync covers card-suspension warnings
    // — a third daily channel often crosses into "harassment" territory.
    includeOverdue: false,
  },
  // Tenancy contract / identity capture defaults. These describe the
  // safety guards admin can tune from the Features page — none of them
  // require new code paths to function, they just adjust how strict the
  // checkin endpoint is.
  tenancyContract: {
    enabled: true,
    // Require citizen-ID front + back image to be uploaded BEFORE checkin
    // succeeds. ON by default — Thai dormitory law requires landlords to
    // keep tenant ID on file. Turn off only for migration / legacy rows.
    requireIdentityImages: true,
    // Require an emergency contact (name + phone) on the tenant row before
    // checkin. ON because losing tenant contact in an emergency is the
    // single most common operations failure for small dorms.
    requireEmergencyContact: true,
    // Require an address on the tenant row. ON because the contract PDF
    // wouldn't have a "current address" field otherwise.
    requireAddress: true,
    // moveInDate sanity window — reject anything outside [today - past, today + future] days.
    // Default: 30 days back / 90 days forward. Catches typos like "2026"
    // when admin meant "2025" while still allowing back-fill of a missed
    // checkin (last week) and a planned future move-in (next month).
    moveInPastDays: 30,
    moveInFutureDays: 90,
    // Deposit must be ≤ depositMaxMonths × monthlyRent. Default = 3 months
    // (typical Thai practice: 1-2 months deposit). admin.force bypasses.
    depositMaxMonths: 3,
    // Current terms-and-conditions version string. Stamped on tenants /
    // contracts at the moment of checkin so a future T&C revision doesn't
    // retroactively bind existing tenants. Operator updates this string
    // each time the displayed T&C document changes.
    termsVersion: 'v1.0-2026-01',
  },
});

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over)) {
    // Defence-in-depth against prototype pollution. The PUT /api/admin/features
    // route already rejects these keys, but features.save/withDefaults can be
    // reached from other callers (restore, future code) — never let a stored
    // blob walk the prototype chain during merge.
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const a = base ? base[k] : undefined;
    const b = over[k];
    if (a && typeof a === 'object' && !Array.isArray(a) && b && typeof b === 'object' && !Array.isArray(b)) {
      out[k] = deepMerge(a, b);
    } else {
      out[k] = b;
    }
  }
  return out;
}

function withDefaults(stored) {
  return deepMerge(DEFAULTS, stored || {});
}

/**
 * Load the feature flag map. Always returns a complete object — keys
 * missing in the DB row come from DEFAULTS.
 * @param {import('pg').Pool} pool
 */
async function load(pool) {
  try {
    const { rows } = await pool.query(
      'SELECT value FROM app_data WHERE key=$1',
      [FEATURES_KEY]
    );
    return withDefaults(rows.length ? rows[0].value : null);
  } catch (err) {
    console.error('[features] load failed, using defaults:', err.message);
    return { ...DEFAULTS };
  }
}

/**
 * Save merged flags. The row always contains the full computed object so
 * an admin can read it back unchanged.
 */
async function save(pool, partial, updatedBy) {
  const current = await load(pool);
  const next = deepMerge(current, partial || {});
  await pool.query(
    `INSERT INTO app_data (key, value, updated_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE
         SET value=EXCLUDED.value, updated_at=NOW(), updated_by=EXCLUDED.updated_by`,
    [FEATURES_KEY, JSON.stringify(next), updatedBy || 'system']
  );
  return next;
}

function disabledPayload(name, req) {
  const label = {
    tenantPortal: 'Tenant portal',
    slipUpload: 'Slip upload',
    photoUpload: 'Photo upload',
    roomBooking: 'Room booking',
    meterIot: 'Meter readings',
    accessControl: 'Access control',
    recurringCharges: 'Recurring charges',
  }[name] || name;
  const out = {
    error: `feature ${name} is disabled`,
    code: 'FEATURE_DISABLED',
    feature: name,
    enabled: false,
    message: `${label} is disabled by feature flag`,
    hint: 'Enable this feature in /admin#features before using this endpoint.',
  };
  if (req && req.id) out.requestId = req.id;
  return out;
}

/**
 * Convenience: middleware factory. Returns 503 if the named flag is off.
 *   app.post('/api/slips', requireFeature('slipUpload'), handler)
 * Mounts the loaded flag map onto req.features for downstream use.
 */
function requireFeature(name) {
  return async function featureGate(req, res, next) {
    try {
      const features = await load(req.app.get('pgPool'));
      req.features = features;
      const flag = features[name];
      if (!flag || flag.enabled !== true) {
        return res.status(503).json(disabledPayload(name, req));
      }
      next();
    } catch (err) {
      console.error('[features] gate error:', err.message);
      res.status(500).json({ error: 'internal error' });
    }
  };
}

/**
 * Read-only middleware: attaches features to req without gating. Use on
 * routes that branch on flags but don't outright require one.
 */
async function attach(req, res, next) {
  try {
    req.features = await load(req.app.get('pgPool'));
    next();
  } catch (err) {
    console.error('[features] attach error:', err.message);
    next();
  }
}

// Hard validation for numeric/enum config in a PARTIAL feature update. Returns
// an array of { flag, field, message } for clearly-invalid values so the admin
// PUT can refuse to persist a config that would break a feature (a typo'd VAT
// rate of 700, a 0-day session, a negative deposit, an out-of-range backup
// hour, …). Only fields PRESENT in the partial are checked — a normal
// { slipUpload: { enabled: true } } toggle validates nothing extra, and saving
// the full DEFAULTS object passes (every default is inside these bounds).
// Defensive: never throws, whatever shape the caller passes.
function validateConfig(partial) {
  const errors = [];
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) return errors;
  const has = (o, k) => o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
  const num = (v) => (v === '' || v == null ? NaN : Number(v));
  const need = (ok, flag, field, message) => { if (!ok) errors.push({ flag, field, message }); };
  const range = (flag, field, v, lo, hi, label, integer) => {
    const n = num(v);
    const okType = integer ? Number.isInteger(n) : Number.isFinite(n);
    need(okType && n >= lo && n <= hi, flag, field, `${flag}.${field} ${label}`);
  };
  const f = partial;
  try {
    if (has(f, 'vat') && has(f.vat, 'ratePct')) range('vat', 'ratePct', f.vat.ratePct, 0, 30, 'ต้องเป็นตัวเลข 0–30 (%)');
    if (has(f, 'lateFee') && has(f.lateFee, 'ratePctPerMonth')) range('lateFee', 'ratePctPerMonth', f.lateFee.ratePctPerMonth, 0, 100, 'ต้องเป็น 0–100 (%/เดือน)');
    if (has(f, 'lateFee') && has(f.lateFee, 'gracePeriodDays')) range('lateFee', 'gracePeriodDays', f.lateFee.gracePeriodDays, 0, 365, 'ต้องเป็นจำนวนเต็ม 0–365 วัน', true);
    if (has(f, 'meterIot') && has(f.meterIot, 'anomalySigmas')) range('meterIot', 'anomalySigmas', f.meterIot.anomalySigmas, 1, 10, 'ต้องเป็น 1–10');
    if (has(f, 'tenantPortal') && has(f.tenantPortal, 'sessionDays')) range('tenantPortal', 'sessionDays', f.tenantPortal.sessionDays, 1, 365, 'ต้องเป็นจำนวนเต็ม 1–365 วัน', true);
    if (has(f, 'roomBooking') && has(f.roomBooking, 'holdMinutes')) range('roomBooking', 'holdMinutes', f.roomBooking.holdMinutes, 1, 1440, 'ต้องเป็นจำนวนเต็ม 1–1440 นาที', true);
    for (const fld of ['depositAmount', 'minimumAmount']) {
      if (has(f, 'roomBooking') && has(f.roomBooking, fld)) range('roomBooking', fld, f.roomBooking[fld], 0, 10_000_000, 'ต้องเป็นตัวเลข 0–10,000,000 บาท');
    }
    if (has(f, 'accessControl') && has(f.accessControl, 'overdueDaysThreshold')) range('accessControl', 'overdueDaysThreshold', f.accessControl.overdueDaysThreshold, 0, 365, 'ต้องเป็นจำนวนเต็ม 0–365 วัน', true);
    if (has(f, 'autoBackup') && has(f.autoBackup, 'hourUtc')) range('autoBackup', 'hourUtc', f.autoBackup.hourUtc, 0, 23, 'ต้องเป็นจำนวนเต็ม 0–23', true);
    if (has(f, 'autoBackup') && has(f.autoBackup, 'retainDays')) range('autoBackup', 'retainDays', f.autoBackup.retainDays, 1, 3650, 'ต้องเป็นจำนวนเต็ม 1–3650 วัน', true);
    if (has(f, 'billAutoGenerate') && has(f.billAutoGenerate, 'dayOfMonth')) range('billAutoGenerate', 'dayOfMonth', f.billAutoGenerate.dayOfMonth, 1, 28, 'ต้องเป็นจำนวนเต็ม 1–28 (เลี่ยงวันที่ 29–31 ที่บางเดือนไม่มี)', true);
    // Upload size caps: 10KB–10MB. A typo here either opens a memory-exhaustion
    // hole (huge) or makes every upload fail (tiny).
    for (const flag of ['slipUpload', 'photoUpload', 'roomBooking']) {
      if (has(f, flag) && has(f[flag], 'maxBytes')) range(flag, 'maxBytes', f[flag].maxBytes, 10_000, 10_000_000, 'ต้องเป็น 10,000–10,000,000 ไบต์', true);
    }
    // Enum checks (meterIot.mode is handled in the route with its own codes).
    if (has(f, 'slipUpload') && has(f.slipUpload, 'provider')) need(['slipok', 'easyslip', 'slip2go'].includes(f.slipUpload.provider), 'slipUpload', 'provider', 'slipUpload.provider ต้องเป็น slipok | easyslip | slip2go');
    if (has(f, 'sms') && has(f.sms, 'provider')) need(['thsms', 'twilio'].includes(f.sms.provider), 'sms', 'provider', 'sms.provider ต้องเป็น thsms | twilio');
    if (has(f, 'i18n') && has(f.i18n, 'defaultLocale')) need(['th', 'en'].includes(f.i18n.defaultLocale), 'i18n', 'defaultLocale', 'i18n.defaultLocale ต้องเป็น th | en');
  } catch { /* never let validation itself throw */ }
  return errors;
}

module.exports = {
  DEFAULTS,
  FEATURES_KEY,
  load,
  save,
  requireFeature,
  attach,
  withDefaults,
  validateConfig,
  disabledPayload,
};
