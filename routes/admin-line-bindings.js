// routes/admin-line-bindings.js
// Admin REST for LINE OA binding lifecycle. Owner/manager only.
//
//   GET    /api/admin/line-bindings                   — overview (all tenants)
//   GET    /api/admin/line-bindings/tenants/:id       — single tenant detail
//   POST   /api/admin/line-bindings/tenants/:id       — issue new code
//   DELETE /api/admin/line-bindings/tenants/:id/codes/:bindingId — revoke unused pending code
//   DELETE /api/admin/line-bindings/tenants/:id       — revoke + unbind
//   POST   /api/admin/line-bindings/tenants/:id/block — block (no future bindings)
//   POST   /api/admin/line-bindings/tenants/:id/unblock
//   GET    /api/admin/line-bindings/tenants/:id/qr    — PNG QR of the current code

const express = require('express');
const QRCode = require('qrcode');
const lineBinding = require('../services/lineBinding');

function lineBindingIssueErrorPayload(err) {
  const code = err && err.code ? String(err.code) : 'LINE_BINDING_ISSUE_FAILED';
  const messages = {
    INVALID_TENANT_ID: 'รหัสผู้เช่าไม่ถูกต้อง กรุณารีเฟรชหน้าแล้วลองใหม่',
    INVALID_TTL_DAYS: 'อายุคีย์ LINE ต้องอยู่ระหว่าง 1-30 วัน',
    INVALID_TARGET_OA: 'LINE OA ที่เลือกไม่ถูกต้อง กรุณาเลือก LINE OA ใหม่',
    TARGET_OA_NOT_AVAILABLE: 'LINE OA ที่เลือกไม่มีอยู่หรือถูกปิดอยู่ กรุณาเปิดใช้งานหรือเลือก OA อื่น',
    TENANT_NOT_FOUND: 'ไม่พบผู้เช่ารายนี้ กรุณารีเฟรชหน้าแล้วตรวจสอบอีกครั้ง',
    TENANT_LINE_BINDING_BLOCKED: 'ห้องนี้ถูกบล็อกการผูก LINE อยู่ ต้องยกเลิกการบล็อกก่อนออกคีย์',
    TENANT_NOT_ACTIVE_FOR_LINE: 'ออกคีย์ไม่ได้ เพราะผู้เช่ายังไม่เป็นสถานะใช้งานอยู่หรือยังไม่มีห้องปัจจุบัน',
    LINE_BINDING_PENDING_UNIQUE_MIGRATION_REQUIRED:
      'ยังออกคีย์เพิ่มหลายใบไม่ได้ เพราะฐานข้อมูลยังมีข้อจำกัดแบบเก่าอยู่ ให้รัน migration แล้วลองใหม่ คีย์เดิมยังไม่ถูกยกเลิก',
  };
  return {
    status: Number(err && err.status) || (code === 'LINE_BINDING_PENDING_UNIQUE_MIGRATION_REQUIRED' ? 409 : 400),
    body: {
      error: messages[code] || err.message || 'ออกคีย์ LINE ไม่สำเร็จ',
      code,
    },
  };
}

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
      const replacePending = req.body?.replacePending !== false;
      try {
        const result = await lineBinding.issue(pool, {
          tenantId: id, ttlDays, targetOaId, replacePending,
          createdBy: req.session.user.username,
        });
        const detail = await lineBinding.getStatus(pool, id).catch((detailErr) => {
          console.warn('[admin line-binding issue] detail reload failed:', detailErr.message);
          return null;
        });
        audit(req, 'line_binding.issue', 'tenant', String(id), {
          ttlDays,
          targetOaId: result.targetOaId || null,
          replacePending,
        });
        res.json({ ok: true, ...result, detail });
      } catch (err) {
        console.error('admin line-binding issue error:', err.message);
        const payload = lineBindingIssueErrorPayload(err);
        res.status(payload.status).json(payload.body);
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

  r.delete('/tenants/:id/codes/:bindingId', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    async (req, res) => {
      const id = Number(req.params.id);
      const bindingId = Number(req.params.bindingId);
      if (!Number.isInteger(id) || id < 1 || !Number.isInteger(bindingId) || bindingId < 1) {
        return res.status(400).json({
          error: 'รหัสผู้เช่าหรือคีย์ LINE ไม่ถูกต้อง กรุณารีเฟรชหน้ารายละเอียดแล้วลองใหม่',
          code: 'INVALID_BINDING_ID',
        });
      }
      try {
        const result = await lineBinding.revokePendingCode(pool, {
          tenantId: id,
          bindingId,
          by: req.session.user.username,
        });
        if (!result.ok) {
          const statusCode = result.reason === 'not_found' ? 404 : 409;
          const message = result.reason === 'not_found'
            ? 'ไม่พบคีย์รอผูกของห้องนี้ อาจถูกลบไปแล้ว กรุณารีเฟรชหน้ารายละเอียด'
            : 'ลบคีย์นี้ไม่ได้ เพราะสถานะล่าสุดไม่ใช่รอผูก อาจผูกแล้ว/หมดอายุ/ถูกยกเลิกแล้ว กรุณารีเฟรชหน้ารายละเอียด';
          return res.status(statusCode).json({
            error: message,
            code: result.reason === 'not_found' ? 'LINE_BINDING_CODE_NOT_FOUND' : 'LINE_BINDING_CODE_NOT_PENDING',
            status: result.status || null,
          });
        }
        audit(req, 'line_binding.revoke_pending_code', 'tenant', String(id), {
          bindingId,
          code: result.code,
        });
        res.json(result);
      } catch (err) {
        console.error('admin line-binding pending code revoke error:', err);
        res.status(500).json({
          error: 'ยกเลิกคีย์ LINE ไม่สำเร็จ กรุณาลองใหม่ หากยังไม่สำเร็จให้ตรวจสอบสถานะคีย์ก่อน',
          code: 'LINE_BINDING_CODE_REVOKE_FAILED',
        });
      }
    }
  );

  r.delete('/tenants/:id/accounts/:bindingId', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    async (req, res) => {
      const id = Number(req.params.id);
      const bindingId = Number(req.params.bindingId);
      if (!Number.isInteger(id) || id < 1 || !Number.isInteger(bindingId) || bindingId < 1) {
        return res.status(400).json({ error: 'invalid id' });
      }
      try {
        const result = await lineBinding.revokeAccount(pool, {
          tenantId: id,
          bindingId,
          by: req.session.user.username,
        });
        if (!result.ok) return res.status(404).json({ error: 'binding not found', code: 'NOT_FOUND' });
        audit(req, 'line_binding.revoke_account', 'tenant', String(id), {
          bindingId,
          remainingBoundCount: result.remainingBoundCount,
        });
        res.json(result);
      } catch (err) {
        console.error('admin line-binding account revoke error:', err);
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
