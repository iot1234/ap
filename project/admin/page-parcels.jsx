// === admin/page-parcels.jsx ==============================================
// Parcel arrival workflow: admin records parcel, tenant gets notified, and
// both sides can see pickup status.
// =========================================================================

const { useState, useEffect, useMemo } = React;

const PARCEL_STATUS_LABEL = {
  waiting_pickup: 'รอผู้เช่ารับ',
  picked_up: 'รับแล้ว',
  returned: 'คืนผู้ส่ง',
  cancelled: 'ยกเลิก',
};
const PARCEL_STATUS_TONE = {
  waiting_pickup: 'warning',
  picked_up: 'success',
  returned: 'neutral',
  cancelled: 'danger',
};
const PARCEL_NOTIFY_LABEL = {
  sent: 'ส่งแล้ว',
  queued: 'เข้าคิวส่ง',
  failed: 'ส่งไม่สำเร็จ',
  disabled: 'ปิดช่องทาง',
  skipped: 'ไม่ได้ส่ง',
};
const PARCEL_OPTION_STORAGE_KEY = 'baankarn.parcelOptions.v1';
const DEFAULT_PARCEL_CARRIERS = [
  'Kerry Express',
  'KEX Express',
  'Flash Express',
  'ไปรษณีย์ไทย',
  'J&T Express',
  'Shopee Express',
  'Lazada Logistics',
  'DHL',
  'Best Express',
  'Ninja Van',
  'SCG Express',
  'GrabExpress',
  'Lalamove',
];

function readParcelOptionMemory() {
  try {
    const raw = JSON.parse(localStorage.getItem(PARCEL_OPTION_STORAGE_KEY) || '{}');
    return {
      carriers: Array.isArray(raw.carriers) ? raw.carriers.filter(Boolean).slice(0, 30) : [],
      shelfLocations: Array.isArray(raw.shelfLocations) ? raw.shelfLocations.filter(Boolean).slice(0, 30) : [],
      lastCarrier: raw.lastCarrier || '',
      lastShelfLocation: raw.lastShelfLocation || '',
    };
  } catch {
    return { carriers: [], shelfLocations: [], lastCarrier: '', lastShelfLocation: '' };
  }
}

function mergeOptionValues(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const raw of Array.isArray(list) ? list : []) {
      const value = typeof raw === 'string' ? raw : raw && raw.value;
      const s = String(value || '').trim();
      const key = s.toLowerCase();
      if (!s || seen.has(key)) continue;
      seen.add(key);
      out.push(s);
      if (out.length >= 50) return out;
    }
  }
  return out;
}

function notifyCount(item, key, fallbackKey) {
  return Number(item?.[key] ?? item?.[fallbackKey] ?? 0) || 0;
}

function notifyChannels(item) {
  const raw = item?.notify_channels || item?.notifyChannels || [];
  const arr = Array.isArray(raw) ? raw : [];
  const last = item?.last_notify_channel || item?.lastNotifyChannel || '';
  return [...new Set([...arr, last].filter((x) => x && !['none', 'unknown'].includes(String(x))))];
}

function notifySummary(item) {
  const attempts = notifyCount(item, 'notify_attempt_count', 'notifyAttemptCount');
  const success = notifyCount(item, 'notify_success_count', 'notifySuccessCount');
  const status = item?.last_notify_status || item?.lastNotifyStatus || '';
  const channels = notifyChannels(item);
  if (attempts <= 0) {
    return {
      attempts,
      success,
      channels,
      label: 'ยังไม่เคยส่งแจ้งเตือน',
      detail: status === 'skipped' ? 'บันทึกไว้โดยไม่ส่งแจ้งเตือน' : 'ยังไม่มีประวัติการส่งถึงผู้เช่า',
      tone: 'neutral',
    };
  }
  return {
    attempts,
    success,
    channels,
    label: `แจ้งเตือน ${attempts} รอบ`,
    detail: `สำเร็จ/เข้าคิว ${success} รอบ · ช่องทาง ${channels.length ? channels.join(', ') : '-'}`,
    tone: success > 0 ? 'success' : 'warning',
  };
}

// --- เตรียมรูปก่อนอัปโหลด ---------------------------------------------------
// รูปจากกล้องมือถือเกือบทุกใบใหญ่เกิน 1.5 MB ถ้า reject ตรง ๆ ผู้ใช้จะติดทางตัน
// ("รูปใหญ่เกินไป" แล้วทำอะไรต่อไม่ได้) จึงย่อรูปอัตโนมัติผ่าน canvas
// (ลดขนาดด้านยาว + ไล่ลดคุณภาพเป็นขั้น) จนพอดีเพดานเซิร์ฟเวอร์
const PARCEL_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PARCEL_IMAGE_TARGET_BYTES = 1_400_000; // เผื่อ headroom จากเพดานเซิร์ฟเวอร์ 1.5 MB
const PARCEL_IMAGE_MAX_INPUT_BYTES = 15_000_000;

function estimateDataUrlBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  return Math.floor((dataUrl.length - (comma >= 0 ? comma + 1 : 0)) * 0.75);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('อ่านไฟล์รูปไม่สำเร็จ กรุณาเลือกรูปใหม่'));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('ไฟล์รูปเสียหรือเปิดไม่ได้ กรุณาเลือกหรือถ่ายรูปใหม่'));
    img.src = dataUrl;
  });
}

async function prepareParcelPhoto(file) {
  if (!file) throw new Error('ไม่พบไฟล์รูป กรุณาเลือกรูปใหม่');
  if (!PARCEL_IMAGE_TYPES.includes(file.type)) {
    throw new Error('รองรับเฉพาะรูป JPG, PNG หรือ WebP');
  }
  if (file.size > PARCEL_IMAGE_MAX_INPUT_BYTES) {
    throw new Error('รูปใหญ่เกิน 15 MB ระบบย่อให้ไม่ไหว กรุณาเลือกรูปที่เล็กกว่านี้');
  }
  const original = await readFileAsDataUrl(file);
  if (file.size <= PARCEL_IMAGE_TARGET_BYTES) return original;
  const img = await loadImageElement(original);
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  if (!srcW || !srcH) throw new Error('อ่านขนาดรูปไม่ได้ กรุณาเลือกรูปใหม่');
  for (const maxDim of [1600, 1280, 1024, 800]) {
    const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) break;
    // พื้นขาวกัน PNG โปร่งใสกลายเป็นพื้นดำตอนแปลงเป็น JPEG
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    for (const quality of [0.82, 0.68, 0.55]) {
      const out = canvas.toDataURL('image/jpeg', quality);
      if (out.startsWith('data:image/jpeg') && estimateDataUrlBytes(out) <= PARCEL_IMAGE_TARGET_BYTES) {
        return out;
      }
    }
  }
  throw new Error('ย่อรูปอัตโนมัติแล้วยังใหญ่เกินไป กรุณาถ่ายหรือเลือกรูปความละเอียดต่ำลง');
}

