// === admin/page-pricing.jsx ===============================================
// ตั้งราคา: 4 tabs - ราคาฐาน, น้ำ-ไฟ, ส่วนลด, ค่าธรรมเนียม
// + Live preview แสดงราคาที่คำนวณได้ตามเงื่อนไข
// ===========================================================================

const { useState, useMemo } = React;

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

// `embedded` lets PageSettings host this component inside its
// "ตั้งราคา" tab without duplicating the outer PageContainer + PageHeader
// chrome. The standalone route /admin#pricing keeps working for legacy
// bookmarks / direct links.
function PagePricing({ config, setConfig, rooms, addActivity, setToast, embedded = false }) {
  const C = window.ADMIN_C;
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES;
  const ADMIN_ROOM_TYPE_KEYS = window.ADMIN_ROOM_TYPE_KEYS;
  const ADMIN_VIEWS = window.ADMIN_VIEWS;
  const { Card, Btn, Input, Select, Toggle, Tabs, Pill, SectionHeading,
          PageContainer, PageHeader, DefList, Modal } = window;
  const Wrapper = embedded
    ? ({ children }) => <div>{children}</div>
    : ({ children }) => <PageContainer>{children}</PageContainer>;
  const Header = embedded
    ? () => null
    : (props) => <PageHeader {...props} />;

  const [tab, setTab] = useState('rates');
  const [draft, setDraft] = useState(config);
  const [confirmReset, setConfirmReset] = useState(false);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(config), [draft, config]);

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
      const next = JSON.parse(JSON.stringify(prev));
      let cur = next;
      const parts = path.split('.');
      for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
      cur[parts[parts.length - 1]] = value;
      return next;
    });
  };
  const handleSave = () => {
    setConfig(draft);
    addActivity && addActivity({ icon: '💰', text: 'อัปเดตการตั้งราคาห้องพัก', type: 'system' });
    setToast && setToast({ kind: 'success', message: 'บันทึกการตั้งราคาเรียบร้อย' });
  };
  const handleReset = () => {
    const next = resetPricingSections(config);
    setDraft(next);
    setConfig(next);
    setConfirmReset(false);
    addActivity && addActivity({ icon: '↺', text: 'รีเซ็ตการตั้งราคาเป็นค่าเริ่มต้น', type: 'system' });
    setToast && setToast({ kind: 'info', message: 'รีเซ็ตเป็นค่าเริ่มต้นแล้ว' });
  };

  return (
    <Wrapper>
      <Header
        title="ตั้งราคาห้องพัก"
        subtitle="กำหนดราคาฐาน, ค่าน้ำ-ไฟ, ส่วนลด และค่าธรรมเนียมต่างๆ อย่างครบถ้วน"
        actions={
          <>
            <Btn variant="ghost" onClick={() => setConfirmReset(true)}>↺ รีเซ็ต</Btn>
            <Btn variant="secondary" onClick={() => setDraft(config)} disabled={!dirty}>ยกเลิกการแก้ไข</Btn>
            <Btn variant="primary" tone="finance" icon="✓" onClick={handleSave} disabled={!dirty}>
              {dirty ? 'บันทึกการเปลี่ยนแปลง' : 'บันทึกแล้ว'}
            </Btn>
          </>
        }
      />
      {/* When embedded inside Settings, show an inline action bar at top
          since the parent Settings header doesn't carry pricing-specific
          actions (Reset / Cancel / Save). Without this, admin opens the
          pricing tab and can't see Save/Reset until they scroll. */}
      {embedded && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          flexWrap: 'wrap', marginBottom: 14,
        }}>
          <Btn variant="ghost" size="sm" onClick={() => setConfirmReset(true)}>↺ รีเซ็ต</Btn>
          <Btn variant="secondary" size="sm" onClick={() => setDraft(config)} disabled={!dirty}>ยกเลิกการแก้ไข</Btn>
          <Btn variant="primary" tone="finance" size="sm" icon="✓" onClick={handleSave} disabled={!dirty}>
            {dirty ? 'บันทึกการเปลี่ยนแปลง' : 'บันทึกแล้ว'}
          </Btn>
        </div>
      )}

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

      <Tabs
        items={[
          { value: 'rates',    label: 'ราคาฐาน',         icon: '🏷️' },
          { value: 'utils',    label: 'ค่าน้ำ-ไฟ',       icon: '💡' },
          { value: 'discount', label: 'ส่วนลด',           icon: '🎁' },
          { value: 'fees',     label: 'ค่าธรรมเนียม',  icon: '📑' },
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

      {/* Reset confirm */}
      <Modal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="รีเซ็ตเป็นค่าเริ่มต้น"
        footer={
          <>
            <Btn variant="ghost" onClick={() => setConfirmReset(false)}>ยกเลิก</Btn>
            <Btn variant="danger" onClick={handleReset}>รีเซ็ต</Btn>
          </>
        }
      >
        <div style={{ fontSize: 14, color: C.ink2, lineHeight: 1.6 }}>
          การกระทำนี้จะรีเซ็ตการตั้งค่าราคาทั้งหมดกลับเป็นค่าเริ่มต้น
          คุณแน่ใจหรือไม่?
        </div>
      </Modal>
    </Wrapper>
  );
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
  const { fmtCurrency, computeRoomRent } = window;
  const { Card, Input, Select, Toggle, SectionHeading, Pill } = window;

  const [previewType, setPreviewType] = useState('deluxe');
  const [previewFloor, setPreviewFloor] = useState('3');
  const [previewView, setPreviewView] = useState('วิวภูเขา');
  const [previewFeats, setPreviewFeats] = useState({ balcony: true, ac: true, parking: false, kitchen: false });

  const previewRent = computeRoomRent(previewType, Number(previewFloor), previewView, previewFeats, draft);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <Card>
          <SectionHeading title="ราคาตามประเภทห้อง" subtitle="ราคาเช่าพื้นฐานและเงินมัดจำของแต่ละประเภท" level={3} />
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
                      updatePath(`rates.${k}.rent`, Number(v));
                      updatePath(`rates.${k}.deposit`, Number(v) * 2);
                    }}
                  />
                  <Input
                    label="เงินมัดจำ" type="number" suffix="บาท"
                    value={r.deposit}
                    onChange={(v) => updatePath(`rates.${k}.deposit`, Number(v))}
                    hint="ปกติเท่ากับ 2 เดือน"
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
              {[
                ['balcony', 'มีระเบียง'],
                ['ac', 'แอร์'],
                ['parking', 'ที่จอดรถ'],
                ['kitchen', 'ครัวในห้อง'],
              ].map(([k, label]) => (
                <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#ebe1cc', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={previewFeats[k]}
                    onChange={(e) => setPreviewFeats(prev => ({ ...prev, [k]: e.target.checked }))}
                    style={{ accentColor: C.accent }}
                  />
                  {label}
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
          <Input label="ส่วนลดแนะนำเพื่อน" type="number" suffix="บาท (เครดิต)"
                 value={draft.discounts.referral}
                 onChange={(v) => updatePath('discounts.referral', Number(v))}
                 hint="ผู้เช่าเดิมแนะนำคนใหม่ ได้รับเครดิต" />
          <Input label="ส่วนลดสำหรับผู้เช่าระยะยาว" type="number" suffix="บาท / ปี"
                 value={draft.discounts.loyaltyPerYear}
                 onChange={(v) => updatePath('discounts.loyaltyPerYear', Number(v))}
                 hint="ลดต่อปีที่อยู่ครบ เช่น 200/ปี → ปีที่ 3 ลด 600" />
        </div>
      </Card>

      <Card style={{ background: C.surfaceAlt }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <span style={{ fontSize: 18 }}>💡</span>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>คำแนะนำการตั้งส่วนลด</div>
        </div>
        <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: C.ink2, lineHeight: 1.7 }}>
          <li>สัญญา 12 เดือนควรมีส่วนลดประมาณ <Pill color="success" size="sm">8-12%</Pill> เพื่อสมดุลระหว่างผลกำไรและความน่าสนใจ</li>
          <li>ส่วนลดเดือนแรก 50% เป็นกลยุทธ์ดึงผู้เช่าในช่วงโปรโมชั่นเปิดตึก</li>
          <li>ส่วนลดแนะนำเพื่อน <Pill color="accent" size="sm">฿500</Pill> เป็นที่นิยมในตลาด</li>
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
      <Card>
        <SectionHeading title="ค่าธรรมเนียมเริ่มต้น" subtitle="เก็บครั้งเดียวเมื่อทำสัญญา" level={3} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <Input label="ค่าทำสัญญา" type="number" suffix="บาท"
                 value={draft.fees.contract}
                 onChange={(v) => updatePath('fees.contract', Number(v))}
                 hint="ค่าจัดทำเอกสารและดำเนินการ" />
          <Input label="ค่าทำกุญแจ" type="number" suffix="บาท / ครั้ง"
                 value={draft.fees.rekey}
                 onChange={(v) => updatePath('fees.rekey', Number(v))}
                 hint="กรณีทำหาย หรือต้องการสำเนา" />
        </div>
      </Card>

      <Card>
        <SectionHeading title="ค่าธรรมเนียมเมื่อย้ายออก" level={3} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <Input label="ค่าทำความสะอาด" type="number" suffix="บาท"
                 value={draft.fees.cleaning}
                 onChange={(v) => updatePath('fees.cleaning', Number(v))}
                 hint="หักจากเงินมัดจำเมื่อสิ้นสุดสัญญา" />
        </div>
      </Card>

      <Card>
        <SectionHeading title="ค่าปรับและบทลงโทษ" level={3} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <Input label="ค่าปรับชำระล่าช้า" type="number" suffix="บาท / วัน"
                 value={draft.fees.latePenaltyPerDay}
                 onChange={(v) => updatePath('fees.latePenaltyPerDay', Number(v))}
                 hint="คิดต่อวันหลังครบกำหนดชำระ" />
        </div>
      </Card>
    </div>
  );
}

window.PagePricing = PagePricing;
