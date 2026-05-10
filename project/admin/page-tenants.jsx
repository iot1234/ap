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
        onTenantCreated={(roomId) => {
          // Auto-open the new tenant's drawer on the contract tab so admin
          // can send the link immediately — all fields auto-pulled from
          // the row they just created. Closes the "ข้ามไปมา" gap on the
          // tenant-onboarding flow.
          if (roomId) {
            setActiveId(roomId);
            setDrawerTab('contract');
          }
        }}
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
            {drawerTab === 'contract' && <TabContract t={active} setToast={setToast} addActivity={addActivity} setRooms={setRooms} onClosed={() => setActiveId(null)} />}
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
function AddTenantModal({ open, onClose, rooms, setRooms, busy, setBusy, addActivity, setToast, apiFetch, onTenantCreated }) {
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

    // Pre-flight duplicate check: hit /api/tenants?q=<phone> to see if the
    // phone is already on a tenant row. The server's mirrorRoomsToTenants
    // bridge can ALSO create rows from a rooms-blob save, so it's possible
    // for an admin to type the same phone twice (e.g. once via this modal,
    // once via the rooms editor) — without this check the second submit
    // creates a duplicate tenant row and the LINE binding flow gets
    // confused about which row to look up.
    setBusy(true);
    try {
      const dupRes = await fetch(`/api/tenants?q=${encodeURIComponent(phone)}`,
        { credentials: 'same-origin' });
      if (dupRes.ok) {
        const dupData = await dupRes.json();
        const dupes = (dupData.tenants || []).filter((t) => {
          // Server may match on full_name / email substrings too — narrow to
          // exact phone match (after the same strip we did on submit).
          const tphone = String(t.phone || '').replace(/[\s-]/g, '');
          return tphone === phone;
        });
        if (dupes.length > 0) {
          const existing = dupes[0];
          // Same name? probably the same person re-typed → block silently
          // with a clear "already exists" message + link to existing row.
          // Different name? warn but allow (shared-phone household — common
          // case in Thai dorms where parents/kids share a contact number).
          const sameName = String(existing.full_name || '').toLowerCase().trim()
            === fullName.toLowerCase();
          if (sameName) {
            setBusy(false);
            setToast && setToast({
              kind: 'danger',
              message: {
                title: `เบอร์ ${phone} อยู่ในระบบแล้ว`,
                description: `ผู้เช่า "${existing.full_name}" — ไม่ต้องเพิ่มใหม่`,
                action: {
                  label: 'ดูข้อมูลผู้เช่าเดิม →',
                  onClick: () => { window.location.hash = '#tenants'; onClose && onClose(); },
                },
              },
            });
            return;
          }
          // Different name → confirm it's intentional (shared phone household)
          const ok = window.confirm(
            `⚠ เบอร์ ${phone} ใช้อยู่กับ:\n` +
            dupes.map((t) => `  • ${t.full_name}${t.current_room_id ? ` (ห้อง ${t.current_room_id})` : ''}`).join('\n') +
            `\n\nจะเพิ่ม "${fullName}" ที่ใช้เบอร์เดียวกันใช่หรือไม่?\n` +
            `(ใช้เมื่อพ่อแม่/ลูกใช้เบอร์เดียวกัน — ต่างคนกัน)`
          );
          if (!ok) { setBusy(false); return; }
        }
      }
    } catch { /* fail-soft — duplicate check shouldn't block on network error */ }

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
      setToast && setToast({
        kind: 'success',
        message: form.roomId
          ? `เพิ่มผู้เช่า ${fullName} แล้ว — เปิดหน้าสัญญาให้อัตโนมัติ`
          : `เพิ่มผู้เช่า ${fullName} เรียบร้อย`,
      });
      // Bubble the assigned roomId back to PageTenants so it can open the
      // drawer on the contract tab. Tenant data is already in the rooms
      // blob (via setRooms above) so TabContract will resolve it on render.
      if (form.roomId && onTenantCreated) onTenantCreated(form.roomId);
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
    // If a PIN already exists (we can infer from a prior bind state or
    // from tenantRow having any portal session activity), require explicit
    // confirmation — admin shouldn't overwrite a working PIN by accident
    // when they meant to type into a different field.
    // We can't read pin_hash directly (server strips it), so we assume
    // "PIN exists" if the tenant has logged in before (session row would
    // exist) or if the binding state shows portal activity. Cheap proxy:
    // ask any time the input was filled deliberately.
    const ok = window.confirm(
      `ตั้ง PIN เป็น "${pin}" ให้ผู้เช่า ${t.name}?\n\n` +
      `📌 ถ้ามี PIN เดิมอยู่ จะถูกแทนที่ทันที — ผู้เช่าจะใช้ PIN เก่า login ไม่ได้อีก\n` +
      `📌 แจ้งให้ผู้เช่าเปลี่ยน PIN เองหลัง login ครั้งแรก (ห้ามใช้ PIN ที่บอกออกไปนาน ๆ)\n\n` +
      `ดำเนินการต่อ?`
    );
    if (!ok) return;

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

// Replaces the previous hardcoded "fake contract no" view with one that
// actually pulls from /api/contracts. When no contract exists, renders a
// check-in form that POSTs /api/tenants/:id/checkin (the route that
// records contract + monthly_rent + deposit + termMonths + discountPct).
// Without this entry point, the contracts table stayed empty, the
// contract-expiry alert had nothing to fire on, and the contract-length
// discount was uncon­figurable from the UI.
// Single hub for everything contract-related on a tenant: create / send link /
// review / approve / sign — no jumping to /admin#contracts or
// /admin#contract-invitations. Room + rent are auto-mapped from the tenant's
// current room (`t.roomId`, `t.rent`) so admin doesn't re-pick the room.
function TabContract({ t, setToast, addActivity, setRooms, onClosed }) {
  const C = window.ADMIN_C;
  const { fmtCurrency } = window;
  const { Card, DefList, Btn, Pill } = window;
  const apiCall = window.apiCall;
  const [contract, setContract] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [tenantDbId, setTenantDbId] = React.useState(null);
  const [showCheckin, setShowCheckin] = React.useState(false);
  const [showEdit, setShowEdit] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  // Just-created invitation URL — token is only revealed once on creation
  // (security feature), so we keep it in component state until tab close.
  const [liveLink, setLiveLink] = React.useState(null);
  const [copied, setCopied] = React.useState(false);
  // Submitted invitation detail loaded lazily for the inline review panel.
  const [reviewing, setReviewing] = React.useState(null);
  // Error from the last approve attempt — surfaced inline in the panel so
  // admin can see WHY the action failed (room conflict / citizen-ID dup /
  // missing data) without the toast disappearing.
  const [approveError, setApproveError] = React.useState(null);
  // Cancel-contract modal state. Holds the reason text while the admin
  // types it; cleared on close.
  const [cancelling, setCancelling] = React.useState(false);
  const [cancelReason, setCancelReason] = React.useState('');

  // Defensive: reset per-tenant transient state whenever the admin switches
  // to a different tenant in the drawer. Without this, a freshly-created
  // liveLink for tenant A would briefly leak into tenant B's view if React
  // reuses the component instance.
  React.useEffect(() => {
    setLiveLink(null);
    setReviewing(null);
    setShowCheckin(false);
    setShowEdit(false);
    setCopied(false);
    setApproveError(null);
    setCancelling(false);
    setCancelReason('');
  }, [t.phone]);

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      const normalisePhone = (s) => String(s || '').replace(/[\s-]/g, '');
      let tid = null;
      try {
        const phone = normalisePhone(t.phone);
        const tRes = await apiCall(`/api/tenants?q=${encodeURIComponent(phone)}`);
        const match = (tRes.tenants || []).find((x) => normalisePhone(x.phone) === phone);
        if (match) tid = match.id;
      } catch { /* fall through */ }
      setTenantDbId(tid);
      if (!tid) { setContract(null); return; }
      const d = await apiCall(`/api/contracts?tenantId=${tid}&status=active`);
      setContract((d.contracts || [])[0] || null);
    } finally { setLoading(false); }
  }, [t.phone]);
  React.useEffect(() => { reload(); }, [reload]);

  const fmtDate = (s) => s ? new Date(s).toLocaleDateString('th-TH') : '-';

  const copyLink = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const el = document.createElement('input');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Send link for an existing draft contract — the contract row already
  // carries room/rent, server just needs to mint the token.
  const sendInviteForExistingContract = async () => {
    if (!contract) return;
    setBusy(true);
    try {
      const d = await apiCall(`/api/contracts/${contract.id}/invite-tenant`, {
        method: 'POST',
        body: JSON.stringify({ expiresInHours: 168 }),
      });
      setLiveLink({
        url: d.invitation.url,
        expiresAt: d.invitation.expiresAt,
        invitationId: d.invitation.id,
      });
      addActivity && addActivity({ icon: '📨',
        text: `ส่งลิงก์สัญญาให้ ${t.name} (ห้อง ${t.roomId})`, type: 'contract' });
      reload();
    } catch (err) {
      setToast && setToast({ kind: 'danger', message: 'สร้างลิงก์ล้มเหลว: ' + err.message });
    } finally { setBusy(false); }
  };

  // Create contract + send link in one shot, room/rent/deposit/move-in pulled
  // straight from the tenant's room context — no re-typing anything.
  const sendInviteForNewContract = async () => {
    if (!t.roomId) {
      setToast && setToast({ kind: 'danger', message: 'ผู้เช่ายังไม่มีห้อง — กำหนดห้องก่อน' });
      return;
    }
    // Rent comes from the rooms blob — should never be 0 for a real room,
    // but guard anyway so admin gets a clear "go fix the room" message
    // instead of an opaque server 400.
    const rent = Number(t.rent);
    if (!Number.isFinite(rent) || rent <= 0) {
      setToast && setToast({ kind: 'danger', message: {
        title: `ห้อง ${t.roomId} ยังไม่กำหนดค่าเช่า`,
        description: 'ไปหน้า "ห้องพัก" กำหนดค่าเช่าก่อน แล้วกลับมาส่งลิงก์',
      }});
      return;
    }
    setBusy(true);
    try {
      const d = await apiCall('/api/contracts/quick-invite', {
        method: 'POST',
        body: JSON.stringify({
          tenantName: t.name,
          tenantPhone: String(t.phone || '').replace(/[\s-]/g, ''),
          tenantEmail: t.email || null,
          roomId: t.roomId,
          monthlyRent: rent,
          deposit: rent * 2,
          moveInDate: new Date().toISOString().slice(0, 10),
          termMonths: 12,
          expiresInHours: 168,
        }),
      });
      setLiveLink({
        url: d.invitation.url,
        expiresAt: d.invitation.expiresAt,
        invitationId: d.invitation.id,
      });
      addActivity && addActivity({ icon: '✨',
        text: `สร้างสัญญา + ส่งลิงก์ให้ ${t.name} (ห้อง ${t.roomId})`, type: 'contract' });
      reload();
    } catch (err) {
      setToast && setToast({ kind: 'danger', message: 'สร้างสัญญาล้มเหลว: ' + err.message });
    } finally { setBusy(false); }
  };

  const revokeInvite = async () => {
    let invId = liveLink ? liveLink.invitationId : null;
    if (!invId && contract) {
      try {
        const d = await apiCall(`/api/admin/contract-invitations?status=active`);
        const found = (d.invitations || []).find((i) => i.contract_id === contract.id);
        if (found) invId = found.id;
      } catch { /* ignore */ }
    }
    if (!invId) return;
    if (!confirm('ยกเลิกลิงก์? ผู้เช่าจะใช้ลิงก์นี้ต่อไม่ได้')) return;
    setBusy(true);
    try {
      await apiCall(`/api/admin/contract-invitations/${invId}/revoke`, { method: 'POST' });
      setLiveLink(null);
      setToast && setToast({ kind: 'success', message: 'ยกเลิกลิงก์เรียบร้อย' });
      reload();
    } catch (err) {
      setToast && setToast({ kind: 'danger', message: 'ยกเลิกล้มเหลว: ' + err.message });
    } finally { setBusy(false); }
  };

  const openReview = async () => {
    if (!contract) return;
    setBusy(true);
    try {
      const list = await apiCall(`/api/admin/contract-invitations?status=submitted`);
      const found = (list.invitations || []).find((i) => i.contract_id === contract.id);
      if (!found) {
        setToast && setToast({ kind: 'danger', message: 'ไม่พบใบที่รอตรวจสอบ — refresh แล้วลองอีกครั้ง' });
        reload();
        return;
      }
      const d = await apiCall(`/api/admin/contract-invitations/${found.id}`);
      setReviewing(d.invitation);
    } catch (err) {
      setToast && setToast({ kind: 'danger', message: 'โหลดล้มเหลว: ' + err.message });
    } finally { setBusy(false); }
  };

  const approveSubmitted = async () => {
    if (!reviewing) return;
    if (!confirm('อนุมัติ + lock สัญญา? (กลับมาแก้ไม่ได้)')) return;
    setBusy(true);
    setApproveError(null);
    try {
      const result = await apiCall(`/api/admin/contract-invitations/${reviewing.id}/approve`,
        { method: 'POST' });
      setReviewing(null);
      setLiveLink(null);
      setToast && setToast({ kind: 'success', message: 'อนุมัติเรียบร้อย — สัญญาถูก lock' });
      addActivity && addActivity({ icon: '✓',
        text: `อนุมัติสัญญา ${contract && contract.contract_no} ของ ${t.name}`, type: 'contract' });
      if (result && result.nextActions && result.nextActions.pdfUrl) {
        window.open(result.nextActions.pdfUrl, '_blank', 'noopener');
      }
      reload();
    } catch (err) {
      // Server responses (CITIZEN_ID_DUPLICATE / ROOM_OCCUPIED / BAD_STATUS)
      // carry both error + hint; surface them inline in the review panel
      // so admin can act on the next-step guidance instead of guessing.
      const body = (err && err.body) || {};
      setApproveError({
        error: err.message || 'เกิดข้อผิดพลาด',
        hint: body.hint || null,
        code: err.code || body.code || null,
      });
      setToast && setToast({ kind: 'danger', message: 'อนุมัติล้มเหลว: ' + (err.message || '') });
    } finally { setBusy(false); }
  };

  // Cancel an active contract — sets status='ended' with today's endDate,
  // and the server cascades: tenant.status → 'moved_out', current_room_id
  // cleared, room.status → 'vacant' (both blob + rooms_v2). The reason is
  // audit-logged via the {reason} metadata so we have a paper trail
  // without adding a column to the contracts table.
  const cancelContract = async () => {
    if (!contract) return;
    const reason = (cancelReason || '').trim();
    if (!reason) {
      setToast && setToast({ kind: 'danger', message: 'กรุณาระบุเหตุผลก่อนยกเลิกสัญญา' });
      return;
    }
    setBusy(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      await apiCall(`/api/contracts/${contract.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          status: 'ended',
          endDate: today,
          cancelReason: reason,  // captured by audit log on the server side
        }),
      });
      setCancelling(false);
      setCancelReason('');
      setToast && setToast({
        kind: 'success',
        message: `ยกเลิกสัญญา ${contract.contract_no} แล้ว — ห้อง ${contract.room_id} ว่าง`,
      });
      addActivity && addActivity({
        icon: '🚫',
        text: `ยกเลิกสัญญา ${contract.contract_no} (${t.name}, ห้อง ${contract.room_id}) — ${reason.slice(0, 60)}`,
        type: 'contract',
      });
      // Update parent rooms state so this tenant disappears from the
      // tenants table immediately — the server already cascaded room
      // status='vacant' + tenant removed, but the client-side `rooms`
      // blob would stay stale until the next full refetch.
      if (setRooms && contract.room_id) {
        setRooms((prev) => {
          if (!prev || !prev[contract.room_id]) return prev;
          const next = { ...prev };
          next[contract.room_id] = {
            ...next[contract.room_id],
            tenant: null,
            status: 'vacant',
            since: null,
            contractEnd: null,
          };
          return next;
        });
      }
      // Drawer becomes detached anyway once `tenants` recomputes (this row
      // no longer has r.tenant). Close it explicitly so admin doesn't see
      // an empty drawer hanging open.
      if (onClosed) onClosed();
    } catch (err) {
      setToast && setToast({ kind: 'danger', message: 'ยกเลิกล้มเหลว: ' + err.message });
    } finally { setBusy(false); }
  };

  const rejectSubmitted = async (reason) => {
    if (!reviewing || !reason || !reason.trim()) return;
    setBusy(true);
    try {
      await apiCall(`/api/admin/contract-invitations/${reviewing.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      setReviewing(null);
      setToast && setToast({ kind: 'success', message: 'ส่งกลับให้ผู้เช่าแก้ไขแล้ว' });
      reload();
    } catch (err) {
      setToast && setToast({ kind: 'danger', message: 'ส่งกลับล้มเหลว: ' + err.message });
    } finally { setBusy(false); }
  };

  if (loading) {
    return <div style={{ padding: 20, color: C.muted }}>กำลังโหลด…</div>;
  }
  if (!tenantDbId) {
    return (
      <Card style={{ padding: 16 }}>
        <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.6 }}>
          ⚠️ ไม่พบผู้เช่ารายนี้ในตาราง <code>tenants</code> — อาจเป็นข้อมูลเก่าจาก rooms blob เท่านั้น
          <br />หากต้องการบันทึกสัญญา + ส่วนลด ให้สร้างผู้เช่าผ่าน "+ เพิ่มผู้เช่า" ก่อน
        </div>
      </Card>
    );
  }

  // Submitted-invitation review panel — replaces a separate page hop.
  if (reviewing) {
    return (
      <ContractReviewPanel
        detail={reviewing}
        busy={busy}
        approveError={approveError}
        onApprove={approveSubmitted}
        onReject={rejectSubmitted}
        onCancel={() => { setReviewing(null); setApproveError(null); }}
        C={C}
      />
    );
  }

  const liveLinkCard = liveLink ? (
    <Card style={{ padding: 14, background: '#e8f5e8', border: '1px solid #4a8b4a' }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#2d5a2c', marginBottom: 8 }}>
        ✅ ลิงก์พร้อมส่งให้ผู้เช่าแล้ว
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input readOnly value={liveLink.url}
          onFocus={(e) => e.target.select()}
          style={{ flex: 1, padding: '8px 10px', fontFamily: 'monospace',
                   fontSize: 11, border: '1px solid #ece4d4', borderRadius: 6,
                   background: '#fff', color: C.ink, minWidth: 0 }} />
        <Btn variant="primary" size="sm" onClick={() => copyLink(liveLink.url)}>
          {copied ? '✓ ก็อปแล้ว' : 'ก็อปลิงก์'}
        </Btn>
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
        หมดอายุ {new Date(liveLink.expiresAt).toLocaleString('th-TH', {
          year: 'numeric', month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit',
        })}<br/>
        🔒 ลิงก์นี้แสดงครั้งเดียว — ปิด drawer แล้วดูซ้ำไม่ได้ (สร้างใหม่จะ revoke ลิงก์เก่าอัตโนมัติ)
      </div>
      <Btn variant="ghost" size="sm" onClick={revokeInvite} disabled={busy}>
        ยกเลิกลิงก์นี้
      </Btn>
    </Card>
  ) : null;

  // No contract — give admin a clear 2-way fork. Show the room + tenant
  // details that the contract will inherit so admin sees the full picture
  // before sending (the user's "เเสดงรายละเอียดทั้งหมด" request).
  if (!contract) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {liveLinkCard}
        <Card style={{ padding: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
            📜 ยังไม่มีสัญญาเช่า — ตรวจรายละเอียดก่อนส่งลิงก์
          </div>
          <ContractPreFlightSummary t={t} C={C} fmtCurrency={fmtCurrency} />
          <div style={{ fontSize: 12, color: C.muted, margin: '10px 0 14px', lineHeight: 1.5 }}>
            ค่าเช่า ห้อง และข้อมูลผู้เช่าทั้งหมดดึงจากระบบให้แล้ว — แอดมินไม่ต้องกรอกซ้ำ
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <ContractActionTile
              icon="🔑"
              title="เช็คอินทันที"
              desc="แอดมินกรอกข้อมูลครบเอง — ใช้เมื่อมีบัตร/ที่อยู่ผู้เช่าอยู่แล้ว"
              onClick={() => setShowCheckin(true)}
              C={C}
            />
            <ContractActionTile
              icon="📨"
              title="ส่งลิงก์ให้ผู้เช่ากรอกเอง"
              desc="ผู้เช่าถ่ายบัตร เซ็น กรอกที่อยู่ผ่านมือถือเอง ไม่ต้องมาที่หอ"
              onClick={sendInviteForNewContract}
              busy={busy}
              C={C}
            />
          </div>
        </Card>
        {showCheckin ? (
          <CheckInModal
            tenantId={tenantDbId}
            tenant={t}
            onClose={() => setShowCheckin(false)}
            onDone={() => { setShowCheckin(false); reload();
              setToast && setToast({ kind: 'success', message: `เช็คอิน ${t.name} เรียบร้อย` });
              addActivity && addActivity({ icon: '🔑', text: `เช็คอิน ${t.name} (ห้อง ${t.roomId})`, type: 'contract' });
            }}
            onError={(msg) => setToast && setToast({ kind: 'danger', message: msg })}
          />
        ) : null}
      </div>
    );
  }

  // Contract exists — show details + state-aware actions.
  const isLocked = !!contract.locked_at;
  const invStatus = contract.active_invitation_status;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {liveLinkCard}

      {invStatus === 'submitted' ? (
        <Card style={{ padding: 14, background: '#fff7e0', border: '1px solid #f1b32d' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#6b4d10', marginBottom: 6 }}>
            ✓ ผู้เช่าส่งสัญญาให้ตรวจสอบแล้ว
          </div>
          <div style={{ fontSize: 13, color: '#6b4d10', marginBottom: 10, lineHeight: 1.5 }}>
            ตรวจสอบและอนุมัติได้ที่นี่เลย — ไม่ต้องไปหน้า "ใบเชิญ"
          </div>
          <Btn variant="primary" size="sm" onClick={openReview} disabled={busy}>
            ตรวจสอบ + อนุมัติ →
          </Btn>
        </Card>
      ) : (invStatus === 'pending' && !liveLink) ? (
        <Card style={{ padding: 14, background: '#e8f1f8', border: '1px solid #b6d2e6' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#234c66', marginBottom: 6 }}>
            📨 ลิงก์ส่งให้ผู้เช่าแล้ว — รอผู้เช่ากรอก
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
            ลิงก์ active ในระบบ — แต่ admin ดู URL เดิมไม่ได้แล้ว (เหตุผลความปลอดภัย)<br/>
            ถ้าผู้เช่าหาลิงก์ไม่เจอ ให้กด "สร้างลิงก์ใหม่" (ลิงก์เก่าจะถูกยกเลิกอัตโนมัติ)
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn variant="primary" size="sm" onClick={sendInviteForExistingContract} disabled={busy}>
              สร้างลิงก์ใหม่
            </Btn>
            <Btn variant="ghost" size="sm" onClick={revokeInvite} disabled={busy}>
              ยกเลิกลิงก์
            </Btn>
          </div>
        </Card>
      ) : null}

      <Card style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 18 }}>📄</span>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>
            สัญญาเช่าฉบับปัจจุบัน
          </div>
          <Pill color={isLocked ? 'success' : 'warning'} size="sm">
            {isLocked ? '🔒 มีผลบังคับใช้' : 'ยังไม่ lock'}
          </Pill>
        </div>
        <DefList
          columns={2}
          items={[
            { label: 'หมายเลขสัญญา', value: contract.contract_no },
            { label: 'ห้อง',           value: contract.room_id },
            { label: 'ระยะเวลาสัญญา', value: contract.term_months ? `${contract.term_months} เดือน` : 'เปิด-ไม่จำกัด' },
            { label: 'วันที่เริ่มต้น', value: fmtDate(contract.start_date) },
            { label: 'วันที่สิ้นสุด',  value: fmtDate(contract.end_date) },
            { label: 'ค่าเช่า/เดือน', value: '฿' + fmtCurrency(contract.monthly_rent), bold: true },
            { label: 'ส่วนลด',        value: Number(contract.discount_pct) > 0
                                              ? `${Number(contract.discount_pct).toFixed(1)}%` : 'ไม่มี' },
            { label: 'เงินมัดจำ',     value: '฿' + fmtCurrency(contract.deposit) },
          ]}
        />
        <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Btn variant="secondary" size="sm" icon="📄"
            onClick={() => window.open(`/api/contracts/${contract.id}/pdf`, '_blank', 'noopener')}>
            ดู PDF
          </Btn>
          {!isLocked && !invStatus ? (
            <Btn variant="primary" size="sm" icon="📨"
              onClick={sendInviteForExistingContract} disabled={busy}>
              ส่งลิงก์ให้ผู้เช่ากรอก
            </Btn>
          ) : null}
          {!isLocked ? (
            <Btn variant="ghost" size="sm" icon="✎" onClick={() => setShowEdit(true)}>
              แก้ไขส่วนลด/ระยะเวลา
            </Btn>
          ) : null}
          {contract.status === 'active' ? (
            <Btn variant="ghost" size="sm" icon="🚫"
              onClick={() => setCancelling(true)} disabled={busy}>
              ยกเลิกสัญญา
            </Btn>
          ) : null}
        </div>
      </Card>

      {showEdit ? (
        <ContractQuickEditModal
          contract={contract}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); reload();
            setToast && setToast({ kind: 'success', message: 'บันทึกแล้ว' });
          }}
          onError={(msg) => setToast && setToast({ kind: 'danger', message: msg })}
        />
      ) : null}

      {cancelling ? (
        <CancelContractModal
          contract={contract}
          tenant={t}
          reason={cancelReason}
          setReason={setCancelReason}
          busy={busy}
          onClose={() => { setCancelling(false); setCancelReason(''); }}
          onConfirm={cancelContract}
          C={C}
        />
      ) : null}
    </div>
  );
}

