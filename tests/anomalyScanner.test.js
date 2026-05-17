// tests/anomalyScanner.test.js
// Each detector receives a tiny pool stub returning canned data. We
// assert it produces the expected anomaly id + severity + count. Pure
// node:test, no DB needed.

const { test } = require('node:test');
const assert = require('node:assert');
const scanner = require('../services/anomalyScanner');

// Tiny pool stub: takes a route table mapping SQL substring → result rows
function stubPool(routes) {
  return {
    query: async (sql) => {
      for (const [needle, rows] of Object.entries(routes)) {
        if (sql.includes(needle)) {
          return { rows: Array.isArray(rows) ? rows : [] };
        }
      }
      return { rows: [] };
    },
  };
}

// === scan integration =====================================================

test('scan: empty DB returns config-missing anomaly only', async () => {
  const pool = stubPool({});
  const out = await scanner.scan(pool);
  assert.ok(out.scannedAt);
  // Empty config table → CONFIG_MISSING
  const missing = out.items.find((i) => i.id === 'CONFIG_MISSING');
  assert.ok(missing, 'should report CONFIG_MISSING');
  assert.strictEqual(missing.severity, 'warn');
});

test('scan: summary counts severities', async () => {
  const pool = stubPool({
    'baankarn_config_v1': [
      // rent=1 → critical, deposit ok
      { value: { rates: { standard: { rent: 1, deposit: 4500 } } } },
    ],
  });
  const out = await scanner.scan(pool);
  assert.strictEqual(out.summary.critical >= 1, true);
});

// === pricing detector =====================================================

test('detector: rates.standard.rent=1 → PRICING_RENT_TOO_LOW critical', async () => {
  const pool = stubPool({
    'baankarn_config_v1': [{
      value: { rates: { standard: { rent: 1 }, deluxe: { rent: 5800 } } },
    }],
  });
  const out = await scanner.scan(pool);
  const a = out.items.find((i) => i.id === 'PRICING_RENT_TOO_LOW');
  assert.ok(a, 'should detect rent=1');
  assert.strictEqual(a.severity, 'critical');
  assert.strictEqual(a.count, 1);
  assert.strictEqual(a.domain, 'pricing');
  assert.ok(a.fix.includes('/admin#pricing'));
});

test('detector: utilities.waterRate=0 → UTILITY_RATE_ZERO critical', async () => {
  const pool = stubPool({
    'baankarn_config_v1': [{
      value: { rates: { standard: { rent: 4500 } }, utilities: { waterRate: 0, elecRate: 8 } },
    }],
  });
  const out = await scanner.scan(pool);
  const a = out.items.find((i) => i.id === 'UTILITY_RATE_ZERO');
  assert.ok(a);
  assert.strictEqual(a.severity, 'critical');
  assert.strictEqual(a.domain, 'utility');
});

test('detector: healthy config produces no pricing anomalies', async () => {
  const pool = stubPool({
    'baankarn_config_v1': [{
      value: {
        rates: { standard: { rent: 4500, deposit: 9000 }, deluxe: { rent: 5800, deposit: 11600 } },
        utilities: { waterRate: 18, elecRate: 8 },
      },
    }],
  });
  const out = await scanner.scan(pool);
  assert.strictEqual(out.items.find((i) => i.domain === 'pricing'), undefined);
  assert.strictEqual(out.items.find((i) => i.domain === 'utility'), undefined);
});

// === bill detector ========================================================

test('detector: tiny bill totals → BILL_TOTAL_TOO_LOW', async () => {
  const pool = stubPool({
    'b.total > 0 AND b.total < 100': [
      { id: 1, bill_no: 'INV-2026-01-101', room_id: '101', total: 5, status: 'pending', d: '2026-01-15' },
    ],
    'baankarn_config_v1': [{ value: { rates: { standard: { rent: 4500 } }, utilities: { waterRate: 18, elecRate: 8 } } }],
  });
  const out = await scanner.scan(pool);
  const a = out.items.find((i) => i.id === 'BILL_TOTAL_TOO_LOW');
  assert.ok(a);
  assert.strictEqual(a.severity, 'critical');
});

test('detector: huge bill totals → BILL_TOTAL_TOO_HIGH', async () => {
  const pool = stubPool({
    'b.total > 100000': [
      { id: 1, bill_no: 'INV-2026-01-101', room_id: '101', total: 500000, status: 'pending' },
    ],
    'baankarn_config_v1': [{ value: { rates: { standard: { rent: 4500 } }, utilities: { waterRate: 18, elecRate: 8 } } }],
  });
  const out = await scanner.scan(pool);
  const a = out.items.find((i) => i.id === 'BILL_TOTAL_TOO_HIGH');
  assert.ok(a);
  assert.strictEqual(a.severity, 'warn');
});

