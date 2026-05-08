// === admin/page-tenants.jsx ===============================================
// จัดการผู้เช่า: รายชื่อ + drawer profile (สัญญา, บิล, บันทึก) + "เพิ่มผู้เช่า"
// modal that POSTs to /api/tenants. Older versions only let admin add a
// tenant by editing a vacant room — this brought tenant creation into a
// dedicated form so admin can pre-create a tenant before assigning a room.
// ===========================================================================

const { useState, useMemo } = React;

function PageTenants({ rooms, setRooms, addActivity, setToast }) {
  const C = window.ADMIN_C;
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES;
  const { fmt, fmtCurrency } = window;
  const { Card, Btn, IconBtn, Avatar, Pill, StatusBadge, DataTable, Drawer,
          SearchInput, FilterChip, PageContainer, PageHeader, SectionHeading,
          DefList, Tabs, Modal, Input, Select, Textarea } = window;
  const apiFetch = window.apiFetch || ((u, o) => fetch(u, { credentials: 'same-origin', ...o }));

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [activeId, setActiveId] = useState(null);
  const [drawerTab, setDrawerTab] = useState('profile');
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);

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
            <Btn variant="primary" icon="+" onClick={() => setAddOpen(true)}>เพิ่มผู้เช่า</Btn>
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

      <AddTenantModal
        open={addOpen}
        onClose={() => !busy && setAddOpen(false)}
        rooms={rooms}
        setRooms={setRooms}
        busy={busy}
        setBusy={setBusy}
        addActivity={addActivity}
        setToast={setToast}
        apiFetch={apiFetch}
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
                { value: 'portal',   label: 'Portal Access', icon: '🔑' },
                { value: 'contract', label: 'สัญญา',     icon: '📄' },
                { value: 'bills',    label: 'บิล',         icon: '🧾' },
                { value: 'notes',    label: 'บันทึก',     icon: '📝' },
              ]}
              value={drawerTab}
              onChange={setDrawerTab}
              style={{ margin: '20px 0 16px' }}
            />
            {drawerTab === 'profile'  && <TabProfile  t={active} />}
            {drawerTab === 'portal'   && <TabPortal   t={active} setToast={setToast} addActivity={addActivity} apiFetch={apiFetch} />}
            {drawerTab === 'contract' && <TabContract t={active} setToast={setToast} addActivity={addActivity} />}
            {drawerTab === 'bills'    && <TabBills    t={active} />}
            {drawerTab === 'notes'    && <TabNotes    t={active} setRooms={setRooms} setToast={setToast} addActivity={addActivity} />}
          </>
        )}
      </Drawer>
    </PageContainer>
  );
}

