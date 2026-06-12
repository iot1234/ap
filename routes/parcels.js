// routes/parcels.js
// Parcel arrival register + tenant-facing parcel list.
//
// Admin:
//   GET    /api/parcels
//   GET    /api/parcels/rooms
//   GET    /api/parcels/options
//   GET    /api/parcels/stats
//   POST   /api/parcels
//   PUT    /api/parcels/:id
//   DELETE /api/parcels/:id
//   POST   /api/parcels/:id/photo
//   POST   /api/parcels/:id/pickup
//   POST   /api/parcels/:id/notify
//
// Tenant:
//   GET    /api/tenant/parcels

const crypto = require('crypto');
const express = require('express');
const { schemas } = require('../schemas');
const { validateBody } = require('../middleware/validate');
const features = require('../services/features');
const notifier = require('../services/notifier');
const billing = require('../services/billing');
const storage = require('../services/storage');

const STATUS = new Set(['waiting_pickup', 'picked_up', 'returned', 'cancelled']);
const CLOSED_STATUS = new Set(['picked_up', 'returned', 'cancelled']);
const PARCEL_PHOTO_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const PARCEL_PHOTO_MAX_BYTES = 1_500_000;

function adminName(req) {
  return req.session?.user?.username || req.session?.user?.id || 'admin';
}

function makeParcelNo() {
  // localTodayYmd, not toISOString — a parcel logged before 07:00 Bangkok
  // must not carry yesterday's (UTC) date in its number.
  const day = billing.localTodayYmd().replace(/-/g, '');
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `PCL-${day}-${suffix}`;
}

function cleanNullable(v) {
  const s = v == null ? '' : String(v).trim();
  return s ? s : null;
}

