// === admin/page-payments.jsx ===============================================
// Slip verification queue. Lists payments by status (pending / verified /
// rejected). Admin opens a slip image, accepts (marks bill paid) or rejects
// with a reason.
// ===========================================================================

(function () {
const { useState, useEffect, useMemo, useRef } = React;

const PAYMENT_STATUS_LABEL = {
  pending: 'รอตรวจสอบ',
  verified: 'อนุมัติแล้ว',
  rejected: 'ปฏิเสธ',
};

const BILL_STATUS_LABEL = {
  pending: 'รอชำระ',
  overdue: 'ค้างชำระ',
  paid: 'ชำระแล้ว',
  void: 'ยกเลิก',
};

const FILTER_ALL = 'all';
const PAYMENT_STATUS_ORDER = ['pending', 'verified', 'rejected'];
const PAYMENT_PAGE_LIMIT = 500;
const FILTER_ALL_LABEL = '\u0e17\u0e31\u0e49\u0e07\u0e2b\u0e21\u0e14';
const PAYMENT_TOLERANCE_THB = 1;

function paymentToleranceForTotal(total) {
  const n = Math.round((Number(total) || 0) * 100) / 100;
  return Math.abs(Math.round(n * 100) % 100) > 0 ? 0.01 : PAYMENT_TOLERANCE_THB;
}

function moneyDiff(a, b) {
  return Math.round(Math.abs((Number(a) || 0) - (Number(b) || 0)) * 100) / 100;
}

function paymentStatusLabel(status) {
  return PAYMENT_STATUS_LABEL[status] || status || '-';
}

function billStatusLabel(status) {
  return BILL_STATUS_LABEL[status] || status || '-';
}

function paymentFilterLabel(status) {
  return status === FILTER_ALL ? FILTER_ALL_LABEL : paymentStatusLabel(status);
}

function paymentStatusMeta(C, status) {
  if (status === 'verified') {
    return {
      label: PAYMENT_STATUS_LABEL.verified,
      title: 'สลิปผ่านแล้ว',
      help: 'ระบบบันทึกการชำระแล้ว และบิลควรเป็นสถานะชำระแล้ว',
      next: 'ไม่ต้องดำเนินการต่อ เว้นแต่ต้องย้อนรายการ',
      color: C.success,
      soft: C.successSoft,
      ink: C.successInk,
    };
  }
  if (status === 'rejected') {
    return {
      label: PAYMENT_STATUS_LABEL.rejected,
      title: 'สลิปไม่ผ่าน',
      help: 'สลิปถูกปฏิเสธแล้ว ผู้เช่าต้องส่งหลักฐานใหม่หรือแก้ยอดชำระ',
      next: 'ตรวจเหตุผลปฏิเสธก่อนติดต่อผู้เช่า',
      color: C.danger,
      soft: C.dangerSoft,
      ink: C.dangerInk,
    };
  }
  return {
    label: PAYMENT_STATUS_LABEL.pending,
    title: 'ต้องตรวจสลิป',
    help: 'ยังไม่เปลี่ยนบิลเป็นชำระแล้ว ต้องเปิดสลิปเพื่อตรวจยอดก่อน',
    next: 'เปิดรายการ แล้วเลือกอนุมัติหรือปฏิเสธพร้อมเหตุผล',
    color: C.warning,
    soft: C.warningSoft,
    ink: C.warningInk,
  };
}

function billStatusMeta(C, status) {
  const raw = String(status || '').toLowerCase();
  if (raw === 'paid') {
    return {
      label: BILL_STATUS_LABEL.paid,
      help: 'บิลถูกปิดยอดแล้ว',
      color: C.success,
      soft: C.successSoft,
      ink: C.successInk,
    };
  }
  if (raw === 'overdue') {
    return {
      label: BILL_STATUS_LABEL.overdue,
      help: 'เลยกำหนดชำระ ควรเร่งตรวจสลิปหรือทวงชำระ',
      color: C.danger,
      soft: C.dangerSoft,
      ink: C.dangerInk,
    };
  }
  if (raw === 'void') {
    return {
      label: BILL_STATUS_LABEL.void,
      help: 'บิลถูกยกเลิก ไม่ควรรับชำระเพิ่ม',
      color: C.neutral || C.muted,
      soft: C.neutralSoft || C.bgSoft,
      ink: C.neutralInk || C.ink,
    };
  }
  return {
    label: BILL_STATUS_LABEL.pending,
    help: 'บิลยังรอชำระ',
    color: C.warning,
    soft: C.warningSoft,
    ink: C.warningInk,
  };
}

function paymentTimestamp(payment) {
  const ts = Date.parse(payment?.created_at);
  return Number.isFinite(ts) ? ts : 0;
}

function sortPaymentsNewestFirst(payments) {
  return [...(payments || [])].sort((a, b) => {
    const byDate = paymentTimestamp(b) - paymentTimestamp(a);
    if (byDate) return byDate;
    return Number(b?.id || 0) - Number(a?.id || 0);
  });
}

function paymentSearchHaystack(payment) {
  return [
    payment.id,
    payment.bill_id,
    payment.bill_no,
    payment.room_id,
    payment.tenant_name,
    payment.tenant_phone,
    payment.amount,
    payment.status,
    payment.bill_status,
    paymentStatusLabel(payment.status),
    billStatusLabel(payment.bill_status),
    PAYMENT_STATUS_LABEL[payment.status],
    BILL_STATUS_LABEL[payment.bill_status],
  ].map((v) => String(v ?? '').toLowerCase()).join(' ');
}

function fmtMoney(value) {
  return Number(value || 0).toLocaleString('th-TH', { minimumFractionDigits: 2 });
}

function partySummary(party) {
  if (!party) return '-';
  return [
    party.name,
    party.bank,
    party.account ? `บัญชีลงท้าย ${String(party.account).replace(/[^0-9]/g, '').slice(-6) || party.account}` : null,
  ].filter(Boolean).join(' / ') || '-';
}

function formatVerifyAttempt(attempt) {
  if (!attempt) return '-';
  return `${attempt.provider || 'provider'}:${attempt.ok ? 'ผ่าน' : (attempt.code || 'ไม่ผ่าน')}`;
}

function StatusBadge({ meta, prefix }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 9px',
      borderRadius: 999,
      border: `1px solid ${meta.color}`,
      background: meta.soft,
      color: meta.ink,
      fontSize: 12,
      fontWeight: 700,
      whiteSpace: 'nowrap',
    }}>
      <span style={{
        width: 7,
        height: 7,
        borderRadius: 999,
        background: meta.color,
        flex: '0 0 auto',
      }} />
      {prefix ? `${prefix}: ` : ''}{meta.label}
    </span>
  );
}

