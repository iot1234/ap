// services/billing.js
// Pure functions for computing a bill. No DB, no I/O — easy to unit test.
// Schema produced here is what /api/bills/render expects and what we now
// also persist in the bills table.

/**
 * Build a bill from room + meter readings + config + features.
 *
 * @param {object} opts
 * @param {object} opts.room       - { id, rent, tenant?, waterUnits?, elecUnits?, ... }
 * @param {object} opts.config     - { utilities: { waterRate, elecRate, wifi }, building: { ... } }
 * @param {object} opts.features   - feature flag map (lateFee, vat, recurringCharges)
 * @param {object} [opts.previous] - previous bill for late-fee calc { paidAt, dueDate, total, status }
 * @param {Array}  [opts.recurring] - extra line items [{ label, amount }]
 * @param {string} [opts.period]   - "2026-05" or human-readable
 * @param {string} [opts.dueDate]  - ISO date "YYYY-MM-DD"
 * @returns {object} bill ready for PDF rendering or DB insert
 */
function buildBill({ room, config, features, previous = null, recurring = [], period, dueDate }) {
  const u = (config && config.utilities) || {};
  const waterRate = Number(u.waterRate ?? 18);
  const elecRate  = Number(u.elecRate  ?? 8);
  const wifiFee   = Number(u.wifi      ?? 0);

  const rent = Number(room.rent) || 0;
  const waterUnits = Number(room.waterUnits) || 0;
  const elecUnits  = Number(room.elecUnits)  || 0;
  const waterAmount = waterUnits * waterRate;
  const elecAmount  = elecUnits  * elecRate;

  const items = [
    { label: 'ค่าเช่าห้องพัก', qty: '1 เดือน', amount: rent },
    { label: 'ค่าน้ำ', qty: `${waterUnits} หน่วย × ${waterRate}`, amount: waterAmount },
    { label: 'ค่าไฟฟ้า', qty: `${elecUnits} หน่วย × ${elecRate}`, amount: elecAmount },
  ];
  if (wifiFee > 0) items.push({ label: 'ค่าอินเทอร์เน็ต', qty: '1 เดือน', amount: wifiFee });

  // Recurring extras (parking, cleaning, etc.)
  if (features?.recurringCharges?.enabled && Array.isArray(recurring)) {
    for (const r of recurring) {
      const amt = Number(r.amount) || 0;
      if (amt > 0) items.push({ label: String(r.label || 'อื่นๆ'), qty: '', amount: amt });
    }
  }

  let subtotal = items.reduce((s, it) => s + (Number(it.amount) || 0), 0);

  // Late fee from previous bill
  let lateFee = 0;
  if (features?.lateFee?.enabled && previous && previous.status === 'overdue') {
    const grace = Number(features.lateFee.gracePeriodDays || 0);
    const ratePctMonth = Number(features.lateFee.ratePctPerMonth || 0);
    const due = previous.dueDate ? new Date(previous.dueDate) : null;
    if (due && Number.isFinite(due.getTime())) {
      const daysOver = Math.max(0, Math.floor((Date.now() - due.getTime()) / 86_400_000) - grace);
      if (daysOver > 0) {
        const monthsOver = daysOver / 30;
        lateFee = round2((Number(previous.total) || 0) * (ratePctMonth / 100) * monthsOver);
        if (lateFee > 0) {
          items.push({ label: `ค่าปรับชำระล่าช้า (${daysOver} วัน)`, qty: '', amount: lateFee });
          subtotal += lateFee;
        }
      }
    }
  }

  // VAT — added on top of subtotal (excludes from base by default)
  let vat = 0;
  if (features?.vat?.enabled) {
    const ratePct = Number(features.vat.ratePct || 0);
    vat = round2(subtotal * (ratePct / 100));
    if (vat > 0) items.push({ label: `ภาษีมูลค่าเพิ่ม ${ratePct}%`, qty: '', amount: vat });
  }

  const total = round2(subtotal + vat);
  const billNo = makeBillNo(room.id, period);

  return {
    billNo,
    roomId: room.id,
    tenantName: room.tenant?.name || '',
    tenantPhone: room.tenant?.phone || '',
    period: period || formatPeriodNow(),
    dueDate: dueDate || formatDueDate(15),
    items,
    rent, waterUnits, waterRate, waterAmount,
    elecUnits, elecRate, elecAmount,
    wifi: wifiFee,
    subtotal: round2(subtotal),
    vat,
    lateFee,
    total,
    building: (config && config.building) || {},
    promptpayTarget: (config && config.payment && config.payment.promptpayTarget) || undefined,
  };
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function makeBillNo(roomId, period) {
  const safe = String(roomId || '000').replace(/[^A-Za-z0-9_-]/g, '');
  const p = (period || formatPeriodNow()).replace(/\s+/g, '-');
  return `INV-${p}-${safe}`;
}

function formatPeriodNow() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function formatDueDate(dom = 15) {
  const d = new Date();
  d.setDate(dom);
  return d.toISOString().slice(0, 10);
}

/**
 * Decide a bill's status from due_date + paid_at.
 */
function statusOf(bill, now = new Date()) {
  if (bill.paid_at) return 'paid';
  if (!bill.due_date) return 'pending';
  const due = new Date(bill.due_date);
  if (due.getTime() < now.getTime()) return 'overdue';
  return 'pending';
}

module.exports = { buildBill, statusOf, makeBillNo, formatPeriodNow, formatDueDate, round2 };
