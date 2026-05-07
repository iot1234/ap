// === admin/page-secrets.jsx ================================================
// Manage encrypted secret values (LINE / SMTP / Sentry / R2 / PromptPay)
// from the admin UI. Replaces the old "set env vars on Railway" workflow
// for non-database keys. Owner-only.
//
// UX: each group is a card. Each row shows:
//   - label + description
//   - current state (• value masked when set, or "ยังไม่ได้ตั้ง")
//   - source pill (env / db / —)
//   - "แก้ไข" button → reveals input + save/clear actions
//   - For env-managed keys: read-only with a hint
// ===========================================================================

const { useState, useEffect, useMemo } = React;

const GROUP_META = {
  line:      { title: 'LINE Messaging API',  icon: '💬', desc: 'Token + Owner ID สำหรับส่งแจ้งเตือนและรับ webhook' },
  smtp:      { title: 'อีเมล (SMTP)',          icon: '📧', desc: 'Host/User/Password สำหรับส่งอีเมลแจ้งเตือน (fallback ของ LINE)' },
  promptpay: { title: 'PromptPay',             icon: '💸', desc: 'เบอร์โทร/บัตร ปชช. สำหรับสร้าง QR ในบิล' },
  sentry:    { title: 'Error Tracking (Sentry)', icon: '🐛', desc: 'DSN สำหรับเก็บ exception report' },
  r2:        { title: 'Cloud Backup (R2/S3)',  icon: '☁️', desc: 'S3-compatible storage สำหรับ backup อัตโนมัติ' },
};

