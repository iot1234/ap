# บ้านกาญจน์ เรสซิเดนซ์ — ระบบจัดการหอพัก

ระบบจัดการหอพัก 5 ชั้น 40 ห้อง ครบวงจร — มีทั้งฝั่ง tenant (ดูสถานะห้อง, จองห้อง, แจ้งซ่อม) และฝั่ง admin (จัดการห้อง, ผู้เช่า, การจอง, บิล, รายงาน, ตั้งค่า)

**Live:** https://ap-production-bba9.up.railway.app

---

## คุณสมบัติ (Features)

### ฝั่งผู้เช่า / สาธารณะ (Tenant / Public)
- **`/`** — Dashboard แสดงสถานะห้องทั้ง 5 ชั้น คลิกเลือกชั้น/ห้อง ดูรายละเอียด
- **`/book`** — ฟอร์มจองห้อง สาธารณะ ไม่ต้อง login
- **`/maintenance`** — แจ้งซ่อม + ดูประวัติของตัวเอง

### ฝั่งผู้ดูแล (Admin — login required)
- **`/login`** — เข้าสู่ระบบ
- **`/admin#overview`** — แดชบอร์ด KPI + รายได้ + กิจกรรมล่าสุด
- **`/admin#rooms`** — จัดการห้องพัก + ผู้เช่า + ข้อมูลครบทุกห้อง
- **`/admin#tenants`** — รายชื่อผู้เช่า + ติดต่อ + สัญญา
- **`/admin#bookings`** — workflow การจอง (pending → reviewing → approved/rejected)
- **`/admin#maintenance`** — Kanban board สำหรับติดตาม ticket แจ้งซ่อม
- **`/admin#billing`** — บิล + ดาวน์โหลด PDF + ส่ง LINE
- **`/admin#reports`** — รายงานรายได้, สถานะห้อง, maintenance
- **`/admin#pricing`** — ตั้งราคาเช่า/ค่าน้ำ/ค่าไฟ + live preview
- **`/admin#settings`** — ข้อมูลตึก, payment, notification, automation, users, system

### API Endpoints
- `GET /health` — health check (รวม DB ping)
- `POST /api/auth/login` — bcrypt + session, rate-limited 10/15min
- `GET /api/auth/me` — returns current session user
- `POST /api/auth/logout`
- `GET /api/data/:key` — public read; `PUT/DELETE` admin only
- `POST /api/bookings/public` — สาธารณะ, rate-limited 5/min/IP
- `POST /api/bills/render` — สร้าง PDF บิลภาษาไทยพร้อม PromptPay QR
- `GET /api/promptpay/qr?target=&amount=&format=png|json` — QR generator
- `POST /api/maintenance` — public submit; `GET` admin list
- `GET /api/maintenance/lookup?roomId=&phone=` — public lookup own tickets
- `PUT /api/maintenance/:id` — admin update
- `POST /api/maintenance/:id/rate` — public rate after completion
- `POST /api/notify/bill` — admin, ส่ง LINE แจ้งบิลใหม่
- `GET /api/audit` — admin, audit log viewer
- `GET /api/reports/overview` — admin, room/booking aggregates
- `GET /api/reports/maintenance` — admin, ticket stats

---

## Stack

- **Frontend:** React 18 (CDN) + Babel standalone (in-browser)
- **Backend:** Node.js 18+ / Express 4
- **Database:** PostgreSQL 14+ (JSONB k/v + relational)
- **Auth:** bcrypt + express-session + connect-pg-simple
- **Security:** helmet (CSP), express-rate-limit on login, sameOrigin CSRF
- **PDF:** PDFKit + Sarabun TTF
- **Notifications:** LINE Messaging API
- **Hosting:** Railway

---

## Local development

```bash
git clone https://github.com/iot1234/ap.git
cd ap
npm install

# Required env
export DATABASE_URL="postgresql://..."
export SESSION_SECRET="random-32+-char-string"
export ADMIN_PASSWORD="your-admin-password"

# Optional env
export ADMIN_USERNAME=admin                 # default 'admin'
export NODE_ENV=production                  # enables secure cookies
export PROMPTPAY_TARGET=0812345678          # phone or 13-digit citizen ID
export LINE_CHANNEL_ACCESS_TOKEN=xxxxx      # from developers.line.biz
export LINE_OWNER_USER_ID=Uxxxxxxxxxx       # owner LINE userId

npm start

# Open:
#   http://localhost:3000/        (tenant)
#   http://localhost:3000/book    (booking form)
#   http://localhost:3000/maintenance
#   http://localhost:3000/login   (admin)
#   http://localhost:3000/admin
#   http://localhost:3000/health
```

The schema migration runs automatically on boot. The first start bootstraps an
admin user with `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

---

## Deployment (Railway)

1. Create a new Railway project, add a **Postgres** service.
2. Connect this GitHub repo as a service.
3. In the GitHub-deployed service's **Variables** tab, add:
   - `DATABASE_URL` — Reference Variable from your Postgres. If Postgres is
     in a different Railway project, copy `DATABASE_PUBLIC_URL` from
     Postgres → Variables instead.
   - `SESSION_SECRET` — random 32+ char string.
   - `ADMIN_PASSWORD` — your initial admin password.
   - `NODE_ENV=production`
   - (optional) `PROMPTPAY_TARGET`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_OWNER_USER_ID`.
4. Generate a public domain (Settings → Networking → Generate Domain).
5. Railway auto-deploys on every push to `main`.

---

## Database schema

Auto-created in `migrate()` on boot:

- **`app_data(key, value JSONB, updated_at, updated_by)`** — JSONB k/v store
  for rooms, bookings, activities, config, admin users.
