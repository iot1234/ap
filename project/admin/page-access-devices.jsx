// === admin/page-access-devices.jsx =========================================
// Issue + revoke API tokens for hardware (RFID readers, ESP32, etc.) so
// they can POST /api/access/log without an admin session. Tokens are
// shown ONCE on creation — never stored in plaintext.
//
// Backed by:
//   GET    /api/admin/access-devices
//   POST   /api/admin/access-devices         { deviceId, description }
//   DELETE /api/admin/access-devices/:id
// ===========================================================================

const { useState, useEffect } = React;
const ACCESS_DEVICE_API_TIMEOUT_MS = 15_000;
const ACCESS_DEVICE_RESPONSE_MAX_BYTES = 512 * 1024;
const ACCESS_DEVICE_RENDER_LIMIT = 100;

function readAccessDeviceJson(res, label) {
  if (window.readJsonWithByteLimit) {
    return window.readJsonWithByteLimit(res, ACCESS_DEVICE_RESPONSE_MAX_BYTES, label || 'access devices response');
  }
  return res.json();
}

async function readAccessDevicePayload(res, label) {
  try {
    return await readAccessDeviceJson(res, label);
  } catch (err) {
    if (res && !res.ok) return {};
    throw err;
  }
}

function accessDeviceText(value, max = 200) {
  return String(value == null ? '' : value).slice(0, max);
}

function normaliseAccessDevices(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, ACCESS_DEVICE_RENDER_LIMIT).map((row) => {
    const id = Number(row && row.id);
    return {
      id: Number.isInteger(id) && id > 0 ? id : 0,
      device_id: accessDeviceText(row && row.device_id, 64),
      description: accessDeviceText(row && row.description, 200),
      enabled: !!(row && row.enabled),
      last_seen: row && row.last_seen ? accessDeviceText(row.last_seen, 64) : null,
      created_at: row && row.created_at ? accessDeviceText(row.created_at, 64) : null,
    };
  }).filter((row) => row.id && row.device_id);
}

function formatAccessDeviceDate(value, mode = 'date') {
  const ts = Date.parse(value || '');
  if (!Number.isFinite(ts)) return '-';
  const d = new Date(ts);
  return mode === 'datetime' ? d.toLocaleString('th-TH') : d.toLocaleDateString('th-TH');
}

function emitAccessDeviceDiagnostic(payload) {
  if (!window.emitAdminDiagnostic) return;
  window.emitAdminDiagnostic({
    page: 'access-devices',
    code: 'ACCESS_DEVICES_TAB_ERROR',
    title: 'API Tokens มีปัญหา',
    ...payload,
  });
}