// Confirmation modal for ending a contract. We require a reason so the
// audit log captures WHY the lease was terminated — admin support cases
// later asking "who cancelled this and why?" should be answerable from
// the audit_log entry without DB forensics.
function CancelContractModal({ contract, tenant, reason, setReason, busy, onClose, onConfirm, C }) {
  const { Modal, Btn, fmtCurrency } = window;
  return (
    <Modal
      open={true}
      onClose={busy ? undefined : onClose}
      width={520}
      title={`ยกเลิกสัญญา ${contract.contract_no}`}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={busy}>ปิด</Btn>
          <Btn variant="danger" onClick={onConfirm} disabled={busy || !reason.trim()}>
            {busy ? 'กำลังยกเลิก…' : 'ยืนยันยกเลิก'}
          </Btn>
        </>
      }
    >
      <div style={{
        padding: 12, background: '#fff7e0', border: '1px solid #f1b32d',
        borderRadius: 8, fontSize: 13, color: '#6b4d10', marginBottom: 16, lineHeight: 1.6,
      }}>
        ⚠️ การยกเลิกจะ:
        <ul style={{ margin: '6px 0 0 0', paddingLeft: 20 }}>
          <li>ตั้งสถานะสัญญาเป็น "สิ้นสุดแล้ว"</li>
          <li>เปลี่ยนสถานะผู้เช่า <b>{tenant && tenant.name}</b> เป็น <b>moved_out</b></li>
          <li>ปล่อยห้อง <b>{contract.room_id}</b> เป็น <b>vacant</b></li>
          <li>หยุดการออกบิลอัตโนมัติ (รอบเดือนถัดไป)</li>
        </ul>
        บิลที่ค้างชำระอยู่แล้วยังคงค้างไว้ ต้องเก็บ/ปิดยอดเอง
      </div>

      <div style={{
        padding: 10, background: '#faf6ee', borderRadius: 8, fontSize: 12,
        color: C.muted, marginBottom: 12, lineHeight: 1.5,
      }}>
        ห้อง: <b style={{ color: C.ink }}>{contract.room_id}</b> ·
        ค่าเช่า: <b style={{ color: C.ink }}>฿{fmtCurrency(contract.monthly_rent)}/เดือน</b> ·
        มัดจำ: <b style={{ color: C.ink }}>฿{fmtCurrency(contract.deposit)}</b>
      </div>

      <label style={{ display: 'block', fontSize: 12, marginBottom: 4, color: '#5b4f40', fontWeight: 500 }}>
        เหตุผลที่ยกเลิก (audit log)
      </label>
      <textarea rows={3} maxLength={500}
        placeholder="เช่น ผู้เช่าขอย้ายออกก่อนกำหนด, ไม่สามารถจ่ายค่าเช่าได้, ฯลฯ"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        autoFocus
        style={{
          width: '100%', padding: '8px 10px', border: '1px solid #ece4d4',
          borderRadius: 6, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box',
        }} />
      <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>
        เหตุผลจะถูกบันทึกใน audit log (ดูที่ /admin#activity)
      </div>
    </Modal>
  );
}

