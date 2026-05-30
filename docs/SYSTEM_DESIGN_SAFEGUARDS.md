# เอกสารออกแบบระบบ — ความถูกต้อง · การป้องกัน · การแจ้งเตือน (ทุกฟีเจอร์)

> บ้านกาญจน์ เรสซิเดนซ์ — Dormitory Management System
> เอกสารนี้วิเคราะห์ระบบจริง (server.js + 31 services + 11 route modules) แล้วออกแบบให้ทุกฟีเจอร์
> **(1) ทำงานถูกต้อง** **(2) มีการป้องกันหลายชั้น** **(3) แจ้งเตือนชัดเจน**
> สถานะ: ✅ มีแล้ว/แข็งแรง · ⚠️ มีบางส่วน/ควรเสริม · ❌ ยังขาด/ต้องเพิ่ม
> อ้างอิงโค้ดเป็น `file:line` · เครื่องหมาย 🔧 = แก้ไปแล้วใน session นี้ (commit a4162ed)

---

## 0. หลักการออกแบบ — 3 เสาหลัก

### เสา 1 — ความถูกต้อง (Correctness)
| หลักการ | วิธีบังคับใช้ | สถานะระบบ |
|---|---|---|
| **เงินเป็นจำนวนเต็มสตางค์** ห้าม float | คอลัมน์ `NUMERIC(10,2)`, `round2()` ทุกขั้น | ✅ |
| **Invariant คงที่** เช่น `total = subtotal + vat + late_fee` | บังคับใน service + DB CHECK | ✅ |
| **Single source of truth** ต่อข้อมูล 1 ชุด | ⚠️ มี 2 แหล่ง: JSONB blob ↔ relational (ดู §2.3) | ⚠️ |
| **Idempotent** ทำซ้ำได้ผลเดิม | latch key, `ON CONFLICT`, recompute-from-principal | ✅ |
| **Timezone เดียว (Asia/Bangkok)** | `process.env.TZ` ตอน boot (`server.js:15`) | ⚠️ JS=ICT แต่ SQL=UTC (ดู §2.17) |

### เสา 2 — การป้องกันหลายชั้น (Defense in Depth) — 7 ชั้น
ทุก request ที่เปลี่ยนข้อมูลต้องผ่านครบทุกชั้นที่เกี่ยวข้อง:

| ชั้น | กลไก | ที่ตั้ง | สถานะ |
|---|---|---|---|
| 1. Network/probe | บล็อก method แปลก, ตรวจ path เดา source/admin | `server.js:618-720` | ✅ |
| 2. Rate limit | login 5/15m, booking/maintenance 5/min, lookup 10/min | `server.js:374, 1506` | ⚠️ in-memory/ต่อ process |
| 3. Origin/CSRF | `sameOrigin` + double-submit `csrf-csrf` | `middleware/csrf.js` | ✅ |
| 4. AuthN | session (admin) / tenant_session / device-token / HMAC (webhook) | `middleware/auth.js` | ✅ |
| 5. AuthZ (RBAC) | `requireRole(owner>manager>staff>readonly)` | `middleware/auth.js:80` | ✅ |
| 6. Input validation | zod schema (104 ตัว) + length cap + enum whitelist | `schemas/index.js` | ✅ |
| 7. Data integrity | `FOR UPDATE` row-lock + transaction + DB CHECK(13) + unique(20) | ทั่วทั้งระบบ | ✅ (ยกเว้น §2.3) |

### เสา 3 — การสังเกตได้และแจ้งเตือน (Observability & Alerting) — 4 ระดับ
| ระดับ | ปลายทาง | ใช้เมื่อ | สถานะ |
|---|---|---|---|
| **Audit log** | ตาราง `audit_logs` (user, ip, ua) | ทุกการเขียนของ admin | ✅ |
| **Security event** | `audit_logs` + แจ้ง owner อัตโนมัติ (10 กฎ, มี threshold+cooldown) | probe/forbidden/token ผิดซ้ำ | ✅ |
| **Owner alert** | `notifier.notifyOwner` → LINE→Email→log (39 จุด) | งานล้มเหลว, ผิดปกติ | ⚠️ ครอบไม่ครบทุกฟีเจอร์ |
| **Health/readiness** | `/health`, `/api/admin/health`, `/api/admin/production-readiness` | monitoring/ก่อน go-live | ✅ |

