// === admin/page-access.jsx =================================================
// Access control log viewer + manual entry. Real RFID/BLE hardware would
// POST to /api/access/log directly; this page lets staff log a manual event
// (e.g. visitor) and review history.
// ===========================================================================

(function () {
const { useState, useEffect, useRef } = React;
const ACCESS_API_TIMEOUT_MS = 15_000;

function PageAccess({ setToast }) {
  // Diagnostic: confirm the component mounted. See page-payments.jsx for context.
  React.useEffect(() => {
    console.log('[PageAccess] mounted');
    return () => console.log('[PageAccess] unmounted');
  }, []);

  // Guard window globals so a partial CDN load doesn't throw a destructure
  // error on first render. See page-meters.jsx for context.
  const C = window.ADMIN_C;
  const Card = window.Card;
  const Btn = window.Btn;
  const Pill = window.Pill;
  const PageContainer = window.PageContainer;
  const PageHeader = window.PageHeader;
  const EmptyState = window.EmptyState;
  if (!C || !Card || !PageContainer || !PageHeader || !Btn || !EmptyState || !Pill) {
    const missing = [
      !C && 'ADMIN_C', !Card && 'Card', !Btn && 'Btn', !Pill && 'Pill',
      !PageContainer && 'PageContainer', !PageHeader && 'PageHeader', !EmptyState && 'EmptyState',
    ].filter(Boolean).join(', ');
    console.warn('[PageAccess] missing window globals:', missing);
    return React.createElement('div', {
      style: { padding: 32, fontSize: 14, color: '#5b4f40', fontFamily: 'inherit' },
    }, `กำลังเตรียมหน้าเข้า-ออก... (รอ: ${missing})`);
  }

  // Top-level view switch: "logs" (this file's existing UI) vs "devices"
  // (embedded PageAccessDevices — API token management for hardware).
  // Consolidated into one sidebar entry so admins manage tokens + see the
  // resulting log entries without switching pages. Hash /admin#access-devices
  // still works as a direct deep-link via shell.jsx's render-by-page-id.
  const Tabs = window.Tabs;
  const [view, setView] = useState('logs');
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ device: 'main_door', method: 'manual', result: 'granted', roomId: '', cardId: '', reason: '' });
  const abortRef = useRef(null);

  async function load() {
    if (abortRef.current) abortRef.current.abort();
    const req = makeAbortableRequest(ACCESS_API_TIMEOUT_MS);
    abortRef.current = req;
    setLoading(true);
    setLoadError(null);
    try {
      const r = await fetch('/api/access/logs?limit=200', {
        credentials: 'same-origin',
        ...(req.signal ? { signal: req.signal } : {}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status !== 503) setLoadError(d.error || `HTTP ${r.status}`);
        setList([]);
      } else {
        setList(d.logs || []);
      }
    } catch (err) {
      if (err.name === 'AbortError' && req.timedOut) {
        setLoadError('โหลด log ใช้เวลานานเกินกำหนด กรุณาลองใหม่อีกครั้ง');
        setList([]);
      } else if (err.name !== 'AbortError') {
        setLoadError(err.message || 'network error');
        setList([]);
      }
    } finally {
      req.done();
      if (abortRef.current === req) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  }
  useEffect(() => {
    load();
    return () => { if (abortRef.current) abortRef.current.abort(); };
  }, []);

  async function submit(e) {
    e.preventDefault();
    if (saving) return;
    if (!window.apiCall && !window.requireApiCall && !window.apiFetch && !window.requireApiFetch) {
      setToast && setToast({ kind: 'error', message: 'ระบบยังไม่พร้อม — กรุณารีเฟรชหน้า' });
      return;
    }
    const clean = {
      ...form,
      device: String(form.device || '').trim(),
      roomId: String(form.roomId || '').trim(),
      cardId: String(form.cardId || '').trim(),
      reason: String(form.reason || '').trim(),
    };
    if (!clean.device) {
      setToast && setToast({
        kind: 'warning',
        message: { title: 'ยังไม่ได้ระบุอุปกรณ์', description: 'กรุณากรอกชื่อ device เช่น main_door ก่อนบันทึก log เข้า-ออก' },
      });
      return;
    }
    setSaving(true);
    try {
      if (window.apiCall || window.requireApiCall) {
        const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
        await apiCall('/api/access/log', {
          method: 'POST',
          body: JSON.stringify(clean),
          timeoutMs: ACCESS_API_TIMEOUT_MS,
        });
      } else {
        const apiFetch = window.requireApiFetch ? window.requireApiFetch() : window.apiFetch;
        const r = await apiFetch('/api/access/log', {
          method: 'POST',
          body: JSON.stringify(clean),
          timeoutMs: ACCESS_API_TIMEOUT_MS,
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw Object.assign(new Error(d.error || `HTTP ${r.status}`), { status: r.status, code: d.code, raw: d });
      }
      setForm({ ...form, cardId: '', reason: '' });
      setToast && setToast({ kind: 'success', message: 'บันทึกแล้ว' });
      load();
    } catch (e2) {
      window.toastError
        ? window.toastError(setToast, e2, { action: 'บันทึก log เข้า-ออก' })
        : setToast && setToast({ kind: 'error', message: e2.message || 'บันทึกไม่สำเร็จ' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <PageContainer>
      <PageHeader title="เข้า-ออก"
        subtitle={view === 'logs'
          ? 'บันทึก log การเข้า-ออก · hardware (RFID/BLE) สามารถ POST /api/access/log โดยตรง'
          : 'ออก Bearer token ให้ฮาร์ดแวร์ใช้ POST /api/access/log โดยไม่ต้องมี session admin'} />

      {Tabs ? (
        <Tabs
          items={[
            { value: 'logs',    label: 'บันทึก Log',  icon: '🪪' },
            { value: 'devices', label: 'API Tokens',  icon: '📡' },
          ]}
          value={view}
          onChange={setView}
          variant="pills"
          style={{ marginBottom: 20 }}
        />
      ) : null}

      {view === 'devices' && window.PageAccessDevices && (
        <window.PageAccessDevices setToast={setToast} embedded />
      )}

      {view === 'logs' && (<>
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
          <Btn type="submit" variant="primary" disabled={saving || loading}>
            {saving ? 'กำลังบันทึก...' : 'บันทึก'}
          </Btn>
        </form>
        {saving ? (
          <div role="status" style={{
            padding: 10, borderRadius: 8,
            background: C.infoSoft || '#eef6ff',
            color: C.infoInk || C.ink2,
            fontSize: 12.5,
          }}>
            กำลังส่งข้อมูลเข้า-ออกไปยังเซิร์ฟเวอร์ ถ้าไม่ตอบกลับใน {Math.round(ACCESS_API_TIMEOUT_MS / 1000)} วินาที ระบบจะหยุดรอและแจ้งให้ลองใหม่
          </div>
        ) : null}
      </Card>
      <Card>
        {loadError && (
          <div style={{
            padding: 10, marginBottom: 12, borderRadius: 8,
            background: C.dangerSoft || '#fff5f4', color: C.danger || '#a23',
            fontSize: 13,
          }}>
            โหลด log ไม่สำเร็จ: {loadError}
            {' '}<button onClick={load} style={{
              border: 0, background: 'transparent', color: 'inherit',
              textDecoration: 'underline', cursor: 'pointer', fontFamily: 'inherit',
            }}>ลองใหม่</button>
          </div>
        )}
        {loading ? (
          <div style={{ padding: 24, textAlign: 'center', color: C.muted, fontSize: 13 }}>กำลังโหลด...</div>
        ) : list.length === 0 ? <EmptyState title="ยังไม่มี log" /> : (
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
      </>)}
    </PageContainer>
  );
}

function Field({ label, children }) {
  const C = window.ADMIN_C || {};
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

function makeAbortableRequest(ms) {
  if (typeof AbortController === 'undefined') {
    return { signal: null, abort() {}, done() {}, timedOut: false };
  }
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, ms);
  return {
    signal: ctrl.signal,
    abort: () => ctrl.abort(),
    done: () => clearTimeout(timer),
    get timedOut() { return timedOut; },
  };
}

window.PageAccess = window.FeatureGate
  ? function PageAccessGated(props) {
      return React.createElement(window.FeatureGate,
        { flag: 'accessControl', label: 'เข้า-ออก' },
        React.createElement(PageAccess, props));
    }
  : PageAccess;
})();