test('detector: orphan payable bill → BILL_NO_TENANT', async () => {
  const pool = stubPool({
    'tenant_id IS NULL': [
      { id: 5, bill_no: 'INV-101', room_id: '101', total: 4500 },
    ],
    'baankarn_config_v1': [{ value: { rates: { standard: { rent: 4500 } }, utilities: { waterRate: 18, elecRate: 8 } } }],
  });
  const out = await scanner.scan(pool);
  const a = out.items.find((i) => i.id === 'BILL_NO_TENANT');
  assert.ok(a);
});

// === tenant detector ======================================================

test('detector: active tenant without room → TENANT_ACTIVE_NO_ROOM', async () => {
  const pool = stubPool({
    'current_room_id IS NULL OR current_room_id': [
      { id: 18, full_name: 'หเกด', phone: '098764321', d: '2026-05-10' },
    ],
    'baankarn_config_v1': [{ value: { rates: { standard: { rent: 4500 } }, utilities: { waterRate: 18, elecRate: 8 } } }],
  });
  const out = await scanner.scan(pool);
  const a = out.items.find((i) => i.id === 'TENANT_ACTIVE_NO_ROOM');
  assert.ok(a);
  assert.strictEqual(a.severity, 'warn');
  assert.strictEqual(a.items[0].id, 18);
});

test('detector: tenant in non-occupied room → TENANT_ROOM_STATUS_DRIFT', async () => {
  const pool = stubPool({
    "rv.status NOT IN ('occupied','overdue')": [
      { id: 19, full_name: 'X', current_room_id: '103', room_status: 'vacant' },
    ],
    'baankarn_config_v1': [{ value: { rates: { standard: { rent: 4500 } }, utilities: { waterRate: 18, elecRate: 8 } } }],
  });
  const out = await scanner.scan(pool);
  const a = out.items.find((i) => i.id === 'TENANT_ROOM_STATUS_DRIFT');
  assert.ok(a);
});

test('detector: multiple active contracts per tenant → TENANT_MULTI_CONTRACT', async () => {
  const pool = stubPool({
    'HAVING COUNT(*) > 1': [
      { tenant_id: 7, n: 2 },
    ],
    'baankarn_config_v1': [{ value: { rates: { standard: { rent: 4500 } }, utilities: { waterRate: 18, elecRate: 8 } } }],
  });
  const out = await scanner.scan(pool);
  const a = out.items.find((i) => i.id === 'TENANT_MULTI_CONTRACT');
  assert.ok(a);
  assert.strictEqual(a.severity, 'critical');
});

// === contract detector ====================================================

test('detector: contract without monthly_rent → CONTRACT_NO_RENT', async () => {
  const pool = stubPool({
    'monthly_rent IS NULL OR monthly_rent <= 0': [
      { id: 1, contract_no: 'C-2026-0001', tenant_id: 1, room_id: '101' },
    ],
    'baankarn_config_v1': [{ value: { rates: { standard: { rent: 4500 } }, utilities: { waterRate: 18, elecRate: 8 } } }],
  });
  const out = await scanner.scan(pool);
  const a = out.items.find((i) => i.id === 'CONTRACT_NO_RENT');
  assert.ok(a);
  assert.strictEqual(a.severity, 'critical');
  assert.ok(a.fix.includes('backfill-contract-rents'));
});

test('detector: low active contract rent -> CONTRACT_RENT_TOO_LOW', async () => {
  const pool = stubPool({
    'monthly_rent < $1::numeric': [
      { id: 19, contract_no: 'C-2026-0019', tenant_id: 19, room_id: '103', monthly_rent: 201, reference_rent: 4500 },
    ],
    'baankarn_config_v1': [{ value: { rates: { standard: { rent: 4500 } }, utilities: { waterRate: 18, elecRate: 8 } } }],
  });
  const out = await scanner.scan(pool);
  const a = out.items.find((i) => i.id === 'CONTRACT_RENT_TOO_LOW');
  assert.ok(a);
  assert.strictEqual(a.severity, 'critical');
  assert.strictEqual(a.domain, 'contract');
  assert.match(a.items[0].label, /201/);
});

test('detector: signed but unlocked contract -> CONTRACT_SIGNED_NOT_LOCKED', async () => {
  const pool = stubPool({
    'signed_at IS NOT NULL': [
      { id: 1, contract_no: 'C-2026-0001', tenant_id: 1, room_id: '101', signed_at: '2026-05-10' },
    ],
    'baankarn_config_v1': [{ value: { rates: { standard: { rent: 4500 } }, utilities: { waterRate: 18, elecRate: 8 } } }],
  });
  const out = await scanner.scan(pool);
  const a = out.items.find((i) => i.id === 'CONTRACT_SIGNED_NOT_LOCKED');
  assert.ok(a);
  assert.strictEqual(a.severity, 'warn');
});

