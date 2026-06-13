// === admin/page-slip-verify.jsx ===========================================
// Dedicated end-to-end setup for slip auto-verification (SlipOK / EasySlip / Slip2Go).
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

const SLIP_PROVIDERS = [
  { id: 'slipok', label: 'SlipOK', key: 'SLIPOK_API_KEY' },
  { id: 'easyslip', label: 'EasySlip', key: 'EASYSLIP_API_KEY' },
  { id: 'slip2go', label: 'Slip2Go', key: 'SLIP2GO_API_KEY', urlKey: 'SLIP2GO_API_URL' },
];
const SLIP_PROVIDER_LABEL = Object.fromEntries(SLIP_PROVIDERS.map((p) => [p.id, p.label]));
const slipProviderLabel = (id) => SLIP_PROVIDER_LABEL[id] || id || 'Provider';

function SlipVerifyStepHeader({ n, done, title, hint, children, C }) {
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
        React.createElement('div', { style: { fontFamily: 'IBM Plex Sans Thai', fontWeight: 600, fontSize: 14.5 } }, title),
        hint ? React.createElement('div', { style: { color: C.muted, fontSize: 12.5, marginTop: 2 } }, hint) : null,
      ),
    ),
    children ? React.createElement('div', { style: { marginTop: 12, marginLeft: 38 } }, children) : null
  );
}

