// === admin/page-pricing.jsx ===============================================
// ตั้งราคา: 4 tabs - ราคาฐาน, น้ำ-ไฟ, ส่วนลด, ค่าธรรมเนียม
// + Live preview แสดงราคาที่คำนวณได้ตามเงื่อนไข
// ===========================================================================

const { useState, useMemo, useEffect } = React;

const PRICING_CONFIG_KEYS = [
  'rates',
  'floorPremium',
  'viewPremium',
  'featurePremium',
  'utilities',
  'discounts',
  'fees',
];

function clonePricingValue(value) {
  try { return JSON.parse(JSON.stringify(value)); }
  catch { return value; }
}

function resetPricingSections(config) {
  const defaults = window.DEFAULT_CONFIG || {};
  const next = { ...(config || {}) };
  for (const key of PRICING_CONFIG_KEYS) {
    next[key] = clonePricingValue(defaults[key]);
  }
  return next;
}

function pricingNumber(value) {
  if (value === '' || value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function inspectPricingBucket(bucketName, obj, issues, warnings) {
  if (!obj || typeof obj !== 'object') return;
  for (const [key, raw] of Object.entries(obj)) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      inspectPricingBucket(`${bucketName}.${key}`, raw, issues, warnings);
      continue;
    }
    const n = pricingNumber(raw);
    if (!Number.isFinite(n)) {
      issues.push(`${bucketName}.${key}: ตัวเลขไม่ถูกต้อง`);
    } else if (n < 0) {
      warnings.push(`${bucketName}.${key}: เป็นค่าติดลบ ตรวจสอบว่านี่คือส่วนลด/การลดราคาที่ตั้งใจ`);
    } else if (n > 1000000) {
      warnings.push(`${bucketName}.${key}: จำนวนสูงผิดปกติ (${n.toLocaleString()} บาท) ตรวจสอบก่อนบันทึก`);
    }
  }
}

function buildPricingReview(draft, current, rooms) {
  const issues = [];
  const warnings = [];
  const impact = [];
  const fmtCurrency = window.fmtCurrency || ((v) => Number(v || 0).toLocaleString());
  const resolveRoomRent = window.resolveRoomRent;
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES || {};
  const typeEntries = Object.keys(ADMIN_ROOM_TYPES);

  for (const type of typeEntries) {
    const th = ADMIN_ROOM_TYPES[type]?.th || type;
    const rate = (draft?.rates || {})[type] || {};
    const rent = pricingNumber(rate.rent);
    const deposit = pricingNumber(rate.deposit);
    if (!Number.isFinite(rent)) issues.push(`ค่าเช่า ${th}: ตัวเลขไม่ถูกต้อง`);
    else if (rent > 0 && rent < 100) warnings.push(`ค่าเช่า ${th}: ต่ำกว่า 100 บาท ตรวจสอบว่าตั้งใจใช้ราคานี้จริงก่อนออกสัญญา/บิล`);
    else if (rent === 0) warnings.push(`ค่าเช่า ${th}: เป็น 0 บาท ห้องประเภทนี้จะไม่มีค่าเช่าถ้าใช้สูตรราคา`);

    if (!Number.isFinite(deposit)) issues.push(`เงินมัดจำ ${th}: ตัวเลขไม่ถูกต้อง`);
    else if (deposit > 0 && deposit < 100) warnings.push(`เงินมัดจำ ${th}: ต่ำกว่า 100 บาท ตรวจสอบว่าตั้งใจใช้ค่านี้จริงก่อนออกสัญญา`);
    else if (rent > 0 && deposit > rent * 4) warnings.push(`เงินมัดจำ ${th}: สูงกว่า 4 เดือน (${fmtCurrency(deposit)})`);
  }

  const utilities = draft?.utilities || {};
  for (const key of ['waterRate', 'elecRate']) {
    const n = pricingNumber(utilities[key]);
    const label = key === 'waterRate' ? 'ค่าน้ำ/หน่วย' : 'ค่าไฟ/หน่วย';
    if (!Number.isFinite(n)) issues.push(`${label}: ตัวเลขไม่ถูกต้อง`);
    else if (n > 0 && n < 1) warnings.push(`${label}: ต่ำกว่า 1 บาท/หน่วย บิลอาจต่ำกว่าที่คาด ตรวจสอบก่อนบันทึก`);
    else if (n === 0) warnings.push(`${label}: เป็น 0 บาท บิลค่าน้ำ/ค่าไฟจะไม่คิดเงินส่วนนี้`);
  }
  for (const key of ['wifi', 'commonFee', 'waterMin', 'elecMin']) {
    const n = pricingNumber(utilities[key]);
    if (!Number.isFinite(n)) issues.push(`utilities.${key}: ตัวเลขไม่ถูกต้อง`);
    else if (n < 0) issues.push(`utilities.${key}: ห้ามติดลบ`);
  }

  inspectPricingBucket('floorPremium', draft?.floorPremium, issues, warnings);
  inspectPricingBucket('viewPremium', draft?.viewPremium, issues, warnings);
  inspectPricingBucket('featurePremium', draft?.featurePremium, issues, warnings);

  for (const [key, raw] of Object.entries(draft?.discounts || {})) {
    const n = pricingNumber(raw);
    if (!Number.isFinite(n)) issues.push(`discounts.${key}: ตัวเลขไม่ถูกต้อง`);
    else if (n < 0 || n > 50) issues.push(`discounts.${key}: ต้องอยู่ระหว่าง 0-50% เพื่อป้องกันบิลผิด`);
  }
  inspectPricingBucket('fees', draft?.fees, issues, warnings);

  if (resolveRoomRent && rooms && typeof rooms === 'object') {
    for (const room of Object.values(rooms)) {
      if (!room || typeof room !== 'object') continue;
      const before = resolveRoomRent(room, current);
      const after = resolveRoomRent(room, draft);
      if (before?.source === 'override' || after?.source === 'override') continue;
      const b = Number(before?.rent || 0);
      const a = Number(after?.rent || 0);
      if (Number.isFinite(b) && Number.isFinite(a) && Math.abs(a - b) >= 0.01) {
        impact.push({
          id: room.id,
          before: b,
          after: a,
          diff: a - b,
          status: room.status || 'unknown',
        });
      }
    }
  }

  const bigMoves = impact.filter((x) => Math.abs(x.diff) >= Math.max(1000, Math.abs(x.before) * 0.25));
  if (bigMoves.length > 0) {
    warnings.push(`มี ${bigMoves.length} ห้องที่ค่าเช่าตามสูตรเปลี่ยนมากกว่า 25% หรือเกิน 1,000 บาท`);
  }
  if (impact.length > 20) {
    warnings.push(`การเปลี่ยนนี้กระทบ ${impact.length} ห้อง ตรวจสอบตัวอย่างก่อนบันทึก`);
  }

  return { issues, warnings, impact };
}

