// services/billPayments.js
// Shared notification helpers for the payment-verify flows.
//
// Extracted from server.js so the same logic can be reached from both the
// /api/payments/:id/verify path (still in server.js) and the bill-side
// /api/bills/:id/void + /:id/unmark-paid handlers (moved to
// routes/bills-extras.js). Without this extraction the two places either
// duplicated the lookup or one of them silently skipped the tenant push.

const features = require('./features');
const notifier = require('./notifier');

// Small cached helper — building name shows up in every tenant-facing
// notification so they know who's writing. Lookup the building config
// once per call (rooms + config blob); for high-volume notification
// flows this could be cached but the in-process notifier queue is
// already deduplicating retries.
async function loadBuildingName(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM app_data WHERE key='baankarn_config_v1' LIMIT 1`
    );
    const cfg = rows.length ? rows[0].value : {};
    return (cfg && cfg.building && cfg.building.name)
      || 'บ้านกาญจน์ เรสซิเดนซ์';
  } catch { return 'บ้านกาญจน์ เรสซิเดนซ์'; }
}

// Helper for both verify endpoints — pushes a notification to the tenant
// when their slip is verified, rejected, or reversed. Fire-and-forget;
// logs to notifications_log via notifier.
//
// Message is intentionally formal + actionable. For verify=accept the
// tenant gets a friendly receipt with bill no, period, and amount; for
// reject they get the rejection reason + clear next-step instructions
// (re-upload slip / contact admin) so the failure isn't a dead end.
//
// `ctx` carries the shared pool reference so callers don't need to thread
// it through every queryWithRetry / features.load — passing it once as
// part of the routes/ ctx object keeps server.js + bills-extras.js DRY.
async function notifyTenantOnPayment(ctx, payment, outcome, reason) {
  const pool = ctx && ctx.pool;
  if (!pool || !payment || !payment.tenant_id) return;
  try {
    const flags = await features.load(pool);
    const [{ rows: tRows }, { rows: bRows }] = await Promise.all([
      pool.query(
        `SELECT id, full_name, phone, email, line_user_id, line_oa_id
           FROM tenants
           WHERE id=$1 AND deleted_at IS NULL`,
        [payment.tenant_id]
      ),
      payment.bill_id ? pool.query(
        `SELECT bill_no, period, total, due_date FROM bills WHERE id=$1 LIMIT 1`,
        [payment.bill_id]
      ) : Promise.resolve({ rows: [] }),
    ]);
    if (!tRows.length) return;
    const t = tRows[0];
    const b = bRows[0] || {};
    const billLabel = b.bill_no || (payment.bill_id ? `#${payment.bill_id}` : '-');
    const period = b.period || '';
    const amt = Number(payment.amount);
    const amtStr = Number.isFinite(amt) ? amt.toLocaleString('th-TH', { minimumFractionDigits: 2 }) : '-';
    const buildingName = await loadBuildingName(pool);

    let subject, lines;
    if (outcome === 'verified') {
      subject = '✅ ชำระเงินเรียบร้อยแล้ว — ขอบคุณ';
      lines = [
        `เรียน คุณ${t.full_name}`,
        ``,
        `🎉 ขอบคุณที่ชำระเงินตรงเวลา`,
        ``,
        `บิล: ${billLabel}${period ? ` (รอบ ${period})` : ''}`,
        `จำนวน: ฿${amtStr}`,
        `สถานะ: ชำระแล้ว ✓`,
        ``,
        `ใบเสร็จ: ดูได้ที่พอร์ทัลผู้เช่า /tenant`,
        ``,
        `${buildingName}`,
      ];
    } else if (outcome === 'reversed') {
      // Admin reversed a previously-verified payment (unmark-paid or
      // bill void with force). Tenant must know — without this push
      // they would only find out when the next overdue reminder
      // arrives, which is confusing ("but I already paid?!"). Reason
      // text comes from the admin's input.
      subject = '⚠️ การชำระถูกยกเลิก — โปรดติดต่อแอดมิน';
      lines = [
        `เรียน คุณ${t.full_name}`,
        ``,
        `แอดมินได้ยกเลิกการบันทึกชำระสำหรับบิลด้านล่าง`,
        ``,
        `บิล: ${billLabel}${period ? ` (รอบ ${period})` : ''}`,
        `จำนวน: ฿${amtStr}`,
        `สถานะ: ยังไม่ชำระ`,
        reason ? `\nเหตุผล: ${reason}` : null,
        ``,
        `📋 ขั้นตอนถัดไป:`,
        `   1) ตรวจสอบกับแอดมินว่าการชำระไปอยู่บิลใด`,
        `   2) ถ้าเป็นความเข้าใจผิด ติดต่อ ${buildingName}`,
      ].filter(Boolean);
    } else {
      // Rejected — surface the reason + concrete next steps so the tenant
      // knows what to do. "ติดต่อเจ้าหน้าที่" alone leaves them stuck.
      subject = '❌ สลิปไม่ผ่านการตรวจสอบ — กรุณาส่งใหม่';
      lines = [
        `เรียน คุณ${t.full_name}`,
        ``,
        `เสียใจที่ต้องแจ้งให้ทราบ — สลิปที่ส่งสำหรับบิลด้านล่างไม่ผ่านการตรวจสอบ`,
        ``,
        `บิล: ${billLabel}${period ? ` (รอบ ${period})` : ''}`,
        `จำนวน: ฿${amtStr}`,
        `สถานะ: ยังไม่ชำระ`,
        reason ? `\nเหตุผลที่ปฏิเสธ:\n${reason}` : null,
        ``,
        `📋 ขั้นตอนถัดไป:`,
        `   1) ตรวจสอบสลิปและจำนวนเงินอีกครั้ง`,
        `   2) อัปโหลดสลิปใหม่ที่พอร์ทัลผู้เช่า /tenant`,
        `   3) หากไม่แน่ใจ ติดต่อ ${buildingName}`,
      ].filter(Boolean);
    }
    await notifier.notifyTenant({ pool, features: flags }, t, {
      subject, text: lines.join('\n'),
    });
  } catch (err) {
    console.error('[notifyTenantOnPayment]', err.message);
  }
}

module.exports = {
  loadBuildingName,
  notifyTenantOnPayment,
};