// Pre-flight summary shown before admin sends the contract link. Mirrors
// every field the system will lock into the contract — room (type/floor/
// size/amenities), rent (auto-calculated deposit), tenant (name/phone/
// email). Everything sourced from the tenant's room context (rooms blob),
// so admin sees exactly what the tenant will receive without re-typing.
function ContractPreFlightSummary({ t, C, fmtCurrency }) {
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES || {};
  const r = t.room || {};
  const typeInfo = ADMIN_ROOM_TYPES[t.type] || {};
  const rent = Number(t.rent) || 0;
  const deposit = rent * 2;

  // Amenity badges — show only what the room actually has.
  const amenities = [];
  if (typeInfo.ac !== false || r.ac) amenities.push('แอร์');
  if (r.balcony) amenities.push('ระเบียง');
  if (r.kitchen) amenities.push('ครัว');
  if (r.parking) amenities.push('ที่จอดรถ');
  if (r.view)    amenities.push(r.view);

  const Row = ({ icon, label, children }) => (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
      padding: '8px 0', borderBottom: '1px solid #f0e9d8', gap: 12,
    }}>
      <span style={{ color: C.muted, fontSize: 12.5, display: 'flex',
                     alignItems: 'center', gap: 6, minWidth: 0 }}>
        <span>{icon}</span>{label}
      </span>
      <span style={{ fontSize: 13, fontWeight: 500, textAlign: 'right',
                     color: C.ink, minWidth: 0 }}>
        {children}
      </span>
    </div>
  );

  return (
    <div style={{ background: '#faf6ee', borderRadius: 10, padding: '4px 14px' }}>
      <Row icon="🏠" label="ห้อง">
        <b>{t.roomId || '—'}</b>
        {t.floor ? <span style={{ color: C.muted, marginLeft: 6, fontWeight: 400 }}>
          · ชั้น {t.floor}</span> : null}
        {typeInfo.th ? <span style={{ color: C.muted, marginLeft: 6, fontWeight: 400 }}>
          · {typeInfo.th}</span> : null}
      </Row>
      {typeInfo.size ? (
        <Row icon="📐" label="ขนาด">
          {typeInfo.size} ตร.ม.{typeInfo.beds ? ` · ${typeInfo.beds} เตียง` : ''}
        </Row>
      ) : null}
      {amenities.length ? (
        <Row icon="✨" label="สิ่งอำนวยความสะดวก">
          <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap',
                          justifyContent: 'flex-end' }}>
            {amenities.map((a, i) => (
              <span key={i} style={{
                padding: '2px 8px', borderRadius: 999, background: '#fff',
                fontSize: 11, color: C.ink2, border: `1px solid ${C.border}`,
              }}>{a}</span>
            ))}
          </span>
        </Row>
      ) : null}
      <Row icon="💰" label="ค่าเช่า/เดือน">
        <b style={{ fontFamily: 'Sora, monospace', fontSize: 14 }}>
          ฿{fmtCurrency(rent)}
        </b>
      </Row>
      <Row icon="🏦" label="เงินมัดจำ">
        <span style={{ fontFamily: 'Sora, monospace' }}>
          ฿{fmtCurrency(deposit)}
        </span>
        <span style={{ color: C.muted, marginLeft: 6, fontSize: 11, fontWeight: 400 }}>
          (ค่าเช่า × 2)
        </span>
      </Row>
      <Row icon="👤" label="ผู้เช่า">
        <b>{t.name || '—'}</b>
      </Row>
      {t.phone ? <Row icon="📱" label="เบอร์">{t.phone}</Row> : null}
      {t.email ? <Row icon="✉️" label="อีเมล">
        <span style={{ wordBreak: 'break-all' }}>{t.email}</span>
      </Row> : null}
    </div>
  );
}

