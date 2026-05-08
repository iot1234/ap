// === admin/page-payments.jsx ===============================================
// Slip verification queue. Lists payments by status (pending / verified /
// rejected). Admin opens a slip image, accepts (marks bill paid) or rejects
// with a reason.
// ===========================================================================

const { useState, useEffect, useMemo, useRef } = React;

function PagePayments({ setToast }) {
  // Guard every window global we depend on. If shared.jsx / ui.jsx / hooks.jsx
  // failed to load (CDN hiccup, slow mobile, blocked script), missing globals
  // would throw "Element type is invalid" inside render. Render a friendly
  // stub instead so the user can refresh, mirroring page-meters.jsx.
  const C = window.ADMIN_C;
  const Card = window.Card;
  const SectionHeading = window.SectionHeading;
  const Btn = window.Btn;
  const Pill = window.Pill;
  const PageContainer = window.PageContainer;
  const PageHeader = window.PageHeader;
  const EmptyState = window.EmptyState;
  if (!C || !Card || !Btn || !Pill || !PageContainer || !PageHeader || !EmptyState) {
    return React.createElement('div', {
      style: { padding: 32, fontSize: 14, color: '#5b4f40', fontFamily: 'inherit' },
    }, 'กำลังเตรียมหน้าสลิปชำระเงิน...');
  }

  const [filter, setFilter] = useState('pending');
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);

  // Track in-flight load() so a rapid filter switch can't pile up overlapping
  // fetches that resolve out of order and overwrite fresh state with stale data.
  const abortRef = useRef(null);

  async function load() {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    setLoading(true);
    setLoadError(null);
    try {
      const r = await fetch(`/api/payments?status=${encodeURIComponent(filter)}`, {
        credentials: 'same-origin',
        signal: ctrl.signal,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        // 503 means slipUpload feature is OFF on the server. Don't surface
        // as an error — FeatureGate already shows the placeholder if the
        // flag is off; if we're rendering at all the gate believed it on.
        if (r.status !== 503) {
          setLoadError(d.error || `HTTP ${r.status}`);
        }
        setList([]);
      } else {
        setList(Array.isArray(d.payments) ? d.payments : []);
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setLoadError(err.message || 'network error');
        setList([]);
      }
    } finally {
      clearTimeout(timer);
      if (abortRef.current === ctrl) abortRef.current = null;
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    return () => { if (abortRef.current) abortRef.current.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

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

  async function decide(id, accept, reason) {
    setBusy(true);
    const apiFetch = window.apiFetch || ((u, o) => fetch(u, { credentials: 'same-origin', ...o }));
    try {
      const r = await apiFetch(`/api/payments/${id}/verify`, {
        method: 'PUT',
        body: JSON.stringify({ accept, reason }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setToast && setToast({ kind: 'success', message:accept ? 'อนุมัติแล้ว' : 'ปฏิเสธแล้ว' });
      setOpen(null); load();
    } catch (e) { setToast && setToast({ kind: 'error', message:e.message }); }
    finally { setBusy(false); }
  }

  const stColor = { pending: C.warning, verified: C.success, rejected: C.danger };

  return (
    <PageContainer>
      <PageHeader title="สลิปชำระเงิน"
        subtitle="ตรวจสอบและอนุมัติสลิปจากผู้เช่า — ต้องเปิดฟีเจอร์ slipUpload"
        actions={
          <select value={filter} onChange={(e) => setFilter(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid ' + C.border, background: C.bg, color: C.ink }}>
            <option value="pending">รอตรวจสอบ</option>
            <option value="verified">อนุมัติแล้ว</option>
            <option value="rejected">ปฏิเสธ</option>
          </select>
        } />
      <Card>
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
        ) : list.length === 0 ? <EmptyState title="ไม่มีรายการ" /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: C.border }}>
            {list.map((p) => (
              <div key={p.id} style={{
                background: C.bg, padding: '14px 16px', display: 'grid',
                gridTemplateColumns: '1fr auto auto', gap: 16, alignItems: 'center', cursor: 'pointer',
              }} onClick={() => openPayment(p)}>
                <div>
                  <div style={{ fontWeight: 600 }}>{p.tenant_name || '—'} · ห้อง {p.bill_no || p.bill_id}</div>
                  <div style={{ color: C.muted, fontSize: 12.5 }}>
                    {p.tenant_phone || ''} · {new Date(p.created_at).toLocaleString('th-TH')}
                  </div>
                </div>
                <div style={{ fontFamily: 'Sora', fontWeight: 600 }}>฿{Number(p.amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })}</div>
                <Pill color={stColor[p.status]}>{p.status}</Pill>
              </div>
            ))}
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
  // Defense-in-depth: if a legacy slip_url somehow contains a base64 data URL
  // (pre-storage-service rows), don't pour it into <img src>/<a href> — that
  // would force the browser to decode tens of MB and can OOM the renderer.
  // The cleanup script + server-side cap should make this unreachable, but
  // belt-and-braces is cheap.
  const slipUrl = (typeof payment.slip_url === 'string'
                   && payment.slip_url.length < 2048
                   && !payment.slip_url.startsWith('data:'))
                   ? payment.slip_url : null;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'grid', placeItems: 'center', zIndex: 100, padding: 16,
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: C.bg, color: C.ink, borderRadius: 16, padding: 24,
        width: '100%', maxWidth: 560, maxHeight: '90vh', overflow: 'auto',
      }}>
        <h3 style={{ margin: 0, fontFamily: 'Sora', fontWeight: 600 }}>สลิปชำระเงิน</h3>
        <p style={{ color: C.muted, fontSize: 13 }}>
          {payment.tenant_name || ''} · {payment.tenant_phone || ''} · บิล {payment.bill_no || payment.bill_id}
        </p>
        {payment._slipLoading ? (
          <div style={{ color: C.muted, padding: '12px 0' }}>กำลังโหลดสลิป...</div>
        ) : slipUrl ? (
          <a href={slipUrl} target="_blank" rel="noopener noreferrer">
            <img src={slipUrl} alt="slip"
              style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid ' + C.border }} />
          </a>
        ) : <div style={{ color: C.muted }}>ไม่มีรูปสลิป</div>}
        <div style={{ marginTop: 12 }}>
          <div>จำนวนเงิน: <strong>฿{Number(payment.amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })}</strong></div>
          <div>วันที่: {new Date(payment.created_at).toLocaleString('th-TH')}</div>
        </div>
        {payment.status === 'pending' ? (
          <>
            <input value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="เหตุผล (กรณีปฏิเสธ)" maxLength={500}
              style={{ width: '100%', marginTop: 12, padding: '8px 12px',
                borderRadius: 6, border: '1px solid ' + C.border, background: C.bg, color: C.ink }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <Btn onClick={() => onDecide(payment.id, true)} disabled={busy} variant="primary" style={{ flex: 1 }}>อนุมัติ + ทำเครื่องหมายชำระแล้ว</Btn>
              <Btn onClick={() => onDecide(payment.id, false, reason)} disabled={busy} style={{ flex: 1 }}>ปฏิเสธ</Btn>
            </div>
          </>
        ) : (
          <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: C.bgSoft, color: C.ink2, fontSize: 13 }}>
            ตรวจสอบโดย {payment.verified_by} เมื่อ {new Date(payment.verified_at).toLocaleString('th-TH')}
            {payment.rejected_reason ? ` · เหตุผล: ${payment.rejected_reason}` : ''}
          </div>
        )}
        <button onClick={onClose} style={{
          marginTop: 12, width: '100%', padding: 10, borderRadius: 8, border: 0,
          background: 'transparent', color: C.muted, cursor: 'pointer', fontFamily: 'inherit',
        }}>ปิด</button>
      </div>
    </div>
  );
}

window.PagePayments = window.FeatureGate
  ? function PagePaymentsGated(props) {
      return React.createElement(window.FeatureGate,
        { flag: 'slipUpload', label: 'สลิปชำระเงิน' },
        React.createElement(PagePayments, props));
    }
  : PagePayments;
