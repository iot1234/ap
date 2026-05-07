// routes/recurring-charges.js
// CRUD for `recurring_charges` (parking, internet, locker, cleaning, etc).
// Bulk-generate auto-pulls active rows for each room/tenant and adds them
// as line items via services/billing.js.
//
//   GET    /api/recurring-charges          ?roomId=&tenantId=&active=true|false
//   GET    /api/recurring-charges/:id
//   POST   /api/recurring-charges
//   PUT    /api/recurring-charges/:id
//   DELETE /api/recurring-charges/:id
//   POST   /api/recurring-charges/:id/toggle

const express = require('express');
const { z } = require('zod');
const { validateBody } = require('../middleware/validate');

const FREQ = ['monthly', 'quarterly', 'one_off'];

// Pre-process: accept both endAt/startAt (server-canonical) AND endDate/startDate
// (which the existing form uses). Same for room_id/tenant_id snake_case alias.
// This kept us from silently dropping the end-date field on save — Zod strips
// unknown keys by default, so admin's "expires on" was being lost.
const aliasPreprocess = (data) => {
  if (!data || typeof data !== 'object') return data;
  const out = { ...data };
  if (out.endDate != null && out.endAt == null) out.endAt = out.endDate;
  if (out.startDate != null && out.startAt == null) out.startAt = out.startDate;
  if (out.end_at != null && out.endAt == null) out.endAt = out.end_at;
  if (out.start_at != null && out.startAt == null) out.startAt = out.start_at;
  if (out.room_id != null && out.roomId == null) out.roomId = out.room_id;
  if (out.tenant_id != null && out.tenantId == null) out.tenantId = out.tenant_id;
  return out;
};

const baseShape = {
  roomId:    z.string().trim().max(32).nullable().optional().or(z.literal('').transform(() => null)),
  tenantId:  z.coerce.number().int().positive().nullable().optional(),
  label:     z.string().trim().min(1).max(80).optional(),
  amount:    z.coerce.number().nonnegative().max(1_000_000).optional(),
  frequency: z.enum(FREQ).optional(),
  active:    z.boolean().optional(),
  startAt:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().or(z.literal('').transform(() => null)),
  endAt:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().or(z.literal('').transform(() => null)),
  notes:     z.string().max(500).nullable().optional(),
};

const writeSchema = z.preprocess(aliasPreprocess, z.object(baseShape)
  .refine((v) => v.roomId || v.tenantId, {
    message: 'ต้องผูกกับห้อง หรือ ผู้เช่า อย่างน้อยหนึ่งอย่าง',
    path: ['roomId'],
  })
);

// PATCH-style partial schema (used by PUT). Skip the cross-field refine
// when both roomId and tenantId are absent — the existing row already has
// a target so the constraint still holds in DB.
const patchSchema = z.preprocess(aliasPreprocess, z.object(baseShape));

module.exports = function buildRecurringChargesRouter(ctx) {
  const { pool, requireAuth, requireRole, sameOrigin, csrfGuard, audit } = ctx;
  const r = express.Router();

  r.get('/', requireAuth, async (req, res) => {
    const params = [];
    const where = [];
    if (req.query.roomId) {
      params.push(String(req.query.roomId).slice(0, 32));
      where.push(`room_id = $${params.length}`);
    }
    if (req.query.tenantId) {
      const tid = Number(req.query.tenantId);
      if (Number.isInteger(tid) && tid > 0) {
        params.push(tid);
        where.push(`tenant_id = $${params.length}`);
      }
    }
    if (req.query.active === 'true' || req.query.active === '1') {
      where.push(`active = TRUE`);
    } else if (req.query.active === 'false' || req.query.active === '0') {
      where.push(`active = FALSE`);
    }
    try {
      const { rows } = await pool.query(
        `SELECT * FROM recurring_charges
           ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
           ORDER BY room_id NULLS LAST, created_at DESC LIMIT 1000`,
        params
      );
      // Frontend expects { charges: [...] } — keep that shape stable.
      res.json({ ok: true, charges: rows });
    } catch (err) {
      console.error('recurring list error:', err);
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    }
  });

  r.get('/:id', requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    try {
      const { rows } = await pool.query(`SELECT * FROM recurring_charges WHERE id=$1`, [id]);
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true, charge: rows[0] });
    } catch (err) {
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    }
  });

  r.post('/', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    validateBody(writeSchema),
    async (req, res) => {
      const b = req.body;
      if (!b.label) return res.status(400).json({ error: 'label required' });
      if (b.amount == null) return res.status(400).json({ error: 'amount required' });
      try {
        const { rows } = await pool.query(
          `INSERT INTO recurring_charges
             (room_id, tenant_id, label, amount, frequency, active, start_at, end_at, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            b.roomId || null,
            b.tenantId || null,
            b.label,
            b.amount,
            b.frequency || 'monthly',
            b.active !== false,
            b.startAt || null,
            b.endAt || null,
            b.notes || null,
            req.session.user.username,
          ]
        );
        audit(req, 'recurring.create', 'recurring', String(rows[0].id),
          { roomId: b.roomId, tenantId: b.tenantId, label: b.label, amount: b.amount });
        res.json({ ok: true, charge: rows[0] });
      } catch (err) {
        console.error('recurring create error:', err);
        res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
      }
    }
  );

  r.put('/:id', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    validateBody(patchSchema),
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
      const b = req.body;
      const fields = []; const params = []; let i = 1;
      const map = {
        roomId: 'room_id', tenantId: 'tenant_id', label: 'label',
        amount: 'amount', frequency: 'frequency', active: 'active',
        startAt: 'start_at', endAt: 'end_at', notes: 'notes',
      };
      for (const [k, col] of Object.entries(map)) {
        if (b[k] !== undefined) {
          fields.push(`${col} = $${i++}`);
          params.push(b[k] === '' ? null : b[k]);
        }
      }
      if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
      fields.push('updated_at = NOW()');
      params.push(id);
      try {
        const { rows: prev } = await pool.query('SELECT * FROM recurring_charges WHERE id=$1', [id]);
        if (!prev.length) return res.status(404).json({ error: 'not found' });
        const { rows } = await pool.query(
          `UPDATE recurring_charges SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`,
          params
        );
        audit(req, 'recurring.update', 'recurring', String(id),
          { changed: Object.keys(b), before: prev[0], after: rows[0] });
        res.json({ ok: true, charge: rows[0] });
      } catch (err) {
        console.error('recurring update error:', err);
        res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
      }
    }
  );

  r.delete('/:id', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
      try {
        const { rowCount } = await pool.query(`DELETE FROM recurring_charges WHERE id=$1`, [id]);
        if (!rowCount) return res.status(404).json({ error: 'not found' });
        audit(req, 'recurring.delete', 'recurring', String(id));
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
      }
    }
  );

  r.post('/:id/toggle', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
      try {
        const { rows } = await pool.query(
          `UPDATE recurring_charges SET active = NOT active, updated_at=NOW()
             WHERE id=$1 RETURNING active`,
          [id]
        );
        if (!rows.length) return res.status(404).json({ error: 'not found' });
        audit(req, 'recurring.toggle', 'recurring', String(id), { active: rows[0].active });
        res.json({ ok: true, active: rows[0].active });
      } catch (err) {
        res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
      }
    }
  );

  return r;
};
