// services/sentry.js
// Optional error tracking via Sentry. The dep is lazy-loaded only when
// the errorTracking flag is enabled and SENTRY_DSN is present, so a
// deployment without Sentry doesn't pay any cost.

const secrets = require('./secrets');

let _sentry = null;

function init(features) {
  if (_sentry) return _sentry;
  const f = features && features.errorTracking;
  if (!f || !f.enabled) return null;
  const dsn = secrets.get('SENTRY_DSN');
  if (!dsn) return null;
  try {
    // eslint-disable-next-line global-require
    _sentry = require('@sentry/node');
    _sentry.init({ dsn, environment: process.env.NODE_ENV || 'production', tracesSampleRate: 0.1 });
    console.log('[sentry] initialised');
    return _sentry;
  } catch (err) {
    console.warn('[sentry] init skipped:', err.message);
    return null;
  }
}

function captureException(err, ctx) {
  if (!_sentry) return;
  try { _sentry.captureException(err, ctx ? { extra: ctx } : undefined); }
  catch { /* swallow */ }
}

function captureMessage(msg, level) {
  if (!_sentry) return;
  try { _sentry.captureMessage(msg, level || 'info'); }
  catch { /* swallow */ }
}

module.exports = { init, captureException, captureMessage };
