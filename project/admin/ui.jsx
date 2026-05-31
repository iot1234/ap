// === admin/ui.jsx =========================================================
// UI primitives ใช้ร่วมกันทุกหน้า: Card, Btn, Input, Select, Toggle, Tabs,
// Drawer, Modal, Table, KpiCard, Charts, EmptyState, Avatar, Badge, etc.
// ===========================================================================

const { useState, useEffect, useRef, useMemo, useId } = React;
const C = window.ADMIN_C;
const ADMIN_STATUS = window.ADMIN_STATUS;
const fmt = window.fmt;
const fmtCurrency = window.fmtCurrency;

// --- Card -----------------------------------------------------------------
function Card({ children, padding = 24, style = {}, hover = false, onClick, className = '' }) {
  const [hov, setHov] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => hover && setHov(true)}
      onMouseLeave={() => hover && setHov(false)}
      className={className}
      style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 14,
        padding,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'box-shadow .18s, transform .18s, border-color .18s',
        boxShadow: hov ? '0 8px 28px -16px rgba(60,40,20,0.18)' : '0 1px 0 rgba(60,40,20,0.02)',
        borderColor: hov ? C.borderStrong : C.border,
        ...style,
      }}>
      {children}
    </div>
  );
}

// --- SectionHeading -------------------------------------------------------
function SectionHeading({ title, subtitle, action, level = 2, style = {} }) {
  const Tag = `h${level}`;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 16, ...style }}>
      <div>
        <Tag style={{ margin: 0, fontFamily: 'IBM Plex Sans Thai, sans-serif', fontWeight: 600, color: C.ink, fontSize: level === 2 ? 22 : (level === 3 ? 17 : 15), lineHeight: 1.2 }}>
          {title}
        </Tag>
        {subtitle && <div style={{ fontSize: 13, color: C.muted, marginTop: 4 }}>{subtitle}</div>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}

// --- Btn ------------------------------------------------------------------
// Btn variants — 8 distinct visual treatments mapped to common admin intents:
//   primary    Dark, high-contrast confirm action ("Save", "Approve")
//   accent     Blue accent, used for navigation / "Open" / sub-confirms
//   secondary  White on border, neutral support action ("Cancel", "Edit")
//   ghost      Transparent, low-emphasis ("More", "Back")
//   soft       Light-tinted, casual action ("Filter", "Export")
//   danger     Red, destructive ("Delete", "Void")
//   success    Green, positive confirm ("Mark paid")
//   warning    Amber, caution ("Force generate", "Bypass check")
//
// `tone` (optional, overrides variant when set) — uses the categorical
// palette from shared.jsx#TONES so a "ออกบิล" button on the finance page
// can take tone='finance' and inherit the emerald color without picking
// the wrong-flavored variant. Useful for primary actions inside a
// category page (PageHeader's color rail color matches Btn's tone color).
function Btn({ children, variant = 'primary', tone, size = 'md', icon, iconRight, onClick, disabled, type = 'button', style = {}, fullWidth = false, danger = false }) {
  const base = {
    sm: { padding: '6px 12px',  fontSize: 12.5, height: 30, gap: 6  },
    md: { padding: '9px 16px',  fontSize: 13.5, height: 38, gap: 8  },
    lg: { padding: '12px 22px', fontSize: 15,   height: 46, gap: 10 },
  }[size] || { padding: '9px 16px', fontSize: 13.5, height: 38, gap: 8 };

  const variants = {
    primary:   { background: danger ? C.danger : C.dark, color: '#fff', border: '1px solid transparent' },
    accent:    { background: C.accent,                   color: '#fff', border: '1px solid transparent' },
    secondary: { background: C.surface,                  color: C.ink,  border: `1px solid ${C.border}` },
    ghost:     { background: 'transparent',              color: C.ink2, border: '1px solid transparent' },
    soft:      { background: C.accentSoft,               color: C.accentInk, border: `1px solid ${C.accentSoft}` },
    danger:    { background: C.danger,                   color: '#fff', border: '1px solid transparent' },
    success:   { background: C.success,                  color: '#fff', border: '1px solid transparent' },
    warning:   { background: C.warning,                  color: '#fff', border: '1px solid transparent' },
  };
  let v = variants[variant] || variants.primary;

  // tone override — for category-specific primary actions. Picks the
  // category color from window.TONES (rooms = blue, finance = emerald,
  // service = amber, system = violet, overview = slate).
  const T = window.TONES;
  if (tone && T && T[tone]) {
    const t = T[tone];
    if (variant === 'soft') {
      v = { background: t.soft, color: t.color, border: `1px solid ${t.color}33` };
    } else {
      v = { background: t.color, color: '#fff', border: '1px solid transparent' };
    }
  }

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      data-variant={variant}
      data-tone={tone || undefined}
      style={{
        ...v,
        ...base,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 10,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontWeight: 500,
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
        width: fullWidth ? '100%' : 'auto',
        transition: 'background .15s, transform .08s, border-color .15s, box-shadow .15s, filter .15s',
        ...style,
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        // Filter brightness shift gives every variant a consistent hover
        // feel; darker variants brighten slightly, lighter ones darken.
        e.currentTarget.style.filter = 'brightness(0.95)';
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        e.currentTarget.style.filter = '';
      }}>
      {icon && <span style={{ display: 'inline-flex', alignItems: 'center', fontSize: base.fontSize + 1 }}>{icon}</span>}
      {children}
      {iconRight && <span style={{ display: 'inline-flex', alignItems: 'center' }}>{iconRight}</span>}
    </button>
  );
}

// --- IconBtn (small square, icon-only) -----------------------------------
// Hover/active states tinted with the rooms tone (blue) by default; pages
// can pass tone='finance'|'service'|'system' for tonal grouping. `danger`
// flag overrides everything for destructive actions (delete, void, etc.).
function IconBtn({ icon, onClick, label, active, danger, tone, disabled }) {
  const T = window.TONES;
  const t = (tone && T && T[tone]) ? T[tone] : { color: '#2563EB', soft: '#E8F0FE' };
  const baseColor = danger ? '#DC2626' : (active ? t.color : C.ink2);
  const baseBg = danger ? '#FCE7E7' : (active ? t.soft : 'transparent');
  const baseBorder = danger ? '#DC2626' : (active ? t.color : C.borderSoft);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      style={{
        width: 36, height: 36,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: baseBg,
        color: baseColor,
        border: `1px solid ${baseBorder}`,
        borderRadius: 9,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontSize: 15,
        transition: 'background .15s, border-color .15s, color .15s, filter .15s',
        fontFamily: 'inherit',
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        if (!active && !danger) {
          e.currentTarget.style.background = t.soft;
          e.currentTarget.style.borderColor = `${t.color}66`;
          e.currentTarget.style.color = t.color;
        } else {
          e.currentTarget.style.filter = 'brightness(0.95)';
        }
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = baseBg;
        e.currentTarget.style.borderColor = baseBorder;
        e.currentTarget.style.color = baseColor;
        e.currentTarget.style.filter = '';
      }}>
      {icon}
    </button>
  );
}

