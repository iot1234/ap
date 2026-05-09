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
    // requirePin used to live here but had no effect — the login flow always
    // forced PIN regardless of the flag. Removed so the Features page can't
    // mislead operators into thinking they can disable it. If a future build
    // wants to support magic-link or OTP login as an alternative to PIN, add
    // it back AND wire it into routes/tenant-ops + server.js's /api/tenant/login.
    sessionDays: 30,
  },
  slipUpload: {
    enabled: false,
    requireVerification: true,   // admin must verify before bill is marked paid
    maxBytes: 1_500_000,         // 1.5MB base64 budget
    allowedMimes: ['image/jpeg', 'image/png', 'image/webp'],
    // Auto-verify: when ON + a provider is configured (SLIPOK_API_KEY or
    // EASYSLIP_API_KEY in secrets), uploaded slips are sent to that service
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
    provider: 'slipok',          // 'slipok' | 'easyslip' (operator choice)
  },
  photoUpload: {
    enabled: true,
    maxBytes: 1_500_000,
    storage: 'local',            // local | s3
  },
  meterIot: {
    enabled: false,
    mode: 'manual',              // manual | simulator | mqtt
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
  billAutoGenerate: {
    enabled: false,
    dayOfMonth: 1,               // run on the 1st of each month
    dueDay: 15,                   // due on the 15th
  },
});

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over)) {
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
        return res.status(503).json({ error: `feature ${name} is disabled` });
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

module.exports = { DEFAULTS, FEATURES_KEY, load, save, requireFeature, attach, withDefaults };
