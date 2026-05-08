// === admin/page-meters.jsx =================================================
// Meter readings: pick a room, see latest reading + chart, record a new
// reading. The chart is a simple inline SVG (no extra libs).
// ===========================================================================

const { useState, useEffect, useMemo } = React;

function PageMeters({ rooms, setToast }) {
  const C = window.ADMIN_C;
  const { Card, SectionHeading, Btn, PageContainer, PageHeader, EmptyState } = window;
  const roomList = useMemo(() => Object.values(rooms || {}).sort((a, b) => String(a.id).localeCompare(String(b.id))), [rooms]);
  const [roomId, setRoomId] = useState(roomList[0]?.id || '');
  const [type, setType] = useState('elec');
  const [list, setList] = useState([]);
  const [reading, setReading] = useState('');

  async function load() {
    if (!roomId) return;
    try {
      const r = await fetch(`/api/meters/${encodeURIComponent(roomId)}/readings?type=${type}`, { credentials: 'same-origin' });
      const d = await r.json();
      if (r.ok) setList((d.readings || []).slice().reverse());
    } catch {}
  }
  useEffect(() => { load(); }, [roomId, type]);

  async function record(e) {
    e.preventDefault();
    if (!reading) return;
    try {
      // Must use apiFetch — POST goes through csrfGuard server-side, raw
      // fetch was 403'ing silently and the meter reading never landed.
      const apiFetch = window.apiFetch
        || ((u, o) => fetch(u, { credentials: 'same-origin', ...o }));
      const r = await apiFetch(`/api/meters/${encodeURIComponent(roomId)}/readings`, {
        method: 'POST',
        body: JSON.stringify({ meterType: type, reading: Number(reading), source: 'manual' }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setReading('');
      if (d.anomaly) setToast && setToast({ kind: 'error', message:`ค่าผิดปกติ z=${d.anomaly.z.toFixed(2)}` });
      else setToast && setToast({ kind: 'success', message:'บันทึกแล้ว' });
      load();
    } catch (e2) { setToast && setToast({ kind: 'error', message:e2.message }); }
  }

  return (
    <PageContainer>
      <PageHeader title="มิเตอร์" subtitle="บันทึกค่าน้ำ/ไฟรายห้อง · ตรวจจับค่าผิดปกติ (3σ)" />
      <Card>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12, marginBottom: 16 }}>
          <label style={lblStyle(C)}>
            ห้อง
            <select value={roomId} onChange={(e) => setRoomId(e.target.value)} style={selStyle(C)}>
              {roomList.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
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
            <Btn type="submit" variant="primary">บันทึก</Btn>
          </form>
        </div>

        {list.length >= 2 ? <SparkChart data={list.map((x) => Number(x.reading))} /> : null}

        {list.length === 0 ? <EmptyState title="ยังไม่มีค่ามิเตอร์ห้องนี้" /> : (
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
  const C = window.ADMIN_C;
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
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ background: C.bgSoft, borderRadius: 8 }}>
      <polyline points={pts} fill="none" stroke={C.accent} strokeWidth="2" />
      {data.map((v, i) => {
        const x = P + ((W - 2 * P) * i) / (data.length - 1);
        const y = H - P - ((v - min) / span) * (H - 2 * P);
        return <circle key={i} cx={x} cy={y} r="2.5" fill={C.accent} />;
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
