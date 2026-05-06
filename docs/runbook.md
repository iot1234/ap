# Operations Runbook

## Common issues and recovery

### 🔴 `FATAL: DATABASE_URL is not set`
**Cause:** the `ap` Railway service is missing the `DATABASE_URL` env var.

**Fix:**
1. Railway → `ap` service → **Variables** tab.
2. If Postgres is in the **same** Railway project: click `+ New Variable` → `Add Reference` → `Postgres.DATABASE_URL`.
3. If Postgres is in a **different** project: open Postgres → Variables → copy `DATABASE_PUBLIC_URL` → paste in `ap` service as `DATABASE_URL`.
4. Railway redeploys automatically on env change.

---

### 🔴 `connect ECONNREFUSED` or `password authentication failed`
**Cause:** `DATABASE_URL` is wrong (typo, expired password, host unreachable).

**Fix:**
1. Verify the URL by connecting from a local `psql`:
   ```bash
   psql "$DATABASE_URL"
   ```
2. If Postgres password was rotated, copy the new `DATABASE_PUBLIC_URL` from Postgres → Variables and paste into `ap` service.
3. If the URL is on `*.railway.internal`, both services must be in the same Railway project. Internal URLs don't work cross-project.

---

### 🟡 `/admin/` shows blank white page
**Cause:** legacy script paths cached by browser (pre-`24bcd4c`), or new JSX file added without updating `Admin Dashboard.html`.

**Fix:**
1. Hard refresh browser: `Ctrl+Shift+R` (Windows/Linux) or `Cmd+Shift+R` (Mac).
2. Open browser DevTools → Network → look for any `*.jsx` returning 404.
3. If a 404 is on a path like `/admin/admin/...`, the script tag is using a relative path. All script tags in `Admin Dashboard.html` MUST be absolute (`/admin/...`).

---

### 🟡 Login redirects in a loop between `/admin` and `/login`
**Cause:** session cookie not being sent. Common causes:
- `NODE_ENV=production` set but the deployment is on plain HTTP (cookie is `Secure: true` so browser drops it).
- `SESSION_SECRET` was rotated → existing sessions are now invalid.
- Cookie host mismatch (e.g. logging in on `apex` but redirected to `www`).

**Fix:**
1. Confirm the deploy serves HTTPS (Railway public domains do automatically).
2. Open DevTools → Application → Cookies. There should be a `connect.sid` cookie after `/api/auth/login`.
3. If `SESSION_SECRET` was just changed, all existing sessions are invalidated. This is expected. Login again.

---

### 🟡 PDF bill renders but Thai characters are boxes (tofu)
**Cause:** `server-assets/fonts/Sarabun-*.ttf` not present in deployment.

**Fix:**
1. Confirm the files are in the git repo: `git ls-files server-assets/fonts/`.
2. If missing, fetch and commit:
   ```bash
   curl -fsSL https://github.com/google/fonts/raw/main/ofl/sarabun/Sarabun-Regular.ttf \
     -o server-assets/fonts/Sarabun-Regular.ttf
   curl -fsSL https://github.com/google/fonts/raw/main/ofl/sarabun/Sarabun-Bold.ttf \
     -o server-assets/fonts/Sarabun-Bold.ttf
   git add server-assets/fonts && git commit -m "chore: bundle Thai fonts" && git push
   ```

---

### 🟡 PromptPay QR doesn't render in the PDF
**Cause:** `PROMPTPAY_TARGET` env var not set, or client didn't include it in the bill payload.

**Fix:**
1. Set in Railway: `PROMPTPAY_TARGET=0812345678` (10-digit phone) or `1234567890123` (13-digit citizen ID).
2. Or add it via the admin UI in **Settings → Payment** (config field stored in `app_data['baankarn_config_v1'].billing.promptpayTarget`).

---

### 🟡 LINE notification not received
**Cause:** missing or invalid `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_OWNER_USER_ID`.

**Fix:**
1. Go to https://developers.line.biz console → Messaging API channel → **Channel access token (long-lived)**. Generate one and paste into Railway as `LINE_CHANNEL_ACCESS_TOKEN`.
2. Find the owner's `userId`:
   - Easiest: in the LINE Official Account Manager, go to channel → "Messaging API" tab → "Bot basic ID" reveals the bot's ID. To find a USER's ID, set up a webhook briefly that logs `event.source.userId`.
3. Paste user ID as `LINE_OWNER_USER_ID`.
4. Test: submit a test booking on `/book`. Owner should get a LINE message within 5 seconds.
5. Check Railway logs for `[line] push failed: ...` if it didn't arrive.

