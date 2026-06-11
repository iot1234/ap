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
const promptpay = require('./promptpay');
const notifier = require('./notifier');
const meter = require('./meter');
const email = require('./email');

const TICK_MS = 60 * 60 * 1000;          // hourly
const SCHEDULER_FAILURE_RE_ALERT_MIN = 60;

// === Local (ICT) date keys ================================================
// The process runs with TZ=Asia/Bangkok and the app pool (server.js — and the
// fallback db/pool.js) sets every SQL session to the same zone on connect, so
// every SQL CURRENT_DATE/NOW() evaluates in ICT. The daily
// "ran today" latches and advisory-lock suffixes MUST use the same ICT
// calendar day — `now.toISOString()` is UTC and would roll the day boundary
// over at 07:00 ICT instead of midnight, drifting the latch out of step with
// the ICT CURRENT_DATE the jobs' SQL compares against. These helpers read the
// LOCAL (ICT) wall-clock so JS latch day == SQL business day.
function localDateKey(now) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;                // YYYY-MM-DD (ICT)
}
function localHourKey(now) {
  return `${localDateKey(now)}T${String(now.getHours()).padStart(2, '0')}`; // YYYY-MM-DDTHH (ICT)
}

const SCHEDULER_JOB_IMPACT = Object.freeze({
  'features-load': 'โหลด feature flags ไม่ได้ งานอัตโนมัติรอบนี้ถูกข้ามทั้งหมด',
  'late-fee': 'บิลเลยกำหนดอาจยังไม่ถูกเปลี่ยนเป็น overdue และค่าปรับอาจยังไม่ถูกคำนวณ',
  'access-sync': 'บัตรเข้า-ออกอาจยังไม่ถูกระงับ/คืนสิทธิ์ตามสถานะชำระเงินล่าสุด',
  'auto-backup': 'ระบบอาจไม่ได้สร้าง backup รอบล่าสุด',
  'bill-gen': 'บิลรายเดือนอัตโนมัติอาจไม่ถูกสร้างหรือส่งแจ้งผู้เช่า',
  'meter-sim': 'มิเตอร์จำลองอาจไม่สร้างค่าทดสอบรอบนี้',
  'contract-expiry': 'สัญญาที่หมดอายุอาจยังไม่ถูกปรับสถานะหรือแจ้งเตือน',
  'overdue-digest': 'เจ้าของอาจไม่ได้รับสรุปบิลค้างชำระรายวัน',
  'auto-reconcile': 'ห้องที่สถานะค้าง/ไม่สอดคล้องอาจยังไม่ได้ถูกตรวจและแก้',
  'room-status-sync': 'สถานะห้องจากสัญญา/บิลอาจยังไม่ถูก sync รายวัน',
  'notif-prune': 'คิวแจ้งเตือนเก่าที่ failed อาจยังไม่ถูกล้าง',
  'orphan-slip-prune': 'ไฟล์สลิปกำพร้าอาจยังไม่ถูกลบออกจาก storage',
  'payment-reminder': 'ผู้เช่าอาจไม่ได้รับ reminder ก่อนวันครบกำหนดชำระ',
  'pending-slip-alert': 'สลิปที่ค้างคิวตรวจนานอาจไม่ถูกแจ้งเตือนถึงเจ้าของ',
  'invitation-expiry-warn': 'ผู้เช่า/แอดมินอาจไม่ได้รับเตือนว่าลิงก์กรอกสัญญาใกล้หมดอายุ',
  'booking-stale': 'การจองที่ค้างนานอาจยังไม่ถูกยกเลิกอัตโนมัติและห้องยังถูกล็อกไว้',
  'anomaly': 'health/anomaly alert รอบนี้อาจไม่ทำงาน',
});

function schedulerFailureMessage(err) {
  if (!err) return 'unknown error';
  return String(err.message || err.error || err).slice(0, 800);
}

function schedulerFailureAgeMin(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 60_000;
}

async function notifySchedulerFailure(pool, flags, state, job, err) {
  const message = schedulerFailureMessage(err);
  if (!state.schedulerFailures || typeof state.schedulerFailures !== 'object') {
    state.schedulerFailures = {};
  }
  const prev = state.schedulerFailures[job] || {};
  const isSameRecent = prev.message === message
    && schedulerFailureAgeMin(prev.notifiedAt) < SCHEDULER_FAILURE_RE_ALERT_MIN;
  state.schedulerFailures[job] = {
    message,
    notifiedAt: isSameRecent ? prev.notifiedAt : new Date().toISOString(),
  };
  writeState(state);
  if (isSameRecent) return;
  const impact = SCHEDULER_JOB_IMPACT[job] || 'งานเบื้องหลังบางส่วนอาจไม่ทำงานครบถ้วน';
  try {
    await notifier.notifyOwner({ pool, features: flags || {} }, {
      category: 'system',
      subject: `งานอัตโนมัติทำงานไม่สำเร็จ: ${job}`,
      text: [
        'ระบบงานอัตโนมัติทำงานไม่สำเร็จ',
        '',
        `งาน: ${job}`,
        `ผลกระทบ: ${impact}`,
        `ข้อผิดพลาด: ${message}`,
        '',
        'สิ่งที่ต้องทำ:',
        '1. เปิด /admin#health เพื่อตรวจสถานะรวม',
        '2. เปิด /admin#notifications เพื่อตรวจคิวแจ้งเตือน',
        '3. หากเกิดซ้ำ ให้แจ้งช่วงเวลาที่เกิดปัญหาให้ผู้ดูแลระบบตรวจบันทึกระบบและแก้การตั้งค่า/ฐานข้อมูลตามข้อผิดพลาดด้านบน',
      ].join('\n'),
    });
  } catch (notifyErr) {
    console.warn('[scheduler] failure alert notify failed:', notifyErr.message);
  }
}

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

// R6 — explicit persistence warning. The /tmp fallback works at the file-
// system level but every container restart wipes /tmp, which means the
// daily-fired latches (lastBillPeriod, lastLateFeeMark, etc.) reset and
// the same bills can re-fire on the next boot — once-per-period
// notifications turn into per-boot notifications. The DB-level idempotency
// guards (uq_bills_room_period_tenant_active, ON CONFLICT, advisory locks)
// still prevent duplicate INSERTs, but the OWNER alerts ("ออกบิลอัตโนมัติ
// X ใบ") are NOT idempotent — without a persistent state file they'd land
// in the owner's inbox every restart of the day. Surface this loudly at
// boot so operators set SCHEDULER_STATE_FILE / UPLOAD_DIR to a real volume.
const _isTmpFallback = !!(STATE_FILE
  && STATE_FILE === path.join(require('os').tmpdir(), 'baankarn-scheduler-state.json'));
if (STATE_FILE && STATE_FILE !== _candidateStatePaths[0]) {
  console.log('[scheduler] state file:', STATE_FILE);
}
if (_isTmpFallback) {
  console.warn(
    '[scheduler] ⚠️ state file is on /tmp (ephemeral). '
    + 'Daily latches reset every container restart — owner can receive '
    + 'duplicate "auto-bill" / "late fee" notifications until midnight UTC. '
    + 'Set SCHEDULER_STATE_FILE or UPLOAD_DIR to a persistent volume to fix.'
  );
}
function isStateFilePersistent() {
  // The first candidate is operator-supplied via env (SCHEDULER_STATE_FILE
  // or UPLOAD_DIR), the second is the app dir (works for self-hosted +
  // VM deploys where the working directory persists). Both are treated as
  // "persistent". The /tmp fallback is not. Used by /admin#health to surface
  // an actionable warning when the deploy is missing a volume mount.
  return !!STATE_FILE && !_isTmpFallback;
}

function readState() {
  if (!STATE_FILE) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}
function writeState(s) {
  if (!STATE_FILE) return;
  // Write atomically: write to a sibling temp file then rename. POSIX rename
  // is atomic (Windows too on same volume from Node 18+), so a second
  // process can never see a half-written JSON. Without this, two instances
  // (Railway redeploy overlap, or a pod with multiple workers) can clobber
  // each other's daily-latch state — losing todaysAccessSync mid-cycle and
  // making the owner digest skip the access-card summary.
  const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, STATE_FILE);
    return;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    // First write that lands here means our pick became unwritable
    // (e.g. permissions changed). Try to relocate ONCE so we don't spam logs.
    if (err.code === 'EACCES' || err.code === 'EROFS') {
      const fallback = path.join(require('os').tmpdir(), 'baankarn-scheduler-state.json');
      if (STATE_FILE !== fallback) {
        console.warn('[scheduler] relocating state file to', fallback, '(reason:', err.code + ')');
        STATE_FILE = fallback;
        const tmp2 = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
        try {
          fs.writeFileSync(tmp2, JSON.stringify(s));
          fs.renameSync(tmp2, STATE_FILE);
          return;
        }
        catch (e2) {
          try { fs.unlinkSync(tmp2); } catch { /* ignore */ }
          console.error('[scheduler] tmp fallback also failed:', e2.message);
        }
      }
    }
    console.error('[scheduler] state write failed:', err.message);
  }
}

async function tickAutoBackup(pool, flags, now, state) {
  if (!flags.autoBackup || !flags.autoBackup.enabled) return;
  const todayKey = localDateKey(now);
  if (state.lastBackup === todayKey) return;
  // `?? 19` not `|| 19` — hourUtc=0 (midnight UTC = 07:00 ICT) is a legal
  // configured value (features.js validates 0-23) and must not fall back.
  if (now.getUTCHours() !== Number(flags.autoBackup.hourUtc ?? 19)) return;
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
    return { error: err.message };
  }
}

