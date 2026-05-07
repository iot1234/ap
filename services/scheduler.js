// services/scheduler.js
// Lightweight in-process cron-style scheduler. We deliberately avoid the
// `cron` package because the few jobs we have only need to fire once per
// hour or once per day; setInterval + a "fired today" guard is enough.
//
// Jobs:
//   1. autoBackup        — once per day at features.autoBackup.hourUtc
//   2. billAutoGenerate  — on features.billAutoGenerate.dayOfMonth, generate
//                          bills for every occupied room that doesn't yet
//                          have one for the current period
//   3. lateFeeRefresh    — daily; mark pending bills past due as overdue
//
// Each job is feature-flag gated (no flag → no fire). Errors are caught and
// logged so a failed tick never crashes the process.

const fs = require('fs');
const path = require('path');
const features = require('./features');
const billing = require('./billing');
const notifier = require('./notifier');
const meter = require('./meter');

const TICK_MS = 60 * 60 * 1000;          // hourly

// Pick a writable location for the state file. Containers commonly run as
// non-root with /app owned-but-not-writable for new files; SCHEDULER_STATE_FILE
// env (or a Railway volume) wins, then the app dir, then /tmp as a last
// resort. State is just last-fired-keys — losing it means today's tasks may
// fire twice; not worth crashing the container.
const _candidateStatePaths = [
  process.env.SCHEDULER_STATE_FILE,
  process.env.UPLOAD_DIR && path.join(process.env.UPLOAD_DIR, 'scheduler-state.json'),
  path.join(__dirname, '..', '.scheduler-state.json'),
  path.join(require('os').tmpdir(), 'baankarn-scheduler-state.json'),
].filter(Boolean);

function _pickStateFile() {
  for (const p of _candidateStatePaths) {
    try {
      // Test writability by opening for append (creates if missing)
      const fd = fs.openSync(p, 'a');
      fs.closeSync(fd);
      return p;
    } catch { /* not writable, try next */ }
  }
  return null;
}
let STATE_FILE = _pickStateFile();
if (STATE_FILE && STATE_FILE !== _candidateStatePaths[0]) {
  console.log('[scheduler] state file:', STATE_FILE);
}

function readState() {
  if (!STATE_FILE) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}
function writeState(s) {
  if (!STATE_FILE) return;
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); }
  catch (err) {
    // First write that lands here means our pick became unwritable
    // (e.g. permissions changed). Try to relocate ONCE so we don't spam logs.
    if (err.code === 'EACCES' || err.code === 'EROFS') {
      const fallback = path.join(require('os').tmpdir(), 'baankarn-scheduler-state.json');
      if (STATE_FILE !== fallback) {
        console.warn('[scheduler] relocating state file to', fallback, '(reason:', err.code + ')');
        STATE_FILE = fallback;
        try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); return; }
        catch (e2) { console.error('[scheduler] tmp fallback also failed:', e2.message); }
      }
    }
    console.error('[scheduler] state write failed:', err.message);
  }
}

async function tickAutoBackup(pool, flags, now, state) {
  if (!flags.autoBackup || !flags.autoBackup.enabled) return;
  const todayKey = now.toISOString().slice(0, 10);
  if (state.lastBackup === todayKey) return;
  if (now.getUTCHours() !== Number(flags.autoBackup.hourUtc || 19)) return;
  try {
    // Lazy-require the backup script as a module
    // eslint-disable-next-line global-require
    const backup = require('../scripts/backup');
    if (typeof backup.run === 'function') {
      await backup.run({ pool, retainDays: flags.autoBackup.retainDays });
    } else {
      // Fallback: spawn the script
      // eslint-disable-next-line global-require
      const { fork } = require('child_process');
      fork(path.join(__dirname, '..', 'scripts', 'backup.js'), [], { detached: true, stdio: 'ignore' }).unref();
    }
    state.lastBackup = todayKey;
    writeState(state);
    console.log('[scheduler] backup fired for', todayKey);
  } catch (err) {
    console.error('[scheduler] backup failed:', err.message);
  }
}

