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
  const FETCH_TIMEOUT_MS = 8_000;

  async function loadFeatures(force) {
    if (!force && _cache && Date.now() - _cacheAt < TTL_MS) return _cache;
    if (_inflight) return _inflight;
    // Hard timeout via AbortController so a hung /api/features request can't
    // leave FeatureGate stuck on the loading skeleton forever (which on
    // mobile/Chrome can escalate to RESULT_CODE_HUNG when combined with
    // skeleton CSS animations + repeated re-renders).
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    _inflight = fetch('/api/features', { credentials: 'same-origin', signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((d) => {
        _cache = d.features || {};
        _cacheAt = Date.now();
        return _cache;
      })
      .catch((err) => {
        // Hard-fail: cache an EMPTY map (every flag effectively disabled) so
        // FeatureGate renders the friendly "feature off" placeholder instead
        // of looping. The cache TTL means we'll retry in 60s automatically.
        console.warn('[features] load failed:', err && err.message);
        _cache = _cache || {};
        _cacheAt = Date.now();
        return _cache;
      })
      .finally(() => { clearTimeout(timer); _inflight = null; });
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
    static getDerivedStateFromError(err) {
      // Coerce err.message to a string immediately. The fallback UI renders
      // err.message via String(...) below; if err.message is itself a
      // circular object (e.g. some libraries store the problematic value as
      // the message), that String() call can re-throw inside render and
      // freeze the ErrorBoundary. Keeping a primitive snapshot avoids that.
      const safe = {
        message: typeof err?.message === 'string' ? err.message :
                 (err == null ? 'unknown' : Object.prototype.toString.call(err)),
        stack: typeof err?.stack === 'string' ? err.stack : '',
      };
      return { err: safe };
    }
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
      } catch { /* ignore — client-error reporter must never re-throw */ }
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
  let _csrfTokenPromise = null;
  async function getCsrfToken(forceRefresh) {
    if (_csrfToken && !forceRefresh) return _csrfToken;
    if (_csrfTokenPromise && !forceRefresh) return _csrfTokenPromise;
    _csrfTokenPromise = (async () => {
      const r = await fetch('/api/csrf-token', { credentials: 'same-origin' });
      if (!r.ok) {
        console.warn('[apiFetch] csrf-token endpoint returned', r.status);
        return null;
      }
      const j = await r.json();
      if (!j || !j.csrfToken) {
        console.warn('[apiFetch] csrf-token response missing csrfToken field');
        return null;
      }
      _csrfToken = j.csrfToken;
      return _csrfToken;
    })();
    try {
      return await _csrfTokenPromise;
    } catch (err) {
      console.warn('[apiFetch] csrf-token fetch failed:', err && err.message);
      return null;
    } finally {
      _csrfTokenPromise = null;
    }
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
      // CSRF token may have rotated — clear cache + retry ONCE with a fresh
      // token. Without this auto-retry, every save after a session token
      // rotation surfaces "invalid CSRF token" until the user refreshes.
      _csrfToken = null;
      if (method !== 'GET' && method !== 'HEAD' && !opts._csrfRetried) {
        try {
          const fresh = await getCsrfToken(true);
          if (fresh) {
            const retryHeaders = { ...headers, 'X-CSRF-Token': fresh };
            return await fetch(url, {
              credentials: 'same-origin', ...opts,
              signal, headers: retryHeaders,
              _csrfRetried: true,
            });
          }
        } catch { /* fall through with original 403 */ }
      }
    }
    return res;
  }
  // Clear the redirect throttle once the user is back on /login or other
  // public path; this keeps a single 401 burst from looping.
  if (location.pathname === '/login' || location.pathname === '/') {
    sessionStorage.removeItem('__admin_redirected_401');
  }

  // === ApiError + apiCall ================================================
  // Structured error class so callers can branch on `.code` / `.status`
  // without re-parsing JSON in every catch block. apiCall(url, opts)
  // wraps apiFetch + JSON parse + throw-on-not-ok in one call. The error
  // it throws plays nicely with toastError() for one-line error handling:
  //
  //   try {
  //     const out = await apiCall('/api/bills', { method: 'POST', body });
  //   } catch (err) {
  //     toastError(setToast, err, { action: 'ออกบิล' });
  //   }
  class ApiError extends Error {
    constructor(payload) {
      super(payload.error || payload.message || `HTTP ${payload.status}`);
      this.name = 'ApiError';
      this.status = payload.status;
      this.code = payload.code;
      this.error = payload.error;
      this.issues = payload.issues;
      this.issueSummary = payload.issueSummary;
      this.hint = payload.hint;
      this.nextActions = payload.nextActions;
      this.requestId = payload.requestId;
      this.raw = payload.raw;
      this.body = payload.raw;
    }
  }
  async function apiCall(url, opts = {}) {
    let res;
    try {
      res = await apiFetch(url, opts);
    } catch (err) {
      // apiFetch may throw on TIMEOUT — preserve its code so toastError
      // can render the right "took too long" message instead of generic.
      throw new ApiError({
        status: 0,
        code: err && err.code,
        error: err && err.message,
        message: err && err.message,
      });
    }
    let body = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try { body = await res.json(); } catch { body = null; }
    }
    if (!res.ok) {
      throw new ApiError({
        status: res.status,
        code: (body && body.code) || null,
        error: (body && body.error) || `HTTP ${res.status}`,
        issues: body && body.issues,
        issueSummary: body && body.issueSummary,
        hint: body && body.hint,
        nextActions: body && body.nextActions,
        requestId: body && body.requestId,
        raw: body,
      });
    }
    return body;
  }

  function requireApiFetch() {
    return apiFetch;
  }

  function requireApiCall() {
    return apiCall;
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
          background: fg,
          opacity: 0.6,
          borderRadius: 4,
          // Static skeleton — the previous CSS shimmer animation looped
          // forever on the GPU and, combined with multiple FeatureGate
          // children mounting/unmounting in rapid succession, was implicated
          // in Chrome RESULT_CODE_HUNG renderer crashes on the access page.
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
      const C = window.ADMIN_C || {};
      return React.createElement('div', {
        style: {
          padding: 40, margin: 24, borderRadius: 12,
          background: C.bgSoft || '#fff7e0',
          color: C.ink2 || '#5b4f40',
          textAlign: 'center', fontFamily: 'inherit',
        },
      }, [
        React.createElement('div', { key: 'i', style: { fontSize: 28, marginBottom: 10 } }, '...'),
        React.createElement('div', { key: 'h', style: { fontFamily: 'IBM Plex Sans Thai', fontSize: 16, fontWeight: 600, marginBottom: 4 } },
          `กำลังตรวจสอบฟีเจอร์ "${label || flag}"`),
        React.createElement('div', { key: 'd', style: { fontSize: 13.5 } },
          'กรุณารอสักครู่'),
      ]);
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
      React.createElement('div', { key: 'h', style: { fontFamily: 'IBM Plex Sans Thai', fontSize: 16, fontWeight: 600, marginBottom: 4 } },
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

  // === toastError(setToast, err, ctx) ====================================
  // Central error-to-toast formatter. Translates server `code` strings into
  // actionable Thai messages with a "what to do next" hint, surfaces Zod
  // validation issues field-by-field, and keeps generic fallback for
  // anything unrecognised. Usage:
  //
  //   try { ... }
  //   catch (err) { toastError(setToast, err, { action: 'บันทึกผู้เช่า' }); }
  //
  // ctx (optional): { action: 'บันทึกผู้เช่า' } — verb that prefixes the
  //   "X ไม่สำเร็จ" headline; default 'การทำงาน'.
  // err can be:
  //   - Error instance (e.g. from apiFetch / fetch reject)
  //   - { status, code, error, issues, message } object (parsed JSON body)
  //   - { res, body } pair — tell-once shortcut for handlers that already
  //     fetched + parsed
  //
  // Returns the toast payload it dispatched (for tests / chaining).
  const ERROR_CODE_MAP = {
    // === Auth / session =================================================
    UNAUTHORIZED: {
      title: 'หมดเวลาเข้าสู่ระบบ',
      description: 'โปรดล็อกอินอีกครั้งเพื่อทำต่อ',
    },
    FORBIDDEN: {
      title: 'สิทธิ์ไม่เพียงพอ',
      description: (e) => `บัญชีนี้ (${e.actual || 'ปัจจุบัน'}) ไม่มีสิทธิ์ทำรายการนี้ — ติดต่อ owner`,
    },
    LOCKED_OUT: {
      title: 'บัญชีถูกล็อกชั่วคราว',
      description: 'พยายามเข้าระบบบ่อยเกินไป — ลองใหม่ในไม่กี่นาทีข้างหน้า',
    },
    STEP_UP_REQUIRED: {
      title: 'ต้องยืนยันรหัสผ่านปัจจุบัน',
      description: 'การเปลี่ยนรหัสผ่านของตัวเองต้องกรอกรหัสปัจจุบันก่อน',
    },
    SELF_ROLE_CHANGE: {
      title: 'เปลี่ยนสิทธิ์ตัวเองไม่ได้',
      description: 'ขอให้ owner คนอื่นเป็นคนปรับ role ให้',
    },
    LAST_OWNER: {
      title: 'ลด/ลบ owner คนสุดท้ายไม่ได้',
      description: 'สร้าง owner คนใหม่ก่อนแล้วค่อยปรับบัญชีนี้',
    },
    CSRF_INVALID: {
      title: 'โทเค็นความปลอดภัยหมดอายุ',
      description: 'ลองใหม่อีกครั้ง — ถ้ายังไม่ได้ ให้รีเฟรชหน้า',
    },
    RATE_LIMIT: {
      title: 'คำขอบ่อยเกินไป',
      description: 'รอสักครู่แล้วลองใหม่',
    },
    // === Data integrity =================================================
    VALIDATION_ERROR: {
      title: 'ข้อมูลที่กรอกไม่ถูกต้อง',
      description: (e) => {
        if (!e.issues || !e.issues.length) return null;
        // Show up to 3 field errors so the toast doesn't grow huge; "+N more"
        // for the rest. Field path looks like "phone" or "tenant.fullName".
        const top = e.issues.slice(0, 3)
          .map((it) => `• ${it.path || 'ฟิลด์'}: ${it.message}`).join('\n');
        const more = e.issues.length > 3 ? `\n• …และอีก ${e.issues.length - 3} จุด` : '';
        return top + more;
      },
    },
    BAD_SHAPE: {
      title: 'รูปแบบข้อมูลไม่ถูกต้อง',
      description: 'ข้อมูลที่ส่งไปไม่ตรงกับรูปแบบที่คาดหวัง — ลองรีเฟรชแล้วบันทึกใหม่',
    },
    INVALID_JSON: { title: 'ข้อมูลไม่ใช่ JSON ที่ถูกต้อง' },
    NOT_SERIALISABLE: { title: 'ข้อมูลมีโครงสร้างซับซ้อนเกินไป (circular reference)' },
    TOO_LARGE: {
      title: 'ข้อมูลใหญ่เกินกำหนด',
      description: (e) => e.error || 'ลดขนาดไฟล์/รูปภาพแล้วลองใหม่',
    },
    NOT_FOUND: { title: 'ไม่พบข้อมูล', description: 'ข้อมูลอาจถูกลบไปแล้ว — กดรีเฟรชเพื่อโหลดใหม่' },
    VERSION_CONFLICT: {
      title: 'มีคนอื่นแก้ไขข้อมูลนี้แล้ว',
      description: 'โปรดรีเฟรชหน้าเพื่อโหลดข้อมูลใหม่ ก่อนแก้ไขซ้ำ',
    },
    BILL_DUPLICATE: {
      title: 'มีบิลของรอบนี้อยู่แล้ว',
      description: 'ทำการ void บิลเดิมก่อน หากต้องการสร้างใหม่',
    },
    // R3 — server recomputes the bill and refuses to insert if admin's
    // submitted totals drift > tolerance vs the resolver. Admin can opt-in
    // via manualOverride+reason for legitimate cases (special promo, legacy
    // migration, contract change mid-flight).
    BILL_TOTAL_DRIFT: {
      title: 'ตัวเลขบิลไม่ตรงกับที่ระบบคำนวณ',
      description: (e) => {
        const lines = ['ตรวจสอบยอดอีกครั้งก่อนยืนยัน — หรือส่ง manualOverride:true พร้อม overrideReason เพื่อบันทึก audit'];
        if (Array.isArray(e.drifts)) {
          for (const d of e.drifts.slice(0, 5)) {
            lines.push(`• ${d.field}: ส่งมา ${d.submitted} ระบบคำนวณ ${d.expected} (ต่าง ${d.diff})`);
          }
        }
        return lines.join('\n');
      },
    },
    // R3 — recompute itself failed (DB hiccup mid-handler). Distinct from
    // DRIFT because the issue is server-side, not the submitted numbers.
    BILL_RECOMPUTE_FAILED: {
      title: 'ระบบตรวจสอบบิลไม่สำเร็จ',
      description: 'ลองส่งใหม่ด้วยตัวเลือก "ให้ระบบคำนวณให้" (compute:true) หรือรอสักครู่แล้วลองใหม่',
    },
    // R3 — admin must include a reason when bypassing the drift check.
    OVERRIDE_REASON_REQUIRED: {
      title: 'ต้องระบุเหตุผลในการ override',
      description: 'พิมพ์อธิบายในกล่อง overrideReason อย่างน้อย 5 ตัวอักษร ก่อนกดยืนยัน',
    },
    // R2-followup — payment amount didn't match current total OR principal.
    // The response shape includes billPrincipal so the UI can show both
    // reference numbers, letting admin/tenant pick the right amount.
    PAYMENT_AMOUNT_MISMATCH: {
      title: 'จำนวนเงินไม่ตรงกับยอดบิล',
      description: (e) => {
        const lines = [];
        if (e.billTotal != null) lines.push(`ยอดบิลปัจจุบัน: ฿${Number(e.billTotal).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`);
        if (e.billPrincipal != null && e.billLateFee > 0) {
          lines.push(`  • ค่าเช่า+ค่าน้ำไฟ: ฿${Number(e.billPrincipal).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`);
          lines.push(`  • ค่าปรับล่าช้า: ฿${Number(e.billLateFee).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`);
        }
        if (e.paymentAmount != null) lines.push(`ยอดที่ระบุ: ฿${Number(e.paymentAmount).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`);
        return lines.join('\n');
      },
    },
    // R2-followup — tenant uploaded amount didn't match (same shape).
    AMOUNT_NOT_BILL_TOTAL: {
      title: 'ยอดสลิปไม่ตรงกับยอดบิล',
      description: (e) => e.error || 'โอนเงินตามยอดบิล แล้วลองอัปโหลดสลิปใหม่',
    },
    LATE_FEE_DECISION_REQUIRED: {
      title: 'ต้องเลือกวิธีจัดการค่าปรับ',
      description: (e) => {
        const lines = ['ผู้เช่าจ่ายเฉพาะยอดก่อนค่าปรับ ต้องเลือกยกค่าปรับ / เก็บรอบหน้า หรือปฏิเสธให้จ่ายเพิ่ม'];
        if (e.billPrincipal != null) lines.push(`ยอดก่อนค่าปรับ: ฿${Number(e.billPrincipal).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`);
        if (e.billLateFee != null) lines.push(`ค่าปรับล่าช้า: ฿${Number(e.billLateFee).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`);
        return lines.join('\n');
      },
    },
    RECURRING_CHARGES_REQUIRED_FOR_CARRY: {
      title: 'ยังเก็บค่าปรับรอบหน้าไม่ได้',
      description: 'เปิดฟีเจอร์ "ค่าใช้จ่ายประจำ" ก่อน หรือเลือกยกค่าปรับแทน',
    },
    LATE_FEE_CARRY_FAILED: {
      title: 'สร้างรายการเก็บค่าปรับรอบหน้าไม่สำเร็จ',
      description: (e) => e.error || 'ตรวจข้อมูลผู้เช่า/ห้อง แล้วลองใหม่ หรือเลือกยกค่าปรับแทน',
    },
    // R7-followup — admin clicked "ส่งเตือน" too soon after the previous
    // send (manual or scheduler). UI should show "ส่งซ้ำตอนนี้?" prompt
    // and re-call with force:true.
    REMINDER_COOLDOWN: {
      title: 'เพิ่งส่งเตือนไป',
      description: (e) => e.error || 'รอสักครู่ก่อนส่งซ้ำ หรือคลิก "บังคับส่งซ้ำ" ถ้าจำเป็น',
    },
    TENANT_HAS_REFS: {
      title: 'ลบผู้เช่าไม่ได้',
      description: 'ผู้เช่ายังมีบิล/สัญญา/บัตรเข้า-ออกเชื่อมโยง — เปิด softDelete หรือลบข้อมูลที่อ้างถึงก่อน',
    },
    // === Booking → contract flow ======================================
    APPROVAL_REQUIRES_ASSIGNMENT_FLOW: {
      title: 'อนุมัติการจองผิดช่องทาง',
      description: (e) => e.hint || 'ต้องใช้ปุ่มอนุมัติที่จองห้องพร้อมกัน เพื่อกัน booking approved แต่ห้องไม่ถูก reserve',
    },
    NO_VACANT_ROOM_MATCH: {
      title: 'ยังไม่มีห้องว่างตรงเงื่อนไข',
      description: (e) => e.hint || 'รอห้องว่าง เปลี่ยนเงื่อนไข booking หรือจัดห้องด้วยตนเองก่อนอนุมัติ',
    },
    BOOKING_DEPOSIT_NOT_READY: {
      title: 'ค่าจองยังไม่พร้อมอนุมัติ',
      description: (e) => e.hint || 'ตรวจสลิปค่าจองหรือให้ผู้จองส่งสลิปใหม่ก่อนอนุมัติ',
    },
    BOOKING_NOT_FOUND: {
      title: 'ไม่พบ booking ต้นทาง',
      description: (e) => e.hint || 'กลับไปหน้า booking แล้วเริ่มจากรายการล่าสุดอีกครั้ง',
    },
    BOOKING_NOT_APPROVED: {
      title: 'booking ยังไม่พร้อมสร้างสัญญา',
      description: (e) => e.hint || `สถานะปัจจุบัน: ${e.currentStatus || '-'} — ต้องอนุมัติและจองห้องก่อน`,
    },
    BOOKING_ROOM_MISMATCH: {
      title: 'booking กับห้องไม่ตรงกัน',
      description: (e) => e.hint || `booking อยู่ห้อง ${e.bookingRoomId || '-'} แต่กำลังใช้ห้อง ${e.requestedRoomId || '-'}`,
    },
    BOOKING_ROOM_NOT_RESERVED: {
      title: 'ห้องไม่ได้ถูกจองโดย booking นี้แล้ว',
      description: (e) => e.hint || 'ข้อมูล reservation เปลี่ยนไประหว่างทาง รีเฟรชและเริ่มจาก booking ใหม่',
    },
    BOOKING_TENANT_MISMATCH: {
      title: 'booking กับผู้เช่าไม่ตรงกัน',
      description: (e) => e.hint || `booking เป็นของเบอร์ ${e.bookingPhone || '-'} แต่กำลังสร้างสัญญาให้ ${e.requestedPhone || '-'}`,
    },
    BOOKING_HAS_ACTIVE_CONTRACT: {
      title: 'ยกเลิก booking ไม่ได้ เพราะมีสัญญา active',
      description: (e) => e.hint || 'ปิดสัญญาหรือ checkout ผู้เช่าก่อน แล้วระบบจะคืนห้องตาม cascade',
    },
    // === Room / tenant / contract guards ===============================
    ROOM_RESERVED: {
      title: 'ห้องถูกจองอยู่แล้ว',
      description: (e) => e.hint || 'เปิดจาก booking/สัญญาที่จองห้องนี้ไว้ หรือยกเลิก reservation เดิมก่อน',
    },
    ROOM_OCCUPIED: {
      title: 'ห้องมีผู้เช่าอยู่แล้ว',
      description: (e) => e.hint || 'ต้อง check-out ผู้เช่าปัจจุบัน หรือเลือกห้องอื่นก่อนทำรายการต่อ',
    },
    ROOM_UNAVAILABLE: {
      title: 'ห้องยังไม่พร้อมใช้งาน',
      description: (e) => e.hint || 'ห้องอยู่ในสถานะที่ไม่รับผู้เช่าใหม่ ให้เปิดใช้งานหรือเลือกห้องอื่น',
    },
    ROOM_NOT_FOUND: {
      title: 'ไม่พบห้องนี้ในระบบ',
      description: (e) => e.hint || 'ตรวจเลขห้องหรือสร้างห้องในหน้าห้องพักก่อน',
    },
    ROOM_CONTRACT_EXISTS: {
      title: 'สร้างสัญญาใหม่ไม่ได้',
      description: (e) => e.hint || 'ห้องนี้มีสัญญาหรือร่างสัญญาอยู่แล้ว ให้ใช้สัญญาเดิมที่มีอยู่ หรือปิด/ยกเลิกสัญญาเดิมก่อนสร้างสัญญาใหม่',
    },
    ROOM_STRANDED_CONTRACT: {
      title: 'ห้องมีสัญญาค้างที่ต้อง reconcile',
      description: (e) => e.hint || 'ข้อมูลห้อง/ผู้เช่า/สัญญาไม่ตรงกัน ให้ reconcile ห้องก่อนสร้างสัญญาใหม่',
    },
    TENANT_ALREADY_ACTIVE: {
      title: 'ผู้เช่ายัง active อยู่ห้องอื่น',
      description: (e) => e.hint || `checkout ห้อง ${e.currentRoom || 'เดิม'} ก่อน หรือใช้ force เฉพาะงาน migrate`,
    },
    TENANT_BLACKLISTED: {
      title: 'ผู้เช่าอยู่ใน blacklist',
      description: (e) => e.hint || 'ตรวจประวัติผู้เช่าก่อน หากต้อง override ต้องทำอย่างตั้งใจและมี audit',
    },
    DRAFT_CONTRACT_EXISTS: {
      title: 'มีสัญญารอลงนามอยู่แล้ว',
      description: (e) => e.hint || 'ส่งลิงก์ใหม่จากสัญญาเดิม หรือยกเลิก draft เดิมก่อนสร้างใหม่',
    },
    TENANT_ROOM_CONTRACT_EXISTS: {
      title: 'ผู้เช่ามีสัญญาของห้องนี้อยู่แล้ว',
      description: (e) => e.hint || 'ใช้สัญญาเดิม หรือปิดสัญญาเดิมก่อนสร้างฉบับใหม่',
    },
    MOVE_IN_OUT_OF_WINDOW: {
      title: 'วันเข้าพักอยู่นอกช่วงที่อนุญาต',
      description: (e) => e.hint || 'ตรวจวันที่อีกครั้ง หรือใช้ force เฉพาะกรณียืนยันว่าข้อมูลถูกต้อง',
    },
    DEPOSIT_TOO_LARGE: {
      title: 'เงินมัดจำสูงผิดปกติ',
      description: (e) => e.hint || 'ตรวจยอดมัดจำก่อนบันทึก เพื่อกันพิมพ์เลขศูนย์เกิน',
    },
    CONTRACT_APPROVAL_PRECHECK_FAILED: {
      title: 'ยังอนุมัติสัญญาไม่ได้',
      description: (e) => {
        const issues = Array.isArray(e.issues) ? e.issues : [];
        const missing = issues.slice(0, 4).map((it) => `• ${it.label || it.field || it.code}`).join('\n');
        return missing || e.hint || 'ข้อมูลที่ผู้เช่ากรอกยังไม่ครบ ให้ส่งกลับไปแก้ก่อน lock สัญญา';
      },
    },
    CONTRACT_APPROVAL_TARGET_INVALID: {
      title: 'สัญญาปลายทางยังไม่พร้อม',
      description: (e) => {
        const issues = Array.isArray(e.issues) ? e.issues : [];
        const top = issues.slice(0, 4).map((it) => {
          const detail = it && it.detail && typeof it.detail === 'object' ? it.detail : {};
          const values = [];
          if (detail.monthlyRent !== undefined) values.push(`ค่าเช่า ${detail.monthlyRent}`);
          if (detail.minimumRent !== undefined) values.push(`ขั้นต่ำ ${detail.minimumRent}`);
          const valueText = values.length ? ` (${values.join(' / ')})` : '';
          return `• ${it.label || it.code}${valueText}: ${it.action || it.consequence || ''}`.trim();
        }).join('\n');
        return top || e.hint || 'แก้ข้อมูลสัญญา/ผู้เช่า/ห้องให้ตรงกันก่อนอนุมัติ';
      },
    },
    CONTRACT_LOCKED: {
      title: 'สัญญาถูก lock แล้ว',
      description: (e) => e.hint || 'สัญญาที่ lock แล้วแก้ข้อมูลสำคัญหรือส่งลิงก์ใหม่ไม่ได้ ต้องสร้างฉบับใหม่หรือทำรายการปิดสัญญา',
    },
    CONTRACT_CLOSE_REASON_REQUIRED: {
      title: 'ต้องระบุเหตุผลการปิดสัญญา',
      description: (e) => e.hint || 'เหตุผลนี้ใช้ใน audit log และช่วยให้ flow ย้ายออก/ยกเลิกสัญญาตรวจสอบย้อนหลังได้',
    },
    CONTRACT_REOPEN_BLOCKED: {
      title: 'เปิดสัญญาที่ปิดแล้วกลับมาไม่ได้',
      description: (e) => e.hint || 'สร้างสัญญาใหม่หรือ check-in ใหม่ เพื่อไม่ให้ห้อง/บิล/ผู้เช่าย้อนสถานะผิด',
    },
    CONTRACT_ALREADY_CLOSED: {
      title: 'สัญญานี้ปิดไปแล้ว',
      description: (e) => `สถานะปัจจุบัน: ${e.currentStatus || '-'} — รีเฟรชข้อมูลก่อนทำรายการต่อ`,
    },
    CHECKOUT_FAILED: {
      title: 'ยกเลิกสัญญาไม่สำเร็จ',
      description: (e) => e.hint || [
        'ระบบยกเลิกการบันทึกที่ไม่สมบูรณ์ให้แล้ว จึงไม่มีข้อมูลถูกเปลี่ยนครึ่งทาง',
        'ให้รีเฟรชหน้าแล้วลองทำรายการอีกครั้ง',
        'หากยังไม่สำเร็จ ให้เปิดเมนูสุขภาพระบบเพื่อตรวจฐานข้อมูล/ตาราง และแจ้งช่วงเวลาที่ทำรายการให้ผู้ดูแลระบบตรวจบันทึกระบบ',
      ].join('\n'),
    },
    CITIZEN_ID_DUPLICATE: {
      title: 'เลขบัตรประชาชนซ้ำกับผู้เช่ารายอื่น',
      description: (e) => e.hint || 'ค้นหาผู้เช่าเดิมก่อนตัดสินใจว่าเป็นคนเดียวกันหรือกรอกเลขผิด',
    },
    BAD_STATUS: {
      title: 'สถานะปัจจุบันทำรายการนี้ไม่ได้',
      description: (e) => e.hint || `สถานะปัจจุบัน: ${e.currentStatus || '-'} — รีเฟรชข้อมูลแล้วตรวจขั้นตอนใหม่`,
    },
    REOPEN_REASON_REQUIRED: {
      title: 'ต้องระบุเหตุผลก่อนทบทวนใหม่',
      description: (e) => e.hint || 'การเปิดรายการที่ถูกปฏิเสธกลับมาตรวจใหม่ต้องมีเหตุผล เพื่อให้ audit log ตรวจย้อนหลังได้',
    },
    TENANT_REQUIRED: {
      title: 'รายการนี้ยังไม่ผูกผู้เช่า',
      description: (e) => e.hint || 'ออก invitation ใหม่จากสัญญาที่ผูก tenant ถูกต้อง',
    },
    // === Service availability ==========================================
    BUSY: { title: 'ระบบกำลังประมวลผลอยู่', description: 'ลองใหม่ในอีกครู่' },
    DB_ERROR: { title: 'ฐานข้อมูลขัดข้อง', description: 'ทีมงานได้รับแจ้งแล้ว — ลองอีกครั้งภายหลัง' },
    TIMEOUT: {
      title: 'คำขอใช้เวลานานเกินกำหนด',
      description: 'เซิร์ฟเวอร์ช้า — ลองใหม่ในไม่กี่วินาที',
    },
  };

  function humanizeAdminErrorText(text, opts = {}) {
    if (text == null) return '';
    let s = String(text).trim();
    if (!s) return '';

    const status = opts.status == null ? null : Number(opts.status);
    if (/^HTTP\s+\d+/i.test(s) || (status && /^HTTP/i.test(s))) {
      const code = status || Number((s.match(/\d+/) || [0])[0]);
      if (code === 400) return 'ข้อมูลที่ส่งไปไม่ถูกต้อง กรุณาตรวจช่องที่กรอกแล้วลองใหม่';
      if (code === 401) return 'หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่';
      if (code === 403) return 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้';
      if (code === 404) return 'ไม่พบข้อมูล รายการอาจถูกลบหรือเปลี่ยนไปแล้ว กรุณารีเฟรชหน้า';
      if (code === 409) return 'ข้อมูลถูกใช้งานหรือมีสถานะขัดกัน กรุณารีเฟรชแล้วตรวจรายการอีกครั้ง';
      if (code === 429) return 'ส่งคำขอบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่';
      if (code >= 500) return 'ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง หากยังไม่สำเร็จให้แจ้งผู้ดูแลระบบ';
      return `ทำรายการไม่สำเร็จ (รหัส ${code || '-'}) กรุณาลองใหม่อีกครั้ง`;
    }

    if (/checkout failed[\s\S]*rolled back/i.test(s)) {
      return 'ยกเลิกสัญญา/ย้ายออกไม่สำเร็จ ระบบย้อนรายการทั้งหมดให้แล้ว จึงไม่มีข้อมูลถูกบันทึกแบบครึ่งทาง';
    }
    if (/restore failed[\s\S]*rolled back/i.test(s)) {
      return 'กู้คืนข้อมูลไม่สำเร็จ ระบบย้อนกลับไปใช้ข้อมูลเดิมแล้ว';
    }
    if (/failed to fetch|networkerror|network error/i.test(s)) {
      return navigator.onLine === false
        ? 'อุปกรณ์ของคุณไม่ได้เชื่อมต่ออินเทอร์เน็ต กรุณาเชื่อมต่อแล้วลองใหม่'
        : 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่ในอีกสักครู่';
    }
    if (/aborterror|timeout/i.test(s)) return 'คำขอใช้เวลานานเกินกำหนด กรุณาลองใหม่อีกครั้ง';

    const exact = [
      [/^load failed$/i, 'โหลดข้อมูลไม่สำเร็จ กรุณารีเฟรชหน้าแล้วลองใหม่'],
      [/^save failed$/i, 'บันทึกข้อมูลไม่สำเร็จ กรุณาตรวจข้อมูลแล้วลองใหม่'],
      [/^create failed$/i, 'สร้างรายการไม่สำเร็จ กรุณาตรวจข้อมูลแล้วลองใหม่'],
      [/^delete failed$/i, 'ลบรายการไม่สำเร็จ กรุณารีเฟรชแล้วลองใหม่'],
      [/^retry failed$/i, 'ลองส่งซ้ำไม่สำเร็จ กรุณารอสักครู่แล้วลองใหม่'],
      [/^failed$/i, 'ทำรายการไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'],
      [/^internal error$/i, 'ระบบขัดข้องภายใน กรุณาลองใหม่อีกครั้ง หากยังไม่สำเร็จให้แจ้งผู้ดูแลระบบ'],
      [/^invalid id$/i, 'รหัสรายการไม่ถูกต้อง กรุณารีเฟรชหน้าแล้วเลือกข้อมูลใหม่'],
      [/^not found$/i, 'ไม่พบข้อมูล รายการอาจถูกลบหรือเปลี่ยนไปแล้ว'],
      [/^unknown error$/i, 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ กรุณาลองใหม่อีกครั้ง'],
    ];
    for (const [re, th] of exact) {
      if (re.test(s)) return th;
    }

    s = s
      .replace(/\bserver logs?\b/gi, 'บันทึกระบบสำหรับผู้ดูแล')
      .replace(/\bhealth\/schema\b/gi, 'หน้าสุขภาพระบบ')
      .replace(/\bschema\b/gi, 'โครงสร้างฐานข้อมูล')
      .replace(/\brolled back\b/gi, 'ย้อนรายการกลับแล้ว')
      .replace(/\brollback\b/gi, 'ย้อนรายการ')
      .replace(/\binternal error\b/gi, 'ระบบขัดข้องภายใน')
      .replace(/\binvalid id\b/gi, 'รหัสรายการไม่ถูกต้อง')
      .replace(/\bnot found\b/gi, 'ไม่พบข้อมูล')
      .replace(/\bload failed\b/gi, 'โหลดข้อมูลไม่สำเร็จ')
      .replace(/\bsave failed\b/gi, 'บันทึกข้อมูลไม่สำเร็จ')
      .replace(/\bcreate failed\b/gi, 'สร้างรายการไม่สำเร็จ')
      .replace(/\bdelete failed\b/gi, 'ลบรายการไม่สำเร็จ')
      .replace(/\bretry failed\b/gi, 'ลองส่งซ้ำไม่สำเร็จ')
      .replace(/\bfailed\b/gi, 'ไม่สำเร็จ')
      .replace(/\berror\b/gi, 'ข้อผิดพลาด');
    return s;
  }

  function normalizeToastPayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const out = { ...payload };
    const msg = out.message;
    if (typeof msg === 'string') {
      out.message = humanizeAdminErrorText(msg);
    } else if (msg && typeof msg === 'object' && !React.isValidElement(msg)) {
      out.message = {
        ...msg,
        title: msg.title ? humanizeAdminErrorText(msg.title) : msg.title,
        description: msg.description ? humanizeAdminErrorText(msg.description) : msg.description,
      };
    }
    return out;
  }

  function extraGuidanceFromRaw(raw) {
    if (!raw || typeof raw !== 'object') return '';
    const parts = [];
    if (raw.hint) parts.push(humanizeAdminErrorText(raw.hint));
    const actions = raw.nextActions && typeof raw.nextActions === 'object'
      ? raw.nextActions
      : null;
    if (actions && actions.hint) parts.push(humanizeAdminErrorText(actions.hint));
    if (raw.reconcileUrl) parts.push(`แก้ไขได้ที่ ${raw.reconcileUrl}`);
    if (actions) {
      const urls = Object.entries(actions)
        .filter(([k, v]) => /Url$/.test(k) && typeof v === 'string' && v)
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${v}`);
      if (urls.length) parts.push(urls.join(' · '));
    }
    return Array.from(new Set(parts)).join('\n');
  }

  function toastError(setToast, err, ctx) {
    if (!setToast) return null;
    const action = (ctx && ctx.action) || 'การทำงาน';

    // Normalise into one shape regardless of source.
    let status, code, msg, issues, raw;
    if (err && typeof err === 'object') {
      status = err.status;
      code = err.code;
      msg = err.error || err.message;
      issues = err.issues;
      raw = err.raw || err;
    } else {
      msg = String(err || 'unknown error');
    }

    // Network-level: TypeError "Failed to fetch" or AbortError
    if (!status && (msg === 'Failed to fetch' || /NetworkError/i.test(msg))) {
      const t = { kind: 'danger', message: {
        title: `${action}ไม่สำเร็จ — เชื่อมต่อเซิร์ฟเวอร์ไม่ได้`,
        description: navigator.onLine === false
          ? 'อุปกรณ์ของคุณออฟไลน์อยู่ — เชื่อม Wi-Fi/4G แล้วลองใหม่'
          : 'เซิร์ฟเวอร์อาจกำลังรีสตาร์ท — ลองใหม่ในไม่กี่วินาที',
      } };
      setToast(t); return t;
    }
    if (code === 'TIMEOUT' || msg === 'AbortError') {
      const t = { kind: 'danger', message: {
        title: `${action}ใช้เวลานานเกินกำหนด`,
        description: 'ระบบยังตอบไม่กลับมา — ลองใหม่ในอีกครู่',
      } };
      setToast(t); return t;
    }

    // 401/403 special-case before code map (status alone is enough).
    if (status === 401) code = code || 'UNAUTHORIZED';
    if (status === 403 && !code) code = 'FORBIDDEN';
    if (status === 429 && !code) code = 'RATE_LIMIT';

    // Look up the friendly mapping. Description can be a function for
    // dynamic substitution (e.g. quote the violating field list).
    const tpl = code && ERROR_CODE_MAP[code];
    if (tpl) {
      const description = typeof tpl.description === 'function'
        ? tpl.description({ ...raw, code, error: msg, issues })
        : tpl.description;
      const guidance = extraGuidanceFromRaw(raw);
      const finalDescription = Array.from(new Set([
        description ? humanizeAdminErrorText(description) : (msg && msg !== tpl.title ? humanizeAdminErrorText(msg) : null),
        guidance,
      ].filter(Boolean)))
        .join('\n');
      const t = { kind: 'danger', message: {
        title: tpl.title,
        description: finalDescription || null,
      } };
      setToast(t); return t;
    }

    // Generic fallback — always prefix with the action verb so the user
    // knows WHAT failed, not just THAT something failed.
    const guidance = extraGuidanceFromRaw(raw);
    const friendlyMsg = humanizeAdminErrorText(msg, { status, code, action });
    const t = { kind: 'danger', message: {
      title: `${action}ไม่สำเร็จ`,
      description: [friendlyMsg && friendlyMsg.length > 260 ? friendlyMsg.slice(0, 260) + '…' : friendlyMsg, guidance]
        .filter(Boolean)
        .join('\n'),
    } };
    setToast(t); return t;
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
  window.requireApiFetch = requireApiFetch;
  window.requireApiCall = requireApiCall;
  window.useEscClose = useEscClose;
  window.AdminSkeleton = Skeleton;
  window.toastError = toastError;
  window.ERROR_CODE_MAP = ERROR_CODE_MAP;
  window.humanizeAdminErrorText = humanizeAdminErrorText;
  window.normalizeToastPayload = normalizeToastPayload;
  window.ApiError = ApiError;
  window.apiCall = apiCall;
})();
