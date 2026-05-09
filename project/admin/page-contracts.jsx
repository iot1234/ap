// === admin/page-contracts.jsx ============================================
// List + edit lease contracts (contracts table). Mostly read-only with a
// targeted edit modal for discount_pct / term_months / end_date / status.
// Pairs with the scheduler.tickContractExpiry alert so admin sees what
// the alert is referencing.
// ===========================================================================

const { useState, useEffect, useMemo } = React;

function PageContracts({ setToast, addActivity }) {
  const C = window.ADMIN_C;
  const { Card, Btn, Input, Select, Modal, Pill, SectionHeading,
          PageContainer, PageHeader } = window;
  const apiCall = window.apiCall;

  const [contracts, setContracts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('active');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filter !== 'all') params.set('status', filter);
      const d = await apiCall(`/api/contracts?${params.toString()}`);
      setContracts(d.contracts || []);
    } catch (e) {
      setToast && setToast({ kind: 'danger', message: 'โหลดสัญญาล้มเหลว: ' + e.message });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { refresh(); }, [filter]);

  const filtered = useMemo(() => {
    if (!search) return contracts;
    const q = search.toLowerCase();
    return contracts.filter((c) =>
      String(c.contract_no || '').toLowerCase().includes(q) ||
      String(c.tenant_name || '').toLowerCase().includes(q) ||
      String(c.tenant_phone || '').includes(q) ||
      String(c.room_id || '').toLowerCase().includes(q)
    );
  }, [contracts, search]);

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
    const out = { all: contracts.length, active: 0, expired: 0, ended: 0, expiring: 0 };
    for (const c of contracts) {
      out[c.status] = (out[c.status] || 0) + 1;
      if (c.status === 'active' && c.days_left != null && c.days_left <= 30 && c.days_left >= 0) {
        out.expiring++;
      }
    }
    return out;
  }, [contracts]);

  return (
    <PageContainer>
      <PageHeader title="สัญญา" subtitle={`${counts.all} ฉบับในระบบ`} />
      <Card>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {[
            { key: 'active',  label: `มีผล (${counts.active})` },
            { key: 'expired', label: `หมดอายุ (${counts.expired})` },
            { key: 'ended',   label: `สิ้นสุด (${counts.ended})` },
            { key: 'all',     label: `ทั้งหมด (${counts.all})` },
          ].map((t) => (
            <button key={t.key} onClick={() => setFilter(t.key)}
              style={{
                padding: '6px 14px', borderRadius: 18, border: '1px solid ' + (filter === t.key ? C.accent : C.border),
                background: filter === t.key ? C.accent : C.surface,
                color: filter === t.key ? '#fff' : C.ink2,
                cursor: 'pointer', fontSize: 13, fontFamily: 'inherit',
              }}>{t.label}</button>
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
            marginTop: 12, padding: 10, background: '#fff7e0',
            border: '1px solid #f1b32d', borderRadius: 8,
            fontSize: 13, color: C.ink2,
          }}>
            ⏰ <b>{counts.expiring}</b> สัญญาจะหมดอายุภายใน 30 วัน — แนะนำติดต่อผู้เช่าเพื่อต่อสัญญา
          </div>
        ) : null}
      </Card>

      <Card style={{ padding: 0, marginTop: 12, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 30, textAlign: 'center', color: C.muted }}>กำลังโหลด…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: C.muted }}>ไม่มีสัญญา</div>
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
                {filtered.map((c) => (
                  <tr key={c.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td style={td}>{c.contract_no}</td>
                    <td style={td}>
                      <div style={{ fontWeight: 500 }}>{c.tenant_name || '-'}</div>
                      <div style={{ color: C.muted, fontSize: 11 }}>{c.tenant_phone || '-'}</div>
                    </td>
                    <td style={td}>{c.room_id || '-'}</td>
                    <td style={td}>{fmtDate(c.start_date)}</td>
                    <td style={td}>
                      {fmtDate(c.end_date)}
                      {c.status === 'active' && c.days_left != null && c.days_left <= 30 && c.days_left >= 0 ? (
                        <div style={{ fontSize: 11, color: '#c46a3e' }}>
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
                    </td>
                    <td style={td}>
                      <Btn size="sm" variant="ghost" onClick={() => setEditing(c)}>แก้ไข</Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing ? (
        <ContractEditModal
          contract={editing}
          onClose={() => setEditing(null)}
          onSaved={(c) => {
            setEditing(null);
            setToast && setToast({ kind: 'success', message: `บันทึก ${c.contract_no} แล้ว` });
            addActivity && addActivity({ icon: '📜', text: `แก้ไขสัญญา ${c.contract_no}`, type: 'system' });
            refresh();
          }}
          onError={(msg) => setToast && setToast({ kind: 'danger', message: msg })}
        />
      ) : null}
    </PageContainer>
  );
}

function ContractEditModal({ contract, onClose, onSaved, onError }) {
  const C = window.ADMIN_C;
  const { Modal, Btn, Input, Select } = window;
  const apiCall = window.apiCall;
  const [form, setForm] = useState({
    discountPct: contract.discount_pct != null ? String(contract.discount_pct) : '0',
    termMonths:  contract.term_months  != null ? String(contract.term_months)  : '',
    endDate:     contract.end_date ? String(contract.end_date).slice(0, 10) : '',
    status:      contract.status || 'active',
  });
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const payload = {};
      const pct = Number(form.discountPct);
      if (Number.isFinite(pct)) payload.discountPct = pct;
      if (form.termMonths === '') payload.termMonths = null;
      else if (form.termMonths != null) payload.termMonths = Number(form.termMonths);
      payload.endDate = form.endDate || null;
      payload.status = form.status;
      const d = await apiCall(`/api/contracts/${contract.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      onSaved && onSaved(d.contract);
    } catch (err) {
      onError && onError('บันทึกล้มเหลว: ' + (err.message || 'unknown'));
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
          <Btn variant="primary" onClick={submit} disabled={busy}>
            {busy ? '…' : 'บันทึก'}
          </Btn>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
          ผู้เช่า: <b>{contract.tenant_name || '-'}</b> · ห้อง <b>{contract.room_id || '-'}</b>
          <br />
          ค่าเช่า/เดือน: ฿{Number(contract.monthly_rent).toLocaleString('th-TH', { minimumFractionDigits: 2 })}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={lbl}>ส่วนลด (%) — สูงสุด 50</label>
            <input type="number" step="0.1" min="0" max="50" value={form.discountPct}
              onChange={(e) => setForm({ ...form, discountPct: e.target.value })}
              style={inp} />
          </div>
          <div>
            <label style={lbl}>ระยะสัญญา (เดือน)</label>
            <input type="number" step="1" min="1" max="120" value={form.termMonths}
              onChange={(e) => setForm({ ...form, termMonths: e.target.value })}
              style={inp} placeholder="เปิด-ไม่จำกัด" />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={lbl}>วันสิ้นสุด</label>
            <input type="date" value={form.endDate}
              onChange={(e) => setForm({ ...form, endDate: e.target.value })}
              style={inp} />
          </div>
          <div>
            <label style={lbl}>สถานะ</label>
            <select value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
              style={inp}>
              <option value="active">มีผล</option>
              <option value="expired">หมดอายุ</option>
              <option value="ended">สิ้นสุด</option>
            </select>
          </div>
        </div>
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

const th = {
  textAlign: 'left', padding: '10px 14px', fontWeight: 600, fontSize: 12,
  color: '#5b4f40', borderBottom: '1px solid #ece4d4',
};
const td = { padding: '10px 14px', verticalAlign: 'top' };
const lbl = { display: 'block', fontSize: 12, color: '#5b4f40', marginBottom: 4 };
const inp = {
  width: '100%', padding: '8px 10px', border: '1px solid #ece4d4',
  borderRadius: 6, fontSize: 13, fontFamily: 'inherit',
};

window.PageContracts = PageContracts;