async function tickLateFee(pool, flags, now, state) {
  const todayKey = localDateKey(now);
  if (state.lastLateFeeMark === todayKey) return;
  try {
    // R2 — Two-phase late fee handling, in order:
    //
    //   Phase A: status='pending' AND due_date < TODAY → flip to 'overdue'.
    //     For freshly-overdue bills, compute late_fee from the principal
    //     (rent + util + recurring + vat — i.e. total minus any pre-existing
    //     late_fee) and write back to bills.late_fee + bills.total in ONE
    //     atomic UPDATE so the audit invariant
    //         total = subtotal + vat + late_fee
    //     never breaks halfway.
    //
    //   Phase B: status='overdue' (incl. older bills from prior days)
    //     → re-compute late_fee from `total - late_fee` (principal) ×
    //       monthsOver. Idempotent: running twice on the same day yields
    //       the same value, not a doubled one. This is what keeps a bill
    //       that's been overdue for 53 days correctly priced — the
    //       scheduler may have ticked it on day 1, 8, 15, 22, ... and each
    //       tick recomputes from principal × monthsOver(today).
    //
    // The buildBill engine NEVER computes a late fee on the NEW month's
    // bill any more — every penalty lives on the bill it belongs to, not
    // carried forward into next month's invoice (R2). Tenants viewing the
    // old bill always see the up-to-date amount due.
    const lateFeeEnabled = !!(flags && flags.lateFee && flags.lateFee.enabled);
    const ratePctMonth = lateFeeEnabled ? Number(flags.lateFee.ratePctPerMonth || 0) : 0;
    const gracePeriodDays = lateFeeEnabled ? Number(flags.lateFee.gracePeriodDays || 0) : 0;
    // Optional accrual ceilings (prevention against runaway late fees on
    // long-overdue bills). 0 = no cap (current behavior).
    const minLateFeeBaht = lateFeeEnabled ? Number(flags.lateFee.minLateFeeBaht || 0) : 0;
    const maxPctOfPrincipal = lateFeeEnabled ? Number(flags.lateFee.maxPctOfPrincipal || 0) : 0;
    const maxLateFeeBaht = lateFeeEnabled ? Number(flags.lateFee.maxLateFeeBaht || 0) : 0;
    // Per-room late-fee exemption (config.billing.lateFeeExemptRooms: string[]) —
    // run "เก็บ/ไม่เก็บค่าล่าช้า" per room without disabling the feature globally.
    let lateFeeExemptRooms = new Set();
    if (lateFeeEnabled) {
      try {
        const { rows: cfgRows } = await pool.query(
          `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
        );
        const arr = cfgRows[0] && cfgRows[0].value && cfgRows[0].value.billing
          && cfgRows[0].value.billing.lateFeeExemptRooms;
        if (Array.isArray(arr)) lateFeeExemptRooms = new Set(arr.map((x) => String(x)));
      } catch { /* config blob missing — no exemptions */ }
    }

    // PostgreSQL doesn't allow DISTINCT inside RETURNING — the old query
    // raised "syntax error at or near DISTINCT" every tick, so bills past
    // due_date were NEVER auto-marked overdue (and the room status cascade
    // below never ran). Wrap in a CTE so we can shape the result freely.
    // We return one row per flipped bill (not deduped) because we need each
    // bill's tenant + bill_no for the per-tenant overdue notification below.
    const { rows: flipped } = await pool.query(
      `WITH bumped AS (
         UPDATE bills SET status='overdue'
           WHERE status='pending' AND due_date < CURRENT_DATE
                 AND deleted_at IS NULL
           RETURNING id, room_id, tenant_id, total, late_fee, subtotal, vat,
                     due_date, bill_no, period
       )
       SELECT b.id, b.room_id, b.tenant_id, b.total, b.late_fee, b.subtotal, b.vat,
              b.due_date, b.bill_no, b.period,
              t.full_name, t.phone, t.email, t.line_user_id, t.line_oa_id,
              t.status AS tenant_status, t.deleted_at,
              (SELECT (c.terms_template_snapshot->'financials'->>'lateFeeRate')::numeric
                 FROM contracts c
                WHERE c.room_id = b.room_id AND c.tenant_id = b.tenant_id
                  AND c.locked_at IS NOT NULL
                  AND c.terms_template_snapshot IS NOT NULL
                ORDER BY c.start_date DESC NULLS LAST, c.id DESC
                LIMIT 1) AS contract_late_fee_rate,
              (SELECT COUNT(*)::int FROM payments p
                 WHERE p.bill_id = b.id AND p.status = 'pending') AS pending_slip_count
         FROM bumped b
         LEFT JOIN tenants t ON t.id = b.tenant_id`
    );

    // Resolve the late-fee RATE for a specific bill: prefer the rate LOCKED into
    // the tenant's signed contract snapshot (so a later change to the global
    // features.lateFee.ratePctPerMonth doesn't retroactively override a rate the
    // tenant agreed to in their PDF), and only fall back to the current global
    // rate when the bill has no locked contract snapshot. Mirrors the PDF
    // render logic in server.js (prefer snapshot.financials.lateFeeRate). Grace
    // period stays global — the snapshot only locks the rate + due day.
    const resolveBillRate = (b) => {
      const cr = Number(b.contract_late_fee_rate);
      return (b.contract_late_fee_rate != null && Number.isFinite(cr) && cr >= 0)
        ? cr : ratePctMonth;
    };

    // Phase A: apply late_fee to each just-flipped bill. Skip when the
    // feature is off — the bill still flips to overdue so the tenant gets
    // notified, just without an added penalty.
    //
    // R2-followup — FAIRNESS GUARD: skip adding a late_fee when the tenant
    // already has a pending slip on this bill. The slip was uploaded BEFORE
    // tickLateFee fired, so the tenant committed to pay the original total
    // and shouldn't be retroactively charged a penalty while waiting for
    // admin review. The validatePaymentAmount two-tier check would catch
    // this on verify, but skipping the fee here keeps bill.total stable
    // during the review window (better UX in the admin queue).
    // Gate on the flag only — NOT `ratePctMonth > 0`. A global rate of 0
    // ("no late fee by default") must not disable contract-locked rates:
    // resolveBillRate prefers the snapshot rate per bill, and computeLateFee
    // already returns 0 when the effective rate resolves to 0.
    if (lateFeeEnabled && flipped.length) {
      for (const b of flipped) {
        if (Number(b.pending_slip_count) > 0) {
          // Audit the skip so admin can see WHY a bill flipped overdue
          // without a fee — useful for reconciliation.
          await pool.query(
            `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            ['system:scheduler', 'bill.late_fee_skipped_pending_slip', 'bill', String(b.id),
             JSON.stringify({
               pendingSlipCount: Number(b.pending_slip_count),
               due_date: b.due_date,
               reason: 'tenant has a pending slip — late_fee held until verify decision',
             })]
          ).catch(() => { /* best-effort */ });
          continue;
        }
        // Match Phase B's ex-tenant exclusion: don't apply a growing late fee
        // to a bill whose tenant has moved out / been soft-deleted (orphan
        // bills with tenant_id NULL are still penalised, same as Phase B).
        // Otherwise a bill that flips overdue the same day its tenant is
        // reconciled would get an initial fee Phase B then refuses to grow —
        // the two phases would disagree on the exact case the filter handles.
        if (b.tenant_id != null
            && (b.deleted_at != null || (b.tenant_status || 'active') !== 'active')) {
          continue;
        }
        // Per-room exemption — this room is configured "ไม่เก็บค่าล่าช้า".
        if (lateFeeExemptRooms.has(String(b.room_id))) continue;
        const effRate = resolveBillRate(b);
        const base = (Number(b.total) || 0) - (Number(b.late_fee) || 0);
        const calc = billing.computeLateFee({
          base,
          dueDate: b.due_date,
          ratePctPerMonth: effRate,
          gracePeriodDays,
          minLateFeeBaht,
          maxPctOfPrincipal,
          maxLateFeeBaht,
          maxBaht: maxLateFeeBaht,
          now,
        });
        if (calc.lateFee > 0 && calc.lateFee !== Number(b.late_fee)) {
          try {
            await pool.query(
              `UPDATE bills
                  SET late_fee = $2::numeric,
                      total    = ($3::numeric + $2::numeric)
                WHERE id = $1
                  AND status = 'overdue'
                  AND deleted_at IS NULL`,
              [b.id, calc.lateFee, base]
            );
            b.late_fee = calc.lateFee;
            b.total = billing.round2(base + calc.lateFee);
            await pool.query(
              `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail)
               VALUES ($1, $2, $3, $4, $5::jsonb)`,
              ['system:scheduler', 'bill.late_fee_applied', 'bill', String(b.id),
                 JSON.stringify({
                   lateFee: calc.lateFee, base, daysOver: calc.daysOver,
                   monthsOver: calc.monthsOver, ratePctPerMonth: effRate,
                   rateSource: effRate === ratePctMonth ? 'global' : 'contract',
                   gracePeriodDays, minLateFeeBaht, maxPctOfPrincipal, maxLateFeeBaht,
                   capped: !!calc.capped, due_date: b.due_date, phase: 'A-flip',
                 })]
            ).catch(() => { /* audit best-effort */ });
          } catch (err) {
            console.warn(`[scheduler] late-fee apply Phase A bill ${b.id} failed:`, err.message);
          }
        }
      }
    }

    // Phase B: refresh late_fee on bills that were ALREADY overdue from a
    // prior day. Each tick recomputes from principal × monthsOver(today)
    // — idempotent and self-correcting (re-runs converge to the right
    // amount).
    // Same flag-only gate as Phase A — contract-locked rates keep accruing
    // even when the global ratePctPerMonth is 0.
    if (lateFeeEnabled) {
      try {
        const flippedIds = new Set(flipped.map((f) => Number(f.id)));
        // R2-followup — same FAIRNESS GUARD as Phase A: don't grow late_fee
        // on bills with a pending slip. The SQL filter `NOT EXISTS` is
        // cheaper than per-row checks, and the index on
        // payments(status, created_at DESC) makes the subquery fast.
        const { rows: stillOverdue } = await pool.query(
          // Same EXCLUDE-ex-tenant filter as the overdue digest (see below):
          // keep orphan bills (tenant_id NULL) but stop growing late_fee on
          // bills whose tenant has moved out / been soft-deleted. Previously
          // Phase B grew penalties on ex-tenants' bills forever while the
          // digest hid them, so the two views disagreed and the fee ballooned
          // unmonitored. Those bills should be reconciled, not auto-penalised.
          `SELECT b.id, b.room_id, b.tenant_id, b.total, b.late_fee, b.due_date,
                  (SELECT (c.terms_template_snapshot->'financials'->>'lateFeeRate')::numeric
                     FROM contracts c
                    WHERE c.room_id = b.room_id AND c.tenant_id = b.tenant_id
                      AND c.locked_at IS NOT NULL
                      AND c.terms_template_snapshot IS NOT NULL
                    ORDER BY c.start_date DESC NULLS LAST, c.id DESC
                    LIMIT 1) AS contract_late_fee_rate
             FROM bills b
             LEFT JOIN tenants t ON t.id = b.tenant_id
            WHERE b.status = 'overdue'
              AND b.deleted_at IS NULL
              AND b.paid_at IS NULL
              AND (
                b.tenant_id IS NULL
                OR (t.deleted_at IS NULL AND COALESCE(t.status,'active')='active')
              )
              AND NOT EXISTS (
                SELECT 1 FROM payments p
                 WHERE p.bill_id = b.id AND p.status = 'pending'
              )`
        );
        for (const b of stillOverdue) {
          if (flippedIds.has(Number(b.id))) continue;   // already done in Phase A
          if (lateFeeExemptRooms.has(String(b.room_id))) continue;   // room exempt
          const effRate = resolveBillRate(b);
          const base = (Number(b.total) || 0) - (Number(b.late_fee) || 0);
          const calc = billing.computeLateFee({
            base,
            dueDate: b.due_date,
            ratePctPerMonth: effRate,
            gracePeriodDays,
            minLateFeeBaht,
            maxPctOfPrincipal,
            maxLateFeeBaht,
            maxBaht: maxLateFeeBaht,
            now,
          });
          if (calc.lateFee > 0 && calc.lateFee !== Number(b.late_fee)) {
            try {
              await pool.query(
                `UPDATE bills
                    SET late_fee = $2::numeric,
                        total    = ($3::numeric + $2::numeric)
                  WHERE id = $1
                    AND status = 'overdue'
                    AND deleted_at IS NULL`,
                [b.id, calc.lateFee, base]
              );
              await pool.query(
                `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail)
                 VALUES ($1, $2, $3, $4, $5::jsonb)`,
                ['system:scheduler', 'bill.late_fee_applied', 'bill', String(b.id),
                 JSON.stringify({
                   lateFee: calc.lateFee, base, daysOver: calc.daysOver,
                   monthsOver: calc.monthsOver, ratePctPerMonth: effRate,
                   rateSource: effRate === ratePctMonth ? 'global' : 'contract',
                   gracePeriodDays, minLateFeeBaht, maxPctOfPrincipal, maxLateFeeBaht,
                   capped: !!calc.capped, due_date: b.due_date,
                   prevLateFee: Number(b.late_fee) || 0, phase: 'B-refresh',
                 })]
              ).catch(() => { /* best-effort */ });
            } catch (err) {
              console.warn(`[scheduler] late-fee apply Phase B bill ${b.id} failed:`, err.message);
            }
          }
        }
      } catch (err) {
        console.warn('[scheduler] late-fee Phase B sweep failed:', err.message);
      }
    }
    if (flipped.length) {
      const rooms = new Set(flipped.map((r) => r.room_id).filter(Boolean));
      console.log(`[scheduler] marked ${flipped.length} bill(s) overdue across ${rooms.size} room(s)`);

      // Cascade room status: any room with a freshly-overdue bill should
      // flip to 'overdue' status. Imported lazily so a missing module on
      // legacy deploys doesn't break the rest of the tick.
      try {
        const roomStatus = require('./roomStatus');
        for (const roomId of rooms) {
          await roomStatus.syncRoom(pool, roomId, { reason: 'bill-overdue-cron' })
            .catch((err) => console.warn(`[scheduler] room-status sync ${roomId} failed:`, err.message));
        }
      } catch (err) {
        console.warn('[scheduler] room-status cascade unavailable:', err.message);
      }

      // De-dupe with tickAccessControlSync: any tenant whose card will be
      // revoked TODAY (because they already have a bill at least threshold days
      // overdue) gets a single comprehensive "card suspended + here are
      // ALL your unpaid bills" message from access-sync. Sending them an
      // extra "another bill of yours is overdue" alert at the same hour
      // is redundant and noisy. Collect those tenant ids up front and
      // skip them in the per-bill loop below.
      //
      // The EXISTS clause matters: access-sync only notifies tenants whose
      // UPDATE matched an ACTIVE card. A tenant whose cards were already
      // revoked on a previous day (the steady state for long-delinquent
      // tenants) — or who has no card at all — produces zero UPDATE rows
      // there, so suppressing the per-bill alert for them means they get
      // NEITHER message and never learn the new bill went overdue.
      const tenantsGettingAccessAlert = new Set();
      if (flags?.accessControl?.enabled && flags?.accessControl?.requirePaymentForCard) {
        const rawThr = Number(flags.accessControl.overdueDaysThreshold);
        const thr = Number.isFinite(rawThr) ? Math.max(1, Math.min(365, Math.trunc(rawThr))) : 30;
        try {
          const dq = await pool.query(`
            SELECT DISTINCT tenant_id FROM bills
              WHERE status='overdue' AND tenant_id IS NOT NULL
                AND deleted_at IS NULL AND paid_at IS NULL
                AND due_date <= CURRENT_DATE - ($1::int * INTERVAL '1 day')
                AND EXISTS (
                  SELECT 1 FROM access_cards ac
                   WHERE ac.tenant_id = bills.tenant_id
                     AND ac.status = 'active'
                )
          `, [thr]);
          for (const r of dq.rows) tenantsGettingAccessAlert.add(Number(r.tenant_id));
        } catch { /* fall back to sending the per-bill alert */ }
      }

      // Notify each tenant the same day their bill flipped overdue. Without
      // this the only signal the tenant got was the next month's bill +
      // accumulated late fee — surprise charges drive support tickets. Plain
      // Thai, with the bill identity, the amount, what to do, and who to
      // contact, so the tenant doesn't have to guess.
      // Inline lookup — server.js has a loadBuildingName helper but it's
      // private; we don't pull it through a require to avoid the cycle.
      let buildingName = 'หอพัก';
      try {
        const cfgRes = await pool.query(
          `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
        );
        const cfg = cfgRes.rows.length ? cfgRes.rows[0].value : {};
        buildingName = (cfg && cfg.building && cfg.building.name) || 'หอพัก';
      } catch { /* default already set */ }
      for (const b of flipped) {
        if (!b.tenant_id || b.tenant_status !== 'active' || b.deleted_at) continue;
        // Skip this per-bill alert when the same tenant is about to get a
        // comprehensive "card suspended + full unpaid list" message from
        // tickAccessControlSync — sending both at the same hour is noise.
        if (tenantsGettingAccessAlert.has(Number(b.tenant_id))) continue;
        try {
          const amtStr = Number(b.total).toLocaleString('th-TH', { minimumFractionDigits: 2 });
          const dueStr = b.due_date ? new Date(b.due_date).toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' }) : '-';
          await notifier.notifyTenant({ pool, features: flags || {} }, {
            id: b.tenant_id,
            full_name: b.full_name,
            phone: b.phone,
            email: b.email,
            line_user_id: b.line_user_id,
            line_oa_id: b.line_oa_id,
            status: b.tenant_status,
          }, {
            subject: '⏰ บิลของคุณเลยกำหนดชำระแล้ว',
            text: [
              `เรียน คุณ${b.full_name}`,
              '',
              `แจ้งให้ทราบว่า บิลด้านล่างเลยวันที่ครบกำหนดชำระแล้ว`,
              '',
              `📄 บิล: ${b.bill_no || `#${b.id}`}${b.period ? ` (รอบ ${b.period})` : ''}`,
              `🏠 ห้อง: ${b.room_id || '-'}`,
              `💰 ยอดที่ต้องชำระ: ฿${amtStr}`,
              `📅 ครบกำหนดเมื่อ: ${dueStr}`,
              '',
              `📋 สิ่งที่ต้องทำ:`,
              `   1) ชำระผ่าน QR PromptPay หรือโอนเงินตามที่ระบุในบิล`,
              `   2) อัปโหลดสลิปที่พอร์ทัลผู้เช่า /tenant`,
              `   3) ถ้าชำระเรียบร้อยแล้ว ระบบจะอัปเดตให้อัตโนมัติ`,
              '',
              `หมายเหตุ: หากค้างต่อเนื่องหลายวัน อาจมีค่าปรับและการระงับบัตรเข้า-ออก`,
              '',
              `หากชำระแล้วหรือมีข้อสงสัย ติดต่อ ${buildingName}`,
            ].join('\n'),
          });
        } catch (err) {
          console.warn(`[scheduler] overdue tenant notify failed for bill ${b.id}:`, err.message);
        }
      }
    }
    state.lastLateFeeMark = todayKey;
    writeState(state);
  } catch (err) {
    console.error('[scheduler] late-fee mark failed:', err.message);
    return { error: err.message };
  }
}

// Daily safety-net for room-status drift. Every room gets re-derived from
// its contracts + bills + reservation pointer. Catches drift introduced by
// any path that mutated room state without calling syncRoom (e.g. a manual
// SQL fix by ops, an older migration, or a future refactor that forgets to
// cascade). The targeted per-event syncRoom calls keep latency low; this
// tick is the eventual-consistency layer.
async function tickRoomStatusSync(pool, _flags, now, state) {
  const todayKey = localDateKey(now);
  if (state.lastRoomStatusSyncAt === todayKey) return;
  try {
    const roomStatus = require('./roomStatus');
    const summary = await roomStatus.syncAllRooms(pool, { reason: 'daily-sync' });
    if (summary.changed > 0) {
      console.log(`[scheduler] roomStatus sync changed ${summary.changed}/${summary.scanned} rooms (errors: ${summary.errors})`);
      // Notify owner only when the daily drift was substantial (>= 3 rooms
      // changed in one tick is unusual — suggests a process touched rooms
      // outside the normal cascade and ops want to know).
      if (summary.changed >= 3) {
        try {
          await notifier.notifyOwner({ pool, features: _flags || {} }, {
            category: 'system',
            subject: `🔄 ปรับสถานะห้องอัตโนมัติ ${summary.changed} ห้อง`,
            text: `Daily roomStatus sync ปรับ ${summary.changed} ห้อง (จาก ${summary.scanned}):\n\n`
              + summary.changes.slice(0, 20).map((c) =>
                  `  • ห้อง ${c.roomId}: ${c.before || '(empty)'} → ${c.after}`
                ).join('\n')
              + (summary.changes.length > 20 ? `\n  …และอีก ${summary.changes.length - 20} ห้อง` : '')
              + `\n\nถ้าจำนวนนี้สูงผิดปกติ ตรวจสอบที่ /admin#health`,
          });
        } catch { /* ignore */ }
      }
    }
    state.lastRoomStatusSyncAt = todayKey;
    writeState(state);
  } catch (err) {
    console.error('[scheduler] roomStatus sync failed:', err.message);
    return { error: err.message };
  }
}

// Due date for an auto-generated bill: the resolved due day in the CURRENT
// month, rolled to the NEXT month when that day already passed ("bill on the
// 20th, due the 1st" means the 1st of the FOLLOWING month). Without the roll
// the bill is born overdue — the next tickLateFee flips it and charges a fee
// computed from days before the bill even existed. Same-day (due day ==
// generation day) stays in this month: "due today" is a valid window and the
// payment reminder handles it. `due` is resolveBillDueDay's result (day 1-28,
// so the rolled month always has the day); formatYMD stays the only date
// constructor (timezone-safe — no Date→toISOString round-trip).
function billGenDueDateFor(now, due) {
  if (due.day < now.getDate()) {
    let y = now.getFullYear();
    let m = now.getMonth() + 2;            // roll into next month
    if (m > 12) { m = 1; y += 1; }
    return billing.formatYMD(y, m, due.day);
  }
  return billing.formatYMD(now.getFullYear(), now.getMonth() + 1, due.day);
}

