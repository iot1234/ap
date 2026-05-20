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
 * LATE FEE POLICY (R2): buildBill itself NEVER computes a late fee from a
 * previous overdue bill. Late fees are owned by services/scheduler.js#tickLateFee,
 * which updates the *previous* bill's `late_fee` + `total` in-place when it
 * flips pending → overdue. This keeps each bill self-contained: a tenant
 * viewing the old bill sees the current amount due (with late fee folded in),
 * not a stale total that's contradicted by the new month's bill. Callers may
 * still pass `previous` for forward compat, but the value is ignored.
 *
 * VAT POLICY (R1): VAT applies to vatBase = rent + utilities + wifi + recurring
 * - discount. It does NOT apply to late_fee — Thai tax rules treat penalty
 * charges as outside the VAT-able rental/utility revenue stream.
 *
 * @param {object} opts
 * @param {object} opts.room       - { id, rent, tenant?, waterUnits?, elecUnits?, type?, floor?, view?, rent_override? }
 * @param {object} opts.config     - { utilities: { waterRate, elecRate, wifi }, building, rates, floorPremium, viewPremium, featurePremium }
 * @param {object} opts.features   - feature flag map (vat, recurringCharges) — note: lateFee.* is read by scheduler.tickLateFee, not here
 * @param {object} [opts.contract] - active contract row (id, status, monthly_rent, discount_pct)
 * @param {Array}  [opts.recurring] - extra line items [{ label, amount }]
 * @param {string} [opts.period]   - "2026-05" or human-readable
 * @param {string} [opts.dueDate]  - ISO date "YYYY-MM-DD"
 * @returns {object} bill ready for PDF rendering or DB insert. Adds
 *                   rentSource ('contract'|'override'|'formula'|'legacy')
 *                   so admin can audit-log why a bill came out at a given price.
 *                   Always returns lateFee: 0 — the previous overdue's fee
 *                   lives on the previous bill, not on this new one.
 */
