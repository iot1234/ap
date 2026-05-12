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

function paymentStatusLabel(status) {
  return PAYMENT_STATUS_LABEL[status] || status || '-';
}

function billStatusLabel(status) {
  return BILL_STATUS_LABEL[status] || status || '-';
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
  const SectionHeading = window.SectionHeading;
  const Btn = window.Btn;
  const Pill = window.Pill;
  const PageContainer = window.PageContainer;
  const PageHeader = window.PageHeader;
  const EmptyState = window.EmptyState;
  if (!C || !Card || !Btn || !Pill || !PageContainer || !PageHeader || !EmptyState) {
    const missing = [
      !C && 'ADMIN_C', !Card && 'Card', !Btn && 'Btn', !Pill && 'Pill',
      !PageContainer && 'PageContainer', !PageHeader && 'PageHeader', !EmptyState && 'EmptyState',
    ].filter(Boolean).join(', ');
    console.warn('[PagePayments] missing window globals:', missing);
    return React.createElement('div', {
      style: { padding: 32, fontSize: 14, color: '#5b4f40', fontFamily: 'inherit' },
    }, `กำลังเตรียมหน้าสลิปชำระเงิน... (รอ: ${missing})`);
  }

  const [filter, setFilter] = useState('pending');
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
      const r = await fetch(`/api/payments?status=${encodeURIComponent(filter)}`, {
        credentials: 'same-origin',
        ...(req.signal ? { signal: req.signal } : {}),
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
        setSummary(null);
      } else {
        setList(Array.isArray(d.payments) ? d.payments : []);
        setSummary(d.summary || null);
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
  const countFor = (status) => Number(summary?.[status]?.count || 0);
  const amountFor = (status) => Number(summary?.[status]?.amount || 0)
    .toLocaleString('th-TH', { minimumFractionDigits: 2 });

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
      {summary ? (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))',
          gap: 10,
          marginBottom: 12,
        }}>
          {[
            ['pending', 'รอตรวจสอบ', C.warning],
            ['verified', 'อนุมัติแล้ว', C.success],
            ['rejected', 'ปฏิเสธ', C.danger],
          ].map(([status, label, color]) => (
            <div key={status} style={{
              padding: '10px 12px',
              border: '1px solid ' + (C.borderSoft || C.border),
              borderRadius: 8,
              background: C.bgSoft || C.bg,
              color: C.ink,
            }}>
              <div style={{ color, fontWeight: 700, fontSize: 18 }}>{countFor(status)}</div>
              <div style={{ fontSize: 12.5, color: C.muted }}>{label} · ฿{amountFor(status)}</div>
            </div>
          ))}
        </div>
      ) : null}
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
                  <div style={{ fontWeight: 600 }}>
                    {p.tenant_name || '—'} · ห้อง {p.room_id || '-'} · บิล {p.bill_no || p.bill_id}
                  </div>
                  <div style={{ color: C.muted, fontSize: 12.5 }}>
                    {p.tenant_phone || ''} · {new Date(p.created_at).toLocaleString('th-TH')}
                  </div>
                </div>
                <div style={{ fontFamily: 'Sora', fontWeight: 600 }}>฿{fmtMoney(p.amount)}</div>
                <div style={{ textAlign: 'right' }}>
                  <Pill color={stColor[p.status]}>{paymentStatusLabel(p.status)}</Pill>
                  <div style={{ marginTop: 4, color: p.status === 'rejected' ? C.danger : C.muted, fontSize: 11.5 }}>
                    สถานะบิล {billStatusLabel(p.bill_status)} · อัปโหลด {p.upload_attempts || 1}/3
                  </div>
                </div>
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
          {payment.tenant_name || ''} · {payment.tenant_phone || ''} · ห้อง {payment.room_id || '-'} · บิล {payment.bill_no || payment.bill_id}
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
          <div>จำนวนเงินที่ผู้เช่าระบุ: <strong>฿{fmtMoney(payment.amount)}</strong></div>
          <div>วันที่: {new Date(payment.created_at).toLocaleString('th-TH')}</div>
          <div>สถานะสลิป: {paymentStatusLabel(payment.status)}</div>
        </div>
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
              <div>• <b>อนุมัติ</b> → บิล <code>#{payment.bill_id || payment.bill_no}</code> จะถูกตั้งเป็น "ชำระแล้ว" + ส่งแจ้งเตือนผู้เช่าทาง LINE/อีเมล</div>
              <div>• <b>ปฏิเสธ</b> → บิลคงสถานะ "รอชำระ" + ส่งเหตุผลให้ผู้เช่า ผู้เช่าต้องอัปโหลดสลิปใหม่</div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <Btn
                onClick={() => {
                  // Confirm before approving — this is the moment money
                  // status flips. Show the amount + bill so admin spots a
                  // mismatched slip image (e.g. tenant uploaded the wrong
                  // month's slip).
                  const amt = fmtMoney(payment.amount);
                  const ok = window.confirm(
                    `อนุมัติสลิป — ตั้งบิลเป็น "ชำระแล้ว"?\n\n` +
                    `ผู้เช่า: ${payment.tenant_name || '-'}\n` +
                    `บิล: ${payment.bill_no || payment.bill_id}\n` +
                    `จำนวน: ฿${amt}\n\n` +
                    `📌 บิลจะถูก mark paid ทันที + ผู้เช่าจะได้แจ้งเตือนทาง LINE/อีเมล\n` +
                    `📌 ถ้าจำนวนเงินไม่ตรงกับสลิปจริง ให้ปฏิเสธก่อนแล้วขอสลิปใหม่`
                  );
                  if (ok) onDecide(payment.id, true);
                }}
                disabled={busy} variant="primary" style={{ flex: 1 }}>✓ อนุมัติ + ตั้งเป็นชำระแล้ว</Btn>
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
