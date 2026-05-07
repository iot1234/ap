// === admin/page-billing.jsx ===============================================
// บิลและการเงิน: รายการบิลเดือนนี้, ยังไม่ชำระ, ค้างชำระ, ออกบิล
// ===========================================================================

const { useState, useMemo } = React;

function PageBilling({ rooms, setRooms, config, addActivity, setToast }) {
  const C = window.ADMIN_C;
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES;
  const { fmt, fmtCurrency, fmtMonthTH } = window;
  const { Card, Btn, IconBtn, Avatar, Pill, KpiCard, DataTable, Modal, Toggle,
          PageContainer, PageHeader, SectionHeading, DefList, Tabs, EmptyState } = window;

  const [tab, setTab] = useState('current');
  const [selected, setSelected] = useState(new Set());
  const [confirmGenerate, setConfirmGenerate] = useState(false);
  const [previewBill, setPreviewBill] = useState(null);

  // Generate bills from rooms — recompute with CURRENT config rates so
  // changes in Pricing engine reflect immediately in this month's bills
  const bills = useMemo(() => {
    const waterRate = config.utilities?.waterRate ?? 18;
    const elecRate  = config.utilities?.elecRate  ?? 8;
    const wifiFee   = config.utilities?.wifi      ?? 250;
    return Object.values(rooms)
      .filter(r => r.tenant && (r.status === 'occupied' || r.status === 'overdue'))
      .map(r => {
        const water = (r.waterUnits || 0) * waterRate;
        const elec  = (r.elecUnits  || 0) * elecRate;
        const wifi  = (r.wifi != null && r.wifi !== 0) ? r.wifi : wifiFee;
        // Pending charges are tickets-completed-with-cost that haven't been
        // settled yet. Each charge becomes a line on this month's bill.
        const charges = Array.isArray(r.pendingCharges) ? r.pendingCharges : [];
        const chargesTotal = charges.reduce((s, c) => s + (Number(c.amount) || 0), 0);
        const total = r.rent + water + elec + wifi + chargesTotal;
        const overdue = r.status === 'overdue';
        const penalty = overdue ? (r.overdueDays || 0) * (config.fees?.latePenaltyPerDay || 0) : 0;
        const grandTotal = total + penalty;
        const now = new Date();
        // Period in ISO YYYY-MM (server schema requires this) — was Thai
        // text which made bill_no unicode and didn't match scheduler's ISO
        // period, so the same room/month produced two different bill rows.
        const periodIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        // Display period in Thai for the UI; ISO is for the API + bill_no.
        const periodDisplay = fmtMonthTH(now);
        // Due date in ISO YYYY-MM-DD (also schema-required). Uses
        // config.notify.dueOnDay if set, else 7th.
        const dueDay = Math.max(1, Math.min(28, Number(config.notify?.dueOnDay) || 7));
        const dueIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(dueDay).padStart(2, '0')}`;
        return {
          id: `INV-${periodIso}-${r.id}`,
          roomId: r.id,
          tenant: r.tenant.name,
          phone: r.tenant.phone,
          period: periodIso,            // for API
          periodDisplay,                 // for UI
          rent: r.rent,
          water, elec, wifi,
          waterUnits: r.waterUnits,
          elecUnits: r.elecUnits,
          charges,
          chargesTotal,
          subtotal: total,
          penalty,
          total: grandTotal,
          dueDate: dueIso,               // for API
          dueDateDisplay: `${dueDay} ${periodDisplay}`,
          // Bills default to 'unpaid'. Admin marks as paid via the row action,
          // which sets r.billPaidAt on the room. Without that, status was
          // mis-marked 'paid' for every non-overdue room — making the unpaid
          // tab empty and creating false reassurance.
          status: r.billPaidAt ? 'paid' : 'unpaid',
          overdueDays: r.overdueDays || 0,
        };
      });
  }, [rooms, config]);

  const filtered = useMemo(() => {
    if (tab === 'current') return bills;
    if (tab === 'unpaid')  return bills.filter(b => b.status === 'unpaid');
    if (tab === 'paid')    return bills.filter(b => b.status === 'paid');
    return bills;
  }, [bills, tab]);

  const stats = useMemo(() => {
    const issued = bills.length;
    const paidCount = bills.filter(b => b.status === 'paid').length;
    const unpaidCount = issued - paidCount;
    const totalRevenue = bills.filter(b => b.status === 'paid').reduce((s, b) => s + b.total, 0);
    const overdueAmt = bills.filter(b => b.status === 'unpaid').reduce((s, b) => s + b.total, 0);
    return { issued, paidCount, unpaidCount, totalRevenue, overdueAmt };
  }, [bills]);

  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map(b => b.id)));
  };

  const handleMarkPaid = (id) => {
    const bill = bills.find(b => b.id === id);
    if (!bill) return;
    // billPaidAt is the source of truth for status: 'paid'. Without it, the
    // useMemo recomputes status: 'unpaid' on next config change.
    setRooms(prev => ({
      ...prev,
      [bill.roomId]: {
        ...prev[bill.roomId],
        status: 'occupied',
        overdueDays: 0,
        billStatus: 'paid',
        billPaidAt: new Date().toISOString(),
      },
    }));
    addActivity && addActivity({ icon: '💳', text: `รับชำระบิล ${id} จำนวน ${fmtCurrency(bill.total)}`, type: 'payment' });
    setToast && setToast({ kind: 'success', message: `บันทึกชำระห้อง ${bill.roomId} แล้ว` });
  };

  // Undo a mark-paid. Clears billPaidAt + billStatus so the next bill recompute
  // returns this room to the unpaid bucket. Use case: admin clicked the wrong
  // row, or a payment turned out to bounce.
  const handleUnmarkPaid = (id) => {
    const bill = bills.find(b => b.id === id);
    if (!bill) return;
    setRooms(prev => {
      const r = prev[bill.roomId];
      if (!r) return prev;
      const { billPaidAt, billStatus, ...rest } = r;
      return { ...prev, [bill.roomId]: rest };
    });
    addActivity && addActivity({ icon: '↺', text: `ยกเลิกการชำระบิล ${id}`, type: 'payment' });
    setToast && setToast({ kind: 'info', message: `ยกเลิกการบันทึกชำระห้อง ${bill.roomId}` });
  };

  const handleSendReminder = async (id) => {
    const b = bills.find((x) => x.id === id);
    if (!b) return;
    try {
      const r = await fetch('/api/notify/bill', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantName: b.tenant, roomId: b.roomId,
          period: b.period, total: b.total, billNo: b.id,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.ok === false) {
        const err = (d && d.error) || `HTTP ${r.status}`;
        setToast && setToast({ kind: 'error', message: `ส่งเตือนไม่สำเร็จ: ${err}` });
        return;
      }
      setToast && setToast({ kind: 'success', message: `ส่งเตือนบิล ${id} ทาง LINE แล้ว` });
      addActivity && addActivity({ icon: '🔔', text: `ส่งเตือนชำระบิล ${id}`, type: 'system' });
    } catch (e) {
      setToast && setToast({ kind: 'error', message: `ส่งเตือนไม่สำเร็จ: ${e.message}` });
    }
  };

  const handleGenerate = async () => {
    // Use the server-side /api/bills/bulk-generate which writes every
    // occupied room's bill in one transaction. Faster + atomic + uses
    // services/billing.js (single source of truth for VAT, late fee, etc).
    setConfirmGenerate(false);
    const apiFetch = window.apiFetch || fetch;
    try {
      const now = new Date();
      const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const dueDay = Number(config.notify?.dueOnDay) || 7;
      const r = await apiFetch('/api/bills/bulk-generate', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period, dueDay }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'failed');
      addActivity && addActivity({ icon: '📋', text: `ออกบิลรอบ ${period}: ${d.made} ใบ (ข้าม ${d.skipped})`, type: 'billing' });
      setToast && setToast({
        kind: d.made > 0 ? 'success' : 'info',
        message: `ออกบิล ${d.made} ใบ${d.skipped ? ` (ข้าม ${d.skipped})` : ''}`,
      });
    } catch (e) {
      setToast && setToast({ kind: 'error', message: 'ออกบิลไม่สำเร็จ: ' + (e.message || 'unknown') });
    }
  };

  // Bulk-send all pending/overdue bills via LINE+email.
  const handleBulkSend = async () => {
    if (!window.confirm('ส่งแจ้งเตือนทุกบิลที่ยังไม่ชำระ/ค้างชำระทาง LINE+อีเมล?')) return;
    const apiFetch = window.apiFetch || fetch;
    try {
      const r = await apiFetch('/api/bills/bulk-send', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'failed');
      setToast && setToast({
        kind: d.enqueued > 0 ? 'success' : 'info',
        message: `จัดคิวแล้ว ${d.enqueued}/${d.attempted} ใบ${d.failed ? ` (พลาด ${d.failed})` : ''}`,
      });
      addActivity && addActivity({ icon: '🔔', text: `ส่งเตือนทุกบิลค้าง: ${d.enqueued} ใบ`, type: 'system' });
    } catch (e) {
      setToast && setToast({ kind: 'error', message: 'ส่งไม่สำเร็จ: ' + e.message });
    }
  };

  const columns = [
    {
      key: 'select', label: '', minWidth: 36, width: 36,
      render: b => (
        <input
          type="checkbox"
          checked={selected.has(b.id)}
          onChange={(e) => { e.stopPropagation(); toggleSelect(b.id); }}
          onClick={(e) => e.stopPropagation()}
          style={{ cursor: 'pointer', accentColor: C.accent }}
        />
      ),
    },
    {
      key: 'id', label: 'เลขที่', minWidth: 170,
      render: b => <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>{b.id}</span>,
    },
    {
      key: 'roomId', label: 'ห้อง', minWidth: 70,
      render: b => <span style={{ fontWeight: 600, fontFamily: 'Sora, sans-serif' }}>{b.roomId}</span>,
    },
    {
      key: 'tenant', label: 'ผู้เช่า', minWidth: 180,
      render: b => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Avatar name={b.tenant} size={28} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, color: C.ink, fontWeight: 500 }}>{b.tenant}</div>
            <div style={{ fontSize: 11, color: C.muted }}>{b.phone}</div>
          </div>
        </div>
      ),
    },
    { key: 'period', label: 'งวด', minWidth: 100, render: b => <span style={{ fontSize: 12.5 }}>{b.periodDisplay || b.period}</span> },
    {
      key: 'total', label: 'รวม', align: 'right', minWidth: 120,
      render: b => (
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: C.ink, fontFamily: 'Sora, sans-serif' }}>
            {fmtCurrency(b.total)}
          </div>
          {b.penalty > 0 && (
            <div style={{ fontSize: 11, color: C.danger }}>+ ปรับ {fmtCurrency(b.penalty)}</div>
          )}
        </div>
      ),
    },
    {
      key: 'status', label: 'สถานะ', minWidth: 120,
      render: b => b.status === 'paid'
        ? <Pill color="success" size="sm" icon="✓">ชำระแล้ว</Pill>
        : <Pill color="danger" size="sm">ค้าง {b.overdueDays} วัน</Pill>,
    },
    {
      key: 'actions', label: '', align: 'right', minWidth: 130,
      render: b => (
        <div style={{ display: 'inline-flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
          <IconBtn icon="👁" label="ดูบิล" onClick={() => setPreviewBill(b)} />
          {b.status === 'unpaid' && (
            <>
              <IconBtn icon="🔔" label="ส่งเตือน" onClick={() => handleSendReminder(b.id)} />
              <IconBtn icon="✓" label="บันทึกชำระ" onClick={() => handleMarkPaid(b.id)} />
            </>
          )}
          {b.status === 'paid' && (
            <IconBtn icon="↺" label="ยกเลิกการชำระ" onClick={() => handleUnmarkPaid(b.id)} />
          )}
        </div>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        title="บิลและการเงิน"
        subtitle={`เดือน ${fmtMonthTH(new Date())} · ${bills.length} ใบ`}
        actions={
          <>
            <Btn variant="secondary" icon="📤" onClick={() => {
              if (window.exportBillsCSV(bills)) {
                addActivity && addActivity({ icon: '📤', text: `ส่งออกบิลเดือนนี้ ${bills.length} ใบ เป็น CSV`, type: 'system' });
                setToast && setToast({ kind: 'success', message: `ดาวน์โหลด CSV ${bills.length} ใบเรียบร้อย` });
              }
            }}>ส่งออก CSV</Btn>
            <Btn variant="primary" icon="📋" onClick={() => setConfirmGenerate(true)}>
              ออกบิลรายเดือน
            </Btn>
            <Btn icon="🔔" onClick={handleBulkSend}>
              ส่งเตือนทั้งหมด
            </Btn>
          </>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 20 }}>
        <KpiCard label="บิลที่ออก"     value={fmt(stats.issued)}     sub="ใบประจำเดือน" icon="📋" />
        <KpiCard label="ชำระแล้ว"       value={fmt(stats.paidCount)} sub={fmtCurrency(stats.totalRevenue)} color="success" icon="✓" />
        <KpiCard label="ค้างชำระ"        value={fmt(stats.unpaidCount)} sub={fmtCurrency(stats.overdueAmt)} color="danger" icon="⚠️" />
        <KpiCard label="อัตราการชำระ" value={stats.issued ? Math.round(stats.paidCount/stats.issued*100) + '%' : '-'} color="info" icon="📊" />
      </div>

      <Tabs
        items={[
          { value: 'current', label: 'เดือนนี้',   count: bills.length },
          { value: 'unpaid',  label: 'ค้างชำระ',  count: stats.unpaidCount },
          { value: 'paid',    label: 'ชำระแล้ว',  count: stats.paidCount },
        ]}
        value={tab}
        onChange={setTab}
        variant="pills"
        style={{ marginBottom: 14 }}
      />

      {selected.size > 0 && (
        <Card style={{
          marginBottom: 12, padding: 12,
          background: C.dark, borderColor: C.dark,
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <span style={{ color: '#fff', fontSize: 13, fontWeight: 500 }}>
            เลือกแล้ว {selected.size} รายการ
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <Btn variant="soft" size="sm" icon="🔔" onClick={async () => {
              const ids = [...selected];
              const targets = bills.filter((b) => ids.includes(b.id));
              let okCount = 0, failCount = 0, skip = false;
              for (const b of targets) {
                try {
                  const r = await fetch('/api/notify/bill', {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      billNo: b.id, roomId: b.roomId, tenantName: b.tenant,
                      period: b.period, total: b.total,
                    }),
                  });
                  if (r.status === 503) { skip = true; break; }
                  if (r.ok) {
                    okCount++;
                    addActivity && addActivity({ icon: '🔔', text: `ส่งเตือนชำระบิล ${b.id}`, type: 'system' });
                  } else failCount++;
                } catch { failCount++; }
              }
              if (skip) {
                setToast && setToast({ kind: 'error', message: 'ระบบยังไม่ได้ตั้งค่า LINE — ตั้งค่าก่อนใช้บัลก์' });
              } else if (failCount === 0) {
                setToast && setToast({ kind: 'success', message: `ส่งเตือน ${okCount} รายการเรียบร้อย` });
              } else {
                setToast && setToast({ kind: 'info', message: `สำเร็จ ${okCount} · ล้มเหลว ${failCount}` });
              }
              setSelected(new Set());
            }}>ส่งเตือนทั้งหมด</Btn>
            <Btn variant="soft" size="sm" icon="📥" onClick={() => {
              const selectedBills = bills.filter(b => selected.has(b.id));
              if (window.exportBillsCSV(selectedBills)) {
                setToast && setToast({ kind: 'success', message: `ดาวน์โหลด ${selectedBills.length} บิลเรียบร้อย` });
              }
            }}>ดาวน์โหลด CSV</Btn>
            <Btn variant="soft" size="sm" icon="✓" onClick={() => {
              const ids = [...selected];
              ids.forEach(id => {
                const bill = bills.find(b => b.id === id);
                if (bill && bill.status === 'unpaid') handleMarkPaid(id);
              });
              setSelected(new Set());
            }}>บันทึกชำระทั้งหมด</Btn>
            <Btn variant="ghost" size="sm" onClick={() => setSelected(new Set())} style={{ color: '#fff' }}>ยกเลิกเลือก</Btn>
          </div>
        </Card>
      )}

      <DataTable
        columns={columns}
        rows={filtered}
        onRowClick={(b) => setPreviewBill(b)}
        empty={<EmptyState icon="🧾" title="ยังไม่มีบิล" />}
      />

      <Modal
        open={confirmGenerate}
        onClose={() => setConfirmGenerate(false)}
        title="ออกบิลประจำเดือน"
        footer={
          <>
            <Btn variant="ghost" onClick={() => setConfirmGenerate(false)}>ยกเลิก</Btn>
            <Btn variant="primary" onClick={handleGenerate}>ออกบิล {bills.length} ใบ</Btn>
          </>
        }
      >
        <div style={{ fontSize: 14, color: C.ink2, lineHeight: 1.6, marginBottom: 12 }}>
          ระบบจะออกบิลสำหรับห้องที่มีผู้เช่าทั้งหมด <b style={{ color: C.ink }}>{bills.length} ห้อง</b>
        </div>
        <div style={{
          padding: 12, background: C.surfaceAlt, borderRadius: 8,
          fontSize: 12.5, color: C.ink2,
        }}>
          <div>📅 ครบกำหนดชำระ: <b>วันที่ {config.notify?.dueOnDay ?? 7} ของเดือน</b></div>
          <div>💰 ยอดรวมโดยประมาณ: <b>{fmtCurrency(bills.reduce((s,b) => s+b.total, 0))}</b></div>
          <div>📨 ส่งทาง: LINE, Email</div>
        </div>
      </Modal>

      <Modal
        open={!!previewBill}
        onClose={() => setPreviewBill(null)}
        title={previewBill ? `บิล ${previewBill.id}` : ''}
        width={520}
        footer={previewBill && (
          <>
            <Btn variant="ghost" onClick={() => setPreviewBill(null)}>ปิด</Btn>
            <Btn variant="secondary" icon="📥" onClick={async () => {
              const b = previewBill;
              // Build the bill payload matching services/pdf.js renderBillPdf shape.
              const items = [
                { label: 'ค่าเช่าห้อง', amount: b.rent || 0 },
                { label: 'ค่าน้ำประปา', qty: `${b.waterUnits || 0} หน่วย`, amount: b.water || 0 },
                { label: 'ค่าไฟฟ้า', qty: `${b.elecUnits || 0} หน่วย`, amount: b.elec || 0 },
                { label: 'ค่า Wi-Fi', amount: b.wifi || 0 },
              ];
              // Maintenance / repair charges from completed tickets.
              if (Array.isArray(b.charges)) {
                b.charges.forEach((c) => items.push({ label: c.label, amount: Number(c.amount) || 0 }));
              }
              if (b.penalty > 0) {
                items.push({ label: `ค่าปรับล่าช้า (${b.overdueDays || 0} วัน)`, amount: b.penalty });
              }
              // Server enriches with payment fields from config.payment via
              // services/billing.buildPaymentBlock. Client only sends the
              // bill basics + config blob; the field-extraction logic lives
              // in one place so client and PDF renderer can't drift.
              const payload = {
                billNo: b.id,
                roomId: b.roomId,
                tenantName: b.tenant,
                tenantPhone: b.phone,
                period: b.period,
                dueDate: b.dueDate,
                items,
                total: b.total,
                building: (config && config.building) || { name: 'บ้านกาญจน์ เรสซิเดนซ์' },
              };
              try {
                const res = await fetch('/api/bills/render', {
                  method: 'POST',
                  credentials: 'include',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ bill: payload, config }),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `bill_${b.id}.pdf`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
                setToast && setToast({ kind: 'success', message: `ดาวน์โหลดบิล ${b.id} เรียบร้อย` });
                addActivity && addActivity({ icon: '📥', text: `ดาวน์โหลดบิล ${b.id} (PDF)`, type: 'billing' });
              } catch (err) {
                console.error('PDF download failed:', err);
                setToast && setToast({ kind: 'error', message: 'ดาวน์โหลดบิลไม่สำเร็จ' });
              }
            }}>ดาวน์โหลด PDF</Btn>
            <Btn variant="primary" icon="📨" onClick={async () => {
              const b = previewBill;
              try {
                const res = await fetch('/api/notify/bill', {
                  method: 'POST',
                  credentials: 'include',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    billNo: b.id,
                    roomId: b.roomId,
                    tenantName: b.tenant,
                    period: b.period,
                    total: b.total,
                  }),
                });
                const data = await res.json().catch(() => ({}));
                if (res.status === 503) {
                  setToast && setToast({ kind: 'error', message: 'ระบบยังไม่ได้ตั้งค่า LINE' });
                  return;
                }
                if (!res.ok || !data.ok) {
                  setToast && setToast({ kind: 'error', message: data.error || 'ส่งแจ้งเตือนไม่สำเร็จ' });
                  return;
                }
                setToast && setToast({ kind: 'success', message: `ส่งบิล ${b.id} ทาง LINE แล้ว` });
                addActivity && addActivity({ icon: '📨', text: `ส่งบิล ${b.id} ให้ ${b.tenant}`, type: 'billing' });
                setPreviewBill(null);
              } catch (err) {
                console.error('notify bill failed:', err);
                setToast && setToast({ kind: 'error', message: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' });
              }
            }}>ส่งให้ผู้เช่า</Btn>
          </>
        )}
      >
        {previewBill && <BillPreview b={previewBill} />}
      </Modal>
    </PageContainer>
  );
}

function BillPreview({ b }) {
  const C = window.ADMIN_C;
  const { fmtCurrency } = window;
  const { Pill } = window;

  const rows = [
    { label: 'ค่าเช่ารายเดือน', value: b.rent },
    { label: `ค่าน้ำ (${b.waterUnits} หน่วย)`, value: b.water },
    { label: `ค่าไฟ (${b.elecUnits} หน่วย)`, value: b.elec },
    { label: 'ค่า Wi-Fi', value: b.wifi },
  ];
  if (b.penalty > 0) rows.push({ label: `ค่าปรับชำระล่าช้า (${b.overdueDays} วัน)`, value: b.penalty, danger: true });

  return (
    <div>
      <div style={{
        padding: 16, background: C.surfaceAlt, borderRadius: 10,
        marginBottom: 16,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div>
          <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 2 }}>เลขที่บิล</div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 14, fontWeight: 600, color: C.ink }}>{b.id}</div>
          <div style={{ fontSize: 12.5, color: C.muted, marginTop: 6 }}>{b.tenant} · ห้อง {b.roomId}</div>
        </div>
        {b.status === 'paid' ? <Pill color="success">ชำระแล้ว</Pill> : <Pill color="danger">ค้างชำระ</Pill>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px dashed ${C.borderSoft}` }}>
            <span style={{ fontSize: 13, color: r.danger ? C.danger : C.ink2 }}>{r.label}</span>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13.5, fontWeight: 500, color: r.danger ? C.danger : C.ink }}>
              {fmtCurrency(r.value)}
            </span>
          </div>
        ))}
      </div>

      <div style={{
        padding: 14, background: C.dark, borderRadius: 10, color: '#fff',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div>
          <div style={{ fontSize: 12, color: '#bcaf95' }}>ยอดรวมที่ต้องชำระ</div>
          <div style={{ fontSize: 11, color: '#8a7d6b', marginTop: 2 }}>ครบกำหนด {b.dueDateDisplay || b.dueDate}</div>
        </div>
        <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 24, fontWeight: 700 }}>
          {fmtCurrency(b.total)}
        </div>
      </div>
    </div>
  );
}

window.PageBilling = PageBilling;