function StatusInfoPanel({ title, meta, detail }) {
  return (
    <div style={{
      border: `1px solid ${meta.color}`,
      background: meta.soft,
      color: meta.ink,
      borderRadius: 8,
      padding: '10px 12px',
      minWidth: 0,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.85, marginBottom: 4 }}>{title}</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 800 }}>{meta.label}</div>
        <span style={{ width: 9, height: 9, borderRadius: 999, background: meta.color, flex: '0 0 auto' }} />
      </div>
      <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.45 }}>{detail || meta.help}</div>
    </div>
  );
}

// "auto:slipok" / "auto:easyslip" / "auto:slip2go" → friendly Thai label
// so admins reading the page don't see raw enum-ish strings. Anything
// else (an actual username) is returned as-is prefixed with 👤.
const PROVIDER_LABEL = {
  slipok: 'SlipOK',
  easyslip: 'EasySlip',
  slip2go: 'Slip2Go',
};
function prettyVerifiedBy(verifiedBy) {
  if (!verifiedBy) return '-';
  const s = String(verifiedBy);
  if (s.startsWith('auto:')) {
    const id = s.slice(5);
    const label = PROVIDER_LABEL[id] || id;
    return `🤖 ระบบอัตโนมัติ (${label})`;
  }
  return `👤 ${s}`;
}

