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
  line:       { title: 'LINE Messaging API',     icon: '💬', desc: 'Token + Owner ID สำหรับส่งแจ้งเตือนและรับ webhook' },
  smtp:       { title: 'อีเมล (SMTP)',           icon: '📧', desc: 'Host/User/Password สำหรับส่งอีเมลแจ้งเตือน (fallback ของ LINE)' },
  promptpay:  { title: 'PromptPay',              icon: '💸', desc: 'เบอร์โทร/บัตร ปชช. สำหรับสร้าง QR ในบิล' },
  slipverify: { title: 'ตรวจสลิปอัตโนมัติ',     icon: '🧾', desc: 'API key ของ SlipOK / EasySlip / Slip2Go — เปิด autoVerify ที่หน้า Features หลังตั้ง key เสร็จ' },
  sentry:     { title: 'Error Tracking (Sentry)', icon: '🐛', desc: 'DSN สำหรับเก็บ exception report' },
  r2:         { title: 'Cloud Backup (R2/S3)',   icon: '☁️', desc: 'S3-compatible storage สำหรับ backup อัตโนมัติ' },
};

// `embedded` prop lets PageSettings render this component INSIDE one of
// its tabs without duplicating the outer PageContainer + PageHeader.
// When embedded=true the wrapper / header are skipped; the page still
// works standalone at /admin#secrets for legacy URLs.
function PageSecrets({ setToast, embedded = false }) {
  const C = window.ADMIN_C;
  const { Card, SectionHeading, Btn, Pill, PageContainer, PageHeader, Modal } = window;
  const apiFetch = window.requireApiFetch ? window.requireApiFetch() : window.apiFetch;
  const [groups, setGroups] = useState({});
  const [editing, setEditing] = useState({});
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState({});
  // Owner-claim modal state: token = { id, code, expiresAt } once issued;
  // claimStatus polls /api/admin/line/owner-claim/:id and switches the
  // modal between pending/claimed/expired views.
  const [ownerClaim, setOwnerClaim] = useState(null);
  const [claimStatus, setClaimStatus] = useState(null);

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
        // Each group surfaces a different "info" shape — render whichever
        // is present so the toast confirms what was actually verified, not
        // just "ok". Helps admin spot "I tested LINE but the OA shown is
        // not the one I intended" type mistakes.
        let detail = '';
        if (d.info) {
          if (d.info.displayName) detail = ` — OA: ${d.info.displayName}`;
          else if (d.info.basicId) detail = ` — ${d.info.basicId}`;
          else if (d.info.format && d.info.masked) detail = ` — ${d.info.format} ${d.info.masked}`;
          // slipverify returns { provider, branchId, ready } — show which
          // provider's key was found so admin knows ตรงไหนถูกใช้
          else if (d.info.provider) {
            const br = d.info.branchId ? ` · branch: ${d.info.branchId}` : '';
            detail = ` — ${d.info.provider}${br}`;
          }
          else if (d.bucket) detail = ` — bucket: ${d.bucket}`;
        } else if (d.bucket) {
          detail = ` — bucket: ${d.bucket}`;
        }
        setToast && setToast({
          kind: 'success',
          message: { title: `✅ ทดสอบ ${group} สำเร็จ`, description: detail || null },
        });
      } else {
        setToast && setToast({
          kind: 'danger',
          message: {
            title: `❌ ${group} ใช้ไม่ได้`,
            description: d.error || 'unknown error',
          },
        });
      }
    } catch (e) {
      window.toastError
        ? window.toastError(setToast, e, { action: `ทดสอบ ${group}` })
        : setToast && setToast({ kind: 'danger', message: e.message });
    } finally {
      setTesting((t) => ({ ...t, [group]: false }));
    }
  }

  // Order from "most-used" → "infrequent". slipverify sits next to promptpay
  // because admins typically configure them together (PromptPay target for
  // bills + provider key for slip auto-verify).
  const groupOrder = ['line', 'smtp', 'promptpay', 'slipverify', 'sentry', 'r2'];

  // Auto-detect Owner User ID. Generates a one-time OWNER-XXXXXXXX code,
  // admin sends it from their personal LINE to the OA, webhook saves the
  // userId — admin doesn't have to manually paste it.
  async function startOwnerClaim() {
    try {
      const r = await apiFetch('/api/admin/line/owner-claim', {
        method: 'POST', body: JSON.stringify({}),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'create failed');
      setOwnerClaim(d);
      setClaimStatus({ status: 'pending' });
    } catch (e) {
      setToast && setToast({ kind: 'error', message: e.message });
    }
  }
  // Poll the claim status while the modal is open. Stops when claimed,
  // expired, or revoked. 2-second interval is fast enough for UX without
  // hammering the DB.
  useEffect(() => {
    if (!ownerClaim) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/admin/line/owner-claim/${ownerClaim.id}`,
          { credentials: 'same-origin' });
        const d = await r.json();
        if (cancelled) return;
        if (r.ok) {
          setClaimStatus(d);
          if (d.status === 'claimed') {
            setToast && setToast({
              kind: 'success',
              message: { title: '✅ ตั้ง Owner สำเร็จ', description: `userId ${d.claimedTail}` },
            });
            load();   // refresh secrets so LINE_OWNER_USER_ID shows as set
          }
        }
      } catch { /* swallow — next poll will retry */ }
    };
    tick();
    const interval = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [ownerClaim?.id]);

  const content = (
    <>
      {!embedded ? (
        <PageHeader title="ตั้งค่า API & Secrets"
          subtitle="ทุกค่าเข้ารหัสด้วย AES-256-GCM ใน DB · env วาง override ได้ตามต้องการ" />
      ) : null}

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
                <div style={{ fontFamily: 'IBM Plex Sans Thai', fontSize: 16, fontWeight: 600 }}>
                  {meta.icon} {meta.title}
                </div>
                <div style={{ color: C.muted, fontSize: 13, marginTop: 2 }}>{meta.desc}</div>
              </div>
              {/* Test button shown for any group the server supports. r2
                  and promptpay are now supported (server: services/secrets.testGroup);
                  the test endpoint's allowlist gates which group strings are
                  accepted. Sentry omitted: there's no read-side probe — sending
                  a fake event would litter the project's Issues stream. */}
              <div style={{ display: 'flex', gap: 8 }}>
                {/* Auto-detect button — only on the LINE group since it
                    relies on the OA webhook being live. Clicking it
                    generates a OWNER-code and opens the claim modal. */}
                {group === 'line' && (
                  <Btn size="sm" variant="ghost" onClick={startOwnerClaim}>
                    🔗 Auto-detect Owner ID
                  </Btn>
                )}
                {(group === 'line' || group === 'smtp' || group === 'r2'
                  || group === 'promptpay' || group === 'slipverify') && (
                  <Btn size="sm" onClick={() => testGroup(group)} disabled={!!testing[group]}>
                    {testing[group] ? 'กำลังทดสอบ…' : '🔌 ทดสอบ'}
                  </Btn>
                )}
              </div>
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

      {/* Owner-claim modal — renders the OWNER-XXXXXXXX code with copy
          + a live status pill that flips green when the webhook records
          a userId. Auto-closes 1.5s after success so admin sees the ✓. */}
      <Modal
        open={!!ownerClaim}
        onClose={() => { setOwnerClaim(null); setClaimStatus(null); }}
        title="🔗 ผูก LINE Owner User ID อัตโนมัติ"
        width={480}
        footer={(
          <Btn variant="ghost"
            onClick={() => { setOwnerClaim(null); setClaimStatus(null); }}>
            {claimStatus?.status === 'claimed' ? 'เสร็จสิ้น' : 'ปิด'}
          </Btn>
        )}
      >
        {ownerClaim && (
          <OwnerClaimBody token={ownerClaim} status={claimStatus} C={C} />
        )}
      </Modal>
    </>
  );
  return embedded ? <div>{content}</div> : <PageContainer>{content}</PageContainer>;
}

// OwnerClaimBody — renders the 3-step claim flow + live status indicator.
// Pure presentational; the parent owns the token + poll state.
function OwnerClaimBody({ token, status, C }) {
  const st = status?.status || 'pending';
  const palette = {
    pending:  { bg: '#fff7e0', border: '#f0e3a7', icon: '⏳', label: 'รอผู้ใช้ส่งรหัส', color: '#8a6b1a' },
    claimed:  { bg: '#f0f9f0', border: '#bce0bc', icon: '✅', label: 'สำเร็จ', color: '#1f5f3a' },
    expired:  { bg: '#fff5f4', border: '#f5c0b4', icon: '⌛', label: 'หมดอายุ', color: '#b94a48' },
    revoked:  { bg: '#fff5f4', border: '#f5c0b4', icon: '❌', label: 'ถูกยกเลิก', color: '#b94a48' },
  };
  const p = palette[st] || palette.pending;
  const expiresIn = token?.expiresAt
    ? Math.max(0, Math.floor((new Date(token.expiresAt).getTime() - Date.now()) / 1000))
    : 0;

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(token.code);
      window.toast && window.toast({ kind: 'success', message: 'คัดลอกรหัสแล้ว' });
    } catch { /* user copies manually */ }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
        ขั้นตอน:
        <ol style={{ margin: '6px 0 0 0', paddingLeft: 20, color: C.ink }}>
          <li>เปิดแชต LINE คุยกับ LINE OA ของหอพัก (จากบัญชีตัวเอง)</li>
          <li>ส่งรหัสด้านล่างไปที่ OA</li>
          <li>รอ ~1-2 วินาที — ระบบจะตั้ง userId อัตโนมัติ</li>
        </ol>
      </div>

      <div style={{
        padding: 16, borderRadius: 10, textAlign: 'center',
        background: '#fdfaf2', border: `1px solid ${C.borderSoft || C.border}`,
      }}>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>รหัสที่ต้องส่ง</div>
        <div style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 22, fontWeight: 700, letterSpacing: 1, color: C.ink,
        }}>{token.code}</div>
        <Btn size="sm" variant="ghost" onClick={copyCode} style={{ marginTop: 8 }}>
          📋 คัดลอก
        </Btn>
      </div>

      <div style={{
        padding: 12, borderRadius: 8,
        background: p.bg, border: `1px solid ${p.border}`,
      }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: p.color }}>
          {p.icon} {p.label}
        </div>
        {st === 'pending' ? (
          <div style={{ fontSize: 12.5, color: C.muted, marginTop: 4 }}>
            หมดอายุใน {Math.floor(expiresIn / 60)}:{String(expiresIn % 60).padStart(2, '0')} นาที
            — รอผู้ใช้ส่งรหัสมาที่ LINE OA
          </div>
        ) : null}
        {st === 'claimed' && status?.claimedTail ? (
          <div style={{ fontSize: 12.5, color: p.color, marginTop: 4 }}>
            LINE userId: {status.claimedTail}
            <br/>ระบบจะส่ง alert ทั้งหมดไปที่ user นี้ตั้งแต่นี้เป็นต้นไป
          </div>
        ) : null}
        {st === 'expired' ? (
          <div style={{ fontSize: 12.5, color: C.muted, marginTop: 4 }}>
            ปิดหน้านี้แล้วกด "🔗 Auto-detect Owner ID" ใหม่
          </div>
        ) : null}
      </div>
    </div>
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
              <button onClick={() => {
                // Tell the admin EXACTLY what stops working when this key
                // is cleared. Generic "ลบค่านี้?" let people drop critical
                // tokens (LINE_CHANNEL_ACCESS_TOKEN, SMTP_PASS) without
                // realising notifications would silently die afterward.
                const IMPACT = {
                  LINE_CHANNEL_ACCESS_TOKEN: 'แจ้งเตือนผ่าน LINE ทั้งหมดจะหยุดทำงาน (รวมถึง bill push, slip alert, maintenance notify)',
                  LINE_CHANNEL_SECRET: 'webhook /webhook/line จะปฏิเสธทุก request เพราะ verify signature ไม่ผ่าน — tenant ส่งรหัส BIND-XXXX ไม่ได้',
                  LINE_OWNER_USER_ID: 'system notifications (ผู้เช่าใหม่จอง / สลิปใหม่ / ticket ใหม่) จะไม่ถึง LINE ของ owner',
                  SMTP_HOST: 'อีเมล fallback ของ LINE จะใช้ไม่ได้',
                  SMTP_USER: 'อีเมล fallback ของ LINE จะใช้ไม่ได้',
                  SMTP_PASS: 'อีเมล fallback ของ LINE จะใช้ไม่ได้ (auth fail)',
                  SMTP_FROM: 'อีเมลจะส่งจากที่อยู่ default แทน — ผู้รับอาจมองว่าเป็น spam',
                  OWNER_EMAIL: 'อีเมลแจ้งเตือน owner จะใช้ไม่ได้',
                  PROMPTPAY_TARGET: 'บิล PDF จะไม่มี QR — ผู้เช่า scan-to-pay ไม่ได้',
                  SENTRY_DSN: 'error report จะไม่ถูกส่งไป Sentry (มองไม่เห็น exception ใน production)',
                  R2_ACCESS_KEY_ID: 'autoBackup จะ fall-back ไปบนดิสก์ container — backup จะหายเมื่อ redeploy',
                  R2_SECRET_ACCESS_KEY: 'autoBackup + photo upload upload R2 ไม่ได้',
                  R2_ENDPOINT: 'autoBackup + photo upload เชื่อม R2 ไม่ได้',
                  R2_BUCKET: 'autoBackup + photo upload หาที่จัดเก็บไม่เจอ',
                  R2_REGION: 'อาจส่งผลกับ AWS region routing (ไม่ใช่ R2 เพราะ R2 ใช้ "auto")',
                };
                const impact = IMPACT[spec.key] || 'ฟีเจอร์ที่อ้างถึง key นี้จะหยุดทำงาน';
                const ok = window.confirm(
                  `ลบค่า ${spec.key}?\n\n` +
                  `📌 ผลกระทบ:\n${impact}\n\n` +
                  `ค่าจะหายจาก DB ทันที — ตั้งใหม่ได้ตลอด แต่ระหว่างนี้ฟีเจอร์ที่เกี่ยวข้องจะใช้ไม่ได้\n\n` +
                  `ดำเนินการต่อ?`
                );
                if (ok) onClear();
              }} disabled={busy} style={{
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
