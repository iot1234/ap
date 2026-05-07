# Changelog

All notable changes since the production buildout began.

Format follows [Keep a Changelog](https://keepachangelog.com/) loosely.
Versions track GitHub commits.

---

## [Unreleased]

### Added — v2 feature expansion
**One unifying primitive: `services/features.js`.** Every new capability is gated by a flag stored in `app_data['baankarn_features_v1']` (JSONB). Admin toggles flags from the new `Features` admin page; routes that depend on a flag are blocked at the server (`503`) when the flag is off.

#### New schema (idempotent CREATE TABLE IF NOT EXISTS)
- `tenants` — full tenant record with phone, encrypted citizen ID, PIN hash for portal login, locale, line_user_id
- `contracts` — contracts linked to tenants
- `bills` — persistent bills (replaces on-demand calc); supports VAT, late fee, recurring charges, void
- `payments` — slip-based payments with admin verification queue, dedup via slip_hash
- `meter_readings` — water/elec history with anomaly detection (n-σ)
- `access_logs` + `access_cards` — RFID/QR/BLE event log + card management
- `notifications_log` — every LINE/email/SMS attempt
- `file_uploads` — tracked photo/slip/signature uploads (local fs + optional S3)
- `tenant_sessions` — separate session table for the tenant portal

#### New services
- `services/features.js` — flag loader, save, `requireFeature(name)` middleware, `attach` middleware
- `services/crypto.js` — AES-256-GCM encrypt/decrypt for citizen ID at rest (HKDF-derived key fallback)
- `services/storage.js` — base64 → local file with size/mime caps, optional S3 hook
- `services/billing.js` — pure bill calculation (rent + utilities + recurring + late fee + VAT)
- `services/notifier.js` — multi-channel dispatch (LINE → Email → log) with `notifications_log` recording
- `services/email.js` — lazy SMTP via nodemailer (optional dep)
- `services/sentry.js` — lazy Sentry init when errorTracking flag + `SENTRY_DSN`
- `services/meter.js` — record / latest / consumption / 3σ anomaly detection
- `services/scheduler.js` — in-process hourly cron: auto-backup, late-fee marking, bill auto-generation

#### New REST endpoints (all behind feature flags where applicable)
- `GET /api/features` (public, enabled-only) — clients use this to hide UI for off features
- `GET /api/admin/features`, `PUT /api/admin/features` — admin read/write of full flag config
- `GET/POST/PUT/DELETE /api/tenants[/:id]` — tenant CRUD with soft delete
- `POST /api/tenant/login`, `POST /api/tenant/logout`, `GET /api/tenant/me` — tenant portal auth (phone + bcrypt PIN, separate session table)
- `GET /api/tenant/bills`, `GET /api/tenant/maintenance` — tenant's own data
- `POST /api/tenant/payments` — tenant uploads slip; gated by `slipUpload`
- `GET /api/payments`, `PUT /api/payments/:id/verify` — admin slip queue
- `GET /api/bills`, `POST /api/bills`, `PUT /api/bills/:id/void` — admin bill management with optional `compute=true` to auto-build
- `POST /api/uploads` — admin photo/signature/citizen-id upload
- `POST /api/meters/:roomId/readings`, `GET /api/meters/:roomId/readings` — meter history
- `POST /api/access/log`, `GET /api/access/logs` — access events
- `GET /api/notifications/log` — admin viewer

#### New UI pages
- `/tenant` — full SPA tenant portal: login, home, bills, slip upload, maintenance form, profile (i18n th/en + dark mode toggle)
- `admin/page-features.jsx` — toggle every feature flag with inline config editing
- `admin/page-payments.jsx` — slip verification queue with image preview and accept/reject
- `admin/page-meters.jsx` — meter history with inline SVG chart + manual entry
- `admin/page-access.jsx` — access log viewer + manual entry form
- `admin/page-notifications.jsx` — read-only notification dispatch log

#### Tests
- `tests/billing.test.js` (6 tests) — bill computation, VAT, late fee, recurring, status logic
- `tests/crypto.test.js` (6 tests) — round-trip, IV randomness, tamper detection, masking, HMAC
- `tests/features.test.js` (4 tests) — `withDefaults` shallow + deep merge, regression guard on flag list
- `tests/storage.test.js` (3 tests) — `parseBase64` data URL + raw + error
- `tests/meter.test.js` (4 tests) — consumption math + type whitelist
- `npm test` runs all 23. All pass on Node 24.

#### Operations
- `services/scheduler.js` — hourly tick: marks overdue bills, runs daily backup at `autoBackup.hourUtc`, generates monthly bills on `billAutoGenerate.dayOfMonth`
- `scripts/backup.js` now exports `run()` for in-process invocation (CLI mode preserved via `require.main` guard)
- `.scheduler-state.json` records last-fired keys to prevent duplicate runs across restarts
- `services/sentry.js` registered as final error middleware in `server.js`

#### Security additions
- AES-256-GCM encryption of citizen IDs (admin must `?includeCitizen=1` to decrypt)
- bcrypt-hashed tenant PIN (4–8 digits)
- Separate `tenant_sessions` table — admin and tenant cookies don't collide
- Slip dedup via HMAC-SHA256 on URL+size — same slip can't be uploaded twice
- Soft-delete switch — admin can choose hard vs. soft delete per deployment

#### Disabled-by-default flags (opt-in)
`tenantPortal`, `slipUpload`, `meterIot`, `accessControl`, `recurringCharges`, `vat`, `email`, `sms`, `errorTracking`, `autoBackup`, `billAutoGenerate`

#### Enabled-by-default flags
`photoUpload`, `lateFee`, `i18n`, `darkMode`, `softDelete`, `citizenIdEncryption`

### Added — Phase E essentials
- `scripts/smoke-test.sh` — bash + curl end-to-end smoke test of all endpoints (auth, public, admin, CSRF defense, rate limit). Usable in CI.
- `docs/api.yaml` — OpenAPI 3.0 spec covering all 19 REST endpoints.
- `Dockerfile` + `.dockerignore` — multi-stage Node 20 Alpine build, non-root user, /health-based healthcheck.
- `.github/workflows/ci.yml` — GitHub Actions: syntax-check, npm install, Docker build.
- `CHANGELOG.md` (this file).
- `LICENSE` (MIT).
- `docs/runbook.md` — operations playbook for common issues.
- `FINAL_REPORT.md` — handover summary of the production buildout.

### Added — Phase B (commit `9f43fae`)
- `TabAudit` viewer in admin Settings — paginated, color-coded audit log table.
- `scripts/backup.js` — JSON dump of all tables. Optional S3-compatible upload via env (`R2_*`). Local rotation to last 30 backups.

### Added — Phase B1+B2+D essentials (commit `c26ad3a`)
- `audit_logs` table + `audit()` helper. Wired into all state-changing endpoints.
- `GET /api/audit` — admin-auth, cursor-paginated.
- `GET /api/reports/overview` + `GET /api/reports/maintenance` — real DB aggregates.
- `helmet` middleware with CSP that allows the React-via-CDN approach.
- `express-rate-limit` on `/api/auth/login` (10 attempts / 15 min / IP).
- README rewritten end-to-end.

### Added — Phase A4 (commit `d804bac`)
- Maintenance ticket system: `maintenance_tickets` table + 5 REST endpoints + Kanban admin page (`page-maintenance.jsx`) + standalone tenant `/maintenance` page with submit form and lookup tab.
- Public submit rate-limited 5/min/IP. Tenant lookup requires both phone AND room_id to prevent enumeration. Admin updates audited.
- LINE notification fires on every new ticket.
- Admin sidebar gets a "แจ้งซ่อม" nav item; tenant TopBar gets a button.

### Added — Phase A3 (commit `ced0755`)
- `services/line.js` — LINE Messaging API push wrapper using built-in `https`. No-op if env not set.
- Public booking POST triggers LINE notify to owner (fire-and-forget).
- `POST /api/notify/bill` — admin-auth, sends formatted bill summary via LINE.
- Admin billing modal "ส่งให้ผู้เช่า" button now actually sends LINE (vs fake toast).

### Added — Phase A2 (commit `984b778`)
- `services/promptpay.js` + `services/pdf.js` — server-side Thai-language PDF rendering with embedded PromptPay EMV QR code.
- `server-assets/fonts/Sarabun-Regular.ttf` + `Sarabun-Bold.ttf` (~90KB each, SIL OFL).
- `POST /api/bills/render` — admin-auth, streams `application/pdf`. Falls back to `PROMPTPAY_TARGET` env var if client doesn't supply one.
- `GET /api/promptpay/qr?target=&amount=&format=png|json` — public QR generator.
- Billing modal "ดาวน์โหลด" button now produces PDF with QR (replacing TXT export).

### Added — Phase A1 (commit `bc03157`)
- `project/booking.html` + `GET /book` — public Thai-language booking form. Validates client + server side, length-capped to bound JSONB payload, handles 429 gracefully, success card with reference number.
- Tenant TopBar gets a terracotta "จองห้อง" button.

### Fixed — pre-A1 deployment (commits `24bcd4c`, `28346e5`, `121f83f`, `8f4fbde`, `bc03157`)
- All admin JSX `<script src>` tags use absolute `/admin/*.jsx` paths so they resolve when URL has trailing slash (`/admin/`).
- API hydration race: `api-client.js` skips its own `localStorage.setItem` wrapper during hydration; tenant pages never push to API (always 401).
- Admin auth gate: shell.jsx's `__bootAdmin()` blocks React mount until `/api/auth/me` confirms authentication, preventing flash of sensitive data.
- `DELETE /api/data/:key` endpoint added; `removeItem` wrapper now sends DELETE instead of PUT null. PUT now rejects null/undefined.
- `sameOrigin` middleware blocks cross-origin Origin/Referer on every state-changing endpoint (lightweight CSRF).

### Initial backend (commits `8f4fbde`, `d1403a7`, `121f83f`)
- Express + PostgreSQL + bcrypt sessions + JSONB k/v store.
- `app_data`, `auth_users`, `user_sessions` tables. Auto-migration on boot.
- Routes: `/`, `/admin`, `/login`, `/health`. APIs: `/api/auth/*`, `/api/data/*`, `/api/bookings/public`.

---

## Conventions

- Branch: single `main` for now; tag releases when stabilizing.
- Commit format: `feat(scope): description` / `fix(scope): description` with body explaining "why".
- Database changes: idempotent SQL inside `migrate()` for now; will move to `migrations/` directory under `node-pg-migrate` in a future release.
- Secrets: env vars only. Never commit `.env`.
