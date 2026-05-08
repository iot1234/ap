// === admin/page-bookings.jsx ==============================================
// การจอง: รอตรวจสอบ / ตรวจสอบ / อนุมัติ / ปฏิเสธ
// ===========================================================================

const { useState, useMemo } = React;

function PageBookings({ rooms, setRooms, bookings, setBookings, addActivity, setToast }) {
  const C = window.ADMIN_C;
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES;
  const { fmt, fmtCurrency, fmtDateTH, relTime } = window;
  const { Card, Btn, IconBtn, Avatar, Pill, DataTable, Drawer, Modal,
          PageContainer, PageHeader, SectionHeading, DefList, Tabs, EmptyState } = window;

  const [tab, setTab] = useState('pending');
  const [activeId, setActiveId] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null);

  const filtered = useMemo(() => {
    if (tab === 'all') return bookings;
    return bookings.filter(b => b.status === tab);
  }, [bookings, tab]);

  const counts = useMemo(() => ({
    pending:   bookings.filter(b => b.status === 'pending').length,
    reviewing: bookings.filter(b => b.status === 'reviewing').length,
    approved:  bookings.filter(b => b.status === 'approved').length,
    rejected:  bookings.filter(b => b.status === 'rejected').length,
  }), [bookings]);

  const active = activeId ? bookings.find(b => b.id === activeId) : null;

  // updateStatus is the canonical state-change hook. It still writes to the
  // local bookings list (api-client mirrors this into baankarn_bookings_v1),
  // and ALSO fires PUT /api/bookings/:id which on the server side enforces
  // the transition guard, audits the change, and pushes notifications to
  // owner + tenant. Fail-soft: a server outage doesn't block the UI from
  // reflecting the action — local state still updates and the api-client's
  // /api/data sync persists eventually.
  const updateStatus = async (id, status, extra = {}) => {
    // Snapshot the prior state so we can revert if the server rejects the
    // transition (e.g. trying to approve→reviewing — server returns 400 with
    // an `allowed` list). Admin sees a toast instead of a phantom approval.
    const before = bookings.find((b) => b.id === id);
    setBookings(prev => prev.map(b => b.id === id ? { ...b, status, ...extra } : b));
    try {
      const f = window.apiFetch || fetch;
      const r = await f(`/api/bookings/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ status, ...extra }),
      });
      if (r && r.ok === false || (r && r.status >= 400)) {
        const j = await r.json().catch(() => ({}));
        if (before) {
          setBookings(prev => prev.map(b => b.id === id ? before : b));
        }
        setToast && setToast({
          kind: 'error',
          message: j.error || `เปลี่ยนสถานะไม่สำเร็จ (HTTP ${r.status})`,
        });
      }
    } catch (e) {
      // Network failure → keep optimistic update; api-client.js will sync
      // the bookings blob via /api/data once the connection is back.
    }
  };

  const handleApprove = (id) => {
    const booking = bookings.find(b => b.id === id);
    if (!booking) return;
    updateStatus(id, 'approved');

    // Find a vacant room of the requested type+floor (best fit). If found,
    // mark it as 'reserved' and seed tenant info from the booking. Admin can
    // change the assignment in /admin#rooms after this — this just removes
    // the manual data-entry duplication on approval.
    const want = (b) => (
      (!booking.wantType || b.type === booking.wantType) &&
      (!booking.wantFloor || b.floor === Number(booking.wantFloor))
    );
    const candidate = Object.values(rooms || {})
      .filter((r) => r.status === 'vacant' && want(r))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];

    let assignedRoomId = null;
    if (candidate && setRooms) {
      assignedRoomId = candidate.id;
      setRooms((prev) => ({
        ...prev,
        [candidate.id]: {
          ...prev[candidate.id],
          status: 'reserved',
          tenant: {
            name: booking.name,
            phone: booking.phone || '',
            email: booking.email || '',
            occupation: '',
            score: 'A',
            since: new Date().toISOString().slice(0, 10),
          },
        },
      }));
    }

    addActivity && addActivity({
      icon: '✅',
      text: assignedRoomId
        ? `อนุมัติการจอง ${id} → จองห้อง ${assignedRoomId}`
        : `อนุมัติการจอง ${id} (ยังไม่ได้กำหนดห้อง — ไม่มีห้องว่างตรงเงื่อนไข)`,
      type: 'booking',
    });

    // Surface the unfinished workflow EXPLICITLY: an approved booking is
    // only halfway done. Without these next steps the tenant can't login to
    // /tenant (no PIN), can't be reached on LINE (no binding code), and
    // can't be added to the legal contract. The previous flow ended with a
    // generic "approved" toast that gave no hint anything was missing —
    // operators kept asking "ทำไม tenant login ไม่ได้".
    //
    // We use the rich-toast payload (kind:'success' with title+description+
    // action) so the next step is one click away from the approval moment.
    setToast && setToast({
      kind: 'success',
      message: {
        title: assignedRoomId
          ? `✅ อนุมัติแล้ว — จัดห้อง ${assignedRoomId}`
          : '✅ อนุมัติแล้ว',
        description: assignedRoomId
          ? 'ขั้นต่อไป: ตั้ง PIN ให้ผู้เช่า + ผูก LINE เพื่อให้เข้าใช้ portal และรับแจ้งเตือนได้'
          : 'ยังไม่มีห้องว่างตรงเงื่อนไข — กำหนดห้องด้วยตนเองที่หน้า "ห้องพัก" ก่อนตั้งค่าผู้เช่า',
        action: assignedRoomId ? {
          label: 'ตั้งค่าผู้เช่า →',
          // Jump to tenants page; admin can find the just-mirrored row
          // (mirrorRoomsToTenants creates it from the rooms-blob save) and
          // set PIN + issue a LINE binding code from there.
          onClick: () => { window.location.hash = '#tenants'; },
        } : {
          label: 'ไปจัดห้อง →',
          onClick: () => { window.location.hash = '#rooms'; },
        },
      },
    });
    setActiveId(null); setConfirmAction(null);
  };
  const handleReject = (id) => {
    updateStatus(id, 'rejected');
    addActivity && addActivity({ icon: '❌', text: `ปฏิเสธการจอง ${id}`, type: 'booking' });
    setToast && setToast({ kind: 'info', message: 'ปฏิเสธการจองแล้ว' });
    setActiveId(null); setConfirmAction(null);
  };

  const statusMap = {
    pending:   { label: 'รอตรวจสอบ', color: 'warning' },
    reviewing: { label: 'กำลังตรวจ', color: 'info' },
    approved:  { label: 'อนุมัติแล้ว', color: 'success' },
    rejected:  { label: 'ปฏิเสธ',     color: 'danger' },
  };

  const columns = [
    {
      key: 'id', label: 'รหัสการจอง', minWidth: 150,
      render: b => <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12.5, fontWeight: 500 }}>{b.id}</span>,
    },
    {
      key: 'name', label: 'ผู้จอง', minWidth: 200,
      render: b => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Avatar name={b.name} size={32} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{b.name}</div>
            <div style={{ fontSize: 11.5, color: C.muted }}>{b.phone}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'wantType', label: 'ห้องที่จอง', minWidth: 160,
      render: b => {
        const typeMeta = ADMIN_ROOM_TYPES[b.wantType] || ADMIN_ROOM_TYPES.standard;
        const floorTxt = b.wantFloor ? `ชั้น ${b.wantFloor}` : 'ไม่ระบุชั้น';
        const monthsTxt = b.months ? `${b.months} เดือน` : '—';
        const sourceTag = b.source === 'public-form' ? (
          <span style={{
            display: 'inline-block', marginLeft: 6,
            background: '#fbf1de', color: '#5a3a0d',
            fontSize: 10, fontWeight: 600,
            padding: '1px 6px', borderRadius: 4,
          }}>หน้าจอง</span>
        ) : null;
        return (
          <div>
            <div style={{ fontSize: 12.5, color: C.ink }}>
              {typeMeta.th}{sourceTag}
            </div>
            <div style={{ fontSize: 11.5, color: C.muted }}>{floorTxt} · {monthsTxt}</div>
          </div>
        );
      },
    },
    {
      key: 'moveIn', label: 'ย้ายเข้า', minWidth: 110,
      render: b => <span style={{ fontSize: 12.5, color: C.ink2 }}>{fmtDateTH(b.moveIn)}</span>,
    },
    {
      key: 'deposit', label: 'มัดจำ', align: 'right', minWidth: 100,
      render: b => <span style={{ fontWeight: 600 }}>{fmtCurrency(b.deposit)}</span>,
    },
    {
      key: 'createdAt', label: 'จองเมื่อ', minWidth: 110,
      render: b => <span style={{ fontSize: 12, color: C.muted }}>{relTime(b.createdAt)}</span>,
    },
    {
      key: 'status', label: 'สถานะ', minWidth: 110,
      render: b => <Pill color={statusMap[b.status].color} size="sm">{statusMap[b.status].label}</Pill>,
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        title="การจองห้องพัก"
        subtitle={`การจองทั้งหมด ${bookings.length} รายการ · รอตรวจสอบ ${counts.pending} รายการ`}
        actions={<Btn variant="secondary" icon="📤" onClick={() => {
          if (window.exportBookingsCSV(bookings)) {
            addActivity && addActivity({ icon: '📤', text: `ส่งออกข้อมูลการจอง ${bookings.length} รายการ เป็น CSV`, type: 'system' });
            setToast && setToast({ kind: 'success', message: `ดาวน์โหลด CSV ${bookings.length} การจองเรียบร้อย` });
          }
        }}>ส่งออก</Btn>}
      />

      <Tabs
        items={[
          { value: 'pending',   label: 'รอตรวจสอบ', count: counts.pending },
          { value: 'reviewing', label: 'กำลังตรวจ', count: counts.reviewing },
          { value: 'approved',  label: 'อนุมัติแล้ว', count: counts.approved },
          { value: 'rejected',  label: 'ปฏิเสธ',     count: counts.rejected },
          { value: 'all',       label: 'ทั้งหมด',    count: bookings.length },
        ]}
        value={tab}
        onChange={setTab}
        variant="pills"
        style={{ marginBottom: 16 }}
      />

      <DataTable
        columns={columns}
        rows={filtered}
        onRowClick={(b) => setActiveId(b.id)}
        empty={<EmptyState icon="📋" title="ไม่มีการจอง" description="เมื่อมีการจองใหม่จะแสดงที่นี่" />}
      />

      <Drawer
        open={!!active}
        onClose={() => setActiveId(null)}
        title={active ? `การจอง ${active.id}` : ''}
        width={560}
        footer={active && (
          <>
            <Btn variant="ghost" onClick={() => setActiveId(null)}>ปิด</Btn>
            {(active.status === 'pending' || active.status === 'reviewing') && (
              <>
                <Btn variant="secondary" icon="🔍" onClick={() => {
                  if (active.status === 'pending') {
                    updateStatus(active.id, 'reviewing');
                    addActivity && addActivity({ icon: '🔍', text: `เริ่มตรวจสอบการจอง ${active.id}`, type: 'booking' });
                    setToast && setToast({ kind: 'info', message: 'เปลี่ยนเป็นกำลังตรวจสอบ' });
                  }
                }} disabled={active.status === 'reviewing'}>
                  {active.status === 'reviewing' ? 'กำลังตรวจสอบ' : 'เริ่มตรวจสอบ'}
                </Btn>
                <Btn variant="danger" icon="✗" onClick={() => setConfirmAction({ id: active.id, type: 'reject' })}>
                  ปฏิเสธ
                </Btn>
                <Btn variant="success" icon="✓" onClick={() => setConfirmAction({ id: active.id, type: 'approve' })}>
                  อนุมัติ
                </Btn>
              </>
            )}
            {active.status === 'approved' && (
              <Btn variant="ghost" onClick={() => {
                updateStatus(active.id, 'pending');
                addActivity && addActivity({ icon: '↺', text: `ยกเลิกอนุมัติการจอง ${active.id}`, type: 'booking' });
                setToast && setToast({ kind: 'info', message: 'ย้อนกลับเป็นรอตรวจสอบ' });
              }}>↺ ย้อนกลับ</Btn>
            )}
            {active.status === 'rejected' && (
              <Btn variant="ghost" onClick={() => {
                updateStatus(active.id, 'pending');
                addActivity && addActivity({ icon: '↺', text: `ทบทวนการจอง ${active.id}`, type: 'booking' });
                setToast && setToast({ kind: 'info', message: 'ย้อนกลับเป็นรอตรวจสอบ' });
              }}>↺ ทบทวนใหม่</Btn>
            )}
          </>
        )}
      >
        {active && <BookingDetail b={active} />}
      </Drawer>

      <Modal
        open={!!confirmAction}
        onClose={() => setConfirmAction(null)}
        title={confirmAction?.type === 'approve' ? 'ยืนยันการอนุมัติ' : 'ยืนยันการปฏิเสธ'}
        footer={
          <>
            <Btn variant="ghost" onClick={() => setConfirmAction(null)}>ยกเลิก</Btn>
            {confirmAction?.type === 'approve'
              ? <Btn variant="success" onClick={() => handleApprove(confirmAction.id)}>อนุมัติ</Btn>
              : <Btn variant="danger" onClick={() => handleReject(confirmAction.id)}>ปฏิเสธ</Btn>}
          </>
        }
      >
        <div style={{ fontSize: 14, color: C.ink2, lineHeight: 1.6 }}>
          {confirmAction?.type === 'approve'
            ? <>ต้องการอนุมัติการจอง <b style={{ color: C.ink }}>{confirmAction.id}</b> หรือไม่? ระบบจะส่งข้อความยืนยันไปยังผู้จอง</>
            : <>ต้องการปฏิเสธการจอง <b style={{ color: C.ink }}>{confirmAction?.id}</b> หรือไม่?</>}
        </div>
      </Modal>
    </PageContainer>
  );
}

function BookingDetail({ b }) {
  const C = window.ADMIN_C;
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES;
  const { fmtCurrency, fmtDateTH, relTime } = window;
  const { Card, Avatar, Pill, DefList, SectionHeading } = window;

  const statusMap = {
    pending:   { label: 'รอตรวจสอบ', color: 'warning' },
    reviewing: { label: 'กำลังตรวจ', color: 'info' },
    approved:  { label: 'อนุมัติแล้ว', color: 'success' },
    rejected:  { label: 'ปฏิเสธ',     color: 'danger' },
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <Card style={{ padding: 16, background: C.surfaceAlt }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Avatar name={b.name} size={48} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>{b.name}</div>
            <div style={{ fontSize: 12.5, color: C.muted }}>{b.phone}</div>
          </div>
          <Pill color={statusMap[b.status].color}>{statusMap[b.status].label}</Pill>
        </div>
      </Card>

      <div>
        <SectionHeading title="รายละเอียดการจอง" level={3} />
        <DefList
          columns={2}
          items={[
            { label: 'รหัสการจอง',    value: b.id, bold: true },
            { label: 'ประเภทห้อง',    value: (ADMIN_ROOM_TYPES[b.wantType] || ADMIN_ROOM_TYPES.standard).th },
            { label: 'ชั้นที่ต้องการ', value: b.wantFloor ? `ชั้น ${b.wantFloor}` : 'ไม่ระบุ' },
            { label: 'ระยะเวลาเช่า',  value: b.months ? `${b.months} เดือน` : '—' },
            { label: 'วันที่ย้ายเข้า', value: b.moveIn ? fmtDateTH(b.moveIn) : '—' },
            { label: 'เงินมัดจำ',      value: fmtCurrency(b.deposit || 0), bold: true },
            { label: 'จองเมื่อ',         value: relTime(b.createdAt) },
            ...(b.email ? [{ label: 'อีเมล', value: b.email }] : []),
            ...(b.message ? [{ label: 'ข้อความ', value: b.message }] : []),
          ]}
        />
      </div>

      <div style={{
        padding: 14, background: '#fff8f1',
        border: `1px solid ${C.accent}33`, borderRadius: 10,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.accentInk, marginBottom: 6 }}>📌 การดำเนินการ</div>
        <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12.5, color: C.ink2, lineHeight: 1.7 }}>
          <li>โทรกลับยืนยันตัวตนผู้จอง</li>
          <li>ตรวจสอบเอกสารยืนยันตัวตน (สำเนาบัตรประชาชน)</li>
          <li>เช็คประวัติเครดิต (ถ้ามี)</li>
          <li>กำหนดห้องที่ตรงกับความต้องการ</li>
        </ul>
      </div>
    </div>
  );
}

window.PageBookings = PageBookings;
