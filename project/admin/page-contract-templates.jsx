// === admin/page-contract-templates.jsx ====================================
// CRUD UI for contract_templates. Operators land here from sidebar →
// "เทมเพลตสัญญา". One screen does everything:
//   - List all templates with badge + clause count
//   - Create / edit / soft-delete / set-default
//   - Live clause editor (add/remove/reorder)
//   - Section visibility toggles + custom variables editor
//   - Preview the resolved contract as PDF in a new tab
//
// Backed by /api/admin/contract-templates (CRUD) and /api/contracts/:id/pdf
// (preview render with ?templateId=N).
// ===========================================================================

const { useState, useEffect, useMemo, useCallback } = React;

function PageContractTemplates({ setToast, addActivity }) {
  const C = window.ADMIN_C;
  const { Card, Btn, Modal, Pill, PageContainer, PageHeader } = window;
  const apiCall = window.apiCall;

  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);   // template object or 'new'
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [defaultClauses, setDefaultClauses] = useState([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const params = includeDisabled ? '?includeDisabled=1' : '';
      const d = await apiCall(`/api/admin/contract-templates${params}`);
      setList(d.templates || []);
      setDefaultClauses(d.defaults || []);
    } catch (err) {
      setToast && setToast({ kind: 'danger', message: 'โหลด templates ล้มเหลว: ' + err.message });
    } finally {
      setLoading(false);
    }
  }, [includeDisabled]);
  useEffect(() => { refresh(); }, [refresh]);

  const setDefault = async (tpl) => {
    try {
      await apiCall(`/api/admin/contract-templates/${tpl.id}/set-default`, { method: 'POST' });
      setToast && setToast({ kind: 'success', message: `ตั้ง "${tpl.name}" เป็น default แล้ว` });
      addActivity && addActivity({ icon: '⭐', text: `ตั้ง template ${tpl.name} เป็น default`, type: 'system' });
      refresh();
    } catch (err) {
      setToast && setToast({ kind: 'danger', message: err.message });
    }
  };

  const remove = async (tpl) => {
    if (!confirm(`ลบ template "${tpl.name}"? (สัญญาที่ใช้ template นี้จะกลับไปใช้ default)`)) return;
    try {
      await apiCall(`/api/admin/contract-templates/${tpl.id}`, { method: 'DELETE' });
      setToast && setToast({ kind: 'success', message: `ลบ "${tpl.name}" แล้ว` });
      addActivity && addActivity({ icon: '🗑', text: `ลบ template ${tpl.name}`, type: 'system' });
      refresh();
    } catch (err) {
      setToast && setToast({ kind: 'danger', message: err.message });
    }
  };

  const toggleEnabled = async (tpl) => {
    // Open the editor + flip enabled in one save round-trip is more reliable
    // than a dedicated endpoint — reuses validation server-side.
    try {
      await apiCall(`/api/admin/contract-templates/${tpl.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: tpl.name, description: tpl.description, mode: tpl.mode,
          clauses: tpl.clauses, sections: tpl.sections, variables: tpl.variables,
          isDefault: tpl.is_default, enabled: !tpl.enabled,
        }),
      });
      setToast && setToast({ kind: 'success',
        message: `${!tpl.enabled ? 'เปิด' : 'ปิด'}ใช้งาน "${tpl.name}" แล้ว` });
      refresh();
    } catch (err) {
      setToast && setToast({ kind: 'danger', message: err.message });
    }
  };

  return (
    <PageContainer>
      <PageHeader
        title="เทมเพลตสัญญา"
        subtitle={`${list.length} เทมเพลตในระบบ · ใช้ default 12 ข้อบังคับมาตรฐานก็ได้`}
        actions={
          <>
            <Btn variant="ghost" onClick={refresh}>↻ รีเฟรช</Btn>
            <Btn variant="primary" onClick={() => setEditing('new')}>+ สร้าง template</Btn>
          </>
        }
      />

      <Card>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: C.ink2 }}>
            <input type="checkbox" checked={includeDisabled}
              onChange={(e) => setIncludeDisabled(e.target.checked)} />
            แสดง template ที่ปิดใช้งาน
          </label>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 12, color: C.muted }}>
            💡 ระบบมีกฎข้อบังคับมาตรฐาน {defaultClauses.length} ข้อ — admin สร้าง template เพิ่ม
            หรือ override ก็ได้
          </div>
        </div>
      </Card>

      <Card style={{ padding: 0, marginTop: 12, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 30, textAlign: 'center', color: C.muted }}>กำลังโหลด…</div>
        ) : list.length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: C.muted }}>
            ยังไม่มี template — กด <b>"+ สร้าง template"</b> เพื่อเริ่ม หรือใช้ default 12 ข้อมาตรฐาน
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: C.surfaceAlt }}>
                <tr>
                  <th style={th}>ชื่อ</th>
                  <th style={th}>โหมด</th>
                  <th style={th}>ข้อบังคับ</th>
                  <th style={th}>สถานะ</th>
                  <th style={th}>ปรับแก้ล่าสุด</th>
                  <th style={th}>การจัดการ</th>
                </tr>
              </thead>
              <tbody>
                {list.map((t) => (
                  <tr key={t.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td style={td}>
                      <div style={{ fontWeight: 600 }}>
                        {t.name}
                        {t.is_default ? (
                          <span style={{
                            marginLeft: 8, fontSize: 10, padding: '2px 6px',
                            borderRadius: 4, background: '#fff3d6', color: '#92651a',
                          }}>⭐ DEFAULT</span>
                        ) : null}
                      </div>
                      {t.description ? (
                        <div style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>
                          {t.description.slice(0, 80)}
                        </div>
                      ) : null}
                    </td>
                    <td style={td}>
                      <Pill color={
                        t.mode === 'override' ? 'warning' :
                        t.mode === 'append' ? 'success' : 'gray'
                      }>{
                        { default: 'ใช้ default', append: 'default + ของ admin',
                          override: 'override default' }[t.mode] || t.mode
                      }</Pill>
                    </td>
                    <td style={td}>
                      <span style={{ fontFamily: 'monospace', fontSize: 12 }}>
                        {t.clause_count ?? (t.clauses ? t.clauses.length : 0)} ข้อ
                      </span>
                    </td>
                    <td style={td}>
                      <Pill color={t.enabled ? 'success' : 'gray'}>
                        {t.enabled ? 'เปิดใช้งาน' : 'ปิดอยู่'}
                      </Pill>
                    </td>
                    <td style={td}>
                      <div style={{ fontSize: 11, color: C.muted }}>
                        {t.updated_at ? new Date(t.updated_at).toLocaleString('th-TH', {
                          year: 'numeric', month: 'short', day: 'numeric',
                          hour: '2-digit', minute: '2-digit',
                        }) : '-'}
                      </div>
                      <div style={{ fontSize: 11, color: C.muted }}>โดย {t.created_by || '-'}</div>
                    </td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      <Btn size="sm" variant="ghost" onClick={() => setEditing(t)}>แก้ไข</Btn>
                      {!t.is_default && t.enabled ? (
                        <Btn size="sm" variant="ghost" onClick={() => setDefault(t)}
                          title="ตั้งเป็น default">⭐ default</Btn>
                      ) : null}
                      <Btn size="sm" variant="ghost" onClick={() => toggleEnabled(t)}>
                        {t.enabled ? 'ปิด' : 'เปิด'}
                      </Btn>
                      {!t.is_default ? (
                        <Btn size="sm" variant="ghost" onClick={() => remove(t)}
                          style={{ color: '#c0392b' }}>ลบ</Btn>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing ? (
        <TemplateEditor
          template={editing === 'new' ? null : editing}
          defaultClauses={defaultClauses}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            setToast && setToast({ kind: 'success',
              message: `บันทึก "${saved.name}" เรียบร้อย` });
            addActivity && addActivity({ icon: '📝',
              text: `${editing === 'new' ? 'สร้าง' : 'แก้ไข'} template ${saved.name}`,
              type: 'system' });
            refresh();
          }}
          onError={(msg) => setToast && setToast({ kind: 'danger', message: msg })}
        />
      ) : null}
    </PageContainer>
  );
}

// === Template editor modal ================================================
// Two-pane layout: left = metadata + section flags + variables, right =
// clause list editor with add/remove/reorder. Uses tabs to keep the modal
// height manageable on small screens.
function TemplateEditor({ template, defaultClauses, onClose, onSaved, onError }) {
  const C = window.ADMIN_C;
  const { Modal, Btn } = window;
  const apiCall = window.apiCall;
  const isNew = !template;

  // Initialize form state from template or defaults.
  const [form, setForm] = useState(() => ({
    name: template?.name || 'เทมเพลตใหม่',
    description: template?.description || '',
    mode: template?.mode || 'append',
    clauses: Array.isArray(template?.clauses) ? template.clauses.map(normaliseClause) : [],
    sections: Object.assign({
      showWitnesses: true,
      showEmergencyContact: true,
      showPropertyDetails: true,
      showFinancialTable: true,
      showRoomAmenities: true,
      acknowledgmentText: '',
      headerNote: '',
    }, template?.sections || {}),
    variables: Array.isArray(toVariablePairs(template?.variables))
      ? toVariablePairs(template?.variables) : [],
    isDefault: template?.is_default || false,
    enabled: template?.enabled !== false,
  }));
  const [tab, setTab] = useState('basic');     // basic | clauses | sections | variables
  const [busy, setBusy] = useState(false);

  function normaliseClause(c) {
    return {
      id: c.id || null,
      title: String(c.title || ''),
      body: String(c.body || ''),
    };
  }
  function toVariablePairs(obj) {
    if (!obj || typeof obj !== 'object') return [];
    return Object.entries(obj).map(([key, value]) => ({ key, value: String(value) }));
  }
  function fromVariablePairs(pairs) {
    const out = {};
    for (const p of pairs) {
      if (!p || !p.key) continue;
      out[p.key] = String(p.value || '');
    }
    return out;
  }

  const submit = async () => {
    setBusy(true);
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        mode: form.mode,
        clauses: form.clauses
          .filter((c) => c.title.trim() || c.body.trim())  // drop blank rows
          .map((c) => ({ id: c.id || null, title: c.title.trim(), body: c.body.trim() })),
        sections: form.sections,
        variables: fromVariablePairs(form.variables),
        isDefault: form.isDefault,
        enabled: form.enabled,
      };
      if (!payload.name) {
        onError && onError('กรุณาตั้งชื่อ template');
        setBusy(false);
        return;
      }
      const url = isNew
        ? '/api/admin/contract-templates'
        : `/api/admin/contract-templates/${template.id}`;
      const d = await apiCall(url, {
        method: isNew ? 'POST' : 'PUT',
        body: JSON.stringify(payload),
      });
      onSaved && onSaved(d.template);
    } catch (err) {
      onError && onError('บันทึกล้มเหลว: ' + err.message);
    } finally {
      setBusy(false);
    }
  };

  const importDefaults = () => {
    // Append the 12 built-in clauses into the editor so admin can edit them
    // line by line. Useful for "I want to keep most defaults but tweak 2-3"
    // which is common — they'd otherwise have to retype everything.
    if (form.clauses.length > 0) {
      if (!confirm('นำ default 12 ข้อมาแทนที่ clauses ปัจจุบัน?')) return;
    }
    setForm({ ...form, mode: 'override',
      clauses: defaultClauses.map((c) => ({ id: c.id, title: c.title, body: c.body })) });
  };

  return (
    <Modal
      open={true}
      onClose={onClose}
      width={820}
      title={isNew ? 'สร้าง Template ใหม่' : `แก้ไข: ${template.name}`}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={busy}>ยกเลิก</Btn>
          <Btn variant="primary" onClick={submit} disabled={busy}>
            {busy ? 'กำลังบันทึก…' : (isNew ? 'สร้าง' : 'บันทึก')}
          </Btn>
        </>
      }
    >
      {/* Tab switcher */}
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}`, marginBottom: 16 }}>
        {[
          { key: 'basic',     label: '📝 ทั่วไป' },
          { key: 'clauses',   label: `📋 ข้อบังคับ (${form.clauses.length})` },
          { key: 'sections',  label: '🎛 จัดเรียงหน้า' },
          { key: 'variables', label: `🔧 ตัวแปร (${form.variables.length})` },
        ].map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{
              padding: '8px 14px', border: 'none',
              borderBottom: `2px solid ${tab === t.key ? C.accent : 'transparent'}`,
              background: 'transparent', cursor: 'pointer',
              fontSize: 13, fontFamily: 'inherit',
              color: tab === t.key ? C.ink : C.muted,
              fontWeight: tab === t.key ? 600 : 400,
            }}>{t.label}</button>
        ))}
      </div>

      {/* Tab: Basic */}
      {tab === 'basic' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={lbl}>ชื่อ template *</label>
            <input value={form.name} maxLength={200} style={inp}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="เช่น สัญญาผู้เช่ารายปี / สัญญานักศึกษา / สัญญาสำนักงาน" />
          </div>
          <div>
            <label style={lbl}>คำอธิบาย (ทางเลือก)</label>
            <textarea value={form.description} maxLength={1000} rows={2} style={{ ...inp, resize: 'vertical' }}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="ใช้กับใครเมื่อไหร่ — เพื่อให้ทีมงานคนอื่นเลือกใช้ได้ถูก" />
          </div>
          <div>
            <label style={lbl}>โหมด — clauses จะถูกประกอบกับ default 12 ข้อมาตรฐานยังไง</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[
                { v: 'default',  label: 'ใช้ default 12 ข้อเท่านั้น',
                  hint: 'ไม่ต้องเขียน clauses เพิ่ม — สำหรับโรงแรมที่กฎมาตรฐานพอแล้ว' },
                { v: 'append',   label: 'default 12 ข้อ + clauses ของฉันต่อท้าย',
                  hint: 'เพิ่มกฎเฉพาะ เช่น ข้อบังคับสัตว์เลี้ยง ค่าใช้พื้นที่ส่วนกลาง' },
                { v: 'override', label: 'ใช้ clauses ของฉันแทน default ทั้งหมด',
                  hint: 'ต้องมีอย่างน้อย 1 ข้อ — สำหรับสัญญาเฉพาะที่ต่างจากปกติ' },
              ].map((o) => (
                <label key={o.v} style={{
                  display: 'flex', gap: 10, alignItems: 'flex-start', padding: 10,
                  border: `1px solid ${form.mode === o.v ? C.accent : C.border}`,
                  borderRadius: 6, cursor: 'pointer',
                  background: form.mode === o.v ? '#fff7ee' : 'transparent',
                }}>
                  <input type="radio" name="mode" checked={form.mode === o.v}
                    onChange={() => setForm({ ...form, mode: o.v })}
                    style={{ marginTop: 2 }} />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{o.label}</div>
                    <div style={{ fontSize: 11, color: C.muted }}>{o.hint}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label style={chkLabel}>
              <input type="checkbox" checked={form.isDefault}
                onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} />
              <span>ตั้งเป็น default ของระบบ</span>
            </label>
            <label style={chkLabel}>
              <input type="checkbox" checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
              <span>เปิดใช้งาน (ปิดเพื่อพักไว้ก่อน)</span>
            </label>
          </div>
        </div>
      ) : null}

      {/* Tab: Clauses */}
      {tab === 'clauses' ? (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <Btn size="sm" variant="primary"
              onClick={() => setForm({
                ...form,
                clauses: [...form.clauses, { id: null, title: '', body: '' }]
              })}
            >+ เพิ่ม clause</Btn>
            <Btn size="sm" variant="ghost" onClick={importDefaults}>
              📋 นำ default 12 ข้อมา + override
            </Btn>
            <div style={{ flex: 1 }} />
            <div style={{ fontSize: 12, color: C.muted }}>
              ใส่ {'{{ตัวแปร}}'} เพื่อให้ระบบเติมค่าอัตโนมัติ เช่น {'{{monthlyRent}}'} {'{{depositAmount}}'}
            </div>
          </div>
          {form.clauses.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: C.muted, fontSize: 13,
                          border: `1px dashed ${C.border}`, borderRadius: 8 }}>
              ยังไม่มี clauses<br/>
              {form.mode === 'default'
                ? 'โหมดนี้ใช้ default 12 ข้อ — ไม่ต้องเขียนเพิ่ม'
                : 'กด "+ เพิ่ม clause" เพื่อเริ่ม หรือ "นำ default มา"'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {form.clauses.map((c, i) => (
                <ClauseRow key={i} index={i} clause={c}
                  total={form.clauses.length}
                  onChange={(next) => {
                    const arr = [...form.clauses];
                    arr[i] = next;
                    setForm({ ...form, clauses: arr });
                  }}
                  onRemove={() => {
                    const arr = [...form.clauses];
                    arr.splice(i, 1);
                    setForm({ ...form, clauses: arr });
                  }}
                  onMove={(dir) => {
                    const arr = [...form.clauses];
                    const j = i + dir;
                    if (j < 0 || j >= arr.length) return;
                    [arr[i], arr[j]] = [arr[j], arr[i]];
                    setForm({ ...form, clauses: arr });
                  }}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/* Tab: Sections */}
      {tab === 'sections' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
            ปิดเปิดส่วนต่างๆของ PDF ตามต้องการ — ไม่กระทบกับ clauses
          </div>
          {[
            { k: 'showPropertyDetails',  label: 'แสดงรายละเอียดห้อง (ประเภท ชั้น ขนาด)',
              hint: 'ปิดเฉพาะกรณีไม่ต้องการระบุ' },
            { k: 'showRoomAmenities',    label: 'แสดงสิ่งอำนวยความสะดวก (แอร์ ระเบียง ฯลฯ)',
              hint: 'ระบบดึงจากข้อมูลห้องอัตโนมัติ' },
            { k: 'showFinancialTable',   label: 'แสดงตารางการเงิน (ค่าเช่า มัดจำ วันครบกำหนด)',
              hint: 'ปิดเฉพาะกรณี non-rental contract' },
            { k: 'showEmergencyContact', label: 'แสดงผู้ติดต่อฉุกเฉิน',
              hint: 'แสดงชื่อ + เบอร์ผู้ติดต่อในกรณีฉุกเฉินของผู้เช่า' },
            { k: 'showWitnesses',        label: 'แสดงพื้นที่ลายเซ็นพยาน',
              hint: 'ปิดสำหรับสัญญาระยะสั้น/ออนไลน์ที่ไม่ต้องพยาน' },
          ].map((s) => (
            <label key={s.k} style={chkLabel}>
              <input type="checkbox" checked={form.sections[s.k] !== false}
                onChange={(e) => setForm({
                  ...form, sections: { ...form.sections, [s.k]: e.target.checked }
                })} />
              <div>
                <div>{s.label}</div>
                <div style={{ fontSize: 11, color: C.muted }}>{s.hint}</div>
              </div>
            </label>
          ))}
          <div>
            <label style={lbl}>ข้อความรับรอง (ก่อนช่องลงนาม)</label>
            <textarea rows={2} style={{ ...inp, resize: 'vertical' }}
              value={form.sections.acknowledgmentText || ''}
              onChange={(e) => setForm({
                ...form, sections: { ...form.sections, acknowledgmentText: e.target.value }
              })}
              placeholder="เว้นว่างเพื่อใช้ default: คู่สัญญาทั้งสองฝ่ายได้อ่านและเข้าใจ..." />
          </div>
          <div>
            <label style={lbl}>หมายเหตุใต้ header (ทางเลือก)</label>
            <input style={inp}
              value={form.sections.headerNote || ''}
              onChange={(e) => setForm({
                ...form, sections: { ...form.sections, headerNote: e.target.value }
              })}
              placeholder="เช่น เลขทะเบียนหอพัก ใบอนุญาตประกอบการ ฯลฯ" />
          </div>
        </div>
      ) : null}

      {/* Tab: Variables */}
      {tab === 'variables' ? (
        <div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
            ตั้งค่าตัวแปรที่ใช้ใน clauses ผ่าน {'{{ชื่อตัวแปร}}'} — เช่น {'{{wifi_password}}'}, {'{{pet_policy}}'}<br/>
            ใช้ตัวอักษรอังกฤษ ตัวเลข underscore (_) เท่านั้น
          </div>
          <div style={{ marginBottom: 8 }}>
            <Btn size="sm" variant="primary"
              onClick={() => setForm({
                ...form,
                variables: [...form.variables, { key: '', value: '' }]
              })}
            >+ เพิ่มตัวแปร</Btn>
          </div>
          {form.variables.length === 0 ? (
            <div style={{ padding: 20, color: C.muted, fontSize: 13, textAlign: 'center',
                          border: `1px dashed ${C.border}`, borderRadius: 6, lineHeight: 1.6 }}>
              ยังไม่มีตัวแปร — clauses จะใช้แค่ตัวแปรในระบบ ({'{{monthlyRent}}'}, {'{{depositAmount}}'} ฯลฯ)<br/>
              <span style={{ fontSize: 12 }}>
                กด <b>"+ เพิ่มตัวแปร"</b> ด้านบน เพื่อสร้างตัวแปรเฉพาะ เช่น <code>{'{{wifi_password}}'}</code>
              </span>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {form.variables.map((v, i) => (
                <VariableRow key={i} pair={v}
                  onChange={(next) => {
                    const arr = [...form.variables];
                    arr[i] = next;
                    setForm({ ...form, variables: arr });
                  }}
                  onRemove={() => {
                    const arr = [...form.variables];
                    arr.splice(i, 1);
                    setForm({ ...form, variables: arr });
                  }} />
              ))}
            </div>
          )}
          <div style={{ marginTop: 12, padding: 10, background: '#f6f3ec', borderRadius: 6,
                        fontSize: 11, color: C.muted, lineHeight: 1.6 }}>
            <b>ตัวแปรในระบบ (ใช้ได้ในทุก clause):</b><br/>
            <code>{'{{lessorName}}'}</code> {'{{tenantName}}'} {'{{roomId}}'} {'{{roomType}}'} {'{{roomFloor}}'} {'{{roomSize}}'}<br/>
            <code>{'{{monthlyRent}}'}</code> {'{{depositAmount}}'} {'{{startDate}}'} {'{{endDate}}'}<br/>
            <code>{'{{dueDay}}'}</code> {'{{lateFeeRate}}'}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

// === Variable key/value row ===============================================
// Cleans the key as the admin types (lowercase + alphanumeric + underscore)
// and shows a small "→ cleaned" hint when the displayed value differs from
// what they typed — silent transformation otherwise leaves admin confused
// when "Wifi Password" becomes "wifipassword". Reserved names (e.g.
// __proto__) get rejected at server side, but UI mirrors the constraint
// so admin sees the issue immediately.
function VariableRow({ pair, onChange, onRemove }) {
  const C = window.ADMIN_C;
  const { Btn } = window;
  const [raw, setRaw] = React.useState(pair.key || '');
  const cleaned = String(raw || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  const wasCleaned = raw !== cleaned;
  const isReserved = ['__proto__', 'constructor', 'prototype'].includes(cleaned);
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr 36px', gap: 8 }}>
        <input style={{
          ...inp,
          borderColor: isReserved ? '#c0392b' : C.border,
        }}
          placeholder="ชื่อ (เช่น wifi_password)"
          value={raw}
          onBlur={() => { setRaw(cleaned); onChange({ ...pair, key: cleaned }); }}
          onChange={(e) => {
            const next = e.target.value;
            setRaw(next);
            onChange({ ...pair, key: next.toLowerCase().replace(/[^a-z0-9_]/g, '') });
          }} />
        <input style={inp} placeholder="ค่า (≤ 500 ตัวอักษร)"
          maxLength={500}
          value={pair.value}
          onChange={(e) => onChange({ ...pair, value: e.target.value })} />
        <Btn size="sm" variant="ghost" onClick={onRemove}
          style={{ color: '#c0392b' }} title="ลบตัวแปร">×</Btn>
      </div>
      {(wasCleaned || isReserved) ? (
        <div style={{
          fontSize: 11, color: isReserved ? '#c0392b' : C.muted,
          marginTop: 2, marginLeft: 4,
        }}>
          {isReserved
            ? `⚠ "${cleaned}" เป็นชื่อสงวน — กรุณาใช้ชื่ออื่น`
            : `→ ระบบจะบันทึกเป็น "${cleaned}" (ใช้แค่ a-z, 0-9, _)`}
        </div>
      ) : null}
    </div>
  );
}

// === Single clause row ====================================================
// Title input + body textarea + reorder/delete buttons. Compact enough to
// fit several on screen at once but expandable per-row when admin focuses.
function ClauseRow({ index, total, clause, onChange, onRemove, onMove }) {
  const C = window.ADMIN_C;
  const { Btn } = window;
  return (
    <div style={{
      border: `1px solid ${C.border}`, borderRadius: 6, padding: 10,
      background: '#fdfbf6',
    }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <span style={{
          fontSize: 11, fontWeight: 600, color: C.muted,
          background: '#fff', border: `1px solid ${C.border}`,
          padding: '2px 8px', borderRadius: 12, minWidth: 30, textAlign: 'center',
        }}>{index + 1}</span>
        <input style={{
          flex: 1, padding: '6px 10px', border: `1px solid ${C.border}`,
          borderRadius: 4, fontSize: 13, fontFamily: 'inherit', fontWeight: 500,
        }}
          placeholder="หัวข้อ เช่น ค่าเช่า การใช้ห้อง ฯลฯ"
          maxLength={200}
          value={clause.title}
          onChange={(e) => onChange({ ...clause, title: e.target.value })} />
        <Btn size="sm" variant="ghost" disabled={index === 0}
          onClick={() => onMove(-1)} title="เลื่อนขึ้น">▲</Btn>
        <Btn size="sm" variant="ghost" disabled={index === total - 1}
          onClick={() => onMove(1)} title="เลื่อนลง">▼</Btn>
        <Btn size="sm" variant="ghost" onClick={onRemove} title="ลบ"
          style={{ color: '#c0392b' }}>×</Btn>
      </div>
      <textarea rows={3} maxLength={4000}
        placeholder="เนื้อหา — รองรับ {{ตัวแปร}} เช่น {{monthlyRent}}, {{depositAmount}}"
        value={clause.body}
        onChange={(e) => onChange({ ...clause, body: e.target.value })}
        style={{
          width: '100%', padding: '8px 10px',
          border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 13,
          fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.5,
        }} />
      <div style={{ fontSize: 10, color: C.muted, marginTop: 4, textAlign: 'right' }}>
        {clause.body.length}/4000
      </div>
    </div>
  );
}

const th = {
  textAlign: 'left', padding: '10px 14px', fontWeight: 600, fontSize: 12,
  color: '#5b4f40', borderBottom: '1px solid #ece4d4',
};
const td = { padding: '10px 14px', verticalAlign: 'top' };
const lbl = { display: 'block', fontSize: 12, color: '#5b4f40', marginBottom: 4, fontWeight: 500 };
const inp = {
  width: '100%', padding: '8px 10px', border: '1px solid #ece4d4',
  borderRadius: 6, fontSize: 13, fontFamily: 'inherit',
  boxSizing: 'border-box',
};
const chkLabel = {
  display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer',
  fontSize: 13, padding: 8, borderRadius: 6,
};

window.PageContractTemplates = PageContractTemplates;
