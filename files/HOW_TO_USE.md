# คู่มือใช้งาน Bundle — เริ่มต้นโปรเจกต์ระบบจัดการหอพัก

> Bundle นี้ประกอบด้วย project specification + 10 sub-agents สำหรับ Claude Code

## 1. โครงสร้าง Bundle

```
dormitory-system/
├── CLAUDE.md                       ← Context หลัก (Claude Code อ่านอัตโนมัติ)
├── ORCHESTRATION.md                ← แผนการทำงานของ 10 agents
├── ACCEPTANCE_CHECKLIST.md         ← เกณฑ์ตรวจรับงาน (300+ items)
├── HOW_TO_USE.md                   ← ไฟล์นี้
└── .claude/
    └── agents/
        ├── orchestrator.md         ← Master coordinator
        ├── backend-core.md         ← Infrastructure agent
        ├── tenant-contract.md      ← Tenant/Room/Contract
        ├── billing-payment.md      ← Bills + PromptPay
        ├── meter-iot.md            ← Smart meter integration ⭐
        ├── maintenance-access.md   ← Maintenance + RFID
        ├── notification.md         ← LINE + Reports
        ├── web-frontend.md         ← Next.js dashboard
        ├── mobile-app.md           ← Flutter app
        ├── code-reviewer.md        ← Code quality (review agent #1)
        └── qa-integration.md       ← Integration testing (review agent #2)
```

## 2. ติดตั้ง Claude Code

```bash
# ติดตั้ง Claude Code (ต้องใช้ Node.js 18+)
npm install -g @anthropic-ai/claude-code

# ตรวจสอบเวอร์ชัน
claude --version

# Login ครั้งแรก
claude
# จะเปิด browser ให้ login ด้วย Anthropic account
```

## 3. ใช้งาน Bundle

### ขั้นตอนที่ 1: Extract bundle ไปที่โฟลเดอร์ใหม่

```bash
# สมมติว่าได้ zip มาแล้ว
unzip dormitory-system.zip
cd dormitory-system

# ตรวจว่าโครงสร้างถูก
ls -la
ls .claude/agents/
```

### ขั้นตอนที่ 2: สร้าง Git repo

```bash
git init
git add .
git commit -m "Initial: dormitory system spec + 10 agents"
```

### ขั้นตอนที่ 3: เริ่ม Claude Code

```bash
claude
```

### ขั้นตอนที่ 4: สั่งให้ Orchestrator เริ่มงาน

ใน Claude Code session พิมพ์:

```
ใช้ orchestrator agent เพื่อเริ่มสร้างระบบหอพักตาม CLAUDE.md และ ORCHESTRATION.md

ทำงานเป็น phase ตามลำดับ:
1. Foundation (backend-core)
2. Core services (4 ตัว parallel)
3. Integration layer (notification)
4. Frontend (web + mobile parallel)
5. Final QA

ให้รายงาน progress ผ่าน TodoWrite ทุก phase
ให้เรียก code-reviewer และ qa-integration ตามที่ระบุใน ORCHESTRATION.md ห้ามข้าม
```

### ขั้นตอนที่ 5: ติดตามความคืบหน้า

Orchestrator จะรายงาน progress เป็นระยะ พร้อม:
- TodoList แสดง task ที่ทำเสร็จ/กำลังทำ/รอทำ
- Reports จาก code-reviewer และ qa-integration
- Blockers (ถ้ามี)

ใช้คำสั่งเช็ค:
- `"แสดง todo list ปัจจุบัน"`
- `"phase ไหนกำลังทำงานอยู่"`
- `"agent ไหน blocked"`

### ขั้นตอนที่ 6: ตรวจรับงาน

หลัง Phase 5 จบ orchestrator จะสร้าง `final-report.md` พร้อมแสดง:
- ทุกข้อใน ACCEPTANCE_CHECKLIST.md ผ่านหรือไม่
- Test coverage รวม
- Performance metrics
- Security scan results

ใช้คำสั่ง:
```
ตรวจ ACCEPTANCE_CHECKLIST.md ทุกข้อให้ดูว่ามีอะไรยังไม่ครบ
```

## 4. คำสั่งที่ใช้บ่อย

### เรียก agent เฉพาะ
```
ใช้ tenant-contract agent ทำงาน [task description]
```

### ขอ review
```
ใช้ code-reviewer ตรวจ services/billing-service ให้ละเอียด
```

### รัน integration test
```
ใช้ qa-integration ทดสอบ Scenario 2 (monthly billing cycle)
```

### ดูสถานะรวม
```
ใช้ orchestrator สรุปสถานะปัจจุบันของโปรเจกต์
```

### แก้ bug ที่ค้นพบ
```
ใช้ orchestrator dispatch agent ที่เกี่ยวข้องเพื่อแก้ bug ใน services/meter-service ที่ qa เจอ
```

## 5. การ Handle Blockers

เมื่อ agent ติดปัญหา orchestrator จะ:
1. Report ให้คุณทราบ
2. รอคำสั่งจากคุณ ถ้าจำเป็น
3. ลองแก้เองก่อน (เช่น re-dispatch agent)

