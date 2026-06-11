// === admin/page-contracts.jsx ============================================
// List + edit lease contracts (contracts table). Mostly read-only with a
// targeted edit modal for discount_pct / term_months / end_date / status.
// Pairs with the scheduler.tickContractExpiry alert so admin sees what
// the alert is referencing.
// ===========================================================================

const { useState, useEffect, useMemo } = React;

function PageContracts({ setToast, addActivity, rooms = {}, config }) {
  const C = window.ADMIN_C;
  const { Card, Btn, Input, Select, Modal, Pill, FilterChip, SectionHeading,
          PageContainer, PageHeader } = window;
  const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
  const hashContractSearch = () => {
    try {
      const raw = String(window.location.hash || '');
      const q = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
      const params = new URLSearchParams(q);
      return String(params.get('contract') || params.get('room') || params.get('roomId') || '').trim();
    } catch {
      return '';
    }
  };

  const [contracts, setContracts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('active');
  const [search, setSearch] = useState(hashContractSearch);
  const [editing, setEditing] = useState(null);
  const [signing, setSigning] = useState(null);     // contract being signed online
  const [assigning, setAssigning] = useState(null); // contract for template assignment
  const [inviting, setInviting] = useState(null);   // contract for self-fill invite
  const [quickCreating, setQuickCreating] = useState(false);  // "+ สร้างสัญญา + ส่งลิงก์"
  const [renewing, setRenewing] = useState(null);   // contract being renewed (prefilled quick-invite)
  const [templates, setTemplates] = useState([]);   // for assignment dropdown

  // Pre-load templates list for the assign-template modal. Cheap call,
  // single round-trip — fires once when the page mounts.
  useEffect(() => {
    apiCall('/api/admin/contract-templates').then((d) => {
      setTemplates(d.templates || []);
    }).catch(() => { /* fail-soft, modal will show fallback */ });
  }, []);

  // Open the contract PDF in a new tab. Inline by default so admin can
  // print directly; ?download=1 flips to attachment for save-and-email.
  const openPdf = (contract, opts = {}) => {
    const params = new URLSearchParams();
    if (opts.download) params.set('download', '1');
    if (opts.templateId) params.set('templateId', String(opts.templateId));
    const url = `/api/contracts/${contract.id}/pdf${params.toString() ? '?' + params : ''}`;
    window.open(url, '_blank', 'noopener');
  };

  const contractMissingLabel = (code) => ({
    address: 'ที่อยู่ผู้เช่า',
    emergencyContactName: 'ชื่อผู้ติดต่อฉุกเฉิน',
    emergencyContactPhone: 'เบอร์ผู้ติดต่อฉุกเฉิน',
    emergencyContact: 'ผู้ติดต่อฉุกเฉิน',
    citizenId: 'เลขบัตรประชาชน 13 หลัก',
    citizenIdFront: 'รูปบัตรประชาชนด้านหน้า',
    citizenIdBack: 'รูปบัตรประชาชนด้านหลัง',
  }[code] || code);

  const formatContractWarningDetail = (warning) => {
    if (!warning) return '';
    const missing = Array.isArray(warning.missing)
      ? warning.missing.map(contractMissingLabel).filter(Boolean)
      : [];
    if (missing.length) return `ขาด: ${missing.join(', ')}`;
    if (warning.action) return `ต้องทำ: ${warning.action}`;
    return warning.consequence || '';
  };

  const contractWarningMeta = (warning) => {
    const code = String((warning && warning.code) || '');
    if (code === 'CONTRACT_IDENTITY_INCOMPLETE') {
      return { domain: 'ผู้เช่า', tone: 'danger', fix: 'เปิดผู้เช่า → แท็บสัญญา → ปุ่ม "เติมข้อมูล/อัปโหลดเอกสาร" เพื่อบันทึกข้อมูล/รูปบัตรย้อนหลัง' };
    }
    if (code.includes('IDENTITY') || code.includes('TENANT')) {
      return { domain: 'ผู้เช่า', tone: 'danger', fix: 'เปิดหน้า/แท็บผู้เช่า แล้วเติมข้อมูลหรือ checkout ให้ตรงสถานะ' };
    }
    if (code.includes('ROOM')) {
      return { domain: 'ห้อง', tone: 'danger', fix: 'เปิดหน้าห้องพักหรือ reconcile ห้องนี้ก่อนทำรายการต่อ' };
    }
    if (code.includes('RENT') || code.includes('DEPOSIT')) {
      return { domain: 'เงิน/บิล', tone: 'danger', fix: 'ตรวจค่าเช่า มัดจำ และราคาที่ใช้กับบิลก่อน lock/ออกบิล' };
    }
    if (code.includes('TEMPLATE') || code.includes('SNAPSHOT') || code.includes('INVITATION')) {
      return { domain: 'PDF/ลิงก์', tone: 'warning', fix: 'ตรวจ template, snapshot หรือออกลิงก์ใหม่ให้จบก่อนอนุมัติ' };
    }
    if (code.includes('END_DATE') || code.includes('EXPIRED')) {
      return { domain: 'อายุสัญญา', tone: 'warning', fix: 'ต่อสัญญาใหม่หรือปิดสัญญาให้ตรงสถานะจริง' };
    }
    return { domain: 'ระบบ', tone: warning && warning.severity === 'error' ? 'danger' : 'warning', fix: warning && warning.action };
  };

  const contractReadiness = (contract) => {
    const warnings = Array.isArray(contract.warnings) ? contract.warnings : [];
    const hasError = warnings.some((w) => w.severity === 'error');
    if (hasError) return { label: 'ต้องแก้ก่อนใช้', color: 'danger' };
    if (warnings.length) return { label: 'ควรตรวจ', color: 'warning' };
    if (contract.active_invitation_status === 'submitted') return { label: 'รอตรวจผู้เช่า', color: 'warning' };
    if (contract.active_invitation_status === 'pending') return { label: 'รอผู้เช่ากรอก', color: 'info' };
    if (contract.status === 'active' && contract.days_left != null && contract.days_left <= 30 && contract.days_left >= 0) {
      return { label: 'ใกล้หมดอายุ', color: 'warning' };
    }
    if (contract.locked_at) return { label: 'พร้อมใช้งาน', color: 'success' };
    return { label: 'ใช้งานได้', color: 'success' };
  };

  const contractIdentityGap = (contract) => {
    const warning = (Array.isArray(contract && contract.warnings) ? contract.warnings : [])
      .find((w) => w && w.code === 'CONTRACT_IDENTITY_INCOMPLETE');
    if (!warning) return null;
    const labels = Array.isArray(warning.missing)
      ? warning.missing.map(contractMissingLabel).filter(Boolean)
      : [];
    return labels.length ? labels : ['ข้อมูลผู้เช่า/เอกสารประกอบสัญญา'];
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const d = await apiCall('/api/contracts');
      setContracts(d.contracts || []);
    } catch (e) {
      if (window.toastError && setToast) {
        window.toastError(setToast, e, { action: 'โหลดสัญญา' });
      } else {
        setToast && setToast({ kind: 'danger', message: 'โหลดสัญญาล้มเหลว: ' + e.message });
      }
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    const onHash = () => {
      if (!String(window.location.hash || '').replace('#', '').startsWith('contracts')) return;
      const next = hashContractSearch();
      if (next) setSearch(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Deep-link "#contracts?renew=<id>" (from the tenants page / expiry alert)
  // opens the prefilled renewal modal as soon as the contract list has the
  // row. An expired contract isn't in the default 'active' filter — widen to
  // 'all' once and let this effect re-run after the refetch.
  useEffect(() => {
    if (loading) return;
    let renewId = '';
    try {
      const raw = String(window.location.hash || '');
      const q = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
      renewId = String(new URLSearchParams(q).get('renew') || '').trim();
    } catch { /* malformed hash — ignore */ }
    if (!renewId) return;
    const target = contracts.find((c) =>
      String(c.id) === renewId || String(c.contract_no) === renewId);
    if (target) {
      setRenewing(target);
      // Strip the param so closing the modal doesn't re-open it.
      window.history.replaceState(null, '', '#contracts');
    } else if (filter !== 'all') {
      setFilter('all');
    }
  }, [contracts, loading]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return contracts.filter((c) => {
      if (filter === 'review' && !(Array.isArray(c.warnings) && c.warnings.length)) return false;
      if (!['all', 'review'].includes(filter) && c.status !== filter) return false;
      if (!q) return true;
      return String(c.id || '').toLowerCase().includes(q) ||
        String(c.contract_no || '').toLowerCase().includes(q) ||
        String(c.tenant_name || '').toLowerCase().includes(q) ||
        String(c.tenant_phone || '').includes(q) ||
        String(c.room_id || '').toLowerCase().includes(q) ||
        String((c.warnings || []).map((w) => `${w.code} ${w.title} ${formatContractWarningDetail(w)}`).join(' ')).toLowerCase().includes(q);
    });
  }, [contracts, search, filter]);

  const STATUS_PILL = {
    active: 'success', expired: 'warning', ended: 'gray',
  };
  const STATUS_TH = {
    active: 'มีผล', expired: 'หมดอายุ', ended: 'สิ้นสุดแล้ว',
  };
  const fmtDate = (s) => {
    if (!s) return '-';
    try { return new Date(s).toLocaleDateString('th-TH'); }
    catch { return s; }
  };
  const fmtCurrency = (n) => {
    const v = Number(n);
    return Number.isFinite(v)
      ? v.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '-';
  };

  // Counts for the header tabs — derived from contracts but recomputed each
  // render so filter switches stay snappy without an extra fetch.
  const counts = useMemo(() => {
    const out = {
      all: contracts.length, active: 0, expired: 0, ended: 0, expiring: 0,
      warnings: 0, errors: 0, submitted: 0, pending: 0, ready: 0,
    };
    for (const c of contracts) {
      out[c.status] = (out[c.status] || 0) + 1;
      if (c.status === 'active' && c.days_left != null && c.days_left <= 30 && c.days_left >= 0) {
        out.expiring++;
      }
      if (Array.isArray(c.warnings) && c.warnings.length) {
        out.warnings++;
        if (c.warnings.some((w) => w.severity === 'error')) out.errors++;
      }
      if (c.active_invitation_status === 'submitted') out.submitted++;
      if (c.active_invitation_status === 'pending') out.pending++;
      if (contractReadiness(c).color === 'success') out.ready++;
    }
    return out;
  }, [contracts]);

  const contractIssueBuckets = useMemo(() => {
    const buckets = new Map();
    for (const c of contracts) {
      for (const w of (Array.isArray(c.warnings) ? c.warnings : [])) {
        const meta = contractWarningMeta(w);
        const key = meta.domain;
        const row = buckets.get(key) || { domain: key, count: 0, errors: 0, fix: meta.fix, tone: meta.tone, examples: [] };
        row.count++;
        if (w.severity === 'error') row.errors++;
        if (row.examples.length < 2) row.examples.push(`${c.contract_no || c.id}: ${w.title || w.code}`);
        buckets.set(key, row);
      }
    }
    return Array.from(buckets.values())
      .sort((a, b) => (b.errors - a.errors) || (b.count - a.count) || a.domain.localeCompare(b.domain));
  }, [contracts]);

  const ContractWarningStack = ({ contract }) => {
    const warnings = Array.isArray(contract.warnings) ? contract.warnings : [];
    if (!warnings.length) return null;
    const hasError = warnings.some((w) => w.severity === 'error');
    return (
      <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
        <Pill color={hasError ? 'danger' : 'warning'}>
          ต้องตรวจ {warnings.length} จุด
        </Pill>
        {warnings.slice(0, 3).map((w) => {
          const meta = contractWarningMeta(w);
          const detail = formatContractWarningDetail(w);
          const toneColor = meta.tone === 'danger'
            ? (C.danger || '#b91c1c')
            : (C.warning || '#d97706');
          return (
            <div key={w.code || w.title} title={w.consequence || ''}
              style={{
                padding: '7px 8px',
                borderRadius: 8,
                border: `1px solid ${toneColor}33`,
                borderLeft: `3px solid ${toneColor}`,
                background: meta.tone === 'danger'
                  ? (C.dangerSoft || '#fee2e2')
                  : (C.warningSoft || '#fff7ed'),
                color: C.ink2,
                fontSize: 11,
                lineHeight: 1.45,
                maxWidth: 360,
              }}>
              <div style={{ fontWeight: 700, color: C.ink }}>
                {meta.domain}: {w.title || w.code || 'ตรวจสอบข้อมูล'}
              </div>
              {detail ? <div>รายละเอียด: {detail}</div> : null}
              {w.consequence ? <div>ผลกระทบ: {w.consequence}</div> : null}
              {meta.fix ? <div>ต้องแก้ที่: {meta.fix}</div> : null}
            </div>
          );
        })}
        {warnings.length > 3 ? (
          <div style={{ color: C.muted, fontSize: 11 }}>
            และอีก {warnings.length - 3} จุด กดแก้ไขหรือเปิดผู้เช่า/ห้องที่เกี่ยวข้องเพื่อตรวจต่อ
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <PageContainer>
      <PageHeader title="สัญญา" subtitle={`${counts.all} ฉบับในระบบ`}
        actions={
          <Btn variant="primary" onClick={() => setQuickCreating(true)}>
            + สร้างสัญญา · ส่งลิงก์ให้ผู้เช่ากรอก
          </Btn>
        }
      />
      <Card>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
          gap: 8,
          marginBottom: 12,
        }}>
          {[
            { label: 'พร้อมใช้งาน', value: counts.ready, tone: 'success' },
            { label: 'ต้องแก้', value: counts.errors, tone: 'danger' },
            { label: 'ต้องตรวจ', value: counts.warnings, tone: 'warning' },
            { label: 'รอผู้เช่าส่ง', value: counts.pending, tone: 'info' },
            { label: 'รอแอดมินตรวจ', value: counts.submitted, tone: 'warning' },
            { label: 'ใกล้หมดอายุ', value: counts.expiring, tone: 'warning' },
          ].map((m) => {
            const palette = m.tone === 'danger'
              ? { bg: C.dangerSoft || '#fee2e2', fg: C.danger || '#b91c1c', border: C.danger || '#b91c1c' }
              : m.tone === 'warning'
                ? { bg: C.warningSoft || '#fff7ed', fg: C.warningInk || '#92400e', border: C.warning || '#d97706' }
                : m.tone === 'info'
                  ? { bg: C.infoSoft || '#e0f2fe', fg: C.infoInk || '#075985', border: C.info || '#0284c7' }
                  : { bg: C.successSoft || '#dcfce7', fg: C.success || '#15803d', border: C.success || '#15803d' };
            return (
              <div key={m.label} style={{
                padding: 10,
                borderRadius: 8,
                border: `1px solid ${palette.border}33`,
                background: palette.bg,
                minHeight: 58,
              }}>
                <div style={{ fontSize: 11, color: palette.fg, fontWeight: 700 }}>{m.label}</div>
                <div style={{ fontSize: 22, lineHeight: 1.2, color: C.ink, fontWeight: 800 }}>{m.value}</div>
              </div>
            );
          })}
        </div>
        {contractIssueBuckets.length ? (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 8,
            marginBottom: 12,
          }}>
            {contractIssueBuckets.slice(0, 4).map((b) => (
              <div key={b.domain} style={{
                padding: 10,
                borderRadius: 8,
                border: `1px solid ${(b.tone === 'danger' ? C.danger : C.warning) || '#d97706'}33`,
                background: b.tone === 'danger' ? (C.dangerSoft || '#fee2e2') : (C.warningSoft || '#fff7ed'),
                color: C.ink2,
                fontSize: 12,
                lineHeight: 1.45,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                  <b>{b.domain}</b>
                  <span style={{ color: b.tone === 'danger' ? (C.danger || '#b91c1c') : (C.warningInk || '#92400e'), fontWeight: 700 }}>
                    {b.count} จุด
                  </span>
                </div>
                <div style={{ color: C.muted }}>{b.examples.join(' · ')}</div>
                {b.fix ? <div style={{ marginTop: 4 }}>ต้องทำ: {b.fix}</div> : null}
              </div>
            ))}
          </div>
        ) : null}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {[
            { key: 'active',  label: `มีผล (${counts.active})` },
            { key: 'review',  label: `ต้องตรวจ (${counts.warnings})` },
            { key: 'expired', label: `หมดอายุ (${counts.expired})` },
            { key: 'ended',   label: `สิ้นสุด (${counts.ended})` },
            { key: 'all',     label: `ทั้งหมด (${counts.all})` },
          ].map((t) => (
            <FilterChip
              key={t.key}
              label={t.label}
              active={filter === t.key}
              onClick={() => setFilter(t.key)}
            />
          ))}
          <input type="search" placeholder="ค้นหา ชื่อ/เบอร์/เลขสัญญา/ห้อง"
            value={search} onChange={(e) => setSearch(e.target.value)}
            style={{
              flex: 1, minWidth: 200, padding: '8px 12px',
              border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13,
            }} />
        </div>
        {counts.expiring > 0 && filter === 'active' ? (
          <div style={{
            marginTop: 12, padding: 10, background: C.warningSoft,
            border: '1px solid #f1b32d', borderRadius: 8,
            fontSize: 13, color: C.ink2,
          }}>
            ⏰ <b>{counts.expiring}</b> สัญญาจะหมดอายุภายใน 30 วัน — กดปุ่ม
            "🔄 ต่อสัญญา" ท้ายแถวเพื่อสร้างสัญญาใหม่จากเงื่อนไขเดิม + ส่งลิงก์ให้ผู้เช่าได้เลย
          </div>
        ) : null}
        {counts.warnings > 0 ? (
          <div style={{
            marginTop: 12, padding: 10, background: C.warningSoft,
            border: '1px solid #f1b32d', borderRadius: 8,
            fontSize: 13, color: C.warningInk || C.ink2,
          }}>
            <b>ต้องตรวจ {counts.warnings} สัญญา</b> — มี {counts.errors} ฉบับที่ควรแก้ก่อน lock/ออกบิล/อนุมัติ และสามารถกดแท็บ “ต้องตรวจ” เพื่อดูเฉพาะรายการเสี่ยง
          </div>
        ) : null}
      </Card>

      <Card style={{ padding: 0, marginTop: 12, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 20 }}>
            {window.SkeletonRows ? <window.SkeletonRows count={5} lineHeight={36} /> : <div style={{ padding: 30, textAlign: 'center', color: C.muted }}>กำลังโหลด…</div>}
          </div>
        ) : filtered.length === 0 ? (
          window.EmptyState ? (
            <window.EmptyState icon="📜" title="ไม่มีสัญญาในมุมมองนี้"
              description='สร้างสัญญาใหม่ได้จากปุ่ม "+ สร้างสัญญา" ด้านบน หรือจากการจองที่อนุมัติแล้ว' />
          ) : (
            <div style={{ padding: 30, textAlign: 'center', color: C.muted }}>ไม่มีสัญญา</div>
          )
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: C.surfaceAlt }}>
                <tr>
                  <th style={th}>เลขสัญญา</th>
                  <th style={th}>ผู้เช่า</th>
                  <th style={th}>ห้อง</th>
                  <th style={th}>เริ่ม</th>
                  <th style={th}>สิ้นสุด</th>
                  <th style={{ ...th, textAlign: 'right' }}>ค่าเช่า/เดือน</th>
                  <th style={{ ...th, textAlign: 'right' }}>ส่วนลด</th>
                  <th style={th}>สถานะ</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => {
                  const readiness = contractReadiness(c);
                  return (
                  <tr key={c.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td style={td}>{c.contract_no}</td>
                    <td style={td}>
                      {/* Cross-link: jump straight to this tenant's drawer
                          (tenants page routes by tenantId/room) instead of
                          re-searching there by hand. */}
                      {c.tenant_id ? (
                        <a href={`#tenants?tenantId=${encodeURIComponent(c.tenant_id)}`}
                          title="เปิดหน้าผู้เช่ารายนี้"
                          style={{ textDecoration: 'none', color: 'inherit' }}>
                          <div style={{ fontWeight: 500, color: C.accent }}>{c.tenant_name || '-'} →</div>
                        </a>
                      ) : (
                        <div style={{ fontWeight: 500 }}>{c.tenant_name || '-'}</div>
                      )}
                      <div style={{ color: C.muted, fontSize: 11 }}>{c.tenant_phone || '-'}</div>
                    </td>
                    <td style={td}>
                      {c.room_id ? (
                        <a href={`#rooms?room=${encodeURIComponent(c.room_id)}`}
                          title="เปิดห้องนี้ในหน้าห้องพัก"
                          style={{ textDecoration: 'none', color: C.accent }}>
                          {c.room_id} →
                        </a>
                      ) : '-'}
                    </td>
                    <td style={td}>{fmtDate(c.start_date)}</td>
                    <td style={td}>
                      {fmtDate(c.end_date)}
                      {c.status === 'active' && c.days_left != null && c.days_left <= 30 && c.days_left >= 0 ? (
                        <div style={{ fontSize: 11, color: C.accent }}>
                          เหลือ {c.days_left} วัน
                        </div>
                      ) : null}
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>
                      ฿{fmtCurrency(c.monthly_rent)}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      {Number(c.discount_pct) > 0 ? (
                        <span style={{ color: C.accent, fontWeight: 600 }}>
                          -{Number(c.discount_pct).toFixed(1)}%
                        </span>
                      ) : <span style={{ color: C.muted }}>-</span>}
                    </td>
                    <td style={td}>
                      <Pill color={STATUS_PILL[c.status] || 'gray'}>{STATUS_TH[c.status] || c.status}</Pill>
                      <div style={{ marginTop: 4 }}>
                        <Pill color={readiness.color}>{readiness.label}</Pill>
                      </div>
                      {c.locked_at ? (
                        <div style={{ marginTop: 4 }}>
                          <Pill color="warning">🔒 LOCKED</Pill>
                        </div>
                      ) : null}
                      {/* Deposit settlement state for closed contracts — recorded
                          only via the checkout flow, so an ended contract with
                          deposit_returned=null means the refund was never logged. */}
                      {c.status !== 'active' && Number(c.deposit) > 0 ? (
                        c.deposit_returned != null ? (
                          <div style={{ marginTop: 4, fontSize: 11, color: C.success || '#2e7d32' }}>
                            คืนมัดจำแล้ว ฿{fmtCurrency(c.deposit_returned)}
                          </div>
                        ) : (
                          <div style={{ marginTop: 4, fontSize: 11, color: C.warningInk || '#9a6b00' }}>
                            ยังไม่บันทึกคืนมัดจำ (฿{fmtCurrency(c.deposit)})
                          </div>
                        )
                      ) : null}
                      {c.active_invitation_status === 'pending' ? (
                        <div style={{ marginTop: 4 }}>
                          <Pill color="info">📨 ลิงก์รอผู้เช่ากรอก</Pill>
                        </div>
                      ) : c.active_invitation_status === 'submitted' ? (
                        <div style={{ marginTop: 4 }}>
                          <a href={c.active_invitation_id
                            ? `#contract-invitations?open=${encodeURIComponent(c.active_invitation_id)}`
                            : '#contract-invitations'}
                            style={{ display: 'inline-block', textDecoration: 'none' }}>
                            <Pill color="warning">✓ รอตรวจสอบ →</Pill>
                          </a>
                        </div>
                      ) : null}
                      <ContractWarningStack contract={c} />
                    </td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      {(c.status === 'expired'
                        || (c.status === 'active' && c.days_left != null && c.days_left <= 60)) ? (
                        <Btn size="sm" variant="soft" onClick={() => setRenewing(c)}
                          title="สร้างสัญญาใหม่จากเงื่อนไขเดิม + ส่งลิงก์ให้ผู้เช่ายืนยัน">🔄 ต่อสัญญา</Btn>
                      ) : null}
                      <Btn size="sm" variant="ghost" onClick={() => openPdf(c)}
                        title="ดู PDF (ใช้ template ที่ผูกไว้ หรือ default)">📄 PDF</Btn>
                      <Btn size="sm" variant="ghost" onClick={() => openPdf(c, { download: 1 })}
                        title="ดาวน์โหลด PDF เพื่อ print">⬇</Btn>
                      {c.status === 'active' && !c.signed_at && !c.locked_at ? (
                        <Btn size="sm" variant="ghost" onClick={() => setSigning(c)}
                          title="ลงนามออนไลน์">✍️ เซ็น</Btn>
                      ) : null}
                      <Btn size="sm" variant="ghost" onClick={() => setAssigning(c)}
                        title="เลือก template สำหรับสัญญานี้">🎨</Btn>
                      {c.status === 'active' && !c.locked_at ? (
                        <Btn size="sm" variant="ghost" onClick={() => setInviting(c)}
                          title="ส่งลิงก์ให้ผู้เช่ากรอกสัญญาเอง">📨</Btn>
                      ) : null}
                      {c.status === 'active' && c.locked_at ? (
                        <Btn size="sm" variant="ghost" disabled={true}
                          title={contractIdentityGap(c)
                            ? `ส่งลิงก์ไม่ได้: สัญญา lock แล้วและยังขาด ${contractIdentityGap(c).join(', ')} — เปิดผู้เช่า → แท็บสัญญา → ปุ่ม "เติมข้อมูล/อัปโหลดเอกสาร" เพื่อบันทึกย้อนหลัง`
                            : 'ส่งลิงก์ไม่ได้: สัญญา lock แล้ว — ลิงก์กรอกใช้ได้เฉพาะก่อน approve/lock ถ้าต้องแก้ข้อมูลให้ทำสัญญาฉบับใหม่/ต่อสัญญา'}>
                          🔒 ส่งลิงก์ไม่ได้
                        </Btn>
                      ) : null}
                      <Btn size="sm" variant="ghost" onClick={() => setEditing(c)}>แก้ไข</Btn>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing ? (
        <ContractEditModal
          contract={editing}
          onClose={() => setEditing(null)}
          onSaved={(c, effects) => {
            setEditing(null);
            if (effects && typeof effects === 'object') {
              // Contract was CLOSED — report the cascade's actual outcome so
              // "tenant still active" can never hide behind a success toast.
              const warns = Array.isArray(effects.warnings)
                ? effects.warnings.map((w) => w && w.message).filter(Boolean) : [];
              setToast && setToast({
                kind: warns.length ? 'warning' : 'success',
                message: {
                  title: `ปิดสัญญา ${c.contract_no} แล้ว`,
                  description: [
                    effects.tenantMovedOut
                      ? 'ผู้เช่าถูกตั้งเป็น "ย้ายออก" แล้ว'
                      : 'ผู้เช่ายังคงสถานะเดิม (ไม่ได้ย้ายออกอัตโนมัติ)',
                    effects.roomFreed ? 'ปล่อยห้องเป็นว่างแล้ว' : null,
                    effects.invitationsRevoked > 0 ? `ยกเลิกลิงก์ค้าง ${effects.invitationsRevoked} ลิงก์` : null,
                    ...warns,
                  ].filter(Boolean).join('\n'),
                },
              });
            } else {
              setToast && setToast({ kind: 'success', message: `บันทึก ${c.contract_no} แล้ว` });
            }
            addActivity && addActivity({ icon: '📜', text: `แก้ไขสัญญา ${c.contract_no}`, type: 'system' });
            refresh();
          }}
          onError={(msg) => setToast && setToast({ kind: 'danger', message: msg })}
        />
      ) : null}

      {signing ? (
        <SignContractModal
          contract={signing}
          onClose={() => setSigning(null)}
          onSaved={(c) => {
            setSigning(null);
            setToast && setToast({ kind: 'success',
              message: `ลงนามสัญญา ${signing.contract_no} เรียบร้อย` });
            addActivity && addActivity({ icon: '✍️',
              text: `ลงนามสัญญา ${signing.contract_no}`, type: 'system' });
            refresh();
          }}
          onError={(msg) => setToast && setToast({ kind: 'danger', message: msg })}
        />
      ) : null}

      {assigning ? (
        <AssignTemplateModal
          contract={assigning}
          templates={templates}
          onClose={() => setAssigning(null)}
          onSaved={() => {
            setAssigning(null);
            setToast && setToast({ kind: 'success',
              message: `ผูก template เข้ากับ ${assigning.contract_no} แล้ว` });
            refresh();
          }}
          onError={(msg) => setToast && setToast({ kind: 'danger', message: msg })}
          onPreview={(tid) => openPdf(assigning, { templateId: tid })}
        />
      ) : null}

      {quickCreating ? (
        <QuickInviteModal
          rooms={rooms}
          config={config}
          onClose={() => setQuickCreating(false)}
          onSaved={(payload) => {
            setQuickCreating(false);
            setToast && setToast({ kind: 'success',
              message: `สร้างสัญญา ${payload.contract.contract_no} + ส่งลิงก์เรียบร้อย` });
            addActivity && addActivity({ icon: '✨',
              text: `สร้างสัญญา + ส่งลิงก์ให้ ${payload.tenant.fullName}`,
              type: 'system' });
            refresh();
          }}
          onError={(msg) => setToast && setToast({ kind: 'danger', message: msg })}
        />
      ) : null}

      {renewing ? (
        <QuickInviteModal
          rooms={rooms}
          config={config}
          renewFrom={renewing}
          onClose={() => setRenewing(null)}
          onSaved={(payload) => {
            const oldNo = renewing.contract_no;
            setRenewing(null);
            setToast && setToast({ kind: 'success',
              message: {
                title: `ต่อสัญญาเรียบร้อย — สัญญาใหม่ ${payload.contract.contract_no}`,
                description: 'ส่งลิงก์ให้ผู้เช่ายืนยัน+เซ็นแล้ว เมื่อผู้เช่าส่งกลับ ตรวจและอนุมัติได้ที่ "ใบเชิญผู้เช่ากรอก" — สัญญาเดิมจะสิ้นสุดตามกำหนดเดิม',
              } });
            addActivity && addActivity({ icon: '🔄',
              text: `ต่อสัญญา ${oldNo} → ${payload.contract.contract_no}`,
              type: 'system' });
            refresh();
          }}
          onError={(msg) => setToast && setToast({ kind: 'danger', message: msg })}
        />
      ) : null}

      {inviting ? (
        <InviteTenantModal
          contract={inviting}
          onClose={() => setInviting(null)}
          onSaved={() => {
            setInviting(null);
            setToast && setToast({ kind: 'success',
              message: `สร้างลิงก์สำหรับ ${inviting.contract_no} เรียบร้อย` });
            addActivity && addActivity({ icon: '📨',
              text: `ส่งลิงก์ให้ผู้เช่ากรอก ${inviting.contract_no}`, type: 'system' });
            refresh();
          }}
          onError={(msg) => setToast && setToast({ kind: 'danger', message: msg })}
        />
      ) : null}
    </PageContainer>
  );
}

// === Invite tenant to self-fill modal =====================================
// Generates a tokenised URL on the server, displays it ONCE for admin to
// copy/share. Token is never re-shown after this modal closes — admin must
// generate a fresh one if they lose it.
function inviteDeliverySummary(delivery) {
  if (!delivery) return 'ยังไม่ได้ตรวจสถานะการส่งอัตโนมัติ';
  if (delivery.ok) {
    const channel = delivery.channel === 'line' ? 'LINE'
      : delivery.channel === 'email' ? 'อีเมล'
      : delivery.channel === 'sms' ? 'SMS'
      : delivery.channel || 'ช่องทางแจ้งเตือน';
    return `ส่งลิงก์ให้ผู้เช่าแล้วทาง ${channel}`;
  }
  if (delivery.queued) return 'ส่งไม่สำเร็จทันที แต่เข้าคิวแจ้งเตือนให้ retry แล้ว';
  const reason = delivery.reason || delivery.error || 'ไม่มี LINE/อีเมล/SMS ที่พร้อมส่ง';
  return `ยังไม่ได้ส่งอัตโนมัติ: ${reason} — ให้ก๊อปลิงก์ด้านล่างส่งเอง`;
}

function inviteErrorMessage(prefix, err) {
  const raw = err && err.raw ? err.raw : {};
  const humanize = window.humanizeAdminErrorText || ((text) => String(text || ''));
  const parts = [];
  const main = raw.error || (err && err.message) || '';
  if (main) parts.push(humanize(main));
  if (raw.hint) parts.push(raw.hint);
  if (raw.reconcileUrl) parts.push(`แก้ไขได้ที่ ${raw.reconcileUrl}`);
  if (raw.nextActions && typeof raw.nextActions === 'object') {
    if (raw.nextActions.hint) parts.push(raw.nextActions.hint);
    Object.entries(raw.nextActions)
      .filter(([key, value]) => /Url$/.test(key) && typeof value === 'string' && value)
      .slice(0, 3)
      .forEach(([key, value]) => parts.push(`${key}: ${value}`));
  }
  return {
    title: prefix,
    description: Array.from(new Set(parts.filter(Boolean))).join('\n') || 'กรุณารีเฟรชข้อมูลแล้วลองใหม่อีกครั้ง',
  };
}

function InviteTenantModal({ contract, onClose, onSaved, onError }) {
  const C = window.ADMIN_C;
  const { Modal, Btn } = window;
  const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
  const [hours, setHours] = useState(168);   // 7 days default
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);

  const generate = async () => {
    if (contract.locked_at) {
      onError && onError({
        title: 'สร้างลิงก์ไม่ได้ — สัญญาถูก lock แล้ว',
        description: 'ลิงก์กรอกสัญญาใช้เฉพาะก่อน approve/lock เท่านั้น ถ้าต้องเก็บข้อมูลผู้เช่าย้อนหลังให้เติมในข้อมูลผู้เช่า หรือสร้าง/ต่อสัญญาฉบับใหม่แล้วส่งลิงก์ก่อน lock',
      });
      return;
    }
    setBusy(true);
    try {
      const d = await apiCall(`/api/contracts/${contract.id}/invite-tenant`, {
        method: 'POST',
        body: JSON.stringify({ expiresInHours: hours }),
      });
      setResult(d);
    } catch (err) {
      onError && onError(inviteErrorMessage('สร้าง/ส่งลิงก์ล้มเหลว', err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!result || !result.invitation || !result.invitation.url) return;
    try {
      await navigator.clipboard.writeText(result.invitation.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select-and-copy via temp input
      const t = document.createElement('input');
      t.value = result.invitation.url;
      document.body.appendChild(t);
      t.select();
      document.execCommand('copy');
      document.body.removeChild(t);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <Modal
      open={true}
      onClose={() => { if (result) onSaved(); else onClose(); }}
      width={620}
      title={`ส่งลิงก์ให้ผู้เช่ากรอก — ${contract.contract_no}`}
      footer={
        result ? (
          <Btn variant="primary" onClick={onSaved}>เสร็จสิ้น</Btn>
        ) : (
          <>
            <Btn variant="ghost" onClick={onClose} disabled={busy}>ยกเลิก</Btn>
            <Btn variant="primary" onClick={generate} disabled={busy}>
              {busy ? 'กำลังสร้าง…' : 'สร้างลิงก์'}
            </Btn>
          </>
        )
      }
    >
      {!result ? (
        <div>
          <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6, marginBottom: 16 }}>
            ระบบจะสร้างลิงก์เฉพาะตัวสำหรับผู้เช่า — เปิดได้โดยไม่ต้องล็อกอิน<br/>
            ผู้เช่ากรอกที่อยู่ ผู้ติดต่อฉุกเฉิน ถ่ายภาพบัตรประชาชน และเซ็นในหน้านั้นเลย<br/>
            หลังจากคุณกดอนุมัติ ลิงก์นี้จะใช้ไม่ได้อีกต่อไป
          </div>
          <div style={{
            padding: 12, background: C.warningSoft, border: '1px solid #f1b32d',
            borderRadius: 8, fontSize: 13, color: C.warningInk, marginBottom: 16,
          }}>
            ⚠️ ลิงก์เก่าที่ยังไม่ได้อนุมัติจะถูกยกเลิกอัตโนมัติเมื่อคุณสร้างลิงก์ใหม่
          </div>
          <label style={lbl}>อายุของลิงก์</label>
          <select style={inp} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            <option value={24}>24 ชั่วโมง (1 วัน)</option>
            <option value={72}>72 ชั่วโมง (3 วัน)</option>
            <option value={168}>168 ชั่วโมง (7 วัน) — แนะนำ</option>
            <option value={336}>336 ชั่วโมง (14 วัน)</option>
            <option value={720}>720 ชั่วโมง (30 วัน)</option>
          </select>
        </div>
      ) : (
        <div>
          <div style={{ padding: 12, background: C.successSoft, border: '1px solid #4a8b4a',
                        borderRadius: 8, fontSize: 13, color: C.successInk, marginBottom: 16 }}>
            ✅ สร้างลิงก์เรียบร้อย — ส่งให้ผู้เช่าผ่าน LINE / SMS หรือก็อปแล้วส่งทางอื่นได้เลย
          </div>
          <label style={lbl}>ลิงก์สำหรับผู้เช่า</label>
          <div style={{
            padding: 10,
            background: result.delivery && result.delivery.ok ? C.successSoft : C.warningSoft,
            border: `1px solid ${result.delivery && result.delivery.ok ? '#4a8b4a' : '#f1b32d'}`,
            borderRadius: 8,
            fontSize: 12,
            color: result.delivery && result.delivery.ok ? C.successInk : C.warningInk,
            marginBottom: 12,
            lineHeight: 1.5,
          }}>
            {inviteDeliverySummary(result.delivery)}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input readOnly value={result.invitation.url} style={{ ...inp, fontFamily: 'monospace', fontSize: 11 }}
              onFocus={(e) => e.target.select()} />
            <Btn variant="primary" onClick={copy}>{copied ? '✓ ก็อปแล้ว' : 'ก็อป'}</Btn>
          </div>
          <div style={{ marginTop: 12, fontSize: 12, color: C.muted }}>
            อายุลิงก์: หมดอายุ {new Date(result.invitation.expiresAt).toLocaleString('th-TH', {
              year: 'numeric', month: 'short', day: 'numeric',
              hour: '2-digit', minute: '2-digit',
            })}
          </div>
          <div style={{ marginTop: 16, padding: 12, background: C.warningSoft,
                        border: '1px solid #f1b32d', borderRadius: 8,
                        fontSize: 12, color: C.warningInk, lineHeight: 1.6 }}>
            🔒 <b>ลิงก์นี้แสดงครั้งเดียว</b> — ปิดหน้าต่างแล้วจะดูซ้ำไม่ได้<br/>
            ตรวจสอบว่าได้ก็อปไว้แล้ว หรือส่งหาผู้เช่าทันที
          </div>
        </div>
      )}
    </Modal>
  );
}

// === Online signature modal ==============================================
// Admin draws / pastes / uploads a signature image; we POST to /sign which
// embeds it into the contract PDF. Three input modes:
//   1. Draw on canvas (touch/mouse)
//   2. Upload existing image file
//   3. (future) Send link to tenant to sign on their device
function SignContractModal({ contract, onClose, onSaved, onError }) {
  const C = window.ADMIN_C;
  const { Modal, Btn } = window;
  const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
  const canvasRef = React.useRef(null);
  const [mode, setMode] = useState('draw');   // 'draw' | 'upload'
  const [hasInk, setHasInk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadedDataUrl, setUploadedDataUrl] = useState(null);

  // Draw setup — vanilla 2D canvas, mouse + touch events. Aspect 3:1
  // matches typical signature box dimensions on the PDF.
  useEffect(() => {
    if (mode !== 'draw') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = 600;
    canvas.height = 200;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#1a1208';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    let drawing = false;
    let lastX = 0, lastY = 0;
    const pos = (e) => {
      const rect = canvas.getBoundingClientRect();
      const t = e.touches ? e.touches[0] : e;
      return {
        x: (t.clientX - rect.left) * (canvas.width / rect.width),
        y: (t.clientY - rect.top)  * (canvas.height / rect.height),
      };
    };
    const start = (e) => {
      e.preventDefault();
      drawing = true;
      const p = pos(e);
      lastX = p.x; lastY = p.y;
    };
    const move = (e) => {
      if (!drawing) return;
      e.preventDefault();
      const p = pos(e);
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      lastX = p.x; lastY = p.y;
      setHasInk(true);
    };
    const end = () => { drawing = false; };

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', end);
    canvas.addEventListener('mouseleave', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);
    return () => {
      canvas.removeEventListener('mousedown', start);
      canvas.removeEventListener('mousemove', move);
      canvas.removeEventListener('mouseup', end);
      canvas.removeEventListener('mouseleave', end);
      canvas.removeEventListener('touchstart', start);
      canvas.removeEventListener('touchmove', move);
      canvas.removeEventListener('touchend', end);
    };
  }, [mode]);

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
  };

  const onUpload = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (f.size > 1_500_000) {
      onError && onError('ไฟล์ใหญ่เกิน 1.5MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => setUploadedDataUrl(ev.target.result);
    reader.readAsDataURL(f);
  };

  const submit = async () => {
    setBusy(true);
    try {
      let dataUrl;
      if (mode === 'draw') {
        if (!hasInk) {
          onError && onError('กรุณาเซ็นชื่อก่อน');
          setBusy(false);
          return;
        }
        dataUrl = canvasRef.current.toDataURL('image/png');
      } else {
        if (!uploadedDataUrl) {
          onError && onError('กรุณาอัปโหลดไฟล์ก่อน');
          setBusy(false);
          return;
        }
        dataUrl = uploadedDataUrl;
      }
      const d = await apiCall(`/api/contracts/${contract.id}/sign`, {
        method: 'POST',
        body: JSON.stringify({ signatureDataUrl: dataUrl }),
      });
      onSaved && onSaved(d.contract);
    } catch (err) {
      onError && onError(inviteErrorMessage('ลงนามล้มเหลว', err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={true}
      onClose={onClose}
      width={680}
      title={`ลงนามสัญญา ${contract.contract_no}`}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={busy}>ยกเลิก</Btn>
          {mode === 'draw' ? (
            <Btn variant="ghost" onClick={clearCanvas} disabled={busy || !hasInk}>ล้าง</Btn>
          ) : null}
          <Btn variant="primary" onClick={submit} disabled={busy}>
            {busy ? 'กำลังบันทึก…' : 'บันทึกลายเซ็น'}
          </Btn>
        </>
      }
    >
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
        ผู้เช่า: <b>{contract.tenant_name || '-'}</b> · ห้อง <b>{contract.room_id || '-'}</b><br/>
        ลายเซ็นจะถูกฝังลงใน PDF อัตโนมัติ — ตรวจ PDF อีกครั้งก่อนพิมพ์
      </div>

      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}`, marginBottom: 12 }}>
        {[
          { k: 'draw',   label: '✍️ เซ็นด้วยเมาส์/ทัช' },
          { k: 'upload', label: '📤 อัปโหลดรูปลายเซ็น' },
        ].map((m) => (
          <button key={m.k} onClick={() => setMode(m.k)}
            style={{
              padding: '8px 14px', border: 'none',
              borderBottom: `2px solid ${mode === m.k ? C.accent : 'transparent'}`,
              background: 'transparent', cursor: 'pointer',
              fontSize: 13, fontFamily: 'inherit',
              color: mode === m.k ? C.ink : C.muted,
              fontWeight: mode === m.k ? 600 : 400,
            }}>{m.label}</button>
        ))}
      </div>

      {mode === 'draw' ? (
        <div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>
            ลากเส้นในช่องเพื่อเซ็นชื่อ
          </div>
          <canvas ref={canvasRef}
            style={{
              width: '100%', maxWidth: 600,
              // aspectRatio 3/1 makes signing on phone (320px wide → 107px
              // tall) basically impossible. Floor the height at 160px so
              // narrow screens still have legible signing room.
              aspectRatio: '3/1', minHeight: 160,
              background: '#fff', border: `2px dashed ${C.border}`,
              borderRadius: 6, cursor: 'crosshair', touchAction: 'none',
            }} />
        </div>
      ) : (
        <div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>
            อัปโหลดภาพลายเซ็น (JPG/PNG/WEBP, ไม่เกิน 1.5MB)
          </div>
          <input type="file" accept="image/jpeg,image/png,image/webp"
            onChange={onUpload}
            style={{ marginBottom: 8 }} />
          {uploadedDataUrl ? (
            <div style={{ marginTop: 8 }}>
              <img src={uploadedDataUrl} alt="signature preview"
                style={{ maxWidth: '100%', maxHeight: 200, border: `1px solid ${C.border}`, borderRadius: 6 }} />
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

// === Assign template to contract ==========================================
function AssignTemplateModal({ contract, templates, onClose, onSaved, onError, onPreview }) {
  const C = window.ADMIN_C;
  const { Modal, Btn } = window;
  const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
  const [tid, setTid] = useState(contract.template_id || '');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await apiCall(`/api/contracts/${contract.id}/template`, {
        method: 'POST',
        body: JSON.stringify({ templateId: tid ? Number(tid) : null }),
      });
      onSaved && onSaved();
    } catch (err) {
      onError && onError(inviteErrorMessage('บันทึกล้มเหลว', err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={`เลือก template สำหรับ ${contract.contract_no}`}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={busy}>ยกเลิก</Btn>
          <Btn variant="primary" onClick={submit} disabled={busy}>
            {busy ? '…' : 'บันทึก'}
          </Btn>
        </>
      }
    >
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
        เลือก template สำหรับสัญญาฉบับนี้ — ถ้าไม่ตั้งจะใช้ template default ของระบบ
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label style={{
          display: 'flex', gap: 10, alignItems: 'flex-start', padding: 10,
          border: `1px solid ${tid === '' ? C.accent : C.border}`,
          borderRadius: 6, cursor: 'pointer',
          background: tid === '' ? C.surfaceAlt : 'transparent',
        }}>
          <input type="radio" checked={tid === ''} onChange={() => setTid('')}
            style={{ marginTop: 2 }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>ใช้ default ของระบบ</div>
            <div style={{ fontSize: 11, color: C.muted }}>
              เปลี่ยน default ที่ "เทมเพลตสัญญา" — สัญญาฉบับนี้จะใช้ตามเสมอ
            </div>
          </div>
        </label>
        {templates.map((t) => (
          <label key={t.id} style={{
            display: 'flex', gap: 10, alignItems: 'flex-start', padding: 10,
            border: `1px solid ${tid === String(t.id) || tid === t.id ? C.accent : C.border}`,
            borderRadius: 6, cursor: 'pointer',
            background: tid === String(t.id) || tid === t.id ? C.surfaceAlt : 'transparent',
          }}>
            <input type="radio" checked={tid === String(t.id) || tid === t.id}
              onChange={() => setTid(String(t.id))}
              style={{ marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>
                {t.name}
                {t.is_default ? <span style={{ marginLeft: 6, fontSize: 10, color: C.warning }}>⭐</span> : null}
              </div>
              {t.description ? (
                <div style={{ fontSize: 11, color: C.muted }}>{t.description}</div>
              ) : null}
            </div>
            <Btn size="sm" variant="ghost"
              onClick={(e) => { e.preventDefault(); onPreview && onPreview(t.id); }}
              title="ดู PDF preview">👁</Btn>
          </label>
        ))}
      </div>
    </Modal>
  );
}

function ContractEditModal({ contract, onClose, onSaved, onError }) {
  const C = window.ADMIN_C;
  const { Modal, Btn, Input, Select } = window;
  const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
  const addContractMonths = window.addContractMonths || (() => '');
  const estimateContractMonths = window.estimateContractMonths || (() => null);
  const contractDateSummary = window.contractDateSummary || (() => '');
  const isLocked = !!contract.locked_at;
  const contractStartDate = contract.start_date ? String(contract.start_date).slice(0, 10) : '';
  const closeTypes = [
    { value: 'early_move_out', label: 'ผู้เช่าออกก่อนกำหนด' },
    { value: 'mutual_cancel', label: 'ยกเลิกตามตกลง' },
    { value: 'no_show', label: 'ยกเลิกก่อนเข้าอยู่ / no-show' },
    { value: 'natural_expiry', label: 'หมดอายุตามกำหนด' },
    { value: 'admin_correction', label: 'แก้ไขข้อมูลย้อนหลัง' },
  ];
  const original = {
    discountPct: Number(contract.discount_pct ?? 0),
    termMonths: contract.term_months == null ? null : Number(contract.term_months),
    endDate: contract.end_date ? String(contract.end_date).slice(0, 10) : null,
    status: contract.status || 'active',
  };
  const [form, setForm] = useState({
    discountPct: contract.discount_pct != null ? String(contract.discount_pct) : '0',
    termMonths:  contract.term_months  != null ? String(contract.term_months)  : '',
    endDate:     contract.end_date ? String(contract.end_date).slice(0, 10) : '',
    status:      contract.status || 'active',
    closeType:   'early_move_out',
    closeReason: '',
  });
  const [busy, setBusy] = useState(false);
  const formPct = Number(form.discountPct);
  const formTerm = form.termMonths === '' ? null : Number(form.termMonths);
  const formEndDate = form.endDate || null;
  const materialChanged = (Number.isFinite(formPct) && formPct !== original.discountPct)
    || formTerm !== original.termMonths
    || formEndDate !== original.endDate;
  const statusChanged = form.status !== original.status;
  const lifecycleClosed = original.status !== 'active';
  const closingRequested = original.status === 'active' && ['ended', 'expired'].includes(form.status);
  const closeReasonReady = !closingRequested || form.closeReason.trim().length >= 5;
  const materialDisabled = isLocked || busy || lifecycleClosed || closingRequested;
  const termValid = form.termMonths === ''
    || (Number.isInteger(Number(form.termMonths)) && Number(form.termMonths) >= 1 && Number(form.termMonths) <= 120);
  const maxContractEndDate = contractStartDate ? addContractMonths(contractStartDate, 120) : '';
  const dateRangeValid = !form.endDate || !contractStartDate
    || (form.endDate >= contractStartDate && (!maxContractEndDate || form.endDate <= maxContractEndDate));
  const dateErrorText = form.endDate && contractStartDate && form.endDate < contractStartDate
    ? 'วันสิ้นสุดต้องไม่ก่อนวันเริ่มสัญญา'
    : (form.endDate && maxContractEndDate && form.endDate > maxContractEndDate
      ? 'วันสิ้นสุดต้องไม่เกิน 120 เดือนจากวันเริ่มสัญญา'
      : 'วันที่สัญญาไม่ถูกต้อง');
  const canSave = !lifecycleClosed && closeReasonReady
    && termValid && dateRangeValid
    && (statusChanged || (!isLocked && !closingRequested && materialChanged));

  const setContractTermMonths = (value) => {
    setForm((f) => {
      const computedEnd = value && contractStartDate
        ? addContractMonths(contractStartDate, Number(value))
        : '';
      return {
        ...f,
        termMonths: value,
        endDate: computedEnd || (value ? f.endDate : ''),
      };
    });
  };
  const setContractEndDate = (value) => {
    setForm((f) => {
      const estimated = value && contractStartDate
        ? estimateContractMonths(contractStartDate, value, 120)
        : null;
      return {
        ...f,
        endDate: value,
        termMonths: estimated ? String(estimated) : '',
      };
    });
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (!termValid) {
        onError && onError('ระยะสัญญาต้องเป็นจำนวนเต็ม 1-120 เดือน หรือเว้นว่างสำหรับสัญญาไม่จำกัดเวลา');
        return;
      }
      if (!dateRangeValid) {
        onError && onError(dateErrorText);
        return;
      }
      const payload = {};
      if (!isLocked && !closingRequested) {
        const pct = Number(form.discountPct);
        if (Number.isFinite(pct) && pct !== original.discountPct) payload.discountPct = pct;
        const term = form.termMonths === '' ? null : Number(form.termMonths);
        if (term !== original.termMonths) payload.termMonths = term;
        const endDate = form.endDate || null;
        if (endDate !== original.endDate) payload.endDate = endDate;
      }
      if (form.status !== original.status) payload.status = form.status;
      if (closingRequested) {
        const closeReason = form.closeReason.trim();
        if (closeReason.length < 5) {
          onError && onError('กรุณาระบุเหตุผลการปิดสัญญาอย่างน้อย 5 ตัวอักษร');
          return;
        }
        payload.closeType = form.closeType;
        payload.closeReason = closeReason;
      }
      if (!Object.keys(payload).length) {
        onError && onError('ไม่มีข้อมูลที่เปลี่ยนแปลง');
        return;
      }
      const d = await apiCall(`/api/contracts/${contract.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      // Pass the close-cascade effects through — the page toast must report
      // what ACTUALLY happened (tenant moved out or not, warnings), not a
      // blanket promise.
      onSaved && onSaved(d.contract, d.effects || null);
    } catch (err) {
      onError && onError(inviteErrorMessage('บันทึกล้มเหลว', err));
    } finally { setBusy(false); }
  };

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={`แก้ไขสัญญา ${contract.contract_no}`}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={busy}>ยกเลิก</Btn>
          <Btn variant="primary" onClick={submit} disabled={busy || !canSave}>
            {busy ? '…' : 'บันทึก'}
          </Btn>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
          ผู้เช่า: <b>{contract.tenant_name || '-'}</b> · ห้อง <b>{contract.room_id || '-'}</b>
          <br />
          วันเริ่มสัญญา: <b>{contractStartDate ? window.fmtDateTH(contractStartDate) : '-'}</b>
          <br />
          ค่าเช่า/เดือน: ฿{Number(contract.monthly_rent).toLocaleString('th-TH', { minimumFractionDigits: 2 })}
        </div>
        {isLocked ? (
          <div style={{
            padding: 10, background: C.warningSoft, borderRadius: 6,
            fontSize: 12, color: C.warningInk || C.ink2, lineHeight: 1.5,
          }}>
            🔒 สัญญานี้ถูก lock แล้ว แก้ไขค่าเช่า ส่วนลด ระยะสัญญา หรือวันสิ้นสุดไม่ได้
            แต่ยังเปลี่ยนสถานะเป็น “สิ้นสุด” หรือ “หมดอายุ” เพื่อปิดสัญญาและปล่อยห้องได้
          </div>
        ) : null}
        {lifecycleClosed ? (
          <div style={{
            padding: 10, background: C.surfaceAlt, borderRadius: 6,
            fontSize: 12, color: C.muted, lineHeight: 1.5,
          }}>
            สัญญานี้ปิดแล้ว ระบบไม่อนุญาตให้เปิดกลับจากหน้านี้ เพราะจะทำให้ห้อง ผู้เช่า และบิลย้อนสถานะผิด ให้สร้างสัญญาใหม่หรือ check-in ใหม่แทน
          </div>
        ) : null}
        {closingRequested ? (
          <div style={{
            padding: 10, background: C.dangerSoft || '#fff5f4',
            border: '1px solid #f5c0b4', borderRadius: 6,
            fontSize: 12, color: C.dangerInk || '#8a2f2b', lineHeight: 1.5,
          }}>
            เมื่อบันทึก ระบบจะปิดสัญญา ตั้งวันสิ้นสุดเป็นวันนี้ถ้าไม่ได้ระบุไว้ ยกเลิกลิงก์สัญญาที่ยังค้าง
            และถ้าผู้เช่าถือห้องตามสัญญาอยู่ (หรือยังไม่เคยย้ายเข้าและไม่มีสัญญาอื่น) จะตั้งเป็นย้ายออก
            ปล่อยห้องว่าง และเพิกถอนสิทธิอัตโนมัติ — ผลที่เกิดขึ้นจริงจะสรุปให้หลังบันทึก
          </div>
        ) : null}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={lbl}>ส่วนลด (%) — สูงสุด 50</label>
            <input type="number" step="0.1" min="0" max="50" value={form.discountPct}
              onChange={(e) => setForm({ ...form, discountPct: e.target.value })}
              disabled={materialDisabled}
              style={inp} />
          </div>
          <div>
            <label style={lbl}>ระยะสัญญา (เดือน)</label>
            <input type="number" step="1" min="1" max="120" value={form.termMonths}
              onChange={(e) => setContractTermMonths(e.target.value)}
              disabled={materialDisabled}
              style={inp} placeholder="เปิด-ไม่จำกัด" />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={lbl}>วันสิ้นสุด</label>
            <input type="date" value={form.endDate}
              onChange={(e) => setContractEndDate(e.target.value)}
              disabled={materialDisabled}
              style={inp} />
          </div>
          <div>
            <label style={lbl}>สถานะ</label>
            <select value={form.status}
              onChange={(e) => setForm({
                ...form,
                status: e.target.value,
                closeType: e.target.value === 'expired' ? 'natural_expiry'
                  : (form.closeType === 'natural_expiry' ? 'early_move_out' : form.closeType),
              })}
              disabled={busy || lifecycleClosed}
              style={inp}>
              <option value="active">มีผล</option>
              <option value="expired">หมดอายุ</option>
              <option value="ended">สิ้นสุด</option>
            </select>
          </div>
        </div>
        {!closingRequested ? (
          <div style={{
            padding: 10,
            background: dateRangeValid ? C.infoSoft : C.dangerSoft,
            border: `1px solid ${dateRangeValid ? C.border : '#f5c0b4'}`,
            borderRadius: 6,
            fontSize: 12,
            color: dateRangeValid ? (C.infoInk || C.ink2) : (C.dangerInk || '#8a2f2b'),
            lineHeight: 1.5,
          }}>
            {dateRangeValid
              ? contractDateSummary(contractStartDate, form.termMonths, form.endDate)
              : `${dateErrorText} ระบบจะยังไม่ให้บันทึก`}
          </div>
        ) : null}
        {closingRequested ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={lbl}>ประเภทการปิดสัญญา</label>
              <select value={form.closeType}
                onChange={(e) => setForm({ ...form, closeType: e.target.value })}
                disabled={busy}
                style={inp}>
                {closeTypes.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={lbl}>เหตุผล (บังคับ)</label>
              <textarea rows={3} maxLength={500}
                value={form.closeReason}
                onChange={(e) => setForm({ ...form, closeReason: e.target.value })}
                disabled={busy}
                placeholder="เช่น ผู้เช่าออกก่อนกำหนด, ยกเลิกตามตกลง, ไม่เข้าอยู่"
                style={{ ...inp, minHeight: 76, resize: 'vertical' }} />
              <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
                เหตุผลนี้จะถูกบันทึกใน contract + audit log และใช้ในข้อความแจ้งเตือน
              </div>
            </div>
          </div>
        ) : null}
        <div style={{
          padding: 10, background: C.surfaceAlt, borderRadius: 6,
          fontSize: 12, color: C.muted, lineHeight: 1.5,
        }}>
          ℹ️ ส่วนลดที่ตั้งจะ apply กับ <b>ค่าเช่า</b> ของบิลรอบถัดไป (ไม่ลดค่าน้ำ-ค่าไฟ-ค่าอินเทอร์เน็ต)
        </div>
      </form>
    </Modal>
  );
}

// === Quick-create modal: build a contract draft + invitation in one shot =
// This is the entry point admin uses when they want the tenant to fill
// the contract themselves from scratch. The form collects ONLY what admin
// must know up-front (room, rent, deposit, dates) plus the tenant's name
// + phone so the link can be addressed correctly. Everything else (address,
// emergency contact, ID photos, signature) the TENANT fills via the link.
function QuickInviteModal({ rooms = {}, config, renewFrom = null, onClose, onSaved, onError }) {
  const C = window.ADMIN_C;
  const { Modal, Btn } = window;
  const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
  const resolveRoomRent = window.resolveRoomRent;
  const resolveRoomDeposit = window.resolveRoomDeposit;
  const contractTodayYmd = window.contractTodayYmd || (() => new Date().toISOString().slice(0, 10));
  const addContractMonths = window.addContractMonths || (() => '');
  const estimateContractMonths = window.estimateContractMonths || (() => null);
  const contractDateSummary = window.contractDateSummary || (() => '');
  // Renewal mode: continue an existing contract — same tenant/room/terms,
  // start = the day after the old end_date (or today when that's already
  // past, so the server's move-in window check doesn't reject it).
  const renewStartDate = (c) => {
    const today = contractTodayYmd();
    const end = String((c && c.end_date) || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return today;
    const d = new Date(end + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    const next = d.toISOString().slice(0, 10);
    return next > today ? next : today;
  };
  const initialStartDate = renewFrom ? renewStartDate(renewFrom) : contractTodayYmd();
  const initialTermMonths = renewFrom
    ? String(Number(renewFrom.term_months) > 0 ? Number(renewFrom.term_months) : 12)
    : '12';
  const roomList = useMemo(() => Object.values(rooms || {})
    .filter(Boolean)
    .sort((a, b) => String(a.id || '').localeCompare(String(b.id || ''), undefined, {
      numeric: true,
      sensitivity: 'base',
    })), [rooms]);
  const availableRooms = useMemo(() => roomList.filter((r) =>
    String(r.status || 'vacant') === 'vacant' && !r.tenant
  ), [roomList]);
  const hasRoomInventory = roomList.length > 0;
  const [form, setForm] = useState({
    tenantName: renewFrom ? String(renewFrom.tenant_name || '') : '',
    tenantPhone: renewFrom ? String(renewFrom.tenant_phone || '') : '',
    tenantEmail: '',
    roomId: renewFrom ? String(renewFrom.room_id || '') : '',
    monthlyRent: renewFrom && Number(renewFrom.monthly_rent) > 0
      ? String(Number(renewFrom.monthly_rent)) : '',
    deposit: renewFrom && Number(renewFrom.deposit) >= 0
      ? String(Number(renewFrom.deposit)) : '',
    moveInDate: initialStartDate,
    termMonths: initialTermMonths,
    endDate: addContractMonths(initialStartDate, Number(initialTermMonths) || 12),
    discountPct: renewFrom ? String(Number(renewFrom.discount_pct) || 0) : '0',
    expiresInHours: 168,
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);
  const setRoomId = (roomId) => {
    const room = roomList.find((r) => String(r.id) === String(roomId));
    setForm((f) => {
      if (!room) {
        return {
          ...f,
          roomId,
          monthlyRent: '',
          deposit: '',
        };
      }
      const rentInfo = resolveRoomRent ? resolveRoomRent(room, config) : { rent: room?.rent };
      const rent = Number(rentInfo.rent);
      const depositInfo = resolveRoomDeposit
        ? resolveRoomDeposit(room, config, Number.isFinite(rent) && rent > 0 ? rent : undefined)
        : { deposit: room?.deposit };
      const deposit = Number(depositInfo.deposit);
      return {
        ...f,
        roomId,
        monthlyRent: Number.isFinite(rent) && rent > 0 ? String(rent) : f.monthlyRent,
        deposit: Number.isFinite(deposit) && deposit >= 0
          ? String(deposit)
          : (Number.isFinite(rent) && rent > 0 ? String(rent * 2) : f.deposit),
      };
    });
  };

  // Auto-set deposit = 2 × monthlyRent when admin types rent (Thai dorm
  // standard) — admin can override after.
  const setRent = (v) => {
    setForm((f) => ({
      ...f,
      monthlyRent: v,
      // Only auto-fill deposit when it's still empty or matches a prior auto-fill.
      deposit: f.deposit === '' || Number(f.deposit) === Number(f.monthlyRent) * 2
        ? String(Number(v) * 2)
        : f.deposit,
    }));
  };
  const selectedRoom = useMemo(
    () => roomList.find((r) => String(r.id) === String(form.roomId)) || null,
    [roomList, form.roomId]
  );
  const selectedRentInfo = selectedRoom && resolveRoomRent
    ? resolveRoomRent(selectedRoom, config)
    : null;
  const selectedDepositInfo = selectedRoom && resolveRoomDeposit
    ? resolveRoomDeposit(selectedRoom, config, Number(form.monthlyRent))
    : null;
  const setMoveInDate = (value) => {
    setForm((f) => ({
      ...f,
      moveInDate: value,
      endDate: f.termMonths ? (addContractMonths(value, Number(f.termMonths)) || f.endDate) : f.endDate,
    }));
  };
  const setTermMonths = (value) => {
    setForm((f) => ({
      ...f,
      termMonths: value,
      endDate: value ? (addContractMonths(f.moveInDate, Number(value)) || f.endDate) : '',
    }));
  };
  const setEndDate = (value) => {
    setForm((f) => {
      const estimated = value ? estimateContractMonths(f.moveInDate, value, 60) : null;
      return {
        ...f,
        endDate: value,
        termMonths: estimated ? String(estimated) : '',
      };
    });
  };

  const submit = async () => {
    setBusy(true);
    try {
      const d = await apiCall('/api/contracts/quick-invite', {
        method: 'POST',
        body: JSON.stringify({
          tenantName: form.tenantName.trim(),
          tenantPhone: form.tenantPhone.trim(),
          tenantEmail: form.tenantEmail.trim() || null,
          roomId: form.roomId.trim(),
          monthlyRent: Number(form.monthlyRent),
          deposit: Number(form.deposit) || 0,
          moveInDate: form.moveInDate,
          termMonths: form.termMonths ? Number(form.termMonths) : null,
          endDate: form.endDate || null,
          discountPct: Number(form.discountPct) || 0,
          expiresInHours: Number(form.expiresInHours) || 168,
          renewOfContractId: renewFrom ? Number(renewFrom.id) : undefined,
        }),
      });
      setResult(d);
    } catch (err) {
      onError && onError(inviteErrorMessage('สร้างสัญญา/ส่งลิงก์ล้มเหลว', err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!result || !result.invitation) return;
    try {
      await navigator.clipboard.writeText(result.invitation.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const t = document.createElement('input');
      t.value = result.invitation.url;
      document.body.appendChild(t);
      t.select();
      document.execCommand('copy');
      document.body.removeChild(t);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Renewal keeps the tenant's own (occupied) room — the server allows that
  // exact case, so the vacant-room check must not block it.
  const renewSameRoom = !!(renewFrom
    && String(form.roomId).trim() === String(renewFrom.room_id || '').trim());
  const roomAvailable = renewSameRoom || !hasRoomInventory || availableRooms.some((r) =>
    String(r.id) === String(form.roomId).trim()
  );
  // Renewal must start after the old contract ends (server enforces too).
  const renewEndYmd = renewFrom ? String(renewFrom.end_date || '').slice(0, 10) : '';
  const renewStartTooEarly = !!(renewFrom && renewEndYmd
    && form.moveInDate && form.moveInDate <= renewEndYmd);
  const termNumber = Number(form.termMonths);
  const termValid = form.termMonths === ''
    || (Number.isInteger(termNumber) && termNumber >= 1 && termNumber <= 60);
  const maxEndDate = form.moveInDate ? addContractMonths(form.moveInDate, 60) : '';
  const endDateValid = !form.endDate
    || (/^\d{4}-\d{2}-\d{2}$/.test(form.endDate)
      && form.endDate >= form.moveInDate
      && (!maxEndDate || form.endDate <= maxEndDate));
  const endDateErrorText = form.endDate && form.endDate < form.moveInDate
    ? 'วันสิ้นสุดต้องไม่ก่อนวันเริ่มเช่า'
    : (form.endDate && maxEndDate && form.endDate > maxEndDate
      ? 'วันสิ้นสุดต้องไม่เกิน 60 เดือนจากวันเริ่มเช่า'
      : 'วันที่สัญญาไม่ถูกต้อง');
  const valid = form.tenantName.trim()
    && /^[\d+\s-]{8,20}$/.test(form.tenantPhone.trim())
    && form.roomId.trim()
    && roomAvailable
    && !renewStartTooEarly
    && Number(form.monthlyRent) > 0
    && /^\d{4}-\d{2}-\d{2}$/.test(form.moveInDate)
    && termValid
    && endDateValid;

  return (
    <Modal
      open={true}
      onClose={() => { if (result) onSaved(result); else onClose(); }}
      width={620}
      title={renewFrom
        ? `🔄 ต่อสัญญา ${renewFrom.contract_no} — สร้างสัญญาใหม่จากเงื่อนไขเดิม`
        : 'สร้างสัญญา + ส่งลิงก์ให้ผู้เช่ากรอกเอง'}
      footer={
        result ? (
          <Btn variant="primary" onClick={() => onSaved(result)}>เสร็จสิ้น</Btn>
        ) : (
          <>
            <Btn variant="ghost" onClick={onClose} disabled={busy}>ยกเลิก</Btn>
            <Btn variant="primary" onClick={submit} disabled={busy || !valid}>
              {busy ? 'กำลังสร้าง…' : 'สร้างสัญญา + รับลิงก์'}
            </Btn>
          </>
        )
      }
    >
      {!result ? (
        <div>
          {renewFrom ? (
            <div style={{
              padding: 10, background: C.infoSoft || '#e8f1f8', borderRadius: 8,
              marginBottom: 12, fontSize: 12, color: C.infoInk || C.ink2, lineHeight: 1.6,
            }}>
              เงื่อนไขเดิม (ผู้เช่า/ห้อง/ค่าเช่า/มัดจำ/ส่วนลด/ระยะเวลา) ถูกดึงมาให้แล้ว —
              แก้ไขได้ก่อนส่ง · สัญญาเดิมจะสิ้นสุดตามกำหนดเดิม ({renewEndYmd || 'ไม่ระบุ'})
              แล้วสัญญาใหม่เริ่มต่อทันที · ผู้เช่ายืนยัน+เซ็นผ่านลิงก์เหมือนสัญญาแรก
            </div>
          ) : null}
          <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6, marginBottom: 16 }}>
            กรอกแค่ข้อมูลสัญญา (ห้อง/ค่าเช่า/มัดจำ/วันเริ่ม) — ส่วนที่เหลือ (ที่อยู่
            ผู้ติดต่อฉุกเฉิน บัตรประชาชน ลายเซ็น) ผู้เช่าจะกรอกเองผ่านลิงก์ที่ระบบ
            สร้างให้
          </div>

          <div style={{
            padding: 12, background: C.surfaceAlt, borderRadius: 8,
            marginBottom: 16, fontSize: 13, fontWeight: 600, color: C.accent,
          }}>👤 ข้อมูลผู้เช่า (สำหรับส่งลิงก์)</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={lbl}>ชื่อ-นามสกุล *</label>
              <input style={inp} maxLength={200}
                value={form.tenantName}
                onChange={(e) => setForm({ ...form, tenantName: e.target.value })} />
            </div>
            <div>
              <label style={lbl}>เบอร์โทร *</label>
              <input style={inp} maxLength={20} placeholder="0812345678"
                value={form.tenantPhone}
                onChange={(e) => setForm({ ...form, tenantPhone: e.target.value })} />
            </div>
          </div>
          <div style={{ marginTop: 8 }}>
            <label style={lbl}>อีเมล (ทางเลือก)</label>
            <input style={inp} type="email" maxLength={200}
              value={form.tenantEmail}
              onChange={(e) => setForm({ ...form, tenantEmail: e.target.value })} />
          </div>

          <div style={{
            padding: 12, background: C.surfaceAlt, borderRadius: 8,
            marginTop: 20, marginBottom: 16, fontSize: 13, fontWeight: 600, color: C.accent,
          }}>📋 ข้อมูลสัญญา</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <div>
              <label style={lbl}>ห้องเลขที่ *</label>
              {renewFrom ? (
                <>
                  <input style={{ ...inp, background: C.surfaceAlt }} value={form.roomId} readOnly />
                  <div style={{ marginTop: 4, fontSize: 11, color: C.muted }}>
                    ต่อสัญญาในห้องเดิมของผู้เช่า
                  </div>
                </>
              ) : hasRoomInventory ? (
                <select style={inp} value={form.roomId}
                  onChange={(e) => setRoomId(e.target.value)}>
                  <option value="">{availableRooms.length ? 'เลือกห้องว่าง' : 'ไม่มีห้องว่าง'}</option>
                  {availableRooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.id} · ฿{Number(r.rent || 0).toLocaleString('th-TH')}
                    </option>
                  ))}
                </select>
              ) : (
                <input style={inp} maxLength={32}
                  value={form.roomId}
                  onChange={(e) => setForm({ ...form, roomId: e.target.value })} />
              )}
              {!renewFrom && hasRoomInventory ? (
                <div style={{ marginTop: 4, fontSize: 11, color: roomAvailable ? C.muted : (C.danger || C.danger) }}>
                  {availableRooms.length
                    ? `เลือกได้ ${availableRooms.length} ห้องว่างจากระบบ`
                    : 'ทุกห้องไม่ว่าง/ติดจอง/ซ่อมบำรุง ต้องปลดสถานะห้องก่อนสร้างสัญญา'}
                </div>
              ) : null}
            </div>
            <div>
              <label style={lbl}>ค่าเช่า/เดือนที่จะล็อกในสัญญา *</label>
              <input style={inp} type="number" step="0.01" min="0"
                value={form.monthlyRent}
                onChange={(e) => setRent(e.target.value)} />
            </div>
            <div>
              <label style={lbl}>มัดจำที่จะล็อกในสัญญา</label>
              <input style={inp} type="number" step="0.01" min="0"
                value={form.deposit}
                onChange={(e) => setForm({ ...form, deposit: e.target.value })} />
            </div>
          </div>
          <div style={{
            marginTop: 8,
            padding: 10,
            background: C.infoSoft || C.surfaceAlt,
            border: `1px solid ${(C.info || C.accent)}33`,
            borderRadius: 6,
            fontSize: 12,
            color: C.infoInk || C.muted,
            lineHeight: 1.5,
          }}>
            {selectedRoom ? (
              <>
                ค่าเช่าที่เลือกมาจาก {selectedRentInfo?.source === 'override' ? 'override รายห้อง' : selectedRentInfo?.source === 'formula' ? 'เมนูตั้งราคา' : 'ข้อมูลห้อง'}
                {' '}และมัดจำมาจาก {selectedDepositInfo?.sourceLabel || 'เมนูตั้งราคา'}.
                เมื่อสร้างสัญญาแล้ว ยอดนี้จะถูกล็อกไว้ในสัญญา หากต้องเปลี่ยนราคากลางให้แก้ที่เมนูตั้งราคาก่อนสร้างสัญญา
              </>
            ) : (
              <>เลือกห้องก่อน ระบบจะดึงค่าเช่าและมัดจำจากเมนูตั้งราคา/override รายห้องมาเติมให้อัตโนมัติ</>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 8 }}>
            <div>
              <label style={lbl}>วันเริ่มเช่า *</label>
              <input style={inp} type="date"
                value={form.moveInDate}
                onChange={(e) => setMoveInDate(e.target.value)} />
            </div>
            <div>
              <label style={lbl}>ระยะเวลา (เดือนนับจากวันเริ่ม)</label>
              <input style={inp} type="number" step="1" min="1" max="60"
                placeholder="เปิด-ไม่จำกัด"
                value={form.termMonths}
                onChange={(e) => setTermMonths(e.target.value)} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 8 }}>
            <div>
              <label style={lbl}>วันสิ้นสุด (คำนวณอัตโนมัติ/แก้เองได้)</label>
              <input style={inp} type="date"
                value={form.endDate}
                onChange={(e) => setEndDate(e.target.value)} />
            </div>
            <div>
              <label style={lbl}>ส่วนลด (%)</label>
              <input style={inp} type="number" step="0.1" min="0" max="50"
                value={form.discountPct}
                onChange={(e) => setForm({ ...form, discountPct: e.target.value })} />
            </div>
          </div>
          <div style={{
            marginTop: 8,
            padding: 10,
            background: (endDateValid && !renewStartTooEarly) ? C.infoSoft : C.dangerSoft,
            border: `1px solid ${(endDateValid && !renewStartTooEarly) ? C.border : '#f5c0b4'}`,
            borderRadius: 6,
            fontSize: 12,
            color: (endDateValid && !renewStartTooEarly) ? (C.infoInk || C.ink2) : (C.dangerInk || '#8a2f2b'),
            lineHeight: 1.5,
          }}>
            {renewStartTooEarly
              ? `วันเริ่มสัญญาใหม่ต้องอยู่หลังวันสิ้นสุดสัญญาเดิม (${renewEndYmd}) ระบบจะยังไม่ให้สร้างสัญญา`
              : endDateValid
                ? contractDateSummary(form.moveInDate, form.termMonths, form.endDate)
                : `${endDateErrorText} ระบบจะยังไม่ให้สร้างสัญญา`}
          </div>

          <div style={{ marginTop: 16 }}>
            <label style={lbl}>อายุของลิงก์</label>
            <select style={inp} value={form.expiresInHours}
              onChange={(e) => setForm({ ...form, expiresInHours: Number(e.target.value) })}>
              <option value={24}>24 ชั่วโมง (1 วัน)</option>
              <option value={72}>72 ชั่วโมง (3 วัน)</option>
              <option value={168}>168 ชั่วโมง (7 วัน) — แนะนำ</option>
              <option value={336}>336 ชั่วโมง (14 วัน)</option>
              <option value={720}>720 ชั่วโมง (30 วัน)</option>
            </select>
          </div>
        </div>
      ) : (
        <div>
          <div style={{
            padding: 12, background: C.successSoft, border: '1px solid #4a8b4a',
            borderRadius: 8, fontSize: 13, color: C.successInk, marginBottom: 16,
          }}>
            ✅ สร้างสัญญา <b>{result.contract.contract_no}</b> เรียบร้อย —
            ส่งลิงก์ด้านล่างให้ <b>{result.tenant.fullName}</b> กรอกได้เลย
          </div>
          <label style={lbl}>ลิงก์สำหรับผู้เช่า</label>
          <div style={{
            padding: 10,
            background: result.delivery && result.delivery.ok ? C.successSoft : C.warningSoft,
            border: `1px solid ${result.delivery && result.delivery.ok ? '#4a8b4a' : '#f1b32d'}`,
            borderRadius: 8,
            fontSize: 12,
            color: result.delivery && result.delivery.ok ? C.successInk : C.warningInk,
            marginBottom: 12,
            lineHeight: 1.5,
          }}>
            {inviteDeliverySummary(result.delivery)}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input readOnly value={result.invitation.url}
              style={{ ...inp, fontFamily: 'monospace', fontSize: 11 }}
              onFocus={(e) => e.target.select()} />
            <Btn variant="primary" onClick={copy}>{copied ? '✓ ก็อปแล้ว' : 'ก็อป'}</Btn>
          </div>
          <div style={{ marginTop: 12, fontSize: 12, color: C.muted }}>
            อายุลิงก์: หมดอายุ {new Date(result.invitation.expiresAt).toLocaleString('th-TH', {
              year: 'numeric', month: 'short', day: 'numeric',
              hour: '2-digit', minute: '2-digit',
            })}
          </div>
          <div style={{
            marginTop: 16, padding: 12, background: C.warningSoft,
            border: '1px solid #f1b32d', borderRadius: 8,
            fontSize: 12, color: C.warningInk, lineHeight: 1.6,
          }}>
            🔒 <b>ลิงก์นี้แสดงครั้งเดียว</b> — ก๊อปแล้วส่งให้ผู้เช่าทาง LINE/SMS<br/>
            หลังผู้เช่ากรอกเสร็จ คุณจะเห็นในเมนู "ใบเชิญผู้เช่ากรอก" สำหรับตรวจสอบ
          </div>
        </div>
      )}
    </Modal>
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

window.PageContracts = PageContracts;
