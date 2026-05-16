// === admin/page-security-events.jsx =========================================
// Owner-facing viewer of:
//   - Failed login attempts (admin + tenant)
//   - Currently locked-out accounts
// Lets the owner spot brute-force activity and unlock if needed.
//
// Backed by GET /api/admin/security-events
// ===========================================================================

const { useState, useEffect, useMemo } = React;

function PageSecurityEvents({ setToast }) {
  const C = window.ADMIN_C;
  const { Card, Pill, PageContainer, PageHeader, EmptyState, SectionHeading } = window;
  const [data, setData] = useState({ failed: [], lockouts: [] });
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try {
      const r = await fetch('/api/admin/security-events?limit=200', { credentials: 'same-origin' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'load failed');
      setData({ failed: d.failed || [], lockouts: d.lockouts || [] });
    } catch (e) {
      setToast && setToast({ kind: 'error', message: e.message });
    } finally { setBusy(false); }
  }
  useEffect(() => { load(); }, []);

  // Group failed attempts by user_id + ip to spot patterns
  const groups = useMemo(() => {
    const map = new Map();
    for (const ev of data.failed) {
      const key = `${ev.user_id || '(unknown)'}|${ev.ip || '(noip)'}`;
      if (!map.has(key)) {
        map.set(key, { userId: ev.user_id, ip: ev.ip, count: 0, last: null, ua: ev.ua });
      }
      const g = map.get(key);
      g.count += 1;
      if (!g.last || new Date(ev.created_at) > new Date(g.last)) g.last = ev.created_at;
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [data.failed]);

  return (
    <PageContainer>
      <PageHeader title="เหตุการณ์ความปลอดภัย"
        subtitle="ความพยายามเข้าระบบที่ล้มเหลว + บัญชีที่ถูกล็อก · ตรวจหา brute-force"
        actions={
          <button onClick={load} disabled={busy} style={{
            padding: '8px 16px', borderRadius: 6, border: '1px solid ' + C.border,
            background: 'transparent', color: C.ink, cursor: busy ? 'wait' : 'pointer',
            fontFamily: 'inherit', fontSize: 13,
          }}>{busy ? '…' : '↻ รีเฟรช'}</button>
        } />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 16 }}>
        <Stat label="ความพยายามล้มเหลว (200 ล่าสุด)" value={data.failed.length} color={data.failed.length > 50 ? '#b94a48' : C.ink} />
        <Stat label="บัญชีที่กำลังล็อก" value={data.lockouts.length} color={data.lockouts.length > 0 ? '#b94a48' : '#2f8f5b'} />
        <Stat label="กลุ่ม IP/บัญชี ผิดซ้ำ" value={groups.filter((g) => g.count >= 3).length} color={groups.filter((g) => g.count >= 3).length > 0 ? '#c08a2a' : C.ink} />
      </div>

      {data.lockouts.length > 0 && (
        <Card>
          <SectionHeading title="🚫 บัญชีที่ถูกล็อกชั่วคราว" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: C.border, borderRadius: 8, overflow: 'hidden' }}>
            {data.lockouts.map((x) => {
              const minutesLeft = x.locked_until
                ? Math.max(0, Math.ceil((new Date(x.locked_until).getTime() - Date.now()) / 60_000)) : 0;
              return (
                <div key={x.principal} style={{
                  background: C.bg, padding: '10px 14px', display: 'grid',
                  gridTemplateColumns: '1fr auto auto', gap: 10, fontSize: 13.5,
                }}>
                  <div>
                    <code style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>{x.principal}</code>
                    <span style={{ color: C.muted, marginLeft: 8 }}>· {x.kind}</span>
                  </div>
                  <span style={{ color: C.muted, fontSize: 12 }}>fails: {x.fail_count}</span>
                  <Pill color="#b94a48">ปลดล็อกใน {minutesLeft} นาที</Pill>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <Card>
        <SectionHeading title="🔁 ผู้พยายามล้มเหลวซ้ำ" />
        {groups.length === 0 ? <EmptyState title="ไม่มีความพยายามที่ล้มเหลว" /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: C.border, borderRadius: 8, overflow: 'hidden', maxHeight: 360, overflowY: 'auto' }}>
            {groups.map((g, i) => (
              <div key={i} style={{
                background: C.bg, padding: '8px 14px', display: 'grid',
                gridTemplateColumns: '1fr 1fr auto auto', gap: 10, fontSize: 12.5, alignItems: 'center',
              }}>
                <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>{g.userId || '(unknown)'}</code>
                <span style={{ color: C.muted, fontSize: 11 }}>{g.ip || '(no ip)'}</span>
                <Pill color={g.count >= 5 ? '#b94a48' : (g.count >= 3 ? '#c08a2a' : C.muted)}>
                  ×{g.count}
                </Pill>
                <span style={{ color: C.muted, fontSize: 11 }}>{new Date(g.last).toLocaleString('th-TH')}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <SectionHeading title="📋 ทุกเหตุการณ์ (ล่าสุดก่อน)" />
        {data.failed.length === 0 ? <EmptyState title="ไม่มีเหตุการณ์" /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: C.border, borderRadius: 8, overflow: 'hidden', maxHeight: 480, overflowY: 'auto' }}>
            {data.failed.map((ev) => (
              <div key={ev.id} style={{
                background: C.bg, padding: '10px 14px',
                fontSize: 12,
              }}>
                {/* Header row: timestamp + action pill — wraps on narrow */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                  marginBottom: 4,
                }}>
                  <span style={{ color: C.muted }}>
                    {new Date(ev.created_at).toLocaleString('th-TH', { hour12: false })}
                  </span>
                  <Pill color={ev.action.includes('locked') ? 'danger' : 'warning'} size="sm">
                    {ev.action.replace('auth.', '').replace('tenant.', '')}
                  </Pill>
                </div>
                {/* User + IP row — wraps gracefully on mobile */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5,
                }}>
                  <code style={{ wordBreak: 'break-all' }}>{ev.user_id || '—'}</code>
                  <span style={{ color: C.muted, wordBreak: 'break-all', marginLeft: 'auto' }}>
                    {ev.ip || '—'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </PageContainer>
  );
}

function Stat({ label, value, color }) {
  const C = window.ADMIN_C;
  return (
    <div style={{ background: C.bg, border: '1px solid ' + C.border, borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: 'IBM Plex Sans Thai', fontSize: 22, fontWeight: 600, color }}>{value}</div>
    </div>
  );
}

window.PageSecurityEvents = PageSecurityEvents;
