// === admin/page-access.jsx =================================================
// Access control log viewer + manual entry. Real RFID/BLE hardware would
// POST to /api/access/log directly; this page lets staff log a manual event
// (e.g. visitor) and review history.
// ===========================================================================

const { useState, useEffect } = React;

function PageAccess({ setToast }) {
  const C = window.ADMIN_C;
  const { Card, Btn, Pill, PageContainer, PageHeader, EmptyState } = window;
  const [list, setList] = useState([]);
  const [form, setForm] = useState({ device: 'main_door', method: 'manual', result: 'granted', roomId: '', cardId: '', reason: '' });

  async function load() {
    try {
      const r = await fetch('/api/access/logs?limit=200', { credentials: 'same-origin' });
      const d = await r.json();
      if (r.ok) setList(d.logs || []);
    } catch {}
  }
  useEffect(() => { load(); }, []);

  async function submit(e) {
    e.preventDefault();
    const apiFetch = window.apiFetch || ((u, o) => fetch(u, { credentials: 'same-origin', ...o }));
    try {
      const r = await apiFetch('/api/access/log', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setForm({ ...form, cardId: '', reason: '' });
      setToast && setToast({ kind: 'success', message:'บันทึกแล้ว' });
      load();
    } catch (e2) { setToast && setToast({ kind: 'error', message:e2.message }); }
  }

  return (
    <PageContainer>
      <PageHeader title="เข้า-ออก"
        subtitle="บันทึก log การเข้า-ออก · hardware (RFID/BLE) สามารถ POST /api/access/log โดยตรง" />
      <Card>
        <form onSubmit={submit} style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))',
          gap: 10, alignItems: 'flex-end', marginBottom: 12,
        }}>
          <Field label="device">
            <input value={form.device} onChange={(e) => setForm({ ...form, device: e.target.value })}
              style={inp(C)} />
          </Field>
          <Field label="method">
            <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} style={inp(C)}>
              <option value="manual">manual</option>
              <option value="rfid">rfid</option>
              <option value="qr">qr</option>
              <option value="ble">ble</option>
            </select>
          </Field>
          <Field label="result">
            <select value={form.result} onChange={(e) => setForm({ ...form, result: e.target.value })} style={inp(C)}>
              <option value="granted">granted</option>
              <option value="denied">denied</option>
            </select>
          </Field>
          <Field label="roomId">
            <input value={form.roomId} onChange={(e) => setForm({ ...form, roomId: e.target.value })} style={inp(C)} />
          </Field>
          <Field label="cardId">
            <input value={form.cardId} onChange={(e) => setForm({ ...form, cardId: e.target.value })} style={inp(C)} />
          </Field>
          <Btn type="submit" variant="primary">บันทึก</Btn>
        </form>
      </Card>
      <Card>
        {list.length === 0 ? <EmptyState title="ยังไม่มี log" /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: C.border, maxHeight: 600, overflow: 'auto' }}>
            {list.map((x) => (
              <div key={x.id} style={{
                background: C.bg, padding: '10px 14px', display: 'grid',
                gridTemplateColumns: '120px 100px 1fr 80px auto', gap: 12, alignItems: 'center', fontSize: 13,
              }}>
                <span style={{ color: C.muted }}>{new Date(x.occurred_at).toLocaleString('th-TH')}</span>
                <span><Pill color={x.result === 'granted' ? C.success : C.danger}>{x.result}</Pill></span>
                <span>{x.device} · {x.method} {x.card_id ? `· ${x.card_id}` : ''}</span>
                <span>{x.room_id || ''}</span>
                <span style={{ color: C.muted, fontSize: 12 }}>{x.reason || ''}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </PageContainer>
  );
}

function Field({ label, children }) {
  const C = window.ADMIN_C;
  return (
    <label style={{ fontSize: 12, color: C.muted, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {label}{children}
    </label>
  );
}
function inp(C) {
  return {
    padding: '8px 10px', borderRadius: 6, border: '1px solid ' + C.border,
    background: C.bg, color: C.ink, fontSize: 13, fontFamily: 'inherit',
  };
}

window.PageAccess = window.FeatureGate
  ? function PageAccessGated(props) {
      return React.createElement(window.FeatureGate,
        { flag: 'accessControl', label: 'เข้า-ออก' },
        React.createElement(PageAccess, props));
    }
  : PageAccess;
