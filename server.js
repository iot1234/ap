// === Production server: Express + PostgreSQL + sessions ====================
// - Serves static React app from project/
// - REST API: /api/data/:key (GET public, PUT admin-only) backed by JSONB store
// - Auth: /api/auth/login (bcrypt + session), /api/auth/me, /api/auth/logout
// - Schema migration runs on boot; bootstraps single admin user from env vars

const express = require('express');
const path = require('path');
const pg = require('pg');
const { Pool } = pg;
const bcrypt = require('bcryptjs');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { renderBillPdf } = require('./services/pdf');
const { renderQrPng, renderQrDataUrl } = require('./services/promptpay');
const lineNotify = require('./services/line');
const features = require('./services/features');
const cryptoSvc = require('./services/crypto');
const storage = require('./services/storage');
const billing = require('./services/billing');
const notifier = require('./services/notifier');
const meter = require('./services/meter');
const sentry = require('./services/sentry');
const scheduler = require('./services/scheduler');
const { schemas } = require('./schemas');
const { validateBody } = require('./middleware/validate');

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const DATABASE_URL = process.env.DATABASE_URL;
const DISABLE_BACKGROUND_JOBS = process.env.DISABLE_BACKGROUND_JOBS === '1'
  || /^true$/i.test(String(process.env.DISABLE_BACKGROUND_JOBS || ''));
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
// No fallback for SESSION_SECRET / ADMIN_PASSWORD — refusing to boot is
// safer than running with a known-weak default that anyone reading the
// repo can use to sign forged cookies.
const SESSION_SECRET = process.env.SESSION_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// === Production env enforcement (A1) =====================================
// We split into FATAL (refuse to boot) and WARN (log + continue):
//   FATAL: missing/example session secret — actively used to sign every
//     cookie, so weak = forged-cookie attack vector right now.
//   WARN:  weak ADMIN_PASSWORD — only used for the FIRST-RUN bootstrap of
//     the admin row. db/migrate.js refuses to bootstrap with a weak value,
//     so an existing deployment with a real admin row is unaffected.
//     Crash-looping the server here would lock operators out of an
//     otherwise-healthy deployment when they need to fix env vars; better
//     to start, log, and let the operator log in to fix.
const _fatalConfig = [];
const _warnConfig = [];
if (!DATABASE_URL) _fatalConfig.push('DATABASE_URL is not set');
if (NODE_ENV === 'production') {
  // SESSION_SECRET — fatal because it's used live for every cookie.
  if (!SESSION_SECRET) _fatalConfig.push('SESSION_SECRET is required in production (≥ 32 random bytes). Generate: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"');
  else if (SESSION_SECRET.length < 32) _fatalConfig.push('SESSION_SECRET must be ≥ 32 chars');
  else if ([
    'dev-only-change-me',
    'change-me-to-a-long-random-string',
    'change-me',
    'changeme',
    'your-secret-here',
  ].includes(SESSION_SECRET)) {
    _fatalConfig.push('SESSION_SECRET looks like an .env.example placeholder — generate a fresh one');
  }

  // ADMIN_PASSWORD — warn-only because it's only consumed by the first-run
  // bootstrap. After the admin user exists in DB, the env var is no-op.
  if (!ADMIN_PASSWORD && !process.env.SKIP_ADMIN_BOOTSTRAP) {
    _warnConfig.push('ADMIN_PASSWORD is not set — first-run bootstrap will be skipped. Set SKIP_ADMIN_BOOTSTRAP=1 to silence this, or supply a ≥12-char password to seed the first admin.');
  } else if (ADMIN_PASSWORD && ADMIN_PASSWORD.length < 12) {
    _warnConfig.push('ADMIN_PASSWORD is shorter than 12 chars — bootstrap will REFUSE to seed a weak admin. Existing admin users still work normally.');
  } else if (ADMIN_PASSWORD === 'admin1234') {
    _warnConfig.push('ADMIN_PASSWORD is the example value `admin1234` — bootstrap will refuse it. Existing admin users still work.');
  }
}
if (_fatalConfig.length) {
  console.error('FATAL: configuration errors:');
  for (const m of _fatalConfig) console.error('  - ' + m);
  process.exit(1);
}
if (_warnConfig.length) {
  console.warn('[boot] configuration warnings (non-fatal):');
  for (const m of _warnConfig) console.warn('  ⚠ ' + m);
}
// In dev, warn loudly but allow boot.
if (NODE_ENV !== 'production' && !SESSION_SECRET) {
  console.warn('[boot] SESSION_SECRET is not set — using a random ephemeral secret (sessions reset on restart)');
}
const _runtimeSessionSecret = SESSION_SECRET
  || require('crypto').randomBytes(48).toString('base64');

// Keep DATE columns as date-only strings. The pg default can materialise DATE
// as local-midnight Date objects, which JSON serialises to the previous UTC
// day in Asia/Bangkok and breaks <input type="date"> values.
if (pg.types && typeof pg.types.setTypeParser === 'function') {
  pg.types.setTypeParser(1082, (value) => value);
}

// --- Process-level safety nets --------------------------------------------
// Without these, an unhandled async rejection or uncaught exception silently
// crashes the process; Railway will restart but mid-flight requests die.
// We log + exit so the orchestrator restarts cleanly with full context.
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err && err.stack || err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
  process.exit(1);
});

// Sanitize URLs in errors to avoid leaking the DB password in logs.
function sanitizeError(err) {
  const msg = String(err && err.message || err);
  return msg.replace(/(\b[a-z]+:\/\/)[^@\s]+@/gi, '$1***@');
}

// Railway-internal Postgres URLs are plain TCP; external ones use SSL.
// Heuristic: enable SSL only when the host isn't .railway.internal.
const useSSL = !/\.railway\.internal/i.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  max: 10,
  // Without these, a stalled DB causes requests to hang indefinitely instead
  // of returning 503 quickly (so client retries can succeed).
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30_000,
  // statement_timeout: aborts any query running > 10s on the server side, so
  // a buggy slow query can't pin a connection slot. lock_timeout caps how
  // long a transaction will wait for a row/table lock before bailing.
  statement_timeout: 10_000,
  lock_timeout: 5_000,
});

pool.on('error', (err) => console.error('[pg] pool error:', sanitizeError(err)));

// --- Schema migration -----------------------------------------------------
// Delegates to db/migrate.js so the SQL is reusable from tests + scripts.
const dbMigrate = require('./db/migrate');
async function migrate() {
  await dbMigrate.migrate(pool);
}

// --- App setup ------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);
app.set('pgPool', pool);  // exposed for feature middlewares (services/features.js)

// Lightweight correlation ID — every request gets a short id echoed in the
// X-Request-ID response header and prefixed onto any error logs we emit.
// Helps trace a 500 back to a specific request when staring at Railway logs.
let _reqCounter = 0;
app.use((req, res, next) => {
  const id = (Date.now().toString(36) + (_reqCounter++).toString(36)).slice(-10);
  req.id = id;
  res.setHeader('X-Request-ID', id);
  next();
});
// 3MB covers a single base64-encoded image (slip / room photo / signature).
// Lower limit reduces memory pressure under attack — 100 concurrent 30MB
// POSTs vs 3MB makes a 10x difference in worst-case memory. Per-feature
// caps (e.g. slipUpload.maxBytes) further constrain individual fields.
//
// `verify` callback captures the raw body for /webhook/* routes that need
// to compute HMAC over the exact bytes the upstream service sent.
// Re-stringifying req.body would change whitespace + key order and break
// signature verification.
app.use(express.json({
  limit: '3mb',
  verify: (req, _res, buf) => {
    if (req.path && req.path.startsWith('/webhook/')) {
      req.rawBody = buf.toString('utf8');
    }
  },
}));
// cookie-parser must run before csrf-csrf so req.cookies is populated.
app.use(require('cookie-parser')(_runtimeSessionSecret));

// Graceful JSON parse errors instead of stack traces.
app.use((err, _req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid json body' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'request too large (max 3mb)' });
  }
  next(err);
});

// Security headers. CSP is permissive for the React-via-CDN + Babel-standalone
// approach this app uses today; tighten when migrating to a build pipeline.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      // unsafe-eval is required by Babel-standalone runtime (in-browser JSX
      // transpile). Migrate to a build pipeline + script nonces to remove it.
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://unpkg.com'],
      // Block inline event handlers (onclick=…) — modern XSS payloads still
      // try them since 'unsafe-inline' on script-src doesn't allow attrs.
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      // blob: needed by admin PDF download (URL.createObjectURL).
      // connect-src 'self' is enough for fetch; we add blob: defensively
      // so the browser doesn't block the blob URL when assigned to <a href>.
      connectSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  // C14 — strict same-origin (was 'same-origin-allow-popups'). Tightens
  // tabnabbing window: a popup we open can't navigate us back to a phish.
  // PDF preview now opens via download/blob URL not window.open, so the
  // looser policy is no longer needed.
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  hidePoweredBy: true,
}));
app.disable('x-powered-by');

// Rate-limit login attempts per IP — 5 per 15 minutes is plenty for humans
// while frustrating brute-force scripts. Per-account lockout (middleware/
// lockout.js) adds a second layer that survives IP rotation.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many login attempts, try again later' },
});

app.use(
  session({
    // pruneSessionInterval: every hour, delete sessions with expire < NOW().
    // Without this the user_sessions table grows forever in production.
    store: new PgSession({
      pool,
      tableName: 'user_sessions',
      createTableIfMissing: false,
      pruneSessionInterval: 60 * 60, // seconds
    }),
    secret: _runtimeSessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  })
);

// --- Auth middleware ------------------------------------------------------
// Canonical implementation lives in middleware/auth.js (also used by routes/*
// modules). Wired here so every consumer shares the same constants and DB
// lookups — previously this file had a copy-pasted duplicate that drifted.
const { makeAuth } = require('./middleware/auth');
const { requireAuth, requireRole, requireDeviceOrAdmin } = makeAuth(pool);

// --- Audit log helper (Phase B1) ------------------------------------------
// Fire-and-forget insert. Never throws back to caller — audit failures must
// not break the user's request. `userIdOverride` is used by paths that
// don't have a session yet (e.g. failed login: we want to record the
// attempted username).
function clientIp(req) {
  if (req.ip) return req.ip;
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff.split(',')[0].trim();
  return null;
}
async function audit(req, action, entityType, entityId, detail, userIdOverride) {
  try {
    const userId = userIdOverride !== undefined ? userIdOverride
      : (req.session && req.session.user ? req.session.user.username : null);
    const ip = clientIp(req);
    const ua = (req.headers['user-agent'] || '').slice(0, 400);
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail, ip, ua)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [userId, action, entityType || null, entityId || null,
       detail ? JSON.stringify(detail) : null, ip, ua]
    );
  } catch (err) {
    console.error('[audit] log failed:', err.message);
  }
}

// --- Lightweight CSRF defense ---------------------------------------------
// Beyond cookie SameSite=lax, require state-changing requests to carry a
// same-origin Origin OR Referer header. We previously allowed both to be
// empty (legitimate same-origin fetch w/o Origin) but that opened a hole:
// a curl/raw-HTTP request without those headers could still hit endpoints.
// Browsers always send Origin on POST/PUT/DELETE within the same site, so
// requiring at least one is safe for legitimate clients.
function sameOrigin(req, res, next) {
  // GET/HEAD don't change state — skip.
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('origin') || req.get('referer') || '';
  if (!origin) {
    return res.status(403).json({ error: 'missing origin/referer header' });
  }
  try {
    const u = new URL(origin);
    const host = req.get('host');
    if (u.host !== host) {
      return res.status(403).json({ error: 'cross-origin request blocked' });
    }
  } catch {
    return res.status(400).json({ error: 'invalid origin' });
  }
  next();
}

// === CSRF token endpoint (defense-in-depth on top of sameOrigin) =========
// Frontend reads /api/csrf-token, then attaches X-CSRF-Token to every
// state-changing request. The header value must match the cookie set here
// — an off-origin attacker can't read the cookie, so they can't forge.
const { makeCsrf } = require('./middleware/csrf');
const csrf = makeCsrf({
  secret: process.env.CSRF_SECRET || _runtimeSessionSecret,
  secure: NODE_ENV === 'production',
});
app.get('/api/csrf-token', (req, res) => {
  const token = csrf.generateCsrfToken(req, res);
  res.json({ csrfToken: token });
});
// Wrap doubleCsrfProtection with our existing sameOrigin so the order is:
// sameOrigin (cheap origin check) → CSRF token check (cookie+header).
function csrfGuard(req, res, next) {
  // Bearer-auth device requests skip CSRF (they have no cookie jar).
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return next();
  csrf.doubleCsrfProtection(req, res, (err) => {
    if (err) return csrf.csrfErrorHandler(err, req, res, next);
    next();
  });
}

// === Lockout (per-account brute-force defense) ============================
const { makeLockout, LockedOutError } = require('./middleware/lockout');
const lockout = makeLockout(pool);
// Bcrypt-shaped placeholder used so every login attempt does the same work
// regardless of whether the user exists. A2 — gates timing-attack
// enumeration of valid usernames.
const DUMMY_HASH = '$2a$10$' + 'X'.repeat(53);

// === Trivial-PIN reject (A6) =============================================
// Single source of truth in services/pinPolicy.js — also used by
// routes/tenant-ops.js so the two paths can't drift.
const { TRIVIAL_PINS_4, isTrivialPin } = require('./services/pinPolicy');

// --- Auth endpoints -------------------------------------------------------
app.post('/api/auth/login', sameOrigin, loginLimiter, validateBody(schemas.login), async (req, res) => {
  const { username, password } = req.body;
  const principal = `admin:${username.toLowerCase()}`;
  try {
    // Reject early if locked, but still consume some time so the response
    // shape mirrors a normal failed login.
    try {
      await lockout.check(principal);
    } catch (err) {
      if (err.code === 'LOCKED_OUT') {
        await audit(req, 'auth.login_locked', 'user', username, null, username);
        const minutes = Math.ceil((err.retryAfterMs || 0) / 60_000);
        return res.status(429).json({
          error: `บัญชีถูกล็อกชั่วคราว — ลองใหม่ใน ${minutes} นาที`,
          code: 'LOCKED_OUT',
        });
      }
      throw err;
    }

    // Case-insensitive lookup to match the case-folding done at create time
    // (POST /api/admin/users lowercases before insert + LOWER() uniqueness).
    // Without this, a user created as "admin" couldn't sign in as "Admin".
    const { rows } = await pool.query(
      'SELECT id, username, password_hash, role FROM auth_users WHERE LOWER(username)=LOWER($1)',
      [username]
    );
    const user = rows[0] || null;
    const hash = user ? user.password_hash : DUMMY_HASH;
    // Always run bcrypt.compare so timing is roughly constant.
    const ok = await bcrypt.compare(password, hash);
    if (!user || !ok) {
      // Fire and forget: lockout counter + audit failed attempt.
      lockout.recordFailure(principal, 'admin').catch(() => {});
      audit(req, 'auth.login_failed', 'user', username,
        { reason: !user ? 'unknown_user' : 'wrong_password' }, username).catch(() => {});
      return res.status(401).json({ error: 'invalid credentials' });
    }
    // Successful login → clear lockout counter for this principal.
    lockout.reset(principal).catch(() => {});
    // Regenerate session ID after successful auth to defend against session
    // fixation (an attacker can't pre-set a sid that survives login).
    req.session.regenerate((regenErr) => {
      if (regenErr) {
        console.error('session.regenerate failed:', regenErr);
        return res.status(500).json({ error: 'internal error' });
      }
      req.session.user = { id: user.id, username: user.username, role: user.role };
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('session.save failed:', saveErr);
          return res.status(500).json({ error: 'internal error' });
        }
        audit(req, 'auth.login', 'user', String(user.id));
        res.json({ user: req.session.user });
      });
    });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/auth/logout', sameOrigin, csrfGuard, (req, res) => {
  const username = req.session && req.session.user ? req.session.user.username : null;
  if (username) audit(req, 'auth.logout', 'user', username);
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.session && req.session.user ? req.session.user : null });
});

// --- Data endpoints (JSONB key-value store) -------------------------------
// Whitelist of allowed keys to prevent abuse. Public reads only see masked
// rooms (no tenant PII); the rest are admin-only.
// baankarn_users_v1 was removed: admin user management now goes through
// /api/admin/users (auth_users table), so this key would only mirror a
// legacy localStorage stub from older builds.
const ALLOWED_KEYS = new Set([
  'baankarn_rooms_v1',
  'baankarn_config_v1',
  'baankarn_bookings_v1',
  'baankarn_activities_v1',
]);
// Keys that are safe to read while unauthenticated. Everything else returns
// 401. `baankarn_rooms_v1` is allowed but the value is run through
// `maskRoomsPublic` first.
const PUBLIC_KEYS = new Set(['baankarn_rooms_v1', 'baankarn_config_v1']);

// Strip every tenant-PII field from a rooms object. The home page only needs
// status/floor/type/rent to render the building grid, so we drop name, phone,
// email, citizen ID, occupation, photos, contract end, etc.
function maskRoomsPublic(roomsObj) {
  if (!roomsObj || typeof roomsObj !== 'object') return roomsObj;
  const out = {};
  for (const [id, r] of Object.entries(roomsObj)) {
    if (!r || typeof r !== 'object') continue;
    out[id] = {
      id: r.id,
      floor: r.floor,
      no: r.no,
      type: r.type,
      view: r.view,
      status: r.status,
      rent: r.rent,
      // Keep tenant truthy so existing UI conditions still work, but every
      // PII field is replaced with a masked placeholder.
      tenant: r.tenant ? { name: 'มีผู้เช่า', occupation: '', masked: true } : null,
    };
  }
  return out;
}

// Hard allowlist of fields safe to expose to unauthenticated visitors of
// the public room board. Switched from a denylist (delete users/notification/
// automation) to a strict allowlist so any new sensitive field admin adds to
// baankarn_config_v1 stays internal by default. The previous shape would
// silently leak any new top-level key — exactly the kind of regression you
// can't spot in code review.
function maskConfigPublic(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const out = {};
  if (cfg.building && typeof cfg.building === 'object') {
    out.building = {
      name: cfg.building.name,
      logo: cfg.building.logo,
      address: cfg.building.address,
      phone: cfg.building.phone,
    };
  }
  if (cfg.payment && typeof cfg.payment === 'object') {
    out.payment = {
      promptpayDisplayName: cfg.payment.promptpayDisplayName || cfg.payment.bankName,
      promptpayTarget: cfg.payment.promptpay || cfg.payment.promptpayTarget,
    };
  }
  // Pricing fields are visible on the public booking form, so let them through.
  if (cfg.utilities && typeof cfg.utilities === 'object') {
    out.utilities = {
      waterRate: cfg.utilities.waterRate,
      elecRate: cfg.utilities.elecRate,
    };
  }
  return out;
}

app.get('/api/data/:key', async (req, res) => {
  const key = req.params.key;
  if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: 'invalid key' });
  const isAuth = !!(req.session && req.session.user);
  if (!isAuth && !PUBLIC_KEYS.has(key)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const { rows } = await pool.query('SELECT value FROM app_data WHERE key=$1', [key]);
    let value = rows.length ? rows[0].value : null;
    if (!isAuth && key === 'baankarn_rooms_v1')  value = maskRoomsPublic(value);
    if (!isAuth && key === 'baankarn_config_v1') value = maskConfigPublic(value);
    res.json({ key, value });
  } catch (err) {
    console.error('data GET error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/data', async (req, res) => {
  const isAuth = !!(req.session && req.session.user);
  try {
    const keys = isAuth ? Array.from(ALLOWED_KEYS) : Array.from(PUBLIC_KEYS);
    const { rows } = await pool.query(
      'SELECT key, value FROM app_data WHERE key = ANY($1)',
      [keys]
    );
    const out = {};
    for (const r of rows) {
      let v = r.value;
      if (!isAuth && r.key === 'baankarn_rooms_v1')  v = maskRoomsPublic(v);
      if (!isAuth && r.key === 'baankarn_config_v1') v = maskConfigPublic(v);
      out[r.key] = v;
    }
    res.json(out);
  } catch (err) {
    console.error('data GET-all error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.put('/api/data/:key', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager', 'staff'), async (req, res) => {
  const key = req.params.key;
  if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: 'invalid key' });
  let value = req.body && req.body.value !== undefined ? req.body.value : req.body;
  // Reject null/undefined writes (use DELETE instead) — prevents the "row exists
  // with value null" footgun where the next hydrate finds null and seeds again.
  if (value === null || value === undefined) {
    return res.status(400).json({ error: 'use DELETE to remove a key' });
  }
  // Defensive normalisation: if the client sent a JSON string instead of an
  // object/array (older code path or buggy state), parse it. This avoids
  // the Postgres error 22P02 "invalid input syntax for type json" we hit
  // when an array element was a malformed JSON-string-of-an-object.
  if (typeof value === 'string') {
    try { value = JSON.parse(value); }
    catch (e) {
      return res.status(400).json({
        error: 'value is a string but not valid JSON',
        code: 'INVALID_JSON',
        hint: e.message,
      });
    }
  }
  // Re-stringify ourselves so pg-node sends a clean JSON literal — this
  // sidesteps any double-escape edge case where an array element was
  // previously serialized as a JSON-string-of-an-object.
  let serialised;
  try { serialised = JSON.stringify(value); }
  catch (e) {
    return res.status(400).json({
      error: 'value is not JSON-serialisable (circular ref?)',
      code: 'NOT_SERIALISABLE',
      hint: e.message,
    });
  }
  // Hard size cap on persisted JSONB rows. Without this, a tenant-side photo
  // upload that embedded base64 data URLs into rooms blob could push the
  // server-side row past 50 MB — and then every `/api/data` hydrate would
  // OOM the Chrome renderer on /admin#billing. 6 MB is generous (rooms blob
  // with proper URL-ref photos sits well under 200 KB) and slightly above
  // the client's 5 MB shapeIsValid cap so the client error is the one that
  // surfaces first in normal operation. The client also strips data: URLs
  // before save (project/admin/shared.jsx stripDataUrls) — this is the
  // belt-and-braces server-side guard.
  const MAX_BYTES = 6 * 1024 * 1024;
  if (serialised.length > MAX_BYTES) {
    console.warn(`[data] rejecting oversize PUT for ${key} (${serialised.length} bytes)`);
    return res.status(413).json({
      error: `value too large for key '${key}' (${(serialised.length / 1_048_576).toFixed(1)} MB > 6 MB cap). Strip embedded base64 images and re-save.`,
      code: 'TOO_LARGE',
    });
  }
  // Sanity check: enforce expected top-level shape per key. Some legacy
  // clients sent malformed structures (e.g. activities became an array of
  // mixed objects + JSON-strings) which then choked Postgres on read.
  const EXPECTED_SHAPE = {
    baankarn_rooms_v1:      'object',
    baankarn_config_v1:     'object',
    baankarn_bookings_v1:   'array',
    baankarn_activities_v1: 'array',
  };
  const want = EXPECTED_SHAPE[key];
  if (want === 'array' && !Array.isArray(value)) {
    return res.status(400).json({ error: `${key} must be a JSON array`, code: 'BAD_SHAPE' });
  }
  if (want === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
    return res.status(400).json({ error: `${key} must be a JSON object`, code: 'BAD_SHAPE' });
  }
  // For arrays, repair common corruption: any element that's a STRING which
  // looks like JSON gets parsed back to its object form. This is exactly
  // the situation that produced the 22P02 error in production logs —
  // someone's `addActivity` accidentally JSON.stringify'd the activity
  // before pushing into the array.
  if (Array.isArray(value)) {
    value = value.map((item) => {
      if (typeof item !== 'string') return item;
      const trimmed = item.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}'))
          || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try { return JSON.parse(trimmed); } catch { /* leave as string */ }
      }
      return item;
    });
    serialised = JSON.stringify(value);
  }
  try {
    await pool.query(
      `INSERT INTO app_data (key, value, updated_by)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_at = NOW(),
             updated_by = EXCLUDED.updated_by`,
      [key, serialised, req.session.user.username]
    );
    audit(req, 'data.put', 'app_data', key);
    // Bridge: when admin saves the rooms blob, mirror tenant info into
    // the tenants table so the tenant portal + bills + LINE binding all
    // see the same identities. Best-effort: silent on failure so admin
    // saves never error out.
    if (key === 'baankarn_rooms_v1' && value && typeof value === 'object') {
      mirrorRoomsToTenants(value, req.session.user.username).catch((err) => {
        console.error('[bridge] rooms→tenants mirror failed:', err.message);
      });
    }
    res.json({ ok: true, key });
  } catch (err) {
    console.error('data PUT error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// === JSONB rooms → tenants table bridge ===================================
// Admin's existing rooms UI keeps writing to baankarn_rooms_v1 JSONB. The
// tenants table needs to stay in sync so:
//   - Tenant portal can recognise the user (login by phone)
//   - Bills can be auto-linked to tenant_id
//   - LINE binding can target a real tenant row
//
// Algorithm: for every room with a tenant.name, upsert by (phone, name).
// Composite key: previously this used phone alone, which silently merged
// two distinct people who happened to share a phone (parents + kids in
// same household, shared lobby phone, etc.). The lookup now matches phone
// AND a normalised full_name so different humans on the same phone become
// separate tenant rows. Same-name retypes still update one row in place.
async function mirrorRoomsToTenants(roomsObj, updatedBy) {
  if (!roomsObj || typeof roomsObj !== 'object') return;
  const seen = new Set();
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  for (const [roomId, room] of Object.entries(roomsObj)) {
    if (!room || typeof room !== 'object') continue;
    const t = room.tenant;
    if (!t || !t.name || t.masked) continue;
    const phone = String(t.phone || '').replace(/[\s-]/g, '').slice(0, 32);
    const fullName = String(t.name).slice(0, 200).trim();
    if (!fullName) continue;
    // If no phone, we can't safely upsert; skip silently to avoid duplicates
    if (!phone) continue;
    const dedupKey = `${phone}|${norm(fullName)}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    // Match on phone + case-insensitive full_name. lower(full_name) avoids
    // the trivial-typo "John Smith" vs "john smith" creating duplicates.
    // We never touch pin_hash or citizen_id_encrypted — those come from
    // /api/tenants endpoints with explicit input.
    try {
      const existing = await pool.query(
        `SELECT id FROM tenants
           WHERE phone=$1 AND lower(full_name)=lower($2)
                 AND deleted_at IS NULL
           LIMIT 1`,
        [phone, fullName]
      );
      if (existing.rows.length) {
        await pool.query(
          `UPDATE tenants
              SET full_name=$1,
                  email=COALESCE($2, email),
                  current_room_id=$3,
                  updated_at=NOW()
            WHERE id=$4`,
          [fullName, t.email || null, String(roomId).slice(0, 32), existing.rows[0].id]
        );
      } else {
        // Soft-warn when this phone is already on a different tenant so
        // operators can audit shared-phone households intentionally.
        const collide = await pool.query(
          'SELECT COUNT(*)::int AS n FROM tenants WHERE phone=$1 AND deleted_at IS NULL',
          [phone]
        );
        if (collide.rows[0].n > 0) {
          console.warn(`[bridge] phone ${phone.slice(-4)} now on ${collide.rows[0].n + 1} distinct tenant rows (room ${roomId})`);
        }
        await pool.query(
          `INSERT INTO tenants (full_name, phone, email, current_room_id, status, locale)
           VALUES ($1,$2,$3,$4,'active','th')`,
          [fullName, phone, t.email || null, String(roomId).slice(0, 32)]
        );
      }
    } catch (err) {
      console.error('[bridge] upsert failed for phone', phone.slice(-4), ':', err.message);
    }
  }
}

app.delete('/api/data/:key', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  const key = req.params.key;
  if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: 'invalid key' });
  // Production safety: refuse to wipe `baankarn_rooms_v1` (the master room
  // record) when the system has real data behind it — i.e. ≥1 tenant row,
  // ≥1 bill, or ≥1 contract. Without this guard, a hijacked owner session
  // could call DELETE /api/data/baankarn_rooms_v1 (the "Reset sample data"
  // path) and silently destroy operational state without leaving any
  // recoverable trail beyond the audit log. Override with `?force=1` after
  // confirming in the UI; the override is audit-logged.
  const force = req.query && (req.query.force === '1' || req.query.force === 'true');
  if (key === 'baankarn_rooms_v1' && !force) {
    try {
      const guard = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM tenants WHERE deleted_at IS NULL) AS tenants,
           (SELECT COUNT(*)::int FROM bills WHERE deleted_at IS NULL) AS bills,
           (SELECT COUNT(*)::int FROM contracts WHERE deleted_at IS NULL) AS contracts`
      );
      const g = guard.rows[0];
      const realData = (g.tenants > 0) || (g.bills > 0) || (g.contracts > 0);
      if (realData) {
        return res.status(409).json({
          error: 'ระบบมีข้อมูลจริงอยู่แล้ว — ลบ rooms blob ไม่ได้',
          code: 'PRODUCTION_DATA_PRESENT',
          counts: g,
          hint: 'ส่ง ?force=1 เพื่อยืนยัน (จะถูกบันทึกใน audit log)',
        });
      }
    } catch (err) {
      console.warn('[data DELETE] production-data check skipped:', err.message);
    }
  }
  try {
    await pool.query('DELETE FROM app_data WHERE key=$1', [key]);
    audit(req, 'data.delete', 'app_data', key, { forced: !!force });
    res.json({ ok: true, key });
  } catch (err) {
    console.error('data DELETE error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Generic IP-based rate limiter factory. Replaces three near-identical inline
// limiters; centralizes the cleanup logic that was buggy before (the `if
// (arr.length === 0) delete` branch was unreachable since arr.length is at
// least 1 right after the `arr.push(now)` line, so the Map grew unbounded).
//
// We do periodic sweep cleanup roughly once every ~5 minutes (probabilistic)
// so a flood of unique IPs can't pile up between sweeps.
function makeIpLimiter({ windowMs, max, message = 'too many requests' }) {
  const hits = new Map();
  let lastSweep = Date.now();
  return function limiter(req, res, next) {
    // Use clientIp() so the X-Forwarded-For fallback parses the FIRST
    // address — using the raw header string lets a misconfigured proxy
    // expose multiple keys per attacker (each unique XFF combo bypasses
    // the per-IP cap).
    const ip = clientIp(req) || 'unknown';
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: message });
    arr.push(now);
    hits.set(ip, arr);
    if (now - lastSweep > 5 * 60_000) {
      lastSweep = now;
      for (const [k, v] of hits) {
        if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
      }
    }
    next();
  };
}

// All IP-based rate limiters. Declared together up here so any later route
// registration can reference them without TDZ errors (we hit one of those
// when /api/promptpay/qr was wired before the limiter const had been
// initialised — moving every limiter to a single block makes the order
// obvious and prevents recurrence).
const rateLimitBooking = makeIpLimiter({ windowMs: 60_000, max: 3 });
const rateLimitTicket  = makeIpLimiter({ windowMs: 60_000, max: 3 });
const rateLimitQr      = makeIpLimiter({ windowMs: 60_000, max: 30 });
// A7 — lookup endpoint can leak phone↔room mapping by enumeration. Tight
// per-IP cap + small random jitter on the response to neutralise timing.
const rateLimitLookup  = makeIpLimiter({ windowMs: 60_000, max: 10 });
// Public ticket-rating endpoint. The "rating IS NULL" guard at the SQL
// level prevents repeat updates, but without a rate limit a script can
// race a legitimate rate by spamming until one wins. 5/min/IP is enough
// for honest re-tries, way below script-attack throughput.
const rateLimitTicketRate = makeIpLimiter({ windowMs: 60_000, max: 5 });
function lookupJitter(_req, _res, next) {
  const ms = 200 + Math.floor(Math.random() * 300);
  setTimeout(next, ms);
}

app.post('/api/bookings/public', sameOrigin, rateLimitBooking, validateBody(schemas.publicBooking), async (req, res) => {
  const b = req.body;
  // Length / type sanity. Strings only, capped to reasonable lengths to keep
  // the JSONB blob bounded and prevent payload-bomb attacks.
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const cleaned = {
    roomId:      str(b.roomId, 32),
    tenantName:  str(b.tenantName, 120),
    phone:       str(b.phone, 32),
    email:       str(b.email, 120),
    checkInDate: str(b.checkInDate, 16),
    floor:       str(b.floor, 4),
    roomType:    str(b.roomType, 32),
    message:     str(b.message, 500),
    citizenIdTail:  str(b.citizenIdTail, 4),
    expectedDeposit: b.expectedDeposit != null ? Number(b.expectedDeposit) : null,
    agreedTermsVersion: str(b.agreedTermsVersion, 64),
  };
  if (!cleaned.tenantName.trim()) {
    return res.status(400).json({ error: 'tenantName required' });
  }
  // Sanity-check expected move-in date if supplied — same window as the
  // checkin endpoint so we don't accept bookings for "next year" by typo.
  if (cleaned.checkInDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned.checkInDate)) {
      return res.status(400).json({ error: 'checkInDate ต้องเป็น YYYY-MM-DD', code: 'INVALID_DATE' });
    }
    const target = new Date(cleaned.checkInDate + 'T00:00:00Z');
    const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
    const diff = (target - today) / 86_400_000;
    // Public bookings get a more lenient 7-days-past / 365-days-future
    // window than admin checkin (which is stricter). Bookers occasionally
    // pick "next year" intentionally for long-lead reservations.
    if (diff < -7 || diff > 365) {
      return res.status(400).json({
        error: `วันเข้าพัก (${cleaned.checkInDate}) อยู่นอกช่วงที่อนุญาต`,
        code: 'MOVE_IN_OUT_OF_WINDOW',
      });
    }
  }
  // Optional citizen ID front photo: store via the same storage pipeline.
  // Failure here doesn't fail the booking — admin can request it later.
  let frontFileId = null;
  if (b.citizenIdImageFront) {
    try {
      const out = await storage.saveBase64({
        pool, category: 'citizen_id_image',
        dataUrl: b.citizenIdImageFront,
        refId: 'public-booking-pending',
        uploadedBy: 'public',
        maxBytes: 1_500_000,
        side: 'front',
      });
      frontFileId = out.id;
    } catch (err) {
      console.warn('[public-booking] id-image upload failed:', err.message);
    }
  }
  // Build the new booking object outside the transaction.
  const VALID_TYPES = ['standard', 'deluxe', 'suite', 'studio'];
  const wantType = VALID_TYPES.includes(cleaned.roomType) ? cleaned.roomType : 'standard';
  const wantFloor = Number(cleaned.floor) || null;
  const newBooking = {
    id: 'BK-PUB-' + require('crypto').randomBytes(6).toString('hex'),
    name: cleaned.tenantName,
    phone: cleaned.phone,
    wantType,
    wantFloor,
    moveIn: cleaned.checkInDate || null,
    months: 12,
    deposit: cleaned.expectedDeposit != null && Number.isFinite(cleaned.expectedDeposit)
      ? cleaned.expectedDeposit : 0,
    status: 'pending',
    createdAt: new Date().toISOString(),
    email: cleaned.email,
    message: cleaned.message,
    source: 'public-form',
    roomId: cleaned.roomId,
    citizenIdTail: cleaned.citizenIdTail || null,
    citizenIdImageFrontId: frontFileId,
    agreedTermsVersion: cleaned.agreedTermsVersion || null,
    agreedTermsAt: cleaned.agreedTermsVersion ? new Date().toISOString() : null,
  };
  const client = await pool.connect();
  try {
    // Read-modify-write inside a transaction with SELECT FOR UPDATE so two
    // simultaneous public submissions can't both see the same list and
    // overwrite each other on save. The row-level lock serialises writers;
    // the request rate limit (3/min/IP) keeps queue depth shallow.
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT value FROM app_data WHERE key=$1 FOR UPDATE',
      ['baankarn_bookings_v1']
    );
    const list = (rows.length && Array.isArray(rows[0].value)) ? rows[0].value : [];
    list.unshift(newBooking);
    // Cap at 500 newest entries to prevent unbounded JSONB growth.
    const capped = list.slice(0, 500);
    await client.query(
      `INSERT INTO app_data (key, value, updated_by) VALUES ($1, $2, 'public')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = 'public'`,
      ['baankarn_bookings_v1', JSON.stringify(capped)]
    );
    // Dual-write into the relational `bookings` table. Reads still go to the
    // JSONB blob (admin pages, approve-and-assign flow) — this is just so
    // reports + future SQL-backed admin views have a real table to query
    // without scanning a 500-element JSONB array. external_id is unique so
    // re-running the same insert (e.g. retried after a transient failure) is
    // idempotent. Best-effort: a failure here doesn't unwind the JSONB write.
    try {
      await client.query(
        `INSERT INTO bookings
            (external_id, name, phone, email, want_type, want_floor,
             move_in, months, deposit, status, source, message, room_id,
             citizen_id_tail, citizen_id_image_front_id, expected_deposit,
             agreed_terms_at, agreed_terms_version)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending','public-form',$10,$11,
                  $12,$13,$14,
                  CASE WHEN $15::text IS NOT NULL THEN NOW() ELSE NULL END, $15)
          ON CONFLICT (external_id) DO NOTHING`,
        [
          newBooking.id, newBooking.name, newBooking.phone || null,
          cleaned.email || null, wantType, wantFloor,
          cleaned.checkInDate || null, 12, newBooking.deposit,
          cleaned.message || null, cleaned.roomId || null,
          cleaned.citizenIdTail || null, frontFileId,
          cleaned.expectedDeposit != null && Number.isFinite(cleaned.expectedDeposit) ? cleaned.expectedDeposit : null,
          cleaned.agreedTermsVersion || null,
        ]
      );
    } catch (err) {
      // Older deployments (pre-migration) fall back to the legacy column set.
      if (err.code === '42703') {
        try {
          await client.query(
            `INSERT INTO bookings
                (external_id, name, phone, email, want_type, want_floor,
                 move_in, months, deposit, status, source, message, room_id)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending','public-form',$10,$11)
              ON CONFLICT (external_id) DO NOTHING`,
            [
              newBooking.id, newBooking.name, newBooking.phone || null,
              cleaned.email || null, wantType, wantFloor,
              cleaned.checkInDate || null, 12, newBooking.deposit,
              cleaned.message || null, cleaned.roomId || null,
            ]
          );
        } catch (e2) {
          console.warn('[booking] relational dual-write fallback also failed:', e2.message);
        }
      } else {
        console.warn('[booking] relational dual-write skipped:', err.message);
      }
    }
    await client.query('COMMIT');
    audit(req, 'booking.public_create', 'booking', newBooking.id,
      { phone: cleaned.phone, roomId: cleaned.roomId, wantType, wantFloor },
      `public:${cleaned.phone || 'anon'}`).catch(() => {});

    // Multi-channel owner notify (LINE → email fallback) + log to
    // notifications_log so admin sees it even when LINE is offline. B6.
    try {
      const flags = await features.load(pool);
      notifier.notifyOwner({ pool, features: flags }, {
        subject: '📋 ผู้เช่าใหม่ขอจอง',
        text: `ชื่อ: ${cleaned.tenantName}\nโทร: ${cleaned.phone || '-'}\nห้อง: ${cleaned.roomId || '-'}\nวันเข้าพัก: ${cleaned.checkInDate || '-'}\nรหัสการจอง: ${newBooking.id}`,
      }).catch(() => {});
    } catch { /* ignore */ }

    res.json({ ok: true, booking: newBooking });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    console.error('public booking error:', err);
    res.status(500).json({ error: 'internal error' });
  } finally {
    client.release();
  }
});

// POST /api/notify/bill — admin-auth. Trigger a LINE notification for a bill
// the admin just sent. Body: { tenantName, roomId, period, total, billNo }.
// Routes through notifier.notifyOwner so multi-OA tenants get the message
// via the correct OA + email fallback fires when LINE isn't configured.
app.post('/api/notify/bill', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager', 'staff'), async (req, res) => {
  const b = req.body || {};
  if (!b.tenantName || !b.total) {
    return res.status(400).json({ error: 'tenantName and total required' });
  }
  const text = [
    `💰 ออกบิลใหม่`,
    `ผู้เช่า: ${b.tenantName}`,
    b.roomId ? `ห้อง: ${b.roomId}` : null,
    b.period ? `รอบบิล: ${b.period}` : null,
    `จำนวน: ฿${Number(b.total).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    b.billNo ? `เลขที่: ${b.billNo}` : null,
  ].filter(Boolean).join('\n');
  try {
    const flags = await features.load(pool);
    const out = await notifier.notifyOwner({ pool, features: flags }, {
      subject: '💰 ออกบิลใหม่',
      text,
    });
    if (!out.ok) {
      return res.status(503).json({ error: 'no notification channel reached the owner', channel: out.channel });
    }
    res.json({ ok: true, channel: out.channel });
  } catch (err) {
    console.error('notify/bill error:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

// --- Bills: PDF rendering + PromptPay QR ----------------------------------
// PDFKit + QR encoding are both CPU-bound. On a single Railway replica,
// concurrent requests block the event loop and downstream requests time out.
// Limit to MAX_PDF_CONCURRENCY in-flight PDFs at once; queued requests wait.
const MAX_PDF_CONCURRENCY = 3;
let _pdfActive = 0;
const _pdfWaiters = [];
function acquirePdfSlot() {
  if (_pdfActive < MAX_PDF_CONCURRENCY) {
    _pdfActive++;
    return Promise.resolve();
  }
  // C9 — bound the queue wait at 30s so a long-running render can't make
  // every queued caller hang past the HTTP read timeout.
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = _pdfWaiters.indexOf(slot);
      if (i >= 0) _pdfWaiters.splice(i, 1);
      reject(new Error('PDF queue timeout'));
    }, 30_000);
    timer.unref();
    const slot = () => { clearTimeout(timer); _pdfActive++; resolve(); };
    _pdfWaiters.push(slot);
  });
}
function releasePdfSlot() {
  _pdfActive = Math.max(0, _pdfActive - 1);
  if (_pdfWaiters.length > 0) {
    const next = _pdfWaiters.shift();
    next();   // increments _pdfActive itself
  }
}
// POST /api/bills/render — admin-authenticated. Body is a bill object built
// client-side from rooms+config; server renders Thai-language PDF with QR
// embedded. We don't persist bills server-side (they're computed on demand
// from rooms+config in the admin UI), so the body carries everything needed.
app.post('/api/bills/render', sameOrigin, csrfGuard, requireAuth, async (req, res) => {
  const bill = req.body && req.body.bill ? req.body.bill : req.body;
  const config = req.body && req.body.config;
  if (!bill || !bill.tenantName || !bill.total) {
    return res.status(400).json({ error: 'bill.tenantName and bill.total required' });
  }
  // Single source of truth for payment block: services/billing.buildPaymentBlock
  // derives promptpayTarget, bankInfo, paymentMethods from config.payment.
  // If client sent { bill, config } we enrich here so the client doesn't need
  // to duplicate the field-extraction logic. Pre-computed fields on `bill`
  // win — old clients that don't send config still work.
  if (config) {
    const pb = billing.buildPaymentBlock(config);
    if (!bill.promptpayTarget && pb.promptpayTarget) bill.promptpayTarget = pb.promptpayTarget;
    if (!bill.promptpayName && pb.promptpayName) bill.promptpayName = pb.promptpayName;
    if (!bill.bankInfo && pb.bankInfo) bill.bankInfo = pb.bankInfo;
    if (!bill.paymentMethods && pb.paymentMethods) bill.paymentMethods = pb.paymentMethods;
  }
  if (!bill.promptpayTarget) {
    const pp = require('./services/secrets').get('PROMPTPAY_TARGET');
    if (pp) bill.promptpayTarget = pp;
  }
  let acquired = false;
  try {
    await acquirePdfSlot();
    acquired = true;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="bill-${(bill.billNo || 'invoice').replace(/[^A-Za-z0-9_-]/g, '')}.pdf"`
    );
    await renderBillPdf(bill, res);
  } catch (err) {
    console.error(`[${req.id}] bill render error:`, sanitizeError(err));
    if (!res.headersSent) {
      const code = String(err.message || '').includes('PDF queue timeout') ? 503 : 500;
      res.status(code).json({ error: 'pdf render failed', code: code === 503 ? 'BUSY' : 'PDF_ERROR' });
    }
  } finally {
    if (acquired) releasePdfSlot();
  }
});

// GET /api/promptpay/qr?target=<phone-or-citizen-id>&amount=<thb>&format=png|json
// Public for now (rate-limited indirectly via session middleware overhead);
// in practice the only callers are admin/tenant pages already inside the app.
app.get('/api/promptpay/qr', rateLimitQr, async (req, res) => {
  const target = String(req.query.target || '').trim();
  const amountRaw = req.query.amount;
  const amount = amountRaw != null && amountRaw !== '' ? Number(amountRaw) : undefined;
  const format = req.query.format === 'json' ? 'json' : 'png';
  if (!target) return res.status(400).json({ error: 'target required' });
  // Cap amount: realistic monthly bills are <100k THB. 999,999 is the upper
  // sanity bound — bigger values are likely attempts to abuse the QR.
  if (amount != null && (!Number.isFinite(amount) || amount < 0 || amount > 999999)) {
    return res.status(400).json({ error: 'invalid amount' });
  }
  // C13 — strict shape: Thai phone (10 digits, leading 0) OR citizen ID (13).
  // Previously a regex allowed `1234567890` (no leading 0) through, which
  // generates a payload that no Thai bank app can parse.
  const cleaned = target.replace(/-/g, '');
  const isPhone = /^0\d{9}$/.test(cleaned);
  const isCitizen = /^\d{13}$/.test(cleaned);
  if (!isPhone && !isCitizen) {
    return res.status(400).json({ error: 'PromptPay target must be a 10-digit Thai phone (0XXXXXXXXX) or 13-digit citizen ID' });
  }
  try {
    if (format === 'json') {
      const dataUrl = await renderQrDataUrl(target, amount);
      return res.json({ ok: true, dataUrl });
    }
    const png = await renderQrPng(target, amount);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(png);
  } catch (err) {
    console.error('qr render error:', err);
    return res.status(500).json({ error: 'qr render failed' });
  }
});

// --- Maintenance tickets (Phase A4) ---------------------------------------
// Lifecycle: open → assigned → in_progress → (awaiting_parts) → completed.
// Tenants submit with room_id + their phone (no login). Admins manage all
// tickets. Tenants can later look up their own by phone.

const VALID_TICKET_STATUS = new Set([
  'open','assigned','in_progress','awaiting_parts','completed','cancelled',
]);
const VALID_TICKET_PRIORITY = new Set(['critical','high','medium','low']);
const VALID_TICKET_CATEGORY = new Set([
  'electrical','plumbing','aircon','furniture','appliance','door_lock','wifi','other',
]);

function makeTicketNo() {
  const d = new Date();
  const y = d.getFullYear().toString().slice(-2);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const seq = String(d.getTime()).slice(-5);
  return `MT${y}${m}-${seq}`;
}

// POST /api/maintenance — public (tenant submits). Rate-limited.
app.post('/api/maintenance', sameOrigin, rateLimitTicket, validateBody(schemas.createTicket), async (req, res) => {
  const b = req.body;
  const cleaned = {
    room_id:      b.roomId,
    tenant_name:  b.tenantName || '',
    tenant_phone: b.tenantPhone || '',
    category:     b.category,
    priority:     b.priority || 'medium',
    title:        b.title,
    description:  b.description || '',
  };
  const ticketNo = makeTicketNo();
  try {
    // Best-effort tenant linkage: if phone matches an existing tenant row,
    // stamp tenant_id so the ticket survives a future phone change. Anonymous
    // submissions (no matching tenant) just leave tenant_id NULL.
    let tenantId = null;
    if (cleaned.tenant_phone) {
      const tr = await pool.query(
        'SELECT id FROM tenants WHERE phone=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1',
        [cleaned.tenant_phone]
      );
      if (tr.rows.length) tenantId = tr.rows[0].id;
    }
    const { rows } = await pool.query(
      `INSERT INTO maintenance_tickets
        (ticket_no, room_id, tenant_name, tenant_phone, category, priority, title, description, tenant_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING *`,
      [ticketNo, cleaned.room_id, cleaned.tenant_name, cleaned.tenant_phone,
       cleaned.category, cleaned.priority, cleaned.title, cleaned.description, tenantId]
    );
    const ticket = rows[0];
    // A4 — audit even public ticket creation; user_id captured as the
    // submitter's phone so admin can correlate abuse.
    audit(req, 'ticket.create', 'ticket', String(ticket.id),
      { priority: ticket.priority, category: ticket.category, room: ticket.room_id },
      `public:${cleaned.tenant_phone || 'anon'}`).catch(() => {});
    // Fire-and-forget multi-channel notify (LINE→email fallback)
    try {
      const flags = await features.load(pool);
      notifier.notifyOwner({ pool, features: flags }, {
        subject: `🛠 แจ้งซ่อมใหม่ (${ticket.priority})`,
        text: `เลขที่: ${ticket.ticket_no}\n` +
              `ห้อง: ${ticket.room_id} (${ticket.tenant_name || '-'})\n` +
              `หมวด: ${ticket.category}\n` +
              `เรื่อง: ${ticket.title}`,
      }).catch(() => {});
    } catch { /* ignore */ }
    res.json({ ok: true, ticket });
  } catch (err) {
    console.error('ticket create error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/maintenance — admin list. Optional ?status= filter.
app.get('/api/maintenance', requireAuth, async (req, res) => {
  const status = req.query.status;
  try {
    const params = [];
    let where = '';
    if (status && VALID_TICKET_STATUS.has(String(status))) {
      params.push(status);
      where = `WHERE status = $1`;
    }
    const { rows } = await pool.query(
      `SELECT * FROM maintenance_tickets ${where} ORDER BY created_at DESC LIMIT 500`,
      params
    );
    res.json({ ok: true, tickets: rows });
  } catch (err) {
    console.error('ticket list error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/maintenance/lookup?phone=... — public lookup of tenant's own tickets.
// Requires both phone AND room_id to prevent enumeration.
app.get('/api/maintenance/lookup', rateLimitLookup, lookupJitter, async (req, res) => {
  // Validate phone shape before hitting the DB so an attacker can't probe
  // the ticket table with garbage values + the rate limiter only protects
  // intentional traffic, not lookups with malformed input.
  const rawPhone = String(req.query.phone || '').trim();
  const phoneCheck = require('./schemas').phoneStr.safeParse(rawPhone);
  if (!phoneCheck.success) {
    return res.status(400).json({ error: 'invalid phone' });
  }
  const phone = phoneCheck.data;
  const roomId = String(req.query.roomId || '').trim().slice(0, 32);
  if (!roomId) {
    return res.status(400).json({ error: 'phone and roomId required' });
  }
  try {
    // Privacy: only return tickets belonging to the CURRENT tenant of the
    // requested room. Previously the WHERE OR'd tenant_phone match against
    // tenant_id ANY, so a new tenant who moved into a room could see the
    // prior tenant's ticket history if the prior tenant had submitted with
    // the same phone (couples/family members) or — more commonly — the
    // tenant_id ANY branch matched any historical tenant who'd ever shared
    // that phone. Now the room+phone must resolve to a CURRENTLY-ACTIVE
    // tenant assigned to that room; tickets are filtered to that tenant_id
    // (or, for legacy tickets created before tenant_id stamping, by phone
    // AND room_id together).
    const currentTenant = await pool.query(
      `SELECT id FROM tenants
         WHERE phone = $1 AND current_room_id = $2
           AND deleted_at IS NULL AND status='active'
         ORDER BY updated_at DESC LIMIT 1`,
      [phone, roomId]
    );
    if (!currentTenant.rows.length) {
      // Phone doesn't match any current resident of this room. Return empty
      // (200 with empty array) rather than 404 so attackers can't probe
      // which (phone,room) pairs exist.
      return res.json({ ok: true, tickets: [] });
    }
    const tenantId = currentTenant.rows[0].id;
    const { rows } = await pool.query(
      `SELECT id, ticket_no, room_id, category, priority, status, title, created_at, completed_at, rating
         FROM maintenance_tickets
         WHERE room_id = $1
           AND (tenant_id = $2 OR (tenant_id IS NULL AND tenant_phone = $3))
         ORDER BY created_at DESC LIMIT 50`,
      [roomId, tenantId, phone]
    );
    res.json({ ok: true, tickets: rows });
  } catch (err) {
    console.error('ticket lookup error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// PUT /api/maintenance/:id — admin updates status / assigned / cost / scheduled.
app.put('/api/maintenance/:id', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager', 'staff'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const b = req.body || {};
  const fields = [];
  const params = [];
  let idx = 1;
  if (b.status !== undefined) {
    if (!VALID_TICKET_STATUS.has(String(b.status))) {
      return res.status(400).json({ error: 'invalid status' });
    }
    fields.push(`status = $${idx++}`); params.push(b.status);
    if (b.status === 'completed') {
      fields.push(`completed_at = NOW()`);
    }
  }
  if (b.priority !== undefined) {
    if (!VALID_TICKET_PRIORITY.has(String(b.priority))) {
      return res.status(400).json({ error: 'invalid priority' });
    }
    fields.push(`priority = $${idx++}`); params.push(b.priority);
  }
  if (b.assignedTo !== undefined) { fields.push(`assigned_to = $${idx++}`); params.push(String(b.assignedTo).slice(0, 120)); }
  if (b.scheduledAt !== undefined) { fields.push(`scheduled_at = $${idx++}`); params.push(b.scheduledAt || null); }
  if (b.cost !== undefined) {
    const cost = Number(b.cost);
    if (!Number.isFinite(cost) || cost < 0) return res.status(400).json({ error: 'invalid cost' });
    fields.push(`cost = $${idx++}`); params.push(cost);
  }
  if (fields.length === 0) {
    return res.status(400).json({ error: 'nothing to update' });
  }
  fields.push(`updated_at = NOW()`);
  params.push(id);
  try {
    const { rows } = await pool.query(
      `UPDATE maintenance_tickets SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });
    audit(req, 'maintenance.update', 'ticket', String(id), { fields: Object.keys(b) });

    // Notify the tenant when the ticket transitions to `completed` so they
    // get a prompt to rate the service. Fire-and-forget; routes through
    // notifier (LINE → email) so multi-OA tenants get the right channel.
    //
    // Resolve by tenant_id (stamped on the ticket at creation time) instead
    // of re-querying by phone. Without this, two tenants sharing a phone
    // (couples, families) would race on `ORDER BY updated_at DESC LIMIT 1`
    // and the completion notification could land on the wrong person.
    // tenant_id was set when the ticket was created (server.js:1119) — that
    // moment's match is the authoritative one. Fall back to phone lookup
    // only for legacy tickets where tenant_id was never stamped.
    if (b.status === 'completed') {
      try {
        const t = rows[0];
        let tq;
        if (t.tenant_id) {
          tq = await pool.query(
            `SELECT id, full_name, phone, email, line_user_id, line_oa_id, status
               FROM tenants
               WHERE id=$1 AND deleted_at IS NULL`,
            [t.tenant_id]
          );
        } else if (t.tenant_phone) {
          tq = await pool.query(
            `SELECT id, full_name, phone, email, line_user_id, line_oa_id, status
               FROM tenants
               WHERE phone=$1 AND deleted_at IS NULL
               ORDER BY updated_at DESC LIMIT 1`,
            [t.tenant_phone]
          );
        } else {
          tq = { rows: [] };
        }
        if (tq.rows.length) {
          const flags = await features.load(pool);
          notifier.notifyTenant({ pool, features: flags }, tq.rows[0], {
            subject: '🛠 แจ้งซ่อมเสร็จสิ้น',
            text: `งาน ${t.ticket_no} เสร็จเรียบร้อย\n` +
                  `เรื่อง: ${t.title}\n\n` +
                  `กรุณาให้คะแนนการบริการในแอป`,
          }).catch(() => {});
        }
      } catch (err) {
        console.warn('[ticket] tenant notify on completed failed:', err.message);
      }
    }
    res.json({ ok: true, ticket: rows[0] });
  } catch (err) {
    console.error('ticket update error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /api/maintenance/:id/rate — public, requires matching phone.
// rateLimitTicketRate caps brute-force attempts at racing the SQL
// `rating IS NULL` guard with a flood of POSTs.
app.post('/api/maintenance/:id/rate', sameOrigin, rateLimitTicketRate, validateBody(schemas.rateTicket), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  const b = req.body;
  const rating = b.rating;
  const phone = b.phone;
  const comment = b.comment || null;
  try {
    // Add `AND rating IS NULL` so a tenant can't keep updating their score
    // (e.g. start at 5★ then quietly downgrade to 1★ after a billing dispute).
    // Tenant portal endpoint /api/tenant/maintenance/:id/rate already had
    // this guard; the legacy public endpoint was missing it.
    const { rows } = await pool.query(
      `UPDATE maintenance_tickets
         SET rating = $1, rating_comment = $2, updated_at = NOW()
         WHERE id = $3 AND tenant_phone = $4
           AND status = 'completed'
           AND rating IS NULL
         RETURNING ticket_no, rating`,
      [rating, comment, id, phone]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'not found, not completed, or already rated' });
    }
    audit(req, 'ticket.rate', 'ticket', String(id), { rating, hasComment: !!comment }, `public:${phone}`)
      .catch(() => {});
    res.json({ ok: true, ticket: rows[0] });
  } catch (err) {
    console.error('ticket rate error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/audit?limit=&before=  — admin-auth, returns recent audit entries.
// Cursor-paginated by created_at DESC. Restricted to owner/manager
// because auth.login_failed details (reason='unknown_user' vs
// 'wrong_password') can be used to enumerate which usernames exist.
app.get('/api/audit', requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  // Validate `before` as ISO date — pg accepts other formats but we want
  // strict parsing so attackers can't push the cursor far enough to scan
  // a huge window. Reject anything that doesn't parse as a valid Date.
  const beforeRaw = req.query.before;
  let before = null;
  if (beforeRaw) {
    const d = new Date(String(beforeRaw));
    if (isNaN(d.getTime())) {
      return res.status(400).json({ error: 'invalid before cursor (use ISO 8601)' });
    }
    before = d.toISOString();
  }
  try {
    const params = [];
    let where = '';
    if (before) { params.push(before); where = `WHERE created_at < $1`; }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT id, user_id, action, entity_type, entity_id, detail, ip, created_at
         FROM audit_logs ${where}
         ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    res.json({ ok: true, logs: rows });
  } catch (err) {
    console.error('audit list error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// --- Reports (Phase B2): real DB aggregates --------------------------------
// Replaces the Math.sin-based mocks. We derive metrics from the existing
// app_data JSONB store (rooms + bookings + audit) so no new schema needed.
// Financial reports (revenue, AR, bill exports) are gated to manager+ — staff
// don't need to see aggregate cashflow to do their day-to-day work, and
// readonly accounts (used for stakeholder demos) shouldn't see it at all.
app.get('/api/reports/overview', requireAuth, requireRole('owner', 'manager'), async (_req, res) => {
  try {
    const [roomsRow, bookingsRow] = await Promise.all([
      pool.query(`SELECT value FROM app_data WHERE key='baankarn_rooms_v1'`),
      pool.query(`SELECT value FROM app_data WHERE key='baankarn_bookings_v1'`),
    ]);
    // Defensive parse: if the JSONB blob is corrupted (e.g., a debug write
    // stored a string instead of an object), Object.values would throw.
    const rawRooms = roomsRow.rows.length ? roomsRow.rows[0].value : {};
    const roomsObj = rawRooms && typeof rawRooms === 'object' && !Array.isArray(rawRooms)
      ? rawRooms : {};
    const bookings = bookingsRow.rows.length && Array.isArray(bookingsRow.rows[0].value)
      ? bookingsRow.rows[0].value : [];
    const rooms = Object.values(roomsObj);
    const occupied = rooms.filter((r) => r.status === 'occupied').length;
    const overdue = rooms.filter((r) => r.status === 'overdue').length;
    const reserved = rooms.filter((r) => r.status === 'reserved').length;
    const vacant = rooms.filter((r) => r.status === 'vacant').length;
    const maintenance = rooms.filter((r) => r.status === 'maintenance').length;
    const totalRent = rooms.reduce((s, r) => s + (Number(r.rent) || 0), 0);
    const occupiedRevenue = rooms
      .filter((r) => r.status === 'occupied' || r.status === 'overdue')
      .reduce((s, r) => s + (Number(r.rent) || 0), 0);
    const pendingBookings = bookings.filter((b) => b.status === 'pending').length;
    res.json({
      ok: true,
      counts: { occupied, overdue, reserved, vacant, maintenance, total: rooms.length },
      revenue: { potential: totalRent, occupied: occupiedRevenue },
      bookings: { pending: pendingBookings, total: bookings.length },
    });
  } catch (err) {
    console.error('reports overview error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/reports/aged-receivable — manager+. Bins overdue rooms by how
// many days overdue. Reads from app_data rooms (which carry overdueDays).
app.get('/api/reports/aged-receivable', requireAuth, requireRole('owner', 'manager'), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM app_data WHERE key='baankarn_rooms_v1'`
    );
    const roomsObj = rows.length ? rows[0].value : {};
    const buckets = {
      'current': { range: '0-30', rooms: 0, amount: 0 },
      'late_30': { range: '31-60', rooms: 0, amount: 0 },
      'late_60': { range: '61-90', rooms: 0, amount: 0 },
      'late_90': { range: '90+',   rooms: 0, amount: 0 },
    };
    Object.values(roomsObj || {}).forEach((r) => {
      if (r.status !== 'overdue') return;
      const days = Number(r.overdueDays) || 0;
      const amt = Number(r.rent) || 0;
      let key = 'current';
      if (days > 90)      key = 'late_90';
      else if (days > 60) key = 'late_60';
      else if (days > 30) key = 'late_30';
      buckets[key].rooms += 1;
      buckets[key].amount += amt;
    });
    res.json({ ok: true, buckets: Object.values(buckets) });
  } catch (err) {
    console.error('reports aged-receivable error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/reports/bills.xlsx — manager+. Streams an Excel workbook of
// the current-month bill estimates for every room.
app.get('/api/reports/bills.xlsx', requireAuth, requireRole('owner', 'manager'), async (_req, res) => {
  let ExcelJS;
  try { ExcelJS = require('exceljs'); }
  catch (e) { return res.status(500).json({ error: 'exceljs not installed' }); }
  try {
    const [roomsRow, configRow] = await Promise.all([
      pool.query(`SELECT value FROM app_data WHERE key='baankarn_rooms_v1'`),
      pool.query(`SELECT value FROM app_data WHERE key='baankarn_config_v1'`),
    ]);
    const rooms = Object.values(roomsRow.rows.length ? roomsRow.rows[0].value : {});
    const config = configRow.rows.length ? configRow.rows[0].value : {};
    const waterRate = config?.utilities?.waterRate ?? 18;
    const elecRate  = config?.utilities?.elecRate  ?? 8;
    const wifiFee   = config?.utilities?.wifi      ?? 250;

    const wb = new ExcelJS.Workbook();
    wb.creator = config?.building?.name || 'บ้านกาญจน์ เรสซิเดนซ์';
    wb.created = new Date();
    const ws = wb.addWorksheet('บิลรอบนี้');
    ws.columns = [
      { header: 'ห้อง', key: 'room', width: 8 },
      { header: 'ผู้เช่า', key: 'tenant', width: 28 },
      { header: 'สถานะ', key: 'status', width: 12 },
      { header: 'ค่าเช่า', key: 'rent', width: 12, style: { numFmt: '#,##0.00' } },
      { header: 'ค่าน้ำ', key: 'water', width: 12, style: { numFmt: '#,##0.00' } },
      { header: 'ค่าไฟ', key: 'elec', width: 12, style: { numFmt: '#,##0.00' } },
      { header: 'Wi-Fi', key: 'wifi', width: 10, style: { numFmt: '#,##0.00' } },
      { header: 'รวม', key: 'total', width: 14, style: { numFmt: '#,##0.00' } },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAF6EE' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    rooms
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .forEach((r) => {
        const water = (Number(r.waterUnits) || 0) * waterRate;
        const elec  = (Number(r.elecUnits)  || 0) * elecRate;
        const total = (Number(r.rent) || 0) + water + elec + wifiFee;
        ws.addRow({
          room: r.id,
          tenant: r.tenant?.name || '—',
          status: r.status || '—',
          rent: Number(r.rent) || 0,
          water,
          elec,
          wifi: wifiFee,
          total,
        });
      });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="bills-${new Date().toISOString().slice(0,10)}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('reports xlsx error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/reports/maintenance — counts by status, average rating, cost
// aggregates. Optional ?period=YYYY-MM filter. C5.
app.get('/api/reports/maintenance', requireAuth, async (req, res) => {
  // The regex below already constrains period to YYYY-MM (no SQL metacharacters
  // can pass through), but we still parameterise to keep the codebase free of
  // string-concatenated SQL — any future relaxation of the regex would silently
  // open an injection vector if we kept interpolating.
  const period = String(req.query.period || '').match(/^\d{4}-\d{2}$/) ? req.query.period : null;
  const where = period ? `WHERE to_char(created_at, 'YYYY-MM') = $1` : '';
  const params = period ? [period] : [];
  try {
    const [byStatus, ratings, costs, byCategory] = await Promise.all([
      pool.query(`SELECT status, COUNT(*) AS n FROM maintenance_tickets ${where} GROUP BY status`, params),
      pool.query(
        `SELECT AVG(rating)::numeric(3,2) AS avg_rating, COUNT(rating) AS rated
           FROM maintenance_tickets ${period ? where + ' AND ' : 'WHERE '} rating IS NOT NULL`,
        params
      ),
      pool.query(`SELECT
                    SUM(cost)::numeric(12,2) AS total_cost,
                    (AVG(cost) FILTER (WHERE cost > 0))::numeric(10,2) AS avg_cost,
                    COUNT(*) FILTER (WHERE cost > 0) AS billed_count,
                    (SUM(cost) FILTER (WHERE status='completed'))::numeric(12,2) AS completed_cost
                  FROM maintenance_tickets ${where}`, params),
      pool.query(
        `SELECT category, COUNT(*) AS n, SUM(cost)::numeric(12,2) AS cost_total
           FROM maintenance_tickets ${where} GROUP BY category ORDER BY n DESC`,
        params
      ),
    ]);
    const counts = {};
    byStatus.rows.forEach((r) => { counts[r.status] = Number(r.n); });
    const c = costs.rows[0] || {};
    res.json({
      ok: true,
      period: period || 'all',
      counts,
      avgRating: ratings.rows[0]?.avg_rating != null ? Number(ratings.rows[0].avg_rating) : null,
      ratedCount: Number(ratings.rows[0]?.rated || 0),
      cost: {
        total: Number(c.total_cost || 0),
        avg: Number(c.avg_cost || 0),
        billedCount: Number(c.billed_count || 0),
        completedTotal: Number(c.completed_cost || 0),
      },
      byCategory: byCategory.rows.map((r) => ({
        category: r.category, count: Number(r.n), cost: Number(r.cost_total || 0),
      })),
    });
  } catch (err) {
    console.error('reports maintenance error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// === v2: Feature management API ===========================================
// Public read of enabled flags only — clients use this to hide UI for
// disabled features. The full config (with secrets-adjacent fields like
// SMTP host) is admin-only via /api/admin/features.
app.get('/api/features', async (_req, res) => {
  try {
    const f = await features.load(pool);
    const out = {};
    for (const [k, v] of Object.entries(f)) {
      out[k] = { enabled: !!v.enabled };
      // Expose a few non-secret display fields so the client can render
      // (e.g. i18n.defaultLocale, lateFee.ratePctPerMonth)
      const safe = ['defaultLocale', 'available', 'ratePctPerMonth', 'ratePct',
        'gracePeriodDays', 'mode', 'autoIncludeOnBillGen',
        'overdueDaysThreshold', 'requirePaymentForCard'];
      for (const s of safe) if (v[s] !== undefined) out[k][s] = v[s];
    }
    res.json({ ok: true, features: out });
  } catch (err) {
    console.error('features public error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/admin/features', requireAuth, async (_req, res) => {
  try {
    const f = await features.load(pool);
    // Never echo a secret. SMTP_PASS is env-only and not in DB anyway.
    res.json({ ok: true, features: f, defaults: features.DEFAULTS });
  } catch (err) {
    console.error('features admin GET error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.put('/api/admin/features', sameOrigin, csrfGuard, requireAuth, requireRole('owner'), async (req, res) => {
  const partial = req.body && req.body.features ? req.body.features : req.body;
  if (!partial || typeof partial !== 'object') {
    return res.status(400).json({ error: 'features object required' });
  }
  // Production safety: refuse to set the meter simulator mode in production.
  // The simulator generates fake hourly readings — running it on a live
  // building would silently overwrite real meter data with random walks and
  // poison every bill computed from `rooms.elecUnits`/`waterUnits`. Demo /
  // staging deploys can still flip it, but production must stay 'manual' or
  // 'mqtt'. The check honors NODE_ENV explicitly so a developer running
  // dev locally with NODE_ENV unset can still toggle the simulator.
  if (NODE_ENV === 'production' && partial.meterIot && partial.meterIot.mode === 'simulator') {
    audit(req, 'features.simulator_blocked', 'config', 'features',
      { attemptedBy: req.session.user.username });
    return res.status(403).json({
      error: 'ห้ามเปิด meter simulator ใน production — จะสร้างค่าเทียมทับข้อมูลมิเตอร์จริง',
      code: 'PRODUCTION_SIMULATOR_BLOCKED',
      hint: 'ตั้ง mode = "manual" หรือ "mqtt" แทน',
    });
  }
  try {
    const next = await features.save(pool, partial, req.session.user.username);
    audit(req, 'features.update', 'config', 'features', { keys: Object.keys(partial) });
    res.json({ ok: true, features: next });
  } catch (err) {
    console.error('features admin PUT error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// === v2: Tenants (table-backed) ===========================================
// Coexists with rooms[].tenant blob. Use this when the tenantPortal flag is
// enabled — gives us a stable id for contracts/bills/payments and a real
// PIN-based login.

const VALID_TENANT_STATUS = new Set(['active', 'moved_out', 'blacklist']);

function maskTenantOut(t) {
  if (!t) return t;
  const out = { ...t };
  if (out.citizen_id_encrypted) {
    delete out.citizen_id_encrypted;
    out.citizen_id_masked = out.citizen_id_tail ? `***-${out.citizen_id_tail}` : '***';
  }
  delete out.pin_hash;
  return out;
}

app.get('/api/tenants', requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const status = req.query.status;
    const params = [];
    const where = ['deleted_at IS NULL'];
    if (status && VALID_TENANT_STATUS.has(String(status))) {
      params.push(status); where.push(`status = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(LOWER(full_name) LIKE $${params.length} OR phone LIKE $${params.length} OR LOWER(COALESCE(email,'')) LIKE $${params.length})`);
    }
    const { rows } = await pool.query(
      `SELECT id, full_name, phone, email, line_user_id, current_room_id, status,
              citizen_id_tail, locale, created_at
         FROM tenants
         WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC LIMIT 500`,
      params
    );
    res.json({ ok: true, tenants: rows });
  } catch (err) {
    console.error('tenants list error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/tenants/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  try {
    // Pull every tenant column the admin UI needs in one round-trip,
    // including the new identity / address / emergency contact fields.
    // Older deploys without those columns get a SELECT * fallback so the
    // endpoint keeps working mid-migration.
    let rows;
    try {
      ({ rows } = await pool.query(
        `SELECT id, full_name, phone, email, line_user_id, line_oa_id,
                current_room_id, status,
                citizen_id_encrypted, citizen_id_tail, citizen_id_hash,
                citizen_id_image_front_id, citizen_id_image_back_id,
                address, emergency_contact_name, emergency_contact_phone,
                emergency_contact_relation,
                notes, locale, blacklist_reason,
                created_at, updated_at
           FROM tenants WHERE id=$1 AND deleted_at IS NULL`,
        [id]
      ));
    } catch (err) {
      if (err.code !== '42703') throw err;  // pre-migration deploy
      ({ rows } = await pool.query(
        `SELECT id, full_name, phone, email, line_user_id, current_room_id, status,
                citizen_id_encrypted, citizen_id_tail, notes, locale, blacklist_reason,
                created_at, updated_at
           FROM tenants WHERE id=$1 AND deleted_at IS NULL`,
        [id]
      ));
    }
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const flags = await features.load(pool);
    const out = maskTenantOut(rows[0]);
    // Don't echo the hash either — it's internal dedup state.
    delete out.citizen_id_hash;
    // Decrypt for admin if encryption is on AND the request asks
    if (flags.citizenIdEncryption && flags.citizenIdEncryption.enabled
        && req.query.includeCitizen === '1' && rows[0].citizen_id_encrypted) {
      try { out.citizen_id = cryptoSvc.decryptString(rows[0].citizen_id_encrypted); }
      catch (_e) { out.citizen_id = null; }
    }
    res.json({ ok: true, tenant: out });
  } catch (err) {
    console.error('tenant get error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// === GET /api/tenants/lookup-by-citizen-id ================================
// Admin types a 13-digit citizen ID before creating a new tenant. We hash
// it the same way as on tenant create + return any existing record
// matching the hash — even moved_out / blacklist tenants. Use case: a
// person who lived here last year wants to re-rent a room. Without this
// lookup admin would create a duplicate row and the partial unique index
// would block them; with it, admin sees the prior record + can reactivate.
//
// Owner / manager only — citizen ID is sensitive even at a hash level.
app.get('/api/tenants/lookup-by-citizen-id', requireAuth, requireRole('owner', 'manager'),
  async (req, res) => {
    const raw = String(req.query.citizenId || '').trim();
    if (!raw) return res.status(400).json({ error: 'citizenId required' });
    const thaiId = require('./services/thaiId');
    const norm = thaiId.normalize(raw);
    if (!norm) return res.status(400).json({ error: 'เลขบัตรประชาชนต้องเป็น 13 หลัก', code: 'INVALID_CITIZEN_ID' });
    if (!thaiId.validateChecksum(norm)) {
      // Don't 400 here — admin might be looking up a legacy record that
      // failed the checksum at creation. Surface a hint instead.
      console.warn('[lookup] caller queried with checksum-invalid ID');
    }
    const hash = thaiId.hashForLookup(norm);
    if (!hash) return res.status(400).json({ error: 'cannot hash input' });
    try {
      // Match by hash AND by tail — if the operator's deploy predates the
      // hash rollout, prior tenants may have only a tail saved. Tail-only
      // match is widened on purpose so admin still sees a hit (with a
      // confidence flag the UI can show).
      const byHash = await pool.query(
        `SELECT id, full_name, phone, status, current_room_id,
                citizen_id_tail, created_at, updated_at, deleted_at
           FROM tenants
          WHERE citizen_id_hash=$1
          ORDER BY (status='active') DESC, updated_at DESC LIMIT 5`,
        [hash]
      ).catch((err) => {
        if (err.code === '42703') return { rows: [] };  // pre-migration
        throw err;
      });
      const byTail = await pool.query(
        `SELECT id, full_name, phone, status, current_room_id,
                citizen_id_tail, created_at, updated_at, deleted_at
           FROM tenants
          WHERE citizen_id_tail=$1 AND deleted_at IS NULL
            AND id NOT IN (
              SELECT id FROM tenants WHERE citizen_id_hash=$2
            )
          ORDER BY (status='active') DESC, updated_at DESC LIMIT 5`,
        [norm.slice(-4), hash]
      ).catch(() => ({ rows: [] }));
      audit(req, 'tenant.citizen_lookup', 'tenant', null,
        { tail: norm.slice(-4), hashHits: byHash.rows.length, tailHits: byTail.rows.length });
      res.json({
        ok: true,
        // High-confidence: hash matches.
        matchedByHash: byHash.rows.map((r) => ({ ...r, matchType: 'hash' })),
        // Lower-confidence: tail matches (legacy data without hash).
        matchedByTailOnly: byTail.rows.map((r) => ({ ...r, matchType: 'tail-only' })),
        checksumValid: thaiId.validateChecksum(norm),
      });
    } catch (err) {
      console.error('citizen lookup error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

// === GET /api/tenants/:id/history =========================================
// One-stop view of every record tied to a tenant — works on active OR
// moved-out tenants. Used by the admin "history" tab so legal / audit
// queries don't have to fan out to multiple endpoints.
//
// Returns: tenant row + all contracts + all bills + all payments +
// maintenance tickets + access cards + identity images + recent audit
// log entries. Soft-deleted rows are EXCLUDED so accidentally-removed
// data doesn't leak — admin can still inspect via the audit log.
app.get('/api/tenants/:id/history', requireAuth, requireRole('owner', 'manager'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    try {
      // Allow even soft-deleted tenants here so admin can audit a deleted
      // record. The masking still hides citizen_id_encrypted + pin_hash.
      const tQ = await pool.query(
        `SELECT * FROM tenants WHERE id=$1`,
        [id]
      );
      if (!tQ.rows.length) return res.status(404).json({ error: 'tenant not found' });
      const tenant = maskTenantOut(tQ.rows[0]);
      delete tenant.citizen_id_hash;

      // Contracts (active + ended + expired). Ordered by most recent so
      // the current contract is first. Soft-deleted excluded.
      const contracts = await pool.query(
        `SELECT id, contract_no, room_id, start_date, end_date, term_months,
                monthly_rent, deposit, deposit_returned, deposit_returned_at,
                deposit_return_reason, discount_pct, status, signed_at,
                signature_image_id, agreed_terms_at, agreed_terms_version,
                created_at
           FROM contracts
          WHERE tenant_id=$1 AND deleted_at IS NULL
          ORDER BY start_date DESC, created_at DESC`,
        [id]
      ).catch(async (err) => {
        if (err.code !== '42703') throw err;
        // Pre-migration fallback
        return await pool.query(
          `SELECT id, contract_no, room_id, start_date, end_date,
                  monthly_rent, deposit, status, signed_at, created_at
             FROM contracts WHERE tenant_id=$1 AND deleted_at IS NULL
             ORDER BY start_date DESC, created_at DESC`,
          [id]
        );
      });

      // Bills (every status, soft-deleted excluded). Latest first.
      const bills = await pool.query(
        `SELECT id, bill_no, room_id, period, total, due_date, paid_at, status,
                rent, water_amount, elec_amount, wifi, late_fee, vat,
                created_at
           FROM bills
          WHERE tenant_id=$1 AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT 200`,
        [id]
      );

      // Payments (joined to bill_no for display).
      const payments = await pool.query(
        `SELECT p.id, p.bill_id, b.bill_no, p.amount, p.method, p.ref,
                p.status, p.verified_by, p.verified_at, p.verify_provider,
                p.created_at
           FROM payments p
           LEFT JOIN bills b ON b.id = p.bill_id
          WHERE p.tenant_id=$1
          ORDER BY p.created_at DESC LIMIT 200`,
        [id]
      );

      // Maintenance tickets — owned by this tenant (tenant_id stamped at
      // create time, or matched via phone for legacy public submissions).
      const tickets = await pool.query(
        `SELECT id, ticket_no, room_id, category, priority, status, title,
                rating, rating_comment, created_at, completed_at
           FROM maintenance_tickets
          WHERE tenant_id=$1
          ORDER BY created_at DESC LIMIT 100`,
        [id]
      );

      // Access cards (active + revoked, gives a complete history).
      const cards = await pool.query(
        `SELECT id, card_id, room_id, status, issued_at, revoked_at, revoke_reason
           FROM access_cards
          WHERE tenant_id=$1
          ORDER BY issued_at DESC`,
        [id]
      );

      // Identity images URL (front+back) — same shape as /identity GET.
      const identity = await pool.query(
        `SELECT t.citizen_id_tail,
                t.citizen_id_image_front_id, t.citizen_id_image_back_id,
                ff.url AS front_url, bf.url AS back_url,
                ff.uploaded_at AS front_uploaded_at, bf.uploaded_at AS back_uploaded_at
           FROM tenants t
           LEFT JOIN file_uploads ff ON ff.id = t.citizen_id_image_front_id
           LEFT JOIN file_uploads bf ON bf.id = t.citizen_id_image_back_id
          WHERE t.id=$1`,
        [id]
      ).catch((err) => {
        if (err.code === '42703') return { rows: [{ citizen_id_tail: tenant.citizen_id_tail }] };
        throw err;
      });

      // Recent audit log entries that mention this tenant. Last 100 events.
      // (Local variable renamed `auditEntries` to avoid shadowing the outer
      // `audit(...)` helper in server.js which is in scope here.)
      const auditEntries = await pool.query(
        `SELECT id, user_id, action, entity_type, entity_id, detail, created_at
           FROM audit_logs
          WHERE (entity_type='tenant' AND entity_id=$1)
             OR (action LIKE 'tenant.%' AND entity_id=$1)
             OR (action LIKE 'contract.%' AND entity_id IN (
                 SELECT id::text FROM contracts WHERE tenant_id=$2 AND deleted_at IS NULL
               ))
             OR (action LIKE 'bill.%' AND entity_id IN (
                 SELECT id::text FROM bills WHERE tenant_id=$2 AND deleted_at IS NULL
               ))
          ORDER BY created_at DESC LIMIT 100`,
        [String(id), id]
      );

      // Aggregate totals so admin sees the bottom line at a glance.
      const totals = {
        contracts: contracts.rows.length,
        bills: bills.rows.length,
        billsPaid: bills.rows.filter((b) => b.status === 'paid').length,
        billsOutstanding: bills.rows
          .filter((b) => b.status === 'pending' || b.status === 'overdue')
          .reduce((s, b) => s + Number(b.total || 0), 0),
        payments: payments.rows.length,
        paymentsTotal: payments.rows
          .filter((p) => p.status === 'verified')
          .reduce((s, p) => s + Number(p.amount || 0), 0),
        tickets: tickets.rows.length,
        ticketsOpen: tickets.rows.filter((t) => t.status !== 'completed' && t.status !== 'cancelled').length,
        accessCardsActive: cards.rows.filter((c) => c.status === 'active').length,
        accessCardsRevoked: cards.rows.filter((c) => c.status === 'revoked').length,
      };

      res.json({
        ok: true,
        tenant,
        identity: identity.rows[0] || {},
        contracts: contracts.rows,
        bills: bills.rows,
        payments: payments.rows,
        tickets: tickets.rows,
        accessCards: cards.rows,
        auditLog: auditEntries.rows,
        totals,
      });
    } catch (err) {
      console.error('tenant history error:', err);
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    }
  });

app.post('/api/tenants', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  const b = req.body || {};
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const fullName = str(b.fullName, 200).trim();
  // Normalise phone the same way schemas.phoneStr does (strip dashes +
  // spaces) so admin-entered "081-234-5678" matches the tenant-typed
  // "0812345678" at login. Three-way drift between admin-create (raw),
  // schemas.phoneStr (stripped), and tenant-login (raw) was the root
  // cause of "tenant can't log in even though admin created the row".
  const rawPhone = str(b.phone, 32).trim();
  const phone = rawPhone.replace(/[\s-]/g, '');
  if (!fullName || !phone) {
    return res.status(400).json({ error: 'fullName and phone required' });
  }
  // Reject obvious junk after normalisation so we don't store "abcdef" as a
  // phone number (matches the schemas.phoneStr regex shape).
  if (!/^[\d+]{8,20}$/.test(phone)) {
    return res.status(400).json({ error: 'เบอร์โทรไม่ถูกต้อง', code: 'INVALID_PHONE' });
  }
  const flags = await features.load(pool);
  const thaiId = require('./services/thaiId');
  // Normalise + validate Thai citizen ID. The mod-11 checksum catches typo
  // errors at create-time so admin doesn't end up with a row that can never
  // match anyone (and that the dedup index can't compare against). When
  // checksum fails AND the operator passes `force: true` we accept the
  // value but skip the hash (no dedup possible) — this preserves the
  // legacy edge case where existing data was entered without a check
  // digit but is otherwise meaningful.
  const citizenIdNorm = thaiId.normalize(str(b.citizenId, 32));
  let citizenEnc = null, citizenTail = null, citizenHash = null;
  if (b.citizenId && !citizenIdNorm) {
    return res.status(400).json({
      error: 'เลขบัตรประชาชนต้องเป็น 13 หลัก (ใส่ขีดได้)',
      code: 'INVALID_CITIZEN_ID',
    });
  }
  if (citizenIdNorm) {
    if (!thaiId.validateChecksum(citizenIdNorm) && b.force !== true) {
      return res.status(400).json({
        error: 'เลขบัตรประชาชนไม่ผ่านการตรวจสอบ check digit (mod-11)',
        code: 'INVALID_CHECKSUM',
        hint: 'ตรวจดูเลขที่ป้อนอีกครั้ง หรือส่ง { force: true } ถ้ายืนยัน (audit-logged)',
      });
    }
    citizenTail = citizenIdNorm.slice(-4);
    citizenHash = thaiId.validateChecksum(citizenIdNorm)
      ? thaiId.hashForLookup(citizenIdNorm)
      : null;  // skip hash if checksum failed but force=true (no dedup)
    if (flags.citizenIdEncryption && flags.citizenIdEncryption.enabled) {
      try { citizenEnc = cryptoSvc.encryptString(citizenIdNorm); }
      catch (e) {
        return res.status(500).json({ error: 'crypto unavailable: ' + e.message });
      }
    } else {
      citizenEnc = citizenIdNorm; // plaintext — not recommended
    }
  }
  let pinHash = null;
  if (b.pin) {
    if (!/^\d{4,8}$/.test(String(b.pin))) {
      return res.status(400).json({ error: 'PIN ต้องเป็นตัวเลข 4-8 หลัก' });
    }
    if (isTrivialPin(b.pin)) {
      return res.status(400).json({ error: 'PIN ไม่ปลอดภัย — เลี่ยงรูปแบบที่คาดเดาง่าย เช่น 1234, 0000, 1111' });
    }
    pinHash = await bcrypt.hash(String(b.pin), 10);
  }
  // Pre-flight dedup check. Two cohorts to look at:
  //   1. citizen_id_hash matches (high confidence) — the partial unique
  //      index catches this at INSERT time too, but a 409 with the prior
  //      tenant's id is more actionable than a generic 23505.
  //   2. citizen_id_tail matches BUT hash is NULL on the prior row. This
  //      catches the dedup escape where tenant A was created with a
  //      checksum-invalid id + force=true (we set hash=NULL there to
  //      preserve the legacy data path), and tenant B comes along with a
  //      valid id whose tail matches A. Without this check, B would slip
  //      past pre-flight + the partial unique because A's hash is NULL.
  if (citizenIdNorm && b.force !== true) {
    try {
      let dup = null;
      if (citizenHash) {
        const r = await pool.query(
          `SELECT id, full_name, status FROM tenants
             WHERE citizen_id_hash=$1 AND deleted_at IS NULL AND status='active' LIMIT 1`,
          [citizenHash]
        );
        dup = r.rows[0] || null;
      }
      if (!dup) {
        const r = await pool.query(
          `SELECT id, full_name, status FROM tenants
             WHERE citizen_id_tail=$1 AND deleted_at IS NULL AND status='active' LIMIT 1`,
          [citizenTail]
        );
        dup = r.rows[0] || null;
      }
      if (dup) {
        return res.status(409).json({
          error: 'เลขบัตรนี้ถูกบันทึกในระบบแล้วกับผู้เช่ารายอื่น',
          code: 'CITIZEN_ID_DUPLICATE',
          conflict: dup,
          hint: 'ส่ง { force: true } ถ้ายืนยันว่าเป็นคนเดิม (audit-logged)',
        });
      }
    } catch (err) {
      // Older deploys without the column fall through silently.
      if (err.code !== '42703') console.warn('[tenant create] dedup check skipped:', err.message);
    }
  }
  // Optional address + emergency contact (admin can leave blank — the
  // checkin endpoint enforces presence when generating contracts).
  const address = str(b.address, 500) || null;
  const ecName    = str(b.emergencyContactName, 200) || null;
  const ecPhone   = str(b.emergencyContactPhone, 32) || null;
  const ecRel     = str(b.emergencyContactRelation, 64) || null;
  // Normalise emergency phone the same way as primary phone.
  const ecPhoneNorm = ecPhone ? ecPhone.trim().replace(/[\s-]/g, '') : null;
  if (ecPhoneNorm && !/^[\d+]{8,20}$/.test(ecPhoneNorm)) {
    return res.status(400).json({
      error: 'เบอร์โทรผู้ติดต่อฉุกเฉินไม่ถูกต้อง',
      code: 'INVALID_EMERGENCY_PHONE',
    });
  }
  try {
    let rows;
    try {
      ({ rows } = await pool.query(
        `INSERT INTO tenants
          (full_name, phone, citizen_id_encrypted, citizen_id_tail, citizen_id_hash,
           email, line_user_id, pin_hash, current_room_id, status, notes, locale,
           address, emergency_contact_name, emergency_contact_phone, emergency_contact_relation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING id, full_name, phone, email, current_room_id, status, created_at`,
        [
          fullName, phone, citizenEnc, citizenTail, citizenHash,
          str(b.email, 200) || null,
          str(b.lineUserId, 64) || null,
          pinHash,
          str(b.roomId, 32) || null,
          VALID_TENANT_STATUS.has(b.status) ? b.status : 'active',
          str(b.notes, 1000) || null,
          ['th', 'en'].includes(b.locale) ? b.locale : 'th',
          address, ecName, ecPhoneNorm, ecRel,
        ]
      ));
    } catch (err) {
      // 23505 from the partial unique on citizen_id_hash → race lost.
      if (err.code === '23505' && err.constraint === 'uq_tenants_citizen_id_hash_active') {
        return res.status(409).json({
          error: 'เลขบัตรนี้ผูกกับผู้เช่ารายอื่นแล้ว (race)',
          code: 'CITIZEN_ID_DUPLICATE',
        });
      }
      // Older deploys without the new columns fall back to the legacy INSERT.
      if (err.code === '42703') {
        ({ rows } = await pool.query(
          `INSERT INTO tenants
            (full_name, phone, citizen_id_encrypted, citizen_id_tail, email, line_user_id,
             pin_hash, current_room_id, status, notes, locale)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING id, full_name, phone, email, current_room_id, status, created_at`,
          [
            fullName, phone, citizenEnc, citizenTail,
            str(b.email, 200) || null,
            str(b.lineUserId, 64) || null,
            pinHash,
            str(b.roomId, 32) || null,
            VALID_TENANT_STATUS.has(b.status) ? b.status : 'active',
            str(b.notes, 1000) || null,
            ['th', 'en'].includes(b.locale) ? b.locale : 'th',
          ]
        ));
      } else {
        throw err;
      }
    }
    // Optional: carry over the citizen ID photo from a public booking the
    // applicant submitted earlier. Without this hand-off the photo would
    // sit in file_uploads with refId='public-booking-pending' forever +
    // admin would have to re-take it at the office. With bookingId set,
    // we re-target the file row + link it on the new tenant.
    if (b.bookingId) {
      try {
        const bookingId = String(b.bookingId).slice(0, 64);
        let fid = null;
        try {
          const bk = await pool.query(
            `SELECT citizen_id_image_front_id FROM bookings WHERE external_id=$1 LIMIT 1`,
            [bookingId]
          );
          fid = bk.rows[0] && bk.rows[0].citizen_id_image_front_id;
        } catch (err) {
          // 42703 = pre-migration column absent. 42P01 = bookings table
          // missing entirely (legacy deploy). Both are expected on older
          // installs — skip carry-over silently. Anything else is a real
          // error that should be visible.
          if (err.code !== '42703' && err.code !== '42P01') throw err;
        }
        if (fid) {
          // Verify the file is actually a citizen-ID image with the
          // public-booking-pending placeholder ref_id we wrote at upload
          // time. Without this, a corrupted booking row pointing at the
          // wrong file_uploads.id (e.g. an unrelated contract_signature)
          // would get re-targeted onto the tenant's identity FK column.
          const fileQ = await pool.query(
            `SELECT id FROM file_uploads
               WHERE id=$1 AND category='citizen_id_image'
                 AND (ref_id='public-booking-pending' OR ref_id IS NULL)
               LIMIT 1`,
            [fid]
          );
          if (fileQ.rows.length) {
            await pool.query(
              `UPDATE tenants SET citizen_id_image_front_id=$1, updated_at=NOW() WHERE id=$2`,
              [fid, rows[0].id]
            );
            await pool.query(
              `UPDATE file_uploads SET ref_id=$1 WHERE id=$2 AND category='citizen_id_image'`,
              [String(rows[0].id), fid]
            );
          } else {
            console.warn('[tenant.create] booking photo skipped — wrong category or ref_id');
          }
        }
      } catch (err) {
        console.warn('[tenant.create] booking photo link skipped:', err.message);
      }
    }
    audit(req, 'tenant.create', 'tenant', String(rows[0].id),
      { hasIdentity: !!(b.citizenIdImageFront || b.citizenIdImageBack),
        linkedFromBooking: b.bookingId || null, force: b.force === true });
    res.json({
      ok: true, tenant: rows[0],
      // Hint to UI: if citizen ID images were sent in the same payload,
      // POST them to /identity now using the returned id. Keeping the
      // upload separate avoids 3MB-per-tenant-create payloads.
      identityUploadHint: (b.citizenIdImageFront || b.citizenIdImageBack)
        ? `POST /api/tenants/${rows[0].id}/identity` : null,
    });
  } catch (err) {
    console.error('tenant create error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.put('/api/tenants/:id', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  const b = req.body || {};
  const fields = [];
  const params = [];
  let i = 1;
  const set = (col, val) => { fields.push(`${col} = $${i++}`); params.push(val); };
  if (b.fullName !== undefined) set('full_name', String(b.fullName).slice(0, 200));
  if (b.phone !== undefined) {
    // Normalise on update too — without this, admin's "fix the phone format"
    // edit silently re-introduces dashes that block tenant login.
    const normPhone = String(b.phone).slice(0, 32).trim().replace(/[\s-]/g, '');
    if (!/^[\d+]{8,20}$/.test(normPhone)) {
      return res.status(400).json({ error: 'เบอร์โทรไม่ถูกต้อง', code: 'INVALID_PHONE' });
    }
    set('phone', normPhone);
  }
  if (b.email !== undefined) set('email', b.email ? String(b.email).slice(0, 200) : null);
  if (b.lineUserId !== undefined) set('line_user_id', b.lineUserId ? String(b.lineUserId).slice(0, 64) : null);
  if (b.roomId !== undefined) set('current_room_id', b.roomId ? String(b.roomId).slice(0, 32) : null);
  if (b.status !== undefined) {
    if (!VALID_TENANT_STATUS.has(String(b.status))) return res.status(400).json({ error: 'invalid status' });
    set('status', b.status);
    if (b.status === 'blacklist' && b.blacklistReason) set('blacklist_reason', String(b.blacklistReason).slice(0, 500));
  }
  if (b.notes !== undefined) set('notes', b.notes ? String(b.notes).slice(0, 1000) : null);
  if (b.locale !== undefined && ['th', 'en'].includes(b.locale)) set('locale', b.locale);
  if (b.pin !== undefined && b.pin) {
    if (!/^\d{4,8}$/.test(String(b.pin))) return res.status(400).json({ error: 'PIN ต้องเป็นตัวเลข 4-8 หลัก' });
    if (isTrivialPin(b.pin)) return res.status(400).json({ error: 'PIN ไม่ปลอดภัย — เลี่ยงรูปแบบที่คาดเดาง่าย' });
    const hash = await bcrypt.hash(String(b.pin), 10);
    set('pin_hash', hash);
  }
  if (b.citizenId !== undefined) {
    const thaiId = require('./services/thaiId');
    const norm = thaiId.normalize(b.citizenId || '');
    if (b.citizenId && !norm) {
      return res.status(400).json({ error: 'เลขบัตรประชาชนต้องเป็น 13 หลัก', code: 'INVALID_CITIZEN_ID' });
    }
    if (norm) {
      if (!thaiId.validateChecksum(norm) && b.force !== true) {
        return res.status(400).json({
          error: 'เลขบัตรประชาชนไม่ผ่าน check digit (mod-11)',
          code: 'INVALID_CHECKSUM',
        });
      }
      const flags = await features.load(pool);
      try {
        const enc = (flags.citizenIdEncryption && flags.citizenIdEncryption.enabled)
          ? cryptoSvc.encryptString(norm) : norm;
        set('citizen_id_encrypted', enc);
        set('citizen_id_tail', norm.slice(-4));
        // Recompute hash on update so dedup index reflects the new value.
        // Skip when checksum failed but operator forced — same policy as create.
        if (thaiId.validateChecksum(norm)) {
          const newHash = thaiId.hashForLookup(norm);
          // Pre-flight dup check (advisory unless force=true).
          if (newHash && b.force !== true) {
            const dup = await pool.query(
              `SELECT id, full_name FROM tenants
                 WHERE citizen_id_hash=$1 AND id<>$2 AND deleted_at IS NULL AND status='active' LIMIT 1`,
              [newHash, id]
            ).catch(() => ({ rows: [] }));
            if (dup.rows.length) {
              return res.status(409).json({
                error: 'เลขบัตรนี้ผูกกับผู้เช่ารายอื่นแล้ว',
                code: 'CITIZEN_ID_DUPLICATE',
                conflict: dup.rows[0],
              });
            }
          }
          set('citizen_id_hash', newHash);
        } else {
          set('citizen_id_hash', null);  // checksum forced — drop dedup
        }
      } catch (e) { return res.status(500).json({ error: 'crypto: ' + e.message }); }
    } else {
      set('citizen_id_encrypted', null);
      set('citizen_id_tail', null);
      set('citizen_id_hash', null);
    }
  }
  // Address + emergency contact updates. All optional; empty string clears.
  if (b.address !== undefined) {
    set('address', b.address ? String(b.address).slice(0, 500) : null);
  }
  if (b.emergencyContactName !== undefined) {
    set('emergency_contact_name', b.emergencyContactName ? String(b.emergencyContactName).slice(0, 200) : null);
  }
  if (b.emergencyContactPhone !== undefined) {
    const ec = b.emergencyContactPhone
      ? String(b.emergencyContactPhone).slice(0, 32).trim().replace(/[\s-]/g, '') : null;
    if (ec && !/^[\d+]{8,20}$/.test(ec)) {
      return res.status(400).json({ error: 'เบอร์โทรผู้ติดต่อฉุกเฉินไม่ถูกต้อง', code: 'INVALID_EMERGENCY_PHONE' });
    }
    set('emergency_contact_phone', ec);
  }
  if (b.emergencyContactRelation !== undefined) {
    set('emergency_contact_relation', b.emergencyContactRelation ? String(b.emergencyContactRelation).slice(0, 64) : null);
  }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
  fields.push('updated_at = NOW()');
  // Optimistic locking: if the client sent a `version` (= server's last
  // updated_at), we add it to the WHERE clause. Two concurrent edits → the
  // second UPDATE returns 0 rows → 409 with the current state so the UI
  // can prompt the user to reload before retrying. Without `version` we
  // fall back to last-write-wins (preserves backwards compat).
  let lockClause = '';
  if (b.version) {
    params.push(b.version);
    lockClause = ` AND updated_at = $${params.length}`;
  }
  params.push(id);
  try {
    const { rows } = await pool.query(
      `UPDATE tenants SET ${fields.join(', ')}
         WHERE id=$${params.length} AND deleted_at IS NULL${lockClause}
         RETURNING id, updated_at`,
      params
    );
    if (!rows.length) {
      if (b.version) {
        // Either the row is gone or the version is stale. Look up to tell apart.
        const cur = await pool.query(
          `SELECT id, full_name, phone, email, current_room_id, status, updated_at
             FROM tenants WHERE id=$1 AND deleted_at IS NULL`,
          [id]
        );
        if (cur.rows.length) {
          return res.status(409).json({
            error: 'ผู้ใช้อื่นแก้ไขข้อมูลนี้ไปแล้ว — โปรดโหลดข้อมูลใหม่ก่อนแก้ไข',
            code: 'VERSION_CONFLICT',
            current: cur.rows[0],
          });
        }
      }
      return res.status(404).json({ error: 'not found', code: 'NOT_FOUND' });
    }
    audit(req, 'tenant.update', 'tenant', String(id), { fields: Object.keys(b) });
    res.json({ ok: true, id, updated_at: rows[0].updated_at });
  } catch (err) {
    console.error('tenant update error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.delete('/api/tenants/:id', sameOrigin, csrfGuard, requireAuth, requireRole('owner'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  try {
    const flags = await features.load(pool);
    if (flags.softDelete && flags.softDelete.enabled) {
      await pool.query(`UPDATE tenants SET deleted_at=NOW() WHERE id=$1`, [id]);
    } else {
      // Hard delete is dangerous: tenants(id) has FK references from bills,
      // contracts, payments, access_cards, line_bindings (CASCADE),
      // recurring_charges (CASCADE), tenant_sessions (NOT NULL).
      // Most FKs are ON DELETE NO ACTION → the DELETE fails with 23503 and
      // the tenant stays orphaned. Surface that as a clear 409 instead of
      // a generic 500 so admin knows to use soft-delete (or clean refs first).
      try {
        await pool.query(`DELETE FROM tenants WHERE id=$1`, [id]);
      } catch (err) {
        if (err.code === '23503') {
          return res.status(409).json({
            error: 'ลบไม่ได้ — ผู้เช่ายังมีบิล/สัญญา/บัตรเข้า-ออกเชื่อมโยง โปรดเปิด softDelete หรือลบข้อมูลที่เชื่อมโยงก่อน',
            code: 'TENANT_HAS_REFS',
          });
        }
        throw err;
      }
    }
    audit(req, 'tenant.delete', 'tenant', String(id));
    res.json({ ok: true });
  } catch (err) {
    console.error('tenant delete error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// === v2: Tenant portal auth ================================================
// Simple hand-rolled session table (tenant_sessions). We don't want to share
// express-session with admins (different cookie, different secret would help
// but separating sessions by table is cleaner).

const TENANT_COOKIE = 'tenant_sid';

function makeSid() {
  const c = require('crypto');
  return c.randomBytes(24).toString('base64url');
}

function hashSid(sid) {
  return require('crypto').createHash('sha256').update(String(sid)).digest('hex');
}

async function tenantSessionLookup(req) {
  const flags = await features.load(pool);
  if (!flags.tenantPortal || !flags.tenantPortal.enabled) return null;
  const sid = req.headers.cookie ? (req.headers.cookie.match(/(?:^|;\s*)tenant_sid=([^;]+)/) || [])[1] : null;
  if (!sid) return null;
  const sidHash = hashSid(sid);
  const { rows } = await pool.query(
    `SELECT s.tenant_id, s.expire, s.sid_hash, t.full_name, t.phone, t.email, t.line_user_id,
            t.current_room_id, t.status, t.locale
       FROM tenant_sessions s JOIN tenants t ON t.id = s.tenant_id
       WHERE s.sid_hash = $1 AND s.expire > NOW() AND t.deleted_at IS NULL`,
    [sidHash]
  );
  if (!rows.length) return null;
  const session = rows[0];
  // Sliding session: when the cookie is past 50% of its lifetime, extend
  // expire to a fresh full window. Avoids logging tenants out mid-session
  // while they're actively using the portal. Best-effort: failures are
  // silent so a slow DB doesn't block the auth check.
  try {
    const days = Number((flags.tenantPortal && flags.tenantPortal.sessionDays) || 30);
    const now = Date.now();
    const expire = new Date(session.expire).getTime();
    const halfLife = (days / 2) * 86_400_000;
    if (expire - now < halfLife) {
      const newExpire = new Date(now + days * 86_400_000);
      pool.query(`UPDATE tenant_sessions SET expire=$1 WHERE sid_hash=$2`, [newExpire, sidHash])
        .catch(() => {});
    }
  } catch { /* ignore */ }
  return session;
}

async function requireTenant(req, res, next) {
  try {
    const t = await tenantSessionLookup(req);
    if (!t) return res.status(401).json({ error: 'unauthorized' });
    if (t.status === 'blacklist') return res.status(403).json({ error: 'account suspended' });
    req.tenant = t;
    next();
  } catch (err) {
    console.error('requireTenant error:', err);
    res.status(500).json({ error: 'internal error' });
  }
}

const rateLimitTenantLogin = makeIpLimiter({
  windowMs: 15 * 60_000, max: 8, message: 'too many login attempts',
});

app.post('/api/tenant/login', sameOrigin, rateLimitTenantLogin, features.requireFeature('tenantPortal'),
  // Wire the tenantLogin schema so phoneStr's dash/space normalisation runs
  // before the DB lookup. Without this a tenant typing "081-234-5678" got
  // an exact-match miss against admin-stored "0812345678" and login failed
  // with no useful feedback. The lockout key derives from the normalised
  // phone too, so an attacker can't dodge per-account rate limiting by
  // alternating between formatted/unformatted phone numbers.
  validateBody(schemas.tenantLogin),
  async (req, res) => {
  const phone = req.body.phone;
  const pin = req.body.pin;
  const principal = `tenant:${phone}`;
  try {
    try {
      await lockout.check(principal);
    } catch (err) {
      if (err.code === 'LOCKED_OUT') {
        const minutes = Math.ceil((err.retryAfterMs || 0) / 60_000);
        return res.status(429).json({
          error: `บัญชีถูกล็อกชั่วคราว — ลองใหม่ใน ${minutes} นาที`,
          code: 'LOCKED_OUT',
        });
      }
      throw err;
    }
    const { rows } = await pool.query(
      `SELECT id, full_name, pin_hash, status FROM tenants
         WHERE phone=$1 AND deleted_at IS NULL LIMIT 1`,
      [phone]
    );
    const t = rows[0] || null;
    const hash = (t && t.pin_hash) ? t.pin_hash : DUMMY_HASH;
    // Always run bcrypt so timing is constant — A3 fix: don't reveal account
    // existence/status through response speed or status code.
    const ok = await bcrypt.compare(pin, hash);
    if (!t || !t.pin_hash || !ok) {
      lockout.recordFailure(principal, 'tenant').catch(() => {});
      audit(req, 'tenant.login_failed', 'tenant', phone, null, phone).catch(() => {});
      return res.status(401).json({ error: 'invalid credentials' });
    }
    // Only AFTER credentials check do we surface blacklist as a different
    // status — so attackers can't enumerate suspended accounts without
    // already knowing the PIN.
    if (t.status === 'blacklist') {
      return res.status(403).json({ error: 'account suspended' });
    }
    lockout.reset(principal).catch(() => {});
    const sid = makeSid();
    const sidHash = hashSid(sid);
    const days = (req.features?.tenantPortal?.sessionDays) || 30;
    const expire = new Date(Date.now() + days * 86_400_000);
    // sid column kept (PRIMARY KEY) but populated with hash too — only the
    // hash is queryable; the raw cookie never round-trips through the DB.
    await pool.query(
      `INSERT INTO tenant_sessions (sid, sid_hash, tenant_id, expire, ip, ua)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [sidHash, sidHash, t.id, expire, clientIp(req), (req.headers['user-agent'] || '').slice(0, 400)]
    );
    res.cookie(TENANT_COOKIE, sid, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: expire,
    });
    audit(req, 'tenant.login', 'tenant', String(t.id));
    res.json({ ok: true, tenant: { id: t.id, fullName: t.full_name } });
  } catch (err) {
    console.error('tenant login error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/tenant/logout', sameOrigin, csrfGuard, async (req, res) => {
  try {
    const sid = req.headers.cookie ? (req.headers.cookie.match(/(?:^|;\s*)tenant_sid=([^;]+)/) || [])[1] : null;
    if (sid) await pool.query(`DELETE FROM tenant_sessions WHERE sid_hash=$1`, [hashSid(sid)]);
    res.clearCookie(TENANT_COOKIE);
    res.json({ ok: true });
  } catch (err) {
    console.error('tenant logout error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/tenant/me', async (req, res) => {
  try {
    const t = await tenantSessionLookup(req);
    if (!t) return res.json({ tenant: null });
    res.json({
      tenant: {
        id: t.tenant_id, fullName: t.full_name, phone: t.phone,
        email: t.email, roomId: t.current_room_id, locale: t.locale,
        status: t.status,
      },
    });
  } catch (err) {
    res.json({ tenant: null });
  }
});

// Tenant updates their own profile (locale + email only). Locale was
// previously persisted to localStorage only, so it reset every time the
// tenant cleared cookies or used another device.
app.put('/api/tenant/me', sameOrigin, csrfGuard, requireTenant, async (req, res) => {
  const b = req.body || {};
  const fields = [], params = [];
  let i = 1;
  if (b.locale !== undefined && ['th', 'en'].includes(String(b.locale))) {
    fields.push(`locale=$${i++}`); params.push(String(b.locale));
  }
  if (b.email !== undefined) {
    const e = b.email ? String(b.email).slice(0, 200).trim() : null;
    fields.push(`email=$${i++}`); params.push(e);
  }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
  fields.push('updated_at = NOW()');
  params.push(req.tenant.tenant_id);
  try {
    await pool.query(
      `UPDATE tenants SET ${fields.join(', ')} WHERE id=$${i} AND deleted_at IS NULL`,
      params
    );
    audit(req, 'tenant.profile_update', 'tenant', String(req.tenant.tenant_id),
      { fields: Object.keys(b) }, `tenant:${req.tenant.tenant_id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('tenant me PUT error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/tenant/payment-info — exposes the operator's accepted payment
// channels (PromptPay number, bank account, LINE Pay/TrueMoney/credit-card
// toggles) to the tenant portal so the BillDetail screen can render them.
// Reads from baankarn_config_v1.payment + the buildPaymentBlock helper so the
// shape matches what PDFs render. No authentication beyond the tenant cookie
// — these are details we already print on every invoice.
app.get('/api/tenant/payment-info', requireTenant, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM app_data WHERE key='baankarn_config_v1'`
    );
    const cfg = rows.length ? rows[0].value : {};
    const block = require('./services/billing').buildPaymentBlock(cfg);
    // Last-resort fallback to env var if the operator never filled in the
    // form: matches the bill-render endpoint's behaviour at server.js:1196.
    if (!block.promptpayTarget) {
      const envPp = require('./services/secrets').get('PROMPTPAY_TARGET');
      if (envPp) {
        block.promptpayTarget = envPp;
        if (!block.paymentMethods.find((m) => m.key === 'promptpay')) {
          block.paymentMethods.unshift({ key: 'promptpay', label: 'PromptPay', enabled: true });
        }
      }
    }
    res.json({ ok: true, payment: block, building: cfg.building || null });
  } catch (err) {
    console.error('tenant payment-info error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/tenant/contract — current active contract for the logged-in
// tenant. Read-only (tenant can't modify their own terms). Used by the
// tenant portal "my contract" tab so they can verify rent/deposit/end-date
// without calling the office. Returns the most recent active contract;
// historical contracts available via /history (admin only).
app.get('/api/tenant/contract', requireTenant, async (req, res) => {
  try {
    let rows;
    try {
      ({ rows } = await pool.query(
        `SELECT id, contract_no, room_id, start_date, end_date, term_months,
                monthly_rent, deposit, deposit_returned, deposit_returned_at,
                discount_pct, status, signed_at, agreed_terms_at,
                agreed_terms_version, created_at,
                CASE WHEN end_date IS NULL THEN NULL
                     ELSE (end_date - CURRENT_DATE)::int
                END AS days_left
           FROM contracts
          WHERE tenant_id=$1 AND deleted_at IS NULL
          ORDER BY (status='active') DESC, start_date DESC, created_at DESC
          LIMIT 1`,
        [req.tenant.tenant_id]
      ));
    } catch (err) {
      if (err.code !== '42703') throw err;  // pre-migration deploy
      ({ rows } = await pool.query(
        `SELECT id, contract_no, room_id, start_date, end_date,
                monthly_rent, deposit, status, signed_at, created_at
           FROM contracts WHERE tenant_id=$1 AND deleted_at IS NULL
           ORDER BY start_date DESC LIMIT 1`,
        [req.tenant.tenant_id]
      ));
    }
    if (!rows.length) {
      return res.json({ ok: true, contract: null, hasContract: false });
    }
    res.json({ ok: true, contract: rows[0], hasContract: true });
  } catch (err) {
    console.error('tenant contract error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/tenant/bills', requireTenant, async (req, res) => {
  // B4 — pagination. Bills typically arrive once a month, so 24 default
  // covers 2 years; max 100 per page.
  const limit = Math.min(Math.max(Number(req.query.limit) || 24, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const status = req.query.status;
  const where = ['tenant_id=$1', 'deleted_at IS NULL'];
  const params = [req.tenant.tenant_id];
  if (status && ['pending', 'paid', 'overdue', 'void'].includes(String(status))) {
    params.push(status);
    where.push(`status=$${params.length}`);
  }
  params.push(limit, offset);
  try {
    const { rows } = await pool.query(
      `SELECT id, bill_no, period, rent, water_units, water_rate, water_amount,
              elec_units, elec_rate, elec_amount, wifi, other,
              subtotal, vat, late_fee, total,
              due_date, status, paid_at, created_at
         FROM bills
         WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ ok: true, bills: rows, limit, offset });
  } catch (err) {
    console.error('tenant bills error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Tenant-side PDF download for a specific bill they own. Mirrors the
// admin /api/bills/render endpoint, but the source-of-truth here is the
// stored bills row (tenant doesn't get to dictate amounts), and ownership
// is enforced via tenant_id. Without this, a tenant who wants a printed
// receipt has to ask admin every month — annoying, and the data is
// already on the server.
app.get('/api/tenant/bills/:id/pdf', requireTenant, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'invalid id' });
  }
  let acquired = false;
  try {
    const { rows } = await pool.query(
      `SELECT b.*, t.full_name AS tenant_name, t.phone AS tenant_phone
         FROM bills b
         LEFT JOIN tenants t ON t.id = b.tenant_id
        WHERE b.id=$1 AND b.deleted_at IS NULL`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'bill not found' });
    const b = rows[0];
    // Ownership: tenant can only download their own bill. Match the same
    // logic as /api/tenant/bills (tenant_id), so a guessable bill_id can't
    // be used to fetch someone else's PDF.
    if (Number(b.tenant_id) !== Number(req.tenant.tenant_id)) {
      return res.status(403).json({ error: 'not your bill' });
    }
    // Compose the bill object expected by services/pdf.renderBillPdf —
    // the same shape the admin POST /api/bills/render builds. Field
    // name remap: snake_case (DB) → camelCase (PDF renderer).
    const cfgQ = await pool.query(
      `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
    );
    const config = cfgQ.rows[0]?.value || {};
    const paymentBlock = billing.buildPaymentBlock(config);
    if (!paymentBlock.promptpayTarget) {
      const envPp = require('./services/secrets').get('PROMPTPAY_TARGET');
      if (envPp) paymentBlock.promptpayTarget = envPp;
    }
    // Reconstruct line items from the persisted columns + `other` JSONB.
    // Admin's render endpoint receives a pre-built items array; the tenant
    // path has to assemble it from the row.
    const items = [
      { label: 'ค่าเช่าห้องพัก', qty: '1 เดือน', amount: Number(b.rent) || 0 },
      { label: 'ค่าน้ำ', qty: `${b.water_units || 0} หน่วย × ${b.water_rate || 0}`, amount: Number(b.water_amount) || 0 },
      { label: 'ค่าไฟฟ้า', qty: `${b.elec_units || 0} หน่วย × ${b.elec_rate || 0}`, amount: Number(b.elec_amount) || 0 },
    ];
    if (Number(b.wifi) > 0) {
      items.push({ label: 'ค่าอินเทอร์เน็ต', qty: '1 เดือน', amount: Number(b.wifi) });
    }
    const otherList = Array.isArray(b.other) ? b.other : [];
    for (const it of otherList) {
      const amt = Number(it.amount) || 0;
      if (amt > 0) items.push({ label: String(it.label || 'อื่นๆ'), qty: '', amount: amt });
    }
    if (Number(b.late_fee) > 0) {
      items.push({ label: 'ค่าปรับชำระล่าช้า', qty: '', amount: Number(b.late_fee) });
    }
    if (Number(b.vat) > 0) {
      items.push({ label: 'ภาษีมูลค่าเพิ่ม', qty: '', amount: Number(b.vat) });
    }
    const bill = {
      billNo: b.bill_no,
      roomId: b.room_id,
      tenantName: b.tenant_name || '',
      tenantPhone: b.tenant_phone || '',
      period: b.period,
      dueDate: b.due_date,
      items,
      rent: Number(b.rent) || 0,
      waterUnits: Number(b.water_units) || 0,
      waterRate: Number(b.water_rate) || 0,
      waterAmount: Number(b.water_amount) || 0,
      elecUnits: Number(b.elec_units) || 0,
      elecRate: Number(b.elec_rate) || 0,
      elecAmount: Number(b.elec_amount) || 0,
      wifi: Number(b.wifi) || 0,
      subtotal: Number(b.subtotal) || 0,
      vat: Number(b.vat) || 0,
      lateFee: Number(b.late_fee) || 0,
      total: Number(b.total) || 0,
      status: b.status,
      paidAt: b.paid_at,
      building: config.building || {},
      ...paymentBlock,
    };

    await acquirePdfSlot();
    acquired = true;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="bill-${(bill.billNo || 'invoice').replace(/[^A-Za-z0-9_-]/g, '')}.pdf"`
    );
    await renderBillPdf(bill, res);
  } catch (err) {
    console.error('tenant bill pdf error:', err);
    if (!res.headersSent) {
      const code = String(err.message || '').includes('PDF queue timeout') ? 503 : 500;
      res.status(code).json({ error: 'pdf render failed', code: code === 503 ? 'BUSY' : 'PDF_ERROR' });
    }
  } finally {
    if (acquired) releasePdfSlot();
  }
});

app.get('/api/tenant/maintenance', requireTenant, async (req, res) => {
  // Pagination support, capped at 100/page; default 50.
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  try {
    // Match by tenant_id (durable across phone changes) OR phone (covers
    // legacy tickets created before tenant_id was stamped at insert time).
    const { rows } = await pool.query(
      `SELECT id, ticket_no, room_id, category, priority, status, title, description,
              created_at, completed_at, rating, rating_comment
         FROM maintenance_tickets
         WHERE tenant_id = $1 OR (tenant_phone = $2 AND $2 <> '')
         ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [req.tenant.tenant_id, req.tenant.phone || '', limit, offset]
    );
    res.json({ ok: true, tickets: rows, limit, offset });
  } catch (err) {
    console.error('tenant tickets error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// B5 — tenant view of their own payment history. Lists every slip they
// uploaded with current verification status, optional bill ref, and reject
// reason if applicable. Pagination by limit/offset, default 50.
app.get('/api/tenant/payments', requireTenant, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  try {
    // Filter b.deleted_at IS NULL on the JOIN so payments tied to a
    // soft-deleted bill don't surface in the tenant's history with
    // dangling bill metadata.
    const { rows } = await pool.query(
      `SELECT p.id, p.bill_id, p.amount, p.method, p.slip_url,
              p.status, p.verified_at, p.rejected_reason, p.created_at,
              b.bill_no, b.period
         FROM payments p
         LEFT JOIN bills b ON b.id = p.bill_id AND b.deleted_at IS NULL
         WHERE p.tenant_id=$1
         ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`,
      [req.tenant.tenant_id, limit, offset]
    );
    res.json({ ok: true, payments: rows, limit, offset });
  } catch (err) {
    console.error('tenant payments list error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// A1 — tenant rates a completed ticket. Authenticated via tenant_session
// (no need to re-pass phone — we know who the tenant is). The ticket must
// be both for this tenant's current room AND in 'completed' status, AND
// not already rated. We also stamp `updated_at` for activity tracking.
app.post('/api/tenant/maintenance/:id/rate', sameOrigin, csrfGuard, requireTenant, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  const rating = Number(req.body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'rating must be integer 1-5' });
  }
  const comment = req.body?.comment ? String(req.body.comment).slice(0, 500) : null;
  try {
    const { rows } = await pool.query(
      `UPDATE maintenance_tickets
         SET rating=$1, rating_comment=$2, updated_at=NOW()
         WHERE id=$3
           AND (tenant_id = $4 OR (tenant_phone = $5 AND $5 <> ''))
           AND status='completed'
           AND rating IS NULL
         RETURNING ticket_no, rating, rating_comment, completed_at`,
      [rating, comment, id, req.tenant.tenant_id, req.tenant.phone || '']
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'ticket not found, not yours, not completed, or already rated' });
    }
    audit(req, 'maintenance.rate', 'ticket', String(id),
      { rating, hasComment: !!comment }, `tenant:${req.tenant.tenant_id}`);
    // Notify owner so they see the feedback in real-time
    try {
      const flags = await features.load(pool);
      notifier.notifyOwner({ pool, features: flags }, {
        subject: `⭐ ผู้เช่าให้คะแนน ${rating}/5`,
        text: `Ticket ${rows[0].ticket_no} — ${rating}/5${comment ? `\n"${comment}"` : ''}`,
      }).catch(() => {});
    } catch { /* ignore */ }
    res.json({ ok: true, ticket: rows[0] });
  } catch (err) {
    console.error('tenant ticket rate error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// === v2: Bills (persistent) ===============================================
// Replaces the on-demand bill computation. Admin generates a bill once per
// room+period; tenant + admin can later attach payments.

app.get('/api/bills', requireAuth, async (req, res) => {
  const status = req.query.status;
  const params = [];
  const where = ['deleted_at IS NULL'];
  if (status && ['pending', 'paid', 'overdue', 'void'].includes(String(status))) {
    params.push(status); where.push(`status=$${params.length}`);
  }
  if (req.query.roomId) {
    params.push(String(req.query.roomId).slice(0, 32));
    where.push(`room_id=$${params.length}`);
  }
  if (req.query.period) {
    params.push(String(req.query.period).slice(0, 16));
    where.push(`period=$${params.length}`);
  }
  // Pagination so admins working with > 500 historical bills can page
  // through them. Default 200/page; max 500 (preserves the previous cap).
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  params.push(limit, offset);
  try {
    const { rows } = await pool.query(
      `SELECT * FROM bills WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ ok: true, bills: rows, limit, offset });
  } catch (err) {
    console.error('bills list error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/bills', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  const b = req.body || {};
  const flags = await features.load(pool);
  // Admin sends either a fully-formed bill, or roomId+period and we compute it.
  let computed = b;
  // Track which one_off recurring rows we used so we can deactivate them
  // after a successful insert (so they don't appear on next month's bill).
  let usedOneOffIds = [];
  if (b.compute && b.roomId) {
    const [roomsRow, configRow] = await Promise.all([
      pool.query(`SELECT value FROM app_data WHERE key='baankarn_rooms_v1'`),
      pool.query(`SELECT value FROM app_data WHERE key='baankarn_config_v1'`),
    ]);
    const roomsObj = roomsRow.rows.length ? roomsRow.rows[0].value : {};
    const config = configRow.rows.length ? configRow.rows[0].value : {};
    const room = roomsObj[b.roomId] || (Object.values(roomsObj || {}).find((r) => r.id === b.roomId));
    if (!room) return res.status(404).json({ error: 'room not found' });
    let previous = null;
    try {
      const prev = await pool.query(
        `SELECT total, due_date, paid_at, status FROM bills
           WHERE room_id=$1 AND status IN ('pending','overdue') AND deleted_at IS NULL
           ORDER BY created_at DESC LIMIT 1`,
        [b.roomId]
      );
      previous = prev.rows[0] ? { total: Number(prev.rows[0].total), dueDate: prev.rows[0].due_date, status: prev.rows[0].status } : null;
    } catch {}
    // B1 — auto-load recurring charges if recurringCharges flag on and the
    // caller didn't explicitly pass `recurring`. Resolve the active tenant
    // first so per-tenant charges (parking, cleaning) match the right person.
    let recurringList = Array.isArray(b.recurring) ? b.recurring : [];
    if (flags.recurringCharges?.enabled && !b.recurring) {
      let tid = b.tenantId || null;
      if (!tid) {
        try {
          const tq = await pool.query(
            `SELECT id FROM tenants WHERE current_room_id=$1 AND status='active' AND deleted_at IS NULL
               ORDER BY updated_at DESC LIMIT 1`,
            [b.roomId]
          );
          if (tq.rows.length) tid = tq.rows[0].id;
        } catch { /* ignore */ }
      }
      const dbRecurring = await loadRecurringFor(pool, { tenantId: tid, roomId: b.roomId });
      // Honor `frequency` so quarterly charges only land on bills for the
      // appropriate quarter (every 3 months from start_at) — previously
      // every recurring row was added every month regardless of frequency,
      // silently overcharging tenants with quarterly fees.
      const periodForFilter = b.period || billing.formatPeriodNow();
      const applicable = dbRecurring.filter((r) => billing.isChargeApplicableForPeriod(r, periodForFilter));
      recurringList = applicable.map((r) => ({ label: r.label, amount: Number(r.amount) }));
      // Only deactivate one_off charges that actually got billed this period.
      usedOneOffIds = applicable.filter((r) => r.frequency === 'one_off').map((r) => r.id);
    }
    // Resolve the active contract's discount_pct so the contract-length
    // discount the admin configured at check-in actually shows up on the
    // bill. Best-effort: no contract → no discount (rent-as-is).
    let discountPct = 0;
    try {
      const cq = await pool.query(
        `SELECT discount_pct FROM contracts
           WHERE room_id=$1 AND status='active' AND deleted_at IS NULL
           ORDER BY start_date DESC LIMIT 1`,
        [b.roomId]
      );
      if (cq.rows[0]) discountPct = Number(cq.rows[0].discount_pct) || 0;
    } catch { /* contracts may be empty on legacy deploys */ }
    computed = billing.buildBill({
      room, config, features: flags,
      previous,
      recurring: recurringList,
      period: b.period, dueDate: b.dueDate,
      discountPct,
    });
  }
  if (!computed.billNo || !computed.total || !computed.roomId) {
    return res.status(400).json({ error: 'billNo, roomId and total required' });
  }
  // Auto-link to tenant: if caller didn't pass tenantId explicitly, look up
  // the active tenant currently in this room. This is what makes bills
  // visible in the tenant portal — without it tenant_id stays NULL.
  let tenantId = b.tenantId || null;
  if (!tenantId && computed.roomId) {
    try {
      const t = await pool.query(
        `SELECT id FROM tenants
            WHERE current_room_id=$1 AND status='active' AND deleted_at IS NULL
            ORDER BY updated_at DESC LIMIT 1`,
        [computed.roomId]
      );
      if (t.rows.length) tenantId = t.rows[0].id;
    } catch (err) {
      console.warn('[bill] tenant lookup failed:', err.message);
    }
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO bills
       (bill_no, tenant_id, room_id, period, rent,
        water_units, water_rate, water_amount,
        elec_units, elec_rate, elec_amount,
        wifi, other, subtotal, vat, late_fee, total, due_date, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,'pending')
       ON CONFLICT (bill_no) DO UPDATE SET
         tenant_id=COALESCE(EXCLUDED.tenant_id, bills.tenant_id),
         rent=EXCLUDED.rent, water_units=EXCLUDED.water_units, water_rate=EXCLUDED.water_rate,
         water_amount=EXCLUDED.water_amount, elec_units=EXCLUDED.elec_units,
         elec_rate=EXCLUDED.elec_rate, elec_amount=EXCLUDED.elec_amount,
         wifi=EXCLUDED.wifi, other=EXCLUDED.other,
         subtotal=EXCLUDED.subtotal, vat=EXCLUDED.vat, late_fee=EXCLUDED.late_fee,
         total=EXCLUDED.total, due_date=EXCLUDED.due_date
       RETURNING *`,
      [
        computed.billNo, tenantId, computed.roomId, computed.period,
        computed.rent || 0,
        computed.waterUnits || 0, computed.waterRate || 0, computed.waterAmount || 0,
        computed.elecUnits || 0, computed.elecRate || 0, computed.elecAmount || 0,
        computed.wifi || 0,
        JSON.stringify(Array.isArray(b.other) ? b.other : []),
        computed.subtotal || computed.total, computed.vat || 0, computed.lateFee || 0,
        computed.total, computed.dueDate,
      ]
    );
    audit(req, 'bill.create', 'bill', String(rows[0].id), { tenantId, autoLinked: !b.tenantId && tenantId });
    // B1 — mark consumed one_off recurring charges inactive so they don't
    // appear on next month's bill. Best-effort; failure here doesn't unwind
    // the bill insert (the charges line items are already in `other`).
    if (usedOneOffIds.length) {
      try {
        await pool.query(
          `UPDATE recurring_charges SET active=FALSE, updated_at=NOW() WHERE id = ANY($1::bigint[])`,
          [usedOneOffIds]
        );
      } catch (err) {
        console.warn('[bill] one_off deactivate failed:', err.message);
      }
    }
    res.json({ ok: true, bill: rows[0], computed });
  } catch (err) {
    // A7 — translate the partial-unique constraint into a clear 409 so
    // the admin UI can show "already generated" instead of a generic 500.
    if (err.code === '23505' && /uq_bills_room_period_active/.test(err.constraint || '')) {
      return res.status(409).json({
        error: 'มีบิลของรอบนี้อยู่แล้ว — ทำการ void ก่อนถ้าต้องการสร้างใหม่',
        code: 'BILL_DUPLICATE',
      });
    }
    console.error('bill create error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.put('/api/bills/:id/void', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  const reason = String(req.body?.reason || '').slice(0, 500);
  const force = req.body && req.body.force === true;
  try {
    // Cross-feature consistency guard: if there's already a verified payment
    // pointing at this bill, voiding silently would leave the payment row
    // orphaned (tenant uploaded slip → admin verified → admin then voids the
    // bill = "we accepted your money but the bill never existed"). Block by
    // default; let admin pass `force: true` after explicit confirmation in
    // the UI. Audit captures the override so the trail is clear.
    const verified = await pool.query(
      `SELECT id, amount FROM payments WHERE bill_id=$1 AND status='verified' LIMIT 1`,
      [id]
    );
    if (verified.rows.length && !force) {
      return res.status(409).json({
        error: 'บิลนี้มีสลิปที่ยืนยันแล้ว — โปรดยืนยันการ void ก่อนทำต่อ',
        code: 'BILL_HAS_VERIFIED_PAYMENT',
        verifiedPaymentId: verified.rows[0].id,
        verifiedAmount: Number(verified.rows[0].amount),
        hint: 'ส่ง { force: true } เพื่อยืนยันการ void ทั้งที่มีการชำระแล้ว',
      });
    }

    const { rows } = await pool.query(
      `UPDATE bills SET status='void', void_reason=$1 WHERE id=$2 AND status<>'paid' RETURNING *`,
      [reason, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found or already paid' });
    audit(req, 'bill.void', 'bill', String(id), {
      reason,
      force: !!force,
      hadVerifiedPayment: verified.rows.length > 0,
    });
    res.json({ ok: true, bill: rows[0] });
  } catch (err) {
    console.error('bill void error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// === v2: Payments + slip upload ===========================================
// Tenant uploads a slip via /api/tenant/payments (gated by slipUpload).
// Admin verifies via /api/payments/:id/verify.

async function ensureSlipUpload(req, res, next) {
  const flags = await features.load(pool);
  if (!flags.slipUpload || !flags.slipUpload.enabled) {
    return res.status(503).json({ error: 'slipUpload disabled' });
  }
  req.features = flags;
  next();
}

app.post('/api/tenant/payments', sameOrigin, csrfGuard, requireTenant, ensureSlipUpload, async (req, res) => {
  const b = req.body || {};
  const billId = Number(b.billId);
  if (!Number.isInteger(billId) || billId < 1) return res.status(400).json({ error: 'billId required' });
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'invalid amount' });
  if (!b.slip) return res.status(400).json({ error: 'slip image required' });
  try {
    const billRes = await pool.query(
      `SELECT id, total, status, tenant_id FROM bills WHERE id=$1 AND deleted_at IS NULL`,
      [billId]
    );
    if (!billRes.rows.length) return res.status(404).json({ error: 'bill not found' });
    if (billRes.rows[0].tenant_id && Number(billRes.rows[0].tenant_id) !== Number(req.tenant.tenant_id)) {
      return res.status(403).json({ error: 'not your bill' });
    }
    // Refuse uploads against orphan bills (tenant_id IS NULL — legacy bills
    // created before tenant auto-linking). Without this guard a logged-in
    // tenant can pay any unattached bill by guessing the bill_id (sequential
    // BIGSERIAL, easily enumerable). Admin must attach the tenant first.
    if (!billRes.rows[0].tenant_id) {
      return res.status(403).json({
        error: 'บิลนี้ยังไม่ได้ผูกกับผู้เช่า — กรุณาติดต่อเจ้าหน้าที่',
        code: 'BILL_NOT_LINKED',
      });
    }
    // Refuse to mark a bill paid for a different amount than what's owed.
    // Without this guard, a tenant could pay 100฿ on a 5,000฿ bill, upload
    // the matching slip, and the auto-verify path would happily accept (slip
    // amount matches `expected.amount` since that came from the same client
    // input) — bill flips to 'paid' for a fraction of what's due. We tolerate
    // ±1฿ to match the slipVerifier's own bank-rounding tolerance, but reject
    // anything beyond that here BEFORE saving the slip / hitting the provider.
    const billTotal = Number(billRes.rows[0].total) || 0;
    if (Math.abs(amount - billTotal) > 1.0) {
      return res.status(400).json({
        error: `จำนวนเงินไม่ตรงกับยอดบิล — บิลนี้ ฿${billTotal.toLocaleString('th-TH', { minimumFractionDigits: 2 })} แต่ผู้เช่าระบุ ฿${amount.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`,
        code: 'AMOUNT_NOT_BILL_TOTAL',
        billTotal,
        submittedAmount: amount,
      });
    }
    // Don't allow re-paying a bill that's already paid or void. Without this
    // a tenant could re-upload after admin has already verified, creating a
    // second 'verified' payment row pointing at the same bill (orphaned
    // accounting). 'pending' and 'overdue' are the only states a slip is
    // legitimately for.
    const billStatus = billRes.rows[0].status;
    if (billStatus !== 'pending' && billStatus !== 'overdue') {
      return res.status(409).json({
        error: billStatus === 'paid'
          ? 'บิลนี้ชำระเรียบร้อยแล้ว ไม่ต้องส่งสลิปอีก'
          : `บิลนี้สถานะ "${billStatus}" — ไม่สามารถส่งสลิปได้`,
        code: 'BILL_NOT_PAYABLE',
        status: billStatus,
      });
    }
    // Hash the actual slip bytes BEFORE saving so dedup works (prior version
    // hashed the URL+size which were always unique → unique index never
    // triggered).
    const rawBuf = Buffer.from(String(b.slip || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
    const slipHash = cryptoSvc.hmac(rawBuf);
    const dup = await pool.query('SELECT id FROM payments WHERE slip_hash=$1 LIMIT 1', [slipHash]);
    if (dup.rows.length) {
      return res.status(409).json({
        error: 'สลิปนี้ถูกใช้ไปแล้ว — ไม่สามารถส่งซ้ำ',
        code: 'DUPLICATE_SLIP_HASH',
      });
    }

    const slip = await storage.saveBase64({
      pool,
      category: 'slip',
      dataUrl: b.slip,
      refId: String(billId),
      uploadedBy: `tenant:${req.tenant.tenant_id}`,
      maxBytes: req.features.slipUpload.maxBytes || 1_500_000,
      allowedMimes: req.features.slipUpload.allowedMimes || ['image/jpeg', 'image/png', 'image/webp'],
    });

    // === Auto-verify the slip via configured provider (SlipOK/EasySlip) ==
    // When slipUpload.autoVerify is on AND a provider key is configured,
    // we send the slip to the provider for instant validation BEFORE
    // touching the DB. The provider returns the bank's transaction
    // reference + actual amount + receiver account. We cross-check:
    //   1) amount ±1฿ vs bill.total
    //   2) receiver account tail vs PROMPTPAY_TARGET (so a slip paid to
    //      someone else's account is rejected)
    //   3) transaction_ref unique in DB (catches replay even when image
    //      bytes differ — re-screenshot, crop, recompress)
    // All three must pass for auto-verify; one mismatch → status='rejected'
    // with a tenant-facing reason.
    const slipVerifier = require('./services/slipVerifier');
    let verifyResult = null;
    let autoVerifyAttempted = false;
    if (slipVerifier.isConfigured(req.features)) {
      autoVerifyAttempted = true;
      const ppTarget = require('./services/secrets').get('PROMPTPAY_TARGET');
      try {
        // Use the fallback chain — tries every configured provider until
        // one succeeds OR one issues a hard rejection (AMOUNT_MISMATCH,
        // RECEIVER_MISMATCH, SLIPOK_REJECT, etc.). If all providers
        // transient-fail (network timeout, parser glitch, 5xx), the result
        // bubbles back with the last error and the upload endpoint
        // demotes it to admin queue via TRANSIENT_CODES handling below.
        // expected.amount comes from bills.total (authoritative ledger value)
        // not from the tenant-submitted `amount` — that input was already
        // bounded by the AMOUNT_NOT_BILL_TOTAL pre-check above, but using
        // billTotal here closes the remaining ±1฿ drift between the two
        // tolerances and means slipVerifier's amount-mismatch reasoning is
        // pinned to the same number the bill is invoiced at.
        verifyResult = await slipVerifier.verifyWithFallback(
          rawBuf,
          { amount: billTotal, billId, promptpayTarget: ppTarget },
          req.features
        );
      } catch (err) {
        // Catch-all in case the fallback wrapper itself threw — shouldn't
        // happen (each provider's catch is internal) but defensive.
        verifyResult = { ok: false, error: err.message, code: 'VERIFIER_THREW', attempts: [] };
      }
    }

    // Decide the payment row's initial status. The matrix is:
    //
    //   autoVerify | verify result        | requireVerification | → status
    //   ---------- + -------------------- + ------------------- + --------
    //   OFF        | (n/a — not called)   | true                | pending
    //   OFF        | (n/a — not called)   | false               | verified  ← legacy
    //   ON         | ok                   | true                | pending   ← paranoid mode (advisory)
    //   ON         | ok                   | false               | verified  ← happy path
    //   ON         | rejected (clear)     | any                 | rejected  ← bad slip
    //   ON         | rejected (transient) | any                 | pending   ← fall back to admin
    //
    // CRITICAL: a transient error (network timeout, provider 5xx, parser
    // glitch) MUST NOT auto-reject. If we set 'rejected' on a flaky
    // provider blip, the tenant sees a false "fake slip" message and
    // their slip_hash + transaction_ref are now in the unique indexes,
    // so even uploading the same legit slip again returns 409. The slip
    // is effectively LOST. Map provider/transport-level errors to
    // 'pending' so the admin queue catches them.
    // Source of truth lives in services/slipVerifier.js — re-importing
    // here keeps the two paths' classification identical when new codes
    // (e.g. provider-specific timeout codes) are added.
    const TRANSIENT_CODES = slipVerifier.TRANSIENT_CODES
      || new Set(['VERIFIER_THREW', 'PROVIDER_ERROR',
                  'SLIPOK_PARSE', 'EASYSLIP_PARSE',
                  'NOT_CONFIGURED', 'UNKNOWN_PROVIDER']);
    let initialStatus, initialReason = null;
    if (autoVerifyAttempted) {
      if (verifyResult && verifyResult.ok) {
        initialStatus = req.features.slipUpload.requireVerification
          ? 'pending'   // paranoid mode: auto-verify is advisory; admin still confirms
          : 'verified';
      } else if (verifyResult && TRANSIENT_CODES.has(verifyResult.code)) {
        // Provider couldn't talk → fall back to pending so admin handles
        // it manually rather than stranding the tenant with a false reject.
        initialStatus = 'pending';
        initialReason = `auto-verify ตกชั่วคราว (${verifyResult.code}) — รอเจ้าหน้าที่ตรวจสอบ`;
      } else {
        // Verifier confirmed the slip is bad: amount mismatch, receiver
        // mismatch, provider explicitly rejected (fake / expired / replay
        // detected on their side), or unknown rejection code → tenant
        // gets a clear "rejected" with reason.
        initialStatus = 'rejected';
        initialReason = (verifyResult && verifyResult.error) || 'การตรวจสอบไม่ผ่าน';
      }
    } else {
      // Safe fallback: if no provider actually verified the slip, keep it in
      // the admin queue. Turning off requireVerification alone must not mark a
      // tenant-uploaded image as paid. Legacy trust mode needs an explicit
      // opt-in flag.
      const allowUnverifiedAutoApprove =
        req.features.slipUpload.allowUnverifiedAutoApprove === true
        && req.features.slipUpload.requireVerification === false
        && req.features.slipUpload.autoVerify !== true;
      initialStatus = allowUnverifiedAutoApprove ? 'verified' : 'pending';
    }

    // Atomic: payment INSERT + (optional) bill mark-paid run in one tx so
    // we never end up with a verified payment row pointing at a bill still
    // marked 'pending', or vice-versa, if either statement crashes mid-way.
    //
    // Concurrency guards inside the tx (NOT covered by the outside SELECT
    // at the top of the handler):
    //   1) SELECT bills FOR UPDATE — serializes concurrent uploads on the
    //      same bill so two slips arriving in the same second can't both
    //      flip the bill to 'paid' with two verified payments (double-credit).
    //   2) Re-check bill.status hasn't moved to 'paid'/'void' since the
    //      outside read (admin could have voided during the slipVerifier
    //      RPC, which takes 5–10s).
    //   3) Refuse if a verified payment ALREADY exists for this bill —
    //      defensive against same-bill double-uploads and admin-side races.
    //
    // `committed` tracks whether the DB transaction made the payment durable.
    // If anything fails after saveBase64 but before COMMIT, rollback removes
    // the payment row and the uploaded file must be scrubbed too.
    let row;
    let committed = false;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // (1) + (2) + (3): lock the bill, re-check status, and verify no other
      // verified payment beat us to the COMMIT. SELECT FOR UPDATE blocks
      // any other concurrent slip-upload on this bill until we commit/rollback.
      // Also re-fetch tenant_id under the lock so an admin-side reassignment
      // happening during the 5-10s verifier RPC can't slip a payment into the
      // wrong tenant's ledger (bill might have been re-pointed at tenant B
      // while tenant A's upload was in flight).
      const lock = await client.query(
        `SELECT id, status, total, tenant_id FROM bills WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [billId]
      );
      if (!lock.rows.length) {
        await client.query('ROLLBACK');
        if (slip && slip.id) {
          require('./services/storage').remove(pool, slip.id).catch(() => {});
        }
        return res.status(404).json({
          error: 'ไม่พบบิล (อาจถูกลบระหว่างการส่งสลิป)',
          code: 'BILL_NOT_FOUND_AT_COMMIT',
        });
      }
      // Re-validate ownership under the lock — protects against the
      // bill.tenant_id changing between the outer SELECT (line 2592) and
      // here, which would otherwise let a slip be attributed to a bill
      // that's been reassigned to a different tenant.
      if (lock.rows[0].tenant_id
          && Number(lock.rows[0].tenant_id) !== Number(req.tenant.tenant_id)) {
        await client.query('ROLLBACK');
        if (slip && slip.id) {
          require('./services/storage').remove(pool, slip.id).catch(() => {});
        }
        return res.status(403).json({
          error: 'บิลนี้ถูกย้ายไปยังผู้เช่ารายอื่นระหว่างการส่งสลิป',
          code: 'BILL_REASSIGNED',
        });
      }
      const lockedStatus = lock.rows[0].status;
      if (lockedStatus !== 'pending' && lockedStatus !== 'overdue') {
        await client.query('ROLLBACK');
        if (slip && slip.id) {
          require('./services/storage').remove(pool, slip.id).catch(() => {});
        }
        return res.status(409).json({
          error: lockedStatus === 'paid'
            ? 'บิลนี้ชำระเรียบร้อยแล้วระหว่างที่กำลังตรวจสลิป — ไม่ต้องส่งซ้ำ'
            : `บิลสถานะ "${lockedStatus}" — ไม่สามารถส่งสลิปได้`,
          code: 'BILL_NOT_PAYABLE_AT_COMMIT',
          status: lockedStatus,
        });
      }
      const existingVerified = await client.query(
        `SELECT id FROM payments WHERE bill_id=$1 AND status='verified' LIMIT 1`,
        [billId]
      );
      if (existingVerified.rows.length) {
        await client.query('ROLLBACK');
        if (slip && slip.id) {
          require('./services/storage').remove(pool, slip.id).catch(() => {});
        }
        return res.status(409).json({
          error: 'บิลนี้มีการชำระที่ยืนยันแล้ว ไม่สามารถส่งสลิปซ้ำ',
          code: 'BILL_ALREADY_PAID',
          existingPaymentId: existingVerified.rows[0].id,
        });
      }

      try {
        // INSERT now carries transaction_ref + verify_provider + raw payload
        // when auto-verify ran. The unique index on transaction_ref catches
        // a replay attempt (same bank tx, different image bytes) — comes
        // back as 23505 and we surface a clear 409 below.
        const ins = await client.query(
          `INSERT INTO payments (bill_id, tenant_id, amount, method, slip_url, slip_hash,
                                 status, rejected_reason, transaction_ref, verify_provider, verify_payload, verified_by, verified_at)
           VALUES ($1,$2,$3,'promptpay',$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
           RETURNING *`,
          [
            billId, req.tenant.tenant_id, amount, slip.url, slipHash,
            initialStatus, initialReason,
            verifyResult?.transRef || null,
            verifyResult?.provider || null,
            verifyResult ? JSON.stringify({
              ok: verifyResult.ok,
              code: verifyResult.code,
              amount: verifyResult.amount,
              sender: verifyResult.sender,
              receiver: verifyResult.receiver,
              transDate: verifyResult.transDate,
              error: verifyResult.error,
              // Per-provider attempt trail (multi-provider fallback chain).
              // Lets admin see "SlipOK was down so EasySlip handled this"
              // or "Both providers rejected — fake slip suspected" in
              // /admin#payments forensics.
              attempts: verifyResult.attempts || [],
            }) : null,
            // For auto-verified rows we credit the provider as verifier so
            // admin can audit which slips were auto-approved vs hand-checked.
            (initialStatus === 'verified' && verifyResult?.ok)
              ? `auto:${verifyResult.provider}` : null,
            (initialStatus === 'verified' && verifyResult?.ok) ? new Date() : null,
          ]
        );
        row = ins.rows[0];
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err.code === '23505') {
          // Race condition cleanup: the early `SELECT id FROM payments WHERE
          // slip_hash=$1` check above is non-locking, so two near-simultaneous
          // uploads of the same slip can both pass the dup gate and both hit
          // saveBase64. The second one then hits the unique constraint here.
          // The first call's file is already on disk — the second's storage
          // row is now an orphan (not referenced by any payment). Best-effort
          // cleanup so we don't leak files on every dup attempt.
          if (slip && slip.id) {
            require('./services/storage').remove(pool, slip.id).catch((e) => {
              console.warn('[slip-upload] orphan file cleanup failed for id=' + slip.id + ':', e.message);
            });
          }
          // Differentiate the two unique-violation paths so the tenant gets
          // an actionable message rather than a generic "duplicate".
          if (/uq_payments_tx_ref/.test(err.constraint || '')) {
            return res.status(409).json({
              error: 'สลิปนี้ถูกใช้ไปแล้ว — transaction reference ซ้ำกับสลิปก่อนหน้า',
              code: 'DUPLICATE_TRANSACTION',
            });
          }
          return res.status(409).json({
            error: 'สลิปนี้ถูกใช้ไปแล้ว — ไม่สามารถส่งซ้ำ',
            code: 'DUPLICATE_SLIP_HASH',
          });
        }
        throw err;
      }
      if (initialStatus === 'verified') {
        const paid = await client.query(
          `UPDATE bills SET status='paid', paid_at=NOW()
             WHERE id=$1 AND status IN ('pending','overdue')
             RETURNING id`,
          [billId]
        );
        if (paid.rowCount !== 1) {
          throw Object.assign(new Error('bill mark-paid update did not affect exactly one row'), {
            code: 'BILL_MARK_PAID_FAILED',
          });
        }
      }
      await client.query('COMMIT');
      committed = true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // Catch-all orphan-file cleanup. The 23505 path already cleans up
      // before returning, but a transient DB error (connection reset,
      // serialization failure, anything raised after saveBase64 succeeded
      // but before the INSERT committed) used to leave the file on disk
      // forever. Belt-and-braces: if the row never got inserted, the file
      // has nothing pointing to it and must go.
      if (!committed && slip && slip.id) {
        require('./services/storage').remove(pool, slip.id).catch((e) => {
          console.warn('[slip-upload] orphan file cleanup (outer) failed for id=' + slip.id + ':', e.message);
        });
      }
      throw err;
    } finally {
      client.release();
    }
    audit(req, 'tenant.slip_upload', 'payment', String(row.id),
      {
        billId, amount,
        initialStatus,
        autoVerifyAttempted,
        autoVerifyOk: !!(verifyResult && verifyResult.ok),
        autoVerifyCode: verifyResult?.code,
        transRef: verifyResult?.transRef,
      },
      `tenant:${req.tenant.tenant_id}`).catch(() => {});

    // Owner receives "new slip" alert so they know to go review. Subject is
    // adjusted by initialStatus so a queue full of self-resolving auto-verified
    // slips doesn't overwhelm the owner's notification — only 'pending' and
    // 'rejected' ones genuinely need their attention.
    {
      const statusEmoji = initialStatus === 'verified' ? '✅'
        : initialStatus === 'rejected' ? '⚠️'
        : '📥';
      const statusTh = initialStatus === 'verified' ? 'ผ่านอัตโนมัติ'
        : initialStatus === 'rejected' ? 'ปฏิเสธอัตโนมัติ'
        : 'รอตรวจสอบ';
      const reasonLine = initialReason ? `\nเหตุผล: ${initialReason}` : '';
      const refLine = verifyResult?.transRef ? `\ntransRef: ${verifyResult.transRef}` : '';
      notifier.notifyOwner(
        { pool, features: req.features },
        { subject: `${statusEmoji} สลิปใหม่ (${statusTh}) — บิล #${billId}`,
          text: `บิล #${billId} จำนวน ฿${amount.toLocaleString('th-TH', { minimumFractionDigits: 2 })} `
                + `จาก ${req.tenant.full_name} (${req.tenant.phone})\n`
                + `สถานะเริ่มต้น: ${statusTh}${reasonLine}${refLine}` }
      ).catch(() => {});
    }

    // Tenant receives an immediate acknowledgment so they don't wonder
    // whether their slip went through. Two flavours: auto-verified (no
    // admin step needed) → "thanks, paid" final receipt; pending review
    // → "got it, we'll check" with expected timeline. Without this the
    // tenant uploaded a slip and got nothing back until admin manually
    // approved hours later — fueling "ส่งไปแล้วทำไมเงียบ" support tickets.
    try {
      // Pull the bill period so the tenant's confirmation message can
      // reference the rounded "เดือน X" instead of just bill_id (less
      // friendly).
      const billQ = await pool.query(
        `SELECT bill_no, period FROM bills WHERE id=$1 LIMIT 1`,
        [billId]
      );
      const billNo = billQ.rows[0]?.bill_no || `#${billId}`;
      const period = billQ.rows[0]?.period || '';
      const amtStr = amount.toLocaleString('th-TH', { minimumFractionDigits: 2 });
      const buildingName = await loadBuildingName(pool);

      // Pick the tenant message based on the actual decision the row
      // landed on. Three outcomes possible now: verified (auto), rejected
      // (auto), or pending (manual queue).
      let tenantNotice;
      if (initialStatus === 'verified') {
        tenantNotice = {
          subject: '✅ ชำระเงินเรียบร้อยแล้ว — ขอบคุณ',
          text: [
            `เรียน คุณ${req.tenant.full_name}`,
            ``,
            `🎉 ขอบคุณที่ชำระเงินตรงเวลา`,
            ``,
            `บิล: ${billNo}${period ? ` (รอบ ${period})` : ''}`,
            `จำนวน: ฿${amtStr}`,
            `สถานะ: ชำระแล้ว ✓`,
            verifyResult?.ok
              ? `ตรวจสอบโดย: ระบบอัตโนมัติ (${verifyResult.provider})${verifyResult.transRef ? ` · ref ${verifyResult.transRef}` : ''}`
              : null,
            ``,
            `ใบเสร็จ: ดูได้ที่พอร์ทัลผู้เช่า /tenant`,
            ``,
            `${buildingName}`,
          ].filter(Boolean).join('\n'),
        };
      } else if (initialStatus === 'rejected') {
        // Auto-verifier rejected the slip — give the tenant the SPECIFIC
        // reason from the verifier so they know what to fix. Common cases:
        //   AMOUNT_MISMATCH   → "ยอดไม่ตรง — สลิป ฿X แต่บิล ฿Y"
        //   RECEIVER_MISMATCH → "บัญชีปลายทางไม่ใช่ของหอพัก"
        //   DUPLICATE_*       → "สลิปนี้ถูกใช้ไปแล้ว"
        //   SLIPOK_REJECT     → "QR ไม่สามารถอ่าน / สลิปหมดอายุ / ฯลฯ"
        tenantNotice = {
          subject: '❌ สลิปไม่ผ่านการตรวจสอบอัตโนมัติ',
          text: [
            `เรียน คุณ${req.tenant.full_name}`,
            ``,
            `ระบบตรวจพบความไม่ถูกต้องในสลิปของคุณ — บิลยังไม่ถูกทำเครื่องหมายว่าชำระแล้ว`,
            ``,
            `บิล: ${billNo}${period ? ` (รอบ ${period})` : ''}`,
            `จำนวนที่คาดหวัง: ฿${amtStr}`,
            `สถานะ: ยังไม่ชำระ`,
            ``,
            `เหตุผล: ${initialReason}`,
            ``,
            `📋 ขั้นตอนถัดไป:`,
            `   1) ตรวจว่าโอนถูกบัญชีและถูกยอดหรือไม่`,
            `   2) อัปโหลดสลิปใหม่ที่ /tenant (สลิปเดิมใช้ไม่ได้แล้ว)`,
            `   3) ถ้ายอดถูกต้องแต่ระบบยังปฏิเสธ — ติดต่อ ${buildingName}`,
          ].join('\n'),
        };
      } else {
        // Pending — three sub-cases depending on why we landed here:
        //   1. autoVerify off, manual queue (legacy)
        //   2. autoVerify on + verifier ok + paranoid mode (admin still confirms)
        //   3. autoVerify on + verifier transient error (network/parsing)
        // Tell the tenant the truth so they don't get a false "verified"
        // signal in case 3.
        let extra = '';
        if (verifyResult?.ok) {
          extra = `\n✅ ระบบยืนยันว่าสลิปถูกต้องแล้ว — รออนุมัติจากเจ้าหน้าที่`;
        } else if (autoVerifyAttempted) {
          // Transient error path — be honest that the auto-check didn't
          // get a clean answer. Don't surface "fake slip" wording.
          extra = `\nℹ️ ระบบตรวจอัตโนมัติไม่สามารถยืนยันได้ในขณะนี้ — เจ้าหน้าที่จะตรวจให้`;
        }
        tenantNotice = {
          subject: '📥 ได้รับสลิปแล้ว — กำลังตรวจสอบ',
          text: [
            `เรียน คุณ${req.tenant.full_name}`,
            ``,
            `เราได้รับสลิปการชำระเงินของคุณเรียบร้อยแล้ว`,
            `บิล: ${billNo}${period ? ` (รอบ ${period})` : ''}`,
            `จำนวน: ฿${amtStr}`,
            ``,
            `🔍 เจ้าหน้าที่กำลังตรวจสอบ — ปกติใช้เวลาภายใน 24 ชั่วโมง${extra}`,
            `📩 จะแจ้งผลการตรวจสอบกลับ (ผ่าน LINE/อีเมลนี้) เมื่อยืนยันแล้ว`,
            ``,
            `หากมีข้อสงสัย ติดต่อ ${buildingName}`,
          ].join('\n'),
        };
      }

      const flags = req.features || (await features.load(pool));
      // Use the tenant data from the request session — req.tenant carries
      // line_user_id + line_oa_id from tenantSessionLookup, so the notifier
      // routes through the right OA without a second DB roundtrip.
      notifier.notifyTenant({ pool, features: flags },
        {
          id: req.tenant.tenant_id,
          full_name: req.tenant.full_name,
          phone: req.tenant.phone,
          email: req.tenant.email,
          line_user_id: req.tenant.line_user_id,
          line_oa_id: req.tenant.line_oa_id,
          status: req.tenant.status,
        },
        tenantNotice
      ).catch(() => {});
    } catch (err) {
      console.warn('[slip-upload] tenant ack failed:', err.message);
    }

    res.json({ ok: true, payment: row });
  } catch (err) {
    console.error('tenant payment error:', err);
    // The previous version forwarded `err.message` straight to the tenant —
    // safe for our own throw-strings ("file too large", "mime not allowed")
    // but a leak vector for native pg / fs errors that include connection
    // strings, file paths, or stack traces. Allow-list the messages we
    // actually generated; everything else collapses to a generic 500.
    const knownUserFacing = [
      'expected string',
      'unrecognized file type',
      'mime mismatch',
      'mime not allowed',
      'unknown mime',
      'file too large',
    ];
    const msg = String(err.message || '');
    const isUserFacing = knownUserFacing.some((s) => msg.startsWith(s));
    if (isUserFacing) {
      return res.status(400).json({ error: msg, code: 'INVALID_SLIP' });
    }
    return res.status(500).json({
      error: 'อัปโหลดสลิปล้มเหลว — ลองใหม่อีกครั้ง',
      code: 'UPLOAD_FAILED',
    });
  }
});

// Small cached helper — building name shows up in every tenant-facing
// notification so they know who's writing. Lookup the building config
// once per call (rooms + config blob); for high-volume notification
// flows this could be cached but the in-process notifier queue is
// already deduplicating retries.
async function loadBuildingName(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
    );
    const cfg = rows.length ? rows[0].value : {};
    return (cfg && cfg.building && cfg.building.name)
      || 'บ้านกาญจน์ เรสซิเดนซ์';
  } catch { return 'บ้านกาญจน์ เรสซิเดนซ์'; }
}

app.get('/api/payments', requireAuth, requireRole('owner', 'manager', 'staff'), async (req, res) => {
  const status = req.query.status;
  const params = [];
  const where = [];
  if (status && ['pending', 'verified', 'rejected'].includes(String(status))) {
    params.push(status); where.push(`p.status=$${params.length}`);
  }
  // Pagination — slip queue can grow large in busy buildings, admin
  // shouldn't be capped at the first 500 forever.
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  params.push(limit, offset);
  try {
    // Explicit column list (no `SELECT p.*`) so a legacy `slip_url` containing
    // a multi-MB base64 data URL — possible in pre-storage-service rows —
    // can't blow up the response size and OOM the renderer when the list is
    // long. The slip image is fetched lazily by GET /api/payments/:id when
    // admin opens a row in the modal.
    const { rows } = await pool.query(
      `SELECT p.id, p.bill_id, p.tenant_id, p.amount, p.method, p.ref,
              p.status, p.verified_by, p.verified_at, p.rejected_reason,
              p.created_at,
              CASE WHEN p.slip_url IS NOT NULL THEN true ELSE false END AS has_slip,
              b.bill_no, b.period,
              t.full_name AS tenant_name, t.phone AS tenant_phone
         FROM payments p
         LEFT JOIN bills b ON b.id = p.bill_id
         LEFT JOIN tenants t ON t.id = p.tenant_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY p.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ ok: true, payments: rows, limit, offset });
  } catch (err) {
    console.error('payments list error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/payments/:id — full row including slip_url, used by the admin
// modal when opening a payment from the queue. Split from the list endpoint
// so the list response stays small (see comment on the list query above).
app.get('/api/payments/:id', requireAuth, requireRole('owner', 'manager', 'staff'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  try {
    const { rows } = await pool.query(
      `SELECT p.*, b.bill_no, b.period,
              t.full_name AS tenant_name, t.phone AS tenant_phone
         FROM payments p
         LEFT JOIN bills b ON b.id = p.bill_id
         LEFT JOIN tenants t ON t.id = p.tenant_id
        WHERE p.id=$1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const row = rows[0];
    // Belt-and-braces: if slip_url is a base64 data URL (legacy data) or
    // absurdly large, drop it from the response so a single oversized row
    // can't OOM the admin's tab. The cleanup script should fix this in DB.
    if (typeof row.slip_url === 'string'
        && (row.slip_url.startsWith('data:') || row.slip_url.length > 2048)) {
      console.warn(`[payments] dropping oversized/data: slip_url for payment id=${id} (${row.slip_url.length} bytes)`);
      row.slip_url = null;
      row._slip_dropped = true;
    }
    res.json({ ok: true, payment: row });
  } catch (err) {
    console.error('payment detail error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// CANONICAL slip verify endpoint — takes a payment id. Use this from the
// admin payments page. routes/bills-extras.js exposes a sibling
// POST /api/bills/:id/verify-slip that takes a bill id (looks up the latest
// pending payment for that bill, then delegates to the same SQL). Both
// paths converge on `bills.status='paid' + payments.status='verified'`.
// Also notifies the tenant on outcome so they see the verdict in their
// portal / LINE without polling.
app.put('/api/payments/:id/verify', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  const accept = req.body?.accept !== false;
  const reason = String(req.body?.reason || '').trim().slice(0, 500);
  if (!accept && reason.length < 3) {
    return res.status(400).json({
      error: 'reject reason is required',
      code: 'REJECT_REASON_REQUIRED',
    });
  }
  // Both branches of this endpoint mutate two tables (payments + bills) so
  // they MUST run in one transaction — the previous version issued the
  // payment UPDATE first, then the bill UPDATE as a separate query. If the
  // second query failed (DB hiccup, connection reset, deploy mid-request),
  // the payment was 'verified' but the bill stayed 'pending' / 'overdue' —
  // a verified payment for an unpaid bill, hard to spot until tenant
  // disputed the next month. The transaction below makes the two-statement
  // commit atomic.
  const client = await pool.connect();
  let row;
  try {
    await client.query('BEGIN');
    if (accept) {
      const pres = await client.query(
        `SELECT * FROM payments WHERE id=$1 AND status='pending' FOR UPDATE`,
        [id]
      );
      if (!pres.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'not found or already decided' });
      }
      row = pres.rows[0];
      if (!row.bill_id) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'payment is not linked to a bill',
          code: 'PAYMENT_WITHOUT_BILL',
        });
      }
      const bill = await client.query(
        `SELECT id, status, deleted_at FROM bills WHERE id=$1 FOR UPDATE`,
        [row.bill_id]
      );
      if (!bill.rows.length || bill.rows[0].deleted_at) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'bill is missing or deleted',
          code: 'BILL_NOT_PAYABLE',
        });
      }
      if (bill.rows[0].status !== 'pending' && bill.rows[0].status !== 'overdue') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'bill is not payable',
          code: 'BILL_NOT_PAYABLE',
          billStatus: bill.rows[0].status,
        });
      }
      const upd = await client.query(
        `UPDATE payments SET status='verified', verified_by=$1, verified_at=NOW()
           WHERE id=$2 AND status='pending' RETURNING *`,
        [req.session.user.username, id]
      );
      if (!upd.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'not found or already decided' });
      }
      row = upd.rows[0];
      const paid = await client.query(
        `UPDATE bills SET status='paid', paid_at=NOW()
           WHERE id=$1 AND status IN ('pending','overdue')
           RETURNING id`,
        [row.bill_id]
      );
      if (paid.rowCount !== 1) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'bill was not marked paid',
          code: 'BILL_MARK_PAID_FAILED',
        });
      }
      await client.query('COMMIT');
      audit(req, 'payment.verify', 'payment', String(id), { billId: row.bill_id, amount: row.amount });
      notifyTenantOnPayment(row, 'verified').catch(() => {});
      return res.json({ ok: true, payment: row });
    }
    // accept === false — reject path. No bill UPDATE needed because a
    // rejection doesn't move the bill out of pending/overdue.
    const upd = await client.query(
      `UPDATE payments SET status='rejected', verified_by=$1, verified_at=NOW(), rejected_reason=$2
         WHERE id=$3 AND status='pending' RETURNING *`,
      [req.session.user.username, reason, id]
    );
    if (!upd.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not found' });
    }
    row = upd.rows[0];
    await client.query('COMMIT');
    audit(req, 'payment.reject', 'payment', String(id), { reason, billId: row.bill_id });
    notifyTenantOnPayment(row, 'rejected', reason).catch(() => {});
    return res.json({ ok: true, payment: row });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('payment verify error:', err);
    return res.status(500).json({ error: 'internal error' });
  } finally {
    client.release();
  }
});

// Helper for both verify endpoints — pushes a notification to the tenant
// when their slip is verified or rejected. Fire-and-forget; logs to
// notifications_log via notifier.
//
// Message is intentionally formal + actionable. For verify=accept the
// tenant gets a friendly receipt with bill no, period, and amount; for
// reject they get the rejection reason + clear next-step instructions
// (re-upload slip / contact admin) so the failure isn't a dead end.
async function notifyTenantOnPayment(payment, outcome, reason) {
  if (!payment || !payment.tenant_id) return;
  try {
    const flags = await features.load(pool);
    const [{ rows: tRows }, { rows: bRows }] = await Promise.all([
      pool.query(
        `SELECT id, full_name, phone, email, line_user_id, line_oa_id
           FROM tenants
           WHERE id=$1 AND deleted_at IS NULL`,
        [payment.tenant_id]
      ),
      payment.bill_id ? pool.query(
        `SELECT bill_no, period, total, due_date FROM bills WHERE id=$1 LIMIT 1`,
        [payment.bill_id]
      ) : Promise.resolve({ rows: [] }),
    ]);
    if (!tRows.length) return;
    const t = tRows[0];
    const b = bRows[0] || {};
    const billLabel = b.bill_no || (payment.bill_id ? `#${payment.bill_id}` : '-');
    const period = b.period || '';
    const amt = Number(payment.amount);
    const amtStr = Number.isFinite(amt) ? amt.toLocaleString('th-TH', { minimumFractionDigits: 2 }) : '-';
    const buildingName = await loadBuildingName(pool);

    let subject, lines;
    if (outcome === 'verified') {
      subject = '✅ ชำระเงินเรียบร้อยแล้ว — ขอบคุณ';
      lines = [
        `เรียน คุณ${t.full_name}`,
        ``,
        `🎉 ขอบคุณที่ชำระเงินตรงเวลา`,
        ``,
        `บิล: ${billLabel}${period ? ` (รอบ ${period})` : ''}`,
        `จำนวน: ฿${amtStr}`,
        `สถานะ: ชำระแล้ว ✓`,
        ``,
        `ใบเสร็จ: ดูได้ที่พอร์ทัลผู้เช่า /tenant`,
        ``,
        `${buildingName}`,
      ];
    } else {
      // Rejected — surface the reason + concrete next steps so the tenant
      // knows what to do. "ติดต่อเจ้าหน้าที่" alone leaves them stuck.
      subject = '❌ สลิปไม่ผ่านการตรวจสอบ — กรุณาส่งใหม่';
      lines = [
        `เรียน คุณ${t.full_name}`,
        ``,
        `เสียใจที่ต้องแจ้งให้ทราบ — สลิปที่ส่งสำหรับบิลด้านล่างไม่ผ่านการตรวจสอบ`,
        ``,
        `บิล: ${billLabel}${period ? ` (รอบ ${period})` : ''}`,
        `จำนวน: ฿${amtStr}`,
        `สถานะ: ยังไม่ชำระ`,
        reason ? `\nเหตุผลที่ปฏิเสธ:\n${reason}` : null,
        ``,
        `📋 ขั้นตอนถัดไป:`,
        `   1) ตรวจสอบสลิปและจำนวนเงินอีกครั้ง`,
        `   2) อัปโหลดสลิปใหม่ที่พอร์ทัลผู้เช่า /tenant`,
        `   3) หากไม่แน่ใจ ติดต่อ ${buildingName}`,
      ].filter(Boolean);
    }
    await notifier.notifyTenant({ pool, features: flags }, t, {
      subject, text: lines.join('\n'),
    });
  } catch (err) {
    console.error('[notifyTenantOnPayment]', err.message);
  }
}

// === v2: Booking state machine (B6) =======================================
// Bookings are stored in app_data['baankarn_bookings_v1'] (legacy JSONB).
// Admin advances state via PUT /api/bookings/:id (status / notes / roomId).
// Valid transitions: pending → reviewing → approved | rejected | cancelled.
// Each transition fires a notify (owner sees the change; tenant via SMS/LINE
// if we have a phone — currently only LINE since SMS is provider-dependent).

// GET /api/bookings/:id — single booking with the citizen ID photo URL
// resolved (when the public booking form attached one). Surfaces enough
// detail for admin to verify ID at approve-time without bouncing between
// the JSONB blob view and file_uploads.
app.get('/api/bookings/:id', requireAuth, async (req, res) => {
  const id = String(req.params.id).slice(0, 64);
  try {
    // Lookup in the relational table first (post-migration deploys).
    let row = null;
    try {
      const r = await pool.query(
        `SELECT b.*, fu.url AS citizen_id_image_front_url, fu.uploaded_at AS citizen_id_image_uploaded_at
           FROM bookings b
           LEFT JOIN file_uploads fu ON fu.id = b.citizen_id_image_front_id
          WHERE b.external_id=$1 LIMIT 1`,
        [id]
      );
      if (r.rows.length) row = r.rows[0];
    } catch (err) {
      if (err.code !== '42703') throw err;  // pre-migration deploy
    }
    // Fallback to the JSONB blob if the relational row is missing
    // (legacy booking).
    let blobBooking = null;
    try {
      const blob = await pool.query(
        `SELECT value FROM app_data WHERE key='baankarn_bookings_v1' LIMIT 1`
      );
      if (blob.rows.length && Array.isArray(blob.rows[0].value)) {
        blobBooking = blob.rows[0].value.find((b) => b && b.id === id) || null;
      }
    } catch { /* ignore */ }
    if (!row && !blobBooking) {
      return res.status(404).json({ error: 'booking not found' });
    }
    res.json({
      ok: true,
      booking: row || blobBooking,
      blob: blobBooking,
      hasPhoto: !!(row && row.citizen_id_image_front_url),
    });
  } catch (err) {
    console.error('booking get error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

const BOOKING_STATUSES = new Set(['pending', 'reviewing', 'approved', 'rejected', 'cancelled', 'completed']);
const BOOKING_TRANSITIONS = {
  // pending → approved is allowed since 5534b48 introduced the new
  // POST /api/bookings/:id/approve-and-assign endpoint that runs the
  // verification checklist via a context-rich confirm modal showing
  // applicant details + tells admin about the follow-up steps (PIN
  // setup, LINE binding) — the "force admin to first click reviewing"
  // gate became redundant once the approve action itself surfaced the
  // applicant data. Keeping reviewing as an optional intermediate
  // state for cases where admin wants to mark "I've started looking"
  // separately from "I've decided to approve".
  pending:   ['reviewing', 'approved', 'rejected', 'cancelled'],
  reviewing: ['approved', 'rejected', 'cancelled'],
  // 'completed' is set by /api/contracts/quick-invite when admin converts
  // an approved booking into a contract+invitation. Admin can still cancel
  // after that (tenant backs out) so the exit edge stays open.
  approved:  ['completed', 'cancelled'],
  completed: ['cancelled'],          // contract handed off but admin can still cancel
  rejected:  ['reviewing'],          // re-open if admin reconsidered
  cancelled: [],                     // terminal
};

// POST /api/bookings/:id/approve-and-assign
//
// Atomically (1) flip the booking to 'approved', (2) find a vacant room
// matching its wantType/wantFloor, (3) mark that room 'reserved' with the
// applicant's tenant info, all under SELECT FOR UPDATE so two admins
// approving different bookings simultaneously can't race onto the same
// room. The previous client-side approval flow had this race: both admins
// saw room 301 as vacant, both wrote rooms blob with different tenants in
// 301, last write won — one tenant ended up homeless from the system's
// perspective. This endpoint serialises the read+write so the second
// caller sees the first's reservation + falls through to the next vacant
// room (or returns NO_VACANT_ROOM cleanly).
app.post('/api/bookings/:id/approve-and-assign', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  const id = String(req.params.id).slice(0, 64);
  const adminNotes = req.body?.adminNotes !== undefined ? String(req.body.adminNotes).slice(0, 1000) : undefined;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the two blobs we'll mutate. Order matters: bookings first
    // (alphabetical) — keeps a global lock order so two endpoints that
    // touch both blobs can't deadlock against each other.
    const bRes = await client.query(
      `SELECT value FROM app_data WHERE key='baankarn_bookings_v1' FOR UPDATE`
    );
    const rRes = await client.query(
      `SELECT value FROM app_data WHERE key='baankarn_rooms_v1' FOR UPDATE`
    );
    const bookings = bRes.rows.length && Array.isArray(bRes.rows[0].value) ? bRes.rows[0].value : [];
    const rooms = rRes.rows.length ? rRes.rows[0].value : {};

    const bIdx = bookings.findIndex((x) => x && x.id === id);
    if (bIdx < 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'booking not found', code: 'NOT_FOUND' });
    }
    const booking = bookings[bIdx];
    // Transition guard — match the BOOKING_TRANSITIONS rules.
    const allowedFrom = new Set(['pending', 'reviewing']);
    if (!allowedFrom.has(booking.status || 'pending')) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `cannot approve from status "${booking.status}"`,
        code: 'BAD_TRANSITION',
        allowed: ['pending', 'reviewing'],
      });
    }

    // Find a vacant room matching wantType + wantFloor. Same logic the
    // frontend used to do client-side, but now under the FOR UPDATE lock
    // so two callers see consistent state.
    //
    // Two sources to consult:
    //   (1) the legacy JSONB blob (rooms keyed by string id)
    //   (2) the rooms_v2 relational table — rooms created via POST /api/rooms
    //       only land here, so without the second query, NEW rooms are
    //       invisible to booking-approve and the response always reads
    //       NO_VACANT_ROOM_MATCH even when a matching vacancy exists.
    const want = (r) => (
      (!booking.wantType || r.type === booking.wantType) &&
      (!booking.wantFloor || Number(r.floor) === Number(booking.wantFloor))
    );
    const blobCandidates = Object.values(rooms || {})
      .filter((r) => r && r.status === 'vacant' && want(r));

    // Lock + read rooms_v2 vacant rows under the same transaction so a
    // concurrent admin can't grab the same v2 row mid-approval.
    let v2Candidates = [];
    try {
      const v2Q = await client.query(
        `SELECT room_code, room_type, floor, room_no, rent_price, deposit_price, wifi_fee
           FROM rooms_v2
           WHERE status='vacant' AND deleted_at IS NULL
             AND ($1::text IS NULL OR room_type = $1)
             AND ($2::int IS NULL OR floor = $2)
           ORDER BY room_code ASC
           FOR UPDATE`,
        [booking.wantType || null,
         booking.wantFloor != null ? Number(booking.wantFloor) : null]
      );
      v2Candidates = v2Q.rows.map((r) => ({
        id: r.room_code,
        type: r.room_type,
        floor: r.floor,
        no: r.room_no,
        rent: Number(r.rent_price),
        deposit: Number(r.deposit_price),
        wifi: Number(r.wifi_fee || 0),
        status: 'vacant',
        _source: 'v2',
      }));
    } catch (err) {
      if (err.code !== '42P01') throw err;  // table missing on legacy deploy
    }

    const candidate = [...blobCandidates, ...v2Candidates]
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];

    let assignedRoomId = null;
    if (candidate) {
      assignedRoomId = candidate.id;
      // Apply reservation in the source the candidate came from. If the
      // room exists ONLY in rooms_v2, mirror a minimal rooms blob entry too
      // so the admin UI (which still reads from the blob in places) sees
      // it as reserved. Without the mirror, blob-reading views would still
      // show the room as vacant.
      const reservation = {
        ...candidate,
        status: 'reserved',
        tenant: {
          name: booking.name,
          phone: booking.phone || '',
          email: booking.email || '',
          occupation: '',
          score: 'A',
          since: new Date().toISOString().slice(0, 10),
        },
        // Track the booking that reserved this room so admin can see the
        // link in the room editor + un-reserve cleanly if booking is
        // later cancelled. Useful for the no-show case (booked but never
        // moved in) where admin needs to know where the reservation came
        // from before flipping back to vacant.
        reservedBy: id,
        reservedAt: new Date().toISOString(),
      };
      delete reservation._source;
      rooms[candidate.id] = reservation;
      if (candidate._source === 'v2') {
        try {
          await client.query(
            `UPDATE rooms_v2 SET status='reserved', updated_at=NOW()
               WHERE room_code=$1 AND deleted_at IS NULL`,
            [candidate.id]
          );
        } catch (err) {
          if (err.code !== '42P01') throw err;
        }
      }
    }

    // Update the booking entry.
    bookings[bIdx] = {
      ...booking,
      status: 'approved',
      roomId: assignedRoomId || booking.roomId || null,
      adminNotes: adminNotes !== undefined ? adminNotes : booking.adminNotes,
      assignedRoomId,
      approvedAt: new Date().toISOString(),
      approvedBy: req.session.user.username,
      updatedAt: new Date().toISOString(),
      updatedBy: req.session.user.username,
    };

    // Persist both blobs in the same transaction.
    await client.query(
      `INSERT INTO app_data (key, value, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW(), updated_by=EXCLUDED.updated_by`,
      ['baankarn_bookings_v1', JSON.stringify(bookings), req.session.user.username]
    );
    await client.query(
      `INSERT INTO app_data (key, value, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW(), updated_by=EXCLUDED.updated_by`,
      ['baankarn_rooms_v1', JSON.stringify(rooms), req.session.user.username]
    );
    // Mirror the status change into the relational `bookings` table so the
    // SQL-backed views stay in sync. Best-effort: if the row was never
    // written (e.g. legacy booking from before the dual-write landed),
    // UPDATE affects 0 rows and we simply move on.
    try {
      await client.query(
        `UPDATE bookings
            SET status='approved', room_id=$2, updated_at=NOW()
          WHERE external_id=$1`,
        [id, assignedRoomId || null]
      );
    } catch (err) {
      console.warn('[booking] relational status sync skipped:', err.message);
    }
    await client.query('COMMIT');

    audit(req, 'booking.approve', 'booking', id, {
      assignedRoomId, wantType: booking.wantType, wantFloor: booking.wantFloor,
    });
    // Bridge tenant row out-of-tx (mirror function does its own writes;
    // we don't want to block the response on it).
    if (assignedRoomId) {
      mirrorRoomsToTenants(rooms, req.session.user.username).catch((err) => {
        console.error('[bridge] rooms→tenants mirror failed after approve:', err.message);
      });
    }
    // Notify owner + tenant fire-and-forget.
    try {
      const flags = await features.load(pool);
      notifier.notifyOwner({ pool, features: flags }, {
        subject: `✅ อนุมัติการจอง ${id}${assignedRoomId ? ` → ห้อง ${assignedRoomId}` : ''}`,
        text: `${booking.name || '-'} (${booking.phone || '-'})\n` +
              (assignedRoomId ? `จัดให้ห้อง ${assignedRoomId}` : 'ยังไม่ได้กำหนดห้อง — ไม่มีห้องว่างตรงเงื่อนไข'),
      }).catch(() => {});
      // Tenant gets the same approval message that the legacy PUT path sends.
      // Resolve the tenant whose phone matches AND who is currently assigned
      // to the just-approved room (if any). This avoids the race where two
      // tenants share a phone number — picking the most-recently-updated one
      // by phone alone could send the approval message to the OTHER tenant.
      // Fall back to the most-recent phone match only if the room match
      // returns nothing (legacy bookings predating room assignment).
      if (booking.phone) {
        const phoneNorm = String(booking.phone).replace(/[\s-]/g, '');
        const tenantInfo = { full_name: booking.name, email: booking.email, phone: phoneNorm };
        try {
          let tq = null;
          if (assignedRoomId) {
            tq = await pool.query(
              `SELECT id, line_user_id, line_oa_id, status FROM tenants
                 WHERE phone=$1 AND current_room_id=$2 AND deleted_at IS NULL
                 ORDER BY updated_at DESC LIMIT 1`,
              [phoneNorm, assignedRoomId]
            );
          }
          if (!tq || !tq.rows.length) {
            tq = await pool.query(
              `SELECT id, line_user_id, line_oa_id, status FROM tenants
                 WHERE phone=$1 AND deleted_at IS NULL AND status='active'
                 ORDER BY updated_at DESC LIMIT 1`,
              [phoneNorm]
            );
          }
          if (tq.rows.length) {
            tenantInfo.id = tq.rows[0].id;
            tenantInfo.line_user_id = tq.rows[0].line_user_id;
            tenantInfo.line_oa_id = tq.rows[0].line_oa_id;
            tenantInfo.status = tq.rows[0].status;
          }
        } catch { /* ignore */ }
        if (tenantInfo.line_user_id || tenantInfo.email) {
          notifier.notifyTenant({ pool, features: flags }, tenantInfo, {
            subject: 'การจองห้องได้รับการอนุมัติแล้ว',
            text: `✅ การจองห้องของคุณได้รับการอนุมัติ\n` +
                  (assignedRoomId ? `ห้อง: ${assignedRoomId}\n` : '') +
                  `กรุณาติดต่อสำนักงานเพื่อเซ็นสัญญา`,
          }).catch(() => {});
        }
      }
    } catch { /* ignore notify failures */ }

    res.json({
      ok: true,
      booking: bookings[bIdx],
      assignedRoomId,
      room: assignedRoomId ? rooms[assignedRoomId] : null,
      noVacantRoomMatch: !assignedRoomId,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('booking approve-and-assign error:', err);
    res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
  } finally {
    client.release();
  }
});

app.put('/api/bookings/:id', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  const id = String(req.params.id).slice(0, 64);
  const b = req.body || {};
  if (b.status && !BOOKING_STATUSES.has(String(b.status))) {
    return res.status(400).json({ error: 'invalid status' });
  }
  try {
    const { rows: cur } = await pool.query(`SELECT value FROM app_data WHERE key='baankarn_bookings_v1'`);
    const list = cur.length && Array.isArray(cur[0].value) ? cur[0].value : [];
    const idx = list.findIndex((x) => x && x.id === id);
    if (idx < 0) return res.status(404).json({ error: 'booking not found' });
    const before = list[idx];
    if (b.status && b.status !== before.status) {
      const allowed = BOOKING_TRANSITIONS[before.status || 'pending'] || [];
      if (!allowed.includes(b.status)) {
        return res.status(400).json({
          error: `cannot transition ${before.status} → ${b.status}`,
          allowed,
        });
      }
    }
    const updated = {
      ...before,
      status: b.status || before.status,
      adminNotes: b.adminNotes !== undefined ? String(b.adminNotes).slice(0, 1000) : before.adminNotes,
      roomId: b.roomId !== undefined ? String(b.roomId).slice(0, 32) : before.roomId,
      updatedAt: new Date().toISOString(),
      updatedBy: req.session.user.username,
    };
    list[idx] = updated;
    await pool.query(
      `INSERT INTO app_data (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW(), updated_by=EXCLUDED.updated_by`,
      ['baankarn_bookings_v1', JSON.stringify(list), req.session.user.username]
    );
    // Mirror status / room changes into the relational bookings table.
    // Best-effort: a missing row (legacy booking from before the dual-write
    // landed) is fine — UPDATE is a no-op then.
    if (b.status !== undefined || b.roomId !== undefined) {
      try {
        await pool.query(
          `UPDATE bookings
              SET status=$2, room_id=$3, updated_at=NOW()
            WHERE external_id=$1`,
          [id, updated.status, updated.roomId || null]
        );
      } catch (err) {
        console.warn('[booking] relational status sync skipped:', err.message);
      }
    }
    audit(req, 'booking.update', 'booking', id, {
      from: before.status, to: updated.status, fields: Object.keys(b),
    });

    // Fire-and-forget notify on status change (so the tenant + owner know
    // their booking was acted on).
    if (b.status && b.status !== before.status) {
      try {
        const flags = await features.load(pool);
        // Owner notification — concise audit-style line.
        const subj = `📋 Booking ${id}: ${before.status} → ${updated.status}`;
        notifier.notifyOwner({ pool, features: flags }, {
          subject: subj,
          text: `${updated.name || '-'} (${updated.phone || '-'})\n` +
                `ห้องที่ต้องการ: ${updated.roomId || updated.wantType || '-'}\n` +
                (updated.adminNotes ? `หมายเหตุ: ${updated.adminNotes}` : ''),
        }).catch(() => {});

        // Tenant notification — try to enrich the booking blob with the
        // applicant's bound LINE info so multi-OA tenants get the message
        // via the right OA. If the applicant is also a registered tenant
        // (matched by phone) we pull line_user_id + line_oa_id from there.
        const tenantText = ({
          approved: `✅ การจองห้องได้รับการอนุมัติแล้ว\nกรุณาติดต่อสำนักงานเพื่อเซ็นสัญญา`,
          rejected: `❌ ขออภัย — การจองห้องไม่ได้รับการอนุมัติ\n${updated.adminNotes ? 'หมายเหตุ: ' + updated.adminNotes : ''}`,
          reviewing: `🔍 การจองของคุณกำลังถูกตรวจสอบ`,
          cancelled: `🚫 การจองถูกยกเลิก`,
        })[updated.status];
        if (tenantText) {
          let tenantInfo = {
            full_name: updated.name,
            email: updated.email || null,
            phone: updated.phone || null,
            line_user_id: null,
            line_oa_id: null,
          };
          if (updated.phone) {
            try {
              const tq = await pool.query(
                `SELECT line_user_id, line_oa_id, email
                   FROM tenants WHERE phone=$1 AND deleted_at IS NULL
                   ORDER BY updated_at DESC LIMIT 1`,
                [updated.phone]
              );
              if (tq.rows.length) {
                tenantInfo.line_user_id = tq.rows[0].line_user_id;
                tenantInfo.line_oa_id = tq.rows[0].line_oa_id;
                if (!tenantInfo.email && tq.rows[0].email) tenantInfo.email = tq.rows[0].email;
              }
            } catch { /* ignore enrichment failure */ }
          }
          // Only fire notify if we have at least one channel — LINE binding
          // OR an email. Without either, the queued message would just log
          // "no channel" and waste a row.
          if (tenantInfo.line_user_id || tenantInfo.email) {
            notifier.notifyTenant({ pool, features: flags },
              tenantInfo,
              { subject: `อัปเดตสถานะการจองห้อง — ${updated.status}`, text: tenantText }
            ).catch(() => {});
          }
        }
      } catch { /* ignore */ }
    }
    res.json({ ok: true, booking: updated });
  } catch (err) {
    console.error('booking update error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// === v2: Recurring charges helper (B1) ====================================
// CRUD lives in routes/recurring-charges.js (dedicated router with Zod
// validation + a /:id/toggle action). We keep loadRecurringFor here
// because /api/bills POST below calls it directly to merge active rows
// into the line-item list at bill-generate time.

// Helper used by bill generation (manual + scheduler) to load active
// charges that apply to a given (tenantId, roomId) combo. one_off charges
// are returned only if they haven't been billed yet (we mark them
// inactive after their first inclusion — see /api/bills POST).
async function loadRecurringFor(pool, { tenantId, roomId }) {
  const params = [];
  const where = ['active = TRUE'];
  const ors = [];
  if (tenantId) { params.push(tenantId); ors.push(`tenant_id = $${params.length}`); }
  if (roomId)   { params.push(roomId);   ors.push(`room_id = $${params.length}`); }
  if (!ors.length) return [];
  where.push(`(${ors.join(' OR ')})`);
  where.push(`(start_at IS NULL OR start_at <= CURRENT_DATE)`);
  where.push(`(end_at IS NULL OR end_at >= CURRENT_DATE)`);
  const { rows } = await pool.query(
    `SELECT id, label, amount, frequency FROM recurring_charges
       WHERE ${where.join(' AND ')} ORDER BY created_at ASC`,
    params
  );
  return rows;
}

// === v2: Photo upload (rooms / signatures / citizen-id images) ============
app.post('/api/uploads', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager', 'staff'), features.requireFeature('photoUpload'), async (req, res) => {
  const b = req.body || {};
  const category = String(b.category || 'misc');
  if (!['room_photo', 'contract_signature', 'citizen_id_image', 'misc'].includes(category)) {
    return res.status(400).json({ error: 'invalid category' });
  }
  if (!b.dataUrl) return res.status(400).json({ error: 'dataUrl required' });
  // For citizen_id_image, validate side explicitly so admin UI can't store
  // an ambiguous "which side is this?" upload — cleaner than relying on
  // upload order or filename heuristics.
  let side = null;
  if (category === 'citizen_id_image') {
    if (b.side !== 'front' && b.side !== 'back') {
      return res.status(400).json({
        error: 'citizen_id_image upload must specify side=front|back',
        code: 'IDENTITY_SIDE_REQUIRED',
      });
    }
    side = b.side;
  }
  try {
    const out = await storage.saveBase64({
      pool,
      category,
      dataUrl: b.dataUrl,
      refId: b.refId ? String(b.refId).slice(0, 64) : null,
      uploadedBy: req.session.user.username,
      maxBytes: req.features.photoUpload.maxBytes || 1_500_000,
      side,
    });
    audit(req, 'upload.create', 'file', String(out.id), { category, side });
    res.json({ ok: true, file: out });
  } catch (err) {
    res.status(400).json({ error: err.message || 'upload failed' });
  }
});

// === v2: Tenant identity capture ==========================================
// POST /api/tenants/:id/identity
// body: {
//   citizenId?: '1234567890123',         // optional — only re-validates / re-hashes
//   frontDataUrl?: 'data:image/jpeg;...',
//   backDataUrl?:  'data:image/jpeg;...',
// }
//
// Saves the front + back images atomically (or just one if only one is
// supplied) and links them to the tenant row via the new
// citizen_id_image_{front,back}_id columns. When citizenId is included we
// validate the Thai mod-11 checksum + re-encrypt + recompute the hash so
// the dedup index detects "same person registered twice" cleanly.
//
// Requires owner/manager — staff can't see citizen-ID details, this is
// the upload counterpart.
app.post('/api/tenants/:id/identity', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
  features.requireFeature('photoUpload'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    const b = req.body || {};
    const front = b.frontDataUrl;
    const back  = b.backDataUrl;
    const citizenIdRaw = b.citizenId != null ? String(b.citizenId) : null;
    if (!front && !back && !citizenIdRaw) {
      return res.status(400).json({
        error: 'ต้องส่งภาพหน้าหรือหลังของบัตรอย่างน้อย 1 ด้าน หรือเลขบัตร 13 หลัก',
        code: 'NOTHING_TO_SAVE',
      });
    }

    // Optional Thai citizen-ID validation. If supplied, MUST pass checksum —
    // typing 13 random digits should fail loudly rather than silently store.
    const thaiId = require('./services/thaiId');
    let citizenId = null;
    let citizenTail = null;
    let citizenEnc = null;
    let citizenHash = null;
    if (citizenIdRaw) {
      const norm = thaiId.normalize(citizenIdRaw);
      if (!norm) {
        return res.status(400).json({
          error: 'เลขบัตรประชาชนต้องเป็น 13 หลัก',
          code: 'INVALID_CITIZEN_ID',
        });
      }
      if (!thaiId.validateChecksum(norm)) {
        return res.status(400).json({
          error: 'เลขบัตรประชาชนไม่ผ่านการตรวจสอบ check digit (mod-11)',
          code: 'INVALID_CHECKSUM',
        });
      }
      citizenId = norm;
      citizenTail = norm.slice(-4);
      citizenHash = thaiId.hashForLookup(norm);
      // Encrypt under the configured citizen-ID encryption flag (matches
      // the existing POST /api/tenants behaviour).
      try {
        const flags = await features.load(pool);
        if (flags.citizenIdEncryption && flags.citizenIdEncryption.enabled) {
          citizenEnc = cryptoSvc.encryptString(norm);
        } else {
          citizenEnc = norm;  // plaintext fallback (not recommended)
        }
      } catch (e) {
        return res.status(500).json({ error: 'crypto unavailable: ' + e.message });
      }
    }

    // Verify the tenant exists BEFORE storing the photos so we don't leave
    // orphan file_uploads on a 404. Pull existing image FK ids too so we can
    // remove them when the admin replaces a side (otherwise old files leak
    // on disk + bloat file_uploads).
    const t = await pool.query(
      `SELECT id, citizen_id_image_front_id, citizen_id_image_back_id
         FROM tenants WHERE id=$1 AND deleted_at IS NULL`,
      [id]
    );
    if (!t.rows.length) return res.status(404).json({ error: 'tenant not found' });
    const existingFrontId = t.rows[0].citizen_id_image_front_id;
    const existingBackId  = t.rows[0].citizen_id_image_back_id;

    // Pre-flight dedup check on citizen_id_hash so admin sees a clear
    // duplicate-detected response instead of a 23505 from the partial
    // unique index. Advisory only when force=true is set in the body.
    if (citizenHash) {
      const dup = await pool.query(
        `SELECT id, full_name, status FROM tenants
           WHERE citizen_id_hash=$1 AND deleted_at IS NULL AND status='active' AND id<>$2
           LIMIT 1`,
        [citizenHash, id]
      );
      if (dup.rows.length && b.force !== true) {
        return res.status(409).json({
          error: 'เลขบัตรนี้ถูกบันทึกในระบบแล้วกับผู้เช่ารายอื่น',
          code: 'CITIZEN_ID_DUPLICATE',
          conflict: dup.rows[0],
          hint: 'ส่ง { force: true } ถ้ายืนยันว่าเป็นคนเดิมและต้องการอัปเดตข้อมูล (audit-logged)',
        });
      }
    }

    const maxBytes = (req.features.photoUpload && req.features.photoUpload.maxBytes) || 1_500_000;
    const username = req.session.user.username;

    // Photos are saved sequentially so a failure mid-flight leaves the
    // tenant row consistent (we only commit the FK update once we know
    // both successful uploads landed).
    let frontFile = null, backFile = null;
    try {
      if (front) {
        frontFile = await storage.saveBase64({
          pool, category: 'citizen_id_image',
          dataUrl: front, refId: String(id), uploadedBy: username,
          maxBytes, side: 'front',
        });
      }
      if (back) {
        backFile = await storage.saveBase64({
          pool, category: 'citizen_id_image',
          dataUrl: back, refId: String(id), uploadedBy: username,
          maxBytes, side: 'back',
        });
      }
    } catch (err) {
      // Roll back any successful upload so we don't leave a half-linked record.
      if (frontFile) await storage.remove(pool, frontFile.id).catch(() => {});
      if (backFile)  await storage.remove(pool, backFile.id).catch(() => {});
      return res.status(400).json({ error: err.message || 'upload failed', code: 'UPLOAD_FAILED' });
    }

    // Link to tenant + write citizen ID fields if provided. All in ONE
    // statement so the partial unique index runs against a coherent row.
    const sets = []; const params = [];
    let i = 1;
    if (frontFile) { sets.push(`citizen_id_image_front_id=$${i++}`); params.push(frontFile.id); }
    if (backFile)  { sets.push(`citizen_id_image_back_id=$${i++}`);  params.push(backFile.id); }
    if (citizenEnc != null) { sets.push(`citizen_id_encrypted=$${i++}`); params.push(citizenEnc); }
    if (citizenTail != null) { sets.push(`citizen_id_tail=$${i++}`); params.push(citizenTail); }
    if (citizenHash != null) { sets.push(`citizen_id_hash=$${i++}`); params.push(citizenHash); }
    if (sets.length) {
      sets.push('updated_at = NOW()');
      params.push(id);
      try {
        await pool.query(
          `UPDATE tenants SET ${sets.join(', ')} WHERE id=$${i}`,
          params
        );
      } catch (err) {
        // 23505 = race against another concurrent identity write hitting
        // the same hash. Tear down photos so the next attempt isn't
        // double-storing.
        if (frontFile) await storage.remove(pool, frontFile.id).catch(() => {});
        if (backFile)  await storage.remove(pool, backFile.id).catch(() => {});
        if (err.code === '23505') {
          return res.status(409).json({
            error: 'เลขบัตรนี้ผูกกับผู้เช่ารายอื่นแล้ว (race)',
            code: 'CITIZEN_ID_DUPLICATE',
          });
        }
        throw err;
      }
    }

    // After successful link, remove the OLD files (if admin is replacing).
    // Best-effort — failure here doesn't fail the request because the new
    // file is already linked; the orphan would just sit around.
    if (frontFile && existingFrontId && existingFrontId !== frontFile.id) {
      await storage.remove(pool, existingFrontId).catch((err) => {
        console.warn('[identity] old front cleanup failed:', err.message);
      });
    }
    if (backFile && existingBackId && existingBackId !== backFile.id) {
      await storage.remove(pool, existingBackId).catch((err) => {
        console.warn('[identity] old back cleanup failed:', err.message);
      });
    }

    audit(req, 'tenant.identity', 'tenant', String(id), {
      hasFront: !!frontFile, hasBack: !!backFile,
      citizenTail, force: b.force === true,
      replacedFrontId: existingFrontId !== frontFile?.id ? existingFrontId : null,
      replacedBackId: existingBackId !== backFile?.id ? existingBackId : null,
    });
    // Owner notify so a third party sees identity-capture activity. Reduces
    // inside-job risk where a single admin could fabricate tenant records;
    // the owner gets a paper trail in LINE/email.
    try {
      const flags = await features.load(pool);
      const sides = [
        frontFile ? 'หน้า' : null,
        backFile ? 'หลัง' : null,
      ].filter(Boolean).join('+');
      notifier.notifyOwner({ pool, features: flags }, {
        subject: `📇 บันทึกบัตรประชาชน — tenant id=${id}`,
        text: `admin ${req.session.user.username} บันทึกภาพบัตร${sides ? ' (' + sides + ')' : ''}`
          + (citizenTail ? `\nหมายเลข: ***-${citizenTail}` : '')
          + (b.force === true ? '\n⚠️ ใช้ force=true bypass dedup' : ''),
      }).catch(() => {});
    } catch { /* notify failure must not break the request */ }
    res.json({
      ok: true,
      tenantId: id,
      front: frontFile ? { id: frontFile.id, url: frontFile.url, side: 'front' } : null,
      back:  backFile  ? { id: backFile.id,  url: backFile.url,  side: 'back'  } : null,
      citizenIdHashSet: !!citizenHash,
      replacedFrontId: existingFrontId && frontFile && existingFrontId !== frontFile.id ? existingFrontId : null,
      replacedBackId: existingBackId && backFile && existingBackId !== backFile.id ? existingBackId : null,
    });
  });

// GET /api/tenants/:id/identity — return the current image links + masked
// citizen ID. Owner/manager only — staff has read on tenant rows but not
// citizen ID; we explicitly gate this endpoint.
app.get('/api/tenants/:id/identity', requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.full_name, t.citizen_id_tail,
              t.citizen_id_image_front_id, t.citizen_id_image_back_id,
              ff.url AS front_url, bf.url AS back_url,
              ff.uploaded_at AS front_uploaded_at, bf.uploaded_at AS back_uploaded_at
         FROM tenants t
         LEFT JOIN file_uploads ff ON ff.id = t.citizen_id_image_front_id
         LEFT JOIN file_uploads bf ON bf.id = t.citizen_id_image_back_id
        WHERE t.id=$1 AND t.deleted_at IS NULL LIMIT 1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'tenant not found' });
    const r = rows[0];
    res.json({
      ok: true,
      tenantId: r.id,
      fullName: r.full_name,
      citizenIdTail: r.citizen_id_tail,  // last 4 only
      front: r.citizen_id_image_front_id ? {
        id: r.citizen_id_image_front_id, url: r.front_url, uploadedAt: r.front_uploaded_at,
      } : null,
      back: r.citizen_id_image_back_id ? {
        id: r.citizen_id_image_back_id, url: r.back_url, uploadedAt: r.back_uploaded_at,
      } : null,
    });
  } catch (err) {
    console.error('identity get error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// === v2: Meter readings ===================================================
app.post('/api/meters/:roomId/readings', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager', 'staff'), features.requireFeature('meterIot'), async (req, res) => {
  const roomId = String(req.params.roomId).slice(0, 32);
  const { meterType, reading, source } = req.body || {};
  try {
    const row = await meter.record(pool, {
      roomId, meterType, reading,
      // A2 — only 'manual' is appropriate for admin-entered readings; an
      // admin shouldn't be able to claim a reading came from MQTT/simulator
      // (those come from scheduler / device endpoints with bearer auth).
      source: 'manual',
      createdBy: req.session.user.username,
    });
    // A2 — anomaly detection is fail-soft: if features not loaded for any
    // reason, default sigmas=3 and still notify. The notifier is already
    // non-throwing, but we additionally swallow any awaits so the admin's
    // request never fails because the LINE owner endpoint is down.
    const flags = req.features || (await features.load(pool).catch(() => ({})));
    const sigmas = (flags.meterIot && flags.meterIot.anomalySigmas) || 3;
    let anomaly = null;
    try {
      anomaly = await meter.detectAnomaly(pool, roomId, row.meter_type, sigmas);
    } catch (e) { console.warn('[meter] anomaly detect failed:', e.message); }
    if (anomaly) {
      const isRollback = anomaly.kind === 'rollback';
      const subject = isRollback ? '⚠️ มิเตอร์ค่าลดลง' : '⚠️ มิเตอร์ผิดปกติ';
      const text = isRollback
        ? `ห้อง ${roomId} (${row.meter_type}) ค่ามิเตอร์ลดลง ${Number(anomaly.last).toFixed(2)} หน่วย\n`
          + `น่าจะเป็น meter reset / ป้อนค่าผิด — โปรดตรวจสอบก่อนออกบิล`
        : `ห้อง ${roomId} (${row.meter_type}) z=${Number(anomaly.z).toFixed(2)} เกิน ${sigmas}σ\n`
          + `ค่าล่าสุด: ${anomaly.last}, ค่าเฉลี่ย: ${Number(anomaly.mean).toFixed(2)}`;
      notifier.notifyOwner(
        { pool, features: flags },
        { subject, text }
      ).catch(() => {});
      audit(req, 'meter.anomaly', 'meter', String(row.id), {
        kind: anomaly.kind || 'sigma',
        z: anomaly.z, sigmas, mean: anomaly.mean,
      });
    }
    audit(req, 'meter.record', 'meter', String(row.id), { meterType: row.meter_type, reading: row.reading });
    res.json({ ok: true, reading: row, anomaly });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/meters/:roomId/readings', requireAuth, async (req, res) => {
  const roomId = String(req.params.roomId).slice(0, 32);
  const type = String(req.query.type || 'elec');
  if (!meter.ALLOWED_TYPES.has(type)) return res.status(400).json({ error: 'invalid type' });
  try {
    const { rows } = await pool.query(
      `SELECT * FROM meter_readings WHERE room_id=$1 AND meter_type=$2
         ORDER BY reading_at DESC LIMIT 200`,
      [roomId, type]
    );
    res.json({ ok: true, readings: rows });
  } catch (err) {
    console.error('meter list error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// === v2: Access control logs (manual entry; integrates with future RFID) ==
// Hardware (Bearer token) skips sameOrigin since it never has a browser
// Origin header. Admin users still get the CSRF-style same-origin check.
function deviceOrSameOrigin(req, res, next) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return next();
  return sameOrigin(req, res, next);
}
app.post('/api/access/log', deviceOrSameOrigin, requireDeviceOrAdmin, features.requireFeature('accessControl'), async (req, res) => {
  const b = req.body || {};
  const device = String(b.device || '').slice(0, 64);
  const method = String(b.method || 'manual').slice(0, 16);
  const result = String(b.result || 'granted').slice(0, 16);
  if (!device) return res.status(400).json({ error: 'device required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO access_logs (room_id, tenant_id, device, method, card_id, result, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        b.roomId ? String(b.roomId).slice(0, 32) : null,
        Number.isInteger(Number(b.tenantId)) ? Number(b.tenantId) : null,
        device, method,
        b.cardId ? String(b.cardId).slice(0, 64) : null,
        ['granted', 'denied'].includes(result) ? result : 'granted',
        b.reason ? String(b.reason).slice(0, 200) : null,
      ]
    );
    audit(req, 'access.log', 'access', String(rows[0].id));
    res.json({ ok: true, log: rows[0] });
  } catch (err) {
    console.error('access log error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/access/logs', requireAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  try {
    const { rows } = await pool.query(
      `SELECT * FROM access_logs ORDER BY occurred_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ ok: true, logs: rows });
  } catch (err) {
    console.error('access logs list error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// === v2: Access cards CRUD ================================================
// Issue / list / revoke RFID (or other) cards for tenants. The scheduler
// already auto-revokes cards for tenants who fall behind on bills (see
// services/scheduler.tickAccessControlSync), but until now there was no
// way for admin to actually CREATE the cards being revoked — the table
// was effectively dead. These endpoints close that loop.
app.get('/api/access/cards', requireAuth, async (req, res) => {
  try {
    const params = [];
    const where = [];
    if (req.query.tenantId) {
      const tid = Number(req.query.tenantId);
      if (Number.isInteger(tid) && tid > 0) {
        params.push(tid); where.push(`tenant_id=$${params.length}`);
      }
    }
    if (req.query.status === 'active' || req.query.status === 'revoked') {
      params.push(req.query.status); where.push(`status=$${params.length}`);
    }
    const sql = `SELECT id, card_id, tenant_id, room_id, status,
                        issued_at, revoked_at, revoke_reason
                   FROM access_cards
                   ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                   ORDER BY issued_at DESC LIMIT 500`;
    const { rows } = await pool.query(sql, params);
    res.json({ ok: true, cards: rows });
  } catch (err) {
    console.error('access cards list error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/access/cards', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
  features.requireFeature('accessControl'),
  async (req, res) => {
    const cardId = String(req.body?.cardId || '').trim().slice(0, 64);
    const tenantId = req.body?.tenantId ? Number(req.body.tenantId) : null;
    const roomId = req.body?.roomId ? String(req.body.roomId).slice(0, 32) : null;
    if (!cardId || !/^[A-Za-z0-9_.:-]{2,64}$/.test(cardId)) {
      return res.status(400).json({ error: 'card_id ต้องเป็น 2-64 ตัวอักษร a-z 0-9 _.:-' });
    }
    if (tenantId !== null && (!Number.isInteger(tenantId) || tenantId < 1)) {
      return res.status(400).json({ error: 'invalid tenant_id' });
    }
    try {
      // Validate the tenant exists before inserting; otherwise the FK
      // would yell with an unhelpful 23503 instead of a clean 404.
      if (tenantId) {
        const t = await pool.query(
          `SELECT 1 FROM tenants WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,
          [tenantId]
        );
        if (!t.rows.length) return res.status(404).json({ error: 'tenant not found' });
      }
      const { rows } = await pool.query(
        `INSERT INTO access_cards (card_id, tenant_id, room_id, status)
         VALUES ($1,$2,$3,'active')
         RETURNING id, card_id, tenant_id, room_id, status, issued_at`,
        [cardId, tenantId, roomId]
      );
      audit(req, 'access_card.create', 'card', String(rows[0].id),
        { cardId, tenantId, roomId });
      res.json({ ok: true, card: rows[0] });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'card_id ซ้ำ — ใช้รหัสอื่น', code: 'DUPLICATE_CARD_ID' });
      }
      console.error('access card create error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

app.put('/api/access/cards/:id/revoke', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    const reason = String(req.body?.reason || 'manual').slice(0, 200);
    try {
      const { rows } = await pool.query(
        `UPDATE access_cards
            SET status='revoked', revoked_at=NOW(), revoke_reason=$1
          WHERE id=$2 AND status='active'
          RETURNING id, card_id, status, revoked_at, revoke_reason`,
        [reason, id]
      );
      if (!rows.length) {
        return res.status(404).json({ error: 'not found or already revoked' });
      }
      audit(req, 'access_card.revoke', 'card', String(id), { reason });
      res.json({ ok: true, card: rows[0] });
    } catch (err) {
      console.error('access card revoke error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

app.put('/api/access/cards/:id/restore', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    try {
      const { rows } = await pool.query(
        `UPDATE access_cards
            SET status='active', revoked_at=NULL, revoke_reason=NULL
          WHERE id=$1 AND status='revoked'
          RETURNING id, card_id, status`,
        [id]
      );
      if (!rows.length) {
        return res.status(404).json({ error: 'not found or already active' });
      }
      audit(req, 'access_card.restore', 'card', String(id));
      res.json({ ok: true, card: rows[0] });
    } catch (err) {
      console.error('access card restore error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

// === v2: Admin user management (B1, C7) ===================================
// Real CRUD against auth_users, replacing the localStorage-only stub in
// page-settings.jsx. Owner-only — no other role can change or remove
// privileged accounts.
app.get('/api/admin/users', requireAuth, requireRole('owner'), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, role, created_at FROM auth_users ORDER BY id ASC'
    );
    res.json({ ok: true, users: rows });
  } catch (err) {
    console.error('admin users list error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});
app.post('/api/admin/users', sameOrigin, csrfGuard, requireAuth, requireRole('owner'), async (req, res) => {
  const r = require('./schemas').schemas.adminCreateUser.safeParse(req.body || {});
  if (!r.success) return res.status(400).json(require('./middleware/validate').formatZodError(r.error));
  // Force lowercase username so "admin"/"Admin"/"ADMIN" can't all coexist as
  // separate rows. Lockout principal already lowercases (server.js:663) so
  // case-different siblings would otherwise share the same lockout counter
  // — locking each other out unintentionally on bad-password attempts.
  const username = String(r.data.username).toLowerCase();
  const password = r.data.password;
  const finalRole = r.data.role || 'staff';
  try {
    const exists = await pool.query('SELECT 1 FROM auth_users WHERE LOWER(username)=$1', [username]);
    if (exists.rows.length) return res.status(409).json({ error: 'username already exists' });
    // bcrypt cost 12 on new accounts (login compare works against any cost,
    // so existing rows with cost 10 keep working without re-hash).
    const hash = await bcrypt.hash(password, 12);
    const ins = await pool.query(
      `INSERT INTO auth_users (username, password_hash, role) VALUES ($1,$2,$3)
       RETURNING id, username, role, created_at`,
      [username, hash, finalRole]
    );
    // Log the ACTUAL assigned role (not the request body's optional field
    // which can be undefined and shows up as `{ role: undefined }`).
    audit(req, 'user.create', 'user', String(ins.rows[0].id),
      { username, role: finalRole, by: req.session.user.username });
    // Notify all OTHER owners — adds visibility if a hijacked session is
    // creating a backdoor user. Fail-soft so the create still succeeds even
    // if the notifier path is broken.
    notifyOtherOwners(req, {
      subject: '👤 มีการสร้างผู้ใช้ใหม่',
      text: `${req.session.user.username} สร้างผู้ใช้ "${username}" (role: ${finalRole})`,
    }).catch(() => {});
    res.json({ ok: true, user: ins.rows[0] });
  } catch (err) {
    console.error('admin users create error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});
app.put('/api/admin/users/:id', sameOrigin, csrfGuard, requireAuth, requireRole('owner'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  const r = require('./schemas').schemas.adminUpdateUser.safeParse(req.body || {});
  if (!r.success) return res.status(400).json(require('./middleware/validate').formatZodError(r.error));
  const { password, currentPassword, role } = r.data;
  const isSelf = Number(req.session.user.id) === id;

  try {
    // Look up the target row first — we need to know its current state to
    // enforce the "last owner" + "no self-demote" + "step-up" rules.
    const beforeQ = await pool.query(
      'SELECT id, username, role, password_hash FROM auth_users WHERE id=$1',
      [id]
    );
    if (!beforeQ.rows.length) return res.status(404).json({ error: 'not found' });
    const before = beforeQ.rows[0];

    // Step-up auth: changing your OWN password requires the current
    // password. Without this, a hijacked session can rotate the password
    // and lock out the legit owner who wouldn't know to invalidate
    // sessions. Other owners changing each other's passwords is fine
    // because that's the recovery path.
    if (password && isSelf) {
      if (!currentPassword) {
        return res.status(400).json({
          error: 'currentPassword required when changing your own password',
          code: 'STEP_UP_REQUIRED',
        });
      }
      const ok = await bcrypt.compare(currentPassword, before.password_hash);
      if (!ok) {
        audit(req, 'user.password_self_change_failed', 'user', String(id), null);
        return res.status(401).json({ error: 'current password is incorrect' });
      }
    }

    // Block self role-change. Owners must use a different owner account to
    // demote themselves (defense vs hijacked session writing themselves
    // out of admin), and we never want an owner to accidentally drop their
    // own privileges and lose access until another owner restores them.
    if (role && isSelf && role !== before.role) {
      return res.status(400).json({
        error: 'cannot change your own role — ask another owner',
        code: 'SELF_ROLE_CHANGE',
      });
    }

    // Block last-owner demotion. Without this, the system can end up with
    // zero owners and /api/admin/users becomes inaccessible to everyone.
    if (role && before.role === 'owner' && role !== 'owner') {
      const owners = await pool.query(`SELECT COUNT(*)::int n FROM auth_users WHERE role='owner'`);
      if (owners.rows[0].n <= 1) {
        return res.status(400).json({
          error: 'cannot demote the last owner',
          code: 'LAST_OWNER',
        });
      }
    }

    const fields = [], params = [];
    let i = 1;
    if (password) {
      const hash = await bcrypt.hash(password, 12);
      fields.push(`password_hash=$${i++}`); params.push(hash);
    }
    if (role) { fields.push(`role=$${i++}`); params.push(role); }
    if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
    params.push(id);
    const upd = await pool.query(
      `UPDATE auth_users SET ${fields.join(', ')} WHERE id=$${i} RETURNING id, username, role`,
      params
    );
    if (!upd.rows.length) return res.status(404).json({ error: 'not found' });

    // Detailed audit so forensics can reconstruct exactly what changed.
    // For role changes we explicitly capture old → new because field-list
    // alone makes "owner→staff" indistinguishable from "manager→staff".
    const detail = {
      target: before.username,
      passwordChanged: !!password,
      isSelf,
    };
    if (role && role !== before.role) {
      detail.role = { from: before.role, to: role };
    }
    audit(req, 'user.update', 'user', String(id), detail);

    // Notify other owners on role changes or password reset for non-self
    // (resetting your own password is normal; resetting someone else's is
    // a recovery action that should be visible).
    if ((role && role !== before.role) || (password && !isSelf)) {
      notifyOtherOwners(req, {
        subject: '⚙️ การเปลี่ยนสิทธิ์ผู้ใช้',
        text: role && role !== before.role
          ? `${req.session.user.username} เปลี่ยน role ของ "${before.username}": ${before.role} → ${role}`
          : `${req.session.user.username} รีเซ็ตรหัสผ่านของ "${before.username}"`,
      }).catch(() => {});
    }
    res.json({ ok: true, user: upd.rows[0] });
  } catch (err) {
    console.error('admin users update error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});
app.delete('/api/admin/users/:id', sameOrigin, csrfGuard, requireAuth, requireRole('owner'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  if (req.session.user.id === id) {
    return res.status(400).json({ error: 'cannot delete your own account' });
  }
  try {
    // Prevent deleting the last owner — DB would still have you locked out.
    const owners = await pool.query(`SELECT COUNT(*)::int n FROM auth_users WHERE role='owner'`);
    const target = await pool.query(`SELECT id, username, role FROM auth_users WHERE id=$1`, [id]);
    if (!target.rows.length) return res.status(404).json({ error: 'not found' });
    if (target.rows[0].role === 'owner' && owners.rows[0].n <= 1) {
      return res.status(400).json({ error: 'cannot delete the last owner' });
    }
    const t = target.rows[0];
    await pool.query('DELETE FROM auth_users WHERE id=$1', [id]);
    audit(req, 'user.delete', 'user', String(id),
      { username: t.username, role: t.role, by: req.session.user.username });
    notifyOtherOwners(req, {
      subject: '🗑️ ผู้ใช้ถูกลบ',
      text: `${req.session.user.username} ลบบัญชี "${t.username}" (role: ${t.role})`,
    }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    console.error('admin users delete error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Helper for user-mgmt endpoints: push a one-line alert to every owner
// EXCEPT the actor. Lets the team see when someone creates/promotes/deletes
// privileged accounts so a hijacked owner session leaves a visible trail.
// Best-effort — never blocks the originating request.
async function notifyOtherOwners(req, msg) {
  try {
    const flags = await features.load(pool);
    const actorId = req.session?.user?.id;
    // We notify owners by LINE userId only when they have one bound. Email
    // fallback runs through notifier.notifyOwner which targets the
    // configured LINE_OWNER_USER_ID / OWNER_EMAIL, so we always at least
    // hit the system owner channel.
    await notifier.notifyOwner({ pool, features: flags }, msg);
    // Plus per-owner LINE push for any other owner with line_user_id set.
    const { rows } = await pool.query(
      `SELECT u.id, u.username FROM auth_users u
         WHERE u.role='owner' AND u.id <> $1`,
      [actorId || 0]
    );
    // We previously matched owner accounts against the tenants table by
    // full_name OR phone to find their bound LINE id. That was exploitable:
    // an attacker who can register a tenant with full_name='alice'
    // (matching an owner username) could intercept owner-management
    // notifications meant for the real Alice.
    //
    // Per-owner LINE delivery would need a deliberate auth_users.line_user_id
    // column + binding flow, which we don't have yet. For now the system
    // owner channel above (LINE_OWNER_USER_ID / OWNER_EMAIL via notifier.
    // notifyOwner) is the only outbound path. Audit log still captures
    // every user-mgmt action so other owners see them on next login.
  } catch (err) {
    console.warn('[user-mgmt] notify other owners failed:', err.message);
  }
}

// === v2: Security events (failed logins / lockouts) =======================
// Read-only viewer of recent auth_failures. Helps owner spot brute-force
// before it succeeds.
app.get('/api/admin/security-events', requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  try {
    const [failed, locked] = await Promise.all([
      pool.query(
        `SELECT id, user_id, action, ip, ua, detail, created_at
           FROM audit_logs
          WHERE action IN ('auth.login_failed','tenant.login_failed','auth.login_locked')
          ORDER BY created_at DESC LIMIT $1`,
        [limit]
      ),
      pool.query(
        `SELECT principal, kind, fail_count, locked_until, last_fail_at
           FROM login_lockouts
          WHERE locked_until IS NOT NULL AND locked_until > NOW()
          ORDER BY locked_until DESC LIMIT 50`
      ),
    ]);
    res.json({ ok: true, failed: failed.rows, lockouts: locked.rows });
  } catch (err) {
    console.error('security events error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// === v2: Access devices (B2) — manage hardware Bearer tokens ===============
app.get('/api/admin/access-devices', requireAuth, requireRole('owner', 'manager'), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, device_id, enabled, description, last_seen, created_at
         FROM access_devices ORDER BY created_at DESC`
    );
    res.json({ ok: true, devices: rows });
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});
app.post('/api/admin/access-devices', sameOrigin, csrfGuard, requireAuth, requireRole('owner'), async (req, res) => {
  const deviceId = String(req.body?.deviceId || '').trim().slice(0, 64);
  const description = String(req.body?.description || '').slice(0, 200);
  if (!deviceId || !/^[A-Za-z0-9_.-]{2,64}$/.test(deviceId)) {
    return res.status(400).json({ error: 'invalid device id' });
  }
  // Generate a 32-byte random token; return it ONCE in the response. We
  // store only the SHA-256 hash, so a leaked DB row can't be replayed.
  const _crypto = require('crypto');
  const token = _crypto.randomBytes(32).toString('hex');
  const hash = _crypto.createHash('sha256').update(token).digest('hex');
  try {
    const { rows } = await pool.query(
      `INSERT INTO access_devices (device_id, api_token_hash, description)
       VALUES ($1,$2,$3) RETURNING id, device_id, enabled, created_at`,
      [deviceId, hash, description || null]
    );
    audit(req, 'access_device.create', 'device', deviceId);
    res.json({ ok: true, device: rows[0], token, hint: 'Save this token now — it will never be shown again.' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'device id already exists' });
    console.error('access device create error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});
app.delete('/api/admin/access-devices/:id', sameOrigin, csrfGuard, requireAuth, requireRole('owner'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  try {
    await pool.query('DELETE FROM access_devices WHERE id=$1', [id]);
    audit(req, 'access_device.delete', 'device', String(id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

// === v2: Notifications log (read-only admin viewer) ========================
app.get('/api/notifications/log', requireAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  try {
    const { rows } = await pool.query(
      `SELECT * FROM notifications_log ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ ok: true, logs: rows });
  } catch (err) {
    console.error('notif log error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /api/client-error — best-effort sink for ErrorBoundary reports.
// Public + lightly rate-limited so bots can't flood it.
const _clientErrLimit = makeIpLimiter({ windowMs: 60_000, max: 30 });
app.post('/api/client-error', _clientErrLimit, async (req, res) => {
  const b = req.body || {};
  const userId = req.session?.user ? req.session.user.username : null;
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, detail, ip, ua)
       VALUES ($1,'client_error','frontend',$2::jsonb,$3,$4)`,
      [
        userId,
        JSON.stringify({
          message: String(b.message || '').slice(0, 1000),
          stack: String(b.stack || '').slice(0, 4000),
          componentStack: String(b.componentStack || '').slice(0, 4000),
          url: String(b.url || '').slice(0, 500),
        }),
        clientIp(req),
        (req.headers['user-agent'] || '').slice(0, 400),
      ]
    );
  } catch { /* ignore */ }
  // Always 204 — never tell the client about server errors.
  res.status(204).end();
});

// === Mount routes/ modules =================================================
// Each module gets a context object with shared dependencies. Done here
// (not earlier) so all helpers are defined.
const _routesIndex = require('./routes');
const _routesCtx = {
  pool,
  audit,
  requireAuth,
  requireRole,
  requireDeviceOrAdmin,
  requireTenant: (req, res, next) => requireTenant(req, res, next),
  sameOrigin,
  csrfGuard,
  lockout,                                 // for per-principal brute-force defense
  makeIpLimiter,                           // shared IP-based rate-limit factory
};
const _routesMounted = _routesIndex(app, _routesCtx);

// === v2: Contracts CRUD ===================================================
// The contracts table is populated by /api/tenants/:id/checkin (which is
// finally accessible via UI in this round). These endpoints expose the
// table for read + targeted edits — admin needs them to:
//   - see who's coming up for renewal (paired with tickContractExpiry alerts)
//   - tweak discount_pct or term_months on an existing contract without
//     having to check the tenant out + back in
app.get('/api/contracts', requireAuth, async (req, res) => {
  const params = [];
  const where = ['c.deleted_at IS NULL'];
  if (req.query.status && ['active', 'ended', 'expired'].includes(String(req.query.status))) {
    params.push(req.query.status); where.push(`c.status=$${params.length}`);
  }
  if (req.query.tenantId) {
    const tid = Number(req.query.tenantId);
    if (Number.isInteger(tid) && tid > 0) {
      params.push(tid); where.push(`c.tenant_id=$${params.length}`);
    }
  }
  if (req.query.roomId) {
    params.push(String(req.query.roomId).slice(0, 32));
    where.push(`c.room_id=$${params.length}`);
  }
  // Optional: only contracts ending within N days (for renewal dashboards)
  if (req.query.expiringInDays) {
    const days = Math.min(365, Math.max(1, Number(req.query.expiringInDays) || 0));
    if (days > 0) {
      where.push(`c.end_date IS NOT NULL`);
      where.push(`c.end_date >= CURRENT_DATE`);
      where.push(`c.end_date < CURRENT_DATE + INTERVAL '${days} days'`);
    }
  }
  try {
    // Try the SELECT including the locked_at + template_id columns added
    // in the contract-template + tenant-fill rounds. Falls back to the
    // legacy column set on pre-migration deploys (42703) so the page
    // keeps loading mid-migration.
    let rows;
    try {
      ({ rows } = await pool.query(
        `SELECT c.id, c.contract_no, c.tenant_id, c.room_id,
                c.start_date, c.end_date, c.term_months,
                c.monthly_rent, c.deposit, c.discount_pct,
                c.status, c.signed_at, c.created_at,
                c.locked_at, c.locked_by, c.template_id,
                t.full_name AS tenant_name, t.phone AS tenant_phone,
                CASE WHEN c.end_date IS NULL THEN NULL
                     ELSE (c.end_date - CURRENT_DATE)::int
                END AS days_left,
                -- Surface the active invitation status (if any) so admin
                -- sees at-a-glance whether the link is still pending or
                -- the tenant has already submitted for review.
                (SELECT i.status FROM contract_invitations i
                   WHERE i.contract_id = c.id
                     AND i.status IN ('pending','submitted')
                   ORDER BY i.created_at DESC LIMIT 1) AS active_invitation_status
           FROM contracts c
           LEFT JOIN tenants t ON t.id = c.tenant_id AND t.deleted_at IS NULL
          WHERE ${where.join(' AND ')}
          ORDER BY
            CASE c.status WHEN 'active' THEN 0 WHEN 'expired' THEN 1 ELSE 2 END,
            c.end_date NULLS LAST, c.created_at DESC
          LIMIT 1000`,
        params
      ));
    } catch (err) {
      if (err.code !== '42703' && err.code !== '42P01') throw err;
      ({ rows } = await pool.query(
        `SELECT c.id, c.contract_no, c.tenant_id, c.room_id,
                c.start_date, c.end_date, c.term_months,
                c.monthly_rent, c.deposit, c.discount_pct,
                c.status, c.signed_at, c.created_at,
                t.full_name AS tenant_name, t.phone AS tenant_phone,
                CASE WHEN c.end_date IS NULL THEN NULL
                     ELSE (c.end_date - CURRENT_DATE)::int
                END AS days_left
           FROM contracts c
           LEFT JOIN tenants t ON t.id = c.tenant_id AND t.deleted_at IS NULL
          WHERE ${where.join(' AND ')}
          ORDER BY
            CASE c.status WHEN 'active' THEN 0 WHEN 'expired' THEN 1 ELSE 2 END,
            c.end_date NULLS LAST, c.created_at DESC
          LIMIT 1000`,
        params
      ));
    }
    res.json({ ok: true, contracts: rows });
  } catch (err) {
    console.error('contracts list error:', err);
    res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
  }
});

app.get('/api/contracts/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  try {
    const { rows } = await pool.query(
      `SELECT c.*, t.full_name AS tenant_name, t.phone AS tenant_phone
         FROM contracts c
         LEFT JOIN tenants t ON t.id = c.tenant_id AND t.deleted_at IS NULL
        WHERE c.id=$1 AND c.deleted_at IS NULL`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, contract: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
  }
});

app.put('/api/contracts/:id', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    const b = req.body || {};
    const fields = []; const params = []; let i = 1;
    // Allow-list mutable fields. monthly_rent is intentionally NOT here
    // because the bill computation reads room.rent (rooms blob) — letting
    // admin set monthly_rent on the contract would create a discrepancy.
    if (b.discountPct !== undefined) {
      const pct = Number(b.discountPct);
      if (!Number.isFinite(pct) || pct < 0 || pct > 50) {
        return res.status(400).json({ error: 'discountPct must be 0-50' });
      }
      fields.push(`discount_pct=$${i++}`); params.push(pct);
    }
    if (b.termMonths !== undefined) {
      const t = Number(b.termMonths);
      if (b.termMonths !== null && (!Number.isInteger(t) || t < 1 || t > 120)) {
        return res.status(400).json({ error: 'termMonths must be 1-120' });
      }
      fields.push(`term_months=$${i++}`); params.push(b.termMonths === null ? null : t);
    }
    if (b.endDate !== undefined) {
      // Either YYYY-MM-DD string or null to clear
      if (b.endDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.endDate))) {
        return res.status(400).json({ error: 'endDate must be YYYY-MM-DD' });
      }
      fields.push(`end_date=$${i++}::date`); params.push(b.endDate);
    }
    if (b.status !== undefined) {
      if (!['active', 'ended', 'expired'].includes(String(b.status))) {
        return res.status(400).json({ error: 'status must be active|ended|expired' });
      }
      fields.push(`status=$${i++}`); params.push(b.status);
    }
    if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
    params.push(id);
    try {
      const { rows } = await pool.query(
        `UPDATE contracts SET ${fields.join(', ')} WHERE id=$${i} AND deleted_at IS NULL RETURNING *`,
        params
      );
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      audit(req, 'contract.update', 'contract', String(id), { fields: Object.keys(b) });
      res.json({ ok: true, contract: rows[0] });
    } catch (err) {
      console.error('contract update error:', err);
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    }
  });

// POST /api/contracts/:id/sign
// body: { signatureDataUrl, agreedTermsVersion? }
//
// Records the contract signature image + signed_at + agreed_terms_at on the
// contract row. The signature image is uploaded via storage.saveBase64
// under category=contract_signature so it lives alongside other auth-gated
// files at /files/:id. Once signed, contracts.signature_image_id is locked
// from re-set unless the operator explicitly passes { force: true }.
app.post('/api/contracts/:id/sign', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
  features.requireFeature('photoUpload'),
  validateBody(schemas.contractSign),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    const { signatureDataUrl, agreedTermsVersion } = req.body;
    const force = req.body && req.body.force === true;

    // Verify the contract exists + is active before storing the photo.
    const cQ = await pool.query(
      `SELECT id, contract_no, status, signature_image_id, tenant_id
         FROM contracts WHERE id=$1 AND deleted_at IS NULL`,
      [id]
    );
    if (!cQ.rows.length) return res.status(404).json({ error: 'contract not found' });
    const contract = cQ.rows[0];
    if (contract.status !== 'active' && !force) {
      return res.status(409).json({
        error: `สัญญาสถานะ ${contract.status} เซ็นไม่ได้ (เซ็นได้เฉพาะ active)`,
        code: 'CONTRACT_NOT_ACTIVE',
        currentStatus: contract.status,
      });
    }
    if (contract.signature_image_id && !force) {
      return res.status(409).json({
        error: 'สัญญาฉบับนี้ลงนามแล้ว — ส่ง { force: true } เพื่อแทนที่ลายเซ็น',
        code: 'ALREADY_SIGNED',
        signatureFileId: contract.signature_image_id,
      });
    }

    let savedFile = null;
    try {
      savedFile = await storage.saveBase64({
        pool, category: 'contract_signature',
        dataUrl: signatureDataUrl, refId: String(id),
        uploadedBy: req.session.user.username,
        maxBytes: (req.features.photoUpload && req.features.photoUpload.maxBytes) || 1_500_000,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message || 'signature upload failed', code: 'UPLOAD_FAILED' });
    }

    // Resolve effective terms version: explicit body > feature default.
    let termsVersion = agreedTermsVersion;
    if (!termsVersion) {
      try {
        const flags = await features.load(pool);
        termsVersion = flags?.tenancyContract?.termsVersion || null;
      } catch { /* leave null */ }
    }

    try {
      const { rows } = await pool.query(
        `UPDATE contracts
            SET signature_image_id=$1, signed_at=NOW(), signature_url=$2,
                agreed_terms_at = COALESCE(agreed_terms_at, NOW()),
                agreed_terms_version = COALESCE($3, agreed_terms_version)
          WHERE id=$4 AND deleted_at IS NULL
          RETURNING id, contract_no, signed_at, agreed_terms_at, agreed_terms_version,
                    signature_image_id`,
        [savedFile.id, savedFile.url, termsVersion, id]
      );
      if (!rows.length) {
        // Rolling back the upload preserves storage cleanliness.
        await storage.remove(pool, savedFile.id).catch(() => {});
        return res.status(404).json({ error: 'contract not found' });
      }
      // Old signature replaced? remove the prior file so we don't accumulate.
      if (contract.signature_image_id && contract.signature_image_id !== savedFile.id) {
        await storage.remove(pool, contract.signature_image_id).catch(() => {});
      }
      audit(req, 'contract.sign', 'contract', String(id), {
        contractNo: contract.contract_no,
        signatureFileId: savedFile.id,
        replacedFileId: contract.signature_image_id,
        forced: force,
        termsVersion,
      });
      // Owner notify — same legal-trail rationale as identity capture: a
      // third party sees contract signature activity in real time.
      try {
        const flags = await features.load(pool);
        notifier.notifyOwner({ pool, features: flags }, {
          subject: `✍️ ลงนามสัญญา ${contract.contract_no}`,
          text: `admin ${req.session.user.username} บันทึกลายเซ็นสัญญา\n`
            + `contract id=${id} tenantId=${contract.tenant_id}\n`
            + (termsVersion ? `terms version: ${termsVersion}\n` : '')
            + (force ? '⚠️ ใช้ force=true แทนที่ลายเซ็นเดิม' : ''),
        }).catch(() => {});
      } catch { /* notify failure must not break request */ }
      res.json({ ok: true, contract: rows[0], signature: { id: savedFile.id, url: savedFile.url } });
    } catch (err) {
      // Pre-migration deploys without the new columns — try the legacy path.
      if (err.code === '42703') {
        await pool.query(
          `UPDATE contracts SET signature_url=$1, signed_at=NOW() WHERE id=$2`,
          [savedFile.url, id]
        );
        return res.json({ ok: true, contract: { id, signature_url: savedFile.url, signed_at: new Date().toISOString() } });
      }
      console.error('contract sign error:', err);
      // Don't leave the upload around if the link failed.
      await storage.remove(pool, savedFile.id).catch(() => {});
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    }
  });

// === v2: Contract templates (multi-template CRUD) ==========================
// Templates live in their own table now; the legacy single-row alias under
// system_settings['contract.terms_template'] kept working until the boot
// migration auto-imported it into a default row. Each template has:
//   - mode: 'default'|'append'|'override' — how clauses combine with built-in
//   - clauses: [{id?, title, body}] — admin's clauses (interpolated)
//   - sections: { showWitnesses, showEmergencyContact, showPropertyDetails,
//                 showFinancialTable, acknowledgmentText, headerNote } —
//     optional visibility / wording overrides for the renderer
//   - variables: { wifi_password, pet_policy, ... } — custom placeholders
//     that interpolate into clause bodies via {{var_name}}
//   - is_default: at most one row at a time (partial unique enforces)
//   - enabled: deactivate a template without deleting it
//
// Default clauses (12 standard Thai dorm rules) live in services/contractPdf.js
// as DEFAULT_CLAUSES — resolveClauses() composes them with each template.

// Validate + normalise a template payload from req.body. Throws on invalid
// input so the caller can return a 400 with a precise code.
function _validateTemplatePayload(b) {
  if (!b || typeof b !== 'object') {
    throw Object.assign(new Error('payload required'), { code: 'INVALID' });
  }
  const name = String(b.name || '').slice(0, 200).trim();
  if (!name) throw Object.assign(new Error('name required'), { code: 'NAME_REQUIRED' });
  const description = b.description ? String(b.description).slice(0, 1000) : null;
  const mode = ['default', 'append', 'override'].includes(b.mode) ? b.mode : 'default';
  const rawClauses = Array.isArray(b.clauses) ? b.clauses : [];
  if (rawClauses.length > 100) {
    throw Object.assign(new Error('จำกัดข้อบังคับสูงสุด 100 ข้อ'),
      { code: 'TOO_MANY_CLAUSES' });
  }
  const clauses = rawClauses.map((c, i) => {
    if (!c || typeof c !== 'object') {
      throw Object.assign(new Error(`ข้อ ${i + 1}: ต้องเป็น object`),
        { code: 'INVALID_CLAUSE' });
    }
    const title = String(c.title || '').slice(0, 200).trim();
    const body  = String(c.body  || '').slice(0, 4000).trim();
    if (!title) throw Object.assign(new Error(`ข้อ ${i + 1}: หัวข้อห้ามว่าง`),
      { code: 'INVALID_CLAUSE' });
    if (!body)  throw Object.assign(new Error(`ข้อ ${i + 1}: เนื้อหาห้ามว่าง`),
      { code: 'INVALID_CLAUSE' });
    return { id: c.id ? String(c.id).slice(0, 64) : null, title, body };
  });
  if (mode === 'override' && clauses.length === 0) {
    throw Object.assign(new Error('override mode ต้องมีข้อบังคับอย่างน้อย 1 ข้อ'),
      { code: 'OVERRIDE_NEEDS_CLAUSES' });
  }
  // Sections: shallow-validate known flags. Unknown keys are dropped so a
  // rogue admin UI can't smuggle arbitrary state into the PDF render.
  const sectionsIn = (b.sections && typeof b.sections === 'object') ? b.sections : {};
  const sections = {};
  for (const k of [
    'showWitnesses', 'showEmergencyContact', 'showPropertyDetails',
    'showFinancialTable', 'showLogo', 'showRoomAmenities',
  ]) {
    if (typeof sectionsIn[k] === 'boolean') sections[k] = sectionsIn[k];
  }
  if (typeof sectionsIn.acknowledgmentText === 'string') {
    sections.acknowledgmentText = sectionsIn.acknowledgmentText.slice(0, 1000);
  }
  if (typeof sectionsIn.headerNote === 'string') {
    sections.headerNote = sectionsIn.headerNote.slice(0, 500);
  }
  // Variables: string-only key/value, capped lengths so PDF text doesn't
  // overflow the page.
  const variablesIn = (b.variables && typeof b.variables === 'object') ? b.variables : {};
  const variables = Object.create(null);  // null prototype — no __proto__ surprise
  // Blocklist names that would cause renderer surprises when spread into
  // the interpolation context. The regex already excludes `-` etc, but
  // identifier-shaped names that collide with Object.prototype methods
  // would render as garbage. Keep the list short — only practical risks.
  const RESERVED_VAR_NAMES = new Set([
    '__proto__', 'constructor', 'prototype', 'hasOwnProperty',
    'toString', 'valueOf',
  ]);
  for (const [k, v] of Object.entries(variablesIn)) {
    if (typeof k !== 'string' || !/^[a-z_][a-z0-9_]{0,30}$/i.test(k)) continue;
    if (RESERVED_VAR_NAMES.has(k)) continue;
    if (typeof v !== 'string') continue;
    variables[k] = v.slice(0, 500);
  }
  return {
    name, description, mode, clauses, sections, variables,
    isDefault: b.isDefault === true,
    enabled: b.enabled !== false,
  };
}

// GET /api/admin/contract-templates
// Lists all non-deleted templates. Defaults to enabled-only; ?includeDisabled=1
// to also see disabled rows.
app.get('/api/admin/contract-templates', requireAuth, requireRole('owner', 'manager'),
  async (req, res) => {
    const includeDisabled = req.query.includeDisabled === '1';
    const where = ['deleted_at IS NULL'];
    if (!includeDisabled) where.push('enabled = TRUE');
    try {
      const { rows } = await pool.query(
        `SELECT id, name, description, mode, clauses, sections, variables,
                is_default, enabled, created_by, created_at, updated_at,
                jsonb_array_length(clauses) AS clause_count
           FROM contract_templates
          WHERE ${where.join(' AND ')}
          ORDER BY is_default DESC, enabled DESC, updated_at DESC`
      );
      const contractPdf = require('./services/contractPdf');
      res.json({
        ok: true,
        templates: rows,
        defaults: contractPdf.DEFAULT_CLAUSES,
      });
    } catch (err) {
      console.error('contract-templates list error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

// GET /api/admin/contract-templates/:id — single template + resolved preview.
app.get('/api/admin/contract-templates/:id', requireAuth, requireRole('owner', 'manager'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    try {
      const { rows } = await pool.query(
        `SELECT * FROM contract_templates WHERE id=$1 AND deleted_at IS NULL`,
        [id]
      );
      if (!rows.length) return res.status(404).json({ error: 'template not found' });
      const contractPdf = require('./services/contractPdf');
      res.json({
        ok: true,
        template: rows[0],
        defaults: contractPdf.DEFAULT_CLAUSES,
        // Preview the final clause list the renderer will produce.
        resolved: contractPdf.resolveClauses(rows[0]),
      });
    } catch (err) {
      console.error('contract-templates GET error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

// POST /api/admin/contract-templates — create a new template (owner only).
app.post('/api/admin/contract-templates', sameOrigin, csrfGuard, requireAuth, requireRole('owner'),
  async (req, res) => {
    let p;
    try { p = _validateTemplatePayload(req.body); }
    catch (err) { return res.status(400).json({ error: err.message, code: err.code }); }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // If this template is being set as default, unset any existing default
      // first so the partial unique index doesn't 23505 us.
      if (p.isDefault) {
        // Bump updated_at on the demoted row too so admin's "recently
        // changed" view reflects the demotion. Without this, the demote
        // looks invisible in the audit list.
        await client.query(
          `UPDATE contract_templates SET is_default=FALSE, updated_at=NOW()
            WHERE is_default=TRUE AND deleted_at IS NULL`
        );
      }
      const { rows } = await client.query(
        `INSERT INTO contract_templates
            (name, description, mode, clauses, sections, variables,
             is_default, enabled, created_by)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9)
         RETURNING *`,
        [p.name, p.description, p.mode,
         JSON.stringify(p.clauses), JSON.stringify(p.sections),
         JSON.stringify(p.variables), p.isDefault, p.enabled,
         req.session.user.username]
      );
      await client.query('COMMIT');
      audit(req, 'contract.template_create', 'contract_template', String(rows[0].id),
        { name: p.name, mode: p.mode, clauseCount: p.clauses.length, isDefault: p.isDefault });
      res.json({ ok: true, template: rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('contract-templates POST error:', err);
      res.status(500).json({ error: 'internal error' });
    } finally {
      client.release();
    }
  });

// PUT /api/admin/contract-templates/:id — update (owner only).
app.put('/api/admin/contract-templates/:id', sameOrigin, csrfGuard, requireAuth, requireRole('owner'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    let p;
    try { p = _validateTemplatePayload(req.body); }
    catch (err) { return res.status(400).json({ error: err.message, code: err.code }); }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Same default-flip handling as POST.
      if (p.isDefault) {
        await client.query(
          `UPDATE contract_templates SET is_default=FALSE
            WHERE is_default=TRUE AND deleted_at IS NULL AND id<>$1`,
          [id]
        );
      }
      const { rows } = await client.query(
        `UPDATE contract_templates SET
            name=$1, description=$2, mode=$3,
            clauses=$4::jsonb, sections=$5::jsonb, variables=$6::jsonb,
            is_default=$7, enabled=$8, updated_at=NOW()
          WHERE id=$9 AND deleted_at IS NULL
          RETURNING *`,
        [p.name, p.description, p.mode,
         JSON.stringify(p.clauses), JSON.stringify(p.sections),
         JSON.stringify(p.variables), p.isDefault, p.enabled, id]
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'template not found' });
      }
      await client.query('COMMIT');
      audit(req, 'contract.template_update', 'contract_template', String(id),
        { name: p.name, mode: p.mode, clauseCount: p.clauses.length, isDefault: p.isDefault });
      res.json({ ok: true, template: rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('contract-templates PUT error:', err);
      res.status(500).json({ error: 'internal error' });
    } finally {
      client.release();
    }
  });

// DELETE /api/admin/contract-templates/:id — soft delete (owner only).
// Refuses to delete the default template unless another row already has
// is_default=TRUE — preventing the "no default exists" footgun.
app.delete('/api/admin/contract-templates/:id', sameOrigin, csrfGuard, requireAuth, requireRole('owner'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    try {
      const t = await pool.query(
        `SELECT id, name, is_default FROM contract_templates
           WHERE id=$1 AND deleted_at IS NULL`,
        [id]
      );
      if (!t.rows.length) return res.status(404).json({ error: 'template not found' });
      if (t.rows[0].is_default) {
        // Refuse — admin must promote another template to default first.
        return res.status(409).json({
          error: 'ลบ template ที่เป็น default ไม่ได้ — โปรดตั้ง template อื่นเป็น default ก่อน',
          code: 'CANNOT_DELETE_DEFAULT',
        });
      }
      // Soft delete + null any contracts.template_id pointing here so
      // re-prints fall back to whatever the current default is.
      await pool.query(
        `UPDATE contract_templates SET deleted_at=NOW(), enabled=FALSE WHERE id=$1`,
        [id]
      );
      await pool.query(
        `UPDATE contracts SET template_id=NULL WHERE template_id=$1`,
        [id]
      ).catch((err) => {
        if (err.code !== '42703') throw err;
      });
      audit(req, 'contract.template_delete', 'contract_template', String(id),
        { name: t.rows[0].name });
      res.json({ ok: true, deletedId: id });
    } catch (err) {
      console.error('contract-templates DELETE error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

// POST /api/admin/contract-templates/:id/set-default — atomic default flip.
app.post('/api/admin/contract-templates/:id/set-default',
  sameOrigin, csrfGuard, requireAuth, requireRole('owner'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Verify the target exists + is enabled (can't promote a disabled row).
      const t = await client.query(
        `SELECT id, name, enabled FROM contract_templates
           WHERE id=$1 AND deleted_at IS NULL`,
        [id]
      );
      if (!t.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'template not found' });
      }
      if (!t.rows[0].enabled) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'template ถูก disable อยู่ — เปิดใช้งานก่อนตั้งเป็น default',
          code: 'TEMPLATE_DISABLED',
        });
      }
      await client.query(
        `UPDATE contract_templates SET is_default=FALSE, updated_at=NOW()
          WHERE is_default=TRUE AND deleted_at IS NULL`
      );
      await client.query(
        `UPDATE contract_templates SET is_default=TRUE, updated_at=NOW() WHERE id=$1`,
        [id]
      );
      await client.query('COMMIT');
      audit(req, 'contract.template_set_default', 'contract_template', String(id),
        { name: t.rows[0].name });
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('contract-templates set-default error:', err);
      res.status(500).json({ error: 'internal error' });
    } finally {
      client.release();
    }
  });

// POST /api/contracts/:id/template — assign a specific template to a
// contract. The PDF endpoint reads contracts.template_id at print time;
// when null, the current default template is used.
app.post('/api/contracts/:id/template', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    const tid = req.body && req.body.templateId;
    const templateId = tid == null ? null : Number(tid);
    if (templateId != null && (!Number.isInteger(templateId) || templateId < 1)) {
      return res.status(400).json({ error: 'invalid templateId' });
    }
    try {
      // Verify the template exists (when set).
      if (templateId != null) {
        const t = await pool.query(
          `SELECT id FROM contract_templates WHERE id=$1 AND deleted_at IS NULL`,
          [templateId]
        );
        if (!t.rows.length) return res.status(404).json({ error: 'template not found' });
      }
      const { rows } = await pool.query(
        `UPDATE contracts SET template_id=$1, updated_at=NOW()
          WHERE id=$2 AND deleted_at IS NULL
          RETURNING id, contract_no, template_id`,
        [templateId, id]
      );
      if (!rows.length) return res.status(404).json({ error: 'contract not found' });
      audit(req, 'contract.template_assign', 'contract', String(id), { templateId });
      res.json({ ok: true, contract: rows[0] });
    } catch (err) {
      // Pre-migration: contracts.template_id might not exist yet.
      if (err.code === '42703') {
        return res.status(503).json({
          error: 'feature pending migration — please redeploy',
          code: 'PENDING_MIGRATION',
        });
      }
      console.error('contract template assign error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

// === Tenant self-fill invitations ==========================================
// Admin generates a tokenised URL for the tenant to fill on their own
// device (no login). Tenant submits → admin reviews → approves (which
// applies the draft to tenants/contracts and LOCKS the contract). Token
// lives ~7 days by default; expired/approved/rejected/revoked links 404.
//
// Rate limits: public endpoints get the same per-IP limiter as the booking
// page; admin endpoints inherit the standard requireAuth + csrfGuard.
const rateLimitContractFill = makeIpLimiter({
  windowMs: 60_000, max: 30,
  message: 'too many requests to the contract fill endpoint',
});

// POST /api/contracts/:id/invite-tenant
// Admin clicks "📨 ส่งให้ผู้เช่ากรอก" → backend generates a fresh token,
// revokes any prior active invitation for the same contract (so admin
// can't accidentally have two valid links floating around), returns the
// tenant URL exactly ONCE in the response.
// POST /api/contracts/quick-invite
// One-shot: create tenant (if new) + create contract draft + create
// invitation. The "draft" path skips the identity guards from checkin
// because the whole point is to delegate gathering identity data to
// the tenant via the invite link. Returns the URL admin sends.
//
// This is the entry point admin uses when they want the tenant to fill
// the contract themselves from scratch — no need to manually upload ID
// photos, address, emergency contact first.
app.post('/api/contracts/quick-invite', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
  async (req, res) => {
    const b = req.body || {};
    // Required fields
    const tenantName = String(b.tenantName || '').slice(0, 200).trim();
    const rawPhone = String(b.tenantPhone || '').slice(0, 32).trim();
    const tenantPhone = rawPhone.replace(/[\s-]/g, '');
    const roomId = String(b.roomId || '').slice(0, 32).trim();
    const monthlyRent = Number(b.monthlyRent);
    const deposit = Number(b.deposit) || 0;
    const moveInDate = String(b.moveInDate || '').slice(0, 16).trim();
    if (!tenantName) return res.status(400).json({ error: 'tenantName required', code: 'NAME_REQUIRED' });
    if (!tenantPhone || !/^[\d+]{8,20}$/.test(tenantPhone)) {
      return res.status(400).json({ error: 'เบอร์โทรไม่ถูกต้อง', code: 'INVALID_PHONE' });
    }
    if (!roomId) return res.status(400).json({ error: 'roomId required', code: 'ROOM_REQUIRED' });
    if (!Number.isFinite(monthlyRent) || monthlyRent <= 0) {
      return res.status(400).json({ error: 'monthlyRent ต้อง > 0', code: 'INVALID_RENT' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(moveInDate)) {
      return res.status(400).json({ error: 'moveInDate ต้องเป็น YYYY-MM-DD', code: 'INVALID_DATE' });
    }
    // Optional
    const tenantEmail = b.tenantEmail ? String(b.tenantEmail).slice(0, 200).trim() : null;
    const termMonths = b.termMonths != null ? Number(b.termMonths) : null;
    const discountPct = b.discountPct != null ? Number(b.discountPct) : 0;
    const expiresInHours = Number(b.expiresInHours) || 168;
    if (termMonths != null && (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 60)) {
      return res.status(400).json({ error: 'termMonths must be 1-60', code: 'INVALID_TERM' });
    }
    if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 50) {
      return res.status(400).json({ error: 'discountPct must be 0-50', code: 'INVALID_DISCOUNT' });
    }

    // Validation parity with checkin (which has these guards under
    // tenancyContract feature flags). Without these checks, admin could
    // pick "2030-05-15" as moveInDate or 30,000 baht deposit on a 5,000
    // baht/month room and the contract would go through silently.
    // Bypass via { force: true } — same convention as checkin.
    const isForced = b.force === true;
    let flags = {};
    try { flags = await features.load(pool); }
    catch { /* keep defaults */ }
    const tenancy = flags.tenancyContract || {};

    // (1) moveInDate window — catches "typed wrong year" errors.
    if (!isForced) {
      const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
      const target = new Date(moveInDate + 'T00:00:00Z');
      if (Number.isFinite(target.getTime())) {
        const diffDays = Math.round((target - today) / 86_400_000);
        const past = Number(tenancy.moveInPastDays ?? 30);
        const future = Number(tenancy.moveInFutureDays ?? 90);
        if (diffDays < -Math.abs(past) || diffDays > Math.abs(future)) {
          return res.status(400).json({
            error: `วันเข้าพัก (${moveInDate}) อยู่นอกช่วงที่ตั้งไว้ (อดีต ≤ ${past} วัน / อนาคต ≤ ${future} วัน)`,
            code: 'MOVE_IN_OUT_OF_WINDOW',
            today: today.toISOString().slice(0, 10), requested: moveInDate, diffDays,
            hint: 'ตรวจสอบอีกครั้งหรือส่ง { force: true } ถ้ายืนยัน',
          });
        }
      }
    }

    // (2) Deposit cap — catches "typed extra zero" errors.
    if (!isForced) {
      const depositMaxMonths = Number(tenancy.depositMaxMonths ?? 3);
      const maxDeposit = depositMaxMonths * monthlyRent;
      if (deposit > maxDeposit) {
        return res.status(400).json({
          error: `เงินมัดจำ (${deposit}) มากกว่า ${depositMaxMonths} เท่าของค่าเช่ารายเดือน (สูงสุด ${maxDeposit})`,
          code: 'DEPOSIT_TOO_LARGE',
          monthlyRent, deposit, maxDeposit, depositMaxMonths,
          hint: 'ตรวจค่าอีกครั้งหรือส่ง { force: true } ถ้าเป็น deposit พิเศษ',
        });
      }
    }

    // Compute end_date if termMonths supplied (clamp last-day-of-month to
    // avoid Date.setMonth rollover bug). Same logic as tenant-ops checkin.
    let endDate = null;
    if (termMonths) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(moveInDate);
      if (m) {
        const sy = Number(m[1]); const sm = Number(m[2]); const sd = Number(m[3]);
        const totalMonths = (sy * 12 + (sm - 1)) + termMonths;
        const ey = Math.floor(totalMonths / 12);
        const em = (totalMonths % 12) + 1;
        const lastDom = new Date(Date.UTC(ey, em, 0)).getUTCDate();
        const ed = Math.min(sd, lastDom);
        endDate = `${ey}-${String(em).padStart(2, '0')}-${String(ed).padStart(2, '0')}`;
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Find existing tenant by phone — most-recent active match wins.
      // Active tenants ranked first so we re-use rather than creating
      // another row for the same person across multiple contracts.
      let tenantId = null;
      const tQ = await client.query(
        `SELECT id, full_name, status FROM tenants
           WHERE phone=$1 AND deleted_at IS NULL
           ORDER BY (status='active') DESC, updated_at DESC LIMIT 1`,
        [tenantPhone]
      );
      if (tQ.rows.length) {
        tenantId = tQ.rows[0].id;
        // Blacklist guard — refuse silent reactivation of blacklisted
        // tenants. Admin can still force the override but it's
        // audit-logged + owner-notified so a hijacked admin session
        // can't quietly re-onboard a banned tenant.
        if (tQ.rows[0].status === 'blacklist' && !isForced) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `ผู้เช่ารายนี้อยู่ในรายชื่อ blacklist — ใช้ { force: true } ถ้ายืนยัน`,
            code: 'TENANT_BLACKLISTED',
            conflict: { id: tenantId, fullName: tQ.rows[0].full_name },
            hint: 'ตรวจประวัติที่ /admin#tenants ก่อนตัดสินใจ',
          });
        }
        // If the existing tenant is moved_out, reactivate to 'active'
        // (returning tenant — common case). Blacklist override paths
        // also reach here when force=true is set; the audit log captures
        // the override above.
        if (tQ.rows[0].status !== 'active') {
          await client.query(
            `UPDATE tenants SET status='active', updated_at=NOW() WHERE id=$1`,
            [tenantId]
          );
        }
      } else {
        // Create a fresh tenant row with just the basics — the rest
        // (address, emergency contact, citizen ID + photos) will arrive
        // when the tenant fills the invitation form.
        const ins = await client.query(
          `INSERT INTO tenants
              (full_name, phone, email, status, locale)
           VALUES ($1, $2, $3, 'active', 'th') RETURNING id`,
          [tenantName, tenantPhone, tenantEmail]
        );
        tenantId = ins.rows[0].id;
      }

      // 2. Create the contract row. We skip the heavy checkin guards
      // (identity images, address, emergency contact) — the tenant fills
      // those via the invitation. Status='active' so the contracts page
      // shows it; locked_at stays NULL until admin approves the
      // tenant's submission.
      const contractNo = `C-${new Date().getFullYear()}-${String(tenantId).padStart(4, '0')}-`
                       + Math.random().toString(36).slice(2, 6).toUpperCase();
      const cIns = await client.query(
        `INSERT INTO contracts (contract_no, tenant_id, room_id, start_date, end_date,
                                monthly_rent, deposit, status, term_months, discount_pct)
         VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, 'active', $8, $9)
         RETURNING id, contract_no, tenant_id, room_id, start_date, end_date,
                   monthly_rent, deposit, status`,
        [contractNo, tenantId, roomId, moveInDate, endDate,
         monthlyRent, deposit, termMonths || null, discountPct]
      );
      const contract = cIns.rows[0];

      // 2b. Optional booking carry-over. When admin sends an invite from
      // an already-approved booking, the public form may have collected
      // a citizen-ID front photo. Re-target that file_uploads row onto
      // the new tenant so they don't have to re-upload via the link.
      // Also link the booking row to the freshly-created tenant +
      // contract for audit traceability.
      if (b.bookingId) {
        try {
          const bookingId = String(b.bookingId).slice(0, 64);
          let frontFileId = null;
          try {
            const bk = await client.query(
              `SELECT citizen_id_image_front_id FROM bookings WHERE external_id=$1 LIMIT 1`,
              [bookingId]
            );
            frontFileId = bk.rows[0] && bk.rows[0].citizen_id_image_front_id;
          } catch (err) {
            // Pre-migration deploy without the column — skip silently.
            if (err.code !== '42703' && err.code !== '42P01') throw err;
          }
          if (frontFileId) {
            // Verify the file is the expected citizen-ID image with the
            // public-booking placeholder ref_id before retargeting.
            const verify = await client.query(
              `SELECT id FROM file_uploads
                 WHERE id=$1 AND category='citizen_id_image'
                   AND (ref_id='public-booking-pending' OR ref_id IS NULL)
                 LIMIT 1`,
              [frontFileId]
            );
            if (verify.rows.length) {
              await client.query(
                `UPDATE tenants SET citizen_id_image_front_id=$1, updated_at=NOW() WHERE id=$2`,
                [frontFileId, tenantId]
              );
              await client.query(
                `UPDATE file_uploads SET ref_id=$1 WHERE id=$2 AND category='citizen_id_image'`,
                [String(tenantId), frontFileId]
              );
            }
          }
          // Mark booking as 'completed' so admin sees it isn't a pending
          // backlog item anymore. Best-effort: pre-migration deploys
          // without the column just skip.
          try {
            await client.query(
              `UPDATE bookings SET status='completed', updated_at=NOW() WHERE external_id=$1`,
              [bookingId]
            );
          } catch (err) {
            if (err.code !== '42703' && err.code !== '42P01') throw err;
          }
        } catch (err) {
          console.warn('[quick-invite] booking carry-over skipped:', err.message);
        }
      }

      // 3. Generate invitation token. We inline the helper's logic
      // here because we're already inside a transaction (the helper
      // would start a nested BEGIN which crashes on pg). Brand-new
      // contract means no prior invitations exist — partial unique
      // index is satisfied without the revoke step.
      const contractInvitation = require('./services/contractInvitation');
      const tk = contractInvitation.generateToken();
      const expiresAt = new Date(Date.now() + Math.max(1, Math.min(720, expiresInHours)) * 3600_000);
      const invIns = await client.query(
        `INSERT INTO contract_invitations
            (contract_id, tenant_id, token_hash, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [contract.id, tenantId, tk.hash, expiresAt, req.session.user.username]
      );
      const invitation = {
        id: invIns.rows[0].id,
        token: tk.token,
        expiresAt,
      };
      await client.query('COMMIT');

      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
      const url = `${proto}://${host}/contract/fill/${invitation.token}`;

      audit(req, 'contract.quick_invite', 'contract', String(contract.id),
        { contractNo: contract.contract_no, tenantId, invitationId: invitation.id });

      res.json({
        ok: true,
        tenant: { id: tenantId, fullName: tenantName, phone: tenantPhone },
        contract,
        invitation: {
          id: invitation.id,
          token: invitation.token,
          url,
          expiresAt: invitation.expiresAt,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('quick-invite error:', err);
      // Friendlier 409 on common race / constraint errors.
      if (err.code === '23505') {
        return res.status(409).json({ error: 'duplicate constraint', code: 'DUPLICATE' });
      }
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    } finally {
      client.release();
    }
  });

app.post('/api/contracts/:id/invite-tenant',
  sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    const expiresInHours = req.body && Number(req.body.expiresInHours);
    try {
      // Verify the contract exists + is unlocked. Locked contracts can't
      // accept fresh tenant input — admin must unlock first (a deliberate
      // step) before re-soliciting tenant data.
      const cQ = await pool.query(
        `SELECT id, contract_no, tenant_id, locked_at FROM contracts
           WHERE id=$1 AND deleted_at IS NULL`,
        [id]
      );
      if (!cQ.rows.length) return res.status(404).json({ error: 'contract not found' });
      if (cQ.rows[0].locked_at) {
        return res.status(409).json({
          error: 'สัญญาถูก lock แล้ว — ส่งลิงก์ไม่ได้',
          code: 'CONTRACT_LOCKED',
          lockedAt: cQ.rows[0].locked_at,
        });
      }
      const contractInvitation = require('./services/contractInvitation');
      const inv = await contractInvitation.createInvitation(pool, {
        contractId: id,
        tenantId: cQ.rows[0].tenant_id,
        expiresInHours,
        createdBy: req.session.user.username,
      });
      // Construct the absolute URL so admin can copy/paste directly. Use
      // the request's host so the link works behind a reverse proxy.
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
      const url = `${proto}://${host}/contract/fill/${inv.token}`;
      audit(req, 'contract.invite_tenant', 'contract', String(id),
        { invitationId: inv.id, expiresAt: inv.expiresAt });
      res.json({
        ok: true,
        invitation: {
          id: inv.id,
          token: inv.token,           // ONLY exposed here — never again
          url,
          expiresAt: inv.expiresAt,
        },
      });
    } catch (err) {
      console.error('invite-tenant error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

// GET /api/admin/contract-invitations — list (defaults to active queue)
app.get('/api/admin/contract-invitations',
  requireAuth, requireRole('owner', 'manager'),
  async (req, res) => {
    const status = req.query.status;
    const where = [];
    const params = [];
    if (status === 'active') {
      where.push(`i.status IN ('pending','submitted')`);
    } else if (status === 'submitted' || status === 'approved'
               || status === 'rejected' || status === 'revoked'
               || status === 'expired' || status === 'pending') {
      params.push(status);
      where.push(`i.status=$${params.length}`);
    }
    try {
      const { rows } = await pool.query(
        `SELECT i.id, i.contract_id, i.tenant_id, i.status,
                i.draft, i.submitted_at, i.approved_at, i.approved_by,
                i.rejected_at, i.rejected_by, i.rejection_reason,
                i.expires_at, i.created_by, i.created_at, i.updated_at,
                c.contract_no, c.room_id,
                t.full_name AS tenant_name, t.phone AS tenant_phone
           FROM contract_invitations i
           LEFT JOIN contracts c ON c.id = i.contract_id
           LEFT JOIN tenants   t ON t.id = i.tenant_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY
            CASE i.status WHEN 'submitted' THEN 0 WHEN 'pending' THEN 1
                          WHEN 'approved' THEN 2 ELSE 3 END,
            i.updated_at DESC
          LIMIT 200`,
        params
      );
      res.json({ ok: true, invitations: rows });
    } catch (err) {
      console.error('invitations list error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

// GET /api/admin/contract-invitations/:id
app.get('/api/admin/contract-invitations/:id',
  requireAuth, requireRole('owner', 'manager'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    try {
      const { rows } = await pool.query(
        `SELECT i.*, c.contract_no, c.room_id, c.monthly_rent, c.deposit,
                t.full_name AS tenant_name, t.phone AS tenant_phone, t.email AS tenant_email,
                ff.url AS draft_front_url, bf.url AS draft_back_url, sf.url AS draft_signature_url
           FROM contract_invitations i
           LEFT JOIN contracts c ON c.id = i.contract_id
           LEFT JOIN tenants   t ON t.id = i.tenant_id
           LEFT JOIN file_uploads ff ON ff.id = (i.draft->>'citizenIdImageFrontId')::bigint
           LEFT JOIN file_uploads bf ON bf.id = (i.draft->>'citizenIdImageBackId')::bigint
           LEFT JOIN file_uploads sf ON sf.id = (i.draft->>'signatureFileId')::bigint
          WHERE i.id=$1`,
        [id]
      );
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true, invitation: rows[0] });
    } catch (err) {
      console.error('invitation get error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

// POST /api/admin/contract-invitations/:id/approve
// Admin reviews tenant's submitted draft + clicks approve. Server applies
// the draft to tenants + contracts in a single transaction, marks the
// invitation 'approved', and locks the contract (subsequent edits forbidden).
app.post('/api/admin/contract-invitations/:id/approve',
  sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const iQ = await client.query(
        `SELECT * FROM contract_invitations WHERE id=$1 FOR UPDATE`,
        [id]
      );
      if (!iQ.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'invitation not found' });
      }
      const inv = iQ.rows[0];
      if (inv.status !== 'submitted') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `อนุมัติได้เฉพาะ invitation สถานะ submitted (ตอนนี้: ${inv.status})`,
          code: 'BAD_STATUS',
          currentStatus: inv.status,
        });
      }
      const draft = inv.draft || {};

      // Apply draft → tenants row (when one is linked).
      if (inv.tenant_id) {
        const sets = [];
        const params = [];
        let i = 1;
        const set = (col, v) => { sets.push(`${col}=$${i++}`); params.push(v); };
        if (draft.address)               set('address', String(draft.address).slice(0, 500));
        if (draft.emergencyContactName)  set('emergency_contact_name', String(draft.emergencyContactName).slice(0, 200));
        if (draft.emergencyContactPhone) set('emergency_contact_phone', String(draft.emergencyContactPhone).slice(0, 32));
        if (draft.emergencyContactRelation) set('emergency_contact_relation', String(draft.emergencyContactRelation).slice(0, 64));
        if (draft.citizenIdImageFrontId) set('citizen_id_image_front_id', Number(draft.citizenIdImageFrontId));
        if (draft.citizenIdImageBackId)  set('citizen_id_image_back_id', Number(draft.citizenIdImageBackId));
        // Citizen ID — re-validate checksum here (tenant might have edited
        // a prior valid value to garbage). On checksum failure we still
        // accept it but with hash=NULL (legacy data path); admin can fix
        // later via tenant edit.
        if (draft.citizenId) {
          const thaiId = require('./services/thaiId');
          const norm = thaiId.normalize(draft.citizenId);
          if (norm) {
            const flags = await features.load(pool);
            const enc = (flags.citizenIdEncryption && flags.citizenIdEncryption.enabled)
              ? cryptoSvc.encryptString(norm) : norm;
            set('citizen_id_encrypted', enc);
            set('citizen_id_tail', norm.slice(-4));
            set('citizen_id_hash', thaiId.validateChecksum(norm)
              ? thaiId.hashForLookup(norm) : null);
          }
        }
        if (sets.length) {
          sets.push('updated_at = NOW()');
          params.push(inv.tenant_id);
          await client.query(
            `UPDATE tenants SET ${sets.join(', ')} WHERE id=$${i}`,
            params
          ).catch((err) => {
            // Dedup race: another tenant already has this hash. Treat as
            // a clean rejection — admin must reconcile manually.
            if (err.code === '23505' && err.constraint === 'uq_tenants_citizen_id_hash_active') {
              throw Object.assign(new Error('CITIZEN_ID_DUPLICATE'),
                { http: 409, code: 'CITIZEN_ID_DUPLICATE' });
            }
            throw err;
          });
        }
      }

      // Apply signature → contracts row + lock the contract.
      const updateSets = ['updated_at=NOW()', 'locked_at=NOW()', 'locked_by=$2'];
      const updateParams = [inv.contract_id, req.session.user.username];
      let pi = 3;
      if (draft.signatureFileId) {
        updateSets.push(`signature_image_id=$${pi++}`,
                        `signed_at = COALESCE(signed_at, NOW())`);
        updateParams.push(Number(draft.signatureFileId));
      }
      if (draft.agreedTermsVersion) {
        updateSets.push(`agreed_terms_version=$${pi++}`,
                        `agreed_terms_at = COALESCE(agreed_terms_at, NOW())`);
        updateParams.push(String(draft.agreedTermsVersion).slice(0, 64));
      }
      // Pull contract.room_id back so we can sync room state below.
      const cUpdate = await client.query(
        `UPDATE contracts SET ${updateSets.join(', ')}
          WHERE id=$1 AND deleted_at IS NULL
          RETURNING id, contract_no, room_id, tenant_id, monthly_rent, deposit, start_date`,
        updateParams
      );
      const contract = cUpdate.rows[0];

      // ============== INTEGRATION: link tenant ↔ room ==============
      // Without this block the contract is approved but the room shows
      // 'vacant' and the tenant has no current_room_id → bills don't
      // auto-generate, booking-approve double-assigns, /api/rooms?
      // status=vacant lies. The block below mirrors what tenant-ops's
      // checkin does on a successful flow, but applied at approve time.
      let roomConflict = null;
      if (inv.tenant_id && contract.room_id) {
        // Lock the tenant + read current_room_id so we can detect a
        // "moving rooms" scenario (tenant was in 102; new contract is
        // for 201 — the old room must be freed first).
        const tQ = await client.query(
          `SELECT id, current_room_id FROM tenants
             WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
          [inv.tenant_id]
        );
        const oldRoomId = tQ.rows.length ? tQ.rows[0].current_room_id : null;

        // Refuse if the target room is already occupied by a DIFFERENT
        // active tenant. Two parallel approvals on the same room would
        // otherwise both succeed with last-write-wins on the room blob.
        const occupants = await client.query(
          `SELECT id, full_name FROM tenants
             WHERE current_room_id=$1 AND status='active' AND deleted_at IS NULL
               AND id <> $2 LIMIT 1
             FOR UPDATE`,
          [contract.room_id, inv.tenant_id]
        );
        if (occupants.rows.length) {
          // Don't throw — return a clean 409 outside the catch path.
          roomConflict = occupants.rows[0];
        } else {
          // Set tenant → room link. Active status is set here for
          // moved_out tenants who are reactivating via this contract.
          await client.query(
            `UPDATE tenants
                SET current_room_id=$1, status='active', updated_at=NOW()
              WHERE id=$2`,
            [contract.room_id, inv.tenant_id]
          );

          // Free the OLD room (if tenant was in a different room).
          // Status → 'vacant' AND tenant → removed so notifications can't
          // leak to the previous occupant. 'AND value ? $1' is the
          // intentional guard — if the room isn't in the blob, there's
          // nothing to free, no-op is correct.
          if (oldRoomId && oldRoomId !== contract.room_id) {
            await client.query(
              `UPDATE app_data
                  SET value = jsonb_set(
                                value,
                                ARRAY[$1::text],
                                (value->$1 - 'tenant') || jsonb_build_object('status', 'vacant')
                              ),
                      updated_at=NOW()
                WHERE key='baankarn_rooms_v1' AND value ? $1`,
              [oldRoomId]
            );
            await client.query(
              `UPDATE rooms_v2 SET status='vacant', updated_at=NOW()
                 WHERE room_code=$1 AND deleted_at IS NULL`,
              [oldRoomId]
            ).catch((err) => {
              if (err.code !== '42P01') throw err;  // table missing on legacy
            });
          }

          // Occupy the NEW room — both data sources so old + new admin
          // pages see the same state. Same dual-write pattern checkin uses.
          //
          // Critical: also write the tenant info INTO the room blob.
          // scheduler.tickBillGen iterates the blob and skips rooms where
          // !room.tenant — so without this nested jsonb_set, auto-billing
          // never fires for tenants approved via the invitation flow.
          // Pull the tenant's display info from the FOR-UPDATE-locked
          // row above to avoid a second SELECT round-trip.
          const tenantInfoQ = await client.query(
            `SELECT full_name, phone, email FROM tenants WHERE id=$1`,
            [inv.tenant_id]
          );
          const tInfo = tenantInfoQ.rows[0] || {};
          const blobTenant = {
            name: tInfo.full_name || '',
            phone: tInfo.phone || '',
            email: tInfo.email || '',
            since: (contract.start_date instanceof Date)
              ? contract.start_date.toISOString().slice(0, 10)
              : (typeof contract.start_date === 'string' ? contract.start_date.slice(0, 10) : null),
          };
          // UPSERT pattern: when the room exists ONLY in rooms_v2 (created
          // via POST /api/rooms), the JSONB blob doesn't have an entry yet.
          // The old `WHERE value ? $1` clause made the UPDATE a no-op for
          // those rooms — scheduler.tickBillGen would then skip the room
          // because the blob has no `room.tenant` to match. Now we ensure
          // the blob row itself exists, then INSERT-or-merge the room key
          // with both status='occupied' and the tenant info in one step.
          await client.query(
            `INSERT INTO app_data (key, value, updated_by)
             VALUES ('baankarn_rooms_v1', '{}'::jsonb, 'system')
             ON CONFLICT (key) DO NOTHING`
          );
          await client.query(
            `UPDATE app_data
                SET value = value || jsonb_build_object(
                              $1::text,
                              COALESCE(value->$1, '{}'::jsonb)
                                || jsonb_build_object(
                                     'id', $1,
                                     'status', 'occupied',
                                     'tenant', $2::jsonb
                                   )
                            ),
                    updated_at=NOW()
              WHERE key='baankarn_rooms_v1'`,
            [contract.room_id, JSON.stringify(blobTenant)]
          );
          await client.query(
            `UPDATE rooms_v2 SET status='occupied', updated_at=NOW()
               WHERE room_code=$1 AND deleted_at IS NULL`,
            [contract.room_id]
          ).catch((err) => {
            if (err.code !== '42P01') throw err;
          });
        }
      }

      if (roomConflict) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `ห้อง ${contract.room_id} มีผู้เช่ารายอื่นอยู่แล้ว `
               + `(${roomConflict.full_name}) — ให้ check-out คนก่อนค่อยอนุมัติ`,
          code: 'ROOM_OCCUPIED',
          occupant: roomConflict,
        });
      }

      await client.query(
        `UPDATE contract_invitations
            SET status='approved', approved_at=NOW(), approved_by=$2, updated_at=NOW()
          WHERE id=$1`,
        [id, req.session.user.username]
      );
      await client.query('COMMIT');
      audit(req, 'contract.invitation_approve', 'contract', String(inv.contract_id),
        { invitationId: id, draftKeys: Object.keys(draft),
          roomId: contract.room_id, tenantId: inv.tenant_id });

      // Owner notify with full context — admin can act immediately rather
      // than going hunting through 3 pages to see what was approved.
      try {
        const flags = await features.load(pool);
        const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
        const lines = [
          `admin ${req.session.user.username} อนุมัติสัญญาที่ผู้เช่ากรอกเอง`,
          `เลขที่: ${contract.contract_no || '-'}`,
          `ห้อง: ${contract.room_id || '-'}`,
          contract.monthly_rent
            ? `ค่าเช่า: ฿${Number(contract.monthly_rent).toLocaleString('th-TH', { minimumFractionDigits: 2 })}/เดือน`
            : null,
          `🔒 สัญญาถูก lock + ห้องเปลี่ยนเป็น occupied`,
          ``,
          `📄 ดู PDF: ${proto}://${host}/api/contracts/${contract.id}/pdf`,
        ].filter(Boolean);
        notifier.notifyOwner({ pool, features: flags }, {
          subject: `✅ อนุมัติสัญญา ${contract.contract_no || ''} — ห้อง ${contract.room_id || ''}`,
          text: lines.join('\n'),
        }).catch(() => {});

        // Tenant notify — closes the loop on the user's complaint that
        // tenant never gets the signed PDF after approval. The link goes
        // to the public PDF endpoint — but PDF requires admin auth, so
        // the message guides the tenant to ask admin if they need a copy.
        // (A future enhancement: a public token-based PDF download for
        // the signed contract; out of scope for this fix.)
        if (inv.tenant_id) {
          try {
            const tNotify = await pool.query(
              `SELECT id, full_name, phone, email, line_user_id, line_oa_id, status
                 FROM tenants WHERE id=$1 AND deleted_at IS NULL`,
              [inv.tenant_id]
            );
            if (tNotify.rows.length) {
              notifier.notifyTenant({ pool, features: flags }, tNotify.rows[0], {
                subject: '✅ สัญญาเช่าได้รับการอนุมัติแล้ว',
                text: [
                  `เรียน คุณ${tNotify.rows[0].full_name || ''}`,
                  ``,
                  `🎉 สัญญาเช่าห้อง ${contract.room_id || '-'} ของคุณได้รับการอนุมัติแล้ว`,
                  ``,
                  `เลขที่สัญญา: ${contract.contract_no || '-'}`,
                  `วันเริ่มสัญญา: ${(contract.start_date instanceof Date)
                    ? contract.start_date.toISOString().slice(0, 10)
                    : (typeof contract.start_date === 'string' ? contract.start_date.slice(0, 10) : '-')}`,
                  ``,
                  `📋 ขั้นตอนต่อไป:`,
                  `   • เก็บสำเนาสัญญา — ติดต่อสำนักงานเพื่อรับ PDF`,
                  `   • ตั้ง PIN เข้าพอร์ทัลผู้เช่าที่ /tenant`,
                  `   • บิลรอบแรกจะออกอัตโนมัติตามรอบเดือน`,
                ].join('\n'),
              }).catch((err) => {
                console.warn('[approve] tenant notify failed:', err.message);
              });
            }
          } catch { /* notify failures don't break the response */ }
        }
      } catch { /* notify failures don't break the response */ }
      res.json({
        ok: true,
        invitationId: id,
        contractId: inv.contract_id,
        contract,
        locked: true,
        // Surface the integration so admin UI can show "ดู PDF" / "สร้างบิลแรก"
        // CTAs without round-tripping back to the server.
        nextActions: {
          pdfUrl: `/api/contracts/${contract.id}/pdf`,
          billingUrl: `/admin#billing`,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.http) return res.status(err.http).json({ error: err.message, code: err.code });
      console.error('invitation approve error:', err);
      res.status(500).json({ error: 'internal error' });
    } finally {
      client.release();
    }
  });

// POST /api/admin/contract-invitations/:id/reject
// Send the submission back to the tenant with a reason. Status flips back
// to 'pending' so the tenant can edit + resubmit.
app.post('/api/admin/contract-invitations/:id/reject',
  sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    const reason = String((req.body && req.body.reason) || '').slice(0, 500);
    if (!reason) return res.status(400).json({ error: 'reason required', code: 'REASON_REQUIRED' });
    try {
      const { rows } = await pool.query(
        `UPDATE contract_invitations
            SET status='pending', rejected_at=NOW(), rejected_by=$2,
                rejection_reason=$3, updated_at=NOW()
          WHERE id=$1 AND status='submitted'
          RETURNING id, contract_id`,
        [id, req.session.user.username, reason]
      );
      if (!rows.length) return res.status(409).json({
        error: 'reject ได้เฉพาะ invitation สถานะ submitted', code: 'BAD_STATUS',
      });
      audit(req, 'contract.invitation_reject', 'contract', String(rows[0].contract_id),
        { invitationId: id, reason });
      res.json({ ok: true, invitationId: id });
    } catch (err) {
      console.error('invitation reject error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

// POST /api/admin/contract-invitations/:id/revoke — kill the link
app.post('/api/admin/contract-invitations/:id/revoke',
  sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    try {
      const { rows } = await pool.query(
        `UPDATE contract_invitations
            SET status='revoked', revoked_at=NOW(), revoked_by=$2, updated_at=NOW()
          WHERE id=$1 AND status IN ('pending','submitted')
          RETURNING id, contract_id`,
        [id, req.session.user.username]
      );
      if (!rows.length) return res.status(409).json({
        error: 'revoke ได้เฉพาะ invitation ที่ยังไม่ปิด', code: 'BAD_STATUS',
      });
      audit(req, 'contract.invitation_revoke', 'contract', String(rows[0].contract_id),
        { invitationId: id });
      res.json({ ok: true, invitationId: id });
    } catch (err) {
      console.error('invitation revoke error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

// === Public endpoints (no auth, token-gated) ==============================
// All wrapped with a per-IP rate limiter — token guess is not trivial
// (32-byte random) but limiting requests prevents a noisy abuser from
// hammering the server cycling through guesses.

// GET /api/contract-fill/:token — load the form data
app.get('/api/contract-fill/:token', rateLimitContractFill, async (req, res) => {
  const token = String(req.params.token).slice(0, 80);
  const contractInvitation = require('./services/contractInvitation');
  try {
    const inv = await contractInvitation.resolveActiveByToken(pool, token);
    if (!inv) return res.status(404).json({
      error: 'ลิงก์นี้ใช้ไม่ได้แล้ว (อาจหมดอายุ ถูกอนุมัติ หรือถูกยกเลิก)',
      code: 'TOKEN_INVALID',
    });
    let building = { name: 'บ้านกาญจน์ เรสซิเดนซ์' };
    try {
      const cfgQ = await pool.query(
        `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
      );
      const cfg = cfgQ.rows[0]?.value || {};
      if (cfg.building) building = { ...building, ...cfg.building };
    } catch { /* keep default */ }
    res.json({ ok: true, view: contractInvitation.buildPublicView(inv, building) });
  } catch (err) {
    console.error('contract-fill GET error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// PUT /api/contract-fill/:token — save draft (intermediate state)
app.put('/api/contract-fill/:token', rateLimitContractFill, async (req, res) => {
  const token = String(req.params.token).slice(0, 80);
  const contractInvitation = require('./services/contractInvitation');
  try {
    const inv = await contractInvitation.resolveActiveByToken(pool, token);
    if (!inv) return res.status(404).json({ error: 'TOKEN_INVALID', code: 'TOKEN_INVALID' });
    if (inv.status !== 'pending') {
      return res.status(409).json({
        error: 'ส่งให้ตรวจสอบแล้ว — แก้ไขไม่ได้จนกว่า admin จะ reject',
        code: 'NOT_EDITABLE',
      });
    }
    const draft = contractInvitation.sanitiseDraft(req.body);
    // Merge over existing — tenant might be saving partial fields.
    const merged = Object.assign({}, inv.draft || {}, draft);
    await pool.query(
      `UPDATE contract_invitations SET draft=$1::jsonb, updated_at=NOW() WHERE id=$2`,
      [JSON.stringify(merged), inv.id]
    );
    res.json({ ok: true, draft: merged });
  } catch (err) {
    console.error('contract-fill PUT error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /api/contract-fill/:token/upload — tenant uploads ID front/back/signature
app.post('/api/contract-fill/:token/upload', rateLimitContractFill, async (req, res) => {
  const token = String(req.params.token).slice(0, 80);
  const contractInvitation = require('./services/contractInvitation');
  try {
    const inv = await contractInvitation.resolveActiveByToken(pool, token);
    if (!inv) return res.status(404).json({ error: 'TOKEN_INVALID', code: 'TOKEN_INVALID' });
    if (inv.status !== 'pending') {
      return res.status(409).json({ error: 'NOT_EDITABLE', code: 'NOT_EDITABLE' });
    }
    const b = req.body || {};
    const kind = String(b.kind || '');
    if (!['front', 'back', 'signature'].includes(kind)) {
      return res.status(400).json({ error: 'kind must be front|back|signature' });
    }
    if (!b.dataUrl) return res.status(400).json({ error: 'dataUrl required' });
    const category = kind === 'signature' ? 'contract_signature' : 'citizen_id_image';
    const side = kind === 'signature' ? null : kind;
    const out = await storage.saveBase64({
      pool, category,
      dataUrl: b.dataUrl,
      // refId points at the invitation so admin can audit which token
      // produced the file. Approval moves it onto the tenant id.
      refId: `invitation-${inv.id}`,
      uploadedBy: 'tenant-fill',
      maxBytes: 1_500_000,
      side,
    });
    res.json({ ok: true, file: { id: out.id, url: out.url, kind } });
  } catch (err) {
    console.error('contract-fill upload error:', err.message);
    res.status(400).json({ error: err.message || 'upload failed' });
  }
});

// POST /api/contract-fill/:token/submit — tenant flips to status='submitted'
app.post('/api/contract-fill/:token/submit', rateLimitContractFill, async (req, res) => {
  const token = String(req.params.token).slice(0, 80);
  const contractInvitation = require('./services/contractInvitation');
  try {
    const inv = await contractInvitation.resolveActiveByToken(pool, token);
    if (!inv) return res.status(404).json({ error: 'TOKEN_INVALID', code: 'TOKEN_INVALID' });
    if (inv.status !== 'pending') {
      return res.status(409).json({ error: 'NOT_EDITABLE', code: 'NOT_EDITABLE' });
    }
    // Optional final-edit payload sent with the submit click — merge as one
    // last save before flipping status.
    let draft = inv.draft || {};
    if (req.body && Object.keys(req.body).length > 0) {
      const next = contractInvitation.sanitiseDraft(req.body);
      draft = Object.assign({}, draft, next);
    }
    // Required fields at submit time. The renderer needs at minimum the
    // signature + the legal trail (terms version) to produce a valid PDF.
    const missing = [];
    if (!draft.signatureFileId) missing.push('signature');
    if (!draft.address) missing.push('address');
    if (!draft.emergencyContactName) missing.push('emergencyContactName');
    if (!draft.emergencyContactPhone) missing.push('emergencyContactPhone');
    if (!draft.citizenIdImageFrontId) missing.push('citizenIdFront');
    if (!draft.citizenIdImageBackId) missing.push('citizenIdBack');
    if (missing.length > 0) {
      return res.status(400).json({
        error: `กรอกไม่ครบ — ขาด: ${missing.join(', ')}`,
        code: 'INCOMPLETE', missing,
      });
    }
    await pool.query(
      `UPDATE contract_invitations
          SET status='submitted', draft=$1::jsonb, submitted_at=NOW(), updated_at=NOW()
        WHERE id=$2 AND status='pending'`,
      [JSON.stringify(draft), inv.id]
    );
    // Owner notify so admin sees a fresh submission immediately.
    try {
      const flags = await features.load(pool);
      notifier.notifyOwner({ pool, features: flags }, {
        subject: '📥 ผู้เช่าส่งสัญญาให้ตรวจสอบ',
        text: `invitation #${inv.id} (contract ${inv.contract_id}) — เข้าตรวจที่ /admin#contract-invitations`,
      }).catch(() => {});
    } catch { /* ignore */ }
    res.json({ ok: true, invitationId: inv.id, status: 'submitted' });
  } catch (err) {
    console.error('contract-fill submit error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// === Legacy single-template alias (backwards compat) =======================
// /api/admin/contract-terms still works — it operates on the default
// contract_templates row. New code should use /api/admin/contract-templates.
const CONTRACT_TERMS_KEY = 'contract.terms_template';

app.get('/api/admin/contract-terms', requireAuth, requireRole('owner', 'manager'), async (_req, res) => {
  try {
    const contractPdf = require('./services/contractPdf');
    // Prefer contract_templates default row; fall back to legacy system_settings.
    const dr = await pool.query(
      `SELECT mode, clauses, sections, variables, updated_by, updated_at
         FROM contract_templates
        WHERE is_default=TRUE AND deleted_at IS NULL LIMIT 1`
    );
    if (dr.rows.length) {
      return res.json({
        ok: true,
        template: dr.rows[0],
        defaults: contractPdf.DEFAULT_CLAUSES,
        resolved: contractPdf.resolveClauses(dr.rows[0]),
        updatedBy: dr.rows[0].updated_by,
        updatedAt: dr.rows[0].updated_at,
        source: 'contract_templates',
      });
    }
    // Legacy fallback (pre-migration)
    const { rows } = await pool.query(
      'SELECT value, updated_by, updated_at FROM system_settings WHERE key=$1',
      [CONTRACT_TERMS_KEY]
    );
    if (!rows.length) {
      return res.json({
        ok: true, template: null,
        defaults: contractPdf.DEFAULT_CLAUSES,
        resolved: contractPdf.DEFAULT_CLAUSES,
      });
    }
    res.json({
      ok: true,
      template: rows[0].value,
      defaults: contractPdf.DEFAULT_CLAUSES,
      resolved: contractPdf.resolveClauses(rows[0].value),
      updatedBy: rows[0].updated_by,
      updatedAt: rows[0].updated_at,
      source: 'system_settings',
    });
  } catch (err) {
    console.error('contract-terms GET error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// PUT writes to BOTH the new default-template row AND the legacy alias
// so older client code that polls system_settings still sees the change.
app.put('/api/admin/contract-terms', sameOrigin, csrfGuard, requireAuth, requireRole('owner'),
  async (req, res) => {
    const b = req.body || {};
    const mode = ['default', 'append', 'override'].includes(b.mode) ? b.mode : 'default';
    const rawClauses = Array.isArray(b.clauses) ? b.clauses : [];
    if (rawClauses.length > 100) {
      return res.status(400).json({
        error: 'จำกัดข้อบังคับสูงสุด 100 ข้อ', code: 'TOO_MANY_CLAUSES',
      });
    }
    let clauses;
    try {
      clauses = rawClauses.map((c, i) => {
        if (!c || typeof c !== 'object') {
          throw Object.assign(new Error(`ข้อ ${i + 1}: ต้องเป็น object`), { code: 'INVALID_CLAUSE' });
        }
        const title = String(c.title || '').slice(0, 200).trim();
        const body  = String(c.body  || '').slice(0, 4000).trim();
        if (!title) throw Object.assign(new Error(`ข้อ ${i + 1}: หัวข้อห้ามว่าง`), { code: 'INVALID_CLAUSE' });
        if (!body)  throw Object.assign(new Error(`ข้อ ${i + 1}: เนื้อหาห้ามว่าง`), { code: 'INVALID_CLAUSE' });
        return { id: c.id ? String(c.id).slice(0, 64) : null, title, body };
      });
    } catch (err) {
      return res.status(400).json({ error: err.message, code: err.code || 'INVALID' });
    }
    if (mode === 'override' && clauses.length === 0) {
      return res.status(400).json({
        error: 'override mode ต้องมีข้อบังคับอย่างน้อย 1 ข้อ',
        code: 'OVERRIDE_NEEDS_CLAUSES',
      });
    }
    const template = { mode, clauses };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Update or create the default contract_templates row.
      const existing = await client.query(
        `SELECT id FROM contract_templates WHERE is_default=TRUE AND deleted_at IS NULL`
      ).catch((err) => {
        if (err.code === '42P01') return { rows: [] };  // pre-migration
        throw err;
      });
      if (existing.rows.length) {
        await client.query(
          `UPDATE contract_templates SET
              mode=$1, clauses=$2::jsonb, updated_at=NOW()
            WHERE id=$3`,
          [mode, JSON.stringify(clauses), existing.rows[0].id]
        );
      } else {
        await client.query(
          `INSERT INTO contract_templates
              (name, description, mode, clauses, is_default, enabled, created_by)
           VALUES ($1, $2, $3, $4::jsonb, TRUE, TRUE, $5)`,
          ['Default', 'auto-created from /contract-terms PUT', mode,
           JSON.stringify(clauses), req.session.user.username]
        ).catch((err) => {
          if (err.code !== '42P01') throw err;
          // Pre-migration: contract_templates table missing → fall through
          // to the system_settings legacy alias only.
        });
      }
      // Mirror to legacy alias for older clients still reading it.
      await client.query(
        `INSERT INTO system_settings (key, value, description, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (key) DO UPDATE SET
           value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
        [CONTRACT_TERMS_KEY, JSON.stringify(template),
         'กฎข้อบังคับสัญญาเช่า (mirror)', req.session.user.username]
      );
      await client.query('COMMIT');
      audit(req, 'contract.terms_update', 'contract_template', 'default',
        { mode, clauseCount: clauses.length });
      res.json({ ok: true, template });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('contract-terms PUT error:', err);
      res.status(500).json({ error: 'internal error' });
    } finally {
      client.release();
    }
  });

// Reset to defaults — clears legacy alias + soft-deletes the default
// template row (a fresh boot will recreate from DEFAULT_CLAUSES).
app.delete('/api/admin/contract-terms', sameOrigin, csrfGuard, requireAuth, requireRole('owner'),
  async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Clear legacy alias.
      await client.query('DELETE FROM system_settings WHERE key=$1', [CONTRACT_TERMS_KEY]);
      // Reset the default contract_templates row to "default mode, no clauses"
      // rather than soft-delete — that way contracts.template_id pointing
      // here keeps working and just falls back to DEFAULT_CLAUSES.
      await client.query(
        `UPDATE contract_templates SET
            mode='default', clauses='[]'::jsonb, sections='{}'::jsonb,
            variables='{}'::jsonb, updated_at=NOW()
          WHERE is_default=TRUE AND deleted_at IS NULL`
      ).catch((err) => {
        if (err.code !== '42P01') throw err;
      });
      await client.query('COMMIT');
      audit(req, 'contract.terms_reset', 'contract_template', 'default');
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('contract-terms DELETE error:', err);
      res.status(500).json({ error: 'internal error' });
    } finally {
      client.release();
    }
  });

// === v2: Contract PDF download ============================================
// GET /api/contracts/:id/pdf
//
// Renders the contract as A4 PDF — for printing AND/OR online viewing.
// Embeds the signature image (if signed online) into the signature box.
// Resolves admin's custom terms template on the fly. Falls back to default
// clauses when no template is set.
//
// ?download=1 forces a download (Content-Disposition: attachment) so admin
// can save → print. Default is inline so the browser PDF viewer opens.
// Restricted to owner+manager because the rendered PDF embeds the
// citizen-ID tail + tenant emergency phone — same data class as
// /api/tenants/:id/identity, which is owner+manager only. Letting staff
// download contracts would route around that gate.
app.get('/api/contracts/:id/pdf', requireAuth, requireRole('owner', 'manager'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    try {
      // ============== 1. Contract + tenant ==============
      // Single SELECT with all the joins admin needs at print time. Falls
      // back to a smaller query on pre-migration deploys (without the
      // identity / template_id columns).
      let contract;
      try {
        const cQ = await pool.query(
          `SELECT c.*, t.full_name AS tenant_name, t.phone AS tenant_phone,
                  t.email AS tenant_email, t.citizen_id_tail, t.address AS tenant_address,
                  t.emergency_contact_name, t.emergency_contact_phone,
                  t.emergency_contact_relation
             FROM contracts c
             LEFT JOIN tenants t ON t.id = c.tenant_id AND t.deleted_at IS NULL
             WHERE c.id=$1 AND c.deleted_at IS NULL`,
          [id]
        );
        if (!cQ.rows.length) return res.status(404).json({ error: 'contract not found' });
        contract = cQ.rows[0];
      } catch (err) {
        if (err.code !== '42703') throw err;  // pre-migration deploy
        const cQ = await pool.query(
          `SELECT c.*, t.full_name AS tenant_name, t.phone AS tenant_phone,
                  t.email AS tenant_email, t.citizen_id_tail
             FROM contracts c
             LEFT JOIN tenants t ON t.id = c.tenant_id AND t.deleted_at IS NULL
             WHERE c.id=$1 AND c.deleted_at IS NULL`,
          [id]
        );
        if (!cQ.rows.length) return res.status(404).json({ error: 'contract not found' });
        contract = cQ.rows[0];
      }

      // ============== 2. Building info ==============
      // Same source as bill PDF — single config blob in app_data.
      let building = { name: 'บ้านกาญจน์ เรสซิเดนซ์' };
      try {
        const cfgQ = await pool.query(
          `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
        );
        const cfg = cfgQ.rows[0]?.value || {};
        if (cfg.building) building = { ...building, ...cfg.building };
      } catch { /* keep default */ }

      // ============== 3. Room details (auto-pull) ==============
      // Try rooms_v2 first (richer schema with type/floor/amenities), fall
      // back to the JSONB blob keyed by room_code. Either source enriches
      // the contract with the unit-level details the renderer prints in
      // the property-details section. Without this, the contract only
      // knew the room id which is unhelpful on the printed copy.
      let room = { id: contract.room_id };
      if (contract.room_id) {
        try {
          const rv2 = await pool.query(
            `SELECT room_code, room_type, floor, room_no, status,
                    rent_price, deposit_price, wifi_fee, view_type,
                    has_balcony, has_parking, has_kitchen, has_ac,
                    size_sqm, bed_count, notes
               FROM rooms_v2
              WHERE room_code=$1 AND deleted_at IS NULL LIMIT 1`,
            [contract.room_id]
          );
          if (rv2.rows.length) {
            const r = rv2.rows[0];
            const amenities = [];
            if (r.has_ac)       amenities.push('แอร์');
            if (r.has_balcony)  amenities.push('ระเบียง');
            if (r.has_kitchen)  amenities.push('ห้องครัว');
            if (r.has_parking)  amenities.push('ที่จอดรถ');
            room = {
              id: r.room_code,
              type: r.room_type,
              floor: r.floor,
              roomNo: r.room_no,
              size: r.size_sqm,
              bedCount: r.bed_count,
              view: r.view_type,
              amenities,
              wifiFee: Number(r.wifi_fee || 0),
              source: 'rooms_v2',
            };
          }
        } catch (err) {
          if (err.code !== '42P01') console.warn('[contract pdf] rooms_v2 lookup:', err.message);
        }
        // Fallback / merge: if rooms_v2 didn't have the row, look up the
        // legacy JSONB blob. We mirror as much detail as the blob has.
        if (room.source !== 'rooms_v2') {
          try {
            const blob = await pool.query(
              `SELECT value FROM app_data WHERE key='baankarn_rooms_v1' LIMIT 1`
            );
            const v = blob.rows[0]?.value;
            const r = v && v[contract.room_id];
            if (r && typeof r === 'object') {
              const amenities = [];
              if (r.hasAc !== false)  amenities.push('แอร์');
              if (r.hasBalcony)       amenities.push('ระเบียง');
              if (r.hasKitchen)       amenities.push('ห้องครัว');
              if (r.hasParking)       amenities.push('ที่จอดรถ');
              room = {
                id: contract.room_id,
                type: r.type || r.roomType || null,
                floor: r.floor || null,
                roomNo: r.no || r.roomNo || null,
                size: r.size || r.sizeSqm || null,
                bedCount: r.bedCount || null,
                view: r.viewType || null,
                amenities,
                wifiFee: Number(r.wifi || 0),
                source: 'jsonb_blob',
              };
            }
          } catch { /* fall through with bare {id} */ }
        }
      }

      // ============== 4. Template resolution ==============
      // Priority: contracts.template_id (per-contract choice) → query
      // override (?templateId=N) → default contract_templates row →
      // legacy system_settings → null (renderer uses DEFAULT_CLAUSES).
      let template = null;
      const queryTemplateId = req.query.templateId ? Number(req.query.templateId) : null;
      const explicitId = (Number.isInteger(queryTemplateId) && queryTemplateId > 0)
        ? queryTemplateId
        : (contract.template_id || null);
      if (explicitId) {
        try {
          const t = await pool.query(
            `SELECT mode, clauses, sections, variables FROM contract_templates
              WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,
            [explicitId]
          );
          if (t.rows.length) template = t.rows[0];
        } catch (err) {
          if (err.code !== '42P01') console.warn('[contract pdf] template lookup:', err.message);
        }
      }
      if (!template) {
        // Fall back to default template row.
        try {
          const t = await pool.query(
            `SELECT mode, clauses, sections, variables FROM contract_templates
              WHERE is_default=TRUE AND deleted_at IS NULL LIMIT 1`
          );
          if (t.rows.length) template = t.rows[0];
        } catch { /* pre-migration */ }
      }
      if (!template) {
        // Legacy single-row fallback.
        try {
          const tQ = await pool.query(
            `SELECT value FROM system_settings WHERE key=$1`,
            [CONTRACT_TERMS_KEY]
          );
          if (tQ.rows.length) template = tQ.rows[0].value;
        } catch { /* renderer falls back to DEFAULT_CLAUSES */ }
      }

      // ============== 5. Online signature embed ==============
      let tenantSigBuf = null;
      if (contract.signature_image_id) {
        try {
          const fQ = await pool.query(
            'SELECT * FROM file_uploads WHERE id=$1 LIMIT 1',
            [contract.signature_image_id]
          );
          if (fQ.rows.length) {
            tenantSigBuf = await storage.readFile(fQ.rows[0]);
          }
        } catch (err) {
          console.warn('[contract pdf] signature load failed:', err.message);
        }
      }

      // ============== 6. Feature-derived constants ==============
      let lateFeeRate = 1.5;
      let dueDay = 15;
      try {
        const flags = await features.load(pool);
        if (Number.isFinite(Number(flags?.lateFee?.ratePctPerMonth))) {
          lateFeeRate = Number(flags.lateFee.ratePctPerMonth);
        }
        if (Number.isFinite(Number(flags?.billAutoGenerate?.dueDay))) {
          dueDay = Number(flags.billAutoGenerate.dueDay);
        }
      } catch { /* keep defaults */ }

      // ============== 7. Response headers + render ==============
      const filename = `contract-${contract.contract_no || id}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader(
        'Content-Disposition',
        `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${filename}"`
      );

      // Mask the citizen ID — the PDF can be shared / reprinted. Last 4 digits
      // + asterisks matches the masking convention used elsewhere.
      const contractPdf = require('./services/contractPdf');
      const tenant = {
        fullName: contract.tenant_name,
        phone: contract.tenant_phone,
        email: contract.tenant_email,
        citizenIdMasked: contract.citizen_id_tail ? `***-***-${contract.citizen_id_tail}` : null,
        address: contract.tenant_address || null,
        emergencyContactName: contract.emergency_contact_name || null,
        emergencyContactPhone: contract.emergency_contact_phone || null,
        emergencyContactRelation: contract.emergency_contact_relation || null,
      };

      audit(req, 'contract.pdf_view', 'contract', String(id), {
        contractNo: contract.contract_no, hasSignature: !!tenantSigBuf,
        download: req.query.download === '1',
        templateId: explicitId, roomSource: room.source || 'minimal',
      });

      await contractPdf.renderContractPdf(
        {
          contractNo: contract.contract_no,
          startDate: contract.start_date,
          endDate: contract.end_date,
          monthlyRent: contract.monthly_rent,
          deposit: contract.deposit,
          discountPct: contract.discount_pct,
          termMonths: contract.term_months,
          signedAt: contract.signed_at,
          agreedTermsVersion: contract.agreed_terms_version,
          status: contract.status,
        },
        tenant, room, building,
        {
          termsTemplate: template,
          signatures: { tenantBuf: tenantSigBuf },
          lateFeeRate, dueDay,
        },
        res
      );
    } catch (err) {
      console.error('contract pdf error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'internal error', code: 'PDF_ERROR' });
      else res.end();
    }
  });

// === v2: Backup + restore (full SQL dump, owner-only) =====================
// scripts/backup.js already does the heavy lifting (run() returns metadata
// + a file on disk; verify() validates a file's SHA-256 integrity hash).
// These endpoints just expose that machinery so admin can:
//   - trigger a backup from the UI ("download" button)
//   - list / download / delete prior backup files
//   - restore from one (server-side file or uploaded JSON body)
//
// Critical UX note: the previous "backup" button in /admin#settings only
// exported the in-memory rooms/config/bookings JSON blobs — bills,
// payments, tenants, contracts, audit_logs were ALL missing. Operators
// who restored from such a backup lost months of financial records.
// These endpoints replace that path with a real DB-level dump.
//
// Filename format is fixed by scripts/backup.js: `backup-<ISO-stamp>.json`
// where ISO chars `:` and `.` are replaced with `-`. We allow-list filenames
// to that exact shape to defeat path traversal. path.basename() before any
// fs op is belt-and-braces.
const BACKUP_FILENAME_RE = /^backup-[A-Za-z0-9-]+\.json$/;
function backupFile(filename) {
  // Reject anything with a slash, dot-segment, etc. before touching disk.
  if (!BACKUP_FILENAME_RE.test(filename)) return null;
  const safe = require('path').basename(filename);
  if (safe !== filename) return null;
  return require('path').join(__dirname, 'backups', safe);
}

app.post('/api/admin/backup/create', sameOrigin, csrfGuard, requireAuth, requireRole('owner'),
  async (req, res) => {
    try {
      const backup = require('./scripts/backup');
      const result = await backup.run({ pool, retainDays: 30 });
      const filename = require('path').basename(result.file);
      audit(req, 'backup.create', 'backup', filename, {
        size: result.size, digest: result.digest, rowCounts: result.rowCounts,
      });
      res.json({
        ok: true,
        filename,
        size: result.size,
        digest: result.digest,
        rowCounts: result.rowCounts,
        downloadUrl: `/api/admin/backup/download/${encodeURIComponent(filename)}`,
      });
    } catch (err) {
      console.error('backup create error:', err);
      res.status(500).json({ error: 'backup failed', code: 'BACKUP_FAILED' });
    }
  });

app.get('/api/admin/backup/list', requireAuth, requireRole('owner', 'manager'), async (_req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, 'backups');
    if (!fs.existsSync(dir)) return res.json({ ok: true, backups: [] });
    const files = fs.readdirSync(dir)
      .filter((f) => BACKUP_FILENAME_RE.test(f))
      .sort()
      .reverse();
    const items = files.map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return {
        filename: f,
        size: stat.size,
        createdAt: stat.mtime.toISOString(),
        downloadUrl: `/api/admin/backup/download/${encodeURIComponent(f)}`,
      };
    });
    res.json({ ok: true, backups: items });
  } catch (err) {
    console.error('backup list error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/admin/backup/download/:filename', requireAuth, requireRole('owner', 'manager'),
  async (req, res) => {
    const fp = backupFile(req.params.filename);
    if (!fp) return res.status(400).json({ error: 'invalid filename' });
    const fs = require('fs');
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
    audit(req, 'backup.download', 'backup', req.params.filename).catch(() => {});
    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${req.params.filename}"`
    );
    fs.createReadStream(fp).on('error', (err) => {
      console.error('backup download stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'read failed' });
    }).pipe(res);
  });

app.delete('/api/admin/backup/:filename', sameOrigin, csrfGuard, requireAuth, requireRole('owner'),
  async (req, res) => {
    const fp = backupFile(req.params.filename);
    if (!fp) return res.status(400).json({ error: 'invalid filename' });
    const fs = require('fs');
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
    try {
      fs.unlinkSync(fp);
      audit(req, 'backup.delete', 'backup', req.params.filename);
      res.json({ ok: true });
    } catch (err) {
      console.error('backup delete error:', err);
      res.status(500).json({ error: 'delete failed' });
    }
  });

// POST /api/admin/restore — destructive. Expects { confirm: true } AND either
// `filename` (server-side backup) or `backup` (full JSON in the body).
//
// The default Express body limit is 3MB, way too small for a real dump
// (audit_logs + meter_readings alone can exceed that). We mount a 100MB
// JSON parser ONLY on this route so the rest of the app stays bounded.
const restoreBodyParser = express.json({ limit: '100mb' });
app.post('/api/admin/restore', restoreBodyParser, sameOrigin, csrfGuard, requireAuth, requireRole('owner'),
  async (req, res) => {
    const b = req.body || {};
    if (b.confirm !== true) {
      return res.status(400).json({
        error: 'restore requires explicit confirm: true (this OVERWRITES current data)',
        code: 'CONFIRM_REQUIRED',
      });
    }
    let backup;
    if (b.filename) {
      const fp = backupFile(b.filename);
      if (!fp) return res.status(400).json({ error: 'invalid filename' });
      const fs = require('fs');
      if (!fs.existsSync(fp)) return res.status(404).json({ error: 'backup file not found' });
      try {
        backup = JSON.parse(fs.readFileSync(fp, 'utf8'));
      } catch (err) {
        return res.status(400).json({ error: 'backup file is not valid JSON' });
      }
    } else if (b.backup && typeof b.backup === 'object') {
      backup = b.backup;
    } else {
      return res.status(400).json({
        error: 'either filename or backup body required',
        code: 'MISSING_PAYLOAD',
      });
    }

    if (!backup.tables || backup.schemaVersion !== 1) {
      return res.status(400).json({
        error: 'invalid backup format (schemaVersion=1 expected)',
        code: 'BAD_FORMAT',
      });
    }
    // Integrity check (skip if backup predates the integrity field — older
    // local-only dumps from scripts/backup.js's main() path don't include it).
    if (backup.integrity?.algorithm === 'sha256') {
      const expected = backup.integrity.digest;
      const stored = { ...backup };
      delete stored.integrity;
      const actual = require('crypto').createHash('sha256')
        .update(JSON.stringify(stored)).digest('hex');
      if (actual !== expected) {
        return res.status(400).json({
          error: 'integrity hash mismatch — backup may be corrupt or tampered',
          code: 'INTEGRITY_FAILED',
        });
      }
    }

    // Tables to restore, in PARENT-FIRST order so per-row INSERT inside the
    // tx satisfies FK constraints. Children (payments → bills → tenants)
    // come after parents. Non-restorable tables are listed in SKIP_TABLES.
    const RESTORABLE_TABLES = [
      'app_data', 'auth_users', 'system_settings',
      'line_oas',
      'tenants',
      'access_devices',
      // contract_templates BEFORE contracts so the contracts.template_id
      // FK is satisfied during a fresh restore.
      'contract_templates',
      'contracts', 'bills', 'recurring_charges',
      'payments', 'access_cards', 'line_bindings',
      'meter_readings',
      'maintenance_tickets',
      'access_logs',
      'audit_logs',
      'notifications_log',
      'file_uploads',
      'bookings',
      // Restored last; FK on contracts means parent must be in place first.
      'contract_invitations',
    ];
    const SKIP_NOTE = {
      tenant_sessions: 'transient — users will re-login',
      login_lockouts: 'ephemeral',
      notifications_queue: 'transient — would replay outbound on restore',
      secrets: 'not in backup (encrypted; admin restores secrets separately)',
      rooms_v2: 'optional table; not in backup TABLES list',
    };

    const client = await pool.connect();
    const stats = {};
    const errors = [];
    try {
      await client.query('BEGIN');
      // Defer FK so insert order within tx is forgiving (most FKs in this
      // schema aren't DEFERRABLE so this is a no-op for them — we still
      // rely on the parent-first ordering above).
      try { await client.query('SET CONSTRAINTS ALL DEFERRED'); } catch { /* not all FKs deferrable */ }

      // Phase 1: DELETE in REVERSE (child-first) order so FKs hold during wipe.
      for (const t of [...RESTORABLE_TABLES].reverse()) {
        const data = backup.tables[t];
        if (!data || !Array.isArray(data)) continue;
        try {
          await client.query(`DELETE FROM ${t}`);
        } catch (err) {
          if (err.code === '42P01') continue; // table doesn't exist on this deploy
          throw err;
        }
      }

      // Phase 2: INSERT parent-first.
      for (const t of RESTORABLE_TABLES) {
        const rows = backup.tables[t];
        if (!rows || !Array.isArray(rows)) {
          stats[t] = { skipped: 'not in backup' };
          continue;
        }
        if (rows.length === 0) { stats[t] = { inserted: 0 }; continue; }

        const cols = Object.keys(rows[0]);
        const colList = cols.map((c) => `"${c}"`).join(',');
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
        let inserted = 0, failed = 0;
        for (const row of rows) {
          const vals = cols.map((c) => row[c] === undefined ? null : row[c]);
          try {
            await client.query(
              `INSERT INTO ${t} (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
              vals
            );
            inserted++;
          } catch (err) {
            failed++;
            errors.push(`${t}: ${err.message.slice(0, 150)}`);
          }
        }
        stats[t] = { inserted, failed };
        // Reset BIGSERIAL sequence so next-insert id picks up where the
        // restored data left off. Best-effort — non-serial PKs (text keys
        // like app_data.key) just get a no-op.
        try {
          await client.query(
            `SELECT setval(pg_get_serial_sequence($1, 'id'),
                            COALESCE((SELECT MAX(id) FROM ${t}), 1), true)`,
            [t]
          );
        } catch { /* table has no `id` SERIAL column */ }
      }

      await client.query('COMMIT');
      audit(req, 'backup.restore', 'backup', b.filename || 'inline-body', {
        stats, errorCount: errors.length,
      });
      res.json({
        ok: true,
        restored: stats,
        skipped: SKIP_NOTE,
        errors: errors.slice(0, 50), // cap response size
        errorCount: errors.length,
        warning: 'รอบทำงานต่อไปต้อง re-login + sequences ถูก reset แล้ว',
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('restore error:', err);
      res.status(500).json({
        error: 'restore failed — database rolled back to previous state',
        detail: String(err.message || '').slice(0, 300),
        code: 'RESTORE_FAILED',
      });
    } finally {
      client.release();
    }
  });

// === v2: Notification queue admin endpoints ===============================
const notifQueue = require('./services/notificationQueue');

app.get('/api/admin/notifications', requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  const status = String(req.query.status || '').slice(0, 16);
  const params = [];
  let where = '';
  // 'processing' = claimed by a worker but dispatch not finished yet
  // (used by the multi-instance-safe queue tick).
  if (['pending', 'sent', 'failed', 'processing'].includes(status)) {
    params.push(status); where = `WHERE status = $1`;
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, channel, recipient, subject, status, retry_count,
              next_attempt_at, sent_at, last_error, created_at
         FROM notifications_queue ${where}
         ORDER BY created_at DESC LIMIT 200`,
      params
    );
    res.json({ ok: true, items: rows });
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});
app.post('/api/admin/notifications/:id/retry', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  try {
    await notifQueue.retryById(pool, id);
    audit(req, 'notification.retry', 'notification', String(id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

// --- Health ---------------------------------------------------------------
// /health → liveness + dependency probe.
//   db          : SELECT 1 latency in ms (or 'down')
//   scheduler   : last fired key from .scheduler-state.json (or disabled)
//   queue       : count of pending notifications (visibility on backlog)
//   secrets     : 'configured' / 'partial' / 'none' (no values, just shape)
//   uptime      : process uptime in seconds
//   memory_mb   : RSS in MB
// Production-readiness checklist. Different from /api/admin/health (which
// is "is it currently working") — this is "is it CONFIGURED for real use."
// Catches the common gotchas that turn a demo into a half-broken production:
// no real building info, no LINE OA bound, simulator still on, default
// admin password, no real PromptPay number, etc.
//
// Owner-only — the response surfaces config gaps that could be useful to an
// attacker scoping a target.
app.get('/api/admin/production-readiness', requireAuth, requireRole('owner'), async (_req, res) => {
  const checks = [];
  const ok    = (id, label, msg)        => checks.push({ id, label, status: 'ok',   message: msg });
  const warn  = (id, label, msg, hint)  => checks.push({ id, label, status: 'warn', message: msg, hint });
  const fail  = (id, label, msg, hint)  => checks.push({ id, label, status: 'fail', message: msg, hint });

  // 1. NODE_ENV
  if (NODE_ENV === 'production') {
    ok('node_env', 'Environment', 'NODE_ENV=production');
  } else {
    warn('node_env', 'Environment', `NODE_ENV=${NODE_ENV} — secure cookies + simulator block jut active in 'production'`,
      'ตั้ง NODE_ENV=production ใน Railway Variables');
  }

  // 2. Building info filled in
  try {
    const cfgRow = await pool.query(`SELECT value FROM app_data WHERE key='baankarn_config_v1'`);
    const cfg = cfgRow.rows.length ? cfgRow.rows[0].value : {};
    const b = (cfg && cfg.building) || {};
    const missing = [];
    if (!b.name || b.name === 'บ้านกาญจน์ เรสซิเดนซ์') missing.push('building.name (ยังเป็น default)');
    if (!b.address) missing.push('building.address');
    if (!b.phone)   missing.push('building.phone');
    if (missing.length) {
      warn('building', 'ข้อมูลตึก',
        `ยังไม่ได้ตั้งค่า: ${missing.join(', ')}`,
        'แก้ที่ Settings → ข้อมูลตึก');
    } else {
      ok('building', 'ข้อมูลตึก', `${b.name} · ${b.phone || ''}`);
    }
    // 3. PromptPay target set?
    const ppDb = (cfg && cfg.payment) ? (cfg.payment.promptpay || cfg.payment.promptpayTarget) : null;
    const ppEnv = require('./services/secrets').get('PROMPTPAY_TARGET');
    if (!ppDb && !ppEnv) {
      fail('promptpay', 'PromptPay',
        'ยังไม่ได้ตั้งค่า PromptPay target — บิล PDF จะไม่มี QR code',
        'แก้ที่ Settings → การชำระเงิน หรือใส่ PROMPTPAY_TARGET ใน Secrets');
    } else {
      ok('promptpay', 'PromptPay', 'ตั้งค่าเรียบร้อย');
    }
  } catch (err) {
    warn('config_read', 'อ่าน config', `ตรวจไม่ได้: ${err.message}`);
  }

  // 4. At least one owner exists with strong password (we can't read the
  //    hash but we can warn if there's exactly the bootstrap user with the
  //    default username 'admin' — operator should rename or rotate password).
  try {
    const ownersQ = await pool.query(`SELECT username FROM auth_users WHERE role='owner' ORDER BY id ASC`);
    const owners = ownersQ.rows.map((r) => r.username);
    if (owners.length === 0) {
      fail('owner', 'Owner accounts', 'ไม่มี owner เลย — ระบบจะล็อกเอง',
        'รัน scripts/promote-to-owner.js หรือลบบัญชีเก่าแล้ว bootstrap ใหม่');
    } else if (owners.length === 1 && owners[0] === 'admin') {
      warn('owner', 'Owner accounts',
        'มี owner คนเดียวด้วย username="admin" (default)',
        'สร้าง owner คนที่สองและตั้งชื่อจริง — กันถูกล็อกออกถ้ารหัสหาย');
    } else {
      ok('owner', 'Owner accounts', `${owners.length} owner: ${owners.join(', ')}`);
    }
  } catch (err) {
    warn('owner_read', 'Owner check', err.message);
  }

  // 5. Critical secrets configured (boot-time + DB)
  const sec = require('./services/secrets');
  const secretChecks = [
    { key: 'SESSION_SECRET',    label: 'SESSION_SECRET',     fatal: true,
      val: SESSION_SECRET, fromEnv: true },
    { key: 'CITIZEN_ID_KEY',    label: 'CITIZEN_ID_KEY',     fatal: false,
      val: process.env.CITIZEN_ID_KEY || process.env.ENCRYPTION_KEY_V1,
      hint: 'ป้องกัน citizen-id ถ้าหมุน SESSION_SECRET — ถ้าไม่ตั้ง ข้อมูลที่เข้ารหัสไว้จะถอดไม่ได้หลังหมุน' },
    { key: 'LINE_CHANNEL_ACCESS_TOKEN', label: 'LINE Channel Access Token', fatal: false,
      val: sec.get('LINE_CHANNEL_ACCESS_TOKEN'),
      hint: 'ไม่มี → ส่งแจ้งเตือนทาง LINE ไม่ได้' },
    { key: 'LINE_CHANNEL_SECRET', label: 'LINE Channel Secret', fatal: false,
      val: sec.get('LINE_CHANNEL_SECRET'),
      hint: 'ไม่มี → webhook signature verification ปฏิเสธทุก request' },
  ];
  for (const s of secretChecks) {
    if (!s.val) {
      (s.fatal ? fail : warn)('secret_' + s.key.toLowerCase(), s.label,
        `ยังไม่ได้ตั้งค่า`, s.hint || `ตั้งค่าใน ${s.fromEnv ? 'Railway Variables' : 'Settings → Secrets'}`);
    } else {
      ok('secret_' + s.key.toLowerCase(), s.label, 'ตั้งค่าเรียบร้อย');
    }
  }

  // 6. Feature flags appropriate for production
  let flags = {};
  try { flags = await features.load(pool); } catch { /* keep going */ }
  if (flags.meterIot?.mode === 'simulator') {
    fail('simulator', 'Meter simulator',
      'meterIot.mode = "simulator" — กำลังสร้างค่าเทียมทับมิเตอร์จริง',
      'เปลี่ยนเป็น "manual" หรือ "mqtt" ที่หน้า Features');
  } else {
    ok('simulator', 'Meter simulator', `mode=${flags.meterIot?.mode || 'manual'}`);
  }
  if (flags.citizenIdEncryption && !flags.citizenIdEncryption.enabled) {
    warn('citizen_enc', 'Citizen ID encryption',
      'ปิดอยู่ — citizen ID ถูกเก็บเป็น plaintext',
      'เปิดที่หน้า Features (ข้อมูลใหม่จะถูกเข้ารหัส; ของเก่ายังเป็น plaintext)');
  } else {
    ok('citizen_enc', 'Citizen ID encryption', 'เปิดอยู่');
  }
  if (flags.autoBackup && flags.autoBackup.enabled) {
    const r2 = !!(sec.get('R2_ACCESS_KEY_ID') && sec.get('R2_BUCKET'));
    if (!r2) {
      warn('backup_target', 'Auto-backup target',
        'autoBackup เปิด แต่ R2 ไม่ได้ตั้งค่า — backup เก็บบน container disk (หายเมื่อ redeploy)',
        'ตั้งค่า R2_* ที่ Settings → Secrets');
    } else {
      ok('backup_target', 'Auto-backup target', 'R2 พร้อม');
    }
  } else {
    warn('autobackup', 'Auto-backup',
      'autoBackup ปิดอยู่ — ต้อง backup ด้วยมือ',
      'เปิดที่หน้า Features (แนะนำให้เปิดเสมอใน production)');
  }
  if (flags.errorTracking && flags.errorTracking.enabled) {
    const dsn = sec.get('SENTRY_DSN') || process.env.SENTRY_DSN;
    if (!dsn) {
      warn('sentry', 'Error tracking',
        'errorTracking เปิด แต่ SENTRY_DSN ว่าง',
        'ใส่ DSN ที่ Settings → Secrets');
    } else {
      ok('sentry', 'Error tracking', 'Sentry พร้อม');
    }
  }

  // 7. Real data signal vs default (helps spot fresh deploys vs live ones)
  try {
    const c = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM tenants WHERE deleted_at IS NULL) AS tenants,
        (SELECT COUNT(*)::int FROM bills   WHERE deleted_at IS NULL) AS bills,
        (SELECT COUNT(*)::int FROM contracts WHERE deleted_at IS NULL) AS contracts,
        (SELECT COUNT(*)::int FROM line_oas  WHERE deleted_at IS NULL) AS line_oas
    `);
    const cnt = c.rows[0];
    if (cnt.tenants === 0 && cnt.bills === 0) {
      warn('data_volume', 'ปริมาณข้อมูล',
        `ยังไม่มี tenant/bill ในระบบ — ดูเหมือนยังไม่ได้เริ่มใช้งานจริง`,
        'เพิ่มผู้เช่าและออกบิลเดือนแรกเพื่อทดสอบ flow ทั้งหมด');
    } else {
      ok('data_volume', 'ปริมาณข้อมูล',
        `${cnt.tenants} tenants · ${cnt.bills} bills · ${cnt.contracts} contracts · ${cnt.line_oas} OA`);
    }
  } catch (err) {
    warn('data_volume_read', 'อ่านปริมาณข้อมูล', err.message);
  }

  // Summarise — count fail / warn for badge
  const summary = {
    fail: checks.filter((c) => c.status === 'fail').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    ok:   checks.filter((c) => c.status === 'ok').length,
    total: checks.length,
  };
  // Production-ready when zero fails AND warnings ≤ N (here 2: tolerable
  // soft-warnings like "1 warn for staging-quality config"). Operator can
  // gate "go live" on this in their runbook.
  const ready = summary.fail === 0 && summary.warn <= 2;
  res.json({
    ok: true,
    ready,
    nodeEnv: NODE_ENV,
    summary,
    checks,
    checkedAt: new Date().toISOString(),
  });
});

// Detailed admin-only health dashboard. Aggregates every subsystem probe
// (DB, schema sanity, LINE OA, SMTP, R2, queue, lockouts, scheduler) into
// one report with status+detail per check. Owner|manager only — exposes
// failure messages that could reveal config to a less-privileged role.
app.get('/api/admin/health', requireAuth, requireRole('owner', 'manager'), async (_req, res) => {
  try {
    const healthCheck = require('./services/healthCheck');
    const report = await healthCheck.runChecks(pool);
    res.json({ ok: true, ...report });
  } catch (err) {
    console.error('admin health error:', err.message);
    res.status(500).json({ ok: false, error: 'health probe failed', message: err.message });
  }
});

// Returns 200 when db is reachable, 503 when degraded so Railway/upstream
// LBs can route around bad replicas.
app.get('/health', async (_req, res) => {
  const out = {
    status: 'ok',
    time: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
  // DB probe with timing
  const t0 = Date.now();
  try {
    await pool.query('SELECT 1');
    out.db = { status: 'ok', latency_ms: Date.now() - t0 };
  } catch (err) {
    out.status = 'degraded';
    out.db = { status: 'down', error: sanitizeError(err) };
  }
  // Notification queue depth — large pending = something stuck
  try {
    const q = await pool.query(`SELECT
      COUNT(*) FILTER (WHERE status='pending')::int AS pending,
      COUNT(*) FILTER (WHERE status='failed')::int AS failed
      FROM notifications_queue WHERE created_at > NOW() - INTERVAL '24 hours'`);
    out.queue = q.rows[0];
  } catch { out.queue = null; }
  // Scheduler heartbeat — last-fired keys from state file. In diagnostic
  // mode, background jobs are intentionally disabled; do not surface stale
  // scheduler errors from a prior production run as current health.
  if (DISABLE_BACKGROUND_JOBS) {
    out.scheduler = { disabled: true, reason: 'DISABLE_BACKGROUND_JOBS=1' };
  } else {
    // Match the candidate list services/healthCheck.js uses so /health and
    // /api/admin/health agree on which file the scheduler is writing to.
    // Previously /health hard-coded ./.scheduler-state.json while admin UI
    // and the healthCheck probe walked SCHEDULER_STATE_FILE → UPLOAD_DIR →
    // app dir → tmpdir, producing diverging "scheduler last seen" reports.
    try {
      const fs = require('fs');
      const path = require('path');
      const candidates = [
        process.env.SCHEDULER_STATE_FILE,
        process.env.UPLOAD_DIR && path.join(process.env.UPLOAD_DIR, 'scheduler-state.json'),
        path.join(__dirname, '.scheduler-state.json'),
        path.join(require('os').tmpdir(), 'baankarn-scheduler-state.json'),
      ].filter(Boolean);
      for (const sf of candidates) {
        try {
          if (fs.existsSync(sf)) {
            out.scheduler = JSON.parse(fs.readFileSync(sf, 'utf8'));
            out.scheduler._statePath = sf;  // surface which file we read
            break;
          }
        } catch { /* try next candidate */ }
      }
    } catch { /* ignore */ }
  }
  // Secrets status — count, no values
  try {
    const c = await pool.query('SELECT COUNT(*)::int AS n FROM secrets');
    out.secrets = { in_db: c.rows[0].n };
  } catch { out.secrets = null; }

  res.status(out.status === 'ok' ? 200 : 503).json(out);
});

// /health/live → minimal probe for Kubernetes-style liveness checks.
// No DB call — server is "alive" if Node is responsive.
app.get('/health/live', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// --- Static + routes ------------------------------------------------------
// Asset caching policy:
//   - .jsx (transpiled in browser, changes every deploy) → no-cache so a fix
//     deployed to Railway is visible the moment the user reloads. Without
//     this, operators who hit a bug then deploy a fix still see the bug for
//     up to an hour because Cache-Control: max-age=3600 holds the old file.
//   - Other static assets (fonts, images) → 1h TTL since they rarely change.
app.use((req, res, next) => {
  if (/\.jsx$/i.test(req.path)) {
    // Force-revalidate on every reload — JSX files are the SPA's source of truth.
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  } else if (/\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ttf)$/i.test(req.path)) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'project'), { redirect: false }));

// Files (slips, room photos, signatures, citizen-ID images) are sensitive
// PII. Instead of mounting uploads/ as a public static path, we proxy through
// /files/:id with auth gating: admins see everything; tenants see only their
// own uploads. URLs that leaked to logs/chats are still useless without auth.
storage.ensureDir(storage.rootPath());
app.get('/files/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).end();
  try {
    const { rows } = await pool.query(
      'SELECT category, filename, mime_type, uploaded_by, storage FROM file_uploads WHERE id=$1',
      [id]
    );
    if (!rows.length) return res.status(404).end();
    const f = rows[0];
    const isAdmin = !!(req.session && req.session.user);
    let allowed = isAdmin;
    if (!allowed) {
      // Tenant: allow only own uploads (uploaded_by === 'tenant:<id>')
      const tSession = await tenantSessionLookup(req);
      if (tSession && f.uploaded_by === `tenant:${tSession.tenant_id}`) allowed = true;
    }
    if (!allowed) return res.status(403).end();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Sensitive PII categories must not be cached on disk — Cache-Control:
    // no-store keeps slips and citizen-ID images out of the browser cache so
    // they're not recoverable after logout. room_photo is non-sensitive and
    // can keep a short private cache for SPA performance.
    const SENSITIVE_CATEGORIES = new Set(['slip', 'citizen_id_image', 'contract_signature']);
    if (SENSITIVE_CATEGORIES.has(f.category)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
      // Force download for sensitive files so a forged mime-type can't be
      // rendered inline (defense-in-depth on top of nosniff).
      const safeName = String(f.filename || `file-${id}`).replace(/[^\w.\-]/g, '_').slice(0, 80);
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    } else {
      res.setHeader('Cache-Control', 'private, max-age=300');
    }
    if (f.mime_type) res.setHeader('Content-Type', f.mime_type);
    // Stream-of-bytes path supports both local disk and R2 transparently
    // (storage.readFile picks the backend). Local: still an in-memory read,
    // but slip/photo limits cap at ~1.5MB so this is fine.
    if (f.storage === 's3') {
      const buf = await storage.readFile(f);
      if (!buf) return res.status(404).end();
      return res.end(buf);
    }
    const fp = path.join(storage.rootPath(), f.category, f.filename);
    res.sendFile(fp, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  } catch (err) {
    console.error('files proxy error:', err);
    if (!res.headersSent) res.status(500).end();
  }
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'project', 'Dorm Status Dashboard.html'));
});

app.get('/admin', (req, res) => {
  // If not logged in, redirect to login page
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  res.sendFile(path.join(__dirname, 'project', 'Admin Dashboard.html'));
});

app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, 'project', 'login.html'));
});

app.get('/book', (_req, res) => {
  res.sendFile(path.join(__dirname, 'project', 'booking.html'));
});

app.get('/maintenance', (_req, res) => {
  res.sendFile(path.join(__dirname, 'project', 'maintenance.html'));
});

app.get('/tenant', (_req, res) => {
  res.sendFile(path.join(__dirname, 'project', 'tenant.html'));
});

// Public contract-fill landing page. The :token segment is consumed by
// the client-side React component (it reads window.location.pathname),
// so the server just serves the HTML shell.
app.get('/contract/fill/:token', (_req, res) => {
  res.sendFile(path.join(__dirname, 'project', 'contract-fill.html'));
});

// Final Express error handler — captures unhandled route errors so they
// reach Sentry (when enabled) instead of disappearing into the server log.
// Error response always includes:
//   - error: human-readable message
//   - code: machine code (UNAUTHORIZED, RATE_LIMIT, DB_ERROR, ...)
//   - requestId: req.id — admin can paste this when reporting bugs
//   - timestamp: ISO so logs + UI report stay correlated
app.use((err, req, res, _next) => {
  const reqId = req.id || '-';
  console.error(`[${reqId}] unhandled:`, sanitizeError(err));
  sentry.captureException(err, { reqId, path: req.path, method: req.method });
  if (res.headersSent) return;
  // Don't leak stack/internals to the client. Surface a stable error code
  // for the frontend to branch on; the real detail goes to logs + Sentry.
  res.status(err.status || 500).json({
    error: NODE_ENV === 'production' ? 'internal error' : sanitizeError(err),
    code: err.code || 'INTERNAL_ERROR',
    requestId: reqId,
    timestamp: new Date().toISOString(),
  });
});

// Catch-all 404 for /api/* — without this, Express falls through to the
// SPA static handler and returns HTML for unknown API paths, which the
// frontend then tries to JSON.parse and shows a confusing "Unexpected token <"
// error. JSON 404 makes debugging instant.
app.use('/api', (req, res) => {
  res.status(404).json({
    error: 'route not found',
    code: 'NOT_FOUND',
    requestId: req.id,
    path: req.path,
    method: req.method,
  });
});

// --- Boot -----------------------------------------------------------------
// Background job: prune time-bounded tables hourly. Each retention window
// is independent so we can age out audit aggressively while keeping
// notifications shorter.
let _prunerInterval = null;
function startAuditPruner() {
  const prune = async () => {
    const stats = {};
    const tasks = [
      ['audit_logs',         `DELETE FROM audit_logs WHERE created_at < NOW() - INTERVAL '180 days'`],
      ['tenant_sessions',    `DELETE FROM tenant_sessions WHERE expire < NOW()`],
      ['notifications_log',  `DELETE FROM notifications_log WHERE created_at < NOW() - INTERVAL '90 days'`],
      ['notifications_queue',`DELETE FROM notifications_queue WHERE status='sent' AND sent_at < NOW() - INTERVAL '14 days'`],
      // Failed rows accumulate too — manual retry resets them, but rows
      // nobody touches stay forever. Keep 30 days of forensics then drop.
      ['notifications_queue_failed', `DELETE FROM notifications_queue WHERE status='failed' AND created_at < NOW() - INTERVAL '30 days'`],
      ['access_logs',        `DELETE FROM access_logs WHERE occurred_at < NOW() - INTERVAL '180 days'`],
      ['login_lockouts',     `DELETE FROM login_lockouts WHERE last_fail_at < NOW() - INTERVAL '30 days' AND (locked_until IS NULL OR locked_until < NOW())`],
      // meter_readings can grow fast — simulator mode adds 2 rows/room/hour,
      // and even a small dorm with 50 rooms generates ~50k rows/month. We
      // only need ~12 months for year-over-year comparisons + the σ-anomaly
      // detector reads the latest 30 rows, so 365 days is plenty.
      ['meter_readings',     `DELETE FROM meter_readings WHERE reading_at < NOW() - INTERVAL '365 days'`],
    ];
    for (const [name, sql] of tasks) {
      try {
        const r = await pool.query(sql);
        if (r.rowCount) stats[name] = r.rowCount;
      } catch (err) {
        console.error(`[prune] ${name} failed:`, sanitizeError(err));
      }
    }
    // Slip-file orphan cleanup: file_uploads rows in category 'slip' older
    // than 180 days that no payment row points to are unreachable and just
    // burn disk/R2 storage. Common causes:
    //   - 23505 race-condition rejected uploads where the in-tx cleanup
    //     was best-effort and missed
    //   - admin running scripts/strip-payments-base64 (NULLs slip_url)
    //   - hard-deleted payment rows (rare; soft-delete is default)
    // We use the storage helper so the on-disk / S3 file is also removed,
    // not just the row. Bound to 50 per run so a long-tail backlog doesn't
    // hammer R2 in one shot.
    try {
      const { rows: orphans } = await pool.query(
        `SELECT id FROM file_uploads
           WHERE category='slip' AND uploaded_at < NOW() - INTERVAL '180 days'
             AND NOT EXISTS (
               SELECT 1 FROM payments p
                WHERE p.slip_url = '/files/' || file_uploads.id::text
             )
           LIMIT 50`
      );
      let cleaned = 0;
      const storage = require('./services/storage');
      for (const r of orphans) {
        try {
          if (await storage.remove(pool, r.id)) cleaned++;
        } catch (err) {
          console.warn(`[prune] orphan slip ${r.id} failed:`, err.message);
        }
      }
      if (cleaned) stats.orphan_slips = cleaned;
    } catch (err) {
      console.error('[prune] orphan_slips failed:', sanitizeError(err));
    }
    if (Object.keys(stats).length) console.log('[prune]', stats);
  };
  prune();
  _prunerInterval = setInterval(prune, 60 * 60 * 1000);
  _prunerInterval.unref();
}
function stopAuditPruner() {
  if (_prunerInterval) clearInterval(_prunerInterval);
  _prunerInterval = null;
}

migrate()
  .then(async () => {
    // Run per-router bootstrap blocks (rooms_v2 table, etc).
    if (_routesMounted && Array.isArray(_routesMounted.bootstraps)) {
      for (const fn of _routesMounted.bootstraps) {
        try { await fn(); }
        catch (err) { console.error('[boot] router bootstrap failed:', err.message); }
      }
    }
    // Load secrets BEFORE Sentry init / scheduler start so any consumer
    // that reads via secrets.get() sees DB-backed values from boot 0.
    try { await require('./services/secrets').preload(pool); }
    catch (err) { console.warn('[boot] secrets preload skipped:', err.message); }

    // A6 — sanity check critical security secrets at boot. These never
    // crash startup; they just print a loud warning so operators see the
    // gap in Railway logs before the first real request needs them.
    {
      const sec = require('./services/secrets');
      if (sec.get('LINE_CHANNEL_ACCESS_TOKEN') && !sec.get('LINE_CHANNEL_SECRET')) {
        console.warn(
          '[boot] WARNING: LINE_CHANNEL_ACCESS_TOKEN is set but LINE_CHANNEL_SECRET is not. ' +
          'Webhook signature verification will reject every request — set the secret in /admin#secrets.'
        );
      }
      if (NODE_ENV === 'production' && !process.env.CITIZEN_ID_KEY && !process.env.ENCRYPTION_KEY_V1) {
        console.warn(
          '[boot] WARNING: no CITIZEN_ID_KEY / ENCRYPTION_KEY_V1 set — citizen-id encryption ' +
          'falls back to HKDF(SESSION_SECRET). Rotate to a dedicated key in production.'
        );
      }
      // Hard-fail boot if encryption is configured but broken — much better
      // than crashing the first user-visible write to secrets/line_oas.
      try {
        const enc = require('./services/encryption');
        const status = enc.validateAtBoot();
        if (status.mode === 'versioned') {
          console.log(`[boot] encryption: versioned (current=v${status.current}, loaded=[${status.loaded.join(',')}])`);
        }
      } catch (err) {
        console.error(err.message);
        if (NODE_ENV === 'production') {
          console.error('[boot] refusing to start: encryption is misconfigured');
          process.exit(1);
        }
      }
    }
    // Optional Sentry init — no-op if errorTracking flag is off.
    try {
      const flags = await features.load(pool);
      sentry.init(flags);

      // Production-readiness summary at boot. Logs once at startup so
      // operators see the gap before the first user request — much earlier
      // than waiting for them to load /admin#health. Mirrors the
      // /api/admin/production-readiness endpoint logic but lives in-process
      // so it runs every restart.
      if (NODE_ENV === 'production') {
        const issues = [];
        if (flags.meterIot && flags.meterIot.mode === 'simulator') {
          issues.push('🔴 meterIot.mode=simulator (จะถูก scheduler block แต่ flag ยังตั้งผิด)');
        }
        if (flags.autoBackup && flags.autoBackup.enabled) {
          const sec = require('./services/secrets');
          if (!sec.get('R2_ACCESS_KEY_ID') || !sec.get('R2_BUCKET')) {
            issues.push('🟡 autoBackup ON but R2 not configured (backup จะหายเมื่อ redeploy)');
          }
        }
        const cfgRow = await pool.query(`SELECT value FROM app_data WHERE key='baankarn_config_v1'`);
        const cfg = cfgRow.rows.length ? cfgRow.rows[0].value : {};
        const b = (cfg && cfg.building) || {};
        if (!b.address || !b.phone) {
          issues.push('🟡 ข้อมูลตึก (address/phone) ยังไม่ครบ');
        }
        const sec = require('./services/secrets');
        const ppDb = (cfg && cfg.payment) ? (cfg.payment.promptpay || cfg.payment.promptpayTarget) : null;
        if (!ppDb && !sec.get('PROMPTPAY_TARGET')) {
          issues.push('🔴 PROMPTPAY_TARGET ยังไม่ตั้ง — บิล PDF จะไม่มี QR');
        }
        const ownersQ = await pool.query(`SELECT COUNT(*)::int n, MIN(username) u FROM auth_users WHERE role='owner'`);
        const oc = ownersQ.rows[0];
        if (oc.n === 0) issues.push('🔴 ไม่มี owner — ระบบล็อกตัวเอง');
        else if (oc.n === 1 && oc.u === 'admin') {
          issues.push('🟡 มี owner คนเดียว (default username "admin") — แนะนำสร้างคนที่สอง');
        }
        if (issues.length) {
          console.warn('[boot] production-readiness issues:');
          for (const i of issues) console.warn('  ' + i);
          console.warn('[boot] ดูทั้งหมด: GET /api/admin/production-readiness');
        } else {
          console.log('[boot] ✅ production-readiness: all checks passed');
        }
      }
    } catch (err) {
      console.warn('[boot] features load failed:', err.message);
    }
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`[server] listening on ${PORT} (NODE_ENV=${NODE_ENV})`);
      console.log(`[server] tenant public: /, /book, /maintenance`);
      console.log(`[server] tenant portal: /tenant`);
      console.log(`[server] admin:   /admin`);
      console.log(`[server] login:   /login`);
      console.log(`[server] health:  /health`);
    });
    if (DISABLE_BACKGROUND_JOBS) {
      console.warn('[server] background jobs disabled via DISABLE_BACKGROUND_JOBS=1');
    } else {
      startAuditPruner();
      scheduler.start(pool);
      notifQueue.start(pool, () => features.load(pool));
    }

    // Graceful shutdown: drain in-flight requests before closing the DB pool
    // so Railway restarts don't kill mid-request work.
    const shutdown = (signal) => {
      console.log(`[server] ${signal} received, shutting down gracefully`);
      // Cancel the background pruner so its DELETE doesn't race with pool.end()
      stopAuditPruner();
      scheduler.stop();
      notifQueue.stop();
      server.close(() => {
        pool.end(() => {
          console.log('[server] closed cleanly');
          process.exit(0);
        });
      });
      // Hard-exit safety net: if shutdown takes too long, kill anyway.
      setTimeout(() => {
        console.error('[server] graceful shutdown timeout, forcing exit');
        process.exit(1);
      }, 10_000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));
  })
  .catch((err) => {
    console.error('FATAL: migration failed:', sanitizeError(err));
    process.exit(1);
  });
