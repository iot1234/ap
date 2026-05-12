// === admin/page-billing.jsx ===============================================
// บิลและการเงิน: รายการบิลเดือนนี้, ยังไม่ชำระ, ค้างชำระ, ออกบิล
// ===========================================================================

const { useState, useMemo } = React;

function PageBilling({ rooms, setRooms, config, addActivity, setToast }) {
  const C = window.ADMIN_C;
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES;
  const { fmt, fmtCurrency, fmtMonthTH } = window;
  const { Card, Btn, IconBtn, Avatar, Pill, KpiCard, DataTable, Modal, Toggle,
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

  // Real bills from DB for the current period. Falls back to client estimate
  // (computed from rooms blob below) when no bills have been issued yet, so
  // the page still shows what bills WOULD look like — the difference is now
  // visible via `realBillsByRoom` so admin can tell estimate from issued.
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
  const fetchDbBills = React.useCallback(() => {
    let cancel = false;
    setDbBills(null);
    setDbBillsErr(null);
    fetch(`/api/bills?period=${encodeURIComponent(currentPeriod)}&limit=500&withPayments=1`, {
      credentials: 'same-origin',
    })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (cancel) return;
        if (!r.ok) { setDbBillsErr(d.error || `HTTP ${r.status}`); setDbBills([]); return; }
        setDbBills(Array.isArray(d.bills) ? d.bills : []);
      })
      .catch((e) => { if (!cancel) { setDbBillsErr(e.message || 'network error'); setDbBills([]); } });
    return () => { cancel = true; };
  }, [currentPeriod]);
  React.useEffect(() => fetchDbBills(), [fetchDbBills]);

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
  // Map room_id → real DB bill so the in-memory estimate can adopt the
  // real status / total for any room that's already been billed this month.
  const realBillsByRoom = useMemo(() => {
    const map = {};
    (dbBills || []).forEach((b) => { if (b.room_id) map[String(b.room_id)] = b; });
    return map;
  }, [dbBills]);

  // Generate bills from rooms — recompute with CURRENT config rates so
  // changes in Pricing engine reflect immediately in this month's bills
  const bills = useMemo(() => {
    const waterRate = config.utilities?.waterRate ?? 18;
    const elecRate  = config.utilities?.elecRate  ?? 8;
    const wifiFee   = config.utilities?.wifi      ?? 250;
    return Object.values(rooms)
      .filter(r => r.tenant && (r.status === 'occupied' || r.status === 'overdue'))
      .map(r => {
        const water = (r.waterUnits || 0) * waterRate;
        const elec  = (r.elecUnits  || 0) * elecRate;
        const wifi  = (r.wifi != null && r.wifi !== 0) ? r.wifi : wifiFee;
        // Pending charges are tickets-completed-with-cost that haven't been
        // settled yet. Each charge becomes a line on this month's bill.
        const charges = Array.isArray(r.pendingCharges) ? r.pendingCharges : [];
        const chargesTotal = charges.reduce((s, c) => s + (Number(c.amount) || 0), 0);
        const total = r.rent + water + elec + wifi + chargesTotal;
        const overdue = r.status === 'overdue';
        const penalty = overdue ? (r.overdueDays || 0) * (config.fees?.latePenaltyPerDay || 0) : 0;
        const grandTotal = total + penalty;
        const now = new Date();
        // Period in ISO YYYY-MM (server schema requires this) — was Thai
        // text which made bill_no unicode and didn't match scheduler's ISO
        // period, so the same room/month produced two different bill rows.
        const periodIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        // Display period in Thai for the UI; ISO is for the API + bill_no.
        const periodDisplay = fmtMonthTH(now);
        // Due date in ISO YYYY-MM-DD (also schema-required). Uses
        // config.notify.dueOnDay if set, else 7th.
        const dueDay = Math.max(1, Math.min(28, Number(config.notify?.dueOnDay) || 7));
        const dueIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(dueDay).padStart(2, '0')}`;
        return {
          id: `INV-${periodIso}-${r.id}`,
          roomId: r.id,
          tenant: r.tenant.name,
          phone: r.tenant.phone,
          period: periodIso,            // for API
          periodDisplay,                 // for UI
          rent: r.rent,
          water, elec, wifi,
          waterUnits: r.waterUnits,
          elecUnits: r.elecUnits,
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
      })
      // Overlay real DB bill status on top of the estimate so the row
      // accurately reflects what was actually issued + collected. The
      // estimate stays as the breakdown source (waterUnits/elecUnits etc.
      // from the rooms blob), but status + total come from the bills row
      // when one exists for this room+period. The `_source` flag drives
      // the per-row "ออกแล้ว/ประมาณ" badge in the table.
      .map((est) => {
        const real = realBillsByRoom[String(est.roomId)];
        if (!real) return { ...est, _source: 'estimate' };
        return {
          ...est,
          _source: 'db',
          dbBillId: real.id,
          dbBillNo: real.bill_no,
          status: real.status === 'paid' ? 'paid' : 'unpaid',
          dbStatus: real.status,                     // pending / paid / overdue / void
          total: Number(real.total) || est.total,    // trust DB total over estimate
          // Slip summary (only present when fetched with withPayments=1).
          // Used by the row "การชำระ" column + the new "📥 รอตรวจสลิป" tab
          // so admin can see at-a-glance which bills have slips waiting,
          // which were auto-paid, and which were admin-approved.
          pendingSlipCount: Number(real.pending_slip_count) || 0,
          verifiedSlipCount: Number(real.verified_slip_count) || 0,
          rejectedSlipCount: Number(real.rejected_slip_count) || 0,
          latestPaidBy: real.latest_paid_by || null,
          latestPaidProvider: real.latest_paid_provider || null,
          latestPaidAt: real.latest_paid_at || null,
        };
      });
  }, [rooms, config, realBillsByRoom]);

  const filtered = useMemo(() => {
    if (tab === 'current') return bills;
    if (tab === 'unpaid')  return bills.filter(b => b.status === 'unpaid');
    if (tab === 'paid')    return bills.filter(b => b.status === 'paid');
    if (tab === 'review')  return bills.filter(b => (b.pendingSlipCount || 0) > 0);
    return bills;
  }, [bills, tab]);

  const pendingReviewCount = useMemo(
    () => bills.filter((b) => (b.pendingSlipCount || 0) > 0).length,
    [bills]
  );

  const stats = useMemo(() => {
    const issued = bills.length;
    const paidCount = bills.filter(b => b.status === 'paid').length;
    const unpaidCount = issued - paidCount;
    const totalRevenue = bills.filter(b => b.status === 'paid').reduce((s, b) => s + b.total, 0);
    const overdueAmt = bills.filter(b => b.status === 'unpaid').reduce((s, b) => s + b.total, 0);
    return { issued, paidCount, unpaidCount, totalRevenue, overdueAmt };
  }, [bills]);

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
      const r = await fetch('/api/admin/billing-readiness', { credentials: 'same-origin' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }, []);

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
      const icon = i.sev === 'high' ? '🔴'
        : i.sev === 'med' ? '🟡'
        : i.sev === 'info' ? 'ℹ️' : '⚪';
      const fix = i.fix ? `\n   → ${i.fix}` : '';
      return `${idx + 1}. ${icon} ${i.msg}${fix}`;
    }).join('\n\n');
    return { lines, high, count: relevant.length };
  }, []);

  const handleMarkPaid = async (id, opts = {}) => {
    const bill = bills.find(b => b.id === id);
    if (!bill) return false;
    if (bill._source !== 'db' || !bill.dbBillId) {
      setToast && setToast({ kind: 'warning', message: 'ต้องออกบิลเข้าระบบก่อน จึงจะบันทึกการชำระได้' });
      return false;
    }
    // Pre-flight: catch config gaps that would silently produce a payment row
    // for the wrong account / on the wrong bill state. Skip when caller passes
    // confirm:false (bulk actions handle their own confirmation upstream).
    if (opts.confirm !== false) {
      const readiness = await fetchBillingReadiness();
      const fmtIssues = formatReadinessIssues(readiness, 'payment');
      let prompt = `ยืนยันบันทึกชำระบิล ${bill.dbBillNo || bill.dbBillId}\n` +
                   `ห้อง ${bill.roomId} · ${fmtCurrency(bill.total)}`;
      if (fmtIssues) {
        prompt = `⚠️ พบ ${fmtIssues.count} ข้อควรทราบ${fmtIssues.high > 0 ? ` (${fmtIssues.high} ข้อสำคัญ)` : ''} ก่อนบันทึกชำระ:\n\n` +
                 fmtIssues.lines +
                 `\n\n📌 ${prompt}\n\n` +
                 (fmtIssues.high > 0
                   ? `   ⚠ บันทึกชำระยังทำได้ แต่ปัญหาข้างบนกระทบ flow รับชำระสลิป/ออก QR ถัดไป\n`
                   : '') +
                 `   • กดยกเลิก → แก้ปัญหาที่ link ด้านบนก่อน\n` +
                 `   • กดตกลง → บันทึกชำระต่อ (รับผิดชอบเอง)`;
      }
      const ok = window.confirm(prompt);
      if (!ok) return false;
    }
    try {
      await window.apiCall(`/api/bills/${bill.dbBillId}/pay`, {
        method: 'POST',
        body: JSON.stringify({
          method: 'transfer',
          amount: Number(bill.total) || 0,
          ref: `admin-billing:${bill.id}`,
        }),
      });
      addActivity && addActivity({ icon: '💳', text: `รับชำระบิล ${bill.dbBillNo || bill.dbBillId} จำนวน ${fmtCurrency(bill.total)}`, type: 'payment' });
      setToast && setToast({ kind: 'success', message: `บันทึกชำระห้อง ${bill.roomId} แล้ว` });
      if (opts.refresh !== false) fetchDbBills();
      return true;
    } catch (err) {
      window.toastError ? window.toastError(setToast, err, { action: 'บันทึกชำระ' })
        : setToast && setToast({ kind: 'error', message: err.message || 'บันทึกชำระไม่สำเร็จ' });
      return false;
    }
  };

  const handleUnmarkPaid = (id) => {
    const bill = bills.find(b => b.id === id);
    if (!bill) return;
    setToast && setToast({ kind: 'info', message: 'การยกเลิกชำระต้องทำผ่านการ void/reconcile เพื่อเก็บ audit trail' });
  };

  // Actual send — called after the confirm modal accepts. Splits into
  // two paths: db-backed bills go through the server's readiness-aware
  // /:id/send; client-estimate "bills" that aren't persisted yet use the
  // legacy /api/notify/bill (no readiness path because there's no row).
  const doSendReminder = async (id) => {
    const b = bills.find((x) => x.id === id);
    if (!b) return;
    setSendingNow(true);
    const apiCall = window.apiCall;
    try {
      if (b._source === 'db' && b.dbBillId) {
        await apiCall(`/api/bills/${b.dbBillId}/send`, {
          method: 'POST', body: JSON.stringify({}),
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
      addActivity && addActivity({ icon: '🔔', text: `ส่งเตือนชำระบิล ${id}`, type: 'system' });
      setSendConfirm(null);
    } catch (err) {
      window.toastError(setToast, err, { action: `ส่งเตือนบิล ${id}` });
    } finally { setSendingNow(false); }
  };

  const handleSendReminder = async (id) => {
    const b = bills.find((x) => x.id === id);
    if (!b) return;
    // For client-estimate bills (no DB row yet), there's no readiness
    // endpoint to consult — show a minimal confirm modal explaining
    // this and let admin proceed at their own risk.
    if (b._source !== 'db' || !b.dbBillId) {
      setSendConfirm({
        bill: b, billId: id,
        readiness: {
          summary: { canSend: true, blocked: false, issueCount: 1 },
          tenant: null,
          issues: [{
            sev: 'low', code: 'ESTIMATE_NOT_PERSISTED',
            msg: 'บิลนี้ยังไม่ได้บันทึกลง DB — เป็น estimate จาก rooms blob',
            fix: 'ออกบิลจริงก่อนเพื่อให้ระบบเก็บ tenant_id และ track สถานะส่งได้',
          }],
        },
      });
      return;
    }
    // Server-side readiness check — returns structured issues so the modal
    // can render them as cards instead of cramming everything into a single
    // window.confirm() string. Opens the modal even on ok:true so admin
    // sees what's about to happen + which channels will fire.
    try {
      const r = await fetch(`/api/bills/${b.dbBillId}/send-readiness`, { credentials: 'same-origin' });
      const d = await r.json();
      if (!r.ok) {
        setToast && setToast({ kind: 'error', message: d.error || 'ตรวจสอบความพร้อมไม่สำเร็จ' });
        return;
      }
      setSendConfirm({ bill: b, billId: id, readiness: d });
    } catch (err) {
      window.toastError ? window.toastError(setToast, err, { action: 'ตรวจสอบความพร้อมส่ง' })
        : setToast && setToast({ kind: 'error', message: err.message || 'network error' });
    }
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
          msg: i.msg,
          fix: i.fix || '',
        }));
    } else {
      issues = [];
      const tenantsWithBills = Object.values(rooms || {}).filter(
        (r) => r && r.tenant && (r.status === 'occupied' || r.status === 'overdue')
      );
      const ppTarget = config?.payment?.promptpay || config?.payment?.promptpayTarget;
      if (!ppTarget) {
        issues.push({
          sev: 'high',
          msg: 'ยังไม่ได้ตั้ง PromptPay — บิล PDF จะไม่มี QR (ผู้เช่าจะ scan-to-pay ไม่ได้)',
          fix: 'ตั้งที่ /admin#secrets → กลุ่ม PromptPay หรือ Settings → การชำระเงิน',
        });
      }
      const wRate = Number(config?.utilities?.waterRate);
      const eRate = Number(config?.utilities?.elecRate);
      if (!Number.isFinite(wRate) || wRate <= 0) {
        issues.push({ sev: 'high', msg: 'ค่าน้ำต่อหน่วยไม่ได้ตั้ง — บิลจะ ฿0 ในส่วนค่าน้ำ', fix: '/admin#pricing → ค่าน้ำ-ไฟ' });
      }
      if (!Number.isFinite(eRate) || eRate <= 0) {
        issues.push({ sev: 'high', msg: 'ค่าไฟต่อหน่วยไม่ได้ตั้ง — บิลจะ ฿0 ในส่วนค่าไฟ', fix: '/admin#pricing → ค่าน้ำ-ไฟ' });
      }
      const noMeter = tenantsWithBills.filter((r) =>
        (Number(r.waterUnits) || 0) === 0 && (Number(r.elecUnits) || 0) === 0
      ).length;
      if (noMeter > 0) {
        issues.push({
          sev: 'med',
          msg: `${noMeter} ห้องยังไม่บันทึกค่าน้ำ/ไฟ — บิลจะออกแต่ยอดน้ำ/ไฟเป็น 0`,
          fix: '/admin#meters → บันทึกค่ามิเตอร์ก่อนออกบิล',
        });
      }
      if (tenantsWithBills.length === 0) {
        issues.push({
          sev: 'high',
          msg: 'ยังไม่มีห้องที่มีผู้เช่าแสดงสถานะ "occupied" — จะออกบิล 0 ใบ',
          fix: '/admin#rooms → กำหนดผู้เช่าให้ห้องก่อน',
        });
      }
      if (!config?.building?.name || config.building.name === 'บ้านกาญจน์ เรสซิเดนซ์') {
        issues.push({
          sev: 'low',
          msg: 'ชื่อตึกยังเป็น default — บิล PDF จะแสดง "บ้านกาญจน์ เรสซิเดนซ์"',
          fix: '/admin#settings → ข้อมูลตึก',
        });
      }
    }

    if (issues.length > 0) {
      const high = issues.filter((i) => i.sev === 'high').length;
      const lines = issues.map((i, idx) => {
        const icon = i.sev === 'high' ? '🔴' : i.sev === 'med' ? '🟡' : '⚪';
        const fix = i.fix ? `\n   → ${i.fix}` : '';
        return `${idx + 1}. ${icon} ${i.msg}${fix}`;
      }).join('\n\n');
      const ok = window.confirm(
        `⚠️ พบ ${issues.length} ปัญหา${high > 0 ? ` (${high} ข้อสำคัญ)` : ''} ก่อนออกบิล:\n\n` +
        lines +
        `\n\n📌 ออกบิลเดี๋ยวนี้ทั้งที่ปัญหาข้างบนยังไม่แก้?\n` +
        (high > 0 ? `   ⚠ บิลที่ออกอาจมี QR หาย / ยอดน้ำ-ไฟ ผิด — ผู้เช่าจ่ายไม่ได้ / ทักท้วงสูง\n` : '') +
        `\n   • กดยกเลิก → แก้ปัญหาก่อนแล้วค่อยมาออกบิล (แนะนำ)\n` +
        `   • กดตกลง → ออกบิลตามค่าปัจจุบัน (รับผิดชอบเอง)`
      );
      if (!ok) return;
    }

    setConfirmGenerate(false);
    const apiCall = window.apiCall;
    try {
      const now = new Date();
      const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const dueDay = Number(config.notify?.dueOnDay) || 7;
      // Pass `force` when there were issues but admin confirmed the warning.
      // The server has its own copy of the same checks (defence-in-depth)
      // and will 412 unless we explicitly opt in. issues.length > 0 here
      // means the client-side confirm modal showed warnings AND admin
      // clicked OK — that's the signal to set force.
      const d = await apiCall('/api/bills/bulk-generate', {
        method: 'POST',
        body: JSON.stringify({ period, dueDay, force: issues.length > 0 }),
      });
      addActivity && addActivity({ icon: '📋', text: `ออกบิลรอบ ${period}: ${d.made} ใบ (ข้าม ${d.skipped})`, type: 'billing' });
      setToast && setToast({
        kind: d.made > 0 ? 'success' : 'info',
        message: d.made > 0
          ? `ออกบิล ${d.made} ใบสำเร็จ${d.skipped ? ` (ข้าม ${d.skipped} ใบที่มีอยู่แล้ว)` : ''}`
          : `ทุกห้องมีบิลรอบ ${period} อยู่แล้ว — ไม่ได้สร้างเพิ่ม`,
      });
      // Refresh the DB-bills overlay so the banner + per-row badge flip
      // from "ประมาณการ" to "ออกแล้ว" without needing a manual reload.
      fetchDbBills();
    } catch (e) {
      window.toastError(setToast, e, { action: 'ออกบิล' });
    }
  };

  // Bulk-send all pending/overdue bills. Opens a Modal showing the
  // server-computed breakdown (X พร้อม / Y มีปัญหา + reasons) before
  // firing. Replaces the old window.confirm() blob with a richer preview
  // the admin can actually read.
  const handleBulkSend = async () => {
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
    setBulkSendingNow(true);
    const apiCall = window.apiCall;
    try {
      const d = await apiCall('/api/bills/bulk-send', { method: 'POST' });
      setToast && setToast({
        kind: d.enqueued > 0 ? 'success' : 'info',
        message: d.enqueued > 0
          ? `จัดคิวแจ้งเตือน ${d.enqueued}/${d.attempted} ใบ${d.failed ? ` — พลาด ${d.failed} ใบ (ดูใน "คิวแจ้งเตือน")` : ''}`
          : `ไม่มีบิลค้างที่ต้องแจ้งเตือน`,
      });
      addActivity && addActivity({ icon: '🔔', text: `ส่งเตือนทุกบิลค้าง: ${d.enqueued} ใบ`, type: 'system' });
      setBulkSendPreview(null);
      fetchBatchReadiness();   // status icons refresh
    } catch (e) {
      window.toastError(setToast, e, { action: 'ส่งแจ้งเตือนทุกบิล' });
    } finally {
      setBulkSendingNow(false);
    }
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
          style={{ cursor: 'pointer', accentColor: C.accent }}
        />
      ),
    },
    {
      key: 'id', label: 'เลขที่', minWidth: 170,
      render: b => <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>{b.id}</span>,
    },
    {
      key: 'roomId', label: 'ห้อง', minWidth: 70,
      render: b => <span style={{ fontWeight: 600, fontFamily: 'Sora, sans-serif' }}>{b.roomId}</span>,
    },
    {
      key: 'tenant', label: 'ผู้เช่า', minWidth: 180,
      render: b => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Avatar name={b.tenant} size={28} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, color: C.ink, fontWeight: 500 }}>{b.tenant}</div>
            <div style={{ fontSize: 11, color: C.muted }}>{b.phone}</div>
          </div>
        </div>
      ),
    },
    { key: 'period', label: 'งวด', minWidth: 100, render: b => <span style={{ fontSize: 12.5 }}>{b.periodDisplay || b.period}</span> },
    {
      key: 'total', label: 'รวม', align: 'right', minWidth: 120,
      render: b => (
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: C.ink, fontFamily: 'Sora, sans-serif' }}>
            {fmtCurrency(b.total)}
          </div>
          {b.penalty > 0 && (
            <div style={{ fontSize: 11, color: C.danger }}>+ ปรับ {fmtCurrency(b.penalty)}</div>
          )}
        </div>
      ),
    },
    {
      key: 'status', label: 'สถานะ', minWidth: 140,
      render: b => (
        <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
          {b.status === 'paid'
            ? <Pill color="success" size="sm" icon="✓">ชำระแล้ว</Pill>
            : <Pill color="danger" size="sm">ค้าง {b.overdueDays} วัน</Pill>}
          <span title={b._source === 'db' ? `บิล #${b.dbBillNo || b.dbBillId}` : 'ยังไม่ได้บันทึกเข้าระบบ'}
                style={{
                  fontSize: 10, padding: '1px 6px', borderRadius: 4,
                  background: b._source === 'db' ? (C.successSoft || '#e3f3e8') : (C.warningSoft || '#fef6e0'),
                  color: b._source === 'db' ? (C.successInk || '#1d4a2c') : (C.warningInk || '#7a5a18'),
                  fontWeight: 600, letterSpacing: '0.02em',
                }}>
            {b._source === 'db' ? 'ออกแล้ว' : 'ประมาณการ'}
          </span>
        </div>
      ),
    },
    {
      // Slip status — at a glance shows whether a tenant has submitted a
      // slip, whether it was auto-verified or admin-approved, and whether
      // there's still one waiting for review. Clicking the badge jumps to
      // /admin#payments pre-filtered to this bill so admin can act
      // immediately without scanning the queue.
      key: 'slipStatus', label: 'การชำระ', align: 'center', minWidth: 130,
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
                fontWeight: 600,
              }}
            >
              {isAuto ? `🤖 ${providerLabel || 'ออโต้'}` : `👤 ${paidBy}`}
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
                background: '#fff4d4', color: '#7a5a18', fontWeight: 600,
              }}
            >
              📥 รอตรวจ {pend} ใบ
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
                background: '#ffe6e2', color: '#7a2920', fontWeight: 600,
              }}
            >
              ⚠️ สลิปถูกปฏิเสธ {rej}
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
      key: 'sendStatus', label: 'พร้อมส่ง', align: 'center', minWidth: 90,
      render: b => {
        if (b._source !== 'db' || !b.dbBillId) {
          return <span style={{ fontSize: 11, color: C.muted }}>—</span>;
        }
        if (b.status !== 'unpaid' && b.status !== 'overdue') {
          return <span style={{ fontSize: 11, color: C.muted }}>{b.status === 'paid' ? 'ชำระแล้ว' : '—'}</span>;
        }
        const r = batchReadiness && batchReadiness.bills && batchReadiness.bills[b.dbBillId];
        if (!r) return <span style={{ fontSize: 11, color: C.muted }}>…</span>;
        if (r.canSend && r.warnCode === 'EMAIL_ONLY') {
          return (
            <span title="ไม่ผูก LINE — จะส่งทางอีเมล (อาจไปกล่อง spam)"
                  style={{ fontSize: 13, color: '#c08a2a' }}>📧 อีเมล</span>
          );
        }
        if (r.canSend) {
          return (
            <span title="LINE + (อีเมลถ้ามี) พร้อม — กดส่งได้เลย"
                  style={{ fontSize: 13, color: '#1f5f3a' }}>✅ พร้อม</span>
          );
        }
        return (
          <span title={r.blockMsg || r.blockCode || 'block'}
                style={{ fontSize: 12, color: '#b94a48', fontWeight: 600 }}>
            🚫 {r.blockCode === 'NO_TENANT_CHANNEL' ? 'ไม่มี channel'
              : r.blockCode === 'TENANT_MOVED_ROOM' ? 'ย้ายห้อง'
              : r.blockCode === 'TENANT_NOT_ACTIVE' ? 'ออกแล้ว'
              : r.blockCode === 'TENANT_DELETED' ? 'ลบแล้ว'
              : r.blockCode === 'BILL_NOT_LINKED' ? 'ไม่ผูก'
              : 'block'}
          </span>
        );
      },
    },
    {
      key: 'actions', label: '', align: 'right', minWidth: 130,
      render: b => (
        <div style={{ display: 'inline-flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
          <IconBtn icon="👁" label="ดูบิล" onClick={() => setPreviewBill(b)} />
          {b.status === 'unpaid' && b._source === 'db' && (
            <>
              <IconBtn icon="🔔" label="ส่งเตือน" onClick={() => handleSendReminder(b.id)} />
              <IconBtn icon="✓" label="บันทึกชำระ" onClick={() => handleMarkPaid(b.id)} />
            </>
          )}
          {b.status === 'paid' && b._source === 'db' && (
            <IconBtn icon="↺" label="ยกเลิกการชำระ" onClick={() => handleUnmarkPaid(b.id)} />
          )}
        </div>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        title="บิลและการเงิน"
        subtitle={`เดือน ${fmtMonthTH(currentPeriodDate)} · ${bills.length} ใบ`}
        actions={
          <>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '4px 6px', border: `1px solid ${C.border}`,
              borderRadius: 8, background: C.bg, color: C.ink,
            }}>
              <button
                type="button"
                aria-label="เดือนก่อนหน้า"
                onClick={() => setPeriodOffset((x) => x - 1)}
                style={{ border: 0, background: 'transparent', color: C.ink, cursor: 'pointer', fontSize: 16 }}
              >‹</button>
              <span style={{ minWidth: 76, textAlign: 'center', fontSize: 12.5, fontWeight: 600 }}>{currentPeriod}</span>
              <button
                type="button"
                aria-label="เดือนถัดไป"
                disabled={periodOffset >= 0}
                onClick={() => setPeriodOffset((x) => Math.min(x + 1, 0))}
                style={{
                  border: 0, background: 'transparent',
                  color: periodOffset >= 0 ? C.muted : C.ink,
                  cursor: periodOffset >= 0 ? 'not-allowed' : 'pointer',
                  fontSize: 16,
                }}
              >›</button>
              {periodOffset !== 0 ? (
                <button
                  type="button"
                  onClick={() => setPeriodOffset(0)}
                  style={{ border: 0, background: 'transparent', color: C.accent || C.ink, cursor: 'pointer', fontSize: 12 }}
                >เดือนนี้</button>
              ) : null}
            </div>
            <Btn variant="secondary" icon="📤" onClick={() => {
              if (window.exportBillsCSV(bills)) {
                addActivity && addActivity({ icon: '📤', text: `ส่งออกบิลเดือนนี้ ${bills.length} ใบ เป็น CSV`, type: 'system' });
                setToast && setToast({ kind: 'success', message: `ดาวน์โหลด CSV ${bills.length} ใบเรียบร้อย` });
              }
            }}>ส่งออก CSV</Btn>
            <Btn variant="primary" icon="📋" onClick={() => setConfirmGenerate(true)}>
              ออกบิลรายเดือน
            </Btn>
            <Btn icon="🔔" onClick={handleBulkSend}>
              ส่งเตือนทั้งหมด
            </Btn>
          </>
        }
      />

      {/* Real-vs-estimate banner. Tells admin at a glance whether what
          they're seeing came from issued bills (DB) or is just a forecast
          built from rooms × rate. Without this, the previous version
          showed a perfect-looking estimate even when 0 bills had been
          issued for the period — false reassurance. */}
      {dbBills != null && (() => {
        const dbCount = dbBills.length;
        const estCount = bills.filter((b) => b._source === 'estimate').length;
        if (dbCount === 0 && estCount > 0) {
          return (
            <div style={{
              padding: '10px 14px', marginBottom: 14, borderRadius: 8,
              background: C.warningSoft || '#fef6e0', color: C.warningInk || '#7a5a18',
              fontSize: 13, display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{ fontSize: 16 }}>⚠️</span>
              <span><strong>ยังไม่ได้ออกบิลรอบ {currentPeriod}</strong> — ตารางด้านล่างเป็นการประมาณการจากข้อมูลห้อง กดปุ่ม "ออกบิลเดือนนี้" เพื่อบันทึกเข้า DB</span>
            </div>
          );
        }
        if (dbCount > 0 && estCount > 0) {
          return (
            <div style={{
              padding: '10px 14px', marginBottom: 14, borderRadius: 8,
              background: C.infoSoft || '#e3eef7', color: C.infoInk || '#1d3b5a',
              fontSize: 13, display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{ fontSize: 16 }}>ℹ️</span>
              <span>ออกบิลแล้ว {dbCount} ใบ (รอบ {currentPeriod}) · เหลือห้องที่ยังไม่ออก {estCount} ห้อง — กด "ออกบิลเดือนนี้" เพื่อออกบิลส่วนที่เหลือ</span>
            </div>
          );
        }
        if (dbCount > 0 && estCount === 0) {
          return (
            <div style={{
              padding: '10px 14px', marginBottom: 14, borderRadius: 8,
              background: C.successSoft || '#e3f3e8', color: C.successInk || '#1d4a2c',
              fontSize: 13, display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{ fontSize: 16 }}>✓</span>
              <span>ออกบิลครบทุกห้องแล้วสำหรับรอบ {currentPeriod} ({dbCount} ใบ)</span>
            </div>
          );
        }
        return null;
      })()}
      {dbBillsErr && (
        <div style={{
          padding: '10px 14px', marginBottom: 14, borderRadius: 8,
          background: C.dangerSoft || '#fff1f0', color: C.danger || '#a23',
          fontSize: 13,
        }}>
          โหลดข้อมูลบิลจาก DB ไม่สำเร็จ: {dbBillsErr} — แสดงประมาณการจากข้อมูลห้อง
          {' '}<button onClick={fetchDbBills} style={{
            border: 0, background: 'transparent', color: 'inherit',
            textDecoration: 'underline', cursor: 'pointer', fontFamily: 'inherit',
          }}>ลองใหม่</button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 20 }}>
        <KpiCard label="บิลที่ออก"     value={fmt(stats.issued)}     sub="ใบประจำเดือน" icon="📋" />
        <KpiCard label="ชำระแล้ว"       value={fmt(stats.paidCount)} sub={fmtCurrency(stats.totalRevenue)} color="success" icon="✓" />
        <KpiCard label="ค้างชำระ"        value={fmt(stats.unpaidCount)} sub={fmtCurrency(stats.overdueAmt)} color="danger" icon="⚠️" />
        <KpiCard label="อัตราการชำระ" value={stats.issued ? Math.round(stats.paidCount/stats.issued*100) + '%' : '-'} color="info" icon="📊" />
      </div>

      <Tabs
        items={[
          { value: 'current', label: 'เดือนนี้',         count: bills.length },
          { value: 'unpaid',  label: 'ค้างชำระ',        count: stats.unpaidCount },
          { value: 'review',  label: '📥 รอตรวจสลิป', count: pendingReviewCount },
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
            เลือกแล้ว {selected.size} รายการ
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <Btn variant="soft" size="sm" icon="🔔" onClick={async () => {
              const ids = [...selected];
              const targets = bills.filter((b) => ids.includes(b.id));
              const apiFetch = window.apiFetch || ((u, o) => fetch(u, { credentials: 'same-origin', ...o }));
              let okCount = 0, failCount = 0, skip = false;
              for (const b of targets) {
                try {
                  const r = (b._source === 'db' && b.dbBillId)
                    ? await apiFetch(`/api/bills/${b.dbBillId}/send`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({}),
                      })
                    : await apiFetch('/api/notify/bill', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          billNo: b.id, roomId: b.roomId, tenantName: b.tenant,
                          period: b.period, total: b.total,
                        }),
                      });
                  if (r.status === 503) { skip = true; break; }
                  if (r.ok) {
                    okCount++;
                    addActivity && addActivity({ icon: '🔔', text: `ส่งเตือนชำระบิล ${b.id}`, type: 'system' });
                  } else failCount++;
                } catch { failCount++; }
              }
              if (skip) {
                setToast && setToast({ kind: 'error', message: 'ระบบยังไม่ได้ตั้งค่า LINE — ตั้งค่าก่อนใช้บัลก์' });
              } else if (failCount === 0) {
                setToast && setToast({ kind: 'success', message: `ส่งเตือน ${okCount} รายการเรียบร้อย` });
              } else {
                setToast && setToast({ kind: 'info', message: `สำเร็จ ${okCount} · ล้มเหลว ${failCount}` });
              }
              setSelected(new Set());
            }}>ส่งเตือนทั้งหมด</Btn>
            <Btn variant="soft" size="sm" icon="📥" onClick={() => {
              const selectedBills = bills.filter(b => selected.has(b.id));
              if (window.exportBillsCSV(selectedBills)) {
                setToast && setToast({ kind: 'success', message: `ดาวน์โหลด ${selectedBills.length} บิลเรียบร้อย` });
              }
            }}>ดาวน์โหลด CSV</Btn>
            <Btn variant="soft" size="sm" icon="✓" onClick={async () => {
              const ids = [...selected];
              for (const id of ids) {
                const bill = bills.find(b => b.id === id);
                if (bill && bill.status === 'unpaid' && bill._source === 'db') {
                  await handleMarkPaid(id, { confirm: false, refresh: false });
                }
              }
              fetchDbBills();
              setSelected(new Set());
            }}>บันทึกชำระทั้งหมด</Btn>
            <Btn variant="ghost" size="sm" onClick={() => setSelected(new Set())} style={{ color: '#fff' }}>ยกเลิกเลือก</Btn>
          </div>
        </Card>
      )}

      <DataTable
        columns={columns}
        rows={filtered}
        onRowClick={(b) => setPreviewBill(b)}
        empty={<EmptyState icon="🧾" title="ยังไม่มีบิล" />}
      />

      <Modal
        open={confirmGenerate}
        onClose={() => setConfirmGenerate(false)}
        title="ออกบิลประจำเดือน"
        footer={
          <>
            <Btn variant="ghost" onClick={() => setConfirmGenerate(false)}>ยกเลิก</Btn>
            <Btn variant="primary" onClick={handleGenerate}>ออกบิล {bills.length} ใบ</Btn>
          </>
        }
      >
        <div style={{ fontSize: 14, color: C.ink2, lineHeight: 1.6, marginBottom: 12 }}>
          ระบบจะออกบิลสำหรับห้องที่มีผู้เช่าทั้งหมด <b style={{ color: C.ink }}>{bills.length} ห้อง</b>
        </div>
        <div style={{
          padding: 12, background: C.surfaceAlt, borderRadius: 8,
          fontSize: 12.5, color: C.ink2,
        }}>
          <div>📅 ครบกำหนดชำระ: <b>วันที่ {config.notify?.dueOnDay ?? 7} ของเดือน</b></div>
          <div>💰 ยอดรวมโดยประมาณ: <b>{fmtCurrency(bills.reduce((s,b) => s+b.total, 0))}</b></div>
          <div>📨 ส่งทาง: LINE, Email</div>
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
              <Btn variant="secondary" icon="💳" onClick={() => {
                window.location.hash = `#payments?billId=${encodeURIComponent(previewBill.dbBillId)}`;
                setPreviewBill(null);
              }}>ดูสลิปของบิลนี้</Btn>
            ) : null}
            <Btn variant="secondary" icon="📥" onClick={async () => {
              const b = previewBill;
              // Build the bill payload matching services/pdf.js renderBillPdf shape.
              const items = [
                { label: 'ค่าเช่าห้อง', amount: b.rent || 0 },
                { label: 'ค่าน้ำประปา', qty: `${b.waterUnits || 0} หน่วย`, amount: b.water || 0 },
                { label: 'ค่าไฟฟ้า', qty: `${b.elecUnits || 0} หน่วย`, amount: b.elec || 0 },
                { label: 'ค่า Wi-Fi', amount: b.wifi || 0 },
              ];
              // Maintenance / repair charges from completed tickets.
              if (Array.isArray(b.charges)) {
                b.charges.forEach((c) => items.push({ label: c.label, amount: Number(c.amount) || 0 }));
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
                building: (config && config.building) || { name: 'บ้านกาญจน์ เรสซิเดนซ์' },
              };
              const apiFetch = window.apiFetch || ((u, o) => fetch(u, { credentials: 'same-origin', ...o }));
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
                addActivity && addActivity({ icon: '📥', text: `ดาวน์โหลดบิล ${b.id} (PDF)`, type: 'billing' });
              } catch (err) {
                console.error('PDF download failed:', err);
                setToast && setToast({ kind: 'error', message: 'ดาวน์โหลดบิลไม่สำเร็จ' });
              }
            }}>ดาวน์โหลด PDF</Btn>
            <Btn variant="primary" icon="📨" onClick={async () => {
              const b = previewBill;
              const apiFetch = window.apiFetch || ((u, o) => fetch(u, { credentials: 'same-origin', ...o }));
              try {
                const res = (b._source === 'db' && b.dbBillId)
                  ? await apiFetch(`/api/bills/${b.dbBillId}/send`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({}),
                    })
                  : await apiFetch('/api/notify/bill', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        billNo: b.id,
                        roomId: b.roomId,
                        tenantName: b.tenant,
                        period: b.period,
                        total: b.total,
                      }),
                    });
                const data = await res.json().catch(() => ({}));
                if (res.status === 503) {
                  setToast && setToast({ kind: 'error', message: 'ระบบยังไม่ได้ตั้งค่า LINE' });
                  return;
                }
                if (!res.ok || !data.ok) {
                  setToast && setToast({ kind: 'error', message: data.error || 'ส่งแจ้งเตือนไม่สำเร็จ' });
                  return;
                }
                setToast && setToast({ kind: 'success', message: `ส่งบิล ${b.id} ทาง LINE แล้ว` });
                addActivity && addActivity({ icon: '📨', text: `ส่งบิล ${b.id} ให้ ${b.tenant}`, type: 'billing' });
                setPreviewBill(null);
              } catch (err) {
                console.error('notify bill failed:', err);
                setToast && setToast({ kind: 'error', message: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' });
              }
            }}>ส่งให้ผู้เช่า</Btn>
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
        title={sendConfirm ? `ส่งเตือนบิล ${sendConfirm.bill.dbBillNo || sendConfirm.billId}` : ''}
        width={520}
        footer={sendConfirm && (
          <>
            <Btn variant="ghost" onClick={() => setSendConfirm(null)} disabled={sendingNow}>
              ยกเลิก
            </Btn>
            {sendConfirm.readiness?.summary?.canSend ? (
              <Btn variant="primary" icon="🔔"
                onClick={() => doSendReminder(sendConfirm.billId)}
                disabled={sendingNow}>
                {sendingNow ? 'กำลังส่ง…' : 'ยืนยันส่ง'}
              </Btn>
            ) : (
              <Btn variant="primary"
                onClick={() => setSendConfirm(null)}
                style={{ background: C.muted }}>
                เข้าใจแล้ว
              </Btn>
            )}
          </>
        )}
      >
        {sendConfirm && <SendReminderConfirmBody confirm={sendConfirm} C={C} fmtCurrency={fmtCurrency} />}
      </Modal>

      {/* Bulk-send preflight — replaces the wall-of-text window.confirm()
          with a Modal showing the server's per-issue breakdown so admin
          knows exactly how many bills will succeed vs fail before firing
          the bulk-send pipeline. */}
      <Modal
        open={!!bulkSendPreview}
        onClose={() => !bulkSendingNow && setBulkSendPreview(null)}
        title="🔔 ส่งเตือนทุกบิลที่ค้าง"
        width={560}
        footer={bulkSendPreview && (() => {
          const ready = bulkSendPreview.readiness?.summary?.canSend ?? bulkSendPreview.pending.length;
          return (
            <>
              <Btn variant="ghost" onClick={() => setBulkSendPreview(null)} disabled={bulkSendingNow}>
                ยกเลิก
              </Btn>
              <Btn variant="primary" icon="🔔"
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
    </PageContainer>
  );
}

// BulkSendPreviewBody — renders the breakdown of which bills will/won't
// send, grouped by block code, so the admin sees the picture before
// firing the pipeline.
function BulkSendPreviewBody({ preview, C, fmtCurrency }) {
  const { pending, totalAmount, readiness } = preview;
  const summary = readiness?.summary || {
    total: pending.length, canSend: pending.length, blocked: 0, issueCounts: {},
  };
  const blockCodeLabel = {
    BILL_NOT_LINKED: 'บิลไม่ผูกผู้เช่า',
    TENANT_DELETED: 'ผู้เช่าถูกลบ',
    TENANT_NOT_ACTIVE: 'ผู้เช่าออกแล้ว (moved_out)',
    TENANT_MOVED_ROOM: 'ผู้เช่าย้ายห้อง',
    NO_TENANT_CHANNEL: 'ไม่ผูก LINE + ไม่มีอีเมล',
  };
  const codes = Object.entries(summary.issueCounts || {}).sort((a, b) => b[1] - a[1]);
  const fmt = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Headline summary */}
      <div style={{
        padding: 14, borderRadius: 10,
        background: summary.blocked === 0 ? '#f0f9f0' : (summary.canSend === 0 ? '#fff5f4' : '#fff7e0'),
        border: `1px solid ${summary.blocked === 0 ? '#bce0bc' : (summary.canSend === 0 ? '#f5c0b4' : '#f0e3a7')}`,
      }}>
        <div style={{ fontFamily: 'Sora', fontWeight: 600, fontSize: 14.5 }}>
          {summary.blocked === 0 ? '✅ ทุกบิลพร้อมส่ง'
            : summary.canSend === 0 ? '🚫 ส่งไม่ได้สักใบ'
            : `⚠️ ส่งได้ ${summary.canSend} ใบ — ติดปัญหา ${summary.blocked} ใบ`}
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
                background: '#fff5f4',
                borderLeft: '3px solid #b94a48',
                fontSize: 13,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <strong style={{ color: '#7a2920' }}>
                    🔴 {blockCodeLabel[code] || code}
                  </strong>
                  <span style={{ color: '#7a2920', fontWeight: 600 }}>{count} ใบ</span>
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 8, lineHeight: 1.5 }}>
            💡 แก้ปัญหารายห้องที่ /admin#tenants ก่อน แล้วกลับมากดส่งใหม่
          </div>
        </div>
      ) : null}

      {/* Footnote */}
      <div style={{
        padding: 10, borderRadius: 6, background: '#fdfaf2',
        border: `1px solid ${C.borderSoft || C.border}`,
        fontSize: 12, color: C.muted, lineHeight: 1.6,
      }}>
        📌 ระบบจะ enqueue ในคิว — ส่งจริงภายใน ~1 นาที<br/>
        📌 ดูคิวที่ /admin#notifications-queue<br/>
        📌 กดบ่อย = ผู้เช่าได้ข้อความซ้ำ (LINE rate-limit = 1000/วัน)
      </div>
    </div>
  );
}