async function tickBillGen(pool, flags, now, state) {
  if (!flags.billAutoGenerate || !flags.billAutoGenerate.enabled) return;
  const dom = Number(flags.billAutoGenerate.dayOfMonth || 1);
  // Clamp the configured day to the actual last day of THIS month. Without
  // this, dom=31 silently skips every month with <31 days (Feb 28/29, Apr,
  // Jun, Sep, Nov) — those tenants got their bill 1 month late. dom=30 in
  // February (28/29 days) had the same issue. Now: if today is the
  // calendar dom OR if today is the last day of the month AND dom > last,
  // we treat it as "today is bill day" and run.
  const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const effectiveDom = Math.min(dom, lastDayOfMonth);
  if (now.getDate() !== effectiveDom) return;
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
    const paymentBlock = billing.buildPaymentBlock(config);
    const ppTarget = paymentBlock.promptpayTarget
      || require('./secrets').get('PROMPTPAY_TARGET');
    const hasManualPaymentChannel = !!(
      (paymentBlock.bankInfo && paymentBlock.bankInfo.account)
      || (paymentBlock.walletInfo && paymentBlock.walletInfo.phone)
    );
    if (!ppTarget && !hasManualPaymentChannel) issues.push('ยังไม่ได้ตั้ง PromptPay/บัญชีธนาคาร/TrueMoney Wallet');
    else if (promptpay.isDemoTarget(ppTarget)) issues.push('PROMPTPAY_TARGET ยังเป็นค่า demo');
    const wRate = Number(config?.utilities?.waterRate);
    const eRate = Number(config?.utilities?.elecRate);
    // Only require global rate > 0 if any eligible room is on metered mode for
    // that utility. Flat-mode rooms (เหมา) carry their own water_flat_amount /
    // elec_flat_amount and don't need a global per-unit rate. Without this gate,
    // buildings that run entirely on flat charges would skip every monthly run
    // because the operator legitimately left global rates at 0.
    const eligibleRooms = rooms.filter((r) => r && r.tenant
      && (r.status === 'occupied' || r.status === 'overdue'));
    const firstMonthRoomIds = new Set();
    const eligibleRoomIds = eligibleRooms.map((r) => String(r?.id || '')).filter(Boolean);
    if (eligibleRoomIds.length > 0) {
      try {
        const contractQ = await pool.query(
          `SELECT DISTINCT ON (room_id) id, room_id, tenant_id, start_date
             FROM contracts
            WHERE room_id = ANY($1::text[])
              AND status='active' AND deleted_at IS NULL
            ORDER BY room_id, start_date DESC NULLS LAST, id DESC`,
          [eligibleRoomIds]
        );
        for (const contract of contractQ.rows || []) {
          if (!billing.contractStartsInPeriod(contract, period)) continue;
          firstMonthRoomIds.add(String(contract.room_id));
        }
      } catch (err) {
        if (err.code !== '42P01' && err.code !== '42703') throw err;
      }
    }
    const monthlyEligibleRooms = eligibleRooms
      .filter((r) => !firstMonthRoomIds.has(String(r?.id || '')));
    const anyMeteredWater = monthlyEligibleRooms.some((r) => !billing.isFlatUtilityConfigured(r, 'water'));
    const anyMeteredElec  = monthlyEligibleRooms.some((r) => !billing.isFlatUtilityConfigured(r, 'elec'));
    if (anyMeteredWater && (!Number.isFinite(wRate) || wRate <= 0)) issues.push('waterRate ไม่ตั้ง / ≤ 0');
    if (anyMeteredElec  && (!Number.isFinite(eRate) || eRate <= 0)) issues.push('elecRate ไม่ตั้ง / ≤ 0');
    if (eligibleRooms.length === 0) issues.push('ไม่มีห้อง occupied/overdue ที่จะออกบิล');
    if (monthlyEligibleRooms.length > 0) {
      const periodMeters = await meter.buildPeriodSummary(pool, rooms, period);
      const missingMeters = [];
      for (const r of monthlyEligibleRooms) {
        const fields = [];
        const m = periodMeters[String(r.id)] || {};
        if (!billing.isFlatUtilityConfigured(r, 'water') && m.waterCurrentReading == null) fields.push('water');
        if (!billing.isFlatUtilityConfigured(r, 'elec') && m.elecCurrentReading == null) fields.push('elec');
        if (fields.length) {
          missingMeters.push(`${r.id || '-'}:${fields.join('+')}`);
        }
      }
      if (missingMeters.length) {
        issues.push(
          `ไม่มีเลขมิเตอร์รอบ ${period} ครบ ${missingMeters.length} ห้อง (${missingMeters.slice(0, 10).join(', ')})`
        );
      }
    }

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
            category: 'billing',
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

    // Building-wide default: config.notify.dueOnDay. The FINAL per-room due
    // date is resolved inside the loop via billing.resolveBillDueDay — a
    // contract-locked due day (terms_template_snapshot.financials.dueDay,
    // the day printed on the tenant's signed PDF) wins over this config
    // value, same precedence rule as the rent and the late-fee rate.
    // formatYMD builds YYYY-MM-DD from local year/month directly — Date()→
    // toISOString() round-trip subtracts the timezone offset and on
    // Asia/Bangkok (UTC+7) returns the previous day, so bills issued on
    // the 1st with dueDay=15 would silently land on the 14th in storage.
    const configDueDay = config?.notify?.dueOnDay;
    let made = 0;
    // Track each successfully-inserted bill so we can fan out tenant
    // notifications AFTER the loop completes (one queue enqueue per bill,
    // not per attempt — failed inserts shouldn't notify anyone).
    const billsCreated = [];
    // R5 — capture per-room flat-mode silent fallbacks so we can alert
    // the owner once at the end of the run. Without this, an admin who
    // ticked "เหมา" but forgot to set the amount would silently get
    // metered bills generated by the scheduler with no warning.
    const flatFellBack = [];
    const firstMonthSkipped = [];
    // Distinguish "deployment that never uses the tenants table" (legacy
    // blob-only mode — billing with tenant_id NULL is the designed fallback)
    // from "tenants table is in use but THIS room has no active tenant"
    // (blob/relational drift — tenant checked out but the blob room still
    // shows them). In the drift case a generated bill would be an orphan:
    // invisible in the tenant portal, no LINE/email recipient, and late fees
    // accrue on it forever. Skip the room + alert the owner instead.
    // Mirrors the same guard in routes/bills-extras.js bulk-generate.
    let relationalTenantsInUse = false;
    try {
      const probe = await pool.query(
        `SELECT 1 FROM tenants WHERE deleted_at IS NULL LIMIT 1`
      );
      relationalTenantsInUse = probe.rows.length > 0;
    } catch { /* table absent on legacy deploys → blob-only mode */ }
    const tenantlessSkipped = [];
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
      if (relationalTenantsInUse && !tenantId) {
        tenantlessSkipped.push({
          roomId: String(room.id || ''),
          blobTenantName: String(room.tenant?.name || ''),
        });
        continue;
      }

      // R2 — previous overdue bill lookup is GONE. Late fees now live on
      // the bill they belong to (services/scheduler.js#tickLateFee updates
      // the old bill's late_fee + total in-place when it flips overdue).
      // The new month's bill always starts with late_fee=0; carrying the
      // previous month's penalty forward used to confuse tenants who
      // viewed the old bill and saw a total that didn't match what they
      // actually owed.

      // Pull contract-length discount so scheduler bills match what the
      // manual /api/bills POST + bulk-generate produce. Without this lookup
      // every auto-generated bill billed full rent regardless of the
      // discount the admin recorded at check-in.
      let discountPct = 0;
      // Pull the active contract for this room. Used for BOTH:
      //   - discount_pct (contract-length discount honored)
      //   - monthly_rent (locked rate from signing — bill engine prefers
      //     this over room.rent/formula via services/pricing.js so admin
      //     changing /admin#pricing mid-contract doesn't break existing
      //     tenants)
      let activeContract = null;
      let expiredContract = null;
      try {
        const cq = await pool.query(
          // contract_due_day: the due day the tenant SIGNED. Only locked
          // contracts carry the snapshot — drafts must not override config.
          // start_date filter: a queued RENEWAL contract (created ahead of
          // time, starting after the old one ends) must not hijack this
          // period's rent/discount/due-day before it actually begins.
          `SELECT id, monthly_rent, discount_pct, status, start_date,
                  CASE WHEN locked_at IS NOT NULL
                       THEN (terms_template_snapshot->'financials'->>'dueDay')::numeric
                  END AS contract_due_day
             FROM contracts
             WHERE room_id=$1 AND status='active' AND deleted_at IS NULL
               AND (start_date IS NULL OR to_char(start_date, 'YYYY-MM') <= $2)
             ORDER BY start_date DESC LIMIT 1`,
          [room.id, period]
        );
        if (cq.rows[0]) {
          activeContract = cq.rows[0];
          discountPct = Number(cq.rows[0].discount_pct) || 0;
        } else {
          // No active contract, but tickBillGen still bills this room because
          // the blob says occupied + has a tenant. A tenant who stayed past a
          // fixed term (no renewal signed) must keep their SIGNED rate, not
          // jump to the current pricing formula. Pull the most-recent expired
          // contract for the resident tenant and let resolveBillingRent honor
          // its locked rate (tier 1.5). discount_pct + the signed due day
          // continue too. Scoped to the tenant currently in the room so a
          // previous tenant's old contract can't leak into a new
          // (un-contracted) occupant's bill.
          const eq = await pool.query(
            `SELECT id, monthly_rent, discount_pct, status,
                    CASE WHEN locked_at IS NOT NULL
                         THEN (terms_template_snapshot->'financials'->>'dueDay')::numeric
                    END AS contract_due_day
               FROM contracts
               WHERE room_id=$1 AND status='expired' AND deleted_at IS NULL
                 AND ($2::bigint IS NULL OR tenant_id=$2)
               ORDER BY end_date DESC NULLS LAST, start_date DESC LIMIT 1`,
            [room.id, tenantId || null]
          );
          if (eq.rows[0] && Number(eq.rows[0].monthly_rent) > 0) {
            expiredContract = eq.rows[0];
            discountPct = Number(eq.rows[0].discount_pct) || 0;
          }
        }
      } catch { /* legacy deploys without contracts table */ }
      if (billing.contractStartsInPeriod(activeContract, period)) {
        firstMonthSkipped.push({
          roomId: String(room.id || ''),
          tenantId,
          contractId: activeContract.id || null,
        });
        continue;
      }
      // Per-room due date — signed day > building config > 15. Rolled to
      // next month when the day already passed (see billGenDueDateFor).
      const due = billing.resolveBillDueDay({
        contractDueDay: (activeContract || expiredContract)?.contract_due_day,
        configDueDay,
      });
      const dueDate = billGenDueDateFor(now, due);
      // Transactional bill insert + one_off deactivation. Reading
      // recurring INSIDE the tx with FOR UPDATE means an admin editing
      // /deleting a recurring row in another tab waits for our tx to
      // commit — otherwise admin's PUT could land between our SELECT
      // and INSERT, and the tenant got billed for the stale amount
      // while admin thinks their edit took effect. Matches the manual
      // bulk-generate path in routes/bills-extras.js.
      const billClient = await pool.connect();
      let recurring = [];
      let usedOneOffIds = [];
      try {
        await billClient.query('BEGIN');
        if (flags.recurringCharges?.enabled && flags.recurringCharges?.autoIncludeOnBillGen !== false) {
          try {
            const params = [];
            const ors = [];
            if (tenantId) { params.push(tenantId); ors.push(`tenant_id = $${params.length}`); }
            params.push(room.id); ors.push(`room_id = $${params.length}`);
            const rc = await billClient.query(
              `SELECT id, label, amount, frequency, start_at, end_at FROM recurring_charges
                 WHERE active = TRUE AND (${ors.join(' OR ')})
                 FOR UPDATE`,
              params
            );
            // Honor `frequency` (monthly/quarterly/one_off) so quarterly
            // charges only fire every 3 months anchored to start_at. Without
            // this the scheduler kept billing quarterly fees every month.
            const applicable = rc.rows.filter((r) => billing.isChargeApplicableForPeriod(r, period));
            recurring = applicable.map((r) => ({ label: r.label, amount: Number(r.amount) }));
            usedOneOffIds = applicable.filter((r) => r.frequency === 'one_off').map((r) => r.id);
          } catch (rcErr) {
            // table may not exist on older deployments — leave recurring=[]
            if (rcErr.code !== '42P01') throw rcErr;
          }
        }
        const roomForBilling = await meter.attachBillingReadingsForPeriod(billClient, room, period);
        const bill = billing.buildBill({ room: roomForBilling, contract: activeContract, expiredContract, config, features: flags, recurring, period, dueDate, discountPct });
        billing.applyPaymentReferenceCents(bill, { tenantId, maxTotal: promptpay.MAX_AMOUNT });

        // R5 — surface flat-mode silent fallbacks. Recorded per room; the
        // owner alert below fires once at the end of the run with the full
        // list so admins notice when "เหมา" rooms reverted to metered.
        if (bill.waterFlatFellBack || bill.elecFlatFellBack) {
          flatFellBack.push({
            roomId: room.id,
            water: !!bill.waterFlatFellBack,
            elec: !!bill.elecFlatFellBack,
          });
        }

        // R4 — bill_no collision retry: when the same room+period already
        // has a bill for a DIFFERENT tenant (move-out + move-in within the
        // month), the default `INV-period-roomId` clashes. Try the default
        // first to keep historic bill_no shape stable for the common single-
        // tenant case; on collision, retry once with the `-T${tenantId}`
        // suffix which the partial unique `uq_bills_room_period_tenant_active`
        // accommodates.
        let otherItems = Array.isArray(recurring) ? [...recurring] : [];
        if (Number(bill.paymentReferenceCents) > 0) {
          otherItems = billing.appendPaymentReferenceLine(otherItems, bill.paymentReferenceCents);
        }
        const otherJson = JSON.stringify(otherItems);
        const buildInsert = (billNoForInsert) => billClient.query(
          `INSERT INTO bills (bill_no, tenant_id, room_id, period, rent,
              water_prev_reading, water_current_reading, water_units, water_rate, water_amount,
              elec_prev_reading, elec_current_reading, elec_units, elec_rate, elec_amount,
              wifi, other, subtotal, vat, late_fee, total, due_date, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,$21,$22,'pending')
           ON CONFLICT (bill_no) DO NOTHING
           RETURNING id, bill_no`,
          [
            billNoForInsert, tenantId, bill.roomId, bill.period,
            bill.rent,
            bill.waterPrevReading, bill.waterCurrentReading,
            bill.waterUnits, bill.waterRate, bill.waterAmount,
            bill.elecPrevReading, bill.elecCurrentReading,
            bill.elecUnits, bill.elecRate, bill.elecAmount,
            bill.wifi, otherJson, bill.subtotal, bill.vat, bill.lateFee, bill.total,
            bill.dueDate,
          ]
        );

        let ins = await buildInsert(bill.billNo);
        let finalBillNo = bill.billNo;
        // ON CONFLICT (bill_no) DO NOTHING returns rowCount=0 on collision.
        // If we have a tenantId AND the conflict is on bill_no, we can try
        // again with a tenant suffix. Verify the existing bill is actually
        // for a different tenant before retrying — otherwise we'd
        // unnecessarily proliferate suffixed bill_nos for the same logical bill.
        if (ins.rowCount === 0 && tenantId) {
          const probe = await billClient.query(
            `SELECT tenant_id FROM bills
              WHERE bill_no = $1 AND deleted_at IS NULL LIMIT 1`,
            [bill.billNo]
          );
          const existingTenantId = probe.rows[0]?.tenant_id;
          if (existingTenantId != null && Number(existingTenantId) !== Number(tenantId)) {
            const suffixed = billing.makeBillNo(bill.roomId, period, { tenantId });
            ins = await buildInsert(suffixed);
            if (ins.rowCount > 0) {
              finalBillNo = ins.rows[0].bill_no;
            }
          }
        }

        if (ins.rowCount > 0) {
          if (usedOneOffIds.length) {
            await billClient.query(
              `UPDATE recurring_charges SET active=FALSE, updated_at=NOW()
                 WHERE id = ANY($1::bigint[])`,
              [usedOneOffIds]
            );
          }
          await billClient.query('COMMIT');
          made++;
          billsCreated.push({ id: ins.rows[0].id, tenantId, roomId: bill.roomId, billNo: finalBillNo, period, total: bill.total, dueDate: bill.dueDate });
        } else {
          // Real duplicate (same room+period+tenant already has a bill, or
          // bill_no collision with same tenant). one_offs stay active because
          // they weren't billed this run — they'll fire again next cycle.
          await billClient.query('COMMIT');
        }
      } catch (e) {
        await billClient.query('ROLLBACK').catch(() => {});
        // Partial-unique on (room_id, period, COALESCE(tenant_id,0)) blocks
        // duplicates even when bill_no differs across paths; treat as silent skip.
        if (e.code !== '23505') console.error('[scheduler] bill insert failed:', e.message);
      } finally {
        billClient.release();
      }
    }
    state.lastBillPeriod = period;
    writeState(state);
    console.log(`[scheduler] auto-generated ${made} bills for ${period}`);

    // R5 — owner alert for flat-mode silent fallbacks. We do this BEFORE
    // the success notification so the operator's inbox shows the WARNING
    // first (more urgent than "X bills sent"). Once-per-period via state
    // latch so admin who hasn't fixed the missing flat amount doesn't get
    // hourly spam from re-runs (the scheduler's own state.lastBillPeriod
    // guard prevents re-running anyway, but the alert latch is independent
    // so a manual trigger can still surface the warning).
    if (flatFellBack.length > 0) {
      const alertKey = `billGenFlatFellBack_${period}`;
      if (!state[alertKey]) {
        const lines = flatFellBack.map((r) => {
          const parts = [];
          if (r.water) parts.push('น้ำ');
          if (r.elec) parts.push('ไฟ');
          return `  • ห้อง ${r.roomId}: ${parts.join(' + ')} — กลับไปคิดตามมิเตอร์`;
        });
        notifier.notifyOwner({ pool, features: flags }, {
          category: 'billing',
          subject: `⚠️ ${flatFellBack.length} ห้อง: โหมดเหมา (flat) ตั้งไม่ครบ`,
          text: [
            `รอบบิล ${period} — ${flatFellBack.length} ห้องเปิดโหมดเหมาไว้ แต่ไม่ได้ใส่จำนวนเหมา ระบบจึงคิดเงินตามมิเตอร์แทน`,
            ``,
            ...lines,
            ``,
            `วิธีแก้: เปิด /admin#rooms → ห้องที่ระบุข้างต้น → ตั้ง waterFlatAmount / elecFlatAmount ให้ครบก่อนรอบถัดไป`,
            `(หรือเปลี่ยน mode กลับเป็น 'metered' ถ้าตั้งใจคิดตามมิเตอร์อยู่แล้ว)`,
          ].join('\n'),
        }).catch(() => {});
        state[alertKey] = true;
        writeState(state);
      }
    }

    if (firstMonthSkipped.length > 0) {
      const alertKey = `billGenFirstMonthSkipped_${period}`;
      if (!state[alertKey]) {
        const lines = firstMonthSkipped.slice(0, 20).map((r) =>
          `  • ห้อง ${r.roomId}${r.contractId ? ` (สัญญา #${r.contractId})` : ''}`);
        notifier.notifyOwner({ pool, features: flags }, {
          category: 'billing',
          subject: `ข้ามบิลรายเดือนเดือนแรก ${firstMonthSkipped.length} ห้อง`,
          text: [
            `รอบบิล ${period} มี ${firstMonthSkipped.length} ห้องที่สัญญาเริ่มในเดือนนี้`,
            `ระบบไม่ออกบิลรายเดือนซ้ำ เพราะบิลย้ายเข้าและเลขมิเตอร์ตั้งต้นดูแลรอบนี้แล้ว`,
            ``,
            ...lines,
            firstMonthSkipped.length > 20 ? `  ...รวม ${firstMonthSkipped.length} ห้อง` : null,
            ``,
            `บิลรายเดือนปกติจะเริ่มรอบถัดไป ส่วนเดือนนี้ให้ตรวจบิลย้ายเข้าที่ /admin#billing`,
          ].filter(Boolean).join('\n'),
        }).catch(() => {});
        state[alertKey] = true;
        writeState(state);
      }
    }

    if (tenantlessSkipped.length > 0) {
      const alertKey = `billGenTenantlessSkipped_${period}`;
      if (!state[alertKey]) {
        const lines = tenantlessSkipped.slice(0, 20).map((r) =>
          `  • ห้อง ${r.roomId}${r.blobTenantName ? ` (ผังห้องระบุ: ${r.blobTenantName})` : ''}`);
        notifier.notifyOwner({ pool, features: flags }, {
          category: 'billing',
          subject: `⚠️ ข้ามออกบิล ${tenantlessSkipped.length} ห้อง — ไม่พบผู้เช่า active ในระบบ`,
          text: [
            `รอบบิล ${period} — ${tenantlessSkipped.length} ห้องมีผู้เช่าในผังห้อง แต่ไม่พบผู้เช่าสถานะ active ในตารางผู้เช่า`,
            `ระบบจึงไม่ออกบิลให้ห้องเหล่านี้ (ถ้าออก บิลจะไม่มีผู้รับ — ผู้เช่าไม่เห็นในพอร์ทัล/ไม่ได้รับแจ้งเตือน และค่าปรับจะงอกโดยไม่มีคนจ่าย)`,
            ``,
            ...lines,
            tenantlessSkipped.length > 20 ? `  ...รวม ${tenantlessSkipped.length} ห้อง` : null,
            ``,
            `วิธีแก้: เปิด /admin#tenants ตรวจว่าผู้เช่าห้องนี้ check-out ไปแล้วหรือยัง`,
            `  • ถ้าย้ายออกแล้ว → ปลดผู้เช่าออกจากผังห้อง (หรือกด reconcile ที่ /admin#rooms)`,
            `  • ถ้ายังอยู่จริง → สร้าง/แก้ผู้เช่าให้สถานะ active และผูกห้องให้ถูกต้อง แล้วออกบิลรอบนี้ด้วยตนเอง`,
          ].filter(Boolean).join('\n'),
        }).catch(() => {});
        state[alertKey] = true;
        writeState(state);
      }
    }

    if (made > 0) {
      notifier.notifyOwner({ pool, features: flags },
        { category: 'billing', subject: 'ออกบิลอัตโนมัติ', text: `ออกบิลรอบ ${period} จำนวน ${made} ใบ` }
      ).catch(() => {});
      // Notify each tenant about their newly-generated bill so they don't
      // miss the due date. Without this, scheduler bills sit silently in
      // the DB until admin runs bulk-send manually — many tenants only
      // discover the bill when they get an overdue alert. Use the queue
      // (notifQueue) so retries on transient LINE/email failures happen
      // automatically.
      try {
        const notifQueue = require('./notificationQueue');
        const emailReady = email.isConfigured(flags);
        for (const b of billsCreated) {
          if (!b.tenantId) continue;  // orphan bills: nobody to notify
          // Per-bill guard: lastBillPeriod is already latched above and a
          // re-run excludes rowCount=0 duplicates, so one transient lookup
          // failure must not abort the loop — every remaining tenant would
          // silently never get their new-bill push.
          try {
            const tQ = await pool.query(
              `SELECT id, line_user_id, line_oa_id, email FROM tenants
                 WHERE id=$1 AND deleted_at IS NULL AND status='active'`,
              [b.tenantId]
            );
            if (!tQ.rows.length) continue;
            const t = tQ.rows[0];
            const lineRecipients = await notifier.getTenantLineRecipients(pool, {
              id: t.id,
              line_user_id: t.line_user_id,
              line_oa_id: t.line_oa_id,
            });
            const lineBindingCount = lineRecipients.length;
            const subject = `💰 บิลใหม่รอบ ${b.period} — ห้อง ${b.roomId}`;
            const body = [
              `บิลใหม่ออกแล้ว`,
              `เลขที่: ${b.billNo}`,
              `ห้อง: ${b.roomId}`,
              `รอบบิล: ${b.period}`,
              `ยอดรวม: ฿${Number(b.total).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`,
              `ครบกำหนด: ${b.dueDate}`,
              `LINE ที่ผูกกับห้องนี้: ${lineBindingCount} บัญชี`,
              ``,
              `ดูรายละเอียด + ชำระผ่าน QR ที่พอร์ทัล /tenant`,
            ].join('\n');
            for (const recipient of lineRecipients) {
              await notifQueue.enqueue(pool, {
                channel: 'line', recipient: recipient.line_user_id, subject, body,
                payload: { oaId: recipient.line_oa_id || null, billId: b.id },
              }).catch(() => {});
            }
            if (t.email && emailReady) {
              await notifQueue.enqueue(pool, {
                channel: 'email', recipient: t.email, subject, body,
                payload: { billId: b.id },
              }).catch(() => {});
            }
          } catch (err) {
            console.warn(`[scheduler] tenant notify enqueue failed for bill ${b.id}:`, err.message);
          }
        }
      } catch (err) {
        console.warn('[scheduler] tenant notify enqueue failed:', err.message);
      }
    }
  } catch (err) {
    console.error('[scheduler] bill gen failed:', err.message);
    return { error: err.message };
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
  const hourKey = localHourKey(now);  // YYYY-MM-DDTHH (ICT)
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
    return { error: err.message };
  }
}