// `embedded` prop lets PageAccess host this as a tab without rendering its
// own PageContainer + PageHeader. Standalone /admin#access-devices still
// works for legacy URLs / bookmarks.
function PageAccessDevices({ setToast, embedded = false }) {
  const C = window.ADMIN_C || {};
  const Card = window.Card;
  const Pill = window.Pill;
  const PageContainer = window.PageContainer;
  const PageHeader = window.PageHeader;
  const EmptyState = window.EmptyState;
  const Btn = window.Btn;
  const Modal = window.Modal;
  const missingGlobals = [
    !Card && 'Card',
    !Pill && 'Pill',
    !EmptyState && 'EmptyState',
    !Btn && 'Btn',
    !Modal && 'Modal',
    !embedded && !PageContainer && 'PageContainer',
    !embedded && !PageHeader && 'PageHeader',
  ].filter(Boolean);
  if (missingGlobals.length > 0) {
    const message = `รอโหลดส่วนประกอบหน้า API Tokens: ${missingGlobals.join(', ')}`;
    setTimeout(() => emitAccessDeviceDiagnostic({ kind: 'warning', message, missingGlobals }), 0);
    return React.createElement('div', {
      style: {
        padding: 16,
        marginBottom: 12,
        borderRadius: 8,
        background: '#fff7e0',
        border: '1px solid #f6d08c',
        color: '#6b4a00',
        fontSize: 13,
      },
    }, message);
  }
  const Wrapper = embedded
    ? ({ children }) => <div>{children}</div>
    : ({ children }) => <PageContainer>{children}</PageContainer>;
  // When embedded, the parent (PageAccess) already renders the title/subtitle
  // in its own PageHeader — we only need to surface the action button.
  const Header = embedded
    ? function EmbeddedHeader({ actions }) {
        if (!actions) return null;
        return (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            {actions}
          </div>
        );
      }
    : function StandaloneHeader(props) { return <PageHeader {...props} />; };
  // Resolve apiFetch defensively. requireApiFetch() THROWS if hooks.jsx
  // hasn't registered window.apiFetch yet; calling it unguarded at render
  // crashed the page to the ErrorBoundary on a slow/partial script load.
  // Fall back to window.apiFetch (possibly undefined) so any genuine
  // "not loaded" error surfaces inside a handler's try/catch as a toast
  // instead of taking down the whole page.
  const apiFetch = (() => {
    try { return window.requireApiFetch ? window.requireApiFetch() : window.apiFetch; }
    catch { return window.apiFetch; }
  })();
  const [devices, setDevices] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ deviceId: '', description: '' });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [revealed, setRevealed] = useState(null);   // { token, deviceId }

  function showError(err, action) {
    if (window.toastError) window.toastError(setToast, err, { action });
    else setToast && setToast({ kind: 'error', message: err?.message || `${action}ไม่สำเร็จ` });
  }

  async function fetchJsonWithTimeout(url, opts = {}) {
    let ctrl;
    let timer;
    let signal = opts.signal;
    if (!signal && typeof AbortController !== 'undefined') {
      ctrl = new AbortController();
      signal = ctrl.signal;
      timer = setTimeout(() => ctrl.abort(), ACCESS_DEVICE_API_TIMEOUT_MS);
    }
    try {
      const r = await fetch(url, {
        credentials: 'same-origin',
        ...opts,
        ...(signal ? { signal } : {}),
      });
      const d = await readAccessDevicePayload(r, url);
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      return d;
    } catch (err) {
      if (err.name === 'AbortError') {
        const e = new Error('คำขอใช้เวลานานเกินกำหนด — โปรดลองใหม่');
        e.code = 'TIMEOUT';
        throw e;
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function load() {
    setLoading(true);
    setLoadError(null);
    const endpoint = `/api/admin/access-devices?limit=${ACCESS_DEVICE_RENDER_LIMIT}`;
    try {
      let d;
      if (window.apiCall || window.requireApiCall) {
        const call = window.requireApiCall ? window.requireApiCall() : window.apiCall;
        d = await call(endpoint, {
          timeoutMs: ACCESS_DEVICE_API_TIMEOUT_MS,
          maxResponseBytes: ACCESS_DEVICE_RESPONSE_MAX_BYTES,
        });
      } else if (apiFetch) {
        const r = await apiFetch(endpoint, {
          timeoutMs: ACCESS_DEVICE_API_TIMEOUT_MS,
        });
        d = await readAccessDevicePayload(r, endpoint);
        if (!r.ok) throw new Error(d.error || 'load failed');
      } else {
        d = await fetchJsonWithTimeout(endpoint);
      }
      setDevices(normaliseAccessDevices(d.devices));
    } catch (e) {
      const message = e?.message || 'โหลด API Tokens ไม่สำเร็จ';
      setLoadError(message);
      setDevices([]);
      emitAccessDeviceDiagnostic({
        kind: 'danger',
        message,
        error: message,
        action: 'โหลด API Tokens',
        endpoint,
      });
      showError(e, 'โหลด API Tokens');
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function create(e) {
    e.preventDefault();
    if (!/^[A-Za-z0-9_.-]{2,64}$/.test(form.deviceId)) {
      setToast && setToast({ kind: 'error', message: 'device id ต้องเป็น a-z 0-9 _.- (2-64 ตัว)' });
      return;
    }
    if (!apiFetch && !window.apiCall && !window.requireApiCall) {
      setToast && setToast({ kind: 'error', message: 'ระบบยังไม่พร้อม — กรุณารีเฟรชหน้า' });
      return;
    }
    setBusy(true);
    try {
      let d;
      if (window.apiCall || window.requireApiCall) {
        const call = window.requireApiCall ? window.requireApiCall() : window.apiCall;
        d = await call('/api/admin/access-devices', {
          method: 'POST',
          body: JSON.stringify(form),
          timeoutMs: ACCESS_DEVICE_API_TIMEOUT_MS,
          maxResponseBytes: ACCESS_DEVICE_RESPONSE_MAX_BYTES,
        });
      } else {
        const r = await apiFetch('/api/admin/access-devices', {
          method: 'POST',
          body: JSON.stringify(form),
          timeoutMs: ACCESS_DEVICE_API_TIMEOUT_MS,
        });
        d = await readAccessDevicePayload(r, '/api/admin/access-devices');
        if (!r.ok) throw new Error(d.error || 'create failed');
      }
      setRevealed({ token: d.token, deviceId: d.device.device_id });
      setShowNew(false);
      setForm({ deviceId: '', description: '' });
      load();
    } catch (e) {
      showError(e, 'สร้าง API Token');
    } finally { setBusy(false); }
  }

  async function remove(id) {
    if (!window.confirm('ลบ device นี้? hardware ที่ใช้ token เก่าจะไม่สามารถ POST log ได้อีก')) return;
    if (deletingId) return;
    if (!apiFetch && !window.apiCall && !window.requireApiCall) {
      setToast && setToast({ kind: 'error', message: 'ระบบยังไม่พร้อม — กรุณารีเฟรชหน้า' });
      return;
    }
    setDeletingId(id);
    try {
      if (window.apiCall || window.requireApiCall) {
        const call = window.requireApiCall ? window.requireApiCall() : window.apiCall;
        await call(`/api/admin/access-devices/${id}`, {
          method: 'DELETE',
          timeoutMs: ACCESS_DEVICE_API_TIMEOUT_MS,
          maxResponseBytes: ACCESS_DEVICE_RESPONSE_MAX_BYTES,
        });
      } else {
        const r = await apiFetch(`/api/admin/access-devices/${id}`, {
          method: 'DELETE',
          timeoutMs: ACCESS_DEVICE_API_TIMEOUT_MS,
        });
        const d = await readAccessDevicePayload(r, `/api/admin/access-devices/${id}`);
        if (!r.ok) throw new Error(d.error || 'delete failed');
      }
      setToast && setToast({ kind: 'success', message: 'ลบแล้ว' });
      load();
    } catch (e) {
      showError(e, 'ลบ API Token');
    } finally { setDeletingId(null); }
  }

  function copyToken() {
    if (!revealed || !navigator.clipboard) return;
    navigator.clipboard.writeText(revealed.token);
    setToast && setToast({ kind: 'success', message: 'คัดลอกแล้ว' });
  }

  return (
    <Wrapper>
      <Header title="API Tokens สำหรับ Hardware"
        subtitle="ออก Bearer token ให้ RFID reader / ESP32 ใช้ POST /api/access/log โดยไม่ต้องมี session"
        actions={
          <Btn variant="primary" onClick={() => setShowNew(true)} disabled={busy || loading}>+ ออก token ใหม่</Btn>
        } />

      <Card style={{ background: C.warningSoft || '#fff7e0', borderLeft: `4px solid ${C.warning || '#d97706'}` }}>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: C.ink2 || C.ink }}>
          🔐 <b>ความปลอดภัย:</b> token ใหม่จะแสดงเพียงครั้งเดียวเท่านั้น — ระบบเก็บแค่ SHA-256 hash<br/>
          📡 <b>Hardware ใช้:</b> ส่ง <code>Authorization: Bearer &lt;token&gt;</code> ทุก request<br/>
          🔄 <b>หมุน token:</b> ลบอันเก่า → สร้างใหม่ → อัปเดตใน firmware
        </div>
      </Card>

      <Card>
        {loadError ? (
          <div style={{
            padding: 12,
            marginBottom: 12,
            borderRadius: 8,
            background: C.dangerSoft || '#fff5f4',
            color: C.dangerInk || C.danger || '#9f1d1d',
            border: `1px solid ${C.danger || '#f3c2bf'}`,
            fontSize: 13,
            lineHeight: 1.5,
          }}>
            <b>โหลด API Tokens ไม่สำเร็จ</b>: {loadError}
            {' '}
            <button type="button" onClick={load} style={{
              border: 0,
              padding: 0,
              background: 'transparent',
              color: 'inherit',
              textDecoration: 'underline',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontWeight: 600,
            }}>ลองใหม่</button>
          </div>
        ) : null}
        {loading ? (
          <div role="status" style={{ padding: 24, textAlign: 'center', color: C.muted, fontSize: 13 }}>
            กำลังโหลด API Tokens...
          </div>
        ) : devices.length === 0 ? <EmptyState title="ยังไม่มี device — กดปุ่ม '+' ด้านบนเพื่อออก token แรก" /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: C.border, borderRadius: 8, overflow: 'hidden' }}>
            {devices.map((d) => (
              <div key={d.id} style={{
                background: C.bg, padding: '12px 16px', display: 'grid',
                gridTemplateColumns: '2fr 2fr auto auto', gap: 12, alignItems: 'center',
              }}>
                <div style={{ minWidth: 0 }}>
                  <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13, fontWeight: 600 }}>{d.device_id}</code>
                  {d.description && <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>{d.description}</div>}
                </div>
                <div style={{ color: C.muted, fontSize: 12 }}>
                  สร้างเมื่อ {formatAccessDeviceDate(d.created_at)}
                  {d.last_seen && <><br/>ใช้งานล่าสุด {formatAccessDeviceDate(d.last_seen, 'datetime')}</>}
                </div>
                <Pill color={d.enabled ? C.success : C.muted}>{d.enabled ? 'ใช้งาน' : 'ปิด'}</Pill>
                <Btn size="sm" variant="danger" disabled={deletingId === d.id || busy}
                  onClick={() => remove(d.id)}>
                  {deletingId === d.id ? 'กำลังลบ...' : 'ลบ'}
                </Btn>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal open={showNew} onClose={() => setShowNew(false)} title="ออก token ใหม่">
        <form onSubmit={create} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ fontSize: 12, color: C.muted }}>
            Device ID
            <input value={form.deviceId} onChange={(e) => setForm({ ...form, deviceId: e.target.value })}
              placeholder="rfid-floor-3" required maxLength={64}
              style={{
                width: '100%', marginTop: 4, padding: '8px 12px', borderRadius: 6,
                border: '1px solid ' + C.border, background: C.bg, color: C.ink,
                fontSize: 13.5, fontFamily: 'inherit',
              }} />
          </label>
          <label style={{ fontSize: 12, color: C.muted }}>
            คำอธิบาย (optional)
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="เครื่องอ่านบัตรชั้น 3 ใกล้บันได" maxLength={200}
              style={{
                width: '100%', marginTop: 4, padding: '8px 12px', borderRadius: 6,
                border: '1px solid ' + C.border, background: C.bg, color: C.ink,
                fontSize: 13.5, fontFamily: 'inherit',
              }} />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn type="submit" variant="primary" disabled={busy} style={{ flex: 1 }}>
              {busy ? 'กำลังสร้าง...' : 'สร้าง'}
            </Btn>
            <Btn type="button" variant="ghost" onClick={() => setShowNew(false)}>ยกเลิก</Btn>
          </div>
        </form>
      </Modal>

      <Modal open={!!revealed} onClose={() => setRevealed(null)} title="🔑 Token ใหม่ — แสดงเพียงครั้งเดียว">
        {revealed && (
          <div>
            <div style={{ color: C.muted, fontSize: 13, marginBottom: 8 }}>
              Device: <code>{revealed.deviceId}</code>
            </div>
            <code style={{
              display: 'block', wordBreak: 'break-all',
              fontFamily: 'JetBrains Mono, monospace', fontSize: 12.5,
              padding: 12, background: C.bgSoft || C.warningSoft,
              borderRadius: 8, border: '1px solid ' + C.border,
              userSelect: 'all',
            }}>{revealed.token}</code>
            <div style={{ marginTop: 8, padding: 10, background: C.dangerSoft, border: '1px solid #f3c2bf', borderRadius: 8, color: C.dangerInk, fontSize: 12.5 }}>
              ⚠️ บันทึก token นี้ไว้ที่ปลอดภัยทันที — ระบบจะไม่แสดงอีกหลังปิดหน้านี้
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <Btn variant="primary" onClick={copyToken} style={{ flex: 1 }}>📋 คัดลอก</Btn>
              <Btn variant="ghost" onClick={() => setRevealed(null)}>ปิด</Btn>
            </div>
          </div>
        )}
      </Modal>
    </Wrapper>
  );
}

// Gate the standalone deep-link (/admin#access-devices) on the accessControl
// flag, same as PageAccess. When embedded as a tab it already inherits
// PageAccess's gate, but the direct hash route rendered this raw — reachable
// even with access control turned off, contradicting the feature flag.
window.PageAccessDevicesInner = PageAccessDevices;
window.PageAccessDevices = window.FeatureGate
  ? function PageAccessDevicesGated(props) {
      return React.createElement(window.FeatureGate,
        { flag: 'accessControl', label: 'อุปกรณ์เข้า-ออก' },
        React.createElement(PageAccessDevices, props));
    }
  : PageAccessDevices;
