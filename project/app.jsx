// === Dorm Status Dashboard — Refined ===
const { useState, useMemo, useEffect } = React;

function useViewport() {
  const [vp, setVp] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 1280,
    isMobile: typeof window !== 'undefined' ? window.innerWidth <= 900 : false,
  }));
  useEffect(() => {
    const onR = () => setVp({ w: window.innerWidth, isMobile: window.innerWidth <= 900 });
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  }, []);
  return vp;
}

const C = {
  bg: '#f3f7f4', surface: '#ffffff', surfaceAlt: '#f7faf8',
  ink: '#1e2a24', ink2: '#506156', muted: '#7b8b81',
  border: '#dfe9e2', borderSoft: '#eef4ef',
  accent: '#2f8a70', accentWarm: '#b98448', dark: '#14231d',
};

const STATUS = {
  vacant:    { th: 'ว่าง',       dot: '#2e9b6a', soft: '#e6f4ec', ink: '#0e3a25' },
  occupied:  { th: 'มีผู้เช่า',  dot: '#475569', soft: '#eef1f5', ink: '#1f2937' },
  reserved:  { th: 'จองแล้ว',    dot: '#c98a2b', soft: '#fbf1de', ink: '#5a3a0d' },
  overdue:   { th: 'ค้างชำระ',  dot: '#b54639', soft: '#f9e7e3', ink: '#5a1a13' },
  maintenance:{th: 'ปรับปรุง',  dot: '#7a6c54', soft: '#efeae0', ink: '#3a3326' },
};

// Sample-tenant list removed — public dashboard only renders tenant name +
// "occupied" presence pulled (masked) from the server. Real tenants come
// from the DB via /api/data/baankarn_rooms_v1 (server applies maskRoomsPublic
// to strip PII for unauthenticated viewers).

const ROOM_TYPES = {
  standard: { th: 'ห้องมาตรฐาน', size: 24, baseRent: 4500, beds: 1, ac: false },
  deluxe:   { th: 'ห้องดีลักซ์',  size: 28, baseRent: 5800, beds: 1, ac: true  },
  suite:    { th: 'ห้องสวีท',      size: 36, baseRent: 7500, beds: 2, ac: true  },
  studio:   { th: 'สตูดิโอพรีเมียม', size: 32, baseRent: 6800, beds: 1, ac: true },
};

// seedRand kept as a no-op-grade helper (caller still resolves the symbol)
// even though the demo room generator that used it has been retired.
function seedRand(seed) { let x = Math.sin(seed) * 10000; return x - Math.floor(x); }

// Empty 5×8 scaffold for first-run UX. The public dashboard hydrates from
// /api/data/baankarn_rooms_v1 (server is the source of truth), but having
// some rooms in initial state means the layout doesn't flash empty before
// the fetch resolves. Admins can add/remove rooms freely after — the
// derived `allFloors` below picks up whatever floors actually exist in
// the data, so floor 6, 7, …, N just work.
function buildRooms() {
  const rooms = {};
  [1,2,3,4,5].forEach((f) => {
    for (let r = 1; r <= 8; r++) {
      const id = `${f}${r.toString().padStart(2,'0')}`;
      const t = ROOM_TYPES.standard;
      rooms[id] = {
        id, floor: f, no: r, type: 'standard', status: 'vacant',
        rent: t.baseRent + (f - 1) * 200,
        tenant: null, since: null,
        deposit: (t.baseRent + (f - 1) * 200) * 2,
        water: 0, elec: 0, waterUnits: 0, elecUnits: 0, wifi: 250,
        contractEnd: null, photos: [], notes: '',
        view: f >= 3 ? 'วิวเมือง' : 'วิวสวน',
        balcony: false, lastCleaned: null,
      };
    }
  });
  return rooms;
}

// Derive the unique sorted list of floors actually present in the rooms
// blob. Replaces the previous [1,2,3,4,5] literal that stopped the public
// dashboard from showing any floor an admin added beyond 5. Returns
// floor numbers sorted ascending; callers reverse for "diagram top-down".
//
// Defensive: filters non-numeric / negative / > 99 floors so a corrupted
// rooms entry can't make the floor strip render with NaN buttons or balloon
// out to thousands of rows. Caps at 99 for sanity.
function getAllFloors(rooms) {
  if (!rooms || typeof rooms !== 'object') return [1];
  const set = new Set();
  for (const r of Object.values(rooms)) {
    const f = Number(r && r.floor);
    if (Number.isInteger(f) && f >= 1 && f <= 99) set.add(f);
  }
  if (set.size === 0) return [1];   // empty rooms → still show floor 1 stub
  return Array.from(set).sort((a, b) => a - b);
}

const fmt = (n) => n.toLocaleString('th-TH');

const ROOM_PHOTO_SETS = {
  standard: ['/assets/rooms/room-standard.jpg', '/assets/rooms/room-studio.jpg', '/assets/rooms/room-deluxe.jpg'],
  deluxe: ['/assets/rooms/room-deluxe.jpg', '/assets/rooms/room-suite.jpg', '/assets/rooms/room-standard.jpg'],
  suite: ['/assets/rooms/room-suite.jpg', '/assets/rooms/room-deluxe.jpg', '/assets/rooms/room-studio.jpg'],
  studio: ['/assets/rooms/room-studio.jpg', '/assets/rooms/room-standard.jpg', '/assets/rooms/room-suite.jpg'],
};

function getRoomType(room) {
  return ROOM_TYPES[room?.type] || ROOM_TYPES.standard;
}

function getRoomStatus(room) {
  return STATUS[room?.status] ? room.status : 'vacant';
}

function realRoomPhotos(room) {
  if (!Array.isArray(room?.photos)) return [];
  return room.photos.filter((p) => (
    typeof p === 'string' &&
    p.trim() &&
    !p.startsWith('data:')
  ));
}

function roomPhotos(room) {
  const photos = realRoomPhotos(room);
  if (photos.length) return photos;
  const set = ROOM_PHOTO_SETS[room?.type] || ROOM_PHOTO_SETS.standard;
  const offset = (Number(room?.floor) || 0) + (Number(room?.no) || 0);
  return [set[0], set[(offset % (set.length - 1)) + 1], set[((offset + 1) % (set.length - 1)) + 1]];
}