function buildBill({ room, contract = null, config, features, recurring = [], period, dueDate, discountPct = 0, isFirstBill = false }) {
  const u = (config && config.utilities) || {};
  // Rate resolution: each utility prefers a per-room override (room blob
  // accepts both camelCase + snake_case to match rooms_v2 columns) then
  // falls back to the building-wide rate. Pattern parallels rent_override
  // in services/pricing.js so admin can run two pricing tiers in the same
  // building (e.g. older units on cheaper meter contract) without forking
  // the global rate.
  //
  // Guard: per-room values must be finite + non-negative. Negative or
  // NaN slip back to the global rate so a typo in /admin#rooms can't
  // accidentally credit the tenant.
  const positiveRateOrFallback = (overrideValue, fallback) => {
    if (overrideValue == null || overrideValue === '') return fallback;
    const n = Number(overrideValue);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const globalWaterRate = Number(u.waterRate ?? 18);
  const globalElecRate  = Number(u.elecRate  ?? 8);
  const globalWifiFee   = Number(u.wifi      ?? 0);
  const r = room || {};
  const waterRate = positiveRateOrFallback(r.waterRateOverride ?? r.water_rate_override, globalWaterRate);
  const elecRate  = positiveRateOrFallback(r.elecRateOverride  ?? r.elec_rate_override,  globalElecRate);
  // Wifi already had a quasi-override (room.wifi) on the client preview
  // path — make it authoritative on the server too so /admin#billing
  // preview and the actual generated bill agree. Honor wifi=0 as a real
  // override (free wifi for this unit), not as "use global".
  const wifiOverrideRaw = r.wifiOverride ?? r.wifi_override ?? r.wifi;
  const wifiFee = wifiOverrideRaw != null && wifiOverrideRaw !== '' && Number.isFinite(Number(wifiOverrideRaw))
    ? Math.max(0, Number(wifiOverrideRaw))
    : globalWifiFee;
  const waterRateSource = waterRate !== globalWaterRate ? 'override' : 'global';
  const elecRateSource  = elecRate  !== globalElecRate  ? 'override' : 'global';
  const wifiFeeSource   = wifiFee   !== globalWifiFee   ? 'override' : 'global';

  // Resolver picks the right rent source. See services/pricing.js for
  // priority + rationale.
  const resolved = pricing.resolveBillingRent({ room, contract, config });
  const rentBase = Number(resolved.rent) || 0;
  // Billing mode resolution per utility — admin can pick 'flat' (เหมา)
  // for rooms that don't have a real meter (older units, single-tenant
  // serviced rooms where utilities are bundled). Three states:
  //   1. mode='flat' AND flat amount > 0 → bill the flat number, drop
  //      units/rate from the line item.
  //   2. mode='flat' BUT flat amount missing/<=0 → fall back to metered
  //      and surface a "flat amount not set" note so admin notices
  //      before the bill goes out (defence-in-depth).
  //   3. mode='metered' (default for legacy rooms without a mode field) →
  //      existing units × rate.
  // Accept both camelCase (blob) + snake_case (rooms_v2 columns).
  const resolveFlatMode = (modeRaw, flatRaw) => {
    const requested = String(modeRaw || '').toLowerCase();
    if (requested !== 'flat') return { mode: 'metered', flat: 0 };
    const flat = Number(flatRaw);
    if (!Number.isFinite(flat) || flat <= 0) {
      return { mode: 'metered', flat: 0, fellBack: true };
    }
    return { mode: 'flat', flat };
  };
  const waterModeInfo = resolveFlatMode(
    r.waterMode ?? r.water_mode,
    r.waterFlatAmount ?? r.water_flat_amount
  );
  const elecModeInfo = resolveFlatMode(
    r.elecMode ?? r.elec_mode,
    r.elecFlatAmount ?? r.elec_flat_amount
  );
  const waterUsage = resolveUtilityUsage(room, 'water');
  const elecUsage = resolveUtilityUsage(room, 'elec');
  const waterUnits = waterModeInfo.mode === 'flat' ? 0 : waterUsage.units;
  const elecUnits  = elecModeInfo.mode  === 'flat' ? 0 : elecUsage.units;
  const waterAmount = waterModeInfo.mode === 'flat'
    ? round2(waterModeInfo.flat)
    : round2(waterUnits * waterRate);
  const elecAmount = elecModeInfo.mode === 'flat'
    ? round2(elecModeInfo.flat)
    : round2(elecUnits * elecRate);
  // Zero out rate on the bill row when flat — the rate column is
  // meaningless for a flat charge and printing "× 0" confuses tenants.
  const effectiveWaterRate = waterModeInfo.mode === 'flat' ? 0 : waterRate;
  const effectiveElecRate  = elecModeInfo.mode  === 'flat' ? 0 : elecRate;

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
  // Flat-mode utility item — different shape from buildUtilityItem since
  // there are no readings/units/rate to display. Tenant sees "ค่าน้ำเหมา
  // รายเดือน" so they don't dispute "why was I charged 300 when my meter
  // says 5 units" — the bill makes the billing mode explicit.
  const flatItem = (label, amount) => ({
    label: `${label} (เหมา)`,
    qty: '1 เดือน',
    amount,
    detail: 'ค่าเหมารายเดือน — ไม่นับตามเลขมิเตอร์',
  });
  const items = [
    { label: 'ค่าเช่าห้องพัก', qty: '1 เดือน', amount: rentBase },
    waterModeInfo.mode === 'flat'
      ? flatItem('ค่าน้ำ', waterAmount)
      : buildUtilityItem('ค่าน้ำ', waterUsage, waterRate, waterAmount),
    elecModeInfo.mode === 'flat'
      ? flatItem('ค่าไฟฟ้า', elecAmount)
      : buildUtilityItem('ค่าไฟฟ้า', elecUsage, elecRate, elecAmount),
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

  // vatBase = rent + utilities + wifi + recurring - discount.
  // This is BEFORE late_fee and BEFORE vat — it's the taxable amount.
  // Round at each accumulation step so VAT/total math runs on stable
  // 2-decimal values. Items are individually rounded but a raw reduce of
  // floats can drift sub-cent; rounding here keeps the bill total exactly
  // equal to the displayed line-item sum (also matches the bill renderer).
  //
  // R1 — VAT applies to the rental/utility/recurring revenue stream only.
  // Late fees are penalty charges (ค่าปรับ) which are out-of-scope for
  // Thai VAT, so they sit AFTER vat on the bill and don't inflate the
  // tax base. Stacking them inside subtotal would silently overcharge VAT
  // on penalties — a real tenant-dispute risk.
  const vatBase = round2(items.reduce((s, it) => s + (Number(it.amount) || 0), 0));

  // VAT — computed on vatBase, NOT on (vatBase + lateFee).
  let vat = 0;
  if (features?.vat?.enabled) {
    const ratePct = Number(features.vat.ratePct || 0);
    vat = round2(vatBase * (ratePct / 100));
    if (vat > 0) items.push({ label: `ภาษีมูลค่าเพิ่ม ${ratePct}%`, qty: '', amount: vat });
  }

  // R2 — late_fee is owned by services/scheduler.js#tickLateFee and lives
  // on the *previous* overdue bill (updated in-place when the bill flips
  // pending → overdue). A freshly-generated bill always starts with
  // late_fee=0 — there is no carry-over of last month's penalty into this
  // month's invoice.
  const lateFee = 0;

  // subtotal = vatBase (everything before VAT, before late_fee). Stored
  // separately from total so the bill PDF can show the breakdown clearly:
  //   subtotal (vatable) + vat + late_fee = total
  // chk_bills_amounts_nonnegative requires subtotal >= 0 — vatBase already
  // round2'd so this can't go negative even when discount > base (the
  // discount cap at 50% prevents that anyway).
  const subtotal = vatBase;
  const total = round2(subtotal + vat + lateFee);
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
    waterUnits, waterRate: effectiveWaterRate, waterAmount,
    waterRateSource,    // 'override' | 'global' — admin can audit which
    waterMode: waterModeInfo.mode,      // 'flat' | 'metered'
    waterFlatFellBack: !!waterModeInfo.fellBack,
    waterPrevReading: waterModeInfo.mode === 'flat' ? null : waterUsage.prevReading,
    waterCurrentReading: waterModeInfo.mode === 'flat' ? null : waterUsage.currentReading,
    elecUnits, elecRate: effectiveElecRate, elecAmount,
    elecRateSource,
    elecMode: elecModeInfo.mode,
    elecFlatFellBack: !!elecModeInfo.fellBack,
    elecPrevReading: elecModeInfo.mode === 'flat' ? null : elecUsage.prevReading,
    elecCurrentReading: elecModeInfo.mode === 'flat' ? null : elecUsage.currentReading,
    wifi: wifiFee,
    wifiFeeSource,
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
  // Accept null/undefined rooms gracefully — every reader (bill builder,
  // tenant portal, admin preview) calls this with whatever the caller has,
  // including legacy blobs missing meter fields entirely. Returning a
  // zero-shape lets the bill render the "no usage / no meter" branch
  // without a defensive guard at every call site.
  const r = room || {};
  const prevReading = firstFinite(
    r[`${prefix}PrevReading`],
    r[`${prefix}PreviousReading`],
    r[`${prefix}ReadingBefore`],
    r[`${prefix}Before`]
  );
  const currentReading = firstFinite(
    r[`${prefix}CurrentReading`],
    r[`${prefix}ReadingAfter`],
    r[`${prefix}After`]
  );
  const rawUnits = Number(r[`${prefix}Units`]);
  const fallbackUnits = Number.isFinite(rawUnits) ? Math.max(0, rawUnits) : 0;
  let units = fallbackUnits;
  if (prevReading != null && currentReading != null) {
    // Clamp negative usage (meter reset / typo) to 0 instead of billing the
    // tenant for a negative number of kWh. The detail line in
    // buildUtilityItem surfaces the anomaly so admin can fix the reading
    // before the bill goes out.
    units = Math.max(0, round2(currentReading - prevReading));
  }
  return {
    units,
    prevReading,
    currentReading,
    hasReadings: prevReading != null && currentReading != null,
  };
}

// Sibling resolver for bills already persisted in the `bills` table.
// The DB row uses snake_case (`water_prev_reading` etc.) so the room-shape
// resolver above can't be used directly. Both functions return the same
// shape so buildUtilityItem treats them interchangeably. Trusts the stored
// `*_units` value (the legal record at bill-issue time) rather than
// recomputing from readings — admin may have intentionally over/underridden.
function resolveUtilityUsageFromBillRow(row, prefix) {
  const r = row || {};
  const prevReading = firstFinite(r[`${prefix}_prev_reading`]);
  const currentReading = firstFinite(r[`${prefix}_current_reading`]);
  const rawUnits = Number(r[`${prefix}_units`]);
  const units = Number.isFinite(rawUnits) ? Math.max(0, rawUnits) : 0;
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

// Reading-or-dash: missing readings render as "—" so the bill always shows
// a before/after column rather than silently dropping the row. Lets tenants
// dispute "where did this number come from?" against the printed bill.
function fmtReadingOrDash(n) {
  return n == null || !Number.isFinite(Number(n)) ? '—' : fmtQty(n);
}

function buildUtilityItem(label, usage, rate, amount) {
  // Defensive normalisation — every caller pass goes through here, so the
  // PDF renderer never sees NaN/undefined for an arithmetic field.
  const u = usage || {};
  const rawUnits = Number(u.units);
  const safeUnits = Number.isFinite(rawUnits) ? Math.max(0, rawUnits) : 0;
  const rawRate = Number(rate);
  const safeRate = Number.isFinite(rawRate) ? Math.max(0, rawRate) : 0;
  const rawAmount = Number(amount);
  const safeAmount = Number.isFinite(rawAmount) ? rawAmount : 0;
  // Coerce only when the source is a real number/string-number — Number(null)
  // is 0 (finite!) so a naive Number.isFinite check would treat missing as 0
  // and the bill would render "เลขก่อน 0 เลขหลัง 0" instead of "ไม่มีการใช้งาน".
  const prev = (u.prevReading == null || u.prevReading === '')
    ? null
    : (Number.isFinite(Number(u.prevReading)) ? Number(u.prevReading) : null);
  const current = (u.currentReading == null || u.currentReading === '')
    ? null
    : (Number.isFinite(Number(u.currentReading)) ? Number(u.currentReading) : null);

  // Qty column: drop the "× rate" tail when there's no rate (free utility
  // or admin-disabled meter) so the bill doesn't print "5 หน่วย × 0".
  const qty = safeRate > 0
    ? `${fmtQty(safeUnits)} หน่วย × ${fmtQty(safeRate)}`
    : `${fmtQty(safeUnits)} หน่วย`;

  // Flat-mode inference for stored bills — the bills table doesn't carry a
  // `mode` column, so we detect flat from the value shape: amount > 0 with
  // rate = 0 + units = 0 + no readings is unreachable from the metered
  // path (metered amount = units × rate, both > 0). New bills get this
  // shape from buildBill's flatItem helper; stored bills round-trip through
  // resolveUtilityUsageFromBillRow which preserves the same shape.
  const isFlat = prev == null && current == null && safeUnits === 0 && safeRate === 0 && safeAmount > 0;
  if (isFlat) {
    return {
      label,
      qty: '1 เดือน',
      amount: safeAmount,
      detail: 'ค่าเหมารายเดือน — ไม่นับตามเลขมิเตอร์',
    };
  }

  // Detail line — ALWAYS present (this is the key fix). Earlier versions
  // omitted detail when readings were missing, which left the tenant with
  // no idea where the unit count came from. Four cases:
  //   1. Both readings present — show normal "เลขก่อน/หลัง/ใช้".
  //      Also flag anomalies: current < prev (meter reset) or stored
  //      units != derived (admin override or data drift).
  //   2. Partial — show what we have with — for the missing side, plus
  //      "(ข้อมูลไม่ครบ)" so admin can correct before the next bill.
  //   3. No readings but units > 0 — admin entered units manually without
  //      a meter snapshot. Mark explicitly so tenant doesn't think the
  //      number came from a meter.
  //   4. No readings and no usage — say "no usage" so the bill is still
  //      auditable (vs silently omitting the row).
  let detail;
  if (prev != null && current != null) {
    detail = `เลขก่อน ${fmtQty(prev)}  เลขหลัง ${fmtQty(current)}  ใช้ ${fmtQty(safeUnits)} หน่วย`;
    if (current < prev) {
      detail += '  ⚠ มิเตอร์ลดลง (อาจรีเซ็ตหรือป้อนผิด)';
    } else {
      const derived = round2(current - prev);
      // Tolerate sub-unit float drift; flag honest mismatch so admin
      // sees the discrepancy on the printed bill before sending.
      if (Math.abs(derived - safeUnits) > 0.5) {
        detail += `  ⚠ หน่วยไม่ตรงกับเลขมิเตอร์ (คำนวณได้ ${fmtQty(derived)})`;
      }
    }
  } else if (prev != null || current != null) {
    detail = `เลขก่อน ${fmtReadingOrDash(prev)}  เลขหลัง ${fmtReadingOrDash(current)}  ใช้ ${fmtQty(safeUnits)} หน่วย  (ข้อมูลไม่ครบ — กรุณาตรวจสอบ)`;
  } else if (safeUnits > 0) {
    detail = `ใช้ ${fmtQty(safeUnits)} หน่วย (ไม่ได้บันทึกเลขมิเตอร์)`;
  } else {
    detail = 'ไม่มีการใช้งาน';
  }

  return { label, qty, amount: safeAmount, detail };
}

/**
 * Extract a unified payment block from config.payment so PDFs and tenant
 * portal both see the same shape. Includes PromptPay QR, bank transfer,
 * TrueMoney Wallet receiver details, and other offline/advertised methods.
 * TrueMoney is manual-only: the tenant transfers to the configured wallet
 * phone and uploads a slip for admin/auto-verifier handling.
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
  const trueMoneyPhone = String(p.truemoneyPhone || p.trueMoneyPhone || p.walletPhone || '')
    .replace(/[\s-]/g, '');
  const trueMoneyReady = p.truemoney === true && /^0\d{9}$/.test(trueMoneyPhone);
  const walletInfo = trueMoneyReady ? {
    provider: 'TrueMoney Wallet',
    phone: trueMoneyPhone,
    name: p.truemoneyName || p.trueMoneyName || p.bankName || '',
    note: p.truemoneyNote || p.trueMoneyNote || 'โอนผ่าน TrueMoney Wallet แล้วแนบสลิปในระบบ',
  } : null;
  const methods = [];
  if (promptpayTarget) methods.push({ key: 'promptpay', label: 'PromptPay', enabled: true });
  if (bank && bank.account) methods.push({ key: 'bank', label: `${bank.bank} • ${bank.account}`, enabled: true });
  if (p.linePay)    methods.push({ key: 'linePay',    label: 'LINE Pay',          enabled: true });
  if (p.truemoney) {
    methods.push({
      key: 'truemoney',
      label: walletInfo ? `TrueMoney Wallet • ${walletInfo.phone}` : 'TrueMoney Wallet (ต้องตั้งเบอร์)',
      enabled: !!walletInfo,
      provider: 'TrueMoney Wallet',
      phone: walletInfo ? walletInfo.phone : '',
      name: walletInfo ? walletInfo.name : '',
      note: walletInfo ? walletInfo.note : '',
      requiresSlip: true,
      manualOnly: true,
    });
  }
  if (p.creditCard) methods.push({ key: 'creditCard', label: 'บัตรเครดิต/เดบิต', enabled: true });
  return {
    promptpayTarget,
    promptpayName,
    bankInfo: bank,
    walletInfo,
    paymentMethods: methods,
  };
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/**
 * Build a unique bill_no.
 *
 * Default shape: `INV-${period}-${roomId}` — keeps backward compat with every
 * bill issued before R4. Stable + human-readable + sortable.
 *
 * R4 — when a room changes tenants mid-period (one moves out, another moves
 * in within the same calendar month), the simple shape collides: both
 * tenants need a bill for the same (room, period) pair but ON CONFLICT
 * (bill_no) DO NOTHING silently dropped the second one. The opt-in
 * `tenantId` argument appends `-T${id}` so two coexisting bills for the
 * same room+period can be stored without collision.
 *
 * Callers SHOULD pass tenantId when they know the bill is for a *new*
 * tenant who just moved in — services/billing.js can't tell on its own
 * because rooms_v2 only carries the current tenant pointer. Bill-gen
 * paths (manual POST, bulk-generate, scheduler) detect collision via the
 * partial-unique index `uq_bills_room_period_active` and retry with the
 * tenant suffix attached — see the conflict-recovery block in those routes.
 *
 * The `attempt` integer is for the rare belt-and-braces case where two
 * tenants happen to share the same DB id — practically impossible but
 * keeps the API future-proof and lets the recovery path keep climbing
 * the suffix space without colliding on the suffix itself.
 */
function makeBillNo(roomId, period, opts = {}) {
  const safe = String(roomId || '000').replace(/[^A-Za-z0-9_-]/g, '');
  const p = (period || formatPeriodNow()).replace(/\s+/g, '-');
  let base = `INV-${p}-${safe}`;
  if (opts && opts.tenantId != null && opts.tenantId !== '') {
    const tid = Number(opts.tenantId);
    if (Number.isInteger(tid) && tid > 0) {
      base += `-T${tid}`;
    }
  }
  if (opts && opts.attempt != null) {
    const att = Number(opts.attempt);
    if (Number.isInteger(att) && att > 1) {
      base += `-${att}`;
    }
  }
  return base;
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

function daysInMonth(year, monthOneIndexed) {
  const y = Math.trunc(Number(year) || new Date().getFullYear());
  const m = Math.max(1, Math.min(12, Math.trunc(Number(monthOneIndexed) || 1)));
  if (m === 2) {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

// Build a YYYY-MM-DD string for a specific (year, month, day) without going
// through Date → toISOString. Same timezone-safety reasoning as
// formatDueDate. Caller passes the human values they mean (year, 1-indexed
// month, day-of-month). Used by the scheduler + bulk-generate paths.
function formatYMD(year, monthOneIndexed, day) {
  const yNum = Math.trunc(Number(year) || new Date().getFullYear());
  const mNum = Math.max(1, Math.min(12, Math.trunc(Number(monthOneIndexed) || 1)));
  const maxDay = daysInMonth(yNum, mNum);
  const dNum = Math.max(1, Math.min(maxDay, Math.trunc(Number(day) || 1)));
  const y = String(yNum).padStart(4, '0');
  const m = String(mNum).padStart(2, '0');
  const d = String(dNum).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isFlatUtilityConfigured(room, prefix) {
  const r = room || {};
  const mode = String(r[`${prefix}Mode`] ?? r[`${prefix}_mode`] ?? '').toLowerCase();
  const amount = Number(r[`${prefix}FlatAmount`] ?? r[`${prefix}_flat_amount`]);
  return mode === 'flat' && Number.isFinite(amount) && amount > 0;
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

/**
 * R2 — Compute the late fee for a bill that has gone past its due date.
 *
 * Centralised so services/scheduler.js#tickLateFee (which writes the fee
 * BACK to bills.late_fee + bills.total) and any future caller (admin
 * preview, tenant-portal "what would my fee be?" calculator) all agree on
 * the math. Pure function — no DB, no I/O.
 *
 * Math:
 *   daysOver  = max(0, floor((now - dueDate)/86400000) - gracePeriodDays)
 *   monthsOver = daysOver / 30          (continuous, not stepped)
 *   lateFee   = base × (ratePctPerMonth/100) × monthsOver
 *
 * `base` is the bill total BEFORE late fee — passing the wrong value here
 * is the classic compounding bug (late fee charges late fee charges late
 * fee). tickLateFee derives base via `total - COALESCE(late_fee, 0)` so
 * each daily tick recomputes from the original principal, making the
 * operation idempotent: running tickLateFee twice on the same day
 * produces the same late_fee, not a doubled one.
 *
 * @param {object} opts
 * @param {number} opts.base                - bill total excluding late_fee (rent + util + recurring + vat)
 * @param {string|Date} opts.dueDate        - YYYY-MM-DD or Date
 * @param {number} [opts.ratePctPerMonth]   - features.lateFee.ratePctPerMonth (default 0 → no fee)
 * @param {number} [opts.gracePeriodDays]   - features.lateFee.gracePeriodDays (default 0)
 * @param {Date}   [opts.now]               - injectable for tests; defaults to new Date()
 * @returns {{ lateFee:number, daysOver:number, monthsOver:number, base:number }}
 *          lateFee already round2'd. daysOver/monthsOver returned for
 *          the audit-log entry ("billed X฿ because 53 days overdue").
 */
function computeLateFee({ base, dueDate, ratePctPerMonth = 0, gracePeriodDays = 0, now } = {}) {
  const safeBase = Number(base);
  const ratePct = Number(ratePctPerMonth);
  const grace = Number(gracePeriodDays);
  // Guard every input — a NaN slipping through here propagates into the
  // bills.late_fee column and breaks downstream chk_bills_amounts_nonnegative.
  if (!Number.isFinite(safeBase) || safeBase <= 0
      || !Number.isFinite(ratePct) || ratePct <= 0) {
    return { lateFee: 0, daysOver: 0, monthsOver: 0, base: Number.isFinite(safeBase) ? safeBase : 0 };
  }
  const due = dueDate instanceof Date ? dueDate : (dueDate ? new Date(dueDate) : null);
  if (!due || !Number.isFinite(due.getTime())) {
    return { lateFee: 0, daysOver: 0, monthsOver: 0, base: safeBase };
  }
  const reference = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const safeGrace = Number.isFinite(grace) ? Math.max(0, grace) : 0;
  const rawDays = Math.floor((reference.getTime() - due.getTime()) / 86_400_000);
  const daysOver = Math.max(0, rawDays - safeGrace);
  if (daysOver <= 0) {
    return { lateFee: 0, daysOver: 0, monthsOver: 0, base: safeBase };
  }
  const monthsOver = daysOver / 30;
  const lateFee = round2(safeBase * (ratePct / 100) * monthsOver);
  return { lateFee, daysOver, monthsOver, base: safeBase };
}

/**
 * R2-followup — Validate a payment amount against a bill that may have had
 * late_fee applied AFTER the tenant initiated payment.
 *
 * Background:
 *   - tickLateFee updates `bills.total` and `bills.late_fee` in-place when
 *     a bill flips pending → overdue (and refreshes daily while overdue).
 *   - A tenant who downloaded the PDF / scanned the QR yesterday saw
 *     `total = 5000`. Today's tick added a 90฿ late fee → `total = 5090`.
 *   - The tenant transfers 5000 in good faith and uploads the slip.
 *   - Strict `Math.abs(amount - total) <= 1` rejects this legitimate
 *     payment as AMOUNT_NOT_BILL_TOTAL.
 *
 * Resolution: accept payment.amount within a TIER. Either:
 *   a) amount ≈ current total (rented + utilities + vat + late_fee) → "fully paid"
 *   b) amount ≈ principal (rented + utilities + vat only)            → "good-faith principal,
 *                                                                       late_fee accrued after
 *                                                                       upload — admin decides
 *                                                                       whether to waive"
 *
 * The match is reported back so caller can record WHICH tier matched in
 * the audit log + drive admin UI:
 *   - tier='exact'     → full match (no late_fee or amount equals total)
 *   - tier='principal' → matched principal but late_fee remains outstanding
 *   - tier='none'      → reject with the closer of (total, principal)
 *
 * @param {object} opts
 * @param {number} opts.amount       - submitted payment amount (THB)
 * @param {number} opts.total        - bills.total at verify time
 * @param {number} opts.lateFee      - bills.late_fee (default 0)
 * @param {number} [opts.tolerance]  - override; defaults to PAYMENT_TOLERANCE_THB
 * @returns {{ ok:boolean, tier:'exact'|'principal'|'none', total:number,
 *             principal:number, lateFee:number, lateFeeOutstanding:number,
 *             closest:number, diff:number }}
 */
function validatePaymentAmount({ amount, total, lateFee = 0, tolerance } = {}) {
  const tol = Number.isFinite(Number(tolerance)) && Number(tolerance) >= 0
    ? Number(tolerance)
    : PAYMENT_TOLERANCE_THB;
  const safeAmount = Number(amount);
  const safeTotal = Number(total);
  const safeLateFee = Number(lateFee) || 0;
  const principal = round2(safeTotal - safeLateFee);
  if (!Number.isFinite(safeAmount) || safeAmount <= 0
      || !Number.isFinite(safeTotal) || safeTotal <= 0) {
    return {
      ok: false, tier: 'none',
      total: safeTotal, principal, lateFee: safeLateFee,
      lateFeeOutstanding: safeLateFee,
      closest: safeTotal, diff: Math.abs(safeAmount - safeTotal),
    };
  }
  const exactDiff = Math.abs(safeAmount - safeTotal);
  if (exactDiff <= tol) {
    return {
      ok: true, tier: 'exact',
      total: safeTotal, principal, lateFee: safeLateFee,
      lateFeeOutstanding: 0,
      closest: safeTotal, diff: exactDiff,
    };
  }
  // Only consider the principal tier when there's an active late_fee. If
  // late_fee=0, total==principal and the exact check above already covered it.
  if (safeLateFee > 0) {
    const principalDiff = Math.abs(safeAmount - principal);
    if (principalDiff <= tol) {
      return {
        ok: true, tier: 'principal',
        total: safeTotal, principal, lateFee: safeLateFee,
        lateFeeOutstanding: safeLateFee,
        closest: principal, diff: principalDiff,
      };
    }
  }
  // Neither tier matched — return the closer reference for a clearer error.
  const closer = Math.abs(safeAmount - safeTotal) <= Math.abs(safeAmount - principal)
    ? { closest: safeTotal, diff: Math.abs(safeAmount - safeTotal) }
    : { closest: principal, diff: Math.abs(safeAmount - principal) };
  return {
    ok: false, tier: 'none',
    total: safeTotal, principal, lateFee: safeLateFee,
    lateFeeOutstanding: safeLateFee,
    closest: closer.closest, diff: closer.diff,
  };
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

/**
 * Final paid-ledger guard. This runs after any late_fee waiver has been
 * applied and immediately before a bill is marked paid. At that point the
 * durable payment amount must match the settled bill total; otherwise a paid
 * bill would no longer reconcile with the payment ledger.
 *
 * @param {object} opts
 * @param {number} opts.paymentAmount - amount stored/being stored in payments.amount
 * @param {number} opts.billTotal     - final bills.total after any waiver
 * @param {number} [opts.tolerance]   - override; defaults to PAYMENT_TOLERANCE_THB
 * @returns {{ ok:boolean, code:'OK'|'INVALID_PAID_LEDGER'|'PAID_LEDGER_INCONSISTENT',
 *             paymentAmount:number, billTotal:number, diff:number, tolerance:number }}
 */
function validatePaidLedger({ paymentAmount, billTotal, tolerance } = {}) {
  const tol = Number.isFinite(Number(tolerance)) && Number(tolerance) >= 0
    ? Number(tolerance)
    : PAYMENT_TOLERANCE_THB;
  const rawAmount = Number(paymentAmount);
  const rawTotal = Number(billTotal);
  const safeAmount = Number.isFinite(rawAmount) ? round2(rawAmount) : rawAmount;
  const safeTotal = Number.isFinite(rawTotal) ? round2(rawTotal) : rawTotal;
  const diff = Number.isFinite(safeAmount) && Number.isFinite(safeTotal)
    ? round2(Math.abs(safeAmount - safeTotal))
    : NaN;
  if (!Number.isFinite(rawAmount) || rawAmount <= 0
      || !Number.isFinite(rawTotal) || rawTotal <= 0) {
    return {
      ok: false,
      code: 'INVALID_PAID_LEDGER',
      paymentAmount: safeAmount,
      billTotal: safeTotal,
      diff,
      tolerance: tol,
    };
  }
  const ok = diff <= tol;
  return {
    ok,
    code: ok ? 'OK' : 'PAID_LEDGER_INCONSISTENT',
    paymentAmount: safeAmount,
    billTotal: safeTotal,
    diff,
    tolerance: tol,
  };
}

module.exports = {
  buildBill, buildPaymentBlock, statusOf, makeBillNo,
  formatPeriodNow, formatDueDate, formatYMD, round2,
  resolveUtilityUsage, resolveUtilityUsageFromBillRow, buildUtilityItem,
  isFlatUtilityConfigured,
  isChargeApplicableForPeriod,
  computeLateFee,
  validatePaymentAmount,
  validatePaidLedger,
  PAYMENT_TOLERANCE_THB,
};
