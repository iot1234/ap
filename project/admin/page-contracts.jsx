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
  const [signing, setSigning] = useState(null);     // contract being signed online
  const [assigning, setAssigning] = useState(null); // contract for template assignment
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
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      <Btn size="sm" variant="ghost" onClick={() => openPdf(c)}
                        title="ดู PDF (ใช้ template ที่ผูกไว้ หรือ default)">📄 PDF</Btn>
                      <Btn size="sm" variant="ghost" onClick={() => openPdf(c, { download: 1 })}
                        title="ดาวน์โหลด PDF เพื่อ print">⬇</Btn>
                      {c.status === 'active' && !c.signed_at ? (
                        <Btn size="sm" variant="ghost" onClick={() => setSigning(c)}
                          title="ลงนามออนไลน์">✍️ เซ็น</Btn>
                      ) : null}
                      <Btn size="sm" variant="ghost" onClick={() => setAssigning(c)}
                        title="เลือก template สำหรับสัญญานี้">🎨</Btn>
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
    </PageContainer>
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
  const apiCall = window.apiCall;
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
      onError && onError('ลงนามล้มเหลว: ' + err.message);
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
  const apiCall = window.apiCall;
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
      onError && onError('บันทึกล้มเหลว: ' + err.message);
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
          background: tid === '' ? '#fff7ee' : 'transparent',
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
            background: tid === String(t.id) || tid === t.id ? '#fff7ee' : 'transparent',
          }}>
            <input type="radio" checked={tid === String(t.id) || tid === t.id}
              onChange={() => setTid(String(t.id))}
              style={{ marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>
                {t.name}
                {t.is_default ? <span style={{ marginLeft: 6, fontSize: 10, color: '#92651a' }}>⭐</span> : null}
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
