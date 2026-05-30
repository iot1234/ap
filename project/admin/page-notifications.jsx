// === admin/page-notifications.jsx ==========================================
// Read-only viewer of notifications_log — every LINE/email/SMS dispatch.
// Useful for verifying delivery + debugging routing fall-through.
// ===========================================================================

const { useState, useEffect } = React;

function PageNotifications() {
  const C = window.ADMIN_C;
  const { Card, Pill, StatusBadge, PageContainer, PageHeader, EmptyState } = window;
  const [list, setList] = useState([]);
  const [filter, setFilter] = useState('');
  const [loadErr, setLoadErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/notifications/log?limit=200', { credentials: 'same-origin' });
        const d = await r.json().catch(() => ({}));
        if (r.ok) { setList(d.logs || []); setLoadErr(''); }
        else setLoadErr(d.error || ('โหลดไม่สำเร็จ (HTTP ' + r.status + ')'));
      } catch {
        setLoadErr('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
      }
    })();
  }, []);

  const shown = filter ? list.filter((x) => x.channel === filter) : list;

  return (
    <PageContainer>
      <PageHeader title="บันทึกการแจ้งเตือน"
        subtitle="ดูประวัติการส่งทุก channel — LINE, อีเมล, SMS"
        actions={
          <select value={filter} onChange={(e) => setFilter(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid ' + C.border, background: C.bg, color: C.ink }}>
            <option value="">ทั้งหมด</option>
            <option value="line">LINE</option>
            <option value="email">อีเมล</option>
            <option value="sms">SMS</option>
            <option value="none">ไม่ส่ง (no channel)</option>
          </select>
        } />
      <Card>
        {shown.length === 0 ? (
          <EmptyState icon={loadErr ? '⚠️' : '📭'}
            title={loadErr ? 'โหลดบันทึกไม่สำเร็จ' : 'ยังไม่มีบันทึก'}
            description={loadErr || undefined} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: C.border, maxHeight: 600, overflow: 'auto' }}>
            {shown.map((x) => (
              <div key={x.id} className="notif-row" style={{
                background: C.bg, padding: '12px 14px',
                fontSize: 13.5,
              }}>
                {/* Top row — status pill + meta (always one line on
                    desktop, stacks under message on phones via CSS). */}
                <div className="notif-meta" style={{
                  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                  marginBottom: 4,
                }}>
                  <span style={{ color: C.muted, fontSize: 12 }}>{new Date(x.created_at).toLocaleString('th-TH')}</span>
                  <StatusBadge status={x.status} size="sm" />
                  <span style={{ color: C.muted, fontSize: 12 }}>· {x.channel}</span>
                  <span style={{ color: C.muted, fontSize: 12, marginLeft: 'auto' }}>{x.recipient}</span>
                </div>
                <div style={{ wordBreak: 'break-word' }}>{x.subject || x.body?.slice(0, 80)}</div>
                {x.error ? <div style={{ color: C.danger, fontSize: 12, marginTop: 4, wordBreak: 'break-word' }}>{x.error}</div> : null}
              </div>
            ))}
          </div>
        )}
      </Card>
    </PageContainer>
  );
}

window.PageNotifications = PageNotifications;
