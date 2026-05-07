# ACCEPTANCE CHECKLIST — เกณฑ์ตรวจรับงานก่อนส่งมอบ

> รายการนี้ใช้ตรวจสอบก่อนปิดโปรเจกต์ — ทุกข้อต้อง ✅ ก่อนส่งมอบ

## A. Infrastructure & DevOps

- [ ] `docker-compose up` ขึ้นทุก service สำเร็จ
- [ ] `docker-compose down -v` ลบ volume ได้สะอาด
- [ ] PostgreSQL + TimescaleDB extension ติดตั้งและใช้งานได้
- [ ] Redis รัน + persistent (AOF enabled)
- [ ] Mosquitto MQTT broker รันและรับ connection ได้
- [ ] MinIO รันและสร้าง bucket อัตโนมัติ
- [ ] Nginx reverse proxy ทำงาน, SSL ผ่าน Cloudflare Tunnel
- [ ] Prometheus + Grafana monitoring stack รัน
- [ ] Health check ทุก service ตอบ `/health` 200 OK
- [ ] `make migrate` รัน Alembic migrations สำเร็จ
- [ ] `make test` รัน test ทั้งหมดผ่าน
- [ ] CI pipeline ตั้งค่าเรียบร้อย (GitHub Actions)

## B. Backend Services — General

ทุก service ต้องมี:
- [ ] Dockerfile + healthcheck
- [ ] `pyproject.toml` ระบุ dependencies + version pinning
- [ ] README.md อธิบาย setup, run, test
- [ ] OpenAPI spec ที่ `/docs`
- [ ] Logging structured (JSON) + correlation ID
- [ ] Metrics endpoint `/metrics` (Prometheus format)
- [ ] Test coverage ≥ 80%
- [ ] No secrets in code (all via .env)
- [ ] Type hints ครบ (mypy passes)
- [ ] Async I/O ทุกที่
- [ ] Error response format มาตรฐาน

## C. Auth Service

- [ ] POST /auth/login ทำงาน + return JWT
- [ ] POST /auth/refresh ทำงาน
- [ ] POST /auth/logout invalidate token (Redis blacklist)
- [ ] POST /auth/register (admin only) ทำงาน
- [ ] GET /auth/me ทำงาน
- [ ] Password hashing ใช้ argon2
- [ ] JWT มี expiry + refresh token rotation
- [ ] Rate limiting login (5 attempts / 15 min)
- [ ] Roles: owner, admin, staff_housekeeper, staff_technician, tenant
- [ ] RBAC decorator `@require_role` ทดสอบครบ

## D. Tenant Service

### Buildings & Rooms
- [ ] CRUD buildings ทำงาน
- [ ] CRUD rooms ทำงาน
- [ ] GET /api/buildings/{id}/floor-map ตอบสถานะห้อง
- [ ] Search rooms by status, floor, price ทำงาน
- [ ] Photo upload ไป MinIO + signed URL
- [ ] Room status transition ตรวจ valid (vacant → occupied → vacant)

### Tenants
- [ ] CRUD tenants ทำงาน
- [ ] Citizen ID encrypted at rest
- [ ] Search by name, phone, citizen_id ทำงาน
- [ ] Document upload (ID card, photo) ทำงาน
- [ ] Blacklist function ทำงาน
- [ ] History tracking ทุก action

### Contracts
- [ ] สร้างสัญญา + auto-generate contract number
- [ ] PDF contract generation ภาษาไทยถูก
- [ ] e-Signature (รับ base64 PNG) บันทึกถูก
- [ ] Check-in flow ทำงาน — บันทึก baseline + ออก RFID + ส่ง LINE welcome
- [ ] Check-out flow ทำงาน — pro-rate + final bill + refund
- [ ] Auto-expire contracts ทำงาน (Celery)
- [ ] Expiring soon alert (30/15/7 days) ทำงาน

## E. Billing Service

