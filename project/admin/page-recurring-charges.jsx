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

const { useState, useEffect, useMemo } = React;

function PageRecurringCharges({ setToast }) {
  const C = window.ADMIN_C;
  const { Card, Btn, Pill, PageContainer, PageHeader, SectionHeading, Modal,
          DataTable, EmptyState } = window;
  const apiFetch = window.apiFetch || fetch;

  const [items, setItems] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [form, setForm] = useState(null);   // null = closed; object = editing/creating
  const [filter, setFilter] = useState('active');

  async function load() {
    setBusy(true); setErr('');
    try {
      const params = new URLSearchParams();
      if (filter === 'active')   params.set('active', 'true');
      if (filter === 'inactive') params.set('active', 'false');
      const [r1, r2] = await Promise.all([
        apiFetch('/api/recurring-charges' + (params.toString() ? '?' + params : '')),
        apiFetch('/api/tenants'),
      ]);
      const d1 = await r1.json();
      const d2 = await r2.json();
      if (!r1.ok) throw new Error(d1.error || 'load failed');
      setItems(d1.charges || []);
      setTenants(d2.tenants || []);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }
  useEffect(() => { load(); }, [filter]);

  async function save(payload) {
    setBusy(true);
    try {
      const isUpdate = !!payload.id;
      const url = isUpdate ? `/api/recurring-charges/${payload.id}` : '/api/recurring-charges';
      const r = await apiFetch(url, {
        method: isUpdate ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'save failed');
      setToast && setToast({ kind: 'success', message: isUpdate ? 'อัปเดตแล้ว' : 'เพิ่มรายการแล้ว' });
      setForm(null);
      await load();
    } catch (e) {
      setToast && setToast({ kind: 'error', message: e.message });
    } finally { setBusy(false); }
  }

  async function remove(id) {
    if (!confirm('ลบรายการนี้?')) return;
    try {
      const r = await apiFetch(`/api/recurring-charges/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('delete failed');
      setToast && setToast({ kind: 'success', message: 'ลบแล้ว' });
      await load();
    } catch (e) {
      setToast && setToast({ kind: 'error', message: e.message });
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

  const tenantLabel = (id) => {
    const t = tenantById.get(Number(id));
    return t ? `${t.full_name} · ${t.phone}` : id ? `#${id}` : '—';
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
        : it.room_id ? `ห้อง ${it.room_id}` : '—' },
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
          <Btn size="sm" variant="danger" onClick={() => remove(it.id)}>ลบ</Btn>
        </div>
      ) },
  ];

  return (
    <PageContainer>
      <PageHeader title="ค่าใช้จ่ายประจำ"
        subtitle="parking / internet add-on / cleaning ฯลฯ — ผูกกับผู้เช่าหรือห้อง" />

      {err ? <Card style={{ color: C.danger }}>{err}</Card> : null}

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
          <Btn icon="+" variant="primary" onClick={() => setForm({})} disabled={busy}>
            เพิ่มรายการ
          </Btn>
        </div>

        {items.length === 0 ? (
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
          onCancel={() => setForm(null)}
          onSave={save}
          busy={busy}
        />
      ) : null}
    </PageContainer>
  );
}

function RecurringForm({ initial, tenants, onCancel, onSave, busy }) {
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
    end_at:  initial.end_at || '',
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
    const payload = {
      ...(isUpdate ? { id: initial.id } : {}),
      label: form.label.trim(),
      amount: amt,
      frequency: form.frequency,
      active: form.active,
      tenantId: scope === 'tenant' ? Number(form.tenant_id) || null : null,
      roomId:   scope === 'room' ? form.room_id.trim() || null : null,
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
          <select value={form.tenant_id} onChange={(e) => setForm({ ...form, tenant_id: e.target.value })}
            style={inp}>
            <option value="">— เลือกผู้เช่า —</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>{t.full_name} · {t.phone}{t.current_room_id ? ` · ห้อง ${t.current_room_id}` : ''}</option>
            ))}
          </select>
        ) : (
          <input value={form.room_id} onChange={(e) => setForm({ ...form, room_id: e.target.value })}
            placeholder="เช่น 1A" maxLength={32} style={inp} />
        )}

        <label style={lbl}>หมดอายุ (optional)</label>
        <input type="date" value={form.end_at}
          onChange={(e) => setForm({ ...form, end_at: e.target.value })} style={inp} />

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

window.PageRecurringCharges = window.FeatureGate
  ? function PageRecurringChargesGated(props) {
      return React.createElement(window.FeatureGate,
        { flag: 'recurringCharges', label: 'ค่าใช้จ่ายประจำ' },
        React.createElement(PageRecurringCharges, props));
    }
  : PageRecurringCharges;
