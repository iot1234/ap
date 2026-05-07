// === project/admin/hooks.jsx ==============================================
// Tiny set of cross-page React hooks. Loaded after ui.jsx and before any
// page-*.jsx so they show up on window.* by the time pages render.
//
//   useFeatureFlag(key)           — returns { enabled, flag } reactively
//   useApi(url)                   — fetch + loading/error state + retry
//   ErrorBoundary                 — wrap any component to catch render errors
//   OfflineBanner                 — listens for online/offline + renders banner
// ===========================================================================

(function () {
  // Tiny shared cache for /api/features so we don't refetch per-component.
  // 60-second TTL matches the spec.
  let _cache = null;
  let _cacheAt = 0;
  let _inflight = null;
  const TTL_MS = 60_000;

  async function loadFeatures(force) {
    if (!force && _cache && Date.now() - _cacheAt < TTL_MS) return _cache;
    if (_inflight) return _inflight;
    _inflight = fetch('/api/features', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((d) => {
        _cache = d.features || {};
        _cacheAt = Date.now();
        return _cache;
      })
      .catch(() => {
        // Hard-fail: assume nothing is enabled rather than leaving stale.
        return _cache || {};
      })
      .finally(() => { _inflight = null; });
    return _inflight;
  }

  // useFeatureFlag('tenantPortal') → { enabled, flag, ready }
  function useFeatureFlag(key) {
    const [state, setState] = React.useState(() => ({
      ready: !!_cache,
      enabled: !!(_cache && _cache[key] && _cache[key].enabled),
      flag: _cache ? (_cache[key] || null) : null,
    }));
    React.useEffect(() => {
      let alive = true;
      loadFeatures().then((f) => {
        if (!alive) return;
        setState({
          ready: true,
          enabled: !!(f[key] && f[key].enabled),
          flag: f[key] || null,
        });
      });
      return () => { alive = false; };
    }, [key]);
    return state;
  }

  // useApi('/api/x') → { data, error, loading, retry }
  function useApi(url, opts) {
    const [data, setData] = React.useState(null);
    const [error, setError] = React.useState(null);
    const [loading, setLoading] = React.useState(true);
    const [tick, setTick] = React.useState(0);
    React.useEffect(() => {
      let alive = true;
      setLoading(true);
      setError(null);
      fetch(url, { credentials: 'same-origin', ...(opts || {}) })
        .then(async (r) => {
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status, code: j.code });
          return j;
        })
        .then((j) => { if (alive) { setData(j); setLoading(false); } })
        .catch((err) => { if (alive) { setError(err); setLoading(false); } });
      return () => { alive = false; };
    }, [url, tick]);
    return { data, error, loading, retry: () => setTick((n) => n + 1) };
  }

  // ErrorBoundary class component
  class ErrorBoundary extends React.Component {
    constructor(props) { super(props); this.state = { err: null }; }
    static getDerivedStateFromError(err) { return { err }; }
    componentDidCatch(err, info) {
      // Best-effort report to server. Only stringify primitive fields —
      // err.cause / err.target may contain DOM/fiber refs that re-throw
      // "Converting circular structure to JSON" inside this handler.
      try {
        fetch('/api/client-error', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: String((err && err.message) || err).slice(0, 1000),
            stack: String((err && err.stack) || '').slice(0, 4000),
            componentStack: String((info && info.componentStack) || '').slice(0, 4000),
            url: window.location.href,
          }),
        });
      } catch { /* ignore */ }
    }
    render() {
      if (!this.state.err) return this.props.children;
      const fallback = this.props.fallback;
      if (typeof fallback === 'function') return fallback(this.state.err, () => this.setState({ err: null }));
      return React.createElement('div', {
        style: {
          padding: 24, margin: 16, borderRadius: 12,
          background: '#fff5f4', color: '#5a1a13', fontFamily: 'inherit',
        },
      }, [
        React.createElement('div', { key: 'h', style: { fontWeight: 700, fontSize: 18, marginBottom: 8 } }, '⚠ เกิดข้อผิดพลาด'),
        React.createElement('div', { key: 'm', style: { fontSize: 14, marginBottom: 12 } },
          String(this.state.err?.message || 'unknown')),
        React.createElement('button', {
          key: 'b',
          onClick: () => this.setState({ err: null }),
          style: { padding: '8px 16px', borderRadius: 8, border: '1px solid #c46a3e', background: '#c46a3e', color: '#fff', cursor: 'pointer' },
        }, 'ลองใหม่'),
      ]);
    }
  }

  // Offline banner
  function OfflineBanner() {
    const [online, setOnline] = React.useState(navigator.onLine);
    React.useEffect(() => {
      const up = () => setOnline(true);
      const down = () => setOnline(false);
      window.addEventListener('online', up);
      window.addEventListener('offline', down);
      return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
    }, []);
    if (online) return null;
    return React.createElement('div', {
      style: {
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1000,
        background: '#b94a48', color: '#fff', padding: '8px 16px',
        textAlign: 'center', fontSize: 13.5, fontWeight: 500,
      },
    }, '🔌 ไม่ได้เชื่อมต่ออินเทอร์เน็ต — ข้อมูลที่บันทึกอาจสูญหาย');
  }

  // CSRF token helper for state-changing fetch calls.
  let _csrfToken = null;
  async function getCsrfToken() {
    if (_csrfToken) return _csrfToken;
    try {
      const r = await fetch('/api/csrf-token', { credentials: 'same-origin' });
      const j = await r.json();
      _csrfToken = j.csrfToken;
      return _csrfToken;
    } catch { return null; }
  }
  async function apiFetch(url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (method !== 'GET' && method !== 'HEAD') {
      const t = await getCsrfToken();
      if (t) headers['X-CSRF-Token'] = t;
    }
    // Default 30s timeout — without this a hung server makes the UI freeze
    // forever. Caller can override via opts.timeoutMs (Infinity to disable).
    const timeoutMs = opts.timeoutMs == null ? 30_000 : opts.timeoutMs;
    let controller, timer;
    let signal = opts.signal;
    if (!signal && Number.isFinite(timeoutMs)) {
      controller = new AbortController();
      signal = controller.signal;
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }
    let res;
    try {
      res = await fetch(url, { credentials: 'same-origin', ...opts, signal, headers });
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (err.name === 'AbortError') {
        const e = new Error('คำขอใช้เวลานานเกินกำหนด — โปรดลองใหม่');
        e.code = 'TIMEOUT';
        throw e;
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
    // Session expired or never authenticated → bounce to login. Skip the
    // login + me + csrf endpoints (those return 401 as a valid signal).
    if (res.status === 401
        && !url.includes('/auth/login') && !url.includes('/auth/me')
        && !url.includes('/csrf-token')) {
      _csrfToken = null;
      // Defer so the caller can read the body if it wants to log first.
      setTimeout(() => {
        if (!sessionStorage.getItem('__admin_redirected_401')) {
          sessionStorage.setItem('__admin_redirected_401', '1');
          window.location.href = '/login?from=' + encodeURIComponent(window.location.hash || '');
        }
      }, 0);
    }
    if (res.status === 403) {
      // CSRF token may have rotated — clear cache so next call refetches.
      _csrfToken = null;
    }
    return res;
  }
  // Clear the redirect throttle once the user is back on /login or other
  // public path; this keeps a single 401 burst from looping.
  if (location.pathname === '/login' || location.pathname === '/') {
    sessionStorage.removeItem('__admin_redirected_401');
  }

  // === Global Esc-to-close modals ========================================
  // Modals across pages call window.useEscClose(open, onClose) to register.
  // The most recently opened modal handles Esc first.
  const _escStack = [];
  if (typeof window !== 'undefined' && !window.__adminEscBound) {
    window.__adminEscBound = true;
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      const top = _escStack[_escStack.length - 1];
      if (top) { ev.preventDefault(); try { top(); } catch {} }
    });
  }
  function useEscClose(open, onClose) {
    React.useEffect(() => {
      if (!open || typeof onClose !== 'function') return undefined;
      _escStack.push(onClose);
      return () => {
        const i = _escStack.lastIndexOf(onClose);
        if (i >= 0) _escStack.splice(i, 1);
      };
    }, [open, onClose]);
  }

  // === Loading skeleton primitive =======================================
  // Replaces "กำลังโหลด…" text — gives admins a sense of layout while
  // data is in flight. Reuses the C palette set by shared.jsx.
  function Skeleton({ rows = 3, lineHeight = 14 }) {
    const C = window.ADMIN_C || {};
    const bg = C.bgSoft || '#f0e9d9';
    const fg = C.border || '#e8dcc6';
    return React.createElement('div', {
      style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 10 },
    }, Array.from({ length: rows }).map((_, i) =>
      React.createElement('div', {
        key: i,
        style: {
          height: lineHeight,
          width: i % 3 === 2 ? '60%' : '100%',
          background: `linear-gradient(90deg, ${bg} 0%, ${fg} 50%, ${bg} 100%)`,
          backgroundSize: '200% 100%',
          borderRadius: 4,
          animation: 'shimmer 1.4s infinite',
        },
      })
    ));
  }
  if (typeof document !== 'undefined' && !document.getElementById('__admin_shimmer_kf')) {
    const s = document.createElement('style');
    s.id = '__admin_shimmer_kf';
    s.textContent = '@keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }';
    document.head.appendChild(s);
  }

  // === Global error sink ================================================
  // ErrorBoundary catches React render errors. window.onerror catches
  // sync errors thrown anywhere; unhandledrejection catches async rejects.
  // Both fire-and-forget POST to /api/client-error so admin sees them in
  // audit logs even when the user closes the tab right after.
  //
  // safeStringify: drops circular refs + DOM nodes + React fibers so a
  // payload containing them doesn't itself throw "Converting circular
  // structure to JSON" (the original error we're trying to report becomes
  // unreportable). We replace problematic values with "[Circular]" /
  // "[DOM]" / "[ReactFiber]" placeholders so the actionable parts survive.
  function safeStringify(obj) {
    const seen = new WeakSet();
    return JSON.stringify(obj, function (key, value) {
      if (typeof key === 'string' && key.startsWith('__react')) return '[ReactFiber]';
      if (value === window) return '[Window]';
      if (typeof Element !== 'undefined' && value instanceof Element) return '[DOM:' + value.tagName + ']';
      if (typeof Event !== 'undefined' && value instanceof Event) return '[Event:' + value.type + ']';
      if (typeof Node !== 'undefined' && value instanceof Node) return '[Node]';
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    });
  }
  if (typeof window !== 'undefined' && !window.__admin_err_bound) {
    window.__admin_err_bound = true;
    let _lastReport = 0;   // throttle: 1 report per second to dodge loops
    function report(payload) {
      const now = Date.now();
      if (now - _lastReport < 1000) return;
      _lastReport = now;
      let body;
      try { body = safeStringify(payload); }
      catch { body = safeStringify({ message: 'unstringifiable payload' }); }
      try {
        navigator.sendBeacon
          ? navigator.sendBeacon('/api/client-error', new Blob(
              [body], { type: 'application/json' }))
          : fetch('/api/client-error', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body,
              keepalive: true,
            });
      } catch { /* ignore */ }
    }
    window.addEventListener('error', (ev) => {
      report({
        message: String(ev.message || 'window.onerror'),
        stack: String((ev.error && ev.error.stack) || '').slice(0, 4000),
        url: window.location.href,
        source: ev.filename, line: ev.lineno, col: ev.colno,
      });
    });
    window.addEventListener('unhandledrejection', (ev) => {
      const r = ev.reason;
      report({
        message: 'unhandledrejection: ' + String((r && r.message) || r),
        stack: String((r && r.stack) || '').slice(0, 4000),
        url: window.location.href,
      });
    });
  }

  // === FeatureGate ====================================================
  // Wraps a page so it shows a friendly "feature is off" placeholder when
  // the corresponding feature flag is disabled — instead of letting the page
  // render and stack 503-error toasts as every API call fails.
  function FeatureGate({ flag, children, label }) {
    const f = useFeatureFlag(flag);
    if (!f.ready) {
      return React.createElement(window.AdminSkeleton || 'div', { rows: 4 });
    }
    if (f.enabled) return children;
    const C = window.ADMIN_C || {};
    return React.createElement('div', {
      style: {
        padding: 40, margin: 24, borderRadius: 12,
        background: C.bgSoft || '#fff7e0',
        color: C.ink2 || '#5b4f40',
        textAlign: 'center', fontFamily: 'inherit',
      },
    }, [
      React.createElement('div', { key: 'i', style: { fontSize: 36, marginBottom: 12 } }, '🎛'),
      React.createElement('div', { key: 'h', style: { fontFamily: 'Sora', fontSize: 16, fontWeight: 600, marginBottom: 4 } },
        `ฟีเจอร์ "${label || flag}" ปิดอยู่`),
      React.createElement('div', { key: 'd', style: { fontSize: 13.5, marginBottom: 16 } },
        'เปิดได้ที่ ระบบ → ฟีเจอร์ระบบ'),
      React.createElement('button', {
        key: 'b',
        onClick: () => { window.location.hash = '#features'; window.location.reload(); },
        style: {
          padding: '8px 18px', borderRadius: 8, border: 0,
          background: C.accent || '#c46a3e', color: '#fff',
          fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
        },
      }, 'ไปหน้าฟีเจอร์'),
    ]);
  }

  window.useFeatureFlag = useFeatureFlag;
  window.FeatureGate = FeatureGate;
  window.useApi = useApi;
  window.loadFeatures = loadFeatures;
  window.ErrorBoundary = ErrorBoundary;
  window.OfflineBanner = OfflineBanner;
  // Pages that call state-changing endpoints directly (page-bookings,
  // page-recurring-charges, etc.) need the same CSRF-aware fetch the hook
  // uses internally. Expose it as a global so non-hook callers can reuse it.
  window.apiFetch = apiFetch;
  window.getCsrfToken = getCsrfToken;
  window.useEscClose = useEscClose;
  window.AdminSkeleton = Skeleton;
})();