function bookingHref(room) {
  const qs = new URLSearchParams({
    roomId: room.id,
    floor: String(room.floor || ''),
    roomType: room.type || 'standard',
  });
  return `/book?${qs.toString()}`;
}

function placeholderPhoto(room, idx = 0) {
  const seed = room.floor * 100 + room.no + idx * 7;
  const hues = [28, 200, 150, 35, 12, 220];
  const h = hues[seed % hues.length];
  const lw = `hsl(${h}, 22%, 92%)`, mw = `hsl(${h}, 18%, 78%)`;
  const ac = `hsl(${h}, 35%, 55%)`, dk = `hsl(${h}, 25%, 32%)`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(`
    <svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 260'>
      <defs>
        <linearGradient id='g' x1='0' y1='0' x2='0' y2='1'>
          <stop offset='0' stop-color='${lw}'/><stop offset='1' stop-color='${mw}'/>
        </linearGradient>
        <pattern id='p' width='8' height='8' patternUnits='userSpaceOnUse'>
          <path d='M0 8L8 0' stroke='${ac}' stroke-opacity='0.08' stroke-width='1'/>
        </pattern>
      </defs>
      <rect width='400' height='260' fill='url(#g)'/>
      <rect width='400' height='260' fill='url(#p)'/>
      <rect x='0' y='200' width='400' height='60' fill='${dk}' fill-opacity='0.08'/>
      <rect x='40' y='40' width='140' height='110' fill='${lw}' stroke='${dk}' stroke-opacity='0.25' stroke-width='2'/>
      <line x1='110' y1='40' x2='110' y2='150' stroke='${dk}' stroke-opacity='0.25' stroke-width='2'/>
      <line x1='40' y1='95' x2='180' y2='95' stroke='${dk}' stroke-opacity='0.25' stroke-width='2'/>
      <rect x='220' y='110' width='150' height='70' rx='4' fill='${ac}' fill-opacity='0.35'/>
      <rect x='230' y='100' width='40' height='20' rx='3' fill='${dk}' fill-opacity='0.2'/>
      <circle cx='210' cy='80' r='10' fill='${ac}' fill-opacity='0.6'/>
      <line x1='210' y1='90' x2='210' y2='180' stroke='${dk}' stroke-opacity='0.3' stroke-width='2'/>
      <text x='20' y='245' font-family='ui-monospace, monospace' font-size='11' fill='${dk}' fill-opacity='0.55'>ROOM ${room.id} · ${getRoomType(room).th}</text>
    </svg>
  `)}`;
}

function RoomImage({ room, src, alt = '', style = {}, ...props }) {
  const fallback = placeholderPhoto(room);
  const [current, setCurrent] = useState(src || fallback);
  useEffect(() => setCurrent(src || fallback), [src, room?.id, fallback]);
  return (
    <img
      src={current}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => {
        if (current !== fallback) setCurrent(fallback);
      }}
      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', ...style }}
      {...props}
    />
  );
}

const StatusDot = ({ status, size = 8, ring = true }) => {
  const s = STATUS[status] || STATUS.vacant;
  return (
    <span style={{
      display: 'inline-block', width: size, height: size, borderRadius: '50%',
      background: s.dot, flex: 'none',
      boxShadow: ring ? `0 0 0 3px ${s.dot}22` : 'none',
    }}/>
  );
};

const StatusBadge = ({ status, compact = false }) => {
  const s = STATUS[status] || STATUS.vacant;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: compact ? '3px 8px' : '5px 10px',
      borderRadius: 999, background: s.soft, color: s.ink,
      fontSize: compact ? 11 : 12, fontWeight: 600,
    }}>
      <StatusDot status={status} size={6} ring={false}/>
      {s.th}
    </span>
  );
};

function KpiBar({ totals, isMobile, floorCount }) {
  const pct = (n) => totals.all ? Math.round((n / totals.all) * 100) : 0;
  const items = [
    { k: 'all', label: 'ห้องทั้งหมด', val: totals.all, sub: `${totals.all} ห้อง · ${floorCount} ชั้น`, color: C.ink },
    { k: 'vacant', label: 'ว่าง', val: totals.vacant, sub: `${pct(totals.vacant)}% ของทั้งหมด`, color: STATUS.vacant.dot },
    { k: 'occupied', label: 'มีผู้เช่า', val: totals.occupied, sub: `${pct(totals.occupied)}% เข้าพัก`, color: STATUS.occupied.dot },
    { k: 'overdue', label: 'ค้างชำระ', val: totals.overdue, sub: 'ต้องติดตาม', color: STATUS.overdue.dot },
  ];
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)',
      gap: 1, background: C.border, borderRadius: 12, overflow: 'hidden',
      border: `1px solid ${C.border}`,
    }}>
      {items.map(it => (
        <div key={it.k} style={{ background: C.surface, padding: isMobile ? '12px 14px' : '14px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: it.color }}/>
            <span style={{ fontSize: 11, color: C.muted, fontWeight: 600, letterSpacing: 0.4 }}>
              {it.label}
            </span>
          </div>
          <div style={{
            fontFamily: 'Sora', fontSize: isMobile ? 24 : 28,
            fontWeight: 600, color: C.ink, marginTop: 4, letterSpacing: 0,
          }}>{it.val}</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{it.sub}</div>
        </div>
      ))}
    </div>
  );
}

function BuildingDiagram({ rooms, currentFloor, onSelectFloor }) {
  // Top-down view: highest floor at the top, ground floor (lobby) at the
  // bottom. Derived from real rooms data — works for any number of floors
  // an admin has added, not just the legacy 1-5.
  const floorsDesc = getAllFloors(rooms).slice().reverse();
  return (
    <div style={{ padding: '24px 20px' }}>
      <div style={{ fontSize: 11, letterSpacing: 1.8, color: C.muted, fontWeight: 600, marginBottom: 12 }}>
        อาคาร · BUILDING A · {floorsDesc.length} ชั้น
      </div>
      <div style={{
        background: 'linear-gradient(180deg, #fbf6ec 0%, #f1e8d6 100%)',
        borderRadius: 12, padding: '12px 12px 16px', border: `1px solid ${C.border}`,
      }}>
        <div style={{ height: 14, background: C.dark, borderRadius: '6px 6px 2px 2px', marginBottom: 6 }}/>
        {floorsDesc.map(f => {
          const list = Object.values(rooms).filter(r => r.floor === f);
          const vacant = list.filter(r => r.status === 'vacant').length;
          const active = currentFloor === f;
          return (
            <button key={f} onClick={() => onSelectFloor(f)} style={{
              display: 'block', width: '100%', textAlign: 'left',
              background: active ? C.surface : 'rgba(255,255,255,0.5)',
              border: active ? `1.5px solid ${C.accent}` : `1px solid ${C.border}`,
              borderRadius: 8, padding: '10px 12px', marginBottom: 5, cursor: 'pointer',
              transition: 'all 0.15s',
              boxShadow: active ? `0 6px 18px -10px ${C.accent}66` : 'none',
              fontFamily: 'inherit',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{
                  fontFamily: 'Sora', fontWeight: 600, fontSize: 18,
                  color: active ? C.accent : C.ink,
                  width: 22, textAlign: 'center', letterSpacing: 0,
                }}>{f}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: C.ink, fontWeight: 600 }}>ชั้น {f}</div>
                  <div style={{ fontSize: 10, color: C.muted, marginTop: 1 }}>
                    ว่าง {vacant}/{list.length} ห้อง
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 1.5 }}>
                  {list.sort((a,b)=>a.no-b.no).map(r => (
                    <div key={r.id} style={{
                      width: 4, height: 14, borderRadius: 1,
                      background: STATUS[getRoomStatus(r)].dot, opacity: 0.85,
                    }}/>
                  ))}
                </div>
              </div>
            </button>
          );
        })}
        <div style={{
          height: 18, background: C.dark, borderRadius: '2px 2px 6px 6px', marginTop: 6,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 9, color: '#a89478', letterSpacing: 2.5, fontFamily: 'ui-monospace',
        }}>GROUND · ล็อบบี้</div>
      </div>

      <div style={{ marginTop: 22, display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ fontSize: 11, letterSpacing: 1.8, color: C.muted, fontWeight: 600, marginBottom: 4 }}>
          คำอธิบาย
        </div>
        {Object.entries(STATUS).map(([k, v]) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: C.ink }}>
            <StatusDot status={k} size={7} ring={false}/>
            <span>{v.th}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FloorTabs({ rooms, currentFloor, onSelectFloor }) {
  // Mobile floor strip — derive floors from data so floors 6+ become
  // tappable instead of being silently dropped. Grid columns adapt to
  // the count: ≤6 floors → equal split; >6 → fixed-width buttons that
  // overflow horizontally (mobile users get a swipe strip).
  const floors = getAllFloors(rooms);
  const tight = floors.length <= 6;
  return (
    <div style={{
      display: tight ? 'grid' : 'flex',
      gridTemplateColumns: tight ? `repeat(${Math.max(floors.length, 1)}, 1fr)` : undefined,
      overflowX: tight ? 'visible' : 'auto',
      gap: 6, padding: '10px 14px',
      background: C.surface, borderBottom: `1px solid ${C.border}`,
      WebkitOverflowScrolling: 'touch',
    }}>
      {floors.map(f => {
        const list = Object.values(rooms).filter(r => r.floor === f);
        const vacant = list.filter(r => r.status === 'vacant').length;
        const active = currentFloor === f;
        return (
          <button key={f} onClick={() => onSelectFloor(f)} style={{
            background: active ? C.dark : C.surfaceAlt,
            color: active ? C.surfaceAlt : C.ink,
            border: active ? 'none' : `1px solid ${C.border}`,
            borderRadius: 10, padding: '8px 6px', cursor: 'pointer',
            fontFamily: 'inherit', textAlign: 'center', transition: 'all 0.15s',
            // When the floor count exceeds the tight-grid threshold we
            // switch to a horizontal scroll strip; force a min-width so
            // each button stays tappable.
            minWidth: tight ? undefined : 64, flexShrink: 0,
          }}>
            <div style={{
              fontFamily: 'Sora', fontWeight: 600, fontSize: 18,
              color: active ? C.accent : C.ink, letterSpacing: 0, lineHeight: 1,
            }}>{f}</div>
            <div style={{ fontSize: 9, opacity: 0.85, marginTop: 3, fontWeight: 500 }}>
              ว่าง {vacant}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function FilterChips({ filter, setFilter, totals }) {
  const items = [
    ['all', 'ทั้งหมด', totals.all, C.ink],
    ['vacant', 'ว่าง', totals.vacant, STATUS.vacant.dot],
    ['occupied', 'มีผู้เช่า', totals.occupied, STATUS.occupied.dot],
    ['reserved', 'จอง', totals.reserved, STATUS.reserved.dot],
    ['overdue', 'ค้างชำระ', totals.overdue, STATUS.overdue.dot],
  ];
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {items.map(([k, label, val, color]) => {
        const active = filter === k;
        return (
          <button key={k} onClick={() => setFilter(k)} style={{
            background: active ? C.surface : 'transparent',
            border: active ? `1.5px solid ${color}` : `1px solid ${C.border}`,
            borderRadius: 999, padding: '6px 12px', cursor: 'pointer',
            fontSize: 12, fontFamily: 'inherit', color: C.ink,
            fontWeight: active ? 600 : 500,
            display: 'inline-flex', alignItems: 'center', gap: 6,
            transition: 'all 0.15s',
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }}/>
            {label}
            <span style={{
              background: active ? color : C.borderSoft,
              color: active ? '#fff' : C.muted,
              padding: '1px 7px', borderRadius: 999,
              fontSize: 10, fontWeight: 600, fontFamily: 'Sora',
              minWidth: 18, textAlign: 'center',
            }}>{val}</span>
          </button>
        );
      })}
    </div>
  );
}

function RoomCard({ room, selected, onClick }) {
  const t = getRoomType(room);
  const status = getRoomStatus(room);
  const photos = roomPhotos(room);
  const photoCount = realRoomPhotos(room).length;
  const rent = Number(room.rent) || t.baseRent;
  return (
    <button onClick={onClick} style={{
      background: C.surface,
      border: selected ? `2px solid ${C.accent}` : `1px solid ${C.border}`,
      borderRadius: 14, padding: 0, cursor: 'pointer',
      textAlign: 'left', overflow: 'hidden',
      boxShadow: selected ? `0 18px 34px -18px ${C.accent}88` : '0 10px 26px -24px rgba(20,35,29,0.45)',
      transition: 'all 0.15s', fontFamily: 'inherit',
      display: 'flex', flexDirection: 'column', minWidth: 0,
    }}>
      <div style={{ position: 'relative', aspectRatio: '16/10', background: C.borderSoft, overflow: 'hidden' }}>
        <RoomImage room={room} src={photos[0]} alt={`ห้อง ${room.id}`}/>
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(180deg, rgba(20,35,29,0.05) 35%, rgba(20,35,29,0.70) 100%)',
          pointerEvents: 'none',
        }}/>
        <div style={{
          position: 'absolute', top: 8, left: 8,
          background: 'rgba(255,255,255,0.95)', backdropFilter: 'blur(6px)',
          borderRadius: 6, padding: '3px 8px',
          fontFamily: 'Sora', fontWeight: 700, fontSize: 13, color: C.ink, letterSpacing: 0,
        }}>{room.id}</div>
        <div style={{ position: 'absolute', top: 8, right: 8 }}>
          <StatusBadge status={status} compact/>
        </div>
        <div style={{
          position: 'absolute', left: 10, right: 10, bottom: 9,
          display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8,
          color: '#fff',
        }}>
          <div>
            <div style={{ fontSize: 10.5, opacity: 0.82, fontWeight: 600 }}>{t.th}</div>
            <div style={{ fontFamily: 'Sora', fontSize: 17, fontWeight: 700, letterSpacing: 0 }}>
              ฿{fmt(rent)}
              <span style={{ fontSize: 10, fontWeight: 500, opacity: 0.86, marginLeft: 3 }}>/เดือน</span>
            </div>
          </div>
          <div style={{
            fontSize: 10, fontWeight: 600, padding: '3px 7px', borderRadius: 999,
            background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.28)',
            backdropFilter: 'blur(6px)', whiteSpace: 'nowrap',
          }}>{photoCount ? `${photoCount} รูป` : 'ภาพห้อง'}</div>
        </div>
      </div>
      <div style={{ padding: '10px 12px 12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
          <div style={{
            fontSize: 12, color: C.ink, fontWeight: 600,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{t.th}</div>
          <div style={{ fontSize: 10, color: C.muted, flex: 'none' }}>{t.size} ตร.ม.</div>
        </div>
        {room.tenant ? (
          <div style={{
            fontSize: 11, color: C.ink2, marginTop: 4,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{room.tenant.name}</div>
        ) : (
          <div style={{ fontSize: 11, color: STATUS.vacant.dot, marginTop: 4, fontWeight: 600 }}>
            ✓ พร้อมเข้าพัก
          </div>
        )}
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 8 }}>
          {[room.view, `${t.beds} เตียง`, t.ac ? 'แอร์' : 'พัดลม'].filter(Boolean).map((label) => (
            <span key={label} style={{
              fontSize: 10.5, color: C.ink2, background: C.surfaceAlt,
              border: `1px solid ${C.border}`, borderRadius: 999, padding: '3px 7px',
            }}>{label}</span>
          ))}
        </div>
      </div>
    </button>
  );
}

function DetailPanel({ room, onClose }) {
  const [tab, setTab] = useState('overview');

  if (!room) {
    return (
      <div style={{
        height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', color: C.muted, padding: 40, textAlign: 'center', gap: 14,
        background: C.surface,
      }}>
        <div style={{
          width: 56, height: 56, borderRadius: '50%', background: C.borderSoft,
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22,
        }}>◌</div>
        <div style={{ fontSize: 14, lineHeight: 1.6 }}>
          เลือกห้องจากผังด้านซ้าย<br/>เพื่อดูรายละเอียดและรูปภาพ
        </div>
      </div>
    );
  }

  const t = getRoomType(room);
  const status = getRoomStatus(room);
  const s = STATUS[status];
  const photos = roomPhotos(room);
  const photoCount = realRoomPhotos(room).length;
  const rent = Number(room.rent) || t.baseRent;
  const water = Number(room.water) || 0;
  const elec = Number(room.elec) || 0;
  const wifi = Number(room.wifi) || 0;
  const deposit = Number(room.deposit) || rent * 2;
  const totalMonthly = rent + water + elec + wifi;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: C.surface }}>
      <div style={{ padding: '20px 22px 14px', borderBottom: `1px solid ${C.border}`, flex: 'none' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, letterSpacing: 1.6, color: C.muted, fontWeight: 600 }}>
              ห้องเลขที่
            </div>
            <h2 style={{
              fontFamily: 'Sora', fontSize: 32, fontWeight: 600,
              color: C.ink, margin: '4px 0 4px', letterSpacing: 0,
            }}>{room.id}</h2>
            <div style={{ fontSize: 13, color: C.ink2 }}>
              {t.th} · ชั้น {room.floor} · {t.size} ตร.ม.
            </div>
          </div>
          <button onClick={onClose} style={{
            background: C.borderSoft, border: 'none', width: 30, height: 30, borderRadius: 8,
            cursor: 'pointer', color: C.ink, fontSize: 14, fontFamily: 'inherit', flex: 'none',
          }}>✕</button>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <StatusBadge status={status}/>
          <span style={{
            background: C.surfaceAlt, color: C.ink2, fontSize: 11, fontWeight: 500,
            padding: '5px 10px', borderRadius: 999,
          }}>{room.view}</span>
          <span style={{
            background: C.surfaceAlt, color: C.ink2, fontSize: 11, fontWeight: 500,
            padding: '5px 10px', borderRadius: 999,
          }}>{t.beds} เตียง · {t.ac ? 'แอร์' : 'พัดลม'}</span>
        </div>
        <a href={bookingHref(room)} style={{
          marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          height: 42, borderRadius: 10, textDecoration: 'none',
          background: status === 'vacant' ? C.accent : C.dark,
          color: '#fff', fontSize: 13, fontWeight: 700,
          boxShadow: `0 10px 24px -18px ${status === 'vacant' ? C.accent : C.dark}`,
        }}>
          <span>{status === 'vacant' ? 'จองห้องนี้' : 'สอบถามห้องนี้'}</span>
          <span aria-hidden="true">→</span>
        </a>
      </div>

      <div style={{ padding: '0 22px', borderBottom: `1px solid ${C.border}`, display: 'flex', gap: 0, flex: 'none', overflow: 'auto' }}>
        {[
          ['overview','รายละเอียด'],
          ['photos', `รูปภาพ${photoCount ? ` (${photoCount})` : ''}`],
          ['billing','ค่าใช้จ่าย'],
        ].map(([key,label]) => (
          <button key={key} onClick={() => setTab(key)} style={{
            background: 'transparent', border: 'none', padding: '12px 14px',
            cursor: 'pointer', fontSize: 13, fontFamily: 'inherit',
            color: tab === key ? C.accent : C.ink2,
            fontWeight: tab === key ? 600 : 500,
            borderBottom: tab === key ? `2px solid ${C.accent}` : '2px solid transparent',
            marginBottom: -1, whiteSpace: 'nowrap',
          }}>{label}</button>
        ))}
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '20px 22px 28px' }}>
        {tab === 'overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={{ aspectRatio: '16/9', borderRadius: 10, overflow: 'hidden', background: C.borderSoft }}>
              <RoomImage room={room} src={photos[0]} alt={`ห้อง ${room.id}`}/>
            </div>

            {room.tenant ? (
              <div style={{ background: s.soft, borderRadius: 10, padding: '14px 16px' }}>
                <div style={{ fontSize: 10, letterSpacing: 1.4, color: s.ink, opacity: 0.7, fontWeight: 600 }}>
                  ผู้เช่าปัจจุบัน
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
                  <div style={{
                    width: 38, height: 38, borderRadius: '50%', background: s.dot, color: '#fff',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: 'Sora', fontWeight: 600, fontSize: 14, flex: 'none',
                  }}>{(room.tenant.name || '?').charAt(2) || '?'}</div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{
                      fontSize: 14, color: C.ink, fontWeight: 600,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{room.tenant.name || 'มีผู้เช่า'}</div>
                    <div style={{
                      fontSize: 11, color: C.ink2, marginTop: 1,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{room.tenant.occupation || ''}</div>
                  </div>
                </div>
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12,
                  paddingTop: 12, borderTop: `1px solid ${s.dot}22`,
                }}>
                  <div>
                    <div style={{ fontSize: 10, color: C.muted, fontWeight: 600 }}>เข้าพักเมื่อ</div>
                    <div style={{ fontSize: 12, color: C.ink, marginTop: 1 }}>{room.since}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: C.muted, fontWeight: 600 }}>สิ้นสุดสัญญา</div>
                    <div style={{ fontSize: 12, color: C.ink, marginTop: 1 }}>{room.contractEnd}</div>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ background: STATUS.vacant.soft, borderRadius: 10, padding: '14px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: 8, background: STATUS.vacant.dot,
                    color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
                  }}>✓</div>
                  <div>
                    <div style={{ fontSize: 14, color: STATUS.vacant.ink, fontWeight: 600 }}>
                      ห้องว่าง · พร้อมเข้าพัก
                    </div>
                    <div style={{ fontSize: 11, color: STATUS.vacant.ink, opacity: 0.75, marginTop: 1 }}>
                      ทำความสะอาดล่าสุด · {room.lastCleaned}
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div>
              <div style={{ fontSize: 11, letterSpacing: 1.6, color: C.muted, fontWeight: 600, marginBottom: 8 }}>
                คุณสมบัติห้อง
              </div>
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1,
                background: C.border, borderRadius: 10, overflow: 'hidden',
                border: `1px solid ${C.border}`,
              }}>
                {[
                  ['ประเภท', t.th],
                  ['ขนาด', `${t.size} ตร.ม.`],
                  ['เตียง', `${t.beds} เตียง`],
                  ['แอร์', t.ac ? 'อินเวอร์เตอร์' : 'พัดลม'],
                  ['ระเบียง', room.balcony ? 'มี' : 'ไม่มี'],
                  ['วิว', room.view],
                ].map(([k,v]) => (
                  <div key={k} style={{ background: C.surface, padding: '12px 14px' }}>
                    <div style={{ fontSize: 10, color: C.muted, fontWeight: 500 }}>{k}</div>
                    <div style={{ fontSize: 13, color: C.ink, marginTop: 2, fontWeight: 500 }}>{v}</div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div style={{ fontSize: 11, letterSpacing: 1.6, color: C.muted, fontWeight: 600, marginBottom: 8 }}>
                สิ่งอำนวยความสะดวก
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {['Wi-Fi 500 Mbps','ตู้เย็น','เครื่องทำน้ำอุ่น','เตียง+ที่นอน','โต๊ะทำงาน','ตู้เสื้อผ้า', t.ac && 'แอร์', room.balcony && 'ระเบียง','ทีวี LED','CCTV ทางเดิน'].filter(Boolean).map(a => (
                  <span key={a} style={{
                    fontSize: 11, padding: '5px 10px', borderRadius: 999,
                    background: C.surfaceAlt, color: C.ink, border: `1px solid ${C.border}`,
                  }}>{a}</span>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === 'photos' && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
              {photos.map((src, i) => (
                <div key={i} style={{
                  position: 'relative', aspectRatio: '4/3',
                  borderRadius: 10, overflow: 'hidden', background: C.borderSoft,
                  border: `1px solid ${C.border}`,
                }}>
                  <RoomImage room={room} src={src} alt={`รูปห้อง ${room.id} ${i + 1}`}/>
                  {!photoCount && (
                    <div style={{
                      position: 'absolute', bottom: 6, left: 6,
                      fontSize: 10, fontFamily: 'ui-monospace', color: C.ink,
                      background: 'rgba(255,255,255,0.85)', padding: '2px 6px', borderRadius: 3,
                    }}>ตัวอย่าง</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'billing' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div>
              <div style={{ fontSize: 11, letterSpacing: 1.6, color: C.muted, fontWeight: 600, marginBottom: 8 }}>
                ค่าใช้จ่ายรายเดือน
              </div>
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
                {[
                  ['ค่าเช่าห้อง', `฿${fmt(rent)}`, 'ฐาน + พรีเมียมชั้น'],
                  ['ค่าน้ำประปา', `฿${fmt(water)}`, `${Number(room.waterUnits) || 0} หน่วย × 18 ฿`],
                  ['ค่าไฟฟ้า', `฿${fmt(elec)}`, `${Number(room.elecUnits) || 0} หน่วย × 8 ฿`],
                  ['ค่าอินเทอร์เน็ต', `฿${fmt(wifi)}`, 'Wi-Fi 500/500 Mbps'],
                ].map(([k,v,sub], i) => (
                  <div key={k} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '12px 14px', borderTop: i ? `1px solid ${C.borderSoft}` : 'none',
                  }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, color: C.ink, fontWeight: 500 }}>{k}</div>
                      <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>{sub}</div>
                    </div>
                    <div style={{ fontFamily: 'Sora', fontSize: 15, color: C.ink, fontWeight: 600 }}>{v}</div>
                  </div>
                ))}
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '14px 16px', background: C.dark, color: C.surfaceAlt,
                }}>
                  <div style={{ fontSize: 12, letterSpacing: 1.4, fontWeight: 600 }}>รวมต่อเดือน</div>
                  <div style={{ fontFamily: 'Sora', fontSize: 22, fontWeight: 600, letterSpacing: 0 }}>
                    ฿{fmt(totalMonthly)}
                  </div>
                </div>
              </div>
            </div>

            <div style={{ background: C.surfaceAlt, borderRadius: 10, padding: '14px 16px', border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 11, letterSpacing: 1.6, color: C.muted, fontWeight: 600 }}>
                ค่าใช้จ่ายแรกเข้า
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 10 }}>
                {[
                  ['เงินประกัน', deposit],
                  ['เช่าล่วงหน้า', rent],
                  ['ค่าทำสัญญา', 500],
                ].map(([k,v]) => (
                  <div key={k}>
                    <div style={{ fontSize: 10, color: C.muted }}>{k}</div>
                    <div style={{ fontFamily: 'Sora', fontSize: 15, color: C.ink, fontWeight: 600, marginTop: 2 }}>
                      ฿{fmt(v)}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{
                marginTop: 12, paddingTop: 12, borderTop: `1px dashed ${C.border}`,
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
              }}>
                <div style={{ fontSize: 12, color: C.ink, fontWeight: 600 }}>รวมแรกเข้า</div>
                <div style={{ fontFamily: 'Sora', fontSize: 18, color: C.accent, fontWeight: 600 }}>
                  ฿{fmt(deposit + rent + 500)}
                </div>
              </div>
            </div>

            <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.6 }}>
              * ค่าน้ำ-ไฟคำนวณตามการใช้งานจริง · บิลออกทุกวันที่ 1 · ชำระภายในวันที่ 5
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

function TopBar({ search, setSearch, isMobile, onMenu, roomCount, vacantCount }) {
  return (
    <div style={{
      padding: isMobile ? '10px 14px' : '14px 24px',
      borderBottom: `1px solid ${C.border}`,
      display: 'flex', alignItems: 'center', gap: 12,
      background: C.surface, flex: 'none',
    }}>
      {isMobile && (
        <button onClick={onMenu} style={{
          background: C.surfaceAlt, border: `1px solid ${C.border}`,
          borderRadius: 8, width: 36, height: 36, cursor: 'pointer',
          fontFamily: 'inherit', fontSize: 16, color: C.ink, flex: 'none',
        }}>≡</button>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none' }}>
        <div style={{
          width: 34, height: 34, borderRadius: 8, background: C.dark,
          color: C.surfaceAlt, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'Sora', fontWeight: 700, fontSize: 14, letterSpacing: 0,
        }}>บก</div>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontFamily: 'Sora', fontSize: isMobile ? 14 : 15,
            color: C.ink, fontWeight: 600, letterSpacing: 0, lineHeight: 1.2,
          }}>บ้านกาญจน์ เรสซิเดนซ์</div>
          {!isMobile && (
            <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>
              ห้องพักอพาร์ตเมนต์ · {roomCount} ห้อง · ว่าง {vacantCount}
            </div>
          )}
        </div>
      </div>

      <div style={{ flex: 1 }}/>

      {!isMobile && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 8,
          padding: '7px 12px', minWidth: 0, width: 280,
        }}>
          <span style={{ color: C.muted, fontSize: 13 }}>⌕</span>
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="ค้นหาห้อง / ผู้เช่า..."
            style={{
              flex: 1, border: 'none', background: 'transparent', outline: 'none',
              fontFamily: 'inherit', fontSize: 13, color: C.ink, minWidth: 0,
            }}/>
        </div>
      )}

      <a
        href="/maintenance"
        title="แจ้งซ่อม"
        style={{
          display: isMobile ? 'none' : 'inline-flex', alignItems: 'center', gap: 6,
          padding: isMobile ? '0 10px' : '0 14px', height: 36,
          background: C.surface, color: C.ink2,
          border: `1px solid ${C.border}`, borderRadius: 8,
          fontFamily: 'inherit', fontSize: 12.5, fontWeight: 500,
          textDecoration: 'none', cursor: 'pointer', flex: 'none',
          transition: 'background .15s',
        }}
        onMouseEnter={(e) => e.currentTarget.style.background = C.surfaceAlt}
        onMouseLeave={(e) => e.currentTarget.style.background = C.surface}>
        <span style={{ fontSize: 13 }}>🛠</span>
        {!isMobile && <span>แจ้งซ่อม</span>}
      </a>

      <a
        href="/book"
        title="จองห้องพัก"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: isMobile ? '0 10px' : '0 14px', height: 36,
          background: C.accent, color: '#fff',
          border: 'none', borderRadius: 8,
          fontFamily: 'inherit', fontSize: 12.5, fontWeight: 500,
          textDecoration: 'none', cursor: 'pointer', flex: 'none',
          transition: 'background .15s',
        }}
        onMouseEnter={(e) => e.currentTarget.style.background = '#24715c'}
        onMouseLeave={(e) => e.currentTarget.style.background = C.accent}>
        <span style={{ fontSize: 13 }}>📋</span>
        {!isMobile && <span>จองห้อง</span>}
      </a>

      <a
        href="/admin"
        title="หลังบ้าน Admin"
        style={{
          display: isMobile ? 'none' : 'inline-flex', alignItems: 'center', gap: 6,
          padding: isMobile ? '0 10px' : '0 14px', height: 36,
          background: C.dark, color: '#fff',
          border: 'none', borderRadius: 8,
          fontFamily: 'inherit', fontSize: 12.5, fontWeight: 500,
          textDecoration: 'none', cursor: 'pointer', flex: 'none',
          transition: 'background .15s',
        }}
        onMouseEnter={(e) => e.currentTarget.style.background = '#0d1914'}
        onMouseLeave={(e) => e.currentTarget.style.background = C.dark}>
        <span style={{ fontSize: 13 }}>🛡</span>
        {!isMobile && <span>Admin</span>}
      </a>
    </div>
  );
}

function App() {
  // ตอน mount ลองอ่านห้องจาก localStorage (ที่หลังบ้าน admin บันทึกไว้)
  // ถ้าไม่มีให้สร้างใหม่จาก buildRooms()
  const [rooms] = useState(() => {
    try {
      const raw = localStorage.getItem('baankarn_rooms_v1');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
          return parsed;
        }
      }
    } catch (e) {}
    return buildRooms();
  });
  // Initial floor: pick the middle floor of whatever floors actually exist
  // so the user lands on a populated view, not on a hardcoded "3" that may
  // not exist in this building (e.g. admin running a 7-floor or 2-floor
  // configuration). Falls back to floor 1 for an empty-rooms first paint.
  const [floor, setFloor] = useState(() => {
    const fs = getAllFloors(rooms);
    return fs[Math.floor(fs.length / 2)] || 1;
  });
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Self-heal: if the currently-viewed floor has no rooms (admin deleted
  // every room there, or rooms were hydrated from server with a different
  // shape than the localStorage seed), auto-jump to a floor that does.
  // Without this the user gets stuck on an empty floor with no rooms to
  // click — the BuildingDiagram won't even highlight the active row.
  useEffect(() => {
    const fs = getAllFloors(rooms);
    if (fs.length === 0) return;     // building is empty — nothing to do
    if (!fs.includes(floor)) {
      // Pick the closest floor above the current one; if none, the closest below.
      const above = fs.find((f) => f >= floor);
      const below = fs.slice().reverse().find((f) => f <= floor);
      setFloor(above ?? below ?? fs[0]);
    }
  }, [rooms, floor]);

  // ESC key dismisses the mobile detail bottom-sheet — keyboard accessibility.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (mobileDetailOpen) setMobileDetailOpen(false);
        else if (mobileMenuOpen) setMobileMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileDetailOpen, mobileMenuOpen]);

  const { isMobile, w: viewportWidth } = useViewport();

  const totals = useMemo(() => {
    const all = Object.values(rooms);
    return {
      all: all.length,
      vacant: all.filter(r => r.status === 'vacant').length,
      occupied: all.filter(r => r.status === 'occupied').length,
      reserved: all.filter(r => r.status === 'reserved').length,
      overdue: all.filter(r => r.status === 'overdue').length,
    };
  }, [rooms]);
  const floorCount = useMemo(() => getAllFloors(rooms).length, [rooms]);

  const floorRooms = useMemo(() => {
    let list = Object.values(rooms).filter(r => r.floor === floor);
    if (filter !== 'all') list = list.filter(r => r.status === filter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(r =>
        r.id.includes(q) ||
        (r.tenant?.name?.toLowerCase?.().includes(q)) ||
        getRoomType(r).th.includes(q)
      );
    }
    return list.sort((a,b) => a.no - b.no);
  }, [rooms, floor, filter, search]);

  const allFloorRooms = Object.values(rooms).filter(r => r.floor === floor).sort((a,b)=>a.no-b.no);
  const floorVacant = allFloorRooms.filter(r => r.status === 'vacant').length;
  const selected = rooms[selectedId];

  function selectRoom(id) {
    setSelectedId(id);
    const r = rooms[id];
    if (r && r.floor !== floor) setFloor(r.floor);
    if (isMobile) setMobileDetailOpen(true);
  }

  const mainContent = (
    <div style={{
      flex: 1, overflow: 'auto', background: C.bg,
      padding: isMobile ? '14px 14px 28px' : '20px 24px 32px',
    }} data-screen-label={`Floor ${floor}`}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 16, marginBottom: 14,
      }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 1.8, color: C.muted, fontWeight: 600 }}>
            FLOOR {floor.toString().padStart(2,'0')}
          </div>
          <h1 style={{
            fontFamily: 'Sora', fontSize: isMobile ? 24 : 30,
            fontWeight: 600, margin: '2px 0 0', color: C.ink, letterSpacing: 0,
          }}>
            ชั้น {floor}
            <span style={{
              fontSize: isMobile ? 12 : 14, color: C.muted,
              fontWeight: 400, marginLeft: 10,
            }}>
              {/* Tier label derives from this floor's RANK among all floors
                  (top floor = penthouse, second-from-top = premium, others
                  standard) so adding floor 6 / 7 / N still gets the right
                  label without hardcoded "floor === 5" branches. */}
              · {(() => {
                const all = getAllFloors(rooms);
                const max = all[all.length - 1];
                if (floor === max && all.length >= 2) return 'เพนท์เฮาส์';
                if (floor === max - 1 && all.length >= 3) return 'พรีเมียม';
                return 'มาตรฐาน';
              })()}
            </span>
          </h1>
        </div>
        <div style={{
          background: C.surface, border: `1px solid ${C.border}`,
          borderRadius: 10, padding: '8px 14px',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS.vacant.dot }}/>
          <div>
            <div style={{
              fontFamily: 'Sora', fontSize: 18, fontWeight: 600, color: C.ink,
              letterSpacing: 0, lineHeight: 1,
            }}>{floorVacant}/{allFloorRooms.length}</div>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>ห้องว่าง</div>
          </div>
        </div>
      </div>

      {!isMobile && (
        <div style={{ marginBottom: 16 }}>
          <KpiBar totals={totals} isMobile={isMobile} floorCount={floorCount}/>
        </div>
      )}

      {isMobile && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
          padding: '9px 12px', marginBottom: 12,
        }}>
          <span style={{ color: C.muted, fontSize: 13 }}>⌕</span>
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="ค้นหาห้อง..."
            style={{
              flex: 1, border: 'none', background: 'transparent', outline: 'none',
              fontFamily: 'inherit', fontSize: 13, color: C.ink, minWidth: 0,
            }}/>
        </div>
      )}

      <div style={{ marginBottom: 14 }}>
        <FilterChips filter={filter} setFilter={setFilter} totals={totals}/>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: isMobile
          ? (viewportWidth < 520 ? '1fr' : 'repeat(2, minmax(0, 1fr))')
          : 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: isMobile ? 10 : 14,
      }}>
        {floorRooms.map(r => (
          <RoomCard key={r.id} room={r} selected={selectedId === r.id}
            onClick={() => selectRoom(r.id)}/>
        ))}
      </div>

      {floorRooms.length === 0 && (
        <div style={{
          textAlign: 'center', padding: '48px 20px', color: C.muted, fontSize: 13,
          background: C.surface, borderRadius: 10, border: `1px solid ${C.border}`,
        }}>ไม่พบห้องที่ตรงกับเงื่อนไข</div>
      )}
    </div>
  );

  return (
    <div style={{
      height: '100vh', background: C.bg,
      fontFamily: '"IBM Plex Sans Thai", "Sora", system-ui, sans-serif',
      color: C.ink, display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <TopBar search={search} setSearch={setSearch} isMobile={isMobile}
        onMenu={() => setMobileMenuOpen(true)}
        roomCount={totals.all}
        vacantCount={totals.vacant}/>

      {isMobile ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <FloorTabs rooms={rooms} currentFloor={floor} onSelectFloor={setFloor}/>
          {mainContent}

          {mobileMenuOpen && (
            <div style={{
              position: 'fixed', inset: 0, zIndex: 60,
              background: 'rgba(44,36,27,0.45)', animation: 'fadeIn 0.18s ease',
            }} onClick={() => setMobileMenuOpen(false)}>
              <div onClick={(e) => e.stopPropagation()} style={{
                width: 280, height: '100%', background: C.surface,
                animation: 'slideRight 0.22s ease', overflow: 'auto',
              }}>
                <div style={{
                  padding: '14px 18px', borderBottom: `1px solid ${C.border}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}>
                  <div style={{ fontFamily: 'Sora', fontSize: 15, fontWeight: 600, color: C.ink }}>
                    ภาพรวมตึก
                  </div>
                  <button onClick={() => setMobileMenuOpen(false)} style={{
                    background: C.borderSoft, border: 'none', width: 28, height: 28, borderRadius: 6,
                    cursor: 'pointer', color: C.ink,
                  }}>✕</button>
                </div>
                <BuildingDiagram rooms={rooms} currentFloor={floor}
                  onSelectFloor={(f) => { setFloor(f); setMobileMenuOpen(false); }}/>
              </div>
            </div>
          )}

          {mobileDetailOpen && selected && (
            <div style={{
              position: 'fixed', inset: 0, zIndex: 50,
              background: 'rgba(44,36,27,0.45)',
              display: 'flex', alignItems: 'flex-end',
              animation: 'fadeIn 0.18s ease',
            }} onClick={() => setMobileDetailOpen(false)}>
              <div onClick={(e) => e.stopPropagation()} style={{
                width: '100%', height: '94vh',
                background: C.surface, borderRadius: '20px 20px 0 0',
                overflow: 'hidden', position: 'relative',
                boxShadow: '0 -10px 40px rgba(0,0,0,0.2)',
                animation: 'slideUp 0.22s ease',
                display: 'flex', flexDirection: 'column',
              }}>
                <div style={{
                  position: 'absolute', top: 6, left: '50%',
                  transform: 'translateX(-50%)',
                  width: 36, height: 4, borderRadius: 2,
                  background: '#d9cdb5', zIndex: 2,
                }}/>
                <div style={{ paddingTop: 10, flex: 1, overflow: 'hidden', display: 'flex' }}>
                  <DetailPanel room={selected}
                    onClose={() => setMobileDetailOpen(false)}/>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div style={{
          flex: 1, display: 'grid',
          gridTemplateColumns: '260px minmax(0, 1fr) 420px',
          overflow: 'hidden',
        }}>
          <div style={{ borderRight: `1px solid ${C.border}`, overflow: 'auto', background: C.surface }}>
            <BuildingDiagram rooms={rooms} currentFloor={floor} onSelectFloor={setFloor}/>
          </div>
          {mainContent}
          <div style={{ borderLeft: `1px solid ${C.border}`, overflow: 'hidden' }}>
            <DetailPanel room={selected}
              onClose={() => setSelectedId(null)}/>
          </div>
        </div>
      )}

    </div>
  );
}

// Wait for API hydration (if api-client.js loaded) before mounting so the
// tenant view reflects what's stored in the database.
const __mountTenant = () => ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
if (window.AP && window.AP.ready && typeof window.AP.ready.then === 'function') {
  window.AP.ready.then(__mountTenant).catch(__mountTenant);
} else {
  __mountTenant();
}