function PageSecrets({ setToast }) {
  const C = window.ADMIN_C;
  const { Card, SectionHeading, Btn, Pill, PageContainer, PageHeader } = window;
  const apiFetch = window.apiFetch;
  const [groups, setGroups] = useState({});
  const [editing, setEditing] = useState({});
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState({});

  async function load() {
    try {
      const r = await fetch('/api/admin/secrets', { credentials: 'same-origin' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'load failed');
      setGroups(d.groups || {});
    } catch (e) {
      setToast && setToast({ kind: 'error', message: e.message });
    }
  }
  useEffect(() => { load(); }, []);

  async function save(key, value) {
    setBusy(true);
    try {
      const r = await apiFetch(`/api/admin/secrets/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'save failed');
      setToast && setToast({ kind: 'success', message: value ? `บันทึก ${key} แล้ว` : `ลบ ${key} แล้ว` });
      setEditing((e) => ({ ...e, [key]: false }));
      setDrafts((d) => ({ ...d, [key]: '' }));
      load();
    } catch (e) {
      setToast && setToast({ kind: 'error', message: e.message });
    } finally { setBusy(false); }
  }

  async function testGroup(group) {
    setTesting((t) => ({ ...t, [group]: true }));
    try {
      const r = await apiFetch('/api/admin/secrets/test', {
        method: 'POST',
        body: JSON.stringify({ group }),
      });
      const d = await r.json();
      if (d.ok) {
        const detail = d.info ? ` (${d.info.displayName || d.info.basicId || 'ok'})` : '';
        setToast && setToast({ kind: 'success', message: `ทดสอบ ${group} สำเร็จ${detail}` });
      } else {
        setToast && setToast({ kind: 'error', message: `${group} ใช้ไม่ได้: ${d.error || 'unknown'}` });
      }
    } catch (e) {
      setToast && setToast({ kind: 'error', message: e.message });
    } finally {
      setTesting((t) => ({ ...t, [group]: false }));
    }
  }

  const groupOrder = ['line', 'smtp', 'promptpay', 'sentry', 'r2'];

  return (
    <PageContainer>
      <PageHeader title="ตั้งค่า API & Secrets"
        subtitle="ทุกค่าเข้ารหัสด้วย AES-256-GCM ใน DB · env วาง override ได้ตามต้องการ" />

      <Card style={{ background: C.warningSoft || '#fff7e0', borderLeft: `4px solid ${C.warning || '#c08a2a'}` }}>
        <div style={{ fontSize: 13, color: C.ink2 || C.ink, lineHeight: 1.6 }}>
          🔐 <b>ความปลอดภัย:</b> ค่าที่ตั้งจะถูกเข้ารหัสและเก็บใน DB ทันที — ไม่แสดงค่าจริงในหน้านี้อีก<br/>
          ⚙️ <b>Env override:</b> ถ้าตั้งใน Railway Variables ค่านั้นจะใช้ก่อนเสมอ (เปลี่ยนผ่าน UI ไม่มีผล)<br/>
          🗝️ <b>กุญแจฐานข้อมูล:</b> DATABASE_URL / SESSION_SECRET / ENCRYPTION_KEY ตั้งใน env เท่านั้น (ความปลอดภัย)
        </div>
      </Card>

      {groupOrder.filter((g) => groups[g] && groups[g].length).map((group) => {
        const meta = GROUP_META[group] || { title: group, icon: '•', desc: '' };
        return (
          <Card key={group}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
              <div>
                <div style={{ fontFamily: 'Sora', fontSize: 16, fontWeight: 600 }}>
                  {meta.icon} {meta.title}
                </div>
                <div style={{ color: C.muted, fontSize: 13, marginTop: 2 }}>{meta.desc}</div>
              </div>
              {(group === 'line' || group === 'smtp') && (
                <Btn size="sm" onClick={() => testGroup(group)} disabled={!!testing[group]}>
                  {testing[group] ? 'กำลังทดสอบ…' : '🔌 ทดสอบ'}
                </Btn>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: C.border, borderRadius: 8, overflow: 'hidden' }}>
              {groups[group].map((s) => (
                <SecretRow key={s.key}
                  spec={s}
                  editing={!!editing[s.key]}
                  draft={drafts[s.key] || ''}
                  busy={busy}
                  onEdit={() => setEditing((e) => ({ ...e, [s.key]: true }))}
                  onCancel={() => { setEditing((e) => ({ ...e, [s.key]: false })); setDrafts((d) => ({ ...d, [s.key]: '' })); }}
                  onDraft={(v) => setDrafts((d) => ({ ...d, [s.key]: v }))}
                  onSave={() => save(s.key, drafts[s.key] || '')}
                  onClear={() => save(s.key, '')}
                  C={C} />
              ))}
            </div>
          </Card>
        );
      })}

      {Object.keys(groups).length === 0 && (
        <Card>
          <div style={{ color: C.muted, textAlign: 'center', padding: 20 }}>กำลังโหลด…</div>
        </Card>
      )}
    </PageContainer>
  );
}

function SecretRow({ spec, editing, draft, busy, onEdit, onCancel, onDraft, onSave, onClear, C }) {
  const sourceColor = spec.source === 'env' ? '#3a7bba' : (spec.source === 'db' ? '#2f8f5b' : C.muted);
  const sourceLabel = spec.source === 'env' ? 'env (lock)' : (spec.source === 'db' ? 'DB' : 'ยังไม่ได้ตั้ง');
  const inputType = spec.kind === 'password' ? 'password' : (spec.kind === 'number' ? 'number' : 'text');
  return (
    <div style={{
      background: C.bg, padding: '12px 16px', display: 'grid',
      gridTemplateColumns: '1fr auto', gap: 16, alignItems: 'center',
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13.5 }}>{spec.label}</strong>
          <code style={{ fontSize: 11, color: C.muted, fontFamily: 'JetBrains Mono, monospace' }}>{spec.key}</code>
          <span style={{
            fontSize: 11, padding: '2px 8px', borderRadius: 999,
            background: sourceColor + '22', color: sourceColor, fontWeight: 500,
          }}>{sourceLabel}</span>
        </div>
        {spec.description && (
          <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>{spec.description}</div>
        )}
        {!editing && spec.isSet && (
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12.5, color: C.ink2, marginTop: 4 }}>
            ค่าปัจจุบัน: {spec.maskedTail}
          </div>
        )}
        {editing && (
          <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type={inputType}
              value={draft}
              onChange={(e) => onDraft(e.target.value)}
              placeholder={spec.default ? `default: ${spec.default}` : 'ค่าใหม่'}
              autoComplete="new-password"
              spellCheck={false}
              style={{
                flex: '1 1 240px', minWidth: 200,
                padding: '8px 12px', borderRadius: 6,
                border: '1px solid ' + C.border, background: C.bgSoft || C.bg,
                color: C.ink, fontSize: 13.5, fontFamily: 'inherit',
              }} />
            <button onClick={onSave} disabled={busy || !draft} style={{
              padding: '8px 14px', borderRadius: 6, border: 0, fontFamily: 'inherit', fontSize: 13,
              background: C.accent, color: '#fff', cursor: busy ? 'not-allowed' : 'pointer', fontWeight: 500,
            }}>บันทึก</button>
            {spec.isSet && spec.source === 'db' && (
              <button onClick={() => { if (window.confirm('ลบค่านี้?')) onClear(); }} disabled={busy} style={{
                padding: '8px 14px', borderRadius: 6, border: '1px solid ' + (C.danger || '#b94a48'),
                background: 'transparent', color: C.danger || '#b94a48', fontFamily: 'inherit', fontSize: 13, cursor: 'pointer',
              }}>ลบค่า</button>
            )}
            <button onClick={onCancel} style={{
              padding: '8px 14px', borderRadius: 6, border: 0, background: 'transparent',
              color: C.muted, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
            }}>ยกเลิก</button>
          </div>
        )}
      </div>
      {!editing && !spec.readOnly && (
        <button onClick={onEdit} style={{
          padding: '6px 14px', borderRadius: 6, border: '1px solid ' + C.border,
          background: 'transparent', color: C.ink, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5,
        }}>{spec.isSet ? 'เปลี่ยนค่า' : 'ตั้งค่า'}</button>
      )}
      {!editing && spec.readOnly && (
        <span style={{ color: C.muted, fontSize: 11, fontStyle: 'italic' }}>ตั้งใน env แล้ว</span>
      )}
    </div>
  );
}

window.PageSecrets = PageSecrets;
