// === admin/page-maintenance.jsx ===========================================
// แจ้งซ่อม: Kanban board สำหรับจัดการ tickets แบบ drag-friendly (คลิกเพื่อ
// เปลี่ยนสถานะ ไม่ใช่ true drag-drop ใน MVP เพื่อความง่าย).
// ===========================================================================

const { useState, useEffect, useMemo } = React;

const STATUS_COLUMNS = [
  { key: 'open',            label: 'เปิดใหม่',     color: '#b54639' },
  { key: 'assigned',        label: 'มอบหมายแล้ว',  color: '#c98a2b' },
  { key: 'in_progress',     label: 'กำลังดำเนินการ', color: '#3a6b8a' },
  { key: 'awaiting_parts',  label: 'รออะไหล่',     color: '#7a4f8a' },
  { key: 'completed',       label: 'เสร็จสิ้น',    color: '#2e9b6a' },
];

const PRIORITY_LABEL = {
  critical: { th: 'วิกฤต', color: '#b54639' },
  high:     { th: 'สูง',   color: '#c98a2b' },
  medium:   { th: 'กลาง',  color: '#3a6b8a' },
  low:      { th: 'ต่ำ',   color: '#5b4f40' },
};

const CATEGORY_LABEL = {
  electrical: '⚡ ระบบไฟฟ้า',
  plumbing:   '🚰 ระบบประปา',
  aircon:     '❄️ เครื่องปรับอากาศ',
  furniture:  '🪑 เฟอร์นิเจอร์',
  appliance:  '🔌 เครื่องใช้ไฟฟ้า',
  door_lock:  '🚪 ประตู/ล็อก',
  wifi:       '📶 Wi-Fi/อินเทอร์เน็ต',
  other:      '🛠 อื่นๆ',
};

