// routes/rooms.js
// Relational `rooms` CRUD. Replaces the JSONB blob (`baankarn_rooms_v1`)
// for new code paths. Existing UI still reads from the blob — admin can
// migrate one room at a time via POST /api/rooms or in bulk via
// POST /api/rooms/migrate-from-jsonb.

const express = require('express');
const { schemas } = require('../schemas');
const { validateBody } = require('../middleware/validate');
const roomSync = require('../services/roomSync');

module.exports = function buildRoomsRouter(ctx) {
  const { pool, requireAuth, requireRole, sameOrigin, csrfGuard, audit } = ctx;
  const r = express.Router();

  // === Schema ============================================================
  // rooms_v2 is now created by db/migrate.js (single source of truth) so
  // every code path that runs migrations gets the schema, not just paths
  // that mount this router. Bootstrap kept as a no-op alias for backwards
  // compatibility with routes/index.js's bootstrap collection + the
  // existing integration test that pins this method's existence.
  r.bootstrap = async () => { /* no-op: schema lives in db/migrate.js */ };

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

  // POST /api/rooms/migrate-from-jsonb — backfill rooms_v2 from the legacy
  // app_data['baankarn_rooms_v1'] blob. Safe to re-run; it upserts by
  // room_code and does not touch tenants, bills, or contracts.
  r.post('/migrate-from-jsonb', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'), async (req, res) => {
    const dryRun = req.body?.dryRun === true || req.query.dryRun === '1' || req.query.dryRun === 'true';
    try {
      const result = await roomSync.upsertRoomsV2FromJsonb(pool, {
        dryRun,
        updatedBy: req.session?.user?.username || 'admin',
      });
      if (!dryRun) {
        audit(req, 'room.migrate_from_jsonb', 'rooms_v2', 'bulk', result);
      }
      res.json({ ok: true, result });
    } catch (err) {
      console.error('rooms migrate-from-jsonb error:', err);
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
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
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
        await roomSync.upsertJsonbRoomFromV2(client, rows[0], req.session.user.username);
        await client.query('COMMIT');
        audit(req, 'room.create', 'room', String(rows[0].id), { code });
        res.json({ ok: true, room: rows[0] });
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch {}
        if (err.code === '23505') {
          return res.status(409).json({ error: 'room_code already exists', code: 'CONFLICT' });
        }
        console.error('rooms create error:', err);
        res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
      } finally {
        client.release();
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
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: prev } = await client.query(
          `SELECT * FROM rooms_v2 WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
          [id]
        );
        if (!prev.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'not found' });
        }
        if (b.roomCode && b.roomCode !== prev[0].room_code) {
          const refs = await roomSync.roomDeleteRefs(client, prev[0].room_code);
          if (refs.total > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: 'เปลี่ยนเลขห้องไม่ได้ — ยังมีผู้เช่า/บิล/สัญญา/งานซ่อม/จองอ้างถึงห้องนี้',
              code: 'ROOM_HAS_REFS',
              refs: refs.refs,
            });
          }
        }
        const { rows } = await client.query(
          `UPDATE rooms_v2 SET ${fields.join(', ')}
             WHERE id=$${i} AND deleted_at IS NULL RETURNING *`,
          params
        );
        if (!rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'not found' });
        }
        if (prev[0].room_code !== rows[0].room_code) {
          await roomSync.removeJsonbRoom(client, prev[0].room_code, req.session.user.username);
        }
        await roomSync.upsertJsonbRoomFromV2(client, rows[0], req.session.user.username);
        await client.query('COMMIT');
        audit(req, 'room.update', 'room', String(id),
          { before: prev[0], after: rows[0], changed: Object.keys(b) });
        res.json({ ok: true, room: rows[0] });
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch {}
        if (err.code === '23505') {
          return res.status(409).json({ error: 'room_code already exists', code: 'CONFLICT' });
        }
        console.error('rooms update error:', err);
        res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
      } finally {
        client.release();
      }
    }
  );

  // DELETE /api/rooms/:id — soft delete. Owner only.
  r.delete('/:id', sameOrigin, csrfGuard, requireAuth, requireRole('owner'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const room = await client.query(
        `SELECT * FROM rooms_v2 WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [id]
      );
      if (!room.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'not found' });
      }
      const code = room.rows[0].room_code;
      const refs = await roomSync.roomDeleteRefs(client, code);
      if (refs.total > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'ลบห้องไม่ได้ — ยังมีผู้เช่า/บิล/สัญญา/งานซ่อม/จองอ้างถึงห้องนี้',
          code: 'ROOM_HAS_REFS',
          refs: refs.refs,
        });
      }
      const blob = await client.query(
        `SELECT value->$1 AS room FROM app_data WHERE key='baankarn_rooms_v1' LIMIT 1`,
        [code]
      );
      const blobRoom = blob.rows[0]?.room;
      if (blobRoom && typeof blobRoom === 'object') {
        const blockedByBlob = !!blobRoom.tenant
          || (blobRoom.status && !['vacant', 'maintenance'].includes(String(blobRoom.status)));
        if (blockedByBlob) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'ลบห้องไม่ได้ — ข้อมูลห้องในระบบเดิมยังมีผู้เช่าหรือสถานะไม่ว่าง',
            code: 'ROOM_BLOB_OCCUPIED',
          });
        }
      }
      const { rows } = await client.query(
        `UPDATE rooms_v2 SET deleted_at=NOW(), updated_at=NOW()
          WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
        [id]
      );
      await roomSync.removeJsonbRoom(client, code, req.session.user.username);
      await client.query('COMMIT');
      audit(req, 'room.delete', 'room', String(id), { code });
      res.json({ ok: true });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    } finally {
      client.release();
    }
  });

  // POST /api/rooms/:id/restore — undo soft delete
  r.post('/:id/restore', sameOrigin, csrfGuard, requireAuth, requireRole('owner'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE rooms_v2 SET deleted_at=NULL, updated_at=NOW() WHERE id=$1 RETURNING *`,
        [id]
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'not found' });
      }
      await roomSync.upsertJsonbRoomFromV2(client, rows[0], req.session.user.username);
      await client.query('COMMIT');
      audit(req, 'room.restore', 'room', String(id), { code: rows[0].room_code });
      res.json({ ok: true, room: rows[0] });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    } finally {
      client.release();
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
