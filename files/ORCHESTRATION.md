# ORCHESTRATION — แผนการทำงานของ 10 Agents

> ไฟล์นี้กำหนดลำดับและการประสานงานของทุก agent — orchestrator อ่านเป็นแผนหลัก

## Agent Roster

### Coding Agents (8 ตัว)
| # | Agent | Model | Responsibility |
|---|-------|-------|----------------|
| 1 | `backend-core` | sonnet | Infrastructure, Auth, Shared modules, Docker |
| 2 | `tenant-contract` | sonnet | Buildings, Rooms, Tenants, Contracts |
| 3 | `billing-payment` | sonnet | Bills, Invoices, PromptPay, Webhooks, Reconciliation |
| 4 | `meter-iot` | sonnet | MQTT, Modbus, TimescaleDB, OCR, Anomaly |
| 5 | `maintenance-access` | sonnet | Tickets, RFID, Door Control, CCTV |
| 6 | `notification` | sonnet | LINE/Email/SMS/Push + Reports & Analytics |
| 7 | `web-frontend` | sonnet | Next.js Admin Dashboard |
| 8 | `mobile-app` | sonnet | Flutter App (iOS + Android) |

### Review Agents (2 ตัว)
| # | Agent | Model | Responsibility |
|---|-------|-------|----------------|
| 9 | `code-reviewer` | opus | Code quality, security, type safety, tests |
| 10 | `qa-integration` | opus | Integration tests, E2E, performance, security pen-test |

### Master (1 ตัว)
- `orchestrator` (opus) — coordinator ที่ dispatch งานและรวบรวม result

---

## Dependency Graph

```
                    ┌─────────────────┐
                    │  backend-core   │  Phase 1 (sequential)
                    └────────┬────────┘
                             │
                  ┌──────────┼──────────┬───────────┐
                  ▼          ▼          ▼           ▼
          ┌──────────┐  ┌────────┐  ┌──────┐  ┌──────────┐
          │  tenant  │  │billing │  │meter │  │maintenance│  Phase 2 (parallel)
          │ contract │  │payment │  │ iot  │  │  access   │
          └─────┬────┘  └────┬───┘  └──┬───┘  └─────┬─────┘
                │            │         │            │
                └────────────┴─────────┴────────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │  notification   │  Phase 3 (sequential — depends on all)
                    └────────┬────────┘
                             │
                  ┌──────────┴──────────┐
                  ▼                     ▼
          ┌──────────────┐     ┌──────────────┐
          │ web-frontend │     │  mobile-app  │  Phase 4 (parallel)
          └──────────────┘     └──────────────┘
                  │                     │
                  └──────────┬──────────┘
                             ▼
                    ┌─────────────────┐
                    │ Final Review    │  Phase 5
                    │ + Integration   │
                    └─────────────────┘
```

---

## Execution Plan (สำหรับ orchestrator)

### Phase 0: Setup (Day 0)
```
orchestrator:
  1. อ่าน CLAUDE.md, ACCEPTANCE_CHECKLIST.md
  2. สร้าง git repo, initial commit
  3. Setup TodoWrite พร้อม milestones ทั้งหมด
  4. Verify environment (Python, Node, Flutter, Docker)
```

### Phase 1: Foundation (Day 1-3)
```
orchestrator → Task(backend-core)
  ├── สร้าง shared library
  ├── Auth service
  ├── Docker compose
  └── Migrations พื้นฐาน

→ Task(code-reviewer) ตรวจ backend-core
   ├── ถ้าไม่ผ่าน → ส่งกลับ backend-core แก้
   └── ถ้าผ่าน → continue

→ Task(qa-integration) ทดสอบ basic
   ├── Auth flow ทำงาน
   ├── DB migrations รันได้
   └── Health checks ตอบ

⚠️ BLOCK: ห้ามไป Phase 2 ถ้า Phase 1 ยังไม่ผ่าน
```

### Phase 2: Core Services (Day 4-10) — PARALLEL
```
orchestrator พร้อมกัน:
  ├── Task(tenant-contract)
  ├── Task(billing-payment)
  ├── Task(meter-iot)
  └── Task(maintenance-access)

[เมื่อแต่ละตัวเสร็จ]
  → Task(code-reviewer) ตรวจตัวนั้น
     ├── ไม่ผ่าน → ส่งกลับแก้
     └── ผ่าน → mark complete

⚠️ ทุกตัวต้องผ่าน code-reviewer ก่อนเข้า Phase 3
```

### Phase 3: Integration Layer (Day 11-13)
```
orchestrator → Task(notification)
  ├── เชื่อมทุก service ผ่าน events
  ├── สร้าง templates
  └── LINE webhook handler

→ Task(code-reviewer) ตรวจ notification
→ Task(qa-integration) รัน Scenario 1-5
   ├── ทุก scenario ผ่าน → continue
   └── มี fail → ส่งกลับ service เกี่ยวข้องแก้

⚠️ Integration test ต้องผ่าน 100% ก่อนไป Phase 4
```

### Phase 4: User Interfaces (Day 14-21) — PARALLEL
```
orchestrator พร้อมกัน:
  ├── Task(web-frontend)
  └── Task(mobile-app)

[เมื่อเสร็จ]
  → Task(code-reviewer) ตรวจ frontend code
  → Task(qa-integration) รัน Scenario 6-7 (E2E)
```

