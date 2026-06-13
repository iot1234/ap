// === admin/page-rooms.jsx =================================================
// จัดการห้องพัก: ตาราง 40 ห้อง, ฟิลเตอร์/ค้นหา, drawer แก้ไขรายห้อง
// ===========================================================================

const { useState, useMemo } = React;

const ROOM_PATCH_KEYS = new Set([
  'id', 'floor', 'no', 'roomNo', 'room_no', 'type', 'roomType', 'room_type',
  'status', 'rent', 'deposit', 'tenant', 'tenantId', 'tenant_id',
  'tenantName', 'tenant_name', 'since', 'contractEnd', 'contract_end',
  'leaseStart', 'lease_start', 'leaseEnd', 'lease_end',
  'water', 'elec', 'waterUnits', 'water_units', 'elecUnits', 'elec_units',
  'wifi', 'photos', 'notes', 'view', 'viewType', 'view_type',
  'ac', 'hasAc', 'has_ac', 'balcony', 'hasBalcony', 'has_balcony',
  'parking', 'hasParking', 'has_parking', 'kitchen', 'hasKitchen', 'has_kitchen',
  'rentOverride', 'rent_override', 'rentOverrideReason', 'rent_override_reason',
  'rentOverrideAt', 'rent_override_at', 'rentOverrideBy', 'rent_override_by',
  'waterMode', 'water_mode', 'waterFlatAmount', 'water_flat_amount',
  'waterRateOverride', 'water_rate_override', 'elecMode', 'elec_mode',
  'elecFlatAmount', 'elec_flat_amount', 'elecRateOverride', 'elec_rate_override',
  'lastCleaned', 'last_cleaned', 'lastBillDate', 'last_bill_date',
  'billStatus', 'bill_status', 'overdueDays', 'overdue_days',
  'createdAt', 'created_at', 'updatedAt', 'updated_at', 'deletedAt', 'deleted_at',
  'source',
]);

function isPlainRoomObject(value) {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isReactEventLike(value) {
  return !!(value && typeof value === 'object' && (
    typeof value.preventDefault === 'function' ||
    typeof value.stopPropagation === 'function' ||
    value.nativeEvent ||
    (value.currentTarget && value.target)
  ));
}

function isDomLike(value) {
  return !!(value && typeof value === 'object' && (
    value.nodeType ||
    value.window === value ||
    (typeof value.addEventListener === 'function' && typeof value.tagName === 'string')
  ));
}

function safeRoomValue(value, seen = new WeakSet()) {
  if (value == null) return value;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return String(value);
  if (t !== 'object') return undefined;
  if (isReactEventLike(value) || isDomLike(value)) return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    const out = [];
    value.forEach((item) => {
      const safe = safeRoomValue(item, seen);
      if (safe !== undefined) out.push(safe);
    });
    return out;
  }

  if (!isPlainRoomObject(value)) return undefined;
  const out = {};
  Object.keys(value).forEach((key) => {
    if (key.startsWith('__react') || key === '_owner' || key === 'stateNode') return;
    const safe = safeRoomValue(value[key], seen);
    if (safe !== undefined) out[key] = safe;
  });
  return out;
}

function safeRoomSnapshot(room) {
  const safe = safeRoomValue(room);
  return isPlainRoomObject(safe) ? safe : {};
}

function safeRoomFingerprint(room) {
  return JSON.stringify(safeRoomSnapshot(room));
}

function sanitizeRoomPatch(patch) {
  if (isReactEventLike(patch) || !isPlainRoomObject(patch)) return null;
  const out = {};
  Object.keys(patch).forEach((key) => {
    if (!ROOM_PATCH_KEYS.has(key)) return;
    const safe = safeRoomValue(patch[key]);
    if (safe !== undefined) out[key] = safe;
  });
  return out;
}

const ROOM_PHOTO_ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ROOM_PHOTO_MAX_COUNT = 12;
const ROOM_PHOTO_MAX_BYTES = 1_500_000;

function normaliseRoomPhotoUrl(value) {
  const url = String(value || '').trim();
  if (!url || url.startsWith('data:')) return null;
  return url.slice(0, 2048);
}

function normaliseRoomPhotos(photos) {
  if (!Array.isArray(photos)) return [];
  const out = [];
  const seen = new Set();
  for (const item of photos) {
    const url = normaliseRoomPhotoUrl(item);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= ROOM_PHOTO_MAX_COUNT) break;
  }
  return out;
}

