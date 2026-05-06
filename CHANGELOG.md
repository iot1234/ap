# Changelog

All notable changes since the production buildout began.

Format follows [Keep a Changelog](https://keepachangelog.com/) loosely.
Versions track GitHub commits.

---

## [Unreleased]

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
