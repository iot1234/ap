// middleware/auth.js
// Auth middlewares used across the routes folder.
//
//   requireAuth        — admin session required; refreshes role from DB
//   requireRole(...)   — admin session AND role in allowed list
//   requireDeviceOrAdmin — accepts admin session OR Bearer device token
//
// requireTenant lives in routes/tenant-portal.js because it needs the
// tenant_sessions DB layout closer at hand.

const crypto = require('crypto');

const ROLE_RANK = { owner: 4, manager: 3, staff: 2, readonly: 1 };

function emitSecurityEvent(req, action, detail = {}) {
  try {
    const sink = req && req.app && typeof req.app.get === 'function'
      ? req.app.get('securityEvent')
      : null;
    if (typeof sink === 'function') {
      Promise.resolve(sink(req, action, detail)).catch(() => {});
    }
  } catch { /* security logging must never break auth */ }
}

function makeAuth(pool) {
  async function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) {
      emitSecurityEvent(req, 'security.admin_unauthorized', {
        path: req.originalUrl || req.url,
        method: req.method,
        reason: 'missing_admin_session',
      });
      return res.status(401).json({ error: 'unauthorized', code: 'UNAUTHORIZED' });
    }
    try {
      const { rows } = await pool.query(
        'SELECT role FROM auth_users WHERE id=$1', [req.session.user.id]
      );
      if (!rows.length) {
        emitSecurityEvent(req, 'security.admin_stale_session', {
          path: req.originalUrl || req.url,
          method: req.method,
          userId: req.session.user.id,
          username: req.session.user.username,
          reason: 'account_missing',
        });
        req.session.destroy(() => {});
        return res.status(401).json({ error: 'account no longer exists', code: 'UNAUTHORIZED' });
      }
      req.session.user.role = rows[0].role;
      next();
    } catch (err) {
      console.error('requireAuth refresh error:', err.message);
      res.status(500).json({ error: 'internal error', code: 'AUTH_ERROR' });
    }
  }

  /**
   * Require the session to have at least one of the listed roles. Roles are
   * also hierarchical: an `owner` satisfies `requireRole('staff')` because
   * owner outranks staff. This means most callers can just specify the
   * minimum role and not enumerate every higher tier.
   */
  function requireRole(...allowed) {
    const minRank = Math.min(...allowed.map((r) => ROLE_RANK[r] || 99));
    return async function (req, res, next) {
      if (!req.session || !req.session.user) {
        emitSecurityEvent(req, 'security.admin_unauthorized', {
          path: req.originalUrl || req.url,
          method: req.method,
          reason: 'missing_admin_session_for_role',
          required: allowed,
        });
        return res.status(401).json({ error: 'unauthorized', code: 'UNAUTHORIZED' });
      }
      const role = req.session.user.role;
      if (allowed.includes(role)) return next();
      const rank = ROLE_RANK[role] || 0;
      if (rank >= minRank) return next();
      emitSecurityEvent(req, 'security.admin_forbidden_role', {
        path: req.originalUrl || req.url,
        method: req.method,
        required: allowed,
        actual: role,
        username: req.session.user.username,
      });
      return res.status(403).json({
        error: 'forbidden — insufficient role',
        code: 'FORBIDDEN',
        required: allowed,
        actual: role,
      });
    };
  }

  /**
   * Hardware devices (RFID readers, ESP32) authenticate with a Bearer token
   * stored hashed in `access_devices`. Falls back to admin session if no
   * Authorization header is present, so a logged-in admin can still POST
   * test events from the UI.
   */
  async function requireDeviceOrAdmin(req, res, next) {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      const token = auth.slice(7).trim();
      if (!token || token.length > 200) {
        emitSecurityEvent(req, 'security.device_token_rejected', {
          path: req.originalUrl || req.url,
          method: req.method,
          reason: !token ? 'empty_token' : 'token_too_long',
        });
        return res.status(401).json({ error: 'invalid token', code: 'UNAUTHORIZED' });
      }
      const hash = crypto.createHash('sha256').update(token).digest('hex');
      try {
        const { rows } = await pool.query(
          `SELECT id, device_id FROM access_devices
             WHERE api_token_hash=$1 AND enabled=TRUE LIMIT 1`,
          [hash]
        );
        if (rows.length) {
          req.device = rows[0];
          // Best-effort last-seen update; don't block on it.
          pool.query('UPDATE access_devices SET last_seen=NOW() WHERE id=$1', [rows[0].id])
            .catch(() => {});
          return next();
        }
        emitSecurityEvent(req, 'security.device_token_rejected', {
          path: req.originalUrl || req.url,
          method: req.method,
          reason: 'hash_not_found_or_disabled',
        });
        return res.status(401).json({ error: 'invalid device token', code: 'UNAUTHORIZED' });
      } catch (err) {
        console.error('device auth error:', err.message);
        return res.status(500).json({ error: 'internal error' });
      }
    }
    return requireAuth(req, res, next);
  }

  return { requireAuth, requireRole, requireDeviceOrAdmin, ROLE_RANK };
}

module.exports = { makeAuth, ROLE_RANK };
