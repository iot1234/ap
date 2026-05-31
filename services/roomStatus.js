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
 * @param {boolean} facts.hasActiveTenant   Active tenant currently assigned to this room
 * @param {boolean} facts.hasCurrentLease   Active contract for that active tenant in this room
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
  // A stale contract row or stale JSONB room.tenant is not enough to mark a
  // room occupied. The authoritative signal is an active tenant whose
  // current_room_id still points at this room. This prevents checkout +
  // later bill payment from resurrecting a moved-out tenant in /rooms.
  if (facts.hasActiveTenant) {
    return facts.hasOverdueBill ? 'overdue' : 'occupied';
  }
  if (facts.hasActiveReservation) return 'reserved';
  return 'vacant';
}

function buildBlobTenant(row) {
  if (!row) return null;
  return {
    tenantId: String(row.id),
    name: row.full_name || '',
    phone: row.phone || '',
    email: row.email || '',
  };
}

function blobTenantMatchesActive(blobTenant, activeTenant) {
  if (!blobTenant || !activeTenant) return false;
  const blobId = String(blobTenant.tenantId || blobTenant.id || '').trim();
  if (blobId && blobId !== String(activeTenant.tenantId)) return false;
  const blobPhone = String(blobTenant.phone || '').replace(/[\s-]/g, '');
  const activePhone = String(activeTenant.phone || '').replace(/[\s-]/g, '');
  if (blobPhone && activePhone && blobPhone !== activePhone) return false;
  if (String(blobTenant.name || '') !== String(activeTenant.name || '')) return false;
  return true;
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
    const activeTenantForBlob = buildBlobTenant(facts.activeTenant);
    // Keep the applicant snapshot on a room that is legitimately RESERVED by a
    // still-live booking/draft: it has a blob tenant snapshot but no active
    // tenant row yet, and stripping it would wipe "reserved by <name>" from the
    // admin drawer. Stale-tenant cleanup still fires once the reservation is
    // gone (expired → hasActiveReservation false) or for a moved-out occupant.
    const cleanupStaleTenant = facts.hasBlobTenant && !activeTenantForBlob && !facts.hasActiveReservation;
    const refreshBlobTenant = !!activeTenantForBlob
      && !blobTenantMatchesActive(facts.blobTenant, activeTenantForBlob);
    const cleanupStaleReservation = !!facts.reservedBy
      && facts.reservationChecked
      && !facts.hasActiveReservation;
    const shouldPatchBlob = after !== before
      || cleanupStaleTenant
      || refreshBlobTenant
      || cleanupStaleReservation;
    let changed = false;
    if (shouldPatchBlob) {
      // Update the legacy blob — primary admin UI source.
      await client.query(
        `UPDATE app_data
            SET value = jsonb_set(
                  value,
                  ARRAY[$1::text],
                  (
                    COALESCE(value->$1, '{}'::jsonb)
                    - CASE WHEN $3::boolean THEN 'tenant' ELSE '__room_status_noop__' END
                    - CASE WHEN $3::boolean THEN 'since' ELSE '__room_status_noop__' END
                    - CASE WHEN $3::boolean THEN 'contractEnd' ELSE '__room_status_noop__' END
                    - CASE WHEN $4::boolean THEN 'reservedBy' ELSE '__room_status_noop__' END
                    - CASE WHEN $4::boolean THEN 'reservedAt' ELSE '__room_status_noop__' END
                    - CASE WHEN $4::boolean THEN 'sourceBookingId' ELSE '__room_status_noop__' END
                  )
                  || jsonb_build_object('status', $2::text)
                  || CASE WHEN $5::jsonb IS NULL
                          THEN '{}'::jsonb
                          ELSE jsonb_build_object('tenant', $5::jsonb)
                     END,
                  true
                ),
                updated_at = NOW()
          WHERE key='baankarn_rooms_v1' AND value ? $1`,
        [roomId, after, cleanupStaleTenant, cleanupStaleReservation,
          activeTenantForBlob ? JSON.stringify(activeTenantForBlob) : null]
      );
      changed = true;
      const notes = [];
      if (cleanupStaleTenant) notes.push('cleared stale tenant');
      if (refreshBlobTenant) notes.push('refreshed tenant snapshot');
      if (cleanupStaleReservation) notes.push('cleared stale reservation');
      console.log(`[roomStatus] ${roomId}: ${before || '(empty)'} -> ${after}${opts.reason ? ` (${opts.reason})` : ''}${notes.length ? `; ${notes.join(', ')}` : ''}`);
    }
    // Mirror to rooms_v2 even when the JSONB status was already correct;
    // otherwise a stale rooms_v2 row can keep /api/rooms?status=occupied
    // wrong until the next manual edit.
    try {
      const v2 = await client.query(
        `UPDATE rooms_v2 SET status=$2, updated_at=NOW()
          WHERE room_code=$1 AND deleted_at IS NULL
            AND status IS DISTINCT FROM $2`,
        [roomId, after]
      );
      if (v2.rowCount > 0) changed = true;
    } catch (err) {
      if (err.code !== '42P01') throw err;
    }
    if (changed && !shouldPatchBlob) {
      console.log(`[roomStatus] ${roomId}: ${before || '(empty)'} -> ${after}${opts.reason ? ` (${opts.reason})` : ''}`);
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
      `WITH blob_rooms AS (
         SELECT rec.key AS room_code
           FROM app_data ad
           CROSS JOIN LATERAL jsonb_each(ad.value) AS rec(key, val)
          WHERE ad.key='baankarn_rooms_v1'
            AND jsonb_typeof(ad.value)='object'
       ),
       v2_rooms AS (
         SELECT room_code
           FROM rooms_v2
          WHERE deleted_at IS NULL
       )
       SELECT room_code FROM blob_rooms
       UNION
       SELECT room_code FROM v2_rooms`
    );
    roomCodes = rows.map((r) => r.room_code);
  } catch (err) {
    if (err.code !== '42P01') {
      console.error('[roomStatus] syncAll list failed:', err.message);
      return summary;
    }
    try {
      const { rows } = await pool.query(
        `SELECT rec.key AS room_code
           FROM app_data ad
           CROSS JOIN LATERAL jsonb_each(ad.value) AS rec(key, val)
          WHERE ad.key='baankarn_rooms_v1'
            AND jsonb_typeof(ad.value)='object'`
      );
      roomCodes = rows.map((r) => r.room_code);
    } catch (fallbackErr) {
      console.error('[roomStatus] syncAll list failed:', fallbackErr.message);
      return summary;
    }
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
            value->$1->'tenant' AS tenant,
            value->$1->'tenant' IS NOT NULL
              AND value->$1->'tenant' <> 'null'::jsonb
              AND value->$1->'tenant' <> '{}'::jsonb AS has_tenant,
            value->$1->>'reservedBy' AS reserved_by,
            value->$1->>'reservationExpiresAt' AS reservation_expires_at
       FROM app_data WHERE key='baankarn_rooms_v1' LIMIT 1`,
    [roomId]
  );
  const blob = blobQ.rows[0] || {};
  // (2) Active tenant currently assigned to this room. This is the
  // authoritative occupancy signal; old contracts/bills must not resurrect
  // a moved-out tenant.
  let activeTenant = null;
  try {
    const tQ = await client.query(
      `SELECT id, full_name, phone, email
         FROM tenants
        WHERE current_room_id=$1
          AND status='active'
          AND deleted_at IS NULL
        ORDER BY id ASC
        LIMIT 1`,
      [roomId]
    );
    activeTenant = tQ.rows[0] || null;
  } catch (err) {
    if (err.code !== '42P01') throw err;
  }
  // (3) Active contract for the active tenant currently in this room. A
  // moved_out tenant with an active old contract is a data anomaly, not
  // occupancy.
  let hasCurrentLease = false;
  try {
    const cQ = await client.query(
      `SELECT 1
         FROM contracts c
         JOIN tenants t ON t.id=c.tenant_id
        WHERE c.room_id=$1
          AND c.status='active'
          AND c.deleted_at IS NULL
          AND t.deleted_at IS NULL
          AND t.status='active'
          AND t.current_room_id=$1
        LIMIT 1`,
      [roomId]
    );
    hasCurrentLease = cQ.rows.length > 0;
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
          AND ($2::bigint IS NULL OR tenant_id IS NULL OR tenant_id=$2)
          AND (status='overdue'
               OR (status='pending' AND due_date < CURRENT_DATE))
        LIMIT 1`,
      [roomId, activeTenant ? String(activeTenant.id) : null]
    );
    hasOverdueBill = bQ.rows.length > 0;
  } catch (err) {
    if (err.code !== '42P01') throw err;
  }
  // (4) Active reservation pointer — booking or contract draft.
  const reservedBy = blob.reserved_by || null;
  let hasActiveReservation = false;
  let reservationChecked = !reservedBy;
  if (reservedBy) {
    if (reservedBy.startsWith('contract:')) {
      const cid = Number(reservedBy.slice('contract:'.length));
      if (Number.isInteger(cid)) {
        try {
          const r = await client.query(
            `SELECT 1
               FROM contracts c
               LEFT JOIN tenants t ON t.id=c.tenant_id AND t.deleted_at IS NULL
              WHERE c.id=$1
                AND c.deleted_at IS NULL
                AND (
                  c.status IN ('draft','pending')
                  OR (
                    c.status='active'
                    AND c.locked_at IS NULL
                    AND COALESCE(t.status, 'active') <> 'moved_out'
                  )
                )
              LIMIT 1`,
            [cid]
          );
          hasActiveReservation = r.rows.length > 0;
          reservationChecked = true;
        } catch (err) {
          if (err.code === '42P01' || err.code === '42703') reservationChecked = false;
          else throw err;
        }
      }
    } else if (reservedBy.startsWith('hold:')) {
      const expires = Date.parse(blob.reservation_expires_at || '');
      hasActiveReservation = Number.isFinite(expires) && expires > Date.now();
      reservationChecked = true;
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
        reservationChecked = true;
      } catch { reservationChecked = false; /* tolerate jsonb-path errors on old PG */ }
    }
  }
  return {
    currentStatus: blob.status || null,
    blobTenant: blob.tenant || null,
    hasBlobTenant: blob.has_tenant === true,
    activeTenant,
    hasActiveTenant: !!activeTenant,
    hasCurrentLease,
    hasOverdueBill,
    reservedBy,
    reservationChecked,
    hasActiveReservation,
  };
}

module.exports = {
  computeRoomStatus,
  syncRoom,
  syncAllRooms,
  VALID_ROOM_STATUSES,
};
