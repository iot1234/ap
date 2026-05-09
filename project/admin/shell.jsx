// === admin/shell.jsx ======================================================
// Sidebar (left rail) + TopBar (per-page header bar) + App (main shell)
// ใช้ window globals จากไฟล์อื่นทั้งหมด
// ===========================================================================

const { useState, useEffect, useMemo, useRef } = React;

// ---------- PageBoundary --------------------------------------------------
// Stable wrapper that delegates to window.ErrorBoundary if available, else
// just renders children. Defined at MODULE scope so React sees the same
// component type across re-renders — the previous IIFE-with-fallback-fn
// pattern was creating a new fallback function literal each parent render
// (when window.ErrorBoundary wasn't yet defined), which forced a full
// page subtree unmount/remount on every shell state change. On the
// access + meters pages this manifested as the page never settling and
// the screen appearing frozen because the load() effect kept restarting.
function PageBoundary({ pageKey, children }) {
  const B = window.ErrorBoundary;
  if (B) {
    return React.createElement(B, {
      key: pageKey,
      // Per-page friendly fallback that's GUARANTEED to be visible (high
      // contrast, fixed-size text). Defends against the "white screen + no
      // console error" symptom where a page silently returns null/empty
      // because of a Babel transpile race or a missing window global a
      // page's own guard didn't catch. The fallback also tells the operator
      // which page failed — invaluable when the bug only repros for one
      // user.
      fallback: (err, retry) => React.createElement('div', {
        style: {
          padding: 32, margin: 24, borderRadius: 12,
          background: '#fff5f4', color: '#5a1a13',
          fontFamily: 'inherit', fontSize: 14, lineHeight: 1.5,
          border: '1px solid #f0c5c0',
        },
      }, [
        React.createElement('div', { key: 'h', style: { fontSize: 18, fontWeight: 700, marginBottom: 8 } },
          `⚠ หน้า "${pageKey}" เปิดไม่สำเร็จ`),
        React.createElement('pre', {
          key: 'm',
          style: {
            margin: '8px 0 16px', padding: 12, background: '#fff',
            borderRadius: 6, fontSize: 12, overflow: 'auto', maxHeight: 200,
            fontFamily: 'JetBrains Mono, Menlo, monospace',
          },
        }, String((err && err.message) || err || 'unknown error')),
        React.createElement('button', {
          key: 'b',
          onClick: () => { try { retry(); } catch {} },
          style: {
            padding: '8px 16px', borderRadius: 8, border: '1px solid #c46a3e',
            background: '#c46a3e', color: '#fff', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 13.5, fontWeight: 600,
          },
        }, 'ลองใหม่'),
      ]),
    }, children);
  }
  // No ErrorBoundary loaded yet — render children with a stable wrapping div
  // (also keyed) so React still resets the subtree on page change.
  return React.createElement('div', { key: pageKey }, children);
}

// ---------- Navigation config ---------------------------------------------
// Groups are organised by user task, not by feature. Each item can declare
// `minRole` — the sidebar hides it if the current user's role is below.
// ROLE_RANK: owner > manager > staff > readonly.
const ROLE_RANK = { owner: 4, manager: 3, staff: 2, readonly: 1 };
const NAV_GROUPS = [
  {
    title: 'ภาพรวม',
    items: [
      { id: 'overview', label: 'แดชบอร์ด', icon: '◫' },
    ],
  },
  {
    title: 'ห้องพัก & ผู้เช่า',
    items: [
      { id: 'rooms',         label: 'ห้องพัก',     icon: '🏠' },
      { id: 'tenants',       label: 'ผู้เช่า',     icon: '👥' },
      { id: 'bookings',      label: 'การจอง',      icon: '📋' },
      { id: 'contracts',     label: 'สัญญา',      icon: '📜', minRole: 'manager' },
      { id: 'line-bindings', label: 'ผูกห้อง ↔ LINE', icon: '🔗', minRole: 'manager' },
      { id: 'line-oas',      label: 'จัดการ LINE OA', icon: '💬', minRole: 'manager' },
    ],
  },
  {
    title: 'การเงิน',
    items: [
      { id: 'billing',     label: 'บิล/ใบแจ้งหนี้',  icon: '🧾' },
      { id: 'payments',    label: 'สลิป/การชำระ',    icon: '💳' },
      { id: 'pricing',     label: 'ตั้งราคา',         icon: '💰', minRole: 'manager' },
      { id: 'recurring',   label: 'ค่าใช้จ่ายประจำ',  icon: '💸', minRole: 'manager' },
      { id: 'reports',     label: 'รายงาน · กราฟ',    icon: '📊' },
      { id: 'reports-v2',  label: 'รายงาน · ตาราง',   icon: '📈', minRole: 'manager' },
    ],
  },
  {
    title: 'บริการ',
    items: [
      { id: 'maintenance',     label: 'แจ้งซ่อม',          icon: '🛠' },
      { id: 'meters',          label: 'มิเตอร์',           icon: '⚡' },
      { id: 'access',          label: 'เข้า-ออก',          icon: '🔑', minRole: 'manager' },
      { id: 'access-devices',  label: 'Hardware tokens', icon: '📡', minRole: 'owner' },
    ],
  },
  {
    title: 'ระบบ',
    items: [
      { id: 'health',              label: 'สถานะระบบ',           icon: '🩺', minRole: 'manager' },
      { id: 'production-readiness', label: 'ตรวจความพร้อม',       icon: '🚦', minRole: 'owner' },
      { id: 'notifications',       label: 'ประวัติแจ้งเตือน',     icon: '🔔', minRole: 'manager' },
      { id: 'notifications-queue', label: 'คิวแจ้งเตือน',         icon: '📤', minRole: 'manager' },
      { id: 'security-events',     label: 'เหตุการณ์ปลอดภัย',    icon: '🛡️', minRole: 'manager' },
      { id: 'features',            label: 'ฟีเจอร์ระบบ',         icon: '🎛', minRole: 'owner' },
      { id: 'secrets',             label: 'ตั้งค่า API/Keys',     icon: '🔐', minRole: 'owner' },
      { id: 'settings',            label: 'ตั้งค่าระบบ',          icon: '⚙️' },
    ],
  },
];

