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
  const { fmt, fmtCurrency, resolveRoomRent, resolveRoomDeposit } = window;
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
      const resolvedRoomRent = room
        ? (resolveRoomRent ? resolveRoomRent(room, config) : { rent: Number(room.rent) || 0 })
        : null;
      const rent = currentRoomId && resolvedRoomRent
        ? Number(resolvedRoomRent.rent || 0)
        : (row.last_monthly_rent != null
          ? Number(row.last_monthly_rent)
          : (resolvedRoomRent ? Number(resolvedRoomRent.rent || 0) : 0));
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

  const duplicateActiveRoomConflicts = useMemo(() => {
    const byRoom = new Map();
    for (const t of tenants) {
      if (t.tenantStatus !== 'active' || !t.currentRoomId) continue;
      const roomId = String(t.currentRoomId);
      if (!byRoom.has(roomId)) byRoom.set(roomId, []);
      byRoom.get(roomId).push(t);
    }
    return Array.from(byRoom.entries())
      .filter(([, rows]) => rows.length > 1)
      .map(([roomId, rows]) => ({
        roomId,
        count: rows.length,
        tenants: rows.map((t) => ({
          id: t.dbId,
          name: t.name,
          phone: t.phone,
          since: t.since,
          contractNo: t.lastContractNo,
        })),
      }));
  }, [tenants]);

  const duplicateActiveRoomIds = useMemo(
    () => new Set(duplicateActiveRoomConflicts.map((x) => x.roomId)),
    [duplicateActiveRoomConflicts]
  );

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
    duplicateRooms: duplicateActiveRoomConflicts.length,
  }), [tenants, duplicateActiveRoomConflicts]);

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
          {t.currentRoomId && duplicateActiveRoomIds.has(String(t.currentRoomId)) ? (
            <div style={{ marginTop: 3 }}>
              <Pill color="danger" size="sm">ห้องนี้มีผู้เช่าซ้ำ</Pill>
            </div>
          ) : null}
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
            <span style={{ fontSize: 11, color: C.danger }}>ค้าง {fmtCurrency(t.outstandingTotal)}</span>
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
        {duplicateActiveRoomConflicts.length ? (
          <div style={{
            marginTop: 12, padding: 10, borderRadius: 8,
            border: `1px solid ${C.danger || '#dc2626'}`,
            background: C.dangerSoft || '#fee2e2',
            color: C.dangerInk || '#7f1d1d',
            fontSize: 12.5, lineHeight: 1.5,
          }}>
            <b>พบห้องที่มีผู้เช่า active ซ้ำ {duplicateActiveRoomConflicts.length} ห้อง</b>
            {duplicateActiveRoomConflicts.slice(0, 5).map((x) => (
              <div key={x.roomId} style={{ marginTop: 4 }}>
                ห้อง {x.roomId}: {x.tenants.map((t) =>
                  `${t.name || '-'}${t.phone ? ` (${t.phone})` : ''}${t.contractNo ? ` · สัญญา ${t.contractNo}` : ''}`
                ).join(' / ')}
              </div>
            ))}
            <div style={{ marginTop: 4 }}>
              ให้เลือกผู้เช่าที่ถูกต้อง แล้ว checkout/ย้ายออกผู้เช่าที่ไม่อยู่จริงก่อนออกบิลหรืออนุมัติสัญญาใหม่
            </div>
          </div>
        ) : null}
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
            {drawerTab === 'contract' && <TabContract t={active} routeBookingId={routeBookingId} config={config} setToast={setToast} addActivity={addActivity} setRooms={setRooms} onTenantChanged={refreshTenants} onClosed={() => setActiveId(null)} />}
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
    const cidDigits = form.citizenId ? form.citizenId.replace(/[\s-]/g, '') : '';
    if (cidDigits && !/^\d{13}$/.test(cidDigits)) {
      setToast && setToast({ kind: 'error', message: 'เลขบัตรประชาชนต้อง 13 หลัก' });
      return;
    }
    if (cidDigits && /^\d{13}$/.test(cidDigits)) {
      // Thai national-ID mod-11 check digit: Σ(digit[i] × (13−i)) for i=0..11,
      // then (11 − sum%11) % 10 must equal digit[12]. Catches transposed/typo'd
      // IDs before the round-trip (the server enforces the same mod-11 check).
      let sum = 0;
      for (let i = 0; i < 12; i++) sum += Number(cidDigits[i]) * (13 - i);
      if ((11 - (sum % 11)) % 10 !== Number(cidDigits[12])) {
        setToast && setToast({ kind: 'error', message: 'เลขบัตรประชาชนไม่ถูกต้อง (เลขตรวจสอบ mod-11 ไม่ผ่าน)' });
        return;
      }
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
              since: window.fmtDateTH ? window.fmtDateTH(new Date()) : new Date().toLocaleDateString('en-CA'),
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
function TabContract({ t, routeBookingId = '', config, setToast, addActivity, setRooms, onTenantChanged, onClosed }) {
  const C = window.ADMIN_C;
  const { fmtCurrency } = window;
  const { Card, DefList, Btn, Pill } = window;
  const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
  const resolveRoomRent = window.resolveRoomRent;
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
  const [contractConflict, setContractConflict] = React.useState(null);
  // Backfill modal for locked contracts with incomplete identity docs —
  // opened from LockedContractIdentityGapCard.
  const [backfilling, setBackfilling] = React.useState(false);

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
    setContractConflict(null);
    setBackfilling(false);
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
      const activeContract = (d.contracts || [])[0] || null;
      setContract(activeContract);
      if (activeContract) setContractConflict(null);
    } finally { setLoading(false); }
  }, [t.dbId, t.phone, t.tenantStatus]);
  React.useEffect(() => { reload(); }, [reload]);

  const fmtDate = (s) => s ? new Date(s).toLocaleDateString('th-TH') : '-';
  const contractRentInfo = React.useMemo(() => {
    const resolved = t.room && resolveRoomRent
      ? resolveRoomRent(t.room, config)
      : null;
    const resolvedRent = Number(resolved && resolved.rent);
    const fallbackRent = Number(t.rent);
    const rent = Number.isFinite(resolvedRent) && resolvedRent > 0
      ? resolvedRent
      : (Number.isFinite(fallbackRent) && fallbackRent > 0 ? fallbackRent : 0);
    const source = resolved && Number.isFinite(resolvedRent) && resolvedRent > 0
      ? (resolved.source || 'formula')
      : 'legacy';
    const sourceLabel = source === 'override'
      ? 'ราคาพิเศษรายห้อง'
      : (source === 'formula' ? 'เมนูตั้งราคา' : 'ค่าเดิมของห้อง');
    const depositInfo = t.room && resolveRoomDeposit
      ? resolveRoomDeposit(t.room, config, rent)
      : null;
    const resolvedDeposit = Number(depositInfo && depositInfo.deposit);
    const deposit = Number.isFinite(resolvedDeposit) && resolvedDeposit >= 0
      ? resolvedDeposit
      : (rent > 0 ? rent * 2 : 0);
    return {
      rent,
      deposit,
      source,
      sourceLabel,
      depositSource: depositInfo?.source || 'rent_x2',
      depositSourceLabel: depositInfo?.sourceLabel || 'ค่าเช่า x 2',
      warning: resolved && resolved.warning,
    };
  }, [t.room, t.rent, config, resolveRoomRent, resolveRoomDeposit]);
  const hasCurrentTenancy = t.tenantStatus === 'active' && !!t.currentRoomId;
  const identityGap = contractIdentityGap(contract);
  const lockedIdentityGap = !!(contract && contract.locked_at && identityGap);

  const lockedInviteBlockMessage = (prefix = 'สร้างลิงก์ไม่ได้') => ({
    title: `${prefix} — สัญญานี้ถูก lock แล้ว`,
    description: [
      identityGap ? `ข้อมูล/เอกสารที่ยังขาด: ${identityGap.labels.join(', ')}` : null,
      'ระบบป้องกันการออกลิงก์กรอกสัญญาบนฉบับที่ lock แล้ว เพราะผู้เช่าจะกรอกได้แต่แอดมิน approve/lock ซ้ำไม่ได้',
      'ทางแก้: เติมข้อมูล/อัปโหลดเอกสารย้อนหลังในข้อมูลผู้เช่า หรือสร้าง/ต่อสัญญาฉบับใหม่แล้วส่งลิงก์ก่อน lock',
    ].filter(Boolean).join('\n'),
  });

  const inviteDeliveryText = (delivery) => {
    if (!delivery) return 'สร้างลิงก์แล้ว แต่ยังไม่ทราบผลส่งอัตโนมัติ ให้คัดลอกลิงก์จากกล่องด้านบนส่งให้ผู้เช่า';
    const channel = ({
      line: 'LINE',
      email: 'อีเมล',
      sms: 'SMS',
      queue: 'คิวแจ้งเตือน',
      none: 'ช่องทางอัตโนมัติ',
    })[delivery.channel] || delivery.channel || 'ระบบแจ้งเตือน';
    const lineCount = Number(delivery.lineRecipientCount || 0);
    const suffix = lineCount > 0 ? ` · ห้องนี้ผูก LINE ${lineCount} บัญชี` : '';
    if (delivery.ok) return `ส่งลิงก์ให้ผู้เช่าทาง ${channel} แล้ว${suffix}`;
    if (delivery.queued) return `จัดคิวส่งลิงก์ทาง ${channel} แล้ว${suffix}`;
    if (delivery.requiresManualContact) {
      return `สร้างลิงก์แล้ว แต่ส่งอัตโนมัติไม่ได้ ให้คัดลอกลิงก์ส่งเองหรือโทรแจ้งผู้เช่า${suffix}`;
    }
    return `สร้างลิงก์แล้ว แต่ช่องทาง ${channel} ยังไม่พร้อม${delivery.reason ? ` (${delivery.reason})` : ''} ให้คัดลอกลิงก์ส่งเอง${suffix}`;
  };

  const showInviteCreatedToast = (d, title) => {
    const delivery = d && d.delivery;
    const deliveryKind = delivery && (delivery.ok || delivery.queued) ? 'success' : 'warning';
    setToast && setToast({
      kind: deliveryKind,
      message: {
        title,
        description: [
          inviteDeliveryText(delivery),
          'ขั้นต่อไป: รอผู้เช่ากรอกข้อมูล ถ่ายรูปบัตรประชาชนหน้า/หลัง และเซ็นผ่านลิงก์นี้ จากนั้นแอดมินกดตรวจสอบ + อนุมัติ',
        ].join('\n'),
      },
    });
  };

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

  const conflictFromError = (err) => {
    const body = err && (err.raw || err.body) ? (err.raw || err.body) : {};
    const code = body.code || (err && err.code);
    if (!['ROOM_CONTRACT_EXISTS', 'DRAFT_CONTRACT_EXISTS', 'TENANT_ROOM_CONTRACT_EXISTS'].includes(code)) return null;
    return {
      ...(body.conflict || {}),
      code,
      error: body.error || (err && err.message) || 'สร้างสัญญาใหม่ไม่ได้',
      hint: body.hint || (body.nextActions && body.nextActions.hint) || null,
      nextActions: body.nextActions || null,
    };
  };

  const openConflictContracts = (conflict = contractConflict) => {
    const params = new URLSearchParams();
    const roomId = String(conflict?.room_id || t.roomId || '').trim();
    const contractId = conflict?.id ? String(conflict.id) : '';
    if (roomId) params.set('room', roomId);
    if (contractId) params.set('contract', contractId);
    window.location.hash = `#contracts${params.toString() ? '?' + params.toString() : ''}`;
  };

  const openConflictPdf = (conflict = contractConflict) => {
    if (!conflict || !conflict.id) return;
    window.open(`/api/contracts/${encodeURIComponent(conflict.id)}/pdf`, '_blank', 'noopener');
  };

  const useExistingConflictContract = async (conflict = contractConflict) => {
    if (!conflict || !conflict.id) return;
    setBusy(true);
    try {
      const d = await apiCall(`/api/contracts/${conflict.id}`);
      setContract(d.contract || null);
      setContractConflict(null);
      setToast && setToast({ kind: 'success', message: 'เปิดสัญญาเดิมในหน้านี้แล้ว' });
    } catch (err) {
      if (window.toastError && setToast) {
        window.toastError(setToast, err, { action: 'เปิดสัญญาเดิม' });
      } else {
        setToast && setToast({ kind: 'danger', message: 'เปิดสัญญาเดิมล้มเหลว: ' + err.message });
      }
    } finally {
      setBusy(false);
    }
  };

  // Send link for an existing draft contract — the contract row already
  // carries room/rent, server just needs to mint the token.
  const sendInviteForExistingContract = async () => {
    if (!contract) return;
    if (contract.locked_at) {
      setToast && setToast({ kind: 'warning', message: lockedInviteBlockMessage() });
      return;
    }
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
      showInviteCreatedToast(d, 'สร้างลิงก์สัญญาเรียบร้อย');
      reload();
      if (onTenantChanged) onTenantChanged();
    } catch (err) {
      if (window.toastError && setToast) {
        window.toastError(setToast, err, { action: 'สร้าง/ส่งลิงก์สัญญา' });
      } else {
        setToast && setToast({ kind: 'danger', message: 'สร้างลิงก์ล้มเหลว: ' + err.message });
      }
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
    const rent = Number(contractRentInfo.rent);
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
      const contractDeposit = Number(contractRentInfo.deposit);
      const payload = {
        tenantName: t.name,
        tenantPhone: String(t.phone || '').replace(/[\s-]/g, ''),
        tenantEmail: t.email || null,
        roomId: t.roomId,
        monthlyRent: rent,
        deposit: Number.isFinite(contractDeposit) && contractDeposit >= 0 ? contractDeposit : rent * 2,
        // Local-timezone today: toISOString() is the UTC date — before 07:00
        // Thai time that backdates the contract's move-in by one day.
        moveInDate: window.contractTodayYmd ? window.contractTodayYmd()
          : new Date().toLocaleDateString('en-CA'),
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
      showInviteCreatedToast(d, bookingId
        ? 'สร้างสัญญาจาก booking และออกลิงก์แล้ว'
        : 'สร้างสัญญาและออกลิงก์แล้ว');
      reload();
    } catch (err) {
      const conflict = conflictFromError(err);
      if (conflict) {
        setContractConflict(conflict);
        setToast && setToast({
          kind: 'danger',
          message: {
            title: 'พบสัญญาเดิมของห้องนี้',
            description: 'ดูรายละเอียดในการ์ดสัญญาด้านล่าง แล้วเปิดสัญญาเดิมหรือปิดสัญญาเดิมก่อนสร้างใหม่',
          },
        });
        return;
      }
      if (window.toastError && setToast) {
        window.toastError(setToast, err, { action: 'สร้างสัญญา/ส่งลิงก์' });
        return;
      }
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
      setToast && setToast({
        kind: result && result.welcomeBillError ? 'warning' : 'success',
        message: {
          title: 'อนุมัติเรียบร้อย — สัญญาถูก lock',
          description: [
            result && result.welcomeBill
              ? `บิลรอบแรกถูกสร้างแล้ว: ${result.welcomeBill.bill_no || result.welcomeBill.billNo || 'ดูที่หน้าบิล'}`
              : 'ตรวจหน้าบิลเพื่อยืนยันบิลรอบแรกและส่งแจ้งเตือนให้ผู้เช่า',
            result && result.welcomeBillError
              ? `คำเตือนบิลรอบแรก: ${result.welcomeBillError}`
              : null,
            'ขั้นต่อไป: ตรวจบิล/ส่งบิลให้ผู้เช่า แล้ว flow ย้ายเข้าถือว่าจบ',
          ].filter(Boolean).join('\n'),
        },
      });
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
  const cancelContract = async (opts = {}) => {
    if (!contract && !tenantDbId) return;
    const reason = (cancelReason || '').trim();
    if (reason.length < 5) {
      setToast && setToast({ kind: 'danger', message: 'กรุณาระบุเหตุผลก่อนยกเลิกสัญญาอย่างน้อย 5 ตัวอักษร' });
      return;
    }
    setBusy(true);
    try {
      const closedRoomId = contract ? contract.room_id : (t.currentRoomId || t.roomId);
      const closedContractNo = contract ? contract.contract_no : 'no-contract';
      let checkoutResult = null;
      if (tenantDbId) {
        const body = { reason, generateClosingBill: true };
        // Deposit return rides on checkout (the only endpoint that can
        // persist contracts.deposit_returned). null = admin chose to skip.
        const fdr = opts && opts.finalDepositReturn;
        if (fdr != null && Number.isFinite(Number(fdr)) && Number(fdr) >= 0) {
          body.finalDepositReturn = Number(fdr);
        }
        // Final meter readings — server records them + bills the last
        // partial period's consumption on the closing bill.
        if (opts && opts.waterEndReading != null && Number.isFinite(Number(opts.waterEndReading))) {
          body.waterEndReading = Number(opts.waterEndReading);
        }
        if (opts && opts.elecEndReading != null && Number.isFinite(Number(opts.elecEndReading))) {
          body.elecEndReading = Number(opts.elecEndReading);
        }
        checkoutResult = await apiCall(`/api/tenants/${tenantDbId}/checkout`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
      } else if (contract) {
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
      const outstandingTotal = Number(checkoutResult && checkoutResult.outstandingTotal) || 0;
      const outstandingCount = (checkoutResult && Array.isArray(checkoutResult.outstandingBills))
        ? checkoutResult.outstandingBills.length : 0;
      const refundRecorded = checkoutResult && checkoutResult.refund != null
        ? Number(checkoutResult.refund) : null;
      const baseMsg = contract
        ? `ยกเลิกสัญญา ${closedContractNo} แล้ว — ห้อง ${closedRoomId} ว่าง`
        : `เช็คเอาท์ ${t.name} จากห้อง ${closedRoomId} แล้ว`;
      const closingBillInfo = checkoutResult && checkoutResult.closingBill;
      const meterSkipped = (checkoutResult && Array.isArray(checkoutResult.meterSkipped))
        ? checkoutResult.meterSkipped : [];
      const meterSkipNote = meterSkipped.length > 0
        ? `⚠️ ไม่ได้จดมิเตอร์${meterSkipped.map((mt) => (mt === 'water' ? 'น้ำ' : 'ไฟ')).join('/')} — ค่างวดสุดท้ายไม่ได้เรียกเก็บ`
        : null;
      const closingNote = closingBillInfo
        ? `ออกบิลปิดยอด ${closingBillInfo.bill_no} ${fmtCurrency(closingBillInfo.total)} แล้ว`
        : null;
      if (outstandingTotal > 0) {
        setToast && setToast({
          kind: 'warning',
          message: {
            title: baseMsg,
            description: [
              `⚠️ ยังมีบิลค้างชำระ ${outstandingCount} ใบ รวม ${fmtCurrency(outstandingTotal)}`,
              closingNote,
              refundRecorded != null ? `บันทึกคืนมัดจำ ${fmtCurrency(refundRecorded)} แล้ว` : null,
              meterSkipNote,
            ].filter(Boolean).join('\n'),
            // Continue the flow: jump straight to this tenant's open bills
            // instead of leaving the admin to find them in /admin#billing.
            action: {
              label: 'ดูบิลค้างของผู้เช่า →',
              onClick: () => { window.location.hash = '#billing'; },
            },
          },
        });
      } else {
        const successLines = [
          refundRecorded != null ? `บันทึกคืนมัดจำ ${fmtCurrency(refundRecorded)} แล้ว` : null,
          closingNote,
          'ไม่มีบิลค้างชำระ',
          meterSkipNote,
        ].filter(Boolean);
        setToast && setToast({
          kind: 'success',
          message: successLines.length
            ? { title: baseMsg, description: successLines.join('\n') }
            : baseMsg,
        });
      }
      addActivity && addActivity({
        icon: '🚫',
        text: contract
          ? `ยกเลิกสัญญา ${closedContractNo} (${t.name}, ห้อง ${closedRoomId}) — ${reason.slice(0, 60)}`
          : `เช็คเอาท์ ${t.name} (ห้อง ${closedRoomId}) — ${reason.slice(0, 60)}`,
        type: 'contract',
      });
      // Update parent rooms state so this tenant disappears from the
      // tenants table immediately — the server already cascaded room
      // status='vacant' + tenant removed, but the client-side `rooms`
      // blob would stay stale until the next full refetch.
      if (setRooms && closedRoomId) {
        setRooms((prev) => {
          if (!prev || !prev[closedRoomId]) return prev;
          const next = { ...prev };
          next[closedRoomId] = {
            ...next[closedRoomId],
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <ContractFlowChecklist
          t={t}
          contract={contract}
          liveLink={liveLink}
          reviewing={true}
          contractConflict={contractConflict}
          hasCurrentTenancy={hasCurrentTenancy}
          rentInfo={contractRentInfo}
          routeBookingId={routeBookingId}
          C={C}
          fmtCurrency={fmtCurrency}
        />
        <ContractReviewPanel
          detail={reviewing}
          busy={busy}
          approveError={approveError}
          onApprove={approveSubmitted}
          onReject={rejectSubmitted}
          onCancel={() => { setReviewing(null); setApproveError(null); }}
          C={C}
        />
      </div>
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
        {contractConflict ? (
          <ContractConflictCard
            conflict={contractConflict}
            tenant={t}
            busy={busy}
            C={C}
            onOpenContracts={() => openConflictContracts(contractConflict)}
            onOpenPdf={() => openConflictPdf(contractConflict)}
            onUseExisting={() => useExistingConflictContract(contractConflict)}
            onRefresh={reload}
          />
        ) : null}
        <ContractFlowChecklist
          t={t}
          contract={contract}
          liveLink={liveLink}
          reviewing={false}
          contractConflict={contractConflict}
          hasCurrentTenancy={hasCurrentTenancy}
          rentInfo={contractRentInfo}
          routeBookingId={routeBookingId}
          C={C}
          fmtCurrency={fmtCurrency}
        />
        <Card style={{ padding: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
            📜 ยังไม่มีสัญญาเช่า — ตรวจรายละเอียดก่อนส่งลิงก์
          </div>
          <ContractPreFlightSummary t={t} rentInfo={contractRentInfo} C={C} fmtCurrency={fmtCurrency} />
          <div style={{ fontSize: 12, color: C.muted, margin: '10px 0 14px', lineHeight: 1.5 }}>
            ค่าเช่า ห้อง และข้อมูลผู้เช่าทั้งหมดดึงจากระบบให้แล้ว — แอดมินไม่ต้องกรอกซ้ำ
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {hasCurrentTenancy ? (
              <ContractActionTile
                icon="🚪"
                title="เช็คเอาท์/ย้ายออก"
                desc="ผู้เช่ารายนี้อยู่ในห้องแล้ว จึงไม่ต้องเช็คอินซ้ำ หากต้องย้ายออกให้ปิดจากปุ่มนี้"
                onClick={() => setCancelling(true)}
                busy={busy}
                C={C}
                tone="danger"
              />
            ) : (
              <ContractActionTile
                icon="🔑"
                title="เช็คอินทันที"
                desc="แอดมินกรอกข้อมูลครบเอง — ใช้เมื่อมีบัตร/ที่อยู่ผู้เช่าอยู่แล้ว"
                onClick={() => setShowCheckin(true)}
                C={C}
              />
            )}
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
            rentInfo={contractRentInfo}
            onClose={() => setShowCheckin(false)}
            onDone={() => { setShowCheckin(false); reload(); if (onTenantChanged) onTenantChanged();
              setToast && setToast({ kind: 'success', message: `เช็คอิน ${t.name} เรียบร้อย` });
              addActivity && addActivity({ icon: '🔑', text: `เช็คอิน ${t.name} (ห้อง ${t.roomId})`, type: 'contract' });
            }}
            onError={(err) => {
              if (window.toastError && setToast) {
                window.toastError(setToast, err, { action: 'เช็คอิน' });
              } else {
                setToast && setToast({ kind: 'danger', message: 'เช็คอินล้มเหลว: ' + ((err && err.message) || err || 'unknown') });
              }
            }}
          />
        ) : null}
        {cancelling ? (
          <CancelContractModal
            contract={null}
            tenant={t}
            tenantDbId={tenantDbId}
            room={t.room}
            config={config}
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

  // Contract exists — show details + state-aware actions.
  const isLocked = !!contract.locked_at;
  const invStatus = contract.active_invitation_status;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {liveLinkCard}

      <ContractFlowChecklist
        t={t}
        contract={contract}
        liveLink={liveLink}
        reviewing={false}
        contractConflict={contractConflict}
        hasCurrentTenancy={hasCurrentTenancy}
        rentInfo={contractRentInfo}
        routeBookingId={routeBookingId}
        C={C}
        fmtCurrency={fmtCurrency}
      />

      {lockedIdentityGap ? (
        <LockedContractIdentityGapCard
          contract={contract}
          gap={identityGap}
          C={C}
          onBackfill={() => setBackfilling(true)}
          onOpenContracts={() => {
            window.location.hash = `#contracts?contract=${encodeURIComponent(contract.id)}&room=${encodeURIComponent(contract.room_id || '')}`;
          }}
          onOpenPdf={() => window.open(`/api/contracts/${contract.id}/pdf`, '_blank', 'noopener')}
        />
      ) : null}

      {backfilling && tenantDbId ? (
        <TenantIdentityBackfillModal
          tenantDbId={tenantDbId}
          tenantName={t.name}
          missing={identityGap && identityGap.warning ? identityGap.warning.missing : []}
          setToast={setToast}
          onClose={() => setBackfilling(false)}
          onSaved={() => { setBackfilling(false); reload(); }}
        />
      ) : null}

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
            { label: 'ค่าเช่า/เดือน', value: fmtCurrency(contract.monthly_rent), bold: true },
            { label: 'ส่วนลด',        value: Number(contract.discount_pct) > 0
                                              ? `${Number(contract.discount_pct).toFixed(1)}%` : 'ไม่มี' },
            { label: 'เงินมัดจำ',     value: fmtCurrency(contract.deposit) },
          ]}
        />
        <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Btn variant="secondary" size="sm" icon="📄"
            onClick={() => window.open(`/api/contracts/${contract.id}/pdf`, '_blank', 'noopener')}>
            ดู PDF
          </Btn>
          {(() => {
            // Renewal entry point — appears when the active contract is within
            // 60 days of its end (or already past it). Deep-links to the
            // contracts page which opens the prefilled renew modal.
            if (contract.status !== 'active' || !contract.end_date) return null;
            let dl = null;
            try {
              const e = new Date(String(contract.end_date).slice(0, 10) + 'T00:00:00');
              dl = Math.ceil((e.getTime() - Date.now()) / 86400000);
            } catch { /* unparsable end date */ }
            if (dl == null || dl > 60) return null;
            return (
              <Btn variant="primary" size="sm" icon="🔄"
                onClick={() => { window.location.hash = `#contracts?renew=${encodeURIComponent(contract.id)}`; }}>
                ต่อสัญญา{dl >= 0 ? ` (เหลือ ${dl} วัน)` : ' (เลยกำหนดแล้ว)'}
              </Btn>
            );
          })()}
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
          {isLocked ? (
            <Btn variant="ghost" size="sm" icon="🔒" disabled={true}
              title={identityGap
                ? `ส่งลิงก์ไม่ได้: สัญญา lock แล้วและยังขาด ${identityGap.labels.join(', ')}`
                : 'ส่งลิงก์ไม่ได้: สัญญา lock แล้ว'}>
              ส่งลิงก์ไม่ได้
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
          tenantDbId={tenantDbId}
          room={t.room}
          config={config}
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
function CancelContractModal({ contract, tenant, tenantDbId, room, config, reason, setReason, busy, onClose, onConfirm, C }) {
  const { Modal, Btn, fmtCurrency } = window;
  const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
  const roomId = contract ? contract.room_id : (tenant && (tenant.currentRoomId || tenant.roomId)) || '-';
  const monthlyRent = contract ? contract.monthly_rent : (tenant && tenant.rent);
  const deposit = contract ? contract.deposit : (Number(monthlyRent) > 0 ? Number(monthlyRent) * 2 : 0);
  // Outstanding pending/overdue bills for THIS tenant — fetched when the
  // modal opens so admin sees the real debt before confirming, instead of
  // the old generic "บิลที่ค้างอยู่ยังคงค้างไว้" line with no number.
  // null = loading, [] = none, undefined = lookup failed (non-blocking).
  const [outstanding, setOutstanding] = React.useState(tenantDbId ? null : []);
  // Deposit return: the checkout endpoint is the ONLY write path for
  // contracts.deposit_returned — if admin skips it here it can't be
  // recorded later, so the field lives in this modal.
  const [depositReturn, setDepositReturn] = React.useState('');
  // Final meter readings — metered rooms only. Empty = admin chose to skip
  // (server then won't bill the last partial period's usage, and warns).
  const [waterEnd, setWaterEnd] = React.useState('');
  const [elecEnd, setElecEnd] = React.useState('');
  const [lastReadings, setLastReadings] = React.useState({ water: null, elec: null });
  React.useEffect(() => {
    if (!tenantDbId || !apiCall) return;
    let cancelled = false;
    Promise.all([
      apiCall(`/api/bills?tenantId=${encodeURIComponent(tenantDbId)}&status=pending&limit=100`),
      apiCall(`/api/bills?tenantId=${encodeURIComponent(tenantDbId)}&status=overdue&limit=100`),
    ]).then(([p, o]) => {
      if (cancelled) return;
      setOutstanding([...(p.bills || []), ...(o.bills || [])]);
    }).catch(() => { if (!cancelled) setOutstanding(undefined); });
    return () => { cancelled = true; };
  }, [tenantDbId]);
  const roomObj = room || (tenant && tenant.room) || {};
  // Client-side mirror of billing.isFlatUtilityConfigured — flat-mode
  // utilities aren't metered, so their inputs are hidden.
  const isFlat = (p) => {
    const mode = String(roomObj[`${p}Mode`] ?? roomObj[`${p}_mode`] ?? '').toLowerCase();
    const amt = Number(roomObj[`${p}FlatAmount`] ?? roomObj[`${p}_flat_amount`]);
    return mode === 'flat' && Number.isFinite(amt) && amt > 0;
  };
  const metered = { water: !isFlat('water'), elec: !isFlat('elec') };
  const realRoomId = roomId && roomId !== '-' ? String(roomId) : '';
  const showMeterSection = !!(tenantDbId && realRoomId && (metered.water || metered.elec));
  React.useEffect(() => {
    if (!showMeterSection || !apiCall) return;
    let cancelled = false;
    ['water', 'elec'].forEach((mt) => {
      if (!metered[mt]) return;
      apiCall(`/api/meters/${encodeURIComponent(realRoomId)}/readings?type=${mt}`)
        .then((d) => {
          if (cancelled) return;
          const latest = d && Array.isArray(d.readings) && d.readings[0]
            ? Number(d.readings[0].reading) : null;
          if (Number.isFinite(latest)) {
            setLastReadings((prev) => ({ ...prev, [mt]: latest }));
          }
        })
        .catch(() => {
          // meterIot feature off / legacy deploy — fall back to room blob hint.
          if (cancelled) return;
          const blobVal = Number(roomObj[`${mt}CurrentReading`]);
          if (Number.isFinite(blobVal)) {
            setLastReadings((prev) => ({ ...prev, [mt]: blobVal }));
          }
        });
    });
    return () => { cancelled = true; };
  }, [showMeterSection, realRoomId]);
  const outstandingTotal = Array.isArray(outstanding)
    ? Math.round(outstanding.reduce((s, b) => s + (Number(b.total) || 0), 0) * 100) / 100
    : 0;
  const util = (config && config.utilities) || {};
  const rateFor = (p) => {
    const o = Number(roomObj[`${p}RateOverride`] ?? roomObj[`${p}_rate_override`]);
    if (Number.isFinite(o) && o > 0) return o;
    const g = Number(p === 'water' ? (util.waterRate ?? 18) : (util.elecRate ?? 8));
    return Number.isFinite(g) && g > 0 ? g : 0;
  };
  const meterPreview = (p) => {
    const raw = p === 'water' ? waterEnd : elecEnd;
    if (raw === '') return null;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) return { invalid: true, msg: 'ต้องเป็นตัวเลข 0 ขึ้นไป' };
    const last = lastReadings[p];
    if (last != null && v < last) {
      return { invalid: true, msg: `น้อยกว่าเลขล่าสุด (${last}) — มิเตอร์ไม่ควรถอยหลัง` };
    }
    const units = last != null ? Math.round((v - last) * 100) / 100 : 0;
    const amount = Math.round(units * rateFor(p) * 100) / 100;
    return { invalid: false, units, amount, rate: rateFor(p) };
  };
  const waterPreview = meterPreview('water');
  const elecPreview = meterPreview('elec');
  const meterInvalid = !!((waterPreview && waterPreview.invalid) || (elecPreview && elecPreview.invalid));
  // Closing-bill estimate (client-side, "โดยประมาณ") feeding the suggested
  // refund: prorated rent for days lived this month + entered meter charges.
  // The server computes the authoritative bill — this is decision support.
  const today = new Date();
  const dim = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const frac = Math.min(1, Math.max(0, today.getDate() / dim));
  const discountPct = contract ? Number(contract.discount_pct) || 0 : 0;
  const estRent = contract
    ? Math.round((Number(monthlyRent) || 0) * frac * (1 - discountPct / 100) * 100) / 100
    : 0;
  const estMeter = (waterPreview && !waterPreview.invalid ? waterPreview.amount : 0)
    + (elecPreview && !elecPreview.invalid ? elecPreview.amount : 0);
  const estClosing = Math.round((estRent + estMeter) * 100) / 100;
  const suggestedRefund = (contract && Array.isArray(outstanding))
    ? Math.max(0, Math.round(((Number(deposit) || 0) - outstandingTotal - estClosing) * 100) / 100)
    : null;
  const depositNum = depositReturn === '' ? null : Number(depositReturn);
  const depositInvalid = depositReturn !== ''
    && (!Number.isFinite(depositNum) || depositNum < 0 || depositNum > Number(deposit || 0));
  const confirm = () => onConfirm({
    finalDepositReturn: depositReturn === '' ? null : depositNum,
    waterEndReading: showMeterSection && metered.water && waterEnd !== '' && !(waterPreview && waterPreview.invalid)
      ? Number(waterEnd) : null,
    elecEndReading: showMeterSection && metered.elec && elecEnd !== '' && !(elecPreview && elecPreview.invalid)
      ? Number(elecEnd) : null,
  });
  return (
    <Modal
      open={true}
      onClose={busy ? undefined : onClose}
      width={520}
      title={contract ? `ยกเลิกสัญญา ${contract.contract_no}` : `เช็คเอาท์ ${tenant && tenant.name ? tenant.name : 'ผู้เช่า'}`}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={busy}>ปิด</Btn>
          <Btn variant="danger" onClick={confirm} disabled={busy || reason.trim().length < 5 || depositInvalid || meterInvalid}>
            {busy ? (contract ? 'กำลังยกเลิก…' : 'กำลังเช็คเอาท์…') : (contract ? 'ยืนยันยกเลิก' : 'ยืนยันเช็คเอาท์')}
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
          {contract ? (
            <li>ตั้งสถานะสัญญาเป็น "สิ้นสุดแล้ว"</li>
          ) : (
            <li>เช็คเอาท์ผู้เช่าที่อยู่ในห้องนี้ แม้ยังไม่พบสัญญา active ในแท็บ</li>
          )}
          <li>เปลี่ยนสถานะผู้เช่า <b>{tenant && tenant.name}</b> เป็น <b>moved_out</b></li>
          <li>ปล่อยห้อง <b>{roomId}</b> เป็น <b>vacant</b></li>
          <li>หยุดการออกบิลอัตโนมัติ (รอบเดือนถัดไป)</li>
        </ul>
        บิลที่ค้างชำระอยู่แล้วยังคงค้างไว้ ต้องเก็บ/ปิดยอดเอง
      </div>

      <div style={{
        padding: 10, background: '#faf6ee', borderRadius: 8, fontSize: 12,
        color: C.muted, marginBottom: 12, lineHeight: 1.5,
      }}>
        ห้อง: <b style={{ color: C.ink }}>{roomId}</b> ·
        ค่าเช่า: <b style={{ color: C.ink }}>{fmtCurrency(monthlyRent)}/เดือน</b> ·
        มัดจำ: <b style={{ color: C.ink }}>{fmtCurrency(deposit)}</b>
      </div>

      {outstanding === null ? (
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>กำลังตรวจสอบบิลค้างชำระ…</div>
      ) : outstanding === undefined ? (
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>
          ⚠️ ตรวจสอบบิลค้างชำระไม่สำเร็จ — ตรวจที่หน้า /admin#billing ก่อนยืนยัน
        </div>
      ) : outstanding.length > 0 ? (
        <div style={{
          padding: 10, background: '#fdecea', border: '1px solid #e57373',
          borderRadius: 8, fontSize: 12, marginBottom: 12, lineHeight: 1.6,
        }}>
          <div style={{ fontWeight: 600, color: C.danger || '#c0392b', marginBottom: 4 }}>
            💸 มีบิลค้างชำระ {outstanding.length} ใบ รวม {fmtCurrency(outstandingTotal)}
          </div>
          {outstanding.slice(0, 5).map((b) => (
            <div key={b.id} style={{ color: '#7a3b32' }}>
              • {b.bill_no} ({b.period}) — {fmtCurrency(b.total)}
            </div>
          ))}
          {outstanding.length > 5 ? (
            <div style={{ color: '#7a3b32' }}>… และอีก {outstanding.length - 5} ใบ</div>
          ) : null}
          <div style={{ color: '#7a3b32', marginTop: 4 }}>
            หนี้จะติดตามผู้เช่า (ไม่หายไปกับห้อง) — เก็บเงิน/หักมัดจำให้เรียบร้อยก่อนคืนส่วนที่เหลือ
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: C.success || '#2e7d32', marginBottom: 12 }}>
          ✓ ไม่มีบิลค้างชำระ
        </div>
      )}

      {showMeterSection ? (
        <div style={{
          padding: 10, background: '#eef6f0', border: '1px solid #bcd9c2',
          borderRadius: 8, marginBottom: 12,
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#1f5b2e', marginBottom: 6 }}>
            ⚡ จดเลขมิเตอร์ครั้งสุดท้าย — ระบบจะคิดค่าน้ำ/ไฟงวดสุดท้ายลงบิลปิดยอดให้
          </div>
          {['water', 'elec'].map((mt) => {
            if (!metered[mt]) return null;
            const label = mt === 'water' ? 'น้ำ' : 'ไฟ';
            const val = mt === 'water' ? waterEnd : elecEnd;
            const setVal = mt === 'water' ? setWaterEnd : setElecEnd;
            const preview = mt === 'water' ? waterPreview : elecPreview;
            const last = lastReadings[mt];
            return (
              <div key={mt} style={{ marginBottom: 8 }}>
                <label style={{ display: 'block', fontSize: 11, color: '#406a4c', marginBottom: 2 }}>
                  มิเตอร์{label}{last != null ? ` (เลขล่าสุด ${last})` : ''}
                </label>
                <input type="number" min="0" step="0.01" value={val}
                  placeholder={last != null ? `≥ ${last}` : 'เลขที่อ่านได้หน้าห้อง'}
                  onChange={(e) => setVal(e.target.value)}
                  style={{
                    width: '100%', padding: '7px 10px', borderRadius: 6, fontSize: 13,
                    boxSizing: 'border-box', fontFamily: 'inherit',
                    border: `1px solid ${preview && preview.invalid ? '#e57373' : '#bcd9c2'}`,
                  }} />
                {preview ? (
                  <div style={{ fontSize: 11, marginTop: 2, color: preview.invalid ? '#c0392b' : '#1f5b2e' }}>
                    {preview.invalid
                      ? preview.msg
                      : `ใช้ไป ${preview.units} หน่วย × ฿${preview.rate} = ฿${Number(preview.amount).toLocaleString('th-TH')}`}
                  </div>
                ) : (
                  <div style={{ fontSize: 11, marginTop: 2, color: '#a3623b' }}>
                    ⚠️ ถ้าเว้นว่าง ระบบจะไม่เรียกเก็บค่า{label}งวดสุดท้าย
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : null}

      {tenantDbId && contract ? (
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, marginBottom: 4, color: '#5b4f40', fontWeight: 500 }}>
            คืนเงินมัดจำให้ผู้เช่า (บาท)
          </label>
          {suggestedRefund != null ? (
            <div style={{
              display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
              fontSize: 11, color: C.muted, margin: '0 0 6px', lineHeight: 1.5,
            }}>
              <span>
                ยอดแนะนำ: มัดจำ {fmtCurrency(deposit)} − ค้างชำระ {fmtCurrency(outstandingTotal)}
                {estClosing > 0 ? ` − บิลปิดยอด (ประมาณ) ${fmtCurrency(estClosing)}` : ''} ={' '}
                <b style={{ color: C.ink }}>{fmtCurrency(suggestedRefund)}</b>
              </span>
              <Btn variant="soft" size="sm" disabled={busy}
                onClick={() => setDepositReturn(String(suggestedRefund))}>
                ใช้ยอดแนะนำ
              </Btn>
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="number" min="0" max={Number(deposit) || 0} step="0.01"
              placeholder="เว้นว่าง = ยังไม่บันทึกการคืน"
              value={depositReturn}
              onChange={(e) => setDepositReturn(e.target.value)}
              style={{
                flex: 1, padding: '8px 10px', border: `1px solid ${depositInvalid ? '#e57373' : '#ece4d4'}`,
                borderRadius: 6, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box',
              }} />
            <Btn variant="secondary" size="sm" disabled={busy}
              onClick={() => setDepositReturn(String(Number(deposit) || 0))}>
              คืนเต็ม {fmtCurrency(deposit)}
            </Btn>
          </div>
          <div style={{ fontSize: 11, color: depositInvalid ? (C.danger || '#c0392b') : C.muted, marginTop: 4 }}>
            {depositInvalid
              ? `ต้องเป็นตัวเลข 0 ถึง ${fmtCurrency(deposit)} (มัดจำตามสัญญา)`
              : 'บันทึกลงสัญญาเพื่อใช้ในรายงาน — ระบบบันทึกได้เฉพาะตอนเช็คเอาท์เท่านั้น ถ้าเว้นว่างจะไม่มีบันทึกการคืนมัดจำ'}
          </div>
        </div>
      ) : tenantDbId ? (
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>
          ผู้เช่ารายนี้ไม่มีสัญญา active ในระบบ — ไม่มีที่บันทึกการคืนมัดจำ (จัดการนอกระบบ)
        </div>
      ) : null}

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

function tenantContractMissingLabel(code) {
  return ({
    address: 'ที่อยู่ผู้เช่า',
    emergencyContactName: 'ชื่อผู้ติดต่อฉุกเฉิน',
    emergencyContactPhone: 'เบอร์ผู้ติดต่อฉุกเฉิน',
    emergencyContact: 'ผู้ติดต่อฉุกเฉิน',
    citizenId: 'เลขบัตรประชาชน 13 หลัก',
    citizenIdFront: 'รูปบัตรประชาชนด้านหน้า',
    citizenIdBack: 'รูปบัตรประชาชนด้านหลัง',
  }[code] || code);
}

// Client mirror of services/thaiId.validateChecksum (official mod-11 spec) —
// catches typo'd citizen IDs BEFORE any API round-trip, so the backfill modal
// never half-saves (profile PUT ok, identity POST rejected) over a typo.
function thaiCitizenIdChecksumOk(digits13) {
  if (!/^\d{13}$/.test(digits13)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(digits13[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(digits13[12]);
}

function contractIdentityGap(contract) {
  const warnings = Array.isArray(contract && contract.warnings) ? contract.warnings : [];
  const warning = warnings.find((w) => w && w.code === 'CONTRACT_IDENTITY_INCOMPLETE');
  if (!warning) return null;
  const labels = Array.isArray(warning.missing)
    ? warning.missing.map(tenantContractMissingLabel).filter(Boolean)
    : [];
  return {
    warning,
    labels: labels.length ? labels : ['ข้อมูลผู้เช่า/เอกสารประกอบสัญญา'],
  };
}

function LockedContractIdentityGapCard({ contract, gap, C, onBackfill, onOpenContracts, onOpenPdf }) {
  const { Card, Btn } = window;
  return (
    <Card style={{ padding: 14, background: C.dangerSoft || '#fff1f0', border: `1px solid ${C.danger || '#c0392b'}` }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.danger || '#9f2d20', marginBottom: 6 }}>
        สัญญา lock แล้ว แต่ข้อมูลผู้เช่า/เอกสารยังไม่ครบ
      </div>
      <div style={{ fontSize: 12.5, color: C.ink2, lineHeight: 1.6, marginBottom: 10 }}>
        ขาด: <b>{gap.labels.join(', ')}</b><br/>
        ระบบไม่เปิดปุ่มสร้างลิงก์ให้ผู้เช่ากรอกบนสัญญานี้ เพราะลิงก์สัญญาใช้เฉพาะก่อน approve/lock เท่านั้น
        ถ้าฝืนออกลิงก์ ผู้เช่าจะกรอกได้แต่แอดมินจะอนุมัติซ้ำไม่ได้ จึงป้องกันไว้ตั้งแต่หน้า admin
      </div>
      <div style={{
        padding: 10,
        borderRadius: 8,
        background: '#fff',
        border: `1px solid ${C.border}`,
        fontSize: 12,
        color: C.ink2,
        lineHeight: 1.5,
        marginBottom: 10,
      }}>
        ทางแก้ที่ปลอดภัย: กดปุ่ม "เติมข้อมูล/อัปโหลดเอกสาร" ด้านล่างเพื่อบันทึกข้อมูลย้อนหลังให้ผู้เช่ารายนี้ได้ทันที
        (ไม่ต้องง้อลิงก์) หรือสร้าง/ต่อสัญญาฉบับใหม่แล้วส่งลิงก์ก่อน lock
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Btn variant="primary" size="sm" icon="✎" onClick={onBackfill}>เติมข้อมูล/อัปโหลดเอกสาร</Btn>
        <Btn variant="secondary" size="sm" onClick={onOpenContracts}>เปิดในหน้าสัญญา</Btn>
        <Btn variant="ghost" size="sm" onClick={onOpenPdf}>ดู PDF ปัจจุบัน</Btn>
        <Btn variant="ghost" size="sm" disabled={true}
          title="ส่งลิงก์ไม่ได้ เพราะสัญญานี้ถูก lock แล้ว">
          🔒 ส่งลิงก์ไม่ได้
        </Btn>
      </div>
    </Card>
  );
}

// === TenantIdentityBackfillModal =========================================
// The actionable way out of CONTRACT_IDENTITY_INCOMPLETE on a locked
// contract. The tenant-fill link is intentionally blocked after approve/lock,
// so this modal writes the tenant profile directly from the admin side:
//   - address + emergency contact + citizen ID  → PUT /api/tenants/:id
//     (optimistic-locked via `version` so a concurrent edit 409s instead of
//     silently overwriting)
//   - citizen-ID card photos (front/back)        → POST /api/tenants/:id/identity
//     (feature-gated `photoUpload`; checksum + cross-tenant dedup enforced
//     server-side)
// Contract warnings are recomputed from the tenants table at read time, so a
// successful save + contract reload clears the "ต้องตรวจ" state with no extra
// step.
function TenantIdentityBackfillModal({ tenantDbId, tenantName, missing, onClose, onSaved, setToast }) {
  const C = window.ADMIN_C;
  const { Modal, Btn, Input, Textarea } = window;
  const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
  const [row, setRow] = React.useState(null);      // GET /api/tenants/:id payload
  const [loadErr, setLoadErr] = React.useState('');
  const [form, setForm] = React.useState({
    address: '', emergencyContactName: '', emergencyContactPhone: '', citizenId: '',
  });
  const [front, setFront] = React.useState(null);  // { dataUrl, name }
  const [back, setBack] = React.useState(null);
  const [error, setError] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setRow(null);
    setLoadErr('');
    (async () => {
      try {
        const d = await apiCall(`/api/tenants/${tenantDbId}`);
        if (cancelled) return;
        const tRow = (d && d.tenant) || {};
        setRow(tRow);
        setForm({
          address: tRow.address || '',
          emergencyContactName: tRow.emergency_contact_name || '',
          emergencyContactPhone: tRow.emergency_contact_phone || '',
          citizenId: '',
        });
      } catch (err) {
        if (!cancelled) setLoadErr((err && err.message) || 'โหลดข้อมูลผู้เช่าไม่สำเร็จ');
      }
    })();
    return () => { cancelled = true; };
  }, [tenantDbId]);

  const citizenIdNorm = String(form.citizenId || '').replace(/[\s-]/g, '');
  // Live citizen-ID validation with a SPECIFIC reason — the save button stays
  // disabled (and says why) instead of letting the server bounce the request.
  const citizenProblem = !citizenIdNorm
    ? ''
    : !/^\d{13}$/.test(citizenIdNorm)
      ? `เลขบัตรต้องเป็นตัวเลข 13 หลัก (ตอนนี้กรอก ${citizenIdNorm.length} ตัว)`
      : !thaiCitizenIdChecksumOk(citizenIdNorm)
        ? 'เลขบัตรไม่ผ่านการตรวจ check digit (mod-11) — มักเกิดจากพิมพ์สลับ/ตกหลัก ตรวจทีละหลักอีกครั้ง'
        : '';
  // Picking the SAME file for both card sides is almost always a mis-click —
  // warn loudly but don't block (a single combined photo is rare-but-legal).
  const sameCardImage = !!(front && back && front.dataUrl === back.dataUrl);
  // Live checklist — "what's still missing if I save right now". Mirrors the
  // server's buildContractWarnings() field list so admin sees the same six
  // items the warning counts.
  const itemDone = {
    address: !!String(form.address || '').trim(),
    emergencyContactName: !!String(form.emergencyContactName || '').trim(),
    emergencyContactPhone: !!String(form.emergencyContactPhone || '').trim(),
    citizenId: citizenIdNorm ? !citizenProblem : !!(row && row.citizen_id_tail),
    citizenIdFront: !!(row && row.citizen_id_image_front_id) || !!front,
    citizenIdBack: !!(row && row.citizen_id_image_back_id) || !!back,
  };
  const checklist = ['address', 'emergencyContactName', 'emergencyContactPhone',
    'citizenId', 'citizenIdFront', 'citizenIdBack'];

  const pickImage = (side) => (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type || '')) {
      setError('ไฟล์รูปบัตรต้องเป็นรูปภาพ (JPG/PNG) — ไฟล์ที่เลือกไม่ใช่รูป');
      return;
    }
    if (file.size > 1_500_000) {
      setError('รูปใหญ่เกิน 1.5MB — ย่อ/บีบอัดรูปก่อน แล้วเลือกใหม่อีกครั้ง');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const val = { dataUrl: String(reader.result || ''), name: file.name };
      if (side === 'front') setFront(val); else setBack(val);
      setError('');
    };
    reader.onerror = () => setError('อ่านไฟล์รูปไม่สำเร็จ — ลองเลือกรูปใหม่อีกครั้ง');
    reader.readAsDataURL(file);
  };

  // Server codes → actionable Thai. Raw err.message is the fallback only.
  const friendlyError = (err) => ({
    INVALID_CITIZEN_ID: 'เลขบัตรประชาชนต้องเป็นตัวเลข 13 หลัก',
    INVALID_CHECKSUM: 'เลขบัตรไม่ผ่านการตรวจ check digit (mod-11) — ตรวจการพิมพ์ทีละหลักอีกครั้ง',
    CITIZEN_ID_DUPLICATE: 'เลขบัตรนี้ผูกกับผู้เช่ารายอื่นในระบบแล้ว — ตรวจรายชื่อผู้เช่าก่อนว่าใช่คนเดียวกันหรือไม่',
    INVALID_EMERGENCY_PHONE: 'เบอร์ผู้ติดต่อฉุกเฉินไม่ถูกต้อง — ต้องเป็นตัวเลข 8-20 หลัก',
    FEATURE_DISABLED: 'ฟีเจอร์อัปโหลดรูป (photoUpload) ปิดอยู่ — เปิดที่เมนู Features แล้วกลับมาอัปโหลดรูปบัตรอีกครั้ง (ข้อมูลตัวหนังสือบันทึกได้ตามปกติ)',
    VERSION_CONFLICT: 'ข้อมูลผู้เช่าเพิ่งถูกแก้จากหน้าจออื่น — ปิดหน้าต่างนี้แล้วเปิดใหม่เพื่อโหลดข้อมูลล่าสุดก่อนบันทึกซ้ำ',
    NOTHING_TO_SAVE: 'ยังไม่มีข้อมูลใหม่ให้บันทึก — กรอกข้อมูลหรือเลือกรูปก่อน',
  }[err && err.code] || (err && err.message) || 'บันทึกไม่สำเร็จ — ลองใหม่อีกครั้ง');

  const submit = async () => {
    if (saving || !row) return;
    setError('');
    if (citizenProblem) {
      setError(citizenProblem);
      return;
    }
    const trimmed = (v) => String(v || '').trim();
    const profilePatch = {};
    if (trimmed(form.address) !== trimmed(row.address)) profilePatch.address = trimmed(form.address);
    if (trimmed(form.emergencyContactName) !== trimmed(row.emergency_contact_name)) {
      profilePatch.emergencyContactName = trimmed(form.emergencyContactName);
    }
    if (trimmed(form.emergencyContactPhone) !== trimmed(row.emergency_contact_phone)) {
      profilePatch.emergencyContactPhone = trimmed(form.emergencyContactPhone);
    }
    const hasIdentity = !!(citizenIdNorm || front || back);
    if (!Object.keys(profilePatch).length && !hasIdentity) {
      setError('ยังไม่ได้แก้ไขอะไร — กรอกข้อมูลที่ขาดหรือเลือกรูปบัตรก่อนบันทึก');
      return;
    }
    setSaving(true);
    let savedProfile = false;
    try {
      if (Object.keys(profilePatch).length) {
        const saved = await apiCall(`/api/tenants/${tenantDbId}`, {
          method: 'PUT',
          body: JSON.stringify({ ...profilePatch, version: row.updated_at }),
        });
        savedProfile = true;
        // Sync local row to what just landed (values + new version). Without
        // this, a later identity-step failure leaves the modal holding a
        // stale version and the retry dies on VERSION_CONFLICT against its
        // own previous save.
        setRow((r) => ({
          ...r,
          address: profilePatch.address !== undefined ? profilePatch.address : r.address,
          emergency_contact_name: profilePatch.emergencyContactName !== undefined
            ? profilePatch.emergencyContactName : r.emergency_contact_name,
          emergency_contact_phone: profilePatch.emergencyContactPhone !== undefined
            ? profilePatch.emergencyContactPhone : r.emergency_contact_phone,
          updated_at: (saved && saved.updated_at) || r.updated_at,
        }));
      }
      if (hasIdentity) {
        await apiCall(`/api/tenants/${tenantDbId}/identity`, {
          method: 'POST',
          body: JSON.stringify({
            ...(citizenIdNorm ? { citizenId: citizenIdNorm } : {}),
            ...(front ? { frontDataUrl: front.dataUrl } : {}),
            ...(back ? { backDataUrl: back.dataUrl } : {}),
          }),
        });
      }
      setToast && setToast({
        kind: 'success',
        message: {
          title: 'เติมข้อมูลย้อนหลังให้ผู้เช่าแล้ว',
          description: 'ระบบตรวจความครบของสัญญาใหม่อัตโนมัติ — เมื่อครบทุกรายการ ป้าย "ต้องตรวจ" และการ์ดแดงจะหายไปเอง',
        },
      });
      onSaved && onSaved();
    } catch (err) {
      if (err && err.code === 'VERSION_CONFLICT') {
        // Genuine concurrent edit — recover automatically: pull the fresh
        // row (new version + current values) and let admin just hit save
        // again, instead of telling them to close/reopen the modal.
        try {
          const d2 = await apiCall(`/api/tenants/${tenantDbId}`);
          if (d2 && d2.tenant) setRow(d2.tenant);
          setError('ข้อมูลผู้เช่าถูกแก้จากที่อื่นพร้อมกัน — ระบบโหลดเวอร์ชันล่าสุดให้แล้ว ตรวจค่าที่กรอกอีกครั้งแล้วกด "บันทึกข้อมูลย้อนหลัง" ซ้ำได้เลย');
        } catch {
          setError(friendlyError(err));
        }
        setSaving(false);
        return;
      }
      // Partial-success is called out explicitly: the PUT may have landed
      // before the identity POST failed, and re-submitting the same text is
      // harmless but confusing if the admin doesn't know what stuck.
      const prefix = savedProfile
        ? 'บันทึกที่อยู่/ผู้ติดต่อฉุกเฉินแล้ว แต่ส่วนเลขบัตร/รูปบัตรยังไม่สำเร็จ: '
        : '';
      setError(prefix + friendlyError(err));
      setSaving(false);
    }
  };

  const fileRow = (side, picked, existingId) => (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      padding: '8px 10px', border: `1px solid ${C.border}`, borderRadius: 8,
    }}>
      <div style={{ fontSize: 12.5, color: C.ink, minWidth: 120, fontWeight: 500 }}>
        {side === 'front' ? 'รูปบัตรด้านหน้า' : 'รูปบัตรด้านหลัง'}
      </div>
      <div style={{ fontSize: 11.5, color: picked || existingId ? (C.success || '#2f8f5b') : (C.danger || '#c0392b'), flex: 1, minWidth: 120 }}>
        {picked ? `เลือกแล้ว: ${picked.name}` : existingId ? 'มีรูปในระบบแล้ว (เลือกใหม่ = แทนที่)' : 'ยังไม่มีรูปในระบบ'}
      </div>
      <label style={{
        fontSize: 12, padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
        border: `1px solid ${C.border}`, background: C.surface || '#fff', color: C.ink,
      }}>
        เลือกรูป…
        <input type="file" accept="image/*" style={{ display: 'none' }}
          disabled={saving} onChange={pickImage(side)} />
      </label>
    </div>
  );

  return (
    <Modal
      open={true}
      onClose={saving ? undefined : onClose}
      title={`เติมข้อมูล/อัปโหลดเอกสารย้อนหลัง — ${tenantName || 'ผู้เช่า'}`}
      width={620}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={saving}>ปิด</Btn>
          <Btn variant="primary" onClick={submit}
            disabled={saving || !row || !!citizenProblem}
            title={!row
              ? (loadErr ? 'บันทึกไม่ได้: โหลดข้อมูลผู้เช่าไม่สำเร็จ — ปิดแล้วเปิดใหม่' : 'กำลังโหลดข้อมูลผู้เช่า…')
              : citizenProblem
                ? `บันทึกไม่ได้: ${citizenProblem}`
                : undefined}>
            {saving ? 'กำลังบันทึก…' : 'บันทึกข้อมูลย้อนหลัง'}
          </Btn>
        </>
      }
    >
      {loadErr ? (
        <div style={{
          padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 12.5, lineHeight: 1.5,
          background: C.dangerSoft || '#fef2f2', border: `1px solid ${C.danger || '#c0392b'}`, color: C.danger || '#9f2d20',
        }}>
          โหลดข้อมูลผู้เช่าไม่สำเร็จ: {loadErr} — ปิดแล้วลองเปิดใหม่อีกครั้ง
        </div>
      ) : null}
      <div style={{
        padding: 10, borderRadius: 8, marginBottom: 12,
        background: C.surfaceAlt || '#f7faf8', border: `1px solid ${C.border}`,
        fontSize: 12, color: C.ink2, lineHeight: 1.55,
      }}>
        สัญญานี้ lock แล้ว ผู้เช่าจึงกรอกผ่านลิงก์ไม่ได้อีก — แอดมินบันทึกแทนได้ที่นี่
        ข้อมูลจะเข้าโปรไฟล์ผู้เช่าโดยตรง และระบบจะนับความครบของสัญญาใหม่ให้ทันทีหลังบันทึก
      </div>
      <div style={{ display: 'grid', gap: 4, marginBottom: 12 }}>
        {checklist.map((key) => (
          <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
            <span style={{ color: itemDone[key] ? (C.success || '#2f8f5b') : (C.danger || '#c0392b'), width: 16, textAlign: 'center' }}>
              {itemDone[key] ? '✓' : '✗'}
            </span>
            <span style={{ color: itemDone[key] ? C.muted : C.ink }}>
              {tenantContractMissingLabel(key)}
              {itemDone[key] ? '' : ' — ยังขาด'}
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Textarea label="ที่อยู่ผู้เช่า (ตามบัตร/ที่ติดต่อได้)" rows={2}
          value={form.address}
          onChange={(v) => setForm((p) => ({ ...p, address: v }))}
          placeholder="บ้านเลขที่ ถนน ตำบล อำเภอ จังหวัด รหัสไปรษณีย์" />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Input label="ชื่อผู้ติดต่อฉุกเฉิน"
            value={form.emergencyContactName}
            onChange={(v) => setForm((p) => ({ ...p, emergencyContactName: v }))}
            placeholder="เช่น คุณแม่ สมหญิง" />
          <Input label="เบอร์ผู้ติดต่อฉุกเฉิน"
            value={form.emergencyContactPhone}
            onChange={(v) => setForm((p) => ({ ...p, emergencyContactPhone: v }))}
            placeholder="0812345678" />
        </div>
        <div>
          <Input label={row && row.citizen_id_tail
              ? `เลขบัตรประชาชน (ในระบบมีลงท้าย ${row.citizen_id_tail} แล้ว — กรอกเฉพาะถ้าต้องการแก้)`
              : 'เลขบัตรประชาชน 13 หลัก'}
            value={form.citizenId}
            onChange={(v) => setForm((p) => ({ ...p, citizenId: v }))}
            placeholder="13 หลัก"
            hint={citizenProblem ? undefined : 'เก็บแบบเข้ารหัสในฐานข้อมูล และตรวจ check digit อัตโนมัติ'} />
          {citizenProblem ? (
            <div style={{ fontSize: 11.5, color: C.danger || '#c0392b', marginTop: 4, lineHeight: 1.5 }}>
              ✗ {citizenProblem}
            </div>
          ) : null}
        </div>
        {fileRow('front', front, row && row.citizen_id_image_front_id)}
        {fileRow('back', back, row && row.citizen_id_image_back_id)}
        {sameCardImage ? (
          <div style={{
            fontSize: 11.5, color: C.warning || '#b45309', lineHeight: 1.5,
            padding: '6px 10px', borderRadius: 6,
            background: C.warningSoft || '#fff7ed', border: `1px solid ${C.warning || '#b45309'}55`,
          }}>
            ⚠️ รูปด้านหน้าและด้านหลังเป็นไฟล์เดียวกัน — มักเกิดจากเลือกผิด ตรวจให้แน่ใจก่อนบันทึก
            (ถ้าถ่ายสองด้านมาในรูปเดียวตั้งใจแล้ว บันทึกต่อได้)
          </div>
        ) : null}
      </div>
      {error ? (
        <div style={{
          marginTop: 12, padding: 10, borderRadius: 8, fontSize: 12.5, lineHeight: 1.55,
          background: C.dangerSoft || '#fef2f2', border: `1px solid ${C.danger || '#c0392b'}`, color: C.danger || '#9f2d20',
        }}>
          {error}
        </div>
      ) : null}
    </Modal>
  );
}

// Pre-flight summary shown before admin sends the contract link. Mirrors
// every field the system will lock into the contract — room (type/floor/
// size/amenities), rent (auto-calculated deposit), tenant (name/phone/
// email). Everything sourced from the tenant's room context (rooms blob),
// so admin sees exactly what the tenant will receive without re-typing.
function ContractPreFlightSummary({ t, rentInfo, C, fmtCurrency }) {
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES || {};
  const r = t.room || {};
  const typeInfo = ADMIN_ROOM_TYPES[t.type] || {};
  const displayRoomId = t.roomId || t.currentRoomId || '';
  const rent = Number(rentInfo && rentInfo.rent) || 0;
  const depositValue = Number(rentInfo && rentInfo.deposit);
  const deposit = Number.isFinite(depositValue) && depositValue >= 0 ? depositValue : (rent * 2);
  const preflightIssues = [
    !displayRoomId ? { level: 'danger', label: 'ยังไม่ผูกห้อง', fix: 'เลือกห้องให้ผู้เช่าก่อนสร้างสัญญา' } : null,
    !(Number.isFinite(rent) && rent > 0) ? { level: 'danger', label: 'ยังไม่มีค่าเช่า', fix: 'ตั้งค่าเช่าที่เมนูตั้งราคา/ห้องพักก่อนส่งลิงก์' } : null,
    !String(t.name || '').trim() ? { level: 'danger', label: 'ยังไม่มีชื่อผู้เช่า', fix: 'กรอกชื่อผู้เช่าให้ครบก่อนออกสัญญา' } : null,
    !String(t.phone || '').trim() ? { level: 'warning', label: 'ยังไม่มีเบอร์ผู้เช่า', fix: 'เพิ่มเบอร์โทรเพื่อส่งลิงก์/แจ้งเตือนอัตโนมัติและติดต่อกลับ' } : null,
    !String(t.email || '').trim() ? { level: 'info', label: 'ยังไม่มีอีเมลผู้เช่า', fix: 'ถ้ามีอีเมลให้เพิ่มไว้เป็นช่องทางสำรองในการส่งลิงก์' } : null,
  ].filter(Boolean);
  const blockers = preflightIssues.filter((it) => it.level === 'danger');
  const preflightReady = blockers.length === 0;
  const preflightWarningOnly = preflightReady && preflightIssues.length > 0;

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
      <div style={{
        margin: '10px 0 6px',
        padding: 10,
        borderRadius: 8,
        border: `1px solid ${preflightReady ? (preflightWarningOnly ? '#f1b32d' : (C.success || '#2f8f5b')) : (C.danger || '#c0392b')}33`,
        background: preflightReady
          ? (preflightWarningOnly ? (C.warningSoft || '#fff7ed') : (C.successSoft || '#e6f4ec'))
          : (C.dangerSoft || '#fff1f0'),
        color: C.ink2,
        fontSize: 12,
        lineHeight: 1.5,
      }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', gap: 8,
          fontWeight: 700, color: C.ink, marginBottom: preflightIssues.length ? 4 : 0,
        }}>
          <span>เช็คก่อนสร้าง/ส่งสัญญา</span>
          <span style={{ color: preflightReady ? (preflightWarningOnly ? (C.warningInk || '#92400e') : (C.success || '#2f8f5b')) : (C.danger || '#c0392b') }}>
            {preflightReady ? (preflightWarningOnly ? 'สร้างได้ แต่ควรเติมข้อมูล' : 'พร้อมสร้างสัญญา') : `ยังไม่พร้อม ${blockers.length} จุด`}
          </span>
        </div>
        {preflightIssues.length ? (
          <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
            {preflightIssues.map((it) => (
              <li key={it.label}>
                <b>{it.label}</b>: {it.fix}
              </li>
            ))}
          </ul>
        ) : (
          <div style={{ color: C.muted }}>ข้อมูลตั้งต้นครบสำหรับสร้างสัญญา ส่งลิงก์ และสร้างบิลแรกหลังอนุมัติ</div>
        )}
      </div>
      <Row icon="🏠" label="ห้อง">
        <b>{displayRoomId || '—'}</b>
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
        <span>
          <b style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 14 }}>
            {fmtCurrency(rent)}
          </b>
          {rentInfo && rentInfo.sourceLabel ? (
            <span style={{ color: C.muted, marginLeft: 6, fontSize: 11, fontWeight: 400 }}>
              ({rentInfo.sourceLabel})
            </span>
          ) : null}
        </span>
      </Row>
      <Row icon="🏦" label="เงินมัดจำ">
        <span>
          <b style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {fmtCurrency(deposit)}
          </b>
          <span style={{ color: C.muted, marginLeft: 6, fontSize: 11, fontWeight: 400 }}>
            ({rentInfo?.depositSourceLabel || 'เมนูตั้งราคา'})
          </span>
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

function ContractFlowChecklist({
  t,
  contract,
  liveLink,
  reviewing,
  contractConflict,
  hasCurrentTenancy,
  rentInfo,
  routeBookingId,
  C,
  fmtCurrency,
}) {
  const invStatus = reviewing ? 'submitted' : (contract && contract.active_invitation_status) || (liveLink ? 'pending' : '');
  const locked = !!(contract && contract.locked_at);
  const hasContract = !!contract || !!liveLink;
  const roomId = (contract && contract.room_id) || t.currentRoomId || t.roomId || '';
  const rent = Number(rentInfo && rentInfo.rent) || Number(contract && contract.monthly_rent) || Number(t.rent) || 0;
  const rentInfoDeposit = Number(rentInfo && rentInfo.deposit);
  const contractDeposit = Number(contract && contract.deposit);
  const deposit = Number.isFinite(rentInfoDeposit) && rentInfoDeposit >= 0
    ? rentInfoDeposit
    : (Number.isFinite(contractDeposit) && contractDeposit >= 0 ? contractDeposit : (rent > 0 ? rent * 2 : 0));
  const reservedBy = t.room && t.room.reservedBy ? String(t.room.reservedBy) : '';
  const bookingId = String(routeBookingId || (t.room && t.room.sourceBookingId) || (reservedBy && !reservedBy.startsWith('contract:') ? reservedBy : '') || '');
  const submitted = invStatus === 'submitted';
  const pending = invStatus === 'pending';
  const identityGap = contractIdentityGap(contract);
  const lockedIdentityGap = locked && !!identityGap;

  const tone = {
    done: { bg: C.successSoft || '#e6f4ec', fg: C.success || '#2f8f5b', border: C.success || '#2f8f5b', label: 'เสร็จแล้ว' },
    warn: { bg: C.warningSoft || '#fff7ed', fg: C.warning || '#b45309', border: C.warning || '#b45309', label: 'ต้องทำต่อ' },
    wait: { bg: C.surfaceAlt || '#f7faf8', fg: C.muted || '#6b7280', border: C.border || '#dfe9e2', label: 'รอขั้นก่อนหน้า' },
    stop: { bg: C.dangerSoft || '#fef2f2', fg: C.danger || '#b91c1c', border: C.danger || '#b91c1c', label: 'ติดปัญหา' },
  };
  const stepTone = (state) => tone[state] || tone.wait;

  const roomReady = !!roomId;
  const priceReady = Number.isFinite(rent) && rent > 0;
  const conflict = !!contractConflict;
  const roomClaimReady = roomReady && (hasCurrentTenancy || hasContract || reservedBy || bookingId);
  const contractReady = hasContract && !conflict;
  const tenantSubmitted = submitted || reviewing;

  const steps = [
    {
      title: 'ข้อมูลตั้งต้น',
      state: roomReady && priceReady ? 'done' : 'stop',
      detail: roomReady && priceReady
        ? `ห้อง ${roomId} · ค่าเช่า ${fmtCurrency(rent)} · มัดจำ ${fmtCurrency(deposit)}`
        : roomReady
          ? 'ห้องนี้ยังไม่มีค่าเช่าที่ใช้งานได้ ให้แก้ที่เมนูตั้งราคา/ห้องพักก่อน'
          : 'ผู้เช่ายังไม่ผูกห้อง ต้องเลือกห้องก่อนสร้างสัญญา',
    },
    {
      title: 'จอง/ล็อกห้อง',
      state: roomClaimReady ? 'done' : (roomReady ? 'warn' : 'wait'),
      detail: bookingId
        ? `ต่อจาก booking ${bookingId} และห้อง ${roomId}`
        : reservedBy
          ? `ห้องถูกล็อกโดย ${reservedBy}`
          : hasCurrentTenancy
            ? `ผู้เช่า active อยู่ห้อง ${roomId} แล้ว`
            : roomReady
              ? 'ยังไม่เห็น booking/reservation ต้นทาง ถ้าเป็นเคส walk-in ให้เช็คอินหรือส่งลิงก์จากห้องนี้ได้'
              : 'รอเลือกห้องก่อน',
    },
    {
      title: 'สร้าง/ส่งสัญญา',
      state: conflict ? 'stop' : (contractReady ? 'done' : 'wait'),
      detail: conflict
        ? 'มีสัญญาเดิมชนกัน ใช้สัญญาเดิมหรือปิดสัญญาเดิมก่อนสร้างใหม่'
        : contract
          ? `มีสัญญา ${contract.contract_no || ''}${locked ? ' และ lock แล้ว' : ' รอขั้นถัดไป'}`
          : liveLink
            ? 'สร้างลิงก์แล้ว ให้ส่ง/คัดลอกให้ผู้เช่ากรอก'
            : 'ยังไม่ได้สร้างสัญญา เลือกเช็คอินทันทีหรือส่งลิงก์ให้ผู้เช่ากรอก',
    },
    {
      title: 'ผู้เช่ากรอก + แอดมินตรวจ',
      state: lockedIdentityGap ? 'stop' : (locked ? 'done' : (tenantSubmitted ? 'warn' : (pending ? 'warn' : 'wait'))),
      detail: lockedIdentityGap
        ? `สัญญา lock แล้ว แต่ยังขาด ${identityGap.labels.join(', ')} — ระบบไม่ออกลิงก์กรอกสัญญาซ้ำเพราะ approve/lock ซ้ำไม่ได้`
        : locked
        ? 'ตรวจและอนุมัติเรียบร้อยแล้ว'
        : submitted || reviewing
          ? 'ผู้เช่าส่งข้อมูลแล้ว ตรวจบัตรหน้า/หลัง ที่อยู่ ผู้ติดต่อฉุกเฉิน และลายเซ็นก่อน lock'
          : pending
            ? 'ลิงก์ active แล้ว รอผู้เช่ากรอก ถ้าหาลิงก์ไม่เจอให้สร้างลิงก์ใหม่จากสัญญาเดิม'
            : 'จะเริ่มหลังสร้างลิงก์หรือเช็คอินด้วยข้อมูลครบ',
    },
    {
      title: 'Lock + บิลแรก',
      state: lockedIdentityGap ? 'warn' : (locked ? 'done' : (hasCurrentTenancy && !contract ? 'warn' : 'wait')),
      detail: lockedIdentityGap
        ? 'สัญญามีผลแล้ว แต่หลักฐานประกอบยังไม่ครบ ตรวจ/เติมข้อมูลย้อนหลังให้ครบก่อนถือว่าเอกสารสมบูรณ์'
        : locked
        ? 'สัญญามีผลแล้ว ตรวจบิลรอบแรก/ส่งบิลให้ผู้เช่า และใช้งาน portal ต่อได้'
        : hasCurrentTenancy && !contract
          ? 'ผู้เช่าอยู่ในห้องแล้วแต่ยังไม่มีสัญญาในระบบ ให้ส่งลิงก์สัญญาหรือเช็คเอาท์ถ้าไม่ใช่เคสนี้'
          : 'รออนุมัติ + lock สัญญาก่อน ระบบจึงถือว่า flow ย้ายเข้าจบ',
    },
  ];

  const nextAction = (() => {
    if (conflict) return 'ใช้ปุ่มในการ์ดสัญญาที่ชนกัน เพื่อเปิดสัญญาเดิม ดู PDF หรือโหลดข้อมูลใหม่';
    if (!roomReady) return 'เลือก/ผูกห้องให้ผู้เช่าก่อน';
    if (!priceReady) return 'แก้ค่าเช่าที่เมนูตั้งราคา/ห้องพักก่อน แล้วกลับมาหน้านี้';
    if (lockedIdentityGap) return `สัญญานี้ lock แล้ว จึงสร้างลิงก์กรอกสัญญาไม่ได้ — ขาด ${identityGap.labels.join(', ')} กดปุ่ม "เติมข้อมูล/อัปโหลดเอกสาร" ในการ์ดแดงด้านล่างเพื่อบันทึกย้อนหลัง หรือทำสัญญาฉบับใหม่ก่อน lock`;
    if (locked) return 'ไปหน้าบิล ตรวจบิลรอบแรก แล้วส่งแจ้งเตือนให้ผู้เช่า';
    if (submitted || reviewing) return 'กดตรวจสอบ + อนุมัติ ตรวจรูปบัตรประชาชนทั้งสองด้านและลายเซ็นก่อน lock';
    if (pending || liveLink) return 'ส่งลิงก์ให้ผู้เช่า รอผู้เช่ากรอก หรือกดสร้างลิงก์ใหม่ถ้าลิงก์เดิมหาย';
    if (hasCurrentTenancy && !contract) return 'ผู้เช่าอยู่ในห้องแล้ว ให้ส่งลิงก์สัญญาเพื่อเก็บเอกสาร หรือเช็คเอาท์ถ้าต้องปิดเคส';
    return 'เลือกเช็คอินทันทีหรือส่งลิงก์ให้ผู้เช่ากรอกเอง';
  })();

  return (
    <div style={{
      padding: 14,
      background: C.bg || '#fff',
      border: `1px solid ${C.border}`,
      borderRadius: 10,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>
        Flow สัญญาและย้ายเข้า
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {steps.map((step, idx) => {
          const s = stepTone(step.state);
          return (
            <div key={step.title} style={{
              display: 'grid',
              gridTemplateColumns: '28px minmax(0, 1fr) auto',
              gap: 10,
              alignItems: 'start',
              padding: '9px 10px',
              border: `1px solid ${s.border}33`,
              borderRadius: 8,
              background: s.bg,
            }}>
              <div style={{
                width: 28, height: 28, borderRadius: 999,
                display: 'grid', placeItems: 'center',
                background: '#fff', color: s.fg, fontWeight: 700,
                border: `1px solid ${s.border}55`,
                fontSize: 12,
              }}>{idx + 1}</div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ink }}>{step.title}</div>
                <div style={{ fontSize: 11.5, color: C.ink2 || C.muted, lineHeight: 1.45, marginTop: 2 }}>
                  {step.detail}
                </div>
              </div>
              <span style={{
                fontSize: 10.5,
                color: s.fg,
                border: `1px solid ${s.border}55`,
                borderRadius: 999,
                padding: '2px 7px',
                background: '#fff',
                whiteSpace: 'nowrap',
              }}>{s.label}</span>
            </div>
          );
        })}
      </div>
      <div style={{
        marginTop: 10,
        padding: '8px 10px',
        borderRadius: 8,
        background: C.surfaceAlt || '#f7faf8',
        color: C.ink2,
        fontSize: 12,
        lineHeight: 1.5,
      }}>
        ขั้นต่อไป: {nextAction}
      </div>
    </div>
  );
}

function ContractConflictCard({ conflict, tenant, busy, C, onOpenContracts, onOpenPdf, onUseExisting, onRefresh }) {
  const { Btn } = window;
  const roomId = conflict.room_id || tenant.roomId || '—';
  const contractNo = conflict.contract_no || `#${conflict.id || '—'}`;
  const conflictTenantId = conflict.tenant_id != null ? String(conflict.tenant_id) : '';
  const currentTenantId = tenant.dbId != null ? String(tenant.dbId)
    : (tenant.tenantId != null ? String(tenant.tenantId) : '');
  const canUseExistingHere = !!conflict.id && !!conflictTenantId
    && !!currentTenantId && conflictTenantId === currentTenantId;
  return (
    <Card style={{ padding: 16, background: '#fff7e8', border: '1px solid #f0c36d' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ fontSize: 22, lineHeight: 1 }}>⚠️</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#7a3f12', marginBottom: 6 }}>
            ห้องนี้มีสัญญาเดิมอยู่แล้ว
          </div>
          <div style={{ fontSize: 12.5, color: '#7a3f12', lineHeight: 1.55, marginBottom: 10 }}>
            ระบบไม่สร้างสัญญาซ้ำให้ห้องเดียวกัน เพื่อกันบิลและสถานะห้องผิดคน
            {conflict.hint ? <><br />{conflict.hint}</> : null}
          </div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px',
            fontSize: 12.5, color: C.ink2, marginBottom: 12,
          }}>
            <span style={{ color: C.muted }}>สัญญาเดิม</span><b>{contractNo}</b>
            <span style={{ color: C.muted }}>ห้อง</span><b>{roomId}</b>
            <span style={{ color: C.muted }}>ผู้เช่าในสัญญา</span><b>{conflict.tenant_name || conflict.full_name || '-'}</b>
            <span style={{ color: C.muted }}>สถานะ</span><b>{conflict.status || 'active'}</b>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {canUseExistingHere ? (
              <Btn variant="primary" size="sm" disabled={busy} onClick={onUseExisting}>
                ใช้สัญญาเดิมนี้ต่อ
              </Btn>
            ) : null}
            {conflict.id ? (
              <Btn variant="secondary" size="sm" disabled={busy} onClick={onOpenPdf}>
                ดู PDF สัญญาเดิม
              </Btn>
            ) : null}
            <Btn variant="ghost" size="sm" disabled={busy} onClick={onOpenContracts}>
              เปิดหน้าสัญญาที่ชนกัน
            </Btn>
            <Btn variant="ghost" size="sm" disabled={busy} onClick={onRefresh}>
              โหลดข้อมูลใหม่
            </Btn>
          </div>
        </div>
      </div>
    </Card>
  );
}

// Big-tile button for the "no contract yet" 2-way fork. Hover lifts the
// border so admin can see this is a primary action.
function ContractActionTile({ icon, title, desc, onClick, busy, C, tone = 'default' }) {
  const toneBorder = tone === 'danger' ? '#e6b8ad' : C.border;
  const toneBg = tone === 'danger' ? '#fff4f1' : C.surface;
  const toneHoverBorder = tone === 'danger' ? '#c95b43' : C.accent;
  const toneHoverBg = tone === 'danger' ? '#fff0eb' : '#faf6ee';
  return (
    <button onClick={onClick} disabled={busy}
      style={{
        textAlign: 'left', padding: 14, borderRadius: 10,
        border: `1px solid ${toneBorder}`, background: toneBg,
        cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit',
        opacity: busy ? 0.6 : 1, transition: 'all 0.15s',
      }}
      onMouseOver={(e) => {
        if (busy) return;
        e.currentTarget.style.borderColor = toneHoverBorder;
        e.currentTarget.style.background = toneHoverBg;
      }}
      onMouseOut={(e) => {
        e.currentTarget.style.borderColor = toneBorder;
        e.currentTarget.style.background = toneBg;
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

function contractReviewChecklistItems(detail) {
  const draft = (detail && detail.draft) || {};
  const checks = [
    { field: 'address', group: 'ข้อมูลผู้เช่า', label: 'ที่อยู่ผู้เช่า', fix: 'ให้ผู้เช่ากรอกที่อยู่ก่อน lock สัญญา' },
    { field: 'emergencyContactName', group: 'ผู้ติดต่อฉุกเฉิน', label: 'ชื่อผู้ติดต่อฉุกเฉิน', fix: 'ขอชื่อผู้ติดต่อฉุกเฉินจากผู้เช่า' },
    { field: 'emergencyContactPhone', group: 'ผู้ติดต่อฉุกเฉิน', label: 'เบอร์ผู้ติดต่อฉุกเฉิน', fix: 'ขอเบอร์ฉุกเฉินที่โทรได้จริง' },
    { field: 'citizenId', group: 'ยืนยันตัวตน', label: 'เลขบัตรประชาชน 13 หลัก', fix: 'ให้ผู้เช่ากรอกเลขบัตรให้ครบ 13 หลัก' },
    { field: 'citizenIdImageFrontId', group: 'ยืนยันตัวตน', label: 'รูปบัตรด้านหน้า', fix: 'อัปโหลดรูปด้านหน้าบัตรที่อ่านเลขได้ชัดเจน' },
    { field: 'citizenIdImageBackId', group: 'ยืนยันตัวตน', label: 'รูปบัตรด้านหลัง', fix: 'อัปโหลดรูปด้านหลังบัตรให้ครบ' },
    { field: 'signatureFileId', group: 'ลายเซ็น', label: 'ลายเซ็นผู้เช่า', fix: 'ให้ผู้เช่าเซ็นก่อนส่งกลับมาใหม่' },
  ];
  return checks.map((item) => {
    const value = draft[item.field];
    const fallbackUrl = item.field === 'citizenIdImageFrontId'
      ? detail && detail.draft_front_url
      : item.field === 'citizenIdImageBackId'
        ? detail && detail.draft_back_url
        : item.field === 'signatureFileId'
          ? detail && detail.draft_signature_url
          : '';
    const missing = item.field === 'citizenId'
      ? String(value || '').replace(/\D/g, '').length !== 13
      : item.field.endsWith('Id')
        ? ((!Number.isInteger(Number(value)) || Number(value) < 1) && !fallbackUrl)
        : !String(value || '').trim();
    return { ...item, ready: !missing };
  });
}

function contractReviewRejectReason(items) {
  if (!items.length) return '';
  return [
    'กรุณาแก้ข้อมูลต่อไปนี้ก่อนส่งสัญญาใหม่:',
    ...items.map((it, idx) => `${idx + 1}. ${it.label} — ${it.fix}`),
  ].join('\n');
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
  const reviewChecklist = contractReviewChecklistItems(detail);
  const missingReviewItems = reviewChecklist.filter((item) => !item.ready);
  const readyReviewCount = reviewChecklist.length - missingReviewItems.length;
  const openRejectForm = () => {
    if (!rejectReason.trim() && missingReviewItems.length) {
      setRejectReason(contractReviewRejectReason(missingReviewItems));
    }
    setShowRejectForm(true);
  };

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

      <div style={{
        padding: 10,
        marginBottom: 12,
        borderRadius: 8,
        border: `1px solid ${missingReviewItems.length ? '#f1b32d' : (C.success || '#2f8f5b')}55`,
        background: missingReviewItems.length ? (C.warningSoft || '#fff7ed') : (C.successSoft || '#e6f4ec'),
        color: C.ink2,
        fontSize: 12,
        lineHeight: 1.45,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
          <b style={{ color: C.ink }}>ความครบถ้วนก่อน lock</b>
          <span style={{ fontWeight: 700, color: missingReviewItems.length ? (C.warningInk || '#92400e') : (C.success || '#2f8f5b') }}>
            {readyReviewCount}/{reviewChecklist.length} ครบ
          </span>
        </div>
        {missingReviewItems.length ? (
          <ul style={{ margin: '0 0 0 18px', padding: 0 }}>
            {missingReviewItems.map((it) => (
              <li key={it.field}>
                <b>{it.group}: {it.label}</b> — {it.fix}
              </li>
            ))}
          </ul>
        ) : (
          <div style={{ color: C.muted }}>ข้อมูลสำคัญครบแล้ว ตรวจภาพบัตรกับเลขจริงอีกครั้งก่อนอนุมัติ</div>
        )}
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
          <Btn variant="ghost" onClick={openRejectForm} disabled={busy}>ขอให้แก้</Btn>
          <Btn variant="primary" onClick={onApprove} disabled={busy || missingReviewItems.length > 0}>
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

function CheckInModal({ tenantId, tenant, rentInfo, onClose, onDone, onError }) {
  const C = window.ADMIN_C;
  const { Modal, Btn } = window;
  const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
  const contractTodayYmd = window.contractTodayYmd || (() => new Date().toISOString().slice(0, 10));
  const addContractMonths = window.addContractMonths || (() => '');
  const estimateContractMonths = window.estimateContractMonths || (() => null);
  const contractDateSummary = window.contractDateSummary || (() => '');
  const initialStartDate = contractTodayYmd();
  const pricingRent = Number(rentInfo && rentInfo.rent) || Number(tenant.rent) || 0;
  const pricingDepositValue = Number(rentInfo && rentInfo.deposit);
  const pricingDeposit = Number.isFinite(pricingDepositValue) && pricingDepositValue >= 0
    ? pricingDepositValue
    : (pricingRent > 0 ? pricingRent * 2 : 0);
  const [form, setForm] = React.useState({
    moveInDate: initialStartDate,
    monthlyRent: pricingRent > 0 ? String(pricingRent) : '',
    depositAmount: Number.isFinite(pricingDeposit) && pricingDeposit >= 0 ? String(pricingDeposit) : '',
    termMonths: '12',
    endDate: addContractMonths(initialStartDate, 12),
    discountPct: '',  // empty → resolved from termMonths + config.discounts
    waterStartReading: '',  // เลขมิเตอร์น้ำตั้งต้นของห้องตอนย้ายเข้า
    elecStartReading: '',   // เลขมิเตอร์ไฟตั้งต้นของห้องตอนย้ายเข้า
  });
  const [busy, setBusy] = React.useState(false);
  const pricingValid = Number.isFinite(pricingRent) && pricingRent > 0;
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
    if (!pricingValid) {
      onError && onError('ห้องนี้ยังไม่มีค่าเช่าที่ตั้งไว้ — ไปตั้งราคาที่เมนูตั้งราคา/ห้องพักก่อนเช็คอิน');
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
        monthlyRent: pricingRent,
        depositAmount: pricingDeposit,
      };
      if (form.termMonths) payload.termMonths = Number(form.termMonths);
      if (form.endDate) payload.endDate = form.endDate;
      if (form.discountPct !== '') payload.discountPct = Number(form.discountPct);
      // Starting meter readings — the room's current meter value at move-in so
      // the first real bill measures THIS tenant's consumption from their own
      // baseline (not the previous tenant's reading or 0). Sent only when
      // filled; server policy (tenancyContract.meterStartPolicy) decides if
      // required for metered rooms.
      if (form.waterStartReading !== '') payload.waterStartReading = Number(form.waterStartReading);
      if (form.elecStartReading !== '') payload.elecStartReading = Number(form.elecStartReading);
      await apiCall(`/api/tenants/${tenantId}/checkin`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      onDone && onDone();
    } catch (err) {
      onError && onError(err);
    } finally { setBusy(false); }
  };
  return (
    <Modal open={true} onClose={onClose} title="เช็คอินผู้เช่า"
      footer={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={busy}>ยกเลิก</Btn>
          <Btn variant="primary" onClick={submit} disabled={busy || !termValid || !endDateValid || !pricingValid}>
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
              readOnly aria-readonly="true"
              required style={{ ...inInp, background: C.surfaceAlt, color: C.ink }} />
          </div>
          <div>
            <label style={inLbl}>เงินมัดจำ (บาท)</label>
            <input type="number" step="0.01" min="0" value={form.depositAmount}
              readOnly aria-readonly="true"
              required style={{ ...inInp, background: C.surfaceAlt, color: C.ink }} />
          </div>
        </div>
        <div style={{
          padding: 10, background: '#f7fbff', border: `1px solid ${C.border}`,
          borderRadius: 6, fontSize: 12, color: C.muted, lineHeight: 1.5,
        }}>
          ค่าเช่าดึงจาก {rentInfo && rentInfo.sourceLabel ? rentInfo.sourceLabel : 'ข้อมูลห้อง'}
          และมัดจำดึงจาก {rentInfo && rentInfo.depositSourceLabel ? rentInfo.depositSourceLabel : 'เมนูตั้งราคา'} เท่านั้น
          หากต้องเปลี่ยนราคา ให้แก้ที่เมนูตั้งราคา หรือใช้ override รายห้องในหน้าห้องพักก่อน แล้วกลับมาเช็คอินใหม่
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={inLbl}>เลขมิเตอร์น้ำตั้งต้น</label>
            <input type="number" step="0.01" min="0" value={form.waterStartReading}
              onChange={(e) => setForm({ ...form, waterStartReading: e.target.value })}
              placeholder="เลขที่อ่านจากหน้ามิเตอร์ตอนนี้" style={inInp} />
          </div>
          <div>
            <label style={inLbl}>เลขมิเตอร์ไฟตั้งต้น</label>
            <input type="number" step="0.01" min="0" value={form.elecStartReading}
              onChange={(e) => setForm({ ...form, elecStartReading: e.target.value })}
              placeholder="เลขที่อ่านจากหน้ามิเตอร์ตอนนี้" style={inInp} />
          </div>
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
    {
      key: 'action', label: 'เหตุการณ์', minWidth: 200,
      // Thai label + a one-line detail summary (room/contract/amounts/reason)
      // so the history reads as events, not API verbs hiding JSON.
      render: (a) => {
        const label = window.auditActionTH ? window.auditActionTH(a.action) : (a.action || '-');
        const detail = window.describeAuditDetail ? window.describeAuditDetail(a) : '';
        return (
          <div>
            <div>{label}</div>
            {detail ? (
              <div style={{ fontSize: 11, color: C.muted, marginTop: 2, lineHeight: 1.4 }}>{detail}</div>
            ) : null}
          </div>
        );
      },
    },
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
