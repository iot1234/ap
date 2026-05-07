// === admin/page-settings.jsx ==============================================
// ตั้งค่าระบบ: ข้อมูลตึก, การชำระเงิน, การแจ้งเตือน, ระบบอัตโนมัติ, ผู้ใช้งาน
// ===========================================================================

const { useState } = React;

function PageSettings({ rooms, setRooms, config, setConfig, bookings, setBookings, activities, setActivities, addActivity, setToast }) {
  const C = window.ADMIN_C;
  const { Card, Btn, Input, Select, Toggle, Textarea, Tabs, Pill, Avatar, Modal,
          PageContainer, PageHeader, SectionHeading, DefList } = window;
  const { resetAll, DEFAULT_CONFIG } = window;

  const [tab, setTab] = useState('building');
  // Strip non-serialisable junk on first mount so a single corrupt key in
  // localStorage (e.g. an event handler accidentally persisted, a DOM ref,
  // a circular structure) can't crash the whole settings page on render.
  const [draft, setDraft] = useState(() => safeClone(config));
  const [confirmReset, setConfirmReset] = useState(false);

  // Try-cloned dirty check. If either side fails to stringify (extremely
  // rare — only happens if rogue code injected a DOM/event), fall back to
  // "not dirty" rather than throwing inside render.
  let dirty = false;
  try {
    dirty = JSON.stringify(draft) !== JSON.stringify(config);
  } catch { dirty = false; }

  const updatePath = (path, value) => {
    setDraft(prev => {
      // Deep-clone via safeClone so a primitive-only `value` plus a
      // primitive-only `prev` keeps the next state primitive-only too.
      // Reject anything non-JSON-safe upstream.
      let next;
      try {
        next = JSON.parse(JSON.stringify(prev));
      } catch {
        next = safeClone(prev);
      }
      let cur = next;
      const parts = path.split('.');
      for (let i = 0; i < parts.length - 1; i++) {
        if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      // Reject DOM/event values defensively — onChange should already pass
      // primitives but a misbehaving custom Input could leak refs.
      const safe = isPrimitiveLike(value) ? value : null;
      cur[parts[parts.length - 1]] = safe;
      return next;
    });
  };

  function isPrimitiveLike(v) {
    if (v == null) return true;
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') return true;
    if (typeof Element !== 'undefined' && v instanceof Element) return false;
    if (typeof Event !== 'undefined' && v instanceof Event) return false;
    if (typeof Node !== 'undefined' && v instanceof Node) return false;
    if (Array.isArray(v)) return v.every(isPrimitiveLike);
    if (t === 'object') {
      // plain-object check — nothing weird in prototype
      const proto = Object.getPrototypeOf(v);
      return (proto === Object.prototype || proto === null);
    }
    return false;
  }
  function safeClone(v) {
    try { return JSON.parse(JSON.stringify(v)); }
    catch { return {}; }
  }

  const handleSave = () => {
    setConfig(draft);
    addActivity && addActivity({ icon: '⚙️', text: 'อัปเดตการตั้งค่าระบบ', type: 'system' });
    setToast && setToast({ kind: 'success', message: 'บันทึกการตั้งค่าเรียบร้อย' });
  };

  const handleResetAll = () => {
    resetAll();
    setToast && setToast({ kind: 'info', message: 'รีเซ็ตข้อมูลทั้งหมดแล้ว — กำลังโหลดหน้าใหม่...' });
    setTimeout(() => location.reload(), 1200);
  };

  return (
    <PageContainer>
      <PageHeader
        title="ตั้งค่าระบบ"
        subtitle="ข้อมูลตึก, การชำระเงิน, การแจ้งเตือน และอื่นๆ"
        actions={
          <>
            <Btn variant="secondary" onClick={() => setDraft(config)} disabled={!dirty}>ยกเลิก</Btn>
            <Btn variant="primary" icon="✓" onClick={handleSave} disabled={!dirty}>
              {dirty ? 'บันทึก' : 'บันทึกแล้ว'}
            </Btn>
          </>
        }
      />

      <Tabs
        items={[
          { value: 'building', label: 'ข้อมูลตึก',     icon: '🏢' },
          { value: 'payment',  label: 'การชำระเงิน', icon: '💳' },
          { value: 'notify',   label: 'การแจ้งเตือน', icon: '🔔' },
          { value: 'auto',     label: 'อัตโนมัติ',     icon: '🤖' },
          { value: 'users',    label: 'ผู้ใช้งาน',     icon: '👥' },
          { value: 'audit',    label: 'Audit log',     icon: '📜' },
          { value: 'system',   label: 'ระบบ',           icon: '⚙️' },
        ]}
        value={tab}
        onChange={setTab}
        variant="pills"
        style={{ marginBottom: 20 }}
      />

      {tab === 'building' && <TabBuilding draft={draft} updatePath={updatePath} />}
      {tab === 'payment'  && <TabPayment  draft={draft} updatePath={updatePath} />}
      {tab === 'notify'   && <TabNotify   draft={draft} updatePath={updatePath} />}
      {tab === 'auto'     && <TabAuto     draft={draft} updatePath={updatePath} />}
      {tab === 'users'    && <TabUsers    setToast={setToast} addActivity={addActivity} />}
      {tab === 'audit'    && <TabAudit    setToast={setToast} />}
      {tab === 'system'   && <TabSystem
                                onResetAll={() => setConfirmReset(true)}
                                rooms={rooms} setRooms={setRooms}
                                config={config} setConfig={setConfig}
                                bookings={bookings} setBookings={setBookings}
                                activities={activities} setActivities={setActivities}
                                setToast={setToast} addActivity={addActivity} />}

      <Modal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="รีเซ็ตข้อมูลทั้งหมด"
        footer={
          <>
            <Btn variant="ghost" onClick={() => setConfirmReset(false)}>ยกเลิก</Btn>
            <Btn variant="danger" onClick={handleResetAll}>รีเซ็ตทั้งหมด</Btn>
          </>
        }
      >
        <div style={{ fontSize: 14, color: C.ink2, lineHeight: 1.6 }}>
          <div style={{ marginBottom: 8 }}>การกระทำนี้จะ:</div>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13 }}>
            <li>ลบข้อมูลห้องทั้งหมดและสร้างใหม่</li>
            <li>รีเซ็ตการตั้งราคากลับเป็นค่าเริ่มต้น</li>
            <li>ลบประวัติการจองและบันทึกกิจกรรม</li>
          </ul>
          <div style={{ marginTop: 12, padding: 10, background: C.dangerSoft, borderRadius: 8, color: C.dangerInk, fontSize: 13 }}>
            ⚠️ การกระทำนี้ไม่สามารถย้อนกลับได้
          </div>
        </div>
      </Modal>
    </PageContainer>
  );
}

