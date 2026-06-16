'use strict';

const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;

const CLONE_IMPORT_TABLES = [
  'app_data', 'auth_users', 'system_settings',
  'rooms_v2',
  'file_uploads',
  'line_oas',
  'admin_line_recipients',
  'tenants',
  'access_devices',
  'contract_templates',
  'contracts', 'bills', 'recurring_charges',
  'payments', 'parcels', 'access_cards', 'line_bindings',
  'meter_readings',
  'maintenance_tickets',
  'access_logs',
  'audit_logs',
  'notifications_log',
  'bookings',
  'booking_deposit_orphans',
  'contract_invitations',
];

const NATURAL_KEYS = {
  app_data: [['key']],
  auth_users: [['username']],
  system_settings: [['key']],
  rooms_v2: [['room_code']],
  line_oas: [['slug']],
  admin_line_recipients: [['line_oa_id', 'line_user_id']],
  maintenance_tickets: [['ticket_no']],
  contracts: [['contract_no']],
  bills: [['bill_no']],
  meter_readings: [['room_id', 'meter_type', 'period']],
  access_cards: [['card_id']],
  access_devices: [['device_id']],
  parcels: [['parcel_no']],
  line_bindings: [['code']],
  bookings: [['external_id'], ['deposit_transaction_ref'], ['deposit_slip_hash']],
  booking_deposit_orphans: [['ref']],
  contract_invitations: [['token_hash']],
};

const FOREIGN_KEYS = {
  admin_line_recipients: { line_oa_id: 'line_oas' },
  tenants: {
    citizen_id_image_front_id: 'file_uploads',
    citizen_id_image_back_id: 'file_uploads',
    line_oa_id: 'line_oas',
  },
  contracts: {
    tenant_id: 'tenants',
    template_id: 'contract_templates',
    signature_image_id: 'file_uploads',
  },
  bills: { tenant_id: 'tenants' },
  payments: { bill_id: 'bills', tenant_id: 'tenants' },
  parcels: {
    tenant_id: 'tenants',
    photo_file_id: 'file_uploads',
    pickup_proof_file_id: 'file_uploads',
  },
  access_cards: { tenant_id: 'tenants' },
  line_bindings: { tenant_id: 'tenants', oa_id: 'line_oas', target_oa_id: 'line_oas' },
  maintenance_tickets: { tenant_id: 'tenants' },
  access_logs: { tenant_id: 'tenants' },
  bookings: {
    citizen_id_image_front_id: 'file_uploads',
    deposit_slip_file_id: 'file_uploads',
  },
  booking_deposit_orphans: { slip_file_id: 'file_uploads' },
  contract_invitations: { contract_id: 'contracts', tenant_id: 'tenants' },
};

function assertIdent(name) {
  if (!IDENT_RE.test(String(name || ''))) {
    throw new Error(`invalid identifier: ${String(name || '').slice(0, 40)}`);
  }
  return name;
}

function q(name) {
  return `"${assertIdent(name)}"`;
}

function normalizeValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = normalizeValue(value[key]);
    return out;
  }
  return value === undefined ? null : value;
}

function stable(value) {
  return JSON.stringify(normalizeValue(value));
}

function rowEquivalent(incoming, existing, cols, opts = {}) {
  const ignore = new Set(opts.ignore || []);
  const a = {};
  const b = {};
  for (const c of cols.slice().sort()) {
    if (ignore.has(c)) continue;
    a[c] = incoming[c] === undefined ? null : incoming[c];
    b[c] = existing[c] === undefined ? null : existing[c];
  }
  return stable(a) === stable(b);
}

function hasUsableKey(row, cols) {
  return cols.every((c) => row[c] !== undefined && row[c] !== null && row[c] !== '');
}

async function getTableColumns(client, table) {
  const { rows } = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  return new Set(rows.map((r) => r.column_name));
}

async function findExisting(client, table, cols, row) {
  if (!hasUsableKey(row, cols)) return null;
  const where = cols.map((c, i) => `${q(c)} IS NOT DISTINCT FROM $${i + 1}`).join(' AND ');
  const values = cols.map((c) => row[c]);
  const { rows } = await client.query(
    `SELECT * FROM ${q(table)} WHERE ${where} LIMIT 1`,
    values
  );
  return rows[0] || null;
}