// --- Input ----------------------------------------------------------------
function Input({ label, value, onChange, placeholder, type = 'text', suffix, prefix, style = {}, disabled, hint, error, fullWidth = true }) {
  const [focus, setFocus] = useState(false);
  return (
    <label style={{ display: 'block', width: fullWidth ? '100%' : 'auto' }}>
      {label && <div style={{ fontSize: 12.5, fontWeight: 500, color: C.ink2, marginBottom: 6 }}>{label}</div>}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        background: disabled ? C.surfaceMuted : C.surface,
        border: `1px solid ${error ? C.danger : (focus ? C.accent : C.border)}`,
        borderRadius: 9,
        padding: '0 12px',
        height: 40,
        boxShadow: focus ? `0 0 0 3px ${C.accent}22` : 'none',
        transition: 'box-shadow .15s, border-color .15s',
        ...style,
      }}>
        {prefix && <span style={{ color: C.muted, marginRight: 8, fontSize: 13 }}>{prefix}</span>}
        <input
          type={type}
          value={value ?? ''}
          onChange={(e) => onChange && onChange(type === 'number' ? Number(e.target.value) : e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={{
            flex: 1,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            fontSize: 14,
            color: C.ink,
            fontFamily: 'inherit',
            padding: 0,
            minWidth: 0,
          }}
        />
        {suffix && <span style={{ color: C.muted, marginLeft: 8, fontSize: 13, whiteSpace: 'nowrap' }}>{suffix}</span>}
      </div>
      {hint && !error && <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>{hint}</div>}
      {error && <div style={{ fontSize: 11.5, color: C.danger, marginTop: 4 }}>{error}</div>}
    </label>
  );
}

// --- Select ---------------------------------------------------------------
function Select({ label, value, onChange, options, placeholder, fullWidth = true, style = {} }) {
  return (
    <label style={{ display: 'block', width: fullWidth ? '100%' : 'auto' }}>
      {label && <div style={{ fontSize: 12.5, fontWeight: 500, color: C.ink2, marginBottom: 6 }}>{label}</div>}
      <select
        value={value ?? ''}
        onChange={(e) => onChange && onChange(e.target.value)}
        style={{
          width: '100%',
          height: 40,
          padding: '0 12px',
          border: `1px solid ${C.border}`,
          borderRadius: 9,
          background: C.surface,
          fontSize: 14,
          color: C.ink,
          fontFamily: 'inherit',
          outline: 'none',
          cursor: 'pointer',
          ...style,
        }}>
        {placeholder && <option value="">{placeholder}</option>}
        {options.map(o => (
          typeof o === 'string'
            ? <option key={o} value={o}>{o}</option>
            : <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

// --- Toggle ---------------------------------------------------------------
function Toggle({ label, checked, onChange, hint, disabled }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 0' }}>
      <div style={{ flex: 1 }}>
        {label && <div style={{ fontSize: 13.5, fontWeight: 500, color: C.ink }}>{label}</div>}
        {hint && <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{hint}</div>}
      </div>
      <button
        type="button"
        disabled={disabled}
        role="switch"
        aria-checked={!!checked}
        aria-label={`${label || 'toggle'}: ${checked ? 'เปิดอยู่' : 'ปิดอยู่'}`}
        title={hint || label || undefined}
        onClick={() => onChange && onChange(!checked)}
        style={{
          width: 42, height: 24,
          background: checked ? C.success : C.borderStrong,
          borderRadius: 12, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
          padding: 2, transition: 'background .18s', position: 'relative',
          opacity: disabled ? 0.5 : 1,
        }}>
        <div style={{
          width: 20, height: 20, background: '#fff', borderRadius: '50%',
          transform: `translateX(${checked ? 18 : 0}px)`,
          transition: 'transform .18s', boxShadow: '0 1px 2px rgba(0,0,0,0.2)'
        }} />
      </button>
    </div>
  );
}

// --- Textarea -------------------------------------------------------------
function Textarea({ label, value, onChange, rows = 4, placeholder, hint }) {
  const [focus, setFocus] = useState(false);
  return (
    <label style={{ display: 'block' }}>
      {label && <div style={{ fontSize: 12.5, fontWeight: 500, color: C.ink2, marginBottom: 6 }}>{label}</div>}
      <textarea
        rows={rows}
        value={value ?? ''}
        onChange={(e) => onChange && onChange(e.target.value)}
        placeholder={placeholder}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          width: '100%',
          padding: '10px 12px',
          border: `1px solid ${focus ? C.accent : C.border}`,
          borderRadius: 9,
          background: C.surface,
          fontSize: 13.5,
          color: C.ink,
          fontFamily: 'inherit',
          outline: 'none',
          resize: 'vertical',
          boxShadow: focus ? `0 0 0 3px ${C.accent}22` : 'none',
          transition: 'box-shadow .15s, border-color .15s',
        }}
      />
      {hint && <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>{hint}</div>}
    </label>
  );
}

// --- StatusDot ------------------------------------------------------------
// Status registry beyond rooms — bill/ticket/tenant/payment domains.
// StatusDot + StatusBadge look up here first, then fall through to
// ADMIN_STATUS (room statuses), then to vacant as last-resort default.
// Each entry has: th (Thai label), dot (color), soft (background), ink (text).
const EXTRA_STATUS = {
  // Bill lifecycle
  pending:      { th: 'รอชำระ',     dot: '#D97706', soft: '#FCEFDB', ink: '#78350F' },
  paid:         { th: 'ชำระแล้ว',   dot: '#059669', soft: '#E3F5EC', ink: '#064E3B' },
  void:         { th: 'ยกเลิก',     dot: '#6B7280', soft: '#F0F2F7', ink: '#1F2937' },
  // Maintenance ticket lifecycle
  open:         { th: 'เปิดใหม่',   dot: '#2563EB', soft: '#E8F0FE', ink: '#1E3A8A' },
  in_progress:  { th: 'กำลังซ่อม',  dot: '#D97706', soft: '#FCEFDB', ink: '#78350F' },
  completed:    { th: 'เสร็จสิ้น',  dot: '#059669', soft: '#E3F5EC', ink: '#064E3B' },
  cancelled:    { th: 'ยกเลิก',     dot: '#6B7280', soft: '#F0F2F7', ink: '#1F2937' },
  // Payment slip lifecycle
  verified:     { th: 'ยืนยันแล้ว', dot: '#059669', soft: '#E3F5EC', ink: '#064E3B' },
  rejected:     { th: 'ปฏิเสธ',     dot: '#DC2626', soft: '#FCE7E7', ink: '#7F1D1D' },
  // Tenant lifecycle
  active:       { th: 'ใช้งาน',     dot: '#059669', soft: '#E3F5EC', ink: '#064E3B' },
  moved_out:    { th: 'ย้ายออก',    dot: '#6B7280', soft: '#F0F2F7', ink: '#1F2937' },
  blacklist:    { th: 'แบล็คลิสต์', dot: '#DC2626', soft: '#FCE7E7', ink: '#7F1D1D' },
  blacklisted:  { th: 'แบล็คลิสต์', dot: '#DC2626', soft: '#FCE7E7', ink: '#7F1D1D' },
  // Contract lifecycle
  signed:       { th: 'เซ็นแล้ว',   dot: '#059669', soft: '#E3F5EC', ink: '#064E3B' },
  draft:        { th: 'ฉบับร่าง',   dot: '#6B7280', soft: '#F0F2F7', ink: '#1F2937' },
  ended:        { th: 'สิ้นสุด',    dot: '#6B7280', soft: '#F0F2F7', ink: '#1F2937' },
  // Notification queue
  sent:         { th: 'ส่งแล้ว',    dot: '#059669', soft: '#E3F5EC', ink: '#064E3B' },
  failed:       { th: 'ล้มเหลว',    dot: '#DC2626', soft: '#FCE7E7', ink: '#7F1D1D' },
  processing:   { th: 'กำลังส่ง',   dot: '#2563EB', soft: '#E8F0FE', ink: '#1E3A8A' },
  // Health probe severity
  ok:           { th: 'ปกติ',       dot: '#059669', soft: '#E3F5EC', ink: '#064E3B' },
  warn:         { th: 'เตือน',      dot: '#D97706', soft: '#FCEFDB', ink: '#78350F' },
  error:        { th: 'ผิดพลาด',    dot: '#DC2626', soft: '#FCE7E7', ink: '#7F1D1D' },
};

function _resolveStatus(status) {
  if (!status) return ADMIN_STATUS.vacant;
  const key = String(status).toLowerCase();
  return ADMIN_STATUS[key] || EXTRA_STATUS[key] || ADMIN_STATUS.vacant;
}

function StatusDot({ status, size = 8 }) {
  const s = _resolveStatus(status);
  return (
    <span style={{
      display: 'inline-block', width: size, height: size, borderRadius: '50%',
      background: s.dot, flexShrink: 0,
      boxShadow: `0 0 0 2px ${s.soft}`,
    }} />
  );
}

// --- StatusBadge ----------------------------------------------------------
// Pill with a status dot in front. Pass `label` to override the auto-Thai
// label (e.g., `<StatusBadge status="paid" label="จ่ายแล้ว ฿4500" />`).
function StatusBadge({ status, size = 'md', label }) {
  const s = _resolveStatus(status);
  const isSm = size === 'sm';
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: isSm ? '2px 8px' : '4px 10px',
      borderRadius: 999,
      background: s.soft,
      color: s.ink,
      fontSize: isSm ? 11 : 12,
      fontWeight: 600,
      whiteSpace: 'nowrap',
      border: `1px solid ${s.dot}1A`,    // 10% tinted border keeps badges crisp on light surface
    }}>
      <span style={{
        width: isSm ? 6 : 7, height: isSm ? 6 : 7, borderRadius: '50%',
        background: s.dot, flexShrink: 0,
      }} />
      {label || s.th}
    </span>
  );
}