ถ้า reviewer reject 3 ครั้ง → orchestrator จะถามคุณว่าจะให้ทำยังไง

## 6. ปรับแต่ง Spec

ถ้าต้องการเปลี่ยน:

### เพิ่มฟีเจอร์ใหม่
แก้ใน agent file ที่เกี่ยวข้อง เช่น `.claude/agents/tenant-contract.md`
แล้วบอก orchestrator ว่า:
```
spec ของ tenant-contract update แล้ว ให้ agent ทำเพิ่มตาม spec ใหม่
```

### เปลี่ยน tech stack
แก้ใน `CLAUDE.md` ส่วน "Tech Stack — บังคับใช้"
ระวัง: ถ้าเปลี่ยนกลางคันอาจต้อง rebuild ทั้งหมด

### เปลี่ยน acceptance criteria
แก้ใน `ACCEPTANCE_CHECKLIST.md`
QA จะใช้ checklist ใหม่ใน round ถัดไป

## 7. Tips & Best Practices

### ใช้ Git commit ทุก milestone
```bash
git add . && git commit -m "feat: phase 2 complete"
```
จะได้ rollback ได้ถ้าทำพลาด

### ใช้ branch สำหรับงานใหญ่
```bash
git checkout -b feature/billing-improvements
# ทำงาน
git checkout main
git merge feature/billing-improvements
```

### Backup .claude/agents
ทุก agent file คือ "ความรู้" ของระบบ — backup ก่อนแก้

### อ่าน reports ของ code-reviewer
ทุกครั้งที่ reviewer reject — อ่านเหตุผล แล้วเรียนรู้ pattern
จะได้ปรับ spec ให้ชัดขึ้นในอนาคต

### Test เป็นระยะ
อย่ารอจน Phase 5 ค่อยทดสอบ — ขอ qa-integration ทดสอบทุก phase

## 8. Troubleshooting

### Orchestrator ไม่เรียก reviewer
→ บอกย้ำ: "ตาม ORCHESTRATION.md ห้ามข้าม code-reviewer และ qa-integration"

### Agent ทำซ้ำงานเดิม
→ บอก orchestrator: "อ่าน progress ก่อน ใช้ TodoWrite list ที่มีอยู่"

### Code reviewer reject แล้ว reject อีก
→ ลองอ่าน reject reason เอง อาจมี requirement ที่ไม่ realistic
→ แก้ spec หรือ override โดยบอก orchestrator: "approve ส่วนนี้ด้วย exception"

### QA scenario fail
→ ดู report → ระบุ service เจ้าของ bug → re-dispatch agent

### Token limit hit
→ Claude Code จะ summarize context อัตโนมัติ
→ ถ้าหายข้อมูลสำคัญ — บอก: "อ่าน CLAUDE.md และ ORCHESTRATION.md อีกครั้ง"

## 9. Estimated Timeline

| Phase | Wall-clock Time | Token Usage (est.) |
|-------|-----------------|---------------------|
| Phase 0 — Setup | 30 นาที | ~50K |
| Phase 1 — Foundation | 4-8 ชั่วโมง | ~500K |
| Phase 2 — Core Services | 12-24 ชั่วโมง | ~2M |
| Phase 3 — Integration | 4-8 ชั่วโมง | ~500K |
| Phase 4 — Frontend | 16-30 ชั่วโมง | ~3M |
| Phase 5 — Final QA | 4-8 ชั่วโมง | ~500K |
| **Total** | **40-80 ชั่วโมง** | **~6.5M tokens** |

(จริงๆ อาจเร็วกว่านี้ถ้าทำหลาย agent parallel)

## 10. หลังโปรเจกต์เสร็จ

1. **Deploy:**
   ```bash
   docker-compose -f docker-compose.prod.yml up -d
   ```

2. **Backup database** ทันที:
   ```bash
   make backup
   ```

3. **Setup monitoring alerts:**
   - Grafana → Alerting → Slack/LINE webhook

4. **Create cron jobs:**
   - Bill generation: 1st of month
   - Late fee: daily 9 AM
   - Backup: daily 3 AM
   - Anomaly check: every 15 min

5. **Train staff:**
   - Admin: ใช้ web dashboard
   - Tenant: ใช้ mobile app
   - Owner: ดู monthly reports

## ตัวอย่าง prompt เริ่มงาน (copy ไปใช้ได้เลย)

```
เริ่มสร้างระบบจัดการหอพักตาม spec ที่ให้มา

ขั้นตอน:
1. อ่าน CLAUDE.md, ORCHESTRATION.md, ACCEPTANCE_CHECKLIST.md ให้ครบ
2. ใช้ orchestrator agent เป็น coordinator
3. ทำตาม Phase 0-5 ใน ORCHESTRATION.md
4. ทุก agent ต้องผ่าน code-reviewer และ qa-integration ห้ามข้าม
5. ใช้ TodoWrite tracking ตลอด
6. Commit ทุก milestone
7. รายงาน progress เป็นระยะ

เริ่มจาก Phase 0 — setup environment + create todo list
```