> **มาตรฐานการแจ้งเตือนที่เสนอ (ใช้ทุกฟีเจอร์):** ทุก "งานเบื้องหลัง/การเงิน/ความปลอดภัย" ที่ล้มเหลว ต้อง (ก) เขียน `audit_logs` หรือ `notifications_log`, (ข) แจ้ง owner เมื่อเป็น severity ≥ medium, (ค) มี **dedup key + cooldown** กันสแปม, (ง) โผล่ในหน้า admin (`#security-events` / `#health` / `#notifications`)

---

## 1. มาตรฐานกลาง (ใช้ซ้ำทุกฟีเจอร์ — ออกแบบครั้งเดียว)

**1.1 Pipeline เขียนข้อมูลมาตรฐาน** (ทุก POST/PUT/DELETE):
```
sameOrigin → csrfGuard → requireAuth → requireRole(...) → validateBody(zod)
  → BEGIN → SELECT ... FOR UPDATE → ตรวจ invariant → UPDATE/INSERT (มี CHECK/unique)
  → audit() → COMMIT → (แจ้งเตือนถ้าจำเป็น)
```
สถานะ: route modules ใหม่ทำครบ (`routes/rooms.js:105` เป็นต้นแบบที่ดี) ✅

**1.2 มาตรฐานการตอบ error** — มี `code` ที่อ่านได้ + ข้อความไทย + (สำหรับ security) `X-Security-Warning` ✅ — frontend แปลผ่าน `ERROR_CODE_MAP` 🔧 (แก้ให้แสดงหลายบรรทัดแล้ว)

**1.3 มาตรฐาน "งานเบื้องหลังต้องไม่ล้มเงียบ"** — ทุก scheduler tick wrap `try/catch` คืน `{error}` ไม่ throw, `Promise.allSettled` กันงานเดียวล้มทั้งหมด ✅ — **เสนอเพิ่ม:** ทุก `{error}` ต้อง `notifyOwner` แบบ dedup (ตอนนี้บางงานเงียบ)

---

## 2. ออกแบบรายฟีเจอร์

### 2.1 เข้าสู่ระบบแอดมิน (Admin Auth)
- **ถูกต้อง:** bcrypt 10 rounds, `session.regenerate()` กัน fixation (`server.js:787`) ✅
- **ป้องกัน:** rate-limit 5/15m + per-account lockout (survive IP rotation) + constant-time compare กัน enumeration + ลบ session ทุกตัวเมื่อเปลี่ยนรหัส/role (`server.js:9586+`) ✅ · กันลบ owner คนสุดท้าย ✅
- **แจ้งเตือน:** ❌ **ควรเพิ่ม** — login สำเร็จจาก IP/UA ใหม่ → แจ้ง owner; lockout ทำงาน → security event (มี rule `security.admin_unauthorized` แต่ยังไม่ครอบ "login สำเร็จครั้งแรกจากอุปกรณ์ใหม่")

### 2.2 พอร์ทัลผู้เช่า (Tenant Portal)
- **ถูกต้อง:** session แยกตาราง, sid 192-bit เก็บเฉพาะ sha256, re-validate `status='active'`+มีห้องทุก request ✅
- **ป้องกัน:** ❌ **single-factor (เบอร์โทรอย่างเดียว)** — ใครรู้เบอร์เข้าแทนได้ → **เสนอ:** เพิ่ม OTP ไป LINE/SMS ที่ผูกไว้ หรือ PIN ตั้งตอน check-in (เก็บ bcrypt). IDOR ป้องกันครบทุก endpoint ✅
- **แจ้งเตือน:** ⚠️ **เสนอ** — login ผู้เช่าจากอุปกรณ์ใหม่ → แจ้งผู้เช่าผ่าน LINE ("มีการเข้าพอร์ทัลของคุณ")

