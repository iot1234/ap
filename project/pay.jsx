const { useEffect, useMemo, useState } = React;
const PUBLIC_PAY_REFRESH_MS = 15000;

function fmt(n) {
  return Number(n || 0).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Keep this in sync with tenantRejectedReason in tenant.jsx — pay.html is
// a minimal public bundle that doesn't share window helpers, so the map
// is inlined here. We translate both server-side audit codes
// (superseded_by_*) and the free-form English strings the upstream slip
// verifiers (SlipOK / EasySlip / Slip2Go) leak ("too many requests",
// "Please provide either a payload string, a image file, a base64
// encoded image, or a image URL", "Unauthorized", "Duplicate slip" …)
// so the tenant never sees raw English on the public pay page.
function tenantRejectedReason(raw) {
  if (!raw) return raw;
  const s = String(raw);

  // Server-side audit codes (structured, prefix-matched).
  if (s.startsWith('superseded_by_verified_sibling')) return 'ระบบรับสลิปอีกใบสำหรับบิลนี้ไปแล้ว';
  if (s.startsWith('superseded_by_manual_pay'))       return 'แอดมินบันทึกการชำระเงินด้วยช่องทางอื่น (เงินสด/โอน) แล้ว';
  if (s.startsWith('superseded_by_void'))             return 'บิลนี้ถูกยกเลิกแล้ว — โปรดติดต่อแอดมิน';
  if (s.startsWith('unmark_paid_correction'))         return 'แอดมินยกเลิกการบันทึกชำระ — โปรดติดต่อแอดมิน';

  // Upstream slip-verifier strings.
  const lower = s.toLowerCase();
  if (/(payload string|image file|base64|image url|invalid image)/i.test(s)) {
    return 'ไม่พบรูปสลิปหรือสลิปอ่านไม่ออก กรุณาอัปโหลดสลิปใหม่ที่ชัดเจน';
  }
  if (/invalid (api|signature|key|token)/i.test(s) || /unauthor/i.test(lower)) {
    return 'ระบบตรวจสลิปเชื่อมต่อไม่สำเร็จ — โปรดติดต่อแอดมินเพื่อตรวจการตั้งค่า';
  }
  if (/quota|rate.?limit|too many|429/i.test(s)) {
    return 'ระบบตรวจสลิปใช้งานเกินโควต้า — รบกวนติดต่อแอดมิน';
  }
  if (/duplicate|already (used|verified)/i.test(s)) {
    return 'สลิปนี้ถูกใช้แล้ว — กรุณาอัปโหลดสลิปของรายการโอนใหม่';
  }
  if (/amount|number/i.test(s) && /mismatch|not match|differ|incorrect/i.test(s)) {
    return 'ยอดในสลิปไม่ตรงกับยอดบิล กรุณาตรวจสอบและอัปโหลดสลิปใหม่';
  }
  if (/receiver|target|account|destination/i.test(s) && /mismatch|not match|differ|incorrect/i.test(s)) {
    return 'บัญชีปลายทางในสลิปไม่ใช่ของหอพัก — กรุณาตรวจสอบบัญชีผู้รับ';
  }
  if (/network|timeout|econnreset|fetch failed|connect/i.test(lower)) {
    return 'เชื่อมต่อระบบตรวจสลิปไม่สำเร็จ ลองอัปโหลดใหม่หรือแจ้งแอดมิน';
  }

  // English-looking free text → generic friendly fallback. Detect "looks
  // English" via the presence of ASCII letters AND the absence of any Thai
  // letters; anything Thai is already actionable.
  if (/[A-Za-z]/.test(s) && !/[฀-๿]/.test(s)) {
    return 'การตรวจสอบไม่ผ่าน ลองอัปโหลดสลิปใหม่หรือแจ้งแอดมิน';
  }
  return s;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function appendQuery(url, params) {
  const qs = new URLSearchParams(params).toString();
  return `${url}${String(url || '').includes('?') ? '&' : '?'}${qs}`;
}

async function readJson(res) {
  const contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
  if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
    const err = new Error('ลิงก์ชำระเงินถูกเปลี่ยนหน้า กรุณาเปิดลิงก์ใหม่หรือติดต่อแอดมิน');
    err.status = res.status || 0;
    err.data = { code: 'REDIRECTED' };
    throw err;
  }
  if (contentType.includes('text/html')) {
    const err = new Error('ระบบชำระเงินส่งหน้าจอแทนข้อมูล กรุณาเปิดลิงก์ใหม่หรือติดต่อแอดมิน');
    err.status = res.status || 0;
    err.data = { code: 'HTML_RESPONSE' };
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function userFacingError(e, fallback) {
  const data = e && e.data;
  if (data && data.code === 'RATE_LIMIT') {
    const wait = Number(data.retryAfterSeconds);
    return Number.isFinite(wait) && wait > 0
      ? `มีการเปิดหรือรีเฟรชลิงก์นี้ถี่เกินไป กรุณารอ ${Math.ceil(wait)} วินาทีแล้วลองใหม่`
      : 'มีการเปิดหรือรีเฟรชลิงก์นี้ถี่เกินไป กรุณารอสักครู่แล้วลองใหม่';
  }
  // If the server response leaked a raw English message (e.g. an upstream
  // 429 that bypassed our IP limiter's Thai text, or a verifier provider
  // string like "too many requests"), translate it through the same
  // dictionary the rejected_reason renderer uses so the public pay page
  // never shows raw English to a tenant.
  const raw = (e && e.message) || '';
  if (raw && /[A-Za-z]/.test(raw) && !/[฀-๿]/.test(raw)) {
    const translated = tenantRejectedReason(raw);
    if (translated && translated !== raw) return translated;
  }
  return raw || fallback;
}

function statusText(status) {
  return ({
    pending: 'รอชำระ',
    overdue: 'ค้างชำระ',
    paid: 'ชำระแล้ว',
    void: 'ยกเลิก',
  })[status] || status || '-';
}

function statusColor(status) {
  return ({
    pending: 'var(--amber)',
    overdue: 'var(--red)',
    paid: 'var(--green)',
    void: 'var(--muted)',
  })[status] || 'var(--muted)';
}

function buildContactSuffix(building) {
  if (!building) return '';
  const name = building.name ? `"${building.name}"` : '';
  const phone = building.phone ? ` โทร ${building.phone}` : '';
  if (!name && !phone) return '';
  return ` (${[name, phone].filter(Boolean).join('')})`.replace('( ', '(');
}

function contactAdminMessage(upload, building) {
  const suffix = buildContactSuffix(building);
  if (upload && upload.remaining > 0) {
    return `หากโอนถูกต้องแล้วกรุณาติดต่อแอดมิน${suffix} หรือรีเฟรช/เปิดลิงก์นี้ใหม่เพื่ออัปโหลดอีกครั้ง เหลือ ${upload.remaining}/${upload.max} ครั้ง`;
  }
  return `บิลนี้ไม่สามารถอัปโหลดสลิปเพิ่มได้แล้ว กรุณาติดต่อแอดมิน${suffix}`;
}

function slipPartyText(party) {
  if (!party) return '';
  return [party.name, party.bank, party.account ? `...${String(party.account).slice(-6)}` : null]
    .filter(Boolean).join(' / ');
}

function verificationMessage(out, fallbackUpload, building) {
  const v = out && out.verification;
  const payment = (out && out.payment) || {};
  const upload = (out && out.upload) || fallbackUpload || null;
  if (!v) {
    if (payment.status === 'verified') return 'ชำระเงินสำเร็จ ระบบอัปเดตสถานะบิลแล้ว';
    if (payment.status === 'rejected') {
      return `${tenantRejectedReason(payment.rejected_reason) || 'สลิปไม่ผ่านการตรวจสอบ'}\n${contactAdminMessage(upload, building)}`;
    }
    return 'อัปโหลดสลิปสำเร็จ รอแอดมินตรวจสอบ';
  }
  const lines = [
    v.title || 'ผลการตรวจสอบสลิป',
    v.message,
  ];
  if (v.provider) lines.push(`บริการตรวจสลิป: ${v.provider}`);
  if (v.code) lines.push(`รหัสอ้างอิงสำหรับแจ้งแอดมิน: ${v.code}`);
  if (v.transactionRef) lines.push(`เลขอ้างอิง: ${v.transactionRef}`);
  if (v.amount != null) lines.push(`ยอดที่อ่านจากสลิป: ฿${fmt(v.amount)}`);
  const sender = slipPartyText(v.sender);
  const receiver = slipPartyText(v.receiver);
  if (sender) lines.push(`ผู้โอน: ${sender}`);
  if (receiver) lines.push(`ผู้รับ: ${receiver}`);
  if (v.nextAction) lines.push(`ขั้นตอนถัดไป: ${v.nextAction}`);
  if (upload) lines.push(`อัปโหลดแล้ว: ${upload.used}/${upload.max} ครั้ง`);
  if (v.status === 'rejected') lines.push(contactAdminMessage(upload, building));
  return lines.filter(Boolean).join('\n');
}

function blockMessage(upload) {
  const code = upload && upload.blocked && upload.blocked.code;
  if (code === 'PAYMENT_UNDER_REVIEW') return 'มีสลิปรอแอดมินตรวจสอบอยู่ กรุณารอผลการตรวจสอบ';
  if (code === 'SLIP_UPLOAD_LIMIT_REACHED') return 'อัปโหลดครบ 3 ครั้งแล้ว กรุณาติดต่อแอดมิน';
  if (code === 'PAID') return 'บิลนี้ชำระเรียบร้อยแล้ว';
  return 'ไม่สามารถอัปโหลดสลิปออนไลน์ได้ กรุณาติดต่อแอดมิน';
}

function BillBreakdown({ bill }) {
  const items = Array.isArray(bill && bill.lineItems)
    ? bill.lineItems.filter((it) => it && String(it.label || '').trim())
    : [];
  if (!items.length) return null;
  return (
    <div style={breakdownCard}>
      <div style={breakdownHeader}>
        <div style={{ fontWeight: 700 }}>รายละเอียดค่าใช้จ่าย</div>
        {bill.subtotal != null ? <div style={muted}>ยอดก่อน VAT/ค่าปรับ ฿{fmt(bill.subtotal)}</div> : null}
      </div>
      <div style={breakdownList}>
        {items.map((it, idx) => (
          <div key={it.key || `${it.label}-${idx}`} style={breakdownRow}>
            <div style={{ minWidth: 0 }}>
              <div style={breakdownLabel}>{it.label}</div>
              {it.qty ? <div style={breakdownMeta}>{it.qty}</div> : null}
              {it.detail ? <div style={breakdownDetail}>{it.detail}</div> : null}
            </div>
            <div style={breakdownAmount}>฿{fmt(it.amount)}</div>
          </div>
        ))}
      </div>
      <div style={breakdownTotal}>
        <span>รวมทั้งสิ้น</span>
        <strong>฿{fmt(bill.total)}</strong>
      </div>
    </div>
  );
}

class PayPageErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, info) {
    try {
      fetch('/api/client-error', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: String((error && error.message) || error || '').slice(0, 1000),
          stack: String((error && error.stack) || '').slice(0, 4000),
          componentStack: String((info && info.componentStack) || '').slice(0, 4000),
          url: window.location.href,
        }),
      });
    } catch { /* best-effort client error report */ }
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="tenant-public-shell" style={wrap}>
          <section className="tenant-pay-panel" style={panel}>
            <div style={topline}>ชำระบิล</div>
            <h1 style={h1}>หน้านี้ขัดข้องชั่วคราว</h1>
            <div style={errorBox}>
              กรุณากดโหลดใหม่อีกครั้ง หากยังเปิดไม่ได้ให้ส่งลิงก์นี้ให้แอดมินตรวจสอบ
            </div>
            <button type="button" style={button} onClick={() => window.location.reload()}>
              โหลดใหม่
            </button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

