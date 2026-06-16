const test = require('node:test');
const assert = require('node:assert/strict');

const cloneImport = require('../services/cloneImport');

function makePool({ columns, rows }) {
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      if (/information_schema\.columns/i.test(text)) {
        const table = params[0];
        return { rows: (columns[table] || []).map((column_name) => ({ column_name })) };
      }

      const select = text.match(/SELECT \* FROM "([a-z_][a-z0-9_]*)" WHERE ([\s\S]+?) LIMIT 1/i);
      if (select) {
        const table = select[1];
        const where = select[2];
        const source = rows[table] || [];
        const cols = [...where.matchAll(/"([a-z_][a-z0-9_]*)"/gi)].map((m) => m[1]);
        const hit = source.find((row) => cols.every((c, i) => {
          const a = row[c] === undefined ? null : row[c];
          const b = params[i] === undefined ? null : params[i];
          return String(a) === String(b);
        }));
        return { rows: hit ? [hit] : [] };
      }

      return { rows: [] };
    },
    release() {},
  };
  return { connect: async () => client };
}

test('cloneImport preview dedupes by business key before raw id', async () => {
  const pool = makePool({
    columns: {
      rooms_v2: ['id', 'room_code', 'floor', 'room_no'],
    },
    rows: {
      rooms_v2: [
        { id: 1, room_code: '101', floor: 1, room_no: 101 },
      ],
    },
  });

  const backup = {
    schemaVersion: 1,
    tables: {
      rooms_v2: [
        { id: 99, room_code: '101', floor: 1, room_no: 101 },
        { id: 1, room_code: '102', floor: 1, room_no: 102 },
        { id: 100, room_code: '103', floor: 1, room_no: 103 },
      ],
    },
  };

  const report = await cloneImport.cloneImportBackup(pool, backup, { dryRun: true });
  assert.equal(report.stats.rooms_v2.incoming, 3);
  assert.equal(report.stats.rooms_v2.duplicates, 1);
  assert.equal(report.stats.rooms_v2.conflicts, 0);
  assert.equal(report.stats.rooms_v2.remappedIds, 1);
  assert.equal(report.stats.rooms_v2.wouldInsert, 2);
  assert.equal(report.totals.duplicates, 1);
  assert.equal(report.totals.conflicts, 0);
  assert.equal(report.totals.remappedIds, 1);
  assert.equal(report.totals.wouldInsert, 2);
});

test('cloneImport remaps known parent ids and reports missing parents', () => {
  const idMaps = {
    tenants: new Map([['10', 77]]),
  };
  const ok = cloneImport.remapForeignKeys('bills', { id: 1, tenant_id: 10 }, idMaps);
  assert.equal(ok.row.tenant_id, 77);
  assert.deepEqual(ok.missing, []);

  const missing = cloneImport.remapForeignKeys('bills', { id: 2, tenant_id: 11 }, idMaps);
  assert.deepEqual(missing.missing, ['tenant_id->tenants:11']);
});

test('cloneImport apply remaps colliding ids so child rows keep working', async () => {
  const db = {
    tenants: [{ id: 1, full_name: 'Existing', phone: '0800000000' }],
    file_uploads: [{ id: 1, category: 'slip', filename: 'existing.jpg', url: '/files/1' }],
    bills: [],
    payments: [],
  };
  const columns = {
    file_uploads: ['id', 'category', 'filename', 'url', 'storage'],
    tenants: ['id', 'full_name', 'phone'],
    bills: ['id', 'bill_no', 'tenant_id', 'room_id', 'period', 'total'],
    payments: ['id', 'bill_id', 'tenant_id', 'amount', 'method', 'status'],
  };
  const serial = { file_uploads: 50, tenants: 100, bills: 200, payments: 300 };
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      if (text === 'BEGIN' || text === 'COMMIT' || /^SELECT setval/i.test(text)) return { rows: [], rowCount: 0 };
      if (/information_schema\.columns/i.test(text)) {
        const table = params[0];
        return { rows: (columns[table] || []).map((column_name) => ({ column_name })) };
      }
      const select = text.match(/SELECT \* FROM "([a-z_][a-z0-9_]*)" WHERE ([\s\S]+?) LIMIT 1/i);
      if (select) {
        const table = select[1];
        const where = select[2];
        const cols = [...where.matchAll(/"([a-z_][a-z0-9_]*)"/gi)].map((m) => m[1]);
        const hit = (db[table] || []).find((row) => cols.every((c, i) => {
          const a = row[c] === undefined ? null : row[c];
          const b = params[i] === undefined ? null : params[i];
          return String(a) === String(b);
        }));
        return { rows: hit ? [hit] : [] };
      }
      const insert = text.match(/INSERT INTO "([a-z_][a-z0-9_]*)" \(([^)]+)\)/i);
      if (insert) {
        const table = insert[1];
        const cols = insert[2].split(',').map((s) => s.replace(/"/g, '').trim());
        const row = {};
        cols.forEach((c, i) => { row[c] = params[i]; });
        if (!Object.prototype.hasOwnProperty.call(row, 'id') && columns[table].includes('id')) {
          row.id = serial[table]++;
        }
        db[table].push(row);
        return { rows: [row], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };

  const backup = {
    schemaVersion: 1,
    tables: {
      file_uploads: [{ id: 1, category: 'slip', filename: 'imported.jpg', url: '/files/1', storage: 'local' }],
      tenants: [{ id: 1, full_name: 'Imported', phone: '0811111111' }],
      bills: [{ id: 2, bill_no: 'B-1', tenant_id: 1, room_id: '101', period: '2026-06', total: 5000 }],
      payments: [{ id: 3, bill_id: 2, tenant_id: 1, amount: 5000, method: 'cash', status: 'verified' }],
    },
  };

  const report = await cloneImport.cloneImportBackup({ connect: async () => client }, backup, { dryRun: false });
  assert.equal(report.stats.tenants.remappedIds, 1);
  assert.equal(report.stats.tenants.inserted, 1);
  assert.equal(report.stats.file_uploads.remappedIds, 1);
  assert.equal(db.file_uploads[1].id, 50);
  assert.equal(db.file_uploads[1].url, '');
  assert.equal(db.tenants[1].id, 100);
  assert.equal(db.bills[0].tenant_id, 100);
  assert.equal(db.payments[0].tenant_id, 100);
  assert.equal(db.payments[0].bill_id, db.bills[0].id);
});
