// services/email.js
// SMTP email via nodemailer. Lazy-loaded — when the email feature is off we
// never construct the transport, so the dep is not required at runtime.
//
// Env vars (override the DB-stored config):
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
// DB config (services/features.js): email.{ smtpHost, smtpPort, smtpUser, from }

const secrets = require('./secrets');

let _nodemailer = null;
let _transport = null;
let _transportKey = '';

function hasNodemailer() {
  try {
    require.resolve('nodemailer');
    return true;
  } catch {
    return false;
  }
}

function load() {
  if (_nodemailer) return _nodemailer;
  // eslint-disable-next-line global-require
  _nodemailer = require('nodemailer');
  return _nodemailer;
}

function buildKey(c) {
  return [c.host, c.port, c.user, c.pass].join('|');
}

function getTransport(config) {
  // Prefer secrets store (admin UI) over feature-flag fields (legacy).
  const cfg = {
    host: secrets.get('SMTP_HOST') || config.smtpHost,
    port: Number(secrets.get('SMTP_PORT') || config.smtpPort || 587),
    user: secrets.get('SMTP_USER') || config.smtpUser,
    pass: secrets.get('SMTP_PASS'),
  };
  if (!cfg.host || !cfg.user || !cfg.pass) {
    throw new Error('SMTP host/user/pass not configured');
  }
  const key = buildKey(cfg);
  if (_transport && key === _transportKey) return _transport;
  const nm = load();
  _transport = nm.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
    // Bound the worst case. notifier.notifyTenant/notifyOwner call send()
    // INLINE from request handlers (check-in, payment verify, maintenance), so
    // a dead/slow SMTP host must fail fast instead of hanging the request (and
    // its DB connection) for the OS-level minutes-long TCP default.
    connectionTimeout: 10_000, // ms to establish the TCP connection
    greetingTimeout: 10_000,   // ms to wait for the SMTP greeting
    socketTimeout: 20_000,     // ms of socket inactivity before giving up
  });
  _transportKey = key;
  return _transport;
}

/**
 * Send a plain-text or HTML email.
 * @param {object} flags - feature flag map; email.enabled must be true
 * @param {object} msg - { to, subject, text?, html? }
 * @returns {Promise<boolean>} true if accepted by SMTP, false on failure
 */
async function send(flags, msg) {
  const ec = flags && flags.email;
  if (!ec || !ec.enabled) return false;
  if (!msg || !msg.to || !msg.subject) return false;
  const from = secrets.get('SMTP_FROM') || ec.from || secrets.get('SMTP_USER') || ec.smtpUser;
  if (!from) return false;
  try {
    const t = getTransport(ec);
    await t.sendMail({
      from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text || undefined,
      html: msg.html || undefined,
      // Stable Message-ID (when the caller supplies one) lets receiving servers
      // dedupe a re-sent message — used by the notification queue so a reaper-
      // induced re-dispatch carries the same id instead of looking like a new mail.
      messageId: msg.messageId || undefined,
    });
    return true;
  } catch (err) {
    console.error('[email] send failed:', err.message);
    return false;
  }
}

function isConfigured(flags, opts = {}) {
  const sdkReady = typeof opts.hasNodemailer === 'function'
    ? opts.hasNodemailer()
    : hasNodemailer();
  return !!(flags && flags.email && flags.email.enabled
    && sdkReady
    && (secrets.get('SMTP_HOST') || flags.email.smtpHost)
    && (secrets.get('SMTP_USER') || flags.email.smtpUser)
    && secrets.get('SMTP_PASS'));
}

module.exports = { send, isConfigured, hasNodemailer };