function App() {
  const match = window.location.pathname.match(/\/pay\/(\d+)/);
  const billId = match ? Number(match[1]) : 0;
  const token = new URLSearchParams(window.location.search).get('t') || '';
  const apiBase = useMemo(
    () => `/api/public/bills/${encodeURIComponent(billId)}/payment?t=${encodeURIComponent(token)}`,
    [billId, token]
  );
  const uploadUrl = useMemo(
    () => `/api/public/bills/${encodeURIComponent(billId)}/payments?t=${encodeURIComponent(token)}`,
    [billId, token]
  );

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [amount, setAmount] = useState('');
  const [file, setFile] = useState(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageKind, setMessageKind] = useState('');
  const [qrFallback, setQrFallback] = useState(null);
  const [qrCopied, setQrCopied] = useState(false);

  async function load(silent = false) {
    if (!billId || !token) {
      setErr('ลิงก์ไม่ถูกต้องหรือหมดอายุ กรุณาติดต่อแอดมิน');
      setLoading(false);
      return;
    }
    try {
      const next = await fetch(apiBase, {
        credentials: 'same-origin',
        redirect: 'manual',
      }).then(readJson);
      setData(next);
      setErr('');
      if (next.bill) setAmount(String(next.bill.total || ''));
    } catch (e) {
      if (!silent) setErr(userFacingError(e, 'โหลดข้อมูลชำระเงินไม่สำเร็จ กรุณาติดต่อแอดมิน'));
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [apiBase]);

  useEffect(() => {
    if (!data || data.paid) return undefined;
    const timer = setInterval(() => load(true), PUBLIC_PAY_REFRESH_MS);
    return () => clearInterval(timer);
  }, [data && data.paid, apiBase]);

  useEffect(() => {
    setQrFallback(null);
    setQrCopied(false);
  }, [data && data.qrUrl]);

  async function loadQrFallback() {
    if (!data || !data.qrUrl) return;
    const payment = data.payment || {};
    try {
      const fallback = await fetch(appendQuery(data.qrUrl, { format: 'json' }), {
        credentials: 'same-origin',
        redirect: 'manual',
      }).then(readJson);
      if (!fallback || !fallback.payload) throw new Error('QR payload missing');
      setQrFallback({
        ...fallback,
        bankInfo: fallback.bankInfo || payment.bankInfo || null,
        promptpayName: fallback.promptpayName || payment.promptpayName || null,
      });
    } catch (e) {
      setQrFallback({
        error: 'ไม่สามารถแสดง QR ได้ กรุณาโอนผ่านบัญชีธนาคารด้านล่างหรือแจ้งแอดมิน',
        bankInfo: payment.bankInfo || null,
        promptpayName: payment.promptpayName || null,
      });
    }
  }

  async function upload() {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setMessageKind('error');
      setMessage('จำนวนเงินไม่ถูกต้อง กรุณาติดต่อแอดมิน');
      return;
    }
    if (!file) {
      setMessageKind('error');
      setMessage('กรุณาแนบรูปสลิป');
      return;
    }

    setBusy(true);
    setMessageKind('processing');
    setMessage('กำลังประมวลผลสลิป กรุณารอสักครู่...');
    try {
      const slip = await fileToDataUrl(file);
      const out = await fetch(uploadUrl, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: n, slip }),
      }).then(readJson);

      const st = out.payment && out.payment.status;
      const building = data && data.building;
      if (st === 'verified') {
        setMessageKind('success');
        setMessage(verificationMessage(out, data && data.upload, building));
      } else if (st === 'rejected') {
        setMessageKind('error');
        setMessage(verificationMessage(out, data && data.upload, building));
      } else {
        setMessageKind('pending');
        setMessage(verificationMessage(out, data && data.upload, building));
      }
      setFile(null);
      setFileInputKey((x) => x + 1);
      await load(true);
    } catch (e) {
      setMessageKind('error');
      const building = data && data.building;
      setMessage(e.data && e.data.verification
        ? verificationMessage(e.data, e.data.upload, building)
        : `${userFacingError(e, 'อัปโหลดไม่สำเร็จ')}\n${contactAdminMessage(e.data && e.data.upload, building)}`);
      await load(true);
    } finally {
      setBusy(false);
    }
  }

  const bill = data && data.bill;
  const paid = !!(data && data.paid);
  const uploadState = data && data.upload;
  const canUpload = !!(data && data.channels && data.channels.slip && !paid && (!uploadState || uploadState.canUpload !== false));
  const hasWalletChannel = !!(data?.payment?.walletInfo && data.payment.walletInfo.phone);
  const hasBankChannel = !!(data?.payment?.bankInfo && data.payment.bankInfo.account);
  const paymentEyebrow = hasWalletChannel
    ? 'Wallet / transfer payment'
    : hasBankChannel
      ? 'Bank transfer payment'
      : 'PromptPay payment';
  const qrFallbackImageSrc = qrFallback && qrFallback.dataUrl
    ? qrFallback.dataUrl
    : qrFallback && qrFallback.svg
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrFallback.svg)}`
      : '';

  const messageStyle = messageKind === 'success'
    ? successBox
    : messageKind === 'error'
      ? errorBox
      : messageKind === 'processing'
        ? processingBox
        : infoBox;

  return (
    <main className="tenant-public-shell" style={wrap}>
      <section className="tenant-public-hero">
        <div>
          <div className="tenant-public-eyebrow">{paymentEyebrow}</div>
          <h1 className="tenant-public-title">ชำระบิล</h1>
          <p className="tenant-public-lead">
            ตรวจยอด สแกน QR แล้วแนบสลิปจากหน้านี้เพื่อให้ระบบตรวจสอบรายการชำระเงิน
          </p>
          <div className="tenant-guide-list" aria-label="ขั้นตอนชำระเงิน">
            <span className="tenant-guide-chip">สแกน QR</span>
            <span className="tenant-guide-chip">แนบสลิปชัดเจน</span>
            <span className="tenant-guide-chip">รอสถานะยืนยัน</span>
          </div>
        </div>
        <img className="tenant-public-art" src="/assets/tenant/mascot-payment.png" alt="" loading="eager" />
      </section>

      <section className="tenant-pay-panel" style={panel}>
        <div style={topline}>ชำระบิล</div>
        {loading ? <p style={muted}>กำลังโหลดข้อมูลบิล...</p> : null}
        {err ? <div style={errorBox}>{err}</div> : null}

        {bill ? (
          <>
            <header style={header}>
              <div>
                <h1 style={h1}>{bill.billNo || `บิล #${bill.id}`}</h1>
                <div style={muted}>ห้อง {bill.roomId || '-'} · รอบ {bill.period || '-'}</div>
                <div style={muted}>กำหนดชำระ {bill.dueDate || '-'}</div>
              </div>
              <span style={{ ...pill, color: statusColor(bill.status), background: `${statusColor(bill.status)}22` }}>
                {statusText(bill.status)}
              </span>
            </header>

            <div style={amountBox}>
              <div style={muted}>ยอดชำระ</div>
              <div style={amountText}>฿{fmt(bill.total)}</div>
            </div>

            <BillBreakdown bill={bill} />

            {uploadState ? (
              <div style={uploadState.blocked ? errorBox : infoBox}>
                <div style={{ fontWeight: 700 }}>อัปโหลดสลิปแล้ว: {uploadState.used}/{uploadState.max} ครั้ง</div>
                <div>เหลือ: {uploadState.remaining} ครั้ง</div>
                {uploadState.latest ? (
                  <div>สถานะล่าสุด: {uploadState.latest.status}{uploadState.latest.rejected_reason ? ` · ${tenantRejectedReason(uploadState.latest.rejected_reason)}` : ''}</div>
                ) : null}
                {uploadState.blocked ? <div style={{ marginTop: 4 }}>{blockMessage(uploadState)}</div> : null}
              </div>
            ) : null}

            {paid ? (
              <div style={successBox}>บิลนี้ชำระสำเร็จแล้ว ไม่ต้องแนบสลิปเพิ่มเติม</div>
            ) : null}

            {!paid && data.qrUrl ? (
              <div style={card}>
                <div style={{ fontWeight: 600, marginBottom: 10 }}>สแกน PromptPay</div>
                {!qrFallback ? (
                  <img
                    src={data.qrUrl}
                    alt="PromptPay QR"
                    width="180"
                    height="180"
                    style={qr}
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                      loadQrFallback();
                    }}
                  />
                ) : null}
                {qrFallbackImageSrc ? (
                  <img src={qrFallbackImageSrc} alt="PromptPay QR fallback" width="180" height="180" style={qr} />
                ) : null}
                {qrFallback ? (
                  <div style={qrFallback.payload ? qrFallbackBox : errorBox}>
                    <div style={{ fontWeight: 700 }}>
                      {qrFallback.payload ? 'ระบบใช้ช่องทางสำรองสำหรับ QR นี้' : 'ไม่สามารถแสดง QR ได้'}
                    </div>
                    <div style={{ fontSize: 12.5, marginTop: 4 }}>
                      {qrFallback.payload
                        ? 'หากสแกนไม่ได้ ให้คัดลอก PromptPay payload ไปวางในแอปธนาคาร หรือโอนผ่านบัญชีธนาคารด้านล่าง'
                        : qrFallback.error || 'กรุณาโอนผ่านบัญชีธนาคารด้านล่างหรือแจ้งแอดมิน'}
                    </div>
                    {qrFallback.payload ? (
                      <>
                        <textarea
                          readOnly
                          value={qrFallback.payload}
                          onClick={(e) => e.target.select()}
                          style={payloadInput}
                        />
                        <button
                          type="button"
                          style={secondaryButton}
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(qrFallback.payload);
                              setQrCopied(true);
                              setTimeout(() => setQrCopied(false), 2000);
                            } catch {
                              setQrCopied('manual');
                              setTimeout(() => setQrCopied(false), 3000);
                            }
                          }}
                        >
                          {qrCopied === true
                            ? 'คัดลอกแล้ว'
                            : qrCopied === 'manual'
                              ? 'เลือกข้อความแล้ว กด Ctrl+C เพื่อคัดลอก'
                              : 'คัดลอก payload'}
                        </button>
                        <div style={{ fontSize: 11.5, marginTop: 6 }}>
                          ยอด ฿{fmt(qrFallback.amount || bill.total)}
                          {qrFallback.targetLast4 ? ` · บัญชีลงท้าย ${qrFallback.targetLast4}` : ''}
                        </div>
                      </>
                    ) : null}
                  </div>
                ) : null}
                {data.payment && data.payment.promptpayName ? <div style={muted}>{data.payment.promptpayName}</div> : null}
              </div>
            ) : null}

            {!paid && data.payment && data.payment.bankInfo && data.payment.bankInfo.account ? (
              <div style={card}>
                <div style={{ fontWeight: 600 }}>โอนผ่านธนาคาร</div>
                <div>{data.payment.bankInfo.bank || '-'}</div>
                <div style={{ fontFamily: 'Sora, monospace', fontWeight: 600 }}>{data.payment.bankInfo.account}</div>
                {data.payment.bankInfo.name ? <div style={muted}>{data.payment.bankInfo.name}</div> : null}
              </div>
            ) : null}

            {!paid && data.payment && data.payment.walletInfo && data.payment.walletInfo.phone ? (
              <div style={card}>
                <div style={{ fontWeight: 600 }}>TrueMoney Wallet</div>
                <div style={{ fontFamily: 'Sora, monospace', fontWeight: 600 }}>{data.payment.walletInfo.phone}</div>
                {data.payment.walletInfo.name ? <div style={muted}>{data.payment.walletInfo.name}</div> : null}
                {data.payment.walletInfo.note ? <div style={muted}>{data.payment.walletInfo.note}</div> : null}
                <div style={{ ...muted, marginTop: 6 }}>Transfer to this wallet, then upload the slip below.</div>
              </div>
            ) : null}

            {!paid && data.payment && Array.isArray(data.payment.paymentMethods)
              && data.payment.paymentMethods.some((m) => m && m.enabled && !['promptpay', 'bank', 'truemoney'].includes(m.key)) ? (
              <div style={card}>
                <div style={{ fontWeight: 600 }}>ช่องทางอื่นที่รับชำระ</div>
                {data.payment.paymentMethods
                  .filter((m) => m && m.enabled && !['promptpay', 'bank', 'truemoney'].includes(m.key))
                  .map((m) => <div key={m.key} style={muted}>{m.label}</div>)}
              </div>
            ) : null}

            {canUpload ? (
              <div style={card}>
                <label style={label}>จำนวนเงิน</label>
                <input style={input} type="number" step="0.01" value={amount} readOnly />
                <label style={label}>รูปสลิป</label>
                <input key={fileInputKey} type="file" accept="image/jpeg,image/png,image/webp" disabled={busy}
                  onChange={(e) => {
                    // Client-side size guard so a 4G tenant doesn't waste
                    // 30s uploading a 10MB photo only to hit the server's
                    // 5MB cap. Mirror the limit on the tenant portal.
                    const f = e.target.files[0] || null;
                    if (f && f.size > 5 * 1024 * 1024) {
                      alert('ไฟล์ใหญ่เกินไป (เกิน 5 MB) — โปรดถ่ายใหม่หรือลดขนาดภาพก่อน');
                      e.target.value = '';
                      setFile(null);
                      return;
                    }
                    setFile(f);
                  }} />
                <div style={{ fontSize: 11.5, color: 'var(--muted)', margin: '6px 0 8px' }}>
                  ภาพต้องชัด เห็น QR/หมายเลขอ้างอิงครบ · JPG/PNG/WebP · ไม่เกิน 5 MB
                </div>
                <button style={button} disabled={busy} onClick={upload}>
                  {busy ? 'กำลังประมวลผล...' : 'อัปโหลดสลิป'}
                </button>
                {message ? <div style={messageStyle}>{message}</div> : null}
              </div>
            ) : null}

            {!paid && !canUpload ? (
              <div style={errorBox}>{blockMessage(uploadState)}</div>
            ) : null}
          </>
        ) : null}
      </section>
    </main>
  );
}

