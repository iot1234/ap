# ระบบจัดการหอพัก — Dormitory Management System

> ไฟล์นี้เป็น context หลักของโปรเจกต์ Claude Code จะอ่านอัตโนมัติทุกครั้งที่เริ่ม session

## ภาพรวมโปรเจกต์

ระบบจัดการหอพัก 5 ชั้นแบบครบวงจร — รองรับการจัดการห้อง/ผู้เช่า, ออกบิลอัตโนมัติ, ดึงค่ามิเตอร์ไฟ real-time, ระบบแจ้งซ่อม, ควบคุมการเข้า-ออก, และแจ้งเตือนผ่าน LINE/Email/SMS

**กลุ่มผู้ใช้:** เจ้าของหอพัก, แอดมิน, แม่บ้าน, ช่างซ่อม, ผู้เช่า

## สถาปัตยกรรม

ระบบเป็น **microservices บน monorepo** ใช้ event-driven architecture

```
Client (Web/Mobile/LINE) → API Gateway (Nginx + JWT)
                              ↓
       ┌──────────────────────┼──────────────────────┐
       Tenant   Billing   Payment   Meter   Maintenance
       Notification   Access   Report   Auth
                              ↓
       PostgreSQL 16 + TimescaleDB | Redis | MinIO
                              ↓
       MQTT (Mosquitto) ← Smart Meters (Modbus/IoT)
```

## Tech Stack — บังคับใช้

- **Backend:** Python 3.12 + FastAPI 0.115+ + SQLAlchemy 2.0 + Pydantic v2 + Alembic (migration)
- **Database:** PostgreSQL 16 + TimescaleDB 2.x extension + Redis 7
- **Real-time:** Mosquitto MQTT broker + WebSocket (FastAPI native)
- **Queue:** Celery + Redis สำหรับ background jobs
- **Frontend Web:** Next.js 15 (App Router) + TypeScript + TanStack Query + Tailwind + shadcn/ui + Chart.js
- **Mobile:** Flutter 3.x + Riverpod
- **IoT:** paho-mqtt, pymodbus
- **External:** LINE Messaging API SDK, SCB Easy API, Google Gemini 2.0 Flash (OCR)
- **Testing:** pytest + pytest-asyncio (backend), Vitest + Playwright (frontend)
- **Deploy:** Docker Compose + Nginx + Cloudflare Tunnel

## โครงสร้างไดเรกทอรี

```
dormitory-system/
├── CLAUDE.md                    ← ไฟล์นี้
├── ACCEPTANCE_CHECKLIST.md      ← เกณฑ์ตรวจรับงาน
├── ORCHESTRATION.md             ← แผนการทำงานของ agents
├── docker-compose.yml
├── .claude/
│   └── agents/                  ← 10 sub-agents
│       ├── orchestrator.md
│       ├── backend-core.md
│       ├── tenant-contract.md
│       ├── billing-payment.md
│       ├── meter-iot.md
│       ├── maintenance-access.md
│       ├── notification.md
│       ├── web-frontend.md
│       ├── mobile-app.md
│       ├── code-reviewer.md
│       └── qa-integration.md
├── services/                    ← Python microservices
│   ├── shared/                  ← models, utils, db base
│   ├── tenant-service/
│   ├── billing-service/
│   ├── payment-service/
│   ├── meter-service/
│   ├── maintenance-service/
│   ├── access-service/
│   ├── notification-service/
│   ├── report-service/
│   └── auth-service/
├── web/                         ← Next.js admin dashboard
├── mobile/                      ← Flutter app
├── infrastructure/              ← nginx, mqtt config, terraform
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
└── docs/                        ← OpenAPI specs, ADRs
```

## หลักการพัฒนา — บังคับ

1. **ภาษาไทยใน UI, English ใน code** — comment สำคัญใน code เป็นไทยได้ แต่ identifier เป็น English
2. **Type-safe ทุกที่** — Pydantic ทุก request/response, TypeScript strict mode
3. **Event-driven** — service สื่อสารผ่าน Redis Pub/Sub และ MQTT ไม่เรียก HTTP กันตรงๆ ยกเว้น read query
4. **Migration-first** — ทุก schema change ต้องผ่าน Alembic migration
5. **Test coverage ≥ 80%** ทุก service
6. **Idempotent APIs** — POST ที่สำคัญต้องรับ idempotency key
7. **Audit log ทุก action** ที่เปลี่ยนแปลงข้อมูล
8. **No secrets in code** — ใช้ .env + env validation

## ข้อมูลธุรกิจ

- หอพัก 5 ชั้น 38 ห้อง (ชั้น 5: 8 ห้อง, ชั้น 4: 8, ชั้น 3: 8, ชั้น 2: 8, ชั้น 1: 6)
- Pricing tier: Penthouse (ชั้น 5), Premium (ชั้น 4), Standard (ชั้น 1-3)
- ค่าเช่า 4,500-8,500 บาท/เดือน
- มิเตอร์ไฟ Eastron SDM ส่งข้อมูลทุก 15 นาทีผ่าน MQTT
- อัตราค่าไฟ 8 บาท/หน่วย, ค่าน้ำเหมาจ่าย 200 บาท/เดือน
- รอบบิล: ออกบิลทุกวันที่ 1, ครบกำหนดวันที่ 15, ดอกเบี้ย 1.5%/เดือน

## สถานะปัจจุบัน

โปรเจกต์อยู่ในสถานะ **เริ่มต้น** — agents ทุกตัวต้องร่วมกันสร้างระบบให้ครบตามสเปก
