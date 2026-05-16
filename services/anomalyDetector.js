// services/anomalyDetector.js
// Periodic health probe → owner notification on state TRANSITIONS only.
//
// Without the transition guard, every tick where (say) SMTP is broken would
// re-spam the owner every hour. We track previous status per check id in
// the scheduler state file; only notify when:
//   - status worsened (ok → warn|error, or warn → error)
//   - or stayed in error for ≥ 60min since last alert (escalation)
//   - resolution: warn|error → ok fires a single "✅ recovered" alert
//
// The full report stays in /api/admin/health for the dashboard. This file
// is the active alerting layer on top.

const healthCheck = require('./healthCheck');
const notifier = require('./notifier');
const features = require('./features');

const RE_ALERT_AFTER_MIN = 60;
// Cap escalation at 24h between repeated alerts so long-running incidents
// don't spam the owner every hour for days. Doubling pattern: 1h, 2h, 4h,
// 8h, 16h, 24h (capped). escalationCount on the state row drives this.
const ESCALATION_CAP_MIN = 24 * 60;
const SEVERITY_EMOJI = { ok: '✅', warn: '⚠️', error: '🚨' };

function ageMin(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 60_000;
}

function escalationDelayMin(count) {
  // count=0 → 60min (first re-alert), count=1 → 120min, …, capped at 24h.
  const n = Number.isFinite(count) ? Math.max(0, count) : 0;
  const minutes = RE_ALERT_AFTER_MIN * Math.pow(2, n);
  return Math.min(minutes, ESCALATION_CAP_MIN);
}

/**
 * Compare current report against last-known statuses, decide which checks
 * deserve a notification, and update the state object in place.
 *
 * @param {object} state - the scheduler state file blob; we mutate
 *                         state.healthStatus[checkId] with the new entry.
 * @param {object} report - output of healthCheck.runChecks()
 * @returns {Array<{check, prevStatus, severity, message}>} alerts to send
 */
function diffAndUpdate(state, report) {
  if (!state.healthStatus || typeof state.healthStatus !== 'object') {
    state.healthStatus = {};
  }
  const alerts = [];
  for (const c of report.checks) {
    const prev = state.healthStatus[c.id] || { status: 'ok', notifiedAt: null, escalationCount: 0 };
    const worsened =
      (prev.status === 'ok' && (c.status === 'warn' || c.status === 'error')) ||
      (prev.status === 'warn' && c.status === 'error');
    // Escalation uses exponential backoff: 1h, 2h, 4h, …, capped at 24h.
    // Without this, an error that persists for days re-alerts every 60min
    // and the operator stops paying attention. Spreading later alerts out
    // keeps signal-to-noise reasonable while still guaranteeing a fresh
    // ping at least once a day.
    const escalate =
      c.status === 'error' &&
      prev.status === 'error' &&
      ageMin(prev.notifiedAt) >= escalationDelayMin(prev.escalationCount || 0);
    // Partial recovery: error → warn is *better* than before, so the owner
    // should know the system is healing even though it isn't fully OK yet.
    // Treated as a "recovered" alert (single ✅-flavoured message). Without
    // this branch the transition fell through every guard and the owner
    // never learned the issue partially resolved until full recovery (or
    // until the 60-minute escalation re-fired the original error message).
    const partialRecovery = prev.status === 'error' && c.status === 'warn';
    const recovered =
      ((prev.status === 'warn' || prev.status === 'error') && c.status === 'ok') ||
      partialRecovery;

    if (worsened || escalate || recovered) {
      alerts.push({
        check: c, prevStatus: prev.status, recovered,
      });
      // Reset escalation count on recovery / status change; bump on each
      // same-state escalation so the next interval doubles. Capped inside
      // escalationDelayMin().
      const nextCount = recovered || c.status !== prev.status
        ? 0
        : (Number(prev.escalationCount) || 0) + 1;
      state.healthStatus[c.id] = {
        status: c.status,
        message: c.message,
        notifiedAt: new Date().toISOString(),
        escalationCount: nextCount,
      };
    } else {
      // Update status without bumping notifiedAt so escalation timer keeps running
      state.healthStatus[c.id] = {
        status: c.status,
        message: c.message,
        notifiedAt: prev.notifiedAt,
        escalationCount: prev.escalationCount || 0,
      };
    }
  }
  return alerts;
}

/**
 * Run the probe and dispatch alerts. Called from services/scheduler.js
 * tick(). Fail-soft — never throws, never blocks the rest of the tick.
 *
 * @param {object} pool
 * @param {object} state - scheduler state file blob (mutated)
 */
async function tick(pool, state) {
  let report;
  try {
    report = await healthCheck.runChecks(pool);
  } catch (err) {
    console.warn('[anomaly] runChecks failed:', err.message);
    return;
  }
  // Always remember when we last ran (lets the dashboard show staleness).
  state.lastHealthCheckAt = new Date().toISOString();
  state.lastHealthSeverity = report.severity;

  const alerts = diffAndUpdate(state, report);
  if (!alerts.length) return;

  // Group alerts into a single owner message so a multi-failure event
  // (e.g. DB down → also takes out queue + lockouts checks) doesn't
  // produce 4 separate LINE pings.
  const lines = alerts.map((a) => {
    const emoji = a.recovered ? SEVERITY_EMOJI.ok : SEVERITY_EMOJI[a.check.status];
    const tag = a.recovered ? 'recovered' : `${a.prevStatus}→${a.check.status}`;
    return `${emoji} ${a.check.label} (${tag}): ${a.check.message}`;
  });
  // "Fully recovered" only means every alert is back to OK. A partial
  // recovery (error → warn) still leaves a warn condition active, so the
  // headline must reflect that — otherwise admin reads "✅ ระบบกลับมาทำงาน
  // ปกติ" and stops investigating while the warn is still firing.
  const fullyRecovered = alerts.every(
    (a) => a.recovered && a.check.status === 'ok'
  );
  const subject = alerts.some((a) => a.check.status === 'error' && !a.recovered)
    ? '🚨 ระบบมีปัญหา (Health Alert)'
    : fullyRecovered
      ? '✅ ระบบกลับมาทำงานปกติ'
      : alerts.every((a) => a.recovered)
        ? '⚠️ ระบบดีขึ้นบางส่วน (ยังมี warn)'
        : '⚠️ ระบบมีบางส่วนผิดปกติ';
  try {
    const flags = await features.load(pool);
    await notifier.notifyOwner({ pool, features: flags }, {
      subject,
      text: `${subject}\n\n${lines.join('\n')}\n\nดูรายละเอียดเต็ม: /admin#health`,
    });
  } catch (err) {
    console.warn('[anomaly] notify failed:', err.message);
  }
}

module.exports = { tick, diffAndUpdate, RE_ALERT_AFTER_MIN };