- **`auth_users(id, username, password_hash, role, created_at)`** — admin
  login accounts.
- **`user_sessions(sid, sess JSON, expire)`** — express-session store.
- **`maintenance_tickets(id, ticket_no, room_id, tenant_*, category,
  priority, status, title, description, assigned_to, scheduled_at,
  completed_at, rating, rating_comment, cost, timestamps)`**
- **`audit_logs(id, user_id, action, entity_type, entity_id, detail JSONB,
  ip, ua, created_at)`**

---

## Security

- **Auth:** bcrypt 10 rounds, session cookies (httpOnly + Secure +
  SameSite=lax), 7-day expiry.
- **Rate limit:** login 10/15min/IP, public booking 5/min/IP, maintenance
  submit 5/min/IP.
- **CSRF defense:** `sameOrigin` middleware rejects cross-origin
  Origin/Referer on all state-changing endpoints; combined with
  SameSite=lax cookies blocks classic CSRF.
- **CSP:** helmet allows React+Babel CDN, Google Fonts; locks down
  everything else.
- **SQL injection:** all queries parameterized.
- **Input validation:** length caps + type checks + whitelist enums on
  every public endpoint.
- **Audit log:** every admin write, login/logout, ticket update logged
  with user_id, IP, UA.

### Security TODO
- [ ] CSRF token (double-submit cookie via `csrf-csrf`)
- [ ] AES-256-GCM at-rest encryption for citizen IDs (when tenant table added)
- [ ] `npm audit` in CI
- [ ] Move secrets to a vault

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          Browser                                 │
│  / (tenant)  /book  /maintenance  /login  /admin (SPA)           │
│  React 18 (CDN) + Babel standalone (in-browser transpile)        │
│  api-client.js: localStorage.set/removeItem → /api/data (admin)  │
└──────────────────────────────┬───────────────────────────────────┘
                               │ HTTPS
┌──────────────────────────────▼───────────────────────────────────┐
│                      Express Server                              │
│  Static: project/*.html, project/*.jsx, project/admin/*          │
│  Routes: /, /admin, /book, /maintenance, /login, /health         │
│  API:    /api/auth/*  /api/data/*  /api/bookings/public          │
│          /api/bills/render  /api/promptpay/qr                    │
│          /api/maintenance/*  /api/audit  /api/reports/*          │
│          /api/notify/bill                                        │
│  Services: pdf.js (PDFKit + Sarabun) | promptpay.js | line.js    │
│  Middleware: helmet | sameOrigin | requireAuth | rateLimit       │
│              audit()                                             │
└──────────────────────────────┬───────────────────────────────────┘
                               │ pg pool (SSL)
┌──────────────────────────────▼───────────────────────────────────┐
│                     PostgreSQL                                   │
│  app_data | auth_users | user_sessions | maintenance_tickets |   │
│  audit_logs                                                      │
└──────────────────────────────────────────────────────────────────┘
```

### Frontend ↔ backend sync
- On page load, `api-client.js` calls `GET /api/data` to hydrate localStorage.
- Wraps `localStorage.setItem` / `removeItem` so future writes (from React
  useEffects) are debounced 250ms and PUT/DELETE to the server. Only
  authenticated admins push writes; tenants get 401 silently.
- Admin session is verified before React mounts (`__bootAdmin` in shell.jsx)
  to prevent flashing sensitive data to unauthenticated users.

---

## Known limitations / Roadmap

### Not yet implemented (intentionally deferred)
- **Tenant portal login** — tenants identify via room_id+phone for lookup; no
  password-based tenant accounts.
- **S3-compatible photo storage** — photos stored as base64 in localStorage;
  doesn't scale beyond ~5MB per room.
- **Automated daily backups** — pg_dump documented but not automated.
- **Vite + TypeScript build** — current stack adds ~2s Babel transpile time
  on first page load.
- **IoT meter integration** — utility readings are entered manually.
- **Full-text search** — admin search is in-memory client-side.
- **i18n** — Thai-only.

### Operational TODO
- Automated backups to S3-compatible storage.
- Sentry / error monitoring.
- Lighthouse CI for perf regressions.

---

## Repo layout

```
.
├── package.json               express, pg, helmet, pdfkit, qrcode, ...
├── server.js                  all backend logic
├── services/
│   ├── pdf.js                 PDFKit + Thai font bill rendering
│   ├── promptpay.js           EMV QR generator
│   └── line.js                LINE Messaging API push
├── server-assets/fonts/       Sarabun TTF (server-side PDF font)
├── project/
│   ├── Dorm Status Dashboard.html  tenant SPA shell
│   ├── Admin Dashboard.html        admin SPA shell
│   ├── login.html                  /login form
│   ├── booking.html                /book form
│   ├── maintenance.html            /maintenance form + lookup
│   ├── api-client.js               localStorage ↔ /api/data bridge
│   ├── app.jsx                     tenant React app
│   └── admin/
│       ├── shared.jsx              constants, utilities, storage
│       ├── ui.jsx                  28+ reusable React components
│       ├── shell.jsx               sidebar, topbar, routing, auth gate
│       ├── page-overview.jsx       dashboard
│       ├── page-rooms.jsx          room CRUD + tenants
│       ├── page-tenants.jsx        tenant list
│       ├── page-bookings.jsx       booking workflow
│       ├── page-maintenance.jsx    Kanban for tickets
│       ├── page-billing.jsx        bills + PDF
│       ├── page-reports.jsx        charts
│       ├── page-pricing.jsx        pricing config
│       └── page-settings.jsx       6-tab settings
└── chats/                     design-phase transcripts
```

---

## Issues / Support

https://github.com/iot1234/ap/issues
