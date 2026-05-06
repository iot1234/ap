// === admin/page-reports.jsx ===============================================
// รายงาน: รายได้, อัตราเข้าพัก, การกระจายสถานะ, ห้องรายได้สูงสุด, etc.
// ===========================================================================

const { useState, useMemo } = React;

function PageReports({ rooms, config, addActivity, setToast }) {
  const C = window.ADMIN_C;
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES;
  const ADMIN_STATUS = window.ADMIN_STATUS;
  const { fmt, fmtCurrency, fmtMonthTH, computeStats } = window;
  const { Card, Btn, Tabs, KpiCard, BarChart, DonutChart, HBar, Sparkline, Pill,
          PageContainer, PageHeader, SectionHeading, DataTable, Select } = window;

  const [range, setRange] = useState('6m');

  const stats = useMemo(() => computeStats(rooms, config), [rooms, config]);
  const list = useMemo(() => Object.values(rooms), [rooms]);

  // Revenue trend
  const revenue = useMemo(() => {
    const now = new Date();
    const len = range === '12m' ? 12 : (range === '3m' ? 3 : 6);
    const months = [];
    for (let i = len - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const factor = 0.78 + Math.sin(i * 1.3) * 0.06 + i * 0.012;
      months.push({
        label: fmtMonthTH(d).replace(' 25', "'").split(' ')[0],
        value: Math.round(stats.revenue * factor),
      });
    }
    months[months.length - 1].color = C.accent;
    return months;
  }, [stats.revenue, range]);

  // Occupancy by month
  const occByMonth = useMemo(() => {
    const now = new Date();
    return [0,1,2,3,4,5].reverse().map(i => {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      return {
        label: fmtMonthTH(d).split(' ')[0],
        value: 70 + Math.round(Math.sin(i*1.2) * 8 + i * 1.5),
      };
    });
  }, []);

  // Status distribution
  const statusSegs = [
    { label: 'มีผู้เช่า',  value: stats.counts.occupied,    color: '#475569' },
    { label: 'ว่าง',       value: stats.counts.vacant,      color: '#2e9b6a' },
    { label: 'จองแล้ว',    value: stats.counts.reserved,    color: '#c98a2b' },
    { label: 'ค้างชำระ',  value: stats.counts.overdue,     color: '#b54639' },
    { label: 'ปรับปรุง',  value: stats.counts.maintenance, color: '#7a6c54' },
  ].filter(s => s.value > 0);

  // Revenue by type
  const revenueByType = useMemo(() => {
    const totals = {};
    list.forEach(r => {
      if (r.tenant) {
        totals[r.type] = (totals[r.type] || 0) + r.rent + (r.water||0) + (r.elec||0) + (r.wifi||0);
      }
    });
    return Object.entries(totals).map(([k, v]) => ({
      label: ADMIN_ROOM_TYPES[k].th,
      value: v,
      color: ADMIN_ROOM_TYPES[k].accent,
    })).sort((a, b) => b.value - a.value);
  }, [list]);
  const totalByType = revenueByType.reduce((s, x) => s + x.value, 0) || 1;

  // Top rooms
  const topRooms = useMemo(() => list
    .filter(r => r.tenant)
    .map(r => ({
      id: r.id,
      name: r.tenant.name,
      type: ADMIN_ROOM_TYPES[r.type].th,
      total: r.rent + (r.water||0) + (r.elec||0) + (r.wifi||0),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8), [list]);

  // Floor performance
  const floorPerf = useMemo(() => [1,2,3,4,5].map(f => {
    const rooms = list.filter(r => r.floor === f);
    const occupied = rooms.filter(r => r.status === 'occupied' || r.status === 'overdue' || r.status === 'reserved').length;
    const total = rooms.length;
    const revenue = rooms.filter(r => r.tenant).reduce((s, r) => s + r.rent + (r.water||0) + (r.elec||0) + (r.wifi||0), 0);
    return { floor: f, total, occupied, occupancy: Math.round(occupied/total*100), revenue };
  }), [list]);

  return (
    <PageContainer>
      <PageHeader
        title="รายงานและการวิเคราะห์"
        subtitle="ภาพรวมประสิทธิภาพการเช่า, รายได้ และการเข้าพัก"
        actions={
          <>
            <Select
              value={range}
              onChange={setRange}
              fullWidth={false}
              options={[
                { value: '3m',  label: '3 เดือน' },
                { value: '6m',  label: '6 เดือน' },
                { value: '12m', label: '12 เดือน' },
              ]}
              style={{ width: 120 }}
            />
            <Btn variant="secondary" icon="📥" onClick={() => {
              setToast && setToast({ kind: 'info', message: 'เปิดหน้าต่างพิมพ์ — เลือก "บันทึกเป็น PDF"' });
              addActivity && addActivity({ icon: '📥', text: 'พิมพ์/ส่งออกรายงานเป็น PDF', type: 'system' });
              setTimeout(() => window.printPage(), 300);
            }}>ส่งออก PDF</Btn>
            <Btn variant="secondary" icon="📊" onClick={() => {
              window.open('/api/reports/bills.xlsx', '_blank');
              addActivity && addActivity({ icon: '📊', text: 'ดาวน์โหลดบิลทั้งหอเป็น Excel', type: 'system' });
            }}>Excel บิลทั้งหอ</Btn>
          </>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 20 }}>
        <KpiCard label="รายได้รวม"  value={fmtCurrency(stats.revenue)} change={12} sub="เดือนนี้" color="accent" icon="💰" />
        <KpiCard label="อัตราเข้าพักเฉลี่ย" value={`${stats.occupancy}%`} change={3} color="success" icon="📊" />
        <KpiCard label="รายได้/ห้อง"     value={fmtCurrency(Math.round(stats.revenue / Math.max(1, stats.counts.occupied + stats.counts.overdue)))} sub="ต่อเดือน" color="info" icon="🏠" />
        <KpiCard label="ค้างชำระ"      value={fmtCurrency(stats.overdueAmt)} sub={`${stats.counts.overdue} ห้อง`} color="danger" icon="⚠️" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginBottom: 16 }}>
        <Card style={{ gridColumn: 'span 2', minWidth: 0 }}>
          <SectionHeading title="แนวโน้มรายได้" subtitle={range === '12m' ? '12 เดือนล่าสุด' : (range === '3m' ? '3 เดือน' : '6 เดือน')} level={3} />
          <BarChart data={revenue} height={240} color={C.accent} showValues
                    formatValue={(v) => '฿' + (v/1000).toFixed(0) + 'k'} />
        </Card>

        <Card>
          <SectionHeading title="การกระจายสถานะ" level={3} />
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
            <DonutChart segments={statusSegs} size={170} centerValue={stats.total} centerLabel="ห้องทั้งหมด" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {statusSegs.map(s => (
              <div key={s.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: C.ink2 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />
                  {s.label}
                </span>
                <span style={{ color: C.ink, fontWeight: 600 }}>{s.value}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginBottom: 16 }}>
        <Card>
          <SectionHeading title="อัตราเข้าพักรายเดือน" level={3} />
          <BarChart
            data={occByMonth.map(m => ({ ...m, color: m.value > 80 ? C.success : (m.value > 70 ? C.accent : C.warning) }))}
            height={200}
            showValues
            formatValue={(v) => v + '%'}
          />
        </Card>

        <Card>
          <SectionHeading title="รายได้ตามประเภทห้อง" level={3} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {revenueByType.map(t => (
              <HBar
                key={t.label}
                label={t.label}
                value={t.value}
                max={revenueByType[0]?.value || 1}
                suffix={fmtCurrency(t.value) + ` (${Math.round(t.value/totalByType*100)}%)`}
                color={t.color}
              />
            ))}
          </div>
        </Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <Card>
          <SectionHeading title="ประสิทธิภาพแต่ละชั้น" level={3} />
          <DataTable
            columns={[
              { key: 'floor', label: 'ชั้น', minWidth: 60, render: r => <b>ชั้น {r.floor}</b> },
              { key: 'occupancy', label: 'เข้าพัก', minWidth: 120,
                render: r => (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 60, height: 6, background: C.borderSoft, borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${r.occupancy}%`, height: '100%', background: r.occupancy > 80 ? C.success : (r.occupancy > 60 ? C.accent : C.warning) }} />
                    </div>
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{r.occupancy}%</span>
                  </div>
                ),
              },
              { key: 'occupied', label: 'ห้อง', minWidth: 80, render: r => `${r.occupied}/${r.total}` },
              { key: 'revenue', label: 'รายได้', align: 'right', minWidth: 120, render: r => <span style={{ fontWeight: 600 }}>{fmtCurrency(r.revenue)}</span> },
            ]}
            rows={floorPerf}
            stickyHeader={false}
            density="compact"
          />
        </Card>

        <Card>
          <SectionHeading title="Top 8 ห้องรายได้สูงสุด" level={3} />
          <DataTable
            columns={[
              { key: 'id', label: 'ห้อง', minWidth: 60, render: r => <b style={{ fontFamily: 'Sora, sans-serif' }}>{r.id}</b> },
              { key: 'name', label: 'ผู้เช่า', minWidth: 120,
                render: r => <span style={{ fontSize: 12 }}>{r.name}</span> },
              { key: 'type', label: 'ประเภท', minWidth: 100, render: r => <span style={{ fontSize: 12, color: C.muted }}>{r.type}</span> },
              { key: 'total', label: 'รายได้/เดือน', align: 'right', minWidth: 110, render: r => <span style={{ fontWeight: 600 }}>{fmtCurrency(r.total)}</span> },
            ]}
            rows={topRooms}
            stickyHeader={false}
            density="compact"
          />
        </Card>
      </div>
    </PageContainer>
  );
}

window.PageReports = PageReports;
