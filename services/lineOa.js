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

function asCount(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Internal: turn a DB row into a public-safe object (no secrets exposed
// unless the caller explicitly asks for the decrypted token).
function rowToPublic(row, includeSecrets = false) {
  if (!row) return null;
  const storedBoundCount = asCount(row.bound_count, 0);
  const hasLiveStats = row.tenant_linked_count != null || row.binding_bound_count != null;
  const bindingBoundCount = row.binding_bound_count != null
    ? asCount(row.binding_bound_count, 0)
    : storedBoundCount;
  // For "how many people are linked?", the tenant row is the operational
  // truth because outbound notifications route through tenants.line_user_id
  // + tenants.line_oa_id. line_bindings remains useful as lifecycle history.
  const tenantLinkedCount = row.tenant_linked_count != null
    ? asCount(row.tenant_linked_count, 0)
    : bindingBoundCount;
  const counterDrift = tenantLinkedCount - storedBoundCount;
  const bindingMismatch = tenantLinkedCount - bindingBoundCount;
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
    boundCount: tenantLinkedCount,
    tenantLinkedCount,
    bindingBoundCount,
    storedBoundCount,
    pendingCount: asCount(row.pending_count, 0),
    lastBoundAt: row.last_bound_at || null,
    countSource: hasLiveStats ? 'live' : 'stored',
    counterDrift,
    bindingMismatch,
    hasCountDrift: hasLiveStats && counterDrift !== 0,
    hasBindingMismatch: hasLiveStats && bindingMismatch !== 0,
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
    boundCount: 0,
    tenantLinkedCount: 0,
    bindingBoundCount: 0,
    storedBoundCount: 0,
    pendingCount: 0,
    counterDrift: 0,
    bindingMismatch: 0,
    hasCountDrift: false,
    hasBindingMismatch: false,
    countSource: 'env',
    isEnvOa: true,
  };
}

// --- CRUD -----------------------------------------------------------------

async function list(pool, { includeDeleted = false } = {}) {
  const where = includeDeleted ? '' : 'WHERE o.deleted_at IS NULL';
  const { rows } = await pool.query(
    `SELECT
        o.*,
        COALESCE(bs.binding_bound_count, 0)::int AS binding_bound_count,
        COALESCE(bs.pending_count, 0)::int AS pending_count,
        bs.last_bound_at AS last_bound_at,
        COALESCE(ts.tenant_linked_count, 0)::int AS tenant_linked_count
       FROM line_oas o
       LEFT JOIN LATERAL (
         SELECT
           COUNT(*) FILTER (WHERE b.status='bound' AND b.oa_id = o.id)::int AS binding_bound_count,
           COUNT(*) FILTER (
             WHERE b.status='pending'
               AND b.expires_at > NOW()
               AND b.target_oa_id = o.id
           )::int AS pending_count,
           MAX(b.bound_at) FILTER (WHERE b.status='bound' AND b.oa_id = o.id) AS last_bound_at
          FROM line_bindings b
         WHERE b.oa_id = o.id OR b.target_oa_id = o.id
       ) bs ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS tenant_linked_count
           FROM tenants t
          WHERE t.line_oa_id = o.id
            AND t.line_user_id IS NOT NULL
            AND t.deleted_at IS NULL
       ) ts ON TRUE
       ${where}
       ORDER BY o.is_default DESC, o.name ASC`
  );
  const items = rows.map((r) => rowToPublic(r, false));
  // If no DB rows, expose the env OA so admin UI can still show something.
  if (items.length === 0) {
    const env = _envOa();
    if (env) {
      try {
        const stats = await getBindingStats(pool, 0);
        items.push({ ...env, ...stats, isEnvOa: true, id: 0 });
      } catch {
        items.push({ ...env, isEnvOa: true, id: 0 });
      }
    }
  }
  return items;
}

async function getBindingStats(pool, oaId) {
  const numId = (oaId == null || Number(oaId) === 0) ? null : Number(oaId);
  if (oaId != null && Number(oaId) !== 0 && (!Number.isFinite(numId) || numId <= 0)) {
    throw new Error('invalid id');
  }
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int
          FROM tenants t
         WHERE COALESCE(t.line_oa_id, 0) = COALESCE($1::bigint, 0)
           AND t.line_user_id IS NOT NULL
           AND t.deleted_at IS NULL) AS tenant_linked_count,
       (SELECT COUNT(*)::int
          FROM line_bindings b
         WHERE COALESCE(b.oa_id, 0) = COALESCE($1::bigint, 0)
           AND b.status='bound') AS binding_bound_count,
       (SELECT COUNT(*)::int
          FROM line_bindings b
         WHERE COALESCE(b.target_oa_id, 0) = COALESCE($1::bigint, 0)
           AND b.status='pending'
           AND b.expires_at > NOW()) AS pending_count,
       (SELECT MAX(b.bound_at)
          FROM line_bindings b
         WHERE COALESCE(b.oa_id, 0) = COALESCE($1::bigint, 0)
           AND b.status='bound') AS last_bound_at,
       (SELECT bound_count::int
          FROM line_oas o
         WHERE $1::bigint IS NOT NULL
           AND o.id = $1::bigint
           AND o.deleted_at IS NULL) AS stored_bound_count`,
    [numId]
  );
  const row = rows[0] || {};
  const tenantLinkedCount = asCount(row.tenant_linked_count, 0);
  const bindingBoundCount = asCount(row.binding_bound_count, 0);
  const storedBoundCount = row.stored_bound_count == null ? 0 : asCount(row.stored_bound_count, 0);
  return {
    boundCount: tenantLinkedCount,
    tenantLinkedCount,
    bindingBoundCount,
    storedBoundCount,
    pendingCount: asCount(row.pending_count, 0),
    lastBoundAt: row.last_bound_at || null,
    countSource: 'live',
    counterDrift: tenantLinkedCount - storedBoundCount,
    bindingMismatch: tenantLinkedCount - bindingBoundCount,
    hasCountDrift: numId != null && tenantLinkedCount !== storedBoundCount,
    hasBindingMismatch: tenantLinkedCount !== bindingBoundCount,
  };
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
    // When the caller flipped is_default, the previously-default OA's
    // cached entry still has isDefault=TRUE for up to 60s. Wipe the entire
    // cache (every OA + slug) so the next request reloads fresh state for
    // any OA — not just the one we just touched.
    if (patch.isDefault !== undefined) invalidateCache(null);
    else invalidateCache(numId);
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
    // Clear last_seen_at + last_error too so the admin UI doesn't keep
    // showing "last seen 2h ago" on a row that's already deleted (was
    // confusing operators who weren't sure if delete actually happened).
    await client.query(
      `UPDATE line_oas
          SET deleted_at=NOW(), enabled=FALSE, is_default=FALSE,
              last_seen_at=NULL, last_error=NULL, updated_at=NOW()
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
          SELECT COUNT(*) FROM tenants
            WHERE line_oa_id=$1
              AND line_user_id IS NOT NULL
              AND deleted_at IS NULL
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
  // Trim + reject control chars (operators commonly paste tokens with a
  // trailing newline; that single \n breaks the http module with
  // "Invalid character in header content")
  const tokenClean = String(oa.channelAccessToken).trim().replace(/[\x00-\x1F\x7F]/g, '');
  if (!tokenClean) throw new Error('access token ว่างหลัง trim — ลอง paste ใหม่');
  if (/[^\x20-\x7E]/.test(tokenClean)) {
    throw new Error('access token มีอักขระที่ใส่ใน HTTP header ไม่ได้ — โปรดวางใหม่');
  }
  return await new Promise((resolve) => {
    const https = require('https');
    const req = https.request({
      hostname: 'api.line.me', path: '/v2/bot/info', method: 'GET',
      headers: { Authorization: `Bearer ${tokenClean}` },
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
  create, update, remove, refreshBoundCount, getBindingStats, testConnection,
  verifyWebhookSignature, invalidateCache,
  normalizeSlug, isValidSlug,
  _envOa,
};
