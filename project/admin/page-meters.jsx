// === admin/page-meters.jsx =================================================
// Meter readings: pick a room, see latest reading + chart, record a new
// reading. The chart is a simple inline SVG (no extra libs).
// ===========================================================================

(function () {
const { useState, useEffect, useMemo, useRef } = React;

function PageMeters({ rooms, setToast }) {
  // Diagnostic: confirm the component mounted. See page-payments.jsx for context.
  React.useEffect(() => {
    console.log('[PageMeters] mounted');
    return () => console.log('[PageMeters] unmounted');
  }, []);

  // Guard every window global we depend on. If shared.jsx / ui.jsx / hooks.jsx
  // failed to load (CDN hiccup, slow mobile, blocked script), missing globals
  // would throw "Cannot read property X of undefined" inside render — which
  // ErrorBoundary catches but the user sees a generic error card. Render a
  // friendly "loading" stub instead so the page keeps polling and recovers
  // when the foundation scripts finish.
  const C = window.ADMIN_C;
  const Card = window.Card;
  const SectionHeading = window.SectionHeading;
  const Btn = window.Btn;
  const PageContainer = window.PageContainer;
  const PageHeader = window.PageHeader;
  const EmptyState = window.EmptyState;
  if (!C || !Card || !PageContainer || !PageHeader || !Btn || !EmptyState) {
    const missing = [
      !C && 'ADMIN_C', !Card && 'Card', !Btn && 'Btn',
      !PageContainer && 'PageContainer', !PageHeader && 'PageHeader', !EmptyState && 'EmptyState',
    ].filter(Boolean).join(', ');
    console.warn('[PageMeters] missing window globals:', missing);
    return React.createElement('div', {
      style: { padding: 32, fontSize: 14, color: '#5b4f40', fontFamily: 'inherit' },
    }, `กำลังเตรียมหน้ามิเตอร์... (รอ: ${missing})`);
  }

  const roomList = useMemo(() => {
    const r = rooms || {};
    return Object.values(r)
      .filter((x) => x && typeof x === 'object' && x.id)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }, [rooms]);
  const [roomId, setRoomId] = useState(roomList[0]?.id || '');
  const [type, setType] = useState('elec');
  const [list, setList] = useState([]);
  const [reading, setReading] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);

  // Track the in-flight load() so a rapid roomId/type switch can't pile up
  // overlapping fetches that resolve out of order and overwrite fresh state
  // with stale data.
  const abortRef = useRef(null);

  async function load() {
    if (!roomId) { setList([]); return; }
    if (abortRef.current) abortRef.current.abort();
    const req = makeAbortableRequest(15_000);
    abortRef.current = req;
    setLoading(true);
    setLoadError(null);
    try {
      const r = await fetch(
        `/api/meters/${encodeURIComponent(roomId)}/readings?type=${encodeURIComponent(type)}`,
        { credentials: 'same-origin', ...(req.signal ? { signal: req.signal } : {}) }
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        // 503 means the meterIot feature is OFF on the server. Don't surface
        // as an error — FeatureGate already shows the "feature off" placeholder
        // when it's off; if we're rendering the page at all the flag was
        // believed-on at gate time, so this is a transient race.
        if (r.status !== 503) {
          setLoadError(d.error || `HTTP ${r.status}`);
        }
        setList([]);
      } else {
        setList((d.readings || []).slice().reverse());
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setLoadError(err.message || 'network error');
        setList([]);
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
  }, [roomId, type]);

  // Initial roomId selection: when rooms hydrate after the page mounts, pick
  // the first one so the user doesn't have to.
  useEffect(() => {
    if (!roomId && roomList.length > 0) setRoomId(roomList[0].id);
  }, [roomList, roomId]);

  async function record(e) {
    e.preventDefault();
    if (!roomId) {
      setToast && setToast({ kind: 'error', message: 'กรุณาเลือกห้องก่อนบันทึก' });
      return;
    }
    if (!reading) return;
    // No more silent CSRF bypass via raw fetch — if hooks.jsx didn't load,
    // alert the user instead of POSTing without a token (which would 403).
    if (!window.apiFetch) {
      setToast && setToast({ kind: 'error', message: 'ระบบยังไม่พร้อม — กรุณารีเฟรชหน้า' });
      return;
    }
    try {
      const r = await window.apiFetch(`/api/meters/${encodeURIComponent(roomId)}/readings`, {
        method: 'POST',
        body: JSON.stringify({ meterType: type, reading: Number(reading), source: 'manual' }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setReading('');
      if (d.anomaly) {
        const a = d.anomaly;
        const msg = a.kind === 'rollback'
          ? `ค่ามิเตอร์ลดลง ${Number(a.last).toFixed(2)} หน่วย — โปรดตรวจสอบ`
          : `ค่าผิดปกติ z=${Number(a.z).toFixed(2)}`;
        setToast && setToast({ kind: 'error', message: msg });
      } else {
        setToast && setToast({ kind: 'success', message: 'บันทึกแล้ว' });
      }
      load();
    } catch (e2) {
      setToast && setToast({ kind: 'error', message: e2.message || 'บันทึกไม่สำเร็จ' });
    }
  }

  return (
    <PageContainer>
      <PageHeader title="มิเตอร์" subtitle="บันทึกค่าน้ำ/ไฟรายห้อง · ตรวจจับค่าผิดปกติ (3σ)" />
      <Card>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12, marginBottom: 16 }}>
          <label style={lblStyle(C)}>
            ห้อง
            <select value={roomId} onChange={(e) => setRoomId(e.target.value)} style={selStyle(C)}>
              {roomList.length === 0
                ? <option value="">— ไม่มีข้อมูลห้อง —</option>
                : roomList.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
            </select>
          </label>
          <label style={lblStyle(C)}>
            ประเภท
            <select value={type} onChange={(e) => setType(e.target.value)} style={selStyle(C)}>
              <option value="elec">ไฟฟ้า</option>
              <option value="water">น้ำ</option>
            </select>
          </label>
          <form onSubmit={record} style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
            <label style={{ ...lblStyle(C), flex: 1 }}>
              ค่ามิเตอร์ใหม่
              <input type="number" step="0.01" value={reading} onChange={(e) => setReading(e.target.value)} style={selStyle(C)} />
            </label>
            <Btn type="submit" variant="primary" disabled={!roomId}>บันทึก</Btn>
          </form>
        </div>

        {loadError && (
          <div style={{
            padding: 10, marginBottom: 12, borderRadius: 8,
            background: C.dangerSoft || '#fff5f4', color: C.danger || '#a23',
            fontSize: 13,
          }}>
            โหลดข้อมูลไม่สำเร็จ: {loadError}
            {' '}<button onClick={load} style={{
              border: 0, background: 'transparent', color: 'inherit',
              textDecoration: 'underline', cursor: 'pointer', fontFamily: 'inherit',
            }}>ลองใหม่</button>
          </div>
        )}

        {list.length >= 2 ? <SparkChart data={list.map((x) => Number(x.reading))} /> : null}

        {loading ? (
          <div style={{ padding: 24, textAlign: 'center', color: C.muted, fontSize: 13 }}>กำลังโหลด...</div>
        ) : list.length === 0 ? <EmptyState title="ยังไม่มีค่ามิเตอร์ห้องนี้" /> : (
          <div style={{ marginTop: 16 }}>
            <div style={{ color: C.muted, fontSize: 12.5, marginBottom: 8 }}>ประวัติ {list.length} รายการ</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: C.border, maxHeight: 360, overflow: 'auto' }}>
              {list.slice().reverse().map((x) => (
                <div key={x.id} style={{
                  background: C.bg, padding: '10px 14px', display: 'flex',
                  justifyContent: 'space-between', alignItems: 'center', fontSize: 13.5,
                }}>
                  <span>{new Date(x.reading_at).toLocaleString('th-TH')} <span style={{ color: C.muted, marginLeft: 8 }}>({x.source})</span></span>
                  <strong>{Number(x.reading).toLocaleString('th-TH', { minimumFractionDigits: 2 })}</strong>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
    </PageContainer>
  );
}

function SparkChart({ data }) {
  const C = window.ADMIN_C || {};
  const W = 560, H = 120, P = 8;
  // Use a fold instead of Math.min(...data) — spreading a large array into
  // function args trips a stack-overflow on Chromium when data.length grows
  // past a few tens of thousands, freezing the renderer. We never expect
  // > 200 readings (server cap), but guard anyway because if a future code
  // path widens the cap, the freeze would only show up in production.
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const span = max - min || 1;
  const denom = data.length > 1 ? (data.length - 1) : 1;
  const pts = data.map((v, i) => {
    const x = P + ((W - 2 * P) * i) / denom;
    const y = H - P - ((Number(v) - min) / span) * (H - 2 * P);
    return `${x},${y}`;
  }).join(' ');
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ background: C.bgSoft || '#f5efe3', borderRadius: 8 }}>
      <polyline points={pts} fill="none" stroke={C.accent || '#c46a3e'} strokeWidth="2" />
      {data.map((v, i) => {
        const x = P + ((W - 2 * P) * i) / (data.length - 1);
        const y = H - P - ((v - min) / span) * (H - 2 * P);
        return <circle key={i} cx={x} cy={y} r="2.5" fill={C.accent || '#c46a3e'} />;
      })}
    </svg>
  );
}

function lblStyle(C) { return { fontSize: 12.5, color: C.muted, display: 'flex', flexDirection: 'column' }; }
function selStyle(C) {
  return {
    marginTop: 4, padding: '8px 12px', borderRadius: 6, border: '1px solid ' + C.border,
    background: C.bg, color: C.ink, fontSize: 13.5, fontFamily: 'inherit',
  };
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

// Wrap with FeatureGate so the page renders a friendly "feature is off"
// placeholder when admin disables `meterIot`, instead of letting every
// /api/meters/... call return 503 and stack error toasts.
window.PageMeters = window.FeatureGate
  ? function PageMetersGated(props) {
      return React.createElement(window.FeatureGate,
        { flag: 'meterIot', label: 'มิเตอร์' },
        React.createElement(PageMeters, props));
    }
  : PageMeters;
})();