// SendReminderConfirmBody — the modal contents. Renders bill summary,
// recipient info, channel availability, and a card per readiness issue.
// Pure component (no hooks beyond what the parent provides) so it can be
// reasoned about independently.
function SendReminderConfirmBody({ confirm, C, fmtCurrency }) {
  const { bill, readiness } = confirm;
  const r = readiness || {};
  const summary = r.summary || {};
  const t = r.tenant;
  const channels = summary.channels || {};
  const blocked = summary.blocked === true;
  const issues = Array.isArray(r.issues) ? r.issues : [];

  const sevPalette = {
    high: { bg: '#fff5f4', border: '#f5c0b4', accent: '#b94a48', icon: '🔴' },
    med:  { bg: '#fff7e0', border: '#f0e3a7', accent: '#8a6b1a', icon: '🟡' },
    low:  { bg: '#f4f8fc', border: '#cfdde9', accent: '#3a5a78', icon: '⚪' },
    info: { bg: '#f4f8fc', border: '#cfdde9', accent: '#3a5a78', icon: 'ℹ️' },
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Top banner — ready / blocked summary */}
      <div style={{
        padding: 12, borderRadius: 8,
        background: blocked ? '#fff5f4' : (issues.length > 0 ? '#fff7e0' : '#f0f9f0'),
        border: `1px solid ${blocked ? '#f5c0b4' : (issues.length > 0 ? '#f0e3a7' : '#bce0bc')}`,
      }}>
        <div style={{ fontFamily: 'Sora', fontWeight: 600, fontSize: 14.5 }}>
          {blocked
            ? `🚫 ส่งไม่ได้ — พบ ${summary.highCount || issues.length} ปัญหาสำคัญ`
            : issues.length > 0
              ? `⚠️ ส่งได้ — แต่มี ${issues.length} ข้อควรทราบ`
              : `✅ พร้อมส่ง`}
        </div>
        <div style={{ fontSize: 12.5, color: C.muted, marginTop: 4, lineHeight: 1.5 }}>
          {blocked
            ? 'แก้ปัญหาด้านล่างให้ครบก่อนถึงจะส่งได้'
            : issues.length > 0
              ? 'ตรวจประเด็นด้านล่าง — กดยืนยันส่งถ้า OK กับ tradeoff'
              : 'ผู้เช่ามีช่องทางรับ + บิลพร้อม — กดยืนยันได้เลย'}
        </div>
      </div>

      {/* Bill summary card */}
      <div style={{
        padding: 12, borderRadius: 8, background: C.surfaceAlt || C.bg,
        border: `1px solid ${C.borderSoft || C.border}`,
      }}>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>บิลที่จะส่ง</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: 'Sora', fontWeight: 600 }}>
              ห้อง {bill.roomId} · รอบ {bill.period || '-'}
            </div>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 2 }}>
              เลขที่ {bill.dbBillNo || bill.id} · กำหนด {bill.dueDate || '-'}
            </div>
          </div>
          <div style={{ fontFamily: 'Sora', fontWeight: 700, fontSize: 18 }}>
            ฿{fmtCurrency(bill.total)}
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
          <div style={{ fontFamily: 'Sora', fontWeight: 600 }}>{t.name || '-'}</div>
          <div style={{ fontSize: 12.5, color: C.muted, marginTop: 2 }}>
            {t.phone || '-'}{t.email ? ` · ${t.email}` : ''}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 11.5, padding: '3px 9px', borderRadius: 999,
              background: channels.line ? '#e6f4ec' : '#fbeae7',
              color: channels.line ? '#1f5f3a' : '#7a2920',
            }}>
              {channels.line ? '✓ LINE' : '✗ ไม่มี LINE'}
            </span>
            <span style={{
              fontSize: 11.5, padding: '3px 9px', borderRadius: 999,
              background: channels.email ? '#e6f4ec' : '#fbeae7',
              color: channels.email ? '#1f5f3a' : '#7a2920',
            }}>
              {channels.email ? '✓ Email' : '✗ ไม่มี Email'}
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
                  {p.icon} {it.msg}
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

  const rows = [
    { label: 'ค่าเช่ารายเดือน', value: b.rent },
    { label: `ค่าน้ำ (${b.waterUnits} หน่วย)`, value: b.water },
    { label: `ค่าไฟ (${b.elecUnits} หน่วย)`, value: b.elec },
    { label: 'ค่า Wi-Fi', value: b.wifi },
  ];
  if (b.penalty > 0) rows.push({ label: `ค่าปรับชำระล่าช้า (${b.overdueDays} วัน)`, value: b.penalty, danger: true });

  return (
    <div>
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
        {b.status === 'paid' ? <Pill color="success">ชำระแล้ว</Pill> : <Pill color="danger">ค้างชำระ</Pill>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px dashed ${C.borderSoft}` }}>
            <span style={{ fontSize: 13, color: r.danger ? C.danger : C.ink2 }}>{r.label}</span>
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
          <div style={{ fontSize: 11, color: '#8a7d6b', marginTop: 2 }}>ครบกำหนด {b.dueDateDisplay || b.dueDate}</div>
        </div>
        <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 24, fontWeight: 700 }}>
          {fmtCurrency(b.total)}
        </div>
      </div>
    </div>
  );
}

window.PageBilling = PageBilling;