// --- Pill -----------------------------------------------------------------
// Now supports 11 color keys: 6 semantic + 5 categorical (overview/rooms/
// finance/service/system) + legacy aliases (gray/accent). Same compact
// pill shape — picks bg/fg from the design palette so the page-header
// breadcrumb, sidebar dot, and inline Pill all use the same hue when
// they're describing the same category.
function Pill({ children, color = 'neutral', size = 'md', icon }) {
  const map = {
    neutral: { bg: '#F0F2F7',   fg: '#1F2937' },
    gray:    { bg: '#F0F2F7',   fg: '#1F2937' },   // legacy alias
    accent:  { bg: C.accentSoft,fg: C.accentInk },
    success: { bg: C.successSoft, fg: C.successInk },
    warning: { bg: C.warningSoft, fg: C.warningInk },
    danger:  { bg: C.dangerSoft,  fg: C.dangerInk },
    info:    { bg: C.infoSoft,    fg: C.infoInk },
    // Categorical tones — for badges that signal which admin section a
    // record belongs to (e.g., "การเงิน" pill on a finance-domain item).
    overview:{ bg: '#EEF1F5',     fg: '#1F2937' },
    rooms:   { bg: '#E8F0FE',     fg: '#1E3A8A' },
    finance: { bg: '#E3F5EC',     fg: '#064E3B' },
    service: { bg: '#FCEFDB',     fg: '#78350F' },
    system:  { bg: '#EFE7FB',     fg: '#4C1D95' },
  };
  const c = map[color] || map.neutral;
  const isSm = size === 'sm';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: isSm ? '2px 8px' : '4px 10px',
      background: c.bg, color: c.fg,
      borderRadius: 999,
      fontSize: isSm ? 11 : 12, fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {icon && <span>{icon}</span>}
      {children}
    </span>
  );
}

// --- KpiCard --------------------------------------------------------------
function KpiCard({ label, value, sub, change, color = 'neutral', icon }) {
  // Colors mapped to design palette. Each preset has a tinted left
  // border rail so admin can scan a KPI strip and see the severity
  // mix at a glance without reading the numbers.
  const colors = {
    neutral: { bg: C.surface,      border: C.border,       icon: C.ink2,    rail: C.muted },
    accent:  { bg: C.accentSoft,   border: '#C7DBFA',      icon: C.accent,  rail: C.accent },
    success: { bg: C.successSoft,  border: '#BDE5CF',      icon: C.success, rail: C.success },
    warning: { bg: C.warningSoft,  border: '#F1D6A6',      icon: C.warning, rail: C.warning },
    danger:  { bg: C.dangerSoft,   border: '#F5BEBE',      icon: C.danger,  rail: C.danger },
    info:    { bg: C.infoSoft,     border: '#C7DBFA',      icon: C.info,    rail: C.info },
    purple:  { bg: C.purpleSoft,   border: '#D6C2EF',      icon: C.purple,  rail: C.purple },
  };
  const cc = colors[color] || colors.neutral;
  const positive = change && change > 0;
  return (
    <div className="kpi-card" style={{
      background: cc.bg,
      border: `1px solid ${cc.border}`,
      borderRadius: 14,
      padding: 18,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      minWidth: 0,
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Severity color rail on the left edge — same pattern as
          PageHeader / Toast / Alert so KPI cards feel like part of
          the same visual language. */}
      <div style={{
        position: 'absolute', left: 0, top: 0, bottom: 0,
        width: 3, background: cc.rail, opacity: color === 'neutral' ? 0 : 0.85,
      }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 12.5, color: C.muted, fontWeight: 500, lineHeight: 1.3, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
        {icon && <div style={{
          width: 32, height: 32, borderRadius: 8, flexShrink: 0,
          background: 'rgba(255,255,255,0.7)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          color: cc.icon, fontSize: 16,
        }}>{icon}</div>}
      </div>
      <div className="kpi-value" style={{
        fontFamily: 'IBM Plex Sans Thai, sans-serif',
        fontSize: 26, fontWeight: 700, color: C.ink,
        lineHeight: 1.1, letterSpacing: '-0.01em',
        overflowWrap: 'break-word', wordBreak: 'break-word',
      }}>
        {value}
      </div>
      {(sub || change != null) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.muted }}>
          {change != null && (
            <span style={{
              color: positive ? C.success : C.danger,
              fontWeight: 600,
              display: 'inline-flex', alignItems: 'center', gap: 2,
            }}>
              {positive ? '▲' : '▼'} {Math.abs(change)}%
            </span>
          )}
          {sub && <span>{sub}</span>}
        </div>
      )}
    </div>
  );
}