function PagePayments({ setToast }) {
  // Diagnostic: prove the component actually mounted. Visible in DevTools
  // console — useful when the user reports a "white screen with no error"
  // because we can confirm whether render even reached this far.
  React.useEffect(() => {
    console.log('[PagePayments] mounted');
    return () => console.log('[PagePayments] unmounted');
  }, []);

  // Guard every window global we depend on. If shared.jsx / ui.jsx / hooks.jsx
  // failed to load (CDN hiccup, slow mobile, blocked script), missing globals
  // would throw "Element type is invalid" inside render. Render a friendly
  // stub instead so the user can refresh, mirroring page-meters.jsx.
  const C = window.ADMIN_C;
  const Card = window.Card;
  const Btn = window.Btn;
  const PageContainer = window.PageContainer;
  const PageHeader = window.PageHeader;
  const EmptyState = window.EmptyState;
  if (!C || !Card || !Btn || !PageContainer || !PageHeader || !EmptyState) {
    const missing = [
      !C && 'ADMIN_C', !Card && 'Card', !Btn && 'Btn',
      !PageContainer && 'PageContainer', !PageHeader && 'PageHeader', !EmptyState && 'EmptyState',
    ].filter(Boolean).join(', ');
    console.warn('[PagePayments] missing window globals:', missing);
    return React.createElement('div', {
      style: { padding: 32, fontSize: 14, color: '#5b4f40', fontFamily: 'inherit' },
    }, `กำลังเตรียมหน้าสลิปชำระเงิน... (รอ: ${missing})`);
  }

  const [filter, setFilter] = useState(FILTER_ALL);
  const [search, setSearch] = useState('');
  const [list, setList] = useState([]);
  const [summary, setSummary] = useState(null);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);

  // Track in-flight load() so a rapid filter switch can't pile up overlapping
  // fetches that resolve out of order and overwrite fresh state with stale data.
  const abortRef = useRef(null);

  async function load() {
    if (abortRef.current) abortRef.current.abort();
    const req = makeAbortableRequest(15_000);
    abortRef.current = req;
    setLoading(true);
    setLoadError(null);
    try {
      const statuses = filter === FILTER_ALL ? PAYMENT_STATUS_ORDER : [filter];
      const batches = await Promise.all(statuses.map(async (status) => {
        const url = `/api/payments?status=${encodeURIComponent(status)}&limit=${PAYMENT_PAGE_LIMIT}`;
        const r = await fetch(url, {
          credentials: 'same-origin',
          ...(req.signal ? { signal: req.signal } : {}),
        });
        const d = await r.json().catch(() => ({}));
        return { r, d };
      }));
      const failed = batches.find((batch) => !batch.r.ok);
      if (failed) {
        // 503 means slipUpload feature is OFF on the server. Don't surface
        // as an error — FeatureGate already shows the placeholder if the
        // flag is off; if we're rendering at all the gate believed it on.
        if (failed.r.status !== 503) {
          setLoadError(failed.d.error || `HTTP ${failed.r.status}`);
        }
        setList([]);
        setSummary(null);
      } else {
        const payments = batches.flatMap(({ d }) => Array.isArray(d.payments) ? d.payments : []);
        setList(sortPaymentsNewestFirst(payments));
        const withSummary = batches.find(({ d }) => d.summary);
        setSummary(withSummary?.d?.summary || null);
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setLoadError(err.message || 'network error');
        setList([]);
        setSummary(null);
      }
    } finally {
      req.done();
      if (abortRef.current === req) abortRef.current = null;
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    return () => { if (abortRef.current) abortRef.current.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  // Cross-link consumer: when /admin#billing → "ดูสลิปของบิลนี้" jumps to
  // /admin#payments?billId=42, we auto-switch the status filter to the
  // status of THAT bill's latest slip (or 'pending' as default) and open
  // the modal so the operator lands directly on the right row. The
  // billId match is best-effort — if the page is still loading, we re-try
  // on the next load() completion.
  const [pendingBillIdFromHash, setPendingBillIdFromHash] = useState(null);
  useEffect(() => {
    const readHash = () => {
      const m = String(window.location.hash || '').match(/billId=([^&]+)/);
      if (m) {
        const id = Number(decodeURIComponent(m[1]));
        if (id) setPendingBillIdFromHash(id);
      }
    };
    readHash();
    window.addEventListener('hashchange', readHash);
    return () => window.removeEventListener('hashchange', readHash);
  }, []);
  useEffect(() => {
    if (!pendingBillIdFromHash || !Array.isArray(list) || loading) return;
    const target = list.find((p) => Number(p.bill_id) === pendingBillIdFromHash);
    if (target) {
      openPayment(target);
      setPendingBillIdFromHash(null);
      // Scrub the query off the hash so a refresh doesn't keep re-opening
      // the modal, but keep the page id so the user stays on /admin#payments.
      const cleanHash = String(window.location.hash || '').split('?')[0];
      try { history.replaceState(null, '', cleanHash || '#payments'); } catch {}
    } else if (filter === FILTER_ALL) {
      setFilter('pending');
    } else if (filter === 'pending') {
      // Not in the current filter — try verified, then rejected.
      setFilter('verified');
    } else if (filter === 'verified') {
      setFilter('rejected');
    } else if (filter === 'rejected') {
      // Exhausted all filters — clear the hash so we don't loop.
      setPendingBillIdFromHash(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingBillIdFromHash, list, filter, loading]);

  // Lazy-load the slip_url when admin opens a row. The list endpoint no longer
  // returns slip_url (defends against legacy base64 in the column from
  // pre-storage-service rows blowing up the renderer when the list is large).
  async function openPayment(p) {
    setOpen({ ...p, _slipLoading: true });
    try {
      const r = await fetch(`/api/payments/${encodeURIComponent(p.id)}`, {
        credentials: 'same-origin',
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.payment) {
        setOpen({ ...p, ...d.payment, _slipLoading: false });
      } else {
        setOpen({ ...p, _slipLoading: false });
      }
    } catch {
      setOpen({ ...p, _slipLoading: false });
    }
  }

  async function decide(id, accept, reason, lateFeeAction) {
    setBusy(true);
    const apiFetch = window.requireApiFetch ? window.requireApiFetch() : window.apiFetch;
    try {
      // lateFeeAction ('waive' | 'carry') is only sent when approving a
      // principal-only payment. Without it the server refuses with
      // LATE_FEE_DECISION_REQUIRED so the admin can't silently forgive the fee.
      const body = { accept, reason };
      if (lateFeeAction) body.lateFeeAction = lateFeeAction;
      const r = await apiFetch(`/api/payments/${id}/verify`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) {
        if (d.code === 'LATE_FEE_DECISION_REQUIRED') {
          throw new Error(`ผู้เช่าจ่ายเฉพาะค่าเช่า ฿${Number(d.billPrincipal).toLocaleString('th-TH')} — ยังมีค่าปรับ ฿${Number(d.billLateFee).toLocaleString('th-TH')} เลือกวิธีจัดการค่าปรับก่อน (ยกค่าปรับ / เก็บรอบหน้า) หรือกดปฏิเสธ`);
        }
        if (d.code === 'RECURRING_CHARGES_REQUIRED_FOR_CARRY') {
          throw new Error('ต้องเปิดฟีเจอร์ "ค่าใช้จ่ายประจำ" ที่หน้า Features ก่อน จึงจะเก็บค่าปรับรอบหน้าได้ — หรือเลือก "ยกค่าปรับ" แทน');
        }
        throw new Error(d.error);
      }
      const okMsg = accept
        ? (lateFeeAction === 'carry' ? 'อนุมัติแล้ว (ยกค่าปรับไปเก็บรอบหน้า)'
           : lateFeeAction === 'waive' ? 'อนุมัติแล้ว (ยกค่าปรับ)' : 'อนุมัติแล้ว')
        : 'ปฏิเสธแล้ว';
      setToast && setToast({ kind: 'success', message: okMsg });
      setOpen(null); load();
    } catch (e) { setToast && setToast({ kind: 'error', message:e.message }); }
    finally { setBusy(false); }
  }

  const searchTerm = search.trim().toLowerCase();
  const visibleList = useMemo(() => {
    const sorted = sortPaymentsNewestFirst(list);
    if (!searchTerm) return sorted;
    return sorted.filter((payment) => paymentSearchHaystack(payment).includes(searchTerm));
  }, [list, searchTerm]);
  const countFor = (status) => Number(summary?.[status]?.count || 0);
  const amountRawFor = (status) => Number(summary?.[status]?.amount || 0);
  const amountFor = (status) => amountRawFor(status)
    .toLocaleString('th-TH', { minimumFractionDigits: 2 });
  const activeFilterLabel = paymentFilterLabel(filter);
  const totalSummaryCount = PAYMENT_STATUS_ORDER.reduce((s, status) => s + countFor(status), 0);
  const totalSummaryAmount = PAYMENT_STATUS_ORDER.reduce((s, status) => s + amountRawFor(status), 0);

  return (
    <PageContainer>
      <PageHeader title="สลิปชำระเงิน"
        subtitle="ตรวจสอบและอนุมัติสลิปจากผู้เช่า — ต้องเปิดฟีเจอร์ slipUpload"
        actions={
          <Btn variant="secondary" onClick={load} disabled={loading}>
            {loading ? 'กำลังโหลด...' : 'รีเฟรช'}
          </Btn>
        } />
      {summary ? (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(175px,1fr))',
          gap: 10,
          marginBottom: 12,
        }}>
          <button type="button" onClick={() => setFilter(FILTER_ALL)} style={{
            appearance: 'none',
            textAlign: 'left',
            fontFamily: 'inherit',
            cursor: 'pointer',
            padding: '12px 14px',
            border: '1px solid ' + (filter === FILTER_ALL ? C.info : (C.borderSoft || C.border)),
            borderRadius: 8,
            background: filter === FILTER_ALL ? C.infoSoft : C.surface,
            color: C.ink,
          }}>
            <div style={{ color: C.info, fontWeight: 800, fontSize: 22 }}>{totalSummaryCount}</div>
            <div style={{ fontSize: 12.5, color: C.ink, fontWeight: 700 }}>ทั้งหมด</div>
            <div style={{ fontSize: 12, color: C.muted }}>รวม ฿{totalSummaryAmount.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</div>
          </button>
          {[
            ['pending'],
            ['verified'],
            ['rejected'],
          ].map(([status]) => {
            const meta = paymentStatusMeta(C, status);
            const selected = filter === status;
            return (
              <button key={status} type="button" onClick={() => setFilter(status)} style={{
                appearance: 'none',
                textAlign: 'left',
                fontFamily: 'inherit',
                cursor: 'pointer',
                padding: '12px 14px',
                border: '1px solid ' + (selected ? meta.color : (C.borderSoft || C.border)),
                borderRadius: 8,
                background: selected ? meta.soft : C.surface,
                color: C.ink,
              }}>
                <div style={{ color: meta.color, fontWeight: 800, fontSize: 22 }}>{countFor(status)}</div>
                <div style={{ fontSize: 12.5, color: C.ink, fontWeight: 700 }}>{meta.label}</div>
                <div style={{ fontSize: 12, color: C.muted }}>฿{amountFor(status)}</div>
                <div style={{ marginTop: 6, fontSize: 11.5, color: meta.ink, lineHeight: 1.35 }}>
                  {meta.next}
                </div>
              </button>
            );
          })}
        </div>
      ) : null}
      <div style={{
        marginBottom: 12,
        padding: 12,
        border: '1px solid ' + (C.borderSoft || C.border),
        borderRadius: 8,
        background: C.surface,
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        flexWrap: 'wrap',
      }}>
        <label style={{ flex: '1 1 300px', minWidth: 220, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.muted, whiteSpace: 'nowrap' }}>ค้นหา</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="ค้นหาสลิปชำระเงิน"
            placeholder="เลขบิล ห้อง ผู้เช่า เบอร์ ยอด หรือสถานะ"
            style={{
              flex: 1,
              minWidth: 0,
              height: 36,
              padding: '0 12px',
              borderRadius: 8,
              border: '1px solid ' + C.border,
              background: C.bg,
              color: C.ink,
              fontFamily: 'inherit',
              fontSize: 13,
            }}
          />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.muted, whiteSpace: 'nowrap' }}>สถานะ</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}
            aria-label="กรองสถานะสลิป"
            style={{
              height: 36,
              padding: '0 10px',
              borderRadius: 8,
              border: '1px solid ' + C.border,
              background: C.bg,
              color: C.ink,
              fontFamily: 'inherit',
            }}>
            <option value={FILTER_ALL}>{FILTER_ALL_LABEL}</option>
            <option value="pending">รอตรวจสอบ</option>
            <option value="verified">อนุมัติแล้ว</option>
            <option value="rejected">ปฏิเสธ</option>
          </select>
        </label>
        {searchTerm && (
          <Btn variant="ghost" size="sm" onClick={() => setSearch('')}>ล้างค้นหา</Btn>
        )}
        <div style={{ fontSize: 12, color: C.muted, marginLeft: 'auto' }}>
          แสดง {visibleList.length} จาก {list.length} รายการในมุมมอง {activeFilterLabel}
        </div>
      </div>
      <Card>
        <div style={{
          padding: '10px 16px',
          borderBottom: '1px solid ' + (C.borderSoft || C.border),
          background: C.bgSoft || C.bg,
          color: C.muted,
          display: 'flex',
          justifyContent: 'space-between',
          gap: 10,
          flexWrap: 'wrap',
          fontSize: 12.5,
        }}>
          <span style={{ fontWeight: 700, color: C.ink }}>รายการสลิป</span>
          <span>เรียงล่าสุดอยู่ด้านบน · คลิกแถวเพื่อดูสลิปและรายละเอียดบิล</span>
        </div>
        {loading ? (
          <div style={{ padding: 32, textAlign: 'center', color: C.muted, fontSize: 13.5 }}>
            กำลังโหลด...
          </div>
        ) : loadError ? (
          <div style={{ padding: 24, color: C.danger || '#b94a48', fontSize: 13.5 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>โหลดข้อมูลไม่สำเร็จ</div>
            <div style={{ marginBottom: 12 }}>{loadError}</div>
            <Btn onClick={load}>ลองใหม่</Btn>
          </div>
        ) : visibleList.length === 0 ? (
          <EmptyState
            title={searchTerm ? 'ไม่พบรายการที่ค้นหา' : 'ไม่มีรายการในสถานะนี้'}
            description={searchTerm
              ? 'ลองค้นด้วยเลขบิล ห้อง ชื่อผู้เช่า เบอร์โทร ยอดเงิน หรือสถานะ'
              : 'เลือกสถานะอื่นหรือรีเฟรชเพื่อดูรายการล่าสุด'}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: C.border }}>
            {visibleList.map((p) => {
              const slipMeta = paymentStatusMeta(C, p.status);
              const billMeta = billStatusMeta(C, p.bill_status);
              return (
                <div key={p.id} style={{
                  background: C.bg,
                  padding: '14px 16px',
                  display: 'grid',
                  borderLeft: `5px solid ${slipMeta.color || C.border}`,
                  gridTemplateColumns: 'minmax(0,1.35fr) minmax(170px,.65fr) minmax(230px,.9fr)',
                  gap: 16,
                  alignItems: 'center',
                  cursor: 'pointer',
                }} onClick={() => openPayment(p)}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
                      {p.tenant_name || 'ไม่ระบุผู้เช่า'} · ห้อง {p.room_id || '-'}
                    </div>
                    <div style={{ color: C.muted, fontSize: 12.5, marginTop: 2 }}>
                      บิล {p.bill_no || p.bill_id || '-'} · {p.tenant_phone || 'ไม่มีเบอร์'} · {new Date(p.created_at).toLocaleString('th-TH')}
                    </div>
                    <div style={{ marginTop: 6, color: slipMeta.ink, fontSize: 12, lineHeight: 1.45 }}>
                      {slipMeta.next}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', minWidth: 0 }}>
                    <div style={{ fontFamily: 'IBM Plex Sans Thai', fontWeight: 800, fontSize: 17 }}>฿{fmtMoney(p.amount)}</div>
                    <div style={{ color: C.muted, fontSize: 11.5, marginTop: 3 }}>
                      อัปโหลด {p.upload_attempts || 1}/3 ครั้ง
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                    <StatusBadge meta={slipMeta} prefix="สลิป" />
                    <StatusBadge meta={billMeta} prefix="บิล" />
                    <div style={{ color: C.muted, fontSize: 11.5, lineHeight: 1.35 }}>
                      {billMeta.help}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      {open ? <SlipModal payment={open} busy={busy} onClose={() => setOpen(null)} onDecide={decide} /> : null}
    </PageContainer>
  );
}

function SlipModal({ payment, busy, onClose, onDecide }) {
  const C = window.ADMIN_C;
  const { Btn } = window;
  const [reason, setReason] = useState('');
  // How to handle the outstanding late fee when approving a principal-only
  // payment: 'waive' (forgive) or 'carry' (bill it next month). Only used when
  // isPrincipalDecision is true below.
  const [lateFeeChoice, setLateFeeChoice] = useState('waive');
  // Defense-in-depth: if a legacy slip_url somehow contains a base64 data URL
  // (pre-storage-service rows), don't pour it into <img src>/<a href> — that
  // would force the browser to decode tens of MB and can OOM the renderer.
  // The cleanup script + server-side cap should make this unreachable, but
  // belt-and-braces is cheap.
  const slipUrl = (typeof payment.slip_url === 'string'
                   && payment.slip_url.length < 2048
                   && !payment.slip_url.startsWith('data:'))
                   ? payment.slip_url : null;
  // Late-fee decision context: tenant paid only the principal while a late fee
  // is outstanding. The admin must explicitly choose — approve waives the fee
  // (waiveLateFee:true), reject asks the tenant to pay it. The server refuses a
  // silent settle (LATE_FEE_DECISION_REQUIRED), so we surface the choice here.
  const lateFeeForDecision = Number(payment.verify_payload?.amountTier?.billLateFeeAtUpload || 0);
  const billTotalForDecision = Number(payment.bill_total);
  const principalForDecision = Number(payment.verify_payload?.amountTier?.principalAtUpload)
    || (billTotalForDecision - lateFeeForDecision);
  const paidAmtForDecision = Number(payment.amount);
  const isPrincipalDecision = lateFeeForDecision > 0
    && Number.isFinite(paidAmtForDecision) && Number.isFinite(principalForDecision)
    && Number.isFinite(billTotalForDecision)
    && moneyDiff(paidAmtForDecision, principalForDecision) <= paymentToleranceForTotal(principalForDecision)
    && moneyDiff(paidAmtForDecision, billTotalForDecision) > paymentToleranceForTotal(billTotalForDecision);
  const slipMeta = paymentStatusMeta(C, payment.status);
  const billMeta = billStatusMeta(C, payment.bill_status);
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'grid', placeItems: 'center', zIndex: 100, padding: 16,
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: C.bg, color: C.ink, borderRadius: 16, padding: 24,
        width: '100%', maxWidth: 560, maxHeight: '90vh', overflow: 'auto',
      }}>
        <h3 style={{ margin: 0, fontFamily: 'IBM Plex Sans Thai', fontWeight: 600 }}>สลิปชำระเงิน</h3>
        <p style={{ color: C.muted, fontSize: 13 }}>
          {payment.tenant_name || ''} · {payment.tenant_phone || ''} · ห้อง {payment.room_id || '-'} · บิล {payment.bill_no || payment.bill_id}
        </p>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
          gap: 10,
          margin: '12px 0',
        }}>
          <StatusInfoPanel title="สถานะสลิป" meta={slipMeta} detail={slipMeta.help} />
          <StatusInfoPanel title="สถานะบิล" meta={billMeta} detail={billMeta.help} />
        </div>
        {payment._slipLoading ? (
          <div style={{ color: C.muted, padding: '12px 0' }}>กำลังโหลดสลิป...</div>
        ) : slipUrl ? (
          <a href={slipUrl} target="_blank" rel="noopener noreferrer">
            <img src={slipUrl} alt="slip"
              style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid ' + C.border }} />
          </a>
        ) : <div style={{ color: C.muted }}>ไม่มีรูปสลิป</div>}
        <div style={{ marginTop: 12 }}>
          <div>จำนวนเงินที่ผู้เช่าระบุ: <strong>฿{fmtMoney(payment.amount)}</strong></div>
          <div>วันที่: {new Date(payment.created_at).toLocaleString('th-TH')}</div>
        </div>
        {/* R2-followup — visual mismatch alert. Admin scanning the slip
            queue needs to see at a glance when amount ≠ bill_total so they
            can decide which tier (exact / principal / reject) is right.
            Shows three colors: green = exact match, amber = principal tier
            (likely good-faith pre-late_fee payment, late_fee will be waived),
            red = doesn't match either reference. The verify_payload.amountTier
            on the row tells us which tier the server already classified. */}
        {(() => {
          const billTotal = Number(payment.bill_total);
          const amt = Number(payment.amount);
          if (!Number.isFinite(billTotal) || billTotal <= 0 || !Number.isFinite(amt)) return null;
          const lateFee = Number(payment.verify_payload?.amountTier?.billLateFeeAtUpload || 0);
          const principal = Number(payment.verify_payload?.amountTier?.principalAtUpload) || (billTotal - lateFee);
          const totalTolerance = paymentToleranceForTotal(billTotal);
          const principalTolerance = paymentToleranceForTotal(principal);
          const diffTotal = moneyDiff(amt, billTotal);
          const diffPrincipal = moneyDiff(amt, principal);
          let alert = null;
          if (diffTotal <= totalTolerance) {
            alert = { tone: 'success', icon: '✅', title: 'ยอดตรงกับบิลพอดี',
              desc: lateFee > 0
                ? `ผู้เช่าจ่ายยอดเต็ม (รวมค่าปรับ ฿${fmtMoney(lateFee)})`
                : 'ยอดที่ผู้เช่าระบุตรงกับยอดบิลปัจจุบัน' };
          } else if (lateFee > 0 && diffPrincipal <= principalTolerance) {
            alert = { tone: 'warning', icon: '💡', title: 'ผู้เช่าจ่ายค่าเช่าสุจริต (ยังไม่รวมค่าปรับ)',
              desc: `ผู้เช่าโอน ฿${fmtMoney(amt)} = ค่าเช่า+ค่าน้ำไฟ — ค่าปรับ ฿${fmtMoney(lateFee)} เพิ่งขึ้นภายหลัง. เลือก "อนุมัติ + ยกค่าปรับ" เพื่อยกเว้น หรือ "ปฏิเสธ" เพื่อให้ผู้เช่าจ่ายค่าปรับเพิ่ม` };
          } else {
            alert = { tone: 'danger', icon: '⚠️', title: 'ยอดไม่ตรงกับทั้งสองเกณฑ์',
              desc: `ผู้เช่าโอน ฿${fmtMoney(amt)}; ยอดบิล ฿${fmtMoney(billTotal)}${lateFee > 0 ? ` (ค่าเช่า ฿${fmtMoney(principal)} + ค่าปรับ ฿${fmtMoney(lateFee)})` : ''} — ปฏิเสธหรือสอบถามผู้เช่า` };
          }
          const palette = {
            success: { bg: '#dff7e6', border: '#7bc798', fg: '#1d6a3e' },
            warning: { bg: '#fff3cd', border: '#dba43a', fg: '#664400' },
            danger:  { bg: '#fde2e2', border: '#d97070', fg: '#7a1b1b' },
          }[alert.tone];
          return (
            <div style={{
              marginTop: 12, padding: '10px 12px', borderRadius: 8,
              background: palette.bg, border: `1px solid ${palette.border}`, color: palette.fg,
              fontSize: 13, lineHeight: 1.55,
            }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{alert.icon} {alert.title}</div>
              <div>{alert.desc}</div>
            </div>
          );
        })()}
        <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: C.bgSoft || '#fbf6ec', color: C.ink2, fontSize: 12.5, lineHeight: 1.6 }}>
          <div>ห้อง: {payment.room_id || '-'} · สถานะบิล: {billStatusLabel(payment.bill_status)}</div>
          {payment.bill_total != null ? <div>ยอดตามบิล: ฿{fmtMoney(payment.bill_total)}</div> : null}
          <div>อัปโหลดสลิป: {payment.upload_attempts || 1}/3</div>
          {payment.rejected_reason ? <div>เหตุผลปฏิเสธ: {payment.rejected_reason}</div> : null}
          {payment.verify_provider ? <div>ผู้ตรวจ: {payment.verify_provider}</div> : null}
          {payment.transaction_ref ? <div>เลขอ้างอิง: {payment.transaction_ref}</div> : null}
          {payment.verify_payload && payment.verify_payload.code ? <div>รหัสตรวจสลิป: {payment.verify_payload.code}</div> : null}
          {payment.verify_payload && payment.verify_payload.error ? <div>ข้อความจากบริการตรวจ: {payment.verify_payload.error}</div> : null}
          {payment.verify_payload && payment.verify_payload.amount != null ? (
            <div>ยอดที่บริการอ่านได้: ฿{fmtMoney(payment.verify_payload.amount)}</div>
          ) : null}
          {payment.verify_payload && payment.verify_payload.sender ? (
            <div>ผู้โอนในสลิป: {partySummary(payment.verify_payload.sender)}</div>
          ) : null}
          {payment.verify_payload && payment.verify_payload.receiver ? (
            <div>ผู้รับในสลิป: {partySummary(payment.verify_payload.receiver)}</div>
          ) : null}
          {payment.verify_payload && payment.verify_payload.transDate ? (
            <div>เวลารายการในสลิป: {payment.verify_payload.transDate}</div>
          ) : null}
          {payment.verify_payload && Array.isArray(payment.verify_payload.attempts) && payment.verify_payload.attempts.length ? (
            <div>เส้นทางตรวจ: {payment.verify_payload.attempts.map(formatVerifyAttempt).join(', ')}</div>
          ) : null}
        </div>
        {payment.status === 'pending' ? (
          <>
            <input value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="เหตุผลที่ปฏิเสธ (จำเป็นเมื่อกดปฏิเสธ — ผู้เช่าจะเห็นข้อความนี้)" maxLength={500}
              style={{ width: '100%', marginTop: 12, padding: '8px 12px',
                borderRadius: 6, border: '1px solid ' + C.border, background: C.bg, color: C.ink }} />
            {/* Inline impact preview — admin sees EXACTLY what each click does
                before clicking. Without this, "อนุมัติ" was a single
                irreversible click that flipped bill→paid + notified the
                tenant; "ปฏิเสธ" silently sent an empty reason. */}
            <div style={{ marginTop: 8, padding: '10px 12px',
                          background: C.bgSoft || '#fbf6ec',
                          border: `1px solid ${C.borderSoft || C.border}`,
                          borderRadius: 8, fontSize: 12, color: C.ink2, lineHeight: 1.6 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>📌 สิ่งที่จะเกิดขึ้น</div>
              {isPrincipalDecision ? (
                <>
                  <div>• ผู้เช่าจ่ายเฉพาะค่าเช่า ฿{fmtMoney(principalForDecision)} — ยังมี<b>ค่าปรับล่าช้า ฿{fmtMoney(lateFeeForDecision)}</b>ค้างอยู่ เลือกวิธีจัดการค่าปรับ:</div>
                  <label style={{ display: 'block', marginTop: 6, cursor: 'pointer' }}>
                    <input type="radio" name="lateFeeChoice" checked={lateFeeChoice === 'waive'}
                      onChange={() => setLateFeeChoice('waive')} style={{ marginRight: 6 }} />
                    <b>ยกค่าปรับ</b> — ยกเว้น ฿{fmtMoney(lateFeeForDecision)} ตั้งบิลเป็น "ชำระแล้ว"
                  </label>
                  <label style={{ display: 'block', marginTop: 4, cursor: 'pointer' }}>
                    <input type="radio" name="lateFeeChoice" checked={lateFeeChoice === 'carry'}
                      onChange={() => setLateFeeChoice('carry')} style={{ marginRight: 6 }} />
                    <b>เก็บรอบหน้า</b> — บิลนี้ชำระแล้ว, ยก ฿{fmtMoney(lateFeeForDecision)} ไปเป็นบิลรอบถัดไป
                  </label>
                  <div style={{ marginTop: 6 }}>• <b>ปฏิเสธ</b> → ให้ผู้เช่าจ่ายเต็มรวมค่าปรับ ฿{fmtMoney(lateFeeForDecision)} แล้วส่งสลิปใหม่ (หรือรับเงินสดที่เคาน์เตอร์)</div>
                </>
              ) : (
                <>
                  <div>• <b>อนุมัติ</b> → บิล <code>#{payment.bill_id || payment.bill_no}</code> จะถูกตั้งเป็น "ชำระแล้ว" + ส่งแจ้งเตือนผู้เช่าทาง LINE/อีเมล</div>
                  <div>• <b>ปฏิเสธ</b> → บิลคงสถานะ "รอชำระ" + ส่งเหตุผลให้ผู้เช่า ผู้เช่าต้องอัปโหลดสลิปใหม่</div>
                </>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <Btn
                onClick={() => {
                  // Confirm before approving — this is the moment money
                  // status flips. Show the amount + bill so admin spots a
                  // mismatched slip image (e.g. tenant uploaded the wrong
                  // month's slip).
                  const amt = fmtMoney(payment.amount);
                  const feeLine = isPrincipalDecision
                    ? (lateFeeChoice === 'carry'
                        ? `\n📌 จะ "ยกค่าปรับล่าช้า ฿${fmtMoney(lateFeeForDecision)}" ไปเก็บในบิลรอบถัดไป`
                        : `\n📌 จะ "ยกเว้นค่าปรับล่าช้า ฿${fmtMoney(lateFeeForDecision)}" ให้ผู้เช่า`)
                    : '';
                  const ok = window.confirm(
                    `อนุมัติสลิป — ตั้งบิลเป็น "ชำระแล้ว"?\n\n` +
                    `ผู้เช่า: ${payment.tenant_name || '-'}\n` +
                    `บิล: ${payment.bill_no || payment.bill_id}\n` +
                    `จำนวน: ฿${amt}${feeLine}\n\n` +
                    `📌 บิลจะถูก mark paid ทันที + ผู้เช่าจะได้แจ้งเตือนทาง LINE/อีเมล\n` +
                    `📌 ถ้าจำนวนเงินไม่ตรงกับสลิปจริง ให้ปฏิเสธก่อนแล้วขอสลิปใหม่`
                  );
                  // On a principal-only payment, pass the chosen late-fee action
                  // ('waive' | 'carry'); otherwise no action (normal full payment).
                  if (ok) onDecide(payment.id, true, null, isPrincipalDecision ? lateFeeChoice : undefined);
                }}
                disabled={busy} variant="primary" style={{ flex: 1 }}>
                {isPrincipalDecision
                  ? (lateFeeChoice === 'carry'
                      ? `✓ อนุมัติ + เก็บค่าปรับรอบหน้า`
                      : `✓ อนุมัติ + ยกค่าปรับ ฿${fmtMoney(lateFeeForDecision)}`)
                  : '✓ อนุมัติ + ตั้งเป็นชำระแล้ว'}</Btn>
              <Btn
                onClick={() => {
                  // Reason is now REQUIRED — without it the tenant gets a
                  // generic "rejected" message and won't know what to fix.
                  // Server schema accepts empty string, so this guard is
                  // purely client-side UX.
                  const trimmed = reason.trim();
                  if (trimmed.length < 3) {
                    alert('โปรดกรอกเหตุผลในการปฏิเสธ (อย่างน้อย 3 ตัวอักษร)\n\nผู้เช่าจะเห็นข้อความนี้ — เขียนชัดเจนเพื่อให้รู้ว่าต้องแก้อะไร เช่น "ยอดไม่ตรงกับบิล" หรือ "เลขที่อ้างอิงผิด"');
                    return;
                  }
                  onDecide(payment.id, false, trimmed);
                }}
                disabled={busy} variant="danger" style={{ flex: 1 }}>✗ ปฏิเสธ</Btn>
            </div>
          </>
        ) : (
          <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: C.bgSoft, color: C.ink2, fontSize: 13 }}>
            ตรวจสอบโดย {prettyVerifiedBy(payment.verified_by)} เมื่อ {new Date(payment.verified_at).toLocaleString('th-TH')}
            {payment.rejected_reason ? ` · เหตุผล: ${payment.rejected_reason}` : ''}
          </div>
        )}
        {/* Cross-link: jump straight to the bill row in /admin#billing so
            the operator can see the full bill context (line items, due
            date, send-readiness) without copy-pasting the bill_no. The
            anchor is consumed by page-billing.jsx which opens the matching
            bill's preview on mount. */}
        {(payment.bill_id || payment.bill_no) ? (
          <div style={{ marginTop: 8, textAlign: 'center' }}>
            <a
              href={`#billing?billId=${encodeURIComponent(payment.bill_id || '')}`}
              onClick={(e) => {
                // History push so the admin shell's hash router picks it up
                // without a full reload; we also dispatch hashchange because
                // some shells listen on that, not popstate.
                e.preventDefault();
                window.location.hash = `#billing?billId=${encodeURIComponent(payment.bill_id || '')}`;
              }}
              style={{ fontSize: 12.5, color: C.muted, textDecoration: 'underline' }}
            >
              ดูบิลในหน้าบิล/ใบแจ้งหนี้ →
            </a>
          </div>
        ) : null}
        <button onClick={onClose} style={{
          marginTop: 12, width: '100%', padding: 10, borderRadius: 8, border: 0,
          background: 'transparent', color: C.muted, cursor: 'pointer', fontFamily: 'inherit',
        }}>ปิด</button>
      </div>
    </div>
  );
}

function makeAbortableRequest(ms) {
  if (typeof AbortController === 'undefined') {
    return { signal: null, abort() {}, done() {} };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return {
    signal: ctrl.signal,
    abort: () => ctrl.abort(),
    done: () => clearTimeout(timer),
  };
}

window.PagePayments = window.FeatureGate
  ? function PagePaymentsGated(props) {
      return React.createElement(window.FeatureGate,
        { flag: 'slipUpload', label: 'สลิปชำระเงิน' },
        React.createElement(PagePayments, props));
    }
  : PagePayments;
})();
