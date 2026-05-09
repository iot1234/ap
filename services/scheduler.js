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

    // Match the server-side bulk-generate guard (routes/bills-extras.js):
    // refuse to run automatically when critical config is missing — would
    // produce 12+ broken bills (no QR / 0฿ utilities) and notify tenants
    // about them. Once-per-period log + owner alert so operator can fix
    // the gap without finding out via tenant complaints next month.
    const issues = [];
    const ppTarget = config?.payment?.promptpay
      || config?.payment?.promptpayTarget
      || require('./secrets').get('PROMPTPAY_TARGET');
    if (!ppTarget)                          issues.push('PROMPTPAY_TARGET ไม่ตั้ง');
    const wRate = Number(config?.utilities?.waterRate);
    const eRate = Number(config?.utilities?.elecRate);
    if (!Number.isFinite(wRate) || wRate <= 0) issues.push('waterRate ไม่ตั้ง / ≤ 0');
    if (!Number.isFinite(eRate) || eRate <= 0) issues.push('elecRate ไม่ตั้ง / ≤ 0');
    const eligibleCount = rooms.filter((r) => r && r.tenant
      && (r.status === 'occupied' || r.status === 'overdue')).length;
    if (eligibleCount === 0) issues.push('ไม่มีห้อง occupied/overdue ที่จะออกบิล');

    if (issues.length > 0) {
      // Latch via state so we don't re-alert every hourly tick — only
      // first encounter per period gets the owner notification. Same
      // pattern as `simulatorBlockedLogged`.
      const skipKey = `billGenSkipped_${period}`;
      if (!state[skipKey]) {
        console.warn(`[scheduler] bill auto-gen for ${period} SKIPPED — ${issues.length} config issue(s):`);
        for (const i of issues) console.warn('  • ' + i);
        try {
          await notifier.notifyOwner({ pool, features: flags }, {
            subject: `⚠️ ออกบิลอัตโนมัติรอบ ${period} ถูกข้าม`,
            text: `ระบบไม่สามารถออกบิลอัตโนมัติเพราะตั้งค่ายังไม่ครบ:\n\n` +
                  issues.map((i, n) => `${n + 1}. ${i}`).join('\n') +
                  `\n\nแก้ไขที่ /admin#secrets และ /admin#pricing แล้ว ` +
                  `กดออกบิลด้วยมือที่ /admin#billing (ระบบจะลองอัตโนมัติอีกครั้งรอบหน้า)`,
          });
        } catch { /* ignore */ }
        state[skipKey] = true;
        writeState(state);
      }
      // Record period as "handled" so the daily latch doesn't keep retrying
      // infinitely; admin must redo manually for THIS period.
      state.lastBillPeriod = period;
      writeState(state);
      return;
    }

    const dueDay = Number(flags.billAutoGenerate.dueDay || 15);
    const dueDate = new Date(now.getFullYear(), now.getMonth(), dueDay).toISOString().slice(0, 10);
    let made = 0;
    // Track each successfully-inserted bill so we can fan out tenant
    // notifications AFTER the loop completes (one queue enqueue per bill,
    // not per attempt — failed inserts shouldn't notify anyone).
    const billsCreated = [];
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
      //
      // Track one_off ids so we can deactivate them after a successful insert
      // — manual bill gen at server.js:2287 already does this; scheduler
      // previously didn't, so a one_off charge would re-bill every month
      // forever (real data bug found in May 2026 cross-feature audit).
      let recurring = [];
      let usedOneOffIds = [];
      if (flags.recurringCharges?.enabled) {
        try {
          const params = [];
          const ors = [];
          if (tenantId) { params.push(tenantId); ors.push(`tenant_id = $${params.length}`); }
          params.push(room.id); ors.push(`room_id = $${params.length}`);
          const rc = await pool.query(
            `SELECT id, label, amount, frequency, start_at, end_at FROM recurring_charges
               WHERE active = TRUE AND (${ors.join(' OR ')})
                 AND (start_at IS NULL OR start_at <= CURRENT_DATE)
                 AND (end_at IS NULL OR end_at >= CURRENT_DATE)`,
            params
          );
          // Honor `frequency` (monthly/quarterly/one_off) so quarterly
          // charges only fire every 3 months anchored to start_at. Without
          // this the scheduler kept billing quarterly fees every month.
          const applicable = rc.rows.filter((r) => billing.isChargeApplicableForPeriod(r, period));
          recurring = applicable.map((r) => ({ label: r.label, amount: Number(r.amount) }));
          usedOneOffIds = applicable.filter((r) => r.frequency === 'one_off').map((r) => r.id);
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

      // Pull contract-length discount so scheduler bills match what the
      // manual /api/bills POST + bulk-generate produce. Without this lookup
      // every auto-generated bill billed full rent regardless of the
      // discount the admin recorded at check-in.
      let discountPct = 0;
      try {
        const cq = await pool.query(
          `SELECT discount_pct FROM contracts
             WHERE room_id=$1 AND status='active' AND deleted_at IS NULL
             ORDER BY start_date DESC LIMIT 1`,
          [room.id]
        );
        if (cq.rows[0]) discountPct = Number(cq.rows[0].discount_pct) || 0;
      } catch { /* legacy deploys without contracts table */ }
      const bill = billing.buildBill({ room, config, features: flags, previous, recurring, period, dueDate, discountPct });
      try {
        // `other` JSONB persists the recurring breakdown so the PDF render
        // and tenant portal bill-detail can reproduce the line items. The
        // manual /api/bills POST + bulk-generate paths already write this;
        // the scheduler used to skip it, so auto-generated bills lost their
        // recurring breakdown on read (total stayed correct, but admins
        // couldn't see WHICH charges made up the total).
        const otherJson = JSON.stringify(recurring || []);
        const ins = await pool.query(
          `INSERT INTO bills (bill_no, tenant_id, room_id, period, rent,
              water_units, water_rate, water_amount,
              elec_units, elec_rate, elec_amount, wifi, other, subtotal, vat, late_fee, total, due_date, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,'pending')
           ON CONFLICT (bill_no) DO NOTHING
           RETURNING id`,
          [
            bill.billNo, tenantId, bill.roomId, bill.period,
            bill.rent, bill.waterUnits, bill.waterRate, bill.waterAmount,
            bill.elecUnits, bill.elecRate, bill.elecAmount,
            bill.wifi, otherJson, bill.subtotal, bill.vat, bill.lateFee, bill.total,
            bill.dueDate,
          ]
        );
        // Only count the bill as "made" + deactivate one_off charges if the
        // INSERT actually wrote a row (rowCount > 0). ON CONFLICT DO NOTHING
        // returns 0 rows when the bill_no collided with an existing one —
        // and in that case we DON'T want to mark one_offs inactive (they
        // weren't billed this run).
        if (ins.rowCount > 0) {
          made++;
          billsCreated.push({ id: ins.rows[0].id, tenantId, roomId: bill.roomId, billNo: bill.billNo, period, total: bill.total, dueDate: bill.dueDate });
          if (usedOneOffIds.length) {
            try {
              await pool.query(
                `UPDATE recurring_charges SET active=FALSE, updated_at=NOW()
                   WHERE id = ANY($1::bigint[])`,
                [usedOneOffIds]
              );
            } catch (e) {
              console.warn('[scheduler] one_off deactivate failed for room', room.id, ':', e.message);
            }
          }
        }
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
      // Notify each tenant about their newly-generated bill so they don't
      // miss the due date. Without this, scheduler bills sit silently in
      // the DB until admin runs bulk-send manually — many tenants only
      // discover the bill when they get an overdue alert. Use the queue
      // (notifQueue) so retries on transient LINE/email failures happen
      // automatically.
      try {
        const notifQueue = require('./notificationQueue');
        for (const b of billsCreated) {
          if (!b.tenantId) continue;  // orphan bills: nobody to notify
          const tQ = await pool.query(
            `SELECT line_user_id, line_oa_id, email FROM tenants
               WHERE id=$1 AND deleted_at IS NULL AND status='active'`,
            [b.tenantId]
          );
          if (!tQ.rows.length) continue;
          const t = tQ.rows[0];
          const subject = `💰 บิลใหม่รอบ ${b.period} — ห้อง ${b.roomId}`;
          const body = [
            `บิลใหม่ออกแล้ว`,
            `เลขที่: ${b.billNo}`,
            `ห้อง: ${b.roomId}`,
            `รอบบิล: ${b.period}`,
            `ยอดรวม: ฿${Number(b.total).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`,
            `ครบกำหนด: ${b.dueDate}`,
            ``,
            `ดูรายละเอียด + ชำระผ่าน QR ที่พอร์ทัล /tenant`,
          ].join('\n');
          if (t.line_user_id) {
            await notifQueue.enqueue(pool, {
              channel: 'line', recipient: t.line_user_id, subject, body,
              payload: { oaId: t.line_oa_id || null, billId: b.id },
            }).catch(() => {});
          }
          if (t.email) {
            await notifQueue.enqueue(pool, {
              channel: 'email', recipient: t.email, subject, body,
              payload: { billId: b.id },
            }).catch(() => {});
          }
        }
      } catch (err) {
        console.warn('[scheduler] tenant notify enqueue failed:', err.message);
      }
    }
  } catch (err) {
    console.error('[scheduler] bill gen failed:', err.message);
  }
}

