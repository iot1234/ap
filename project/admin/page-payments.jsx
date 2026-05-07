// === admin/page-payments.jsx ===============================================
// Slip verification queue. Lists payments by status (pending / verified /
// rejected). Admin opens a slip image, accepts (marks bill paid) or rejects
// with a reason.
// ===========================================================================

const { useState, useEffect, useMemo } = React;

function PagePayments({ setToast }) {
  const C = window.ADMIN_C;
  const { Card, SectionHeading, Btn, Pill, PageContainer, PageHeader, EmptyState } = window;
  const [filter, setFilter] = useState('pending');
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const r = await fetch(`/api/payments?status=${filter}`, { credentials: 'same-origin' });
      const d = await r.json();
      setList(d.payments || []);
    } catch (e) { /* ignore */ }
  }
  useEffect(() => { load(); }, [filter]);

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
        {list.length === 0 ? <EmptyState title="ไม่มีรายการ" /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: C.border }}>
            {list.map((p) => (
              <div key={p.id} style={{
                background: C.bg, padding: '14px 16px', display: 'grid',
                gridTemplateColumns: '1fr auto auto', gap: 16, alignItems: 'center', cursor: 'pointer',
              }} onClick={() => setOpen(p)}>
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
        {payment.slip_url ? (
          <a href={payment.slip_url} target="_blank" rel="noopener noreferrer">
            <img src={payment.slip_url} alt="slip"
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