- [ ] Bill generation รายเดือน (Celery cron) ทำงาน
- [ ] Bill items: rent + electricity + water + others
- [ ] VAT 7% calculation ถูก
- [ ] Late fee calculation ถูก (1.5%/month)
- [ ] PDF invoice generation สวยงาม
- [ ] Bill voiding + audit log
- [ ] Aged receivable report (0-30, 31-60, 61-90, 90+)
- [ ] Recurring charges (parking, internet) ทำงาน
- [ ] Pro-rate calculation ถูกตอน mid-month checkout

## F. Payment Service

- [ ] PromptPay QR generation — สแกนได้จริง (test กับแอพธนาคาร)
- [ ] SCB webhook handler — verify signature, idempotent
- [ ] K-Bank webhook handler — verify signature, idempotent
- [ ] Cash payment recording (admin only)
- [ ] Slip OCR (Gemini) — accuracy ≥ 90% บนตัวอย่าง 20 สลิป
- [ ] Auto-reconciliation matching (amount + ref + datetime)
- [ ] Manual reconciliation tool ทำงาน
- [ ] Receipt PDF generation
- [ ] Refund flow + audit
- [ ] Idempotency keys ใน critical POSTs

## G. Meter Service

### Hardware Integration
- [ ] MQTT subscriber รับ topic `meter/+/reading` ทำงาน
- [ ] Modbus polling worker (pymodbus) ทำงาน
- [ ] Meter simulator script ใช้งานได้สำหรับ dev
- [ ] OCR endpoint อ่านค่ามิเตอร์จากรูป (Gemini) ทำงาน
- [ ] Meter offline detection (no data > 1 hour) → alert

### Data Storage
- [ ] TimescaleDB hypertable สร้างถูก
- [ ] Continuous aggregates (hourly, daily) ทำงาน
- [ ] Compression policy ใช้กับ chunks เก่า
- [ ] Query 30 days < 2 sec บน 35M rows

### Real-time
- [ ] WebSocket /ws/meters/{room_id} ส่ง real-time
- [ ] Anomaly detection (3σ) ทำงาน
- [ ] Leak detection (water meter ตอนกลางคืน) ทำงาน
- [ ] Alert generation + notification

### Period Closing
- [ ] End-of-month closing ทำงาน
- [ ] Emit event `meter.month_closed` ถูก
- [ ] Bill generation รับ event ถูก

## H. Maintenance Service

- [ ] Tenant submit ticket ผ่าน LINE bot
- [ ] Tenant submit ticket ผ่าน mobile app
- [ ] Auto-categorize (Gemini) accuracy ≥ 80%
- [ ] Photo upload (before/during/after) ทำงาน
- [ ] Assignment to staff ทำงาน + push notification
- [ ] Status workflow ถูกต้อง (open → assigned → in_progress → completed)
- [ ] SLA tracking (Critical/High/Medium/Low)
- [ ] SLA breach alert ทำงาน
- [ ] Cost tracking + tenant_responsible flag
- [ ] Charge to bill (event → billing service)
- [ ] Rating system (1-5 stars) + comments
- [ ] Reopen function ทำงาน
- [ ] Dashboard summary ทำงาน

## I. Access Control Service

### RFID
- [ ] Verify card endpoint < 100ms response
- [ ] Card issuance + activation
- [ ] Auto-disable on payment overdue (30+ days)
- [ ] Re-enable on payment completed
- [ ] Anti-passback logic ทำงาน

### QR Codes
- [ ] Generate temporary QR (TTL + max uses)
- [ ] QR verification ทำงาน
- [ ] Revocation ทำงาน
- [ ] JWT signed correctly

### Mobile BLE
- [ ] BLE unlock ทำงาน (test กับ ESP32 mock)
- [ ] Challenge-response signature verification

### Doors
- [ ] Door device registry ทำงาน
- [ ] Heartbeat / offline detection
- [ ] Emergency unlock (broadcast MQTT command)
- [ ] Lock all doors function (admin)

