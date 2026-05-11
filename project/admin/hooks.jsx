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
      this.requestId = payload.requestId;
      this.raw = payload.raw;
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
        requestId: body && body.requestId,
        raw: body,
      });
    }
    return body;
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
        React.createElement('div', { key: 'h', style: { fontFamily: 'Sora', fontSize: 16, fontWeight: 600, marginBottom: 4 } },
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
    TENANT_HAS_REFS: {
      title: 'ลบผู้เช่าไม่ได้',
      description: 'ผู้เช่ายังมีบิล/สัญญา/บัตรเข้า-ออกเชื่อมโยง — เปิด softDelete หรือลบข้อมูลที่อ้างถึงก่อน',
    },
    // === Service availability ==========================================
    BUSY: { title: 'ระบบกำลังประมวลผลอยู่', description: 'ลองใหม่ในอีกครู่' },
    DB_ERROR: { title: 'ฐานข้อมูลขัดข้อง', description: 'ทีมงานได้รับแจ้งแล้ว — ลองอีกครั้งภายหลัง' },
    TIMEOUT: {
      title: 'คำขอใช้เวลานานเกินกำหนด',
      description: 'เซิร์ฟเวอร์ช้า — ลองใหม่ในไม่กี่วินาที',
    },
  };

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
      const t = { kind: 'danger', message: {
        title: tpl.title,
        description: description || (msg && msg !== tpl.title ? msg : null),
      } };
      setToast(t); return t;
    }

    // Generic fallback — always prefix with the action verb so the user
    // knows WHAT failed, not just THAT something failed.
    const t = { kind: 'danger', message: {
      title: `${action}ไม่สำเร็จ`,
      description: msg && msg.length > 200 ? msg.slice(0, 200) + '…' : msg,
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
  window.useEscClose = useEscClose;
  window.AdminSkeleton = Skeleton;
  window.toastError = toastError;
  window.ERROR_CODE_MAP = ERROR_CODE_MAP;
  window.ApiError = ApiError;
  window.apiCall = apiCall;
})();
