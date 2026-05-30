// services/roomSync.js
//
// Keeps the legacy app_data['baankarn_rooms_v1'] room blob and the relational
// rooms_v2 table aligned. The blob is still the source used by the current
// admin/public room UI and scheduler, while rooms_v2 backs newer API paths.

const VALID_TYPES = new Set(['standard', 'deluxe', 'suite', 'studio']);
const VALID_STATUSES = new Set(['vacant', 'occupied', 'reserved', 'overdue', 'maintenance']);

const TYPE_DEFAULTS = {
  standard: { rent: 4500, size: 24, beds: 1, ac: false },
  deluxe:   { rent: 5800, size: 28, beds: 1, ac: true },
  suite:    { rent: 7500, size: 36, beds: 2, ac: true },
  studio:   { rent: 6800, size: 32, beds: 1, ac: true },
};

function asText(v, max = 1000) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function asNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asInt(v) {
  const n = asNumber(v);
  if (n === null) return null;
  return Number.isInteger(n) ? n : Math.trunc(n);
}

function boolFrom(v, fallback = false) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(s)) return true;
    if (['false', '0', 'no', 'n'].includes(s)) return false;
  }
  return fallback;
}

function normaliseRoomType(v) {
  const s = String(v || '').trim().toLowerCase();
  if (VALID_TYPES.has(s)) return s;
  if (/deluxe|ดีลักซ์/.test(s)) return 'deluxe';
  if (/suite|สวีท/.test(s)) return 'suite';
  if (/studio|สตูดิโอ/.test(s)) return 'studio';
  return 'standard';
}

function normaliseStatus(v) {
  const s = String(v || '').trim().toLowerCase();
  if (VALID_STATUSES.has(s)) return s;
  if (['available', 'empty', 'free'].includes(s)) return 'vacant';
  if (['busy', 'rented'].includes(s)) return 'occupied';
  return 'vacant';
}

// Vacant-family check for guards that compare a RAW status against 'vacant'.
// The JSONB blob legitimately stores legacy 'available'/'empty'/'free' for an
// empty room (old admin UI vocabulary), so a bare `=== 'vacant'` comparison
// wrongly rejects a genuinely-free room. Mirrors the helper in server.js so
// booking / hold / check-in / claim guards all agree. Unknown statuses are
// intentionally NOT treated as vacant (fail safe → block, let admin review).
const VACANT_STATUS_WORDS = new Set(['vacant', 'available', 'empty', 'free']);
function isVacantStatus(s) {
  return VACANT_STATUS_WORDS.has(String(s || '').trim().toLowerCase());
}

function deriveFloorRoomNo(code) {
  const s = String(code || '').trim();
  if (!/^\d{3,4}$/.test(s)) return {};
  const n = Number(s);
  const roomNo = n % 100;
  const floor = Math.floor(n / 100);
  if (floor < 1 || roomNo < 1) return {};
  return { floor, roomNo };
}

function positiveMoney(v, fallback) {
  const n = asNumber(v);
  if (n !== null && n > 0) return Number(n.toFixed(2));
  return Number(fallback.toFixed(2));
}

function nonNegativeMoney(v, fallback = 0) {
  const n = asNumber(v);
  if (n !== null && n >= 0) return Number(n.toFixed(2));
  return Number(fallback.toFixed(2));
}