// --- Tabs -----------------------------------------------------------------
// On narrow viewports the row of tabs would overflow horizontally and
// clip behind the page edge. Wrap in a scrollable container with
// momentum scroll + edge mask so admin can scroll the row instead of
// missing tabs. data-tabs-scroll class lets Admin Dashboard.html add
// the touch + mask styles.
function Tabs({ items, value, onChange, variant = 'underline', style = {} }) {
  if (variant === 'pills') {
    return (
      <div className="tabs-scroll" style={{
        display: 'inline-flex', gap: 4, padding: 4,
        background: C.surfaceAlt, borderRadius: 10,
        maxWidth: '100%', overflowX: 'auto',
        WebkitOverflowScrolling: 'touch',
        ...style,
      }}>
        {items.map(it => {
          const active = it.value === value;
          return (
            <button
              key={it.value}
              type="button"
              onClick={() => onChange(it.value)}
              style={{
                padding: '7px 14px',
                background: active ? C.surface : 'transparent',
                color: active ? C.ink : C.muted,
                border: 'none',
                borderRadius: 7,
                fontSize: 13,
                fontWeight: active ? 600 : 500,
                cursor: 'pointer',
                fontFamily: 'inherit',
                boxShadow: active ? '0 1px 3px rgba(60,40,20,0.08)' : 'none',
                transition: 'all .15s',
                whiteSpace: 'nowrap',
              }}>
              {it.icon && <span style={{ marginRight: 6 }}>{it.icon}</span>}
              {it.label}
              {it.count != null && (
                <span style={{
                  marginLeft: 6, padding: '1px 6px', borderRadius: 999,
                  background: active ? C.accent : C.borderSoft,
                  color: active ? '#fff' : C.muted,
                  fontSize: 10.5, fontWeight: 700,
                }}>{it.count}</span>
              )}
            </button>
          );
        })}
      </div>
    );
  }
  // Underline variant
  return (
    <div className="tabs-scroll" style={{
      display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}`,
      overflowX: 'auto', WebkitOverflowScrolling: 'touch',
      ...style,
    }}>
      {items.map(it => {
        const active = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            onClick={() => onChange(it.value)}
            style={{
              padding: '10px 14px',
              background: 'transparent',
              color: active ? C.ink : C.muted,
              border: 'none',
              borderBottom: `2px solid ${active ? C.accent : 'transparent'}`,
              fontSize: 13.5,
              fontWeight: active ? 600 : 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
              marginBottom: -1,
              transition: 'all .15s',
              whiteSpace: 'nowrap',
            }}>
            {it.icon && <span style={{ marginRight: 6 }}>{it.icon}</span>}
            {it.label}
            {it.count != null && (
              <span style={{ marginLeft: 6, color: C.muted, fontSize: 12 }}>({it.count})</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// --- Drawer (right-side slide-in) -----------------------------------------
function Drawer({ open, onClose, title, children, width = 540, footer }) {
  useEffect(() => {
    const onEsc = (e) => { if (e.key === 'Escape' && open) onClose && onClose(); };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000 }}>
      <div onClick={onClose} style={{
        position: 'absolute', inset: 0, background: 'rgba(30,20,10,0.36)',
        animation: 'fadeIn .2s ease',
      }} />
      <div style={{
        position: 'absolute', top: 0, right: 0, height: '100%',
        width: '100%', maxWidth: width, background: C.bg,
        boxShadow: '-12px 0 32px -8px rgba(30,20,10,0.18)',
        display: 'flex', flexDirection: 'column',
        animation: 'slideLeft .25s ease',
      }}>
        <div style={{
          padding: '16px 24px', borderBottom: `1px solid ${C.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: C.surface, flexShrink: 0,
        }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: C.ink, fontFamily: 'IBM Plex Sans Thai, sans-serif' }}>
            {title}
          </div>
          <button onClick={onClose} style={{
            width: 32, height: 32, border: 'none', background: 'transparent',
            color: C.muted, cursor: 'pointer', fontSize: 20, borderRadius: 8,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}>×</button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
          {children}
        </div>
        {footer && (
          <div style={{
            padding: '14px 24px', borderTop: `1px solid ${C.border}`,
            background: C.surface, flexShrink: 0,
            display: 'flex', justifyContent: 'flex-end', gap: 8,
          }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Modal ----------------------------------------------------------------
function Modal({ open, onClose, title, children, footer, width = 480 }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const onEsc = (e) => { if (e.key === 'Escape' && open) onClose && onClose(); };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [open, onClose]);
  // Focus trap: send focus into the dialog when it opens; restore to the
  // previously-focused element on close. Without this, screen-reader and
  // keyboard users get dropped back to the top of the page.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement;
    const node = dialogRef.current;
    if (node) {
      const focusable = node.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      (focusable || node).focus();
    }
    return () => { try { previouslyFocused && previouslyFocused.focus && previouslyFocused.focus(); } catch {} };
  }, [open]);
  if (!open) return null;
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1100,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, background: 'rgba(30,20,10,0.42)',
      animation: 'fadeIn .18s ease',
    }} onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.surface, borderRadius: 14, width: '100%', maxWidth: width,
          boxShadow: '0 16px 48px -8px rgba(30,20,10,0.36)',
          display: 'flex', flexDirection: 'column', maxHeight: '90vh',
          outline: 'none',
        }}>
        {title && (
          <div style={{
            padding: '16px 22px', borderBottom: `1px solid ${C.border}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <div id={titleId} style={{ fontSize: 15.5, fontWeight: 600, color: C.ink, fontFamily: 'IBM Plex Sans Thai, sans-serif' }}>{title}</div>
            <button
              onClick={onClose}
              aria-label="ปิด"
              style={{
                width: 28, height: 28, border: 'none', background: 'transparent',
                color: C.muted, cursor: 'pointer', fontSize: 18, borderRadius: 6,
              }}><span aria-hidden="true">×</span></button>
          </div>
        )}
        <div style={{ padding: 22, overflow: 'auto' }}>{children}</div>
        {footer && (
          <div style={{
            padding: '14px 22px', borderTop: `1px solid ${C.border}`,
            display: 'flex', justifyContent: 'flex-end', gap: 8,
          }}>{footer}</div>
        )}
      </div>
    </div>
  );
}

// --- DataTable ------------------------------------------------------------
function DataTable({ columns, rows, onRowClick, empty, density = 'normal', stickyHeader = true }) {
  const padding = density === 'compact' ? '8px 12px' : '12px 14px';
  // Track horizontal overflow so the wrapper can show an "→ more" affordance
  // (right-edge inset shadow) only when the table actually overflows, and
  // drop that affordance when the user has scrolled to the rightmost edge.
  // Without this, narrow viewports clip the actions column silently — admins
  // never realise there are more buttons offscreen.
  const wrapRef = React.useRef(null);
  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const sync = () => {
      const overflows = el.scrollWidth - el.clientWidth > 1;
      el.classList.toggle('scrollable', overflows);
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
      el.classList.toggle('at-end', atEnd);
    };
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    if (ro) ro.observe(el);
    window.addEventListener('resize', sync);
    return () => {
      el.removeEventListener('scroll', sync);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', sync);
    };
  }, [columns, rows]);
  return (
    <div style={{
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: 12,
      overflow: 'hidden',
      width: '100%',
      maxWidth: '100%',
    }}>
      {/* data-table-wrap CSS class adds touch momentum + a right-edge
          shadow hint that appears only when the table overflows. Inline
          styles below are the fallback for browsers without that class. */}
      <div ref={wrapRef} className="data-table-wrap" style={{
        overflow: 'auto', maxWidth: '100%',
        WebkitOverflowScrolling: 'touch',
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: columns.reduce((s,c) => s + (c.minWidth || 100), 0) }}>
          <thead>
            <tr style={{ background: C.surfaceAlt, position: stickyHeader ? 'sticky' : 'static', top: 0, zIndex: 1 }}>
              {columns.map(col => (
                <th key={col.key} style={{
                  padding,
                  textAlign: col.align || 'left',
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: C.muted,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  borderBottom: `1px solid ${C.border}`,
                  whiteSpace: 'nowrap',
                  minWidth: col.minWidth,
                  width: col.width,
                }}>{col.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} style={{ padding: 40, textAlign: 'center', color: C.muted, fontSize: 13 }}>
                  {empty || 'ไม่พบข้อมูล'}
                </td>
              </tr>
            ) : rows.map((row, i) => (
              <tr
                key={row.id || row.key || i}
                onClick={() => onRowClick && onRowClick(row, i)}
                style={{
                  cursor: onRowClick ? 'pointer' : 'default',
                  borderBottom: i === rows.length - 1 ? 'none' : `1px solid ${C.borderSoft}`,
                  transition: 'background .12s',
                }}
                onMouseEnter={(e) => onRowClick && (e.currentTarget.style.background = C.surfaceAlt)}
                onMouseLeave={(e) => onRowClick && (e.currentTarget.style.background = 'transparent')}
              >
                {columns.map(col => (
                  <td key={col.key} style={{
                    padding,
                    textAlign: col.align || 'left',
                    fontSize: 13,
                    color: C.ink,
                    verticalAlign: 'middle',
                  }}>
                    {col.render ? col.render(row) : row[col.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- EmptyState -----------------------------------------------------------
function EmptyState({ icon = '📭', title, description, action }) {
  return (
    <div style={{
      padding: '40px 24px', textAlign: 'center',
      background: C.surfaceAlt, border: `1px dashed ${C.borderStrong}`,
      borderRadius: 12,
    }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>{icon}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: C.ink, marginBottom: 6 }}>{title}</div>
      {description && <div style={{ fontSize: 13, color: C.muted, marginBottom: 16, maxWidth: 340, marginLeft: 'auto', marginRight: 'auto' }}>{description}</div>}
      {action && <div>{action}</div>}
    </div>
  );
}

// --- Avatar (initials w/ deterministic color) ----------------------------
function Avatar({ name, size = 36, color }) {
  const initials = useMemo(() => {
    if (!name) return '?';
    const parts = name.replace(/^(คุณ|นาย|นาง|นางสาว|น\.ส\.)\s*/, '').trim().split(/\s+/);
    return (parts[0]?.[0] || '') + (parts[1]?.[0] || '');
  }, [name]);
  const palette = ['#c46a3e','#3a6b8a','#7a4f8a','#2e9b6a','#c98a2b','#5b4f40','#8a4536','#456b2e'];
  const hash = useMemo(() => {
    let h = 0; for (const c of (name || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return h;
  }, [name]);
  const bg = color || palette[hash % palette.length];
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: bg, color: '#fff',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.36, fontWeight: 600, fontFamily: 'IBM Plex Sans Thai, sans-serif',
      flexShrink: 0,
      letterSpacing: '-0.02em',
    }}>{initials}</div>
  );
}

// --- SearchInput ----------------------------------------------------------
function SearchInput({ value, onChange, placeholder = 'ค้นหา...', width = 280 }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', width,
      background: C.surface, border: `1px solid ${C.border}`,
      borderRadius: 9, padding: '0 12px', height: 38,
    }}>
      <span style={{ color: C.muted, marginRight: 8, fontSize: 14 }}>🔍</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          flex: 1, border: 'none', outline: 'none', background: 'transparent',
          fontSize: 13.5, color: C.ink, fontFamily: 'inherit', padding: 0,
        }}
      />
      {value && (
        <button onClick={() => onChange('')} style={{
          border: 'none', background: 'transparent', color: C.muted,
          cursor: 'pointer', fontSize: 14, padding: 4,
        }}>×</button>
      )}
    </div>
  );
}

// --- FilterChip -----------------------------------------------------------
function FilterChip({ label, active, onClick, count, color }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '6px 12px',
        background: active ? (color || C.dark) : C.surface,
        color: active ? '#fff' : C.ink2,
        border: `1px solid ${active ? (color || C.dark) : C.border}`,
        borderRadius: 999,
        fontSize: 12.5,
        fontWeight: 500,
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
        display: 'inline-flex', alignItems: 'center', gap: 6,
        transition: 'all .15s',
      }}>
      {label}
      {count != null && (
        <span style={{
          padding: '0 6px', borderRadius: 999, fontSize: 11, fontWeight: 600,
          background: active ? 'rgba(255,255,255,0.22)' : C.borderSoft,
          color: active ? '#fff' : C.muted,
        }}>{count}</span>
      )}
    </button>
  );
}

// --- Toast (controlled) ---------------------------------------------------
// Supports two payload shapes via children:
//   - string                              → simple line
//   - { title, description?, action? }    → rich; description shows below;
//                                            action: { label, onClick }
// Kind aliases:
//   - 'error' → 'danger'  (61 callsites used 'error' historically before the
//     Toast knew the kind; without the alias they all rendered as gray info,
//     visually undistinguishable from a success message — bug found during
//     the May 2026 usability audit).
// Duration:
//   - success / info:  2.8s (default — non-blocking)
//   - warning:        4.5s
//   - danger / error: 7s   (errors deserve a longer dwell; we also add an
//                           explicit × so the user can dismiss earlier)
function Toast({ open, kind = 'success', children, onClose, duration }) {
  // Normalise legacy alias before any branching below.
  if (kind === 'error') kind = 'danger';
  const isUrgent = kind === 'danger' || kind === 'warning';
  // Resolve duration: explicit prop wins; otherwise pick by kind.
  const resolvedDuration = duration != null
    ? duration
    : (kind === 'danger' ? 7000 : kind === 'warning' ? 4500 : 2800);
  const timerRef = useRef(null);
  const startedAtRef = useRef(0);
  const remainingRef = useRef(0);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  const clearAutoDismissTimer = () => {
    if (!timerRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  const startAutoDismissTimer = (waitMs) => {
    clearAutoDismissTimer();
    if (!open || !resolvedDuration) return;
    const wait = Math.max(0, Number(waitMs) || 0);
    if (!wait) {
      closeRef.current && closeRef.current();
      return;
    }
    startedAtRef.current = Date.now();
    remainingRef.current = wait;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      remainingRef.current = 0;
      closeRef.current && closeRef.current();
    }, wait);
  };

  const pauseAutoDismiss = () => {
    if (!open || !resolvedDuration || !timerRef.current) return;
    const elapsed = Date.now() - startedAtRef.current;
    remainingRef.current = Math.max(0, remainingRef.current - elapsed);
    clearAutoDismissTimer();
  };

  const resumeAutoDismiss = () => {
    if (!open || !resolvedDuration || timerRef.current) return;
    startAutoDismissTimer(remainingRef.current > 0 ? remainingRef.current : 1);
  };

  useEffect(() => {
    remainingRef.current = resolvedDuration || 0;
    clearAutoDismissTimer();
    if (!open || !resolvedDuration) return undefined;
    startAutoDismissTimer(resolvedDuration);
    return clearAutoDismissTimer;
  }, [open, resolvedDuration, children, kind]);
  if (!open) return null;
  // Each kind gets a left-edge category color rail + matching icon,
  // mirroring the PageHeader pattern so the toast looks like it
  // belongs to the same system. Background stays high-contrast dark
  // so the message reads clearly over any page color.
  const colors = {
    success: { bg: '#064E3B', rail: '#10B981', icon: '✓' },
    danger:  { bg: '#7F1D1D', rail: '#EF4444', icon: '!' },
    warning: { bg: '#78350F', rail: '#F59E0B', icon: '⚠' },
    info:    { bg: '#1E3A8A', rail: '#3B82F6', icon: 'ℹ' },
  };
  const cc = colors[kind] || colors.info;

  // Unpack the rich-payload shape if the caller passed an object instead of
  // a plain string. Plain string keeps the simple display the existing 60+
  // callsites assume — backward-compat.
  let title = children;
  let description = null;
  let action = null;
  if (children && typeof children === 'object' && !React.isValidElement(children)) {
    title = children.title || children.message || '';
    description = children.description || null;
    action = children.action || null;
  }

  // role=status (polite) for success/info; role=alert (assertive) for danger
  // / warning so the urgency matches what screen readers announce.
  return (
    <div
      role={isUrgent ? 'alert' : 'status'}
      aria-live={isUrgent ? 'assertive' : 'polite'}
      aria-atomic="true"
      className="toast-floating"
      onMouseEnter={pauseAutoDismiss}
      onMouseLeave={resumeAutoDismiss}
      style={{
        position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
        background: cc.bg, color: '#fff',
        padding: 0,
        borderRadius: 10,
        fontSize: 13.5, fontWeight: 500,
        boxShadow: '0 16px 40px -8px rgba(11,18,32,0.55), 0 0 0 1px rgba(255,255,255,0.06) inset',
        zIndex: 1200,
        animation: 'slideUp .3s ease',
        maxWidth: 'calc(100vw - 32px)',
        minWidth: 280,
        display: 'flex', alignItems: 'stretch',
        overflow: 'hidden',
      }}>
      {/* Severity rail — same pattern as PageHeader */}
      <div style={{ width: 4, background: cc.rail, flexShrink: 0 }} />
      {/* Icon glyph in a tinted circle */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '0 6px 0 14px',
      }}>
        <span style={{
          width: 24, height: 24, borderRadius: 999,
          background: cc.rail, color: '#fff',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 700, lineHeight: 1, flexShrink: 0,
        }}>{cc.icon}</span>
      </div>
      {/* Body */}
      <div style={{
        flex: 1, minWidth: 0,
        padding: description ? '12px 14px 12px 4px' : '11px 14px 11px 4px',
        display: 'flex', alignItems: description ? 'flex-start' : 'center',
        gap: 12,
      }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ wordBreak: 'break-word' }}>{title}</div>
        {description && (
          <div style={{
            marginTop: 4,
            fontSize: 12.5, fontWeight: 400, opacity: 0.85,
            wordBreak: 'break-word',
            // Error formatters build \n-separated multi-line bodies (validation
            // field lists, bill-total drift, payment breakdown) — keep the breaks.
            whiteSpace: 'pre-line',
          }}>{description}</div>
        )}
      </div>
      {action && action.label && action.onClick && (
        <button
          onClick={() => { try { action.onClick(); } finally { onClose && onClose(); } }}
          style={{
            background: 'rgba(255,255,255,0.18)', color: '#fff',
            border: '1px solid rgba(255,255,255,0.28)', borderRadius: 7,
            fontSize: 12.5, fontWeight: 600, padding: '5px 11px',
            cursor: 'pointer', flexShrink: 0, fontFamily: 'inherit',
          }}>{action.label}</button>
      )}
      {/* Manual dismiss for urgent kinds — gives the user time to read AND
          a way to close early without waiting 7s. Less-urgent kinds rely on
          the auto-dismiss alone (they're announcements, not blockers). */}
      {isUrgent && (
        <button
          onClick={onClose}
          aria-label="ปิด"
          style={{
            background: 'transparent', color: '#fff', border: 'none',
            fontSize: 16, lineHeight: 1, padding: '0 2px 2px',
            cursor: 'pointer', opacity: 0.75, flexShrink: 0,
            fontFamily: 'inherit',
          }}
          onMouseEnter={(e) => e.currentTarget.style.opacity = 1}
          onMouseLeave={(e) => e.currentTarget.style.opacity = 0.75}>×</button>
      )}
      </div>{/* body */}
    </div>
  );
}

// --- Alert / Banner ------------------------------------------------------
// In-page notification surface (the Toast is for transient flashes; this
// is for things that should stay visible — "1 ห้องราคาผิดปกติ", "บิล 4 ใบ
// ค้างชำระ", etc.). Uses the same severity colors as Toast so the visual
// language stays consistent across the admin.
function Alert({ kind = 'info', title, children, action, onDismiss, icon, style }) {
  if (kind === 'error') kind = 'danger';
  const palettes = {
    success: { rail: '#10B981', soft: '#E3F5EC', ink: '#064E3B', icon: '✓' },
    danger:  { rail: '#EF4444', soft: '#FCE7E7', ink: '#7F1D1D', icon: '!' },
    warning: { rail: '#F59E0B', soft: '#FCEFDB', ink: '#78350F', icon: '⚠' },
    info:    { rail: '#3B82F6', soft: '#E8F0FE', ink: '#1E3A8A', icon: 'ℹ' },
  };
  const p = palettes[kind] || palettes.info;
  return (
    <div
      role={kind === 'danger' || kind === 'warning' ? 'alert' : 'status'}
      style={{
        background: p.soft, color: p.ink,
        borderRadius: 10,
        border: `1px solid ${p.rail}33`,
        padding: 0,
        display: 'flex', alignItems: 'stretch',
        overflow: 'hidden',
        ...style,
      }}>
      <div style={{ width: 4, background: p.rail, flexShrink: 0 }} />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', flex: 1, minWidth: 0 }}>
        <span style={{
          width: 22, height: 22, borderRadius: 999,
          background: p.rail, color: '#fff',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 700, lineHeight: 1, flexShrink: 0,
          marginTop: 1,
        }}>{icon || p.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          {title && (
            <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: children ? 3 : 0 }}>
              {title}
            </div>
          )}
          {children && (
            <div style={{ fontSize: 12.5, lineHeight: 1.55, opacity: 0.95 }}>{children}</div>
          )}
          {action && action.label && (
            <button
              onClick={action.onClick}
              style={{
                marginTop: 8,
                background: p.rail, color: '#fff', border: 'none',
                fontSize: 12.5, fontWeight: 600,
                padding: '6px 12px', borderRadius: 6,
                cursor: 'pointer', fontFamily: 'inherit',
              }}>{action.label}</button>
          )}
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            aria-label="ปิด"
            style={{
              background: 'transparent', border: 'none',
              color: p.ink, opacity: 0.55, fontSize: 16, lineHeight: 1,
              padding: 2, cursor: 'pointer', flexShrink: 0,
              fontFamily: 'inherit',
            }}
            onMouseEnter={(e) => e.currentTarget.style.opacity = 1}
            onMouseLeave={(e) => e.currentTarget.style.opacity = 0.55}>×</button>
        )}
      </div>
    </div>
  );
}

// --- Charts: BarChart -----------------------------------------------------
function BarChart({ data, height = 200, color, formatValue, showValues = false }) {
  const max = Math.max(...data.map(d => d.value), 1);
  const barColor = color || C.accent;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height, padding: '8px 0' }}>
      {data.map((d, i) => {
        const h = (d.value / max) * (height - 36);
        return (
          <div key={d.label || i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0, gap: 6 }}>
            {showValues && <div style={{ fontSize: 10.5, fontWeight: 600, color: C.ink2, whiteSpace: 'nowrap' }}>
              {formatValue ? formatValue(d.value) : fmt(d.value)}
            </div>}
            <div style={{
              width: '100%', height: Math.max(h, 2), maxWidth: 40,
              background: d.color || barColor,
              borderRadius: '6px 6px 2px 2px',
              transformOrigin: 'bottom',
              animation: `growBar .6s ease ${i*0.04}s both`,
              opacity: d.muted ? 0.45 : 1,
            }} />
            <div style={{ fontSize: 10.5, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
              {d.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// --- Charts: DonutChart ---------------------------------------------------
function DonutChart({ segments, size = 180, thickness = 22, centerLabel, centerValue }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = size / 2 - thickness / 2;
  const cx = size / 2, cy = size / 2;
  let cum = 0;
  const arcs = segments.map((seg, i) => {
    const startA = (cum / total) * 2 * Math.PI - Math.PI / 2;
    cum += seg.value;
    const endA = (cum / total) * 2 * Math.PI - Math.PI / 2;
    const x1 = cx + r * Math.cos(startA);
    const y1 = cy + r * Math.sin(startA);
    const x2 = cx + r * Math.cos(endA);
    const y2 = cy + r * Math.sin(endA);
    const large = endA - startA > Math.PI ? 1 : 0;
    const d = `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
    return { d, color: seg.color, key: seg.label || i };
  });
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} style={{ display: 'block' }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={C.borderSoft} strokeWidth={thickness} />
        {arcs.map(a => (
          <path key={a.key} d={a.d} fill="none" stroke={a.color}
                strokeWidth={thickness} strokeLinecap="butt" />
        ))}
      </svg>
      {(centerLabel || centerValue) && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        }}>
          {centerValue && <div style={{ fontFamily: 'IBM Plex Sans Thai, sans-serif', fontSize: 28, fontWeight: 700, color: C.ink, lineHeight: 1 }}>{centerValue}</div>}
          {centerLabel && <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{centerLabel}</div>}
        </div>
      )}
    </div>
  );
}

