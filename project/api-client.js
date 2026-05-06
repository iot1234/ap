// === api-client.js =========================================================
// Bridges localStorage <-> backend API.
// - On load: hydrates localStorage with values fetched from /api/data
// - Wraps localStorage.setItem so any write to whitelisted keys is also POSTed
//   to /api/data/:key with debouncing (250ms).
// - Tenant pages (read-only writes possible via /api/bookings/public for new
//   booking submissions). For all other writes the API requires admin session.
// ===========================================================================

(function () {
  const SYNCED_KEYS = [
    'baankarn_rooms_v1',
    'baankarn_config_v1',
    'baankarn_bookings_v1',
    'baankarn_activities_v1',
    'baankarn_users_v1',
  ];

  const DEBOUNCE_MS = 250;
  const pendingTimers = new Map();
  const inflight = new Set();
  let isHydrating = false;        // suppress monkey-patch during hydration
  let isAuthenticated = false;     // tenant pages skip PUTs entirely
  let hydratedKeys = new Set();    // which keys came from the server (vs local seed)

  // Save references to original methods BEFORE we wrap them
  const origSetItem = window.localStorage.setItem.bind(window.localStorage);
  const origRemoveItem = window.localStorage.removeItem.bind(window.localStorage);

  // --- Hydrate localStorage from API once on first load --------------------
  async function hydrate() {
    isHydrating = true;
    try {
      // First, find out if we're authenticated. If not, skip writes silently.
      try {
        const meRes = await fetch('/api/auth/me', { credentials: 'include' });
        if (meRes.ok) {
          const me = await meRes.json();
          isAuthenticated = !!(me && me.user);
        }
      } catch {}

      const res = await fetch('/api/data', { credentials: 'include' });
      if (!res.ok) {
        console.warn('[api-client] hydrate failed', res.status);
        return;
      }
      const data = await res.json();
      let count = 0;
      for (const key of SYNCED_KEYS) {
        if (data[key] !== undefined && data[key] !== null) {
          // Use the ORIGINAL setItem so we don't trigger a PUT back to server
          origSetItem(key, JSON.stringify(data[key]));
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
      console.log(`[api-client] hydrated ${count}/${SYNCED_KEYS.length} keys (auth=${isAuthenticated})`);
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

  async function flushRetryQueue() {
    if (!isAuthenticated) return;
    const entries = Array.from(retryQueue.entries());
    retryQueue.clear();
    for (const [key, value] of entries) {
      try {
        const r = await fetch(`/api/data/${encodeURIComponent(key)}`, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        });
        if (!r.ok) console.warn(`[api-client] retry PUT ${key} failed`, r.status);
      } catch (err) {
        console.warn(`[api-client] retry PUT ${key} error`, err);
        retryQueue.set(key, value); // keep for next attempt
      }
    }
  }

  function pushToApi(key, rawJson) {
    if (pendingTimers.has(key)) clearTimeout(pendingTimers.get(key));
    const timer = setTimeout(async () => {
      pendingTimers.delete(key);
      let value;
      try { value = JSON.parse(rawJson); } catch { return; }
      inflight.add(key);
      try {
        const res = await fetch(`/api/data/${encodeURIComponent(key)}`, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        });
        if (res.status === 401) {
          // Session expired or never authenticated. Stash the value so we
          // don't lose admin's edit on the next page load — flushed by
          // login() or me() when auth is restored.
          retryQueue.set(key, value);
          isAuthenticated = false;
        } else if (!res.ok) {
          console.warn(`[api-client] PUT ${key} failed`, res.status);
        }
      } catch (err) {
        console.warn(`[api-client] PUT ${key} error`, err);
      } finally {
        inflight.delete(key);
      }
    }, DEBOUNCE_MS);
    pendingTimers.set(key, timer);
  }

  // --- Wrap localStorage.setItem ------------------------------------------
  // Behavior:
  //   - During hydration: never trigger PUT (we're filling localStorage from server).
  //   - When unauthenticated (tenant): never trigger PUT — they can't write anyway,
  //     and trying would race with admin's data and pollute the DB on first run.
  //     Tenants use dedicated endpoints (e.g. /api/bookings/public) for their writes.
  //   - When authenticated (admin): debounce a PUT to /api/data/:key.
  window.localStorage.setItem = function (key, value) {
    origSetItem(key, value);
    if (!isHydrating && isAuthenticated && SYNCED_KEYS.includes(key)) {
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
      fetch(`/api/data/${encodeURIComponent(key)}`, {
        method: 'DELETE',
        credentials: 'include',
      }).catch((err) => console.warn(`[api-client] DELETE ${key} error`, err));
    }
  };

  // --- Public API (window.AP) ---------------------------------------------
  window.AP = {
    hydrate,
    syncedKeys: SYNCED_KEYS,
    isInflight: () => inflight.size > 0,
    isAuthenticated: () => isAuthenticated,
    isHydrated: (key) => hydratedKeys.has(key),
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
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
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
