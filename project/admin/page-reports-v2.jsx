// === admin/page-reports-v2.jsx =============================================
// Real reports backed by /api/reports2/* endpoints (DB-aggregated, not the
// localStorage-derived numbers in the legacy page-reports.jsx).
//
// Tabs: Revenue · Occupancy · Overdue · Maintenance · Cashflow
// Each tab supports CSV / XLSX export (calls /api/reports2/<x>?format=…).
// ===========================================================================

const { useState, useEffect, useMemo } = React;

// `embedded` prop lets PageReports host this as a tab without the outer
// PageContainer + PageHeader. Standalone usage at /admin#reports-v2 still
// works for legacy URLs / bookmarks.
function PageReportsV2({ setToast, embedded = false }) {
  const C = window.ADMIN_C;
  const { Card, PageContainer, PageHeader, EmptyState, Btn, Tabs } = window;
  const Wrapper = embedded
    ? ({ children }) => <div>{children}</div>
    : ({ children }) => <PageContainer>{children}</PageContainer>;
  const Header = embedded
    ? () => null
    : (props) => <PageHeader {...props} />;
  const [tab, setTab] = useState('revenue');
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState({ rows: [], stats: null });
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try {
      let url;
      if (tab === 'revenue')      url = `/api/reports2/revenue?year=${year}`;
      else if (tab === 'occupancy') url = `/api/reports2/occupancy?year=${year}`;
      else if (tab === 'overdue')   url = `/api/reports2/overdue`;
      else if (tab === 'maintenance') url = `/api/reports2/maintenance/stats`;
      else if (tab === 'cashflow')  url = `/api/reports2/cashflow?months=12`;
      const r = await fetch(url, { credentials: 'same-origin' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'load failed');
      setData({ rows: d.rows || [], stats: d.byStatus ? d : null });
    } catch (e) {
      setToast && setToast({ kind: 'error', message: e.message });
      setData({ rows: [], stats: null });
    } finally { setBusy(false); }
  }
  useEffect(() => { load(); }, [tab, year]);

  function exportAs(format) {
    const url = tab === 'revenue' ? `/api/reports2/revenue?year=${year}&format=${format}`
      : tab === 'occupancy' ? `/api/reports2/occupancy?year=${year}&format=${format}`
      : tab === 'overdue' ? `/api/reports2/overdue?format=${format}`
      : tab === 'maintenance' ? `/api/reports2/maintenance/stats?format=${format}`
      : tab === 'cashflow' ? `/api/reports2/cashflow?months=12&format=${format}`
      : null;
    if (!url) {
      setToast && setToast({ kind: 'info', message: 'หน้านี้ไม่รองรับการส่งออก' });
      return;
    }
    window.open(url, '_blank');
  }

  return (
    <Wrapper>
      <Header title="รายงานจริง (จากฐานข้อมูล)"
        subtitle="ตัวเลขจริงจากตาราง bills / tenants / maintenance — ไม่ใช่ข้อมูลตัวอย่าง"
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {(tab === 'revenue' || tab === 'occupancy') && (
              <select value={year} onChange={(e) => setYear(Number(e.target.value))}
                style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid ' + C.border, background: C.bg, color: C.ink }}>
                {[0, 1, 2].map((d) => {
                  const y = new Date().getFullYear() - d;
                  return <option key={y} value={y}>ปี {y + 543}</option>;
                })}
              </select>
            )}
            <Btn size="sm" onClick={() => exportAs('csv')}>CSV</Btn>
            <Btn size="sm" onClick={() => exportAs('xlsx')}>Excel</Btn>
          </div>
        } />

      <Card>
        <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid ' + C.border, marginBottom: 16 }}>
          {[
            ['revenue', 'รายได้'],
            ['occupancy', 'อัตราเข้าพัก'],
            ['overdue', 'ลูกหนี้ค้าง'],
            ['maintenance', 'แจ้งซ่อม'],
            ['cashflow', 'กระแสเงินสด'],
          ].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} style={{
              padding: '10px 16px', border: 0, background: 'transparent',
              borderBottom: tab === id ? `2px solid ${C.accent}` : '2px solid transparent',
              color: tab === id ? C.accent : C.muted,
              cursor: 'pointer', fontFamily: 'inherit', fontSize: 14, fontWeight: tab === id ? 600 : 400,
              marginBottom: -1,
            }}>{label}</button>
          ))}
        </div>

        {busy && <div style={{ color: C.muted, padding: 24, textAlign: 'center' }}>กำลังโหลด…</div>}

        {!busy && tab === 'revenue' && <RevenueView rows={data.rows} C={C} />}
        {!busy && tab === 'occupancy' && <OccupancyView rows={data.rows} C={C} />}
        {!busy && tab === 'overdue' && <OverdueView rows={data.rows} C={C} />}
        {!busy && tab === 'maintenance' && <MaintenanceView stats={data.stats} C={C} />}
        {!busy && tab === 'cashflow' && <CashflowView rows={data.rows} C={C} />}
      </Card>
    </Wrapper>
  );
}

