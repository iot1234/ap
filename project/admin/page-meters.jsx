// === admin/page-meters.jsx =================================================
// Meter readings: pick a room, see latest reading + chart, record a new
// reading. The chart is a simple inline SVG (no extra libs).
// ===========================================================================

(function () {
const { useState, useEffect, useMemo, useRef } = React;

function PageMeters({ rooms, setToast }) {
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
  const nowForMonth = new Date();
  const currentMonth = `${nowForMonth.getFullYear()}-${String(nowForMonth.getMonth() + 1).padStart(2, '0')}`;
  const [period, setPeriod] = useState(currentMonth);

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
      setToast && setToast({
        kind: 'warning',
        message: { title: 'ยังไม่ได้เลือกห้อง', description: 'กรุณาเลือกห้องที่จะบันทึกค่ามิเตอร์ก่อน' },
      });
      return;
    }
    if (reading === '') {
      setToast && setToast({
        kind: 'warning',
        message: { title: 'กรุณากรอกค่ามิเตอร์', description: 'ค่ามิเตอร์ต้องเป็นตัวเลข ≥ 0' },
      });
      return;
    }
    // No more silent CSRF bypass via raw fetch — if hooks.jsx didn't load,
    // alert the user instead of POSTing without a token (which would 403).
    if (!window.apiCall) {
      setToast && setToast({
        kind: 'danger',
        message: { title: 'ระบบยังไม่พร้อม', description: 'สคริปต์โหลดไม่ครบ — กรุณารีเฟรชหน้า' },
      });
      return;
    }
    // Pre-flight rollback check: cheap client-side guard BEFORE POSTing.
    // The server's 3σ anomaly detection runs AFTER insert and only emits a
    // warning toast — by then the bad reading is already in the table and
    // will silently corrupt the next bill (rooms.elecUnits / waterUnits
    // gets jsonb_set'd from the delta in services/meter.js). Catch the
    // most common typo ("999" instead of "9999", missing decimal) up
    // front by comparing against the most-recent reading we already have
    // loaded; force admin to confirm before posting.
    const newVal = Number(reading);
    const latest = list && list.length ? Number(list[list.length - 1].reading) : null;
    // When admin confirms a decreasing reading, the server still re-checks
    // against ITS latest value (authoritative, period-aware) and refuses
    // unless we pass allowRollback — the confirm here doubles as that
    // explicit consent, which the server audit-logs.
    let allowRollback = false;
    if (latest != null && Number.isFinite(latest) && newVal < latest) {
      const t = type === 'water' ? 'ค่าน้ำ' : 'ค่าไฟ';
      const ok = window.confirm(
        `⚠ ${t}ห้อง ${roomId} กำลังจะลดลง — ผิดปกติ\n\n` +
        `ค่าล่าสุด:  ${latest.toFixed(2)} หน่วย\n` +
        `ค่าใหม่:    ${newVal.toFixed(2)} หน่วย\n` +
        `ลดลง:      ${(latest - newVal).toFixed(2)} หน่วย\n\n` +
        `📌 มิเตอร์ปกติเดินขึ้นเสมอ — ค่าลดลงมักเกิดจาก:\n` +
        `   1) พิมพ์ผิด (เช่น พิมพ์ 999 แทน 9999)\n` +
        `   2) มิเตอร์ถูก reset/เปลี่ยนตัวใหม่ — ในกรณีนี้ควรแจ้ง admin ก่อนบันทึก\n\n` +
        `ยืนยันบันทึกตามนี้ใช่หรือไม่? (ระบบจะบันทึกการยืนยันนี้ใน audit log)`
      );
      if (!ok) return;
      allowRollback = true;
    }
    // Detect "huge jump" — new value > 5× the last delta (cheap heuristic;
    // server's 3σ is more accurate but only fires after save). Helps catch
    // an extra zero ("99999" instead of "9999").
    if (latest != null && newVal > latest && list.length >= 2) {
      const prevPrev = Number(list[list.length - 2].reading);
      const lastDelta = latest - prevPrev;
      const newDelta = newVal - latest;
      if (lastDelta > 0 && newDelta > lastDelta * 10 && newDelta > 100) {
        const t = type === 'water' ? 'ค่าน้ำ' : 'ค่าไฟ';
        const ok = window.confirm(
          `⚠ ${t}ห้อง ${roomId} กระโดดขึ้นเยอะกว่าปกติมาก\n\n` +
          `ค่าล่าสุด:  ${latest.toFixed(2)}\n` +
          `ค่าใหม่:    ${newVal.toFixed(2)}\n` +
          `Delta:     +${newDelta.toFixed(2)} (ปกติประมาณ +${lastDelta.toFixed(2)})\n\n` +
          `📌 อาจเป็นการพิมพ์ผิด (เกินศูนย์ 1 ตัว) — ตรวจเลขอีกครั้งก่อนบันทึก\n\n` +
          `ยืนยันบันทึกใช่หรือไม่?`
        );
        if (!ok) return;
      }
    }
    try {
      const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
      let d;
      try {
        d = await apiCall(`/api/meters/${encodeURIComponent(roomId)}/readings`, {
          method: 'POST',
          body: JSON.stringify({ meterType: type, reading: newVal, source: 'manual', period, allowRollback }),
        });
      } catch (errFirst) {
        // Server-side rollback guard fired (its "latest" is period-aware and
        // can differ from the list rendered here). Give the admin one
        // explicit confirm with the SERVER's numbers, then retry with
        // allowRollback so a real meter reset can still be recorded.
        if (errFirst && errFirst.code === 'METER_ROLLBACK' && !allowRollback) {
          const t = type === 'water' ? 'ค่าน้ำ' : 'ค่าไฟ';
          const last = Number((errFirst.raw && errFirst.raw.lastReading) ?? errFirst.lastReading);
          const ok = window.confirm(
            `⚠ ระบบพบว่า${t}ห้อง ${roomId} ลดลงจากเลขล่าสุดในระบบ\n\n` +
            `เลขล่าสุดในระบบ: ${Number.isFinite(last) ? last.toFixed(2) : '-'}\n` +
            `เลขที่กรอก:        ${newVal.toFixed(2)}\n\n` +
            `ถ้ามิเตอร์ถูกเปลี่ยน/รีเซ็ตจริง กดตกลงเพื่อยืนยันบันทึก (ระบบจะบันทึก audit)\n` +
            `ถ้าเป็นการพิมพ์ผิด กดยกเลิกแล้วแก้เลขก่อน`
          );
          if (!ok) return;
          d = await apiCall(`/api/meters/${encodeURIComponent(roomId)}/readings`, {
            method: 'POST',
            body: JSON.stringify({ meterType: type, reading: newVal, source: 'manual', period, allowRollback: true }),
          });
        } else {
          throw errFirst;
        }
      }
      setReading('');
      // Anomaly is NOT a save failure — it's a successful save with a
      // warning attached. Use kind:'warning' so the visual matches.
      if (d.anomaly) {
        const a = d.anomaly;
        const t = type === 'water' ? 'ค่าน้ำ' : 'ค่าไฟ';
        // detectAnomaly returns different shapes per kind: only 'sigma' has z,
        // only 'sigma'/'zero-variance' have mean. Format per-kind so the toast
        // never shows "z=NaN · เฉลี่ย NaN" for jump / zero-variance anomalies.
        const num = (v, dgt = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(dgt) : '—');
        let title, description;
        if (a.kind === 'rollback') {
          title = `บันทึกแล้ว — แต่${t}ลดลงผิดปกติ`;
          description = `ค่าลดลง ${num(Math.abs(Number(a.last)))} หน่วย — อาจเป็นการ reset มิเตอร์หรือพิมพ์ผิด ตรวจสอบก่อนออกบิล`;
        } else if (a.kind === 'jump') {
          title = `บันทึกแล้ว — แต่${t}พุ่งสูงผิดปกติ`;
          description = `รอบนี้ ${num(a.last)} หน่วย ≈ ${num(a.ratio, 1)}× ของรอบก่อน (${num(a.prev)} หน่วย) — ตรวจสอบการพิมพ์เลข`;
        } else if (a.kind === 'zero-variance') {
          title = `บันทึกแล้ว — แต่${t}เปลี่ยนกะทันหัน`;
          description = `เคยใช้คงที่ ${num(a.mean)} หน่วย แต่รอบนี้ ${num(a.last)} หน่วย — ตรวจสอบก่อนออกบิล`;
        } else {
          title = `บันทึกแล้ว — แต่${t}ผิดปกติ (>${num(a.threshold, 0)}σ)`;
          description = `z=${num(a.z)} · ค่าล่าสุด ${num(a.last)} · เฉลี่ย ${num(a.mean)}`;
        }
        setToast && setToast({ kind: 'warning', message: { title, description } });
      } else {
        setToast && setToast({ kind: 'success', message: `บันทึก${type === 'water' ? 'ค่าน้ำ' : 'ค่าไฟ'}ห้อง ${roomId} รอบ ${period} แล้ว` });
      }
      load();
    } catch (e2) {
      window.toastError(setToast, e2, { action: 'บันทึกค่ามิเตอร์' });
    }
  }

  return (
    <PageContainer>
      <PageHeader title="มิเตอร์" subtitle="บันทึกค่าน้ำ/ไฟแยกตามรอบเดือน · Billing จะใช้รอบเดือนที่เลือก ไม่ใช้ค่าจากหน้าห้องพัก" />
      <Card>
        <div style={{
          padding: 10, marginBottom: 12, borderRadius: 8,
          background: C.infoSoft || '#eef6ff',
          border: `1px solid ${(C.info || '#3b82f6')}33`,
          color: C.infoInk || C.ink2,
          fontSize: 12.5, lineHeight: 1.55,
        }}>
          กรอกเลขมิเตอร์ของรอบบิลที่นี่ เช่น รอบ 2026-05 ให้กรอกเลขท้ายเดือนพฤษภาคม.
          หน้าห้องพักใช้ตั้งค่าโหมด/อัตราพิเศษเท่านั้น ไม่ใช่จุดกรอกหน่วยรายเดือน.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12, marginBottom: 16 }}>
          <label style={lblStyle(C)}>
            รอบเดือน
            <input type="month" value={period} onChange={(e) => setPeriod(e.target.value || currentMonth)} style={selStyle(C)} />
          </label>
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
              ค่ามิเตอร์รอบนี้
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
                  <span>
                    {new Date(x.reading_at).toLocaleString('th-TH')}
                    <span style={{ color: C.muted, marginLeft: 8 }}>
                      ({x.period || 'latest'} · {x.source})
                    </span>
                  </span>
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
