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
  const apiFetch = window.requireApiFetch ? window.requireApiFetch() : window.apiFetch;

  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState({
    totalOas: 0, enabledOas: 0, totalBound: 0, totalPending: 0,
    totalBindingRows: 0, totalCounterDrift: 0, hasWarnings: false,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lineContact, setLineContact] = useState({ loaded: false, addFriendUrl: '' });
  // diagnostics modal: holds the loaded payload from webhook-status endpoint.
  // null = closed, { loading: true } = fetching, full payload = ready.
  const [diag, setDiag] = useState(null);

  function safePublicLineContactUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      const isLineHost = host === 'line.me' || host.endsWith('.line.me')
        || host === 'lin.ee' || host.endsWith('.lin.ee');
      return u.protocol === 'https:' && isLineHost ? u.toString() : '';
    } catch {
      return '';
    }
  }

  function readPublicLineContactUrl(payload) {
    const cfg = payload && typeof payload === 'object' && payload.value && typeof payload.value === 'object'
      ? payload.value
      : payload;
    const building = cfg && typeof cfg === 'object' && cfg.building && typeof cfg.building === 'object'
      ? cfg.building
      : {};
    return safePublicLineContactUrl(building.lineAddFriendUrl || building.lineUrl || building.lineLink);
  }

  async function openDiagnostics(oa) {
    setDiag({ oa, loading: true });
    try {
      const r = await fetch(`/api/admin/line-oas/${oa.id}/webhook-status`,
        { credentials: 'same-origin' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'load failed');
      setDiag({ oa, ...d });
    } catch (e) {
      setDiag({ oa, error: e.message });
    }
  }

  async function load() {
    setLoading(true); setError(null);
    try {
      const [d, configPayload] = await Promise.all([
        fetch('/api/admin/line-oas', { credentials: 'same-origin' })
          .then(async (r) => {
            const out = await r.json();
            if (!r.ok) throw new Error(out.error || 'load failed');
            return out;
          }),
        fetch('/api/data/baankarn_config_v1', { credentials: 'same-origin' })
          .then((r) => r.ok ? r.json().catch(() => null) : null)
          .catch(() => null),
      ]);
      setItems(d.items || []);
      setSummary(d.summary || summarizeLineOas(d.items || []));
      setLineContact({ loaded: true, addFriendUrl: readPublicLineContactUrl(configPayload) });
    } catch (e) {
      setError(e.message);
      setLineContact((current) => current.loaded ? current : { loaded: true, addFriendUrl: '' });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  function openAdd() {
    setEditing({
      id: null, slug: '', name: '', description: '',
      botBasicId: '', addFriendUrl: '', channelId: '', ownerUserId: '',
      channelAccessToken: '', channelSecret: '',
      enabled: true, isDefault: items.length === 0,
    });
  }
  function openEdit(o) {
    setEditing({
      id: o.id, slug: o.slug, name: o.name, description: o.description || '',
      botBasicId: o.botBasicId || '', addFriendUrl: o.addFriendUrl || '', channelId: o.channelId || '',
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
        addFriendUrl: editing.addFriendUrl,
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
        actions={(
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn variant="secondary" onClick={() => { window.location.hash = '#settings'; }}>
              ตั้งลิงก์ LINE ติดต่อ
            </Btn>
            <Btn variant="primary" icon="+" onClick={openAdd}>เพิ่ม OA</Btn>
          </div>
        )}
      />

      {error && (
        <div style={{ padding: 12, background: C.dangerSoft, color: C.dangerInk,
                       borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
          ⚠️ {error}
        </div>
      )}

      {lineContact.loaded && (
        <div style={{
          padding: 12,
          background: lineContact.addFriendUrl ? (C.successSoft || '#eaf7ef') : (C.warningSoft || '#fff7e0'),
          color: lineContact.addFriendUrl ? (C.successInk || '#17633a') : (C.warningInk || '#7a5a00'),
          borderRadius: 8,
          fontSize: 13,
          lineHeight: 1.6,
          marginBottom: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}>
          <div>
            <b>{lineContact.addFriendUrl ? 'LINE ติดต่อพร้อมใช้งาน' : 'ยังไม่ได้ตั้งลิงก์ LINE ติดต่อ'}</b>
            <div>
              {lineContact.addFriendUrl
                ? 'ผู้จองจะเห็นปุ่ม LINE ติดต่อหลังจองสำเร็จ ส่วน LINE OA Webhook/Token ด้านล่างยังทำงานแยกกันตามเดิม'
                : 'ผู้จองจะเห็นข้อความ "โปรดติดต่อแอดมินเพื่อรับช่องทาง LINE" แทนปุ่ม จนกว่าจะตั้งลิงก์ใน Settings'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {lineContact.addFriendUrl && (
              <Btn variant="secondary" onClick={() => window.open(lineContact.addFriendUrl, '_blank', 'noopener,noreferrer')}>
                เปิด LINE ติดต่อ
              </Btn>
            )}
            <Btn variant="secondary" onClick={() => { window.location.hash = '#settings'; }}>
              ตั้งลิงก์ LINE ติดต่อ
            </Btn>
          </div>
        </div>
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
        gap: 10,
        marginBottom: 16,
      }}>
        <LineOaStat label="ผู้เช่าผูก LINE แล้ว" value={summary.totalBound || 0}
                    note="นับสดจาก tenant ที่มี line_user_id" color="#2f8f5b" />
        <LineOaStat label="รหัสรอผูก" value={summary.totalPending || 0}
                    note="pending code ที่ยังไม่หมดอายุ" color="#c08a2a" />
        <LineOaStat label="OA เปิดใช้งาน" value={`${summary.enabledOas || 0}/${summary.totalOas || 0}`}
                    note="ช่องทางที่รับ/ส่งได้ตอนนี้" color={C.accent || '#2563EB'} />
        <LineOaStat label="สถานะตัวนับ" value={summary.hasWarnings ? 'ต้องตรวจ' : 'ปกติ'}
                    note={summary.hasWarnings ? 'มีข้อมูล binding/cache ไม่ตรงกัน' : 'ค่าหน้า OA ตรงกับข้อมูลจริง'}
                    color={summary.hasWarnings ? '#b94a48' : C.muted} />
      </div>

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
                    <Pill color="success" size="sm">ผูกแล้ว {fmtLineCount(o.boundCount)} คน</Pill>
                    {!!o.pendingCount && <Pill color="warning" size="sm">รอผูก {fmtLineCount(o.pendingCount)}</Pill>}
                    {(o.hasCountDrift || o.hasBindingMismatch) && (
                      <Pill color="danger" size="sm">ตัวนับไม่ตรง</Pill>
                    )}
                  </div>
                  {o.description && (
                    <div style={{ fontSize: 13, color: C.ink2, marginTop: 4 }}>{o.description}</div>
                  )}
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))',
                    gap: 8,
                    marginTop: 10,
                  }}>
                    <OaMetric label="ผูกใช้งานได้" value={o.boundCount || 0}
                              hint="tenants.line_user_id" color="#2f8f5b" />
                    <OaMetric label="binding bound" value={o.bindingBoundCount || 0}
                              hint="line_bindings" color={C.ink2} />
                    <OaMetric label="รอผูก" value={o.pendingCount || 0}
                              hint="code ยังไม่หมดอายุ" color="#c08a2a" />
                    <OaMetric label="cache เดิม" value={o.storedBoundCount || 0}
                              hint={o.hasCountDrift ? `คลาด ${o.counterDrift > 0 ? '+' : ''}${o.counterDrift}` : 'ตรงกัน'}
                              color={o.hasCountDrift ? '#b94a48' : C.muted} />
                  </div>
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
                    {o.addFriendUrl && (
                      <span>
                        <a href={o.addFriendUrl} target="_blank" rel="noreferrer" style={{ color: C.accent, fontWeight: 600 }}>
                          เปิดหน้า LINE OA
                        </a>
                        {' · '}
                      </span>
                    )}
                    {o.oaMessageUrl ? (
                      <span>
                        <a href={o.oaMessageUrl} target="_blank" rel="noreferrer" style={{ color: C.accent, fontWeight: 600 }}>
                          ทดสอบเปิดแชต OA
                        </a>
                        {' · ลิงก์พร้อมคีย์: พร้อม · '}
                      </span>
                    ) : (
                      <span style={{ color: C.warning || '#b45309' }}>
                        ลิงก์พร้อมคีย์: ต้องใส่ Bot Basic ID ·
                      </span>
                    )}
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
                    <Btn variant="ghost" size="sm" onClick={() => openDiagnostics(o)}>
                      🩺 ตรวจ webhook
                    </Btn>
                  )}
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
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 18,
          alignItems: 'center',
        }}>
          <div style={{
            borderRadius: 10,
            overflow: 'hidden',
            border: `1px solid ${C.borderSoft || C.border}`,
            background: C.surfaceAlt,
          }}>
            <img src="/assets/line-oa-setup-guide.png"
                 alt="ภาพประกอบขั้นตอนเชื่อม LINE OA กับระบบหลังบ้าน"
                 style={{ display: 'block', width: '100%', height: 'auto' }} />
          </div>
          <div>
            <SectionHeading
              title="วิธีตั้งค่า LINE Developer Console"
              subtitle="ทำตามขั้นตอนนี้แล้วกลับมากดทดสอบ/ตรวจ webhook บนการ์ด OA เพื่อดูสถานะจริง"
              level={3}
            />
            <ol style={{ fontSize: 13, color: C.ink2, lineHeight: 1.8, paddingLeft: 20, margin: 0 }}>
              <li>เข้า <a href="https://developers.line.biz/console/" target="_blank" rel="noreferrer">LINE Developer Console</a> → เลือก provider → กด Create Messaging API channel</li>
              <li>คัดลอก <b>Channel access token (long-lived)</b> + <b>Channel secret</b></li>
              <li>กด "เพิ่ม OA" ที่หน้านี้ → กรอก slug (ใช้สั้นๆ เช่น <code>main</code>, <code>branch2</code>) + token + secret</li>
              <li>กลับไปที่ LINE Console → Messaging API → ใส่ Webhook URL จากการ์ดด้านบน</li>
              <li>เปิด "Use webhook" → กด Verify เพื่อทดสอบ</li>
              <li>ปิด "Auto-reply messages" + "Greeting messages" เพื่อให้ระบบนี้คุมการตอบกลับเอง</li>
            </ol>
          </div>
        </div>
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
                   hint="ใช้สร้างทั้งลิงก์ add friend และปุ่มเปิด LINE พร้อมคีย์ให้ผู้จองส่งเองใน LINE" />
            <Input label="ลิงก์เปิด LINE OA / Add friend (ไม่บังคับ)"
                   value={editing.addFriendUrl}
                   onChange={(v) => setEditing({ ...editing, addFriendUrl: v })}
                   placeholder="https://lin.ee/xxxx หรือ https://line.me/R/ti/p/@your_oa"
                   hint="ถ้าใส่แค่ lin.ee ระบบเปิด OA ได้ แต่เติมคีย์ให้ผู้จองไม่ได้; ต้องมี Bot Basic ID เพื่อสร้างลิงก์เปิดแชตพร้อมคีย์" />
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

      {/* Webhook diagnostics modal — shows the exact URL + recent events
          (success + failure with reasons) so admin can debug 403 / 404
          without leaving the page. */}
      <Modal
        open={!!diag}
        onClose={() => setDiag(null)}
        title={diag ? `🩺 Webhook Diagnostics — ${diag.oa?.name || 'OA'}` : ''}
        width={620}
        footer={(
          <>
            <Btn variant="ghost" onClick={() => diag && openDiagnostics(diag.oa)}>
              🔄 รีเฟรช
            </Btn>
            <Btn variant="primary" onClick={() => setDiag(null)}>
              ปิด
            </Btn>
          </>
        )}
      >
        {diag && <DiagnosticsBody diag={diag} C={C} />}
      </Modal>
    </PageContainer>
  );
}

