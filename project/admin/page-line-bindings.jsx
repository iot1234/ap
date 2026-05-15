// === admin/page-line-bindings.jsx ==========================================
// Manage LINE OA bindings per tenant. Shows a table with each tenant's
// current state — pending code / bound / unbound / blocked — and lets
// admin issue/revoke/block from the row, plus a QR modal for show-and-tell.
// ===========================================================================

const { useState, useEffect, useMemo } = React;

function PageLineBindings({ setToast }) {
  const C = window.ADMIN_C;
  const { Card, SectionHeading, Btn, Pill, PageContainer, PageHeader, EmptyState, Modal } = window;
  const apiFetch = window.requireApiFetch ? window.requireApiFetch() : window.apiFetch;
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({});
  const [filter, setFilter] = useState('actionable');  // actionable | all | bound | blocked
  const [openId, setOpenId] = useState(null);
  const [openDetail, setOpenDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [oas, setOas] = useState([]);                 // list of registered OAs
  const [issueOaId, setIssueOaId] = useState('');     // selected target OA for issue
  const [showIssueModal, setShowIssueModal] = useState(null); // { tenantId } when picking OA

  async function load() {
    try {
      const [r1, r2] = await Promise.all([
        fetch('/api/admin/line-bindings', { credentials: 'same-origin' }),
        fetch('/api/admin/line-oas', { credentials: 'same-origin' }).catch(() => null),
      ]);
      const d = await r1.json();
      if (!r1.ok) throw new Error(d.error || 'load failed');
      setItems(d.items || []);
      setCounts(d.counts || {});
      if (r2 && r2.ok) {
        const d2 = await r2.json();
        setOas((d2.items || []).filter((o) => o.enabled));
      }
    } catch (e) {
      setToast && setToast({ kind: 'error', message: e.message });
    }
  }
  useEffect(() => { load(); }, []);

  async function loadDetail(id) {
    try {
      const r = await fetch(`/api/admin/line-bindings/tenants/${id}`, { credentials: 'same-origin' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'load failed');
      setOpenDetail(d);
    } catch (e) { setToast && setToast({ kind: 'error', message: e.message }); }
  }

  // Issue a code, optionally targeting a specific OA. If admin has ≥2 OAs we
  // open a small modal to let them pick; with ≤1 OA we issue directly.
  function startIssue(tenantId) {
    if (oas.length <= 1) {
      issue(tenantId, oas[0]?.id || null);
      return;
    }
    setIssueOaId('');  // any-OA by default
    setShowIssueModal({ tenantId });
  }

  async function issue(id, targetOaId) {
    setBusy(true);
    try {
      const body = { ttlDays: 7 };
      if (targetOaId != null && targetOaId !== '' && Number(targetOaId) > 0) {
        body.targetOaId = Number(targetOaId);
      }
      const r = await apiFetch(`/api/admin/line-bindings/tenants/${id}`, {
        method: 'POST', body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'failed');
      setToast && setToast({ kind: 'success', message: `ออกรหัสแล้ว: ${d.code}` });
      setShowIssueModal(null);
      await load();
      if (openId === id || id === showIssueModal?.tenantId) await loadDetail(id);
    } catch (e) { setToast && setToast({ kind: 'error', message: e.message }); }
    finally { setBusy(false); }
  }

  async function revoke(id) {
    if (!window.confirm('ยกเลิก / ปลดผูก LINE ของผู้เช่ารายนี้?')) return;
    setBusy(true);
    try {
      const r = await apiFetch(`/api/admin/line-bindings/tenants/${id}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'failed');
      setToast && setToast({ kind: 'success', message: 'ปลดผูกแล้ว' });
      await load();
      if (openId === id) await loadDetail(id);
    } catch (e) { setToast && setToast({ kind: 'error', message: e.message }); }
    finally { setBusy(false); }
  }

  async function block(id) {
    const reason = window.prompt('เหตุผลที่บล็อก (optional):', '') || '';
    setBusy(true);
    try {
      const r = await apiFetch(`/api/admin/line-bindings/tenants/${id}/block`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'failed');
      setToast && setToast({ kind: 'success', message: 'บล็อกแล้ว' });
      await load();
    } catch (e) { setToast && setToast({ kind: 'error', message: e.message }); }
    finally { setBusy(false); }
  }

  async function unblock(id) {
    setBusy(true);
    try {
      const r = await apiFetch(`/api/admin/line-bindings/tenants/${id}/unblock`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'failed');
      setToast && setToast({ kind: 'success', message: 'ยกเลิกการบล็อกแล้ว' });
      await load();
    } catch (e) { setToast && setToast({ kind: 'error', message: e.message }); }
    finally { setBusy(false); }
  }

  const filtered = useMemo(() => {
    if (filter === 'all') return items;
    if (filter === 'bound') return items.filter((x) => x.line_user_id && !x.line_binding_blocked);
    if (filter === 'blocked') return items.filter((x) => x.line_binding_blocked);
    // actionable = pending or unbound (not blocked)
    return items.filter((x) =>
      !x.line_binding_blocked && (x.binding_status === 'pending' || !x.line_user_id)
    );
  }, [items, filter]);

  function rowState(row) {
    if (row.line_binding_blocked) return { label: 'บล็อก', color: '#b94a48' };
    if (row.binding_status === 'pending') {
      const remaining = row.expires_at
        ? Math.max(0, Math.ceil((new Date(row.expires_at).getTime() - Date.now()) / 86_400_000))
        : 0;
      return { label: `รอผูก (${remaining}d)`, color: '#c08a2a' };
    }
    if (row.line_user_id) return { label: 'ผูกแล้ว', color: '#2f8f5b' };
    return { label: 'ยังไม่ผูก', color: C.muted };
  }

  return (
    <PageContainer>
      <PageHeader title="ผูกบัญชี LINE OA"
        subtitle="ออกรหัสยืนยันให้ผู้เช่า — ผู้เช่า add OA + ส่งรหัสในแชต = ผูกอัตโนมัติ"
        actions={
          <select value={filter} onChange={(e) => setFilter(e.target.value)}
            style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid ' + C.border, background: C.bg, color: C.ink }}>
            <option value="actionable">ต้องดำเนินการ ({(counts.pending || 0) + (counts.unbound || 0)})</option>
            <option value="bound">ผูกแล้ว ({counts.bound || 0})</option>
            <option value="blocked">บล็อก ({counts.blocked || 0})</option>
            <option value="all">ทั้งหมด ({counts.total || 0})</option>
          </select>
        } />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 16 }}>
        <StatCard label="ผู้เช่าทั้งหมด" value={counts.total || 0} color={C.ink} />
        <StatCard label="ผูกแล้ว" value={counts.bound || 0} color="#2f8f5b" />
        <StatCard label="รอผูก (รหัสค้าง)" value={counts.pending || 0} color="#c08a2a" />
        <StatCard label="ยังไม่ผูก" value={counts.unbound || 0} color={C.muted} />
        <StatCard label="บล็อก" value={counts.blocked || 0} color="#b94a48" />
      </div>

      <Card>
        {filtered.length === 0 ? (
          <EmptyState title="ไม่มีผู้เช่าตรงเงื่อนไข" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: C.border, borderRadius: 8, overflow: 'hidden' }}>
            {filtered.map((row) => {
              const state = rowState(row);
              return (
                <div key={row.tenant_id} style={{
                  background: C.bg, padding: '12px 16px', display: 'grid',
                  gridTemplateColumns: '2fr 1fr auto auto', gap: 12, alignItems: 'center',
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>
                      {row.full_name}
                      {row.current_room_id && (
                        <span style={{ color: C.muted, marginLeft: 8, fontWeight: 400 }}>· ห้อง {row.current_room_id}</span>
                      )}
                    </div>
                    <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>
                      {row.phone}
                      {(row.oa_name || row.target_oa_name) && (
                        <span style={{ marginLeft: 8 }}>
                          · {row.oa_name
                              ? `ผ่าน ${row.oa_name}`
                              : `→ ${row.target_oa_name}`}
                        </span>
                      )}
                    </div>
                  </div>
                  <div>
                    <Pill color={state.color}>{state.label}</Pill>
                  </div>
                  <div>
                    {row.code && row.binding_status === 'pending' && (
                      <code style={{
                        fontFamily: 'JetBrains Mono, monospace', fontSize: 12.5,
                        background: C.bgSoft || C.bg, color: C.ink,
                        padding: '4px 8px', borderRadius: 4, border: '1px solid ' + C.border,
                      }}>{row.code}</code>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => { setOpenId(row.tenant_id); loadDetail(row.tenant_id); }}
                      style={btnLink(C)}>จัดการ</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {openId && openDetail && (
        <DetailModal
          C={C} Modal={Modal} Btn={Btn} Pill={Pill}
          detail={openDetail}
          tenantId={openId}
          oas={oas}
          busy={busy}
          onClose={() => { setOpenId(null); setOpenDetail(null); }}
          onIssue={() => startIssue(openId)}
          onRevoke={() => revoke(openId)}
          onBlock={() => block(openId)}
          onUnblock={() => unblock(openId)} />
      )}

      {/* Issue-with-target-OA picker (only shown when admin has ≥2 OAs) */}
      <Modal
        open={!!showIssueModal}
        onClose={() => setShowIssueModal(null)}
        title="เลือก LINE OA สำหรับรหัสนี้"
        footer={
          <>
            <Btn variant="ghost" onClick={() => setShowIssueModal(null)}>ยกเลิก</Btn>
            <Btn variant="primary" disabled={busy}
                 onClick={() => issue(showIssueModal.tenantId, issueOaId)}>
              {busy ? '…' : 'ออกรหัส'}
            </Btn>
          </>
        }
      >
        {showIssueModal && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 14 }}>
            <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.6 }}>
              ผู้เช่าต้องส่งรหัสไปที่ LINE OA ที่เลือกนี้เท่านั้น (ระบบจะปฏิเสธถ้าส่งผิดที่)
              เลือก "ใช้ OA ใดก็ได้" ถ้าไม่อยากบังคับ
            </div>
            <select value={issueOaId} onChange={(e) => setIssueOaId(e.target.value)}
                    style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid ' + C.border,
                             background: C.bg, color: C.ink, fontSize: 14 }}>
              <option value="">— ใช้ OA ใดก็ได้ —</option>
              {oas.filter((o) => !o.isEnvOa || o.id > 0).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} {o.isDefault ? '(default)' : ''}
                </option>
              ))}
            </select>
            {oas.length === 0 && (
              <div style={{ padding: 10, background: C.warningSoft || '#fff7e0',
                            color: C.warningInk || '#7a5a00', borderRadius: 8, fontSize: 12 }}>
                ⚠ ยังไม่มี LINE OA ลงทะเบียนเลย — ไปเพิ่มได้ที่หน้า "จัดการ LINE OA"
              </div>
            )}
          </div>
        )}
      </Modal>
    </PageContainer>
  );
}

function StatCard({ label, value, color }) {
  const C = window.ADMIN_C;
  return (
    <div style={{
      background: C.bg, border: '1px solid ' + C.border, borderRadius: 8, padding: '12px 14px',
    }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: 'IBM Plex Sans Thai', fontSize: 22, fontWeight: 600, color }}>{value}</div>
    </div>
  );
}

function DetailModal({ C, Modal, Btn, Pill, detail, tenantId, oas, busy, onClose, onIssue, onRevoke, onBlock, onUnblock }) {
  const t = detail.tenant;
  const pending = detail.pending;
  const bound = detail.bound;
  const blocked = !!t.line_binding_blocked;
  const hasMultiOas = oas && oas.length > 0;

  function copyCode(code) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(code).then(() => {
      // simple visual feedback
      const el = document.getElementById(`copy-${code}`);
      if (el) { el.innerText = '✓ คัดลอกแล้ว'; setTimeout(() => { el.innerText = 'คัดลอก'; }, 1500); }
    });
  }

  return (
    <Modal open={true} onClose={onClose} title={`${t.full_name}${t.current_room_id ? ' · ห้อง ' + t.current_room_id : ''}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 12, rowGap: 4, fontSize: 13 }}>
          <span style={{ color: C.muted }}>เบอร์โทร:</span><span>{t.phone}</span>
          <span style={{ color: C.muted }}>LINE userId:</span>
          <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>
            {t.line_user_id ? `…${t.line_user_id.slice(-8)}` : '—'}
          </code>
        </div>

        {blocked && (
          <div style={{ padding: 12, background: '#fff5f4', border: '1px solid #f3c2bf', borderRadius: 8, color: '#5a1a13', fontSize: 13 }}>
            🚫 ถูกบล็อกจาก LINE binding
            {t.line_binding_blocked_reason && <div style={{ marginTop: 4, fontSize: 12 }}>เหตุผล: {t.line_binding_blocked_reason}</div>}
          </div>
        )}

        {pending && !blocked && (
          <div style={{ padding: 14, background: C.bgSoft || '#fff7e0', border: '1px solid ' + C.border, borderRadius: 8 }}>
            <div style={{ fontSize: 12, color: C.muted }}>
              รหัสที่ออกล่าสุด · หมดอายุ {new Date(pending.expires_at).toLocaleString('th-TH')}
              {pending.target_oa_name && (
                <span style={{ marginLeft: 8, color: C.accent }}>
                  · ส่งไปที่ <b>{pending.target_oa_name}</b> เท่านั้น
                </span>
              )}
              {!pending.target_oa_name && hasMultiOas && (
                <span style={{ marginLeft: 8 }}>· รับได้ทุก OA</span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
              <code style={{
                fontFamily: 'JetBrains Mono, monospace', fontSize: 18, fontWeight: 600,
                padding: '8px 14px', background: '#fff', borderRadius: 6, border: '1px solid ' + C.border,
              }}>{pending.code}</code>
              <button id={`copy-${pending.code}`} onClick={() => copyCode(pending.code)} style={btnLink(C)}>คัดลอก</button>
            </div>
            <div style={{ marginTop: 12 }}>
              <img src={`/api/admin/line-bindings/tenants/${tenantId}/qr`}
                alt="QR ของรหัส"
                style={{ width: 180, height: 180, borderRadius: 8, border: '1px solid ' + C.border, background: '#fff' }} />
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: C.muted, lineHeight: 1.6 }}>
              📋 ขั้นตอนสำหรับผู้เช่า:<br/>
              1) Add LINE OA เป็นเพื่อน<br/>
              2) ส่งข้อความ <code>{pending.code}</code> ในแชต<br/>
              3) ระบบจะตอบกลับ "ผูกบัญชีสำเร็จ" และเริ่มส่งบิล/แจ้งเตือน
            </div>
          </div>
        )}

        {bound && !pending && !blocked && (
          <div style={{ padding: 12, background: '#f1faf3', border: '1px solid #c8e6cd', borderRadius: 8, color: '#1f6b3a', fontSize: 13 }}>
            ✅ ผูกบัญชีแล้วเมื่อ {new Date(bound.bound_at).toLocaleString('th-TH')}
            {bound.oa_name && (
              <div style={{ marginTop: 4, fontSize: 12, color: '#1f6b3a' }}>
                ผ่าน LINE OA: <b>{bound.oa_name}</b> — บิล/แจ้งเตือนจะส่งกลับผ่าน OA นี้
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          {!blocked && (
            <Btn variant="primary" disabled={busy} onClick={onIssue}>
              {pending ? 'ออกรหัสใหม่ (ยกเลิกอันเก่า)' : 'ออกรหัสยืนยัน'}
            </Btn>
          )}
          {(pending || bound) && !blocked && (
            <Btn disabled={busy} onClick={onRevoke}>{bound ? 'ปลดผูก LINE' : 'ยกเลิกรหัส'}</Btn>
          )}
          {!blocked && (
            <Btn variant="danger" disabled={busy} onClick={onBlock}>บล็อกการผูก</Btn>
          )}
          {blocked && (
            <Btn disabled={busy} onClick={onUnblock}>ยกเลิกการบล็อก</Btn>
          )}
          <Btn variant="ghost" onClick={onClose}>ปิด</Btn>
        </div>

        {detail.history && detail.history.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>ประวัติ {detail.history.length} รายการ</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: C.border, borderRadius: 6, fontSize: 12, maxHeight: 200, overflow: 'auto' }}>
              {detail.history.map((h) => (
                <div key={h.id} style={{ background: C.bg, padding: '6px 10px', display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 8 }}>
                  <code>{h.code}</code>
                  <Pill color={h.status === 'bound' ? '#2f8f5b' : (h.status === 'pending' ? '#c08a2a' : C.muted)}>{h.status}</Pill>
                  <span style={{ color: C.muted }}>{new Date(h.created_at).toLocaleDateString('th-TH')}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function btnLink(C) {
  return {
    padding: '6px 12px', borderRadius: 6, border: 0,
    background: 'transparent', color: C.accent || '#c46a3e',
    cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
  };
}

window.PageLineBindings = PageLineBindings;
