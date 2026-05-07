// === admin/page-rooms.jsx =================================================
// จัดการห้องพัก: ตาราง 40 ห้อง, ฟิลเตอร์/ค้นหา, drawer แก้ไขรายห้อง
// ===========================================================================

const { useState, useMemo } = React;

function PageRooms({ rooms, setRooms, config, addActivity, setToast }) {
  const C = window.ADMIN_C;
  const ADMIN_STATUS = window.ADMIN_STATUS;
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES;
  const ADMIN_ROOM_TYPE_KEYS = window.ADMIN_ROOM_TYPE_KEYS;
  const ADMIN_VIEWS = window.ADMIN_VIEWS;
  const { fmt, fmtCurrency } = window;
  const { Card, Btn, IconBtn, Input, Select, Toggle, Textarea, StatusBadge, Pill, DataTable,
          Drawer, Modal, SearchInput, FilterChip, PageContainer, PageHeader, SectionHeading, DefList } = window;

  const [search, setSearch]       = useState('');
  const [filterStatus, setFStatus] = useState('all');
  const [filterFloor, setFFloor]   = useState('all');
  const [filterType, setFType]     = useState('all');
  const [editId, setEditId]        = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [addOpen, setAddOpen]      = useState(false);
  const fileInputRef               = React.useRef(null);

  const list = useMemo(() => Object.values(rooms).sort((a, b) => a.id.localeCompare(b.id)), [rooms]);

  const filtered = useMemo(() => list.filter(r => {
    if (filterStatus !== 'all' && r.status !== filterStatus) return false;
    if (filterFloor  !== 'all' && r.floor !== Number(filterFloor)) return false;
    if (filterType   !== 'all' && r.type  !== filterType)  return false;
    if (search) {
      const q = search.toLowerCase();
      const hay = `${r.id} ${r.tenant?.name || ''} ${ADMIN_ROOM_TYPES[r.type].th}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }), [list, filterStatus, filterFloor, filterType, search]);

  const counts = useMemo(() => {
    const c = { all: list.length };
    Object.keys(ADMIN_STATUS).forEach(k => { c[k] = list.filter(r => r.status === k).length; });
    return c;
  }, [list]);

  const updateRoom = (id, patch) => {
    setRooms(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };

  const handleExportCSV = () => {
    const ok = window.exportRoomsCSV(rooms);
    if (ok) {
      addActivity && addActivity({ icon: '📤', text: `ส่งออกข้อมูลห้องพัก (${list.length} รายการ) เป็น CSV`, type: 'system' });
      setToast && setToast({ kind: 'success', message: `ดาวน์โหลด CSV ${list.length} ห้องเรียบร้อย` });
    }
  };

  const handleImportCSV = () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.csv,text/csv';
    inp.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const text = reader.result.replace(/^﻿/, '');
          // C8 — cap input so a malicious or accidental 100MB CSV can't
          // freeze the browser. Real bulk-import is a few hundred rows.
          if (text.length > 5_000_000) throw new Error('ไฟล์ใหญ่เกิน 5MB');
          const lines = text.split(/\r?\n/).filter(l => l.trim());
          if (lines.length > 5000) throw new Error('แถวเกิน 5,000 — แบ่งไฟล์ก่อนนำเข้า');
          const parseRow = (line) => {
            const out = []; let cur = '', inQ = false;
            for (let i = 0; i < line.length; i++) {
              const ch = line[i];
              if (inQ) {
                if (ch === '"' && line[i+1] === '"') { cur += '"'; i++; }
                else if (ch === '"') inQ = false;
                else cur += ch;
              } else {
                if (ch === '"') inQ = true;
                else if (ch === ',') { out.push(cur); cur = ''; }
                else cur += ch;
              }
            }
            out.push(cur);
            return out;
          };
          const header = parseRow(lines[0]);
          const idIdx = header.findIndex(h => /เลขห้อง|^id$/i.test(h));
          if (idIdx === -1) throw new Error('ไม่พบคอลัมน์ "เลขห้อง" ในไฟล์');
          const rentIdx     = header.findIndex(h => /ค่าเช่า|^rent$/i.test(h));
          const statusIdx   = header.findIndex(h => /^สถานะ$|^status$/i.test(h));
          const notesIdx    = header.findIndex(h => /หมายเหตุ|notes/i.test(h));
          const waterIdx    = header.findIndex(h => /หน่วย.*น้ำ|water.*units|^น้ำ\(หน่วย\)$/i.test(h));
          const elecIdx     = header.findIndex(h => /หน่วย.*ไฟ|elec.*units|^ไฟ\(หน่วย\)$/i.test(h));
          const statusMap = {}; for (const k of Object.keys(window.ADMIN_STATUS)) statusMap[window.ADMIN_STATUS[k].th] = k;
          let count = 0;
          setRooms(prev => {
            const next = { ...prev };
            for (let i = 1; i < lines.length; i++) {
              const row = parseRow(lines[i]);
              const id = row[idIdx]?.trim();
              if (!id || !next[id]) continue;
              const patch = {};
              if (rentIdx > -1 && row[rentIdx])   patch.rent = Number(row[rentIdx]);
              if (statusIdx > -1 && row[statusIdx]) patch.status = statusMap[row[statusIdx].trim()] || row[statusIdx].trim();
              if (notesIdx > -1)                  patch.notes = row[notesIdx] || '';
              if (waterIdx > -1 && row[waterIdx]) patch.waterUnits = Number(row[waterIdx]);
              if (elecIdx > -1 && row[elecIdx])   patch.elecUnits  = Number(row[elecIdx]);
              if (Object.keys(patch).length) {
                next[id] = { ...next[id], ...patch };
                count++;
              }
            }
            return next;
          });
          setToast && setToast({ kind: 'success', message: `นำเข้า CSV สำเร็จ — อัปเดต ${count} ห้อง` });
          addActivity && addActivity({ icon: '📥', text: `นำเข้า CSV ห้องพัก ${count} รายการ`, type: 'system' });
        } catch (err) {
          setToast && setToast({ kind: 'danger', message: 'นำเข้า CSV ไม่สำเร็จ: ' + err.message });
        }
      };
      reader.readAsText(file, 'utf-8');
    };
    inp.click();
  };

  const handleAddRoom = (data) => {
    if (rooms[data.id]) {
      setToast && setToast({ kind: 'danger', message: `เลขห้อง ${data.id} มีอยู่แล้ว` });
      return false;
    }
    const t = ADMIN_ROOM_TYPES[data.type];
    const newRoom = {
      id: data.id, floor: Number(data.floor), no: Number(data.no || 1),
      type: data.type, status: 'vacant',
      rent: Number(data.rent), deposit: Number(data.rent) * 2,
      tenant: null, since: null, contractEnd: null,
      water: 0, elec: 0, waterUnits: 0, elecUnits: 0, wifi: config.utilities.wifi || 250,
      photos: [], notes: '',
      view: data.view, balcony: !!data.balcony, parking: !!data.parking, kitchen: !!data.kitchen,
      lastCleaned: window.fmtDateTH(new Date()),
      lastBillDate: null, billStatus: 'none', overdueDays: 0,
    };
    setRooms(prev => ({ ...prev, [data.id]: newRoom }));
    addActivity && addActivity({ icon: '➕', text: `เพิ่มห้องใหม่ ${data.id} (${t.th})`, type: 'system' });
    setToast && setToast({ kind: 'success', message: `เพิ่มห้อง ${data.id} เรียบร้อย` });
    setAddOpen(false);
    return true;
  };

  const handleDelete = () => {
    if (!confirmDelete) return;
    const id = confirmDelete;
    setRooms(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    addActivity && addActivity({ icon: '🗑️', text: `ลบห้อง ${id}`, type: 'system' });
    setToast && setToast({ kind: 'success', message: `ลบห้อง ${id} แล้ว` });
    setConfirmDelete(null);
    if (editId === id) setEditId(null);
  };

  const editing = editId ? rooms[editId] : null;

  // --- Table columns -----
  const columns = [
    {
      key: 'id', label: 'ห้อง', minWidth: 80,
      render: r => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 9,
            background: ADMIN_ROOM_TYPES[r.type].accent + '18',
            color: ADMIN_ROOM_TYPES[r.type].accent,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'Sora, sans-serif', fontWeight: 700, fontSize: 13,
            flexShrink: 0,
          }}>{r.id}</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink }}>ชั้น {r.floor}</div>
            <div style={{ fontSize: 11, color: C.muted }}>{ADMIN_ROOM_TYPES[r.type].th}</div>
          </div>
        </div>
      ),
    },
    { key: 'status',  label: 'สถานะ', minWidth: 110, render: r => <StatusBadge status={r.status} /> },
    {
      key: 'tenant',  label: 'ผู้เช่า', minWidth: 180,
      render: r => r.tenant ? (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, color: C.ink, fontWeight: 500 }}>{r.tenant.name}</div>
          <div style={{ fontSize: 11.5, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.tenant.occupation}
          </div>
        </div>
      ) : <span style={{ color: C.muted }}>—</span>,
    },
    {
      key: 'rent',    label: 'ค่าเช่า',  align: 'right', minWidth: 100,
      render: r => <span style={{ fontWeight: 600, fontFamily: 'Sora, sans-serif' }}>{fmtCurrency(r.rent)}</span>,
    },
    {
      key: 'utilities', label: 'น้ำ/ไฟ', align: 'right', minWidth: 110,
      render: r => (
        <div style={{ fontSize: 11.5 }}>
          <div style={{ color: C.ink2 }}>💧 {r.waterUnits} หน่วย</div>
          <div style={{ color: C.ink2 }}>⚡ {r.elecUnits} หน่วย</div>
        </div>
      ),
    },
    {
      key: 'contract', label: 'สัญญา', minWidth: 120,
      render: r => r.contractEnd
        ? <div style={{ fontSize: 12, color: C.ink2 }}>หมด {r.contractEnd}</div>
        : <span style={{ color: C.muted, fontSize: 12 }}>—</span>,
    },
    {
      key: 'actions', label: '', align: 'right', minWidth: 80,
      render: r => (
        <div style={{ display: 'inline-flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
          <IconBtn icon="✎" label="แก้ไข" onClick={() => setEditId(r.id)} />
          <IconBtn icon="🗑" label="ลบ" danger onClick={() => setConfirmDelete(r.id)} />
        </div>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        title="จัดการห้องพัก"
        subtitle={`ทั้งหมด ${list.length} ห้อง · แสดง ${filtered.length} รายการ`}
        actions={
          <>
            <Btn variant="secondary" icon="📥" onClick={handleImportCSV}>นำเข้า CSV</Btn>
            <Btn variant="secondary" icon="📤" onClick={handleExportCSV}>ส่งออก CSV</Btn>
            <Btn variant="primary" icon="+" onClick={() => setAddOpen(true)}>เพิ่มห้อง</Btn>
          </>
        }
      />

      {/* Filters row */}
      <Card style={{ marginBottom: 16, padding: 16 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <SearchInput value={search} onChange={setSearch} placeholder="ค้นหาเลขห้อง / ผู้เช่า..." />
          <div style={{ width: 1, height: 28, background: C.border, margin: '0 4px' }} />
          <FilterChip label="ทั้งหมด" active={filterStatus === 'all'} onClick={() => setFStatus('all')} count={counts.all} />
          {Object.keys(ADMIN_STATUS).map(k => (
            <FilterChip
              key={k}
              label={ADMIN_STATUS[k].th}
              active={filterStatus === k}
              onClick={() => setFStatus(k)}
              count={counts[k]}
              color={ADMIN_STATUS[k].dot}
            />
          ))}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Select
              value={filterFloor}
              onChange={setFFloor}
              fullWidth={false}
              options={[
                { value: 'all', label: 'ทุกชั้น' },
                ...[1,2,3,4,5].map(f => ({ value: String(f), label: `ชั้น ${f}` })),
              ]}
              style={{ width: 130 }}
            />
            <Select
              value={filterType}
              onChange={setFType}
              fullWidth={false}
              options={[
                { value: 'all', label: 'ทุกประเภท' },
                ...ADMIN_ROOM_TYPE_KEYS.map(k => ({ value: k, label: ADMIN_ROOM_TYPES[k].th })),
              ]}
              style={{ width: 160 }}
            />
          </div>
        </div>
      </Card>

      {/* Table */}
      <DataTable
        columns={columns}
        rows={filtered}
        onRowClick={(r) => setEditId(r.id)}
        empty="ไม่พบห้องที่ตรงกับเงื่อนไข"
      />

      {/* Edit Drawer */}
      <Drawer
        open={!!editing}
        onClose={() => setEditId(null)}
        title={editing ? `ห้อง ${editing.id} · ${ADMIN_ROOM_TYPES[editing.type].th}` : ''}
        width={580}
        footer={editing && (
          <>
            <Btn variant="ghost" onClick={() => setEditId(null)}>ยกเลิก</Btn>
            <Btn variant="primary" icon="✓" onClick={() => {
              addActivity && addActivity({ icon: '✏️', text: `แก้ไขข้อมูลห้อง ${editing.id}`, type: 'system' });
              setToast && setToast({ kind: 'success', message: `บันทึกห้อง ${editing.id} เรียบร้อย` });
              setEditId(null);
            }}>บันทึกการเปลี่ยนแปลง</Btn>
          </>
        )}
      >
        {editing && <RoomEditForm room={editing} onUpdate={(patch) => updateRoom(editing.id, patch)} config={config} />}
      </Drawer>

      {/* Delete confirm */}
      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="ยืนยันการลบห้อง"
        footer={
          <>
            <Btn variant="ghost" onClick={() => setConfirmDelete(null)}>ยกเลิก</Btn>
            <Btn variant="danger" onClick={handleDelete}>ลบห้อง</Btn>
          </>
        }
      >
        <div style={{ fontSize: 14, color: C.ink2, lineHeight: 1.6 }}>
          ต้องการลบห้อง <b style={{ color: C.ink }}>{confirmDelete}</b> ใช่หรือไม่?
          การกระทำนี้ไม่สามารถย้อนกลับได้
        </div>
      </Modal>

      <AddRoomModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdd={handleAddRoom}
        existingIds={Object.keys(rooms)}
      />
    </PageContainer>
  );
}

// --- Tenant section (in edit drawer) -----------------------------------
function TenantSection({ room, onUpdate }) {
  const C = window.ADMIN_C;
  const { Input, SectionHeading, Btn, DefList, Pill, Modal } = window;
  const { fmtDateTH } = window;
  const [editMode, setEditMode] = React.useState(false);
  const [confirmRemove, setConfirmRemove] = React.useState(false);

  const hasTenant = !!room.tenant;

  const startNew = () => {
    onUpdate({
      tenant: { name: '', occupation: '', phone: '', email: '', score: 'A' },
      since: fmtDateTH(new Date()),
      contractEnd: fmtDateTH(new Date(Date.now() + 365*24*60*60*1000)),
      status: room.status === 'vacant' ? 'occupied' : room.status,
    });
    setEditMode(true);
  };

  const removeTenant = () => {
    onUpdate({ tenant: null, since: null, contractEnd: null, status: 'vacant' });
    setEditMode(false);
    setConfirmRemove(false);
  };

  const updateTenant = (k, v) => {
    onUpdate({ tenant: { ...room.tenant, [k]: v } });
  };

  if (!hasTenant) {
    return (
      <div>
        <SectionHeading title="ข้อมูลผู้เช่า" level={3} style={{ marginBottom: 10 }} />
        <div style={{
          padding: 16, background: C.surfaceAlt, borderRadius: 10,
          border: `1px dashed ${C.borderStrong}`, textAlign: 'center',
        }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>👤</div>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>ห้องนี้ยังไม่มีผู้เช่า</div>
          <Btn variant="primary" size="sm" icon="+" onClick={startNew}>เพิ่มผู้เช่า</Btn>
        </div>
      </div>
    );
  }

  return (
    <div>
      <SectionHeading
        title="ข้อมูลผู้เช่า"
        level={3}
        style={{ marginBottom: 10 }}
        action={
          <div style={{ display: 'flex', gap: 6 }}>
            <Btn variant="ghost" size="sm" onClick={() => setEditMode(m => !m)}>
              {editMode ? '✓ เสร็จสิ้น' : '✎ แก้ไข'}
            </Btn>
            <Btn variant="ghost" size="sm" danger onClick={() => setConfirmRemove(true)}>🗑 ย้ายออก</Btn>
          </div>
        }
      />
      <Modal
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title="ยืนยันการย้ายออก"
        footer={
          <>
            <Btn variant="ghost" onClick={() => setConfirmRemove(false)}>ยกเลิก</Btn>
            <Btn variant="danger" onClick={removeTenant}>ย้ายออก</Btn>
          </>
        }
      >
        <div style={{ fontSize: 14, color: C.ink2, lineHeight: 1.6 }}>
          ลบข้อมูลผู้เช่า <b style={{ color: C.ink }}>{room.tenant?.name}</b> ออกจากห้อง <b>{room.id}</b> และตั้งสถานะเป็นว่าง?
        </div>
      </Modal>
      {editMode ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Input label="ชื่อ-นามสกุล" value={room.tenant.name || ''}
                 onChange={(v) => updateTenant('name', v)} />
          <Input label="อาชีพ"          value={room.tenant.occupation || ''}
                 onChange={(v) => updateTenant('occupation', v)} />
          <Input label="เบอร์โทร"      value={room.tenant.phone || ''}
                 onChange={(v) => updateTenant('phone', v)} />
          <Input label="อีเมล"           value={room.tenant.email || ''}
                 onChange={(v) => updateTenant('email', v)} />
          <Input label="วันที่เข้าพัก" value={room.since || ''}
                 onChange={(v) => onUpdate({ since: v })} />
          <Input label="สัญญาสิ้นสุด" value={room.contractEnd || ''}
                 onChange={(v) => onUpdate({ contractEnd: v })} />
        </div>
      ) : (
        <DefList
          columns={2}
          items={[
            { label: 'ชื่อ',                value: room.tenant.name, bold: true },
            { label: 'อาชีพ',              value: room.tenant.occupation },
            { label: 'เบอร์โทร',          value: room.tenant.phone },
            { label: 'อีเมล',               value: room.tenant.email },
            { label: 'เข้าพักเมื่อ',     value: room.since },
            { label: 'สัญญาสิ้นสุด',  value: room.contractEnd },
          ]}
        />
      )}
    </div>
  );
}

// --- Add room modal ------------------------------------------------------
function AddRoomModal({ open, onClose, onAdd, existingIds }) {
  const C = window.ADMIN_C;
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES;
  const ADMIN_ROOM_TYPE_KEYS = window.ADMIN_ROOM_TYPE_KEYS;
  const ADMIN_VIEWS = window.ADMIN_VIEWS;
  const { Modal, Btn, Input, Select, Toggle } = window;

  const [form, setForm] = React.useState({
    id: '', floor: 1, no: 1, type: 'standard',
    rent: 4500, view: 'วิวสวน', balcony: false, parking: false, kitchen: false,
  });
  React.useEffect(() => {
    if (open) {
      // Find a sensible default ID — next available
      const ids = new Set(existingIds);
      let next = '';
      for (let f = 1; f <= 5 && !next; f++) {
        for (let r = 1; r <= 8 && !next; r++) {
          const id = `${f}${String(r).padStart(2,'0')}`;
          if (!ids.has(id)) next = id;
        }
      }
      setForm(prev => ({ ...prev,
        id: next || '999',
        floor: next ? Number(next[0]) : 9,
        no: next ? Number(next.slice(1)) : 99,
        rent: ADMIN_ROOM_TYPES.standard.baseRent,
      }));
    }
  }, [open]);

  const exists = existingIds.includes(form.id);

  const update = (k, v) => {
    setForm(p => {
      const next = { ...p, [k]: v };
      if (k === 'type')  next.rent = ADMIN_ROOM_TYPES[v].baseRent;
      if (k === 'floor') next.id = `${v}${String(p.no).padStart(2,'0')}`;
      if (k === 'no')    next.id = `${p.floor}${String(v).padStart(2,'0')}`;
      return next;
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="เพิ่มห้องใหม่"
      width={520}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose}>ยกเลิก</Btn>
          <Btn variant="primary" disabled={!form.id || exists || !form.rent}
               onClick={() => onAdd(form)}>เพิ่มห้อง</Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <Input label="ชั้น" type="number" value={form.floor}
                 onChange={(v) => update('floor', Number(v))} />
          <Input label="ลำดับห้อง" type="number" value={form.no}
                 onChange={(v) => update('no', Number(v))} />
          <Input label="เลขห้อง" value={form.id}
                 onChange={(v) => update('id', v)}
                 error={exists ? `ห้อง ${form.id} มีแล้ว` : null} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Select label="ประเภทห้อง" value={form.type}
                  onChange={(v) => update('type', v)}
                  options={ADMIN_ROOM_TYPE_KEYS.map(k => ({ value: k, label: ADMIN_ROOM_TYPES[k].th }))} />
          <Select label="วิว" value={form.view}
                  onChange={(v) => update('view', v)}
                  options={ADMIN_VIEWS} />
        </div>
        <Input label="ค่าเช่า/เดือน" type="number" suffix="บาท"
               value={form.rent} onChange={(v) => update('rent', Number(v))} />
        <div style={{ padding: 10, background: C.surfaceAlt, borderRadius: 8 }}>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>คุณสมบัติพิเศษ</div>
          <Toggle label="มีระเบียง"  checked={form.balcony} onChange={(v) => update('balcony', v)} />
          <Toggle label="ที่จอดรถ"   checked={form.parking} onChange={(v) => update('parking', v)} />
          <Toggle label="ครัวในห้อง" checked={form.kitchen} onChange={(v) => update('kitchen', v)} />
        </div>
      </div>
    </Modal>
  );
}

// --- Edit form (sub-component) -------------------------------------------
function RoomEditForm({ room, onUpdate, config }) {
  const C = window.ADMIN_C;
  const ADMIN_STATUS = window.ADMIN_STATUS;
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES;
  const ADMIN_ROOM_TYPE_KEYS = window.ADMIN_ROOM_TYPE_KEYS;
  const ADMIN_VIEWS = window.ADMIN_VIEWS;
  const { fmt, fmtCurrency, computeRoomRent } = window;
  const { Input, Select, Toggle, Textarea, SectionHeading, DefList, Pill } = window;

  const features = {
    balcony: room.balcony,
    ac: ADMIN_ROOM_TYPES[room.type].ac,
    parking: room.parking,
    kitchen: room.kitchen,
  };
  const computedRent = computeRoomRent(room.type, room.floor, room.view, features, config);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {/* Quick info */}
      <div style={{
        background: C.surfaceAlt, padding: 14, borderRadius: 10,
        border: `1px solid ${C.borderSoft}`,
      }}>
        <DefList
          columns={2}
          dense
          items={[
            { label: 'เลขห้อง',   value: room.id, bold: true },
            { label: 'ชั้น',         value: `ชั้น ${room.floor}` },
            { label: 'ประเภท',     value: ADMIN_ROOM_TYPES[room.type].th },
            { label: 'ขนาด',         value: `${ADMIN_ROOM_TYPES[room.type].size} ตร.ม.` },
            { label: 'ค่าเช่าปัจจุบัน', value: fmtCurrency(room.rent), bold: true },
            { label: 'ราคาตามสูตร',   value: fmtCurrency(computedRent) },
          ]}
        />
      </div>

      {/* Status */}
      <div>
        <SectionHeading title="สถานะ" level={3} style={{ marginBottom: 10 }} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
          {Object.keys(ADMIN_STATUS).map(k => {
            const s = ADMIN_STATUS[k];
            const active = room.status === k;
            return (
              <button
                key={k}
                type="button"
                onClick={() => onUpdate({ status: k })}
                style={{
                  padding: '10px 12px',
                  background: active ? s.soft : C.surface,
                  border: `1px solid ${active ? s.dot : C.border}`,
                  borderRadius: 9, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 8,
                  fontSize: 12.5, fontWeight: active ? 600 : 500,
                  color: active ? s.ink : C.ink2,
                  fontFamily: 'inherit',
                  transition: 'all .15s',
                }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.dot }} />
                {s.th}
              </button>
            );
          })}
        </div>
      </div>

      {/* Type & view */}
      <div>
        <SectionHeading title="ประเภทและตำแหน่ง" level={3} style={{ marginBottom: 10 }} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Select
            label="ประเภทห้อง"
            value={room.type}
            onChange={(v) => onUpdate({ type: v })}
            options={ADMIN_ROOM_TYPE_KEYS.map(k => ({ value: k, label: ADMIN_ROOM_TYPES[k].th }))}
          />
          <Select
            label="วิว"
            value={room.view}
            onChange={(v) => onUpdate({ view: v })}
            options={ADMIN_VIEWS}
          />
        </div>
        <div style={{ marginTop: 12, padding: 12, background: C.surfaceAlt, borderRadius: 8 }}>
          <Toggle label="มีระเบียง"  checked={room.balcony} onChange={(v) => onUpdate({ balcony: v })} />
          <Toggle label="ที่จอดรถ"   checked={room.parking} onChange={(v) => onUpdate({ parking: v })} />
          <Toggle label="ครัวในห้อง" checked={room.kitchen} onChange={(v) => onUpdate({ kitchen: v })} />
        </div>
      </div>

      {/* Pricing */}
      <div>
        <SectionHeading title="ราคาและค่าใช้จ่าย" level={3} style={{ marginBottom: 10 }} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Input
            label="ค่าเช่ารายเดือน" type="number" suffix="บาท"
            value={room.rent}
            onChange={(v) => onUpdate({ rent: Number(v), deposit: Number(v) * 2 })}
            hint="เปลี่ยนแปลงค่าเช่าจะอัพเดทเงินมัดจำอัตโนมัติ"
          />
          <Input
            label="เงินมัดจำ" type="number" suffix="บาท"
            value={room.deposit}
            onChange={(v) => onUpdate({ deposit: Number(v) })}
          />
          <Input
            label="ค่าน้ำ (หน่วย)" type="number" suffix="หน่วย"
            value={room.waterUnits}
            onChange={(v) => onUpdate({ waterUnits: Number(v), water: Number(v) * config.utilities.waterRate })}
          />
          <Input
            label="ค่าไฟ (หน่วย)" type="number" suffix="หน่วย"
            value={room.elecUnits}
            onChange={(v) => onUpdate({ elecUnits: Number(v), elec: Number(v) * config.utilities.elecRate })}
          />
          <Input
            label="ค่า Wi-Fi" type="number" suffix="บาท/เดือน"
            value={room.wifi}
            onChange={(v) => onUpdate({ wifi: Number(v) })}
          />
        </div>
        <div style={{
          marginTop: 12, padding: 12,
          background: C.accentSoft, border: `1px solid ${C.accent}33`,
          borderRadius: 8,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 13, color: C.accentInk }}>รวมค่าใช้จ่ายเดือนนี้</span>
          <span style={{ fontSize: 18, fontWeight: 700, color: C.accentInk, fontFamily: 'Sora, sans-serif' }}>
            {fmtCurrency(room.rent + (room.water||0) + (room.elec||0) + (room.wifi||0))}
          </span>
        </div>
      </div>

      {/* Tenant info — editable, allows creating new tenant for vacant rooms */}
      <TenantSection room={room} onUpdate={onUpdate} />


      {/* Notes */}
      <Textarea
        label="หมายเหตุ"
        value={room.notes}
        onChange={(v) => onUpdate({ notes: v })}
        placeholder="บันทึกข้อมูลเพิ่มเติม เช่น รายละเอียดการซ่อมบำรุง, ข้อตกลงพิเศษ"
      />
    </div>
  );
}

window.PageRooms = PageRooms;