// --- Charts: Sparkline (line) --------------------------------------------
function Sparkline({ data, width = 120, height = 36, color, fill = true }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data), min = Math.min(...data);
  const range = max - min || 1;
  const stepX = data.length > 1 ? width / (data.length - 1) : 0;
  const points = data.map((v, i) => [i * stepX, height - ((v - min) / range) * height]);
  const pathD = points.map(([x,y], i) => `${i ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const fillD = `${pathD} L ${width} ${height} L 0 ${height} Z`;
  const c = color || C.accent;
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      {fill && <path d={fillD} fill={c} opacity="0.12" />}
      <path d={pathD} fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// --- Charts: HorizontalBar (for top-N rankings) --------------------------
function HBar({ value, max, color, label, suffix }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4, color: C.ink2 }}>
        <span>{label}</span>
        <span style={{ fontWeight: 600, color: C.ink }}>{suffix || fmt(value)}</span>
      </div>
      <div style={{ height: 8, background: C.borderSoft, borderRadius: 4, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${pct}%`, background: color || C.accent,
          borderRadius: 4, transition: 'width .6s ease',
        }} />
      </div>
    </div>
  );
}

// --- DefList (definition list, label-value rows) -------------------------
function DefList({ items, columns = 1, dense = false }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
      gap: dense ? '8px 16px' : '12px 16px',
    }}>
      {items.map((it, i) => (
        <div key={i} style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 2 }}>{it.label}</div>
          <div style={{ fontSize: 13.5, color: C.ink, fontWeight: it.bold ? 600 : 400, wordBreak: 'break-word' }}>
            {it.value || '—'}
          </div>
        </div>
      ))}
    </div>
  );
}