// Big-tile button for the "no contract yet" 2-way fork. Hover lifts the
// border so admin can see this is a primary action.
function ContractActionTile({ icon, title, desc, onClick, busy, C }) {
  return (
    <button onClick={onClick} disabled={busy}
      style={{
        textAlign: 'left', padding: 14, borderRadius: 10,
        border: `1px solid ${C.border}`, background: C.surface,
        cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit',
        opacity: busy ? 0.6 : 1, transition: 'all 0.15s',
      }}
      onMouseOver={(e) => {
        if (busy) return;
        e.currentTarget.style.borderColor = C.accent;
        e.currentTarget.style.background = '#faf6ee';
      }}
      onMouseOut={(e) => {
        e.currentTarget.style.borderColor = C.border;
        e.currentTarget.style.background = C.surface;
      }}
    >
      <div style={{ fontSize: 22, marginBottom: 4 }}>{icon}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, marginBottom: 4 }}>
        {title}
      </div>
      <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5 }}>{desc}</div>
    </button>
  );
}

// Format citizen ID for display: X-XXXX-XXXXX-XX-X (standard Thai layout).
// Admin needs the full number visible to cross-check against the photo —
// the previous masked '***-***-XXXX' view forced them to open the photo
// in a separate tab and squint, which defeated the point of the digital
// flow. Falls back to raw value when it isn't 13 digits.
function formatCitizenId(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/\D/g, '');
  if (s.length !== 13) return s || null;
  return `${s[0]}-${s.slice(1, 5)}-${s.slice(5, 10)}-${s.slice(10, 12)}-${s[12]}`;
}

