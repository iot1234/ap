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
    completed: bookings.filter(b => b.status === 'completed').length,
    cancelled: bookings.filter(b => b.status === 'cancelled').length,
  }), [bookings]);

  const active = activeId ? bookings.find(b => b.id === activeId) : null;

  // updateStatus is the canonical state-change hook. The server enforces
  // transitions, audits, notifies owner/tenant, and releases reserved rooms
  // on cancellation. If the server rejects the change, the optimistic row is
  // reverted so the UI cannot show a phantom status.
  const updateStatus = async (id, status, extra = {}) => {
    const before = bookings.find((b) => b.id === id);
    setBookings(prev => prev.map(b => b.id === id ? { ...b, status, ...extra } : b));
    try {
      const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
      if (!apiCall) throw new Error('Admin API helper is not loaded. Refresh the page.');
      const out = await apiCall(`/api/bookings/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ status, ...extra }),
      });
      if (out && out.booking) {
        setBookings(prev => prev.map(b => b.id === id ? out.booking : b));
      }
      if (out && out.releasedRoomId && out.room && setRooms) {
        setRooms(prev => ({ ...prev, [out.releasedRoomId]: out.room }));
      }
      return true;
    } catch (e) {
      if (before) {
        setBookings(prev => prev.map(b => b.id === id ? before : b));
      }
      window.toastError
        ? window.toastError(setToast, e, { action: `เปลี่ยนสถานะการจอง ${id}` })
        : setToast && setToast({ kind: 'danger', message: e.message || 'เปลี่ยนสถานะการจองไม่สำเร็จ' });
      return false;
    }
  };

  const handleApprove = async (id) => {
    const booking = bookings.find(b => b.id === id);
    if (!booking) return;
    // Atomic server-side approve+assign — replaces the previous client-side
    // optimistic update which had a race condition: two admins approving
    // different bookings simultaneously could both pick the same vacant
    // room (last write wins → one tenant displaced). The new endpoint
    // SELECTs both blobs FOR UPDATE so the second caller sees the first's
    // reservation + falls through to the next vacant room cleanly.
    let assignedRoomId = null;
    try {
      const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
      if (!apiCall) throw new Error('Admin API helper is not loaded. Refresh the page.');
      const out = await apiCall(`/api/bookings/${encodeURIComponent(id)}/approve-and-assign`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      assignedRoomId = out.assignedRoomId;
      // Mirror the server's mutation into local React state so the table
      // + drawer reflect "approved" + "reserved" without waiting for the
      // next /api/data poll.
      setBookings((prev) => prev.map((b) => b.id === id ? out.booking : b));
      if (out.room && out.assignedRoomId) {
        setRooms((prev) => ({ ...prev, [out.assignedRoomId]: out.room }));
      }
    } catch (err) {
      // Server refused — propagate the error and DON'T touch local state.
      // Common reasons: bad transition (already approved/cancelled), 404
      // (booking not found in current blob — admin's tab is stale).
      window.toastError
        ? window.toastError(setToast, err, { action: `อนุมัติการจอง ${id}` })
        : setToast && setToast({ kind: 'danger', message: err.message || 'อนุมัติไม่สำเร็จ' });
      setActiveId(null); setConfirmAction(null);
      return;
    }

    addActivity && addActivity({
      icon: '✅',
      text: assignedRoomId
        ? `อนุมัติการจอง ${id} → จองห้อง ${assignedRoomId}`
        : `อนุมัติการจอง ${id} (ยังไม่ได้กำหนดห้อง — ไม่มีห้องว่างตรงเงื่อนไข)`,
      type: 'booking',
    });

    // Surface the unfinished workflow EXPLICITLY: an approved booking is
    // only halfway done. Without these next steps the tenant may not be
    // reachable on LINE (no binding code), and
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
          ? 'ขั้นต่อไป: เปิดหน้าสัญญาของผู้เช่าห้องนี้ แล้วสร้างสัญญา/ส่งลิงก์จาก booking เดิม'
          : 'ยังไม่มีห้องว่างตรงเงื่อนไข — กำหนดห้องด้วยตนเองที่หน้า "ห้องพัก" ก่อนตั้งค่าผู้เช่า',
        action: assignedRoomId ? {
          label: 'สร้างสัญญา →',
          // Jump to tenants page; admin can find the just-mirrored row
          // (mirrorRoomsToTenants creates it from the rooms-blob save).
          // Keep the booking id in the URL so the next page can preserve
          // context while the quick-invite payload pulls reservedBy from room.
          onClick: () => {
            window.location.hash =
              `#tenants?room=${encodeURIComponent(assignedRoomId)}&tab=contract&booking=${encodeURIComponent(id)}`;
          },
        } : {
          label: 'ไปจัดห้อง →',
          onClick: () => { window.location.hash = '#rooms'; },
        },
      },
    });
    setActiveId(null); setConfirmAction(null);
  };
  const handleReject = async (id) => {
    const ok = await updateStatus(id, 'rejected');
    if (!ok) return;
    addActivity && addActivity({ icon: '❌', text: `ปฏิเสธการจอง ${id}`, type: 'booking' });
    setToast && setToast({ kind: 'info', message: 'ปฏิเสธการจองแล้ว' });
    setActiveId(null); setConfirmAction(null);
  };

  const statusMap = {
    pending:   { label: 'รอตรวจสอบ', color: 'warning' },
    reviewing: { label: 'กำลังตรวจ', color: 'info' },
    approved:  { label: 'อนุมัติแล้ว', color: 'success' },
    rejected:  { label: 'ปฏิเสธ',     color: 'danger' },
    completed: { label: 'เสร็จสิ้น',   color: 'neutral' },
    cancelled: { label: 'ยกเลิก',     color: 'neutral' },
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
            background: C.warningSoft, color: C.warningInk,
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
      render: b => {
        const meta = statusMap[b.status] || { label: b.status || 'unknown', color: 'neutral' };
        return <Pill color={meta.color} size="sm">{meta.label}</Pill>;
      },
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
          { value: 'completed', label: 'เสร็จสิ้น',  count: counts.completed },
          { value: 'cancelled', label: 'ยกเลิก',     count: counts.cancelled },
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
                <Btn variant="secondary" icon="🔍" onClick={async () => {
                  if (active.status === 'pending') {
                    const ok = await updateStatus(active.id, 'reviewing');
                    if (!ok) return;
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
              <>
                {(active.assignedRoomId || active.roomId) && (
                  <Btn variant="primary" icon="📄" onClick={() => {
                    const roomId = active.assignedRoomId || active.roomId;
                    window.location.hash =
                      `#tenants?room=${encodeURIComponent(roomId)}&tab=contract&booking=${encodeURIComponent(active.id)}`;
                    setActiveId(null);
                  }}>
                    สร้างสัญญา
                  </Btn>
                )}
                <Btn variant="ghost" onClick={async () => {
                  const ok = await updateStatus(active.id, 'cancelled');
                  if (!ok) return;
                  addActivity && addActivity({ icon: '↺', text: `ยกเลิกอนุมัติการจอง ${active.id}`, type: 'booking' });
                  setToast && setToast({ kind: 'info', message: 'ยกเลิกการจองและปล่อยห้องแล้ว' });
                  setActiveId(null);
                }}>ยกเลิก/ปล่อยห้อง</Btn>
              </>
            )}
            {active.status === 'rejected' && (
              <Btn variant="ghost" onClick={async () => {
                const ok = await updateStatus(active.id, 'reviewing');
                if (!ok) return;
                addActivity && addActivity({ icon: '↺', text: `ทบทวนการจอง ${active.id}`, type: 'booking' });
                setToast && setToast({ kind: 'info', message: 'ส่งกลับไปตรวจสอบใหม่แล้ว' });
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
              : <Btn variant="danger" onClick={() => handleReject(confirmAction.id)}>ปฏิเสธการจอง</Btn>}
          </>
        }
      >
        {(() => {
          // Pull the actual booking so the confirm shows context (name,
          // phone, what kind of room they wanted) rather than just an
          // opaque id like "BK-PUB-abc123". Helps admin double-check this
          // is the right booking before the destructive click.
          const b = confirmAction ? bookings.find((x) => x.id === confirmAction.id) : null;
          const isApprove = confirmAction?.type === 'approve';
          return (
            <div style={{ fontSize: 14, color: C.ink2, lineHeight: 1.7 }}>
              <div style={{ marginBottom: 12 }}>
                {isApprove ? 'อนุมัติการจอง:' : 'ปฏิเสธการจอง:'}
                <div style={{ marginTop: 6, padding: '8px 12px',
                              background: C.surfaceAlt || C.surfaceAlt,
                              borderRadius: 8, fontSize: 13.5 }}>
                  <b style={{ color: C.ink }}>{b?.name || confirmAction?.id}</b>
                  {b?.phone && <span style={{ color: C.muted }}> · {b.phone}</span>}
                  {b?.wantType && (
                    <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                      ต้องการ {ADMIN_ROOM_TYPES[b.wantType]?.th || b.wantType}
                      {b.wantFloor ? ` · ชั้น ${b.wantFloor}` : ''}
                      {b.moveIn ? ` · เข้าพัก ${fmtDateTH(b.moveIn)}` : ''}
                    </div>
                  )}
                </div>
              </div>

              <div style={{
                padding: '10px 12px',
                background: isApprove ? (C.successSoft || C.successSoft) : (C.warningSoft || C.warningSoft),
                borderLeft: `3px solid ${isApprove ? (C.success || C.success) : (C.warning || C.warning)}`,
                borderRadius: 6, fontSize: 12.5, color: C.ink2,
              }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>📌 สิ่งที่จะเกิดขึ้น</div>
                {isApprove ? (
                  <>
                    1) ระบบจะหาห้องว่างตรงเงื่อนไขแล้วตั้งเป็น "จองแล้ว" อัตโนมัติ<br/>
                    2) ผู้จองจะได้รับแจ้งเตือนทาง LINE/อีเมล (ถ้ามีข้อมูล)<br/>
                    3) <b style={{ color: C.warning || C.warning }}>ขั้นต่อไป:</b> ตรวจเบอร์ผู้เช่า + ผูก LINE ที่หน้า "ผู้เช่า" — ผู้เช่า login portal ด้วยเบอร์ที่ผูกกับห้อง
                  </>
                ) : (
                  <>
                    1) สถานะการจองจะเปลี่ยนเป็น "ปฏิเสธ" — กดดู/เปลี่ยนกลับได้ในแท็บ "ปฏิเสธ"<br/>
                    2) ผู้จองจะได้รับ LINE/อีเมลแจ้ง "ขออภัย — ไม่ได้รับการอนุมัติ" (ใส่ adminNotes ใน drawer ก่อนถ้าต้องการระบุเหตุผล)
                  </>
                )}
              </div>
            </div>
          );
        })()}
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
    completed: { label: 'เสร็จสิ้น',   color: 'neutral' },
    cancelled: { label: 'ยกเลิก',     color: 'neutral' },
  };
  const meta = statusMap[b.status] || { label: b.status || 'unknown', color: 'neutral' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <Card style={{ padding: 16, background: C.surfaceAlt }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Avatar name={b.name} size={48} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>{b.name}</div>
            <div style={{ fontSize: 12.5, color: C.muted }}>{b.phone}</div>
          </div>
          <Pill color={meta.color}>{meta.label}</Pill>
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
        padding: 14, background: C.surfaceAlt,
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
