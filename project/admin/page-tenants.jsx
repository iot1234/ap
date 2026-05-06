// === admin/page-tenants.jsx ===============================================
// จัดการผู้เช่า: รายชื่อ + drawer profile (สัญญา, บิล, บันทึก)
// ===========================================================================

const { useState, useMemo } = React;

function PageTenants({ rooms, setRooms, addActivity, setToast }) {
  const C = window.ADMIN_C;
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES;
  const { fmt, fmtCurrency } = window;
  const { Card, Btn, IconBtn, Avatar, Pill, StatusBadge, DataTable, Drawer,
          SearchInput, FilterChip, PageContainer, PageHeader, SectionHeading,
          DefList, Tabs } = window;

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [activeId, setActiveId] = useState(null);
  const [drawerTab, setDrawerTab] = useState('profile');

  // Build tenants list from rooms
  const tenants = useMemo(() => {
    return Object.values(rooms)
      .filter(r => r.tenant)
      .map(r => ({
        ...r.tenant,
        roomId: r.id,
        floor: r.floor,
        type: r.type,
        rent: r.rent,
        since: r.since,
        contractEnd: r.contractEnd,
        status: r.status,
        room: r,
      }))
      .sort((a, b) => a.roomId.localeCompare(b.roomId));
  }, [rooms]);

  const filtered = useMemo(() => tenants.filter(t => {
    if (filter === 'overdue' && t.status !== 'overdue') return false;
    if (filter === 'aPlus' && t.score !== 'A') return false;
    if (search) {
      const q = search.toLowerCase();
      const hay = `${t.name} ${t.roomId} ${t.phone} ${t.email} ${t.occupation}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }), [tenants, filter, search]);

  const counts = useMemo(() => ({
    all: tenants.length,
    overdue: tenants.filter(t => t.status === 'overdue').length,
    aPlus: tenants.filter(t => t.score === 'A').length,
  }), [tenants]);

  const active = activeId ? tenants.find(t => t.roomId === activeId) : null;

  const columns = [
    {
      key: 'name', label: 'ผู้เช่า', minWidth: 220,
      render: t => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Avatar name={t.name} size={36} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{t.name}</div>
            <div style={{ fontSize: 11.5, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
              {t.occupation}
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'roomId', label: 'ห้อง', minWidth: 100,
      render: t => (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, fontFamily: 'Sora, sans-serif' }}>{t.roomId}</div>
          <div style={{ fontSize: 11, color: C.muted }}>{ADMIN_ROOM_TYPES[t.type].th}</div>
        </div>
      ),
    },
    {
      key: 'contact', label: 'ติดต่อ', minWidth: 160,
      render: t => (
        <div>
          <div style={{ fontSize: 12.5, color: C.ink2 }}>📱 {t.phone}</div>
          <div style={{ fontSize: 11.5, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis' }}>✉️ {t.email}</div>
        </div>
      ),
    },
    { key: 'since', label: 'เข้าพัก', minWidth: 110, render: t => <span style={{ fontSize: 12.5, color: C.ink2 }}>{t.since}</span> },
    {
      key: 'score', label: 'เครดิต', align: 'center', minWidth: 80,
      render: t => {
        const c = t.score === 'A' ? 'success' : (t.score === 'B' ? 'warning' : 'danger');
        return <Pill color={c} size="sm">{t.score}</Pill>;
      },
    },
    {
      key: 'status', label: 'สถานะ', minWidth: 110,
      render: t => <StatusBadge status={t.status} size="sm" />,
    },
    {
      key: 'actions', label: '', align: 'right', minWidth: 80,
      render: t => (
        <div onClick={(e) => e.stopPropagation()}>
          <IconBtn icon="📞" label="โทร" onClick={() => setToast && setToast({ kind: 'info', message: `กำลังโทร ${t.phone}` })} />
        </div>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        title="จัดการผู้เช่า"
        subtitle={`มีผู้เช่าทั้งหมด ${tenants.length} คน · แสดง ${filtered.length} คน`}
        actions={
          <>
            <Btn variant="secondary" icon="📤" onClick={() => {
              if (window.exportTenantsCSV(rooms)) {
                addActivity && addActivity({ icon: '📤', text: `ส่งออกข้อมูลผู้เช่า ${tenants.length} คน เป็น CSV`, type: 'system' });
                setToast && setToast({ kind: 'success', message: `ดาวน์โหลด CSV ${tenants.length} ผู้เช่าเรียบร้อย` });
              }
            }}>ส่งออก</Btn>
            <Btn variant="primary" icon="+" onClick={() => setToast && setToast({
              kind: 'info', message: 'เพิ่มผู้เช่าได้จากหน้า "ห้องพัก" → เลือกห้องที่ว่าง → เปลี่ยนสถานะเป็นมีผู้เช่า',
            })}>เพิ่มผู้เช่า</Btn>
          </>
        }
      />

      <Card style={{ marginBottom: 16, padding: 16 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <SearchInput value={search} onChange={setSearch} placeholder="ค้นหาชื่อ / ห้อง / เบอร์..." />
          <div style={{ width: 1, height: 28, background: C.border, margin: '0 4px' }} />
          <FilterChip label="ทั้งหมด" active={filter === 'all'} onClick={() => setFilter('all')} count={counts.all} />
          <FilterChip label="ค้างชำระ" active={filter === 'overdue'} onClick={() => setFilter('overdue')} count={counts.overdue} color={C.danger} />
          <FilterChip label="เครดิต A" active={filter === 'aPlus'} onClick={() => setFilter('aPlus')} count={counts.aPlus} color={C.success} />
        </div>
      </Card>

      <DataTable
        columns={columns}
        rows={filtered}
        onRowClick={(t) => { setActiveId(t.roomId); setDrawerTab('profile'); }}
        empty="ไม่พบผู้เช่าที่ตรงกับเงื่อนไข"
      />

      <Drawer
        open={!!active}
        onClose={() => setActiveId(null)}
        title={active ? active.name : ''}
        width={620}
        footer={active && (
          <>
            <Btn variant="ghost" onClick={() => setActiveId(null)}>ปิด</Btn>
            <Btn variant="secondary" icon="✉️" onClick={() => {
              setToast && setToast({ kind: 'info', message: `ส่งข้อความถึง ${active.name} ทาง LINE แล้ว` });
              addActivity && addActivity({ icon: '✉️', text: `ส่งข้อความถึง ${active.name} (ห้อง ${active.roomId})`, type: 'tenant' });
            }}>ส่งข้อความ</Btn>
            <Btn variant="primary" icon="📋" onClick={() => setDrawerTab('contract')}>ดูสัญญา</Btn>
          </>
        )}
      >
        {active && (
          <>
            <TenantHeader t={active} />
            <Tabs
              items={[
                { value: 'profile',  label: 'โปรไฟล์',  icon: '👤' },
                { value: 'contract', label: 'สัญญา',     icon: '📄' },
                { value: 'bills',    label: 'บิล',         icon: '🧾' },
                { value: 'notes',    label: 'บันทึก',     icon: '📝' },
              ]}
              value={drawerTab}
              onChange={setDrawerTab}
              style={{ margin: '20px 0 16px' }}
            />
            {drawerTab === 'profile'  && <TabProfile  t={active} />}
            {drawerTab === 'contract' && <TabContract t={active} setToast={setToast} addActivity={addActivity} />}
            {drawerTab === 'bills'    && <TabBills    t={active} />}
            {drawerTab === 'notes'    && <TabNotes    t={active} setRooms={setRooms} setToast={setToast} addActivity={addActivity} />}
          </>
        )}
      </Drawer>
    </PageContainer>
  );
}

function TenantHeader({ t }) {
  const C = window.ADMIN_C;
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES;
  const { Avatar, Pill, StatusBadge } = window;
  return (
    <div style={{
      padding: 16, background: C.surfaceAlt, borderRadius: 12,
      display: 'flex', alignItems: 'center', gap: 14,
    }}>
      <Avatar name={t.name} size={56} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 16, fontWeight: 600, color: C.ink, marginBottom: 2 }}>
          {t.name}
        </div>
        <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 6 }}>{t.occupation}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Pill color="accent" size="sm">ห้อง {t.roomId}</Pill>
          <Pill color="neutral" size="sm">{ADMIN_ROOM_TYPES[t.type].th}</Pill>
          <Pill color={t.score === 'A' ? 'success' : 'warning'} size="sm">เครดิต {t.score}</Pill>
          <StatusBadge status={t.status} size="sm" />
        </div>
      </div>
    </div>
  );
}

function TabProfile({ t }) {
  const { DefList } = window;
  return (
    <DefList
      columns={2}
      items={[
        { label: 'ชื่อ-นามสกุล', value: t.name, bold: true },
        { label: 'อาชีพ',          value: t.occupation },
        { label: 'เบอร์โทรศัพท์',  value: t.phone },
        { label: 'อีเมล',          value: t.email },
        { label: 'เลขห้อง',        value: t.roomId },
        { label: 'ชั้น',             value: `ชั้น ${t.floor}` },
        { label: 'เข้าพักเมื่อ',  value: t.since },
        { label: 'คะแนนเครดิต', value: t.score },
      ]}
    />
  );
}

function TabContract({ t, setToast, addActivity }) {
  const C = window.ADMIN_C;
  const { fmtCurrency, downloadFile } = window;
  const { Card, DefList, Btn, Pill } = window;

  const contractNo = `CT-${t.roomId}-${(t.since || '').slice(-4)}`;

  const handleDownload = () => {
    const today = new Date().toLocaleDateString('th-TH');
    const text = [
      'สัญญาเช่าห้องพัก — บ้านกาญจน์ เรสซิเดนซ์',
      '='.repeat(48),
      `หมายเลขสัญญา : ${contractNo}`,
      `วันที่ออกเอกสาร : ${today}`,
      '',
      'ผู้เช่า',
      `  ชื่อ-สกุล : ${t.name}`,
      `  อาชีพ      : ${t.occupation}`,
      `  เบอร์โทร  : ${t.phone}`,
      `  อีเมล      : ${t.email}`,
      '',
      'ห้องพัก',
      `  เลขห้อง   : ${t.roomId}`,
      `  ชั้น          : ${t.floor}`,
      '',
      'เงื่อนไข',
      `  ระยะเวลาสัญญา : 12 เดือน`,
      `  เริ่มต้น           : ${t.since}`,
      `  สิ้นสุด             : ${t.contractEnd}`,
      `  ค่าเช่า/เดือน    : ${fmtCurrency(t.rent)}`,
      `  เงินมัดจำ         : ${fmtCurrency(t.rent * 2)}`,
      '',
      'ลงชื่อ ............................. ผู้เช่า',
      'ลงชื่อ ............................. ผู้ให้เช่า',
    ].join('\n');
    if (downloadFile(`contract_${contractNo}.txt`, text)) {
      setToast && setToast({ kind: 'success', message: 'ดาวน์โหลดสัญญาเรียบร้อย' });
      addActivity && addActivity({ icon: '📥', text: `ดาวน์โหลดสัญญา ${contractNo}`, type: 'contract' });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={{ fontSize: 18 }}>📄</span>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>สัญญาเช่าฉบับปัจจุบัน</div>
          <Pill color="success" size="sm">มีผลบังคับใช้</Pill>
        </div>
        <DefList
          columns={2}
          items={[
            { label: 'หมายเลขสัญญา', value: contractNo },
            { label: 'ระยะเวลาสัญญา', value: '12 เดือน' },
            { label: 'วันที่เริ่มต้น',    value: t.since },
            { label: 'วันที่สิ้นสุด',     value: t.contractEnd },
            { label: 'ค่าเช่า/เดือน',     value: fmtCurrency(t.rent), bold: true },
            { label: 'เงินมัดจำ',         value: fmtCurrency(t.rent * 2) },
          ]}
        />
        <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Btn variant="secondary" size="sm" icon="📥" onClick={handleDownload}>ดาวน์โหลด</Btn>
          <Btn variant="ghost" size="sm" icon="✎" onClick={() => setToast && setToast({ kind: 'info', message: 'แก้ไขสัญญาทำได้จากหน้าห้องพัก' })}>แก้ไขสัญญา</Btn>
          <Btn variant="ghost" size="sm" icon="↻" onClick={() => {
            setToast && setToast({ kind: 'success', message: `เริ่มกระบวนการต่อสัญญาห้อง ${t.roomId}` });
            addActivity && addActivity({ icon: '↻', text: `เริ่มต่อสัญญาห้อง ${t.roomId} (${t.name})`, type: 'contract' });
          }}>ต่อสัญญา</Btn>
        </div>
      </Card>
    </div>
  );
}

function TabBills({ t }) {
  const C = window.ADMIN_C;
  const { fmtCurrency } = window;
  const { DataTable, Pill, Btn } = window;

  // Generate sample 6-month bill history
  const bills = useMemo(() => {
    const now = new Date();
    return [0,1,2,3,4,5].map(i => {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
      return {
        id: `INV-${t.roomId}-${(d.getFullYear()+543).toString().slice(-2)}${(d.getMonth()+1).toString().padStart(2,'0')}`,
        period: `${months[d.getMonth()]} ${d.getFullYear()+543}`,
        amount: t.rent + (t.room?.water || 0) + (t.room?.elec || 0) + (t.room?.wifi || 250),
        status: i === 0 && t.status === 'overdue' ? 'unpaid' : 'paid',
      };
    });
  }, [t]);

  const columns = [
    { key: 'id', label: 'เลขที่บิล', minWidth: 140, render: b => <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>{b.id}</span> },
    { key: 'period', label: 'งวด',  minWidth: 100 },
    { key: 'amount', label: 'จำนวน', align: 'right', minWidth: 110, render: b => <span style={{ fontWeight: 600 }}>{fmtCurrency(b.amount)}</span> },
    { key: 'status', label: 'สถานะ', minWidth: 100, render: b => <Pill color={b.status === 'paid' ? 'success' : 'danger'} size="sm">{b.status === 'paid' ? 'ชำระแล้ว' : 'ค้างชำระ'}</Pill> },
  ];

  return (
    <div>
      <DataTable columns={columns} rows={bills} density="compact" stickyHeader={false} />
    </div>
  );
}

function TabNotes({ t, setRooms, setToast, addActivity }) {
  const C = window.ADMIN_C;
  const { Textarea, Btn } = window;
  const [notes, setNotes] = useState(t.room?.notes || '');
  React.useEffect(() => { setNotes(t.room?.notes || ''); }, [t.roomId]);

  const dirty = notes !== (t.room?.notes || '');

  const save = () => {
    setRooms && setRooms(prev => ({ ...prev, [t.roomId]: { ...prev[t.roomId], notes } }));
    setToast && setToast({ kind: 'success', message: 'บันทึกหมายเหตุเรียบร้อย' });
    addActivity && addActivity({ icon: '📝', text: `อัปเดตหมายเหตุห้อง ${t.roomId} (${t.name})`, type: 'tenant' });
  };

  return (
    <div>
      <Textarea
        label={`บันทึกเกี่ยวกับ ${t.name}`}
        value={notes}
        onChange={setNotes}
        rows={6}
        placeholder="เช่น เป็นนักศึกษาขยัน ชำระตรงเวลาทุกเดือน ไม่มีปัญหาเรื่องเสียงดัง"
      />
      <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        {dirty && <Btn variant="ghost" size="sm" onClick={() => setNotes(t.room?.notes || '')}>ยกเลิก</Btn>}
        <Btn variant="primary" size="sm" disabled={!dirty} onClick={save}>
          {dirty ? 'บันทึก' : 'บันทึกแล้ว'}
        </Btn>
      </div>
    </div>
  );
}

window.PageTenants = PageTenants;
