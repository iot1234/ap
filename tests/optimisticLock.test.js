// tests/optimisticLock.test.js
//   node --test tests/optimisticLock.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const ol = require('../db/optimisticLock');

function fakePool(rowsByQuery) {
  return {
    query: async (sql) => {
      for (const [pattern, rows] of Object.entries(rowsByQuery)) {
        if (sql.includes(pattern)) return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test('checkVersion: ok when no client-supplied updated_at', async () => {
  const r = await ol.checkVersion(fakePool({}), 'tenants', 1, undefined);
  assert.equal(r.ok, true);
});

test('checkVersion: ok when row gone (caller handles 404)', async () => {
  const r = await ol.checkVersion(fakePool({ 'SELECT updated_at': [] }), 'tenants', 1, '2026-01-01T00:00:00Z');
  assert.equal(r.ok, true);
});

test('checkVersion: ok when timestamps match', async () => {
  const ts = '2026-05-07T10:00:00.000Z';
  const r = await ol.checkVersion(
    fakePool({ 'SELECT updated_at': [{ updated_at: ts, id: 1 }] }),
    'tenants', 1, ts
  );
  assert.equal(r.ok, true);
});

test('checkVersion: conflict when timestamps differ', async () => {
  const r = await ol.checkVersion(
    fakePool({ 'SELECT updated_at': [{ updated_at: '2026-05-07T10:00:00Z', id: 1, name: 'Foo' }] }),
    'tenants', 1, '2026-05-07T09:00:00Z'
  );
  assert.ok(r.conflict);
  assert.equal(r.conflict.row.name, 'Foo');
});

test('checkVersion: rejects invalid table name (SQL injection guard)', async () => {
  await assert.rejects(
    () => ol.checkVersion(fakePool({}), 'tenants; DROP TABLE users;', 1, 'x'),
    /invalid table name/
  );
});

test('updateWithVersion: success when version matches', async () => {
  const pool = {
    query: async (sql) => {
      if (sql.includes('UPDATE')) return { rows: [{ id: 1, updated_at: 'now', name: 'New' }] };
      return { rows: [], rowCount: 0 };
    },
  };
  const r = await ol.updateWithVersion(pool, 'tenants', 1, '2026-01-01', 'name=$3', ['New']);
  assert.equal(r.row.name, 'New');
});

test('updateWithVersion: conflict when 0 rows updated and row still exists', async () => {
  let calls = 0;
  const pool = {
    query: async (sql) => {
      calls++;
      if (calls === 1) return { rows: [], rowCount: 0 };  // UPDATE returned 0
      return { rows: [{ id: 1, updated_at: 'newer', name: 'Old' }] };  // SELECT returns current
    },
  };
  const r = await ol.updateWithVersion(pool, 'tenants', 1, '2026-01-01', 'name=$3', ['New']);
  assert.equal(r.row, undefined);
  assert.ok(r.conflict);
  assert.equal(r.conflict.current.id, 1);
});

test('updateWithVersion: notFound when 0 rows + row doesn\'t exist', async () => {
  let calls = 0;
  const pool = {
    query: async () => {
      calls++;
      return { rows: [], rowCount: 0 };
    },
  };
  const r = await ol.updateWithVersion(pool, 'tenants', 99, '2026-01-01', 'name=$3', ['New']);
  assert.equal(r.notFound, true);
});
