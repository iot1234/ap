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
const SEVERITY_EMOJI = { ok: '✅', warn: '⚠️', error: '🚨' };

function ageMin(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 60_000;
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
    const prev = state.healthStatus[c.id] || { status: 'ok', notifiedAt: null };
    const worsened =
      (prev.status === 'ok' && (c.status === 'warn' || c.status === 'error')) ||
      (prev.status === 'warn' && c.status === 'error');
    const escalate =
      c.status === 'error' &&
      prev.status === 'error' &&
      ageMin(prev.notifiedAt) >= RE_ALERT_AFTER_MIN;
    const recovered = (prev.status === 'warn' || prev.status === 'error') && c.status === 'ok';

    if (worsened || escalate || recovered) {
      alerts.push({
        check: c, prevStatus: prev.status, recovered,
      });
      state.healthStatus[c.id] = {
        status: c.status,
        message: c.message,
        notifiedAt: new Date().toISOString(),
      };
    } else {
      // Update status without bumping notifiedAt so escalation timer keeps running
      state.healthStatus[c.id] = {
        status: c.status,
        message: c.message,
        notifiedAt: prev.notifiedAt,
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
  const subject = alerts.some((a) => a.check.status === 'error' && !a.recovered)
    ? '🚨 ระบบมีปัญหา (Health Alert)'
    : alerts.every((a) => a.recovered)
      ? '✅ ระบบกลับมาทำงานปกติ'
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
