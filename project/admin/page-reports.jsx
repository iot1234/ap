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

  // Top-level view switch: "ภาพรวม (กราฟ)" — KPI cards + charts (this file)
  // vs "รายละเอียด (ตาราง · ส่งออก)" — embedded PageReportsV2 with DB-backed
  // tables + CSV/XLSX export. Consolidated into one sidebar entry so admin
  // doesn't see two confusing "รายงาน" rows. Hash /admin#reports-v2 still
  // works for direct deep-links.
  const [view, setView] = useState('charts');
  const [range, setRange] = useState('6m');
  const [liveOverview, setLiveOverview] = React.useState(null);
  const [agedReceivable, setAgedReceivable] = React.useState(null);
  // Real revenue + occupancy series from /api/reports/{revenue,occupancy}.
  // Spans the full year (12 months); the chart slices to `range` below.
  // Replaced Math.sin fabrications — see audit, May 2026.
  const [revRows, setRevRows] = React.useState(null);   // null=loading
  const [occRows, setOccRows] = React.useState(null);

  // Pull live aggregates from the server. Falls back gracefully to local
  // computeStats if the server is unreachable.
  React.useEffect(() => {
    let cancel = false;
    const year = new Date().getFullYear();
    (async () => {
      try {
        const [oRes, aRes, revRes, occRes] = await Promise.all([
          fetch('/api/reports/overview', { credentials: 'include' }),
          fetch('/api/reports/aged-receivable', { credentials: 'include' }),
          fetch(`/api/reports/revenue?year=${year}`, { credentials: 'include' }),
          fetch(`/api/reports/occupancy?year=${year}`, { credentials: 'include' }),
        ]);
        if (cancel) return;
        if (oRes.ok)   setLiveOverview(await oRes.json());
        if (aRes.ok)   setAgedReceivable(await aRes.json());
        if (revRes.ok) setRevRows(((await revRes.json()).rows) || []);
        else           setRevRows([]);
        if (occRes.ok) setOccRows(((await occRes.json()).rows) || []);
        else           setOccRows([]);
      } catch {
        if (!cancel) { setRevRows([]); setOccRows([]); }
      }
    })();
    return () => { cancel = true; };
  }, []);

  const stats = useMemo(() => computeStats(rooms, config), [rooms, config]);
  const list = useMemo(() => Object.values(rooms), [rooms]);

  // Revenue trend — slice the year-long /api/reports/revenue series down to
  // the selected range (3 / 6 / 12 months). Each row carries paid_amount;
  // unbilled months show as 0 so the operator can see the gap.
  const revenue = useMemo(() => {
    if (!revRows) return [];
    const now = new Date();
    const len = range === '12m' ? 12 : (range === '3m' ? 3 : 6);
    const months = [];
    for (let i = len - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const row = revRows.find((x) => x.period === period);
      months.push({
        label: fmtMonthTH(d).replace(' 25', "'").split(' ')[0],
        value: Math.round(Number(row?.paid_amount || 0)),
      });
    }
    if (months.length) months[months.length - 1].color = C.accent;
    return months;
  }, [revRows, range]);

  // Occupancy by month — last 6 months, real `rate_pct` from server.
  const occByMonth = useMemo(() => {
    if (!occRows) return [];
    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const row = occRows.find((x) => x.period === period);
      months.push({
        label: fmtMonthTH(d).split(' ')[0],
        value: row ? Math.round(Number(row.rate_pct || 0)) : 0,
      });
    }
    return months;
  }, [occRows]);

  // Real revenue prev-month delta (replaces hardcoded change={12}).
  const revChangePct = useMemo(() => {
    if (!revRows || revRows.length < 2) return null;
    const now = new Date();
    const cur = Number(revRows.find((x) => x.period === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)?.paid_amount || 0);
    const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prev = Number(revRows.find((x) => x.period === `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`)?.paid_amount || 0);
    if (!prev) return null;
    return Math.round(((cur - prev) / prev) * 100);
  }, [revRows]);

  // Real occupancy prev-month delta (replaces hardcoded change={3}).
  const occChangePct = useMemo(() => {
    if (!occRows || occRows.length < 2) return null;
    const now = new Date();
    const cur = Number(occRows.find((x) => x.period === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)?.rate_pct || 0);
    const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prev = Number(occRows.find((x) => x.period === `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`)?.rate_pct || 0);
    if (!prev) return null;
    return Math.round(cur - prev);   // pct-point delta, not relative %
  }, [occRows]);

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

  // Floor performance — derive floors from actual rooms data so floors 6+
  // an admin added show up in the breakdown. Previously hardcoded
  // [1,2,3,4,5] left newly-added floors invisible in this report and
  // could divide-by-zero on total=0 (NaN occupancy %). Filter empty
  // floors out so we don't render rows for floors that don't exist.
  const floorPerf = useMemo(() => {
    const set = new Set();
    for (const r of list) {
      const f = Number(r && r.floor);
      if (Number.isInteger(f) && f >= 1 && f <= 99) set.add(f);
    }
    const floors = Array.from(set).sort((a, b) => a - b);
    return floors.map(f => {
      const rooms = list.filter(r => r.floor === f);
      const occupied = rooms.filter(r => r.status === 'occupied' || r.status === 'overdue' || r.status === 'reserved').length;
      const total = rooms.length;
      const revenue = rooms.filter(r => r.tenant).reduce((s, r) => s + r.rent + (r.water||0) + (r.elec||0) + (r.wifi||0), 0);
      // Guard against division-by-zero — floors that exist in `floors` always
      // have at least one room so total > 0 in practice, but defensive.
      const occupancy = total > 0 ? Math.round(occupied / total * 100) : 0;
      return { floor: f, total, occupied, occupancy, revenue };
    });
  }, [list]);

  return (
    <PageContainer>
      <PageHeader
        title="รายงานและการวิเคราะห์"
        subtitle="ภาพรวมประสิทธิภาพการเช่า, รายได้ และการเข้าพัก"
        actions={view === 'charts' ? (
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
        ) : null}
      />

      <Tabs
        items={[
          { value: 'charts', label: 'ภาพรวม · กราฟ',      icon: '📊' },
          { value: 'tables', label: 'รายละเอียด · ตาราง', icon: '📈' },
        ]}
        value={view}
        onChange={setView}
        variant="pills"
        style={{ marginBottom: 20 }}
      />

      {view === 'tables' && window.PageReportsV2 && (
        <window.PageReportsV2 setToast={setToast} embedded />
      )}

      {view === 'charts' && (<>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 20 }}>
        <KpiCard label="รายได้รวม"  value={fmtCurrency(stats.revenue)} change={revChangePct} sub="เดือนนี้" color="accent" icon="💰" />
        <KpiCard label="อัตราเข้าพักเฉลี่ย" value={`${stats.occupancy}%`} change={occChangePct} color="success" icon="📊" />
        <KpiCard label="รายได้/ห้อง"     value={fmtCurrency(Math.round(stats.revenue / Math.max(1, stats.counts.occupied + stats.counts.overdue)))} sub="ต่อเดือน" color="info" icon="🏠" />
        <KpiCard label="ค้างชำระ"      value={fmtCurrency(stats.overdueAmt)} sub={`${stats.counts.overdue} ห้อง`} color="danger" icon="⚠️" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginBottom: 16 }}>
        <Card style={{ gridColumn: 'span 2', minWidth: 0 }}>
          <SectionHeading title="แนวโน้มรายได้" subtitle={(range === '12m' ? '12 เดือนล่าสุด' : (range === '3m' ? '3 เดือน' : '6 เดือน')) + ' — จากบิลที่ชำระแล้ว'} level={3} />
          {revRows == null ? (
            <div style={{ padding: 32, textAlign: 'center', color: C.muted, fontSize: 13 }}>กำลังโหลดข้อมูลรายได้...</div>
          ) : revenue.every((m) => !m.value) ? (
            <div style={{ padding: 32, textAlign: 'center', color: C.muted, fontSize: 13.5 }}>
              ยังไม่มีบิลที่ชำระแล้วในช่วงนี้
            </div>
          ) : (
            <BarChart data={revenue} height={240} color={C.accent} showValues
                      formatValue={(v) => '฿' + (v/1000).toFixed(0) + 'k'} />
          )}
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
          <SectionHeading title="อัตราเข้าพักรายเดือน" subtitle="จากบิลที่ออกในแต่ละรอบ" level={3} />
          {occRows == null ? (
            <div style={{ padding: 32, textAlign: 'center', color: C.muted, fontSize: 13 }}>กำลังโหลดข้อมูลการเข้าพัก...</div>
          ) : occByMonth.every((m) => !m.value) ? (
            <div style={{ padding: 32, textAlign: 'center', color: C.muted, fontSize: 13.5 }}>
              ยังไม่มีบิลในช่วง 6 เดือน — ออกบิลเพื่อดูอัตราเข้าพักจริง
            </div>
          ) : (
            <BarChart
              data={occByMonth.map(m => ({ ...m, color: m.value > 80 ? C.success : (m.value > 70 ? C.accent : C.warning) }))}
              height={200}
              showValues
              formatValue={(v) => v + '%'}
            />
          )}
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
              { key: 'id', label: 'ห้อง', minWidth: 60, render: r => <b style={{ fontFamily: 'IBM Plex Sans Thai, sans-serif' }}>{r.id}</b> },
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

        {agedReceivable && Array.isArray(agedReceivable.buckets) && (
          <Card>
            <SectionHeading title="ลูกหนี้ค้างชำระแยกอายุ" subtitle="Aged receivable" level={3} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
              {agedReceivable.buckets.map((b) => (
                <div key={b.range} style={{
                  padding: 14, background: C.surfaceAlt, border: `1px solid ${C.border}`,
                  borderRadius: 10,
                }}>
                  <div style={{ fontSize: 11.5, color: C.muted, fontWeight: 500 }}>{b.range} วัน</div>
                  <div style={{ fontSize: 22, fontWeight: 600, color: C.ink, fontFamily: 'IBM Plex Sans Thai, sans-serif', marginTop: 4 }}>
                    {fmtCurrency(b.amount)}
                  </div>
                  <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{b.rooms} ห้อง</div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {liveOverview && liveOverview.counts && (
          <Card>
            <SectionHeading title="สรุปสถานะปัจจุบัน (Live)" subtitle="ดึงจาก DB ทันทีที่เปิดหน้า" level={3} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, fontSize: 12 }}>
              {[
                { k: 'occupied', l: 'มีผู้เช่า', c: '#475569' },
                { k: 'overdue', l: 'ค้างชำระ', c: '#b54639' },
                { k: 'reserved', l: 'จองแล้ว', c: '#c98a2b' },
                { k: 'vacant', l: 'ว่าง', c: '#2e9b6a' },
                { k: 'maintenance', l: 'ปรับปรุง', c: '#7a6c54' },
              ].map((it) => (
                <div key={it.k} style={{ padding: 12, background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10 }}>
                  <div style={{ fontSize: 11, color: C.muted }}>{it.l}</div>
                  <div style={{ fontSize: 22, fontWeight: 600, color: it.c, fontFamily: 'IBM Plex Sans Thai, sans-serif', marginTop: 2 }}>
                    {liveOverview.counts[it.k] || 0}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      </>)}
    </PageContainer>
  );
}

window.PageReports = PageReports;
