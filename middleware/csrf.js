// middleware/csrf.js
// Double-submit cookie CSRF defense via the `csrf-csrf` package.
//
// The existing same-origin Origin/Referer check already blocks classic CSRF.
// This adds defense-in-depth: even if a future code change loosens the
// origin check (or browsers send unexpected Origin headers), the attacker
// also has to read a cookie they can't access cross-origin.
//
// Wiring:
//   - GET  /api/csrf-token         → returns { csrfToken } and sets cookie
//   - All state-changing routes get `csrfProtection` middleware
//   - Frontend reads the token + sends it as `X-CSRF-Token` header
//
// We intentionally exempt:
//   - public POSTs that have no session (booking, maintenance) — they're
//     already protected by sameOrigin + rate limit + no privileged action
//   - device API token paths (Bearer auth) — devices have no cookie jar

const { doubleCsrf } = require('csrf-csrf');

function makeCsrf({ secret, secure }) {
  const { generateCsrfToken, doubleCsrfProtection, invalidCsrfTokenError } = doubleCsrf({
    getSecret: () => secret,
    getSessionIdentifier: (req) => {
      // Prefer admin session id, fall back to tenant session id, fall back
      // to anonymised IP. This binds the token to a user (or at least an
      // origin) so an attacker can't forge it without knowing the cookie.
      const a = req.session && req.session.user ? `admin:${req.session.user.id}` : null;
      const t = req.headers.cookie
        ? (req.headers.cookie.match(/(?:^|;\s*)tenant_sid=([^;]+)/) || [])[1] : null;
      return a || (t ? `tenant:${t.slice(0, 16)}` : `anon:${req.ip || 'x'}`);
    },
    cookieName: secure ? '__Host-csrf' : 'csrf-token',
    cookieOptions: {
      sameSite: 'lax',
      secure,
      httpOnly: true,
      path: '/',
    },
    size: 32,
    getCsrfTokenFromRequest: (req) =>
      req.headers['x-csrf-token']
      || (req.body && req.body._csrf)
      || (req.query && req.query._csrf),
  });

  function csrfErrorHandler(err, req, res, next) {
    if (err === invalidCsrfTokenError) {
      return res.status(403).json({ error: 'invalid CSRF token', code: 'CSRF_INVALID' });
    }
    next(err);
  }

  return { generateCsrfToken, doubleCsrfProtection, csrfErrorHandler };
}

module.exports = { makeCsrf };
