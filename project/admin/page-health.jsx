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
  ok:    { color: '#2f8f5b', bg: '#e7f3ec', icon: '✓', label: 'ปกติ' },
  warn:  { color: '#c08a2a', bg: '#fbf1de', icon: '⚠', label: 'เตือน' },
  error: { color: '#b94a48', bg: '#fbe7e6', icon: '✗', label: 'ผิดปกติ' },
};

function PageHealth({ setToast }) {
  const C = window.ADMIN_C;
  const { Card, Btn, Pill, PageContainer, PageHeader, SectionHeading } = window;
  const apiFetch = window.apiFetch || ((u, o) => fetch(u, { credentials: 'same-origin', ...o }));

  const [report, setReport] = useState(null);
  const [busy, setBusy]     = useState(false);
  const [err, setErr]       = useState('');
  const [expanded, setExpanded] = useState({});
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