// `embedded` lets PageSettings host this component inside its
// "ตั้งราคา" tab without duplicating the outer PageContainer + PageHeader
// chrome. The standalone route /admin#pricing keeps working for legacy
// bookmarks / direct links.
function PagePricing({ config, setConfig, rooms, setRooms, addActivity, setToast, embedded = false, currentUser = null }) {
  const C = window.ADMIN_C;
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES;
  const ADMIN_ROOM_TYPE_KEYS = window.ADMIN_ROOM_TYPE_KEYS;
  const ADMIN_VIEWS = window.ADMIN_VIEWS;
  const { Card, Btn, Input, Select, Toggle, Tabs, Pill, SectionHeading,
          PageContainer, PageHeader, DefList, Modal } = window;
  const fmtMoney = window.fmtCurrency || ((v) => Number(v || 0).toLocaleString());

  const [tab, setTab] = useState('rates');
  const [draft, setDraft] = useState(config);
  const [confirmReset, setConfirmReset] = useState(false);
  const [impactReview, setImpactReview] = useState(null);
  const [saving, setSaving] = useState(false);
  const lastConfigJsonRef = React.useRef(JSON.stringify(config));

  useEffect(() => {
    const nextJson = JSON.stringify(config);
    if (nextJson === lastConfigJsonRef.current) return;
    setDraft(prev => (JSON.stringify(prev) === lastConfigJsonRef.current ? config : prev));
    lastConfigJsonRef.current = nextJson;
  }, [config]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(config), [draft, config]);
  const review = useMemo(() => buildPricingReview(draft, config, rooms), [draft, config, rooms]);
  const pricingStats = useMemo(() => {
    const list = rooms && typeof rooms === 'object' ? Object.values(rooms) : [];
    const resolveRoomRent = window.resolveRoomRent;
    let overrideCount = 0;
    let formulaCount = 0;
    let legacyCount = 0;
    for (const room of list) {
      if (!room || typeof room !== 'object') continue;
      const info = resolveRoomRent ? resolveRoomRent(room, draft) : null;
      if (info?.source === 'override') overrideCount++;
      else if (info?.source === 'formula') formulaCount++;
      else legacyCount++;
    }
    return {
      roomCount: list.length,
      formulaCount,
      overrideCount,
      legacyCount,
      affectedFutureRooms: review.impact.length,
    };
  }, [rooms, draft, review.impact.length]);

  // Derive the unique sorted list of floors actually present so the
  // "พรีเมียมตามชั้น" inputs + preview floor selector show every floor an
  // admin has added. Previously hardcoded [1,2,3,4,5]; floor 6+ silently
  // had no premium-rate UI even though the underlying floorPremium dict
  // accepts arbitrary keys. Falls back to [1..config.building.floors] for
  // an empty rooms blob (first-run UX).
  const floorsForPricing = useMemo(() => {
    const set = new Set();
    if (rooms) {
      for (const r of Object.values(rooms)) {
        const f = Number(r && r.floor);
        if (Number.isInteger(f) && f >= 1 && f <= 99) set.add(f);
      }
    }
    if (set.size === 0) {
      // Empty rooms → use the configured floor count as the upper bound,
      // capped at 99 for sanity. Lets admin pre-set premiums BEFORE adding
      // any room.
      const N = Math.max(1, Math.min(99, Number(config?.building?.floors) || 5));
      return Array.from({ length: N }, (_, i) => i + 1);
    }
    return Array.from(set).sort((a, b) => a - b);
  }, [rooms, config]);

  // Update helpers
  const updatePath = (path, value) => {
    setDraft(prev => {
      const next = JSON.parse(JSON.stringify(prev || {}));
      let cur = next;
      const parts = path.split('.');
      for (let i = 0; i < parts.length - 1; i++) {
        if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
      return next;
    });
  };
  async function savePricingDraft(next, options = {}) {
    const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
    if (!apiCall) {
      setToast && setToast({ kind: 'error', message: 'ระบบ API ยังไม่พร้อม กรุณารีเฟรชหน้าแล้วลองอีกครั้ง' });
      return false;
    }
    setSaving(true);
    try {
      // baseUpdatedAt = optimistic lock — if another tab/admin saved config
      // after this page loaded, the server answers 409 STALE_WRITE instead
      // of letting this save overwrite theirs (surfaced via catch below).
      const baseUpdatedAt = window.AP && window.AP.getBaseVersion
        ? window.AP.getBaseVersion('baankarn_config_v1') : null;
      const body = {
        value: next,
        ...(baseUpdatedAt ? { baseUpdatedAt } : {}),
        ...(options.pricingImpactAcknowledged ? { pricingImpactAcknowledged: true } : {}),
        ...(options.pricingContractMode ? { pricingContractMode: options.pricingContractMode } : {}),
        ...(options.pricingContractConfirm ? { pricingContractConfirm: options.pricingContractConfirm } : {}),
      };
      const out = await apiCall('/api/data/baankarn_config_v1', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      if (out && out.updatedAt && window.AP && window.AP.setBaseVersion) {
        window.AP.setBaseVersion('baankarn_config_v1', out.updatedAt);
      }
      const nextJson = JSON.stringify(next);
      lastConfigJsonRef.current = nextJson;
      setDraft(next);
      setConfig(next);
      if (options.closeReset) setConfirmReset(false);
      addActivity && addActivity({
        icon: options.activityIcon || '💰',
        text: options.activityText || 'อัปเดตการตั้งค่าราคาห้องพัก',
        type: 'system',
      });
      const serverWarnings = Array.isArray(out && out.warnings) ? out.warnings : [];
      const updatedContracts = Number(out?.contractUpdates?.updatedCount || 0);
      if (serverWarnings.length) {
        setToast && setToast({
          kind: 'warning',
          message: `บันทึกแล้ว${updatedContracts ? ` · อัปเดตสัญญา ${updatedContracts} รายการ` : ''} แต่มีคำเตือน: ${serverWarnings.slice(0, 3).join(', ')}`,
        });
      } else {
        setToast && setToast({
          kind: 'success',
          message: updatedContracts
            ? `บันทึกการตั้งราคาและอัปเดตสัญญา ${updatedContracts} รายการแล้ว`
            : (options.successMessage || 'บันทึกการตั้งค่าราคาเรียบร้อย'),
        });
      }
      return true;
    } catch (err) {
      if (err && err.code === 'PRICING_IMPACT_REVIEW_REQUIRED') {
        if (options.closeReset) setConfirmReset(false);
        setImpactReview({
          draft: clonePricingValue(next),
          impact: err.raw && err.raw.impact ? err.raw.impact : null,
          hint: err.hint || '',
        });
        return false;
      }
      const issues = Array.isArray(err && err.issues) && err.issues.length
        ? `: ${err.issues.slice(0, 3).join(', ')}`
        : '';
      setToast && setToast({
        kind: 'error',
        message: `${err && err.message ? err.message : 'บันทึกการตั้งค่าราคาไม่สำเร็จ'}${issues}`,
      });
      return false;
    } finally {
      setSaving(false);
    }
  }

  const handleSave = async () => {
    if (review.issues.length) {
      setToast && setToast({
        kind: 'danger',
        message: {
          title: 'ยังบันทึกการตั้งค่าราคาไม่ได้',
          description: review.issues.slice(0, 5).join('\n'),
        },
      });
      return;
    }
    const next = clonePricingValue(draft);
    await savePricingDraft(next, {
      activityText: 'อัปเดตการตั้งราคาห้องพัก',
      successMessage: 'บันทึกการตั้งราคาเรียบร้อย',
    });
  };
  const saveReviewedImpact = async (mode) => {
    if (!impactReview || !impactReview.draft) return;
    const wantsContractUpdate = mode === 'update_active';
    const ok = await savePricingDraft(clonePricingValue(impactReview.draft), {
      pricingImpactAcknowledged: true,
      pricingContractMode: wantsContractUpdate ? 'update_active' : 'new_only',
      pricingContractConfirm: wantsContractUpdate ? 'UPDATE_ACTIVE_CONTRACTS' : undefined,
      activityText: wantsContractUpdate
        ? 'อัปเดตการตั้งราคาและยอดสัญญา active'
        : 'อัปเดตการตั้งราคาเฉพาะสัญญาใหม่',
      successMessage: wantsContractUpdate
        ? 'บันทึกการตั้งราคาและอัปเดตสัญญา active แล้ว'
        : 'บันทึกการตั้งราคาแล้ว สัญญาเดิมยังใช้ยอดเดิม',
    });
    if (ok) setImpactReview(null);
  };
  const handleReset = async () => {
    const next = resetPricingSections(config);
    await savePricingDraft(next, {
      closeReset: true,
      activityIcon: '↺',
      activityText: 'รีเซ็ตการตั้งราคาเป็นค่าเริ่มต้น',
      successMessage: 'รีเซ็ตเป็นค่าเริ่มต้นแล้ว',
    });
  };
  const impact = impactReview?.impact || {};
  const impactSummary = impact.summary || {};
  const impactActiveContracts = Array.isArray(impact.activeContractChanges) ? impact.activeContractChanges : [];
  const impactFutureRooms = Array.isArray(impact.futureRoomChanges) ? impact.futureRoomChanges : [];
  const canUpdateActiveContracts = ['owner', 'manager'].includes(String(currentUser?.role || ''));
  const signedMoney = (v) => {
    const n = Number(v) || 0;
    return `${n >= 0 ? '+' : '-'}${fmtMoney(Math.abs(n))}`;
  };

  const pageActions = (
    <>
      <Btn variant="ghost" onClick={() => setConfirmReset(true)} disabled={saving}>↺ รีเซ็ต</Btn>
      <Btn variant="secondary" onClick={() => setDraft(config)} disabled={saving || !dirty}>ยกเลิกการแก้ไข</Btn>
      <Btn variant="primary" tone="finance" icon="✓" onClick={handleSave} disabled={saving || !dirty || review.issues.length > 0}>
        {saving ? 'กำลังบันทึก...' : dirty ? 'บันทึกการเปลี่ยนแปลง' : 'บันทึกแล้ว'}
      </Btn>
    </>
  );

  const content = (
    <>
      {!embedded ? <PageHeader
        title="ตั้งราคาห้องพัก"
        subtitle="กำหนดราคาฐาน, ค่าน้ำ-ไฟ, ส่วนลด และค่าธรรมเนียมต่างๆ อย่างครบถ้วน"
        actions={pageActions}
      /> : null}
      {/* When embedded inside Settings, show an inline action bar at top
          since the parent Settings header doesn't carry pricing-specific
          actions (Reset / Cancel / Save). Without this, admin opens the
          pricing tab and can't see Save/Reset until they scroll. */}
      {embedded && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          flexWrap: 'wrap', marginBottom: 14,
        }}>
          {pageActions}
        </div>
      )}

      <Card style={{ marginBottom: 16, background: C.surfaceAlt, border: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ minWidth: 240, flex: '1 1 320px' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.ink, marginBottom: 4 }}>
              ศูนย์กลางราคาเดียว
            </div>
            <div style={{ fontSize: 12.5, color: C.ink2, lineHeight: 1.6 }}>
              ค่าเช่าและมัดจำสำหรับ booking, quick invite, check-in และสัญญาใหม่จะอ้างอิงจากหน้านี้ก่อนเสมอ.
              หน้าห้องพักใช้แก้เฉพาะลักษณะห้องหรือ override รายห้อง ส่วนสัญญา active จะยังใช้ยอดที่ล็อกไว้จนกว่าจะเลือกอัปเดตสัญญา.
            </div>
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
            gap: 8,
            flex: '1 1 460px',
          }}>
            {[
              { label: 'ห้องใช้สูตรกลาง', value: pricingStats.formulaCount, tone: C.success },
              { label: 'override รายห้อง', value: pricingStats.overrideCount, tone: C.warning },
              { label: 'ค่าเดิม fallback', value: pricingStats.legacyCount, tone: C.muted },
              { label: 'กำลังจะเปลี่ยน', value: pricingStats.affectedFutureRooms, tone: dirty ? C.accent : C.muted },
            ].map((item) => (
              <div key={item.label} style={{
                padding: 10,
                borderRadius: 8,
                background: C.surface,
                border: `1px solid ${C.borderSoft}`,
                minWidth: 0,
              }}>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 3 }}>{item.label}</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: item.tone || C.ink }}>{item.value}</div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* ห้องที่ใช้ราคาพิเศษ — ข้อยกเว้นจากสูตรกลางทั้งหมดต้องมองเห็นและ
          จัดการได้จากหน้านี้ ไม่ใช่ตัวเลขนับเฉยๆ ที่ต้องไล่เปิดทีละห้อง */}
      {(() => {
        const resolveRent = window.resolveRoomRent;
        const overrideRooms = Object.values(rooms || {})
          .map((room) => {
            const info = resolveRent ? resolveRent(room, config) : null;
            if (!info || info.source !== 'override') return null;
            return {
              id: room.id,
              override: Number(info.rent) || 0,
              formula: Number(info.formula) || 0,
              reason: room.rentOverrideReason || room.rent_override_reason || '-',
              at: room.rentOverrideAt || room.rent_override_at || null,
            };
          })
          .filter(Boolean)
          .sort((a, b) => String(a.id).localeCompare(String(b.id)));
        if (!overrideRooms.length) return null;
        const clearOverride = (entry) => {
          if (!setRooms) {
            setToast && setToast({ kind: 'warning', message: 'หน้านี้แก้ข้อมูลห้องไม่ได้ — เปิดหน้าห้องพักเพื่อล้างราคาพิเศษ' });
            return;
          }
          const ok = window.confirm(
            `ล้างราคาพิเศษของห้อง ${entry.id}?\n\n` +
            `ราคาพิเศษปัจจุบัน: ${fmtMoney(entry.override)}\n` +
            `ราคาตามสูตรกลางที่จะใช้แทน: ${fmtMoney(entry.formula)}\n\n` +
            `สัญญา active เดิมไม่กระทบ (ยังใช้ยอดที่ล็อกไว้) — มีผลกับสัญญา/บิลใหม่เท่านั้น`
          );
          if (!ok) return;
          setRooms((prev) => {
            const room = prev[entry.id];
            if (!room) return prev;
            return {
              ...prev,
              [entry.id]: {
                ...room,
                rentOverride: null, rentOverrideReason: null,
                rentOverrideAt: null, rentOverrideBy: null,
                rent: entry.formula || room.rent,
              },
            };
          });
          addActivity && addActivity({ icon: '🧹', text: `ล้างราคาพิเศษห้อง ${entry.id} → กลับไปใช้สูตรกลาง ${fmtMoney(entry.formula)}`, type: 'system' });
          setToast && setToast({
            kind: 'success',
            message: {
              title: `ห้อง ${entry.id} กลับมาใช้สูตรกลางแล้ว`,
              description: `ราคาปัจจุบัน ${fmtMoney(entry.formula)} — ต่อจากนี้แก้ราคากลางที่หน้านี้ ห้องจะอัปเดตตามอัตโนมัติ`,
            },
          });
        };
        return (
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.ink, marginBottom: 4 }}>
              ห้องที่ใช้ราคาพิเศษ (ไม่ตามสูตรกลาง) — {overrideRooms.length} ห้อง
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
              ห้องเหล่านี้จะไม่ขยับตามเมนูตั้งราคา จนกว่าจะล้างราคาพิเศษ — ตรวจว่ายังตั้งใจให้เป็นแบบนี้อยู่หรือไม่
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              {overrideRooms.map((entry) => (
                <div key={entry.id} style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(48px, auto) 1fr auto',
                  gap: 10, alignItems: 'center',
                  padding: '8px 10px',
                  border: `1px solid ${C.borderSoft}`,
                  borderRadius: 8,
                  background: C.surface,
                }}>
                  <div style={{ fontWeight: 700, color: C.ink }}>ห้อง {entry.id}</div>
                  <div style={{ fontSize: 12, color: C.ink2, lineHeight: 1.5, minWidth: 0 }}>
                    ราคาพิเศษ <b>{fmtMoney(entry.override)}</b>
                    {' '}· ตามสูตรควรเป็น {fmtMoney(entry.formula)}
                    {' '}({entry.override - entry.formula >= 0 ? '+' : ''}{fmtMoney(entry.override - entry.formula)})
                    <br />เหตุผล: {entry.reason}{entry.at ? ` · ตั้งเมื่อ ${new Date(entry.at).toLocaleDateString('th-TH')}` : ''}
                  </div>
                  <Btn variant="ghost" size="sm" onClick={() => clearOverride(entry)}>
                    ล้างกลับไปใช้สูตร
                  </Btn>
                </div>
              ))}
            </div>
          </Card>
        );
      })()}

      {dirty && (
        <div style={{
          padding: '10px 14px', marginBottom: 16,
          background: C.warningSoft, border: `1px solid ${C.warning}44`,
          borderRadius: 9, color: C.warningInk, fontSize: 13,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>⚠️</span>
          <span>คุณมีการเปลี่ยนแปลงที่ยังไม่ได้บันทึก กดปุ่ม "บันทึกการเปลี่ยนแปลง" เพื่อยืนยัน</span>
        </div>
      )}

      {dirty && review.issues.length > 0 ? (
        <Card style={{
          marginBottom: 16,
          background: C.dangerSoft || '#FDEDEC',
          border: `1px solid ${(C.danger || '#D92D20')}55`,
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.dangerInk || C.danger, marginBottom: 8 }}>
            หยุดก่อน: พบค่าราคาที่ผิดปกติ
          </div>
          <div style={{ fontSize: 12.5, color: C.dangerInk || C.ink2, lineHeight: 1.6 }}>
            {review.issues.slice(0, 8).map((it, idx) => <div key={idx}>• {it}</div>)}
            {review.issues.length > 8 ? <div>• อีก {review.issues.length - 8} รายการ</div> : null}
          </div>
        </Card>
      ) : null}

      {dirty && review.issues.length === 0 && (review.warnings.length > 0 || review.impact.length > 0) ? (
        <Card style={{
          marginBottom: 16,
          background: C.warningSoft,
          border: `1px solid ${C.warning}55`,
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.warningInk, marginBottom: 8 }}>
            ตรวจสอบผลกระทบก่อนบันทึก
          </div>
          <div style={{ fontSize: 12.5, color: C.warningInk, lineHeight: 1.6 }}>
            {review.warnings.map((it, idx) => <div key={`w-${idx}`}>• {it}</div>)}
            {review.impact.length > 0 ? (
              <div style={{ marginTop: 6 }}>
                • ค่าเช่าตามสูตรจะเปลี่ยน {review.impact.length} ห้อง
                {review.impact.slice(0, 5).map((it) => (
                  <div key={it.id} style={{ marginLeft: 14 }}>
                    ห้อง {it.id}: {fmtMoney(it.before)} → {fmtMoney(it.after)}
                  </div>
                ))}
                {review.impact.length > 5 ? <div style={{ marginLeft: 14 }}>…อีก {review.impact.length - 5} ห้อง</div> : null}
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Tabs
        items={[
          { value: 'rates',    label: 'ค่าเช่า+มัดจำ',  icon: '🏷️' },
          { value: 'utils',    label: 'น้ำ/ไฟ/ส่วนกลาง', icon: '💡' },
          { value: 'discount', label: 'ส่วนลดสัญญา',     icon: '🎁' },
          { value: 'fees',     label: 'ค่าปรับ/อื่นๆ',    icon: '📑' },
        ]}
        value={tab}
        onChange={setTab}
        variant="pills"
        style={{ marginBottom: 20 }}
      />

      {tab === 'rates'    && <TabRates    draft={draft} updatePath={updatePath} floorsForPricing={floorsForPricing} />}
      {tab === 'utils'    && <TabUtils    draft={draft} updatePath={updatePath} />}
      {tab === 'discount' && <TabDiscount draft={draft} updatePath={updatePath} />}
      {tab === 'fees'     && <TabFees     draft={draft} updatePath={updatePath} />}

      <Modal
        open={!!impactReview}
        onClose={() => !saving && setImpactReview(null)}
        title="ตรวจผลกระทบก่อนบันทึกราคา"
        footer={
          <>
            <Btn variant="ghost" onClick={() => setImpactReview(null)} disabled={saving}>กลับไปแก้ราคา</Btn>
            <Btn variant="primary" tone="finance" onClick={() => saveReviewedImpact('new_only')} disabled={saving}>
              {saving ? 'กำลังบันทึก...' : 'ใช้เฉพาะสัญญาใหม่'}
            </Btn>
            <Btn
              variant="danger"
              onClick={() => saveReviewedImpact('update_active')}
              disabled={saving || !canUpdateActiveContracts || impactActiveContracts.length === 0}
              title={!canUpdateActiveContracts ? 'เฉพาะ owner/manager เท่านั้น' : ''}
            >
              เปลี่ยนสัญญา active ด้วย
            </Btn>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13, color: C.ink2, lineHeight: 1.55 }}>
          <div style={{
            padding: 12, borderRadius: 8,
            background: C.warningSoft, border: `1px solid ${C.warning}55`,
            color: C.warningInk,
          }}>
            ราคากลางที่เปลี่ยนจะไม่ควรแก้สัญญาเดิมโดยอัตโนมัติ เพราะสัญญา active มีค่าเช่า/มัดจำที่ล็อกไว้แล้ว
            เลือก “ใช้เฉพาะสัญญาใหม่” ถ้าต้องการให้ผู้เช่าปัจจุบันจ่ายยอดเดิมจนหมดสัญญาหรือต่อสัญญาใหม่
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
            <div style={{ padding: 10, border: `1px solid ${C.border}`, borderRadius: 8, background: C.surfaceAlt }}>
              <div style={{ fontSize: 11.5, color: C.muted }}>สัญญา active ที่ต้องตรวจ</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: C.ink }}>{impactSummary.activeContractChanges || 0}</div>
            </div>
            <div style={{ padding: 10, border: `1px solid ${C.border}`, borderRadius: 8, background: C.surfaceAlt }}>
              <div style={{ fontSize: 11.5, color: C.muted }}>ห้องสำหรับสัญญาใหม่</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: C.ink }}>{impactSummary.futureRoomChanges || 0}</div>
            </div>
            <div style={{ padding: 10, border: `1px solid ${C.border}`, borderRadius: 8, background: C.surfaceAlt }}>
              <div style={{ fontSize: 11.5, color: C.muted }}>ค่าเช่ารวมถ้าแก้สัญญา</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: Number(impactSummary.activeRentDelta || 0) >= 0 ? C.success : C.danger }}>
                {signedMoney(impactSummary.activeRentDelta || 0)}
              </div>
            </div>
          </div>

          {impactActiveContracts.length > 0 ? (
            <div>
              <div style={{ fontWeight: 700, color: C.ink, marginBottom: 6 }}>
                สัญญา active ที่ยอด pricing ใหม่ต่างจากยอดเดิม
              </div>
              <div style={{ maxHeight: 250, overflow: 'auto', border: `1px solid ${C.border}`, borderRadius: 8 }}>
                {impactActiveContracts.slice(0, 20).map((it, idx) => (
                  <div key={`${it.contractId || it.roomId || idx}`} style={{
                    padding: 10,
                    borderTop: idx === 0 ? 0 : `1px solid ${C.borderSoft}`,
                    background: idx % 2 ? C.surfaceAlt : C.surface,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                      <b style={{ color: C.ink }}>ห้อง {it.roomId || '-'} · {it.tenantName || 'ไม่ระบุผู้เช่า'}</b>
                      <span style={{ color: C.muted }}>{it.contractNo || `สัญญา #${it.contractId || '-'}`}</span>
                    </div>
                    {it.type === 'missing_room' ? (
                      <div style={{ color: C.danger, marginTop: 4 }}>ไม่พบข้อมูลห้องสำหรับคำนวณราคาใหม่ ระบบจะไม่อัปเดตสัญญานี้</div>
                    ) : (
                      <div style={{ marginTop: 5, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        <div>ค่าเช่าสัญญา: <b>{fmtMoney(it.currentRent)}</b> → <b>{fmtMoney(it.newSettingRent)}</b></div>
                        <div>มัดจำสัญญา: <b>{fmtMoney(it.currentDeposit)}</b> → <b>{fmtMoney(it.newSettingDeposit)}</b></div>
                      </div>
                    )}
                  </div>
                ))}
                {impactActiveContracts.length > 20 ? (
                  <div style={{ padding: 10, color: C.muted, borderTop: `1px solid ${C.borderSoft}` }}>
                    ยังมีอีก {impactActiveContracts.length - 20} สัญญา
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {impactFutureRooms.length > 0 ? (
            <div>
              <div style={{ fontWeight: 700, color: C.ink, marginBottom: 6 }}>
                ห้องที่ยังไม่ lock สัญญาและจะใช้ราคานี้กับคนเข้าใหม่
              </div>
              <div style={{ maxHeight: 170, overflow: 'auto', border: `1px solid ${C.border}`, borderRadius: 8 }}>
                {impactFutureRooms.slice(0, 12).map((it, idx) => (
                  <div key={`${it.roomId || idx}`} style={{
                    padding: 9,
                    borderTop: idx === 0 ? 0 : `1px solid ${C.borderSoft}`,
                    display: 'grid',
                    gridTemplateColumns: 'minmax(70px, 0.7fr) minmax(0, 1.2fr) minmax(0, 1.2fr)',
                    gap: 8,
                    background: idx % 2 ? C.surfaceAlt : C.surface,
                  }}>
                    <b style={{ color: C.ink }}>ห้อง {it.roomId}</b>
                    <span>ค่าเช่า {fmtMoney(it.oldRent)} → {fmtMoney(it.newRent)}</span>
                    <span>มัดจำ {fmtMoney(it.oldDeposit)} → {fmtMoney(it.newDeposit)}</span>
                  </div>
                ))}
                {impactFutureRooms.length > 12 ? (
                  <div style={{ padding: 9, color: C.muted, borderTop: `1px solid ${C.borderSoft}` }}>
                    ยังมีอีก {impactFutureRooms.length - 12} ห้อง
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {!canUpdateActiveContracts && impactActiveContracts.length > 0 ? (
            <div style={{ padding: 10, borderRadius: 8, background: C.dangerSoft, color: C.dangerInk }}>
              บัญชี role {currentUser?.role || '-'} บันทึกเฉพาะสัญญาใหม่ได้ แต่การแก้ยอดในสัญญา active ต้องใช้ owner/manager
            </div>
          ) : null}
        </div>
      </Modal>

      {/* Reset confirm */}
      <Modal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="รีเซ็ตเป็นค่าเริ่มต้น"
        footer={
          <>
            <Btn variant="ghost" onClick={() => setConfirmReset(false)}>ยกเลิก</Btn>
            <Btn variant="danger" onClick={handleReset} disabled={saving}>{saving ? 'กำลังบันทึก...' : 'รีเซ็ต'}</Btn>
          </>
        }
      >
        <div style={{ fontSize: 14, color: C.ink2, lineHeight: 1.6 }}>
          การกระทำนี้จะรีเซ็ตการตั้งค่าราคาทั้งหมดกลับเป็นค่าเริ่มต้น
          คุณแน่ใจหรือไม่?
        </div>
      </Modal>
    </>
  );
  return embedded ? <div>{content}</div> : <PageContainer>{content}</PageContainer>;
}

// ============================================================
// Tab 1: Base rates per type + floor premium + view + features
// ============================================================
// floorsForPricing is computed in the parent (PagePricing) from the actual
// rooms blob — passed in as a prop because TabRates doesn't receive `rooms`
// or `config` directly. Falls back to a sensible default if the parent
// somehow forgets to pass it (defensive — without this guard, the page
// crashed with "floorsForPricing is not defined" the moment admin opened
// /admin#pricing).
function TabRates({ draft, updatePath, floorsForPricing }) {
  // Defensive default: if we somehow got rendered without the prop (hot-reload
  // edge case, older shell.jsx, etc.), derive a list from draft.building.floors
  // so the page renders something useful instead of throwing.
  if (!Array.isArray(floorsForPricing) || floorsForPricing.length === 0) {
    const N = Math.max(1, Math.min(99, Number(draft?.building?.floors) || 5));
    floorsForPricing = Array.from({ length: N }, (_, i) => i + 1);
  }
  const C = window.ADMIN_C;
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES;
  const ADMIN_ROOM_TYPE_KEYS = window.ADMIN_ROOM_TYPE_KEYS;
  const ADMIN_VIEWS = window.ADMIN_VIEWS;
  const { fmtCurrency, computeRoomRent, resolveRoomDeposit } = window;
  const { Card, Input, Select, Toggle, SectionHeading, Pill } = window;

  const [previewType, setPreviewType] = useState('deluxe');
  const [previewFloor, setPreviewFloor] = useState('3');
  const [previewView, setPreviewView] = useState('วิวภูเขา');
  const [previewFeats, setPreviewFeats] = useState({ balcony: true, ac: true, parking: false, kitchen: false });

  const previewRent = computeRoomRent(previewType, Number(previewFloor), previewView, previewFeats, draft);
  const previewDepositInfo = resolveRoomDeposit
    ? resolveRoomDeposit({ type: previewType }, draft, previewRent)
    : { deposit: previewRent * 2, sourceLabel: 'ค่าเช่า x 2' };
  const previewDeposit = Number(previewDepositInfo.deposit) || 0;
  const featurePremiumItems = [
    { key: 'balcony', label: 'มีระเบียง', premium: Number(draft.featurePremium.balcony || 0) },
    { key: 'ac', label: 'แอร์', premium: Number(draft.featurePremium.ac || 0) },
    { key: 'parking', label: 'ที่จอดรถ', premium: Number(draft.featurePremium.parking || 0) },
    { key: 'kitchen', label: 'ครัวในห้อง', premium: Number(draft.featurePremium.kitchen || 0) },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <Card style={{ background: '#FFF8E6', border: '1px solid #F2C84B' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, color: '#7A5A0F', lineHeight: 1.6 }}>
            <span style={{ fontSize: 16, lineHeight: 1 }}>ℹ️</span>
            <div>
              <b>แก้ราคาหลักที่นี่ที่เดียว</b>: ค่าเช่าและมัดจำในหน้านี้จะถูกใช้กับ booking, quick invite, check-in และสัญญาใหม่.
              ห้องที่ต้องใช้ราคาไม่เหมือนสูตรให้ไปตั้ง <b>override รายห้อง</b> ที่หน้าห้องพัก. สัญญา active จะไม่เปลี่ยนจนกว่าจะยืนยันในหน้าตรวจผลกระทบ.
            </div>
          </div>
        </Card>
        <Card>
          <SectionHeading title="ค่าเช่าและมัดจำกลางตามประเภทห้อง" subtitle="จุดตั้งราคาหลักสำหรับผู้เช่าใหม่และสัญญาใหม่" level={3} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {ADMIN_ROOM_TYPE_KEYS.map(k => {
              const t = ADMIN_ROOM_TYPES[k];
              const r = draft.rates[k] || { rent: t.baseRent, deposit: t.baseRent * 2 };
              return (
                <div key={k} style={{
                  padding: 14, background: C.surfaceAlt, borderRadius: 10,
                  border: `1px solid ${C.borderSoft}`,
                  display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr)',
                  gap: 14, alignItems: 'end',
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 3, background: t.accent }} />
                      <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>{t.th}</div>
                    </div>
                    <div style={{ fontSize: 11.5, color: C.muted }}>
                      {t.size} ตร.ม. · {t.beds} เตียง · {t.ac ? 'มีแอร์' : 'ไม่มีแอร์'}
                    </div>
                  </div>
                  <Input
                    label="ค่าเช่า/เดือน" type="number" suffix="บาท"
                    value={r.rent}
                    onChange={(v) => {
                      const nextRent = Number(v);
                      const oldRent = Number(r.rent);
                      const currentDeposit = Number(r.deposit);
                      updatePath(`rates.${k}.rent`, nextRent);
                      if (!Number.isFinite(currentDeposit)
                        || currentDeposit === 0
                        || (Number.isFinite(oldRent) && Math.abs(currentDeposit - oldRent * 2) < 0.01)) {
                        updatePath(`rates.${k}.deposit`, nextRent * 2);
                      }
                    }}
                    hint="ถ้ามัดจำยังเป็น 2 เดือน ระบบจะปรับตามค่าเช่าให้"
                  />
                  <Input
                    label="เงินมัดจำกลาง" type="number" suffix="บาท"
                    value={r.deposit}
                    onChange={(v) => updatePath(`rates.${k}.deposit`, Number(v))}
                    hint="ค่านี้ถูกใช้กับสัญญาใหม่ก่อนค่า fallback ของห้อง"
                  />
                </div>
              );
            })}
          </div>
        </Card>

        <Card>
          <SectionHeading title="พรีเมียมตามชั้น" subtitle="ส่วนเพิ่มราคาเช่าตามชั้นที่อยู่" level={3} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
            {floorsForPricing.map(f => (
              <Input
                key={f}
                label={`ชั้น ${f}`}
                type="number" suffix="+ บาท"
                value={draft.floorPremium[f] || 0}
                onChange={(v) => updatePath(`floorPremium.${f}`, Number(v))}
              />
            ))}
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: C.muted }}>
            💡 บวกเพิ่มจากราคาฐานของห้อง โดยทั่วไปชั้นสูงจะมีพรีเมียมมากกว่า
          </div>
        </Card>

        <Card>
          <SectionHeading title="พรีเมียมตามวิว" level={3} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
            {ADMIN_VIEWS.map(v => (
              <Input
                key={v}
                label={v}
                type="number" suffix="+ บาท"
                value={draft.viewPremium[v] || 0}
                onChange={(val) => updatePath(`viewPremium.${v}`, Number(val))}
              />
            ))}
          </div>
        </Card>

        <Card>
          <SectionHeading title="พรีเมียมตามคุณสมบัติ" subtitle="ส่วนเพิ่มเมื่อห้องมีสิ่งอำนวยความสะดวกพิเศษ" level={3} />
          <div style={{ fontSize: 12.5, color: C.ink2, lineHeight: 1.55, marginBottom: 10 }}>
            ตัวเลขชุดนี้เป็นราคากลางของสูตรค่าเช่า เมื่อเปิดคุณสมบัติเดียวกันในหน้าห้องพัก ระบบจะบวกเพิ่มจากค่าเช่าฐานทันทีใน preview
            และใช้กับห้องว่าง/สัญญาใหม่ที่ยังไม่ได้ lock ราคา
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
            <Input label="มีระเบียง"  type="number" suffix="+ บาท"
                   value={draft.featurePremium.balcony} onChange={(v) => updatePath('featurePremium.balcony', Number(v))} />
            <Input label="แอร์"          type="number" suffix="+ บาท"
                   value={draft.featurePremium.ac}      onChange={(v) => updatePath('featurePremium.ac', Number(v))} />
            <Input label="ที่จอดรถ"   type="number" suffix="+ บาท"
                   value={draft.featurePremium.parking} onChange={(v) => updatePath('featurePremium.parking', Number(v))} />
            <Input label="ครัวในห้อง" type="number" suffix="+ บาท"
                   value={draft.featurePremium.kitchen} onChange={(v) => updatePath('featurePremium.kitchen', Number(v))} />
          </div>
        </Card>
      </div>

      {/* --- Live preview panel --- */}
      <div style={{ position: 'sticky', top: 90 }}>
        <Card style={{ background: C.dark, borderColor: C.dark, color: '#fff' }}>
          <div style={{ fontSize: 11.5, color: '#bcaf95', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginBottom: 4 }}>
            🔍 จำลองราคา
          </div>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#fff', marginBottom: 16 }}>
            ตัวอย่างห้องตามเงื่อนไข
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
            <DarkSelect label="ประเภทห้อง" value={previewType} onChange={setPreviewType}
              options={ADMIN_ROOM_TYPE_KEYS.map(k => ({ value: k, label: ADMIN_ROOM_TYPES[k].th }))} />
            <DarkSelect label="ชั้น" value={previewFloor} onChange={setPreviewFloor}
              options={floorsForPricing.map(f => ({ value: String(f), label: `ชั้น ${f}` }))} />
            <DarkSelect label="วิว" value={previewView} onChange={setPreviewView}
              options={ADMIN_VIEWS.map(v => ({ value: v, label: v }))} />
            <div style={{
              padding: 10, background: 'rgba(255,255,255,0.06)', borderRadius: 8,
              display: 'flex', flexDirection: 'column', gap: 4,
            }}>
              <div style={{ fontSize: 11.5, color: '#bcaf95', marginBottom: 4 }}>คุณสมบัติพิเศษ</div>
              {featurePremiumItems.map(({ key: k, label, premium }) => (
                <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#ebe1cc', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={previewFeats[k]}
                    onChange={(e) => setPreviewFeats(prev => ({ ...prev, [k]: e.target.checked }))}
                    style={{ accentColor: C.accent }}
                  />
                  <span>{label}</span>
                  <span style={{ marginLeft: 'auto', color: '#bcaf95', fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5 }}>
                    +{fmtCurrency(premium)}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <PriceBreakdown
            type={previewType}
            floor={Number(previewFloor)}
            view={previewView}
            feats={previewFeats}
            draft={draft}
          />

          <div style={{
            marginTop: 16, padding: 14,
            background: C.accent, borderRadius: 10,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontSize: 13, color: '#fff', opacity: 0.9 }}>ราคาเช่ารวม</span>
            <span style={{ fontFamily: 'IBM Plex Sans Thai, sans-serif', fontSize: 22, fontWeight: 700, color: '#fff' }}>
              {fmtCurrency(previewRent)}
            </span>
          </div>
          <div style={{
            marginTop: 8, padding: 12,
            background: 'rgba(255,255,255,0.07)', borderRadius: 10,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
          }}>
            <span style={{ fontSize: 12.5, color: '#ebe1cc' }}>มัดจำสัญญาใหม่</span>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 15, fontWeight: 700, color: '#fff' }}>
              {fmtCurrency(previewDeposit)}
            </span>
          </div>
          <div style={{ fontSize: 11, color: '#8a7d6b', marginTop: 6, textAlign: 'right' }}>
            มัดจำจาก {previewDepositInfo.sourceLabel || 'เมนูตั้งราคา'}
          </div>
          <div style={{ fontSize: 11, color: '#8a7d6b', marginTop: 8, textAlign: 'right' }}>
            * ยังไม่รวมค่าน้ำ ค่าไฟ และค่าธรรมเนียมอื่นๆ
          </div>
        </Card>
      </div>
    </div>
  );
}

function DarkSelect({ label, value, onChange, options }) {
  const C = window.ADMIN_C;
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 11.5, color: '#bcaf95', marginBottom: 4 }}>{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%', height: 36, padding: '0 10px',
          background: 'rgba(255,255,255,0.06)', color: '#fff',
          border: '1px solid rgba(255,255,255,0.12)', borderRadius: 7,
          fontSize: 13, fontFamily: 'inherit', outline: 'none', cursor: 'pointer',
        }}>
        {options.map(o => <option key={o.value} value={o.value} style={{ background: C.dark, color: '#fff' }}>{o.label}</option>)}
      </select>
    </label>
  );
}

function PriceBreakdown({ type, floor, view, feats, draft }) {
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES;
  const { fmtCurrency } = window;
  const base    = (draft.rates[type] || {}).rent || ADMIN_ROOM_TYPES[type].baseRent;
  const fp      = draft.floorPremium[floor] || 0;
  const vp      = draft.viewPremium[view]   || 0;
  const balcony = feats.balcony ? draft.featurePremium.balcony : 0;
  const ac      = feats.ac      ? draft.featurePremium.ac      : 0;
  const parking = feats.parking ? draft.featurePremium.parking : 0;
  const kitchen = feats.kitchen ? draft.featurePremium.kitchen : 0;

  const rows = [
    { label: 'ราคาฐาน',     value: base },
    fp      && { label: `+ ชั้น ${floor}`,    value: fp },
    vp      && { label: `+ ${view}`,             value: vp },
    balcony && { label: '+ ระเบียง',            value: balcony },
    ac      && { label: '+ แอร์',                  value: ac },
    parking && { label: '+ ที่จอดรถ',          value: parking },
    kitchen && { label: '+ ครัวในห้อง',       value: kitchen },
  ].filter(Boolean);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5, color: '#ebe1cc' }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
          <span style={{ color: '#bcaf95' }}>{r.label}</span>
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 500 }}>{fmtCurrency(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// Tab 2: Utilities (water, electric, wifi, common fee)
// ============================================================
function TabUtils({ draft, updatePath }) {
  const C = window.ADMIN_C;
  const { Card, Input, SectionHeading } = window;
  const { fmtCurrency } = window;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <Card>
          <SectionHeading title="ค่าน้ำประปา" subtitle="คิดตามจำนวนหน่วยที่ใช้จริง" level={3} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="อัตราต่อหน่วย" type="number" suffix="บาท/หน่วย"
                   value={draft.utilities.waterRate}
                   onChange={(v) => updatePath('utilities.waterRate', Number(v))}
                   hint="อัตรามาตรฐานในเชียงใหม่: ~18 บาท/หน่วย" />
            <Input label="ขั้นต่ำ" type="number" suffix="หน่วย"
                   value={draft.utilities.waterMin}
                   onChange={(v) => updatePath('utilities.waterMin', Number(v))}
                   hint="0 = ไม่มีขั้นต่ำ" />
          </div>
        </Card>

        <Card>
          <SectionHeading title="ค่าไฟฟ้า" subtitle="คิดตามจำนวนหน่วยที่ใช้จริง" level={3} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="อัตราต่อหน่วย" type="number" suffix="บาท/หน่วย"
                   value={draft.utilities.elecRate}
                   onChange={(v) => updatePath('utilities.elecRate', Number(v))}
                   hint="อัตราการไฟฟ้าส่วนภูมิภาค + ส่วนเพิ่ม" />
            <Input label="ขั้นต่ำ" type="number" suffix="หน่วย"
                   value={draft.utilities.elecMin}
                   onChange={(v) => updatePath('utilities.elecMin', Number(v))} />
          </div>
        </Card>

        <Card>
          <SectionHeading title="ค่าอินเทอร์เน็ตและส่วนกลาง" level={3} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="ค่า Wi-Fi" type="number" suffix="บาท/เดือน"
                   value={draft.utilities.wifi}
                   onChange={(v) => updatePath('utilities.wifi', Number(v))}
                   hint="แพ็กเกจ 200 Mbps ของ AIS Fibre" />
            <Input label="ค่าส่วนกลาง" type="number" suffix="บาท/เดือน"
                   value={draft.utilities.commonFee}
                   onChange={(v) => updatePath('utilities.commonFee', Number(v))}
                   hint="รักษาความปลอดภัย, ทำความสะอาด, ขยะ" />
          </div>
        </Card>
      </div>

      <Card style={{ background: C.surfaceAlt, position: 'sticky', top: 90 }}>
        <SectionHeading title="ตัวอย่างคำนวณ" level={3} />
        <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 12 }}>
          ผู้เช่าตัวอย่างใช้น้ำ <b style={{color: C.ink}}>15 หน่วย</b> และไฟ <b style={{color: C.ink}}>80 หน่วย</b> ต่อเดือน
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
          <UtilRow label="ค่าน้ำ (15 หน่วย)" value={15 * draft.utilities.waterRate} />
          <UtilRow label="ค่าไฟ (80 หน่วย)" value={80 * draft.utilities.elecRate} />
          <UtilRow label="ค่า Wi-Fi"           value={draft.utilities.wifi} />
          <UtilRow label="ค่าส่วนกลาง"      value={draft.utilities.commonFee} />
          <div style={{ height: 1, background: C.border, margin: '4px 0' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>รวม</span>
            <span style={{ fontFamily: 'IBM Plex Sans Thai, sans-serif', fontSize: 18, fontWeight: 700, color: C.accent }}>
              {fmtCurrency(15 * draft.utilities.waterRate + 80 * draft.utilities.elecRate + draft.utilities.wifi + draft.utilities.commonFee)}
            </span>
          </div>
        </div>
      </Card>
    </div>
  );
}

function UtilRow({ label, value }) {
  const C = window.ADMIN_C;
  const { fmtCurrency } = window;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
      <span style={{ color: C.ink2 }}>{label}</span>
      <span style={{ fontFamily: 'JetBrains Mono, monospace', color: C.ink, fontWeight: 500 }}>{fmtCurrency(value)}</span>
    </div>
  );
}

// ============================================================
// Tab 3: Discounts
// ============================================================
function TabDiscount({ draft, updatePath }) {
  const C = window.ADMIN_C;
  const { Card, Input, SectionHeading, Pill } = window;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 900 }}>
      <Card>
        <SectionHeading
          title="ส่วนลดสำหรับสัญญาระยะยาว"
          subtitle="จูงใจให้ผู้เช่าทำสัญญายาวขึ้น ลดความเสี่ยงห้องว่าง"
          level={3}
        />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <Input label="สัญญา 6 เดือน"  type="number" suffix="% ส่วนลด"
                 value={draft.discounts.sixMonth}
                 onChange={(v) => updatePath('discounts.sixMonth', Number(v))} />
          <Input label="สัญญา 12 เดือน" type="number" suffix="% ส่วนลด"
                 value={draft.discounts.twelveMonth}
                 onChange={(v) => updatePath('discounts.twelveMonth', Number(v))} />
          <Input label="สัญญา 24 เดือน" type="number" suffix="% ส่วนลด"
                 value={draft.discounts.twentyFourMonth}
                 onChange={(v) => updatePath('discounts.twentyFourMonth', Number(v))} />
        </div>
      </Card>

      <Card>
        <SectionHeading title="โปรโมชั่นพิเศษ" level={3} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <Input label="ส่วนลดเดือนแรก (ผู้เช่าใหม่)" type="number" suffix="% ส่วนลด"
                 value={draft.discounts.firstMonth}
                 onChange={(v) => updatePath('discounts.firstMonth', Number(v))}
                 hint="ส่วนลดเฉพาะเดือนแรกเท่านั้น" />
        </div>
        {/* `discounts.referral` and `discounts.loyaltyPerYear` inputs lived
            here but services/billing.js never read them — they were a
            config-tab tease that did nothing to actual bills. Removed so
            admin doesn't waste time tuning a number with no effect.
            Re-add only when the corresponding apply-credit logic ships. */}
      </Card>

      <Card style={{ background: C.surfaceAlt }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <span style={{ fontSize: 18 }}>💡</span>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>คำแนะนำการตั้งส่วนลด</div>
        </div>
        <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: C.ink2, lineHeight: 1.7 }}>
          <li>สัญญา 12 เดือนควรมีส่วนลดประมาณ <Pill color="success" size="sm">8-12%</Pill> เพื่อสมดุลระหว่างผลกำไรและความน่าสนใจ</li>
          <li>ส่วนลดเดือนแรก 50% เป็นกลยุทธ์ดึงผู้เช่าในช่วงโปรโมชั่นเปิดตึก</li>
        </ul>
      </Card>
    </div>
  );
}

