// === admin/page-production-readiness.jsx ==================================
// "Is this deployment ready for real users?" checklist. Calls
// GET /api/admin/production-readiness (owner-only) and renders the result
// as a grouped, severity-colored list with explicit hints for each gap.
//
// Different from /admin#health — that's "is the system currently working".
// This is "is the system CONFIGURED for live operations":
//   - Building info filled in (not still default 'บ้านกาญจน์ เรสซิเดนซ์')
//   - PromptPay target set (else bills have no QR)
//   - At least one non-default-username owner
//   - Critical secrets present (SESSION_SECRET, LINE creds)
//   - meterIot.mode != 'simulator' (else fake readings overwrite real)
//   - autoBackup wired to R2 (else backups die on redeploy)
//
// Owner-only at the API level — the UI also gates so non-owner roles see
// a friendly placeholder instead of a 401-shaped empty state.
// ===========================================================================

(function () {
const { useState, useEffect, useMemo } = React;

function PageProductionReadiness({ setToast }) {
  const C = window.ADMIN_C || {};
  const Card = window.Card;
  const Btn = window.Btn;
  const PageContainer = window.PageContainer;
  const PageHeader = window.PageHeader;

  // CRITICAL: every hook (useState / useEffect / useMemo) MUST come BEFORE
  // any early `return`. React's Rules of Hooks require an identical hook
  // order across every render — a guard like `if (!Card) return <stub>`
  // before useState would skip 3+ hooks on the first render and throw
  // Minified React error #310 the moment the globals load. Same pattern was
  // shipped in page-features.jsx and broke /admin#features. The defensive
  // missing-globals guard now lives BELOW the hooks (line ~85).
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/admin/production-readiness', { credentials: 'same-origin' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw Object.assign(new Error(d.error || `HTTP ${r.status}`), { status: r.status, code: d.code });
      }
      setData(d);
    } catch (err) {
      setError(err);
      // Surface 401/403 with the central toast helper so the message is
      // consistent with the rest of the admin pages — owners-only, others
      // see a clean "ต้องเป็น owner" instead of raw HTTP 403.
      if (window.toastError) {
        window.toastError(setToast, err, { action: 'โหลดสถานะความพร้อม' });
      }
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  // Severity → visual mapping. Matches the kind aliases the toast component
  // accepts so the same color words are used throughout the admin shell.
  const severityMap = {
    fail: { color: C.danger || '#b54639', soft: C.dangerSoft || '#f9e7e3', icon: '🔴', label: 'ต้องแก้' },
    warn: { color: C.warning || '#c98a2b', soft: C.warningSoft || '#fbf1de', icon: '🟡', label: 'ควรปรับ' },
    ok:   { color: C.success || '#2e9b6a', soft: C.successSoft || '#e6f4ec', icon: '✅', label: 'พร้อม' },
  };

  // Group checks by status so the operator sees the urgent items first.
  // Within each status, preserve server-side order (which is roughly:
  // env → building → secrets → flags → data volume).
  const grouped = useMemo(() => {
    if (!data || !Array.isArray(data.checks)) return { fail: [], warn: [], ok: [] };
    const out = { fail: [], warn: [], ok: [] };
    for (const c of data.checks) {
      (out[c.status] || out.ok).push(c);
    }
    return out;
  }, [data]);

  // ===== Early returns are SAFE below this line — every hook above has
  // already been called in the same order on every render path. =====

  // Defensive guard mirroring page-payments.jsx pattern — if any of the
  // foundational components didn't load (CDN slow, blocked script), render
  // a graceful placeholder instead of an "Element type is invalid" stack.
  if (!C || !Card || !Btn || !PageContainer || !PageHeader) {
    return React.createElement('div', {
      style: { padding: 32, fontSize: 14, color: '#5b4f40', fontFamily: 'inherit' },
    }, 'กำลังเตรียมหน้าตรวจความพร้อม...');
  }

  // Permission failure → friendly explanation instead of a generic error.
  if (error && error.status === 403) {
    return React.createElement(PageContainer, null,
      React.createElement(PageHeader, {
        title: 'ตรวจความพร้อม Production',
        subtitle: 'หน้านี้สำหรับ owner เท่านั้น',
      }),
      React.createElement(Card, { style: { padding: 24, textAlign: 'center', color: C.muted } },
        '🔐 หน้านี้แสดงข้อมูล config ที่อ่อนไหว — ต้องเป็น owner ถึงดูได้'
      )
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="ตรวจความพร้อม Production"
        subtitle="ตรวจว่าระบบตั้งค่าครบสำหรับใช้งานจริง — ไม่ใช่แค่ทำงานได้ในเชิงเทคนิค"
        actions={
          <Btn variant="secondary" onClick={load} disabled={loading} icon="↻">
            {loading ? 'กำลังโหลด…' : 'รีเฟรช'}
          </Btn>
        }
      />

      {loading && !data && (
        <Card style={{ padding: 40, textAlign: 'center', color: C.muted }}>
          กำลังตรวจสอบ…
        </Card>
      )}

      {data && (
        <>
          <ReadinessSummary data={data} severityMap={severityMap} C={C} Card={Card} />
          {grouped.fail.length > 0 && (
            <CheckGroup
              title={`ต้องแก้ก่อนเปิดใช้งานจริง (${grouped.fail.length})`}
              checks={grouped.fail}
              severityMap={severityMap}
              C={C} Card={Card} />
          )}
          {grouped.warn.length > 0 && (
            <CheckGroup
              title={`ควรปรับปรุง (${grouped.warn.length})`}
              checks={grouped.warn}
              severityMap={severityMap}
              C={C} Card={Card} />
          )}
          {grouped.ok.length > 0 && (
            <CheckGroup
              title={`พร้อมแล้ว (${grouped.ok.length})`}
              checks={grouped.ok}
              severityMap={severityMap}
              C={C} Card={Card}
              defaultCollapsed={grouped.fail.length > 0 || grouped.warn.length > 0} />
          )}
        </>
      )}

      {error && error.status !== 403 && (
        <Card style={{ padding: 16, color: C.danger, background: C.dangerSoft || '#f9e7e3' }}>
          โหลดไม่สำเร็จ: {error.message}
        </Card>
      )}
    </PageContainer>
  );
}

// ---------- Summary card -------------------------------------------------
function ReadinessSummary({ data, severityMap, C, Card }) {
  const s = data.summary || {};
  // The "ready" verdict comes from the server: zero fails AND warnings ≤ 2.
  // Don't recompute client-side — keep it as one source of truth so future
  // tightening of the criteria propagates without UI changes.
  const ready = !!data.ready;
  const headline = ready
    ? '✅ พร้อมเปิดใช้งานจริง'
    : (s.fail > 0
        ? `🔴 ยังมี ${s.fail} จุดที่ต้องแก้ก่อนเปิดใช้งาน`
        : `🟡 มี ${s.warn} จุดที่ควรปรับ`);

  return (
    <Card style={{
      padding: 20,
      background: ready
        ? (C.successSoft || '#e6f4ec')
        : (s.fail > 0 ? (C.dangerSoft || '#f9e7e3') : (C.warningSoft || '#fbf1de')),
      borderLeft: `4px solid ${ready ? severityMap.ok.color : (s.fail > 0 ? severityMap.fail.color : severityMap.warn.color)}`,
      marginBottom: 16,
    }}>
      <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
        {headline}
      </div>
      <div style={{ fontSize: 13.5, color: C.ink2, lineHeight: 1.6, marginBottom: 12 }}>
        NODE_ENV = <code style={{ background: 'rgba(0,0,0,0.06)', padding: '1px 6px', borderRadius: 3 }}>{data.nodeEnv || 'unknown'}</code>
        {data.checkedAt && (
          <span style={{ marginLeft: 12, color: C.muted, fontSize: 12 }}>
            ตรวจเมื่อ {new Date(data.checkedAt).toLocaleString('th-TH')}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 13 }}>
        <Badge color={severityMap.fail.color} bg="rgba(255,255,255,0.6)">
          🔴 ต้องแก้: {s.fail || 0}
        </Badge>
        <Badge color={severityMap.warn.color} bg="rgba(255,255,255,0.6)">
          🟡 ควรปรับ: {s.warn || 0}
        </Badge>
        <Badge color={severityMap.ok.color} bg="rgba(255,255,255,0.6)">
          ✅ พร้อม: {s.ok || 0}
        </Badge>
        <Badge color={C.muted || '#5b4f40'} bg="rgba(255,255,255,0.6)">
          รวม: {s.total || 0} รายการ
        </Badge>
      </div>
    </Card>
  );
}

function Badge({ color, bg, children }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '4px 12px',
      borderRadius: 999,
      background: bg,
      color: color,
      fontWeight: 600,
      fontSize: 12.5,
    }}>{children}</span>
  );
}