test('detector: expired-still-active contract → CONTRACT_EXPIRED_ACTIVE', async () => {
  const pool = stubPool({
    "end_date < CURRENT_DATE - INTERVAL '7 days'": [
      { id: 1, contract_no: 'C-2025-0001', room_id: '201', end_date: '2025-01-01' },
    ],
    'baankarn_config_v1': [{ value: { rates: { standard: { rent: 4500 } }, utilities: { waterRate: 18, elecRate: 8 } } }],
  });
  const out = await scanner.scan(pool);
  const a = out.items.find((i) => i.id === 'CONTRACT_EXPIRED_ACTIVE');
  assert.ok(a);
});

// === room detector ========================================================

test('detector: ghost-occupied room → ROOM_GHOST_OCCUPIED', async () => {
  const pool = stubPool({
    "AND t.status='active' AND t.current_room_id=rv.room_code": [
      { room_code: '305', status: 'occupied' },
    ],
    'baankarn_config_v1': [{ value: { rates: { standard: { rent: 4500 } }, utilities: { waterRate: 18, elecRate: 8 } } }],
  });
  const out = await scanner.scan(pool);
  const a = out.items.find((i) => i.id === 'ROOM_GHOST_OCCUPIED');
  assert.ok(a);
});

test('detector: override without reason → ROOM_OVERRIDE_NO_REASON', async () => {
  const pool = stubPool({
    'rent_override IS NOT NULL': [
      { room_code: '305', rent_override: 5200, rent_override_by: 'admin' },
    ],
    'baankarn_config_v1': [{ value: { rates: { standard: { rent: 4500 } }, utilities: { waterRate: 18, elecRate: 8 } } }],
  });
  const out = await scanner.scan(pool);
  const a = out.items.find((i) => i.id === 'ROOM_OVERRIDE_NO_REASON');
  assert.ok(a);
  assert.strictEqual(a.severity, 'info');
});

test('detector: stale JSONB room tenant -> ROOM_BLOB_STALE_TENANT', async () => {
  const pool = stubPool({
    "br.room ? 'tenant'": [
      { room_code: '305', status: 'occupied' },
    ],
    'baankarn_config_v1': [{ value: { rates: { standard: { rent: 4500 } }, utilities: { waterRate: 18, elecRate: 8 } } }],
  });
  const out = await scanner.scan(pool);
  const a = out.items.find((i) => i.id === 'ROOM_BLOB_STALE_TENANT');
  assert.ok(a);
  assert.strictEqual(a.severity, 'warn');
  assert.strictEqual(a.fix, '/admin#rooms');
});

// === payment detector =====================================================

test('detector: stuck pending payment → PAYMENT_STUCK_PENDING', async () => {
  const pool = stubPool({
    "p.created_at < NOW() - INTERVAL '48 hours'": [
      { id: 1, bill_id: 100, amount: 4500, d: '2026-01-01', bill_no: 'INV-101' },
    ],
    'baankarn_config_v1': [{ value: { rates: { standard: { rent: 4500 } }, utilities: { waterRate: 18, elecRate: 8 } } }],
  });
  const out = await scanner.scan(pool);
  const a = out.items.find((i) => i.id === 'PAYMENT_STUCK_PENDING');
  assert.ok(a);
});

// === fail-soft ============================================================

test('scan: detector that throws is wrapped, others still run', async () => {
  const pool = {
    query: async (sql) => {
      // Throw on the bill detector's first query — anomalyScanner should
      // catch it and emit a SCAN_FAILED_BILL entry instead of crashing.
      if (sql.includes('FROM bills b')) throw new Error('boom');
      return { rows: [] };
    },
  };
  const out = await scanner.scan(pool);
  const failed = out.items.find((i) => i.id.startsWith('SCAN_FAILED_'));
  assert.ok(failed, 'should emit SCAN_FAILED_BILL when bill detector throws');
  assert.strictEqual(failed.severity, 'warn');
});

// === sort order ===========================================================

test('scan: items sorted critical → warn → info', async () => {
  const pool = stubPool({
    "p.created_at < NOW() - INTERVAL '48 hours'": [   // warn
      { id: 1, bill_id: 100, amount: 4500, d: '2026-01-01', bill_no: 'INV-1' },
    ],
    'rent_override IS NOT NULL': [    // info
      { room_code: '305', rent_override: 5200 },
    ],
    'baankarn_config_v1': [{
      value: { rates: { standard: { rent: 1 } } },    // critical
    }],
  });
  const out = await scanner.scan(pool);
  const sev = out.items.map((i) => i.severity);
  // Verify monotonically non-increasing severity rank
  for (let i = 1; i < sev.length; i++) {
    assert.ok(
      scanner.SEVERITY_RANK[sev[i - 1]] >= scanner.SEVERITY_RANK[sev[i]],
      `severity should not increase: ${sev[i - 1]} -> ${sev[i]}`
    );
  }
});