function publicParcel(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    tenant_id: row.tenant_id == null ? null : Number(row.tenant_id),
    tenantId: row.tenant_id == null ? null : Number(row.tenant_id),
    parcelNo: row.parcel_no,
    roomId: row.room_id,
    recipientName: row.recipient_name,
    recipientPhone: row.recipient_phone,
    trackingNo: row.tracking_no,
    shelfLocation: row.shelf_location,
    lastNotifyStatus: row.last_notify_status,
    lastNotifyChannel: row.last_notify_channel,
    lastNotifyError: row.last_notify_error,
    notifyAttemptCount: Number(row.notify_attempt_count || 0),
    notifySuccessCount: Number(row.notify_success_count || 0),
    notifyChannels: Array.isArray(row.notify_channels) ? row.notify_channels : [],
    photoFileId: row.photo_file_id == null ? null : Number(row.photo_file_id),
    photoUrl: row.photo_url || null,
    pickupProofFileId: row.pickup_proof_file_id == null ? null : Number(row.pickup_proof_file_id),
    pickupProofUrl: row.pickup_proof_url || null,
    notifiedAt: row.notified_at,
    pickedUpAt: row.picked_up_at,
    pickedUpBy: row.picked_up_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function errBody(error, code, hint, extra) {
  return {
    error,
    code,
    message: error,
    ...(hint ? { hint } : {}),
    ...(extra || {}),
  };
}

async function loadActiveTenant(pool, roomId) {
  const { rows } = await pool.query(
    `SELECT id, full_name, phone, email, line_user_id, line_oa_id,
            current_room_id, status, deleted_at
       FROM tenants
      WHERE current_room_id=$1
        AND status='active'
        AND deleted_at IS NULL
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT 2`,
    [roomId]
  );
  if (rows.length === 0) {
    return {
      error: {
        status: 404,
        body: errBody(
          'ยังไม่พบผู้เช่าที่กำลังอยู่ในห้องนี้',
          'ACTIVE_TENANT_NOT_FOUND',
          'ตรวจเลขห้องให้ถูกต้อง หรือผูกผู้เช่า active กับห้องนี้ก่อนบันทึกพัสดุ'
        ),
      },
    };
  }
  if (rows.length > 1) {
    return {
      error: {
        status: 409,
        body: errBody(
          'ห้องนี้มีผู้เช่า active มากกว่า 1 ราย',
          'AMBIGUOUS_ACTIVE_TENANT',
          'แก้ข้อมูลผู้เช่าให้เหลือ active แค่ 1 รายต่อห้องก่อนส่งแจ้งเตือนพัสดุ',
          { tenantIds: rows.map((r) => Number(r.id)) }
        ),
      },
    };
  }
  return { tenant: rows[0] };
}

function composeParcelMessage(parcel, tenant, customMessage) {
  const lines = [
    `มีพัสดุถึงห้อง ${parcel.room_id}`,
    `ผู้รับ: ${parcel.recipient_name || tenant.full_name || '-'}`,
  ];
  if (parcel.carrier) lines.push(`ขนส่ง: ${parcel.carrier}`);
  if (parcel.tracking_no) lines.push(`เลขพัสดุ: ${parcel.tracking_no}`);
  if (parcel.shelf_location) lines.push(`จุดรับ: ${parcel.shelf_location}`);
  if (parcel.note) lines.push(`หมายเหตุ: ${parcel.note}`);
  if (customMessage) lines.push('', customMessage);
  lines.push('', 'กรุณาติดต่อสำนักงานเพื่อรับพัสดุ');
  return lines.join('\n');
}

function notifyOutcome(result) {
  if (result?.ok) {
    return {
      status: 'sent',
      channel: result.channel || 'unknown',
      error: null,
      notice: {
        kind: 'success',
        title: 'ส่งแจ้งเตือนแล้ว',
        message: `ส่งผ่าน ${result.channel || 'ช่องทางแจ้งเตือน'} สำเร็จ`,
      },
    };
  }
  if (result?.queued) {
    return {
      status: 'queued',
      channel: result.channel || 'queue',
      error: result.reason || null,
      notice: {
        kind: 'warning',
        title: 'เข้าคิวส่งแจ้งเตือนแล้ว',
        message: 'ช่องทางหลักยังส่งไม่สำเร็จ ระบบเก็บเข้าคิวและจะลองส่งซ้ำอัตโนมัติ',
      },
    };
  }
  if (result?.channelsDisabled) {
    return {
      status: 'disabled',
      channel: result.channel || 'none',
      error: 'notification channels disabled',
      notice: {
        kind: 'warning',
        title: 'บันทึกพัสดุแล้ว แต่ไม่ได้ส่งแจ้งเตือน',
        message: 'ช่องทางแจ้งเตือนถูกปิดในตั้งค่าระบบ กรุณาเปิด LINE/Email/SMS อย่างน้อย 1 ช่องทาง',
      },
    };
  }
  const reason = result?.reason || result?.error || 'tenant has no reachable channel';
  return {
    status: result?.skipped ? 'skipped' : 'failed',
    channel: result?.channel || 'none',
    error: reason,
    notice: {
      kind: 'warning',
      title: 'บันทึกพัสดุแล้ว แต่ยังส่งแจ้งเตือนไม่ได้',
      message: reason === 'inactive'
        ? 'ผู้เช่าไม่อยู่ในสถานะ active จึงไม่ส่งแจ้งเตือน'
        : 'ยังไม่มีช่องทางติดต่อที่พร้อมใช้งานสำหรับผู้เช่ารายนี้',
    },
  };
}

async function sendParcelNotification(pool, flags, parcel, tenant, customMessage) {
  const subject = `พัสดุใหม่ถึงห้อง ${parcel.room_id}`;
  const text = composeParcelMessage(parcel, tenant, customMessage);
  const result = await notifier.notifyTenant({ pool, features: flags }, tenant, { subject, text });
  return notifyOutcome(result);
}

async function safeSendParcelNotification(pool, flags, parcel, tenant, customMessage) {
  try {
    return await sendParcelNotification(pool, flags, parcel, tenant, customMessage);
  } catch (err) {
    console.error('parcel notification dispatch error:', err);
    return {
      status: 'failed',
      channel: 'none',
      error: err?.message || 'notification dispatch failed',
      notice: {
        kind: 'warning',
        title: 'บันทึกพัสดุแล้ว แต่ยังส่งแจ้งเตือนไม่สำเร็จ',
        message: 'ระบบบันทึกรายการไว้แล้ว สามารถกดส่งแจ้งซ้ำได้จากแถวพัสดุ',
      },
    };
  }
}

function publicParcelRoom(row) {
  return {
    roomId: row.current_room_id,
    tenantId: Number(row.tenant_id),
    tenantName: row.full_name || '',
    phone: row.phone || '',
    email: row.email || '',
    label: `ห้อง ${row.current_room_id} · ${row.full_name || '-'}`,
  };
}

async function updateNotifyState(pool, parcelId, outcome, opts = {}) {
  const attempted = opts.attempted !== false;
  const { rows } = await pool.query(
    `UPDATE parcels
        SET notified_at = CASE WHEN $2 IN ('sent','queued') THEN NOW() ELSE notified_at END,
            last_notify_status = $2,
            last_notify_channel = $3,
            last_notify_error = $4,
            notify_attempt_count = COALESCE(notify_attempt_count, 0) + CASE WHEN $5::boolean THEN 1 ELSE 0 END,
            notify_success_count = COALESCE(notify_success_count, 0) + CASE WHEN $5::boolean AND $2 IN ('sent','queued') THEN 1 ELSE 0 END,
            notify_channels = CASE
              WHEN $5::boolean
                AND $3 IS NOT NULL
                AND $3 <> ''
                AND $3 NOT IN ('none','unknown')
                AND NOT ($3 = ANY(COALESCE(notify_channels, '{}'::TEXT[])))
              THEN array_append(COALESCE(notify_channels, '{}'::TEXT[]), $3)
              ELSE COALESCE(notify_channels, '{}'::TEXT[])
            END,
            updated_at = NOW()
      WHERE id=$1 AND deleted_at IS NULL
      RETURNING *`,
    [parcelId, outcome.status, outcome.channel || null, outcome.error || null, attempted]
  );
  return rows[0] || null;
}

async function safeUpdateNotifyState(pool, parcelId, outcome, opts) {
  try {
    return await updateNotifyState(pool, parcelId, outcome, opts);
  } catch (err) {
    console.error('parcel notify state update error:', err);
    return null;
  }
}

async function saveParcelPhoto(pool, parcelId, photoDataUrl, uploadedBy) {
  const prevQ = await pool.query(
    `SELECT id, photo_file_id
       FROM parcels
      WHERE id=$1 AND deleted_at IS NULL
      LIMIT 1`,
    [parcelId]
  );
  if (!prevQ.rows.length) return { missing: true };
  let saved = null;
  try {
    saved = await storage.saveBase64({
      pool,
      category: 'parcel_photo',
      dataUrl: photoDataUrl,
      refId: String(parcelId),
      uploadedBy,
      maxBytes: PARCEL_PHOTO_MAX_BYTES,
      allowedMimes: PARCEL_PHOTO_MIMES,
    });
  } catch (err) {
    return { invalid: true, error: err?.message || 'invalid parcel photo' };
  }
  try {
    const { rows } = await pool.query(
      `UPDATE parcels
          SET photo_file_id=$2,
              photo_url=$3,
              updated_at=NOW()
        WHERE id=$1 AND deleted_at IS NULL
        RETURNING *`,
      [parcelId, saved.id, saved.url]
    );
    const previousFileId = Number(prevQ.rows[0].photo_file_id || 0);
    if (previousFileId && previousFileId !== Number(saved.id)) {
      storage.remove(pool, previousFileId).catch((err) => {
        console.warn('parcel old photo cleanup failed:', err.message);
      });
    }
    return { parcel: rows[0] || null, file: saved };
  } catch (err) {
    if (saved?.id) storage.remove(pool, saved.id).catch(() => {});
    throw err;
  }
}

module.exports = function buildParcelsRouter(ctx) {
  const { pool, requireAuth, requireRole, requireTenant, sameOrigin, csrfGuard, audit } = ctx;
  const admin = express.Router();
  const tenant = express.Router();

  admin.use(requireAuth, requireRole('owner', 'manager', 'staff'), features.requireFeature('parcelNotifications'));

  admin.get('/', async (req, res) => {
    const where = ['p.deleted_at IS NULL'];
    const params = [];
    const status = String(req.query.status || '').trim();
    if (status && status !== 'all') {
      const normalized = status === 'open' ? 'waiting_pickup' : status;
      if (STATUS.has(normalized)) {
        params.push(normalized);
        where.push(`p.status=$${params.length}`);
      }
    }
    const roomId = cleanNullable(req.query.roomId);
    if (roomId) {
      params.push(roomId.slice(0, 32));
      where.push(`p.room_id=$${params.length}`);
    }
    const q = cleanNullable(req.query.q);
    if (q) {
      params.push(`%${q.slice(0, 120)}%`);
      const i = params.length;
      where.push(`(
        p.parcel_no ILIKE $${i}
        OR p.room_id ILIKE $${i}
        OR p.recipient_name ILIKE $${i}
        OR p.recipient_phone ILIKE $${i}
        OR p.carrier ILIKE $${i}
        OR p.tracking_no ILIKE $${i}
        OR t.full_name ILIKE $${i}
        OR t.phone ILIKE $${i}
      )`);
    }
    try {
      const { rows } = await pool.query(
        `SELECT p.*, t.full_name AS tenant_name, t.phone AS tenant_phone, t.email AS tenant_email
           FROM parcels p
           LEFT JOIN tenants t ON t.id = p.tenant_id
          WHERE ${where.join(' AND ')}
          ORDER BY p.created_at DESC
          LIMIT 500`,
        params
      );
      res.json({ ok: true, parcels: rows.map(publicParcel) });
    } catch (err) {
      console.error('parcels list error:', err);
      res.status(500).json(errBody('โหลดรายการพัสดุไม่สำเร็จ', 'DB_ERROR'));
    }
  });

  admin.get('/rooms', async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `WITH active_rooms AS (
           SELECT current_room_id, COUNT(*)::int AS active_count
             FROM tenants
            WHERE deleted_at IS NULL
              AND status='active'
              AND COALESCE(TRIM(current_room_id), '') <> ''
            GROUP BY current_room_id
         )
         SELECT t.id AS tenant_id, t.full_name, t.phone, t.email, t.current_room_id
           FROM tenants t
           JOIN active_rooms ar ON ar.current_room_id = t.current_room_id
          WHERE t.deleted_at IS NULL
            AND t.status='active'
            AND ar.active_count = 1
          ORDER BY t.current_room_id`
      );
      const conflictQ = await pool.query(
        `SELECT current_room_id AS room_id,
                COUNT(*)::int AS active_count,
                ARRAY_AGG(full_name ORDER BY id) AS tenant_names
           FROM tenants
          WHERE deleted_at IS NULL
            AND status='active'
            AND COALESCE(TRIM(current_room_id), '') <> ''
          GROUP BY current_room_id
         HAVING COUNT(*) > 1
          ORDER BY current_room_id
          LIMIT 50`
      );
      res.json({
        ok: true,
        rooms: rows.map(publicParcelRoom),
        conflicts: conflictQ.rows.map((r) => ({
          roomId: r.room_id,
          activeCount: Number(r.active_count || 0),
          tenantNames: Array.isArray(r.tenant_names) ? r.tenant_names : [],
        })),
      });
    } catch (err) {
      console.error('parcel rooms list error:', err);
      res.status(500).json(errBody('โหลดรายการห้องสำหรับพัสดุไม่สำเร็จ', 'DB_ERROR'));
    }
  });

  admin.get('/options', async (_req, res) => {
    try {
      const { rows: carrierRows } = await pool.query(
        `SELECT carrier AS value, COUNT(*)::int AS count
           FROM parcels
          WHERE deleted_at IS NULL
            AND COALESCE(TRIM(carrier), '') <> ''
          GROUP BY carrier
          ORDER BY COUNT(*) DESC, carrier
          LIMIT 100`
      );
      const { rows: shelfRows } = await pool.query(
        `SELECT shelf_location AS value, COUNT(*)::int AS count
           FROM parcels
          WHERE deleted_at IS NULL
            AND COALESCE(TRIM(shelf_location), '') <> ''
          GROUP BY shelf_location
          ORDER BY COUNT(*) DESC, shelf_location
          LIMIT 100`
      );
      res.json({
        ok: true,
        carriers: carrierRows.map((r) => ({ value: r.value, count: Number(r.count || 0) })),
        shelfLocations: shelfRows.map((r) => ({ value: r.value, count: Number(r.count || 0) })),
      });
    } catch (err) {
      console.error('parcel options list error:', err);
      res.status(500).json(errBody('โหลดตัวเลือกขนส่ง/จุดรับพัสดุไม่สำเร็จ', 'DB_ERROR'));
    }
  });

  // นับจำนวนจริงต่อสถานะจากฐานข้อมูล — ตัวเลขบนหัวเพจ/ตัวกรองต้องไม่ขึ้นกับ
  // รายการที่ถูกกรองอยู่บนจอ (ไม่อย่างนั้นเลือกดู "รับแล้ว" จะเห็น "รอรับ 0" ทั้งที่มีของค้าง)
  admin.get('/stats', async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT status,
                COUNT(*)::int AS count,
                COUNT(*) FILTER (
                  WHERE status='waiting_pickup'
                    AND created_at < NOW() - INTERVAL '7 days'
                )::int AS aging_count
           FROM parcels
          WHERE deleted_at IS NULL
          GROUP BY status`
      );
      const counts = { waiting_pickup: 0, picked_up: 0, returned: 0, cancelled: 0 };
      let agingWaiting = 0;
      for (const r of rows) {
        if (Object.prototype.hasOwnProperty.call(counts, r.status)) {
          counts[r.status] = Number(r.count || 0);
        }
        if (r.status === 'waiting_pickup') agingWaiting = Number(r.aging_count || 0);
      }
      const all = counts.waiting_pickup + counts.picked_up + counts.returned + counts.cancelled;
      res.json({ ok: true, counts: { ...counts, all }, agingWaiting });
    } catch (err) {
      console.error('parcel stats error:', err);
      res.status(500).json(errBody('โหลดสถิติพัสดุไม่สำเร็จ', 'DB_ERROR'));
    }
  });

  admin.post('/', sameOrigin, csrfGuard, validateBody(schemas.createParcel), async (req, res) => {
    const b = req.body;
    const roomId = b.roomId.trim();
    try {
      const target = await loadActiveTenant(pool, roomId);
      if (target.error) return res.status(target.error.status).json(target.error.body);
      const t = target.tenant;

      let inserted = null;
      for (let attempt = 0; attempt < 4 && !inserted; attempt++) {
        try {
          const parcelNo = makeParcelNo();
          const { rows } = await pool.query(
            `INSERT INTO parcels
               (parcel_no, room_id, tenant_id, recipient_name, recipient_phone,
                carrier, tracking_no, shelf_location, note, status, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'waiting_pickup',$10)
             RETURNING *`,
            [
              parcelNo,
              roomId,
              t.id,
              cleanNullable(b.recipientName) || t.full_name,
              t.phone || null,
              cleanNullable(b.carrier),
              cleanNullable(b.trackingNo),
              cleanNullable(b.shelfLocation),
              cleanNullable(b.note),
              adminName(req),
            ]
          );
          inserted = rows[0];
        } catch (err) {
          if (err.code === '23505' && attempt < 3) continue;
          throw err;
        }
      }
      audit(req, 'parcel.create', 'parcel', String(inserted.id), {
        parcelNo: inserted.parcel_no,
        roomId,
        tenantId: Number(t.id),
        notify: b.notify !== false,
      });

      let row = inserted;
      let notice = {
        kind: 'info',
        title: 'บันทึกพัสดุแล้ว',
        message: 'ยังไม่ได้ส่งแจ้งเตือนตามตัวเลือกที่ปิดไว้',
      };
      if (b.notify !== false) {
        const outcome = await safeSendParcelNotification(pool, req.features, inserted, t, null);
        row = await safeUpdateNotifyState(pool, inserted.id, outcome) || inserted;
        notice = outcome.notice;
        audit(req, 'parcel.notify', 'parcel', String(inserted.id), {
          status: outcome.status,
          channel: outcome.channel,
          error: outcome.error,
        });
      } else {
        row = await safeUpdateNotifyState(pool, inserted.id, {
          status: 'skipped',
          channel: 'none',
          error: 'notify disabled by admin on create',
        }, { attempted: false }) || inserted;
      }
      res.status(201).json({ ok: true, parcel: publicParcel(row), notice });
    } catch (err) {
      console.error('parcels create error:', err);
      res.status(500).json(errBody('บันทึกพัสดุไม่สำเร็จ', 'DB_ERROR'));
    }
  });

  admin.put('/:id', sameOrigin, csrfGuard, validateBody(schemas.updateParcel), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json(errBody('รหัสพัสดุไม่ถูกต้อง', 'INVALID_ID'));
    }
    const b = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const prevQ = await client.query(
        `SELECT * FROM parcels WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [id]
      );
      if (!prevQ.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json(errBody('ไม่พบพัสดุรายการนี้', 'PARCEL_NOT_FOUND'));
      }
      const prev = prevQ.rows[0];
      if (CLOSED_STATUS.has(prev.status) && b.status && b.status !== prev.status) {
        await client.query('ROLLBACK');
        return res.status(409).json(errBody(
          'พัสดุรายการนี้ปิดงานแล้ว ไม่สามารถเปลี่ยนสถานะย้อนกลับได้',
          'PARCEL_TERMINAL',
          'ถ้าบันทึกผิด ให้สร้างรายการใหม่หรือให้ owner ตรวจ audit ก่อนแก้ข้อมูลในฐานข้อมูล'
        ));
      }

      const fields = [];
      const params = [];
      let i = 1;
      const map = {
        recipientName: 'recipient_name',
        carrier: 'carrier',
        trackingNo: 'tracking_no',
        shelfLocation: 'shelf_location',
        note: 'note',
        status: 'status',
      };
      for (const [key, col] of Object.entries(map)) {
        if (b[key] !== undefined) {
          fields.push(`${col}=$${i++}`);
          params.push(cleanNullable(b[key]));
        }
      }
      if (b.status === 'picked_up') {
        fields.push(`picked_up_at=COALESCE(picked_up_at, NOW())`);
        fields.push(`picked_up_by=$${i++}`);
        params.push(cleanNullable(b.pickedUpBy) || adminName(req));
      } else if (b.pickedUpBy !== undefined) {
        fields.push(`picked_up_by=$${i++}`);
        params.push(cleanNullable(b.pickedUpBy));
      }
      if (!fields.length) {
        await client.query('ROLLBACK');
        return res.status(400).json(errBody('ไม่มีข้อมูลให้บันทึก', 'NOTHING_TO_UPDATE'));
      }
      fields.push('updated_at=NOW()');
      params.push(id);
      const { rows } = await client.query(
        `UPDATE parcels SET ${fields.join(', ')}
          WHERE id=$${i} AND deleted_at IS NULL
          RETURNING *`,
        params
      );
      await client.query('COMMIT');
      audit(req, 'parcel.update', 'parcel', String(id), {
        before: { status: prev.status, roomId: prev.room_id },
        changed: Object.keys(b),
        after: { status: rows[0].status },
      });
      res.json({ ok: true, parcel: publicParcel(rows[0]) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('parcels update error:', err);
      res.status(500).json(errBody('อัปเดตพัสดุไม่สำเร็จ', 'DB_ERROR'));
    } finally {
      client.release();
    }
  });

  admin.delete('/:id', sameOrigin, csrfGuard, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json(errBody('รหัสพัสดุไม่ถูกต้อง', 'INVALID_ID'));
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const prevQ = await client.query(
        `SELECT * FROM parcels WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [id]
      );
      if (!prevQ.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json(errBody('ไม่พบพัสดุรายการนี้ หรือถูกลบไปแล้ว', 'PARCEL_NOT_FOUND'));
      }
      const prev = prevQ.rows[0];
      const { rows } = await client.query(
        `UPDATE parcels
            SET deleted_at=NOW(), updated_at=NOW()
          WHERE id=$1 AND deleted_at IS NULL
          RETURNING *`,
        [id]
      );
      await client.query('COMMIT');
      audit(req, 'parcel.delete', 'parcel', String(id), {
        parcelNo: prev.parcel_no,
        roomId: prev.room_id,
        tenantId: prev.tenant_id == null ? null : Number(prev.tenant_id),
        notifyAttemptCount: Number(prev.notify_attempt_count || 0),
        lastNotifyStatus: prev.last_notify_status || null,
        lastNotifyChannel: prev.last_notify_channel || null,
      });
      res.json({
        ok: true,
        parcel: publicParcel(rows[0]),
        notice: {
          kind: 'success',
          title: 'ลบรายการพัสดุแล้ว',
          message: 'รายการนี้ถูกซ่อนจากหน้าแอดมินและผู้เช่าแล้ว แต่ยังมี audit สำหรับตรวจย้อนหลัง',
        },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('parcels delete error:', err);
      res.status(500).json(errBody('ลบพัสดุไม่สำเร็จ', 'DB_ERROR'));
    } finally {
      client.release();
    }
  });

  admin.post('/:id/photo', sameOrigin, csrfGuard, validateBody(schemas.parcelPhoto), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json(errBody('รหัสพัสดุไม่ถูกต้อง', 'INVALID_ID'));
    }
    try {
      const result = await saveParcelPhoto(pool, id, req.body.photo, adminName(req));
      if (result.missing) {
        return res.status(404).json(errBody(
          'ไม่พบพัสดุรายการนี้ หรือถูกลบไปแล้ว',
          'PARCEL_NOT_FOUND',
          'กดรีเฟรชรายการพัสดุ แล้วเลือกรายการที่ยังอยู่ในระบบอีกครั้ง'
        ));
      }
      if (result.invalid) {
        return res.status(400).json(errBody(
          'อัปโหลดรูปพัสดุไม่สำเร็จ',
          'PARCEL_PHOTO_INVALID',
          'เลือกรูป JPG, PNG หรือ WebP และย่อไฟล์ให้ไม่เกินประมาณ 1.5 MB',
          { detail: result.error }
        ));
      }
      audit(req, 'parcel.photo.upload', 'parcel', String(id), {
        fileId: result.file?.id || null,
        size: result.file?.size || null,
        mime: result.file?.mime || null,
      });
      res.json({
        ok: true,
        parcel: publicParcel(result.parcel),
        notice: {
          kind: 'success',
          title: 'บันทึกรูปพัสดุแล้ว',
          message: 'รูปนี้จะแสดงพร้อมรายการพัสดุในหน้าแอดมินและหน้าผู้เช่า',
        },
      });
    } catch (err) {
      console.error('parcel photo upload error:', err);
      res.status(500).json(errBody(
        'อัปโหลดรูปพัสดุไม่สำเร็จ',
        'DB_ERROR',
        'รายการพัสดุยังอยู่ในระบบ ให้ลองเลือกรูปและอัปโหลดอีกครั้งภายหลัง'
      ));
    }
  });

  // ปิดงานรับพัสดุ + แนบหลักฐาน (ถ้ามี) ใน "คำขอเดียว" — ห้ามแยกเป็น 2 ขั้น
  // (เปลี่ยนสถานะก่อนแล้วค่อยอัปโหลดรูป) เพราะถ้ารูปพังจะได้สถานะที่ปิดไปแล้ว
  // โดยไม่มีหลักฐาน ย้อนกลับไม่ได้ ลำดับที่ปลอดภัยคือ:
  //   ล็อกแถว → ตรวจว่ายังรอรับ → เซฟรูป (ถ้าแนบ) → UPDATE → COMMIT
  // พลาดขั้นไหนก็ ROLLBACK ทั้งก้อน สถานะเดิมไม่ถูกแตะ และรูปกำพร้าถูกลบทิ้ง
  admin.post('/:id/pickup', sameOrigin, csrfGuard, validateBody(schemas.pickupParcel), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json(errBody('รหัสพัสดุไม่ถูกต้อง', 'INVALID_ID'));
    }
    const client = await pool.connect();
    let proofFile = null;
    let committed = false;
    try {
      await client.query('BEGIN');
      // FOR UPDATE: กันแอดมิน 2 เครื่องกด "รับแล้ว" พร้อมกัน — เครื่องที่สอง
      // จะรอแถวปลดล็อกแล้วเจอสถานะ picked_up พร้อมข้อความบอกว่าใครรับไปแล้ว
      const prevQ = await client.query(
        `SELECT * FROM parcels WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [id]
      );
      if (!prevQ.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json(errBody(
          'ไม่พบพัสดุรายการนี้ หรือถูกลบไปแล้ว',
          'PARCEL_NOT_FOUND',
          'กดรีเฟรชรายการพัสดุ แล้วตรวจรายการที่ยังอยู่ในระบบอีกครั้ง'
        ));
      }
      const prev = prevQ.rows[0];
      if (prev.status === 'picked_up') {
        await client.query('ROLLBACK');
        const when = prev.picked_up_at ? new Date(prev.picked_up_at).toLocaleString('th-TH') : '-';
        return res.status(409).json(errBody(
          'พัสดุรายการนี้ถูกบันทึกรับไปแล้ว',
          'PARCEL_ALREADY_PICKED',
          `บันทึกรับเมื่อ ${when} โดย ${prev.picked_up_by || '-'} — ถ้ากดซ้ำเพราะหน้าจอไม่อัปเดต ให้รีเฟรชรายการ`,
          { pickedUpAt: prev.picked_up_at, pickedUpBy: prev.picked_up_by || null }
        ));
      }
      if (CLOSED_STATUS.has(prev.status)) {
        await client.query('ROLLBACK');
        return res.status(409).json(errBody(
          'พัสดุรายการนี้ปิดงานแล้ว ไม่สามารถบันทึกรับได้',
          'PARCEL_TERMINAL',
          'รายการที่คืนผู้ส่งหรือยกเลิกไปแล้วจะเปลี่ยนกลับมารับไม่ได้ ถ้าของกลับมาจริงให้สร้างรายการใหม่'
        ));
      }
      if (req.body.proof) {
        try {
          // ใช้ category 'parcel_photo' เดิม: กติกาเข้าถึงไฟล์ใน server.js
          // (แอดมินทุก role + ผู้เช่าเจ้าของพัสดุ) คุ้มครองหลักฐานชุดนี้ให้อัตโนมัติ
          proofFile = await storage.saveBase64({
            pool,
            category: 'parcel_photo',
            dataUrl: req.body.proof,
            refId: String(id),
            uploadedBy: adminName(req),
            maxBytes: PARCEL_PHOTO_MAX_BYTES,
            allowedMimes: PARCEL_PHOTO_MIMES,
          });
        } catch (err) {
          await client.query('ROLLBACK');
          return res.status(400).json(errBody(
            'บันทึกหลักฐานการรับไม่สำเร็จ — ยังไม่ได้เปลี่ยนสถานะพัสดุ',
            'PICKUP_PROOF_INVALID',
            'เลือกรูป JPG, PNG หรือ WebP ขนาดไม่เกินประมาณ 1.5 MB แล้วกดบันทึกรับใหม่ หรือบันทึกรับโดยไม่แนบรูปก็ได้',
            { detail: err?.message || 'invalid pickup proof' }
          ));
        }
      }
      const { rows } = await client.query(
        `UPDATE parcels
            SET status='picked_up',
                picked_up_at=COALESCE(picked_up_at, NOW()),
                picked_up_by=$2,
                pickup_proof_file_id=COALESCE($3, pickup_proof_file_id),
                pickup_proof_url=COALESCE($4, pickup_proof_url),
                updated_at=NOW()
          WHERE id=$1 AND deleted_at IS NULL AND status='waiting_pickup'
          RETURNING *`,
        [
          id,
          cleanNullable(req.body.pickedUpBy) || adminName(req),
          proofFile ? proofFile.id : null,
          proofFile ? proofFile.url : null,
        ]
      );
      if (!rows.length) {
        // ตาข่ายชั้นสุดท้าย — ปกติมาไม่ถึงเพราะล็อกแถวไว้แล้ว
        await client.query('ROLLBACK');
        return res.status(409).json(errBody(
          'สถานะพัสดุเปลี่ยนไประหว่างบันทึก กรุณารีเฟรชแล้วตรวจอีกครั้ง',
          'PARCEL_STATE_CHANGED'
        ));
      }
      await client.query('COMMIT');
      committed = true;
      audit(req, 'parcel.pickup', 'parcel', String(id), {
        parcelNo: prev.parcel_no,
        roomId: prev.room_id,
        tenantId: prev.tenant_id == null ? null : Number(prev.tenant_id),
        pickedUpBy: rows[0].picked_up_by,
        proofFileId: proofFile ? Number(proofFile.id) : null,
        proofAttached: !!proofFile,
      });
      res.json({
        ok: true,
        parcel: publicParcel(rows[0]),
        notice: {
          kind: 'success',
          title: 'บันทึกรับพัสดุแล้ว',
          message: proofFile
            ? `ปิดงาน ${prev.parcel_no} พร้อมหลักฐานการรับเรียบร้อย ผู้เช่าจะเห็นสถานะและรูปหลักฐานในหน้าพัสดุ`
            : `ปิดงาน ${prev.parcel_no} เรียบร้อย (ไม่ได้แนบหลักฐาน) ผู้เช่าจะเห็นสถานะรับแล้วในหน้าพัสดุ`,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('parcel pickup error:', err);
      res.status(500).json(errBody(
        'บันทึกรับพัสดุไม่สำเร็จ',
        'DB_ERROR',
        'สถานะยังเป็นรอรับเหมือนเดิม ลองใหม่อีกครั้ง ถ้ายังไม่ได้ให้ตรวจการเชื่อมต่อฐานข้อมูล'
      ));
    } finally {
      // รูปถูกเซฟผ่าน pool (นอกทรานแซกชัน) — ถ้าปิดงานไม่สำเร็จ ต้องลบไฟล์กำพร้าทิ้ง
      if (!committed && proofFile?.id) {
        storage.remove(pool, proofFile.id).catch((e) => {
          console.warn('parcel pickup proof orphan cleanup failed:', e.message);
        });
      }
      client.release();
    }
  });

  admin.post('/:id/notify', sameOrigin, csrfGuard, validateBody(schemas.notifyParcel), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json(errBody('รหัสพัสดุไม่ถูกต้อง', 'INVALID_ID'));
    }
    try {
      const { rows } = await pool.query(
        `SELECT p.*, t.full_name, t.phone, t.email, t.line_user_id, t.line_oa_id,
                t.current_room_id, t.status AS tenant_status, t.deleted_at AS tenant_deleted_at
           FROM parcels p
           LEFT JOIN tenants t ON t.id = p.tenant_id
          WHERE p.id=$1 AND p.deleted_at IS NULL
          LIMIT 1`,
        [id]
      );
      if (!rows.length) return res.status(404).json(errBody('ไม่พบพัสดุรายการนี้', 'PARCEL_NOT_FOUND'));
      const row = rows[0];
      if (CLOSED_STATUS.has(row.status)) {
        return res.status(409).json(errBody(
          'พัสดุรายการนี้ปิดงานแล้ว ไม่ส่งแจ้งเตือนซ้ำ',
          'PARCEL_ALREADY_CLOSED',
          'รายการที่รับแล้ว/คืนผู้ส่ง/ยกเลิกจะไม่ส่งแจ้งเตือนซ้ำเพื่อป้องกันผู้เช่าสับสน'
        ));
      }
      if (!row.tenant_id) {
        return res.status(409).json(errBody(
          'รายการนี้ยังไม่ผูกกับผู้เช่า',
          'PARCEL_TENANT_MISSING',
          'สร้างรายการใหม่โดยเลือกห้องที่มีผู้เช่า active หรือแก้ข้อมูลผู้เช่าก่อน'
        ));
      }
      const tenantRow = {
        id: row.tenant_id,
        full_name: row.full_name,
        phone: row.phone,
        email: row.email,
        line_user_id: row.line_user_id,
        line_oa_id: row.line_oa_id,
        current_room_id: row.current_room_id,
        status: row.tenant_status,
        deleted_at: row.tenant_deleted_at,
      };
      const outcome = await safeSendParcelNotification(pool, req.features, row, tenantRow, req.body.message || null);
      const updated = await safeUpdateNotifyState(pool, row.id, outcome) || row;
      audit(req, 'parcel.notify', 'parcel', String(row.id), {
        status: outcome.status,
        channel: outcome.channel,
        error: outcome.error,
        manual: true,
      });
      res.json({ ok: true, parcel: publicParcel(updated), notice: outcome.notice });
    } catch (err) {
      console.error('parcels notify error:', err);
      res.status(500).json(errBody('ส่งแจ้งเตือนพัสดุไม่สำเร็จ', 'DB_ERROR'));
    }
  });

  tenant.get('/', requireTenant, features.requireFeature('parcelNotifications'), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT *
           FROM parcels p
          WHERE p.tenant_id=$1
            AND p.deleted_at IS NULL
          ORDER BY
            CASE WHEN p.status='waiting_pickup' THEN 0 ELSE 1 END,
            p.created_at DESC
          LIMIT 200`,
        [req.tenant.tenant_id]
      );
      res.json({ ok: true, parcels: rows.map(publicParcel) });
    } catch (err) {
      console.error('tenant parcels list error:', err);
      res.status(500).json(errBody('โหลดรายการพัสดุไม่สำเร็จ', 'DB_ERROR'));
    }
  });

  return { admin, tenant };
};
