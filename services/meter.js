// services/meter.js
// Meter reading helpers — record readings, compute consumption between
// two readings, simple anomaly detection (n-σ from rolling mean).

const ALLOWED_TYPES = new Set(['water', 'elec']);

/**
 * Insert a reading. Also computes the delta from the previous reading and
 * patches `app_data['baankarn_rooms_v1'][roomId][elecUnits|waterUnits]` so
 * the existing billing UI (which reads from rooms blob) sees the latest
 * monthly consumption automatically.
 *
 * Returns the inserted row, augmented with `delta` (consumption since prev).
 */
async function record(pool, { roomId, meterType, reading, source = 'manual', createdBy = null }) {
  if (!ALLOWED_TYPES.has(String(meterType))) throw new Error('invalid meter type');
  const r = Number(reading);
  if (!Number.isFinite(r) || r < 0) throw new Error('invalid reading');
  const safeRoom = String(roomId).slice(0, 32);

  const prev = await latest(pool, safeRoom, meterType);
  const { rows } = await pool.query(
    `INSERT INTO meter_readings (room_id, meter_type, reading, source, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [safeRoom, meterType, r, source, createdBy]
  );
  const delta = prev ? Math.max(0, r - Number(prev.reading)) : 0;

  // Sync delta into the rooms JSONB blob so admin/page-billing.jsx (which
  // calculates bills from rooms[id].elecUnits × rate) reflects current
  // consumption without manual entry. Fail-soft: if rooms key is missing or
  // the room id isn't there, jsonb_set is a no-op and we still return the row.
  if (delta > 0) {
    const col = meterType === 'elec' ? 'elecUnits' : 'waterUnits';
    try {
      await pool.query(
        `UPDATE app_data
            SET value = jsonb_set(value, ARRAY[$1::text, $2::text], to_jsonb($3::numeric)),
                updated_at = NOW()
          WHERE key = 'baankarn_rooms_v1'
            AND value ? $1`,
        [safeRoom, col, delta]
      );
    } catch (err) {
      console.error('[meter] room blob sync failed:', err.message);
    }
  }

  return { ...rows[0], delta };
}

/**
 * Latest reading for a room+type, or null.
 */
async function latest(pool, roomId, meterType) {
  const { rows } = await pool.query(
    `SELECT * FROM meter_readings
       WHERE room_id=$1 AND meter_type=$2
       ORDER BY reading_at DESC LIMIT 1`,
    [roomId, meterType]
  );
  return rows[0] || null;
}

/**
 * Consumption between (a→b) — b should be the more recent reading.
 * Returns 0 if either is missing or if b<a (meter rollover not modeled).
 */
function consumption(a, b) {
  if (!a || !b) return 0;
  const diff = Number(b.reading) - Number(a.reading);
  return diff > 0 ? Math.round(diff * 100) / 100 : 0;
}

/**
 * Detect anomalies: returns an object describing the anomaly when the latest
 * delta is more than `sigmas` standard deviations from the past mean, OR when
 * a meter rollback (negative delta) is observed. Returns null otherwise.
 *
 * Needs at least 4 prior consecutive deltas to be meaningful for the σ test.
 *
 * Why surface negative deltas:
 *   - Meter physically replaced/reset → admin needs to know so the bill
 *     calculation doesn't silently undercount.
 *   - Data-entry typo (entered 1234 instead of 12345) → notify before the
 *     wrong reading is used to bill someone.
 *   - Tamper / fraud signal — readings should monotonically increase.
 */
async function detectAnomaly(pool, roomId, meterType, sigmas = 3) {
  const { rows } = await pool.query(
    `SELECT reading, reading_at FROM meter_readings
       WHERE room_id=$1 AND meter_type=$2
       ORDER BY reading_at DESC LIMIT 30`,
    [roomId, meterType]
  );
  if (rows.length < 2) return null;
  const sorted = rows.reverse();  // oldest → newest

  // Latest delta first — a negative reading is itself an anomaly signal,
  // independent of how many prior samples we have.
  const lastDelta = Number(sorted[sorted.length - 1].reading)
                  - Number(sorted[sorted.length - 2].reading);
  if (lastDelta < 0) {
    return {
      kind: 'rollback',
      last: lastDelta,
      mean: null,
      std: null,
      z: null,
      threshold: sigmas,
    };
  }

  // σ test on the prior positive-only deltas (excluding the just-observed one).
  if (sorted.length < 5) return null;
  const deltas = [];
  for (let i = 1; i < sorted.length; i++) {
    const d = Number(sorted[i].reading) - Number(sorted[i - 1].reading);
    if (d >= 0) deltas.push(d);
  }
  if (deltas.length < 4) return null;
  const last = deltas.pop();
  const mean = deltas.reduce((s, x) => s + x, 0) / deltas.length;
  const variance = deltas.reduce((s, x) => s + (x - mean) ** 2, 0) / deltas.length;
  const std = Math.sqrt(variance);
  if (std === 0) return null;
  const z = (last - mean) / std;
  if (Math.abs(z) >= sigmas) {
    return { kind: 'sigma', z, mean, std, last, threshold: sigmas };
  }
  return null;
}

module.exports = { record, latest, consumption, detectAnomaly, ALLOWED_TYPES };
