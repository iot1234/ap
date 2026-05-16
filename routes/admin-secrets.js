// routes/admin-secrets.js
// CRUD for encrypted secret store (LINE/SMTP/Sentry/R2 keys etc.).
//
//   GET    /api/admin/secrets          — list (metadata only, never values)
//   PUT    /api/admin/secrets/:key     — set/clear one secret
//   POST   /api/admin/secrets/test     — probe a group (line/smtp) for connectivity
//
// All endpoints owner-only. Values are encrypted at rest via
// services/encryption.js; env vars always override DB so an operator can
// pin a value via Railway Variables when needed.

const express = require('express');
const secrets = require('../services/secrets');

module.exports = function buildAdminSecretsRouter(ctx) {
  const { pool, requireAuth, requireRole, sameOrigin, csrfGuard, audit } = ctx;
  const r = express.Router();

  r.get('/', requireAuth, requireRole('owner'), async (_req, res) => {
    try {
      const items = await secrets.listMetadata(pool);
      // Group for UI rendering convenience
      const groups = {};
      for (const item of items) {
        groups[item.group] = groups[item.group] || [];
        groups[item.group].push(item);
      }
      res.json({ ok: true, items, groups });
    } catch (err) {
      console.error('admin secrets list error:', err);
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    }
  });

  r.put('/:key', sameOrigin, csrfGuard, requireAuth, requireRole('owner'), async (req, res) => {
    const key = String(req.params.key).slice(0, 64);
    const value = req.body?.value;
    const entry = secrets.CATALOG_BY_KEY[key];
    // Reject keys that aren't in the catalog so the table can't be used
    // as an arbitrary key/value dump.
    if (!entry) {
      return res.status(400).json({ error: 'unknown secret key', code: 'INVALID_KEY' });
    }
    // Hidden keys (e.g. PROMPTPAY_TARGET) are managed from a different
    // canonical UI surface — Settings → การชำระเงิน writes to
    // config.payment.promptpay, NOT to this secrets table. Blocking the
    // SET path here keeps the "one write location" invariant even if a
    // caller hits the API directly with curl. We still ALLOW clearing
    // (empty value → DELETE) so admins can purge a stale DB row left
    // over from before the consolidation.
    const isClear = value == null || value === '';
    if (entry.hidden && !isClear) {
      return res.status(400).json({
        error: 'PROMPTPAY_TARGET ตั้งค่าจาก Settings → การชำระเงิน เท่านั้น (ป้องกันตั้งหลายที่)',
        code: 'HIDDEN_KEY_SET',
      });
    }
    try {
      const out = await secrets.set(pool, key, value, req.session.user.username);
      audit(req, isClear ? 'secret.delete' : 'secret.update', 'secret', key);
      res.json({ ok: true, ...out });
    } catch (err) {
      console.error('admin secrets put error:', err);
      res.status(500).json({ error: err.message || 'internal error', code: 'DB_ERROR' });
    }
  });

  r.post('/test', sameOrigin, csrfGuard, requireAuth, requireRole('owner'), async (req, res) => {
    const group = String(req.body?.group || '').slice(0, 16);
    // 'slipverify' tests whichever provider (SlipOK / EasySlip / Slip2Go) the
    // operator picked in features.slipUpload.provider. 'promptpay' still
    // accepted so external callers (and the Settings → Payment tab test
    // button, if added later) can validate the saved target, even though
    // the standalone secrets UI no longer surfaces a promptpay group.
    if (!['line', 'smtp', 'r2', 'promptpay', 'slipverify'].includes(group)) {
      return res.status(400).json({ error: 'group must be one of: line, smtp, r2, promptpay, slipverify' });
    }
    try {
      const result = await secrets.testGroup(group);
      audit(req, 'secret.test', 'secret', group, { ok: result.ok });
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return r;
};