### 2.3 จัดการห้อง + Sync ข้อมูล (Room Mgmt / Data Bridge) — 🔴 จุดเสี่ยงสูงสุด
- **ถูกต้อง:** ⚠️ มี 2 แหล่ง — JSONB blob `baankarn_rooms_v1` (UI เขียนผ่าน `PUT /api/data/:key`) ↔ ตาราง `rooms_v2`/`tenants`
- **ป้องกัน:** ❌ **`PUT /api/data/:key` เป็น last-write-wins ไม่มี lock/version** (`server.js:1242`) → แอดมินเซฟทับสถานะที่ scheduler/booking แก้ไว้ (ห้องที่ปล่อยกลับมาจอง ฯลฯ). `db/optimisticLock.js` เขียนไว้แล้ว**แต่ไม่ได้ต่อสาย**
  - **แบบที่เสนอ (P0):**
    1. ฝั่ง server: `SELECT value, updated_at FROM app_data WHERE key=$1 FOR UPDATE` → ถ้า client ส่ง `If-Match`/`baseUpdatedAt` ไม่ตรง → ตอบ `409 STALE_WRITE` (ใช้ `updateWithVersion()` ที่มีอยู่)
    2. ฝั่ง client (`api-client.js`): เก็บ `updated_at` ที่ hydrate มา, แนบกลับตอน PUT, เจอ 409 → re-hydrate + merge + เตือน "มีคนแก้พร้อมกัน"
    3. ระยะยาว: ย้าย write หนัก (สถานะห้อง/ผู้เช่า) ไป endpoint relational เฉพาะ (`/api/rooms/:id`) แทน blob ทั้งก้อน
  - blob↔rooms_v2 เขียนคนละ transaction → drift ได้ (`server.js:1242-1268`) → **เสนอ:** รวมเป็น transaction เดียว หรือมี reconcile job + แจ้งเตือน
- **แจ้งเตือน:** ✅ มี `reconcile` + แจ้ง owner เมื่อ sync ล้ม — แต่ควรเพิ่ม alert เมื่อ blob/relational drift เกิน N ห้อง

### 2.4 จัดการผู้เช่า + PII (Tenant Mgmt)
- **ถูกต้อง:** soft-delete (`deleted_at`), citizen ID เก็บ AES-256-GCM ✅
- **ป้องกัน:** ⚠️ **flag `citizenIdEncryption` ปิดได้ runtime → เก็บเลขบัตร plaintext** ในคอลัมน์ชื่อ `..._encrypted` (`tenant-ops.js:604`) → **เสนอ:** ตั้ง `STRICT_PII_KEY=1` เป็น default จริง, ห้ามปิด flag ถ้ามีข้อมูลเข้ารหัสอยู่, หรือถอด toggle ออกจาก UI. การเปิดดูเลขเต็มต้อง owner/manager + audit ✅
- **แจ้งเตือน:** ✅ เปิดดูเลขบัตรเต็ม → audit. **เสนอเพิ่ม:** เปิดดูเกิน N ครั้ง/วัน → แจ้ง owner

### 2.5 จองห้อง + มัดจำ (Booking + Deposit Hold)
- **ถูกต้อง:** hold token 24-byte สุ่ม เก็บ sha256, re-check ownership ตอน submit ใน `FOR UPDATE` ✅
- **ป้องกัน:** ✅ กัน double-book (lock blob+rooms_v2), กัน deposit-slip replay (dedup กับทั้ง `payments` และ `bookings.deposit_slip_hash`), hold หมดอายุ auto-release
- **แจ้งเตือน:** ✅ จองใหม่ → แจ้ง owner. **เสนอ:** hold-sweeper ปล่อยห้อง → log ให้เห็นใน admin

