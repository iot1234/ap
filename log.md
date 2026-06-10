บั๊กระดับร้ายแรง (ต้องแก้ก่อน)
1. Modal/Dialog แสดงผลผิดทุกหน้า (Critical)
อาการ: ทุก modal (รายละเอียดบิล, แจ้งซ่อมใหม่) แสดงเป็นกล่องเล็กๆ ~312×319px ลอยอยู่กลางคอนเทนต์ ไม่มี backdrop dim เต็มจอ มี scrollbar ซ้อนหลายชั้น เนื้อหาล้นและทับซ้อนกับหน้าหลัก
Root cause (วินิจฉัยจาก DOM/CSS):

.modal-overlay ตั้ง position: fixed; inset: 0 ถูกต้องแล้ว
แต่ parent .anim-in มี transform: matrix(1,0,0,1,0,0) (จาก animation)
ตามสเปก CSS เมื่อ ancestor มี transform != none, position: fixed จะถูก contain อยู่ภายใน ancestor นั้นแทนที่จะ relative ต่อ viewport
ผลคือ overlay/modal มีขนาดเท่ากับ .anim-in (312px) แทนที่จะคลุมทั้งหน้าจอ

คำแนะนำให้ Claude Code แก้:
แก้ใน components/Modal (หรือ Dialog component):
1. ใช้ React Portal: createPortal(<ModalContent/>, document.body)
   เพื่อย้าย modal ออกจาก subtree ที่มี transform
2. หรือถ้าจำเป็นต้องคงไว้: ลบ transform ออกจาก .anim-in
   เปลี่ยนเป็น opacity-only animation:
   .anim-in { animation: fadeIn .2s ease; }
   @keyframes fadeIn { from {opacity:0} to {opacity:1} }
   (อย่าใช้ transform: scale/translate ใน wrapper ของ modal)
2. ประวัติการชำระเงินแสดง error message ดิบ
อาการ: แสดงข้อความ technical error เป็นภาษาอังกฤษให้ผู้ใช้เห็น:

"Please provide either a payload string, a image file, a base64 encoded image, or a image URL"

คำแนะนำให้ Claude Code แก้:
ในหน้า /tenant/payments (ประวัติการชำระเงิน):
1. Map raw API error → user-friendly message ภาษาไทย เช่น
   - "ไม่พบรูปสลิปที่อัปโหลด"
   - "สลิปไม่สามารถอ่านได้ กรุณาอัปโหลดใหม่"
2. เพิ่ม validation client-side ก่อนส่ง upload
3. ใน catch block ของ payment submit:
   const errMap = { 'payload string': 'กรุณาแนบรูปสลิป', ... }
4. แก้ไวยากรณ์ "a image" → "an image" หรือดีกว่านั้นไม่ส่งให้ user เห็น
⚠️ จุดที่ควรปรับปรุง
3. Modal แจ้งซ่อม — Grid หมวดหมู่ผิดรูป
หมวดหมู่ (ไฟฟ้า/ประปา/แอร์/เครื่องใช้/ประตู/อินเทอร์เน็ต) ถูกตัดคำและ overflow แนวนอน เนื่องจาก modal กว้างไม่พอ — จะหายเองเมื่อแก้บั๊กข้อ 1 แต่ควรเพิ่ม:
- .category-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px }
- .category-item { word-break: break-word; text-align: center }
- ตั้ง modal max-width: min(560px, 92vw)
4. ประวัติการชำระเงิน ขาด features

ไม่มีปุ่ม "อัปโหลดสลิปใหม่" สำหรับรายการที่ "ไม่ผ่าน"
ไม่มีปุ่มดูรูปสลิปที่เคยอัปโหลด
ไม่มี pagination/filter ตามสถานะ
แนะนำให้เพิ่ม action column และ status filter chip

5. การจัดวาง (Layout)

โดยรวมหน้าหลัก/โปรไฟล์/สัญญาดูสวยและจัดวางดี ✅
Sidebar นำทางและการ์ดข้อมูลทำได้ดี
ปุ่ม "แจ้งซ่อมใหม่" ในหน้า empty state ทับกับ header เมื่อหน้าจอแคบ — ควรย้ายปุ่มไปอยู่ใต้หัวข้อบน mobile

6. Accessibility & Semantics

<div role="dialog"> ไม่ถูกตั้ง — modal ใช้ <div class="modal-overlay"> เปล่า ไม่มี role="dialog", aria-modal="true", aria-labelledby
ปุ่มปิด (×) ไม่มี aria-label="ปิด"
focus trap ไม่ทำงานใน modal (กด Tab จะหลุดออกไปข้างหลัง)
