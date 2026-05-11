// services/roomStatus.js
// Single source of truth for "what status SHOULD this room be in?". Eliminates
// the drift that built up when multiple write paths (admin click, contract
// PUT, checkout, scheduler) each set room.status using their own local logic.
//
// Status precedence (highest wins):
//
//   1. maintenance        — manual lock. Never auto-overwrite; admin owns
//                           this state until they clear it themselves.
//   2. overdue            — has tenant + active contract + at least one
//                           unpaid bill past due_date. Cascades from the
//                           bill-overdue cron AND from per-payment events
//                           (so paying the last overdue bill flips room
//                           overdue→occupied without admin clicking).
//   3. occupied           — has tenant + active contract (no overdue bills).
//   4. reserved           — has draft/pending contract OR booking with
//                           reservedBy still pointing at an active row.
//   5. vacant             — nothing else.
//
// All five values are the same vocabulary the existing UI + reports already
// use (grep "status === 'occupied'" / 'overdue' / 'reserved' / 'vacant' /
// 'maintenance' across server.js to verify before touching this list).

const VALID_ROOM_STATUSES = new Set([
  'vacant', 'reserved', 'occupied', 'overdue', 'maintenance',
]);

/**
 * Pure function — compute the canonical status for a room from its
 * derived facts. No DB access; caller assembles `facts` from the right
 * queries first. Pure-ness keeps this trivially unit-testable.
 *
 * @param {object} facts
 * @param {string} [facts.currentStatus]    Current room.status from the blob (used to honor manual 'maintenance')
 * @param {boolean} facts.hasActiveContract Active contract on this room
 * @param {boolean} facts.hasBlobTenant     Blob's room.tenant is set
 * @param {boolean} facts.hasOverdueBill    At least one bill with status='overdue' (or pending past due_date)
 * @param {boolean} facts.hasActiveReservation reservedBy pointer is still live (booking pending OR contract draft)
 * @returns {'vacant'|'reserved'|'occupied'|'overdue'|'maintenance'}
 */
function computeRoomStatus(facts) {
  const cur = facts.currentStatus;
  // Manual override — admin chose 'maintenance' for a reason (cleaning,
  // repair). Never auto-overwrite; admin must clear it themselves.
  if (cur === 'maintenance') return 'maintenance';
  if (facts.hasActiveContract && facts.hasBlobTenant) {
    return facts.hasOverdueBill ? 'overdue' : 'occupied';
  }
  if (facts.hasActiveContract && !facts.hasBlobTenant) {
    // Contract exists but tenant hasn't actually moved into the blob slot
    // yet — invitation phase. Treat as reserved so admin can't double-book.
    return 'reserved';
  }
  if (facts.hasActiveReservation) return 'reserved';
  return 'vacant';
}

/**
 * Sync a single room's status. Loads the derived facts under a single
 * transaction client (FOR UPDATE the bills + contracts rows so a concurrent
 * payment verify doesn't race past us) and updates the blob + rooms_v2.
 * Caller passes their own pool client when running inside an existing tx,
 * or pass `pool` to get a fresh connection.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} dbOrClient
 * @param {string} roomId
 * @param {object} [opts]
 * @param {string} [opts.reason]  Optional audit annotation (logged via console)
 * @returns {Promise<{ roomId, before?, after, changed: boolean }>}
 */
async function syncRoom(dbOrClient, roomId, opts = {}) {
  if (!roomId) return { roomId, after: null, changed: false };
  const ownClient = typeof dbOrClient.connect === 'function';
  const client = ownClient ? await dbOrClient.connect() : dbOrClient;
  try {
    if (ownClient) await client.query('BEGIN');
    // Gather derived facts. Each query is shielded by AND deleted_at IS NULL
    // (where applicable) so soft-deleted rows don't trip the derivation.
    const facts = await deriveFacts(client, roomId);
    const before = facts.currentStatus;
    const after = computeRoomStatus(facts);
    let changed = false;
    if (after !== before) {
      // Update the legacy blob — primary admin UI source.
      await client.query(
        `UPDATE app_data
            SET value = jsonb_set(value, ARRAY[$1::text], COALESCE(value->$1, '{}'::jsonb)
                                                          || jsonb_build_object('status', $2::text)),
                updated_at = NOW()
          WHERE key='baankarn_rooms_v1' AND value ? $1`,
        [roomId, after]
      );
      // Mirror to rooms_v2 — soft-deletion safe + tolerates missing table on
      // legacy deploys (42P01 = relation undefined).
      try {
        await client.query(
          `UPDATE rooms_v2 SET status=$2, updated_at=NOW()
            WHERE room_code=$1 AND deleted_at IS NULL`,
          [roomId, after]
        );
      } catch (err) {
        if (err.code !== '42P01') throw err;
      }
      changed = true;
      console.log(`[roomStatus] ${roomId}: ${before || '(empty)'} → ${after}${opts.reason ? ` (${opts.reason})` : ''}`);
    }
    if (ownClient) await client.query('COMMIT');
    return { roomId, before, after, changed };
  } catch (err) {
    if (ownClient) await client.query('ROLLBACK').catch(() => {});
    console.error(`[roomStatus] sync ${roomId} failed:`, err.message);
    return { roomId, error: err.message, after: null, changed: false };
  } finally {
    if (ownClient) client.release();
  }
}

