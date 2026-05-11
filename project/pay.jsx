const { useEffect, useMemo, useState } = React;

function fmt(n) {
  return Number(n || 0).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function readJson(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
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
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function load(silent = false) {
    if (!billId || !token) {
      setErr('ลิงก์ไม่ถูกต้องหรือหมดอายุ');
      setLoading(false);
      return;
    }
    try {
      const next = await fetch(apiBase, { credentials: 'same-origin' }).then(readJson);
      setData(next);
      setErr('');
      if (!amount && next.bill) setAmount(String(next.bill.total || ''));
    } catch (e) {
      if (!silent) setErr(e.message || 'โหลดข้อมูลไม่สำเร็จ');
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [apiBase]);

  useEffect(() => {
    if (!data || data.paid) return undefined;
    const timer = setInterval(() => load(true), 5000);
    return () => clearInterval(timer);
  }, [data && data.paid, apiBase]);

  async function upload() {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setMsg('กรุณาระบุจำนวนเงินให้ถูกต้อง');
      return;
    }
    if (!file) {
      setMsg('กรุณาแนบรูปสลิป');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const slip = await fileToDataUrl(file);
      const out = await fetch(uploadUrl, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: n, slip }),
      }).then(readJson);
      const st = out.payment && out.payment.status;
      if (st === 'verified') {
        setMsg('ชำระเงินสำเร็จ ระบบอัปเดตสถานะเรียบร้อยแล้ว');
      } else if (st === 'rejected') {
        setMsg(out.payment.rejected_reason || 'สลิปไม่ผ่านการตรวจสอบ กรุณาตรวจสอบและส่งใหม่');
      } else {
        setMsg('ได้รับสลิปแล้ว กำลังรอเจ้าหน้าที่ตรวจสอบ');
      }
      setFile(null);
      await load(true);
    } catch (e) {
      setMsg(e.message || 'อัปโหลดไม่สำเร็จ');
      await load(true);
    } finally {
      setBusy(false);
    }
  }

  const bill = data && data.bill;
  const paid = !!(data && data.paid);
  const canUpload = !!(data && data.channels && data.channels.slip && !paid);

  return (
    <main style={wrap}>
      <section style={panel}>
        <div style={topline}>ชำระบิล</div>
        {loading ? <p style={muted}>กำลังโหลดข้อมูลบิล...</p> : null}
        {err ? <div style={errorBox}>{err}</div> : null}
        {bill ? (
          <>
            <header style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
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
              <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 34, fontWeight: 700 }}>฿{fmt(bill.total)}</div>
            </div>

            {paid ? (
              <div style={successBox}>
                บิลนี้ชำระสำเร็จแล้ว ไม่ต้องแนบสลิปเพิ่มเติม
              </div>
            ) : null}

            {!paid && data.qrUrl ? (
              <div style={card}>
                <div style={{ fontWeight: 600, marginBottom: 10 }}>สแกน PromptPay</div>
                <img src={data.qrUrl} alt="PromptPay QR" width="180" height="180" style={qr} />
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

            {canUpload ? (
              <div style={card}>
                <label style={label}>จำนวนเงิน</label>
                <input style={input} type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
                <label style={label}>แนบรูปสลิป</label>
                <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files[0] || null)} />
                <button style={button} disabled={busy} onClick={upload}>
                  {busy ? 'กำลังอัปโหลด...' : 'อัปโหลดสลิป'}
                </button>
                {msg ? <div style={note}>{msg}</div> : null}
              </div>
            ) : null}

            {!paid && !canUpload ? (
              <div style={errorBox}>
                ระบบรับสลิปออนไลน์ยังไม่พร้อมใช้งาน กรุณาติดต่อสำนักงานหรือส่งสลิปผ่าน LINE ของหอพัก
              </div>
            ) : null}
          </>
        ) : null}
      </section>
    </main>
  );
}

const wrap = {
  minHeight: '100vh',
  display: 'grid',
  placeItems: 'start center',
  padding: '24px 14px',
};
const panel = {
  width: '100%',
  maxWidth: 560,
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: 20,
  boxShadow: '0 14px 36px -24px rgba(0,0,0,.35)',
};
const topline = { color: 'var(--accent)', fontWeight: 700, fontSize: 13, marginBottom: 8 };
const h1 = { margin: 0, fontSize: 24, fontFamily: 'Sora, sans-serif', letterSpacing: 0 };
const muted = { color: 'var(--muted)', fontSize: 13 };
const pill = { display: 'inline-block', padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' };
const amountBox = { marginTop: 18, padding: 16, border: '1px solid var(--border)', borderRadius: 8, background: '#fffaf2' };
const card = { marginTop: 14, padding: 14, border: '1px solid var(--border)', borderRadius: 8 };
const qr = { display: 'block', margin: '0 auto 8px', background: '#fff', border: '1px solid var(--border)', borderRadius: 8, padding: 6 };
const label = { display: 'block', fontSize: 13, fontWeight: 600, margin: '10px 0 6px' };
const input = { width: '100%', height: 42, padding: '0 12px', borderRadius: 6, border: '1px solid var(--border)', font: 'inherit' };
const button = { marginTop: 14, width: '100%', height: 44, border: 0, borderRadius: 6, background: 'var(--accent)', color: '#fff', font: 'inherit', fontWeight: 700, cursor: 'pointer' };
const note = { marginTop: 10, fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 };
const successBox = { marginTop: 14, padding: 12, background: '#eef8f1', border: '1px solid #bee4ca', borderRadius: 8, color: 'var(--green)', fontWeight: 600 };
const errorBox = { marginTop: 12, padding: 12, background: '#fff4f1', border: '1px solid #f3c2b8', borderRadius: 8, color: 'var(--red)', lineHeight: 1.5 };

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