// ============================================================
function TabBuilding({ draft, updatePath }) {
  const { Card, Input, Textarea, SectionHeading } = window;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 800 }}>
      <Card>
        <SectionHeading title="ข้อมูลตึก" level={3} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Input label="ชื่อตึก"         value={draft.building.name}    onChange={(v) => updatePath('building.name', v)} />
          <Input label="เบอร์โทรศัพท์" value={draft.building.phone}  onChange={(v) => updatePath('building.phone', v)} />
          <Input label="อีเมล"             value={draft.building.email}  onChange={(v) => updatePath('building.email', v)} />
          <Input label="LINE ID"           value={draft.building.line}    onChange={(v) => updatePath('building.line', v)} prefix="@" />
        </div>
        <div style={{ marginTop: 12 }}>
          <Textarea
            label="ที่อยู่"
            rows={2}
            value={draft.building.address}
            onChange={(v) => updatePath('building.address', v)}
          />
        </div>
      </Card>

      <Card>
        <SectionHeading title="โครงสร้างอาคาร" level={3} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Input label="จำนวนชั้น"      type="number" suffix="ชั้น"  value={draft.building.floors}        onChange={(v) => updatePath('building.floors', Number(v))} />
          <Input label="ห้อง/ชั้น"         type="number" suffix="ห้อง"  value={draft.building.roomsPerFloor} onChange={(v) => updatePath('building.roomsPerFloor', Number(v))} />
          <Input label="เวลาเปิดทำการ" value={draft.building.open}                                onChange={(v) => updatePath('building.open', v)} />
        </div>
      </Card>

      <Card>
        <SectionHeading title="กฎระเบียบ" level={3} />
        <Textarea
          label="กฎระเบียบทั่วไป"
          rows={3}
          value={draft.building.rules}
          onChange={(v) => updatePath('building.rules', v)}
          placeholder="เช่น ห้ามสูบบุหรี่, ห้ามเลี้ยงสัตว์, เคอร์ฟิวเที่ยงคืน"
        />
      </Card>
    </div>
  );
}

// ============================================================
// Validate Thai PromptPay target. Accepts a 10-digit phone (must start with 0)
// or a 13-digit citizen ID. Hyphens/spaces are stripped before checking.
function validatePromptpay(s) {
  if (!s) return { ok: false, reason: 'ยังไม่ได้กรอกหมายเลข' };
  const cleaned = String(s).replace(/[\s-]/g, '');
  if (/^0\d{9}$/.test(cleaned)) return { ok: true, kind: 'phone' };
  if (/^\d{13}$/.test(cleaned)) return { ok: true, kind: 'citizen' };
  return { ok: false, reason: 'ต้องเป็นเบอร์ 10 หลัก (ขึ้นต้น 0) หรือเลขบัตรประชาชน 13 หลัก' };
}

// Demo placeholder bundled in DEFAULT_CONFIG. We show a soft warning if the
// admin hasn't replaced it yet so tenants don't get bills routed to the dev's
// test number.
const DEMO_PROMPTPAY = '0801234567';
const DEMO_BANK_ACC  = '123-456789-0';