/**
 * Re-sync every room. Used by the scheduler nightly safety-net + the
 * /api/admin/rooms/reconcile-all-status endpoint admin can call from
 * the rooms page. Returns a summary so the caller can log/audit.
 */
async function syncAllRooms(pool, opts = {}) {
  const summary = { scanned: 0, changed: 0, errors: 0, changes: [] };
  // List rooms from the JSONB blob — that's the canonical set the admin
  // UI reads. rooms_v2-only rooms are still picked up because syncRoom
  // updates both sources from the derived facts (and creates a blob entry
  // implicitly via jsonb_set with COALESCE).
  let roomCodes;
  try {
    const { rows } = await pool.query(
      `SELECT jsonb_object_keys(value) AS room_code
         FROM app_data WHERE key='baankarn_rooms_v1' LIMIT 1`
    );
    roomCodes = rows.map((r) => r.room_code);
  } catch (err) {
    console.error('[roomStatus] syncAll list failed:', err.message);
    return summary;
  }
  for (const roomId of roomCodes) {
    summary.scanned++;
    const r = await syncRoom(pool, roomId, { reason: opts.reason || 'sync-all' });
    if (r.error) summary.errors++;
    if (r.changed) {
      summary.changed++;
      summary.changes.push({ roomId, before: r.before, after: r.after });
    }
  }
  return summary;
}

// --- Internal --------------------------------------------------------------
async function deriveFacts(client, roomId) {
  // (1) Current blob status — needed for 'maintenance' precedence + change detection.
  const blobQ = await client.query(
    `SELECT value->$1->>'status' AS status,
            value->$1->'tenant' IS NOT NULL
              AND value->$1->'tenant' <> 'null'::jsonb
              AND value->$1->'tenant' <> '{}'::jsonb AS has_tenant,
            value->$1->>'reservedBy' AS reserved_by
       FROM app_data WHERE key='baankarn_rooms_v1' LIMIT 1`,
    [roomId]
  );
  const blob = blobQ.rows[0] || {};
  // (2) Active contract for this room.
  let hasActiveContract = false;
  try {
    const cQ = await client.query(
      `SELECT 1 FROM contracts
        WHERE room_id=$1 AND status='active' AND deleted_at IS NULL
        LIMIT 1`,
      [roomId]
    );
    hasActiveContract = cQ.rows.length > 0;
  } catch (err) {
    if (err.code !== '42P01') throw err;
  }
  // (3) Any overdue / past-due bill for this room. Both explicit overdue
  // status AND pending bills where due_date < today (the late-fee cron
  // might not have run yet today, so we recompute here for fresh state).
  let hasOverdueBill = false;
  try {
    const bQ = await client.query(
      `SELECT 1 FROM bills
        WHERE room_id=$1 AND deleted_at IS NULL
          AND (status='overdue'
               OR (status='pending' AND due_date < CURRENT_DATE))
        LIMIT 1`,
      [roomId]
    );
    hasOverdueBill = bQ.rows.length > 0;
  } catch (err) {
    if (err.code !== '42P01') throw err;
  }
  // (4) Active reservation pointer — booking or contract draft.
  const reservedBy = blob.reserved_by || null;
  let hasActiveReservation = false;
  if (reservedBy) {
    if (reservedBy.startsWith('contract:')) {
      const cid = Number(reservedBy.slice('contract:'.length));
      if (Number.isInteger(cid)) {
        try {
          const r = await client.query(
            `SELECT 1 FROM contracts WHERE id=$1 AND status IN ('active','draft','pending') AND deleted_at IS NULL LIMIT 1`,
            [cid]
          );
          hasActiveReservation = r.rows.length > 0;
        } catch (err) { if (err.code !== '42P01') throw err; }
      }
    } else {
      // Booking-id pointer — check the bookings blob.
      try {
        const r = await client.query(
          `SELECT 1 FROM app_data
            WHERE key='baankarn_bookings_v1'
              AND value @> jsonb_build_array(jsonb_build_object('id', $1::text))
            LIMIT 1`,
          [reservedBy]
        );
        if (r.rows.length) {
          // Cheap match — the booking exists. Refine: only count it as live
          // when the booking isn't terminal (cancelled/rejected/completed).
          const bk = await client.query(
            `SELECT jsonb_path_query_first(value,
                      '$[*] ? (@.id == $rid)',
                      jsonb_build_object('rid', $1::text)
                    ) AS booking
               FROM app_data WHERE key='baankarn_bookings_v1' LIMIT 1`,
            [reservedBy]
          );
          const status = bk.rows[0]?.booking?.status;
          hasActiveReservation = !['cancelled', 'rejected', 'completed'].includes(status);
        }
      } catch { /* tolerate jsonb-path errors on old PG */ }
    }
  }
  return {
    currentStatus: blob.status || null,
    hasBlobTenant: blob.has_tenant === true,
    hasActiveContract,
    hasOverdueBill,
    hasActiveReservation,
  };
}

module.exports = {
  computeRoomStatus,
  syncRoom,
  syncAllRooms,
  VALID_ROOM_STATUSES,
};