// Inline review panel — shows tenant's submitted draft + photos + signature
// directly inside the tenant drawer so admin can approve without page hops.
// `approveError` lets the parent surface server-side failures (room conflict,
// citizen-ID dup, etc.) right next to the buttons instead of letting a
// toast disappear after a few seconds.
function ContractReviewPanel({ detail, busy, approveError, onApprove, onReject, onCancel, C }) {
  const { Card, Btn } = window;
  const draft = detail.draft || {};
  const [showRejectForm, setShowRejectForm] = React.useState(false);
  const [rejectReason, setRejectReason] = React.useState('');

  const Section = ({ title, children }) => (
    <div style={{ marginBottom: 12, padding: 12, background: '#faf6ee', borderRadius: 8 }}>
      <div style={{ fontWeight: 600, marginBottom: 6, color: C.accent, fontSize: 12 }}>{title}</div>
      {children}
    </div>
  );
  const KV = ({ k, v, mono }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0',
                  fontSize: 13, borderBottom: '1px solid #f0e9d8' }}>
      <span style={{ color: C.muted }}>{k}</span>
      <span style={{ fontWeight: 500, textAlign: 'right',
                     fontFamily: mono ? 'Sora, monospace' : 'inherit' }}>{v || '—'}</span>
    </div>
  );
  const fullCitizenId = formatCitizenId(draft.citizenId);
  return (
    <Card style={{ padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>ตรวจสอบสัญญาที่ผู้เช่ากรอก</div>
        <Btn variant="ghost" size="sm" onClick={onCancel} disabled={busy}>← ย้อน</Btn>
      </div>

      <Section title="ที่อยู่">
        <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
          {draft.address || <span style={{ color: '#c0392b' }}>ยังไม่กรอก</span>}
        </div>
      </Section>

      <Section title="ผู้ติดต่อฉุกเฉิน">
        <KV k="ชื่อ" v={draft.emergencyContactName} />
        <KV k="เบอร์" v={draft.emergencyContactPhone} />
        {draft.emergencyContactRelation ? (
          <KV k="ความสัมพันธ์" v={draft.emergencyContactRelation} />
        ) : null}
      </Section>

      <Section title="เลขบัตร + รูป">
        <KV k="เลขบัตรประชาชน"
          v={fullCitizenId || <span style={{ color: '#c0392b' }}>ยังไม่กรอก</span>}
          mono={!!fullCitizenId} />
        <div style={{ fontSize: 11, color: C.muted, marginTop: 4, marginBottom: 8 }}>
          ตรวจให้ตรงกับเลขบนรูปบัตรก่อน lock
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
          <ContractPhotoBox label="หน้าบัตร" url={detail.draft_front_url} C={C} />
          <ContractPhotoBox label="หลังบัตร" url={detail.draft_back_url} C={C} />
        </div>
      </Section>

      <Section title="ลายเซ็น">
        {detail.draft_signature_url ? (
          <img src={detail.draft_signature_url} alt="signature"
            style={{ maxWidth: '100%', maxHeight: 160, background: '#fff',
                     border: `1px solid ${C.border}`, borderRadius: 6 }} />
        ) : (
          <div style={{ color: '#c0392b' }}>ยังไม่ได้เซ็น</div>
        )}
      </Section>

      {approveError ? (
        <div style={{
          padding: 12, marginBottom: 10, borderRadius: 8,
          background: '#ffe6e3', border: '1px solid #c0392b', color: '#7a1d10',
          fontSize: 13, lineHeight: 1.6,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>❌ อนุมัติไม่สำเร็จ</div>
          <div>{approveError.error}</div>
          {approveError.hint ? (
            <div style={{ marginTop: 6, fontSize: 12, color: '#7a1d10', opacity: 0.85 }}>
              💡 {approveError.hint}
            </div>
          ) : null}
        </div>
      ) : null}

      {showRejectForm ? (
        <div>
          <label style={{ display: 'block', fontSize: 12, marginBottom: 4, color: '#5b4f40' }}>
            เหตุผลที่ขอให้แก้ (ผู้เช่าจะเห็นข้อความนี้)
          </label>
          <textarea rows={3} maxLength={500}
            placeholder="เช่น รูปบัตรไม่ชัด — ถ่ายในที่สว่างกว่านี้"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', border: '1px solid #ece4d4',
                     borderRadius: 6, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
            <Btn variant="ghost" onClick={() => setShowRejectForm(false)} disabled={busy}>← ย้อน</Btn>
            <Btn variant="danger" onClick={() => onReject(rejectReason)}
              disabled={busy || !rejectReason.trim()}>
              ส่งกลับให้ผู้เช่าแก้
            </Btn>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={() => setShowRejectForm(true)} disabled={busy}>ขอให้แก้</Btn>
          <Btn variant="primary" onClick={onApprove} disabled={busy}>
            {busy ? 'กำลังอนุมัติ…' : '✓ อนุมัติ + lock'}
          </Btn>
        </div>
      )}
    </Card>
  );
}

function ContractPhotoBox({ label, url, C }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>{label}</div>
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer">
          <img src={url} alt={label} style={{
            maxWidth: '100%', maxHeight: 140, borderRadius: 6,
            border: `1px solid ${C.border}`, cursor: 'zoom-in',
          }} />
        </a>
      ) : (
        <div style={{ padding: 24, background: '#fff', border: `1px dashed ${C.border}`,
                      borderRadius: 6, color: '#c0392b', fontSize: 12 }}>
          ยังไม่อัปโหลด
        </div>
      )}
    </div>
  );
}