function normaliseRoomForV2(key, room) {
  if (!room || typeof room !== 'object' || Array.isArray(room)) {
    return { skipped: true, reason: 'room is not an object', key };
  }

  const roomCode = asText(room.id || room.roomCode || key, 32);
  if (!roomCode) return { skipped: true, reason: 'room code missing', key };
  if (String(room.id || room.roomCode || key).trim().length > 32) {
    return { skipped: true, reason: 'room code longer than 32 chars', key: roomCode };
  }

  const parsed = deriveFloorRoomNo(roomCode);
  const floor = asInt(room.floor) || parsed.floor;
  const roomNo = asInt(room.no ?? room.roomNo) || parsed.roomNo;
  if (!Number.isInteger(floor) || floor < 1 || floor > 99) {
    return { skipped: true, reason: 'floor missing/invalid', key: roomCode };
  }
  if (!Number.isInteger(roomNo) || roomNo < 1 || roomNo > 999) {
    return { skipped: true, reason: 'roomNo missing/invalid', key: roomCode };
  }

  const roomType = normaliseRoomType(room.type || room.roomType);
  const defaults = TYPE_DEFAULTS[roomType] || TYPE_DEFAULTS.standard;
  const rent = positiveMoney(room.rent ?? room.rentPrice ?? room.monthlyRent, defaults.rent);
  const deposit = nonNegativeMoney(room.deposit ?? room.depositPrice, rent * 2);
  const wifi = nonNegativeMoney(room.wifi ?? room.wifiFee, 0);
  // Per-room override — set by admin from /admin#rooms when this specific
  // room needs a non-formula rate. Blob shape uses camelCase rentOverride;
  // rooms_v2 column is rent_override. Either source feeds the v2 row.
  const overrideRaw = room.rent_override ?? room.rentOverride;
  const override = overrideRaw == null || overrideRaw === ''
    ? null
    : (Number.isFinite(Number(overrideRaw)) && Number(overrideRaw) > 0 ? Number(Number(overrideRaw).toFixed(2)) : null);
  const overrideReason = asText(room.rent_override_reason ?? room.rentOverrideReason, 500);
  const overrideAt = room.rent_override_at ?? room.rentOverrideAt ?? null;
  const overrideBy = asText(room.rent_override_by ?? room.rentOverrideBy, 64);

  return {
    room_code: roomCode,
    floor,
    room_no: roomNo,
    room_type: roomType,
    status: normaliseStatus(room.status),
    rent_price: rent,
    rent_override: override,
    rent_override_reason: overrideReason,
    rent_override_at: overrideAt,
    rent_override_by: overrideBy,
    deposit_price: deposit,
    wifi_fee: wifi,
    view_type: asText(room.view ?? room.viewType, 64),
    has_balcony: boolFrom(room.balcony ?? room.hasBalcony ?? room.has_balcony, false),
    has_parking: boolFrom(room.parking ?? room.hasParking ?? room.has_parking, false),
    has_kitchen: boolFrom(room.kitchen ?? room.hasKitchen ?? room.has_kitchen, false),
    has_ac: boolFrom(room.hasAc ?? room.has_ac ?? room.ac, defaults.ac),
    size_sqm: nonNegativeMoney(room.sizeSqm ?? room.size, defaults.size),
    bed_count: Math.max(0, Math.min(20, asInt(room.bedCount ?? room.beds) ?? defaults.beds)),
    notes: asText(room.notes, 1000),
  };
}

function normaliseRoomsObject(roomsObj) {
  const out = [];
  const skipped = [];
  if (!roomsObj || typeof roomsObj !== 'object' || Array.isArray(roomsObj)) {
    return { rooms: out, skipped: [{ reason: 'rooms blob is not an object' }] };
  }
  for (const [key, room] of Object.entries(roomsObj)) {
    const normalised = normaliseRoomForV2(key, room);
    if (normalised.skipped) skipped.push(normalised);
    else out.push(normalised);
  }
  out.sort((a, b) => {
    const an = Number(a.room_code);
    const bn = Number(b.room_code);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.room_code.localeCompare(b.room_code);
  });
  return { rooms: out, skipped };
}

