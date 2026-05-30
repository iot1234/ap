// === admin/page-health.jsx ================================================
// System health dashboard. Shows the status of every subsystem (DB, LINE,
// SMTP, R2, scheduler, queue, etc.) with color-coded pills + detail
// drawers. Backed by GET /api/admin/health (services/healthCheck.js).
//
// The dashboard polls every 30s while open. Owners can also click
// "Refresh" to force-rerun all checks. Anomaly detector (running from
// the scheduler tick hourly) sends LINE/email alerts on transitions —
// this page is the manual / forensic view.
// ===========================================================================

const { useState, useEffect, useRef } = React;

const STATUS_META = {
  ok:    { color: C.success, bg: C.successSoft, icon: '✓', label: 'ปกติ' },
  warn:  { color: C.warning, bg: C.warningSoft, icon: '⚠', label: 'เตือน' },
  error: { color: C.danger, bg: C.dangerSoft, icon: '✗', label: 'ผิดปกติ' },
};

function PageHealth({ setToast }) {
  const C = window.ADMIN_C;
  const { Card, Btn, Pill, PageContainer, PageHeader, SectionHeading } = window;
  const apiFetch = window.requireApiFetch ? window.requireApiFetch() : window.apiFetch;

  const [report, setReport] = useState(null);
  const [busy, setBusy]     = useState(false);
  const [err, setErr]       = useState('');
  const [expanded, setExpanded] = useState({});
  const [anomalies, setAnomalies] = useState(null);   // data-integrity scan
  const timerRef = useRef(null);

  async function load(force = false) {
    setBusy(true);
    if (force) setErr('');
    try {
      const r = await apiFetch('/api/admin/health');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setReport(d);
      setErr('');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
    // Data-integrity anomalies (rent typos, zero utility rates, ghost-occupied
    // rooms, stuck slips, …). Best-effort + separate try so a scan failure
    // never blocks the health view.
    try {
      const ar = await apiFetch('/api/admin/anomalies');
      const ad = await ar.json();
      if (ar.ok) setAnomalies(ad);
    } catch { /* ignore — panel just stays hidden */ }
  }

  useEffect(() => {
    load(true);
    timerRef.current = setInterval(load, 30_000);
    return () => clearInterval(timerRef.current);
  }, []);

  const summaryColor = report
    ? STATUS_META[report.severity || 'ok']
    : STATUS_META.ok;

  return (
    <PageContainer>
      <PageHeader
        title="สถานะระบบ"
        subtitle="ตรวจทุก subsystem แบบเรียลไทม์ — เตือนเจ้าของอัตโนมัติเมื่อสถานะเปลี่ยน"
        right={
          <Btn variant="ghost" onClick={() => load(true)} disabled={busy}>
            {busy ? '…' : '🔄 รีเฟรช'}
          </Btn>
        }
      />

      {err ? (
        <Card style={{ color: C.danger, marginBottom: 12 }}>
          ⚠ ไม่สามารถดึงสถานะได้: {err}
        </Card>
      ) : null}

      {/* Summary banner */}
      <Card style={{
        marginBottom: 16,
        background: summaryColor.bg,
        borderLeft: `4px solid ${summaryColor.color}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{
            width: 48, height: 48, borderRadius: 24,
            background: summaryColor.color, color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 22, fontWeight: 700,
          }}>{summaryColor.icon}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 17, color: summaryColor.color }}>
              {report
                ? (report.severity === 'ok' ? 'ทุกระบบทำงานปกติ'
                  : report.severity === 'warn' ? 'มีบางส่วนต้องตรวจสอบ'
                  : 'พบปัญหาที่ต้องแก้ไขด่วน')
                : 'กำลังตรวจสอบ…'}
            </div>
            <div style={{ color: C.muted, fontSize: 13, marginTop: 2 }}>
              {report
                ? `ตรวจล่าสุด: ${new Date(report.checkedAt).toLocaleString('th-TH')} · ทดสอบ ${report.checks?.length || 0} รายการ`
                : 'รอผลตรวจครั้งแรก'}
            </div>
          </div>
        </div>
      </Card>

      {/* Data-integrity anomalies — surfaces the previously-orphaned
          /api/admin/anomalies scanner so operators can SEE + fix bad data
          (typo'd rent, zero utility rate, ghost-occupied room, stuck slip). */}
      {anomalies && Array.isArray(anomalies.items) && anomalies.items.length ? (
        <Card style={{ marginBottom: 16 }}>
          <SectionHeading>🔎 ตรวจสุขภาพข้อมูล</SectionHeading>
          <div style={{ color: C.muted, fontSize: 12.5, marginBottom: 8 }}>
            ความผิดปกติของข้อมูลที่ควรแก้ — ค่าเช่า/เรตค่าน้ำไฟผิดปกติ, ห้องว่างแต่ยังผูกผู้เช่า, สลิปค้างตรวจ ฯลฯ
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {anomalies.items.map((a) => {
              const meta = STATUS_META[a.severity === 'critical' ? 'error'
                : a.severity === 'warn' ? 'warn' : 'ok'] || STATUS_META.warn;
              const samples = Array.isArray(a.items) ? a.items : [];
              return (
                <div key={a.key} style={{
                  borderBottom: '1px solid ' + C.border, padding: '12px 0',
                  display: 'grid', gridTemplateColumns: '32px 1fr auto',
                  alignItems: 'center', gap: 12,
                }}>
                  <div style={{
                    width: 26, height: 26, borderRadius: 13,
                    background: meta.bg, color: meta.color,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 700, fontSize: 14,
                  }}>{meta.icon}</div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: meta.color }}>
                      {a.title}{a.count ? ` (${a.count})` : ''}
                    </div>
                    {samples.length ? (
                      <div style={{ color: C.muted, fontSize: 12, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {samples.slice(0, 5).map((it) => it && it.label).filter(Boolean).join(' · ')}
                        {samples.length > 5 ? ` … +${samples.length - 5}` : ''}
                      </div>
                    ) : null}
                  </div>
                  {a.fix ? (
                    <a
                      href={a.fix}
                      onClick={(e) => {
                        if (typeof a.fix === 'string' && a.fix.startsWith('/admin#')) {
                          e.preventDefault();
                          window.location.hash = a.fix.slice('/admin'.length);
                        }
                      }}
                      style={{ fontSize: 12.5, color: C.accent || C.info, textDecoration: 'underline', whiteSpace: 'nowrap' }}
                    >แก้ไข →</a>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Card>
      ) : (anomalies && anomalies.ok ? (
        <Card style={{ marginBottom: 16 }}>
          <span style={{ color: C.success, fontSize: 13 }}>✅ ตรวจสุขภาพข้อมูล: ไม่พบความผิดปกติ</span>
        </Card>
      ) : null)}

      {/* Per-check rows */}
      <Card>
        <SectionHeading>ผลการตรวจรายระบบ</SectionHeading>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {(report?.checks || []).map((c) => {
            const meta = STATUS_META[c.status] || STATUS_META.ok;
            const isOpen = expanded[c.id];
            return (
              <div key={c.id} style={{
                borderBottom: '1px solid ' + C.border,
                padding: '14px 0',
              }}>
                <div
                  onClick={() => c.detail && setExpanded({ ...expanded, [c.id]: !isOpen })}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '40px 1fr auto',
                    alignItems: 'center', gap: 14,
                    cursor: c.detail ? 'pointer' : 'default',
                  }}
                >
                  <div style={{
                    width: 32, height: 32, borderRadius: 16,
                    background: meta.bg, color: meta.color,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 700, fontSize: 16,
                  }}>{meta.icon}</div>

                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14.5, color: C.ink }}>
                      {c.label}
                    </div>
                    <div style={{ color: c.status === 'ok' ? C.muted : meta.color, fontSize: 13, marginTop: 2 }}>
                      {c.message}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {c.durationMs != null ? (
                      <span style={{ fontSize: 11, color: C.muted, fontFamily: 'JetBrains Mono, monospace' }}>
                        {c.durationMs}ms
                      </span>
                    ) : null}
                    <Pill color={c.status === 'ok' ? 'success' : c.status === 'warn' ? 'warning' : 'danger'} size="sm">
                      {meta.label}
                    </Pill>
                  </div>
                </div>

                {isOpen && c.detail ? (
                  <pre style={{
                    marginTop: 10, marginLeft: 54,
                    padding: 12, borderRadius: 8,
                    background: C.bg, color: C.ink2,
                    fontSize: 12, fontFamily: 'JetBrains Mono, monospace',
                    overflowX: 'auto', whiteSpace: 'pre-wrap',
                  }}>
                    {JSON.stringify(c.detail, null, 2)}
                  </pre>
                ) : null}
              </div>
            );
          })}
        </div>
      </Card>

      <Card style={{ marginTop: 16, background: C.bg, fontSize: 13, color: C.muted }}>
        <div style={{ marginBottom: 6 }}>
          📡 <b>Auto-refresh ทุก 30 วิ</b> · ผลตรวจมีการ cache ฝั่งเซิร์ฟเวอร์
        </div>
        <div style={{ marginBottom: 6 }}>
          🔔 ระบบจะ <b>แจ้งเจ้าของผ่าน LINE/อีเมลทันทีที่สถานะเปลี่ยน</b> (ok→warn/error) —
          ไม่สแปม: ส่งซ้ำเฉพาะเมื่อยังเป็น error เกิน 60 นาที หรือกลับมาปกติ
        </div>
        <div>
          🛠 หากเห็นสถานะ <b>ผิดปกติ</b>: คลิกแถวเพื่อดูรายละเอียด · ตรวจหน้า "ตั้งค่า API/Keys"
          ว่า credentials ครบ · ตรวจ logs ใน Railway dashboard
        </div>
      </Card>
    </PageContainer>
  );
}

window.PageHealth = PageHealth;
