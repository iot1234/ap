// routes/rooms.js
// Relational `rooms` CRUD. Replaces the JSONB blob (`baankarn_rooms_v1`)
// for new code paths. Existing UI still reads from the blob — admin can
// migrate one room at a time via POST /api/rooms or in bulk via
// POST /api/rooms/migrate-from-jsonb.

const express = require('express');
const { schemas } = require('../schemas');
const { validateBody } = require('../middleware/validate');

module.exports = function buildRoomsRouter(ctx) {
  const { pool, requireAuth, requireRole, sameOrigin, csrfGuard, audit } = ctx;
  const r = express.Router();

  // === Schema ============================================================
  // Migration is idempotent and hosted in db/migrate.js so it runs at boot.
  // We add the rooms table via this router's bootstrap so routes/* modules
  // remain self-contained when integrators want to opt in/out per feature.
  r.bootstrap = async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rooms_v2 (
        id            BIGSERIAL PRIMARY KEY,
        room_code     TEXT UNIQUE NOT NULL,
        floor         INT NOT NULL,
        room_no       INT NOT NULL,
        room_type     TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'vacant',
        rent_price    NUMERIC(10,2) NOT NULL,
        deposit_price NUMERIC(10,2) NOT NULL DEFAULT 0,
        wifi_fee      NUMERIC(10,2) DEFAULT 0,
        view_type     TEXT,
        has_balcony   BOOLEAN DEFAULT FALSE,
        has_parking   BOOLEAN DEFAULT FALSE,
        has_kitchen   BOOLEAN DEFAULT FALSE,
        has_ac        BOOLEAN DEFAULT TRUE,
        size_sqm      NUMERIC(6,2),
        bed_count     INT DEFAULT 1,
        notes         TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at    TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_rooms_v2_floor ON rooms_v2(floor) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_rooms_v2_status ON rooms_v2(status) WHERE deleted_at IS NULL;
    `);
  };

  function makeRoomCode(floor, roomNo) {
    return `${floor}${String(roomNo).padStart(2, '0')}`;
  }

  // GET /api/rooms — list (filterable)
  r.get('/', requireAuth, async (req, res) => {
    const params = [];
    const where = ['deleted_at IS NULL'];
    if (req.query.floor) {
      params.push(Number(req.query.floor));
      where.push(`floor = $${params.length}`);
    }
    if (req.query.status) {
      params.push(String(req.query.status).slice(0, 32));
      where.push(`status = $${params.length}`);
    }
    if (req.query.type) {
      params.push(String(req.query.type).slice(0, 32));
      where.push(`room_type = $${params.length}`);
    }
    try {
      const { rows } = await pool.query(
        `SELECT * FROM rooms_v2 WHERE ${where.join(' AND ')}
           ORDER BY floor ASC, room_no ASC LIMIT 1000`,
        params
      );
      res.json({ ok: true, rooms: rows });
    } catch (err) {
      console.error('rooms list error:', err);
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    }
  });

  // GET /api/rooms/:id — single
  r.get('/:id', requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    try {
      const { rows } = await pool.query(`SELECT * FROM rooms_v2 WHERE id=$1`, [id]);
      if (!rows.length) return res.status(404).json({ error: 'not found', code: 'NOT_FOUND' });
      res.json({ ok: true, room: rows[0] });
    } catch (err) {
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    }
  });

  // POST /api/rooms — create. Owner/manager only.
  r.post('/', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    validateBody(schemas.createRoom),
    async (req, res) => {
      const b = req.body;
      const code = b.roomCode || makeRoomCode(b.floor, b.roomNo);
      try {
        const { rows } = await pool.query(
          `INSERT INTO rooms_v2
             (room_code, floor, room_no, room_type, rent_price, deposit_price,
              wifi_fee, view_type, has_balcony, has_parking, has_kitchen, has_ac,
              size_sqm, bed_count, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING *`,
          [
            code, b.floor, b.roomNo, b.roomType,
            b.rentPrice, b.depositPrice, b.wifiFee || 0,
            b.viewType || null,
            !!b.hasBalcony, !!b.hasParking, !!b.hasKitchen, b.hasAc !== false,
            b.sizeSqm || null, b.bedCount || 1,
            b.notes || null,
          ]
        );
        audit(req, 'room.create', 'room', String(rows[0].id), { code });
        res.json({ ok: true, room: rows[0] });
      } catch (err) {
        if (err.code === '23505') {
          return res.status(409).json({ error: 'room_code already exists', code: 'CONFLICT' });
        }
        console.error('rooms create error:', err);
        res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
      }
    }
  );

  // PUT /api/rooms/:id — update. Owner/manager only.
  r.put('/:id', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'),
    validateBody(schemas.updateRoom),
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
      const b = req.body;
      const fields = []; const params = []; let i = 1;
      const map = {
        floor: 'floor', roomNo: 'room_no', roomCode: 'room_code', roomType: 'room_type',
        rentPrice: 'rent_price', depositPrice: 'deposit_price', wifiFee: 'wifi_fee',
        viewType: 'view_type', hasBalcony: 'has_balcony', hasParking: 'has_parking',
        hasKitchen: 'has_kitchen', hasAc: 'has_ac', sizeSqm: 'size_sqm',
        bedCount: 'bed_count', notes: 'notes',
      };
      for (const [k, col] of Object.entries(map)) {
        if (b[k] !== undefined) {
          fields.push(`${col} = $${i++}`); params.push(b[k]);
        }
      }
      if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
      fields.push('updated_at = NOW()');
      params.push(id);
      try {
        const { rows: prev } = await pool.query(`SELECT * FROM rooms_v2 WHERE id=$1`, [id]);
        const { rows } = await pool.query(
          `UPDATE rooms_v2 SET ${fields.join(', ')}
             WHERE id=$${i} AND deleted_at IS NULL RETURNING *`,
          params
        );
        if (!rows.length) return res.status(404).json({ error: 'not found' });
        audit(req, 'room.update', 'room', String(id),
          { before: prev[0], after: rows[0], changed: Object.keys(b) });
        res.json({ ok: true, room: rows[0] });
      } catch (err) {
        console.error('rooms update error:', err);
        res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
      }
    }
  );

  // DELETE /api/rooms/:id — soft delete. Owner only.
  r.delete('/:id', sameOrigin, csrfGuard, requireAuth, requireRole('owner'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    try {
      const { rows } = await pool.query(
        `UPDATE rooms_v2 SET deleted_at=NOW() WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
        [id]
      );
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      audit(req, 'room.delete', 'room', String(id));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    }
  });

  // POST /api/rooms/:id/restore — undo soft delete
  r.post('/:id/restore', sameOrigin, csrfGuard, requireAuth, requireRole('owner'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    try {
      const { rows } = await pool.query(
        `UPDATE rooms_v2 SET deleted_at=NULL, updated_at=NOW() WHERE id=$1 RETURNING id`,
        [id]
      );
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      audit(req, 'room.restore', 'room', String(id));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    }
  });

  // GET /api/rooms/:id/history — tenant history for the room
  r.get('/:id/history', requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    try {
      const room = await pool.query(`SELECT room_code FROM rooms_v2 WHERE id=$1`, [id]);
      if (!room.rows.length) return res.status(404).json({ error: 'not found' });
      const code = room.rows[0].room_code;
      const tenants = await pool.query(
        `SELECT id, full_name, phone, email, status, created_at, deleted_at
           FROM tenants WHERE current_room_id=$1
           ORDER BY created_at DESC LIMIT 100`,
        [code]
      );
      const bills = await pool.query(
        `SELECT id, bill_no, period, total, status, due_date, paid_at, created_at
           FROM bills WHERE room_id=$1 AND deleted_at IS NULL
           ORDER BY created_at DESC LIMIT 50`,
        [code]
      );
      res.json({ ok: true, code, tenants: tenants.rows, bills: bills.rows });
    } catch (err) {
      console.error('rooms history error:', err);
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    }
  });

  return r;
};
