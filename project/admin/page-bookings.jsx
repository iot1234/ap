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
  const [detailLoadingId, setDetailLoadingId] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null);
  const [actionReason, setActionReason] = useState('');

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

  const mergeBookingRow = (current, incoming) => {
    if (!incoming) return current;
    const currentLine = current && (current.lineBinding || current.line_binding);
    const incomingLine = incoming.lineBinding || incoming.line_binding;
    const merged = { ...(current || {}), ...incoming };
    if (current && current.id) merged.id = current.id;
    if (incomingLine || currentLine) merged.lineBinding = incomingLine || currentLine;
    return merged;
  };

  const openBookingDetail = async (bookingOrId) => {
    const id = typeof bookingOrId === 'object' && bookingOrId ? bookingOrId.id : bookingOrId;
    if (!id) return;
    setActiveId(id);
    setDetailLoadingId(id);
    try {
      const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
      if (!apiCall) throw new Error('Admin API helper is not loaded. Refresh the page.');
      const out = await apiCall(`/api/bookings/${encodeURIComponent(id)}`);
      if (out && out.booking) {
        setBookings(prev => prev.map(b => b.id === id ? mergeBookingRow(b, out.booking) : b));
      }
    } catch (err) {
      setToast && setToast({
        kind: 'warning',
        message: `โหลดสถานะล่าสุดของการจอง ${id} ไม่สำเร็จ: ${err.message || err}`,
      });
    } finally {
      setDetailLoadingId(prev => prev === id ? null : prev);
    }
  };

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
        setBookings(prev => prev.map(b => b.id === id ? mergeBookingRow(b, out.booking) : b));
      }
      if (out && out.releasedRoomId && out.room && setRooms) {
        setRooms(prev => ({ ...prev, [out.releasedRoomId]: out.room }));
      }
      return out || { ok: true };
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

  const bookingNotifyText = (out) => {
    const n = out && out.tenantNotify;
    if (!n) return '';
    const channelLabel = ({
      line: 'LINE',
      email: 'อีเมล',
      sms: 'SMS',
      queue: 'คิวแจ้งเตือน',
    })[n.channel] || n.channel || 'ระบบแจ้งเตือน';
    const lineCount = Number(n.lineRecipientCount || 0);
    const lineCountText = lineCount > 0 ? ` · ห้องนี้ผูก LINE ทั้งหมด ${lineCount} บัญชี` : '';
    if (n.ok) return ` — แจ้งผู้จองแล้วทาง ${channelLabel}${n.recipients ? ` ${n.recipients} บัญชี` : ''}${lineCountText}`;
    if (n.queued) return ` — เข้าคิวแจ้งผู้จองแล้ว (${channelLabel})${lineCountText}`;
    if (n.requiresManualContact) {
      return ` — ยังแจ้งอัตโนมัติไม่ได้ กรุณาโทรแจ้งผู้จอง${n.phone ? ` (${n.phone})` : ''}${lineCountText}`;
    }
    return '';
  };

  const bookingNotifyDescription = (out) => bookingNotifyText(out).replace(/^ — /, '');

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
    let approveOut = null;
    try {
      const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
      if (!apiCall) throw new Error('Admin API helper is not loaded. Refresh the page.');
      approveOut = await apiCall(`/api/bookings/${encodeURIComponent(id)}/approve-and-assign`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      assignedRoomId = approveOut.assignedRoomId;
      // Mirror the server's mutation into local React state so the table
      // + drawer reflect "approved" + "reserved" without waiting for the
      // next /api/data poll.
      setBookings((prev) => prev.map((b) => b.id === id ? mergeBookingRow(b, approveOut.booking) : b));
      if (approveOut.room && approveOut.assignedRoomId) {
        setRooms((prev) => ({ ...prev, [approveOut.assignedRoomId]: approveOut.room }));
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
          ? ['ขั้นต่อไป: เปิดหน้าสัญญาของผู้เช่าห้องนี้ แล้วสร้างสัญญา/ส่งลิงก์จาก booking เดิม', bookingNotifyDescription(approveOut)].filter(Boolean).join('\n')
          : ['ยังไม่มีห้องว่างตรงเงื่อนไข — กำหนดห้องด้วยตนเองที่หน้า "ห้องพัก" ก่อนตั้งค่าผู้เช่า', bookingNotifyDescription(approveOut)].filter(Boolean).join('\n'),
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
    const rejectReason = actionReason.trim();
    if (rejectReason.length < 5) {
      setToast && setToast({ kind: 'danger', message: 'กรุณาระบุเหตุผลปฏิเสธอย่างน้อย 5 ตัวอักษร เพื่อใช้แจ้งผู้จอง' });
      return;
    }
    const out = await updateStatus(id, 'rejected', { adminNotes: rejectReason });
    if (!out) return;
    addActivity && addActivity({ icon: '❌', text: `ปฏิเสธการจอง ${id}: ${rejectReason.slice(0, 60)}`, type: 'booking' });
    setToast && setToast({
      kind: 'info',
      message: out.releasedRoomId
        ? `ปฏิเสธการจองแล้ว — ปล่อยห้อง ${out.releasedRoomId}${out.releasedTenant ? ' และเคลียร์ผู้เช่าที่ผูกจาก booking แล้ว' : ''}${bookingNotifyText(out)}`
        : `ปฏิเสธการจองแล้ว${bookingNotifyText(out)}`,
    });
    setActionReason('');
    setActiveId(null); setConfirmAction(null);
  };

  const handleReopen = async (id) => {
    const reopenReason = actionReason.trim();
    if (reopenReason.length < 5) {
      setToast && setToast({ kind: 'danger', message: 'กรุณาระบุเหตุผลทบทวนใหม่อย่างน้อย 5 ตัวอักษร' });
      return;
    }
    const out = await updateStatus(id, 'reviewing', { reopenReason });
    if (!out) return;
    addActivity && addActivity({ icon: '↺', text: `ทบทวนการจอง ${id}: ${reopenReason.slice(0, 60)}`, type: 'booking' });
    setToast && setToast({ kind: 'info', message: `ส่งกลับไปตรวจสอบใหม่แล้ว${bookingNotifyText(out)}` });
    setActionReason('');
    setConfirmAction(null);
  };

  const statusMap = {
    pending:   { label: 'รอตรวจสอบ', color: 'warning' },
    reviewing: { label: 'กำลังตรวจ', color: 'info' },
    approved:  { label: 'อนุมัติแล้ว', color: 'success' },
    rejected:  { label: 'ปฏิเสธ',     color: 'danger' },
    completed: { label: 'เสร็จสิ้น',   color: 'neutral' },
    cancelled: { label: 'ยกเลิก',     color: 'neutral' },
  };
  const depositStatusLabel = (s) => ({
    pending_review: 'รอตรวจสลิป',
    verified: 'ยืนยันแล้ว',
    rejected: 'สลิปไม่ผ่าน',
    awaiting_slip: 'รอสลิป',
    manual_review: 'ตรวจด้วยมือ',
    not_required: 'ไม่ต้องมัดจำ',
  })[s] || s || '—';

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
            {b.applicantRisk && (
              <div style={{ fontSize: 11, color: C.warning || '#b45309', marginTop: 2 }}>
                เบอร์นี้มีผู้เช่า active อยู่แล้ว
              </div>
            )}
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
      key: 'deposit', label: 'ค่าจอง', align: 'right', minWidth: 120,
      render: b => (
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontWeight: 600 }}>{fmtCurrency(b.bookingFee ?? b.deposit)}</div>
          <div style={{ fontSize: 11, color: C.muted }}>
            {depositStatusLabel(b.depositStatus)}{b.bookingFeeAppliesToDeposit ? ' · หักมัดจำ' : ''}
          </div>
        </div>
      ),
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
        onRowClick={openBookingDetail}
        empty={<EmptyState icon="📋" title="ไม่มีการจอง" description="เมื่อมีการจองใหม่จะแสดงที่นี่" />}
      />

      <Drawer
        open={!!active}
        onClose={() => { setActiveId(null); setDetailLoadingId(null); }}
        title={active ? `การจอง ${active.id}${detailLoadingId === active.id ? ' · กำลังโหลดสถานะล่าสุด' : ''}` : ''}
        width={560}
        footer={active && (
          <>
            <Btn variant="ghost" onClick={() => setActiveId(null)}>ปิด</Btn>
            {(active.status === 'pending' || active.status === 'reviewing') && (
              <>
                <Btn variant="secondary" icon="🔍" onClick={async () => {
                  if (active.status === 'pending') {
                    const out = await updateStatus(active.id, 'reviewing');
                    if (!out) return;
                    addActivity && addActivity({ icon: '🔍', text: `เริ่มตรวจสอบการจอง ${active.id}`, type: 'booking' });
                    setToast && setToast({ kind: 'info', message: `เปลี่ยนเป็นกำลังตรวจสอบ${bookingNotifyText(out)}` });
                  }
                }} disabled={active.status === 'reviewing'}>
                  {active.status === 'reviewing' ? 'กำลังตรวจสอบ' : 'เริ่มตรวจสอบ'}
                </Btn>
                <Btn variant="danger" icon="✗" onClick={() => {
                  setActionReason('');
                  setConfirmAction({ id: active.id, type: 'reject' });
                }}>
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
                  const out = await updateStatus(active.id, 'cancelled');
                  if (!out) return;
                  addActivity && addActivity({ icon: '↺', text: `ยกเลิกอนุมัติการจอง ${active.id}`, type: 'booking' });
                  setToast && setToast({
                    kind: 'info',
                    message: out.releasedRoomId
                      ? `ยกเลิกการจองและปล่อยห้อง ${out.releasedRoomId} แล้ว${out.releasedTenant ? ' — เคลียร์ผู้เช่าที่ผูกจาก booking แล้ว' : ''}${bookingNotifyText(out)}`
                      : `ยกเลิกการจองแล้ว${bookingNotifyText(out)}`,
                  });
                  setActiveId(null);
                }}>ยกเลิก/ปล่อยห้อง</Btn>
              </>
            )}
            {active.status === 'rejected' && (
              <Btn variant="ghost" onClick={() => {
                setActionReason('');
                setConfirmAction({ id: active.id, type: 'reopen' });
              }}>↺ ทบทวนใหม่</Btn>
            )}
          </>
        )}
      >
        {active && <BookingDetail b={active} />}
      </Drawer>

      <Modal
        open={!!confirmAction}
        onClose={() => { setConfirmAction(null); setActionReason(''); }}
        title={confirmAction?.type === 'approve'
          ? 'ยืนยันการอนุมัติ'
          : confirmAction?.type === 'reopen'
            ? 'ยืนยันการทบทวนใหม่'
            : 'ยืนยันการปฏิเสธ'}
        footer={
          <>
            <Btn variant="ghost" onClick={() => { setConfirmAction(null); setActionReason(''); }}>ยกเลิก</Btn>
            {confirmAction?.type === 'approve'
              ? <Btn variant="success" onClick={() => handleApprove(confirmAction.id)}>อนุมัติ</Btn>
              : confirmAction?.type === 'reopen'
                ? <Btn variant="secondary" onClick={() => handleReopen(confirmAction.id)}
                    disabled={actionReason.trim().length < 5}>ส่งกลับไปตรวจสอบ</Btn>
                : <Btn variant="danger" onClick={() => handleReject(confirmAction.id)}
                    disabled={actionReason.trim().length < 5}>ปฏิเสธการจอง</Btn>}
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
          const isReopen = confirmAction?.type === 'reopen';
          const isReject = confirmAction?.type === 'reject';
          return (
            <div style={{ fontSize: 14, color: C.ink2, lineHeight: 1.7 }}>
              <div style={{ marginBottom: 12 }}>
                {isApprove ? 'อนุมัติการจอง:' : isReopen ? 'ทบทวนการจองใหม่:' : 'ปฏิเสธการจอง:'}
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

              {(isReopen || isReject) ? (
                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: 'block', fontSize: 12, color: C.muted, marginBottom: 4 }}>
                    {isReject ? 'เหตุผลที่แจ้งผู้จอง' : 'เหตุผลที่นำกลับมาตรวจใหม่'}
                  </label>
                  <textarea rows={3} maxLength={500}
                    value={actionReason}
                    onChange={(e) => setActionReason(e.target.value)}
                    placeholder={isReject
                      ? 'เช่น ห้องที่เลือกไม่ว่างแล้ว, เอกสาร/สลิปไม่ครบ, ข้อมูลไม่ตรงเงื่อนไข'
                      : 'เช่น ผู้จองส่งเอกสารเพิ่มแล้ว, ตรวจข้อมูลซ้ำพบว่าถูกต้อง'}
                    style={{
                      width: '100%', padding: '8px 10px', border: `1px solid ${C.border}`,
                      borderRadius: 6, fontSize: 13, fontFamily: 'inherit',
                      boxSizing: 'border-box', resize: 'vertical',
                    }} />
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
                    {isReject
                      ? 'เหตุผลนี้จะถูกส่งให้ผู้จองถ้ามีช่องทางแจ้งอัตโนมัติ และใช้เป็นข้อความอ้างอิงตอนโทรแจ้ง'
                      : 'ระบบจะบันทึกเหตุผลนี้ในรายการจองและ audit log'}
                  </div>
                </div>
              ) : null}

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
                    2) ผู้จองจะได้รับแจ้งเตือนทาง LINE/อีเมล/SMS ถ้าส่งอัตโนมัติได้; ถ้าไม่ได้ ระบบจะแจ้งให้แอดมินโทรเอง<br/>
                    3) <b style={{ color: C.warning || C.warning }}>ขั้นต่อไป:</b> ตรวจเบอร์ผู้เช่า + ผูก LINE ที่หน้า "ผู้เช่า" — ผู้เช่า login portal ด้วยเบอร์ที่ผูกกับห้อง
                  </>
                ) : isReopen ? (
                  <>
                    1) สถานะการจองจะกลับเป็น "กำลังตรวจ" เพื่อให้ตรวจเอกสารและตัดสินใจใหม่<br/>
                    2) เหตุผลจะถูกเก็บไว้ในรายการจองและ audit log เพื่อย้อนตรวจสอบภายหลัง
                  </>
                ) : (
                  <>
                    1) สถานะการจองจะเปลี่ยนเป็น "ปฏิเสธ" — กดดู/เปลี่ยนกลับได้ในแท็บ "ปฏิเสธ"<br/>
                    2) ผู้จองจะได้รับ LINE/อีเมล/SMS แจ้ง "ขออภัย — ไม่ได้รับการอนุมัติ" พร้อมเหตุผลด้านบนถ้าส่งอัตโนมัติได้; ถ้าไม่ได้ toast จะแจ้งให้โทรเอง
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
  const depositStatusLabel = (s) => ({
    pending_review: 'รอตรวจสลิปค่าจอง',
    verified: 'ยืนยันสลิปแล้ว',
    rejected: 'สลิปไม่ผ่าน',
    awaiting_slip: 'รอสลิป',
    manual_review: 'ตรวจด้วยมือ',
    not_required: 'ไม่ต้องมัดจำ',
  })[s] || s || '—';
  const applicantRisk = b.applicantRisk || (
    Array.isArray(b.riskFlags) && b.riskFlags.includes('APPLICANT_PHONE_ALREADY_ACTIVE_TENANT')
      ? { message: 'เบอร์นี้มีผู้เช่า active อยู่แล้ว', nextAction: 'โทรยืนยันตัวตนก่อนอนุมัติ' }
      : null
  );

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

      {applicantRisk && (
        <div style={{
          padding: '10px 12px',
          border: `1px solid ${(C.warning || '#d97706')}55`,
          borderLeft: `3px solid ${C.warning || '#d97706'}`,
          borderRadius: 8,
          background: C.warningSoft || '#fff7ed',
          color: C.ink2,
          fontSize: 12.5,
          lineHeight: 1.6,
        }}>
          <div style={{ fontWeight: 700, color: C.warningInk || C.ink, marginBottom: 4 }}>
            ต้องตรวจสอบผู้จองก่อนอนุมัติ
          </div>
          <div>{applicantRisk.message || 'เบอร์นี้มีผู้เช่า active อยู่แล้ว'}</div>
          <div style={{ marginTop: 2, color: C.muted }}>
            {applicantRisk.nextAction || 'ถ้าจองให้เพื่อน ให้เพื่อนใช้ LINE/เบอร์ของตัวเอง; ถ้าจองอีกห้อง ให้แอดมินตรวจสอบก่อนสร้างสัญญา'}
          </div>
        </div>
      )}

      <BookingFlowChecklist b={b} depositStatusLabel={depositStatusLabel} />

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
            { label: 'ค่าจอง',      value: fmtCurrency(b.bookingFee ?? b.deposit ?? 0), bold: true },
            { label: 'นโยบายค่าจอง', value: b.bookingFeeAppliesToDeposit ? 'นำไปหัก/นับรวมกับเงินมัดจำสัญญา' : 'แยกจากเงินมัดจำสัญญา' },
            ...(b.depositCreditAmount ? [{ label: 'เครดิตมัดจำจากค่าจอง', value: fmtCurrency(b.depositCreditAmount) }] : []),
            ...(b.depositBalanceDue != null ? [{ label: 'เงินมัดจำคงเหลือที่ต้องเก็บ', value: fmtCurrency(b.depositBalanceDue) }] : []),
            { label: 'สถานะสลิปค่าจอง', value: depositStatusLabel(b.depositStatus) },
            ...(b.depositVerifyProvider ? [{ label: 'ตรวจสลิปโดย', value: b.depositVerifyProvider }] : []),
            ...(b.depositVerifyCode ? [{ label: 'รหัสผลตรวจสลิป', value: b.depositVerifyCode }] : []),
            ...(b.depositTransactionRef ? [{ label: 'เลขอ้างอิงรายการโอน', value: b.depositTransactionRef }] : []),
            ...(b.depositVerifyReason ? [{ label: 'หมายเหตุผลตรวจ', value: b.depositVerifyReason }] : []),
            ...(b.depositSlipUrl ? [{ label: 'สลิปค่าจอง', value: <a href={b.depositSlipUrl} target="_blank" rel="noopener noreferrer" style={{ color: C.accent }}>เปิดดูสลิป</a> }] : []),
            ...(b.reservedAt ? [{ label: 'ล็อกห้องเมื่อ', value: relTime(b.reservedAt) }] : []),
            ...(b.holdExpiresAt ? [{ label: 'hold เดิมหมดอายุ', value: fmtDateTH(String(b.holdExpiresAt).slice(0, 10)) }] : []),
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