// --- Page wrapper (consistent padding + max-width) ----------------------
function PageContainer({ children, maxWidth = 1240, style = {} }) {
  // page-padding class scales padding responsively (CSS in
  // Admin Dashboard.html) — 24/28 desktop → 14/14 mobile. Inline `style`
  // still overrides anything callers pass.
  return (
    <div className="page-padding" style={{ maxWidth, margin: '0 auto', ...style }}>
      {children}
    </div>
  );
}

// --- PageHeader ---------------------------------------------------------
function PageHeader({ title, subtitle, actions, breadcrumb, tone }) {
  // Tone: category color rail + breadcrumb dot — admin instantly sees
  // which section they're in. The new design uses 5 categorical hues
  // (overview/rooms/finance/service/system) keyed by page id.
  //
  // None of the existing 28 page-*.jsx callers pass `tone` yet — rather
  // than diff every page, we auto-resolve from the URL hash via the
  // window.PAGE_TONE registry in shared.jsx. Pages can still pass
  // tone explicitly to override (e.g., a finance-domain modal opened
  // from the rooms page).
  const TONES = window.TONES || {};
  const PAGE_TONE = window.PAGE_TONE || {};
  let toneKey = tone;
  if (!toneKey) {
    // Shell sets window.__adminPage synchronously when routing changes —
    // prefer this over the URL hash because the hash useEffect can lag
    // one render behind on first paint after a page-id state change.
    const fromShell = window.__adminPage;
    if (fromShell && PAGE_TONE[fromShell]) {
      toneKey = PAGE_TONE[fromShell];
    } else {
      // hash example: '#billing?period=2026-05' → 'billing'
      const hash = (window.location.hash || '').replace(/^#/, '').split('?')[0].split('/')[0];
      toneKey = PAGE_TONE[hash];
    }
  }
  if (!toneKey || !TONES[toneKey]) toneKey = 'overview';
  const t = TONES[toneKey];

  // breadcrumb can be:
  //   - array of strings (legacy multi-segment)
  //   - single string (legacy)
  //   - omitted entirely (new — auto-fill with category label so every
  //     page header shows which section it belongs to, no per-page work)
  let crumbs;
  if (Array.isArray(breadcrumb)) crumbs = breadcrumb;
  else if (breadcrumb) crumbs = [breadcrumb];
  else crumbs = t.label ? [t.label] : null;

  return (
    <div style={{
      background: 'var(--surface, #FFFFFF)',
      borderBottom: `1px solid var(--border, ${C.border})`,
      padding: '20px 28px 18px',
      margin: '-24px -24px 24px', // bleed to page edge inside PageContainer
      position: 'relative',
    }}>
      {/* Category color rail — left edge */}
      <div style={{
        position: 'absolute', left: 0, top: 0, bottom: 0,
        width: 3, background: t.color,
      }} />
      <div className="page-header-row">
        <div style={{ minWidth: 0 }}>
          {crumbs && crumbs.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                fontSize: 11.5, fontWeight: 600, letterSpacing: '0.06em',
                textTransform: 'uppercase', color: t.color, whiteSpace: 'nowrap',
              }}>
                <span style={{ width: 6, height: 6, borderRadius: 999, background: t.color }} />
                {crumbs.join(' · ')}
              </span>
            </div>
          )}
          <h1 className="page-title" style={{
            margin: 0,
            fontFamily: '"IBM Plex Sans Thai", "IBM Plex Sans", system-ui, sans-serif',
            fontSize: 22, fontWeight: 700,
            color: C.ink, letterSpacing: '-0.01em', lineHeight: 1.2,
          }}>
            {title}
          </h1>
          {subtitle && (
            <div style={{ fontSize: 13.5, color: C.muted, marginTop: 4 }}>{subtitle}</div>
          )}
        </div>
        {actions && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Skeleton ----------------------------------------------------------
// Placeholder for content that's still loading. Pages should swap text
// "กำลังโหลด…" for one of these so admin sees the shape of what's
// coming instead of a flicker. Cheap to render; uses a CSS gradient
// shimmer (no animation if prefers-reduced-motion is set — that media
// query in Admin Dashboard.html collapses the transition to ~0).
function Skeleton({ width = '100%', height = 14, radius = 6, style = {} }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width, height,
        borderRadius: radius,
        background: 'linear-gradient(90deg, #ECECEC 0%, #F5F5F7 40%, #ECECEC 80%)',
        backgroundSize: '200% 100%',
        animation: 'skeletonPulse 1.4s linear infinite',
        ...style,
      }}
    />
  );
}