// Auto-revoke reason — exported so callers (server.js, scheduler ticks)
// agree on which `revoke_reason` value belongs to this subsystem. Manual
// admin revokes use other reason strings, so restores only target our own
// auto-revokes and never undo an admin's deliberate suspension.
const ACCESS_CARD_AUTO_REVOKE_REASON = 'auto:overdue_bill';

// Restore any cards that this subsystem auto-revoked for one tenant, but
// only when the tenant no longer has any bill at least threshold days overdue.
// Used by tickAccessControlSync (bulk daily pass) AND by the payment
// verify path in server.js so the card un-blocks the SAME MINUTE the
// tenant pays — instead of forcing them to wait up to 24 hours for the
// next cron tick. Returns { restoredCount, restoredCardIds, tenant }.
async function restoreAccessCardsForTenantIfClear(pool, tenantId, { threshold = 30, notifier: _notifier, flags, audit } = {}) {
  const tenantIdNum = Number(tenantId);
  if (!Number.isInteger(tenantIdNum) || tenantIdNum < 1) {
    return { restoredCount: 0, restoredCardIds: [] };
  }
  try {
    const rawThreshold = Number(threshold);
    const safeThreshold = Number.isFinite(rawThreshold)
      ? Math.max(1, Math.min(365, Math.trunc(rawThreshold)))
      : 30;
    const restore = await pool.query(`
      UPDATE access_cards SET status='active', revoked_at=NULL, revoke_reason=NULL
        WHERE status='revoked' AND revoke_reason=$1
          AND tenant_id = $2
          AND NOT EXISTS (
            SELECT 1 FROM bills b
              WHERE b.tenant_id = access_cards.tenant_id
                AND b.status='overdue'
                AND b.due_date <= CURRENT_DATE - ($3::int * INTERVAL '1 day')
                AND b.paid_at IS NULL
                AND b.deleted_at IS NULL
          )
        RETURNING id, card_id
    `, [ACCESS_CARD_AUTO_REVOKE_REASON, tenantIdNum, safeThreshold]);
    if (restore.rowCount === 0) {
      return { restoredCount: 0, restoredCardIds: [] };
    }
    // Audit each card individually so a /admin#access-events search shows
    // exactly which physical card was reinstated, by whom, and why.
    if (audit && typeof audit === 'function') {
      for (const r of restore.rows) {
        try {
          await audit({
            actor: 'system:payment-clear',
            action: 'access_card.restore',
            entity: 'access_card',
            entityId: String(r.id),
            details: { card_id: r.card_id, tenant_id: tenantIdNum, trigger: 'bill-paid' },
          });
        } catch { /* audit is best-effort */ }
      }
    }
    // Look up the tenant for the notify message.
    let tenantRow = null;
    try {
      const t = await pool.query(
        `SELECT id, full_name, phone, email, line_user_id, line_oa_id, status
           FROM tenants WHERE id=$1 AND deleted_at IS NULL AND status='active'`,
        [tenantIdNum]
      );
      tenantRow = t.rows[0] || null;
    } catch { /* fall through */ }
    if (tenantRow && _notifier && typeof _notifier.notifyTenant === 'function') {
      _notifier.notifyTenant({ pool, features: flags || {} }, tenantRow, {
        subject: '🔓 บัตรเข้า-ออกกลับมาใช้ได้แล้ว',
        text: [
          `เรียน คุณ${tenantRow.full_name}`,
          '',
          `🎉 ระบบเปิดบัตรเข้า-ออกของคุณให้แล้ว — ขอบคุณที่ชำระบิลค้างเรียบร้อย`,
          '',
          `จำนวนบัตรที่กลับมาใช้ได้: ${restore.rowCount} ใบ`,
        ].join('\n'),
      }).catch((err) => console.warn('[access-restore] notify failed:', err.message));
    }
    return {
      restoredCount: restore.rowCount,
      restoredCardIds: restore.rows.map((r) => r.card_id),
      tenant: tenantRow,
    };
  } catch (err) {
    console.warn(`[access-restore] failed for tenant ${tenantIdNum}:`, err.message);
    return { restoredCount: 0, restoredCardIds: [], error: err.message };
  }
}

// B2 — access control: revoke cards for tenants with overdue bills past
// the configured grace window. Re-activate when their bills clear.
async function tickAccessControlSync(pool, flags, now, state) {
  if (!flags.accessControl || !flags.accessControl.enabled) return;
  if (!flags.accessControl.requirePaymentForCard) return;
  const todayKey = localDateKey(now);
  if (state.lastAccessSync === todayKey) return;
  // Revoke active cards belonging to tenants whose oldest unpaid bill is
  // at least `accessControl.overdueDaysThreshold` days past due. Bound
  // the threshold to a sane range (1-365) so a misconfigured value can't
  // either revoke same-day or never trigger.
  const REVOKE_REASON = ACCESS_CARD_AUTO_REVOKE_REASON;
  const rawThreshold = Number(flags.accessControl?.overdueDaysThreshold);
  const threshold = Number.isFinite(rawThreshold)
    ? Math.max(1, Math.min(365, Math.trunc(rawThreshold)))
    : 30;
  try {
    // Find tenants with overdue bills at least threshold days late. We pass threshold
    // as a parameter so it can't smuggle SQL even if the feature flag was
    // tampered with.
    const overdue = await pool.query(`
      SELECT DISTINCT tenant_id FROM bills
        WHERE status='overdue'
          AND tenant_id IS NOT NULL
          AND deleted_at IS NULL
          AND due_date <= CURRENT_DATE - ($1::int * INTERVAL '1 day')
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
    // overdue bill at least threshold days late. Only undo our own auto-revokes (manual
    // revokes stay revoked — admin made that call deliberately).
    const restore = await pool.query(`
      UPDATE access_cards SET status='active', revoked_at=NULL, revoke_reason=NULL
        WHERE status='revoked' AND revoke_reason=$1
          AND tenant_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM bills b
              WHERE b.tenant_id = access_cards.tenant_id
                AND b.status='overdue'
                AND b.due_date <= CURRENT_DATE - ($2::int * INTERVAL '1 day')
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
      // Audit log so /admin#access-events has a queryable trail of
      // automatic revoke/restore actions. Previously the only signal was
      // the console log + the access_cards row's revoked_at/revoke_reason
      // — admins couldn't search "what did the cron do on 2026-05-12?"
      // without grepping Railway logs.
      try {
        // Table is `audit_logs` (plural) with columns (user_id, action,
        // entity_type, entity_id, detail) — see db/migrate.js:65. The first
        // version of this insert used singular `audit_log` with renamed
        // columns (actor / entity / details), so it silently failed with
        // 42P01 "relation does not exist". Caught by the err.code check
        // below, but the audit trail stayed empty.
        await pool.query(
          `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail)
           VALUES ('system:overdue-cron', 'access_card.bulk_sync', 'access_card', $1, $2::jsonb)`,
          [
            todayKey,
            JSON.stringify({
              revoked,
              restored,
              threshold,
              revokedTenantIds: [...revokedTenants],
              restoredTenantIds: [...restoredTenants],
            }),
          ]
        );
      } catch (err) {
        if (err.code !== '42P01' && err.code !== '42703') {
          console.warn('[scheduler] access-sync audit insert failed:', err.message);
        }
      }
      // Stash today's action set in state so tickOverdueDigest (which
      // runs in the same cycle but in a separate advisory lock) can mention
      // the auto-revokes in the owner's daily digest. Without this the
      // owner only saw the overdue bill list — not which tenants got
      // their cards cut.
      state.todaysAccessSync = {
        date: todayKey,
        revokedCount: revoked,
        restoredCount: restored,
      };
      writeState(state);
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
          // For the revoke message, pull the tenant's full list of unpaid
          // bills so the message can ENUMERATE what's owed instead of just
          // saying "you have overdue bills". A separate "today's bill is
          // overdue" alert from tickLateFee would otherwise feel duplicate
          // and disconnected — listing here gives one consolidated picture.
          let billsBlock = '';
          let totalOwed = 0;
          if (isRevoked) {
            try {
              const ob = await pool.query(
                `SELECT bill_no, period, total, due_date,
                        (CURRENT_DATE - due_date)::int AS days_late
                   FROM bills
                  WHERE tenant_id=$1 AND status='overdue' AND deleted_at IS NULL
                  ORDER BY due_date ASC
                  LIMIT 10`,
                [t.id]
              );
              if (ob.rows.length) {
                billsBlock = '\n📋 บิลที่ค้างทั้งหมดของคุณ:\n';
                for (const b of ob.rows) {
                  const amt = Number(b.total).toLocaleString('th-TH', { minimumFractionDigits: 2 });
                  totalOwed += Number(b.total) || 0;
                  billsBlock += `   • ${b.bill_no || '-'} (รอบ ${b.period || '-'}) — ฿${amt} · ค้าง ${b.days_late} วัน\n`;
                }
                billsBlock += `\n💰 ยอดค้างรวม: ฿${totalOwed.toLocaleString('th-TH', { minimumFractionDigits: 2 })}\n`;
              }
            } catch { /* listing is best-effort */ }
          }
          const subject = isRevoked
            ? '🔒 บัตรเข้า-ออกถูกระงับ — ค้างชำระค่าเช่า'
            : '🔓 บัตรเข้า-ออกกลับมาใช้ได้แล้ว';
          const body = isRevoked
            ? [
              `เรียน คุณ${t.full_name}`,
              '',
              `ระบบได้ระงับบัตรเข้า-ออกของคุณชั่วคราว เนื่องจากมีบิลค้างชำระครบ ${threshold} วันขึ้นไป`,
              billsBlock,
              `📋 วิธีแก้:`,
              `   1) ชำระบิลค้างทั้งหมดผ่านพอร์ทัลผู้เช่า /tenant`,
              `   2) เมื่อยืนยันการชำระเรียบร้อย ระบบจะเปิดใช้บัตรให้ทันที`,
              `      (ไม่ต้องรอ — ทันทีที่สลิปผ่านการตรวจสอบ)`,
              '',
              `หากมีปัญหาติดต่อสำนักงาน`,
            ].filter(Boolean).join('\n')
            : [
              `เรียน คุณ${t.full_name}`,
              '',
              `🎉 บัตรเข้า-ออกของคุณกลับมาใช้ได้แล้ว`,
              `ขอบคุณที่ชำระบิลค้าง — ระบบยืนยันแล้วว่าไม่มีบิลค้างเกินกำหนด`,
            ].join('\n');
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
    // Pre-suspension warning — tenants whose oldest overdue bill crosses the
    // threshold TOMORROW get one heads-up today, so the card stopping is
    // never the first signal they receive. due_date equality gives a one-day
    // window; the audit-row NOT EXISTS makes it idempotent across replicas
    // (each replica keeps a private state file, so a latch alone can't
    // dedupe). threshold=1 has no "tomorrow" — skip.
    if (threshold > 1) {
      try {
        const warnQ = await pool.query(
          `SELECT DISTINCT t.id, t.full_name, t.phone, t.email,
                  t.line_user_id, t.line_oa_id, t.status
             FROM bills b
             JOIN tenants t ON t.id = b.tenant_id
            WHERE b.status='overdue' AND b.deleted_at IS NULL AND b.paid_at IS NULL
              AND b.due_date = CURRENT_DATE - ($1::int - 1)
              AND t.deleted_at IS NULL AND t.status='active'
              AND EXISTS (
                SELECT 1 FROM access_cards ac
                 WHERE ac.tenant_id = t.id AND ac.status='active'
              )
              AND NOT EXISTS (
                SELECT 1 FROM audit_logs al
                 WHERE al.action='access_card.suspension_warned'
                   AND al.entity_type='tenant'
                   AND al.entity_id = t.id::text
                   AND al.created_at > NOW() - INTERVAL '3 days'
              )`,
          [threshold]
        );
        for (const t of warnQ.rows) {
          try {
            await pool.query(
              `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail)
               VALUES ('system:overdue-cron', 'access_card.suspension_warned', 'tenant', $1, $2::jsonb)`,
              [String(t.id), JSON.stringify({ threshold, date: todayKey })]
            );
          } catch (err) {
            if (err.code === '42P01' || err.code === '42703') break;
            throw err;
          }
          notifier.notifyTenant({ pool, features: flags || {} }, t, {
            subject: '⚠️ บัตรเข้า-ออกจะถูกระงับพรุ่งนี้ — มีบิลค้างชำระ',
            text: [
              `เรียน คุณ${t.full_name}`,
              '',
              `คุณมีบิลค้างชำระใกล้ครบ ${threshold} วัน`,
              'หากยังไม่ชำระภายในวันนี้ ระบบจะระงับบัตรเข้า-ออกของคุณอัตโนมัติในวันพรุ่งนี้',
              '',
              '📋 ทางแก้ (ทำได้ทันที):',
              '   1) ชำระบิลค้างและส่งสลิปที่พอร์ทัลผู้เช่า /tenant',
              '   2) เมื่อการชำระผ่านการตรวจสอบ บัตรจะไม่ถูกระงับ',
              '',
              'หากชำระแล้วหรือมีข้อสงสัย ติดต่อสำนักงานก่อนสิ้นวันนี้',
            ].join('\n'),
          }).catch((err) => {
            console.warn('[scheduler] suspension pre-warn notify failed:', err.message);
          });
        }
      } catch (err) {
        console.warn('[scheduler] suspension pre-warn failed:', err.message);
      }
    }
  } catch (err) {
    console.error('[scheduler] access sync failed:', err.message);
    return { error: err.message };
  }
}

// === Contract-fill invitation expiry warning ===============================
// A pending invitation that quietly expires strands both sides: the tenant's
// link dies mid-fill and the admin keeps waiting for a submission that can
// never arrive. Within 24h of expiry, nudge the tenant (finish now / ask for
// a fresh link — the raw URL can't be re-sent, only its hash is stored) and
// give the owner a consolidated list with the resend instruction. The
// audit-row NOT EXISTS keeps it to one warning per invitation and makes the
// hourly tick idempotent across replicas.
async function tickInvitationExpiryWarn(pool, flags, now, state) {
  let rows;
  try {
    const q = await pool.query(
      `SELECT ci.id, ci.expires_at, c.contract_no, c.room_id,
              t.id AS tenant_id, t.full_name, t.phone, t.email,
              t.line_user_id, t.line_oa_id, t.status AS tenant_status
         FROM contract_invitations ci
         JOIN contracts c ON c.id = ci.contract_id
         LEFT JOIN tenants t ON t.id = ci.tenant_id AND t.deleted_at IS NULL
        WHERE ci.status='pending'
          AND ci.expires_at > NOW()
          AND ci.expires_at <= NOW() + INTERVAL '24 hours'
          AND NOT EXISTS (
            SELECT 1 FROM audit_logs al
             WHERE al.action='contract.invitation_expiry_warned'
               AND al.entity_type='contract_invitation'
               AND al.entity_id = ci.id::text
          )
        ORDER BY ci.expires_at ASC
        LIMIT 50`
    );
    rows = q.rows;
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') return;  // legacy deploy
    return { error: err.message };
  }
  if (!rows.length) return;
  const fmtExpiry = (v) => {
    try {
      return new Date(v).toLocaleString('th-TH', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok',
      });
    } catch { return String(v); }
  };
  const ownerLines = [];
  for (const r of rows) {
    try {
      await pool.query(
        `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail)
         VALUES ('system:scheduler', 'contract.invitation_expiry_warned', 'contract_invitation', $1, $2::jsonb)`,
        [String(r.id), JSON.stringify({
          contractNo: r.contract_no, tenantId: r.tenant_id,
          expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
        })]
      );
    } catch (err) {
      console.warn('[scheduler] invitation warn audit failed:', err.message);
      continue;  // no dedup marker written — skip the send, retry next hour
    }
    ownerLines.push(`  • ${r.contract_no || '-'} (ห้อง ${r.room_id || '-'}) `
      + `${r.full_name || '-'} — หมดอายุ ${fmtExpiry(r.expires_at)}`);
    if (r.tenant_id) {
      // force: the invited person is exactly who this message is for, even
      // if their tenant row hasn't flipped to active yet.
      notifier.notifyTenant({ pool, features: flags || {} }, {
        id: r.tenant_id, full_name: r.full_name, phone: r.phone, email: r.email,
        line_user_id: r.line_user_id, line_oa_id: r.line_oa_id, status: 'active',
      }, {
        subject: '⏳ ลิงก์กรอกสัญญาใกล้หมดอายุ',
        text: [
          `เรียน คุณ${r.full_name || ''}`,
          '',
          `ลิงก์กรอกสัญญาเช่า${r.room_id ? ` (ห้อง ${r.room_id})` : ''} ของคุณ`,
          `จะหมดอายุ ${fmtExpiry(r.expires_at)}`,
          '',
          '📋 สิ่งที่ต้องทำ:',
          '   1) เปิดลิงก์ที่ได้รับ กรอกให้ครบ แล้วกด "ส่งให้ตรวจสอบ" ก่อนเวลาดังกล่าว',
          '   2) ถ้าหาลิงก์ไม่เจอหรือลิงก์ใช้ไม่ได้ ติดต่อสำนักงานเพื่อขอลิงก์ใหม่ได้ทันที',
        ].join('\n'),
        force: true,
      }).catch((err) => {
        console.warn('[scheduler] invitation warn tenant notify failed:', err.message);
      });
    }
  }
  if (ownerLines.length) {
    try {
      await notifier.notifyOwner({ pool, features: flags || {} }, {
        category: 'tenancy',
        subject: `⏳ ลิงก์กรอกสัญญาใกล้หมดอายุ ${ownerLines.length} รายการ`,
        text: [
          'ลิงก์ต่อไปนี้จะหมดอายุภายใน 24 ชั่วโมง และผู้เช่ายังไม่ได้ส่งข้อมูล:',
          ...ownerLines,
          '',
          '👉 ที่ต้องทำ: ถ้าผู้เช่ายังต้องการกรอก กด "สร้างลิงก์ใหม่" ที่หน้าสัญญา',
          '(ลิงก์เก่าจะถูกยกเลิกอัตโนมัติ) — ระบบเตือนผู้เช่าให้แล้วทางช่องทางที่ผูกไว้',
        ].join('\n'),
      });
    } catch (err) {
      console.warn('[scheduler] invitation warn owner notify failed:', err.message);
    }
  }
}

