// === admin/page-slip-verify.jsx ===========================================
// Dedicated end-to-end setup for slip auto-verification (SlipOK / EasySlip).
//
// What this page does — in one place:
//   1. Toggle the slipUpload feature on/off                  (calls /api/admin/features)
//   2. Toggle autoVerify on/off + pick provider              (same endpoint)
//   3. Enter API key + (optional) branch id                  (calls /api/admin/secrets/:key)
//   4. Test the configured provider end-to-end                (POST /api/admin/secrets/test)
//   5. Show live readiness: what works, what's missing, why  (GET /api/admin/billing-readiness)
//
// Why a dedicated page exists (instead of just /admin#features + /admin#secrets):
// operators kept missing the key-setup step because the feature toggle was on
// one page and the secret input was on another. Tenants would then upload
// slips that silently fell into the admin queue ("autoVerify is on, why isn't
// anything verifying?"). Consolidating the flow here makes the prerequisites
// obvious — each step is gated on the previous one, with inline status pills.
// ===========================================================================

const { useState, useEffect, useCallback, useMemo } = React;

function PageSlipVerify({ setToast }) {
  const C = window.ADMIN_C;
  const { Card, SectionHeading, Btn, Pill, PageContainer, PageHeader } = window;
  // apiFetch attaches CSRF + handles 401 redirect. Without it PUT/POST 403.
  const apiFetch = window.apiFetch || ((u, o) => fetch(u, { credentials: 'same-origin', ...o }));

  const [features, setFeatures] = useState(null);
  const [secrets, setSecrets] = useState({});           // { SLIPOK_API_KEY: {...}, ... }
  const [readiness, setReadiness] = useState(null);
  const [drafts, setDrafts] = useState({});             // per-key pending edit
  const [editing, setEditing] = useState({});           // per-key edit-mode toggle
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [err, setErr] = useState('');

  // Centralised reload — called after every mutation so the UI stays in sync
  // without manual cache invalidation. All three endpoints are cheap reads.
  const reload = useCallback(async () => {
    try {
      const [fRes, sRes, rRes] = await Promise.all([
        fetch('/api/admin/features', { credentials: 'same-origin' }),
        fetch('/api/admin/secrets', { credentials: 'same-origin' }),
        fetch('/api/admin/billing-readiness', { credentials: 'same-origin' }),
      ]);
      const [fJson, sJson, rJson] = await Promise.all([fRes.json(), sRes.json(), rRes.json()]);
      if (!fRes.ok) throw new Error(fJson.error || 'load features failed');
      if (!sRes.ok) throw new Error(sJson.error || 'load secrets failed');
      setFeatures(fJson.features);
      // Flatten secrets into a key→spec map filtered to the slipverify group
      // so the rest of the component reads by key instead of array index.
      const out = {};
      (sJson.items || []).forEach((it) => {
        if (it.group === 'slipverify') out[it.key] = it;
      });
      setSecrets(out);
      if (rRes.ok) setReadiness(rJson);
    } catch (e) {
      setErr(e.message);
      setToast && setToast({ kind: 'error', message: e.message });
    }
  }, [setToast]);

  useEffect(() => { reload(); }, [reload]);

  async function saveFeature(partial) {
    setBusy(true); setErr('');
    try {
      const r = await apiFetch('/api/admin/features', {
        method: 'PUT',
        body: JSON.stringify({ features: partial }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'save failed');
      setFeatures(d.features);
      // Invalidate the cached test result whenever a feature change could
      // affect what the test would prove. Switching SlipOK ↔ EasySlip,
      // toggling autoVerify, or disabling slipUpload all make the
      // previously-green "✓ ผ่าน" misleading — admin would see it next
      // to a config that hasn't actually been tested.
      if (partial && partial.slipUpload && (
        'provider' in partial.slipUpload
        || 'providers' in partial.slipUpload
        || 'autoVerify' in partial.slipUpload
        || 'enabled' in partial.slipUpload
      )) {
        setTestResult(null);
      }
      setToast && setToast({ kind: 'success', message: 'บันทึกการตั้งค่าฟีเจอร์แล้ว' });
      reload();
    } catch (e) {
      setErr(e.message);
      setToast && setToast({ kind: 'error', message: e.message });
    } finally { setBusy(false); }
  }

  async function saveSecret(key, value) {
    setBusy(true); setErr('');
    try {
      const r = await apiFetch(`/api/admin/secrets/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'save failed');
      setToast && setToast({
        kind: 'success',
        message: value ? `บันทึก ${key} แล้ว` : `ลบ ${key} แล้ว`,
      });
      setEditing((e) => ({ ...e, [key]: false }));
      setDrafts((d) => ({ ...d, [key]: '' }));
      // Changing the API key invalidates the previous test result — the
      // old "✓ ผ่าน" was for a different key. Force admin to re-test.
      setTestResult(null);
      reload();
    } catch (e) {
      setErr(e.message);
      setToast && setToast({ kind: 'error', message: e.message });
    } finally { setBusy(false); }
  }

  async function runTest() {
    setTesting(true); setTestResult(null);
    try {
      const r = await apiFetch('/api/admin/secrets/test', {
        method: 'POST',
        body: JSON.stringify({ group: 'slipverify' }),
      });
      const d = await r.json();
      setTestResult(d);
      if (d.ok) {
        setToast && setToast({
          kind: 'success',
          message: { title: '✅ ทดสอบสำเร็จ', description: d.info ? JSON.stringify(d.info) : null },
        });
      } else {
        setToast && setToast({
          kind: 'danger',
          message: { title: '❌ ทดสอบไม่ผ่าน', description: d.error || 'unknown error' },
        });
      }
    } catch (e) {
      setToast && setToast({ kind: 'error', message: e.message });
    } finally { setTesting(false); }
  }

  // Derive the picture: which step is the operator currently blocked on?
  // Each step has a "done" boolean — the UI uses these to render check marks,
  // active-step highlighting, and the inline error banner pointing to the
  // first incomplete step.
  const status = useMemo(() => {
    if (!features) return null;
    const slip = features.slipUpload || {};
    const provider = slip.provider || 'slipok';
    const keyName = provider === 'easyslip' ? 'EASYSLIP_API_KEY' : 'SLIPOK_API_KEY';
    const keyEntry = secrets[keyName];
    const keySet = !!(keyEntry && keyEntry.isSet);
    const branchEntry = secrets.SLIPOK_BRANCH_ID;
    return {
      provider,
      keyName,
      keySet,
      keyEntry,
      branchSet: !!(branchEntry && branchEntry.isSet),
      branchEntry,
      step1Done: slip.enabled === true,
      step2Done: slip.autoVerify === true,
      step3Done: !!provider,
      step4Done: keySet,
      step5Done: testResult && testResult.ok === true,
      tenantPortalOff: features.tenantPortal && features.tenantPortal.enabled === false,
      // PromptPay target is needed for receiver-account verification — the
      // single most common silent-fail cause after key setup ("ทำไมยังตก
      // queue admin ทั้งที่ key ใส่แล้ว"). Surface here even though it's a
      // separate secret group.
      promptpayConfigured: readiness && readiness.issues
        ? !readiness.issues.some((i) =>
            i.code === 'NO_PROMPTPAY' || i.code === 'DEMO_PROMPTPAY' || i.code === 'PROMPTPAY_INVALID_SHAPE')
        : null,
    };
  }, [features, secrets, testResult, readiness]);

  // Subset of billing-readiness issues that are RELEVANT to slip verification.
  // Filtering by code keeps the panel focused — admin shouldn't see
  // "NO_WATER_RATE" warnings on this page.
  const slipIssues = useMemo(() => {
    if (!readiness || !readiness.issues) return [];
    const RELEVANT = new Set([
      'NO_PROMPTPAY', 'DEMO_PROMPTPAY', 'PROMPTPAY_INVALID_SHAPE',
      'SLIP_NEEDS_PORTAL', 'AUTO_APPROVE_UNVERIFIED',
      'AUTOVERIFY_NO_PROVIDER', 'PROVIDER_NAME_UNKNOWN', 'AUTOVERIFY_MISSING_KEY',
      'NO_VERIFICATION_PATH', 'SLIP_UPLOAD_DISABLED', 'BIG_VERIFY_QUEUE',
    ]);
    return readiness.issues.filter((i) => RELEVANT.has(i.code));
  }, [readiness]);

  if (!features || !status) {
    return React.createElement(PageContainer, null,
      React.createElement(PageHeader, {
        title: 'ตรวจสลิปอัตโนมัติ',
        subtitle: 'ตั้งค่าระบบยืนยันสลิปด้วย API (SlipOK / EasySlip)',
      }),
      React.createElement(Card, null,
        React.createElement('div', { style: { color: C.muted, textAlign: 'center', padding: 20 } },
          err ? `❌ ${err}` : 'กำลังโหลด…')
      )
    );
  }

  const sevColor = (sev) =>
    sev === 'high' ? '#b94a48' : sev === 'med' ? '#c08a2a' : C.muted;
  const sevIcon = (sev) =>
    sev === 'high' ? '🔴' : sev === 'med' ? '🟡' : sev === 'low' ? '⚪' : 'ℹ️';

  function StepHeader({ n, done, title, hint, children }) {
    return React.createElement('div', {
      style: {
        padding: '14px 16px',
        background: done ? '#f0f9f0' : C.bg,
        borderRadius: 8, marginBottom: 10,
        border: `1px solid ${done ? '#bce0bc' : C.border}`,
      },
    },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
        React.createElement('span', {
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, borderRadius: '50%',
            background: done ? '#2f8f5b' : C.muted, color: '#fff',
            fontWeight: 700, fontSize: 13, flexShrink: 0,
          },
        }, done ? '✓' : n),
        React.createElement('div', { style: { flex: 1 } },
          React.createElement('div', { style: { fontFamily: 'Sora', fontWeight: 600, fontSize: 14.5 } }, title),
          hint ? React.createElement('div', { style: { color: C.muted, fontSize: 12.5, marginTop: 2 } }, hint) : null,
        ),
      ),
      children ? React.createElement('div', { style: { marginTop: 12, marginLeft: 38 } }, children) : null
    );
  }

  // ── Render ────────────────────────────────────────────────────────────
  return React.createElement(PageContainer, null,
    React.createElement(PageHeader, {
      title: 'ตรวจสลิปอัตโนมัติ',
      subtitle: 'ตั้งค่า SlipOK / EasySlip ทีเดียวจบ — สลิปที่ผู้เช่าส่งจะถูกยืนยันและบิลถูก mark paid อัตโนมัติภายใน 3-5 วินาที',
    }),

    // Intro / explainer card
    React.createElement(Card, {
      style: { background: '#fdfaf2', borderLeft: `4px solid ${C.accent || '#c46a3e'}` },
    },
      React.createElement('div', { style: { fontSize: 13.5, lineHeight: 1.7, color: C.ink2 || C.ink } },
        React.createElement('div', { style: { fontWeight: 600, marginBottom: 6, fontFamily: 'Sora' } },
          '🧾 หลักการทำงาน'),
        React.createElement('div', null,
          '1) ผู้เช่าอัปโหลดสลิป → ', '2) ระบบส่งภาพไปยัง provider (SlipOK/EasySlip) → ',
          '3) provider ถอด QR + เช็คกับธนาคารว่าเงินถึงจริง → ',
          '4) ระบบเช็คซ้ำ: ยอด ±1฿ ตรงบิล + บัญชีปลายทางตรง PromptPay + transRef ไม่ซ้ำ → ',
          '5) ผ่านทั้งสาม → บิล mark paid + แจ้ง LINE ทันที'),
        React.createElement('div', { style: { marginTop: 8, fontSize: 12.5, color: C.muted } },
          'ปกติ provider คิด 1-3 บาท/สลิป — เทียบกับเวลา admin ที่ต้องมานั่งกดอนุมัติเอง ระบบนี้คุ้มทันทีตั้งแต่บิลที่ 10+'),
      )
    ),

    // Live status / readiness banner
    slipIssues.length > 0 ? React.createElement(Card, {
      style: { background: '#fff7e0', borderLeft: `4px solid ${C.warning || '#c08a2a'}` },
    },
      React.createElement(SectionHeading, null, `⚠️ พบ ${slipIssues.length} ข้อที่ต้องแก้`),
      React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        slipIssues.map((i, idx) =>
          React.createElement('div', {
            key: idx,
            style: {
              padding: 10, background: C.bg, borderRadius: 6,
              borderLeft: `3px solid ${sevColor(i.sev)}`,
            },
          },
            React.createElement('div', { style: { fontSize: 13, lineHeight: 1.5 } },
              `${sevIcon(i.sev)} ${i.msg}`),
            i.fix ? React.createElement('div', {
              style: { fontSize: 12, color: C.muted, marginTop: 4 },
            }, `→ ${i.fix}`) : null,
          )
        ),
      ),
    ) : (status.step4Done && status.step1Done && status.step2Done ? React.createElement(Card, {
      style: { background: '#f0f9f0', borderLeft: '4px solid #2f8f5b' },
    },
      React.createElement('div', { style: { fontWeight: 600, fontSize: 14, color: '#1f5f3a' } },
        '✅ ตั้งค่าครบแล้ว — สลิปที่ผู้เช่าส่งจะถูกยืนยันอัตโนมัติ'),
      React.createElement('div', { style: { fontSize: 12.5, color: C.muted, marginTop: 4 } },
        'แนะนำให้กด "🔌 ทดสอบ" ด้านล่างหนึ่งครั้งเพื่อยืนยันว่า key ใช้ได้จริง'),
    ) : null),

    // Setup steps
    React.createElement(Card, null,
      React.createElement(SectionHeading, null, 'ขั้นตอนตั้งค่า'),

      // Step 1: enable slipUpload
      React.createElement(StepHeader, {
        n: 1,
        done: status.step1Done,
        title: 'เปิดฟีเจอร์อัปโหลดสลิป',
        hint: 'ผู้เช่าจะมีปุ่ม "ส่งสลิป" ในพอร์ทัล (/tenant) — ปิดอยู่ผู้เช่าจะส่งสลิปออนไลน์ไม่ได้',
      },
        React.createElement('div', null,
          React.createElement(Btn, {
            onClick: () => saveFeature({ slipUpload: { enabled: !status.step1Done } }),
            disabled: busy,
          }, status.step1Done ? '✓ เปิดอยู่ — กดเพื่อปิด' : 'เปิด slipUpload'),
          status.tenantPortalOff ? React.createElement('div', {
            style: { marginTop: 8, fontSize: 12.5, color: '#b94a48' },
          },
            '⚠ tenantPortal ปิดอยู่ — ผู้เช่า login ไม่ได้ ส่งสลิปไม่ได้ ',
            React.createElement('a', {
              href: '/admin#features',
              style: { color: C.accent, fontWeight: 600 },
            }, 'ไปเปิดที่ Features →')
          ) : null,
        ),
      ),

      // Step 2: enable autoVerify
      React.createElement(StepHeader, {
        n: 2,
        done: status.step2Done,
        title: 'เปิดการตรวจสลิปอัตโนมัติ (autoVerify)',
        hint: 'ถ้าปิด — สลิปจะตกเข้าคิว admin เหมือนเดิม (ต้องมาคลิกอนุมัติทีละใบ)',
      },
        React.createElement('div', null,
          React.createElement(Btn, {
            onClick: () => saveFeature({ slipUpload: { autoVerify: !status.step2Done } }),
            disabled: busy || !status.step1Done,
          }, status.step2Done ? '✓ เปิดอยู่ — กดเพื่อปิด' : 'เปิด autoVerify'),
          !status.step1Done ? React.createElement('div', {
            style: { marginTop: 8, fontSize: 12.5, color: C.muted },
          }, '↑ ทำขั้นตอน 1 ก่อน') : null,
        ),
      ),

      // Step 3: choose provider
      React.createElement(StepHeader, {
        n: 3,
        done: status.step3Done && status.step2Done,
        title: `เลือกผู้ให้บริการ — ตอนนี้: ${status.provider === 'easyslip' ? 'EasySlip' : 'SlipOK'}`,
        hint: 'เลือก provider ที่สมัครไว้ — ระบบจะเรียก provider นี้ก่อน ถ้า provider ล่ม transient จะ fall through ไป provider สำรอง (ถ้ามีตั้งไว้ใน providers array)',
      },
        React.createElement('div', { style: { display: 'flex', gap: 8 } },
          ['slipok', 'easyslip'].map((p) =>
            React.createElement('button', {
              key: p,
              onClick: () => saveFeature({ slipUpload: { provider: p } }),
              disabled: busy || status.provider === p || !status.step2Done,
              style: {
                padding: '8px 16px', borderRadius: 6,
                border: `1px solid ${status.provider === p ? C.accent : C.border}`,
                background: status.provider === p ? C.accent : 'transparent',
                color: status.provider === p ? '#fff' : C.ink,
                cursor: busy || !status.step2Done ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit', fontSize: 13.5, fontWeight: 500,
              },
            }, p === 'easyslip' ? 'EasySlip' : 'SlipOK')
          ),
        ),
      ),

      // Step 4: API key
      React.createElement(StepHeader, {
        n: 4,
        done: status.step4Done,
        title: `ใส่ API key ของ ${status.provider === 'easyslip' ? 'EasySlip' : 'SlipOK'}`,
        hint: status.provider === 'slipok'
          ? 'หาได้จาก https://slipok.com/ → API → x-authorization (และ Branch ID ถ้าเป็นแผน multi-branch)'
          : 'หาได้จาก https://developer.easyslip.com/ → API Keys',
      },
        React.createElement('div', null,
          status.keyEntry ? React.createElement(SecretInput, {
            spec: status.keyEntry,
            editing: !!editing[status.keyName],
            draft: drafts[status.keyName] || '',
            busy,
            C,
            onEdit: () => setEditing((e) => ({ ...e, [status.keyName]: true })),
            onCancel: () => {
              setEditing((e) => ({ ...e, [status.keyName]: false }));
              setDrafts((d) => ({ ...d, [status.keyName]: '' }));
            },
            onDraft: (v) => setDrafts((d) => ({ ...d, [status.keyName]: v })),
            onSave: () => saveSecret(status.keyName, drafts[status.keyName] || ''),
            onClear: () => saveSecret(status.keyName, ''),
          }) : null,
          status.provider === 'slipok' && status.branchEntry ? React.createElement('div', {
            style: { marginTop: 10 },
          },
            React.createElement(SecretInput, {
              spec: status.branchEntry,
              editing: !!editing.SLIPOK_BRANCH_ID,
              draft: drafts.SLIPOK_BRANCH_ID || '',
              busy,
              C,
              onEdit: () => setEditing((e) => ({ ...e, SLIPOK_BRANCH_ID: true })),
              onCancel: () => {
                setEditing((e) => ({ ...e, SLIPOK_BRANCH_ID: false }));
                setDrafts((d) => ({ ...d, SLIPOK_BRANCH_ID: '' }));
              },
              onDraft: (v) => setDrafts((d) => ({ ...d, SLIPOK_BRANCH_ID: v })),
              onSave: () => saveSecret('SLIPOK_BRANCH_ID', drafts.SLIPOK_BRANCH_ID || ''),
              onClear: () => saveSecret('SLIPOK_BRANCH_ID', ''),
            })
          ) : null,
        ),
      ),

      // Step 5: test
      React.createElement(StepHeader, {
        n: 5,
        done: status.step5Done,
        title: 'ทดสอบการเชื่อมต่อ',
        hint: 'ตรวจว่า key ใช้ได้จริงโดยไม่ส่งสลิป — provider ตอบ 200 ถือว่าผ่าน (ไม่หักเครดิตสลิป)',
      },
        React.createElement('div', null,
          React.createElement(Btn, {
            onClick: runTest,
            disabled: testing || !status.step4Done,
          }, testing ? 'กำลังทดสอบ…' : '🔌 ทดสอบ'),
          testResult ? React.createElement('div', {
            style: {
              marginTop: 10, padding: 10, borderRadius: 6,
              background: testResult.ok ? '#f0f9f0' : '#fff5f4',
              border: `1px solid ${testResult.ok ? '#bce0bc' : '#f0c5c0'}`,
              fontSize: 12.5, color: testResult.ok ? '#1f5f3a' : '#7a2920',
              fontFamily: 'JetBrains Mono, monospace', lineHeight: 1.5,
            },
          },
            testResult.ok
              ? (testResult.info
                ? `✓ ผ่าน — provider: ${testResult.info.provider || '-'}${
                    testResult.info.branchId ? ` · branch: ${testResult.info.branchId}` : ''
                  }`
                : '✓ ผ่าน')
              : `✗ ไม่ผ่าน — ${testResult.error || 'unknown'}`
          ) : null,
        ),
      ),
    ),

    // PromptPay reminder (cross-feature)
    React.createElement(Card, null,
      React.createElement(SectionHeading, null, 'ข้อกำหนดเพิ่มเติม'),
      React.createElement('div', {
        style: { fontSize: 13, lineHeight: 1.6 },
      },
        React.createElement('div', { style: { marginBottom: 6 } },
          status.promptpayConfigured === true ? '✓' :
          status.promptpayConfigured === false ? '🔴' : '…',
          ' PromptPay target ',
          status.promptpayConfigured === false
            ? React.createElement('span', { style: { color: '#b94a48' } },
                'ยังไม่ตั้ง / เป็น demo — ',
                React.createElement('a', {
                  href: '/admin#secrets',
                  style: { color: C.accent, fontWeight: 600 },
                }, 'ไปตั้งที่ Secrets →'))
            : React.createElement('span', { style: { color: C.muted, fontSize: 12.5 } },
                ' (ใช้เช็คว่าสลิปจ่ายเข้าบัญชีหอพักจริง)'),
        ),
        React.createElement('div', { style: { color: C.muted, fontSize: 12.5, marginTop: 8 } },
          '💡 เคล็ดลับ: หลังตั้งค่าครบ ทดลองให้ผู้เช่าคนหนึ่งส่งสลิปเล็ก ๆ (เช่นบิล ฿1) ก่อน เพื่อยืนยันว่า e2e ทำงาน ก่อนรอบบิลใหญ่จริง',
        ),
      ),
    ),

    // Diagnostics / advanced
    React.createElement(Card, null,
      React.createElement(SectionHeading, null, 'การวินิจฉัย'),
      React.createElement('div', { style: { fontSize: 13, color: C.ink2 } },
        React.createElement('div', null,
          'ดูสถานะระบบโดยรวมที่ ',
          React.createElement('a', {
            href: '/admin#health', style: { color: C.accent, fontWeight: 600 },
          }, 'สถานะระบบ →'),
        ),
        React.createElement('div', { style: { marginTop: 4 } },
          'ดูสลิปที่รอตรวจ + ผลตรวจล่าสุดที่ ',
          React.createElement('a', {
            href: '/admin#payments', style: { color: C.accent, fontWeight: 600 },
          }, 'สลิป/การชำระ →'),
        ),
      ),
    ),
  );
}

// Inline secret input — re-implemented locally so this page doesn't depend on
// page-secrets.jsx's SecretRow internals. Keeps each setup-flow page
// self-contained.
function SecretInput({ spec, editing, draft, busy, onEdit, onCancel, onDraft, onSave, onClear, C }) {
  const sourceColor = spec.source === 'env' ? '#3a7bba' : (spec.source === 'db' ? '#2f8f5b' : C.muted);
  const sourceLabel = spec.source === 'env' ? 'env (lock)' : (spec.source === 'db' ? 'DB' : 'ยังไม่ได้ตั้ง');
  const inputType = spec.kind === 'password' ? 'password' : (spec.kind === 'number' ? 'number' : 'text');
  return React.createElement('div', {
    style: {
      padding: '10px 12px',
      background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6,
    },
  },
    React.createElement('div', {
      style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 },
    },
      React.createElement('strong', { style: { fontSize: 13.5 } }, spec.label),
      React.createElement('code', {
        style: { fontSize: 11, color: C.muted, fontFamily: 'JetBrains Mono, monospace' },
      }, spec.key),
      React.createElement('span', {
        style: {
          fontSize: 11, padding: '2px 8px', borderRadius: 999,
          background: sourceColor + '22', color: sourceColor, fontWeight: 500,
        },
      }, sourceLabel),
    ),
    spec.description ? React.createElement('div', {
      style: { color: C.muted, fontSize: 12, marginBottom: 6 },
    }, spec.description) : null,
    !editing && spec.isSet ? React.createElement('div', {
      style: {
        fontFamily: 'JetBrains Mono, monospace', fontSize: 12.5,
        color: C.ink2, marginBottom: 6,
      },
    }, `ค่าปัจจุบัน: ${spec.maskedTail}`) : null,
    !editing && !spec.readOnly ? React.createElement('button', {
      onClick: onEdit,
      style: {
        padding: '6px 14px', borderRadius: 6, border: `1px solid ${C.border}`,
        background: 'transparent', color: C.ink, cursor: 'pointer',
        fontFamily: 'inherit', fontSize: 12.5,
      },
    }, spec.isSet ? 'เปลี่ยนค่า' : 'ตั้งค่า') : null,
    !editing && spec.readOnly ? React.createElement('span', {
      style: { color: C.muted, fontSize: 11, fontStyle: 'italic' },
    }, 'ตั้งใน env แล้ว') : null,
    editing ? React.createElement('div', {
      style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
    },
      React.createElement('input', {
        type: inputType,
        value: draft,
        onChange: (e) => onDraft(e.target.value),
        placeholder: spec.default ? `default: ${spec.default}` : 'ค่าใหม่',
        autoComplete: 'new-password',
        spellCheck: false,
        style: {
          flex: '1 1 240px', minWidth: 200,
          padding: '8px 12px', borderRadius: 6,
          border: `1px solid ${C.border}`, background: C.bgSoft || C.bg,
          color: C.ink, fontSize: 13.5, fontFamily: 'inherit',
        },
      }),
      React.createElement('button', {
        onClick: onSave,
        disabled: busy || !draft,
        style: {
          padding: '8px 14px', borderRadius: 6, border: 0,
          fontFamily: 'inherit', fontSize: 13,
          background: C.accent, color: '#fff',
          cursor: busy ? 'not-allowed' : 'pointer', fontWeight: 500,
        },
      }, 'บันทึก'),
      spec.isSet && spec.source === 'db' ? React.createElement('button', {
        onClick: () => {
          const ok = window.confirm(
            `ลบค่า ${spec.key}?\n\n` +
            '📌 ผลกระทบ: autoVerify จะใช้ provider นี้ไม่ได้ — สลิปจะตกเข้าคิว admin จนกว่าจะตั้งใหม่\n\n' +
            'ดำเนินการต่อ?'
          );
          if (ok) onClear();
        },
        disabled: busy,
        style: {
          padding: '8px 14px', borderRadius: 6,
          border: `1px solid ${C.danger || '#b94a48'}`,
          background: 'transparent', color: C.danger || '#b94a48',
          fontFamily: 'inherit', fontSize: 13, cursor: 'pointer',
        },
      }, 'ลบค่า') : null,
      React.createElement('button', {
        onClick: onCancel,
        style: {
          padding: '8px 14px', borderRadius: 6, border: 0,
          background: 'transparent', color: C.muted,
          cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
        },
      }, 'ยกเลิก'),
    ) : null,
  );
}

window.PageSlipVerify = PageSlipVerify;
