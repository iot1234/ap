// === admin/page-contract-invitations.jsx =================================
// Queue view of tenant self-fill invitations. Three tabs:
//   - "ต้องตรวจสอบ" (status='submitted'): tenant has filled + submitted,
//     admin reviews + approves/rejects
//   - "รอกรอก" (status='pending'): tenant hasn't submitted yet
//   - "ปิดแล้ว": approved / rejected / revoked / expired (history)
//
// On approve, server applies the draft to tenants/contracts + locks
// the contract. The token in the link is then unusable.
// ===========================================================================

const { useState, useEffect, useCallback } = React;

function PageContractInvitations({ setToast, addActivity }) {
  const C = window.ADMIN_C;
  const { Card, Btn, Modal, Pill, PageContainer, PageHeader } = window;
  const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;

  const [tab, setTab] = useState('submitted');   // submitted | pending | closed
  const [invitations, setInvitations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reviewing, setReviewing] = useState(null);  // detail modal

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (tab === 'submitted') params.set('status', 'submitted');
      else if (tab === 'pending') params.set('status', 'pending');
      // 'closed' = no filter, but we'll filter client-side below
      const d = await apiCall(`/api/admin/contract-invitations?${params}`);
      let list = d.invitations || [];
      if (tab === 'closed') {
        list = list.filter((i) => ['approved', 'rejected', 'revoked', 'expired'].includes(i.status));
      }
      setInvitations(list);
    } catch (err) {
      setToast && setToast({ kind: 'danger', message: 'โหลดล้มเหลว: ' + err.message });
    } finally {
      setLoading(false);
    }
  }, [tab]);
  useEffect(() => { refresh(); }, [refresh]);

  // Deep-link "#contract-invitations?open=<id>" (from the contracts page's
  // "รอตรวจสอบ →" pill or the tenants drawer) opens that invitation's review
  // modal directly — no second search on this page. Falls back to the
  // pending tab once if the id isn't in the default (submitted) list.
  useEffect(() => {
    if (loading) return;
    let target = '';
    try {
      const raw = String(window.location.hash || '');
      const q = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
      target = String(new URLSearchParams(q).get('open') || '').trim();
    } catch { /* malformed hash — ignore */ }
    if (!target) return;
    const row = invitations.find((i) => String(i.id) === target);
    if (row) {
      setReviewing(row);
      window.history.replaceState(null, '', '#contract-invitations');
    } else if (tab === 'submitted') {
      setTab('pending');
    } else {
      window.history.replaceState(null, '', '#contract-invitations');
    }
  }, [invitations, loading]);

  const STATUS_PILL = {
    submitted: 'warning', pending: 'info',
    approved: 'success', rejected: 'danger',
    revoked: 'gray', expired: 'gray',
  };
  const STATUS_TH = {
    submitted: 'รอตรวจสอบ', pending: 'รอผู้เช่ากรอก',
    approved: 'อนุมัติแล้ว', rejected: 'ปฏิเสธ',
    revoked: 'ถูกยกเลิก', expired: 'หมดอายุ',
  };

  const counts = {
    submitted: invitations.filter((i) => i.status === 'submitted').length,
    pending: invitations.filter((i) => i.status === 'pending').length,
  };

  return (
    <PageContainer>
      <PageHeader
        title="ใบเชิญให้ผู้เช่ากรอกสัญญา"
        subtitle="แอดมินส่งลิงก์ให้ผู้เช่ากรอกที่อยู่ ผู้ติดต่อฉุกเฉิน ถ่ายบัตร และเซ็นชื่อด้วยตัวเอง"
        actions={<Btn variant="ghost" onClick={refresh}>↻ รีเฟรช</Btn>}
      />

      <Card>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[
            { key: 'submitted', label: `ต้องตรวจสอบ${counts.submitted ? ` (${counts.submitted})` : ''}` },
            { key: 'pending',   label: 'รอกรอก' },
            { key: 'closed',    label: 'ปิดแล้ว' },
          ].map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{
                padding: '7px 16px', borderRadius: 18,
                border: '1px solid ' + (tab === t.key ? C.accent : C.border),
                background: tab === t.key ? C.accent : C.surface,
                color: tab === t.key ? '#fff' : C.ink2,
                cursor: 'pointer', fontSize: 13, fontFamily: 'inherit',
                fontWeight: tab === t.key ? 600 : 400,
              }}>{t.label}</button>
          ))}
        </div>
      </Card>

      <Card style={{ padding: 0, marginTop: 12, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 30, textAlign: 'center', color: C.muted }}>กำลังโหลด…</div>
        ) : invitations.length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: C.muted }}>
            {tab === 'submitted' && 'ยังไม่มีใบที่รอตรวจสอบ'}
            {tab === 'pending' && 'ยังไม่มีใบที่ผู้เช่ายังไม่ได้กรอก'}
            {tab === 'closed' && 'ยังไม่มีประวัติ'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: C.surfaceAlt }}>
                <tr>
                  <th style={th}>สัญญา</th>
                  <th style={th}>ผู้เช่า</th>
                  <th style={th}>สถานะ</th>
                  <th style={th}>หมดอายุ</th>
                  <th style={th}>อัปเดตล่าสุด</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((inv) => (
                  <tr key={inv.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td style={td}>
                      <div style={{ fontWeight: 500 }}>{inv.contract_no || '—'}</div>
                      <div style={{ color: C.muted, fontSize: 11 }}>ห้อง {inv.room_id || '-'}</div>
                    </td>
                    <td style={td}>
                      <div>{inv.tenant_name || '—'}</div>
                      <div style={{ color: C.muted, fontSize: 11 }}>{inv.tenant_phone || '-'}</div>
                    </td>
                    <td style={td}>
                      <Pill color={STATUS_PILL[inv.status] || 'gray'}>{STATUS_TH[inv.status] || inv.status}</Pill>
                      {inv.rejection_reason ? (
                        <div style={{ fontSize: 11, color: '#c0392b', marginTop: 2 }}>
                          ← {inv.rejection_reason.slice(0, 40)}
                        </div>
                      ) : null}
                    </td>
                    <td style={{ ...td, fontSize: 11, color: C.muted }}>
                      {inv.expires_at ? new Date(inv.expires_at).toLocaleString('th-TH', {
                        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                      }) : '-'}
                    </td>
                    <td style={{ ...td, fontSize: 11, color: C.muted }}>
                      {inv.updated_at ? new Date(inv.updated_at).toLocaleString('th-TH', {
                        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                      }) : '-'}
                      {/* Surface the last actor responsible for the
                          terminal state (approved / rejected / revoked).
                          Fall back to created_by for pending rows so an
                          admin still knows who issued the link. */}
                      {inv.approved_by ? (
                        <div style={{ color: C.success || C.accent }}>
                          ✓ อนุมัติโดย {inv.approved_by}
                        </div>
                      ) : inv.rejected_by ? (
                        <div style={{ color: '#c0392b' }}>
                          ↩ ส่งกลับโดย {inv.rejected_by}
                        </div>
                      ) : inv.revoked_by ? (
                        <div>⊘ ยกเลิกโดย {inv.revoked_by}</div>
                      ) : inv.created_by ? (
                        <div>โดย {inv.created_by}</div>
                      ) : null}
                    </td>
                    <td style={td}>
                      <Btn size="sm" variant="ghost" onClick={() => setReviewing(inv)}>
                        {inv.status === 'submitted' ? 'ตรวจสอบ →' : 'ดู'}
                      </Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {reviewing ? (
        <ReviewModal
          invitation={reviewing}
          onClose={() => setReviewing(null)}
          onAction={(action) => {
            setReviewing(null);
            setToast && setToast({ kind: 'success',
              message: action === 'approve' ? 'อนุมัติเรียบร้อย — สัญญาถูก lock'
                     : action === 'reject' ? 'ส่งกลับให้ผู้เช่าแก้ไขแล้ว'
                     : 'ยกเลิกลิงก์เรียบร้อย' });
            addActivity && addActivity({ icon: '📨',
              text: `${action === 'approve' ? 'อนุมัติ' : action === 'reject' ? 'reject' : 'revoke'} ` +
                    `invitation #${reviewing.id}`, type: 'system' });
            refresh();
          }}
          onError={(msg) => setToast && setToast({ kind: 'danger', message: msg })}
        />
      ) : null}
    </PageContainer>
  );
}

function approvalChecklistItems(detail) {
  const draft = (detail && detail.draft) || {};
  const checks = [
    { field: 'signatureFileId', group: 'ลายเซ็น', label: 'ลายเซ็นผู้เช่า', consequence: 'ถ้าอนุมัติต่อ PDF จะถูก lock โดยไม่มีลายเซ็น', fix: 'ให้ผู้เช่าเซ็นในขั้นลายเซ็นแล้วส่งใหม่' },
    { field: 'address', group: 'ข้อมูลผู้เช่า', label: 'ที่อยู่ผู้เช่า', consequence: 'ถ้าอนุมัติต่อ สัญญาจะไม่มีที่อยู่อ้างอิง', fix: 'ให้ผู้เช่ากรอกที่อยู่ตามบัตรหรือที่อยู่ติดต่อได้' },
    { field: 'emergencyContactName', group: 'ผู้ติดต่อฉุกเฉิน', label: 'ชื่อผู้ติดต่อฉุกเฉิน', consequence: 'ทีมงานจะไม่มีชื่อผู้ติดต่อเมื่อเกิดเหตุฉุกเฉิน', fix: 'ให้ผู้เช่ากรอกชื่อผู้ติดต่อฉุกเฉิน' },
    { field: 'emergencyContactPhone', group: 'ผู้ติดต่อฉุกเฉิน', label: 'เบอร์ผู้ติดต่อฉุกเฉิน', consequence: 'ทีมงานจะติดต่อฉุกเฉินไม่ได้', fix: 'ให้ผู้เช่ากรอกเบอร์ติดต่อฉุกเฉินที่โทรได้จริง' },
    { field: 'citizenId', group: 'ยืนยันตัวตน', label: 'เลขบัตรประชาชน 13 หลัก', consequence: 'สัญญาจะไม่มีเลขบัตรประชาชนสำหรับยืนยันตัวตนและตรวจซ้ำ', fix: 'ให้ผู้เช่ากรอกเลขบัตรประชาชนให้ครบ 13 หลัก' },
    { field: 'citizenIdImageFrontId', group: 'ยืนยันตัวตน', label: 'รูปบัตรประชาชนด้านหน้า', consequence: 'ตรวจตัวตนย้อนหลังไม่ครบ', fix: 'ให้อัปโหลดรูปด้านหน้าบัตรที่อ่านเลขได้ชัดเจน' },
    { field: 'citizenIdImageBackId', group: 'ยืนยันตัวตน', label: 'รูปบัตรประชาชนด้านหลัง', consequence: 'เอกสารยืนยันตัวตนไม่ครบทั้งสองด้าน', fix: 'ให้อัปโหลดรูปด้านหลังบัตรให้ครบ' },
  ];
  return checks.map((check) => {
    const value = draft[check.field];
    const missing = check.field === 'citizenId'
      ? String(value || '').replace(/[^0-9]/g, '').length !== 13
      : check.field.endsWith('Id')
      ? (!Number.isInteger(Number(value)) || Number(value) < 1)
      : !String(value || '').trim();
    return { ...check, ready: !missing };
  });
}

function approvalPrecheckWarnings(detail) {
  return approvalChecklistItems(detail)
    .filter((item) => !item.ready)
    .map(({ field, group, label, consequence, fix }) => ({ field, group, label, consequence, fix }));
}

function defaultApprovalRejectReason(warnings) {
  if (!warnings.length) return '';
  return [
    'กรุณาแก้ข้อมูลต่อไปนี้ก่อนส่งสัญญาใหม่:',
    ...warnings.map((w, idx) => `${idx + 1}. ${w.label} — ${w.fix || w.consequence}`),
  ].join('\n');
}

function formatApprovalErrorMessage(err) {
  const raw = (err && (err.raw || err.body)) || {};
  const issues = Array.isArray(raw.issueSummary)
    ? raw.issueSummary
    : (Array.isArray(raw.issues) ? raw.issues : []);
  const issueText = issues.slice(0, 5).map((it) => {
    const detail = it && it.detail && typeof it.detail === 'object' ? it.detail : {};
    const values = [];
    if (detail.monthlyRent !== undefined) values.push(`ค่าเช่า ${detail.monthlyRent}`);
    if (detail.minimumRent !== undefined) values.push(`ขั้นต่ำ ${detail.minimumRent}`);
    const valueText = values.length ? ` (${values.join(' / ')})` : '';
    const action = it.action || it.consequence || '';
    return `• ${it.label || it.field || it.code || 'ตรวจสอบข้อมูล'}${valueText}${action ? ` — ${action}` : ''}`;
  }).join('\n');
  const guidance = [
    raw.hint,
    raw.nextActions && raw.nextActions.hint,
  ].filter(Boolean).join('\n');
  return {
    title: 'อนุมัติล้มเหลว',
    description: [
      err && err.message ? err.message : 'ระบบไม่สามารถอนุมัติสัญญานี้ได้',
      issueText,
      guidance,
    ].filter(Boolean).join('\n'),
  };
}

// === Review modal — admin sees tenant's submission and approves/rejects ===
function ReviewModal({ invitation, onClose, onAction, onError }) {
  const C = window.ADMIN_C;
  const { Modal, Btn } = window;
  const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showReject, setShowReject] = useState(false);
  const approvalChecklist = detail ? approvalChecklistItems(detail) : [];
  const approvalWarnings = detail ? approvalPrecheckWarnings(detail) : [];

  useEffect(() => {
    apiCall(`/api/admin/contract-invitations/${invitation.id}`).then((d) => {
      setDetail(d.invitation);
    }).catch((err) => onError('โหลดล้มเหลว: ' + err.message));
  }, [invitation.id]);

  const approve = async () => {
    if (!detail) {
      onError('กำลังโหลดข้อมูลสัญญา กรุณารอสักครู่');
      return;
    }
    if (approvalWarnings.length) {
      onError({
        title: `ยังอนุมัติไม่ได้ — ขาด ${approvalWarnings.length} จุด`,
        description: defaultApprovalRejectReason(approvalWarnings),
      });
      return;
    }
    if (!confirm('อนุมัติ + ลงข้อมูลให้ผู้เช่า + lock สัญญา?\n\nผลที่จะเกิดขึ้น:\n- ข้อมูลผู้เช่าจะถูกบันทึกเข้าระบบ\n- ห้องจะเปลี่ยนเป็น occupied\n- สัญญาจะถูก lock และแก้เงื่อนไขสำคัญไม่ได้\n- ระบบจะสร้างบิลแรกถ้ายังไม่มี')) return;
    setBusy(true);
    try {
      const result = await apiCall(`/api/admin/contract-invitations/${invitation.id}/approve`, { method: 'POST' });
      // After approval the server returns nextActions URLs — open the
      // freshly-locked PDF in a new tab so admin can verify the result
      // without an extra click. UX shortcut: most admins want to see
      // the contract immediately after approving.
      if (result && result.nextActions && result.nextActions.pdfUrl) {
        window.open(result.nextActions.pdfUrl, '_blank', 'noopener');
      }
      onAction('approve');
    } catch (err) {
      // Server may return ROOM_OCCUPIED 409 — surface clearly so admin
      // knows to checkout the previous tenant first.
      onError(formatApprovalErrorMessage(err));
    } finally { setBusy(false); }
  };

  const reject = async () => {
    if (!rejectReason.trim()) { onError('ระบุเหตุผลในการ reject'); return; }
    setBusy(true);
    try {
      await apiCall(`/api/admin/contract-invitations/${invitation.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: rejectReason.trim() }),
      });
      onAction('reject');
    } catch (err) {
      onError('reject ล้มเหลว: ' + err.message);
    } finally { setBusy(false); }
  };

  const revoke = async () => {
    if (!confirm('ยกเลิกลิงก์? ผู้เช่าจะใช้งานต่อไม่ได้')) return;
    setBusy(true);
    try {
      await apiCall(`/api/admin/contract-invitations/${invitation.id}/revoke`, { method: 'POST' });
      onAction('revoke');
    } catch (err) {
      onError('revoke ล้มเหลว: ' + err.message);
    } finally { setBusy(false); }
  };

  const openRejectForm = () => {
    if (!rejectReason.trim() && approvalWarnings.length) {
      setRejectReason(defaultApprovalRejectReason(approvalWarnings));
    }
    setShowReject(true);
  };

  return (
    <Modal
      open={true}
      onClose={onClose}
      width={720}
      title={`ตรวจสอบใบกรอก — ${invitation.contract_no || `#${invitation.id}`}`}
      footer={
        invitation.status === 'submitted' ? (
          showReject ? (
            <>
              <Btn variant="ghost" onClick={() => setShowReject(false)} disabled={busy}>← ย้อน</Btn>
              <Btn variant="danger" onClick={reject} disabled={busy || !rejectReason.trim()}>
                ส่งกลับให้ผู้เช่าแก้
              </Btn>
            </>
          ) : (
            <>
              <Btn variant="ghost" onClick={onClose} disabled={busy}>ปิด</Btn>
              <Btn variant="ghost" onClick={openRejectForm} disabled={busy || !detail}>ขอให้แก้</Btn>
              <Btn variant="primary" onClick={approve} disabled={busy || !detail || approvalWarnings.length > 0}>
                {busy ? '…' : '✓ อนุมัติ + lock'}
              </Btn>
            </>
          )
        ) : invitation.status === 'pending' ? (
          <>
            <Btn variant="ghost" onClick={onClose}>ปิด</Btn>
            <Btn variant="danger" onClick={revoke} disabled={busy}>ยกเลิกลิงก์</Btn>
          </>
        ) : (
          <Btn variant="ghost" onClick={onClose}>ปิด</Btn>
        )
      }
    >
      {!detail ? (
        <div style={{ padding: 20, textAlign: 'center', color: C.muted }}>กำลังโหลด...</div>
      ) : showReject ? (
        <div>
          <h3 style={{ margin: '0 0 8px' }}>ขอให้ผู้เช่าแก้ไข</h3>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>
            เหตุผลจะแสดงให้ผู้เช่าเห็น เพื่อแก้ตรงจุดและส่งใหม่
          </div>
          <textarea rows={5} maxLength={500} style={inp}
            placeholder="เช่น รูปบัตรไม่ชัด — ถ่ายในที่สว่างกว่านี้"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)} />
        </div>
      ) : (
        <ReviewBody detail={detail} approvalWarnings={approvalWarnings} approvalChecklist={approvalChecklist} />
      )}
    </Modal>
  );
}

function ReviewBody({ detail, approvalWarnings = [], approvalChecklist = [] }) {
  const C = window.ADMIN_C;
  const draft = detail.draft || {};
  const readyCount = approvalChecklist.filter((item) => item.ready).length;
  const Section = ({ title, children }) => (
    <div style={{ marginBottom: 16, padding: 12, background: C.surfaceAlt, borderRadius: 8 }}>
      <div style={{ fontWeight: 600, marginBottom: 8, color: C.accent, fontSize: 13 }}>{title}</div>
      {children}
    </div>
  );
  const KV = ({ k, v }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0',
                  fontSize: 13, borderBottom: `1px solid #f0e9d8` }}>
      <span style={{ color: C.muted }}>{k}</span>
      <span style={{ fontWeight: 500, textAlign: 'right' }}>{v || '—'}</span>
    </div>
  );
  return (
    <div>
      {approvalWarnings.length ? (
        <div style={{
          padding: 12, marginBottom: 16, background: C.warningSoft,
          border: '1px solid #f1b32d', borderRadius: 8,
          color: C.warningInk || C.ink2, fontSize: 13, lineHeight: 1.55,
        }}>
          <b>ยัง approve ไม่ได้</b> — ข้อมูลครบ {readyCount}/{approvalChecklist.length} จุด ถ้าฝืนอนุมัติ สัญญาจะถูก lock โดยข้อมูลสำคัญไม่ครบ:
          <ul style={{ margin: '8px 0 0 18px', padding: 0 }}>
            {approvalWarnings.map((w) => (
              <li key={w.field}><b>{w.group}: {w.label}</b>: {w.consequence}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div style={{
          padding: 12, marginBottom: 16, background: C.successSoft || C.surfaceAlt,
          border: `1px solid ${C.success || C.border}`, borderRadius: 8,
          color: C.successInk || C.ink2, fontSize: 13, lineHeight: 1.55,
        }}>
          เมื่อกดอนุมัติ ระบบจะบันทึกข้อมูลผู้เช่า, เปลี่ยนห้องเป็น occupied, lock สัญญา และเปิด PDF ให้ตรวจทันที
        </div>
      )}
      {approvalChecklist.length ? (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
          gap: 8,
          marginBottom: 16,
        }}>
          {approvalChecklist.map((item) => (
            <div key={item.field} style={{
              padding: 10,
              borderRadius: 8,
              border: `1px solid ${item.ready ? (C.success || '#15803d') : '#f1b32d'}33`,
              background: item.ready ? (C.successSoft || '#dcfce7') : (C.warningSoft || '#fff7ed'),
              color: C.ink2,
              fontSize: 12,
              lineHeight: 1.45,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                <b style={{ color: C.ink }}>{item.label}</b>
                <span style={{ color: item.ready ? (C.success || '#15803d') : (C.warningInk || '#92400e'), fontWeight: 700 }}>
                  {item.ready ? 'ครบแล้ว' : 'ยังไม่ครบ'}
                </span>
              </div>
              <div style={{ color: C.muted }}>{item.group}</div>
              {!item.ready ? <div style={{ marginTop: 3 }}>ต้องทำ: {item.fix}</div> : null}
            </div>
          ))}
        </div>
      ) : null}
      <Section title="ข้อมูลสัญญา">
        <KV k="เลขที่สัญญา" v={detail.contract_no} />
        <KV k="ห้อง" v={detail.room_id} />
        <KV k="ค่าเช่า/เดือน" v={detail.monthly_rent ? `฿${Number(detail.monthly_rent).toLocaleString('th-TH', { minimumFractionDigits: 2 })}` : '—'} />
        <KV k="มัดจำ" v={detail.deposit ? `฿${Number(detail.deposit).toLocaleString('th-TH', { minimumFractionDigits: 2 })}` : '—'} />
      </Section>

      <Section title="ผู้เช่ากรอก: ที่อยู่">
        <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
          {draft.address || <span style={{ color: '#c0392b' }}>ยังไม่กรอก</span>}
        </div>
      </Section>

      <Section title="ผู้เช่ากรอก: ผู้ติดต่อฉุกเฉิน">
        <KV k="ชื่อ" v={draft.emergencyContactName} />
        <KV k="เบอร์" v={draft.emergencyContactPhone} />
        {draft.emergencyContactRelation ? (
          <KV k="ความสัมพันธ์" v={draft.emergencyContactRelation} />
        ) : null}
      </Section>

      <Section title="ผู้เช่ากรอก: เลขบัตร + รูป">
        <KV k="เลขบัตรประชาชน"
            v={(() => {
              const raw = draft.citizenId ? String(draft.citizenId).replace(/\D/g, '') : '';
              if (!raw) return '—';
              if (raw.length !== 13) return raw;
              // Standard Thai layout X-XXXX-XXXXX-XX-X. Showing the full
              // number is required so admin can cross-check against the
              // photo before locking the contract.
              return `${raw[0]}-${raw.slice(1, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 12)}-${raw[12]}`;
            })()} />
        <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
          ตรวจเลขให้ตรงกับรูปบัตรด้านล่างก่อนอนุมัติ
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
          <PhotoBox label="หน้าบัตร" url={detail.draft_front_url} />
          <PhotoBox label="หลังบัตร" url={detail.draft_back_url} />
        </div>
      </Section>

      <Section title="ผู้เช่ากรอก: ลายเซ็น">
        {detail.draft_signature_url ? (
          <img src={detail.draft_signature_url} alt="signature"
            style={{ maxWidth: '100%', maxHeight: 200, background: '#fff',
                     border: `1px solid ${C.border}`, borderRadius: 6 }} />
        ) : (
          <div style={{ color: '#c0392b' }}>ยังไม่ได้เซ็น</div>
        )}
      </Section>

      {/* Audit trail — surface every admin action on this invitation so a
          contract that ends up "locked" or "rejected" has a visible owner.
          Server returns approved_by/approved_at, rejected_by/rejected_at
          plus created_by/created_at on every contract_invitations row,
          but the previous modal only displayed submitted_at from the
          tenant side. */}
      {(detail.created_by || detail.submitted_at || detail.approved_by
        || detail.rejected_by || detail.revoked_by) ? (
        <Section title="ประวัติการดำเนินการ">
          {detail.created_by ? (
            <KV k="แอดมินที่สร้างลิงก์" v={<span style={{ fontWeight: 600 }}>👤 {detail.created_by}</span>} />
          ) : null}
          {detail.created_at ? (
            <KV k="สร้างเมื่อ" v={new Date(detail.created_at).toLocaleString('th-TH')} />
          ) : null}
          {detail.submitted_at ? (
            <KV k="ผู้เช่าส่งเมื่อ" v={new Date(detail.submitted_at).toLocaleString('th-TH')} />
          ) : null}
          {detail.approved_by ? (
            <KV k="อนุมัติโดย" v={<span style={{ fontWeight: 600, color: C.success || C.accent }}>👤 {detail.approved_by}</span>} />
          ) : null}
          {detail.approved_at ? (
            <KV k="อนุมัติเมื่อ" v={new Date(detail.approved_at).toLocaleString('th-TH')} />
          ) : null}
          {detail.rejected_by ? (
            <KV k="ส่งกลับให้แก้โดย" v={<span style={{ fontWeight: 600, color: '#c0392b' }}>👤 {detail.rejected_by}</span>} />
          ) : null}
          {detail.rejected_at ? (
            <KV k="ส่งกลับเมื่อ" v={new Date(detail.rejected_at).toLocaleString('th-TH')} />
          ) : null}
          {detail.rejection_reason ? (
            <KV k="เหตุผลที่ส่งกลับ" v={detail.rejection_reason} />
          ) : null}
          {detail.revoked_by ? (
            <KV k="ยกเลิกลิงก์โดย" v={<span style={{ fontWeight: 600, color: C.muted }}>👤 {detail.revoked_by}</span>} />
          ) : null}
          {detail.revoked_at ? (
            <KV k="ยกเลิกเมื่อ" v={new Date(detail.revoked_at).toLocaleString('th-TH')} />
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}

function PhotoBox({ label, url }) {
  const C = window.ADMIN_C;
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>{label}</div>
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer">
          <img src={url} alt={label} style={{
            maxWidth: '100%', maxHeight: 180, borderRadius: 6,
            border: `1px solid ${C.border}`, cursor: 'zoom-in',
          }} />
        </a>
      ) : (
        <div style={{ padding: 24, background: '#fff', border: `1px dashed ${C.border}`,
                      borderRadius: 6, color: '#c0392b', fontSize: 12 }}>
          ยังไม่อัปโหลด
        </div>
      )}
    </div>
  );
}

const th = {
  textAlign: 'left', padding: '10px 14px', fontWeight: 600, fontSize: 12,
  color: C.ink2, borderBottom: '1px solid #ece4d4',
};
const td = { padding: '10px 14px', verticalAlign: 'top' };
const lbl = { display: 'block', fontSize: 12, color: C.ink2, marginBottom: 4, fontWeight: 500 };
const inp = {
  width: '100%', padding: '8px 10px', border: '1px solid #ece4d4',
  borderRadius: 6, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box',
};

window.PageContractInvitations = PageContractInvitations;
