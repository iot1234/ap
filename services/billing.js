// services/billing.js
// Pure functions for computing a bill. No DB, no I/O — easy to unit test.
// Schema produced here is what /api/bills/render expects and what we now
// also persist in the bills table.

const pricing = require('./pricing');

/**
 * Build a bill from room + meter readings + config + features.
 *
 * Rent resolution priority (services/pricing.js#resolveBillingRent):
 *   1. contract.monthly_rent (active contract → locked rate)
 *   2. room.rent_override / room.rentOverride (per-room special rate)
 *   3. computeFromFormula(room, config) (config.rates + premiums)
 *   4. room.rent (legacy fallback)
 *
 * Callers should pass `contract` whenever the room is occupied. Without
 * it, the resolver falls back to formula → legacy room.rent. Existing
 * code paths that don't pass `contract` keep working unchanged.
 *
 * @param {object} opts
 * @param {object} opts.room       - { id, rent, tenant?, waterUnits?, elecUnits?, type?, floor?, view?, rent_override? }
 * @param {object} opts.config     - { utilities: { waterRate, elecRate, wifi }, building, rates, floorPremium, viewPremium, featurePremium }
 * @param {object} opts.features   - feature flag map (lateFee, vat, recurringCharges)
 * @param {object} [opts.contract] - active contract row (id, status, monthly_rent, discount_pct)
 * @param {object} [opts.previous] - previous bill for late-fee calc { paidAt, dueDate, total, status }
 * @param {Array}  [opts.recurring] - extra line items [{ label, amount }]
 * @param {string} [opts.period]   - "2026-05" or human-readable
 * @param {string} [opts.dueDate]  - ISO date "YYYY-MM-DD"
 * @returns {object} bill ready for PDF rendering or DB insert. Adds
 *                   rentSource ('contract'|'override'|'formula'|'legacy')
 *                   so admin can audit-log why a bill came out at a given price.
 */
function buildBill({ room, contract = null, config, features, previous = null, recurring = [], period, dueDate, discountPct = 0, isFirstBill = false }) {
  const u = (config && config.utilities) || {};
  const waterRate = Number(u.waterRate ?? 18);
  const elecRate  = Number(u.elecRate  ?? 8);
  const wifiFee   = Number(u.wifi      ?? 0);

  // Resolver picks the right rent source. See services/pricing.js for
  // priority + rationale.
  const resolved = pricing.resolveBillingRent({ room, contract, config });
  const rentBase = Number(resolved.rent) || 0;
  const waterUsage = resolveUtilityUsage(room, 'water');
  const elecUsage = resolveUtilityUsage(room, 'elec');
  const waterUnits = waterUsage.units;
  const elecUnits  = elecUsage.units;
  const waterAmount = waterUnits * waterRate;
  const elecAmount  = elecUnits  * elecRate;

  // Contract-length discount applies only to the rent portion (utilities
  // are pass-through cost — discounting kWh would underbill). discountPct
  // comes from contracts.discount_pct, populated at check-in based on
  // termMonths + config.discounts.{sixMonth,twelveMonth,twentyFourMonth}.
  // Cap at 50% defensively so a misconfigured row can't zero the rent.
  // First-month discount stacks on top of the contract discount when
  // isFirstBill is true — caller flips this on for the welcome bill so
  // tenants who took the "first-month-X%-off" promotion actually see it
  // applied. Without isFirstBill, only the contract discount fires.
  const contractPct = Math.max(0, Math.min(50, Number(discountPct) || 0));
  const firstMonthPctRaw = isFirstBill && config?.discounts?.firstMonth
    ? Number(config.discounts.firstMonth) || 0
    : 0;
  const firstMonthPct = Math.max(0, Math.min(50, firstMonthPctRaw));
  // Combine multiplicatively so 10% + 5% = 14.5% off, not 15%. Caps
  // total effective discount at 50% so even stacked promos can't zero the rent.
  const combinedPct = Math.min(50,
    100 * (1 - (1 - contractPct / 100) * (1 - firstMonthPct / 100)));
  const safePct = round2(combinedPct);
  const rent = round2(rentBase * (1 - safePct / 100));
  const discountAmount = round2(rentBase - rent);

  // Items show the FULL rent on the rent line and the discount as a
  // separate negative line — keeps the receipt transparent (tenant sees
  // both the headline rent and the discount they're getting). Subtotal
  // math matches: rentBase + utilities + (-discountAmount) = rent + utilities.
  const items = [
    { label: 'ค่าเช่าห้องพัก', qty: '1 เดือน', amount: rentBase },
    buildUtilityItem('ค่าน้ำ', waterUsage, waterRate, waterAmount),
    buildUtilityItem('ค่าไฟฟ้า', elecUsage, elecRate, elecAmount),
  ];
  if (wifiFee > 0) items.push({ label: 'ค่าอินเทอร์เน็ต', qty: '1 เดือน', amount: wifiFee });
  if (discountAmount > 0) {
    items.push({
      label: `ส่วนลดสัญญา ${safePct}%`,
      qty: '',
      amount: -discountAmount,
    });
  }

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
    rent, rentBase, discountPct: safePct, discountAmount,
    waterUnits, waterRate, waterAmount,
    waterPrevReading: waterUsage.prevReading,
    waterCurrentReading: waterUsage.currentReading,
    elecUnits, elecRate, elecAmount,
    elecPrevReading: elecUsage.prevReading,
    elecCurrentReading: elecUsage.currentReading,
    wifi: wifiFee,
    subtotal: round2(subtotal),
    vat,
    lateFee,
    total,
    // Pricing audit trail — tells admin / future-you why this bill came
    // out at this price. 'contract' = locked at signing; 'override' =
    // admin special; 'formula' = current config; 'legacy' = pre-resolver
    // fallback. Used by /admin#billing to flag mismatch between bill price
    // and current formula (helpful when admin asks "why is this bill
    // different from what I see in /admin#pricing?").
    rentSource: resolved.source,
    rentSourceContractId: resolved.contractId || null,
    rentSourceReason: resolved.reason || null,
    building: (config && config.building) || {},
    ...buildPaymentBlock(config),
  };
}