const wrap = {
  minHeight: '100vh',
  padding: '28px 0 80px',
};
const panel = {
  width: '100%',
  maxWidth: 640,
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: 20,
  boxShadow: '0 14px 36px -24px rgba(0,0,0,.35)',
};
const header = { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' };
const topline = { color: 'var(--accent)', fontWeight: 700, fontSize: 13, marginBottom: 8 };
const h1 = { margin: 0, fontSize: 24, fontFamily: 'Sora, sans-serif', letterSpacing: 0 };
const muted = { color: 'var(--muted)', fontSize: 13 };
const pill = { display: 'inline-block', padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' };
const amountBox = { marginTop: 18, padding: 16, border: '1px solid var(--border)', borderRadius: 8, background: '#fffaf2' };
const amountText = { fontFamily: 'Sora, sans-serif', fontSize: 34, fontWeight: 700 };
const breakdownCard = { marginTop: 14, padding: 14, border: '1px solid var(--border)', borderRadius: 8, background: '#fff' };
const breakdownHeader = { display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline', marginBottom: 8, flexWrap: 'wrap' };
const breakdownList = { display: 'grid', gap: 0, borderTop: '1px solid var(--border)' };
const breakdownRow = { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)', alignItems: 'start' };
const breakdownLabel = { fontWeight: 700, color: 'var(--text)' };
const breakdownMeta = { marginTop: 2, color: 'var(--muted)', fontSize: 12.5 };
const breakdownDetail = { marginTop: 3, color: 'var(--muted)', fontSize: 12.5, lineHeight: 1.45 };
const breakdownAmount = { fontFamily: 'Sora, sans-serif', fontWeight: 700, whiteSpace: 'nowrap', color: 'var(--text)' };
const breakdownTotal = { display: 'flex', justifyContent: 'space-between', gap: 12, paddingTop: 12, fontFamily: 'Sora, sans-serif', color: 'var(--text)' };
const card = { marginTop: 14, padding: 14, border: '1px solid var(--border)', borderRadius: 8 };
const qr = { display: 'block', margin: '0 auto 8px', background: '#fff', border: '1px solid var(--border)', borderRadius: 8, padding: 6 };
const qrFallbackBox = { marginTop: 10, padding: 12, background: '#fff8e6', border: '1px solid #ead49a', borderRadius: 8, color: '#6b5b1a', lineHeight: 1.5 };
const payloadInput = { width: '100%', minHeight: 64, marginTop: 8, padding: 8, border: '1px solid var(--border)', borderRadius: 6, background: '#fff', fontFamily: 'Sora, monospace', fontSize: 11, resize: 'none' };
const secondaryButton = { marginTop: 8, padding: '7px 12px', border: '1px solid var(--border)', borderRadius: 6, background: '#fff', color: 'var(--text)', font: 'inherit', fontSize: 13, fontWeight: 700, cursor: 'pointer' };
const label = { display: 'block', fontSize: 13, fontWeight: 600, margin: '10px 0 6px' };
const input = { width: '100%', height: 42, padding: '0 12px', borderRadius: 6, border: '1px solid var(--border)', font: 'inherit' };
const button = { marginTop: 14, width: '100%', height: 44, border: 0, borderRadius: 6, background: 'var(--accent)', color: '#fff', font: 'inherit', fontWeight: 700, cursor: 'pointer' };
const infoBox = { marginTop: 12, padding: 12, background: '#f3f7ff', border: '1px solid #c7d8f5', borderRadius: 8, color: '#315a9c', lineHeight: 1.5, whiteSpace: 'pre-line' };
const processingBox = { marginTop: 12, padding: 12, background: '#fff8e6', border: '1px solid #ead49a', borderRadius: 8, color: 'var(--amber)', lineHeight: 1.5, whiteSpace: 'pre-line' };
const successBox = { marginTop: 14, padding: 12, background: '#eef8f1', border: '1px solid #bee4ca', borderRadius: 8, color: 'var(--green)', fontWeight: 600, whiteSpace: 'pre-line' };
const errorBox = { marginTop: 12, padding: 12, background: '#fff4f1', border: '1px solid #f3c2b8', borderRadius: 8, color: 'var(--red)', lineHeight: 1.5, whiteSpace: 'pre-line' };

ReactDOM.createRoot(document.getElementById('root')).render(
  <PayPageErrorBoundary>
    <App />
  </PayPageErrorBoundary>
);
