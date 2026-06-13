// === admin/page-booking-deposit-settings.jsx ==============================
// Dedicated setup page for public room booking fees / deposit policy.
// The same values still live in features.roomBooking, but this page exposes
// them as one guided operational flow so admins do not have to hunt through
// the generic feature-flag page.
// ===========================================================================

const { useState, useEffect, useCallback, useMemo } = React;

const BOOKING_DEPOSIT_DEFAULTS = {
  enabled: true,
  requireDeposit: false,
  depositAmount: 500,
  minimumAmount: 0,
  applyBookingFeeToDeposit: false,
  requireSlip: true,
  holdMinutes: 15,
  maxBytes: 1500000,
  allowedMimes: ['image/jpeg', 'image/png', 'image/webp'],
};

function bookingDepositNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bookingDepositClamp(value, min, max, fallback) {
  const n = bookingDepositNumber(value, fallback);
  return Math.min(max, Math.max(min, n));
}

function normalizeBookingDepositFeature(raw) {
  const base = { ...BOOKING_DEPOSIT_DEFAULTS, ...(raw || {}) };
  const depositAmount = Math.round(bookingDepositClamp(base.depositAmount, 0, 1000000, 500));
  const rawMinimum = bookingDepositClamp(base.minimumAmount, 0, 1000000, 0);
  const minimumAmount = rawMinimum > 0 ? Math.max(1, Math.round(rawMinimum)) : 0;
  const holdMinutes = Math.round(bookingDepositClamp(base.holdMinutes, 1, 120, 15));
  const maxBytes = Math.round(bookingDepositClamp(base.maxBytes, 100000, 5000000, 1500000));
  return {
    enabled: base.enabled !== false,
    requireDeposit: base.requireDeposit === true,
    depositAmount,
    minimumAmount,
    applyBookingFeeToDeposit: base.applyBookingFeeToDeposit === true,
    requireSlip: base.requireSlip !== false,
    holdMinutes,
    maxBytes,
    allowedMimes: Array.isArray(base.allowedMimes) && base.allowedMimes.length
      ? base.allowedMimes
      : BOOKING_DEPOSIT_DEFAULTS.allowedMimes,
  };
}

function bookingDepositEffectiveAmount(draft) {
  const amount = Math.max(0, Math.round(Number(draft?.depositAmount || 0)));
  const minimum = Math.max(0, Math.round(Number(draft?.minimumAmount || 0)));
  return minimum > 0 ? Math.max(amount, minimum) : amount;
}

function bookingDepositBytesToMb(bytes) {
  const n = bookingDepositNumber(bytes, 1500000);
  return Math.max(0.1, Math.round((n / 1000000) * 10) / 10);
}

function bookingDepositMbToBytes(mb) {
  return Math.round(bookingDepositClamp(mb, 0.1, 5, 1.5) * 1000000);
}

function bookingDepositMoney(value) {
  if (window.fmtCurrency) return window.fmtCurrency(value);
  return '฿' + Number(value || 0).toLocaleString('th-TH');
}

function bookingDepositCanEditRole(role) {
  return role === 'owner' || role === 'manager';
}

function bookingDepositNeedsPaymentSetup(draft, paymentKnown, paymentReady) {
  return !!(draft && draft.requireDeposit && draft.requireSlip && paymentKnown && !paymentReady);
}