// DiagnosticsBody — webhook URL banner + status pill + event list. Pure.
function DiagnosticsBody({ diag, C }) {
  const { Pill } = window;
  if (diag.loading) {
    return <div style={{ padding: 20, color: C.muted, textAlign: 'center' }}>กำลังโหลด…</div>;
  }
  if (diag.error) {
    return (
      <div style={{ padding: 12, background: '#fff5f4', border: '1px solid #f5c0b4',
                    borderRadius: 8, color: '#7a2920' }}>
        ❌ โหลดสถานะไม่ได้: {diag.error}
      </div>
    );
  }
  const ev = diag.events || [];
  const stats = diag.bindingStats || {};
  const hasBindingWarning = !!(stats.hasCountDrift || stats.hasBindingMismatch);
  const hasRecentFail = !!diag.lastFailureAt && (!diag.lastSuccessAt
    || new Date(diag.lastFailureAt) > new Date(diag.lastSuccessAt));
  const overall = ev.length === 0
    ? { icon: '⏳', label: 'ยังไม่เคยมี webhook เข้ามาเลย', bg: '#fff7e0', border: '#f0e3a7', color: '#8a6b1a' }
    : hasRecentFail
      ? { icon: '🔴', label: 'webhook ล่าสุดล้มเหลว — ดู event ด้านล่าง', bg: '#fff5f4', border: '#f5c0b4', color: '#7a2920' }
      : { icon: '✅', label: 'webhook ทำงานปกติ — มี event เข้ามาล่าสุด', bg: '#f0f9f0', border: '#bce0bc', color: '#1f5f3a' };

  const copyUrl = (u) => {
    try { navigator.clipboard.writeText(u); window.toast && window.toast({ kind: 'success', message: 'คัดลอกแล้ว' }); }
    catch { /* manual select */ }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Overall status banner */}
      <div style={{
        padding: 12, borderRadius: 8,
        background: overall.bg, border: `1px solid ${overall.border}`,
      }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: overall.color }}>
          {overall.icon} {overall.label}
        </div>
        {diag.lastSuccessAt && (
          <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
            event ล่าสุดที่ผ่าน: {new Date(diag.lastSuccessAt).toLocaleString('th-TH')}
          </div>
        )}
      </div>

      {/* Webhook URL panel */}
      <div style={{ padding: 12, borderRadius: 8, background: C.surfaceAlt,
                    border: `1px solid ${C.borderSoft || C.border}` }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>
          📋 Webhook URL ที่ต้องใส่ใน LINE Developer Console
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <code style={{ flex: 1, padding: 8, background: '#fff',
                         border: `1px solid ${C.border}`, borderRadius: 6,
                         fontSize: 12, wordBreak: 'break-all',
                         fontFamily: 'JetBrains Mono, monospace' }}>
            {diag.webhookUrl}
          </code>
          <Btn size="sm" variant="ghost" onClick={() => copyUrl(diag.webhookUrl)}>📋</Btn>
        </div>
        <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
          กลับไปที่ Console → Messaging API → Webhook settings → ใส่ URL นี้ →
          กด "Verify"
        </div>
      </div>

      {/* Pre-flight config check */}
      <div style={{ padding: 12, borderRadius: 8, background: C.surfaceAlt,
                    border: `1px solid ${C.borderSoft || C.border}` }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>
          ⚙️ ความพร้อมก่อนตั้งใน LINE Console
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5 }}>
          <div>
            {diag.oa?.enabled ? '✅' : '❌'} OA enabled
            {!diag.oa?.enabled && <span style={{ color: C.muted }}> — เปิด OA ที่หน้านี้ก่อน</span>}
          </div>
          <div>
            {diag.oa?.hasSecret ? '✅' : '❌'} Channel Secret
            {!diag.oa?.hasSecret && <span style={{ color: C.muted }}> — เพิ่มที่ "แก้ไข OA" ก่อน</span>}
          </div>
          <div>
            {diag.oa?.hasToken ? '✅' : '❌'} Channel Access Token
            {!diag.oa?.hasToken && <span style={{ color: C.muted }}> — เพิ่มที่ "แก้ไข OA" ก่อน</span>}
          </div>
        </div>
      </div>

      {/* Binding count diagnostics */}
      <div style={{ padding: 12, borderRadius: 8, background: hasBindingWarning ? '#fff7e0' : C.surfaceAlt,
                    border: `1px solid ${hasBindingWarning ? '#f0d58a' : (C.borderSoft || C.border)}` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>
            🔎 ตรวจจำนวนผู้ผูก LINE
          </div>
          <Pill color={hasBindingWarning ? 'warning' : 'success'} size="sm">
            {hasBindingWarning ? 'พบข้อมูลไม่ตรงกัน' : 'ตัวเลขปกติ'}
          </Pill>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
          <DiagMetric C={C} label="ผูกใช้งานได้" value={stats.boundCount || 0}
                      hint="tenant มี line_user_id" color="#2f8f5b" />
          <DiagMetric C={C} label="binding bound" value={stats.bindingBoundCount || 0}
                      hint="line_bindings" color={C.ink2} />
          <DiagMetric C={C} label="รอผูก" value={stats.pendingCount || 0}
                      hint="pending code" color="#c08a2a" />
          <DiagMetric C={C} label="cache เดิม" value={stats.storedBoundCount || 0}
                      hint={stats.hasCountDrift ? `คลาด ${stats.counterDrift > 0 ? '+' : ''}${stats.counterDrift}` : 'ตรงกัน'}
                      color={stats.hasCountDrift ? '#b94a48' : C.muted} />
        </div>
        {hasBindingWarning && (
          <div style={{ marginTop: 8, fontSize: 12, color: '#7a5a00', lineHeight: 1.5 }}>
            ระบบจะแสดงเลขหลักจาก tenant ที่มี LINE userId เพราะเป็นข้อมูลที่ใช้ส่งแจ้งเตือนจริง
            ส่วนเลข cache เดิมใช้เป็นตัวช่วยจับความคลาดเคลื่อนเท่านั้น
          </div>
        )}
      </div>

      {/* Recent events */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
          📜 Webhook events ล่าสุด (สูงสุด 20)
        </div>
        {ev.length === 0 ? (
          <div style={{ padding: 12, color: C.muted, fontSize: 12.5, fontStyle: 'italic',
                        background: C.surfaceAlt, borderRadius: 6 }}>
            ยังไม่มี event — LINE ยังไม่เคยส่ง webhook ถึงเรา
            หรือเหตุการณ์เกิดเกินช่วงที่เก็บ
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
            {ev.map((e, idx) => {
              const isFail = e.kind === 'failure';
              return (
                <div key={idx} style={{
                  padding: '8px 10px', borderRadius: 6,
                  background: isFail ? '#fff5f4' : '#f0f9f0',
                  border: `1px solid ${isFail ? '#f5c0b4' : '#bce0bc'}`,
                  borderLeft: `3px solid ${isFail ? '#b94a48' : '#2f8f5b'}`,
                  fontSize: 12.5,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <strong style={{ color: isFail ? '#7a2920' : '#1f5f3a' }}>
                      {isFail ? `🔴 ${e.failureKind || 'failure'}` : `✅ ${e.subject?.split(' ')[0] || 'inbound'}`}
                    </strong>
                    <span style={{ color: C.muted, fontSize: 11.5 }}>
                      {new Date(e.createdAt).toLocaleString('th-TH', { hour12: false })}
                    </span>
                  </div>
                  {isFail && e.failureHint && (
                    <div style={{ fontSize: 12, color: '#7a2920', marginTop: 4 }}>
                      → {e.failureHint}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function fmtLineCount(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n.toLocaleString('th-TH') : '0';
}

function summarizeLineOas(items) {
  return (items || []).reduce((acc, o) => {
    acc.totalOas += 1;
    if (o.enabled) acc.enabledOas += 1;
    acc.totalBound += Number(o.boundCount || 0);
    acc.totalBindingRows += Number(o.bindingBoundCount || 0);
    acc.totalPending += Number(o.pendingCount || 0);
    acc.totalCounterDrift += Number(o.counterDrift || 0);
    if (o.hasCountDrift || o.hasBindingMismatch) acc.hasWarnings = true;
    return acc;
  }, {
    totalOas: 0,
    enabledOas: 0,
    totalBound: 0,
    totalBindingRows: 0,
    totalPending: 0,
    totalCounterDrift: 0,
    hasWarnings: false,
  });
}

function LineOaStat({ label, value, note, color }) {
  const C = window.ADMIN_C;
  return (
    <div style={{
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      padding: '12px 14px',
      minWidth: 0,
    }}>
      <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 24, lineHeight: 1.1, fontWeight: 700, color, letterSpacing: 0 }}>
        {typeof value === 'number' ? fmtLineCount(value) : value}
      </div>
      <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>{note}</div>
    </div>
  );
}

function OaMetric({ label, value, hint, color }) {
  const C = window.ADMIN_C;
  return (
    <div style={{
      padding: '8px 10px',
      borderRadius: 8,
      background: C.surfaceAlt,
      border: `1px solid ${C.borderSoft || C.border}`,
      minWidth: 0,
    }}>
      <div style={{ fontSize: 11, color: C.muted }}>{label}</div>
      <div style={{ fontSize: 18, lineHeight: 1.2, fontWeight: 700, color, marginTop: 2 }}>
        {fmtLineCount(value)}
      </div>
      <div style={{ fontSize: 10.5, color: C.muted, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {hint}
      </div>
    </div>
  );
}

function DiagMetric({ C, label, value, hint, color }) {
  return (
    <div style={{
      padding: '8px 10px',
      borderRadius: 8,
      background: '#fff',
      border: `1px solid ${C.borderSoft || C.border}`,
      minWidth: 0,
    }}>
      <div style={{ fontSize: 11, color: C.muted }}>{label}</div>
      <div style={{ fontSize: 19, lineHeight: 1.2, fontWeight: 700, color, marginTop: 2 }}>
        {fmtLineCount(value)}
      </div>
      <div style={{ fontSize: 10.5, color: C.muted, marginTop: 2 }}>{hint}</div>
    </div>
  );
}

window.PageLineOas = PageLineOas;
