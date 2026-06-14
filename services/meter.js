// services/meter.js
// Meter reading helpers — record readings, compute consumption between
// two readings, simple anomaly detection (n-σ from rolling mean).

const ALLOWED_TYPES = new Set(['water', 'elec']);

function normalisePeriod(period) {
  if (period == null || period === '') return null;
  const s = String(period).slice(0, 7);
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  if (!m) throw new Error('invalid period');
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (year < 2020 || year > 2100 || month < 1 || month > 12) {
    throw new Error('invalid period');
  }
  return s;
}

function periodBangkokBounds(period) {
  const p = normalisePeriod(period);
  if (!p) return null;
  const [year, month] = p.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 0, 17, 0, 0, 0));
  const nextStart = new Date(Date.UTC(year, month, 0, 17, 0, 0, 0));
  const readingAt = new Date(nextStart.getTime() - 1);
  return { start, nextStart, readingAt };
}

/**
 * Insert a reading. Period-scoped readings are the source of truth for
 * monthly billing; legacy unscoped readings still patch the rooms blob so old
 * demo paths keep working.
 *
 * Returns the inserted row, augmented with `delta` (consumption since prev).
 */
async function record(pool, { roomId, meterType, reading, source = 'manual', createdBy = null, period = null, allowRollback = false }) {
  if (!ALLOWED_TYPES.has(String(meterType))) throw new Error('invalid meter type');
  const r = Number(reading);
  if (!Number.isFinite(r) || r < 0) throw new Error('invalid reading');
  const safeRoom = String(roomId).slice(0, 32);
  const safePeriod = normalisePeriod(period);
  const bounds = safePeriod ? periodBangkokBounds(safePeriod) : null;

  const prev = safePeriod
    ? await latestBeforePeriod(pool, safeRoom, meterType, safePeriod)
    : await latest(pool, safeRoom, meterType);

  // Meters only count up. A reading BELOW the previous one is either a typo
  // (1234 instead of 12345 — next bill silently shows 0 units) or a physical
  // meter replacement/reset. Reject at entry so the bad value never becomes
  // billing input; the caller resubmits with allowRollback:true after a human
  // confirms the meter really was reset. detectAnomaly() still flags the
  // rollback post-hoc, but by then the reading is already saved — this guard
  // is the before-the-fact layer. Matches the check-in path's
  // METER_START_BACKWARD guard (routes/tenant-ops.js).
  if (!allowRollback && prev && r < Number(prev.reading)) {
    const err = new Error(
      `เลขมิเตอร์ใหม่ (${r}) น้อยกว่าเลขล่าสุด (${prev.reading}) — มิเตอร์ไม่ควรถอยหลัง`
    );
    err.code = 'METER_ROLLBACK';
    err.httpStatus = 409;
    err.lastReading = Number(prev.reading);
    err.attemptedReading = r;
    throw err;
  }
  const { rows } = await pool.query(
    `INSERT INTO meter_readings (room_id, meter_type, reading, source, created_by, period, reading_at)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, NOW()))
     ON CONFLICT (room_id, meter_type, period) WHERE period IS NOT NULL
     DO UPDATE SET
       reading = EXCLUDED.reading,
       source = EXCLUDED.source,
       created_by = EXCLUDED.created_by,
       reading_at = EXCLUDED.reading_at
     RETURNING *`,
    [safeRoom, meterType, r, source, createdBy, safePeriod, bounds ? bounds.readingAt.toISOString() : null]
  );
  const delta = prev ? Math.max(0, r - Number(prev.reading)) : 0;

  // Sync delta into the rooms JSONB blob so admin/page-billing.jsx (which
  // calculates bills from rooms[id].elecUnits × rate) reflects current
  // consumption without manual entry, and keep before/after readings for the
  // bill preview/PDF. Fail-soft: if rooms key is missing or the room id isn't
  // there, jsonb_set is a no-op and we still return the row.
  if (!safePeriod) {
    const col = meterType === 'elec' ? 'elecUnits' : 'waterUnits';
    const prevCol = meterType === 'elec' ? 'elecPrevReading' : 'waterPrevReading';
    const currentCol = meterType === 'elec' ? 'elecCurrentReading' : 'waterCurrentReading';
    try {
      await pool.query(
        `UPDATE app_data
            SET value = jsonb_set(
                          jsonb_set(
                            jsonb_set(value, ARRAY[$1::text, $2::text], COALESCE(to_jsonb($3::numeric), 'null'::jsonb)),
                            ARRAY[$1::text, $4::text], COALESCE(to_jsonb($5::numeric), 'null'::jsonb)
                          ),
                          ARRAY[$1::text, $6::text], COALESCE(to_jsonb($7::numeric), 'null'::jsonb)
                        ),
                updated_at = NOW()
          WHERE key = 'baankarn_rooms_v1'
            AND value ? $1`,
        [safeRoom, col, delta, prevCol, prev ? Number(prev.reading) : null, currentCol, r]
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

async function latestBeforePeriod(pool, roomId, meterType, period) {
  const safePeriod = normalisePeriod(period);
  const bounds = periodBangkokBounds(safePeriod);
  // Rank candidates by observation time, NOT period-first: record() stamps
  // every scoped row's reading_at at its period's end (periodBangkokBounds),
  // so reading_at is comparable across scoped and unscoped rows. Sorting
  // period-first would let an old scoped baseline permanently outrank newer
  // unscoped readings, re-billing already-billed consumption every month.
  // On a same-instant tie the scoped row wins — it's the billing source of
  // truth for its month.
  const { rows } = await pool.query(
    `SELECT * FROM meter_readings
       WHERE room_id=$1 AND meter_type=$2
         AND (
           (period IS NOT NULL AND period < $3)
           OR (period IS NULL AND reading_at < $4::timestamptz)
         )
       ORDER BY reading_at DESC, (period IS NOT NULL) DESC
       LIMIT 1`,
    [roomId, meterType, safePeriod, bounds.start.toISOString()]
  );
  return rows[0] || null;
}

async function readingPairForPeriod(pool, roomId, meterType, period) {
  const safePeriod = normalisePeriod(period);
  const bounds = periodBangkokBounds(safePeriod);
  const currentQ = await pool.query(
    `SELECT * FROM meter_readings
       WHERE room_id=$1 AND meter_type=$2
         AND (
           period=$3
           OR (period IS NULL AND reading_at >= $4::timestamptz AND reading_at < $5::timestamptz)
         )
       ORDER BY (period=$3) DESC, reading_at DESC
       LIMIT 1`,
    [roomId, meterType, safePeriod, bounds.start.toISOString(), bounds.nextStart.toISOString()]
  );
  const current = currentQ.rows[0] || null;
  const prev = await latestBeforePeriod(pool, roomId, meterType, safePeriod);
  return { current, prev };
}

/**
 * Decorate a room object with the latest before/after meter readings.
 *
 * Billing needs the audit trail, not just the already-computed delta:
 *   previous reading -> current reading = units used x rate
 *
 * When fewer than two readings exist for a meter type, the existing
 * room.waterUnits / room.elecUnits value is left intact so legacy manual
 * entry still works.
 */
async function attachLatestBillingReadings(pool, room) {
  if (!room || !room.id) return room;
  const safeRoom = String(room.id).slice(0, 32);
  let rows = [];
  try {
    const out = await pool.query(
      `SELECT meter_type, reading, reading_at
         FROM (
           SELECT meter_type, reading, reading_at,
                  ROW_NUMBER() OVER (PARTITION BY meter_type ORDER BY reading_at DESC) AS rn
             FROM meter_readings
            WHERE room_id=$1 AND meter_type IN ('water', 'elec')
         ) ranked
        WHERE rn <= 2
        ORDER BY meter_type, reading_at DESC`,
      [safeRoom]
    );
    rows = out.rows || [];
  } catch (err) {
    // Older deployments may not have meter_readings yet. Billing can still
    // proceed from the legacy room units.
    if (err.code !== '42P01' && err.code !== '42703') throw err;
    return room;
  }

  const next = { ...room };
  for (const meterType of ['water', 'elec']) {
    const pair = rows.filter((r) => r.meter_type === meterType);
    const current = pair[0] || null;
    const prev = pair[1] || null;
    if (!current) continue;
    const prefix = meterType === 'elec' ? 'elec' : 'water';
    // Set ALL three fields from the authoritative meter_readings table so a
    // stale `*Units`/`*PrevReading` left in the room blob (e.g. a legacy
    // manual entry on a room that just switched to metered) can't leak into
    // the bill. A first-ever reading has no baseline → 0 units this period;
    // the current reading becomes next period's baseline.
    next[`${prefix}CurrentReading`] = Number(current.reading);
    next[`${prefix}PrevReading`] = prev ? Number(prev.reading) : null;
    next[`${prefix}Units`] = prev ? consumption(prev, current) : 0;
  }
  return next;
}

async function attachBillingReadingsForPeriod(pool, room, period) {
  if (!room || !room.id) return room;
  let safePeriod;
  try {
    safePeriod = normalisePeriod(period);
  } catch {
    return attachLatestBillingReadings(pool, room);
  }
  if (!safePeriod) return attachLatestBillingReadings(pool, room);

  const safeRoom = String(room.id).slice(0, 32);
  const next = { ...room };
  try {
    for (const meterType of ['water', 'elec']) {
      const prefix = meterType === 'elec' ? 'elec' : 'water';
      const { current, prev } = await readingPairForPeriod(pool, safeRoom, meterType, safePeriod);
      if (!current) {
        // No reading for THIS period. Do NOT fall through leaving the stale
        // room-blob `*Units`/`*CurrentReading`/`*PrevReading` from a prior
        // unscoped record() — that would silently re-bill already-charged
        // consumption, and because the stale *CurrentReading is non-null the
        // NO_METER_READINGS guard (hasPeriodReading, bills-extras.js) would not
        // fire. Explicitly zero the usage and null the readings so the bill is
        // 0 and the missing-reading gap is detected.
        next[`${prefix}Units`] = 0;
        next[`${prefix}PrevReading`] = null;
        next[`${prefix}CurrentReading`] = null;
        continue;
      }
      // Authoritative table values override any stale blob `*Units`/`*PrevReading`
      // (see attachLatestBillingReadings). No baseline → 0 units this period.
      next[`${prefix}CurrentReading`] = Number(current.reading);
      next[`${prefix}PrevReading`] = prev ? Number(prev.reading) : null;
      next[`${prefix}Units`] = prev ? consumption(prev, current) : 0;
    }
  } catch (err) {
    if (err.code !== '42P01' && err.code !== '42703') throw err;
    return room;
  }
  return next;
}

async function buildPeriodSummary(pool, rooms, period) {
  const safePeriod = normalisePeriod(period);
  const out = {};
  for (const room of Object.values(rooms || {})) {
    if (!room || !room.id) continue;
    const withReadings = await attachBillingReadingsForPeriod(pool, room, safePeriod);
    out[String(room.id)] = {
      roomId: String(room.id),
      waterPrevReading: withReadings.waterPrevReading ?? null,
      waterCurrentReading: withReadings.waterCurrentReading ?? null,
      waterUnits: withReadings.waterUnits ?? room.waterUnits ?? 0,
      elecPrevReading: withReadings.elecPrevReading ?? null,
      elecCurrentReading: withReadings.elecCurrentReading ?? null,
      elecUnits: withReadings.elecUnits ?? room.elecUnits ?? 0,
    };
  }
  return out;
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
  // For new rooms (< 4 prior deltas) we fall back to a simpler "much bigger
  // than last observation" heuristic so brand-new units still get SOME fraud
  // protection — the σ test silently returning null left them open for the
  // first ~4 readings.
  if (sorted.length < 5) {
    // Simple rule: if the latest delta is more than 5x the previous delta and
    // both are positive, flag it. Misses subtle drifts but catches the
    // typo-entered-wrong-number case (10 → 1000) on a young meter.
    if (sorted.length >= 3) {
      const prev = Number(sorted[sorted.length - 2].reading) - Number(sorted[sorted.length - 3].reading);
      if (prev > 0 && lastDelta > 0 && lastDelta > prev * 5) {
        return { kind: 'jump', last: lastDelta, prev, threshold: sigmas, ratio: lastDelta / prev };
      }
    }
    return null;
  }
  const deltas = [];
  for (let i = 1; i < sorted.length; i++) {
    const d = Number(sorted[i].reading) - Number(sorted[i - 1].reading);
    if (d >= 0) deltas.push(d);
  }
  if (deltas.length < 4) return null;
  const last = deltas.pop();
  const mean = deltas.reduce((s, x) => s + x, 0) / deltas.length;
  // Sample variance (÷ n-1, Bessel's correction). Population variance (÷ n)
  // underestimates σ on the small windows here, making the n-σ test trip too
  // easily → false-positive anomaly alerts on young meters. We required ≥4
  // deltas before the pop above, so n≥3 here and n-1≥2 — never divides by zero.
  const variance = deltas.reduce((s, x) => s + (x - mean) ** 2, 0) / (deltas.length - 1);
  const std = Math.sqrt(variance);
  // Constant-consumption rooms (e.g. unoccupied with steady leak, or fully
  // automated flat charges) produce std === 0. The original code returned
  // null here which meant a sudden jump from a perfectly-flat baseline to,
  // say, 10x usage went completely undetected. When std is 0 but the latest
  // delta differs from the mean, flag it as a 'zero-variance' anomaly.
  if (std === 0) {
    if (last !== mean) {
      return { kind: 'zero-variance', last, mean, std: 0, threshold: sigmas };
    }
    return null;
  }
  const z = (last - mean) / std;
  if (Math.abs(z) >= sigmas) {
    return { kind: 'sigma', z, mean, std, last, threshold: sigmas };
  }
  return null;
}

module.exports = {
  record,
  latest,
  latestBeforePeriod,
  attachLatestBillingReadings,
  attachBillingReadingsForPeriod,
  buildPeriodSummary,
  consumption,
  detectAnomaly,
  normalisePeriod,
  ALLOWED_TYPES,
};
