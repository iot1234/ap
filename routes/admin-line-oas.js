// routes/admin-line-oas.js
// Admin REST for managing LINE Official Accounts. Owner-only because
// channel access tokens grant push privileges to every bound user — leaking
// one is equivalent to leaking the building's entire LINE notification
// channel.
//
//   GET    /api/admin/line-oas           — list (no secrets exposed)
//   GET    /api/admin/line-oas/:id       — detail (no secrets exposed)
//   POST   /api/admin/line-oas           — create
//   PUT    /api/admin/line-oas/:id       — update (token/secret optional)
//   DELETE /api/admin/line-oas/:id       — soft-delete (revokes bindings)
//   POST   /api/admin/line-oas/:id/test  — call /v2/bot/info to validate token
//   POST   /api/admin/line-oas/:id/default — flip is_default

const express = require('express');
const lineOa = require('../services/lineOa');

module.exports = function buildAdminLineOasRouter(ctx) {
  const { pool, requireAuth, requireRole, sameOrigin, csrfGuard, audit } = ctx;
  const r = express.Router();

  // List — owner/manager. Manager can view, owner can mutate.
  r.get('/', requireAuth, requireRole('owner', 'manager'), async (req, res) => {
    try {
      const items = await lineOa.list(pool);
      // Tag each row with its webhook URL so admin UI can copy it directly.
      const base = req.headers['x-forwarded-proto'] && req.headers['x-forwarded-host']
        ? `${req.headers['x-forwarded-proto']}://${req.headers['x-forwarded-host']}`
        : `${req.protocol}://${req.get('host')}`;
      const withUrls = items.map((o) => ({
        ...o,
        webhookUrl: o.isEnvOa
          ? `${base}/webhook/line`
          : `${base}/webhook/line/${o.slug}`,
      }));
      res.json({ ok: true, items: withUrls });
    } catch (err) {
      console.error('admin line-oas list error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  r.get('/:id', requireAuth, requireRole('owner', 'manager'), async (req, res) => {
    const id = Number(req.params.id);
    // Reject id <= 0 to match PUT/DELETE — env-OA (id=0) is exposed via
    // the list endpoint as `isEnvOa: true` and edited only via env vars,
    // never via the per-id REST surface.
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    try {
      const oa = await lineOa.getById(pool, id);
      if (!oa) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true, oa });
    } catch (err) {
      console.error('admin line-oas get error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  r.post('/', sameOrigin, csrfGuard, requireAuth, requireRole('owner'), async (req, res) => {
    const body = req.body || {};
    try {
      const oa = await lineOa.create(pool, {
        slug: body.slug,
        name: body.name,
        description: body.description,
        botBasicId: body.botBasicId,
        channelId: body.channelId,
        ownerUserId: body.ownerUserId,
        channelAccessToken: body.channelAccessToken,
        channelSecret: body.channelSecret,
        enabled: body.enabled,
        isDefault: body.isDefault,
      }, req.session.user.username);
      audit(req, 'line_oa.create', 'line_oa', String(oa.id), { slug: oa.slug, name: oa.name });
      res.json({ ok: true, oa });
    } catch (err) {
      console.error('admin line-oas create error:', err.message);
      res.status(400).json({ error: err.message || 'failed' });
    }
  });

  r.put('/:id', sameOrigin, csrfGuard, requireAuth, requireRole('owner'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    try {
      const oa = await lineOa.update(pool, id, req.body || {}, req.session.user.username);
      audit(req, 'line_oa.update', 'line_oa', String(id), {
        // Don't audit token/secret values — only the fact they changed.
        fields: Object.keys(req.body || {}).filter((k) => k !== 'channelAccessToken' && k !== 'channelSecret'),
        rotated_token: req.body && req.body.channelAccessToken !== undefined,
        rotated_secret: req.body && req.body.channelSecret !== undefined,
      });
      res.json({ ok: true, oa });
    } catch (err) {
      console.error('admin line-oas update error:', err.message);
      res.status(400).json({ error: err.message || 'failed' });
    }
  });

  r.delete('/:id', sameOrigin, csrfGuard, requireAuth, requireRole('owner'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    try {
      await lineOa.remove(pool, id, req.session.user.username);
      audit(req, 'line_oa.delete', 'line_oa', String(id));
      res.json({ ok: true });
    } catch (err) {
      console.error('admin line-oas delete error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Test connectivity. Returns LINE's bot info on success or HTTP error
  // details on failure. Updates last_seen_at / last_error on the row.
  r.post('/:id/test', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
      try {
        const result = await lineOa.testConnection(pool, id);
        audit(req, 'line_oa.test', 'line_oa', String(id), { ok: result.ok, status: result.status });
        res.json({ ok: result.ok, ...result });
      } catch (err) {
        res.status(400).json({ ok: false, error: err.message });
      }
    }
  );

  r.post('/:id/default', sameOrigin, csrfGuard, requireAuth, requireRole('owner'),
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
      try {
        await lineOa.update(pool, id, { isDefault: true }, req.session.user.username);
        audit(req, 'line_oa.set_default', 'line_oa', String(id));
        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }
  );

  return r;
};