### Logging
- [ ] Access logs partitioned by month
- [ ] CCTV clip linking
- [ ] Suspicious activity detection
- [ ] WebSocket live feed ทำงาน

## J. Notification Service

### Channels
- [ ] LINE Messaging API ส่งข้อความได้
- [ ] LINE Flex Message สำหรับบิลแสดงถูก
- [ ] Email via SendGrid ส่งได้ (MJML responsive)
- [ ] SMS via Twilio/Thai gateway ส่งได้
- [ ] FCM Push ส่งได้ทั้ง iOS และ Android

### Templates
- [ ] ทุก template ใน list (15+) สร้างและ render ได้
- [ ] Jinja2 variables validation
- [ ] Template editor ใน admin UI

### Logic
- [ ] Smart routing (LINE → Email → SMS) ทำงาน
- [ ] Quiet hours respect ทำงาน
- [ ] User preferences ใช้งานได้
- [ ] Retry on failure (3 attempts, exponential backoff)
- [ ] Broadcast 100+ msg < 1 minute

### LINE Bot
- [ ] Webhook handler รับ message ได้
- [ ] Rich Menu setup
- [ ] Quick Reply commands ทำงาน
- [ ] Forward unhandled messages to admin chat

## K. Report Service

- [ ] Revenue report + group by month/year
- [ ] Revenue forecast (Random Forest, RMSE < 10%)
- [ ] Aged receivable report
- [ ] Occupancy rate report
- [ ] Turnover report
- [ ] Maintenance stats + SLA performance
- [ ] Energy per room report
- [ ] Energy comparison report
- [ ] Energy anomalies report
- [ ] Excel export — formatted with frozen rows, conditional formatting
- [ ] PDF monthly summary — single page beautiful
- [ ] Custom report builder + saved reports
- [ ] All endpoints respond < 2 sec

## L. Web Frontend

### Pages (ทุกหน้าใน sitemap ต้องทำงาน)
- [ ] Login + forgot password
- [ ] Dashboard home with KPIs + alerts
- [ ] Building view (3D + 2D + List)
- [ ] Floor detail with rooms grid
- [ ] Room detail with photos + history
- [ ] Tenants list + search
- [ ] Tenant profile with history timeline
- [ ] New tenant form
- [ ] Contracts list + calendar view
- [ ] Contract wizard (multi-step)
- [ ] Expiring contracts page
- [ ] Bills list + filters
- [ ] Bill generation page
- [ ] Bill detail + payment history
- [ ] Overdue bills page
- [ ] Payments list + reconcile tool
- [ ] Meters dashboard with real-time
- [ ] Meter detail + chart (1d/7d/30d/1y)
- [ ] Meter alerts page
- [ ] Maintenance Kanban board
- [ ] Maintenance ticket detail
- [ ] Maintenance calendar view
- [ ] Access live feed
- [ ] Access cards management
- [ ] Door management
- [ ] Access logs
- [ ] Notifications history
- [ ] Notification templates editor
- [ ] Broadcast page
- [ ] Reports dashboard
- [ ] Revenue report
- [ ] Occupancy report
- [ ] Energy report
- [ ] Custom report builder
- [ ] Staff management
- [ ] Settings (building, rates, billing, integrations)

### Quality
- [ ] Login flow + JWT refresh ทำงาน
- [ ] Role-based menu hiding ถูกต้อง
- [ ] Forms มี Zod validation + error display
- [ ] Data tables sort/filter/paginate
- [ ] Charts render ถูกต้อง
- [ ] WebSocket reconnect on disconnect
- [ ] 3D building view interactive (Three.js)
- [ ] Dark mode ทำงานทุกหน้า
- [ ] Responsive ≥ 768px
- [ ] Lighthouse score ≥ 90
- [ ] Bundle size < 500KB gzipped
- [ ] No console errors
- [ ] Playwright E2E tests pass

## M. Mobile App