### 2.6 สัญญาเช่า (Contracts: template/invite/fill/sign/PDF)
- **ถูกต้อง:** snapshot due-day + late-fee-rate ตอนเซ็น ใช้ใน PDF ✅ · invitation token เก็บ sha256 + หมดอายุด้วย DB `NOW()` ✅ · 🔧 `GET /api/admin/contract-terms` (เคย 500 ทุกครั้ง — แก้แล้ว)
- **ป้องกัน:** ✅ `uq_contracts_active_room` กัน 2 สัญญา active/ห้อง · draft file ผูกกับ invitation กัน file ID เดา · contract-fill เปิดเฉพาะ token
- **แจ้งเตือน:** ✅ มี contract-expiry tick → แจ้งล่วงหน้า. ⚠️ **บั๊กเล็ก** (`scheduler.js:1444`) ผู้เช่า 2 สัญญา dedup key ทับกัน → แจ้งซ้ำได้ → เสนอแก้ key เป็น `tenantId:contractId`

### 2.7 ออกบิล (Billing: compute/recurring/VAT)
- **ถูกต้อง:** VAT คิดบนฐานที่ถูก (ไม่รวม late fee) ✅ · invariant บังคับ + DB CHECK ✅
- **ป้องกัน:** ✅ `uq_bills_room_period_tenant_active` + `ON CONFLICT` กันบิลซ้ำ · compute ใน transaction · ⚠️ **F4 (นโยบาย):** ผู้เช่าเข้ากลางเดือน welcome bill คิดแต่ค่าเช่า ไม่เคยคิดน้ำ/ไฟเดือนแรก (`tenant-ops.js:1902`) — **ต้องตัดสินใจ:** ตั้งใจ หรือเก็บขาด? · ⚠️ **F9:** single-bill path deactivate one-off charge นอก transaction → บรรทัดหายจาก `other` ได้
- **แจ้งเตือน:** ✅ ออกบิล → แจ้งผู้เช่า. **เสนอ:** bill-gen สำเร็จ/ล้มราย batch → สรุปให้ owner

### 2.8 ค่าปรับล่าช้า (Late Fee)
- **ถูกต้อง:** 2-phase, recompute-from-principal × monthsOver → idempotent ไม่ทบต้น ✅ · cap %/บาท ได้ ✅
- **ป้องกัน:** ⚠️ **F3 (นโยบาย):** ใช้เรต **global ปัจจุบัน** ไม่ใช่เรตที่เซ็นในสัญญา (`scheduler.js:245`) → ขึ้นเรตแล้วเก็บย้อนทุกคน ขัด PDF สัญญา → **เสนอ:** อ่านเรต/grace จาก `contract` snapshot ก่อน fallback global · ⚠️ **M2:** `tickLateFee` เป็นงานเดียวที่ไม่มี advisory lock → 2 replica เขียน audit ซ้ำ → เสนอ wrap lock เหมือนงานอื่น
- **แจ้งเตือน:** ✅ บิลเกินกำหนด → แจ้งผู้เช่า

### 2.9 ชำระเงิน + ตรวจสลิป (Payments + Slip Verify)
- **ถูกต้อง:** ✅ ตรวจยอดตรง, สถานะถูกต้องใต้ lock
- **ป้องกัน:** ✅✅ แข็งแรงมาก — `FOR UPDATE` + re-check, slip-hash dedup ข้ามตาราง, `transaction_ref` unique กัน re-screenshot, cap 3 ครั้ง/บิล, verifier error → park เป็น pending (ไม่ auto-reject) · ⚠️ **SSRF TOCTOU:** outbound verify re-resolve DNS (`slipVerifier.js:829`) → DNS-rebinding ได้ → **เสนอ:** pin IP ที่ผ่าน guard / ใช้ `assertSafeUrlResolved` + agent ที่ผูก IP
- **แจ้งเตือน:** ✅ บันทึก `notifications_log` ทุกครั้ง. **เสนอ:** slip ค้าง pending เกิน X ชม. → เตือน admin (มี verify queue แล้ว)

### 2.10 PromptPay QR
- **ถูกต้อง:** EMV-compliant, มีเทสต์ (`promptpay.test.js`) ✅
- **ป้องกัน:** ✅ validate target (เบอร์ 10 หลัก/บัตร 13 หลัก), cap amount, demo-target detection · token QR HMAC + `timingSafeEqual`
- **แจ้งเตือน:** ไม่จำเป็น (read-only)