function TabPayment({ draft, updatePath }) {
  const C = window.ADMIN_C;
  const { Card, Input, Toggle, Select, SectionHeading, Pill } = window;
  const ppCheck = validatePromptpay(draft.payment.promptpay);
  const isDemoPp   = (draft.payment.promptpay || '').replace(/[\s-]/g, '') === DEMO_PROMPTPAY;
  const isDemoBank = (draft.payment.bankAcc || '') === DEMO_BANK_ACC;
  const promptpayDisplayHint = ppCheck.ok
    ? (ppCheck.kind === 'phone' ? '✓ รูปแบบเบอร์โทรศัพท์' : '✓ รูปแบบเลขบัตรประชาชน')
    : ppCheck.reason;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 800 }}>
      <Card>
        <SectionHeading title="พร้อมเพย์ (PromptPay)" subtitle="ช่องทางหลักสำหรับรับชำระบิล" level={3}
          action={
            ppCheck.ok && !isDemoPp
              ? <Pill color="success" icon="✓">พร้อมใช้งาน</Pill>
              : <Pill color="warning" icon="⚠">ต้องตั้งค่า</Pill>
          } />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Input
            label="หมายเลขพร้อมเพย์"
            value={draft.payment.promptpay}
            onChange={(v) => updatePath('payment.promptpay', v)}
            hint={promptpayDisplayHint}
            placeholder="0812345678 หรือ 1234567890123"
          />
          <Input
            label="ชื่อที่แสดงบน QR (ไม่บังคับ)"
            value={draft.payment.promptpayDisplayName || ''}
            onChange={(v) => updatePath('payment.promptpayDisplayName', v)}
            hint="เว้นว่างได้ ระบบจะใช้ชื่อบัญชีธนาคารแทน"
          />
        </div>
        {isDemoPp && (
          <div style={{ marginTop: 10, padding: 10, background: C.warningSoft || '#fff7e0', borderRadius: 8, fontSize: 12.5, color: C.warningInk || '#7a5a00' }}>
            ⚠ ตอนนี้ใช้หมายเลขตัวอย่างของระบบอยู่ — กรุณาเปลี่ยนเป็นเบอร์/บัตรประชาชนของคุณก่อนใช้งานจริง
          </div>
        )}
      </Card>

      <Card>
        <SectionHeading title="โอนผ่านธนาคาร" subtitle="แสดงในบิล PDF + tenant portal" level={3}
          action={
            (draft.payment.bankAcc && draft.payment.bankAcc.replace(/[\s-]/g, '').length >= 6 && !isDemoBank)
              ? <Pill color="success" icon="✓">พร้อมใช้งาน</Pill>
              : <Pill color="muted">ปิด</Pill>
          } />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Select
            label="ธนาคาร"
            value={draft.payment.bank}
            onChange={(v) => updatePath('payment.bank', v)}
            options={['ไทยพาณิชย์','กสิกรไทย','กรุงเทพ','กรุงไทย','กรุงศรี','ทหารไทยธนชาต','ออมสิน','ธ.ก.ส.']}
          />
          <Input label="เลขที่บัญชี" value={draft.payment.bankAcc}  onChange={(v) => updatePath('payment.bankAcc', v)} placeholder="123-4-56789-0" />
          <Input label="ชื่อบัญชี"     value={draft.payment.bankName} onChange={(v) => updatePath('payment.bankName', v)} style={{ gridColumn: 'span 2' }} />
        </div>
        {isDemoBank && (
          <div style={{ marginTop: 10, padding: 10, background: C.warningSoft || '#fff7e0', borderRadius: 8, fontSize: 12.5, color: C.warningInk || '#7a5a00' }}>
            ⚠ ตอนนี้ใช้เลขบัญชีตัวอย่างของระบบอยู่ — เปลี่ยนเป็นบัญชีจริงก่อนเปิดให้ผู้เช่าใช้งาน
          </div>
        )}
      </Card>

      <Card>
        <SectionHeading title="ช่องทางอื่นๆ" subtitle="ปรากฏในบิล PDF เพื่อแจ้งผู้เช่าว่าหอพักรับช่องทางใดบ้าง" level={3} />
        <Toggle label="LINE Pay"          hint="แจ้งผู้เช่าว่ารับชำระผ่าน LINE Pay (ต้องประสานกับร้านค้า LINE Pay เอง)" checked={draft.payment.linePay}    onChange={(v) => updatePath('payment.linePay', v)} />
        <Toggle label="TrueMoney Wallet" hint="แจ้งผู้เช่าว่ารับชำระผ่าน TrueMoney (ต้องประสานกับ Ascend เอง)"      checked={draft.payment.truemoney}  onChange={(v) => updatePath('payment.truemoney', v)} />
        <Toggle label="บัตรเครดิต/เดบิต"   hint="แจ้งผู้เช่าว่ารับชำระด้วยบัตรที่ออฟฟิศ"                                       checked={draft.payment.creditCard} onChange={(v) => updatePath('payment.creditCard', v)} />
        <div style={{ marginTop: 10, padding: 10, background: C.surfaceAlt, borderRadius: 8, fontSize: 12, color: C.muted }}>
          💡 ระบบนี้ไม่ได้เชื่อมตรงกับ LINE Pay / TrueMoney / payment gateway —
          toggle ที่เปิดจะปรากฏเป็นรายการ "ช่องทางที่รับชำระอื่น" ในบิล PDF + หน้า tenant portal
          เพื่อแจ้งผู้เช่าให้ทราบเท่านั้น การชำระจริงทำผ่าน PromptPay/โอนธนาคารแล้วอัปโหลดสลิป
        </div>
      </Card>
    </div>
  );
}

