// services/lineOa.js
// Multi-OA registry. Operator can register N LINE Official Accounts and the
// system routes inbound webhooks + outbound pushes to the correct one. Each
// OA's channel access token + channel secret are stored encrypted at rest.
//
// Backwards compatibility: if env LINE_CHANNEL_ACCESS_TOKEN/LINE_CHANNEL_SECRET
// are set and no DB OAs exist, we return a synthetic "env OA" with id=0 so
// existing single-OA deployments keep working without migration.

const crypto = require('crypto');
const encryption = require('./encryption');
const secrets = require('./secrets');

// In-memory cache of decrypted OAs. Keyed by oa_id; invalidated on writes via
// invalidateCache(). Avoids re-decrypting on every notification push.
const _cache = new Map();        // id -> { oa, expires }
const _cacheBySlug = new Map();  // slug -> { oa, expires }
const CACHE_TTL_MS = 60_000;

function _now() { return Date.now(); }

function invalidateCache(oaId) {
  if (oaId == null) {
    _cache.clear();
    _cacheBySlug.clear();
  } else {
    _cache.delete(oaId);
    // Slug cache is keyed by string — drop the whole map on a per-id
    // invalidation; the OA may have changed slug too.
    _cacheBySlug.clear();
  }
}

// --- Slug helpers ---------------------------------------------------------
// Slug becomes part of the webhook URL: /webhook/line/<slug>. We restrict to
// [a-z0-9_-] and 2..40 chars to avoid path-injection / case-folding issues.
function normalizeSlug(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function isValidSlug(s) {
  return /^[a-z0-9][a-z0-9_-]{1,38}[a-z0-9]$|^[a-z0-9]{2,40}$/.test(s || '');
}

// Internal: turn a DB row into a public-safe object (no secrets exposed
// unless the caller explicitly asks for the decrypted token).
function rowToPublic(row, includeSecrets = false) {
  if (!row) return null;
  const out = {
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    description: row.description || '',
    botBasicId: row.bot_basic_id || '',
    channelId: row.channel_id || '',
    enabled: !!row.enabled,
    isDefault: !!row.is_default,
    ownerUserId: row.owner_user_id || '',
    boundCount: Number(row.bound_count || 0),
    lastSeenAt: row.last_seen_at,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hasAccessToken: !!row.channel_access_token_encrypted,
    hasChannelSecret: !!row.channel_secret_encrypted,
  };
  if (includeSecrets) {
    try {
      out.channelAccessToken = row.channel_access_token_encrypted
        ? encryption.decryptString(row.channel_access_token_encrypted)
        : null;
      out.channelSecret = row.channel_secret_encrypted
        ? encryption.decryptString(row.channel_secret_encrypted)
        : null;
    } catch (err) {
      out.channelAccessToken = null;
      out.channelSecret = null;
      out.lastError = `decrypt failed: ${err.message}`;
    }
  }
  return out;
}

// Synthetic "env OA" that wraps the legacy single-OA env vars. Returned only
// when no DB rows exist OR caller explicitly asks for envOa. id=0 means
// "legacy env-based" everywhere downstream — line_bindings.oa_id stays NULL
// (meaning "the env OA") so we don't need a real row in the DB.
function _envOa() {
  const token = secrets.get('LINE_CHANNEL_ACCESS_TOKEN');
  const channelSecret = secrets.get('LINE_CHANNEL_SECRET');
  const owner = secrets.get('LINE_OWNER_USER_ID');
  if (!token && !channelSecret) return null;
  return {
    id: 0,
    slug: 'env',
    name: 'LINE OA (env vars)',
    description: 'Legacy single-OA configured via environment variables',
    enabled: true,
    isDefault: true,
    ownerUserId: owner || '',
    channelAccessToken: token || null,
    channelSecret: channelSecret || null,
    hasAccessToken: !!token,
    hasChannelSecret: !!channelSecret,
    isEnvOa: true,
  };
}

// --- CRUD -----------------------------------------------------------------

async function list(pool, { includeDeleted = false } = {}) {
  const where = includeDeleted ? '' : 'WHERE deleted_at IS NULL';
  const { rows } = await pool.query(
    `SELECT * FROM line_oas ${where} ORDER BY is_default DESC, name ASC`
  );
  const items = rows.map((r) => rowToPublic(r, false));
  // If no DB rows, expose the env OA so admin UI can still show something.
  if (items.length === 0) {
    const env = _envOa();
    if (env) items.push({ ...env, isEnvOa: true, id: 0 });
  }
  return items;
}

async function getById(pool, id, { withSecrets = false } = {}) {
  const numId = Number(id);
  if (!Number.isFinite(numId)) return null;
  if (numId === 0) return _envOa();
  // Cache-aware lookup
  const cached = _cache.get(numId);
  if (cached && cached.expires > _now() && withSecrets) return cached.oa;

  const { rows } = await pool.query(
    `SELECT * FROM line_oas WHERE id=$1 AND deleted_at IS NULL`,
    [numId]
  );
  const oa = rowToPublic(rows[0], withSecrets);
  if (oa && withSecrets) {
    _cache.set(numId, { oa, expires: _now() + CACHE_TTL_MS });
  }
  return oa;
}

async function getBySlug(pool, slug, { withSecrets = false } = {}) {
  const s = normalizeSlug(slug);
  if (!s) return null;
  if (s === 'env') return _envOa();
  // Cache-aware lookup. The webhook /webhook/line/:slug calls this on
  // every event; without caching we'd re-decrypt the channel secret per
  // request, which is ~10x the CPU of the legacy single-OA path.
  const cached = _cacheBySlug.get(s);
  if (cached && cached.expires > _now() && withSecrets) return cached.oa;

  const { rows } = await pool.query(
    `SELECT * FROM line_oas WHERE slug=$1 AND deleted_at IS NULL`,
    [s]
  );
  const oa = rowToPublic(rows[0], withSecrets);
  if (oa && withSecrets) {
    _cacheBySlug.set(s, { oa, expires: _now() + CACHE_TTL_MS });
    // Mirror into the id cache too so a subsequent getById hits the same
    // decrypted bytes without another DB roundtrip.
    if (oa.id) _cache.set(oa.id, { oa, expires: _now() + CACHE_TTL_MS });
  }
  return oa;
}

// The "default" OA is what we use when issuing a binding code without a
// specific target, and what notifyOwner uses for system messages. Resolution:
// 1) row with is_default=TRUE
// 2) any single enabled row (when there's exactly one)
// 3) env OA (legacy)
async function getDefault(pool, { withSecrets = false } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM line_oas
       WHERE deleted_at IS NULL AND enabled = TRUE
       ORDER BY is_default DESC, id ASC LIMIT 1`
  );
  if (rows[0]) return rowToPublic(rows[0], withSecrets);
  return _envOa();
}

// Resolve the OA for a bound tenant. Returns the real OA if oaId is set,
// or the env OA if oaId is NULL/0 (legacy bindings predating multi-OA).
async function resolveForTenant(pool, oaId, { withSecrets = false } = {}) {
  if (oaId == null || oaId === 0) return _envOa();
  return getById(pool, oaId, { withSecrets });
}

async function create(pool, input, createdBy) {
  const slug = normalizeSlug(input.slug || input.name);
  if (!isValidSlug(slug)) throw new Error('slug ไม่ถูกต้อง (a-z0-9_- 2-40 chars)');
  const name = String(input.name || '').slice(0, 120).trim();
  if (!name) throw new Error('name required');

  const accessTokenEnc = input.channelAccessToken
    ? encryption.encryptString(String(input.channelAccessToken))
    : null;
  const secretEnc = input.channelSecret
    ? encryption.encryptString(String(input.channelSecret))
    : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // If asked to be default, clear any existing default first (the partial
    // unique index would otherwise reject the insert).
    if (input.isDefault) {
      await client.query(`UPDATE line_oas SET is_default=FALSE WHERE deleted_at IS NULL`);
    }
    const { rows } = await client.query(
      `INSERT INTO line_oas
         (slug, name, description, bot_basic_id, channel_id,
          channel_secret_encrypted, channel_access_token_encrypted,
          enabled, is_default, owner_user_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        slug, name,
        input.description ? String(input.description).slice(0, 500) : null,
        input.botBasicId ? String(input.botBasicId).slice(0, 60) : null,
        input.channelId ? String(input.channelId).slice(0, 60) : null,
        secretEnc, accessTokenEnc,
        input.enabled !== false,
        !!input.isDefault,
        input.ownerUserId ? String(input.ownerUserId).slice(0, 60) : null,
        createdBy || null,
      ]
    );
    await client.query('COMMIT');
    invalidateCache();
    return rowToPublic(rows[0], false);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') throw new Error('slug ซ้ำกับ OA อื่น');
    throw err;
  } finally {
    client.release();
  }
}