### 2.11 มิเตอร์ + ตรวจค่าผิดปกติ (Meter + Anomaly)
- **ถูกต้อง:** anomaly 3σ ด้วย Bessel correction, กัน /0, กันค่าถอยหลัง ✅
- **ป้องกัน:** ✅ `ON CONFLICT (room, type, period)`, MQTT mode ปฏิเสธ (ยังไม่รองรับ), admin entry บังคับ `source='manual'`
- **แจ้งเตือน:** ✅ เจอค่าผิดปกติ → แจ้ง + แสดงหน้า Health (anomaly scanner)

### 2.12 แจ้งซ่อม (Maintenance)
- **ถูกต้อง:** Kanban state machine, ผู้เช่าให้คะแนนหลังเสร็จ ✅
- **ป้องกัน:** ✅ public submit rate-limit 5/min, escape HTML ทุก field (`maintenance.html:411`), lookup ไม่มี oracle (คืน `[]`)
- **แจ้งเตือน:** ✅ ticket ใหม่ → แจ้ง owner. **เสนอ:** ticket ค้าง `open` เกิน N วัน → เตือน

### 2.13 ควบคุมการเข้า-ออก (Access Control)
- **ถูกต้อง:** event log + card lifecycle ✅
- **ป้องกัน:** ✅ device-token หรือ admin, auto-revoke card เมื่อค้างเกิน 30 วัน
- **แจ้งเตือน:** ⚠️ device-token ผิดซ้ำ → security event ✅. **เสนอ:** card ถูก revoke อัตโนมัติ → แจ้งผู้เช่า

### 2.14 ระบบแจ้งเตือน (Notifications: LINE/Email/SMS/Queue)
- **ถูกต้อง:** queue `FOR UPDATE SKIP LOCKED`, fatal-vs-transient, backoff, `X-Line-Retry-Key` dedup ✅
- **ป้องกัน:** 🔧 **H1 email inline ไม่มี timeout** — เพิ่ม connection/greeting/socket timeout แล้ว (กัน request ค้าง) · ⚠️ **M5:** `enqueue` ไม่มี dedup key → re-enqueue (เช่น state file หาย) ส่งซ้ำได้ → **เสนอ:** unique partial `(channel, ref_id, day)` หรือ idempotency key · ⚠️ **L1:** `notifyTenant` LINE บางตัวล้ม → ตัวที่ล้มหายเงียบ → เสนอ fallback เข้า queue เฉพาะตัวที่ล้ม
- **แจ้งเตือน:** ✅ บันทึกทุก dispatch + หน้า `#notifications`. 🔧 หน้า notifications โชว์ error โหลดแล้ว (เคยกลืนเงียบ)

### 2.15 LINE OA / Binding / Webhook / Owner-claim
- **ถูกต้อง:** HMAC verify จาก raw body + per-OA secret + `timingSafeEqual` ✅ · binding token opaque + `FOR UPDATE` ✅
- **ป้องกัน:** ⚠️ **M3:** `/webhook` ไม่มี rate-limit + log ทุก request ที่ fail → flood = DB โต (log amplification) → **เสนอ:** rate-limit เผื่อ burst ของ LINE (เช่น 300/min/IP) + ไม่ log junk ที่ signature ผิดแบบไม่มี body · ⚠️ **L3:** dedup พึ่ง `isRedelivery` อย่างเดียว ไม่เก็บ `webhookEventId` → เสนอตาราง dedup
- **แจ้งเตือน:** ✅ binding/owner-claim → แจ้ง owner

### 2.16 รายงาน (Reports)
- **ถูกต้อง:** 🔧 **revenue/occupancy เคยนับบิล void → แก้แล้ว** (เพิ่ม `status <> 'void'`) · 🔧 ลบ fast-path `jsonb_object_keys_count()` ที่ไม่มีจริง · overdue/aged-receivable/cashflow ถูกต้องอยู่แล้ว ✅
- **ป้องกัน:** ✅ manager+ เท่านั้น, SQL parameterized, where สร้างจาก regex `YYYY-MM`
- **แจ้งเตือน:** ไม่จำเป็น (read-only) — แต่ **เสนอ:** dashboard ขึ้น badge เตือนเมื่อ "ยอดค้างชำระรวม > X" หรือ "occupancy < Y%"

