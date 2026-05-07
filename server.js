// === Production server: Express + PostgreSQL + sessions ====================
// - Serves static React app from project/
// - REST API: /api/data/:key (GET public, PUT admin-only) backed by JSONB store
// - Auth: /api/auth/login (bcrypt + session), /api/auth/me, /api/auth/logout
// - Schema migration runs on boot; bootstraps single admin user from env vars

const express = require('express');
const path = require('path');
const { Pool } = require('pg');
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

    const { rows } = await pool.query(
      'SELECT id, username, password_hash, role FROM auth_users WHERE username=$1',
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

// Fields in baankarn_config_v1 that are operator-internal — strip when public.
function maskConfigPublic(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const c = { ...cfg };
  if (c.payment) {
    c.payment = {
      promptpayDisplayName: c.payment.promptpayDisplayName || c.payment.bankName,
      promptpayTarget: c.payment.promptpay || c.payment.promptpayTarget,
    };
  }
  delete c.users; delete c.notification; delete c.automation;
  return c;
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
  try {
    await pool.query('DELETE FROM app_data WHERE key=$1', [key]);
    audit(req, 'data.delete', 'app_data', key);
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
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
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
  };
  if (!cleaned.tenantName.trim()) {
    return res.status(400).json({ error: 'tenantName required' });
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
    deposit: 0,
    status: 'pending',
    createdAt: new Date().toISOString(),
    email: cleaned.email,
    message: cleaned.message,
    source: 'public-form',
    roomId: cleaned.roomId,
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
    const { rows } = await pool.query(
      `SELECT id, ticket_no, room_id, category, priority, status, title, created_at, completed_at, rating
         FROM maintenance_tickets
         WHERE tenant_phone = $1 AND room_id = $2
         ORDER BY created_at DESC LIMIT 50`,
      [phone, roomId]
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
    if (b.status === 'completed') {
      try {
        const t = rows[0];
        // Look up the bound tenant (so we have line_user_id + line_oa_id).
        const tq = await pool.query(
          `SELECT id, full_name, phone, email, line_user_id, line_oa_id
             FROM tenants
             WHERE phone=$1 AND deleted_at IS NULL
             ORDER BY updated_at DESC LIMIT 1`,
          [t.tenant_phone || '']
        );
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
app.post('/api/maintenance/:id/rate', sameOrigin, validateBody(schemas.rateTicket), async (req, res) => {
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
app.get('/api/reports/overview', requireAuth, async (_req, res) => {
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

// GET /api/reports/aged-receivable — admin-auth. Bins overdue rooms by how
// many days overdue. Reads from app_data rooms (which carry overdueDays).
app.get('/api/reports/aged-receivable', requireAuth, async (_req, res) => {
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

// GET /api/reports/bills.xlsx — admin-auth. Streams an Excel workbook of
// the current-month bill estimates for every room.
app.get('/api/reports/bills.xlsx', requireAuth, async (_req, res) => {
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
                    AVG(cost)::numeric(10,2) FILTER (WHERE cost > 0) AS avg_cost,
                    COUNT(*) FILTER (WHERE cost > 0) AS billed_count,
                    SUM(cost) FILTER (WHERE status='completed')::numeric(12,2) AS completed_cost
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
        'gracePeriodDays', 'requirePin', 'mode', 'autoIncludeOnBillGen',
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
    const { rows } = await pool.query(
      `SELECT id, full_name, phone, email, line_user_id, current_room_id, status,
              citizen_id_encrypted, citizen_id_tail, notes, locale, blacklist_reason,
              created_at, updated_at
         FROM tenants WHERE id=$1 AND deleted_at IS NULL`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const flags = await features.load(pool);
    const out = maskTenantOut(rows[0]);
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

app.post('/api/tenants', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  const b = req.body || {};
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const fullName = str(b.fullName, 200).trim();
  const phone = str(b.phone, 32).trim();
  if (!fullName || !phone) {
    return res.status(400).json({ error: 'fullName and phone required' });
  }
  const flags = await features.load(pool);
  const citizenId = str(b.citizenId, 32).replace(/[^0-9]/g, '');
  let citizenEnc = null, citizenTail = null;
  if (citizenId) {
    citizenTail = citizenId.slice(-4);
    if (flags.citizenIdEncryption && flags.citizenIdEncryption.enabled) {
      try { citizenEnc = cryptoSvc.encryptString(citizenId); }
      catch (e) {
        return res.status(500).json({ error: 'crypto unavailable: ' + e.message });
      }
    } else {
      citizenEnc = citizenId; // plaintext — not recommended
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
  try {
    const { rows } = await pool.query(
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
    );
    audit(req, 'tenant.create', 'tenant', String(rows[0].id));
    res.json({ ok: true, tenant: rows[0] });
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
  if (b.phone !== undefined) set('phone', String(b.phone).slice(0, 32));
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
    const cid = String(b.citizenId || '').replace(/[^0-9]/g, '');
    if (cid) {
      const flags = await features.load(pool);
      try {
        const enc = (flags.citizenIdEncryption && flags.citizenIdEncryption.enabled)
          ? cryptoSvc.encryptString(cid) : cid;
        set('citizen_id_encrypted', enc);
        set('citizen_id_tail', cid.slice(-4));
      } catch (e) { return res.status(500).json({ error: 'crypto: ' + e.message }); }
    } else {
      set('citizen_id_encrypted', null); set('citizen_id_tail', null);
    }
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

app.post('/api/tenant/login', sameOrigin, rateLimitTenantLogin, features.requireFeature('tenantPortal'), async (req, res) => {
  const phone = String(req.body?.phone || '').trim().slice(0, 32);
  const pin = String(req.body?.pin || '').trim().slice(0, 16);
  if (!phone || !pin) return res.status(400).json({ error: 'phone and pin required' });
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
    const { rows } = await pool.query(
      `SELECT p.id, p.bill_id, p.amount, p.method, p.slip_url,
              p.status, p.verified_at, p.rejected_reason, p.created_at,
              b.bill_no, b.period
         FROM payments p
         LEFT JOIN bills b ON b.id = p.bill_id
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
  try {
    const { rows } = await pool.query(
      `SELECT * FROM bills WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC LIMIT 500`, params
    );
    res.json({ ok: true, bills: rows });
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
      recurringList = dbRecurring.map((r) => ({ label: r.label, amount: Number(r.amount) }));
      usedOneOffIds = dbRecurring.filter((r) => r.frequency === 'one_off').map((r) => r.id);
    }
    computed = billing.buildBill({
      room, config, features: flags,
      previous,
      recurring: recurringList,
      period: b.period, dueDate: b.dueDate,
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
  try {
    const { rows } = await pool.query(
      `UPDATE bills SET status='void', void_reason=$1 WHERE id=$2 AND status<>'paid' RETURNING *`,
      [reason, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found or already paid' });
    audit(req, 'bill.void', 'bill', String(id), { reason });
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
    // Hash the actual slip bytes BEFORE saving so dedup works (prior version
    // hashed the URL+size which were always unique → unique index never
    // triggered).
    const rawBuf = Buffer.from(String(b.slip || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
    const slipHash = cryptoSvc.hmac(rawBuf);
    const dup = await pool.query('SELECT id FROM payments WHERE slip_hash=$1 LIMIT 1', [slipHash]);
    if (dup.rows.length) return res.status(409).json({ error: 'duplicate slip' });

    const slip = await storage.saveBase64({
      pool,
      category: 'slip',
      dataUrl: b.slip,
      refId: String(billId),
      uploadedBy: `tenant:${req.tenant.tenant_id}`,
      maxBytes: req.features.slipUpload.maxBytes || 1_500_000,
      allowedMimes: req.features.slipUpload.allowedMimes || ['image/jpeg', 'image/png', 'image/webp'],
    });
    // Atomic: payment INSERT + (optional) bill mark-paid run in one tx so
    // we never end up with a verified payment row pointing at a bill still
    // marked 'pending', or vice-versa, if either statement crashes mid-way.
    let row;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        const ins = await client.query(
          `INSERT INTO payments (bill_id, tenant_id, amount, method, slip_url, slip_hash, status)
           VALUES ($1,$2,$3,'promptpay',$4,$5,$6)
           RETURNING *`,
          [billId, req.tenant.tenant_id, amount, slip.url, slipHash,
           req.features.slipUpload.requireVerification ? 'pending' : 'verified']
        );
        row = ins.rows[0];
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err.code === '23505') return res.status(409).json({ error: 'duplicate slip' });
        throw err;
      }
      if (!req.features.slipUpload.requireVerification) {
        await client.query(`UPDATE bills SET status='paid', paid_at=NOW() WHERE id=$1 AND status<>'paid'`, [billId]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    audit(req, 'tenant.slip_upload', 'payment', String(row.id),
      { billId, amount, autoVerified: !req.features.slipUpload.requireVerification },
      `tenant:${req.tenant.tenant_id}`).catch(() => {});
    notifier.notifyOwner(
      { pool, features: req.features },
      { subject: 'มีผู้ส่งสลิปชำระเงินใหม่',
        text: `บิล #${billId} จำนวน ${amount.toLocaleString('th-TH')} บาท จาก ${req.tenant.full_name} (${req.tenant.phone})` }
    ).catch(() => {});
    res.json({ ok: true, payment: row });
  } catch (err) {
    console.error('tenant payment error:', err);
    res.status(400).json({ error: err.message || 'upload failed' });
  }
});

app.get('/api/payments', requireAuth, async (req, res) => {
  const status = req.query.status;
  const params = [];
  const where = [];
  if (status && ['pending', 'verified', 'rejected'].includes(String(status))) {
    params.push(status); where.push(`p.status=$${params.length}`);
  }
  try {
    const { rows } = await pool.query(
      `SELECT p.*, b.bill_no, b.period, t.full_name AS tenant_name, t.phone AS tenant_phone
         FROM payments p
         LEFT JOIN bills b ON b.id = p.bill_id
         LEFT JOIN tenants t ON t.id = p.tenant_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY p.created_at DESC LIMIT 500`, params
    );
    res.json({ ok: true, payments: rows });
  } catch (err) {
    console.error('payments list error:', err);
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
  const reason = String(req.body?.reason || '').slice(0, 500);
  try {
    if (accept) {
      const { rows } = await pool.query(
        `UPDATE payments SET status='verified', verified_by=$1, verified_at=NOW()
           WHERE id=$2 AND status='pending' RETURNING *`,
        [req.session.user.username, id]
      );
      if (!rows.length) return res.status(404).json({ error: 'not found or already decided' });
      if (rows[0].bill_id) {
        await pool.query(`UPDATE bills SET status='paid', paid_at=NOW() WHERE id=$1 AND status<>'paid'`, [rows[0].bill_id]);
      }
      audit(req, 'payment.verify', 'payment', String(id), { billId: rows[0].bill_id, amount: rows[0].amount });
      // Notify the tenant fire-and-forget
      notifyTenantOnPayment(rows[0], 'verified').catch(() => {});
      res.json({ ok: true, payment: rows[0] });
    } else {
      const { rows } = await pool.query(
        `UPDATE payments SET status='rejected', verified_by=$1, verified_at=NOW(), rejected_reason=$2
           WHERE id=$3 AND status='pending' RETURNING *`,
        [req.session.user.username, reason, id]
      );
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      audit(req, 'payment.reject', 'payment', String(id), { reason, billId: rows[0].bill_id });
      notifyTenantOnPayment(rows[0], 'rejected', reason).catch(() => {});
      res.json({ ok: true, payment: rows[0] });
    }
  } catch (err) {
    console.error('payment verify error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Helper for both verify endpoints — pushes a notification to the tenant
// when their slip is verified or rejected. Fire-and-forget; logs to
// notifications_log via notifier.
async function notifyTenantOnPayment(payment, outcome, reason) {
  if (!payment || !payment.tenant_id) return;
  try {
    const flags = await features.load(pool);
    const { rows } = await pool.query(
      `SELECT id, full_name, phone, email, line_user_id, line_oa_id
         FROM tenants
         WHERE id=$1 AND deleted_at IS NULL`,
      [payment.tenant_id]
    );
    if (!rows.length) return;
    const t = rows[0];
    const subject = outcome === 'verified' ? '✅ ตรวจสอบการชำระเงินแล้ว' : '❌ สลิปไม่ผ่านการตรวจสอบ';
    const amt = Number(payment.amount);
    const amtStr = Number.isFinite(amt) ? amt.toLocaleString('th-TH', { minimumFractionDigits: 2 }) : '-';
    const lines = [
      outcome === 'verified'
        ? `ชำระเงินบิล #${payment.bill_id || '-'} จำนวน ${amtStr} บาท ได้รับการยืนยันแล้ว`
        : `สลิปสำหรับบิล #${payment.bill_id || '-'} ไม่ผ่านการตรวจสอบ`,
      reason ? `เหตุผล: ${reason}` : null,
      'ติดต่อเจ้าหน้าที่หากมีข้อสงสัย',
    ].filter(Boolean);
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

const BOOKING_STATUSES = new Set(['pending', 'reviewing', 'approved', 'rejected', 'cancelled']);
const BOOKING_TRANSITIONS = {
  pending:   ['reviewing', 'approved', 'rejected', 'cancelled'],
  reviewing: ['approved', 'rejected', 'cancelled'],
  approved:  ['cancelled'],          // can revoke an approval if tenant backs out
  rejected:  ['reviewing'],          // re-open if admin reconsidered
  cancelled: [],                     // terminal
};

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

        // Tenant notification — only if we have a contact channel.
        const tenantText = ({
          approved: `✅ การจองห้องได้รับการอนุมัติแล้ว\nกรุณาติดต่อสำนักงานเพื่อเซ็นสัญญา`,
          rejected: `❌ ขออภัย — การจองห้องไม่ได้รับการอนุมัติ\n${updated.adminNotes ? 'หมายเหตุ: ' + updated.adminNotes : ''}`,
          reviewing: `🔍 การจองของคุณกำลังถูกตรวจสอบ`,
          cancelled: `🚫 การจองถูกยกเลิก`,
        })[updated.status];
        if (tenantText && updated.email) {
          notifier.notifyTenant({ pool, features: flags },
            { full_name: updated.name, email: updated.email, phone: updated.phone },
            { subject: `อัปเดตสถานะการจองห้อง — ${updated.status}`, text: tenantText }
          ).catch(() => {});
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
  try {
    const out = await storage.saveBase64({
      pool,
      category,
      dataUrl: b.dataUrl,
      refId: b.refId ? String(b.refId).slice(0, 64) : null,
      uploadedBy: req.session.user.username,
      maxBytes: req.features.photoUpload.maxBytes || 1_500_000,
    });
    audit(req, 'upload.create', 'file', String(out.id), { category });
    res.json({ ok: true, file: out });
  } catch (err) {
    res.status(400).json({ error: err.message || 'upload failed' });
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
      notifier.notifyOwner(
        { pool, features: flags },
        { subject: '⚠️ มิเตอร์ผิดปกติ',
          text: `ห้อง ${roomId} (${row.meter_type}) z=${Number(anomaly.z).toFixed(2)} เกิน ${sigmas}σ\nค่าล่าสุด: ${anomaly.last}, ค่าเฉลี่ย: ${Number(anomaly.mean).toFixed(2)}` }
      ).catch(() => {});
      audit(req, 'meter.anomaly', 'meter', String(row.id),
        { z: anomaly.z, sigmas, mean: anomaly.mean });
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
    if (!rows.length) return;
    // Map owner usernames → tenant rows (line_user_id + line_oa_id) via
    // tenants table (admins are sometimes also tenants who bound LINE).
    // Then route through notifier.notifyTenant so the multi-OA dispatcher
    // resolves which OA to push through. Falls back to email when the
    // owner has no LINE binding.
    for (const o of rows) {
      try {
        const t = await pool.query(
          `SELECT id, full_name, phone, email, line_user_id, line_oa_id
             FROM tenants
             WHERE phone=$1 OR full_name=$2
             LIMIT 1`,
          [o.username, o.username]
        );
        if (!t.rows.length) continue;
        await notifier.notifyTenant(
          { pool, features: flags },
          t.rows[0],
          { subject: msg.subject, text: msg.text }
        );
        continue;
      } catch { /* per-owner failure is fine */ }
    }
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

// === v2: Notification queue admin endpoints ===============================
const notifQueue = require('./services/notificationQueue');

app.get('/api/admin/notifications', requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  const status = String(req.query.status || '').slice(0, 16);
  const params = [];
  let where = '';
  if (['pending', 'sent', 'failed'].includes(status)) {
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
//   scheduler   : last fired key from .scheduler-state.json (sanity check)
//   queue       : count of pending notifications (visibility on backlog)
//   secrets     : 'configured' / 'partial' / 'none' (no values, just shape)
//   uptime      : process uptime in seconds
//   memory_mb   : RSS in MB
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
  // Scheduler heartbeat — last-fired keys from state file
  try {
    const fs = require('fs');
    const path = require('path');
    const sf = path.join(__dirname, '.scheduler-state.json');
    if (fs.existsSync(sf)) {
      out.scheduler = JSON.parse(fs.readFileSync(sf, 'utf8'));
    }
  } catch { /* ignore */ }
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
app.use(express.static(path.join(__dirname, 'project')));

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
      ['access_logs',        `DELETE FROM access_logs WHERE occurred_at < NOW() - INTERVAL '180 days'`],
      ['login_lockouts',     `DELETE FROM login_lockouts WHERE last_fail_at < NOW() - INTERVAL '30 days' AND (locked_until IS NULL OR locked_until < NOW())`],
    ];
    for (const [name, sql] of tasks) {
      try {
        const r = await pool.query(sql);
        if (r.rowCount) stats[name] = r.rowCount;
      } catch (err) {
        console.error(`[prune] ${name} failed:`, sanitizeError(err));
      }
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
    }
    // Optional Sentry init — no-op if errorTracking flag is off.
    try {
      const flags = await features.load(pool);
      sentry.init(flags);
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
    startAuditPruner();
    scheduler.start(pool);
    notifQueue.start(pool, () => features.load(pool));

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
