// routes/webhooks.js
// External-service webhooks. We verify HMAC signatures inline because these
// requests don't have a session cookie or origin header to use sameOrigin.
//
// Multi-OA routing:
//   POST /webhook/line          — legacy single-OA webhook (env vars or default DB OA)
//   POST /webhook/line/:slug    — per-OA webhook; the slug picks which channel
// Each OA verifies the signature with its OWN channel secret, so a leaked
// secret on one OA never lets an attacker spoof events into another.

const express = require('express');
const lineSvc = require('../services/line');
const lineOa = require('../services/lineOa');
const lineBinding = require('../services/lineBinding');
const ownerClaim = require('../services/ownerClaim');
const secrets = require('../services/secrets');
const notifier = require('../services/notifier');
const features = require('../services/features');

module.exports = function buildWebhooksRouter(ctx) {
  const { pool } = ctx;
  const r = express.Router();

  // ---- handler factory ---------------------------------------------------
  // Returns an Express handler bound to a specific OA-resolution strategy.
  // For the legacy /line route, oaResolver is a no-op that yields the default
  // OA (via env or DB). For /line/:slug, the resolver loads by slug.
  function makeHandler(oaResolver) {
    return async (req, res) => {
      let oa;
      try {
        oa = await oaResolver(req);
      } catch (err) {
        console.error('[line webhook] OA resolve failed:', err.message);
        return res.status(500).json({ error: 'internal' });
      }
      if (!oa) {
        // Slug not found, or no OA configured at all
        return res.status(404).json({ error: 'oa not found' });
      }
      if (oa.enabled === false) {
        return res.status(503).json({ error: 'oa disabled' });
      }
      const raw = req.rawBody || JSON.stringify(req.body || {});
      const sig = req.headers['x-line-signature'];
      if (!lineSvc.verifyWebhookSignature(oa, raw, sig)) {
        return res.status(403).json({ error: 'invalid signature' });
      }
      // Always 200 quickly so LINE doesn't retry. Process async.
      res.json({ ok: true });
      try {
        const events = Array.isArray(req.body?.events) ? req.body.events : [];
        for (const ev of events) {
          handleEvent(oa, ev).catch((e) => {
            console.error(`[line:${oa.slug}] event handler:`, e.message);
          });
        }
      } catch (err) {
        console.error(`[line:${oa.slug}] webhook outer:`, err);
      }
      // Touch last_seen on real DB OAs (env OA is ephemeral)
      if (oa.id && oa.id !== 0) {
        pool.query(
          `UPDATE line_oas SET last_seen_at=NOW() WHERE id=$1`,
          [oa.id]
        ).catch(() => {});
      }
    };
  }

  // ---- routes ------------------------------------------------------------
  // Legacy single-OA endpoint: tries default DB OA first, falls back to env.
  r.post('/line', makeHandler(async () => {
    return await lineOa.getDefault(pool, { withSecrets: true });
  }));

  // Per-OA endpoint. The slug is part of the URL admin configures in the
  // LINE Developer Console for each OA; pick a hard-to-guess slug for
  // defence in depth, even though the HMAC signature is the real auth.
  r.post('/line/:slug', makeHandler(async (req) => {
    return await lineOa.getBySlug(pool, req.params.slug, { withSecrets: true });
  }));

  // ---- event handler -----------------------------------------------------
  async function handleEvent(oa, ev) {
    const userId = ev.source?.userId || ev.source?.groupId || '';

    // Always log the inbound event for forensics. Tag with OA slug so we can
    // audit which channel an event came in on.
    try {
      await pool.query(
        `INSERT INTO notifications_log (channel, recipient, subject, body, status)
         VALUES ('line-in', $1, $2, $3, 'sent')`,
        [userId, `${ev.type || 'unknown'} oa:${oa.slug}`, JSON.stringify(ev).slice(0, 4000)]
      );
    } catch { /* ignore */ }

    if (ev.type !== 'message' || ev.message?.type !== 'text') return;
    if (!userId || !ev.replyToken) return;

    const text = String(ev.message.text || '').trim();

    // 0) Owner-claim code — match OWNER-XXXXXXXX. Checked BEFORE tenant
    //    bind so the two namespaces never collide. The admin issuing the
    //    claim is the only one who knows the code (and it's single-use +
    //    5-min TTL), so an unsuspecting user sending OWNER-... to the OA
    //    can't accidentally hijack the owner channel.
    if (ownerClaim.isClaimCode(text)) {
      let result;
      try {
        result = await ownerClaim.tryClaim(pool, {
          code: text, lineUserId: userId, oaId: oa.id || null,
          secretsModule: secrets,
        });
      } catch (err) {
        console.error(`[line:${oa.slug}] owner-claim error:`, err.message);
        await lineSvc.replyText(oa, ev.replyToken, '⚠️ ระบบขัดข้อง — โปรดลองใหม่');
        return;
      }
      if (result.ok) {
        await lineSvc.replyText(oa, ev.replyToken,
          `✅ ตั้งคุณเป็น Owner ของ ${oa.name} เรียบร้อย\n\n` +
          `LINE userId นี้จะได้รับ system alerts ทั้งหมด ` +
          `(บิลที่ส่งไม่ได้ / สลิปใหม่ / health alert / ฯลฯ)\n\n` +
          `เปลี่ยนได้ภายหลังที่ /admin#secrets`);
        return;
      }
      const messages = {
        invalid:      '❌ รหัสไม่ถูกต้อง — โปรดขอใหม่จาก /admin#secrets',
        expired:      '❌ รหัสหมดอายุ (เกิน 5 นาที) — ขอใหม่ที่หน้า admin',
        already_used: '❌ รหัสนี้ถูกใช้ไปแล้ว',
        revoked:      '❌ รหัสนี้ถูกยกเลิก — ขอใหม่ที่หน้า admin',
        wrong_oa:     '❌ รหัสนี้ออกให้ใช้กับ LINE OA อื่น',
        error:        '⚠️ เกิดข้อผิดพลาด — โปรดลองใหม่',
      };
      await lineSvc.replyText(oa, ev.replyToken, messages[result.reason] || '❌ ตั้ง owner ไม่สำเร็จ');
      return;
    }

    // 1) Binding code — match BIND-XXXXXXXX (case-insensitive, 4-16 hex)
    if (/^BIND-[A-F0-9]{4,16}$/i.test(text)) {
      let result;
      try {
        result = await lineBinding.tryBind(pool, {
          code: text, lineUserId: userId, oaId: oa.id || null,
        });
      } catch (err) {
        console.error(`[line:${oa.slug}] bind error:`, err.message);
        await lineSvc.replyText(oa, ev.replyToken, '⚠️ ระบบขัดข้อง — โปรดลองใหม่ภายหลัง');
        return;
      }
      if (result.ok) {
        const room = result.roomId ? ` (ห้อง ${result.roomId})` : '';
        await lineSvc.replyText(oa, ev.replyToken,
          `✅ ผูกบัญชี LINE สำเร็จ\n` +
          `${result.fullName}${room}\n` +
          `ผ่าน OA: ${oa.name}\n\n` +
          `คุณจะได้รับแจ้งเตือนบิล / แจ้งซ่อม / ประกาศต่าง ๆ ผ่านช่องนี้`
        );
        // Tell the operator owner so they have visibility
        try {
          const flags = await features.load(pool);
          notifier.notifyOwner({ pool, features: flags }, {
            subject: 'มีผู้เช่าผูก LINE OA',
            text: `${result.fullName}${room} ผูก LINE OA สำเร็จ ผ่าน ${oa.name}`,
          }).catch(() => {});
        } catch { /* ignore */ }
        return;
      }
      const messages = {
        invalid:                 '❌ รหัสไม่ถูกต้อง — โปรดติดต่อแอดมินเพื่อขอรหัสใหม่',
        expired:                 '❌ รหัสหมดอายุ — โปรดติดต่อแอดมินเพื่อขอรหัสใหม่',
        already_bound:           '❌ รหัสนี้ถูกใช้ไปแล้ว',
        tenant_blocked:          '❌ บัญชีถูกระงับจาก LINE binding — ติดต่อแอดมิน',
        line_user_already_bound: '❌ LINE บัญชีนี้ผูกกับห้องอื่นอยู่แล้ว — ติดต่อแอดมินเพื่อยกเลิกก่อน',
        wrong_oa:                '❌ รหัสนี้ออกให้ใช้กับ LINE OA อื่น — โปรดส่งไปที่ OA ที่แอดมินระบุ',
      };
      await lineSvc.replyText(oa, ev.replyToken, messages[result.reason] || '❌ ไม่สามารถผูกบัญชีได้');
      return;
    }

    // 2) Help / unknown — guide the tenant
    if (/^(help|ช่วย|เริ่ม|start|menu|เมนู)$/i.test(text)) {
      await lineSvc.replyText(oa, ev.replyToken,
        `📌 คำสั่งที่ใช้ได้ (${oa.name}):\n` +
        '• BIND-XXXXXXXX — ผูกบัญชี (ขอรหัสจากแอดมิน)\n' +
        '• "บิล" หรือ "bills" — ดูบิลล่าสุด\n' +
        '• "สถานะ" หรือ "status" — สถานะห้องของคุณ\n' +
        '• "แจ้งซ่อม" — ลิงก์แจ้งซ่อม\n' +
        '• "help" — เมนูนี้'
      );
      return;
    }

    // 3) Intent matching for already-bound tenants — scoped to THIS OA so
    //    tenant on OA #2 doesn't accidentally read tenant #1's bills via the
    //    same human userId across different OAs.
    const tenantRow = await getBoundTenant(userId, oa.id || null);

    if (/^(บิล|bills?|invoice)$/i.test(text)) {
      if (!tenantRow) return await replyUnbound(oa, ev.replyToken);
      await replyLatestBill(oa, ev.replyToken, tenantRow);
      return;
    }

    if (/^(สถานะ|status|ห้อง|room)$/i.test(text)) {
      if (!tenantRow) return await replyUnbound(oa, ev.replyToken);
      await replyRoomStatus(oa, ev.replyToken, tenantRow);
      return;
    }

    if (/^(แจ้งซ่อม|maintenance|ซ่อม|repair)$/i.test(text)) {
      const base = process.env.PUBLIC_BASE_URL || '';
      await lineSvc.replyText(oa, ev.replyToken,
        '🔧 แจ้งซ่อม:\n' + (base ? `${base}/maintenance` : '/maintenance') +
        '\n\nหรือพิมพ์ "help" เพื่อดูคำสั่งทั้งหมด'
      );
      return;
    }

    if (text.length < 200) {
      await lineSvc.replyText(oa, ev.replyToken,
        'ขอบคุณค่ะ — พิมพ์ "help" เพื่อดูคำสั่งที่ใช้ได้\nหรือรอแอดมินตอบกลับ');
    }
  }

  // --- intent helpers ----------------------------------------------------
  // Lookup must include the OA scope: a single human has different LINE
  // userIds in different OAs, but the userId space is global per-OA so two
  // tenants COULD share a userId across OAs without colliding.
  async function getBoundTenant(lineUserId, oaId) {
    if (!lineUserId) return null;
    const { rows } = await pool.query(
      `SELECT t.id, t.full_name, t.phone, t.current_room_id, t.status
         FROM tenants t
         JOIN line_bindings b ON b.tenant_id = t.id
        WHERE b.line_user_id = $1
          AND COALESCE(b.oa_id, 0) = COALESCE($2::bigint, 0)
          AND b.status = 'bound'
          AND t.deleted_at IS NULL
          AND t.status = 'active'
        LIMIT 1`,
      [lineUserId, oaId]
    );
    return rows[0] || null;
  }

  async function replyUnbound(oa, replyToken) {
    await lineSvc.replyText(oa, replyToken,
      'บัญชีนี้ยังไม่ได้ผูกห้อง — ส่งรหัส BIND-XXXXXXXX (ขอจากแอดมิน) ก่อนนะครับ');
  }

  async function replyLatestBill(oa, replyToken, tenant) {
    const { rows } = await pool.query(
      `SELECT bill_no, period, total, due_date, status
         FROM bills WHERE tenant_id=$1 AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 3`,
      [tenant.id]
    );
    if (!rows.length) {
      await lineSvc.replyText(oa, replyToken, '📑 ยังไม่มีบิลในระบบ');
      return;
    }
    const fmt = (n) => {
      const v = Number(n);
      if (!Number.isFinite(v)) return '0.00';
      return v.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };
    const STATUS_TH = { pending: 'รอชำระ', paid: 'ชำระแล้ว', overdue: 'ค้างชำระ', void: 'ยกเลิก' };
    const lines = rows.map((b, i) =>
      `${i + 1}) ${b.bill_no} (${b.period})\n   ฿${fmt(b.total)} · ${STATUS_TH[b.status] || b.status}\n   ครบกำหนด ${b.due_date}`
    ).join('\n');
    await lineSvc.replyText(oa, replyToken, `📑 บิลล่าสุด:\n${lines}\n\nเข้าพอร์ทัลเพื่อดูบิลทั้งหมด`);
  }

  async function replyRoomStatus(oa, replyToken, tenant) {
    const room = tenant.current_room_id || '-';
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
    await lineSvc.replyText(oa, replyToken,
      `🏠 ${tenant.full_name}\nห้อง: ${room}${extra}\n\nพิมพ์ "บิล" เพื่อดูบิลล่าสุด`);
  }

  return r;
};