async function loadLegacyRooms(pool) {
  const { rows } = await pool.query(
    `SELECT value FROM app_data WHERE key='baankarn_rooms_v1' LIMIT 1`
  );
  const value = rows[0]?.value;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function upsertRoomsV2FromJsonb(pool, opts = {}) {
  const dryRun = opts.dryRun === true;
  const updatedBy = opts.updatedBy || 'room-sync';
  const roomsObj = opts.roomsObj || await loadLegacyRooms(pool);
  const { rooms, skipped } = normaliseRoomsObject(roomsObj);
  const codes = rooms.map((r) => r.room_code);
  let existing = new Set();

  if (codes.length) {
    const ex = await pool.query(
      `SELECT room_code FROM rooms_v2 WHERE room_code = ANY($1::text[])`,
      [codes]
    );
    existing = new Set(ex.rows.map((r) => r.room_code));
  }

  const summary = {
    dryRun,
    sourceRooms: Object.keys(roomsObj || {}).length,
    normalised: rooms.length,
    skipped,
    inserted: rooms.filter((r) => !existing.has(r.room_code)).length,
    updated: rooms.filter((r) => existing.has(r.room_code)).length,
  };
  if (dryRun || rooms.length === 0) return summary;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const room of rooms) {
      await client.query(
        `INSERT INTO rooms_v2
           (room_code, floor, room_no, room_type, status, rent_price,
            rent_override, rent_override_reason, rent_override_at, rent_override_by,
            deposit_price, wifi_fee, view_type, has_balcony, has_parking,
            has_kitchen, has_ac, size_sqm, bed_count, notes, deleted_at)
         VALUES
           ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NULL)
         ON CONFLICT (room_code) DO UPDATE SET
           floor=EXCLUDED.floor,
           room_no=EXCLUDED.room_no,
           room_type=EXCLUDED.room_type,
           status=EXCLUDED.status,
           rent_price=EXCLUDED.rent_price,
           rent_override=EXCLUDED.rent_override,
           rent_override_reason=EXCLUDED.rent_override_reason,
           rent_override_at=EXCLUDED.rent_override_at,
           rent_override_by=EXCLUDED.rent_override_by,
           deposit_price=EXCLUDED.deposit_price,
           wifi_fee=EXCLUDED.wifi_fee,
           view_type=EXCLUDED.view_type,
           has_balcony=EXCLUDED.has_balcony,
           has_parking=EXCLUDED.has_parking,
           has_kitchen=EXCLUDED.has_kitchen,
           has_ac=EXCLUDED.has_ac,
           size_sqm=EXCLUDED.size_sqm,
           bed_count=EXCLUDED.bed_count,
           notes=EXCLUDED.notes,
           deleted_at=NULL,
           updated_at=NOW()`,
        [
          room.room_code, room.floor, room.room_no, room.room_type, room.status,
          room.rent_price, room.rent_override, room.rent_override_reason,
          room.rent_override_at, room.rent_override_by,
          room.deposit_price, room.wifi_fee, room.view_type,
          room.has_balcony, room.has_parking, room.has_kitchen, room.has_ac,
          room.size_sqm, room.bed_count, room.notes,
        ]
      );
    }
    await client.query('COMMIT');
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail)
       VALUES ($1, 'room.sync_from_jsonb', 'rooms_v2', 'bulk', $2::jsonb)`,
      [updatedBy, JSON.stringify(summary)]
    ).catch(() => {});
    return summary;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

function rowToBlobRoom(row) {
  const roomType = normaliseRoomType(row.room_type);
  const defaults = TYPE_DEFAULTS[roomType] || TYPE_DEFAULTS.standard;
  const rent = positiveMoney(row.rent_price, defaults.rent);
  const deposit = nonNegativeMoney(row.deposit_price, rent * 2);
  // Carry the override forward into the JSONB blob so the legacy admin
  // UI can read it without joining to rooms_v2. Bill generation reads
  // either shape via services/pricing.js#resolveBillingRent.
  const overrideRaw = row.rent_override;
  const rentOverride = overrideRaw == null || overrideRaw === ''
    ? null
    : (Number.isFinite(Number(overrideRaw)) && Number(overrideRaw) > 0 ? Number(overrideRaw) : null);
  // IMPORTANT: emit ONLY the physical/relational attributes this endpoint owns.
  // The blob is merged as `existing || blobRoom` (jsonb concat — right side
  // wins), so any key we emit OVERWRITES the live blob. Previously this also
  // emitted occupancy + meter + billing keys (tenant:null, waterUnits:0,
  // billStatus:'none', …); a routine room edit (rent/notes/wifi) then WIPED the
  // tenant name, move-in date, contract-end and last meter units that the admin
  // billing page reads — silent data loss on every occupied-room edit. Those
  // keys are owned by checkin/checkout, meter entry, and bill-gen respectively,
  // so we no longer touch them here. A brand-new room simply has them absent and
  // the reader defaults them (vacant / 0 units).
  return {
    id: row.room_code,
    floor: Number(row.floor),
    no: Number(row.room_no),
    type: roomType,
    status: normaliseStatus(row.status),
    rent,
    rentOverride,
    rentOverrideReason: row.rent_override_reason || null,
    rentOverrideAt: row.rent_override_at || null,
    rentOverrideBy: row.rent_override_by || null,
    deposit,
    wifi: nonNegativeMoney(row.wifi_fee, 0),
    notes: row.notes || '',
    view: row.view_type || '',
    balcony: !!row.has_balcony,
    parking: !!row.has_parking,
    kitchen: !!row.has_kitchen,
  };
}

async function upsertJsonbRoomFromV2(pool, row, updatedBy = 'room-sync') {
  if (!row || !row.room_code) return;
  const blobRoom = rowToBlobRoom(row);
  await pool.query(
    `INSERT INTO app_data (key, value, updated_by)
     VALUES ('baankarn_rooms_v1', '{}'::jsonb, $1)
     ON CONFLICT (key) DO NOTHING`,
    [updatedBy]
  );
  await pool.query(
    `UPDATE app_data
        SET value = value || jsonb_build_object(
                      $1::text,
                      COALESCE(value->$1, '{}'::jsonb) || $2::jsonb
                    ),
            updated_at = NOW(),
            updated_by = $3
      WHERE key='baankarn_rooms_v1'`,
    [row.room_code, JSON.stringify(blobRoom), updatedBy]
  );
}

async function removeJsonbRoom(pool, roomCode, updatedBy = 'room-sync') {
  await pool.query(
    `UPDATE app_data
        SET value = value - $1::text,
            updated_at = NOW(),
            updated_by = $2
      WHERE key='baankarn_rooms_v1' AND value ? $1::text`,
    [roomCode, updatedBy]
  );
}

async function roomDeleteRefs(pool, roomCode) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM tenants
          WHERE current_room_id=$1 AND status='active' AND deleted_at IS NULL) AS active_tenants,
       (SELECT COUNT(*)::int FROM bills
          WHERE room_id=$1 AND deleted_at IS NULL AND status <> 'void') AS bills,
       (SELECT COUNT(*)::int FROM contracts
          WHERE room_id=$1 AND deleted_at IS NULL AND status IN ('active','pending','signed')) AS contracts,
       (SELECT COUNT(*)::int FROM maintenance_tickets
          WHERE room_id=$1 AND status NOT IN ('completed','cancelled')) AS open_tickets,
       -- Active bookings live canonically in the JSONB blob
       -- (app_data baankarn_bookings_v1, an array). The relational bookings
       -- table is only best-effort dual-written, so counting it here missed
       -- bookings whose dual-write failed/lagged — letting an admin
       -- delete/rename a room that still has a live reservation and orphan it.
       -- Count from the authoritative blob instead.
       (SELECT COUNT(*)::int
          FROM app_data ad
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(ad.value)='array' THEN ad.value ELSE '[]'::jsonb END
          ) AS b
         WHERE ad.key='baankarn_bookings_v1'
           AND b->>'roomId' = $1
           AND b->>'status' IN ('pending','reviewing','approved')) AS active_bookings`,
    [roomCode]
  );
  const refs = rows[0] || {};
  const total = Object.values(refs).reduce((sum, n) => sum + (Number(n) || 0), 0);
  return { refs, total };
}

module.exports = {
  normaliseStatus,
  isVacantStatus,
  normaliseRoomForV2,
  normaliseRoomsObject,
  upsertRoomsV2FromJsonb,
  rowToBlobRoom,
  upsertJsonbRoomFromV2,
  removeJsonbRoom,
  roomDeleteRefs,
};
