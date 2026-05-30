// === admin/page-recurring-charges.jsx =====================================
// Per-tenant or per-room recurring line items (parking, internet add-on,
// cleaning fee, etc.) that auto-merge into monthly bills when the
// recurringCharges feature flag is enabled.
//
// Fields:
//   tenant_id  - link to a specific tenant (charged regardless of room)
//   room_id    - link to a room (charged for whoever lives there)
//   label      - display text on the bill
//   amount     - THB
//   frequency  - 'monthly' | 'quarterly' | 'one_off'
//   active     - on/off; one_off auto-flips to inactive after first inclusion
// ===========================================================================

const { useState, useEffect, useMemo, useRef } = React;

function PageRecurringCharges({ setToast }) {
  const C = window.ADMIN_C;
  const { Card, Btn, Pill, PageContainer, PageHeader, SectionHeading, Modal,
          DataTable, EmptyState } = window;
  const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
  const recurringFlag = window.useFeatureFlag
    ? window.useFeatureFlag('recurringCharges')
    : { ready: true, enabled: true, flag: { autoIncludeOnBillGen: true } };
  const API_TIMEOUT_MS = 12000;

  const [items, setItems] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [tenantLoadWarning, setTenantLoadWarning] = useState('');
  const [roomLoadWarning, setRoomLoadWarning] = useState('');
  const [form, setForm] = useState(null);   // null = closed; object = editing/creating
  const [filter, setFilter] = useState('active');
  const loadSeqRef = useRef(0);

  function errorText(e, fallback) {
    if (e && e.code === 'TIMEOUT') return 'คำขอใช้เวลานานเกินกำหนด กรุณาลองใหม่';
    const raw = (e && (e.error || e.message)) || fallback;
    return window.humanizeAdminErrorText ? window.humanizeAdminErrorText(raw, e || {}) : raw;
  }

  async function load() {
    const seq = ++loadSeqRef.current;
    setBusy(true); setErr(''); setTenantLoadWarning(''); setRoomLoadWarning('');
    try {
      const params = new URLSearchParams();
      if (filter === 'active')   params.set('active', 'true');
      if (filter === 'inactive') params.set('active', 'false');
      const query = params.toString();
      const [chargesResult, tenantsResult, roomsResult] = await Promise.allSettled([
        apiCall('/api/recurring-charges' + (query ? '?' + query : ''), { timeoutMs: API_TIMEOUT_MS }),
        apiCall('/api/tenants?status=active', { timeoutMs: API_TIMEOUT_MS }),
        apiCall('/api/rooms', { timeoutMs: API_TIMEOUT_MS }),
      ]);
      if (seq !== loadSeqRef.current) return;

      if (chargesResult.status === 'rejected') throw chargesResult.reason;
      const chargePayload = chargesResult.value || {};
      setItems(Array.isArray(chargePayload.charges) ? chargePayload.charges : []);

      if (tenantsResult.status === 'fulfilled') {
        const tenantPayload = tenantsResult.value || {};
        setTenants(Array.isArray(tenantPayload.tenants) ? tenantPayload.tenants : []);
      } else {
        setTenants([]);
        setTenantLoadWarning(
          errorText(tenantsResult.reason, 'โหลดรายชื่อผู้เช่าไม่สำเร็จ') +
          ' — ยังดู/แก้รายการค่าใช้จ่ายได้ แต่การเลือกผู้เช่าจะไม่ครบจนกว่าจะรีเฟรช'
        );
      }

      if (roomsResult.status === 'fulfilled') {
        const roomPayload = roomsResult.value || {};
        setRooms(Array.isArray(roomPayload.rooms) ? roomPayload.rooms : []);
      } else {
        setRooms([]);
        setRoomLoadWarning(
          errorText(roomsResult.reason, 'โหลดรายชื่อห้องไม่สำเร็จ') +
          ' — ยังเพิ่มแบบพิมพ์เลขห้องเองได้ แต่ควรรีเฟรชเพื่อเลือกจากรายการจริง'
        );
      }
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      setErr(errorText(e, 'โหลดค่าใช้จ่ายประจำไม่สำเร็จ'));
      if (window.toastError) window.toastError(setToast, e, { action: 'โหลดค่าใช้จ่ายประจำ' });
    }
    finally {
      if (seq === loadSeqRef.current) setBusy(false);
    }
  }
  useEffect(() => { load(); }, [filter]);

  async function save(payload) {
    setBusy(true);
    try {
      const isUpdate = !!payload.id;
      const url = isUpdate ? `/api/recurring-charges/${payload.id}` : '/api/recurring-charges';
      await apiCall(url, {
        method: isUpdate ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
        timeoutMs: API_TIMEOUT_MS,
      });
      setToast && setToast({ kind: 'success', message: isUpdate ? 'อัปเดตแล้ว' : 'เพิ่มรายการแล้ว' });
      setForm(null);
      await load();
    } catch (e) {
      window.toastError
        ? window.toastError(setToast, e, { action: payload.id ? 'บันทึกค่าใช้จ่ายประจำ' : 'เพิ่มค่าใช้จ่ายประจำ' })
        : setToast && setToast({ kind: 'error', message: errorText(e, 'save failed') });
    } finally { setBusy(false); }
  }

  async function remove(item) {
    // Build a context-rich confirm so admin sees what they're about to drop:
    //   - the label (so they don't delete the wrong "ที่จอดรถ" row)
    //   - the binding (per-tenant vs per-room) so they understand scope
    //   - amount + frequency so they spot a "monthly 5,000" row that'll
    //     stop appearing on next month's bill
    // For one_off charges that may have already been billed, suggest
    // toggling active=false instead of delete to keep the audit trail.
    const id = typeof item === 'object' ? item.id : item;
    const it = items.find((x) => x.id === id) || (typeof item === 'object' ? item : null);
    if (!it) {
      setToast && setToast({ kind: 'danger', message: 'ไม่พบรายการที่จะลบ' });
      return;
    }
    const target = it.tenant_id ? `ผู้เช่า: ${tenantLabel(it.tenant_id)}`
      : it.room_id ? `ห้อง ${it.room_id}` : '—';
    const amt = Number(it.amount).toLocaleString('th-TH', { minimumFractionDigits: 2 });
    const isOneOff = it.frequency === 'one_off';
    const lines = [
      `ลบรายการ "${it.label}" (${amt} บาท · ${FREQ_LABEL[it.frequency] || it.frequency})?`,
      ``,
      `ผูกกับ: ${target}`,
      it.active ? '✅ ปัจจุบันเปิดอยู่ — จะหายจากการคำนวณบิลรอบถัดไป' : 'ℹ️ ปิดอยู่แล้ว',
      ``,
      isOneOff
        ? '⚠️ เป็นรายการ one_off — ถ้าใช้ในบิลที่ออกไปแล้ว แนะนำ "ปิดใช้งาน" แทน เพื่อเก็บ audit trail'
        : '⚠️ การลบเปลี่ยนแปลงถาวร — เก่าที่อยู่ในบิลที่ออกไปแล้วยังคงอยู่',
      '',
      'ดำเนินการต่อ?',
    ];
    if (!window.confirm(lines.join('\n'))) return;
    setBusy(true);
    try {
      await apiCall(`/api/recurring-charges/${id}`, { method: 'DELETE', timeoutMs: API_TIMEOUT_MS });
      setToast && setToast({ kind: 'success', message: `ลบ "${it.label}" แล้ว` });
      await load();
    } catch (e) {
      window.toastError
        ? window.toastError(setToast, e, { action: 'ลบรายการประจำ' })
        : setToast && setToast({ kind: 'danger', message: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(item) {
    await save({ id: item.id, active: !item.active });
  }

  const tenantById = useMemo(() => {
    const m = new Map();
    for (const t of tenants) m.set(Number(t.id), t);
    return m;
  }, [tenants]);

  const roomByCode = useMemo(() => {
    const m = new Map();
    for (const r of rooms) m.set(String(r.room_code || r.id || ''), r);
    return m;
  }, [rooms]);

  const tenantLabel = (id) => {
    const t = tenantById.get(Number(id));
    return t ? `${t.full_name} · ${t.phone}` : id ? `#${id}` : '—';
  };

  const roomLabel = (id) => {
    const key = id ? String(id) : '';
    const r = roomByCode.get(key);
    if (!r) return key ? `ห้อง ${key}` : '—';
    const statusText = {
      vacant: 'ว่าง',
      occupied: 'มีผู้เช่า',
      reserved: 'จองแล้ว',
      overdue: 'ค้างชำระ',
      maintenance: 'ซ่อมบำรุง',
    }[r.status] || r.status || '';
    return statusText ? `ห้อง ${key} · ${statusText}` : `ห้อง ${key}`;
  };

  const FREQ_LABEL = { monthly: 'รายเดือน', quarterly: 'รายไตรมาส', one_off: 'ครั้งเดียว' };

  const columns = [
    { key: 'label', label: 'รายการ', minWidth: 180,
      render: (it) => <span style={{ fontWeight: 600 }}>{it.label}</span> },
    { key: 'amount', label: 'จำนวน', align: 'right', minWidth: 100,
      render: (it) => Number(it.amount).toLocaleString('th-TH', { minimumFractionDigits: 2 }) },
    { key: 'frequency', label: 'รอบ', minWidth: 100,
      render: (it) => <Pill color="info" size="sm">{FREQ_LABEL[it.frequency] || it.frequency}</Pill> },
    { key: 'target', label: 'ผูกกับ', minWidth: 200,
      render: (it) => it.tenant_id ? `ผู้เช่า: ${tenantLabel(it.tenant_id)}`
        : it.room_id ? roomLabel(it.room_id) : '—' },
    { key: 'active', label: 'สถานะ', minWidth: 100,
      render: (it) => <Pill color={it.active ? 'success' : 'muted'} size="sm">
        {it.active ? 'เปิด' : 'ปิด'}</Pill> },
    { key: 'actions', label: '', align: 'right', minWidth: 180,
      render: (it) => (
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <Btn size="sm" variant="ghost" onClick={() => toggleActive(it)}>
            {it.active ? 'ปิด' : 'เปิด'}
          </Btn>
          <Btn size="sm" variant="ghost" onClick={() => setForm(it)}>แก้ไข</Btn>
          <Btn size="sm" variant="danger" onClick={() => remove(it)}>ลบ</Btn>
        </div>
      ) },
  ];

  return (
    <PageContainer>
      <PageHeader title="ค่าใช้จ่ายประจำ"
        subtitle="parking / internet add-on / cleaning ฯลฯ — ผูกกับผู้เช่าหรือห้อง" />

      {recurringFlag.ready && !recurringFlag.enabled ? (
        <Card style={{
          background: C.warningSoft, color: C.warningInk, border: '1px solid ' + C.warning,
          display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontWeight: 700 }}>ฟีเจอร์รวมเข้าบิลอัตโนมัติยังปิดอยู่</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>
              ยังเพิ่มและแก้รายการได้ แต่รายการจะยังไม่ถูกรวมในบิลจนกว่าจะเปิด recurringCharges
            </div>
          </div>
          <Btn size="sm" variant="secondary" onClick={() => { window.location.hash = '#features'; }}>
            ไปเปิดฟีเจอร์
          </Btn>
        </Card>
      ) : recurringFlag.ready && recurringFlag.enabled && recurringFlag.flag?.autoIncludeOnBillGen === false ? (
        <Card style={{ background: C.infoSoft, color: C.infoInk, border: '1px solid ' + C.info }}>
          เปิดฟีเจอร์แล้ว แต่ autoIncludeOnBillGen ปิดอยู่: รายการจะไม่เข้าบิลอัตโนมัติจนกว่าจะเปิดตัวเลือกนี้
        </Card>
      ) : null}

      {err ? (
        <Card style={{ color: C.danger, display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 700 }}>โหลดค่าใช้จ่ายประจำไม่สำเร็จ</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>{err}</div>
          </div>
          <Btn size="sm" variant="secondary" onClick={load} disabled={busy}>ลองใหม่</Btn>
        </Card>
      ) : null}

      {tenantLoadWarning ? (
        <Card style={{
          background: C.warningSoft, color: C.warningInk, border: '1px solid ' + C.warning,
          display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontWeight: 700 }}>โหลดรายชื่อผู้เช่าไม่ครบ</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>{tenantLoadWarning}</div>
          </div>
          <Btn size="sm" variant="secondary" onClick={load} disabled={busy}>รีเฟรช</Btn>
        </Card>
      ) : null}

      {roomLoadWarning ? (
        <Card style={{
          background: C.warningSoft, color: C.warningInk, border: '1px solid ' + C.warning,
          display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontWeight: 700 }}>โหลดรายชื่อห้องไม่ครบ</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>{roomLoadWarning}</div>
          </div>
          <Btn size="sm" variant="secondary" onClick={load} disabled={busy}>รีเฟรช</Btn>
        </Card>
      ) : null}

      <Card>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid ' + C.border,
              background: C.bg, color: C.ink, fontSize: 13 }}>
            <option value="active">เฉพาะที่เปิดอยู่</option>
            <option value="inactive">เฉพาะที่ปิด</option>
            <option value="all">ทั้งหมด</option>
          </select>
          <div style={{ flex: 1 }} />
          <Btn size="sm" variant="secondary" onClick={load} disabled={busy}>
            {busy ? 'กำลังโหลด...' : 'รีเฟรช'}
          </Btn>
          <Btn icon="+" variant="primary" onClick={() => setForm({})} disabled={busy}>
            เพิ่มรายการ
          </Btn>
        </div>

        {busy && items.length === 0 && !err ? (
          <div role="status" aria-live="polite" style={{
            padding: 28, textAlign: 'center', border: '1px dashed ' + C.borderStrong,
            borderRadius: 10, background: C.surfaceAlt, color: C.muted, fontSize: 13,
          }}>
            กำลังโหลดค่าใช้จ่ายประจำ...
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon="💸" title="ยังไม่มีรายการ"
            description="เพิ่มรายการแรกเพื่อให้ระบบรวมเข้าบิลทุกเดือนอัตโนมัติ" />
        ) : (
          <DataTable rows={items} columns={columns} keyOf={(it) => it.id} />
        )}
      </Card>

      {form !== null ? (
        <RecurringForm
          initial={form}
          tenants={tenants}
          rooms={rooms}
          tenantLoadWarning={tenantLoadWarning}
          roomLoadWarning={roomLoadWarning}
          onReloadTenants={load}
          onCancel={() => setForm(null)}
          onSave={save}
          busy={busy}
        />
      ) : null}
    </PageContainer>
  );
}

function RecurringForm({ initial, tenants, rooms, tenantLoadWarning, roomLoadWarning, onReloadTenants, onCancel, onSave, busy }) {
  const C = window.ADMIN_C;
  const { Modal, Btn } = window;
  const isUpdate = !!initial.id;
  const [form, setForm] = useState({
    label:     initial.label || '',
    amount:    initial.amount || '',
    frequency: initial.frequency || 'monthly',
    tenant_id: initial.tenant_id || '',
    room_id:   initial.room_id || '',
    active:    initial.active !== false,
    start_at:  initial.start_at ? String(initial.start_at).slice(0, 10) : '',
    end_at:    initial.end_at ? String(initial.end_at).slice(0, 10) : '',
    notes:     initial.notes || '',
  });
  const [scope, setScope] = useState(
    initial.tenant_id ? 'tenant' : initial.room_id ? 'room' : 'tenant'
  );

  function submit(e) {
    e.preventDefault();
    if (!form.label.trim()) { alert('ใส่ชื่อรายการ'); return; }
    const amt = Number(form.amount);
    if (!Number.isFinite(amt) || amt < 0) { alert('จำนวนเงินไม่ถูกต้อง'); return; }
    if (scope === 'tenant' && tenantLoadWarning && tenants.length === 0) {
      alert('รายชื่อผู้เช่ายังโหลดไม่สำเร็จ กดรีเฟรชหรือเลือกผูกกับห้องแทน');
      return;
    }
    const payload = {
      ...(isUpdate ? { id: initial.id } : {}),
      label: form.label.trim(),
      amount: amt,
      frequency: form.frequency,
      active: form.active,
      tenantId: scope === 'tenant' ? Number(form.tenant_id) || null : null,
      roomId:   scope === 'room' ? form.room_id.trim() || null : null,
      startAt:  form.start_at || null,
      endAt:    form.end_at || null,
      notes:    form.notes.trim() || null,
    };
    if (!payload.tenantId && !payload.roomId) {
      alert('เลือกผู้เช่าหรือใส่หมายเลขห้อง');
      return;
    }
    onSave(payload);
  }

  const lbl = { display: 'block', fontSize: 12, color: C.muted, margin: '10px 0 4px' };
  const inp = {
    width: '100%', padding: '8px 10px', borderRadius: 6,
    border: '1px solid ' + C.border, background: C.bg, color: C.ink, fontSize: 13.5,
  };

  return (
    <Modal open={true} onClose={onCancel} title={isUpdate ? 'แก้ไขรายการ' : 'เพิ่มรายการ'}>
      <form onSubmit={submit}>
        <label style={lbl}>ชื่อรายการ</label>
        <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })}
          maxLength={80} required style={inp} />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={lbl}>จำนวนเงิน (บาท)</label>
            <input type="number" step="0.01" min="0" value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              required style={inp} />
          </div>
          <div>
            <label style={lbl}>รอบการเรียกเก็บ</label>
            <select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}
              style={inp}>
              <option value="monthly">รายเดือน</option>
              <option value="quarterly">รายไตรมาส</option>
              <option value="one_off">ครั้งเดียว (auto-off หลังเก็บ)</option>
            </select>
          </div>
        </div>

        <label style={lbl}>ผูกกับ</label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
          <label style={{ fontSize: 13, color: C.ink2 }}>
            <input type="radio" checked={scope === 'tenant'} onChange={() => setScope('tenant')} />
            {' '}ผู้เช่า
          </label>
          <label style={{ fontSize: 13, color: C.ink2 }}>
            <input type="radio" checked={scope === 'room'} onChange={() => setScope('room')} />
            {' '}ห้อง
          </label>
        </div>
        {scope === 'tenant' ? (
          <React.Fragment>
            <select value={form.tenant_id} onChange={(e) => setForm({ ...form, tenant_id: e.target.value })}
              style={inp}>
              <option value="">— เลือกผู้เช่า —</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>{t.full_name} · {t.phone}{t.current_room_id ? ` · ห้อง ${t.current_room_id}` : ''}</option>
              ))}
            </select>
            {tenantLoadWarning ? (
              <div style={{
                marginTop: 8, padding: 10, borderRadius: 8,
                background: C.warningSoft, color: C.warningInk, fontSize: 12.5,
                display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between',
              }}>
                <span>รายชื่อผู้เช่ายังโหลดไม่ครบ เลือกรีเฟรชหรือผูกกับห้องแทน</span>
                <Btn size="sm" variant="secondary" type="button" onClick={onReloadTenants} disabled={busy}>รีเฟรช</Btn>
              </div>
            ) : null}
          </React.Fragment>
        ) : (
          <React.Fragment>
            {rooms && rooms.length > 0 ? (
              <select value={form.room_id} onChange={(e) => setForm({ ...form, room_id: e.target.value })}
                style={inp}>
                <option value="">— เลือกห้อง —</option>
                {rooms.map((r) => {
                  const code = String(r.room_code || r.id || '');
                  const statusText = {
                    vacant: 'ว่าง',
                    occupied: 'มีผู้เช่า',
                    reserved: 'จองแล้ว',
                    overdue: 'ค้างชำระ',
                    maintenance: 'ซ่อมบำรุง',
                  }[r.status] || r.status || '';
                  return (
                    <option key={code} value={code}>
                      ห้อง {code}{statusText ? ` · ${statusText}` : ''}
                    </option>
                  );
                })}
              </select>
            ) : (
              <input value={form.room_id} onChange={(e) => setForm({ ...form, room_id: e.target.value })}
                placeholder="เช่น 101" maxLength={32} style={inp} />
            )}
            {roomLoadWarning ? (
              <div style={{
                marginTop: 8, padding: 10, borderRadius: 8,
                background: C.warningSoft, color: C.warningInk, fontSize: 12.5,
              }}>
                รายชื่อห้องยังโหลดไม่ครบ พิมพ์เลขห้องเองได้ แต่ระบบจะตรวจว่าห้องมีจริงตอนบันทึก
              </div>
            ) : null}
          </React.Fragment>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={lbl}>เริ่มเรียกเก็บ (optional)</label>
            <input type="date" value={form.start_at || ''}
              onChange={(e) => setForm({ ...form, start_at: e.target.value })} style={inp} />
          </div>
          <div>
            <label style={lbl}>หมดอายุ (optional)</label>
            <input type="date" value={form.end_at || ''}
              onChange={(e) => setForm({ ...form, end_at: e.target.value })} style={inp} />
          </div>
        </div>
        {form.frequency === 'quarterly' ? (
          <div style={{
            marginTop: 4, padding: 8, background: C.surfaceAlt, borderRadius: 6,
            fontSize: 12, color: C.muted, lineHeight: 1.5,
          }}>
            ℹ️ <b>รายไตรมาส</b> — ระบบจะออกบิลทุก 3 เดือนนับจากเดือนของ "เริ่มเรียกเก็บ"
            (ถ้าไม่ระบุ จะนับจาก ม.ค.) · เช่น <i>เริ่มเรียกเก็บ มี.ค.</i> → จะออกบิลใน <b>มี.ค. มิ.ย. ก.ย. ธ.ค.</b>
          </div>
        ) : null}

        <label style={lbl}>หมายเหตุ</label>
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}
          maxLength={500} rows={2} style={{ ...inp, resize: 'vertical' }} />

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 13, color: C.ink2 }}>
          <input type="checkbox" checked={form.active}
            onChange={(e) => setForm({ ...form, active: e.target.checked })} />
          เปิดใช้งานทันที
        </label>

        <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onCancel} type="button">ยกเลิก</Btn>
          <Btn variant="primary" type="submit" disabled={busy}>
            {busy ? '…' : isUpdate ? 'บันทึก' : 'เพิ่ม'}
          </Btn>
        </div>
      </form>
    </Modal>
  );
}

window.PageRecurringCharges = PageRecurringCharges;
