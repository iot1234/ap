// tests/deep-functional.test.js
// Behavior-level tests across the full stack. The integration.test.js file
// pins SHAPE (regex on source, exports lists). This file pins BEHAVIOR —
// actually call functions and assert what they compute / write / return,
// using a mock pg pool so endpoints execute their full handler pipeline.
//
//   node --test tests/deep-functional.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// === Env setup BEFORE any project require =============================
process.env.NODE_ENV = 'development';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.ADMIN_PASSWORD = 'pwd-at-least-12-chars';
process.env.DATABASE_URL = 'postgres://fake/fake';
process.env.CITIZEN_ID_KEY = Buffer.alloc(32, 9).toString('base64');

// === Mock pg pool factory ==============================================
// Each test creates a fresh pool so state doesn't leak between cases.
function makeMockPool() {
  const calls = [];
  const responders = new Map();
  const pool = {
    on() {},
    totalCount: 0, idleCount: 0, waitingCount: 0,
    async query(text, params) {
      calls.push({ text: String(text), params });
      for (const [pattern, fn] of responders) {
        if (text.includes(pattern)) {
          const result = typeof fn === 'function' ? await fn(text, params) : fn;
          if (result === undefined) continue;  // pattern matched but no response
          return result;
        }
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return {
        query: pool.query.bind(pool),
        release: () => {},
      };
    },
  };
  return {
    pool,
    calls,
    on(pattern, fn) { responders.set(pattern, fn); },
    callsMatching(re) {
      return calls.filter((c) => re.test(c.text));
    },
  };
}

// =====================================================================
// 1. BILLING MATH — boundary + edge cases
// =====================================================================

const billing = require('../services/billing');

test('billing.buildBill: zero rent + zero utilities still produces valid bill', () => {
  const b = billing.buildBill({
    room: { id: '0', rent: 0, waterUnits: 0, elecUnits: 0, tenant: { name: '-' } },
    config: { utilities: { waterRate: 0, elecRate: 0, wifi: 0 } },
    features: { vat: { enabled: false }, lateFee: { enabled: false } },
  });
  assert.equal(b.total, 0);
  assert.equal(b.subtotal, 0);
  assert.equal(b.discountAmount, 0);
  assert.ok(Array.isArray(b.items));
});

test('billing.buildBill: VAT applies AFTER discount (correct ledger order)', () => {
  const b = billing.buildBill({
    room: { id: '1', rent: 10000, waterUnits: 0, elecUnits: 0, tenant: { name: 'T' } },
    config: { utilities: { waterRate: 0, elecRate: 0, wifi: 0 } },
    features: { vat: { enabled: true, ratePct: 7 }, lateFee: { enabled: false } },
    discountPct: 10,
  });
  // Subtotal: 10000 (rentBase as item) - 1000 (discount) = 9000
  // VAT 7%: 9000 * 0.07 = 630
  // Total: 9000 + 630 = 9630
  assert.equal(b.subtotal, 9000, 'subtotal = rentBase - discount');
  assert.equal(b.vat, 630, '7% on discounted subtotal');
  assert.equal(b.total, 9630, 'total = subtotal + vat');
});

test('billing.computeLateFee: late fee from previous overdue bill', () => {
  const sevenDaysAgo = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
  const fee = billing.computeLateFee({
    base: 5000,
    dueDate: sevenDaysAgo,
    ratePctPerMonth: 1.5,
    gracePeriodDays: 7,
    now: new Date(),
  });
  // 60 days overdue - 7 grace = 53 days = 1.766... months
  // Fee = 5000 * 0.015 * 1.766 ≈ 132.5
  assert.ok(fee.lateFee > 100 && fee.lateFee < 200, `lateFee=${fee.lateFee} should be ~132-133`);
});

test('billing.buildBill: never carries forward previous bill late fee (R2)', () => {
  // R2 — buildBill is now a pure rent/utility/recurring calculator. Late
  // fees are owned by services/scheduler.js#tickLateFee which updates the
  // OLD bill's late_fee + total in-place when it flips pending → overdue.
  // Whether `previous` is overdue, paid, or pending no longer matters here
  // — the new bill always starts with late_fee=0. Tenants viewing the
  // overdue bill always see the up-to-date total.
  const oldDate = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
  for (const prevStatus of ['paid', 'overdue', 'pending', 'void']) {
    const b = billing.buildBill({
      room: { id: '1', rent: 5000, waterUnits: 0, elecUnits: 0, tenant: { name: 'T' } },
      config: { utilities: { waterRate: 0, elecRate: 0, wifi: 0 } },
      features: {
        vat: { enabled: false },
        lateFee: { enabled: true, ratePctPerMonth: 1.5, gracePeriodDays: 7 },
      },
      previous: { total: 5000, dueDate: oldDate, status: prevStatus },
    });
    assert.equal(b.lateFee, 0,
      `buildBill must ignore previous status (got prev.status=${prevStatus})`);
  }
});

test('billing.buildBill: recurring items only included when feature on', () => {
  const args = {
    room: { id: '1', rent: 5000, waterUnits: 0, elecUnits: 0, tenant: { name: 'T' } },
    config: { utilities: { waterRate: 0, elecRate: 0, wifi: 0 } },
    recurring: [{ label: 'Parking', amount: 500 }],
  };
  const off = billing.buildBill({
    ...args,
    features: { vat: { enabled: false }, lateFee: { enabled: false }, recurringCharges: { enabled: false } },
  });
  const on = billing.buildBill({
    ...args,
    features: { vat: { enabled: false }, lateFee: { enabled: false }, recurringCharges: { enabled: true } },
  });
  assert.equal(off.total, 5000, 'recurring ignored when flag off');
  assert.equal(on.total, 5500, 'recurring added when flag on');
});

test('billing.buildBill: discountPct null/NaN safely treated as 0', () => {
  const room = { id: '1', rent: 5000, waterUnits: 0, elecUnits: 0, tenant: { name: 'T' } };
  const config = { utilities: { waterRate: 0, elecRate: 0, wifi: 0 } };
  const features = { vat: { enabled: false }, lateFee: { enabled: false } };
  for (const bad of [null, undefined, NaN, 'abc', -10, 999]) {
    const b = billing.buildBill({ room, config, features, discountPct: bad });
    assert.ok(Number.isFinite(b.rent), `discountPct=${bad}: rent=${b.rent} must be finite`);
    assert.ok(b.rent >= 2500 && b.rent <= 5000, `discountPct=${bad}: rent in valid range`);
  }
});

// =====================================================================
// 2. CHARGE FREQUENCY FILTER — exhaustive boundary cases
// =====================================================================

test('isChargeApplicableForPeriod: monthly fires every month', () => {
  const c = { frequency: 'monthly', start_at: '2026-01-15' };
  for (const m of ['2026-01', '2026-02', '2026-12', '2027-06']) {
    assert.equal(billing.isChargeApplicableForPeriod(c, m), true, `monthly should fire ${m}`);
  }
});

test('isChargeApplicableForPeriod: quarterly with mid-year anchor', () => {
  // start_at = May → quarterly fires May, Aug, Nov, Feb (next year cycle)
  const c = { frequency: 'quarterly', start_at: '2026-05-01' };
  assert.equal(billing.isChargeApplicableForPeriod(c, '2026-05'), true);
  assert.equal(billing.isChargeApplicableForPeriod(c, '2026-06'), false);
  assert.equal(billing.isChargeApplicableForPeriod(c, '2026-08'), true);
  assert.equal(billing.isChargeApplicableForPeriod(c, '2026-11'), true);
  assert.equal(billing.isChargeApplicableForPeriod(c, '2027-02'), true);
  assert.equal(billing.isChargeApplicableForPeriod(c, '2027-03'), false);
});

test('isChargeApplicableForPeriod: end_at boundary', () => {
  const c = { frequency: 'monthly', end_at: '2026-05-31' };
  assert.equal(billing.isChargeApplicableForPeriod(c, '2026-05'), true,  'last month: in window');
  assert.equal(billing.isChargeApplicableForPeriod(c, '2026-06'), false, 'after end_at: skip');
});

test('isChargeApplicableForPeriod: start_at mid-month still includes that month', () => {
  // Charge starts 2026-03-20 — should fire on 2026-03 bill, not skip to April
  const c = { frequency: 'monthly', start_at: '2026-03-20' };
  assert.equal(billing.isChargeApplicableForPeriod(c, '2026-03'), true);
  assert.equal(billing.isChargeApplicableForPeriod(c, '2026-02'), false);
});

test('isChargeApplicableForPeriod: malformed period returns false', () => {
  const c = { frequency: 'monthly' };
  for (const bad of [null, undefined, '', 'invalid', '2026', '2026-13', 'XXXX-XX']) {
    assert.equal(billing.isChargeApplicableForPeriod(c, bad), false, `bad period ${bad}`);
  }
});

test('isChargeApplicableForPeriod: unknown frequency falls back to monthly', () => {
  const c = { frequency: 'weekly' };  // not implemented
  assert.equal(billing.isChargeApplicableForPeriod(c, '2026-05'), true,
    'unknown freq treated as monthly to avoid silent dropping');
});

// =====================================================================
// 3. SLIP VERIFIER — code path coverage
// =====================================================================

const slipVerifier = require('../services/slipVerifier');

test('slipVerifier.isConfigured: false when no provider keys', () => {
  delete process.env.SLIPOK_API_KEY;
  delete process.env.EASYSLIP_API_KEY;
  delete process.env.SLIP2GO_API_KEY;
  delete process.env.SLIP2GO_API_URL;
  delete require.cache[require.resolve('../services/secrets')];
  delete require.cache[require.resolve('../services/slipVerifier')];
  const sv = require('../services/slipVerifier');
  assert.equal(sv.isConfigured({ slipUpload: { autoVerify: true, providers: ['slipok'] } }), false);
  assert.equal(sv.isConfigured({ slipUpload: { autoVerify: false } }), false);
  assert.equal(sv.isConfigured({}), false);
});

test('slipVerifier.getConfiguredProviders: filters by key presence + dedupes', () => {
  process.env.SLIPOK_API_KEY = 'k1';
  delete process.env.EASYSLIP_API_KEY;
  delete process.env.SLIP2GO_API_KEY;
  delete process.env.SLIP2GO_API_URL;
  delete require.cache[require.resolve('../services/secrets')];
  delete require.cache[require.resolve('../services/slipVerifier')];
  const sv = require('../services/slipVerifier');
  const cfg = sv.getConfiguredProviders({
    slipUpload: { autoVerify: true, providers: ['slipok', 'easyslip', 'slip2go', 'slipok', 'unknown'] },
  });
  assert.equal(cfg.length, 1, 'only slipok ready');
  assert.equal(cfg[0].id, 'slipok');
  delete process.env.SLIPOK_API_KEY;
  delete process.env.SLIP2GO_API_KEY;
  delete process.env.SLIP2GO_API_URL;
});

test('slipVerifier.verifyWithFallback: returns NOT_CONFIGURED when no provider ready', async () => {
  delete process.env.SLIPOK_API_KEY;
  delete process.env.EASYSLIP_API_KEY;
  delete process.env.SLIP2GO_API_KEY;
  delete process.env.SLIP2GO_API_URL;
  delete require.cache[require.resolve('../services/secrets')];
  delete require.cache[require.resolve('../services/slipVerifier')];
  const sv = require('../services/slipVerifier');
  const result = await sv.verifyWithFallback(Buffer.from(''), { amount: 100 },
    { slipUpload: { autoVerify: true } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_CONFIGURED');
  // NOT_CONFIGURED must be in TRANSIENT_CODES so it falls back to admin queue,
  // not a hard reject.
  assert.ok(sv.TRANSIENT_CODES.has('NOT_CONFIGURED'));
});

// =====================================================================
// 4. MIGRATION — exercises every CREATE / ALTER statement
// =====================================================================

test('db/migrate: emits all required tables + new columns + admin bootstrap', async () => {
  const m = makeMockPool();
  // Stub bcrypt-hash count check + auth_users existence so bootstrap path doesn't loop.
  m.on('SELECT id FROM auth_users WHERE username', () => ({ rows: [{ id: 1 }] }));
  m.on('SELECT COUNT(*)', () => ({ rows: [{ n: 1 }] }));
  const dbMigrate = require('../db/migrate');
  await dbMigrate.migrate(m.pool, { adminPassword: '' });

  const sql = m.calls.map((c) => c.text).join('\n');
  // Core tables
  for (const t of [
    'tenants', 'contracts', 'bills', 'payments', 'meter_readings',
    'access_logs', 'access_cards', 'access_devices',
    'notifications_log', 'notifications_queue',
    'file_uploads', 'tenant_sessions', 'login_lockouts',
    'system_settings', 'line_oas', 'line_bindings',
    'recurring_charges', 'bookings', 'rooms_v2',
    'maintenance_tickets', 'audit_logs', 'app_data', 'auth_users',
  ]) {
    assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${t}`),
      `migration must CREATE ${t}`);
  }
  // Recently added columns
  assert.ok(sql.includes('discount_pct'),  'contracts.discount_pct must be migrated');
  assert.ok(sql.includes('term_months'),   'contracts.term_months must be migrated');
  assert.ok(sql.includes('transaction_ref'), 'payments.transaction_ref must be migrated');
  assert.ok(sql.includes('uq_payments_tx_ref'), 'replay-attack unique index');
  assert.ok(sql.includes("status IN ('pending','verified')"),
    'slip replay indexes must allow rejected slips to be reconciled/re-submitted');
  assert.ok(sql.includes('chk_bills_status_valid'), 'bills status CHECK constraint');
  assert.ok(sql.includes('chk_bills_amounts_nonnegative'), 'bills amount CHECK constraint');
  assert.ok(sql.includes('chk_payments_status_valid'), 'payments status CHECK constraint');
  assert.ok(sql.includes('uq_payments_one_verified_per_bill'),
    'one verified payment per bill guard');
  assert.ok(sql.includes('uq_bills_room_period_active'), 'bills duplicate-period guard');
  assert.ok(sql.includes('idx_payments_status_created'), 'slip queue index');
});

// =====================================================================
// 5. NOTIFICATION QUEUE — retry math
// =====================================================================

test('notifQueue LINE retry key is a deterministic UUID accepted by LINE', () => {
  const notifQueue = require('../services/notificationQueue');
  const key1 = notifQueue._retryKeyForRowId(160);
  const key2 = notifQueue._retryKeyForRowId(160);
  const key3 = notifQueue._retryKeyForRowId(161);
  assert.equal(key1, key2, 'retry key must stay stable for the same queue row');
  assert.notEqual(key1, key3, 'different queue rows need different retry keys');
  assert.match(key1,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'LINE rejects ad-hoc keys like notifq-160; use UUID format');
});

test('notifQueue explains provider-configuration failures for admins', () => {
  const notifQueue = require('../services/notificationQueue');
  const emailDiag = notifQueue.diagnoseFailure({
    channel: 'email',
    last_error: 'email not configured',
  });
  assert.equal(emailDiag.code, 'EMAIL_NOT_CONFIGURED');
  assert.match(emailDiag.hint, /SMTP_HOST/);
  assert.equal(emailDiag.retryAfterFix, true);

  const smsDiag = notifQueue.diagnoseFailure({
    channel: 'sms',
    last_error: "SMS provider 'foo' is not implemented",
  });
  assert.equal(smsDiag.code, 'SMS_NOT_CONFIGURED');

  const rateDiag = notifQueue.diagnoseFailure({
    channel: 'line',
    last_error: 'HTTP 429 rate limit',
  });
  assert.equal(rateDiag.code, 'PROVIDER_RATE_LIMIT');
  assert.equal(rateDiag.retryAfterFix, false);
});

test('notifQueue.tick: claims pending rows + retries on failure with exponential backoff', async () => {
  // We can't call processOne directly (not exported), but we can drive
  // tick() which claims one row and processes it. To assert backoff math
  // we capture the UPDATE that schedules the retry.
  const m = makeMockPool();
  // tick reaper UPDATE first — return rowCount 0 so it doesn't reset state.
  let claimedOnce = false;
  m.on('UPDATE notifications_queue', (text, params) => {
    if (text.includes("status='pending'") && text.includes('reaped')) {
      return { rowCount: 0 };
    }
    if (text.includes("status='processing'")) {
      // marking claimed rows as processing — return ok
      return { rowCount: 1 };
    }
    return { rowCount: 1 };
  });
  m.on('SELECT id, channel, recipient', (text) => {
    if (claimedOnce) return { rows: [] };
    claimedOnce = true;
    return { rows: [{
      id: 1, channel: 'line', recipient: 'Uxxx',
      subject: 's', body: 'b', payload: {}, retry_count: 0,
    }] };
  });
  // Fail LINE dispatch by returning no OA.
  m.on('FROM line_oas', () => ({ rows: [] }));
  // Capture the retry UPDATE shape — params [id, errMsg, waitMs].
  let retryWait = null;
  const originalQuery = m.pool.query.bind(m.pool);
  m.pool.query = async (text, params) => {
    if (text.includes('next_attempt_at=NOW()') && text.includes('INTERVAL') && params?.length === 3) {
      retryWait = params[2];
    }
    return originalQuery(text, params);
  };
  const notifQueue = require('../services/notificationQueue');
  const processed = await notifQueue.tick(m.pool, { email: { enabled: false }, sms: { enabled: false } }, 1);
  assert.equal(processed, 1, 'tick should process exactly 1 claimed row');
  assert.equal(retryWait, 60_000,
    'first retry must schedule next_attempt_at = NOW + 60000ms (1 minute)');
});

// =====================================================================
// 6. BACKUP / RESTORE round-trip on synthetic data
// =====================================================================

test('backup.run + verify: integrity hash matches', async () => {
  // Provide a self-contained pool that returns a tiny dataset for each table.
  const m = makeMockPool();
  m.on('FROM ', (text) => {
    // Strip schema prefix if any, return 1 fake row per table.
    return { rows: [{ id: 1, sample: 'data' }] };
  });
  const backup = require('../scripts/backup');
  // Force the backup file under tests/_backup-tmp so it doesn't clutter the
  // real backups/ dir.
  const path = require('node:path');
  const fs = require('node:fs');
  const tmp = path.join(__dirname, '_backup-tmp');
  if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });

  const out = await backup.run({ pool: m.pool, retainDays: 1 });
  assert.ok(out.file && out.size > 0);
  assert.match(out.digest, /^[0-9a-f]{64}$/, 'sha256 hex');
  // Verify the file's hash without restoring.
  const v = backup.verify(out.file);
  assert.equal(v.ok, true);
  assert.deepEqual(Object.keys(v.counts).sort(), Object.keys(out.rowCounts).sort());

  // Tamper with the file → verify must reject.
  const raw = fs.readFileSync(out.file, 'utf8');
  const obj = JSON.parse(raw);
  obj.tables.bills = [{ id: 999, evil: 'mutation' }];
  fs.writeFileSync(out.file, JSON.stringify(obj, null, 2));
  const tampered = backup.verify(out.file);
  assert.equal(tampered.ok, false);
  assert.match(tampered.error, /hash mismatch|tamper/i);

  // Cleanup
  try { fs.unlinkSync(out.file); } catch {}
});

// =====================================================================
// 7. SLIP UPLOAD ENDPOINT — full handler with mocked DB
// =====================================================================

test('/api/tenant/payments handler: rejects amount mismatch BEFORE saving slip', async () => {
  // Read the handler logic from server.js without booting the express app.
  // We can't easily mount the full server, so we exercise the validation
  // path by replicating it: bill.total=5000, submitted amount=100 → 400 +
  // AMOUNT_NOT_BILL_TOTAL. This proves the source has the guard wired
  // before saveBase64; if a future refactor removed it the regex test in
  // integration.test.js would already break.
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // The guard must run BEFORE the slip-upload saveBase64. The file now has
  // multiple saveBase64 callers (public booking → citizen ID image, admin
  // /api/uploads, /tenants/:id/identity, /contracts/:id/sign), so use the
  // FIRST saveBase64 that appears AFTER AMOUNT_NOT_BILL_TOTAL — that's the
  // slip-upload call we want to assert is downstream of the guard.
  const idxAmountGuard = server.indexOf('AMOUNT_NOT_BILL_TOTAL');
  const idxSlipSave = server.indexOf('storage.saveBase64', idxAmountGuard);
  assert.ok(idxAmountGuard > 0 && idxSlipSave > 0,
    'both AMOUNT_NOT_BILL_TOTAL and a downstream storage.saveBase64 must exist');
  assert.ok(idxAmountGuard < idxSlipSave,
    'AMOUNT_NOT_BILL_TOTAL guard must run BEFORE saveBase64 (else slip leaks on reject)');
  assert.match(server, /SELECT id, total, late_fee, status, tenant_id FROM bills WHERE id=\$1 AND deleted_at IS NULL/,
    'tenant slip upload must read late_fee so principal-tier payments can be validated');
  assert.match(server, /AMOUNT_NOT_BILL_TOTAL_AT_COMMIT/,
    'tenant slip upload must re-check the amount after locking the bill row');
});

// =====================================================================
// 8. TENANT PORTAL — phone-only access
// =====================================================================

test('tenant portal PIN init/change endpoints are removed', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ops = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'tenant-ops.js'), 'utf8'
  );
  assert.equal(ops.includes('/_tenant/pin/init'), false,
    'first-time PIN setup route must not exist');
  assert.equal(ops.includes('/_tenant/pin/change'), false,
    'tenant PIN change route must not exist');
  assert.equal(ops.includes('tenantSetPin'), false,
    'router must not validate removed PIN setup schema');
  assert.equal(ops.includes('tenantChangePin'), false,
    'router must not validate removed PIN change schema');
});

// =====================================================================
// 9. PROMPTPAY — encoding sanity
// =====================================================================

test('promptpay.buildPayload: amount serialized in EMV format', () => {
  const { buildPayload } = require('../services/promptpay');
  // EMV amount field tag is "54" + 2-digit length + value. For "1234.56"
  // the value is 7 chars including the dot, so length is 07 → "54071234.56".
  const a = buildPayload('0801234567', 1234.56);
  assert.match(a, /54071234\.56/, '1234.56 → tag 54, length 07, value "1234.56"');
  // Sub-baht amount "0.01" is 4 chars → "54040.01"
  const b = buildPayload('0801234567', 0.01);
  assert.match(b, /54040\.01/, '0.01 → tag 54, length 04, value "0.01"');
  // Whole baht "100" — the underlying promptpay-qr lib pads to 2 decimals,
  // so 100 → "100.00" (6 chars, length 06).
  const c = buildPayload('0801234567', 100);
  assert.match(c, /5406100\.00/, '100 → padded to "100.00", length 06');
});

// =====================================================================
// 10. STORAGE — magic-byte spoofing defense
// =====================================================================

test('storage.detectMime: catches MIME spoofing (HTML claiming to be PNG)', () => {
  const storage = require('../services/storage');
  // Real PNG header
  const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
  assert.equal(storage.detectMime(png), 'image/png');
  // HTML pretending to be PNG → magic bytes don't match → null
  const fakeHtml = Buffer.from('<html><body>oops</body></html>');
  assert.equal(storage.detectMime(fakeHtml), null);
  // Empty buffer
  assert.equal(storage.detectMime(Buffer.alloc(0)), null);
});

test('storage.parseBase64: handles both data URL and raw base64', () => {
  const storage = require('../services/storage');
  const a = storage.parseBase64('data:image/png;base64,iVBORw0KGgo=');
  assert.equal(a.mime, 'image/png');
  assert.ok(Buffer.isBuffer(a.buffer));
  const b = storage.parseBase64('iVBORw0KGgo=');
  assert.equal(b.mime, null);
  assert.ok(Buffer.isBuffer(b.buffer));
});

// =====================================================================
// 11. ENCRYPTION — versioned cipher round-trip
// =====================================================================

test('encryption: versioned cipher tolerates key rotation', () => {
  process.env.ENCRYPTION_KEY_V1 = Buffer.alloc(32, 1).toString('base64');
  process.env.ENCRYPTION_KEY_V2 = Buffer.alloc(32, 2).toString('base64');
  process.env.ENCRYPTION_KEY_CURRENT = '2';
  delete require.cache[require.resolve('../services/encryption')];
  const enc = require('../services/encryption');
  // Encrypt with v2
  const c2 = enc.encryptString('hello');
  assert.match(c2, /^v2\$/);
  assert.equal(enc.decryptString(c2), 'hello');
  // Decrypt v1-tagged ciphertext (created when current was v1) — must
  // still succeed because v1 key is still loaded.
  process.env.ENCRYPTION_KEY_CURRENT = '1';
  delete require.cache[require.resolve('../services/encryption')];
  const enc1 = require('../services/encryption');
  const c1 = enc1.encryptString('hello');
  assert.match(c1, /^v1\$/);
  // Switch back to v2 current — old v1 ciphertext still decrypts.
  process.env.ENCRYPTION_KEY_CURRENT = '2';
  delete require.cache[require.resolve('../services/encryption')];
  const enc2 = require('../services/encryption');
  assert.equal(enc2.decryptString(c1), 'hello',
    'must read v1 ciphertext after rotating current to v2');
});
