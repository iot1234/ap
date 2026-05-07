// services/sms.js
// SMS provider abstraction. Two modes:
//   1) features.sms.enabled === false  → send() returns false (no-op)
//   2) enabled but no provider integration → throw a clear error so the
//      notifications_log row carries an actionable message
//
// To enable real SMS:
//   a) install your provider SDK (e.g. `npm i twilio` or use thsms HTTPS API)
//   b) set features.sms.provider = 'twilio' | 'thsms'
//   c) add credentials to the secrets table (TWILIO_ACCOUNT_SID, etc.)
//   d) implement the provider branch below
//
// The fallback chain in services/notifier.js skips SMS unless
// isConfigured(features) returns true, so an unimplemented provider can't
// silently block delivery — LINE/email still fire normally.

const secrets = require('./secrets');

function isConfigured(features) {
  if (!features || !features.sms || !features.sms.enabled) return false;
  const provider = features.sms.provider || '';
  if (provider === 'twilio') {
    return !!(secrets.get('TWILIO_ACCOUNT_SID') && secrets.get('TWILIO_AUTH_TOKEN') && secrets.get('TWILIO_FROM'));
  }
  if (provider === 'thsms') {
    return !!(secrets.get('THSMS_API_KEY') && secrets.get('THSMS_API_SECRET'));
  }
  return false;
}

async function send(features, msg) {
  if (!isConfigured(features)) return false;
  if (!msg || !msg.to || !msg.text) return false;
  const provider = features.sms.provider;

  if (provider === 'twilio') {
    let twilio;
    try { twilio = require('twilio'); }
    catch {
      throw new Error('twilio SDK not installed — run `npm i twilio`');
    }
    const client = twilio(secrets.get('TWILIO_ACCOUNT_SID'), secrets.get('TWILIO_AUTH_TOKEN'));
    await client.messages.create({
      from: secrets.get('TWILIO_FROM'),
      to: String(msg.to),
      body: String(msg.text).slice(0, 1600),
    });
    return true;
  }

  if (provider === 'thsms') {
    // thsms.com REST: POST https://api.thsms.com/api/rest with key/secret + to/text.
    // This is a minimal integration — adjust to whatever endpoint shape the
    // current Thai SMS aggregator you use exposes.
    const https = require('https');
    const body = new URLSearchParams({
      key: secrets.get('THSMS_API_KEY'),
      secret: secrets.get('THSMS_API_SECRET'),
      msisdn: String(msg.to),
      message: String(msg.text).slice(0, 480),
      sender: secrets.get('THSMS_SENDER') || 'BAANKARN',
    }).toString();
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.thsms.com', path: '/api/rest', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length },
        timeout: 8000,
      }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(true);
          else reject(new Error(`thsms HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('thsms timeout')); });
      req.write(body);
      req.end();
    });
  }

  throw new Error(`SMS provider '${provider}' is not implemented. Supported: twilio, thsms.`);
}

module.exports = { send, isConfigured };