function initStats(rows) {
  return {
    incoming: Array.isArray(rows) ? rows.length : 0,
    wouldInsert: 0,
    inserted: 0,
    duplicates: 0,
    conflicts: 0,
    remappedIds: 0,
    skipped: 0,
    failed: 0,
    unknownColumns: [],
    notes: [],
  };
}

function addIdMap(idMaps, table, oldId, newId) {
  if (oldId === undefined || oldId === null || newId === undefined || newId === null) return;
  if (!idMaps[table]) idMaps[table] = new Map();
  idMaps[table].set(String(oldId), newId);
}

function remapForeignKeys(table, row, idMaps) {
  const refs = FOREIGN_KEYS[table] || {};
  const next = { ...row };
  const missing = [];
  for (const [col, parent] of Object.entries(refs)) {
    if (next[col] === undefined || next[col] === null || next[col] === '') continue;
    const map = idMaps[parent];
    if (map && map.has(String(next[col]))) {
      next[col] = map.get(String(next[col]));
    } else {
      missing.push(`${col}->${parent}:${next[col]}`);
    }
  }
  return { row: next, missing };
}

function summarize(allStats, dryRun) {
  const totals = {
    incoming: 0,
    wouldInsert: 0,
    inserted: 0,
    duplicates: 0,
    conflicts: 0,
    remappedIds: 0,
    skipped: 0,
    failed: 0,
  };
  for (const st of Object.values(allStats)) {
    for (const key of Object.keys(totals)) totals[key] += Number(st[key] || 0);
  }
  return {
    dryRun: !!dryRun,
    totals,
    hasConflicts: totals.conflicts > 0 || totals.failed > 0,
  };
}

