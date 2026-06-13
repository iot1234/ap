// === project/tenant-shared.js =============================================
// Helpers ที่ tenant.jsx (พอร์ทัลผู้เช่า) และ pay.jsx (หน้าชำระเงินสาธารณะ)
// ต้องใช้ "ตรงกันเป๊ะ" — เดิมสองไฟล์ inline สำเนาของตัวเองพร้อมคอมเมนต์
// "Keep this in sync" ซึ่งเสี่ยง drift ทุกครั้งที่เพิ่มเหตุผลใหม่
// ไฟล์นี้เป็น plain JS (ไม่ใช่ JSX) โหลดด้วย <script> ธรรมดา "ก่อน" บันเดิล
// Babel ของแต่ละหน้า แล้วฝากของไว้บน window ฝั่ง JSX มี fallback แบบ degrade
// ไว้กันหน้าพังกรณีไฟล์นี้โหลดไม่สำเร็จ
(function attachTenantShared() {
  'use strict';

  // Translate server-stamped reject reasons + raw 3rd-party verifier strings
  // into tenant-friendly Thai. log.md #2 — the upstream slip provider was
  // leaking English error messages (e.g. "Please provide either a payload
  // string, a image file, a base64 encoded image, or a image URL") into the
  // payment-history list. We intercept those upstream-shaped messages here
  // and convert them to actionable Thai before they reach the tenant.
  function tenantRejectedReason(raw) {
    if (!raw) return raw;
    const s = String(raw);

    // Server-side audit codes (structured, prefix-matched).
    if (s.startsWith('superseded_by_verified_sibling')) return 'ระบบรับสลิปอีกใบสำหรับบิลนี้ไปแล้ว';
    if (s.startsWith('superseded_by_manual_pay'))       return 'แอดมินบันทึกการชำระเงินด้วยช่องทางอื่น (เงินสด/โอน) แล้ว';
    if (s.startsWith('superseded_by_void'))             return 'บิลนี้ถูกยกเลิกแล้ว — โปรดติดต่อแอดมิน';
    if (s.startsWith('unmark_paid_correction'))         return 'แอดมินยกเลิกการบันทึกชำระ — โปรดติดต่อแอดมิน';

    // Verifier upstream — EasySlip / SlipOK / Slip2Go return free-form
    // English on validation errors. Map the families we actually see in
    // production to a Thai message that tells the tenant what to do.
    const lower = s.toLowerCase();
    if (/(payload string|image file|base64|image url|invalid image)/i.test(s)) {
      return 'ไม่พบรูปสลิปหรือสลิปอ่านไม่ออก กรุณาอัปโหลดสลิปใหม่ที่ชัดเจน';
    }
    if (/invalid (api|signature|key|token)/i.test(s) || /unauthor/i.test(lower)) {
      return 'ระบบตรวจสลิปเชื่อมต่อไม่สำเร็จ — โปรดติดต่อแอดมินเพื่อตรวจการตั้งค่า';
    }
    if (/quota|rate.?limit|too many|429/i.test(s)) {
      return 'ระบบตรวจสลิปใช้งานเกินโควต้า — รบกวนติดต่อแอดมิน';
    }
    if (/duplicate|already (used|verified)/i.test(s)) {
      return 'สลิปนี้ถูกใช้แล้ว — กรุณาอัปโหลดสลิปของรายการโอนใหม่';
    }
    if (/amount|number/i.test(s) && /mismatch|not match|differ|incorrect/i.test(s)) {
      return 'ยอดในสลิปไม่ตรงกับยอดบิล กรุณาตรวจสอบและอัปโหลดสลิปใหม่';
    }
    if (/receiver|target|account|destination/i.test(s) && /mismatch|not match|differ|incorrect/i.test(s)) {
      return 'บัญชีปลายทางในสลิปไม่ใช่ของหอพัก — กรุณาตรวจสอบบัญชีผู้รับ';
    }
    if (/network|timeout|econnreset|fetch failed|connect/i.test(lower)) {
      return 'เชื่อมต่อระบบตรวจสลิปไม่สำเร็จ ลองอัปโหลดใหม่หรือแจ้งแอดมิน';
    }

    // English-looking free text → generic friendly fallback. We detect
    // "looks English" by the presence of ASCII letters AND the absence of
    // any Thai letters; anything Thai is already actionable.
    if (/[A-Za-z]/.test(s) && !/[฀-๿]/.test(s)) {
      return 'การตรวจสอบไม่ผ่าน ลองอัปโหลดสลิปใหม่หรือแจ้งแอดมิน';
    }
    return s;
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  window.tenantRejectedReason = tenantRejectedReason;
  window.fileToDataUrl = fileToDataUrl;
})();