function PageMaintenance({ addActivity, setToast }) {
  const C = window.ADMIN_C;
  const { Card, SectionHeading, Btn, Pill, EmptyState, PageContainer, PageHeader, Modal, Drawer, Select, Input, Textarea } = window;

  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState('');
  const [filterPriority, setFilterPriority] = useState('all');

  const reload = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/maintenance', { credentials: 'include' });
      const data = await res.json();
      if (data.ok) setTickets(data.tickets || []);
    } catch (err) {
      console.error('load tickets failed', err);
      setToast && setToast({ kind: 'error', message: 'โหลดข้อมูลไม่สำเร็จ' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    // Poll every 30s so admins see new tickets without manual refresh.
    const t = setInterval(reload, 30_000);
    return () => clearInterval(t);
  }, []);

  // Mobile: stack columns horizontally-scrollable rather than 5-col grid
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 900;

  const filtered = useMemo(() => {
    return tickets.filter((t) => {
      if (filterPriority !== 'all' && t.priority !== filterPriority) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!(t.ticket_no?.toLowerCase().includes(q) ||
              t.title?.toLowerCase().includes(q) ||
              t.room_id?.toLowerCase().includes(q) ||
              t.tenant_name?.toLowerCase().includes(q))) return false;
      }
      return true;
    });
  }, [tickets, search, filterPriority]);

  const byStatus = useMemo(() => {
    const grouped = {};
    STATUS_COLUMNS.forEach((c) => { grouped[c.key] = []; });
    filtered.forEach((t) => {
      if (grouped[t.status]) grouped[t.status].push(t);
      else grouped.open.push(t);
    });
    return grouped;
  }, [filtered]);

  const updateTicket = async (id, payload) => {
    try {
      const res = await fetch(`/api/maintenance/${id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setToast && setToast({ kind: 'error', message: data.error || 'อัปเดตไม่สำเร็จ' });
        return null;
      }
      setTickets((prev) => prev.map((t) => (t.id === id ? data.ticket : t)));
      if (selected && selected.id === id) setSelected(data.ticket);
      return data.ticket;
    } catch (err) {
      console.error('update ticket failed', err);
      setToast && setToast({ kind: 'error', message: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' });
      return null;
    }
  };

  const stats = useMemo(() => ({
    total: tickets.length,
    open: tickets.filter(t => t.status === 'open').length,
    inProgress: tickets.filter(t => t.status === 'in_progress' || t.status === 'assigned').length,
    completed: tickets.filter(t => t.status === 'completed').length,
  }), [tickets]);

  return (
    <PageContainer>
      <PageHeader
        title="แจ้งซ่อม"
        subtitle={`ทั้งหมด ${stats.total} รายการ · เปิดใหม่ ${stats.open} · กำลังดำเนิน ${stats.inProgress} · เสร็จสิ้น ${stats.completed}`}
        actions={
          <Btn variant="secondary" icon="🔄" onClick={reload}>รีเฟรช</Btn>
        }
      />

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <Input
          placeholder="ค้นหาเลขที่ / เรื่อง / ห้อง / ผู้เช่า…"
          value={search}
          onChange={setSearch}
          fullWidth={false}
          style={{ width: 320 }}
        />
        <Select
          value={filterPriority}
          onChange={setFilterPriority}
          options={[
            { value: 'all', label: 'ทุกความสำคัญ' },
            { value: 'critical', label: 'วิกฤต' },
            { value: 'high', label: 'สูง' },
            { value: 'medium', label: 'กลาง' },
            { value: 'low', label: 'ต่ำ' },
          ]}
          fullWidth={false}
          style={{ width: 180 }}
        />
      </div>

      {loading && tickets.length === 0 && (
        <Card><div style={{ padding: 24, textAlign: 'center', color: C.muted }}>กำลังโหลด…</div></Card>
      )}

      {!loading && tickets.length === 0 && (
        <Card>
          <EmptyState
            icon="🛠"
            title="ยังไม่มีรายการแจ้งซ่อม"
            description="เมื่อผู้เช่าแจ้งซ่อมจากหน้า tenant จะปรากฏที่นี่"
          />
        </Card>
      )}

      {/* Kanban */}
      {tickets.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? 'repeat(5, 280px)' : 'repeat(5, 1fr)',
          gap: 12,
          alignItems: 'flex-start',
          ...(isMobile ? { overflowX: 'auto', paddingBottom: 8 } : {}),
        }}>
          {STATUS_COLUMNS.map((col) => (
            <div key={col.key} style={{
              background: C.surfaceAlt, borderRadius: 12, padding: 12,
              border: `1px solid ${C.border}`, minHeight: 220,
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                marginBottom: 12, paddingBottom: 8, borderBottom: `1px solid ${C.border}`,
              }}>
                <span style={{
                  fontSize: 12.5, fontWeight: 600, color: C.ink,
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: 50, background: col.color, display: 'inline-block',
                  }} />
                  {col.label}
                </span>
                <span style={{
                  background: C.surface, color: C.ink2, fontSize: 11, fontWeight: 600,
                  padding: '2px 7px', borderRadius: 999, border: `1px solid ${C.border}`,
                }}>{byStatus[col.key].length}</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {byStatus[col.key].map((t) => {
                  const pri = PRIORITY_LABEL[t.priority] || PRIORITY_LABEL.medium;
                  const cat = CATEGORY_LABEL[t.category] || t.category;
                  return (
                    <div
                      key={t.id}
                      onClick={() => setSelected(t)}
                      style={{
                        background: C.surface, border: `1px solid ${C.border}`,
                        borderRadius: 9, padding: '10px 12px', cursor: 'pointer',
                        transition: 'border-color .15s, box-shadow .15s',
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.borderColor = C.accent}
                      onMouseLeave={(e) => e.currentTarget.style.borderColor = C.border}>
                      <div style={{
                        fontSize: 10.5, color: pri.color, fontWeight: 600,
                        textTransform: 'uppercase', letterSpacing: 0.4,
                      }}>{pri.th} · {t.ticket_no}</div>
                      <div style={{
                        fontSize: 13, color: C.ink, fontWeight: 500,
                        marginTop: 4, marginBottom: 6, lineHeight: 1.3,
                      }}>{t.title}</div>
                      <div style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        fontSize: 11, color: C.muted,
                      }}>
                        <span>ห้อง {t.room_id}</span>
                        <span>{cat}</span>
                      </div>
                    </div>
                  );
                })}
                {byStatus[col.key].length === 0 && (
                  <div style={{
                    padding: '20px 12px', textAlign: 'center', fontSize: 12, color: C.muted,
                  }}>—</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Detail drawer */}
      <Drawer
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? `${selected.ticket_no} — ${selected.title}` : ''}
        width={520}
      >
        {selected && (
          <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={{
              padding: 14, background: C.surfaceAlt, borderRadius: 9,
              fontSize: 13.5, color: C.ink, lineHeight: 1.6,
            }}>
              {selected.description || <span style={{ color: C.muted }}>(ไม่มีรายละเอียดเพิ่มเติม)</span>}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <div style={{ fontSize: 11.5, color: C.muted }}>ห้อง</div>
                <div style={{ fontSize: 14, color: C.ink, fontWeight: 500 }}>{selected.room_id}</div>
              </div>
              <div>
                <div style={{ fontSize: 11.5, color: C.muted }}>หมวด</div>
                <div style={{ fontSize: 14, color: C.ink, fontWeight: 500 }}>
                  {CATEGORY_LABEL[selected.category] || selected.category}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11.5, color: C.muted }}>ผู้เช่า</div>
                <div style={{ fontSize: 14, color: C.ink, fontWeight: 500 }}>
                  {selected.tenant_name || '—'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11.5, color: C.muted }}>เบอร์ติดต่อ</div>
                <div style={{ fontSize: 14, color: C.ink, fontWeight: 500 }}>
                  {selected.tenant_phone || '—'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11.5, color: C.muted }}>วันที่แจ้ง</div>
                <div style={{ fontSize: 13, color: C.ink2 }}>
                  {selected.created_at ? new Date(selected.created_at).toLocaleString('th-TH') : '—'}
                </div>
              </div>
              {selected.completed_at && (
                <div>
                  <div style={{ fontSize: 11.5, color: C.muted }}>วันที่เสร็จ</div>
                  <div style={{ fontSize: 13, color: C.ink2 }}>
                    {new Date(selected.completed_at).toLocaleString('th-TH')}
                  </div>
                </div>
              )}
            </div>

            <hr style={{ border: 'none', borderTop: `1px solid ${C.border}` }} />

            <div>
              <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 6 }}>เปลี่ยนสถานะ</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {STATUS_COLUMNS.map((c) => (
                  <button
                    key={c.key}
                    onClick={() => updateTicket(selected.id, { status: c.key })}
                    style={{
                      padding: '6px 12px', borderRadius: 7,
                      border: `1px solid ${selected.status === c.key ? c.color : C.border}`,
                      background: selected.status === c.key ? c.color : 'transparent',
                      color: selected.status === c.key ? '#fff' : C.ink,
                      fontSize: 12, fontWeight: 500, cursor: 'pointer',
                      fontFamily: 'inherit', transition: 'all .15s',
                    }}>
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            <Input
              label="มอบหมายให้ (ชื่อช่าง / ทีม)"
              value={selected.assigned_to || ''}
              onChange={(v) => updateTicket(selected.id, { assignedTo: v })}
            />

            <Input
              label="ค่าใช้จ่าย (บาท)"
              type="number"
              value={selected.cost || 0}
              onChange={(v) => updateTicket(selected.id, { cost: Number(v) || 0 })}
            />

            <Select
              label="ความสำคัญ"
              value={selected.priority}
              onChange={(v) => updateTicket(selected.id, { priority: v })}
              options={[
                { value: 'critical', label: 'วิกฤต' },
                { value: 'high', label: 'สูง' },
                { value: 'medium', label: 'กลาง' },
                { value: 'low', label: 'ต่ำ' },
              ]}
            />

            {selected.rating && (
              <div style={{
                padding: 14, background: '#fbf1de', borderRadius: 9,
                border: '1px solid #ecd9b4',
              }}>
                <div style={{ fontSize: 11.5, color: '#5a3a0d', marginBottom: 4 }}>คะแนนจากผู้เช่า</div>
                <div style={{ fontSize: 18, color: '#5a3a0d' }}>
                  {'★'.repeat(selected.rating)}{'☆'.repeat(5 - selected.rating)}
                </div>
                {selected.rating_comment && (
                  <div style={{ fontSize: 13, color: C.ink2, marginTop: 6, fontStyle: 'italic' }}>
                    "{selected.rating_comment}"
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </Drawer>
    </PageContainer>
  );
}

window.PageMaintenance = PageMaintenance;
