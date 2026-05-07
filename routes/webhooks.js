// routes/webhooks.js
// External-service webhooks. We verify HMAC signatures inline because these
// requests don't have a session cookie or origin header to use sameOrigin.

const express = require('express');
const lineSvc = require('../services/line');
const lineBinding = require('../services/lineBinding');
const notifier = require('../services/notifier');
const features = require('../services/features');

module.exports = function buildWebhooksRouter(ctx) {
  const { pool, audit } = ctx;
  const r = express.Router();

  // POST /webhook/line
  // LINE sends Bot events here. We use the raw body (captured by the json
  // parser's `verify` callback in server.js) to compute HMAC over the exact
  // bytes LINE sent — re-stringifying req.body would change whitespace +
  // key order and break verification.
  r.post('/line', async (req, res) => {
    const raw = req.rawBody || JSON.stringify(req.body || {});
    const sig = req.headers['x-line-signature'];
    if (!lineSvc.verifyWebhookSignature(raw, sig)) {
      return res.status(403).json({ error: 'invalid signature' });
    }
    // Always 200 quickly so LINE doesn't retry. Process events asynchronously.
    res.json({ ok: true });
    try {
      const events = Array.isArray(req.body?.events) ? req.body.events : [];
      for (const ev of events) handleEvent(ev).catch((e) => {
        console.error('[line webhook] event handler:', e.message);
      });
    } catch (err) {
      console.error('line webhook outer:', err);
    }
  });

  async function handleEvent(ev) {
    const userId = ev.source?.userId || ev.source?.groupId || '';

    // Always log the inbound event for forensics.
    try {
      await pool.query(
        `INSERT INTO notifications_log (channel, recipient, subject, body, status)
         VALUES ('line-in', $1, $2, $3, 'sent')`,
        [userId, ev.type || 'unknown', JSON.stringify(ev).slice(0, 4000)]
      );
    } catch { /* ignore */ }

    // Only handle text messages from individual users.
    if (ev.type !== 'message' || ev.message?.type !== 'text') return;
    if (!userId || !ev.replyToken) return;

    const text = String(ev.message.text || '').trim();

    // 1) Binding code — match BIND-XXXXXXXX
    if (/^BIND-[A-F0-9]{4,16}$/i.test(text)) {
      let result;
      try {
        result = await lineBinding.tryBind(pool, {
          code: text,
          lineUserId: userId,
        });
      } catch (err) {
        console.error('[line bind] error:', err.message);
        await lineSvc.replyText(ev.replyToken, '⚠️ ระบบขัดข้อง — โปรดลองใหม่ภายหลัง');
        return;
      }
      if (result.ok) {
        const room = result.roomId ? ` (ห้อง ${result.roomId})` : '';
        await lineSvc.replyText(
          ev.replyToken,
          `✅ ผูกบัญชี LINE สำเร็จ\n` +
          `${result.fullName}${room}\n\n` +
          `คุณจะได้รับแจ้งเตือนบิล / แจ้งซ่อม / ประกาศต่าง ๆ ผ่านช่องนี้`
        );
        // Tell the owner so they have visibility
        try {
          const flags = await features.load(pool);
          notifier.notifyOwner({ pool, features: flags }, {
            subject: 'มีผู้เช่าผูก LINE OA',
            text: `${result.fullName}${room} ผูกบัญชี LINE สำเร็จ`,
          }).catch(() => {});
        } catch { /* ignore */ }
        return;
      }
      // Failed bind — give a specific but non-leaking message
      const messages = {
        invalid:               '❌ รหัสไม่ถูกต้อง — โปรดติดต่อแอดมินเพื่อขอรหัสใหม่',
        expired:               '❌ รหัสหมดอายุ — โปรดติดต่อแอดมินเพื่อขอรหัสใหม่',
        already_bound:         '❌ รหัสนี้ถูกใช้ไปแล้ว',
        tenant_blocked:        '❌ บัญชีถูกระงับจาก LINE binding — ติดต่อแอดมิน',
        line_user_already_bound: '❌ LINE บัญชีนี้ผูกกับห้องอื่นอยู่แล้ว — ติดต่อแอดมินเพื่อยกเลิกก่อน',
      };
      await lineSvc.replyText(ev.replyToken, messages[result.reason] || '❌ ไม่สามารถผูกบัญชีได้');
      return;
    }

    // 2) Help / unknown — guide the tenant
    if (/^(help|ช่วย|เริ่ม|start|menu|เมนู)$/i.test(text)) {
      await lineSvc.replyText(
        ev.replyToken,
        '📌 คำสั่งที่ใช้ได้:\n' +
        '• BIND-XXXXXXXX — ผูกบัญชี (ขอรหัสจากแอดมิน)\n' +
        '• "บิล" หรือ "bills" — ดูบิลล่าสุด\n' +
        '• "สถานะ" หรือ "status" — สถานะห้องของคุณ\n' +
        '• "แจ้งซ่อม" — ลิงก์แจ้งซ่อม\n' +
        '• "help" — เมนูนี้'
      );
      return;
    }

    // 3) Intent matching for already-bound tenants. We resolve the LINE
    //    userId → tenant row first; if no match, fall through to the
    //    generic reply (pre-binding state).
    const tenantRow = await getBoundTenant(userId);

    if (/^(บิล|bills?|invoice)$/i.test(text)) {
      if (!tenantRow) return await replyUnbound(ev.replyToken);
      await replyLatestBill(ev.replyToken, tenantRow);
      return;
    }

    if (/^(สถานะ|status|ห้อง|room)$/i.test(text)) {
      if (!tenantRow) return await replyUnbound(ev.replyToken);
      await replyRoomStatus(ev.replyToken, tenantRow);
      return;
    }

    if (/^(แจ้งซ่อม|maintenance|ซ่อม|repair)$/i.test(text)) {
      const base = process.env.PUBLIC_BASE_URL || '';
      await lineSvc.replyText(
        ev.replyToken,
        '🔧 แจ้งซ่อม:\n' + (base ? `${base}/maintenance` : '/maintenance') +
        '\n\nหรือพิมพ์ "help" เพื่อดูคำสั่งทั้งหมด'
      );
      return;
    }

    // 4) Anything else — short generic reply (admin will follow up).
    if (text.length < 200) {
      await lineSvc.replyText(
        ev.replyToken,
        'ขอบคุณค่ะ — พิมพ์ "help" เพื่อดูคำสั่งที่ใช้ได้\nหรือรอแอดมินตอบกลับ'
      );
    }
  }

  // --- intent helpers ----------------------------------------------------
  async function getBoundTenant(lineUserId) {
    if (!lineUserId) return null;
    const { rows } = await pool.query(
      `SELECT id, full_name, phone, current_room_id, status
         FROM tenants
         WHERE line_user_id=$1 AND deleted_at IS NULL AND status='active'
         LIMIT 1`,
      [lineUserId]
    );
    return rows[0] || null;
  }

  async function replyUnbound(replyToken) {
    await lineSvc.replyText(replyToken,
      'บัญชีนี้ยังไม่ได้ผูกห้อง — ส่งรหัส BIND-XXXXXXXX (ขอจากแอดมิน) ก่อนนะครับ');
  }

  async function replyLatestBill(replyToken, tenant) {
    const { rows } = await pool.query(
      `SELECT bill_no, period, total, due_date, status
         FROM bills WHERE tenant_id=$1 AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 3`,
      [tenant.id]
    );
    if (!rows.length) {
      await lineSvc.replyText(replyToken, '📑 ยังไม่มีบิลในระบบ');
      return;
    }
    const fmt = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2 });
    const STATUS_TH = { pending: 'รอชำระ', paid: 'ชำระแล้ว', overdue: 'ค้างชำระ', void: 'ยกเลิก' };
    const lines = rows.map((b, i) =>
      `${i + 1}) ${b.bill_no} (${b.period})\n   ฿${fmt(b.total)} · ${STATUS_TH[b.status] || b.status}\n   ครบกำหนด ${b.due_date}`
    ).join('\n');
    await lineSvc.replyText(replyToken, `📑 บิลล่าสุด:\n${lines}\n\nเข้าพอร์ทัลเพื่อดูบิลทั้งหมด`);
  }

  async function replyRoomStatus(replyToken, tenant) {
    const room = tenant.current_room_id || '-';
    // Pull room blob for status (optional)
    let extra = '';
    try {
      const { rows } = await pool.query(`SELECT value FROM app_data WHERE key='baankarn_rooms_v1'`);
      const obj = rows.length ? rows[0].value : {};
      const r = obj && obj[room];
      if (r) {
        const STATUS_TH = { occupied: 'พักอยู่', overdue: 'ค้างชำระ', maintenance: 'แจ้งซ่อม', vacant: 'ว่าง' };
        extra = `\nสถานะ: ${STATUS_TH[r.status] || r.status || '-'}`;
        if (r.elecUnits != null) extra += `\nไฟฟ้า: ${r.elecUnits} หน่วย`;
        if (r.waterUnits != null) extra += `\nน้ำ: ${r.waterUnits} หน่วย`;
      }
    } catch { /* ignore */ }
    await lineSvc.replyText(replyToken,
      `🏠 ${tenant.full_name}\nห้อง: ${room}${extra}\n\nพิมพ์ "บิล" เพื่อดูบิลล่าสุด`);
  }

  return r;
};