async function tickLateFee(pool, flags, now, state) {
  const todayKey = now.toISOString().slice(0, 10);
  if (state.lastLateFeeMark === todayKey) return;
  try {
    const { rowCount } = await pool.query(
      `UPDATE bills SET status='overdue'
         WHERE status='pending' AND due_date < CURRENT_DATE`
    );
    if (rowCount) console.log(`[scheduler] marked ${rowCount} bills overdue`);
    state.lastLateFeeMark = todayKey;
    writeState(state);
  } catch (err) {
    console.error('[scheduler] late-fee mark failed:', err.message);
  }
}

async function tickBillGen(pool, flags, now, state) {
  if (!flags.billAutoGenerate || !flags.billAutoGenerate.enabled) return;
  const dom = Number(flags.billAutoGenerate.dayOfMonth || 1);
  if (now.getDate() !== dom) return;
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  if (state.lastBillPeriod === period) return;
  try {
    const [roomsRow, configRow] = await Promise.all([
      pool.query(`SELECT value FROM app_data WHERE key='baankarn_rooms_v1'`),
      pool.query(`SELECT value FROM app_data WHERE key='baankarn_config_v1'`),
    ]);
    const rooms = Object.values(roomsRow.rows.length ? roomsRow.rows[0].value : {});
    const config = configRow.rows.length ? configRow.rows[0].value : {};
    const dueDay = Number(flags.billAutoGenerate.dueDay || 15);
    const dueDate = new Date(now.getFullYear(), now.getMonth(), dueDay).toISOString().slice(0, 10);
    let made = 0;
    for (const room of rooms) {
      if (!room.tenant || (room.status !== 'occupied' && room.status !== 'overdue')) continue;
      // Resolve the active tenant for this room so generated bills appear
      // in the tenant portal (without tenant_id, /api/tenant/bills can't
      // see them and the LINE bill push has no recipient).
      let tenantId = null;
      try {
        const tq = await pool.query(
          `SELECT id FROM tenants
              WHERE current_room_id=$1 AND status='active' AND deleted_at IS NULL
              ORDER BY updated_at DESC LIMIT 1`,
          [room.id]
        );
        if (tq.rows.length) tenantId = tq.rows[0].id;
      } catch { /* fail-soft */ }

      // Pull active recurring charges (parking/internet/etc.) so the
      // scheduler-generated bill matches what the manual /api/bills POST
      // would produce. Without this, scheduler bills silently miss line
      // items that the admin UI shows when generating manually.
      let recurring = [];
      if (flags.recurringCharges?.enabled) {
        try {
          const params = [];
          const ors = [];
          if (tenantId) { params.push(tenantId); ors.push(`tenant_id = $${params.length}`); }
          params.push(room.id); ors.push(`room_id = $${params.length}`);
          const rc = await pool.query(
            `SELECT label, amount FROM recurring_charges
               WHERE active = TRUE AND (${ors.join(' OR ')})
                 AND (start_at IS NULL OR start_at <= CURRENT_DATE)
                 AND (end_at IS NULL OR end_at >= CURRENT_DATE)`,
            params
          );
          recurring = rc.rows.map((r) => ({ label: r.label, amount: Number(r.amount) }));
        } catch { /* table may not exist on older deployments */ }
      }

      // Pull previous overdue bill for late-fee carry-over (matches the
      // manual generate path so totals are identical between both routes).
      let previous = null;
      try {
        const prev = await pool.query(
          `SELECT total, due_date, paid_at, status FROM bills
             WHERE room_id=$1 AND status IN ('pending','overdue') AND deleted_at IS NULL
             ORDER BY created_at DESC LIMIT 1`,
          [room.id]
        );
        if (prev.rows[0]) {
          previous = {
            total: Number(prev.rows[0].total),
            dueDate: prev.rows[0].due_date,
            status: prev.rows[0].status,
          };
        }
      } catch { /* ignore */ }

      const bill = billing.buildBill({ room, config, features: flags, previous, recurring, period, dueDate });
      try {
        await pool.query(
          `INSERT INTO bills (bill_no, tenant_id, room_id, period, rent,
              water_units, water_rate, water_amount,
              elec_units, elec_rate, elec_amount, wifi, subtotal, vat, late_fee, total, due_date, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'pending')
           ON CONFLICT (bill_no) DO NOTHING`,
          [
            bill.billNo, tenantId, bill.roomId, bill.period,
            bill.rent, bill.waterUnits, bill.waterRate, bill.waterAmount,
            bill.elecUnits, bill.elecRate, bill.elecAmount,
            bill.wifi, bill.subtotal, bill.vat, bill.lateFee, bill.total,
            bill.dueDate,
          ]
        );
        made++;
      } catch (e) {
        // Partial-unique on (room_id, period) blocks duplicates even when
        // bill_no differs across paths; treat as silent skip.
        if (e.code !== '23505') console.error('[scheduler] bill insert failed:', e.message);
      }
    }
    state.lastBillPeriod = period;
    writeState(state);
    console.log(`[scheduler] auto-generated ${made} bills for ${period}`);
    if (made > 0) {
      notifier.notifyOwner({ pool, features: flags },
        { subject: 'ออกบิลอัตโนมัติ', text: `ออกบิลรอบ ${period} จำนวน ${made} ใบ` }
      ).catch(() => {});
    }
  } catch (err) {
    console.error('[scheduler] bill gen failed:', err.message);
  }
}

