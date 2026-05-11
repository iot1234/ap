# บ้านกาญจน์ เรสซิเดนซ์ — ระบบจัดการหอพัก

ระบบจัดการหอพัก 5 ชั้น 40 ห้อง ครบวงจร — มีทั้งฝั่ง tenant (ดูสถานะห้อง, จองห้อง, แจ้งซ่อม) และฝั่ง admin (จัดการห้อง, ผู้เช่า, การจอง, บิล, รายงาน, ตั้งค่า)

**Live:** https://ap-production-bba9.up.railway.app

---

## คุณสมบัติ (Features)

### ฝั่งผู้เช่า / สาธารณะ (Tenant / Public)
- **`/`** — Dashboard แสดงสถานะห้องทั้ง 5 ชั้น คลิกเลือกชั้น/ห้อง ดูรายละเอียด
- **`/book`** — ฟอร์มจองห้อง สาธารณะ ไม่ต้อง login
- **`/maintenance`** — แจ้งซ่อม + ดูประวัติของตัวเอง
- **`/tenant`** — พอร์ทัลผู้เช่า (login ด้วยเบอร์โทรที่ผูกกับห้อง): ดูบิล อัปโหลดสลิป แจ้งซ่อม โปรไฟล์ + dark mode + i18n th/en (เปิดผ่าน `tenantPortal` flag)

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
- **`/admin#payments`** — คิวตรวจสอบสลิปชำระเงิน (อนุมัติ/ปฏิเสธ)
- **`/admin#meters`** — บันทึกค่ามิเตอร์รายห้อง + กราฟ + ตรวจค่าผิดปกติ (3σ)
- **`/admin#access`** — log การเข้า-ออก + manual entry
- **`/admin#notifications`** — ดูประวัติการส่ง LINE / อีเมล / SMS ทั้งหมด
- **`/admin#features`** — เปิด/ปิดทุกฟีเจอร์ของระบบ (feature flags)
- **`/admin#settings`** — ข้อมูลตึก, payment, notification, automation, users, system

### API Endpoints
**Core (always on):**
- `GET /health` — health check (รวม DB ping)
- `POST /api/auth/login` / `GET /api/auth/me` / `POST /api/auth/logout`
- `GET/PUT/DELETE /api/data/:key` (whitelist) · `POST /api/bookings/public`
- `POST /api/bills/render` — PDF ภาษาไทยพร้อม PromptPay QR
- `GET /api/promptpay/qr?target=&amount=&format=png|json`
- `POST /api/maintenance` (public) · `GET /api/maintenance` (admin) · lookup · update · rate
- `POST /api/notify/bill` · `GET /api/audit` · `GET /api/reports/{overview,aged-receivable,maintenance}` · `GET /api/reports/bills.xlsx`

**v2 — feature-flag gated:**
- `GET /api/features` — public flag map (enabled-only)
- `GET/PUT /api/admin/features` — admin flag config
- Tenants CRUD: `GET/POST/PUT/DELETE /api/tenants[/:id]`
- Tenant portal: `POST /api/tenant/login`, `/logout`, `GET /api/tenant/me`, `/bills`, `/maintenance`, `POST /api/tenant/payments`
- Bills: `GET/POST /api/bills`, `PUT /api/bills/:id/void`
- Payments: `GET /api/payments`, `PUT /api/payments/:id/verify`
- Uploads: `POST /api/uploads` (gated by `photoUpload`)
- Meters: `GET/POST /api/meters/:roomId/readings` (gated by `meterIot`)
- Access: `POST /api/access/log`, `GET /api/access/logs` (gated by `accessControl`)
- Notification log: `GET /api/notifications/log`

---

## Stack

- **Frontend:** React 18 (CDN) + Babel standalone (in-browser)
- **Backend:** Node.js 18+ / Express 4
- **Database:** PostgreSQL 14+ (JSONB k/v + 13 relational tables)
- **Auth:** bcrypt + express-session (admin) + custom tenant_sessions table (tenant portal)
- **Security:** helmet (CSP), rate-limit, sameOrigin CSRF, AES-256-GCM (citizen ID)
- **PDF:** PDFKit + Sarabun TTF
- **Notifications:** LINE Messaging API + optional SMTP (nodemailer)
- **Background:** in-process scheduler (auto-backup, late-fee marking, monthly bill generation)
- **Hosting:** Railway

### Optional integrations (loaded only when feature flag is on)
- `nodemailer` — SMTP email channel (optionalDependency)
- `@sentry/node` — error tracking (optionalDependency)
- `@aws-sdk/client-s3` — backup upload (lazy-required by `scripts/backup.js`)

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
export DISABLE_BACKGROUND_JOBS=1            # optional: diagnostics only
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

## Feature flags (v2)