// C2 — meter simulator: when meterIot.mode === 'simulator', generate one
// fake water + one fake elec reading per active room each tick (capped to
// once per hour so we don't flood the table). Real-world dorms see ~1
// reading/day per meter; simulator runs hourly so demos look lively.
//
// Belt-and-braces: even though the PUT /api/admin/features route refuses to
// save mode='simulator' in production, the flag could already be 'simulator'
// from a pre-production toggle that survives a NODE_ENV change (e.g. flipping
// the same DB from staging to prod). Hard-block at the tick site too — the
// only way to enable simulator in production is to lower NODE_ENV deliberately.
async function tickMeterSimulator(pool, flags, now, state) {
  if (!flags.meterIot || !flags.meterIot.enabled) return;
  if (flags.meterIot.mode !== 'simulator') return;
  if ((process.env.NODE_ENV || 'production') === 'production') {
    // Only log once per state to avoid Railway log spam — guard via the
    // shared scheduler-state file. Operators see ONE warning at boot, not
    // one per hour.
    if (!state.simulatorBlockedLogged) {
      console.warn(
        '[scheduler] meter simulator is enabled but NODE_ENV=production — ' +
        'refusing to fabricate readings; flip mode to "manual" or "mqtt" in /admin#features.'
      );
      state.simulatorBlockedLogged = true;
    }
    return;
  }
  // Reset the warning latch when we leave production so the next tick logs again.
  state.simulatorBlockedLogged = false;
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
    // Capture which tenants were ACTUALLY affected (not just which ones MIGHT
    // be) by using RETURNING tenant_id. Without this, the post-update notify
    // step has to guess at the change set — and guessing via timestamps fails
    // because access_cards has no updated_at column (only revoked_at, set on
    // revoke but cleared on restore).
    const revokedTenants = new Set();
    const restoredTenants = new Set();
    if (overdueIds.length) {
      const r = await pool.query(
        `UPDATE access_cards
            SET status='revoked', revoked_at=NOW(), revoke_reason=$1
          WHERE status='active' AND tenant_id = ANY($2::bigint[])
          RETURNING tenant_id`,
        [REVOKE_REASON, overdueIds]
      );
      revoked = r.rowCount || 0;
      for (const row of r.rows) revokedTenants.add(Number(row.tenant_id));
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
        RETURNING tenant_id
    `, [REVOKE_REASON, threshold]);
    for (const row of restore.rows) restoredTenants.add(Number(row.tenant_id));
    restored = restore.rowCount || 0;
    state.lastAccessSync = todayKey;
    writeState(state);
    if (revoked || restored) {
      console.log(`[scheduler] access cards: revoked=${revoked} restored=${restored}`);
    }
    // Notify each affected tenant individually so they understand WHY
    // their card stopped working (or that it's working again). Use the
    // tenant_id sets captured from the UPDATE...RETURNING above so we
    // notify exactly the rows that changed in this run — a tenant who
    // had multiple cards (some auto-revoked, some manual) might appear
    // in BOTH sets if the auto-revoke pattern toggled them; that's rare
    // enough that we don't dedupe explicitly.
    const tenantsToNotify = new Map();
    for (const tid of revokedTenants) tenantsToNotify.set(tid, 'revoked');
    for (const tid of restoredTenants) tenantsToNotify.set(tid, 'restored');
    if (tenantsToNotify.size > 0) {
      try {
        const ids = Array.from(tenantsToNotify.keys());
        const affected = await pool.query(
          `SELECT id, full_name, phone, email, line_user_id, line_oa_id, status
             FROM tenants
            WHERE id = ANY($1::bigint[])
              AND deleted_at IS NULL
              AND status='active'`,
          [ids]
        );
        for (const t of affected.rows) {
          const action = tenantsToNotify.get(Number(t.id));
          const isRevoked = action === 'revoked';
          const subject = isRevoked
            ? '🔒 บัตรเข้า-ออกถูกระงับ — ค้างชำระค่าเช่า'
            : '🔓 บัตรเข้า-ออกกลับมาใช้ได้แล้ว';
          const body = isRevoked
            ? `เรียน คุณ${t.full_name}\n\n`
              + `ระบบได้ระงับบัตรเข้า-ออกของคุณชั่วคราวเนื่องจากมีบิลค้างชำระเกิน ${threshold} วัน\n\n`
              + `📋 วิธีแก้:\n`
              + `   1) ชำระบิลค้างผ่านพอร์ทัล /tenant\n`
              + `   2) เมื่อยืนยันการชำระเรียบร้อย ระบบจะเปิดใช้บัตรอัตโนมัติภายใน 24 ชม.\n\n`
              + `หากมีปัญหาติดต่อสำนักงาน`
            : `เรียน คุณ${t.full_name}\n\n`
              + `บัตรเข้า-ออกของคุณกลับมาใช้ได้แล้ว — ขอบคุณที่ชำระบิลตรงเวลา 🎉`;
          notifier.notifyTenant({ pool, features: flags || {} }, t, {
            subject, text: body,
          }).catch((err) => {
            console.warn('[scheduler] access card notify failed:', err.message);
          });
        }
      } catch (err) {
        console.warn('[scheduler] access card notify lookup failed:', err.message);
      }
    }
  } catch (err) {
    console.error('[scheduler] access sync failed:', err.message);
  }
}

// === Contract expiry monitor ==============================================
// Two responsibilities:
//   1. Auto-flip contracts whose end_date is in the past from 'active' to
//      'expired' so reports + access-control logic see them as ended. With-
//      out this, a contract that ended 6 months ago still shows status=
//      'active' and any "active contracts" view is wrong.
//   2. Notify the owner once per day about contracts expiring within 30
//      days so they can plan renewals + send the tenant a "would you like
//      to extend?" message before the contract ends.
//
// Daily cadence — trigger once per day via the existing state latch.
// Notification deduplicated via state.lastContractExpiryAt = todayKey.
async function tickContractExpiry(pool, _flags, now, state) {
  const todayKey = now.toISOString().slice(0, 10);
  if (state.lastContractExpiryAt === todayKey) return;
  try {
    // (1) auto-expire — single statement, idempotent.
    const expired = await pool.query(
      `UPDATE contracts SET status='expired'
         WHERE status='active' AND end_date IS NOT NULL AND end_date < CURRENT_DATE
       RETURNING id, contract_no, tenant_id`
    );
    if (expired.rowCount > 0) {
      console.log(`[scheduler] auto-expired ${expired.rowCount} contract(s) past end_date`);
    }

    // (2) upcoming expiries — anything ending in the next 30 days that's
    // still active. Send ONE consolidated message to the owner so we don't
    // spam them when 5 contracts end in the same week.
    const { rows: upcoming } = await pool.query(
      `SELECT c.id, c.contract_no, c.end_date, c.room_id,
              t.full_name, t.phone, t.email, t.line_user_id, t.line_oa_id,
              (c.end_date - CURRENT_DATE) AS days_left
         FROM contracts c
         LEFT JOIN tenants t ON t.id = c.tenant_id
        WHERE c.status='active'
          AND c.end_date IS NOT NULL
          AND c.end_date >= CURRENT_DATE
          AND c.end_date <  CURRENT_DATE + INTERVAL '30 days'
        ORDER BY c.end_date ASC`
    );

    if (upcoming.length > 0 || expired.rowCount > 0) {
      const lines = [];
      if (expired.rowCount > 0) {
        lines.push(`📋 สัญญา ${expired.rowCount} ฉบับสิ้นสุดแล้ว — เปลี่ยนสถานะเป็น expired`);
      }
      if (upcoming.length > 0) {
        lines.push(`\n⏰ สัญญาใกล้หมดอายุ (≤ 30 วัน):`);
        for (const c of upcoming) {
          lines.push(`  • ${c.contract_no} (ห้อง ${c.room_id || '-'}) `
            + `${c.full_name || '-'} — เหลือ ${c.days_left} วัน (${c.end_date})`);
        }
      }
      try {
        await notifier.notifyOwner({ pool, features: _flags || {} }, {
          subject: '📋 รายงานสัญญา (รายวัน)',
          text: lines.join('\n'),
        });
      } catch (err) {
        console.warn('[scheduler] contract notify owner failed:', err.message);
      }
    }
    state.lastContractExpiryAt = todayKey;
    writeState(state);
  } catch (err) {
    console.error('[scheduler] contract expiry tick failed:', err.message);
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
    tickContractExpiry(pool, flags, now, state),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') {
      console.error('[scheduler] sub-tick failed:', r.reason && r.reason.message || r.reason);
    }
  }
  // Health probe + auto-alert. Runs every tick (hourly) regardless of
  // feature flags — operators always want to know when something's wrong.
  // Internally guarded against notification spam (only alerts on
  // status transitions or after 60min in error state).
  try {
    const anomalyDetector = require('./anomalyDetector');
    await anomalyDetector.tick(pool, state);
    writeState(state);
  } catch (err) {
    console.error('[scheduler] anomaly tick failed:', err.message);
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