async function update(pool, id, patch, updatedBy) {
  const numId = Number(id);
  if (!Number.isFinite(numId) || numId <= 0) throw new Error('invalid id');
  const sets = [];
  const params = [];
  let i = 1;
  if (patch.name !== undefined) { sets.push(`name=$${i++}`); params.push(String(patch.name).slice(0, 120)); }
  if (patch.description !== undefined) { sets.push(`description=$${i++}`); params.push(patch.description ? String(patch.description).slice(0, 500) : null); }
  if (patch.botBasicId !== undefined) { sets.push(`bot_basic_id=$${i++}`); params.push(patch.botBasicId ? String(patch.botBasicId).slice(0, 60) : null); }
  if (patch.channelId !== undefined) { sets.push(`channel_id=$${i++}`); params.push(patch.channelId ? String(patch.channelId).slice(0, 60) : null); }
  if (patch.ownerUserId !== undefined) { sets.push(`owner_user_id=$${i++}`); params.push(patch.ownerUserId ? String(patch.ownerUserId).slice(0, 60) : null); }
  if (patch.enabled !== undefined) { sets.push(`enabled=$${i++}`); params.push(!!patch.enabled); }
  if (patch.slug !== undefined) {
    const s = normalizeSlug(patch.slug);
    if (!isValidSlug(s)) throw new Error('slug ไม่ถูกต้อง');
    sets.push(`slug=$${i++}`); params.push(s);
  }
  if (patch.channelAccessToken !== undefined) {
    sets.push(`channel_access_token_encrypted=$${i++}`);
    params.push(patch.channelAccessToken ? encryption.encryptString(String(patch.channelAccessToken)) : null);
  }
  if (patch.channelSecret !== undefined) {
    sets.push(`channel_secret_encrypted=$${i++}`);
    params.push(patch.channelSecret ? encryption.encryptString(String(patch.channelSecret)) : null);
  }
  // is_default is handled in a transaction below
  sets.push(`updated_at=NOW()`);
  if (sets.length === 1 && patch.isDefault === undefined) {
    throw new Error('ไม่มีอะไรให้แก้ไข');
  }
  params.push(numId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (patch.isDefault === true) {
      await client.query(`UPDATE line_oas SET is_default=FALSE WHERE id<>$1 AND deleted_at IS NULL`, [numId]);
      sets.push(`is_default=TRUE`);
    } else if (patch.isDefault === false) {
      sets.push(`is_default=FALSE`);
    }
    const sql = `UPDATE line_oas SET ${sets.join(', ')} WHERE id=$${i} AND deleted_at IS NULL RETURNING *`;
    const { rows } = await client.query(sql, params);
    await client.query('COMMIT');
    invalidateCache(numId);
    if (!rows[0]) throw new Error('not found');
    return rowToPublic(rows[0], false);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') throw new Error('slug ซ้ำกับ OA อื่น');
    throw err;
  } finally {
    client.release();
  }
}

