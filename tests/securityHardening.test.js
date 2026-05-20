const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const serverSource = () => fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('API responses default to no-store cache control', () => {
  const src = serverSource();
  assert.match(src, /app\.use\('\/api', \(_req, res, next\) => \{/,
    'server must install an /api cache-control middleware');
  assert.match(src, /Cache-Control', 'no-store'/,
    'API middleware must prevent browser/shared caching of sensitive JSON');
});

test('server blocks path traversal and source-file probing before routes', () => {
  const src = serverSource();
  assert.match(src, /BLOCKED_METHODS = new Set\(\['TRACE', 'TRACK', 'CONNECT'\]\)/,
    'dangerous HTTP methods should be blocked before reaching routes');
  assert.match(src, /PROTECTED_SOURCE_PATH/,
    'server must define protected source-path scanner');
  assert.match(src, /function isProtectedSourceProbePath\(pathValue\)/,
    'protected source-path scanner must be centralized');
  assert.match(src, /\^\\\/api\\\/uploads\\\/\?\$/,
    'authenticated /api/uploads must not be confused with direct /uploads file probes');
  assert.match(src, /if \(isProtectedSourceProbePath\(pathValue\)\)/,
    'request guard must use the scanner helper so route exceptions stay active');
  assert.match(src, /path_traversal/,
    'server must explicitly reject traversal probes');
  assert.match(src, /protected_source_path/,
    'server must reject attempts to fetch source/config directories');
  assert.match(src, /security\.blocked_request/,
    'blocked probes must be recorded as security events');
});

test('security events trigger owner alerts with thresholds and cooldown', () => {
  const src = serverSource();
  assert.match(src, /SECURITY_ALERT_RULES = Object\.freeze/,
    'security events should have alert rules');
  assert.match(src, /SECURITY_ALERT_COOLDOWN_MS/,
    'alerts must have a cooldown to avoid notification spam');
  assert.match(src, /maybeNotifySecurityEvent\(req, action, safeDetail\)/,
    'securityEvent should invoke the alert aggregator');
  assert.match(src, /notifier\.notifyOwner/,
    'security alerts should notify the owner through the normal notifier pipeline');
  assert.match(src, /\/admin#security-events/,
    'alert text should point admins to the security events page');
});

test('blocked attackers receive a generic warning without detector details', () => {
  const src = serverSource();
  assert.match(src, /SECURITY_WARNING_TEXT/,
    'server must define a generic warning shown to suspicious callers');
  assert.match(src, /X-Security-Warning', 'unauthorized-access-logged'/,
    'security responses should include a warning header');
  assert.match(src, /X-Robots-Tag', 'noindex, nofollow'/,
    'security warning responses should discourage indexing scanner URLs');
  assert.match(src, /function sendSecurityJson/,
    'JSON security responses should be centralized');
  assert.match(src, /function sendSecurityText/,
    'plain-text security responses should be centralized');
});

test('auth-gated file proxy is rate-limited and audits denied access', () => {
  const src = serverSource();
  assert.match(src, /const rateLimitFileAccess = makeIpLimiter/,
    'file proxy needs its own limiter so file-id scans cannot run unbounded');
  assert.match(src, /app\.get\('\/files\/:id', rateLimitFileAccess,/,
    '/files/:id must use the file limiter');
  assert.match(src, /security\.file_guess_miss/,
    'missing or invalid file ids must be audited as URL guessing');
  assert.match(src, /return sendSecurityText\(res, 404\)/,
    'file guessing should return a warning body instead of an empty response');
  assert.match(src, /security\.file_access_denied/,
    'denied file reads must be visible in the security event log');
  assert.match(src, /res\.setHeader\('Vary', 'Cookie'\)/,
    'file responses must vary by cookie because authorization is cookie/session based');
});

test('unknown URL guessing is logged for API and suspicious public probes', () => {
  const src = serverSource();
  assert.match(src, /SUSPICIOUS_UNKNOWN_PATH/,
    'server must classify suspicious public 404 probes');
  assert.match(src, /security\.api_unknown_route/,
    'unknown API endpoints must be recorded for URL guessing detection');
  assert.match(src, /security\.public_unknown_route/,
    'suspicious public unknown routes must be recorded');
  assert.match(src, /suspiciousUnknownPath\(req\.originalUrl \|\| req\.url\)/,
    'public 404 handler must check suspicious path patterns');
  assert.match(src, /securityWarningBody\('route not found', 'NOT_FOUND'\)/,
    'unknown API route responses should include the generic warning');
});

test('admin security events include central security.* audit records', () => {
  const src = serverSource();
  const block = src.match(/app\.get\('\/api\/admin\/security-events'[\s\S]+?\n\}\);/);
  assert.ok(block, 'security events endpoint must exist');
  assert.match(block[0], /action LIKE 'security\.%'/,
    'security events page must show blocked access, role denial, file denial, and token rejection events');
});
