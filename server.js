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

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-change-me';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set');
  process.exit(1);
}

// Railway-internal Postgres URLs are plain TCP; external ones use SSL.
// Heuristic: enable SSL only when the host isn't .railway.internal.
const useSSL = !/\.railway\.internal/i.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  max: 10,
});

pool.on('error', (err) => console.error('Postgres pool error:', err));

// --- Schema migration -----------------------------------------------------
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_data (
      key         TEXT PRIMARY KEY,
      value       JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by  TEXT
    );
    CREATE TABLE IF NOT EXISTS auth_users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'admin',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_sessions (
      sid    VARCHAR NOT NULL PRIMARY KEY,
      sess   JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expire ON user_sessions(expire);

    -- Maintenance tickets (Phase A4)
    CREATE TABLE IF NOT EXISTS maintenance_tickets (
      id              BIGSERIAL PRIMARY KEY,
      ticket_no       TEXT UNIQUE NOT NULL,
      room_id         TEXT NOT NULL,
      tenant_name     TEXT,
      tenant_phone    TEXT,
      category        TEXT NOT NULL,
      priority        TEXT NOT NULL DEFAULT 'medium',
      status          TEXT NOT NULL DEFAULT 'open',
      title           TEXT NOT NULL,
      description     TEXT,
      assigned_to     TEXT,
      scheduled_at    TIMESTAMPTZ,
      completed_at    TIMESTAMPTZ,
      rating          SMALLINT,
      rating_comment  TEXT,
      cost            NUMERIC(10,2) DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON maintenance_tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_room ON maintenance_tickets(room_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_created ON maintenance_tickets(created_at DESC);

    -- Audit log (Phase B1)
    CREATE TABLE IF NOT EXISTS audit_logs (
      id          BIGSERIAL PRIMARY KEY,
      user_id     TEXT,
      action      TEXT NOT NULL,
      entity_type TEXT,
      entity_id   TEXT,
      detail      JSONB,
      ip          TEXT,
      ua          TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
  `);
  console.log('[db] schema ready');

  // Bootstrap admin user (idempotent — only inserts if missing)
  const { rows } = await pool.query(
    'SELECT id FROM auth_users WHERE username=$1',
    [ADMIN_USERNAME]
  );
  if (rows.length === 0) {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await pool.query(
      'INSERT INTO auth_users (username, password_hash, role) VALUES ($1,$2,$3)',
      [ADMIN_USERNAME, hash, 'admin']
    );
    console.log(`[db] bootstrapped admin user: ${ADMIN_USERNAME}`);
  }
}

// --- App setup ------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));

// Security headers. CSP is permissive for the React-via-CDN + Babel-standalone
// approach this app uses today; tighten when migrating to a build pipeline.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://unpkg.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,  // unpkg / Google Fonts can't ship COEP headers
}));

// Rate-limit login attempts per IP — 10 per 15 minutes is plenty for humans
// while frustrating brute-force scripts.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many login attempts, try again later' },
});

app.use(
  session({
    store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: false }),
    secret: SESSION_SECRET,
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
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// --- Audit log helper (Phase B1) ------------------------------------------
// Fire-and-forget insert. Never throws back to caller — audit failures must
// not break the user's request.
async function audit(req, action, entityType, entityId, detail) {
  try {
    const userId = req.session && req.session.user ? req.session.user.username : null;
    const ip = req.ip || req.headers['x-forwarded-for'] || null;
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
// Beyond cookie SameSite=lax, ensure state-changing requests originate from
// our own domain by checking Origin/Referer against the request host.
function sameOrigin(req, res, next) {
  const origin = req.get('origin') || req.get('referer') || '';
  // Empty Origin/Referer is OK only for same-origin (e.g. fetch w/o Origin).
  // We'll only block requests with a mismatched Origin/Referer.
  if (!origin) return next();
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

// --- Auth endpoints -------------------------------------------------------
app.post('/api/auth/login', sameOrigin, loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, username, password_hash, role FROM auth_users WHERE username=$1',
      [username]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'invalid credentials' });
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });
    req.session.user = { id: user.id, username: user.username, role: user.role };
    audit(req, 'auth.login', 'user', String(user.id));
    res.json({ user: req.session.user });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/auth/logout', sameOrigin, (req, res) => {
  const username = req.session && req.session.user ? req.session.user.username : null;
  if (username) audit(req, 'auth.logout', 'user', username);
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.session && req.session.user ? req.session.user : null });
});

// --- Data endpoints (JSONB key-value store) -------------------------------
// Whitelist of allowed keys to prevent abuse
const ALLOWED_KEYS = new Set([
  'baankarn_rooms_v1',
  'baankarn_config_v1',
  'baankarn_bookings_v1',
  'baankarn_activities_v1',
  'baankarn_users_v1',
]);

app.get('/api/data/:key', async (req, res) => {
  const key = req.params.key;
  if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: 'invalid key' });
  try {
    const { rows } = await pool.query('SELECT value FROM app_data WHERE key=$1', [key]);
    res.json({ key, value: rows.length ? rows[0].value : null });
  } catch (err) {
    console.error('data GET error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/data', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT key, value FROM app_data WHERE key = ANY($1)',
      [Array.from(ALLOWED_KEYS)]
    );
    const out = {};
    rows.forEach((r) => { out[r.key] = r.value; });
    res.json(out);
  } catch (err) {
    console.error('data GET-all error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.put('/api/data/:key', sameOrigin, requireAuth, async (req, res) => {
  const key = req.params.key;
  if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: 'invalid key' });
  const value = req.body && req.body.value !== undefined ? req.body.value : req.body;
  // Reject null/undefined writes (use DELETE instead) — prevents the "row exists
  // with value null" footgun where the next hydrate finds null and seeds again.
  if (value === null || value === undefined) {
    return res.status(400).json({ error: 'use DELETE to remove a key' });
  }
  try {
    await pool.query(
      `INSERT INTO app_data (key, value, updated_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_at = NOW(),
             updated_by = EXCLUDED.updated_by`,
      [key, value, req.session.user.username]
    );
    audit(req, 'data.put', 'app_data', key);
    res.json({ ok: true, key });
  } catch (err) {
    console.error('data PUT error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.delete('/api/data/:key', sameOrigin, requireAuth, async (req, res) => {
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

// Public endpoint for tenant booking submissions (rate-limited via IP basic gate)
const bookingHits = new Map();
function rateLimitBooking(req, res, next) {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  const arr = (bookingHits.get(ip) || []).filter((t) => now - t < 60_000);
  if (arr.length >= 5) return res.status(429).json({ error: 'too many requests' });
  arr.push(now);
  bookingHits.set(ip, arr);
  next();
}

app.post('/api/bookings/public', sameOrigin, rateLimitBooking, async (req, res) => {
  const b = req.body || {};
  if (!b.roomId || !b.tenantName) {
    return res.status(400).json({ error: 'roomId and tenantName required' });
  }
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
  try {
    const { rows } = await pool.query(
      'SELECT value FROM app_data WHERE key=$1',
      ['baankarn_bookings_v1']
    );
    const list = (rows.length && Array.isArray(rows[0].value)) ? rows[0].value : [];
    const newBooking = {
      id: 'b' + Date.now(),
      ...cleaned,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    list.unshift(newBooking);
    await pool.query(
      `INSERT INTO app_data (key, value, updated_by) VALUES ($1, $2, 'public')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = 'public'`,
      ['baankarn_bookings_v1', JSON.stringify(list)]
    );

    // Fire-and-forget LINE notification to owner. Don't await/block: response
    // ships immediately, the push runs on the event loop. Failures are caught
    // and logged inside the service.
    lineNotify
      .notifyOwner(
        `📋 ผู้เช่าใหม่ขอจอง\nชื่อ: ${cleaned.tenantName}\nโทร: ${cleaned.phone || '-'}\nห้อง: ${cleaned.roomId}\nวันเข้าพัก: ${cleaned.checkInDate || '-'}\nรหัสการจอง: ${newBooking.id}`
      )
      .catch(() => {});

    res.json({ ok: true, booking: newBooking });
  } catch (err) {
    console.error('public booking error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /api/notify/bill — admin-auth. Trigger a LINE notification for a bill
// the admin just sent. Body: { tenantName, roomId, period, total, billNo,
// recipientUserId? } — if recipientUserId omitted, falls back to LINE_OWNER_USER_ID.
app.post('/api/notify/bill', sameOrigin, requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.tenantName || !b.total) {
    return res.status(400).json({ error: 'tenantName and total required' });
  }
  const recipient = b.recipientUserId || process.env.LINE_OWNER_USER_ID;
  if (!recipient) return res.status(400).json({ error: 'no LINE recipient configured' });
  if (!lineNotify.isConfigured()) {
    return res.status(503).json({ error: 'LINE not configured on server' });
  }
  const text = [
    `💰 ออกบิลใหม่`,
    `ผู้เช่า: ${b.tenantName}`,
    b.roomId ? `ห้อง: ${b.roomId}` : null,
    b.period ? `รอบบิล: ${b.period}` : null,
    `จำนวน: ฿${Number(b.total).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    b.billNo ? `เลขที่: ${b.billNo}` : null,
  ].filter(Boolean).join('\n');
  const ok = await lineNotify.pushText(recipient, text);
  res.json({ ok });
});

// --- Bills: PDF rendering + PromptPay QR ----------------------------------
// POST /api/bills/render — admin-authenticated. Body is a bill object built
// client-side from rooms+config; server renders Thai-language PDF with QR
// embedded. We don't persist bills server-side (they're computed on demand
// from rooms+config in the admin UI), so the body carries everything needed.
app.post('/api/bills/render', sameOrigin, requireAuth, async (req, res) => {
  const bill = req.body && req.body.bill ? req.body.bill : req.body;
  if (!bill || !bill.tenantName || !bill.total) {
    return res.status(400).json({ error: 'bill.tenantName and bill.total required' });
  }
  // Fall back to PROMPTPAY_TARGET env var if the client didn't send one.
  // Lets ops configure the QR target without touching the admin UI.
  if (!bill.promptpayTarget && process.env.PROMPTPAY_TARGET) {
    bill.promptpayTarget = process.env.PROMPTPAY_TARGET;
  }
  try {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="bill-${(bill.billNo || 'invoice').replace(/[^A-Za-z0-9_-]/g, '')}.pdf"`
    );
    await renderBillPdf(bill, res);
  } catch (err) {
    console.error('bill render error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'pdf render failed' });
  }
});

// GET /api/promptpay/qr?target=<phone-or-citizen-id>&amount=<thb>&format=png|json
// Public for now (rate-limited indirectly via session middleware overhead);
// in practice the only callers are admin/tenant pages already inside the app.
app.get('/api/promptpay/qr', async (req, res) => {
  const target = String(req.query.target || '').trim();
  const amountRaw = req.query.amount;
  const amount = amountRaw != null && amountRaw !== '' ? Number(amountRaw) : undefined;
  const format = req.query.format === 'json' ? 'json' : 'png';
  if (!target) return res.status(400).json({ error: 'target required' });
  if (amount != null && (!Number.isFinite(amount) || amount < 0)) {
    return res.status(400).json({ error: 'invalid amount' });
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

const ticketHits = new Map();
function rateLimitTicket(req, res, next) {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  const arr = (ticketHits.get(ip) || []).filter((t) => now - t < 60_000);
  if (arr.length >= 5) return res.status(429).json({ error: 'too many requests' });
  arr.push(now);
  ticketHits.set(ip, arr);
  next();
}

function makeTicketNo() {
  const d = new Date();
  const y = d.getFullYear().toString().slice(-2);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const seq = String(d.getTime()).slice(-5);
  return `MT${y}${m}-${seq}`;
}

// POST /api/maintenance — public (tenant submits). Rate-limited.
app.post('/api/maintenance', sameOrigin, rateLimitTicket, async (req, res) => {
  const b = req.body || {};
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const cleaned = {
    room_id:      str(b.roomId, 32),
    tenant_name:  str(b.tenantName, 120),
    tenant_phone: str(b.tenantPhone, 32),
    category:     str(b.category, 32),
    priority:     str(b.priority, 16) || 'medium',
    title:        str(b.title, 200),
    description:  str(b.description, 2000),
  };
  if (!cleaned.room_id || !cleaned.title || !cleaned.category) {
    return res.status(400).json({ error: 'roomId, title and category required' });
  }
  if (!VALID_TICKET_CATEGORY.has(cleaned.category)) {
    return res.status(400).json({ error: 'invalid category' });
  }
  if (!VALID_TICKET_PRIORITY.has(cleaned.priority)) {
    return res.status(400).json({ error: 'invalid priority' });
  }
  const ticketNo = makeTicketNo();
  try {
    const { rows } = await pool.query(
      `INSERT INTO maintenance_tickets
        (ticket_no, room_id, tenant_name, tenant_phone, category, priority, title, description)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *`,
      [ticketNo, cleaned.room_id, cleaned.tenant_name, cleaned.tenant_phone,
       cleaned.category, cleaned.priority, cleaned.title, cleaned.description]
    );
    const ticket = rows[0];
    // Fire-and-forget LINE notify to owner
    lineNotify
      .notifyOwner(
        `🛠 แจ้งซ่อมใหม่ (${ticket.priority})\n` +
        `เลขที่: ${ticket.ticket_no}\n` +
        `ห้อง: ${ticket.room_id} (${ticket.tenant_name || '-'})\n` +
        `หมวด: ${ticket.category}\n` +
        `เรื่อง: ${ticket.title}`
      )
      .catch(() => {});
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
app.get('/api/maintenance/lookup', async (req, res) => {
  const phone = String(req.query.phone || '').trim().slice(0, 32);
  const roomId = String(req.query.roomId || '').trim().slice(0, 32);
  if (!phone || !roomId) {
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
app.put('/api/maintenance/:id', sameOrigin, requireAuth, async (req, res) => {
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
    res.json({ ok: true, ticket: rows[0] });
  } catch (err) {
    console.error('ticket update error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /api/maintenance/:id/rate — public, requires matching phone.
app.post('/api/maintenance/:id/rate', sameOrigin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  const b = req.body || {};
  const rating = Number(b.rating);
  const phone = String(b.phone || '').trim();
  if (!phone) return res.status(400).json({ error: 'phone required' });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'rating must be 1-5' });
  }
  const comment = typeof b.comment === 'string' ? b.comment.slice(0, 500) : null;
  try {
    const { rows } = await pool.query(
      `UPDATE maintenance_tickets
         SET rating = $1, rating_comment = $2, updated_at = NOW()
         WHERE id = $3 AND tenant_phone = $4 AND status = 'completed'
         RETURNING ticket_no, rating`,
      [rating, comment, id, phone]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not found or not completed' });
    res.json({ ok: true, ticket: rows[0] });
  } catch (err) {
    console.error('ticket rate error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/audit?limit=&before=  — admin-auth, returns recent audit entries.
// Cursor-paginated by created_at DESC.
app.get('/api/audit', requireAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const before = req.query.before; // ISO timestamp or omit for newest
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
    const roomsObj = roomsRow.rows.length ? roomsRow.rows[0].value : {};
    const bookings = bookingsRow.rows.length && Array.isArray(bookingsRow.rows[0].value)
      ? bookingsRow.rows[0].value : [];
    const rooms = Object.values(roomsObj || {});
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

// GET /api/reports/maintenance — counts by status, average rating.
app.get('/api/reports/maintenance', requireAuth, async (_req, res) => {
  try {
    const [byStatus, ratings] = await Promise.all([
      pool.query(`SELECT status, COUNT(*) AS n FROM maintenance_tickets GROUP BY status`),
      pool.query(`SELECT AVG(rating)::numeric(3,2) AS avg_rating, COUNT(rating) AS rated
                    FROM maintenance_tickets WHERE rating IS NOT NULL`),
    ]);
    const counts = {};
    byStatus.rows.forEach((r) => { counts[r.status] = Number(r.n); });
    res.json({
      ok: true,
      counts,
      avgRating: ratings.rows[0]?.avg_rating != null ? Number(ratings.rows[0].avg_rating) : null,
      ratedCount: Number(ratings.rows[0]?.rated || 0),
    });
  } catch (err) {
    console.error('reports maintenance error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// --- Health ---------------------------------------------------------------
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok', time: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'down', error: err.message });
  }
});

// --- Static + routes ------------------------------------------------------
app.use(express.static(path.join(__dirname, 'project')));

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

// --- Boot -----------------------------------------------------------------
migrate()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[server] listening on ${PORT} (NODE_ENV=${NODE_ENV})`);
      console.log(`[server] tenant:  /`);
      console.log(`[server] admin:   /admin`);
      console.log(`[server] login:   /login`);
      console.log(`[server] health:  /health`);
    });
  })
  .catch((err) => {
    console.error('FATAL: migration failed:', err);
    process.exit(1);
  });
