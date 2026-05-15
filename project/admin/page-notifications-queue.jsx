// === admin/page-notifications-queue.jsx ====================================
// Admin viewer for the persistent notification retry queue
// (`notifications_queue`). Lets owners see what's pending, what failed,
// and manually retry a stuck row.
//
// Backed by:
//   GET  /api/admin/notifications?status=pending|sent|failed
//   POST /api/admin/notifications/:id/retry
// ===========================================================================

const { useState, useEffect } = React;

function PageNotificationsQueue({ setToast }) {
  const C = window.ADMIN_C;
  const { Card, Pill, PageContainer, PageHeader, EmptyState, Btn } = window;
  const apiFetch = window.requireApiFetch ? window.requireApiFetch() : window.apiFetch;
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('pending');
  const [busy, setBusy] = useState(null);

  async function load() {
    try {
      const r = await fetch(`/api/admin/notifications?status=${filter}`, { credentials: 'same-origin' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'load failed');
      setItems(d.items || []);
    } catch (e) {
      setToast && setToast({ kind: 'error', message: e.message });
    }
  }
  useEffect(() => { load(); }, [filter]);

  async function retry(id) {
    setBusy(id);
    try {
      const r = await apiFetch(`/api/admin/notifications/${id}/retry`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'retry failed');
      setToast && setToast({ kind: 'success', message: `จัดคิว retry แล้ว` });
      load();
    } catch (e) {
      setToast && setToast({ kind: 'error', message: e.message });
    } finally { setBusy(null); }
  }

  const colors = { pending: '#c08a2a', sent: '#2f8f5b', failed: '#b94a48' };
  const channelIcon = { line: '💬', email: '📧', sms: '📱' };

  return (
    <PageContainer>
      <PageHeader title="คิวการแจ้งเตือน"
        subtitle="ติดตามสถานะข้อความรอส่ง / ส่งสำเร็จ / ล้มเหลว · retry แมนวลได้"
        actions={
          <select value={filter} onChange={(e) => setFilter(e.target.value)}
            style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid ' + C.border, background: C.bg, color: C.ink }}>
            <option value="pending">รอส่ง</option>
            <option value="sent">ส่งสำเร็จ</option>
            <option value="failed">ล้มเหลว (≥3 ครั้ง)</option>
            <option value="">ทั้งหมด</option>
          </select>
        } />
      <Card>
        {items.length === 0 ? <EmptyState title={`ไม่มีรายการ${filter ? ' (' + filter + ')' : ''}`} /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: C.border, borderRadius: 8, overflow: 'hidden' }}>
            {items.map((x) => (
              <div key={x.id} style={{
                background: C.bg, padding: '12px 16px', display: 'grid',
                gridTemplateColumns: '70px 1fr auto auto', gap: 12, alignItems: 'center',
              }}>
                <div style={{ fontSize: 24, textAlign: 'center' }}>{channelIcon[x.channel] || '•'}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                    {x.subject || '(ไม่มีหัวข้อ)'}
                  </div>
                  <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>
                    {x.recipient} · {new Date(x.created_at).toLocaleString('th-TH')}
                    {x.retry_count > 0 ? ` · retry ${x.retry_count}/3` : ''}
                  </div>
                  {x.last_error && (
                    <div style={{ color: '#b94a48', fontSize: 11.5, marginTop: 4, fontFamily: 'JetBrains Mono, monospace' }}>
                      ⚠ {x.last_error}
                    </div>
                  )}
                </div>
                <Pill color={colors[x.status] || C.muted}>{x.status}</Pill>
                <div>
                  {(x.status === 'failed' || x.status === 'pending') && (
                    <Btn size="sm" disabled={busy === x.id} onClick={() => retry(x.id)}>
                      {busy === x.id ? '…' : 'Retry'}
                    </Btn>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </PageContainer>
  );
}

window.PageNotificationsQueue = PageNotificationsQueue;