// C2 — meter simulator: when meterIot.mode === 'simulator', generate one
// fake water + one fake elec reading per active room each tick (capped to
// once per hour so we don't flood the table). Real-world dorms see ~1
// reading/day per meter; simulator runs hourly so demos look lively.
async function tickMeterSimulator(pool, flags, now, state) {
  if (!flags.meterIot || !flags.meterIot.enabled) return;
  if (flags.meterIot.mode !== 'simulator') return;
  const hourKey = `${now.toISOString().slice(0, 13)}`;  // YYYY-MM-DDTHH
  if (state.lastSimHour === hourKey) return;
  try {
    const { rows: roomsRow } = await pool.query(
      `SELECT value FROM app_data WHERE key='baankarn_rooms_v1'`
    );
    const roomsObj = roomsRow.length ? roomsRow[0].value : {};
    let made = 0;
    for (const [id, room] of Object.entries(roomsObj || {})) {
      if (!room || (room.status !== 'occupied' && room.status !== 'overdue')) continue;
      // Add small random delta to whatever the latest reading was. If no
      // prior reading, start at a realistic baseline.
      for (const meterType of ['water', 'elec']) {
        const prev = await meter.latest(pool, id, meterType);
        const baseline = prev ? Number(prev.reading) : (meterType === 'water' ? 100 : 1500);
        const delta = meterType === 'water'
          ? (Math.random() * 0.5 + 0.05)        // 0.05 - 0.55 cubic meters/hour
          : (Math.random() * 1.5 + 0.5);         // 0.5 - 2 kWh/hour
        const reading = Math.round((baseline + delta) * 100) / 100;
        try {
          await meter.record(pool, {
            roomId: id, meterType, reading, source: 'simulator', createdBy: 'scheduler',
          });
          made++;
        } catch (err) {
          console.warn('[scheduler] sim record failed:', err.message);
        }
      }
    }
    state.lastSimHour = hourKey;
    writeState(state);
    if (made) console.log(`[scheduler] simulator generated ${made} readings`);
  } catch (err) {
    console.error('[scheduler] simulator failed:', err.message);
  }
}