function CheckInModal({ tenantId, tenant, onClose, onDone, onError }) {
  const C = window.ADMIN_C;
  const { Modal, Btn } = window;
  const apiCall = window.apiCall;
  const [form, setForm] = React.useState({
    moveInDate: new Date().toISOString().slice(0, 10),
    monthlyRent: String(tenant.rent || ''),
    depositAmount: String((tenant.rent || 0) * 2),
    termMonths: '12',
    discountPct: '',  // empty → resolved from termMonths + config.discounts
  });
  const [busy, setBusy] = React.useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!tenant.roomId) {
      onError && onError('ไม่พบห้องของผู้เช่า — กำหนดห้องที่หน้ารายชื่อก่อน');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        roomId: tenant.roomId,
        moveInDate: form.moveInDate,
        monthlyRent: Number(form.monthlyRent),
        depositAmount: Number(form.depositAmount),
      };
      if (form.termMonths) payload.termMonths = Number(form.termMonths);
      if (form.discountPct !== '') payload.discountPct = Number(form.discountPct);
      await apiCall(`/api/tenants/${tenantId}/checkin`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      onDone && onDone();
    } catch (err) {
      onError && onError('เช็คอินล้มเหลว: ' + (err.message || 'unknown'));
    } finally { setBusy(false); }
  };
  return (
    <Modal open={true} onClose={onClose} title="เช็คอินผู้เช่า"
      footer={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={busy}>ยกเลิก</Btn>
          <Btn variant="primary" onClick={submit} disabled={busy}>
            {busy ? '…' : 'บันทึก + สร้างสัญญา'}
          </Btn>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
          ผู้เช่า: <b>{tenant.name}</b> · ห้อง <b>{tenant.roomId}</b>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={inLbl}>วันที่เข้าพัก</label>
            <input type="date" value={form.moveInDate}
              onChange={(e) => setForm({ ...form, moveInDate: e.target.value })}
              required style={inInp} />
          </div>
          <div>
            <label style={inLbl}>ระยะสัญญา (เดือน)</label>
            <input type="number" min="1" max="120" value={form.termMonths}
              onChange={(e) => setForm({ ...form, termMonths: e.target.value })}
              placeholder="12" style={inInp} />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={inLbl}>ค่าเช่า/เดือน (บาท)</label>
            <input type="number" step="0.01" min="0" value={form.monthlyRent}
              onChange={(e) => setForm({ ...form, monthlyRent: e.target.value })}
              required style={inInp} />
          </div>
          <div>
            <label style={inLbl}>เงินมัดจำ (บาท)</label>
            <input type="number" step="0.01" min="0" value={form.depositAmount}
              onChange={(e) => setForm({ ...form, depositAmount: e.target.value })}
              required style={inInp} />
          </div>
        </div>
        <div>
          <label style={inLbl}>ส่วนลด % (เว้นว่างเพื่อใช้จาก config.discounts ตามระยะสัญญา)</label>
          <input type="number" step="0.1" min="0" max="50" value={form.discountPct}
            onChange={(e) => setForm({ ...form, discountPct: e.target.value })}
            placeholder="ปล่อยว่าง = auto" style={inInp} />
        </div>
        <div style={{
          padding: 10, background: C.surfaceAlt, borderRadius: 6,
          fontSize: 12, color: C.muted, lineHeight: 1.5,
        }}>
          ℹ️ ถ้าตั้ง <b>ระยะสัญญา</b> + เว้น <b>ส่วนลด</b> ว่าง ระบบจะหาว่าเข้าเกณฑ์ใด:
          ≥ 24 เดือน → twentyFourMonth, ≥ 12 → twelveMonth, ≥ 6 → sixMonth
          (จาก /admin#pricing)
        </div>
      </form>
    </Modal>
  );
}

function ContractQuickEditModal({ contract, onClose, onSaved, onError }) {
  const C = window.ADMIN_C;
  const { Modal, Btn } = window;
  const apiCall = window.apiCall;
  const [form, setForm] = React.useState({
    discountPct: contract.discount_pct != null ? String(contract.discount_pct) : '0',
    termMonths:  contract.term_months  != null ? String(contract.term_months)  : '',
    endDate:     contract.end_date ? String(contract.end_date).slice(0, 10) : '',
  });
  const [busy, setBusy] = React.useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const payload = {};
      if (form.discountPct !== '') payload.discountPct = Number(form.discountPct);
      payload.termMonths = form.termMonths === '' ? null : Number(form.termMonths);
      payload.endDate = form.endDate || null;
      await apiCall(`/api/contracts/${contract.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      onSaved && onSaved();
    } catch (err) {
      onError && onError('บันทึกล้มเหลว: ' + (err.message || 'unknown'));
    } finally { setBusy(false); }
  };
  return (
    <Modal open={true} onClose={onClose} title={`แก้ไข ${contract.contract_no}`}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={busy}>ยกเลิก</Btn>
          <Btn variant="primary" onClick={submit} disabled={busy}>
            {busy ? '…' : 'บันทึก'}
          </Btn>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={inLbl}>ส่วนลด %</label>
            <input type="number" step="0.1" min="0" max="50" value={form.discountPct}
              onChange={(e) => setForm({ ...form, discountPct: e.target.value })}
              style={inInp} />
          </div>
          <div>
            <label style={inLbl}>ระยะสัญญา (เดือน)</label>
            <input type="number" min="1" max="120" value={form.termMonths}
              onChange={(e) => setForm({ ...form, termMonths: e.target.value })}
              style={inInp} />
          </div>
        </div>
        <div>
          <label style={inLbl}>วันสิ้นสุด</label>
          <input type="date" value={form.endDate}
            onChange={(e) => setForm({ ...form, endDate: e.target.value })}
            style={inInp} />
        </div>
      </form>
    </Modal>
  );
}

const inLbl = { display: 'block', fontSize: 12, color: '#5b4f40', marginBottom: 4 };
const inInp = {
  width: '100%', padding: '8px 10px', border: '1px solid #ece4d4',
  borderRadius: 6, fontSize: 13, fontFamily: 'inherit',
};

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