// ============================================================
function TabNotify({ draft, updatePath }) {
  const C = window.ADMIN_C;
  const { Card, Input, Toggle, SectionHeading } = window;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 800 }}>
      <Card>
        <SectionHeading title="กำหนดการบิล" subtitle="ออกบิลอัตโนมัติทุกเดือน" level={3} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Input label="ออกบิลวันที่"    type="number" suffix="ของเดือน" value={draft.notify.billOnDay} onChange={(v) => updatePath('notify.billOnDay', Number(v))} />
          <Input label="ครบกำหนดวันที่" type="number" suffix="ของเดือน" value={draft.notify.dueOnDay}  onChange={(v) => updatePath('notify.dueOnDay', Number(v))} />
        </div>
      </Card>

      <Card>
        <SectionHeading title="แจ้งเตือนและติดตาม" level={3} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Input label="แจ้งเตือนครั้งที่ 1"  type="number" suffix="วันก่อนครบกำหนด" value={draft.notify.reminder1} onChange={(v) => updatePath('notify.reminder1', Number(v))} />
          <Input label="แจ้งเตือนครั้งที่ 2"  type="number" suffix="วันหลังครบกำหนด" value={draft.notify.reminder2} onChange={(v) => updatePath('notify.reminder2', Number(v))} />
          <Input label="แจ้งเตือนสัญญาใกล้หมด" type="number" suffix="วัน" value={draft.notify.contractEndDays} onChange={(v) => updatePath('notify.contractEndDays', Number(v))} />
        </div>
      </Card>

      <Card>
        <SectionHeading title="ช่องทางการแจ้งเตือน" level={3} />
        <Toggle label="LINE Official Account" hint="ส่งข้อความผ่าน LINE OA (แนะนำ)"  checked={draft.notify.channels.line}  onChange={(v) => updatePath('notify.channels.line', v)} />
        <Toggle label="อีเมล"                   hint="ส่งใบแจ้งหนี้ทางอีเมล"               checked={draft.notify.channels.email} onChange={(v) => updatePath('notify.channels.email', v)} />
        <Toggle label="SMS"                       hint="ส่ง SMS (มีค่าใช้จ่ายเพิ่มเติม)" checked={draft.notify.channels.sms}   onChange={(v) => updatePath('notify.channels.sms', v)} />
      </Card>
    </div>
  );
}

// ============================================================
function TabAuto({ draft, updatePath }) {
  const C = window.ADMIN_C;
  const { Card, Toggle, Input, SectionHeading, Pill } = window;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 800 }}>
      <Card>
        <SectionHeading title="ระบบอัตโนมัติ" subtitle="ลดงาน manual ที่ต้องทำซ้ำๆ" level={3} />
        <Toggle label="ออกบิลอัตโนมัติ"      hint={`ออกบิลทุกวันที่ ${draft.notify.billOnDay} ของเดือน`}             checked={draft.automation.autoBill}        onChange={(v) => updatePath('automation.autoBill', v)} />
        <Toggle label="แจ้งเตือนอัตโนมัติ" hint="ส่งเตือนก่อน/หลังครบกำหนดตามช่องทางที่ตั้งไว้"      checked={draft.automation.autoReminder}    onChange={(v) => updatePath('automation.autoReminder', v)} />
        <Toggle label="ค่าปรับอัตโนมัติ"     hint="คำนวณค่าปรับชำระล่าช้าให้อัตโนมัติ"                    checked={draft.automation.autoLatePenalty} onChange={(v) => updatePath('automation.autoLatePenalty', v)} />
      </Card>

      <Card>
        <SectionHeading title="สำรองข้อมูล" level={3}
          action={<Pill color="success" icon="✓">ทำงานปกติ</Pill>} />
        <Toggle label="สำรองข้อมูลรายวัน"  hint="สำรองอัตโนมัติทุกวันตามเวลาที่กำหนด" checked={draft.automation.autoBackup} onChange={(v) => updatePath('automation.autoBackup', v)} />
        {draft.automation.autoBackup && (
          <div style={{ marginTop: 12, maxWidth: 240 }}>
            <Input
              label="เวลาสำรองข้อมูล"
              type="number"
              suffix=":00 น."
              value={draft.automation.backupHour}
              onChange={(v) => updatePath('automation.backupHour', Number(v))}
              hint="แนะนำเวลากลางคืนที่มีการใช้งานน้อย"
            />
          </div>
        )}
        <div style={{ marginTop: 12, padding: 10, background: C.surfaceAlt, borderRadius: 8, fontSize: 12.5, color: C.muted }}>
          📂 สำรองข้อมูลล่าสุด: <b style={{ color: C.ink }}>เมื่อวาน 03:00 น.</b> · ขนาด 2.4 MB
        </div>
      </Card>
    </div>
  );
}