// B2 — access control: revoke cards for tenants with overdue bills past
// the configured grace window. Re-activate when their bills clear.
async function tickAccessControlSync(pool, flags, now, state) {
  if (!flags.accessControl || !flags.accessControl.enabled) return;
  if (!flags.accessControl.requirePaymentForCard) return;
  const todayKey = now.toISOString().slice(0, 10);
  if (state.lastAccessSync === todayKey) return;
  // Revoke active cards belonging to tenants whose oldest unpaid bill is
  // older than `accessControl.overdueDaysThreshold` days past due. Bound
  // the threshold to a sane range (1-365) so a misconfigured value can't
  // either revoke same-day or never trigger.
  const REVOKE_REASON = 'auto:overdue_bill';
  const rawThreshold = Number(flags.accessControl?.overdueDaysThreshold);
  const threshold = Number.isFinite(rawThreshold)
    ? Math.max(1, Math.min(365, Math.trunc(rawThreshold)))
    : 30;
  try {
    // Find tenants with overdue bills > threshold days. We pass threshold
    // as a parameter so it can't smuggle SQL even if the feature flag was
    // tampered with.
    const overdue = await pool.query(`
      SELECT DISTINCT tenant_id FROM bills
        WHERE status='overdue'
          AND tenant_id IS NOT NULL
          AND deleted_at IS NULL
          AND due_date < CURRENT_DATE - ($1::int * INTERVAL '1 day')
          AND paid_at IS NULL
    `, [threshold]);
    const overdueIds = overdue.rows.map((r) => Number(r.tenant_id));
    let revoked = 0, restored = 0;
    if (overdueIds.length) {
      const r = await pool.query(
        `UPDATE access_cards
            SET status='revoked', revoked_at=NOW(), revoke_reason=$1
          WHERE status='active' AND tenant_id = ANY($2::bigint[])`,
        [REVOKE_REASON, overdueIds]
      );
      revoked = r.rowCount || 0;
    }
    // Restore previously auto-revoked cards whose tenant no longer has any
    // overdue bill > threshold. Only undo our own auto-revokes (manual
    // revokes stay revoked — admin made that call deliberately).
    const restore = await pool.query(`
      UPDATE access_cards SET status='active', revoked_at=NULL, revoke_reason=NULL
        WHERE status='revoked' AND revoke_reason=$1
          AND tenant_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM bills b
              WHERE b.tenant_id = access_cards.tenant_id
                AND b.status='overdue'
                AND b.due_date < CURRENT_DATE - ($2::int * INTERVAL '1 day')
                AND b.paid_at IS NULL
                AND b.deleted_at IS NULL
          )
    `, [REVOKE_REASON, threshold]);
    restored = restore.rowCount || 0;
    state.lastAccessSync = todayKey;
    writeState(state);
    if (revoked || restored) {
      console.log(`[scheduler] access cards: revoked=${revoked} restored=${restored}`);
    }
  } catch (err) {
    console.error('[scheduler] access sync failed:', err.message);
  }
}

async function tick(pool) {
  let flags;
  try { flags = await features.load(pool); } catch { return; }
  const state = readState();
  const now = new Date();
  // Run jobs in parallel with allSettled so a hung job (e.g. backup waiting
  // on R2) doesn't block the others (late-fee, bill-gen). Each job catches
  // its own errors internally; allSettled here is a safety net for ones we
  // missed. Errors are logged, never propagated to the parent tick caller.
  const results = await Promise.allSettled([
    tickLateFee(pool, flags, now, state),
    tickAutoBackup(pool, flags, now, state),
    tickBillGen(pool, flags, now, state),
    tickMeterSimulator(pool, flags, now, state),
    tickAccessControlSync(pool, flags, now, state),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') {
      console.error('[scheduler] sub-tick failed:', r.reason && r.reason.message || r.reason);
    }
  }
}

let _interval = null;
function start(pool) {
  if (_interval) return;
  // Fire once shortly after boot, then hourly.
  setTimeout(() => tick(pool).catch((e) => console.error('[scheduler] tick:', e.message)), 30_000);
  _interval = setInterval(() => tick(pool).catch((e) => console.error('[scheduler] tick:', e.message)), TICK_MS);
  _interval.unref();
  console.log('[scheduler] started (hourly)');
}
function stop() {
  if (_interval) clearInterval(_interval);
  _interval = null;
}

module.exports = { start, stop, tick };
