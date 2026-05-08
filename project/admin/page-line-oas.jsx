// === admin/page-line-oas.jsx ==============================================
// Manage multiple LINE Official Accounts. Operator can register N OAs,
// each with its own webhook URL + channel access token + channel secret.
// Tenants bind through any OA → notifications go back through THE SAME OA.
// ===========================================================================

const { useState, useEffect } = React;

function PageLineOas({ setToast }) {
  const C = window.ADMIN_C;
  const { Card, Btn, Input, Toggle, Pill, PageContainer, PageHeader,
          SectionHeading, EmptyState, Modal } = window;
  const apiFetch = window.apiFetch;

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/admin/line-oas', { credentials: 'same-origin' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'load failed');
      setItems(d.items || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  function openAdd() {
    setEditing({
      id: null, slug: '', name: '', description: '',
      botBasicId: '', channelId: '', ownerUserId: '',
      channelAccessToken: '', channelSecret: '',
      enabled: true, isDefault: items.length === 0,
    });
  }
  function openEdit(o) {
    setEditing({
      id: o.id, slug: o.slug, name: o.name, description: o.description || '',
      botBasicId: o.botBasicId || '', channelId: o.channelId || '',
      ownerUserId: o.ownerUserId || '',
      channelAccessToken: '',  // never re-fetched; empty = leave unchanged
      channelSecret: '',
      enabled: o.enabled, isDefault: o.isDefault,
      isEnvOa: o.isEnvOa,
      // Carry the original enabled state + bound count so the save guard
      // below can detect "user just toggled OFF" and warn that bindings
      // will silently stop receiving notifications.
      _wasEnabled: o.enabled,
      _boundCount: o.boundCount || 0,
    });
  }

  async function save() {
    if (!editing.name.trim()) {
      setToast && setToast({ kind: 'error', message: 'ชื่อ OA ห้ามว่าง' });
      return;
    }
    if (!editing.id && !editing.channelAccessToken) {
      setToast && setToast({ kind: 'error', message: 'ต้องใส่ channel access token' });
      return;
    }
    // Pre-flight: disabling an OA that has bound tenants stops every push
    // through that channel — silently. The Toggle's hint says "ปิดเพื่อหยุด
    // ส่ง+รับชั่วคราว ไม่ลบ binding" but doesn't mention how many people
    // are affected. Confirm with the actual count so admin spots a misclick.
    const turningOff = editing._wasEnabled === true && editing.enabled === false;
    if (turningOff && editing._boundCount > 0) {
      const ok = window.confirm(
        `🔌 ปิด OA "${editing.name}" — ผู้เช่า ${editing._boundCount} คนผูกกับ OA นี้\n\n` +
        `📌 จะเกิดอะไรขึ้น:\n` +
        `   ● bindings ที่มีอยู่จะ "ค้าง" ไม่ถูก revoke (พร้อมเปิดใหม่ได้)\n` +
        `   ● ส่ง LINE notify ไป tenant ${editing._boundCount} คนนี้จะหยุดทำงานทันที\n` +
        `   ● bills/maintenance/booking notify จะ fall-back ไป email — ถ้า tenant ไม่มี email ก็ไม่ได้รับเลย\n` +
        `   ● webhook /webhook/line/${editing.slug} จะตอบ 503 — tenant ส่ง BIND-XXXX ใหม่ผูกไม่ได้\n\n` +
        `💡 ทางเลือกที่ปลอดภัยกว่า:\n` +
        `   • ถ้าจะเปลี่ยน OA — สร้าง OA ใหม่ก่อน, set default, แล้วค่อยปิดอันเก่า\n` +
        `   • ถ้าจะรีโทเค็น — แค่อัปเดต channelAccessToken (ปุ่มนี้ไม่ต้องปิด)\n\n` +
        `ยืนยันปิด OA นี้ใช่หรือไม่?`
      );
      if (!ok) {
        // Roll the toggle back so admin doesn't accidentally save again
        // — the modal stays open with the toggle now showing "on".
        setEditing({ ...editing, enabled: true });
        return;
      }
    }
    setBusy(true);
    try {
      const body = {
        slug: editing.slug,
        name: editing.name,
        description: editing.description,
        botBasicId: editing.botBasicId,
        channelId: editing.channelId,
        ownerUserId: editing.ownerUserId,
        enabled: editing.enabled,
        isDefault: editing.isDefault,
      };
      // Only include token/secret if non-empty (empty = leave unchanged)
      if (editing.channelAccessToken) body.channelAccessToken = editing.channelAccessToken;
      if (editing.channelSecret) body.channelSecret = editing.channelSecret;

      let r;
      if (editing.id && !editing.isEnvOa) {
        r = await apiFetch(`/api/admin/line-oas/${editing.id}`, {
          method: 'PUT', body: JSON.stringify(body),
        });
      } else {
        r = await apiFetch('/api/admin/line-oas', {
          method: 'POST', body: JSON.stringify(body),
        });
      }
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'save failed');
      setToast && setToast({ kind: 'success', message: editing.id ? 'อัปเดตแล้ว' : 'เพิ่ม OA แล้ว' });
      setEditing(null);
      await load();
    } catch (e) {
      setToast && setToast({ kind: 'error', message: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function del(id) {
    setBusy(true);
    try {
      const r = await apiFetch(`/api/admin/line-oas/${id}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'delete failed');
      setToast && setToast({ kind: 'success', message: 'ลบ OA แล้ว — bindings ถูก revoke ทั้งหมด' });
      setConfirmDel(null);
      await load();
    } catch (e) {
      setToast && setToast({ kind: 'error', message: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function test(id) {
    setBusy(true);
    try {
      const r = await apiFetch(`/api/admin/line-oas/${id}/test`, { method: 'POST' });
      const d = await r.json();
      if (d.ok && d.info) {
        setToast && setToast({ kind: 'success',
          message: `เชื่อมต่อสำเร็จ — ${d.info.displayName || 'LINE OA'} (${d.info.userId || ''})` });
      } else {
        setToast && setToast({ kind: 'error',
          message: `ทดสอบไม่ผ่าน: ${d.error || `HTTP ${d.status}`}` });
      }
      await load();
    } catch (e) {
      setToast && setToast({ kind: 'error', message: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function setDefault(id) {
    setBusy(true);
    try {
      const r = await apiFetch(`/api/admin/line-oas/${id}/default`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'failed');
      setToast && setToast({ kind: 'success', message: 'ตั้งเป็น default OA แล้ว' });
      await load();
    } catch (e) {
      setToast && setToast({ kind: 'error', message: e.message });
    } finally {
      setBusy(false);
    }
  }

  function copy(text) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(() => {
      setToast && setToast({ kind: 'info', message: 'คัดลอกแล้ว' });
    });
  }

  return (
    <PageContainer>
      <PageHeader
        title="LINE Official Accounts"
        subtitle="ลงทะเบียน LINE OA ได้ไม่จำกัด — ผู้เช่าผูกเข้า OA ใดได้ก็ตาม ระบบจะส่งบิลกลับผ่าน OA นั้น"
        actions={<Btn variant="primary" icon="+" onClick={openAdd}>เพิ่ม OA</Btn>}
      />

      {error && (
        <div style={{ padding: 12, background: C.dangerSoft, color: C.dangerInk,
                       borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
          ⚠️ {error}
        </div>
      )}

      {loading && items.length === 0 ? (
        <Card><div style={{ padding: 40, textAlign: 'center', color: C.muted }}>กำลังโหลด…</div></Card>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon="💬"
            title="ยังไม่มี LINE OA"
            description="กดเพิ่ม OA เพื่อเชื่อม LINE Official Account ของคุณ — ทำได้ไม่จำกัดจำนวน"
            action={<Btn variant="primary" onClick={openAdd}>เพิ่ม OA แรก</Btn>}
          />
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {items.map((o) => (
            <Card key={o.id || 'env'}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 16, fontWeight: 600, color: C.ink }}>{o.name}</span>
                    {o.isDefault && <Pill color="success" size="sm">default</Pill>}
                    {o.enabled
                      ? <Pill color="info" size="sm">เปิด</Pill>
                      : <Pill color="muted" size="sm">ปิด</Pill>}
                    {o.isEnvOa && <Pill color="warning" size="sm">env</Pill>}
                    <span style={{ fontSize: 12, color: C.muted }}>
                      ผูกแล้ว {o.boundCount || 0} คน
                    </span>
                  </div>
                  {o.description && (
                    <div style={{ fontSize: 13, color: C.ink2, marginTop: 4 }}>{o.description}</div>
                  )}
                  <div style={{ marginTop: 10, padding: 10, background: C.surfaceAlt,
                                borderRadius: 6, fontSize: 12, fontFamily: 'JetBrains Mono, monospace' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: C.muted, marginBottom: 4 }}>
                      <span>Webhook URL:</span>
                      <button onClick={() => copy(o.webhookUrl)}
                              style={{ border: 0, background: 'transparent', color: C.accent,
                                       cursor: 'pointer', fontFamily: 'inherit' }}>📋 copy</button>
                    </div>
                    <div style={{ wordBreak: 'break-all', color: C.ink }}>{o.webhookUrl}</div>
                  </div>
                  <div style={{ marginTop: 8, fontSize: 11.5, color: C.muted }}>
                    {o.botBasicId && <span>Bot ID: {o.botBasicId} · </span>}
                    {o.lastSeenAt && <span>เห็นล่าสุด: {new Date(o.lastSeenAt).toLocaleString('th-TH')}</span>}
                    {o.lastError && (
                      <span style={{ color: C.danger, marginLeft: 8 }}>⚠ {o.lastError}</span>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {!o.isEnvOa && !o.isDefault && (
                    <Btn variant="ghost" size="sm" disabled={busy} onClick={() => setDefault(o.id)}>
                      ตั้งเป็น default
                    </Btn>
                  )}
                  <Btn variant="secondary" size="sm" disabled={busy || !o.hasAccessToken}
                       onClick={() => test(o.id)}>
                    🔌 ทดสอบ
                  </Btn>
                  {!o.isEnvOa && (
                    <>
                      <Btn variant="ghost" size="sm" onClick={() => openEdit(o)}>แก้ไข</Btn>
                      <Btn variant="danger" size="sm" disabled={busy}
                           onClick={() => setConfirmDel(o)}>ลบ</Btn>
                    </>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Card style={{ marginTop: 16 }}>
        <SectionHeading title="วิธีตั้งค่า LINE Developer Console" level={3} />
        <ol style={{ fontSize: 13, color: C.ink2, lineHeight: 1.8, paddingLeft: 20 }}>
          <li>เข้า <a href="https://developers.line.biz/console/" target="_blank" rel="noreferrer">LINE Developer Console</a> → เลือก provider → กด Create Messaging API channel</li>
          <li>คัดลอก <b>Channel access token (long-lived)</b> + <b>Channel secret</b></li>
          <li>กด "เพิ่ม OA" ที่หน้านี้ → กรอก slug (ใช้สั้นๆ เช่น <code>main</code>, <code>branch2</code>) + token + secret</li>
          <li>กลับไปที่ LINE Console → Messaging API → ใส่ Webhook URL จากการ์ดด้านบน</li>
          <li>เปิด "Use webhook" → กด Verify เพื่อทดสอบ</li>
          <li>ปิด "Auto-reply messages" + "Greeting messages" (เพื่อให้ระบบเราคุมการตอบเอง)</li>
        </ol>
      </Card>

      {/* Edit / Add modal */}
      <Modal
        open={!!editing}
        onClose={() => !busy && setEditing(null)}
        title={editing?.id ? `แก้ไข ${editing.name}` : 'เพิ่ม LINE OA'}
        footer={
          <>
            <Btn variant="ghost" onClick={() => setEditing(null)} disabled={busy}>ยกเลิก</Btn>
            <Btn variant="primary" onClick={save} disabled={busy}>{busy ? '…' : 'บันทึก'}</Btn>
          </>
        }
      >
        {editing && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Input label="ชื่อ OA"
                   value={editing.name}
                   onChange={(v) => setEditing({ ...editing, name: v })}
                   placeholder="บ้านกาญจน์ Main" />
            <Input label="slug"
                   value={editing.slug}
                   onChange={(v) => setEditing({ ...editing, slug: v.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') })}
                   hint="a-z 0-9 _ - · ใช้เป็นส่วนของ webhook URL · เช่น main, branch2"
                   disabled={editing.isEnvOa} />
            <Input label="คำอธิบาย (ไม่บังคับ)"
                   value={editing.description}
                   onChange={(v) => setEditing({ ...editing, description: v })}
                   placeholder="เช่น ตึก A ชั้น 1-3" />
            <Input label="Bot Basic ID (ไม่บังคับ)"
                   value={editing.botBasicId}
                   onChange={(v) => setEditing({ ...editing, botBasicId: v })}
                   placeholder="@baankarn"
                   hint="ใช้สร้างลิงก์ add friend (อยากให้ผู้เช่ากด add ได้ทันที)" />
            <Input label="LINE userId ของเจ้าของ OA นี้ (ไม่บังคับ)"
                   value={editing.ownerUserId}
                   onChange={(v) => setEditing({ ...editing, ownerUserId: v })}
                   placeholder="Uxxxxxxxxxxxxx"
                   hint="ระบบจะส่งแจ้งเตือนระบบไปที่ userId นี้ผ่าน OA นี้" />
            <Input label={editing.id ? 'Channel access token (เว้นว่าง = ไม่เปลี่ยน)' : 'Channel access token *'}
                   type="password"
                   value={editing.channelAccessToken}
                   onChange={(v) => setEditing({ ...editing, channelAccessToken: v })}
                   placeholder={editing.id ? '••••••• (กรอกใหม่หากต้องการเปลี่ยน)' : 'long-lived token จาก LINE console'} />
            <Input label={editing.id ? 'Channel secret (เว้นว่าง = ไม่เปลี่ยน)' : 'Channel secret *'}
                   type="password"
                   value={editing.channelSecret}
                   onChange={(v) => setEditing({ ...editing, channelSecret: v })}
                   placeholder={editing.id ? '••••••• (กรอกใหม่หากต้องการเปลี่ยน)' : 'channel secret จาก LINE console'} />
            <Toggle label="เปิดใช้งาน OA นี้"
                    checked={editing.enabled}
                    onChange={(v) => setEditing({ ...editing, enabled: v })}
                    hint="ปิดเพื่อหยุดส่ง+รับชั่วคราว ไม่ลบ binding" />
            <Toggle label="ตั้งเป็น default OA"
                    checked={editing.isDefault}
                    onChange={(v) => setEditing({ ...editing, isDefault: v })}
                    hint="ใช้สำหรับ issue code โดยไม่ระบุ OA + ส่งแจ้งเตือนระบบ" />
            {editing.isEnvOa && (
              <div style={{ padding: 10, background: C.warningSoft || '#fff7e0',
                            color: C.warningInk || '#7a5a00', borderRadius: 8, fontSize: 12 }}>
                ⚠ OA นี้คอนฟิกผ่าน env vars (LINE_CHANNEL_ACCESS_TOKEN ฯลฯ) —
                การกดบันทึกจะสร้างเป็น DB row ใหม่ที่ override env
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Confirm delete */}
      <Modal
        open={!!confirmDel}
        onClose={() => !busy && setConfirmDel(null)}
        title="ยืนยันการลบ OA"
        footer={
          <>
            <Btn variant="ghost" onClick={() => setConfirmDel(null)} disabled={busy}>ยกเลิก</Btn>
            <Btn variant="danger" onClick={() => del(confirmDel.id)} disabled={busy}>
              {busy ? '…' : 'ลบ OA'}
            </Btn>
          </>
        }
      >
        {confirmDel && (
          <div style={{ fontSize: 14, color: C.ink2, lineHeight: 1.6 }}>
            ลบ OA <b style={{ color: C.ink }}>{confirmDel.name}</b>?
            <div style={{ marginTop: 10, padding: 10, background: C.dangerSoft,
                          color: C.dangerInk, borderRadius: 8, fontSize: 12.5 }}>
              ⚠ จะ revoke binding ของผู้เช่า {confirmDel.boundCount || 0} คนที่ผูกผ่าน OA นี้ —
              พวกเขาจะหยุดได้รับแจ้งเตือนทันที จนกว่าจะผูกผ่าน OA อื่นใหม่
            </div>
          </div>
        )}
      </Modal>
    </PageContainer>
  );
}

window.PageLineOas = PageLineOas;
