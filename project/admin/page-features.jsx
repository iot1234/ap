// === admin/page-features.jsx ==============================================
// Toggle every optional feature in the system. Each row is one flag with
// an "Enable" switch and (when applicable) inline config inputs.
//
// All flags persist to app_data['baankarn_features_v1'] via PUT
// /api/admin/features. The server is the source of truth — clients fetch
// /api/features (public, enabled-only) on every page load.
// ===========================================================================

const { useState, useEffect, useMemo } = React;

const FEATURE_HELP = {
  tenantPortal: [
    'เปิดแล้วผู้เช่าเข้า /tenant ได้ ดูบิล แจ้งซ่อม และอัปโหลดสลิปตามสิทธิ์ที่เกี่ยวข้อง',
    'ปิดแล้ว endpoint ฝั่ง tenant จะตอบ 503 และฟีเจอร์ที่พึ่งพา tenant portal เช่น slip upload จะใช้ไม่ได้',
  ],
  parcelNotifications: [
    'เปิดแล้ว admin บันทึกพัสดุถึงห้องและส่งแจ้งเตือนไปยังผู้เช่าผ่านช่องทางที่ตั้งไว้ได้',
    'ปิดแล้ว API จะตอบ FEATURE_DISABLED และฝั่งผู้เช่าจะไม่เห็นเมนู/ปุ่มพัสดุ',
  ],
  photoUpload: [
    'ใช้กับรูปห้อง ลายเซ็น สัญญา และเอกสารยืนยันตัวตน',
    'ปิดแล้วไฟล์เดิมยังอยู่ แต่ admin/tenant จะอัปโหลดเพิ่มไม่ได้',
  ],
  roomBooking: [
    'ควบคุมหน้าจองสาธารณะ: เปิดค่าจอง, จำนวนเงิน, เวลาล็อกห้อง และการบังคับแนบสลิป',
    'ถ้าเปิดมัดจำ ผู้จองต้องเลือกห้องจริง ระบบจะล็อกห้องชั่วคราวตามเวลาที่ตั้งไว้ และปล่อยอัตโนมัติถ้าไม่ส่งจองสำเร็จ',
  ],
  lateFee: [
    'ใช้คำนวณค่าปรับจากบิลค้างชำระจริงใน backend',
    'ถ้าปิด ระบบจะไม่เพิ่มค่าปรับในบิลใหม่ แม้บิลก่อนหน้าจะ overdue',
  ],
  vat: [
    'เปิดแล้ว backend เพิ่ม VAT ตามเปอร์เซ็นต์ที่ตั้งในบิลใหม่',
    'บิลที่ออกไปแล้วไม่ถูกคำนวณย้อนหลัง',
  ],
  recurringCharges: [
    'เปิดแล้วรายการค่าใช้จ่ายประจำ/ครั้งเดียวจะถูกดึงเข้าบิลเมื่อออกบิล',
    'ถ้าปิด รายการเดิมยังอยู่แต่ไม่ถูกนำไปคิดในรอบบิลใหม่',
  ],
  billAutoGenerate: [
    'เปิดแล้ว scheduler จะออกบิลรายเดือนตามวันที่ตั้งไว้',
    'ถ้าปิด ต้องออกบิลเองจากหน้าบิล รายการ recurring จะยังรวมได้เมื่อกดออกบิลเอง',
  ],
  meterIot: [
    'เปิดแล้วหน้ามิเตอร์และ API บันทึกค่าน้ำไฟตามรอบเดือนจะใช้งานได้',
    'โหมด MQTT ยังไม่รองรับใน build นี้ ระบบจึงปิดตัวเลือกไว้และ backend กันซ้ำอีกชั้น',
  ],
  accessControl: [
    'เปิดแล้วระบบบันทึก access log และจัดการบัตร/QR ได้',
    'ถ้าเปิดระงับบัตรเมื่อค้างชำระ ระบบจะใช้ overdue threshold เพื่อตัดสิทธิ์อัตโนมัติ',
  ],
  email: [
    'ใช้เป็นช่องทางแจ้งเตือนสำรองเมื่อ LINE ส่งไม่ได้',
    'ต้องตั้ง SMTP credentials ในหน้า Secrets/env ไม่อย่างนั้นเปิดไว้ก็ยังส่งจริงไม่ได้',
  ],
  sms: [
    'ใช้เป็นช่องทางสำรองเพิ่มเติมสำหรับแจ้งเตือนสำคัญ',
    'ต้องติดตั้ง provider/credentials เพิ่ม เปิด toggle อย่างเดียวไม่ทำให้ส่ง SMS ได้ทันที',
  ],
  darkMode: [
    'มีผลเฉพาะ tenant portal ไม่ได้เปลี่ยนธีมหน้า admin',
    'ปิดแล้วผู้เช่าจะไม่เห็นตัวเลือกโหมดมืด',
  ],
  i18n: [
    'เปิดแล้ว tenant portal ใช้ภาษาไทย/อังกฤษได้ตามค่าเริ่มต้น',
    'ปิดแล้ว UI ฝั่ง tenant จะไม่แสดงตัวเลือกภาษา',
  ],
  citizenIdEncryption: [
    'ควรเปิดไว้เสมอเพื่อเข้ารหัสเลขบัตรประชาชนก่อนเก็บลงฐานข้อมูล',
    'ปิดแล้วข้อมูลใหม่จะเสี่ยงเป็น plaintext และอาจปนกับข้อมูลเก่าที่เข้ารหัสไว้',
  ],
  softDelete: [
    'เปิดแล้วการลบข้อมูลจะเก็บ deleted_at เพื่อกู้คืน/ตรวจสอบย้อนหลังได้',
    'ปิดแล้วการลบครั้งต่อไปอาจเป็นการลบถาวรหรือชน FK กับข้อมูลบิล/สัญญา',
  ],
  errorTracking: [
    'เปิดแล้วระบบส่ง error ไป Sentry เมื่อมี SENTRY_DSN',
    'ถ้าไม่มี DSN จะไม่เกิดผลจริง ให้ตั้งค่าที่ Secrets/env ก่อน',
  ],
  autoBackup: [
    'เปิดแล้ว scheduler จะสำรองฐานข้อมูลตามชั่วโมง UTC ที่กำหนด',
    'ถ้าไม่ตั้ง R2 credentials backup อาจอยู่ใน disk ของ container และหายตอน redeploy',
  ],
  autoReconcileRooms: [
    'เปิดแล้ว scheduler ช่วยแก้ห้องค้างสถานะเฉพาะเคสที่ปลอดภัย เช่น tenant moved_out แล้วแต่ห้องยัง occupied',
    'ระบบยังแจ้งเตือน anomaly เสมอ แม้ปิด auto-fix เพื่อให้ admin ตรวจเองก่อน',
  ],
};

