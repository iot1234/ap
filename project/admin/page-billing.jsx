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

  // Real bills from DB for the current period. Falls back to client estimate
  // (computed from rooms blob below) when no bills have been issued yet, so
  // the page still shows what bills WOULD look like — the difference is now
  // visible via `realBillsByRoom` so admin can tell estimate from issued.
  const currentPeriod = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }, []);
  const [dbBills, setDbBills] = React.useState(null);   // null = loading
  const [dbBillsErr, setDbBillsErr] = React.useState(null);
  const fetchDbBills = React.useCallback(() => {
    let cancel = false;
    setDbBills(null);
    setDbBillsErr(null);
    fetch(`/api/bills?period=${encodeURIComponent(currentPeriod)}&limit=500`, {
      credentials: 'same-origin',
    })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (cancel) return;
        if (!r.ok) { setDbBillsErr(d.error || `HTTP ${r.status}`); setDbBills([]); return; }
        setDbBills(Array.isArray(d.bills) ? d.bills : []);
      })
      .catch((e) => { if (!cancel) { setDbBillsErr(e.message || 'network error'); setDbBills([]); } });
    return () => { cancel = true; };
  }, [currentPeriod]);
  React.useEffect(() => fetchDbBills(), [fetchDbBills]);
  // Map room_id → real DB bill so the in-memory estimate can adopt the
  // real status / total for any room that's already been billed this month.
  const realBillsByRoom = useMemo(() => {
    const map = {};
    (dbBills || []).forEach((b) => { if (b.room_id) map[String(b.room_id)] = b; });
    return map;
  }, [dbBills]);

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
      })
      // Overlay real DB bill status on top of the estimate so the row
      // accurately reflects what was actually issued + collected. The
      // estimate stays as the breakdown source (waterUnits/elecUnits etc.
      // from the rooms blob), but status + total come from the bills row
      // when one exists for this room+period. The `_source` flag drives
      // the per-row "ออกแล้ว/ประมาณ" badge in the table.
      .map((est) => {
        const real = realBillsByRoom[String(est.roomId)];
        if (!real) return { ...est, _source: 'estimate' };
        return {
          ...est,
          _source: 'db',
          dbBillId: real.id,
          dbBillNo: real.bill_no,
          status: real.status === 'paid' ? 'paid' : 'unpaid',
          dbStatus: real.status,                     // pending / paid / overdue / void
          total: Number(real.total) || est.total,    // trust DB total over estimate
        };
      });
  }, [rooms, config, realBillsByRoom]);

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

  const handleMarkPaid = async (id, opts = {}) => {
    const bill = bills.find(b => b.id === id);
    if (!bill) return false;
    if (bill._source !== 'db' || !bill.dbBillId) {
      setToast && setToast({ kind: 'warning', message: 'ต้องออกบิลเข้าระบบก่อน จึงจะบันทึกการชำระได้' });
      return false;
    }
    if (opts.confirm !== false) {
      const ok = window.confirm(
        `ยืนยันบันทึกชำระบิล ${bill.dbBillNo || bill.dbBillId}\n` +
        `ห้อง ${bill.roomId} · ${fmtCurrency(bill.total)}`
      );
      if (!ok) return false;
    }
    try {
      await window.apiCall(`/api/bills/${bill.dbBillId}/pay`, {
        method: 'POST',
        body: JSON.stringify({
          method: 'transfer',
          amount: Number(bill.total) || 0,
          ref: `admin-billing:${bill.id}`,
        }),
      });
      addActivity && addActivity({ icon: '💳', text: `รับชำระบิล ${bill.dbBillNo || bill.dbBillId} จำนวน ${fmtCurrency(bill.total)}`, type: 'payment' });
      setToast && setToast({ kind: 'success', message: `บันทึกชำระห้อง ${bill.roomId} แล้ว` });
      if (opts.refresh !== false) fetchDbBills();
      return true;
    } catch (err) {
      window.toastError ? window.toastError(setToast, err, { action: 'บันทึกชำระ' })
        : setToast && setToast({ kind: 'error', message: err.message || 'บันทึกชำระไม่สำเร็จ' });
      return false;
    }
  };

  const handleUnmarkPaid = (id) => {
    const bill = bills.find(b => b.id === id);
    if (!bill) return;
    setToast && setToast({ kind: 'info', message: 'การยกเลิกชำระต้องทำผ่านการ void/reconcile เพื่อเก็บ audit trail' });
  };

  const handleSendReminder = async (id) => {
    const b = bills.find((x) => x.id === id);
    if (!b) return;
    // Pre-flight reachability: see if THIS specific tenant can actually
    // receive a notification. Without the check, admin clicks "ส่งเตือน"
    // on a tenant with no LINE binding and no email — the notifier
    // logs a "skipped" row and the admin thinks it was sent.
    try {
      const room = Object.values(rooms || {}).find((r) => r.id === b.roomId);
      const phone = room?.tenant?.phone ? String(room.tenant.phone).replace(/[\s-]/g, '') : null;
      let tenantRow = null;
      if (phone) {
        const r = await fetch(`/api/tenants?q=${encodeURIComponent(phone)}`, { credentials: 'same-origin' });
        if (r.ok) {
          const j = await r.json();
          tenantRow = (j.tenants || []).find((t) =>
            String(t.phone || '').replace(/[\s-]/g, '') === phone
          );
        }
      }
      const hasLine = !!tenantRow?.line_user_id;
      const hasEmail = !!(tenantRow?.email || room?.tenant?.email);
      if (!hasLine && !hasEmail) {
        // Hard block — sending will silently drop. Suggest the fix path.
        const ok = window.confirm(
          `⚠ ผู้เช่าห้อง ${b.roomId} (${b.tenant}) ยังไม่มีช่องทางส่ง\n\n` +
          `   ❌ ไม่ได้ผูก LINE\n` +
          `   ❌ ไม่ใส่อีเมล\n\n` +
          `กดยืนยันก็ส่งได้ — แต่ระบบจะ log "skipped: no channel" และข้อความจะไม่ถึงผู้เช่า\n\n` +
          `📌 แนะนำ: ยกเลิก แล้วไป /admin#tenants → tab "Portal Access" ผูก LINE ก่อน\n\n` +
          `ดำเนินการต่อ?`
        );
        if (!ok) return;
      } else if (!hasLine && hasEmail) {
        // Soft warn — email works but takes longer + spam folder risk
        const ok = window.confirm(
          `📧 ผู้เช่าห้อง ${b.roomId} ยังไม่ได้ผูก LINE — จะส่งทางอีเมลแทน\n\n` +
          `อีเมลอาจไปอยู่ในกล่อง spam ได้ — แนะนำให้ผูก LINE เพื่อความเร็ว\n\n` +
          `ส่งอีเมลต่อ?`
        );
        if (!ok) return;
      }
    } catch { /* fail-soft — pre-flight can't block on network error */ }

    const apiCall = window.apiCall;
    try {
      if (b._source === 'db' && b.dbBillId) {
        await apiCall(`/api/bills/${b.dbBillId}/send`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
      } else {
        await apiCall('/api/notify/bill', {
          method: 'POST',
          body: JSON.stringify({
            tenantName: b.tenant, roomId: b.roomId,
            period: b.period, total: b.total, billNo: b.id,
          }),
        });
      }
      setToast && setToast({ kind: 'success', message: `ส่งเตือนบิล ${id} ทาง LINE แล้ว` });
      addActivity && addActivity({ icon: '🔔', text: `ส่งเตือนชำระบิล ${id}`, type: 'system' });
    } catch (err) {
      window.toastError(setToast, err, { action: `ส่งเตือนบิล ${id}` });
    }
  };

  const handleGenerate = async () => {
    // Pre-flight config sanity check. Without these, admin can blindly
    // click "ออกบิล" and produce bills with: missing PromptPay (no QR
    // on PDFs), default rates (4500/8/18 — which the operator may have
    // never reviewed), zero water/elec readings (rooms ที่ไม่ได้บันทึก
    // มิเตอร์เลย → bill ไม่มียอดน้ำ/ไฟ), or no rates set at all.
    const issues = [];
    const tenantsWithBills = Object.values(rooms || {}).filter(
      (r) => r && r.tenant && (r.status === 'occupied' || r.status === 'overdue')
    );
    const ppTarget = config?.payment?.promptpay || config?.payment?.promptpayTarget;
    if (!ppTarget) {
      issues.push({
        sev: 'high',
        msg: 'ยังไม่ได้ตั้ง PromptPay — บิล PDF จะไม่มี QR (ผู้เช่าจะ scan-to-pay ไม่ได้)',
        fix: 'ตั้งที่ /admin#secrets → กลุ่ม PromptPay หรือ Settings → การชำระเงิน',
      });
    }
    const wRate = Number(config?.utilities?.waterRate);
    const eRate = Number(config?.utilities?.elecRate);
    if (!Number.isFinite(wRate) || wRate <= 0) {
      issues.push({ sev: 'high', msg: 'ค่าน้ำต่อหน่วยไม่ได้ตั้ง — บิลจะ ฿0 ในส่วนค่าน้ำ', fix: '/admin#pricing → ค่าน้ำ-ไฟ' });
    }
    if (!Number.isFinite(eRate) || eRate <= 0) {
      issues.push({ sev: 'high', msg: 'ค่าไฟต่อหน่วยไม่ได้ตั้ง — บิลจะ ฿0 ในส่วนค่าไฟ', fix: '/admin#pricing → ค่าน้ำ-ไฟ' });
    }
    // Count rooms with zero meter readings — admin probably forgot to
    // record them. The bill will still generate but the utilities line
    // items show 0 หน่วย, leading to "ทำไมบิลเดือนนี้ถูกจัง" tickets.
    const noMeter = tenantsWithBills.filter((r) =>
      (Number(r.waterUnits) || 0) === 0 && (Number(r.elecUnits) || 0) === 0
    ).length;
    if (noMeter > 0) {
      issues.push({
        sev: 'med',
        msg: `${noMeter} ห้องยังไม่บันทึกค่าน้ำ/ไฟ — บิลจะออกแต่ยอดน้ำ/ไฟเป็น 0`,
        fix: '/admin#meters → บันทึกค่ามิเตอร์ก่อนออกบิล',
      });
    }
    if (tenantsWithBills.length === 0) {
      issues.push({
        sev: 'high',
        msg: 'ยังไม่มีห้องที่มีผู้เช่าแสดงสถานะ "occupied" — จะออกบิล 0 ใบ',
        fix: '/admin#rooms → กำหนดผู้เช่าให้ห้องก่อน',
      });
    }
    // Building info — bill PDFs render building name + address + phone.
    // Default placeholder makes the bill look unprofessional.
    if (!config?.building?.name || config.building.name === 'บ้านกาญจน์ เรสซิเดนซ์') {
      issues.push({
        sev: 'low',
        msg: 'ชื่อตึกยังเป็น default — บิล PDF จะแสดง "บ้านกาญจน์ เรสซิเดนซ์"',
        fix: '/admin#settings → ข้อมูลตึก',
      });
    }

    if (issues.length > 0) {
      const high = issues.filter((i) => i.sev === 'high').length;
      const lines = issues.map((i, idx) => {
        const icon = i.sev === 'high' ? '🔴' : i.sev === 'med' ? '🟡' : '⚪';
        return `${idx + 1}. ${icon} ${i.msg}\n   → ${i.fix}`;
      }).join('\n\n');
      const ok = window.confirm(
        `⚠️ พบ ${issues.length} ปัญหา${high > 0 ? ` (${high} ข้อสำคัญ)` : ''} ก่อนออกบิล:\n\n` +
        lines +
        `\n\n📌 ออกบิลเดี๋ยวนี้ทั้งที่ปัญหาข้างบนยังไม่แก้?\n` +
        (high > 0 ? `   ⚠ บิลที่ออกอาจมี QR หาย / ยอดน้ำ-ไฟ ผิด — ผู้เช่าจ่ายไม่ได้ / ทักท้วงสูง\n` : '') +
        `\n   • กดยกเลิก → แก้ปัญหาก่อนแล้วค่อยมาออกบิล (แนะนำ)\n` +
        `   • กดตกลง → ออกบิลตามค่าปัจจุบัน (รับผิดชอบเอง)`
      );
      if (!ok) return;
    }

    setConfirmGenerate(false);
    const apiCall = window.apiCall;
    try {
      const now = new Date();
      const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const dueDay = Number(config.notify?.dueOnDay) || 7;
      // Pass `force` when there were issues but admin confirmed the warning.
      // The server has its own copy of the same checks (defence-in-depth)
      // and will 412 unless we explicitly opt in. issues.length > 0 here
      // means the client-side confirm modal showed warnings AND admin
      // clicked OK — that's the signal to set force.
      const d = await apiCall('/api/bills/bulk-generate', {
        method: 'POST',
        body: JSON.stringify({ period, dueDay, force: issues.length > 0 }),
      });
      addActivity && addActivity({ icon: '📋', text: `ออกบิลรอบ ${period}: ${d.made} ใบ (ข้าม ${d.skipped})`, type: 'billing' });
      setToast && setToast({
        kind: d.made > 0 ? 'success' : 'info',
        message: d.made > 0
          ? `ออกบิล ${d.made} ใบสำเร็จ${d.skipped ? ` (ข้าม ${d.skipped} ใบที่มีอยู่แล้ว)` : ''}`
          : `ทุกห้องมีบิลรอบ ${period} อยู่แล้ว — ไม่ได้สร้างเพิ่ม`,
      });
      // Refresh the DB-bills overlay so the banner + per-row badge flip
      // from "ประมาณการ" to "ออกแล้ว" without needing a manual reload.
      fetchDbBills();
    } catch (e) {
      window.toastError(setToast, e, { action: 'ออกบิล' });
    }
  };

  // Bulk-send all pending/overdue bills via LINE+email.
  // Pre-flight: count from local DB-bills overlay so admin sees exactly
  // how many notifications they're about to dispatch + total amount.
  // Without this, a single "OK" click could fire 200 LINE pushes (which
  // hits LINE's rate limit AND looks spammy to tenants), or fire ZERO
  // because the admin filtered the list and forgot the bulk-send acts
  // on ALL bills not just the visible ones.
  const handleBulkSend = async () => {
    const pending = (dbBills || []).filter((b) => b.status === 'pending' || b.status === 'overdue');
    const totalAmount = pending.reduce((s, b) => s + (Number(b.total) || 0), 0);
    if (pending.length === 0) {
      setToast && setToast({
        kind: 'info',
        message: {
          title: 'ไม่มีบิลค้างชำระ',
          description: 'ทุกบิลในระบบอยู่ในสถานะ "ชำระแล้ว" หรือ "ยกเลิก" — ไม่มีอะไรต้องส่ง',
        },
      });
      return;
    }
    const overdueCnt = pending.filter((b) => b.status === 'overdue').length;
    const fmt = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // Pre-flight reachability check: count how many of the pending bills'
    // tenants actually have a contactable channel. server-side sender
    // skips bills with no LINE userId AND no email — those tenants get
    // ZERO notifications, but admin doesn't see that distinction without
    // digging through the queue. Surface it up front so admin knows
    // "12 bills sent → 9 will reach a person, 3 will silently drop".
    let unreachable = 0;
    try {
      const r = await fetch('/api/tenants?status=active', { credentials: 'same-origin' });
      if (r.ok) {
        const j = await r.json();
        const byPhone = new Map();
        for (const t of (j.tenants || [])) {
          if (t.phone) byPhone.set(String(t.phone).replace(/[\s-]/g, ''), t);
        }
        for (const b of pending) {
          // Tenants without LINE binding AND without email are unreachable
          // via the bulk-send pipeline. b.tenant_id is what server uses;
          // we approximate with the rooms-blob data we have.
          const room = Object.values(rooms || {}).find((r) => r.id === b.room_id);
          const phone = room?.tenant?.phone ? String(room.tenant.phone).replace(/[\s-]/g, '') : null;
          const tenantRow = phone ? byPhone.get(phone) : null;
          const hasLine = !!tenantRow?.line_user_id;
          const hasEmail = !!tenantRow?.email || !!room?.tenant?.email;
          if (!hasLine && !hasEmail) unreachable++;
        }
      }
    } catch { /* fail-soft — show the warning conservatively when we can't tell */ }

    const ok = window.confirm(
      `ส่งแจ้งเตือนทุกบิลที่ยังไม่ชำระ?\n\n` +
      `📊 จำนวน: ${pending.length} ใบ` +
      (overdueCnt > 0 ? ` (ค้างชำระ ${overdueCnt}, รอชำระ ${pending.length - overdueCnt})` : '') + `\n` +
      `💰 ยอดรวม: ฿${fmt(totalAmount)}\n` +
      (unreachable > 0
        ? `\n⚠ ${unreachable} ใบจะส่งไม่ถึงผู้เช่า:\n` +
          `   ผู้เช่า ${unreachable} คน ไม่ได้ผูก LINE และไม่ใส่อีเมล\n` +
          `   📌 แนะนำ: ไป /admin#tenants → tab "Portal Access" ผูก LINE ก่อน,\n` +
          `   หรือใส่อีเมลใน Settings ของผู้เช่า\n`
        : '\n✅ ทุกบิลมีช่องทางส่งถึง (LINE หรือ อีเมล)\n') +
      `\n📌 ระบบจะ enqueue ในคิว — ส่งจริงภายใน ~1 นาที\n` +
      `📌 ดูคิวที่ /admin#notifications-queue\n` +
      `📌 กดบ่อย = ผู้เช่าได้ข้อความซ้ำ (rate-limit ของ LINE = 1000/วัน)`
    );
    if (!ok) return;
    const apiCall = window.apiCall;
    try {
      const d = await apiCall('/api/bills/bulk-send', { method: 'POST' });
      setToast && setToast({
        kind: d.enqueued > 0 ? 'success' : 'info',
        message: d.enqueued > 0
          ? `จัดคิวแจ้งเตือน ${d.enqueued}/${d.attempted} ใบ${d.failed ? ` — พลาด ${d.failed} ใบ (ดูรายละเอียดใน "คิวแจ้งเตือน")` : ''}`
          : `ไม่มีบิลค้างที่ต้องแจ้งเตือน`,
      });
      addActivity && addActivity({ icon: '🔔', text: `ส่งเตือนทุกบิลค้าง: ${d.enqueued} ใบ`, type: 'system' });
    } catch (e) {
      window.toastError(setToast, e, { action: 'ส่งแจ้งเตือนทุกบิล' });
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
      key: 'status', label: 'สถานะ', minWidth: 140,
      render: b => (
        <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
          {b.status === 'paid'
            ? <Pill color="success" size="sm" icon="✓">ชำระแล้ว</Pill>
            : <Pill color="danger" size="sm">ค้าง {b.overdueDays} วัน</Pill>}
          <span title={b._source === 'db' ? `บิล #${b.dbBillNo || b.dbBillId}` : 'ยังไม่ได้บันทึกเข้าระบบ'}
                style={{
                  fontSize: 10, padding: '1px 6px', borderRadius: 4,
                  background: b._source === 'db' ? (C.successSoft || '#e3f3e8') : (C.warningSoft || '#fef6e0'),
                  color: b._source === 'db' ? (C.successInk || '#1d4a2c') : (C.warningInk || '#7a5a18'),
                  fontWeight: 600, letterSpacing: '0.02em',
                }}>
            {b._source === 'db' ? 'ออกแล้ว' : 'ประมาณการ'}
          </span>
        </div>
      ),
    },
    {
      key: 'actions', label: '', align: 'right', minWidth: 130,
      render: b => (
        <div style={{ display: 'inline-flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
          <IconBtn icon="👁" label="ดูบิล" onClick={() => setPreviewBill(b)} />
          {b.status === 'unpaid' && b._source === 'db' && (
            <>
              <IconBtn icon="🔔" label="ส่งเตือน" onClick={() => handleSendReminder(b.id)} />
              <IconBtn icon="✓" label="บันทึกชำระ" onClick={() => handleMarkPaid(b.id)} />
            </>
          )}
          {b.status === 'paid' && b._source === 'db' && (
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

      {/* Real-vs-estimate banner. Tells admin at a glance whether what
          they're seeing came from issued bills (DB) or is just a forecast
          built from rooms × rate. Without this, the previous version
          showed a perfect-looking estimate even when 0 bills had been
          issued for the period — false reassurance. */}
      {dbBills != null && (() => {
        const dbCount = dbBills.length;
        const estCount = bills.filter((b) => b._source === 'estimate').length;
        if (dbCount === 0 && estCount > 0) {
          return (
            <div style={{
              padding: '10px 14px', marginBottom: 14, borderRadius: 8,
              background: C.warningSoft || '#fef6e0', color: C.warningInk || '#7a5a18',
              fontSize: 13, display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{ fontSize: 16 }}>⚠️</span>
              <span><strong>ยังไม่ได้ออกบิลรอบ {currentPeriod}</strong> — ตารางด้านล่างเป็นการประมาณการจากข้อมูลห้อง กดปุ่ม "ออกบิลเดือนนี้" เพื่อบันทึกเข้า DB</span>
            </div>
          );
        }
        if (dbCount > 0 && estCount > 0) {
          return (
            <div style={{
              padding: '10px 14px', marginBottom: 14, borderRadius: 8,
              background: C.infoSoft || '#e3eef7', color: C.infoInk || '#1d3b5a',
              fontSize: 13, display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{ fontSize: 16 }}>ℹ️</span>
              <span>ออกบิลแล้ว {dbCount} ใบ (รอบ {currentPeriod}) · เหลือห้องที่ยังไม่ออก {estCount} ห้อง — กด "ออกบิลเดือนนี้" เพื่อออกบิลส่วนที่เหลือ</span>
            </div>
          );
        }
        if (dbCount > 0 && estCount === 0) {
          return (
            <div style={{
              padding: '10px 14px', marginBottom: 14, borderRadius: 8,
              background: C.successSoft || '#e3f3e8', color: C.successInk || '#1d4a2c',
              fontSize: 13, display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{ fontSize: 16 }}>✓</span>
              <span>ออกบิลครบทุกห้องแล้วสำหรับรอบ {currentPeriod} ({dbCount} ใบ)</span>
            </div>
          );
        }
        return null;
      })()}
      {dbBillsErr && (
        <div style={{
          padding: '10px 14px', marginBottom: 14, borderRadius: 8,
          background: C.dangerSoft || '#fff1f0', color: C.danger || '#a23',
          fontSize: 13,
        }}>
          โหลดข้อมูลบิลจาก DB ไม่สำเร็จ: {dbBillsErr} — แสดงประมาณการจากข้อมูลห้อง
          {' '}<button onClick={fetchDbBills} style={{
            border: 0, background: 'transparent', color: 'inherit',
            textDecoration: 'underline', cursor: 'pointer', fontFamily: 'inherit',
          }}>ลองใหม่</button>
        </div>
      )}

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
              const apiFetch = window.apiFetch || ((u, o) => fetch(u, { credentials: 'same-origin', ...o }));
              let okCount = 0, failCount = 0, skip = false;
              for (const b of targets) {
                try {
                  const r = (b._source === 'db' && b.dbBillId)
                    ? await apiFetch(`/api/bills/${b.dbBillId}/send`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({}),
                      })
                    : await apiFetch('/api/notify/bill', {
                        method: 'POST',
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
            <Btn variant="soft" size="sm" icon="✓" onClick={async () => {
              const ids = [...selected];
              for (const id of ids) {
                const bill = bills.find(b => b.id === id);
                if (bill && bill.status === 'unpaid' && bill._source === 'db') {
                  await handleMarkPaid(id, { confirm: false, refresh: false });
                }
              }
              fetchDbBills();
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
              const apiFetch = window.apiFetch || ((u, o) => fetch(u, { credentials: 'same-origin', ...o }));
              try {
                const res = await apiFetch('/api/bills/render', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(
                    b._source === 'db' && b.dbBillId
                      ? { billId: b.dbBillId, bill: payload }
                      : { bill: payload, config }
                  ),
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
              const apiFetch = window.apiFetch || ((u, o) => fetch(u, { credentials: 'same-origin', ...o }));
              try {
                const res = (b._source === 'db' && b.dbBillId)
                  ? await apiFetch(`/api/bills/${b.dbBillId}/send`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({}),
                    })
                  : await apiFetch('/api/notify/bill', {
                      method: 'POST',
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