### Phase 5: Final QA & Sign-off (Day 22-25)
```
orchestrator:
  1. Task(code-reviewer) — full system review
     └── อ่าน code ทั้ง repo สรุป quality
  
  2. Task(qa-integration) — full regression
     ├── รัน integration tests ทั้งหมด
     ├── รัน E2E ทั้งหมด
     ├── Load testing
     ├── Security pen-test
     └── สร้าง final report

  3. ตรวจ ACCEPTANCE_CHECKLIST.md ทุกข้อ
  
  4. ถ้ามีข้อใดยังไม่ครบ → loop กลับไป agent เกี่ยวข้อง
  
  5. สร้าง final-report.md สรุปทั้งโปรเจกต์
  
  6. แจ้งผู้ใช้ว่าพร้อมส่งมอบ
```

---

## Communication Protocol

### Agent → Orchestrator
ทุก agent ตอนจบงานต้องรายงาน:
```markdown
## Status: COMPLETED / BLOCKED / NEEDS_INPUT

## Summary
[สรุปสิ่งที่ทำ 2-3 ประโยค]

## Files Created/Modified
- path/to/file.py (245 lines)
- ...

## Tests Status
- Unit: 23/23 passed
- Coverage: 87%

## Dependencies Met
- [ ] xxx
- [ ] yyy

## Handoff Notes
[ข้อมูลที่ agent ถัดไปต้องรู้]

## Blockers (ถ้ามี)
- [ปัญหา] — [สิ่งที่ต้องการเพื่อแก้]
```

### Orchestrator → User
ทุก phase ต้อง report:
```markdown
## Milestone: [Name] — STATUS

✅ Completed:
- ...

🔄 In Progress:
- ...

⏸️ Blocked:
- ...

📊 Overall Progress: X/Y tasks complete (Z%)

Next: [phase ถัดไป]
```

---

## Failure Handling

### กรณี code-reviewer reject
```
orchestrator:
  1. อ่าน reject reason
  2. Re-dispatch task ไป agent เดิม + รวม feedback
  3. agent แก้ → re-submit
  4. code-reviewer ตรวจอีกครั้ง
  5. ถ้า reject 3 ครั้งติดกัน → escalate ให้ user ตัดสินใจ
```

### กรณี qa-integration หา bug
```
orchestrator:
  1. อ่าน failed test
  2. Identify service เจ้าของ bug
  3. Re-dispatch agent นั้น + bug details
  4. แก้ → re-test → ทำซ้ำจนผ่าน
```

### กรณี blocked โดย missing dependency
```
orchestrator:
  1. ตรวจ dependency graph
  2. ส่ง agent ที่จำเป็นทำก่อน
  3. resume agent ที่ block
```

---

## Time Budget (estimate)

| Phase | Duration | Agents Involved |
|-------|----------|-----------------|
| 0 — Setup | 1 day | orchestrator |
| 1 — Foundation | 2-3 days | backend-core, reviewer, qa |
| 2 — Core Services | 6-7 days | 4 agents in parallel + reviewers |
| 3 — Integration | 2-3 days | notification + qa |
| 4 — Frontend | 7-8 days | 2 agents in parallel + reviewers |
| 5 — Final QA | 3-4 days | reviewer, qa, orchestrator |
| **Total** | **~25 days** | |

(Note: agents ทำงานพร้อมกันได้ — wall-clock time จริงสั้นกว่านี้)

---

## Quality Gates

ทุก milestone ต้องผ่าน gate ก่อนปิด:

### Gate 1 (จบ Phase 1)
- [ ] docker-compose up ขึ้นได้
- [ ] Auth flow ทำงาน
- [ ] code-reviewer approved
- [ ] basic qa passed

### Gate 2 (จบ Phase 2)
- [ ] 4 services ทำงานแยกกันได้
- [ ] ทั้ง 4 services code-reviewer approved
- [ ] Unit tests coverage ≥ 80% ทุกตัว

### Gate 3 (จบ Phase 3)
- [ ] Events flow ระหว่าง services ทำงาน
- [ ] Integration scenarios 1-5 ผ่าน
- [ ] LINE bot demo ใช้งานได้

### Gate 4 (จบ Phase 4)
- [ ] Web admin login + ใช้งานทุกหน้าได้
- [ ] Mobile app build ผ่านทั้ง iOS + Android
- [ ] E2E test ผ่าน

### Gate 5 (Final)
- [ ] ACCEPTANCE_CHECKLIST.md ครบทุกข้อ
- [ ] No security blockers
- [ ] Performance targets ผ่าน
- [ ] Documentation ครบ
- [ ] Final report ส่งมอบ

---

## ห้ามทำ (Anti-patterns)

- ❌ ห้ามให้ agent ทำงานข้าม phase
- ❌ ห้าม merge code ที่ไม่ผ่าน reviewer
- ❌ ห้าม skip QA แม้ "เร่ง"
- ❌ ห้าม approve โดยไม่รัน test จริง
- ❌ ห้ามลด test coverage ต่ำกว่า 80%
- ❌ ห้าม hardcode secrets ที่ไหนก็ตาม
- ❌ ห้ามให้ orchestrator เขียน code เอง — dispatch อย่างเดียว