---

### 🟡 Admin reports show wrong numbers
**Cause:** the older parts of `page-reports.jsx` use Math.sin-based mock projections (not all numbers come from the DB yet).

**Fix:**
The KPI cards and current-period numbers come from real data. Multi-month trend charts are still partly mocked because we don't store historical snapshots yet. Live numbers are accurate.

---

### 🔴 Schema migration changes fail on existing DB
**Cause:** `migrate()` uses `CREATE TABLE IF NOT EXISTS` so it should always be idempotent. If it's failing, check Railway logs for the specific error.

**Fix:**
- Connect via `psql "$DATABASE_URL"` and inspect: `\d app_data`, `\d maintenance_tickets`, etc.
- If a column is missing on an old DB but defined in newer code, add it manually:
  ```sql
  ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS rating SMALLINT;
  ```
- Future schema changes should be moved into a real migrations directory (deferred — see roadmap).

---

## Recovery procedures

### Restoring from a backup
1. Find the most recent backup in `backups/` (or downloaded from R2).
2. Inspect:
   ```bash
   jq '.tables | keys' backup-2026-05-06T...-json
   ```
3. To restore selectively (e.g. only `app_data`):
   ```bash
   psql "$DATABASE_URL" -c "TRUNCATE app_data RESTART IDENTITY"
   jq -r '.tables.app_data[] | [.key, (.value | tostring), .updated_at, .updated_by] | @csv' backup.json > app_data.csv
   psql "$DATABASE_URL" -c "\COPY app_data(key, value, updated_at, updated_by) FROM 'app_data.csv' WITH (FORMAT csv)"
   ```
4. **DO NOT** truncate `auth_users` unless you also have admin password access to recreate.

### Resetting an admin password
The bootstrap user from `ADMIN_PASSWORD` is only created on first migrate. To reset later:
```bash
# Option A: change ADMIN_PASSWORD env var, then DELETE the row to force re-bootstrap
psql "$DATABASE_URL" -c "DELETE FROM auth_users WHERE username='admin'"
# Restart the service — migrate() will re-bootstrap with the new password

# Option B: hash a new password manually
node -e "console.log(require('bcryptjs').hashSync('NewPassword!', 10))"
psql "$DATABASE_URL" -c "UPDATE auth_users SET password_hash='<hash>' WHERE username='admin'"
```

### Rotating PostgreSQL password
1. Railway → Postgres service → Settings → "Rotate Password" (regenerates auto-set password).
2. The internal `DATABASE_URL` reference variable updates automatically.
3. If `ap` service uses the public URL instead, update `DATABASE_URL` manually in `ap` Variables.
4. Active sessions in `user_sessions` are unaffected (they're just rows in a table).

### Rotating SESSION_SECRET
1. Pick a new random string (32+ chars).
2. Replace `SESSION_SECRET` in `ap` Variables.
3. **All existing user sessions become invalid.** Users must log in again. This is expected.

---

## Smoke testing after deploy

```bash
BASE_URL=https://ap-production-bba9.up.railway.app \
ADMIN_USER=admin ADMIN_PASS="$ADMIN_PASSWORD" \
bash scripts/smoke-test.sh
```

Expected output: `Summary: 17 passed, 0 failed` (or similar).

If any failure, the specific endpoint and HTTP status are printed.

---

## Logs to watch in Railway

- `[db] schema ready` — successful migration on boot
- `[db] bootstrapped admin user: admin` — first-time admin creation
- `[server] listening on 8080` — server up
- `[audit] log failed: ...` — non-fatal: a single audit insert failed; investigate but doesn't block users
- `[line] push failed: ...` — LINE API rejected a push (token revoked? user blocked the bot?)
- `[backup] uploaded to ...` — a successful backup run
- `FATAL: ...` — process exits; the service is down until env is fixed

---

## Manual interventions

### Force-clear a problematic JSONB blob
If `baankarn_rooms_v1` got corrupted somehow:
```bash
psql "$DATABASE_URL" -c "DELETE FROM app_data WHERE key='baankarn_rooms_v1'"
```
The next admin page load will hydrate from `buildAdminRooms()` seed and re-save.

### See live audit trail
```bash
psql "$DATABASE_URL" -c "SELECT created_at, user_id, action, entity_type, entity_id FROM audit_logs ORDER BY id DESC LIMIT 50"
```
Or use the admin UI: Settings → Audit log.

### Check pending bookings count
```bash
psql "$DATABASE_URL" -c "SELECT jsonb_array_length(value) FROM app_data WHERE key='baankarn_bookings_v1'"
```
