// === admin/page-overview.jsx ==============================================
// หน้าภาพรวม (Dashboard): KPI cards, รายได้รายเดือน, สถานะห้อง, กิจกรรมล่าสุด
// ===========================================================================

const { useMemo } = React;

function PageOverview({ rooms, config, bookings, activities, addActivity, setToast }) {
  const C = window.ADMIN_C;
  const { fmt, fmtCurrency, fmtMonthTH, relTime, computeStats, exportFullBackup } = window;
  const { Card, SectionHeading, Btn, KpiCard, BarChart, DonutChart, Pill, StatusBadge, HBar, EmptyState, PageContainer, PageHeader, Modal } = window;
  const [allActivitiesOpen, setAllActivitiesOpen] = React.useState(false);

  const stats = useMemo(() => computeStats(rooms, config), [rooms, config]);
  const list  = useMemo(() => Object.values(rooms), [rooms]);

  // --- Real revenue trend from DB. Pulls 12 months of bills, slices to last
  // 6 for the dashboard chart. Falls back to an empty series if the endpoint
  // is unreachable (manager+ role required by /api/reports/revenue) so the
  // page still renders. The previous Math.sin formula fabricated numbers
  // unrelated to the actual `bills` table — see audit, May 2026.
  const [revenueRows, setRevenueRows] = React.useState(null);  // null = loading, [] = error/empty
  React.useEffect(() => {
    let cancel = false;
    const year = new Date().getFullYear();
    fetch(`/api/reports/revenue?year=${year}`, { credentials: 'same-origin' })
      .then(async (r) => (r.ok ? (await r.json()).rows : []))
      .then((rows) => { if (!cancel) setRevenueRows(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancel) setRevenueRows([]); });
    return () => { cancel = true; };
  }, []);
  const revenueTrend = useMemo(() => {
    if (!revenueRows) return [];   // still loading
    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const row = revenueRows.find((x) => x.period === period);
      months.push({
        label: fmtMonthTH(d).replace(' 25', "'"),
        value: Math.round(Number(row?.paid_amount || 0)),
      });
    }
    if (months.length) months[months.length - 1].color = C.accent;
    return months;
  }, [revenueRows]);

  // Real prev-month delta for the revenue KPI (replaces hardcoded +12%).
  // Returns null when there's no prior data to compare against — KpiCard
  // just hides the change badge in that case.
  const revChangePct = useMemo(() => {
    if (!revenueRows || revenueRows.length < 2) return null;
    const now = new Date();
    const thisP = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevP = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
    const cur = Number(revenueRows.find((x) => x.period === thisP)?.paid_amount || 0);
    const prev = Number(revenueRows.find((x) => x.period === prevP)?.paid_amount || 0);
    if (!prev) return null;   // can't compute % change from zero
    return Math.round(((cur - prev) / prev) * 100);
  }, [revenueRows]);

  // --- Status distribution ----
  const statusSegs = [
    { label: 'มีผู้เช่า',  value: stats.counts.occupied,    color: '#475569' },
    { label: 'ว่าง',       value: stats.counts.vacant,      color: '#2e9b6a' },
    { label: 'จองแล้ว',    value: stats.counts.reserved,    color: '#c98a2b' },
    { label: 'ค้างชำระ',  value: stats.counts.overdue,     color: '#b54639' },
    { label: 'ปรับปรุง',  value: stats.counts.maintenance, color: '#7a6c54' },
  ].filter(s => s.value > 0);

  // --- Top revenue rooms (use current config rates) ----
  const topRooms = useMemo(() => {
    const wRate = config.utilities?.waterRate ?? 18;
    const eRate = config.utilities?.elecRate  ?? 8;
    const wifi  = config.utilities?.wifi       ?? 250;
    return list
      .filter(r => r.tenant)
      .map(r => ({
        id: r.id,
        total: r.rent + (r.waterUnits||0)*wRate + (r.elecUnits||0)*eRate + (r.wifi || wifi),
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);
  }, [list, config]);
  const topMax = topRooms[0]?.total || 1;

  // --- Upcoming contract endings from the relational contracts table ----
  // rooms.contractEnd is a legacy blob field and can drift from the real
  // contract row after check-in, invitation approval, or checkout. The
  // dashboard warning must use contracts as the source of truth.
  const [upcomingContracts, setUpcomingContracts] = React.useState([]);
  React.useEffect(() => {
    let cancel = false;
    fetch('/api/contracts?status=active&expiringInDays=60', { credentials: 'same-origin' })
      .then(async (r) => (r.ok ? (await r.json()).contracts : []))
      .then((rows) => {
        if (cancel) return;
        const next = (Array.isArray(rows) ? rows : [])
          .filter((c) => c && c.end_date)
          .slice(0, 4)
          .map((c) => ({
            id: c.id,
            room: c.room_id,
            name: c.tenant_name || 'ไม่ระบุผู้เช่า',
            date: String(c.end_date).slice(0, 10),
            daysLeft: c.days_left,
          }));
        setUpcomingContracts(next);
      })
      .catch(() => { if (!cancel) setUpcomingContracts([]); });
    return () => { cancel = true; };
  }, []);

  const overdueRooms = list.filter(r => r.status === 'overdue');
  const pendingBookings = (bookings || []).filter(b => b.status === 'pending').length;

  return (
    <PageContainer>
      <PageHeader
        title={`สวัสดี ผู้ดูแลระบบ`}
        subtitle={`วันนี้ ${new Date().toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`}
        actions={
          <>
            <Btn variant="secondary" icon="📥" onClick={() => {
              if (exportFullBackup(rooms, config, bookings, activities)) {
                addActivity && addActivity({ icon: '📥', text: 'ส่งออกรายงานทั้งหมด', type: 'system' });
                setToast && setToast({ kind: 'success', message: 'ส่งออกรายงาน JSON เรียบร้อย' });
              }
            }}>ส่งออกรายงาน</Btn>
            <Btn variant="primary" icon="📋" onClick={() => { location.hash = 'billing'; }}>
              ออกบิลเดือนนี้
            </Btn>
          </>
        }
      />

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginBottom: 24 }}>
        <KpiCard
          label="รายได้เดือนนี้"
          value={fmtCurrency(stats.revenue)}
          change={revChangePct}
          sub={revChangePct == null ? 'ยังไม่มีข้อมูลเปรียบเทียบ' : 'เทียบเดือนก่อน'}
          color="accent"
          icon="💰"
        />
        <KpiCard
          label="อัตราการเข้าพัก"
          value={`${stats.occupancy}%`}
          sub={`${stats.counts.occupied + stats.counts.overdue + stats.counts.reserved}/${stats.total} ห้อง`}
          color="success"
          icon="🏠"
        />
        <KpiCard
          label="ห้องว่าง"
          value={fmt(stats.counts.vacant)}
          sub="พร้อมเข้าพัก"
          color="info"
          icon="🚪"
        />
        <KpiCard
          label="ค้างชำระ"
          value={fmt(stats.counts.overdue)}
          sub={fmtCurrency(stats.overdueAmt)}
          color="danger"
          icon="⚠️"
        />
        <KpiCard
          label="การจองใหม่"
          value={fmt(pendingBookings)}
          sub="รอตรวจสอบ"
          color="warning"
          icon="📋"
        />
      </div>

      {/* Main grid: revenue trend + status donut */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginBottom: 16 }}>
        <Card style={{ gridColumn: 'span 2', minWidth: 0 }} className="grid-span-2">
          <SectionHeading
            title="รายได้รายเดือน"
            subtitle="6 เดือนล่าสุด — จากบิลที่ชำระแล้วในระบบ"
            level={3}
            action={revChangePct != null
              ? <Pill color={revChangePct >= 0 ? 'success' : 'danger'}
                      icon={revChangePct >= 0 ? '▲' : '▼'}>
                  {(revChangePct >= 0 ? '+' : '') + revChangePct + '% เทียบเดือนก่อน'}
                </Pill>
              : null}
          />
          {revenueRows == null ? (
            <div style={{ padding: 16 }}>
              {window.SkeletonRows ? <window.SkeletonRows count={6} lineHeight={26} varyWidths /> : <div style={{ padding: 16, textAlign: 'center', color: C.muted, fontSize: 13 }}>กำลังโหลดข้อมูลรายได้...</div>}
            </div>
          ) : revenueTrend.every((m) => !m.value) ? (
            <div style={{ padding: 32, textAlign: 'center', color: C.muted, fontSize: 13.5 }}>
              ยังไม่มีบิลที่ชำระแล้วในช่วง 6 เดือน — ออกบิลและรับชำระเพื่อดูแนวโน้มจริง
            </div>
          ) : (
            <BarChart data={revenueTrend} height={220} color={C.accent} showValues
                      formatValue={(v) => '฿' + (v/1000).toFixed(0) + 'k'} />
          )}
        </Card>

        <Card>
          <SectionHeading title="สถานะห้องพัก" level={3} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, justifyContent: 'center', flexWrap: 'wrap' }}>
            <DonutChart
              segments={statusSegs}
              size={170}
              centerValue={`${stats.occupancy}%`}
              centerLabel="เข้าพัก"
            />
          </div>
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {statusSegs.map(s => (
              <div key={s.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12.5 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color }} />
                  <span style={{ color: C.ink2 }}>{s.label}</span>
                </div>
                <span style={{ color: C.ink, fontWeight: 600 }}>{s.value} ห้อง</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Bottom row: activity + top rooms + upcoming */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        <Card>
          <SectionHeading
            title="กิจกรรมล่าสุด"
            level={3}
            action={<button onClick={() => setAllActivitiesOpen(true)} style={{ background: 'transparent', border: 'none', color: C.accent, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>ดูทั้งหมด</button>}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {(activities || []).slice(0, 6).map((a, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <div style={{
                  width: 32, height: 32, borderRadius: 8,
                  background: C.surfaceAlt, color: C.ink,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 14, flexShrink: 0,
                }}>{a.icon}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.4 }}>{a.text}</div>
                  <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>{relTime(a.time)}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <SectionHeading title="ห้องรายได้สูงสุด" subtitle="Top 5 ของเดือนนี้" level={3} />
          {topRooms.length === 0 ? (
            <EmptyState icon="📊" title="ยังไม่มีข้อมูล" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {topRooms.map(r => (
                <HBar
                  key={r.id}
                  label={`ห้อง ${r.id}`}
                  value={r.total}
                  max={topMax}
                  suffix={fmtCurrency(r.total)}
                  color={C.accent}
                />
              ))}
            </div>
          )}
        </Card>

        <Card>
          <SectionHeading title="แจ้งเตือนสำคัญ" level={3} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {overdueRooms.slice(0, 3).map(r => (
              <div key={r.id} style={{
                padding: 12, background: C.dangerSoft, borderRadius: 8,
                border: `1px solid ${C.danger}22`,
                display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <div style={{ fontSize: 18 }}>⚠️</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: C.dangerInk, fontWeight: 600 }}>
                    ห้อง {r.id} ค้างชำระ {r.overdueDays} วัน
                  </div>
                  <div style={{ fontSize: 12, color: C.dangerInk, opacity: 0.8 }}>
                    {r.tenant?.name} · {fmtCurrency(r.rent + (r.water||0) + (r.elec||0) + (r.wifi||0))}
                  </div>
                </div>
              </div>
            ))}
            {pendingBookings > 0 && (
              <div style={{
                padding: 12, background: C.warningSoft, borderRadius: 8,
                border: `1px solid ${C.warning}22`,
                display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <div style={{ fontSize: 18 }}>📋</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: C.warningInk, fontWeight: 600 }}>
                    การจองใหม่ {pendingBookings} รายการ
                  </div>
                  <div style={{ fontSize: 12, color: C.warningInk, opacity: 0.8 }}>
                    รอการตรวจสอบและอนุมัติ
                  </div>
                </div>
              </div>
            )}
            {upcomingContracts.slice(0, 2).map(u => (
              <div key={u.id || u.room} onClick={() => { location.hash = 'contracts'; }} style={{
                padding: 12, background: C.infoSoft, borderRadius: 8,
                border: `1px solid ${C.info}22`,
                display: 'flex', alignItems: 'center', gap: 10,
                cursor: 'pointer',
              }}>
                <div style={{ fontSize: 18 }}>📄</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: C.infoInk, fontWeight: 600 }}>
                    สัญญาห้อง {u.room} ใกล้หมดอายุ
                  </div>
                  <div style={{ fontSize: 12, color: C.infoInk, opacity: 0.8 }}>
                    {u.name} · {u.date}{Number.isFinite(Number(u.daysLeft)) ? ` · อีก ${u.daysLeft} วัน` : ''}
                  </div>
                </div>
              </div>
            ))}
            {overdueRooms.length === 0 && pendingBookings === 0 && upcomingContracts.length === 0 && (
              <EmptyState icon="✅" title="ไม่มีรายการเร่งด่วน" description="ทุกอย่างเป็นไปตามแผน" />
            )}
          </div>
        </Card>
      </div>

      <Modal
        open={allActivitiesOpen}
        onClose={() => setAllActivitiesOpen(false)}
        title={`กิจกรรมทั้งหมด (${(activities || []).length})`}
        width={560}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {(activities || []).map((a, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0', borderBottom: i === activities.length - 1 ? 'none' : `1px solid ${C.borderSoft}` }}>
              <div style={{
                width: 32, height: 32, borderRadius: 8,
                background: C.surfaceAlt, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 14, flexShrink: 0,
              }}>{a.icon}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.4 }}>{a.text}</div>
                <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>{relTime(a.time)}</div>
              </div>
            </div>
          ))}
          {(activities || []).length === 0 && (
            <EmptyState icon="📭" title="ยังไม่มีกิจกรรม" />
          )}
        </div>
      </Modal>
    </PageContainer>
  );
}

window.PageOverview = PageOverview;
