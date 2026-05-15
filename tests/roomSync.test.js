const test = require('node:test');
const assert = require('node:assert/strict');

const roomSync = require('../services/roomSync');

test('normaliseRoomsObject converts legacy room blob to rooms_v2 rows', () => {
  const { rooms, skipped } = roomSync.normaliseRoomsObject({
    101: {
      id: '101',
      floor: 1,
      no: 1,
      type: 'deluxe',
      status: 'occupied',
      rent: '5800',
      deposit: '',
      wifi: 250,
      view: 'city',
      balcony: true,
      kitchen: false,
      notes: 'near lift',
    },
    bad: null,
  });

  assert.equal(rooms.length, 1);
  assert.equal(skipped.length, 1);
  assert.deepEqual(rooms[0], {
    room_code: '101',
    floor: 1,
    room_no: 1,
    room_type: 'deluxe',
    status: 'occupied',
    rent_price: 5800,
    // Override fields (pricing resolver v1): null when admin hasn't set
    // a per-room override on this room. Bill engine then uses contract
    // monthly_rent or formula via services/pricing.js.
    rent_override: null,
    rent_override_reason: null,
    rent_override_at: null,
    rent_override_by: null,
    deposit_price: 11600,
    wifi_fee: 250,
    view_type: 'city',
    has_balcony: true,
    has_parking: false,
    has_kitchen: false,
    has_ac: true,
    size_sqm: 28,
    bed_count: 1,
    notes: 'near lift',
  });
});

test('normaliseRoomsObject carries rentOverride from blob → rooms_v2 row', () => {
  // Admin set a special rate on this room via /admin#rooms. roomSync
  // must persist the override + reason on the v2 row so the resolver
  // can read it whichever side the data is loaded from.
  const { rooms } = roomSync.normaliseRoomsObject({
    305: {
      id: '305', floor: 3, no: 5, type: 'studio',
      rent: 6800,
      rentOverride: 5500,
      rentOverrideReason: 'small unit',
    },
  });
  assert.equal(rooms[0].rent_override, 5500);
  assert.equal(rooms[0].rent_override_reason, 'small unit');
});

test('rowToBlobRoom emits the legacy shape expected by admin/public UI', () => {
  const blob = roomSync.rowToBlobRoom({
    room_code: '305',
    floor: 3,
    room_no: 5,
    room_type: 'studio',
    status: 'vacant',
    rent_price: '6800.00',
    deposit_price: '13600.00',
    wifi_fee: '250.00',
    view_type: 'garden',
    has_balcony: false,
    has_parking: true,
    has_kitchen: true,
    has_ac: true,
    notes: 'quiet',
  });

  assert.equal(blob.id, '305');
  assert.equal(blob.type, 'studio');
  assert.equal(blob.rent, 6800);
  assert.equal(blob.deposit, 13600);
  assert.equal(blob.tenant, null);
  assert.equal(blob.parking, true);
  assert.equal(blob.kitchen, true);
  // Override fields propagate back into the blob — admin UI reads them
  // without joining to rooms_v2.
  assert.equal(blob.rentOverride, null);
});

test('rowToBlobRoom carries rent_override back into the blob shape', () => {
  const blob = roomSync.rowToBlobRoom({
    room_code: '305', floor: 3, room_no: 5, room_type: 'studio',
    status: 'vacant', rent_price: 6800,
    rent_override: 5500,
    rent_override_reason: 'small unit',
    rent_override_at: '2026-05-15T10:00:00Z',
    rent_override_by: 'admin',
    deposit_price: 11000, wifi_fee: 250,
    view_type: '', has_balcony: false, has_parking: false,
    has_kitchen: false, has_ac: true,
  });
  assert.equal(blob.rentOverride, 5500);
  assert.equal(blob.rentOverrideReason, 'small unit');
  assert.equal(blob.rentOverrideBy, 'admin');
});

test('upsertRoomsV2FromJsonb dry-run reports inserts/updates without writes', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      assert.doesNotMatch(sql, /INSERT INTO rooms_v2/);
      return { rows: [{ room_code: '101' }] };
    },
  };

  const result = await roomSync.upsertRoomsV2FromJsonb(pool, {
    dryRun: true,
    roomsObj: {
      101: { id: '101', floor: 1, no: 1, rent: 4500 },
      102: { id: '102', floor: 1, no: 2, rent: 4500 },
    },
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.normalised, 2);
  assert.equal(result.updated, 1);
  assert.equal(result.inserted, 1);
  assert.equal(calls.length, 1);
});
