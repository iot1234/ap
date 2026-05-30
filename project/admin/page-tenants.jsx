// === admin/page-tenants.jsx ===============================================
// จัดการผู้เช่า: รายชื่อ + drawer profile (สัญญา, บิล, บันทึก) + "เพิ่มผู้เช่า"
// modal that POSTs to /api/tenants. Older versions only let admin add a
// tenant by editing a vacant room — this brought tenant creation into a
// dedicated form so admin can pre-create a tenant before assigning a room.
// ===========================================================================

const { useState, useMemo } = React;

function PageTenants({ rooms, setRooms, config, addActivity, setToast }) {
  const C = window.ADMIN_C;
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES;
  const { fmt, fmtCurrency, resolveRoomRent } = window;
  const { Card, Btn, IconBtn, Avatar, Pill, StatusBadge, DataTable, Drawer,
          SearchInput, FilterChip, PageContainer, PageHeader, SectionHeading,
          DefList, Tabs, Modal, Input, Select, Textarea } = window;
  const apiFetch = window.requireApiFetch ? window.requireApiFetch() : window.apiFetch;

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [activeId, setActiveId] = useState(null);
  const [drawerTab, setDrawerTab] = useState('profile');
  const [addOpen, setAddOpen] = useState(false);
  const [initialAddRoomId, setInitialAddRoomId] = useState('');
  const [routeBookingId, setRouteBookingId] = useState('');
  const [busy, setBusy] = useState(false);
  const [tenantRows, setTenantRows] = useState([]);
  const [tenantLoadError, setTenantLoadError] = useState(null);

  const refreshTenants = React.useCallback(async () => {
    setTenantLoadError(null);
    try {
      const d = await (window.requireApiCall ? window.requireApiCall() : window.apiCall)('/api/tenants');
      setTenantRows(Array.isArray(d.tenants) ? d.tenants : []);
    } catch (err) {
      setTenantLoadError(err);
    }
  }, []);

  React.useEffect(() => { refreshTenants(); }, [refreshTenants]);

  // Build tenants list from the relational tenants table, then decorate with
  // the room blob for current-room display data. This keeps moved_out tenants
  // searchable while preserving the existing room-card UI for active tenants.
  const tenants = useMemo(() => {
    const byPhoneRoom = new Map();
    for (const r of Object.values(rooms || {})) {
      if (!r || !r.tenant) continue;
      const phone = String(r.tenant.phone || '').replace(/[\s-]/g, '');
      if (phone) byPhoneRoom.set(`${phone}:${r.id}`, r);
    }
    return (tenantRows || []).map((row) => {
      const currentRoomId = row.current_room_id || '';
      const lastRoomId = row.last_room_id || '';
      const roomId = currentRoomId || lastRoomId || '';
      const cleanPhone = String(row.phone || '').replace(/[\s-]/g, '');
      const room = currentRoomId
        ? (rooms && rooms[currentRoomId])
        : ((rooms && rooms[lastRoomId]) || byPhoneRoom.get(`${cleanPhone}:${lastRoomId}`) || null);
      const roomTenant = room && room.tenant ? room.tenant : {};
      const type = (room && room.type) || 'standard';
      const rent = row.last_monthly_rent != null
        ? Number(row.last_monthly_rent)
        : (room ? (resolveRoomRent ? resolveRoomRent(room, config).rent : room.rent) : 0);
      const tenantStatus = row.status || 'active';
      const outstandingTotal = Number(row.outstanding_total || 0);
      return {
        ...roomTenant,
        rowKey: `tenant:${row.id}`,
        dbId: row.id,
        tenantId: row.id,
        name: row.full_name || roomTenant.name || '-',
        phone: row.phone || roomTenant.phone || '',
        email: row.email || roomTenant.email || '',
        occupation: roomTenant.occupation || '',
        score: roomTenant.score || (outstandingTotal > 0 ? 'B' : 'A'),
        roomId,
        currentRoomId,
        lastRoomId,
        floor: room ? room.floor : '-',
        type,
        rent,
        since: row.last_contract_start_date || room?.since || row.created_at,
        contractEnd: row.last_contract_end_date || room?.contractEnd || null,
        lastContractNo: row.last_contract_no || null,
        lastContractStatus: row.last_contract_status || null,
        tenantStatus,
        status: tenantStatus,
        roomStatus: room ? room.status : null,
        outstandingCount: Number(row.outstanding_count || 0),
        outstandingTotal,
        room,
      };
    }).sort((a, b) => {
      if (a.tenantStatus !== b.tenantStatus) {
        if (a.tenantStatus === 'active') return -1;
        if (b.tenantStatus === 'active') return 1;
      }
      return String(a.roomId || '').localeCompare(String(b.roomId || ''))
        || String(a.name || '').localeCompare(String(b.name || ''));
    });
  }, [tenantRows, rooms, config]);

  const filtered = useMemo(() => tenants.filter(t => {
    if (filter === 'active' && t.tenantStatus !== 'active') return false;
    if (filter === 'moved_out' && t.tenantStatus !== 'moved_out') return false;
    if (filter === 'blacklist' && t.tenantStatus !== 'blacklist') return false;
    if (filter === 'overdue' && !(t.roomStatus === 'overdue' || t.outstandingTotal > 0)) return false;
    if (filter === 'aPlus' && t.score !== 'A') return false;
    if (search) {
      const q = search.toLowerCase();
      const hay = `${t.name} ${t.roomId} ${t.currentRoomId} ${t.lastRoomId} ${t.phone} ${t.email} ${t.occupation} ${t.lastContractNo || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }), [tenants, filter, search]);

  const counts = useMemo(() => ({
    all: tenants.length,
    active: tenants.filter(t => t.tenantStatus === 'active').length,
    moved_out: tenants.filter(t => t.tenantStatus === 'moved_out').length,
    blacklist: tenants.filter(t => t.tenantStatus === 'blacklist').length,
    overdue: tenants.filter(t => t.roomStatus === 'overdue' || t.outstandingTotal > 0).length,
    aPlus: tenants.filter(t => t.score === 'A').length,
  }), [tenants]);

  const active = activeId ? tenants.find(t =>
    t.rowKey === activeId
    || String(t.dbId || '') === String(activeId)
    || (t.roomId && t.roomId === activeId)
  ) : null;

  React.useEffect(() => {
    const validTabs = new Set(['profile', 'portal', 'contract', 'bills', 'history', 'notes']);
    const applyTenantRoute = () => {
      const raw = String(window.location.hash || '').replace(/^#/, '');
      const [pathPart, queryPart = ''] = raw.split('?');
      const parts = pathPart.split('/').filter(Boolean);
      if (parts[0] !== 'tenants') return;

      const params = new URLSearchParams(queryPart);
      setRouteBookingId(String(params.get('booking') || '').slice(0, 64));
      const pathRef = parts[1] || '';
      const tenantRef = params.get('tenantId') || (!rooms[pathRef] ? pathRef : '');
      let roomId = params.get('room') || params.get('roomId') || (rooms[pathRef] ? pathRef : '');
      if (!roomId && tenantRef) {
        const found = tenants.find((t) =>
          String(t.tenantId || t.id || t.dbId || '') === String(tenantRef));
        roomId = found ? found.roomId : '';
      }

      if (params.get('add') === '1') {
        setActiveId(null);
        setInitialAddRoomId(roomId || '');
        setAddOpen(true);
        return;
      }

      const found = tenants.find((t) =>
        (tenantRef && String(t.dbId || '') === String(tenantRef))
        || (roomId && t.roomId === roomId)
      );
      if (found) {
        setActiveId(found.rowKey);
        const tab = params.get('tab');
        setDrawerTab(validTabs.has(tab) ? tab : 'profile');
      }
    };

    applyTenantRoute();
    window.addEventListener('hashchange', applyTenantRoute);
    return () => window.removeEventListener('hashchange', applyTenantRoute);
  }, [rooms, tenants]);

  async function sendTenantMessage(t) {
    if (!t) return;
    const message = (window.prompt(`ส่งข้อความถึง ${t.name} (ห้อง ${t.roomId})`, '') || '').trim();
    if (!message) return;
    try {
      const r = await apiFetch('/api/tenants/notify', {
        method: 'POST',
        body: JSON.stringify({
          roomId: t.roomId,
          phone: t.phone,
          subject: 'ข้อความจากหอพัก',
          message,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const err = new Error(d.error || `HTTP ${r.status}`);
        err.status = r.status;
        err.body = d;
        throw err;
      }
      setToast && setToast({
        kind: d.queued ? 'warning' : 'success',
        message: d.queued
          ? `ส่งข้อความเข้าคิวแล้ว (${d.channel})`
          : `ส่งข้อความถึง ${t.name} แล้ว (${d.channel})`,
      });
      addActivity && addActivity({
        icon: '✉️',
        text: `ส่งข้อความถึง ${t.name} (ห้อง ${t.roomId})`,
        type: 'tenant',
      });
    } catch (err) {
      window.toastError
        ? window.toastError(setToast, err, { action: `ส่งข้อความถึง ${t.name}` })
        : setToast && setToast({ kind: 'danger', message: err.message || 'ส่งข้อความไม่สำเร็จ' });
    }
  }

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
          <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, fontFamily: 'IBM Plex Sans Thai, sans-serif' }}>{t.roomId || '-'}</div>
          <div style={{ fontSize: 11, color: C.muted }}>{t.currentRoomId ? (((ADMIN_ROOM_TYPES[t.type] || ADMIN_ROOM_TYPES.standard || {}).th) || t.type || '-') : (t.lastRoomId ? 'ห้องล่าสุด' : '-')}</div>
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
      render: t => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
          <StatusBadge status={t.tenantStatus} size="sm" />
          {t.outstandingTotal > 0 ? (
            <span style={{ fontSize: 11, color: C.danger }}>ค้าง ฿{fmtCurrency(t.outstandingTotal)}</span>
          ) : null}
        </div>
      ),
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
            <Btn variant="secondary" icon="↻" onClick={refreshTenants}>รีเฟรช</Btn>
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
          <FilterChip label="กำลังอยู่" active={filter === 'active'} onClick={() => setFilter('active')} count={counts.active} color={C.success} />
          <FilterChip label="ย้ายออก" active={filter === 'moved_out'} onClick={() => setFilter('moved_out')} count={counts.moved_out} color={C.muted} />
          <FilterChip label="แบล็คลิสต์" active={filter === 'blacklist'} onClick={() => setFilter('blacklist')} count={counts.blacklist} color={C.danger} />
          <FilterChip label="ทั้งหมด" active={filter === 'all'} onClick={() => setFilter('all')} count={counts.all} />
          <FilterChip label="ค้างชำระ" active={filter === 'overdue'} onClick={() => setFilter('overdue')} count={counts.overdue} color={C.danger} />
          <FilterChip label="เครดิต A" active={filter === 'aPlus'} onClick={() => setFilter('aPlus')} count={counts.aPlus} color={C.success} />
        </div>
        {tenantLoadError ? (
          <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <div style={{ fontSize: 12.5, color: C.danger, lineHeight: 1.5 }}>
              โหลดรายชื่อผู้เช่าจากฐานข้อมูลไม่สำเร็จ: {tenantLoadError.message || String(tenantLoadError)}
              <div style={{ color: C.muted }}>ระบบยังไม่ใช้ข้อมูลเก่าจาก rooms blob แทน เพราะอาจทำให้ผู้เช่าเก่าหายหรือบิลปนกัน</div>
            </div>
            <Btn variant="secondary" size="sm" onClick={refreshTenants}>ลองโหลดใหม่</Btn>
          </div>
        ) : null}
      </Card>

      <DataTable
        columns={columns}
        rows={filtered}
        onRowClick={(t) => { setActiveId(t.rowKey); setDrawerTab('profile'); }}
        empty="ไม่พบผู้เช่าที่ตรงกับเงื่อนไข"
      />

      <AddTenantModal
        open={addOpen}
        onClose={() => {
          if (busy) return;
          setAddOpen(false);
          setInitialAddRoomId('');
        }}
        rooms={rooms}
        setRooms={setRooms}
        busy={busy}
        setBusy={setBusy}
        initialRoomId={initialAddRoomId}
        addActivity={addActivity}
        setToast={setToast}
        apiFetch={apiFetch}
        onTenantCreated={(roomId, tenant) => {
          refreshTenants();
          // Auto-open the new tenant's drawer on the contract tab so admin
          // can send the link immediately — all fields auto-pulled from
          // the row they just created. Closes the "ข้ามไปมา" gap on the
          // tenant-onboarding flow.
          if (tenant && tenant.id) {
            setActiveId(`tenant:${tenant.id}`);
            setDrawerTab('contract');
          } else if (roomId) {
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
            <Btn variant="secondary" icon="✉️" onClick={() => sendTenantMessage(active)}>ส่งข้อความ</Btn>
            <Btn variant="primary" icon="📋" onClick={() => setDrawerTab('contract')}>ดูสัญญา</Btn>
          </>
        )}
      >
        {active && (
          <>
            <TenantHeader t={active} />
            <TenantFlowNotice t={active} setDrawerTab={setDrawerTab} />
            <Tabs
              items={[
                { value: 'history',  label: 'ย้อนหลัง',       icon: '↺' },
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
            {drawerTab === 'contract' && <TabContract t={active} routeBookingId={routeBookingId} setToast={setToast} addActivity={addActivity} setRooms={setRooms} onTenantChanged={refreshTenants} onClosed={() => setActiveId(null)} />}
            {drawerTab === 'bills'    && <TabBills    t={active} />}
            {drawerTab === 'history'  && <TabHistory  t={active} />}
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
function AddTenantModal({ open, onClose, rooms, setRooms, busy, setBusy, initialRoomId = '', addActivity, setToast, apiFetch, onTenantCreated }) {
  const C = window.ADMIN_C;
  const { Btn, Input, Select, Textarea, Modal } = window;
  const [form, setForm] = React.useState({
    fullName: '', phone: '', citizenId: '', email: '',
    occupation: '', roomId: '', notes: '',
  });

  // Reset whenever modal opens (don't leak stale input from a cancelled session)
  React.useEffect(() => {
    const initialRoom = initialRoomId ? rooms[initialRoomId] : null;
    const canUseInitialRoom = initialRoom
      && String(initialRoom.status || 'vacant') === 'vacant'
      && !initialRoom.tenant;
    if (open) setForm({
      fullName: '', phone: '', citizenId: '', email: '',
      occupation: '', roomId: canUseInitialRoom ? initialRoomId : '', notes: '',
    });
  }, [open, initialRoomId]);

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
      if (onTenantCreated) onTenantCreated(form.roomId || '', d.tenant || null);
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
          ผู้เช่าเข้า /tenant ด้วยเบอร์โทรที่ผูกกับห้อง ไม่ต้องใช้รหัสเพิ่มเติม ·
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
  const roomType = ADMIN_ROOM_TYPES[t.type] || ADMIN_ROOM_TYPES.standard || {};
  return (
    <div style={{
      padding: 16, background: C.surfaceAlt, borderRadius: 12,
      display: 'flex', alignItems: 'center', gap: 14,
    }}>
      <Avatar name={t.name} size={56} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'IBM Plex Sans Thai, sans-serif', fontSize: 16, fontWeight: 600, color: C.ink, marginBottom: 2 }}>
          {t.name}
        </div>
        <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 6 }}>{t.occupation}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Pill color="accent" size="sm">ห้อง {t.roomId}</Pill>
          <Pill color="neutral" size="sm">{roomType.th || t.type || '-'}</Pill>
          <Pill color={t.score === 'A' ? 'success' : 'warning'} size="sm">เครดิต {t.score}</Pill>
          <StatusBadge status={t.tenantStatus || t.status} size="sm" />
        </div>
      </div>
    </div>
  );
}

function TenantFlowNotice({ t, setDrawerTab }) {
  const C = window.ADMIN_C;
  const { Card, Btn, Pill } = window;
  const status = t.tenantStatus || t.status || 'active';
  const outstanding = Number(t.outstandingTotal || 0);
  const hasCurrentRoom = !!t.currentRoomId;
  const hasContract = !!(t.lastContractNo || t.lastContractStatus);
  let tone = 'info';
  let title = 'พร้อมใช้งานต่อ';
  let detail = 'ข้อมูลผู้เช่า สัญญา บิล และประวัติย้อนหลังผูกกับ tenant_id แล้ว สามารถตรวจต่อได้จากแท็บด้านล่าง';
  let actionTab = 'history';
  let actionLabel = 'ดูย้อนหลัง';

  if (status !== 'active') {
    tone = outstanding > 0 ? 'warning' : 'neutral';
    title = status === 'moved_out' ? 'ผู้เช่าย้ายออกแล้ว' : `สถานะผู้เช่า: ${status}`;
    detail = outstanding > 0
      ? `ยังมียอดค้าง ${outstanding.toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท ให้ตรวจบิลและ audit ก่อนปิดเคส`
      : 'ปิด portal/check-in ซ้ำแล้ว ให้ใช้แท็บย้อนหลังเพื่อตรวจสัญญา บิล การชำระ และ audit';
    actionTab = outstanding > 0 ? 'bills' : 'history';
    actionLabel = outstanding > 0 ? 'ดูบิลค้าง' : 'ดูย้อนหลัง';
  } else if (!hasCurrentRoom) {
    tone = 'warning';
    title = 'ผู้เช่ายังไม่มีห้องปัจจุบัน';
    detail = 'ต้อง check-in หรือผูกห้องก่อน ระบบจึงจะเปิด portal, LINE binding, สัญญา และการออกบิลรายเดือนได้ถูกต้อง';
    actionTab = 'contract';
    actionLabel = 'ไปเช็คอิน/สัญญา';
  } else if (!hasContract) {
    tone = 'warning';
    title = 'ยังไม่มีสัญญาที่ตรวจย้อนหลังได้';
    detail = 'ควรสร้างสัญญาหรือส่งลิงก์ให้ผู้เช่ากรอก เพื่อให้ค่าเช่า ระยะสัญญา และหลักฐานถูกล็อกในระบบ';
    actionTab = 'contract';
    actionLabel = 'สร้าง/ส่งสัญญา';
  } else if (String(t.lastContractStatus || '').match(/draft|pending|submitted/i)) {
    tone = 'warning';
    title = 'สัญญายังไม่จบขั้นตอน';
    detail = `สัญญา ${t.lastContractNo || ''} อยู่สถานะ ${t.lastContractStatus}; ตรวจคำขอหรืออนุมัติให้จบก่อนเริ่มรอบบิลถัดไป`;
    actionTab = 'contract';
    actionLabel = 'ตรวจสัญญา';
  } else if (outstanding > 0) {
    tone = 'warning';
    title = 'มีบิลค้างชำระ';
    detail = `ยอดค้างรวม ${outstanding.toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท ระบบแยกตาม tenant_id แล้วเพื่อไม่ปนกับผู้เช่าห้องเดียวกันคนอื่น`;
    actionTab = 'bills';
    actionLabel = 'ดูบิล';
  }

  const palette = {
    info: { bg: C.infoSoft || '#E8F0FE', border: C.info || '#2563EB', fg: C.infoInk || '#1E3A8A' },
    warning: { bg: C.warningSoft || '#FCEFDB', border: C.warning || '#D97706', fg: C.warningInk || '#78350F' },
    neutral: { bg: C.surfaceAlt, border: C.border, fg: C.muted },
  }[tone] || {};

  return (
    <Card style={{ padding: 12, marginTop: 10, border: `1px solid ${palette.border}`, background: palette.bg }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
            <Pill color={tone === 'warning' ? 'warning' : 'info'} size="sm">{title}</Pill>
            {t.lastContractNo ? <span style={{ fontSize: 12, color: palette.fg }}>สัญญาล่าสุด {t.lastContractNo}</span> : null}
          </div>
          <div style={{ fontSize: 12.5, color: palette.fg, lineHeight: 1.55 }}>{detail}</div>
        </div>
        <Btn variant="secondary" size="sm" onClick={() => setDrawerTab(actionTab)}>{actionLabel}</Btn>
      </div>
    </Card>
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
//   1) Confirm tenant portal phone access
//   2) Issue LINE binding code — required for LINE notifications
//
// Why this lives on the tenants page (not bookings):
//   - mirrorRoomsToTenants() in server.js auto-creates a tenants table row
//     when admin saves the rooms blob, so by the time this tab renders the
//     tenant_id is resolvable by phone.
//   - The flow is the same for "approved booking → new tenant" AND for
//     "existing tenant needs notification setup" — one path, one screen.
//
// Lookup is by phone because the rooms-blob view doesn't carry tenant_id;
// we hit GET /api/tenants?q=<phone> on mount to find the row, then route
// binding through /api/admin/line-bindings/tenants/:id.
function TabPortal({ t, setToast, addActivity, apiFetch }) {
  const C = window.ADMIN_C;
  const { Card, Btn, Pill } = window;
  const [tenantRow, setTenantRow] = React.useState(null);   // null=loading
  const [tenantErr, setTenantErr] = React.useState(null);
  const [binding, setBinding] = React.useState(null);
  const [bindingErr, setBindingErr] = React.useState(null);
  const [bindBusy, setBindBusy] = React.useState(false);

  async function loadBinding(exact) {
    setTenantRow(exact);
    const r2 = await fetch(`/api/admin/line-bindings/tenants/${exact.id}`,
      { credentials: 'same-origin' });
    if (r2.ok) {
      const d2 = await r2.json();
      setBinding(d2);
    } else if (r2.status !== 404) {
      const d2 = await r2.json().catch(() => ({}));
      setBindingErr(new Error(d2.error || `HTTP ${r2.status}`));
    }
  }

  async function load() {
    setTenantErr(null);
    setBindingErr(null);
    setBinding(null);
    try {
      if (t.dbId) {
        await loadBinding({
          id: t.dbId,
          full_name: t.name,
          phone: t.phone,
          current_room_id: t.currentRoomId || t.roomId,
          status: t.tenantStatus || 'active',
        });
        return;
      }
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
      // Now fetch binding status — this endpoint already returns full state
      // (pending code / bound user / blocked) in one call.
      await loadBinding(exact);
    } catch (err) {
      setTenantErr(err);
    }
  }
  React.useEffect(() => {
    if (t.tenantStatus && t.tenantStatus !== 'active') {
      setTenantRow(null);
      setBinding(null);
      setTenantErr(null);
      setBindingErr(null);
      return;
    }
    load(); /* eslint-disable-next-line */
  }, [t.dbId, t.roomId, t.phone, t.tenantStatus]);

  if (t.tenantStatus && t.tenantStatus !== 'active') {
    return (
      <Card style={{ padding: 16, background: C.surfaceAlt }}>
        <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6, marginBottom: 10 }}>
          ผู้เช่ารายนี้ไม่ได้ active แล้ว ระบบจึงปิด portal/LINE binding สำหรับการใช้งานปัจจุบันเพื่อป้องกันการส่งบิลหรือเปิดสิทธิ์ให้ผู้เช่าเก่า
        </div>
        <Btn variant="secondary" size="sm" onClick={() => { window.location.hash = `#tenants?tenantId=${encodeURIComponent(t.dbId || t.tenantId || '')}&tab=history`; }}>
          ดูประวัติย้อนหลัง
        </Btn>
      </Card>
    );
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

  const bindingBoundCount = Number(binding && (binding.boundCount || binding.bound_count || 0));
  const bindingStatus = binding && binding.bound
    ? { label: `ผูก LINE แล้ว ${bindingBoundCount || 1} บัญชี (ผ่าน ${binding.bound.oa_name || 'OA'})`, color: C.success }
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
            เบอร์ <code style={{ background: 'rgba(0,0,0,0.05)', padding: '1px 5px', borderRadius: 3 }}>{tenantRow.phone}</code>
          </div>
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>
            ผู้เช่าเข้า /tenant ด้วยเบอร์นี้ได้เมื่อสถานะ active และผูกห้องอยู่
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

      {/* LINE binding management */}
      <Card style={{ padding: 16 }}>
        <div style={{ fontFamily: 'IBM Plex Sans Thai, sans-serif', fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
          🔗 ผูกบัญชี LINE
        </div>
        <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.6, marginBottom: 12 }}>
          {binding && binding.bound
            ? `ผูกแล้ว ${bindingBoundCount || 1} บัญชี — ต้องการให้คนในห้องรับแจ้งเตือนเพิ่ม ให้ออกรหัสใหม่และให้ LINE อีกบัญชีส่งรหัสนี้ ระบบจะไม่ลบบัญชีเดิม และจะแจ้งเตือนทุกบัญชีที่ผูกกับห้องนี้`
            : binding && binding.pending
              ? `รหัสค้างอยู่: ${binding.pending.code} (หมดอายุ ${new Date(binding.pending.expires_at).toLocaleDateString('th-TH')})`
              : 'ออกรหัส 8 หลัก ให้ผู้เช่า — add OA + ส่งรหัสในแชต = ผูกอัตโนมัติ'}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Btn variant={binding && binding.bound ? 'secondary' : 'primary'}
               disabled={bindBusy} onClick={issueBinding}>
            {bindBusy ? 'กำลังออกรหัส…'
              : binding && binding.bound ? 'ออกรหัสเพิ่ม LINE อีกบัญชี'
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
function TabContract({ t, routeBookingId = '', setToast, addActivity, setRooms, onTenantChanged, onClosed }) {
  const C = window.ADMIN_C;
  const { fmtCurrency } = window;
  const { Card, DefList, Btn, Pill } = window;
  const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
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
  }, [t.phone, routeBookingId]);

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      if (t.tenantStatus && t.tenantStatus !== 'active') {
        setTenantDbId(t.dbId || null);
        setContract(null);
        return;
      }
      const normalisePhone = (s) => String(s || '').replace(/[\s-]/g, '');
      let tid = t.dbId || null;
      if (!tid) try {
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
  }, [t.dbId, t.phone, t.tenantStatus]);
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
      if (onTenantChanged) onTenantChanged();
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
      const reservedBy = t.room && t.room.reservedBy ? String(t.room.reservedBy) : '';
      const routedBookingId = String(routeBookingId || '').trim().slice(0, 64);
      const bookingId = routedBookingId
        || (reservedBy && !reservedBy.startsWith('contract:') ? reservedBy : null);
      const payload = {
        tenantName: t.name,
        tenantPhone: String(t.phone || '').replace(/[\s-]/g, ''),
        tenantEmail: t.email || null,
        roomId: t.roomId,
        monthlyRent: rent,
        deposit: rent * 2,
        moveInDate: new Date().toISOString().slice(0, 10),
        termMonths: 12,
        expiresInHours: 168,
      };
      if (bookingId) payload.bookingId = bookingId;
      const d = await apiCall('/api/contracts/quick-invite', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setLiveLink({
        url: d.invitation.url,
        expiresAt: d.invitation.expiresAt,
        invitationId: d.invitation.id,
      });
      addActivity && addActivity({ icon: '✨',
        text: bookingId
          ? `สร้างสัญญาจากการจอง ${bookingId} + ส่งลิงก์ให้ ${t.name} (ห้อง ${t.roomId})`
          : `สร้างสัญญา + ส่งลิงก์ให้ ${t.name} (ห้อง ${t.roomId})`,
        type: 'contract' });
      reload();
    } catch (err) {
      const body = err && (err.raw || err.body) ? (err.raw || err.body) : {};
      setToast && setToast({
        kind: 'danger',
        message: body.code === 'ROOM_RESERVED'
          ? {
              title: 'ห้องนี้ถูกจองอยู่แล้ว',
              description: 'ถ้าเป็น booking ที่เพิ่งอนุมัติ ให้เปิดจากรายการจองหรือ refresh แล้วลองสร้างสัญญาอีกครั้ง',
            }
          : body.hint
            ? {
                title: 'สร้างสัญญาล้มเหลว',
                description: `${err.message}${body.code ? ` (${body.code})` : ''} — ${body.hint}`,
              }
          : 'สร้างสัญญาล้มเหลว: ' + err.message,
      });
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
      if (window.toastError && setToast) {
        window.toastError(setToast, err, { action: 'ยกเลิกลิงก์สัญญา' });
      } else {
        setToast && setToast({ kind: 'danger', message: 'ยกเลิกล้มเหลว: ' + err.message });
      }
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
      if (onTenantChanged) onTenantChanged();
    } catch (err) {
      // Server responses (CITIZEN_ID_DUPLICATE / ROOM_OCCUPIED / BAD_STATUS)
      // carry both error + hint; surface them inline in the review panel
      // so admin can act on the next-step guidance instead of guessing.
      const body = (err && (err.raw || err.body)) || {};
      const issues = Array.isArray(body.issueSummary)
        ? body.issueSummary
        : (Array.isArray(body.issues) ? body.issues : []);
      setApproveError({
        error: err.message || 'เกิดข้อผิดพลาด',
        hint: body.hint || (body.nextActions && body.nextActions.hint) || null,
        issues,
        code: err.code || body.code || null,
      });
      const issueText = issues.slice(0, 4).map((it) => {
        const detail = it && it.detail && typeof it.detail === 'object' ? it.detail : {};
        const values = [];
        if (detail.monthlyRent !== undefined) values.push(`ค่าเช่า ${detail.monthlyRent}`);
        if (detail.minimumRent !== undefined) values.push(`ขั้นต่ำ ${detail.minimumRent}`);
        const valueText = values.length ? ` (${values.join(' / ')})` : '';
        return `• ${it.label || it.field || it.code || 'ตรวจสอบข้อมูล'}${valueText}${it.action ? ` — ${it.action}` : ''}`;
      }).join('\n');
      setToast && setToast({
        kind: 'danger',
        message: {
          title: 'อนุมัติล้มเหลว',
          description: [err.message || '', issueText, body.hint].filter(Boolean).join('\n'),
        },
      });
    } finally { setBusy(false); }
  };

  // Cancel an active contract through checkout when possible so early
  // move-out gets the full cascade: contract ended, tenant moved out,
  // room freed, sessions/cards revoked, recurring charges disabled, and
  // closing bill generated. Direct contract PUT remains a fallback for
  // legacy rows where tenantDbId cannot be resolved.
  const cancelContract = async () => {
    if (!contract) return;
    const reason = (cancelReason || '').trim();
    if (reason.length < 5) {
      setToast && setToast({ kind: 'danger', message: 'กรุณาระบุเหตุผลก่อนยกเลิกสัญญาอย่างน้อย 5 ตัวอักษร' });
      return;
    }
    setBusy(true);
    try {
      if (tenantDbId) {
        await apiCall(`/api/tenants/${tenantDbId}/checkout`, {
          method: 'POST',
          body: JSON.stringify({
            reason,
            generateClosingBill: true,
          }),
        });
      } else {
        await apiCall(`/api/contracts/${contract.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            status: 'ended',
            closeType: 'early_move_out',
            closeReason: reason,
          }),
        });
      }
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
      if (onTenantChanged) onTenantChanged();
      // Drawer becomes detached anyway once `tenants` recomputes (this row
      // no longer has r.tenant). Close it explicitly so admin doesn't see
      // an empty drawer hanging open.
      if (onClosed) onClosed();
    } catch (err) {
      if (window.toastError && setToast) {
        window.toastError(setToast, err, { action: 'ยกเลิกสัญญา' });
      } else {
        setToast && setToast({ kind: 'danger', message: 'ยกเลิกล้มเหลว: ' + err.message });
      }
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

  if (t.tenantStatus && t.tenantStatus !== 'active') {
    return (
      <Card style={{ padding: 16, background: C.surfaceAlt }}>
        <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6, marginBottom: 10 }}>
          ผู้เช่าย้ายออกแล้ว สัญญาปัจจุบันจึงไม่เปิดให้ check-in/ยกเลิกซ้ำ ระบบป้องกันการสร้างสัญญาซ้อนและการเปิดห้องเดิมผิดคน
        </div>
        <Btn variant="secondary" size="sm" onClick={() => { window.location.hash = `#tenants?tenantId=${encodeURIComponent(t.dbId || t.tenantId || '')}&tab=history`; }}>
          ดูสัญญาเก่า/บิล/audit
        </Btn>
      </Card>
    );
  }

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
            onDone={() => { setShowCheckin(false); reload(); if (onTenantChanged) onTenantChanged();
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
          <Btn variant="danger" onClick={onConfirm} disabled={busy || reason.trim().length < 5}>
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
        <b style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 14 }}>
          ฿{fmtCurrency(rent)}
        </b>
      </Row>
      <Row icon="🏦" label="เงินมัดจำ">
        <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>
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
                     fontFamily: mono ? 'JetBrains Mono, monospace' : 'inherit' }}>{v || '—'}</span>
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
          {approveError.issues && approveError.issues.length ? (
            <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
              {approveError.issues.slice(0, 5).map((it, idx) => (
                <li key={idx}>
                  <b>{it.label || it.field || it.code || 'ตรวจสอบข้อมูล'}</b>
                  {it.detail && it.detail.monthlyRent !== undefined ? ` (ค่าเช่า ${it.detail.monthlyRent}` : null}
                  {it.detail && it.detail.minimumRent !== undefined ? ` / ขั้นต่ำ ${it.detail.minimumRent})` : (it.detail && it.detail.monthlyRent !== undefined ? ')' : null)}
                  {it.action ? ` — ${it.action}` : null}
                </li>
              ))}
            </ul>
          ) : null}
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
  const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
  const contractTodayYmd = window.contractTodayYmd || (() => new Date().toISOString().slice(0, 10));
  const addContractMonths = window.addContractMonths || (() => '');
  const estimateContractMonths = window.estimateContractMonths || (() => null);
  const contractDateSummary = window.contractDateSummary || (() => '');
  const initialStartDate = contractTodayYmd();
  const [form, setForm] = React.useState({
    moveInDate: initialStartDate,
    monthlyRent: String(tenant.rent || ''),
    depositAmount: String((tenant.rent || 0) * 2),
    termMonths: '12',
    endDate: addContractMonths(initialStartDate, 12),
    discountPct: '',  // empty → resolved from termMonths + config.discounts
  });
  const [busy, setBusy] = React.useState(false);
  const termNumber = Number(form.termMonths);
  const termValid = form.termMonths === ''
    || (Number.isInteger(termNumber) && termNumber >= 1 && termNumber <= 60);
  const maxEndDate = form.moveInDate ? addContractMonths(form.moveInDate, 60) : '';
  const endDateValid = !form.endDate
    || (/^\d{4}-\d{2}-\d{2}$/.test(form.endDate)
      && form.endDate >= form.moveInDate
      && (!maxEndDate || form.endDate <= maxEndDate));
  const endDateErrorText = form.endDate && form.endDate < form.moveInDate
    ? 'วันสิ้นสุดต้องไม่ก่อนวันที่เข้าพัก'
    : (form.endDate && maxEndDate && form.endDate > maxEndDate
      ? 'วันสิ้นสุดต้องไม่เกิน 60 เดือนจากวันที่เข้าพัก'
      : 'วันที่สัญญาไม่ถูกต้อง');
  const setMoveInDate = (value) => {
    setForm((f) => ({
      ...f,
      moveInDate: value,
      endDate: f.termMonths ? (addContractMonths(value, Number(f.termMonths)) || f.endDate) : f.endDate,
    }));
  };
  const setTermMonths = (value) => {
    setForm((f) => ({
      ...f,
      termMonths: value,
      endDate: value ? (addContractMonths(f.moveInDate, Number(value)) || f.endDate) : '',
    }));
  };
  const setEndDate = (value) => {
    setForm((f) => {
      const estimated = value ? estimateContractMonths(f.moveInDate, value, 60) : null;
      return {
        ...f,
        endDate: value,
        termMonths: estimated ? String(estimated) : '',
      };
    });
  };
  const submit = async (e) => {
    e.preventDefault();
    if (!tenant.roomId) {
      onError && onError('ไม่พบห้องของผู้เช่า — กำหนดห้องที่หน้ารายชื่อก่อน');
      return;
    }
    if (!termValid) {
      onError && onError('ระยะสัญญาต้องเป็นจำนวนเต็ม 1-60 เดือน หรือเว้นว่างสำหรับสัญญาไม่จำกัดเวลา');
      return;
    }
    if (!endDateValid) {
      onError && onError(endDateErrorText);
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
      if (form.endDate) payload.endDate = form.endDate;
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
          <Btn variant="primary" onClick={submit} disabled={busy || !termValid || !endDateValid}>
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
              onChange={(e) => setMoveInDate(e.target.value)}
              required style={inInp} />
          </div>
          <div>
            <label style={inLbl}>ระยะสัญญา (เดือนนับจากวันที่เข้าพัก)</label>
            <input type="number" min="1" max="60" value={form.termMonths}
              onChange={(e) => setTermMonths(e.target.value)}
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
          <label style={inLbl}>วันสิ้นสุดสัญญา (คำนวณอัตโนมัติ/แก้เองได้)</label>
          <input type="date" value={form.endDate}
            onChange={(e) => setEndDate(e.target.value)}
            style={inInp} />
        </div>
        <div>
          <label style={inLbl}>ส่วนลด % (เว้นว่างเพื่อใช้จาก config.discounts ตามระยะสัญญา)</label>
          <input type="number" step="0.1" min="0" max="50" value={form.discountPct}
            onChange={(e) => setForm({ ...form, discountPct: e.target.value })}
            placeholder="ปล่อยว่าง = auto" style={inInp} />
        </div>
        <div style={{
          padding: 10,
          background: endDateValid ? C.infoSoft : C.dangerSoft,
          border: `1px solid ${endDateValid ? C.border : '#f5c0b4'}`,
          borderRadius: 6,
          fontSize: 12,
          color: endDateValid ? (C.infoInk || C.muted) : (C.dangerInk || '#8a2f2b'),
          lineHeight: 1.5,
        }}>
          {endDateValid
            ? contractDateSummary(form.moveInDate, form.termMonths, form.endDate)
            : `${endDateErrorText} ระบบจะยังไม่ให้เช็คอิน`}
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
  const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
  const addContractMonths = window.addContractMonths || (() => '');
  const estimateContractMonths = window.estimateContractMonths || (() => null);
  const contractDateSummary = window.contractDateSummary || (() => '');
  const contractStartDate = contract.start_date ? String(contract.start_date).slice(0, 10) : '';
  const [form, setForm] = React.useState({
    discountPct: contract.discount_pct != null ? String(contract.discount_pct) : '0',
    termMonths:  contract.term_months  != null ? String(contract.term_months)  : '',
    endDate:     contract.end_date ? String(contract.end_date).slice(0, 10) : '',
  });
  const [busy, setBusy] = React.useState(false);
  const termNumber = Number(form.termMonths);
  const termValid = form.termMonths === ''
    || (Number.isInteger(termNumber) && termNumber >= 1 && termNumber <= 120);
  const maxEndDate = contractStartDate ? addContractMonths(contractStartDate, 120) : '';
  const endDateValid = !form.endDate || !contractStartDate
    || (form.endDate >= contractStartDate && (!maxEndDate || form.endDate <= maxEndDate));
  const endDateErrorText = form.endDate && contractStartDate && form.endDate < contractStartDate
    ? 'วันสิ้นสุดต้องไม่ก่อนวันเริ่มสัญญา'
    : (form.endDate && maxEndDate && form.endDate > maxEndDate
      ? 'วันสิ้นสุดต้องไม่เกิน 120 เดือนจากวันเริ่มสัญญา'
      : 'วันที่สัญญาไม่ถูกต้อง');
  const setTermMonths = (value) => {
    setForm((f) => ({
      ...f,
      termMonths: value,
      endDate: value && contractStartDate
        ? (addContractMonths(contractStartDate, Number(value)) || f.endDate)
        : '',
    }));
  };
  const setEndDate = (value) => {
    setForm((f) => {
      const estimated = value && contractStartDate
        ? estimateContractMonths(contractStartDate, value, 120)
        : null;
      return {
        ...f,
        endDate: value,
        termMonths: estimated ? String(estimated) : '',
      };
    });
  };
  const submit = async (e) => {
    e.preventDefault();
    if (!termValid) {
      onError && onError('ระยะสัญญาต้องเป็นจำนวนเต็ม 1-120 เดือน หรือเว้นว่างสำหรับสัญญาไม่จำกัดเวลา');
      return;
    }
    if (!endDateValid) {
      onError && onError(endDateErrorText);
      return;
    }
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
          <Btn variant="primary" onClick={submit} disabled={busy || !termValid || !endDateValid}>
            {busy ? '…' : 'บันทึก'}
          </Btn>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
          วันเริ่มสัญญา: <b>{contractStartDate ? window.fmtDateTH(contractStartDate) : '-'}</b>
        </div>
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
              onChange={(e) => setTermMonths(e.target.value)}
              style={inInp} />
          </div>
        </div>
        <div>
          <label style={inLbl}>วันสิ้นสุด</label>
          <input type="date" value={form.endDate}
            onChange={(e) => setEndDate(e.target.value)}
            style={inInp} />
        </div>
        <div style={{
          padding: 10,
          background: endDateValid ? C.infoSoft : C.dangerSoft,
          border: `1px solid ${endDateValid ? C.border : '#f5c0b4'}`,
          borderRadius: 6,
          fontSize: 12,
          color: endDateValid ? (C.infoInk || C.muted) : (C.dangerInk || '#8a2f2b'),
          lineHeight: 1.5,
        }}>
          {endDateValid
            ? contractDateSummary(contractStartDate, form.termMonths, form.endDate)
            : `${endDateErrorText} ระบบจะยังไม่ให้บันทึก`}
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
  const { Card, DataTable, Pill, EmptyState } = window;

  // Real bill history. Prefer tenantId so a current tenant never sees bills
  // from the previous occupant of the same room; fall back to roomId for
  // legacy rows that predate tenants.id wiring.
  const [bills, setBills] = React.useState(null);   // null = loading
  const [err, setErr] = React.useState(null);
  React.useEffect(() => {
    if (!t.dbId && !t.roomId) { setBills([]); return; }
    let cancel = false;
    setBills(null);
    setErr(null);
    const qs = t.dbId
      ? `tenantId=${encodeURIComponent(t.dbId)}`
      : `roomId=${encodeURIComponent(t.roomId)}`;
    fetch(`/api/bills?${qs}&limit=24`, { credentials: 'same-origin' })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (cancel) return;
        if (!r.ok) { setErr(d.error || `HTTP ${r.status}`); setBills([]); return; }
        setBills(Array.isArray(d.bills) ? d.bills : []);
      })
      .catch((e) => { if (!cancel) { setErr(e.message || 'network error'); setBills([]); } });
    return () => { cancel = true; };
  }, [t.dbId, t.roomId]);

  const periodTH = (period) => {
    if (!period || typeof period !== 'string') return period || '';
    const m = period.match(/^(\d{4})-(\d{2})/);
    if (!m) return period;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, 1);
    return fmtMonthTH ? fmtMonthTH(d) : period;
  };
  const statusLabel = { paid: 'ชำระแล้ว', pending: 'รอชำระ', overdue: 'ค้างชำระ', void: 'ยกเลิก' };
  const statusColor = { paid: 'success', pending: 'warning', overdue: 'danger', void: 'muted' };
  const ownerCell = (b) => {
    const tenantId = b.tenant_id || b.bill_tenant_id || t.dbId || '';
    const name = b.bill_tenant_name || t.name || (tenantId ? `tenant_id ${tenantId}` : '-');
    const phone = b.bill_tenant_phone || t.phone || '';
    return (
      <div style={{ lineHeight: 1.35 }}>
        <div style={{ fontSize: 12.5, color: C.ink, fontWeight: 500 }}>{name}</div>
        <div style={{ fontSize: 10.5, color: C.muted }}>
          tenant_id={tenantId || '-'}{phone ? ` · ${phone}` : ''}
        </div>
      </div>
    );
  };

  const columns = [
    { key: 'bill_no', label: 'เลขที่บิล', minWidth: 140, render: b => <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>{b.bill_no || `#${b.id}`}</span> },
    { key: 'owner', label: 'เจ้าของ', minWidth: 170, render: ownerCell },
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
    return (
      <Card style={{ padding: 16, color: C.danger || '#a23', fontSize: 13, lineHeight: 1.6 }}>
        โหลดประวัติบิลไม่สำเร็จ: {err}
        <div style={{ color: C.muted, marginTop: 4 }}>ยังไม่แสดงข้อมูล fallback เพื่อป้องกันบิลของผู้เช่าเก่าหรือผู้เช่าคนใหม่ในห้องเดียวกันปนกัน</div>
      </Card>
    );
  }
  if (bills.length === 0) {
    return EmptyState
      ? <EmptyState title="ยังไม่มีประวัติบิล" description={t.dbId ? 'ยังไม่พบบิลที่ผูกกับผู้เช่าคนนี้' : 'ยังไม่พบบิลจาก roomId fallback'} />
      : <div style={{ padding: 16, color: C.muted, fontSize: 13 }}>ยังไม่มีประวัติบิลสำหรับผู้เช่าคนนี้</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Card style={{ padding: 12, background: C.surfaceAlt }}>
        <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>
          {t.dbId
            ? `แสดงเฉพาะบิลที่ผูก tenant_id=${t.dbId} เพื่อไม่ปนกับผู้เช่าคนอื่นในห้อง ${t.roomId || '-'}`
            : `ข้อมูลเก่าไม่มี tenant_id จึง fallback ด้วย roomId=${t.roomId || '-'} โปรดตรวจเลขห้องก่อนใช้อ้างอิง`}
        </div>
      </Card>
      <DataTable columns={columns} rows={bills} density="compact" stickyHeader={false} />
    </div>
  );
}

function TabHistory({ t }) {
  const C = window.ADMIN_C;
  const { Card, DataTable, Pill } = window;
  const [history, setHistory] = React.useState(null);
  const [err, setErr] = React.useState(null);

  React.useEffect(() => {
    if (!t.dbId) { setHistory(null); return; }
    let cancel = false;
    setHistory(null);
    setErr(null);
    fetch(`/api/tenants/${encodeURIComponent(t.dbId)}/history`, { credentials: 'same-origin' })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (cancel) return;
        if (!r.ok) { setErr(d.error || `HTTP ${r.status}`); setHistory(null); return; }
        setHistory(d);
      })
      .catch((e) => { if (!cancel) setErr(e.message || 'network error'); });
    return () => { cancel = true; };
  }, [t.dbId]);

  if (!t.dbId) {
    return <Card style={{ padding: 16, color: C.muted }}>ยังไม่มี tenant_id สำหรับเปิดประวัติย้อนหลัง</Card>;
  }
  if (err) {
    return <Card style={{ padding: 16, color: C.danger }}>โหลดประวัติย้อนหลังไม่สำเร็จ: {err}</Card>;
  }
  if (!history) {
    return <div style={{ padding: 24, color: C.muted, textAlign: 'center' }}>กำลังโหลดประวัติย้อนหลัง...</div>;
  }

  const totals = history.totals || {};
  const activeCards = Number(totals.accessCardsActive || 0);
  const outstanding = Number(totals.billsOutstanding || 0);
  const contracts = Array.isArray(history.contracts) ? history.contracts : [];
  const alerts = [];
  if (t.tenantStatus !== 'active' && activeCards > 0) {
    alerts.push({
      tone: 'danger',
      title: 'ผู้เช่าเก่ายังมีบัตร active',
      detail: 'ควร revoke บัตรทันทีที่หน้า Access Control หรือเช็ก checkout cascade เพราะเป็นความเสี่ยงด้านสิทธิ์เข้าออก',
    });
  }
  if (outstanding > 0) {
    alerts.push({
      tone: 'warning',
      title: 'ยังมียอดค้างชำระ',
      detail: `ยอดค้างรวม ${outstanding.toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท ใช้ตารางบิลด้านล่างตรวจรอบบิลก่อนติดตามผู้เช่า`,
    });
  }
  if (contracts.length === 0) {
    alerts.push({
      tone: 'warning',
      title: 'ไม่พบสัญญาในประวัติ',
      detail: 'ผู้เช่านี้อาจเป็นข้อมูลเก่าก่อนเปิดระบบสัญญา ควรตรวจ audit/บิลและเพิ่มบันทึกภายในถ้าต้องใช้อ้างอิง',
    });
  }
  if (t.tenantStatus === 'active' && !(history.identity?.front_url && history.identity?.back_url)) {
    alerts.push({
      tone: 'info',
      title: 'เอกสารยืนยันตัวยังไม่ครบ',
      detail: 'ถ้าจะทำสัญญาใหม่หรืออนุมัติสัญญา ควรอัปโหลดภาพบัตรประชาชนหน้า/หลังให้ครบก่อน',
    });
  }

  const contractCols = [
    { key: 'contract_no', label: 'สัญญา', minWidth: 120 },
    { key: 'room_id', label: 'ห้อง', minWidth: 70 },
    { key: 'start_date', label: 'เริ่ม', minWidth: 95, render: c => String(c.start_date || '-').slice(0, 10) },
    { key: 'end_date', label: 'สิ้นสุด', minWidth: 95, render: c => String(c.end_date || '-').slice(0, 10) },
    { key: 'status', label: 'สถานะ', minWidth: 90, render: c => <Pill size="sm" color={c.status === 'active' ? 'success' : 'muted'}>{c.status}</Pill> },
  ];
  const billCols = [
    { key: 'bill_no', label: 'บิล', minWidth: 130 },
    { key: 'owner', label: 'เจ้าของ', minWidth: 165, render: b => (
      <div style={{ lineHeight: 1.35 }}>
        <div style={{ fontSize: 12.5 }}>{b.bill_tenant_name || t.name || '-'}</div>
        <div style={{ fontSize: 10.5, color: C.muted }}>tenant_id={b.tenant_id || '-'}</div>
      </div>
    ) },
    { key: 'room_id', label: 'ห้อง', minWidth: 70 },
    { key: 'period', label: 'รอบ', minWidth: 80 },
    { key: 'total', label: 'ยอด', align: 'right', minWidth: 90, render: b => Number(b.total || 0).toLocaleString('th-TH', { minimumFractionDigits: 2 }) },
    { key: 'status', label: 'สถานะ', minWidth: 90, render: b => <Pill size="sm" color={b.status === 'paid' ? 'success' : (b.status === 'void' ? 'muted' : 'warning')}>{b.status}</Pill> },
  ];
  const auditCols = [
    { key: 'created_at', label: 'เวลา', minWidth: 130, render: a => String(a.created_at || '').slice(0, 19).replace('T', ' ') },
    { key: 'action', label: 'เหตุการณ์', minWidth: 160 },
    { key: 'user_id', label: 'ผู้ทำรายการ', minWidth: 100, render: a => a.user_id || '-' },
  ];
  const paymentCols = [
    { key: 'bill_no', label: 'บิล', minWidth: 130, render: p => p.bill_no || `#${p.bill_id || '-'}` },
    { key: 'amount', label: 'ยอดชำระ', align: 'right', minWidth: 95, render: p => Number(p.amount || 0).toLocaleString('th-TH', { minimumFractionDigits: 2 }) },
    { key: 'method', label: 'วิธี', minWidth: 90, render: p => p.method || '-' },
    { key: 'status', label: 'สถานะ', minWidth: 90, render: p => <Pill size="sm" color={p.status === 'verified' ? 'success' : (p.status === 'rejected' ? 'danger' : 'warning')}>{p.status}</Pill> },
    { key: 'created_at', label: 'เวลา', minWidth: 130, render: p => String(p.created_at || '').slice(0, 19).replace('T', ' ') },
  ];
  const cardCols = [
    { key: 'card_id', label: 'บัตร', minWidth: 120 },
    { key: 'room_id', label: 'ห้อง', minWidth: 70 },
    { key: 'status', label: 'สถานะ', minWidth: 90, render: c => <Pill size="sm" color={c.status === 'active' ? 'success' : 'muted'}>{c.status}</Pill> },
    { key: 'issued_at', label: 'ออกบัตร', minWidth: 130, render: c => String(c.issued_at || '').slice(0, 19).replace('T', ' ') },
    { key: 'revoked_at', label: 'ยกเลิก', minWidth: 130, render: c => c.revoked_at ? String(c.revoked_at).slice(0, 19).replace('T', ' ') : '-' },
  ];
  const ticketCols = [
    { key: 'ticket_no', label: 'งานซ่อม', minWidth: 120 },
    { key: 'room_id', label: 'ห้อง', minWidth: 70 },
    { key: 'title', label: 'เรื่อง', minWidth: 160, render: x => x.title || x.category || '-' },
    { key: 'status', label: 'สถานะ', minWidth: 90, render: x => <Pill size="sm" color={x.status === 'completed' ? 'success' : (x.status === 'cancelled' ? 'muted' : 'warning')}>{x.status}</Pill> },
    { key: 'created_at', label: 'แจ้งเมื่อ', minWidth: 130, render: x => String(x.created_at || '').slice(0, 19).replace('T', ' ') },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {alerts.map((a, idx) => {
        const color = a.tone === 'danger' ? C.danger : (a.tone === 'warning' ? C.warning : (C.info || C.muted));
        const bg = a.tone === 'danger' ? C.dangerSoft : (a.tone === 'warning' ? C.warningSoft : (C.infoSoft || C.surfaceAlt));
        return (
          <Card key={idx} style={{ padding: 12, border: `1px solid ${color}`, background: bg }}>
            <div style={{ fontSize: 13, fontWeight: 700, color }}>{a.title}</div>
            <div style={{ fontSize: 12.5, color: C.ink, lineHeight: 1.55, marginTop: 4 }}>{a.detail}</div>
          </Card>
        );
      })}
      <Card style={{ padding: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: 10 }}>
          <HistoryMetric label="สัญญา" value={totals.contracts || 0} C={C} />
          <HistoryMetric label="บิลค้าง" value={outstanding.toLocaleString('th-TH', { minimumFractionDigits: 2 })} C={C} />
          <HistoryMetric label="จ่ายแล้ว" value={Number(totals.paymentsTotal || 0).toLocaleString('th-TH', { minimumFractionDigits: 2 })} C={C} />
          <HistoryMetric label="บัตร active" value={activeCards} C={C} />
          <HistoryMetric label="งานซ่อมเปิด" value={totals.ticketsOpen || 0} C={C} />
        </div>
      </Card>
      <Card style={{ padding: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>สัญญาทั้งหมด</div>
        <DataTable columns={contractCols} rows={contracts} density="compact" stickyHeader={false} empty="ไม่มีประวัติสัญญา" />
      </Card>
      <Card style={{ padding: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>บิลของผู้เช่าคนนี้</div>
        <DataTable columns={billCols} rows={history.bills || []} density="compact" stickyHeader={false} empty="ไม่มีบิล" />
      </Card>
      <Card style={{ padding: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>การชำระเงิน</div>
        <DataTable columns={paymentCols} rows={history.payments || []} density="compact" stickyHeader={false} empty="ไม่มีประวัติการชำระ" />
      </Card>
      <Card style={{ padding: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>บัตรเข้าออก</div>
        <DataTable columns={cardCols} rows={history.accessCards || []} density="compact" stickyHeader={false} empty="ไม่มีบัตรเข้าออก" />
      </Card>
      <Card style={{ padding: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>งานซ่อมที่เกี่ยวข้อง</div>
        <DataTable columns={ticketCols} rows={history.tickets || []} density="compact" stickyHeader={false} empty="ไม่มีงานซ่อม" />
      </Card>
      <Card style={{ padding: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Audit ล่าสุด</div>
        <DataTable columns={auditCols} rows={history.auditLog || []} density="compact" stickyHeader={false} empty="ไม่มี audit log" />
      </Card>
    </div>
  );
}

function HistoryMetric({ label, value, C }) {
  return (
    <div style={{ padding: 10, border: `1px solid ${C.border}`, borderRadius: 8, background: C.surfaceAlt }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: C.ink }}>{value}</div>
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
