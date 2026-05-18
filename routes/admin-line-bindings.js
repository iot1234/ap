// routes/admin-line-bindings.js
// Admin REST for LINE OA binding lifecycle. Owner/manager only.
//
//   GET    /api/admin/line-bindings                   — overview (all tenants)
//   GET    /api/admin/line-bindings/tenants/:id       — single tenant detail
//   POST   /api/admin/line-bindings/tenants/:id       — issue new code (revokes previous pending)
//   DELETE /api/admin/line-bindings/tenants/:id       — revoke + unbind
//   POST   /api/admin/line-bindings/tenants/:id/block — block (no future bindings)
//   POST   /api/admin/line-bindings/tenants/:id/unblock
//   GET    /api/admin/line-bindings/tenants/:id/qr    — PNG QR of the current code

const express = require('express');
const QRCode = require('qrcode');
const lineBinding = require('../services/lineBinding');

module.exports = function buildAdminLineBindingsRouter(ctx) {
  const { pool, requireAuth, requireRole, sameOrigin, csrfGuard, audit } = ctx;
  const r = express.Router();

  r.get('/', requireAuth, requireRole('owner', 'manager'), async (_req, res) => {
    try {
      const rows = await lineBinding.listAll(pool);
      // Aggregate counters for the page header
      const counts = { total: rows.length, pending: 0, bound: 0, unbound: 0, blocked: 0, boundAccounts: 0 };
      for (const row of rows) {
        const boundCount = Number(row.bound_count || 0);
        counts.boundAccounts += boundCount;
        if (row.line_binding_blocked) counts.blocked++;
        else if (row.binding_status === 'pending') counts.pending++;
        else if (row.line_user_id || boundCount > 0) counts.bound++;
        else counts.unbound++;
      }
      res.json({ ok: true, items: rows, counts });
    } catch (err) {
      console.error('admin line-bindings list error:', err);
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    }
  });

  r.get('/tenants/:id', requireAuth, requireRole('owner', 'manager'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    try {
      const status = await lineBinding.getStatus(pool, id);
      if (!status) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true, ...status });
    } catch (err) {
      console.error('admin line-binding get error:', err);
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    }
  });

  r.post('/tenants/:id', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
      const ttlDays = Number(req.body?.ttlDays || 7);
      // Optional targetOaId — when admin picks a specific OA in the UI,
      // the tenant must send the code to THAT OA's webhook for tryBind to
      // accept it. Without this passthrough the constraint silently
      // dropped and any OA could accept any code.
      const targetOaId = req.body?.targetOaId;
      try {
        const result = await lineBinding.issue(pool, {
          tenantId: id, ttlDays, targetOaId,
          createdBy: req.session.user.username,
        });
        audit(req, 'line_binding.issue', 'tenant', String(id), { ttlDays, targetOaId: result.targetOaId || null });
        res.json({ ok: true, ...result });
      } catch (err) {
        console.error('admin line-binding issue error:', err.message);
        res.status(400).json({ error: err.message || 'failed' });
      }
    }
  );

  r.delete('/tenants/:id', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
      try {
        await lineBinding.revoke(pool, { tenantId: id, by: req.session.user.username });
        audit(req, 'line_binding.revoke', 'tenant', String(id));
        res.json({ ok: true });
      } catch (err) {
        console.error('admin line-binding revoke error:', err);
        res.status(500).json({ error: 'internal error' });
      }
    }
  );

  r.post('/tenants/:id/block', sameOrigin, csrfGuard, requireAuth, requireRole('owner'),
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
      const reason = String(req.body?.reason || '').slice(0, 500);
      try {
        await lineBinding.block(pool, { tenantId: id, reason, by: req.session.user.username });
        audit(req, 'line_binding.block', 'tenant', String(id), { reason });
        res.json({ ok: true });
      } catch (err) {
        console.error('admin line-binding block error:', err);
        res.status(500).json({ error: 'internal error' });
      }
    }
  );

  r.post('/tenants/:id/unblock', sameOrigin, csrfGuard, requireAuth, requireRole('owner'),
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
      try {
        await lineBinding.unblock(pool, { tenantId: id });
        audit(req, 'line_binding.unblock', 'tenant', String(id));
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: 'internal error' });
      }
    }
  );

  // GET /tenants/:id/qr — returns a PNG QR of the current pending code so
  // admin can show it on screen / print it for the tenant.
  r.get('/tenants/:id/qr', requireAuth, requireRole('owner', 'manager'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).end();
    try {
      const status = await lineBinding.getStatus(pool, id);
      if (!status || !status.pending) {
        return res.status(404).json({ error: 'no pending code' });
      }
      const png = await QRCode.toBuffer(status.pending.code, {
        type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 360,
        color: { dark: '#2c241b', light: '#ffffff' },
      });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store');
      res.end(png);
    } catch (err) {
      console.error('admin line-binding qr error:', err);
      res.status(500).end();
    }
  });

  return r;
};
