// tests/fix-tenant-ops.test.js
// Regression tests for the tenant check-in / check-out audit fixes in
// routes/tenant-ops.js:
//   1. Contract deposit derives from the room's own pricing (blob deposit /
//      rooms_v2.deposit_price → rent×2 fallback), and the DEPOSIT_TOO_LARGE
//      cap validates the DERIVED value that actually lands on the contract —
//      not the discarded request depositAmount.
//   2. Welcome bill + checkout closing bill carry VAT exactly like every
//      buildBill-generated recurring bill (R1: VAT on rent/utility/wifi/common,
//      NEVER on late-fee penalties).
//   3. Welcome bill due date is floored at max(moveIn, today)+7d so a move-in
//      after the configured due day (or a back-dated check-in) can't mint a
//      bill that tickLateFee flips overdue + fines on its next tick.
//   4. Same-month re-check-in (after a checkout that left an '-X' closing
//      bill) skips the welcome bill instead of 23505-ing the whole check-in
//      on uq_bills_room_period_tenant_active.
//   5. Check-in meter-start backward guard consults the room's LATEST reading
//      (meter.latest), not just latestBeforePeriod, so a same-period reading
//      can't be silently undercut + overwritten.
//   6. Checkout records the deposit refund on exactly ONE contract (the room
//      the tenant occupies) — never duplicated across parallel force-checkin
//      contracts.
//   node --test tests/fix-tenant-ops.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const r2 = (n) => Math.round(n * 100) / 100;

const buildTenantOpsRouter = require('../routes/tenant-ops');
const billing = require('../services/billing');

// === Harness ===============================================================
// Drive the real route handlers (including the real zod validateBody) with a
// fake pg pool that routes on SQL text — the same fake-pool idiom the other
// test files use, applied to the full route stack.

