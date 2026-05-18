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
  const [issuedCodeNotice, setIssuedCodeNotice] = useState(null); // sticky latest code; survives toast timeout

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
      return d;
    } catch (e) { setToast && setToast({ kind: 'error', message: e.message }); }
    return null;
  }

  function detailHasCode(detail, code) {
    const rows = [
      ...(Array.isArray(detail?.pendingCodes || detail?.pending_codes) ? (detail.pendingCodes || detail.pending_codes) : []),
      ...(Array.isArray(detail?.history) ? detail.history : []),
      detail?.pending,
    ].filter(Boolean);
    return rows.some((row) => String(row.code || '') === String(code || ''));
  }

  function mergeIssuedCodeIntoDetail(detail, issued) {
    if (!detail || !issued || String(detail.tenant?.id) !== String(issued.tenantId)) return detail;
    const targetOa = issued.targetOaId
      ? (oas || []).find((o) => String(o.id) === String(issued.targetOaId))
      : null;
    const pendingRow = {
      id: issued.id || `issued-${issued.code}`,
      code: issued.code,
      status: 'pending',
      expires_at: issued.expiresAt || issued.expires_at,
      created_at: issued.createdAt || new Date().toISOString(),
      target_oa_id: issued.targetOaId || null,
      target_oa_name: targetOa ? targetOa.name : null,
      target_oa_slug: targetOa ? targetOa.slug : null,
    };
    const currentPendingCodes = Array.isArray(detail.pendingCodes || detail.pending_codes)
      ? (detail.pendingCodes || detail.pending_codes)
      : (detail.pending ? [detail.pending] : []);
    const keptPendingCodes = issued.replacePending
      ? []
      : currentPendingCodes.filter((row) => String(row.code || '') !== String(issued.code));
    const history = Array.isArray(detail.history) ? detail.history : [];
    const keptHistory = history.filter((row) => String(row.code || '') !== String(issued.code));
    return {
      ...detail,
      pending: pendingRow,
      pendingCodes: [pendingRow, ...keptPendingCodes],
      history: [pendingRow, ...keptHistory].slice(0, 200),
    };
  }

  // Issue a code, optionally targeting a specific OA. If admin has ≥2 OAs we
  // open a small modal to let them pick; with ≤1 OA we issue directly.
  function startIssue(tenantId, options = {}) {
    const replacePending = options.replacePending !== false;
    if (oas.length <= 1) {
      issue(tenantId, oas[0]?.id || null, { replacePending });
      return;
    }
    setIssueOaId('');  // any-OA by default
    setShowIssueModal({ tenantId, replacePending });
  }

  async function issue(id, targetOaId, options = {}) {
    setBusy(true);
    try {
      const replacePending = options.replacePending !== false;
      const body = { ttlDays: 7, replacePending };
      if (targetOaId != null && targetOaId !== '' && Number(targetOaId) > 0) {
        body.targetOaId = Number(targetOaId);
      }
      const r = await apiFetch(`/api/admin/line-bindings/tenants/${id}`, {
        method: 'POST', body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'failed');
      const issued = {
        tenantId: id,
        id: d.id,
        code: d.code,
        expiresAt: d.expiresAt || d.expires_at,
        targetOaId: d.targetOaId || d.target_oa_id || (body.targetOaId || null),
        replacePending,
        createdAt: new Date().toISOString(),
      };
      setIssuedCodeNotice(issued);
      setOpenId(id);
      setOpenDetail((prev) => mergeIssuedCodeIntoDetail(prev, issued));
      if (d.detail) {
        setOpenDetail(detailHasCode(d.detail, d.code)
          ? d.detail
          : mergeIssuedCodeIntoDetail(d.detail, issued));
      }
      setToast && setToast({
        kind: 'success',
        message: replacePending
          ? `ออกคีย์ LINE แล้ว: ${d.code}`
          : `ออกคีย์เพิ่มแล้ว: ${d.code} (คีย์เดิมยังใช้ได้)`,
      });
      setShowIssueModal(null);
      await load();
      if (!d.detail || !detailHasCode(d.detail, d.code)) {
        const detail = await loadDetail(id);
        if (!detail || !detailHasCode(detail, d.code)) {
          setOpenDetail((prev) => mergeIssuedCodeIntoDetail(prev, issued));
        }
      }
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

  async function revokeAccount(tenantId, bindingId) {
    if (!window.confirm('ลบบัญชี LINE นี้ออกจากห้องนี้? บัญชี LINE อื่นที่ผูกกับห้องนี้จะยังรับแจ้งเตือนต่อไป')) return;
    setBusy(true);
    try {
      const r = await apiFetch(`/api/admin/line-bindings/tenants/${tenantId}/accounts/${bindingId}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'failed');
      setToast && setToast({ kind: 'success', message: `ลบบัญชี LINE แล้ว เหลือ ${d.remainingBoundCount || 0} บัญชี` });
      await load();
      if (openId === tenantId) await loadDetail(tenantId);
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
    if (filter === 'bound') return items.filter((x) =>
      !x.line_binding_blocked && (x.line_user_id || Number(x.bound_count || 0) > 0)
    );
    if (filter === 'blocked') return items.filter((x) => x.line_binding_blocked);
    // actionable = pending or unbound (not blocked)
    return items.filter((x) =>
      !x.line_binding_blocked && (
        x.binding_status === 'pending' ||
        (!x.line_user_id && Number(x.bound_count || 0) === 0)
      )
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
    if (row.line_user_id || Number(row.bound_count || 0) > 0) {
      const boundCount = Number(row.bound_count || 0) || 1;
      return { label: `ผูกแล้ว ${boundCount} บัญชี`, color: '#2f8f5b' };
    }
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
        <StatCard label="บัญชี LINE ที่ผูก" value={counts.boundAccounts || 0} color="#2f8f5b" />
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
          issuedCodeNotice={issuedCodeNotice}
          onClearIssuedCode={() => setIssuedCodeNotice(null)}
          onClose={() => { setOpenId(null); setOpenDetail(null); }}
          onIssue={() => startIssue(openId, { replacePending: true })}
          onIssueAdditional={() => startIssue(openId, { replacePending: false })}
          onRevoke={() => revoke(openId)}
          onRevokeAccount={(bindingId) => revokeAccount(openId, bindingId)}
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
                 onClick={() => issue(showIssueModal.tenantId, issueOaId, {
                   replacePending: showIssueModal.replacePending !== false,
                 })}>
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

function DetailModal({ C, Modal, Btn, Pill, detail, tenantId, oas, busy, issuedCodeNotice, onClearIssuedCode, onClose, onIssue, onIssueAdditional, onRevoke, onRevokeAccount, onBlock, onUnblock }) {
  const t = detail.tenant;
  const pending = detail.pending;
  const bound = detail.bound;
  const blocked = !!t.line_binding_blocked;
  const boundCount = Number(detail.boundCount || detail.bound_count || 0);
  const boundAccounts = Array.isArray(detail.boundAccounts || detail.bound_accounts)
    ? (detail.boundAccounts || detail.bound_accounts)
    : [];
  const pendingCodes = Array.isArray(detail.pendingCodes || detail.pending_codes)
    ? (detail.pendingCodes || detail.pending_codes)
    : (pending ? [pending] : []);
  const issuedForThisTenant = issuedCodeNotice && String(issuedCodeNotice.tenantId) === String(tenantId)
    ? issuedCodeNotice
    : null;
  const hasMultiOas = oas && oas.length > 0;

  function copyCode(code, elementId) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(code).then(() => {
      // simple visual feedback
      const el = document.getElementById(elementId || `copy-${code}`);
      if (el) { el.innerText = '✓ คัดลอกแล้ว'; setTimeout(() => { el.innerText = 'คัดลอก'; }, 1500); }
    });
  }
  function resolveLineAddUrl(row = pending) {
    const list = Array.isArray(oas) ? oas : [];
    const targetId = row && (row.target_oa_id || row.targetOaId);
    if (targetId) {
      const target = list.find((o) => String(o.id) === String(targetId));
      return target && target.addFriendUrl ? target.addFriendUrl : '';
    }
    const defaultOa = list.find((o) => o.isDefault && o.addFriendUrl);
    if (defaultOa) return defaultOa.addFriendUrl;
    const first = list.find((o) => o.addFriendUrl);
    return first ? first.addFriendUrl : '';
  }
  function resolveLineMessageUrl(row = pending) {
    const list = Array.isArray(oas) ? oas : [];
    const targetId = row && (row.target_oa_id || row.targetOaId);
    if (targetId) {
      const target = list.find((o) => String(o.id) === String(targetId));
      return target && target.oaMessageUrl ? target.oaMessageUrl : '';
    }
    const defaultOa = list.find((o) => o.isDefault && o.oaMessageUrl);
    if (defaultOa) return defaultOa.oaMessageUrl;
    const first = list.find((o) => o.oaMessageUrl);
    return first ? first.oaMessageUrl : '';
  }
  function buildLineTenantBindingMessageLink(baseUrl, code) {
    const bindCode = String(code || '').trim().slice(0, 80);
    if (!baseUrl || !/^BIND-[A-F0-9]{4,16}$/i.test(bindCode)) return '';
    try {
      const u = new URL(String(baseUrl).trim(), window.location.origin);
      if (u.protocol !== 'https:' || u.hostname !== 'line.me' || !u.pathname.startsWith('/R/oaMessage/')) return '';
      const path = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
      return `${u.origin}${path}?${encodeURIComponent(bindCode)}`;
    } catch {
      return '';
    }
  }
  function buildLineOpenUrlFor(row) {
    const messageUrl = buildLineTenantBindingMessageLink(resolveLineMessageUrl(row), row && row.code);
    return messageUrl || resolveLineAddUrl(row);
  }
  const lineAddUrl = resolveLineAddUrl(pending);
  const lineMessageUrl = buildLineTenantBindingMessageLink(resolveLineMessageUrl(pending), pending && pending.code);
  const lineOpenUrl = lineMessageUrl || lineAddUrl;

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

        {issuedForThisTenant && !blocked && (
          <div style={{ padding: 14, background: '#eef8ff', border: '1px solid #b8d9ef', borderRadius: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 12, color: '#2a6285', fontWeight: 700 }}>
                  รหัสล่าสุดที่เพิ่งออก - กล่องนี้จะไม่หายตาม toast
                </div>
                <div style={{ marginTop: 4, fontSize: 12, color: '#2a6285', lineHeight: 1.55 }}>
                  คัดลอกหรือเปิด LINE จากตรงนี้ได้ทันที หากรายการด้านล่าง reload ช้า ระบบยังเก็บรหัสนี้ไว้ให้แอดมินเห็นก่อนส่งให้ผู้เช่า
                </div>
              </div>
              <button onClick={onClearIssuedCode} style={{ ...btnLink(C), color: '#2a6285' }}>ซ่อน</button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
              <code style={{
                fontFamily: 'JetBrains Mono, monospace', fontSize: 18, fontWeight: 700,
                padding: '8px 14px', background: '#fff', borderRadius: 6, border: '1px solid #b8d9ef',
              }}>{issuedForThisTenant.code}</code>
              <button id={`copy-issued-${issuedForThisTenant.code}`}
                onClick={() => copyCode(issuedForThisTenant.code, `copy-issued-${issuedForThisTenant.code}`)}
                style={btnLink(C)}>
                คัดลอก
              </button>
              {buildLineOpenUrlFor({
                code: issuedForThisTenant.code,
                target_oa_id: issuedForThisTenant.targetOaId,
              }) ? (
                <a href={buildLineOpenUrlFor({
                  code: issuedForThisTenant.code,
                  target_oa_id: issuedForThisTenant.targetOaId,
                })} target="_blank" rel="noreferrer"
                  style={{ ...btnLink(C), background: C.accent || '#2f8a70', color: '#fff', textDecoration: 'none' }}>
                  เปิด LINE พร้อมคีย์
                </a>
              ) : (
                <button onClick={() => { window.location.hash = '#line-oas'; }}
                  style={{ ...btnLink(C), border: '1px solid #b8d9ef' }}>
                  ตั้งลิงก์ LINE
                </button>
              )}
            </div>
            <div style={{ marginTop: 8, fontSize: 11.5, color: '#2a6285' }}>
              {issuedForThisTenant.replacePending
                ? 'คีย์นี้แทนคีย์รอผูกเดิมของห้องนี้'
                : 'คีย์นี้เป็นคีย์เพิ่ม คีย์รอผูกเดิมของห้องนี้ยังใช้ได้'}
            </div>
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
              {lineOpenUrl ? (
                <a href={lineOpenUrl} target="_blank" rel="noreferrer"
                  style={{ ...btnLink(C), background: C.accent || '#2f8a70', color: '#fff', textDecoration: 'none' }}>
                  {lineMessageUrl ? 'เปิด LINE พร้อมคีย์' : 'เปิด LINE OA'}
                </a>
              ) : (
                <button onClick={() => { window.location.hash = '#line-oas'; }}
                  style={{ ...btnLink(C), border: '1px solid ' + C.border }}>
                  ตั้งลิงก์ LINE
                </button>
              )}
            </div>
            <div style={{ marginTop: 12 }}>
              <img src={`/api/admin/line-bindings/tenants/${tenantId}/qr`}
                alt="QR ของรหัส"
                style={{ width: 180, height: 180, borderRadius: 8, border: '1px solid ' + C.border, background: '#fff' }} />
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: C.muted, lineHeight: 1.6 }}>
              📋 ขั้นตอนสำหรับผู้เช่า:<br/>
              1) กด “{lineMessageUrl ? 'เปิด LINE พร้อมคีย์' : 'เปิด LINE OA'}” หรือ Add LINE OA เป็นเพื่อน<br/>
              {lineMessageUrl ? (
                <>2) ตรวจว่าช่องพิมพ์มี <code>{pending.code}</code> แล้วกดส่งใน LINE<br/></>
              ) : (
                <>2) ส่งข้อความ <code>{pending.code}</code> ในแชต<br/></>
              )}
              3) ระบบจะตอบกลับ "ผูกบัญชีสำเร็จ" และเริ่มส่งบิล/แจ้งเตือน
            </div>
            {pendingCodes.length > 1 && (
              <div style={{ marginTop: 10, borderTop: '1px solid ' + C.border, paddingTop: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.ink, marginBottom: 6 }}>
                  คีย์รอผูกทั้งหมด ({pendingCodes.length}) - ส่งคนละคีย์ให้แต่ละบัญชี LINE ได้
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {pendingCodes.map((row) => {
                    const openUrl = buildLineOpenUrlFor(row);
                    return (
                      <div key={row.id} style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr auto auto',
                        gap: 8,
                        alignItems: 'center',
                        background: '#fff',
                        border: '1px solid ' + C.border,
                        borderRadius: 6,
                        padding: '7px 8px',
                      }}>
                        <div style={{ minWidth: 0 }}>
                          <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12.5 }}>{row.code}</code>
                          <div style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>
                            หมดอายุ {row.expires_at ? new Date(row.expires_at).toLocaleString('th-TH') : '-'}
                            {row.target_oa_name ? ` · ส่งที่ ${row.target_oa_name}` : ''}
                          </div>
                        </div>
                        <button id={`copy-pending-${row.id}`} onClick={() => copyCode(row.code, `copy-pending-${row.id}`)} style={btnLink(C)}>คัดลอก</button>
                        {openUrl ? (
                          <a href={openUrl} target="_blank" rel="noreferrer"
                            style={{ ...btnLink(C), textDecoration: 'none' }}>
                            เปิด LINE
                          </a>
                        ) : (
                          <button onClick={() => { window.location.hash = '#line-oas'; }}
                            style={btnLink(C)}>
                            ตั้งลิงก์
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {bound && !pending && !blocked && (
          <div style={{ padding: 12, background: '#f1faf3', border: '1px solid #c8e6cd', borderRadius: 8, color: '#1f6b3a', fontSize: 13 }}>
            ✅ ผูกบัญชีแล้วเมื่อ {new Date(bound.bound_at).toLocaleString('th-TH')}
            <div style={{ marginTop: 4, fontSize: 12, color: '#1f6b3a' }}>
              ห้องนี้ผูก LINE แล้วทั้งหมด <b>{boundCount || 1}</b> บัญชี — ทุกบัญชีจะได้รับบิลและแจ้งเตือนของห้องนี้
            </div>
            {bound.oa_name && (
              <div style={{ marginTop: 4, fontSize: 12, color: '#1f6b3a' }}>
                ผ่าน LINE OA: <b>{bound.oa_name}</b> — บิล/แจ้งเตือนจะส่งกลับผ่าน OA นี้
              </div>
            )}
            <div style={{ marginTop: 6, fontSize: 12, color: '#1f6b3a' }}>
              ต้องการเพิ่ม LINE ของคนในห้องนี้ ให้ออกรหัสใหม่แล้วให้บัญชี LINE อีกบัญชีส่งรหัส ระบบจะส่งแจ้งเตือนถึงทุกบัญชีที่ผูกไว้
            </div>
          </div>
        )}

        {boundAccounts.length > 0 && !blocked && (
          <div style={{ marginTop: 4, border: '1px solid ' + C.border, borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ padding: '8px 10px', background: C.surfaceAlt || '#f7faf8', fontSize: 12.5, fontWeight: 700, color: C.ink }}>
              บัญชี LINE ที่ผูกกับห้องนี้ ({boundAccounts.length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: C.border }}>
              {boundAccounts.map((account) => {
                const userId = String(account.line_user_id || '');
                const tail = userId ? `…${userId.slice(-8)}` : '-';
                return (
                  <div key={account.id} style={{
                    background: C.bg,
                    padding: '8px 10px',
                    display: 'grid',
                    gridTemplateColumns: '1fr auto',
                    gap: 10,
                    alignItems: 'center',
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, color: C.ink }}>
                        LINE userId <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>{tail}</code>
                      </div>
                      <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>
                        {account.oa_name ? `ผ่าน ${account.oa_name}` : 'ผ่าน OA เดิม/ไม่ระบุ'} · ผูกเมื่อ {account.bound_at ? new Date(account.bound_at).toLocaleString('th-TH') : '-'}
                      </div>
                    </div>
                    <Btn variant="danger" disabled={busy} onClick={() => onRevokeAccount && onRevokeAccount(account.id)}>
                      ลบบัญชีนี้
                    </Btn>
                  </div>
                );
              })}
            </div>
            <div style={{ padding: '8px 10px', fontSize: 11.5, color: C.muted, background: C.bg }}>
              การแก้ไขบัญชีที่ผูกให้ลบบัญชีที่ไม่ต้องการออก แล้วออกคีย์ใหม่ให้บัญชี LINE ที่ถูกต้องส่งเข้ามา ระบบจะยังส่งแจ้งเตือนให้บัญชีที่เหลืออยู่
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          {!blocked && (
            <Btn variant="primary" disabled={busy} onClick={bound ? (onIssueAdditional || onIssue) : onIssue}>
              {pending ? (bound ? 'ออกคีย์เพิ่ม LINE อีกบัญชี' : 'ออกรหัสใหม่ (ยกเลิกอันเก่า)') : bound ? 'ออกคีย์เพิ่ม LINE อีกบัญชี' : 'ออกรหัสยืนยัน'}
            </Btn>
          )}
          {pending && !bound && !blocked && (
            <Btn disabled={busy} onClick={onIssueAdditional || onIssue}>
              ออกคีย์เพิ่มอีกใบ (ไม่ยกเลิกคีย์เดิม)
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
