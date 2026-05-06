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
app.post('/api/auth/login', sameOrigin, async (req, res) => {
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
    res.json({ user: req.session.user });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/auth/logout', sameOrigin, (req, res) => {
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
    res.json({ ok: true, booking: newBooking });
  } catch (err) {
    console.error('public booking error:', err);
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