ทุกฟีเจอร์เสริมเปิด/ปิดได้จากหน้า **`/admin#features`** เก็บค่าใน `app_data['baankarn_features_v1']` (JSONB) — ฝั่ง server บล็อก endpoint ที่ flag ปิด (HTTP 503), ฝั่ง client เรียก `/api/features` เพื่อซ่อน UI ที่ไม่ใช้

| flag | default | คำอธิบาย |
|------|---------|----------|
| `tenantPortal` | off | พอร์ทัลผู้เช่าที่ `/tenant` (login ด้วยเบอร์โทรที่ผูกกับห้อง) |
| `slipUpload` | off | อัปโหลดสลิปชำระเงิน + คิวตรวจสอบ |
| `photoUpload` | **on** | อัปโหลดรูปห้อง / ลายเซ็น / สำเนาบัตร |
| `meterIot` | off | บันทึกค่ามิเตอร์ + ตรวจค่าผิดปกติ |
| `accessControl` | off | log การเข้า-ออก + RFID hooks |
| `recurringCharges` | off | ค่าใช้จ่ายประจำในบิล (parking, internet) |
| `lateFee` | **on** | ค่าปรับชำระล่าช้า |
| `vat` | off | ภาษีมูลค่าเพิ่ม |
| `email` | off | SMTP สำรอง LINE |
| `i18n` | **on** | th/en switcher ใน tenant portal |
| `darkMode` | **on** | dark theme toggle |
| `softDelete` | **on** | ลบแล้วเก็บ `deleted_at` |
| `citizenIdEncryption` | **on** | AES-256-GCM at-rest |
| `errorTracking` | off | ส่ง exception เข้า Sentry |
| `autoBackup` | off | dump JSON รายวันที่กำหนด |
| `billAutoGenerate` | off | ออกบิลอัตโนมัติทุก 1st |

### Required env เพิ่มเติม (เมื่อเปิด flag)
- `CITIZEN_ID_KEY` — base64 32-byte key สำหรับ AES-256-GCM (ถ้าไม่ตั้ง จะใช้ HKDF จาก `SESSION_SECRET` แทนพร้อม warning)
- `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` — เปิด `email` flag (รหัสผ่านอ่านจาก env เท่านั้น ไม่เก็บใน DB)
- `SENTRY_DSN` — เปิด `errorTracking` flag
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET` — `autoBackup` flag จะอัปโหลดเข้า S3-compatible

## Testing

```bash
npm test                  # unit/integration tests, no live DB needed
bash scripts/smoke-test.sh # end-to-end HTTP smoke (needs running server)
```

ทดสอบครอบคลุม service หลัก, schema validation, auth/rate-limit, billing, tenant payments, PDF/PromptPay, storage, encryption, backup/restore, LINE OA/binding, health checks และ regression guards สำหรับ route สำคัญ

## Database schema

Auto-created in `migrate()` on boot:

**Core (always present):**
- `app_data` — JSONB k/v: rooms, config, bookings, activities, users, **features**
- `auth_users`, `user_sessions`, `maintenance_tickets`, `audit_logs`

**v2 (created by same idempotent migration block):**
- `tenants` — phone, encrypted citizen ID + tail, line_user_id, locale, soft-delete
- `contracts` — contract_no, tenant_id, room_id, dates, monthly_rent, deposit
- `bills` — persistent bills with VAT, late_fee, status (pending/paid/overdue/void)
- `payments` — bill_id, amount, slip_url, slip_hash (HMAC dedup), verified_by
- `meter_readings` — room_id × meter_type × reading_at (water/elec)
- `access_logs`, `access_cards` — events + card lifecycle
- `notifications_log` — every dispatch with status + error
- `file_uploads` — category × ref_id × url (room_photo, slip, contract_signature, citizen_id_image)
- `tenant_sessions` — separate from `user_sessions` so admin/tenant don't collide

---

## Security

- **Auth:** bcrypt 10 rounds, session cookies (httpOnly + Secure +
  SameSite=lax), 7-day expiry.
- **Rate limit:** login 10/15min/IP, public booking 5/min/IP, maintenance
  submit 5/min/IP.
- **CSRF defense:** `sameOrigin` middleware rejects cross-origin
  Origin/Referer on state-changing endpoints, then privileged writes also
  require a double-submit CSRF cookie/header from `/api/csrf-token`.
- **CSP:** helmet allows React+Babel CDN, Google Fonts; locks down
  everything else.
- **SQL injection:** all queries parameterized.
- **Input validation:** length caps + type checks + whitelist enums on
  every public endpoint.
- **Audit log:** every admin write, login/logout, ticket update logged
  with user_id, IP, UA.

### Security TODO
- [ ] Add `npm audit --audit-level=high` to CI/deploy checks
- [ ] Move secrets to a managed vault when available
- [ ] Add browser-level smoke tests for admin/tenant critical flows

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