// Returns the same NAV_GROUPS but with items hidden when the user's role
// rank is below the item's minRole.
function filterNavByRole(groups, role) {
  const have = ROLE_RANK[role] || 0;
  return groups
    .map((g) => ({
      ...g,
      items: g.items.filter((it) => !it.minRole || (ROLE_RANK[it.minRole] || 99) <= have),
    }))
    .filter((g) => g.items.length > 0);
}

const PAGE_TITLES = {
  overview:    'แดชบอร์ด',
  rooms:       'ห้องพัก',
  tenants:     'ผู้เช่า',
  bookings:    'การจอง',
  contracts:   'สัญญา',
  'line-bindings': 'ผูกห้อง ↔ LINE',
  'line-oas':      'จัดการ LINE OA',
  maintenance: 'แจ้งซ่อม',
  billing:     'บิล/ใบแจ้งหนี้',
  payments:    'สลิปชำระเงิน',
  meters:      'มิเตอร์',
  access:      'เข้า-ออก',
  notifications: 'บันทึกการแจ้งเตือน',
  'notifications-queue': 'คิวการแจ้งเตือน',
  'security-events':    'เหตุการณ์ปลอดภัย',
  'access-devices':     'Hardware API Tokens',
  reports:     'รายงาน · กราฟภาพรวม',
  'reports-v2': 'รายงาน · ตารางและส่งออก',
  pricing:     'ตั้งราคา',
  recurring:   'ค่าใช้จ่ายประจำ',
  features:    'ฟีเจอร์ระบบ',
  secrets:     'ตั้งค่า API/Keys',
  settings:    'ตั้งค่าระบบ',
  health:      'สถานะระบบ',
  'production-readiness': 'ตรวจความพร้อม Production',
};

