// === admin/page-billing.jsx ===============================================
// บิลและการเงิน: รายการบิลเดือนนี้, ยังไม่ชำระ, ค้างชำระ, ออกบิล
// ===========================================================================

const { useState, useMemo } = React;

function numOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ownerTenantId(row) {
  const raw = row?.tenantId ?? row?.tenant_id ?? row?.bill_tenant_id ?? row?.dbId;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? String(n) : '';
}

function billOwnerKey(roomId, tenantId) {
  return `${String(roomId || '')}::${String(tenantId || '')}`;
}

function parseBillOther(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const PAYABLE_UI_STATUSES = new Set(['unpaid', 'pending', 'overdue']);

function billUiStatus(row) {
  const raw = String(row?.dbStatus || row?.status || '').toLowerCase();
  if (raw === 'paid') return 'paid';
  if (raw === 'void') return 'void';
  if (raw === 'overdue') return 'overdue';
  if (raw === 'pending' || raw === 'unpaid') return 'unpaid';
  return raw || 'unpaid';
}

function isBillPayableUi(row) {
  return PAYABLE_UI_STATUSES.has(billUiStatus(row)) && row?.dbStatus !== 'void';
}

function billStatusMeta(row) {
  const status = billUiStatus(row);
  if (status === 'paid') return { label: 'ชำระแล้ว', color: 'success' };
  if (status === 'void') return { label: 'ยกเลิก', color: 'neutral' };
  if (status === 'overdue') {
    const days = Math.max(0, Number(row?.overdueDays) || 0);
    return { label: `ค้าง ${days} วัน`, color: 'danger' };
  }
  return { label: 'รอชำระ', color: 'warning' };
}

function tenantStatusUiLabel(status) {
  const raw = String(status || '').trim();
  const labels = {
    active: 'กำลังอยู่',
    moved_out: 'ย้ายออกแล้ว',
    blacklist: 'บัญชีเฝ้าระวัง',
    inactive: 'ไม่ใช้งาน',
    blocked: 'ถูกระงับ',
  };
  return labels[raw] || (raw ? `สถานะ ${raw}` : 'ไม่ทราบสถานะ');
}

function sendReadinessBlockLabel(r) {
  if (!r) return 'ติดปัญหา';
  if (r.blockCode === 'NO_TENANT_CHANNEL') return 'ไม่มีช่องทาง';
  if (r.blockCode === 'EMAIL_NOT_CONFIGURED') return 'อีเมลไม่พร้อม';
  if (r.blockCode === 'TENANT_MOVED_ROOM') {
    return r.tenantCurrentRoom ? `ย้ายห้อง ${r.tenantCurrentRoom}` : 'ไม่ผูกห้อง';
  }
  if (r.blockCode === 'TENANT_NOT_ACTIVE') return tenantStatusUiLabel(r.tenantStatus);
  if (r.blockCode === 'TENANT_DELETED') return 'ลบแล้ว';
  if (r.blockCode === 'BILL_NOT_LINKED') return 'ไม่ผูก';
  return 'ติดปัญหา';
}

function billDbStatusToUi(status) {
  const raw = String(status || '').toLowerCase();
  if (raw === 'paid') return 'paid';
  if (raw === 'void') return 'void';
  if (raw === 'overdue') return 'overdue';
  return 'unpaid';
}

function dbBillMatchesUiBill(real, bill) {
  if (!real || !bill) return false;
  const realRoom = String(real.room_id || '');
  const billRoom = String(bill.roomId || bill.room_id || '');
  if (!realRoom || realRoom !== billRoom) return false;

  const realTenantId = ownerTenantId(real);
  const billTenantId = ownerTenantId(bill);
  if (realTenantId && billTenantId) return realTenantId === billTenantId;

  const realBillNo = String(real.bill_no || '');
  const billNo = String(bill.dbBillNo || bill.billNo || bill.id || '');
  if (realBillNo && billNo && realBillNo === billNo) return true;

  return !realTenantId && !billTenantId;
}

function billRowFromDbFallback(real, est = {}) {
  const tenantId = ownerTenantId(real) || ownerTenantId(est);
  return {
    ...est,
    id: real.bill_no || (real.id ? `DB-${real.id}` : est.id),
    roomId: real.room_id || est.roomId,
    tenantId,
    tenant: real.bill_tenant_name || est.tenant || (tenantId ? `tenant_id ${tenantId}` : 'ไม่ผูกผู้เช่า'),
    phone: real.bill_tenant_phone || est.phone || '',
    tenantStatus: real.bill_tenant_status || est.tenantStatus || null,
    tenantCurrentRoomId: real.bill_tenant_current_room_id || est.tenantCurrentRoomId || null,
    tenantDeletedAt: real.bill_tenant_deleted_at || est.tenantDeletedAt || null,
    period: real.period || est.period || '',
    rent: numOrNull(real.rent) ?? est.rent ?? 0,
    water: numOrNull(real.water_amount) ?? est.water ?? 0,
    waterUnits: numOrNull(real.water_units) ?? est.waterUnits ?? 0,
    waterRate: numOrNull(real.water_rate) ?? est.waterRate ?? 0,
    waterPrevReading: numOrNull(real.water_prev_reading),
    waterCurrentReading: numOrNull(real.water_current_reading),
    elec: numOrNull(real.elec_amount) ?? est.elec ?? 0,
    elecUnits: numOrNull(real.elec_units) ?? est.elecUnits ?? 0,
    elecRate: numOrNull(real.elec_rate) ?? est.elecRate ?? 0,
    elecPrevReading: numOrNull(real.elec_prev_reading),
    elecCurrentReading: numOrNull(real.elec_current_reading),
    wifi: numOrNull(real.wifi) ?? est.wifi ?? 0,
    subtotal: numOrNull(real.subtotal) ?? est.subtotal ?? 0,
    penalty: numOrNull(real.late_fee) ?? est.penalty ?? 0,
    lateFee: numOrNull(real.late_fee) ?? est.lateFee ?? 0,
    vat: numOrNull(real.vat) ?? est.vat ?? 0,
    total: Number(real.total) || est.total || 0,
    dueDate: real.due_date || est.dueDate || '',
    dueDateDisplay: real.due_date || est.dueDateDisplay || '',
    status: billDbStatusToUi(real.status),
    dbStatus: real.status,
    _source: 'db',
    dbBillId: real.id,
    dbBillNo: real.bill_no,
    pendingSlipCount: Number(real.pending_slip_count) || 0,
    verifiedSlipCount: Number(real.verified_slip_count) || 0,
    rejectedSlipCount: Number(real.rejected_slip_count) || 0,
    latestPaidBy: real.latest_paid_by || null,
    latestPaidProvider: real.latest_paid_provider || null,
    latestPaidAt: real.latest_paid_at || null,
  };
}

function fmtQty(n) {
  const value = Number(n) || 0;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function readingPair(room, prefix) {
  const prev = numOrNull(room?.[`${prefix}PrevReading`] ?? room?.[`${prefix}PreviousReading`] ?? room?.[`${prefix}ReadingBefore`] ?? room?.[`${prefix}Before`]);
  const current = numOrNull(room?.[`${prefix}CurrentReading`] ?? room?.[`${prefix}ReadingAfter`] ?? room?.[`${prefix}After`]);
  return { prev, current };
}

function unitsFromReadingsOrFallback(room, prefix) {
  const pair = readingPair(room, prefix);
  if (pair.prev != null && pair.current != null) {
    return Math.max(0, Math.round((pair.current - pair.prev) * 100) / 100);
  }
  return Math.max(0, Number(room?.[`${prefix}Units`]) || 0);
}

function recurringAppliesToPeriod(charge, period) {
  if (!charge || !period) return false;
  const match = String(period).match(/^(\d{4})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return false;
  const periodStart = new Date(Date.UTC(year, month - 1, 1));
  const periodEnd = new Date(Date.UTC(year, month, 0, 23, 59, 59));
  const startRaw = charge.start_at || charge.startAt;
  if (startRaw) {
    const start = new Date(startRaw);
    if (Number.isFinite(start.getTime()) && start.getTime() > periodEnd.getTime()) return false;
  }
  const endRaw = charge.end_at || charge.endAt;
  if (endRaw) {
    const end = new Date(endRaw);
    if (Number.isFinite(end.getTime()) && end.getTime() < periodStart.getTime()) return false;
  }
  const frequency = charge.frequency || 'monthly';
  if (frequency === 'monthly' || frequency === 'one_off') return true;
  if (frequency === 'quarterly') {
    const start = startRaw ? new Date(startRaw) : null;
    const anchorMonth = start && Number.isFinite(start.getTime())
      ? start.getUTCMonth() + 1
      : 1;
    return (((month - anchorMonth) % 3) + 3) % 3 === 0;
  }
  return true;
}

function utilityDetailFromBill(b, prefix) {
  // Mirror services/billing.js#buildUtilityItem detail logic so the admin
  // table cell shows the same before/after string the tenant sees on the
  // PDF — never an empty cell. Missing readings render as "—".
  const prev = numOrNull(b?.[`${prefix}PrevReading`]);
  const current = numOrNull(b?.[`${prefix}CurrentReading`]);
  const rawUnits = Number(b?.[`${prefix}Units`]);
  const units = Number.isFinite(rawUnits) ? Math.max(0, rawUnits) : 0;
  const rawRate = Number(b?.[`${prefix}Rate`]);
  const rate = Number.isFinite(rawRate) ? Math.max(0, rawRate) : 0;
  // Flat-mode inference matches services/billing.js: amount > 0 with
  // rate=0 + units=0 + no readings is unreachable from the metered path
  // (amount = units × rate) — only a flat bill produces this shape.
  const rawAmount = Number(b?.[`${prefix}Amount`] ?? b?.[prefix]);
  const amount = Number.isFinite(rawAmount) ? rawAmount : 0;
  const isFlat = prev == null && current == null && units === 0 && rate === 0 && amount > 0;
  if (isFlat) return 'ค่าเหมารายเดือน — ไม่นับตามเลขมิเตอร์';
  const fr = (v) => v == null ? '—' : fmtQty(v);
  if (prev == null && current == null) {
    if (units <= 0) return 'ไม่มีการใช้งาน';
    return `ใช้ ${fmtQty(units)} หน่วย (ไม่มีเลขมิเตอร์)`;
  }
  const partial = prev == null || current == null;
  const flagged = !partial && Number.isFinite(prev) && Number.isFinite(current) && current < prev;
  const base = `เลขก่อน ${fr(prev)}  เลขหลัง ${fr(current)}  ใช้ ${fmtQty(units)} หน่วย`;
  if (partial) return base + ' (ข้อมูลไม่ครบ)';
  if (flagged) return base + ' (มิเตอร์ลดลง)';
  return base;
}

function PageBilling({ rooms, setRooms, config, addActivity, setToast }) {
  const C = window.ADMIN_C;
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES;
  const { fmt, fmtCurrency, fmtMonthTH, resolveRoomRent } = window;
  const { Card, Btn, Avatar, Pill, KpiCard, DataTable, Modal, Toggle,
          PageContainer, PageHeader, SectionHeading, DefList, Tabs, EmptyState } = window;

  const [tab, setTab] = useState('current');
  // Period selector — defaults to current month but admin can step back to
  // see past months. Without this the bills page only ever showed "now",
  // so reconciling last quarter's invoices required hitting the API directly.
  const [periodOffset, setPeriodOffset] = useState(0);
  const [selected, setSelected] = useState(new Set());
  const [confirmGenerate, setConfirmGenerate] = useState(false);
  const [previewBill, setPreviewBill] = useState(null);
  // sendConfirm: holds the pre-flight payload + the bill ID we're about
  // to send, so the modal can render structured per-issue cards instead
  // of falling back to ugly window.confirm() native dialogs. null = closed.
  const [sendConfirm, setSendConfirm] = useState(null);
  const [sendingNow, setSendingNow] = useState(false);
  // justSentAck: friction ack for resends within ~5 minutes. The confirm
  // button stays disabled until admin explicitly checks "I know they
  // just got it". Reset whenever the modal opens with a new bill.
  const [justSentAck, setJustSentAck] = useState(false);
  // batchReadiness maps billId → { canSend, blockCode, blockMsg, channels,
  // warnCode } for every pending/overdue bill in the current period. Fetched
  // once on mount + after fetchDbBills so the bills table can show per-row
  // status icons instead of forcing admin to click each row to find out
  // which ones are blocked.
  const [batchReadiness, setBatchReadiness] = useState(null);
  // bulkSendPreview holds the readiness summary while the admin is staring
  // at the bulk-send confirmation modal. null = closed.
  const [bulkSendPreview, setBulkSendPreview] = useState(null);
  const [bulkSendingNow, setBulkSendingNow] = useState(false);
  // markPaidPrompt holds the modal state for the manual mark-paid flow.
  // null = closed. Holds { bill, method, ref, note, busy } so admin picks
  // payment method (cash/transfer/promptpay) before the row flips paid.
  const [markPaidPrompt, setMarkPaidPrompt] = useState(null);

  // Real bills from DB for the current period. Falls back to client estimate
  // (computed from rooms blob below) when no bills have been issued yet, so
  // the page still shows what bills WOULD look like — the difference is now
  // visible via the owner-aware DB overlay so admin can tell estimate from issued.
  const currentPeriod = useMemo(() => {
    const now = new Date();
    const dt = new Date(now.getFullYear(), now.getMonth() + periodOffset, 1);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
  }, [periodOffset]);
  const currentPeriodDate = useMemo(() => {
    const [y, m] = currentPeriod.split('-').map(Number);
    return new Date(y, (m || 1) - 1, 1);
  }, [currentPeriod]);
  const [dbBills, setDbBills] = React.useState(null);   // null = loading
  const [dbBillsErr, setDbBillsErr] = React.useState(null);
  const [dbBillsLoading, setDbBillsLoading] = React.useState(false);
  const fetchDbBills = React.useCallback((opts = {}) => {
    const clear = opts.clear !== false;
    const controller = new AbortController();
    if (clear) setDbBills(null);
    setDbBillsLoading(true);
    setDbBillsErr(null);
    const request = fetch(`/api/bills?period=${encodeURIComponent(currentPeriod)}&limit=500&withPayments=1`, {
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          setDbBillsErr(d.error || `HTTP ${r.status}`);
          setDbBills([]);
          return [];
        }
        const rows = Array.isArray(d.bills) ? d.bills : [];
        setDbBills(rows);
        return rows;
      })
      .catch((e) => {
        if (e && e.name === 'AbortError') return null;
        setDbBillsErr(e.message || 'network error');
        setDbBills([]);
        return [];
      })
      .finally(() => {
        if (!controller.signal.aborted) setDbBillsLoading(false);
      });
    request.cancel = () => controller.abort();
    return request;
  }, [currentPeriod]);
  React.useEffect(() => {
    const request = fetchDbBills({ clear: true });
    return () => { if (request && request.cancel) request.cancel(); };
  }, [fetchDbBills]);

  // Cross-link consumer: when /admin#payments → "ดูบิลในหน้าบิล" hops over
  // to /admin#billing?billId=42 we auto-open the matching bill's preview
  // modal so the operator lands directly on the relevant row instead of
  // having to scan the table.
  React.useEffect(() => {
    const openFromHash = () => {
      const m = String(window.location.hash || '').match(/billId=([^&]+)/);
      if (!m || !Array.isArray(dbBills)) return;
      const id = Number(decodeURIComponent(m[1]));
      if (!id) return;
      const target = bills.find((b) => Number(b.dbBillId) === id);
      if (target) setPreviewBill(target);
    };
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
    return () => window.removeEventListener('hashchange', openFromHash);
  }, [bills, dbBills]);

  // Batch readiness — refreshed alongside dbBills so the row status icons
  // stay in sync with the underlying ledger. Cheap (one JOIN-aggregated
  // query) so we can re-run it on every bills refresh without throttling.
  const fetchBatchReadiness = React.useCallback(() => {
    let cancel = false;
    fetch(`/api/bills/send-readiness-batch?period=${encodeURIComponent(currentPeriod)}`,
      { credentials: 'same-origin' })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (cancel) return;
        if (r.ok && d.ok) setBatchReadiness(d);
        else setBatchReadiness(null);
      })
      .catch(() => { if (!cancel) setBatchReadiness(null); });
    return () => { cancel = true; };
  }, [currentPeriod]);
  React.useEffect(() => fetchBatchReadiness(), [fetchBatchReadiness, dbBills]);

  // Month-scoped meter readings. Rooms store room configuration; water/elec
  // usage belongs to the selected bill period.
  const [periodMeters, setPeriodMeters] = React.useState(null);
  React.useEffect(() => {
    let cancel = false;
    setPeriodMeters(null);
    fetch(`/api/meters/period-summary?period=${encodeURIComponent(currentPeriod)}`, {
      credentials: 'same-origin',
    })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (cancel) return;
        if (r.ok && d.ok) setPeriodMeters(d.rooms || {});
        else setPeriodMeters({});
      })
      .catch(() => { if (!cancel) setPeriodMeters({}); });
    return () => { cancel = true; };
  }, [currentPeriod]);

  // Server-side canonical preview. This path uses the same rent resolver,
  // active contract lookup, period meter readings, and recurring-charge
  // filter as actual bill generation. The older browser calculation below is
  // retained only as an offline/degraded fallback.
  const [serverPreviewBills, setServerPreviewBills] = React.useState(null);
  React.useEffect(() => {
    let cancel = false;
    setServerPreviewBills(null);
    fetch(`/api/bills/preview-period?period=${encodeURIComponent(currentPeriod)}`, {
      credentials: 'same-origin',
    })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (cancel) return;
        if (r.ok && d.ok && Array.isArray(d.bills)) setServerPreviewBills(d.bills);
        else setServerPreviewBills(null);
      })
      .catch(() => { if (!cancel) setServerPreviewBills(null); });
    return () => { cancel = true; };
  }, [currentPeriod, dbBills]);

  // Active recurring charges keyed by roomId. Tenant-scoped rows are resolved
  // through /api/tenants?status=active so the preview matches the server's
  // loadRecurringFor({ tenantId, roomId }) behaviour during real bill create.
  // The server's bulk-generate
  // path automatically merges these into the actual bill (services/billing.js
  // appends each `recurring[].amount` as a line item), and one_off rows
  // auto-deactivate after first inclusion. We mirror that here so the
  // CLIENT preview shows the same charges admin will see on the issued
  // bill — eliminates the old drift where r.pendingCharges showed in
  // preview but the generated bill silently omitted it.
  const [activeRecurring, setActiveRecurring] = React.useState({});
  React.useEffect(() => {
    let cancel = false;
    Promise.allSettled([
      fetch('/api/recurring-charges?active=true', { credentials: 'same-origin' }),
      fetch('/api/tenants?status=active', { credentials: 'same-origin' }),
    ])
      .then(async ([chargeRes, tenantRes]) => {
        if (cancel || chargeRes.status !== 'fulfilled' || !chargeRes.value.ok) return;
        const d = await chargeRes.value.json().catch(() => ({}));
        if (cancel) return;
        const tenantById = {};
        if (tenantRes.status === 'fulfilled' && tenantRes.value.ok) {
          const td = await tenantRes.value.json().catch(() => ({}));
          for (const t of (td.tenants || [])) {
            if (t.id && t.current_room_id) tenantById[String(t.id)] = String(t.current_room_id);
          }
        }
        const byRoom = {};
        for (const c of (d.charges || [])) {
          if (!recurringAppliesToPeriod(c, currentPeriod)) continue;
          const rid = c.room_id || c.roomId || tenantById[String(c.tenant_id || c.tenantId || '')];
          if (!rid) continue;
          (byRoom[rid] = byRoom[rid] || []).push({
            label: c.label,
            amount: Number(c.amount) || 0,
            frequency: c.frequency,
            start_at: c.start_at || c.startAt || null,
            end_at: c.end_at || c.endAt || null,
          });
        }
        setActiveRecurring(byRoom);
      })
      .catch(() => { /* preview falls back to empty charges — bill generation
                        still pulls authoritative rows server-side */ });
    return () => { cancel = true; };
  }, [currentPeriod, dbBills]);

  // Map room_id + tenant_id → real DB bill so a moved-out tenant's closing
  // bill is not overwritten by the current tenant in the same room.
  const realBillsByOwnerKey = useMemo(() => {
    const map = {};
    (dbBills || []).forEach((b) => {
      const tenantId = ownerTenantId(b);
      const key = billOwnerKey(b.room_id, tenantId);
      if (b.room_id && tenantId && !map[key]) map[key] = b;
    });
    return map;
  }, [dbBills]);

  const legacyRealBillsByRoom = useMemo(() => {
    const map = {};
    (dbBills || []).forEach((b) => {
      const key = String(b.room_id);
      if (b.room_id && !ownerTenantId(b) && !map[key]) map[key] = b;
    });
    return map;
  }, [dbBills]);

  // Generate preview rows. Prefer serverPreviewBills because it uses the
  // same resolver as actual bill generation, including active contract rent.
  // The local calculation remains as a degraded fallback for offline/local
  // preview only.
  const bills = useMemo(() => {
    const globalWaterRate = config.utilities?.waterRate ?? 18;
    const globalElecRate  = config.utilities?.elecRate  ?? 8;
    const globalWifiFee   = config.utilities?.wifi      ?? 250;
    // Preview mirrors services/billing.js per-room override pattern so
    // admin's /admin#rooms rate edits show up in /admin#billing immediately.
    // Negative / NaN slip back to the global rate so a typo doesn't credit
    // the tenant.
    const overrideOrFallback = (raw, fallback) => {
      if (raw == null || raw === '') return fallback;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    // Keep client estimates aligned with the period selected in the toolbar.
    // If admin is looking at a back-filled month, preview rows and bulk issue
    // payloads must not fall back to the wall-clock month.
    const periodDisplay = fmtMonthTH(currentPeriodDate);
    const dueDay = Math.max(1, Math.min(28, Number(config.notify?.dueOnDay) || 7));
    const dueIso = `${currentPeriod}-${String(dueDay).padStart(2, '0')}`;
    const estimates = Array.isArray(serverPreviewBills)
      ? serverPreviewBills.map((b) => ({
        ...b,
        id: b.id || b.billNo || `INV-${currentPeriod}-${b.roomId}`,
        roomId: b.roomId,
        tenantId: ownerTenantId(b),
        tenant: b.tenant || b.tenantName || '',
        phone: b.phone || b.tenantPhone || '',
        period: b.period || currentPeriod,
        periodDisplay: b.periodDisplay || periodDisplay,
        rent: Number(b.rent) || 0,
        rentSource: b.rentSource || null,
        water: Number(b.water ?? b.waterAmount) || 0,
        elec: Number(b.elec ?? b.elecAmount) || 0,
        wifi: Number(b.wifi) || 0,
        waterUnits: Number(b.waterUnits) || 0,
        waterRate: Number(b.waterRate) || 0,
        waterPrevReading: numOrNull(b.waterPrevReading),
        waterCurrentReading: numOrNull(b.waterCurrentReading),
        elecUnits: Number(b.elecUnits) || 0,
        elecRate: Number(b.elecRate) || 0,
        elecPrevReading: numOrNull(b.elecPrevReading),
        elecCurrentReading: numOrNull(b.elecCurrentReading),
        charges: Array.isArray(b.charges) ? b.charges : [],
        chargesTotal: Number(b.chargesTotal) || 0,
        subtotal: Number(b.subtotal) || 0,
        penalty: Number(b.penalty ?? b.lateFee) || 0,
        total: Number(b.total) || 0,
        dueDate: b.dueDate || dueIso,
        dueDateDisplay: b.dueDateDisplay || `${dueDay} ${periodDisplay}`,
        status: b.status || 'unpaid',
        overdueDays: Number(b.overdueDays) || 0,
        _source: 'server-preview',
      }))
      : Object.values(rooms)
      .filter(r => r.tenant && (r.status === 'occupied' || r.status === 'overdue'))
      .map(r => {
        // Flat-mode preview matches services/billing.js — if room mode is
        // 'flat' and amount > 0, bill the flat number and zero out
        // units/rate so the table doesn't show "5 หน่วย × 18" alongside
        // the flat amount.
        const meterForPeriod = periodMeters && periodMeters[String(r.id)]
          ? periodMeters[String(r.id)]
          : null;
        const rr = meterForPeriod ? { ...r, ...meterForPeriod } : r;
        const waterFlat = Number(rr.waterFlatAmount);
        const elecFlat  = Number(rr.elecFlatAmount);
        const waterFlatActive = String(rr.waterMode || '').toLowerCase() === 'flat'
          && Number.isFinite(waterFlat) && waterFlat > 0;
        const elecFlatActive  = String(rr.elecMode || '').toLowerCase() === 'flat'
          && Number.isFinite(elecFlat)  && elecFlat  > 0;
        const waterUnits = waterFlatActive ? 0 : unitsFromReadingsOrFallback(rr, 'water');
        const elecUnits  = elecFlatActive  ? 0 : unitsFromReadingsOrFallback(rr, 'elec');
        const waterPair = readingPair(rr, 'water');
        const elecPair = readingPair(rr, 'elec');
        const waterRate = waterFlatActive ? 0 : overrideOrFallback(rr.waterRateOverride, globalWaterRate);
        const elecRate  = elecFlatActive  ? 0 : overrideOrFallback(rr.elecRateOverride,  globalElecRate);
        const water = waterFlatActive ? waterFlat : waterUnits * waterRate;
        const elec  = elecFlatActive  ? elecFlat  : elecUnits * elecRate;
        // Honor wifi=0 as a real override (free wifi), not "use global".
        const wifiRaw = rr.wifiOverride ?? rr.wifi;
        const wifi = (wifiRaw != null && wifiRaw !== '' && Number.isFinite(Number(wifiRaw)))
          ? Math.max(0, Number(wifiRaw))
          : globalWifiFee;
        // Common-area fee — flat monthly, mirrors services/billing.js so the
        // preview total matches the issued bill (it bills this ungated, like wifi).
        const globalCommonFee = Number(config.utilities?.commonFee) || 0;
        const commonRaw = rr.commonFeeOverride ?? rr.commonFee;
        const commonFee = (commonRaw != null && commonRaw !== '' && Number.isFinite(Number(commonRaw)))
          ? Math.max(0, Number(commonRaw))
          : (globalCommonFee > 0 ? globalCommonFee : 0);
        // Bill line items come from /api/recurring-charges (active rows).
        // Server's bulk-generate merges these via services/billing.js, so
        // mirroring them here keeps the preview totals in sync with what
        // the tenant will actually see on the issued bill. Legacy
        // r.pendingCharges from old maintenance-ticket flow is intentionally
        // ignored — those rows never made it onto real bills.
        const charges = activeRecurring[r.id] || [];
        const chargesTotal = charges.reduce((s, c) => s + (Number(c.amount) || 0), 0);
        const rentInfo = resolveRoomRent ? resolveRoomRent(rr, config) : { rent: rr.rent, source: 'legacy' };
        const previewRent = Number(rentInfo.rent) || 0;
        const total = previewRent + water + elec + wifi + commonFee + chargesTotal;
        const overdue = r.status === 'overdue';
        // Late fee is computed server-side at bill-gen time using
        // features.lateFee.ratePctPerMonth + gracePeriodDays (the canonical
        // formula in services/billing.js). The legacy preview multiplied
        // overdueDays × config.fees.latePenaltyPerDay, which no backend code
        // reads — admin saw a THB/day estimate that didn't match the actual
        // %/month bill. Showing 0 here keeps the preview honest; the real
        // penalty appears once the bill is actually generated.
        const penalty = 0;
        const grandTotal = total + penalty;
        const periodIso = currentPeriod;
        return {
          id: `INV-${periodIso}-${r.id}`,
          roomId: r.id,
          tenantId: ownerTenantId(r.tenant)
            || (Number.isInteger(Number(r.tenant?.id)) && Number(r.tenant.id) > 0 ? String(Number(r.tenant.id)) : ''),
          tenant: r.tenant.name,
          phone: r.tenant.phone,
          period: periodIso,            // for API
          periodDisplay,                 // for UI
          rent: previewRent,
          rentSource: rentInfo.source,
          water, elec, wifi, commonFee,
          waterUnits,
          waterRate,
          waterPrevReading: waterPair.prev,
          waterCurrentReading: waterPair.current,
          elecUnits,
          elecRate,
          elecPrevReading: elecPair.prev,
          elecCurrentReading: elecPair.current,
          charges,
          chargesTotal,
          subtotal: total,
          penalty,
          total: grandTotal,
          dueDate: dueIso,               // for API
          dueDateDisplay: `${dueDay} ${periodDisplay}`,
          // Bills default to 'unpaid'. Admin marks as paid via the row action,
          // which sets r.billPaidAt on the room. Without that, status was
          // mis-marked 'paid' for every non-overdue room — making the unpaid
          // tab empty and creating false reassurance.
          status: r.billPaidAt ? 'paid' : 'unpaid',
          overdueDays: r.overdueDays || 0,
        };
      });
    const periodLabelFor = (period) => {
      if (!period || typeof period !== 'string') return period || periodDisplay;
      const m = period.match(/^(\d{4})-(\d{2})/);
      if (!m) return period;
      const d = new Date(Number(m[1]), Number(m[2]) - 1, 1);
      return fmtMonthTH ? fmtMonthTH(d) : period;
    };
    const overdueDaysFor = (real) => {
      if (real.status !== 'overdue' || !real.due_date) return 0;
      const due = new Date(`${String(real.due_date).slice(0, 10)}T00:00:00+07:00`);
      if (!Number.isFinite(due.getTime())) return 0;
      return Math.max(0, Math.floor((Date.now() - due.getTime()) / 86400000));
    };
    const rowFromDbBill = (real, est = {}) => {
      const tenantId = ownerTenantId(real) || ownerTenantId(est);
      const other = parseBillOther(real.other);
      const chargesTotal = other.reduce((s, c) => s + (Number(c && c.amount) || 0), 0);
      const period = real.period || est.period || currentPeriod;
      return {
        ...est,
        id: real.bill_no || (real.id ? `DB-${real.id}` : est.id),
        roomId: real.room_id || est.roomId,
        tenantId,
        tenant: real.bill_tenant_name || est.tenant || (tenantId ? `tenant_id ${tenantId}` : 'ไม่ผูกผู้เช่า'),
        phone: real.bill_tenant_phone || est.phone || '',
        tenantStatus: real.bill_tenant_status || est.tenantStatus || null,
        tenantCurrentRoomId: real.bill_tenant_current_room_id || null,
        tenantDeletedAt: real.bill_tenant_deleted_at || null,
        period,
        periodDisplay: periodLabelFor(period),
        rent: numOrNull(real.rent) ?? est.rent ?? 0,
        rentSource: est.rentSource || null,
        water: numOrNull(real.water_amount) ?? est.water ?? 0,
        waterUnits: numOrNull(real.water_units) ?? est.waterUnits ?? 0,
        waterRate: numOrNull(real.water_rate) ?? est.waterRate ?? 0,
        waterPrevReading: numOrNull(real.water_prev_reading),
        waterCurrentReading: numOrNull(real.water_current_reading),
        elec: numOrNull(real.elec_amount) ?? est.elec ?? 0,
        elecUnits: numOrNull(real.elec_units) ?? est.elecUnits ?? 0,
        elecRate: numOrNull(real.elec_rate) ?? est.elecRate ?? 0,
        elecPrevReading: numOrNull(real.elec_prev_reading),
        elecCurrentReading: numOrNull(real.elec_current_reading),
        wifi: numOrNull(real.wifi) ?? est.wifi ?? 0,
        commonFee: est.commonFee || 0,
        charges: other.length ? other : (est.charges || []),
        chargesTotal: other.length ? chargesTotal : (est.chargesTotal || 0),
        subtotal: numOrNull(real.subtotal) ?? est.subtotal ?? 0,
        penalty: numOrNull(real.late_fee) ?? est.penalty ?? 0,
        lateFee: numOrNull(real.late_fee) ?? est.lateFee ?? 0,
        vat: numOrNull(real.vat) ?? est.vat ?? 0,
        total: Number(real.total) || est.total || 0,
        dueDate: real.due_date || est.dueDate || dueIso,
        dueDateDisplay: real.due_date || est.dueDateDisplay || `${dueDay} ${periodLabelFor(period)}`,
        status: real.status === 'paid' ? 'paid'
          : real.status === 'void' ? 'void'
          : real.status === 'overdue' ? 'overdue'
          : 'unpaid',
        dbStatus: real.status,
        overdueDays: real.status === 'overdue' ? overdueDaysFor(real) : (est.overdueDays || 0),
        _source: 'db',
        dbBillId: real.id,
        dbBillNo: real.bill_no,
        pendingSlipCount: Number(real.pending_slip_count) || 0,
        verifiedSlipCount: Number(real.verified_slip_count) || 0,
        rejectedSlipCount: Number(real.rejected_slip_count) || 0,
        latestPaidBy: real.latest_paid_by || null,
        latestPaidProvider: real.latest_paid_provider || null,
        latestPaidAt: real.latest_paid_at || null,
      };
    };

    const consumedDbBillIds = new Set();
    const rows = estimates.map((est) => {
      const tenantId = ownerTenantId(est);
      const real = tenantId
        ? realBillsByOwnerKey[billOwnerKey(est.roomId, tenantId)]
        : legacyRealBillsByRoom[String(est.roomId)];
      if (!real) return { ...est, _source: est._source || 'estimate' };
      consumedDbBillIds.add(Number(real.id));
      return rowFromDbBill(real, est);
    });
    (dbBills || []).forEach((real) => {
      if (!consumedDbBillIds.has(Number(real.id))) rows.push(rowFromDbBill(real));
    });
    return rows;
  }, [rooms, config, realBillsByOwnerKey, legacyRealBillsByRoom, dbBills, currentPeriod, currentPeriodDate, activeRecurring, periodMeters, serverPreviewBills]);

  const filtered = useMemo(() => {
    if (tab === 'current') return bills;
    if (tab === 'unpaid')  return bills.filter(isBillPayableUi).filter(b => b._source === 'db');
    if (tab === 'paid')    return bills.filter(b => b._source === 'db' && b.status === 'paid');
    if (tab === 'review')  return bills.filter(b => (b.pendingSlipCount || 0) > 0);
    return bills;
  }, [bills, tab]);

  const pendingReviewCount = useMemo(
    () => bills.filter((b) => b._source === 'db' && (b.pendingSlipCount || 0) > 0).length,
    [bills]
  );

  const stats = useMemo(() => {
    const issuedRows = bills.filter((b) => b._source === 'db');
    const issued = issuedRows.length;
    const estimateCount = bills.length - issued;
    const paidCount = issuedRows.filter(b => b.status === 'paid').length;
    const payableRows = bills.filter(isBillPayableUi).filter((b) => b._source === 'db');
    const unpaidCount = payableRows.length;
    const totalRevenue = issuedRows.filter(b => b.status === 'paid').reduce((s, b) => s + b.total, 0);
    const overdueAmt = payableRows.reduce((s, b) => s + b.total, 0);
    return { issued, estimateCount, paidCount, unpaidCount, totalRevenue, overdueAmt };
  }, [bills]);

  const payableDbBills = useMemo(
    () => bills.filter(isBillPayableUi).filter((b) => b._source === 'db' && b.dbBillId),
    [bills]
  );

  const readinessStats = useMemo(() => {
    const bmap = batchReadiness?.bills || {};
    let ready = 0;
    let blocked = 0;
    let unknown = 0;
    let sent = 0;
    let unsent = 0;
    for (const bill of payableDbBills) {
      const r = bmap[bill.dbBillId];
      if (!r) {
        unknown++;
      } else if (r.canSend === false) {
        blocked++;
      } else {
        ready++;
      }
      if (r && Number(r.reminderCount) > 0) sent++;
      else unsent++;
    }
    return {
      ready,
      blocked,
      unknown,
      sent,
      unsent,
      payable: payableDbBills.length,
      loading: dbBillsLoading || (payableDbBills.length > 0 && !batchReadiness),
    };
  }, [batchReadiness, dbBillsLoading, payableDbBills]);

  const selectedRows = useMemo(
    () => bills.filter((b) => selected.has(b.id)),
    [bills, selected]
  );
  const selectedPayableRows = useMemo(
    () => selectedRows.filter((b) => b._source === 'db' && b.dbBillId && isBillPayableUi(b)),
    [selectedRows]
  );

  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map(b => b.id)));
  };

  // Pull the server-side preflight before risky billing actions. Used by
  // both "บันทึกชำระ" and "ออกบิล" so the operator gets a structured warning
  // with fix links instead of a generic 500 mid-action. Returns null on
  // network error so the caller can fall through (avoid blocking on a
  // transient blip).
  const fetchBillingReadiness = React.useCallback(async () => {
    try {
      const r = await fetch(`/api/admin/billing-readiness?period=${encodeURIComponent(currentPeriod)}`, { credentials: 'same-origin' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }, [currentPeriod]);

  const formatIssueRoom = React.useCallback((room) => {
    if (room == null) return '';
    if (typeof room === 'string' || typeof room === 'number') return String(room);
    const fields = Array.isArray(room.fields) && room.fields.length
      ? ` [${room.fields.map((f) => ({ water: 'ค่าน้ำ', elec: 'ค่าไฟ' })[f] || f).join('+')}]`
      : '';
    const tenant = room.tenant ? ` (${room.tenant})` : '';
    return `${room.roomId || room.id || '-'}${fields}${tenant}`;
  }, []);

  const formatIssueDetail = React.useCallback((issue) => {
    const detail = issue?.detail || {};
    const lines = [];
    if (detail.period) lines.push(`รอบบิล: ${detail.period}`);
    if (typeof detail.manualChannelConfigured === 'boolean') {
      lines.push(`ช่องทางโอน manual: ${detail.manualChannelConfigured ? 'มี' : 'ไม่มี'}`);
    }
    if (Array.isArray(detail.rooms) && detail.rooms.length > 0) {
      const rooms = detail.rooms.map(formatIssueRoom).filter(Boolean);
      if (rooms.length > 0) {
        const count = Number(detail.count);
        const suffix = Number.isFinite(count) && count > rooms.length ? ` ... รวม ${count} ห้อง` : '';
        lines.push(`ห้องที่เกี่ยวข้อง: ${rooms.join(', ')}${suffix}`);
      }
    }
    return lines.length ? `\n   ${lines.join('\n   ')}` : '';
  }, [formatIssueRoom]);

  // Render the preflight modal text. Filters by `area` so the same endpoint
  // serves both flows: "ออกบิล" wants area=issue, "บันทึกชำระ" wants payment.
  const formatReadinessIssues = React.useCallback((readiness, area) => {
    if (!readiness || !Array.isArray(readiness.issues)) return null;
    const relevant = readiness.issues.filter((i) =>
      Array.isArray(i.area) ? i.area.includes(area) : true
    );
    if (relevant.length === 0) return null;
    const high = relevant.filter((i) => i.sev === 'high').length;
    const lines = relevant.map((i, idx) => {
      const severity = i.sev === 'high' ? 'สำคัญ'
        : i.sev === 'med' ? 'ควรตรวจ'
        : i.sev === 'info' ? 'ข้อมูล' : 'ทั่วไป';
      const fix = i.fix ? `\n   → ${i.fix}` : '';
      const code = i.code ? ` (${i.code})` : '';
      const detail = formatIssueDetail(i);
      return `${idx + 1}. [${severity}]${code} ${i.msg}${detail}${fix}`;
    }).join('\n\n');
    return { lines, high, count: relevant.length };
  }, [formatIssueDetail]);

  const handleMarkPaid = async (id, opts = {}) => {
    const bill = bills.find(b => b.id === id);
    if (!bill) return false;
    if (bill._source !== 'db' || !bill.dbBillId) {
      setToast && setToast({ kind: 'warning', message: 'ต้องออกบิลเข้าระบบก่อน จึงจะบันทึกการชำระได้' });
      return false;
    }
    // Bulk-pay callers skip the modal so they can confirm once for the
    // whole batch — they pass { confirm: false, method, ref } directly.
    if (opts.confirm === false) {
      return await submitMarkPaid({
        bill,
        method: opts.method || 'transfer',
        ref: opts.ref || `admin-billing:${bill.id}`,
        note: opts.note || '',
      }, opts);
    }
    // Pre-flight readiness check — surface config gaps (PromptPay not
    // set, slip provider keys missing, etc.) so admin can act on them
    // before recording payment. Failure is non-blocking; we still let
    // admin proceed (the readiness call itself doesn't gate mark-paid).
    let readinessIssues = null;
    try {
      const readiness = await fetchBillingReadiness();
      const fmt = formatReadinessIssues(readiness, 'payment');
      if (fmt) readinessIssues = fmt;
    } catch { /* readiness fetch is best-effort */ }
    // Open the structured method-picker modal. Replaces the old
    // window.confirm() that hardcoded method='transfer' — admin can now
    // record cash payments without inventing a fake slip + the tenant
    // notification labels the actual method ("รับเงินสดที่สำนักงาน" vs
    // "โอนผ่านธนาคาร" vs "PromptPay"), so the tenant knows exactly how
    // the payment was recorded.
    setMarkPaidPrompt({
      bill,
      method: 'cash',
      ref: '',
      note: '',
      // Optional evidence photo — admin can attach the bank-transfer slip
      // or a photo of the cash receipt so audit trail has a paper trail.
      // Not required; mark-paid still works without it.
      slipFile: null,
      slipDataUrl: null,
      slipError: '',
      busy: false,
      readinessIssues,
    });
    return true;
  };

  const submitMarkPaid = async ({ bill, method, ref, note, slipDataUrl }, opts = {}) => {
    try {
      const cleanRef = String(ref || '').trim();
      const cleanNote = String(note || '').trim();
      const refToSend = cleanRef
        || (method === 'cash' ? `เงินสด·${bill.dbBillNo || bill.dbBillId}` : `admin-billing:${bill.id}`);
      const payload = {
        method,
        amount: Number(bill.total) || 0,
        ref: cleanNote ? `${refToSend} — ${cleanNote}` : refToSend,
      };
      // Attach the optional evidence photo. Server saves it via storage
      // service so the receipt lives next to the auto-uploaded tenant
      // slips in /admin#payments — same image preview path works.
      if (slipDataUrl) payload.slip = slipDataUrl;
      const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
      await apiCall(`/api/bills/${bill.dbBillId}/pay`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const methodLabel = ({ cash: 'เงินสด', transfer: 'โอน', promptpay: 'PromptPay' })[method] || method;
      addActivity && addActivity({
        icon: '💳',
        text: `รับชำระ ${methodLabel} บิล ${bill.dbBillNo || bill.dbBillId} จำนวน ${fmtCurrency(bill.total)}`,
        type: 'payment',
      });
      setToast && setToast({
        kind: 'success',
        message: `บันทึกชำระห้อง ${bill.roomId} (${methodLabel}) แล้ว — ผู้เช่าได้รับแจ้งเตือน`,
      });
      if (opts.refresh !== false) fetchDbBills();
      return true;
    } catch (err) {
      window.toastError ? window.toastError(setToast, err, { action: 'บันทึกชำระ' })
        : setToast && setToast({ kind: 'error', message: err.message || 'บันทึกชำระไม่สำเร็จ' });
      return false;
    }
  };

  const handleUnmarkPaid = async (id) => {
    const bill = bills.find(b => b.id === id);
    if (!bill || bill._source !== 'db' || !bill.dbBillId) {
      setToast && setToast({ kind: 'info', message: 'บิลนี้ยังไม่ได้บันทึกในระบบ ไม่ต้องยกเลิก' });
      return;
    }
    // Call the unmark-paid endpoint, which reverses the verified payment
    // and flips the bill back to pending/overdue. The bill stays alive
    // — that matches the "ยกเลิกชำระ" semantic (admin marked paid by
    // mistake, the rent is still owed). Previously this called /void
    // with force=true, which KILLED the bill entirely; admin then had
    // to re-issue, losing the bill_no and audit chain.
    const reason = window.prompt(
      `ยกเลิกการชำระ บิล ${bill.dbBillNo || bill.dbBillId} (ห้อง ${bill.roomId})?\n\n`
      + `บิลจะกลับเป็น "ยังไม่ชำระ" และ payment ที่ verified จะถูก reject\n`
      + `(บิลไม่ถูกลบ — ผู้เช่ายังต้องจ่าย)\n\n`
      + `กรุณาระบุเหตุผล (เช่น "บันทึกผิดบิล", "ผู้เช่าจ่ายเป็นบิลอื่น"):`
    );
    if (reason === null) return; // cancelled
    const trimmed = String(reason || '').trim();
    if (trimmed.length < 5) {
      setToast && setToast({ kind: 'error', message: 'กรุณาระบุเหตุผล ≥ 5 ตัวอักษร' });
      return;
    }
    const apiFetch = window.requireApiFetch ? window.requireApiFetch() : window.apiFetch;
    try {
      const r = await apiFetch(`/api/bills/${bill.dbBillId}/unmark-paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: trimmed }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setToast && setToast({ kind: 'error', message: d.error || `ยกเลิกการชำระไม่สำเร็จ (HTTP ${r.status})` });
        return;
      }
      const reversedCount = (d.reversedPayments || []).length;
      setToast && setToast({
        kind: 'success',
        message: `ยกเลิกการชำระ บิล ${bill.dbBillNo || bill.dbBillId} เรียบร้อย`
          + (reversedCount ? ` (reject payment ${reversedCount} รายการ)` : ''),
      });
      addActivity && addActivity({
        icon: '↺',
        text: `ยกเลิกการชำระบิล ${bill.dbBillNo || bill.dbBillId}: ${trimmed}`,
        type: 'billing',
      });
      fetchDbBills();
    } catch (err) {
      setToast && setToast({ kind: 'error', message: err.message || 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' });
    }
  };

  // Actual send — called after the confirm modal accepts. Splits into
  // two paths: db-backed bills go through the server's readiness-aware
  // /:id/send; client-estimate "bills" that aren't persisted yet use the
  // legacy /api/notify/bill (no readiness path because there's no row).
  const doSendReminder = async (id) => {
    const b = (sendConfirm
      && (sendConfirm.billId === id
        || sendConfirm.bill?.id === id
        || String(sendConfirm.bill?.dbBillId || '') === String(id || '')))
      ? sendConfirm.bill
      : bills.find((x) => x.id === id);
    if (!b) return;
    setSendingNow(true);
    const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
    try {
      if (b._source === 'db' && b.dbBillId) {
        const sh = sendConfirm?.readiness?.summary?.sendHistory;
        const force = !!(sh && sh.veryRecently && justSentAck);
        await apiCall(`/api/bills/${b.dbBillId}/send`, {
          method: 'POST', body: JSON.stringify(force ? { force: true } : {}),
        });
      } else {
        await apiCall('/api/notify/bill', {
          method: 'POST',
          body: JSON.stringify({
            tenantName: b.tenant, roomId: b.roomId,
            period: b.period, total: b.total, billNo: b.id,
          }),
        });
      }
      setToast && setToast({ kind: 'success', message: `ส่งเตือนบิล ${id} แล้ว` });
      addActivity && addActivity({ icon: 'ส่ง', text: `ส่งเตือนชำระบิล ${id}`, type: 'system' });
      setSendConfirm(null);
    } catch (err) {
      window.toastError(setToast, err, { action: `ส่งเตือนบิล ${id}` });
    } finally { setSendingNow(false); }
  };

  const openSendReadiness = async (b, id) => {
    try {
      const r = await fetch(`/api/bills/${b.dbBillId}/send-readiness`, { credentials: 'same-origin' });
      const d = await r.json();
      if (!r.ok) {
        setToast && setToast({ kind: 'error', message: d.error || 'ตรวจสอบความพร้อมไม่สำเร็จ' });
        return;
      }
      setJustSentAck(false);
      setSendConfirm({ bill: b, billId: id || b.id, readiness: d });
    } catch (err) {
      window.toastError ? window.toastError(setToast, err, { action: 'ตรวจสอบความพร้อมส่ง' })
        : setToast && setToast({ kind: 'error', message: err.message || 'network error' });
    }
  };

  const handleSendReminder = async (id) => {
    let b = bills.find((x) => x.id === id);
    if (!b) return;
    // For client-estimate bills (no DB row yet), there's no readiness
    // endpoint to consult — show a minimal confirm modal explaining
    // this. If the admin just generated bills, first force a DB refresh;
    // otherwise a stale preview object can incorrectly say "not saved"
    // while the persisted bill already exists.
    if (b._source !== 'db' || !b.dbBillId) {
      const freshRows = await fetchDbBills({ clear: false });
      const rows = Array.isArray(freshRows) ? freshRows : (Array.isArray(dbBills) ? dbBills : []);
      const real = rows.find((row) => dbBillMatchesUiBill(row, b));
      if (real) {
        b = billRowFromDbFallback(real, b);
        await openSendReadiness(b, b.id);
        return;
      }
      setJustSentAck(false);
      setSendConfirm({
        bill: b, billId: id,
        readiness: {
          summary: { canSend: false, blocked: true, highCount: 1, issueCount: 1 },
          tenant: null,
          issues: [{
            sev: 'high', code: 'ESTIMATE_NOT_PERSISTED',
            msg: 'ส่งไม่ได้เพราะแถวนี้ยังเป็นประมาณการบนหน้าจอ ไม่ใช่บิลจริงใน DB สำหรับห้อง/ผู้เช่ารอบนี้',
            fix: 'กดออกบิลจริงก่อน แล้วรอป้ายในตารางเปลี่ยนเป็น "ออกแล้ว"; ถ้ายังเป็นประมาณการ แปลว่ารายการนี้ถูกข้ามหรือข้อมูลผู้เช่า/ห้องยังไม่พร้อม',
          }],
        },
      });
      return;
    }
    // Server-side readiness check — returns structured issues so the modal
    // can render them as cards instead of cramming everything into a single
    // window.confirm() string. Opens the modal even on ok:true so admin
    // sees what's about to happen + which channels will fire.
    await openSendReadiness(b, id);
  };

  const handleGenerate = async () => {
    // Pre-flight: ask the server for the authoritative readiness picture
    // (PromptPay shape, slip provider keys, LINE OA, queue backlog) since
    // those are not visible from the browser-side config blob. Fall back
    // to local-only checks if the endpoint is unreachable so a transient
    // network blip doesn't block an admin who already knows the state.
    const readiness = await fetchBillingReadiness();
    let issues;
    if (readiness && Array.isArray(readiness.issues)) {
      issues = readiness.issues
        .filter((i) => Array.isArray(i.area) ? i.area.includes('issue') : true)
        .map((i) => ({
          sev: i.sev === 'info' ? 'low' : i.sev,
          code: i.code || '',
          msg: i.msg,
          fix: i.fix || '',
          detail: i.detail || null,
        }));
    } else {
      issues = [];
      const tenantsWithBills = Object.values(rooms || {}).filter(
        (r) => r && r.tenant && (r.status === 'occupied' || r.status === 'overdue')
      );
      const ppTarget = config?.payment?.promptpay || config?.payment?.promptpayTarget;
      const hasManualPaymentChannel = !!(
        config?.payment?.bankAcc
        || config?.payment?.truemoneyPhone
        || config?.payment?.trueMoneyPhone
        || config?.payment?.walletPhone
      );
      if (!ppTarget) {
        issues.push({
          sev: hasManualPaymentChannel ? 'med' : 'high',
          code: 'NO_PROMPTPAY',
          msg: 'ยังไม่ได้ตั้ง PromptPay — บิล PDF จะไม่มี QR (ผู้เช่าจะ scan-to-pay ไม่ได้)',
          fix: 'ตั้งที่ /admin#secrets → กลุ่ม PromptPay หรือ Settings → การชำระเงิน',
          detail: { manualChannelConfigured: hasManualPaymentChannel },
        });
      }
      const issueRoom = (r, fields = []) => ({
        roomId: String(r?.id || '-'),
        tenant: r?.tenant?.name || '',
        ...(fields.length ? { fields } : {}),
      });
      const isFlatModeRequested = (r, prefix) => String(r?.[`${prefix}Mode`] || '').toLowerCase() === 'flat';
      const isFlatOk = (r, prefix) => String(r?.[`${prefix}Mode`] || '').toLowerCase() === 'flat'
        && Number(r?.[`${prefix}FlatAmount`]) > 0;
      const meteredWaterRooms = tenantsWithBills.filter((r) => !isFlatOk(r, 'water'));
      const meteredElecRooms = tenantsWithBills.filter((r) => !isFlatOk(r, 'elec'));
      const flatMisconfigured = tenantsWithBills
        .map((r) => {
          const fields = [];
          if (isFlatModeRequested(r, 'water') && !isFlatOk(r, 'water')) fields.push('water');
          if (isFlatModeRequested(r, 'elec') && !isFlatOk(r, 'elec')) fields.push('elec');
          return fields.length ? issueRoom(r, fields) : null;
        })
        .filter(Boolean);
      const anyMeteredWater = meteredWaterRooms.length > 0;
      const anyMeteredElec = meteredElecRooms.length > 0;
      const wRate = Number(config?.utilities?.waterRate);
      const eRate = Number(config?.utilities?.elecRate);
      if (flatMisconfigured.length > 0) {
        issues.push({
          sev: 'med',
          code: 'FLAT_AMOUNT_MISSING',
          msg: `${flatMisconfigured.length} ห้องตั้งค่าน้ำ/ไฟแบบเหมา แต่ยังไม่ได้ใส่จำนวนเหมา ระบบจะ fallback ไปคิดตามมิเตอร์`,
          fix: '/admin#rooms → เปิดห้องที่แจ้งเตือน แล้วใส่จำนวนเหมาน้ำ/ไฟ หรือเปลี่ยนกลับเป็นคิดตามมิเตอร์',
          detail: { period: currentPeriod, count: flatMisconfigured.length, rooms: flatMisconfigured.slice(0, 20) },
        });
      }
      if (anyMeteredWater && (!Number.isFinite(wRate) || wRate <= 0)) {
        issues.push({
          sev: 'high',
          code: 'NO_WATER_RATE',
          msg: 'ค่าน้ำต่อหน่วยไม่ได้ตั้ง — บิลจะ ฿0 ในส่วนค่าน้ำสำหรับห้องที่คิดตามมิเตอร์',
          fix: '/admin#pricing → ค่าน้ำ-ไฟ หรือ ตั้งค่าน้ำแบบเหมาในทุกห้องที่ไม่ใช้มิเตอร์',
          detail: { period: currentPeriod, count: meteredWaterRooms.length, rooms: meteredWaterRooms.map((r) => issueRoom(r, ['water'])).slice(0, 20) },
        });
      }
      if (anyMeteredElec && (!Number.isFinite(eRate) || eRate <= 0)) {
        issues.push({
          sev: 'high',
          code: 'NO_ELEC_RATE',
          msg: 'ค่าไฟต่อหน่วยไม่ได้ตั้ง — บิลจะ ฿0 ในส่วนค่าไฟสำหรับห้องที่คิดตามมิเตอร์',
          fix: '/admin#pricing → ค่าน้ำ-ไฟ หรือ ตั้งค่าไฟแบบเหมาในทุกห้องที่ไม่ใช้มิเตอร์',
          detail: { period: currentPeriod, count: meteredElecRooms.length, rooms: meteredElecRooms.map((r) => issueRoom(r, ['elec'])).slice(0, 20) },
        });
      }
      const hasPeriodReading = (r, prefix) => {
        const m = periodMeters && periodMeters[String(r.id)] ? periodMeters[String(r.id)] : null;
        return m && m[`${prefix}CurrentReading`] != null;
      };
      const noMeter = tenantsWithBills.filter((r) =>
        (!isFlatOk(r, 'water') && !hasPeriodReading(r, 'water'))
        || (!isFlatOk(r, 'elec') && !hasPeriodReading(r, 'elec'))
      );
      if (noMeter.length > 0) {
        issues.push({
          sev: 'high',
          code: 'NO_METER_READINGS',
          msg: `${noMeter.length} ห้องยังไม่มีเลขมิเตอร์ครบสำหรับรอบ ${currentPeriod} — บิลส่วนน้ำ/ไฟอาจเป็น 0 หรือข้อมูลไม่ครบ`,
          fix: `/admin#meters → เลือกรอบ ${currentPeriod} แล้วบันทึกเลขมิเตอร์ก่อนออกบิล`,
          detail: {
            period: currentPeriod,
            count: noMeter.length,
            rooms: noMeter.map((r) => {
              const fields = [];
              if (!isFlatOk(r, 'water') && !hasPeriodReading(r, 'water')) fields.push('water');
              if (!isFlatOk(r, 'elec') && !hasPeriodReading(r, 'elec')) fields.push('elec');
              return issueRoom(r, fields);
            }).slice(0, 20),
          },
        });
      }
      if (tenantsWithBills.length === 0) {
        issues.push({
          sev: 'high',
          code: 'NO_ELIGIBLE_ROOMS',
          msg: 'ยังไม่มีห้องที่มีผู้เช่าแสดงสถานะ "occupied" — จะออกบิล 0 ใบ',
          fix: '/admin#rooms → กำหนดผู้เช่าให้ห้องก่อน',
        });
      }
      if (!config?.building?.name || config.building.name === 'ที่พักของคุณ') {
        issues.push({
          sev: 'low',
          code: 'DEFAULT_BUILDING_NAME',
          msg: 'ชื่อตึกยังเป็นค่าเริ่มต้น — บิล PDF จะแสดง "ที่พักของคุณ"',
          fix: '/admin#settings → ข้อมูลตึก',
        });
      }
    }

    if (issues.length > 0) {
      const high = issues.filter((i) => i.sev === 'high').length;
      const lines = issues.map((i, idx) => {
        const severity = i.sev === 'high' ? 'สำคัญ' : i.sev === 'med' ? 'ควรตรวจ' : 'ทั่วไป';
        const fix = i.fix ? `\n   → ${i.fix}` : '';
        const code = i.code ? ` (${i.code})` : '';
        const detail = formatIssueDetail(i);
        return `${idx + 1}. [${severity}]${code} ${i.msg}${detail}${fix}`;
      }).join('\n\n');
      const warningText =
        `พบ ${issues.length} ปัญหา${high > 0 ? ` (${high} ข้อสำคัญ)` : ''} ก่อนออกบิล:\n\n` +
        lines +
        `\n\nออกบิลเดี๋ยวนี้ทั้งที่ปัญหาข้างบนยังไม่แก้?\n` +
        (high > 0 ? `   บิลที่ออกอาจมี QR หาย / ยอดน้ำ-ไฟผิด ผู้เช่าอาจจ่ายไม่ได้หรือทักท้วงสูง\n` : '') +
        `\n   • ยกเลิก → แก้ปัญหาก่อนแล้วค่อยมาออกบิล (แนะนำ)\n` +
        `   • ยืนยัน → ออกบิลตามค่าปัจจุบัน (รับผิดชอบเอง)`;
      const ok = high > 0
        ? String(window.prompt(
            warningText +
            `\n\nถ้าต้องการออกบิลทั้งที่มีปัญหาสำคัญ ให้พิมพ์: ยืนยันออกบิล`
          ) || '').trim() === 'ยืนยันออกบิล'
        : window.confirm(warningText);
      if (!ok) return;
    }

    setConfirmGenerate(false);
    const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
    try {
      const period = currentPeriod;
      const dueDay = Math.max(1, Math.min(28, Number(config.notify?.dueOnDay) || 7));
      // Pass `force` when there were issues but admin confirmed the warning.
      // The server has its own copy of the same checks (defence-in-depth)
      // and will 412 unless we explicitly opt in. issues.length > 0 here
      // means the client-side confirm modal showed warnings AND admin
      // clicked OK — that's the signal to set force.
      const d = await apiCall('/api/bills/bulk-generate', {
        method: 'POST',
        body: JSON.stringify({ period, dueDay, force: issues.length > 0 }),
      });
      const madeCount = Number(d.made) || 0;
      const updatedCount = Number(d.updated) || 0;
      const changedCount = madeCount + updatedCount;
      addActivity && addActivity({ icon: 'บิล', text: `ออกบิลรอบ ${period}: สร้าง ${madeCount} ใบ, อัปเดต ${updatedCount} ใบ (ข้าม ${d.skipped})`, type: 'billing' });
      // Surface rooms that silently fell back from flat → metered so admin
      // can fix the flat amount before the next cycle. Without this the
      // billing UI just says "ออกบิล N ใบ" and the wrong-mode bills go
      // out unnoticed until a tenant disputes.
      const fellBack = Array.isArray(d.flatFellBack) ? d.flatFellBack : [];
      const warnings = Array.isArray(d.warnings) ? d.warnings : [];
      const fellBackMsg = fellBack.length
        ? ` · เตือน: ${fellBack.length} ห้อง (${fellBack.slice(0, 3).map((x) => x.roomId).join(', ')}${fellBack.length > 3 ? '…' : ''}) ตั้งโหมดเหมาไว้แต่ยังไม่กรอกจำนวน — บิลถูกออกตามมิเตอร์แทน`
        : '';
      const warningMsg = warnings.length
        ? ` · warning ${warnings.length} รายการ (${warnings.slice(0, 3).map((w) => w.code || w.msg || 'WARN').join(', ')}${warnings.length > 3 ? '…' : ''})`
        : '';
      const sendHint = changedCount > 0
        ? ' — ขั้นตอนนี้ยังไม่ได้ส่งให้ผู้เช่า ต้องกด "ส่งบิลค้างชำระ" หรือส่งรายบิลต่อ'
        : '';
      setToast && setToast({
        kind: (fellBack.length || warnings.length) ? 'warning' : (changedCount > 0 ? 'success' : 'info'),
        message: (changedCount > 0
          ? `ออก/อัปเดตบิล ${changedCount} ใบสำเร็จ${d.skipped ? ` (ข้าม ${d.skipped} ใบที่มีอยู่แล้วหรือล็อกอยู่)` : ''}${sendHint}`
          : `ไม่มีบิลใหม่สำหรับรอบ ${period} — บิลจริงมีอยู่แล้วหรือรายการถูกข้าม`)
          + fellBackMsg
          + warningMsg,
      });
      // Refresh the DB-bills overlay so the banner + per-row badge flip
      // from "ประมาณการ" to "ออกแล้ว" without needing a manual reload.
      await fetchDbBills({ clear: false });
      fetchBatchReadiness();
    } catch (e) {
      window.toastError(setToast, e, { action: 'ออกบิล' });
    }
  };

  // Bulk-send all pending/overdue bills. Opens a Modal showing the
  // server-computed breakdown (X พร้อม / Y มีปัญหา + reasons) before
  // firing. Replaces the old window.confirm() blob with a richer preview
  // the admin can actually read.
  const handleBulkSend = async () => {
    if (dbBills === null || dbBillsLoading) {
      setToast && setToast({
        kind: 'info',
        message: 'กำลังโหลดบิลจริงจาก DB — รอให้โหลดเสร็จก่อนส่งให้ผู้เช่า',
      });
      return;
    }
    const pending = (dbBills || []).filter((b) => b.status === 'pending' || b.status === 'overdue');
    if (pending.length === 0) {
      setToast && setToast({
        kind: 'info',
        message: {
          title: 'ไม่มีบิลค้างชำระ',
          description: 'ทุกบิลในระบบอยู่ในสถานะ "ชำระแล้ว" หรือ "ยกเลิก" — ไม่มีอะไรต้องส่ง',
        },
      });
      return;
    }
    const totalAmount = pending.reduce((s, b) => s + (Number(b.total) || 0), 0);
    // Reuse the batch readiness already cached on the page when fresh;
    // otherwise force a fresh fetch so the modal has up-to-date numbers.
    let readiness = batchReadiness;
    if (!readiness || readiness.period !== currentPeriod) {
      try {
        const r = await fetch(
          `/api/bills/send-readiness-batch?period=${encodeURIComponent(currentPeriod)}`,
          { credentials: 'same-origin' });
        const d = await r.json();
        if (r.ok && d.ok) {
          readiness = d;
          setBatchReadiness(d);
        }
      } catch { /* fall through with stale data */ }
    }
    setBulkSendPreview({ pending, totalAmount, readiness });
  };

  const doBulkSendNow = async () => {
    const ready = bulkSendPreview?.readiness?.summary?.canSend ?? bulkSendPreview?.pending?.length ?? 0;
    if (!bulkSendPreview || ready <= 0) {
      setToast && setToast({ kind: 'warning', message: 'ไม่มีบิลที่พร้อมส่ง — แก้ปัญหาในคอลัมน์ "พร้อมส่ง" ก่อน' });
      return;
    }
    setBulkSendingNow(true);
    const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
    const apiFetch = window.requireApiFetch ? window.requireApiFetch() : window.apiFetch;
    const selectedIds = bulkSendPreview?.selectedIds;
    try {
      // Two paths: scoped (a list of selected dbBillIds from the
      // multi-select toolbar) vs unscoped (every pending+overdue bill).
      // Scoped loops client-side so it doesn't accidentally fire bills
      // the admin didn't select. Unscoped uses the existing bulk-send
      // endpoint for efficiency.
      if (Array.isArray(selectedIds) && selectedIds.length > 0) {
        let okCount = 0, failCount = 0;
        for (const billId of selectedIds) {
          try {
            const r = await apiFetch(`/api/bills/${billId}/send`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            });
            if (r.ok) okCount++; else failCount++;
          } catch { failCount++; }
        }
        setToast && setToast({
          kind: failCount === 0 ? 'success' : (okCount === 0 ? 'error' : 'info'),
          message: failCount === 0
            ? `จัดคิวแจ้งเตือน ${okCount} ใบที่เลือก`
            : `สำเร็จ ${okCount} · พลาด ${failCount} (ดูใน "คิวแจ้งเตือน")`,
        });
        addActivity && addActivity({
          icon: 'ส่ง',
          text: `ส่งเตือนบิลที่เลือก ${okCount} ใบ`,
          type: 'system',
        });
        setSelected(new Set());
      } else {
        const d = await apiCall('/api/bills/bulk-send', {
          method: 'POST',
          body: JSON.stringify({ period: currentPeriod }),
        });
        setToast && setToast({
          kind: d.enqueued > 0 ? 'success' : 'info',
          message: d.enqueued > 0
            ? `จัดคิวแจ้งเตือน ${d.enqueued}/${d.attempted} ใบ${d.failed ? ` — พลาด ${d.failed} ใบ (ดูใน "คิวแจ้งเตือน")` : ''}`
            : `ไม่มีบิลค้างที่ต้องแจ้งเตือน`,
        });
        addActivity && addActivity({ icon: 'ส่ง', text: `ส่งเตือนทุกบิลค้าง: ${d.enqueued} ใบ`, type: 'system' });
      }
      setBulkSendPreview(null);
      fetchBatchReadiness();   // status icons refresh
    } catch (e) {
      window.toastError(setToast, e, { action: 'ส่งแจ้งเตือน' });
    } finally {
      setBulkSendingNow(false);
    }
  };

  // Selected-only bulk send — opens the same preview modal as the
  // page-wide bulk-send, but scoped to the rows admin ticked. The modal
  // shows recent-send warnings so admin doesn't accidentally re-blast
  // tenants who just got a reminder.
  //
  // `selected` is a Set of bills[].id (string "INV-YYYY-MM-ROOM"), NOT
  // the numeric DB id. We filter against `bills` (the merged estimate +
  // db view) and pull `dbBillId` from each row when present.
  const handleBulkSendSelected = async () => {
    const ids = [...selected];
    // Use the same payable classifier as the table, so overdue bills are
    // included and voided/paid bills are skipped before hitting the API.
    const targets = bills.filter(
      (b) => ids.includes(b.id) && b._source === 'db' && b.dbBillId
             && isBillPayableUi(b));
    if (targets.length === 0) {
      setToast && setToast({
        kind: 'info',
        message: 'ไม่มีบิลที่เลือกเป็นบิลที่ออกแล้วและยังค้างชำระ',
      });
      return;
    }
    const totalAmount = targets.reduce((s, b) => s + (Number(b.total) || 0), 0);
    let readiness = batchReadiness;
    if (!readiness || readiness.period !== currentPeriod) {
      try {
        const r = await fetch(
          `/api/bills/send-readiness-batch?period=${encodeURIComponent(currentPeriod)}`,
          { credentials: 'same-origin' });
        const d = await r.json();
        if (r.ok && d.ok) {
          readiness = d;
          setBatchReadiness(d);
        }
      } catch { /* fall through with stale data */ }
    }
    // Recompute the summary scoped to the selected subset. The raw
    // batch-readiness summary covers the full period, so feeding it
    // straight to BulkSendPreviewBody would show "30 ใบทั้งหมด" while
    // we're only sending 5. Build a new summary from the selected bills
    // map so headline + counts match what's actually going to send.
    const bmap = readiness?.bills || {};
    let scopedCanSend = 0, scopedBlocked = 0;
    const scopedIssueCounts = {};
    for (const t of targets) {
      const r = bmap[t.dbBillId];
      if (!r) { scopedCanSend++; continue; }   // assume sendable when missing
      if (r.canSend === false) {
        scopedBlocked++;
        if (r.blockCode) {
          scopedIssueCounts[r.blockCode] = (scopedIssueCounts[r.blockCode] || 0) + 1;
        }
      } else {
        scopedCanSend++;
      }
    }
    const scopedReadiness = readiness ? {
      ...readiness,
      summary: {
        ...(readiness.summary || {}),
        total: targets.length,
        canSend: scopedCanSend,
        blocked: scopedBlocked,
        issueCounts: scopedIssueCounts,
      },
    } : null;
    setBulkSendPreview({
      pending: targets,
      totalAmount,
      readiness: scopedReadiness,
      selectedIds: targets.map((b) => b.dbBillId),
    });
  };

  const columns = [
    {
      key: 'select', label: '', minWidth: 36, width: 36,
      render: b => (
        <input
          type="checkbox"
          checked={selected.has(b.id)}
          onChange={(e) => { e.stopPropagation(); toggleSelect(b.id); }}
          onClick={(e) => e.stopPropagation()}
          title={b._source === 'db'
            ? 'เลือกบิลจริงเพื่อส่ง/ส่งออก'
            : 'แถวประมาณการเลือกได้เฉพาะส่งออก CSV ยังส่งหรือบันทึกชำระไม่ได้'}
          style={{ cursor: 'pointer', accentColor: C.accent }}
        />
      ),
    },
    {
      key: 'id', label: 'เลขที่', minWidth: 145,
      render: b => (
        <div>
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>{b.dbBillNo || b.id}</span>
          {b.dbBillId && (
            <div style={{ fontSize: 10.5, color: C.muted, marginTop: 2 }}>DB #{b.dbBillId}</div>
          )}
        </div>
      ),
    },
    {
      key: 'roomId', label: 'ห้อง', minWidth: 60,
      render: b => <span style={{ fontWeight: 600, fontFamily: 'IBM Plex Sans Thai, sans-serif' }}>{b.roomId}</span>,
    },
    {
      key: 'tenant', label: 'เจ้าของบิล', minWidth: 220,
      render: b => {
        const statusText = b.tenantDeletedAt
          ? 'ถูกลบ'
          : (b.tenantStatus ? tenantStatusUiLabel(b.tenantStatus) : '');
        const movedRoom = b.tenantCurrentRoomId
          && String(b.tenantCurrentRoomId) !== String(b.roomId);
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Avatar name={b.tenant} size={28} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, color: C.ink, fontWeight: 500 }}>{b.tenant}</div>
              <div style={{ fontSize: 11, color: C.muted }}>{b.phone || '-'}</div>
              {b._source === 'db' && (
                <div style={{ fontSize: 10.5, color: C.muted, display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
                  <span title={`bills.tenant_id=${b.tenantId || '-'}`}>tenant_id={b.tenantId || '-'}</span>
                  {statusText && <span>· {statusText}</span>}
                  {movedRoom && <span>· ปัจจุบันห้อง {b.tenantCurrentRoomId}</span>}
                </div>
              )}
            </div>
          </div>
        );
      },
    },
    { key: 'period', label: 'งวด', minWidth: 90, render: b => <span style={{ fontSize: 12.5 }}>{b.periodDisplay || b.period}</span> },
    {
      key: 'total', label: 'รวม', align: 'right', minWidth: 110,
      render: b => (
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: C.ink, fontFamily: 'IBM Plex Sans Thai, sans-serif' }}>
            {fmtCurrency(b.total)}
          </div>
          {Number(b.chargesTotal) > 0 && (
            <div style={{ fontSize: 11, color: C.muted }}>ค่าอื่น {fmtCurrency(b.chargesTotal)}</div>
          )}
          {Number(b.vat) > 0 && (
            <div style={{ fontSize: 11, color: C.muted }}>VAT {fmtCurrency(b.vat)}</div>
          )}
          {b.penalty > 0 && (
            <div style={{ fontSize: 11, color: C.danger }}>+ ปรับ {fmtCurrency(b.penalty)}</div>
          )}
        </div>
      ),
    },
    {
      key: 'status', label: 'สถานะ', minWidth: 120,
      render: b => {
        const statusMeta = billStatusMeta(b);
        return (
          <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
            <Pill color={statusMeta.color} size="sm">{statusMeta.label}</Pill>
            <span title={b._source === 'db' ? `บิล #${b.dbBillNo || b.dbBillId}` : 'ยังไม่ได้บันทึกเข้าระบบ'}
                  style={{
                    fontSize: 10, padding: '1px 6px', borderRadius: 4,
                    background: b._source === 'db' ? (C.successSoft || '#e3f3e8') : (C.warningSoft || '#fef6e0'),
                    color: b._source === 'db' ? (C.successInk || '#1d4a2c') : (C.warningInk || C.warningInk),
                    fontWeight: 600, letterSpacing: '0.02em',
                  }}>
              {b._source === 'db' ? 'ออกแล้ว' : 'ประมาณการ'}
            </span>
          </div>
        );
      },
    },
    {
      // Slip status — at a glance shows whether a tenant has submitted a
      // slip, whether it was auto-verified or admin-approved, and whether
      // there's still one waiting for review. Clicking the badge jumps to
      // /admin#payments pre-filtered to this bill so admin can act
      // immediately without scanning the queue.
      key: 'slipStatus', label: 'การชำระ', align: 'center', minWidth: 145,
      render: b => {
        if (b._source !== 'db' || !b.dbBillId) {
          return <span style={{ fontSize: 11, color: C.muted }}>—</span>;
        }
        const pend = Number(b.pendingSlipCount) || 0;
        const rej = Number(b.rejectedSlipCount) || 0;
        const paidBy = b.latestPaidBy;
        const jumpToPayments = (e) => {
          e.stopPropagation();
          window.location.hash = `#payments?billId=${encodeURIComponent(b.dbBillId)}`;
        };
        if (b.status === 'paid' && paidBy) {
          const isAuto = String(paidBy).startsWith('auto:');
          const provider = b.latestPaidProvider
            || (isAuto ? String(paidBy).slice(5) : null);
          const providerLabel = ({ slipok: 'SlipOK', easyslip: 'EasySlip', slip2go: 'Slip2Go' })[provider] || provider;
          return (
            <span
              onClick={jumpToPayments}
              title={isAuto
                ? `ระบบตรวจสลิปอัตโนมัติยืนยันแล้ว (${providerLabel || '-'}) — คลิกดูสลิป`
                : `แอดมิน "${paidBy}" อนุมัติด้วยตัวเอง — คลิกดูสลิป`}
              style={{
                cursor: 'pointer', fontSize: 12,
                padding: '3px 8px', borderRadius: 999,
                background: isAuto ? '#e3f3e8' : '#eaf1fb',
                color: isAuto ? '#1d4a2c' : '#1d3a5b',
                fontWeight: 600, whiteSpace: 'nowrap',
              }}
            >
              {isAuto ? `ตรวจอัตโนมัติ: ${providerLabel || 'ระบบ'}` : `อนุมัติโดย: ${paidBy}`}
            </span>
          );
        }
        if (pend > 0) {
          return (
            <span
              onClick={jumpToPayments}
              title={`มีสลิป ${pend} ใบรอตรวจสอบ — คลิกเพื่อตรวจ`}
              style={{
                cursor: 'pointer', fontSize: 12,
                padding: '3px 8px', borderRadius: 999,
                background: C.warningSoft, color: C.warningInk, fontWeight: 600,
                whiteSpace: 'nowrap',
              }}
            >
              รอตรวจสลิป {pend} ใบ
            </span>
          );
        }
        if (rej > 0) {
          return (
            <span
              onClick={jumpToPayments}
              title={`สลิป ${rej} ใบถูกปฏิเสธ — รอผู้เช่าส่งใหม่`}
              style={{
                cursor: 'pointer', fontSize: 11.5,
                padding: '3px 8px', borderRadius: 999,
                background: C.dangerSoft, color: C.dangerInk, fontWeight: 600,
                whiteSpace: 'nowrap',
              }}
            >
              สลิปถูกปฏิเสธ {rej} ใบ
            </span>
          );
        }
        return <span style={{ fontSize: 11, color: C.muted }}>ยังไม่มีสลิป</span>;
      },
    },
    {
      // Per-bill readiness icon — at a glance shows whether THIS bill can
      // be sent (or why not). Avoids "click 30 bills to find the 3 that
      // fail" pattern. Tooltip on the icon carries the reason.
      //
      // Below the readiness label we surface a tiny "ส่งแล้ว N×" badge
      // when the bill has been reminded already — so admin spots the
      // already-pinged tenants without opening each row's confirm modal.
      key: 'sendStatus', label: 'พร้อมส่ง', align: 'center', minWidth: 135,
      render: b => {
        if (b._source !== 'db' || !b.dbBillId) {
          return <span style={{ fontSize: 11, color: C.muted }}>—</span>;
        }
        if (!isBillPayableUi(b)) {
          const statusMeta = billStatusMeta(b);
          return <span style={{ fontSize: 11, color: C.muted }}>{statusMeta.label}</span>;
        }
        const r = batchReadiness && batchReadiness.bills && batchReadiness.bills[b.dbBillId];
        if (!r) return <span style={{ fontSize: 11, color: C.muted }}>…</span>;

        let mainEl;
        if (r.canSend && r.warnCode === 'EX_TENANT_BILL') {
          mainEl = (
            <span title="ผู้เช่าย้ายออกแล้ว — ส่งได้เฉพาะบิลค้างเก่าผ่านลิงก์ชำระเงิน ไม่เปิดสิทธิ์พอร์ทัลกลับ"
                  style={{ fontSize: 12.5, color: C.warning, fontWeight: 600, whiteSpace: 'nowrap' }}>ผู้เช่าเก่า: ส่งได้</span>
          );
        } else if (r.canSend && r.warnCode === 'EMAIL_ONLY') {
          mainEl = (
            <span title="ไม่ผูก LINE — จะส่งทางอีเมล (อาจไปกล่อง spam)"
                  style={{ fontSize: 13, color: C.warning, whiteSpace: 'nowrap' }}>ส่งทางอีเมล</span>
          );
        } else if (r.canSend && r.warnCode === 'EMAIL_DISABLED') {
          mainEl = (
            <span title="มีอีเมล แต่ SMTP ยังไม่พร้อม — รอบนี้จะส่งทาง LINE เท่านั้น"
                  style={{ fontSize: 13, color: C.warning, whiteSpace: 'nowrap' }}>ส่งทาง LINE</span>
          );
        } else if (r.canSend) {
          mainEl = (
            <span title="LINE + (อีเมลถ้ามี) พร้อม — กดส่งได้เลย"
                  style={{ fontSize: 13, color: C.success, whiteSpace: 'nowrap' }}>พร้อมส่ง</span>
          );
        } else {
          mainEl = (
            <span title={r.blockMsg || r.blockCode || 'block'}
                  style={{ fontSize: 12, color: C.danger, fontWeight: 600, whiteSpace: 'nowrap' }}>
              ส่งไม่ได้: {sendReadinessBlockLabel(r)}
            </span>
          );
        }
        const count = Number(r.reminderCount) || 0;
        if (count === 0) return mainEl;
        const min = r.minutesAgo;
        const ago = min == null ? ''
          : min < 60 ? `${min} น.`
          : min < 1440 ? `${Math.round(min / 60)} ชม.`
          : `${Math.round(min / 1440)} วัน`;
        const veryRecent = min != null && min < 5;
        return (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            {mainEl}
            <span
              title={r.lastRemindedAt
                ? `ส่งล่าสุด ${new Date(r.lastRemindedAt).toLocaleString('th-TH')}`
                : 'เคยส่งมาแล้ว'}
              style={{
                fontSize: 10.5, padding: '1px 6px', borderRadius: 10,
                background: veryRecent ? '#fbeae7' : '#fdf3e0',
                color: veryRecent ? C.dangerInk : '#7a5a1a',
                whiteSpace: 'nowrap',
              }}>
              ส่งแล้ว {count}× {ago ? `· ${ago}ก่อน` : ''}
            </span>
          </div>
        );
      },
    },
    {
      // Actions column — short Thai text labels (no icons; per operator
      // feedback that icons-alone were unclear). Tight padding/font keeps
      // the 3-button row at ~170px so the whole billing table fits in a
      // desktop viewport without horizontal scrolling. `title` carries the
      // long form ("ดูบิล", "ส่งเตือน", "บันทึกชำระ") for screen readers.
      key: 'actions', label: '', align: 'right', minWidth: 170,
      render: b => {
        const compactBtn = {
          padding: '6px 10px',
          fontSize: 12,
          height: 28,
        };
        return (
          <div style={{ display: 'inline-flex', gap: 5, flexWrap: 'nowrap', justifyContent: 'flex-end', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
            <Btn size="sm" variant="ghost" style={compactBtn} onClick={() => setPreviewBill(b)}>ดู</Btn>
            {isBillPayableUi(b) && b._source === 'db' && (
              <>
                <Btn size="sm" variant="ghost" style={compactBtn} onClick={() => handleSendReminder(b.id)}>ส่ง</Btn>
                <Btn size="sm" variant="ghost" style={compactBtn} onClick={() => handleMarkPaid(b.id)}>ชำระ</Btn>
              </>
            )}
            {b.status === 'paid' && b._source === 'db' && (
              <Btn size="sm" variant="ghost" style={compactBtn} onClick={() => handleUnmarkPaid(b.id)}>ยกเลิก</Btn>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        title="บิลและการเงิน"
        subtitle={`เดือน ${fmtMonthTH(currentPeriodDate)} · ${bills.length} ใบ`}
        actions={
          <>
            {/* Period picker — segmented control with arrows + "เดือนนี้"
                shortcut. Stays as a single inline element on desktop;
                wraps to its own row on mobile thanks to the page-header-row
                flex-wrap. */}
            <div style={{
              display: 'inline-flex', alignItems: 'center',
              padding: 2, border: `1px solid ${C.border}`,
              borderRadius: 9, background: C.surface,
              height: 38, overflow: 'hidden',
            }}>
              <button
                type="button"
                aria-label="เดือนก่อนหน้า"
                onClick={() => setPeriodOffset((x) => x - 1)}
                style={{
                  width: 32, height: 32, border: 0, borderRadius: 6,
                  background: 'transparent', color: C.ink, cursor: 'pointer',
                  fontSize: 17, fontFamily: 'inherit', display: 'inline-flex',
                  alignItems: 'center', justifyContent: 'center',
                }}
              >‹</button>
              <span style={{
                minWidth: 80, padding: '0 4px',
                textAlign: 'center', fontSize: 13, fontWeight: 600, color: C.ink,
                fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.02em',
              }}>{currentPeriod}</span>
              <button
                type="button"
                aria-label="เดือนถัดไป"
                disabled={periodOffset >= 0}
                onClick={() => setPeriodOffset((x) => Math.min(x + 1, 0))}
                style={{
                  width: 32, height: 32, border: 0, borderRadius: 6,
                  background: 'transparent',
                  color: periodOffset >= 0 ? C.muted : C.ink,
                  cursor: periodOffset >= 0 ? 'not-allowed' : 'pointer',
                  fontSize: 17, fontFamily: 'inherit',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}
              >›</button>
              {periodOffset !== 0 ? (
                <button
                  type="button"
                  onClick={() => setPeriodOffset(0)}
                  style={{
                    border: 0, padding: '0 10px', height: 32,
                    marginLeft: 2, borderLeft: `1px solid ${C.borderSoft}`,
                    background: 'transparent', color: C.accent,
                    cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                  }}
                >เดือนนี้</button>
              ) : null}
            </div>
            <Btn variant="secondary" onClick={() => {
              if (window.exportBillsCSV(bills)) {
                addActivity && addActivity({ icon: 'CSV', text: `ส่งออกบิลเดือนนี้ ${bills.length} ใบ เป็น CSV`, type: 'system' });
                setToast && setToast({ kind: 'success', message: `ดาวน์โหลด CSV ${bills.length} ใบเรียบร้อย` });
              }
            }}>ส่งออก CSV</Btn>
            <Btn variant="primary" tone="finance" onClick={() => setConfirmGenerate(true)}>
              {stats.estimateCount > 0 ? 'ออกบิลส่วนที่เหลือ' : 'ตรวจ/อัปเดตบิล'}
            </Btn>
            <Btn
              variant="soft"
              tone="finance"
              onClick={handleBulkSend}
              disabled={dbBills === null || dbBillsLoading || readinessStats.payable === 0}
              title={dbBills === null || dbBillsLoading
                ? 'รอโหลดบิลจริงจาก DB ก่อน'
                : readinessStats.payable === 0
                  ? 'ไม่มีบิลจริงที่ยังค้างชำระ'
                  : 'ส่งเฉพาะบิลจริงใน DB ที่ยังค้างชำระ'}>
              ส่งบิลค้างชำระ
            </Btn>
          </>
        }
      />

      <BillingWorkflowStrip
        C={C}
        fmt={fmt}
        stats={stats}
        readinessStats={readinessStats}
        dbBillsLoading={dbBillsLoading}
      />

      {/* Real-vs-estimate banner. Tells admin at a glance whether what
          they're seeing came from issued bills (DB) or is just a forecast
          built from rooms × rate. Uses the unified Alert component so
          the visual language matches every other banner in the admin
          (rail + icon glyph + soft tinted bg). */}
      {dbBills != null && (() => {
        const Alert = window.Alert;
        const dbCount = dbBills.length;
        const estCount = bills.filter((b) => b._source !== 'db').length;
        if (!Alert) return null;
        if (dbCount === 0 && estCount > 0) {
          return (
            <div style={{ marginBottom: 14 }}>
              <Alert kind="warning"
                title={`ยังไม่ได้ออกบิลรอบ ${currentPeriod}`}>
                ตารางด้านล่างเป็นการประมาณการจากข้อมูลห้อง — กดปุ่ม "ออกบิลเดือนนี้" เพื่อบันทึกเข้า DB จริง
              </Alert>
            </div>
          );
        }
        if (dbCount > 0 && estCount > 0) {
          return (
            <div style={{ marginBottom: 14 }}>
              <Alert kind="info"
                title={`ออกบิลแล้ว ${dbCount} ใบ · เหลือ ${estCount} ห้อง`}>
                รอบ {currentPeriod} — กด "ออกบิลเดือนนี้" เพื่อออกบิลส่วนที่เหลือ
              </Alert>
            </div>
          );
        }
        if (dbCount > 0 && estCount === 0) {
          return (
            <div style={{ marginBottom: 14 }}>
              <Alert kind="success"
                title={`ออกบิลครบทุกห้อง · ${dbCount} ใบ`}>
                รอบ {currentPeriod} ออกบิลครบถ้วนแล้ว
              </Alert>
            </div>
          );
        }
        return null;
      })()}
      {dbBillsLoading && dbBills != null && window.Alert && (
        <div style={{ marginBottom: 14 }}>
          <window.Alert kind="info" title="กำลังซิงก์บิลจริงจาก DB">
            ถ้าเพิ่งกดออกบิล ให้รอให้ป้ายในตารางเปลี่ยนเป็น "ออกแล้ว" ก่อนส่งให้ผู้เช่า
          </window.Alert>
        </div>
      )}
      {dbBillsErr && window.Alert && (
        <div style={{ marginBottom: 14 }}>
          <window.Alert kind="danger"
            title="โหลดข้อมูลบิลจาก DB ไม่สำเร็จ"
            action={{ label: 'ลองใหม่', onClick: fetchDbBills }}>
            {dbBillsErr} — แสดงประมาณการจากข้อมูลห้องแทน
          </window.Alert>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 20 }}>
        <KpiCard label="บิลที่ออก"     value={fmt(stats.issued)}     sub={stats.estimateCount ? `มีประมาณการ ${fmt(stats.estimateCount)} แถว` : 'ใบจริงใน DB'} />
        <KpiCard label="ชำระแล้ว"       value={fmt(stats.paidCount)} sub={fmtCurrency(stats.totalRevenue)} color="success" />
        <KpiCard label="ค้างชำระ"        value={fmt(stats.unpaidCount)} sub={fmtCurrency(stats.overdueAmt)} color="danger" />
        <KpiCard label="อัตราการชำระ" value={stats.issued ? Math.round(stats.paidCount/stats.issued*100) + '%' : '-'} color="info" />
      </div>

      <Tabs
        items={[
          { value: 'current', label: 'เดือนนี้',         count: bills.length },
          { value: 'unpaid',  label: 'ค้างชำระ',        count: stats.unpaidCount },
          { value: 'review',  label: 'รอตรวจสลิป', count: pendingReviewCount },
          { value: 'paid',    label: 'ชำระแล้ว',       count: stats.paidCount },
        ]}
        value={tab}
        onChange={setTab}
        variant="pills"
        style={{ marginBottom: 14 }}
      />

      {selected.size > 0 && (
        <Card style={{
          marginBottom: 12, padding: 12,
          background: C.dark, borderColor: C.dark,
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <span style={{ color: '#fff', fontSize: 13, fontWeight: 500 }}>
            เลือกแล้ว {selected.size} รายการ · ส่ง/ชำระได้ {selectedPayableRows.length} บิลจริง
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <Btn
              variant="soft"
              size="sm"
              onClick={handleBulkSendSelected}
              disabled={selectedPayableRows.length === 0}
              title={selectedPayableRows.length === 0 ? 'รายการที่เลือกยังไม่มีบิลจริงค้างชำระ' : ''}>
              ส่งบิลที่เลือก
            </Btn>
            <Btn variant="soft" size="sm" onClick={() => {
              const selectedBills = selectedRows;
              if (window.exportBillsCSV(selectedBills)) {
                setToast && setToast({ kind: 'success', message: `ดาวน์โหลด ${selectedBills.length} บิลเรียบร้อย` });
              }
            }}>ดาวน์โหลด CSV</Btn>
            <Btn
              variant="soft"
              size="sm"
              disabled
              title="ป้องกันการกดชำระผิด: บันทึกชำระต้องทำทีละบิลเพื่อเลือกวิธีและแนบหลักฐาน">
              ชำระทีละบิล
            </Btn>
            <Btn variant="ghost" size="sm" onClick={() => setSelected(new Set())} style={{ color: '#fff' }}>ยกเลิกเลือก</Btn>
          </div>
        </Card>
      )}

      <DataTable
        columns={columns}
        rows={filtered}
        onRowClick={(b) => setPreviewBill(b)}
        empty={(() => {
          // Diagnose why the table is empty so admin knows what to do
          // next instead of staring at "ยังไม่มีบิล" with no clue. The
          // 4 distinct cases give different messages:
          //   1) loading      → spinner
          //   2) load error   → show error + retry hint
          //   3) no rooms     → tell admin to add a tenant
          //   4) eligible rooms exist but no bill row → tell admin to
          //      click "ออกบิลรายเดือน" or wait for scheduler
          if (dbBills === null) {
            return <EmptyState icon="โหลด" title="กำลังโหลด..." />;
          }
          if (dbBillsErr) {
            return (
              <EmptyState
                icon="ผิดพลาด"
                title="โหลดบิลไม่สำเร็จ"
                description={`${dbBillsErr} — ลองรีเฟรชหน้า หรือถ้ายังไม่ได้ ติดต่อทีมเทคนิค`}
              />
            );
          }
          const eligibleRooms = Object.values(rooms || {}).filter(
            (r) => r && r.tenant && (r.status === 'occupied' || r.status === 'overdue')
          ).length;
          if (eligibleRooms === 0) {
            return (
              <EmptyState
                icon="ห้อง"
                title="ยังไม่มีห้องที่เปิดให้เช่า"
                description={'ต้องมีห้องสถานะ "occupied" หรือ "overdue" ก่อน — เพิ่มผู้เช่าที่ /admin#rooms หรือ check-in ผู้เช่าใหม่'}
              />
            );
          }
          if (tab === 'review') {
            return (
              <EmptyState
                icon="สลิป"
                title="ไม่มีบิลที่รอตรวจสลิป"
                description="ผู้เช่ายังไม่ได้อัปโหลดสลิป หรือสลิปทั้งหมดผ่านการตรวจอัตโนมัติแล้ว"
              />
            );
          }
          if (tab === 'paid') {
            return (
              <EmptyState
                icon="ชำระแล้ว"
                title="ยังไม่มีบิลที่ชำระแล้ว"
                description="บิลที่ทำเครื่องหมายชำระแล้วจะปรากฏที่นี่ ลองเปิด tab อื่นเพื่อดูบิลที่รอจ่าย"
              />
            );
          }
          if (tab === 'unpaid') {
            return (
              <EmptyState
                icon="ไม่มีค้าง"
                title="ไม่มีบิลค้างชำระ"
                description={`มีห้องที่เปิดให้เช่า ${eligibleRooms} ห้อง ทั้งหมดชำระเรียบร้อยแล้ว`}
              />
            );
          }
          // tab='current' — eligible rooms exist but no DB bill row this period
          return (
            <EmptyState
              icon="บิล"
              title={`ยังไม่มีบิลเดือนนี้ (${currentPeriod})`}
              description={
                'มีห้องเปิดให้เช่า ' + eligibleRooms + ' ห้อง แต่ยังไม่ได้ออกบิลรอบนี้ — '
                + 'กด "ออกบิลรายเดือน" ด้านบน หรือรอ scheduler รันอัตโนมัติตามวันที่ตั้งไว้ใน /admin#features'
              }
            />
          );
        })()}
      />

      <Modal
        open={confirmGenerate}
        onClose={() => setConfirmGenerate(false)}
        title="ออกบิลประจำเดือน"
        footer={
          <>
            <Btn variant="ghost" onClick={() => setConfirmGenerate(false)}>ยกเลิก</Btn>
            <Btn variant="primary" onClick={handleGenerate} disabled={dbBillsLoading}>
              {dbBillsLoading
                ? 'กำลังซิงก์ DB…'
                : stats.estimateCount > 0
                  ? `ออกบิลส่วนที่เหลือ ${stats.estimateCount} แถว`
                  : 'ตรวจ/อัปเดตบิลจริง'}
            </Btn>
          </>
        }
      >
        <div style={{ fontSize: 14, color: C.ink2, lineHeight: 1.6, marginBottom: 12 }}>
          ระบบจะตรวจรอบ <b style={{ color: C.ink }}>{currentPeriod}</b> และบันทึกเฉพาะบิลจริงลง DB
        </div>
        <div style={{
          padding: 12, background: C.surfaceAlt, borderRadius: 8,
          fontSize: 12.5, color: C.ink2,
        }}>
          <div>บิลจริงใน DB ตอนนี้: <b>{fmt(stats.issued)} ใบ</b></div>
          <div>แถวที่ยังเป็นประมาณการ: <b>{fmt(stats.estimateCount)} แถว</b></div>
          <div>ครบกำหนดชำระ: <b>วันที่ {config.notify?.dueOnDay ?? 7} ของเดือน</b></div>
          <div>ยอดรวมโดยประมาณ: <b>{fmtCurrency(bills.reduce((s,b) => s+b.total, 0))}</b></div>
          <div>หลังออกบิล: <b>ยังไม่ส่งผู้เช่าอัตโนมัติ</b> — ต้องกดส่งบิลค้างชำระหรือส่งรายบิล</div>
        </div>
      </Modal>

      <Modal
        open={!!previewBill}
        onClose={() => setPreviewBill(null)}
        title={previewBill ? `บิล ${previewBill.id}` : ''}
        width={520}
        footer={previewBill && (
          <>
            <Btn variant="ghost" onClick={() => setPreviewBill(null)}>ปิด</Btn>
            {/* Cross-link to /admin#payments. Only show when the bill is
                actually persisted (no point linking to an estimate) and
                only when there's something to see (a slip is attached or
                the bill is already paid via a slip). For unsent bills
                with no slip yet this button stays hidden so the footer
                isn't cluttered. */}
            {previewBill._source === 'db' && previewBill.dbBillId
              && ((previewBill.pendingSlipCount || 0) > 0
                  || (previewBill.verifiedSlipCount || 0) > 0
                  || (previewBill.rejectedSlipCount || 0) > 0) ? (
              <Btn variant="secondary" onClick={() => {
                window.location.hash = `#payments?billId=${encodeURIComponent(previewBill.dbBillId)}`;
                setPreviewBill(null);
              }}>ดูสลิปของบิลนี้</Btn>
            ) : null}
            <Btn variant="secondary" onClick={async () => {
              const b = previewBill;
              // Build the bill payload matching services/pdf.js renderBillPdf shape.
              const items = [
                { label: 'ค่าเช่าห้อง', amount: b.rent || 0 },
                {
                  label: 'ค่าน้ำประปา',
                  qty: `${fmtQty(b.waterUnits)} หน่วย × ${fmtQty(b.waterRate || config.utilities?.waterRate || 0)}`,
                  detail: utilityDetailFromBill(b, 'water'),
                  amount: b.water || 0,
                },
                {
                  label: 'ค่าไฟฟ้า',
                  qty: `${fmtQty(b.elecUnits)} หน่วย × ${fmtQty(b.elecRate || config.utilities?.elecRate || 0)}`,
                  detail: utilityDetailFromBill(b, 'elec'),
                  amount: b.elec || 0,
                },
                { label: 'ค่า Wi-Fi', amount: b.wifi || 0 },
              ];
              if (Number(b.commonFee) > 0) items.push({ label: 'ค่าส่วนกลาง', amount: Number(b.commonFee) });
              // Maintenance / repair charges from completed tickets. Filter out
              // any common-fee line so it isn't shown twice (it's already added
              // above; DB bills also carry it inside `other`/charges).
              if (Array.isArray(b.charges)) {
                b.charges
                  .filter((c) => !/ส่วนกลาง/.test(String((c && c.label) || '')))
                  .forEach((c) => items.push({ label: c.label, amount: Number(c.amount) || 0 }));
              }
              if (b.penalty > 0) {
                items.push({ label: `ค่าปรับล่าช้า (${b.overdueDays || 0} วัน)`, amount: b.penalty });
              }
              // Server enriches with payment fields from config.payment via
              // services/billing.buildPaymentBlock. Client only sends the
              // bill basics + config blob; the field-extraction logic lives
              // in one place so client and PDF renderer can't drift.
              const payload = {
                billNo: b.id,
                roomId: b.roomId,
                tenantName: b.tenant,
                tenantPhone: b.phone,
                period: b.period,
                dueDate: b.dueDate,
                items,
                total: b.total,
                waterUnits: b.waterUnits,
                waterRate: b.waterRate,
                waterPrevReading: b.waterPrevReading,
                waterCurrentReading: b.waterCurrentReading,
                elecUnits: b.elecUnits,
                elecRate: b.elecRate,
                elecPrevReading: b.elecPrevReading,
                elecCurrentReading: b.elecCurrentReading,
                building: (config && config.building) || { name: 'ที่พักของคุณ' },
              };
              const apiFetch = window.requireApiFetch ? window.requireApiFetch() : window.apiFetch;
              try {
                const res = await apiFetch('/api/bills/render', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(
                    b._source === 'db' && b.dbBillId
                      ? { billId: b.dbBillId, bill: payload }
                      : { bill: payload, config }
                  ),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `bill_${b.id}.pdf`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
                setToast && setToast({ kind: 'success', message: `ดาวน์โหลดบิล ${b.id} เรียบร้อย` });
                addActivity && addActivity({ icon: 'PDF', text: `ดาวน์โหลดบิล ${b.id} (PDF)`, type: 'billing' });
              } catch (err) {
                console.error('PDF download failed:', err);
                setToast && setToast({ kind: 'error', message: 'ดาวน์โหลดบิลไม่สำเร็จ' });
              }
            }}>ดาวน์โหลด PDF</Btn>
            <Btn variant="primary"
              disabled={dbBillsLoading && previewBill._source !== 'db'}
              onClick={() => {
              // Route through the same readiness modal as the row "ส่งเตือน"
              // button so admin sees send history + monthCount + friction
              // before firing. Previously this button bypassed the popup
              // and sent silently.
              const b = previewBill;
              setPreviewBill(null);
              handleSendReminder(b.id);
            }}>{dbBillsLoading && previewBill._source !== 'db' ? 'กำลังโหลดบิลจริง…' : 'ส่งให้ผู้เช่า'}</Btn>
          </>
        )}
      >
        {previewBill && <BillPreview b={previewBill} />}
      </Modal>

      {/* Pretty send-reminder confirm. Replaces the old window.confirm()
          chain with a Modal that lists every readiness issue as a card
          (sev colour-coded), surfaces the recipient channels (LINE/email
          state), and only enables the green "ส่ง" button when canSend
          is true. Cancel and "ส่งต่อ" pathways both close the modal. */}
      <Modal
        open={!!sendConfirm}
        onClose={() => !sendingNow && setSendConfirm(null)}
        title={sendConfirm ? `ส่งบิล ${sendConfirm.bill.dbBillNo || sendConfirm.billId}` : ''}
        width={520}
        footer={sendConfirm && (() => {
          const sh = sendConfirm.readiness?.summary?.sendHistory;
          // Block confirm when admin is about to resend within ~5 min
          // unless they explicitly tick the friction checkbox.
          const ackNeeded = !!(sh && sh.veryRecently);
          const ackBlocking = ackNeeded && !justSentAck;
          return (
            <>
              <Btn variant="ghost" onClick={() => setSendConfirm(null)} disabled={sendingNow}>
                ยกเลิก
              </Btn>
              {sendConfirm.readiness?.summary?.canSend ? (
                <Btn variant="primary"
                  onClick={() => doSendReminder(sendConfirm.billId)}
                  disabled={sendingNow || ackBlocking}
                  title={ackBlocking ? 'ติ๊กยืนยันก่อนว่าเข้าใจว่าผู้เช่าเพิ่งได้รับ' : ''}>
                  {sendingNow ? 'กำลังส่ง…'
                    : ackNeeded
                      ? (justSentAck ? 'ยืนยันส่งซ้ำ' : 'ติ๊กยืนยันก่อน')
                      : (sh && sh.count > 0 ? 'ยืนยันส่งซ้ำ' : 'ยืนยันส่ง')}
                </Btn>
              ) : (
                <Btn variant="primary"
                  onClick={() => setSendConfirm(null)}
                  style={{ background: C.muted }}>
                  เข้าใจแล้ว
                </Btn>
              )}
            </>
          );
        })()}
      >
        {sendConfirm && <SendReminderConfirmBody
          confirm={sendConfirm}
          C={C}
          fmtCurrency={fmtCurrency}
          justSentAck={justSentAck}
          setJustSentAck={setJustSentAck}
        />}
      </Modal>

      {/* Bulk-send preflight — replaces the wall-of-text window.confirm()
          with a Modal showing the server's per-issue breakdown so admin
          knows exactly how many bills will succeed vs fail before firing
          the bulk-send pipeline. */}
      <Modal
        open={!!bulkSendPreview}
        onClose={() => !bulkSendingNow && setBulkSendPreview(null)}
        title={bulkSendPreview?.selectedIds
          ? `ส่งบิลที่เลือก (${bulkSendPreview.selectedIds.length} ใบ)`
          : 'ส่งบิลค้างชำระ'}
        width={560}
        footer={bulkSendPreview && (() => {
          // When scoped to a selection, count only the selected bills
          // that are actually sendable per batch readiness. Otherwise use
          // the page-wide canSend total.
          let ready;
          if (Array.isArray(bulkSendPreview.selectedIds)) {
            const bmap = bulkSendPreview.readiness?.bills || {};
            ready = bulkSendPreview.selectedIds.filter((id) => bmap[id]?.canSend !== false).length;
          } else {
            ready = bulkSendPreview.readiness?.summary?.canSend ?? bulkSendPreview.pending.length;
          }
          return (
            <>
              <Btn variant="ghost" onClick={() => setBulkSendPreview(null)} disabled={bulkSendingNow}>
                ยกเลิก
              </Btn>
              <Btn variant="primary"
                onClick={doBulkSendNow}
                disabled={bulkSendingNow || ready === 0}>
                {bulkSendingNow ? 'กำลังส่ง…' : `ยืนยันส่ง (${ready} ใบที่พร้อม)`}
              </Btn>
            </>
          );
        })()}
      >
        {bulkSendPreview && <BulkSendPreviewBody
          preview={bulkSendPreview} C={C} fmtCurrency={fmtCurrency} />}
      </Modal>

      {/* Manual mark-paid modal — replaces the old window.confirm() that
          forced method='transfer' for every offline payment. Admin now
          picks เงินสด / โอน / PromptPay, can add a note, and the
          tenant's confirmation message labels the actual method. */}
      <Modal
        open={!!markPaidPrompt}
        onClose={() => markPaidPrompt && !markPaidPrompt.busy && setMarkPaidPrompt(null)}
        title="บันทึกการชำระเงิน"
        width={460}
        footer={markPaidPrompt && (
          <>
            <Btn variant="ghost"
                 onClick={() => setMarkPaidPrompt(null)}
                 disabled={markPaidPrompt.busy}>ยกเลิก</Btn>
            <Btn variant="primary"
                 onClick={async () => {
                   setMarkPaidPrompt({ ...markPaidPrompt, busy: true });
                   const ok = await submitMarkPaid({
                     bill: markPaidPrompt.bill,
                     method: markPaidPrompt.method,
                     ref: markPaidPrompt.ref,
                     note: markPaidPrompt.note,
                     slipDataUrl: markPaidPrompt.slipDataUrl,
                   });
                   if (ok) setMarkPaidPrompt(null);
                   else setMarkPaidPrompt({ ...markPaidPrompt, busy: false });
                 }}
                 disabled={markPaidPrompt.busy}>
              {markPaidPrompt.busy ? 'กำลังบันทึก…' : 'ยืนยันบันทึก'}
            </Btn>
          </>
        )}
      >
        {markPaidPrompt && (
          <div style={{ fontSize: 13.5, color: C.ink, lineHeight: 1.6 }}>
            <div style={{ marginBottom: 12, padding: 10, background: C.bgSoft || '#fbf6ec', borderRadius: 8 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                บิล {markPaidPrompt.bill.dbBillNo || markPaidPrompt.bill.dbBillId} ·
                ห้อง {markPaidPrompt.bill.roomId}
              </div>
              <div style={{ color: C.muted, fontSize: 12.5 }}>
                ผู้เช่า: {markPaidPrompt.bill.tenant || '-'} · ยอด {fmtCurrency(markPaidPrompt.bill.total)}
              </div>
            </div>
            {markPaidPrompt.readinessIssues ? (
              <div style={{
                marginBottom: 12, padding: 10,
                background: markPaidPrompt.readinessIssues.high > 0 ? '#fff4f1' : '#fff8e6',
                border: `1px solid ${markPaidPrompt.readinessIssues.high > 0 ? '#f3c2b8' : '#ead49a'}`,
                borderRadius: 8, fontSize: 12, color: C.ink2, lineHeight: 1.5,
                whiteSpace: 'pre-line',
              }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  พบ {markPaidPrompt.readinessIssues.count} ข้อควรทราบเรื่องตั้งค่ารับชำระ
                </div>
                {markPaidPrompt.readinessIssues.lines}
              </div>
            ) : null}

            <div style={{ fontWeight: 600, marginBottom: 6 }}>ผู้เช่าจ่ายมาทางไหน? *</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
              {[
                { key: 'cash', label: 'เงินสด', desc: 'รับที่สำนักงาน' },
                { key: 'transfer', label: 'โอน', desc: 'ธนาคารปกติ' },
                { key: 'promptpay', label: 'PromptPay', desc: 'QR สแกน' },
              ].map((m) => {
                const sel = markPaidPrompt.method === m.key;
                return (
                  <button key={m.key} type="button"
                    onClick={() => setMarkPaidPrompt({ ...markPaidPrompt, method: m.key })}
                    disabled={markPaidPrompt.busy}
                    style={{
                      padding: '10px 8px', textAlign: 'center', cursor: 'pointer',
                      border: `2px solid ${sel ? (C.accent || C.warning) : C.border}`,
                      background: sel ? (C.accentSoft || '#fef6e0') : C.bg,
                      color: C.ink, borderRadius: 8,
                      fontFamily: 'inherit', fontSize: 13, fontWeight: sel ? 600 : 400,
                    }}>
                    <div>{m.label}</div>
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{m.desc}</div>
                  </button>
                );
              })}
            </div>

            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              อ้างอิง (ไม่บังคับ)
              {markPaidPrompt.method !== 'cash'
                ? <span style={{ fontWeight: 400, color: C.muted, fontSize: 12 }}> — เช่น เลขที่สลิป / transRef</span>
                : <span style={{ fontWeight: 400, color: C.muted, fontSize: 12 }}> — เช่น เลขใบเสร็จที่ออกให้ผู้เช่า</span>}
            </div>
            <input type="text" maxLength={120}
              value={markPaidPrompt.ref}
              onChange={(e) => setMarkPaidPrompt({ ...markPaidPrompt, ref: e.target.value })}
              disabled={markPaidPrompt.busy}
              placeholder={markPaidPrompt.method === 'cash' ? 'เช่น RC-001/2026' : 'เช่น 2026051500001'}
              style={{
                width: '100%', padding: '8px 10px', borderRadius: 6,
                border: `1px solid ${C.border}`, background: C.bg, color: C.ink,
                fontFamily: 'inherit', fontSize: 13, marginBottom: 12,
              }} />

            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              บันทึกเพิ่ม (ไม่บังคับ)
            </div>
            <input type="text" maxLength={200}
              value={markPaidPrompt.note}
              onChange={(e) => setMarkPaidPrompt({ ...markPaidPrompt, note: e.target.value })}
              disabled={markPaidPrompt.busy}
              placeholder="เช่น 'รับจากคุณแม่ของผู้เช่า'"
              style={{
                width: '100%', padding: '8px 10px', borderRadius: 6,
                border: `1px solid ${C.border}`, background: C.bg, color: C.ink,
                fontFamily: 'inherit', fontSize: 13, marginBottom: 12,
              }} />

            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              แนบรูปสลิป/ใบเสร็จเป็นหลักฐาน (ไม่บังคับ)
            </div>
            <input type="file" accept="image/jpeg,image/png,image/webp"
              disabled={markPaidPrompt.busy}
              onChange={(e) => {
                const f = e.target.files && e.target.files[0];
                if (!f) {
                  setMarkPaidPrompt((prev) => prev ? { ...prev, slipFile: null, slipDataUrl: null, slipError: '' } : prev);
                  return;
                }
                const allowed = ['image/jpeg', 'image/png', 'image/webp'];
                if (f.type && !allowed.includes(f.type)) {
                  const msg = 'รองรับเฉพาะไฟล์ JPG, PNG หรือ WebP เท่านั้น — ไฟล์นี้จะไม่ถูกส่งเข้าระบบ';
                  e.target.value = '';
                  setMarkPaidPrompt((prev) => prev ? { ...prev, slipFile: null, slipDataUrl: null, slipError: msg } : prev);
                  setToast && setToast({ kind: 'warning', message: msg });
                  return;
                }
                if (f.size > 5 * 1024 * 1024) {
                  const msg = 'ไฟล์ใหญ่เกินไป (เกิน 5 MB) — โปรดถ่ายใหม่หรือลดขนาดภาพก่อน';
                  e.target.value = '';
                  setMarkPaidPrompt((prev) => prev ? { ...prev, slipFile: null, slipDataUrl: null, slipError: msg } : prev);
                  setToast && setToast({ kind: 'warning', message: msg });
                  return;
                }
                const reader = new FileReader();
                reader.onload = () => {
                  setMarkPaidPrompt((prev) => prev ? {
                    ...prev, slipFile: f, slipDataUrl: reader.result, slipError: '',
                  } : prev);
                };
                reader.onerror = () => {
                  const msg = 'อ่านไฟล์ไม่สำเร็จ — โปรดเลือกใหม่';
                  setMarkPaidPrompt((prev) => prev ? { ...prev, slipFile: null, slipDataUrl: null, slipError: msg } : prev);
                  setToast && setToast({ kind: 'error', message: msg });
                };
                reader.readAsDataURL(f);
              }}
              style={{ display: 'block', marginBottom: 6 }} />
            {markPaidPrompt.slipError ? (
              <div role="alert" style={{
                fontSize: 11.5, color: C.danger || '#c0392b',
                background: C.dangerSoft || '#fdecea',
                border: `1px solid ${(C.danger || '#c0392b')}33`,
                borderRadius: 6, padding: '7px 9px', marginBottom: 8,
              }}>{markPaidPrompt.slipError}</div>
            ) : null}
            <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 12 }}>
              เก็บเป็นหลักฐานในประวัติชำระ ดูได้ที่ /admin#payments · JPG/PNG/WebP · ไม่เกิน 5 MB
              {markPaidPrompt.slipFile
                ? ` · เลือกไฟล์แล้ว: ${markPaidPrompt.slipFile.name} (${Math.ceil(markPaidPrompt.slipFile.size / 1024)} KB)`
                : ''}
            </div>

            <div style={{
              padding: 10, borderRadius: 8,
              background: C.bgSoft || '#fbf6ec', color: C.ink2,
              fontSize: 12.5, lineHeight: 1.6,
            }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>สิ่งที่จะเกิดขึ้น</div>
              <div>• บิลจะถูกตั้งเป็น <b>ชำระแล้ว</b> ทันที</div>
              <div>• ผู้เช่าจะได้รับแจ้งเตือนทาง LINE/อีเมล พร้อมระบุช่องทาง <b>{({ cash: 'เงินสด', transfer: 'โอน', promptpay: 'PromptPay' })[markPaidPrompt.method] || markPaidPrompt.method}</b></div>
              <div>• เก็บใน audit log โดยใช้ชื่อ login ของคุณ</div>
              {markPaidPrompt.method === 'cash'
                ? <div style={{ marginTop: 4 }}>• <b>เงินสด</b> — ไม่ต้องมีสลิป</div>
                : <div style={{ marginTop: 4 }}>• ถ้ามีสลิปจริง แนะนำให้ผู้เช่าอัปโหลดที่ /tenant จะดีกว่า เพราะระบบตรวจสลิปอัตโนมัติได้</div>}
            </div>
          </div>
        )}
      </Modal>
    </PageContainer>
  );
}

function BillingWorkflowStrip({ C, fmt, stats, readinessStats, dbBillsLoading }) {
  const stepBase = {
    minWidth: 0,
    padding: '10px 12px',
    borderRadius: 8,
    border: `1px solid ${C.borderSoft || C.border}`,
    background: C.surface,
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
  };
  const numStyle = (bg, color) => ({
    width: 24,
    height: 24,
    borderRadius: 999,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 24px',
    background: bg,
    color,
    fontSize: 12,
    fontWeight: 700,
    fontFamily: 'JetBrains Mono, monospace',
  });
  const titleStyle = { fontSize: 12.5, color: C.ink, fontWeight: 700, marginBottom: 2 };
  const descStyle = { fontSize: 11.5, color: C.muted, lineHeight: 1.45 };
  const readyText = readinessStats.loading
    ? 'กำลังตรวจช่องทางส่ง'
    : readinessStats.payable === 0
      ? 'ไม่มีบิลค้างส่ง'
      : `พร้อม ${fmt(readinessStats.ready)} · ติดปัญหา ${fmt(readinessStats.blocked)}`
        + (readinessStats.unknown ? ` · รอตรวจ ${fmt(readinessStats.unknown)}` : '');
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
      gap: 10,
      marginBottom: 14,
    }}>
      <div style={stepBase}>
        <span style={numStyle(stats.estimateCount ? C.warningSoft : C.successSoft, stats.estimateCount ? C.warningInk : C.success)}>
          1
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={titleStyle}>ออกบิลจริง</div>
          <div style={descStyle}>
            {fmt(stats.issued)} ใบใน DB
            {stats.estimateCount ? ` · ยังเป็นประมาณการ ${fmt(stats.estimateCount)} แถว` : ' · ครบตามรายการที่แสดง'}
          </div>
        </div>
      </div>
      <div style={stepBase}>
        <span style={numStyle(
          readinessStats.blocked ? C.dangerSoft : (readinessStats.ready ? C.successSoft : C.surfaceAlt),
          readinessStats.blocked ? C.dangerInk : (readinessStats.ready ? C.success : C.muted)
        )}>
          2
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={titleStyle}>ตรวจพร้อมส่ง</div>
          <div style={descStyle}>{readyText}</div>
        </div>
      </div>
      <div style={stepBase}>
        <span style={numStyle(readinessStats.unsent ? C.warningSoft : C.successSoft, readinessStats.unsent ? C.warningInk : C.success)}>
          3
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={titleStyle}>ส่งผู้เช่า</div>
          <div style={descStyle}>
            ส่งแล้ว {fmt(readinessStats.sent)} · ยังไม่ส่ง {fmt(readinessStats.unsent)}
            {dbBillsLoading ? ' · กำลังซิงก์' : ''}
          </div>
        </div>
      </div>
    </div>
  );
}

// BulkSendPreviewBody — renders the breakdown of which bills will/won't
// send, grouped by block code, so the admin sees the picture before
// firing the pipeline.
function BulkSendPreviewBody({ preview, C, fmtCurrency }) {
  const { pending, totalAmount, readiness, selectedIds } = preview;
  const summary = readiness?.summary || {
    total: pending.length, canSend: pending.length, blocked: 0, issueCounts: {},
  };
  const blockCodeLabel = {
    BILL_NOT_LINKED: 'บิลไม่ผูกผู้เช่า',
    TENANT_DELETED: 'ผู้เช่าถูกลบ',
    TENANT_NOT_ACTIVE: 'สถานะผู้เช่าไม่พร้อม',
    TENANT_MOVED_ROOM: 'ผู้เช่าย้ายห้อง/ไม่ผูกห้อง',
    NO_TENANT_CHANNEL: 'ไม่ผูก LINE + ไม่มีอีเมล',
    EMAIL_NOT_CONFIGURED: 'มีอีเมล แต่ระบบ SMTP ยังไม่พร้อม',
  };
  const codes = Object.entries(summary.issueCounts || {}).sort((a, b) => b[1] - a[1]);
  const fmt = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // When the bulk-send is scoped to a selection, surface any selected
  // bills that were recently reminded so admin can spot accidental
  // re-blasts before firing. Pulls from batchReadiness (lastRemindedAt
  // + reminderCount per bill).
  const billsMap = readiness?.bills || {};
  const recentlySent = Array.isArray(selectedIds)
    ? selectedIds
        .map((id) => {
          const r = billsMap[id];
          if (!r || !r.reminderCount) return null;
          const target = pending.find((b) => b.dbBillId === id);
          return target ? {
            id, count: r.reminderCount,
            minutesAgo: r.minutesAgo,
            tenant: r.tenantName || target?.tenant || '-',
            roomId: target?.roomId || '-',
            veryRecent: r.minutesAgo != null && r.minutesAgo < 60,
          } : null;
        })
        .filter(Boolean)
        .sort((a, b) => (a.minutesAgo ?? Infinity) - (b.minutesAgo ?? Infinity))
    : [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Headline summary */}
      <div style={{
        padding: 14, borderRadius: 10,
        background: summary.blocked === 0 ? '#f0f9f0' : (summary.canSend === 0 ? C.dangerSoft : C.warningSoft),
        border: `1px solid ${summary.blocked === 0 ? '#bce0bc' : (summary.canSend === 0 ? C.danger : '#f0e3a7')}`,
      }}>
        <div style={{ fontFamily: 'IBM Plex Sans Thai', fontWeight: 600, fontSize: 14.5 }}>
          {summary.blocked === 0 ? 'ทุกบิลพร้อมส่ง'
            : summary.canSend === 0 ? 'ส่งไม่ได้สักใบ'
            : `ส่งได้ ${summary.canSend} ใบ — ติดปัญหา ${summary.blocked} ใบ`}
        </div>
        <div style={{ fontSize: 12.5, color: C.muted, marginTop: 4 }}>
          ทั้งหมด {summary.total} ใบ · ยอดรวม ฿{fmt(totalAmount)}
        </div>
      </div>

      {/* Per-issue breakdown */}
      {codes.length > 0 ? (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
            ปัญหาที่พบ (จะถูกข้าม):
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {codes.map(([code, count]) => (
              <div key={code} style={{
                padding: 10, borderRadius: 6,
                background: C.dangerSoft,
                borderLeft: '3px solid #b94a48',
                fontSize: 13,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <strong style={{ color: C.dangerInk }}>
                    ปัญหา: {blockCodeLabel[code] || code}
                  </strong>
                  <span style={{ color: C.dangerInk, fontWeight: 600 }}>{count} ใบ</span>
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 8, lineHeight: 1.5 }}>
            คำแนะนำ: แก้ปัญหารายห้องที่ /admin#tenants ก่อน แล้วกลับมากดส่งใหม่
          </div>
        </div>
      ) : null}

      {/* Recently-sent warnings — only shown when scoped to a selection.
          Helps admin spot the bills that were just reminded so they
          don't double-blast tenants in a single workflow. */}
      {recentlySent.length > 0 ? (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
            บิลที่เคยส่งมาแล้ว (ระวังส่งซ้ำ):
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {recentlySent.slice(0, 6).map((it) => {
              const ago = it.minutesAgo == null ? '-'
                : it.minutesAgo < 60 ? `${it.minutesAgo} นาทีก่อน`
                : it.minutesAgo < 1440 ? `${Math.round(it.minutesAgo / 60)} ชม.ก่อน`
                : `${Math.round(it.minutesAgo / 1440)} วันก่อน`;
              return (
                <div key={it.id} style={{
                  padding: 8, borderRadius: 6, fontSize: 12.5,
                  background: it.veryRecent ? '#fff5e8' : C.surfaceAlt,
                  borderLeft: `3px solid ${it.veryRecent ? C.warning : '#bcaf95'}`,
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <span>ห้อง {it.roomId} · {it.tenant}</span>
                  <span style={{ color: C.muted, fontSize: 11.5 }}>
                    ส่งแล้ว {it.count}× · ล่าสุด {ago}
                  </span>
                </div>
              );
            })}
            {recentlySent.length > 6 ? (
              <div style={{ fontSize: 11.5, color: C.muted, textAlign: 'center' }}>
                และอีก {recentlySent.length - 6} ใบ
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Footnote */}
      <div style={{
        padding: 10, borderRadius: 6, background: C.surfaceAlt,
        border: `1px solid ${C.borderSoft || C.border}`,
        fontSize: 12, color: C.muted, lineHeight: 1.6,
      }}>
        ระบบจะ enqueue ในคิว — ส่งจริงภายใน ~1 นาที<br/>
        ดูคิวที่ /admin#notifications-queue<br/>
        กดบ่อย = ผู้เช่าได้ข้อความซ้ำ (LINE rate-limit = 1000/วัน)
      </div>
    </div>
  );
}

// SendReminderConfirmBody — the modal contents. Renders bill summary,
// recipient info, channel availability, and a card per readiness issue.
// Renders send history (this-bill count + this-tenant month count +
// per-bill timeline) so admin can answer "did this person just hear
// from us?" before clicking confirm.
function SendReminderConfirmBody({ confirm, C, fmtCurrency, justSentAck, setJustSentAck }) {
  const { bill, readiness } = confirm;
  const r = readiness || {};
  const summary = r.summary || {};
  const t = r.tenant;
  const channels = summary.channels || {};
  const blocked = summary.blocked === true;
  const issues = Array.isArray(r.issues) ? r.issues : [];
  const emailHasAddress = !!channels.emailAddress;
  const emailConfigured = channels.emailConfigured !== false;
  const emailReady = !!channels.email;
  const emailLabel = emailReady
    ? 'Email พร้อม'
    : emailHasAddress && !emailConfigured
      ? 'มี Email แต่ SMTP ไม่พร้อม'
      : emailHasAddress
        ? 'Email ไม่พร้อม'
        : 'ไม่มี Email';

  const sevPalette = {
    high: { bg: C.dangerSoft, border: C.danger, accent: C.danger, label: 'ปัญหาสำคัญ' },
    med:  { bg: C.warningSoft, border: '#f0e3a7', accent: '#8a6b1a', label: 'ควรตรวจ' },
    low:  { bg: '#f4f8fc', border: '#cfdde9', accent: '#3a5a78', label: 'ข้อมูล' },
    info: { bg: '#f4f8fc', border: '#cfdde9', accent: '#3a5a78', label: 'ข้อมูล' },
  };

  // Show send history as a top-of-modal banner so admin sees it BEFORE
  // they click confirm — previously buried in the issues list. The hard
  // debounce was removed (admin asked for resend-anytime), so this is
  // purely informational: "ส่งไปแล้ว N ครั้ง · ล่าสุด X นาทีก่อน".
  const sendHistory = summary.sendHistory;
  const channelLabel = { line: 'LINE', email: 'อีเมล' };
  const statusLabel = {
    pending: 'รอส่ง', sent: 'ส่งแล้ว', failed: 'พลาด', skipped: 'ข้าม',
  };
  const fmtTime = (iso) => {
    if (!iso) return '-';
    const d = new Date(iso);
    return d.toLocaleString('th-TH', {
      day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit',
    });
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Top banner — ready / blocked summary */}
      <div style={{
        padding: 12, borderRadius: 8,
        background: blocked ? C.dangerSoft : (issues.length > 0 ? C.warningSoft : '#f0f9f0'),
        border: `1px solid ${blocked ? C.danger : (issues.length > 0 ? '#f0e3a7' : '#bce0bc')}`,
      }}>
        <div style={{ fontFamily: 'IBM Plex Sans Thai', fontWeight: 600, fontSize: 14.5 }}>
          {blocked
            ? `ส่งไม่ได้ — พบ ${summary.highCount || issues.length} ปัญหาสำคัญ`
            : issues.length > 0
              ? `ส่งได้ — แต่มี ${issues.length} ข้อควรทราบ`
              : `พร้อมส่ง`}
        </div>
        <div style={{ fontSize: 12.5, color: C.muted, marginTop: 4, lineHeight: 1.5 }}>
          {blocked
            ? 'แก้ปัญหาด้านล่างให้ครบก่อนถึงจะส่งได้'
            : issues.length > 0
              ? 'ตรวจประเด็นด้านล่าง — กดยืนยันส่งถ้า OK กับ tradeoff'
              : 'ผู้เช่ามีช่องทางรับ + บิลพร้อม — กดยืนยันได้เลย'}
        </div>
      </div>

      {sendHistory && (sendHistory.count > 0 || (sendHistory.monthCount || 0) > 0) ? (
        <div style={{
          padding: 12, borderRadius: 8,
          background: sendHistory.veryRecently ? '#fbeae7'
            : sendHistory.recently ? '#fff5e8' : '#f4f8fc',
          border: `1px solid ${sendHistory.veryRecently ? C.danger
            : sendHistory.recently ? '#f0c47a' : '#cfdde9'}`,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            {sendHistory.veryRecently ? 'เพิ่งส่งไปเมื่อกี้ — ระวังส่งซ้ำ'
              : sendHistory.recently ? 'เพิ่งส่งไปไม่นาน'
              : 'เคยส่งเตือนมาแล้ว'}
          </div>
          <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.7 }}>
            <div>
              บิลใบนี้: ส่งไปแล้ว <b style={{ color: C.ink }}>{sendHistory.count}</b> ครั้ง
              {sendHistory.lastSentAt
                ? ` · ล่าสุด ${sendHistory.minutesAgo} นาทีก่อน (${fmtTime(sendHistory.lastSentAt)})`
                : ''}
            </div>
            {(sendHistory.monthCount || 0) > 0 ? (
              <div>
                ผู้เช่าคนนี้เดือนนี้: ได้รับข้อความ <b style={{ color: C.ink }}>{sendHistory.monthCount}</b> ครั้ง
                {(sendHistory.monthCount > sendHistory.count)
                  ? ` (รวมบิลใบอื่นด้วย ${sendHistory.monthCount - sendHistory.count} ครั้ง)`
                  : ''}
              </div>
            ) : null}
            {sendHistory.count >= 3 ? (
              <div style={{ marginTop: 4, color: C.dangerInk }}>
                ส่งไปเยอะแล้ว — แนะนำลองโทรหรือทักทาง LINE OA ส่วนตัวแทน
              </div>
            ) : null}
          </div>

          {Array.isArray(sendHistory.recentSends) && sendHistory.recentSends.length > 0 ? (
            <div style={{ marginTop: 10, fontSize: 12, color: C.ink2 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>ประวัติส่งบิลใบนี้</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {sendHistory.recentSends.map((s, i) => (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between',
                    padding: '3px 8px',
                    background: 'rgba(255,255,255,0.5)',
                    borderRadius: 4, fontSize: 11.5,
                  }}>
                    <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      {fmtTime(s.at)}
                    </span>
                    <span style={{ color: C.muted }}>
                      {channelLabel[s.channel] || s.channel}
                      {' · '}
                      <span style={{
                        color: s.status === 'sent' ? C.success
                          : s.status === 'failed' ? C.danger : C.muted,
                      }}>
                        {statusLabel[s.status] || s.status}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {sendHistory.veryRecently ? (
            <label style={{
              display: 'flex', alignItems: 'flex-start', gap: 8,
              marginTop: 10, padding: 8, borderRadius: 6,
              background: 'rgba(255,255,255,0.6)', cursor: 'pointer',
              fontSize: 12.5, lineHeight: 1.5, color: C.ink,
            }}>
              <input type="checkbox"
                checked={!!justSentAck}
                onChange={(e) => setJustSentAck(e.target.checked)}
                style={{ marginTop: 2, accentColor: C.accent || C.warning }} />
              <span>
                <b>เข้าใจว่าผู้เช่าเพิ่งได้รับข้อความนี้ไปเมื่อกี้</b>
                {' '}— ยังต้องการส่งซ้ำเพราะ (เช่น ผู้เช่าโทรมาบอกไม่เห็น)
              </span>
            </label>
          ) : null}
        </div>
      ) : null}

      {/* Bill summary card */}
      <div style={{
        padding: 12, borderRadius: 8, background: C.surfaceAlt || C.bg,
        border: `1px solid ${C.borderSoft || C.border}`,
      }}>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>บิลที่จะส่ง</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: 'IBM Plex Sans Thai', fontWeight: 600 }}>
              ห้อง {bill.roomId} · รอบ {bill.period || '-'}
            </div>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 2 }}>
              เลขที่ {bill.dbBillNo || bill.id} · กำหนด {bill.dueDate || '-'}
            </div>
          </div>
          <div style={{ fontFamily: 'IBM Plex Sans Thai', fontWeight: 700, fontSize: 18 }}>
            {fmtCurrency(bill.total)}
          </div>
        </div>
      </div>

      {/* Recipient card — only when readiness gave us a tenant */}
      {t ? (
        <div style={{
          padding: 12, borderRadius: 8, background: C.surfaceAlt || C.bg,
          border: `1px solid ${C.borderSoft || C.border}`,
        }}>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>จะส่งให้</div>
          <div style={{ fontFamily: 'IBM Plex Sans Thai', fontWeight: 600 }}>{t.name || '-'}</div>
          <div style={{ fontSize: 12.5, color: C.muted, marginTop: 2 }}>
            {t.phone || '-'}{t.email ? ` · ${t.email}` : ''}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 11.5, padding: '3px 9px', borderRadius: 999,
              background: channels.line ? C.successSoft : '#fbeae7',
              color: channels.line ? C.success : C.dangerInk,
            }}>
              {channels.line ? 'มี LINE' : 'ไม่มี LINE'}
            </span>
            <span style={{
              fontSize: 11.5, padding: '3px 9px', borderRadius: 999,
              background: emailReady ? C.successSoft : (emailHasAddress ? C.warningSoft : '#fbeae7'),
              color: emailReady ? C.success : (emailHasAddress ? C.warningInk : C.dangerInk),
            }}>
              {emailLabel}
            </span>
          </div>
        </div>
      ) : null}

      {/* Issue cards — one per issue with sev colour + fix link */}
      {issues.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {issues.map((it, idx) => {
            const p = sevPalette[it.sev] || sevPalette.low;
            return (
              <div key={idx} style={{
                padding: 10, borderRadius: 6,
                background: p.bg, border: `1px solid ${p.border}`,
                borderLeft: `3px solid ${p.accent}`,
              }}>
                <div style={{ fontWeight: 500, fontSize: 13.5, lineHeight: 1.5 }}>
                  <span style={{ color: p.accent, fontWeight: 700 }}>{p.label}: </span>{it.msg}
                </div>
                {it.fix ? (
                  <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
                    → {it.fix}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function BillPreview({ b }) {
  const C = window.ADMIN_C;
  const { fmtCurrency } = window;
  const { Pill } = window;
  const statusMeta = billStatusMeta(b);
  const isPersistedBill = b._source === 'db' && b.dbBillId;

  const rows = [
    { label: 'ค่าเช่ารายเดือน', value: b.rent },
    {
      label: `ค่าน้ำ (${fmtQty(b.waterUnits)} หน่วย × ${fmtQty(b.waterRate || 0)})`,
      detail: utilityDetailFromBill(b, 'water'),
      value: b.water,
    },
    {
      label: `ค่าไฟ (${fmtQty(b.elecUnits)} หน่วย × ${fmtQty(b.elecRate || 0)})`,
      detail: utilityDetailFromBill(b, 'elec'),
      value: b.elec,
    },
    { label: 'ค่า Wi-Fi', value: b.wifi },
  ];
  if (Number(b.commonFee) > 0) rows.push({ label: 'ค่าส่วนกลาง', value: b.commonFee });
  const otherCharges = Array.isArray(b.charges)
    ? b.charges.filter((c) => {
        const amount = Number(c && c.amount) || 0;
        if (amount <= 0) return false;
        const label = String((c && c.label) || '');
        return !(Number(b.commonFee) > 0 && /ส่วนกลาง|common/i.test(label));
      })
    : [];
  otherCharges.forEach((c) => rows.push({
    label: String(c.label || 'ค่าอื่น ๆ'),
    detail: c.frequency ? `รอบ ${c.frequency}` : '',
    value: Number(c.amount) || 0,
  }));
  if (Number(b.vat) > 0) rows.push({ label: 'ภาษีมูลค่าเพิ่ม (VAT)', value: Number(b.vat) || 0 });
  if (Number(b.penalty) > 0) {
    rows.push({ label: `ค่าปรับชำระล่าช้า (${Number(b.overdueDays) || 0} วัน)`, value: b.penalty, danger: true });
  }

  return (
    <div>
      {!isPersistedBill ? (
        <div style={{
          padding: 12,
          borderRadius: 8,
          background: C.warningSoft || '#fbf1de',
          borderLeft: `4px solid ${C.warning || '#c98a2b'}`,
          color: C.warningInk || '#7A5A0F',
          fontSize: 12.5,
          lineHeight: 1.6,
          marginBottom: 12,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 2 }}>บิลนี้ยังเป็นประมาณการ</div>
          <div>ยังไม่มีแถวบิลจริงใน DB จึงส่งให้ผู้เช่า บันทึกชำระ หรือ track สถานะส่งไม่ได้</div>
          <div style={{ marginTop: 3 }}>
            ขั้นตอนถัดไป: กดออกบิลจริงก่อน แล้วรอป้ายในตารางเปลี่ยนเป็น "ออกแล้ว"
          </div>
        </div>
      ) : (
        <div style={{
          padding: 10,
          borderRadius: 8,
          background: C.successSoft || '#e3f3e8',
          color: C.successInk || '#1d4a2c',
          fontSize: 12,
          lineHeight: 1.5,
          marginBottom: 12,
        }}>
          บิลจริงใน DB #{b.dbBillId}{b.tenantId ? ` · tenant_id=${b.tenantId}` : ''} พร้อมตรวจช่องทางส่งและสถานะชำระ
        </div>
      )}
      <div style={{
        padding: 16, background: C.surfaceAlt, borderRadius: 10,
        marginBottom: 16,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div>
          <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 2 }}>เลขที่บิล</div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 14, fontWeight: 600, color: C.ink }}>{b.id}</div>
          <div style={{ fontSize: 12.5, color: C.muted, marginTop: 6 }}>{b.tenant} · ห้อง {b.roomId}</div>
        </div>
        <Pill color={statusMeta.color}>{statusMeta.label}</Pill>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: `1px dashed ${C.borderSoft}` }}>
            <span style={{ fontSize: 13, color: r.danger ? C.danger : C.ink2, lineHeight: 1.45 }}>
              {r.label}
              {r.detail ? <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>{r.detail}</div> : null}
            </span>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13.5, fontWeight: 500, color: r.danger ? C.danger : C.ink }}>
              {fmtCurrency(r.value)}
            </span>
          </div>
        ))}
      </div>

      <div style={{
        padding: 14, background: C.dark, borderRadius: 10, color: '#fff',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div>
          <div style={{ fontSize: 12, color: '#bcaf95' }}>ยอดรวมที่ต้องชำระ</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>ครบกำหนด {b.dueDateDisplay || b.dueDate}</div>
        </div>
        <div style={{ fontFamily: 'IBM Plex Sans Thai, sans-serif', fontSize: 24, fontWeight: 700 }}>
          {fmtCurrency(b.total)}
        </div>
      </div>
    </div>
  );
}

window.PageBilling = PageBilling;