function formatRoomPhotoFileSize(file) {
  const bytes = Number(file && file.size) || 0;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatRoomPhotoMaxSize() {
  return formatRoomPhotoFileSize({ size: ROOM_PHOTO_MAX_BYTES });
}

function describeRoomPhotoStorage(storageModes) {
  const modes = new Set(Array.from(storageModes || []).filter(Boolean));
  if (modes.has('s3') && modes.size === 1) return 'เก็บบน R2/S3 แล้ว';
  if (modes.has('s3') && modes.has('local')) return 'เก็บบางรูปบน R2/S3 และบางรูปบน local uploads';
  if (modes.has('local')) return 'เก็บบน local uploads แล้ว';
  return 'เก็บใน storage กลางของระบบแล้ว';
}

function roomPhotoUploadErrorMessage(res, body) {
  const code = body && body.code;
  const raw = String((body && body.error) || '');
  if (res && res.status === 413) return `ไฟล์ใหญ่เกินกำหนด (${formatRoomPhotoMaxSize()})`;
  if (code === 'UPLOAD_TOO_LARGE') return `ไฟล์ใหญ่เกินกำหนด (${formatRoomPhotoMaxSize()})`;
  if (code === 'INVALID_UPLOAD_FILE' || /unrecognized file type|mime mismatch|mime not allowed/i.test(raw)) {
    return 'ไฟล์รูปไม่ถูกต้องหรือชนิดไฟล์ไม่รองรับ';
  }
  if ((res && res.status === 404) || code === 'NOT_FOUND') {
    return 'ไม่พบ endpoint อัปโหลดรูป /api/uploads กรุณารีเฟรชหน้าและตรวจว่า backend deploy เวอร์ชันล่าสุดแล้ว';
  }
  return raw || `upload failed (${res ? res.status : 'unknown'})`;
}

function splitRoomPhotoFiles(fileList, availableSlots = ROOM_PHOTO_MAX_COUNT) {
  const picked = Array.from(fileList || []);
  const accepted = [];
  const issues = [];
  let overflow = 0;
  for (const file of picked) {
    const name = file?.name || 'photo';
    if (!file || !file.size) {
      issues.push(`${name}: ไฟล์ว่างหรืออ่านไม่ได้`);
      continue;
    }
    if (file.type && !ROOM_PHOTO_ALLOWED_MIMES.has(file.type)) {
      issues.push(`${name}: รองรับเฉพาะ JPG, PNG หรือ WebP`);
      continue;
    }
    // รูปที่เกินเพดาน 1.5 MB จะถูกย่ออัตโนมัติตอนอัปโหลด (shared.jsx
    // prepareImageForUpload) — ปฏิเสธเฉพาะไฟล์ที่ใหญ่เกินกว่าจะย่อไหว
    if (file.size > 15_000_000) {
      issues.push(`${name}: ขนาด ${formatRoomPhotoFileSize(file)} เกิน 15 MB — ใหญ่เกินกว่าระบบจะย่ออัตโนมัติได้`);
      continue;
    }
    if (accepted.length >= availableSlots) {
      overflow++;
      continue;
    }
    accepted.push(file);
  }
  if (overflow > 0) issues.push(`เก็บรูปได้สูงสุด ${ROOM_PHOTO_MAX_COUNT} รูปต่อห้อง`);
  return { accepted, issues };
}

// อ่าน/ย่อรูปผ่าน helper กลางใน shared.jsx — เลิกถือสำเนา FileReader ของหน้านี้
function readRoomPhotoDataUrl(file) {
  return window.readImageFileAsDataUrl(file);
}

async function uploadRoomPhotoFiles(apiFetch, roomId, files) {
  if (!apiFetch) throw new Error('Admin API is not ready');
  if (!roomId) throw new Error('room id required');
  const selected = Array.from(files || []);
  if (selected.length > ROOM_PHOTO_MAX_COUNT) throw new Error(`upload limit is ${ROOM_PHOTO_MAX_COUNT} photos`);
  const uploaded = [];
  const storageModes = [];
  for (const file of selected) {
    if (!file || !file.size) throw new Error(`${file?.name || 'photo'} is empty`);
    if (file.type && !ROOM_PHOTO_ALLOWED_MIMES.has(file.type)) {
      throw new Error(`${file.name || 'photo'} must be JPG, PNG or WebP`);
    }
    // เกินเพดาน 1.5 MB → ย่ออัตโนมัติให้พอดี แทนการโยน error ใส่ผู้ใช้
    // (รูปจากกล้องมือถือแทบทุกใบใหญ่กว่าเพดาน) ไฟล์เล็กอ่านตรง ๆ ตามเดิม
    const dataUrl = file.size > ROOM_PHOTO_MAX_BYTES
      ? await window.prepareImageForUpload(file)
      : await readRoomPhotoDataUrl(file);
    if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(dataUrl)) {
      throw new Error(`${file.name || 'photo'} could not be read as an image`);
    }
    const res = await apiFetch('/api/uploads', {
      method: 'POST',
      body: JSON.stringify({
        category: 'room_photo',
        refId: roomId,
        dataUrl,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok || !body.file || !body.file.url) {
      const err = new Error(roomPhotoUploadErrorMessage(res, body));
      err.code = body.code || null;
      err.uploaded = uploaded;
      err.storageModes = storageModes;
      throw err;
    }
    uploaded.push(body.file.url);
    storageModes.push(body.file.storage || 'unknown');
  }
  return { urls: uploaded, storageModes };
}

function PageRooms({ rooms, setRooms, config, addActivity, setToast }) {
  const C = window.ADMIN_C;
  const ADMIN_STATUS = window.ADMIN_STATUS;
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES;
  const ADMIN_ROOM_TYPE_KEYS = window.ADMIN_ROOM_TYPE_KEYS;
  const ADMIN_VIEWS = window.ADMIN_VIEWS;
  const { fmt, fmtCurrency, resolveRoomRent, resolveRoomDeposit, computeRoomRent } = window;
  const { Card, Btn, IconBtn, Input, Select, Toggle, Textarea, StatusBadge, Pill, DataTable,
          Drawer, Modal, SearchInput, FilterChip, PageContainer, PageHeader, SectionHeading, DefList } = window;

  const [search, setSearch]       = useState('');
  const [filterStatus, setFStatus] = useState('all');
  const [filterFloor, setFFloor]   = useState('all');
  const [filterType, setFType]     = useState('all');
  const [editId, setEditId]        = useState(null);
  const [editDraft, setEditDraft]  = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [addOpen, setAddOpen]      = useState(false);
  const [bulkAddOpen, setBulkAddOpen] = useState(false);
  const fileInputRef               = React.useRef(null);

  const list = useMemo(() => Object.values(rooms).sort((a, b) => a.id.localeCompare(b.id)), [rooms]);

  // Deep-link "#rooms?room=X" (from search results / cross-page buttons)
  // opens that room's edit drawer directly instead of dropping the admin on
  // the bare table to search again. Param is stripped after applying so
  // closing the drawer doesn't re-open it on the next hashchange.
  React.useEffect(() => {
    const applyRoomRoute = () => {
      const raw = String(window.location.hash || '').replace(/^#/, '');
      const [pathPart, queryPart = ''] = raw.split('?');
      if (pathPart.split('/')[0] !== 'rooms') return;
      let target = '';
      try {
        target = String(new URLSearchParams(queryPart).get('room') || '').trim();
      } catch { /* malformed query — ignore */ }
      if (!target || !rooms[target]) return;
      setEditId(target);
      window.history.replaceState(null, '', '#rooms');
    };
    applyRoomRoute();
    window.addEventListener('hashchange', applyRoomRoute);
    return () => window.removeEventListener('hashchange', applyRoomRoute);
  }, [rooms]);

  // Derive the unique sorted list of floors actually present so the filter
  // dropdown auto-grows when admin adds floor 6, 7, …, N. Previously the
  // list was hardcoded [1,2,3,4,5] which left newly-added floors invisible
  // in the dropdown even though their rooms appeared in the table.
  const allFloors = useMemo(() => {
    const set = new Set();
    for (const r of list) {
      const f = Number(r && r.floor);
      if (Number.isInteger(f) && f >= 1 && f <= 99) set.add(f);
    }
    return Array.from(set).sort((a, b) => a - b);
  }, [list]);

  const filtered = useMemo(() => list.filter(r => {
    if (filterStatus !== 'all' && r.status !== filterStatus) return false;
    if (filterFloor  !== 'all' && r.floor !== Number(filterFloor)) return false;
    if (filterType   !== 'all' && r.type  !== filterType)  return false;
    if (search) {
      const q = search.toLowerCase();
      const hay = `${r.id} ${r.tenant?.name || ''} ${ADMIN_ROOM_TYPES[r.type].th}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }), [list, filterStatus, filterFloor, filterType, search]);

  const counts = useMemo(() => {
    const c = { all: list.length };
    Object.keys(ADMIN_STATUS).forEach(k => { c[k] = list.filter(r => r.status === k).length; });
    return c;
  }, [list]);

  const rejectInvalidRoomPatch = (source, patch) => {
    console.warn(`[rooms] Blocked non-serializable room patch from ${source}`, patch);
    setToast && setToast({
      kind: 'danger',
      message: {
        title: 'อัปเดตห้องไม่สำเร็จ',
        description: 'ระบบได้รับ event/DOM จากปุ่มแทนข้อมูลห้อง จึงยกเลิกเพื่อป้องกันหน้า Rooms ค้างหรือพัง กรุณาลองกดอีกครั้ง',
      },
    });
  };

  const updateRoom = (id, patch, source = 'room update') => {
    const safePatch = sanitizeRoomPatch(patch);
    if (!safePatch) {
      rejectInvalidRoomPatch(source, patch);
      return false;
    }
    if (Object.keys(safePatch).length === 0) return false;
    setRooms(prev => ({
      ...prev,
      [id]: { ...safeRoomSnapshot(prev[id] || {}), ...safePatch },
    }));
    return true;
  };

  const cloneRoom = (room) => (room ? safeRoomSnapshot(room) : null);

  React.useEffect(() => {
    setEditDraft(editId && rooms[editId] ? cloneRoom(rooms[editId]) : null);
    // Reset only when switching rooms/opening the drawer. While editing, the
    // draft must not be overwritten by its own keystrokes or by background
    // localStorage hydration.
  }, [editId]);

  const editing = editId ? rooms[editId] : null;
  const editingRoom = editDraft || editing;
  const editDirty = !!(editing && editDraft
    && safeRoomFingerprint(editDraft) !== safeRoomFingerprint(editing));

  const updateEditDraft = (patch) => {
    const safePatch = sanitizeRoomPatch(patch);
    if (!safePatch) {
      rejectInvalidRoomPatch('room edit draft', patch);
      return false;
    }
    if (Object.keys(safePatch).length === 0) return false;
    setEditDraft(prev => ({ ...safeRoomSnapshot(prev || editing || {}), ...safePatch }));
    return true;
  };

  const applyRoomServerPatch = (patch) => {
    if (!editId) return;
    const safePatch = sanitizeRoomPatch(patch);
    if (!safePatch) {
      rejectInvalidRoomPatch('room server patch', patch);
      return false;
    }
    if (Object.keys(safePatch).length === 0) return false;
    updateRoom(editId, safePatch, 'room server patch');
    setEditDraft(prev => ({ ...safeRoomSnapshot(prev || editing || {}), ...safePatch }));
    return true;
  };

  const closeEditDrawer = () => {
    if (editDirty) {
      const ok = window.confirm('ทิ้งการแก้ไขที่ยังไม่ได้บันทึก?');
      if (!ok) return;
    }
    setEditId(null);
    setEditDraft(null);
  };

  const roomPricingChanged = (before, after) => {
    const keys = ['type', 'view', 'balcony', 'ac', 'parking', 'kitchen', 'rentOverride'];
    return keys.some((k) => String(before?.[k] ?? '') !== String(after?.[k] ?? ''));
  };

  const saveRoomEdit = () => {
    if (!editId || !editing || !editDraft) return;
    const before = editing;
    const after = cloneRoom(editDraft);
    const beforeRent = resolveRoomRent ? resolveRoomRent(before, config) : { rent: before.rent, source: 'legacy' };
    const afterRent = resolveRoomRent ? resolveRoomRent(after, config) : { rent: after.rent, source: 'legacy' };
    const preWarnings = [];
    if (Number(beforeRent.rent) !== Number(afterRent.rent)) {
      preWarnings.push(`ค่าเช่าที่ระบบจะใช้เปลี่ยนจาก ${fmtCurrency(beforeRent.rent)} เป็น ${fmtCurrency(afterRent.rent)}`);
    }
    if (roomPricingChanged(before, after)) {
      preWarnings.push('ประเภท/วิว/คุณสมบัติพิเศษถูกเปลี่ยน และจะมีผลกับสูตรราคาของห้องว่าง สัญญาใหม่ หรือบิลใหม่ที่ยังไม่ lock ราคาเดิม');
    }
    if (afterRent.source === 'override') {
      preWarnings.push('ห้องนี้มีราคาพิเศษรายห้อง ระบบจะไม่ใช้สูตร Pricing จนกว่าจะล้างราคาพิเศษ');
    }
    if (Number(afterRent.rent) > 0 && Number(afterRent.rent) < 100) {
      preWarnings.push('ค่าเช่าต่ำกว่า 100 บาท ผิดปกติสำหรับการออกสัญญา/บิล');
    }
    if (preWarnings.length) {
      const ok = window.confirm(
        `ตรวจสอบก่อนบันทึกห้อง ${editId}\n\n` +
        preWarnings.map((x) => `• ${x}`).join('\n') +
        '\n\nยืนยันบันทึกหรือไม่?'
      );
      if (!ok) return;
    }
    setRooms(prev => ({ ...prev, [editId]: after }));
    addActivity && addActivity({ icon: '✏️', text: `แก้ไขข้อมูลห้อง ${editId}`, type: 'system' });

    const lines = [];
    if (Number(beforeRent.rent) !== Number(afterRent.rent)) {
      lines.push(`ค่าเช่าที่ระบบจะใช้เปลี่ยนจาก ${fmtCurrency(beforeRent.rent)} เป็น ${fmtCurrency(afterRent.rent)}`);
    }
    if (roomPricingChanged(before, after)) {
      lines.push('ประเภท/วิว/คุณสมบัติใช้คำนวณราคาตามสูตรและใช้กับสัญญาใหม่หรือห้องว่าง');
      lines.push('สัญญาที่ lock แล้วและบิลที่ออกไปแล้วจะไม่ถูกแก้ย้อนหลัง');
    }
    if (afterRent.source === 'override') {
      lines.push('ห้องนี้ยังใช้ราคาพิเศษรายห้องอยู่ จึงไม่ตามสูตรจนกว่าจะล้างราคาพิเศษ');
    }
    setToast && setToast({
      kind: 'success',
      message: {
        title: `บันทึกห้อง ${editId} เรียบร้อย`,
        description: lines.join('\n') || 'บันทึกข้อมูลห้องแล้ว',
      },
    });
    setEditId(null);
    setEditDraft(null);
  };

  const handleExportCSV = () => {
    const ok = window.exportRoomsCSV(rooms);
    if (ok) {
      addActivity && addActivity({ icon: '📤', text: `ส่งออกข้อมูลห้องพัก (${list.length} รายการ) เป็น CSV`, type: 'system' });
      setToast && setToast({ kind: 'success', message: `ดาวน์โหลด CSV ${list.length} ห้องเรียบร้อย` });
    }
  };

  const handleImportCSV = () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.csv,text/csv';
    inp.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const text = reader.result.replace(/^﻿/, '');
          // C8 — cap input so a malicious or accidental 100MB CSV can't
          // freeze the browser. Real bulk-import is a few hundred rows.
          if (text.length > 5_000_000) throw new Error('ไฟล์ใหญ่เกิน 5MB');
          const lines = text.split(/\r?\n/).filter(l => l.trim());
          if (lines.length > 5000) throw new Error('แถวเกิน 5,000 — แบ่งไฟล์ก่อนนำเข้า');
          const parseRow = (line) => {
            const out = []; let cur = '', inQ = false;
            for (let i = 0; i < line.length; i++) {
              const ch = line[i];
              if (inQ) {
                if (ch === '"' && line[i+1] === '"') { cur += '"'; i++; }
                else if (ch === '"') inQ = false;
                else cur += ch;
              } else {
                if (ch === '"') inQ = true;
                else if (ch === ',') { out.push(cur); cur = ''; }
                else cur += ch;
              }
            }
            out.push(cur);
            return out;
          };
          const header = parseRow(lines[0]);
          const idIdx = header.findIndex(h => /เลขห้อง|^id$/i.test(h));
          if (idIdx === -1) throw new Error('ไม่พบคอลัมน์ "เลขห้อง" ในไฟล์');
          const rentIdx     = header.findIndex(h => /ค่าเช่า|^rent$/i.test(h));
          const statusIdx   = header.findIndex(h => /^สถานะ$|^status$/i.test(h));
          const notesIdx    = header.findIndex(h => /หมายเหตุ|notes/i.test(h));
          const statusMap = {}; for (const k of Object.keys(window.ADMIN_STATUS)) statusMap[window.ADMIN_STATUS[k].th] = k;
          // DRY-RUN FIRST: parse the file without mutating state, gather a
          // diff (matched rooms, skipped rows, columns being applied), and
          // show a confirm before committing. Without this dry-run, importing
          // a CSV with a bad column header silently overwrites every room's
          // rent/status with NaN/empty — and there's no undo.
          const willUpdate = [];
          const skippedNoMatch = [];
          const skippedNoChange = [];
          const validStatuses = new Set(Object.keys(window.ADMIN_STATUS));
          for (let i = 1; i < lines.length; i++) {
            const row = parseRow(lines[i]);
            const id = row[idIdx]?.trim();
            if (!id) continue;
            if (!rooms[id]) { skippedNoMatch.push(id); continue; }
            const patch = {};
            if (rentIdx > -1 && row[rentIdx])     patch.rent = Number(row[rentIdx]);
            if (statusIdx > -1 && row[statusIdx]) {
              const s = row[statusIdx].trim();
              const mapped = statusMap[s] || s;
              if (validStatuses.has(mapped)) patch.status = mapped;
              // else: ignore — don't let bad CSV poison status values.
            }
            if (notesIdx > -1)                    patch.notes = row[notesIdx] || '';
            // Monthly water/electric usage belongs to /admin#meters by period.
            // Keep room CSV import limited to room attributes/config.
            // Reject NaN values silently — happens when the CSV cell is
            // empty or has trailing characters from a different format.
            if (patch.rent != null && !Number.isFinite(patch.rent)) delete patch.rent;
            if (Object.keys(patch).length === 0) {
              skippedNoChange.push(id);
            } else {
              willUpdate.push({ id, patch });
            }
          }
          // Build a human-readable summary showing first 5 changes so admin
          // can spot wrong-column-mapping issues before committing.
          const sample = willUpdate.slice(0, 5).map((u) => {
            const fields = Object.keys(u.patch).map((k) => `${k}=${u.patch[k]}`).join(', ');
            return `  • ห้อง ${u.id}: ${fields}`;
          }).join('\n');
          const cols = [
            rentIdx > -1 && 'ค่าเช่า',
            statusIdx > -1 && 'สถานะ',
            notesIdx > -1 && 'หมายเหตุ',
          ].filter(Boolean).join(', ');
          if (willUpdate.length === 0) {
            setToast && setToast({
              kind: 'warning',
              message: {
                title: 'ไม่พบข้อมูลที่จะอัปเดต',
                description: skippedNoMatch.length
                  ? `${skippedNoMatch.length} แถวมีเลขห้องที่ไม่ตรงกับห้องในระบบ — ตรวจคอลัมน์ "เลขห้อง" ในไฟล์`
                  : 'ทุกแถวมีค่าเหมือนเดิม หรือไฟล์ไม่มีคอลัมน์ที่จะอัปเดต',
              },
            });
            return;
          }
          const ok = window.confirm(
            `📥 ตรวจสอบก่อนนำเข้า CSV\n\n` +
            `📊 สรุป:\n` +
            `  • จะอัปเดต: ${willUpdate.length} ห้อง\n` +
            `  • ข้าม (ไม่พบเลขห้องในระบบ): ${skippedNoMatch.length} แถว\n` +
            `  • ข้าม (ไม่มีคอลัมน์ที่จะอัปเดต): ${skippedNoChange.length} แถว\n\n` +
            `📋 คอลัมน์ที่จะถูกอัปเดต: ${cols || '(ไม่มี)'}\n\n` +
            `🔍 ตัวอย่าง 5 ห้องแรก:\n${sample}` +
            (willUpdate.length > 5 ? `\n  ... อีก ${willUpdate.length - 5} ห้อง` : '') +
            (skippedNoMatch.length > 0
              ? `\n\n⚠️ ${skippedNoMatch.length} แถวจะถูกข้ามเพราะเลขห้องไม่ตรง:\n${skippedNoMatch.slice(0, 3).join(', ')}` +
                (skippedNoMatch.length > 3 ? `, ...` : '')
              : '') +
            `\n\n📌 ทับค่าเดิมทันที — แนะนำส่งออก backup ก่อน\n\nดำเนินการต่อ?`
          );
          if (!ok) return;
          let count = 0;
          setRooms(prev => {
            const next = { ...prev };
            for (const { id, patch } of willUpdate) {
              next[id] = { ...next[id], ...patch };
              count++;
            }
            return next;
          });
          setToast && setToast({
            kind: 'success',
            message: skippedNoMatch.length || skippedNoChange.length
              ? `อัปเดต ${count} ห้อง · ข้าม ${skippedNoMatch.length + skippedNoChange.length} แถว`
              : `อัปเดต ${count} ห้องเรียบร้อย`,
          });
          addActivity && addActivity({ icon: '📥', text: `นำเข้า CSV ห้องพัก ${count} รายการ`, type: 'system' });
        } catch (err) {
          setToast && setToast({ kind: 'danger', message: 'นำเข้า CSV ไม่สำเร็จ: ' + err.message });
        }
      };
      reader.readAsText(file, 'utf-8');
    };
    inp.click();
  };

  const handleAddRoom = (data) => {
    if (rooms[data.id]) {
      setToast && setToast({ kind: 'danger', message: `เลขห้อง ${data.id} มีอยู่แล้ว` });
      return false;
    }
    const t = ADMIN_ROOM_TYPES[data.type];
    const features = { ac: !!data.ac, balcony: !!data.balcony, parking: !!data.parking, kitchen: !!data.kitchen };
    const formulaRent = computeRoomRent
      ? computeRoomRent(data.type, Number(data.floor), data.view, features, config)
      : Number(data.rent);
    // priceMode 'formula' (default) pins the room to the central pricing —
    // the typed rent is ignored entirely so a stale form value can never
    // become an accidental override. Only the explicit 'custom' mode (which
    // required a reason in the modal) records a per-room override.
    const usingFormula = data.priceMode !== 'custom';
    const rent = usingFormula
      ? (formulaRent || t.baseRent)
      : (Number(data.rent) || formulaRent || t.baseRent);
    const depositInfo = resolveRoomDeposit
      ? resolveRoomDeposit({ type: data.type }, config, rent)
      : { deposit: rent * 2 };
    const deposit = Number(depositInfo.deposit);
    const rentIsOverride = !usingFormula && Math.abs(Number(rent) - Number(formulaRent || 0)) >= 0.01;
    const newRoom = {
      id: data.id, floor: Number(data.floor), no: Number(data.no || 1),
      type: data.type, status: 'vacant',
      rent, deposit: Number.isFinite(deposit) && deposit >= 0 ? deposit : rent * 2,
      tenant: null, since: null, contractEnd: null,
      water: 0, elec: 0, waterUnits: 0, elecUnits: 0, wifi: config.utilities.wifi || 250,
      photos: normaliseRoomPhotos(data.photos), notes: '',
      view: data.view, ac: !!data.ac,
      balcony: !!data.balcony, parking: !!data.parking, kitchen: !!data.kitchen,
      rentOverride: rentIsOverride ? rent : null,
      rentOverrideReason: rentIsOverride
        ? (String(data.overrideReason || '').trim() || 'ราคาพิเศษตอนสร้างห้อง') : null,
      rentOverrideAt: rentIsOverride ? new Date().toISOString() : null,
      rentOverrideBy: rentIsOverride ? 'admin-ui' : null,
      lastCleaned: window.fmtDateTH(new Date()),
      lastBillDate: null, billStatus: 'none', overdueDays: 0,
    };
    setRooms(prev => ({ ...prev, [data.id]: newRoom }));
    addActivity && addActivity({ icon: '➕', text: `เพิ่มห้องใหม่ ${data.id} (${t.th})`, type: 'system' });
    setToast && setToast({ kind: 'success', message: `เพิ่มห้อง ${data.id} เรียบร้อย` });
    setAddOpen(false);
    return true;
  };

  // Bulk-add a whole floor in one action (e.g., "ชั้น 6 มี 12 ห้อง"). Faster
  // than clicking "เพิ่มห้อง" 12 times. Skips IDs that already exist so it's
  // safe to re-run if the admin gets interrupted halfway.
  const handleBulkAddFloor = (data) => {
    const f = Number(data.floor);
    const start = Number(data.startNo) || 1;
    const count = Number(data.count) || 0;
    if (!Number.isInteger(f) || f < 1 || f > 99) {
      setToast && setToast({ kind: 'danger', message: 'เลขชั้นต้องอยู่ระหว่าง 1-99' });
      return false;
    }
    if (count < 1 || count > 99) {
      setToast && setToast({ kind: 'danger', message: 'จำนวนห้องต้องอยู่ระหว่าง 1-99' });
      return false;
    }
    if (start + count - 1 > 99) {
      setToast && setToast({ kind: 'danger', message: 'เลขห้องสุดท้ายเกิน 99 — ลดจำนวนลง' });
      return false;
    }
    const t = ADMIN_ROOM_TYPES[data.type] || ADMIN_ROOM_TYPES.standard;
    const features = { ac: !!data.ac, balcony: !!data.balcony, parking: !!data.parking, kitchen: !!data.kitchen };
    const formulaRent = computeRoomRent
      ? computeRoomRent(data.type, f, data.view, features, config)
      : Number(data.rent);
    // Same contract as handleAddRoom: formula mode ignores the typed rent
    // so every bulk-created room follows central pricing automatically.
    const usingFormula = data.priceMode !== 'custom';
    const rent = usingFormula
      ? (formulaRent || t.baseRent)
      : (Number(data.rent) || formulaRent || t.baseRent);
    const depositInfo = resolveRoomDeposit
      ? resolveRoomDeposit({ type: data.type }, config, rent)
      : { deposit: rent * 2 };
    const deposit = Number(depositInfo.deposit);
    const rentIsOverride = !usingFormula && Math.abs(Number(rent) - Number(formulaRent || 0)) >= 0.01;
    let added = 0, skipped = 0;
    setRooms(prev => {
      const next = { ...prev };
      for (let n = start; n < start + count; n++) {
        const id = `${f}${String(n).padStart(2, '0')}`;
        if (next[id]) { skipped++; continue; }
        next[id] = {
          id, floor: f, no: n, type: data.type, status: 'vacant',
          rent,
          deposit: Number.isFinite(deposit) && deposit >= 0 ? deposit : rent * 2,
          tenant: null, since: null, contractEnd: null,
          water: 0, elec: 0, waterUnits: 0, elecUnits: 0,
          wifi: config.utilities.wifi || 250,
          photos: [], notes: '',
          view: data.view || 'วิวสวน',
          ac: !!data.ac,
          balcony: !!data.balcony, parking: !!data.parking, kitchen: !!data.kitchen,
          rentOverride: rentIsOverride ? rent : null,
          rentOverrideReason: rentIsOverride
            ? (String(data.overrideReason || '').trim() || 'ราคาพิเศษตอนสร้างทั้งชั้น') : null,
          rentOverrideAt: rentIsOverride ? new Date().toISOString() : null,
          rentOverrideBy: rentIsOverride ? 'admin-ui' : null,
          lastCleaned: window.fmtDateTH(new Date()),
          lastBillDate: null, billStatus: 'none', overdueDays: 0,
        };
        added++;
      }
      return next;
    });
    addActivity && addActivity({
      icon: '🏗️',
      text: `เพิ่มชั้น ${f} จำนวน ${added} ห้อง (${t.th})${skipped ? ` — ข้าม ${skipped} ที่มีอยู่แล้ว` : ''}`,
      type: 'system',
    });
    setToast && setToast({
      kind: added > 0 ? 'success' : 'warning',
      message: added > 0
        ? `เพิ่มห้อง ${added} ห้องในชั้น ${f}${skipped ? ` (ข้าม ${skipped})` : ''}`
        : 'ไม่ได้เพิ่ม — ทุกห้องในช่วงนี้มีอยู่แล้ว',
    });
    return added > 0;
  };

  const handleDelete = () => {
    if (!confirmDelete) return;
    const id = confirmDelete;
    const room = rooms[id];
    // Pre-check: block delete if the room is occupied/reserved/overdue OR
    // has a tenant attached. Without this guard, admin can wipe a room
    // that's actively rented — leaving the tenant's contracts/bills/maint
    // tickets orphaned (FK references a room id that no longer exists in
    // the rooms blob, even though the relational tables still think the
    // room exists by id-string).
    if (room && (room.tenant || (room.status && room.status !== 'vacant' && room.status !== 'maintenance'))) {
      const reason = room.tenant
        ? `มีผู้เช่า "${room.tenant.name}" อยู่`
        : `สถานะ "${room.status}" ไม่ใช่ห้องว่าง`;
      setToast && setToast({
        kind: 'danger',
        message: {
          title: `ลบห้อง ${id} ไม่ได้`,
          description: `${reason} — ย้ายผู้เช่าออกหรือเปลี่ยนสถานะเป็น "ว่าง"/"ปรับปรุง" ก่อน`,
          action: {
            label: 'แก้ไขห้องนี้ →',
            onClick: () => { setConfirmDelete(null); setEditId(id); },
          },
        },
      });
      return;
    }
    setRooms(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    addActivity && addActivity({ icon: '🗑️', text: `ลบห้อง ${id}`, type: 'system' });
    setToast && setToast({ kind: 'success', message: `ลบห้อง ${id} แล้ว` });
    setConfirmDelete(null);
    if (editId === id) setEditId(null);
  };

  // --- Table columns -----
  const columns = [
    {
      key: 'id', label: 'ห้อง', minWidth: 80,
      render: r => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 9,
            background: ADMIN_ROOM_TYPES[r.type].accent + '18',
            color: ADMIN_ROOM_TYPES[r.type].accent,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'IBM Plex Sans Thai, sans-serif', fontWeight: 700, fontSize: 13,
            flexShrink: 0,
          }}>{r.id}</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink }}>ชั้น {r.floor}</div>
            <div style={{ fontSize: 11, color: C.muted }}>{ADMIN_ROOM_TYPES[r.type].th}</div>
          </div>
        </div>
      ),
    },
    { key: 'status',  label: 'สถานะ', minWidth: 110, render: r => <StatusBadge status={r.status} /> },
    {
      key: 'tenant',  label: 'ผู้เช่า', minWidth: 180,
      render: r => r.tenant ? (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, color: C.ink, fontWeight: 500 }}>{r.tenant.name}</div>
          <div style={{ fontSize: 11.5, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.tenant.occupation}
          </div>
        </div>
      ) : <span style={{ color: C.muted }}>—</span>,
    },
    {
      key: 'rent',    label: 'ค่าเช่า',  align: 'right', minWidth: 100,
      render: r => {
        const info = resolveRoomRent ? resolveRoomRent(r, config) : { rent: r.rent };
        return <span style={{ fontWeight: 600, fontFamily: 'IBM Plex Sans Thai, sans-serif' }}>{fmtCurrency(info.rent)}</span>;
      },
    },
    {
      key: 'utilities', label: 'หน่วยล่าสุด', align: 'right', minWidth: 110,
      render: r => (
        <div style={{ fontSize: 11.5 }}>
          <div style={{ color: C.ink2 }}>💧 {r.waterUnits} หน่วย</div>
          <div style={{ color: C.ink2 }}>⚡ {r.elecUnits} หน่วย</div>
        </div>
      ),
    },
    {
      key: 'contract', label: 'สัญญา', minWidth: 120,
      render: r => r.contractEnd
        ? <div style={{ fontSize: 12, color: C.ink2 }}>หมด {r.contractEnd}</div>
        : <span style={{ color: C.muted, fontSize: 12 }}>—</span>,
    },
    {
      key: 'actions', label: '', align: 'right', minWidth: 80,
      render: r => (
        <div style={{ display: 'inline-flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
          <IconBtn icon="✎" label="แก้ไข" onClick={() => setEditId(r.id)} />
          <IconBtn icon="🗑" label="ลบ" danger onClick={() => setConfirmDelete(r.id)} />
        </div>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        title="จัดการห้องพัก"
        subtitle={`ทั้งหมด ${list.length} ห้อง · แสดง ${filtered.length} รายการ`}
        actions={
          <>
            <Btn variant="secondary" icon="📥" onClick={handleImportCSV}>นำเข้า CSV</Btn>
            <Btn variant="secondary" icon="📤" onClick={handleExportCSV}>ส่งออก CSV</Btn>
            <Btn variant="secondary" icon="🏗️" onClick={() => setBulkAddOpen(true)}>เพิ่มชั้นใหม่</Btn>
            <Btn variant="primary" icon="+" onClick={() => setAddOpen(true)}>เพิ่มห้อง</Btn>
          </>
        }
      />

      {/* Filters row */}
      <Card style={{ marginBottom: 16, padding: 16 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <SearchInput value={search} onChange={setSearch} placeholder="ค้นหาเลขห้อง / ผู้เช่า..." />
          <div style={{ width: 1, height: 28, background: C.border, margin: '0 4px' }} />
          <FilterChip label="ทั้งหมด" active={filterStatus === 'all'} onClick={() => setFStatus('all')} count={counts.all} />
          {Object.keys(ADMIN_STATUS).map(k => (
            <FilterChip
              key={k}
              label={ADMIN_STATUS[k].th}
              active={filterStatus === k}
              onClick={() => setFStatus(k)}
              count={counts[k]}
              color={ADMIN_STATUS[k].dot}
            />
          ))}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Select
              value={filterFloor}
              onChange={setFFloor}
              fullWidth={false}
              options={[
                { value: 'all', label: 'ทุกชั้น' },
                ...allFloors.map(f => ({ value: String(f), label: `ชั้น ${f}` })),
              ]}
              style={{ width: 130 }}
            />
            <Select
              value={filterType}
              onChange={setFType}
              fullWidth={false}
              options={[
                { value: 'all', label: 'ทุกประเภท' },
                ...ADMIN_ROOM_TYPE_KEYS.map(k => ({ value: k, label: ADMIN_ROOM_TYPES[k].th })),
              ]}
              style={{ width: 160 }}
            />
          </div>
        </div>
      </Card>

      {/* Table */}
      <DataTable
        columns={columns}
        rows={filtered}
        onRowClick={(r) => setEditId(r.id)}
        empty="ไม่พบห้องที่ตรงกับเงื่อนไข"
      />

      {/* Edit Drawer */}
      <Drawer
        open={!!editingRoom}
        onClose={closeEditDrawer}
        title={editingRoom ? `ห้อง ${editingRoom.id} · ${ADMIN_ROOM_TYPES[editingRoom.type].th}` : ''}
        width={580}
        footer={editingRoom && (
          <>
            <Btn variant="ghost" onClick={closeEditDrawer}>ยกเลิก</Btn>
            <Btn variant="primary" icon="✓" onClick={saveRoomEdit} disabled={!editDirty}>
              {editDirty ? 'บันทึกการเปลี่ยนแปลง' : 'บันทึกแล้ว'}
            </Btn>
          </>
        )}
      >
        {editingRoom && <RoomEditForm
          room={editingRoom}
          originalRoom={editing}
          onUpdate={updateEditDraft}
          onServerPatch={applyRoomServerPatch}
          config={config}
          setToast={setToast}
        />}
      </Drawer>

      {/* Delete confirm — preview the actual room state so admin doesn't
          delete blind. Block button when the pre-check (tenant/non-vacant)
          would reject anyway, surfacing the reason inline + linking to the
          room editor for the right next step. */}
      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="ยืนยันการลบห้อง"
        footer={(() => {
          const r = confirmDelete ? rooms[confirmDelete] : null;
          const blocked = !!(r && (r.tenant || (r.status && r.status !== 'vacant' && r.status !== 'maintenance')));
          return (
            <>
              <Btn variant="ghost" onClick={() => setConfirmDelete(null)}>ยกเลิก</Btn>
              {blocked ? (
                <Btn variant="primary" onClick={() => { const id = confirmDelete; setConfirmDelete(null); setEditId(id); }}>
                  ไปแก้ไขห้องนี้
                </Btn>
              ) : (
                <Btn variant="danger" onClick={handleDelete}>ลบห้อง</Btn>
              )}
            </>
          );
        })()}
      >
        {(() => {
          const r = confirmDelete ? rooms[confirmDelete] : null;
          if (!r) {
            return (
              <div style={{ fontSize: 14, color: C.ink2 }}>
                ห้อง <b style={{ color: C.ink }}>{confirmDelete}</b> ไม่พบในข้อมูล (อาจถูกลบไปแล้ว)
              </div>
            );
          }
          const blocked = !!r.tenant || (r.status && r.status !== 'vacant' && r.status !== 'maintenance');
          return (
            <div style={{ fontSize: 14, color: C.ink2, lineHeight: 1.7 }}>
              <div style={{ marginBottom: 12 }}>
                จะลบห้อง <b style={{ color: C.ink }}>{confirmDelete}</b> · ชั้น {r.floor} · {ADMIN_ROOM_TYPES[r.type]?.th || r.type}
              </div>

              {blocked ? (
                <div style={{
                  background: C.dangerSoft || C.dangerSoft,
                  border: `1px solid ${C.danger || C.danger}33`,
                  borderRadius: 8, padding: 14,
                  color: C.dangerInk || C.dangerInk,
                }}>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>🛑 ลบไม่ได้</div>
                  <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                    {r.tenant ? (
                      <>มีผู้เช่า <b>"{r.tenant.name}"</b>{r.tenant.phone ? ` (${r.tenant.phone})` : ''} อยู่ในห้องนี้</>
                    ) : (
                      <>สถานะปัจจุบันคือ <b>"{ADMIN_STATUS[r.status]?.th || r.status}"</b> — ไม่ใช่ห้องว่าง</>
                    )}
                    <div style={{ marginTop: 8 }}>
                      💡 ขั้นตอนที่ถูกต้อง:<br/>
                      1) เปิดห้องนี้ → ย้ายผู้เช่าออก (ถ้ามี)<br/>
                      2) เปลี่ยนสถานะเป็น "ว่าง" หรือ "ปรับปรุง"<br/>
                      3) กลับมากดลบใหม่
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{
                  background: C.warningSoft || C.warningSoft,
                  border: `1px solid ${C.warning || C.warning}44`,
                  borderRadius: 8, padding: 14,
                  color: C.warningInk || C.warningInk,
                }}>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>⚠ การลบห้องเป็นการเปลี่ยนแปลงถาวร</div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>
                    บิลและสัญญาเก่าใน DB ที่อ้างถึงห้อง <code>{confirmDelete}</code> จะ<b>ยังอยู่</b> (ไม่ถูกลบตาม) — เก็บไว้สำหรับ audit
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </Modal>

      <AddRoomModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdd={handleAddRoom}
        config={config}
        existingIds={Object.keys(rooms)}
        setToast={setToast}
      />

      <BulkAddFloorModal
        open={bulkAddOpen}
        onClose={() => setBulkAddOpen(false)}
        onAdd={(data) => { if (handleBulkAddFloor(data)) setBulkAddOpen(false); }}
        config={config}
        existingFloors={allFloors}
        setToast={setToast}
      />
    </PageContainer>
  );
}

// --- BulkAddFloorModal ---------------------------------------------------
// "Add a whole floor in one click" — common when a building has 8-16 rooms
// per floor and admin would otherwise click "เพิ่มห้อง" per room. Generates
// `count` rooms in floor `floor` starting at `startNo`, all with the same
// type/rent/view. Idempotent — re-running skips IDs that already exist.
function BulkAddFloorModal({ open, onClose, onAdd, existingFloors, config, setToast }) {
  const C = window.ADMIN_C;
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES;
  const ADMIN_ROOM_TYPE_KEYS = window.ADMIN_ROOM_TYPE_KEYS;
  const ADMIN_VIEWS = window.ADMIN_VIEWS;
  const { Modal, Btn, Input, Select, Toggle } = window;
  const { fmtCurrency, computeRoomRent } = window;
  const notify = setToast || window.toast;

  // Default the new floor to "next floor up from the highest existing one".
  // Same UX shortcut as AddRoomModal for the per-room flow — the operator
  // expects "I'm building floor 6 next" without having to compute it.
  const defaultFloor = (existingFloors && existingFloors.length)
    ? Math.min(99, existingFloors[existingFloors.length - 1] + 1)
    : 1;
  const defaultBulkView = 'วิวสวน';
  const defaultBulkFeatures = { ac: ADMIN_ROOM_TYPES.standard.ac, balcony: false, parking: false, kitchen: false };
  const defaultBulkRent = computeRoomRent
    ? computeRoomRent('standard', defaultFloor, defaultBulkView, defaultBulkFeatures, config)
    : ADMIN_ROOM_TYPES.standard.baseRent;

  const [form, setForm] = React.useState({
    floor: defaultFloor,
    startNo: 1,
    count: 8,
    type: 'standard',
    rent: defaultBulkRent,
    view: defaultBulkView,
    ac: ADMIN_ROOM_TYPES.standard.ac,
    balcony: false, parking: false, kitchen: false,
  });
  const [manualRent, setManualRent] = React.useState(false);
  const [overrideReason, setOverrideReason] = React.useState('');
  React.useEffect(() => {
    if (open) {
      setForm({
        floor: defaultFloor,
        startNo: 1,
        count: 8,
        type: 'standard',
        rent: defaultBulkRent,
        view: defaultBulkView,
        ac: ADMIN_ROOM_TYPES.standard.ac,
        balcony: false, parking: false, kitchen: false,
      });
      setManualRent(false);
      setOverrideReason('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const update = (k, v) => {
    setForm(p => {
      const next = { ...p, [k]: v };
      if (k === 'type') {
        next.ac = ADMIN_ROOM_TYPES[v].ac;
      }
      if (computeRoomRent && k !== 'rent' && !manualRent) {
        const feats = { ac: !!next.ac, balcony: !!next.balcony, parking: !!next.parking, kitchen: !!next.kitchen };
        next.rent = computeRoomRent(next.type, Number(next.floor), next.view, feats, config);
      }
      return next;
    });
  };

  const floorExists = existingFloors && existingFloors.includes(Number(form.floor));
  const lastNo = Number(form.startNo) + Number(form.count) - 1;
  const lastId = `${form.floor}${String(lastNo).padStart(2, '0')}`;
  const firstId = `${form.floor}${String(form.startNo).padStart(2, '0')}`;
  const tooMany = lastNo > 99;
  const bulkFeatures = { ac: !!form.ac, balcony: !!form.balcony, parking: !!form.parking, kitchen: !!form.kitchen };
  const formulaRent = computeRoomRent
    ? computeRoomRent(form.type, Number(form.floor), form.view, bulkFeatures, config)
    : Number(form.rent || 0);
  const rentDiffersFromFormula = Math.abs(Number(form.rent || 0) - Number(formulaRent || 0)) >= 0.01;
  const featurePremium = config?.featurePremium || {};
  const featureRows = [
    { key: 'ac', label: 'แอร์', premium: Number(featurePremium.ac || 0) },
    { key: 'balcony', label: 'มีระเบียง', premium: Number(featurePremium.balcony || 0) },
    { key: 'parking', label: 'ที่จอดรถ', premium: Number(featurePremium.parking || 0) },
    { key: 'kitchen', label: 'ครัวในห้อง', premium: Number(featurePremium.kitchen || 0) },
  ];
  const bulkIssues = [];
  if (!Number.isFinite(Number(form.rent))) bulkIssues.push('ค่าเช่าต้องเป็นตัวเลข');
  else if (Number(form.rent) > 0 && Number(form.rent) < 100) bulkIssues.push('ค่าเช่าต่ำกว่า 100 บาท ผิดปกติสำหรับการออกสัญญา/บิล');
  if (manualRent && rentDiffersFromFormula && String(overrideReason).trim().length < 5) {
    bulkIssues.push('ต้องระบุเหตุผลราคาพิเศษอย่างน้อย 5 ตัวอักษร (เช่น โปรโมชั่นเปิดชั้นใหม่)');
  }
  if (tooMany) bulkIssues.push(`เลขห้องสุดท้ายเกิน 99 (${lastNo})`);
  const submit = () => {
    if (bulkIssues.length) {
      notify && notify({
        kind: 'danger',
        message: { title: 'ยังเพิ่มชั้นไม่ได้', description: bulkIssues.join('\n') },
      });
      return;
    }
    if ((manualRent && rentDiffersFromFormula) || floorExists) {
      const ok = window.confirm(
        `ตรวจสอบก่อนเพิ่มชั้น ${form.floor}\n\n` +
        `ช่วงห้อง: ${firstId} ถึง ${lastId}\n` +
        `ราคาตามสูตรกลาง: ${fmtCurrency(formulaRent)}\n` +
        `ราคาที่จะบันทึก: ${fmtCurrency(manualRent ? form.rent : formulaRent)}\n\n` +
        (manualRent && rentDiffersFromFormula
          ? `ทุกห้องที่สร้างจะใช้ราคาพิเศษ (เหตุผล: ${String(overrideReason).trim()}) และไม่ตามสูตรกลางจนกว่าจะล้าง\n`
          : '') +
        (floorExists
          ? 'ชั้นนี้มีห้องอยู่แล้ว ห้องที่เลขซ้ำจะถูกข้าม\n'
          : '') +
        '\nยืนยันเพิ่มห้องหรือไม่?'
      );
      if (!ok) return;
    }
    onAdd({
      ...form,
      priceMode: manualRent ? 'custom' : 'formula',
      overrideReason: manualRent ? String(overrideReason).trim() : null,
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="เพิ่มชั้นใหม่ (Bulk)"
      width={520}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose}>ยกเลิก</Btn>
          <Btn variant="primary" disabled={!!bulkIssues.length || !form.count} onClick={submit}>
            เพิ่ม {form.count} ห้อง
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{
          padding: 12, background: floorExists ? (C.warningSoft || C.warningSoft) : (C.surfaceAlt || C.surfaceAlt),
          borderRadius: 8, fontSize: 13, color: C.ink2, lineHeight: 1.6,
        }}>
          {floorExists ? (
            <>⚠️ <b>ชั้น {form.floor} มีอยู่แล้ว</b> — ห้องที่ id ซ้ำจะถูกข้าม จะเพิ่มเฉพาะที่ยังไม่มี</>
          ) : (
            <>จะสร้างห้อง <code style={{ background: 'rgba(0,0,0,0.05)', padding: '1px 5px', borderRadius: 3 }}>{firstId}</code> ถึง <code style={{ background: 'rgba(0,0,0,0.05)', padding: '1px 5px', borderRadius: 3 }}>{lastId}</code> ({form.count} ห้อง) ใน <b>ชั้น {form.floor}</b></>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <Input label="ชั้น" type="number" value={form.floor}
                 onChange={(v) => update('floor', Math.max(1, Math.min(99, Number(v) || 1)))} />
          <Input label="เริ่มห้องที่" type="number" value={form.startNo}
                 onChange={(v) => update('startNo', Math.max(1, Math.min(99, Number(v) || 1)))} />
          <Input label="จำนวน" type="number" value={form.count}
                 onChange={(v) => update('count', Math.max(1, Math.min(99, Number(v) || 1)))}
                 error={tooMany ? `ห้องสุดท้ายเกิน ${lastNo}>99` : null} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Select label="ประเภทห้อง (ทุกห้อง)" value={form.type}
                  onChange={(v) => update('type', v)}
                  options={ADMIN_ROOM_TYPE_KEYS.map(k => ({ value: k, label: ADMIN_ROOM_TYPES[k].th }))} />
          <Select label="วิว (ทุกห้อง)" value={form.view}
                  onChange={(v) => update('view', v)}
                  options={ADMIN_VIEWS} />
        </div>

        <div style={{ padding: 12, background: C.surfaceAlt, borderRadius: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ink }}>ค่าเช่า/เดือน (ทุกห้อง)</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <Btn size="sm" variant={!manualRent ? 'primary' : 'ghost'}
                   onClick={() => { setManualRent(false); setOverrideReason(''); update('rent', formulaRent); }}>
                ตามสูตรกลาง (แนะนำ)
              </Btn>
              <Btn size="sm" variant={manualRent ? 'primary' : 'ghost'}
                   onClick={() => setManualRent(true)}>
                กำหนดราคาพิเศษ
              </Btn>
            </div>
          </div>
          {!manualRent ? (
            <>
              <div style={{ fontSize: 22, fontWeight: 800, color: C.ink }}>
                {fmtCurrency(formulaRent)} <span style={{ fontSize: 12, fontWeight: 400, color: C.muted }}>/เดือน/ห้อง</span>
              </div>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 6 }}>
                ทุกห้องที่สร้างจะผูกกับเมนู "ตั้งราคา" — แก้ราคากลางเมื่อไหร่ ห้องอัปเดตตามอัตโนมัติ
              </div>
            </>
          ) : (
            <>
              <Input label="ราคาพิเศษ (ทุกห้องที่สร้าง)" type="number" suffix="บาท"
                     value={form.rent}
                     onChange={(v) => update('rent', Number(v))}
                     error={bulkIssues.find((x) => x.includes('ค่าเช่า')) || null}
                     hint={`ราคาตามสูตรกลาง: ${fmtCurrency(formulaRent)}`} />
              <Input label="เหตุผลราคาพิเศษ (จำเป็น)"
                     value={overrideReason}
                     onChange={setOverrideReason}
                     placeholder="เช่น โปรโมชั่นเปิดชั้นใหม่"
                     error={bulkIssues.find((x) => x.includes('เหตุผลราคาพิเศษ')) || null} />
              <div style={{ fontSize: 11.5, color: C.warningInk || C.warning, marginTop: 4, lineHeight: 1.5 }}>
                ⚠️ ทุกห้องที่สร้างจะ "ไม่ตามสูตรกลาง" จนกว่าจะล้างราคาพิเศษ (ดู/ล้างได้ที่เมนูตั้งราคา)
              </div>
            </>
          )}
        </div>

        <div style={{ padding: 12, background: C.surfaceAlt, borderRadius: 8 }}>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>
            คุณสมบัติพิเศษ (ติดทุกห้องที่สร้าง — แก้ทีหลังรายห้องได้)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
            {featureRows.map((item) => {
              const isOn = !!bulkFeatures[item.key];
              const nextFeatures = { ...bulkFeatures, [item.key]: !isOn };
              const nextRent = computeRoomRent
                ? computeRoomRent(form.type, Number(form.floor), form.view, nextFeatures, config)
                : formulaRent;
              const diff = Number(nextRent || 0) - Number(formulaRent || 0);
              const diffLabel = diff === 0
                ? 'ราคาไม่เปลี่ยน'
                : `${diff > 0 ? '+' : ''}${fmtCurrency(diff)}`;
              return (
                <button
                  type="button"
                  key={item.key}
                  onClick={() => update(item.key, !isOn)}
                  aria-pressed={isOn}
                  title={`${item.label} · Premium +${fmtCurrency(item.premium)} · กดแล้ว ${diffLabel}`}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'stretch',
                    gap: 4, padding: '10px 12px',
                    background: isOn ? (C.successSoft || '#e3f3e8') : C.surface,
                    border: `1.5px solid ${isOn ? (C.success || '#4a8b4a') : C.border}`,
                    color: isOn ? (C.successInk || '#1d4a2c') : C.ink,
                    borderRadius: 8, cursor: 'pointer', textAlign: 'left',
                    fontFamily: 'inherit', minWidth: 0,
                    transition: 'background .15s, border-color .15s',
                  }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600 }}>{item.label}</span>
                    <span style={{
                      fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                      background: isOn ? (C.success || '#4a8b4a') : (C.borderStrong || '#999'),
                      color: '#fff', flexShrink: 0,
                    }}>{isOn ? 'เปิด' : 'ปิด'}</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.4 }}>
                    Premium +{fmtCurrency(item.premium)} · กดแล้ว {diffLabel}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// --- Tenant section (in edit drawer) -----------------------------------
function TenantSection({ room }) {
  const C = window.ADMIN_C;
  const { SectionHeading, Btn, DefList } = window;

  const hasTenant = !!room.tenant;

  const startNew = () => {
    window.location.hash = `#tenants?add=1&room=${encodeURIComponent(room.id)}`;
  };

  const manageTenant = () => {
    window.location.hash = `#tenants?room=${encodeURIComponent(room.id)}&tab=profile`;
  };

  if (!hasTenant) {
    return (
      <div>
        <SectionHeading title="ข้อมูลผู้เช่า" level={3} style={{ marginBottom: 10 }} />
        <div style={{
          padding: 16, background: C.surfaceAlt, borderRadius: 10,
          border: `1px dashed ${C.borderStrong}`, textAlign: 'center',
        }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>👤</div>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>ห้องนี้ยังไม่มีผู้เช่า</div>
          <Btn variant="primary" size="sm" icon="+" onClick={startNew}>เพิ่มผ่านหน้าผู้เช่า</Btn>
        </div>
      </div>
    );
  }

  return (
    <div>
      <SectionHeading
        title="ข้อมูลผู้เช่า"
        level={3}
        style={{ marginBottom: 10 }}
        action={
          <div style={{ display: 'flex', gap: 6 }}>
            <Btn variant="primary" size="sm" onClick={manageTenant}>
              จัดการที่หน้าผู้เช่า
            </Btn>
          </div>
        }
      />
      <DefList
        columns={2}
        items={[
          { label: 'ชื่อ',                value: room.tenant.name, bold: true },
          { label: 'อาชีพ',              value: room.tenant.occupation },
          { label: 'เบอร์โทร',          value: room.tenant.phone },
          { label: 'อีเมล',               value: room.tenant.email },
          { label: 'เข้าพักเมื่อ',     value: room.since },
          { label: 'สัญญาสิ้นสุด',  value: room.contractEnd },
        ]}
      />
    </div>
  );
}

// --- Add room modal ------------------------------------------------------
function AddRoomModal({ open, onClose, onAdd, existingIds, config, setToast }) {
  const C = window.ADMIN_C;
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES;
  const ADMIN_ROOM_TYPE_KEYS = window.ADMIN_ROOM_TYPE_KEYS;
  const ADMIN_VIEWS = window.ADMIN_VIEWS;
  const { Modal, Btn, Input, Select, Toggle } = window;
  const { fmtCurrency, computeRoomRent } = window;
  const apiFetch = window.requireApiFetch ? window.requireApiFetch() : window.apiFetch;
  const notify = setToast || window.toast;
  const defaultAddView = 'วิวสวน';
  const defaultAddFeatures = { ac: ADMIN_ROOM_TYPES.standard.ac, balcony: false, parking: false, kitchen: false };
  const defaultAddRent = computeRoomRent
    ? computeRoomRent('standard', 1, defaultAddView, defaultAddFeatures, config)
    : ADMIN_ROOM_TYPES.standard.baseRent;

  const [form, setForm] = React.useState({
    id: '', floor: 1, no: 1, type: 'standard',
    rent: defaultAddRent, view: defaultAddView,
    ac: ADMIN_ROOM_TYPES.standard.ac,
    balcony: false, parking: false, kitchen: false,
  });
  const [manualRent, setManualRent] = React.useState(false);
  const [overrideReason, setOverrideReason] = React.useState('');
  const [photoFiles, setPhotoFiles] = React.useState([]);
  const [uploadingPhotos, setUploadingPhotos] = React.useState(false);
  const addPhotoInputRef = React.useRef(null);

  React.useEffect(() => {
    if (!open) return;
    setPhotoFiles([]);
    setUploadingPhotos(false);
    setOverrideReason('');
  }, [open]);

  // Suggest the next-available room id based on what's ALREADY in the
  // rooms blob (not a hardcoded 5×8 grid). Strategy:
  //   1. Find the highest floor that currently has rooms.
  //   2. On that floor, suggest (max room number + 1).
  //   3. If that floor is "full" (>= 99 rooms), bump to next floor / room 1.
  //   4. Empty building → start with 1, room 1 (id = '101').
  // Admin can override the suggested id; uniqueness is enforced via
  // `existingIds.includes(form.id)` below + server's room_code unique index.
  React.useEffect(() => {
    if (!open) return;
    const ids = new Set(existingIds);

    // Parse room ids in the form `${floor}${roomNo.padStart(2,0)}` — same
    // as buildAdminRooms() generates. Free-form ids that don't match are
    // ignored for the purpose of suggestion (admin still sees them in the
    // table; we just don't try to extrapolate from them).
    const byFloor = new Map();
    for (const id of ids) {
      const m = String(id).match(/^(\d{1,2})(\d{2})$/);
      if (!m) continue;
      const f = Number(m[1]);
      const n = Number(m[2]);
      if (!byFloor.has(f)) byFloor.set(f, []);
      byFloor.get(f).push(n);
    }

    let suggestedFloor = 1, suggestedNo = 1;
    if (byFloor.size > 0) {
      // Pick the most-recently-used floor (highest number) and bump by one.
      const floors = Array.from(byFloor.keys()).sort((a, b) => a - b);
      const topFloor = floors[floors.length - 1];
      const topRooms = byFloor.get(topFloor).sort((a, b) => a - b);
      const nextOnTop = topRooms[topRooms.length - 1] + 1;
      if (nextOnTop <= 99) {
        suggestedFloor = topFloor;
        suggestedNo = nextOnTop;
      } else {
        // Top floor is full — suggest first room of a new floor above.
        suggestedFloor = Math.min(topFloor + 1, 99);
        suggestedNo = 1;
      }
    }
    // Resolve to a free id (defensive against bizarre overlap).
    let id = `${suggestedFloor}${String(suggestedNo).padStart(2, '0')}`;
    let bump = 0;
    while (ids.has(id) && bump < 200) {
      bump++;
      const fNo = suggestedNo + bump;
      if (fNo <= 99) {
        id = `${suggestedFloor}${String(fNo).padStart(2, '0')}`;
      } else {
        suggestedFloor = Math.min(suggestedFloor + 1, 99);
        suggestedNo = 1;
        bump = 0;
        id = `${suggestedFloor}${String(suggestedNo).padStart(2, '0')}`;
      }
    }
    const floor = Number(id.match(/^(\d{1,2})/)[1]);
    const rent = computeRoomRent
      ? computeRoomRent('standard', floor, defaultAddView, defaultAddFeatures, config)
      : ADMIN_ROOM_TYPES.standard.baseRent;
    setForm(prev => ({ ...prev,
      id,
      floor,
      no: Number(id.slice(-2)),
      rent,
      ac: ADMIN_ROOM_TYPES.standard.ac,
    }));
    setManualRent(false);
  }, [open]);

  const exists = existingIds.includes(form.id);

  const update = (k, v) => {
    setForm(p => {
      const next = { ...p, [k]: v };
      if (k === 'type') {
        next.ac = ADMIN_ROOM_TYPES[v].ac;
      }
      if (k === 'floor') next.id = `${v}${String(p.no).padStart(2,'0')}`;
      if (k === 'no')    next.id = `${p.floor}${String(v).padStart(2,'0')}`;
      if (computeRoomRent && k !== 'rent' && !manualRent) {
        const feats = { ac: !!next.ac, balcony: !!next.balcony, parking: !!next.parking, kitchen: !!next.kitchen };
        next.rent = computeRoomRent(next.type, Number(next.floor), next.view, feats, config);
      }
      return next;
    });
  };
  const addFeatures = { ac: !!form.ac, balcony: !!form.balcony, parking: !!form.parking, kitchen: !!form.kitchen };
  const formulaRent = computeRoomRent
    ? computeRoomRent(form.type, Number(form.floor), form.view, addFeatures, config)
    : Number(form.rent || 0);
  const rentDiffersFromFormula = Math.abs(Number(form.rent || 0) - Number(formulaRent || 0)) >= 0.01;
  const featurePremium = config?.featurePremium || {};
  const featureRows = [
    { key: 'ac', label: 'แอร์', premium: Number(featurePremium.ac || 0) },
    { key: 'balcony', label: 'มีระเบียง', premium: Number(featurePremium.balcony || 0) },
    { key: 'parking', label: 'ที่จอดรถ', premium: Number(featurePremium.parking || 0) },
    { key: 'kitchen', label: 'ครัวในห้อง', premium: Number(featurePremium.kitchen || 0) },
  ];
  const addIssues = [];
  if (!form.id) addIssues.push('ต้องระบุเลขห้อง');
  if (exists) addIssues.push(`เลขห้อง ${form.id} มีอยู่แล้ว`);
  if (!Number.isFinite(Number(form.floor)) || Number(form.floor) < 1 || Number(form.floor) > 99) addIssues.push('ชั้นต้องอยู่ระหว่าง 1-99');
  if (!Number.isFinite(Number(form.no)) || Number(form.no) < 1 || Number(form.no) > 99) addIssues.push('ลำดับห้องต้องอยู่ระหว่าง 1-99');
  if (!Number.isFinite(Number(form.rent))) addIssues.push('ค่าเช่าต้องเป็นตัวเลข');
  else if (Number(form.rent) > 0 && Number(form.rent) < 100) addIssues.push('ค่าเช่าต่ำกว่า 100 บาท ผิดปกติสำหรับการออกสัญญา/บิล');
  if (manualRent && rentDiffersFromFormula && String(overrideReason).trim().length < 5) {
    addIssues.push('ต้องระบุเหตุผลราคาพิเศษอย่างน้อย 5 ตัวอักษร (เช่น ห้องชำรุด, โปรโมชั่น)');
  }
  const addPendingPhotos = (fileList) => {
    const { accepted, issues } = splitRoomPhotoFiles(fileList, ROOM_PHOTO_MAX_COUNT - photoFiles.length);
    if (issues.length) {
      notify && notify({
        kind: accepted.length ? 'warning' : 'danger',
        message: { title: 'ตรวจสอบรูปห้อง', description: issues.join('\n') },
      });
    }
    if (accepted.length) {
      setPhotoFiles((prev) => [...prev, ...accepted].slice(0, ROOM_PHOTO_MAX_COUNT));
    }
  };
  const removePendingPhoto = (idx) => {
    setPhotoFiles((prev) => prev.filter((_, i) => i !== idx));
  };
  const submit = async () => {
    if (uploadingPhotos) return;
    if (addIssues.length) {
      notify && notify({
        kind: 'danger',
        message: { title: 'ยังเพิ่มห้องไม่ได้', description: addIssues.join('\n') },
      });
      return;
    }
    if (manualRent && rentDiffersFromFormula) {
      const ok = window.confirm(
        `ตรวจสอบก่อนเพิ่มห้อง ${form.id}\n\n` +
        `ราคาตามสูตรกลาง: ${fmtCurrency(formulaRent)}\n` +
        `ราคาพิเศษที่จะบันทึก: ${fmtCurrency(form.rent)}\n` +
        `เหตุผล: ${String(overrideReason).trim()}\n\n` +
        `ห้องนี้จะไม่ตามสูตรกลางจนกว่าจะล้างราคาพิเศษ (ทำได้ที่เมนูตั้งราคา)\n\n` +
        `ยืนยันเพิ่มห้องหรือไม่?`
      );
      if (!ok) return;
    }
    const payload = {
      ...form,
      priceMode: manualRent ? 'custom' : 'formula',
      overrideReason: manualRent ? String(overrideReason).trim() : null,
    };
    setUploadingPhotos(true);
    try {
      const uploadResult = photoFiles.length
        ? await uploadRoomPhotoFiles(apiFetch, form.id, photoFiles)
        : { urls: [], storageModes: [] };
      const ok = onAdd({ ...payload, photos: uploadResult.urls });
      if (ok !== false) {
        setPhotoFiles([]);
        if (uploadResult.urls.length) {
          notify && notify({
            kind: 'success',
            message: `รูปห้อง ${form.id} อัปโหลดสำเร็จ ${uploadResult.urls.length} รูป (${describeRoomPhotoStorage(uploadResult.storageModes)})`,
          });
        }
      }
    } catch (err) {
      const partialPhotos = normaliseRoomPhotos(err.uploaded || []);
      if (partialPhotos.length) {
        const ok = onAdd({ ...payload, photos: partialPhotos });
        if (ok !== false) {
          setPhotoFiles([]);
          notify && notify({
            kind: 'warning',
            message: `เพิ่มห้องพร้อมรูปที่อัปโหลดสำเร็จ ${partialPhotos.length} รูปแล้ว (${describeRoomPhotoStorage(err.storageModes)}) แต่มีบางรูปไม่สำเร็จ: ${err.message || err}`,
          });
        } else {
          notify && notify({
            kind: 'danger',
            message: `เพิ่มห้องไม่สำเร็จหลังอัปโหลดรูปบางส่วน กรุณาตรวจเลขห้องแล้วลองเพิ่มรูปอีกครั้ง`,
          });
        }
        return;
      }
      const ok = onAdd({ ...payload, photos: [] });
      if (ok !== false) {
        setPhotoFiles([]);
        notify && notify({
          kind: 'warning',
          message: `เพิ่มห้อง ${form.id} แล้ว แต่รูปห้องยังไม่ถูกบันทึก: ${err.message || err}`,
        });
      } else {
        notify && notify({
          kind: 'danger',
          message: `เพิ่มห้องและอัปโหลดรูปไม่สำเร็จ: ${err.message || err}`,
        });
      }
    } finally {
      setUploadingPhotos(false);
    }
  };
  const closeModal = () => {
    if (uploadingPhotos) {
      notify && notify({ kind: 'warning', message: 'กำลังอัปโหลดรูปอยู่ กรุณารอให้เสร็จก่อนปิดหน้าต่าง' });
      return;
    }
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={closeModal}
      title="เพิ่มห้องใหม่"
      width={520}
      footer={
        <>
          <Btn variant="ghost" onClick={closeModal} disabled={uploadingPhotos}>ยกเลิก</Btn>
          <Btn variant="primary" disabled={uploadingPhotos}
               onClick={submit}>{uploadingPhotos ? 'กำลังอัปโหลดรูป…' : 'เพิ่มห้อง'}</Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <Input label="ชั้น" type="number" value={form.floor}
                 onChange={(v) => update('floor', Number(v))} />
          <Input label="ลำดับห้อง" type="number" value={form.no}
                 onChange={(v) => update('no', Number(v))} />
          <Input label="เลขห้อง" value={form.id}
                 onChange={(v) => update('id', v)}
                 error={exists ? `ห้อง ${form.id} มีแล้ว` : null} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Select label="ประเภทห้อง" value={form.type}
                  onChange={(v) => update('type', v)}
                  options={ADMIN_ROOM_TYPE_KEYS.map(k => ({ value: k, label: ADMIN_ROOM_TYPES[k].th }))} />
          <Select label="วิว" value={form.view}
                  onChange={(v) => update('view', v)}
                  options={ADMIN_VIEWS} />
        </div>
        {/* ราคา: สูตรกลางเป็นค่าเริ่มต้น (อ่านอย่างเดียว) — ราคาพิเศษต้องเลือก
            เองและใส่เหตุผล จะได้ไม่มี override เกิดจากการเผลอพิมพ์ทับ */}
        <div style={{ padding: 12, background: C.surfaceAlt, borderRadius: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ink }}>ค่าเช่า/เดือน</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <Btn size="sm" variant={!manualRent ? 'primary' : 'ghost'}
                   onClick={() => { setManualRent(false); setOverrideReason(''); update('rent', formulaRent); }}>
                ตามสูตรกลาง (แนะนำ)
              </Btn>
              <Btn size="sm" variant={manualRent ? 'primary' : 'ghost'}
                   onClick={() => setManualRent(true)}>
                กำหนดราคาพิเศษ
              </Btn>
            </div>
          </div>
          {!manualRent ? (
            <>
              <div style={{ fontSize: 22, fontWeight: 800, color: C.ink }}>
                {fmtCurrency(formulaRent)} <span style={{ fontSize: 12, fontWeight: 400, color: C.muted }}>/เดือน</span>
              </div>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4, lineHeight: 1.5 }}>
                {(() => {
                  const base = Number(((config?.rates || {})[form.type] || {}).rent
                    ?? ADMIN_ROOM_TYPES[form.type]?.baseRent ?? 0);
                  const fp = Number((config?.floorPremium || {})[Number(form.floor)] || 0);
                  const vp = Number((config?.viewPremium || {})[form.view] || 0);
                  const featSum = featureRows.reduce((s, it) => s + (addFeatures[it.key] ? it.premium : 0), 0);
                  return ['ฐาน ' + fmtCurrency(base),
                    fp ? `ชั้น +${fmtCurrency(fp)}` : null,
                    vp ? `วิว +${fmtCurrency(vp)}` : null,
                    featSum ? `คุณสมบัติ +${fmtCurrency(featSum)}` : null,
                  ].filter(Boolean).join(' · ');
                })()}
              </div>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 6 }}>
                ราคานี้ผูกกับเมนู "ตั้งราคา" — แก้ราคากลางเมื่อไหร่ ห้องนี้อัปเดตตามอัตโนมัติ
              </div>
            </>
          ) : (
            <>
              <Input label="ราคาพิเศษของห้องนี้" type="number" suffix="บาท"
                     value={form.rent}
                     onChange={(v) => update('rent', Number(v))}
                     error={addIssues.find((x) => x.includes('ค่าเช่า')) || null}
                     hint={`ราคาตามสูตรกลาง: ${fmtCurrency(formulaRent)}`} />
              <Input label="เหตุผลราคาพิเศษ (จำเป็น)"
                     value={overrideReason}
                     onChange={setOverrideReason}
                     placeholder="เช่น ห้องชำรุดรอซ่อม / โปรโมชั่นเปิดตึก / ตกลงราคากับผู้เช่าเดิม"
                     error={addIssues.find((x) => x.includes('เหตุผลราคาพิเศษ')) || null} />
              <div style={{ fontSize: 11.5, color: C.warningInk || C.warning, marginTop: 4, lineHeight: 1.5 }}>
                ⚠️ ห้องนี้จะ "ไม่ตามสูตรกลาง" จนกว่าจะล้างราคาพิเศษ (ดู/ล้างได้ที่เมนูตั้งราคา)
              </div>
            </>
          )}
        </div>
        <div style={{ padding: 12, background: C.surfaceAlt, borderRadius: 8 }}>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>
            คุณสมบัติพิเศษ (กดเพื่อเปิด/ปิด — มีผลกับสูตรราคาห้องนี้)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
            {featureRows.map((item) => {
              const isOn = !!addFeatures[item.key];
              const nextFeatures = { ...addFeatures, [item.key]: !isOn };
              const nextRent = computeRoomRent
                ? computeRoomRent(form.type, Number(form.floor), form.view, nextFeatures, config)
                : formulaRent;
              const diff = Number(nextRent || 0) - Number(formulaRent || 0);
              const diffLabel = diff === 0
                ? 'ราคาไม่เปลี่ยน'
                : `${diff > 0 ? '+' : ''}${fmtCurrency(diff)}`;
              return (
                <button
                  type="button"
                  key={item.key}
                  onClick={() => update(item.key, !isOn)}
                  aria-pressed={isOn}
                  title={`${item.label} · Premium +${fmtCurrency(item.premium)} · กดแล้ว ${diffLabel}`}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'stretch',
                    gap: 4, padding: '10px 12px',
                    background: isOn ? (C.successSoft || '#e3f3e8') : C.surface,
                    border: `1.5px solid ${isOn ? (C.success || '#4a8b4a') : C.border}`,
                    color: isOn ? (C.successInk || '#1d4a2c') : C.ink,
                    borderRadius: 8, cursor: 'pointer', textAlign: 'left',
                    fontFamily: 'inherit', minWidth: 0,
                    transition: 'background .15s, border-color .15s',
                  }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600 }}>{item.label}</span>
                    <span style={{
                      fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                      background: isOn ? (C.success || '#4a8b4a') : (C.borderStrong || '#999'),
                      color: '#fff', flexShrink: 0,
                    }}>{isOn ? 'เปิด' : 'ปิด'}</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.4 }}>
                    Premium +{fmtCurrency(item.premium)} · กดแล้ว {diffLabel}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
        <div style={{ padding: 12, background: C.surfaceAlt, borderRadius: 8, border: `1px solid ${C.borderSoft}` }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>รูปห้อง</div>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>JPG, PNG, WebP · บันทึกเป็น URL ไม่ฝัง base64 ในข้อมูลห้อง</div>
            </div>
            <Btn
              variant="secondary"
              size="sm"
              icon="+"
              disabled={uploadingPhotos || photoFiles.length >= ROOM_PHOTO_MAX_COUNT}
              onClick={() => addPhotoInputRef.current && addPhotoInputRef.current.click()}
            >
              เลือกรูป
            </Btn>
            <input
              ref={addPhotoInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                addPendingPhotos(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
          {photoFiles.length ? (
            <div style={{ display: 'grid', gap: 6 }}>
              {photoFiles.map((file, idx) => (
                <div key={`${file.name}-${file.size}-${idx}`} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                  padding: '8px 10px', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 7,
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {file.name || `photo-${idx + 1}`}
                    </div>
                    <div style={{ fontSize: 11, color: C.muted }}>{formatRoomPhotoFileSize(file)}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removePendingPhoto(idx)}
                    disabled={uploadingPhotos}
                    style={{
                      border: 'none', background: 'transparent', color: C.danger,
                      cursor: uploadingPhotos ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600,
                    }}
                  >
                    ลบ
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: C.muted, padding: '8px 0 2px' }}>
              เลือกรูปได้ตอนสร้างห้อง หรือเพิ่ม/ลบรูปภายหลังในหน้าแก้ไขห้อง
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// --- Edit form (sub-component) -------------------------------------------
function RoomEditForm({ room, originalRoom, onUpdate, onServerPatch, config, setToast }) {
  const C = window.ADMIN_C;
  const ADMIN_STATUS = window.ADMIN_STATUS;
  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES;
  const ADMIN_ROOM_TYPE_KEYS = window.ADMIN_ROOM_TYPE_KEYS;
  const ADMIN_VIEWS = window.ADMIN_VIEWS;
  const { fmt, fmtCurrency, computeRoomRent, resolveRoomRent, resolveRoomDeposit } = window;
  const { Input, Select, Toggle, Textarea, SectionHeading, DefList, Pill, Btn } = window;
  const apiFetch = window.requireApiFetch ? window.requireApiFetch() : window.apiFetch;
  const notify = setToast || window.toast;
  const roomPhotoInputRef = React.useRef(null);
  const [photoBusy, setPhotoBusy] = React.useState(false);
  const [showLegacyDeposit, setShowLegacyDeposit] = React.useState(false);

  // Server-side audit for this room: cross-checks blob, rooms_v2, contracts,
  // and outstanding bills to surface inconsistencies the rooms-blob UI alone
  // can't see (e.g., blob shows tenant but no active contract → "stranded
  // occupied" — the exact bug the operator reported). Also lists outstanding
  // bills with tenant_name so admin knows whose unpaid bill is on this room.
  const [audit, setAudit] = React.useState(null);
  const [auditErr, setAuditErr] = React.useState(null);
  const [reconciling, setReconciling] = React.useState(false);
  const [auditLoadKey, setAuditLoadKey] = React.useState(0);
  React.useEffect(() => {
    let cancelled = false;
    setAudit(null); setAuditErr(null);
    fetch(`/api/admin/rooms/${encodeURIComponent(room.id)}/audit`, {
      credentials: 'same-origin',
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, body: d })))
      .then(({ ok, body }) => {
        if (cancelled) return;
        if (ok && body.ok) setAudit(body);
        else setAuditErr(body.error || `HTTP ${ok ? '200 unexpected' : 'fail'}`);
      })
      .catch((e) => { if (!cancelled) setAuditErr(e.message); });
    return () => { cancelled = true; };
  }, [room.id, auditLoadKey]);

  const reconcile = async () => {
    if (!audit?.reconcilable) return;
    const ok = window.confirm(
      `ยืนยัน Reconcile ห้อง ${room.id}?\n\n` +
      `ระบบจะ:\n` +
      `  1) ปิดสัญญา active ที่ค้างอยู่ (status='ended', end_date=วันนี้)\n` +
      `  2) ลบข้อมูลผู้เช่าออกจาก rooms blob (status='vacant')\n` +
      `  3) sync rooms_v2.status='vacant'\n` +
      `  4) เพิกถอน access cards ของ tenant ที่ค้าง\n` +
      `  5) ปิด recurring charges ของ tenant\n\n` +
      `* บิลค้างของอดีตผู้เช่าจะ "ไม่" ถูกแตะ — เปิดหน้า Billing เพื่อ void ถ้าตัดสินใจไม่เก็บเงิน`
    );
    if (!ok) return;
    setReconciling(true);
    try {
      const r = await apiFetch(`/api/admin/rooms/${encodeURIComponent(room.id)}/reconcile`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'admin reconcile from rooms page' }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'reconcile failed');
      notify && notify({ kind: 'success', message: `Reconciled ห้อง ${room.id} — ${d.actions?.length || 0} actions` });
      setAuditLoadKey((k) => k + 1);
      // The parent rooms blob also needs a refresh — onUpdate is the
      // hook into the parent state, but it expects a patch object. Pass
      // the reconciled state so the rooms grid updates immediately
      // without a full /api/data refetch.
      const patch = { tenant: null, status: 'vacant', since: null, contractEnd: null };
      if (onServerPatch) onServerPatch(patch);
      else onUpdate(patch);
    } catch (e) {
      notify && notify({ kind: 'danger', message: 'Reconcile ล้มเหลว: ' + (e.message || e) });
    } finally { setReconciling(false); }
  };

  const features = {
    balcony: room.balcony,
    ac: (room.ac ?? room.hasAc ?? room.has_ac) === undefined
      ? (ADMIN_ROOM_TYPES[room.type] || ADMIN_ROOM_TYPES.standard).ac
      : !!(room.ac ?? room.hasAc ?? room.has_ac),
    parking: room.parking,
    kitchen: room.kitchen,
  };
  const computedRent = computeRoomRent(room.type, room.floor, room.view, features, config);
  const originalFeatures = originalRoom ? {
    balcony: !!(originalRoom.balcony || originalRoom.hasBalcony || originalRoom.has_balcony),
    ac: (originalRoom.ac ?? originalRoom.hasAc ?? originalRoom.has_ac) === undefined
      ? (ADMIN_ROOM_TYPES[originalRoom.type] || ADMIN_ROOM_TYPES.standard).ac
      : !!(originalRoom.ac ?? originalRoom.hasAc ?? originalRoom.has_ac),
    parking: !!(originalRoom.parking || originalRoom.hasParking || originalRoom.has_parking),
    kitchen: !!(originalRoom.kitchen || originalRoom.hasKitchen || originalRoom.has_kitchen),
  } : features;
  const originalComputedRent = originalRoom
    ? computeRoomRent(originalRoom.type, originalRoom.floor, originalRoom.view, originalFeatures, config)
    : computedRent;
  const rentInfo = resolveRoomRent ? resolveRoomRent(room, config) : {
    rent: room.rent,
    source: 'legacy',
    formula: computedRent,
    override: room.rentOverride || null,
  };
  const effectiveRent = Number(rentInfo.rent) || 0;
  const overrideRent = rentInfo.override == null ? '' : rentInfo.override;
  const fallbackRoomDeposit = Number(room.deposit);
  const depositInfo = resolveRoomDeposit
    ? resolveRoomDeposit(room, config, effectiveRent || computedRent)
    : {
      deposit: Number.isFinite(fallbackRoomDeposit) && fallbackRoomDeposit >= 0
        ? fallbackRoomDeposit
        : (effectiveRent > 0 ? effectiveRent * 2 : 0),
      source: 'room_snapshot',
      sourceLabel: 'ค่า fallback ของห้อง',
    };
  const effectiveDeposit = Number(depositInfo.deposit) || 0;
  const depositUsesPricing = depositInfo.source === 'pricing_config';
  const featurePremium = config?.featurePremium || {};
  const featureToggleRows = [
    {
      key: 'ac',
      label: 'แอร์',
      checked: !!features.ac,
      premium: Number(featurePremium.ac || 0),
      onChange: (v) => onUpdate({ ac: v }),
      note: 'ใช้กำหนดว่าห้องนี้คิดพรีเมียมแอร์หรือไม่ แม้ประเภทห้องเดิมจะเป็นห้องแอร์ก็ตาม',
    },
    {
      key: 'balcony',
      label: 'มีระเบียง',
      checked: !!features.balcony,
      premium: Number(featurePremium.balcony || 0),
      onChange: (v) => onUpdate({ balcony: v }),
      note: 'เปิดเมื่อห้องมีระเบียงจริงและต้องการให้สูตรค่าเช่าบวกพรีเมียมระเบียง',
    },
    {
      key: 'parking',
      label: 'ที่จอดรถ',
      checked: !!features.parking,
      premium: Number(featurePremium.parking || 0),
      onChange: (v) => onUpdate({ parking: v }),
      note: 'เปิดเมื่อห้องผูกสิทธิ์จอดรถประจำกับค่าเช่าห้อง ไม่ใช่ค่าจอดรถรายเดือนแยก',
    },
    {
      key: 'kitchen',
      label: 'ครัวในห้อง',
      checked: !!features.kitchen,
      premium: Number(featurePremium.kitchen || 0),
      onChange: (v) => onUpdate({ kitchen: v }),
      note: 'เปิดเมื่อห้องมีครัวในตัวและต้องคิดพรีเมียมตามสูตรค่าเช่า',
    },
  ].map((item) => {
    const nextFeatures = { ...features, [item.key]: !item.checked };
    const nextRent = computeRoomRent(room.type, room.floor, room.view, nextFeatures, config);
    return { ...item, deltaOnToggle: nextRent - computedRent };
  });
  const pricingControlChanged = !!(originalRoom && (
    String(originalRoom.type || '') !== String(room.type || '') ||
    String(originalRoom.view || '') !== String(room.view || '') ||
    !!originalFeatures.balcony !== !!features.balcony ||
    !!originalFeatures.ac !== !!features.ac ||
    !!originalFeatures.parking !== !!features.parking ||
    !!originalFeatures.kitchen !== !!features.kitchen
  ));

  const clearRentOverride = () => {
    const patch = {
      rent: computedRent,
      rentOverride: null,
      rentOverrideReason: null,
      rentOverrideAt: null,
      rentOverrideBy: null,
    };
    const currentDeposit = Number(room.deposit);
    if (!Number.isFinite(currentDeposit)
      || currentDeposit === 0
      || Math.abs(currentDeposit - effectiveRent * 2) < 0.01) {
      patch.deposit = computedRent * 2;
    }
    onUpdate(patch);
  };

  const setRentOverride = (v) => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) {
      const patch = {
        rent: n,
        rentOverride: n,
        rentOverrideReason: room.rentOverrideReason || 'ราคาพิเศษรายห้อง (ตั้งจากหน้าห้องพัก)',
        rentOverrideAt: new Date().toISOString(),
        rentOverrideBy: 'admin-ui',
      };
      const currentDeposit = Number(room.deposit);
      if (!Number.isFinite(currentDeposit)
        || currentDeposit === 0
        || Math.abs(currentDeposit - effectiveRent * 2) < 0.01) {
        patch.deposit = n * 2;
      }
      onUpdate(patch);
    } else {
      clearRentOverride();
    }
  };

  const roomPhotos = normaliseRoomPhotos(room.photos);
  const commitRoomPhotos = (photos) => {
    const nextPhotos = normaliseRoomPhotos(photos);
    const applied = onServerPatch ? onServerPatch({ photos: nextPhotos }) : false;
    if (!applied) onUpdate({ photos: nextPhotos });
    return nextPhotos;
  };
  const addRoomPhotos = async (fileList) => {
    if (photoBusy) return;
    const { accepted, issues } = splitRoomPhotoFiles(fileList, ROOM_PHOTO_MAX_COUNT - roomPhotos.length);
    if (issues.length) {
      notify && notify({
        kind: accepted.length ? 'warning' : 'danger',
        message: { title: 'ตรวจสอบรูปห้อง', description: issues.join('\n') },
      });
    }
    if (!accepted.length) return;
    if (roomPhotos.length >= ROOM_PHOTO_MAX_COUNT) {
      notify && notify({ kind: 'warning', message: `เก็บรูปได้สูงสุด ${ROOM_PHOTO_MAX_COUNT} รูปต่อห้อง` });
      return;
    }
    setPhotoBusy(true);
    try {
      const uploadResult = await uploadRoomPhotoFiles(apiFetch, room.id, accepted);
      commitRoomPhotos([...roomPhotos, ...uploadResult.urls]);
      notify && notify({
        kind: 'success',
        message: `เพิ่มรูปห้อง ${room.id} แล้ว ${uploadResult.urls.length} รูป (${describeRoomPhotoStorage(uploadResult.storageModes)}) และบันทึกเข้าห้องแล้ว`,
      });
    } catch (err) {
      const partialPhotos = normaliseRoomPhotos(err.uploaded || []);
      if (partialPhotos.length) {
        commitRoomPhotos([...roomPhotos, ...partialPhotos]);
        notify && notify({
          kind: 'warning',
          message: `เพิ่มรูปที่อัปโหลดสำเร็จ ${partialPhotos.length} รูปแล้ว (${describeRoomPhotoStorage(err.storageModes)}) และบันทึกเข้าห้องแล้ว แต่มีบางรูปไม่สำเร็จ: ${err.message || err}`,
        });
        return;
      }
      notify && notify({
        kind: 'danger',
        message: `อัปโหลดรูปห้องไม่สำเร็จ: ${err.message || err}`,
      });
    } finally {
      setPhotoBusy(false);
    }
  };
  const removeRoomPhoto = (idx) => {
    commitRoomPhotos(roomPhotos.filter((_, i) => i !== idx));
    notify && notify({ kind: 'warning', message: `ลบรูปห้อง ${room.id} แล้ว` });
  };
  const setRoomCoverPhoto = (idx) => {
    if (idx <= 0) return;
    const next = [...roomPhotos];
    const [picked] = next.splice(idx, 1);
    next.unshift(picked);
    commitRoomPhotos(next);
    notify && notify({ kind: 'success', message: `ตั้งรูปหลักของห้อง ${room.id} แล้ว` });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {/* === Cross-source audit panel =================================
          Shows server-side issues (stranded occupied, status mismatch)
          + outstanding bills grouped by previous tenant. Renders only
          when there's something worth showing — clean rooms stay quiet.
       ============================================================= */}
      {audit && (audit.issues.length > 0 || audit.outstandingBills.length > 0) ? (
        <div style={{
          padding: 14, borderRadius: 10,
          background: audit.issues.some((i) => i.sev === 'high') ? C.dangerSoft : C.warningSoft,
          border: `1px solid ${audit.issues.some((i) => i.sev === 'high') ? C.danger : '#f0e3a7'}`,
        }}>
          <div style={{ fontFamily: 'IBM Plex Sans Thai', fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
            {audit.issues.some((i) => i.sev === 'high') ? '🔴 ห้องนี้มีปัญหา' : '🟡 ห้องนี้มีบิลค้าง'}
          </div>
          {audit.issues.map((it, idx) => (
            <div key={idx} style={{
              padding: 10, marginBottom: 6, borderRadius: 6,
              background: '#fff',
              borderLeft: `3px solid ${it.sev === 'high' ? C.danger : C.warning}`,
              fontSize: 13, lineHeight: 1.6,
            }}>
              <div style={{ fontWeight: 500 }}>
                {it.sev === 'high' ? '🔴' : '🟡'} {it.msg}
              </div>
              {it.fix ? (
                <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>→ {it.fix}</div>
              ) : null}
              {/* Outstanding-bill detail: list each bill with tenant name
                  attached so admin sees exactly whose ค้าง is on this room. */}
              {it.code === 'OUTSTANDING_FROM_MOVED_OUT' && it.detail?.bills ? (
                <div style={{ marginTop: 8, padding: 8, background: C.surfaceAlt, borderRadius: 4 }}>
                  <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>
                    บิลค้าง ({it.detail.bills.length} ใบ) จาก{' '}
                    <a href={`/admin#tenants/${it.detail.tenantId}`} style={{ color: C.accent, fontWeight: 600 }}>
                      {it.detail.tenantName || '-'}
                    </a>
                    {it.detail.tenantPhone ? ` · โทร ${it.detail.tenantPhone}` : ''}
                  </div>
                  {it.detail.bills.map((b) => (
                    <div key={b.id} style={{
                      display: 'flex', justifyContent: 'space-between',
                      fontSize: 12, padding: '4px 0',
                      borderTop: '1px dashed #e5dec9',
                    }}>
                      <span>
                        {b.billNo} · รอบ {b.period || '-'}
                        {b.daysOverdue > 0 ? (
                          <span style={{ color: C.danger, marginLeft: 6 }}>
                            (เกิน {b.daysOverdue} วัน)
                          </span>
                        ) : null}
                      </span>
                      <strong>{fmtCurrency(b.total)}</strong>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
          {audit.reconcilable ? (
            <div style={{ marginTop: 10 }}>
              <Btn variant="primary" icon="🔧"
                onClick={reconcile} disabled={reconciling}>
                {reconciling ? 'กำลัง reconcile…' : 'Reconcile ห้อง'}
              </Btn>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 6 }}>
                ปุ่มนี้จะ sync ทุก source ให้ตรงกัน (contract→ended + blob/v2→vacant)
                — บิลค้างไม่ถูกแตะ
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {auditErr ? (
        <div style={{
          padding: 10, borderRadius: 6, background: C.dangerSoft,
          border: '1px solid #f5c0b4', fontSize: 12.5, color: C.dangerInk,
        }}>
          ⚠ ตรวจสอบสถานะห้องไม่สำเร็จ: {auditErr}
        </div>
      ) : null}

      {/* Quick info */}
      <div style={{
        background: C.surfaceAlt, padding: 14, borderRadius: 10,
        border: `1px solid ${C.borderSoft}`,
      }}>
        <DefList
          columns={2}
          dense
          items={[
            { label: 'เลขห้อง',   value: room.id, bold: true },
            { label: 'ชั้น',         value: `ชั้น ${room.floor}` },
            { label: 'ประเภท',     value: ADMIN_ROOM_TYPES[room.type].th },
            { label: 'ขนาด',         value: `${ADMIN_ROOM_TYPES[room.type].size} ตร.ม.` },
            { label: 'ค่าเช่าปัจจุบัน', value: fmtCurrency(effectiveRent), bold: true },
            { label: 'ราคาตามสูตร',   value: fmtCurrency(computedRent) },
            { label: 'ที่มาราคา', value: rentInfo.source === 'override' ? 'ราคาพิเศษรายห้อง' : rentInfo.source === 'formula' ? 'สูตรจาก Pricing' : 'ค่าเดิม' },
            { label: 'มัดจำสัญญาใหม่', value: fmtCurrency(effectiveDeposit), bold: true },
            { label: 'ที่มามัดจำ', value: depositInfo.sourceLabel || 'เมนูตั้งราคา' },
          ]}
        />
      </div>

      {/* Room photos */}
      <div>
        <SectionHeading
          title="รูปห้อง"
          level={3}
          style={{ marginBottom: 10 }}
          action={
            <Btn
              variant="secondary"
              size="sm"
              icon="+"
              disabled={photoBusy || roomPhotos.length >= ROOM_PHOTO_MAX_COUNT}
              onClick={() => roomPhotoInputRef.current && roomPhotoInputRef.current.click()}
            >
              เพิ่มรูป
            </Btn>
          }
        />
        <input
          ref={roomPhotoInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            addRoomPhotos(e.target.files);
            e.target.value = '';
          }}
        />
        {roomPhotos.length ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
            {roomPhotos.map((src, idx) => (
              <div key={`${src}-${idx}`} style={{
                border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden',
                background: C.surface, minWidth: 0,
              }}>
                <div style={{ aspectRatio: '4/3', background: C.borderSoft, overflow: 'hidden' }}>
                  <img
                    src={src}
                    alt={`Room ${room.id} photo ${idx + 1}`}
                    loading="lazy"
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                </div>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
                  padding: 8, borderTop: `1px solid ${C.borderSoft}`,
                }}>
                  <div style={{ fontSize: 11.5, color: C.muted, fontWeight: 600 }}>
                    {idx === 0 ? 'รูปหลัก' : `รูป ${idx + 1}`}
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {idx > 0 ? (
                      <button
                        type="button"
                        onClick={() => setRoomCoverPhoto(idx)}
                        style={{ border: 'none', background: 'transparent', color: C.accent, cursor: 'pointer', fontSize: 11.5, fontWeight: 600 }}
                      >
                        ใช้หลัก
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => removeRoomPhoto(idx)}
                      style={{ border: 'none', background: 'transparent', color: C.danger, cursor: 'pointer', fontSize: 11.5, fontWeight: 600 }}
                    >
                      ลบ
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{
            padding: 14, borderRadius: 8, background: C.surfaceAlt, border: `1px dashed ${C.borderStrong}`,
            color: C.muted, fontSize: 12.5, lineHeight: 1.5,
          }}>
            ยังไม่มีรูปห้อง · กด “เพิ่มรูป” เพื่ออัปโหลดผ่าน storage กลางของระบบ
          </div>
        )}
        {photoBusy ? (
          <div style={{ marginTop: 8, fontSize: 12, color: C.muted }}>กำลังอัปโหลดรูปห้อง...</div>
        ) : null}
      </div>

      {/* Status */}
      <div>
        <SectionHeading title="สถานะ" level={3} style={{ marginBottom: 10 }} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
          {Object.keys(ADMIN_STATUS).map(k => {
            const s = ADMIN_STATUS[k];
            const active = room.status === k;
            return (
              <button
                key={k}
                type="button"
                onClick={() => onUpdate({ status: k })}
                style={{
                  padding: '10px 12px',
                  background: active ? s.soft : C.surface,
                  border: `1px solid ${active ? s.dot : C.border}`,
                  borderRadius: 9, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 8,
                  fontSize: 12.5, fontWeight: active ? 600 : 500,
                  color: active ? s.ink : C.ink2,
                  fontFamily: 'inherit',
                  transition: 'all .15s',
                }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.dot }} />
                {s.th}
              </button>
            );
          })}
        </div>
      </div>

      {/* Type & view */}
      <div>
        <SectionHeading title="ประเภทและตำแหน่ง" level={3} style={{ marginBottom: 10 }} />
        <div style={{
          padding: 10, background: C.infoSoft, border: `1px solid ${C.info}33`,
          borderRadius: 8, fontSize: 12.5, color: C.infoInk,
          lineHeight: 1.55, marginBottom: 10,
        }}>
          ใช้กำหนด “ลักษณะจริงของห้อง” เพื่อแสดงผลในหน้าห้อง/หน้าจอง และคำนวณค่าเช่าตามสูตร
          จากหน้า Pricing. การเปลี่ยนตรงนี้มีผลกับห้องว่างและสัญญาใหม่เท่านั้น;
          สัญญาที่ lock แล้วกับบิลเดิมไม่ถูกแก้ย้อนหลัง.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Select
            label="ประเภทห้อง"
            value={room.type}
            onChange={(v) => onUpdate({ type: v })}
            options={ADMIN_ROOM_TYPE_KEYS.map(k => ({ value: k, label: ADMIN_ROOM_TYPES[k].th }))}
          />
          <Select
            label="วิว"
            value={room.view}
            onChange={(v) => onUpdate({ view: v })}
            options={ADMIN_VIEWS}
          />
        </div>
        <div style={{ marginTop: 12, padding: 12, background: C.surfaceAlt, borderRadius: 8 }}>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>
            คุณสมบัติพิเศษที่ใช้ในสูตรราคา
          </div>
          <div style={{ fontSize: 12.5, color: C.ink2, lineHeight: 1.55, marginBottom: 8 }}>
            ปุ่มเหล่านี้ไม่ได้เป็นแค่ข้อมูลแสดงผล แต่เป็นตัวแปรในสูตรค่าเช่าเดียวกับหน้า Pricing
            จึงมีผลกับราคาห้องว่างและสัญญาใหม่ ส่วนสัญญาที่ lock แล้ว/บิลที่ออกแล้วจะไม่ถูกแก้ย้อนหลัง
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
            {featureToggleRows.map((item) => {
              const isOn = !!item.checked;
              const nextLabel = item.deltaOnToggle === 0
                ? 'ราคาไม่เปลี่ยน'
                : `${item.deltaOnToggle > 0 ? '+' : ''}${fmtCurrency(item.deltaOnToggle)}`;
              const handleClick = () => {
                if (typeof item.onChange !== 'function') return;
                // Pass the explicit boolean so a click never lands inside the
                // callback as a SyntheticEvent — that was the silent bug when
                // a name-collision swapped Toggle out from under us.
                item.onChange(!isOn);
              };
              return (
                <button
                  type="button"
                  key={item.key}
                  onClick={handleClick}
                  aria-pressed={isOn}
                  title={`${item.note} · Premium +${fmtCurrency(item.premium)} · กดแล้ว ${nextLabel}`}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'stretch',
                    gap: 4, padding: '10px 12px',
                    background: isOn ? (C.successSoft || '#e3f3e8') : C.surface,
                    border: `1.5px solid ${isOn ? (C.success || '#4a8b4a') : C.border}`,
                    color: isOn ? (C.successInk || '#1d4a2c') : C.ink,
                    borderRadius: 8, cursor: 'pointer', textAlign: 'left',
                    fontFamily: 'inherit', minWidth: 0,
                    transition: 'background .15s, border-color .15s',
                  }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600 }}>{item.label}</span>
                    <span style={{
                      fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                      background: isOn ? (C.success || '#4a8b4a') : (C.borderStrong || '#999'),
                      color: '#fff', flexShrink: 0,
                    }}>{isOn ? 'เปิด' : 'ปิด'}</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.4 }}>
                    Premium ที่ตั้งไว้ +{fmtCurrency(item.premium)} · กดแล้ว {nextLabel}
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.4 }}>
                    {item.note}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
        <div style={{
          marginTop: 10, padding: 10,
          background: pricingControlChanged ? C.warningSoft : C.surfaceAlt,
          border: `1px solid ${pricingControlChanged ? '#f0c36a' : C.border}`,
          borderRadius: 8, fontSize: 12.5, color: pricingControlChanged ? C.warningInk : C.muted,
          lineHeight: 1.6,
        }}>
          <div style={{ fontWeight: 600, color: pricingControlChanged ? C.warningInk : C.ink2 }}>
            ผลต่อราคา
          </div>
          <div>
            ราคาตามสูตร: {fmtCurrency(originalComputedRent)} → <b>{fmtCurrency(computedRent)}</b>
          </div>
          {rentInfo.source === 'override' ? (
            <div>
              ห้องนี้มีราคาพิเศษรายห้องอยู่ ราคาที่ใช้จริงยังเป็น <b>{fmtCurrency(effectiveRent)}</b>
              จนกว่าจะกด “ล้างราคาพิเศษ”
            </div>
          ) : (
            <div>
              ราคาที่ใช้สำหรับห้องว่าง/สัญญาใหม่ตอนนี้คือ <b>{fmtCurrency(effectiveRent)}</b>
            </div>
          )}
        </div>
      </div>

      {/* Pricing */}
      <div>
        <SectionHeading title="ราคาและค่าใช้จ่าย" level={3} style={{ marginBottom: 10 }} />
        <div style={{
          padding: 10, background: C.infoSoft || C.surfaceAlt,
          border: `1px solid ${(C.info || C.accent)}33`, borderRadius: 8,
          fontSize: 12.5, color: C.infoInk || C.ink2, lineHeight: 1.55,
          marginBottom: 10,
        }}>
          ราคากลางและเงินมัดจำแก้ที่เมนูตั้งราคาเป็นหลัก. หน้านี้ใช้กำหนดข้อยกเว้นรายห้องและโหมดค่าน้ำ/ค่าไฟของห้องนี้เท่านั้น.
          หน่วยค่าน้ำและค่าไฟของแต่ละเดือนต้องบันทึกที่หน้า มิเตอร์ เพื่อให้บิลดึงเลขตามรอบเดือนที่ออกจริง.
          <div style={{ marginTop: 8 }}>
            <Btn variant="secondary" onClick={() => { window.location.hash = 'meters'; }}>ไปหน้ามิเตอร์</Btn>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Input
            label="ราคาพิเศษรายห้อง" type="number" suffix="บาท"
            value={overrideRent}
            placeholder={String(computedRent || '')}
            onChange={setRentOverride}
            hint="ปล่อยว่างเพื่อใช้ราคาตามสูตรจากหน้า Pricing"
          />
          <div style={{
            padding: 12,
            border: `1px solid ${depositUsesPricing ? C.success || C.border : C.warning || C.border}`,
            borderRadius: 8,
            background: depositUsesPricing ? (C.successSoft || C.surfaceAlt) : C.warningSoft,
            minWidth: 0,
          }}>
            <div style={{ fontSize: 12, color: depositUsesPricing ? (C.successInk || C.ink2) : C.warningInk, marginBottom: 4 }}>
              เงินมัดจำสำหรับสัญญาใหม่
            </div>
            <div style={{
              display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
              gap: 10, flexWrap: 'wrap',
            }}>
              <b style={{ fontSize: 20, color: C.ink }}>{fmtCurrency(effectiveDeposit)}</b>
              <span style={{ fontSize: 11.5, color: C.muted }}>{depositInfo.sourceLabel || 'เมนูตั้งราคา'}</span>
            </div>
            <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.45, marginTop: 6 }}>
              แก้ค่าหลักที่เมนูตั้งราคา เพื่อให้ booking, check-in, quick invite และสัญญาใหม่ใช้ยอดเดียวกัน
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              <Btn variant="secondary" size="sm" onClick={() => { window.location.hash = 'pricing'; }}>
                เปิดเมนูตั้งราคา
              </Btn>
              <Btn variant="ghost" size="sm" onClick={() => setShowLegacyDeposit(v => !v)}>
                {showLegacyDeposit ? 'ซ่อนค่า fallback' : 'ดูค่า fallback'}
              </Btn>
            </div>
          </div>
          {showLegacyDeposit ? (
            <div style={{
              gridColumn: '1 / -1',
              padding: 12,
              border: `1px dashed ${C.borderStrong || C.border}`,
              borderRadius: 8,
              background: C.surfaceAlt,
            }}>
              <Input
                label="มัดจำ fallback ของห้อง" type="number" suffix="บาท"
                value={room.deposit}
                onChange={(v) => onUpdate({ deposit: Number(v) })}
                hint="ใช้เฉพาะเมื่อเมนูตั้งราคาไม่ได้กำหนดมัดจำของประเภทห้องนี้"
              />
            </div>
          ) : null}
          {/* Water section — mode toggle drives whether the metered inputs
              or the flat-amount input shows. Both modes save to the room
              blob so admin can flip back and forth without losing data. */}
          <div style={{
            gridColumn: '1 / -1',
            padding: 12,
            border: `1px solid ${C.borderSoft}`, borderRadius: 8,
            background: C.surface,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>โหมดค่าน้ำ</span>
              <label style={{ fontSize: 13, color: C.ink2, display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="radio" name={`waterMode-${room.id}`}
                  checked={(room.waterMode || 'metered') !== 'flat'}
                  onChange={() => onUpdate({ waterMode: 'metered' })} />
                ตามมิเตอร์
              </label>
              <label style={{ fontSize: 13, color: C.ink2, display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="radio" name={`waterMode-${room.id}`}
                  checked={room.waterMode === 'flat'}
                  onChange={() => onUpdate({ waterMode: 'flat' })} />
                เหมารายเดือน
              </label>
            </div>
            {room.waterMode === 'flat' ? (
              <React.Fragment>
                <Input
                  label="ค่าน้ำเหมา" type="number" step="0.01" suffix="บาท/เดือน"
                  value={room.waterFlatAmount == null ? '' : room.waterFlatAmount}
                  onChange={(v) => onUpdate({
                    waterFlatAmount: v === '' ? null : Number(v),
                    water: v === '' ? 0 : Number(v),
                  })}
                  hint="ค่าน้ำเดือนละเท่าไรไม่นับตามเลขมิเตอร์"
                />
                {(room.waterFlatAmount == null || Number(room.waterFlatAmount) <= 0) ? (
                  <div style={{
                    marginTop: 8, padding: 10, borderRadius: 8,
                    background: '#FEF3C7', border: '1px solid #F2C84B',
                    fontSize: 12.5, color: '#7A5A0F', lineHeight: 1.5,
                  }}>
                    ⚠ เลือก "เหมา" แต่ยังไม่กรอกจำนวน — บิลที่ออกจะกลับไปคิดตามมิเตอร์ (fallback) จนกว่าจะกรอก
                  </div>
                ) : null}
              </React.Fragment>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Input
                  label="ค่าน้ำ (หน่วยล่าสุด)" type="number" suffix="หน่วย"
                  value={room.waterUnits}
                  disabled
                  hint="บันทึกหน่วยรายเดือนที่หน้า มิเตอร์ โดยเลือกรอบเดือนก่อนออกบิล"
                />
                <Input
                  label="อัตราพิเศษ" type="number" step="0.01" suffix="บาท/หน่วย"
                  value={room.waterRateOverride == null ? '' : room.waterRateOverride}
                  placeholder={String(config.utilities.waterRate ?? 18)}
                  onChange={(v) => onUpdate({
                    waterRateOverride: v === '' ? null : Number(v),
                  })}
                  hint="ว่าง = ใช้อัตรากลางจาก Pricing"
                />
              </div>
            )}
          </div>

          {/* Electricity section — same shape as water. */}
          <div style={{
            gridColumn: '1 / -1',
            padding: 12,
            border: `1px solid ${C.borderSoft}`, borderRadius: 8,
            background: C.surface,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>โหมดค่าไฟ</span>
              <label style={{ fontSize: 13, color: C.ink2, display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="radio" name={`elecMode-${room.id}`}
                  checked={(room.elecMode || 'metered') !== 'flat'}
                  onChange={() => onUpdate({ elecMode: 'metered' })} />
                ตามมิเตอร์
              </label>
              <label style={{ fontSize: 13, color: C.ink2, display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="radio" name={`elecMode-${room.id}`}
                  checked={room.elecMode === 'flat'}
                  onChange={() => onUpdate({ elecMode: 'flat' })} />
                เหมารายเดือน
              </label>
            </div>
            {room.elecMode === 'flat' ? (
              <React.Fragment>
                <Input
                  label="ค่าไฟเหมา" type="number" step="0.01" suffix="บาท/เดือน"
                  value={room.elecFlatAmount == null ? '' : room.elecFlatAmount}
                  onChange={(v) => onUpdate({
                    elecFlatAmount: v === '' ? null : Number(v),
                    elec: v === '' ? 0 : Number(v),
                  })}
                  hint="ค่าไฟเดือนละเท่าไรไม่นับตามเลขมิเตอร์"
                />
                {(room.elecFlatAmount == null || Number(room.elecFlatAmount) <= 0) ? (
                  <div style={{
                    marginTop: 8, padding: 10, borderRadius: 8,
                    background: '#FEF3C7', border: '1px solid #F2C84B',
                    fontSize: 12.5, color: '#7A5A0F', lineHeight: 1.5,
                  }}>
                    ⚠ เลือก "เหมา" แต่ยังไม่กรอกจำนวน — บิลที่ออกจะกลับไปคิดตามมิเตอร์ (fallback) จนกว่าจะกรอก
                  </div>
                ) : null}
              </React.Fragment>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Input
                  label="ค่าไฟ (หน่วยล่าสุด)" type="number" suffix="หน่วย"
                  value={room.elecUnits}
                  disabled
                  hint="บันทึกเลขไฟของรอบเดือนที่หน้า มิเตอร์ ไม่กรอกในหน้าห้องพัก"
                />
                <Input
                  label="อัตราพิเศษ" type="number" step="0.01" suffix="บาท/หน่วย"
                  value={room.elecRateOverride == null ? '' : room.elecRateOverride}
                  placeholder={String(config.utilities.elecRate ?? 8)}
                  onChange={(v) => onUpdate({
                    elecRateOverride: v === '' ? null : Number(v),
                  })}
                  hint="ว่าง = ใช้อัตรากลางจาก Pricing"
                />
              </div>
            )}
          </div>

          <Input
            label="ค่า Wi-Fi" type="number" suffix="บาท/เดือน"
            value={room.wifi}
            onChange={(v) => onUpdate({ wifi: Number(v) })}
            hint="ใส่ 0 เพื่อไม่คิด (free wifi) — ปล่อยว่างเพื่อใช้ค่ากลางจาก Pricing"
          />
        </div>
        <div style={{
          marginTop: 12, padding: 12,
          background: C.accentSoft, border: `1px solid ${C.accent}33`,
          borderRadius: 8,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 13, color: C.accentInk }}>รวมค่าใช้จ่ายเดือนนี้</span>
          <span style={{ fontSize: 18, fontWeight: 700, color: C.accentInk, fontFamily: 'IBM Plex Sans Thai, sans-serif' }}>
            {fmtCurrency(effectiveRent + (room.water||0) + (room.elec||0) + (room.wifi||0))}
          </span>
        </div>
        {rentInfo.source === 'override' ? (
          <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
            <Btn variant="ghost" size="sm" onClick={clearRentOverride}>
              ล้างราคาพิเศษ
            </Btn>
          </div>
        ) : null}
      </div>

      {/* Tenant info — editable, allows creating new tenant for vacant rooms */}
      <TenantSection room={room} onUpdate={onUpdate} />


      {/* Notes */}
      <Textarea
        label="หมายเหตุ"
        value={room.notes}
        onChange={(v) => onUpdate({ notes: v })}
        placeholder="บันทึกข้อมูลเพิ่มเติม เช่น รายละเอียดการซ่อมบำรุง, ข้อตกลงพิเศษ"
      />
    </div>
  );
}

window.PageRooms = PageRooms;