// `embedded` prop lets PageSettings render this component INSIDE one of
// its tabs without duplicating the outer PageContainer + PageHeader.
// When embedded=true the wrapper / header are skipped; the page still
// works standalone at /admin#features for legacy URLs / direct links.
function PageFeatures({ setToast, embedded = false, currentUser = null }) {
  const C = window.ADMIN_C;
  const { Card, SectionHeading, Btn, Pill, PageContainer, PageHeader } = window;
  // Wrap with PageContainer/PageHeader only when NOT embedded. Inside a
  // tab the parent already provides the page chrome.
  const Wrapper = embedded
    ? ({ children }) => <div>{children}</div>
    : ({ children }) => <PageContainer>{children}</PageContainer>;
  const Header = embedded
    ? () => null
    : (props) => <PageHeader {...props} />;
  // apiFetch attaches the CSRF token + handles 401 redirects. Without it the
  // PUT to /api/admin/features 403s with "invalid CSRF token", and every
  // toggle on this page silently fails.
  const apiFetch = window.requireApiFetch ? window.requireApiFetch() : window.apiFetch;
  const [features, setFeatures] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [canEdit, setCanEdit] = useState(currentUser?.role === 'owner');
  const [viewerRole, setViewerRole] = useState(currentUser?.role || '');
  // Authoritative cross-feature warnings from the server (it can read secrets
  // + carries severity). null = not provided yet / older server → fall back to
  // the client-side mirror below.
  const [serverWarnings, setServerWarnings] = useState(null);

  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!currentUser?.role) return;
    setViewerRole(currentUser.role);
    setCanEdit(currentUser.role === 'owner');
  }, [currentUser?.role]);

  async function load() {
    try {
      const r = await fetch('/api/admin/features', { credentials: 'same-origin' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'load failed');
      setFeatures(d.features); setDefaults(d.defaults);
      if (typeof d.canEdit === 'boolean') setCanEdit(d.canEdit);
      if (d.role) setViewerRole(d.role);
      setServerWarnings(Array.isArray(d.warnings) ? d.warnings : null);
    } catch (e) { setErr(e.message); }
  }

  async function save(partial) {
    if (!canEdit) {
      const message = {
        title: 'ไม่มีสิทธิ์เปิด/ปิดฟีเจอร์',
        description: 'การแก้ฟีเจอร์ระบบทำได้เฉพาะ owner เท่านั้น บัญชี manager/staff ดูค่าได้แต่บันทึกไม่ได้',
      };
      setToast && setToast({ kind: 'warning', message });
      setErr(message.description);
      return;
    }
    setBusy(true); setErr('');
    try {
      const r = await apiFetch('/api/admin/features', {
        method: 'PUT',
        body: JSON.stringify({ features: partial }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'save failed');
      setFeatures(d.features);
      // PUT now returns fresh consistency warnings — update the banner so the
      // admin sees the consequence of THIS toggle immediately.
      setServerWarnings(Array.isArray(d.warnings) ? d.warnings : null);
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
    if (!canEdit) {
      save({ [key]: { enabled: !features[key]?.enabled } });
      return;
    }
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
    if (!canEdit) {
      save({ [key]: { [field]: value } });
      return;
    }
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
    // The server's checkFeatureDependencies() is authoritative: it can read
    // secrets (so it knows whether SMTP/R2/Sentry/slip-provider keys are
    // ACTUALLY missing, not merely "enabled") and carries severity plus extra
    // checks (vat/lateFee rate=0, citizen-ID key, checkin-blocked). Prefer it
    // whenever the server returned a warnings array; fall back to this
    // client-side mirror only before the first load resolves or on an older
    // server build that doesn't return `warnings`.
    if (Array.isArray(serverWarnings)) {
      return serverWarnings.map((w) => ({
        flag: w.flag,
        msg: w.issue || w.msg || '',
        fix: w.fix || '',
        severity: w.severity || 'warning',
        soft: w.severity ? w.severity !== 'critical' : !!w.soft,
      }));
    }
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
  }, [features, serverWarnings]);

  if (!features) {
    return (
      <Wrapper>
        <Header title="ฟีเจอร์ระบบ" subtitle="เปิด/ปิดฟีเจอร์ของระบบ" />
        <Card>{err || (window.SkeletonRows ? <window.SkeletonRows count={6} /> : 'กำลังโหลด…')}</Card>
      </Wrapper>
    );
  }

  const readOnlyReason = canEdit ? '' : `บัญชี ${viewerRole || 'ปัจจุบัน'} ดูค่าได้เท่านั้น ต้องใช้ role owner เพื่อบันทึก`;
  const criticalWarnCount = dependencyWarnings.filter((w) => w.severity === 'critical').length;

  // Render row helper
  const Row = ({ id, title, desc, children }) => {
    const f = features[id] || {};
    const help = FEATURE_HELP[id] || [];
    return (
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr auto', gap: 16,
        padding: '14px 0', borderBottom: '1px solid ' + C.border, alignItems: 'flex-start',
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
            <span style={{ fontWeight: 600, fontSize: 14.5 }}>{title}</span>
            <Pill color={f.enabled ? 'success' : 'muted'} size="sm">{f.enabled ? 'เปิดอยู่' : 'ปิดอยู่'}</Pill>
          </div>
          <div style={{ color: C.muted, fontSize: 13, marginBottom: 8 }}>{desc}</div>
          {help.length ? (
            <ul style={{
              margin: '0 0 8px 0', paddingLeft: 18,
              color: C.ink2, fontSize: 12.5, lineHeight: 1.55,
            }}>
              {help.map((line, i) => <li key={i}>{line}</li>)}
            </ul>
          ) : null}
          {f.enabled && children ? (
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              {children}
            </div>
          ) : null}
          {!canEdit ? (
            <div style={{ marginTop: 8, fontSize: 12, color: C.warningInk || '#7A5A0F' }}>
              {readOnlyReason}
            </div>
          ) : null}
        </div>
        <FeatureFlagToggle
          on={!!f.enabled}
          disabled={busy || !canEdit}
          label={title}
          disabledReason={readOnlyReason}
          onChange={() => toggle(id)}
        />
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
          disabled={!canEdit || busy}
          title={!canEdit ? readOnlyReason : undefined}
          onBlur={(e) => {
            let next = e.target.value;
            if (type === 'number') next = next === '' ? null : Number(next);
            if (next !== v) setField(id, field, next);
          }}
          style={{
            marginTop: 4, padding: '6px 10px', borderRadius: 6,
            border: '1px solid ' + C.border,
            background: (!canEdit || busy) ? C.surfaceMuted || C.surfaceAlt : C.bg,
            color: C.ink,
            width: type === 'number' ? 100 : 220, fontSize: 13,
            cursor: (!canEdit || busy) ? 'not-allowed' : 'text',
          }}
        />
      </label>
    );
  };

  return (
    <Wrapper>
      <Header title="ฟีเจอร์ระบบ"
        subtitle="เปิด/ปิดฟีเจอร์ของระบบ — รายการที่ปิดจะถูกบล็อกที่ฝั่ง server (503)" />
      {err ? <Card style={{ color: C.danger }}>{err}</Card> : null}
      {!canEdit ? (
        <Card style={{
          background: C.warningSoft || '#FEF3C7',
          borderLeft: `4px solid ${C.warning || '#D97706'}`,
          marginBottom: 12,
          color: C.warningInk || '#7A5A0F',
          fontSize: 13,
          lineHeight: 1.6,
        }}>
          <b>โหมดดูอย่างเดียว</b>: {readOnlyReason}
          <div style={{ marginTop: 4 }}>
            ปุ่มเปิด/ปิดถูกปิดไว้ล่วงหน้าเพื่อกันการกดแล้วไม่เกิดผลหรือเจอ 403 หลังจากคลิก
          </div>
        </Card>
      ) : null}

      {dependencyWarnings.length > 0 && (
        <Card style={{
          background: criticalWarnCount ? (C.dangerSoft || '#fdecea') : (C.warningSoft || '#fbf1de'),
          borderLeft: `4px solid ${criticalWarnCount ? (C.danger || '#c0392b') : (C.warning || '#c98a2b')}`,
          marginBottom: 12,
        }}>
          <div style={{ fontFamily: 'IBM Plex Sans Thai', fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
            มีฟีเจอร์ที่เปิดอยู่แต่ flow ยังไม่พร้อม ({dependencyWarnings.length}{criticalWarnCount ? ` · ต้องแก้ก่อนใช้ ${criticalWarnCount}` : ''})
          </div>
          <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 10, lineHeight: 1.55 }}>
            รายการด้านล่างคือสาเหตุที่เปิด toggle แล้วผู้ใช้ยังใช้งานไม่ได้จริง หรือระบบอาจทำงานผิด flow
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {dependencyWarnings.map((w, i) => (
              <div key={i} style={{
                opacity: w.soft ? 0.9 : 1,
                padding: '10px 12px',
                borderRadius: 8,
                background: 'rgba(255,255,255,0.52)',
                border: `1px solid ${w.severity === 'critical' ? (C.danger || '#c0392b') : (C.borderSoft || C.border)}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 5 }}>
                  <span style={{
                    fontSize: 11.5,
                    fontWeight: 700,
                    color: w.severity === 'critical' ? (C.dangerInk || C.danger || '#7f1d1d') : (C.warningInk || '#7A5A0F'),
                    background: w.severity === 'critical' ? (C.dangerSoft || '#fdecea') : (C.warningSoft || '#fbf1de'),
                    padding: '2px 7px',
                    borderRadius: 999,
                  }}>
                    {w.severity === 'critical' ? 'ต้องแก้ก่อนใช้ flow' : 'ควรตรวจ'}
                  </span>
                  <code style={{ background: 'rgba(0,0,0,0.06)', padding: '1px 5px', borderRadius: 3, fontSize: 11.5 }}>{w.flag}</code>
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.6, color: C.ink2 }}>
                  <b style={{ color: C.ink }}>ปัญหา:</b> {w.msg}
                </div>
                {w.fix ? (
                  <div style={{ fontSize: 12.5, lineHeight: 1.55, color: C.muted, marginTop: 3 }}>
                    <b>แก้ไข:</b> {w.fix}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <SectionHeading title="ฝั่งผู้เช่า" />
        <Row id="tenantPortal"
          title="พอร์ทัลผู้เช่า (/tenant)"
          desc="ผู้เช่า login ด้วยเบอร์โทรที่ผูกกับห้อง เพื่อดูบิล แจ้งซ่อม อัปโหลดสลิป">
          <Field id="tenantPortal" field="sessionDays" label="อายุ session (วัน)" type="number" />
        </Row>
        <Row id="parcelNotifications"
          title="แจ้งเตือนพัสดุ"
          desc="แอดมินบันทึกพัสดุที่มาถึงห้อง ส่งแจ้งเตือนผู้เช่า และให้ผู้เช่าดูรายการพัสดุของตัวเองใน /tenant" />
        {/* slipUpload inline toggles used to live here, duplicating the
            dedicated wizard at /admin#slip-verify. Operators kept enabling
            autoVerify without setting an API key and then debugging across
            three pages (features here + secrets there + readiness elsewhere).
            Surfacing only a deep link keeps slip-verify as the single
            canonical place. Dependency warnings above (line ~125) still
            fire because they read features.slipUpload.* regardless. */}
        <div style={{
          padding: '12px 14px', marginBottom: 12,
          background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 8,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, flexWrap: 'wrap',
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>
              อัปโหลดสลิปชำระเงิน
              {features?.slipUpload?.enabled
                ? <span style={{ marginLeft: 8, fontSize: 11.5, color: C.success, fontWeight: 500 }}>● เปิดอยู่</span>
                : <span style={{ marginLeft: 8, fontSize: 11.5, color: C.muted }}>○ ปิด</span>}
            </div>
            <div style={{ fontSize: 12.5, color: C.ink2, lineHeight: 1.5 }}>
              ตั้งค่า feature toggle, autoVerify, provider, API key, และทดสอบ end-to-end
              ในที่เดียวที่หน้า <b>ตรวจสลิปอัตโนมัติ</b> เพื่อกัน config กระจัดกระจาย.
            </div>
          </div>
          <a href="/admin#slip-verify" style={{
            padding: '8px 14px', borderRadius: 6,
            background: C.accent, color: '#fff',
            textDecoration: 'none', fontWeight: 500, fontSize: 13,
            whiteSpace: 'nowrap',
          }}>ไปตั้งค่า →</a>
        </div>
        <Row id="photoUpload"
          title="อัปโหลดรูปภาพ"
          desc="รูปห้อง / ลายเซ็นสัญญา / สำเนาบัตร">
          <Field id="photoUpload" field="maxBytes" label="ขนาดสูงสุด (bytes)" type="number" />
        </Row>
        <Row id="roomBooking"
          title="ค่าจองห้องสาธารณะ"
          desc="ตั้งค่ามัดจำ/สลิป และเวลาล็อกห้องชั่วคราวก่อนผู้จองส่งคำขอสำเร็จ">
          <ToggleField id="roomBooking" field="requireDeposit"
            label="บังคับเก็บค่าจองก่อนส่งคำขอ"
            features={features} setField={setField}
            disabled={!canEdit || busy} disabledReason={readOnlyReason} />
          <ToggleField id="roomBooking" field="requireSlip"
            label="ต้องแนบสลิปค่าจอง"
            features={features} setField={setField}
            disabled={!canEdit || busy} disabledReason={readOnlyReason} />
          <ToggleField id="roomBooking" field="applyBookingFeeToDeposit"
            label="นำค่าจองไปหัก/นับรวมกับเงินมัดจำสัญญา"
            features={features} setField={setField}
            disabled={!canEdit || busy} disabledReason={readOnlyReason} />
          <Field id="roomBooking" field="depositAmount" label="ค่าจอง (บาท)" type="number" />
          <Field id="roomBooking" field="minimumAmount" label="ขั้นต่ำค่าจอง (0 = ไม่กำหนด)" type="number" />
          <Field id="roomBooking" field="holdMinutes" label="ล็อกห้องชั่วคราว (นาที)" type="number" />
          <Field id="roomBooking" field="maxBytes" label="ขนาดสลิปสูงสุด (bytes)" type="number" />
        </Row>
      </Card>

      <Card>
        <SectionHeading title="การเงิน" />
        <Row id="lateFee"
          title="ค่าปรับชำระล่าช้า"
          desc="คำนวณจากยอดบิลก่อนหน้าที่เกินกำหนด">
          <Field id="lateFee" field="ratePctPerMonth" label="อัตรา %/เดือน" type="number" step="0.1" />
          <Field id="lateFee" field="gracePeriodDays" label="ผ่อนผัน (วัน)" type="number" />
          <Field id="lateFee" field="minLateFeeBaht" label="ขั้นต่ำค่าปรับ (บาท, 0 = ไม่กำหนด)" type="number" />
          <Field id="lateFee" field="maxPctOfPrincipal" label="เพดาน % ของยอดก่อนค่าปรับ (0 = ไม่จำกัด)" type="number" step="0.1" />
          <Field id="lateFee" field="maxLateFeeBaht" label="เพดานสูงสุด (บาท, 0 = ไม่จำกัด)" type="number" />
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
            features={features} setField={setField}
            disabled={!canEdit || busy} disabledReason={readOnlyReason} />
        </Row>
        <Row id="billAutoGenerate"
          title="ออกบิลอัตโนมัติทุกเดือน"
          desc="cron จะออกบิลตามวันที่กำหนด · กำหนดชำระตั้งที่ ตั้งค่าระบบ → แจ้งเตือน (ใช้ค่าเดียวกับการออกบิลด้วยมือ)">
          <Field id="billAutoGenerate" field="dayOfMonth" label="วันที่ออกบิล" type="number" />
        </Row>
      </Card>

      <Card>
        <SectionHeading title="มิเตอร์ & ควบคุมการเข้า-ออก" />
        <Row id="meterIot"
          title="ระบบมิเตอร์"
          desc="บันทึกค่าน้ำ/ไฟ + ตรวจจับความผิดปกติ (3σ)">
          <SelectField id="meterIot" field="mode" label="โหมด"
            features={features} setField={setField}
            options={[['manual', 'กรอกเอง'], ['simulator', 'จำลอง'], ['mqtt', 'MQTT (ยังไม่รองรับ)', true]]}
            disabled={!canEdit || busy} disabledReason={readOnlyReason} />
          <Field id="meterIot" field="anomalySigmas" label="เกณฑ์ σ" type="number" step="0.5" />
        </Row>
        <Row id="accessControl"
          title="ควบคุมการเข้า-ออก"
          desc="บันทึก log การเข้า-ออก + RFID/QR (ทำงานร่วมกับ hardware ภายนอก)">
          <ToggleField id="accessControl" field="requirePaymentForCard"
            label="ระงับการ์ดอัตโนมัติเมื่อค้างชำระ"
            features={features} setField={setField}
            disabled={!canEdit || busy} disabledReason={readOnlyReason} />
          <Field id="accessControl" field="overdueDaysThreshold"
            label="ค้างชำระเกิน (วัน) จึงระงับ" type="number" />
        </Row>
      </Card>

      <Card>
        <SectionHeading title="การแจ้งเตือน" />
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
            options={[['thsms', 'thsms.com'], ['twilio', 'Twilio']]}
            disabled={!canEdit || busy} disabledReason={readOnlyReason} />
        </Row>
      </Card>

      <Card>
        <SectionHeading title="UX" />
        <Row id="darkMode"
          title="โหมดมืด"
          desc="ใช้ในพอร์ทัลผู้เช่า (/tenant) เท่านั้น — admin console ใช้ธีมเดียว" />
        <Row id="i18n"
          title="หลายภาษา (i18n)"
          desc="เปลี่ยนภาษาไทย/อังกฤษ ในพอร์ทัลผู้เช่า">
          <SelectField id="i18n" field="defaultLocale" label="ภาษาเริ่มต้น"
            features={features} setField={setField}
            options={[['th', 'ไทย'], ['en', 'English']]}
            disabled={!canEdit || busy} disabledReason={readOnlyReason} />
        </Row>
      </Card>

      <Card>
        <SectionHeading title="ความปลอดภัย / ปฏิบัติการ" />
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
        <Row id="autoReconcileRooms"
          title="Reconcile ห้องอัตโนมัติ"
          desc="ช่วยแก้สถานะห้อง/สัญญาที่ค้างไม่ตรงกันเฉพาะเคสที่ระบบพิสูจน์ได้ว่าปลอดภัย" />
        <div style={{
          padding: '14px 0',
          borderBottom: '1px solid ' + C.border,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
            <span style={{ fontWeight: 600, fontSize: 14.5 }}>กฎสัญญาและเช็คอิน</span>
            <Pill color="info" size="sm">guard หลัก</Pill>
          </div>
          <div style={{ color: C.muted, fontSize: 13, marginBottom: 8 }}>
            ใช้ป้องกันการเข้าห้องผิดวัน, เงินมัดจำผิดปกติ, เอกสารไม่ครบ และข้อมูลฉุกเฉินไม่ครบก่อนสร้างสัญญา/เช็คอิน
          </div>
          <ul style={{ margin: '0 0 8px 0', paddingLeft: 18, color: C.ink2, fontSize: 12.5, lineHeight: 1.55 }}>
            <li>ค่ากลุ่มนี้ถูกใช้ทั้ง flow สร้างสัญญาจาก booking และ flow check-in ผู้เช่า</li>
            <li>ไม่ทำเป็น master toggle เพื่อกันปิด guard สำคัญโดยไม่ตั้งใจ แต่ปรับระดับความเข้มงวดได้ด้านล่าง</li>
          </ul>
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            <ToggleField id="tenancyContract" field="requireIdentityImages"
              label="ต้องมีรูปบัตรหน้า/หลัง" features={features} setField={setField}
              disabled={!canEdit || busy} disabledReason={readOnlyReason} />
            <ToggleField id="tenancyContract" field="requireEmergencyContact"
              label="ต้องมีผู้ติดต่อฉุกเฉิน" features={features} setField={setField}
              disabled={!canEdit || busy} disabledReason={readOnlyReason} />
            <ToggleField id="tenancyContract" field="requireAddress"
              label="ต้องมีที่อยู่ผู้เช่า" features={features} setField={setField}
              disabled={!canEdit || busy} disabledReason={readOnlyReason} />
            <Field id="tenancyContract" field="moveInPastDays" label="ย้อนหลังได้ (วัน)" type="number" />
            <Field id="tenancyContract" field="moveInFutureDays" label="ล่วงหน้าได้ (วัน)" type="number" />
            <Field id="tenancyContract" field="depositMaxMonths" label="มัดจำสูงสุด (เดือน)" type="number" step="0.5" />
            <Field id="tenancyContract" field="termsVersion" label="เวอร์ชันเงื่อนไข" />
          </div>
        </div>
      </Card>
    </Wrapper>
  );
}

// Local switch used by this page only. Named distinctly from window.Toggle
// (ui.jsx) so the top-level function declaration does not overwrite the
// shared Toggle reference on `window`. Earlier this was `function Toggle`,
// which silently shadowed window.Toggle for every page that loaded after
// page-features.jsx, breaking <Toggle label= checked= hint= /> in rooms,
// settings, and line-oas.
function FeatureFlagToggle({ on, disabled, onChange, label, disabledReason }) {
  const C = window.ADMIN_C;
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      role="switch"
      aria-checked={!!on}
      aria-label={`${label || 'feature'}: ${on ? 'เปิดอยู่' : 'ปิดอยู่'}`}
      title={disabled ? (disabledReason || 'กำลังบันทึก') : `${on ? 'ปิด' : 'เปิด'} ${label || 'feature'}`}
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

function ToggleField({ id, field, label, features, setField, disabled = false, disabledReason = '' }) {
  const C = window.ADMIN_C;
  const on = !!(features[id] && features[id][field]);
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: C.ink2 }}>
      <input
        type="checkbox"
        checked={on}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        onChange={(e) => setField(id, field, e.target.checked)}
      />
      {label}
    </label>
  );
}

function SelectField({ id, field, label, options, features, setField, disabled = false, disabledReason = '' }) {
  const C = window.ADMIN_C;
  const v = (features[id] || {})[field] || '';
  return (
    <label style={{ fontSize: 12.5, color: C.muted, display: 'flex', flexDirection: 'column' }}>
      {label}
      <select
        value={v}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        onChange={(e) => setField(id, field, e.target.value)}
        style={{
          marginTop: 4, padding: '6px 10px', borderRadius: 6,
          border: '1px solid ' + C.border,
          background: disabled ? C.surfaceMuted || C.surfaceAlt : C.bg,
          color: C.ink, fontSize: 13,
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}>
        {options.map(([val, lab, disabled]) => <option key={val} value={val} disabled={!!disabled}>{lab}</option>)}
      </select>
    </label>
  );
}

window.PageFeatures = PageFeatures;
