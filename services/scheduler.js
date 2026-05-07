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
const STATE_FILE = path.join(__dirname, '..', '.scheduler-state.json');

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}
function writeState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); }
  catch (err) { console.error('[scheduler] state write failed:', err.message); }
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
      const bill = billing.buildBill({ room, config, features: flags, period, dueDate });
      try {
        await pool.query(
          `INSERT INTO bills (bill_no, room_id, period, rent, water_units, water_rate, water_amount,
              elec_units, elec_rate, elec_amount, wifi, subtotal, vat, late_fee, total, due_date, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending')
           ON CONFLICT (bill_no) DO NOTHING`,
          [
            bill.billNo, bill.roomId, bill.period,
            bill.rent, bill.waterUnits, bill.waterRate, bill.waterAmount,
            bill.elecUnits, bill.elecRate, bill.elecAmount,
            bill.wifi, bill.subtotal, bill.vat, bill.lateFee, bill.total,
            bill.dueDate,
          ]
        );
        made++;
      } catch (e) { console.error('[scheduler] bill insert failed:', e.message); }
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
  // > 30 days past due. Reason field tags it so admin can reverse easily.
  const REVOKE_REASON = 'auto:overdue_bill';
  try {
    // Find tenants with overdue bills > 30 days
    const overdue = await pool.query(`
      SELECT DISTINCT tenant_id FROM bills
        WHERE status='overdue'
          AND tenant_id IS NOT NULL
          AND deleted_at IS NULL
          AND due_date < CURRENT_DATE - INTERVAL '30 days'
          AND paid_at IS NULL
    `);
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
    // overdue bill > 30d. Only undo our own auto-revokes (manual revokes
    // stay revoked — admin made that call deliberately).
    const restore = await pool.query(`
      UPDATE access_cards SET status='active', revoked_at=NULL, revoke_reason=NULL
        WHERE status='revoked' AND revoke_reason=$1
          AND tenant_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM bills b
              WHERE b.tenant_id = access_cards.tenant_id
                AND b.status='overdue'
                AND b.due_date < CURRENT_DATE - INTERVAL '30 days'
                AND b.paid_at IS NULL
                AND b.deleted_at IS NULL
          )
    `, [REVOKE_REASON]);
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
  await tickLateFee(pool, flags, now, state);
  await tickAutoBackup(pool, flags, now, state);
  await tickBillGen(pool, flags, now, state);
  await tickMeterSimulator(pool, flags, now, state);
  await tickAccessControlSync(pool, flags, now, state);
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