// Compose a few Skeleton lines for common shapes — pages just pick the
// rows that match the loading content.
function SkeletonRows({ count = 3, gap = 10, lineHeight = 14, varyWidths = true }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton
          key={i}
          height={lineHeight}
          width={varyWidths ? `${65 + ((i * 17) % 25)}%` : '100%'}
        />
      ))}
    </div>
  );
}

// Card-shaped skeleton — for KPI grids / tile rows while data fetches.
function SkeletonCard({ height = 96, style = {} }) {
  return (
    <div style={{
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: 12,
      padding: 16,
      ...style,
    }}>
      <Skeleton height={11} width="50%" />
      <div style={{ height: 10 }} />
      <Skeleton height={24} width="70%" />
      <div style={{ height: 8 }} />
      <Skeleton height={10} width="40%" />
      {height > 110 && (
        <>
          <div style={{ height: 12 }} />
          <Skeleton height={6} width="100%" radius={999} />
        </>
      )}
    </div>
  );
}

// --- Expose to window ---------------------------------------------------
// Each script in /admin/* runs in the same global scope via babel-standalone.
// That means a top-level `function Toggle(){}` in any page-*.jsx silently
// overwrites our shared Toggle, breaking every <Toggle label= checked= hint= />
// after that script loads. We seal these primitives with writable:false so
// any future name collision logs an error in dev tools and the page-level
// declaration becomes a local shadow inside its own scope only.
const __UI_PRIMITIVES = {
  Card, SectionHeading, Btn, IconBtn,
  Input, Select, Toggle, Textarea,
  StatusDot, StatusBadge, Pill,
  KpiCard, Tabs, Drawer, Modal,
  DataTable, EmptyState, Avatar,
  SearchInput, FilterChip, Toast, Alert,
  Skeleton, SkeletonRows, SkeletonCard,
  BarChart, DonutChart, Sparkline, HBar,
  DefList, PageContainer, PageHeader,
};
Object.keys(__UI_PRIMITIVES).forEach((name) => {
  try {
    Object.defineProperty(window, name, {
      value: __UI_PRIMITIVES[name],
      writable: false,
      configurable: false,
      enumerable: true,
    });
  } catch (err) {
    // Fall back to plain assignment if the property already exists with a
    // conflicting descriptor (e.g., hot reload) — surfaces the collision.
    try { window[name] = __UI_PRIMITIVES[name]; } catch (_) {}
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`[ui] ${name} could not be sealed:`, err && err.message);
    }
  }
});