// === Stale booking auto-cancel =============================================
// Bookings the flow forgot: pending/reviewing requests nobody decided on, and
// approved bookings whose contract never got created. Both keep a room
// 'reserved' forever without this tick. Thresholds come from
// config.notify.bookingStaleDays (pending/reviewing, default 14) and
// config.notify.bookingApprovedStaleDays (approved, default 30); 0 disables
// that class. The cancel cascade mirrors PUT /api/bookings/:id → 'cancelled':
// release the room only when reservedBy still points at this booking, move
// the pre-contract mirrored tenant out only when no active contract exists,
// then revoke leftover LINE binding codes and notify booker + owner. An
// approved booking whose room already carries an active contract for the
// same phone is flipped to 'completed' instead — the work was done, only the
// status linkage was missed.
async function tickBookingStale(pool, flags, now, state) {
  const todayKey = localDateKey(now);
  if (state.lastBookingStaleAt === todayKey) return;
  let staleDays = 14;
  let approvedStaleDays = 30;
  try {
    const { rows } = await pool.query(
      `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
    );
    const n = (rows[0] && rows[0].value && rows[0].value.notify) || {};
    if (n.bookingStaleDays != null && Number.isFinite(Number(n.bookingStaleDays))) {
      staleDays = Math.max(0, Math.min(365, Math.trunc(Number(n.bookingStaleDays))));
    }
    if (n.bookingApprovedStaleDays != null && Number.isFinite(Number(n.bookingApprovedStaleDays))) {
      approvedStaleDays = Math.max(0, Math.min(365, Math.trunc(Number(n.bookingApprovedStaleDays))));
    }
  } catch { /* config missing — keep defaults */ }
  if (staleDays === 0 && approvedStaleDays === 0) {
    state.lastBookingStaleAt = todayKey;
    writeState(state);
    return;
  }

  const cancelledOut = [];
  const completedOut = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bRes = await client.query(
      `SELECT value FROM app_data WHERE key='baankarn_bookings_v1' FOR UPDATE`
    );
    const list = bRes.rows.length && Array.isArray(bRes.rows[0].value) ? bRes.rows[0].value : [];
    if (!list.length) {
      await client.query('ROLLBACK');
      state.lastBookingStaleAt = todayKey;
      writeState(state);
      return;
    }
    const rRes = await client.query(
      `SELECT value FROM app_data WHERE key='baankarn_rooms_v1' FOR UPDATE`
    );
    const rooms = rRes.rows.length && rRes.rows[0].value && typeof rRes.rows[0].value === 'object'
      ? rRes.rows[0].value : {};
    const nowMs = now.getTime();
    const ageDays = (iso) => {
      const t = Date.parse(iso || '');
      return Number.isFinite(t) ? (nowMs - t) / 86_400_000 : null;
    };
    let roomsDirty = false;
    for (const b of list) {
      if (!b || typeof b !== 'object') continue;
      const status = String(b.status || '');
      let limit = null;
      let baseTs = null;
      if ((status === 'pending' || status === 'reviewing') && staleDays > 0) {
        limit = staleDays;
        baseTs = b.createdAt;
      } else if (status === 'approved' && approvedStaleDays > 0) {
        limit = approvedStaleDays;
        baseTs = b.approvedAt || b.updatedAt || b.createdAt;
      } else {
        continue;
      }
      const age = ageDays(baseTs);
      if (age == null || age < limit) continue;

      const beforeStatus = status;
      const roomId = String(b.assignedRoomId || b.roomId || '') || null;
      const bookingPhone = String(b.phone || '').replace(/[\s-]/g, '').slice(0, 32);

      // Approved booking whose room already has an active contract for the
      // same phone → the contract flow happened, only the booking status
      // linkage was missed. Close the loop as 'completed', release nothing.
      if (beforeStatus === 'approved' && roomId) {
        try {
          const cQ = await client.query(
            `SELECT c.id FROM contracts c
               JOIN tenants t ON t.id = c.tenant_id
              WHERE c.room_id=$1 AND c.status='active' AND c.deleted_at IS NULL
                AND t.deleted_at IS NULL
                AND ($2::text = '' OR replace(replace(COALESCE(t.phone,''),' ',''),'-','') = $2)
              LIMIT 1`,
            [roomId, bookingPhone]
          );
          if (cQ.rows.length) {
            b.status = 'completed';
            b.updatedAt = new Date(nowMs).toISOString();
            b.updatedBy = 'system:booking-stale';
            b.adminNotes = [
              b.adminNotes || null,
              '[auto] พบสัญญา active ของห้องนี้แล้ว — ปิดงานจองเป็น completed',
            ].filter(Boolean).join('\n').slice(0, 2000);
            completedOut.push({ id: b.id, name: b.name || '-', roomId, contractId: cQ.rows[0].id });
            continue;
          }
        } catch (err) {
          if (err.code !== '42P01') throw err;
        }
      }

      let releasedRoomId = null;
      let releasedTenant = null;
      const room = roomId ? rooms[roomId] : null;
      if (room && room.status === 'reserved' && room.reservedBy === b.id) {
        // Pre-contract tenant cleanup — same guards as the PUT cancel path:
        // match by phone+name and never touch a tenant who already has an
        // active contract on this room.
        const bookingName = String(b.name || '').trim().slice(0, 200);
        if (bookingPhone || bookingName) {
          const clauses = [`current_room_id=$1`, `status='active'`, `deleted_at IS NULL`];
          const params = [roomId];
          if (bookingPhone) { params.push(bookingPhone); clauses.push(`phone=$${params.length}`); }
          if (bookingName) { params.push(bookingName); clauses.push(`lower(full_name)=lower($${params.length})`); }
          try {
            const tFind = await client.query(
              `SELECT id, full_name, phone FROM tenants
                WHERE ${clauses.join(' AND ')}
                ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
              params
            );
            const tenantRow = tFind.rows[0] || null;
            if (tenantRow) {
              const activeContract = await client.query(
                `SELECT id FROM contracts
                  WHERE tenant_id=$1 AND room_id=$2 AND status='active' AND deleted_at IS NULL
                  LIMIT 1`,
                [tenantRow.id, roomId]
              ).catch((err) => {
                if (err.code === '42P01') return { rows: [] };
                throw err;
              });
              if (!activeContract.rows.length) {
                const tUpd = await client.query(
                  `UPDATE tenants
                      SET status='moved_out', current_room_id=NULL, updated_at=NOW(),
                          notes=trim(BOTH E'\n' FROM COALESCE(notes || E'\n', '') || $2)
                    WHERE id=$1 AND status='active'
                    RETURNING id, full_name, phone`,
                  [tenantRow.id,
                    `[auto] booking ${b.id} stale-cancelled: released pre-contract reservation ${roomId}`]
                );
                if (tUpd.rows.length) {
                  releasedTenant = { id: tUpd.rows[0].id, fullName: tUpd.rows[0].full_name };
                }
              }
            }
          } catch (err) {
            if (err.code !== '42P01') throw err;
          }
        }
        const { tenant, reservedBy, reservedAt, ...rest } = room;
        rooms[roomId] = { ...rest, status: 'vacant' };
        roomsDirty = true;
        releasedRoomId = roomId;
        try {
          await client.query(
            `UPDATE rooms_v2 SET status='vacant', updated_at=NOW()
              WHERE room_code=$1 AND status='reserved' AND deleted_at IS NULL`,
            [roomId]
          );
        } catch (err) {
          if (err.code !== '42P01') throw err;
        }
      }
      b.status = 'cancelled';
      b.updatedAt = new Date(nowMs).toISOString();
      b.updatedBy = 'system:booking-stale';
      b.adminNotes = [
        b.adminNotes || null,
        `[auto] ยกเลิกอัตโนมัติ: ค้างสถานะ "${beforeStatus}" เกิน ${limit} วัน`,
      ].filter(Boolean).join('\n').slice(0, 2000);
      cancelledOut.push({
        id: b.id, name: b.name || '-', phone: b.phone || null, email: b.email || null,
        beforeStatus, limit, releasedRoomId, releasedTenant, roomId,
      });
      if (cancelledOut.length >= 25) break;  // bound the daily batch
    }
    if (!cancelledOut.length && !completedOut.length) {
      await client.query('ROLLBACK');
      state.lastBookingStaleAt = todayKey;
      writeState(state);
      return;
    }
    await client.query(
      `INSERT INTO app_data (key, value, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW(), updated_by=EXCLUDED.updated_by`,
      ['baankarn_bookings_v1', JSON.stringify(list), 'system:booking-stale']
    );
    if (roomsDirty) {
      await client.query(
        `INSERT INTO app_data (key, value, updated_by) VALUES ($1, $2, $3)
           ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW(), updated_by=EXCLUDED.updated_by`,
        ['baankarn_rooms_v1', JSON.stringify(rooms), 'system:booking-stale']
      );
    }
    for (const c of cancelledOut) {
      try {
        await client.query(
          `UPDATE bookings SET status='cancelled', updated_at=NOW() WHERE external_id=$1`,
          [c.id]
        );
      } catch (err) {
        console.warn('[scheduler] booking-stale relational sync skipped:', err.message);
      }
    }
    for (const c of completedOut) {
      try {
        await client.query(
          `UPDATE bookings SET status='completed', updated_at=NOW() WHERE external_id=$1`,
          [c.id]
        );
      } catch (err) {
        console.warn('[scheduler] booking-stale relational sync skipped:', err.message);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[scheduler] booking stale failed:', err.message);
    return { error: err.message };
  } finally {
    client.release();
  }

  state.lastBookingStaleAt = todayKey;
  writeState(state);

  // Post-commit: LINE binding cleanup + audit + notifications. Best-effort,
  // mirroring the PUT cancel path's after-commit section.
  let lineBindingMod = null;
  try { lineBindingMod = require('./lineBinding'); } catch { /* optional */ }
  const ownerLines = [];
  for (const c of completedOut) {
    try {
      await pool.query(
        `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail)
         VALUES ('system:booking-stale', 'booking.stale_complete', 'booking', $1, $2::jsonb)`,
        [String(c.id), JSON.stringify({ roomId: c.roomId, contractId: c.contractId })]
      );
    } catch (err) {
      if (err.code !== '42P01' && err.code !== '42703') {
        console.warn('[scheduler] booking-stale audit failed:', err.message);
      }
    }
    ownerLines.push(`  • ${c.id} ${c.name} — มีสัญญาแล้ว ปิดเป็น completed (ห้อง ${c.roomId || '-'})`);
  }
  for (const c of cancelledOut) {
    if (lineBindingMod) {
      try { await lineBindingMod.revokeBookingBindings(pool, { bookingId: c.id }); }
      catch (err) { console.warn('[scheduler] booking-stale binding revoke failed:', err.message); }
    }
    try {
      await pool.query(
        `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail)
         VALUES ('system:booking-stale', 'booking.stale_cancel', 'booking', $1, $2::jsonb)`,
        [String(c.id), JSON.stringify({
          from: c.beforeStatus, to: 'cancelled', staleLimitDays: c.limit,
          releasedRoomId: c.releasedRoomId,
          releasedTenantId: c.releasedTenant ? c.releasedTenant.id : null,
        })]
      );
    } catch (err) {
      if (err.code !== '42P01' && err.code !== '42703') {
        console.warn('[scheduler] booking-stale audit failed:', err.message);
      }
    }
    // Booker notification — the booking's own LINE bindings first; the
    // notifier falls back to email/SMS from the same info object.
    try {
      const tenantInfo = {
        full_name: c.name, email: c.email, phone: c.phone,
        line_user_id: null, line_oa_id: null, lineRecipients: [],
        status: 'active',
      };
      if (lineBindingMod) {
        try { tenantInfo.lineRecipients = await lineBindingMod.listBookingRecipients(pool, c.id); }
        catch { /* no binding — email/SMS path still works */ }
      }
      if (tenantInfo.lineRecipients.length || tenantInfo.email || tenantInfo.phone) {
        await notifier.notifyTenant({ pool, features: flags || {} }, tenantInfo, {
          subject: 'การจองถูกยกเลิกอัตโนมัติ',
          text: [
            `🚫 การจอง${c.roomId ? ` ห้อง ${c.roomId}` : ''}ของคุณถูกยกเลิกอัตโนมัติ`,
            `เหตุผล: ไม่มีการดำเนินการต่อภายใน ${c.limit} วัน`,
            '',
            'หากยังต้องการเช่าห้อง สามารถจองใหม่ได้ที่หน้าจองห้อง หรือติดต่อสำนักงานได้ทันที',
          ].join('\n'),
        });
      }
    } catch (err) {
      console.warn('[scheduler] booking-stale booker notify failed:', err.message);
    }
    ownerLines.push(`  • ${c.id} ${c.name} (${c.phone || '-'}) — ค้าง "${c.beforeStatus}" เกิน ${c.limit} วัน`
      + (c.releasedRoomId ? ` · ปล่อยห้อง ${c.releasedRoomId} แล้ว` : ''));
  }
  if (ownerLines.length) {
    try {
      await notifier.notifyOwner({ pool, features: flags || {} }, {
        category: 'booking',
        subject: `🧹 จัดการการจองค้างอัตโนมัติ ${ownerLines.length} รายการ`,
        text: [
          'การจองต่อไปนี้ค้างเกินกำหนดและถูกจัดการอัตโนมัติ:',
          ...ownerLines,
          '',
          `เกณฑ์: pending/reviewing > ${staleDays || '-'} วัน · approved (ยังไม่มีสัญญา) > ${approvedStaleDays || '-'} วัน`,
          'ปรับเกณฑ์ได้ที่ตั้งค่า notify.bookingStaleDays / notify.bookingApprovedStaleDays (0 = ปิด)',
          'ระบบแจ้งผู้จองที่ถูกยกเลิกให้แล้วทางช่องทางที่ติดต่อได้',
        ].join('\n'),
      });
    } catch (err) {
      console.warn('[scheduler] booking-stale owner notify failed:', err.message);
    }
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
  const todayKey = localDateKey(now);
  if (state.lastContractExpiryAt === todayKey) return;
  try {
    // (1) auto-expire — single statement, idempotent. RETURNING the tenant
    // info too so we can fire one notify per expired contract telling the
    // tenant their contract has officially ended (without this they only
    // learned indirectly when their card stopped working / next bill failed).
    // Stamp the closed_* audit fields too — the manual close path (PUT
    // /api/contracts/:id) records who/when/why, and without the matching
    // stamps here reports can't tell "admin ended early" from "auto-expired
    // on schedule". closed_at uses COALESCE so a contract that somehow
    // already carries a close stamp keeps the original one. Soft-deleted
    // contracts are excluded — they're historical rows, not live tenancies.
    const expired = await pool.query(
      `UPDATE contracts c SET status='expired',
              closed_at = COALESCE(c.closed_at, NOW()),
              closed_by = COALESCE(c.closed_by, 'system:scheduler'),
              closed_reason = COALESCE(c.closed_reason, 'สัญญาครบกำหนด end_date — ระบบเปลี่ยนสถานะอัตโนมัติ'),
              closed_type = COALESCE(c.closed_type, 'auto_expire'),
              updated_at = NOW()
         FROM tenants t
        WHERE c.tenant_id = t.id
          AND c.status='active' AND c.end_date IS NOT NULL AND c.end_date < CURRENT_DATE
          AND c.deleted_at IS NULL
       RETURNING c.id, c.contract_no, c.end_date, c.room_id,
                 t.id AS tenant_id, t.full_name, t.phone, t.email,
                 t.line_user_id, t.line_oa_id, t.status AS tenant_status, t.deleted_at`
    );
    if (expired.rowCount > 0) {
      console.log(`[scheduler] auto-expired ${expired.rowCount} contract(s) past end_date`);
    }

    // (2) upcoming expiries — anything ending within the operator-configured
    // window (config.notify.contractEndDays, default 30, clamped 1-365) that's
    // still active. Previously hardcoded to 30, so the Settings field did
    // nothing. Send ONE consolidated message to the owner so we don't spam them
    // when 5 contracts end in the same week.
    let expiryWindowDays = 30;
    try {
      const { rows: cfgRows } = await pool.query(
        `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
      );
      const v = Number(cfgRows[0] && cfgRows[0].value && cfgRows[0].value.notify
        && cfgRows[0].value.notify.contractEndDays);
      if (Number.isFinite(v) && v >= 1 && v <= 365) expiryWindowDays = Math.floor(v);
    } catch { /* config missing — keep default 30 */ }
    const { rows: upcoming } = await pool.query(
      `SELECT c.id, c.contract_no, c.end_date, c.room_id,
              t.id AS tenant_id, t.full_name, t.phone, t.email, t.line_user_id, t.line_oa_id,
              t.status AS tenant_status, t.deleted_at,
              (c.end_date - CURRENT_DATE) AS days_left
         FROM contracts c
         LEFT JOIN tenants t ON t.id = c.tenant_id
        WHERE c.status='active'
          AND c.end_date IS NOT NULL
          AND c.end_date >= CURRENT_DATE
          AND c.end_date <  CURRENT_DATE + make_interval(days => $1)
        ORDER BY c.end_date ASC`,
      [expiryWindowDays]
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
          category: 'tenancy',
          subject: '📋 รายงานสัญญา (รายวัน)',
          text: lines.join('\n'),
        });
      } catch (err) {
        console.warn('[scheduler] contract notify owner failed:', err.message);
      }
    }

    // (3) Tenant-side notifications — admin-only alerts let active tenants
    // walk into a "your contract just expired" surprise. Send each tenant
    // (a) early warnings at fixed thresholds (30/14/7/1 days), deduped per
    //     state.lastContractTenantNotify[<id>] = `<threshold>:<period>` so
    //     we don't repeat the same threshold-message from yesterday/today.
    // (b) a one-time "ended" notice when their contract just flipped expired.
    //
    // Skip inactive/deleted tenants — they shouldn't keep getting messages
    // (notifier.notifyTenant already enforces this, but cheaper to short-
    // circuit here than to fan out then bail).
    if (!state.lastContractTenantNotify || typeof state.lastContractTenantNotify !== 'object') {
      state.lastContractTenantNotify = {};
    }
    // Dedup is keyed by contract_no (globally unique), NOT tenant_id: a tenant
    // with two contracts in the result set (a renewal where the old contract
    // just expired AND the new one is approaching its threshold, or a tenant in
    // two rooms) would otherwise overwrite each other's slot under a single
    // tenant_id key and ping-pong repeat notifications every tick.

    // Recently-expired: one final "ended" message per contract.
    for (const c of expired.rows) {
      if (!c.tenant_id) continue;
      if (c.tenant_status !== 'active' || c.deleted_at) continue;
      const key = `expired:${c.contract_no}`;
      if (state.lastContractTenantNotify[c.contract_no] === key) continue;
      try {
        await notifier.notifyTenant({ pool, features: _flags || {} }, {
          id: c.tenant_id, full_name: c.full_name, phone: c.phone, email: c.email,
          line_user_id: c.line_user_id, line_oa_id: c.line_oa_id, status: c.tenant_status,
        }, {
          subject: '📄 สัญญาเช่าสิ้นสุดแล้ว',
          text: `เรียน คุณ${c.full_name}\n\n`
            + `สัญญาเช่า ${c.contract_no} (ห้อง ${c.room_id || '-'}) สิ้นสุดเมื่อ ${c.end_date}\n\n`
            + `กรุณาติดต่อสำนักงานเพื่อต่อสัญญาหรือคืนห้อง`,
        });
        state.lastContractTenantNotify[c.contract_no] = key;
      } catch (err) {
        console.warn('[scheduler] contract tenant ended-notify failed:', err.message);
      }
    }

    // Upcoming: warn tenants at 30 / 14 / 7 / 1 day thresholds.
    const THRESHOLDS = [30, 14, 7, 1];
    for (const c of upcoming) {
      if (!c.tenant_id) continue;
      if (c.tenant_status !== 'active' || c.deleted_at) continue;
      const days = Number(c.days_left);
      // Pick the smallest threshold the tenant has crossed today
      // (e.g. days_left=6 → matches 7 first, but we want 1 once they hit it)
      const matched = THRESHOLDS.filter((t) => days <= t).sort((a, b) => a - b)[0];
      if (matched == null) continue;
      const key = `upcoming:${c.contract_no}:${matched}`;
      if (state.lastContractTenantNotify[c.contract_no] === key) continue;
      try {
        await notifier.notifyTenant({ pool, features: _flags || {} }, {
          id: c.tenant_id, full_name: c.full_name, phone: c.phone, email: c.email,
          line_user_id: c.line_user_id, line_oa_id: c.line_oa_id, status: c.tenant_status,
        }, {
          subject: `⏰ สัญญาเช่าจะหมดอายุภายใน ${days} วัน`,
          text: `เรียน คุณ${c.full_name}\n\n`
            + `สัญญาเช่า ${c.contract_no} (ห้อง ${c.room_id || '-'}) `
            + `จะสิ้นสุดวันที่ ${c.end_date} (เหลือ ${days} วัน)\n\n`
            + `หากต้องการต่อสัญญา กรุณาติดต่อสำนักงานก่อนวันสิ้นสุด`,
        });
        state.lastContractTenantNotify[c.contract_no] = key;
      } catch (err) {
        console.warn('[scheduler] contract tenant upcoming-notify failed:', err.message);
      }
    }

    state.lastContractExpiryAt = todayKey;
    writeState(state);
  } catch (err) {
    console.error('[scheduler] contract expiry tick failed:', err.message);
    return { error: err.message };
  }
}

// Auto-detect + reconcile stranded rooms. Two-stage:
//   (1) detect — daily count of rooms where the JSONB blob shows a tenant
//       but no active contract. Anomaly detector already alerts on this via
//       healthCheck's stranded_occupied_rooms, but the daily tick produces
//       a single concise "today's residue" line for owner so it's visible
//       even without going through /admin#health.
//   (2) auto-fix — when features.autoReconcileRooms.enabled is true, run
//       /api/admin/rooms/:roomId/reconcile-equivalent SQL on rooms where
//       the orphan contract's tenant is ALREADY moved_out (the safe case
//       where reconcile has no ambiguity). Stranded rooms whose tenant is
//       still 'active' are left alone — those need admin to decide if the
//       contract should close (tenant disputes resolution / refund pending).
// Either stage failing should never block the rest of the scheduler tick.

// Daily "who hasn't paid" digest for the owner. Runs once per day after
// tickLateFee has already flipped pending → overdue, so the digest sees the
// authoritative set. Without this tick the operator had to remember to open
// /admin#bills?status=overdue manually; missed days meant a tenant could be
// 30+ days late before anyone noticed.
//
// One LINE/email message per day, even when there are zero overdue bills —
// the "all clear" message proves the digest fired (avoid "did the cron run
// today?" anxiety). Skipped on weekend? No — late-rent doesn't take weekends.
async function tickOverdueDigest(pool, flags, now, state) {
  const todayKey = localDateKey(now);
  if (state.lastOverdueDigestAt === todayKey) return;
  try {
    // Pull all overdue bills + owner-relevant fields. days_late computed in SQL
    // (CURRENT_DATE - due_date) so the message is correct regardless of when
    // tick fires within the day. LEFT JOIN tenants so orphan bills (tenant_id
    // NULL — legacy) still surface; admin needs to know about those too.
    //
    // EXCLUDE bills whose tenant has moved out or been soft-deleted. Without
    // this filter, the digest counted historical bills from ex-tenants as
    // "currently overdue", driving owners to call phone numbers that no
    // longer belong to them. Those bills should be reconciled (voided or
    // attributed to the moved-out tenant's final settlement), not chased.
    // Bills with tenant_id IS NULL (orphans) still surface — admin needs
    // to know about those so they can be linked or voided.
    const { rows } = await pool.query(`
      SELECT b.id, b.bill_no, b.room_id, b.period, b.total, b.due_date,
             (CURRENT_DATE - b.due_date)::int AS days_late,
             t.full_name, t.phone
        FROM bills b
        LEFT JOIN tenants t ON t.id = b.tenant_id
       WHERE b.status='overdue' AND b.deleted_at IS NULL
         AND (
           b.tenant_id IS NULL
           OR (t.deleted_at IS NULL AND COALESCE(t.status,'active')='active')
         )
       ORDER BY (CURRENT_DATE - b.due_date) DESC, b.room_id ASC
       LIMIT 200
    `);

    // Also count slip queue health so the owner sees both halves of the
    // "money in" picture in one message — overdue bills (no slip yet) and
    // pending slips (uploaded, awaiting admin review).
    const queueRes = await pool.query(`
      SELECT COUNT(*)::int AS pending_count,
             COALESCE(SUM(amount), 0)::numeric AS pending_amount
        FROM payments WHERE status='pending'
    `);
    const pendingCount = Number(queueRes.rows[0]?.pending_count || 0);
    const pendingAmount = Number(queueRes.rows[0]?.pending_amount || 0);

    const totalOverdue = rows.reduce((s, r) => s + (Number(r.total) || 0), 0);
    const lines = [];
    if (rows.length === 0) {
      lines.push('✅ ไม่มีบิลค้างชำระวันนี้');
    } else {
      lines.push(`🔴 บิลค้างชำระ ${rows.length} ใบ — รวม ฿${totalOverdue.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`);
      lines.push('');
      const display = rows.slice(0, 30);
      for (const r of display) {
        const amt = Number(r.total).toLocaleString('th-TH', { minimumFractionDigits: 2 });
        const tenant = r.full_name || '(ไม่มีผู้เช่าผูก)';
        const phone = r.phone ? ` · ${r.phone}` : '';
        lines.push(`  • ห้อง ${r.room_id || '-'} · ${tenant}${phone}`);
        lines.push(`      บิล ${r.bill_no || `#${r.id}`} (${r.period || '-'}) — ฿${amt} · ค้าง ${r.days_late} วัน`);
      }
      if (rows.length > display.length) {
        lines.push(`  …และอีก ${rows.length - display.length} ห้อง`);
      }
    }
    if (pendingCount > 0) {
      lines.push('');
      lines.push(`📥 สลิปรอตรวจ ${pendingCount} ใบ — รวม ฿${pendingAmount.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`);
      lines.push('   → ตรวจที่ /admin#payments');
    }
    // Surface today's access-card auto-revoke / auto-restore activity so
    // the owner sees the consequence of overdue bills (cards cut) in the
    // same daily message. The data is stashed by tickAccessControlSync
    // for this exact tick — same calendar date guard so we don't surface
    // yesterday's number.
    const accessToday = state.todaysAccessSync;
    if (accessToday && accessToday.date === todayKey
        && (accessToday.revokedCount || accessToday.restoredCount)) {
      lines.push('');
      lines.push(`🔐 บัตรเข้า-ออกอัตโนมัติวันนี้:`);
      if (accessToday.revokedCount) {
        lines.push(`   🔒 ระงับ: ${accessToday.revokedCount} ใบ (ค้างชำระเกินกำหนด)`);
      }
      if (accessToday.restoredCount) {
        lines.push(`   🔓 คืนสิทธิ์: ${accessToday.restoredCount} ใบ (ชำระเรียบร้อย)`);
      }
      lines.push('   → ดูที่ /admin#access');
    }
    if (rows.length > 0) {
      lines.push('');
      lines.push('รายละเอียดเต็ม → /admin#bills?status=overdue');
    }

    try {
      await notifier.notifyOwner({ pool, features: flags || {} }, {
        category: 'billing',
        subject: rows.length === 0
          ? '✅ รายงานบิลค้างชำระ — ไม่มี'
          : `🔴 บิลค้างชำระ ${rows.length} ใบ — ฿${totalOverdue.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`,
        text: lines.join('\n'),
      });
    } catch (err) {
      console.warn('[scheduler] overdue digest notify failed:', err.message);
    }

    state.lastOverdueDigestAt = todayKey;
    writeState(state);
  } catch (err) {
    console.error('[scheduler] overdue digest tick failed:', err.message);
    return { error: err.message };
  }
}

async function tickAutoReconcileRooms(pool, flags, now, state) {
  const todayKey = localDateKey(now);
  if (state.lastAutoReconcileAt === todayKey) return;
  try {
    // Stage 1: detect — query is the same shape as healthCheck's
    // stranded_occupied_rooms but enriched with the room codes themselves
    // so we can act on each one.
    const { rows: stranded } = await pool.query(`
      WITH blob_rooms AS (
        SELECT rec.key AS room_code, rec.val AS room
          FROM app_data, jsonb_each(value) AS rec(key, val)
         WHERE app_data.key='baankarn_rooms_v1'
           AND jsonb_typeof(value) = 'object'
      )
      SELECT br.room_code,
             COALESCE(br.room->'tenant'->>'name', '?')   AS blob_tenant_name,
             c.id   AS orphan_contract_id,
             c.contract_no AS orphan_contract_no,
             c.tenant_id AS orphan_tenant_id,
             t.full_name AS orphan_tenant_name,
             t.status   AS orphan_tenant_status
        FROM blob_rooms br
        LEFT JOIN contracts c
               ON c.room_id = br.room_code
              AND c.status='active' AND c.deleted_at IS NULL
        LEFT JOIN tenants t ON t.id = c.tenant_id
       WHERE br.room ? 'tenant'
         AND br.room->'tenant' IS NOT NULL
         AND br.room->'tenant' <> 'null'::jsonb
         AND (c.id IS NULL OR t.status = 'moved_out')
       ORDER BY br.room_code
       LIMIT 500
    `);

    if (stranded.length === 0) {
      state.lastAutoReconcileAt = todayKey;
      writeState(state);
      return;
    }

    // Stage 2: optionally auto-fix the "safe" subset. A row is safe to
    // auto-reconcile when the orphan contract's tenant is already
    // 'moved_out' OR the blob shows a tenant but no contract exists at
    // all — in both cases there's no live tenant to disrupt and the
    // reconcile action mirrors the explicit endpoint.
    const autoEnabled = !!(flags?.autoReconcileRooms && flags.autoReconcileRooms.enabled);
    const safe = stranded.filter((r) =>
      // No contract OR contract's tenant is already moved_out
      r.orphan_contract_id == null || r.orphan_tenant_status === 'moved_out'
    );
    const reconciled = [];
    if (autoEnabled && safe.length > 0) {
      for (const r of safe) {
        // Use a tx per room — atomic per-reconcile, so a transient DB
        // hiccup on room #5 doesn't lose the work on room #1-4.
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          if (r.orphan_contract_id) {
            await client.query(
              `UPDATE contracts SET status='ended', end_date=CURRENT_DATE,
                  deposit_return_reason = COALESCE(deposit_return_reason,
                    '[auto-reconcile] tenant already moved_out'),
                  updated_at=NOW()
                WHERE id=$1 AND status='active'`,
              [r.orphan_contract_id]
            );
          }
          // Free the blob: drop 'tenant' + flip status='vacant'.
          await client.query(
            `UPDATE app_data
                SET value = jsonb_set(
                              value,
                              ARRAY[$1::text],
                              ((value->$1) - 'tenant') || jsonb_build_object('status', 'vacant')
                            ),
                    updated_at=NOW()
              WHERE key='baankarn_rooms_v1' AND value ? $1`,
            [r.room_code]
          );
          // Best-effort rooms_v2 sync.
          try {
            await client.query(
              `UPDATE rooms_v2 SET status='vacant', updated_at=NOW()
                WHERE room_code=$1 AND deleted_at IS NULL`,
              [r.room_code]
            );
          } catch (err) { if (err.code !== '42P01') throw err; }
          await client.query('COMMIT');
          reconciled.push(r);
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          console.warn(`[scheduler] auto-reconcile room ${r.room_code} failed:`, err.message);
        } finally {
          client.release();
        }
      }
    }

    // Notify owner — one summary message per day. Detection-only mode
    // (autoReconcileRooms off) makes the message a passive heads-up;
    // auto-fix mode includes the list of fixed rooms + any leftover that
    // need manual review.
    const remaining = stranded.filter((r) => !reconciled.some((x) => x.room_code === r.room_code));
    const lines = [];
    if (reconciled.length > 0) {
      lines.push(`🔧 Auto-reconciled ${reconciled.length} stranded room(s):`);
      for (const r of reconciled) {
        lines.push(`  • ห้อง ${r.room_code}` +
          (r.orphan_contract_no ? ` — ปิดสัญญา ${r.orphan_contract_no} (อดีตผู้เช่า ${r.orphan_tenant_name || '-'})` : ''));
      }
    }
    if (remaining.length > 0) {
      lines.push((reconciled.length > 0 ? '\n' : '') + `⚠️ Stranded ห้องที่ต้องตรวจสอบเอง (${remaining.length}):`);
      for (const r of remaining) {
        lines.push(`  • ห้อง ${r.room_code} (blob ผู้เช่า: ${r.blob_tenant_name})` +
          (r.orphan_contract_no ? ` — สัญญา ${r.orphan_contract_no} กับ ${r.orphan_tenant_name || '-'} (${r.orphan_tenant_status || '?'})` : ' — ไม่มีสัญญา active'));
      }
      if (!autoEnabled) {
        lines.push(`\n💡 เปิดใช้งานการ reconcile อัตโนมัติได้ที่ /admin#features → autoReconcileRooms`);
      }
      lines.push(`\nรายละเอียดเต็ม + ปุ่ม Reconcile → /admin#rooms`);
    }
    if (lines.length > 0) {
      try {
        await notifier.notifyOwner({ pool, features: flags || {} }, {
          category: 'system',
          subject: reconciled.length > 0 && remaining.length === 0
            ? `✅ Reconciled ${reconciled.length} stranded room(s)`
            : `⚠️ ห้องสถานะไม่สอดคล้อง ${stranded.length} ห้อง`,
          text: lines.join('\n'),
        });
      } catch (err) {
        console.warn('[scheduler] auto-reconcile notify failed:', err.message);
      }
    }

    state.lastAutoReconcileAt = todayKey;
    writeState(state);
  } catch (err) {
    console.error('[scheduler] auto-reconcile tick failed:', err.message);
    return { error: err.message };
  }
}

// Postgres advisory-lock helper. The 64-bit lock id is derived from a per-
// scheduler salt + a fixed namespace so cross-feature lock ids never collide.
// Hash takes any string and folds it to int64 — good enough for cooperative
// scheduling between replicas (we don't need cryptographic strength here).
const SCHED_LOCK_NAMESPACE = 0x42414e4b;  // ascii "BANK"
function _lockKeyFor(name) {
  // FNV-1a 32-bit, sign-clamped to int32 so pg_try_advisory_lock(int4,int4)
  // accepts both args without throwing "out of range for int4".
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Clamp to positive int32
  return (h >>> 0) & 0x7fffffff;
}
async function _withAdvisoryLock(pool, name, fn, { dbLatch = false } = {}) {
  // Try-lock so a hung peer can never wedge us — scheduler ticks are idempotent
  // anyway; missing one tick is preferable to blocking subsequent ticks.
  let acquired = false;
  let client;
  try {
    client = await pool.connect();
    const r = await client.query(
      'SELECT pg_try_advisory_lock($1::int, $2::int) AS got',
      [SCHED_LOCK_NAMESPACE, _lockKeyFor(name)]
    );
    acquired = r.rows[0] && r.rows[0].got === true;
    if (!acquired) return { skipped: true, reason: 'lock-held' };
    // dbLatch — cross-replica once-per-key guard. The advisory lock is a
    // MUTEX, not a memory: a replica ticking a minute after a peer released
    // the lock acquires it freely, and the per-container state file can't
    // see what the other replica already sent (staggered 2x deploys double-
    // sent every daily digest). For jobs whose side effects are pure
    // notifications (no DB idempotency guard of their own), persist a shared
    // "already ran" marker keyed by the date/hour-suffixed lock name —
    // checked AND written while holding the lock so two replicas can never
    // both pass. Written only after fn() succeeds, so a failed run is still
    // retried on the next tick. Latch read/write failures degrade to the old
    // run-anyway behavior rather than dropping the job. Rows are pruned
    // after 7 days by tickPruneFailedNotifications.
    const latchKey = `sched_done:${name}`;
    if (dbLatch) {
      try {
        const seen = await client.query(
          'SELECT 1 FROM app_data WHERE key=$1 LIMIT 1', [latchKey]
        );
        if (seen.rows.length) return { skipped: true, reason: 'db-latch' };
      } catch (err) {
        console.warn(`[scheduler] db-latch read(${name}) failed:`, err.message);
      }
    }
    const result = await fn(client);
    if (dbLatch && !(result && result.error)) {
      try {
        await client.query(
          `INSERT INTO app_data (key, value, updated_by)
             VALUES ($1, $2::jsonb, 'system:scheduler')
           ON CONFLICT (key) DO NOTHING`,
          [latchKey, JSON.stringify({ at: new Date().toISOString() })]
        );
      } catch (err) {
        console.warn(`[scheduler] db-latch write(${name}) failed:`, err.message);
      }
    }
    return result;
  } catch (err) {
    console.error(`[scheduler] advisory-lock(${name}) error:`, err.message);
    return { error: err.message };
  } finally {
    if (client) {
      if (acquired) {
        try {
          await client.query(
            'SELECT pg_advisory_unlock($1::int, $2::int)',
            [SCHED_LOCK_NAMESPACE, _lockKeyFor(name)]
          );
        } catch { /* ignore */ }
      }
      client.release();
    }
  }
}

// === R7 — Pre-due payment reminder ========================================
// Tenants forget. The original system only notified them when a bill was
// FIRST issued (via tickBillGen or admin click "ส่ง") and AFTER it had
// already gone overdue (via tickLateFee). Between those two signals there
// was no nudge — most "I forgot, that's why I paid late" complaints lived
// in that gap. This tick fires on TWO trigger days:
//   - 3 days before due_date (T-3) → soft heads-up
//   - the due_date itself (T-0)    → final reminder
//
// Idempotency: `last_reminded_at` (already in the bills table for the admin
// "ส่งเตือน" history) — we skip any bill reminded today, so a daily tick
// can never fire twice. Without this check a Railway 2-replica deploy
// would still each send their own reminder on the same day; the advisory
// lock wrapping the tick prevents that, but the `last_reminded_at` guard
// is the second line of defence.
//
// FEATURE FLAG: features.paymentReminder.enabled (default OFF — preserves
// historical behaviour for deploys that don't want extra LINE pushes).
// Config keys:
//   - daysBeforeDue:  array of integers, e.g. [3, 0]. 0 means due day.
//                     Defaults to [3, 0] when flag enabled but list missing.
//   - includeOverdue: when true, also remind on overdue bills daily until
//                     paid. Default false because tickLateFee already
//                     handles the flip-day notification and access-sync
//                     handles the suspension warning — most operators
//                     don't want a third channel pinging tenants daily.
async function tickPaymentReminder(pool, flags, now, state) {
  if (!flags.paymentReminder || !flags.paymentReminder.enabled) return;
  const todayKey = localDateKey(now);
  if (state.lastPaymentReminderAt === todayKey) return;

  // Front-back reconciliation for the Settings → การแจ้งเตือน fields, which
  // used to be ignored: config.notify.reminder1 (days BEFORE due) is folded into
  // the pre-due offsets, and config.notify.reminder2 > 0 (days after due) turns
  // on the overdue reminders. The feature-flag list (daysBeforeDue/includeOverdue)
  // still applies; the two sources are unioned so either UI works.
  let cfgReminder1 = null;
  let cfgReminder2On = false;
  try {
    const { rows: cfgRows } = await pool.query(
      `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
    );
    const notify = cfgRows[0] && cfgRows[0].value && cfgRows[0].value.notify;
    if (notify) {
      const r1 = Number(notify.reminder1);
      if (Number.isInteger(r1) && r1 >= 0 && r1 <= 30) cfgReminder1 = r1;
      cfgReminder2On = Number(notify.reminder2) > 0;
    }
  } catch { /* config missing — feature flag values still apply */ }

  // Sanitize the configured reminder days: keep integers in [0, 30] only.
  // 30 is more than the usual ~15-day bill window — anything beyond is
  // almost certainly a typo. Negative days don't make sense (those are
  // "after due date" which is overdue territory, handled separately).
  const rawDays = Array.isArray(flags.paymentReminder.daysBeforeDue)
    ? [...flags.paymentReminder.daysBeforeDue]   // copy — never mutate the flags cache
    : [3, 0];
  if (cfgReminder1 != null) rawDays.push(cfgReminder1);
  const dueOffsets = [...new Set(rawDays
    .map((d) => Number(d))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 30)
  )].sort((a, b) => b - a);   // most-future first so T-3 fires before T-0
  if (dueOffsets.length === 0) return;

  const includeOverdue = flags.paymentReminder.includeOverdue === true || cfgReminder2On;

  try {
    // Query bills that hit any of the configured offsets today.
    // CURRENT_DATE + offset works because PostgreSQL evaluates the DATE
    // arithmetic before comparing to due_date (which is also DATE).
    //
    // We filter `last_reminded_at < CURRENT_DATE` (not <= CURRENT_DATE)
    // so a bill reminded EARLIER today (e.g. by an admin clicking "ส่งเตือน"
    // at 9am, then the cron firing at 6pm) is NOT re-pinged. The admin's
    // manual send takes priority.
    //
    // Tenant join filter (status='active', deleted_at IS NULL) matches
    // the rest of the codebase — we never push to moved-out / soft-deleted
    // tenants. tenant_status and current_room are pulled so we can also
    // skip bills whose tenant has since moved out (their problem to pay
    // is being handled via collections workflow, not portal reminders).
    const conditions = dueOffsets.map((_, i) => `b.due_date = CURRENT_DATE + $${i + 1}::int`);
    if (includeOverdue) conditions.push(`(b.status = 'overdue' AND b.due_date < CURRENT_DATE)`);
    const params = dueOffsets.slice();
    const { rows: due } = await pool.query(
      `SELECT b.id, b.bill_no, b.room_id, b.tenant_id, b.period,
              b.total, b.due_date, b.late_fee, b.status,
              t.full_name, t.phone, t.email,
              t.line_user_id, t.line_oa_id
         FROM bills b
         INNER JOIN tenants t ON t.id = b.tenant_id
        WHERE b.deleted_at IS NULL
          AND b.paid_at IS NULL
          AND b.status IN ('pending', 'overdue')
          AND (${conditions.join(' OR ')})
          AND (b.last_reminded_at IS NULL
               OR b.last_reminded_at < CURRENT_DATE)
          AND t.deleted_at IS NULL
          AND t.status = 'active'
          AND t.current_room_id = b.room_id
        ORDER BY b.due_date ASC, b.id ASC
        LIMIT 200`,
      params
    );

    if (due.length === 0) {
      state.lastPaymentReminderAt = todayKey;
      writeState(state);
      return;
    }

    const notifQueue = require('./notificationQueue');
    let reminded = 0;
    for (const b of due) {
      // Skip rooms with no reachable channel; owner gets a separate
      // alert via the queue/notifier failure path if needed.
      let recipients = [];
      try {
        recipients = await notifier.getTenantLineRecipients(pool, {
          id: b.tenant_id,
          line_user_id: b.line_user_id,
          line_oa_id: b.line_oa_id,
        });
      } catch {
        recipients = b.line_user_id ? [{ line_user_id: b.line_user_id, line_oa_id: b.line_oa_id }] : [];
      }
      const lineBindingCount = recipients.length;
      const hasLine = lineBindingCount > 0;
      const hasEmail = !!(b.email);
      if (!hasLine && !hasEmail) continue;

      const dueDt = b.due_date ? new Date(b.due_date) : null;
      const dueDayStr = dueDt
        ? dueDt.toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' })
        : '-';
      // Whole-CALENDAR-day difference, not a raw timestamp delta. due_date is
      // a date-only column (local midnight); `now` carries the time of day, so
      // subtracting the raw getTime() values yielded a fractional day that
      // Math.round flipped to -1 once the tick fired after ~noon — making a
      // bill due TODAY render "🔔 อีก -1 วันครบกำหนด" and never hitting the
      // "วันนี้ครบกำหนด" tier. Normalise both sides to local midnight first.
      const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const daysUntilDue = dueDt
        ? Math.round((startOfDay(dueDt).getTime() - startOfDay(now).getTime()) / 86_400_000)
        : null;
      const isToday = daysUntilDue === 0;
      const isOverdueRow = b.status === 'overdue';
      const amtStr = Number(b.total).toLocaleString('th-TH', { minimumFractionDigits: 2 });

      // Tailor the subject to the urgency tier — gives tenants a quick
      // skim signal in their LINE chat list / email subject line.
      let subject;
      if (isOverdueRow) {
        subject = `⏰ บิลค้างชำระ — ห้อง ${b.room_id}`;
      } else if (isToday) {
        subject = `📌 วันนี้ครบกำหนดชำระ — ห้อง ${b.room_id}`;
      } else {
        subject = `🔔 อีก ${daysUntilDue} วันครบกำหนดชำระ — ห้อง ${b.room_id}`;
      }

      const lateFeeLine = Number(b.late_fee) > 0
        ? `ค่าปรับล่าช้า: ฿${Number(b.late_fee).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`
        : null;

      const body = [
        `เรียน คุณ${b.full_name || ''}`,
        ``,
        isOverdueRow
          ? `บิลด้านล่างเลยกำหนดชำระแล้ว กรุณาชำระโดยเร็ว`
          : isToday
            ? `วันนี้เป็นวันสุดท้ายในการชำระบิลด้านล่าง`
            : `บิลด้านล่างจะครบกำหนดชำระในอีก ${daysUntilDue} วัน — ส่งล่วงหน้าเพื่อให้คุณไม่ลืม`,
        ``,
        `📄 บิล: ${b.bill_no || `#${b.id}`}${b.period ? ` (รอบ ${b.period})` : ''}`,
        `🏠 ห้อง: ${b.room_id}`,
        `💰 ยอดที่ต้องชำระ: ฿${amtStr}`,
        lateFeeLine,
        `📅 ครบกำหนด: ${dueDayStr}`,
        `LINE ที่ผูกกับห้องนี้: ${lineBindingCount} บัญชี`,
        ``,
        `📋 ชำระผ่าน QR PromptPay หรือโอนเงินตามที่ระบุในบิล แล้วอัปโหลดสลิปที่พอร์ทัล /tenant`,
      ].filter(Boolean).join('\n');

      const reminderTier = isOverdueRow ? 'overdue' : (isToday ? 'today' : 'pre-due');
      try {
        // Count enqueues that actually landed. The bill is only stamped
        // last_reminded_at when at least one did — otherwise a transient
        // queue/DB failure would silently mark the bill "reminded today" and
        // the next tick's `last_reminded_at < CURRENT_DATE` filter would skip
        // it for the rest of the day, dropping the reminder entirely.
        let enqueuedOk = 0;
        if (hasLine) {
          // Fan out to every LINE binding the tenant has (single-OA
          // tenants get 1 push, multi-OA tenants get 1 per OA so the
          // message lands wherever they actually check). Falls back
          // gracefully when getTenantLineRecipients isn't yet wired
          // for a legacy deploy (we still have b.line_user_id).
          for (const r of recipients) {
            try {
              await notifQueue.enqueue(pool, {
                channel: 'line', recipient: r.line_user_id, subject, body,
                payload: { oaId: r.line_oa_id || null, billId: b.id, reminderTier },
              });
              enqueuedOk++;
            } catch (e) { /* keep going; only successes count toward the stamp */ }
          }
        }
        if (hasEmail) {
          try {
            await notifQueue.enqueue(pool, {
              channel: 'email', recipient: b.email, subject, body,
              payload: { billId: b.id, reminderTier },
            });
            enqueuedOk++;
          } catch (e) { /* ignore — stamp guarded by enqueuedOk below */ }
        }
        // Stamp last_reminded_at only when something was actually queued, so
        // admin's send-history UI and the next tick's filter both see this
        // bill as handled — and a fully-failed round is retried next tick.
        if (enqueuedOk > 0) {
          await pool.query(
            `UPDATE bills
                SET last_reminded_at = NOW(),
                    reminder_count   = COALESCE(reminder_count, 0) + 1
              WHERE id = $1 AND deleted_at IS NULL`,
            [b.id]
          ).catch((err) => console.warn('[scheduler] reminder stamp failed:', err.message));
          reminded++;
        }
      } catch (err) {
        console.warn(`[scheduler] reminder for bill ${b.id} failed:`, err.message);
      }
    }
    if (reminded > 0) {
      console.log(`[scheduler] payment reminders sent for ${reminded}/${due.length} bill(s)`);
    }
    state.lastPaymentReminderAt = todayKey;
    writeState(state);
  } catch (err) {
    console.error('[scheduler] payment reminder failed:', err.message);
    return { error: err.message };
  }
}

// === Janitor: prune old failed notifications ============================
// notifications_queue rows with status='failed' linger forever — there
// was no TTL or cleanup before this. Over months the table accumulates
// thousands of dead rows from misconfigured SMTP / revoked LINE tokens /
// missing recipients, which inflates /admin#health "queue backlog" and
// makes the table slow to scan. We keep failed rows 30 days for forensics
// (admin can see "why didn't the message go through?") then prune.
async function tickPruneFailedNotifications(pool, _flags, now, state) {
  const todayKey = localDateKey(now);
  if (state.lastNotifQueuePruneAt === todayKey) return;
  try {
    const r = await pool.query(`
      DELETE FROM notifications_queue
        WHERE status='failed'
          AND created_at < NOW() - INTERVAL '30 days'
    `);
    if (r.rowCount > 0) {
      console.log(`[scheduler] pruned ${r.rowCount} failed notification(s) older than 30 days`);
    }
    // Also prune the cross-replica scheduler run latches (see
    // _withAdvisoryLock dbLatch) — keys are date/hour-suffixed and only
    // matter for the day they were written; 7 days keeps a short forensic
    // window without growing app_data unbounded.
    try {
      await pool.query(`
        DELETE FROM app_data
          WHERE key LIKE 'sched_done:%'
            AND updated_at < NOW() - INTERVAL '7 days'
      `);
    } catch (latchErr) {
      console.warn('[scheduler] sched_done latch prune failed:', latchErr.message);
    }
    state.lastNotifQueuePruneAt = todayKey;
    writeState(state);
  } catch (err) {
    // Tolerate missing table on legacy deploys without notifications_queue.
    if (err.code !== '42P01') {
      console.warn('[scheduler] prune-failed-notifications failed:', err.message);
      return { error: err.message };
    }
  }
}

// === Janitor: orphan slip files ============================================
// When the slip upload pipeline crashes between storage.saveBase64 and the
// payments INSERT commit, file_uploads has a row pointing at a real file
// but no payments row references it. The transactional rollback path in
// server.js handles the in-process error; this tick catches the case where
// the Node process itself died (Railway restart, OOM kill, deploy mid-
// request) leaving file orphans on R2 / local disk + a dead file_uploads
// row. Conservative: only prune slip-category uploads older than 24h with
// no referencing payment or booking-deposit slip.
async function tickPruneOrphanSlips(pool, _flags, now, state) {
  const todayKey = localDateKey(now);
  if (state.lastOrphanSlipPruneAt === todayKey) return;
  try {
    // Look up orphan file_uploads rows first so we can call storage.remove
    // (which deletes the underlying file in R2 / local). We don't bulk-
    // DELETE in SQL because the file bytes won't be reachable afterwards.
    const orphans = await pool.query(`
      SELECT fu.id, fu.url
        FROM file_uploads fu
        LEFT JOIN payments p ON p.slip_url = fu.url
        LEFT JOIN bookings b ON b.deposit_slip_file_id = fu.id
       WHERE fu.category = 'slip'
         AND p.id IS NULL
         AND b.id IS NULL
         AND fu.uploaded_at < NOW() - INTERVAL '24 hours'
       LIMIT 200
    `);
    if (orphans.rows.length === 0) {
      state.lastOrphanSlipPruneAt = todayKey;
      writeState(state);
      return;
    }
    const storage = require('./storage');
    let removed = 0;
    for (const o of orphans.rows) {
      try {
        await storage.remove(pool, o.id);
        removed++;
      } catch (err) {
        console.warn(`[scheduler] orphan slip cleanup id=${o.id} failed:`, err.message);
      }
    }
    if (removed > 0) {
      console.log(`[scheduler] pruned ${removed}/${orphans.rows.length} orphan slip file(s)`);
    }
    state.lastOrphanSlipPruneAt = todayKey;
    writeState(state);
  } catch (err) {
    if (err.code !== '42P01') {
      console.warn('[scheduler] prune-orphan-slips failed:', err.message);
      return { error: err.message };
    }
  }
}

let _ticking = false;
// Escalate slips stuck in the 'pending' admin queue beyond the operator's
// threshold (features.slipUpload.pendingSlipAlertHours, default 12; 0 = off).
// The daily overdue digest already prints the queue SIZE — this is the
// faster per-slip escalation so a tenant who already paid isn't left
// waiting days for a verify click. Runs hourly; each payment alerts ONCE
// (state.alertedPendingSlips latch, pruned when the payment leaves the
// pending state so a re-upload after rejection can alert again).
async function tickPendingSlipAlert(pool, flags, now, state) {
  if (!flags?.slipUpload?.enabled) return;
  const rawHours = Number(flags.slipUpload.pendingSlipAlertHours);
  if (!Number.isFinite(rawHours) || rawHours <= 0) return;   // 0/absent = off
  const hours = Math.max(1, Math.min(168, Math.trunc(rawHours)));
  try {
    if (!state.alertedPendingSlips || typeof state.alertedPendingSlips !== 'object') {
      state.alertedPendingSlips = {};
    }
    // Prune the latch against the FULL pending set (not just the aged ones)
    // so entries for verified/rejected payments drop out and the state file
    // stays bounded by the live queue size.
    const allPending = await pool.query(
      `SELECT id FROM payments WHERE status='pending'`
    );
    const livePendingIds = new Set(allPending.rows.map((r) => String(r.id)));
    let pruned = false;
    for (const key of Object.keys(state.alertedPendingSlips)) {
      if (!livePendingIds.has(key)) {
        delete state.alertedPendingSlips[key];
        pruned = true;
      }
    }
    const { rows } = await pool.query(
      `SELECT p.id, p.amount, p.created_at, p.bill_id,
              b.bill_no, b.room_id, b.period,
              t.full_name
         FROM payments p
         LEFT JOIN bills b ON b.id = p.bill_id
         LEFT JOIN tenants t ON t.id = p.tenant_id
        WHERE p.status='pending'
          AND p.created_at <= NOW() - make_interval(hours => $1)
        ORDER BY p.created_at ASC
        LIMIT 50`,
      [hours]
    );
    const fresh = rows.filter((r) => !state.alertedPendingSlips[String(r.id)]);
    if (!fresh.length) {
      if (pruned) writeState(state);
      return;
    }
    const lines = fresh.slice(0, 10).map((r) => {
      const waitedH = Math.max(1, Math.floor((now.getTime() - new Date(r.created_at).getTime()) / 3_600_000));
      const amt = Number(r.amount).toLocaleString('th-TH', { minimumFractionDigits: 2 });
      const who = r.full_name || '(ไม่มีผู้เช่าผูก)';
      const bill = r.bill_no || (r.bill_id ? `#${r.bill_id}` : '-');
      return `  • ห้อง ${r.room_id || '-'} · ${who} — ฿${amt} (บิล ${bill}${r.period ? ` รอบ ${r.period}` : ''}) · รอมา ${waitedH} ชม.`;
    });
    await notifier.notifyOwner({ pool, features: flags }, {
      category: 'payment',
      subject: `⏳ สลิปรอตรวจค้างเกิน ${hours} ชม. — ${fresh.length} รายการ`,
      text: [
        `มีสลิปที่ผู้เช่าส่งแล้วแต่ยังไม่ได้ตรวจ ค้างคิวเกิน ${hours} ชั่วโมง:`,
        ``,
        ...lines,
        fresh.length > 10 ? `  …และอีก ${fresh.length - 10} รายการ` : null,
        ``,
        `ผู้เช่าที่โอนแล้วกำลังรอผล — ตรวจที่ /admin#payments`,
        `(ปรับเกณฑ์ได้ที่ features → slipUpload.pendingSlipAlertHours, 0 = ปิด)`,
      ].filter(Boolean).join('\n'),
    });
    for (const r of fresh) {
      state.alertedPendingSlips[String(r.id)] = new Date().toISOString();
    }
    writeState(state);
  } catch (err) {
    console.error('[scheduler] pending-slip alert failed:', err.message);
    return { error: err.message };
  }
}

async function tick(pool) {
  // Re-entrancy guard. setInterval fires hourly, but a heavy cycle (large
  // bill-gen + slow LINE/SMTP fan-out) could exceed TICK_MS. Overlapping ticks
  // in the SAME process would double-run the un-locked tickLateFee and race
  // writeState(). Advisory locks cover the cross-replica case; this covers
  // same-process overlap. Skips (not queues) — the next hourly tick catches up.
  if (_ticking) {
    console.warn('[scheduler] previous tick still running — skipping this cycle');
    return;
  }
  _ticking = true;
  try {
    await _runTick(pool);
  } finally {
    _ticking = false;
  }
}

async function _runTick(pool) {
  const state = readState();
  let flags;
  try {
    flags = await features.load(pool);
  } catch (err) {
    console.error('[scheduler] features load failed:', err.message);
    await notifySchedulerFailure(pool, {}, state, 'features-load', err);
    return;
  }
  const now = new Date();
  // ICT calendar day, shared by every daily latch + advisory-lock suffix below.
  const todayKey = localDateKey(now);

  // Late-fee MUST run before bill-gen so any bills going overdue today get
  // their late_fee applied IN-PLACE before bill-gen reads the same table.
  // R2 — buildBill never carries the previous bill's penalty forward; the
  // fee lives on the original overdue bill (updated by tickLateFee). Order
  // still matters because access-control sync + room-status cascade read
  // bills.status, so the overdue flip must complete before downstream
  // jobs see the table.
  //
  // Wrapped in the SAME per-day advisory lock as the other ticks: tickLateFee
  // sends per-tenant "บิลเลยกำหนด" notifications and writes audit rows that are
  // NOT idempotent across replicas, so on a 2x deploy both instances would
  // otherwise double-notify / double-audit the same overdue bills. Lock held
  // only for this job; the state-file latch still blocks repeats in-process.
  try {
    const lateFeeResult = await _withAdvisoryLock(
      pool, `lateFee-${todayKey}`, () => tickLateFee(pool, flags, now, state)
    );
    if (lateFeeResult && lateFeeResult.error) {
      await notifySchedulerFailure(pool, flags, state, 'late-fee', lateFeeResult);
    }
  } catch (err) {
    console.error('[scheduler] late-fee:', err.message);
    await notifySchedulerFailure(pool, flags, state, 'late-fee', err);
  }

  // Wrap the daily ticks in an advisory lock so multi-replica deployments
  // (Railway 2x replica common) don't run the same job CONCURRENTLY. The
  // lock alone is NOT enough for once-per-day semantics — it's a mutex with
  // no memory, and staggered replicas (boot+30s then hourly) rarely overlap,
  // so a peer ticking minutes later acquires the same key freely. Jobs whose
  // side effects are DB-guarded (ON CONFLICT inserts, UPDATE..RETURNING
  // flips, last_reminded_at stamps) are safe anyway; jobs that only send
  // notifications (digest, contract warnings, slip alerts, reconcile
  // report) additionally pass { dbLatch: true } so the "already ran today"
  // marker is shared across replicas via app_data instead of each
  // container's private state file.
  //
  // The advisory lock is held only for the duration of one tick cycle; the
  // state-file latch still blocks repeats within the same instance.
  // (todayKey computed above, shared with the late-fee lock.)
  // Access sync feeds today's revoke/restore counts into state.todaysAccessSync,
  // and the overdue digest prints that summary for the owner. Keep access sync
  // before the parallel daily batch so the digest cannot race ahead with a
  // stale/empty access-card section.
  try {
    const accessResult = await _withAdvisoryLock(pool, `accessSync-${todayKey}`, () => tickAccessControlSync(pool, flags, now, state));
    if (accessResult && accessResult.error) {
      await notifySchedulerFailure(pool, flags, state, 'access-sync', accessResult);
    }
  } catch (err) {
    console.error('[scheduler] access sync:', err.message);
    await notifySchedulerFailure(pool, flags, state, 'access-sync', err);
  }

  // Bill-gen's promise is shared so payment-reminder can chain off it below
  // — Promise.allSettled alone gives no ordering, and the two jobs hold
  // DIFFERENT advisory locks so they'd otherwise run fully concurrently.
  const billGenPromise = _withAdvisoryLock(pool, `billGen-${todayKey}`, () => tickBillGen(pool, flags, now, state));
  const jobs = [
    { job: 'auto-backup', promise: _withAdvisoryLock(pool, `autoBackup-${todayKey}`, () => tickAutoBackup(pool, flags, now, state)) },
    { job: 'bill-gen', promise: billGenPromise },
    { job: 'meter-sim', promise: _withAdvisoryLock(pool, `meterSim-${localHourKey(now)}`, () => tickMeterSimulator(pool, flags, now, state)) },
    { job: 'contract-expiry', promise: _withAdvisoryLock(pool, `contractExpiry-${todayKey}`, () => tickContractExpiry(pool, flags, now, state), { dbLatch: true }) },
    { job: 'overdue-digest', promise: _withAdvisoryLock(pool, `overdueDigest-${todayKey}`, () => tickOverdueDigest(pool, flags, now, state), { dbLatch: true }) },
    { job: 'auto-reconcile', promise: _withAdvisoryLock(pool, `autoReconcile-${todayKey}`, () => tickAutoReconcileRooms(pool, flags, now, state), { dbLatch: true }) },
    { job: 'room-status-sync', promise: _withAdvisoryLock(pool, `roomStatusSync-${todayKey}`, () => tickRoomStatusSync(pool, flags, now, state)) },
    { job: 'notif-prune', promise: _withAdvisoryLock(pool, `notifQueuePrune-${todayKey}`, () => tickPruneFailedNotifications(pool, flags, now, state)) },
    { job: 'orphan-slip-prune', promise: _withAdvisoryLock(pool, `orphanSlipPrune-${todayKey}`, () => tickPruneOrphanSlips(pool, flags, now, state)) },
    // R7 — pre-due payment reminder. Chained AFTER bill-gen settles so
    // newly-issued bills with a same-day due date (possible when admin sets
    // dueOnDay = bill-gen day) are committed before the reminder's
    // due_date = CURRENT_DATE query runs — otherwise those tenants miss the
    // "ครบกำหนดวันนี้" alert and the daily latch never retries it.
    // Daily idempotent via state.lastPaymentReminderAt + bills.last_reminded_at.
    {
      job: 'payment-reminder',
      promise: billGenPromise.catch(() => {}).then(
        () => _withAdvisoryLock(pool, `paymentReminder-${todayKey}`, () => tickPaymentReminder(pool, flags, now, state))
      ),
    },
    // Hourly (not daily-latched): a slip crossing the aging threshold at
    // 14:00 shouldn't wait for tomorrow's tick. Per-payment latch inside
    // makes repeat fires no-ops; the hour-scoped advisory lock + dbLatch
    // stop multi-replica double-sends within the same hour.
    { job: 'pending-slip-alert', promise: _withAdvisoryLock(pool, `pendingSlipAlert-${localHourKey(now)}`, () => tickPendingSlipAlert(pool, flags, now, state), { dbLatch: true }) },
    // Hourly: a contract-fill link entering its last 24h gets one tenant +
    // owner warning. Idempotent via the audit-row marker inside the tick;
    // the hour lock just stops replicas racing within the same hour.
    { job: 'invitation-expiry-warn', promise: _withAdvisoryLock(pool, `invitationExpiryWarn-${localHourKey(now)}`, () => tickInvitationExpiryWarn(pool, flags, now, state), { dbLatch: true }) },
    // Daily: cancel stale bookings (pending/reviewing or approved-without-
    // contract past their configured age) and release their rooms.
    { job: 'booking-stale', promise: _withAdvisoryLock(pool, `bookingStale-${todayKey}`, () => tickBookingStale(pool, flags, now, state), { dbLatch: true }) },
  ];
  const results = await Promise.allSettled(jobs.map((j) => j.promise));
  for (const [i, r] of results.entries()) {
    const job = jobs[i].job;
    if (r.status === 'rejected') {
      console.error('[scheduler] sub-tick failed:', r.reason && r.reason.message || r.reason);
      await notifySchedulerFailure(pool, flags, state, job, r.reason);
    } else if (r.value && r.value.error) {
      await notifySchedulerFailure(pool, flags, state, job, r.value);
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
    await notifySchedulerFailure(pool, flags, state, 'anomaly', err);
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

module.exports = {
  start,
  stop,
  tick,
  // Exported for server.js so the payment.verify and slip auto-verify
  // paths can reinstate cards the moment a tenant clears their overdue
  // balance — instead of forcing them to wait for the next daily tick.
  restoreAccessCardsForTenantIfClear,
  ACCESS_CARD_AUTO_REVOKE_REASON,
  // R6 — exposed for /admin#health so the UI can surface an actionable
  // "deploy is missing a persistent volume" warning when the scheduler
  // state file is on ephemeral storage.
  isStateFilePersistent,
  // Exposed for tests (tests/fix-scheduler.test.js): the pure due-date
  // helper, the lock + cross-replica latch wrapper, and the ticks that are
  // exercised with fake pools.
  billGenDueDateFor,
  _withAdvisoryLock,
  tickLateFee,
  tickAutoBackup,
};