function PageBookingDepositSettings({ setToast, embedded = false, currentUser = null }) {
  const C = window.ADMIN_C;
  const { Card, SectionHeading, Btn, Pill, PageContainer, PageHeader, Toggle, Input } = window;
  // Defensive: requireApiFetch() throws if hooks.jsx hasn't registered
  // window.apiFetch yet — resolving it unguarded at render crashed the page to
  // the ErrorBoundary on a slow/partial load. Fall back so the error surfaces
  // in a handler's try/catch instead of taking down the whole page.
  const apiFetch = (() => {
    try { return window.requireApiFetch ? window.requireApiFetch() : window.apiFetch; }
    catch { return window.apiFetch; }
  })();

  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(null);
  const [defaults, setDefaults] = useState(BOOKING_DEPOSIT_DEFAULTS);
  const [publicConfig, setPublicConfig] = useState(null);
  const [canEdit, setCanEdit] = useState(bookingDepositCanEditRole(currentUser?.role));
  const [viewerRole, setViewerRole] = useState(currentUser?.role || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!currentUser?.role) return;
    setViewerRole(currentUser.role);
    setCanEdit(bookingDepositCanEditRole(currentUser.role));
  }, [currentUser?.role]);

  const load = useCallback(async () => {
    setErr('');
    try {
      const settingsRes = await fetch('/api/admin/booking-deposit-settings', { credentials: 'same-origin' });
      const settingsJson = await settingsRes.json();
      if (!settingsRes.ok) throw new Error(settingsJson.error || 'load booking deposit settings failed');
      const featureDefaults = normalizeBookingDepositFeature(settingsJson.defaults);
      const feature = normalizeBookingDepositFeature({
        ...featureDefaults,
        ...(settingsJson.settings || {}),
      });
      setDefaults(featureDefaults);
      setSaved(feature);
      setDraft(feature);
      if (typeof settingsJson.canEdit === 'boolean') setCanEdit(settingsJson.canEdit);
      if (settingsJson.role) setViewerRole(settingsJson.role);
      setPublicConfig({ payment: settingsJson.payment || null });
    } catch (e) {
      setErr(e.message);
      setToast && setToast({ kind: 'error', message: e.message });
    }
  }, [setToast]);

  useEffect(() => { load(); }, [load]);

  const savedComparable = useMemo(
    () => saved ? JSON.stringify(normalizeBookingDepositFeature(saved)) : '',
    [saved]
  );
  const draftComparable = useMemo(
    () => draft ? JSON.stringify(normalizeBookingDepositFeature(draft)) : '',
    [draft]
  );
  const dirty = !!draft && !!saved && draftComparable !== savedComparable;
  const effectiveAmount = bookingDepositEffectiveAmount(draft || defaults);
  const paymentReady = publicConfig?.payment?.ready;
  const paymentKnown = publicConfig?.payment && typeof paymentReady === 'boolean';
  const readOnlyReason = canEdit ? '' : `บัญชี ${viewerRole || 'ปัจจุบัน'} ดูได้เท่านั้น ต้องใช้ role owner หรือ manager เพื่อบันทึก`;

  function patchDraft(patch) {
    setDraft((prev) => normalizeBookingDepositFeature({ ...(prev || defaults), ...patch }));
  }

  async function save() {
    if (!draft) return;
    if (!canEdit) {
      const message = {
        title: 'ไม่มีสิทธิ์บันทึกการตั้งค่าค่าจอง',
        description: 'การแก้ค่าจอง/มัดจำต้องใช้บัญชี owner หรือ manager',
      };
      setToast && setToast({ kind: 'warning', message });
      setErr(message.description);
      return;
    }
    const clean = normalizeBookingDepositFeature(draft);
    setBusy(true); setErr('');
    try {
      const r = await apiFetch('/api/admin/booking-deposit-settings', {
        method: 'PUT',
        body: JSON.stringify({ roomBooking: clean }),
      });
      const d = await r.json();
      if (!r.ok) {
        const issue = Array.isArray(d.issues) && d.issues[0] ? d.issues[0] : null;
        throw new Error(issue ? `${d.error}: ${issue.message}` : (d.error || 'save failed'));
      }
      const next = normalizeBookingDepositFeature(d.settings || clean);
      const returnedPayment = d.payment || null;
      const savedNeedsPaymentSetup = next.enabled && bookingDepositNeedsPaymentSetup(
        next,
        returnedPayment && typeof returnedPayment.ready === 'boolean',
        returnedPayment?.ready
      );
      setSaved(next);
      setDraft(next);
      if (typeof d.canEdit === 'boolean') setCanEdit(d.canEdit);
      if (d.role) setViewerRole(d.role);
      setPublicConfig({ payment: returnedPayment });
      setToast && setToast({
        kind: savedNeedsPaymentSetup ? 'warning' : 'success',
        message: {
          title: savedNeedsPaymentSetup
            ? 'บันทึกแล้ว แต่ยังรับสลิปค่าจองไม่ได้'
            : 'บันทึกค่าจอง/มัดจำแล้ว',
          description: savedNeedsPaymentSetup
            ? 'ต้องตั้งค่า PromptPay/บัญชีธนาคาร หรือปิด "ต้องแนบสลิปค่าจอง" เพื่อให้หน้า booking จองต่อได้'
            : (!clean.enabled
                ? 'ปิดรับจองออนไลน์แล้ว ผู้สนใจจะเห็นข้อความแจ้งชัดเจนและส่งคำขอจองไม่ได้'
                : clean.requireDeposit
                ? `ผู้จองต้องชำระ ${bookingDepositMoney(bookingDepositEffectiveAmount(clean))} และห้องจะถูกล็อก ${clean.holdMinutes} นาที`
                : 'ปิดการเก็บค่าจองก่อนส่งคำขอแล้ว'),
        },
      });
      load();
    } catch (e) {
      setErr(e.message);
      setToast && setToast({ kind: 'error', message: e.message });
    } finally {
      setBusy(false);
    }
  }

  function resetToSaved() {
    setDraft(saved || normalizeBookingDepositFeature(defaults));
    setErr('');
  }

  function resetToDefault() {
    setDraft(normalizeBookingDepositFeature(defaults));
    setErr('');
  }

  if (!draft) {
    const content = (
      <>
        {!embedded ? <PageHeader title="ตั้งค่าจอง/มัดจำ" subtitle="กำลังโหลดค่าปัจจุบัน..." tone="rooms" /> : null}
        <Card>
          <div style={{ color: C.muted, fontSize: 14 }}>กำลังโหลดการตั้งค่า</div>
        </Card>
      </>
    );
    return embedded ? <div>{content}</div> : <PageContainer>{content}</PageContainer>;
  }

  const warnings = [];
  if (!draft.enabled) {
    warnings.push({
      color: 'warning',
      title: 'หน้าจองสาธารณะปิดอยู่',
      detail: 'ผู้สนใจจะส่งคำขอจองห้องไม่ได้จนกว่าจะเปิดใช้งาน',
    });
  }
  if (bookingDepositNeedsPaymentSetup(draft, paymentKnown, paymentReady)) {
    warnings.push({
      color: 'danger',
      title: 'ยังไม่พร้อมรับเงินค่าจอง',
      detail: 'ตอนนี้บังคับแนบสลิป แต่ยังไม่มี PromptPay/บัญชีธนาคารให้ผู้จองโอน ระบบจะบล็อกการจองจนกว่าจะตั้งค่ารับเงิน หรือปิดบังคับสลิปเพื่อ manual review',
    });
  }
  if (draft.requireDeposit && !draft.requireSlip && paymentKnown && !paymentReady) {
    warnings.push({
      color: 'warning',
      title: 'รับจองแบบ manual review',
      detail: 'ยังไม่มีบัญชีรับเงินในระบบ แต่ผู้จองยังส่งคำขอได้เพราะไม่บังคับแนบสลิป แอดมินต้องตรวจยอดโอน/รับเงินเองก่อนอนุมัติ',
    });
  }
  if (draft.requireDeposit && draft.minimumAmount > draft.depositAmount) {
    warnings.push({
      color: 'info',
      title: 'ขั้นต่ำสูงกว่าค่าจองที่กรอก',
      detail: `ระบบจะใช้ยอดจริง ${bookingDepositMoney(effectiveAmount)} ตามกติกาขั้นต่ำ`,
    });
  }
  if (draft.requireDeposit && !draft.requireSlip) {
    warnings.push({
      color: 'warning',
      title: 'ไม่บังคับแนบสลิป',
      detail: 'คำขอที่มีค่าจองจะเข้า manual review เพื่อให้แอดมินตรวจการโอนเอง',
    });
  }

  const inputDisabled = busy || !canEdit;
  const maxSlipMb = bookingDepositBytesToMb(draft.maxBytes);
  const saveActions = (
    <>
      <Btn variant="secondary" onClick={resetToSaved} disabled={!dirty || busy}>ยกเลิก</Btn>
      <Btn variant="soft" tone="rooms" onClick={resetToDefault} disabled={busy || !canEdit}>ค่าเริ่มต้น</Btn>
      <Btn variant="primary" tone="rooms" onClick={save} disabled={!dirty || busy || !canEdit}>
        {busy ? 'กำลังบันทึก...' : (dirty ? 'บันทึก' : 'บันทึกแล้ว')}
      </Btn>
    </>
  );

  const content = (
    <>
      {!embedded ? <PageHeader
        title="ตั้งค่าจอง/มัดจำ"
        subtitle="กำหนดค่าจอง ล็อกห้อง สลิป และการหักเงินจองกับมัดจำสัญญาในที่เดียว"
        actions={saveActions}
        tone="rooms"
      /> : null}

      {embedded ? (
        <Card>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}>
            <div style={{ minWidth: 220, flex: 1 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.ink }}>ตั้งค่าจอง/มัดจำ</div>
              <div style={{ fontSize: 13, color: C.muted, marginTop: 3 }}>
                ปรับค่าในหน้านี้แล้วกดปุ่มบันทึกชุดนี้โดยตรง ไม่ต้องใช้ปุ่มบันทึกของตั้งค่าระบบ
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {saveActions}
            </div>
          </div>
        </Card>
      ) : null}

      {!canEdit ? (
        <BookingDepositNotice color="warning" title="โหมดอ่านอย่างเดียว" C={C}>
          {readOnlyReason}
        </BookingDepositNotice>
      ) : null}
      {err ? (
        <BookingDepositNotice color="danger" title="บันทึก/โหลดไม่สำเร็จ" C={C}>
          {err}
        </BookingDepositNotice>
      ) : null}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))',
        gap: 16,
        alignItems: 'start',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card>
            <SectionHeading
              title="สถานะการใช้งาน"
              subtitle="ตั้งจากบนลงล่างได้เลย เมื่อบันทึกแล้วหน้า booking จะใช้ค่านี้ทันที"
              action={
                draft.requireDeposit
                  ? <Pill color="finance">เก็บค่าจอง {bookingDepositMoney(effectiveAmount)}</Pill>
                  : <Pill color="neutral">ไม่เก็บค่าจอง</Pill>
              }
              level={3}
            />
            <Toggle
              label="เปิดหน้าจองห้องสาธารณะ"
              hint="ถ้าปิด ผู้สนใจจะส่งคำขอจองจากหน้าเว็บไม่ได้"
              checked={draft.enabled}
              disabled={inputDisabled}
              onChange={(v) => patchDraft({ enabled: v })}
            />
            <Toggle
              label="เก็บค่าจองก่อนส่งคำขอ"
              hint="เมื่อเปิด ผู้จองต้องเลือกห้องจริง ระบบจะล็อกห้องชั่วคราวระหว่างส่งคำขอ"
              checked={draft.requireDeposit}
              disabled={inputDisabled}
              onChange={(v) => patchDraft({ requireDeposit: v })}
            />
            <Toggle
              label="ต้องแนบสลิปค่าจอง"
              hint="ปิดได้ในกรณีรับจองแบบ manual review หรือเก็บเงินช่องทางอื่น"
              checked={draft.requireSlip}
              disabled={inputDisabled || !draft.requireDeposit}
              onChange={(v) => patchDraft({ requireSlip: v })}
            />
            <Toggle
              label="นำค่าจองไปหัก/นับรวมกับเงินมัดจำสัญญา"
              hint="ถ้าเปิด เมื่ออนุมัติจองและสร้างสัญญา ระบบจะบันทึกเครดิตค่าจองและยอดมัดจำคงเหลือ"
              checked={draft.applyBookingFeeToDeposit}
              disabled={inputDisabled || !draft.requireDeposit}
              onChange={(v) => patchDraft({ applyBookingFeeToDeposit: v })}
            />
          </Card>

          <Card>
            <SectionHeading
              title="ยอดเงินและเวลาล็อกห้อง"
              subtitle="ขั้นต่ำ 0 คือไม่กำหนด ถ้ากำหนดต้องไม่น้อยกว่า 1 บาท"
              level={3}
            />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12 }}>
              <Input
                type="number"
                label="ค่าจองที่ต้องชำระ"
                value={draft.depositAmount}
                suffix="บาท"
                disabled={inputDisabled}
                onChange={(v) => patchDraft({ depositAmount: v })}
                hint="ตัวอย่าง 500 บาท"
              />
              <Input
                type="number"
                label="ขั้นต่ำค่าจอง"
                value={draft.minimumAmount}
                suffix="บาท"
                disabled={inputDisabled}
                onChange={(v) => patchDraft({ minimumAmount: v })}
                hint="0 = ไม่กำหนด, ถ้ามีขั้นต่ำจะเริ่มที่ 1 บาท"
              />
              <Input
                type="number"
                label="ล็อกห้องชั่วคราว"
                value={draft.holdMinutes}
                suffix="นาที"
                disabled={inputDisabled}
                onChange={(v) => patchDraft({ holdMinutes: v })}
                hint="แนะนำ 15 นาที ระบบปล่อยห้องอัตโนมัติเมื่อหมดเวลา"
              />
              <Input
                type="number"
                label="ขนาดสลิปสูงสุด"
                value={maxSlipMb}
                suffix="MB"
                disabled={inputDisabled}
                onChange={(v) => patchDraft({ maxBytes: bookingDepositMbToBytes(v) })}
                hint="รองรับ JPG, PNG, WEBP"
              />
            </div>
          </Card>

          <Card>
            <SectionHeading title="การทำงานร่วมกับระบบอื่น" level={3} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12 }}>
              <BookingDepositFlowItem
                C={C}
                title="หน้า booking"
                detail={draft.requireDeposit
                  ? `แสดงยอด ${bookingDepositMoney(effectiveAmount)} และขอ hold token ก่อนส่งคำขอ`
                  : 'รับคำขอจองได้ทันทีโดยไม่ต้องชำระค่าจอง'}
              />
              <BookingDepositFlowItem
                C={C}
                title="สถานะห้อง"
                detail={`ห้องถูกล็อก ${draft.holdMinutes} นาทีตอนเริ่มจอง และปล่อยอัตโนมัติถ้าส่งไม่สำเร็จ`}
              />
              <BookingDepositFlowItem
                C={C}
                title="ตรวจสลิปซ้ำ"
                detail="backend ตรวจ hash กับสลิปชำระบิลและสลิปค่าจองเดิมก่อนบันทึก"
              />
              <BookingDepositFlowItem
                C={C}
                title="สัญญา"
                detail={draft.applyBookingFeeToDeposit
                  ? 'เมื่ออนุมัติ ระบบส่งเครดิตค่าจองไปที่สัญญาและคำนวณมัดจำคงเหลือ'
                  : 'ค่าจองถูกเก็บแยกจากเงินมัดจำสัญญา'}
              />
            </div>
          </Card>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card>
            <SectionHeading title="สรุปก่อนบันทึก" level={3} />
            <BookingDepositSummaryRow C={C} label="หน้าจอง" value={draft.enabled ? 'เปิด' : 'ปิด'} good={draft.enabled} />
            <BookingDepositSummaryRow C={C} label="ค่าจองที่ใช้จริง" value={draft.requireDeposit ? bookingDepositMoney(effectiveAmount) : 'ไม่เก็บ'} good={!draft.requireDeposit || effectiveAmount > 0} />
            <BookingDepositSummaryRow C={C} label="สลิป" value={draft.requireDeposit ? (draft.requireSlip ? 'บังคับแนบ' : 'ไม่บังคับ / manual review') : '-'} good={!draft.requireDeposit || draft.requireSlip} />
            <BookingDepositSummaryRow C={C} label="ล็อกห้อง" value={`${draft.holdMinutes} นาที`} good={draft.holdMinutes >= 1} />
            <BookingDepositSummaryRow C={C} label="มัดจำสัญญา" value={draft.applyBookingFeeToDeposit ? 'หักจากมัดจำ' : 'แยกจากมัดจำ'} good />
            <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <a href="/admin#settings" style={bookingDepositLinkStyle(C)}>ตั้งค่าบัญชีรับเงิน</a>
              <a href="/booking" target="_blank" rel="noopener noreferrer" style={bookingDepositLinkStyle(C)}>ดูหน้าจอง</a>
            </div>
          </Card>

          {warnings.length ? (
            <Card>
              <SectionHeading title="แจ้งเตือน" level={3} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {warnings.map((w, idx) => (
                  <BookingDepositNotice key={idx} color={w.color} title={w.title} C={C}>
                    {w.detail}
                  </BookingDepositNotice>
                ))}
              </div>
            </Card>
          ) : (
            <Card>
              <SectionHeading title="แจ้งเตือน" level={3} />
              <BookingDepositNotice color="success" title="พร้อมใช้งาน" C={C}>
                ค่านี้ทำงานร่วมกับหน้า booking, การล็อกห้อง, การตรวจสลิปซ้ำ และการสร้างสัญญาแล้ว
              </BookingDepositNotice>
            </Card>
          )}
        </div>
      </div>
    </>
  );
  return embedded ? <div>{content}</div> : <PageContainer>{content}</PageContainer>;
}