// ============================================================
// Tab 4: Fees & penalties
// ============================================================
function TabFees({ draft, updatePath }) {
  const C = window.ADMIN_C;
  const { Card, Input, SectionHeading } = window;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 900 }}>
      {/* `fees.contract`, `fees.rekey`, `fees.cleaning` inputs lived here
          but services/billing.js / routes/* read none of them — they
          shipped as cosmetic settings. Removed so the admin doesn't tune
          numbers with no bill-level effect. Any one-off charge (cleaning
          fee at move-out, lost-key fee, etc.) is now entered as a
          one_off row in /admin#recurring so the server's bill generator
          auto-includes it via the recurring_charges path. */}
      <Card style={{ background: C.surfaceAlt }}>
        <SectionHeading title="ค่าธรรมเนียมแบบครั้งเดียว" level={3} />
        <div style={{ fontSize: 13, color: C.ink2, lineHeight: 1.6 }}>
          ค่าทำสัญญา / ค่าทำกุญแจ / ค่าทำความสะอาด และค่าธรรมเนียมครั้งเดียวอื่นๆ
          ใช้ผ่านหน้า <b>ค่าใช้จ่ายประจำ</b> โดยเลือก frequency = <code>one_off</code>
          — ระบบจะแนบเข้าบิลรอบถัดไปอัตโนมัติแล้วปิด row ทันทีเพื่อกันคิดซ้ำ.
          <div style={{ marginTop: 10 }}>
            <a href="/admin#recurring" style={{
              padding: '6px 12px', borderRadius: 6, background: C.accent,
              color: '#fff', textDecoration: 'none', fontSize: 12.5, fontWeight: 500,
            }}>ไปจัดการค่าใช้จ่ายประจำ →</a>
          </div>
        </div>
      </Card>

      <Card>
        <SectionHeading title="ค่าปรับและบทลงโทษ" level={3} />
        {/* The legacy `latePenaltyPerDay` (THB/day) field used to live here,
            but nothing on the server reads it — services/billing.js (line ~101)
            uses features.lateFee.ratePctPerMonth + gracePeriodDays as the
            authoritative calc. Setting a THB/day number here just made the
            client-side preview disagree with the actual bill. Canonical
            surface for late fees is now Settings → ฟีเจอร์ระบบ → ค่าปรับ. */}
        <div style={{
          padding: 12, background: C.surfaceAlt,
          border: `1px solid ${C.border}`, borderRadius: 8,
          fontSize: 13, color: C.ink2, lineHeight: 1.6,
        }}>
          💡 ค่าปรับชำระล่าช้าตั้งค่าที่ <b>ฟีเจอร์ระบบ → ค่าปรับชำระล่าช้า</b>
          (อัตรา %/เดือน + วันผ่อนผัน) — ใช้ source เดียวกับการคำนวณจริงใน
          backend เพื่อป้องกัน preview ไม่ตรงกับบิลจริง.
        </div>
      </Card>
    </div>
  );
}

window.PagePricing = PagePricing;