function PageSlipVerify({ setToast }) {
  const C = window.ADMIN_C;
  const { Card, SectionHeading, Btn, Pill, PageContainer, PageHeader } = window;
  // apiFetch attaches CSRF + handles 401 redirect. Without it PUT/POST 403.
  const apiFetch = window.requireApiFetch ? window.requireApiFetch() : window.apiFetch;

  const [features, setFeatures] = useState(null);
  const [secrets, setSecrets] = useState({});           // { SLIPOK_API_KEY: {...}, ... }
  const [readiness, setReadiness] = useState(null);
  const [drafts, setDrafts] = useState({});             // per-key pending edit
  const [editing, setEditing] = useState({});           // per-key edit-mode toggle
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [err, setErr] = useState('');
  // Draft for the pending-slip escalation threshold (hours). '' = follow the
  // saved value; only diverges while the operator is typing.
  const [alertHoursDraft, setAlertHoursDraft] = useState('');
  // providerStatus carries per-provider readiness from secrets.testGroup.
  // Refreshed whenever the underlying keys change so the "ตอนนี้พร้อมไหม?"
  // panel auto-updates as admin saves a new key without forcing them to
  // click "ทดสอบ" again.
  const [providerStatus, setProviderStatus] = useState(null);

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

  // Probe per-provider connection state whenever the keys change. Surfaces
  // "ระบบเชื่อมต่อได้ไหม" without admin having to click the test button.
  const refreshProviderStatus = useCallback(async () => {
    try {
      const r = await apiFetch('/api/admin/secrets/test', {
        method: 'POST',
        body: JSON.stringify({ group: 'slipverify' }),
      });
      const d = await r.json();
      setProviderStatus(d);
    } catch { setProviderStatus(null); }
  }, [apiFetch]);
  useEffect(() => {
    refreshProviderStatus();
    // Track provider key/url isSet flags so saves re-probe the
    // connection. tag-prop chains: saveSecret → reload → setSecrets →
    // dep change here → refresh.
  }, [
    refreshProviderStatus,
    secrets.SLIPOK_API_KEY?.isSet,
    secrets.EASYSLIP_API_KEY?.isSet,
    secrets.SLIP2GO_API_KEY?.isSet,
    secrets.SLIP2GO_API_URL?.isSet,
  ]);

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
      // affect what the test would prove. Switching providers,
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
    // The backend supports either a single `provider` string (legacy) OR a
    // `providers` array (new — for auto-failover chain). Reconcile both
    // here so the UI can render the right "primary" while still allowing
    // the operator to configure both keys side-by-side regardless of which
    // representation the row currently carries.
    const providersArr = Array.isArray(slip.providers) && slip.providers.length > 0
      ? slip.providers
      : (slip.provider ? [slip.provider] : ['slipok']);
    const primary = providersArr[0];
    // Per-provider credential entries — all are surfaced in step 4 regardless of
    // which is primary, so admin can save EITHER without first switching the
    // dropdown. Fixes the bug where saving EasySlip's key hid SlipOK's input.
    const slipokKey = secrets.SLIPOK_API_KEY;
    const easyslipKey = secrets.EASYSLIP_API_KEY;
    const slip2goKey = secrets.SLIP2GO_API_KEY;
    const slip2goUrl = secrets.SLIP2GO_API_URL;
    const branchEntry = secrets.SLIPOK_BRANCH_ID;
    const slipokKeySet = !!(slipokKey && slipokKey.isSet);
    const easyslipKeySet = !!(easyslipKey && easyslipKey.isSet);
    const slip2goKeySet = !!(slip2goKey && slip2goKey.isSet && slip2goUrl && slip2goUrl.isSet);
    const providerReadyById = {
      slipok: slipokKeySet,
      easyslip: easyslipKeySet,
      slip2go: slip2goKeySet,
    };
    const readyProviders = SLIP_PROVIDERS
      .map((p) => p.id)
      .filter((id) => providerReadyById[id]);
    // Failover is "live" when two or more providers are ready AND appear in
    // the providers array. We auto-promote to providers=[primary, ...ready]
    // when enough providers are detected — keeps the operator from having to
    // know the JSON-array shape exists.
    const failoverReady = providersArr.filter((id) => providerReadyById[id]).length >= 2;
    return {
      primary,
      providersArr,
      slipokKey, slipokKeySet,
      easyslipKey, easyslipKeySet,
      slip2goKey, slip2goUrl, slip2goKeySet,
      branchEntry,
      branchSet: !!(branchEntry && branchEntry.isSet),
      providerReadyById,
      readyProviders,
      failoverReady,
      // step4 done when AT LEAST one provider is configured and ready.
      step1Done: slip.enabled === true,
      step2Done: slip.autoVerify === true,
      step3Done: !!primary,
      step4Done: readyProviders.length > 0,
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

  // When multiple providers are ready but features.slipUpload.providers doesn't yet
  // reflect the failover chain (legacy single-provider config), auto-upgrade
  // it once so verifyWithFallback iterates both. The setField fires only when
  // the upgrade is actually needed — no-op on each subsequent render.
  React.useEffect(() => {
    if (!status) return;
    if (status.readyProviders.length >= 2) {
      const currentProviders = features?.slipUpload?.providers;
      const wantProviders = [
        status.primary,
        ...status.readyProviders.filter((p) => p !== status.primary),
      ];
      const match = Array.isArray(currentProviders)
        && currentProviders.length === wantProviders.length
        && currentProviders.every((p, i) => p === wantProviders[i]);
      if (!match) {
        // Fire once via saveFeature; the reload() inside will refresh the
        // useMemo on the next render so this effect doesn't re-fire.
        saveFeature({ slipUpload: { providers: wantProviders } });
      }
    }
  }, [status?.readyProviders.join('|'), status?.primary]);

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
        subtitle: 'ตั้งค่าระบบยืนยันสลิปด้วย API (SlipOK / EasySlip / Slip2Go)',
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

  // ── Render ────────────────────────────────────────────────────────────
  return React.createElement(PageContainer, null,
    React.createElement(PageHeader, {
      title: 'ตรวจสลิปอัตโนมัติ',
      subtitle: 'ตั้งค่า SlipOK / EasySlip / Slip2Go ทีเดียวจบ — สลิปที่ผู้เช่าส่งจะถูกยืนยันและบิลถูก mark paid อัตโนมัติภายใน 3-5 วินาที',
    }),

    // Intro / explainer card
    React.createElement(Card, {
      style: { background: '#fdfaf2', borderLeft: `4px solid ${C.accent || '#c46a3e'}` },
    },
      React.createElement('div', { style: { fontSize: 13.5, lineHeight: 1.7, color: C.ink2 || C.ink } },
        React.createElement('div', { style: { fontWeight: 600, marginBottom: 6, fontFamily: 'IBM Plex Sans Thai' } },
          '🧾 หลักการทำงาน'),
        React.createElement('div', null,
          '1) ผู้เช่าอัปโหลดสลิป → ', '2) ระบบส่งภาพไปยัง provider (SlipOK/EasySlip/Slip2Go) → ',
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

    // Live connection-status panel — answers "ระบบเชื่อมต่อได้ไหมตอนนี้?"
    // without admin clicking the test button. Auto-refreshes when the
    // underlying keys change (refreshProviderStatus effect above).
    providerStatus ? React.createElement(Card, null,
      React.createElement(SectionHeading, null, 'สถานะการเชื่อมต่อ provider'),
      React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        (providerStatus.providers || []).map((p) => {
          const isPrimary = status.primary === p.id;
          return React.createElement('div', {
            key: p.id,
            style: {
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 14px', borderRadius: 8,
              background: p.ready ? '#f0f9f0' : '#fff5f4',
              border: `1px solid ${p.ready ? '#bce0bc' : '#f5c0b4'}`,
            },
          },
            React.createElement('div', null,
              React.createElement('div', { style: { fontWeight: 600, fontSize: 14 } },
                `${p.ready ? '✅' : '❌'} ${p.label}`,
                isPrimary ? React.createElement('span', {
                  style: {
                    marginLeft: 8, fontSize: 11, padding: '2px 8px',
                    borderRadius: 999, background: C.accent + '22', color: C.accent, fontWeight: 600,
                  },
                }, 'PRIMARY') : null,
              ),
              React.createElement('div', { style: { fontSize: 12, color: C.muted, marginTop: 2 } },
                p.ready
                  ? (p.detail?.branchId
                      ? `พร้อมใช้งาน · branch: ${p.detail.branchId}`
                      : p.detail?.apiUrl
                        ? `พร้อมใช้งาน · url: ${p.detail.apiUrl}`
                      : 'พร้อมใช้งาน — key ถูกตั้งแล้ว')
                  : (p.detail?.hint || 'key ยังไม่ตั้ง')
              ),
            ),
            React.createElement('div', { style: { fontSize: 12, color: C.muted } },
              p.ready ? 'connected' : 'not configured',
            ),
          );
        }),
        // Overall summary
        React.createElement('div', {
          style: {
            marginTop: 4, padding: '8px 12px', borderRadius: 6,
            background: providerStatus.ok ? '#fdfaf2' : '#fff5f4',
            border: `1px solid ${providerStatus.ok ? '#ece4d4' : '#f5c0b4'}`,
            fontSize: 12.5, lineHeight: 1.6,
          },
        },
          providerStatus.info?.failoverReady
            ? `🔁 Auto-failover พร้อม — ${status.providersArr.filter((id) => status.providerReadyById[id]).length} provider เชื่อมต่อได้ ระบบจะใช้ ${slipProviderLabel(status.primary)} ก่อน แล้ว fall through ถ้าล่ม`
            : providerStatus.readyCount === 1
              ? `⚠️ มีแค่ provider เดียวที่พร้อม — ถ้า provider นี้ล่ม สลิปจะตกเข้าคิว admin (ตั้ง key อีกอันเพื่อ enable auto-failover)`
              : `🔴 ระบบยังเชื่อมต่อไม่ได้ — ต้องตั้ง key อย่างน้อย 1 provider ที่ Step 4 ด้านล่าง`,
        ),
      ),
    ) : null,

    // Setup steps
    React.createElement(Card, null,
      React.createElement(SectionHeading, null, 'ขั้นตอนตั้งค่า'),

      // Step 1: enable slipUpload
      React.createElement(SlipVerifyStepHeader, {
        C,
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
      React.createElement(SlipVerifyStepHeader, {
        C,
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

      // Step 3: choose PRIMARY provider (system tries this first; falls
      // through to ready fallback providers on transient failures)
      React.createElement(SlipVerifyStepHeader, {
        C,
        n: 3,
        done: status.step3Done && status.step2Done,
        title: `Provider หลัก — ตอนนี้: ${slipProviderLabel(status.primary)}`,
        hint: status.failoverReady
          ? '✓ Auto-failover พร้อม: ระบบจะเรียก provider หลักก่อน ถ้าตอบ transient error (timeout, 5xx, parse fail) จะลอง provider สำรองให้อัตโนมัติ'
          : 'เลือก provider ที่จะถูกเรียกก่อน — เมื่อตั้งค่า provider อย่างน้อย 2 ตัวด้านล่าง ระบบจะ enable auto-failover อัตโนมัติ',
      },
        React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          SLIP_PROVIDERS.map((meta) => meta.id).map((p) => {
            const isActive = status.primary === p;
            const targetKeySet = !!status.providerReadyById[p];
            return React.createElement('button', {
              key: p,
              onClick: () => {
                // Warn before switching to a provider whose key isn't set —
                // the switch will succeed but auto-verify won't work. Better
                // to surface this BEFORE the click takes effect so admin
                // doesn't think "I switched but verification is silently
                // broken". Confirm only — they can still proceed if they
                // know what they're doing.
                if (!isActive && !targetKeySet) {
                  const ok = window.confirm(
                    `⚠ ${slipProviderLabel(p)} ยังไม่ได้ตั้ง API key\n\n` +
                    `ถ้าสลับเป็น primary ตอนนี้ ระบบจะ:\n` +
                    `  • ใช้ ${slipProviderLabel(p)} เป็น primary (ตามที่เลือก)\n` +
                    `  • แต่ verify จะใช้งานไม่ได้ทันที — สลิปจะตกเข้าคิว admin\n\n` +
                    `📌 แนะนำ: ตั้ง API key ของ ${slipProviderLabel(p)} ที่ Step 4 ก่อน แล้วค่อยสลับ primary\n\n` +
                    `ดำเนินการสลับต่อหรือไม่?`
                  );
                  if (!ok) return;
                }
                saveFeature({ slipUpload: {
                  provider: p,
                  providers: [p, ...status.readyProviders.filter((id) => id !== p)],
                }});
              },
              disabled: busy || isActive || !status.step2Done,
              style: {
                padding: '8px 16px', borderRadius: 6,
                border: `1px solid ${isActive ? C.accent : (targetKeySet ? C.border : '#f0c5b4')}`,
                background: isActive ? C.accent : 'transparent',
                color: isActive ? '#fff' : C.ink,
                cursor: busy || !status.step2Done ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit', fontSize: 13.5, fontWeight: 500,
                opacity: !targetKeySet && !isActive ? 0.85 : 1,
              },
            }, `${slipProviderLabel(p)}${targetKeySet ? '' : ' ⚠ key ยังไม่ตั้ง'}`);
          }),
        ),
        status.failoverReady ? React.createElement('div', {
          style: {
            marginTop: 10, padding: '6px 10px',
            background: '#f0f9f0', border: '1px solid #bce0bc',
            borderRadius: 6, fontSize: 12.5, color: '#1f5f3a',
          },
        }, `🔁 Auto-failover: ${status.providersArr.filter((id) => status.providerReadyById[id]).map(slipProviderLabel).join(' → ')} `
          + `(ถ้า ${slipProviderLabel(status.primary)} ล่ม จะลอง provider สำรองให้ทันที)`) : null,
      ),

      // Step 4: API keys — all providers shown side-by-side so admin can
      // configure either without first switching the primary selector.
      // The previous version only rendered the selected provider's key,
      // which made it impossible to save EasySlip then later set SlipOK
      // without re-clicking the dropdown each time.
      React.createElement(SlipVerifyStepHeader, {
        C,
        n: 4,
        done: status.step4Done,
        title: 'API keys (ตั้งหลาย provider → auto-failover พร้อม)',
        hint: 'ตั้ง provider อย่างน้อย 1 ตัวก็เริ่มใช้งานได้ — ตั้งพร้อมใช้ตั้งแต่ 2 ตัวขึ้นไป ระบบจะสลับมาใช้อันสำรองอัตโนมัติเมื่ออันหลักล่ม',
      },
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          // SlipOK key — always shown, regardless of primary selection
          React.createElement('div', null,
            React.createElement('div', {
              style: {
                fontSize: 12.5, fontWeight: 600, marginBottom: 6,
                color: status.primary === 'slipok' ? C.accent : C.muted,
              },
            }, `🧾 SlipOK${status.primary === 'slipok' ? ' (primary)' : ' (fallback)'}`),
            status.slipokKey ? React.createElement(SecretInput, {
              spec: status.slipokKey,
              editing: !!editing.SLIPOK_API_KEY,
              draft: drafts.SLIPOK_API_KEY || '',
              busy,
              C,
              onEdit: () => setEditing((e) => ({ ...e, SLIPOK_API_KEY: true })),
              onCancel: () => {
                setEditing((e) => ({ ...e, SLIPOK_API_KEY: false }));
                setDrafts((d) => ({ ...d, SLIPOK_API_KEY: '' }));
              },
              onDraft: (v) => setDrafts((d) => ({ ...d, SLIPOK_API_KEY: v })),
              onSave: () => saveSecret('SLIPOK_API_KEY', drafts.SLIPOK_API_KEY || ''),
              onClear: () => saveSecret('SLIPOK_API_KEY', ''),
            }) : React.createElement('div', { style: { color: C.muted, fontSize: 12.5 } },
              'กำลังโหลด…'),
            // SlipOK branch ID — optional, shown right under the SlipOK key
            status.branchEntry ? React.createElement('div', { style: { marginTop: 8 } },
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
          // EasySlip key — always shown
          React.createElement('div', null,
            React.createElement('div', {
              style: {
                fontSize: 12.5, fontWeight: 600, marginBottom: 6,
                color: status.primary === 'easyslip' ? C.accent : C.muted,
              },
            }, `🧾 EasySlip${status.primary === 'easyslip' ? ' (primary)' : ' (fallback)'}`),
            status.easyslipKey ? React.createElement(SecretInput, {
              spec: status.easyslipKey,
              editing: !!editing.EASYSLIP_API_KEY,
              draft: drafts.EASYSLIP_API_KEY || '',
              busy,
              C,
              onEdit: () => setEditing((e) => ({ ...e, EASYSLIP_API_KEY: true })),
              onCancel: () => {
                setEditing((e) => ({ ...e, EASYSLIP_API_KEY: false }));
                setDrafts((d) => ({ ...d, EASYSLIP_API_KEY: '' }));
              },
              onDraft: (v) => setDrafts((d) => ({ ...d, EASYSLIP_API_KEY: v })),
              onSave: () => saveSecret('EASYSLIP_API_KEY', drafts.EASYSLIP_API_KEY || ''),
              onClear: () => saveSecret('EASYSLIP_API_KEY', ''),
            }) : React.createElement('div', { style: { color: C.muted, fontSize: 12.5 } },
              'กำลังโหลด…'),
          ),
          // Slip2Go key + API URL — both are required by Slip2Go's docs.
          React.createElement('div', null,
            React.createElement('div', {
              style: {
                fontSize: 12.5, fontWeight: 600, marginBottom: 6,
                color: status.primary === 'slip2go' ? C.accent : C.muted,
              },
            }, `🧾 Slip2Go${status.primary === 'slip2go' ? ' (primary)' : ' (fallback)'}`),
            status.slip2goKey ? React.createElement(SecretInput, {
              spec: status.slip2goKey,
              editing: !!editing.SLIP2GO_API_KEY,
              draft: drafts.SLIP2GO_API_KEY || '',
              busy,
              C,
              onEdit: () => setEditing((e) => ({ ...e, SLIP2GO_API_KEY: true })),
              onCancel: () => {
                setEditing((e) => ({ ...e, SLIP2GO_API_KEY: false }));
                setDrafts((d) => ({ ...d, SLIP2GO_API_KEY: '' }));
              },
              onDraft: (v) => setDrafts((d) => ({ ...d, SLIP2GO_API_KEY: v })),
              onSave: () => saveSecret('SLIP2GO_API_KEY', drafts.SLIP2GO_API_KEY || ''),
              onClear: () => saveSecret('SLIP2GO_API_KEY', ''),
            }) : React.createElement('div', { style: { color: C.muted, fontSize: 12.5 } },
              'กำลังโหลด…'),
            status.slip2goUrl ? React.createElement('div', { style: { marginTop: 8 } },
              React.createElement(SecretInput, {
                spec: status.slip2goUrl,
                editing: !!editing.SLIP2GO_API_URL,
                draft: drafts.SLIP2GO_API_URL || '',
                busy,
                C,
                onEdit: () => setEditing((e) => ({ ...e, SLIP2GO_API_URL: true })),
                onCancel: () => {
                  setEditing((e) => ({ ...e, SLIP2GO_API_URL: false }));
                  setDrafts((d) => ({ ...d, SLIP2GO_API_URL: '' }));
                },
                onDraft: (v) => setDrafts((d) => ({ ...d, SLIP2GO_API_URL: v })),
                onSave: () => saveSecret('SLIP2GO_API_URL', drafts.SLIP2GO_API_URL || ''),
                onClear: () => saveSecret('SLIP2GO_API_URL', ''),
              })
            ) : null,
          ),
        ),
      ),

      // Step 5: test
      React.createElement(SlipVerifyStepHeader, {
        C,
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

    // Hardening — optional strictness knobs. All default OFF so the
    // long-standing behaviour is unchanged until the operator opts in.
    React.createElement(Card, null,
      React.createElement(SectionHeading, null, 'ความเข้มงวดการตรวจ (ตัวเลือกเสริม)'),
      React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13 } },
        // strictReceiverTail
        React.createElement('div', null,
          React.createElement('label', { style: { display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' } },
            React.createElement('input', {
              type: 'checkbox',
              checked: features?.slipUpload?.strictReceiverTail === true,
              disabled: busy,
              onChange: (e) => saveFeature({ slipUpload: { strictReceiverTail: e.target.checked } }),
              style: { marginTop: 3 },
            }),
            React.createElement('div', null,
              React.createElement('div', { style: { fontWeight: 600 } }, 'โหมดเข้มงวดเลขท้ายบัญชี (strictReceiverTail)'),
              React.createElement('div', { style: { color: C.muted, fontSize: 12.5, lineHeight: 1.55 } },
                'ธนาคารปิดบังเลขบัญชีได้หลายรูปแบบ (xxx-x-x1234, 12**5***99, 1*3*5****9) — '
                + 'ระบบเทียบทุกหลักที่อ่านได้ตามตำแหน่งจริง เปิดโหมดนี้แล้ว '
                + 'สลิปที่อ่านเลขตรงกันได้น้อยกว่า 6 หลักจะไม่ auto-ผ่าน '
                + 'แต่เข้าคิวให้แอดมินยืนยันแทน (ไม่มีทาง reject ผู้เช่าผิด ๆ)'),
            ),
          ),
        ),
        // providerReceiverCheck
        React.createElement('div', null,
          React.createElement('label', { style: { display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' } },
            React.createElement('input', {
              type: 'checkbox',
              checked: features?.slipUpload?.providerReceiverCheck === true,
              disabled: busy,
              onChange: (e) => saveFeature({ slipUpload: { providerReceiverCheck: e.target.checked } }),
              style: { marginTop: 3 },
            }),
            React.createElement('div', null,
              React.createElement('div', { style: { fontWeight: 600 } }, 'ให้ provider ตรวจบัญชีผู้รับซ้ำอีกชั้น (providerReceiverCheck)'),
              React.createElement('div', { style: { color: C.muted, fontSize: 12.5, lineHeight: 1.55 } },
                'ส่งคำสั่งให้ EasySlip (matchAccount — ต้องลงทะเบียนบัญชีในแดชบอร์ดของเขาก่อน) '
                + 'และ Slip2Go (checkReceiver เทียบกับ PromptPay ของหอ) ตรวจ "เลขบัญชีเต็ม" ฝั่ง provider '
                + 'เพิ่มจากการเทียบเลขท้ายฝั่งเรา — เปิดได้เมื่อตั้งค่าฝั่ง provider แล้วเท่านั้น'),
            ),
          ),
        ),
        // pendingSlipAlertHours
        React.createElement('div', null,
          React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } },
            'แจ้งเตือนสลิปค้างคิวตรวจ (pendingSlipAlertHours)'),
          React.createElement('div', { style: { color: C.muted, fontSize: 12.5, lineHeight: 1.55, marginBottom: 8 } },
            'แจ้ง owner ทาง LINE/อีเมลเมื่อสลิปนั่งรอในคิวนานเกินชั่วโมงที่ตั้ง (แจ้งครั้งเดียวต่อสลิป) — '
            + 'เร็วกว่ารอสรุปรายวัน · 0 = ปิดการแจ้งเตือนนี้'),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            React.createElement('input', {
              type: 'number', min: 0, max: 168, step: 1,
              value: alertHoursDraft === ''
                ? String(features?.slipUpload?.pendingSlipAlertHours ?? 12)
                : alertHoursDraft,
              disabled: busy,
              onChange: (e) => setAlertHoursDraft(e.target.value),
              style: {
                width: 90, padding: '6px 8px', fontSize: 13,
                border: `1px solid ${C.border}`, borderRadius: 6,
              },
            }),
            React.createElement('span', { style: { color: C.muted, fontSize: 12.5 } }, 'ชั่วโมง'),
            React.createElement(Btn, {
              disabled: busy || alertHoursDraft === '',
              onClick: () => {
                const n = Number(alertHoursDraft);
                if (!Number.isInteger(n) || n < 0 || n > 168) {
                  setToast && setToast({ kind: 'warning', message: 'ต้องเป็นจำนวนเต็ม 0-168 ชั่วโมง (0 = ปิด)' });
                  return;
                }
                saveFeature({ slipUpload: { pendingSlipAlertHours: n } });
                setAlertHoursDraft('');
              },
            }, 'บันทึก'),
          ),
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