// ---------- Sidebar -------------------------------------------------------
// Width modes:
//   - 260px (expanded, default) — full labels + section headings
//   - 64px  (collapsed) — icons only, label appears on hover via title attr
//   - mobile drawer — always 260px expanded, slides in from left
// User's choice persists in localStorage so a wide-monitor user who collapsed
// once doesn't have to re-collapse every reload.
function Sidebar({ page, setPage, mobileOpen, setMobileOpen, isMobile, pendingBookings, overdueRooms, buildingName, currentUser, collapsed, setCollapsed }) {
  const C = window.ADMIN_C;
  const shortName = (buildingName || 'บ้านกาญจน์').replace(/\s*(เรสซิเดนซ์|residence).*/i, '').trim();
  // Collapse only applies to non-mobile. Mobile drawer is always full width.
  const isCollapsed = !isMobile && collapsed;
  const railWidth = isCollapsed ? 64 : 260;

  const sidebarStyle = {
    width: railWidth,
    background: C.navBg,
    color: C.navInk,
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    height: '100vh',
    position: isMobile ? 'fixed' : 'sticky',
    top: 0,
    left: 0,
    zIndex: 100,
    transform: isMobile ? `translateX(${mobileOpen ? 0 : -260}px)` : 'none',
    transition: 'transform .25s ease, width .2s ease',
    boxShadow: isMobile ? '4px 0 24px -8px rgba(0,0,0,0.3)' : 'none',
  };

  const navItemStyle = (active) => ({
    display: 'flex',
    alignItems: 'center',
    gap: 11,
    padding: isCollapsed ? '9px 0' : '9px 14px',
    margin: '0 8px',
    borderRadius: 8,
    cursor: 'pointer',
    background: active ? C.navActive : 'transparent',
    color: active ? '#fff' : C.navInkSoft,
    fontSize: 13.5,
    fontWeight: active ? 600 : 500,
    border: 'none',
    width: 'calc(100% - 16px)',
    textAlign: isCollapsed ? 'center' : 'left',
    justifyContent: isCollapsed ? 'center' : 'flex-start',
    fontFamily: 'inherit',
    transition: 'background .15s, color .15s',
    position: 'relative',
  });

  return (
    <>
      {isMobile && mobileOpen && (
        <div
          onClick={() => setMobileOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 99,
            background: 'rgba(0,0,0,0.4)', animation: 'fadeIn .2s ease',
          }}
        />
      )}
      <aside id="admin-sidebar" style={sidebarStyle}>
        {/* Logo + collapse toggle (desktop only) */}
        <div style={{
          padding: isCollapsed ? '20px 8px 18px' : '20px 20px 18px',
          borderBottom: `1px solid ${C.navBorder}`,
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            justifyContent: isCollapsed ? 'center' : 'flex-start',
          }}>
            <div
              title={isCollapsed ? shortName : null}
              style={{
                width: 38, height: 38, borderRadius: 9,
                background: `linear-gradient(135deg, ${C.accent} 0%, ${C.accentDark} 100%)`,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                color: '#fff', fontFamily: 'Sora, sans-serif', fontWeight: 700, fontSize: 18,
                flexShrink: 0,
              }}>{(shortName[0] || 'บ').toUpperCase()}</div>
            {!isCollapsed && (
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontFamily: 'Sora, sans-serif', fontWeight: 700, fontSize: 14.5, color: '#fff', lineHeight: 1.2,
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {shortName}
                </div>
                <div style={{ fontSize: 10, color: C.navMuted, textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 2 }}>
                  Admin Console
                </div>
              </div>
            )}
            {!isMobile && (
              <button
                onClick={() => setCollapsed(!collapsed)}
                title={isCollapsed ? 'ขยายแถบเมนู' : 'ย่อแถบเมนู'}
                aria-label={isCollapsed ? 'ขยายแถบเมนู' : 'ย่อแถบเมนู'}
                style={{
                  background: 'transparent',
                  border: `1px solid ${C.navBorder}`,
                  color: C.navInkSoft,
                  width: 26, height: 26, borderRadius: 6,
                  cursor: 'pointer',
                  fontSize: 14, lineHeight: 1,
                  flexShrink: 0,
                  display: isCollapsed ? 'none' : 'inline-flex',
                  alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'inherit',
                }}>‹</button>
            )}
          </div>
          {isCollapsed && !isMobile && (
            <button
              onClick={() => setCollapsed(false)}
              title="ขยายแถบเมนู"
              aria-label="ขยายแถบเมนู"
              style={{
                marginTop: 10,
                background: 'transparent',
                border: `1px solid ${C.navBorder}`,
                color: C.navInkSoft,
                width: '100%', height: 26, borderRadius: 6,
                cursor: 'pointer',
                fontSize: 14, lineHeight: 1,
                display: 'inline-flex',
                alignItems: 'center', justifyContent: 'center',
                fontFamily: 'inherit',
              }}>›</button>
          )}
        </div>

        {/* Nav — role-aware */}
        <nav style={{ flex: 1, overflowY: 'auto', padding: '14px 0' }}>
          {filterNavByRole(NAV_GROUPS, currentUser?.role).map(group => (
            <div key={group.title} style={{ marginBottom: isCollapsed ? 8 : 18 }}>
              {!isCollapsed && (
                <div style={{
                  padding: '4px 22px', fontSize: 10.5, color: C.navMuted,
                  textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600,
                  marginBottom: 6,
                }}>{group.title}</div>
              )}
              {isCollapsed && (
                // Subtle separator between groups when label is hidden, so the
                // structure is still visible without text.
                <div style={{
                  height: 1, background: C.navBorder, margin: '6px 14px 6px',
                  opacity: 0.4,
                }} />
              )}
              {group.items.map(it => {
                const active = page === it.id;
                let badge = null;
                if (it.id === 'bookings' && pendingBookings > 0) badge = pendingBookings;
                if (it.id === 'billing'  && overdueRooms > 0)    badge = overdueRooms;
                return (
                  <button
                    key={it.id}
                    onClick={() => { setPage(it.id); if (isMobile) setMobileOpen(false); }}
                    title={isCollapsed ? it.label : null}
                    aria-label={it.label}
                    style={navItemStyle(active)}>
                    <span style={{ fontSize: 15, width: 18, textAlign: 'center', flexShrink: 0 }}>{it.icon}</span>
                    {!isCollapsed && <span style={{ flex: 1 }}>{it.label}</span>}
                    {badge != null && (
                      <span style={{
                        background: it.id === 'billing' ? C.danger : C.accent,
                        color: '#fff', fontSize: isCollapsed ? 9 : 10, fontWeight: 700,
                        padding: isCollapsed ? '0 4px' : '1px 7px',
                        borderRadius: 999,
                        minWidth: isCollapsed ? 14 : 18,
                        textAlign: 'center',
                        position: isCollapsed ? 'absolute' : 'static',
                        top: isCollapsed ? 4 : undefined,
                        right: isCollapsed ? 8 : undefined,
                      }}>{badge}</span>
                    )}
                    {active && (
                      <span style={{
                        position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)',
                        width: 3, height: 18, background: C.navAccent, borderRadius: '0 2px 2px 0',
                      }} />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div style={{
          padding: isCollapsed ? '14px 8px' : '14px 20px',
          borderTop: `1px solid ${C.navBorder}`,
          background: C.navBgAlt,
        }}>
          <a
            href="/"
            title={isCollapsed ? 'ดูในมุมผู้เช่า' : null}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: isCollapsed ? '8px 0' : '8px 10px', borderRadius: 7,
              background: 'rgba(255,255,255,0.05)',
              color: C.navInkSoft, fontSize: 12.5, fontWeight: 500,
              textDecoration: 'none', transition: 'background .15s',
              justifyContent: isCollapsed ? 'center' : 'flex-start',
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}>
            <span style={{ fontSize: 14 }}>👁</span>
            {!isCollapsed && <span style={{ flex: 1 }}>ดูในมุมผู้เช่า</span>}
            {!isCollapsed && <span style={{ color: C.navMuted, fontSize: 11 }}>→</span>}
          </a>
          <div style={{
            display: 'flex', alignItems: 'center',
            gap: 10, marginTop: 10,
            padding: isCollapsed ? '6px 0' : '6px 4px',
            justifyContent: isCollapsed ? 'center' : 'flex-start',
          }}>
            <div
              title={isCollapsed && currentUser ? `${currentUser.username} (${currentUser.role})` : null}
              style={{
                width: 32, height: 32, borderRadius: '50%',
                background: C.accent, color: '#fff',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, fontWeight: 600, flexShrink: 0,
              }}>{(currentUser && currentUser.username ? currentUser.username[0] : 'A').toUpperCase()}</div>
            {!isCollapsed && (
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12.5, color: '#fff', fontWeight: 500 }}>{currentUser ? currentUser.username : 'admin'}</div>
                <div style={{ fontSize: 10.5, color: C.navMuted }}>{currentUser ? currentUser.role : 'ผู้ดูแลระบบ'}</div>
              </div>
            )}
            <button
              onClick={() => { if (window.AP && window.AP.logout) window.AP.logout(); }}
              title="ออกจากระบบ"
              aria-label="ออกจากระบบ"
              style={{
                background: 'transparent', border: `1px solid ${C.navBorder}`,
                color: C.navInkSoft, fontSize: 11,
                padding: isCollapsed ? '4px 6px' : '4px 8px',
                borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
                display: isCollapsed ? 'none' : 'inline-block',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = '#fff'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = C.navInkSoft; }}>
              ออก
            </button>
          </div>
          {isCollapsed && (
            // Logout button as a separate row when collapsed (icon-only).
            <button
              onClick={() => { if (window.AP && window.AP.logout) window.AP.logout(); }}
              title="ออกจากระบบ"
              aria-label="ออกจากระบบ"
              style={{
                marginTop: 8, width: '100%', height: 28,
                background: 'transparent', border: `1px solid ${C.navBorder}`,
                color: C.navInkSoft, fontSize: 14,
                borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}>⏻</button>
          )}
        </div>
      </aside>
    </>
  );
}

// ---------- TopBar --------------------------------------------------------
function TopBar({ page, setPage, onMenuClick, isMobile, search, setSearch, notifCount,
                  notifItems, onNotifClick, onResetData, searchResults, onSelectResult }) {
  const C = window.ADMIN_C;
  const [showNotif, setShowNotif] = useState(false);
  const [showResults, setShowResults] = useState(false);

  return (
    <header style={{
      height: 64,
      background: C.surface,
      borderBottom: `1px solid ${C.border}`,
      display: 'flex',
      alignItems: 'center',
      padding: '0 20px',
      gap: 12,
      position: 'sticky',
      top: 0,
      zIndex: 50,
      flexShrink: 0,
    }}>
      {isMobile && (
        <button
          onClick={onMenuClick}
          aria-label="เปิดเมนูนำทาง"
          aria-expanded={false}
          aria-controls="admin-sidebar"
          style={{
            width: 36, height: 36, border: 'none', background: 'transparent',
            color: C.ink, cursor: 'pointer', fontSize: 22, padding: 0, lineHeight: 1,
          }}><span aria-hidden="true">☰</span></button>
      )}

      <div style={{ minWidth: 0, flex: '0 1 auto' }}>
        <div style={{ fontSize: 11, color: C.muted, fontWeight: 500 }}>Admin Console</div>
        <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 16, fontWeight: 600, color: C.ink, lineHeight: 1.2 }}>
          {PAGE_TITLES[page] || ''}
        </div>
      </div>

      {/* Search */}
      <div style={{
        flex: '1 1 auto', maxWidth: 380,
        marginLeft: 'auto',
        display: isMobile ? 'none' : 'flex',
        position: 'relative',
      }}>
        <div style={{
          width: '100%', display: 'flex', alignItems: 'center',
          background: C.surfaceAlt, border: `1px solid ${showResults && searchResults?.length ? C.accent : C.border}`,
          borderRadius: 9, padding: '0 12px', height: 38,
        }}>
          <span aria-hidden="true" style={{ color: C.muted, marginRight: 8, fontSize: 14 }}>🔍</span>
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setShowResults(true); }}
            onFocus={() => setShowResults(true)}
            placeholder="ค้นหาห้อง, ผู้เช่า, บิล..."
            aria-label="ค้นหาห้อง ผู้เช่า หรือบิล"
            aria-controls="admin-search-results"
            aria-expanded={!!(showResults && search)}
            style={{
              flex: 1, border: 'none', outline: 'none', background: 'transparent',
              fontSize: 13.5, color: C.ink, fontFamily: 'inherit',
            }}
          />
          {search && (
            <button
              onClick={() => { setSearch(''); setShowResults(false); }}
              aria-label="ล้างคำค้น"
              style={{ border: 'none', background: 'transparent', color: C.muted, cursor: 'pointer', fontSize: 16, padding: 4 }}><span aria-hidden="true">×</span></button>
          )}
        </div>
        {showResults && search && (
          <>
            <div onClick={() => setShowResults(false)} style={{ position: 'fixed', inset: 0, zIndex: 90 }} />
            <div id="admin-search-results" role="listbox" style={{
              position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0,
              background: C.surface, border: `1px solid ${C.border}`,
              borderRadius: 10, boxShadow: '0 12px 32px -8px rgba(30,20,10,0.18)',
              zIndex: 100, maxHeight: 440, overflow: 'auto',
            }}>
              {(searchResults || []).length === 0 ? (
                <div style={{ padding: 16, fontSize: 13, color: C.muted, textAlign: 'center' }}>
                  ไม่พบผลการค้นหาสำหรับ "{search}"
                </div>
              ) : (() => {
                // Group results by `kind` so a search hitting multiple
                // categories (e.g. tenant name + booking name) reads as
                // "Rooms (3) / Tenants (2) / Bookings (1)" instead of a
                // flat unsorted list. Order preserved within group.
                const groups = {};
                const order = [];
                for (const r of searchResults) {
                  const k = r.kind || 'อื่นๆ';
                  if (!groups[k]) { groups[k] = []; order.push(k); }
                  groups[k].push(r);
                }
                let flatIndex = 0;
                return order.map((k) => (
                  <div key={k}>
                    <div style={{
                      padding: '8px 14px 4px',
                      fontSize: 10.5, color: C.muted,
                      textTransform: 'uppercase', letterSpacing: '0.08em',
                      fontWeight: 600,
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      background: C.surfaceAlt,
                      borderTop: flatIndex === 0 ? 'none' : `1px solid ${C.borderSoft}`,
                    }}>
                      <span>{k}</span>
                      <span style={{ color: C.muted, fontWeight: 500 }}>{groups[k].length}</span>
                    </div>
                    {groups[k].map((r) => {
                      const i = flatIndex++;
                      return (
                        <button
                          key={i}
                          role="option"
                          onClick={() => { onSelectResult && onSelectResult(r); setShowResults(false); setSearch(''); }}
                          style={{
                            width: '100%', display: 'flex', gap: 10, alignItems: 'center',
                            padding: '10px 14px', border: 'none',
                            background: 'transparent', cursor: 'pointer', textAlign: 'left',
                            fontFamily: 'inherit',
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.background = C.surfaceAlt}
                          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                          <span style={{ fontSize: 14 }}>{r.icon}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 500, color: C.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</div>
                            <div style={{ fontSize: 11.5, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.subtitle}</div>
                          </div>
                          <span style={{ fontSize: 16, color: C.muted, opacity: 0.5 }}>›</span>
                        </button>
                      );
                    })}
                  </div>
                ));
              })()}
            </div>
          </>
        )}
      </div>

      {/* Notif */}
      <div style={{ position: 'relative', flexShrink: 0, marginLeft: isMobile ? 'auto' : 0 }}>
        <button
          onClick={() => setShowNotif(s => !s)}
          aria-label={notifCount > 0 ? `การแจ้งเตือน — ${notifCount} รายการใหม่` : 'การแจ้งเตือน'}
          aria-haspopup="true"
          aria-expanded={showNotif}
          style={{
            width: 38, height: 38, border: `1px solid ${C.border}`,
            background: C.surface, color: C.ink, cursor: 'pointer',
            borderRadius: 9, fontSize: 16, position: 'relative',
          }}>
          <span aria-hidden="true">🔔</span>
          {notifCount > 0 && (
            <span aria-hidden="true" style={{
              position: 'absolute', top: -4, right: -4,
              background: C.danger, color: '#fff',
              fontSize: 10, fontWeight: 700,
              padding: '1px 5px', borderRadius: 999, minWidth: 16, textAlign: 'center',
              border: `2px solid ${C.surface}`,
            }}>{notifCount}</span>
          )}
        </button>
        {showNotif && (
          <>
            <div onClick={() => setShowNotif(false)} style={{ position: 'fixed', inset: 0, zIndex: 90 }} />
            <div style={{
              position: 'absolute', top: 'calc(100% + 8px)', right: 0,
              width: 360, maxWidth: 'calc(100vw - 32px)', background: C.surface,
              border: `1px solid ${C.border}`, borderRadius: 12,
              boxShadow: '0 12px 32px -8px rgba(30,20,10,0.18)',
              zIndex: 100, overflow: 'hidden',
            }}>
              <div style={{ padding: '12px 14px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>การแจ้งเตือน</div>
                {notifCount > 0 && (
                  <span style={{ fontSize: 11, color: C.muted }}>{notifCount} รายการใหม่</span>
                )}
              </div>
              <div style={{ maxHeight: 380, overflow: 'auto' }}>
                {(notifItems || []).length === 0 ? (
                  <div style={{ padding: 32, fontSize: 13, color: C.muted, textAlign: 'center' }}>
                    ✓ ไม่มีรายการเร่งด่วน
                  </div>
                ) : (
                  notifItems.map((n, i) => (
                    <button
                      key={i}
                      onClick={() => { onNotifClick && onNotifClick(n); setShowNotif(false); }}
                      style={{
                        width: '100%', display: 'flex', gap: 10, alignItems: 'flex-start',
                        padding: '12px 14px', border: 'none',
                        borderBottom: i < notifItems.length - 1 ? `1px solid ${C.borderSoft}` : 'none',
                        background: 'transparent', cursor: 'pointer', textAlign: 'left',
                        fontFamily: 'inherit',
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = C.surfaceAlt}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                      <div style={{
                        width: 32, height: 32, borderRadius: 8,
                        background: n.kind === 'overdue' ? C.dangerSoft : C.warningSoft,
                        color: n.kind === 'overdue' ? C.danger : C.warning,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 14, flexShrink: 0,
                      }}>{n.icon}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: C.ink, lineHeight: 1.4 }}>{n.title}</div>
                        <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>{n.subtitle}</div>
                      </div>
                      <span style={{ fontSize: 14, color: C.muted, alignSelf: 'center' }}>›</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Reset-to-sample-data — destructive, hence the danger color hint.
          Was previously a generic ↻ with tooltip "รีเฟรชข้อมูลตัวอย่าง" which
          looked like an innocent refresh button — admins clicked it expecting
          to reload the page and were surprised by the destructive modal. */}
      <button
        onClick={onResetData}
        title="รีเซ็ตเป็นข้อมูลตัวอย่าง (ลบของเดิม)"
        aria-label="รีเซ็ตเป็นข้อมูลตัวอย่าง"
        style={{
          width: 38, height: 38, border: `1px solid ${C.border}`,
          background: C.surface, color: C.ink2, cursor: 'pointer',
          borderRadius: 9, fontSize: 14, flexShrink: 0,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = C.dangerSoft || '#fde2dc';
          e.currentTarget.style.color = C.danger || '#b94a48';
          e.currentTarget.style.borderColor = C.danger || '#b94a48';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = C.surface;
          e.currentTarget.style.color = C.ink2;
          e.currentTarget.style.borderColor = C.border;
        }}>♻︎</button>
    </header>
  );
}

// ---------- Main App ------------------------------------------------------
function App() {
  const C = window.ADMIN_C;
  const {
    loadRooms, saveRooms, loadConfig, saveConfig,
    loadBookings, saveBookings, loadActivities, saveActivities, resetAll,
  } = window;

  const {
    PageOverview, PageRooms, PagePricing, PageTenants,
    PageBookings, PageBilling, PageReports, PageSettings,
    Toast,
  } = window;

  // --- State (persisted to localStorage) ---
  const [rooms,      setRooms]      = useState(loadRooms);
  const [config,     setConfig]     = useState(loadConfig);
  const [bookings,   setBookings]   = useState(loadBookings);
  const [activities, setActivities] = useState(loadActivities);

  // Skip the first render's save: useEffect fires once on mount with the
  // value we JUST loaded from localStorage (which the api-client already
  // hydrated from /api/data). Without this guard, every page load triggers
  // four immediate PUTs to mirror the freshly-fetched data right back.
  const _firstSave = useRef({ rooms: true, config: true, bookings: true, activities: true });
  useEffect(() => { if (_firstSave.current.rooms)      { _firstSave.current.rooms      = false; return; } saveRooms(rooms); },           [rooms]);
  useEffect(() => { if (_firstSave.current.config)     { _firstSave.current.config     = false; return; } saveConfig(config); },         [config]);
  useEffect(() => { if (_firstSave.current.bookings)   { _firstSave.current.bookings   = false; return; } saveBookings(bookings); },     [bookings]);
  useEffect(() => { if (_firstSave.current.activities) { _firstSave.current.activities = false; return; } saveActivities(activities); }, [activities]);

  // --- Live data polling -----------------------------------------------
  // Public bookings + maintenance tickets arrive without an admin reload,
  // so poll every 30s. Both endpoints are cheap (one row each).
  // - Skip when the tab is hidden (saves bandwidth + battery).
  // - Surface 401 via toast so admin can re-login instead of seeing stale data.
  const [tickets, setTickets] = useState([]);
  useEffect(() => {
    let cancel = false;
    let warned401 = false;
    const refresh = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const [bRes, tRes] = await Promise.all([
          fetch('/api/data/baankarn_bookings_v1', { credentials: 'include' }),
          fetch('/api/maintenance', { credentials: 'include' }),
        ]);
        if (cancel) return;
        if (tRes.status === 401 && !warned401) {
          warned401 = true;
          setToast && setToast({ kind: 'error', message: 'หมดเวลาเข้าสู่ระบบ — โปรดล็อกอินใหม่' });
        }
        if (bRes.ok) {
          const bd = await bRes.json();
          if (Array.isArray(bd?.value)) {
            setBookings((prev) => {
              // Only merge in genuinely-new public-form submissions; never
              // resurrect a booking the admin removed locally. Filtering by
              // source='public-form' stops admin-edited bookings (which the
              // poll re-fetches) from being prepended as duplicates if their
              // id were ever to mismatch.
              const known = new Set(prev.map((b) => b.id));
              const additions = bd.value.filter(
                (b) => b && b.source === 'public-form' && !known.has(b.id)
              );
              return additions.length ? [...additions, ...prev] : prev;
            });
          }
        }
        if (tRes.ok) {
          warned401 = false;
          const td = await tRes.json();
          if (Array.isArray(td?.tickets)) setTickets(td.tickets);
        }
      } catch (err) {
        console.warn('[shell] live poll error:', err);
      }
    };
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => { cancel = true; clearInterval(t); };
  }, []);

  // --- Auth: load current user info for the sidebar ---
  // Auth is already enforced before this component mounts (see __bootAdmin
  // at the bottom of this file), so this just fetches the user object for
  // displaying name/role/avatar in the sidebar footer.
  const [currentUser, setCurrentUser] = useState(null);
  useEffect(() => {
    if (!window.AP || !window.AP.me) return;
    window.AP.me()
      .then((d) => { if (d && d.user) setCurrentUser(d.user); })
      .catch(() => {});
  }, []);

  // --- Routing via hash ---
  const [page, setPage] = useState(() => {
    const h = location.hash.replace('#', '');
    return PAGE_TITLES[h] ? h : 'overview';
  });
  useEffect(() => { location.hash = page; }, [page]);
  useEffect(() => {
    const onHash = () => {
      const h = location.hash.replace('#', '');
      if (PAGE_TITLES[h]) setPage(h);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // --- Viewport ---
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 900);
  useEffect(() => {
    const onR = () => setIsMobile(window.innerWidth <= 900);
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  }, []);
  const [mobileOpen, setMobileOpen] = useState(false);

  // --- Sidebar collapsed (desktop only, persisted) ---
  // Wrap localStorage calls in try/catch — Safari private mode + some embedded
  // webviews throw on access. Default to expanded on read failure.
  const SIDEBAR_KEY = '__admin_sidebar_collapsed_v1';
  const [collapsed, setCollapsedState] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_KEY) === '1'; }
    catch { return false; }
  });
  const setCollapsed = (next) => {
    setCollapsedState(next);
    try { localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0'); } catch { /* ignore */ }
  };

  // --- Toast ---
  const [toast, setToast] = useState(null);

  // --- Confirm refresh modal ---
  const [confirmRefresh, setConfirmRefresh] = useState(false);

  // --- Search (top bar) ---
  const [search, setSearch] = useState('');

  // --- Helpers passed to pages ---
  const addActivity = (act) => {
    setActivities(prev => [{ time: new Date().toISOString(), ...act }, ...prev].slice(0, 30));
  };

  // Reset-data button is a "wipe local cache + go back to seed" action that
  // makes sense during demos but is dangerous on a live deployment. Treat
  // ANY of these as a signal that real operations are happening, and disable
  // the button entirely:
  //   - ≥1 tenant in the rooms blob (admin entered real people)
  //   - ≥1 pending/active booking (real submission via /book)
  //   - ≥10 activities in the feed (real audit history accumulated)
  // Operator can still wipe via psql if they really need to.
  const hasRealData = useMemo(() => {
    const tenantCount = Object.values(rooms || {}).filter((r) => r && r.tenant).length;
    const bookingCount = (bookings || []).length;
    const activityCount = (activities || []).length;
    return tenantCount > 0 || bookingCount > 0 || activityCount >= 10;
  }, [rooms, bookings, activities]);

  const handleResetData = () => {
    if (hasRealData) {
      setToast({
        kind: 'warning',
        message: {
          title: 'ปิดปุ่มรีเซ็ตเพราะระบบมีข้อมูลจริงแล้ว',
          description: 'มีผู้เช่า/การจอง/กิจกรรมในระบบ — ลบไม่ได้จากปุ่มนี้ (ป้องกันลบบังเอิญ) ใช้ psql ถ้าจำเป็นจริง',
        },
      });
      return;
    }
    setConfirmRefresh(true);
  };
  const doResetData = () => {
    resetAll();
    location.reload();
  };

  const ADMIN_ROOM_TYPES = window.ADMIN_ROOM_TYPES;

  const pendingBookings = bookings.filter(b => b.status === 'pending').length;
  const overdueRooms = Object.values(rooms).filter(r => r.status === 'overdue');
  const overdueRoomCount = overdueRooms.length;

  // Build notification items
  const notifItems = useMemo(() => {
    const items = [];
    overdueRooms.forEach(r => {
      items.push({
        kind: 'overdue', icon: '⚠️',
        title: `ห้อง ${r.id} ค้างชำระ ${r.overdueDays} วัน`,
        subtitle: `${r.tenant?.name || ''} · ฿${(r.rent + (r.water||0) + (r.elec||0) + (r.wifi||0)).toLocaleString('th-TH')}`,
        target: { page: 'billing' },
      });
    });
    bookings.filter(b => b.status === 'pending').forEach(b => {
      items.push({
        kind: 'booking', icon: '📋',
        title: `การจองใหม่ ${b.id}`,
        subtitle: `${b.name} · ${ADMIN_ROOM_TYPES[b.wantType]?.th || b.wantType}`,
        target: { page: 'bookings' },
      });
    });
    // Open + assigned tickets surface as notifications until completed.
    (tickets || [])
      .filter((t) => t.status === 'open' || t.status === 'assigned')
      .slice(0, 10)
      .forEach((t) => {
        items.push({
          kind: 'ticket', icon: '🛠',
          title: `แจ้งซ่อม ${t.ticket_no}`,
          subtitle: `ห้อง ${t.room_id} · ${t.title}`,
          target: { page: 'maintenance' },
        });
      });
    return items;
  }, [rooms, bookings, tickets]);
  const notifCount = notifItems.length;

  // Build search results
  const searchResults = useMemo(() => {
    const q = (search || '').trim().toLowerCase();
    if (!q) return [];
    const results = [];
    // Rooms
    for (const r of Object.values(rooms)) {
      const hay = `${r.id} ${r.tenant?.name || ''} ${ADMIN_ROOM_TYPES[r.type]?.th || ''}`.toLowerCase();
      if (hay.includes(q)) {
        results.push({
          kind: 'ห้อง',
          icon: '🏠',
          title: `ห้อง ${r.id} · ${ADMIN_ROOM_TYPES[r.type]?.th}`,
          subtitle: r.tenant ? r.tenant.name : 'ห้องว่าง',
          target: { page: 'rooms' },
        });
        if (results.length >= 8) break;
      }
    }
    // Tenants
    for (const r of Object.values(rooms)) {
      if (!r.tenant) continue;
      const hay = `${r.tenant.name} ${r.tenant.phone || ''} ${r.tenant.email || ''}`.toLowerCase();
      if (hay.includes(q)) {
        results.push({
          kind: 'ผู้เช่า',
          icon: '👤',
          title: r.tenant.name,
          subtitle: `ห้อง ${r.id} · ${r.tenant.phone}`,
          target: { page: 'tenants' },
        });
        if (results.length >= 12) break;
      }
    }
    // Bookings
    for (const b of bookings) {
      const hay = `${b.id} ${b.name} ${b.phone}`.toLowerCase();
      if (hay.includes(q)) {
        results.push({
          kind: 'การจอง',
          icon: '📋',
          title: b.name,
          subtitle: `${b.id} · ${b.phone}`,
          target: { page: 'bookings' },
        });
        if (results.length >= 14) break;
      }
    }
    // Maintenance tickets
    for (const t of (tickets || [])) {
      const hay = `${t.ticket_no} ${t.title || ''} ${t.room_id || ''} ${t.tenant_name || ''}`.toLowerCase();
      if (hay.includes(q)) {
        results.push({
          kind: 'แจ้งซ่อม',
          icon: '🛠',
          title: t.ticket_no + ' · ' + (t.title || ''),
          subtitle: `ห้อง ${t.room_id} · ${t.status}`,
          target: { page: 'maintenance' },
        });
        if (results.length >= 18) break;
      }
    }
    return results.slice(0, 18);
  }, [search, rooms, bookings, tickets]);

  const handleNotifClick = (n) => { if (n?.target?.page) setPage(n.target.page); };
  const handleSelectResult = (r) => { if (r?.target?.page) setPage(r.target.page); };

  const pageProps = {
    rooms, setRooms,
    config, setConfig,
    bookings, setBookings,
    activities, setActivities, addActivity,
    setToast,
  };

  const PAGES = {
    overview:    PageOverview,
    rooms:       PageRooms,
    tenants:     PageTenants,
    bookings:    PageBookings,
    contracts:   window.PageContracts,
    'line-bindings': window.PageLineBindings,
    'line-oas':      window.PageLineOas,
    maintenance: window.PageMaintenance,
    billing:     PageBilling,
    payments:    window.PagePayments,
    meters:      window.PageMeters,
    access:      window.PageAccess,
    notifications: window.PageNotifications,
    'notifications-queue': window.PageNotificationsQueue,
    'security-events':     window.PageSecurityEvents,
    'access-devices':      window.PageAccessDevices,
    reports:     PageReports,
    'reports-v2': window.PageReportsV2,
    pricing:     PagePricing,
    recurring:   window.PageRecurringCharges,
    features:    window.PageFeatures,
    secrets:     window.PageSecrets,
    settings:    PageSettings,
    health:      window.PageHealth,
    'production-readiness': window.PageProductionReadiness,
  };
  // PAGES[page] can be undefined if (a) the route is unknown, or (b) the
  // page module hasn't loaded yet (slow CDN, blocked script). Rendering
  // <undefined /> throws "Element type is invalid" inside React, which
  // ErrorBoundary catches but presents as a generic error card. Show a
  // friendly placeholder instead so the user can navigate elsewhere.
  let Page = PAGES[page];
  // Diagnostic: log what page the shell resolved to. Helps debug "white
  // screen on menu click" by showing whether window.PageX was registered
  // at the time the click was handled. Hidden behind ?debug=1 so the
  // admin's normal console isn't spammed with one log per render.
  if (typeof console !== 'undefined' && console.log
      && typeof location !== 'undefined' && /[?&]debug=1\b/.test(location.search)) {
    console.log('[shell] page=' + page + ' resolved=' + (typeof Page === 'function' ? Page.name || 'anonymous' : '<missing>'));
  }
  if (typeof Page !== 'function') {
    Page = function MissingPage() {
      return React.createElement('div', {
        style: { padding: 32, fontSize: 14, color: C.ink2, fontFamily: 'inherit' },
      }, [
        React.createElement('div', { key: 'h', style: { fontSize: 18, fontWeight: 600, marginBottom: 8 } },
          PAGES[page] === undefined ? `หน้า "${page}" ยังโหลดไม่เสร็จ` : `ไม่พบหน้า "${page}"`),
        React.createElement('div', { key: 'd', style: { color: C.muted, marginBottom: 16 } },
          PAGES[page] === undefined
            ? 'หากเครือข่ายช้า กรุณารอ 2-3 วินาทีหรือรีเฟรชหน้า'
            : 'เลือกเมนูจากแถบด้านซ้าย'),
        React.createElement('button', {
          key: 'b',
          onClick: () => setPage('overview'),
          style: {
            padding: '8px 16px', borderRadius: 8, border: 0,
            background: C.accent, color: '#fff', cursor: 'pointer', fontFamily: 'inherit',
          },
        }, 'ไปหน้าแดชบอร์ด'),
      ]);
    };
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: C.bg }}>
      <Sidebar
        page={page}
        setPage={setPage}
        mobileOpen={mobileOpen}
        setMobileOpen={setMobileOpen}
        isMobile={isMobile}
        pendingBookings={pendingBookings}
        overdueRooms={overdueRoomCount}
        buildingName={config.building?.name}
        currentUser={currentUser}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
      />
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <TopBar
          page={page}
          setPage={setPage}
          onMenuClick={() => setMobileOpen(true)}
          isMobile={isMobile}
          search={search}
          setSearch={setSearch}
          notifCount={notifCount}
          notifItems={notifItems}
          onNotifClick={handleNotifClick}
          searchResults={searchResults}
          onSelectResult={handleSelectResult}
          onResetData={handleResetData}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Module-scoped PageBoundary keeps a stable component type so
              React never thrashes the page subtree on shell state changes. */}
          <PageBoundary pageKey={page}>
            <Page {...pageProps} />
          </PageBoundary>
        </div>
      </main>

      <Toast
        open={!!toast}
        kind={toast?.kind || 'success'}
        onClose={() => setToast(null)}
      >{toast?.message}</Toast>

      {window.Modal && (
        <window.Modal
          open={confirmRefresh}
          onClose={() => setConfirmRefresh(false)}
          title="รีเฟรชข้อมูล"
          footer={
            <>
              <window.Btn variant="ghost" onClick={() => setConfirmRefresh(false)}>ยกเลิก</window.Btn>
              <window.Btn variant="danger" onClick={doResetData}>รีเฟรชข้อมูล</window.Btn>
            </>
          }
        >
          <div style={{ fontSize: 14, color: C.ink2, lineHeight: 1.6 }}>
            ลบการเปลี่ยนแปลงทั้งหมดและกลับสู่ข้อมูลตัวอย่าง — ใช้ดูผลของฟีเจอร์ใหม่ในข้อมูลเริ่มต้น
            <div style={{ marginTop: 10, padding: 10, background: C.warningSoft, borderRadius: 8, color: C.warningInk, fontSize: 13 }}>
              ⚠️ การกระทำนี้ไม่สามารถย้อนกลับได้ — แนะนำส่งออก JSON backup ก่อน (ตั้งค่า → ระบบ)
            </div>
          </div>
        </window.Modal>
      )}
    </div>
  );
}

// ---------- Render --------------------------------------------------------
// Wait for hydration AND verify auth BEFORE mounting. Without this gate the
// admin UI would render with sensitive tenant data and only redirect to /login
// after the page already painted (visible flash + cached in browser history).
const __mount = () => {
  const root = ReactDOM.createRoot(document.getElementById('root'));
  // ErrorBoundary catches render-time exceptions in any page; OfflineBanner
  // tells the admin when network goes down so they don't trust stale data.
  const Boundary = window.ErrorBoundary || (({ children }) => children);
  const Banner = window.OfflineBanner || (() => null);
  root.render(
    <>
      <Banner />
      <Boundary>
        <App />
      </Boundary>
    </>
  );
};
const __redirectToLogin = () => { window.location.replace('/login'); };
const __bootAdmin = async () => {
  if (window.AP && window.AP.ready && typeof window.AP.ready.then === 'function') {
    try { await window.AP.ready; } catch {}
  }
  // Hard auth gate: if not authenticated, replace location with /login and
  // never mount React.
  if (window.AP && window.AP.isAuthenticated && !window.AP.isAuthenticated()) {
    __redirectToLogin();
    return;
  }
  // Belt-and-braces: re-check via /api/auth/me directly
  try {
    const me = await (window.AP && window.AP.me ? window.AP.me() : Promise.resolve({}));
    if (!me || !me.user) { __redirectToLogin(); return; }
  } catch {
    __redirectToLogin();
    return;
  }
  __mount();
};
__bootAdmin();