function fmtBaht(n) {
  return Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function RevenueView({ rows, C }) {
  const total = rows.reduce((s, r) => s + Number(r.paid_amount || 0), 0);
  const overdue = rows.reduce((s, r) => s + Number(r.overdue_amount || 0), 0);
  const max = Math.max(1, ...rows.map((r) => Number(r.total_amount || 0)));
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 16 }}>
        <Stat label="รับชำระแล้วทั้งปี" value={`฿${fmtBaht(total)}`} color="#2f8f5b" />
        <Stat label="ค้างชำระ" value={`฿${fmtBaht(overdue)}`} color="#b94a48" />
        <Stat label="จำนวนบิล" value={rows.reduce((s, r) => s + Number(r.bills || 0), 0)} color="" />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((r) => (
          <div key={r.period} style={{ display: 'grid', gridTemplateColumns: '70px 1fr 120px', gap: 10, alignItems: 'center', fontSize: 13 }}>
            <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>{r.period}</span>
            <div style={{ background: C.bgSoft || '#f5efe4', borderRadius: 4, height: 22, position: 'relative' }}>
              <div style={{
                position: 'absolute', left: 0, top: 0, bottom: 0,
                width: `${(Number(r.paid_amount) / max) * 100}%`,
                background: '#2f8f5b', borderRadius: 4,
              }} />
              {Number(r.overdue_amount) > 0 && (
                <div style={{
                  position: 'absolute',
                  left: `${(Number(r.paid_amount) / max) * 100}%`, top: 0, bottom: 0,
                  width: `${(Number(r.overdue_amount) / max) * 100}%`,
                  background: '#b94a48', opacity: 0.8,
                }} />
              )}
            </div>
            <span style={{ textAlign: 'right' }}>฿{fmtBaht(r.paid_amount)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function OccupancyView({ rows, C }) {
  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((r) => (
          <div key={r.period} style={{ display: 'grid', gridTemplateColumns: '70px 1fr 120px', gap: 10, alignItems: 'center', fontSize: 13 }}>
            <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>{r.period}</span>
            <div style={{ background: C.bgSoft || '#f5efe4', borderRadius: 4, height: 22, position: 'relative' }}>
              <div style={{
                position: 'absolute', left: 0, top: 0, bottom: 0,
                width: `${r.rate_pct}%`, background: '#3a7bba', borderRadius: 4,
              }} />
            </div>
            <span style={{ textAlign: 'right' }}>{r.occupied}/{r.total_rooms} ({r.rate_pct}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function OverdueView({ rows, C }) {
  const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const labels = {
    current: 'ยังไม่ครบกำหนด',
    late_0_30: 'ค้าง 0-30 วัน',
    late_31_60: 'ค้าง 31-60 วัน',
    late_61_90: 'ค้าง 61-90 วัน',
    late_over_90: 'ค้างเกิน 90 วัน',
  };
  const colors = {
    current: '#2f8f5b', late_0_30: '#c08a2a',
    late_31_60: '#c46a3e', late_61_90: '#a4542d', late_over_90: '#b94a48',
  };
  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <span style={{ color: C.muted, fontSize: 13 }}>รวมยังเก็บไม่ได้: </span>
        <strong style={{ fontFamily: 'IBM Plex Sans Thai', fontSize: 22 }}>฿{fmtBaht(total)}</strong>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: C.border, borderRadius: 6, overflow: 'hidden' }}>
        {rows.map((r) => (
          <div key={r.bucket} style={{
            background: C.bg, padding: '10px 14px',
            display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10, alignItems: 'center',
          }}>
            <span style={{ color: colors[r.bucket] || C.ink, fontWeight: 600 }}>{labels[r.bucket] || r.bucket}</span>
            <span style={{ color: C.muted }}>{r.bills} บิล</span>
            <strong>฿{fmtBaht(r.amount)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function MaintenanceView({ stats, C }) {
  if (!stats) return <EmptyStateLocal label="ไม่มีข้อมูล" />;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
      <Stat label="ทั้งหมด"          value={stats.completed + (stats.byStatus.open || 0) + (stats.byStatus.in_progress || 0) + (stats.byStatus.assigned || 0) + (stats.byStatus.cancelled || 0)} color="" />
      <Stat label="เสร็จสิ้น"          value={stats.completed || 0} color="#2f8f5b" />
      <Stat label="กำลังดำเนินการ"  value={(stats.byStatus.in_progress || 0) + (stats.byStatus.assigned || 0)} color="#3a7bba" />
      <Stat label="เปิดใหม่"          value={stats.byStatus.open || 0} color="#c08a2a" />
      <Stat label="critical ค้าง"    value={stats.open_critical || 0} color={stats.open_critical > 0 ? '#b94a48' : '#2f8f5b'} />
      <Stat label="เวลาเฉลี่ย (ชม.)"  value={stats.avg_hours_to_resolve || '—'} color="" />
      <Stat label="คะแนนเฉลี่ย"     value={stats.avg_rating ? `${stats.avg_rating}/5` : '—'} color="" />
      <Stat label="ผู้ให้คะแนน"      value={stats.rated || 0} color="" />
    </div>
  );
}

function CashflowView({ rows, C }) {
  const max = Math.max(1, ...rows.map((r) => Number(r.projected || 0)));
  return (
    <div>
      <div style={{ color: C.muted, fontSize: 13, marginBottom: 12 }}>
        ประมาณการรายได้ 12 เดือนข้างหน้า (จากค่าเฉลี่ย 90 วันล่าสุด)
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((r) => (
          <div key={r.period} style={{ display: 'grid', gridTemplateColumns: '70px 1fr 120px', gap: 10, alignItems: 'center', fontSize: 13 }}>
            <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>{r.period}</span>
            <div style={{ background: C.bgSoft || '#f5efe4', borderRadius: 4, height: 22, position: 'relative' }}>
              <div style={{
                position: 'absolute', left: 0, top: 0, bottom: 0,
                width: `${(Number(r.projected) / max) * 100}%`,
                background: C.accent, borderRadius: 4,
              }} />
            </div>
            <span style={{ textAlign: 'right' }}>฿{fmtBaht(r.projected)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, color }) {
  const C = window.ADMIN_C;
  return (
    <div style={{ background: C.bg, border: '1px solid ' + C.border, borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: 'IBM Plex Sans Thai', fontSize: 20, fontWeight: 600, color: color || C.ink }}>{value}</div>
    </div>
  );
}

function EmptyStateLocal({ label }) {
  const C = window.ADMIN_C;
  return <div style={{ color: C.muted, padding: 40, textAlign: 'center' }}>{label}</div>;
}

window.PageReportsV2 = PageReportsV2;
