// === api-client.js =========================================================
// Bridges localStorage <-> backend API.
// - On load: hydrates localStorage with values fetched from /api/data
// - Wraps localStorage.setItem so any write to whitelisted keys is also POSTed
//   to /api/data/:key with debouncing (250ms).
// - Tenant pages (read-only writes possible via /api/bookings/public for new
//   booking submissions). For all other writes the API requires admin session.
// ===========================================================================

(function () {
  // Keys that are mirrored to /api/data/:key. baankarn_users_v1 was removed
  // because the Users page now talks to /api/admin/users (auth_users table)
  // directly — keeping it here would PUT a localStorage stub blob to the
  // server every time the page rendered.
  const SYNCED_KEYS = [
    'baankarn_rooms_v1',
    'baankarn_config_v1',
    'baankarn_bookings_v1',
    'baankarn_activities_v1',
  ];

  const DEBOUNCE_MS = 250;
  const pendingTimers = new Map();
  const inflight = new Set();
  let isHydrating = false;        // suppress monkey-patch during hydration
  let isAuthenticated = false;     // tenant pages skip PUTs entirely
  let hydratedKeys = new Set();    // which keys came from the server (vs local seed)
  // Optimistic-lock bases: server row `updated_at` per key, captured on
  // hydrate/GET and refreshed from every successful PUT. Sent back as
  // `baseUpdatedAt` so the server can refuse a save built on stale data
  // (someone else / the scheduler / a public booking changed the blob since
  // this tab loaded it) instead of silently overwriting it.
  const baseVersions = new Map();
  // Latest raw value queued per key while a PUT for that key is in flight —
  // PUTs are serialised per key so the follow-up save reuses the fresh
  // updatedAt returned by the previous one (otherwise back-to-back edits
  // from the SAME tab would false-conflict against their own writes).
  const latestQueued = new Map();

  // CSRF token cache — server endpoints under csrfGuard require both the
  // CSRF cookie (set on /api/csrf-token GET) and the matching X-CSRF-Token
  // header on every state-changing request. We fetch once and reuse; a 403
  // response invalidates the cache so the next call refetches.
  let _csrfToken = null;
  async function getCsrfToken(forceRefresh = false) {
    if (_csrfToken && !forceRefresh) return _csrfToken;
    if (forceRefresh) _csrfToken = null;
    try {
      const r = await fetch('/api/csrf-token', { credentials: 'include' });
      if (!r.ok) return null;
      const j = await r.json();
      _csrfToken = j.csrfToken || null;
      return _csrfToken;
    } catch { return null; }
  }
  // Build headers for state-changing requests. Always JSON; attach CSRF.
  async function csrfHeaders(extra = {}) {
    const t = await getCsrfToken();
    return { 'Content-Type': 'application/json', ...(t ? { 'X-CSRF-Token': t } : {}), ...extra };
  }
  async function fetchWithCsrfRetry(url, opts = {}) {
    const headers = await csrfHeaders(opts.headers || {});
    let res = await fetch(url, {
      credentials: 'include',
      ...opts,
      headers,
    });
    if (res.status === 403) {
      _csrfToken = null;
      const retryHeaders = await csrfHeaders(opts.headers || {});
      if (retryHeaders['X-CSRF-Token']) {
        res = await fetch(url, {
          credentials: 'include',
          ...opts,
          headers: retryHeaders,
        });
      }
    }
    if (res.status === 403) _csrfToken = null;
    return res;
  }

  // Save references to original methods BEFORE we wrap them
  const origSetItem = window.localStorage.setItem.bind(window.localStorage);
  const origRemoveItem = window.localStorage.removeItem.bind(window.localStorage);

  // --- Hydrate localStorage from API once on first load --------------------
  // Helper: fetch with a hard timeout so a slow/hanging API doesn't
  // block React mount indefinitely. Without this, hydrate() awaits the
  // GET /api/data forever and the admin sees a white screen until they
  // refresh. AbortController cancels the in-flight request after `ms`
  // so we fall through to "no hydrate" and let React render with
  // localStorage's existing values.
  async function fetchWithTimeout(url, opts, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function hydrate() {
    isHydrating = true;
    try {
      // First, find out if we're authenticated. If not, skip writes silently.
      // 4s timeout — generous for a JSON 200 OK but bounded so a hung
      // session middleware doesn't freeze the entire admin shell.
      try {
        const meRes = await fetchWithTimeout('/api/auth/me', { credentials: 'include' }, 4000);
        if (meRes.ok) {
          const me = await meRes.json();
          isAuthenticated = !!(me && me.user);
        }
      } catch (e) {
        // AbortError or network — treat as "not authenticated" and
        // continue. React will mount + a 401 will redirect to /login
        // on the next privileged request anyway.
        if (e && e.name !== 'AbortError') console.warn('[api-client] auth check error', e.message || e);
      }

      // 8s timeout on /api/data — it can be larger (rooms + bookings +
      // activities) so we give it more room than auth/me but still cap.
      let res;
      try {
        res = await fetchWithTimeout('/api/data', { credentials: 'include' }, 8000);
      } catch (e) {
        console.warn('[api-client] hydrate /api/data timed out — using existing localStorage:', e.message || e);
        return;
      }
      if (!res.ok) {
        console.warn('[api-client] hydrate failed', res.status);
        return;
      }
      const data = await res.json();
      // Per-key row versions for the optimistic-lock handshake.
      const metaUpdatedAt = (data.__meta && data.__meta.updatedAt) || {};
      let count = 0;
      for (const key of SYNCED_KEYS) {
        if (metaUpdatedAt[key]) baseVersions.set(key, metaUpdatedAt[key]);
        if (data[key] !== undefined && data[key] !== null) {
          const serialised = JSON.stringify(data[key]);
          // Reject oversized server values too. If somehow the DB still has
          // a >5 MB row (e.g. cleanup script not yet run on this environment),
          // we'd rather render with a stale-but-tiny localStorage value than
          // hand the renderer a 50 MB string and watch it hang.
          if (serialised.length > 5 * 1024 * 1024) {
            console.warn(
              `[api-client] server returned oversized ${key} ` +
              `(${serialised.length.toLocaleString()} bytes) — discarding ` +
              `to protect the renderer. Run scripts/strip-rooms-photos.js on the server.`
            );
            origRemoveItem(key);
            continue;
          }
          // Use the ORIGINAL setItem so we don't trigger a PUT back to server
          origSetItem(key, serialised);
          hydratedKeys.add(key);
          count++;
        } else {
          // DB has nothing for this key. For tenants, clear stale localStorage
          // so they don't push their local seed to the server (or worse, see
          // diverged data). For admins, leave it — admin React will seed and
          // upload on first save.
          if (!isAuthenticated) {
            origRemoveItem(key);
          }
        }
      }
    } catch (err) {
      console.warn('[api-client] hydrate error', err);
    } finally {
      isHydrating = false;
    }
  }

  // --- Debounced PUT to API ------------------------------------------------
  // Queue holds the most recent value per key that failed to PUT (typically
  // due to 401 — admin's session expired mid-edit). When auth is restored
  // (next AP.me() / AP.login() returns truthy), we flush this queue.
  const retryQueue = new Map();

  function emitSyncError(key, detail = {}) {
    try {
      window.dispatchEvent(new CustomEvent('ap:sync-error', {
        detail: {
          key,
          status: detail.status || 0,
          code: detail.code || null,
          error: detail.error || detail.message || 'sync failed',
        },
      }));
    } catch {}
  }

  // Re-fetch ONE key from the server into localStorage (no PUT echo) after a
  // STALE_WRITE conflict, so the next page interaction starts from the
  // server's truth instead of the stale local copy that just got refused.
  async function rehydrateKey(key) {
    try {
      const r = await fetch(`/api/data/${encodeURIComponent(key)}`, { credentials: 'include' });
      if (!r.ok) return false;
      const j = await r.json();
      if (j && j.updatedAt) baseVersions.set(key, j.updatedAt);
      if (j && j.value !== undefined && j.value !== null) {
        origSetItem(key, JSON.stringify(j.value));
        hydratedKeys.add(key);
        return true;
      }
    } catch (err) {
      console.warn(`[api-client] rehydrate ${key} failed`, err);
    }
    return false;
  }

  async function flushRetryQueue() {
    if (!isAuthenticated) return;
    const entries = Array.from(retryQueue.entries());
    retryQueue.clear();
    for (const [key, value] of entries) {
      try {
        const body = { value };
        const base = baseVersions.get(key);
        if (base) body.baseUpdatedAt = base;
        const r = await fetchWithCsrfRetry(`/api/data/${encodeURIComponent(key)}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
        if (r.ok) {
          let resBody = null;
          try { resBody = await r.json(); } catch {}
          if (resBody && resBody.updatedAt) baseVersions.set(key, resBody.updatedAt);
        } else if (r.status === 409) {
          // The blob changed while we were logged out — do NOT overwrite.
          let resBody = null;
          try { resBody = await r.json(); } catch {}
          await rehydrateKey(key);
          emitSyncError(key, {
            status: 409,
            code: (resBody && resBody.code) || 'STALE_WRITE',
            error: (resBody && resBody.error)
              || 'ข้อมูลถูกแก้ไขจากที่อื่นระหว่างหลุดเซสชัน — โหลดข้อมูลใหม่แล้ว กรุณารีเฟรชหน้าและทำรายการอีกครั้ง',
          });
        } else {
          console.warn(`[api-client] retry PUT ${key} failed`, r.status);
          emitSyncError(key, { status: r.status, error: `retry PUT failed (${r.status})` });
        }
      } catch (err) {
        console.warn(`[api-client] retry PUT ${key} error`, err);
        emitSyncError(key, { error: err && err.message ? err.message : String(err) });
        retryQueue.set(key, value); // keep for next attempt
      }
    }
  }

  async function sendPut(key, rawJson) {
    // Serialise per key: if a PUT is already in flight, park the newest value
    // and send it when the current one settles (with its refreshed base).
    if (inflight.has(key)) { latestQueued.set(key, rawJson); return; }
    let value;
    try { value = JSON.parse(rawJson); } catch { return; }
    inflight.add(key);
    try {
      const body = { value };
      const base = baseVersions.get(key);
      if (base) body.baseUpdatedAt = base;
      const res = await fetchWithCsrfRetry(`/api/data/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        // Session expired or never authenticated. Stash the value so we
        // don't lose admin's edit on the next page load — flushed by
        // login() or me() when auth is restored.
        retryQueue.set(key, value);
        isAuthenticated = false;
      } else if (res.status === 409) {
        let resBody = null;
        try { resBody = await res.json(); } catch {}
        const code = (resBody && resBody.code) || null;
        if (code === 'STALE_WRITE') {
          // Someone else (another admin, a public booking, the scheduler)
          // changed this blob after our tab loaded it. The server refused our
          // save so their change survives. Drop any queued follow-up (it is
          // built on the same stale state), pull the fresh truth into
          // localStorage, and tell the admin to redo their edit.
          latestQueued.delete(key);
          await rehydrateKey(key);
          emitSyncError(key, {
            status: 409,
            code,
            error: (resBody && resBody.error)
              || 'ข้อมูลถูกแก้ไขจากที่อื่น — ระบบยกเลิกการบันทึกนี้และโหลดข้อมูลล่าสุดแล้ว กรุณารีเฟรชหน้าและทำรายการอีกครั้ง',
          });
        } else {
          emitSyncError(key, {
            status: 409,
            code,
            error: (resBody && resBody.error) || 'PUT failed (409)',
          });
        }
      } else if (!res.ok) {
        console.warn(`[api-client] PUT ${key} failed`, res.status);
        let resBody = null;
        try { resBody = await res.json(); } catch {}
        emitSyncError(key, {
          status: res.status,
          code: resBody && resBody.code,
          error: (resBody && resBody.error) || `PUT failed (${res.status})`,
        });
      } else {
        let resBody = null;
        try { resBody = await res.json(); } catch {}
        if (resBody && resBody.updatedAt) baseVersions.set(key, resBody.updatedAt);
      }
    } catch (err) {
      console.warn(`[api-client] PUT ${key} error`, err);
      emitSyncError(key, { error: err && err.message ? err.message : String(err) });
    } finally {
      inflight.delete(key);
      const queued = latestQueued.get(key);
      if (queued !== undefined) {
        latestQueued.delete(key);
        void sendPut(key, queued);
      }
    }
  }

  function pushToApi(key, rawJson) {
    if (pendingTimers.has(key)) clearTimeout(pendingTimers.get(key));
    const timer = setTimeout(() => {
      pendingTimers.delete(key);
      void sendPut(key, rawJson);
    }, DEBOUNCE_MS);
    pendingTimers.set(key, timer);
  }

  // --- Defense-in-depth: shape guard on synced values --------------------
  // Each whitelisted key has an expected JSON shape. The wrapper used to
  // PUT *anything* set on localStorage to the API, which meant a single
  // XSS in admin context could persist garbage server-side. We now reject
  // values that don't parse as JSON or whose top-level type doesn't match
  // the expected shape. Real admin code only ever writes valid shapes.
  const EXPECTED_TYPE = {
    baankarn_rooms_v1:      'object',
    baankarn_config_v1:     'object',
    baankarn_bookings_v1:   'array',
    baankarn_activities_v1: 'array',
  };
  // Hard size cap on every PUT. Without this, a base64 photo upload that
  // accidentally lands in the rooms blob (see project/app.jsx legacy path)
  // could push a 50-100 MB JSON payload to the server every keystroke,
  // causing both server-side memory pressure AND a Chrome renderer OOM
  // when the next page load reads it back. 5 MB is a generous ceiling —
  // a 40-room blob with reasonable metadata sits well under 200 KB.
  const MAX_SYNCED_BYTES = 5 * 1024 * 1024;
  function shapeIsValid(key, raw) {
    const want = EXPECTED_TYPE[key];
    if (!want) return false;
    if (typeof raw !== 'string') return false;
    if (raw.length > MAX_SYNCED_BYTES) {
      console.warn(`[api-client] dropped oversized value for ${key} (${raw.length} bytes > ${MAX_SYNCED_BYTES})`);
      return false;
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return false; }
    if (parsed === null) return false;
    if (want === 'array') return Array.isArray(parsed);
    return typeof parsed === 'object' && !Array.isArray(parsed);
  }

  // --- Wrap localStorage.setItem ------------------------------------------
  // Behavior:
  //   - During hydration: never trigger PUT (we're filling localStorage from server).
  //   - When unauthenticated (tenant): never trigger PUT.
  //   - When authenticated (admin): debounce a PUT to /api/data/:key —
  //     but only if the value passes the shape guard above.
  window.localStorage.setItem = function (key, value) {
    origSetItem(key, value);
    if (!isHydrating && isAuthenticated && SYNCED_KEYS.includes(key)) {
      if (!shapeIsValid(key, value)) {
        console.warn('[api-client] dropped invalid value for', key);
        emitSyncError(key, { code: 'BAD_LOCAL_SHAPE', error: 'local value failed shape/size validation' });
        return;
      }
      pushToApi(key, value);
    }
  };

  // --- Wrap localStorage.removeItem ---------------------------------------
  // For admins, send a real DELETE to remove the row. For others, no-op on API.
  window.localStorage.removeItem = function (key) {
    origRemoveItem(key);
    if (!isHydrating && isAuthenticated && SYNCED_KEYS.includes(key)) {
      // Clear pending PUT for this key first
      if (pendingTimers.has(key)) {
        clearTimeout(pendingTimers.get(key));
        pendingTimers.delete(key);
      }
      // DELETE also goes through csrfGuard now, with one token refresh retry.
      fetchWithCsrfRetry(`/api/data/${encodeURIComponent(key)}`, {
        method: 'DELETE',
      }).catch((err) => console.warn(`[api-client] DELETE ${key} error`, err));
    }
  };

  // --- Public API (window.AP) ---------------------------------------------
  window.AP = {
    hydrate,
    syncedKeys: SYNCED_KEYS,
    isInflight: () => inflight.size > 0 || latestQueued.size > 0 || pendingTimers.size > 0,
    isAuthenticated: () => isAuthenticated,
    isHydrated: (key) => hydratedKeys.has(key),
    // Optimistic-lock base for a synced key (server row updated_at at last
    // hydrate/save). Pages that PUT /api/data/:key directly (pricing,
    // settings) attach this as `baseUpdatedAt` so their save is refused
    // instead of silently overwriting another tab's newer write.
    getBaseVersion: (key) => baseVersions.get(key) || null,
    setBaseVersion: (key, v) => { if (v) baseVersions.set(key, v); },
    // Bypass for the wrapped setItem/removeItem. Use these when you need to
    // mutate localStorage WITHOUT triggering a PUT/DELETE to the server —
    // e.g. shared.jsx clearing a corrupt/oversized stale blob during load
    // (where the wrapped removeItem would inadvertently DELETE the (good)
    // server-side row that we're about to re-hydrate from).
    localBypass: { setItem: origSetItem, removeItem: origRemoveItem },
    async login(username, password) {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (res.ok && data.user) {
        isAuthenticated = true;
        // Drain anything that failed with 401 while logged out.
        flushRetryQueue();
      }
      return data;
    },
    async logout() {
      // /api/auth/logout went under csrfGuard — must include token.
      await fetch('/api/auth/logout', {
        method: 'POST', credentials: 'include',
        headers: await csrfHeaders(),
      });
      isAuthenticated = false;
      window.location.href = '/login';
    },
    async me() {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      const data = await res.json();
      const wasAuth = isAuthenticated;
      isAuthenticated = !!(data && data.user);
      // Auth state transitioned false→true → flush any pending writes.
      if (!wasAuth && isAuthenticated) flushRetryQueue();
      return data;
    },
    async submitPublicBooking(booking) {
      const res = await fetch('/api/bookings/public', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(booking),
      });
      return res.json();
    },
  };

  // --- Boot ----------------------------------------------------------------
  // Block React from rendering until hydration completes (best-effort).
  // We expose a promise that bootstrap code can await before mounting.
  window.AP.ready = hydrate();
})();
