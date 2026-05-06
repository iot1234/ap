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

  // --- Hydrate localStorage from API once on first load --------------------
  async function hydrate() {
    try {
      const res = await fetch('/api/data', { credentials: 'include' });
      if (!res.ok) {
        console.warn('[api-client] hydrate failed', res.status);
        return;
      }
      const data = await res.json();
      let count = 0;
      for (const key of SYNCED_KEYS) {
        if (data[key] !== undefined && data[key] !== null) {
          window.localStorage.setItem(key, JSON.stringify(data[key]));
          count++;
        }
      }
      console.log(`[api-client] hydrated ${count}/${SYNCED_KEYS.length} keys from API`);
    } catch (err) {
      console.warn('[api-client] hydrate error', err);
    }
  }

  // --- Debounced PUT to API ------------------------------------------------
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
          // Not logged in — silently ignore. Keeps tenant pages working.
          // Admin pages will be redirected to /login by server route guard.
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
  const origSetItem = window.localStorage.setItem.bind(window.localStorage);
  window.localStorage.setItem = function (key, value) {
    origSetItem(key, value);
    if (SYNCED_KEYS.includes(key)) {
      pushToApi(key, value);
    }
  };

  // --- Wrap localStorage.removeItem to clear the key on the server too ----
  const origRemoveItem = window.localStorage.removeItem.bind(window.localStorage);
  window.localStorage.removeItem = function (key) {
    origRemoveItem(key);
    // We don't expose DELETE; just push 'null' which our server treats as "store null"
    if (SYNCED_KEYS.includes(key)) {
      pushToApi(key, JSON.stringify(null));
    }
  };

  // --- Public API (window.AP) ---------------------------------------------
  window.AP = {
    hydrate,
    syncedKeys: SYNCED_KEYS,
    isInflight: () => inflight.size > 0,
    async login(username, password) {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      return res.json();
    },
    async logout() {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      window.location.href = '/login';
    },
    async me() {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      return res.json();
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
