// === admin/page-features.jsx ==============================================
// Toggle every optional feature in the system. Each row is one flag with
// an "Enable" switch and (when applicable) inline config inputs.
//
// All flags persist to app_data['baankarn_features_v1'] via PUT
// /api/admin/features. The server is the source of truth — clients fetch
// /api/features (public, enabled-only) on every page load.
// ===========================================================================

const { useState, useEffect, useMemo } = React;

function PageFeatures({ setToast }) {
  const C = window.ADMIN_C;
  const { Card, SectionHeading, Btn, Pill, PageContainer, PageHeader } = window;
  // apiFetch attaches the CSRF token + handles 401 redirects. Without it the
  // PUT to /api/admin/features 403s with "invalid CSRF token", and every
  // toggle on this page silently fails.
  const apiFetch = window.requireApiFetch ? window.requireApiFetch() : window.apiFetch;
  const [features, setFeatures] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const r = await fetch('/api/admin/features', { credentials: 'same-origin' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'load failed');
      setFeatures(d.features); setDefaults(d.defaults);
    } catch (e) { setErr(e.message); }
  }

  async function save(partial) {
    setBusy(true); setErr('');
    try {
      const r = await apiFetch('/api/admin/features', {
        method: 'PUT',
        body: JSON.stringify({ features: partial }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'save failed');
      setFeatures(d.features);
      setToast && setToast({ kind: 'success', message:'บันทึกแล้ว' });
    } catch (e) { setErr(e.message); setToast && setToast({ kind: 'error', message:e.message }); }
    finally { setBusy(false); }
  }

  // Toggling some flags has consequences that aren't reversible without
  // operator action — citizenIdEncryption OFF puts new IDs in plaintext
  // (mixing with already-encrypted rows that won't decrypt cleanly later);
  // softDelete OFF turns the next admin DELETE into a permanent FK-cascade
  // that can fail with "TENANT_HAS_REFS" or actually drop linked rows.
  // Block these toggles behind a confirm so admin can't tap them
  // accidentally.
  const DANGEROUS_OFF = {
    citizenIdEncryption: {
      title: '🔓 ปิดการเข้ารหัสเลขบัตรประชาชน',
      description:
        'เลขบัตร ปชช. ของผู้เช่าใหม่จะถูกเก็บเป็น plaintext ใน DB' +
        '\n• ข้อมูลเก่าที่ encrypted อยู่จะปนกันกับ plaintext ใหม่ (decrypt fail บางแถว)' +
        '\n• ผิด PDPA ถ้าเก็บ plaintext PII แบบจงใจ' +
        '\n\nต้องการปิดจริง ๆ ใช่หรือไม่?',
    },
    softDelete: {
      title: '🗑️ ปิด Soft Delete',
      description:
        'การลบข้อมูลครั้งต่อไปจะเป็นการลบถาวร (DELETE จาก DB จริง)' +
        '\n• tenant ที่มี bills/contracts/payments อ้างถึงจะลบไม่ได้ (FK)' +
        '\n• ของที่ลบสำเร็จไม่มีทางกู้คืน — ต้อง restore จาก backup' +
        '\n\nต้องการปิดจริง ๆ ใช่หรือไม่?',
    },
    photoUpload: {
      title: '📷 ปิดการอัปโหลดรูป',
      description:
        'รูปห้อง/ลายเซ็น/สำเนาบัตรที่มีอยู่ยังเก็บไว้ แต่ admin/tenant อัปโหลดเพิ่มไม่ได้' +
        '\n\nต้องการปิดจริง ๆ ใช่หรือไม่?',
    },
  };

  function toggle(key) {
    if (!features) return;
    const cur = features[key];
    if (!cur) return;
    const turningOff = cur.enabled === true;
    const danger = turningOff ? DANGEROUS_OFF[key] : null;
    if (danger) {
      const ok = window.confirm(`${danger.title}\n\n${danger.description}`);
      if (!ok) return;
    }
    save({ [key]: { enabled: !cur.enabled } });
  }

  function setField(key, field, value) {
    if (!features) return;
    save({ [key]: { [field]: value } });
  }

  // Compute cross-feature dependency warnings client-side. Mirrors the
  // server's checkFeatureDependencies() in healthCheck.js — kept here too so
  // the admin sees the warning IMMEDIATELY after toggling a flag, not on the
  // next /admin#health refresh.
  //
  // CRITICAL: this useMemo MUST stay above any early `return` — React's
  // Rules of Hooks require the same hook order across every render, and the
  // `if (!features)` placeholder return below otherwise skipped this hook
  // on the first render and triggered Minified React error #310 the moment
  // /api/admin/features resolved.
  const dependencyWarnings = useMemo(() => {
    if (!features) return [];
    const w = [];
    if (features.slipUpload?.enabled && !features.tenantPortal?.enabled) {
      w.push({
        flag: 'slipUpload',
        msg: 'slipUpload เปิด แต่ tenantPortal ปิด — ผู้เช่าจะ login ไม่ได้ ทำให้ upload สลิปไม่ได้',
        fix: 'เปิด tenantPortal ด้านบน',
      });
    }
    if (features.slipUpload?.enabled && features.slipUpload.requireVerification === false
        && !features.slipUpload.autoVerify
        && features.slipUpload.allowUnverifiedAutoApprove !== true) {
      w.push({
        flag: 'slipUpload.requireVerification',
        msg: 'ปิดการตรวจสอบก่อน แต่ยังไม่ได้เปิด autoVerify; ระบบจะยังส่งสลิปเข้าคิวตรวจแทนการ mark paid อัตโนมัติ',
        fix: 'เปิด autoVerify และตั้ง provider key หรือเปิด "ต้องตรวจสอบก่อน" กลับ',
      });
    }
    if (features.slipUpload?.allowUnverifiedAutoApprove === true) {
      w.push({
        flag: 'slipUpload.allowUnverifiedAutoApprove',
        msg: 'โหมด legacy นี้ให้สลิปที่ผู้เช่าอัปโหลด mark paid ได้โดยไม่มี provider/admin ตรวจ',
        fix: 'ปิดค่านี้ถ้าไม่ตั้งใจรับความเสี่ยง',
      });
    }
    if (features.accessControl?.enabled && features.accessControl?.requirePaymentForCard
        && !features.tenantPortal?.enabled) {
      w.push({
        flag: 'accessControl',
        msg: 'accessControl.requirePaymentForCard ON แต่ tenantPortal ปิด — บัตรไม่ถูก revoke เพราะ bills ไม่มี tenant_id',
        fix: 'เปิด tenantPortal เพื่อให้ระบบสร้าง tenant rows',
      });
    }
    if (features.meterIot?.enabled && features.meterIot?.mode === 'simulator') {
      w.push({
        flag: 'meterIot',
        msg: 'mode = simulator — กำลังสร้างค่ามิเตอร์เทียม (block ใน NODE_ENV=production)',
        fix: 'เปลี่ยนเป็น manual ก่อน deploy production',
      });
    }
    if (features.meterIot?.enabled && features.meterIot?.mode === 'mqtt') {
      w.push({
        flag: 'meterIot',
        msg: 'mode = mqtt ยังไม่รองรับใน build นี้ — จะไม่มี reading เข้ามาอัตโนมัติ',
        fix: 'เปลี่ยนเป็น manual และกรอกค่ามิเตอร์จากหน้า "มิเตอร์"',
      });
    }
    if (features.recurringCharges?.enabled && !features.billAutoGenerate?.enabled) {
      w.push({
        flag: 'recurringCharges',
        msg: 'recurringCharges เปิด แต่ billAutoGenerate ปิด — ต้องสร้างบิลด้วยมือถึงจะรวม recurring',
        fix: 'เปิด billAutoGenerate ถ้าต้องการให้รวมอัตโนมัติทุกเดือน',
      });
    }
    if (features.errorTracking?.enabled) {
      // We can't read secrets from frontend, so just remind the operator.
      w.push({
        flag: 'errorTracking',
        msg: 'errorTracking ON — ต้องตั้ง SENTRY_DSN ที่หน้า "ตั้งค่า API/Keys" ด้วย',
        fix: 'ดูเพิ่มที่ /admin#secrets',
        soft: true,
      });
    }
    if (features.email?.enabled) {
      w.push({
        flag: 'email',
        msg: 'email channel ON — ต้องตั้ง SMTP_HOST/USER/PASS ด้วย',
        fix: 'ดูเพิ่มที่ /admin#secrets',
        soft: true,
      });
    }
    if (features.autoBackup?.enabled) {
      w.push({
        flag: 'autoBackup',
        msg: 'autoBackup ON — ถ้าไม่ตั้ง R2 credentials backup จะอยู่บนดิสก์ container (หายเมื่อ redeploy)',
        fix: 'ดูเพิ่มที่ /admin#secrets',
        soft: true,
      });
    }
    return w;
  }, [features]);

  if (!features) {
    return (
      <PageContainer>
        <PageHeader title="ฟีเจอร์ระบบ" subtitle="เปิด/ปิดฟีเจอร์ของระบบ" />
        <Card>{err || 'กำลังโหลด…'}</Card>
      </PageContainer>
    );
  }

  // Render row helper
  const Row = ({ id, title, desc, children }) => {
    const f = features[id] || {};
    return (
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr auto', gap: 16,
        padding: '14px 0', borderBottom: '1px solid ' + C.border, alignItems: 'flex-start',
      }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14.5, marginBottom: 4 }}>{title}</div>
          <div style={{ color: C.muted, fontSize: 13, marginBottom: 8 }}>{desc}</div>
          {f.enabled && children ? (
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              {children}
            </div>
          ) : null}
        </div>
        <Toggle on={!!f.enabled} disabled={busy} onChange={() => toggle(id)} />
      </div>
    );
  };

  const Field = ({ id, field, label, type = 'text', step }) => {
    const v = (features[id] || {})[field];
    return (
      <label style={{ fontSize: 12.5, color: C.muted, display: 'flex', flexDirection: 'column' }}>
        {label}
        <input
          type={type} step={step}
          defaultValue={v ?? ''}
          onBlur={(e) => {
            let next = e.target.value;
            if (type === 'number') next = next === '' ? null : Number(next);
            if (next !== v) setField(id, field, next);
          }}
          style={{
            marginTop: 4, padding: '6px 10px', borderRadius: 6,
            border: '1px solid ' + C.border, background: C.bg, color: C.ink,
            width: type === 'number' ? 100 : 220, fontSize: 13,
          }}
        />
      </label>
    );
  };

  return (
    <PageContainer>
      <PageHeader title="ฟีเจอร์ระบบ"
        subtitle="เปิด/ปิดฟีเจอร์ของระบบ — รายการที่ปิดจะถูกบล็อกที่ฝั่ง server (503)" />
      {err ? <Card style={{ color: C.danger }}>{err}</Card> : null}

      {dependencyWarnings.length > 0 && (
        <Card style={{
          background: C.warningSoft || '#fbf1de',
          borderLeft: `4px solid ${C.warning || '#c98a2b'}`,
          marginBottom: 12,
        }}>
          <div style={{ fontFamily: 'Sora', fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
            ⚠️ ความสัมพันธ์ของ flag ที่ต้องตรวจ ({dependencyWarnings.length})
          </div>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.7, color: C.ink2 }}>
            {dependencyWarnings.map((w, i) => (
              <li key={i} style={{ opacity: w.soft ? 0.8 : 1 }}>
                <code style={{ background: 'rgba(0,0,0,0.06)', padding: '1px 5px', borderRadius: 3, fontSize: 11.5 }}>{w.flag}</code>{' '}
                {w.msg}
                <span style={{ color: C.muted, fontSize: 12, marginLeft: 6 }}>→ {w.fix}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <SectionHeading>ฝั่งผู้เช่า</SectionHeading>
        <Row id="tenantPortal"
          title="พอร์ทัลผู้เช่า (/tenant)"
          desc="ผู้เช่า login ด้วยเบอร์โทรที่ผูกกับห้อง เพื่อดูบิล แจ้งซ่อม อัปโหลดสลิป">
          <Field id="tenantPortal" field="sessionDays" label="อายุ session (วัน)" type="number" />
        </Row>
        <Row id="slipUpload"
          title="อัปโหลดสลิปชำระเงิน"
          desc="ผู้เช่าแนบสลิปแทนการโอนเงินสด แอดมินตรวจสอบก่อนอนุมัติ">
          <ToggleField id="slipUpload" field="requireVerification" label="ต้องตรวจสอบก่อน" features={features} setField={setField} />
          <ToggleField id="slipUpload" field="autoVerify" label="ตรวจสลิปอัตโนมัติ" features={features} setField={setField} />
          <SelectField id="slipUpload" field="provider" label="ผู้ให้บริการตรวจสลิป"
            options={[['slipok', 'SlipOK'], ['easyslip', 'EasySlip'], ['slip2go', 'Slip2Go']]} features={features} setField={setField} />
          <Field id="slipUpload" field="maxBytes" label="ขนาดสูงสุด (bytes)" type="number" />
          {/* Surface the provider-key requirement inline so the operator
              doesn't enable autoVerify and silently wait for verifications
              that never happen. Visible whenever autoVerify is on; the
              actual key presence is checked server-side at
              /api/admin/billing-readiness — but pointing at the right page
              from here closes the discovery loop. */}
          {features?.slipUpload?.autoVerify ? (
            <div style={{
              gridColumn: '1 / -1',
              marginTop: 6, padding: '10px 12px',
              background: '#fff7e0', border: '1px solid #f0e3a7',
              borderRadius: 6, fontSize: 12.5, lineHeight: 1.6, color: '#6b5b1a',
            }}>
              🔑 <b>autoVerify เปิดอยู่</b> — ต้องตั้ง API key ของ {features?.slipUpload?.provider === 'easyslip' ? 'EasySlip' : (features?.slipUpload?.provider === 'slip2go' ? 'Slip2Go' : 'SlipOK')} ที่{' '}
              <a href="/admin#secrets" style={{ color: '#8a6b1a', fontWeight: 600 }}>
                /admin#secrets → ตรวจสลิปอัตโนมัติ
              </a>{' '}แล้วกด "🔌 ทดสอบ" ก่อนใช้งานจริง — ถ้า key หาย สลิปจะตกเข้าคิว admin เหมือนเดิม (ไม่ auto-verify)
            </div>
          ) : null}
        </Row>
        <Row id="photoUpload"
          title="อัปโหลดรูปภาพ"
          desc="รูปห้อง / ลายเซ็นสัญญา / สำเนาบัตร">
          <Field id="photoUpload" field="maxBytes" label="ขนาดสูงสุด (bytes)" type="number" />
        </Row>
      </Card>

      <Card>
        <SectionHeading>การเงิน</SectionHeading>
        <Row id="lateFee"
          title="ค่าปรับชำระล่าช้า"
          desc="คำนวณจากยอดบิลก่อนหน้าที่เกินกำหนด">
          <Field id="lateFee" field="ratePctPerMonth" label="อัตรา %/เดือน" type="number" step="0.1" />
          <Field id="lateFee" field="gracePeriodDays" label="ผ่อนผัน (วัน)" type="number" />
        </Row>
        <Row id="vat"
          title="ภาษีมูลค่าเพิ่ม (VAT)"
          desc="คำนวณบนยอดรวมของบิล">
          <Field id="vat" field="ratePct" label="อัตรา %" type="number" step="0.1" />
        </Row>
        <Row id="recurringCharges"
          title="ค่าใช้จ่ายประจำ (parking, internet, etc.)"
          desc="ค่าใช้จ่ายต่อเนื่องผูกกับผู้เช่า/ห้อง — รวมเข้าบิลทุกเดือนอัตโนมัติ">
          <ToggleField id="recurringCharges" field="autoIncludeOnBillGen"
            label="รวมเข้าบิลอัตโนมัติเมื่อสร้างบิล"
            features={features} setField={setField} />
        </Row>
        <Row id="billAutoGenerate"
          title="ออกบิลอัตโนมัติทุกเดือน"
          desc="cron จะออกบิลตามวันที่กำหนด">
          <Field id="billAutoGenerate" field="dayOfMonth" label="วันที่ออกบิล" type="number" />
          <Field id="billAutoGenerate" field="dueDay" label="กำหนดชำระ (วัน)" type="number" />
        </Row>
      </Card>

      <Card>
        <SectionHeading>มิเตอร์ &amp; ควบคุมการเข้า-ออก</SectionHeading>
        <Row id="meterIot"
          title="ระบบมิเตอร์"
          desc="บันทึกค่าน้ำ/ไฟ + ตรวจจับความผิดปกติ (3σ)">
          <SelectField id="meterIot" field="mode" label="โหมด"
            features={features} setField={setField}
            options={[['manual', 'กรอกเอง'], ['simulator', 'จำลอง'], ['mqtt', 'MQTT (ยังไม่รองรับ)', true]]} />
          <Field id="meterIot" field="anomalySigmas" label="เกณฑ์ σ" type="number" step="0.5" />
        </Row>
        <Row id="accessControl"
          title="ควบคุมการเข้า-ออก"
          desc="บันทึก log การเข้า-ออก + RFID/QR (ทำงานร่วมกับ hardware ภายนอก)">
          <ToggleField id="accessControl" field="requirePaymentForCard"
            label="ระงับการ์ดอัตโนมัติเมื่อค้างชำระ"
            features={features} setField={setField} />
          <Field id="accessControl" field="overdueDaysThreshold"
            label="ค้างชำระเกิน (วัน) จึงระงับ" type="number" />
        </Row>
      </Card>

      <Card>
        <SectionHeading>การแจ้งเตือน</SectionHeading>
        <Row id="email"
          title="อีเมล (SMTP)"
          desc="แจ้งเตือนผ่านอีเมลเมื่อ LINE ส่งไม่สำเร็จ">
          <Field id="email" field="smtpHost" label="SMTP host" />
          <Field id="email" field="smtpPort" label="port" type="number" />
          <Field id="email" field="smtpUser" label="user" />
          <Field id="email" field="from" label="From address" />
          <div style={{ width: '100%', color: C.muted, fontSize: 12 }}>
            * รหัสผ่าน SMTP กำหนดผ่าน env <code>SMTP_PASS</code> เท่านั้น (ไม่เก็บใน DB)
          </div>
        </Row>
        <Row id="sms"
          title="SMS (สำรองช่องทาง LINE/email)"
          desc="⚠ ต้องติดตั้ง SDK ผู้ให้บริการเองก่อน (npm i twilio) แล้วตั้ง credentials ในหน้า Secrets — เปิดอย่างเดียวจะไม่ส่งข้อความ">
          <SelectField id="sms" field="provider" label="ผู้ให้บริการ"
            features={features} setField={setField}
            options={[['thsms', 'thsms.com'], ['twilio', 'Twilio']]} />
        </Row>
      </Card>

      <Card>
        <SectionHeading>UX</SectionHeading>
        <Row id="darkMode"
          title="โหมดมืด"
          desc="ใช้ในพอร์ทัลผู้เช่า (/tenant) เท่านั้น — admin console ใช้ธีมเดียว" />
        <Row id="i18n"
          title="หลายภาษา (i18n)"
          desc="เปลี่ยนภาษาไทย/อังกฤษ ในพอร์ทัลผู้เช่า">
          <SelectField id="i18n" field="defaultLocale" label="ภาษาเริ่มต้น"
            features={features} setField={setField}
            options={[['th', 'ไทย'], ['en', 'English']]} />
        </Row>
      </Card>

      <Card>
        <SectionHeading>ความปลอดภัย / ปฏิบัติการ</SectionHeading>
        <Row id="citizenIdEncryption"
          title="เข้ารหัสเลขบัตร ปชช. (AES-256-GCM)"
          desc="เก็บข้อมูล PII แบบเข้ารหัส (ต้องตั้ง CITIZEN_ID_KEY หรือ SESSION_SECRET)" />
        <Row id="softDelete"
          title="Soft delete"
          desc="ลบข้อมูลแล้วเก็บ deleted_at แทนการลบจริง" />
        <Row id="errorTracking"
          title="Error tracking (Sentry)"
          desc="ต้องตั้ง SENTRY_DSN ใน env" />
        <Row id="autoBackup"
          title="Backup อัตโนมัติ"
          desc="dump DB เป็น JSON ทุกวันตามเวลา UTC ที่กำหนด">
          <Field id="autoBackup" field="hourUtc" label="ชั่วโมง UTC" type="number" />
          <Field id="autoBackup" field="retainDays" label="เก็บไว้ (วัน)" type="number" />
        </Row>
      </Card>
    </PageContainer>
  );
}

function Toggle({ on, disabled, onChange }) {
  const C = window.ADMIN_C;
  return (
    <button onClick={onChange} disabled={disabled}
      style={{
        width: 46, height: 26, borderRadius: 999, border: 0,
        background: on ? C.accent : C.border,
        position: 'relative', cursor: disabled ? 'not-allowed' : 'pointer',
        flexShrink: 0,
      }}>
      <span style={{
        position: 'absolute', top: 3, left: on ? 22 : 3,
        width: 20, height: 20, borderRadius: '50%',
        background: '#fff', transition: 'left .15s',
      }} />
    </button>
  );
}

function ToggleField({ id, field, label, features, setField }) {
  const C = window.ADMIN_C;
  const on = !!(features[id] && features[id][field]);
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: C.ink2 }}>
      <input type="checkbox" checked={on} onChange={(e) => setField(id, field, e.target.checked)} />
      {label}
    </label>
  );
}

function SelectField({ id, field, label, options, features, setField }) {
  const C = window.ADMIN_C;
  const v = (features[id] || {})[field] || '';
  return (
    <label style={{ fontSize: 12.5, color: C.muted, display: 'flex', flexDirection: 'column' }}>
      {label}
      <select value={v} onChange={(e) => setField(id, field, e.target.value)}
        style={{
          marginTop: 4, padding: '6px 10px', borderRadius: 6,
          border: '1px solid ' + C.border, background: C.bg, color: C.ink, fontSize: 13,
        }}>
        {options.map(([val, lab, disabled]) => <option key={val} value={val} disabled={!!disabled}>{lab}</option>)}
      </select>
    </label>
  );
}

window.PageFeatures = PageFeatures;