function BookingFlowChecklist({ b, depositStatusLabel }) {
  const C = window.ADMIN_C;
  const status = String(b.status || 'pending');
  const lineBinding = b.lineBinding || b.line_binding || null;
  const depositStatus = String(b.depositStatus || (b.depositRequired ? 'awaiting_slip' : 'not_required'));
  const depositRequired = !!b.depositRequired || Number(b.bookingFee ?? b.deposit ?? 0) > 0;
  const depositDone = !depositRequired || ['verified', 'not_required'].includes(depositStatus);
  const depositWarn = depositRequired && ['pending_review', 'manual_review'].includes(depositStatus);
  const lineCount = Number(lineBinding && (lineBinding.boundCount || lineBinding.bound_count || lineBinding.lineRecipientCount || 0));
  const lineStatus = String((lineBinding && lineBinding.status) || '').toLowerCase();
  const lineExpiresAt = lineBinding && (lineBinding.expiresAt || lineBinding.expires_at);
  const lineExpiresAtMs = lineExpiresAt ? Date.parse(lineExpiresAt) : NaN;
  const lineExpired = !!(lineBinding && (
    lineBinding.expired ||
    lineStatus === 'expired' ||
    (Number.isFinite(lineExpiresAtMs) && lineExpiresAtMs <= Date.now() && lineCount <= 0)
  ));
  const lineFailed = !!(lineBinding && (lineBinding.error || lineStatus === 'error'));
  const lineLookupError = !!(lineBinding && lineBinding.lookupError);
  const lineNeedsReissue = !!(lineBinding && lineBinding.needsReissue) || lineExpired || ['revoked', 'blocked'].includes(lineStatus);
  const lineIssued = !!(lineBinding && lineBinding.code) && !lineNeedsReissue;
  const linePending = lineStatus === 'pending' || lineIssued;
  const lineStepState = lineCount > 0 ? 'done' : (lineFailed || lineLookupError || lineNeedsReissue || linePending ? 'warn' : 'wait');
  const assignedRoom = b.assignedRoomId || b.roomId || null;

  const tone = {
    done: { bg: C.successSoft || '#e6f4ec', fg: C.success || '#2f8f5b', border: C.success || '#2f8f5b', label: 'เสร็จแล้ว' },
    warn: { bg: C.warningSoft || '#fff7ed', fg: C.warning || '#b45309', border: C.warning || '#b45309', label: 'ต้องติดตาม' },
    wait: { bg: C.surfaceAlt || '#f7faf8', fg: C.muted || '#6b7280', border: C.border || '#dfe9e2', label: 'รอดำเนินการ' },
    stop: { bg: C.dangerSoft || '#fef2f2', fg: C.danger || '#b91c1c', border: C.danger || '#b91c1c', label: 'หยุด flow' },
  };
  const stepTone = (state) => tone[state] || tone.wait;
  const terminal = ['rejected', 'cancelled'].includes(status);
  const completed = status === 'completed';
  const approved = status === 'approved';
  const reviewing = status === 'reviewing';

  const steps = [
    {
      title: 'รับคำขอจอง',
      state: 'done',
      detail: `รหัส ${b.id || '-'} · ผู้จอง ${b.name || '-'} · โทร ${b.phone || '-'}`,
    },
    {
      title: 'ค่าจอง/เอกสาร',
      state: depositDone ? 'done' : (depositWarn ? 'warn' : 'stop'),
      detail: depositRequired
        ? `${depositStatusLabel(depositStatus)}${b.depositVerifyReason ? ` · ${b.depositVerifyReason}` : ''}`
        : 'ไม่ต้องเก็บค่าจองสำหรับคำขอนี้',
    },
    {
      title: 'LINE ผู้รับแจ้งเตือน',
      state: lineStepState,
      detail: lineCount > 0
        ? `ผูกแล้ว ${lineCount} บัญชี ทุกบัญชีจะได้รับผลจอง สัญญา และบิลของห้องนี้`
        : lineLookupError
          ? 'อ่านสถานะ LINE ล่าสุดไม่ได้ ให้ refresh หรือเปิดหน้า LINE Binding เพื่อตรวจสอบก่อนแจ้งผลจอง'
          : lineFailed
            ? `ออกคีย์ LINE ไม่สำเร็จ: ${lineBinding.error || '-'} · ต้องออกคีย์ใหม่หรือโทรแจ้งโดยตรง`
            : lineNeedsReissue
              ? 'คีย์ LINE หมดอายุ/ถูกยกเลิก หรือยังไม่มีคีย์ที่ใช้ได้ ต้องออกคีย์ใหม่ก่อนหวังผลแจ้งเตือนอัตโนมัติ'
              : linePending
                ? 'ออกคีย์ให้ผู้จองแล้ว แต่ยังไม่ถือว่าผูกสำเร็จจนกว่าผู้จองจะส่งคีย์ใน LINE OA; ถ้าจองให้เพื่อน ให้เพื่อนใช้ LINE ของตัวเอง'
                : 'ยังไม่พบคีย์ LINE ในคำขอนี้ ถ้าต้องการแจ้งอัตโนมัติให้ออกคีย์จากหน้า LINE Binding',
    },
    {
      title: 'ตัดสินใจการจอง',
      state: terminal ? 'stop' : (approved || completed ? 'done' : (reviewing ? 'warn' : 'wait')),
      detail: terminal
        ? `จบ flow ที่สถานะ ${status === 'rejected' ? 'ปฏิเสธ' : 'ยกเลิก'}${b.adminNotes ? ` · ${b.adminNotes}` : ''}`
        : approved || completed
          ? `อนุมัติแล้ว${assignedRoom ? ` · ห้อง ${assignedRoom}` : ''}`
          : reviewing
            ? 'กำลังตรวจสอบ ต้องอนุมัติหรือปฏิเสธพร้อมเหตุผล'
            : 'รอตรวจสอบ กดเริ่มตรวจสอบหรืออนุมัติเมื่อข้อมูลครบ',
    },
    {
      title: 'สัญญาและบิล',
      state: completed ? 'done' : (approved ? 'warn' : 'wait'),
      detail: completed
        ? 'ส่งต่อไปขั้นสัญญาแล้ว ตรวจสัญญา/เช็คอิน/บิลเดือนแรกต่อ'
        : approved
          ? 'ขั้นต่อไปคือสร้างสัญญาจาก booking เดิม แล้วส่งลิงก์ให้ผู้เช่า'
          : 'จะเริ่มได้หลังอนุมัติและกำหนดห้องแล้ว',
    },
  ];

  const nextAction = terminal
    ? 'ไม่ต้องสร้างสัญญาจากรายการนี้ เว้นแต่เปิดกลับมาตรวจใหม่'
    : completed
      ? 'ตรวจว่าสัญญาถูกส่ง/อนุมัติ และบิลเดือนแรกถูกออกครบ'
      : approved
        ? 'เปิดหน้า ผู้เช่า/สัญญา แล้วสร้างสัญญาจาก booking เดิม'
        : reviewing
          ? 'ตรวจค่าจอง เอกสาร และความเสี่ยงก่อนอนุมัติหรือปฏิเสธ'
          : 'เริ่มตรวจสอบคำขอ แล้วแจ้งผลให้ผู้จอง';

  return (
    <div style={{
      padding: 14,
      background: C.bg || '#fff',
      border: `1px solid ${C.border}`,
      borderRadius: 10,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>
        Flow การจองจนถึงสัญญา
      </div>
      <div style={{
        display: 'grid',
        gap: 8,
      }}>
        {steps.map((step, idx) => {
          const s = stepTone(step.state);
          return (
            <div key={step.title} style={{
              display: 'grid',
              gridTemplateColumns: '28px 1fr auto',
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

window.PageBookings = PageBookings;