// จำนวนวันที่พัสดุค้างรอรับ — ใช้เตือนของค้างนาน (null = ไม่รู้/ข้อมูลเพี้ยน)
function ParcelFeatureDisabledPanel({ onOpenFeatures }) {
  const C = window.ADMIN_C;
  const { Btn, Pill, Card } = window;
  return (
    <Card style={{
      border: '1px solid ' + C.warning,
      background: `linear-gradient(135deg, ${C.warningSoft || '#fff7ed'} 0%, ${C.surface || '#fff'} 68%)`,
      color: C.warningInk || C.ink,
      padding: 24,
    }}>
      <div style={{
        display: 'flex',
        gap: 16,
        alignItems: 'flex-start',
        flexWrap: 'wrap',
      }}>
        <div aria-hidden="true" style={{
          width: 48, height: 48, borderRadius: 12,
          display: 'grid', placeItems: 'center',
          background: C.surface,
          border: '1px solid ' + C.warning,
          fontSize: 24,
        }}>📦</div>
        <div style={{ minWidth: 220, flex: '1 1 360px' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
            <h2 style={{ margin: 0, fontSize: 18, lineHeight: 1.35, color: C.warningInk || C.ink }}>
              ฟีเจอร์พัสดุปิดอยู่
            </h2>
            <Pill color="warning" size="sm">ปิดการใช้งาน</Pill>
          </div>
          <p style={{ margin: '0 0 10px 0', color: C.ink2, fontSize: 14, lineHeight: 1.65 }}>
            ตอนนี้ระบบบันทึกพัสดุและส่งแจ้งเตือนให้ผู้เช่าถูกปิดไว้ หน้านี้จึงไม่สามารถเพิ่ม แก้ไข ลบ ส่งแจ้งเตือน หรือบันทึกรับพัสดุได้
          </p>
          <div style={{
            display: 'grid',
            gap: 6,
            color: C.muted,
            fontSize: 13,
            lineHeight: 1.55,
          }}>
            <div>• ข้อมูลเดิมยังอยู่ในระบบ แต่ API จะตอบว่า FEATURE_DISABLED จนกว่าจะเปิดฟีเจอร์</div>
            <div>• ฝั่งผู้เช่าจะไม่เห็นปุ่มพัสดุในพอร์ทัลระหว่างที่ปิดฟีเจอร์นี้</div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: '0 1 220px' }}>
          <Btn variant="primary" onClick={onOpenFeatures}>ไปเปิดฟีเจอร์</Btn>
          <div style={{ color: C.muted, fontSize: 12, lineHeight: 1.4, textAlign: 'center' }}>
            เปิดที่ Features → parcelNotifications
          </div>
        </div>
      </div>
    </Card>
  );
}

function daysWaiting(item) {
  const created = item?.created_at || item?.createdAt;
  if (!created) return null;
  const ms = Date.now() - new Date(created).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 86_400_000);
}