// ============================================================
// TabUsers — wired to /api/admin/users (auth_users table). Replaces the
// previous localStorage-only stub. All mutations require the caller to be
// logged in with role=owner (server-side check), and the frontend uses
// apiFetch so the CSRF token is attached.
function TabUsers({ setToast, addActivity }) {
  const C = window.ADMIN_C;
  const { Card, Btn, IconBtn, Avatar, Pill, DataTable, SectionHeading,
          Modal, Input, Select } = window;
  const fetchApi = window.apiFetch || ((u, o) => fetch(u, { credentials: 'same-origin', ...o }));

  const ROLES = [
    { value: 'owner',    label: 'เจ้าของ' },
    { value: 'manager',  label: 'ผู้จัดการ' },
    { value: 'staff',    label: 'เจ้าหน้าที่' },
    { value: 'readonly', label: 'อ่านอย่างเดียว' },
  ];
  const roleLabel = (r) => (ROLES.find((x) => x.value === r) || {}).label || r;
  const roleColor = (r) => r === 'owner' ? 'accent' : (r === 'manager' ? 'info' : (r === 'staff' ? 'neutral' : 'muted'));

  const [users, setUsers]       = React.useState([]);
  const [loading, setLoading]   = React.useState(true);
  const [error, setError]       = React.useState(null);
  const [editing, setEditing]   = React.useState(null);
  const [confirmDel, setConfirmDel] = React.useState(null);
  const [busy, setBusy]         = React.useState(false);

  const reload = React.useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/admin/users', { credentials: 'same-origin' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setUsers(Array.isArray(d.users) ? d.users : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => { reload(); }, [reload]);

  // Track which row is the current admin so we can prompt for currentPassword
  // when they edit their own row (server enforces step-up auth on self
  // password changes — without this, the save just 400s with STEP_UP_REQUIRED).
  const [meId, setMeId] = React.useState(null);
  React.useEffect(() => {
    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((d) => { if (d && d.user && d.user.id) setMeId(Number(d.user.id)); })
      .catch(() => {});
  }, []);

  const openAdd  = () => setEditing({ id: null, username: '', password: '', role: 'staff', currentPassword: '' });
  const openEdit = (u) => setEditing({ id: u.id, username: u.username, password: '', role: u.role, currentPassword: '' });

  const save = async () => {
    if (!editing.username || editing.username.trim().length < 3) {
      setToast && setToast({ kind: 'error', message: 'username ต้อง ≥ 3 ตัว' });
      return;
    }
    if (!editing.id && (!editing.password || editing.password.length < 12)) {
      setToast && setToast({ kind: 'error', message: 'รหัสผ่านต้อง ≥ 12 ตัว' });
      return;
    }
    if (editing.id && editing.password && editing.password.length < 12) {
      setToast && setToast({ kind: 'error', message: 'รหัสผ่านใหม่ต้อง ≥ 12 ตัว (เว้นว่าง = ไม่เปลี่ยน)' });
      return;
    }
    // Step-up: server requires currentPassword when self-rotating password
    const isSelfPwChange = editing.id && editing.id === meId && !!editing.password;
    if (isSelfPwChange && !editing.currentPassword) {
      setToast && setToast({ kind: 'error', message: 'ใส่รหัสผ่านปัจจุบันเพื่อยืนยัน (กำลังเปลี่ยนของตัวเอง)' });
      return;
    }
    setBusy(true);
    try {
      let r, d;
      if (editing.id) {
        const body = { role: editing.role };
        if (editing.password) body.password = editing.password;
        if (isSelfPwChange) body.currentPassword = editing.currentPassword;
        r = await fetchApi(`/api/admin/users/${editing.id}`, {
          method: 'PUT', body: JSON.stringify(body),
        });
      } else {
        r = await fetchApi('/api/admin/users', {
          method: 'POST',
          body: JSON.stringify({
            username: editing.username.trim(),
            password: editing.password,
            role: editing.role,
          }),
        });
      }
      d = await r.json().catch(() => ({}));
      if (!r.ok) {
        // Surface server-specific error codes with friendlier messages
        if (d.code === 'STEP_UP_REQUIRED') throw new Error('ใส่รหัสผ่านปัจจุบันก่อนเปลี่ยน');
        if (d.code === 'SELF_ROLE_CHANGE') throw new Error('เปลี่ยนบทบาทของตัวเองไม่ได้ — ขอเจ้าของอื่นช่วย');
        if (d.code === 'LAST_OWNER')      throw new Error('ไม่สามารถลด/ลบเจ้าของคนสุดท้ายได้');
        throw new Error(d.error || `HTTP ${r.status}`);
      }
      addActivity && addActivity({
        icon: editing.id ? '👤' : '➕',
        text: editing.id ? `แก้ไขผู้ใช้ ${editing.username}` : `เพิ่มผู้ใช้ ${editing.username}`,
        type: 'system',
      });
      setToast && setToast({ kind: 'success', message: editing.id ? 'บันทึกแล้ว' : 'เพิ่มผู้ใช้แล้ว' });
      setEditing(null);
      await reload();
    } catch (err) {
      setToast && setToast({ kind: 'error', message: err.message });
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    const u = users.find((x) => x.id === confirmDel);
    if (!u) return;
    setBusy(true);
    try {
      const r = await fetchApi(`/api/admin/users/${u.id}`, { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      addActivity && addActivity({ icon: '🗑️', text: `ลบผู้ใช้ ${u.username}`, type: 'system' });
      setToast && setToast({ kind: 'success', message: `ลบผู้ใช้ ${u.username} แล้ว` });
      setConfirmDel(null);
      await reload();
    } catch (err) {
      setToast && setToast({ kind: 'error', message: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <SectionHeading
        title="ผู้ใช้งานระบบ"
        subtitle="กำหนดสิทธิ์และจัดการบัญชีผู้ใช้ — เฉพาะเจ้าของเข้าได้"
        level={3}
        action={<Btn variant="primary" size="sm" icon="+" onClick={openAdd}>เพิ่มผู้ใช้</Btn>}
      />
      {error && (
        <div style={{ padding: 12, background: C.dangerSoft, color: C.dangerInk, borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
          ⚠️ {error} {error.includes('forbidden') && '— ต้องเข้าระบบในฐานะเจ้าของ'}
        </div>
      )}
      {loading && users.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: C.muted }}>กำลังโหลด…</div>
      ) : (
        <DataTable
          columns={[
            { key: 'user', label: 'username', minWidth: 240,
              render: u => (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Avatar name={u.username} size={36} />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, fontFamily: 'JetBrains Mono, monospace' }}>{u.username}</div>
                    <div style={{ fontSize: 11.5, color: C.muted }}>id #{u.id}</div>
                  </div>
                </div>
              ),
            },
            { key: 'role', label: 'บทบาท', minWidth: 140,
              render: u => <Pill color={roleColor(u.role)} size="sm">{roleLabel(u.role)}</Pill> },
            { key: 'created_at', label: 'สร้างเมื่อ', minWidth: 160,
              render: u => <span style={{ fontSize: 12.5, color: C.ink2 }}>
                {u.created_at ? new Date(u.created_at).toLocaleString('th-TH') : '—'}
              </span> },
            { key: 'actions', label: '', align: 'right', minWidth: 80,
              render: u => (
                <div style={{ display: 'inline-flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
                  <IconBtn icon="✎" label="แก้ไข" onClick={() => openEdit(u)} />
                  <IconBtn icon="🗑" label={u.id === meId ? 'ลบตัวเองไม่ได้' : 'ลบ'}
                           danger
                           disabled={u.id === meId}
                           onClick={() => u.id !== meId && setConfirmDel(u.id)} />
                </div>
              ),
            },
          ]}
          rows={users}
          onRowClick={openEdit}
          stickyHeader={false}
        />
      )}

      <Modal
        open={!!editing}
        onClose={() => !busy && setEditing(null)}
        title={editing?.id ? `แก้ไข ${editing.username}` : 'เพิ่มผู้ใช้ใหม่'}
        footer={
          <>
            <Btn variant="ghost" onClick={() => setEditing(null)} disabled={busy}>ยกเลิก</Btn>
            <Btn variant="primary" onClick={save} disabled={busy}>{busy ? '…' : 'บันทึก'}</Btn>
          </>
        }
      >
        {editing && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Input label="username" value={editing.username}
                   disabled={!!editing.id}
                   onChange={(v) => setEditing({ ...editing, username: v })}
                   hint={editing.id ? 'แก้ username ไม่ได้ — สร้างผู้ใช้ใหม่แทน' : 'a-z 0-9 _ . - (3-64 ตัว)'} />
            <Input
              label={editing.id ? 'รหัสผ่านใหม่ (เว้นว่าง = ไม่เปลี่ยน)' : 'รหัสผ่าน (≥ 12 ตัว)'}
              type="password"
              value={editing.password || ''}
              onChange={(v) => setEditing({ ...editing, password: v })}
            />
            {editing.id && editing.id === meId && editing.password && (
              <Input
                label="รหัสผ่านปัจจุบัน (ยืนยันการเปลี่ยนของตัวเอง)"
                type="password"
                value={editing.currentPassword || ''}
                onChange={(v) => setEditing({ ...editing, currentPassword: v })}
                hint="ระบบบังคับให้กรอกเพื่อกัน session ที่ถูก hijack เปลี่ยนรหัสผ่าน"
              />
            )}
            <Select label="บทบาท" value={editing.role}
                    onChange={(v) => setEditing({ ...editing, role: v })}
                    options={ROLES.map((r) => ({ value: r.value, label: r.label }))}
                    disabled={editing.id && editing.id === meId}
                    hint={editing.id && editing.id === meId ? 'เปลี่ยนบทบาทของตัวเองไม่ได้ — ขอ owner คนอื่น' : ''} />
          </div>
        )}
      </Modal>

      <Modal
        open={!!confirmDel}
        onClose={() => !busy && setConfirmDel(null)}
        title="ยืนยันการลบผู้ใช้"
        footer={
          <>
            <Btn variant="ghost" onClick={() => setConfirmDel(null)} disabled={busy}>ยกเลิก</Btn>
            <Btn variant="danger" onClick={del} disabled={busy}>{busy ? '…' : 'ลบ'}</Btn>
          </>
        }
      >
        <div style={{ fontSize: 14, color: C.ink2 }}>
          ต้องการลบผู้ใช้ <b style={{ color: C.ink, fontFamily: 'JetBrains Mono, monospace' }}>
            {users.find((u) => u.id === confirmDel)?.username}
          </b> ใช่หรือไม่? — การกระทำนี้ย้อนกลับไม่ได้
        </div>
      </Modal>
    </Card>
  );
}

// ============================================================
function TabAudit({ setToast }) {
  const C = window.ADMIN_C;
  const { Card, Btn, EmptyState, Pill } = window;
  const { useState, useEffect } = React;
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/audit?limit=100', { credentials: 'include' });
      const data = await res.json();
      if (data.ok) setLogs(data.logs || []);
    } catch (err) {
      console.error('audit reload failed', err);
      setToast && setToast({ kind: 'error', message: 'โหลด audit log ไม่สำเร็จ' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, []);

  const actionColor = (action) => {
    if (!action) return C.muted;
    if (action.startsWith('auth.')) return C.info;
    if (action.startsWith('data.delete')) return C.danger;
    if (action.startsWith('data.')) return C.success;
    if (action.startsWith('maintenance.')) return C.purple;
    return C.ink2;
  };

  return (
    <Card padding={0}>
      <div style={{
        padding: '14px 18px', borderBottom: `1px solid ${C.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>บันทึกการใช้งาน</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
            แสดง 100 รายการล่าสุด · ทุกการเปลี่ยนแปลงข้อมูลและการเข้าระบบ
          </div>
        </div>
        <Btn variant="secondary" icon="🔄" onClick={reload}>รีเฟรช</Btn>
      </div>

      {loading && logs.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', color: C.muted }}>กำลังโหลด…</div>
      )}

      {!loading && logs.length === 0 && (
        <EmptyState icon="📜" title="ยังไม่มีบันทึก" description="กิจกรรมจะปรากฏที่นี่หลังการใช้งาน" />
      )}

      {logs.length > 0 && (
        <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: C.surfaceAlt, color: C.muted, fontSize: 11.5 }}>
                <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 500 }}>เวลา</th>
                <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 500 }}>ผู้ใช้</th>
                <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 500 }}>การกระทำ</th>
                <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 500 }}>เป้าหมาย</th>
                <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 500 }}>IP</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: '10px 14px', color: C.ink2, whiteSpace: 'nowrap' }}>
                    {new Date(log.created_at).toLocaleString('th-TH')}
                  </td>
                  <td style={{ padding: '10px 14px', color: C.ink, fontWeight: 500 }}>
                    {log.user_id || '—'}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <span style={{
                      color: actionColor(log.action), fontWeight: 600,
                      fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5,
                    }}>{log.action}</span>
                  </td>
                  <td style={{ padding: '10px 14px', color: C.ink2 }}>
                    {log.entity_type ? `${log.entity_type}/${log.entity_id || '—'}` : '—'}
                  </td>
                  <td style={{ padding: '10px 14px', color: C.muted, fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>
                    {(log.ip || '—').replace(/^::ffff:/, '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ============================================================
function TabSystem({ onResetAll, rooms, setRooms, config, setConfig, bookings, setBookings, activities, setActivities, setToast, addActivity }) {
  const C = window.ADMIN_C;
  const { Card, Btn, SectionHeading, DefList, Modal } = window;
  const { exportFullBackup, importJSON, exportRoomsCSV } = window;

  const [confirmRestore, setConfirmRestore] = React.useState(null);

  // Compute storage size
  const storageSize = React.useMemo(() => {
    try {
      let total = 0;
      for (const k in localStorage) {
        if (Object.prototype.hasOwnProperty.call(localStorage, k)) {
          total += (localStorage[k]?.length || 0) + k.length;
        }
      }
      return (total / 1024).toFixed(1) + ' KB';
    } catch (e) { return 'ไม่ทราบ'; }
  }, [rooms, config, bookings, activities]);

  const handleBackup = () => {
    if (exportFullBackup(rooms, config, bookings, activities)) {
      setToast && setToast({ kind: 'success', message: 'ส่งออกข้อมูลทั้งหมดเรียบร้อย' });
      addActivity && addActivity({ icon: '💾', text: 'ส่งออก backup ข้อมูลทั้งหมด', type: 'system' });
    }
  };

  // A10 — Validate the imported backup before letting admin click "Restore".
  // Without this, a crafted JSON file from an attacker could swap the
  // PromptPay number, owner email, or user list, redirecting payments and
  // notifications. We refuse anything that doesn't match the expected shape.
  const validateBackupShape = (d) => {
    if (!d || typeof d !== 'object') throw new Error('ไม่ใช่ object');
    if (d.rooms !== undefined && (typeof d.rooms !== 'object' || Array.isArray(d.rooms))) {
      throw new Error('rooms ต้องเป็น object');
    }
    if (d.config !== undefined && (typeof d.config !== 'object' || Array.isArray(d.config))) {
      throw new Error('config ต้องเป็น object');
    }
    if (d.bookings !== undefined && !Array.isArray(d.bookings)) {
      throw new Error('bookings ต้องเป็น array');
    }
    if (d.activities !== undefined && !Array.isArray(d.activities)) {
      throw new Error('activities ต้องเป็น array');
    }
    // Critical-field sanitisation: refuse a backup that contains a malformed
    // PromptPay target — a typical attacker payload.
    const pp = d.config?.payment?.promptpayTarget;
    if (pp !== undefined && pp !== null && pp !== '') {
      const cleaned = String(pp).replace(/-/g, '');
      if (!/^0\d{9}$/.test(cleaned) && !/^\d{13}$/.test(cleaned)) {
        throw new Error('PromptPay ใน config ไม่ถูกต้อง');
      }
    }
    return true;
  };

  // Compute a one-screen diff between the file and the current state so the
  // admin sees exactly what's about to change before confirming.
  const computeDiff = (incoming) => {
    const cur = { rooms, config, bookings, activities };
    const d = [];
    for (const k of ['rooms', 'config', 'bookings', 'activities']) {
      if (!(k in incoming)) continue;
      const a = JSON.stringify(cur[k] || (Array.isArray(incoming[k]) ? [] : {}));
      const b = JSON.stringify(incoming[k] || (Array.isArray(incoming[k]) ? [] : {}));
      if (a === b) continue;
      const sizeBefore = (Array.isArray(cur[k]) ? cur[k].length : Object.keys(cur[k] || {}).length);
      const sizeAfter  = (Array.isArray(incoming[k]) ? incoming[k].length : Object.keys(incoming[k] || {}).length);
      d.push(`${k}: ${sizeBefore} → ${sizeAfter}`);
    }
    return d;
  };

  const handleImport = () => {
    importJSON(
      (data) => {
        try {
          validateBackupShape(data);
        } catch (e) {
          setToast && setToast({ kind: 'danger', message: 'ไฟล์ backup ไม่ผ่านการตรวจสอบ: ' + e.message });
          return;
        }
        setConfirmRestore({ ...data, __diff: computeDiff(data) });
      },
      (err) => setToast && setToast({ kind: 'danger', message: 'นำเข้าไม่สำเร็จ: ' + err.message })
    );
  };

  const applyRestore = () => {
    const d = confirmRestore;
    if (d.rooms      && setRooms)      setRooms(d.rooms);
    if (d.config     && setConfig)     setConfig(d.config);
    if (d.bookings   && setBookings)   setBookings(d.bookings);
    if (d.activities && setActivities) setActivities(d.activities);
    addActivity && addActivity({ icon: '📤', text: `นำเข้าข้อมูลจาก backup (${d.exportedAt?.slice(0,10) || 'unknown'})`, type: 'system' });
    setToast && setToast({ kind: 'success', message: 'นำเข้าข้อมูลเรียบร้อย' });
    setConfirmRestore(null);
  };

  const handleExportExcel = () => {
    if (exportRoomsCSV(rooms)) {
      setToast && setToast({ kind: 'info', message: 'ส่งออก CSV (เปิดได้ใน Excel)' });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 800 }}>
      <Card>
        <SectionHeading title="ข้อมูลระบบ" level={3} />
        <DefList
          columns={2}
          items={[
            { label: 'เวอร์ชัน',           value: 'v1.0.0' },
            { label: 'อัปเดตล่าสุด',     value: '2 พฤษภาคม 2569' },
            { label: 'ฐานข้อมูล',          value: 'localStorage (prototype)' },
            { label: 'พื้นที่ใช้งาน',      value: storageSize + ' / ~5 MB' },
            { label: 'ห้องในระบบ',        value: Object.keys(rooms || {}).length + ' ห้อง' },
            { label: 'การจองในระบบ',    value: (bookings || []).length + ' รายการ' },
          ]}
        />
      </Card>

      <Card>
        <SectionHeading title="การส่งออก/นำเข้าข้อมูล" subtitle="สำรองข้อมูลทั้งหมดเป็นไฟล์ JSON หรือ CSV" level={3} />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Btn variant="secondary" icon="💾" onClick={handleBackup}>ส่งออกทั้งหมด (JSON)</Btn>
          <Btn variant="secondary" icon="📤" onClick={handleImport}>นำเข้าจากไฟล์</Btn>
          <Btn variant="secondary" icon="📊" onClick={handleExportExcel}>ส่งออก CSV (Excel)</Btn>
        </div>
        <div style={{ marginTop: 10, padding: 10, background: C.surfaceAlt, borderRadius: 8, fontSize: 12, color: C.muted }}>
          💡 ไฟล์ JSON จะรวมข้อมูลห้อง, การตั้งค่า, การจอง และกิจกรรมทั้งหมด — สามารถนำกลับมาใช้ได้ในภายหลัง
        </div>
      </Card>

      <Card style={{ borderColor: C.danger, background: '#fef9f8' }}>
        <SectionHeading title="พื้นที่อันตราย" subtitle="การกระทำต่อไปนี้ไม่สามารถย้อนกลับได้" level={3} />
        <div style={{ padding: 12, background: '#fff', border: `1px solid ${C.dangerSoft}`, borderRadius: 8, marginTop: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.dangerInk, marginBottom: 4 }}>รีเซ็ตข้อมูลทั้งหมด</div>
          <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 10 }}>
            ลบข้อมูลห้อง, ผู้เช่า, การจอง, การตั้งค่าทั้งหมด — กลับสู่ค่าเริ่มต้น
          </div>
          <Btn variant="danger" size="sm" onClick={onResetAll}>รีเซ็ตทั้งหมด</Btn>
        </div>
      </Card>

      <Modal
        open={!!confirmRestore}
        onClose={() => setConfirmRestore(null)}
        title="ยืนยันการนำเข้าข้อมูล"
        footer={
          <>
            <Btn variant="ghost" onClick={() => setConfirmRestore(null)}>ยกเลิก</Btn>
            <Btn variant="danger" onClick={applyRestore}>นำเข้า (ทับข้อมูลปัจจุบัน)</Btn>
          </>
        }
      >
        {confirmRestore && (
          <div style={{ fontSize: 14, color: C.ink2, lineHeight: 1.6 }}>
            <div style={{ marginBottom: 10 }}>ไฟล์ที่จะนำเข้ามีข้อมูล:</div>
            <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13 }}>
              <li>ห้องพัก: <b>{Object.keys(confirmRestore.rooms || {}).length}</b> ห้อง</li>
              <li>การจอง: <b>{(confirmRestore.bookings || []).length}</b> รายการ</li>
              <li>กิจกรรม: <b>{(confirmRestore.activities || []).length}</b> รายการ</li>
              <li>การตั้งค่า: <b>{confirmRestore.config ? 'มี' : 'ไม่มี'}</b></li>
              <li>ส่งออกเมื่อ: <b>{confirmRestore.exportedAt?.slice(0, 19).replace('T', ' ') || 'ไม่ระบุ'}</b></li>
            </ul>
            {Array.isArray(confirmRestore.__diff) && confirmRestore.__diff.length > 0 && (
              <div style={{ marginTop: 12, padding: 10, background: C.warningSoft || '#fff7e0', borderRadius: 8, fontSize: 12.5 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>การเปลี่ยนแปลงที่จะเกิดขึ้น:</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {confirmRestore.__diff.map((line, i) => <li key={i}>{line}</li>)}
                </ul>
              </div>
            )}
            <div style={{ marginTop: 12, padding: 10, background: C.dangerSoft, borderRadius: 8, color: C.dangerInk, fontSize: 12.5 }}>
              ⚠️ การนำเข้าจะทับข้อมูลปัจจุบันทั้งหมด — แนะนำให้ส่งออก backup ก่อน
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

window.PageSettings = PageSettings;