// ---------- Check group --------------------------------------------------
// Collapsible group of checks, sharing a single style. The "OK" group
// auto-collapses when there are still things to fix — operator's eye is
// drawn to the unfinished work first.
function CheckGroup({ title, checks, severityMap, C, Card, defaultCollapsed = false }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  return (
    <Card style={{ padding: 0, marginBottom: 12, overflow: 'hidden' }}>
      <button
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        style={{
          width: '100%',
          padding: '14px 18px',
          background: C.surfaceAlt || C.bgSoft || '#faf6ee',
          border: 'none',
          borderBottom: collapsed ? 'none' : `1px solid ${C.border}`,
          fontFamily: 'inherit', fontSize: 14, fontWeight: 600, textAlign: 'left',
          cursor: 'pointer',
          color: C.ink,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
        <span>{title}</span>
        <span style={{ fontSize: 12, color: C.muted, transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform .15s' }}>›</span>
      </button>
      {!collapsed && (
        <div>
          {checks.map((c, i) => (
            <CheckRow key={c.id || i} check={c} severityMap={severityMap} C={C}
              isLast={i === checks.length - 1} />
          ))}
        </div>
      )}
    </Card>
  );
}

function CheckRow({ check, severityMap, C, isLast }) {
  const s = severityMap[check.status] || severityMap.ok;
  return (
    <div style={{
      padding: '14px 18px',
      borderBottom: isLast ? 'none' : `1px solid ${C.borderSoft || C.border}`,
      display: 'grid',
      gridTemplateColumns: 'auto 1fr',
      gap: 14,
      alignItems: 'flex-start',
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: '50%',
        background: s.soft, color: s.color,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 14, flexShrink: 0,
      }}>{s.icon}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.ink, marginBottom: 2 }}>
          {check.label}
          <code style={{
            marginLeft: 8, fontSize: 10.5, color: C.muted, fontWeight: 400,
            background: 'rgba(0,0,0,0.04)', padding: '1px 6px', borderRadius: 3,
            fontFamily: 'JetBrains Mono, monospace',
          }}>{check.id}</code>
        </div>
        <div style={{ fontSize: 13, color: C.ink2, lineHeight: 1.6, wordBreak: 'break-word' }}>
          {check.message}
        </div>
        {check.hint && (
          <div style={{
            marginTop: 6,
            fontSize: 12.5,
            color: s.color,
            background: s.soft,
            padding: '6px 10px',
            borderRadius: 6,
            lineHeight: 1.5,
          }}>
            💡 {check.hint}
          </div>
        )}
      </div>
    </div>
  );
}

window.PageProductionReadiness = PageProductionReadiness;
})();