function PageParcels({ setToast }) {
  const C = window.ADMIN_C;
  const { Card, Btn, Pill, PageContainer, PageHeader, EmptyState } = window;
  const apiCall = window.requireApiCall ? window.requireApiCall() : window.apiCall;
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState('waiting_pickup');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [featureDisabled, setFeatureDisabled] = useState(false);
  const [form, setForm] = useState(null);
  const [serverStats, setServerStats] = useState(null);
  const [lightbox, setLightbox] = useState(null); // { url, title, detail } — ป็อพอัพดูรูป
  const [pickup, setPickup] = useState(null); // รายการที่กำลังบันทึกรับ
  const [pickupErr, setPickupErr] = useState('');
  const [confirmAction, setConfirmAction] = useState(null); // { kind: 'returned'|'cancelled'|'delete', item }
  const [roomOptions, setRoomOptions] = useState([]);
  const [roomConflicts, setRoomConflicts] = useState([]);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [roomsErr, setRoomsErr] = useState('');
  const [parcelOptions, setParcelOptions] = useState(() => {
    const memory = readParcelOptionMemory();
    return {
      carriers: mergeOptionValues(DEFAULT_PARCEL_CARRIERS, memory.carriers),
      shelfLocations: memory.shelfLocations,
    };
  });
  const [lastParcelDefaults, setLastParcelDefaults] = useState(() => {
    const memory = readParcelOptionMemory();
    return {
      carrier: memory.lastCarrier || '',
      shelfLocation: memory.lastShelfLocation || '',
    };
  });

  useEffect(() => {
    if (!featureDisabled) return;
    setItems([]);
    setServerStats(null);
    setForm(null);
    setPickup(null);
    setPickupErr('');
    setConfirmAction(null);
    setLightbox(null);
  }, [featureDisabled]);

  function textFromError(e, fallback) {
    const raw = e && (e.error || e.message || e.hint) || fallback;
    return window.humanizeAdminErrorText ? window.humanizeAdminErrorText(raw, e || {}) : raw;
  }

  function toastNotice(notice, fallback) {
    const n = notice || {};
    const message = n.title && n.message ? `${n.title}: ${n.message}` : (n.message || n.title || fallback);
    setToast && setToast({ kind: n.kind || 'success', message });
  }

  function noteFeatureDisabled(e) {
    if (e && e.code === 'FEATURE_DISABLED') {
      setFeatureDisabled(true);
      return true;
    }
    return false;
  }

  async function load() {
    setLoading(true);
    setErr('');
    try {
      const params = new URLSearchParams();
      if (status && status !== 'all') params.set('status', status);
      if (q.trim()) params.set('q', q.trim());
      const d = await apiCall('/api/parcels' + (params.toString() ? '?' + params.toString() : ''), { timeoutMs: 12000 });
      setFeatureDisabled(false);
      setItems(Array.isArray(d.parcels) ? d.parcels : []);
    } catch (e) {
      noteFeatureDisabled(e);
      // แสดง error ชั้นเดียว: แบนเนอร์ inline (มีปุ่ม "ลองใหม่") เท่านั้น —
      // เดิมยิง toast ซ้อนอีกชั้นทำให้ผู้ใช้เห็นข้อความเดียวกันซ้ำ 2 ที่
      setErr(textFromError(e, 'โหลดรายการพัสดุไม่สำเร็จ'));
    } finally {
      setLoading(false);
    }
  }

  async function loadRooms() {
    setRoomsLoading(true);
    setRoomsErr('');
    try {
      const d = await apiCall('/api/parcels/rooms', { timeoutMs: 12000 });
      setRoomOptions(Array.isArray(d.rooms) ? d.rooms : []);
      setRoomConflicts(Array.isArray(d.conflicts) ? d.conflicts : []);
    } catch (e) {
      noteFeatureDisabled(e);
      setRoomsErr(textFromError(e, 'โหลดรายการห้องไม่สำเร็จ'));
    } finally {
      setRoomsLoading(false);
    }
  }

  async function loadParcelOptions() {
    const memory = readParcelOptionMemory();
    try {
      const d = await apiCall('/api/parcels/options', { timeoutMs: 12000 });
      setParcelOptions({
        carriers: mergeOptionValues(DEFAULT_PARCEL_CARRIERS, memory.carriers, d.carriers),
        shelfLocations: mergeOptionValues(memory.shelfLocations, d.shelfLocations),
      });
      setLastParcelDefaults({
        carrier: memory.lastCarrier || '',
        shelfLocation: memory.lastShelfLocation || '',
      });
    } catch (e) {
      noteFeatureDisabled(e);
      setParcelOptions({
        carriers: mergeOptionValues(DEFAULT_PARCEL_CARRIERS, memory.carriers),
        shelfLocations: mergeOptionValues(memory.shelfLocations),
      });
    }
  }

  async function loadStats() {
    try {
      const d = await apiCall('/api/parcels/stats', { timeoutMs: 12000 });
      if (d && d.counts) {
        setServerStats({ counts: d.counts, agingWaiting: Number(d.agingWaiting || 0) });
      }
    } catch (e) {
      noteFeatureDisabled(e);
      // ตัวเลขสรุปเป็นข้อมูลเสริม — โหลดไม่ได้ไม่ต้องบล็อกหน้า (ใช้ตัวเลขจากรายการแทน)
    }
  }

  function rememberParcelOptions(payload) {
    const carrier = String(payload?.carrier || '').trim();
    const shelfLocation = String(payload?.shelfLocation || '').trim();
    if (!carrier && !shelfLocation) return;
    setParcelOptions((prev) => {
      const next = {
        carriers: mergeOptionValues(carrier ? [carrier] : [], prev.carriers),
        shelfLocations: mergeOptionValues(shelfLocation ? [shelfLocation] : [], prev.shelfLocations),
      };
      const memory = {
        carriers: next.carriers.slice(0, 30),
        shelfLocations: next.shelfLocations.slice(0, 30),
        lastCarrier: carrier || lastParcelDefaults.carrier || '',
        lastShelfLocation: shelfLocation || lastParcelDefaults.shelfLocation || '',
      };
      try { localStorage.setItem(PARCEL_OPTION_STORAGE_KEY, JSON.stringify(memory)); } catch {}
      setLastParcelDefaults({
        carrier: memory.lastCarrier,
        shelfLocation: memory.lastShelfLocation,
      });
      return next;
    });
  }

  useEffect(() => {
    const timer = setTimeout(load, q.trim() ? 300 : 0);
    return () => clearTimeout(timer);
  }, [status, q]);

  useEffect(() => { loadRooms(); loadParcelOptions(); loadStats(); }, []);

  // ตัวเลขสรุปบนหัวเพจ/ตัวกรองต้องเป็น "จำนวนจริงทั้งระบบ" จาก /stats —
  // ห้ามนับจาก items เพราะ items ถูกกรองตามแท็บอยู่ (เลือกดู "รับแล้ว"
  // จะกลายเป็น "รอรับ 0" ทั้งที่มีของค้าง ทำให้แอดมินเข้าใจผิด)
  const localCounts = useMemo(() => ({
    waiting_pickup: items.filter((x) => x.status === 'waiting_pickup').length,
    picked_up: items.filter((x) => x.status === 'picked_up').length,
    returned: items.filter((x) => x.status === 'returned').length,
    cancelled: items.filter((x) => x.status === 'cancelled').length,
    all: items.length,
  }), [items]);
  const counts = serverStats?.counts || (status === 'all' ? localCounts : null);
  const agingWaiting = serverStats ? serverStats.agingWaiting : 0;

  async function save(payload) {
    if (featureDisabled || busy) return;
    setBusy(true);
    try {
      const isUpdate = !!payload.id;
      const { id, photo, ...body } = payload;
      const d = await apiCall(isUpdate ? `/api/parcels/${id}` : '/api/parcels', {
        method: isUpdate ? 'PUT' : 'POST',
        body: JSON.stringify(body),
        timeoutMs: 15000,
      });
      let savedParcel = d.parcel || null;
      let photoNotice = null;
      if (photo && savedParcel && savedParcel.id) {
        try {
          const pd = await apiCall(`/api/parcels/${savedParcel.id}/photo`, {
            method: 'POST',
            body: JSON.stringify({ photo }),
            timeoutMs: 20000,
          });
          savedParcel = pd.parcel || savedParcel;
          photoNotice = pd.notice || null;
        } catch (photoErr) {
          photoNotice = {
            kind: 'warning',
            title: 'บันทึกพัสดุแล้ว แต่รูปยังไม่สำเร็จ',
            message: textFromError(photoErr, 'เลือกรูป JPG, PNG หรือ WebP ขนาดไม่เกินประมาณ 1.5 MB แล้วลองอัปโหลดใหม่'),
          };
        }
      }
      rememberParcelOptions(body);
      setForm(null);
      const finalNotice = d.notice && photoNotice
        ? {
            kind: d.notice.kind === 'success' ? photoNotice.kind : d.notice.kind,
            title: d.notice.title,
            message: [d.notice.message, `${photoNotice.title}: ${photoNotice.message}`].filter(Boolean).join('\n'),
          }
        : (photoNotice || d.notice);
      toastNotice(finalNotice, isUpdate ? 'บันทึกพัสดุแล้ว' : 'เพิ่มพัสดุแล้ว');
      await load();
      loadStats();
    } catch (e) {
      if (noteFeatureDisabled(e)) return;
      window.toastError
        ? window.toastError(setToast, e, { action: payload.id ? 'บันทึกพัสดุ' : 'เพิ่มพัสดุ' })
        : setToast && setToast({ kind: 'danger', message: textFromError(e, 'บันทึกพัสดุไม่สำเร็จ') });
    } finally {
      setBusy(false);
    }
  }

  function openCreate() {
    if (featureDisabled) return;
    setForm({
      notify: true,
      carrier: lastParcelDefaults.carrier || '',
      shelfLocation: lastParcelDefaults.shelfLocation || '',
    });
    if (!roomOptions.length && !roomsLoading) loadRooms();
    if (!parcelOptions.carriers.length && !parcelOptions.shelfLocations.length) loadParcelOptions();
  }

  // สถานะบนจอเก่ากว่าฐานข้อมูลได้เสมอ (แอดมินอีกเครื่องเพิ่งปิดงาน/ลบ) —
  // ทุก action ที่โดน 409/404 ต้องปิดกล่องยืนยันแล้วรีโหลดให้ตรงความจริงทันที
  const STALE_PARCEL_CODES = new Set([
    'PARCEL_TERMINAL', 'PARCEL_ALREADY_CLOSED', 'PARCEL_ALREADY_PICKED',
    'PARCEL_STATE_CHANGED', 'PARCEL_NOT_FOUND',
  ]);
  async function recoverFromStaleParcel(e) {
    if (!e || !STALE_PARCEL_CODES.has(e.code)) return false;
    setConfirmAction(null);
    setPickup(null);
    await load();
    loadStats();
    return true;
  }

  async function deleteParcel(item) {
    if (featureDisabled || !item || busy) return;
    setBusy(true);
    try {
      const d = await apiCall(`/api/parcels/${item.id}`, {
        method: 'DELETE',
        timeoutMs: 12000,
      });
      setItems((prev) => prev.filter((x) => x.id !== item.id));
      setConfirmAction(null);
      toastNotice(d.notice, 'ลบรายการพัสดุแล้ว');
      loadStats();
    } catch (e) {
      if (noteFeatureDisabled(e)) return;
      await recoverFromStaleParcel(e);
      window.toastError
        ? window.toastError(setToast, e, { action: 'ลบพัสดุ' })
        : setToast && setToast({ kind: 'danger', message: textFromError(e, 'ลบพัสดุไม่สำเร็จ') });
    } finally {
      setBusy(false);
    }
  }

  // เปลี่ยนสถานะปิดงานทาง PUT — เหลือเฉพาะ "คืนผู้ส่ง/ยกเลิก"
  // ส่วน "รับแล้ว" ต้องผ่าน confirmPickup (POST /pickup) เท่านั้น
  // เพื่อให้แนบหลักฐานได้และกันรับซ้ำแบบ atomic ที่เซิร์ฟเวอร์
  async function updateStatus(item, nextStatus) {
    if (featureDisabled || !item || item.status !== 'waiting_pickup' || busy) return;
    if (nextStatus !== 'returned' && nextStatus !== 'cancelled') return;
    const label = PARCEL_STATUS_LABEL[nextStatus] || nextStatus;
    setBusy(true);
    try {
      const d = await apiCall(`/api/parcels/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: nextStatus }),
        timeoutMs: 12000,
      });
      setItems((prev) => prev.map((x) => x.id === item.id ? d.parcel : x));
      setConfirmAction(null);
      setToast && setToast({ kind: 'success', message: `อัปเดตเป็น "${label}" แล้ว` });
      loadStats();
    } catch (e) {
      if (noteFeatureDisabled(e)) return;
      await recoverFromStaleParcel(e);
      window.toastError
        ? window.toastError(setToast, e, { action: 'เปลี่ยนสถานะพัสดุ' })
        : setToast && setToast({ kind: 'danger', message: textFromError(e, 'เปลี่ยนสถานะไม่สำเร็จ') });
    } finally {
      setBusy(false);
    }
  }

  // บันทึกรับพัสดุ: สถานะ + หลักฐาน (ถ้าแนบ) ไปด้วยกันในคำขอเดียว
  async function confirmPickup(payload) {
    if (featureDisabled || !pickup || busy) return;
    setBusy(true);
    setPickupErr('');
    try {
      const d = await apiCall(`/api/parcels/${pickup.id}/pickup`, {
        method: 'POST',
        body: JSON.stringify(payload || {}),
        timeoutMs: 25000,
      });
      setItems((prev) => prev.map((x) => x.id === pickup.id ? d.parcel : x));
      setPickup(null);
      toastNotice(d.notice, 'บันทึกรับพัสดุแล้ว');
      loadStats();
    } catch (e) {
      if (noteFeatureDisabled(e)) return;
      if (e && e.code === 'PICKUP_PROOF_INVALID') {
        // เซิร์ฟเวอร์ยังไม่เปลี่ยนสถานะ — เปิดกล่องค้างไว้ให้แก้รูป
        // หรือกดบันทึกแบบไม่แนบหลักฐานแทน
        setPickupErr(textFromError(e, 'บันทึกหลักฐานไม่สำเร็จ ลองเลือกรูปใหม่หรือบันทึกโดยไม่แนบรูป'));
        return;
      }
      const recovered = await recoverFromStaleParcel(e);
      window.toastError
        ? window.toastError(setToast, e, { action: 'บันทึกรับพัสดุ' })
        : setToast && setToast({
            kind: recovered ? 'warning' : 'danger',
            message: textFromError(e, 'บันทึกรับพัสดุไม่สำเร็จ'),
          });
    } finally {
      setBusy(false);
    }
  }

  async function notify(item) {
    if (featureDisabled || !item || item.status !== 'waiting_pickup') return;
    setBusy(true);
    try {
      const d = await apiCall(`/api/parcels/${item.id}/notify`, {
        method: 'POST',
        body: JSON.stringify({}),
        timeoutMs: 15000,
      });
      setItems((prev) => prev.map((x) => x.id === item.id ? d.parcel : x));
      toastNotice(d.notice, 'ส่งแจ้งเตือนแล้ว');
    } catch (e) {
      if (noteFeatureDisabled(e)) return;
      await recoverFromStaleParcel(e);
      window.toastError
        ? window.toastError(setToast, e, { action: 'ส่งแจ้งเตือนพัสดุ' })
        : setToast && setToast({ kind: 'danger', message: textFromError(e, 'ส่งแจ้งเตือนไม่สำเร็จ') });
    } finally {
      setBusy(false);
    }
  }

  function openFeatureSettings() {
    window.location.hash = '#features';
  }

  if (featureDisabled) {
    return (
      <PageContainer>
        <PageHeader
          title="พัสดุ"
          subtitle="ลงทะเบียนพัสดุเข้า แจ้งเตือนผู้เช่า และบันทึกการรับพร้อมหลักฐาน"
          actions={
            <Btn variant="primary" onClick={openFeatureSettings}>
              ไปเปิดฟีเจอร์
            </Btn>
          }
        />
        <ParcelFeatureDisabledPanel onOpenFeatures={openFeatureSettings} />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="พัสดุ"
        subtitle={counts
          ? `รอผู้เช่ารับ ${counts.waiting_pickup} · รับแล้ว ${counts.picked_up} · คืนผู้ส่ง ${counts.returned} · ยกเลิก ${counts.cancelled} · ทั้งหมด ${counts.all} รายการ`
          : `แสดง ${items.length} รายการในตัวกรองนี้`}
        actions={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn variant="secondary" onClick={() => { load(); loadStats(); }} disabled={loading || busy}>รีเฟรช</Btn>
            <Btn variant="primary" icon="+" onClick={openCreate} disabled={loading || busy}>
              เพิ่มพัสดุ
            </Btn>
          </div>
        }
      />

      {agingWaiting > 0 ? (
        <Card style={{
          background: C.warningSoft, color: C.warningInk,
          border: '1px solid ' + C.warning, fontSize: 13.5, lineHeight: 1.6,
        }}>
          มีพัสดุค้างรอรับเกิน 7 วันอยู่ {agingWaiting} รายการ —
          แนะนำกด "ส่งแจ้งซ้ำ" หรือติดต่อผู้เช่าโดยตรง ก่อนตัดสินใจคืนผู้ส่ง
        </Card>
      ) : null}

      <Card>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ค้นหาเลขพัสดุ, ห้อง, ผู้รับ, ขนส่ง..."
            style={{
              flex: '1 1 260px', minWidth: 220,
              height: 38, padding: '0 12px', borderRadius: 8,
              border: '1px solid ' + C.border, background: C.surfaceAlt,
              color: C.ink, fontFamily: 'inherit', fontSize: 13.5,
            }}
          />
        </div>

        {/* ตัวกรองสถานะแบบ chips — แยกทุกสถานะออกจากกันชัดเจน พร้อมจำนวนจริง
            จากฐานข้อมูล (ไม่ใช่จำนวนเฉพาะหน้าที่กรองอยู่) */}
        <div role="tablist" aria-label="กรองตามสถานะพัสดุ" style={{
          display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16,
        }}>
          {[
            { id: 'waiting_pickup', label: PARCEL_STATUS_LABEL.waiting_pickup },
            { id: 'picked_up', label: PARCEL_STATUS_LABEL.picked_up },
            { id: 'returned', label: PARCEL_STATUS_LABEL.returned },
            { id: 'cancelled', label: PARCEL_STATUS_LABEL.cancelled },
            { id: 'all', label: 'ทั้งหมด' },
          ].map((f) => {
            const active = status === f.id;
            const count = counts ? counts[f.id === 'all' ? 'all' : f.id] : null;
            return (
              <button key={f.id} type="button" role="tab" aria-selected={active}
                onClick={() => setStatus(f.id)} disabled={loading && active} style={{
                  padding: '7px 14px', borderRadius: 999, cursor: 'pointer',
                  border: '1px solid ' + (active ? C.ink : C.border),
                  background: active ? C.ink : C.surface,
                  color: active ? C.surface : C.ink2,
                  fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                  whiteSpace: 'nowrap',
                }}>
                {f.label}
                {count != null ? (
                  <span style={{ opacity: 0.65, marginLeft: 6 }}>{count}</span>
                ) : null}
              </button>
            );
          })}
        </div>

        {err && !featureDisabled ? (
          <div style={{
            padding: 14, borderRadius: 8, marginBottom: 12,
            background: C.dangerSoft, color: C.dangerInk || C.danger,
            display: 'flex', gap: 12, justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>{err}</span>
            <Btn size="sm" variant="secondary" onClick={load}>ลองใหม่</Btn>
          </div>
        ) : null}

        {loading && items.length === 0 ? (
          <div role="status" style={{
            padding: 32, textAlign: 'center', color: C.muted,
            border: '1px dashed ' + C.borderStrong, borderRadius: 10,
          }}>กำลังโหลดรายการพัสดุ...</div>
        ) : items.length === 0 ? (
          <EmptyState
            icon="📦"
            title="ยังไม่มีรายการพัสดุ"
            description={featureDisabled ? 'เปิดฟีเจอร์ก่อนเพิ่มรายการพัสดุ' : 'กดเพิ่มพัสดุเมื่อมีของมาถึง แล้วระบบจะแจ้งผู้เช่าตามช่องทางที่ตั้งไว้'}
          />
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {items.map((item) => (
              <ParcelRow
                key={item.id}
                item={item}
                busy={busy}
                onEdit={() => setForm(item)}
                onNotify={() => notify(item)}
                onPickup={() => { setPickupErr(''); setPickup(item); }}
                onReturned={() => setConfirmAction({ kind: 'returned', item })}
                onCancelled={() => setConfirmAction({ kind: 'cancelled', item })}
                onDelete={() => setConfirmAction({ kind: 'delete', item })}
                onShowPhoto={setLightbox}
              />
            ))}
          </div>
        )}
      </Card>

      {form ? (
        <ParcelForm
          initial={form}
          busy={busy}
          roomOptions={roomOptions}
          roomConflicts={roomConflicts}
          roomsLoading={roomsLoading}
          roomsErr={roomsErr}
          parcelOptions={parcelOptions}
          onReloadRooms={loadRooms}
          onCancel={() => setForm(null)}
          onSave={save}
        />
      ) : null}

      {/* ป็อพอัพดูรูปพัสดุ/หลักฐาน — เปิดในหน้าเดิม ไม่เปิดแท็บใหม่ */}
      {lightbox ? (
        <ParcelPhotoLightbox photo={lightbox} onClose={() => setLightbox(null)} />
      ) : null}

      {pickup ? (
        <ParcelPickupModal
          item={pickup}
          busy={busy}
          error={pickupErr}
          onCancel={() => { if (!busy) { setPickup(null); setPickupErr(''); } }}
          onConfirm={confirmPickup}
        />
      ) : null}

      {confirmAction ? (
        <ParcelActionConfirmModal
          action={confirmAction.kind}
          item={confirmAction.item}
          busy={busy}
          onCancel={() => { if (!busy) setConfirmAction(null); }}
          onConfirm={() => {
            if (confirmAction.kind === 'delete') deleteParcel(confirmAction.item);
            else updateStatus(confirmAction.item, confirmAction.kind);
          }}
        />
      ) : null}
    </PageContainer>
  );
}

// ปุ่มรูปย่อ — กดแล้วเปิดป็อพอัพ (lightbox) ในหน้าเดิม ไม่เปิดแท็บ/หน้าใหม่
function ParcelThumb({ url, label, caption, onShowPhoto }) {
  const C = window.ADMIN_C;
  return (
    <button type="button" title={`ดู${label} (ป็อพอัพ)`}
      onClick={() => onShowPhoto && onShowPhoto({ url, title: label, detail: caption })}
      style={{
        width: 76, padding: 0, cursor: 'zoom-in',
        border: '1px solid ' + C.border, borderRadius: 8,
        background: C.surfaceAlt, overflow: 'hidden',
        display: 'block', fontFamily: 'inherit',
      }}>
      <img src={url} alt={label} loading="lazy" style={{
        width: '100%', height: 64, objectFit: 'cover', display: 'block',
      }} />
      <span style={{
        display: 'block', fontSize: 10.5, color: C.muted,
        padding: '2px 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{label}</span>
    </button>
  );
}

function ParcelRow({ item, busy, onEdit, onNotify, onPickup, onReturned, onCancelled, onDelete, onShowPhoto }) {
  const C = window.ADMIN_C;
  const { Btn, Pill } = window;
  const status = item.status || 'waiting_pickup';
  const canAct = status === 'waiting_pickup';
  const parcelNo = item.parcel_no || item.parcelNo || `#${item.id}`;
  const roomId = item.room_id || item.roomId || '-';
  const tenantName = item.tenant_name || item.recipient_name || item.recipientName || '-';
  const tracking = item.tracking_no || item.trackingNo || '';
  const photoUrl = item.photo_url || item.photoUrl || '';
  const proofUrl = item.pickup_proof_url || item.pickupProofUrl || '';
  const notifyStatus = item.last_notify_status || item.lastNotifyStatus || '';
  const notification = notifySummary(item);
  const created = item.created_at || item.createdAt;
  const pickedAt = item.picked_up_at || item.pickedUpAt;
  const pickedBy = item.picked_up_by || item.pickedUpBy || '';
  const waitedDays = status === 'waiting_pickup' ? daysWaiting(item) : null;
  return (
    <div style={{
      border: '1px solid ' + C.border, borderRadius: 10,
      padding: 14, background: C.surface,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      gap: 12, flexWrap: 'wrap',
    }}>
      {photoUrl || proofUrl ? (
        <div style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {photoUrl ? (
            <ParcelThumb url={photoUrl} label="รูปพัสดุ" onShowPhoto={onShowPhoto}
              caption={`${parcelNo} · ห้อง ${roomId} · ถ่ายตอนพัสดุมาถึง`} />
          ) : null}
          {proofUrl ? (
            <ParcelThumb url={proofUrl} label="หลักฐานรับ" onShowPhoto={onShowPhoto}
              caption={`${parcelNo} · รับเมื่อ ${pickedAt ? new Date(pickedAt).toLocaleString('th-TH') : '-'}${pickedBy ? ` · ผู้บันทึก ${pickedBy}` : ''}`} />
          ) : null}
        </div>
      ) : null}
      <div style={{ minWidth: 0, flex: '1 1 300px' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>{parcelNo}</span>
          <Pill color={PARCEL_STATUS_TONE[status] || 'neutral'} size="sm">
            {PARCEL_STATUS_LABEL[status] || status}
          </Pill>
          {waitedDays != null && waitedDays >= 1 ? (
            <Pill color={waitedDays >= 7 ? 'danger' : waitedDays >= 3 ? 'warning' : 'neutral'} size="sm">
              รอมาแล้ว {waitedDays} วัน
            </Pill>
          ) : null}
          {notifyStatus ? (
            <Pill color={notifyStatus === 'sent' ? 'success' : notifyStatus === 'queued' ? 'warning' : 'neutral'} size="sm">
              แจ้งเตือน: {PARCEL_NOTIFY_LABEL[notifyStatus] || notifyStatus}
            </Pill>
          ) : null}
          <Pill color={notification.tone} size="sm">
            {notification.label}
          </Pill>
        </div>
        <div style={{ color: C.ink2, fontSize: 13.5, lineHeight: 1.6 }}>
          <b>ห้อง {roomId}</b> · ผู้รับ {tenantName}
          {item.carrier ? ` · ${item.carrier}` : ''}
          {tracking ? ` · ${tracking}` : ''}
        </div>
        <div style={{ color: C.muted, fontSize: 12.5, marginTop: 4, lineHeight: 1.5 }}>
          {item.shelf_location || item.shelfLocation ? `จุดรับ: ${item.shelf_location || item.shelfLocation}` : 'ยังไม่ระบุจุดรับ'}
          {item.note ? ` · หมายเหตุ: ${item.note}` : ''}
          {created ? ` · บันทึกเมื่อ ${new Date(created).toLocaleString('th-TH')}` : ''}
        </div>
        {status === 'picked_up' ? (
          <div style={{ color: C.successInk || C.ink2, fontSize: 12.5, marginTop: 4, lineHeight: 1.5 }}>
            รับเมื่อ {pickedAt ? new Date(pickedAt).toLocaleString('th-TH') : '-'}
            {pickedBy ? ` · ผู้บันทึก ${pickedBy}` : ''}
            {proofUrl ? ' · มีหลักฐานการรับ (กดที่รูปเพื่อดู)' : ' · ไม่ได้แนบหลักฐาน'}
          </div>
        ) : null}
        <div style={{ color: C.ink2, fontSize: 12.5, marginTop: 4, lineHeight: 1.5 }}>
          {notification.detail}
          {item.notified_at || item.notifiedAt ? ` · ล่าสุด ${new Date(item.notified_at || item.notifiedAt).toLocaleString('th-TH')}` : ''}
        </div>
        {item.last_notify_error || item.lastNotifyError ? (
          <div style={{ marginTop: 6, color: C.warningInk || C.warning, fontSize: 12.5 }}>
            แจ้งเตือนล่าสุด: {item.last_notify_error || item.lastNotifyError}
          </div>
        ) : null}
      </div>
      <div style={{
        display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end',
        flexWrap: 'wrap', flex: '1 1 220px',
      }}>
        <Btn size="sm" variant="ghost" onClick={onEdit} disabled={busy}>แก้ไข</Btn>
        <Btn size="sm" variant="secondary" onClick={onNotify} disabled={busy || !canAct}>ส่งแจ้งซ้ำ</Btn>
        <Btn size="sm" variant="primary" onClick={onPickup} disabled={busy || !canAct}
          title="เปิดหน้าต่างบันทึกรับ — แนบหลักฐานหรือถ่ายรูปได้ (ไม่บังคับ)">
          บันทึกรับ
        </Btn>
        <Btn size="sm" variant="ghost" onClick={onReturned} disabled={busy || !canAct}>คืนผู้ส่ง</Btn>
        <Btn size="sm" variant="danger" onClick={onCancelled} disabled={busy || !canAct}>ยกเลิก</Btn>
        <Btn size="sm" variant="danger" onClick={onDelete} disabled={busy}>ลบ</Btn>
      </div>
    </div>
  );
}

// ป็อพอัพดูรูป (lightbox) — แทนการเปิดรูปในแท็บใหม่ ผู้ใช้กดปิด/ESC/คลิกพื้นหลัง
// เพื่อกลับมาที่รายการเดิมได้ทันที และมี fallback เมื่อไฟล์รูปหายจากระบบ
function ParcelPhotoLightbox({ photo, onClose }) {
  const C = window.ADMIN_C;
  const { Modal, Btn } = window;
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [photo && photo.url]);
  if (!photo || !photo.url) return null;
  return (
    <Modal open={true} onClose={onClose} title={photo.title || 'รูปพัสดุ'} width={720}>
      <div style={{ display: 'grid', gap: 10 }}>
        {broken ? (
          <div style={{
            padding: 28, textAlign: 'center', color: C.muted,
            border: '1px dashed ' + C.borderStrong, borderRadius: 10,
          }}>
            เปิดรูปไม่สำเร็จ ไฟล์อาจถูกย้ายหรือถูกลบไปแล้ว — กดรีเฟรชรายการพัสดุแล้วลองอีกครั้ง
          </div>
        ) : (
          <img src={photo.url} alt={photo.title || 'รูปพัสดุ'} onError={() => setBroken(true)}
            style={{
              maxWidth: '100%', maxHeight: '64vh', margin: '0 auto',
              objectFit: 'contain', display: 'block', borderRadius: 10,
              border: '1px solid ' + C.border, background: C.surfaceAlt,
            }} />
        )}
        {photo.detail ? (
          <div style={{ color: C.muted, fontSize: 12.5, textAlign: 'center', lineHeight: 1.5 }}>
            {photo.detail}
          </div>
        ) : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Btn variant="secondary" type="button" onClick={onClose}>ปิด</Btn>
        </div>
      </div>
    </Modal>
  );
}

// หน้าต่างบันทึกรับพัสดุ — แนบหลักฐานได้ 2 ทาง (ถ่ายรูปจากกล้อง / เลือกรูปจากเครื่อง)
// หรือไม่แนบเลยก็ได้ รูปใหญ่ถูกย่ออัตโนมัติก่อนส่ง และกันกดซ้ำระหว่างกำลังบันทึก
function ParcelPickupModal({ item, busy, error, onCancel, onConfirm }) {
  const C = window.ADMIN_C;
  const { Modal, Btn } = window;
  const [pickedUpBy, setPickedUpBy] = useState('');
  const [proof, setProof] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const cameraInputRef = React.useRef(null);
  const galleryInputRef = React.useRef(null);
  const parcelNo = item.parcel_no || item.parcelNo || `#${item.id}`;
  const roomId = item.room_id || item.roomId || '-';
  const tenantName = item.tenant_name || item.recipient_name || item.recipientName || '-';
  const tracking = item.tracking_no || item.trackingNo || '';
  const lbl = { display: 'block', fontSize: 12.5, color: C.muted, margin: '12px 0 4px' };
  const inp = {
    width: '100%', padding: '9px 10px', borderRadius: 7,
    border: '1px solid ' + C.border, background: C.surfaceAlt,
    color: C.ink, fontFamily: 'inherit', fontSize: 13.5,
    boxSizing: 'border-box',
  };

  async function handleProofFile(ev) {
    const input = ev.target;
    const file = input.files && input.files[0];
    // เคลียร์ค่า input เสมอ — เลือกไฟล์เดิมซ้ำได้ และกันไฟล์ค้างข้ามรอบ
    input.value = '';
    if (!file) return;
    setPhotoError('');
    setPhotoBusy(true);
    try {
      setProof(await prepareParcelPhoto(file));
    } catch (e) {
      setProof('');
      setPhotoError(e?.message || 'เตรียมรูปไม่สำเร็จ กรุณาลองใหม่');
    } finally {
      setPhotoBusy(false);
    }
  }

  function submit(e) {
    e.preventDefault();
    if (busy || photoBusy) return; // กันกดซ้ำ และกันส่งระหว่างรูปยังย่อไม่เสร็จ
    onConfirm({
      ...(pickedUpBy.trim() ? { pickedUpBy: pickedUpBy.trim() } : {}),
      ...(proof ? { proof } : {}),
    });
  }

  return (
    <Modal open={true} onClose={onCancel} title={`บันทึกรับพัสดุ ${parcelNo}`} width={520}>
      <form onSubmit={submit}>
        <div style={{
          padding: 12, borderRadius: 8, background: C.surfaceAlt,
          color: C.ink2, fontSize: 13, lineHeight: 1.6,
        }}>
          <b>ห้อง {roomId}</b> · ผู้รับ {tenantName}
          {item.carrier ? ` · ${item.carrier}` : ''}
          {tracking ? ` · ${tracking}` : ''}
          {item.shelf_location || item.shelfLocation ? (
            <div>จุดรับ: {item.shelf_location || item.shelfLocation}</div>
          ) : null}
        </div>

        <label style={lbl}>ผู้มารับ / ผู้บันทึก (ไม่บังคับ)</label>
        <input value={pickedUpBy} onChange={(e) => setPickedUpBy(e.target.value)}
          maxLength={120} placeholder="เว้นว่าง = ใช้ชื่อแอดมินที่ล็อกอินอยู่" style={inp} />

        <label style={lbl}>หลักฐานการรับ (แนบหรือไม่แนบก็ได้)</label>
        <div style={{
          display: 'grid', gridTemplateColumns: '96px minmax(0, 1fr)',
          gap: 12, alignItems: 'start',
        }}>
          <div style={{
            width: 96, height: 96, borderRadius: 8,
            border: '1px dashed ' + C.borderStrong, background: C.surfaceAlt,
            overflow: 'hidden', display: 'grid', placeItems: 'center',
            color: C.muted, fontSize: 12, textAlign: 'center',
          }}>
            {photoBusy ? 'กำลังย่อรูป...' : proof ? (
              <img src={proof} alt="หลักฐานการรับ" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            ) : 'ไม่มีรูป'}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Btn size="sm" variant="secondary" type="button" disabled={busy || photoBusy}
                onClick={() => cameraInputRef.current && cameraInputRef.current.click()}>
                📷 ถ่ายรูป
              </Btn>
              <Btn size="sm" variant="secondary" type="button" disabled={busy || photoBusy}
                onClick={() => galleryInputRef.current && galleryInputRef.current.click()}>
                🖼 เลือกรูปจากเครื่อง
              </Btn>
              {proof ? (
                <Btn size="sm" variant="ghost" type="button" disabled={busy || photoBusy}
                  onClick={() => { setProof(''); setPhotoError(''); }}>
                  ล้างรูป
                </Btn>
              ) : null}
            </div>
            {/* input คู่: อันแรกบังคับเปิดกล้อง (มือถือ), อันสองเปิดคลังรูป/ไฟล์ */}
            <input ref={cameraInputRef} type="file" accept="image/jpeg,image/png,image/webp"
              capture="environment" onChange={handleProofFile} style={{ display: 'none' }} />
            <input ref={galleryInputRef} type="file" accept="image/jpeg,image/png,image/webp"
              onChange={handleProofFile} style={{ display: 'none' }} />
            <div style={{
              color: photoError ? (C.dangerInk || C.danger) : C.muted,
              fontSize: 12, marginTop: 8, lineHeight: 1.5,
            }}>
              {photoError || 'รองรับ JPG, PNG, WebP — รูปใหญ่ระบบย่อให้อัตโนมัติ ไม่แนบหลักฐานก็บันทึกรับได้'}
            </div>
          </div>
        </div>

        {error ? (
          <div style={{
            marginTop: 12, padding: 10, borderRadius: 8,
            background: C.dangerSoft, color: C.dangerInk || C.danger,
            fontSize: 12.5, lineHeight: 1.5,
          }}>{error}</div>
        ) : null}

        <div style={{
          marginTop: 12, padding: 10, borderRadius: 8,
          background: C.warningSoft, color: C.warningInk, fontSize: 12.5, lineHeight: 1.5,
        }}>
          เมื่อบันทึกรับแล้ว รายการจะปิดงานถาวร เปลี่ยนกลับเป็นรอรับไม่ได้
          และระบบจะไม่ส่งแจ้งเตือนซ้ำสำหรับรายการนี้
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Btn variant="ghost" type="button" onClick={onCancel} disabled={busy}>ยกเลิก</Btn>
          <Btn variant="primary" type="submit" disabled={busy || photoBusy}>
            {busy ? 'กำลังบันทึก...' : proof ? 'บันทึกรับพร้อมหลักฐาน' : 'บันทึกรับ (ไม่แนบหลักฐาน)'}
          </Btn>
        </div>
      </form>
    </Modal>
  );
}

// ข้อความยืนยันต่อ action — บอกผลลัพธ์ถาวรชัด ๆ ก่อนกด ใช้ modal ของระบบ
// แทนกล่องยืนยันดั้งเดิมของเบราว์เซอร์ที่อ่านยาก กดพลาดง่าย และจัดรูปแบบไม่ได้
const PARCEL_CONFIRM_COPY = {
  returned: {
    title: 'ยืนยันคืนพัสดุให้ผู้ส่ง',
    button: 'ยืนยันคืนผู้ส่ง',
    variant: 'primary',
    warning: 'ใช้เมื่อผู้เช่าไม่มารับจนต้องส่งคืนต้นทาง รายการจะปิดงานถาวร เปลี่ยนกลับเป็นรอรับไม่ได้ และจะไม่ส่งแจ้งเตือนซ้ำ',
  },
  cancelled: {
    title: 'ยืนยันยกเลิกรายการพัสดุ',
    button: 'ยืนยันยกเลิก',
    variant: 'danger',
    warning: 'ใช้เมื่อบันทึกผิดรายการ/ไม่มีพัสดุจริง รายการจะปิดงานถาวร เปลี่ยนกลับเป็นรอรับไม่ได้',
  },
  delete: {
    title: 'ยืนยันลบรายการพัสดุ',
    button: 'ลบรายการ',
    variant: 'danger',
    warning: 'รายการจะถูกซ่อนจากหน้าแอดมินและหน้าผู้เช่า แต่ยังเก็บ audit ไว้ตรวจย้อนหลังได้',
  },
};

function ParcelActionConfirmModal({ action, item, busy, onCancel, onConfirm }) {
  const C = window.ADMIN_C;
  const { Modal, Btn, Pill } = window;
  const copy = PARCEL_CONFIRM_COPY[action];
  if (!copy || !item) return null;
  const status = item.status || 'waiting_pickup';
  const parcelNo = item.parcel_no || item.parcelNo || `#${item.id}`;
  const summary = notifySummary(item);
  return (
    <Modal open={true} onClose={onCancel} title={copy.title} width={480}>
      <div style={{
        padding: 12, borderRadius: 8, background: C.surfaceAlt,
        color: C.ink2, fontSize: 13, lineHeight: 1.7,
      }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <b style={{ color: C.ink }}>{parcelNo}</b>
          <Pill color={PARCEL_STATUS_TONE[status] || 'neutral'} size="sm">
            {PARCEL_STATUS_LABEL[status] || status}
          </Pill>
        </div>
        <div>ห้อง {item.room_id || item.roomId || '-'} · ผู้รับ {item.tenant_name || item.recipient_name || item.recipientName || '-'}</div>
        {item.carrier || item.tracking_no || item.trackingNo ? (
          <div>{[item.carrier, item.tracking_no || item.trackingNo].filter(Boolean).join(' · ')}</div>
        ) : null}
        <div>{summary.label} · {summary.detail}</div>
      </div>
      {action === 'delete' && status === 'waiting_pickup' ? (
        <div style={{
          marginTop: 10, padding: 10, borderRadius: 8,
          background: C.dangerSoft, color: C.dangerInk || C.danger,
          fontSize: 12.5, lineHeight: 1.6,
        }}>
          รายการนี้ยังอยู่สถานะ "รอผู้เช่ารับ" — ถ้าของยังอยู่จริง การลบจะทำให้ผู้เช่า
          ไม่เห็นรายการและไม่ถูกแจ้งเตือนอีก ตรวจให้แน่ใจก่อนลบ
        </div>
      ) : null}
      <div style={{
        marginTop: 10, padding: 10, borderRadius: 8,
        background: C.warningSoft, color: C.warningInk, fontSize: 12.5, lineHeight: 1.6,
      }}>
        {copy.warning}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <Btn variant="ghost" type="button" onClick={onCancel} disabled={busy}>ยกเลิก</Btn>
        <Btn variant={copy.variant} type="button" onClick={onConfirm} disabled={busy}>
          {busy ? 'กำลังบันทึก...' : copy.button}
        </Btn>
      </div>
    </Modal>
  );
}

function ParcelForm({
  initial,
  busy,
  roomOptions = [],
  roomConflicts = [],
  roomsLoading = false,
  roomsErr = '',
  parcelOptions = { carriers: [], shelfLocations: [] },
  onReloadRooms,
  onCancel,
  onSave,
}) {
  const C = window.ADMIN_C;
  const { Modal, Btn } = window;
  const isUpdate = !!initial.id;
  const initialPhotoUrl = initial.photo_url || initial.photoUrl || '';
  const [form, setForm] = useState({
    roomId: initial.room_id || initial.roomId || '',
    recipientName: initial.recipient_name || initial.recipientName || '',
    carrier: initial.carrier || '',
    trackingNo: initial.tracking_no || initial.trackingNo || '',
    shelfLocation: initial.shelf_location || initial.shelfLocation || '',
    note: initial.note || '',
    notify: initial.notify !== false,
  });
  const [photoDataUrl, setPhotoDataUrl] = useState('');
  const [photoPreview, setPhotoPreview] = useState(initialPhotoUrl);
  const [photoError, setPhotoError] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);
  const selectedRoom = roomOptions.find((r) => String(r.roomId) === String(form.roomId)) || null;
  const lbl = { display: 'block', fontSize: 12.5, color: C.muted, margin: '10px 0 4px' };
  const inp = {
    width: '100%', padding: '9px 10px', borderRadius: 7,
    border: '1px solid ' + C.border, background: C.surfaceAlt,
    color: C.ink, fontFamily: 'inherit', fontSize: 13.5,
    boxSizing: 'border-box',
  };

  function selectRoom(roomId) {
    const room = roomOptions.find((r) => String(r.roomId) === String(roomId));
    setForm({
      ...form,
      roomId,
      recipientName: room ? (room.tenantName || '') : '',
    });
  }

  async function choosePhoto(ev) {
    const input = ev.target;
    const file = input.files && input.files[0];
    // เคลียร์ input เสมอ — เลือกไฟล์เดิมซ้ำหลังแก้รูปได้ ไม่ค้างไฟล์เก่า
    input.value = '';
    setPhotoError('');
    setPhotoDataUrl('');
    if (!file) {
      setPhotoPreview(initialPhotoUrl);
      return;
    }
    setPhotoBusy(true);
    try {
      // รูปใหญ่ (เช่นรูปจากกล้องมือถือ) ถูกย่ออัตโนมัติ — ไม่ reject ทิ้งเฉย ๆ
      const dataUrl = await prepareParcelPhoto(file);
      setPhotoDataUrl(dataUrl);
      setPhotoPreview(dataUrl);
    } catch (err) {
      setPhotoPreview(initialPhotoUrl);
      setPhotoError(err?.message || 'เตรียมรูปไม่สำเร็จ กรุณาเลือกรูปใหม่');
    } finally {
      setPhotoBusy(false);
    }
  }

  function submit(e) {
    e.preventDefault();
    if (busy || photoBusy) return; // กันกดซ้ำ และกันส่งระหว่างรูปยังย่อไม่เสร็จ
    if (photoError) return; // ข้อความ error แสดงอยู่ใต้ช่องรูปแล้ว
    if (!isUpdate && !form.roomId.trim()) {
      alert('กรุณาระบุห้องที่รับพัสดุ');
      return;
    }
    const base = {
      recipientName: form.recipientName.trim() || undefined,
      carrier: form.carrier.trim() || undefined,
      trackingNo: form.trackingNo.trim() || undefined,
      shelfLocation: form.shelfLocation.trim() || undefined,
      note: form.note.trim() || undefined,
    };
    onSave(isUpdate
      ? { id: initial.id, ...base, ...(photoDataUrl ? { photo: photoDataUrl } : {}) }
      : { roomId: form.roomId.trim(), ...base, notify: form.notify, ...(photoDataUrl ? { photo: photoDataUrl } : {}) });
  }

  return (
    <Modal open={true} onClose={onCancel} title={isUpdate ? 'แก้ไขพัสดุ' : 'เพิ่มพัสดุ'} width={560}>
      <form onSubmit={submit}>
        {!isUpdate ? (
          <React.Fragment>
            <label style={lbl}>ห้อง</label>
            <select value={form.roomId} onChange={(e) => selectRoom(e.target.value)}
              required disabled={roomsLoading || roomOptions.length === 0} style={inp}>
              <option value="">{roomsLoading ? 'กำลังโหลดห้อง...' : 'เลือกห้องที่มีผู้เช่า active'}</option>
              {roomOptions.map((r) => (
                <option key={r.roomId} value={r.roomId}>
                  {r.label || `ห้อง ${r.roomId} · ${r.tenantName || '-'}`}
                </option>
              ))}
            </select>
            {selectedRoom ? (
              <div style={{
                marginTop: 8, padding: 10, borderRadius: 8,
                background: C.surfaceAlt, color: C.ink2, fontSize: 13, lineHeight: 1.5,
              }}>
                ดึงข้อมูลแล้ว: ห้อง {selectedRoom.roomId} · ผู้เช่า {selectedRoom.tenantName || '-'}
                {selectedRoom.phone ? ` · ${selectedRoom.phone}` : ''}
              </div>
            ) : null}
            {roomsErr ? (
              <div style={{ marginTop: 8, color: C.danger, fontSize: 12.5 }}>
                {roomsErr} <button type="button" onClick={onReloadRooms} style={{ marginLeft: 6 }}>ลองใหม่</button>
              </div>
            ) : null}
            {!roomsLoading && roomOptions.length === 0 && !roomsErr ? (
              <div style={{ marginTop: 8, color: C.warningInk || C.warning, fontSize: 12.5 }}>
                ยังไม่มีห้องที่มีผู้เช่า active แบบชัดเจนให้เลือก กรุณาผูกผู้เช่าเข้าห้องก่อนเพิ่มพัสดุ
              </div>
            ) : null}
            {roomConflicts.length ? (
              <div style={{ marginTop: 8, color: C.warningInk || C.warning, fontSize: 12.5 }}>
                มี {roomConflicts.length} ห้องที่มีผู้เช่า active ซ้ำ จึงถูกซ่อนจากตัวเลือกเพื่อกันส่งผิดห้อง
              </div>
            ) : null}
            <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>
              ระบบจะตรวจว่าห้องนี้มีผู้เช่า active แค่ 1 รายก่อนบันทึก เพื่อกันส่งแจ้งผิดห้อง
            </div>
          </React.Fragment>
        ) : (
          <div style={{
            padding: 10, borderRadius: 8, background: C.surfaceAlt,
            color: C.ink2, fontSize: 13, marginBottom: 4,
          }}>
            ห้อง {initial.room_id || initial.roomId || '-'} · {initial.parcel_no || initial.parcelNo || ''}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={lbl}>ชื่อผู้รับ (ถ้ามี)</label>
            <input value={form.recipientName} onChange={(e) => setForm({ ...form, recipientName: e.target.value })}
              maxLength={120} placeholder="เว้นว่าง = ใช้ชื่อผู้เช่าปัจจุบัน" style={inp} />
          </div>
          <div>
            <label style={lbl}>ขนส่ง</label>
            <input value={form.carrier} onChange={(e) => setForm({ ...form, carrier: e.target.value })}
              list="parcel-carrier-options" maxLength={80}
              placeholder="เลือกจากประวัติหรือพิมพ์เอง" style={inp} />
            <datalist id="parcel-carrier-options">
              {parcelOptions.carriers.map((x) => <option key={x} value={x} />)}
            </datalist>
          </div>
        </div>

        <label style={lbl}>เลขพัสดุ</label>
        <input value={form.trackingNo} onChange={(e) => setForm({ ...form, trackingNo: e.target.value })}
          maxLength={120} placeholder="ใส่เพื่อให้ค้นหาย้อนหลังได้ง่าย" style={inp} />

        <label style={lbl}>จุดรับ / ชั้นวาง</label>
        <input value={form.shelfLocation} onChange={(e) => setForm({ ...form, shelfLocation: e.target.value })}
          list="parcel-shelf-options" maxLength={120}
          placeholder="เลือกจากประวัติหรือพิมพ์เอง" style={inp} />
        <datalist id="parcel-shelf-options">
          {parcelOptions.shelfLocations.map((x) => <option key={x} value={x} />)}
        </datalist>

        <label style={lbl}>หมายเหตุ</label>
        <textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })}
          maxLength={500} rows={3} style={{ ...inp, resize: 'vertical' }} />

        <label style={lbl}>รูปพัสดุ (ถ้ามี)</label>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '96px minmax(0, 1fr)',
          gap: 12,
          alignItems: 'center',
        }}>
          <div style={{
            width: 96,
            height: 96,
            borderRadius: 8,
            border: '1px dashed ' + C.borderStrong,
            background: C.surfaceAlt,
            overflow: 'hidden',
            display: 'grid',
            placeItems: 'center',
            color: C.muted,
            fontSize: 12,
            textAlign: 'center',
          }}>
            {photoBusy ? 'กำลังย่อรูป...' : photoPreview ? (
              <img src={photoPreview} alt="รูปพัสดุ" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            ) : 'ไม่มีรูป'}
          </div>
          <div style={{ minWidth: 0 }}>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={busy || photoBusy}
              onChange={choosePhoto}
              style={{ ...inp, padding: 7 }}
            />
            <div style={{ color: photoError ? (C.dangerInk || C.danger) : C.muted, fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
              {photoError || 'รองรับ JPG, PNG, WebP — รูปใหญ่ระบบย่อให้อัตโนมัติ จะเว้นว่างไว้ก็ได้'}
            </div>
            {photoDataUrl ? (
              <button
                type="button"
                onClick={() => { setPhotoDataUrl(''); setPhotoPreview(initialPhotoUrl); setPhotoError(''); }}
                style={{
                  marginTop: 6,
                  border: 0,
                  background: 'transparent',
                  color: C.danger,
                  padding: 0,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 12.5,
                }}
              >
                ล้างรูปที่เลือก
              </button>
            ) : null}
          </div>
        </div>

        {!isUpdate ? (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, color: C.ink2, fontSize: 13 }}>
            <input type="checkbox" checked={form.notify}
              onChange={(e) => setForm({ ...form, notify: e.target.checked })} />
            ส่งแจ้งเตือนถึงผู้เช่าทันทีหลังบันทึก
          </label>
        ) : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <Btn variant="ghost" onClick={onCancel} type="button" disabled={busy}>ยกเลิก</Btn>
          <Btn variant="primary" type="submit" disabled={busy || photoBusy}>
            {busy ? 'กำลังบันทึก...' : photoBusy ? 'กำลังย่อรูป...' : 'บันทึก'}
          </Btn>
        </div>
      </form>
    </Modal>
  );
}

window.PageParcels = PageParcels;
