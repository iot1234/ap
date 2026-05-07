// === admin/page-notifications.jsx ==========================================
// Read-only viewer of notifications_log — every LINE/email/SMS dispatch.
// Useful for verifying delivery + debugging routing fall-through.
// ===========================================================================

const { useState, useEffect } = React;

function PageNotifications() {
  const C = window.ADMIN_C;
  const { Card, Pill, PageContainer, PageHeader, EmptyState } = window;
  const [list, setList] = useState([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/notifications/log?limit=200', { credentials: 'same-origin' });
        const d = await r.json();
        if (r.ok) setList(d.logs || []);
      } catch {}
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
        {shown.length === 0 ? <EmptyState title="ยังไม่มีบันทึก" /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: C.border, maxHeight: 600, overflow: 'auto' }}>
            {shown.map((x) => (
              <div key={x.id} style={{
                background: C.bg, padding: '12px 14px', display: 'grid',
                gridTemplateColumns: '160px 80px 90px 1fr 80px', gap: 12, fontSize: 13.5, alignItems: 'center',
              }}>
                <span style={{ color: C.muted, fontSize: 12 }}>{new Date(x.created_at).toLocaleString('th-TH')}</span>
                <Pill color={x.status === 'sent' ? C.success : C.danger}>{x.status}</Pill>
                <span>{x.channel}</span>
                <div>
                  <div>{x.subject || x.body?.slice(0, 80)}</div>
                  {x.error ? <div style={{ color: C.danger, fontSize: 12 }}>{x.error}</div> : null}
                </div>
                <span style={{ color: C.muted, fontSize: 12 }}>{x.recipient}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </PageContainer>
  );
}

window.PageNotifications = PageNotifications;
