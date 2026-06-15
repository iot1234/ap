// === Production server: Express + PostgreSQL + sessions ====================
// - Serves static React app from project/
// - REST API: /api/data/:key (GET public, PUT admin-only) backed by JSONB store
// - Auth: /api/auth/login (bcrypt + session), /api/auth/me, /api/auth/logout
// - Schema migration runs on boot; bootstraps single admin user from env vars

// --- Timezone guard (MUST run before any Date is constructed) --------------
// The entire scheduler (auto bill-gen, late-fee marking, payment reminders,
// overdue digests, backups) computes calendar days/months from local time
// and EXPECTS Asia/Bangkok (UTC+7). Containers (node:*-alpine) default to UTC
// when no TZ is set, which silently shifts every job by ~7h and can stamp
// bills with the wrong day/month near midnight. We default TZ here — Node
// re-reads process.env.TZ for every subsequent Date — and log loudly so the
// behaviour is never a silent surprise. Operators can override via the TZ env.
if (!process.env.TZ) {
  process.env.TZ = 'Asia/Bangkok';
  console.log('[boot] TZ not set — defaulting to Asia/Bangkok (UTC+7) for scheduler date math.');
} else if (process.env.TZ !== 'Asia/Bangkok') {
  console.warn(`[boot] TZ=${process.env.TZ} (not Asia/Bangkok). Scheduler day/month math assumes ICT; `
    + 'bill periods and reminder days may be off if this is intentional, set it deliberately.');
}

const express = require('express');
const path = require('path');
const pg = require('pg');
const { Pool } = pg;
const bcrypt = require('bcryptjs');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { renderBillPdf } = require('./services/pdf');
const { renderQrPng, renderQrDataUrl, renderQrSvg, renderQrWithFallback, buildPayload: buildPromptPayPayload, MAX_AMOUNT, isDemoTarget, normaliseTarget } = require('./services/promptpay');
const lineNotify = require('./services/line');
const features = require('./services/features');
const cryptoSvc = require('./services/crypto');
const storage = require('./services/storage');
const billing = require('./services/billing');
const pricing = require('./services/pricing');
const notifier = require('./services/notifier');
const meter = require('./services/meter');
const sentry = require('./services/sentry');
const scheduler = require('./services/scheduler');
const roomSync = require('./services/roomSync');
const billPayments = require('./services/billPayments');
const lineBinding = require('./services/lineBinding');
const lineOa = require('./services/lineOa');
const billTokens = require('./services/billTokens');
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
billTokens.configureRuntimeSecret(_runtimeSessionSecret);

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

function safeDownloadFilename(base, fallback = 'file', ext = 'pdf') {
  const cleanExt = String(ext || 'bin').replace(/[^A-Za-z0-9]/g, '') || 'bin';
  const cleaned = String(base || fallback || 'file')
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  const safeBase = cleaned || String(fallback || 'file').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80) || 'file';
  return `${safeBase}.${cleanExt}`;
}

function safeAuditJson(value, maxBytes = 16_000) {
  if (value === null || value === undefined) return null;
  const seen = new WeakSet();
  let out;
  try {
    out = JSON.stringify(value, (_key, v) => {
      if (typeof v === 'bigint') return v.toString();
      if (v instanceof Error) {
        return { name: v.name, message: v.message, stack: String(v.stack || '').slice(0, 1000) };
      }
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    });
  } catch (err) {
    out = JSON.stringify({
      unserialisable: true,
      message: String(err && err.message || err).slice(0, 500),
    });
  }
  if (typeof out !== 'string') return null;
  if (out.length <= maxBytes) return out;
  return JSON.stringify({
    truncated: true,
    originalLength: out.length,
    preview: out.slice(0, Math.max(0, maxBytes - 200)),
  });
}

// Railway-internal Postgres URLs are plain TCP; external ones use SSL.
// Heuristic: enable SSL only when the host isn't .railway.internal.
const useSSL = !/\.railway\.internal/i.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  // The daily scheduler fires ~14 advisory-locked jobs near-synchronously,
  // each grabbing a pool connection for its whole run (and bill-gen opens a
  // 2nd per-room connection). At max:10 the extras queued past
  // connectionTimeoutMillis and could fail money jobs (bill-gen / reminders)
  // for the cycle. Default the pool above that peak; PG_POOL_MAX lets a small
  // DB plan dial it back.
  max: Number(process.env.PG_POOL_MAX) || 20,
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

// Pin every SQL session to Asia/Bangkok so CURRENT_DATE / NOW()::date in the
// scheduler (late-fee flip, payment reminders, contract expiry, checkout
// end_date stamps) agree with the JS side (process.env.TZ above). Hosted
// Postgres defaults to UTC: without this, every date boundary in SQL lags
// ICT by 7 hours — a bill due "yesterday" doesn't flip overdue until 07:00,
// and a checkout at 01:00 stamps the contract end_date with the previous
// day. node-postgres serialises queries per client in FIFO order, so this
// SET always runs before any query handed to the connection's acquirer.
// Mirrors db/pool.js — that pool has the same handler but is only a
// fallback; THIS pool is the one the app and scheduler actually use.
pool.on('connect', (client) => {
  client.query("SET timezone='Asia/Bangkok'").catch((err) => {
    console.error('[pg] SET timezone failed:', sanitizeError(err));
  });
});

async function loadContractTermsSnapshot(db, contract = {}) {
  let rawTemplate = null;
  let templateId = contract.template_id || null;
  if (templateId) {
    try {
      const t = await db.query(
        `SELECT id, mode, clauses, sections, variables
           FROM contract_templates
          WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,
        [templateId]
      );
      if (t.rows.length) rawTemplate = t.rows[0];
    } catch (err) {
      if (err.code !== '42P01') throw err;
    }
  }
  if (!rawTemplate) {
    try {
      const t = await db.query(
        `SELECT id, mode, clauses, sections, variables
           FROM contract_templates
          WHERE is_default=TRUE AND deleted_at IS NULL LIMIT 1`
      );
      if (t.rows.length) {
        rawTemplate = t.rows[0];
        templateId = t.rows[0].id;
      }
    } catch (err) {
      if (err.code !== '42P01') throw err;
    }
  }
  if (!rawTemplate) {
    try {
      const t = await db.query(
        `SELECT value FROM system_settings WHERE key=$1`,
        [CONTRACT_TERMS_KEY]
      );
      if (t.rows.length) rawTemplate = t.rows[0].value;
    } catch { /* renderer defaults below */ }
  }

  const contractPdf = require('./services/contractPdf');
  const clauses = contractPdf.resolveClauses(rawTemplate);

  // Capture the financial terms (due day + late-fee rate) AS THEY ARE NOW so a
  // locked/signed contract's PDF keeps printing the terms the tenant actually
  // agreed to, even if the operator later changes config.notify.dueOnDay or
  // features.lateFee.ratePctPerMonth. Without this the PDF read these LIVE and a
  // routine policy change silently rewrote already-signed contracts.
  let financials = { dueDay: 15, lateFeeRate: 1.5 };
  try {
    const cfgR = await db.query(`SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`);
    const d = Number(cfgR.rows[0] && cfgR.rows[0].value
      && cfgR.rows[0].value.notify && cfgR.rows[0].value.notify.dueOnDay);
    if (Number.isFinite(d) && d >= 1 && d <= 28) financials.dueDay = Math.floor(d);
  } catch { /* keep default 15 */ }
  try {
    const flags = await features.load(db);
    const r = Number(flags && flags.lateFee && flags.lateFee.ratePctPerMonth);
    if (Number.isFinite(r) && r >= 0) financials.lateFeeRate = r;
  } catch { /* keep default 1.5 */ }

  return {
    templateId,
    snapshot: {
      mode: 'override',
      clauses,
      sections: rawTemplate && typeof rawTemplate.sections === 'object' ? rawTemplate.sections : {},
      variables: rawTemplate && typeof rawTemplate.variables === 'object' ? rawTemplate.variables : {},
      financials,
      snapshotVersion: 'contract-terms-snapshot-v2',
    },
  };
}

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
const defaultJsonParser = express.json({
  limit: '3mb',
  verify: (req, _res, buf) => {
    if (req.path && req.path.startsWith('/webhook/')) {
      req.rawBody = buf.toString('utf8');
    }
  },
});
app.use((req, res, next) => {
  // /api/admin/restore has its own large JSON parser mounted AFTER
  // sameOrigin + CSRF + owner auth. Letting the global parser touch it first
  // breaks legitimate large restores (3MB cap), while mounting the 100MB
  // parser before auth would turn an owner-only endpoint into a public memory
  // pressure target.
  if (/^\/api\/admin\/restore\/?$/i.test(req.path || '')) return next();
  return defaultJsonParser(req, res, next);
});
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

// Permissions-Policy: deny powerful browser features by default. Helmet 8 does
// not emit this header, so set it explicitly -- defence in depth so any future
// XSS/embedded context can't silently reach camera/mic/geolocation/etc. The
// app's only device need is the camera on slip/ID upload pages, which use a
// plain <input type=file> (no getUserMedia), so camera=() is safe.
app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), usb=(), payment=(), ' +
    'accelerometer=(), gyroscope=(), magnetometer=(), interest-cohort=()');
  next();
});

// Compress text responses and static source files. The current frontend still
// serves JSX directly to the browser, so gzip materially reduces cold-load
// transfer size until the app moves to a real build/bundle pipeline.
app.use(compression({
  threshold: 1024,
}));

// API responses can include roles, tenant data, bills, slips metadata, and
// CSRF tokens. Keep them out of shared/browser caches by default; explicit
// PDF/file routes can still set their own stricter headers later.
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

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
const { requireAuth, requireRole, requireDeviceOrAdmin, ROLE_RANK } = makeAuth(pool);

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
       safeAuditJson(detail), ip, ua]
    );
  } catch (err) {
    console.error('[audit] log failed:', err.message);
  }
}

function securityEvent(req, action, detail = {}, userIdOverride) {
  const safeDetail = {
    ...detail,
    path: String(detail.path || req.originalUrl || req.url || '').slice(0, 500),
    method: String(detail.method || req.method || '').slice(0, 16),
    requestId: req.id || null,
  };
  const auditWrite = audit(
    req,
    action,
    'security',
    safeDetail.path || null,
    safeDetail,
    userIdOverride
  );
  maybeNotifySecurityEvent(req, action, safeDetail).catch(() => {});
  return auditWrite;
}

function recordSecurityEvent(req, action, detail = {}, userIdOverride) {
  securityEvent(req, action, detail, userIdOverride).catch(() => {});
}

app.set('securityEvent', securityEvent);

const SECURITY_WARNING_TEXT = 'คำขอนี้ไม่ได้รับอนุญาตหรือไม่สามารถตรวจสอบสิทธิ์ได้ ระบบได้บันทึกเหตุการณ์ไว้เพื่อความปลอดภัย';
function applySecurityWarning(res) {
  res.setHeader('X-Security-Warning', 'unauthorized-access-logged');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

function securityWarningBody(error, code) {
  return {
    error,
    code,
    warning: SECURITY_WARNING_TEXT,
  };
}

function sendSecurityJson(res, status, error, code) {
  applySecurityWarning(res);
  return res.status(status).json(securityWarningBody(error, code));
}

function sendSecurityText(res, status) {
  applySecurityWarning(res);
  return res.status(status).type('text/plain').send(SECURITY_WARNING_TEXT);
}

function sendSecurityHtml(req, res, status) {
  applySecurityWarning(res);
  res.status(status);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Request-ID', req.id || '');
  return res.sendFile(path.join(__dirname, 'project', 'security-warning.html'));
}

const SECURITY_ALERT_WINDOW_MS = 10 * 60_000;
const SECURITY_ALERT_COOLDOWN_MS = 30 * 60_000;
const SECURITY_ALERT_RULES = Object.freeze({
  'security.blocked_request':      { threshold: 2, severity: 'high', title: 'พบการ probe URL/ไฟล์ระบบ' },
  'security.blocked_method':       { threshold: 1, severity: 'high', title: 'พบ HTTP method ที่ไม่อนุญาต' },
  'security.file_guess_miss':      { threshold: 8, severity: 'high', title: 'พบการเดา URL ไฟล์' },
  'security.file_access_denied':   { threshold: 3, severity: 'high', title: 'พบการพยายามเปิดไฟล์ที่ไม่มีสิทธิ์' },
  'security.api_unknown_route':    { threshold: 12, severity: 'medium', title: 'พบการเดา API URL' },
  'security.public_unknown_route': { threshold: 8, severity: 'medium', title: 'พบการ probe URL สาธารณะ' },
  'security.admin_route_probe':    { threshold: 3, severity: 'high', title: 'พบการเดา URL หลังบ้าน' },
  'security.device_token_rejected':{ threshold: 3, severity: 'high', title: 'พบ token อุปกรณ์ผิดซ้ำ' },
  'security.admin_forbidden_role': { threshold: 3, severity: 'medium', title: 'พบสิทธิ์ผู้ใช้ไม่พอซ้ำ' },
  'security.admin_unauthorized':   { threshold: 10, severity: 'medium', title: 'พบการเข้า admin endpoint โดยไม่มี session' },
});
const _securityAlertBuckets = new Map();

function securityAlertFingerprint(req, action, detail) {
  const ip = clientIp(req) || 'unknown';
  const reason = detail && detail.reason ? String(detail.reason).slice(0, 80) : '';
  return `${action}|${ip}|${reason}`;
}

async function maybeNotifySecurityEvent(req, action, detail = {}) {
  const rule = SECURITY_ALERT_RULES[action];
  if (!rule) return;
  const now = Date.now();
  const key = securityAlertFingerprint(req, action, detail);
  let bucket = _securityAlertBuckets.get(key);
  if (!bucket || now - bucket.firstAt > SECURITY_ALERT_WINDOW_MS) {
    bucket = {
      firstAt: now,
      count: 0,
      lastAlertAt: 0,
      samples: [],
      lastUa: '',
    };
    _securityAlertBuckets.set(key, bucket);
  }
  bucket.count += 1;
  bucket.lastUa = String(req.headers['user-agent'] || '').slice(0, 180);
  const pathSample = String(detail.path || req.originalUrl || req.url || '').slice(0, 180);
  if (pathSample && !bucket.samples.includes(pathSample)) {
    bucket.samples.push(pathSample);
    if (bucket.samples.length > 5) bucket.samples.shift();
  }

  for (const [k, b] of _securityAlertBuckets) {
    if (now - b.firstAt > SECURITY_ALERT_WINDOW_MS && now - b.lastAlertAt > SECURITY_ALERT_COOLDOWN_MS) {
      _securityAlertBuckets.delete(k);
    }
  }

  if (bucket.count < rule.threshold) return;
  if (bucket.lastAlertAt && now - bucket.lastAlertAt < SECURITY_ALERT_COOLDOWN_MS) return;
  bucket.lastAlertAt = now;

  const ip = clientIp(req) || 'unknown';
  const reason = detail.reason ? `\nเหตุผล: ${detail.reason}` : '';
  const samples = bucket.samples.length
    ? `\nURL ตัวอย่าง:\n${bucket.samples.map((x) => `- ${x}`).join('\n')}`
    : '';
  const ua = bucket.lastUa ? `\nUser-Agent: ${bucket.lastUa}` : '';
  const flags = await features.load(pool).catch(() => ({}));
  await notifier.notifyOwner({ pool, features: flags }, {
    category: 'security',
    subject: `แจ้งเตือนความปลอดภัย: ${rule.title}`,
    text: [
      rule.title,
      `ระดับ: ${rule.severity}`,
      `เหตุการณ์: ${action}`,
      `จำนวน: ${bucket.count} ครั้งใน ${Math.round(SECURITY_ALERT_WINDOW_MS / 60_000)} นาที`,
      `IP: ${ip}`,
      reason.trim(),
      samples.trim(),
      ua.trim(),
      '',
      'ระบบบล็อก/ปฏิเสธคำขอแล้ว และบันทึกไว้ที่ /admin#security-events',
    ].filter(Boolean).join('\n'),
  }).catch(() => {});
}

function safeDecodePath(rawPath) {
  let out = String(rawPath || '');
  for (let i = 0; i < 2; i++) {
    try {
      const decoded = decodeURIComponent(out);
      if (decoded === out) break;
      out = decoded;
    } catch {
      return { ok: false, value: out };
    }
  }
  return { ok: true, value: out };
}

const BLOCKED_METHODS = new Set(['TRACE', 'TRACK', 'CONNECT']);
const PROTECTED_SOURCE_PATH = /(?:^|\/)(?:\.env(?:\..*)?|\.git|\.svn|\.hg|node_modules|uploads|db|routes|services|middleware|tests|scripts|server-assets)(?:\/|$)|(?:^|\/)(?:server\.js|package(?:-lock)?\.json|\.npmrc|railway\.json)(?:$|[?#])/i;
function isProtectedSourceProbePath(pathValue) {
  // `/api/uploads` is the authenticated upload endpoint. The protected-path
  // scanner still blocks direct `/uploads/...` probes for local files.
  if (/^\/api\/uploads\/?$/i.test(String(pathValue || ''))) return false;
  return PROTECTED_SOURCE_PATH.test(pathValue);
}
const SUSPICIOUS_UNKNOWN_PATH = /(?:wp-admin|wp-login|xmlrpc|phpmyadmin|adminer|composer\.(?:json|lock)|vendor\/|backup|dump|database|config|setup|install|\.php|\.asp|\.aspx|\.jsp|\.cgi|\.sql|\.bak|\.old|\.zip|\.tar|\.gz|\.rar)/i;
const ADMIN_CONSOLE_PROBE_PATH = /^\/(?:admin(?:\/.+|[-_a-z0-9]+)?|administrator|backend|backoffice|dashboard|cpanel|control-?panel|manage|manager|cms)(?:\/|$)/i;

function adminConsoleProbePath(rawPath) {
  const decoded = safeDecodePath(String(rawPath || '').split('?')[0] || '/');
  const value = (decoded.ok ? decoded.value : String(rawPath || '')).replace(/\\/g, '/');
  if (value === '/admin' || value === '/admin/') return false;
  return ADMIN_CONSOLE_PROBE_PATH.test(value);
}

function adminStaticShellPath(rawPath) {
  const decoded = safeDecodePath(String(rawPath || '').split('?')[0] || '/');
  const value = (decoded.ok ? decoded.value : String(rawPath || '')).replace(/\\/g, '/');
  return /^\/Admin Dashboard\.html$/i.test(value);
}

function suspiciousUnknownPath(rawPath) {
  const decoded = safeDecodePath(String(rawPath || '').split('?')[0] || '/');
  const value = (decoded.ok ? decoded.value : String(rawPath || '')).replace(/\\/g, '/');
  if (SUSPICIOUS_UNKNOWN_PATH.test(value)) return true;
  if (value.length > 160) return true;
  const slashCount = (value.match(/\//g) || []).length;
  return slashCount >= 6;
}

app.use((req, res, next) => {
  if (BLOCKED_METHODS.has(req.method)) {
    recordSecurityEvent(req, 'security.blocked_method', {
      reason: 'blocked_method',
      method: req.method,
    });
    return sendSecurityJson(res, 405, 'method not allowed', 'METHOD_NOT_ALLOWED');
  }

  const rawPath = String((req.originalUrl || req.url || '').split('?')[0] || '/');
  if (rawPath.length > 2048) {
    recordSecurityEvent(req, 'security.blocked_request', {
      reason: 'path_too_long',
      pathLength: rawPath.length,
    });
    return sendSecurityJson(res, 414, 'uri too long', 'URI_TOO_LONG');
  }

  const decoded = safeDecodePath(rawPath);
  if (!decoded.ok) {
    recordSecurityEvent(req, 'security.blocked_request', {
      reason: 'malformed_path_encoding',
      path: rawPath.slice(0, 500),
    });
    return sendSecurityJson(res, 400, 'bad request', 'BAD_PATH');
  }

  const pathValue = decoded.value.replace(/\\/g, '/');
  if (/%00/i.test(rawPath) || pathValue.includes('\0')) {
    recordSecurityEvent(req, 'security.blocked_request', { reason: 'null_byte_path' });
    return sendSecurityJson(res, 400, 'bad request', 'BAD_PATH');
  }
  if (/(^|\/)\.\.(\/|$)/.test(pathValue)) {
    recordSecurityEvent(req, 'security.blocked_request', {
      reason: 'path_traversal',
      path: rawPath.slice(0, 500),
    });
    return sendSecurityJson(res, 404, 'not found', 'NOT_FOUND');
  }
  if (isProtectedSourceProbePath(pathValue)) {
    recordSecurityEvent(req, 'security.blocked_request', {
      reason: 'protected_source_path',
      path: rawPath.slice(0, 500),
    });
    return sendSecurityJson(res, 404, 'not found', 'NOT_FOUND');
  }

  next();
});

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
  // Reuse the existing valid cookie/token pair instead of minting a new one on
  // every call. We have TWO independent client-side token caches that both pull
  // from this endpoint — api-client.js (PUT /api/data/:key) and hooks.jsx's
  // apiFetch (everything else, e.g. /api/tenants/notify). With overwrite=true
  // every fetch rotated the single CSRF cookie, so whichever cache fetched last
  // owned the cookie and the other cache's token was instantly stale → 403
  // "invalid CSRF token". Symptom: sending a LINE/notify succeeds (apiFetch
  // refetched + rotated the cookie) but the follow-up activity-log save via
  // api-client fails with HTTP 403 ("บันทึกข้อมูล ไม่สำเร็จ"). The client retry
  // added in "Retry CSRF for admin background sync" masks it; this removes the
  // root cause.
  //
  // overwrite=false makes repeated calls return the SAME stable token (reusing
  // the cookie), so both caches agree. validateOnReuse=false preserves the
  // anonymous -> tenant/admin transition: when the session identifier changes
  // the old cookie no longer validates, and instead of throwing we silently
  // regenerate a fresh pair bound to the new identifier.
  const token = csrf.generateCsrfToken(req, res, false, false);
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

// --- Auth endpoints -------------------------------------------------------
app.post('/api/auth/login', sameOrigin, loginLimiter, lookupJitter, validateBody(schemas.login), async (req, res) => {
  const { username, password } = req.body;
  const principal = `admin:${username.toLowerCase().trim()}`;
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
      // Record the failure AUTHORITATIVELY (awaited) so concurrent attempts
      // that cross the threshold lock the account atomically instead of all
      // racing past a stale check(). Audit stays fire-and-forget.
      const lockedUntil = await lockout.recordFailure(principal, 'admin').catch(() => null);
      audit(req, 'auth.login_failed', 'user', username,
        { reason: !user ? 'unknown_user' : 'wrong_password' }, username).catch(() => {});
      if (lockedUntil && new Date(lockedUntil).getTime() > Date.now()) {
        const minutes = Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 60_000);
        return res.status(429).json({
          error: `บัญชีถูกล็อกชั่วคราว — ลองใหม่ใน ${minutes} นาที`,
          code: 'LOCKED_OUT',
        });
      }
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

app.post('/api/auth/change-password', sameOrigin, csrfGuard, requireAuth, async (req, res) => {
  const r = schemas.changePassword.safeParse(req.body || {});
  if (!r.success) return res.status(400).json(require('./middleware/validate').formatZodError(r.error));
  const { currentPassword, newPassword } = r.data;
  const sessionUser = req.session && req.session.user ? req.session.user : null;
  const userId = Number(sessionUser && sessionUser.id);
  if (!Number.isInteger(userId) || userId < 1) {
    return res.status(401).json({ error: 'unauthorized', code: 'UNAUTHORIZED' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, username, password_hash FROM auth_users WHERE id=$1',
      [userId]
    );
    const user = rows[0] || null;
    if (!user) {
      return req.session.destroy(() => {
        res.status(401).json({ error: 'account no longer exists', code: 'UNAUTHORIZED' });
      });
    }

    const principal = `admin:${String(user.username).toLowerCase().trim()}`;
    try {
      await lockout.check(principal);
    } catch (err) {
      if (err.code === 'LOCKED_OUT') {
        await audit(req, 'user.password_self_change_locked', 'user', String(user.id),
          { username: user.username });
        const minutes = Math.ceil((err.retryAfterMs || 0) / 60_000);
        return res.status(429).json({
          error: `บัญชีถูกล็อกชั่วคราว — ลองใหม่ใน ${minutes} นาที`,
          code: 'LOCKED_OUT',
        });
      }
      throw err;
    }

    const currentOk = await bcrypt.compare(currentPassword, user.password_hash);
    if (!currentOk) {
      lockout.recordFailure(principal, 'admin').catch(() => {});
      audit(req, 'user.password_self_change_failed', 'user', String(user.id),
        { username: user.username, reason: 'wrong_current_password' });
      return res.status(400).json({
        error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง',
        code: 'CURRENT_PASSWORD_INCORRECT',
      });
    }

    const samePassword = await bcrypt.compare(newPassword, user.password_hash);
    if (samePassword) {
      audit(req, 'user.password_self_change_failed', 'user', String(user.id),
        { username: user.username, reason: 'password_reuse' });
      return res.status(400).json({
        error: 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม',
        code: 'PASSWORD_REUSE',
      });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE auth_users SET password_hash=$1 WHERE id=$2', [hash, user.id]);
    if (req.sessionID) {
      await pool.query(
        `DELETE FROM user_sessions WHERE (sess::jsonb->'user'->>'id')::int = $1 AND sid <> $2`,
        [user.id, req.sessionID]
      ).catch((err) => {
        console.warn('[auth] self password session cleanup failed:', sanitizeError(err));
      });
    }
    lockout.reset(principal).catch(() => {});
    audit(req, 'user.password_self_change', 'user', String(user.id), { username: user.username });
    res.json({ ok: true });
  } catch (err) {
    console.error('auth change-password error:', err);
    res.status(500).json({ error: 'internal error' });
  }
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
// Maximum raw JSON text we'll send back for a single app_data value. PUT has a
// 6 MB hard cap below; this read-side cap protects browsers from legacy rows
// that were already bloated before that guard shipped.
const APP_DATA_RESPONSE_VALUE_MAX_BYTES = 5 * 1024 * 1024;
// Keys that are safe to read while unauthenticated. Everything else returns
// 401. `baankarn_rooms_v1` is allowed but the value is run through
// `maskRoomsPublic` first.
const PUBLIC_KEYS = new Set(['baankarn_rooms_v1', 'baankarn_config_v1']);

function appDataPayloadBytes(row) {
  return Number(row && (row.payload_bytes || row.bytes || row.n)) || 0;
}

function oversizedAppDataPayload(row) {
  const bytes = appDataPayloadBytes(row);
  return bytes > APP_DATA_RESPONSE_VALUE_MAX_BYTES;
}

function oversizedAppDataInfo(row) {
  return {
    omitted: true,
    code: 'DATA_TOO_LARGE',
    bytes: appDataPayloadBytes(row),
    maxBytes: APP_DATA_RESPONSE_VALUE_MAX_BYTES,
  };
}

// Strip every tenant-PII field from a rooms object. The home page needs
// status/floor/type/rent plus non-sensitive room-photo URLs to render the
// building grid, so we drop name, phone, email, citizen ID, occupation,
// contract end, etc.
//
// The rent shown publicly is run through the formula resolver so admin
// pricing edits in /admin#pricing reflect on the homepage immediately
// (without waiting for someone to re-save each room blob). Falls back to
// the static room.rent snapshot when no config is supplied — that path is
// only hit on the GET-all endpoint where the caller hasn't loaded config
// yet; the per-key GET path always passes config.
function publicRoomPhotos(photos) {
  if (!Array.isArray(photos)) return [];
  const out = [];
  const seen = new Set();
  for (const item of photos) {
    const url = String(item || '').trim();
    if (!url || url.startsWith('data:')) continue;
    const isSafeRoomPhotoUrl = /^\/files\/\d+$/.test(url)
      || /^\/assets\/rooms\/[A-Za-z0-9._/-]+$/.test(url);
    if (!isSafeRoomPhotoUrl || seen.has(url)) continue;
    seen.add(url);
    out.push(url.slice(0, 2048));
    if (out.length >= 12) break;
  }
  return out;
}

function maskRoomsPublic(roomsObj, config) {
  if (!roomsObj || typeof roomsObj !== 'object') return roomsObj;
  const out = {};
  for (const [id, r] of Object.entries(roomsObj)) {
    if (!r || typeof r !== 'object') continue;
    // Use the same resolver the bill engine uses (minus contract, since
    // contracts are admin-only data and we don't want to leak them publicly).
    // Result: vacant rooms show formula-derived rent, occupied rooms show
    // override or formula — never a stale legacy snapshot from a save weeks
    // ago. Public visitors see "what would I pay if I rented this today".
    let resolvedRent = r.rent;
    if (config) {
      try {
        const { rent } = pricing.resolveBillingRent({ room: r, config });
        if (Number.isFinite(rent) && rent > 0) resolvedRent = rent;
      } catch { /* fall back to legacy */ }
    }
    out[id] = {
      id: r.id,
      floor: r.floor,
      no: r.no,
      type: r.type,
      view: r.view,
      status: r.status,
      rent: resolvedRent,
      photos: publicRoomPhotos(r.photos),
      // Keep tenant truthy so existing UI conditions still work, but every
      // PII field is replaced with a masked placeholder.
      tenant: r.tenant ? { name: 'มีผู้เช่า', occupation: '', masked: true } : null,
    };
  }
  return out;
}

function publicBookableRooms(roomsObj, config, v2Rows = []) {
  const byId = new Map();
  const v2Status = new Map();
  if (roomsObj && typeof roomsObj === 'object') {
    for (const [id, room] of Object.entries(roomsObj)) {
      if (!room || typeof room !== 'object') continue;
      const roomId = String(room.id || id || '').trim();
      if (!roomId) continue;
      byId.set(roomId, { ...room, id: roomId });
    }
  }
  for (const row of Array.isArray(v2Rows) ? v2Rows : []) {
    const room = roomFromV2(row);
    if (!room || !room.id) continue;
    const roomId = String(room.id).trim();
    if (!roomId) continue;
    v2Status.set(roomId, room.status || 'vacant');
    const legacy = byId.get(roomId);
    byId.set(roomId, {
      ...(legacy || {}),
      ...room,
      id: roomId,
      // A held room is written to the legacy blob first, so never let a
      // stale rooms_v2 "vacant" value publish it as bookable.
      status: legacy && legacy.status ? legacy.status : (room.status || 'vacant'),
      view: (legacy && legacy.view) || room.view || '',
    });
  }

  const out = [];
  for (const [roomId, room] of byId.entries()) {
    const blobStatus = room.status || 'vacant';
    const relationalStatus = v2Status.get(roomId);
    if (!isVacantStatus(blobStatus) || (relationalStatus && !isVacantStatus(relationalStatus))) continue;
    const masked = maskRoomsPublic({ [roomId]: room }, config)?.[roomId];
    if (!masked || !isVacantStatus(masked.status)) continue;
    out.push({
      id: String(masked.id || roomId),
      floor: masked.floor,
      no: masked.no,
      type: masked.type || 'standard',
      view: masked.view || '',
      status: 'vacant',
      rent: Number.isFinite(Number(masked.rent)) ? Number(masked.rent) : 0,
      photos: Array.isArray(masked.photos) ? masked.photos : [],
    });
  }
  return out.sort((a, b) => (
    (Number(a.floor) || 0) - (Number(b.floor) || 0)
    || (Number(a.no) || 0) - (Number(b.no) || 0)
    || String(a.id).localeCompare(String(b.id), 'th')
  ));
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
      logo: normalizeBuildingLogoUrl(cfg.building.logo),
      address: cfg.building.address,
      phone: cfg.building.phone,
    };
  }
  if (cfg.payment && typeof cfg.payment === 'object') {
    out.payment = {
      promptpayDisplayName: cfg.payment.promptpayDisplayName || cfg.payment.bankName,
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

function normalizeBuildingLogoUrl(value) {
  const logo = String(value || '').trim();
  if (!logo) return '';
  return /^\/files\/\d+$/.test(logo) ? logo : null;
}

function fileIdFromPublicFileUrl(value) {
  const m = String(value || '').trim().match(/^\/files\/(\d+)$/);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function fileUrlHasCategory(value, category) {
  const id = fileIdFromPublicFileUrl(value);
  if (!id) return false;
  try {
    const { rows } = await pool.query(
      `SELECT category FROM file_uploads WHERE id=$1`,
      [id]
    );
    return rows.length > 0 && rows[0].category === category;
  } catch (err) {
    console.warn('[config] file category check failed:', err.message);
    return false;
  }
}

async function removeFileUrlIfCategory(value, category, label) {
  const id = fileIdFromPublicFileUrl(value);
  if (!id) return;
  try {
    const { rows } = await pool.query(
      `SELECT category FROM file_uploads WHERE id=$1`,
      [id]
    );
    if (rows.length && rows[0].category === category) {
      storage.removeQuietly(pool, id, label);
    }
  } catch (err) {
    console.warn(`[storage] ${label || category} category check failed for id=${id}:`, err.message);
  }
}

const PRICING_CONTRACT_UPDATE_CONFIRM = 'UPDATE_ACTIVE_CONTRACTS';

function pricingImpactRoomFromV2(row) {
  if (!row) return null;
  return {
    id: row.room_code,
    room_code: row.room_code,
    type: row.room_type,
    room_type: row.room_type,
    floor: row.floor,
    no: row.room_no,
    room_no: row.room_no,
    rent: Number(row.rent_price),
    rent_price: Number(row.rent_price),
    rent_override: row.rent_override == null ? null : Number(row.rent_override),
    rent_override_reason: row.rent_override_reason || null,
    deposit: Number(row.deposit_price || 0),
    deposit_price: Number(row.deposit_price || 0),
    wifi: Number(row.wifi_fee || 0),
    wifi_fee: Number(row.wifi_fee || 0),
    view: row.view_type || '',
    view_type: row.view_type || '',
    balcony: !!row.has_balcony,
    has_balcony: !!row.has_balcony,
    parking: !!row.has_parking,
    has_parking: !!row.has_parking,
    kitchen: !!row.has_kitchen,
    has_kitchen: !!row.has_kitchen,
    ac: row.has_ac === null || row.has_ac === undefined ? undefined : !!row.has_ac,
    has_ac: row.has_ac === null || row.has_ac === undefined ? undefined : !!row.has_ac,
    status: row.status || 'vacant',
  };
}

function mergePricingImpactRooms(roomsObj, v2Rows) {
  const map = new Map();
  if (roomsObj && typeof roomsObj === 'object') {
    for (const [id, room] of Object.entries(roomsObj)) {
      if (!room || typeof room !== 'object') continue;
      const roomId = String(room.id || id || '').trim();
      if (!roomId) continue;
      map.set(roomId, { ...room, id: roomId });
    }
  }
  for (const row of Array.isArray(v2Rows) ? v2Rows : []) {
    const v2Room = pricingImpactRoomFromV2(row);
    if (!v2Room || !v2Room.id) continue;
    const existing = map.get(String(v2Room.id));
    map.set(String(v2Room.id), {
      ...(existing || {}),
      ...v2Room,
      id: String(v2Room.id),
      status: (existing && existing.status) || v2Room.status || 'vacant',
      view: (existing && existing.view) || v2Room.view || '',
      rentOverride: existing && existing.rentOverride !== undefined ? existing.rentOverride : v2Room.rent_override,
      rentOverrideReason: existing && existing.rentOverrideReason !== undefined
        ? existing.rentOverrideReason : v2Room.rent_override_reason,
    });
  }
  return Array.from(map.values()).sort((a, b) => String(a.id).localeCompare(String(b.id), 'th'));
}

async function loadPricingImpactInputs(db) {
  const configRow = await db.query(`SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`);
  const roomsRow = await db.query(`SELECT value FROM app_data WHERE key='baankarn_rooms_v1' LIMIT 1`);
  const contractsQ = await db.query(
    `SELECT c.id, c.contract_no, c.tenant_id, c.room_id, c.monthly_rent,
            c.deposit, c.status, c.start_date, c.end_date,
            t.full_name AS tenant_name, t.phone AS tenant_phone
       FROM contracts c
       LEFT JOIN tenants t ON t.id=c.tenant_id AND t.deleted_at IS NULL
      WHERE c.status='active' AND c.deleted_at IS NULL
      ORDER BY c.room_id ASC, c.id ASC`
  ).catch((err) => {
    if (err.code === '42P01' || err.code === '42703') return { rows: [] };
    throw err;
  });
  let v2Rows = [];
  try {
    const v2 = await db.query(
      `SELECT room_code, floor, room_no, room_type, status, rent_price,
              rent_override, rent_override_reason, deposit_price, wifi_fee,
              view_type, has_balcony, has_parking, has_kitchen, has_ac
         FROM rooms_v2
        WHERE deleted_at IS NULL
        ORDER BY room_code ASC`
    );
    v2Rows = v2.rows || [];
  } catch (err) {
    if (err.code !== '42P01' && err.code !== '42703') throw err;
  }
  return {
    currentConfig: configRow.rows[0]?.value || {},
    rooms: mergePricingImpactRooms(roomsRow.rows[0]?.value || {}, v2Rows),
    contracts: contractsQ.rows || [],
  };
}

async function buildPricingImpactForConfig(db, nextConfig) {
  const inputs = await loadPricingImpactInputs(db);
  return pricing.previewPricingChangeImpact({
    rooms: inputs.rooms,
    contracts: inputs.contracts,
    oldConfig: inputs.currentConfig,
    newConfig: nextConfig || {},
  });
}

async function applyPricingToActiveContracts(client, nextConfig) {
  const inputs = await loadPricingImpactInputs(client);
  const roomMap = new Map((inputs.rooms || []).map((room) => [String(room.id || room.room_code || ''), room]));
  const updated = [];
  const skipped = [];
  for (const contract of inputs.contracts || []) {
    const room = roomMap.get(String(contract.room_id || ''));
    if (!room) {
      skipped.push({
        roomId: contract.room_id,
        contractId: contract.id,
        contractNo: contract.contract_no,
        tenantName: contract.tenant_name,
        reason: 'missing_room',
      });
      continue;
    }
    const rentInfo = pricing.resolveExpectedRoomRent({ room, config: nextConfig || {} });
    const depositInfo = pricing.resolveContractDeposit({ room, config: nextConfig || {}, rent: rentInfo.rent });
    const currentRent = Number(contract.monthly_rent) || 0;
    const currentDeposit = Number(contract.deposit) || 0;
    const nextRent = Number(rentInfo.rent);
    const nextDeposit = Number(depositInfo.deposit);
    const willUpdateRent = Math.abs(nextRent - currentRent) >= 0.01;
    const willUpdateDeposit = Math.abs(nextDeposit - currentDeposit) >= 0.01;
    if (!willUpdateRent && !willUpdateDeposit) continue;
    if (!Number.isFinite(nextRent) || nextRent <= 0 || !Number.isFinite(nextDeposit) || nextDeposit < 0) {
      skipped.push({
        roomId: contract.room_id,
        contractId: contract.id,
        contractNo: contract.contract_no,
        tenantName: contract.tenant_name,
        nextRent,
        nextDeposit,
        reason: 'invalid_target_amount',
      });
      continue;
    }
    const upd = await client.query(
      `UPDATE contracts
          SET monthly_rent=$1,
              deposit=$2,
              updated_at=NOW()
       WHERE id=$3 AND status='active' AND deleted_at IS NULL
       RETURNING id, contract_no, room_id, monthly_rent, deposit`,
      [nextRent, nextDeposit, contract.id]
    );
    if (!upd.rows.length) {
      skipped.push({
        roomId: contract.room_id,
        contractId: contract.id,
        contractNo: contract.contract_no,
        tenantName: contract.tenant_name,
        reason: 'contract_changed_before_update',
      });
      continue;
    }
    updated.push({
      contractId: contract.id,
      contractNo: contract.contract_no,
      roomId: contract.room_id,
      tenantName: contract.tenant_name,
      rent: { from: currentRent, to: Number(upd.rows[0].monthly_rent) },
      deposit: { from: currentDeposit, to: Number(upd.rows[0].deposit) },
    });
  }
  return {
    ok: true,
    updatedCount: updated.length,
    skippedCount: skipped.length,
    updated,
    skipped: skipped.slice(0, 20),
  };
}

app.post('/api/admin/pricing-impact', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager', 'staff'), async (req, res) => {
  const nextConfig = req.body && req.body.value !== undefined ? req.body.value : req.body;
  if (!nextConfig || typeof nextConfig !== 'object' || Array.isArray(nextConfig)) {
    return res.status(400).json({ error: 'value must be a config object', code: 'BAD_SHAPE' });
  }
  try {
    const impact = await buildPricingImpactForConfig(pool, nextConfig);
    res.json({ ok: true, impact });
  } catch (err) {
    console.error('pricing impact error:', err);
    res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
  }
});

app.get('/api/data/:key', async (req, res) => {
  const key = req.params.key;
  if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: 'invalid key' });
  const isAuth = !!(req.session && req.session.user);
  if (!isAuth && !PUBLIC_KEYS.has(key)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (key === 'baankarn_rooms_v1') {
      await releaseExpiredPublicBookingHolds(pool, { skipOversized: true });
    }
    const sizeQ = await pool.query(
      'SELECT updated_at, octet_length(value::text) AS payload_bytes FROM app_data WHERE key=$1',
      [key]
    );
    if (!sizeQ.rows.length) {
      return res.json({ key, value: null, updatedAt: null });
    }
    if (oversizedAppDataPayload(sizeQ.rows[0])) {
      const info = oversizedAppDataInfo(sizeQ.rows[0]);
      console.warn(`[data] omitting oversized GET for ${key} (${info.bytes} bytes)`);
      return res.json({
        key,
        value: null,
        updatedAt: sizeQ.rows[0].updated_at,
        ...info,
      });
    }
    const { rows } = await pool.query('SELECT value, updated_at FROM app_data WHERE key=$1', [key]);
    let value = rows.length ? rows[0].value : null;
    const updatedAt = rows.length ? rows[0].updated_at : null;
    if (!isAuth && key === 'baankarn_rooms_v1') {
      // Load config so the public rent reflects the current pricing formula
      // (admin's /admin#pricing edits show up here without waiting for a
      // per-room re-save). One extra query per public room load — cached
      // would be nice but the row is small.
      let cfg = null;
      try {
        const c = await pool.query(`SELECT value FROM app_data WHERE key='baankarn_config_v1'`);
        cfg = c.rows[0]?.value || null;
      } catch { /* fall back to legacy r.rent inside maskRoomsPublic */ }
      value = maskRoomsPublic(value, cfg);
    }
    if (!isAuth && key === 'baankarn_config_v1') value = maskConfigPublic(value);
    res.json({ key, value, updatedAt });
  } catch (err) {
    console.error('data GET error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/data', async (req, res) => {
  const isAuth = !!(req.session && req.session.user);
  try {
    const keys = isAuth ? Array.from(ALLOWED_KEYS) : Array.from(PUBLIC_KEYS);
    if (keys.includes('baankarn_rooms_v1')) {
      await releaseExpiredPublicBookingHolds(pool, { skipOversized: true });
    }
    const sizeRows = await pool.query(
      'SELECT key, updated_at, octet_length(value::text) AS payload_bytes FROM app_data WHERE key = ANY($1)',
      [keys]
    );
    const safeKeys = sizeRows.rows
      .filter((r) => !oversizedAppDataPayload(r))
      .map((r) => r.key);
    const { rows } = safeKeys.length
      ? await pool.query(
          'SELECT key, value, updated_at FROM app_data WHERE key = ANY($1)',
          [safeKeys]
        )
      : { rows: [] };
    const valueRowsByKey = new Map(rows.map((r) => [r.key, r]));
    const out = {};
    // For unauth callers we need to mask rooms AGAINST the (also-masked)
    // config so the public rent runs through the same formula resolver as
    // the admin bill engine. Pre-resolve the raw config row before iterating.
    const rawConfigRow = !isAuth
      ? valueRowsByKey.get('baankarn_config_v1')
      : null;
    const rawConfigForRooms = rawConfigRow ? rawConfigRow.value : null;
    // Per-key row versions for the optimistic-lock handshake (PUT
    // baseUpdatedAt). Tucked under `__meta` so existing consumers that
    // iterate known keys (api-client SYNCED_KEYS) are unaffected.
    const meta = { updatedAt: {}, bytes: {}, omitted: {} };
    for (const sizeRow of sizeRows.rows) {
      meta.updatedAt[sizeRow.key] = sizeRow.updated_at;
      meta.bytes[sizeRow.key] = appDataPayloadBytes(sizeRow);
      if (oversizedAppDataPayload(sizeRow)) {
        const info = oversizedAppDataInfo(sizeRow);
        console.warn(`[data] omitting oversized GET-all value for ${sizeRow.key} (${info.bytes} bytes)`);
        out[sizeRow.key] = null;
        meta.omitted[sizeRow.key] = info;
        continue;
      }
      const r = valueRowsByKey.get(sizeRow.key);
      if (!r) continue;
      let v = r.value;
      if (!isAuth && r.key === 'baankarn_rooms_v1')  v = maskRoomsPublic(v, rawConfigForRooms);
      if (!isAuth && r.key === 'baankarn_config_v1') v = maskConfigPublic(v);
      out[r.key] = v;
    }
    out.__meta = meta;
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
  if (value === null || value === undefined) {
    return res.status(400).json({
      error: 'use DELETE to remove a key',
      code: 'NULL_VALUE',
      hint: 'JSON string values such as "null" are rejected so app_data never stores a null blob.',
    });
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
  if (want === 'object' && (value === null || typeof value !== 'object' || Array.isArray(value))) {
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
  // === Semantic validation for baankarn_config_v1 ==========================
  // Pricing can legitimately be unusual (promo room, test contract, waived
  // deposit). Do not block those saves. Instead, return warnings so the UI
  // can make the operator confirm while still preserving deliberate values.
  // Keep hard rejects only for data that would make downstream features
  // ambiguous or broken, such as an enabled payment receiver with no valid
  // target.
  let configWarnings = [];
  let pricingImpactReview = null;
  let pricingContractUpdateMode = 'new_only';
  let pricingContractUpdateResult = null;
  if (key === 'baankarn_config_v1') {
    // === Payment-receiver protection (AuthZ) ================================
    // value.payment.{promptpay,bankAcc,truemoneyPhone,…} decides WHERE every
    // tenant's bill payment actually goes (billing.buildEffectivePaymentBlock
    // reads it as the first-priority receiver). PUT /api/data is open to the
    // 'staff' role, but the receiver is an owner/manager concern — it is
    // owner-gated on the secrets surface and owner/manager-gated on
    // system-settings. Without this guard a staff account could repoint every
    // bill's PromptPay/bank/TrueMoney target to their own and silently harvest
    // rent. So: for a non-owner/manager actor we force the STORED payment block
    // to survive unchanged — their edits to other config (rooms pricing,
    // building info) still apply, but payment.* is preserved (or dropped on a
    // first-ever save). Preserve rather than reject so a legitimate non-payment
    // settings save by staff isn't blocked by JSON key-ordering noise.
    const actorRole = req.session.user && req.session.user.role;
    const privileged = actorRole === 'owner' || actorRole === 'manager';
    if (!privileged) {
      let storedPayment;
      try {
        const cur = await pool.query(
          `SELECT value->'payment' AS payment FROM app_data WHERE key=$1`, [key]
        );
        storedPayment = cur.rows.length ? cur.rows[0].payment : undefined;
      } catch { storedPayment = undefined; }
      const submitted = JSON.stringify(value.payment ?? null);
      const preserved = JSON.stringify(storedPayment ?? null);
      if (submitted !== preserved) {
        // Surface the attempt: a staff account trying to change the receiver is
        // worth an audit trail even though we silently ignore the change.
        audit(req, 'data.put.payment_preserved', 'app_data', key, {
          role: actorRole, attempted: true,
        });
      }
      if (storedPayment === undefined || storedPayment === null) {
        delete value.payment;
      } else {
        value.payment = storedPayment;
      }
    }
    const MIN_SENSIBLE_RENT = 100;
    const MIN_SENSIBLE_DEPOSIT = 100;
    const MIN_SENSIBLE_UTILITY = 1;
    const hardIssues = [];
    const warnings = [];
    const building = value.building && typeof value.building === 'object' ? value.building : null;
    if (building && building.logo !== undefined) {
      const logo = normalizeBuildingLogoUrl(building.logo);
      if (logo === null) {
        hardIssues.push('building.logo ต้องเป็นไฟล์โลโก้ที่อัปโหลดผ่านระบบเท่านั้น');
      } else if (logo && !(await fileUrlHasCategory(logo, 'building_logo'))) {
        hardIssues.push('building.logo ต้องอ้างอิงไฟล์หมวด building_logo ที่อัปโหลดผ่านระบบเท่านั้น');
      } else {
        building.logo = logo;
      }
    }
    const rates = value.rates && typeof value.rates === 'object' ? value.rates : {};
    for (const [type, r] of Object.entries(rates)) {
      if (!r || typeof r !== 'object') continue;
      const rent = Number(r.rent);
      if (Number.isFinite(rent) && rent > 0 && rent < MIN_SENSIBLE_RENT) {
        warnings.push(`rates.${type}.rent = ${rent} (ต่ำผิดปกติ — ตรวจสอบว่าตั้งใจใช้ค่านี้จริงก่อนออกสัญญา/บิล)`);
      }
      const dep = Number(r.deposit);
      if (Number.isFinite(dep) && dep > 0 && dep < MIN_SENSIBLE_DEPOSIT) {
        warnings.push(`rates.${type}.deposit = ${dep} (ต่ำผิดปกติ — ตรวจสอบว่าตั้งใจเก็บมัดจำค่านี้จริง)`);
      }
    }
    const u = value.utilities && typeof value.utilities === 'object' ? value.utilities : {};
    for (const k of ['waterRate', 'elecRate']) {
      const v = Number(u[k]);
      if (Number.isFinite(v) && v < 0) {
        // Negative rate flips the bill line into a credit — never legitimate.
        hardIssues.push(`utilities.${k} = ${v} — อัตราค่าน้ำ/ค่าไฟติดลบไม่ได้ (บิลจะกลายเป็นยอดติดลบ)`);
      } else if (Number.isFinite(v) && v > 0 && v < MIN_SENSIBLE_UTILITY) {
        warnings.push(`utilities.${k} = ${v} (ต่ำผิดปกติ — บิลค่าน้ำ/ค่าไฟอาจต่ำกว่าที่คาด)`);
      }
    }
    // Cross-feature heads-up: utility-rate changes apply only to bills
    // generated AFTER this save (issued bills keep their snapshot), so tell
    // the operator explicitly instead of letting them assume old unpaid
    // bills re-price themselves.
    try {
      const curU = await pool.query(
        `SELECT value->'utilities' AS utilities FROM app_data WHERE key=$1`, [key]
      );
      const storedU = curU.rows.length && curU.rows[0].utilities
        && typeof curU.rows[0].utilities === 'object' ? curU.rows[0].utilities : null;
      if (storedU) {
        for (const k of ['waterRate', 'elecRate']) {
          const before = Number(storedU[k]);
          const after = Number(u[k]);
          if (Number.isFinite(before) && Number.isFinite(after) && before !== after) {
            warnings.push(
              `utilities.${k} เปลี่ยน ${before} → ${after} — มีผลเฉพาะบิลที่ออกหลังจากนี้ `
              + `บิลค้างชำระเดิมยังใช้เรทเก่า ถ้าต้องการเรทใหม่กับบิลเดิมให้ void แล้วออกบิลใหม่`
            );
          }
        }
      }
    } catch { /* heads-up is best-effort — never block the save on a probe failure */ }
    const payment = value.payment && typeof value.payment === 'object' ? value.payment : null;
    // Cross-feature safeguard: changing the RECEIVING account while unpaid
    // bills are in flight strands every QR / bank-info message already sent
    // — tenants who pay the OLD account will fail the slip receiver check
    // and pile up in the admin queue. Legitimate (changing banks happens),
    // so warn — never block — and tell the operator what to expect.
    if (payment) {
      try {
        const digitsOf = (v) => String(v || '').replace(/[^0-9]/g, '');
        const receiverKeys = ['promptpay', 'bankAcc', 'truemoneyPhone'];
        const cur = await pool.query(
          `SELECT value->'payment' AS payment FROM app_data WHERE key=$1`, [key]
        );
        const stored = cur.rows.length && cur.rows[0].payment && typeof cur.rows[0].payment === 'object'
          ? cur.rows[0].payment : null;
        if (stored) {
          const changed = receiverKeys.filter((k) => {
            const before = digitsOf(stored[k]);
            const after = digitsOf(payment[k]);
            return before && after && before !== after;
          });
          if (changed.length) {
            const unpaid = await pool.query(
              `SELECT COUNT(*)::int AS n FROM bills
                WHERE status IN ('pending','overdue') AND deleted_at IS NULL`
            );
            const n = Number(unpaid.rows[0]?.n) || 0;
            if (n > 0) {
              warnings.push(
                `เปลี่ยนบัญชีรับเงิน (${changed.join(', ')}) ขณะมีบิลค้างชำระ ${n} ใบ — `
                + `QR/ข้อความที่ส่งไปแล้วชี้บัญชีเดิม ผู้เช่าที่โอนเข้าบัญชีเดิมหลังจากนี้`
                + `สลิปจะติดตรวจที่คิวแอดมิน (RECEIVER_MISMATCH) — แนะนำส่งบิลแจ้งซ้ำหลังบันทึก`
              );
            }
          }
        }
      } catch { /* warning is best-effort — never block the save on a probe failure */ }
    }
    if (payment) {
      const trueMoneyPhone = String(payment.truemoneyPhone || payment.trueMoneyPhone || payment.walletPhone || '')
        .replace(/[\s-]/g, '');
      if (payment.truemoney === true) {
        if (!/^0\d{9}$/.test(trueMoneyPhone)) {
          hardIssues.push('payment.truemoneyPhone = ต้องเป็นเบอร์มือถือ 10 หลักและขึ้นต้นด้วย 0 เมื่อเปิด TrueMoney Wallet');
        } else {
          payment.truemoneyPhone = trueMoneyPhone;
        }
      } else if (trueMoneyPhone && /^0\d{9}$/.test(trueMoneyPhone)) {
        payment.truemoneyPhone = trueMoneyPhone;
      }
      for (const [field, max] of Object.entries({ truemoneyName: 120, truemoneyNote: 240 })) {
        if (payment[field] === null || payment[field] === undefined) continue;
        if (typeof payment[field] !== 'string') {
          hardIssues.push(`payment.${field} ต้องเป็นข้อความ`);
          continue;
        }
        const trimmed = payment[field].trim();
        if (trimmed.length > max) {
          hardIssues.push(`payment.${field} ยาวเกิน ${max} ตัวอักษร`);
          continue;
        }
        payment[field] = trimmed;
      }
    }
    if (building) {
      if (typeof building.line === 'string') {
        building.line = building.line.trim().replace(/^@+/, '');
      }
      const rawLineAddFriendUrl = String(building.lineAddFriendUrl || '').trim();
      if (rawLineAddFriendUrl) {
        const safeLineAddFriendUrl = lineOa.normaliseLineAddUrl(rawLineAddFriendUrl);
        if (!safeLineAddFriendUrl) {
          hardIssues.push('building.lineAddFriendUrl = ต้องเป็น https://line.me หรือ https://lin.ee เท่านั้น');
        } else {
          building.lineAddFriendUrl = safeLineAddFriendUrl;
        }
      } else {
        building.lineAddFriendUrl = '';
      }
    }
    // floorPremium / viewPremium / featurePremium are ADDITIVE deltas —
    // they can legitimately be 0, but negative values can't be intended
    // unless admin really wants a "discount per floor" which we don't
    // support yet. Block negatives outright.
    for (const k of ['floorPremium', 'viewPremium', 'featurePremium']) {
      const obj = value[k];
      if (!obj || typeof obj !== 'object') continue;
      for (const [name, raw] of Object.entries(obj)) {
        const n = Number(raw);
        if (Number.isFinite(n) && n < 0) {
          warnings.push(`${k}.${name} = ${n} (ลบ — ตรวจสอบว่านี่คือส่วนลดที่ตั้งใจให้มีผลกับสูตรราคา)`);
        }
      }
    }
    if (hardIssues.length) {
      return res.status(400).json({
        error: 'ค่า config ไม่ผ่านการตรวจสอบ',
        code: 'INVALID_CONFIG',
        issues: hardIssues,
        hint: 'แก้ค่าที่หน้า /admin#settings แล้วบันทึกใหม่ ระบบจะบล็อกเฉพาะข้อมูลที่ทำให้ระบบทำงานต่อไม่ได้',
      });
    }
    const rawMode = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body.pricingContractMode
      : undefined;
    pricingContractUpdateMode = rawMode === 'update_active' ? 'update_active' : 'new_only';
    const pricingImpactAcknowledged = !!(req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      && req.body.pricingImpactAcknowledged === true);
    if (pricingContractUpdateMode === 'update_active') {
      if (!privileged) {
        return res.status(403).json({
          error: 'เฉพาะ owner/manager เท่านั้นที่อัปเดตยอดในสัญญา active ได้',
          code: 'PRICING_CONTRACT_UPDATE_FORBIDDEN',
          hint: 'เลือกบันทึกเฉพาะสัญญาใหม่ หรือให้ owner/manager เป็นผู้ทำรายการ',
        });
      }
      const confirmToken = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body.pricingContractConfirm
        : null;
      if (confirmToken !== PRICING_CONTRACT_UPDATE_CONFIRM) {
        return res.status(400).json({
          error: 'ต้องยืนยันการอัปเดตสัญญา active อย่างชัดเจน',
          code: 'PRICING_CONTRACT_UPDATE_CONFIRM_REQUIRED',
          required: PRICING_CONTRACT_UPDATE_CONFIRM,
        });
      }
    }

    pricingImpactReview = await buildPricingImpactForConfig(pool, value);
    if (pricingImpactReview?.summary?.requiresReview && !pricingImpactAcknowledged) {
      return res.status(409).json({
        error: 'ต้องตรวจผลกระทบของการเปลี่ยนราคาก่อนบันทึก',
        code: 'PRICING_IMPACT_REVIEW_REQUIRED',
        impact: pricingImpactReview,
        hint: 'ตรวจรายชื่อห้อง/สัญญาที่กระทบ แล้วเลือกว่าจะใช้เฉพาะสัญญาใหม่หรืออัปเดตสัญญา active ด้วย',
      });
    }
    if (pricingImpactReview?.summary?.activeContractChanges > 0) {
      if (pricingContractUpdateMode === 'update_active') {
        warnings.push(`ยืนยันให้อัปเดตสัญญา active ${pricingImpactReview.summary.activeContractChanges} รายการตาม pricing ใหม่`);
      } else {
        warnings.push(`สัญญา active ${pricingImpactReview.summary.activeContractChanges} รายการจะยังใช้ยอดเดิมในสัญญา — pricing ใหม่มีผลกับสัญญาใหม่/ต่อสัญญา`);
      }
    }
    if (pricingImpactReview?.summary?.futureRoomChanges > 0) {
      warnings.push(`ห้องที่ยังไม่ lock สัญญา ${pricingImpactReview.summary.futureRoomChanges} ห้องจะใช้ยอด pricing ใหม่ในสัญญาถัดไป`);
    }
    configWarnings = warnings;
    serialised = JSON.stringify(value);
  }
  // Optimistic concurrency: the client may echo back the `updated_at` it
  // hydrated (body.baseUpdatedAt). These blobs are read-modify-write across
  // HTTP — admin loads the rooms blob, edits in the browser for minutes,
  // then PUTs the WHOLE object back. Meanwhile a public booking, the hold
  // sweeper, a check-in, or another admin may have changed the same blob —
  // without a version check the stale PUT silently erases those changes
  // (e.g. a room reserved by a new booking flips back to vacant → double
  // booking). When baseUpdatedAt is present and doesn't match the row, the
  // save is refused with 409 STALE_WRITE so the client re-hydrates first.
  // Clients that don't send it (older/static pages) keep last-write-wins.
  const baseUpdatedAtRaw = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body.baseUpdatedAt : undefined;
  let baseUpdatedAtMs = null;
  if (baseUpdatedAtRaw !== undefined && baseUpdatedAtRaw !== null && baseUpdatedAtRaw !== '') {
    const t = new Date(baseUpdatedAtRaw).getTime();
    if (!Number.isFinite(t)) {
      return res.status(400).json({
        error: 'baseUpdatedAt ต้องเป็นเวลารูปแบบ ISO ที่อ่านได้',
        code: 'INVALID_BASE_UPDATED_AT',
      });
    }
    baseUpdatedAtMs = t;
  }
  // For room/config blobs: use a transaction with SELECT FOR UPDATE to prevent
  // last-write-wins when two admins save simultaneously (admin A's save would
  // silently overwrite admin B's room changes). Bookings blob has its own
  // per-endpoint locking, so skip the unconditional lock to avoid nested-lock
  // contention — but ANY key takes the locked path when a version check was
  // requested (the check must be atomic with the write).
  const LOCK_KEYS = new Set(['baankarn_rooms_v1', 'baankarn_config_v1']);
  let savedUpdatedAt = null;
  try {
    if (LOCK_KEYS.has(key) || baseUpdatedAtMs !== null) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        let currentRow = null;
        try {
          const cur = await client.query(
            `SELECT updated_at, updated_by FROM app_data WHERE key=$1 FOR UPDATE`, [key]
          );
          currentRow = cur.rows[0] || null;
        } catch { /* row/table may not exist yet — that's fine */ }
        if (baseUpdatedAtMs !== null && currentRow && currentRow.updated_at) {
          // Compare at second precision — the JSON round-trip through the
          // browser keeps milliseconds but older stored values may carry
          // microseconds Postgres-side. Mirrors db/optimisticLock.js.
          const dbMs = new Date(currentRow.updated_at).getTime();
          if (Math.floor(dbMs / 1000) !== Math.floor(baseUpdatedAtMs / 1000)) {
            // Stale base — but if the submitted value is SEMANTICALLY
            // IDENTICAL to what's stored (jsonb equality ignores key order),
            // this is just the admin UI echoing back a change the server
            // already applied (e.g. local state patched after a checkout
            // endpoint mutated the same blob). Accept it as a no-op and hand
            // back the current version so the client re-bases, instead of
            // crying STALE_WRITE over nothing.
            const sameQ = await client.query(
              `SELECT (value = $2::jsonb) AS same FROM app_data WHERE key=$1`,
              [key, serialised]
            );
            if (sameQ.rows[0] && sameQ.rows[0].same === true) {
              await client.query('COMMIT');
              return res.json({
                ok: true, key, noop: true,
                roomSync: null, warnings: configWarnings,
                updatedAt: currentRow.updated_at,
              });
            }
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: 'ข้อมูลชุดนี้ถูกแก้ไขโดยผู้ใช้อื่นหรือระบบหลังจากหน้าจอนี้โหลดมา — ระบบยกเลิกการบันทึกเพื่อไม่ให้ทับข้อมูลล่าสุด',
              code: 'STALE_WRITE',
              key,
              currentUpdatedAt: currentRow.updated_at,
              currentUpdatedBy: currentRow.updated_by || null,
              hint: 'โหลดข้อมูลล่าสุดแล้วทำรายการอีกครั้ง',
            });
          }
        }
        const ins = await client.query(
          `INSERT INTO app_data (key, value, updated_by)
           VALUES ($1, $2::jsonb, $3)
           ON CONFLICT (key) DO UPDATE
             SET value = EXCLUDED.value,
                 updated_at = NOW(),
                 updated_by = EXCLUDED.updated_by
           RETURNING updated_at`,
          [key, serialised, req.session.user.username]
        );
        if (key === 'baankarn_config_v1' && pricingContractUpdateMode === 'update_active') {
          pricingContractUpdateResult = await applyPricingToActiveContracts(client, value);
        }
        await client.query('COMMIT');
        savedUpdatedAt = ins.rows[0] ? ins.rows[0].updated_at : null;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } else {
      const ins = await pool.query(
        `INSERT INTO app_data (key, value, updated_by)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value,
               updated_at = NOW(),
               updated_by = EXCLUDED.updated_by
         RETURNING updated_at`,
        [key, serialised, req.session.user.username]
      );
      savedUpdatedAt = ins.rows[0] ? ins.rows[0].updated_at : null;
    }
    audit(req, 'data.put', 'app_data', key);
    if (pricingContractUpdateResult) {
      audit(req, 'pricing.contracts_bulk_update', 'contract', 'bulk', {
        updatedCount: pricingContractUpdateResult.updatedCount,
        skippedCount: pricingContractUpdateResult.skippedCount,
        updated: pricingContractUpdateResult.updated.slice(0, 20),
      });
    }
    let roomSyncResult = null;
    // Bridge: when admin saves the rooms blob, mirror tenant info into
    // the tenants table so the tenant portal + bills + LINE binding all
    // see the same identities. Also upsert the same room inventory into
    // rooms_v2 so newer API paths do not drift from the legacy UI blob.
    if (key === 'baankarn_rooms_v1' && value && typeof value === 'object') {
      try {
        roomSyncResult = await roomSync.upsertRoomsV2FromJsonb(pool, {
          roomsObj: value,
          updatedBy: req.session.user.username,
        });
      } catch (err) {
        console.error('[bridge] rooms→rooms_v2 sync failed:', err.message);
        roomSyncResult = { ok: false, error: err.message };
      }
      mirrorRoomsToTenants(value, req.session.user.username).catch(async (err) => {
        console.error('[bridge] rooms→tenants mirror failed:', err.message);
        // Surface to the owner: a failed mirror leaves rooms in the blob
        // without matching tenants rows, which breaks: tenant login by
        // phone, /api/tenant/bills (no JOIN match), LINE binding (no
        // tenant_id target), and scheduler bill-gen (filters on tenants
        // row presence for tenant_id). Without an alert the admin only
        // discovers the gap when a tenant complains they "can't see
        // their bill" — sometimes weeks later.
        try {
          const flags = await features.load(pool).catch(() => ({}));
          await notifier.notifyOwner({ pool, features: flags }, {
            category: 'system',
            subject: '⚠️ บันทึกข้อมูลผู้เช่าใหม่ไม่สมบูรณ์ — กรุณาตรวจสอบ',
            text: [
              'ระบบบันทึกห้องสำเร็จ แต่คัดลอกข้อมูลผู้เช่าเข้าทะเบียนผู้เช่าไม่สำเร็จ',
              '',
              `ข้อความจากระบบ: ${err.message}`,
              '',
              '⚠️ ถ้าปล่อยไว้จะเกิดอะไรขึ้น:',
              '   • ผู้เช่าใหม่จะเข้าดูบิลของตัวเองด้วยเบอร์โทรไม่ได้',
              '   • บิลที่ออกใหม่จะไม่ผูกกับผู้เช่า ผู้เช่าจะไม่ได้รับแจ้งเตือน',
              '   • การผูก LINE ของห้องนี้จะยังใช้ไม่ได้',
              '',
              '👉 วิธีแก้: เปิดเมนู "สถานะระบบ" (/admin#health) ดูหัวข้อความถูกต้องของข้อมูล แล้วเปิดห้องนั้นกดบันทึกซ้ำอีกครั้ง ถ้ายังไม่หายให้แจ้งผู้ดูแลระบบพร้อมข้อความด้านบน',
            ].join('\n'),
          });
        } catch (notifyErr) {
          console.warn('[bridge] mirror failure alert also failed:', notifyErr.message);
        }
      });
    }
    res.json({
      ok: true, key, roomSync: roomSyncResult, warnings: configWarnings,
      pricingImpact: pricingImpactReview,
      contractUpdates: pricingContractUpdateResult,
      // Fresh row version — the client stores this as its next baseUpdatedAt
      // so consecutive saves from the same tab don't false-conflict.
      updatedAt: savedUpdatedAt,
    });
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
    // Only mirror rooms that represent a CONFIRMED occupancy. A 'reserved' room
    // (e.g. a pending public booking) carries an applicant snapshot but has no
    // contract/approval yet — mirroring it would create a phantom 'active'
    // tenant and flip the room to 'occupied' the next time an admin saves ANY
    // room. An empty/legacy status (older blobs that never set one) still
    // mirrors, so confirmed-occupied legacy rooms keep working.
    const rstatus = String(room.status || '').toLowerCase();
    if (rstatus && rstatus !== 'occupied' && rstatus !== 'overdue') continue;
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
    // We never touch citizen_id_encrypted — that comes from /api/tenants
    // endpoints with explicit identity input.
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
      // Fail CLOSED: if we can't verify the system is empty (DB hiccup /
      // circuit breaker / statement timeout), refuse the destructive wipe
      // rather than assuming there's no real data behind it. The operator can
      // retry, or pass ?force=1 after confirming in the UI.
      console.error('[data DELETE] production-data check failed — refusing:', err.message);
      return res.status(503).json({
        error: 'ตรวจสอบข้อมูลจริงไม่สำเร็จ — ยังไม่ลบเพื่อความปลอดภัย โปรดลองใหม่อีกครั้ง',
        code: 'PRODUCTION_DATA_CHECK_FAILED',
        hint: 'ส่ง ?force=1 เพื่อยืนยันการลบ (จะถูกบันทึกใน audit log)',
      });
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
function makeIpLimiter({ windowMs, max, message = 'too many requests', code = 'RATE_LIMIT' }) {
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
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - arr.length - 1));
    if (arr.length >= max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000));
      res.setHeader('Retry-After', retryAfterSeconds);
      return res.status(429).json({ error: message, code, retryAfterSeconds });
    }
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
const rateLimitBookingHold = makeIpLimiter({
  windowMs: 60_000,
  max: 12,
  message: 'ล็อกห้องถี่เกินไป กรุณารอสักครู่แล้วลองใหม่',
});
const rateLimitBookingSubmit = makeIpLimiter({
  windowMs: 5 * 60_000,
  max: 8,
  message: 'ส่งคำขอจองถี่เกินไป กรุณารอสักครู่แล้วลองใหม่',
});
const rateLimitTicket  = makeIpLimiter({ windowMs: 60_000, max: 3 });
const rateLimitQr = makeIpLimiter({
  windowMs: 60_000,
  max: 120,
  message: 'เปิด QR ถี่เกินไป กรุณารอสักครู่แล้วลองใหม่',
});
const rateLimitPublicPaymentView = makeIpLimiter({
  windowMs: 60_000,
  max: 120,
  message: 'เปิดหน้าชำระเงินถี่เกินไป กรุณารอสักครู่แล้วลองใหม่',
});
const rateLimitPublicPaymentUpload = makeIpLimiter({
  windowMs: 60_000,
  max: 20,
  message: 'ส่งสลิปถี่เกินไป กรุณารอสักครู่แล้วลองใหม่',
});
const rateLimitFileAccess = makeIpLimiter({
  windowMs: 60_000,
  max: 120,
  message: 'file access too frequent',
});
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

function roomBookingSettings(flags) {
  const raw = (flags && flags.roomBooking) || {};
  const amount = Number(raw.depositAmount);
  const minimumRaw = Number(raw.minimumAmount);
  const holdMinutes = Number(raw.holdMinutes);
  const maxBytes = Number(raw.maxBytes);
  const openAtTs = raw.openAt ? Date.parse(raw.openAt) : NaN;
  const openAt = Number.isFinite(openAtTs) ? new Date(openAtTs).toISOString() : null;
  const minimumAmount = Number.isFinite(minimumRaw) && minimumRaw > 0
    ? Math.min(Math.max(minimumRaw, 1), 1_000_000)
    : 0;
  const configuredAmount = Number.isFinite(amount) && amount >= 0
    ? Math.min(amount, 1_000_000)
    : 500;
  return {
    enabled: raw.enabled !== false,
    openAt,
    requireDeposit: raw.requireDeposit === true,
    requireSlip: raw.requireSlip !== false,
    depositAmount: minimumAmount > 0
      ? Math.max(configuredAmount, minimumAmount)
      : configuredAmount,
    configuredDepositAmount: configuredAmount,
    minimumAmount,
    applyBookingFeeToDeposit: raw.applyBookingFeeToDeposit === true,
    holdMinutes: Number.isFinite(holdMinutes) && holdMinutes > 0
      ? Math.min(Math.max(Math.trunc(holdMinutes), 1), 120)
      : 15,
    maxBytes: Number.isFinite(maxBytes) && maxBytes > 0
      ? Math.min(maxBytes, 5_000_000)
      : 1_500_000,
    allowedMimes: Array.isArray(raw.allowedMimes) && raw.allowedMimes.length
      ? raw.allowedMimes
      : ['image/jpeg', 'image/png', 'image/webp'],
  };
}

function roomBookingOpenState(settings, now = new Date()) {
  const serverNow = now.toISOString();
  const openAtTs = settings && settings.openAt ? Date.parse(settings.openAt) : NaN;
  const scheduled = !!(settings && settings.enabled && Number.isFinite(openAtTs) && openAtTs > now.getTime());
  const enabled = !!(settings && settings.enabled && !scheduled);
  return {
    enabled,
    status: !settings || settings.enabled === false ? 'closed' : (scheduled ? 'scheduled' : 'open'),
    scheduled,
    onlineEnabled: !!(settings && settings.enabled),
    openAt: settings && settings.openAt ? settings.openAt : null,
    serverNow,
    opensInMs: scheduled ? Math.max(0, openAtTs - now.getTime()) : 0,
  };
}

function bookingDepositStatus(settings, hasSlip, verification = {}) {
  if (!settings || !settings.requireDeposit) return 'not_required';
  if (verification && verification.status) return verification.status;
  if (hasSlip) return 'pending_review';
  return settings.requireSlip ? 'awaiting_slip' : 'manual_review';
}

function bookingDepositVerificationNotice({
  status,
  verifyResult,
  autoVerifyAttempted,
  requireVerification,
}) {
  const code = verifyResult?.code || null;
  const provider = verifyResult?.provider || null;
  const attemptCount = Array.isArray(verifyResult?.attempts) ? verifyResult.attempts.length : 0;
  const base = {
    status,
    attempted: !!autoVerifyAttempted,
    ok: !!(verifyResult && verifyResult.ok),
    provider,
    code,
    transactionRef: verifyResult?.transRef || null,
    amount: verifyResult?.amount ?? null,
    sender: publicPartyForSlipNotice(verifyResult?.sender),
    receiver: publicPartyForSlipNotice(verifyResult?.receiver),
    transDate: verifyResult?.transDate || null,
    attempts: Array.isArray(verifyResult?.attempts) ? verifyResult.attempts : [],
  };
  if (status === 'verified') {
    return {
      ...base,
      severity: 'success',
      title: 'ตรวจสลิปค่าจองผ่านแล้ว',
      message: 'ระบบยืนยันแล้วว่าสลิปค่าจองเป็นรายการจริง ยอดและบัญชีปลายทางตรงกับที่ตั้งไว้',
      nextAction: 'ห้องถูกล็อกเป็นการจองแล้ว รอแอดมินตรวจข้อมูลและอนุมัติสัญญา',
    };
  }
  if (status === 'pending_review') {
    if (verifyResult?.ok && requireVerification) {
      return {
        ...base,
        severity: 'pending',
        title: 'สลิปค่าจองตรวจผ่าน รอแอดมินยืนยัน',
        message: 'บริการตรวจสลิปยืนยันรายการแล้ว แต่ระบบตั้งค่าให้แอดมินตรวจทานก่อนสรุปผล',
        nextAction: 'ห้องถูกล็อกเป็นการจองแล้ว รอแอดมินตรวจข้อมูล ไม่ต้องส่งสลิปซ้ำ',
      };
    }
    if (autoVerifyAttempted) {
      return {
        ...base,
        severity: 'pending',
        title: 'รับสลิปค่าจองแล้ว รอแอดมินตรวจ',
        message: `ระบบลองตรวจสลิปอัตโนมัติแล้ว${attemptCount ? ` ${attemptCount} provider` : ''} แต่ยังไม่ได้ผลยืนยันที่ปลอดภัย${code ? ` (รหัส ${code})` : ''}`,
        nextAction: 'ห้องถูกล็อกเป็นการจองแล้ว แอดมินต้องเปิดดูสลิปและตรวจยอดก่อนอนุมัติ',
      };
    }
    return {
      ...base,
      severity: 'pending',
      title: 'รับสลิปค่าจองแล้ว',
      message: 'ระบบยังไม่ได้เปิดหรือยังไม่พร้อมใช้การตรวจสลิปอัตโนมัติ จึงส่งรายการให้แอดมินตรวจด้วยมือ',
      nextAction: 'ห้องถูกล็อกเป็นการจองแล้ว รอแอดมินตรวจยอดโอนและติดต่อกลับ',
    };
  }
  if (status === 'manual_review') {
    return {
      ...base,
      severity: 'pending',
      title: 'รับคำขอจองแล้ว',
      message: 'การตั้งค่านี้ไม่บังคับแนบสลิป แอดมินจะตรวจค่าจองหรือรับชำระด้วยมือ',
      nextAction: 'รอแอดมินติดต่อกลับเพื่อยืนยันยอดและขั้นตอนถัดไป',
    };
  }
  const copy = slipRejectCopy(code, verifyResult?.error || 'สลิปค่าจองไม่ผ่านการตรวจสอบ');
  return {
    ...base,
    severity: 'error',
    title: copy.title,
    message: copy.message,
    nextAction: copy.nextAction,
  };
}

const ROOM_BOOKING_EDITABLE_FIELDS = new Set([
  'enabled',
  'openAt',
  'requireDeposit',
  'depositAmount',
  'minimumAmount',
  'applyBookingFeeToDeposit',
  'requireSlip',
  'holdMinutes',
  'maxBytes',
  'allowedMimes',
]);
const ROOM_BOOKING_ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ROOM_BOOKING_DISABLED_NOTICE = {
  code: 'ROOM_BOOKING_DISABLED',
  error: 'ระบบจองห้องถูกปิดใช้งานอยู่',
  message: 'ขณะนี้ยังไม่รับคำขอจองออนไลน์ กรุณาติดต่อแอดมินหรือกลับมาตรวจสอบอีกครั้ง',
  nextAction: 'เปิดรับจองจากหน้าแอดมินเมื่อพร้อมให้ผู้สนใจส่งคำขอจอง',
};
const ROOM_BOOKING_SCHEDULED_NOTICE = {
  code: 'ROOM_BOOKING_NOT_OPEN_YET',
  error: 'ยังไม่เปิดรับจองออนไลน์',
  message: 'ระบบจองห้องจะเปิดรับคำขอตามเวลาที่กำหนด',
  nextAction: 'รอจนถึงเวลาที่แสดงบนหน้าเว็บ ระบบจะโหลดห้องว่างให้อัตโนมัติ',
};

function roomBookingDisabledPayload(extra = {}) {
  const scheduled = extra && (extra.scheduled || extra.status === 'scheduled');
  return {
    ...(scheduled ? ROOM_BOOKING_SCHEDULED_NOTICE : ROOM_BOOKING_DISABLED_NOTICE),
    ...extra,
    enabled: false,
  };
}

function normalizeRoomBookingEditableSettings(raw) {
  const base = {
    ...features.DEFAULTS.roomBooking,
    ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}),
  };
  const effective = roomBookingSettings({ roomBooking: base });
  return {
    enabled: effective.enabled,
    openAt: effective.openAt,
    requireDeposit: effective.requireDeposit,
    requireSlip: effective.requireSlip,
    depositAmount: effective.configuredDepositAmount,
    minimumAmount: effective.minimumAmount,
    applyBookingFeeToDeposit: effective.applyBookingFeeToDeposit,
    holdMinutes: effective.holdMinutes,
    maxBytes: effective.maxBytes,
    allowedMimes: Array.isArray(base.allowedMimes) && base.allowedMimes.length
      ? base.allowedMimes.filter((m) => ROOM_BOOKING_ALLOWED_MIMES.has(m))
      : [...ROOM_BOOKING_ALLOWED_MIMES],
  };
}

function parseRoomBookingEditableSettings(input, currentRaw) {
  const current = normalizeRoomBookingEditableSettings(currentRaw);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      issues: [{
        field: 'roomBooking',
        code: 'BOOKING_DEPOSIT_SETTINGS_REQUIRED',
        message: 'ต้องส่งค่า roomBooking เป็น object',
      }],
    };
  }
  const issues = [];
  const unknown = Object.keys(input).filter((k) => !ROOM_BOOKING_EDITABLE_FIELDS.has(k));
  if (unknown.length) {
    issues.push({
      field: 'roomBooking',
      code: 'BOOKING_DEPOSIT_UNKNOWN_FIELD',
      message: `ไม่รองรับค่า: ${unknown.join(', ')}`,
    });
  }
  const boolField = (field) => {
    if (input[field] === undefined) return current[field] === true;
    if (typeof input[field] === 'boolean') return input[field];
    issues.push({
      field,
      code: 'BOOKING_DEPOSIT_INVALID_BOOLEAN',
      message: `${field} ต้องเป็น true หรือ false`,
    });
    return current[field] === true;
  };
  const numField = (field, min, max, fallback, code) => {
    if (input[field] === undefined) return fallback;
    const n = Number(input[field]);
    if (!Number.isFinite(n) || n < min || n > max) {
      issues.push({
        field,
        code,
        message: `${field} ต้องอยู่ระหว่าง ${min} ถึง ${max}`,
      });
      return fallback;
    }
    return Math.round(n);
  };
  const parseOpenAt = () => {
    if (input.openAt === undefined) return current.openAt || null;
    if (input.openAt === null || input.openAt === '') return null;
    const ts = Date.parse(String(input.openAt));
    if (!Number.isFinite(ts)) {
      issues.push({
        field: 'openAt',
        code: 'BOOKING_OPEN_AT_INVALID',
        message: 'เวลาเปิดจองต้องเป็นวันเวลาที่ถูกต้อง',
      });
      return current.openAt || null;
    }
    const maxFuture = Date.now() + 730 * 24 * 60 * 60 * 1000;
    if (ts > maxFuture) {
      issues.push({
        field: 'openAt',
        code: 'BOOKING_OPEN_AT_RANGE',
        message: 'ตั้งเวลาเปิดจองล่วงหน้าได้ไม่เกิน 730 วัน',
      });
      return current.openAt || null;
    }
    return new Date(ts).toISOString();
  };
  const depositAmount = numField(
    'depositAmount',
    0,
    1_000_000,
    current.depositAmount,
    'BOOKING_DEPOSIT_AMOUNT_RANGE'
  );
  let minimumAmount = 0;
  if (input.minimumAmount === undefined) {
    minimumAmount = current.minimumAmount;
  } else {
    const n = Number(input.minimumAmount);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000 || (n > 0 && n < 1)) {
      issues.push({
        field: 'minimumAmount',
        code: 'BOOKING_DEPOSIT_MINIMUM_RANGE',
        message: 'ขั้นต่ำต้องเป็น 0 หรืออย่างน้อย 1 บาท และไม่เกิน 1,000,000 บาท',
      });
      minimumAmount = current.minimumAmount;
    } else {
      minimumAmount = n > 0 ? Math.round(n) : 0;
    }
  }
  const next = {
    enabled: boolField('enabled'),
    openAt: parseOpenAt(),
    requireDeposit: boolField('requireDeposit'),
    requireSlip: boolField('requireSlip'),
    depositAmount,
    minimumAmount,
    applyBookingFeeToDeposit: boolField('applyBookingFeeToDeposit'),
    holdMinutes: numField(
      'holdMinutes',
      1,
      120,
      current.holdMinutes,
      'BOOKING_DEPOSIT_HOLD_MINUTES_RANGE'
    ),
    maxBytes: numField(
      'maxBytes',
      100_000,
      5_000_000,
      current.maxBytes,
      'BOOKING_DEPOSIT_MAX_BYTES_RANGE'
    ),
    allowedMimes: current.allowedMimes,
  };
  if (input.allowedMimes !== undefined) {
    if (!Array.isArray(input.allowedMimes) || input.allowedMimes.length === 0) {
      issues.push({
        field: 'allowedMimes',
        code: 'BOOKING_DEPOSIT_MIME_REQUIRED',
        message: 'allowedMimes ต้องเป็น array ที่มีชนิดไฟล์อย่างน้อย 1 รายการ',
      });
    } else {
      const cleaned = input.allowedMimes
        .map((m) => String(m || '').trim())
        .filter((m) => ROOM_BOOKING_ALLOWED_MIMES.has(m));
      if (cleaned.length !== input.allowedMimes.length) {
        issues.push({
          field: 'allowedMimes',
          code: 'BOOKING_DEPOSIT_MIME_UNSUPPORTED',
          message: 'รองรับเฉพาะ image/jpeg, image/png, image/webp',
        });
      } else {
        next.allowedMimes = [...new Set(cleaned)];
      }
    }
  }
  const effectiveAmount = next.minimumAmount > 0
    ? Math.max(next.depositAmount, next.minimumAmount)
    : next.depositAmount;
  if (next.requireDeposit && effectiveAmount <= 0) {
    issues.push({
      field: 'depositAmount',
      code: 'BOOKING_DEPOSIT_AMOUNT_REQUIRED',
      message: 'เมื่อเปิดเก็บค่าจอง ยอดค่าจองที่ใช้จริงต้องมากกว่า 0 บาท',
    });
  }
  return issues.length ? { ok: false, issues } : { ok: true, settings: next };
}

function bookingHoldHash(token) {
  if (!token || typeof token !== 'string') return null;
  return cryptoSvc.hmac(`booking-hold:${token}`);
}

function advisoryInt32Key(value) {
  let h = 0x811c9dc5;
  const s = String(value || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) & 0x7fffffff;
}

function roomFromV2(row) {
  if (!row) return null;
  return {
    id: row.room_code,
    type: row.room_type,
    floor: row.floor,
    no: row.room_no,
    rent: Number(row.rent_price),
    deposit: Number(row.deposit_price || 0),
    wifi: Number(row.wifi_fee || 0),
    status: row.status || 'vacant',
  };
}

// JSONB blob can store 'available'/'empty'/'free' (legacy admin UI values).
// rooms_v2 normalises these to 'vacant' on sync. All booking/hold/public-list
// logic must accept both spellings so admin-created rooms are bookable.
function isVacantStatus(s) {
  return ['vacant', 'available', 'empty', 'free'].includes(String(s || '').toLowerCase());
}

function isPublicHoldRoom(room) {
  return !!(room && room.status === 'reserved'
    && typeof room.reservedBy === 'string'
    && room.reservedBy.startsWith('hold:'));
}

function isExpiredHold(room, now = Date.now()) {
  if (!isPublicHoldRoom(room)) return false;
  const expires = Date.parse(room.reservationExpiresAt || room.holdExpiresAt || '');
  return Number.isFinite(expires) && expires <= now;
}

function releaseHoldShape(room) {
  if (!room || typeof room !== 'object') return room;
  const {
    tenant,
    reservedBy,
    reservedAt,
    reservationExpiresAt,
    reservationMode,
    holdExpiresAt,
    holdTokenHash,
    ...rest
  } = room;
  return { ...rest, status: 'vacant' };
}

async function releaseExpiredPublicBookingHolds(dbOrClient, opts = {}) {
  const ownClient = typeof dbOrClient.connect === 'function'
    && typeof dbOrClient.release !== 'function';
  const client = ownClient ? await dbOrClient.connect() : dbOrClient;
  const released = [];
  try {
    if (ownClient) await client.query('BEGIN');
    if (opts.skipOversized) {
      const sizeRes = await client.query(
        `SELECT octet_length(value::text) AS payload_bytes FROM app_data WHERE key='baankarn_rooms_v1'`
      );
      if (sizeRes.rows.length && oversizedAppDataPayload(sizeRes.rows[0])) {
        const info = oversizedAppDataInfo(sizeRes.rows[0]);
        console.warn(`[booking-hold] skipped expired-hold sweep because rooms blob is oversized (${info.bytes} bytes)`);
        if (ownClient) await client.query('COMMIT');
        return { released, skipped: 'rooms_blob_oversized', bytes: info.bytes };
      }
    }
    const rRes = await client.query(
      `SELECT value FROM app_data WHERE key='baankarn_rooms_v1' FOR UPDATE`
    );
    const rooms = rRes.rows.length && rRes.rows[0].value && typeof rRes.rows[0].value === 'object'
      ? rRes.rows[0].value
      : {};
    let changed = false;
    for (const [roomId, room] of Object.entries(rooms)) {
      if (!isExpiredHold(room)) continue;
      rooms[roomId] = releaseHoldShape(room);
      released.push(roomId);
      changed = true;
      try {
        await client.query(
          `UPDATE rooms_v2 SET status='vacant', updated_at=NOW()
             WHERE room_code=$1 AND status='reserved' AND deleted_at IS NULL`,
          [roomId]
        );
      } catch (err) {
        if (err.code !== '42P01') throw err;
      }
    }
    if (changed) {
      await client.query(
        `INSERT INTO app_data (key, value, updated_by) VALUES ($1, $2, 'booking-hold-sweeper')
           ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW(), updated_by='booking-hold-sweeper'`,
        ['baankarn_rooms_v1', JSON.stringify(rooms)]
      );
    }
    if (ownClient) await client.query('COMMIT');
    return { released };
  } catch (err) {
    if (ownClient) await client.query('ROLLBACK').catch(() => {});
    console.warn('[booking-hold] release expired failed:', err.message);
    return { released, error: err.message };
  } finally {
    if (ownClient) client.release();
  }
}

async function publicBookingDepositInfo() {
  const flags = await features.load(pool);
  const settings = roomBookingSettings(flags);
  let payment = null;
  let paymentBlock = null;
  if (settings.requireDeposit) {
    ({ paymentBlock } = await loadEffectivePaymentBlock());
    const amount = settings.depositAmount;
    const bankInfo = paymentBlock.bankInfo && paymentBlock.bankInfo.account
      ? paymentBlock.bankInfo
      : null;
    payment = {
      amount,
      promptpayName: paymentBlock.promptpayName || paymentBlock.promptpayDisplayName || null,
      targetLast4: paymentBlock.promptpayTarget ? String(paymentBlock.promptpayTarget).slice(-4) : null,
      bankInfo,
      walletInfo: paymentBlock.walletInfo || null,
      paymentMethods: Array.isArray(paymentBlock.paymentMethods) ? paymentBlock.paymentMethods : [],
      qrDataUrl: null,
    };
    try {
      const slipVerifier = require('./services/slipVerifier');
      const providers = slipVerifier.getConfiguredProviders(flags);
      payment.slipAutoVerify = {
        enabled: flags?.slipUpload?.enabled !== false && flags?.slipUpload?.autoVerify === true,
        ready: providers.length > 0,
        requireAdminConfirmation: flags?.slipUpload?.requireVerification === true,
        providers: providers.map((p) => ({ id: p.id, label: p.label })),
      };
    } catch {
      payment.slipAutoVerify = {
        enabled: false,
        ready: false,
        requireAdminConfirmation: true,
        providers: [],
      };
    }
    if (paymentBlock.promptpayTarget && Number.isFinite(amount) && amount > 0) {
      try {
        const target = normaliseTarget(paymentBlock.promptpayTarget);
        if (!isDemoTarget(target)) {
          payment.qrDataUrl = await renderQrDataUrl(target, amount);
        }
      } catch { /* display bank/manual transfer fallback */ }
    }
    payment.ready = !!(payment.qrDataUrl || bankInfo || payment.walletInfo);
  }
  return { settings, payment, flags, paymentBlock };
}

function resolvePublicLineContactLinks(config) {
  const building = config && typeof config === 'object' && config.building && typeof config.building === 'object'
    ? config.building
    : {};
  const configuredAddFriendUrl = lineOa.normaliseLineAddUrl(building.lineAddFriendUrl)
    || lineOa.normaliseLineAddUrl(building.lineUrl)
    || lineOa.normaliseLineAddUrl(building.lineLink);
  const configured = !!configuredAddFriendUrl;
  return {
    addFriendUrl: configuredAddFriendUrl || null,
    configured,
    source: configured ? 'building-line-contact' : 'none',
    message: configured
      ? 'LINE ติดต่อพร้อมใช้งาน'
      : 'ยังไม่ได้ตั้งค่าลิงก์ LINE ติดต่อ โปรดติดต่อแอดมินเพื่อรับช่องทาง LINE',
  };
}

function looksSuspiciousPublicLineUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (/(example|dummy|placeholder|test|sdfsfsdf)/.test(lower)) return true;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (host === 'line.me' || host.endsWith('.line.me')) {
      const p = u.pathname.toLowerCase();
      return !(/\/ti\/p\/|\/r\/ti\/p\/|\/oa\//.test(p));
    }
  } catch {
    return true;
  }
  return false;
}

async function loadPublicLineContactLinks() {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
    );
    return resolvePublicLineContactLinks(rows[0]?.value || null);
  } catch {
    return resolvePublicLineContactLinks(null);
  }
}

async function bookingDepositAdminPaymentReadiness(amount) {
  const { paymentBlock } = await loadEffectivePaymentBlock();
  const bankInfo = paymentBlock.bankInfo && paymentBlock.bankInfo.account
    ? paymentBlock.bankInfo
    : null;
  let promptpayReady = false;
  if (paymentBlock.promptpayTarget && Number.isFinite(amount) && amount > 0) {
    try {
      const target = normaliseTarget(paymentBlock.promptpayTarget);
      promptpayReady = !isDemoTarget(target);
    } catch {
      promptpayReady = false;
    }
  }
  const walletInfo = paymentBlock.walletInfo || null;
  return {
    amount,
    ready: !!(promptpayReady || bankInfo || walletInfo),
    promptpayReady,
    promptpayName: paymentBlock.promptpayName || paymentBlock.promptpayDisplayName || null,
    targetLast4: paymentBlock.promptpayTarget ? String(paymentBlock.promptpayTarget).slice(-4) : null,
    bankInfo,
    walletInfo,
    paymentMethods: Array.isArray(paymentBlock.paymentMethods) ? paymentBlock.paymentMethods : [],
  };
}

app.get('/api/bookings/public/config', async (_req, res) => {
  try {
    // skipOversized: on a property whose rooms blob has bloated past the
    // response cap, don't take a FOR UPDATE rewrite of the whole blob on
    // every anonymous page load — the 60s in-process sweeper still expires
    // holds. Mirrors the authenticated /api/data paths.
    await releaseExpiredPublicBookingHolds(pool, { skipOversized: true });
    const { settings, payment } = await publicBookingDepositInfo();
    const openState = roomBookingOpenState(settings);
    const lineContact = await loadPublicLineContactLinks();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      booking: {
        enabled: openState.enabled,
        onlineEnabled: settings.enabled,
        bookingStatus: openState.status,
        scheduled: openState.scheduled,
        openAt: openState.openAt,
        serverNow: openState.serverNow,
        opensInMs: openState.opensInMs,
        requireDeposit: settings.requireDeposit,
        requireSlip: settings.requireSlip,
        depositAmount: settings.depositAmount,
        configuredDepositAmount: settings.configuredDepositAmount,
        minimumAmount: settings.minimumAmount,
        applyBookingFeeToDeposit: settings.applyBookingFeeToDeposit,
        holdMinutes: settings.holdMinutes,
        maxBytes: settings.maxBytes,
        allowedMimes: settings.allowedMimes,
        payment,
        lineContact,
        disabledNotice: openState.enabled ? null : roomBookingDisabledPayload(openState),
      },
    });
  } catch (err) {
    console.error('public booking config error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/bookings/public/rooms', async (_req, res) => {
  try {
    // skipOversized: see /config above — keep anonymous reads off the
    // exclusive blob-rewrite path; the background sweeper covers expiry.
    await releaseExpiredPublicBookingHolds(pool, { skipOversized: true });
    const flags = await features.load(pool);
    const settings = roomBookingSettings(flags);
    const openState = roomBookingOpenState(settings);
    if (!openState.enabled) {
      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        ok: true,
        enabled: false,
        count: 0,
        rooms: [],
        ...roomBookingDisabledPayload(openState),
      });
    }
    const { rows } = await pool.query(
      `SELECT key, value FROM app_data WHERE key = ANY($1)`,
      [['baankarn_rooms_v1', 'baankarn_config_v1']]
    );
    const rawRooms = rows.find((r) => r.key === 'baankarn_rooms_v1')?.value || {};
    const rawConfig = rows.find((r) => r.key === 'baankarn_config_v1')?.value || null;
    let v2Rows = [];
    try {
      const v2 = await pool.query(
        `SELECT room_code, room_type, floor, room_no, rent_price, deposit_price, wifi_fee, status
           FROM rooms_v2
          WHERE deleted_at IS NULL
          ORDER BY floor NULLS LAST, room_no NULLS LAST, room_code`
      );
      v2Rows = v2.rows;
    } catch (err) {
      if (err.code !== '42P01') throw err;
    }
    const rooms = publicBookableRooms(rawRooms, rawConfig, v2Rows);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, enabled: true, count: rooms.length, rooms });
  } catch (err) {
    console.error('public booking rooms error:', err);
    res.status(500).json({ error: 'internal error', code: 'ROOMS_LOAD_FAILED' });
  }
});

app.post('/api/bookings/public/hold', sameOrigin, rateLimitBookingHold, async (req, res) => {
  const roomId = String(req.body?.roomId || '').trim().slice(0, 32);
  if (!roomId) return res.status(400).json({ error: 'roomId required', code: 'ROOM_REQUIRED' });
  let settings, payment;
  try {
    ({ settings, payment } = await publicBookingDepositInfo());
  } catch (err) {
    console.error('public booking hold config error:', err);
    return res.status(500).json({ error: 'internal error', code: 'CONFIG_ERROR' });
  }
  if (!settings.enabled) {
    return res.status(503).json(roomBookingDisabledPayload(roomBookingOpenState(settings)));
  }
  const holdOpenState = roomBookingOpenState(settings);
  if (!holdOpenState.enabled) {
    return res.status(503).json(roomBookingDisabledPayload(holdOpenState));
  }
  if (!settings.requireDeposit) {
    return res.json({ ok: true, holdRequired: false, booking: { requireDeposit: false } });
  }
  if (settings.requireDeposit && settings.requireSlip && payment && payment.ready === false) {
    return res.status(503).json({
      error: 'ยังไม่ได้ตั้งค่าบัญชีรับเงินค่าจอง',
      code: 'BOOKING_DEPOSIT_PAYMENT_NOT_CONFIGURED',
      hint: 'ตั้งค่า PromptPay/บัญชีธนาคาร หรือปิดการบังคับแนบสลิปค่าจองเพื่อรับจองแบบ manual review',
    });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await releaseExpiredPublicBookingHolds(client);
    const rRes = await client.query(
      `SELECT value FROM app_data WHERE key='baankarn_rooms_v1' FOR UPDATE`
    );
    const rooms = rRes.rows.length && rRes.rows[0].value && typeof rRes.rows[0].value === 'object'
      ? rRes.rows[0].value
      : {};
    let room = rooms[roomId] || null;
    let v2Room = null;
    try {
      const v2 = await client.query(
        `SELECT room_code, room_type, floor, room_no, rent_price, deposit_price, wifi_fee, status
           FROM rooms_v2
          WHERE room_code=$1 AND deleted_at IS NULL
          FOR UPDATE`,
        [roomId]
      );
      v2Room = v2.rows[0] || null;
      if (!room && v2Room) room = roomFromV2(v2Room);
    } catch (err) {
      if (err.code !== '42P01') throw err;
    }
    if (!room) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'ไม่พบห้องนี้', code: 'ROOM_NOT_FOUND' });
    }
    if (!isVacantStatus(room.status) || (v2Room && !isVacantStatus(v2Room.status))) {
      await client.query('ROLLBACK');
      const expiresAt = isPublicHoldRoom(room) ? (room.reservationExpiresAt || null) : null;
      return res.status(409).json({
        error: expiresAt ? 'ห้องนี้ถูกล็อกโดยผู้จองก่อนหน้าอยู่' : 'ห้องนี้ไม่ว่างสำหรับจอง',
        code: expiresAt ? 'ROOM_HELD' : 'ROOM_NOT_VACANT',
        expiresAt,
      });
    }
    const token = require('crypto').randomBytes(24).toString('base64url');
    const tokenHash = bookingHoldHash(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + settings.holdMinutes * 60_000);
    rooms[roomId] = {
      ...room,
      id: room.id || roomId,
      status: 'reserved',
      reservedBy: `hold:${tokenHash}`,
      reservedAt: now.toISOString(),
      reservationExpiresAt: expiresAt.toISOString(),
      reservationMode: 'public_booking_hold',
      holdTokenHash: tokenHash,
    };
    await client.query(
      `INSERT INTO app_data (key, value, updated_by) VALUES ($1, $2, 'public-hold')
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW(), updated_by='public-hold'`,
      ['baankarn_rooms_v1', JSON.stringify(rooms)]
    );
    try {
      await client.query(
        `UPDATE rooms_v2 SET status='reserved', updated_at=NOW()
           WHERE room_code=$1 AND status='vacant' AND deleted_at IS NULL`,
        [roomId]
      );
    } catch (err) {
      if (err.code !== '42P01') throw err;
    }
    await client.query('COMMIT');
    audit(req, 'booking.hold_create', 'room', roomId, {
      holdMinutes: settings.holdMinutes,
      expiresAt: expiresAt.toISOString(),
    }, 'public').catch(() => {});
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      holdRequired: true,
      hold: { token, roomId, expiresAt: expiresAt.toISOString() },
      booking: {
        requireDeposit: true,
        depositAmount: settings.depositAmount,
        minimumAmount: settings.minimumAmount,
        applyBookingFeeToDeposit: settings.applyBookingFeeToDeposit,
        holdMinutes: settings.holdMinutes,
        payment,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('public booking hold error:', err);
    res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
  } finally {
    client.release();
  }
});

app.post('/api/bookings/public/hold/release', sameOrigin, rateLimitBookingHold, async (req, res) => {
  const roomId = String(req.body?.roomId || '').trim().slice(0, 32);
  const holdToken = String(req.body?.holdToken || '').trim().slice(0, 200);
  const reason = String(req.body?.reason || 'client_release').trim().slice(0, 64);
  if (!roomId) return res.status(400).json({ error: 'roomId required', code: 'ROOM_REQUIRED' });
  if (!holdToken) return res.status(400).json({ error: 'holdToken required', code: 'BOOKING_HOLD_TOKEN_REQUIRED' });
  const tokenHash = bookingHoldHash(holdToken);
  if (!tokenHash) return res.status(400).json({ error: 'holdToken invalid', code: 'BOOKING_HOLD_TOKEN_INVALID' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await releaseExpiredPublicBookingHolds(client);
    const rRes = await client.query(
      `SELECT value FROM app_data WHERE key='baankarn_rooms_v1' FOR UPDATE`
    );
    const rooms = rRes.rows.length && rRes.rows[0].value && typeof rRes.rows[0].value === 'object'
      ? rRes.rows[0].value
      : {};
    const room = rooms[roomId] || null;
    const ownsHold = room && isPublicHoldRoom(room) && room.reservedBy === `hold:${tokenHash}`;
    if (!ownsHold) {
      await client.query('COMMIT');
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, released: false, code: 'BOOKING_HOLD_NOT_OWNED' });
    }
    rooms[roomId] = releaseHoldShape(room);
    await client.query(
      `INSERT INTO app_data (key, value, updated_by) VALUES ($1, $2, 'public-hold-release')
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW(), updated_by='public-hold-release'`,
      ['baankarn_rooms_v1', JSON.stringify(rooms)]
    );
    try {
      await client.query(
        `UPDATE rooms_v2 SET status='vacant', updated_at=NOW()
           WHERE room_code=$1 AND status='reserved' AND deleted_at IS NULL`,
        [roomId]
      );
    } catch (err) {
      if (err.code !== '42P01') throw err;
    }
    await client.query('COMMIT');
    audit(req, 'booking.hold_release', 'room', roomId, { reason }, 'public').catch(() => {});
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, released: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('public booking hold release error:', err);
    res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
  } finally {
    client.release();
  }
});

app.post('/api/bookings/public', sameOrigin, rateLimitBookingSubmit, validateBody(schemas.publicBooking), async (req, res) => {
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
    holdToken: str(b.holdToken, 200),
    depositSlip: typeof b.depositSlip === 'string' ? b.depositSlip : '',
    agreedTermsVersion: str(b.agreedTermsVersion, 64),
  };
  if (!cleaned.tenantName.trim()) {
    return res.status(400).json({ error: 'tenantName required' });
  }
  let bookingSettings, bookingPayment, bookingFlags, bookingPaymentBlock;
  try {
    ({
      settings: bookingSettings,
      payment: bookingPayment,
      flags: bookingFlags,
      paymentBlock: bookingPaymentBlock,
    } = await publicBookingDepositInfo());
  } catch (err) {
    console.error('public booking config load error:', err);
    return res.status(500).json({ error: 'internal error', code: 'CONFIG_ERROR' });
  }
  // Booking open/closed state. Closing booking must STOP new attempts but must
  // not abandon in-flight ones: a user who already locked a room (a valid hold
  // token) before the admin closed booking — and may already have transferred
  // the deposit — is allowed to DRAIN (finish their submission). The hold is
  // re-validated under the row lock (sameHold) inside the transaction below; a
  // closed-window submit WITHOUT a valid owning hold is refused there. Up front
  // we only hard-reject when nothing is in flight to drain (no room+hold pair).
  const submitOpenState = roomBookingOpenState(bookingSettings);
  const bookingOpen = !!bookingSettings.enabled && submitOpenState.enabled;
  const hasHoldAttempt = !!(cleaned.roomId && cleaned.holdToken);
  if (!bookingOpen && !hasHoldAttempt) {
    return res.status(503).json(roomBookingDisabledPayload(submitOpenState));
  }
  if (bookingSettings.requireDeposit) {
    if (!cleaned.roomId) {
      return res.status(400).json({
        error: 'ต้องเลือกห้องก่อนจองแบบมีค่าจอง',
        code: 'ROOM_REQUIRED_FOR_BOOKING_DEPOSIT',
        hint: 'เปิดหน้าห้องว่างแล้วกดจองจากห้องที่ต้องการ เพื่อให้ระบบล็อกห้องได้ถูกต้อง',
      });
    }
    if (!cleaned.holdToken) {
      return res.status(400).json({
        error: 'ต้องล็อกห้องก่อนส่งคำขอจองแบบมีค่าจอง',
        code: 'BOOKING_HOLD_REQUIRED',
        hint: 'เลือกห้องว่างจากหน้าจอง แล้วรอให้ระบบล็อกห้องสำเร็จก่อนส่งคำขอ',
      });
    }
    if (bookingSettings.requireSlip && bookingPayment && bookingPayment.ready === false) {
      return res.status(503).json({
        error: 'ยังไม่ได้ตั้งค่าบัญชีรับเงินค่าจอง',
        code: 'BOOKING_DEPOSIT_PAYMENT_NOT_CONFIGURED',
        hint: 'ตั้งค่า PromptPay/บัญชีธนาคาร หรือปิดการบังคับแนบสลิปค่าจองเพื่อรับจองแบบ manual review',
      });
    }
    if (bookingSettings.requireSlip && !cleaned.depositSlip) {
      return res.status(400).json({
        error: 'กรุณาแนบสลิปค่าจองก่อนส่งคำขอ',
        code: 'BOOKING_DEPOSIT_SLIP_REQUIRED',
      });
    }
  }
  // Sanity-check expected move-in date if supplied — same window as the
  // checkin endpoint so we don't accept bookings for "next year" by typo.
  if (cleaned.checkInDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned.checkInDate)) {
      return res.status(400).json({ error: 'checkInDate ต้องเป็น YYYY-MM-DD', code: 'INVALID_DATE' });
    }
    const target = new Date(cleaned.checkInDate + 'T00:00:00Z');
    const today = new Date(billing.localTodayYmd() + 'T00:00:00Z');
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
  const normalisedApplicantPhone = normaliseBookingPhone(cleaned.phone);
  // Blacklist refusal on the PUBLIC path: reject before storing identity
  // images or touching deposit slips. The message stays vague so we do not
  // disclose blacklist status to the applicant.
  if (normalisedApplicantPhone) {
    try {
      const black = await pool.query(
        `SELECT id FROM tenants
           WHERE deleted_at IS NULL AND status='blacklist'
             AND REPLACE(REPLACE(COALESCE(phone, ''), ' ', ''), '-', '')=$1
           LIMIT 1`,
        [normalisedApplicantPhone]
      );
      if (black.rows.length) {
        return res.status(403).json({
          error: 'ไม่สามารถรับจองด้วยเบอร์นี้ได้ กรุณาติดต่อสำนักงานโดยตรง',
          code: 'TENANT_BLACKLISTED',
        });
      }
    } catch (err) {
      if (err.code !== '42P01' && err.code !== '42703') {
        console.warn('[public-booking] blacklist check skipped:', err.message);
      }
    }
  }
  // Optional citizen ID front photo: store via the same storage pipeline.
  // Failure here doesn't fail the booking — admin can request it later.
  let frontFileId = null;
  let idImageWarning = null;
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
      // The booking still succeeds (admin can request the ID photo later), but
      // don't drop it SILENTLY — the schema allows a ~3 MB string while save is
      // capped at 1.5 MB, so an oversized photo would otherwise vanish with no
      // feedback. Surface a warning the applicant/admin can act on.
      idImageWarning = /file too large/i.test(String(err.message || ''))
        ? 'รูปบัตรประชาชนมีขนาดใหญ่เกินกำหนด ระบบรับจองแล้วแต่ยังไม่ได้แนบรูป กรุณาส่งรูปที่เล็กลงให้เจ้าหน้าที่ภายหลัง'
        : 'อัปโหลดรูปบัตรประชาชนไม่สำเร็จ ระบบรับจองแล้วแต่ยังไม่ได้แนบรูป เจ้าหน้าที่อาจขอใหม่ภายหลัง';
    }
  }
  // Build the new booking object outside the transaction.
  const VALID_TYPES = ['standard', 'deluxe', 'suite', 'studio'];
  const wantType = VALID_TYPES.includes(cleaned.roomType) ? cleaned.roomType : 'standard';
  const wantFloor = Number(cleaned.floor) || null;
  const bookingId = 'BK-PUB-' + require('crypto').randomBytes(6).toString('hex');
  const holdTokenHash = bookingHoldHash(cleaned.holdToken);
  let applicantRisk = null;
  if (normalisedApplicantPhone) {
    try {
      const existingTenant = await pool.query(
        `SELECT id, full_name, current_room_id
           FROM tenants
          WHERE deleted_at IS NULL
            AND status='active'
            AND (
              phone=$1
              OR REPLACE(REPLACE(COALESCE(phone, ''), ' ', ''), '-', '')=$2
            )
          ORDER BY updated_at DESC
          LIMIT 1`,
        [cleaned.phone, normalisedApplicantPhone]
      );
      if (existingTenant.rows.length) {
        const t = existingTenant.rows[0];
        applicantRisk = {
          code: 'APPLICANT_PHONE_ALREADY_ACTIVE_TENANT',
          tenantId: t.id,
          tenantName: t.full_name || null,
          currentRoomId: t.current_room_id || null,
          message: t.current_room_id
            ? `เบอร์นี้มีผู้เช่า active อยู่ห้อง ${t.current_room_id} แล้ว`
            : 'เบอร์นี้มีผู้เช่า active อยู่แล้ว',
          nextAction: 'โทรยืนยันว่าเป็นผู้เช่าเดิมจองอีกห้อง หรือจองแทนเพื่อน ก่อนอนุมัติและสร้างสัญญา',
        };
      }
    } catch (err) {
      if (err.code !== '42P01' && err.code !== '42703') {
        console.warn('[public-booking] active-tenant risk check skipped:', err.message);
      }
    }
  }
  let depositSlipFile = null;
  let depositSlipHash = null;
  let depositVerifyResult = null;
  let depositAutoVerifyAttempted = false;
  let depositVerificationStatus = null;
  let depositVerificationReason = null;
  let depositPaymentMethod = null;
  if (bookingSettings.requireDeposit && cleaned.depositSlip) {
    try {
      const rawBuf = Buffer.from(String(cleaned.depositSlip).replace(/^data:[^;]+;base64,/, ''), 'base64');
      if (!rawBuf.length) {
        return res.status(400).json({ error: 'สลิปค่าจองไม่ถูกต้อง', code: 'INVALID_BOOKING_DEPOSIT_SLIP' });
      }
      // Enforce the operator's byte ceiling BEFORE the paid verify round-trip.
      // The zod schema caps the base64 string at ~3 MB, but the operator's
      // maxBytes (default 1.5 MB) was previously checked only at the final
      // storage.saveBase64 — i.e. AFTER the slip was decoded and shipped to the
      // external verify provider, wasting the provider call on an over-cap blob.
      if (Number(bookingSettings.maxBytes) > 0 && rawBuf.length > Number(bookingSettings.maxBytes)) {
        return res.status(400).json({
          error: `ไฟล์สลิปใหญ่เกินกำหนด (สูงสุด ${Math.floor(Number(bookingSettings.maxBytes) / 1024)} KB)`,
          code: 'BOOKING_DEPOSIT_SLIP_TOO_LARGE',
        });
      }
      depositSlipHash = cryptoSvc.hmac(rawBuf);
      const dupPayment = await pool.query(
        `SELECT id FROM payments WHERE slip_hash=$1 LIMIT 1`,
        [depositSlipHash]
      );
      if (dupPayment.rows.length) {
        return res.status(409).json({
          error: 'สลิปนี้ถูกใช้กับการชำระเงินรายการอื่นแล้ว',
          code: 'DUPLICATE_BOOKING_DEPOSIT_SLIP',
        });
      }
      try {
        const dupBooking = await pool.query(
          `SELECT external_id FROM bookings WHERE deposit_slip_hash=$1 LIMIT 1`,
          [depositSlipHash]
        );
        if (dupBooking.rows.length) {
          return res.status(409).json({
            error: 'สลิปนี้ถูกใช้กับการจองก่อนหน้าแล้ว',
            code: 'DUPLICATE_BOOKING_DEPOSIT_SLIP',
            bookingId: dupBooking.rows[0].external_id,
          });
        }
      } catch (err) {
        if (err.code !== '42703') throw err;
      }
      const slipVerifier = require('./services/slipVerifier');
      const autoVerifyReady = bookingFlags?.slipUpload?.enabled !== false
        && slipVerifier.isConfigured(bookingFlags);
      if (autoVerifyReady) {
        depositAutoVerifyAttempted = true;
        try {
          let ppTarget = null;
          if (bookingPaymentBlock?.promptpayTarget) {
            try {
              const normalised = normaliseTarget(bookingPaymentBlock.promptpayTarget);
              ppTarget = isDemoTarget(normalised) ? null : normalised;
            } catch { ppTarget = null; }
          }
          const extraTargets = paymentBlockReceiverTargetEntries(bookingPaymentBlock)
            .filter((target) => target.method !== 'promptpay');
          if (!ppTarget && extraTargets.length === 0) {
            depositVerifyResult = {
              ok: false,
              error: 'ยังไม่ได้ตั้งค่าบัญชีปลายทางที่ใช้ตรวจสลิปค่าจอง',
              code: 'NOT_CONFIGURED',
              attempts: [],
            };
          } else {
            depositVerifyResult = await slipVerifier.verifyWithFallback(
              rawBuf,
              {
                amount: bookingSettings.depositAmount,
                billId: bookingId,
                promptpayTarget: ppTarget || null,
                additionalReceiverTargets: extraTargets,
                // Same operator hardening as the bill-slip path — booking
                // deposits go to the same receiving accounts, so the same
                // receiver scrutiny applies. Weak/strict outcomes are
                // TRANSIENT → this path already maps them to pending_review.
                easyslipMatchAccount: bookingFlags?.slipUpload?.providerReceiverCheck === true,
                slip2goCheckReceiver: bookingFlags?.slipUpload?.providerReceiverCheck === true,
                strictReceiverTail: bookingFlags?.slipUpload?.strictReceiverTail === true,
              },
              bookingFlags
            );
          }
        } catch (err) {
          depositVerifyResult = { ok: false, error: err.message, code: 'VERIFIER_THREW', attempts: [] };
        }
        const transient = depositVerifyResult && slipVerifier.TRANSIENT_CODES.has(depositVerifyResult.code);
        if (depositVerifyResult?.ok) {
          depositVerificationStatus = bookingFlags?.slipUpload?.requireVerification
            ? 'pending_review'
            : 'verified';
          depositVerificationReason = depositVerificationStatus === 'verified'
            ? 'auto-verified booking deposit slip'
            : 'auto-verified, pending admin confirmation';
        } else if (transient) {
          depositVerificationStatus = 'pending_review';
          depositVerificationReason = `auto-verify inconclusive: ${depositVerifyResult.code}`;
        } else {
          const notice = bookingDepositVerificationNotice({
            status: 'rejected',
            verifyResult: depositVerifyResult,
            autoVerifyAttempted: true,
            requireVerification: bookingFlags?.slipUpload?.requireVerification === true,
          });
          return res.status(400).json({
            error: notice.message,
            code: 'INVALID_BOOKING_DEPOSIT_SLIP',
            slipVerification: notice,
          });
        }
      } else {
        depositVerificationStatus = 'pending_review';
        depositVerificationReason = 'auto-verify not configured for booking deposit';
      }
      if (depositVerifyResult?.transRef) {
        const dupPaymentRef = await pool.query(
          `SELECT id FROM payments WHERE transaction_ref=$1 AND status IN ('pending','verified') LIMIT 1`,
          [depositVerifyResult.transRef]
        );
        if (dupPaymentRef.rows.length) {
          return res.status(409).json({
            error: 'สลิปนี้ถูกใช้กับการชำระเงินรายการอื่นแล้ว',
            code: 'DUPLICATE_BOOKING_DEPOSIT_SLIP',
          });
        }
        try {
          const dupBookingRef = await pool.query(
            `SELECT external_id FROM bookings WHERE deposit_transaction_ref=$1 LIMIT 1`,
            [depositVerifyResult.transRef]
          );
          if (dupBookingRef.rows.length) {
            return res.status(409).json({
              error: 'สลิปนี้ถูกใช้กับการจองก่อนหน้าแล้ว',
              code: 'DUPLICATE_BOOKING_DEPOSIT_SLIP',
              bookingId: dupBookingRef.rows[0].external_id,
            });
          }
        } catch (err) {
          if (err.code !== '42703') throw err;
        }
      }
      depositPaymentMethod = inferSlipPaymentMethod(bookingPaymentBlock, depositVerifyResult, {
        promptpayTarget: bookingPaymentBlock?.promptpayTarget || null,
        defaultMethod: bookingPaymentBlock?.promptpayTarget ? 'promptpay' : 'transfer',
      });
      depositSlipFile = await storage.saveBase64({
        pool,
        category: 'slip',
        dataUrl: cleaned.depositSlip,
        refId: bookingId,
        uploadedBy: `public-booking:${bookingId}`,
        maxBytes: bookingSettings.maxBytes,
        allowedMimes: bookingSettings.allowedMimes,
      });
    } catch (err) {
      const msg = String(err.message || '');
      const isUserFacing = /expected string|unrecognized file type|mime mismatch|mime not allowed|unknown mime|file too large/i.test(msg);
      return res.status(isUserFacing ? 400 : 500).json({
        error: isUserFacing ? msg : 'อัปโหลดสลิปค่าจองไม่สำเร็จ กรุณาลองใหม่',
        code: isUserFacing ? 'INVALID_BOOKING_DEPOSIT_SLIP' : 'BOOKING_DEPOSIT_UPLOAD_FAILED',
      });
    }
  }
  const newBooking = {
    id: bookingId,
    name: cleaned.tenantName,
    phone: cleaned.phone,
    wantType,
    wantFloor,
    moveIn: cleaned.checkInDate || null,
    months: 12,
    deposit: bookingSettings.requireDeposit
      ? bookingSettings.depositAmount
      : (cleaned.expectedDeposit != null && Number.isFinite(cleaned.expectedDeposit)
          ? cleaned.expectedDeposit : 0),
    depositRequired: bookingSettings.requireDeposit,
    bookingFee: bookingSettings.requireDeposit ? bookingSettings.depositAmount : 0,
    bookingFeeAppliesToDeposit: bookingSettings.applyBookingFeeToDeposit,
    depositMinimumAmount: bookingSettings.minimumAmount,
    depositCreditAmount: 0,
    depositBalanceDue: null,
    contractDepositEstimate: null,
    depositStatus: bookingDepositStatus(bookingSettings, !!depositSlipFile, { status: depositVerificationStatus }),
    depositSlipUrl: depositSlipFile ? depositSlipFile.url : null,
    depositSlipFileId: depositSlipFile ? depositSlipFile.id : null,
    depositSlipHash: depositSlipHash || null,
    depositVerifyProvider: depositVerifyResult?.provider || null,
    depositVerifyCode: depositVerifyResult?.code || null,
    depositVerifyReason: depositVerificationReason || null,
    depositVerifyAttempts: Array.isArray(depositVerifyResult?.attempts) ? depositVerifyResult.attempts : [],
    depositVerifiedAt: depositVerificationStatus === 'verified' ? new Date().toISOString() : null,
    depositTransactionRef: depositVerifyResult?.transRef || null,
    depositPaymentMethod: depositPaymentMethod || null,
    depositVerification: depositSlipFile ? bookingDepositVerificationNotice({
      status: bookingDepositStatus(bookingSettings, !!depositSlipFile, { status: depositVerificationStatus }),
      verifyResult: depositVerifyResult,
      autoVerifyAttempted: depositAutoVerifyAttempted,
      requireVerification: bookingFlags?.slipUpload?.requireVerification === true,
    }) : null,
    holdTokenHash: holdTokenHash || null,
    holdExpiresAt: null,
    reservedAt: null,
    status: 'pending',
    createdAt: new Date().toISOString(),
    email: cleaned.email,
    message: cleaned.message,
    riskFlags: applicantRisk ? [applicantRisk.code] : [],
    applicantRisk,
    source: 'public-form',
    roomId: cleaned.roomId,
    citizenIdTail: cleaned.citizenIdTail || null,
    citizenIdImageFrontId: frontFileId,
    citizenIdImageWarning: idImageWarning,
    agreedTermsVersion: cleaned.agreedTermsVersion || null,
    agreedTermsAt: cleaned.agreedTermsVersion ? new Date().toISOString() : null,
  };
  const client = await pool.connect();
  const cleanupDepositSlip = async () => {
    if (depositSlipFile && depositSlipFile.id) {
      try { await storage.remove(pool, depositSlipFile.id); } catch { /* best effort */ }
    }
  };
  // When a deposit slip was uploaded (and possibly auto-verified — i.e. real
  // money captured) but the booking then can't be created because the room was
  // lost in the race between verify+save and the room-lock transaction, do NOT
  // delete the slip. Park a reconciliation record (keeping the slip file) and
  // alert the owner so the payment can be refunded or re-applied. Returns a ref
  // string when parked, or null (no slip / table missing). Used in place of
  // cleanupDepositSlip() on the "paid but couldn't book" conflict paths.
  const handleLostDeposit = async (reasonCode, lostRoomId) => {
    if (!depositSlipFile || !depositSlipFile.id) return null;
    let ref = null;
    try {
      ref = 'ORPH-' + require('crypto').randomBytes(6).toString('hex');
      await pool.query(
        `INSERT INTO booking_deposit_orphans
           (ref, booking_external_id, room_id, applicant_name, applicant_phone,
            amount, slip_hash, transaction_ref, slip_file_id, verify_provider,
            verify_code, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [ref, bookingId, lostRoomId || cleaned.roomId || null,
         cleaned.tenantName || null, cleaned.phone || null,
         Number(bookingSettings.depositAmount) || null,
         depositSlipHash || null, depositVerifyResult?.transRef || null,
         depositSlipFile.id, depositVerifyResult?.provider || null,
         depositVerifyResult?.code || null, reasonCode]
      );
    } catch (err) {
      // Table missing/legacy or insert failed — still DO NOT delete the slip.
      // An orphaned file is recoverable; a deleted paid slip is not. Just warn.
      console.warn('[public-booking] orphan deposit park failed (slip kept):', err.message);
      return null;
    }
    try {
      const flags = await features.load(pool);
      notifier.notifyOwner({ pool, features: flags }, {
        category: 'booking',
        subject: '⚠️ ค่าจองค้างคืน (จ่ายแล้วแต่จองห้องไม่สำเร็จ)',
        text: [
          `ผู้จอง ${cleaned.tenantName || '-'} (${cleaned.phone || '-'}) ชำระค่าจองแล้ว แต่ระบบจองห้องไม่สำเร็จ (${reasonCode})`,
          `ห้องที่พยายามจอง: ${lostRoomId || cleaned.roomId || '-'}`,
          `ยอด: ฿${Number(bookingSettings.depositAmount || 0).toLocaleString('th-TH')}`,
          `อ้างอิงการโอน: ${depositVerifyResult?.transRef || depositSlipHash || '-'}`,
          `รหัสรายการค้างคืน: ${ref}`,
          '— ขั้นต่อไป: ตรวจสอบแล้วคืนเงิน หรือจัดห้องให้ผู้จอง (สลิปถูกเก็บไว้แล้ว ไม่ได้ลบทิ้ง)',
        ].join('\n'),
      }).catch(() => {});
    } catch { /* owner alert is best-effort */ }
    return ref;
  };
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
    if (cleaned.roomId) {
      await releaseExpiredPublicBookingHolds(client);
      const roomRow = await client.query(
        `SELECT value FROM app_data WHERE key='baankarn_rooms_v1' FOR UPDATE`
      );
      const rooms = roomRow.rows.length && roomRow.rows[0].value && typeof roomRow.rows[0].value === 'object'
        ? roomRow.rows[0].value
        : {};
      let room = rooms[cleaned.roomId] || null;
      let v2Room = null;
      try {
        const v2 = await client.query(
          `SELECT room_code, room_type, floor, room_no, rent_price, deposit_price, wifi_fee, status,
                  view_type, has_balcony, has_parking, has_kitchen, has_ac,
                  rent_override, rent_override_reason
             FROM rooms_v2
            WHERE room_code=$1 AND deleted_at IS NULL
            FOR UPDATE`,
          [cleaned.roomId]
        );
        v2Room = v2.rows[0] || null;
        if (!room && v2Room) room = pricingImpactRoomFromV2(v2Room);
      } catch (err) {
        if (err.code !== '42P01') throw err;
      }
      if (!room) {
        await client.query('ROLLBACK');
        const parkedRef = await handleLostDeposit('ROOM_NOT_FOUND', cleaned.roomId);
        return res.status(404).json({
          error: 'ไม่พบห้องนี้', code: 'ROOM_NOT_FOUND',
          ...(parkedRef ? { depositParked: true, depositReconcileRef: parkedRef } : {}),
        });
      }
      const sameHold = bookingSettings.requireDeposit
        && holdTokenHash
        && room.reservedBy === `hold:${holdTokenHash}`
        && !isExpiredHold(room);
      const vacant = isVacantStatus(room.status) && (!v2Room || isVacantStatus(v2Room.status));
      // Drain guard: booking was CLOSED while this user was mid-flight. Only a
      // still-valid OWNING hold (sameHold) may complete — they committed before
      // close, possibly already paid. An expired/foreign hold on a closed
      // booking is refused with BOOKING_DISABLED (clearer than ROOM_HELD), and
      // any deposit already captured is PARKED, never silently dropped.
      if (!bookingOpen && !sameHold) {
        await client.query('ROLLBACK');
        const parkedRef = await handleLostDeposit('BOOKING_DISABLED_MIDFLIGHT', cleaned.roomId);
        return res.status(503).json({
          ...roomBookingDisabledPayload(submitOpenState),
          ...(parkedRef ? { depositParked: true, depositReconcileRef: parkedRef } : {}),
        });
      }
      if (!sameHold && !vacant) {
        await client.query('ROLLBACK');
        const parkedRef = await handleLostDeposit(isPublicHoldRoom(room) ? 'ROOM_HELD' : 'ROOM_NOT_VACANT', cleaned.roomId);
        return res.status(409).json({
          error: isPublicHoldRoom(room) ? 'ห้องนี้ถูกล็อกโดยผู้จองก่อนหน้าอยู่' : 'ห้องนี้ไม่ว่างสำหรับจอง',
          code: isPublicHoldRoom(room) ? 'ROOM_HELD' : 'ROOM_NOT_VACANT',
          expiresAt: isPublicHoldRoom(room) ? (room.reservationExpiresAt || null) : null,
          ...(parkedRef ? { depositParked: true, depositReconcileRef: parkedRef } : {}),
        });
      }
      if (bookingSettings.requireDeposit && !sameHold && holdTokenHash) {
        // The browser had a hold token, but it no longer owns this room.
        // Surface a clean conflict instead of silently creating a booking
        // on a room another person may now be paying for.
        await client.query('ROLLBACK');
        const parkedRef = await handleLostDeposit('BOOKING_HOLD_EXPIRED', cleaned.roomId);
        return res.status(409).json({
          error: 'เวลาล็อกห้องหมดแล้ว กรุณาเลือกห้องอีกครั้ง',
          code: 'BOOKING_HOLD_EXPIRED',
          ...(parkedRef ? { depositParked: true, depositReconcileRef: parkedRef } : {}),
        });
      }
      let pricingConfig = {};
      try {
        const cfgQ = await client.query(
          `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
        );
        pricingConfig = cfgQ.rows[0]?.value || {};
      } catch { /* deposit estimate falls back through the resolver */ }
      const bookingRentInfo = pricing.resolveBillingRent({ room, config: pricingConfig });
      const bookingDepositInfo = pricing.resolveContractDeposit({
        room,
        config: pricingConfig,
        rent: bookingRentInfo.rent,
      });
      const contractDepositEstimate = Math.max(0, Number(bookingDepositInfo.deposit) || 0);
      const depositCreditAmount = bookingSettings.requireDeposit && bookingSettings.applyBookingFeeToDeposit
        ? Math.min(Number(newBooking.bookingFee) || 0, contractDepositEstimate)
        : 0;
      newBooking.contractDepositEstimate = contractDepositEstimate;
      newBooking.depositCreditAmount = depositCreditAmount;
      newBooking.depositBalanceDue = contractDepositEstimate > 0
        ? Math.max(contractDepositEstimate - depositCreditAmount, 0)
        : null;
      const reservedAt = new Date().toISOString();
      newBooking.reservedAt = reservedAt;
      newBooking.holdExpiresAt = sameHold ? (room.reservationExpiresAt || null) : null;
      newBooking.roomId = cleaned.roomId;
      newBooking.assignedRoomId = cleaned.roomId;
      rooms[cleaned.roomId] = {
        ...room,
        id: room.id || cleaned.roomId,
        status: 'reserved',
        tenant: {
          name: cleaned.tenantName,
          phone: cleaned.phone || '',
          email: cleaned.email || '',
          occupation: '',
          score: 'A',
          since: billing.localTodayYmd(),
        },
        reservedBy: newBooking.id,
        reservedAt,
        reservationMode: bookingSettings.requireDeposit ? 'public_booking_deposit' : 'public_booking',
        depositStatus: newBooking.depositStatus,
        bookingFee: newBooking.bookingFee,
        bookingFeeAppliesToDeposit: newBooking.bookingFeeAppliesToDeposit,
        depositCreditAmount: newBooking.depositCreditAmount,
        depositBalanceDue: newBooking.depositBalanceDue,
      };
      delete rooms[cleaned.roomId].reservationExpiresAt;
      delete rooms[cleaned.roomId].holdExpiresAt;
      delete rooms[cleaned.roomId].holdTokenHash;
      await client.query(
        `INSERT INTO app_data (key, value, updated_by) VALUES ($1, $2, 'public-booking')
           ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW(), updated_by='public-booking'`,
        ['baankarn_rooms_v1', JSON.stringify(rooms)]
      );
      try {
        if (!sameHold) {
          const reserveV2 = await client.query(
            `UPDATE rooms_v2 SET status='reserved', updated_at=NOW()
               WHERE room_code=$1 AND status='vacant' AND deleted_at IS NULL`,
            [cleaned.roomId]
          );
          if (v2Room && reserveV2.rowCount !== 1) {
            throw Object.assign(new Error('room no longer vacant'), { code: 'ROOM_NOT_VACANT' });
          }
        }
      } catch (err) {
        if (err.code === '42P01') {
          // legacy deploy without rooms_v2: the JSONB reservation above is enough
        } else if (err.code === 'ROOM_NOT_VACANT') {
          await client.query('ROLLBACK');
          const parkedRef = await handleLostDeposit('ROOM_NOT_VACANT', cleaned.roomId);
          return res.status(409).json({
            error: 'ห้องนี้ไม่ว่างสำหรับจอง', code: 'ROOM_NOT_VACANT',
            ...(parkedRef ? { depositParked: true, depositReconcileRef: parkedRef } : {}),
          });
        } else {
          throw err;
        }
      }
    }
    if (!cleaned.roomId) {
      // Idempotency for roomless/inquiry bookings: a double-tap, or a client
      // retry after a slow/timed-out response, would otherwise mint a second
      // random bookingId and unshift a duplicate (the relational ON CONFLICT
      // keys on external_id, which differs each submission, so it can't dedupe
      // two distinct submissions). Re-use a still-open booking from the same
      // phone + wanted type created in the last 3 minutes instead. Mirrors the
      // admin-create DUPLICATE_BOOKING guard, but returns the existing booking
      // so a retry looks successful rather than erroring.
      const dupWindowMs = 3 * 60_000;
      const existingOpen = normalisedApplicantPhone ? list.find((x) => x
        && ['pending', 'reviewing'].includes(String(x.status || 'pending'))
        && !x.roomId
        && normaliseBookingPhone(x.phone) === normalisedApplicantPhone
        && String(x.wantType || '') === String(wantType)
        && x.createdAt && (Date.now() - Date.parse(x.createdAt)) < dupWindowMs) : null;
      if (existingOpen) {
        await client.query('ROLLBACK');
        await cleanupDepositSlip();
        return res.json({ ok: true, booking: existingOpen, duplicate: true });
      }
    }
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
             deposit_required, booking_fee, booking_fee_applies_to_deposit,
             deposit_credit_amount, deposit_balance_due, deposit_minimum_amount,
             deposit_status, deposit_slip_file_id,
             deposit_slip_hash, deposit_verify_provider, deposit_verify_code,
             deposit_verify_reason, deposit_verify_attempts, deposit_verified_at,
             deposit_transaction_ref, deposit_payment_method,
             hold_token_hash, hold_expires_at, reserved_at,
             agreed_terms_at, agreed_terms_version)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending','public-form',$10,$11,
                  $12,$13,$14,
                  $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27::jsonb,$28,$29,$30,$31,$32,$33,
                  CASE WHEN $34::text IS NOT NULL THEN NOW() ELSE NULL END, $34)
          ON CONFLICT (external_id) DO NOTHING`,
        [
          newBooking.id, newBooking.name, newBooking.phone || null,
          cleaned.email || null, wantType, wantFloor,
          cleaned.checkInDate || null, 12, newBooking.deposit,
          cleaned.message || null, cleaned.roomId || null,
          cleaned.citizenIdTail || null, frontFileId,
          cleaned.expectedDeposit != null && Number.isFinite(cleaned.expectedDeposit) ? cleaned.expectedDeposit : null,
          bookingSettings.requireDeposit,
          newBooking.bookingFee || 0,
          newBooking.bookingFeeAppliesToDeposit === true,
          newBooking.depositCreditAmount || 0,
          newBooking.depositBalanceDue,
          newBooking.depositMinimumAmount || 0,
          newBooking.depositStatus || null,
          newBooking.depositSlipFileId || null,
          newBooking.depositSlipHash || null,
          newBooking.depositVerifyProvider || null,
          newBooking.depositVerifyCode || null,
          newBooking.depositVerifyReason || null,
          JSON.stringify(newBooking.depositVerifyAttempts || []),
          newBooking.depositVerifiedAt || null,
          newBooking.depositTransactionRef || null,
          newBooking.depositPaymentMethod || null,
          newBooking.holdTokenHash || null,
          newBooking.holdExpiresAt || null,
          newBooking.reservedAt || null,
          cleaned.agreedTermsVersion || null,
        ]
      );
    } catch (err) {
      if (err.code === '23505' && /deposit_(slip_hash|transaction_ref)/.test(String(err.constraint || err.detail || ''))) {
        await client.query('ROLLBACK').catch(() => {});
        await cleanupDepositSlip();
        return res.status(409).json({
          error: 'สลิปนี้ถูกใช้กับการจองก่อนหน้าแล้ว',
          code: 'DUPLICATE_BOOKING_DEPOSIT_SLIP',
        });
      }
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
    try {
      const defaultOa = await lineOa.getDefault(pool).catch(() => null);
      const binding = await lineBinding.issueBooking(pool, {
        bookingId: newBooking.id,
        ttlDays: 7,
        createdBy: 'public-booking',
      });
      newBooking.lineBinding = {
        code: binding.code,
        expiresAt: binding.expiresAt,
        bookingId: binding.bookingId,
        addFriendUrl: defaultOa?.addFriendUrl || null,
        oaMessageUrl: defaultOa?.oaMessageUrl || null,
      };
    } catch (err) {
      console.warn('[booking] LINE binding code issue skipped:', err.message);
      newBooking.lineBinding = {
        error: 'LINE_BINDING_CODE_FAILED',
        message: 'สร้างรหัสผูก LINE ไม่สำเร็จ เจ้าหน้าที่สามารถออกให้ใหม่ได้ภายหลัง',
        nextAction: 'แอดมินควรออก LINE binding code ให้ผู้จองใหม่จากหน้าแอดมิน หรือโทรแจ้งสถานะการจองโดยตรง',
      };
    }
    newBooking.lineContact = await loadPublicLineContactLinks().catch(() => ({ addFriendUrl: null, source: 'none' }));
    audit(req, 'booking.public_create', 'booking', newBooking.id,
      {
        phone: cleaned.phone, roomId: cleaned.roomId, wantType, wantFloor,
        depositRequired: bookingSettings.requireDeposit,
        bookingFee: newBooking.bookingFee,
        depositStatus: newBooking.depositStatus,
        depositVerifyCode: newBooking.depositVerifyCode,
        depositVerifyProvider: newBooking.depositVerifyProvider,
        depositTransactionRef: newBooking.depositTransactionRef,
        applicantRisk: applicantRisk ? applicantRisk.code : null,
        lineBindingError: newBooking.lineBinding && newBooking.lineBinding.error ? newBooking.lineBinding.error : null,
        // True when this booking DRAINED through after the admin had already
        // closed booking (valid in-flight hold completed). Lets the owner see
        // that a post-close booking was an intentional grace, not a leak.
        drainedWhileClosed: !bookingOpen,
      },
      `public:${cleaned.phone || 'anon'}`).catch(() => {});

    // Multi-channel owner notify (LINE → email fallback) + log to
    // notifications_log so admin sees it even when LINE is offline. B6.
    try {
      const flags = await features.load(pool);
      notifier.notifyOwner({ pool, features: flags }, {
        category: 'booking',
        subject: '📋 ผู้เช่าใหม่ขอจอง',
        text: `ชื่อ: ${cleaned.tenantName}\nโทร: ${cleaned.phone || '-'}\nห้อง: ${cleaned.roomId || '-'}\nวันเข้าพัก: ${cleaned.checkInDate || '-'}\nค่าจอง: ${newBooking.bookingFee ? `฿${Number(newBooking.bookingFee).toLocaleString('th-TH')}` : '-'} (${newBooking.depositStatus || 'not_required'})\nผลตรวจสลิป: ${newBooking.depositVerification?.title || newBooking.depositVerifyCode || '-'}\nนโยบาย: ${newBooking.bookingFeeAppliesToDeposit ? 'นำค่าจองไปหัก/นับรวมกับเงินมัดจำ' : 'ค่าจองแยกจากเงินมัดจำ'}\nมัดจำคงเหลือโดยประมาณ: ${newBooking.depositBalanceDue != null ? `฿${Number(newBooking.depositBalanceDue).toLocaleString('th-TH')}` : '-'}${newBooking.lineBinding?.error ? `\n⚠️ LINE: สร้างรหัสผูก LINE ไม่สำเร็จ (${newBooking.lineBinding.error})\nขั้นต่อไป: ${newBooking.lineBinding.nextAction}` : ''}${newBooking.applicantRisk ? `\n⚠️ ข้อควรตรวจ: ${newBooking.applicantRisk.message}\nขั้นต่อไป: ${newBooking.applicantRisk.nextAction}` : ''}\nรหัสการจอง: ${newBooking.id}\n— ขั้นต่อไป: เปิด /admin#bookings เพื่อตรวจสอบและกดอนุมัติการจองนี้`,
      }).catch(() => {});
    } catch { /* ignore */ }

    res.json({ ok: true, booking: newBooking });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    // Park (don't delete) any captured deposit slip on an unexpected failure —
    // money safety over file tidiness. No-op when no slip was uploaded.
    await handleLostDeposit('INTERNAL_ERROR', cleaned.roomId);
    console.error('public booking error:', err);
    res.status(500).json({ error: 'internal error' });
  } finally {
    client.release();
  }
});

// POST /api/notify/bill - legacy estimate reminder. Resolve the active
// tenant from roomId and send through tenant channels. Persisted bills
// should use POST /api/bills/:id/send instead.
app.post('/api/notify/bill', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager', 'staff'), async (req, res) => {
  const b = req.body || {};
  const notifyTotal = Number(b.total);
  if (!b.roomId || !Number.isFinite(notifyTotal) || notifyTotal <= 0) {
    return res.status(400).json({ error: 'roomId and positive total required', code: 'INVALID_BILL_NOTIFY' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, phone, email, line_user_id, line_oa_id, status
         FROM tenants
        WHERE current_room_id=$1 AND status='active' AND deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 1`,
      [String(b.roomId).slice(0, 32)]
    );
    if (!rows.length) {
      return res.status(404).json({
        error: 'no active tenant is linked to this room',
        code: 'TENANT_NOT_FOUND_FOR_BILL_NOTIFY',
      });
    }
    const tenant = rows[0];
    const text = [
      `New bill`,
      `Tenant: ${tenant.full_name || b.tenantName || '-'}`,
      `Room: ${b.roomId}`,
      b.period ? `Period: ${b.period}` : null,
      `Amount: THB ${notifyTotal.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      b.billNo ? `Bill no: ${b.billNo}` : null,
    ].filter(Boolean).join('\n');
    const flags = await features.load(pool);
    const out = await notifier.notifyTenant({ pool, features: flags }, tenant, {
      subject: 'New bill',
      text,
    });
    if (!out.ok) {
      return res.status(503).json({
        error: 'tenant has no reachable notification channel',
        code: 'NO_TENANT_CHANNEL',
        channel: out.channel,
      });
    }
    return res.json({ ok: true, channel: out.channel, tenantId: tenant.id });
  } catch (err) {
    console.error('notify/bill tenant error:', err.message);
    return res.status(500).json({ error: 'internal error' });
  }
});

// POST /api/tenants/notify moved to routes/tenant-ops.js so the entire
// /api/tenants surface lives in one router (round 9).

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

async function loadBillingConfig() {
  const { rows } = await pool.query(
    `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
  );
  return rows[0]?.value || {};
}

function buildEffectivePaymentBlock(config) {
  const block = billing.buildPaymentBlock(config || {});
  if (!block.promptpayTarget) {
    const envPp = require('./services/secrets').get('PROMPTPAY_TARGET');
    if (envPp) {
      block.promptpayTarget = envPp;
      if (!Array.isArray(block.paymentMethods)) block.paymentMethods = [];
      if (!block.paymentMethods.find((m) => m && m.key === 'promptpay')) {
        block.paymentMethods.unshift({ key: 'promptpay', label: 'PromptPay', enabled: true });
      }
    }
  }
  return block;
}

async function loadEffectivePaymentBlock() {
  const config = await loadBillingConfig();
  return { config, paymentBlock: buildEffectivePaymentBlock(config) };
}

function numOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Bills-table → usage shape adapter. Delegates to billing service so the
// snake_case → before/after detail logic is shared with routes/bills-extras
// instead of drifting between two near-identical implementations.
function storedUtilityUsage(b, prefix) {
  return billing.resolveUtilityUsageFromBillRow(b, prefix);
}

function parseBillOtherItems(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function lateFeePolicyFromFlags(flags) {
  const lateFee = flags && flags.lateFee && flags.lateFee.enabled ? flags.lateFee : {};
  return {
    ratePctPerMonth: Number(lateFee.ratePctPerMonth) || 0,
    gracePeriodDays: Number(lateFee.gracePeriodDays) || 0,
    minLateFeeBaht: Number(lateFee.minLateFeeBaht) || 0,
    maxPctOfPrincipal: Number(lateFee.maxPctOfPrincipal) || 0,
    maxLateFeeBaht: Number(lateFee.maxLateFeeBaht) || 0,
  };
}

function fmtMoneyTH(n) {
  return Number(n || 0).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtNumberTH(n) {
  const value = Number(n || 0);
  return Number.isInteger(value) ? String(value) : value.toLocaleString('th-TH', { maximumFractionDigits: 2 });
}

function buildLateFeeCalculation(b, policy = {}) {
  const lateFee = billing.round2(Number(b && b.late_fee) || 0);
  if (lateFee <= 0) return null;
  const total = Number(b && b.total) || 0;
  const principal = billing.round2(Math.max(0, total - lateFee));
  const ratePctPerMonth = Number(policy.ratePctPerMonth) || 0;
  const gracePeriodDays = Math.max(0, Number(policy.gracePeriodDays) || 0);
  const minLateFeeBaht = Math.max(0, Number(policy.minLateFeeBaht) || 0);
  const maxPctOfPrincipal = Math.max(0, Number(policy.maxPctOfPrincipal) || 0);
  const maxLateFeeBaht = Math.max(0, Number(policy.maxLateFeeBaht) || 0);
  const calc = billing.computeLateFee({
    base: principal,
    dueDate: b && b.due_date,
    ratePctPerMonth,
    gracePeriodDays,
    minLateFeeBaht,
    maxPctOfPrincipal,
    maxLateFeeBaht,
    maxBaht: maxLateFeeBaht,
  });
  const daysOver = Number(calc.daysOver) || 0;
  const monthsOver = Number(calc.monthsOver) || 0;
  let formulaText = `คำนวณจากยอดก่อนค่าปรับ ฿${fmtMoneyTH(principal)} = ค่าปรับ ฿${fmtMoneyTH(lateFee)}`;
  if (ratePctPerMonth > 0 && daysOver > 0) {
    const uncappedLateFee = Number(calc.uncappedLateFee) || lateFee;
    formulaText = `คำนวณจากยอดก่อนค่าปรับ ฿${fmtMoneyTH(principal)} × ${fmtNumberTH(ratePctPerMonth)}%/เดือน × ${fmtNumberTH(daysOver)} วัน ÷ 30 = ฿${fmtMoneyTH(uncappedLateFee)}`;
    if (gracePeriodDays > 0) formulaText += ` (หักระยะผ่อนผัน ${fmtNumberTH(gracePeriodDays)} วันแล้ว)`;
    if (calc.minApplied) {
      formulaText += `; ปรับตามขั้นต่ำ ฿${fmtMoneyTH(minLateFeeBaht)}`;
    }
    if (calc.capped) {
      const caps = [];
      if (maxPctOfPrincipal > 0) caps.push(`${fmtNumberTH(maxPctOfPrincipal)}% ของยอดก่อนค่าปรับ`);
      if (maxLateFeeBaht > 0) caps.push(`฿${fmtMoneyTH(maxLateFeeBaht)}`);
      formulaText += `; จำกัดตามเพดานค่าปรับ${caps.length ? ` (${caps.join(' / ')})` : ''} เหลือ ฿${fmtMoneyTH(lateFee)}`;
    }
  }
  return {
    amount: lateFee,
    principal,
    ratePctPerMonth,
    gracePeriodDays,
    minLateFeeBaht,
    maxPctOfPrincipal,
    maxLateFeeBaht,
    daysOver,
    monthsOver,
    capped: !!calc.capped,
    uncappedLateFee: Number(calc.uncappedLateFee) || lateFee,
    formulaText,
  };
}

function buildOnlineBillLineItems(b, policy = {}) {
  if (!b) return [];
  const items = [];
  const push = (item) => {
    if (!item) return;
    const amount = Number(item.amount);
    items.push({
      key: item.key || String(item.label || `item-${items.length}`),
      label: String(item.label || ''),
      qty: item.qty == null ? '' : String(item.qty),
      detail: item.detail == null ? '' : String(item.detail),
      amount: Number.isFinite(amount) ? amount : 0,
    });
  };

  push({
    key: 'rent',
    label: 'ค่าเช่าห้องพัก',
    qty: '1 เดือน',
    detail: b.period ? `รอบบิล ${b.period}` : '',
    amount: Number(b.rent) || 0,
  });
  push({
    key: 'water',
    ...billing.buildUtilityItem('ค่าน้ำ', storedUtilityUsage(b, 'water'), Number(b.water_rate) || 0, Number(b.water_amount) || 0),
  });
  push({
    key: 'elec',
    ...billing.buildUtilityItem('ค่าไฟฟ้า', storedUtilityUsage(b, 'elec'), Number(b.elec_rate) || 0, Number(b.elec_amount) || 0),
  });
  if (Number(b.wifi) > 0) {
    push({
      key: 'wifi',
      label: 'ค่าอินเทอร์เน็ต',
      qty: '1 เดือน',
      detail: '',
      amount: Number(b.wifi) || 0,
    });
  }
  for (const [idx, it] of parseBillOtherItems(b.other).entries()) {
    const amount = Number(it && it.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    push({
      key: `other-${idx}`,
      label: String((it && it.label) || 'อื่นๆ'),
      qty: '',
      detail: '',
      amount,
    });
  }
  if (Number(b.vat) > 0) {
    push({ key: 'vat', label: 'ภาษีมูลค่าเพิ่ม', qty: '', detail: '', amount: Number(b.vat) || 0 });
  }
  const lateFeeCalculation = buildLateFeeCalculation(b, policy);
  if (lateFeeCalculation) {
    push({
      key: 'late_fee',
      label: 'ค่าปรับชำระล่าช้า',
      qty: '',
      detail: lateFeeCalculation.formulaText,
      amount: lateFeeCalculation.amount,
    });
  }
  return items;
}

// The tenant-side bill PDF endpoint (further down in this file) inlines
// its own bill-object assembly because it needs to resolve config +
// payment block on the same code path — the admin /api/bills/render
// version lives in routes/bills-extras.js with the rest of /api/bills.

// Note: the generic GET /api/promptpay/qr?target=&amount= endpoint was
// removed. It accepted a query-string target+amount and would render a QR
// for ANY account — useful only as an admin convenience but no UI in this
// build called it (tenant uses /api/tenant/bills/:id/qr which loads amount
// from the DB row; PDFs render inline via services/pdf.js). The generic
// endpoint was a small but real attack surface (anyone within rate-limit
// headroom could synthesise QR images for arbitrary PromptPay accounts).
// If a future admin tool needs preview rendering, prefer an owner-only
// /api/admin/promptpay/qr that takes its target from server config rather
// than from the caller's query string.

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
    // Residency-checked tenant linkage: stamp tenant_id ONLY when the
    // submitter's phone matches an ACTIVE tenant who currently lives
    // in THIS room. Without the room match, a logged-in tenant A could
    // file a ticket with `{roomId: B, tenantPhone: B's phone}` and the
    // system would attribute it to B (and B's portal would show the
    // rating prompt). The non-matching submissions are still inserted
    // — anonymous tickets are legitimate (a friend reporting on the
    // tenant's behalf, walk-in repair request) — but tenant_id stays
    // NULL so they don't grant any tenant ownership.
    let tenantId = null;
    if (cleaned.tenant_phone) {
      const tr = await pool.query(
        `SELECT id FROM tenants
           WHERE phone=$1 AND deleted_at IS NULL
             AND status='active'
             AND current_room_id=$2
           ORDER BY id DESC LIMIT 1`,
        [cleaned.tenant_phone, cleaned.room_id]
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
        category: 'maintenance',
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
    // Refuse to walk a ticket back from a terminal status. Once a ticket
    // is rated/completed and the tenant has been notified, flipping it
    // back to 'open' or 'in_progress' would orphan the completed_at
    // timestamp + send confusing duplicate notifications. Admins who
    // genuinely need to revive a closed ticket should create a new one.
    // 'cancelled' is also treated as terminal so accidental click can't
    // resurrect a cancelled ticket without explicit DB intervention.
    const TERMINAL_TICKET_STATUSES = new Set(['completed', 'cancelled']);
    const newStatus = String(b.status);
    if (TERMINAL_TICKET_STATUSES.has(newStatus) || newStatus !== b.status) {
      // Look up current status to decide whether the requested transition
      // is allowed. Tiny extra round-trip but avoids racing 2 admins on
      // the same ticket — the actual UPDATE is row-locked below.
      const current = await pool.query(
        `SELECT status FROM maintenance_tickets WHERE id=$1`,
        [id]
      );
      if (current.rows.length && TERMINAL_TICKET_STATUSES.has(current.rows[0].status)
          && current.rows[0].status !== newStatus) {
        return res.status(409).json({
          error: `ticket ปิดไปแล้ว (สถานะ ${current.rows[0].status}) — ออก ticket ใหม่แทนการเปลี่ยนสถานะ`,
          code: 'TICKET_TERMINAL',
          currentStatus: current.rows[0].status,
        });
      }
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
    //
    // IDOR fix: scope this anonymous, phone-only path to `tenant_id IS NULL`.
    // A ticket that was submitted by an identified tenant carries a tenant_id;
    // matching it by phone alone let anyone who knows that (semi-public) phone
    // number rate/comment on the victim's completed ticket by enumerating ids.
    // Identified tenants must rate through the session-authenticated portal
    // endpoint (which binds on tenant_id). Orphan/legacy tickets have no
    // stronger identity than the phone that submitted them, so phone-match is
    // the correct authorization there.
    const { rows } = await pool.query(
      `UPDATE maintenance_tickets
         SET rating = $1, rating_comment = $2, updated_at = NOW()
         WHERE id = $3 AND tenant_phone = $4 AND $4 <> ''
           AND tenant_id IS NULL
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

// /api/reports/* lives in routes/reports.js (mounted at /api/reports).

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

app.get('/api/admin/features', requireAuth, requireRole('owner', 'manager', 'staff'), async (req, res) => {
  try {
    const f = await features.load(pool);
    // Never echo a secret. SMTP_PASS is env-only and not in DB anyway.
    const role = req.session.user.role;
    // Current cross-feature consistency warnings so the Features page can show
    // them on load (not only after a toggle). Non-fatal if the check throws.
    let warnings = [];
    try {
      const dep = await require('./services/healthCheck').checkFeatureDependencies(f, pool);
      warnings = (dep && dep.detail && dep.detail.warnings) || [];
    } catch { /* surface no warnings rather than failing the page */ }
    res.json({
      ok: true,
      features: f,
      defaults: features.DEFAULTS,
      role,
      canEdit: role === 'owner',
      warnings,
    });
  } catch (err) {
    console.error('features admin GET error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/admin/booking-deposit-settings', requireAuth, requireRole('owner', 'manager', 'staff'), async (req, res) => {
  try {
    const f = await features.load(pool);
    const role = req.session.user.role;
    const effectiveSettings = roomBookingSettings(f);
    const openState = roomBookingOpenState(effectiveSettings);
    const payment = await bookingDepositAdminPaymentReadiness(effectiveSettings.depositAmount);
    res.json({
      ok: true,
      settings: normalizeRoomBookingEditableSettings(f.roomBooking),
      effectiveSettings: { ...effectiveSettings, openState },
      defaults: normalizeRoomBookingEditableSettings(features.DEFAULTS.roomBooking),
      payment,
      role,
      canEdit: ['owner', 'manager'].includes(role),
    });
  } catch (err) {
    console.error('booking deposit settings GET error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.put('/api/admin/booking-deposit-settings',
  sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
  async (req, res) => {
    try {
      const current = await features.load(pool);
      const input = req.body && req.body.roomBooking ? req.body.roomBooking : req.body;
      const parsed = parseRoomBookingEditableSettings(input, current.roomBooking);
      if (!parsed.ok) {
        return res.status(400).json({
          error: 'ตั้งค่าจอง/มัดจำไม่ถูกต้อง',
          code: 'BOOKING_DEPOSIT_SETTINGS_INVALID',
          issues: parsed.issues,
        });
      }
      const next = await features.save(
        pool,
        { roomBooking: parsed.settings },
        req.session.user.username
      );
      audit(req, 'booking_deposit_settings.update', 'config', 'roomBooking', {
        keys: Object.keys(input || {}),
        enabled: parsed.settings.enabled,
        openAt: parsed.settings.openAt || null,
        requireDeposit: parsed.settings.requireDeposit,
        depositAmount: parsed.settings.depositAmount,
        minimumAmount: parsed.settings.minimumAmount,
        holdMinutes: parsed.settings.holdMinutes,
      });
      const effectiveSettings = roomBookingSettings(next);
      const openState = roomBookingOpenState(effectiveSettings);
      const payment = await bookingDepositAdminPaymentReadiness(effectiveSettings.depositAmount);
      res.json({
        ok: true,
        settings: normalizeRoomBookingEditableSettings(next.roomBooking),
        effectiveSettings: { ...effectiveSettings, openState },
        payment,
        role: req.session.user.role,
        canEdit: true,
      });
    } catch (err) {
      console.error('booking deposit settings PUT error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  }
);

app.put('/api/admin/features', sameOrigin, csrfGuard, requireAuth, requireRole('owner'), async (req, res) => {
  const partial = req.body && req.body.features ? req.body.features : req.body;
  if (!partial || typeof partial !== 'object') {
    return res.status(400).json({ error: 'features object required' });
  }
  // Defense-in-depth: reject prototype-polluting keys anywhere in the payload
  // before it reaches the recursive deepMerge in features.save(). The merge is
  // already pollution-resistant (it builds fresh objects), but refusing these
  // keys outright removes the foot-gun entirely and keeps the flag config clean.
  const hasDangerousKey = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 6) return false;
    for (const k of Object.keys(o)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') return true;
      if (hasDangerousKey(o[k], depth + 1)) return true;
    }
    return false;
  };
  if (hasDangerousKey(partial)) {
    return res.status(400).json({ error: 'invalid feature key', code: 'BAD_KEY' });
  }
  // MQTT is not wired in this build. Refuse it at save-time instead of
  // advertising a mode that silently receives no readings.
  if (partial.meterIot && partial.meterIot.mode === 'mqtt') {
    audit(req, 'features.mqtt_blocked', 'config', 'features',
      { attemptedBy: req.session.user.username });
    return res.status(400).json({
      error: 'meterIot.mode=mqtt ยังไม่รองรับในระบบนี้ — ใช้ manual จนกว่าจะติดตั้ง MQTT integration',
      code: 'METER_MQTT_UNAVAILABLE',
      hint: 'ตั้ง mode = "manual"',
    });
  }
  // Production safety: refuse to set the meter simulator mode in production.
  // The simulator generates fake hourly readings — running it on a live
  // building would silently overwrite real meter data with random walks and
  // poison every bill computed from `rooms.elecUnits`/`waterUnits`. Demo /
  // staging deploys can still flip it, but production must stay 'manual' or
  // another implemented mode. The check honors NODE_ENV explicitly so a developer running
  // dev locally with NODE_ENV unset can still toggle the simulator.
  if (NODE_ENV === 'production' && partial.meterIot && partial.meterIot.mode === 'simulator') {
    audit(req, 'features.simulator_blocked', 'config', 'features',
      { attemptedBy: req.session.user.username });
    return res.status(403).json({
      error: 'ห้ามเปิด meter simulator ใน production — จะสร้างค่าเทียมทับข้อมูลมิเตอร์จริง',
      code: 'PRODUCTION_SIMULATOR_BLOCKED',
      hint: 'ตั้ง mode = "manual" แทน',
    });
  }
  // Reject clearly-invalid numeric/enum config BEFORE persisting, so a typo
  // (VAT 700%, a 0-day session, a negative deposit, an out-of-range backup
  // hour) can't quietly break a feature or open a resource hole.
  const cfgErrors = features.validateConfig(partial);
  if (cfgErrors.length) {
    return res.status(400).json({
      error: 'ค่าตั้งฟีเจอร์ไม่ถูกต้อง: ' + cfgErrors.map((e) => e.message).join('; '),
      code: 'INVALID_FEATURE_CONFIG',
      errors: cfgErrors,
    });
  }
  // Prevent disabling citizenIdEncryption when encrypted data already exists —
  // turning it off would revert to plaintext storage but the existing encrypted
  // rows can't be decrypted at display time (encryptString would be called on
  // the ciphertext again), silently corrupting the citizen ID display.
  if (partial.citizenIdEncryption && partial.citizenIdEncryption.enabled === false) {
    try {
      const check = await pool.query(
        // "Encrypted" == NOT an exact 13-digit plaintext Thai ID. The old
        // `NOT LIKE '1%'` heuristic was wrong both ways: real plaintext IDs
        // start with 1-8 (not only '1'), and base64 ciphertext can start with
        // '1' (~1/64 of rows). Match the display-time discriminator instead so
        // the guard neither false-blocks plaintext nor leaks ciphertext rows.
        `SELECT 1 FROM tenants WHERE citizen_id_encrypted IS NOT NULL
           AND citizen_id_encrypted !~ '^[0-9]{13}$'  -- ciphertext = not a bare 13-digit ID
           AND deleted_at IS NULL LIMIT 1`
      );
      if (check.rows.length) {
        return res.status(409).json({
          error: 'ไม่สามารถปิด citizenIdEncryption ได้ เนื่องจากมีข้อมูลบัตรประชาชนที่เข้ารหัสแล้วในระบบ — ปิดจะทำให้ข้อมูลแสดงผลผิดพลาด',
          code: 'ENCRYPTION_DATA_EXISTS',
          hint: 'ถ้าต้องการปิดจริงๆ ต้อง decrypt ข้อมูลทั้งหมดก่อน หรือล้างข้อมูลผู้เช่าที่เกี่ยวข้อง',
        });
      }
    } catch (e) { console.warn('[features] encryption guard check skipped:', e.message); }
  }
  try {
    const next = await features.save(pool, partial, req.session.user.username);
    audit(req, 'features.update', 'config', 'features', { keys: Object.keys(partial) });
    // Surface cross-feature consistency warnings at the MOMENT of the toggle —
    // an admin who turns on slipUpload without tenantPortal (or sets VAT on with
    // a 0% rate, etc.) sees it immediately instead of discovering the silent
    // failure days later. Non-blocking: the save already succeeded.
    let warnings = [];
    try {
      const dep = await require('./services/healthCheck').checkFeatureDependencies(next, pool);
      warnings = (dep && dep.detail && dep.detail.warnings) || [];
    } catch (e) { console.warn('[features] consistency check skipped:', e.message); }
    res.json({ ok: true, features: next, warnings });
  } catch (err) {
    console.error('features admin PUT error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// === /api/tenants endpoints moved to routes/tenant-ops.js ================
// VALID_TENANT_STATUS + maskTenantOut helpers travelled with them — they
// were only used by tenant endpoints. See routes/tenant-ops.js for the
// list/read/lookup/history/create/update/delete implementations.

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

function tenantCanUsePortal(t) {
  return !!(
    t
    && t.status === 'active'
    && String(t.current_room_id || '').trim() !== ''
  );
}

async function tenantSessionLookup(req) {
  const flags = await features.load(pool);
  req.features = req.features || flags;
  if (!flags.tenantPortal || !flags.tenantPortal.enabled) {
    req.tenantPortalDisabled = true;
    return null;
  }
  req.tenantPortalDisabled = false;
  const sid = req.headers.cookie ? (req.headers.cookie.match(/(?:^|;\s*)tenant_sid=([^;]+)/) || [])[1] : null;
  if (!sid) return null;
  const sidHash = hashSid(sid);
  const { rows } = await pool.query(
    `SELECT s.tenant_id, s.expire, s.sid_hash, t.full_name, t.phone, t.email, t.line_user_id,
            t.line_oa_id, t.current_room_id, t.status, t.locale
       FROM tenant_sessions s JOIN tenants t ON t.id = s.tenant_id
       WHERE s.sid_hash = $1 AND s.expire > NOW() AND t.deleted_at IS NULL`,
    [sidHash]
  );
  if (!rows.length) return null;
  const session = rows[0];
  if (!tenantCanUsePortal(session)) {
    await pool.query(`DELETE FROM tenant_sessions WHERE sid_hash=$1`, [sidHash]).catch(() => {});
    return null;
  }
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
    if (!t) {
      if (req.tenantPortalDisabled) {
        return res.status(503).json(features.disabledPayload('tenantPortal', req));
      }
      return res.status(401).json({
        error: 'unauthorized',
        code: 'TENANT_SESSION_REQUIRED',
        hint: 'Log in again from /tenant.',
        requestId: req.id,
      });
    }
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

app.post('/api/tenant/login', sameOrigin, rateLimitTenantLogin, lookupJitter, features.requireFeature('tenantPortal'),
  // Wire the tenantLogin schema so phoneStr's dash/space normalisation runs
  // before the DB lookup. Without this a tenant typing "081-234-5678" got
  // an exact-match miss against admin-stored "0812345678" and login failed
  // with no useful feedback. The lockout key derives from the normalised
  // phone too, so an attacker can't dodge per-account rate limiting by
  // alternating between formatted/unformatted phone numbers.
  validateBody(schemas.tenantLogin),
  async (req, res) => {
  const phone = req.body.phone;
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
      `SELECT id, full_name, status, current_room_id
         FROM tenants
        WHERE phone=$1
          AND deleted_at IS NULL
          AND status='active'
          AND current_room_id IS NOT NULL
          AND current_room_id <> ''
        ORDER BY updated_at DESC NULLS LAST, id DESC
        LIMIT 2`,
      [phone]
    );
    if (!rows.length) {
      // Authoritative await + gate (see admin login) so the phone-only portal's
      // main brute-force defence can't be bypassed by concurrent attempts.
      const lockedUntil = await lockout.recordFailure(principal, 'tenant').catch(() => null);
      audit(req, 'tenant.login_failed', 'tenant', phone, { reason: 'no_active_current_tenant' }, phone).catch(() => {});
      if (lockedUntil && new Date(lockedUntil).getTime() > Date.now()) {
        const minutes = Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 60_000);
        return res.status(429).json({
          error: `บัญชีถูกล็อกชั่วคราว — ลองใหม่ใน ${minutes} นาที`,
          code: 'LOCKED_OUT',
        });
      }
      return res.status(401).json({ error: 'invalid credentials' });
    }
    if (rows.length > 1) {
      lockout.recordFailure(principal, 'tenant').catch(() => {});
      audit(req, 'tenant.login_blocked_ambiguous_phone', 'tenant', phone,
        { tenantIds: rows.map((r) => r.id), roomIds: rows.map((r) => r.current_room_id) }, phone).catch(() => {});
      return res.status(409).json({
        error: 'phone is linked to multiple active rooms',
        code: 'PHONE_LINKED_TO_MULTIPLE_ACTIVE_ROOMS',
      });
    }
    const matched = rows[0];
    if (!tenantCanUsePortal(matched)) {
      audit(req, 'tenant.login_blocked_inactive', 'tenant', String(matched.id),
        { status: matched.status, currentRoomId: matched.current_room_id }, phone).catch(() => {});
      return res.status(403).json({
        error: 'tenant is not active for portal access',
        code: 'TENANT_NOT_ACTIVE',
      });
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
      [sidHash, sidHash, matched.id, expire, clientIp(req), (req.headers['user-agent'] || '').slice(0, 400)]
    );
    res.cookie(TENANT_COOKIE, sid, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: expire,
    });
    audit(req, 'tenant.login', 'tenant', String(matched.id));
    res.json({ ok: true, tenant: { id: matched.id, fullName: matched.full_name } });
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
    if (!t) {
      if (req.tenantPortalDisabled) {
        return res.status(503).json({
          tenant: null,
          ...features.disabledPayload('tenantPortal', req),
        });
      }
      return res.json({ tenant: null });
    }
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
    const { config: cfg, paymentBlock: block } = await loadEffectivePaymentBlock();
    res.json({ ok: true, payment: block, building: cfg.building || null });
  } catch (err) {
    console.error('tenant payment-info error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/tenant/pay-readiness/:billId — tenant-side preflight that returns
// what payment channels actually work for THIS bill, plus a structured list
// of issues with sev/code/msg/fix so the BillDetail screen can show the
// tenant a clear "ทำไมจ่าย QR ไม่ได้" message before they tap the button.
// Channels: qr (PromptPay QR renderable), bank/wallet (manual receiver
// details present), slip (slipUpload enabled), autoVerify (provider configured
// with at least one validated receiver target). Issues are HINTS, not hard blocks —
// admin may accept payments through channels we can't auto-detect here.
app.get('/api/tenant/pay-readiness/:billId', requireTenant, async (req, res) => {
  const id = Number(req.params.billId);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'invalid id' });
  }
  try {
    const billQ = await pool.query(
      `SELECT id, total, status, tenant_id, due_date
         FROM bills WHERE id=$1 AND deleted_at IS NULL`,
      [id]
    );
    if (!billQ.rows.length) return res.status(404).json({ error: 'bill not found' });
    const bill = billQ.rows[0];
    // Orphan bill (tenant_id IS NULL — legacy bills created before tenant
    // auto-linking, or admin forgot to attach a tenant). Surface a clear
    // BILL_NOT_LINKED so the tenant sees the real reason ("ติดต่อสำนักงาน
    // ให้ผูกบิล") instead of the misleading "not your bill". Matches the
    // upload endpoint /api/tenant/payments behaviour (line 4048) so the
    // preflight stays consistent with the action endpoint.
    if (!bill.tenant_id) {
      return res.status(403).json({
        error: 'บิลนี้ยังไม่ได้ผูกกับผู้เช่า — กรุณาติดต่อเจ้าหน้าที่',
        code: 'BILL_NOT_LINKED',
      });
    }
    if (Number(bill.tenant_id) !== Number(req.tenant.tenant_id)) {
      return res.status(403).json({ error: 'not your bill' });
    }

    const flags = await features.load(pool);
    const { paymentBlock } = await loadEffectivePaymentBlock();
    const promptpay = require('./services/promptpay');
    const slipVerifier = require('./services/slipVerifier');
    const issues = [];
    const channels = { qr: false, slip: false, autoVerify: false, bank: false, wallet: false };
    let autoVerifyReceiverReady = false;

    if (bill.status === 'paid') {
      issues.push({
        sev: 'info', code: 'BILL_ALREADY_PAID',
        msg: 'บิลนี้ชำระเรียบร้อยแล้ว — ไม่ต้องส่งสลิปอีก',
        fix: null,
      });
    } else if (bill.status !== 'pending' && bill.status !== 'overdue') {
      issues.push({
        sev: 'high', code: 'BILL_NOT_PAYABLE',
        msg: `บิลสถานะ "${bill.status}" — ไม่สามารถชำระได้`,
        fix: 'ติดต่อสำนักงานเพื่อสอบถามรายละเอียด',
      });
    }

    const billTotal = Number(bill.total);
    const isBillPayable = bill.status === 'pending' || bill.status === 'overdue';
    channels.bank = isBillPayable && !!(paymentBlock.bankInfo && paymentBlock.bankInfo.account);
    channels.wallet = isBillPayable && !!(paymentBlock.walletInfo && paymentBlock.walletInfo.phone);
    if (!Number.isFinite(billTotal) || billTotal <= 0) {
      issues.push({
        sev: 'high', code: 'INVALID_BILL_TOTAL',
        msg: 'ยอดบิลไม่ถูกต้อง — ติดต่อสำนักงาน',
        fix: null,
      });
    } else if (billTotal > MAX_AMOUNT) {
      issues.push({
        sev: 'high', code: 'AMOUNT_EXCEEDS_PROMPTPAY',
        msg: `ยอด ฿${billTotal.toLocaleString('th-TH')} เกิน PromptPay limit (฿${MAX_AMOUNT.toLocaleString('th-TH')}) — จ่าย QR ไม่ได้`,
        fix: 'โอนผ่าน mobile banking แทน หรือแบ่งชำระ',
      });
    }

    const manualPaymentAvailable = channels.bank || channels.wallet;
    if (!paymentBlock.promptpayTarget) {
      if (isBillPayable) {
        issues.push({
          sev: manualPaymentAvailable ? 'med' : 'high', code: 'PROMPTPAY_NOT_CONFIGURED',
          msg: manualPaymentAvailable
            ? 'หอพักยังไม่ตั้งค่า PromptPay — สแกน QR ไม่ได้ แต่ยังชำระผ่านบัญชี/Wallet ที่แสดงในบิลได้'
            : 'หอพักยังไม่ตั้งค่า PromptPay และยังไม่มีช่องทางโอนอื่น — กรุณาติดต่อสำนักงาน',
          fix: manualPaymentAvailable ? 'โอนตามช่องทางที่แสดง แล้วแนบสลิปในระบบ' : 'ติดต่อสำนักงาน',
        });
      }
    } else {
      try {
        promptpay.normaliseTarget(paymentBlock.promptpayTarget);
        if (promptpay.isDemoTarget(paymentBlock.promptpayTarget)) {
          issues.push({
            sev: 'high', code: 'PROMPTPAY_DEMO',
            msg: 'หอพักยังใช้ PromptPay demo — สแกนแล้วเงินจะไม่ถึงเจ้าของหอ',
            fix: 'แจ้งสำนักงานให้ตั้งบัญชีจริงก่อน',
          });
        } else {
          autoVerifyReceiverReady = true;
          if (Number.isFinite(billTotal) && billTotal > 0 && billTotal <= MAX_AMOUNT && isBillPayable) {
            channels.qr = true;
          }
        }
      } catch {
        issues.push({
          sev: 'high', code: 'PROMPTPAY_INVALID_CONFIG',
          msg: 'รูปแบบ PromptPay ของหอพักไม่ถูกต้อง — สแกน QR ไม่ได้',
          fix: 'แจ้งสำนักงานให้แก้ที่ Settings → การชำระเงิน',
        });
      }
    }
    if (!autoVerifyReceiverReady && paymentBlockReceiverTargets(paymentBlock).length > 0) {
      autoVerifyReceiverReady = true;
    }

    let uploadAttempts = null;
    if (!flags?.slipUpload?.enabled) {
      issues.push({
        sev: 'med', code: 'SLIP_UPLOAD_DISABLED',
        msg: 'หอพักปิดการรับสลิปออนไลน์ — กรุณานำสลิปไปยื่นที่สำนักงาน',
        fix: null,
      });
    } else if (isBillPayable && Number.isFinite(billTotal) && billTotal > 0) {
      uploadAttempts = await loadBillPaymentAttemptSummary(pool, id, req.tenant.tenant_id);
      const slipBlock = publicSlipBlockReason({
        flags,
        payable: true,
        paid: false,
        attempts: uploadAttempts,
      });
      if (slipBlock) {
        const issue = slipBlockReadinessIssue(slipBlock);
        if (issue) issues.push(issue);
      } else {
        channels.slip = true;
        const ready = slipVerifier.getConfiguredProviders(flags);
        if (flags.slipUpload.autoVerify && ready.length > 0 && autoVerifyReceiverReady) {
          channels.autoVerify = true;
        } else if (flags.slipUpload.autoVerify && ready.length === 0) {
          issues.push({
            sev: 'low', code: 'AUTOVERIFY_NOT_READY',
            msg: 'การยืนยันสลิปอัตโนมัติยังไม่พร้อม — สลิปจะเข้าคิวรอเจ้าหน้าที่ตรวจสอบ (ปกติ < 24 ชม.)',
            fix: null,
          });
        }
      }
    }

    try {
      const { rows: trows } = await pool.query(
        `SELECT line_user_id, email FROM tenants WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,
        [req.tenant.tenant_id]
      );
      const t = trows[0] || {};
      if (!lineNotify.isLikelyUserId(t.line_user_id) && !t.email) {
        issues.push({
          sev: 'low', code: 'NO_NOTIFY_CHANNEL',
          msg: 'คุณยังไม่ได้ผูก LINE หรือใส่อีเมล — จะไม่ได้รับแจ้งเตือนเมื่อสลิปถูกตรวจสอบ',
          fix: 'ไปที่ "บัญชีของฉัน" เพื่อผูก LINE หรือใส่อีเมล',
        });
      }
    } catch { /* non-blocking */ }

    const qrVersion = channels.qr === true
      ? `${bill.id}-${String(bill.status || 'pending')}-${Date.now()}`
      : null;
    const qrUrl = qrVersion
      ? `/api/tenant/bills/${encodeURIComponent(bill.id)}/qr?v=${encodeURIComponent(qrVersion)}`
      : null;

    res.json({
      ok: true,
      paid: bill.status === 'paid',
      payable: isBillPayable,
      qrVersion,
      qrUrl,
      channels,
      issues,
      bill: {
        id: bill.id,
        total: billTotal,
        status: bill.status,
        dueDate: bill.due_date,
      },
      upload: uploadAttempts ? {
        ...uploadAttempts,
        canUpload: channels.slip === true,
        blocked: channels.slip === true ? null : publicSlipBlockReason({
          flags,
          payable: isBillPayable,
          paid: bill.status === 'paid',
          attempts: uploadAttempts,
        }),
      } : null,
      promptpayTarget: paymentBlock.promptpayTarget ? 'configured' : null,
    });
  } catch (err) {
    console.error('tenant pay-readiness error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/admin/billing-readiness — owner/manager preflight that the
// admin UI calls before "ออกบิล" / "บันทึกรับชำระ" so the operator sees
// structured issues with fix links (same pattern as handleGenerate's
// existing confirm-modal) instead of getting a generic 500 mid-action.
// Each issue: { sev: 'high'|'med'|'low'|'info', code, area: string[], msg, fix }
// `summary.canIssueBills` / `canRecordPayments` flip to false when a high-
// severity issue blocks that flow.

// === LINE owner-claim flow ================================================
// Generate a OWNER-XXXXXXXX code that the admin sends from THEIR OWN LINE
// account to the OA. Webhook matches the code → saves source.userId into
// line_oas.owner_user_id (or secrets.LINE_OWNER_USER_ID for env-fallback
// deployments without a registered OA row). Replaces the manual paste
// flow that confused operators.
app.post('/api/admin/line/owner-claim',
  sameOrigin, csrfGuard, requireAuth, requireRole('owner'),
  async (req, res) => {
    const oaId = req.body?.oaId ? Number(req.body.oaId) : null;
    try {
      const ownerClaim = require('./services/ownerClaim');
      const token = await ownerClaim.createToken(pool, {
        oaId, createdBy: req.session.user.username,
      });
      audit(req, 'line.owner_claim.create', 'owner_claim_token', String(token.id),
        { oaId, code: token.code });
      res.json({ ok: true, ...token });
    } catch (err) {
      console.error('owner-claim create error:', err);
      res.status(500).json({ error: err.message || 'internal error' });
    }
  });

app.get('/api/admin/line/owner-claim/:id',
  requireAuth, requireRole('owner'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    try {
      const ownerClaim = require('./services/ownerClaim');
      const t = await ownerClaim.getToken(pool, id);
      if (!t) return res.status(404).json({ error: 'not found' });
      // Mask the userId tail so the admin browser doesn't display the
      // raw value in full — confirm via the success status instead.
      const claimedTail = t.claimed_user_id
        ? '...' + String(t.claimed_user_id).slice(-6)
        : null;
      res.json({
        ok: true,
        id: t.id, code: t.code, oaId: t.oa_id, status: t.status,
        claimedTail, claimedAt: t.claimed_at, expiresAt: t.expires_at,
      });
    } catch (err) {
      console.error('owner-claim get error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

// === Multi-admin notification recipients ===================================
// Unlimited staff LINE accounts that receive every system alert alongside
// the single legacy owner contact. Owner-gated end to end: who hears about
// money/bookings is an owner decision. Flow mirrors owner-claim (ADMIN-
// namespace, single-use codes typed into the OA chat), management adds
// enable/disable (mute), relabel, and terminal revoke.
app.get('/api/admin/line/admin-recipients',
  requireAuth, requireRole('owner'),
  async (req, res) => {
    try {
      const adminRecipients = require('./services/adminRecipients');
      const items = await adminRecipients.listRecipients(pool, {
        includeRevoked: req.query.includeRevoked === '1',
      });
      // Catalog rides along so the UI renders chips from the same whitelist
      // the server validates against — no second hardcoded list to drift.
      res.json({ ok: true, items, categories: adminRecipients.CATEGORIES });
    } catch (err) {
      if (err.code === '42P01') {
        const adminRecipients = require('./services/adminRecipients');
        return res.json({ ok: true, items: [], categories: adminRecipients.CATEGORIES });
      }
      console.error('admin-recipients list error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

app.post('/api/admin/line/admin-recipients/tokens',
  sameOrigin, csrfGuard, requireAuth, requireRole('owner'),
  async (req, res) => {
    const oaId = req.body?.oaId ? Number(req.body.oaId) : null;
    const label = req.body?.label ? String(req.body.label).slice(0, 120) : null;
    try {
      const adminRecipients = require('./services/adminRecipients');
      const token = await adminRecipients.createToken(pool, {
        oaId, label, createdBy: req.session.user.username,
      });
      audit(req, 'line.admin_recipient.token_create', 'admin_recipient_token',
        String(token.id), { oaId, label, code: token.code });
      res.json({ ok: true, ...token });
    } catch (err) {
      console.error('admin-recipient token create error:', err);
      res.status(500).json({ error: err.message || 'internal error' });
    }
  });

app.get('/api/admin/line/admin-recipients/tokens/:id',
  requireAuth, requireRole('owner'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    try {
      const adminRecipients = require('./services/adminRecipients');
      const t = await adminRecipients.getToken(pool, id);
      if (!t) return res.status(404).json({ error: 'not found' });
      res.json({
        ok: true,
        id: t.id, code: t.code, oaId: t.oa_id, label: t.label, status: t.status,
        claimedTail: t.claimed_user_id ? '...' + String(t.claimed_user_id).slice(-6) : null,
        recipientId: t.recipient_id || null,
        claimedAt: t.claimed_at, expiresAt: t.expires_at,
      });
    } catch (err) {
      console.error('admin-recipient token get error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

app.put('/api/admin/line/admin-recipients/:id',
  sameOrigin, csrfGuard, requireAuth, requireRole('owner'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    try {
      const adminRecipients = require('./services/adminRecipients');
      const out = {};
      if (typeof req.body?.enabled === 'boolean') {
        const r = await adminRecipients.setEnabled(pool, id, req.body.enabled, req.session.user.username);
        if (!r) return res.status(404).json({ error: 'recipient not found or revoked', code: 'NOT_FOUND' });
        out.enabled = r.enabled;
        audit(req, req.body.enabled ? 'line.admin_recipient.enable' : 'line.admin_recipient.disable',
          'admin_line_recipient', String(id), {});
      }
      if (req.body?.label !== undefined) {
        const r = await adminRecipients.setLabel(pool, id, req.body.label);
        if (!r) return res.status(404).json({ error: 'recipient not found or revoked', code: 'NOT_FOUND' });
        out.label = r.label;
        audit(req, 'line.admin_recipient.relabel', 'admin_line_recipient', String(id),
          { label: r.label });
      }
      if (req.body?.mutedCategories !== undefined) {
        // Whitelist BEFORE touching the DB so the admin sees exactly which
        // keys were rejected (typo'd client, stale UI after a catalog change).
        const check = adminRecipients.validateMutedCategories(req.body.mutedCategories);
        if (!check.ok) {
          return res.status(400).json({
            error: `หมวดแจ้งเตือนไม่ถูกต้อง: ${check.invalid.join(', ')}`,
            code: 'INVALID_CATEGORIES',
            invalid: check.invalid,
            allowed: adminRecipients.CATEGORIES.map((c) => c.key),
          });
        }
        const r = await adminRecipients.setMutedCategories(pool, id, check.list);
        if (!r) return res.status(404).json({ error: 'recipient not found or revoked', code: 'NOT_FOUND' });
        out.mutedCategories = r.mutedCategories;
        audit(req, 'line.admin_recipient.categories', 'admin_line_recipient', String(id),
          { mutedCategories: r.mutedCategories });
      }
      if (!Object.keys(out).length) {
        return res.status(400).json({ error: 'nothing to update (enabled / label / mutedCategories)' });
      }
      res.json({ ok: true, id, ...out });
    } catch (err) {
      console.error('admin-recipient update error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

app.delete('/api/admin/line/admin-recipients/:id',
  sameOrigin, csrfGuard, requireAuth, requireRole('owner'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    try {
      const adminRecipients = require('./services/adminRecipients');
      const ok = await adminRecipients.revoke(pool, id, req.session.user.username);
      if (!ok) return res.status(404).json({ error: 'recipient not found or already revoked', code: 'NOT_FOUND' });
      audit(req, 'line.admin_recipient.revoke', 'admin_line_recipient', String(id), {});
      res.json({ ok: true, id, revoked: true });
    } catch (err) {
      console.error('admin-recipient revoke error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

app.get('/api/admin/billing-readiness',
  requireAuth, requireRole('owner', 'manager'),
  async (req, res) => {
    try {
      const flags = await features.load(pool);
      const { config: cfg, paymentBlock } = await loadEffectivePaymentBlock();
      const promptpay = require('./services/promptpay');
      const slipVerifier = require('./services/slipVerifier');
      const secretsSvc = require('./services/secrets');
      const issues = [];
      const now = new Date();
      let readinessPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      if (req.query.period) {
        try {
          readinessPeriod = meter.normalisePeriod(req.query.period);
        } catch {
          return res.status(400).json({
            error: 'period must be YYYY-MM',
            code: 'INVALID_PERIOD',
          });
        }
      }

      const hasManualPaymentChannel = !!(
        (paymentBlock.bankInfo && paymentBlock.bankInfo.account)
        || (paymentBlock.walletInfo && paymentBlock.walletInfo.phone)
      );
      if (!paymentBlock.promptpayTarget) {
        issues.push({
          sev: hasManualPaymentChannel ? 'med' : 'high', code: 'NO_PROMPTPAY', area: ['issue', 'payment'],
          msg: hasManualPaymentChannel
            ? 'ยังไม่ได้ตั้ง PromptPay — บิล PDF จะไม่มี QR แต่ยังมีช่องทางโอน manual ให้ผู้เช่าใช้'
            : 'ยังไม่ได้ตั้ง PromptPay และยังไม่มีช่องทางโอน manual — ผู้เช่าจะไม่มีปลายทางรับเงินที่ชัดเจน',
          fix: hasManualPaymentChannel
            ? '/admin#settings → การชำระเงิน หากต้องการ QR ให้ตั้ง PromptPay เพิ่ม'
            : '/admin#settings → การชำระเงิน ตั้ง PromptPay หรือบัญชีธนาคาร/TrueMoney Wallet',
          detail: { manualChannelConfigured: hasManualPaymentChannel },
        });
      } else {
        try {
          promptpay.normaliseTarget(paymentBlock.promptpayTarget);
          if (promptpay.isDemoTarget(paymentBlock.promptpayTarget)) {
            issues.push({
              sev: 'high', code: 'DEMO_PROMPTPAY', area: ['issue', 'payment'],
              msg: 'PromptPay ยังเป็นค่า demo (0801234567) — ผู้เช่าจะสแกนแล้วเงินไปไม่ถึงบัญชีจริง',
              fix: '/admin#settings → การชำระเงิน เป็นเบอร์/บัตรประชาชนจริง',
            });
          }
        } catch {
          issues.push({
            sev: 'high', code: 'PROMPTPAY_INVALID_SHAPE', area: ['issue', 'payment'],
            msg: `PromptPay "${paymentBlock.promptpayTarget}" รูปแบบไม่ถูกต้อง — ต้องเป็นเบอร์ 10 หลัก หรือเลขบัตรประชาชน 13 หลัก`,
            fix: '/admin#settings → การชำระเงิน',
          });
        }
      }

      const trueMoneyEnabled = cfg?.payment?.truemoney === true;
      const trueMoneyPhone = String(
        cfg?.payment?.truemoneyPhone
        || cfg?.payment?.trueMoneyPhone
        || cfg?.payment?.walletPhone
        || ''
      ).replace(/[\s-]/g, '');
      if (trueMoneyEnabled && !/^0\d{9}$/.test(trueMoneyPhone)) {
        issues.push({
          sev: 'med', code: 'TRUEMONEY_PHONE_MISSING', area: ['payment'],
          msg: 'เปิด TrueMoney Wallet แล้ว แต่ยังไม่ได้ตั้งเบอร์วอลเล็ต 10 หลัก — ผู้เช่าจะใช้ช่องทางนี้ไม่ได้',
          fix: '/admin#settings → การชำระเงิน → TrueMoney Wallet',
        });
      }

      if (!cfg?.building?.name || cfg.building.name === 'ที่พักของคุณ') {
        issues.push({
          sev: 'low', code: 'DEFAULT_BUILDING_NAME', area: ['issue'],
          msg: 'ชื่อตึกยังเป็นค่าเริ่มต้น — บิล PDF จะแสดง "ที่พักของคุณ"',
          fix: '/admin#settings → ข้อมูลตึก',
        });
      }
      if (!cfg?.building?.phone) {
        issues.push({
          sev: 'low', code: 'NO_BUILDING_PHONE', area: ['issue'],
          msg: 'เบอร์ติดต่อตึกยังไม่ใส่ — ผู้เช่าจะไม่รู้จะโทรสอบถามที่ไหน',
          fix: '/admin#settings → ข้อมูลตึก',
        });
      }

      try {
        const { rows: roomBlob } = await pool.query(
          `SELECT value FROM app_data WHERE key='baankarn_rooms_v1' LIMIT 1`
        );
        const rooms = roomBlob[0]?.value || {};
        const tenantsWithBills = Object.values(rooms).filter(
          (r) => r && r.tenant && (r.status === 'occupied' || r.status === 'overdue')
        );
        const wRate = Number(cfg?.utilities?.waterRate);
        const eRate = Number(cfg?.utilities?.elecRate);
        const issueRoom = (r, fields = []) => ({
          roomId: String(r?.id || '-'),
          tenant: r?.tenant?.name || '',
          ...(fields.length ? { fields } : {}),
        });
        const isFlatModeRequested = (r, prefix) =>
          String(r?.[`${prefix}Mode`] ?? r?.[`${prefix}_mode`] ?? '').toLowerCase() === 'flat';
        const firstMonthRoomIds = new Set();
        const firstMonthRooms = [];
        const roomIds = tenantsWithBills.map((r) => String(r?.id || '')).filter(Boolean);
        if (roomIds.length > 0) {
          try {
            const contractQ = await pool.query(
              `SELECT DISTINCT ON (room_id) id, room_id, tenant_id, start_date
                 FROM contracts
                WHERE room_id = ANY($1::text[])
                  AND status='active' AND deleted_at IS NULL
                ORDER BY room_id, start_date DESC NULLS LAST, id DESC`,
              [roomIds]
            );
            for (const contract of contractQ.rows || []) {
              if (!billing.contractStartsInPeriod(contract, readinessPeriod)) continue;
              const room = tenantsWithBills.find((r) => String(r?.id || '') === String(contract.room_id || ''));
              firstMonthRoomIds.add(String(contract.room_id));
              firstMonthRooms.push({
                roomId: String(contract.room_id),
                tenant: room?.tenant?.name || '',
                contractId: contract.id || null,
                tenantId: contract.tenant_id || null,
              });
            }
          } catch (err) {
            if (err.code !== '42P01' && err.code !== '42703') throw err;
          }
        }
        if (firstMonthRooms.length > 0) {
          issues.push({
            sev: 'info', code: 'FIRST_MONTH_WELCOME_BILL', area: ['issue'],
            msg: `${firstMonthRooms.length} ห้องเป็นเดือนแรกของสัญญา — ระบบจะไม่ออกบิลรายเดือนซ้ำ เพราะบิลย้ายเข้าและเลขมิเตอร์ตั้งต้นดูแลรอบนี้แล้ว`,
            fix: 'ตรวจบิลย้ายเข้าที่แท็บบิล หรือออกบิลด้วยมือเฉพาะกรณีพิเศษ',
            detail: { period: readinessPeriod, count: firstMonthRooms.length, rooms: firstMonthRooms.slice(0, 20) },
          });
        }
        const monthlyBillableTenants = tenantsWithBills
          .filter((r) => !firstMonthRoomIds.has(String(r?.id || '')));
        const meteredWaterRooms = monthlyBillableTenants.filter((r) => !billing.isFlatUtilityConfigured(r, 'water'));
        const meteredElecRooms = monthlyBillableTenants.filter((r) => !billing.isFlatUtilityConfigured(r, 'elec'));
        const flatMisconfigured = monthlyBillableTenants
          .map((r) => {
            const fields = [];
            if (isFlatModeRequested(r, 'water') && !billing.isFlatUtilityConfigured(r, 'water')) fields.push('water');
            if (isFlatModeRequested(r, 'elec') && !billing.isFlatUtilityConfigured(r, 'elec')) fields.push('elec');
            return fields.length ? issueRoom(r, fields) : null;
          })
          .filter(Boolean);
        const anyMeteredWater = meteredWaterRooms.length > 0;
        const anyMeteredElec = meteredElecRooms.length > 0;
        if (flatMisconfigured.length > 0) {
          issues.push({
            sev: 'med', code: 'FLAT_AMOUNT_MISSING', area: ['issue'],
            msg: `${flatMisconfigured.length} ห้องตั้งค่าน้ำ/ไฟแบบเหมา แต่ยังไม่ได้ใส่จำนวนเหมา ระบบจะ fallback ไปคิดตามมิเตอร์`,
            fix: '/admin#rooms → เปิดห้องที่แจ้งเตือน แล้วใส่จำนวนเหมาน้ำ/ไฟ หรือเปลี่ยนกลับเป็นคิดตามมิเตอร์',
            detail: { period: readinessPeriod, count: flatMisconfigured.length, rooms: flatMisconfigured.slice(0, 20) },
          });
        }
        if (anyMeteredWater && (!Number.isFinite(wRate) || wRate <= 0)) {
          issues.push({
            sev: 'high', code: 'NO_WATER_RATE', area: ['issue'],
            msg: 'ค่าน้ำต่อหน่วยยังไม่ตั้ง — บิลจะออกค่าน้ำ ฿0 สำหรับห้องที่คิดตามมิเตอร์',
            fix: '/admin#pricing → ค่าน้ำ-ไฟ หรือ ตั้งค่าน้ำแบบเหมาในทุกห้องที่ไม่ใช้มิเตอร์',
            detail: { period: readinessPeriod, count: meteredWaterRooms.length, rooms: meteredWaterRooms.map((r) => issueRoom(r, ['water'])).slice(0, 20) },
          });
        }
        if (anyMeteredElec && (!Number.isFinite(eRate) || eRate <= 0)) {
          issues.push({
            sev: 'high', code: 'NO_ELEC_RATE', area: ['issue'],
            msg: 'ค่าไฟต่อหน่วยยังไม่ตั้ง — บิลจะออกค่าไฟ ฿0 สำหรับห้องที่คิดตามมิเตอร์',
            fix: '/admin#pricing → ค่าน้ำ-ไฟ หรือ ตั้งค่าไฟแบบเหมาในทุกห้องที่ไม่ใช้มิเตอร์',
            detail: { period: readinessPeriod, count: meteredElecRooms.length, rooms: meteredElecRooms.map((r) => issueRoom(r, ['elec'])).slice(0, 20) },
          });
        }
        const periodMeters = await meter.buildPeriodSummary(pool, rooms, readinessPeriod);
        const hasPeriodReading = (r, prefix) => {
          const m = periodMeters[String(r.id)] || {};
          return m[`${prefix}CurrentReading`] != null;
        };
        const noMeter = monthlyBillableTenants.filter((r) =>
          (!billing.isFlatUtilityConfigured(r, 'water') && !hasPeriodReading(r, 'water'))
          || (!billing.isFlatUtilityConfigured(r, 'elec') && !hasPeriodReading(r, 'elec'))
        );
        if (tenantsWithBills.length === 0) {
          issues.push({
            sev: 'high', code: 'NO_BILLABLE_TENANTS', area: ['issue'],
            msg: 'ยังไม่มีห้องที่มีผู้เช่า status occupied/overdue — กดออกบิลจะออก 0 ใบ',
            fix: '/admin#rooms → กำหนดผู้เช่าให้ห้องก่อน',
          });
        } else if (noMeter.length > 0) {
          issues.push({
            sev: 'high', code: 'NO_METER_READINGS', area: ['issue'],
            msg: `${noMeter.length} ห้องยังไม่มีเลขมิเตอร์ครบสำหรับรอบ ${readinessPeriod} — บิลส่วนน้ำ/ไฟอาจเป็น 0 หรือข้อมูลไม่ครบ`,
            fix: `/admin#meters → เลือกรอบ ${readinessPeriod} แล้วบันทึกเลขมิเตอร์ก่อนออกบิล`,
            detail: { period: readinessPeriod, count: noMeter.length, rooms: noMeter.map((r) => {
              const fields = [];
              if (!billing.isFlatUtilityConfigured(r, 'water') && !hasPeriodReading(r, 'water')) fields.push('water');
              if (!billing.isFlatUtilityConfigured(r, 'elec') && !hasPeriodReading(r, 'elec')) fields.push('elec');
              return issueRoom(r, fields);
            }).slice(0, 20) },
          });
        }
      } catch { /* tolerate empty rooms blob */ }

      if (flags?.slipUpload?.enabled) {
        if (!flags?.tenantPortal?.enabled) {
          issues.push({
            sev: 'high', code: 'SLIP_NEEDS_PORTAL', area: ['payment'],
            msg: 'slipUpload เปิด แต่ tenantPortal ปิด — ผู้เช่า login ไม่ได้ จะ upload สลิปไม่ได้',
            fix: '/admin#features → เปิด tenantPortal',
          });
        }
        if (flags.slipUpload.allowUnverifiedAutoApprove === true) {
          issues.push({
            sev: 'med', code: 'AUTO_APPROVE_UNVERIFIED', area: ['payment'],
            msg: 'allowUnverifiedAutoApprove เปิด — สลิปจะถูก mark paid โดยไม่ต้องตรวจสอบ (legacy trust mode)',
            fix: '/admin#features → ปิด allowUnverifiedAutoApprove เว้นแต่ตั้งใจ',
          });
        }
        if (flags.slipUpload.autoVerify) {
          // Audit each provider explicitly so a typo'd name ('slipo')
          // surfaces as "ชื่อ provider ไม่รู้จัก" with the exact bad string,
          // and a missing key surfaces as "ตั้ง KEY_NAME ใน Secrets" with
          // the exact key name.
          const audit = slipVerifier.auditProviders(flags);
          if (audit.unknown.length > 0) {
            issues.push({
              sev: 'med', code: 'PROVIDER_NAME_UNKNOWN', area: ['payment'],
              msg: `ชื่อ provider ไม่รู้จัก: ${audit.unknown.join(', ')} — ระบบจะข้ามและไม่เรียก provider เหล่านี้`,
              fix: '/admin#features → ตรวจรายชื่อ providers (รองรับเฉพาะ slipok, easyslip, slip2go)',
            });
          }
          if (audit.missingKeys.length > 0) {
            const keyList = audit.missingKeys.flatMap((p) => p.keys);
            issues.push({
              sev: 'med', code: 'AUTOVERIFY_MISSING_KEY', area: ['payment'],
              msg: `provider ${audit.missingKeys.map((p) => p.id).join(', ')} ตั้งชื่อไว้แต่ key ยังไม่ใส่`,
              fix: `/admin#secrets → ตั้ง ${keyList.join(', ')}`,
            });
          }
          if (audit.ready.length === 0 && audit.unknown.length === 0 && audit.missingKeys.length === 0) {
            issues.push({
              sev: 'med', code: 'AUTOVERIFY_NO_PROVIDER', area: ['payment'],
              msg: 'autoVerify เปิด แต่ยังไม่ระบุ provider — สลิปจะตกเข้าคิว admin เหมือนเดิม',
              fix: '/admin#features → กรอก providers เช่น ["slipok"], ["slip2go"] หรือ ["slipok","easyslip","slip2go"]',
            });
          }
        } else if (flags.slipUpload.requireVerification === false) {
          issues.push({
            sev: 'med', code: 'NO_VERIFICATION_PATH', area: ['payment'],
            msg: 'requireVerification ปิด แต่ autoVerify ก็ปิด — สลิปจะยังรอ admin ตรวจสอบเสมอ',
            fix: '/admin#features → เปิด autoVerify (พร้อม provider key) หรือเปิด requireVerification กลับ',
          });
        }
      } else {
        issues.push({
          sev: 'low', code: 'SLIP_UPLOAD_DISABLED', area: ['payment'],
          msg: 'slipUpload ปิด — ผู้เช่าจะ upload สลิปจากพอร์ทัลไม่ได้',
          fix: '/admin#features → เปิด slipUpload (ถ้าต้องการรับสลิปออนไลน์)',
        });
      }

      let hasOaInDb = false;
      try {
        const oaQ = await pool.query(`SELECT COUNT(*)::int AS n FROM line_oas WHERE deleted_at IS NULL`);
        hasOaInDb = (Number(oaQ.rows[0]?.n) || 0) > 0;
      } catch { /* legacy deploys without line_oas */ }
      const lineEnvCfg = !!(secretsSvc.get('LINE_CHANNEL_ACCESS_TOKEN') || secretsSvc.get('LINE_CHANNEL_SECRET'));
      if (!lineEnvCfg && !hasOaInDb) {
        issues.push({
          sev: 'med', code: 'NO_LINE_OA', area: ['issue', 'payment'],
          msg: 'ยังไม่มี LINE OA — การแจ้งบิล/แจ้งผลตรวจสลิปจะไม่ส่ง LINE',
          fix: '/admin#line-oa → ผูก LINE Official Account',
        });
      }

      try {
        const pendQ = await pool.query(
          `SELECT COUNT(*)::int AS n FROM payments
            WHERE status='pending' AND created_at > NOW() - INTERVAL '7 days'`
        );
        const pendingN = Number(pendQ.rows[0]?.n) || 0;
        if (pendingN > 20) {
          issues.push({
            sev: 'low', code: 'BIG_VERIFY_QUEUE', area: ['payment'],
            msg: `${pendingN} สลิปรอตรวจสอบในช่วง 7 วัน — backlog ค่อนข้างใหญ่`,
            fix: '/admin#payments → ตรวจสลิปค้างคิวก่อน',
            detail: { pending: pendingN },
          });
        }
      } catch { /* tolerate missing payments */ }

      // Surface the double-credit backstop index when it is missing. The
      // uq_payments_one_verified_per_bill unique index is skipped at migration
      // time (with only a boot-log WARNING) when historical duplicate verified
      // payments already exist, and the skip is sticky until those rows are
      // reconciled AND migrate re-runs. Without it the "one verified payment per
      // bill" guarantee is gone — a race/double-submit can double-credit a bill.
      // Make the gap visible (med, non-blocking) instead of silent so operators
      // can reconcile and restart. Non-blocking on purpose: the system can still
      // record payments, just without the DB-level dedup safety net.
      try {
        const idxQ = await pool.query(
          `SELECT 1 FROM pg_indexes
            WHERE schemaname='public' AND indexname='uq_payments_one_verified_per_bill' LIMIT 1`
        );
        if (!idxQ.rows.length) {
          let dupBills = 0;
          try {
            const dupQ = await pool.query(
              `SELECT COUNT(*)::int AS n FROM (
                 SELECT bill_id FROM payments
                  WHERE bill_id IS NOT NULL AND status='verified'
                  GROUP BY bill_id HAVING COUNT(*) > 1
               ) d`
            );
            dupBills = Number(dupQ.rows[0]?.n) || 0;
          } catch { /* tolerate older schema */ }
          issues.push({
            sev: 'med', code: 'MISSING_VERIFIED_PAYMENT_INDEX', area: ['payment'],
            msg: dupBills > 0
              ? `ดัชนีกันจ่ายซ้ำ (1 บิล = 1 การชำระที่ยืนยัน) ยังไม่ติดตั้ง เพราะมี ${dupBills} บิลที่มีการชำระยืนยันซ้ำอยู่ก่อนแล้ว — ระบบกำลังทำงานโดยไม่มีตัวกันเครดิตซ้ำระดับฐานข้อมูล`
              : 'ดัชนีกันจ่ายซ้ำ (uq_payments_one_verified_per_bill) หายไป — ระบบไม่มีตัวกันเครดิตซ้ำระดับฐานข้อมูล',
            fix: dupBills > 0
              ? '/admin#payments → แก้บิลที่มีการชำระยืนยันซ้ำให้เหลือรายการเดียว แล้ว restart เพื่อให้ migration สร้างดัชนีให้อัตโนมัติ'
              : 'restart บริการเพื่อให้ migration สร้างดัชนีใหม่ — หากยังหายให้ตรวจ log การ migrate',
            detail: { duplicateBills: dupBills },
          });
        }
      } catch { /* tolerate missing payments table / pg_indexes access */ }

      const blockingIssue = issues.some((i) => i.sev === 'high' && i.area.includes('issue'));
      const blockingPayment = issues.some((i) => i.sev === 'high' && i.area.includes('payment'));
      res.json({
        ok: true,
        checkedAt: new Date().toISOString(),
        issues,
        summary: {
          canIssueBills: !blockingIssue,
          canRecordPayments: !blockingPayment,
          issueCount: issues.length,
          highCount: issues.filter((i) => i.sev === 'high').length,
          medCount: issues.filter((i) => i.sev === 'med').length,
        },
      });
    } catch (err) {
      console.error('billing-readiness error:', err);
      res.status(500).json({ error: 'internal error', message: err.message });
    }
  });

// GET /api/admin/rooms/:roomId/audit — full picture of a single room across
// every source-of-truth: legacy JSONB blob, rooms_v2 table, active contract,
// outstanding bills (with tenant name attached). Built to answer "why is
// this room still showing occupied?" and "who owes the unpaid bill?" in one
// admin call — no need to cross-reference billing/contracts/tenants tabs.
// Returns:
//   {
//     ok: true,
//     roomId: '101',
//     blob:   { tenant: { name, phone, ... } | null, status: 'occupied' | 'vacant' | ... }
//     v2:     { status, ... } | null,
//     activeContract: { id, contract_no, tenant_id, tenant_name, start_date, end_date } | null,
//     outstandingBills: [{ id, bill_no, period, total, status, due_date,
//                          tenant_id, tenant_name, days_overdue }],
//     issues: [{ sev, code, msg, fix }],
//     reconcilable: boolean  // true when /reconcile would fix something
//   }
app.get('/api/admin/rooms/:roomId/audit',
  requireAuth, requireRole('owner', 'manager'),
  async (req, res) => {
    const roomId = String(req.params.roomId).slice(0, 32);
    if (!roomId) return res.status(400).json({ error: 'roomId required' });
    try {
      // Pull all four sources in parallel so a slow DB doesn't double the
      // latency on the admin click.
      const [blobQ, v2Q, contractQ, billsQ] = await Promise.all([
        pool.query(
          `SELECT value->$1 AS room
             FROM app_data WHERE key='baankarn_rooms_v1' LIMIT 1`,
          [roomId]
        ),
        pool.query(
          `SELECT room_code, status, room_type, rent_price, updated_at
             FROM rooms_v2 WHERE room_code=$1 AND deleted_at IS NULL LIMIT 1`,
          [roomId]
        ).catch((err) => {
          // Legacy deploys without rooms_v2 — return empty result rather
          // than 500 since the blob alone can still answer.
          if (err.code === '42P01') return { rows: [] };
          throw err;
        }),
        pool.query(
          `SELECT c.id, c.contract_no, c.tenant_id, c.start_date, c.end_date,
                  c.monthly_rent, c.deposit, c.status,
                  t.full_name AS tenant_name, t.phone AS tenant_phone
             FROM contracts c
             LEFT JOIN tenants t ON t.id = c.tenant_id
            WHERE c.room_id=$1 AND c.status='active' AND c.deleted_at IS NULL
            ORDER BY c.start_date DESC LIMIT 1`,
          [roomId]
        ),
        pool.query(
          `SELECT b.id, b.bill_no, b.period, b.total, b.status, b.due_date,
                  b.tenant_id, b.created_at,
                  t.full_name AS tenant_name, t.phone AS tenant_phone,
                  t.status AS tenant_status,
                  GREATEST(0, (CURRENT_DATE - b.due_date)::int) AS days_overdue
             FROM bills b
             LEFT JOIN tenants t ON t.id = b.tenant_id
            WHERE b.room_id=$1 AND b.deleted_at IS NULL
              AND b.status IN ('pending','overdue')
            ORDER BY b.due_date ASC, b.id ASC
            LIMIT 50`,
          [roomId]
        ),
      ]);

      const blobRoom = blobQ.rows[0]?.room || null;
      const v2 = v2Q.rows[0] || null;
      const activeContract = contractQ.rows[0] || null;
      const outstandingBills = billsQ.rows.map((b) => ({
        id: b.id, billNo: b.bill_no, period: b.period,
        total: Number(b.total), status: b.status, dueDate: b.due_date,
        daysOverdue: Number(b.days_overdue) || 0,
        tenantId: b.tenant_id,
        tenantName: b.tenant_name || null,
        tenantPhone: b.tenant_phone || null,
        tenantStatus: b.tenant_status || null,  // 'active' | 'moved_out' | null
        createdAt: b.created_at,
      }));

      // === Issue detection — cross-source consistency =====================
      const issues = [];
      const blobTenant = blobRoom?.tenant || null;
      const blobStatus = blobRoom?.status || null;

      // A) Blob says occupied (has tenant) but no active contract — the
      // exact symptom user reported. Caused by PUT /tenants/:id bypass
      // (now blocked) or pre-fix orphans.
      if (blobTenant && !activeContract) {
        issues.push({
          sev: 'high', code: 'BLOB_TENANT_NO_CONTRACT',
          msg: `ห้องแสดงผู้เช่า "${blobTenant.name || '-'}" แต่ไม่มีสัญญา active — ผู้เช่าออกแล้วแต่ blob ค้าง`,
          fix: 'กดปุ่ม "Reconcile ห้อง" ด้านล่าง (จะปิดสัญญาที่ค้าง + ล้างผู้เช่าจาก blob)',
        });
      }

      // B) Active contract but blob has no tenant — opposite drift, also
      // means /api/rooms (blob-backed) lies to admin about availability.
      if (activeContract && !blobTenant) {
        issues.push({
          sev: 'high', code: 'CONTRACT_NO_BLOB_TENANT',
          msg: `มีสัญญา active กับ ${activeContract.tenant_name} แต่ blob ไม่มีข้อมูลผู้เช่า — sync ห้อง blob`,
          fix: 'กดปุ่ม "Reconcile ห้อง" ด้านล่าง',
        });
      }

      // C) Status divergence between blob and rooms_v2.
      if (v2 && blobStatus && blobStatus !== v2.status) {
        issues.push({
          sev: 'med', code: 'STATUS_MISMATCH',
          msg: `Blob: "${blobStatus}", rooms_v2: "${v2.status}" — สอง source ไม่ตรงกัน`,
          fix: 'Reconcile จะ sync ทั้งสอง source ตาม contract เป็นตัวอ้างอิง',
        });
      }

      // D) Outstanding bills from a moved_out tenant — the "ค้างของใคร"
      // information the user asked to surface. Group by tenant for the UI.
      const movedOutBillsByTenant = new Map();
      for (const b of outstandingBills) {
        if (b.tenantStatus === 'moved_out') {
          const k = b.tenantId;
          if (!movedOutBillsByTenant.has(k)) {
            movedOutBillsByTenant.set(k, {
              tenantId: b.tenantId, tenantName: b.tenantName,
              tenantPhone: b.tenantPhone, bills: [],
            });
          }
          movedOutBillsByTenant.get(k).bills.push(b);
        }
      }
      const movedOutOwners = Array.from(movedOutBillsByTenant.values());
      for (const owner of movedOutOwners) {
        const total = owner.bills.reduce((s, b) => s + (b.total || 0), 0);
        issues.push({
          sev: 'high', code: 'OUTSTANDING_FROM_MOVED_OUT',
          msg: `บิลค้าง ${owner.bills.length} ใบ ยอด ฿${total.toLocaleString('th-TH', { minimumFractionDigits: 2 })} ของอดีตผู้เช่า ${owner.tenantName || '-'}${owner.tenantPhone ? ` (${owner.tenantPhone})` : ''}`,
          fix: 'ติดต่ออดีตผู้เช่าเก็บเงิน หรือ void บิลถ้าตัดสินใจไม่เก็บแล้ว',
          detail: {
            tenantId: owner.tenantId,
            tenantName: owner.tenantName,
            tenantPhone: owner.tenantPhone,
            bills: owner.bills.map((b) => ({
              id: b.id, billNo: b.billNo, total: b.total,
              status: b.status, dueDate: b.dueDate, daysOverdue: b.daysOverdue,
            })),
          },
        });
      }

      const reconcilable = issues.some((i) =>
        i.code === 'BLOB_TENANT_NO_CONTRACT'
        || i.code === 'CONTRACT_NO_BLOB_TENANT'
        || i.code === 'STATUS_MISMATCH'
      );

      res.json({
        ok: true,
        roomId,
        blob: blobRoom
          ? { tenant: blobRoom.tenant || null, status: blobStatus }
          : null,
        v2: v2 ? { status: v2.status, rentPrice: Number(v2.rent_price), updatedAt: v2.updated_at } : null,
        activeContract: activeContract ? {
          id: activeContract.id, contractNo: activeContract.contract_no,
          tenantId: activeContract.tenant_id, tenantName: activeContract.tenant_name,
          tenantPhone: activeContract.tenant_phone,
          startDate: activeContract.start_date, endDate: activeContract.end_date,
          monthlyRent: Number(activeContract.monthly_rent),
        } : null,
        outstandingBills,
        issues,
        reconcilable,
      });
    } catch (err) {
      console.error('room audit error:', err);
      res.status(500).json({ error: 'internal error', message: err.message });
    }
  });

// POST /api/admin/rooms/:roomId/reconcile — owner-only: fix a stranded room
// by closing any orphan active contract, clearing the blob's tenant key,
// and syncing rooms_v2.status to 'vacant'. Used by admin when /audit
// reports `reconcilable: true` (e.g., a pre-fix orphan from before the PUT
// block landed). Outstanding bills are NOT touched — admin chooses to
// chase them or void them via /admin#billing.
app.post('/api/admin/rooms/:roomId/reconcile',
  sameOrigin, csrfGuard, requireAuth, requireRole('owner'),
  async (req, res) => {
    const roomId = String(req.params.roomId).slice(0, 32);
    if (!roomId) return res.status(400).json({ error: 'roomId required' });
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    const client = await pool.connect();
    const actions = [];
    try {
      await client.query('BEGIN');

      // 1) Close any active contract on this room (lock first so concurrent
      //    contract edits don't race past us).
      const orphans = await client.query(
        `SELECT id, contract_no, tenant_id FROM contracts
           WHERE room_id=$1 AND status='active' AND deleted_at IS NULL
           FOR UPDATE`,
        [roomId]
      );
      for (const c of orphans.rows) {
        await client.query(
          `UPDATE contracts SET status='ended', end_date=CURRENT_DATE,
                deposit_return_reason = COALESCE(deposit_return_reason, $2),
                updated_at = NOW()
            WHERE id=$1`,
          [c.id, `[reconcile] ${reason || 'admin reconcile of stranded room'}`]
        );
        actions.push({ kind: 'contract_closed', id: c.id, contractNo: c.contract_no, tenantId: c.tenant_id });

        // Cascade tenant to moved_out (if not already) + clear current_room_id.
        await client.query(
          `UPDATE tenants
              SET status='moved_out', current_room_id=NULL, updated_at=NOW()
            WHERE id=$1 AND status='active'`,
          [c.tenant_id]
        );

        // Revoke any still-active access cards tied to that tenant.
        const cards = await client.query(
          `UPDATE access_cards SET status='revoked', revoked_at=NOW(),
                revoke_reason='auto:reconcile'
            WHERE tenant_id=$1 AND status='active' RETURNING id`,
          [c.tenant_id]
        );
        if (cards.rowCount > 0) actions.push({ kind: 'cards_revoked', count: cards.rowCount, tenantId: c.tenant_id });

        // Deactivate tenant-scoped recurring charges.
        await client.query(
          `UPDATE recurring_charges SET active=FALSE, updated_at=NOW()
            WHERE tenant_id=$1 AND active=TRUE`,
          [c.tenant_id]
        ).catch((err) => { if (err.code !== '42P01') throw err; });
      }

      // 2) Free the room in the legacy JSONB blob: drop the 'tenant' key
      //    + set status='vacant'. Skip silently if the room key isn't in
      //    the blob (rooms_v2-only deploy).
      const blobUpd = await client.query(
        `UPDATE app_data
            SET value = jsonb_set(
                          value,
                          ARRAY[$1::text],
                          ((value->$1) - 'tenant') || jsonb_build_object('status', 'vacant')
                        ),
                updated_at = NOW()
          WHERE key='baankarn_rooms_v1' AND value ? $1`,
        [roomId]
      );
      if (blobUpd.rowCount > 0) actions.push({ kind: 'blob_freed' });

      // 3) Sync rooms_v2.status='vacant' (tolerate missing table on legacy).
      try {
        const v2Upd = await client.query(
          `UPDATE rooms_v2 SET status='vacant', updated_at=NOW()
            WHERE room_code=$1 AND deleted_at IS NULL`,
          [roomId]
        );
        if (v2Upd.rowCount > 0) actions.push({ kind: 'rooms_v2_freed' });
      } catch (err) { if (err.code !== '42P01') throw err; }

      await client.query('COMMIT');
      audit(req, 'room.reconcile', 'room', roomId, { actions, reason: reason || null });
      res.json({ ok: true, actions });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('room reconcile error:', err);
      res.status(500).json({ error: 'internal error', message: err.message });
    } finally {
      client.release();
    }
  });

// Sign / verify a bill QR token. Used by GET /p/bill-qr/:billId so the URL
// can be sent over LINE Messaging API (which requires a public HTTPS URL —
// can't auth with a session cookie). The token is HMAC(billId|expiry|secret)
// + URL-safe base64. Two layers of protection:
//   - billId is mixed into the HMAC so an attacker can't reuse a valid
//     token for a different bill.
//   - expiry is encoded in the token so old links naturally die after the
//     LINE chat scrolls past them (default 30 days — matches a typical
//     billing cycle so the link still works if the tenant pays late).
// QR content is non-sensitive (just a payment QR to the dorm's PromptPay
// target — anyone scanning it pays the dorm, not steals data), so a
// time-limited public URL is acceptable trade-off.
function signBillQrToken(billId, expiresAt) {
  return billTokens.signBillQrToken(billId, expiresAt);
}
function verifyBillQrToken(billId, token) {
  return billTokens.verifyBillQrToken(billId, token);
}

const BILL_QR_STATUS_IMAGE_CACHE = new Map();
const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function pngCrc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = PNG_CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBuf.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(pngCrc32(Buffer.concat([typeBuf, data])), 8 + data.length);
  return out;
}

function renderPaidBillQrStatusPng() {
  const cached = BILL_QR_STATUS_IMAGE_CACHE.get('paid');
  if (cached) return cached;
  const zlib = require('zlib');
  const width = 640;
  const height = 640;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const bg = [240, 253, 244, 255];
  const green = [22, 101, 52, 255];
  const green2 = [21, 128, 61, 255];
  const white = [255, 255, 255, 255];
  const gray = [73, 83, 75, 255];
  function put(x, y, color) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const off = y * (width * 4 + 1) + 1 + x * 4;
    raw[off] = color[0];
    raw[off + 1] = color[1];
    raw[off + 2] = color[2];
    raw[off + 3] = color[3];
  }
  function fillRect(x, y, w, h, color) {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(width, Math.ceil(x + w));
    const y1 = Math.min(height, Math.ceil(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) put(xx, yy, color);
  }
  function disk(cx, cy, r, color) {
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2) put(x, y, color);
      }
    }
  }
  function line(x0, y0, x1, y1, thickness, color) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      disk(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, thickness / 2, color);
    }
  }
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) put(x, y, bg);
  }
  fillRect(0, 0, width, 18, green2);
  fillRect(0, height - 18, width, 18, green2);
  fillRect(0, 0, 18, height, green2);
  fillRect(width - 18, 0, 18, height, green2);
  disk(320, 210, 94, green2);
  line(268, 212, 306, 250, 22, white);
  line(306, 250, 380, 162, 22, white);

  const font = {
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
    L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  };
  function measure(text, scale) {
    let total = 0;
    for (const ch of text) total += (ch === ' ' ? 3 : 5) * scale + scale;
    return Math.max(0, total - scale);
  }
  function drawText(text, x, y, scale, color) {
    let cx = x;
    for (const ch of text.toUpperCase()) {
      if (ch === ' ') {
        cx += 4 * scale;
        continue;
      }
      const rows = font[ch];
      if (!rows) continue;
      for (let yy = 0; yy < rows.length; yy++) {
        for (let xx = 0; xx < rows[yy].length; xx++) {
          if (rows[yy][xx] === '1') fillRect(cx + xx * scale, y + yy * scale, scale, scale, color);
        }
      }
      cx += 6 * scale;
    }
  }
  drawText('BILL', Math.round((width - measure('BILL', 10)) / 2), 338, 10, gray);
  drawText('PAID', Math.round((width - measure('PAID', 24)) / 2), 392, 24, green);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  const rendered = { contentType: 'image/png', renderer: 'status-png', body: png };
  BILL_QR_STATUS_IMAGE_CACHE.set('paid', rendered);
  return rendered;
}

function signBillPayToken(billId, expiresAt) {
  return billTokens.signBillPayToken(billId, expiresAt);
}
function verifyBillPayToken(billId, token) {
  return billTokens.verifyBillPayToken(billId, token);
}

// GET /p/bill-qr/:billId?t=<token> — PUBLIC endpoint that LINE Platform
// (and any browser following the link) can fetch as image content. Token
// is HMAC-signed so it can't be enumerated to access bills you don't
// know about. Returns 404 for unknown bill, 403 for invalid token,
// otherwise the same PNG/SVG fallback chain as the tenant-auth path.
const PUBLIC_SLIP_UPLOAD_MAX_ATTEMPTS = 3;

async function loadBillPaymentAttemptSummary(db, billId, tenantId) {
  const id = Number(billId);
  const tid = Number(tenantId);
  if (!Number.isInteger(id) || id < 1 || !Number.isInteger(tid) || tid < 1) {
    return {
      used: 0,
      remaining: PUBLIC_SLIP_UPLOAD_MAX_ATTEMPTS,
      max: PUBLIC_SLIP_UPLOAD_MAX_ATTEMPTS,
      hasPending: false,
      pendingCount: 0,
      rejectedCount: 0,
      verifiedCount: 0,
      latest: null,
    };
  }
  const params = [id, tid];
  // The "used" count gates the SLIP_UPLOAD_LIMIT_REACHED 3-strikes
  // limit. We EXCLUDE rows that were rejected by admin cascade
  // (sibling-rejection on verify/manual-pay, void's payment reversal,
  // unmark-paid correction). Those rows came from system housekeeping,
  // not from the tenant attempting again — counting them locks the
  // tenant out of a bill that was later flipped back to pending.
  // Pending/verified counts include all rows so the UI still reflects
  // the current state.
  const counts = await db.query(
    `SELECT
        COUNT(*) FILTER (
          WHERE status<>'rejected'
             OR rejected_reason IS NULL
             OR (rejected_reason NOT LIKE 'superseded\\_%' ESCAPE '\\'
                 AND rejected_reason NOT LIKE 'unmark\\_paid\\_%' ESCAPE '\\')
        )::int AS used,
        COUNT(*) FILTER (WHERE status='pending')::int AS pending_count,
        COUNT(*) FILTER (WHERE status='rejected')::int AS rejected_count,
        COUNT(*) FILTER (WHERE status='verified')::int AS verified_count
       FROM payments
      WHERE bill_id=$1 AND tenant_id=$2`,
    params
  );
  const latest = await db.query(
    `SELECT id, status, amount, rejected_reason, verified_by, verified_at,
            verify_provider, verify_payload, transaction_ref, created_at
       FROM payments
      WHERE bill_id=$1 AND tenant_id=$2
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    params
  );
  const c = counts.rows[0] || {};
  const used = Number(c.used) || 0;
  return {
    used,
    remaining: Math.max(PUBLIC_SLIP_UPLOAD_MAX_ATTEMPTS - used, 0),
    max: PUBLIC_SLIP_UPLOAD_MAX_ATTEMPTS,
    hasPending: (Number(c.pending_count) || 0) > 0,
    pendingCount: Number(c.pending_count) || 0,
    rejectedCount: Number(c.rejected_count) || 0,
    verifiedCount: Number(c.verified_count) || 0,
    latest: latest.rows[0] || null,
  };
}

function publicBillPayTenantStatusAllowed(status) {
  return status === 'active' || status === 'moved_out';
}

function publicSlipBlockReason({ flags, payable, paid, attempts }) {
  if (paid) return { code: 'PAID', message: 'บิลนี้ชำระเรียบร้อยแล้ว ไม่ต้องส่งสลิปเพิ่ม' };
  if (!flags.slipUpload || !flags.slipUpload.enabled) {
    return { code: 'SLIP_UPLOAD_DISABLED', message: 'ระบบยังไม่เปิดรับอัปโหลดสลิปออนไลน์' };
  }
  if (!payable) {
    return {
      code: 'BILL_NOT_PAYABLE',
      message: 'บิลนี้ยังไม่สามารถชำระผ่านระบบได้ กรุณาติดต่อแอดมิน',
    };
  }
  if (attempts && attempts.hasPending) {
    return {
      code: 'PAYMENT_UNDER_REVIEW',
      message: 'มีสลิปรอแอดมินตรวจสอบอยู่แล้ว กรุณารอผลก่อนส่งใหม่',
    };
  }
  if (attempts && attempts.remaining <= 0) {
    return {
      code: 'SLIP_UPLOAD_LIMIT_REACHED',
      message: 'อัปโหลดสลิปครบ 3 ครั้งแล้ว กรุณาติดต่อแอดมิน',
    };
  }
  return null;
}

function slipBlockReadinessIssue(slipBlock) {
  if (!slipBlock) return null;
  if (slipBlock.code === 'SLIP_UPLOAD_LIMIT_REACHED') {
    return {
      sev: 'high',
      code: slipBlock.code,
      msg: 'อัปโหลดสลิปครบ 3 ครั้งแล้ว กรุณาติดต่อแอดมิน',
      fix: 'ติดต่อแอดมินเพื่อให้ตรวจสอบการชำระเงินหรือเปิดรอบอัปโหลดใหม่',
    };
  }
  if (slipBlock.code === 'PAYMENT_UNDER_REVIEW') {
    return {
      sev: 'high',
      code: slipBlock.code,
      msg: 'มีสลิปรอแอดมินตรวจสอบอยู่ กรุณารอผลการตรวจสอบ',
      fix: 'ติดต่อแอดมินหากต้องการตรวจสอบเร่งด่วน',
    };
  }
  return {
    sev: 'high',
    code: slipBlock.code,
    msg: slipBlock.message || 'ไม่สามารถอัปโหลดสลิปได้ในขณะนี้',
    fix: 'ติดต่อแอดมิน',
  };
}

function publicPartyForSlipNotice(party) {
  if (!party || typeof party !== 'object') return null;
  return {
    name: party.name || party.displayName || null,
    bank: party.bank || null,
    account: party.account || null,
  };
}

function paymentBlockReceiverTargets(paymentBlock) {
  const targets = [];
  const addDigits = (value) => {
    const digits = String(value || '').replace(/[^0-9]/g, '');
    if (digits.length >= 4) targets.push(digits);
  };
  if (paymentBlock && paymentBlock.bankInfo && paymentBlock.bankInfo.account) {
    addDigits(paymentBlock.bankInfo.account);
  }
  if (paymentBlock && paymentBlock.walletInfo && paymentBlock.walletInfo.phone) {
    addDigits(paymentBlock.walletInfo.phone);
  }
  return Array.from(new Set(targets));
}

function paymentBlockReceiverTargetEntries(paymentBlock, promptpayTarget = null) {
  const entries = [];
  const seen = new Set();
  const add = (method, value, label) => {
    const digits = String(value || '').replace(/[^0-9]/g, '');
    if (digits.length < 4) return;
    const key = `${method}:${digits}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ method, target: digits, label });
  };
  if (promptpayTarget || paymentBlock?.promptpayTarget) {
    add('promptpay', promptpayTarget || paymentBlock.promptpayTarget, 'PromptPay');
  }
  if (paymentBlock?.bankInfo?.account) {
    add('transfer', paymentBlock.bankInfo.account, paymentBlock.bankInfo.bank || 'Bank transfer');
  }
  if (paymentBlock?.walletInfo?.phone) {
    add('truemoney', paymentBlock.walletInfo.phone, 'TrueMoney Wallet');
  }
  return entries;
}

function normalizeUploadedSlipMethod(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'promptpay') return 'promptpay';
  if (raw === 'truemoney' || raw === 'wallet') return 'truemoney';
  if (raw === 'bank' || raw === 'transfer') return 'transfer';
  return null;
}

function inferSlipPaymentMethod(paymentBlock, verifyResult, opts = {}) {
  if (verifyResult?.receiverMatch?.method) return verifyResult.receiverMatch.method;
  const actualDigits = String(verifyResult?.receiver?.account || '').replace(/[^0-9]/g, '');
  if (actualDigits.length >= 4) {
    for (const target of paymentBlockReceiverTargetEntries(paymentBlock, opts.promptpayTarget)) {
      const targetDigits = String(target.target || '').replace(/[^0-9]/g, '');
      const compareLen = Math.min(6, targetDigits.length, actualDigits.length);
      if (compareLen >= 4 && targetDigits.slice(-compareLen) === actualDigits.slice(-compareLen)) {
        return target.method;
      }
    }
  }
  const requested = normalizeUploadedSlipMethod(opts.requestedMethod);
  if (requested) return requested;
  return opts.defaultMethod || (opts.promptpayTarget || paymentBlock?.promptpayTarget ? 'promptpay' : 'transfer');
}

function slipRejectCopy(code, fallback) {
  const map = {
    AMOUNT_MISMATCH: {
      title: 'ยอดในสลิปไม่ตรงกับยอดบิล',
      message: fallback || 'ระบบตรวจพบว่ายอดเงินในสลิปไม่ตรงกับยอดที่ต้องชำระ',
      nextAction: 'ตรวจยอดในบิลและอัปโหลดสลิปที่โอนยอดถูกต้องใหม่ หากโอนถูกแล้วให้ติดต่อแอดมิน',
    },
    RECEIVER_MISMATCH: {
      title: 'บัญชีปลายทางไม่ตรงกับที่ตั้งไว้',
      message: fallback || 'สลิปนี้ไม่ได้โอนเข้าบัญชี/พร้อมเพย์ของหอพักที่ตั้งไว้ในระบบ',
      nextAction: 'ตรวจบัญชีปลายทางก่อนอัปโหลดใหม่ หากแน่ใจว่าโอนถูกบัญชีให้ติดต่อแอดมิน',
    },
    RECEIVER_UNREADABLE: {
      title: 'ตรวจบัญชีปลายทางจากสลิปไม่ได้',
      message: fallback || 'บริการตรวจสลิปอ่านข้อมูลบัญชีปลายทางจากสลิปไม่ได้',
      nextAction: 'อัปโหลดรูปสลิปที่ชัดเจน มี QR code และรายละเอียดครบ หรือ ติดต่อแอดมิน',
    },
    DUPLICATE_SLIP: {
      title: 'สลิปนี้ถูกใช้หรือตรวจสอบไปแล้ว',
      message: fallback || 'ระบบพบว่าสลิปหรือรายการโอนนี้ถูกใช้ไปแล้ว',
      nextAction: 'อัปโหลดสลิปของรายการโอนใหม่ หากเป็นความผิดพลาดให้ติดต่อแอดมิน',
    },
    DUPLICATE_SLIP_HASH: {
      title: 'สลิปนี้ถูกอัปโหลดซ้ำ',
      message: fallback || 'ไฟล์สลิปนี้ถูกใช้ไปแล้ว ไม่สามารถส่งซ้ำได้',
      nextAction: 'อัปโหลดสลิปใหม่ หรือ ติดต่อแอดมินหากชำระถูกต้องแล้ว',
    },
    DUPLICATE_TRANSACTION: {
      title: 'เลขอ้างอิงรายการโอนซ้ำ',
      message: fallback || 'รายการโอนนี้ถูกใช้กับสลิปก่อนหน้าแล้ว',
      nextAction: 'อัปโหลดสลิปของรายการโอนอื่น หรือ ติดต่อแอดมิน',
    },
    DATE_MISMATCH: {
      title: 'วันที่ในสลิปไม่ตรงเงื่อนไข',
      message: fallback || 'บริการตรวจสลิปแจ้งว่าวันที่ของรายการไม่ตรงตามเงื่อนไข',
      nextAction: 'ตรวจสลิปให้ตรงกับบิลนี้ หรือ ติดต่อแอดมิน',
    },
    SLIPOK_REJECT: {
      title: 'สลิปไม่ผ่านการตรวจสอบ',
      message: fallback || 'บริการตรวจสลิปไม่สามารถยืนยันสลิปนี้ได้ อาจไม่มี QR code หรือข้อมูลไม่ถูกต้อง',
      nextAction: 'อัปโหลดสลิปตัวจริงที่มี QR code ชัดเจน หรือ ติดต่อแอดมิน',
    },
    EASYSLIP_REJECT: {
      title: 'สลิปไม่ผ่านการตรวจสอบ',
      message: fallback || 'บริการตรวจสลิปไม่สามารถยืนยันสลิปนี้ได้ อาจไม่มี QR code หรือข้อมูลไม่ถูกต้อง',
      nextAction: 'อัปโหลดสลิปตัวจริงที่มี QR code ชัดเจน หรือ ติดต่อแอดมิน',
    },
    SLIP2GO_REJECT: {
      title: 'สลิปไม่ผ่านการตรวจสอบ',
      message: fallback || 'บริการตรวจสลิปไม่สามารถยืนยันสลิปนี้ได้ อาจไม่มี QR code หรือข้อมูลไม่ถูกต้อง',
      nextAction: 'อัปโหลดสลิปตัวจริงที่มี QR code ชัดเจน หรือ ติดต่อแอดมิน',
    },
  };
  if (map[code]) return map[code];
  return {
    title: 'สลิปไม่ผ่านการตรวจสอบ',
    message: fallback || 'บริการตรวจสลิปแจ้งว่าสลิปนี้ไม่ถูกต้องหรือยืนยันไม่ได้',
    nextAction: 'ตรวจยอด บัญชีปลายทาง และ QR code แล้วอัปโหลดใหม่ หากยังไม่ผ่านให้ติดต่อแอดมิน',
  };
}

function buildSlipVerificationNotice({
  initialStatus,
  verifyResult,
  autoVerifyAttempted,
  requireVerification,
  upload,
}) {
  const code = verifyResult?.code || null;
  const provider = verifyResult?.provider || null;
  const fallback = verifyResult?.error || null;
  let title;
  let message;
  let nextAction;
  let severity = 'info';

  if (initialStatus === 'verified') {
    severity = 'success';
    title = 'ชำระเงินสำเร็จ';
    message = verifyResult?.ok
      ? 'ระบบตรวจสอบแล้วว่าสลิปเป็นรายการจริง ยอดและบัญชีปลายทางตรงกับที่ตั้งไว้'
      : 'ระบบรับสลิปและบันทึกการชำระเงินสำเร็จ';
    nextAction = 'บิลถูกตั้งเป็นชำระแล้ว';
  } else if (initialStatus === 'pending') {
    severity = 'pending';
    if (verifyResult?.ok && requireVerification) {
      title = 'สลิปตรวจผ่าน รอแอดมินอนุมัติ';
      message = 'บริการตรวจสลิปยืนยันรายการแล้ว แต่ระบบตั้งค่าให้แอดมินตรวจทานก่อนปิดบิล';
      nextAction = 'รอแอดมินอนุมัติ ระบบจะแจ้งผลเมื่อดำเนินการแล้ว';
    } else if (autoVerifyAttempted) {
      const attemptCount = Array.isArray(verifyResult?.attempts) ? verifyResult.attempts.length : 0;
      const attemptText = attemptCount > 0
        ? ` ระบบได้ลองตรวจผ่านผู้ให้บริการที่ตั้งค่าไว้ ${attemptCount} รายการแล้ว แต่ยังไม่ได้ผลยืนยันที่ปลอดภัย`
        : '';
      const refText = code ? ` รหัสอ้างอิงสำหรับแจ้งแอดมิน: ${code}.` : '';
      title = 'รับสลิปแล้ว ระบบส่งให้แอดมินตรวจ';
      message = `ระบบตรวจสลิปอัตโนมัติยังไม่สามารถยืนยันผลได้ในขณะนี้${attemptText}${refText} สลิปถูกส่งให้แอดมินตรวจสอบแล้ว บิลจะยังไม่ถูกทำเครื่องหมายว่าชำระแล้วจนกว่าแอดมินจะอนุมัติ หากต้องการความช่วยเหลือหรือเร่งตรวจ กรุณาติดต่อแอดมิน/สำนักงานพร้อมเลขบิลและรหัสอ้างอิง`;
      nextAction = 'รอแอดมินตรวจสอบจากคิว Payments ไม่ต้องอัปโหลดซ้ำระหว่างรอตรวจ หากต้องการเร่งด่วนให้ติดต่อแอดมิน/สำนักงาน';
    } else {
      title = 'รับสลิปแล้ว รอแอดมินตรวจสอบ';
      message = 'ระบบยังไม่ได้เปิดหรือยังไม่พร้อมใช้การตรวจสลิปอัตโนมัติ สลิปถูกส่งให้แอดมินตรวจ';
      nextAction = 'รอแอดมินอนุมัติ ระบบจะแจ้งผลเมื่อดำเนินการแล้ว';
    }
  } else {
    severity = 'error';
    const copy = slipRejectCopy(code, fallback);
    title = copy.title;
    message = copy.message;
    nextAction = copy.nextAction;
  }

  return {
    status: initialStatus,
    severity,
    attempted: !!autoVerifyAttempted,
    ok: !!(verifyResult && verifyResult.ok),
    provider,
    code,
    transactionRef: verifyResult?.transRef || null,
    amount: verifyResult?.amount ?? null,
    sender: publicPartyForSlipNotice(verifyResult?.sender),
    receiver: publicPartyForSlipNotice(verifyResult?.receiver),
    transDate: verifyResult?.transDate || null,
    attempts: Array.isArray(verifyResult?.attempts) ? verifyResult.attempts : [],
    title,
    message,
    nextAction,
    canRetry: upload ? upload.remaining > 0 && !upload.hasPending && initialStatus !== 'verified' : null,
  };
}

app.get('/p/bill-qr/:billId', rateLimitQr, async (req, res) => {
  const id = Number(req.params.billId);
  if (!Number.isInteger(id) || id < 1) return res.status(400).end();
  const token = String(req.query.t || '');
  if (!verifyBillQrToken(id, token)) {
    return res.status(403).json({ error: 'invalid or expired token' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, total, status, tenant_id FROM bills
        WHERE id=$1 AND deleted_at IS NULL`,
      [id]
    );
    if (!rows.length) return res.status(404).end();
    const bill = rows[0];
    const format = String(req.query.format || 'png').toLowerCase();
    if (bill.status === 'paid') {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Bill-QR-State', 'paid');
      if (format === 'json' || format === 'payload') {
        return res.status(409).json({
          ok: false,
          error: 'bill is already paid',
          code: 'BILL_ALREADY_PAID',
          status: bill.status,
          paid: true,
          billId: bill.id,
        });
      }
      const rendered = renderPaidBillQrStatusPng();
      res.setHeader('Content-Type', rendered.contentType);
      res.setHeader('X-QR-Renderer', rendered.renderer);
      return res.end(rendered.body);
    }
    if (bill.status !== 'pending' && bill.status !== 'overdue') {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Bill-QR-State', String(bill.status || 'not-payable'));
      return res.status(409).json({
        error: 'bill is not payable',
        code: 'BILL_NOT_PAYABLE',
        status: bill.status,
      });
    }
    const amount = Number(bill.total);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
      return res.status(409).json({ error: 'invalid bill total' });
    }
    const { paymentBlock } = await loadEffectivePaymentBlock();
    if (!paymentBlock.promptpayTarget) return res.status(503).json({ error: 'PromptPay not configured' });
    try { paymentBlock.promptpayTarget = normaliseTarget(paymentBlock.promptpayTarget); }
    catch { return res.status(503).json({ error: 'PromptPay target invalid' }); }
    if (isDemoTarget(paymentBlock.promptpayTarget)) {
      return res.status(503).json({ error: 'PromptPay still on demo target' });
    }
    if (format === 'json' || format === 'payload') {
      const payload = buildPromptPayPayload(paymentBlock.promptpayTarget, amount);
      let dataUrl = null;
      let svg = null;
      let renderer = null;
      let renderError = null;
      try {
        dataUrl = await renderQrDataUrl(paymentBlock.promptpayTarget, amount);
        renderer = 'qrcode';
      } catch (renderErr) {
        renderError = renderErr.message || 'render failed';
        console.error('[public-qr] dataUrl render failed, attempting SVG fallback:', renderError);
        try {
          svg = renderQrSvg(paymentBlock.promptpayTarget, amount);
          renderer = 'qrcode-svg';
        } catch (svgErr) {
          renderError += ' | svg fallback: ' + (svgErr.message || 'failed');
          console.error('[public-qr] svg fallback also failed:', svgErr.message);
        }
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.json({
        ok: true,
        payload,
        dataUrl,
        svg,
        renderer,
        renderError,
        amount,
        billId: bill.id,
        targetLast4: String(paymentBlock.promptpayTarget).slice(-4),
        bankInfo: paymentBlock.bankInfo || null,
        promptpayName: paymentBlock.promptpayName || null,
      });
    }
    const rendered = await renderQrWithFallback(paymentBlock.promptpayTarget, amount);
    res.setHeader('Content-Type', rendered.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Bill-QR-State', bill.status);
    res.setHeader('X-QR-Renderer', rendered.renderer);
    return res.end(rendered.body);
  } catch (err) {
    console.error('public bill qr error:', err);
    return res.status(500).end();
  }
});

app.get('/pay/:billId', (req, res) => {
  const id = Number(req.params.billId);
  if (!Number.isInteger(id) || id < 1) return res.status(400).end();
  res.sendFile(path.join(__dirname, 'project', 'pay.html'));
});

app.get('/api/public/bills/:billId/payment', rateLimitPublicPaymentView, async (req, res) => {
  const id = Number(req.params.billId);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'ลิงก์ชำระเงินไม่ถูกต้อง กรุณาติดต่อแอดมิน' });
  const token = String(req.query.t || '');
  if (!verifyBillPayToken(id, token)) {
    return res.status(403).json({ error: 'ลิงก์ชำระเงินไม่ถูกต้องหรือหมดอายุ กรุณาติดต่อแอดมิน', code: 'INVALID_TOKEN' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.bill_no, b.period, b.rent,
              b.water_prev_reading, b.water_current_reading, b.water_units, b.water_rate, b.water_amount,
              b.elec_prev_reading, b.elec_current_reading, b.elec_units, b.elec_rate, b.elec_amount,
              b.wifi, b.other, b.subtotal, b.vat, b.late_fee, b.total,
              b.due_date, b.status, b.room_id, b.tenant_id,
              t.full_name, t.phone, t.email, t.line_user_id, t.line_oa_id,
              t.current_room_id, t.status AS tenant_status, t.deleted_at AS tenant_deleted_at
         FROM bills b
         LEFT JOIN tenants t ON t.id = b.tenant_id
        WHERE b.id=$1 AND b.deleted_at IS NULL
        LIMIT 1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'ไม่พบบิลนี้ กรุณาติดต่อแอดมิน' });
    const bill = rows[0];
    if (!bill.tenant_id || bill.tenant_deleted_at || !publicBillPayTenantStatusAllowed(bill.tenant_status)) {
      return res.status(409).json({
        error: 'บิลนี้ยังไม่ได้ผูกกับผู้เช่าที่ใช้งานอยู่ กรุณาติดต่อแอดมิน',
        code: 'BILL_NOT_LINKED_TO_ACTIVE_TENANT',
      });
    }
    const flags = await features.load(pool);
    const lateFeePolicy = lateFeePolicyFromFlags(flags);
    const { config, paymentBlock } = await loadEffectivePaymentBlock();
    const billTotal = Number(bill.total);
    const payable = bill.status === 'pending' || bill.status === 'overdue';
    const attempts = await loadBillPaymentAttemptSummary(pool, id, bill.tenant_id);
    const slipBlock = publicSlipBlockReason({
      flags,
      payable,
      paid: bill.status === 'paid',
      attempts,
    });
    // Surface the building name + phone so the public pay page can show
    // a concrete escalation contact in error messages instead of the
    // vague "ติดต่อแอดมิน". Without this, tenants who hit a problem
    // (link expired, slip rejected, network blip) had no idea where to
    // get help. Building data already lives in config — just exposing it.
    const buildingInfo = {
      name: (config && config.building && config.building.name) || null,
      phone: (config && config.building && config.building.phone) || null,
    };
    const qrUsable = payable
      && Number.isFinite(billTotal) && billTotal > 0 && billTotal <= MAX_AMOUNT
      && !!paymentBlock.promptpayTarget
      && !isDemoTarget(paymentBlock.promptpayTarget);
    let qrUrl = null;
    if (qrUsable) {
      try {
        normaliseTarget(paymentBlock.promptpayTarget);
        const qrVersion = `${id}-${String(bill.status || 'pending')}-${Date.now()}`;
        qrUrl = `/p/bill-qr/${encodeURIComponent(id)}?t=${encodeURIComponent(signBillQrToken(id))}&v=${encodeURIComponent(qrVersion)}`;
      } catch {
        qrUrl = null;
      }
    }
    res.json({
      ok: true,
      bill: {
        id: bill.id,
        billNo: bill.bill_no,
        period: bill.period,
        rent: Number(bill.rent) || 0,
        waterUnits: Number(bill.water_units) || 0,
        waterRate: Number(bill.water_rate) || 0,
        waterAmount: Number(bill.water_amount) || 0,
        waterPrevReading: numOrNull(bill.water_prev_reading),
        waterCurrentReading: numOrNull(bill.water_current_reading),
        elecUnits: Number(bill.elec_units) || 0,
        elecRate: Number(bill.elec_rate) || 0,
        elecAmount: Number(bill.elec_amount) || 0,
        elecPrevReading: numOrNull(bill.elec_prev_reading),
        elecCurrentReading: numOrNull(bill.elec_current_reading),
        wifi: Number(bill.wifi) || 0,
        other: parseBillOtherItems(bill.other),
        subtotal: Number(bill.subtotal) || 0,
        vat: Number(bill.vat) || 0,
        lateFee: Number(bill.late_fee) || 0,
        lateFeeCalculation: buildLateFeeCalculation(bill, lateFeePolicy),
        total: billTotal,
        dueDate: bill.due_date,
        status: bill.status,
        roomId: bill.room_id,
        lineItems: buildOnlineBillLineItems(bill, lateFeePolicy),
      },
      payment: paymentBlock,
      building: buildingInfo,
      channels: {
        slip: !slipBlock,
        qr: !!qrUrl,
        bank: payable && !!(paymentBlock.bankInfo && paymentBlock.bankInfo.account),
        wallet: payable && !!(paymentBlock.walletInfo && paymentBlock.walletInfo.phone),
      },
      upload: {
        ...attempts,
        canUpload: !slipBlock,
        blocked: slipBlock,
      },
      paid: bill.status === 'paid',
      qrUrl,
    });
  } catch (err) {
    console.error('public bill payment info error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/public/bills/:billId/payments', rateLimitPublicPaymentUpload, sameOrigin, async (req, res) => {
  const id = Number(req.params.billId);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'ลิงก์ชำระเงินไม่ถูกต้อง กรุณาติดต่อแอดมิน' });
  const token = String(req.query.t || '');
  if (!verifyBillPayToken(id, token)) {
    return res.status(403).json({ error: 'ลิงก์ชำระเงินไม่ถูกต้องหรือหมดอายุ กรุณาติดต่อแอดมิน', code: 'INVALID_TOKEN' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.total, b.status, b.tenant_id,
              t.full_name, t.phone, t.email, t.line_user_id, t.line_oa_id,
              t.current_room_id, t.status AS tenant_status, t.locale
         FROM bills b
         JOIN tenants t ON t.id = b.tenant_id
        WHERE b.id=$1 AND b.deleted_at IS NULL AND t.deleted_at IS NULL
        LIMIT 1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'ไม่พบบิลนี้ กรุณาติดต่อแอดมิน' });
    const row = rows[0];
    if (!publicBillPayTenantStatusAllowed(row.tenant_status)
        || (row.tenant_status === 'active' && !row.current_room_id)) {
      return res.status(403).json({
        error: 'บิลนี้ไม่ได้อยู่กับผู้เช่าที่ใช้งานอยู่ กรุณาติดต่อแอดมิน',
        code: 'TENANT_NOT_ACTIVE',
      });
    }
    const flags = await features.load(pool);
    if (!flags.slipUpload || !flags.slipUpload.enabled) {
      return res.status(503).json({ error: 'ระบบยังไม่เปิดรับอัปโหลดสลิปออนไลน์ กรุณาติดต่อแอดมิน' });
    }
    const payable = row.status === 'pending' || row.status === 'overdue';
    const attempts = await loadBillPaymentAttemptSummary(pool, id, row.tenant_id);
    const slipBlock = publicSlipBlockReason({
      flags,
      payable,
      paid: row.status === 'paid',
      attempts,
    });
    if (slipBlock) {
      const status = slipBlock.code === 'SLIP_UPLOAD_LIMIT_REACHED' ? 429 : 409;
      return res.status(status).json({
        error: slipBlock.message,
        code: slipBlock.code,
        upload: {
          ...attempts,
          canUpload: false,
          blocked: slipBlock,
        },
      });
    }
    req.features = flags;
    req.tenant = {
      tenant_id: row.tenant_id,
      full_name: row.full_name,
      phone: row.phone,
      email: row.email,
      line_user_id: row.line_user_id,
      line_oa_id: row.line_oa_id,
      current_room_id: row.current_room_id,
      status: row.tenant_status,
      locale: row.locale,
    };
    req.publicPayment = {
      source: 'public_pay_link',
      maxAttempts: PUBLIC_SLIP_UPLOAD_MAX_ATTEMPTS,
      attemptNo: attempts.used + 1,
      previousAttempts: attempts,
    };
    req.body = {
      ...(req.body || {}),
      billId: id,
      amount: Number((req.body || {}).amount || row.total),
    };
    return tenantPaymentUploadHandler(req, res);
  } catch (err) {
    console.error('public bill slip upload error:', err);
    return res.status(500).json({
      error: 'อัปโหลดสลิปล้มเหลว กรุณาลองใหม่อีกครั้งหรือติดต่อแอดมิน',
      code: 'UPLOAD_FAILED',
    });
  }
});

// GET /api/tenant/bills/:id/qr — tenant-owned PromptPay QR generated from
// the stored bill row. This avoids trusting a browser-side `amount=` query:
// the amount encoded into the QR is always bills.total for that bill.
app.get('/api/tenant/bills/:id/qr', rateLimitQr, requireTenant, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'invalid id' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, total, status, tenant_id
         FROM bills
        WHERE id=$1 AND deleted_at IS NULL`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'bill not found' });
    const bill = rows[0];
    // Orphan bill (tenant_id IS NULL) — same handling as /api/tenant/payments
    // and /api/tenant/pay-readiness so the tenant sees a clear "ติดต่อ
    // เจ้าหน้าที่" message instead of "not your bill" (which implies they
    // tried to peek at someone else's QR — confusing for the actual victim
    // of an unattached bill).
    if (!bill.tenant_id) {
      return res.status(403).json({
        error: 'บิลนี้ยังไม่ได้ผูกกับผู้เช่า — กรุณาติดต่อเจ้าหน้าที่',
        code: 'BILL_NOT_LINKED',
      });
    }
    if (Number(bill.tenant_id) !== Number(req.tenant.tenant_id)) {
      return res.status(403).json({ error: 'not your bill' });
    }
    const format = String(req.query.format || 'png').toLowerCase();
    const setQrNoStoreHeaders = (state) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (state) res.setHeader('X-Bill-QR-State', String(state));
    };
    if (bill.status === 'paid') {
      setQrNoStoreHeaders('paid');
      if (format === 'json' || format === 'payload') {
        return res.status(409).json({
          ok: false,
          error: 'bill is already paid',
          code: 'BILL_ALREADY_PAID',
          status: bill.status,
          paid: true,
          billId: bill.id,
        });
      }
      const rendered = renderPaidBillQrStatusPng();
      res.setHeader('Content-Type', rendered.contentType);
      res.setHeader('X-QR-Renderer', rendered.renderer);
      return res.end(rendered.body);
    }
    if (bill.status !== 'pending' && bill.status !== 'overdue') {
      setQrNoStoreHeaders(bill.status || 'not-payable');
      return res.status(409).json({
        error: 'bill is not payable',
        code: 'BILL_NOT_PAYABLE',
        status: bill.status,
      });
    }
    const amount = Number(bill.total);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
      setQrNoStoreHeaders(bill.status || 'invalid-total');
      return res.status(409).json({
        error: 'bill amount cannot be encoded as PromptPay QR',
        code: 'INVALID_BILL_TOTAL',
      });
    }

    const { paymentBlock } = await loadEffectivePaymentBlock();
    if (!paymentBlock.promptpayTarget) {
      setQrNoStoreHeaders(bill.status);
      return res.status(503).json({
        error: 'PromptPay is not configured',
        code: 'PROMPTPAY_NOT_CONFIGURED',
      });
    }
    try {
      paymentBlock.promptpayTarget = normaliseTarget(paymentBlock.promptpayTarget);
    } catch (err) {
      setQrNoStoreHeaders(bill.status);
      return res.status(503).json({
        error: 'PromptPay target is invalid',
        code: 'PROMPTPAY_INVALID_CONFIG',
      });
    }
    // Refuse to render a QR for the bundled demo PromptPay account.
    // Without this guard a fresh deploy ships with a QR that points at a
    // hard-coded test target — tenants would scan and the transfer would
    // go to nobody. Catch it here so the failure is loud + actionable
    // ("admin: go set PromptPay") instead of silent + financial.
    if (isDemoTarget(paymentBlock.promptpayTarget)) {
      setQrNoStoreHeaders(bill.status);
      return res.status(503).json({
        error: 'หอพักยังใช้ PromptPay demo — แจ้งเจ้าหน้าที่ให้ตั้งบัญชีจริงก่อน',
        code: 'PROMPTPAY_DEMO',
      });
    }

    // Two response shapes:
    //   format=json  → { ok, payload, dataUrl, target, amount }
    //                  payload is the raw EMV string — tenant can paste it
    //                  into a banking app even if the rendered PNG fails to
    //                  load (some apps support "paste payload to pay"). The
    //                  dataUrl is best-effort: if QR rendering throws, the
    //                  payload field still lets the client recover by
    //                  rendering with a browser-side QR library OR by
    //                  showing a copyable text fallback.
    //   default      → image/png (legacy path, unchanged)
    if (format === 'json' || format === 'payload') {
      // Build the EMV payload first — that's the durable contract value
      // (a Thai banking-app-readable string) that doesn't require the
      // QR rendering pipeline. If buildPayload itself throws (very rare —
      // would mean promptpay-qr is broken), fall through to the catch
      // below for a clean 500.
      const payload = buildPromptPayPayload(paymentBlock.promptpayTarget, amount);
      let dataUrl = null;
      let svg = null;
      let renderError = null;
      let renderer = null;
      try {
        dataUrl = await renderQrDataUrl(paymentBlock.promptpayTarget, amount);
        renderer = 'qrcode';
      } catch (renderErr) {
        // Primary renderer (qrcode → PNG/dataURL) broke. Try the SVG
        // fallback so the JSON response still carries a renderable image
        // for the client to paint without resorting to copy-paste text.
        renderError = renderErr.message || 'render failed';
        console.error('[qr] dataUrl render failed, attempting SVG fallback:', renderError);
        try {
          svg = renderQrSvg(paymentBlock.promptpayTarget, amount);
          renderer = 'qrcode-svg';
        } catch (svgErr) {
          // Both renderers down — the payload field below is the last
          // resort (paste-to-pay). Surface a richer renderError so the
          // health check / Sentry can correlate.
          renderError += ' | svg fallback: ' + (svgErr.message || 'failed');
          console.error('[qr] svg fallback also failed:', svgErr.message);
        }
      }
      setQrNoStoreHeaders(bill.status);
      return res.json({
        ok: true,
        payload,
        dataUrl,                            // null when rendering failed
        svg,                                // populated when SVG fallback ran
        renderer,                           // 'qrcode' | 'qrcode-svg' | null
        renderError,                        // null on primary success
        target: paymentBlock.promptpayTarget,
        amount,
        billId: bill.id,
        // Hand the bank-info card to the client so the fallback UI can
        // render manual-transfer details in the same response — no
        // second round-trip needed when QR fails.
        bankInfo: paymentBlock.bankInfo || null,
        promptpayName: paymentBlock.promptpayName || null,
      });
    }

    // Default PNG path uses the dual-engine wrapper. If the primary qrcode
    // package fails (PNG encoder broke, OOM, native binding issue), the
    // wrapper transparently falls through to qrcode-svg and returns an SVG
    // body with `image/svg+xml` Content-Type. Browsers render either format
    // in <img> tags, so the tenant UI doesn't have to branch on the type.
    const rendered = await renderQrWithFallback(paymentBlock.promptpayTarget, amount);
    res.setHeader('Content-Type', rendered.contentType);
    setQrNoStoreHeaders(bill.status);
    // Expose which renderer answered so admins debugging "why is the QR an
    // SVG today?" can grep response headers to see the primary failure.
    res.setHeader('X-QR-Renderer', rendered.renderer);
    return res.end(rendered.body);
  } catch (err) {
    console.error('tenant bill qr error:', err);
    const msg = String(err.message || '');
    if (msg.startsWith('PromptPay target')) {
      return res.status(503).json({
        error: 'PromptPay configuration is invalid',
        code: 'PROMPTPAY_INVALID_CONFIG',
      });
    }
    return res.status(500).json({ error: 'qr render failed', code: 'QR_ERROR' });
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
                locked_at,
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

// GET /api/tenant/contract/:id/pdf — tenant views/downloads their OWN signed
// contract PDF. Replaces the "ติดต่อสำนักงานเพื่อรับ PDF" friction:
// tenant can now self-serve from the portal. Inline preview is the default;
// ?download=1 is reserved for explicit downloads. Ownership is enforced via
// tenant_id match (a guessed contract id can't fetch someone else's PDF),
// and we require locked_at (signed) so unfinished drafts don't leak.
app.get('/api/tenant/contract/:id/pdf', requireTenant, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  let acquired = false;
  try {
    // Same SELECT shape the admin /api/contracts/:id/pdf uses so the
    // renderer below gets the fields it expects (tenant_address, emergency
    // contacts, citizen_id_tail). Falls back to legacy columns on
    // pre-migration deploys (42703).
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
      if (err.code !== '42703') throw err;
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
    // Ownership check — must match the logged-in tenant.
    if (Number(contract.tenant_id) !== Number(req.tenant.tenant_id)) {
      return res.status(403).json({ error: 'not your contract' });
    }
    // Require locked_at so tenants can't download a draft (un-approved)
    // PDF that doesn't yet reflect final terms.
    if (!contract.locked_at) {
      return res.status(409).json({
        error: 'สัญญายังไม่ได้รับการอนุมัติ — รอเจ้าของหอพักตรวจสอบ',
        code: 'NOT_LOCKED',
      });
    }

    // Building info
    let building = { name: 'ที่พักของคุณ' };
    try {
      const cfgQ = await pool.query(
        `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
      );
      const cfg = cfgQ.rows[0]?.value || {};
      if (cfg.building) building = { ...building, ...cfg.building };
    } catch { /* keep default */ }

    // Room enrichment (rooms_v2 → blob fallback) — same logic as admin path
    // but simplified: tenant doesn't need template override or raw room source.
    let room = { id: contract.room_id };
    if (contract.room_id) {
      try {
        const rv2 = await pool.query(
          `SELECT room_code, room_type, floor, room_no,
                  wifi_fee, view_type, has_balcony, has_parking, has_kitchen, has_ac,
                  size_sqm, bed_count
             FROM rooms_v2 WHERE room_code=$1 AND deleted_at IS NULL LIMIT 1`,
          [contract.room_id]
        );
        if (rv2.rows.length) {
          const r = rv2.rows[0];
          const amenities = [];
          if (r.has_ac)      amenities.push('แอร์');
          if (r.has_balcony) amenities.push('ระเบียง');
          if (r.has_kitchen) amenities.push('ห้องครัว');
          if (r.has_parking) amenities.push('ที่จอดรถ');
          room = {
            id: r.room_code, type: r.room_type, floor: r.floor, roomNo: r.room_no,
            size: r.size_sqm, bedCount: r.bed_count, view: r.view_type,
            amenities, wifiFee: Number(r.wifi_fee || 0),
          };
        }
      } catch (err) {
        if (err.code !== '42P01') console.warn('[tenant contract pdf] rooms_v2:', err.message);
      }
    }

    // Template — use the contract's bound template, or the system default.
    let template = null;
    if (contract.locked_at && contract.terms_template_snapshot) {
      template = contract.terms_template_snapshot;
    }
    if (!template && contract.template_id) {
      try {
        // enabled=TRUE: a disabled template must not keep printing just
        // because a contract still points at it — fall through to default.
        const t = await pool.query(
          `SELECT mode, clauses, sections, variables FROM contract_templates
            WHERE id=$1 AND deleted_at IS NULL AND enabled=TRUE LIMIT 1`,
          [contract.template_id]
        );
        if (t.rows.length) template = t.rows[0];
      } catch { /* fall through */ }
    }
    if (!template) {
      try {
        const t = await pool.query(
          `SELECT mode, clauses, sections, variables FROM contract_templates
            WHERE is_default=TRUE AND deleted_at IS NULL AND enabled=TRUE LIMIT 1`
        );
        if (t.rows.length) template = t.rows[0];
      } catch { /* pre-migration */ }
    }

    // Online signature embed
    let tenantSigBuf = null;
    if (contract.signature_image_id) {
      try {
        const fQ = await pool.query(
          'SELECT * FROM file_uploads WHERE id=$1 LIMIT 1',
          [contract.signature_image_id]
        );
        if (fQ.rows.length) tenantSigBuf = await storage.readFile(fQ.rows[0]);
      } catch (err) {
        console.warn('[tenant contract pdf] sig load failed:', err.message);
      }
    }

    // Feature-derived constants. dueDay now lives in config.notify.dueOnDay
    // (one canonical source — manual billing + scheduler + contract PDF all
    // read the same key) so admin doesn't tune two values that mean the same.
    let lateFeeRate = 1.5;
    let dueDay = 15;
    try {
      const flags = await features.load(pool);
      if (Number.isFinite(Number(flags?.lateFee?.ratePctPerMonth))) {
        lateFeeRate = Number(flags.lateFee.ratePctPerMonth);
      }
      const cfgRow = await pool.query(`SELECT value FROM app_data WHERE key='baankarn_config_v1'`);
      const cfg = cfgRow.rows[0]?.value || {};
      if (Number.isFinite(Number(cfg?.notify?.dueOnDay))) {
        dueDay = Number(cfg.notify.dueOnDay);
      }
    } catch { /* keep defaults */ }

    // For a LOCKED (signed) contract, prefer the financial terms captured in the
    // signing snapshot over the live config — the PDF must reflect what the
    // tenant agreed to, not a later policy change. Older v1 snapshots have no
    // financials and fall back to the live values above.
    const snapFin = contract.locked_at
      && contract.terms_template_snapshot
      && contract.terms_template_snapshot.financials;
    if (snapFin) {
      const snapDueDay = Number(snapFin.dueDay);
      const snapLateFeeRate = Number(snapFin.lateFeeRate);
      if (Number.isFinite(snapDueDay) && snapDueDay >= 1 && snapDueDay <= 28) {
        dueDay = Math.floor(snapDueDay);
      }
      if (Number.isFinite(snapLateFeeRate) && snapLateFeeRate >= 0) {
        lateFeeRate = snapLateFeeRate;
      }
    }

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

    await acquirePdfSlot();
    acquired = true;
    const filename = safeDownloadFilename(`contract-${contract.contract_no || id}`, `contract-${id}`, 'pdf');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Disposition',
      `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${filename}"`
    );
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
    console.error('tenant contract pdf error:', err);
    if (!res.headersSent) {
      const code = String(err.message || '').includes('PDF queue timeout') ? 503 : 500;
      res.status(code).json({ error: 'internal error', code: code === 503 ? 'BUSY' : 'PDF_ERROR' });
    }
    else res.end();
  } finally {
    if (acquired) releasePdfSlot();
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
    const flags = await features.load(pool).catch(() => ({}));
    const lateFeePolicy = lateFeePolicyFromFlags(flags);
    const { rows } = await pool.query(
      `SELECT id, bill_no, period, rent,
              water_prev_reading, water_current_reading, water_units, water_rate, water_amount,
              elec_prev_reading, elec_current_reading, elec_units, elec_rate, elec_amount, wifi, other,
              subtotal, vat, late_fee, total,
              due_date, status, paid_at, created_at
         FROM bills
         WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const bills = rows.map((row) => ({
      ...row,
      late_fee_calculation: buildLateFeeCalculation(row, lateFeePolicy),
    }));
    res.json({ ok: true, bills, limit, offset });
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
    // Block PDF download for voided bills. Without this guard the PDF
    // renderer happily generated a full invoice with PromptPay QR for
    // a void bill — tenant could scan, pay, and the transaction landed
    // against nothing. The void path already notifies the tenant so
    // they shouldn't be requesting this PDF; refusing closes the loop.
    if (b.status === 'void') {
      return res.status(410).json({
        error: 'บิลนี้ถูกยกเลิกแล้ว ไม่สามารถดาวน์โหลด PDF ได้',
        code: 'BILL_VOID',
      });
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
      billing.buildUtilityItem('ค่าน้ำ', storedUtilityUsage(b, 'water'), Number(b.water_rate) || 0, Number(b.water_amount) || 0),
      billing.buildUtilityItem('ค่าไฟฟ้า', storedUtilityUsage(b, 'elec'), Number(b.elec_rate) || 0, Number(b.elec_amount) || 0),
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
      waterPrevReading: numOrNull(b.water_prev_reading),
      waterCurrentReading: numOrNull(b.water_current_reading),
      elecUnits: Number(b.elec_units) || 0,
      elecRate: Number(b.elec_rate) || 0,
      elecAmount: Number(b.elec_amount) || 0,
      elecPrevReading: numOrNull(b.elec_prev_reading),
      elecCurrentReading: numOrNull(b.elec_current_reading),
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
    // Match by tenant_id (durable across phone changes). Legacy rows created
    // before tenant_id stamping may fall back to phone, but only when the row
    // has no tenant_id and belongs to the tenant's current room; otherwise
    // family/shared phones can leak another tenant's ticket history.
    const { rows } = await pool.query(
      `SELECT id, ticket_no, room_id, category, priority, status, title, description,
              created_at, completed_at, rating, rating_comment
         FROM maintenance_tickets
         WHERE tenant_id = $1
            OR (tenant_id IS NULL AND tenant_phone = $2 AND $2 <> '' AND room_id = $3)
         ORDER BY created_at DESC LIMIT $4 OFFSET $5`,
      [req.tenant.tenant_id, req.tenant.phone || '', req.tenant.current_room_id || '', limit, offset]
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
    // dangling bill metadata. Do not return slip_url here: old rows can
    // contain base64 data URLs, and even normal /files/<id> URLs are PII
    // handles. The tenant UI fetches the actual image lazily through the
    // ownership-checked preview endpoint below.
    const { rows } = await pool.query(
      `SELECT p.id, p.bill_id, p.amount, p.method,
              p.status, p.verified_at, p.rejected_reason, p.created_at,
              (sf.id IS NOT NULL
               AND sf.category='slip'
               AND sf.uploaded_by IN ('tenant:' || p.tenant_id::text, 'public-pay:' || p.tenant_id::text)
               AND lower(COALESCE(sf.mime_type, '')) IN ('image/jpeg','image/png','image/webp')) AS has_slip,
              b.bill_no, b.period
         FROM payments p
         LEFT JOIN file_uploads sf ON p.slip_url = '/files/' || sf.id::text
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

// Tenant slip preview. This intentionally does not reuse /files/:id because
// /files forces Content-Disposition: attachment for sensitive categories.
// The UI needs an inline image inside a modal, so this endpoint re-checks:
//   1) the payment belongs to the current tenant,
//   2) the slip_url points at a canonical file_uploads row,
//   3) the file is an image slip uploaded by the same tenant, either from
//      the tenant portal or that tenant's tokenized public-pay link.
app.get('/api/tenant/payments/:id/slip', requireTenant, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  try {
    const { rows } = await pool.query(
      `SELECT p.id AS payment_id, p.slip_url,
              f.id AS file_id, f.category, f.filename, f.mime_type, f.uploaded_by, f.storage
         FROM payments p
         LEFT JOIN file_uploads f
           ON p.slip_url = '/files/' || f.id::text
        WHERE p.id=$1 AND p.tenant_id=$2`,
      [id, req.tenant.tenant_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const f = rows[0];
    const allowedUploaders = new Set([
      `tenant:${req.tenant.tenant_id}`,
      `public-pay:${req.tenant.tenant_id}`,
    ]);
    if (!f.file_id || f.category !== 'slip' || !allowedUploaders.has(f.uploaded_by)) {
      return res.status(404).json({ error: 'slip not found' });
    }
    const mime = String(f.mime_type || '').toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
      return res.status(415).json({ error: 'unsupported slip type' });
    }
    const buf = await storage.readFile(f);
    if (!buf) return res.status(404).json({ error: 'slip not found' });
    const safeName = String(f.filename || `slip-${id}`).replace(/[^\w.\-]/g, '_').slice(0, 80);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.end(buf);
  } catch (err) {
    console.error('tenant slip preview error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
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
    // Authorization — only the tenant whose ticket this is may rate it.
    //
    // IDOR fix: previously the OR clause allowed match-by-phone as a
    // fallback. Couples or family members sharing a phone could rate
    // each other's tickets that way — tenant A's phone matches a ticket
    // submitted by tenant B (same phone, different tenant_id), and the
    // OR clause passed. Phone-only match is now scoped to tickets that
    // never got tenant_id stamped (legacy/orphan rows), so identified
    // tenants can only rate their OWN tickets.
    const { rows } = await pool.query(
      `UPDATE maintenance_tickets
         SET rating=$1, rating_comment=$2, updated_at=NOW()
         WHERE id=$3
           AND (
             tenant_id = $4
            OR (tenant_id IS NULL AND tenant_phone = $5 AND $5 <> '' AND room_id = $6)
            )
            AND status='completed'
            AND rating IS NULL
          RETURNING ticket_no, rating, rating_comment, completed_at`,
      [rating, comment, id, req.tenant.tenant_id, req.tenant.phone || '', req.tenant.current_room_id || '']
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
        category: 'maintenance',
        subject: `⭐ ผู้เช่าให้คะแนนงานซ่อม ${rating}/5`,
        text: `งานซ่อม ${rows[0].ticket_no} ได้รับคะแนน ${rating}/5${comment ? `\nความเห็นผู้เช่า: "${comment}"` : ''}`,
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
//
// All /api/bills/* endpoints (GET list, POST create, PUT /:id/void,
// POST /:id/unmark-paid, POST /render, plus the helpers in
// routes/bills-extras.js) live in routes/bills-extras.js so the entire
// bill surface is in one file. See routes/index.js for the mount.
//
// Helper functions that travelled with them: getRenderBillId,
// buildStoredBillPdfObject, loadRecurringFor, notifyBillVoided.
//
// Helpers that stayed here (because non-bill endpoints also use them):
// acquirePdfSlot / releasePdfSlot, loadBillingConfig,
// loadEffectivePaymentBlock, buildEffectivePaymentBlock, sanitizeError —
// they're handed to bills-extras.js via the routes ctx object.

// === v2: Payments + slip upload ===========================================
// Tenant uploads a slip via /api/tenant/payments (gated by slipUpload).
// Admin verifies via /api/payments/:id/verify.

async function ensureSlipUpload(req, res, next) {
  const flags = await features.load(pool);
  if (!flags.slipUpload || !flags.slipUpload.enabled) {
    return res.status(503).json({
      error: 'ระบบยังไม่เปิดรับอัปโหลดสลิปออนไลน์ กรุณาติดต่อแอดมิน',
      code: 'SLIP_UPLOAD_DISABLED',
    });
  }
  req.features = flags;
  next();
}

async function tenantPaymentUploadHandler(req, res) {
  const b = req.body || {};
  const billId = Number(b.billId);
  if (!Number.isInteger(billId) || billId < 1) return res.status(400).json({ error: 'billId required' });
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'invalid amount' });
  if (!b.slip) return res.status(400).json({ error: 'slip image required' });
  try {
    const billRes = await pool.query(
      `SELECT id, total, late_fee, status, tenant_id FROM bills WHERE id=$1 AND deleted_at IS NULL`,
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
    // input) — bill flips to 'paid' for a fraction of what's due.
    //
    // R2-followup — accept the payment in two tiers:
    //   - tier='exact'     → amount ≈ current total (incl. late_fee)
    //   - tier='principal' → amount ≈ subtotal+vat (tenant paid before
    //                        scheduler.tickLateFee added late_fee)
    // Both are legitimate. validatePaymentAmount also reports the
    // outstanding late_fee so the admin queue can decide whether to waive
    // (good-faith principal) or hold for the full amount.
    const billTotal = Number(billRes.rows[0].total) || 0;
    const billLateFee = Number(billRes.rows[0].late_fee) || 0;
    const amountCheck = billing.validatePaymentAmount({
      amount,
      total: billTotal,
      lateFee: billLateFee,
    });
    if (!amountCheck.ok) {
      return res.status(400).json({
        error: `จำนวนเงินไม่ตรงกับยอดบิล — ยอดบิลปัจจุบัน ฿${billTotal.toLocaleString('th-TH', { minimumFractionDigits: 2 })}${
          billLateFee > 0
            ? ` (ค่าเช่า+ค่าน้ำไฟ ฿${amountCheck.principal.toLocaleString('th-TH', { minimumFractionDigits: 2 })} + ค่าปรับล่าช้า ฿${billLateFee.toLocaleString('th-TH', { minimumFractionDigits: 2 })})`
            : ''
        } แต่ผู้เช่าระบุ ฿${amount.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`,
        code: 'AMOUNT_NOT_BILL_TOTAL',
        billTotal,
        billPrincipal: amountCheck.principal,
        billLateFee,
        submittedAmount: amount,
      });
    }
    // Stash tier + outstanding late_fee for the verify path + audit log.
    // When tier==='principal' and outstanding > 0, the verified payment
    // leaves a residual debt that admin can decide to waive or pursue.
    const amountTier = amountCheck.tier;
    const lateFeeOutstandingAtUpload = amountCheck.lateFeeOutstanding;
    let finalAmountCheck = amountCheck;
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
    const attemptsBeforeUpload = await loadBillPaymentAttemptSummary(pool, billId, req.tenant.tenant_id);
    const slipBlock = publicSlipBlockReason({
      flags: req.features,
      payable: true,
      paid: false,
      attempts: attemptsBeforeUpload,
    });
    if (slipBlock) {
      const status = slipBlock.code === 'SLIP_UPLOAD_LIMIT_REACHED' ? 429 : 409;
      return res.status(status).json({
        error: slipBlock.message,
        code: slipBlock.code,
        upload: {
          ...attemptsBeforeUpload,
          canUpload: false,
          blocked: slipBlock,
        },
      });
    }
    if (req.publicPayment) {
      req.publicPayment.attemptNo = attemptsBeforeUpload.used + 1;
      req.publicPayment.previousAttempts = attemptsBeforeUpload;
    }
    // Hash the actual slip bytes BEFORE saving so dedup works (prior version
    // hashed the URL+size which were always unique → unique index never
    // triggered).
    const rawBuf = Buffer.from(String(b.slip || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
    const slipHash = cryptoSvc.hmac(rawBuf);
    const dup = await pool.query(
      `SELECT id FROM payments
        WHERE slip_hash=$1 AND status IN ('pending','verified')
        LIMIT 1`,
      [slipHash]
    );
    if (dup.rows.length) {
      return res.status(409).json({
        error: 'สลิปนี้ถูกใช้ไปแล้ว — ไม่สามารถส่งซ้ำ',
        code: 'DUPLICATE_SLIP_HASH',
      });
    }
    // Cross-flow replay guard: the same bank-slip image already accepted as a
    // BOOKING deposit must not be reused to "pay" a real bill (the bill-pay
    // dedup above only scans the payments table). Booking deposits live in the
    // bookings table with their own deposit_slip_hash, so check it too.
    const dupBookingSlip = await pool.query(
      `SELECT external_id FROM bookings WHERE deposit_slip_hash=$1 LIMIT 1`,
      [slipHash]
    );
    if (dupBookingSlip.rows.length) {
      return res.status(409).json({
        error: 'สลิปนี้ถูกใช้เป็นมัดจำการจองไปแล้ว — ไม่สามารถนำมาชำระบิลซ้ำ',
        code: 'DUPLICATE_SLIP_HASH',
      });
    }

    const slip = await storage.saveBase64({
      pool,
      category: 'slip',
      dataUrl: b.slip,
      refId: String(billId),
      uploadedBy: req.publicPayment
        ? `public-pay:${req.tenant.tenant_id}`
        : `tenant:${req.tenant.tenant_id}`,
      maxBytes: features.slipMaxBytes(req.features),
      allowedMimes: req.features.slipUpload.allowedMimes || ['image/jpeg', 'image/png', 'image/webp'],
    });

    // === Auto-verify the slip via configured provider (SlipOK/EasySlip/Slip2Go) ==
    // When slipUpload.autoVerify is on AND a provider key is configured,
    // we send the slip to the provider for instant validation BEFORE
    // touching the DB. The provider returns the bank's transaction
    // reference + actual amount + receiver account. We cross-check:
    //   1) amount ±1฿ vs bill.total
    //   2) receiver account tail vs configured receiver channels
    //      (PromptPay, bank account, TrueMoney Wallet) so a slip paid to
    //      someone else's account is rejected while every advertised
    //      dorm receiver remains valid
    //   3) transaction_ref unique in DB (catches replay even when image
    //      bytes differ — re-screenshot, crop, recompress)
    // All three must pass for auto-verify; one mismatch → status='rejected'
    // with a tenant-facing reason.
    const slipVerifier = require('./services/slipVerifier');
    let verifyResult = null;
    let autoVerifyAttempted = false;
    let effectivePaymentBlock = null;
    let effectivePromptpayTarget = null;
    if (slipVerifier.isConfigured(req.features)) {
      autoVerifyAttempted = true;
      try {
        const { paymentBlock } = await loadEffectivePaymentBlock();
        effectivePaymentBlock = paymentBlock;
        let ppTarget = null;
        let promptpayConfigError = null;
        if (paymentBlock.promptpayTarget) {
          try {
            ppTarget = normaliseTarget(paymentBlock.promptpayTarget);
            effectivePromptpayTarget = ppTarget;
          } catch (err) {
            promptpayConfigError = 'PromptPay target is invalid';
          }
        }
        const extraTargets = paymentBlockReceiverTargetEntries(paymentBlock)
          .filter((target) => target.method !== 'promptpay');
        if (!ppTarget && extraTargets.length === 0) {
          verifyResult = {
            ok: false,
            error: promptpayConfigError
              ? `${promptpayConfigError}, and no bank/TrueMoney receiver is configured for fallback verification`
              : 'No PromptPay, bank account, or TrueMoney Wallet receiver is configured for verification',
            code: 'NOT_CONFIGURED',
            attempts: [],
          };
        }
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
        if (!verifyResult) {
          // The invoice can advertise multiple receiver channels (PromptPay,
          // bank transfer, TrueMoney Wallet). Tenants may pay any visible
          // channel, so every configured receiver tail must be accepted by
          // auto-verify to avoid false RECEIVER_MISMATCH rejections.
          //
          // R2-followup — `expected.amount` is the tenant-submitted amount
          // (already cross-checked against bill total OR principal by
          // validatePaymentAmount above). Using billTotal here would fail
          // the slip provider's amount-match when the tenant legitimately
          // paid the principal before late_fee accrued. The submitted
          // `amount` is the value actually on the slip's QR, so it's what
          // the provider's amount field will match against.
          verifyResult = await slipVerifier.verifyWithFallback(
            rawBuf,
            {
              amount,
              billId,
              promptpayTarget: ppTarget || null,
              additionalReceiverTargets: extraTargets,
              // Operator hardening opt-ins (features.slipUpload.*):
              //   providerReceiverCheck → ask the provider to ALSO verify the
              //     receiver with the FULL account it has registered (our
              //     local tail-match stays canonical either way).
              //   strictReceiverTail → a tail match on <6 digits parks in the
              //     admin queue instead of auto-verifying.
              easyslipMatchAccount: req.features?.slipUpload?.providerReceiverCheck === true,
              slip2goCheckReceiver: req.features?.slipUpload?.providerReceiverCheck === true,
              strictReceiverTail: req.features?.slipUpload?.strictReceiverTail === true,
            },
            req.features
          );
        }
      } catch (err) {
        // Catch-all in case the fallback wrapper itself threw — shouldn't
        // happen (each provider's catch is internal) but defensive.
        verifyResult = { ok: false, error: err.message, code: 'VERIFIER_THREW', attempts: [] };
      }
    }

    // Cross-flow replay guard (txref): a bank transaction already recorded as a
    // BOOKING deposit must not be reused to pay a bill. The slip_hash check
    // above only catches the SAME image; a re-screenshot has a different hash
    // but the SAME bank transaction_ref. uq_payments_tx_ref dedups within
    // payments, but booking deposits live in bookings.deposit_transaction_ref —
    // so check there too (mirror of the booking-submit guard at /bookings).
    if (verifyResult && verifyResult.transRef) {
      try {
        const dupBookingRef = await pool.query(
          `SELECT external_id FROM bookings WHERE deposit_transaction_ref=$1 LIMIT 1`,
          [verifyResult.transRef]
        );
        if (dupBookingRef.rows.length) {
          if (slip && slip.id) {
            require('./services/storage').removeQuietly(pool, slip.id, '[slip-upload] orphan file');
          }
          return res.status(409).json({
            error: 'รายการโอนนี้ถูกใช้เป็นมัดจำการจองไปแล้ว — ไม่สามารถนำมาชำระบิลซ้ำ',
            code: 'DUPLICATE_TRANSACTION',
            bookingId: dupBookingRef.rows[0].external_id,
          });
        }
      } catch (err) {
        if (err.code !== '42703') throw err; // pre-migration: column absent
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
    // Single source of truth — slipVerifier owns the classification.
    // A local fallback set used to live here but it silently drifted
    // when slipVerifier added new transient codes (the old fallback
    // never picked them up, causing legit timeouts to hard-reject).
    // If the export is missing the require above would have already
    // failed, so we can rely on it.
    const TRANSIENT_CODES = slipVerifier.TRANSIENT_CODES;
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
        initialReason = `ระบบตรวจสลิปอัตโนมัติยังยืนยันไม่ได้ (${verifyResult.code}) — ส่งเข้าคิวแอดมินตรวจด้วยมือ`;
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
    // Replay-after-reversal guard. When an admin VOIDS a bill or UNMARKS it
    // paid, the reversed payment is flipped to status='rejected', dropping its
    // slip_hash + transaction_ref out of the pending/verified unique indexes —
    // so the same REAL bank transfer could be silently re-credited on a fresh
    // upload. Those reversals stamp a distinctive rejected_reason
    // (superseded_by_void: / unmark_paid_correction:), which separates them
    // from an ordinary wrong-bill slip reject (that one is meant to be
    // resubmittable). If this upload matches a reversed ref, never auto-verify
    // it — route it to the admin queue so a human re-confirms against the
    // reversal history. Detective only: it can downgrade verified->pending,
    // never hard-reject a genuine payment.
    if (initialStatus === 'verified') {
      try {
        const reversedRef = await pool.query(
          `SELECT 1 FROM payments
             WHERE status='rejected'
               AND (rejected_reason LIKE 'superseded_by_void:%'
                    OR rejected_reason LIKE 'unmark_paid_correction:%')
               AND (slip_hash = $1
                    OR ($2::text IS NOT NULL AND transaction_ref = $2))
             LIMIT 1`,
          [slipHash, (verifyResult && verifyResult.transRef) ? String(verifyResult.transRef) : null]
        );
        if (reversedRef.rows.length) {
          initialStatus = 'pending';
          initialReason = 'สลิป/รายการโอนนี้ตรงกับการชำระที่เคยถูกยกเลิกหรือกลับรายการ — ส่งเข้าคิวแอดมินเพื่อตรวจสอบก่อนยืนยัน';
        }
      } catch (e) {
        // Best-effort: a lookup failure must not block a legitimate payment;
        // the partial unique indexes remain the hard integrity backstop.
        if (e && e.code !== '42P01' && e.code !== '42703') {
          console.warn('[pay] reversed-ref replay check failed:', e.message);
        }
      }
    }
    if (!effectivePaymentBlock) {
      try {
        const loaded = await loadEffectivePaymentBlock();
        effectivePaymentBlock = loaded.paymentBlock;
        if (effectivePaymentBlock?.promptpayTarget) {
          try { effectivePromptpayTarget = normaliseTarget(effectivePaymentBlock.promptpayTarget); } catch { /* method fallback only */ }
        }
      } catch { /* method fallback only */ }
    }
    const paymentMethod = inferSlipPaymentMethod(effectivePaymentBlock, verifyResult, {
      promptpayTarget: effectivePromptpayTarget,
      requestedMethod: b.method || b.paymentMethod,
    });

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
    let committedRoomId = null;
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
        `SELECT id, status, total, late_fee, tenant_id FROM bills WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [billId]
      );
      if (!lock.rows.length) {
        await client.query('ROLLBACK');
        if (slip && slip.id) {
          require('./services/storage').removeQuietly(pool, slip.id, '[slip-upload] orphan file');
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
          require('./services/storage').removeQuietly(pool, slip.id, '[slip-upload] orphan file');
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
          require('./services/storage').removeQuietly(pool, slip.id, '[slip-upload] orphan file');
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
          require('./services/storage').removeQuietly(pool, slip.id, '[slip-upload] orphan file');
        }
        return res.status(409).json({
          error: 'บิลนี้มีการชำระที่ยืนยันแล้ว ไม่สามารถส่งสลิปซ้ำ',
          code: 'BILL_ALREADY_PAID',
          existingPaymentId: existingVerified.rows[0].id,
        });
      }
      // Re-check the per-bill upload cap under the lock. The pre-check at
      // line 6218 runs before the verifier RPC (5-10s) — in that window,
      // a tenant who fires N concurrent uploads could see remaining > 0
      // on all of them and bypass the 3-strikes limit by ~tenant slip
      // attempts. Re-counting here, with the bill row locked, makes the
      // cap an actual cap rather than a soft hint.
      const attemptsUnderLock = await loadBillPaymentAttemptSummary(
        client, billId, req.tenant.tenant_id
      );
      if (attemptsUnderLock.remaining <= 0) {
        await client.query('ROLLBACK');
        if (slip && slip.id) {
          require('./services/storage').removeQuietly(pool, slip.id, '[slip-upload] orphan file');
        }
        return res.status(429).json({
          error: 'อัปโหลดสลิปครบ 3 ครั้งแล้ว กรุณาติดต่อแอดมิน',
          code: 'SLIP_UPLOAD_LIMIT_REACHED',
          upload: { ...attemptsUnderLock, canUpload: false },
        });
      }
      // Re-check the amount under the bill row lock. The first check happens
      // before a slow storage/verifier path; in that window an admin edit or
      // the late-fee scheduler can change bills.total. The locked check keeps
      // the durable payment row consistent with the ledger amount we are about
      // to mark paid.
      const lockedBillTotal = billing.round2(Number(lock.rows[0].total));
      const lockedLateFee = billing.round2(Number(lock.rows[0].late_fee || 0));
      finalAmountCheck = billing.validatePaymentAmount({
        amount,
        total: lockedBillTotal,
        lateFee: lockedLateFee,
      });
      if (!finalAmountCheck.ok) {
        await client.query('ROLLBACK');
        if (slip && slip.id) {
          require('./services/storage').removeQuietly(pool, slip.id, '[slip-upload] orphan file');
        }
        return res.status(409).json({
          error: 'ยอดชำระไม่ตรงกับยอดบิลล่าสุด กรุณารีเฟรชบิลแล้วส่งใหม่',
          code: 'AMOUNT_NOT_BILL_TOTAL_AT_COMMIT',
          billTotal: lockedBillTotal,
          billPrincipal: finalAmountCheck.principal,
          billLateFee: lockedLateFee,
          submittedAmount: amount,
        });
      }
      // Late-fee policy gate (services/billing.js#resolvePrincipalLateFee).
      // The slip may have auto-verified as authentic, but if it only covers the
      // principal while a late fee is outstanding AND the operator has not opted
      // into auto-waiving, we must NOT silently settle and forgive the fee.
      // Downgrade the row to 'pending' so it lands in the admin slip queue, where
      // the admin explicitly chooses to waive the fee or have the tenant pay it.
      const tenantLateFeePolicy = billing.resolvePrincipalLateFee({
        tier: finalAmountCheck.tier,
        lateFee: finalAmountCheck.lateFee,
        autoWaive: !!(req.features && req.features.lateFee && req.features.lateFee.autoWaiveOnPrincipal),
      });
      if (initialStatus === 'verified' && tenantLateFeePolicy.applies && !tenantLateFeePolicy.settle) {
        initialStatus = 'pending';
        initialReason = `ผู้เช่าชำระยอดก่อนค่าปรับ (฿${finalAmountCheck.principal.toLocaleString('th-TH')}) — ค่าปรับ ฿${finalAmountCheck.lateFee.toLocaleString('th-TH')} รอแอดมินตัดสินใจ (ยกเว้น หรือ เก็บเพิ่ม)`;
      }

      try {
        // INSERT now carries transaction_ref + verify_provider + raw payload
        // when auto-verify ran. The unique index on transaction_ref catches
        // a replay attempt (same bank tx, different image bytes) — comes
        // back as 23505 and we surface a clear 409 below.
        const uploadMeta = req.publicPayment ? {
          source: req.publicPayment.source || 'public_pay_link',
          attemptNo: req.publicPayment.attemptNo || null,
          maxAttempts: req.publicPayment.maxAttempts || PUBLIC_SLIP_UPLOAD_MAX_ATTEMPTS,
        } : null;
        // R2-followup — record which amount-tier the tenant satisfied so
        // admin verify-slip can show "good-faith principal payment, late
        // fee 90฿ still outstanding" instead of a confusing mismatch alert.
        // tier='exact' = amount matched current total. tier='principal' =
        // amount matched subtotal+vat (late_fee accrued after the tenant
        // already committed to pay).
        const amountTierMeta = {
          tier: finalAmountCheck.tier || amountTier,
          billTotalAtUpload: billTotal,
          billLateFeeAtUpload: billLateFee,
          principalAtUpload: billing.round2(billTotal - billLateFee),
          lateFeeOutstandingAtUpload,
          billTotalAtCommit: finalAmountCheck.total,
          billLateFeeAtCommit: finalAmountCheck.lateFee,
          principalAtCommit: finalAmountCheck.principal,
          lateFeeOutstandingAtCommit: finalAmountCheck.lateFeeOutstanding,
        };
        const verifyPayload = (verifyResult || uploadMeta) ? JSON.stringify({
          ...(verifyResult ? {
            ok: verifyResult.ok,
            code: verifyResult.code,
            amount: verifyResult.amount,
            sender: verifyResult.sender,
            receiver: verifyResult.receiver,
            receiverMatch: verifyResult.receiverMatch || null,
            transDate: verifyResult.transDate,
            error: verifyResult.error,
            attempts: verifyResult.attempts || [],
          } : {}),
          ...(uploadMeta ? { upload: uploadMeta } : {}),
          amountTier: amountTierMeta,
        }) : JSON.stringify({ amountTier: amountTierMeta });
        const ins = await client.query(
          `INSERT INTO payments (bill_id, tenant_id, amount, method, slip_url, slip_hash,
                                 status, rejected_reason, transaction_ref, verify_provider, verify_payload, verified_by, verified_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
           RETURNING *`,
          [
            billId, req.tenant.tenant_id, amount, paymentMethod, slip.url, slipHash,
            initialStatus, initialReason,
            verifyResult?.transRef || null,
            verifyResult?.provider || null,
            verifyPayload || (verifyResult ? JSON.stringify({
              ok: verifyResult.ok,
              code: verifyResult.code,
              amount: verifyResult.amount,
              sender: verifyResult.sender,
              receiver: verifyResult.receiver,
              receiverMatch: verifyResult.receiverMatch || null,
              transDate: verifyResult.transDate,
              error: verifyResult.error,
              // Per-provider attempt trail (multi-provider fallback chain).
              // Lets admin see "SlipOK was down so EasySlip handled this"
              // or "Both providers rejected — fake slip suspected" in
              // /admin#payments forensics.
              attempts: verifyResult.attempts || [],
            }) : null),
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
            require('./services/storage').removeQuietly(pool, slip.id, '[slip-upload] orphan file');
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
        if (finalAmountCheck.tier === 'principal' && finalAmountCheck.lateFee > 0) {
          await client.query(
            `UPDATE bills
                SET late_fee = 0,
                    total    = $2::numeric
              WHERE id = $1 AND deleted_at IS NULL`,
            [billId, finalAmountCheck.principal]
          );
          await client.query(
            `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [
              verifyResult?.ok ? `auto:${verifyResult.provider || 'slip'}` : `tenant:${req.tenant.tenant_id}`,
              'bill.late_fee_waived_on_principal_payment',
              'bill',
              String(billId),
              JSON.stringify({
                waivedLateFee: finalAmountCheck.lateFee,
                paymentAmount: amount,
                principalAtVerify: finalAmountCheck.principal,
                billTotalBeforeWaive: finalAmountCheck.total,
                reason: 'tenant slip matched principal before late_fee was collected',
              }),
            ]
          ).catch(() => { /* audit best-effort */ });
        }
        const settledBillTotal = finalAmountCheck.tier === 'principal' && finalAmountCheck.lateFee > 0
          ? finalAmountCheck.principal
          : finalAmountCheck.total;
        const paidLedgerCheck = billing.validatePaidLedger({
          paymentAmount: amount,
          billTotal: settledBillTotal,
        });
        if (!paidLedgerCheck.ok) {
          await client.query('ROLLBACK');
          if (slip && slip.id) {
            require('./services/storage').removeQuietly(pool, slip.id, '[slip-upload] orphan file');
          }
          return res.status(409).json({
            error: 'ยอดชำระไม่สอดคล้องกับยอดบิลหลังปรับสถานะ กรุณารีเฟรชบิลแล้วส่งใหม่',
            code: 'PAID_LEDGER_INCONSISTENT',
            paymentAmount: paidLedgerCheck.paymentAmount,
            billTotal: paidLedgerCheck.billTotal,
            diff: paidLedgerCheck.diff,
            tolerance: paidLedgerCheck.tolerance,
          });
        }
        const paid = await client.query(
          `UPDATE bills SET status='paid', paid_at=NOW()
             WHERE id=$1 AND status IN ('pending','overdue')
             RETURNING id, room_id`,
          [billId]
        );
        if (paid.rowCount !== 1) {
          throw Object.assign(new Error('bill mark-paid update did not affect exactly one row'), {
            code: 'BILL_MARK_PAID_FAILED',
          });
        }
        // Stash the room_id for the post-commit roomStatus sync below.
        committedRoomId = paid.rows[0]?.room_id || null;
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
        require('./services/storage').removeQuietly(pool, slip.id, '[slip-upload] orphan file (outer)');
      }
      throw err;
    } finally {
      client.release();
    }
    // Auto-cascade room status after a successful slip auto-verify. The
    // billRoom_id was captured under the tx; calling syncRoom here (post-
    // commit, fire-and-forget) flips the room from 'overdue' → 'occupied'
    // when the tenant just paid their last overdue bill. Failure to sync
    // is non-fatal — the daily safety-net tick will reconcile.
    if (committedRoomId) {
      require('./services/roomStatus').syncRoom(pool, committedRoomId, { reason: 'slip-auto-verify' })
        .catch((err) => console.warn(`[slip-upload] room sync failed:`, err.message));
    }
    // Immediate access-card reinstate when the auto-verified payment
    // cleared a tenant's overdue balance. Mirrors the cascade in
    // /api/payments/:id/verify so a tenant who uploads via portal /
    // public link / LINE doesn't have to wait for the next daily tick
    // to use their access card again.
    if (initialStatus === 'verified' && req.tenant?.tenant_id) {
      try {
        const rawThreshold = Number(req.features?.accessControl?.overdueDaysThreshold);
        const threshold = Number.isFinite(rawThreshold) ? rawThreshold : 30;
        require('./services/scheduler').restoreAccessCardsForTenantIfClear(pool, req.tenant.tenant_id, {
          threshold,
          notifier: require('./services/notifier'),
          flags: req.features,
          audit: async (entry) => {
            // Table name is `audit_logs` (plural) with columns
            // (user_id, action, entity_type, entity_id, detail) — see
            // db/migrate.js:65. Earlier version used singular `audit_log`
            // and renamed columns, which silently failed with 42P01.
            await pool.query(
              `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail)
               VALUES ($1, $2, $3, $4, $5::jsonb)`,
              [entry.actor, entry.action, entry.entity, entry.entityId, JSON.stringify(entry.details || {})]
            ).catch(() => {});
          },
        }).catch((err) => console.warn(`[slip-upload] access-card restore failed:`, err.message));
      } catch (err) { console.warn(`[slip-upload] access-card restore outer error:`, err.message); }
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
      let adminBill = null;
      let adminAttempts = null;
      try {
        const [billInfo, attemptInfo] = await Promise.all([
          pool.query(`SELECT bill_no, period, room_id, status, total FROM bills WHERE id=$1 LIMIT 1`, [billId]),
          loadBillPaymentAttemptSummary(pool, billId, req.tenant.tenant_id),
        ]);
        adminBill = billInfo.rows[0] || null;
        adminAttempts = attemptInfo || null;
      } catch { /* notification detail is best-effort */ }
      // Translate every label into Thai so a non-dev owner reading the
      // LINE/email push on their phone doesn't have to context-switch
      // between Thai header and English detail block. Layout is one
      // labeled fact per line so it skims well on a small screen.
      const billStatusTh = ({
        pending: 'รอชำระ',
        overdue: 'ค้างชำระ',
        paid: 'ชำระแล้ว',
        void: 'ยกเลิก',
      })[adminBill?.status] || adminBill?.status || '-';
      const latestSlipStatusTh = ({
        pending: 'รอตรวจสอบ',
        verified: 'อนุมัติแล้ว',
        rejected: 'ถูกปฏิเสธ',
      })[adminAttempts?.latest?.status] || adminAttempts?.latest?.status || '-';
      const partyDetail = (label, party) => {
        if (!party || typeof party !== 'object') return null;
        const detail = [
          party.name || party.displayName || null,
          party.bank || null,
          party.account ? `บัญชีลงท้าย ${String(party.account).replace(/[^0-9]/g, '').slice(-6) || party.account}` : null,
        ].filter(Boolean).join(' / ');
        return detail ? `${label}: ${detail}` : null;
      };
      const verifyAttemptTrail = Array.isArray(verifyResult?.attempts) && verifyResult.attempts.length
        ? verifyResult.attempts
            .map((a) => `${a.provider || 'provider'}:${a.ok ? 'ผ่าน' : (a.code || 'ไม่ผ่าน')}`)
            .join(', ')
        : null;
      const verifyAmount = Number(verifyResult?.amount);
      const verifyDetailLines = [
        verifyResult?.provider ? `บริการตรวจสลิป: ${verifyResult.provider}` : null,
        verifyResult?.code ? `รหัสผลตรวจสำหรับแอดมิน: ${verifyResult.code}` : null,
        Number.isFinite(verifyAmount)
          ? `ยอดที่บริการอ่านจากสลิป: ฿${verifyAmount.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`
          : null,
        partyDetail('ผู้โอนในสลิป', verifyResult?.sender),
        partyDetail('ผู้รับในสลิป', verifyResult?.receiver),
        verifyResult?.transDate ? `เวลารายการในสลิป: ${verifyResult.transDate}` : null,
        verifyAttemptTrail ? `เส้นทาง provider: ${verifyAttemptTrail}` : null,
      ].filter(Boolean);
      const adminDetailLines = [
        adminBill?.room_id ? `🏠 ห้อง: ${adminBill.room_id}` : null,
        adminBill?.bill_no ? `📄 เลขบิล: ${adminBill.bill_no}` : null,
        adminBill?.period ? `📅 รอบบิล: ${adminBill.period}` : null,
        adminBill?.status ? `📌 สถานะบิลปัจจุบัน: ${billStatusTh}` : null,
        adminBill?.total != null
          ? `💰 ยอดตามบิล: ฿${Number(adminBill.total).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`
          : null,
        adminAttempts
          ? `📥 ผู้เช่าอัปโหลดสลิปครั้งที่: ${adminAttempts.used}/${adminAttempts.max} (เหลืออีก ${adminAttempts.remaining} ครั้ง)`
          : null,
        adminAttempts?.pendingCount
          ? `⏳ สลิปรอตรวจของบิลนี้: ${adminAttempts.pendingCount} ใบ` : null,
        adminAttempts?.rejectedCount
          ? `❌ สลิปที่ถูกปฏิเสธก่อนหน้า: ${adminAttempts.rejectedCount} ใบ` : null,
        adminAttempts?.latest
          ? `🕐 สลิปล่าสุด: ${latestSlipStatusTh}${adminAttempts.latest.rejected_reason ? ` — ${adminAttempts.latest.rejected_reason}` : ''}`
          : null,
        ...verifyDetailLines,
        initialReason ? `📝 ผลการตรวจอัตโนมัติ: ${initialReason}` : null,
        verifyResult?.transRef ? `🔖 เลขอ้างอิงรายการโอน: ${verifyResult.transRef}` : null,
        '', // blank line before action
        initialStatus === 'verified'
          ? '✅ ระบบทำเครื่องหมายบิลเป็น "ชำระแล้ว" ให้แล้ว ไม่ต้องดำเนินการเพิ่ม'
          : initialStatus === 'pending' && autoVerifyAttempted && !verifyResult?.ok
            ? '👉 ที่ต้องทำ: ระบบตรวจสลิปอัตโนมัติยังยืนยันไม่ได้ ให้แอดมินเปิด /admin#payments ตรวจสลิปด้วยมือและติดต่อผู้เช่าหากต้องการข้อมูลเพิ่ม — บิลยังเป็น "ยังไม่ชำระ" จนกว่าจะอนุมัติ'
            : initialStatus === 'pending'
              ? '👉 ที่ต้องทำ: เข้า /admin#payments เพื่อตรวจสลิป — บิลยังเป็น "ยังไม่ชำระ" จนกว่าจะอนุมัติ'
              : '👉 ที่ต้องทำ: เข้า /admin#payments เพื่อดูเหตุผลที่ระบบปฏิเสธ และติดต่อผู้เช่าหากจำเป็น — บิลยังไม่ถูกชำระ',
      ].filter((l) => l !== null && l !== undefined);
      // Lead with the most important facts (who + how much + room) on
      // line 1 so a glance at the LINE preview already tells the owner
      // what room paid before they tap to open.
      const headerLine = adminBill?.room_id
        ? `🏠 ห้อง ${adminBill.room_id} · คุณ${req.tenant.full_name} (${req.tenant.phone || 'ไม่มีเบอร์'})`
        : `คุณ${req.tenant.full_name} (${req.tenant.phone || 'ไม่มีเบอร์'})`;
      const subjectRoomPart = adminBill?.room_id ? ` · ห้อง ${adminBill.room_id}` : '';
      notifier.notifyOwner(
        { pool, features: req.features },
        {
          subject: `${statusEmoji} สลิปใหม่${subjectRoomPart} — ${statusTh} · ฿${amount.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`,
          text: [
            headerLine,
            `💸 ผู้เช่าระบุยอดที่โอน: ฿${amount.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`,
            `🚦 สถานะการตรวจอัตโนมัติ: ${statusTh}`,
            '',
            ...adminDetailLines,
          ].join('\n'),
        }
      ).catch(() => {});
    }

    // Tenant receives an immediate acknowledgment so they don't wonder
    // whether their slip went through. Two flavours: auto-verified (no
    // admin step needed) → "thanks, paid" final receipt; pending review
    // → "got it, we'll check" with expected timeline. Without this the
    // tenant uploaded a slip and got nothing back until admin manually
    // approved hours later — fueling "ส่งไปแล้วทำไมเงียบ" support tickets.
    if (!req.skipTenantAck) {
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
        const buildingName = await billPayments.loadBuildingName(pool);

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
          const verifierCode = verifyResult?.code || 'VERIFIER_UNAVAILABLE';
          const attemptCount = Array.isArray(verifyResult?.attempts) ? verifyResult.attempts.length : 0;
          const attemptText = attemptCount > 0
            ? ` ระบบลองตรวจผ่านผู้ให้บริการที่ตั้งค่าไว้ ${attemptCount} รายการแล้วแต่ยังไม่ได้ผลยืนยัน`
            : '';
          extra = `\n⚠️ ระบบตรวจสลิปอัตโนมัติยังไม่สามารถยืนยันผลได้ในขณะนี้ (รหัส ${verifierCode}) — สลิปถูกส่งให้แอดมิน/สำนักงานตรวจแล้ว${attemptText}`;
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
            `หากต้องการความช่วยเหลือหรือเร่งตรวจ กรุณาติดต่อแอดมิน/สำนักงานของ ${buildingName} พร้อมแจ้งบิล ${billNo} และจำนวน ฿${amtStr}`,
          ].join('\n'),
        };
      }

      if (req.publicPayment) tenantNotice.force = true;
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
    }

    const attemptSummary = await loadBillPaymentAttemptSummary(pool, billId, req.tenant.tenant_id)
      .catch(() => null);
    const uploadState = attemptSummary ? {
      ...attemptSummary,
      canUpload: attemptSummary.remaining > 0 && !attemptSummary.hasPending && row.status !== 'verified',
      blocked: attemptSummary.remaining <= 0
        ? { code: 'SLIP_UPLOAD_LIMIT_REACHED', message: 'อัปโหลดสลิปครบ 3 ครั้งแล้ว กรุณาติดต่อแอดมิน' }
        : (attemptSummary.hasPending
            ? { code: 'PAYMENT_UNDER_REVIEW', message: 'มีสลิปรอแอดมินตรวจสอบอยู่แล้ว กรุณารอผลก่อนส่งใหม่' }
            : null),
    } : null;
    res.json({
      ok: true,
      payment: row,
      verification: buildSlipVerificationNotice({
        initialStatus,
        verifyResult,
        autoVerifyAttempted,
        requireVerification: !!req.features?.slipUpload?.requireVerification,
        upload: uploadState,
      }),
      upload: uploadState,
    });
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
}

app.post('/api/tenant/payments', sameOrigin, csrfGuard, requireTenant, ensureSlipUpload, tenantPaymentUploadHandler);

async function processTenantSlipUpload({ tenant, billId, amount, slip, features: featureFlags, source = 'internal', skipTenantAck = false } = {}) {
  if (!tenant) throw new Error('tenant required');
  const req = {
    body: { billId, amount, slip },
    tenant,
    features: featureFlags || await features.load(pool),
    headers: {},
    session: null,
    ip: null,
    id: `slip-${source}`,
    skipTenantAck,
    get: () => '',
  };
  let statusCode = 200;
  let payload;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      payload = body;
      return this;
    },
  };
  await tenantPaymentUploadHandler(req, res);
  if (statusCode >= 400) {
    const err = new Error((payload && payload.error) || `slip upload failed (${statusCode})`);
    err.status = statusCode;
    err.data = payload;
    throw err;
  }
  return payload;
}

// loadBuildingName + notifyTenantOnPayment moved to services/billPayments.js
// so /api/bills/:id/void + /:id/unmark-paid (in routes/bills-extras.js) and
// /api/payments/:id/verify (still in this file) can share a single
// implementation instead of two slightly-drifted copies.
//
// notifyBillVoided moved into routes/bills-extras.js alongside its sole
// caller, PUT /api/bills/:id/void.

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
              p.verify_provider, p.transaction_ref, p.created_at,
              COUNT(*) OVER (PARTITION BY p.bill_id, p.tenant_id)::int AS upload_attempts,
              (sf.id IS NOT NULL
               AND sf.category='slip'
               AND lower(COALESCE(sf.mime_type, '')) IN ('image/jpeg','image/png','image/webp')) AS has_slip,
              b.bill_no, b.period, b.room_id, b.status AS bill_status, b.total AS bill_total,
              t.full_name AS tenant_name, t.phone AS tenant_phone
         FROM payments p
         LEFT JOIN file_uploads sf ON p.slip_url = '/files/' || sf.id::text
         LEFT JOIN bills b ON b.id = p.bill_id
         LEFT JOIN tenants t ON t.id = p.tenant_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY p.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const summaryRes = await pool.query(
      `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::numeric AS amount
         FROM payments
        WHERE status IN ('pending','verified','rejected')
        GROUP BY status`
    );
    const summary = {
      pending: { count: 0, amount: 0 },
      verified: { count: 0, amount: 0 },
      rejected: { count: 0, amount: 0 },
    };
    for (const r of summaryRes.rows) {
      if (!summary[r.status]) continue;
      summary[r.status] = {
        count: Number(r.count) || 0,
        amount: Number(r.amount) || 0,
      };
    }
    res.json({ ok: true, payments: rows, summary, limit, offset });
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
      `SELECT p.*, b.bill_no, b.period, b.room_id, b.status AS bill_status, b.total AS bill_total,
              COUNT(*) OVER (PARTITION BY p.bill_id, p.tenant_id)::int AS upload_attempts,
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
  const reasonRaw = String(req.body?.reason || '').trim();
  if (reasonRaw.length > 500) {
    return res.status(400).json({
      error: 'เหตุผลที่ปฏิเสธยาวเกินไป (สูงสุด 500 ตัวอักษร)',
      code: 'REJECT_REASON_TOO_LONG',
      maxLength: 500,
      actualLength: reasonRaw.length,
    });
  }
  const reason = reasonRaw;
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
      // Lock-order discipline: bills BEFORE payments, matching
      // /api/bills/:id/verify-slip (routes/bills-extras.js). If we locked
      // payments first here, two admins clicking different UIs on the same
      // bill+payment pair would deadlock (each waiting on the other's lock)
      // and one transaction would die with Postgres 40P01. We do a
      // non-locking read of the payment first to discover its bill_id,
      // then lock in the canonical bill → payment order.
      const peek = await client.query(
        `SELECT bill_id FROM payments WHERE id=$1 AND status='pending'`,
        [id]
      );
      if (!peek.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'not found or already decided' });
      }
      const billId = peek.rows[0].bill_id;
      if (!billId) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'payment is not linked to a bill',
          code: 'PAYMENT_WITHOUT_BILL',
        });
      }
      const bill = await client.query(
        `SELECT id, status, total, late_fee, subtotal, vat, deleted_at, tenant_id, room_id, period FROM bills WHERE id=$1 FOR UPDATE`,
        [billId]
      );
      // Now lock the payment row in the canonical order. Re-check status
      // because the window between the peek above and this lock could have
      // let another verifier change the row to verified/rejected.
      const pres = await client.query(
        `SELECT * FROM payments WHERE id=$1 AND status='pending' FOR UPDATE`,
        [id]
      );
      if (!pres.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'not found or already decided' });
      }
      row = pres.rows[0];
      if (Number(row.bill_id) !== Number(billId)) {
        // The payment's bill_id changed between peek and lock (admin
        // re-linked it). Fail closed — operator must restart with the
        // updated context.
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'payment changed mid-flight, refresh and try again',
          code: 'PAYMENT_BILL_CHANGED',
        });
      }
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
      // R2-followup — accept the payment in two tiers:
      //   - tier='exact'     → paymentAmount ≈ current bill.total (incl. late_fee)
      //   - tier='principal' → paymentAmount ≈ subtotal+vat (tenant paid before
      //                         scheduler.tickLateFee added late_fee)
      // Both are legitimate. When tier==='principal', late_fee stays on the
      // bill as an outstanding residual the admin can choose to waive or
      // pursue — the response surfaces that outstanding amount so the
      // admin UI can flag it.
      const billTotal = Number(bill.rows[0].total);
      const billLateFee = Number(bill.rows[0].late_fee || 0);
      const paymentAmount = Number(row.amount);
      const amountCheck = billing.validatePaymentAmount({
        amount: paymentAmount,
        total: billTotal,
        lateFee: billLateFee,
      });
      if (!Number.isFinite(billTotal) || !Number.isFinite(paymentAmount) || !amountCheck.ok) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'payment amount does not match bill total',
          code: 'PAYMENT_AMOUNT_MISMATCH',
          billTotal,
          billPrincipal: amountCheck.principal,
          billLateFee,
          paymentAmount,
        });
      }
      // Late-fee policy (services/billing.js#resolvePrincipalLateFee). When the
      // tenant only covered the principal while a late fee is outstanding, the
      // admin must explicitly DECIDE — we no longer silently forgive it. The
      // "อนุมัติ + ยกค่าปรับ" action sends waiveLateFee:true to waive; a plain
      // approve gets LATE_FEE_DECISION_REQUIRED so the UI prompts for the choice.
      // The admin DECIDES via lateFeeAction: 'waive' forgives the fee; 'carry'
      // settles this bill at principal and bills the fee next month (one-off
      // charge). Legacy waiveLateFee:true still maps to 'waive'. No decision →
      // LATE_FEE_DECISION_REQUIRED so the UI prompts for the choice.
      const lateFeeAction = (req.body && req.body.lateFeeAction)
        || (req.body && req.body.waiveLateFee === true ? 'waive' : undefined);
      const lateFeePolicy = billing.resolvePrincipalLateFee({
        tier: amountCheck.tier, lateFee: billLateFee, action: lateFeeAction,
      });
      if (lateFeePolicy.applies && !lateFeePolicy.settle) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'ผู้เช่าชำระเฉพาะยอดก่อนค่าปรับ — เลือกจัดการค่าปรับ: ยกค่าปรับ / เก็บรอบหน้า หรือปฏิเสธให้จ่ายเพิ่ม',
          code: 'LATE_FEE_DECISION_REQUIRED',
          billTotal,
          billPrincipal: amountCheck.principal,
          billLateFee,
          paymentAmount,
        });
      }
      let carriedChargeId = null;
      if (lateFeePolicy.applies && lateFeePolicy.settle) {
        // 'carry' depends on the recurring-charges feature (next bill-gen pulls
        // the one-off in). Block it when disabled so the fee can't silently
        // vanish — admin must enable the feature or waive instead.
        if (lateFeePolicy.action === 'carry') {
          const flags = await features.load(pool).catch(() => ({}));
          if (!(flags.recurringCharges && flags.recurringCharges.enabled)) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: 'ต้องเปิดฟีเจอร์ "ค่าใช้จ่ายประจำ" ก่อนจึงจะเก็บค่าปรับรอบหน้าได้ — หรือเลือกยกค่าปรับแทน',
              code: 'RECURRING_CHARGES_REQUIRED_FOR_CARRY',
            });
          }
        }
        await client.query(
          `UPDATE bills
              SET late_fee = 0,
                  total    = $2::numeric
            WHERE id = $1 AND deleted_at IS NULL`,
          [row.bill_id, amountCheck.principal]
        );
        if (lateFeePolicy.action === 'carry') {
          carriedChargeId = await billPayments.carryLateFeeToNextBill(client, {
            tenantId: bill.rows[0].tenant_id,
            roomId: bill.rows[0].room_id,
            amount: billLateFee,
            fromPeriod: bill.rows[0].period,
            createdBy: req.session?.user?.username || 'admin:unknown',
          });
          if (!carriedChargeId) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: 'ไม่สามารถสร้างรายการเก็บค่าปรับรอบหน้าได้ กรุณาตรวจข้อมูลผู้เช่า/ห้อง หรือเลือกยกค่าปรับแทน',
              code: 'LATE_FEE_CARRY_FAILED',
            });
          }
        }
        const auditAction = lateFeePolicy.action === 'carry'
          ? 'bill.late_fee_carried_forward_on_principal_payment'
          : 'bill.late_fee_waived_on_principal_payment';
        await client.query(
          `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [req.session?.user?.username || 'admin:unknown',
           auditAction,
           'bill', String(row.bill_id),
           JSON.stringify({
             lateFee: billLateFee,
             action: lateFeePolicy.action,
             carriedChargeId,
             paymentId: id,
             paymentAmount,
             principalAtVerify: amountCheck.principal,
             billTotalBeforeSettle: billTotal,
           })]
        ).catch(() => { /* audit best-effort */ });
      }
      const settledBillTotal = amountCheck.tier === 'principal' && billLateFee > 0
        ? amountCheck.principal
        : billTotal;
      const paidLedgerCheck = billing.validatePaidLedger({
        paymentAmount,
        billTotal: settledBillTotal,
      });
      if (!paidLedgerCheck.ok) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'payment ledger does not reconcile with bill total',
          code: 'PAID_LEDGER_INCONSISTENT',
          paymentAmount: paidLedgerCheck.paymentAmount,
          billTotal: paidLedgerCheck.billTotal,
          diff: paidLedgerCheck.diff,
          tolerance: paidLedgerCheck.tolerance,
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
      // Reject sibling pending payments on the same bill. Without this,
      // if a tenant uploaded slip A → admin verified slip B (different
      // upload, same bill), slip A stayed forever in 'pending' and
      // showed as an orphan in the slip queue. Bills-extras.js does the
      // same for its by-bill verify path; this canonical by-payment-id
      // path needed the same fix to stay consistent.
      await client.query(
        `UPDATE payments
            SET status='rejected',
                verified_by=$1,
                verified_at=NOW(),
                rejected_reason='superseded_by_verified_sibling'
          WHERE bill_id=$2 AND status='pending' AND id<>$3`,
        [req.session.user.username, row.bill_id, id]
      );
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
      billPayments.notifyTenantOnPayment({ pool }, row, 'verified').catch(() => {});
      // Recompute the room's status now that the bill is paid — covers the
      // common "paying the last overdue bill flips room overdue → occupied"
      // case so admin doesn't have to click anything. Fire-and-forget
      // since the payment is already durable + audited; a sync failure
      // won't undo the payment, it just leaves the room status to the
      // nightly safety-net.
      try {
        const billRoom = await pool.query(`SELECT room_id FROM bills WHERE id=$1 LIMIT 1`, [row.bill_id]);
        const rid = billRoom.rows[0]?.room_id;
        if (rid) {
          require('./services/roomStatus').syncRoom(pool, rid, { reason: 'payment-verify' })
            .catch((err) => console.warn(`[payment.verify] room sync failed:`, err.message));
        }
      } catch (err) { console.warn(`[payment.verify] room lookup failed:`, err.message); }
      // Immediate access-card reinstate. Previously the tenant had to wait
      // until the next daily tickAccessControlSync — up to 24 hours — even
      // though they just cleared their balance. Now: pay → bill paid →
      // cascade restores any cards this subsystem auto-revoked, and the
      // tenant gets "🔓 บัตรเข้า-ออกกลับมาใช้ได้แล้ว" in the same minute.
      // Threshold pulled from features so it matches the daily cron's logic.
      if (row.tenant_id) {
        try {
          const flags = await features.load(pool).catch(() => ({}));
          const rawThreshold = Number(flags?.accessControl?.overdueDaysThreshold);
          const threshold = Number.isFinite(rawThreshold) ? rawThreshold : 30;
          require('./services/scheduler').restoreAccessCardsForTenantIfClear(pool, row.tenant_id, {
            threshold,
            notifier: require('./services/notifier'),
            flags,
            audit: async (entry) => {
              // Table is `audit_logs` (plural). See note at the matching
              // slip-upload site above + db/migrate.js:65 for the canonical
              // column shape.
              await pool.query(
                `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail)
                 VALUES ($1, $2, $3, $4, $5::jsonb)`,
                [entry.actor, entry.action, entry.entity, entry.entityId, JSON.stringify(entry.details || {})]
              ).catch(() => {});
            },
          }).catch((err) => console.warn(`[payment.verify] access-card restore failed:`, err.message));
        } catch (err) { console.warn(`[payment.verify] access-card restore outer error:`, err.message); }
      }
      // "เงินเข้า" alert to the owner + every bound admin recipient — the
      // money event the team actually cares about, fired from the same
      // post-commit spot as the room/access cascades.
      billPayments.notifyOwnerPaymentReceived(pool, {
        billId: row.bill_id, amount: row.amount,
        method: row.method || 'slip', source: 'payment-verify',
        actor: req.session.user.username,
      }).catch(() => {});
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
    billPayments.notifyTenantOnPayment({ pool }, row, 'rejected', reason).catch(() => {});
    return res.json({ ok: true, payment: row });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('payment verify error:', err);
    return res.status(500).json({ error: 'internal error' });
  } finally {
    client.release();
  }
});

// notifyTenantOnPayment moved to services/billPayments.js — see note above
// notifyBillVoided for the rationale.

// === v2: Booking state machine (B6) =======================================
// Bookings are stored in app_data['baankarn_bookings_v1'] (legacy JSONB).
// Admin advances state via PUT /api/bookings/:id (status / notes / roomId).
// Valid transitions: pending → reviewing → approved | rejected | cancelled.
// Each transition fires a notify (owner sees the change; applicant via
// LINE/email/SMS when a reachable channel exists). If no automatic channel
// works, the API returns that fact so the admin UI can tell staff to call.

// GET /api/bookings/:id — single booking with the citizen ID photo URL
// resolved (when the public booking form attached one). Surfaces enough
// detail for admin to verify ID at approve-time without bouncing between
// the JSONB blob view and file_uploads.
function composeBookingDetail(row, blobBooking) {
  if (!row && !blobBooking) return null;
  const externalId = (row && row.external_id) || (blobBooking && blobBooking.id);
  const out = { ...(blobBooking || {}), ...(row || {}) };
  // The JSONB blob is the canonical booking store — it's updated on every
  // workflow path (approve-and-assign, PUT, hold sweeper). The relational
  // `bookings` row is only best-effort dual-written (its UPDATEs are wrapped
  // in try/catch and merely warn on failure), so spreading `row` last would
  // let a lagged/failed dual-write clobber the authoritative status/notes with
  // a stale value — the booking drawer would then show e.g. "pending" for an
  // already-approved booking. Re-assert the canonical workflow fields from the
  // blob whenever it has them.
  if (blobBooking) {
    if (blobBooking.status != null) out.status = blobBooking.status;
    if (blobBooking.notes != null) out.notes = blobBooking.notes;
  }
  if (externalId) out.id = String(externalId);
  if (row && row.id != null) out.rowId = row.id;
  if (row && row.citizen_id_image_front_url && !out.citizenIdImageFrontUrl) {
    out.citizenIdImageFrontUrl = row.citizen_id_image_front_url;
  }
  if (row && row.citizen_id_image_uploaded_at && !out.citizenIdImageUploadedAt) {
    out.citizenIdImageUploadedAt = row.citizen_id_image_uploaded_at;
  }
  return out;
}

function isBookingLineExpiryPast(value) {
  if (!value) return false;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) && ts <= Date.now();
}

async function enrichBookingLineBindingStatus(pool, booking) {
  if (!booking) return booking;
  const out = { ...booking };
  const existing = out.lineBinding || out.line_binding || {};
  const bookingId = String(out.id || out.external_id || '').slice(0, 64);
  if (!bookingId) return out;

  try {
    const [bookingRecipients, statusRes] = await Promise.all([
      lineBinding.listBookingRecipients(pool, bookingId),
      pool.query(
        `SELECT id, code, status, expires_at, bound_at, created_at, updated_at,
                oa_id, target_oa_id
           FROM line_bindings
          WHERE booking_id=$1
            AND tenant_id IS NULL
          ORDER BY
            CASE status
              WHEN 'bound' THEN 0
              WHEN 'pending' THEN 1
              WHEN 'expired' THEN 2
              WHEN 'revoked' THEN 3
              ELSE 4
            END,
            bound_at DESC NULLS LAST,
            updated_at DESC NULLS LAST,
            created_at DESC
          LIMIT 10`,
        [bookingId]
      ),
    ]);

    const bookingStatus = String(out.status || 'pending').toLowerCase();
    const activeBookingStatus = ['pending', 'reviewing', 'approved'].includes(bookingStatus);
    const rows = Array.isArray(statusRes.rows) ? statusRes.rows : [];
    const pending = rows.find((r) => r.status === 'pending') || null;
    const bound = rows.find((r) => r.status === 'bound') || null;
    const latest = rows[0] || null;

    let tenantRecipients = [];
    let transferredTenantId = null;
    const roomId = out.assignedRoomId || out.roomId || out.room_id || null;
    const phone = normaliseBookingPhone(out.phone);
    if (!bookingRecipients.length && roomId && phone && ['approved', 'completed'].includes(bookingStatus)) {
      const tq = await pool.query(
        `SELECT id
           FROM tenants
          WHERE phone=$1
            AND current_room_id=$2
            AND deleted_at IS NULL
            AND status='active'
          ORDER BY updated_at DESC LIMIT 1`,
        [phone, String(roomId)]
      );
      if (tq.rows.length) {
        transferredTenantId = tq.rows[0].id;
        tenantRecipients = await lineBinding.listTenantRecipients(pool, transferredTenantId);
      }
    }

    const lineRecipients = bookingRecipients.length ? bookingRecipients : tenantRecipients;
    const boundCount = lineRecipients.length;
    const existingExpiry = existing.expiresAt || existing.expires_at || null;
    const expiresAt = pending?.expires_at || existingExpiry || latest?.expires_at || null;
    const pendingExpired = !boundCount && (
      (pending && isBookingLineExpiryPast(pending.expires_at))
      || (!pending && activeBookingStatus && isBookingLineExpiryPast(existingExpiry))
    );

    let effectiveStatus = String(existing.status || latest?.status || '').toLowerCase();
    if (boundCount > 0) effectiveStatus = 'bound';
    else if (existing.error) effectiveStatus = 'error';
    else if (pendingExpired) effectiveStatus = 'expired';
    else if (pending) effectiveStatus = 'pending';
    else if (!effectiveStatus && activeBookingStatus && existing.code) {
      effectiveStatus = isBookingLineExpiryPast(existingExpiry) ? 'expired' : 'pending';
    } else if (!effectiveStatus) {
      effectiveStatus = activeBookingStatus ? 'none' : 'not_required';
    }

    const needsReissue = activeBookingStatus && boundCount === 0 && [
      'none', 'error', 'expired', 'revoked', 'blocked',
    ].includes(effectiveStatus);

    let addFriendUrl = existing.addFriendUrl || existing.add_friend_url || null;
    let oaMessageUrl = existing.oaMessageUrl || existing.oa_message_url || null;
    if (!addFriendUrl || !oaMessageUrl) {
      const addFriendOaId = pending?.target_oa_id || pending?.oa_id || bound?.oa_id
        || latest?.target_oa_id || latest?.oa_id || null;
      const oa = addFriendOaId
        ? await lineOa.getById(pool, addFriendOaId).catch(() => null)
        : await lineOa.getDefault(pool).catch(() => null);
      addFriendUrl = addFriendUrl || oa?.addFriendUrl || null;
      oaMessageUrl = oaMessageUrl || oa?.oaMessageUrl || null;
    }

    out.lineBinding = {
      ...existing,
      status: effectiveStatus,
      lastStatus: latest?.status || existing.status || null,
      code: pending?.code || (activeBookingStatus ? existing.code : null) || null,
      expiresAt,
      addFriendUrl,
      oaMessageUrl,
      boundAt: bound?.bound_at || existing.boundAt || existing.bound_at || null,
      boundCount,
      lineRecipientCount: boundCount,
      pendingCount: pending ? 1 : 0,
      expired: effectiveStatus === 'expired',
      needsReissue,
      transferredTenantId,
      source: bookingRecipients.length ? 'booking-line-bindings' : (tenantRecipients.length ? 'tenant-line-bindings' : 'line-bindings'),
    };
  } catch (err) {
    if (!['42P01', '42703'].includes(err.code)) {
      console.warn('booking line binding enrich error:', err.message);
    }
    const fallbackCount = Number(existing.boundCount || existing.bound_count || existing.lineRecipientCount || 0) || 0;
    out.lineBinding = {
      ...existing,
      status: existing.status || (existing.error ? 'error' : 'unknown'),
      boundCount: fallbackCount,
      lineRecipientCount: fallbackCount,
      lookupError: true,
    };
  }
  return out;
}

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
    const booking = await enrichBookingLineBindingStatus(
      pool,
      composeBookingDetail(row, blobBooking)
    );
    // Citizen-ID card images are PII restricted to owner/manager, matching
    // /api/tenants/:id?includeCitizen and the /files/ sensitive-category gate.
    // This endpoint is requireAuth-only so staff can manage bookings (name/
    // phone/email stay visible) — but lower roles must not pull ID images by
    // iterating booking ids.
    const viewerRole = req.session && req.session.user && req.session.user.role;
    if (viewerRole !== 'owner' && viewerRole !== 'manager') {
      for (const k of [
        'citizen_id_image_front_url', 'citizenIdImageFrontUrl',
        'citizen_id_image_uploaded_at', 'citizenIdImageUploadedAt',
        'citizenIdImageFront', 'citizenIdImageBack',
      ]) {
        if (booking && k in booking) delete booking[k];
        if (blobBooking && typeof blobBooking === 'object' && k in blobBooking) delete blobBooking[k];
      }
    }
    res.json({
      ok: true,
      booking,
      blob: blobBooking,
      hasPhoto: !!(booking && (booking.citizen_id_image_front_url || booking.citizenIdImageFrontUrl)),
    });
  } catch (err) {
    console.error('booking get error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

const BOOKING_STATUSES = new Set(['pending', 'reviewing', 'approved', 'rejected', 'cancelled', 'completed']);
const BOOKING_TRANSITIONS = {
  // Direct PUT transitions are intentionally NOT allowed to approve a
  // booking. Approval must go through POST /approve-and-assign so the room
  // reservation is created under the same lock as the status change.
  pending:   ['reviewing', 'rejected', 'cancelled'],
  reviewing: ['rejected', 'cancelled'],
  // 'completed' is set by /api/contracts/quick-invite when admin converts
  // an approved booking into a contract+invitation. Admin can still cancel
  // after that (tenant backs out) so the exit edge stays open.
  approved:  ['completed', 'cancelled'],
  completed: ['cancelled'],          // contract handed off but admin can still cancel
  rejected:  ['reviewing'],          // re-open if admin reconsidered
  cancelled: [],                     // terminal
};

function normaliseBookingPhone(phone) {
  return String(phone || '').replace(/[\s-]/g, '').slice(0, 32);
}

// === Admin creates a booking on a customer's behalf ========================
// Walk-in / phone bookings used to have NO entry path — the only writer was
// the public form, so the front desk either typed bookings into the public
// page (losing the admin audit trail) or skipped the booking step entirely
// (losing the room reservation + deposit paper trail). This endpoint mirrors
// the public path's guarantees with the SAME locks and dual-writes:
//   - bookings blob + rooms blob + rooms_v2 locked FOR UPDATE in one tx
//   - room must be vacant in BOTH sources before it flips to 'reserved'
//   - relational dual-write (source='admin-manual') with legacy fallback
//   - deposit credit math identical to the public flow
// plus admin-specific safeguards the public path can't do:
//   - blacklist refusal (same rule the approve paths enforce later — fail
//     at the door, not after the customer already paid)
//   - duplicate guard: an open booking with the same phone for the same
//     room is almost always a double-submit
// Staff may create bookings (it's the front-desk job); approval stays
// owner/manager-gated like before.
app.post('/api/bookings', sameOrigin, csrfGuard, requireAuth,
  requireRole('owner', 'manager', 'staff'), validateBody(schemas.adminBooking),
  async (req, res) => {
  const b = req.body;
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const cleaned = {
    roomId:      str(b.roomId, 32).trim(),
    tenantName:  str(b.tenantName, 120).trim(),
    phone:       str(b.phone, 32).trim(),
    email:       str(b.email, 120).trim(),
    checkInDate: str(b.checkInDate, 16).trim(),
    floor:       str(b.floor, 4).trim(),
    roomType:    str(b.roomType, 32),
    message:     str(b.message, 500),
  };
  const months = Number.isInteger(b.months) ? b.months : 12;
  if (cleaned.checkInDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned.checkInDate)) {
      return res.status(400).json({ error: 'checkInDate ต้องเป็น YYYY-MM-DD', code: 'INVALID_DATE' });
    }
    const target = new Date(cleaned.checkInDate + 'T00:00:00Z');
    const today = new Date(billing.localTodayYmd() + 'T00:00:00Z');
    const diff = (target - today) / 86_400_000;
    // Slightly wider past-window than the public form (-30 vs -7): the front
    // desk occasionally records a booking the day after the phone call.
    if (diff < -30 || diff > 365) {
      return res.status(400).json({
        error: `วันเข้าพัก (${cleaned.checkInDate}) อยู่นอกช่วงที่อนุญาต (ย้อนหลัง ≤ 30 วัน / ล่วงหน้า ≤ 365 วัน)`,
        code: 'MOVE_IN_OUT_OF_WINDOW',
      });
    }
  }
  let bookingSettings;
  try {
    ({ settings: bookingSettings } = await publicBookingDepositInfo());
  } catch (err) {
    console.error('admin booking config load error:', err);
    return res.status(500).json({ error: 'internal error', code: 'CONFIG_ERROR' });
  }
  // NOTE: bookingSettings.enabled gates the PUBLIC form only — admin can
  // record bookings even while online booking is switched off (that's the
  // point of the flexibility: walk-in business doesn't stop).
  const normalisedPhone = normaliseBookingPhone(cleaned.phone);
  // Blacklist refusal — the approve / quick-invite / booking-approve paths
  // all refuse blacklisted tenants later; refusing HERE means the customer
  // is told at the counter, not after they've waited days for review.
  try {
    const black = await pool.query(
      `SELECT id, full_name FROM tenants
         WHERE deleted_at IS NULL AND status='blacklist'
           AND REPLACE(REPLACE(COALESCE(phone, ''), ' ', ''), '-', '')=$1
         LIMIT 1`,
      [normalisedPhone]
    );
    if (black.rows.length) {
      return res.status(409).json({
        error: `เบอร์นี้ตรงกับผู้เช่าใน blacklist (${black.rows[0].full_name || 'ไม่ระบุชื่อ'}) — ไม่สามารถรับจองได้`,
        code: 'TENANT_BLACKLISTED',
        tenantId: black.rows[0].id,
        hint: 'ตรวจประวัติที่หน้าผู้เช่า หากต้องการรับกลับจริง ให้ปลดสถานะ blacklist อย่างตั้งใจก่อน แล้วค่อยจองใหม่',
      });
    }
  } catch (err) {
    if (err.code !== '42P01' && err.code !== '42703') {
      console.warn('[admin-booking] blacklist check skipped:', err.message);
    }
  }
  // Same "already an active tenant" advisory the public path attaches —
  // not a block (tenant booking a second room for family is legitimate),
  // but the approver must see it.
  let applicantRisk = null;
  try {
    const existingTenant = await pool.query(
      `SELECT id, full_name, current_room_id
         FROM tenants
        WHERE deleted_at IS NULL AND status='active'
          AND (phone=$1 OR REPLACE(REPLACE(COALESCE(phone, ''), ' ', ''), '-', '')=$2)
        ORDER BY updated_at DESC
        LIMIT 1`,
      [cleaned.phone, normalisedPhone]
    );
    if (existingTenant.rows.length) {
      const t = existingTenant.rows[0];
      applicantRisk = {
        code: 'APPLICANT_PHONE_ALREADY_ACTIVE_TENANT',
        tenantId: t.id,
        tenantName: t.full_name || null,
        currentRoomId: t.current_room_id || null,
        message: t.current_room_id
          ? `เบอร์นี้มีผู้เช่า active อยู่ห้อง ${t.current_room_id} แล้ว`
          : 'เบอร์นี้มีผู้เช่า active อยู่แล้ว',
        nextAction: 'ยืนยันว่าเป็นผู้เช่าเดิมจองอีกห้อง หรือจองแทนคนอื่น ก่อนอนุมัติและสร้างสัญญา',
      };
    }
  } catch (err) {
    if (err.code !== '42P01' && err.code !== '42703') {
      console.warn('[admin-booking] active-tenant risk check skipped:', err.message);
    }
  }
  const VALID_TYPES = ['standard', 'deluxe', 'suite', 'studio'];
  const wantType = VALID_TYPES.includes(cleaned.roomType) ? cleaned.roomType : 'standard';
  const wantFloor = Number(cleaned.floor) || null;
  const bookingId = 'BK-ADM-' + require('crypto').randomBytes(6).toString('hex');
  const createdBy = req.session.user.username;
  // Deposit attestation: depositCollected=true means the admin HOLDS the
  // booking fee already (cash on the counter / transfer they verified on
  // their own banking app). depositStatus='verified' + provider='manual'
  // reuses the exact states the approve checklist already understands.
  const depositCollected = b.depositCollected === true
    && bookingSettings.requireDeposit && Number(bookingSettings.depositAmount) > 0;
  const depositRequired = depositCollected;
  const newBooking = {
    id: bookingId,
    name: cleaned.tenantName,
    phone: cleaned.phone,
    wantType,
    wantFloor,
    moveIn: cleaned.checkInDate || null,
    months,
    deposit: depositCollected ? bookingSettings.depositAmount : 0,
    depositRequired,
    bookingFee: depositCollected ? bookingSettings.depositAmount : 0,
    bookingFeeAppliesToDeposit: depositCollected ? bookingSettings.applyBookingFeeToDeposit : false,
    depositMinimumAmount: bookingSettings.minimumAmount,
    depositCreditAmount: 0,
    depositBalanceDue: null,
    contractDepositEstimate: null,
    depositStatus: depositCollected ? 'verified' : 'not_required',
    depositSlipUrl: null,
    depositSlipFileId: null,
    depositSlipHash: null,
    depositVerifyProvider: depositCollected ? 'manual' : null,
    depositVerifyCode: null,
    depositVerifyReason: depositCollected
      ? `แอดมิน ${createdBy} ยืนยันว่าเก็บค่าจองแล้ว (${b.depositPaymentMethod || 'cash'})`
      : null,
    depositVerifyAttempts: [],
    depositVerifiedAt: depositCollected ? new Date().toISOString() : null,
    depositTransactionRef: null,
    depositPaymentMethod: depositCollected ? (b.depositPaymentMethod || 'cash') : null,
    depositVerification: null,
    holdTokenHash: null,
    holdExpiresAt: null,
    reservedAt: null,
    status: 'pending',
    createdAt: new Date().toISOString(),
    createdBy,
    email: cleaned.email,
    message: cleaned.message,
    riskFlags: applicantRisk ? [applicantRisk.code] : [],
    applicantRisk,
    source: 'admin-manual',
    roomId: cleaned.roomId || '',
    citizenIdTail: null,
    citizenIdImageFrontId: null,
    agreedTermsVersion: null,
    agreedTermsAt: null,
  };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT value FROM app_data WHERE key=$1 FOR UPDATE',
      ['baankarn_bookings_v1']
    );
    const list = (rows.length && Array.isArray(rows[0].value)) ? rows[0].value : [];
    // Duplicate guard — an OPEN booking for the same phone (and same room
    // when one is named) is a double-submit, not a second customer.
    const openStatuses = new Set(['pending', 'reviewing', 'approved']);
    const dup = list.find((x) => x
      && openStatuses.has(String(x.status || 'pending'))
      && normaliseBookingPhone(x.phone) === normalisedPhone
      && (!cleaned.roomId || String(x.assignedRoomId || x.roomId || '') === cleaned.roomId));
    if (dup) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `เบอร์นี้มีการจองค้างอยู่แล้ว (${dup.id}${dup.roomId ? ` · ห้อง ${dup.roomId}` : ''} · ${dup.status})`,
        code: 'DUPLICATE_BOOKING',
        existingBookingId: dup.id,
        hint: 'เปิดการจองเดิมเพื่อดำเนินการต่อ หรือยกเลิกของเดิมก่อนถ้าลูกค้าเปลี่ยนใจ',
      });
    }
    if (cleaned.roomId) {
      await releaseExpiredPublicBookingHolds(client);
      const roomRow = await client.query(
        `SELECT value FROM app_data WHERE key='baankarn_rooms_v1' FOR UPDATE`
      );
      const rooms = roomRow.rows.length && roomRow.rows[0].value && typeof roomRow.rows[0].value === 'object'
        ? roomRow.rows[0].value
        : {};
      let room = rooms[cleaned.roomId] || null;
      let v2Room = null;
      try {
        const v2 = await client.query(
          `SELECT room_code, room_type, floor, room_no, rent_price, deposit_price, wifi_fee, status,
                  view_type, has_balcony, has_parking, has_kitchen, has_ac,
                  rent_override, rent_override_reason
             FROM rooms_v2
            WHERE room_code=$1 AND deleted_at IS NULL
            FOR UPDATE`,
          [cleaned.roomId]
        );
        v2Room = v2.rows[0] || null;
        if (!room && v2Room) room = pricingImpactRoomFromV2(v2Room);
      } catch (err) {
        if (err.code !== '42P01') throw err;
      }
      if (!room) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'ไม่พบห้องนี้', code: 'ROOM_NOT_FOUND' });
      }
      const vacant = isVacantStatus(room.status) && (!v2Room || isVacantStatus(v2Room.status));
      if (!vacant) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: isPublicHoldRoom(room)
            ? 'ห้องนี้ถูกล็อกโดยผู้จองหน้าเว็บอยู่ — รอหมดเวลาล็อกหรือเลือกห้องอื่น'
            : `ห้องนี้ไม่ว่างสำหรับจอง (${room.status})`,
          code: isPublicHoldRoom(room) ? 'ROOM_HELD' : 'ROOM_NOT_VACANT',
          currentStatus: room.status,
          expiresAt: isPublicHoldRoom(room) ? (room.reservationExpiresAt || null) : null,
        });
      }
      let pricingConfig = {};
      try {
        const cfgQ = await client.query(
          `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
        );
        pricingConfig = cfgQ.rows[0]?.value || {};
      } catch { /* deposit estimate falls back through the resolver */ }
      const bookingRentInfo = pricing.resolveBillingRent({ room, config: pricingConfig });
      const bookingDepositInfo = pricing.resolveContractDeposit({
        room,
        config: pricingConfig,
        rent: bookingRentInfo.rent,
      });
      const contractDepositEstimate = Math.max(0, Number(bookingDepositInfo.deposit) || 0);
      const depositCreditAmount = depositCollected && newBooking.bookingFeeAppliesToDeposit
        ? Math.min(Number(newBooking.bookingFee) || 0, contractDepositEstimate)
        : 0;
      newBooking.contractDepositEstimate = contractDepositEstimate;
      newBooking.depositCreditAmount = depositCreditAmount;
      newBooking.depositBalanceDue = contractDepositEstimate > 0
        ? Math.max(contractDepositEstimate - depositCreditAmount, 0)
        : null;
      const reservedAt = new Date().toISOString();
      newBooking.reservedAt = reservedAt;
      newBooking.assignedRoomId = cleaned.roomId;
      rooms[cleaned.roomId] = {
        ...room,
        id: room.id || cleaned.roomId,
        status: 'reserved',
        tenant: {
          name: cleaned.tenantName,
          phone: cleaned.phone || '',
          email: cleaned.email || '',
          occupation: '',
          score: 'A',
          since: billing.localTodayYmd(),
        },
        reservedBy: newBooking.id,
        reservedAt,
        reservationMode: 'admin_booking',
        depositStatus: newBooking.depositStatus,
        bookingFee: newBooking.bookingFee,
        bookingFeeAppliesToDeposit: newBooking.bookingFeeAppliesToDeposit,
        depositCreditAmount: newBooking.depositCreditAmount,
        depositBalanceDue: newBooking.depositBalanceDue,
      };
      delete rooms[cleaned.roomId].reservationExpiresAt;
      delete rooms[cleaned.roomId].holdExpiresAt;
      delete rooms[cleaned.roomId].holdTokenHash;
      await client.query(
        `INSERT INTO app_data (key, value, updated_by) VALUES ($1, $2, $3)
           ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW(), updated_by=EXCLUDED.updated_by`,
        ['baankarn_rooms_v1', JSON.stringify(rooms), createdBy]
      );
      try {
        const reserveV2 = await client.query(
          `UPDATE rooms_v2 SET status='reserved', updated_at=NOW()
             WHERE room_code=$1 AND status='vacant' AND deleted_at IS NULL`,
          [cleaned.roomId]
        );
        if (v2Room && reserveV2.rowCount !== 1) {
          throw Object.assign(new Error('room no longer vacant'), { code: 'ROOM_NOT_VACANT' });
        }
      } catch (err) {
        if (err.code === '42P01') {
          // legacy deploy without rooms_v2: the JSONB reservation above is enough
        } else if (err.code === 'ROOM_NOT_VACANT') {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'ห้องนี้ไม่ว่างสำหรับจอง', code: 'ROOM_NOT_VACANT' });
        } else {
          throw err;
        }
      }
    }
    list.unshift(newBooking);
    const capped = list.slice(0, 500);
    await client.query(
      `INSERT INTO app_data (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      ['baankarn_bookings_v1', JSON.stringify(capped), createdBy]
    );
    // Relational dual-write — same columns as the public path, with the
    // legacy-deploy fallback. Best-effort by design (blob is the read model).
    try {
      await client.query(
        `INSERT INTO bookings
            (external_id, name, phone, email, want_type, want_floor,
             move_in, months, deposit, status, source, message, room_id,
             deposit_required, booking_fee, booking_fee_applies_to_deposit,
             deposit_credit_amount, deposit_balance_due, deposit_minimum_amount,
             deposit_status, deposit_verify_provider, deposit_verify_reason,
             deposit_verified_at, deposit_payment_method, reserved_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending','admin-manual',$10,$11,
                  $12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
          ON CONFLICT (external_id) DO NOTHING`,
        [
          newBooking.id, newBooking.name, newBooking.phone || null,
          cleaned.email || null, wantType, wantFloor,
          cleaned.checkInDate || null, months, newBooking.deposit,
          cleaned.message || null, cleaned.roomId || null,
          newBooking.depositRequired,
          newBooking.bookingFee || 0,
          newBooking.bookingFeeAppliesToDeposit === true,
          newBooking.depositCreditAmount || 0,
          newBooking.depositBalanceDue,
          newBooking.depositMinimumAmount || 0,
          newBooking.depositStatus || null,
          newBooking.depositVerifyProvider || null,
          newBooking.depositVerifyReason || null,
          newBooking.depositVerifiedAt || null,
          newBooking.depositPaymentMethod || null,
          newBooking.reservedAt || null,
        ]
      );
    } catch (err) {
      if (err.code === '42703') {
        try {
          await client.query(
            `INSERT INTO bookings
                (external_id, name, phone, email, want_type, want_floor,
                 move_in, months, deposit, status, source, message, room_id)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending','admin-manual',$10,$11)
              ON CONFLICT (external_id) DO NOTHING`,
            [
              newBooking.id, newBooking.name, newBooking.phone || null,
              cleaned.email || null, wantType, wantFloor,
              cleaned.checkInDate || null, months, newBooking.deposit,
              cleaned.message || null, cleaned.roomId || null,
            ]
          );
        } catch (e2) {
          console.warn('[admin-booking] relational dual-write fallback also failed:', e2.message);
        }
      } else {
        console.warn('[admin-booking] relational dual-write skipped:', err.message);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('admin booking create error:', err);
    return res.status(500).json({ error: 'internal error' });
  } finally {
    client.release();
  }
  audit(req, 'booking.create', 'booking', bookingId, {
    source: 'admin-manual',
    roomId: cleaned.roomId || null,
    wantType,
    wantFloor,
    depositCollected,
    depositPaymentMethod: newBooking.depositPaymentMethod,
    applicantRisk: applicantRisk ? applicantRisk.code : null,
  });
  // Owner visibility when a STAFF account books — owner/manager are the
  // approvers, so a staff-recorded booking should land in their inbox the
  // same way a public one does. Owner/manager creating their own booking
  // already know about it; skip the self-notification.
  if (req.session.user.role === 'staff') {
    const flags = req.features || (await features.load(pool).catch(() => ({})));
    notifier.notifyOwner({ pool, features: flags }, {
      category: 'booking',
      subject: `📋 จองใหม่ (โดยแอดมิน ${createdBy})`,
      text: `ชื่อ: ${cleaned.tenantName}\nโทร: ${cleaned.phone || '-'}\n`
        + `ห้อง: ${cleaned.roomId || 'ยังไม่ระบุ'}\nวันเข้าพัก: ${cleaned.checkInDate || '-'}\n`
        + `ค่าจอง: ${depositCollected ? `฿${Number(newBooking.bookingFee).toLocaleString('th-TH')} (เก็บแล้ว · ${newBooking.depositPaymentMethod})` : 'ยังไม่เก็บ'}\n`
        + `${applicantRisk ? `⚠️ ${applicantRisk.message}\n` : ''}`
        + `รหัสการจอง: ${bookingId}\n— เปิด /admin#bookings เพื่อตรวจสอบและอนุมัติ`,
    }).catch(() => {});
  }
  res.json({ ok: true, booking: newBooking, applicantRisk });
});

async function ensureApprovedBookingTenant(client, { booking, roomId }) {
  const fullName = String(booking?.name || booking?.tenantName || '').slice(0, 200).trim();
  const phone = normaliseBookingPhone(booking?.phone);
  const email = booking?.email ? String(booking.email).slice(0, 200).trim() : null;
  const currentRoomId = String(roomId || '').slice(0, 32).trim();
  if (!fullName || !phone || !currentRoomId) return null;

  // Blacklist is PHONE-keyed: a blacklisted person who books under a slightly
  // different name spelling ("Somchai S." vs "Somchai Suk") must not slip past
  // the exact name+phone match below. This phone-only pre-check matches the
  // public/admin risk computation and closes that name-variant evasion.
  const blacklisted = await client.query(
    `SELECT id FROM tenants
       WHERE deleted_at IS NULL AND status='blacklist'
         AND REPLACE(REPLACE(COALESCE(phone, ''), ' ', ''), '-', '')=$1
       LIMIT 1`,
    [phone]
  );
  if (blacklisted.rows.length) {
    const err = new Error('ผู้จองรายนี้อยู่ใน blacklist ไม่สามารถอนุมัติและสร้าง tenant อัตโนมัติได้');
    err.httpStatus = 409;
    err.publicCode = 'TENANT_BLACKLISTED';
    err.hint = 'ตรวจสอบประวัติผู้เช่าก่อนอนุมัติ booking หรือปลด blacklist อย่างตั้งใจก่อนดำเนินการต่อ';
    throw err;
  }

  const existing = await client.query(
    `SELECT id, status FROM tenants
       WHERE phone=$1 AND lower(full_name)=lower($2)
         AND deleted_at IS NULL
       LIMIT 1
       FOR UPDATE`,
    [phone, fullName]
  );
  if (existing.rows.length) {
    if (existing.rows[0].status === 'blacklist') {
      const err = new Error('ผู้จองรายนี้อยู่ใน blacklist ไม่สามารถอนุมัติและสร้าง tenant อัตโนมัติได้');
      err.httpStatus = 409;
      err.publicCode = 'TENANT_BLACKLISTED';
      err.hint = 'ตรวจสอบประวัติผู้เช่าก่อนอนุมัติ booking หรือปลด blacklist อย่างตั้งใจก่อนดำเนินการต่อ';
      throw err;
    }
    const upd = await client.query(
      `UPDATE tenants
          SET full_name=$1,
              email=COALESCE($2, email),
              current_room_id=$3,
              status='active',
              updated_at=NOW()
        WHERE id=$4
        RETURNING id`,
      [fullName, email, currentRoomId, existing.rows[0].id]
    );
    return upd.rows[0]?.id || existing.rows[0].id;
  }

  const ins = await client.query(
    `INSERT INTO tenants (full_name, phone, email, current_room_id, status, locale)
     VALUES ($1, $2, $3, $4, 'active', 'th')
     RETURNING id`,
    [fullName, phone, email, currentRoomId]
  );
  return ins.rows[0]?.id || null;
}

function summariseBookingApplicantNotify(result, tenantInfo) {
  const out = result || {};
  const fallbackLineCount = (tenantInfo.lineRecipients && tenantInfo.lineRecipients.length)
    || (tenantInfo.line_user_id ? 1 : 0);
  const lineRecipientCount = Number.isFinite(Number(out.lineRecipientCount))
    ? Number(out.lineRecipientCount)
    : fallbackLineCount;
  return {
    attempted: true,
    ok: out.ok === true,
    queued: out.queued === true,
    channel: out.channel || 'none',
    oa: out.oa || null,
    recipients: out.recipients || null,
    failedRecipients: out.failedRecipients || null,
    lineRecipientCount,
    skipped: out.skipped === true,
    reason: out.reason || null,
    requiresManualContact: !(out.ok === true || out.queued === true),
    hasLine: lineRecipientCount > 0,
    hasEmail: !!tenantInfo.email,
    hasPhone: !!tenantInfo.phone,
    phone: tenantInfo.phone || null,
    email: tenantInfo.email || null,
  };
}

function bookingNotifyOwnerLine(result) {
  if (!result) return null;
  const countText = Number(result.lineRecipientCount) > 0
    ? ` — ห้องนี้ผูก LINE ทั้งหมด ${Number(result.lineRecipientCount)} บัญชี`
    : '';
  if (result.ok) {
    return `แจ้งผู้จองแล้วทาง ${result.channel || '-'}${countText}`;
  }
  if (result.queued) {
    return `เข้าคิวแจ้งผู้จองแล้ว (${result.channel || '-'})${countText}`;
  }
  if (result.requiresManualContact) {
    return `ยังแจ้งผู้จองอัตโนมัติไม่ได้ — กรุณาโทรแจ้ง${result.phone ? ` ${result.phone}` : ''}${countText}`;
  }
  return null;
}

async function notifyBookingApplicantStatus({ pool, flags, booking, subject, text, roomId }) {
  const phone = normaliseBookingPhone(booking && booking.phone);
  const tenantInfo = {
    full_name: booking?.name || booking?.tenantName || null,
    email: booking?.email || null,
    phone: phone || null,
    line_user_id: null,
    line_oa_id: null,
    lineRecipients: [],
  };
  if (booking?.id) {
    try {
      tenantInfo.lineRecipients = await lineBinding.listBookingRecipients(pool, booking.id);
    } catch { /* ignore booking-recipient lookup failure */ }
  }
  const hasBookingLineRecipients = tenantInfo.lineRecipients.length > 0;

  // LINE enrichment is intentionally limited to the active tenant for the
  // exact room involved in this booking. A public booking applicant may share
  // a phone with an old/current tenant record, especially when booking for a
  // friend or requesting another room. If the booking already has its own
  // pre-bound LINE recipients, keep the decision notice scoped there. If it
  // does not, never fall back to a phone-only tenant LINE because that can
  // notify the wrong person; phone/SMS remains available via tenantInfo.phone.
  if (phone && !hasBookingLineRecipients && roomId) {
    try {
      const tq = await pool.query(
        `SELECT id, line_user_id, line_oa_id, email
           FROM tenants
          WHERE phone=$1 AND current_room_id=$2
            AND deleted_at IS NULL AND status='active'
          ORDER BY updated_at DESC LIMIT 1`,
        [phone, roomId]
      );
      if (tq.rows.length) {
        tenantInfo.id = tq.rows[0].id;
        tenantInfo.line_user_id = tq.rows[0].line_user_id;
        tenantInfo.line_oa_id = tq.rows[0].line_oa_id;
        if (!tenantInfo.email && tq.rows[0].email) tenantInfo.email = tq.rows[0].email;
      }
    } catch { /* ignore enrichment failure; email/SMS can still work */ }
  }

  if (!tenantInfo.line_user_id && !tenantInfo.lineRecipients.length && !tenantInfo.email && !tenantInfo.phone) {
    return {
      attempted: false,
      ok: false,
      queued: false,
      channel: 'none',
      requiresManualContact: true,
      reason: 'no_contact',
      hasLine: false,
      hasEmail: false,
      hasPhone: false,
      lineRecipientCount: 0,
      phone: null,
      email: null,
    };
  }

  try {
    const result = await notifier.notifyTenant(
      { pool, features: flags },
      tenantInfo,
      { subject, text }
    );
    return summariseBookingApplicantNotify(result, tenantInfo);
  } catch (err) {
    return {
      attempted: true,
      ok: false,
      queued: false,
      channel: 'none',
      requiresManualContact: true,
      reason: err.message || 'notify_failed',
      hasLine: !!tenantInfo.line_user_id || !!(tenantInfo.lineRecipients && tenantInfo.lineRecipients.length),
      hasEmail: !!tenantInfo.email,
      hasPhone: !!tenantInfo.phone,
      lineRecipientCount: (tenantInfo.lineRecipients && tenantInfo.lineRecipients.length) || (tenantInfo.line_user_id ? 1 : 0),
      phone: tenantInfo.phone || null,
      email: tenantInfo.email || null,
    };
  }
}

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
  let tenantNotify = null;
  let preContractTenantId = null;
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
      return res.status(404).json({
        error: `ไม่พบ booking ${id}`,
        code: 'BOOKING_NOT_FOUND',
        hint: 'กลับไปหน้า booking แล้วเปิดรายการล่าสุดอีกครั้ง ข้อมูลบนหน้าจออาจเก่าแล้ว',
        nextActions: {
          bookingsUrl: '/admin#bookings',
        },
      });
    }
    const booking = bookings[bIdx];
    // Transition guard — match the BOOKING_TRANSITIONS rules.
    const allowedFrom = new Set(['pending', 'reviewing']);
    if (!allowedFrom.has(booking.status || 'pending')) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `cannot approve from status "${booking.status}"`,
        code: 'BAD_TRANSITION',
        currentStatus: booking.status || 'pending',
        requestedStatus: 'approved',
        allowed: ['pending', 'reviewing'],
        hint: 'รายการนี้ไม่ได้อยู่ในขั้นตอนที่อนุมัติได้แล้ว ให้รีเฟรชหน้า booking แล้วใช้รายการสถานะล่าสุด',
        nextActions: {
          bookingsUrl: '/admin#bookings',
        },
      });
    }
    if (booking.depositRequired && ['awaiting_slip', 'rejected'].includes(booking.depositStatus)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: booking.depositStatus === 'rejected'
          ? 'สลิปค่าจองไม่ผ่าน ไม่สามารถอนุมัติการจองได้'
          : 'ยังไม่มีสลิปค่าจอง ไม่สามารถอนุมัติการจองได้',
        code: 'BOOKING_DEPOSIT_NOT_READY',
        hint: 'ให้ผู้จองส่งสลิปใหม่ หรือเปลี่ยนสถานะเป็นตรวจสอบหลังแอดมินตรวจยอดด้วยมือแล้ว',
        nextActions: {
          bookingsUrl: `/admin#bookings?booking=${encodeURIComponent(id)}`,
        },
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
    let preclaimedCandidate = null;
    const preclaimedRoomId = String(booking.assignedRoomId || booking.roomId || '').trim();
    if (preclaimedRoomId) {
      const blobPreclaimed = rooms && rooms[preclaimedRoomId]
        ? { id: rooms[preclaimedRoomId].id || preclaimedRoomId, ...rooms[preclaimedRoomId] }
        : null;
      let v2Preclaimed = null;
      try {
        const v2Pre = await client.query(
          `SELECT room_code, room_type, floor, room_no, rent_price, deposit_price, wifi_fee, status
             FROM rooms_v2
             WHERE room_code=$1 AND deleted_at IS NULL
             FOR UPDATE`,
          [preclaimedRoomId]
        );
        v2Preclaimed = v2Pre.rows[0] || null;
      } catch (err) {
        if (err.code !== '42P01') throw err;
      }
      const candidateRoom = blobPreclaimed || (v2Preclaimed ? roomFromV2(v2Preclaimed) : null);
      const ownedByThisBooking = candidateRoom
        && candidateRoom.status === 'reserved'
        && String(candidateRoom.reservedBy || '') === id;
      const v2Compatible = !v2Preclaimed || ['reserved', 'vacant'].includes(v2Preclaimed.status);
      // Do NOT re-apply the want(type/floor) filter to a room this booking
      // already reserved. wantType/wantFloor are a PREFERENCE used to AUTO-pick
      // a room when the applicant didn't choose one — but here the applicant
      // explicitly selected and locked this exact room (often paying a deposit
      // hold on it). Re-filtering it spuriously rejected rooms whose blob entry
      // lacks type/floor metadata (e.g. wantType defaulted to 'standard' while
      // the reserved room carries no type), then assigned a DIFFERENT room and
      // left the originally-reserved room stuck 'reserved' (orphaned). The
      // applicant's explicit reservation wins.
      if (ownedByThisBooking && v2Compatible) {
        preclaimedCandidate = { ...candidateRoom, _source: 'preclaimed' };
      }
    }
    const rawBlobCandidates = Object.entries(rooms || {})
      .map(([roomCode, room]) => ({ id: room?.id || roomCode, ...(room || {}) }))
      .filter((r) => r && isVacantStatus(r.status) && want(r));

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

    // Prefer the lowest room id, but de-duplicate JSONB+rooms_v2 matches.
    // When JSONB says "vacant" but rooms_v2 says otherwise, skip the room:
    // rooms_v2 is the source used by newer admin room CRUD, so approving
    // against stale JSONB would double-reserve an occupied/reserved room.
    const sortedCandidates = [...rawBlobCandidates, ...v2Candidates]
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    let candidate = preclaimedCandidate;
    if (!candidate) {
      const seenRoomIds = new Set();
      for (const cand of sortedCandidates) {
        const roomId = String(cand.id || '').trim();
        if (!roomId || seenRoomIds.has(roomId)) continue;
        seenRoomIds.add(roomId);
        if (cand._source !== 'v2') {
          try {
            const v2State = await client.query(
              `SELECT status FROM rooms_v2
                 WHERE room_code=$1 AND deleted_at IS NULL
                 FOR UPDATE`,
              [roomId]
            );
            if (v2State.rows.length && !isVacantStatus(v2State.rows[0].status)) {
              continue;
            }
          } catch (err) {
            if (err.code !== '42P01') throw err;
          }
        }
        candidate = cand;
        break;
      }
    }

    let assignedRoomId = null;
    if (!candidate) {
      // Refuse the approval when no vacant room matches the booking's
      // wanted type/floor. Previously this branch silently completed
      // the approval with `assignedRoomId=null`, leaving a "phantom
      // approved" booking that no longer auto-reserves. Admin had to
      // remember to come back and manually assign — which is the kind
      // of state that drops through the cracks. Refusing here keeps
      // the booking at 'pending'/'reviewing' so the next time a room
      // opens up admin re-tries cleanly.
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'ไม่มีห้องว่างที่ตรงกับเงื่อนไขการจอง (ประเภท/ชั้น)',
        code: 'NO_VACANT_ROOM_MATCH',
        hint: 'รอห้องว่าง หรือเปิด /admin#rooms มอบหมายห้องด้วยตนเอง '
            + 'หรือใช้ปุ่ม "ปรับสถานะ" ที่หน้า booking',
        nextActions: {
          roomsUrl: '/admin#rooms',
          bookingsUrl: `/admin#bookings?booking=${encodeURIComponent(id)}`,
        },
      });
    }
    {
      assignedRoomId = candidate.id;
      // Refuse rooms that already carry an active contract — locked OR still
      // waiting for the tenant to sign. Check-in has this exact guard but
      // booking-approve didn't, so an approval could claim a room whose
      // contract flow for ANOTHER tenant was already in flight: two "active"
      // tenants both pointing at the room, and the contract holder's
      // invitation forever un-approvable against the new occupant.
      let roomContract = null;
      try {
        const fcQ = await client.query(
          `SELECT id, contract_no, tenant_id, locked_at
             FROM contracts
            WHERE room_id=$1 AND status='active' AND deleted_at IS NULL
            ORDER BY locked_at DESC NULLS LAST, created_at DESC
            LIMIT 1
            FOR UPDATE`,
          [String(assignedRoomId)]
        );
        roomContract = fcQ.rows[0] || null;
      } catch (err) {
        if (err.code !== '42P01') throw err;
      }
      if (roomContract) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `ห้อง ${assignedRoomId} มีสัญญาเช่า${roomContract.locked_at ? 'มีผล' : 'ที่รอผู้เช่าลงนาม'}อยู่แล้ว (${roomContract.contract_no || roomContract.id})`,
          code: 'ROOM_CONTRACT_EXISTS',
          conflict: roomContract,
          hint: 'อนุมัติ booking นี้เข้าห้องนี้ไม่ได้จนกว่าจะจัดการสัญญาเดิม — ใช้สัญญาเดิมต่อ ยกเลิกสัญญาเดิมถ้าซ้ำซ้อน หรือมอบหมาย booking นี้เข้าห้องอื่น',
          nextActions: {
            contractsUrl: `/admin#contracts?room=${encodeURIComponent(assignedRoomId)}&contract=${encodeURIComponent(roomContract.id)}`,
            bookingsUrl: `/admin#bookings?booking=${encodeURIComponent(id)}`,
          },
        });
      }
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
          since: billing.localTodayYmd(),
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
      try {
        const v2Reserve = await client.query(
          `UPDATE rooms_v2 SET status='reserved', updated_at=NOW()
             WHERE room_code=$1 AND status='vacant' AND deleted_at IS NULL`,
          [candidate.id]
        );
        if (candidate._source === 'v2' && v2Reserve.rowCount !== 1) {
          throw new Error('rooms_v2 reservation failed: room no longer vacant');
        }
      } catch (err) {
        if (err.code !== '42P01') throw err;
      }
    }

    // Update the booking entry.
    if (assignedRoomId) {
      preContractTenantId = await ensureApprovedBookingTenant(client, {
        booking,
        roomId: assignedRoomId,
      });
    }
    // Approving a booking whose deposit slip sits in a review state IS the
    // human verification — the approve drawer shows the slip + verifier
    // outcome, and the admin clicked "อนุมัติ" with that on screen. Stamp
    // the deposit verified so (a) the booking checklist stops warning
    // forever, (b) /api/reports/booking-fees counts the money as confirmed
    // received instead of perpetually "รอตรวจ". awaiting_slip / rejected
    // can't reach here (the guard above refuses approval), so this only
    // promotes slips a human actually saw.
    const DEPOSIT_REVIEW_STATES = new Set(['pending_review', 'manual_review', 'submitted']);
    const stampDepositVerified = !!(booking.depositRequired
      && Number(booking.bookingFee) > 0
      && DEPOSIT_REVIEW_STATES.has(String(booking.depositStatus || '')));
    const depositStamp = stampDepositVerified ? {
      depositStatus: 'verified',
      depositVerifiedAt: new Date().toISOString(),
      depositVerifyReason: `ยืนยันพร้อมการอนุมัติการจองโดย ${req.session.user.username}`,
      depositVerifyProvider: booking.depositVerifyProvider || 'manual',
    } : null;
    bookings[bIdx] = {
      ...booking,
      ...(depositStamp || {}),
      status: 'approved',
      roomId: assignedRoomId || booking.roomId || null,
      tenantId: preContractTenantId || booking.tenantId || null,
      adminNotes: adminNotes !== undefined ? adminNotes : booking.adminNotes,
      assignedRoomId,
      approvedAt: new Date().toISOString(),
      approvedBy: req.session.user.username,
      updatedAt: new Date().toISOString(),
      updatedBy: req.session.user.username,
    };
    // Keep the room's reservation copy of the deposit state in step with the
    // booking (the public create path copies it; without this the room shows
    // the stale pre-approval state until the next full room save).
    if (depositStamp && assignedRoomId && rooms[assignedRoomId]
        && 'depositStatus' in rooms[assignedRoomId]) {
      rooms[assignedRoomId].depositStatus = depositStamp.depositStatus;
    }

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
      if (depositStamp) {
        // Separate statement so legacy deploys missing the deposit columns
        // (42703) only lose the deposit mirror, not the status mirror above.
        await client.query(
          `UPDATE bookings
              SET deposit_status=$2,
                  deposit_verified_at=NOW(),
                  deposit_verify_reason=$3,
                  updated_at=NOW()
            WHERE external_id=$1`,
          [id, depositStamp.depositStatus, depositStamp.depositVerifyReason]
        ).catch((err) => {
          if (err.code !== '42703') throw err;
        });
      }
    } catch (err) {
      console.warn('[booking] relational status sync skipped:', err.message);
    }
    await client.query('COMMIT');

    audit(req, 'booking.approve', 'booking', id, {
      assignedRoomId, wantType: booking.wantType, wantFloor: booking.wantFloor,
      preContractTenantId,
      depositVerifiedOnApprove: stampDepositVerified || undefined,
    });
    // Full bridge remains a best-effort cleanup for legacy room edits, but
    // approve-and-assign already wrote the selected applicant's tenant row
    // inside the transaction above so the next contract page can open
    // immediately without racing this async mirror.
    if (assignedRoomId) {
      mirrorRoomsToTenants(rooms, req.session.user.username).catch(async (err) => {
        console.error('[bridge] rooms→tenants mirror failed after approve:', err.message);
        // Same failure-alert pattern as the rooms PUT bridge. After a
        // booking approval the room blob says 'reserved' but if the tenant
        // upsert failed there's no tenants row → checkin will create a
        // FRESH tenant + contract leaving an orphan, the scheduler can't
        // bill the room, and /admin#rooms shows a phantom resident. Loud
        // alert so the operator notices BEFORE the tenant moves in.
        try {
          const flags = await features.load(pool).catch(() => ({}));
          await notifier.notifyOwner({ pool, features: flags }, {
            category: 'booking',
            subject: `⚠️ อนุมัติการจอง ${id} แล้ว แต่บันทึกผู้เช่าไม่สมบูรณ์`,
            text: [
              `การจอง ${id} (${booking.name || '-'} · ${booking.phone || '-'}) อนุมัติแล้ว`,
              `จัดห้อง: ${assignedRoomId}`,
              '',
              `❌ แต่ระบบสร้างข้อมูลผู้เช่าในทะเบียนผู้เช่าไม่สำเร็จ`,
              `ข้อความจากระบบ: ${err.message}`,
              '',
              '⚠️ ถ้าปล่อยไว้: ห้องจะขึ้นว่า "จองแล้ว" แต่จะไม่มีชื่อผู้เช่าในระบบ ออกบิล/แจ้งเตือนไม่ได้',
              '👉 วิธีแก้: เปิดหน้าห้องพัก (/admin#rooms) เลือกห้องนี้แล้วกดบันทึกซ้ำ หรือทำเช็คอินผู้เช่าจากหน้าผู้เช่าได้เลย',
            ].join('\n'),
          });
        } catch (notifyErr) {
          console.warn('[bridge] approve mirror failure alert also failed:', notifyErr.message);
        }
      });
    }
    // Notify owner + applicant after the status commit. The state change is
    // already durable; notification failure is returned to the admin UI as a
    // manual follow-up, not allowed to roll back approval.
    try {
      const flags = await features.load(pool);
      tenantNotify = await notifyBookingApplicantStatus({
        pool,
        flags,
        booking,
        roomId: assignedRoomId || booking.assignedRoomId || booking.roomId || null,
        subject: 'การจองห้องได้รับการอนุมัติแล้ว',
        text: `✅ การจองห้องของคุณได้รับการอนุมัติแล้ว\n` +
              (assignedRoomId ? `ห้อง: ${assignedRoomId}\n` : '') +
              `ขั้นต่อไป: เจ้าหน้าที่จะติดต่อคุณเพื่อนัดเซ็นสัญญาและชำระเงินมัดจำส่วนที่เหลือ (ถ้ามี)\n` +
              `กรุณาเตรียมบัตรประชาชนตัวจริงในวันเซ็นสัญญา`,
      });
      notifier.notifyOwner({ pool, features: flags }, {
        category: 'booking',
        subject: `✅ อนุมัติการจอง ${id}${assignedRoomId ? ` → ห้อง ${assignedRoomId}` : ''}`,
        text: [
          `${booking.name || '-'} (${booking.phone || '-'})`,
          assignedRoomId ? `จัดให้ห้อง ${assignedRoomId}` : 'ยังไม่ได้กำหนดห้อง — ไม่มีห้องว่างตรงเงื่อนไข',
          bookingNotifyOwnerLine(tenantNotify),
          assignedRoomId
            ? '— ขั้นต่อไป: สร้างสัญญา + ส่งลิงก์เซ็นให้ผู้เช่า (ปุ่ม "สร้างสัญญา" ที่หน้า booking)'
            : '— ขั้นต่อไป: เลือกห้องว่างให้ผู้เช่าด้วยตนเอง แล้วจึงสร้างสัญญา',
        ].filter(Boolean).join('\n'),
      }).catch(() => {});
    } catch (err) {
      tenantNotify = {
        attempted: true,
        ok: false,
        queued: false,
        channel: 'none',
        requiresManualContact: true,
        reason: err.message || 'notify_failed',
        phone: normaliseBookingPhone(booking.phone) || null,
        email: booking.email || null,
      };
    }

    res.json({
      ok: true,
      booking: bookings[bIdx],
      assignedRoomId,
      preContractTenantId,
      room: assignedRoomId ? rooms[assignedRoomId] : null,
      noVacantRoomMatch: !assignedRoomId,
      tenantNotify,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err && err.httpStatus && err.publicCode) {
      return res.status(err.httpStatus).json({
        error: err.message,
        code: err.publicCode,
        hint: err.hint || null,
      });
    }
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
    return res.status(400).json({
      error: `สถานะ booking ไม่ถูกต้อง: ${b.status}`,
      code: 'INVALID_BOOKING_STATUS',
      requestedStatus: String(b.status),
      allowed: Array.from(BOOKING_STATUSES),
      hint: 'เลือกสถานะจากปุ่มบนหน้า booking เท่านั้น เพื่อให้ระบบล็อก/ปล่อยห้องตามขั้นตอน',
      nextActions: {
        bookingsUrl: '/admin#bookings',
      },
    });
  }
  const client = await pool.connect();
  let txCommitted = false;
  try {
    await client.query('BEGIN');
    const { rows: cur } = await client.query(`SELECT value FROM app_data WHERE key='baankarn_bookings_v1' FOR UPDATE`);
    const list = cur.length && Array.isArray(cur[0].value) ? cur[0].value : [];
    const idx = list.findIndex((x) => x && x.id === id);
    if (idx < 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        error: `ไม่พบ booking ${id}`,
        code: 'BOOKING_NOT_FOUND',
        hint: 'กลับไปหน้า booking แล้วเปิดรายการล่าสุดอีกครั้ง ข้อมูลบนหน้าจออาจเก่าแล้ว',
        nextActions: {
          bookingsUrl: '/admin#bookings',
        },
      });
    }
    const before = list[idx];
    // Room assignment/reassignment must go through approve-and-assign (which
    // locks the room blob + booking together). PUT only carries status/notes,
    // so accepting a roomId here would (a) desync booking.roomId from the real
    // reservation with no rooms_v1/rooms_v2 coordination, and (b) let a
    // terminal (cancelled/completed) record keep being mutated. Refuse any
    // actual roomId change — the legitimate admin UI never sends one.
    if (b.roomId !== undefined && String(b.roomId).slice(0, 32) !== String(before.roomId || '')) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'การมอบหมาย/เปลี่ยนห้องของ booking ต้องทำผ่านปุ่มอนุมัติที่จองห้องพร้อมกันเท่านั้น',
        code: 'ASSIGNMENT_REQUIRES_ASSIGNMENT_FLOW',
        hint: 'ใช้ POST /api/bookings/:id/approve-and-assign เพื่อให้สถานะ booking และสถานะห้องถูกล็อกพร้อมกัน',
        nextActions: {
          bookingsUrl: `/admin#bookings?booking=${encodeURIComponent(id)}`,
        },
      });
    }
    if (b.status && b.status !== before.status) {
      if (b.status === 'approved') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'การอนุมัติ booking ต้องทำผ่านปุ่มอนุมัติที่จองห้องพร้อมกันเท่านั้น',
          code: 'APPROVAL_REQUIRES_ASSIGNMENT_FLOW',
          hint: 'ใช้ POST /api/bookings/:id/approve-and-assign เพื่อให้สถานะ booking และสถานะห้องถูกล็อกพร้อมกัน',
          nextActions: {
            bookingsUrl: `/admin#bookings?booking=${encodeURIComponent(id)}`,
          },
        });
      }
      const allowed = BOOKING_TRANSITIONS[before.status || 'pending'] || [];
      if (!allowed.includes(b.status)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `cannot transition ${before.status} → ${b.status}`,
          code: 'BAD_TRANSITION',
          currentStatus: before.status || 'pending',
          requestedStatus: String(b.status),
          allowed,
          hint: 'สถานะรายการไม่ตรงขั้นตอน ให้รีเฟรชหน้า booking แล้วเลือก action ที่ระบบแสดงให้ในสถานะล่าสุด',
          nextActions: {
            bookingsUrl: `/admin#bookings?booking=${encodeURIComponent(id)}`,
          },
        });
      }
      // Cancelling is terminal and can free a reserved room, so require a
      // human-readable reason just like rejection/reopen. It becomes the
      // applicant-facing message, the owner notification note, and the audit
      // trail answer for "why was this room released?"
      if (b.status === 'cancelled') {
        const cancelReason = String(b.cancelReason || b.adminNotes || '').trim();
        if (cancelReason.length < 5) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'ต้องระบุเหตุผลยกเลิกการจองอย่างน้อย 5 ตัวอักษร',
            code: 'CANCEL_REASON_REQUIRED',
            hint: 'กดยกเลิกจากหน้า booking แล้วใส่เหตุผล เช่น ผู้จองขอยกเลิก หรือไม่สะดวกเข้าพัก เพื่อให้ระบบแจ้งผู้จองและบันทึก audit ได้ชัดเจน',
            nextActions: {
              bookingsUrl: `/admin#bookings?booking=${encodeURIComponent(id)}`,
            },
          });
        }
        b.cancelReason = cancelReason.slice(0, 500);
        b.adminNotes = cancelReason.slice(0, 1000);
      }
      // Reverse transition rejected → reviewing is a legitimate admin
      // override (reconsider a previously-rejected booking) but it bypasses
      // the audit trail rationale carried by the original reject reason.
      // Require an explicit `reopenReason` (≥5 chars) on the reopen so we
      // can answer the audit question "why was this back in the queue?"
      // six months later. The reason gets stamped onto the row + audit log.
      if (before.status === 'rejected' && b.status === 'reviewing') {
        const reopenReason = String(b.reopenReason || '').trim();
        if (reopenReason.length < 5) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'ต้องระบุเหตุผลในการเปิด booking ที่ถูกปฏิเสธอย่างน้อย 5 ตัวอักษร',
            code: 'REOPEN_REASON_REQUIRED',
            hint: 'กดทบทวนใหม่จากหน้า booking แล้วใส่เหตุผล เช่น ผู้จองส่งเอกสารเพิ่ม หรือแอดมินตรวจข้อมูลซ้ำแล้ว',
          });
        }
        // Stash the reason on the booking blob so it shows up in admin UI.
        b.reopenReason = reopenReason.slice(0, 500);
      }
    }
    const updated = {
      ...before,
      status: b.status || before.status,
      adminNotes: b.adminNotes !== undefined ? String(b.adminNotes).slice(0, 1000) : before.adminNotes,
      roomId: b.roomId !== undefined ? String(b.roomId).slice(0, 32) : before.roomId,
      // Preserve reopenReason from the rejected→reviewing reverse transition so
      // it shows up on the booking detail panel + survives subsequent edits.
      reopenReason: b.reopenReason !== undefined ? b.reopenReason : before.reopenReason,
      cancelReason: b.cancelReason !== undefined ? b.cancelReason : before.cancelReason,
      updatedAt: new Date().toISOString(),
      updatedBy: req.session.user.username,
    };
    // Refund obligation: when a booking that COLLECTED money goes terminal
    // (cancelled/rejected), record a one-way refund obligation on the booking
    // itself. Previously the deposit just stayed depositStatus='verified' with
    // no per-booking trace — only an aggregate report count — so a refund
    // could be paid twice or never. depositStatus='refund_due' is cleared only
    // by POST /api/bookings/:id/refund (idempotent). Skip if already resolved.
    if (['cancelled', 'rejected'].includes(updated.status)
        && before.status !== updated.status
        && Number(before.bookingFee) > 0
        && ['verified', 'pending_review', 'manual_review', 'submitted'].includes(String(before.depositStatus || ''))) {
      updated.refundDue = Number(before.bookingFee);
      updated.depositStatus = 'refund_due';
      updated.refundResolvedAt = null;
      updated.refundResolvedBy = null;
    }
    let releasedRoomId = null;
    let roomsAfterRelease = null;
    let releasedTenant = null;
    let tenantNotify = null;
    const shouldReleaseTerminalBookingRoom = ['cancelled', 'rejected'].includes(updated.status)
      && before.status !== updated.status;
    if (shouldReleaseTerminalBookingRoom) {
      // A booking can now reserve a room before approval when the public
      // booking/deposit flow succeeds. Terminal outcomes must release only
      // reservations that are still owned by this booking id:
      //   - pending/reviewing → rejected: public booking reservation is freed
      //   - approved → cancelled: pre-contract reservation is freed
      //   - completed → cancelled: quick-invite may have changed reservedBy to
      //                 "contract:<id>"; active contracts are never freed here.
      // The OLD code only handled the 'approved' case (reservedBy===booking.id).
      // For 'completed' we refuse the cancel outright when the linked
      // contract is still active — admin must end the contract first so the
      // checkout cascade runs (revokes cards, deactivates recurring, ฯลฯ).
      // If the contract has already been ended/expired/cancelled we proceed
      // and free any stale 'contract:N' reservation.
      const roomToRelease = String(before.assignedRoomId || before.roomId || '').slice(0, 32);
      if (before.status === 'completed' && roomToRelease) {
        // Find the contract that was created from this booking.
        // contracts.notes / source field doesn't link back to bookings
        // directly, so we look for an active contract on the same room
        // that was created after the booking was approved.
        let linkedContract = null;
        try {
          const cQ = await client.query(
            `SELECT id, contract_no, tenant_id, status FROM contracts
               WHERE room_id=$1 AND deleted_at IS NULL
               ORDER BY created_at DESC LIMIT 1`,
            [roomToRelease]
          );
          linkedContract = cQ.rows[0] || null;
        } catch { /* no contracts table on legacy deploys — fall through */ }
        if (linkedContract && linkedContract.status === 'active') {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `ยกเลิก booking นี้ไม่ได้ — มีสัญญา ${linkedContract.contract_no} active อยู่บนห้อง ${roomToRelease}`,
            code: 'BOOKING_HAS_ACTIVE_CONTRACT',
            contract: linkedContract,
            hint: 'ยกเลิก/ปิดสัญญาก่อน (จะ cascade คืนห้องอัตโนมัติ) — หรือใช้ POST /api/tenants/:tenantId/checkout',
            contractUrl: `/admin#contracts/${linkedContract.id}`,
          });
        }
      }
      if (roomToRelease) {
        const rRes = await client.query(
          `SELECT value FROM app_data WHERE key='baankarn_rooms_v1' FOR UPDATE`
        );
        const rooms = rRes.rows.length && rRes.rows[0].value && typeof rRes.rows[0].value === 'object'
          ? rRes.rows[0].value
          : {};
        const room = rooms[roomToRelease];
        // Free the room when it was reserved BY this booking OR by a
        // contract that has since been ended (the contract cascade
        // didn't reset reservedBy because the room transitioned through
        // 'occupied' first). The second condition catches the stale
        // "contract:N" pointer on a contract that is no longer active.
        let shouldFree = false;
        if (room && room.status === 'reserved') {
          if (room.reservedBy === id) {
            shouldFree = true;   // approved-then-cancelled, no contract created
          } else if (typeof room.reservedBy === 'string'
              && room.reservedBy.startsWith('contract:')) {
            const cid = Number(room.reservedBy.slice('contract:'.length));
            if (Number.isInteger(cid)) {
              try {
                const cR = await client.query(
                  `SELECT status FROM contracts WHERE id=$1 LIMIT 1`,
                  [cid]
                );
                if (!cR.rows.length || cR.rows[0].status !== 'active') {
                  shouldFree = true;
                }
              } catch { /* no contracts table — leave the reservation alone */ }
            }
          }
        }
        if (shouldFree) {
          // Approval mirrors a booking applicant into tenants.current_room_id
          // before a contract exists. If the applicant backs out, clear that
          // pre-contract tenant link together with the room reservation.
          const bookingPhone = String(before.phone || '').replace(/[\s-]/g, '').slice(0, 32);
          const bookingName = String(before.name || '').trim().slice(0, 200);
          const tenantClauses = [
            `current_room_id=$1`,
            `status='active'`,
            `deleted_at IS NULL`,
          ];
          const tenantParams = [roomToRelease];
          if (bookingPhone) {
            tenantParams.push(bookingPhone);
            tenantClauses.push(`phone=$${tenantParams.length}`);
          }
          if (bookingName) {
            tenantParams.push(bookingName);
            tenantClauses.push(`lower(full_name)=lower($${tenantParams.length})`);
          }
          if (bookingPhone || bookingName) {
            const tFind = await client.query(
              `SELECT id, full_name, phone
                 FROM tenants
                WHERE ${tenantClauses.join(' AND ')}
                ORDER BY updated_at DESC
                LIMIT 1
                FOR UPDATE`,
              tenantParams
            );
            const tenantRow = tFind.rows[0] || null;
            if (tenantRow) {
              // Check the tenant's contracts ANYWHERE, not just the released
              // room. Approving a second-room booking re-points
              // current_room_id at the new room; cancelling that booking
              // must not flip a tenant who still holds a live contract on
              // their original room to moved_out — restore the pointer to
              // the contract's room instead.
              const activeContract = await client.query(
                `SELECT id, room_id FROM contracts
                  WHERE tenant_id=$1
                    AND status='active' AND deleted_at IS NULL
                  ORDER BY (CASE WHEN room_id=$2 THEN 0 ELSE 1 END),
                           locked_at DESC NULLS LAST, start_date DESC NULLS LAST, id DESC
                  LIMIT 1`,
                [tenantRow.id, roomToRelease]
              ).catch((err) => {
                if (err.code === '42P01') return { rows: [] };
                throw err;
              });
              const liveContract = activeContract.rows[0] || null;
              if (!liveContract) {
                const tUpd = await client.query(
                  `UPDATE tenants
                      SET status='moved_out',
                          current_room_id=NULL,
                          updated_at=NOW(),
                          notes=trim(BOTH E'\n' FROM COALESCE(notes || E'\n', '') || $2)
                    WHERE id=$1 AND status='active'
                    RETURNING id, full_name, phone`,
                  [
                    tenantRow.id,
                    `[auto] booking ${id} ${updated.status}: released pre-contract reservation ${roomToRelease}`,
                  ]
                );
                if (tUpd.rows.length) {
                  releasedTenant = {
                    id: tUpd.rows[0].id,
                    fullName: tUpd.rows[0].full_name,
                    phone: tUpd.rows[0].phone,
                  };
                }
              } else if (String(liveContract.room_id || '') !== String(roomToRelease)) {
                // Tenant's real tenancy lives on another room — point them back.
                await client.query(
                  `UPDATE tenants
                      SET current_room_id=$2, updated_at=NOW(),
                          notes=trim(BOTH E'\n' FROM COALESCE(notes || E'\n', '') || $3)
                    WHERE id=$1 AND status='active' AND current_room_id=$4`,
                  [
                    tenantRow.id,
                    String(liveContract.room_id),
                    `[auto] booking ${id} ${updated.status}: restored room ${liveContract.room_id} from live contract`,
                    roomToRelease,
                  ]
                );
              }
              // else: live contract on the released room itself — leave the tenant alone.
            }
          }
          const { tenant, reservedBy, reservedAt, ...rest } = room;
          rooms[roomToRelease] = { ...rest, status: 'vacant' };
          roomsAfterRelease = rooms;
          releasedRoomId = roomToRelease;
          try {
            await client.query(
              `UPDATE rooms_v2 SET status='vacant', updated_at=NOW()
                 WHERE room_code=$1 AND status='reserved' AND deleted_at IS NULL`,
              [roomToRelease]
            );
          } catch (err) {
            if (err.code !== '42P01') throw err;
          }
        }
      }
    }
    list[idx] = updated;
    await client.query(
      `INSERT INTO app_data (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW(), updated_by=EXCLUDED.updated_by`,
      ['baankarn_bookings_v1', JSON.stringify(list), req.session.user.username]
    );
    if (roomsAfterRelease) {
      await client.query(
        `INSERT INTO app_data (key, value, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW(), updated_by=EXCLUDED.updated_by`,
        ['baankarn_rooms_v1', JSON.stringify(roomsAfterRelease), req.session.user.username]
      );
    }
    // Mirror status / room changes into the relational bookings table.
    // Best-effort: a missing row (legacy booking from before the dual-write
    // landed) is fine — UPDATE is a no-op then.
    if (b.status !== undefined || b.roomId !== undefined) {
      try {
        await client.query(
          `UPDATE bookings
              SET status=$2, room_id=$3, updated_at=NOW()
            WHERE external_id=$1`,
          [id, updated.status, updated.roomId || null]
        );
      } catch (err) {
        console.warn('[booking] relational status sync skipped:', err.message);
      }
    }
    await client.query('COMMIT');
    txCommitted = true;

    // Notify the applicant on status change FIRST — BEFORE revoking the
    // booking's LINE bindings below. The cancel/reject notice is resolved
    // through this booking's BOUND LINE recipients; revoking the bindings
    // first empties that set, so a LINE-only public applicant (the common
    // case) would silently receive nothing. Order: notify → revoke (revoke
    // is cleanup, see below). Notification failures never roll back the
    // already-committed status change; they surface to the admin UI as
    // manual follow-up work.
    if (b.status && b.status !== before.status) {
      try {
        const flags = await features.load(pool);
        // Clear, next-step guidance in Thai so the applicant always knows
        // (1) what just happened and (2) what comes next — the booking flow
        // stays easy to follow end to end. 'approved' is intentionally NOT here:
        // it's unreachable via PUT (blocked above) and is sent by
        // approve-and-assign with its own room-assignment message.
        const roomLabel = (updated.assignedRoomId || updated.roomId)
          ? ` ห้อง ${updated.assignedRoomId || updated.roomId}` : '';
        // When the booking had collected money, tell the applicant the
        // deposit/booking fee will be refunded — silence here reads as
        // "the dorm kept my money". Driven by the refund_due stamp applied
        // above on terminal transitions of a paid booking.
        const refundLine = (updated.depositStatus === 'refund_due' && Number(updated.refundDue) > 0)
          ? `\n💸 ค่าจองที่ชำระไว้ ฿${Number(updated.refundDue).toLocaleString('th-TH')} เจ้าหน้าที่จะติดต่อคืนเงินให้`
          : '';
        const tenantText = ({
          reviewing: `🔍 การจองห้อง${roomLabel}ของคุณกำลังถูกตรวจสอบโดยเจ้าหน้าที่\n`
            + `ขั้นต่อไป: เราจะแจ้งผลให้คุณทราบทาง LINE นี้เมื่อตรวจสอบเสร็จ — ยังไม่ต้องดำเนินการใดเพิ่ม`,
          rejected: `❌ ขออภัย การจองห้อง${roomLabel}ไม่ได้รับการอนุมัติ\n`
            + (updated.adminNotes ? `เหตุผล: ${updated.adminNotes}\n` : '')
            + `หากมีข้อสงสัย หรือต้องการเลือกห้องอื่น กรุณาติดต่อสำนักงาน${refundLine}`,
          cancelled: `🚫 การจองห้อง${roomLabel}ถูกยกเลิกแล้ว\n`
            + (updated.adminNotes ? `เหตุผล: ${updated.adminNotes}\n` : '')
            + `หากต้องการจองใหม่ สามารถทำรายการได้ที่หน้าจองห้องอีกครั้ง${refundLine}`,
        })[updated.status];
        if (tenantText) {
          tenantNotify = await notifyBookingApplicantStatus({
            pool,
            flags,
            booking: updated,
            roomId: updated.assignedRoomId || updated.roomId || releasedRoomId || null,
            subject: `อัปเดตสถานะการจองห้อง — ${updated.status}`,
            text: tenantText,
          });
        }

        // Owner notification — concise audit-style line.
        const subj = `📋 Booking ${id}: ${before.status} → ${updated.status}`;
        notifier.notifyOwner({ pool, features: flags }, {
          category: 'booking',
          subject: subj,
          text: [
            `${updated.name || '-'} (${updated.phone || '-'})`,
            `ห้องที่ต้องการ: ${updated.roomId || updated.wantType || '-'}`,
            releasedRoomId ? `ปล่อยห้องแล้ว: ${releasedRoomId}` : null,
            releasedTenant ? `เคลียร์ผู้เช่าที่ mirror จาก booking แล้ว: ${releasedTenant.fullName || releasedTenant.id}` : null,
            (updated.depositStatus === 'refund_due' && Number(updated.refundDue) > 0)
              ? `💸 ต้องคืนค่าจอง ฿${Number(updated.refundDue).toLocaleString('th-TH')} — ทำเครื่องหมายคืนแล้วที่หน้า booking` : null,
            bookingNotifyOwnerLine(tenantNotify),
            updated.adminNotes ? `หมายเหตุ: ${updated.adminNotes}` : null,
          ].filter(Boolean).join('\n'),
        }).catch(() => {});
      } catch { /* ignore */ }
    }

    // R-followup booking audit: revoke any LINE binding codes that were
    // issued for this booking when it transitions to a terminal status.
    // tryBind() already refuses to bind on a cancelled/rejected booking
    // (the JOIN on bookings.status), so this is NOT a security fix — it's
    // a cleanup so stale 'bound' rows (bound BEFORE cancel but never
    // transferred via quick-invite) don't keep occupying the per-OA
    // active-user slot.
    //
    // Scope (in revokeBookingBindings): only bindings still anchored at
    // booking_id with tenant_id IS NULL — bindings already transferred to
    // a tenant (via transferBookingBindings during quick-invite) represent
    // a live tenant relationship that must NOT be touched.
    //
    // Runs AFTER the applicant notify above (which reads these same bound
    // recipients) so the cancel/reject notice still reaches LINE, then in
    // its own short transaction so a slow LINE/OA refresh can't block the
    // status-change durability. Errors are caught + surfaced in the audit log.
    let bookingBindingRevoke = null;
    if (['cancelled', 'rejected'].includes(updated.status) && before.status !== updated.status) {
      try {
        const lineBinding = require('./services/lineBinding');
        bookingBindingRevoke = await lineBinding.revokeBookingBindings(pool, { bookingId: id });
      } catch (err) {
        console.warn('[booking.update] revokeBookingBindings failed:', err.message);
        bookingBindingRevoke = { error: err.message };
      }
    }
    audit(req, 'booking.update', 'booking', id, {
      from: before.status, to: updated.status, fields: Object.keys(b), releasedRoomId,
      terminalReason: ['cancelled', 'rejected'].includes(updated.status) ? (updated.adminNotes || null) : null,
      releasedTenantId: releasedTenant ? releasedTenant.id : null,
      refundDue: (updated.depositStatus === 'refund_due' && Number(updated.refundDue) > 0) ? Number(updated.refundDue) : null,
      lineBindingRevoke: bookingBindingRevoke ? {
        revoked: bookingBindingRevoke.revoked || 0,
        error: bookingBindingRevoke.error || null,
      } : null,
    });
    res.json({
      ok: true,
      booking: updated,
      releasedRoomId,
      releasedTenant,
      tenantNotify,
      room: releasedRoomId && roomsAfterRelease ? roomsAfterRelease[releasedRoomId] : null,
    });
  } catch (err) {
    if (!txCommitted) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('booking update error:', err);
    res.status(500).json({ error: 'internal error' });
  } finally {
    client.release();
  }
});

// POST /api/bookings/:id/refund — settle the refund obligation on a booking
// that collected money and was later cancelled/rejected. Idempotent / one-way:
// only 'refund_due' → 'refunded'. The refund_due stamp is written by the PUT
// cancel/reject path; this records WHO settled it + WHEN so the same booking
// can never be refunded twice (re-call → ALREADY_REFUNDED) or silently missed.
app.post('/api/bookings/:id/refund', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  const id = String(req.params.id).slice(0, 64);
  const note = req.body?.note !== undefined ? String(req.body.note).slice(0, 500) : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cur } = await client.query(
      `SELECT value FROM app_data WHERE key='baankarn_bookings_v1' FOR UPDATE`
    );
    const list = cur.length && Array.isArray(cur[0].value) ? cur[0].value : [];
    const idx = list.findIndex((x) => x && x.id === id);
    if (idx < 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: `ไม่พบ booking ${id}`, code: 'BOOKING_NOT_FOUND' });
    }
    const before = list[idx];
    if (String(before.depositStatus || '') === 'refunded') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'การจองนี้ทำเครื่องหมายคืนค่าจองไปแล้ว',
        code: 'BOOKING_ALREADY_REFUNDED',
        refundedAt: before.refundResolvedAt || null,
        refundedBy: before.refundResolvedBy || null,
      });
    }
    if (String(before.depositStatus || '') !== 'refund_due') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'การจองนี้ไม่มีค่าจองที่ต้องคืน',
        code: 'BOOKING_NOT_REFUND_DUE',
        hint: 'ปุ่มคืนค่าจองใช้ได้เฉพาะ booking ที่เก็บค่าจองแล้วและถูกยกเลิก/ปฏิเสธ (สถานะ refund_due)',
      });
    }
    const refundedAmount = Number(before.refundDue) || Number(before.bookingFee) || 0;
    const resolvedAt = new Date().toISOString();
    const updated = {
      ...before,
      depositStatus: 'refunded',
      refundDue: refundedAmount,
      refundResolvedAt: resolvedAt,
      refundResolvedBy: req.session.user.username,
      refundNote: note,
      updatedAt: resolvedAt,
      updatedBy: req.session.user.username,
    };
    list[idx] = updated;
    await client.query(
      `INSERT INTO app_data (key, value, updated_by) VALUES ($1, $2, 'booking-refund')
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW(), updated_by='booking-refund'`,
      ['baankarn_bookings_v1', JSON.stringify(list)]
    );
    // Best-effort relational mirror so SQL-backed views agree with the blob.
    try {
      await client.query(
        `UPDATE bookings SET deposit_status='refunded' WHERE external_id=$1`,
        [id]
      );
    } catch (err) {
      if (err.code !== '42P01' && err.code !== '42703') {
        console.warn('[booking.refund] relational mirror skipped:', err.message);
      }
    }
    await client.query('COMMIT');
    audit(req, 'booking.refund', 'booking', id, { amount: refundedAmount, note });
    res.json({ ok: true, booking: updated });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('booking refund error:', err);
    res.status(500).json({ error: 'internal error' });
  } finally {
    client.release();
  }
});

// === v2: Recurring charges helper (B1) ====================================
// CRUD lives in routes/recurring-charges.js (dedicated router with Zod
// validation + a /:id/toggle action). loadRecurringFor moved to
// routes/bills-extras.js because POST /api/bills (its only caller) lives
// there now.

// === v2: Photo upload (rooms / signatures / citizen-id images) ============
const ROOM_PHOTO_UPLOAD_ALERT_COOLDOWN_MS = 15 * 60 * 1000;
const roomPhotoUploadAlertBuckets = new Map();

function classifyUploadError(err) {
  const raw = String(err && err.message ? err.message : err || 'upload failed');
  if (/file too large/i.test(raw)) {
    return { status: 413, code: 'UPLOAD_TOO_LARGE', message: 'ไฟล์ใหญ่เกินกำหนด', raw };
  }
  if (/expected string|unrecognized file type|mime mismatch|mime not allowed|unknown mime/i.test(raw)) {
    return { status: 400, code: 'INVALID_UPLOAD_FILE', message: 'ไฟล์รูปไม่ถูกต้องหรือชนิดไฟล์ไม่รองรับ', raw };
  }
  return { status: 400, code: 'UPLOAD_FAILED', message: raw, raw };
}

async function notifyRoomPhotoUploadRejected(req, refId, classification) {
  const now = Date.now();
  const ip = clientIp(req) || 'unknown';
  const reason = String(classification.code || classification.raw || 'upload failed').slice(0, 120);
  const key = `${ip}|${refId || '-'}|${reason}`;
  const last = roomPhotoUploadAlertBuckets.get(key) || 0;
  if (now - last < ROOM_PHOTO_UPLOAD_ALERT_COOLDOWN_MS) return;
  roomPhotoUploadAlertBuckets.set(key, now);
  for (const [k, t] of roomPhotoUploadAlertBuckets) {
    if (now - t > ROOM_PHOTO_UPLOAD_ALERT_COOLDOWN_MS * 2) {
      roomPhotoUploadAlertBuckets.delete(k);
    }
  }

  const flags = req.features || (await features.load(pool).catch(() => ({})));
  const status = storage.storageStatus();
  const user = req.session && req.session.user ? req.session.user.username : 'unknown';
  notifier.notifyOwner({ pool, features: flags }, {
    category: 'system',
    subject: 'อัปโหลดรูปห้องถูกปฏิเสธ',
    text: [
      'ระบบปฏิเสธการอัปโหลดรูปห้อง เพราะไฟล์หรือข้อมูลไม่ถูกต้อง/ผิดปกติ',
      `ห้อง: ${refId || '-'}`,
      `ผู้ใช้: ${user}`,
      `IP: ${ip}`,
      `เหตุผล: ${classification.message}`,
      `รายละเอียดระบบ: ${classification.raw}`,
      `Storage ปัจจุบัน: ${status.storageMode === 's3' ? 'R2/S3' : `local (${status.uploadRoot})`}`,
      'ไฟล์นี้ยังไม่ถูกบันทึก กรุณาตรวจชนิดไฟล์ ขนาดไฟล์ และการตั้งค่า R2/S3 ถ้าใช้งาน production',
    ].join('\n'),
  }).catch(() => {});
}

async function loadConfigForLogoUpdate(client) {
  const { rows } = await client.query(
    `SELECT value FROM app_data WHERE key='baankarn_config_v1' FOR UPDATE`
  );
  const cfg = rows.length && rows[0].value && typeof rows[0].value === 'object' && !Array.isArray(rows[0].value)
    ? rows[0].value
    : {};
  if (!cfg.building || typeof cfg.building !== 'object' || Array.isArray(cfg.building)) {
    cfg.building = {};
  }
  return cfg;
}

app.post('/api/admin/building-logo', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  const dataUrl = req.body && req.body.dataUrl;
  if (!dataUrl) {
    return res.status(400).json({
      error: 'dataUrl required',
      code: 'BUILDING_LOGO_REQUIRED',
    });
  }
  let saved = null;
  const client = await pool.connect();
  try {
    saved = await storage.saveBase64({
      pool,
      category: 'building_logo',
      dataUrl,
      refId: 'building',
      uploadedBy: req.session.user.username,
      maxBytes: 750_000,
    });
    const logo = `/files/${saved.id}`;
    await client.query('BEGIN');
    const cfg = await loadConfigForLogoUpdate(client);
    const oldLogo = normalizeBuildingLogoUrl(cfg.building.logo) || '';
    cfg.building.logo = logo;
    const { rows } = await client.query(
      `INSERT INTO app_data (key, value, updated_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE
         SET value=EXCLUDED.value, updated_at=NOW(), updated_by=EXCLUDED.updated_by
       RETURNING updated_at`,
      ['baankarn_config_v1', JSON.stringify(cfg), req.session.user.username]
    );
    await client.query('COMMIT');
    const oldFileId = fileIdFromPublicFileUrl(oldLogo);
    if (oldFileId && oldFileId !== saved.id) {
      removeFileUrlIfCategory(oldLogo, 'building_logo', 'old building logo').catch(() => {});
    }
    audit(req, 'building.logo.update', 'config', 'baankarn_config_v1', {
      logo,
      oldLogo: oldLogo || null,
    });
    const { buffer, ...file } = saved;
    res.json({
      ok: true,
      logo,
      file,
      config: cfg,
      updatedAt: rows[0] && rows[0].updated_at ? rows[0].updated_at.toISOString() : null,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (saved && saved.id) storage.removeQuietly(pool, saved.id, 'failed building logo upload');
    const classification = classifyUploadError(err);
    audit(req, 'building.logo.rejected', 'config', 'baankarn_config_v1', {
      code: classification.code,
      reason: classification.raw,
    }).catch(() => {});
    res.status(classification.status || 500).json({
      error: classification.message || 'อัปโหลดโลโก้ไม่สำเร็จ',
      code: classification.code || 'BUILDING_LOGO_UPLOAD_FAILED',
    });
  } finally {
    client.release();
  }
});

app.delete('/api/admin/building-logo', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cfg = await loadConfigForLogoUpdate(client);
    const oldLogo = normalizeBuildingLogoUrl(cfg.building.logo) || '';
    cfg.building.logo = '';
    const { rows } = await client.query(
      `INSERT INTO app_data (key, value, updated_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE
         SET value=EXCLUDED.value, updated_at=NOW(), updated_by=EXCLUDED.updated_by
       RETURNING updated_at`,
      ['baankarn_config_v1', JSON.stringify(cfg), req.session.user.username]
    );
    await client.query('COMMIT');
    const oldFileId = fileIdFromPublicFileUrl(oldLogo);
    if (oldFileId) removeFileUrlIfCategory(oldLogo, 'building_logo', 'removed building logo').catch(() => {});
    audit(req, 'building.logo.delete', 'config', 'baankarn_config_v1', { oldLogo: oldLogo || null });
    res.json({
      ok: true,
      logo: '',
      config: cfg,
      updatedAt: rows[0] && rows[0].updated_at ? rows[0].updated_at.toISOString() : null,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('building logo delete error:', err);
    res.status(500).json({ error: 'internal error', code: 'BUILDING_LOGO_DELETE_FAILED' });
  } finally {
    client.release();
  }
});

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
    const { buffer, ...file } = out;
    res.json({ ok: true, file });
  } catch (err) {
    const classification = classifyUploadError(err);
    const refId = b.refId ? String(b.refId).slice(0, 64) : null;
    audit(req, 'upload.rejected', 'file', refId, {
      category,
      side,
      code: classification.code,
      reason: classification.raw,
      storageMode: storage.storageStatus().storageMode,
    }).catch(() => {});
    if (category === 'room_photo') {
      notifyRoomPhotoUploadRejected(req, refId, classification).catch(() => {});
    }
    res.status(classification.status).json({
      error: classification.message,
      code: classification.code,
    });
  }
});

// POST /api/tenants/:id/identity + GET /api/tenants/:id/identity moved
// to routes/tenant-ops.js so the entire /api/tenants surface lives in
// one router (round 9). Live code: routes/tenant-ops.js.

// === v2: Meter readings ===================================================

// Compose an owner-facing alert from a meter anomaly. detectAnomaly returns
// one of four shapes; each carries different fields. This formats each kind
// using only the fields it actually has so the alert is always readable
// (no "z=NaN" / "ค่าเฉลี่ย NaN"). Mirrored client-side in page-meters.jsx.
function describeMeterAnomaly(roomId, meterType, anomaly, sigmas) {
  const head = `ห้อง ${roomId} (${meterType})`;
  const num = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '—');
  switch (anomaly && anomaly.kind) {
    case 'rollback':
      return {
        subject: '⚠️ มิเตอร์ค่าลดลง',
        text: `${head} ค่ามิเตอร์ลดลง ${num(anomaly.last)} หน่วย\n`
          + 'น่าจะเป็น meter reset / ป้อนค่าผิด — โปรดตรวจสอบก่อนออกบิล',
      };
    case 'jump':
      return {
        subject: '⚠️ มิเตอร์พุ่งสูงผิดปกติ',
        text: `${head} การใช้พุ่งสูงผิดปกติ: รอบนี้ ${num(anomaly.last)} หน่วย `
          + `≈ ${num(anomaly.ratio, 1)} เท่าของรอบก่อน (${num(anomaly.prev)} หน่วย)\n`
          + 'อาจเป็นการป้อนเลขผิด — โปรดตรวจสอบก่อนออกบิล',
      };
    case 'zero-variance':
      return {
        subject: '⚠️ มิเตอร์ผิดปกติ',
        text: `${head} เคยใช้คงที่ ${num(anomaly.mean)} หน่วยมาตลอด `
          + `แต่รอบนี้ ${num(anomaly.last)} หน่วย\n`
          + 'การใช้เปลี่ยนกะทันหันจากค่าคงที่ — โปรดตรวจสอบ',
      };
    case 'sigma':
    default:
      return {
        subject: '⚠️ มิเตอร์ผิดปกติ',
        text: `${head} ใช้ผิดปกติ z=${num(anomaly && anomaly.z)} (เกิน ${num(sigmas, 0)}σ)\n`
          + `ค่าล่าสุด: ${num(anomaly && anomaly.last)} หน่วย, ค่าเฉลี่ย: ${num(anomaly && anomaly.mean)} หน่วย`,
      };
  }
}

app.post('/api/meters/:roomId/readings', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager', 'staff'), features.requireFeature('meterIot'), async (req, res) => {
  const roomId = String(req.params.roomId).slice(0, 32);
  const { meterType, reading, period } = req.body || {};
  try {
    // Reject readings for rooms that don't exist — otherwise a typo'd/crafted
    // room code creates orphan meter rows (anomaly-detector noise) that never
    // reach a bill. Mirrors routes/recurring-charges.js#roomExists.
    let roomFound = false;
    try {
      const rv2 = await pool.query(
        `SELECT 1 FROM rooms_v2 WHERE room_code=$1 AND deleted_at IS NULL LIMIT 1`,
        [roomId]
      );
      roomFound = rv2.rows.length > 0;
    } catch (err) {
      if (err.code !== '42P01') throw err; // pre-migration deploy: no rooms_v2 yet
    }
    if (!roomFound) {
      const legacy = await pool.query(
        `SELECT 1 FROM app_data WHERE key='baankarn_rooms_v1' AND value ? $1 LIMIT 1`,
        [roomId]
      );
      roomFound = legacy.rows.length > 0;
    }
    if (!roomFound) {
      return res.status(404).json({ error: 'room not found', code: 'ROOM_NOT_FOUND' });
    }
    let row;
    try {
      row = await meter.record(pool, {
        roomId, meterType, reading,
        // A2 — only 'manual' is appropriate for admin-entered readings; an
        // admin shouldn't be able to claim a reading came from MQTT/simulator
        // (those come from scheduler / device endpoints with bearer auth).
        source: 'manual',
        createdBy: req.session.user.username,
        period,
        // Backward reading is refused unless the admin explicitly confirms a
        // meter replacement/reset. The confirmation is audit-logged below so
        // a disputed bill can be traced back to who accepted the rollback.
        allowRollback: req.body && req.body.allowRollback === true,
      });
    } catch (err) {
      if (err && err.code === 'METER_ROLLBACK') {
        return res.status(409).json({
          error: err.message,
          code: 'METER_ROLLBACK',
          lastReading: err.lastReading,
          attemptedReading: err.attemptedReading,
          hint: 'ตรวจเลขที่กรอกอีกครั้ง — ถ้ามิเตอร์ถูกเปลี่ยน/รีเซ็ตจริง ส่ง { allowRollback: true } เพื่อยืนยัน (ระบบจะบันทึก audit)',
        });
      }
      throw err;
    }
    if (req.body && req.body.allowRollback === true) {
      audit(req, 'meter.rollback_confirmed', 'meter', String(row.id), {
        meterType: row.meter_type, reading: row.reading, period: row.period || null,
      });
    }
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
      // Build a clear, per-kind message. detectAnomaly returns different
      // shapes per kind — only 'sigma' carries z, only 'sigma'/'zero-variance'
      // carry mean — so a single z/mean template printed "z=NaN … ค่าเฉลี่ย NaN"
      // for 'jump' and 'zero-variance' alerts (the exact young-meter / flat-
      // baseline fraud cases these branches exist to catch). Format each kind
      // with the fields it actually has, and never call toFixed on undefined.
      const { subject, text } = describeMeterAnomaly(roomId, row.meter_type, anomaly, sigmas);
      notifier.notifyOwner(
        { pool, features: flags },
        { subject, text }
      ).catch(() => {});
      audit(req, 'meter.anomaly', 'meter', String(row.id), {
        kind: anomaly.kind || 'sigma',
        sigmas,
        // Keep whichever metrics this kind produced (omit undefined so the
        // audit row never stores NaN/null noise).
        ...(Number.isFinite(anomaly.z) ? { z: Number(anomaly.z.toFixed(3)) } : {}),
        ...(Number.isFinite(anomaly.mean) ? { mean: Number(anomaly.mean.toFixed(3)) } : {}),
        ...(Number.isFinite(anomaly.ratio) ? { ratio: Number(anomaly.ratio.toFixed(2)) } : {}),
        ...(Number.isFinite(anomaly.last) ? { last: anomaly.last } : {}),
      });
    }
    audit(req, 'meter.record', 'meter', String(row.id), { meterType: row.meter_type, reading: row.reading, period: row.period || null });
    res.json({ ok: true, reading: row, anomaly });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/meters/period-summary', requireAuth, features.requireFeature('meterIot'), async (req, res) => {
  try {
    const period = meter.normalisePeriod(req.query.period);
    if (!period) return res.status(400).json({ error: 'period required (YYYY-MM)', code: 'INVALID_PERIOD' });
    const { rows } = await pool.query(`SELECT value FROM app_data WHERE key='baankarn_rooms_v1' LIMIT 1`);
    const rooms = rows[0]?.value || {};
    const summary = await meter.buildPeriodSummary(pool, rooms, period);
    res.json({ ok: true, period, rooms: summary });
  } catch (err) {
    const status = /invalid period/.test(String(err.message || '')) ? 400 : 500;
    if (status === 500) console.error('meter period summary error:', err);
    res.status(status).json({ error: err.message || 'internal error' });
  }
});

app.get('/api/meters/:roomId/readings', requireAuth, features.requireFeature('meterIot'), async (req, res) => {
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
  const requestedResult = ['granted', 'denied'].includes(String(b.result || 'granted'))
    ? String(b.result) : 'granted';
  const cardId = b.cardId ? String(b.cardId).slice(0, 64) : null;
  if (!device) return res.status(400).json({ error: 'device required' });
  // A leaked/compromised device token must not forge access events straight from
  // the body. Without a presented card, tenant_id/room_id/result below are fully
  // caller-controlled — require a real card for device-authenticated callers (the
  // card row is the only trusted identity). Admin UI test posts are exempt.
  if (req.device && !cardId) {
    return res.status(400).json({ error: 'cardId required for device access events', code: 'CARD_REQUIRED' });
  }
  try {
    // Card-driven access decision. When a physical card is presented, the
    // card ROW — not the request body — is the source of truth for which
    // tenant/room the event belongs to, and a revoked card is ALWAYS denied.
    //
    // This is the software enforcement point for the revoke-on-overdue
    // feature: tickAccessControlSync flips access_cards.status='revoked', and
    // here we honor it so a revoked card can never be recorded as 'granted'.
    // Without this, `result` was whatever the caller sent and tenant_id/card_id
    // could be forged for any tenant by anyone holding a device token —
    // fabricating "tenant X entered room Y" in the system-of-record log.
    let roomId = b.roomId ? String(b.roomId).slice(0, 32) : null;
    let tenantId = Number.isInteger(Number(b.tenantId)) ? Number(b.tenantId) : null;
    let result = requestedResult;
    let reason = b.reason ? String(b.reason).slice(0, 200) : null;
    if (cardId) {
      const { rows: cardRows } = await pool.query(
        `SELECT card_id, tenant_id, room_id, status FROM access_cards WHERE card_id=$1 LIMIT 1`,
        [cardId]
      );
      if (!cardRows.length) {
        // Unknown card → never grant; record honestly as denied even if the
        // caller claimed 'granted'. Don't attribute to any tenant.
        result = 'denied';
        reason = reason || 'unknown_card';
        tenantId = null;
      } else {
        const card = cardRows[0];
        // Authoritative identity from the card, not the body (anti-forgery).
        tenantId = card.tenant_id;
        roomId = card.room_id || roomId;
        if (card.status === 'revoked') {
          result = 'denied';
          reason = reason || 'card_revoked';
        }
      }
    }
    // Even a valid, non-revoked card is denied when the cardholder is no longer an
    // active tenant (moved out / blacklisted / soft-deleted). Card ISSUE now also
    // requires an active tenant, but a tenant can go inactive AFTER a card was
    // issued (e.g. force move-out that didn't collect the physical tag), so the
    // status is re-checked here at decision time.
    if (result === 'granted' && tenantId != null) {
      const { rows: tRows } = await pool.query(
        `SELECT status, deleted_at, current_room_id FROM tenants WHERE id=$1 LIMIT 1`,
        [tenantId]
      );
      const holder = tRows[0];
      if (!holder || holder.deleted_at || holder.status !== 'active') {
        result = 'denied';
        reason = reason || 'tenant_inactive';
      } else if (roomId && String(holder.current_room_id || '') !== String(roomId)) {
        // The card is bound to a room, but the holder no longer occupies it.
        // A returning tenant keeps the same tenant id (re-rented elsewhere),
        // and an auto-expired contract can leave a stale 'active' card on the
        // OLD room — both pass the active-tenant check above. Bind the grant
        // to the tenant's CURRENT room so an old card can't open a room they
        // no longer rent.
        result = 'denied';
        reason = reason || 'room_mismatch';
      }
    }
    const { rows } = await pool.query(
      `INSERT INTO access_logs (room_id, tenant_id, device, method, card_id, result, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [roomId, tenantId, device, method, cardId, result, reason]
    );
    audit(req, 'access.log', 'access', String(rows[0].id));
    res.json({ ok: true, log: rows[0], decision: result });
  } catch (err) {
    console.error('access log error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/access/logs', requireAuth, requireRole('owner', 'manager'), features.requireFeature('accessControl'), async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  try {
    const { rows } = await pool.query(
      `SELECT id,
              NULLIF(left(COALESCE(room_id, ''), 32), '') AS room_id,
              tenant_id,
              left(COALESCE(device, ''), 64) AS device,
              left(COALESCE(method, ''), 16) AS method,
              NULLIF(left(COALESCE(card_id, ''), 64), '') AS card_id,
              left(COALESCE(result, ''), 16) AS result,
              NULLIF(left(COALESCE(reason, ''), 200), '') AS reason,
              occurred_at
         FROM access_logs ORDER BY occurred_at DESC LIMIT $1`,
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
app.get('/api/access/cards', requireAuth, requireRole('owner', 'manager'), features.requireFeature('accessControl'), async (req, res) => {
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
          `SELECT 1 FROM tenants WHERE id=$1 AND deleted_at IS NULL AND status='active' LIMIT 1`,
          [tenantId]
        );
        if (!t.rows.length) return res.status(404).json({ error: 'tenant not found or not active', code: 'TENANT_NOT_ACTIVE' });
      }
      // Recycle a physical card. card_id is globally UNIQUE, so a tag whose
      // previous holder checked out (row left 'revoked') could never be
      // re-registered to the next tenant — a 409 forever, despite the physical
      // card being free. Re-issue ONLY when the existing row is 'revoked':
      // reassign it to the new tenant/room and reactivate. An 'active' row is
      // genuinely in use → still a clean 409 (no silent steal of a live card).
      let rows;
      try {
        ({ rows } = await pool.query(
          `INSERT INTO access_cards (card_id, tenant_id, room_id, status)
           VALUES ($1,$2,$3,'active')
           RETURNING id, card_id, tenant_id, room_id, status, issued_at`,
          [cardId, tenantId, roomId]
        ));
      } catch (err) {
        if (err.code !== '23505') throw err;
        const recycled = await pool.query(
          `UPDATE access_cards
              SET tenant_id=$2, room_id=$3, status='active',
                  issued_at=NOW(), revoked_at=NULL, revoke_reason=NULL
            WHERE card_id=$1 AND status='revoked'
          RETURNING id, card_id, tenant_id, room_id, status, issued_at`,
          [cardId, tenantId, roomId]
        );
        if (!recycled.rows.length) {
          // Row exists and is still active → genuinely in use.
          return res.status(409).json({ error: 'card_id ซ้ำ — บัตรนี้ยังใช้งานอยู่ ใช้รหัสอื่นหรือเพิกถอนบัตรเดิมก่อน', code: 'DUPLICATE_CARD_ID' });
        }
        rows = recycled.rows;
        audit(req, 'access_card.recycle', 'card', String(rows[0].id),
          { cardId, tenantId, roomId, note: 'reissued previously-revoked physical card' });
        return res.json({ ok: true, card: rows[0], recycled: true });
      }
      audit(req, 'access_card.create', 'card', String(rows[0].id),
        { cardId, tenantId, roomId });
      res.json({ ok: true, card: rows[0] });
    } catch (err) {
      console.error('access card create error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

app.put('/api/access/cards/:id/revoke', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'), features.requireFeature('accessControl'),
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

app.put('/api/access/cards/:id/restore', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'), features.requireFeature('accessControl'),
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

    // Security: a password reset or role change must invalidate the target's
    // EXISTING server sessions, otherwise a hijacked/old session cookie outlives
    // the credential/permission change (requireAuth only re-reads role + that
    // the user still exists, not a password epoch). Keep the actor's own current
    // session when they reset their OWN password so they aren't logged out.
    if (password || (role && role !== before.role)) {
      try {
        if (isSelf && req.sessionID) {
          await pool.query(
            `DELETE FROM user_sessions WHERE (sess::jsonb->'user'->>'id')::int = $1 AND sid <> $2`,
            [id, req.sessionID]
          );
        } else {
          await pool.query(
            `DELETE FROM user_sessions WHERE (sess::jsonb->'user'->>'id')::int = $1`,
            [id]
          );
        }
      } catch (e) {
        console.warn('[admin/users update] session purge failed:', e.message);
      }
    }

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
    // Security: kill any live sessions for the deleted account so an open
    // browser/cookie can't keep acting as a user that no longer exists.
    await pool.query(
      `DELETE FROM user_sessions WHERE (sess::jsonb->'user'->>'id')::int = $1`,
      [id]
    ).catch((e) => console.warn('[admin/users delete] session purge failed:', e.message));
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
    // hit the system owner channel. User-management changes are a security
    // trail (hijacked owner session leaves a visible wake) — category
    // 'security' unless the caller tagged otherwise.
    await notifier.notifyOwner({ pool, features: flags }, { category: 'security', ...msg });
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
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  try {
    const [failed, locked] = await Promise.all([
      pool.query(
        `SELECT id, user_id, action, ip, ua, detail, created_at
           FROM audit_logs
          WHERE action IN ('auth.login_failed','tenant.login_failed','auth.login_locked')
             OR action LIKE 'security.%'
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
app.get('/api/admin/access-devices', requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 100);
  try {
    const { rows } = await pool.query(
      `SELECT id,
              left(COALESCE(device_id, ''), 64) AS device_id,
              enabled,
              NULLIF(left(COALESCE(description, ''), 200), '') AS description,
              last_seen,
              created_at
         FROM access_devices ORDER BY created_at DESC LIMIT $1`,
      [limit]
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
// owner/manager only — the log holds recipient contact info + message bodies,
// and the UI page (page-notifications.jsx) is already minRole:'manager'.
app.get('/api/notifications/log', requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
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
// Same-origin + lightly rate-limited so third-party pages can't spam the
// audit log, while frontend errors can still report before CSRF bootstraps.
const _clientErrLimit = makeIpLimiter({ windowMs: 60_000, max: 30 });
app.post('/api/client-error', sameOrigin, _clientErrLimit, async (req, res) => {
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
  // Token signing helpers — bills-extras uses signBillQrToken when
  // building Flex Messages so the embedded /p/bill-qr URL passes the
  // HMAC check at fetch time (LINE Platform has no session).
  signBillQrToken,
  signBillPayToken,
  processTenantSlipUpload,
  // Shared with /api/bills/render in routes/bills-extras.js. These helpers
  // live in this file because the tenant-side PDF endpoint and admin-side
  // QR/render paths also reach for them; rather than duplicate the bodies
  // we expose them via ctx so bills-extras.js can call into the same
  // singletons (PDF concurrency slot + payment-block builder + config
  // loader). sanitizeError is the request-id-aware logger.
  acquirePdfSlot,
  releasePdfSlot,
  loadBillingConfig,
  loadEffectivePaymentBlock,
  buildEffectivePaymentBlock,
  sanitizeError,
};
const _routesMounted = _routesIndex(app, _routesCtx);

// === v2: Contracts CRUD ===================================================
// The contracts table is populated by /api/tenants/:id/checkin (which is
async function expirePendingContractInvitations(db) {
  try {
    await db.query(
      `UPDATE contract_invitations
          SET status='expired', updated_at=NOW()
        WHERE status='pending'
          AND expires_at IS NOT NULL
          AND expires_at <= NOW()`
    );
  } catch (err) {
    if (err.code !== '42P01' && err.code !== '42703') {
      console.warn('[contracts] stale invitation expiry skipped:', err.message);
    }
  }
}

function contractWarning(code, severity, title, consequence, action, extra = {}) {
  return { code, severity, title, consequence, action, ...extra };
}

function buildContractWarnings(row) {
  const warnings = [];
  const isActive = row.status === 'active';
  const locked = !!row.locked_at;
  const tenantRoom = row.tenant_current_room_id || row.current_room_id || null;
  const endYmd = row.end_date ? String(row.end_date).slice(0, 10) : null;
  const todayYmd = billing.localTodayYmd();

  if (isActive && row.tenant_id && !row.tenant_status) {
    warnings.push(contractWarning(
      'CONTRACT_TENANT_MISSING',
      'error',
      'ไม่พบผู้เช่าที่ผูกกับสัญญา',
      'ถ้าใช้สัญญานี้ต่อ ระบบจะออกบิล/แจ้งเตือนผู้เช่าไม่ได้ครบถ้วน เพราะ tenant row หายหรือถูกลบ',
      'ตรวจ tenant_id ในสัญญา แล้วผูกผู้เช่าใหม่หรือปิดสัญญานี้'
    ));
  }
  if (isActive && row.tenant_status && row.tenant_status !== 'active') {
    warnings.push(contractWarning(
      'ACTIVE_CONTRACT_INACTIVE_TENANT',
      'error',
      'สัญญายัง active แต่ผู้เช่าไม่ได้ active',
      'ถ้าปล่อยไว้ scheduler อาจยังคิดว่าสัญญามีผล แต่ผู้เช่าจะไม่อยู่ใน flow ห้อง/บิลตามปกติ',
      'checkout ให้ครบหรือปรับสถานะผู้เช่าและห้องให้ตรงกัน'
    ));
  }
  if (isActive && row.tenant_status === 'active' && row.room_id
      && tenantRoom && String(tenantRoom) !== String(row.room_id)) {
    warnings.push(contractWarning(
      'TENANT_ROOM_MISMATCH',
      'error',
      'ห้องในสัญญาไม่ตรงกับห้องปัจจุบันของผู้เช่า',
      'ถ้าออกบิลหรือ approve งานต่อ ระบบอาจผูกค่าใช้จ่าย/สถานะห้องผิดห้อง',
      'ตรวจว่าผู้เช่าย้ายห้องแล้วหรือยัง ถ้าย้ายแล้วให้ checkout/reconcile ให้ครบก่อน'
    ));
  }
  if (isActive && row.tenant_status === 'active' && row.room_id && !tenantRoom) {
    warnings.push(contractWarning(
      'TENANT_ROOM_EMPTY',
      'error',
      'ผู้เช่า active แต่ไม่มี current_room_id',
      'ถ้าออกบิลหรือแจ้งเตือนต่อ ระบบจะไม่รู้ว่าผู้เช่าควรอยู่ห้องใด แม้สัญญายัง active',
      'ผูกผู้เช่ากลับเข้าห้องในสัญญา หรือปิดสัญญา/checkout ถ้าย้ายออกแล้ว'
    ));
  }
  if (isActive && (!Number.isFinite(Number(row.monthly_rent)) || Number(row.monthly_rent) <= 0)) {
    warnings.push(contractWarning(
      'CONTRACT_RENT_INVALID',
      'error',
      'ค่าเช่าในสัญญาไม่ถูกต้อง',
      'ถ้าระบบออกบิลจากสัญญานี้ ค่าเช่าอาจเป็น 0 หรือ fallback ไปสูตรราคาอื่น ทำให้ยอดไม่ตรงสัญญา',
      'แก้ค่าเช่าก่อน lock/ออกบิล หรือสร้างสัญญาใหม่ด้วยค่าเช่าที่ถูกต้อง'
    ));
  }
  const rentAssessment = pricing.assessContractRent({ monthlyRent: row.monthly_rent });
  if (isActive && !rentAssessment.ok && rentAssessment.code === 'CONTRACT_RENT_TOO_LOW') {
    warnings.push(contractWarning(
      'CONTRACT_RENT_TOO_LOW',
      'error',
      'ค่าเช่าในสัญญาต่ำผิดปกติ',
      `ค่าเช่า ${rentAssessment.rent} ต่ำกว่าขั้นต่ำที่ระบบยอมรับ (${rentAssessment.minimumRent}) อาจเกิดจากพิมพ์ตกศูนย์หรือ config ราคาเก่าค้าง`,
      'ตรวจค่าเช่าในสัญญาและสร้างฉบับใหม่/แก้ข้อมูลก่อนอนุมัติหรือออกบิล',
      {
        monthlyRent: rentAssessment.rent,
        minimumRent: rentAssessment.minimumRent,
      }
    ));
  }
  if (isActive && Number(row.deposit) < 0) {
    warnings.push(contractWarning(
      'CONTRACT_DEPOSIT_INVALID',
      'error',
      'เงินมัดจำติดลบ',
      'ถ้า checkout/refund จากข้อมูลนี้ ยอดคืนมัดจำจะผิด',
      'แก้เงินมัดจำก่อนทำรายการต่อ'
    ));
  }
  if (isActive && endYmd && endYmd < todayYmd) {
    warnings.push(contractWarning(
      'ACTIVE_CONTRACT_END_DATE_PAST',
      'error',
      'สัญญาเลยวันสิ้นสุดแล้วแต่ยัง active',
      'ถ้าปล่อยไว้ ระบบอาจยังออกบิล/ให้สิทธิผู้เช่าเหมือนสัญญายังมีผล ทั้งที่ควรต่อสัญญาหรือปิดสัญญา',
      'ต่อสัญญาใหม่ หรือปิดเป็นหมดอายุ/สิ้นสุดพร้อมเหตุผล'
    ));
  }
  if (!isActive && row.active_invitation_status) {
    warnings.push(contractWarning(
      'CLOSED_CONTRACT_HAS_ACTIVE_INVITATION',
      'warn',
      'สัญญาปิดแล้วแต่ยังมีลิงก์กรอกสัญญาค้าง',
      'ผู้เช่าอาจเห็นลิงก์ที่ไม่ควรใช้ต่อ หรือ admin อาจเข้าใจผิดว่ายังรอผู้เช่ากรอก',
      'ยกเลิก invitation หรือออกสัญญาใหม่ถ้ายังต้องการให้เช่าต่อ'
    ));
  }

  const missingIdentity = [];
  if (!row.address) missingIdentity.push('address');
  if (!row.emergency_contact_name) missingIdentity.push('emergencyContactName');
  if (!row.emergency_contact_phone) missingIdentity.push('emergencyContactPhone');
  if (!row.citizen_id_tail) missingIdentity.push('citizenId');
  if (!row.citizen_id_image_front_id) missingIdentity.push('citizenIdFront');
  if (!row.citizen_id_image_back_id) missingIdentity.push('citizenIdBack');
  if (isActive && missingIdentity.length) {
    warnings.push(contractWarning(
      'CONTRACT_IDENTITY_INCOMPLETE',
      locked ? 'error' : 'warn',
      'ข้อมูลผู้เช่า/เอกสารประกอบสัญญายังไม่ครบ',
      locked
        ? 'สัญญานี้ถูก lock แล้ว แต่เอกสารไม่ครบ ทำให้หลักฐานหลังอนุมัติไม่สมบูรณ์'
        : 'ถ้า lock/approve ตอนนี้ สัญญาจะถูกปิดแก้ไขทั้งที่ข้อมูลสำคัญยังไม่ครบ',
      'ให้ผู้เช่ากรอก/อัปโหลดเอกสารให้ครบ หรือ mark เป็น legacy อย่างตั้งใจ',
      { missing: missingIdentity }
    ));
  }
  if (locked && row.has_terms_template_snapshot === false) {
    warnings.push(contractWarning(
      'LOCKED_CONTRACT_MISSING_TERMS_SNAPSHOT',
      'error',
      'สัญญา lock แล้วแต่ไม่มี snapshot เงื่อนไข',
      'ถ้าแก้ template ภายหลัง PDF ย้อนหลังอาจเปลี่ยนตาม template ใหม่ ไม่ immutable ตามหลักฐานวันที่เซ็น',
      'backfill terms_template_snapshot จาก template ที่ตั้งใจใช้ในวันอนุมัติ'
    ));
  }
  if (!locked && row.active_invitation_status === 'pending'
      && row.active_invitation_expires_at
      && new Date(row.active_invitation_expires_at).getTime() <= Date.now()) {
    warnings.push(contractWarning(
      'PENDING_INVITATION_EXPIRED',
      'warn',
      'ลิงก์ให้ผู้เช่ากรอกหมดอายุแล้ว',
      'ผู้เช่าจะเปิดลิงก์เดิมไม่ได้ และงานจะค้างในระบบจนออกลิงก์ใหม่หรือปิด invitation',
      'ออก invitation ใหม่หลังตรวจข้อมูลห้อง/ผู้เช่า'
    ));
  }
  if (!locked && !row.template_id && row.has_default_template === false) {
    warnings.push(contractWarning(
      'NO_DEFAULT_CONTRACT_TEMPLATE',
      'warn',
      'ยังไม่ได้ตั้ง default template',
      'ถ้า preview/approve โดยไม่ผูก template ระบบจะ fallback ไปเงื่อนไข legacy/default ทำให้รูปแบบสัญญาไม่ predictable',
      'ตั้ง default template ที่หน้าเทมเพลตสัญญา'
    ));
  }
  return warnings;
}

function contractWarningSeverity(warnings) {
  if (!warnings || !warnings.length) return 'ok';
  if (warnings.some((w) => w.severity === 'error')) return 'error';
  return 'warn';
}

const CONTRACT_CLOSE_TYPES = new Set([
  'early_move_out',
  'mutual_cancel',
  'no_show',
  'natural_expiry',
  'admin_correction',
]);

function normalizeContractCloseReason(body) {
  return String(body?.closeReason ?? body?.cancelReason ?? body?.reason ?? '')
    .trim()
    .slice(0, 500);
}

function normalizeContractCloseType(body, status) {
  const raw = String(body?.closeType || '').trim();
  if (raw) return raw;
  return status === 'expired' ? 'natural_expiry' : 'early_move_out';
}

function addContractMonths(startYmd, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(startYmd || ''));
  const n = Number(months);
  if (!m || !Number.isInteger(n) || n < 1) return null;
  const sy = Number(m[1]);
  const sm = Number(m[2]);
  const sd = Number(m[3]);
  const totalMonths = (sy * 12 + (sm - 1)) + n;
  const ey = Math.floor(totalMonths / 12);
  const em = (totalMonths % 12) + 1;
  const lastDom = new Date(Date.UTC(ey, em, 0)).getUTCDate();
  const ed = Math.min(sd, lastDom);
  return `${ey}-${String(em).padStart(2, '0')}-${String(ed).padStart(2, '0')}`;
}

function estimateContractMonths(startYmd, endYmd, maxMonths = 120) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startYmd || ''))
      || !/^\d{4}-\d{2}-\d{2}$/.test(String(endYmd || ''))
      || String(endYmd) < String(startYmd)) {
    return null;
  }
  const max = Math.max(1, Math.min(240, Number(maxMonths) || 120));
  for (let i = 1; i <= max; i += 1) {
    if (addContractMonths(startYmd, i) === endYmd) return i;
  }
  return null;
}

function contractInvitationDeliveryText(contract, url, expiresAt) {
  const expires = expiresAt ? new Date(expiresAt).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }) : '-';
  return [
    `กรุณากรอกข้อมูลสัญญาเช่า ${contract.contract_no || ''}`.trim(),
    contract.room_id ? `ห้อง: ${contract.room_id}` : null,
    `ลิงก์กรอกสัญญา: ${url}`,
    `หมดอายุ: ${expires}`,
    `หลังกรอกเสร็จ ระบบจะส่งให้เจ้าของหอพักตรวจและอนุมัติ`,
  ].filter(Boolean).join('\n');
}

async function tryNotifyTenantContractInvitation(tenant, contract, url, expiresAt) {
  if (!tenant || !tenant.id) {
    return { ok: false, channel: 'none', reason: 'tenant not linked' };
  }
  try {
    const flags = await features.load(pool);
    const result = await notifier.notifyTenant({ pool, features: flags }, {
      ...tenant,
      status: tenant.status || tenant.tenant_status || 'active',
    }, {
      subject: `ลิงก์กรอกสัญญา ${contract.contract_no}`,
      text: contractInvitationDeliveryText(contract, url, expiresAt),
      force: true,
    });
    return result || { ok: false, channel: 'none' };
  } catch (err) {
    console.warn('[contracts] invite delivery failed:', err.message);
    return { ok: false, channel: 'none', reason: err.message };
  }
}

function validateContractApprovalDraft(draft) {
  const required = [
    ['signatureFileId', 'signature', 'ลายเซ็นผู้เช่า', 'สัญญาจะถูก lock โดยไม่มีลายเซ็นใน PDF'],
    ['address', 'address', 'ที่อยู่ผู้เช่า', 'สัญญาจะถูก lock โดยไม่มีที่อยู่สำหรับอ้างอิงตามเอกสาร'],
    ['emergencyContactName', 'emergencyContactName', 'ชื่อผู้ติดต่อฉุกเฉิน', 'ทีมงานจะไม่มีคนติดต่อเมื่อเกิดเหตุฉุกเฉิน'],
    ['emergencyContactPhone', 'emergencyContactPhone', 'เบอร์ผู้ติดต่อฉุกเฉิน', 'ทีมงานจะโทรหาผู้ติดต่อฉุกเฉินไม่ได้'],
    ['citizenId', 'citizenId', 'เลขบัตรประชาชน 13 หลัก', 'สัญญาจะถูก lock โดยไม่มีเลขบัตรประชาชนสำหรับยืนยันตัวตนและตรวจซ้ำ'],
    ['citizenIdImageFrontId', 'citizenIdFront', 'รูปบัตรประชาชนด้านหน้า', 'ตรวจตัวตนย้อนหลังไม่ได้ครบถ้วน'],
    ['citizenIdImageBackId', 'citizenIdBack', 'รูปบัตรประชาชนด้านหลัง', 'เอกสารยืนยันตัวตนไม่ครบทั้งสองด้าน'],
  ];
  const issues = [];
  const thaiId = require('./services/thaiId');
  for (const [field, code, label, consequence] of required) {
    const value = draft && draft[field];
    const missing = field === 'citizenId'
      ? !thaiId.normalize(value)
      : field.endsWith('Id')
      ? (!Number.isInteger(Number(value)) || Number(value) < 1)
      : !String(value || '').trim();
    if (missing) {
      issues.push({
        field,
        code,
        label,
        consequence,
        action: 'reject ใบเชิญนี้กลับให้ผู้เช่าแก้ไข แล้ว approve ใหม่เมื่อข้อมูลครบ',
      });
    }
  }
  return issues;
}

async function validateContractDraftFiles(db, invitationId, draft) {
  const expectedRef = `invitation-${invitationId}`;
  const checks = [
    {
      field: 'signatureFileId',
      code: 'signatureFile',
      label: 'ไฟล์ลายเซ็นผู้เช่า',
      category: 'contract_signature',
      side: null,
      consequence: 'ลายเซ็นใน draft ไม่ได้มาจากลิงก์ invitation นี้ จึงอาจเป็นไฟล์ผิดคนหรือไฟล์ที่ถูกเดา id',
    },
    {
      field: 'citizenIdImageFrontId',
      code: 'citizenIdFrontFile',
      label: 'ไฟล์บัตรประชาชนด้านหน้า',
      category: 'citizen_id_image',
      side: 'front',
      consequence: 'รูปบัตรด้านหน้าใน draft ไม่ได้มาจากลิงก์ invitation นี้ จึงอาจเป็นไฟล์ผิดคนหรือผิดด้าน',
    },
    {
      field: 'citizenIdImageBackId',
      code: 'citizenIdBackFile',
      label: 'ไฟล์บัตรประชาชนด้านหลัง',
      category: 'citizen_id_image',
      side: 'back',
      consequence: 'รูปบัตรด้านหลังใน draft ไม่ได้มาจากลิงก์ invitation นี้ จึงอาจเป็นไฟล์ผิดคนหรือผิดด้าน',
    },
  ];
  const issues = [];
  for (const check of checks) {
    const id = Number(draft && draft[check.field]);
    if (!Number.isInteger(id) || id < 1) continue;
    const params = [id, check.category, expectedRef];
    let sideSql = '';
    if (check.side) {
      params.push(check.side);
      sideSql = ` AND (side=$4 OR side IS NULL)`;
    }
    const { rows } = await db.query(
      `SELECT id FROM file_uploads
        WHERE id=$1
          AND category=$2
          AND ref_id=$3
          ${sideSql}
        FOR UPDATE`,
      params
    );
    if (!rows.length) {
      issues.push({
        field: check.field,
        code: check.code,
        label: check.label,
        consequence: check.consequence,
        action: 'ให้ผู้เช่าอัปโหลดไฟล์ใหม่ผ่านลิงก์สัญญานี้เท่านั้น แล้วส่งตรวจสอบอีกครั้ง',
      });
    }
  }
  return issues;
}

function validateContractApprovalTarget(inv, contract) {
  const issues = [];
  if (!contract.room_id) {
    issues.push({
      code: 'CONTRACT_ROOM_REQUIRED',
      field: 'room_id',
      label: 'สัญญาไม่มีเลขห้อง',
      consequence: 'approve แล้วระบบจะผูกผู้เช่าเข้าห้องไม่ได้ และ billing/room status จะเพี้ยน',
      action: 'แก้หรือสร้างสัญญาใหม่ให้มี room_id ก่อน approve',
    });
  }
  if (contract.status !== 'active') {
    issues.push({
      code: 'CONTRACT_NOT_ACTIVE',
      field: 'status',
      label: `สัญญาสถานะ ${contract.status || '-'}`,
      consequence: 'approve แล้วจะ lock สัญญาที่ไม่ได้มีผลใช้งาน ทำให้ flow เช่าและบิลสับสน',
      action: 'ใช้เฉพาะสัญญา active หรือสร้างสัญญาใหม่',
    });
  }
  const rentAssessment = pricing.assessContractRent({ monthlyRent: contract.monthly_rent });
  if (rentAssessment.code === 'CONTRACT_RENT_INVALID') {
    issues.push({
      code: 'CONTRACT_RENT_INVALID',
      field: 'monthly_rent',
      label: 'ค่าเช่าไม่ถูกต้อง',
      consequence: 'บิลแรกและบิลรายเดือนอาจเป็น 0 หรือไม่ตรงกับที่ตกลงในสัญญา',
      action: 'แก้ค่าเช่าให้ถูกต้องก่อน approve',
    });
  }
  if (rentAssessment.code === 'CONTRACT_RENT_TOO_LOW') {
    issues.push({
      code: 'CONTRACT_RENT_TOO_LOW',
      field: 'monthly_rent',
      label: 'ค่าเช่าต่ำผิดปกติ',
      consequence: `ค่าเช่า ${rentAssessment.rent} ต่ำกว่าขั้นต่ำที่ระบบยอมรับ (${rentAssessment.minimumRent}) ถ้า approve ต่อ บิลรายเดือนจะต่ำผิดจริง`,
      action: 'ตรวจว่าพิมพ์ตกศูนย์หรือไม่ แล้วสร้าง/แก้สัญญาด้วยค่าเช่าที่ถูกต้องก่อน approve',
      detail: {
        monthlyRent: rentAssessment.rent,
        minimumRent: rentAssessment.minimumRent,
      },
    });
  }
  if (Number(contract.deposit) < 0) {
    issues.push({
      code: 'CONTRACT_DEPOSIT_INVALID',
      field: 'deposit',
      label: 'เงินมัดจำติดลบ',
      consequence: 'ยอดคืนมัดจำตอน checkout จะผิด',
      action: 'แก้เงินมัดจำก่อน approve',
    });
  }
  // Date sanity — the create paths (quick-invite / checkin) validate this,
  // but a contract edited or migrated outside those paths could reach
  // approval with end < start. Locking such a contract poisons everything
  // downstream: term display, expiry scheduler, closing-bill proration.
  if (contract.start_date && contract.end_date
      && String(contract.end_date) < String(contract.start_date)) {
    issues.push({
      code: 'CONTRACT_DATES_INVALID',
      field: 'end_date',
      label: `วันสิ้นสุดสัญญา (${contract.end_date}) มาก่อนวันเริ่ม (${contract.start_date})`,
      consequence: 'สัญญาจะหมดอายุทันทีที่ approve และวันครบกำหนด/บิลปิดยอดจะคำนวณผิด',
      action: 'แก้วันเริ่ม/วันสิ้นสุดสัญญาให้ถูกต้องก่อน approve',
    });
  }
  if (contract.tenant_id && inv.tenant_id
      && Number(contract.tenant_id) !== Number(inv.tenant_id)) {
    issues.push({
      code: 'CONTRACT_TENANT_MISMATCH',
      field: 'tenant_id',
      label: 'ผู้เช่าในสัญญาไม่ตรงกับผู้เช่าใน invitation',
      consequence: 'ข้อมูลที่ผู้เช่ากรอกจะถูกบันทึกให้คนหนึ่ง แต่สัญญา/บิลอาจผูกกับอีกคน',
      action: 'ยกเลิก invitation นี้ แล้วออกใหม่จากสัญญาที่ผูก tenant ถูกต้อง',
    });
  }
  return issues;
}

function approvalIssueSummary(issues, fallbackError, fallbackHint) {
  const list = Array.isArray(issues) ? issues.filter(Boolean) : [];
  const primary = list[0] || {};
  const firstLabel = primary.label || primary.code || '';
  const firstAction = primary.action || primary.consequence || fallbackHint || '';
  const detail = primary.detail && typeof primary.detail === 'object' ? primary.detail : {};
  const valueBits = [];
  if (detail.monthlyRent !== undefined) valueBits.push(`ค่าเช่า ${detail.monthlyRent}`);
  if (detail.minimumRent !== undefined) valueBits.push(`ขั้นต่ำ ${detail.minimumRent}`);
  const valueText = valueBits.length ? ` (${valueBits.join(' / ')})` : '';
  return {
    error: firstLabel
      ? `${fallbackError}: ${firstLabel}${valueText}`
      : fallbackError,
    hint: firstAction || fallbackHint || null,
    issueSummary: list.slice(0, 6).map((issue) => ({
      code: issue.code || null,
      label: issue.label || issue.field || issue.code || 'ตรวจสอบข้อมูล',
      action: issue.action || null,
      consequence: issue.consequence || null,
      detail: issue.detail || null,
    })),
  };
}

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
      await expirePendingContractInvitations(pool);
      ({ rows } = await pool.query(
        `SELECT c.id, c.contract_no, c.tenant_id, c.room_id,
                c.start_date, c.end_date, c.term_months,
                c.monthly_rent, c.deposit, c.discount_pct,
                c.booking_fee_credit, c.deposit_balance_due,
                c.deposit_returned, c.deposit_returned_at,
                c.status, c.signed_at, c.created_at,
                c.closed_at, c.closed_by, c.closed_reason, c.closed_type,
                c.locked_at, c.locked_by, c.template_id,
                c.terms_template_snapshot IS NOT NULL AS has_terms_template_snapshot,
                c.signature_image_id,
                t.full_name AS tenant_name, t.phone AS tenant_phone,
                t.status AS tenant_status, t.current_room_id AS tenant_current_room_id,
                t.address, t.emergency_contact_name, t.emergency_contact_phone,
                t.citizen_id_tail,
                t.citizen_id_image_front_id, t.citizen_id_image_back_id,
                CASE WHEN c.end_date IS NULL THEN NULL
                     ELSE (c.end_date - CURRENT_DATE)::int
                END AS days_left,
                -- Surface the active invitation status (if any) so admin
                -- sees at-a-glance whether the link is still pending or
                -- the tenant has already submitted for review.
                (SELECT i.status FROM contract_invitations i
                   WHERE i.contract_id = c.id
                     AND i.status IN ('pending','submitted')
                   ORDER BY i.created_at DESC LIMIT 1) AS active_invitation_status,
                (SELECT i.expires_at FROM contract_invitations i
                   WHERE i.contract_id = c.id
                     AND i.status IN ('pending','submitted')
                   ORDER BY i.created_at DESC LIMIT 1) AS active_invitation_expires_at,
                -- id too, so the UI's "รอตรวจสอบ →" pill can deep-link
                -- straight into that invitation's review modal.
                (SELECT i.id FROM contract_invitations i
                   WHERE i.contract_id = c.id
                     AND i.status IN ('pending','submitted')
                   ORDER BY i.created_at DESC LIMIT 1) AS active_invitation_id,
                EXISTS (
                  SELECT 1 FROM contract_templates tpl
                   WHERE tpl.deleted_at IS NULL
                     AND tpl.enabled = TRUE
                     AND tpl.is_default = TRUE
                ) AS has_default_template
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
    const contracts = rows.map((row) => {
      const warnings = buildContractWarnings(row);
      return {
        ...row,
        warnings,
        warning_severity: contractWarningSeverity(warnings),
      };
    });
    res.json({ ok: true, contracts });
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
    const requestedStatus = b.status !== undefined ? String(b.status) : undefined;
    const isClosingContract = requestedStatus === 'ended' || requestedStatus === 'expired';
    const closeReason = normalizeContractCloseReason(b);
    const closeType = normalizeContractCloseType(b, requestedStatus);
    if (isClosingContract) {
      if (!closeReason) {
        return res.status(400).json({
          error: 'closeReason is required when closing a contract',
          code: 'CONTRACT_CLOSE_REASON_REQUIRED',
          hint: 'ระบุเหตุผล เช่น ผู้เช่าออกก่อนกำหนด / ยกเลิกตามตกลง / หมดอายุตามกำหนด เพื่อให้ audit และการแจ้งเตือนครบถ้วน',
        });
      }
      if (!CONTRACT_CLOSE_TYPES.has(closeType)) {
        return res.status(400).json({
          error: 'closeType is invalid',
          code: 'CONTRACT_CLOSE_TYPE_INVALID',
          allowed: Array.from(CONTRACT_CLOSE_TYPES),
        });
      }
    }
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
      if (!['active', 'ended', 'expired'].includes(requestedStatus)) {
        return res.status(400).json({ error: 'status must be active|ended|expired' });
      }
      fields.push(`status=$${i++}`); params.push(requestedStatus);
    }
    if (isClosingContract && b.endDate === undefined) {
      fields.push(requestedStatus === 'expired'
        ? `end_date=CASE WHEN end_date IS NOT NULL AND end_date <= CURRENT_DATE THEN end_date ELSE CURRENT_DATE END`
        : `end_date=CURRENT_DATE`);
    }
    if (isClosingContract) {
      fields.push('closed_at=COALESCE(closed_at, NOW())');
      fields.push(`closed_by=$${i++}`); params.push(req.session.user.username);
      fields.push(`closed_reason=$${i++}`); params.push(closeReason);
      fields.push(`closed_type=$${i++}`); params.push(closeType);
    }
    if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
    // Always bump updated_at so audit history reflects the actual edit time
    // (the new contracts.updated_at column has DEFAULT NOW() only on INSERT,
    // so we have to push it on every UPDATE for the timestamp to be useful).
    fields.push('updated_at=NOW()');

    // When admin manually flips status to 'ended' or 'expired', the
    // tenant is effectively moving out — sync tenant.status='moved_out'
    // + clear current_room_id + free the room state. Without this, the
    // contract shows ended but bills keep auto-generating and
    // /api/rooms still shows the room as occupied (drift #7 from audit).
    const materialEditRequested = b.discountPct !== undefined
      || b.termMonths !== undefined
      || (b.endDate !== undefined && !isClosingContract);

    const client = await pool.connect();
    let closeEffects = null;
    let closeTenantNotify = null;
    try {
      await client.query('BEGIN');
      const currentQ = await client.query(
        `SELECT c.*, t.full_name AS tenant_name, t.phone AS tenant_phone,
                t.email AS tenant_email, t.line_user_id, t.line_oa_id,
                t.status AS tenant_status, t.current_room_id AS tenant_current_room_id
           FROM contracts c
           LEFT JOIN tenants t ON t.id = c.tenant_id AND t.deleted_at IS NULL
          WHERE c.id=$1 AND c.deleted_at IS NULL
          FOR UPDATE OF c`,
        [id]
      );
      if (!currentQ.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'not found' });
      }
      const current = currentQ.rows[0];
      if (requestedStatus === 'active' && current.status !== 'active') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'closed contracts cannot be re-opened from this endpoint',
          code: 'CONTRACT_REOPEN_BLOCKED',
          hint: 'สร้างสัญญาใหม่หรือ check-in ใหม่ เพื่อไม่ให้ห้อง/ผู้เช่า/บิลย้อนสถานะผิด',
        });
      }
      if (isClosingContract && current.status !== 'active') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'contract is already closed',
          code: 'CONTRACT_ALREADY_CLOSED',
          currentStatus: current.status,
        });
      }
      if (materialEditRequested && current.locked_at) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'contract is locked; material terms cannot be edited',
          code: 'CONTRACT_LOCKED',
        });
      }
      const startDateYmd = current.start_date ? String(current.start_date).slice(0, 10) : null;
      if (!isClosingContract && b.endDate !== undefined && b.endDate !== null && startDateYmd) {
        const requestedEndDate = String(b.endDate);
        const maxEndDate = addContractMonths(startDateYmd, 120);
        if (requestedEndDate < startDateYmd) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'endDate must not be before contract start_date',
            code: 'INVALID_END_DATE',
            startDate: startDateYmd,
            endDate: requestedEndDate,
          });
        }
        if (maxEndDate && requestedEndDate > maxEndDate) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'endDate must be within 120 months from contract start_date',
            code: 'END_DATE_TOO_FAR',
            startDate: startDateYmd,
            endDate: requestedEndDate,
            maxEndDate,
          });
        }
      }
      if (!isClosingContract && b.termMonths !== undefined && b.termMonths !== null
          && b.endDate === undefined && startDateYmd) {
        const computedEndDate = addContractMonths(startDateYmd, Number(b.termMonths));
        if (computedEndDate) {
          fields.push(`end_date=$${i++}::date`);
          params.push(computedEndDate);
        }
      }
      if (!isClosingContract && b.endDate !== undefined && b.endDate !== null
          && b.termMonths === undefined && startDateYmd) {
        const estimatedMonths = estimateContractMonths(startDateYmd, String(b.endDate), 120);
        if (estimatedMonths) {
          fields.push(`term_months=$${i++}`);
          params.push(estimatedMonths);
        }
      }
      params.push(id);
      const { rows } = await client.query(
        `UPDATE contracts SET ${fields.join(', ')} WHERE id=$${i} AND deleted_at IS NULL RETURNING *`,
        params
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'not found' });
      }
      let contract = rows[0];

      // Repair the auto-expire vs admin-extend race. If admin pushes
      // end_date into the future on a contract that the scheduler had
      // already marked 'expired' (tickContractExpiry runs at 00:00), the
      // contract was left in {status='expired', end_date>NOW()} — a
      // self-contradicting state that the UI rendered as "ended" even
      // though it had a valid future end_date. Detect + auto-restore
      // status='active' when the new end_date is in the future, the
      // admin didn't explicitly request a status flip, and the row is
      // not soft-closed.
      const adminFlippedStatus = b.status !== undefined;
      const extendedIntoFuture = b.endDate !== undefined
        && b.endDate !== null
        && /^\d{4}-\d{2}-\d{2}$/.test(String(b.endDate))
        && new Date(b.endDate) >= new Date(new Date().toDateString());
      if (!adminFlippedStatus && extendedIntoFuture && contract.status === 'expired') {
        const repair = await client.query(
          `UPDATE contracts SET status='active', updated_at=NOW()
             WHERE id=$1 AND status='expired' AND deleted_at IS NULL
             RETURNING *`,
          [id]
        );
        if (repair.rows.length) {
          contract = repair.rows[0];
        }
      }

      // Cascade: closing the contract → tenant moves out + room freed.
      // Skip if tenant is already non-active (idempotent re-closure).
      // The invitation revoke + reserved-room release are keyed on the
      // CONTRACT alone — they must run even when tenant_id is NULL
      // (legacy/orphan rows), otherwise the fill link outlives the close.
      if (isClosingContract) {
        closeEffects = {
          tenantMovedOut: false,
          roomFreed: false,
          invitationsRevoked: 0,
          sessionsRevoked: 0,
          cardsRevoked: 0,
          recurringDeactivated: 0,
          warnings: [],
        };
        const revokedInvites = await client.query(
          `UPDATE contract_invitations
              SET status='revoked', revoked_at=NOW(), revoked_by=$2, updated_at=NOW()
            WHERE contract_id=$1 AND status IN ('pending','submitted')
            RETURNING id`,
          [contract.id, req.session.user.username]
        ).catch((err) => {
          if (err.code === '42P01' || err.code === '42703') return { rowCount: 0, rows: [] };
          throw err;
        });
        closeEffects.invitationsRevoked = revokedInvites.rowCount || 0;
      }
      if (isClosingContract && contract.tenant_id) {
        const tQ = await client.query(
          `SELECT id, status, current_room_id FROM tenants
             WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
          [contract.tenant_id]
        );
        const t = tQ.rows[0];
        // Renewal-overlap guard: when ANOTHER active contract for the same
        // tenant exists on the same room (old + renewal coexisting), closing
        // one of them must not evict the tenant from a tenancy that is
        // still live under the other.
        let roomOverlapContract = null;
        if (t && t.status === 'active' && contract.room_id
            && String(t.current_room_id || '') === String(contract.room_id)) {
          const ovQ = await client.query(
            `SELECT id, contract_no FROM contracts
               WHERE room_id=$1 AND tenant_id=$2 AND status='active'
                 AND deleted_at IS NULL AND id<>$3
               LIMIT 1`,
            [contract.room_id, contract.tenant_id, contract.id]
          );
          roomOverlapContract = ovQ.rows[0] || null;
        }
        if (roomOverlapContract) {
          closeEffects.warnings.push({
            code: 'TENANT_HAS_OTHER_ACTIVE_CONTRACT',
            message: `สัญญาถูกปิด แต่ผู้เช่ายังมีสัญญา ${roomOverlapContract.contract_no || roomOverlapContract.id} ที่ active บนห้องเดียวกัน (เช่น สัญญาต่ออายุ) จึงไม่ย้ายผู้เช่าออก/ปล่อยห้อง`,
          });
        } else if (t && t.status === 'active' && String(t.current_room_id || '') === String(contract.room_id)) {
          await client.query(
            `UPDATE tenants SET status='moved_out', current_room_id=NULL, updated_at=NOW()
               WHERE id=$1`,
            [contract.tenant_id]
          );
          closeEffects.tenantMovedOut = true;
          const sessions = await client.query(`DELETE FROM tenant_sessions WHERE tenant_id=$1`, [contract.tenant_id]);
          closeEffects.sessionsRevoked = sessions.rowCount || 0;
          const cards = await client.query(
            `UPDATE access_cards
                SET status='revoked', revoked_at=NOW(), revoke_reason=$2
              WHERE tenant_id=$1 AND status='active'
              RETURNING id`,
            [contract.tenant_id, `auto:contract-close:${closeType}`]
          ).catch((err) => {
            if (err.code === '42P01') return { rowCount: 0, rows: [] };
            throw err;
          });
          closeEffects.cardsRevoked = cards.rowCount || 0;
          const recurring = await client.query(
            `UPDATE recurring_charges
                SET active=FALSE, updated_at=NOW(),
                    notes = COALESCE(notes,'') || E'\n[auto] deactivated on contract close at ' || NOW()::text
              WHERE tenant_id=$1 AND active=TRUE
              RETURNING id`,
            [contract.tenant_id]
          ).catch((err) => {
            if (err.code === '42P01') return { rowCount: 0, rows: [] };
            throw err;
          });
          closeEffects.recurringDeactivated = recurring.rowCount || 0;
          closeTenantNotify = {
            id: contract.tenant_id,
            full_name: current.tenant_name,
            phone: current.tenant_phone,
            email: current.tenant_email,
            line_user_id: current.line_user_id,
            line_oa_id: current.line_oa_id,
            status: 'active',
          };
          // Free the room (drop tenant key + flip status).
          await client.query(
            `UPDATE app_data
                SET value = jsonb_set(
                              value,
                              ARRAY[$1::text],
                              ((value->$1) - 'tenant') || jsonb_build_object('status', 'vacant')
                            ),
                    updated_at=NOW()
              WHERE key='baankarn_rooms_v1' AND value ? $1`,
            [contract.room_id]
          );
          await client.query(
            `UPDATE rooms_v2 SET status='vacant', updated_at=NOW()
               WHERE room_code=$1 AND deleted_at IS NULL`,
            [contract.room_id]
          ).catch((err) => {
            if (err.code !== '42P01') throw err;
          });
          closeEffects.roomFreed = true;
        } else if (t && t.status === 'active' && !t.current_room_id) {
          // The tenant never moved in (invite-flow row, room binds only at
          // approve+lock). Closing their ONLY contract must not leave them
          // "active" with no room and no contract — the zombie the tenants
          // list then shows as a green ใช้งาน forever. Guard on other live
          // contracts so a multi-room tenant is never deactivated by
          // closing one of their contracts.
          const otherActive = await client.query(
            `SELECT id FROM contracts
               WHERE tenant_id=$1 AND status='active' AND deleted_at IS NULL AND id<>$2
               LIMIT 1`,
            [contract.tenant_id, contract.id]
          );
          if (!otherActive.rows.length) {
            await client.query(
              `UPDATE tenants SET status='moved_out', current_room_id=NULL, updated_at=NOW()
                 WHERE id=$1`,
              [contract.tenant_id]
            );
            const sessions = await client.query(
              `DELETE FROM tenant_sessions WHERE tenant_id=$1`, [contract.tenant_id]
            );
            closeEffects.tenantMovedOut = true;
            closeEffects.sessionsRevoked = sessions.rowCount || 0;
          } else {
            closeEffects.warnings.push({
              code: 'TENANT_HAS_OTHER_ACTIVE_CONTRACT',
              message: 'สัญญาถูกปิด แต่ผู้เช่ายังมีสัญญา active ฉบับอื่น จึงคงสถานะใช้งานไว้',
            });
          }
        } else if (t && t.status === 'active') {
          closeEffects.warnings.push({
            code: 'TENANT_ROOM_MISMATCH_ON_CLOSE',
            message: 'สัญญาถูกปิด แต่ผู้เช่า active อยู่คนละห้อง จึงไม่ย้ายผู้เช่าออกหรือเพิกถอนสิทธิอัตโนมัติ',
          });
        }
      }
      if (isClosingContract && contract.room_id && closeEffects && !closeEffects.roomFreed) {
        {
          const rQ = await client.query(
            `SELECT value FROM app_data WHERE key='baankarn_rooms_v1' FOR UPDATE`
          );
          const rooms = rQ.rows.length && rQ.rows[0].value && typeof rQ.rows[0].value === 'object'
            ? rQ.rows[0].value
            : {};
          const room = rooms[contract.room_id];
          if (room && room.status === 'reserved' && String(room.reservedBy || '') === `contract:${contract.id}`) {
            const { tenant, reservedBy, reservedAt, sourceBookingId, ...rest } = room;
            rooms[contract.room_id] = { ...rest, status: 'vacant' };
            await client.query(
              `INSERT INTO app_data (key, value, updated_by) VALUES ($1, $2, $3)
                 ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW(), updated_by=EXCLUDED.updated_by`,
              ['baankarn_rooms_v1', JSON.stringify(rooms), req.session.user.username]
            );
            await client.query(
              `UPDATE rooms_v2 SET status='vacant', updated_at=NOW()
                 WHERE room_code=$1 AND status='reserved' AND deleted_at IS NULL`,
              [contract.room_id]
            ).catch((err) => {
              if (err.code !== '42P01') throw err;
            });
            closeEffects.roomFreed = true;
          }
        }
      }
      await client.query('COMMIT');
      // Capture cancelReason (when admin terminates via the tenant page
      // "ยกเลิกสัญญา" button) in the audit metadata so we have a paper
      // trail of WHY the lease was ended without a dedicated column.
      const auditMeta = {
        fields: Object.keys(b),
        cascadedTenantMovedOut: !!(closeEffects && closeEffects.tenantMovedOut),
        closeEffects,
      };
      if (isClosingContract) {
        auditMeta.closeReason = closeReason;
        auditMeta.closeType = closeType;
      } else if (b.cancelReason && typeof b.cancelReason === 'string') {
        auditMeta.cancelReason = String(b.cancelReason).slice(0, 500);
      }
      audit(req, isClosingContract ? 'contract.cancel' : 'contract.update',
        'contract', String(id), auditMeta);
      if (isClosingContract) {
        try {
          const flags = await features.load(pool);
          const lines = [
            `สัญญาถูกปิด: ${contract.contract_no}`,
            `สถานะ: ${requestedStatus}`,
            `ประเภท: ${closeType}`,
            `เหตุผล: ${closeReason}`,
          ];
          if (contract.room_id) lines.push(`ห้อง: ${contract.room_id}`);
          if (current.tenant_name) lines.push(`ผู้เช่า: ${current.tenant_name}`);
          if (closeEffects) {
            lines.push(`ย้ายผู้เช่าออก: ${closeEffects.tenantMovedOut ? 'ใช่' : 'ไม่ใช่'}`);
            lines.push(`ปล่อยห้อง: ${closeEffects.roomFreed ? 'ใช่' : 'ไม่ใช่'}`);
            if (closeEffects.cardsRevoked) lines.push(`เพิกถอนบัตร: ${closeEffects.cardsRevoked} ใบ`);
            if (closeEffects.recurringDeactivated) lines.push(`ปิดค่าบริการรายเดือนอัตโนมัติ: ${closeEffects.recurringDeactivated} รายการ`);
            if (closeEffects.invitationsRevoked) lines.push(`ยกเลิกลิงก์สัญญาค้าง: ${closeEffects.invitationsRevoked} ลิงก์`);
            for (const w of closeEffects.warnings || []) lines.push(`คำเตือน: ${w.message}`);
          }
          notifier.notifyOwner({ pool, features: flags }, {
            category: 'tenancy',
            subject: `ปิดสัญญา ${contract.contract_no}`,
            text: lines.join('\n'),
          }).catch(() => {});
          if (closeTenantNotify) {
            notifier.notifyTenant({ pool, features: flags }, closeTenantNotify, {
              subject: `แจ้งปิดสัญญา ${contract.contract_no}`,
              text: [
                `เรียน คุณ${closeTenantNotify.full_name || ''}`,
                ``,
                `ระบบบันทึกการปิดสัญญา ${contract.contract_no} แล้ว`,
                contract.room_id ? `ห้อง: ${contract.room_id}` : null,
                `เหตุผล: ${closeReason}`,
                closeEffects && closeEffects.cardsRevoked ? `บัตรเข้า-ออกถูกเพิกถอน ${closeEffects.cardsRevoked} ใบ` : null,
                `หากยังมีบิลค้างชำระหรือเงินมัดจำ โปรดติดต่อสำนักงานเพื่อปิดยอด`,
              ].filter(Boolean).join('\n'),
              force: true,
            }).catch(() => {});
          }
        } catch (err) {
          console.warn('[contracts] close notification failed:', err.message);
        }
      }
      res.json({ ok: true, contract, effects: closeEffects });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('contract update error:', err);
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    } finally {
      client.release();
    }
  });

// POST /api/contracts/:id/sign
// body: { signatureDataUrl, agreedTermsVersion? }
//
// Records the contract signature image + signed_at + agreed_terms_at, then
// locks the contract with an immutable terms snapshot. The signature image
// is uploaded via storage.saveBase64 under category=contract_signature so it
// lives alongside other auth-gated files at /files/:id.
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
      `SELECT id, contract_no, status, signature_image_id, tenant_id,
              locked_at, template_id
         FROM contracts WHERE id=$1 AND deleted_at IS NULL`,
      [id]
    );
    if (!cQ.rows.length) return res.status(404).json({ error: 'contract not found' });
    const contract = cQ.rows[0];
    if (contract.locked_at) {
      return res.status(409).json({
        error: 'contract is locked; signature cannot be changed',
        code: 'CONTRACT_LOCKED',
      });
    }
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

    let termsSnapshot;
    try {
      termsSnapshot = await loadContractTermsSnapshot(pool, contract);
    } catch (err) {
      console.error('contract sign terms snapshot error:', err);
      return res.status(500).json({
        error: 'ไม่สามารถ snapshot เงื่อนไขสัญญาก่อนลงนามได้',
        code: 'TERMS_SNAPSHOT_FAILED',
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
                agreed_terms_version = COALESCE($3, agreed_terms_version),
                locked_at=NOW(),
                locked_by=$6,
                terms_template_snapshot=$7::jsonb,
                updated_at=NOW()
          WHERE id=$4 AND deleted_at IS NULL
            AND locked_at IS NULL
            AND (status='active' OR $5::boolean)
            AND (signature_image_id IS NULL OR $5::boolean)
          RETURNING id, contract_no, signed_at, agreed_terms_at, agreed_terms_version,
                    signature_image_id, locked_at, locked_by`,
        [
          savedFile.id,
          savedFile.url,
          termsVersion,
          id,
          force,
          req.session.user.username,
          JSON.stringify(termsSnapshot.snapshot),
        ]
      );
      if (!rows.length) {
        // Rolling back the upload preserves storage cleanliness.
        await storage.remove(pool, savedFile.id).catch(() => {});
        const fresh = await pool.query(
          `SELECT id, status, signature_image_id, locked_at
             FROM contracts WHERE id=$1 AND deleted_at IS NULL`,
          [id]
        );
        if (!fresh.rows.length) return res.status(404).json({ error: 'contract not found' });
        if (fresh.rows[0].locked_at) {
          return res.status(409).json({
            error: 'contract is locked; signature cannot be changed',
            code: 'CONTRACT_LOCKED',
          });
        }
        if (fresh.rows[0].status !== 'active' && !force) {
          return res.status(409).json({
            error: `สัญญาสถานะ ${fresh.rows[0].status} เซ็นไม่ได้ (เซ็นได้เฉพาะ active)`,
            code: 'CONTRACT_NOT_ACTIVE',
            currentStatus: fresh.rows[0].status,
          });
        }
        if (fresh.rows[0].signature_image_id && !force) {
          return res.status(409).json({
            error: 'สัญญาฉบับนี้ถูกลงนามไปแล้วโดยคำขออื่น — โหลดหน้าใหม่ก่อนทำต่อ',
            code: 'ALREADY_SIGNED',
            signatureFileId: fresh.rows[0].signature_image_id,
          });
        }
        return res.status(409).json({
          error: 'sign conflict — contract changed while saving signature',
          code: 'CONTRACT_SIGN_CONFLICT',
        });
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
        locked: true,
        templateId: termsSnapshot.templateId || null,
        snapshotVersion: termsSnapshot.snapshot?.snapshotVersion || null,
      });
      // Owner notify — same legal-trail rationale as identity capture: a
      // third party sees contract signature activity in real time.
      try {
        const flags = await features.load(pool);
        notifier.notifyOwner({ pool, features: flags }, {
          category: 'tenancy',
          subject: `✍️ ลงนามสัญญา ${contract.contract_no}`,
          text: `แอดมิน ${req.session.user.username} บันทึกลายเซ็นสัญญา ${contract.contract_no} แล้ว\n`
            + `สัญญามีผลและล็อกการแก้ไขแล้ว — เงื่อนไข ณ วันเซ็นถูกบันทึกถาวรเพื่อใช้อ้างอิง\n`
            + (termsVersion ? `เวอร์ชันเงื่อนไขที่ใช้: ${termsVersion}\n` : '')
            + (force ? '⚠️ เป็นการบันทึกทับลายเซ็นเดิม (ใช้สิทธิ์พิเศษ) — ตรวจสอบความถูกต้องอีกครั้ง' : ''),
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
// Default clauses (standard Thai dorm rules) live in services/contractPdf.js
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
        systemVariables: contractPdf.SYSTEM_VARIABLES,
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
        systemVariables: contractPdf.SYSTEM_VARIABLES,
        // Preview the final clause list the renderer will produce.
        resolved: contractPdf.resolveClauses(rows[0]),
      });
    } catch (err) {
      console.error('contract-templates GET error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

// Shared save-time guards for template POST/PUT. Returns a response body
// (to send as 400) or null when the payload is safe.
function _templateGuardError(p) {
  // Typo'd {{variables}} render as "—" in a LEGAL document — reject with
  // the exact list so the admin fixes the spelling (or defines the custom
  // variable) before anything can print.
  const contractPdf = require('./services/contractPdf');
  const unknown = contractPdf.findUnknownVariables(p);
  if (unknown.length) {
    return {
      error: `พบตัวแปรที่ระบบไม่รู้จัก ${unknown.length} ตัว: ${unknown.map((k) => `{{${k}}}`).join(', ')}`,
      code: 'TEMPLATE_UNKNOWN_VARIABLES',
      unknownVariables: unknown,
      hint: 'ตรวจการสะกดให้ตรงกับรายการตัวแปรระบบ หรือถ้าตั้งใจใช้ตัวแปรใหม่ ให้เพิ่มในแท็บ "ตัวแปร" ก่อนบันทึก — ไม่อย่างนั้นตำแหน่งนั้นจะพิมพ์เป็น "—" ในสัญญาจริง',
    };
  }
  // The default template is what every contract falls back to — a disabled
  // default means "no default" to the warning system but the old lookup
  // still printed it. Forbid the contradictory state outright.
  if (p.isDefault && !p.enabled) {
    return {
      error: 'เทมเพลต default ต้องเปิดใช้งานเสมอ — ถ้าต้องการปิดตัวนี้ ให้ตั้งเทมเพลตอื่นเป็น default ก่อน',
      code: 'DEFAULT_MUST_BE_ENABLED',
    };
  }
  return null;
}

// POST /api/admin/contract-templates — create a new template (owner only).
app.post('/api/admin/contract-templates', sameOrigin, csrfGuard, requireAuth, requireRole('owner'),
  async (req, res) => {
    let p;
    try { p = _validateTemplatePayload(req.body); }
    catch (err) { return res.status(400).json({ error: err.message, code: err.code }); }
    const guardErr = _templateGuardError(p);
    if (guardErr) return res.status(400).json(guardErr);
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
    const guardErr = _templateGuardError(p);
    if (guardErr) return res.status(400).json(guardErr);
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
      //
      // Also blank `terms_template_snapshot` on DRAFT contracts
      // (locked_at IS NULL) that were prepped from this template.
      // Without this, the snapshot stayed cached from the soon-to-be-
      // deleted template — and the next print rendered the deleted
      // text, not the new default. Locked contracts keep their
      // snapshot (audit / legal trail).
      await pool.query(
        `UPDATE contract_templates SET deleted_at=NOW(), enabled=FALSE WHERE id=$1`,
        [id]
      );
      await pool.query(
        `UPDATE contracts
            SET template_id=NULL,
                terms_template_snapshot=NULL
          WHERE template_id=$1 AND locked_at IS NULL`,
        [id]
      ).catch((err) => {
        if (err.code !== '42703') throw err;
      });
      await pool.query(
        `UPDATE contracts SET template_id=NULL
          WHERE template_id=$1 AND locked_at IS NOT NULL`,
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
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const c = await client.query(
        `SELECT id, locked_at FROM contracts
          WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [id]
      );
      if (!c.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'contract not found' });
      }
      if (c.rows[0].locked_at) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'contract is locked; template cannot be changed',
          code: 'CONTRACT_LOCKED',
        });
      }
      // Verify the template exists AND is enabled. Without the
      // `enabled` check, admin disabled a retired template via the
      // set-default endpoint (which DOES enforce TEMPLATE_DISABLED),
      // but could still assign it directly to a contract via this
      // route. Result: the next PDF render snapshotted the retired
      // version, often diverging from what admin intended.
      if (templateId != null) {
        const t = await client.query(
          `SELECT id, enabled FROM contract_templates WHERE id=$1 AND deleted_at IS NULL`,
          [templateId]
        );
        if (!t.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'template not found' });
        }
        if (!t.rows[0].enabled) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'template ถูก disable อยู่ — เปิดใช้งานก่อนกำหนดให้สัญญา',
            code: 'TEMPLATE_DISABLED',
          });
        }
      }
      const { rows } = await client.query(
        `UPDATE contracts SET template_id=$1, updated_at=NOW()
          WHERE id=$2 AND deleted_at IS NULL
          RETURNING id, contract_no, template_id`,
        [templateId, id]
      );
      await client.query('COMMIT');
      audit(req, 'contract.template_assign', 'contract', String(id), { templateId });
      res.json({ ok: true, contract: rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // Pre-migration: contracts.template_id might not exist yet.
      if (err.code === '42703') {
        return res.status(503).json({
          error: 'feature pending migration — please redeploy',
          code: 'PENDING_MIGRATION',
        });
      }
      console.error('contract template assign error:', err);
      res.status(500).json({ error: 'internal error' });
    } finally {
      client.release();
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

function quickInviteDuplicateConflictBody(err, context = {}) {
  const constraint = String((err && (err.constraint || err.detail)) || '');
  const roomId = String(context.roomId || '').trim();
  const contractsUrl = roomId
    ? `/admin#contracts?room=${encodeURIComponent(roomId)}`
    : '/admin#contracts';
  const roomUrl = roomId
    ? `/admin#rooms?room=${encodeURIComponent(roomId)}`
    : '/admin#rooms';

  if (/uq_contracts_active_room/.test(constraint)) {
    return {
      error: roomId
        ? `สร้างสัญญาใหม่ไม่ได้: ห้อง ${roomId} มีสัญญา active อยู่แล้ว`
        : 'สร้างสัญญาใหม่ไม่ได้: ห้องนี้มีสัญญา active อยู่แล้ว',
      code: 'ROOM_CONTRACT_EXISTS',
      hint: 'รีเฟรชข้อมูล แล้วเปิดสัญญาเดิมของห้องนี้ หรือปิด/ยกเลิกสัญญาเดิมก่อนสร้างฉบับใหม่ เพื่อป้องกันห้องเดียวมีหลายสัญญา',
      nextActions: {
        contractsUrl,
        roomUrl,
        hint: 'เปิดหน้าสัญญาหรือหน้าห้องพักเพื่อตรวจรายการเดิมก่อนทำซ้ำ',
      },
    };
  }

  if (/uq_contract_invitations_active_per_contract/.test(constraint)) {
    return {
      error: 'สัญญานี้มีลิงก์ให้ผู้เช่ากรอกที่ยังใช้งานอยู่แล้ว',
      code: 'DRAFT_CONTRACT_EXISTS',
      hint: 'เปิดสัญญาเดิมแล้วกดส่งลิงก์ใหม่ หรือยกเลิกลิงก์เดิมก่อนสร้างใหม่',
      nextActions: {
        contractsUrl,
        hint: 'ใช้สัญญาเดิมเป็นต้นทาง เพื่อไม่ให้มีลิงก์หลายชุดสำหรับสัญญาเดียวกัน',
      },
    };
  }

  return {
    error: 'สร้างสัญญาไม่สำเร็จ เพราะมีข้อมูลสัญญาหรือผู้เช่าซ้ำกับรายการที่มีอยู่แล้ว',
    code: 'DUPLICATE_QUICK_INVITE',
    hint: 'รีเฟรชข้อมูล แล้วตรวจห้อง ผู้เช่า และสัญญาเดิมก่อนสร้างซ้ำ หากเป็นการกดพร้อมกัน ให้ใช้รายการที่สร้างสำเร็จล่าสุด',
    nextActions: {
      contractsUrl,
      roomUrl,
      hint: 'ตรวจรายการเดิมก่อนเริ่มสร้างสัญญาใหม่',
    },
  };
}

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
    const depositRaw = Number(b.deposit);
    const deposit = Number.isFinite(depositRaw) ? depositRaw : 0;
    const moveInDate = String(b.moveInDate || '').slice(0, 16).trim();
    if (!tenantName) return res.status(400).json({ error: 'tenantName required', code: 'NAME_REQUIRED' });
    if (!tenantPhone || !/^[\d+]{8,20}$/.test(tenantPhone)) {
      return res.status(400).json({ error: 'เบอร์โทรไม่ถูกต้อง', code: 'INVALID_PHONE' });
    }
    if (!roomId) return res.status(400).json({ error: 'roomId required', code: 'ROOM_REQUIRED' });
    if (!Number.isFinite(monthlyRent) || monthlyRent <= 0) {
      return res.status(400).json({ error: 'monthlyRent ต้อง > 0', code: 'INVALID_RENT' });
    }
    if (!Number.isFinite(deposit) || deposit < 0) {
      return res.status(400).json({ error: 'deposit ต้องไม่ติดลบ', code: 'INVALID_DEPOSIT' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(moveInDate)) {
      return res.status(400).json({ error: 'moveInDate ต้องเป็น YYYY-MM-DD', code: 'INVALID_DATE' });
    }
    // Optional
    const tenantEmail = b.tenantEmail ? String(b.tenantEmail).slice(0, 200).trim() : null;
    const termMonths = b.termMonths != null ? Number(b.termMonths) : null;
    const requestedEndDate = b.endDate ? String(b.endDate).slice(0, 16).trim() : null;
    const discountPct = b.discountPct != null ? Number(b.discountPct) : 0;
    const expiresInHours = Number(b.expiresInHours) || 168;
    const bookingIdForRoom = b.bookingId ? String(b.bookingId).slice(0, 64) : null;
    // Renewal mode: the new contract continues an existing locked contract on
    // the SAME room + tenant. Identifying the predecessor lets the same-tenant
    // duplicate-contract guard below allow exactly this case (new start must
    // be after the old end_date, so the two never overlap a billing day).
    const renewOfContractId = b.renewOfContractId != null && Number.isInteger(Number(b.renewOfContractId))
      ? Number(b.renewOfContractId)
      : null;
    if (termMonths != null && (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 60)) {
      return res.status(400).json({ error: 'termMonths must be 1-60', code: 'INVALID_TERM' });
    }
    if (requestedEndDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedEndDate)) {
      return res.status(400).json({ error: 'endDate ต้องเป็น YYYY-MM-DD', code: 'INVALID_END_DATE' });
    }
    if (requestedEndDate && requestedEndDate < moveInDate) {
      return res.status(400).json({
        error: 'วันสิ้นสุดสัญญาต้องไม่ก่อนวันเริ่มเช่า',
        code: 'INVALID_END_DATE',
        moveInDate,
        endDate: requestedEndDate,
      });
    }
    const maxEndDate = addContractMonths(moveInDate, 60);
    if (requestedEndDate && maxEndDate && requestedEndDate > maxEndDate) {
      return res.status(400).json({
        error: 'วันสิ้นสุดสัญญาเกิน 60 เดือนจากวันเริ่มเช่า',
        code: 'END_DATE_TOO_FAR',
        moveInDate,
        endDate: requestedEndDate,
        maxEndDate,
      });
    }
    const effectiveTermMonths = termMonths
      || (requestedEndDate ? estimateContractMonths(moveInDate, requestedEndDate, 60) : null);
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
      const today = new Date(billing.localTodayYmd() + 'T00:00:00Z');
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

    // Compute end_date from either explicit endDate or termMonths. The
    // helper clamps end-of-month dates (Jan 31 + 1mo => Feb 28/29), matching
    // the checkin flow so both contract entry points store identical dates.
    let endDate = requestedEndDate;
    if (!endDate && effectiveTermMonths) {
      endDate = addContractMonths(moveInDate, Number(effectiveTermMonths));
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Serialize contract drafts for the same applicant phone. The
      // duplicate-draft SELECT below is a read-before-insert guard; without
      // this xact lock, two admins could start quick-invite for the same
      // phone in different rooms, both see no draft, then both insert.
      await client.query(
        'SELECT pg_advisory_xact_lock($1::int, $2::int)',
        [0x51494e56, advisoryInt32Key(tenantPhone)] // "QINV": quick invite applicant
      );

      // 1. Find existing tenant by phone — most-recent active match wins.
      // Active tenants ranked first so we re-use rather than creating
      // another row for the same person across multiple contracts.
      let tenantId = null;
      let tenantForInviteNotify = null;
      let sameTenantPreclaimedRoom = false;
      const tQ = await client.query(
        `SELECT id, full_name, phone, email, line_user_id, line_oa_id,
                status, current_room_id
           FROM tenants
           WHERE phone=$1 AND deleted_at IS NULL
           ORDER BY (status='active') DESC, updated_at DESC LIMIT 1
           FOR UPDATE`,
        [tenantPhone]
      );
      if (tQ.rows.length) {
        tenantId = tQ.rows[0].id;
        tenantForInviteNotify = {
          id: tenantId,
          full_name: tQ.rows[0].full_name || tenantName,
          phone: tQ.rows[0].phone || tenantPhone,
          email: tenantEmail || tQ.rows[0].email || null,
          line_user_id: tQ.rows[0].line_user_id || null,
          line_oa_id: tQ.rows[0].line_oa_id || null,
          status: 'active',
        };
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
        if (tQ.rows[0].status === 'active'
            && tQ.rows[0].current_room_id
            && tQ.rows[0].current_room_id !== roomId
            && !isForced) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `ผู้เช่ารายนี้ยัง active อยู่ห้อง ${tQ.rows[0].current_room_id} — ต้อง check-out หรือ force ก่อนสร้างสัญญาใหม่`,
            code: 'TENANT_ALREADY_ACTIVE',
            currentRoom: tQ.rows[0].current_room_id,
            requestedRoom: roomId,
            hint: 'ปิดสัญญา/checkout ห้องเดิมก่อน หรือส่ง { force: true } สำหรับงาน migrate เท่านั้น',
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
        sameTenantPreclaimedRoom = tQ.rows[0].status === 'active'
          && tQ.rows[0].current_room_id === roomId;
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
        tenantForInviteNotify = {
          id: tenantId,
          full_name: tenantName,
          phone: tenantPhone,
          email: tenantEmail || null,
          status: 'active',
        };
      }

      // Room-level guard for draft contracts. Quick-invite happens before
      // final checkin/approval, but it still claims a room. Lock the room
      // state here so two admins cannot create competing unsigned contracts
      // or place a draft on top of an occupied/reserved room.
      const occupant = await client.query(
        `SELECT id, full_name FROM tenants
           WHERE current_room_id=$1 AND status='active' AND deleted_at IS NULL
             AND id <> $2
           LIMIT 1
           FOR UPDATE`,
        [roomId, tenantId]
      );
      if (occupant.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'room is already occupied by another active tenant',
          code: 'ROOM_OCCUPIED',
          conflict: occupant.rows[0],
          hint: 'ต้อง check-out ผู้เช่าปัจจุบัน หรือเลือกห้องอื่นก่อนสร้างสัญญาใหม่',
        });
      }

      const roomContract = await client.query(
        `SELECT c.id, c.contract_no, c.tenant_id, c.locked_at,
                t.full_name AS tenant_name, t.status AS tenant_status
           FROM contracts c
           LEFT JOIN tenants t ON t.id = c.tenant_id
          WHERE c.room_id=$1 AND c.status='active'
            AND c.deleted_at IS NULL AND c.tenant_id <> $2
          LIMIT 1 FOR UPDATE OF c`,
        [roomId, tenantId]
      );
      if (roomContract.rows.length) {
        const conflict = roomContract.rows[0];
        await client.query('ROLLBACK');
        // Distinguish "real" contract conflict (legitimate active tenant)
        // from a "stranded" one (contract still active but tenant already
        // moved_out — the bug surface that motivated the audit/reconcile
        // endpoints). Stranded conflicts get a different error code +
        // explicit reconcileUrl so the admin UI can offer one-click fix
        // instead of a generic "ROOM_CONTRACT_EXISTS" dead-end.
        if (conflict.tenant_status === 'moved_out') {
          return res.status(409).json({
            error: `ห้องนี้มีสัญญา active ค้างของอดีตผู้เช่า ${conflict.tenant_name || '-'} ` +
                   `(สถานะ moved_out แล้ว แต่สัญญายังไม่ปิด) — รัน Reconcile ก่อนสร้างสัญญาใหม่`,
            code: 'ROOM_STRANDED_CONTRACT',
            conflict,
            reconcileUrl: `/api/admin/rooms/${encodeURIComponent(roomId)}/reconcile`,
            auditUrl: `/api/admin/rooms/${encodeURIComponent(roomId)}/audit`,
            hint: 'เปิดหน้า /admin#rooms ห้องนี้ → กดปุ่ม "Reconcile ห้อง" ใน drawer แล้วลองใหม่',
          });
        }
        return res.status(409).json({
          error: `สร้างสัญญาใหม่ไม่ได้: ห้อง ${roomId} มีสัญญาหรือร่างสัญญาอยู่แล้ว` +
                 `${conflict.tenant_name ? ` ของ ${conflict.tenant_name}` : ''}` +
                 `${conflict.contract_no ? ` (${conflict.contract_no})` : ''}`,
          code: 'ROOM_CONTRACT_EXISTS',
          conflict,
          hint: 'ให้ใช้สัญญาเดิมที่มีอยู่ หรือปิด/ยกเลิกสัญญาเดิมก่อนสร้างสัญญาใหม่ เพื่อป้องกันห้องเดียวมีหลายสัญญา',
          nextActions: {
            contractsUrl: `/admin#contracts?room=${encodeURIComponent(roomId)}&contract=${encodeURIComponent(conflict.id)}`,
            roomUrl: `/admin#rooms?room=${encodeURIComponent(roomId)}`,
            pdfUrl: `/api/contracts/${encodeURIComponent(conflict.id)}/pdf`,
            hint: 'เปิดสัญญาเดิมที่ชนกันได้ทันทีจากปุ่มในหน้าแอดมิน',
          },
        });
      }

      const sameTenantRoomContract = await client.query(
        `SELECT c.id, c.contract_no, c.locked_at, c.end_date
           FROM contracts c
          WHERE c.room_id=$1 AND c.tenant_id=$2
            AND c.status='active' AND c.deleted_at IS NULL
          ORDER BY c.created_at DESC
          LIMIT 1
          FOR UPDATE OF c`,
        [roomId, tenantId]
      );
      if (sameTenantRoomContract.rows.length) {
        const conflict = sameTenantRoomContract.rows[0];
        const conflictEnd = conflict.end_date ? String(conflict.end_date).slice(0, 10) : null;
        // Renewal path: caller explicitly names THIS contract as the one
        // being renewed. Allowed only when the new start date is strictly
        // after the old end date — the old contract keeps running to its
        // end_date (auto-expired by the scheduler), the renewal takes over
        // from the next day, and no billing day is covered twice. tickBillGen
        // ignores contracts that start after the billed period, so the
        // queued renewal can't hijack rent/due-day before it begins.
        const isRenewalOfConflict = renewOfContractId != null
          && Number(conflict.id) === renewOfContractId;
        if (isRenewalOfConflict && (!conflictEnd || moveInDate <= conflictEnd)) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: conflictEnd
              ? `วันเริ่มสัญญาใหม่ (${moveInDate}) ต้องอยู่หลังวันสิ้นสุดสัญญาเดิม (${conflictEnd})`
              : `สัญญาเดิม ${conflict.contract_no} ไม่มีวันสิ้นสุด (เปิด-ไม่จำกัด) — ปิดสัญญาเดิมก่อนจึงต่อสัญญาได้`,
            code: 'RENEWAL_START_OVERLAPS',
            conflict,
            hint: conflictEnd
              ? `เลือกวันเริ่มตั้งแต่วันถัดจาก ${conflictEnd} เป็นต้นไป`
              : 'กำหนดวันสิ้นสุดให้สัญญาเดิม หรือปิดสัญญาเดิม แล้วลองใหม่',
          });
        }
        if (!isRenewalOfConflict && (conflict.locked_at || !isForced)) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: conflict.locked_at
              ? 'ผู้เช่ารายนี้มีสัญญา active ของห้องนี้อยู่แล้ว'
              : `ผู้เช่ารายนี้มีสัญญารอลงนามอยู่แล้ว (${conflict.contract_no})`,
            code: conflict.locked_at ? 'TENANT_ROOM_CONTRACT_EXISTS' : 'DRAFT_CONTRACT_EXISTS',
            conflict,
            hint: conflict.locked_at
              ? 'ใช้สัญญาเดิม หรือปิดสัญญาเดิมก่อนสร้างฉบับใหม่ — ถ้าต้องการต่อสัญญา ใช้ปุ่ม "ต่อสัญญา" ที่หน้า /admin#contracts'
              : 'ส่งลิงก์ใหม่จากสัญญาเดิมที่ /admin#contracts หรือส่ง { force: true } เพื่อสร้างใหม่ (audit-logged)',
            nextActions: {
              contractsUrl: `/admin#contracts?room=${encodeURIComponent(roomId)}&contract=${encodeURIComponent(conflict.id)}`,
              pdfUrl: `/api/contracts/${encodeURIComponent(conflict.id)}/pdf`,
              hint: 'ใช้รายการสัญญาเดิมนี้ต่อ ไม่ต้องสร้างซ้ำ',
            },
          });
        }
      }

      let bookingCarryoverList = null;
      let bookingCarryoverIdx = -1;
      let bookingForInvite = null;
      let bookingFeeForDepositCredit = 0;
      let bookingFeeAppliesToDeposit = false;
      let bookingFeeCredit = 0;
      let contractDepositBalanceDue = Math.max(deposit, 0);
      if (bookingIdForRoom) {
        const bookingBlobQ = await client.query(
          `SELECT value FROM app_data WHERE key='baankarn_bookings_v1' FOR UPDATE`
        );
        bookingCarryoverList = bookingBlobQ.rows.length && Array.isArray(bookingBlobQ.rows[0].value)
          ? bookingBlobQ.rows[0].value
          : [];
        bookingCarryoverIdx = bookingCarryoverList.findIndex((x) => x && x.id === bookingIdForRoom);
        if (bookingCarryoverIdx < 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({
            error: `ไม่พบ booking ${bookingIdForRoom} สำหรับสร้างสัญญา`,
            code: 'BOOKING_NOT_FOUND',
            hint: 'กลับไปหน้า booking แล้วเริ่มจากปุ่มอนุมัติ/สร้างสัญญาใหม่',
          });
        }
        bookingForInvite = bookingCarryoverList[bookingCarryoverIdx] || {};
        if (bookingForInvite.status !== 'approved') {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `booking ${bookingIdForRoom} ยังไม่พร้อมสร้างสัญญา (สถานะ: ${bookingForInvite.status || 'pending'})`,
            code: 'BOOKING_NOT_APPROVED',
            currentStatus: bookingForInvite.status || 'pending',
            hint: 'ต้องอนุมัติ booking ให้ระบบจองห้องก่อน แล้วค่อยสร้าง/ส่งลิงก์สัญญา',
          });
        }
        const bookedRoomId = String(bookingForInvite.assignedRoomId || bookingForInvite.roomId || '').trim();
        if (!bookedRoomId || bookedRoomId !== roomId) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `booking ${bookingIdForRoom} ไม่ได้จองห้อง ${roomId}`,
            code: 'BOOKING_ROOM_MISMATCH',
            bookingRoomId: bookedRoomId || null,
            requestedRoomId: roomId,
            hint: 'เปิดจาก booking ที่อนุมัติแล้ว หรือเลือกห้องที่ booking นั้นจองไว้',
          });
        }
        const bookingPhone = String(bookingForInvite.phone || '').replace(/[\s-]/g, '');
        if (bookingPhone && tenantPhone && bookingPhone !== tenantPhone) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `booking ${bookingIdForRoom} เป็นของเบอร์ ${bookingPhone} แต่กำลังสร้างสัญญาให้เบอร์ ${tenantPhone}`,
            code: 'BOOKING_TENANT_MISMATCH',
            bookingPhone,
            requestedPhone: tenantPhone,
            bookingName: bookingForInvite.name || null,
            requestedName: tenantName,
            hint: 'กลับไปเปิดจาก booking/ผู้เช่าคนเดียวกัน หรือสร้างสัญญาแบบไม่อ้าง booking ถ้าเป็นงานแก้ข้อมูลย้อนหลัง',
          });
        }
        bookingFeeForDepositCredit = Math.max(0, Number(bookingForInvite.bookingFee) || 0);
        bookingFeeAppliesToDeposit = bookingForInvite.bookingFeeAppliesToDeposit === true;
      }

      const roomBlobQ = await client.query(
        `SELECT value FROM app_data WHERE key='baankarn_rooms_v1' FOR UPDATE`
      );
      const roomsForInvite = roomBlobQ.rows.length && roomBlobQ.rows[0].value
        && typeof roomBlobQ.rows[0].value === 'object'
        ? roomBlobQ.rows[0].value
        : {};
      const blobRoom = roomsForInvite[roomId];
      let roomV2 = null;
      try {
        const roomV2Q = await client.query(
          `SELECT room_code, room_type, floor, room_no, rent_price, deposit_price, wifi_fee, status,
                  view_type, has_balcony, has_parking, has_kitchen, has_ac,
                  rent_override, rent_override_reason
             FROM rooms_v2
             WHERE room_code=$1 AND deleted_at IS NULL
             FOR UPDATE`,
          [roomId]
        );
        roomV2 = roomV2Q.rows[0] || null;
      } catch (err) {
        if (err.code !== '42P01') throw err;
      }
      if (!blobRoom && !roomV2 && !isForced) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          error: `ไม่พบห้อง ${roomId} ในระบบ — ตรวจเลขห้องก่อนสร้างสัญญา`,
          code: 'ROOM_NOT_FOUND',
          requestedRoom: roomId,
        });
      }
      const roomStatuses = [blobRoom?.status, roomV2?.status].filter(Boolean);
      const roomState = roomStatuses.includes('occupied') ? 'occupied'
        : roomStatuses.includes('maintenance') ? 'maintenance'
        : roomStatuses.includes('reserved') ? 'reserved'
        : 'vacant';
      if (roomState === 'occupied' && !sameTenantPreclaimedRoom) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `room is not available (${roomState})`,
          code: 'ROOM_OCCUPIED',
          currentStatus: roomState,
          hint: 'ห้องนี้มีผู้เช่าอยู่แล้ว ต้อง check-out/ปิดสัญญาเดิมก่อน หรือเลือกห้องอื่น',
        });
      }
      if (roomState === 'maintenance') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `room is not available (${roomState})`,
          code: 'ROOM_UNAVAILABLE',
          currentStatus: roomState,
          hint: 'ห้องอยู่ระหว่างซ่อม/งดใช้งาน เปิดใช้งานห้องหรือเลือกห้องอื่นก่อนสร้างสัญญา',
        });
      }
      const currentReservationOwner = blobRoom?.reservedBy ? String(blobRoom.reservedBy) : null;
      const reservationOwnerOk = currentReservationOwner && currentReservationOwner === bookingIdForRoom;
      if (bookingIdForRoom && !reservationOwnerOk) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `ห้อง ${roomId} ไม่ได้ถูกจองโดย booking ${bookingIdForRoom}`,
          code: 'BOOKING_ROOM_NOT_RESERVED',
          currentStatus: roomState,
          reservedBy: currentReservationOwner,
          hint: 'อนุมัติ booking ใหม่ให้ระบบจองห้องก่อน หรือ reconcile ห้องถ้าข้อมูลเก่าค้าง',
        });
      }
      if (roomState === 'reserved' && !reservationOwnerOk) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'room is already reserved by another booking or contract',
          code: 'ROOM_RESERVED',
          currentStatus: roomState,
          reservedBy: currentReservationOwner,
          hint: 'เปิดจาก booking/สัญญาที่จองห้องนี้ไว้ หรือยกเลิก reservation เดิมก่อน',
        });
      }

      let pricingConfig = {};
      try {
        const cfgQ = await client.query(
          `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
        );
        pricingConfig = cfgQ.rows[0]?.value || {};
      } catch { /* keep default pricing reference */ }
      const resolvedQuickInviteRent = pricing.resolveBillingRent({
        room: blobRoom || roomV2,
        config: pricingConfig,
      });
      const resolvedQuickInviteRentValue = Number(resolvedQuickInviteRent.rent);
      const contractMonthlyRent = Number.isFinite(resolvedQuickInviteRentValue) && resolvedQuickInviteRentValue > 0
        ? resolvedQuickInviteRentValue
        : monthlyRent;
      const resolvedQuickInviteDeposit = pricing.resolveContractDeposit({
        room: blobRoom || roomV2,
        config: pricingConfig,
        rent: contractMonthlyRent,
      });
      const resolvedQuickInviteDepositValue = Number(resolvedQuickInviteDeposit.deposit);
      const contractDeposit = Number.isFinite(resolvedQuickInviteDepositValue) && resolvedQuickInviteDepositValue >= 0
        ? resolvedQuickInviteDepositValue
        : deposit;
      bookingFeeCredit = bookingFeeAppliesToDeposit
        ? Math.min(bookingFeeForDepositCredit, Math.max(contractDeposit, 0))
        : 0;
      contractDepositBalanceDue = Math.max(Math.max(contractDeposit, 0) - bookingFeeCredit, 0);
      const rentAssessment = pricing.assessContractRent({
        monthlyRent: contractMonthlyRent,
        room: blobRoom || roomV2,
        config: pricingConfig,
      });
      if (!isForced && !rentAssessment.ok) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: rentAssessment.referenceRent > 0
            ? `ค่าเช่า ${contractMonthlyRent} ต่ำผิดปกติสำหรับห้อง ${roomId} (ราคาอ้างอิง ${rentAssessment.referenceRent}, ขั้นต่ำที่ยอมรับ ${rentAssessment.minimumRent})`
            : `ค่าเช่า ${contractMonthlyRent} ต่ำผิดปกติ (ขั้นต่ำที่ยอมรับ ${rentAssessment.minimumRent})`,
          code: rentAssessment.code || 'CONTRACT_RENT_TOO_LOW',
          field: rentAssessment.field,
          monthlyRent: rentAssessment.rent,
          minimumRent: rentAssessment.minimumRent,
          referenceRent: rentAssessment.referenceRent,
          referenceSource: rentAssessment.referenceSource,
          hint: 'ตรวจว่าพิมพ์ตกศูนย์หรือไม่ ถ้าเป็นงาน migrate ข้อมูลเก่าจริง ๆ ให้ส่ง { force: true } และระบบจะ audit-log',
        });
      }

      // 2. Create the contract row. We skip the heavy checkin guards
      // (identity images, address, emergency contact) — the tenant fills
      // those via the invitation. Status='active' so the contracts page
      // shows it; locked_at stays NULL until admin approves the
      // tenant's submission.
      //
      // Duplicate-draft guard: refuse if this tenant already has an
      // unsigned (locked_at IS NULL) active contract that hasn't been
      // approved. Without this, two parallel quick-invites for the
      // same tenant produce two ghost contracts — the second one stays
      // forever as orphan state once the first is approved. Admin can
      // bypass via { force: true } to deliberately create a second
      // draft (e.g. tenant moving rooms with overlapping contracts).
      if (!isForced) {
        const dupContract = await client.query(
          `SELECT id, contract_no, room_id FROM contracts
             WHERE tenant_id=$1 AND status='active' AND locked_at IS NULL
               AND deleted_at IS NULL
             ORDER BY created_at DESC LIMIT 1`,
          [tenantId]
        );
        if (dupContract.rows.length) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `ผู้เช่ารายนี้มีสัญญารอลงนามอยู่แล้ว (${dupContract.rows[0].contract_no}, ห้อง ${dupContract.rows[0].room_id})`,
            code: 'DRAFT_CONTRACT_EXISTS',
            conflict: dupContract.rows[0],
            hint: 'ส่งลิงก์ใหม่จากสัญญาเดิมที่ /admin#contracts หรือส่ง { force: true } เพื่อสร้างใหม่ (audit-logged)',
          });
        }
      }

      const contractNo = `C-${new Date().getFullYear()}-${String(tenantId).padStart(4, '0')}-`
                       + require('crypto').randomBytes(3).toString('hex').toUpperCase();
      const cIns = await client.query(
        `INSERT INTO contracts (contract_no, tenant_id, room_id, start_date, end_date,
                                monthly_rent, deposit, status, term_months, discount_pct,
                                booking_fee_credit, deposit_balance_due)
         VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, 'active', $8, $9, $10, $11)
         RETURNING id, contract_no, tenant_id, room_id, start_date, end_date,
                   monthly_rent, deposit, status, booking_fee_credit, deposit_balance_due`,
        [contractNo, tenantId, roomId, moveInDate, endDate,
         contractMonthlyRent, contractDeposit, effectiveTermMonths || null, discountPct,
         bookingFeeCredit, contractDepositBalanceDue]
      );
      const contract = cIns.rows[0];

      // Renewal of a SITTING tenant (active + occupying this room under a
      // locked contract): they live there RIGHT NOW. Stripping their
      // current_room_id / demoting the room to 'reserved' would disarm every
      // later cleanup cascade and silently stop auto-billing under the
      // still-active old contract.
      let sittingRenewal = false;
      try {
        const sitQ = await client.query(
          `SELECT 1 FROM tenants t
             JOIN contracts c ON c.tenant_id = t.id
            WHERE t.id=$1 AND t.current_room_id=$2 AND t.status='active' AND t.deleted_at IS NULL
              AND c.room_id=$2 AND c.status='active' AND c.locked_at IS NOT NULL AND c.deleted_at IS NULL
            LIMIT 1`,
          [tenantId, roomId]
        );
        sittingRenewal = sitQ.rows.length > 0;
      } catch (err) {
        if (err.code !== '42P01') throw err;
      }
      if (sameTenantPreclaimedRoom && !sittingRenewal) {
        // Convert a tenant-modal preclaim into the normal invitation state:
        // the tenant profile exists, the room is reserved by contract:N, and
        // current_room_id is written only after admin approves the submission.
        await client.query(
          `UPDATE tenants
              SET current_room_id=NULL, updated_at=NOW()
            WHERE id=$1 AND current_room_id=$2`,
          [tenantId, roomId]
        );
      }

      const draftReservation = {
        ...(blobRoom || {}),
        id: blobRoom?.id || roomId,
        type: blobRoom?.type || roomV2?.room_type || undefined,
        floor: blobRoom?.floor ?? roomV2?.floor,
        no: blobRoom?.no || roomV2?.room_no || undefined,
        rent: contractMonthlyRent,
        deposit: contractDeposit,
        wifi: blobRoom?.wifi ?? (roomV2 ? Number(roomV2.wifi_fee || 0) : 0),
        // Sitting renewal keeps the room 'occupied' — billing for the live
        // tenancy must not pause while the renewal link is out for signing.
        status: sittingRenewal ? (blobRoom?.status || 'occupied') : 'reserved',
        tenant: {
          name: tenantName,
          phone: tenantPhone,
          email: tenantEmail || '',
          occupation: '',
          score: 'A',
          since: moveInDate,
        },
        reservedBy: `contract:${contract.id}`,
        reservedAt: new Date().toISOString(),
      };
      if (bookingIdForRoom) draftReservation.sourceBookingId = bookingIdForRoom;
      roomsForInvite[roomId] = draftReservation;
      await client.query(
        `INSERT INTO app_data (key, value, updated_by) VALUES ($1, $2, $3)
           ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW(), updated_by=EXCLUDED.updated_by`,
        ['baankarn_rooms_v1', JSON.stringify(roomsForInvite), req.session.user.username]
      );
      try {
        if (!sittingRenewal) {
          const reservableStatuses = sameTenantPreclaimedRoom
            ? ['vacant', 'occupied']
            : ['vacant'];
          await client.query(
            `UPDATE rooms_v2 SET status='reserved', updated_at=NOW()
               WHERE room_code=$1 AND status = ANY($2::text[]) AND deleted_at IS NULL`,
            [roomId, reservableStatuses]
          );
        }
      } catch (err) {
        if (err.code !== '42P01') throw err;
      }

      // 2b. Optional booking carry-over. When admin sends an invite from
      // an already-approved booking, the public form may have collected
      // a citizen-ID front photo. Re-target that file_uploads row onto
      // the new tenant so they don't have to re-upload via the link.
      // Also link the booking row to the freshly-created tenant +
      // contract for audit traceability.
      if (bookingIdForRoom) {
        try {
          const bookingId = bookingIdForRoom;
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
          //
          // Status guard: only advance an actually-eligible booking.
          // Previously this UPDATE had no WHERE-status clause and
          // happily resurrected `rejected`/`cancelled` bookings as
          // `completed` — bypassing BOOKING_TRANSITIONS which forbids
          // those edges. The blob path below mirrors the same guard.
          const allowedFromForQuickInvite = ['approved'];
          try {
            await client.query(
              `UPDATE bookings
                  SET status='completed',
                      deposit_credit_amount=$3,
                      deposit_balance_due=$4,
                      updated_at=NOW()
                WHERE external_id=$1
                  AND status = ANY($2::text[])`,
              [bookingId, allowedFromForQuickInvite, bookingFeeCredit, contractDepositBalanceDue]
            );
          } catch (err) {
            if (err.code !== '42703' && err.code !== '42P01') throw err;
          }
          if (bookingCarryoverList && bookingCarryoverIdx >= 0
              && allowedFromForQuickInvite.includes(
                   bookingCarryoverList[bookingCarryoverIdx]?.status || 'pending')) {
            bookingCarryoverList[bookingCarryoverIdx] = {
              ...bookingCarryoverList[bookingCarryoverIdx],
              status: 'completed',
              roomId,
              assignedRoomId: roomId,
              tenantId,
              contractId: contract.id,
              contractDepositAmount: contractDeposit,
              depositCreditAmount: bookingFeeCredit,
              depositBalanceDue: contractDepositBalanceDue,
              completedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              updatedBy: req.session.user.username,
            };
            await client.query(
              `INSERT INTO app_data (key, value, updated_by) VALUES ($1, $2, $3)
                 ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW(), updated_by=EXCLUDED.updated_by`,
              ['baankarn_bookings_v1', JSON.stringify(bookingCarryoverList), req.session.user.username]
            );
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
      const inviteHours = Math.max(1, Math.min(720, expiresInHours));
      const invIns = await client.query(
        `INSERT INTO contract_invitations
            (contract_id, tenant_id, token_hash, expires_at, created_by)
         VALUES ($1, $2, $3, NOW() + ($4::int || ' hours')::interval, $5)
         RETURNING id, expires_at`,
        [contract.id, tenantId, tk.hash, inviteHours, req.session.user.username]
      );
      const invitation = {
        id: invIns.rows[0].id,
        token: tk.token,
        expiresAt: invIns.rows[0].expires_at,
      };
      await client.query('COMMIT');

      let lineBindingCarryover = null;
      if (bookingIdForRoom) {
        try {
          lineBindingCarryover = await lineBinding.transferBookingBindings(pool, {
            bookingId: bookingIdForRoom,
            tenantId,
          });
        } catch (err) {
          console.warn('[quick-invite] booking LINE binding carry-over skipped:', err.message);
          lineBindingCarryover = { ok: false, error: err.message };
        }
      }

      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
      const url = `${proto}://${host}/contract/fill/${invitation.token}`;
      const delivery = await tryNotifyTenantContractInvitation(
        tenantForInviteNotify,
        contract,
        url,
        invitation.expiresAt
      );

      audit(req, 'contract.quick_invite', 'contract', String(contract.id),
        { contractNo: contract.contract_no, tenantId, invitationId: invitation.id, delivery, lineBindingCarryover,
          renewOfContractId: renewOfContractId || undefined });

      res.json({
        ok: true,
        tenant: { id: tenantId, fullName: tenantName, phone: tenantPhone },
        contract,
        delivery,
        lineBindingCarryover,
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
        return res.status(409).json(quickInviteDuplicateConflictBody(err, {
          roomId,
          tenantPhone,
        }));
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
        `SELECT c.id, c.contract_no, c.tenant_id, c.room_id, c.locked_at,
                t.full_name AS tenant_name, t.phone AS tenant_phone,
                t.email AS tenant_email, t.line_user_id, t.line_oa_id,
                t.status AS tenant_status
           FROM contracts c
           LEFT JOIN tenants t ON t.id = c.tenant_id AND t.deleted_at IS NULL
          WHERE c.id=$1 AND c.deleted_at IS NULL`,
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
      const delivery = await tryNotifyTenantContractInvitation({
        id: cQ.rows[0].tenant_id,
        full_name: cQ.rows[0].tenant_name,
        phone: cQ.rows[0].tenant_phone,
        email: cQ.rows[0].tenant_email,
        line_user_id: cQ.rows[0].line_user_id,
        line_oa_id: cQ.rows[0].line_oa_id,
        status: cQ.rows[0].tenant_status || 'active',
      }, cQ.rows[0], url, inv.expiresAt);
      audit(req, 'contract.invite_tenant', 'contract', String(id),
        { invitationId: inv.id, expiresAt: inv.expiresAt, delivery });
      res.json({
        ok: true,
        delivery,
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
      await expirePendingContractInvitations(pool);
      const { rows } = await pool.query(
        `SELECT i.id, i.contract_id, i.tenant_id, i.status,
                i.draft, i.submitted_at, i.approved_at, i.approved_by,
                i.rejected_at, i.rejected_by, i.rejection_reason,
                i.revoked_at, i.revoked_by,
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
      await expirePendingContractInvitations(pool);
      const { rows } = await pool.query(
        `SELECT i.*, c.contract_no, c.room_id, c.monthly_rent, c.deposit,
                t.full_name AS tenant_name, t.phone AS tenant_phone, t.email AS tenant_email,
                ff.url AS draft_front_url, bf.url AS draft_back_url, sf.url AS draft_signature_url
           FROM contract_invitations i
           LEFT JOIN contracts c ON c.id = i.contract_id
           LEFT JOIN tenants   t ON t.id = i.tenant_id
           LEFT JOIN file_uploads ff
                  ON ff.id = (i.draft->>'citizenIdImageFrontId')::bigint
                 AND ff.category='citizen_id_image'
                 AND ff.ref_id = ('invitation-' || i.id::text)
                 AND (ff.side='front' OR ff.side IS NULL)
           LEFT JOIN file_uploads bf
                  ON bf.id = (i.draft->>'citizenIdImageBackId')::bigint
                 AND bf.category='citizen_id_image'
                 AND bf.ref_id = ('invitation-' || i.id::text)
                 AND (bf.side='back' OR bf.side IS NULL)
           LEFT JOIN file_uploads sf
                  ON sf.id = (i.draft->>'signatureFileId')::bigint
                 AND sf.category='contract_signature'
                 AND sf.ref_id = ('invitation-' || i.id::text)
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
      // Hard-fail when the invitation has no tenant linked. Without
      // this, the whole "apply draft → tenant row" block below was
      // silently skipped: contract still locked, welcome bill still
      // fired, success/audit pretended to succeed — but address,
      // emergency contact, citizen ID, and photos all vanished. Admin
      // saw "approved + locked" with no idea data was dropped.
      if (!inv.tenant_id) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'invitation นี้ไม่ได้ผูกกับผู้เช่า — ไม่สามารถอนุมัติได้',
          code: 'TENANT_REQUIRED',
          hint: 'ลบ invitation เก่าและออกใหม่หลังจากผูก tenant กับ contract',
        });
      }
      const draft = inv.draft || {};
      const draftIssues = validateContractApprovalDraft(draft);
      if (draftIssues.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'ข้อมูลที่ผู้เช่ากรอกยังไม่ครบ จึงยัง approve และ lock สัญญาไม่ได้',
          code: 'CONTRACT_APPROVAL_PRECHECK_FAILED',
          issues: draftIssues,
          consequences: draftIssues.map((x) => x.consequence),
          nextActions: {
            rejectInvitation: true,
            hint: 'กด "ขอให้แก้" พร้อมระบุรายการที่ขาด แล้วให้ผู้เช่าส่งกลับมาใหม่',
          },
        });
      }
      const fileIssues = await validateContractDraftFiles(client, inv.id, draft);
      if (fileIssues.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'ไฟล์ที่แนบกับสัญญาไม่ตรงกับ invitation นี้ จึง approve ไม่ได้',
          code: 'CONTRACT_APPROVAL_FILE_PRECHECK_FAILED',
          issues: fileIssues,
          consequences: fileIssues.map((x) => x.consequence),
          nextActions: {
            rejectInvitation: true,
            hint: 'กด "ขอให้แก้" แล้วให้ผู้เช่าอัปโหลดไฟล์ผ่านลิงก์เดิมใหม่ทั้งหมด',
          },
        });
      }

      // Re-lock the tenant row to verify it still exists + isn't deleted
      // BEFORE applying drafts or binding to a room. Without this guard,
      // a tenant deleted between submit and approve would silently take
      // the contract lock + room reservation + welcome bill, leaving an
      // orphan: locked contract with no real tenant, room flipped to
      // 'occupied' for a row that scheduler.tickBillGen can't reach.
      // The room-binding block below also re-locks the tenant; promoting
      // the check here makes EVERY downstream write (drafts, tenant
      // fields, room bind, welcome bill) refuse to fire on a phantom row.
      const tenantGuard = await client.query(
        `SELECT id, status FROM tenants WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [inv.tenant_id]
      );
      if (!tenantGuard.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'ผู้เช่าที่ผูกกับ invitation นี้ถูกลบไปแล้ว ไม่สามารถ approve ได้',
          code: 'TENANT_DELETED',
          tenantId: inv.tenant_id,
          hint: 'ลบ invitation เก่า + ผูก contract กับผู้เช่าคนปัจจุบัน แล้วออก invitation ใหม่',
        });
      }
      // Approval reactivates the tenant (status → 'active' in the room-binding
      // block below), so a tenant blacklisted AFTER the invite went out must
      // not slip back in through this door. quick-invite and the booking
      // approve path both refuse blacklisted tenants — without this mirror,
      // approve-invitation was the one unguarded entrance.
      if (tenantGuard.rows[0].status === 'blacklist') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'ผู้เช่ารายนี้อยู่ใน blacklist — ไม่สามารถ approve สัญญาได้',
          code: 'TENANT_BLACKLISTED',
          tenantId: inv.tenant_id,
          hint: 'ตรวจสอบประวัติผู้เช่าก่อน หากต้องการรับกลับจริง ให้ปลดสถานะ blacklist ที่หน้าผู้เช่าอย่างตั้งใจ แล้วค่อย approve',
        });
      }

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
          // Scope to non-deleted tenants — the tenantGuard above pre-locks
          // the row but a defensive WHERE clause keeps this UPDATE safe
          // even if the guard is refactored away in the future.
          const draftUpd = await client.query(
            `UPDATE tenants SET ${sets.join(', ')}
              WHERE id=$${i} AND deleted_at IS NULL`,
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
          // Belt-and-braces — if the row vanished between tenantGuard and
          // this UPDATE (impossible inside the transaction, but defends
          // against future refactor that drops the FOR UPDATE lock above)
          // we treat it as the same "tenant deleted" condition.
          if (draftUpd && draftUpd.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: 'ผู้เช่าหายไประหว่าง approve — กรุณาลองใหม่',
              code: 'TENANT_DISAPPEARED',
            });
          }
        }
        const identityFileIds = [
          Number(draft.citizenIdImageFrontId),
          Number(draft.citizenIdImageBackId),
        ].filter((n) => Number.isInteger(n) && n > 0);
        if (identityFileIds.length) {
          await client.query(
            `UPDATE file_uploads
                SET ref_id=$1
              WHERE id = ANY($2::bigint[])
                AND category='citizen_id_image'
                AND ref_id=$3`,
            [String(inv.tenant_id), identityFileIds, `invitation-${inv.id}`]
          );
        }
      }

      // Apply signature → contracts row + lock the contract.
      const cLock = await client.query(
        `SELECT id, tenant_id, room_id, status, monthly_rent, deposit,
                template_id, locked_at
           FROM contracts
          WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [inv.contract_id]
      );
      if (!cLock.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'contract not found', code: 'CONTRACT_NOT_FOUND' });
      }
      if (cLock.rows[0].locked_at) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'contract is already locked',
          code: 'CONTRACT_LOCKED',
        });
      }
      const targetIssues = validateContractApprovalTarget(inv, cLock.rows[0]);
      if (targetIssues.length) {
        const summary = approvalIssueSummary(
          targetIssues,
          'สัญญาปลายทางไม่พร้อมสำหรับการ approve',
          'แก้ข้อมูลสัญญา/ผู้เช่า/ห้องให้ตรงกันก่อน แล้วค่อย approve ใหม่'
        );
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: summary.error,
          code: 'CONTRACT_APPROVAL_TARGET_INVALID',
          issues: targetIssues,
          issueSummary: summary.issueSummary,
          consequences: targetIssues.map((x) => x.consequence),
          hint: summary.hint,
          nextActions: {
            contractUrl: `/admin#contracts`,
            invitationUrl: `/admin#contract-invitations`,
            hint: summary.hint || 'แก้ข้อมูลสัญญา/ผู้เช่า/ห้องให้ตรงกันก่อน แล้วค่อย approve ใหม่',
          },
        });
      }
      const termsSnapshot = await loadContractTermsSnapshot(client, cLock.rows[0]);
      const updateSets = [
        'updated_at=NOW()',
        'locked_at=NOW()',
        'locked_by=$2',
        `terms_template_snapshot=$3::jsonb`,
      ];
      const updateParams = [
        inv.contract_id,
        req.session.user.username,
        JSON.stringify(termsSnapshot.snapshot),
      ];
      let pi = 4;
      if (draft.signatureFileId) {
        updateSets.push(`signature_image_id=$${pi++}`,
                        `signed_at = COALESCE(signed_at, NOW())`,
                        `agreed_terms_at = COALESCE(agreed_terms_at, NOW())`);
        updateParams.push(Number(draft.signatureFileId));
        updateSets.push(`agreed_terms_version = COALESCE(agreed_terms_version, $${pi++})`);
        updateParams.push(String(draft.agreedTermsVersion || 'tenant-fill-v1').slice(0, 64));
      } else if (draft.agreedTermsVersion) {
        updateSets.push(`agreed_terms_version=$${pi++}`,
                        `agreed_terms_at = COALESCE(agreed_terms_at, NOW())`);
        updateParams.push(String(draft.agreedTermsVersion).slice(0, 64));
      }
      // Pull contract.room_id back so we can sync room state below.
      const cUpdate = await client.query(
        `UPDATE contracts SET ${updateSets.join(', ')}
          WHERE id=$1 AND deleted_at IS NULL AND locked_at IS NULL
          RETURNING id, contract_no, room_id, tenant_id, monthly_rent, deposit,
                    start_date, discount_pct, template_id, locked_at`,
        updateParams
      );
      const contract = cUpdate.rows[0];
      if (!contract) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'contract is already locked', code: 'CONTRACT_LOCKED' });
      }
      if (draft.signatureFileId) {
        await client.query(
          `UPDATE file_uploads
              SET ref_id=$1
            WHERE id=$2
              AND category='contract_signature'
              AND ref_id=$3`,
          [String(contract.id), Number(draft.signatureFileId), `invitation-${inv.id}`]
        );
      }

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
          // deleted_at IS NULL guard matches the tenantGuard at the top
          // of the handler — refuses to bind a soft-deleted tenant even
          // if some future refactor weakens the early check.
          const bindUpd = await client.query(
            `UPDATE tenants
                SET current_room_id=$1, status='active', updated_at=NOW()
              WHERE id=$2 AND deleted_at IS NULL`,
            [contract.room_id, inv.tenant_id]
          );
          if (bindUpd.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: 'ผู้เช่าหายไประหว่าง approve — กรุณาลองใหม่',
              code: 'TENANT_DISAPPEARED',
            });
          }

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
                                ((value->$1) - 'tenant') || jsonb_build_object('status', 'vacant')
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
          // Surface clear next-step URLs so the admin UI can render
          // action buttons instead of a dead-end error message. The
          // tenant page lets admin checkout the existing occupant; the
          // contract template assignment page lets admin reassign room.
          nextActions: {
            checkoutExistingTenantUrl: `/admin#tenants/${roomConflict.id}`,
            invitationUrl: `/admin#contract-invitations`,
            hint: `1) ไปหน้าผู้เช่าคนเดิม กด check-out  2) กลับมาที่ใบเชิญนี้แล้ว approve ใหม่`,
          },
        });
      }

      await client.query(
        `UPDATE contract_invitations
            SET status='approved', approved_at=NOW(), approved_by=$2, updated_at=NOW()
          WHERE id=$1`,
        [id, req.session.user.username]
      );

      // ============== Welcome bill ==============
      // The legacy /tenants/:id/checkin path creates a welcome bill for the
      // move-in period (see routes/tenant-ops.js). Without an equivalent
      // here, tenants approved via the invitation flow have NO first-month
      // bill until the scheduler's next monthly tick — i.e. an Apr-3 move-in
      // approved Apr-5 gets billed in May, not Apr. Mirror the checkin
      // logic so both onboarding paths produce the same outcome.
      //
      // Period derived from contract.start_date (NOT wallclock) so back-
      // dated approvals stamp the bill in the right month. ON CONFLICT
      // DO NOTHING handles the (rare) race where a manual bill was already
      // created for this room+period.
      let welcomeBillCreated = null;
      let welcomeBillError = null;
      if (inv.tenant_id && contract.room_id && Number(contract.monthly_rent) > 0) {
        await client.query('SAVEPOINT welcome_bill');
        try {
          const startStr = (contract.start_date instanceof Date)
            ? contract.start_date.toISOString().slice(0, 10)
            : String(contract.start_date || '').slice(0, 10);
          const moveInMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startStr);
          const period = moveInMatch
            ? `${moveInMatch[1]}-${moveInMatch[2]}`
            : billing.formatPeriodNow();
          // Due day for the welcome bill: the snapshot being locked onto THIS
          // contract right now is the authoritative source — it is literally
          // the due day printed on the PDF the tenant just signed. Config is
          // the fallback for templates that don't carry financials.
          const dueCfg = await client.query(
            `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
          ).then((r) => r.rows[0]?.value || null).catch(() => null);
          const welcomeDue = billing.resolveBillDueDay({
            contractDueDay: termsSnapshot?.snapshot?.financials?.dueDay,
            configDueDay: dueCfg?.notify?.dueOnDay,
          });
          const dueDay = welcomeDue.day;
          const dueDate = moveInMatch
            ? billing.formatYMD(Number(moveInMatch[1]), Number(moveInMatch[2]), dueDay)
            : billing.formatDueDate(dueDay);
          // Stack contract discount + config.discounts.firstMonth promo
          // multiplicatively (same formula as checkin) so first-month
          // promotions still apply on the invitation path.
          let welcomeRent = Number(contract.monthly_rent) || 0;
          const contractPct = Math.max(0, Math.min(50,
            Number(contract.discount_pct ?? 0)));
          const { rows: cfgR } = await client.query(
            `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
          );
          const firstMonthPct = Math.max(0, Math.min(50,
            Number(cfgR[0]?.value?.discounts?.firstMonth) || 0));
          const combinedPct = Math.min(50,
            100 * (1 - (1 - contractPct / 100) * (1 - firstMonthPct / 100)));
          welcomeRent = Math.round(welcomeRent * (1 - combinedPct / 100) * 100) / 100;
          // config.billing.prorateFirstMonth — mirror the checkin path: charge
          // only the days lived in the move-in month. Off by default (full month).
          if (cfgR[0]?.value?.billing?.prorateFirstMonth === true && moveInMatch) {
            const y = Number(moveInMatch[1]);
            const mo = Number(moveInMatch[2]);
            const day = Number(moveInMatch[3]);
            const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
            const frac = billing.firstMonthProrationFraction({ moveInDay: day, daysInMonth, prorate: true });
            welcomeRent = Math.round(welcomeRent * frac * 100) / 100;
          }
          // Resolve the room's flat (non-metered) charges, mirroring the
          // /checkin welcome bill (routes/tenant-ops.js) so BOTH onboarding paths
          // bill the same first-month line items — previously this path billed
          // rent ONLY and silently dropped wifi / common fee / flat utilities
          // (an undercharge on every invitation-approved tenant). Metered
          // water/elec are NOT on the welcome bill (their first consumption is
          // measured next cycle from the baseline captured below).
          const cfgValForBill = cfgR[0]?.value || {};
          const roomBlobQ = await client.query(
            `SELECT value->$1 AS room FROM app_data WHERE key='baankarn_rooms_v1' LIMIT 1`,
            [contract.room_id]
          );
          const billRoomObj = (roomBlobQ.rows[0] && roomBlobQ.rows[0].room) || {};
          let flatFrac = 1;
          if (moveInMatch) {
            const _dim = new Date(Date.UTC(Number(moveInMatch[1]), Number(moveInMatch[2]), 0)).getUTCDate();
            flatFrac = billing.firstMonthProrationFraction({
              moveInDay: Number(moveInMatch[3]), daysInMonth: _dim, prorate: true,
            });
          }
          const _util = (cfgValForBill && typeof cfgValForBill.utilities === 'object') ? cfgValForBill.utilities : {};
          const _pickNum = (...vals) => {
            for (const v of vals) {
              if (v != null && v !== '' && Number.isFinite(Number(v))) return Math.max(0, Number(v));
            }
            return 0;
          };
          const r2 = (n) => Math.round(n * 100) / 100;
          const wifiAmt = r2(_pickNum(billRoomObj.wifiOverride, billRoomObj.wifi_override, billRoomObj.wifi, _util.wifi) * flatFrac);
          const commonAmt = r2(_pickNum(billRoomObj.commonFeeOverride, billRoomObj.common_fee_override, billRoomObj.commonFee, billRoomObj.common_fee, _util.commonFee) * flatFrac);
          const waterAmt = r2((billing.isFlatUtilityConfigured(billRoomObj, 'water')
            ? _pickNum(billRoomObj.waterFlatAmount, billRoomObj.water_flat_amount) : 0) * flatFrac);
          const elecAmt = r2((billing.isFlatUtilityConfigured(billRoomObj, 'elec')
            ? _pickNum(billRoomObj.elecFlatAmount, billRoomObj.elec_flat_amount) : 0) * flatFrac);
          const welcomeOther = commonAmt > 0
            ? [{ label: `ค่าส่วนกลาง${flatFrac < 1 ? ' (ตามวันที่อยู่)' : ''}`, amount: commonAmt }]
            : [];
          const welcomeSubtotal = r2(welcomeRent + wifiAmt + waterAmt + elecAmt + commonAmt);
          let billNo = billing.makeBillNo(contract.room_id, period);
          const billNoCheck = await client.query(
            `SELECT tenant_id FROM bills
               WHERE bill_no=$1 AND deleted_at IS NULL
               LIMIT 1
               FOR UPDATE`,
            [billNo]
          );
          const existingBillTenantId = billNoCheck.rows[0]?.tenant_id;
          if (billNoCheck.rows.length && Number(existingBillTenantId || 0) !== Number(inv.tenant_id)) {
            billNo = billing.makeBillNo(contract.room_id, period, { tenantId: inv.tenant_id });
          }
          const welcomePaymentRef = billing.applyPaymentReferenceCents({
            billNo, roomId: contract.room_id, period,
            subtotal: welcomeSubtotal, vat: 0, lateFee: 0, total: welcomeSubtotal,
            other: welcomeOther,
          }, { tenantId: inv.tenant_id });
          const adjustedWelcomeSubtotal = Number(welcomePaymentRef.subtotal) || welcomeSubtotal;
          const adjustedWelcomeOther = Array.isArray(welcomePaymentRef.other) ? welcomePaymentRef.other : welcomeOther;
          if (adjustedWelcomeSubtotal > 0) {
            const billIns = await client.query(
              `INSERT INTO bills
                 (bill_no, tenant_id, room_id, period, rent,
                  water_amount, elec_amount, wifi, other,
                  subtotal, vat, late_fee, total, due_date, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, 0, 0, $10, $11, 'pending')
               ON CONFLICT DO NOTHING
               RETURNING id, bill_no, period, total, due_date`,
              [billNo, inv.tenant_id, contract.room_id, period, welcomeRent,
               waterAmt, elecAmt, wifiAmt, JSON.stringify(adjustedWelcomeOther),
               adjustedWelcomeSubtotal, dueDate]
            );
            if (billIns.rows.length) welcomeBillCreated = billIns.rows[0];
          }
          // TL-2: establish a move-in meter baseline so the FIRST metered bill
          // measures only THIS tenant's usage, not the previous occupant's. The
          // invitation flow has no operator-entered reading, so we anchor the
          // baseline at the room's latest known reading (the handover point) for
          // each METERED utility — but only when the move-in period has no
          // reading yet, so we never overwrite an existing period reading.
          for (const mt of ['water', 'elec']) {
            if (billing.isFlatUtilityConfigured(billRoomObj, mt)) continue; // flat → no meter
            try {
              const existsQ = await client.query(
                `SELECT 1 FROM meter_readings WHERE room_id=$1 AND meter_type=$2 AND period=$3 LIMIT 1`,
                [contract.room_id, mt, period]
              );
              if (existsQ.rows.length) continue;
              const last = await meter.latest(client, contract.room_id, mt);
              if (!last) continue; // no prior reading → next bill gets 0 units (safe)
              await meter.record(client, {
                roomId: contract.room_id, meterType: mt, reading: Number(last.reading),
                period, source: 'invitation-approve', createdBy: req.session.user.username,
              });
            } catch (mErr) {
              console.warn(`[approve] meter baseline (${mt}) skipped:`, mErr.message);
            }
          }
          await client.query('RELEASE SAVEPOINT welcome_bill');
        } catch (err) {
          // Welcome bill is best-effort — admin can manually create one
          // from /admin#billing if this fails. Roll back only this block so
          // a unique/schema error cannot poison the main approve transaction.
          // Capture the error message so the admin response can surface a
          // visible warning instead of failing silently (previously this
          // only hit the server log and admins missed it until the tenant
          // complained about no first-month bill).
          await client.query('ROLLBACK TO SAVEPOINT welcome_bill').catch(() => {});
          await client.query('RELEASE SAVEPOINT welcome_bill').catch(() => {});
          welcomeBillError = err && err.message ? String(err.message).slice(0, 200) : 'unknown error';
          console.warn('[approve] welcome bill skipped:', err.message);
        }
      }
      await client.query('COMMIT');
      // Audit log — captures the full state change so a tenant dispute
      // months later ("ทำไม locked ตอนนั้น? termsSnapshot ใช้ template ไหน?")
      // can be answered without grepping notifications_log.
      //
      // Includes:
      //   - lockedAt/lockedBy: who flipped the contract from draft → locked
      //   - templateId + snapshotVersion: which terms got frozen on the bill
      //   - signature: whether a signature image was captured
      //   - welcomeBill: bill_no if the move-in bill was created
      //   - welcomeBillError: surface SAVEPOINT failure so admin reconciles
      //     manually instead of finding out from the tenant
      audit(req, 'contract.invitation_approve', 'contract', String(inv.contract_id),
        { invitationId: id, draftKeys: Object.keys(draft),
          roomId: contract.room_id, tenantId: inv.tenant_id,
          // The contract row was UPDATE'd with locked_at=NOW() + locked_by
          // a few lines above; using `req.session.user.username` matches
          // what the SQL stored, and `lockedAt` is approximated to the
          // commit moment (millisecond precision is enough for audit).
          lockedAt: new Date().toISOString(),
          lockedBy: req.session.user.username,
          templateId: termsSnapshot.templateId || null,
          snapshotVersion: termsSnapshot.snapshot?.snapshotVersion || null,
          hasSignature: !!draft.signatureFileId,
          agreedTermsVersion: draft.agreedTermsVersion || null,
          welcomeBill: welcomeBillCreated ? welcomeBillCreated.bill_no : null,
          welcomeBillError: welcomeBillError || null });

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
          `🔒 สัญญามีผลและล็อกการแก้ไขแล้ว · ห้องถูกบันทึกเป็น "มีผู้พัก"`,
          ``,
          `📄 ดู PDF: ${proto}://${host}/api/contracts/${contract.id}/pdf`,
        ].filter(Boolean);
        notifier.notifyOwner({ pool, features: flags }, {
          category: 'tenancy',
          subject: `✅ อนุมัติสัญญา ${contract.contract_no || ''} — ห้อง ${contract.room_id || ''}`,
          text: lines.join('\n'),
        }).catch(() => {});

        // Tenant notify — points at the tenant portal where they can
        // download their own signed PDF (see GET /api/tenant/contract/:id/pdf
        // below). The welcome-bill block above stamps the first-month bill
        // inside the same transaction so the "ดูบิลรอบแรก" CTA is honest.
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
                  welcomeBillCreated
                    ? `บิลรอบแรก: ${welcomeBillCreated.bill_no} (กำหนด ${welcomeBillCreated.due_date})`
                    : null,
                  ``,
                  `📋 ขั้นตอนต่อไป:`,
                  `   • ดูสัญญา + ดาวน์โหลด PDF ที่พอร์ทัลผู้เช่า`,
                  `   • เข้าพอร์ทัลผู้เช่าที่ ${proto}://${host}/tenant ด้วยเบอร์โทรที่ผูกกับห้อง`,
                  welcomeBillCreated
                    ? `   • บิลรอบแรกพร้อมชำระแล้ว — เข้าพอร์ทัลเพื่อดูรายละเอียด`
                    : `   • บิลรอบแรกจะออกในรอบบิลเดือนถัดไป`,
                ].filter(Boolean).join('\n'),
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
        welcomeBill: welcomeBillCreated || null,
        // Non-fatal warning so admin sees in UI immediately and can create
        // the bill manually from /admin#billing instead of finding out via
        // tenant complaint that the first month never billed.
        welcomeBillError: welcomeBillError || null,
        // Surface the integration so admin UI can show "ดู PDF" / "สร้างบิลแรก"
        // CTAs without round-tripping back to the server.
        nextActions: {
          pdfUrl: `/api/contracts/${contract.id}/pdf`,
          billingUrl: `/admin#billing`,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err && err.code === '23505' && err.constraint === 'uq_tenants_active_room') {
        return res.status(409).json({
          error: 'ห้องนี้มีผู้เช่า active อยู่แล้ว — ไม่สามารถ approve สัญญาซ้อนห้องได้',
          code: 'ROOM_OCCUPIED',
          constraint: 'uq_tenants_active_room',
          hint: 'ตรวจผู้เช่า/สัญญาของห้องนี้ แล้ว checkout หรือปิดสัญญาเดิมก่อน approve อีกครั้ง',
          nextActions: {
            tenantsListUrl: '/admin#tenants',
            contractsUrl: '/admin#contracts',
            invitationUrl: '/admin#contract-invitations',
          },
        });
      }
      if (err.http) {
        // Enrich CITIZEN_ID_DUPLICATE with admin-actionable next steps —
        // they need to reconcile (find the existing tenant + decide if
        // it's the same person or a real duplicate) before re-approving.
        const body = { error: err.message, code: err.code };
        if (err.code === 'CITIZEN_ID_DUPLICATE') {
          body.error = 'เลขบัตรประชาชนนี้ถูกบันทึกในระบบแล้วกับผู้เช่ารายอื่น';
          body.hint = 'ใช้ /api/tenants/lookup-by-citizen-id เพื่อหาผู้เช่าเดิม '
            + 'แล้วตัดสินใจว่าเป็นคนเดียวกัน (ใช้ tenant เดิม) หรือคนละคน '
            + '(ขอให้ผู้เช่าตรวจเลขบัตรอีกครั้ง)';
          body.nextActions = {
            tenantsListUrl: '/admin#tenants',
            invitationUrl: '/admin#contract-invitations',
          };
        }
        return res.status(err.http).json(body);
      }
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
      // Pull tenant_id back in the RETURNING so we can LINE-notify them
      // about the rejection — without it the tenant has to guess the
      // link is back open and re-visit it manually.
      // Extend expires_at by 7 days from now: if the original 7-day window
      // already lapsed by the time admin got around to reviewing, the
      // tenant would otherwise hit a lazy-expire on their next visit and
      // never get a chance to fix the issue.
      const { rows } = await pool.query(
        `UPDATE contract_invitations
            SET status='pending', rejected_at=NOW(), rejected_by=$2,
                rejection_reason=$3,
                expires_at = GREATEST(expires_at, NOW() + INTERVAL '7 days'),
                updated_at=NOW()
          WHERE id=$1 AND status='submitted'
          RETURNING id, contract_id, tenant_id`,
        [id, req.session.user.username, reason]
      );
      if (!rows.length) return res.status(409).json({
        error: 'reject ได้เฉพาะ invitation สถานะ submitted', code: 'BAD_STATUS',
      });
      audit(req, 'contract.invitation_reject', 'contract', String(rows[0].contract_id),
        { invitationId: id, reason });

      // Tenant notify — they need to know admin sent it back AND why,
      // otherwise they'll wait forever wondering what happened. Best-effort:
      // a notifier failure doesn't undo the reject.
      const tenantId = rows[0].tenant_id;
      if (tenantId) {
        try {
          const flags = await features.load(pool);
          const tQ = await pool.query(
            `SELECT id, full_name, phone, email, line_user_id, line_oa_id, status
               FROM tenants WHERE id=$1 AND deleted_at IS NULL`,
            [tenantId]
          );
          if (tQ.rows.length) {
            notifier.notifyTenant({ pool, features: flags }, tQ.rows[0], {
              subject: '📋 กรุณาแก้ไขข้อมูลสัญญา',
              text: [
                `เรียน คุณ${tQ.rows[0].full_name || ''}`,
                ``,
                `เจ้าของหอพักขอให้แก้ไขข้อมูลสัญญาบางจุด:`,
                ``,
                `📝 เหตุผล: ${reason}`,
                ``,
                `กรุณาเปิดลิงก์เดิมที่เคยส่งให้ — แก้ไขแล้วกด "ส่งให้ตรวจสอบ" อีกครั้ง`,
                `(ลิงก์เดิมยังใช้ได้ ไม่ต้องขอลิงก์ใหม่)`,
              ].join('\n'),
            }).catch((err) => {
              console.warn('[reject] tenant notify failed:', err.message);
            });
          }
        } catch { /* notify failures don't break the response */ }
      }

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
    if (!inv) {
      // Drill into raw state for actionable error messages. This is what
      // distinguishes "you already submitted, just wait" from "admin
      // revoked, you need a new link" — both look like 404 otherwise.
      const raw = await contractInvitation.inspectByToken(pool, token);
      if (raw) {
        if (raw.status === 'approved') return res.status(410).json({
          error: 'สัญญาได้รับการอนุมัติแล้ว — ติดต่อเจ้าของหอพักเพื่อรับ PDF',
          code: 'ALREADY_APPROVED',
        });
        if (raw.status === 'revoked') return res.status(410).json({
          error: 'ลิงก์นี้ถูกยกเลิกโดยเจ้าของหอพัก — ติดต่อขอลิงก์ใหม่',
          code: 'REVOKED',
        });
        if (raw.status === 'expired') return res.status(410).json({
          error: 'ลิงก์หมดอายุแล้ว — ติดต่อเจ้าของหอพักเพื่อขอลิงก์ใหม่',
          code: 'EXPIRED',
        });
      }
      return res.status(404).json({
        error: 'ลิงก์นี้ใช้ไม่ได้ — ติดต่อเจ้าของหอพัก',
        code: 'TOKEN_INVALID',
      });
    }
    let building = { name: 'ที่พักของคุณ' };
    // Resolve the payment terms the tenant is about to agree to from the LIVE
    // config (pending invitation = current terms; they lock into the snapshot
    // at approval). Previously the contract-fill page hardcoded "วันที่ 15".
    const financials = { dueDay: 15, lateFeeRate: 1.5 };
    try {
      const cfgQ = await pool.query(
        `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
      );
      const cfg = cfgQ.rows[0]?.value || {};
      if (cfg.building) building = { ...building, ...cfg.building };
      const d = Number(cfg?.notify?.dueOnDay);
      if (Number.isFinite(d) && d >= 1 && d <= 28) financials.dueDay = Math.floor(d);
    } catch { /* keep default */ }
    try {
      const flags = await features.load(pool);
      const r = Number(flags?.lateFee?.ratePctPerMonth);
      if (Number.isFinite(r) && r >= 0) financials.lateFeeRate = r;
    } catch { /* keep default */ }
    res.json({ ok: true, view: contractInvitation.buildPublicView(inv, building, financials) });
  } catch (err) {
    console.error('contract-fill GET error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Shared helper: build a friendly error response based on the raw row
// state. Both PUT and Upload need the same "distinguish terminal states"
// behavior — collapsing every failure to TOKEN_INVALID was the bug that
// made the tenant page show "ลิงก์ใช้ไม่ได้" with no actionable next step.
async function _contractFillFriendlyError(pool, contractInvitation, token, res) {
  const raw = await contractInvitation.inspectByToken(pool, token);
  if (raw) {
    if (raw.status === 'approved') return res.status(410).json({
      error: 'สัญญาได้รับการอนุมัติแล้ว', code: 'ALREADY_APPROVED',
    });
    if (raw.status === 'revoked') return res.status(410).json({
      error: 'ลิงก์ถูกยกเลิกโดยเจ้าของหอพัก', code: 'REVOKED',
    });
    if (raw.status === 'expired') return res.status(410).json({
      error: 'ลิงก์หมดอายุแล้ว', code: 'EXPIRED',
    });
  }
  return res.status(404).json({
    error: 'ลิงก์นี้ใช้ไม่ได้', code: 'TOKEN_INVALID',
  });
}

// PUT /api/contract-fill/:token — save draft (intermediate state)
// sameOrigin: token-in-URL is the only auth, so a leaked link is enough
// to read the form (acceptable — it's a 32-byte random). But a leaked
// link must NOT be enough to OVERWRITE the draft from a third-party
// page (e.g. tenant clicks a phishing link that fires a hidden XHR
// to PUT a malicious signature image). sameOrigin denies cross-site
// fetches that lack the Origin/Referer of this app.
app.put('/api/contract-fill/:token', rateLimitContractFill, sameOrigin, async (req, res) => {
  const token = String(req.params.token).slice(0, 80);
  const contractInvitation = require('./services/contractInvitation');
  try {
    const inv = await contractInvitation.resolveActiveByToken(pool, token);
    if (!inv) return _contractFillFriendlyError(pool, contractInvitation, token, res);
    if (inv.status !== 'pending') {
      return res.status(409).json({
        error: 'ส่งให้ตรวจสอบแล้ว — แก้ไขไม่ได้จนกว่า admin จะ reject',
        code: 'NOT_EDITABLE',
      });
    }
    const draft = contractInvitation.sanitiseDraft(req.body);
    // Merge over existing — tenant might be saving partial fields.
    const merged = Object.assign({}, inv.draft || {}, draft);
    // Slide expires_at forward on every save: a tenant actively filling
    // shouldn't have their link expire underneath them. We bump it to
    // 7 days from now if the current expires_at is closer than that.
    // Idle invitations still expire on the original schedule.
    const saved = await pool.query(
      `UPDATE contract_invitations
          SET draft=$1::jsonb,
              expires_at = GREATEST(expires_at, NOW() + INTERVAL '7 days'),
              updated_at=NOW()
        WHERE id=$2 AND status='pending'
        RETURNING draft`,
      [JSON.stringify(merged), inv.id]
    );
    if (!saved.rows.length) {
      const raw = await contractInvitation.inspectByToken(pool, token);
      if (raw && raw.status === 'submitted') {
        return res.status(409).json({
          error: 'ส่งให้ตรวจสอบแล้ว — แก้ไขไม่ได้จนกว่า admin จะ reject',
          code: 'NOT_EDITABLE',
        });
      }
      return _contractFillFriendlyError(pool, contractInvitation, token, res);
    }
    res.json({ ok: true, draft: saved.rows[0].draft || merged });
  } catch (err) {
    console.error('contract-fill PUT error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /api/contract-fill/:token/upload — tenant uploads ID front/back/signature
// sameOrigin: see PUT above. Without this guard, a third-party page that
// has obtained the token (forwarded LINE message, screenshot etc.)
// could overwrite the tenant's signature/ID images via a hidden form.
app.post('/api/contract-fill/:token/upload', rateLimitContractFill, sameOrigin, async (req, res) => {
  const token = String(req.params.token).slice(0, 80);
  const contractInvitation = require('./services/contractInvitation');
  try {
    const inv = await contractInvitation.resolveActiveByToken(pool, token);
    if (!inv) return _contractFillFriendlyError(pool, contractInvitation, token, res);
    if (inv.status !== 'pending') {
      return res.status(409).json({
        error: 'ส่งให้ตรวจสอบแล้ว — แก้ไขไม่ได้',
        code: 'NOT_EDITABLE',
      });
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
    // Persist the file id into the draft in the same request. This closes
    // the race where upload succeeds but submit happens before autosave.
    const draftKey = kind === 'signature'
      ? 'signatureFileId'
      : (kind === 'front' ? 'citizenIdImageFrontId' : 'citizenIdImageBackId');
    const previousFileId = Number(inv.draft && inv.draft[draftKey]) || null;
    let updatedDraft = null;
    try {
      const upd = await pool.query(
        `UPDATE contract_invitations
            SET draft = COALESCE(draft, '{}'::jsonb)
                        || jsonb_build_object($2::text, $3::int),
                expires_at = GREATEST(expires_at, NOW() + INTERVAL '7 days'),
                updated_at=NOW()
          WHERE id=$1 AND status='pending'
          RETURNING draft`,
        [inv.id, draftKey, out.id]
      );
      if (!upd.rows.length) {
        await storage.remove(pool, out.id).catch(() => {});
        return res.status(409).json({
          error: 'ส่งให้ตรวจสอบแล้ว — แก้ไขไม่ได้',
          code: 'NOT_EDITABLE',
        });
      }
      updatedDraft = upd.rows[0].draft;
    } catch (err) {
      await storage.remove(pool, out.id).catch(() => {});
      throw err;
    }
    if (previousFileId && previousFileId !== out.id) {
      storage.remove(pool, previousFileId).catch(() => {});
    }
    res.json({ ok: true, file: { id: out.id, url: out.url, kind }, draft: updatedDraft });
  } catch (err) {
    console.error('contract-fill upload error:', err.message);
    res.status(400).json({ error: err.message || 'upload failed' });
  }
});

// POST /api/contract-fill/:token/submit — tenant flips to status='submitted'
//
// Idempotent on already-submitted (double-click safe). When the token is
// invalid we drill into the raw row state so the response distinguishes
// expired / revoked / approved / never-existed — without this the tenant
// sees a generic "ลิงก์ใช้ไม่ได้" with no actionable next step.
app.post('/api/contract-fill/:token/submit', rateLimitContractFill, sameOrigin, async (req, res) => {
  const token = String(req.params.token).slice(0, 80);
  const contractInvitation = require('./services/contractInvitation');
  try {
    const inv = await contractInvitation.resolveActiveByToken(pool, token);
    if (!inv) {
      // Drill into the raw row so we can return a useful error code.
      // resolveActiveByToken collapses many distinct states into null:
      // expired / revoked / approved / rejected / bad-format / no-row.
      const raw = await contractInvitation.inspectByToken(pool, token);
      if (raw) {
        if (raw.status === 'approved') {
          return res.status(409).json({
            error: 'สัญญานี้ได้รับการอนุมัติแล้ว — ไม่ต้องส่งซ้ำ',
            code: 'ALREADY_APPROVED',
          });
        }
        if (raw.status === 'revoked') {
          return res.status(409).json({
            error: 'ลิงก์นี้ถูกยกเลิกโดยเจ้าของหอพัก — ติดต่อขอลิงก์ใหม่',
            code: 'REVOKED',
          });
        }
        if (raw.status === 'expired') {
          return res.status(409).json({
            error: 'ลิงก์หมดอายุแล้ว — ติดต่อเจ้าของหอพักเพื่อขอต่ออายุ',
            code: 'EXPIRED',
          });
        }
      }
      return res.status(404).json({
        error: 'ลิงก์นี้ใช้ไม่ได้ — ติดต่อเจ้าของหอพัก',
        code: 'TOKEN_INVALID',
      });
    }
    // Idempotent re-submit: if the row is already 'submitted', a second
    // click (double-tap, network retry) should NOT error out. Just confirm
    // success — the tenant's data is already captured.
    if (inv.status === 'submitted') {
      return res.json({
        ok: true, invitationId: inv.id, status: 'submitted',
        alreadySubmitted: true,
      });
    }
    if (inv.status !== 'pending') {
      return res.status(409).json({
        error: 'ลิงก์นี้แก้ไขไม่ได้แล้ว',
        code: 'NOT_EDITABLE', status: inv.status,
      });
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
    const thaiId = require('./services/thaiId');
    if (!draft.signatureFileId) missing.push('signature');
    if (!draft.address) missing.push('address');
    if (!draft.emergencyContactName) missing.push('emergencyContactName');
    if (!draft.emergencyContactPhone) missing.push('emergencyContactPhone');
    if (!thaiId.normalize(draft.citizenId)) missing.push('citizenId');
    if (!draft.citizenIdImageFrontId) missing.push('citizenIdFront');
    if (!draft.citizenIdImageBackId) missing.push('citizenIdBack');
    if (missing.length > 0) {
      return res.status(400).json({
        error: `กรอกไม่ครบ — ขาด: ${missing.join(', ')}`,
        code: 'INCOMPLETE', missing,
      });
    }
    const fileIssues = await validateContractDraftFiles(pool, inv.id, draft);
    if (fileIssues.length > 0) {
      return res.status(400).json({
        error: 'ไฟล์แนบไม่ตรงกับลิงก์สัญญานี้ — กรุณาอัปโหลดใหม่จากหน้านี้',
        code: 'INVALID_UPLOADS',
        issues: fileIssues,
      });
    }
    // Extend expires_at to give admin a generous review window. Without
    // this, a tenant who barely beat the 7-day expiry would have their
    // submitted row lazy-expired before admin gets to review it (now
    // prevented by the resolveActiveByToken change too, but defense in
    // depth is cheap).
    const submitUpdate = await pool.query(
      `UPDATE contract_invitations
          SET status='submitted', draft=$1::jsonb, submitted_at=NOW(),
              expires_at = GREATEST(expires_at, NOW() + INTERVAL '60 days'),
              updated_at=NOW()
        WHERE id=$2 AND status='pending'
        RETURNING id`,
      [JSON.stringify(draft), inv.id]
    );
    if (!submitUpdate.rows.length) {
      const raw = await contractInvitation.inspectByToken(pool, token);
      if (raw && raw.status === 'submitted') {
        return res.json({
          ok: true, invitationId: inv.id, status: 'submitted',
          alreadySubmitted: true,
        });
      }
      if (raw && raw.status === 'approved') {
        return res.status(409).json({
          error: 'สัญญานี้ได้รับการอนุมัติแล้ว — ไม่ต้องส่งซ้ำ',
          code: 'ALREADY_APPROVED',
        });
      }
      if (raw && raw.status === 'revoked') {
        return res.status(409).json({
          error: 'ลิงก์นี้ถูกยกเลิกโดยเจ้าของหอพัก — ติดต่อขอลิงก์ใหม่',
          code: 'REVOKED',
        });
      }
      if (raw && raw.status === 'expired') {
        return res.status(409).json({
          error: 'ลิงก์หมดอายุแล้ว — ติดต่อเจ้าของหอพักเพื่อขอต่ออายุ',
          code: 'EXPIRED',
        });
      }
      return res.status(409).json({
        error: 'ลิงก์นี้แก้ไขไม่ได้แล้ว',
        code: 'NOT_EDITABLE',
        status: raw ? raw.status : null,
      });
    }
    // Owner notify so admin sees a fresh submission immediately.
    try {
      const flags = await features.load(pool);
      notifier.notifyOwner({ pool, features: flags }, {
        category: 'tenancy',
        subject: '📥 ผู้เช่ากรอกข้อมูลสัญญาเสร็จแล้ว — รอตรวจอนุมัติ',
        text: 'ผู้เช่ากรอกข้อมูลและเซ็นสัญญาผ่านลิงก์เรียบร้อยแล้ว\n'
          + '👉 ขั้นต่อไป: เปิดเมนู "ใบเชิญผู้เช่ากรอก" (/admin#contract-invitations) ตรวจรูปบัตร ที่อยู่ และลายเซ็น แล้วกดอนุมัติเพื่อให้สัญญามีผล',
      }).catch(() => {});
    } catch { /* ignore */ }
    res.json({ ok: true, invitationId: inv.id, status: 'submitted' });
  } catch (err) {
    console.error('contract-fill submit error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/contract-fill/:token/pdf — tenant self-serves the APPROVED signed
// contract PDF straight from the fill-page success screen. Right after
// approval the tenant usually has no portal session yet, so the invitation
// token (the same credential that protected the whole fill flow) gates this.
//
// Security model:
//   - per-IP rate limit (rateLimitContractFill) against token cycling
//   - approved-only: pending/submitted must NOT leak a draft PDF whose terms
//     aren't final yet (mirrors the portal's locked_at gate)
//   - expires_at is honored even though 'approved' is terminal — a forwarded
//     LINE message must not stay a forever-credential to a PII document.
//     Submit already extends the window +60 days; after that the tenant
//     portal (phone login) serves the same PDF at /api/tenant/contract/:id/pdf.
//   - NO certified ID-card appendix (unlike the admin sign-ready pack): the
//     tenant's own copy is the contract body + signature. Keeps ID-card
//     images out of the weakest-credential path.
app.get('/api/contract-fill/:token/pdf', rateLimitContractFill, async (req, res) => {
  const token = String(req.params.token).slice(0, 80);
  const contractInvitation = require('./services/contractInvitation');
  let acquired = false;
  try {
    const raw = await contractInvitation.inspectByToken(pool, token);
    if (!raw) {
      return res.status(404).json({ error: 'ลิงก์นี้ใช้ไม่ได้ — ติดต่อเจ้าของหอพัก', code: 'TOKEN_INVALID' });
    }
    if (raw.status === 'revoked') {
      return res.status(410).json({ error: 'ลิงก์ถูกยกเลิกโดยเจ้าของหอพัก', code: 'REVOKED' });
    }
    if (raw.status === 'expired') {
      return res.status(410).json({ error: 'ลิงก์หมดอายุแล้ว', code: 'EXPIRED' });
    }
    if (raw.status !== 'approved') {
      return res.status(409).json({
        error: 'สัญญายังไม่ได้รับการอนุมัติ — ดาวน์โหลด PDF ได้หลังเจ้าของหอพักอนุมัติ',
        code: 'PDF_NOT_READY',
        status: raw.status,
      });
    }
    if (raw.expires_at && new Date(raw.expires_at).getTime() < Date.now()) {
      return res.status(410).json({
        error: 'ลิงก์หมดอายุแล้ว — เข้าสู่ Tenant Portal (ล็อกอินด้วยเบอร์โทร) เพื่อดาวน์โหลดสัญญา',
        code: 'EXPIRED',
      });
    }
    const fillContractId = Number(raw.contract_id);
    if (!Number.isInteger(fillContractId) || fillContractId < 1) {
      return res.status(404).json({ error: 'ไม่พบสัญญาของลิงก์นี้', code: 'CONTRACT_NOT_FOUND' });
    }

    // Same SELECT shape as /api/tenant/contract/:id/pdf so the renderer gets
    // the fields it expects; 42703 fallback for pre-migration deploys. The
    // WHERE c.id = invitation.contract_id IS the ownership check — the token
    // can only ever reach the one contract it was issued for.
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
        [fillContractId]
      );
      contract = cQ.rows[0] || null;
    } catch (err) {
      if (err.code !== '42703') throw err;
      const cQ = await pool.query(
        `SELECT c.*, t.full_name AS tenant_name, t.phone AS tenant_phone,
                t.email AS tenant_email, t.citizen_id_tail
           FROM contracts c
           LEFT JOIN tenants t ON t.id = c.tenant_id AND t.deleted_at IS NULL
           WHERE c.id=$1 AND c.deleted_at IS NULL`,
        [fillContractId]
      );
      contract = cQ.rows[0] || null;
    }
    if (!contract) {
      return res.status(404).json({ error: 'ไม่พบสัญญาของลิงก์นี้', code: 'CONTRACT_NOT_FOUND' });
    }
    // Approval locks the contract; an unlocked row here means the approval
    // didn't complete — don't serve a PDF whose terms aren't final.
    if (!contract.locked_at) {
      return res.status(409).json({
        error: 'สัญญายังไม่ถูกล็อกเป็นฉบับจริง — ติดต่อเจ้าของหอพัก',
        code: 'NOT_LOCKED',
      });
    }

    // Building info
    let building = { name: 'ที่พักของคุณ' };
    try {
      const cfgQ = await pool.query(
        `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
      );
      const cfg = cfgQ.rows[0]?.value || {};
      if (cfg.building) building = { ...building, ...cfg.building };
    } catch { /* keep default */ }

    // Room enrichment (rooms_v2 → minimal fallback) — same as the portal path.
    let room = { id: contract.room_id };
    if (contract.room_id) {
      try {
        const rv2 = await pool.query(
          `SELECT room_code, room_type, floor, room_no,
                  wifi_fee, view_type, has_balcony, has_parking, has_kitchen, has_ac,
                  size_sqm, bed_count
             FROM rooms_v2 WHERE room_code=$1 AND deleted_at IS NULL LIMIT 1`,
          [contract.room_id]
        );
        if (rv2.rows.length) {
          const r = rv2.rows[0];
          const amenities = [];
          if (r.has_ac)      amenities.push('แอร์');
          if (r.has_balcony) amenities.push('ระเบียง');
          if (r.has_kitchen) amenities.push('ห้องครัว');
          if (r.has_parking) amenities.push('ที่จอดรถ');
          room = {
            id: r.room_code, type: r.room_type, floor: r.floor, roomNo: r.room_no,
            size: r.size_sqm, bedCount: r.bed_count, view: r.view_type,
            amenities, wifiFee: Number(r.wifi_fee || 0),
          };
        }
      } catch (err) {
        if (err.code !== '42P01') console.warn('[fill contract pdf] rooms_v2:', err.message);
      }
    }

    // Template — the locked signing snapshot wins (the PDF must reflect what
    // the tenant agreed to), then the bound template, then the default.
    let template = contract.terms_template_snapshot || null;
    if (!template && contract.template_id) {
      try {
        const t = await pool.query(
          `SELECT mode, clauses, sections, variables FROM contract_templates
            WHERE id=$1 AND deleted_at IS NULL AND enabled=TRUE LIMIT 1`,
          [contract.template_id]
        );
        if (t.rows.length) template = t.rows[0];
      } catch { /* fall through */ }
    }
    if (!template) {
      try {
        const t = await pool.query(
          `SELECT mode, clauses, sections, variables FROM contract_templates
            WHERE is_default=TRUE AND deleted_at IS NULL AND enabled=TRUE LIMIT 1`
        );
        if (t.rows.length) template = t.rows[0];
      } catch { /* pre-migration */ }
    }

    // Online signature embed
    let tenantSigBuf = null;
    if (contract.signature_image_id) {
      try {
        const fQ = await pool.query(
          'SELECT * FROM file_uploads WHERE id=$1 LIMIT 1',
          [contract.signature_image_id]
        );
        if (fQ.rows.length) tenantSigBuf = await storage.readFile(fQ.rows[0]);
      } catch (err) {
        console.warn('[fill contract pdf] sig load failed:', err.message);
      }
    }

    // Financial terms: signing snapshot wins; live config is legacy fallback
    // for v1 snapshots without financials.
    let lateFeeRate = 1.5;
    let dueDay = 15;
    try {
      const flags = await features.load(pool);
      if (Number.isFinite(Number(flags?.lateFee?.ratePctPerMonth))) {
        lateFeeRate = Number(flags.lateFee.ratePctPerMonth);
      }
      const cfgRow = await pool.query(`SELECT value FROM app_data WHERE key='baankarn_config_v1'`);
      const cfg = cfgRow.rows[0]?.value || {};
      if (Number.isFinite(Number(cfg?.notify?.dueOnDay))) {
        dueDay = Number(cfg.notify.dueOnDay);
      }
    } catch { /* keep defaults */ }
    const snapFin = contract.terms_template_snapshot
      && contract.terms_template_snapshot.financials;
    if (snapFin) {
      const snapDueDay = Number(snapFin.dueDay);
      const snapLateFeeRate = Number(snapFin.lateFeeRate);
      if (Number.isFinite(snapDueDay) && snapDueDay >= 1 && snapDueDay <= 28) {
        dueDay = Math.floor(snapDueDay);
      }
      if (Number.isFinite(snapLateFeeRate) && snapLateFeeRate >= 0) {
        lateFeeRate = snapLateFeeRate;
      }
    }

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

    audit(req, 'contract.pdf_view', 'contract', String(contract.id), {
      contractNo: contract.contract_no,
      via: 'contract-fill-token',
      invitationId: raw.id,
      hasSignature: !!tenantSigBuf,
      download: req.query.download === '1',
    }, 'public').catch(() => {});

    await acquirePdfSlot();
    acquired = true;
    const filename = safeDownloadFilename(`contract-${contract.contract_no || contract.id}`, `contract-${contract.id}`, 'pdf');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Disposition',
      `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${filename}"`
    );
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
    console.error('contract-fill pdf error:', err);
    if (!res.headersSent) {
      const code = String(err.message || '').includes('PDF queue timeout') ? 503 : 500;
      res.status(code).json({ error: 'internal error', code: code === 503 ? 'BUSY' : 'PDF_ERROR' });
    } else {
      res.end();
    }
  } finally {
    if (acquired) releasePdfSlot();
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
      `SELECT mode, clauses, sections, variables, created_by, updated_at
         FROM contract_templates
        WHERE is_default=TRUE AND deleted_at IS NULL LIMIT 1`
    );
    if (dr.rows.length) {
      return res.json({
        ok: true,
        template: dr.rows[0],
        defaults: contractPdf.DEFAULT_CLAUSES,
        resolved: contractPdf.resolveClauses(dr.rows[0]),
        // contract_templates tracks created_by + updated_at (no updated_by column).
        updatedBy: dr.rows[0].created_by,
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
    let acquired = false;
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
      let building = { name: 'ที่พักของคุณ' };
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
      if (contract.locked_at && Number.isInteger(queryTemplateId) && queryTemplateId > 0) {
        return res.status(409).json({
          error: 'contract is locked; PDF template override is disabled',
          code: 'CONTRACT_LOCKED',
        });
      }
      const explicitId = (Number.isInteger(queryTemplateId) && queryTemplateId > 0)
        ? queryTemplateId
        : (contract.template_id || null);
      if (contract.locked_at && contract.terms_template_snapshot) {
        template = contract.terms_template_snapshot;
      }
      if (!template && explicitId) {
        // ?templateId=N (admin preview from the templates page) may render a
        // DISABLED template on purpose — that's how admin reviews it before
        // re-enabling. A template merely ASSIGNED to the contract must be
        // enabled, otherwise fall through to the default like the warning
        // system assumes.
        const fromQueryPreview = Number.isInteger(queryTemplateId) && queryTemplateId > 0;
        try {
          const t = await pool.query(
            `SELECT mode, clauses, sections, variables FROM contract_templates
              WHERE id=$1 AND deleted_at IS NULL
                AND (enabled = TRUE OR $2::boolean)
              LIMIT 1`,
            [explicitId, fromQueryPreview]
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
              WHERE is_default=TRUE AND deleted_at IS NULL AND enabled=TRUE LIMIT 1`
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
      // dueDay now lives in config.notify.dueOnDay (single canonical source
      // shared with scheduler + manual billing). See sibling block above.
      let lateFeeRate = 1.5;
      let dueDay = 15;
      try {
        const flags = await features.load(pool);
        if (Number.isFinite(Number(flags?.lateFee?.ratePctPerMonth))) {
          lateFeeRate = Number(flags.lateFee.ratePctPerMonth);
        }
        const cfgRow = await pool.query(`SELECT value FROM app_data WHERE key='baankarn_config_v1'`);
        const cfg = cfgRow.rows[0]?.value || {};
        if (Number.isFinite(Number(cfg?.notify?.dueOnDay))) {
          dueDay = Number(cfg.notify.dueOnDay);
        }
      } catch { /* keep defaults */ }

      // Same invariant as the tenant PDF endpoint: signed/locked contracts
      // render the financial terms captured at signing time, not today's config.
      const snapFin = contract.locked_at
        && contract.terms_template_snapshot
        && contract.terms_template_snapshot.financials;
      if (snapFin) {
        const snapDueDay = Number(snapFin.dueDay);
        const snapLateFeeRate = Number(snapFin.lateFeeRate);
        if (Number.isFinite(snapDueDay) && snapDueDay >= 1 && snapDueDay <= 28) {
          dueDay = Math.floor(snapDueDay);
        }
        if (Number.isFinite(snapLateFeeRate) && snapLateFeeRate >= 0) {
          lateFeeRate = snapLateFeeRate;
        }
      }

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

      // Optional ?docs=1 — append certified-copy pages with the tenant's
      // ID-card images so the printed pack is sign-ready on paper. Image
      // problems NEVER block the contract render: each missing/broken image
      // degrades to an in-PDF note telling the admin to attach a paper copy.
      let identityDocs = null;
      if (req.query.docs === '1') {
        identityDocs = { front: null, back: null, note: null };
        const addNote = (msg) => {
          identityDocs.note = identityDocs.note ? `${identityDocs.note} · ${msg}` : msg;
        };
        try {
          const tQ = contract.tenant_id ? await pool.query(
            `SELECT citizen_id_image_front_id, citizen_id_image_back_id
               FROM tenants WHERE id=$1 AND deleted_at IS NULL`,
            [contract.tenant_id]
          ) : { rows: [] };
          const ids = tQ.rows[0] || {};
          const loadImg = async (fid, label) => {
            if (!fid) return null;
            try {
              const fQ = await pool.query('SELECT * FROM file_uploads WHERE id=$1 LIMIT 1', [fid]);
              if (!fQ.rows.length) throw new Error('ไม่พบไฟล์ในระบบ');
              return await storage.readFile(fQ.rows[0]);
            } catch (err) {
              console.warn(`[contract pdf] identity ${label} load failed:`, err.message);
              addNote(`โหลดรูป${label}ไม่สำเร็จ — โปรดแนบสำเนากระดาษแทน`);
              return null;
            }
          };
          identityDocs.front = await loadImg(ids.citizen_id_image_front_id, 'ด้านหน้าบัตร');
          identityDocs.back = await loadImg(ids.citizen_id_image_back_id, 'ด้านหลังบัตร');
          if (!ids.citizen_id_image_front_id && !ids.citizen_id_image_back_id) {
            addNote('ผู้เช่ายังไม่มีรูปบัตรในระบบ — เติมได้ที่หน้าผู้เช่า ปุ่ม "เติมข้อมูล/อัปโหลดเอกสาร"');
          }
        } catch (err) {
          console.warn('[contract pdf] identity docs lookup failed:', err.message);
          addNote('ดึงข้อมูลรูปบัตรจากระบบไม่สำเร็จ — โปรดแนบสำเนากระดาษแทน');
        }
      }

      audit(req, 'contract.pdf_view', 'contract', String(id), {
        contractNo: contract.contract_no, hasSignature: !!tenantSigBuf,
        download: req.query.download === '1',
        identityDocs: identityDocs
          ? { front: !!identityDocs.front, back: !!identityDocs.back, note: identityDocs.note || null }
          : null,
        templateId: explicitId, roomSource: room.source || 'minimal',
      });

      // ============== 7. Response headers + render ==============
      await acquirePdfSlot();
      acquired = true;
      const filename = safeDownloadFilename(`contract-${contract.contract_no || id}`, `contract-${id}`, 'pdf');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader(
        'Content-Disposition',
        `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${filename}"`
      );

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
          identityDocs,
          lateFeeRate, dueDay,
        },
        res
      );
    } catch (err) {
      console.error('contract pdf error:', err);
      if (!res.headersSent) {
        const code = String(err.message || '').includes('PDF queue timeout') ? 503 : 500;
        res.status(code).json({ error: 'internal error', code: code === 503 ? 'BUSY' : 'PDF_ERROR' });
      }
      else res.end();
    } finally {
      if (acquired) releasePdfSlot();
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
const BACKUP_FILENAME_RE = /^backup-[A-Za-z0-9-]+\.json(\.enc)?$/;
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
    res.setHeader('Content-Type', req.params.filename.endsWith('.enc')
      ? 'application/octet-stream'   // encrypted backup — opaque bytes
      : 'application/json');
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
// JSON parser ONLY on this route, AFTER sameOrigin + CSRF + owner auth, so
// unauthenticated callers cannot force the process to parse a huge body.
const restoreBodyParser = express.json({ limit: '100mb' });
function parseRestoreBody(req, res, next) {
  return restoreBodyParser(req, res, (err) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid json body', code: 'BAD_JSON' });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'restore payload too large (max 100mb)', code: 'RESTORE_TOO_LARGE' });
    }
    return next(err);
  });
}
app.post('/api/admin/restore', sameOrigin, csrfGuard, requireAuth, requireRole('owner'), parseRestoreBody,
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
        // Decrypt-aware: encrypted backups (.json.enc, APENC1 format) are
        // unwrapped with the same key registry that wrote them; plaintext
        // .json files parse as before.
        backup = require('./scripts/backup').readBackupFile(fp);
      } catch (err) {
        return res.status(400).json({
          error: /key|decrypt|auth/i.test(String(err.message))
            ? `backup file is encrypted but cannot be decrypted: ${err.message}`
            : 'backup file is not valid JSON',
        });
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
      'payments', 'parcels', 'access_cards', 'line_bindings',
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
        // Column names are interpolated as quoted identifiers below (they can't
        // be bound as $N params), so they must be real snake_case identifiers.
        // The backup blob is caller-supplied and its integrity hash is optional
        // (absent on legacy dumps, line ~14617), so a crafted key containing a
        // double-quote could break out of "..." and inject SQL. Reject the
        // whole table with a clear message instead of trusting the keys.
        const badCol = cols.find((c) => !/^[a-z_][a-z0-9_]*$/i.test(c));
        if (badCol) {
          stats[t] = { skipped: `invalid column name: ${String(badCol).slice(0, 40)}` };
          errors.push(`${t}: invalid column name in backup — table skipped`);
          continue;
        }
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
        error: 'กู้คืนข้อมูลไม่สำเร็จ ระบบย้อนกลับไปใช้ข้อมูลเดิมแล้ว',
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
    res.json({
      ok: true,
      items: rows.map((row) => ({
        ...row,
        diagnostic: row.last_error ? notifQueue.diagnoseFailure(row) : null,
      })),
    });
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
// /health → public readiness probe. Keep this intentionally small: it is
// unauthenticated and used by load balancers, so detailed queue/scheduler/
// storage/config/secrets diagnostics belong behind /api/admin/health.
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
  let cfgForReadiness = null;

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
    cfgForReadiness = cfg;
    const b = (cfg && cfg.building) || {};
    const missing = [];
    if (!b.name || b.name === 'ที่พักของคุณ') missing.push('building.name (ยังเป็นค่าเริ่มต้น)');
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
    } else if (isDemoTarget(ppDb || ppEnv)) {
      fail('promptpay', 'PromptPay',
        'PromptPay ยังเป็นค่า demo — ห้ามใช้รับเงินจริง',
        'แก้ที่ Settings → การชำระเงิน หรือใส่ PROMPTPAY_TARGET ของบัญชีจริงใน Secrets');
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
      // crypto.js (citizen-ID PII) reads ONLY CITIZEN_ID_KEY, else derives from
      // SESSION_SECRET via HKDF — it never reads ENCRYPTION_KEY_V1 (that feeds
      // the separate secrets/OA-token store in encryption.js). Treating
      // ENCRYPTION_KEY_V1 as covering citizen IDs is a false green: the
      // operator thinks PII is rotation-safe while it's still bound to
      // SESSION_SECRET, so rotating it silently destroys every stored ID.
      val: process.env.CITIZEN_ID_KEY,
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
  const bookingSettingsForReadiness = roomBookingSettings(flags);
  if (bookingSettingsForReadiness.enabled && bookingSettingsForReadiness.requireDeposit) {
    if (bookingSettingsForReadiness.depositAmount > 0 && bookingSettingsForReadiness.depositAmount < 100) {
      fail('booking_deposit_amount', 'Booking deposit',
        `Booking deposit is only ฿${bookingSettingsForReadiness.depositAmount} — this looks like a test value`,
        'Open Booking deposit settings and set the real booking fee/deposit amount before accepting public bookings');
    } else {
      ok('booking_deposit_amount', 'Booking deposit',
        `Booking deposit ฿${bookingSettingsForReadiness.depositAmount}`);
    }
  } else if (bookingSettingsForReadiness.enabled) {
    warn('booking_deposit_amount', 'Booking deposit',
      'Online booking is open without a required deposit',
      'Keep this only if staff intentionally reviews bookings without a paid hold');
  } else {
    ok('booking_deposit_amount', 'Booking deposit', 'Online booking is closed');
  }
  const publicLine = resolvePublicLineContactLinks(cfgForReadiness);
  if (bookingSettingsForReadiness.enabled && !publicLine.configured) {
    warn('booking_line_contact', 'Booking LINE contact',
      'Online booking is open but no public LINE contact link is configured',
      'Set a real LINE add-friend URL in Settings so applicants can follow up after booking');
  } else if (publicLine.configured && looksSuspiciousPublicLineUrl(publicLine.addFriendUrl)) {
    warn('booking_line_contact', 'Booking LINE contact',
      `LINE contact URL looks like a placeholder: ${publicLine.addFriendUrl}`,
      'Replace it with the real LINE Official Account add-friend URL before go-live');
  } else if (publicLine.configured) {
    ok('booking_line_contact', 'Booking LINE contact', 'Public LINE contact link is configured');
  }
  const lateFeeFlag = flags && flags.lateFee ? flags.lateFee : {};
  if (lateFeeFlag.enabled) {
    const rate = Number(lateFeeFlag.ratePctPerMonth);
    if (!Number.isFinite(rate) || rate <= 0) {
      fail('late_fee_rate', 'Late fee policy',
        'เปิดค่าปรับชำระล่าช้าแล้ว แต่อัตราเป็น 0%/เดือน — บิล overdue จะไม่เกิดค่าปรับ',
        'ไปที่ Features → ค่าปรับชำระล่าช้า แล้วตั้งอัตรา %/เดือนให้ตรงนโยบายหอ');
    } else if (Number(lateFeeFlag.maxPctOfPrincipal || 0) <= 0 && Number(lateFeeFlag.maxLateFeeBaht || 0) <= 0) {
      warn('late_fee_cap', 'Late fee policy',
        'ค่าปรับชำระล่าช้าไม่มีเพดานสูงสุด',
        'ถ้านโยบายหอต้องจำกัดยอด ให้ตั้งเพดานเป็น % ของเงินต้นหรือจำนวนบาทที่หน้า Features');
    } else {
      ok('late_fee_policy', 'Late fee policy',
        `rate=${rate}%/month, grace=${Number(lateFeeFlag.gracePeriodDays) || 0} days`);
    }
  } else {
    warn('late_fee_disabled', 'Late fee policy',
      'ปิดค่าปรับชำระล่าช้าอยู่ — บิล overdue จะไม่เพิ่มค่าปรับ',
      'เปิดที่หน้า Features ถ้านโยบายหอต้องเก็บค่าปรับ');
  }
  if (flags.meterIot?.mode === 'simulator') {
    fail('simulator', 'Meter simulator',
      'meterIot.mode = "simulator" — กำลังสร้างค่าเทียมทับมิเตอร์จริง',
      'เปลี่ยนเป็น "manual" ที่หน้า Features — MQTT ยังไม่รองรับใน build นี้');
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
  const uploadStorage = storage.storageStatus();
  if (uploadStorage.s3Configured) {
    ok('upload_storage', 'Upload storage',
      `R2/S3 configured; uploads are not tied to the app container disk`);
  } else if (NODE_ENV === 'production' && !uploadStorage.hasExplicitUploadDir) {
    fail('upload_storage', 'Upload storage',
      'ไฟล์สัญญา/ลายเซ็น/บัตรประชาชนจะเก็บบน local disk ของ container และอาจหายเมื่อ redeploy',
      'ตั้งค่า R2_* ที่ Settings → Secrets หรือกำหนด UPLOAD_DIR ไปยัง persistent volume ก่อนใช้งานจริง');
  } else if (uploadStorage.hasExplicitUploadDir) {
    warn('upload_storage', 'Upload storage',
      `ใช้ local UPLOAD_DIR=${uploadStorage.uploadRoot}`,
      'ยืนยันว่า path นี้เป็น persistent volume และ backup โฟลเดอร์ uploads คู่กับ DB');
  } else {
    warn('upload_storage', 'Upload storage',
      'ใช้ local ./uploads เหมาะกับ dev เท่านั้น',
      'production ควรใช้ R2/S3 หรือ persistent UPLOAD_DIR');
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

  // 8. Cross-store / payment data integrity. These are real-use blockers:
  // rooms_v2 empty makes /api/rooms lie, and payable bills without tenant_id
  // cannot be paid from the tenant portal by design.
  try {
    const d = await pool.query(`
      SELECT
        COALESCE((
          SELECT COUNT(*)::int
            FROM app_data ad
            CROSS JOIN LATERAL jsonb_object_keys(
              CASE WHEN jsonb_typeof(ad.value)='object' THEN ad.value ELSE '{}'::jsonb END
            ) AS k(room_code)
           WHERE ad.key='baankarn_rooms_v1'
        ), 0)::int AS legacy_rooms,
        (SELECT COUNT(*)::int FROM rooms_v2 WHERE deleted_at IS NULL) AS rooms_v2,
        (SELECT COUNT(*)::int FROM bills
          WHERE deleted_at IS NULL
            AND status IN ('pending','overdue')
            AND tenant_id IS NULL) AS orphan_payable_bills,
        (SELECT COUNT(*)::int FROM tenants
          WHERE deleted_at IS NULL
            AND status='active'
            AND (current_room_id IS NULL OR current_room_id='')) AS active_tenants_without_room,
        (SELECT COUNT(*)::int FROM contracts
          WHERE deleted_at IS NULL
            AND status='active'
            AND monthly_rent > 0
            AND monthly_rent < $1::numeric) AS active_contract_low_rent,
        (SELECT COUNT(*)::int FROM contracts
          WHERE deleted_at IS NULL
            AND status='active'
            AND signed_at IS NOT NULL
            AND locked_at IS NULL) AS signed_unlocked_contracts,
        (SELECT COUNT(*)::int FROM notifications_queue WHERE status='failed') AS failed_notifications`,
      [pricing.MIN_SENSIBLE_CONTRACT_RENT]
    );
    const x = d.rows[0] || {};
    if (Number(x.legacy_rooms) > 0 && Number(x.rooms_v2) === 0) {
      fail('rooms_sync', 'Rooms sync',
        `${x.legacy_rooms} legacy rooms exist but rooms_v2 is empty`,
        'Run scripts/sync-rooms-v2-from-jsonb.js --apply, or POST /api/rooms/migrate-from-jsonb as owner');
    } else {
      ok('rooms_sync', 'Rooms sync', `${x.legacy_rooms || 0} legacy rooms · ${x.rooms_v2 || 0} rooms_v2`);
    }
    if (Number(x.orphan_payable_bills) > 0) {
      warn('orphan_bills', 'Bill ownership',
        `${x.orphan_payable_bills} payable bills have tenant_id=NULL; tenant payments are blocked for them`,
        'Reconcile tenant.current_room_id / rooms blob first, then link only unambiguous bills');
    } else {
      ok('orphan_bills', 'Bill ownership', 'No payable orphan bills');
    }
    if (Number(x.active_tenants_without_room) > 0) {
      fail('active_tenant_room', 'Tenant room assignment',
        `${x.active_tenants_without_room} active tenants have no current_room_id`,
        'Open /admin#tenants, assign the correct room or run checkout/reconcile so tenant portal and billing can target the right room');
    } else {
      ok('active_tenant_room', 'Tenant room assignment', 'Every active tenant has a room');
    }
    if (Number(x.active_contract_low_rent) > 0) {
      fail('contract_rent_guard', 'Contract rent sanity',
        `${x.active_contract_low_rent} active contracts have monthly_rent below ฿${pricing.MIN_SENSIBLE_CONTRACT_RENT}`,
        'Create corrected contracts or migrate the rows deliberately with force only after confirming the signed amount');
    } else {
      ok('contract_rent_guard', 'Contract rent sanity', 'No active contracts below the rent floor');
    }
    if (Number(x.signed_unlocked_contracts) > 0) {
      warn('signed_unlocked_contracts', 'Contract approval state',
        `${x.signed_unlocked_contracts} active contracts are signed but not locked`,
        'Approve, reject, or expire the invitation so the legal snapshot and room state stop drifting');
    } else {
      ok('signed_unlocked_contracts', 'Contract approval state', 'No signed-but-unlocked contracts');
    }
    if (Number(x.failed_notifications) > 50) {
      warn('notification_backlog', 'Notification backlog',
        `${x.failed_notifications} failed notifications in queue`,
        'Check LINE/Email/SMS secrets, then retry or let the pruner remove old failures');
    } else {
      ok('notification_backlog', 'Notification backlog', `${x.failed_notifications || 0} failed notifications`);
    }
  } catch (err) {
    warn('data_integrity_read', 'Data integrity', err.message);
  }

  // 9. Current subsystem health must be clean before go-live. Keep the
  // detailed report in /api/admin/health, but make readiness fail loudly when
  // any health check is currently in error.
  try {
    const healthCheck = require('./services/healthCheck');
    const report = await healthCheck.runChecks(pool);
    const healthChecks = Array.isArray(report.checks) ? report.checks : [];
    const errors = healthChecks.filter((c) => c.status === 'error');
    const warnings = healthChecks.filter((c) => c.status === 'warn');
    if (errors.length) {
      fail('admin_health_errors', 'Current health',
        `${errors.length} health check(s) are currently error: ${errors.slice(0, 4).map((c) => c.id).join(', ')}`,
        'Open /admin#health and resolve error checks before production launch');
    } else if (warnings.length) {
      warn('admin_health_warnings', 'Current health',
        `${warnings.length} health check warning(s): ${warnings.slice(0, 4).map((c) => c.id).join(', ')}`,
        'Review /admin#health; warnings may be acceptable only with an explicit operating decision');
    } else {
      ok('admin_health', 'Current health', 'All health checks are ok');
    }
  } catch (err) {
    warn('admin_health_read', 'Current health', `Health check failed: ${err.message}`);
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

// Anomaly scan — data-level "this looks wrong" report grouped by domain
// (pricing, bill, tenant, contract, room, payment, utility). Read-only,
// fail-soft per detector so one bad query doesn't blank the whole report.
// Companion to /api/admin/health: health probes are about subsystems
// (DB, LINE, SMTP, etc.); anomalies are about the DATA inside them
// (typo'd rent, orphan tenant, stuck slip, expired contract still active).
//
// Each item has a stable `id` code admin UI can use for filter / dedup
// across scans, plus a Thai `message` for the badge and `fix` hint
// pointing at the admin page that can resolve it.
app.get('/api/admin/anomalies', requireAuth, requireRole('owner', 'manager'), async (_req, res) => {
  try {
    const anomalyScanner = require('./services/anomalyScanner');
    const report = await anomalyScanner.scan(pool);
    res.json({ ok: true, ...report });
  } catch (err) {
    console.error('admin anomalies error:', err.message);
    res.status(500).json({ ok: false, error: 'anomaly scan failed', message: err.message });
  }
});

// Returns 200 when db is reachable, 503 when degraded so Railway/upstream
// LBs can route around bad replicas. It must not leak operational internals.
app.get('/health', async (_req, res) => {
  const out = {
    status: 'ok',
    time: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
  };
  // DB probe with timing
  const t0 = Date.now();
  try {
    await pool.query('SELECT 1');
    out.db = { status: 'ok', latency_ms: Date.now() - t0 };
  } catch (err) {
    out.status = 'degraded';
    console.warn('[health] DB readiness probe failed:', sanitizeError(err));
    out.db = { status: 'down' };
  }

  res.status(out.status === 'ok' ? 200 : 503).json(out);
});

// /health/live → minimal probe for Kubernetes-style liveness checks.
// No DB call — server is "alive" if Node is responsive.
app.get('/health/live', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// --- Static + routes ------------------------------------------------------
// Asset caching policy:
//   - .jsx (transpiled in browser, changes every deploy) → no-cache so the
//     browser may keep a local copy but must revalidate before use. This
//     preserves fast fixes while allowing 304 responses instead of
//     redownloading megabytes of admin JSX on every reload.
//   - Other static assets (fonts, images) → 1h TTL since they rarely change.
app.use((req, res, next) => {
  const rawPath = String((req.originalUrl || req.url || '').split('?')[0] || '/');
  const protectedAdminStatic = adminConsoleProbePath(rawPath) || adminStaticShellPath(rawPath);
  if (!protectedAdminStatic) return next();
  if (req.session && req.session.user) return next();
  recordSecurityEvent(req, 'security.admin_route_probe', {
    reason: rawPath.startsWith('/admin/') || adminStaticShellPath(rawPath)
      ? 'unauthenticated_admin_static_or_route'
      : 'guessed_admin_console_path',
    path: rawPath.slice(0, 500),
  });
  return sendSecurityHtml(req, res, 401);
});
app.use((req, res, next) => {
  if (/\.jsx$/i.test(req.path)) {
    // Revalidate on every reload, but do not block the browser from storing
    // the file. `no-store` forced a full transfer every time and made the
    // Babel-in-browser boot path much slower than necessary.
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  } else if (/\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ttf)$/i.test(req.path)) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'project'), { redirect: false }));

// Files proxy. Sensitive uploads stay auth-gated; room_photo/building_logo are
// deliberately public because public pages need to render them. Keep every category behind this proxy instead
// of mounting uploads/ directly so scanning, MIME headers, and caching remain
// centralized.
storage.ensureDir(storage.rootPath());
app.get('/files/:id', rateLimitFileAccess, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    recordSecurityEvent(req, 'security.file_guess_miss', {
      reason: 'invalid_file_id',
      fileId: String(req.params.id || '').slice(0, 80),
    });
    return sendSecurityText(res, 400);
  }
  try {
    const { rows } = await pool.query(
      'SELECT category, ref_id, filename, mime_type, uploaded_by, storage FROM file_uploads WHERE id=$1',
      [id]
    );
    if (!rows.length) {
      recordSecurityEvent(req, 'security.file_guess_miss', {
        reason: 'missing_file_id',
        fileId: id,
      });
      return sendSecurityText(res, 404);
    }
    const f = rows[0];
    // PII files (citizen-ID scans, payment slips, contract signatures) must NOT
    // be readable by every admin session — only owner/manager (or the tenant who
    // owns the file). A readonly/staff admin may browse tenants but must not pull
    // the raw ID-card images / slips. File IDs are sequential & enumerable, so
    // this role gate is the only thing between a low-privilege admin and bulk PII
    // download. Non-sensitive files (room photos + building logo) stay broadly readable.
    const SENSITIVE_CATEGORIES = new Set(['slip', 'citizen_id_image', 'contract_signature']);
    const sensitive = SENSITIVE_CATEGORIES.has(f.category);
    const PUBLIC_FILE_CATEGORIES = new Set(['room_photo', 'building_logo']);
    const isPublicAsset = PUBLIC_FILE_CATEGORIES.has(f.category);
    const isPublicRoomPhoto = f.category === 'room_photo';
    const isPublicBuildingLogo = isPublicAsset && f.category === 'building_logo';
    const sessionRole = req.session && req.session.user && req.session.user.role;
    const isAdmin = !!(req.session && req.session.user);
    const isManagerPlus = (ROLE_RANK[sessionRole] || 0) >= ROLE_RANK.manager;
    let allowed = isPublicRoomPhoto || (isAdmin && (!sensitive || isManagerPlus));
    if (!allowed && isPublicBuildingLogo) allowed = true;
    // Session lookup is a DB round-trip — resolve it at most ONCE per request
    // even when both tenant checks below run (parcel_photo + own-upload).
    let tSession = null;
    let tSessionChecked = false;
    const loadTenantSession = async () => {
      if (!tSessionChecked) {
        tSession = await tenantSessionLookup(req);
        tSessionChecked = true;
      }
      return tSession;
    };
    if (!allowed && f.category === 'parcel_photo') {
      await loadTenantSession();
      const parcelRefId = Number(f.ref_id);
      if (tSession && Number.isInteger(parcelRefId) && parcelRefId > 0) {
        const ownParcel = await pool.query(
          `SELECT 1
             FROM parcels
            WHERE id=$1
              AND tenant_id=$2
              AND deleted_at IS NULL
            LIMIT 1`,
          [parcelRefId, tSession.tenant_id]
        );
        if (ownParcel.rows.length) allowed = true;
      }
    }
    if (!allowed) {
      // Tenant: allow only own uploads (uploaded_by === 'tenant:<id>')
      await loadTenantSession();
      if (tSession && f.uploaded_by === `tenant:${tSession.tenant_id}`) allowed = true;
    }
    if (!allowed) {
      recordSecurityEvent(req, 'security.file_access_denied', {
        fileId: id,
        category: f.category,
        uploadedBy: f.uploaded_by,
        tenantId: tSession ? tSession.tenant_id : null,
      });
      return sendSecurityText(res, 403);
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Vary', 'Cookie');
    // Sensitive PII categories must not be cached on disk — Cache-Control:
    // no-store keeps slips and citizen-ID images out of the browser cache so
    // they're not recoverable after logout. room_photo is non-sensitive and
    // can keep a short private cache for SPA performance.
    if (sensitive) {
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
    const buf = await storage.readFile(f);
    if (!buf) return res.status(404).end();
    return res.end(buf);
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
  const isAdminApiProbe = /^\/api\/admin(?:\/|$)/i.test(String(req.originalUrl || req.url || ''));
  recordSecurityEvent(req, isAdminApiProbe ? 'security.admin_route_probe' : 'security.api_unknown_route', {
    reason: isAdminApiProbe ? 'unknown_admin_api_route' : 'unknown_api_route',
    path: req.originalUrl || req.url,
  });
  applySecurityWarning(res);
  res.status(404).json({
    ...securityWarningBody('route not found', 'NOT_FOUND'),
    requestId: req.id,
    path: req.path,
    method: req.method,
  });
});

app.use((req, res) => {
  if (adminConsoleProbePath(req.originalUrl || req.url)) {
    recordSecurityEvent(req, 'security.admin_route_probe', {
      reason: 'unknown_admin_console_route',
      path: req.originalUrl || req.url,
    });
    return sendSecurityHtml(req, res, 404);
  }
  if (suspiciousUnknownPath(req.originalUrl || req.url)) {
    recordSecurityEvent(req, 'security.public_unknown_route', {
      reason: 'suspicious_unknown_route',
      path: req.originalUrl || req.url,
    });
    return sendSecurityText(res, 404);
  }
  res.status(404).type('text/plain').send('not found');
});

// --- Boot -----------------------------------------------------------------
// Background job: prune time-bounded tables hourly. Each retention window
// is independent so we can age out audit aggressively while keeping
// notifications shorter.
let _prunerInterval = null;
let _bookingHoldInterval = null;
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
             AND NOT EXISTS (
               SELECT 1 FROM bookings b
                WHERE b.deposit_slip_file_id = file_uploads.id
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

function startBookingHoldSweeper() {
  const sweep = async () => {
    const out = await releaseExpiredPublicBookingHolds(pool);
    if (out.released && out.released.length) {
      console.log(`[booking-hold] released expired holds: ${out.released.join(',')}`);
    }
  };
  sweep();
  _bookingHoldInterval = setInterval(sweep, 60 * 1000);
  _bookingHoldInterval.unref();
}

function stopBookingHoldSweeper() {
  if (_bookingHoldInterval) clearInterval(_bookingHoldInterval);
  _bookingHoldInterval = null;
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
        // Canary check: detects the operator-overwrite-V1 hazard that the
        // sync round-trip can't see. validateAtBoot() encrypts+decrypts with
        // the SAME current key; if V1 was rotated to a brand-new 32-byte value
        // (instead of adding V2), it still passes the round-trip while every
        // existing ciphertext silently becomes unreadable. The canary stores
        // a known plaintext at first boot and re-decrypts on every subsequent
        // boot, catching the rotation mistake before the first user write
        // surfaces it as a "decrypt failed" log for every secret column.
        try {
          const canary = await enc.validateCanary(pool);
          if (!canary.ok) {
            console.error('[boot] encryption canary failed:', canary.reason);
            if (NODE_ENV === 'production') {
              console.error('[boot] refusing to start: encryption keys were rotated incorrectly');
              process.exit(1);
            }
          } else if (canary.mode === 'created') {
            console.log('[boot] encryption canary: created (first run)');
          } else if (canary.mode === 'verified') {
            console.log(`[boot] encryption canary: verified (v${canary.version})`);
          }
        } catch (canaryErr) {
          console.warn('[boot] encryption canary check skipped:', canaryErr.message);
        }
        // Citizen-ID PII canary. The check above only covers the versioned
        // ENCRYPTION_KEY_V* registry; citizen IDs are keyed separately by
        // services/crypto.js (CITIZEN_ID_KEY or HKDF(SESSION_SECRET)). Without
        // this, rotating SESSION_SECRET silently makes every citizen_id_encrypted
        // undecryptable while boot reports green. Gated on the feature flag so a
        // deploy that never enabled it isn't forced to resolve a PII key.
        // Deliberately NON-fatal (unlike the registry canary's process.exit):
        // a PII-display fault must not take rent/billing offline — but it is now
        // surfaced loudly instead of failing silently.
        try {
          const encFlags = await features.load(pool);
          if (encFlags && encFlags.citizenIdEncryption && encFlags.citizenIdEncryption.enabled) {
            const piiCanary = await enc.validateCitizenIdCanary(pool);
            if (!piiCanary.ok) {
              console.error('[boot] 🔴 CITIZEN-ID PII CANARY FAILED:', piiCanary.reason);
              console.error('[boot] Remedy: if SESSION_SECRET was rotated, pin the PREVIOUS derived key as '
                + 'CITIZEN_ID_KEY (see services/crypto.js startup warning for the exact one-liner). '
                + 'The app will keep serving; citizen-id reveal + dedup stay broken until the key is restored.');
            } else if (piiCanary.mode === 'created') {
              console.log('[boot] citizen-id PII canary: created (first run)');
            } else if (piiCanary.mode === 'verified') {
              console.log('[boot] citizen-id PII canary: verified');
            } else if (piiCanary.mode === 'no-key') {
              console.warn('[boot] citizen-id PII canary skipped: no resolvable PII key —', piiCanary.reason);
            }
          }
        } catch (piiErr) {
          console.warn('[boot] citizen-id PII canary check skipped:', piiErr.message);
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
        const ppTarget = ppDb || sec.get('PROMPTPAY_TARGET');
        if (!ppTarget) {
          issues.push('🔴 PROMPTPAY_TARGET ยังไม่ตั้ง — บิล PDF จะไม่มี QR');
        } else if (isDemoTarget(ppTarget)) {
          issues.push('🔴 PROMPTPAY_TARGET ยังเป็นค่า demo — ห้ามใช้รับเงินจริง');
        }
        if (!process.env.PUBLIC_URL && !process.env.RAILWAY_PUBLIC_DOMAIN) {
          issues.push('🔴 PUBLIC_URL/RAILWAY_PUBLIC_DOMAIN ยังไม่ตั้ง — บิลแจ้งเตือน LINE จะไม่มี QR/ปุ่มจ่าย (ตกเป็นข้อความล้วน)');
        }
        const ownersQ = await pool.query(`SELECT COUNT(*)::int n, MIN(username) u FROM auth_users WHERE role='owner'`);
        const oc = ownersQ.rows[0];
        if (oc.n === 0) issues.push('🔴 ไม่มี owner — ระบบล็อกตัวเอง');
        else if (oc.n === 1 && oc.u === 'admin') {
          issues.push('🟡 มี owner คนเดียว (default username "admin") — แนะนำสร้างคนที่สอง');
        }
        // Pricing config sanity — surface broken rate values (typo
        // rate=1 etc.) at boot so admin sees it on every restart, not
        // only when they navigate to /admin#health. Doesn't block boot;
        // the resolver's contract-lock still protects existing tenants,
        // and admin can fix via /admin#pricing.
        try {
          const MIN_RENT = 100;
          const rates = (cfg && cfg.rates) || {};
          for (const [type, r] of Object.entries(rates)) {
            if (!r || typeof r !== 'object') continue;
            const rent = Number(r.rent);
            if (Number.isFinite(rent) && rent > 0 && rent < MIN_RENT) {
              issues.push(`🔴 rates.${type}.rent=${rent} (น่าจะพิมพ์ผิด — แก้ที่ /admin#pricing)`);
            }
          }
          const u = (cfg && cfg.utilities) || {};
          if (Number(u.waterRate) === 0 || u.waterRate == null) {
            issues.push('🟡 utilities.waterRate ไม่ได้ตั้ง — บิลค่าน้ำจะเป็น 0');
          }
          if (Number(u.elecRate) === 0 || u.elecRate == null) {
            issues.push('🟡 utilities.elecRate ไม่ได้ตั้ง — บิลค่าไฟจะเป็น 0');
          }
        } catch { /* defensive: don't block boot on parse errors */ }
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
      startBookingHoldSweeper();
      scheduler.start(pool);
      notifQueue.start(pool, () => features.load(pool));
    }

    // Graceful shutdown: drain in-flight requests before closing the DB pool
    // so Railway restarts don't kill mid-request work.
    const shutdown = (signal) => {
      console.log(`[server] ${signal} received, shutting down gracefully`);
      // Cancel the background pruner so its DELETE doesn't race with pool.end()
      stopAuditPruner();
      stopBookingHoldSweeper();
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