async function resetSequence(client, table) {
  try {
    await client.query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'),
                      COALESCE((SELECT MAX(id) FROM ${q(table)}), 1), true)`,
      [table]
    );
  } catch {
    // Tables without a serial id do not need a sequence reset.
  }
}

async function cloneImportBackup(pool, backup, opts = {}) {
  const dryRun = opts.dryRun !== false;
  if (!backup || backup.schemaVersion !== 1 || !backup.tables || typeof backup.tables !== 'object') {
    const err = new Error('invalid backup format (schemaVersion=1 expected)');
    err.code = 'BAD_FORMAT';
    throw err;
  }

  const client = await pool.connect();
  const stats = {};
  const errors = [];
  const idMaps = {};

  try {
    if (!dryRun) await client.query('BEGIN');

    for (const table of CLONE_IMPORT_TABLES) {
      assertIdent(table);
      const sourceRows = backup.tables[table];
      const st = initStats(sourceRows);
      stats[table] = st;

      if (!Array.isArray(sourceRows)) {
        st.skipped += 1;
        st.notes.push(sourceRows && sourceRows.__skipped ? sourceRows.__skipped : 'not in backup');
        continue;
      }

      const targetCols = await getTableColumns(client, table);
      if (!targetCols.size) {
        st.skipped += sourceRows.length;
        st.notes.push('table does not exist on this deploy');
        continue;
      }

      for (const original of sourceRows) {
        if (!original || typeof original !== 'object' || Array.isArray(original)) {
          st.failed += 1;
          errors.push(`${table}: row is not an object`);
          continue;
        }

        const invalidCol = Object.keys(original).find((c) => !IDENT_RE.test(c));
        if (invalidCol) {
          st.failed += 1;
          errors.push(`${table}: invalid column name ${String(invalidCol).slice(0, 40)}`);
          continue;
        }

        const unknown = Object.keys(original).filter((c) => !targetCols.has(c));
        if (unknown.length) {
          st.unknownColumns.push(...unknown.filter((c) => !st.unknownColumns.includes(c)).slice(0, 20));
        }

        const row = {};
        for (const c of Object.keys(original)) {
          if (targetCols.has(c)) row[c] = original[c] === undefined ? null : original[c];
        }
        if (!Object.keys(row).length) {
          st.skipped += 1;
          errors.push(`${table}: no matching columns on target`);
          continue;
        }

        const remapped = remapForeignKeys(table, row, idMaps);
        if (remapped.missing.length) {
          st.skipped += 1;
          errors.push(`${table}: skipped because parent row is missing or conflicted (${remapped.missing.slice(0, 3).join(', ')})`);
          continue;
        }
        const candidate = remapped.row;
        const cols = Object.keys(candidate);

        let existing = null;
        let duplicateBy = null;
        for (const key of NATURAL_KEYS[table] || []) {
          if (!key.every((c) => targetCols.has(c))) continue;
          const hit = await findExisting(client, table, key, candidate);
          if (hit) {
            existing = hit;
            duplicateBy = key.join('+');
            break;
          }
        }
        if (!existing && targetCols.has('id') && candidate.id !== undefined && candidate.id !== null) {
          existing = await findExisting(client, table, ['id'], candidate);
          duplicateBy = existing ? 'id' : null;
        }

        if (existing) {
          const ignore = duplicateBy === 'id' ? [] : ['id'];
          if (rowEquivalent(candidate, existing, cols, { ignore })) {
            st.duplicates += 1;
            if (targetCols.has('id')) addIdMap(idMaps, table, row.id, existing.id);
            continue;
          }
          if (duplicateBy === 'id' && targetCols.has('id')) {
            const generated = { ...candidate };
            delete generated.id;
            if (table === 'file_uploads' && /^\/files\/\d+$/i.test(String(generated.url || ''))) {
              generated.url = '';
            }
            const generatedCols = Object.keys(generated);
            st.remappedIds += 1;
            if (dryRun) {
              st.wouldInsert += 1;
              addIdMap(idMaps, table, row.id, row.id);
              continue;
            }
            const colList = generatedCols.map(q).join(',');
            const placeholders = generatedCols.map((_, i) => `$${i + 1}`).join(',');
            const values = generatedCols.map((c) => generated[c]);
            try {
              const inserted = await client.query(
                `INSERT INTO ${q(table)} (${colList}) VALUES (${placeholders})
                 ON CONFLICT DO NOTHING RETURNING *`,
                values
              );
              if (inserted.rows[0]) {
                st.inserted += 1;
                addIdMap(idMaps, table, row.id, inserted.rows[0].id);
              } else {
                st.conflicts += 1;
                errors.push(`${table}: row skipped by database unique constraint after id remap`);
              }
            } catch (err) {
              st.failed += 1;
              errors.push(`${table}: ${String(err.message || err).slice(0, 160)}`);
            }
          } else {
            st.conflicts += 1;
            errors.push(`${table}: conflict on ${duplicateBy || 'unique key'} (${targetCols.has('id') ? `incoming id ${row.id}` : 'no id'})`);
          }
          continue;
        }

        if (dryRun) {
          st.wouldInsert += 1;
          if (targetCols.has('id')) addIdMap(idMaps, table, row.id, candidate.id);
          continue;
        }

        const colList = cols.map(q).join(',');
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
        const values = cols.map((c) => candidate[c]);
        try {
          const inserted = await client.query(
            `INSERT INTO ${q(table)} (${colList}) VALUES (${placeholders})
             ON CONFLICT DO NOTHING RETURNING *`,
            values
          );
          if (inserted.rows[0]) {
            st.inserted += 1;
            if (targetCols.has('id')) addIdMap(idMaps, table, row.id, inserted.rows[0].id);
          } else {
            st.conflicts += 1;
            errors.push(`${table}: row skipped by database unique constraint`);
          }
        } catch (err) {
          st.failed += 1;
          errors.push(`${table}: ${String(err.message || err).slice(0, 160)}`);
        }
      }

      if (!dryRun) await resetSequence(client, table);
    }

    if (!dryRun) await client.query('COMMIT');
    return {
      ok: true,
      mode: 'merge',
      stats,
      errors: errors.slice(0, 100),
      errorCount: errors.length,
      ...summarize(stats, dryRun),
    };
  } catch (err) {
    if (!dryRun) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  CLONE_IMPORT_TABLES,
  NATURAL_KEYS,
  FOREIGN_KEYS,
  cloneImportBackup,
  rowEquivalent,
  remapForeignKeys,
  summarize,
};