### 2.17 ตัวจับเวลางานเบื้องหลัง (Scheduler)
- **ถูกต้อง:** ⚠️ **M4 timezone split** — JS ใช้ ICT แต่ Postgres `NOW()/CURRENT_DATE` ใช้ UTC → late-fee/reminder เลื่อน ~7 ชม. → **เสนอ (P1):** `SET timezone='Asia/Bangkok'` ตอน connect (pool) ให้ JS กับ SQL ตรงกัน
- **ป้องกัน:** ✅ advisory lock กันรันซ้ำข้าม replica (ยกเว้น tickLateFee — ดู §2.8) · ⚠️ **M1:** `tick()` ไม่มี re-entrancy guard → ถ้า tick ก่อนยังไม่จบ tick ใหม่ทับ → **เสนอ:** `if(_ticking) return; ... finally{_ticking=false}`
- **แจ้งเตือน:** ⚠️ ทุกงานคืน `{error}` แต่ไม่ใช่ทุกงานแจ้ง owner → **เสนอมาตรฐาน:** งานล้ม → `notifyOwner` แบบ dedup + ขึ้นหน้า Health

### 2.18 สำรอง/กู้คืนข้อมูล (Backup/Restore)
- **ถูกต้อง:** dump JSON + integrity hash + verify, optional R2/S3 ✅
- **ป้องกัน:** ✅ restore ต้อง owner + CSRF · ⚠️ R2 endpoint ใช้ sync SSRF check (`storage.js:28`) ไม่ resolve DNS → เสนอใช้ resolved variant
- **แจ้งเตือน:** ✅ backup สำเร็จ → log. ❌ **ควรเพิ่ม (P1):** backup **ล้มเหลว** → แจ้ง owner ทันที (สำคัญมาก — backup เงียบหายคือหายนะ); backup ไม่รันเกิน 48 ชม. → เตือน

### 2.19 Feature Flags + Settings
- **ถูกต้อง:** server เป็น source of truth, flag ปิด → endpoint 503, UI ซ่อนตาม `/api/features` ✅ · ⚠️ **M2 (data):** `features.save` read-modify-write ไม่มี lock → 2 admin toggle พร้อมกันหายอัปเดต → เสนอ `FOR UPDATE` หรือ jsonb merge ใน SQL
- **ป้องกัน:** ✅ owner-gated, cross-flag dependency warning · ⚠️ `system_settings` PUT รับ key อิสระ (ไม่ whitelist) → manager เขียน key มั่วได้ → เสนอ whitelist catalog
- **แจ้งเตือน:** ✅ เปลี่ยน flag → audit. **เสนอ:** ปิด flag สำคัญ (citizenIdEncryption, lateFee, autoBackup) → แจ้ง owner

### 2.20 Audit + Security Events + Health
- **ถูกต้อง/ป้องกัน/แจ้งเตือน:** ✅✅✅ ส่วนนี้เป็นแบบอย่างที่ดี — audit ทุก write, security event 10 กฎมี threshold+cooldown+dedup, health ping DB + queue + scheduler + secrets, production-readiness checklist

---

## 3. ระบบแจ้งเตือนรวม (Unified Alerting Matrix) — แบบที่เสนอ

ออกแบบ "ตารางกฎกลาง" ให้ทุกฟีเจอร์อ้างอิง (ขยายจาก `SECURITY_ALERT_RULES` ที่มีอยู่):

