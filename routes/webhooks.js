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
const adminRecipients = require('../services/adminRecipients');
const secrets = require('../services/secrets');
const notifier = require('../services/notifier');
const features = require('../services/features');
const storage = require('../services/storage');

module.exports = function buildWebhooksRouter(ctx) {
  const { pool, processTenantSlipUpload, signBillPayToken, makeIpLimiter } = ctx;
  const r = express.Router();

  // Per-IP rate limit on the whole webhook surface. Genuine LINE delivery from
  // a 40-room dorm is a trickle; 600/min/IP is far above real traffic yet caps
  // an unauthenticated flood (the failure-log + unknown-slug DB lookups below
  // each touch the DB, so an unthrottled POST loop is a log-amplification /
  // DB-load DoS, and also the only thing bounding online brute-force of an
  // 8-hex bind code). LINE retries non-2xx, so a rare 429 still gets redelivered.
  if (typeof makeIpLimiter === 'function') {
    r.use(makeIpLimiter({ windowMs: 60_000, max: 600, code: 'WEBHOOK_RATE_LIMIT' }));
  }

  // Throttle the failure-logging itself: even within the rate limit we must not
  // write one notifications_log row per bad request. Keep an in-memory
  // last-logged time per (ip, kind) and skip the DB write inside a short
  // cooldown — diagnostics still surface (first hit logs), volume stays bounded.
  const FAIL_LOG_COOLDOWN_MS = 60_000;
  const FAIL_LOG_MAX_KEYS = 5_000;     // hard cap so IP rotation can't grow it unbounded
  const _failLogSeen = new Map();      // `${ip}:${kind}` -> last logged ms
  function shouldLogFailure(ip, kind) {
    const k = `${ip}:${kind}`;
    const now = Date.now();
    const last = _failLogSeen.get(k);
    if (last && now - last < FAIL_LOG_COOLDOWN_MS) return false;
    if (_failLogSeen.size >= FAIL_LOG_MAX_KEYS) _failLogSeen.clear(); // cheap bound
    _failLogSeen.set(k, now);
    return true;
  }

  // ---- handler factory ---------------------------------------------------
  // Returns an Express handler bound to a specific OA-resolution strategy.
  // For the legacy /line route, oaResolver is a no-op that yields the default
  // OA (via env or DB). For /line/:slug, the resolver loads by slug.
  // Log a failed webhook attempt to notifications_log with channel='line-webhook-fail'.
  // The /admin#line-oas diagnostics panel reads this so the operator can see WHY
  // LINE keeps reporting 403/404 instead of staring at the LINE Console with no
  // breadcrumb on our side. Fail-soft — never let a logging error mask the real
  // response we owe to LINE's retry loop.
  async function logWebhookFailure(req, kind, detail) {
    try {
      const slug = req.params?.slug || '(default)';
      const sigHead = String(req.headers['x-line-signature'] || '').slice(0, 16);
      const ua = String(req.headers['user-agent'] || '').slice(0, 100);
      const ip = req.ip || req.headers['x-forwarded-for'] || '';
      // Drop repeats from the same source within the cooldown so a flood of
      // unsigned/unknown-slug POSTs can't amplify into unbounded DB rows.
      if (!shouldLogFailure(String(ip).slice(0, 64), kind)) return;
      await pool.query(
        `INSERT INTO notifications_log (channel, recipient, subject, body, status)
         VALUES ('line-webhook-fail', $1, $2, $3, 'failed')`,
        [
          String(ip).slice(0, 64),
          `${kind} oa-slug:${slug}`,
          JSON.stringify({ kind, slug, detail, sigHead, ua }).slice(0, 4000),
        ]
      );
    } catch (err) {
      console.warn('[line webhook] failure log skipped:', err.message);
    }
  }

  function makeHandler(oaResolver) {
    return async (req, res) => {
      let oa;
      try {
        oa = await oaResolver(req);
      } catch (err) {
        console.error('[line webhook] OA resolve failed:', err.message);
        await logWebhookFailure(req, 'oa_resolve_error', { error: err.message });
        return res.status(500).json({ error: 'internal' });
      }
      if (!oa) {
        // Slug not found, or no OA configured at all. Operators frequently hit
        // this when they register a fresh OA in /admin#line-oas but the slug
        // they put into LINE Developer Console doesn't match. The response now
        // includes a hint so a future support ticket has a one-line answer.
        await logWebhookFailure(req, 'oa_not_found', {
          path: req.path,
          hint: 'slug must match an enabled OA in /admin#line-oas',
        });
        return res.status(404).json({
          error: 'oa not found',
          code: 'OA_NOT_FOUND',
          hint: 'URL slug ใน LINE Developer Console ต้องตรงกับ slug ใน /admin#line-oas — หรือใช้ /webhook/line (ไม่มี slug) สำหรับ default OA',
        });
      }
      if (oa.enabled === false) {
        await logWebhookFailure(req, 'oa_disabled', { oaId: oa.id, slug: oa.slug });
        return res.status(503).json({
          error: 'oa disabled',
          code: 'OA_DISABLED',
          hint: `OA "${oa.name || oa.slug}" ถูกปิดอยู่ — เปิดที่ /admin#line-oas ก่อน`,
        });
      }
      // The HMAC must be computed over the EXACT bytes LINE sent. express.json's
      // verify hook captures them into req.rawBody for /webhook/* routes, but
      // only when the body actually parsed as application/json (which every
      // genuine LINE webhook is). If it's missing, the request didn't arrive as
      // JSON — reject rather than HMAC a re-stringified `req.body`, which would
      // silently change what's signed and weaken the verification contract.
      const raw = req.rawBody;
      const sig = req.headers['x-line-signature'];
      if (!raw) {
        await logWebhookFailure(req, 'no_raw_body', {
          oaId: oa.id, slug: oa.slug,
          hint: 'webhook must POST a JSON body with Content-Type: application/json',
        });
        return res.status(403).json({ error: 'missing or non-json body', code: 'NO_RAW_BODY' });
      }
      if (!lineSvc.verifyWebhookSignature(oa, raw, sig)) {
        // Distinguish "no signature header" from "bad signature" so the
        // diagnostic panel can hint at the right fix. LINE always sends
        // x-line-signature on webhook POSTs; a missing header usually means
        // someone hit the URL with curl or a test tool.
        const noSig = !sig;
        const hasSecret = !!(oa && oa.channelSecret);
        await logWebhookFailure(req, noSig ? 'no_signature' : 'invalid_signature', {
          oaId: oa.id, slug: oa.slug,
          hasSecret,
          hint: hasSecret
            ? 'channel_secret ใน /admin#line-oas อาจไม่ตรงกับ "Channel secret" ที่ LINE Developer Console — copy ใหม่จาก Console แล้ว save'
            : 'OA ยังไม่ได้ตั้ง channel_secret — ไปที่ /admin#line-oas แก้ค่า',
        });
        return res.status(403).json({
          error: noSig ? 'missing signature' : 'invalid signature',
          code: noSig ? 'NO_SIGNATURE' : 'INVALID_SIGNATURE',
          hint: hasSecret
            ? 'ตรวจสอบ channel_secret ที่ /admin#line-oas ให้ตรงกับ LINE Developer Console'
            : 'OA ยังไม่ได้ตั้ง channel_secret — ตั้งค่าที่ /admin#line-oas',
        });
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

    // Idempotency guard. LINE re-delivers an event when it didn't receive our
    // 200 (e.g. the response was lost on the wire / timed out). We send the
    // 200 BEFORE processing and handle events asynchronously, so a redelivery
    // means the original was already processed — reprocessing would duplicate
    // side effects (most importantly a second pending payment row for the same
    // slip image, inflating the admin review queue). We've already logged the
    // event above for forensics; skip the state-changing handlers.
    if (ev.deliveryContext && ev.deliveryContext.isRedelivery) {
      console.log(`[line:${oa.slug}] skipping redelivered event ${ev.webhookEventId || '(no id)'}`);
      return;
    }

    if (!userId || !ev.replyToken) return;
    if (ev.type !== 'message') return;

    if (ev.message?.type === 'image') {
      await handleSlipImageMessage(oa, ev, userId);
      return;
    }

    if (ev.message?.type !== 'text') return;

    const text = normaliseLineText(ev.message.text);
    if (!text) return;

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

    // 0.5) Admin-recipient code — match ADMIN-XXXXXXXX. The multi-person
    //      counterpart to owner-claim: any number of staff LINE accounts can
    //      bind as system-alert recipients. Same security shape: single-use,
    //      short-TTL, only the issuing admin knows the code, and the
    //      namespace is distinct from OWNER-/BIND- so flows can't collide.
    if (adminRecipients.isClaimCode(text)) {
      let result;
      try {
        result = await adminRecipients.tryClaim(pool, {
          code: text, lineUserId: userId, oaId: oa.id || null,
        });
      } catch (err) {
        console.error(`[line:${oa.slug}] admin-recipient claim error:`, err.message);
        await lineSvc.replyText(oa, ev.replyToken, '⚠️ ระบบขัดข้อง — โปรดลองใหม่');
        return;
      }
      if (result.ok) {
        await lineSvc.replyText(oa, ev.replyToken,
          (result.already
            ? `✅ บัญชีนี้เป็นผู้รับแจ้งเตือนแอดมินของ ${oa.name} อยู่แล้ว (เปิดรับอีกครั้งให้เรียบร้อย)\n\n`
            : `✅ ผูกบัญชีนี้เป็นผู้รับแจ้งเตือนแอดมินของ ${oa.name} เรียบร้อย${result.label ? ` (${result.label})` : ''}\n\n`) +
          `จะได้รับแจ้งเตือนระบบทั้งหมด: การจอง / ชำระเงิน / ย้ายเข้า-ย้ายออก / แจ้งซ่อม / บิล ฯลฯ\n\n` +
          `เจ้าของระบบเปิด-ปิด/ยกเลิกการรับแจ้งเตือนนี้ได้ที่ /admin#line-oas`);
        // Visibility: tell the EXISTING recipients that someone new joined —
        // an unexpected join here is a security signal worth seeing.
        try {
          const flags = await features.load(pool);
          notifier.notifyOwner({ pool, features: flags }, {
            category: 'security',
            subject: result.already ? 'ผู้รับแจ้งเตือนแอดมินเปิดรับอีกครั้ง' : 'มีผู้รับแจ้งเตือนแอดมินคนใหม่',
            text: `${result.label || 'ไม่ระบุชื่อ'} ผูก LINE เป็นผู้รับแจ้งเตือนแอดมิน ผ่าน ${oa.name}\n` +
              `LINE userId (ท้าย): ...${String(userId || '').slice(-6)}\n` +
              `จัดการได้ที่ /admin#line-oas`,
          }).catch(() => {});
        } catch { /* visibility alert must not break the reply */ }
        return;
      }
      const messages = {
        invalid:      '❌ รหัสไม่ถูกต้อง — ขอรหัสใหม่จากเจ้าของระบบ (/admin#line-oas)',
        expired:      '❌ รหัสหมดอายุ (เกิน 10 นาที) — ขอรหัสใหม่จากเจ้าของระบบ',
        already_used: '❌ รหัสนี้ถูกใช้ไปแล้ว — ขอรหัสใหม่จากเจ้าของระบบ',
        revoked:      '❌ รหัสนี้ถูกยกเลิก — ขอรหัสใหม่จากเจ้าของระบบ',
        wrong_oa:     '❌ รหัสนี้ออกให้ใช้กับ LINE OA อื่น — ส่งในแชทของ OA ที่ถูกต้อง',
        error:        '⚠️ เกิดข้อผิดพลาด — โปรดลองใหม่',
      };
      await lineSvc.replyText(oa, ev.replyToken, messages[result.reason] || '❌ ผูกผู้รับแจ้งเตือนไม่สำเร็จ');
      return;
    }

    // 1) Binding code — match BIND-XXXXXXXX (case-insensitive, 4-16 hex)
    if (isBindCode(text)) {
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
        let bindingCount = null;
        try {
          const boundRows = result.tenantId
            ? await lineBinding.listTenantRecipients(pool, result.tenantId)
            : (result.bookingId ? await lineBinding.listBookingRecipients(pool, result.bookingId) : []);
          bindingCount = boundRows.length;
        } catch { bindingCount = null; }
        const bindingCountLine = bindingCount == null
          ? ''
          : `\nห้อง/การจองนี้ผูก LINE แล้วทั้งหมด ${bindingCount} บัญชี`;
        const scope = result.pendingTenantLink
          ? 'ระบบจะผูกบัญชีนี้กับห้องอัตโนมัติหลังแอดมินอนุมัติและสร้างสัญญา'
          : 'คุณจะได้รับแจ้งเตือนบิล / แจ้งซ่อม / ประกาศต่าง ๆ ผ่านช่องนี้';
        await lineSvc.replyText(oa, ev.replyToken,
          `✅ ผูกบัญชี LINE สำเร็จ\n` +
          `${result.fullName}${room}\n` +
          `ผ่าน OA: ${oa.name}\n\n` +
          scope +
          bindingCountLine
        );
        // Tell the operator owner so they have visibility
        try {
          const flags = await features.load(pool);
          notifier.notifyOwner({ pool, features: flags }, {
            category: 'booking',
            subject: 'มีผู้เช่าผูก LINE OA',
            text: `${result.fullName}${room} ผูก LINE OA สำเร็จ ผ่าน ${oa.name}${bindingCount == null ? '' : `\nห้อง/การจองนี้ผูก LINE แล้วทั้งหมด ${bindingCount} บัญชี`}`,
          }).catch(() => {});
        } catch { /* ignore */ }
        return;
      }
      if (['line_user_already_bound', 'tenant_blocked', 'booking_not_active', 'wrong_oa'].includes(result.reason)) {
        try {
          const flags = await features.load(pool);
          notifier.notifyOwner({ pool, features: flags }, {
            category: 'booking',
            subject: 'LINE binding ต้องตรวจสอบ',
            text: [
              `เหตุผล: ${result.reason}`,
              `OA: ${oa.name || oa.slug || oa.id || '-'}`,
              `LINE userId: ${userId || '-'}`,
              result.otherTenantId ? `ผูกอยู่กับ tenantId อื่น: ${result.otherTenantId}` : null,
              result.otherBookingId ? `ผูกอยู่กับ bookingId อื่น: ${result.otherBookingId}` : null,
              result.expectedOaId ? `ควรส่งรหัสไปที่ OA id: ${result.expectedOaId}` : null,
              'ขั้นต่อไป: ตรวจสอบว่าเป็นการจองแทนเพื่อน/จองอีกห้อง/ส่งผิด OA ก่อนออก code ใหม่หรือรวมข้อมูล',
            ].filter(Boolean).join('\n'),
          }).catch(() => {});
        } catch { /* owner alert must not break LINE reply */ }
      }
      const messages = {
        invalid:                 '❌ รหัสไม่ถูกต้อง — โปรดติดต่อแอดมินเพื่อขอรหัสใหม่',
        expired:                 '❌ รหัสหมดอายุ — โปรดติดต่อแอดมินเพื่อขอรหัสใหม่',
        already_bound:           '❌ รหัสนี้ถูกใช้ไปแล้ว',
        tenant_blocked:          '❌ บัญชีถูกระงับจาก LINE binding — ติดต่อแอดมิน',
        booking_not_active:      '❌ การจองนี้ไม่อยู่ในสถานะที่ผูก LINE ได้แล้ว — ติดต่อแอดมิน',
        line_user_already_bound: [
          '❌ LINE บัญชีนี้ผูกกับผู้เช่า/ห้องอื่นอยู่แล้ว',
          'ถ้าจองให้เพื่อน ให้เพื่อนส่งรหัสนี้ด้วย LINE ของเพื่อนเอง',
          'ถ้าจองอีกห้องให้ตัวเอง ให้แอดมินตรวจสอบ/รวมข้อมูลก่อนผูก เพื่อป้องกันบิลหรือสัญญาส่งผิดห้อง',
        ].join('\n'),
        wrong_oa:                '❌ รหัสนี้ออกให้ใช้กับ LINE OA อื่น — โปรดส่งไปที่ OA ที่แอดมินระบุ',
      };
      await lineSvc.replyText(oa, ev.replyToken, messages[result.reason] || '❌ ไม่สามารถผูกบัญชีได้');
      return;
    }

    // 2) Help / menu command
    if (isHelpCommand(text)) {
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

    if (isMaintenanceCommand(text)) {
      const base = process.env.PUBLIC_BASE_URL || '';
      await lineSvc.replyText(oa, ev.replyToken,
        '🔧 แจ้งซ่อม:\n' + (base ? `${base}/maintenance` : '/maintenance') +
        '\n\nหรือพิมพ์ "help" เพื่อดูคำสั่งทั้งหมด'
      );
      return;
    }

    // 3) Bound-tenant commands. Only these paths need a tenant lookup; free
    //    text must stay side-effect free and must not depend on DB health.
    if (isBillCommand(text)) {
      const tenantRow = await getBoundTenant(userId, oa.id || null);
      if (!tenantRow) return await replyUnbound(oa, ev.replyToken, userId);
      await replyLatestBill(oa, ev.replyToken, tenantRow);
      return;
    }

    if (isRoomStatusCommand(text)) {
      const tenantRow = await getBoundTenant(userId, oa.id || null);
      if (!tenantRow) return await replyUnbound(oa, ev.replyToken, userId);
      await replyRoomStatus(oa, ev.replyToken, tenantRow);
      return;
    }

    // Unknown normal text is intentionally silent. LINE is also used as an
    // admin chat surface, so the bot must reply only to verified keys and
    // explicit commands.
    return;
  }

  // --- intent helpers ----------------------------------------------------
  function normaliseLineText(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim();
  }

  function isBindCode(text) {
    return /^BIND-[A-F0-9]{4,16}$/i.test(text);
  }

  function isHelpCommand(text) {
    return /^(help|ช่วย|เริ่ม|start|menu|เมนู)$/i.test(text);
  }

  function isBillCommand(text) {
    return /^(บิล|bills?|invoice)$/i.test(text);
  }

  function isRoomStatusCommand(text) {
    return /^(สถานะ|status|ห้อง|room)$/i.test(text);
  }

  function isMaintenanceCommand(text) {
    return /^(แจ้งซ่อม|maintenance|ซ่อม|repair)$/i.test(text);
  }

  // Lookup must include the OA scope: a single human has different LINE
  // userIds in different OAs, but the userId space is global per-OA so two
  // tenants COULD share a userId across OAs without colliding.
  async function getBoundTenant(lineUserId, oaId) {
    if (!lineUserId) return null;
    const { rows } = await pool.query(
      `SELECT t.id, t.full_name, t.phone, t.email, t.line_user_id, t.line_oa_id,
              t.current_room_id, t.status, t.locale
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

  async function handleSlipImageMessage(oa, ev, userId) {
    const tenant = await getBoundTenant(userId, oa.id || null);
    if (!tenant) return await replyUnbound(oa, ev.replyToken, userId);
    if (typeof processTenantSlipUpload !== 'function') {
      await lineSvc.replyText(oa, ev.replyToken, 'ระบบรับสลิปผ่าน LINE ยังไม่พร้อมใช้งาน โปรดใช้ลิงก์ในบิล');
      return;
    }
    const flags = await features.load(pool);
    if (!flags.slipUpload || !flags.slipUpload.enabled) {
      await lineSvc.replyText(oa, ev.replyToken, 'ระบบรับสลิปออนไลน์ยังไม่เปิดใช้งาน โปรดติดต่อสำนักงาน');
      return;
    }
    const { rows: bills } = await pool.query(
      `SELECT id, bill_no, period, total, status, due_date
         FROM bills
        WHERE tenant_id=$1
          AND deleted_at IS NULL
          AND status IN ('pending','overdue')
        ORDER BY due_date NULLS LAST, created_at DESC, id DESC
        LIMIT 3`,
      [tenant.id]
    );
    if (!bills.length) {
      await lineSvc.replyText(oa, ev.replyToken, 'ยังไม่มีบิลค้างชำระในระบบ หรือบิลถูกชำระแล้ว ไม่ต้องส่งสลิปเพิ่มเติม');
      return;
    }
    if (bills.length > 1) {
      const lines = bills.map((b) => {
        const amount = Number(b.total).toLocaleString('th-TH', { minimumFractionDigits: 2 });
        return `- ${b.bill_no || `#${b.id}`} รอบ ${b.period || '-'} ยอด ฿${amount}`;
      }).join('\n');
      await lineSvc.replyText(oa, ev.replyToken,
        `พบหลายบิลที่ยังค้างชำระ จึงยังไม่แนบสลิปให้อัตโนมัติเพื่อป้องกันลงบิลผิด\n${lines}\n\nโปรดเปิดลิงก์ของบิลที่ต้องการชำระ แล้วอัปโหลดสลิปจากลิงก์นั้น`);
      return;
    }

    const bill = bills[0];
    try {
      const content = await lineSvc.getMessageContent(oa, ev.message.id, {
        maxBytes: (flags.slipUpload && flags.slipUpload.maxBytes) || 1_500_000,
      });
      const headerMime = /^image\/(jpeg|png|webp)\b/i.test(content.contentType || '')
        ? content.contentType.split(';')[0].toLowerCase()
        : 'image/jpeg';
      const mime = storage.detectMime(content.body) || headerMime;
      const dataUrl = `data:${mime};base64,${content.body.toString('base64')}`;
      const out = await processTenantSlipUpload({
        tenant: {
          tenant_id: tenant.id,
          full_name: tenant.full_name,
          phone: tenant.phone,
          email: tenant.email,
          line_user_id: userId,
          line_oa_id: oa.id || tenant.line_oa_id || null,
          current_room_id: tenant.current_room_id,
          status: tenant.status,
          locale: tenant.locale,
        },
        billId: bill.id,
        amount: Number(bill.total),
        slip: dataUrl,
        features: flags,
        source: 'line',
        skipTenantAck: true,
      });
      const payment = out && out.payment;
      if (payment && payment.status === 'verified') {
        await lineSvc.replyText(oa, ev.replyToken,
          `✅ ชำระเงินสำเร็จ\nบิล ${bill.bill_no || `#${bill.id}`} อัปเดตเป็นชำระแล้วเรียบร้อย`);
      } else if (payment && payment.status === 'rejected') {
        await lineSvc.replyText(oa, ev.replyToken,
          `❌ สลิปไม่ผ่านการตรวจสอบ\nบิล ${bill.bill_no || `#${bill.id}`}\nเหตุผล: ${payment.rejected_reason || 'ไม่ผ่านการตรวจสอบ'}`);
      } else {
        await lineSvc.replyText(oa, ev.replyToken,
          `📥 ได้รับสลิปแล้ว\nบิล ${bill.bill_no || `#${bill.id}`} กำลังรอเจ้าหน้าที่ตรวจสอบ`);
      }
    } catch (err) {
      const code = err.data && err.data.code;
      const message = err.data && err.data.error ? err.data.error : err.message;
      if (code === 'BILL_ALREADY_PAID' || code === 'BILL_NOT_PAYABLE' || /ชำระ.*แล้ว/.test(String(message || ''))) {
        await lineSvc.replyText(oa, ev.replyToken, 'บิลนี้ชำระแล้ว ไม่ต้องส่งสลิปเพิ่มเติม');
      } else {
        await lineSvc.replyText(oa, ev.replyToken,
          `ระบบรับสลิปไม่สำเร็จ — กรุณาส่งรูปใหม่อีกครั้ง ถ้ายังไม่ได้ให้ติดต่อสำนักงาน${message ? `\n(สาเหตุ: ${message})` : ''}`);
      }
    }
  }

  async function replyUnbound(oa, replyToken, lineUserId) {
    // Before assuming the user is unbound, check whether they're bound
    // to a DIFFERENT OA. The "ส่งรหัส BIND" message is misleading when
    // the user is already bound — they don't need a new code, they need
    // to message the right OA. This was a real support-ticket driver
    // when a building runs multi-OA (e.g. one OA per branch).
    if (lineUserId) {
      try {
        // Table is `line_oas` and the human-readable column is `name`,
        // not `line_oa` / `display_name` (which is what an earlier version
        // assumed). Querying the wrong names always threw, the catch
        // below swallowed it, and tenants who messaged a SECOND OA they
        // were already bound to elsewhere saw the generic "send BIND
        // code" reply — letting them re-bind cross-OA. Schema source of
        // truth: db/migrate.js:466 (CREATE TABLE line_oas …).
        const { rows } = await pool.query(
          `SELECT b.oa_id, o.name AS oa_name, o.slug
             FROM line_bindings b
             LEFT JOIN line_oas o ON o.id = b.oa_id
            WHERE b.line_user_id = $1 AND b.status = 'bound'
            LIMIT 1`,
          [lineUserId]
        );
        if (rows.length) {
          const r = rows[0];
          const isDifferentOa = (oa && oa.id != null && r.oa_id != null && Number(r.oa_id) !== Number(oa.id))
            || (oa && oa.id == null && r.oa_id != null);
          if (isDifferentOa) {
            const otherName = r.oa_name || r.slug || `OA #${r.oa_id}`;
            await lineSvc.replyText(oa, replyToken,
              `บัญชี LINE ของคุณถูกผูกกับ ${otherName} อยู่แล้ว — โปรดส่งสลิป/ติดต่อผ่าน ${otherName} เท่านั้น\n\n`
              + `(ถ้าต้องการย้ายมาผูกที่ OA นี้แทน กรุณาติดต่อแอดมิน)`);
            return;
          }
        }
      } catch (err) {
        console.warn('[webhook] wrong-OA detection failed:', err.message);
        // fall through to the generic unbound reply
      }
    }
    await lineSvc.replyText(oa, replyToken,
      'บัญชีนี้ยังไม่ได้ผูกห้อง — ส่งรหัส BIND-XXXXXXXX (ขอจากแอดมิน) ก่อนนะครับ');
  }

  async function replyLatestBill(oa, replyToken, tenant) {
    const publicUrl = (process.env.PUBLIC_URL
      || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
      || '').replace(/\/+$/, '');
    const { rows } = await pool.query(
      `SELECT id, bill_no, period, total, due_date, status
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
    const lines = rows.map((b, i) => {
      const token = publicUrl && typeof signBillPayToken === 'function'
        ? signBillPayToken(b.id)
        : null;
      const link = token ? `\n   ${publicUrl}/pay/${encodeURIComponent(b.id)}?t=${encodeURIComponent(token)}` : '';
      return `${i + 1}) ${b.bill_no} (${b.period})\n   ฿${fmt(b.total)} · ${STATUS_TH[b.status] || b.status}\n   ครบกำหนด ${b.due_date}${link}`;
    }).join('\n');
    await lineSvc.replyText(oa, replyToken, `📑 บิลล่าสุด:\n${lines}\n\nเปิดลิงก์ของบิลเพื่อชำระหรือส่งสลิป`);
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
        extra += `\nค่าน้ำ/ไฟ: ดูจากบิลรอบล่าสุดเพื่อป้องกันใช้เลขมิเตอร์ผิดรอบ`;
      }
    } catch { /* ignore */ }
    await lineSvc.replyText(oa, replyToken,
      `🏠 ${tenant.full_name}\nห้อง: ${room}${extra}\n\nพิมพ์ "บิล" เพื่อดูบิลล่าสุด`);
  }

  return r;
};