function firstFinite(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function resolveUtilityUsage(room, prefix) {
  const prevReading = firstFinite(
    room?.[`${prefix}PrevReading`],
    room?.[`${prefix}PreviousReading`],
    room?.[`${prefix}ReadingBefore`],
    room?.[`${prefix}Before`]
  );
  const currentReading = firstFinite(
    room?.[`${prefix}CurrentReading`],
    room?.[`${prefix}ReadingAfter`],
    room?.[`${prefix}After`]
  );
  const fallbackUnits = Math.max(0, Number(room?.[`${prefix}Units`]) || 0);
  let units = fallbackUnits;
  if (prevReading != null && currentReading != null) {
    units = Math.max(0, round2(currentReading - prevReading));
  }
  return {
    units,
    prevReading,
    currentReading,
    hasReadings: prevReading != null && currentReading != null,
  };
}

function fmtQty(n) {
  const value = Number(n) || 0;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function buildUtilityItem(label, usage, rate, amount) {
  const item = {
    label,
    qty: `${fmtQty(usage.units)} หน่วย × ${fmtQty(rate)}`,
    amount,
  };
  if (usage.hasReadings) {
    item.detail = `เลขก่อน ${fmtQty(usage.prevReading)}  เลขหลัง ${fmtQty(usage.currentReading)}  ใช้ ${fmtQty(usage.units)} หน่วย`;
  }
  return item;
}

/**
 * Extract a unified payment block from config.payment so PDFs and tenant
 * portal both see the same shape. Includes PromptPay (primary), bank transfer
 * details, and the toggles for LINE Pay / TrueMoney / credit card so they can
 * be advertised on the invoice even though we don't process them in-app.
 */
function buildPaymentBlock(config) {
  const p = (config && config.payment) || {};
  const promptpayTarget = p.promptpay || p.promptpayTarget || undefined;
  const promptpayName = p.promptpayDisplayName || p.bankName || undefined;
  const bank = p.bank ? {
    bank: p.bank,
    account: p.bankAcc || '',
    name: p.bankName || '',
  } : null;
  const methods = [];
  if (promptpayTarget) methods.push({ key: 'promptpay', label: 'PromptPay', enabled: true });
  if (bank && bank.account) methods.push({ key: 'bank', label: `${bank.bank} • ${bank.account}`, enabled: true });
  if (p.linePay)    methods.push({ key: 'linePay',    label: 'LINE Pay',          enabled: true });
  if (p.truemoney)  methods.push({ key: 'truemoney',  label: 'TrueMoney Wallet',  enabled: true });
  if (p.creditCard) methods.push({ key: 'creditCard', label: 'บัตรเครดิต/เดบิต', enabled: true });
  return {
    promptpayTarget,
    promptpayName,
    bankInfo: bank,
    paymentMethods: methods,
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
  // Build YYYY-MM-DD by reading LOCAL year/month — never round-trip through
  // toISOString() because that converts to UTC and on Asia/Bangkok (UTC+7)
  // it would shift the date back by ~17h, returning the wrong day-string
  // for any moment between midnight and 7am local. The dom argument is a
  // day-of-month, not a wall-clock instant; combining it with the current
  // local year/month + zero-padding produces the operator's intent
  // regardless of the server's timezone.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(Math.max(1, Math.min(28, Number(dom) || 15))).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Build a YYYY-MM-DD string for a specific (year, month, day) without going
// through Date → toISOString. Same timezone-safety reasoning as
// formatDueDate. Caller passes the human values they mean (year, 1-indexed
// month, day-of-month). Used by the scheduler + bulk-generate paths.
function formatYMD(year, monthOneIndexed, day) {
  const y = String(Number(year) || new Date().getFullYear()).padStart(4, '0');
  const m = String(Number(monthOneIndexed) || 1).padStart(2, '0');
  const d = String(Number(day) || 1).padStart(2, '0');
  return `${y}-${m}-${d}`;
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

/**
 * Decide whether a recurring_charge row should be included on the bill for
 * the given period. Honors `frequency`:
 *   - 'monthly'   : every month
 *   - 'one_off'   : every month while active (caller is responsible for
 *                   deactivating after first use — see scheduler.js + bills POST)
 *   - 'quarterly' : every 3rd month, anchored to start_at month (1 if not set)
 *
 * Without this filter, quarterly charges were being billed every month —
 * silent overcharge to tenants on charges like "ค่าทำความสะอาดทุก 3 เดือน".
 *
 * @param {object} charge - { frequency, start_at?, end_at? }
 * @param {string} period - "YYYY-MM"
 */
function isChargeApplicableForPeriod(charge, period) {
  if (!charge || !period) return false;
  const m = String(period).match(/^(\d{4})-(\d{2})$/);
  if (!m) return false;
  const periodYear = Number(m[1]);
  const periodMonth = Number(m[2]);
  // Reject impossible months — the regex above accepts "2026-13" / "2026-00"
  // because it only checks digit count. Without this, a malformed period
  // would slip through and the JS Date math below produces garbage.
  if (periodMonth < 1 || periodMonth > 12) return false;
  // Use the first day of the period for date comparisons.
  const periodStart = new Date(Date.UTC(periodYear, periodMonth - 1, 1));
  if (charge.start_at) {
    const s = new Date(charge.start_at);
    if (Number.isFinite(s.getTime())) {
      // Compare to the LAST day of the period so a charge starting mid-month
      // still counts for that month.
      const periodEnd = new Date(Date.UTC(periodYear, periodMonth, 0, 23, 59, 59));
      if (s.getTime() > periodEnd.getTime()) return false;
    }
  }
  if (charge.end_at) {
    const e = new Date(charge.end_at);
    if (Number.isFinite(e.getTime()) && e.getTime() < periodStart.getTime()) return false;
  }
  const freq = charge.frequency || 'monthly';
  if (freq === 'monthly' || freq === 'one_off') return true;
  if (freq === 'quarterly') {
    // Anchor month: start_at month if set, otherwise January.
    const anchorMonth = charge.start_at && Number.isFinite(new Date(charge.start_at).getTime())
      ? new Date(charge.start_at).getUTCMonth() + 1
      : 1;
    // (periodMonth - anchorMonth) mod 3 === 0  → fires this month.
    // Add 12 before modulo to handle negatives (Jan period vs Apr anchor).
    return (((periodMonth - anchorMonth) % 3) + 3) % 3 === 0;
  }
  // Unknown frequency — treat as monthly (safest default; surfaced via admin).
  return true;
}

// Tolerance (Thai baht) for accepting a payment whose amount differs from
// the bill total. Banks round in different directions for fees/discounts
// (e.g. PromptPay ±0.50, some processors ±1.00), so a strict equality
// would reject legitimate slips. Exported as a single source of truth so
// the four enforcement points stay in sync:
//   1) POST /api/tenant/payments        (tenant slip upload)
//   2) PUT  /api/payments/:id/verify    (admin verify by payment id)
//   3) POST /api/bills/:id/verify-slip  (admin verify by bill id)
//   4) POST /api/bills/:id/pay          (admin offline manual pay)
//   5) services/slipVerifier#verifyOne  (provider amount cross-check)
//   6) services/healthCheck data integrity
// Tightening this value affects all six paths together — that's the point.
const PAYMENT_TOLERANCE_THB = 1.0;

module.exports = {
  buildBill, buildPaymentBlock, statusOf, makeBillNo,
  formatPeriodNow, formatDueDate, formatYMD, round2,
  resolveUtilityUsage, buildUtilityItem,
  isChargeApplicableForPeriod,
  PAYMENT_TOLERANCE_THB,
};