function makeCtx(pool) {
  const pass = (req, res, next) => next();
  return {
    pool,
    requireAuth: pass,
    requireRole: () => pass,
    sameOrigin: pass,
    csrfGuard: pass,
    audit: () => Promise.resolve(),
    signBillPayToken: () => 'tok',
  };
}

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function dispatch(pool, method, routePath, req) {
  const router = buildTenantOpsRouter(makeCtx(pool));
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method]
  );
  assert.ok(layer, `route ${method} ${routePath} must exist`);
  const res = makeRes();
  for (const s of layer.route.stack) {
    let nextCalled = false;
    await s.handle(req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return res;
}

// --- check-in fake pool ----------------------------------------------------
// Tenant 7 (moved_out) checks into blob-only room '101' (rent 4500, room
// deposit 3000). Feature flags: VAT 7% on, identity requirements off.
function makeCheckinPool({ periodAlreadyBilled = false } = {}) {
  const captured = { contractInsert: null, billInsert: null };
  const featuresValue = {
    vat: { enabled: true, ratePct: 7 },
    tenancyContract: {
      requireIdentityImages: false,
      requireAddress: false,
      requireEmergencyContact: false,
    },
  };
  async function route(sql, params) {
    const s = String(sql);
    if (/FROM app_data WHERE key=\$1/.test(s) && params && params[0] === 'baankarn_features_v1') {
      return { rows: [{ value: featuresValue }] };
    }
    if (/FROM tenants WHERE id=\$1 AND deleted_at IS NULL FOR UPDATE/.test(s)) {
      return { rows: [{
        id: 7, full_name: 'สมชาย ทดสอบ', phone: '0812345678', email: null,
        status: 'moved_out', current_room_id: null,
        citizen_id_image_front_id: null, citizen_id_image_back_id: null,
        address: null, emergency_contact_name: null, emergency_contact_phone: null,
      }] };
    }
    if (/pg_advisory_xact_lock/.test(s)) return { rows: [] };
    if (/FROM tenants[\s\S]*WHERE current_room_id=\$1 AND status='active'/.test(s)) {
      return { rows: [] };
    }
    if (/key='baankarn_config_v1'/.test(s)) {
      return { rows: [{ value: { notify: { dueOnDay: 1 } } }] };
    }
    if (/key='baankarn_rooms_v1' FOR UPDATE/.test(s)) {
      return { rows: [{ value: {
        101: { id: '101', status: 'vacant', rent: 4500, deposit: 3000 },
      } }] };
    }
    if (/FROM rooms_v2/.test(s)) return { rows: [] };
    if (/FROM contracts[\s\S]*WHERE room_id=\$1 AND status='active'/.test(s)) {
      return { rows: [] };
    }
    if (/UPDATE tenants/.test(s)) {
      return { rows: [{ id: 7, full_name: 'สมชาย ทดสอบ', phone: '0812345678', email: null }] };
    }
    if (/INSERT INTO app_data/.test(s)) return { rowCount: 1, rows: [] };
    if (/UPDATE app_data/.test(s)) return { rowCount: 1, rows: [] };
    if (/UPDATE rooms_v2/.test(s)) return { rowCount: 1, rows: [] };
    if (/SELECT COUNT\(\*\)::int AS n FROM contracts/.test(s)) return { rows: [{ n: 0 }] };
    if (/INSERT INTO contracts/.test(s)) {
      captured.contractInsert = { sql: s, params };
      return { rows: [{ id: 501 }] };
    }
    if (/SELECT tenant_id FROM bills/.test(s)) return { rows: [] };
    if (/FROM meter_readings/.test(s)) return { rows: [] };
    if (/SELECT bill_no FROM bills/.test(s)) {
      return { rows: periodAlreadyBilled ? [{ bill_no: 'INV-PRIOR-101-X-T7' }] : [] };
    }
    if (/INSERT INTO bills/.test(s)) {
      captured.billInsert = { sql: s, params };
      return { rowCount: 1, rows: [] };
    }
    if (/FROM tenants WHERE id=\$1 AND deleted_at IS NULL/.test(s)) {
      return { rows: [{ id: 7, full_name: 'สมชาย ทดสอบ', phone: '0812345678',
        email: null, line_user_id: null, line_oa_id: null, status: 'active' }] };
    }
    return { rows: [], rowCount: 0 };
  }
  const client = { query: route, release() {} };
  return { pool: { query: route, connect: async () => client }, captured };
}

async function runCheckin({ periodAlreadyBilled = false } = {}) {
  const { pool, captured } = makeCheckinPool({ periodAlreadyBilled });
  // Back-dated 20 days (inside the default 30-day window) so the configured
  // due day (1st of the move-in month) is guaranteed already past.
  const todayYmd = billing.localTodayYmd();
  const t0 = new Date(`${todayYmd}T00:00:00Z`);
  const moveInDate = new Date(t0.getTime() - 20 * 86_400_000).toISOString().slice(0, 10);
  const req = {
    params: { id: '7' },
    body: { roomId: '101', moveInDate, depositAmount: 3000, monthlyRent: 4500 },
    session: { user: { username: 'owner1' } },
    headers: {},
  };
  const res = await dispatch(pool, 'post', '/:id/checkin', req);
  return { res, captured, moveInDate, todayYmd, t0 };
}

// --- checkout fake pool ------------------------------------------------------
// Tenant 7 lives in room '202' but ALSO holds a second active contract on
// '101' (force-checkin migration leftover). RETURNING deliberately yields the
// stale contract first to prove the route pins the refund-bearing one.
function makeCheckoutPool({ vatEnabled = false, ratePct = 7, carriedLateFee = 0 } = {}) {
  const captured = { refundTarget: null, contractUpdate: null, billInsert: null };
  const featuresValue = { vat: { enabled: vatEnabled, ratePct } };
  const contractRows = [
    { id: 11, contract_no: 'C-2025-0007', room_id: '101', start_date: '2025-01-01',
      monthly_rent: 4500, deposit: 9000, deposit_returned: null, discount_pct: 0 },
    { id: 22, contract_no: 'C-2026-0007-2', room_id: '202', start_date: '2026-01-01',
      monthly_rent: 4500, deposit: 9000, deposit_returned: 4500, discount_pct: 0 },
  ];
  async function route(sql, params) {
    const s = String(sql);
    if (/FROM app_data WHERE key=\$1/.test(s) && params && params[0] === 'baankarn_features_v1') {
      return { rows: [{ value: featuresValue }] };
    }
    if (/SELECT id, full_name, current_room_id/.test(s)) {
      return { rows: [{ id: 7, full_name: 'สมชาย ทดสอบ', current_room_id: '202',
        line_user_id: null, line_oa_id: null, email: null, phone: '0812345678',
        status: 'active' }] };
    }
    if (/UPDATE tenants SET status='moved_out'/.test(s)) return { rowCount: 1, rows: [] };
    if (/DELETE FROM tenant_sessions/.test(s)) return { rowCount: 1, rows: [] };
    if (/SELECT id FROM contracts/.test(s)) {
      captured.refundTarget = { sql: s, params };
      return { rows: [{ id: 22 }] };
    }
    if (/UPDATE contracts SET status='ended'/.test(s)) {
      captured.contractUpdate = { sql: s, params };
      return { rows: contractRows, rowCount: contractRows.length };
    }
    if (/UPDATE contract_invitations/.test(s)) return { rowCount: 0, rows: [] };
    if (/UPDATE app_data/.test(s)) return { rowCount: 1, rows: [] };
    if (/UPDATE rooms_v2/.test(s)) return { rowCount: 1, rows: [] };
    if (/UPDATE access_cards/.test(s)) return { rowCount: 0, rows: [] };
    if (/SELECT id, amount FROM recurring_charges/.test(s)) {
      return { rows: carriedLateFee > 0 ? [{ id: 5, amount: carriedLateFee }] : [] };
    }
    if (/UPDATE recurring_charges/.test(s)) return { rowCount: 0, rows: [] };
    if (/key='baankarn_config_v1'/.test(s)) return { rows: [{ value: {} }] };
    if (/SELECT value->\$1 AS room FROM app_data/.test(s)) return { rows: [{ room: {} }] };
    if (/FROM meter_readings/.test(s)) return { rows: [] };
    if (/SELECT id FROM bills/.test(s)) return { rows: [] };
    if (/INSERT INTO bills/.test(s)) {
      captured.billInsert = { sql: s, params };
      return { rows: [{ id: 99, bill_no: params[0], total: params[9], due_date: params[5] }] };
    }
    return { rows: [], rowCount: 0 };
  }
  const client = { query: route, release() {} };
  return { pool: { query: route, connect: async () => client }, captured };
}

async function runCheckout(opts = {}) {
  const { pool, captured } = makeCheckoutPool(opts);
  const req = {
    params: { id: '7' },
    body: { reason: 'ย้ายงานต่างจังหวัด', finalDepositReturn: 4500 },
    session: { user: { username: 'owner1' } },
    headers: {},
  };
  const res = await dispatch(pool, 'post', '/:id/checkout', req);
  return { res, captured };
}

// Mirror of the route's Asia/Bangkok "today" used for the closing bill.
function bangkokToday() {
  const bkk = new Date(Date.now() + 7 * 3600 * 1000);
  const ty = bkk.getUTCFullYear();
  const tm = bkk.getUTCMonth() + 1;
  const td = bkk.getUTCDate();
  const daysInMonth = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const period = `${ty}-${String(tm).padStart(2, '0')}`;
  return { td, daysInMonth, period };
}

// === 1. Deposit derived from room pricing + cap on the derived value =======

test('check-in falls back to the room-configured deposit when pricing has no deposit template', async () => {
  const { res, captured } = await runCheckin();
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(captured.contractInsert, 'contract INSERT must run');
  // params: [contractNo, id, roomId, start, end, rent, deposit, ...]
  assert.equal(captured.contractInsert.params[5], 4500, 'rent snapshots from the room');
  assert.equal(captured.contractInsert.params[6], 3000,
    'deposit must fall back to the room\'s configured deposit (3000), not rent×2 (9000)');
});

test('deposit cap guard validates the derived deposit that lands on the contract', () => {
  const ops = read('routes', 'tenant-ops.js');
  assert.match(ops, /pricing\.resolveContractDeposit\(\{[\s\S]{0,160}config: pricingConfig,[\s\S]{0,80}rent: effectiveMonthlyRent/,
    'deposit must use the pricing/contract deposit resolver');
  assert.match(ops, /if \(!isForced && effectiveDepositAmount > maxDeposit\)/,
    'DEPOSIT_TOO_LARGE must check the DERIVED deposit');
  assert.doesNotMatch(ops, /Number\(depositAmount\) > maxDeposit/,
    'the old guard on the discarded request value must be gone');
  // Guard must run before the contract INSERT so an over-cap derived value
  // is refused, never stored.
  const guardIdx = ops.indexOf('effectiveDepositAmount > maxDeposit');
  const insertIdx = ops.indexOf('INSERT INTO contracts');
  assert.ok(guardIdx > 0 && insertIdx > guardIdx,
    'derived-deposit cap guard must precede the contract INSERT');
});

// === 2. VAT parity ==========================================================

test('welcome bill carries VAT like every recurring bill', async () => {
  const { res, captured, moveInDate } = await runCheckin();
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(captured.billInsert, 'welcome bill INSERT must run');
  const p = captured.billInsert.params;
  const period = moveInDate.slice(0, 7);
  const billNo = billing.makeBillNo('101', period);
  const paymentRef = billing.paymentReferenceCents(
    billing.paymentReferenceSeedForBill({ billNo, roomId: '101', period, tenantId: 7 })
  );
  const subtotalWithRef = r2(4500 + paymentRef);
  // params: [billNo, id, roomId, period, rent, water, elec, wifi, other,
  //          subtotal, vat, total, dueDate]
  assert.equal(p[4], 4500, 'welcome rent');
  assert.equal(p[9], subtotalWithRef, 'welcome subtotal includes payment-reference cents');
  assert.equal(p[10], r2(4500 * 0.07), 'VAT 7% on the vatable subtotal');
  assert.equal(p[11], r2(subtotalWithRef + r2(4500 * 0.07)), 'total = subtotal + vat');
  assert.match(captured.billInsert.sql, /\$10, \$11, 0, \$12, \$13/,
    'vat/total must be bound parameters — not the old hardcoded vat=0, total=subtotal');
});

test('checkout closing bill applies VAT to vatable charges but never the carried late fee', async () => {
  const { res, captured } = await runCheckout({ vatEnabled: true, ratePct: 7, carriedLateFee: 300 });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(captured.billInsert, 'closing bill INSERT must run');
  const p = captured.billInsert.params;
  const { td, daysInMonth, period } = bangkokToday();
  const proRatedRent = r2(4500 * (td / daysInMonth));
  const billNo = billing.makeBillNo('202-X', period, { tenantId: 7 });
  const paymentRef = billing.paymentReferenceCents(
    billing.paymentReferenceSeedForBill({ billNo, roomId: '202', period, tenantId: 7 })
  );
  const subtotalWithRef = r2(proRatedRent + 300 + paymentRef);
  // params: [billNo, id, room, period, rent, dueDate, other, subtotal,
  //          lateFee, total, water, elec, wifi, vat]
  assert.equal(p[4], proRatedRent, 'pro-rated rent');
  assert.equal(p[7], subtotalWithRef, 'subtotal folds carried late fee plus payment-reference cents');
  assert.equal(p[13], r2(proRatedRent * 0.07),
    'VAT base excludes the carried late fee (penalties are outside Thai VAT — R1)');
  assert.equal(p[9], r2(subtotalWithRef + r2(proRatedRent * 0.07)),
    'total = subtotal + vat');
  assert.match(captured.billInsert.sql, /subtotal, vat, late_fee, total/,
    'closing bill INSERT must persist the vat column');
  assert.equal(res.body.closingBillDetail.vat, r2(proRatedRent * 0.07),
    'closing bill breakdown surfaces the VAT amount');
});

test('checkout closing bill stays VAT-free when the feature is disabled', async () => {
  const { res, captured } = await runCheckout({ vatEnabled: false });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const p = captured.billInsert.params;
  assert.equal(p[13], 0, 'vat param must be 0 when features.vat is off');
  assert.equal(p[9], p[7], 'total equals subtotal without VAT');
});

// === 3. Welcome bill due-date floor =========================================

test('welcome bill due date is floored so the bill is never born overdue', async () => {
  const { res, captured, todayYmd, t0 } = await runCheckin();
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const dueDate = captured.billInsert.params[12];
  // Config dueOnDay=1 + move-in 20 days back → raw due day is in the past;
  // the floor must give the same 7-day window the closing bill uses.
  const expected = new Date(t0.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
  assert.equal(dueDate, expected, `due date must be today+7, not before today (${todayYmd})`);
  assert.ok(dueDate > todayYmd, 'due date must be in the future');
});

// === 4. Same-month re-check-in skips the welcome bill =======================

test('re-check-in with an existing same-period bill skips the welcome bill instead of failing', async () => {
  const { res, captured } = await runCheckin({ periodAlreadyBilled: true });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(captured.billInsert, null,
    'no welcome bill INSERT — it would 23505 on uq_bills_room_period_tenant_active');
  assert.ok(captured.contractInsert, 'the check-in itself (contract) must still succeed');
  assert.deepEqual(res.body.welcomeBillSkipped,
    { reason: 'period_already_billed', existingBillNo: 'INV-PRIOR-101-X-T7' },
    'the skip must be surfaced to the admin in the response');
  assert.equal(res.body.billNo, null, 'response must not advertise a bill that was never created');
});

// === 5. Meter-start guard wiring ============================================

test('check-in meter-start backward guard consults the room\'s LATEST reading', () => {
  const ops = read('routes', 'tenant-ops.js');
  const checkinIdx = ops.indexOf("r.post('/:id/checkin'");
  const checkoutIdx = ops.indexOf("r.post('/:id/checkout'");
  const checkin = ops.slice(checkinIdx, checkoutIdx);
  assert.match(checkin, /meter\.latest\(client, roomId, mt\)/,
    'must look at the latest reading regardless of period (a same-period checkout reading is invisible to latestBeforePeriod)');
  assert.match(checkin, /const guardReading = \[prevReading, latestReading\]/,
    'guard must compare against the highest known reading — meters only count up');
  assert.match(checkin, /guardReading && Number\(guardReading\.reading\) > startVal && !isForced/,
    'METER_START_BACKWARD must use the combined guard reading');
});

// === 6. Deposit refund recorded on exactly one contract =====================

test('checkout stamps the deposit refund on the current-room contract only', async () => {
  const { res, captured } = await runCheckout({ vatEnabled: false });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  // Refund target selection prefers the room the tenant currently occupies.
  assert.ok(captured.refundTarget, 'refund-target SELECT must run');
  assert.deepEqual(captured.refundTarget.params, [7, '202']);
  assert.match(captured.refundTarget.sql, /ORDER BY \(room_id = \$2\) DESC/);
  // Close-all UPDATE still ends every active contract, but the deposit
  // settlement fields are gated on the single refund contract id.
  const upd = captured.contractUpdate;
  assert.ok(upd, 'contract close UPDATE must run');
  assert.match(upd.sql, /WHERE tenant_id=\$1 AND status='active'/,
    'all active contracts still get closed');
  assert.match(upd.sql, /deposit_returned = CASE WHEN \$2::numeric IS NOT NULL AND id=\$5/,
    'deposit_returned must be restricted to the refund contract');
  assert.match(upd.sql, /deposit_returned_at = CASE WHEN \$2::numeric IS NOT NULL AND id=\$5/);
  assert.match(upd.sql, /deposit_return_reason = CASE WHEN id=\$5/);
  assert.equal(upd.params[4], 22, 'refund contract id = the current-room contract');
  // Response reads the refund off the refund-bearing contract even when
  // RETURNING yields the stale parallel contract first.
  assert.equal(res.body.refund, 4500);
  assert.equal(res.body.depositHeld, 9000);
  // …and the closing bill targets the refund contract's room.
  assert.equal(captured.billInsert.params[2], '202',
    'closing bill must bill the room the tenant actually occupied');
});