function BookingDepositNotice({ color = 'info', title, children, C }) {
  const palette = {
    success: { bg: C.successSoft, border: '#BDE5CF', ink: C.successInk },
    warning: { bg: C.warningSoft, border: '#F3D39B', ink: C.warningInk },
    danger: { bg: C.dangerSoft, border: '#F5BBBB', ink: C.dangerInk },
    info: { bg: C.infoSoft, border: '#BFD2FA', ink: C.infoInk },
  }[color] || { bg: C.neutralSoft, border: C.border, ink: C.neutralInk };
  return (
    <div style={{
      padding: '10px 12px',
      border: `1px solid ${palette.border}`,
      background: palette.bg,
      color: palette.ink,
      borderRadius: 8,
      fontSize: 13,
      lineHeight: 1.55,
    }}>
      <div style={{ fontWeight: 700, marginBottom: 2 }}>{title}</div>
      <div>{children}</div>
    </div>
  );
}

function BookingDepositFlowItem({ title, detail, C }) {
  return (
    <div style={{
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      padding: 12,
      background: C.surfaceAlt,
      minHeight: 82,
    }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: C.ink, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 12.5, color: C.ink2, lineHeight: 1.5 }}>{detail}</div>
    </div>
  );
}

function BookingDepositSummaryRow({ label, value, good, C }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      gap: 12,
      padding: '9px 0',
      borderBottom: `1px solid ${C.borderSoft}`,
      fontSize: 13,
    }}>
      <span style={{ color: C.muted }}>{label}</span>
      <span style={{ color: good ? C.ink : C.warningInk, fontWeight: 700, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function bookingDepositLinkStyle(C) {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 34,
    padding: '7px 12px',
    border: `1px solid ${C.border}`,
    borderRadius: 7,
    background: C.surface,
    color: C.ink,
    textDecoration: 'none',
    fontSize: 13,
    fontWeight: 600,
  };
}

window.PageBookingDepositSettings = PageBookingDepositSettings;