### Build & Setup
- [ ] Flutter build ผ่าน Android (release)
- [ ] Flutter build ผ่าน iOS (release)
- [ ] App icon + splash screen
- [ ] Firebase setup (FCM, Auth, Crashlytics, Analytics)
- [ ] App size < 30 MB

### Tenant Features
- [ ] Login + OTP ทำงาน
- [ ] LINE Login ทำงาน
- [ ] Biometric re-login
- [ ] Dashboard render
- [ ] Bill list + filters
- [ ] Bill detail with QR
- [ ] Slip upload + status check
- [ ] Maintenance report (photo + form)
- [ ] Maintenance status tracking
- [ ] BLE door unlock
- [ ] QR generation for guests
- [ ] Meter consumption chart
- [ ] Profile management
- [ ] Notification preferences

### Staff Features
- [ ] My tasks list
- [ ] Task detail with photos
- [ ] Status update flow
- [ ] Schedule calendar
- [ ] Stats dashboard

### Quality
- [ ] FCM push notifications work (test in Firebase Console)
- [ ] Offline mode + queue actions
- [ ] Dark mode ทุกหน้า
- [ ] Locale switch th/en
- [ ] 60 fps scrolling
- [ ] Test coverage ≥ 70%

## N. Integration Tests (ต้องผ่านทุก scenario)

- [ ] Scenario 1: Tenant onboarding flow end-to-end
- [ ] Scenario 2: Monthly billing cycle (generate → notify → pay → reconcile)
- [ ] Scenario 3: Smart meter real-time + anomaly detection
- [ ] Scenario 4: Maintenance workflow (LINE → assign → complete → rate)
- [ ] Scenario 5: Access control + auto-disable on overdue
- [ ] Scenario 6: Mobile app tenant journey end-to-end
- [ ] Scenario 7: Web admin dashboard full smoke test

## O. Performance

- [ ] API response p95 < 500ms
- [ ] API response p99 < 1s
- [ ] Database queries p95 < 200ms
- [ ] WebSocket latency < 100ms
- [ ] Web frontend FCP < 1.5s
- [ ] Mobile cold start < 2s
- [ ] Load test 1000 RPS pass with error rate < 0.1%

## P. Security

- [ ] Bandit scan — no high/critical issues
- [ ] Safety check — no vulnerable deps
- [ ] npm audit — no critical
- [ ] Trivy container scan — no critical
- [ ] JWT manipulation rejected
- [ ] SQL injection prevention works
- [ ] XSS prevention works
- [ ] IDOR protection works
- [ ] CSRF protection on forms
- [ ] Rate limiting works
- [ ] Privilege escalation blocked
- [ ] Webhook signature verification
- [ ] Citizen ID encrypted at rest
- [ ] Secrets only in .env
- [ ] HTTPS enforced (Cloudflare Tunnel)
- [ ] CORS not wildcard
- [ ] Audit log on destructive actions

## Q. Documentation

- [ ] CLAUDE.md (project overview)
- [ ] README.md (root)
- [ ] README.md ทุก service
- [ ] OpenAPI spec ทุก service
- [ ] Architecture Decision Records (ADRs) สำคัญ
- [ ] Database schema diagram
- [ ] Deployment guide
- [ ] Operations runbook
- [ ] User manual (Thai) สำหรับเจ้าของหอ
- [ ] Hardware setup guide สำหรับมิเตอร์ + door controllers

## R. Final Sign-off

- [ ] Code reviewer final approval
- [ ] QA integration final approval
- [ ] All acceptance items above ✅
- [ ] Demo เปิดให้ user ทดลอง
- [ ] Final report (final-report.md) ส่งมอบ
- [ ] Source code repository handover
- [ ] Credentials transferred securely
- [ ] Training session กับเจ้าของหอ

---

## Sign-off Block

**Project:** ระบบจัดการหอพัก
**Version:** 1.0.0
**Sign-off Date:** ____________

**Code Reviewer:** ____________________
**QA Integration:** ____________________
**Orchestrator:** ____________________
**Owner Approval:** ____________________