// Soft delete. Active bindings via this OA are revoked (so notifications stop)
// but kept on disk for audit. Tenants must be re-issued a code via another OA.
async function remove(pool, id, by) {
  const numId = Number(id);
  if (!Number.isFinite(numId) || numId <= 0) throw new Error('invalid id');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE line_oas SET deleted_at=NOW(), enabled=FALSE, updated_at=NOW()
         WHERE id=$1 AND deleted_at IS NULL`,
      [numId]
    );
    // Revoke active bindings via this OA so we don't try to push to a dead token
    await client.query(
      `UPDATE line_bindings SET status='revoked', updated_at=NOW()
         WHERE oa_id=$1 AND status IN ('pending','bound')`,
      [numId]
    );
    // Clear cache on tenants that were bound here
    await client.query(
      `UPDATE tenants SET line_user_id=NULL, line_oa_id=NULL, updated_at=NOW()
         WHERE line_oa_id=$1`,
      [numId]
    );
    await client.query('COMMIT');
    invalidateCache(numId);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Recompute bound_count for an OA. Cheap enough to call on every bind/unbind.
async function refreshBoundCount(pool, oaId) {
  if (oaId == null || oaId === 0) return;
  await pool.query(
    `UPDATE line_oas
        SET bound_count = (
          SELECT COUNT(*) FROM line_bindings
            WHERE oa_id=$1 AND status='bound'
        ),
        updated_at = NOW()
      WHERE id=$1`,
    [oaId]
  );
  invalidateCache(oaId);
}

// Test the OA's credentials by hitting LINE's bot info endpoint. Updates
// last_seen_at on success and last_error on failure for the admin UI.
async function testConnection(pool, id) {
  const oa = await getById(pool, id, { withSecrets: true });
  if (!oa) throw new Error('not found');
  if (!oa.channelAccessToken) throw new Error('ยังไม่ได้ตั้ง access token');
  return await new Promise((resolve) => {
    const https = require('https');
    const req = https.request({
      hostname: 'api.line.me', path: '/v2/bot/info', method: 'GET',
      headers: { Authorization: `Bearer ${oa.channelAccessToken}` },
      timeout: 5000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', async () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        try {
          if (oa.id !== 0) {
            await pool.query(
              `UPDATE line_oas
                  SET last_seen_at = CASE WHEN $2 THEN NOW() ELSE last_seen_at END,
                      last_error  = CASE WHEN $2 THEN NULL ELSE $3 END,
                      updated_at  = NOW()
                WHERE id=$1`,
              [oa.id, ok, ok ? null : `HTTP ${res.statusCode}: ${buf.slice(0, 240)}`]
            );
            invalidateCache(oa.id);
          }
        } catch { /* ignore */ }
        let info = null;
        try { info = ok ? JSON.parse(buf) : null; } catch { /* ignore */ }
        resolve({ ok, status: res.statusCode, body: buf.slice(0, 400), info });
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end();
  });
}

// Verify HMAC signature with the OA's own secret (NOT the global env one).
// Used by the per-slug webhook handler.
function verifyWebhookSignature(oa, rawBody, signature) {
  if (!oa || !oa.channelSecret || !signature) return false;
  const expected = crypto
    .createHmac('sha256', oa.channelSecret)
    .update(rawBody)
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch { return false; }
}

module.exports = {
  list, getById, getBySlug, getDefault, resolveForTenant,
  create, update, remove, refreshBoundCount, testConnection,
  verifyWebhookSignature, invalidateCache,
  normalizeSlug, isValidSlug,
  _envOa,
};
