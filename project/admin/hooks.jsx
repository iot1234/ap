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
      // Best-effort report to server for grouping. Stays inside try so a
      // failing report can't double-fault.
      try {
        fetch('/api/client-error', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: String(err?.message || err),
            stack: String(err?.stack || '').slice(0, 4000),
            componentStack: String(info?.componentStack || '').slice(0, 4000),
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
    const res = await fetch(url, { credentials: 'same-origin', ...opts, headers });
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

  window.useFeatureFlag = useFeatureFlag;
  window.useApi = useApi;
  window.loadFeatures = loadFeatures;
  window.ErrorBoundary = ErrorBoundary;
  window.OfflineBanner = OfflineBanner;
  window.apiFetch = apiFetch;
  window.getCsrfToken = getCsrfToken;
})();