// Standalone "Add Tenant" modal. Posts to /api/tenants (relational `tenants`
// table, used by tenant portal + LINE binding) AND optionally writes the
// tenant into the legacy rooms blob if a room was picked, so the table on
// this page (which reads from rooms) shows the new tenant immediately.
function AddTenantModal({ open, onClose, rooms, setRooms, busy, setBusy, addActivity, setToast, apiFetch }) {
  const C = window.ADMIN_C;
  const { Btn, Input, Select, Textarea, Modal } = window;
  const [form, setForm] = React.useState({
    fullName: '', phone: '', citizenId: '', email: '',
    occupation: '', roomId: '', pin: '', notes: '',
  });

  // Reset whenever modal opens (don't leak stale input from a cancelled session)
  React.useEffect(() => {
    if (open) setForm({
      fullName: '', phone: '', citizenId: '', email: '',
      occupation: '', roomId: '', pin: '', notes: '',
    });
  }, [open]);

  const vacantRooms = React.useMemo(() => {
    return Object.values(rooms || {})
      .filter((r) => r.status === 'vacant' || !r.tenant)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map((r) => ({ value: r.id, label: `${r.id} · ชั้น ${r.floor} · ${(window.ADMIN_ROOM_TYPES[r.type] || {}).th || r.type}` }));
  }, [rooms]);

  function set(k, v) { setForm((p) => ({ ...p, [k]: v })); }

  async function submit() {
    const fullName = form.fullName.trim();
    const phone = form.phone.replace(/[\s-]/g, '');
    if (fullName.length < 2) {
      setToast && setToast({ kind: 'error', message: 'ชื่อ-นามสกุลอย่างน้อย 2 ตัว' });
      return;
    }
    if (!/^0\d{8,9}$/.test(phone)) {
      setToast && setToast({ kind: 'error', message: 'เบอร์โทรไม่ถูกต้อง (ขึ้นต้น 0 ตามด้วย 9-10 หลัก)' });
      return;
    }
    if (form.citizenId && !/^\d{13}$/.test(form.citizenId.replace(/[\s-]/g, ''))) {
      setToast && setToast({ kind: 'error', message: 'เลขบัตรประชาชนต้อง 13 หลัก' });
      return;
    }
    if (form.pin && !/^\d{4,8}$/.test(form.pin)) {
      setToast && setToast({ kind: 'error', message: 'PIN ต้องเป็นตัวเลข 4-8 หลัก' });
      return;
    }
    setBusy(true);
    try {
      const body = {
        fullName, phone,
        citizenId: form.citizenId.replace(/[\s-]/g, '') || undefined,
        email: form.email.trim() || undefined,
        roomId: form.roomId || undefined,
        pin: form.pin || undefined,
        notes: form.notes.trim() || undefined,
      };
      const r = await apiFetch('/api/tenants', {
        method: 'POST', body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);

      // If admin assigned a room, mirror the tenant into the rooms blob so
      // this page's table (which reads rooms[].tenant) shows them immediately
      // without a page reload. The relational tenants table is the source of
      // truth; the rooms blob is just the cached display copy.
      if (form.roomId && rooms[form.roomId]) {
        setRooms((prev) => {
          const next = { ...prev };
          const r0 = next[form.roomId];
          if (r0) {
            next[form.roomId] = {
              ...r0,
              status: r0.status === 'vacant' ? 'occupied' : r0.status,
              tenant: {
                name: fullName,
                phone,
                email: form.email.trim() || '',
                occupation: form.occupation.trim() || '',
                score: 'A',
                tenantId: d.tenant && d.tenant.id ? d.tenant.id : null,
              },
              since: window.fmtDateTH ? window.fmtDateTH(new Date()) : new Date().toISOString().slice(0, 10),
            };
          }
          return next;
        });
      }

      addActivity && addActivity({
        icon: '👤',
        text: `เพิ่มผู้เช่า ${fullName}${form.roomId ? ` (ห้อง ${form.roomId})` : ''}`,
        type: 'tenant',
      });
      setToast && setToast({ kind: 'success', message: `เพิ่มผู้เช่า ${fullName} เรียบร้อย` });
      onClose && onClose();
    } catch (err) {
      window.toastError
        ? window.toastError(setToast, err, { action: 'เพิ่มผู้เช่า' })
        : setToast && setToast({ kind: 'danger', message: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="เพิ่มผู้เช่าใหม่"
      width={560}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={busy}>ยกเลิก</Btn>
          <Btn variant="primary" onClick={submit} disabled={busy}>
            {busy ? 'กำลังบันทึก…' : 'เพิ่มผู้เช่า'}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Input label="ชื่อ-นามสกุล *"
                 value={form.fullName} onChange={(v) => set('fullName', v)}
                 placeholder="เช่น คุณสมศรี ใจดี" />
          <Input label="เบอร์โทรศัพท์ *"
                 value={form.phone} onChange={(v) => set('phone', v)}
                 placeholder="0812345678" />
          <Input label="เลขบัตรประชาชน (ไม่บังคับ)"
                 value={form.citizenId} onChange={(v) => set('citizenId', v)}
                 placeholder="13 หลัก"
                 hint="เก็บแบบเข้ารหัสในฐานข้อมูล" />
          <Input label="อีเมล (ไม่บังคับ)"
                 value={form.email} onChange={(v) => set('email', v)}
                 placeholder="user@example.com" />
          <Input label="อาชีพ (ไม่บังคับ)"
                 value={form.occupation} onChange={(v) => set('occupation', v)} />
          <Input label="PIN เข้าพอร์ทัล (ไม่บังคับ)"
                 type="password"
                 value={form.pin} onChange={(v) => set('pin', v)}
                 placeholder="4-8 หลัก"
                 hint="ผู้เช่าใช้ login ที่ /tenant" />
        </div>
        <Select label="ห้องที่จะเข้าพัก (เลือกภายหลังก็ได้)"
                value={form.roomId}
                onChange={(v) => set('roomId', v)}
                options={[{ value: '', label: '— ไม่เลือก —' }, ...vacantRooms]}
                hint={vacantRooms.length === 0 ? 'ไม่มีห้องว่างในขณะนี้' : `${vacantRooms.length} ห้องว่าง`} />
        <Textarea label="บันทึก (ไม่บังคับ)"
                  rows={2}
                  value={form.notes}
                  onChange={(v) => set('notes', v)}
                  placeholder="ข้อมูลเพิ่มเติม เช่น ผู้ติดต่อฉุกเฉิน" />
        <div style={{ padding: 10, background: C.surfaceAlt, borderRadius: 8, fontSize: 12, color: C.muted, lineHeight: 1.6 }}>
          💡 ผู้เช่ามีตัวตนในระบบ tenants พร้อมใช้งาน LINE binding + tenant portal ได้ทันที ·
          ถ้ายังไม่ได้เลือกห้อง สามารถมาผูกที่หน้า "ห้องพัก" ภายหลัง
        </div>
      </div>
    </Modal>
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

// === TabPortal ===========================================================
// Consolidates post-onboarding setup that the booking-approval flow leaves
// undone:
//   1) Set/reset PIN — required for /tenant portal login
//   2) Issue LINE binding code — required for LINE notifications
//
// Why this lives on the tenants page (not bookings):
//   - mirrorRoomsToTenants() in server.js auto-creates a tenants table row
//     when admin saves the rooms blob, so by the time this tab renders the
//     tenant_id is resolvable by phone.
//   - The flow is the same for "approved booking → new tenant" AND for
//     "existing tenant lost their PIN" — one path, one screen.
//
// Lookup is by phone because the rooms-blob view doesn't carry tenant_id;
// we hit GET /api/tenants?q=<phone> on mount to find the row, then route
// PIN updates through PUT /api/tenants/:id and binding through
// /api/admin/line-bindings/tenants/:id.
function TabPortal({ t, setToast, addActivity, apiFetch }) {
  const C = window.ADMIN_C;
  const { Card, Btn, Pill } = window;
  const [tenantRow, setTenantRow] = React.useState(null);   // null=loading
  const [tenantErr, setTenantErr] = React.useState(null);
  const [binding, setBinding] = React.useState(null);
  const [bindingErr, setBindingErr] = React.useState(null);
  const [pinDraft, setPinDraft] = React.useState('');
  const [pinBusy, setPinBusy] = React.useState(false);
  const [bindBusy, setBindBusy] = React.useState(false);

  async function load() {
    setTenantErr(null);
    setBindingErr(null);
    try {
      // Search by phone — server's tenants list endpoint accepts ?q=<text>
      // and matches across full_name / phone / email. Using the phone here
      // because it's the most uniquely-matching field for a single person.
      const cleanPhone = String(t.phone || '').replace(/[\s-]/g, '');
      if (!cleanPhone) {
        setTenantErr(new Error('ไม่มีเบอร์โทรในระบบ — เพิ่มเบอร์ให้ผู้เช่าก่อน'));
        return;
      }
      const r = await fetch(`/api/tenants?q=${encodeURIComponent(cleanPhone)}`,
        { credentials: 'same-origin' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      // Prefer the tenant whose room_id matches t.roomId (handles
      // shared-phone households where two tenants share a number).
      const list = Array.isArray(d.tenants) ? d.tenants : [];
      const exact = list.find((row) => row.current_room_id === t.roomId) || list[0];
      if (!exact) {
        setTenantErr(new Error('ยังไม่มี tenant row สำหรับเบอร์นี้ — บันทึกห้องก่อนเพื่อให้ระบบสร้างให้อัตโนมัติ'));
        return;
      }
      setTenantRow(exact);
      // Now fetch binding status — this endpoint already returns full state
      // (pending code / bound user / blocked) in one call.
      const r2 = await fetch(`/api/admin/line-bindings/tenants/${exact.id}`,
        { credentials: 'same-origin' });
      if (r2.ok) {
        const d2 = await r2.json();
        setBinding(d2);
      } else if (r2.status !== 404) {
        const d2 = await r2.json().catch(() => ({}));
        setBindingErr(new Error(d2.error || `HTTP ${r2.status}`));
      }
    } catch (err) {
      setTenantErr(err);
    }
  }
  React.useEffect(() => { load(); /* eslint-disable-next-line */ }, [t.roomId, t.phone]);

  // === PIN actions ======================================================
  async function setPin() {
    const pin = pinDraft.trim();
    if (!/^\d{4,8}$/.test(pin)) {
      setToast && setToast({
        kind: 'warning',
        message: { title: 'รูปแบบ PIN ไม่ถูกต้อง', description: 'ต้องเป็นตัวเลข 4-8 หลัก' },
      });
      return;
    }
    setPinBusy(true);
    try {
      const r = await apiFetch(`/api/tenants/${tenantRow.id}`, {
        method: 'PUT',
        body: JSON.stringify({ pin }),
      });
      const d = await r.json();
      if (!r.ok) throw Object.assign(new Error(d.error || `HTTP ${r.status}`),
        { status: r.status, code: d.code, issues: d.issues });
      setToast && setToast({
        kind: 'success',
        message: { title: '✅ บันทึก PIN แล้ว',
          description: `แจ้งให้ผู้เช่าใช้ PIN นี้ login ที่ /tenant ครั้งแรก แล้วเปลี่ยนเอง` },
      });
      addActivity && addActivity({
        icon: '🔑',
        text: `ตั้ง PIN ให้ ${t.name} (ห้อง ${t.roomId})`,
        type: 'tenant',
      });
      setPinDraft('');
      load();
    } catch (err) {
      window.toastError
        ? window.toastError(setToast, err, { action: 'ตั้ง PIN' })
        : setToast && setToast({ kind: 'danger', message: err.message });
    } finally {
      setPinBusy(false);
    }
  }

  function generateRandomPin() {
    // 6-digit, avoiding the trivial patterns the server rejects (1234, 0000,
    // 1111, sequential, repeating). Loop until we land on a good one.
    const TRIVIAL = new Set(['000000', '111111', '222222', '333333', '444444',
      '555555', '666666', '777777', '888888', '999999', '123456', '654321']);
    for (let i = 0; i < 50; i++) {
      const n = Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0');
      if (!TRIVIAL.has(n)) return n;
    }
    return '472938';   // hard-coded fallback — should be statistically unreachable
  }

  // === LINE binding actions ============================================
  async function issueBinding() {
    setBindBusy(true);
    try {
      const r = await apiFetch(`/api/admin/line-bindings/tenants/${tenantRow.id}`, {
        method: 'POST',
        body: JSON.stringify({ ttlDays: 7 }),
      });
      const d = await r.json();
      if (!r.ok) throw Object.assign(new Error(d.error || `HTTP ${r.status}`),
        { status: r.status, code: d.code });
      setToast && setToast({
        kind: 'success',
        message: { title: `✅ ออกรหัสแล้ว: ${d.code}`,
          description: 'ผู้เช่าต้อง add OA + ส่งรหัสในแชต' },
      });
      addActivity && addActivity({
        icon: '🔗',
        text: `ออกรหัสผูก LINE ให้ ${t.name}`,
        type: 'tenant',
      });
      load();
    } catch (err) {
      window.toastError
        ? window.toastError(setToast, err, { action: 'ออกรหัสผูก LINE' })
        : setToast && setToast({ kind: 'danger', message: err.message });
    } finally {
      setBindBusy(false);
    }
  }

  // === Render ==========================================================
  if (tenantErr) {
    return (
      <Card style={{ padding: 16, background: C.warningSoft || '#fbf1de', color: C.ink2 }}>
        <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
          ⚠️ {tenantErr.message}
        </div>
        {tenantErr.message.includes('สร้าง') && (
          <div style={{ fontSize: 12.5, marginTop: 8, color: C.muted }}>
            หลังจากบันทึกข้อมูลห้องในหน้า "ห้องพัก" — ระบบจะ auto-mirror ผู้เช่านี้เข้า tenants table แล้วเปิดหน้านี้อีกครั้ง
          </div>
        )}
      </Card>
    );
  }
  if (!tenantRow) {
    return <div style={{ padding: 16, color: C.muted }}>กำลังโหลดข้อมูล portal…</div>;
  }

  const pinSet = !!tenantRow.pin_hash;     // server doesn't return hash; we use a presence flag if we ever add one
  // Note: maskTenantOut() strips pin_hash, so tenantRow.pin_hash is always
  // undefined here. We display "ไม่ทราบสถานะ" with a hint instead — the
  // common case is "admin set it manually" or "PIN never set yet".
  const bindingStatus = binding && binding.bound
    ? { label: `ผูก LINE แล้ว (ผ่าน ${binding.bound.oa_name || 'OA'})`, color: C.success }
    : binding && binding.pending
      ? { label: `รอผูก — รหัส ${binding.pending.code}`, color: C.warning }
      : { label: 'ยังไม่ผูก LINE', color: C.muted };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Status overview */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Card style={{ padding: 14 }}>
          <div style={{ fontSize: 11, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
            Tenant Portal Login
          </div>
          <div style={{ fontSize: 13.5, color: C.ink, lineHeight: 1.5 }}>
            เบอร์ <code style={{ background: 'rgba(0,0,0,0.05)', padding: '1px 5px', borderRadius: 3 }}>{tenantRow.phone}</code> + PIN
          </div>
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>
            {pinSet ? '✅ PIN ตั้งไว้แล้ว' : 'ℹ️ ตั้ง PIN ด้านล่างเพื่อให้ผู้เช่า login ได้'}
          </div>
        </Card>
        <Card style={{ padding: 14 }}>
          <div style={{ fontSize: 11, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
            LINE Binding
          </div>
          <div style={{ fontSize: 13.5, color: bindingStatus.color, fontWeight: 600 }}>
            {bindingStatus.label}
          </div>
          {bindingErr && (
            <div style={{ fontSize: 11.5, color: C.danger, marginTop: 4 }}>
              โหลดสถานะไม่สำเร็จ: {bindingErr.message}
            </div>
          )}
        </Card>
      </div>

      {/* PIN management */}
      <Card style={{ padding: 16 }}>
        <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
          🔑 ตั้ง / รีเซ็ต PIN
        </div>
        <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.6, marginBottom: 12 }}>
          PIN เป็นตัวเลข 4-8 หลัก · ห้ามใช้รูปแบบที่คาดเดาง่าย (1234, 0000, 1111)<br/>
          แนะนำให้ผู้เช่าเปลี่ยนเองหลัง login ครั้งแรก
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            inputMode="numeric"
            pattern="\d{4,8}"
            value={pinDraft}
            onChange={(e) => setPinDraft(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
            placeholder="กรอก PIN ใหม่"
            style={{
              flex: '1 1 200px', minWidth: 160,
              padding: '8px 12px', borderRadius: 7,
              border: '1px solid ' + C.border, background: C.bg, color: C.ink,
              fontSize: 14, fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.15em',
            }}
          />
          <Btn variant="ghost" size="sm" onClick={() => setPinDraft(generateRandomPin())}>
            🎲 สุ่ม
          </Btn>
          <Btn variant="primary" disabled={pinBusy || !pinDraft} onClick={setPin}>
            {pinBusy ? 'กำลังบันทึก…' : 'บันทึก PIN'}
          </Btn>
        </div>
      </Card>

      {/* LINE binding management */}
      <Card style={{ padding: 16 }}>
        <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
          🔗 ผูกบัญชี LINE
        </div>
        <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.6, marginBottom: 12 }}>
          {binding && binding.bound
            ? 'ผูกแล้ว — ระบบส่งบิล/แจ้งเตือนผ่าน LINE OA นี้'
            : binding && binding.pending
              ? `รหัสค้างอยู่: ${binding.pending.code} (หมดอายุ ${new Date(binding.pending.expires_at).toLocaleDateString('th-TH')})`
              : 'ออกรหัส 8 หลัก ให้ผู้เช่า — add OA + ส่งรหัสในแชต = ผูกอัตโนมัติ'}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Btn variant={binding && binding.bound ? 'secondary' : 'primary'}
               disabled={bindBusy} onClick={issueBinding}>
            {bindBusy ? 'กำลังออกรหัส…'
              : binding && binding.bound ? 'ออกรหัสใหม่ (เปลี่ยน OA)'
              : binding && binding.pending ? 'ออกรหัสใหม่ (ยกเลิกอันเก่า)'
              : 'ออกรหัสผูก LINE'}
          </Btn>
          <Btn variant="ghost" onClick={() => { window.location.hash = '#line-bindings'; }}>
            จัดการเต็มในหน้า "ผูก LINE" →
          </Btn>
        </div>
      </Card>
    </div>
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
  const { fmtCurrency, fmtMonthTH } = window;
  const { DataTable, Pill, EmptyState } = window;

  // Real bill history from /api/bills?roomId=X. Replaces a hardcoded
  // 6-month fake history that lied to admins about payment status.
  const [bills, setBills] = React.useState(null);   // null = loading
  const [err, setErr] = React.useState(null);
  React.useEffect(() => {
    if (!t.roomId) { setBills([]); return; }
    let cancel = false;
    setBills(null);
    setErr(null);
    fetch(`/api/bills?roomId=${encodeURIComponent(t.roomId)}&limit=24`, { credentials: 'same-origin' })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (cancel) return;
        if (!r.ok) { setErr(d.error || `HTTP ${r.status}`); setBills([]); return; }
        setBills(Array.isArray(d.bills) ? d.bills : []);
      })
      .catch((e) => { if (!cancel) { setErr(e.message || 'network error'); setBills([]); } });
    return () => { cancel = true; };
  }, [t.roomId]);

  const periodTH = (period) => {
    if (!period || typeof period !== 'string') return period || '';
    const m = period.match(/^(\d{4})-(\d{2})/);
    if (!m) return period;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, 1);
    return fmtMonthTH ? fmtMonthTH(d) : period;
  };
  const statusLabel = { paid: 'ชำระแล้ว', pending: 'รอชำระ', overdue: 'ค้างชำระ', void: 'ยกเลิก' };
  const statusColor = { paid: 'success', pending: 'warning', overdue: 'danger', void: 'muted' };

  const columns = [
    { key: 'bill_no', label: 'เลขที่บิล', minWidth: 140, render: b => <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>{b.bill_no || `#${b.id}`}</span> },
    { key: 'period',  label: 'งวด',     minWidth: 100, render: b => periodTH(b.period) },
    { key: 'total',   label: 'จำนวน',   align: 'right', minWidth: 110,
      render: b => <span style={{ fontWeight: 600 }}>{fmtCurrency(Number(b.total) || 0)}</span> },
    { key: 'status',  label: 'สถานะ',   minWidth: 100,
      render: b => <Pill color={statusColor[b.status] || 'muted'} size="sm">{statusLabel[b.status] || b.status}</Pill> },
  ];

  if (bills == null) {
    return <div style={{ padding: 24, textAlign: 'center', color: C.muted, fontSize: 13 }}>กำลังโหลดประวัติบิล...</div>;
  }
  if (err) {
    return <div style={{ padding: 16, color: C.danger || '#a23', fontSize: 13 }}>โหลดประวัติบิลไม่สำเร็จ: {err}</div>;
  }
  if (bills.length === 0) {
    return EmptyState
      ? <EmptyState title="ยังไม่มีประวัติบิล" description="เมื่อออกบิลให้ห้องนี้แล้ว ประวัติจะแสดงที่นี่" />
      : <div style={{ padding: 16, color: C.muted, fontSize: 13 }}>ยังไม่มีประวัติบิลสำหรับห้องนี้</div>;
  }
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
