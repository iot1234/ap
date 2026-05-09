// db/optimisticLock.js
// Helpers for detecting concurrent edits via the `updated_at` column.
//
// Pattern: client GETs row → keeps `updated_at` value → POSTs back with it.
// Server checks the value still matches; if not, another admin edited the
// same row in between → 409 with the current state so the UI can reload.
//
// Usage:
//   const { conflict } = await checkVersion(pool, 'tenants', id, body.updated_at);
//   if (conflict) return res.status(409).json({
//     error: 'version conflict — row was changed by another user',
//     code: 'VERSION_CONFLICT',
//     currentRow: conflict.row,
//   });
//
// Or one-shot UPDATE … WHERE id=$1 AND updated_at=$2 RETURNING * — if the
// returned rows.length is 0, the version check failed.

/**
 * Compare a client-supplied updated_at against the row's current value.
 * Returns { ok: true } when fresh, { conflict: { row } } when stale.
 */
async function checkVersion(pool, table, id, clientUpdatedAt) {
  if (!clientUpdatedAt) return { ok: true };          // client didn't pass one
  // Whitelist table to avoid SQL injection through dynamic name.
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) {
    throw new Error('invalid table name');
  }
  const { rows } = await pool.query(
    `SELECT updated_at, * FROM "${table}" WHERE id=$1`,
    [id]
  );
  if (!rows.length) return { ok: true };               // row not found — caller handles
  const dbVal = rows[0].updated_at;
  // Timestamps come back as Date or ISO string depending on driver options.
  // Normalise to ISO + compare second-precision (DB rounds to microseconds
  // but JSON round-trip can lose them).
  const a = new Date(dbVal).toISOString().slice(0, 19);
  const b = new Date(clientUpdatedAt).toISOString().slice(0, 19);
  if (a !== b) return { conflict: { row: rows[0] } };
  return { ok: true };
}

/**
 * One-shot version check baked into an UPDATE. Returns { row } on success,
 * { conflict: { current } } on stale write. Saves a roundtrip vs checkVersion.
 *
 * @param {object} pool
 * @param {string} table - safe table name
 * @param {number} id
 * @param {string} clientUpdatedAt - ISO from the client
 * @param {string} setClause - "name=$3, phone=$4" — params start at $3
 * @param {Array} params - values for setClause
 */
async function updateWithVersion(pool, table, id, clientUpdatedAt, setClause, params) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) {
    throw new Error('invalid table name');
  }
  if (!clientUpdatedAt) {
    // No version provided — fall through to plain UPDATE.
    const r = await pool.query(
      `UPDATE "${table}" SET ${setClause}, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [id, ...params]
    );
    return r.rows.length ? { row: r.rows[0] } : { conflict: null, notFound: true };
  }
  // Compare at second-precision so a microsecond stored on the server side
  // doesn't false-409 against the millisecond-precision ISO string the
  // client round-trips through JSON. Matches checkVersion() semantics.
  const r = await pool.query(
    `UPDATE "${table}" SET ${setClause}, updated_at=NOW()
       WHERE id=$1
         AND date_trunc('second', updated_at) = date_trunc('second', $2::timestamptz)
       RETURNING *`,
    [id, clientUpdatedAt, ...params]
  );
  if (r.rows.length) return { row: r.rows[0] };
  // 0 rows changed → either gone OR stale. Find out which.
  const cur = await pool.query(`SELECT * FROM "${table}" WHERE id=$1`, [id]);
  if (!cur.rows.length) return { notFound: true };
  return { conflict: { current: cur.rows[0] } };
}

module.exports = { checkVersion, updateWithVersion };
