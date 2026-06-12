// === admin/page-parcels.jsx ==============================================
// Parcel arrival workflow: admin records parcel, tenant gets notified, and
// both sides can see pickup status.
// =========================================================================

const { useState, useEffect, useMemo } = React;

const PARCEL_STATUS_LABEL = {
  waiting_pickup: 'รอผู้เช่ารับ',
  picked_up: 'รับแล้ว',
  returned: 'คืนผู้ส่ง',
  cancelled: 'ยกเลิก',
};
const PARCEL_STATUS_TONE = {
  waiting_pickup: 'warning',
  picked_up: 'success',
  returned: 'neutral',
  cancelled: 'danger',
};
const PARCEL_NOTIFY_LABEL = {
  sent: 'ส่งแล้ว',
  queued: 'เข้าคิวส่ง',
  failed: 'ส่งไม่สำเร็จ',
  disabled: 'ปิดช่องทาง',
  skipped: 'ไม่ได้ส่ง',
};

function PageParcels({ setToast }) {
  const C = window.ADMIN_C;
  const { Card, Btn, Pill, PageContainer, PageHeader, EmptyState } = window;
  const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState('waiting_pickup');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [featureDisabled, setFeatureDisabled] = useState(false);
  const [form, setForm] = useState(null);

  function textFromError(e, fallback) {
    const raw = e && (e.error || e.message || e.hint) || fallback;
    return window.humanizeAdminErrorText ? window.humanizeAdminErrorText(raw, e || {}) : raw;
  }

  function toastNotice(notice, fallback) {
    const n = notice || {};
    const message = n.title && n.message ? `${n.title}: ${n.message}` : (n.message || n.title || fallback);
    setToast && setToast({ kind: n.kind || 'success', message });
  }

  async function load() {
    setLoading(true);
    setErr('');
    try {
      const params = new URLSearchParams();
      if (status && status !== 'all') params.set('status', status);
      if (q.trim()) params.set('q', q.trim());
      const d = await apiCall('/api/parcels' + (params.toString() ? '?' + params.toString() : ''), { timeoutMs: 12000 });
      setFeatureDisabled(false);
      setItems(Array.isArray(d.parcels) ? d.parcels : []);
    } catch (e) {
      if (e && e.code === 'FEATURE_DISABLED') setFeatureDisabled(true);
      setErr(textFromError(e, 'โหลดรายการพัสดุไม่สำเร็จ'));
      if (window.toastError) window.toastError(setToast, e, { action: 'โหลดรายการพัสดุ' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = setTimeout(load, q.trim() ? 300 : 0);
    return () => clearTimeout(timer);
  }, [status, q]);

  const stats = useMemo(() => ({
    total: items.length,
    waiting: items.filter((x) => x.status === 'waiting_pickup').length,
    closed: items.filter((x) => x.status !== 'waiting_pickup').length,
  }), [items]);

  async function save(payload) {
    if (busy) return;
    setBusy(true);
    try {
      const isUpdate = !!payload.id;
      const d = await apiCall(isUpdate ? `/api/parcels/${payload.id}` : '/api/parcels', {
        method: isUpdate ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
        timeoutMs: 15000,
      });
      setForm(null);
      toastNotice(d.notice, isUpdate ? 'บันทึกพัสดุแล้ว' : 'เพิ่มพัสดุแล้ว');
      await load();
    } catch (e) {
      window.toastError
        ? window.toastError(setToast, e, { action: payload.id ? 'บันทึกพัสดุ' : 'เพิ่มพัสดุ' })
        : setToast && setToast({ kind: 'danger', message: textFromError(e, 'บันทึกพัสดุไม่สำเร็จ') });
    } finally {
      setBusy(false);
    }
  }

  async function updateStatus(item, nextStatus) {
    if (!item || item.status !== 'waiting_pickup') return;
    const label = PARCEL_STATUS_LABEL[nextStatus] || nextStatus;
    const lines = [
      `เปลี่ยนสถานะพัสดุ ${item.parcel_no || item.parcelNo || item.id} เป็น "${label}"?`,
      '',
      `ห้อง: ${item.room_id || item.roomId || '-'}`,
      item.tracking_no || item.trackingNo ? `เลขพัสดุ: ${item.tracking_no || item.trackingNo}` : null,
      '',
      nextStatus === 'picked_up'
        ? 'เมื่อบันทึกรับแล้ว ระบบจะไม่อนุญาตให้ส่งแจ้งเตือนซ้ำเพื่อลดความสับสนของผู้เช่า'
        : 'รายการที่ปิดแล้วจะไม่สามารถเปลี่ยนสถานะกลับเป็นรอรับได้',
    ].filter(Boolean);
    if (!window.confirm(lines.join('\n'))) return;
    setBusy(true);
    try {
      const d = await apiCall(`/api/parcels/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: nextStatus }),
        timeoutMs: 12000,
      });
      setItems((prev) => prev.map((x) => x.id === item.id ? d.parcel : x));
      setToast && setToast({ kind: 'success', message: `อัปเดตเป็น "${label}" แล้ว` });
    } catch (e) {
      window.toastError
        ? window.toastError(setToast, e, { action: 'เปลี่ยนสถานะพัสดุ' })
        : setToast && setToast({ kind: 'danger', message: textFromError(e, 'เปลี่ยนสถานะไม่สำเร็จ') });
    } finally {
      setBusy(false);
    }
  }

  async function notify(item) {
    if (!item || item.status !== 'waiting_pickup') return;
    setBusy(true);
    try {
      const d = await apiCall(`/api/parcels/${item.id}/notify`, {
        method: 'POST',
        body: JSON.stringify({}),
        timeoutMs: 15000,
      });
      setItems((prev) => prev.map((x) => x.id === item.id ? d.parcel : x));
      toastNotice(d.notice, 'ส่งแจ้งเตือนแล้ว');
    } catch (e) {
      window.toastError
        ? window.toastError(setToast, e, { action: 'ส่งแจ้งเตือนพัสดุ' })
        : setToast && setToast({ kind: 'danger', message: textFromError(e, 'ส่งแจ้งเตือนไม่สำเร็จ') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="พัสดุ"
        subtitle={`ทั้งหมด ${stats.total} รายการ · รอรับ ${stats.waiting} · ปิดงาน ${stats.closed}`}
        actions={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn variant="secondary" onClick={load} disabled={loading || busy}>รีเฟรช</Btn>
            <Btn variant="primary" icon="+" onClick={() => setForm({ notify: true })} disabled={featureDisabled || busy}>
              เพิ่มพัสดุ
            </Btn>
          </div>
        }
      />

      {featureDisabled ? (
        <Card style={{
          background: C.warningSoft, color: C.warningInk,
          border: '1px solid ' + C.warning,
          display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap',
        }}>
          <div>
            <div style={{ fontWeight: 700 }}>ฟีเจอร์แจ้งเตือนพัสดุยังปิดอยู่</div>
            <div style={{ marginTop: 4, fontSize: 13, lineHeight: 1.5 }}>
              หน้านี้จะไม่สร้างหรือส่งแจ้งเตือนพัสดุจนกว่าจะเปิด `parcelNotifications`
              และฝั่งผู้เช่าจะไม่เห็นปุ่มพัสดุเมื่อปิดฟีเจอร์
            </div>
          </div>
          <Btn variant="secondary" onClick={() => { window.location.hash = '#features'; }}>
            ไปเปิดใน Features
          </Btn>
        </Card>
      ) : null}

      <Card>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ค้นหาเลขพัสดุ, ห้อง, ผู้รับ, ขนส่ง..."
            style={{
              flex: '1 1 260px', minWidth: 220,
              height: 38, padding: '0 12px', borderRadius: 8,
              border: '1px solid ' + C.border, background: C.surfaceAlt,
              color: C.ink, fontFamily: 'inherit', fontSize: 13.5,
            }}
          />
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{
            height: 38, padding: '0 10px', borderRadius: 8,
            border: '1px solid ' + C.border, background: C.surface, color: C.ink,
            fontFamily: 'inherit', fontSize: 13.5,
          }}>
            <option value="waiting_pickup">รอผู้เช่ารับ</option>
            <option value="picked_up">รับแล้ว</option>
            <option value="returned">คืนผู้ส่ง</option>
            <option value="cancelled">ยกเลิก</option>
            <option value="all">ทั้งหมด</option>
          </select>
        </div>

        {err && !featureDisabled ? (
          <div style={{
            padding: 14, borderRadius: 8, marginBottom: 12,
            background: C.dangerSoft, color: C.dangerInk || C.danger,
            display: 'flex', gap: 12, justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>{err}</span>
            <Btn size="sm" variant="secondary" onClick={load}>ลองใหม่</Btn>
          </div>
        ) : null}

        {loading && items.length === 0 ? (
          <div role="status" style={{
            padding: 32, textAlign: 'center', color: C.muted,
            border: '1px dashed ' + C.borderStrong, borderRadius: 10,
          }}>กำลังโหลดรายการพัสดุ...</div>
        ) : items.length === 0 ? (
          <EmptyState
            icon="📦"
            title="ยังไม่มีรายการพัสดุ"
            description={featureDisabled ? 'เปิดฟีเจอร์ก่อนเพิ่มรายการพัสดุ' : 'กดเพิ่มพัสดุเมื่อมีของมาถึง แล้วระบบจะแจ้งผู้เช่าตามช่องทางที่ตั้งไว้'}
          />
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {items.map((item) => (
              <ParcelRow
                key={item.id}
                item={item}
                busy={busy}
                onEdit={() => setForm(item)}
                onNotify={() => notify(item)}
                onPicked={() => updateStatus(item, 'picked_up')}
                onReturned={() => updateStatus(item, 'returned')}
                onCancelled={() => updateStatus(item, 'cancelled')}
              />
            ))}
          </div>
        )}
      </Card>

      {form ? (
        <ParcelForm
          initial={form}
          busy={busy}
          onCancel={() => setForm(null)}
          onSave={save}
        />
      ) : null}
    </PageContainer>
  );
}

function ParcelRow({ item, busy, onEdit, onNotify, onPicked, onReturned, onCancelled }) {
  const C = window.ADMIN_C;
  const { Btn, Pill } = window;
  const status = item.status || 'waiting_pickup';
  const canAct = status === 'waiting_pickup';
  const roomId = item.room_id || item.roomId || '-';
  const tenantName = item.tenant_name || item.recipient_name || item.recipientName || '-';
  const tracking = item.tracking_no || item.trackingNo || '';
  const notifyStatus = item.last_notify_status || item.lastNotifyStatus || '';
  const created = item.created_at || item.createdAt;
  return (
    <div style={{
      border: '1px solid ' + C.border, borderRadius: 10,
      padding: 14, background: C.surface,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      gap: 12, flexWrap: 'wrap',
    }}>
      <div style={{ minWidth: 0, flex: '1 1 300px' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>{item.parcel_no || item.parcelNo}</span>
          <Pill color={PARCEL_STATUS_TONE[status] || 'neutral'} size="sm">
            {PARCEL_STATUS_LABEL[status] || status}
          </Pill>
          {notifyStatus ? (
            <Pill color={notifyStatus === 'sent' ? 'success' : notifyStatus === 'queued' ? 'warning' : 'neutral'} size="sm">
              แจ้งเตือน: {PARCEL_NOTIFY_LABEL[notifyStatus] || notifyStatus}
            </Pill>
          ) : null}
        </div>
        <div style={{ color: C.ink2, fontSize: 13.5, lineHeight: 1.6 }}>
          <b>ห้อง {roomId}</b> · ผู้รับ {tenantName}
          {item.carrier ? ` · ${item.carrier}` : ''}
          {tracking ? ` · ${tracking}` : ''}
        </div>
        <div style={{ color: C.muted, fontSize: 12.5, marginTop: 4, lineHeight: 1.5 }}>
          {item.shelf_location || item.shelfLocation ? `จุดรับ: ${item.shelf_location || item.shelfLocation}` : 'ยังไม่ระบุจุดรับ'}
          {item.note ? ` · หมายเหตุ: ${item.note}` : ''}
          {created ? ` · บันทึกเมื่อ ${new Date(created).toLocaleString('th-TH')}` : ''}
        </div>
        {item.last_notify_error || item.lastNotifyError ? (
          <div style={{ marginTop: 6, color: C.warningInk || C.warning, fontSize: 12.5 }}>
            แจ้งเตือนล่าสุด: {item.last_notify_error || item.lastNotifyError}
          </div>
        ) : null}
      </div>
      <div style={{
        display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end',
        flexWrap: 'wrap', flex: '1 1 220px',
      }}>
        <Btn size="sm" variant="ghost" onClick={onEdit} disabled={busy}>แก้ไข</Btn>
        <Btn size="sm" variant="secondary" onClick={onNotify} disabled={busy || !canAct}>ส่งแจ้งซ้ำ</Btn>
        <Btn size="sm" variant="primary" onClick={onPicked} disabled={busy || !canAct}>รับแล้ว</Btn>
        <Btn size="sm" variant="ghost" onClick={onReturned} disabled={busy || !canAct}>คืนผู้ส่ง</Btn>
        <Btn size="sm" variant="danger" onClick={onCancelled} disabled={busy || !canAct}>ยกเลิก</Btn>
      </div>
    </div>
  );
}

function ParcelForm({ initial, busy, onCancel, onSave }) {
  const C = window.ADMIN_C;
  const { Modal, Btn } = window;
  const isUpdate = !!initial.id;
  const [form, setForm] = useState({
    roomId: initial.room_id || initial.roomId || '',
    recipientName: initial.recipient_name || initial.recipientName || '',
    carrier: initial.carrier || '',
    trackingNo: initial.tracking_no || initial.trackingNo || '',
    shelfLocation: initial.shelf_location || initial.shelfLocation || '',
    note: initial.note || '',
    notify: initial.notify !== false,
  });
  const lbl = { display: 'block', fontSize: 12.5, color: C.muted, margin: '10px 0 4px' };
  const inp = {
    width: '100%', padding: '9px 10px', borderRadius: 7,
    border: '1px solid ' + C.border, background: C.surfaceAlt,
    color: C.ink, fontFamily: 'inherit', fontSize: 13.5,
    boxSizing: 'border-box',
  };

  function submit(e) {
    e.preventDefault();
    if (!isUpdate && !form.roomId.trim()) {
      alert('กรุณาระบุห้องที่รับพัสดุ');
      return;
    }
    const base = {
      recipientName: form.recipientName.trim() || undefined,
      carrier: form.carrier.trim() || undefined,
      trackingNo: form.trackingNo.trim() || undefined,
      shelfLocation: form.shelfLocation.trim() || undefined,
      note: form.note.trim() || undefined,
    };
    onSave(isUpdate
      ? { id: initial.id, ...base }
      : { roomId: form.roomId.trim(), ...base, notify: form.notify });
  }

  return (
    <Modal open={true} onClose={onCancel} title={isUpdate ? 'แก้ไขพัสดุ' : 'เพิ่มพัสดุ'} width={560}>
      <form onSubmit={submit}>
        {!isUpdate ? (
          <React.Fragment>
            <label style={lbl}>ห้อง</label>
            <input value={form.roomId} onChange={(e) => setForm({ ...form, roomId: e.target.value })}
              maxLength={32} required placeholder="เช่น 101" style={inp} />
            <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>
              ระบบจะตรวจว่าห้องนี้มีผู้เช่า active แค่ 1 รายก่อนบันทึก เพื่อกันส่งแจ้งผิดห้อง
            </div>
          </React.Fragment>
        ) : (
          <div style={{
            padding: 10, borderRadius: 8, background: C.surfaceAlt,
            color: C.ink2, fontSize: 13, marginBottom: 4,
          }}>
            ห้อง {initial.room_id || initial.roomId || '-'} · {initial.parcel_no || initial.parcelNo || ''}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={lbl}>ชื่อผู้รับ (ถ้ามี)</label>
            <input value={form.recipientName} onChange={(e) => setForm({ ...form, recipientName: e.target.value })}
              maxLength={120} placeholder="เว้นว่าง = ใช้ชื่อผู้เช่าปัจจุบัน" style={inp} />
          </div>
          <div>
            <label style={lbl}>ขนส่ง</label>
            <input value={form.carrier} onChange={(e) => setForm({ ...form, carrier: e.target.value })}
              maxLength={80} placeholder="Kerry / Flash / ไปรษณีย์" style={inp} />
          </div>
        </div>

        <label style={lbl}>เลขพัสดุ</label>
        <input value={form.trackingNo} onChange={(e) => setForm({ ...form, trackingNo: e.target.value })}
          maxLength={120} placeholder="ใส่เพื่อให้ค้นหาย้อนหลังได้ง่าย" style={inp} />

        <label style={lbl}>จุดรับ / ชั้นวาง</label>
        <input value={form.shelfLocation} onChange={(e) => setForm({ ...form, shelfLocation: e.target.value })}
          maxLength={120} placeholder="เช่น ชั้น A-03 / เคาน์เตอร์หน้าออฟฟิศ" style={inp} />

        <label style={lbl}>หมายเหตุ</label>
        <textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })}
          maxLength={500} rows={3} style={{ ...inp, resize: 'vertical' }} />

        {!isUpdate ? (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, color: C.ink2, fontSize: 13 }}>
            <input type="checkbox" checked={form.notify}
              onChange={(e) => setForm({ ...form, notify: e.target.checked })} />
            ส่งแจ้งเตือนถึงผู้เช่าทันทีหลังบันทึก
          </label>
        ) : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <Btn variant="ghost" onClick={onCancel} type="button" disabled={busy}>ยกเลิก</Btn>
          <Btn variant="primary" type="submit" disabled={busy}>
            {busy ? 'กำลังบันทึก...' : 'บันทึก'}
          </Btn>
        </div>
      </form>
    </Modal>
  );
}

window.PageParcels = PageParcels;