| เหตุการณ์ | severity | ช่อง | ผู้รับ | dedup/cooldown | สถานะ |
|---|---|---|---|---|---|
| login admin จากอุปกรณ์/IP ใหม่ | medium | LINE+Email | owner | ต่ออุปกรณ์ | ❌ เพิ่ม |
| lockout/probe/token ผิดซ้ำ | high | LINE | owner | 10m/30m | ✅ |
| backup ล้มเหลว / ไม่รัน >48ชม. | **high** | LINE+Email | owner | 1/วัน | ❌ **เพิ่ม (P1)** |
| scheduler job ล้ม | medium | LINE | owner | ต่อ job/วัน | ⚠️ บางงาน |
| blob↔relational drift | medium | LINE | owner | 1/ชม. | ⚠️ |
| slip pending ค้าง >X ชม. | low | in-app | admin | — | ❌ เพิ่ม |
| ticket open ค้าง >N วัน | low | LINE | owner | 1/วัน | ❌ เพิ่ม |
| meter anomaly 3σ | medium | LINE | owner | ต่อห้อง | ✅ |
| ปิด flag PII/lateFee/backup | medium | LINE | owner | — | ❌ เพิ่ม |
| ยอดค้างรวม > เกณฑ์ / occupancy < เกณฑ์ | info | dashboard | admin | — | ❌ เพิ่ม |

**กลไกที่ใช้ซ้ำได้ทันที:** `notifier.notifyOwner({pool, features}, {subject, text})` + bucket dedup แบบ `maybeNotifySecurityEvent` (`server.js:519`) — เสนอแยกเป็น `services/alerting.js` ให้ทุก service เรียกผ่าน interface เดียว

---

## 4. แผนลงมือ (Roadmap ตามลำดับความสำคัญ)

### P0 — ความถูกต้อง/ความปลอดภัยของข้อมูล (ทำก่อน)
1. ✅🔧 รายงานนับบิล void, contract-terms 500, checkout total=0, ฿฿ UI — **แก้แล้ว (commit a4162ed)**
2. ❌ **§2.3 JSONB lost-update** — ต่อสาย `optimisticLock` + If-Match (ป้องกันข้อมูลห้อง/ผู้เช่าหาย)
3. ❌ **§2.4 PII** — บังคับเข้ารหัสเลขบัตรเสมอ (ห้ามปิด flag เมื่อมีข้อมูล)

### P1 — เสถียรภาพ/การเงิน/แจ้งเตือนสำคัญ
4. ❌ **§2.18 backup-fail alert** + **§2.17 scheduler timezone** (`SET timezone`) + re-entrancy guard
5. ⚠️ **§2.8 F3** late-fee ใช้เรตสัญญา · **§2.7 F4** นโยบายค่าน้ำ/ไฟเดือนแรก (รอ owner ตัดสิน)
6. ❌ **§3** แยก `services/alerting.js` + เติมกฎที่ขาด

### P2 — เสริมความแข็งแรง
7. ⚠️ tenant 2FA (§2.2) · webhook rate-limit (§2.15) · SSRF pin-IP (§2.9) · features.save lock (§2.19) · rate-limit ใช้ store ร่วม (Redis/DB) แทน in-memory
8. ⚠️ เอกสาร: ปรับ `files/CLAUDE.md` (ผิดสถาปัตยกรรม), `FINAL_REPORT.md`, `docs/api.yaml` (17→146 endpoint), `npm audit fix` (tmp high)

---

## 5. สรุปสิ่งที่แก้ไปแล้วใน session นี้ (commit a4162ed — รอ push, ติดสิทธิ์ 403)
- รายงาน revenue/occupancy ไม่นับบิล void อีกต่อไป (ยืนยันรันจริง: 12,999→3,000)
- ลบ fast-path SQL ที่ไม่มีฟังก์ชันจริง
- `GET /api/admin/contract-terms` คืน 200 (เคย 500)
- checkout ข้ามบิลยอด 0 (เคยทำ checkout ทั้งรายการพัง)
- email มี timeout (กัน request ค้าง)
- `฿฿` → `฿` 10 จุด · toast หลายบรรทัด · หน้า notifications โชว์ error · README แก้เลข rate-limit
- ผ่านเทสต์ 822/822 · สแกน endpoint ทั้งระบบ → ไม่เหลือ 500
