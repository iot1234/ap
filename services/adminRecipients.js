// services/adminRecipients.js
// Unlimited admin/staff LINE notification recipients — the multi-person
// counterpart to services/ownerClaim.js (which binds exactly ONE owner
// contact per OA). Every system alert dispatched through
// notifier.notifyOwner fans out to all ENABLED recipients here in addition
// to the legacy owner contact, so the whole front-desk team hears about
// bookings / payments / move-ins / move-outs, not just one phone.
//
// Flow (mirrors owner-claim, different namespace):
//   1. Owner opens /admin#line-oas → "ออกรหัสผูกแอดมิน" → POST
//      /api/admin/line/admin-recipients/tokens → ADMIN-XXXXXXXX (10-min TTL).
//   2. The staff member adds the OA as a friend and sends the code from
//      THEIR OWN LINE account.
//   3. Webhook matches the code → tryClaim() creates the recipient row.
//   4. Owner can disable (mute), re-enable, relabel, or revoke each row.
//      Revocation is terminal — rejoining needs a fresh code.
//
// Security:
//   - Codes are single-use, short-TTL, and namespaced (ADMIN- vs OWNER-/
//     BIND-) so the three webhook claim flows can never collide.
//   - Issuing codes + managing recipients is owner-role only (routes).
//   - line_user_id values are masked everywhere they surface in the UI.

const crypto = require('crypto');

const CODE_RE = /^ADMIN-[A-F0-9]{8}$/i;
const TTL_MS = 10 * 60 * 1000;         // 10 minutes — staff types it while present

// === Notification categories ===============================================
// Every notifyOwner call site tags its message with one of these keys; each
// recipient can mute categories individually ("ผู้จัดการ เอ รับเฉพาะเรื่องเงิน,
// พนักงาน บี รับเฉพาะจอง+แจ้งซ่อม"). The catalog is the SINGLE whitelist —
// the REST endpoint, the notifier filter, and the UI chips all read it, so
// an unknown key can neither be saved nor silently change behaviour.
//
// Mute semantics (fail-open by design): we store the categories a recipient
// does NOT want. A category key added in a future release is therefore ON
// for everyone until they mute it — for operational alerts, over-notifying
// a new event type beats silently dropping it. The legacy owner contact is
// NEVER filtered: it stays the catch-all safety net.
const CATEGORIES = Object.freeze([
  { key: 'booking',     label: 'การจอง',            desc: 'จองใหม่ / อนุมัติ / ยกเลิก / ผูก LINE ผู้จอง' },
  { key: 'payment',     label: 'รับเงิน/สลิป',       desc: 'เงินเข้า / สลิปใหม่ / สลิปค้างคิวตรวจ' },
  { key: 'billing',     label: 'บิล/ค้างชำระ',       desc: 'ออกบิลอัตโนมัติ / สรุปค้างชำระรายวัน / คำเตือนรอบบิล' },
  { key: 'tenancy',     label: 'ย้ายเข้า-ออก/สัญญา', desc: 'เช็คอิน / เช็คเอาท์ / อนุมัติสัญญา / สัญญาใกล้หมดอายุ' },
  { key: 'maintenance', label: 'แจ้งซ่อม',           desc: 'งานแจ้งซ่อมใหม่' },
  { key: 'security',    label: 'ความปลอดภัย',        desc: 'การ bypass ด้วย force / เหตุการณ์ผิดปกติ / แอดมินใหม่ผูกเข้ามา' },
  { key: 'system',      label: 'ระบบ/งานอัตโนมัติ',   desc: 'งานเบื้องหลังล้มเหลว / สำรองข้อมูล / health / มิเตอร์ผิดปกติ' },
]);
const CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key));

/**
 * Validate a muted-categories payload from the API. Returns
 * { ok: true, list } with a deduped, whitelisted array — or
 * { ok: false, invalid } naming every rejected entry so the admin UI can
 * show exactly what was wrong instead of a generic 400.
 */
function validateMutedCategories(input) {
  if (input == null) return { ok: true, list: [] };
  if (!Array.isArray(input)) return { ok: false, invalid: ['(not an array)'] };
  const list = [];
  const invalid = [];
  const seen = new Set();
  for (const raw of input) {
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!CATEGORY_KEYS.has(key)) { invalid.push(String(raw).slice(0, 40)); continue; }
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(key);
  }
  if (invalid.length) return { ok: false, invalid };
  return { ok: true, list };
}

/**
 * Does a recipient want messages of this category? Pure + defensive:
 *   - unknown/missing category on the MESSAGE → treated as 'system'
 *     (a typo at a call site must never silently drop an alert class)
 *   - malformed muted list on the ROW (manual SQL edit) → treated as []
 *     (fail-open: deliver rather than silently mute)
 */
function wantsCategory(mutedCategories, category) {
  const cat = CATEGORY_KEYS.has(category) ? category : 'system';
  const muted = Array.isArray(mutedCategories) ? mutedCategories : [];
  return !muted.includes(cat);
}

function generateCode() {
  return 'ADMIN-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function isClaimCode(text) {
  return CODE_RE.test(String(text || '').trim());
}

function maskLineUserId(id) {
  const s = String(id || '');
  if (s.length <= 8) return s ? `...${s.slice(-4)}` : '';
  return `${s.slice(0, 4)}…${s.slice(-6)}`;
}

/**
 * Issue a fresh bind token. Multiple pending tokens may coexist (codes for
 * several staff at once); each is single-use. Returns { id, code, expiresAt }.
 */
async function createToken(pool, { oaId, label, createdBy } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateCode();
    try {
      const { rows } = await pool.query(
        `INSERT INTO admin_recipient_tokens (code, oa_id, label, expires_at, created_by, status)
         VALUES ($1, $2, $3, NOW() + INTERVAL '${Math.floor(TTL_MS / 1000)} seconds', $4, 'pending')
         RETURNING id, code, expires_at`,
        [code, oaId || null, label ? String(label).slice(0, 120) : null, createdBy || 'admin']
      );
      return { id: rows[0].id, code: rows[0].code, expiresAt: rows[0].expires_at, ttlMs: TTL_MS };
    } catch (err) {
      if (err.code === '23505' && attempt < 2) continue;
      throw err;
    }
  }
  throw new Error('failed to generate unique admin bind code after retries');
}

/**
 * Poll a token by id (admin UI). Lazy-expires pending tokens past TTL.
 */
async function getToken(pool, id) {
  const { rows } = await pool.query(
    `SELECT id, code, oa_id, label, status, claimed_user_id, claimed_at,
            recipient_id, expires_at, created_at
       FROM admin_recipient_tokens WHERE id=$1 LIMIT 1`,
    [id]
  );
  if (!rows.length) return null;
  const t = rows[0];
  if (t.status === 'pending' && new Date(t.expires_at).getTime() < Date.now()) {
    await pool.query(
      `UPDATE admin_recipient_tokens SET status='expired', updated_at=NOW()
         WHERE id=$1 AND status='pending'`,
      [id]
    );
    t.status = 'expired';
  }
  return t;
}

/** Revoke a still-pending token (admin cancelled before it was typed). */
async function revokeToken(pool, id) {
  const { rowCount } = await pool.query(
    `UPDATE admin_recipient_tokens SET status='revoked', updated_at=NOW()
       WHERE id=$1 AND status='pending'`,
    [id]
  );
  return rowCount > 0;
}

/**
 * Webhook entry — consume an ADMIN-XXXXXXXX code and create the recipient.
 * Returns { ok, reason?, recipientId?, label?, already? } so the webhook can
 * craft a Thai reply. `already: true` means this LINE account was ALREADY an
 * active recipient on this OA — treated as success (idempotent re-type).
 */
async function tryClaim(pool, { code, lineUserId, oaId } = {}) {
  if (!isClaimCode(code)) return { ok: false, reason: 'invalid' };
  if (!lineUserId || typeof lineUserId !== 'string') return { ok: false, reason: 'invalid' };
  const cleanCode = String(code).trim().toUpperCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, status, oa_id, label, expires_at
         FROM admin_recipient_tokens WHERE code=$1 FOR UPDATE`,
      [cleanCode]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'invalid' };
    }
    const t = rows[0];
    if (t.status === 'claimed') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'already_used' };
    }
    if (t.status === 'revoked') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'revoked' };
    }
    if (new Date(t.expires_at).getTime() < Date.now()) {
      await client.query(
        `UPDATE admin_recipient_tokens SET status='expired', updated_at=NOW() WHERE id=$1`,
        [t.id]
      );
      await client.query('COMMIT');
      return { ok: false, reason: 'expired' };
    }
    // Token issued for a specific OA must be typed into THAT OA's chat —
    // alerts push through the OA the recipient is bound on.
    if (t.oa_id && oaId && Number(t.oa_id) !== Number(oaId)) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'wrong_oa' };
    }
    // Bind strictly to the token's OWN scope (mirror services/ownerClaim.js):
    // a null-scoped (env) token rides the default OA via line_oa_id NULL
    // instead of silently latching onto whichever OA's chat it was typed into.
    const effectiveOaId = t.oa_id != null ? t.oa_id : null;
    // Already an active recipient on this OA? Idempotent success — refresh
    // the label if the token carried one, consume the token, done.
    const existing = await client.query(
      `SELECT id, enabled FROM admin_line_recipients
        WHERE COALESCE(line_oa_id, 0) = COALESCE($1::bigint, 0)
          AND line_user_id = $2
          AND revoked_at IS NULL
        LIMIT 1
        FOR UPDATE`,
      [effectiveOaId, lineUserId]
    );
    let recipientId;
    let already = false;
    if (existing.rows.length) {
      already = true;
      recipientId = existing.rows[0].id;
      await client.query(
        `UPDATE admin_line_recipients
            SET label = COALESCE($2, label), enabled = TRUE, updated_at = NOW()
          WHERE id = $1`,
        [recipientId, t.label || null]
      );
    } else {
      const ins = await client.query(
        `INSERT INTO admin_line_recipients (line_user_id, line_oa_id, label, enabled, created_by)
         VALUES ($1, $2, $3, TRUE, $4)
         RETURNING id`,
        [lineUserId, effectiveOaId, t.label || null, `token:${t.id}`]
      );
      recipientId = ins.rows[0].id;
    }
    await client.query(
      `UPDATE admin_recipient_tokens
          SET status='claimed', claimed_user_id=$2, claimed_at=NOW(),
              recipient_id=$3, updated_at=NOW()
        WHERE id=$1`,
      [t.id, lineUserId, recipientId]
    );
    await client.query('COMMIT');
    return { ok: true, recipientId, label: t.label || null, oaId: effectiveOaId, already };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      // Lost a race against a concurrent claim for the SAME LINE account on
      // this OA (two codes typed from two devices in the same second) — the
      // other transaction already created the recipient row, so the binding
      // factually succeeded. Report idempotent success; this token stays
      // pending and ages out via its TTL.
      return { ok: true, recipientId: null, label: null, oaId: oaId || null, already: true };
    }
    console.error('[adminRecipients] tryClaim error:', err.message);
    return { ok: false, reason: 'error', error: err.message };
  } finally {
    client.release();
  }
}

/**
 * Recipients for the management UI — active rows (revoked excluded by
 * default) with masked LINE ids and the OA name joined in.
 */
async function listRecipients(pool, { includeRevoked = false } = {}) {
  const { rows } = await pool.query(
    `SELECT r.id, r.line_user_id, r.line_oa_id, r.label, r.enabled,
            r.muted_categories,
            r.created_by, r.created_at, r.updated_at, r.revoked_at, r.revoked_by,
            o.name AS oa_name, o.slug AS oa_slug
       FROM admin_line_recipients r
       LEFT JOIN line_oas o ON o.id = r.line_oa_id
      ${includeRevoked ? '' : 'WHERE r.revoked_at IS NULL'}
      ORDER BY r.revoked_at IS NOT NULL, r.created_at ASC`
  );
  return rows.map((r) => ({
    id: r.id,
    label: r.label || null,
    lineUserIdMasked: maskLineUserId(r.line_user_id),
    lineOaId: r.line_oa_id,
    oaName: r.oa_name || null,
    oaSlug: r.oa_slug || null,
    enabled: r.enabled === true,
    mutedCategories: Array.isArray(r.muted_categories) ? r.muted_categories : [],
    createdBy: r.created_by || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    revokedAt: r.revoked_at,
    revokedBy: r.revoked_by || null,
  }));
}

/**
 * Replace a recipient's muted-category list. Input must already be
 * validated via validateMutedCategories — this function re-validates as a
 * defensive second layer (DB writes never trust route-level checks alone).
 */
async function setMutedCategories(pool, id, mutedCategories) {
  const check = validateMutedCategories(mutedCategories);
  if (!check.ok) {
    const err = new Error(`invalid notification categories: ${check.invalid.join(', ')}`);
    err.code = 'INVALID_CATEGORIES';
    err.invalid = check.invalid;
    throw err;
  }
  const { rows } = await pool.query(
    `UPDATE admin_line_recipients
        SET muted_categories=$2::jsonb, updated_at=NOW()
      WHERE id=$1 AND revoked_at IS NULL
      RETURNING id, muted_categories`,
    [id, JSON.stringify(check.list)]
  );
  if (!rows.length) return null;
  return { id: rows[0].id, mutedCategories: rows[0].muted_categories };
}

/** Mute / unmute without losing the binding. */
async function setEnabled(pool, id, enabled, updatedBy) {
  const { rows } = await pool.query(
    `UPDATE admin_line_recipients
        SET enabled=$2, updated_at=NOW()
      WHERE id=$1 AND revoked_at IS NULL
      RETURNING id, enabled`,
    [id, enabled === true]
  );
  if (!rows.length) return null;
  return { id: rows[0].id, enabled: rows[0].enabled, updatedBy: updatedBy || null };
}

/** Update the operator-facing label. */
async function setLabel(pool, id, label) {
  const { rows } = await pool.query(
    `UPDATE admin_line_recipients
        SET label=$2, updated_at=NOW()
      WHERE id=$1 AND revoked_at IS NULL
      RETURNING id, label`,
    [id, label ? String(label).slice(0, 120) : null]
  );
  return rows.length ? { id: rows[0].id, label: rows[0].label } : null;
}

/** Terminal revoke — the person must re-bind with a fresh code to return. */
async function revoke(pool, id, revokedBy) {
  const { rows } = await pool.query(
    `UPDATE admin_line_recipients
        SET revoked_at=NOW(), revoked_by=$2, enabled=FALSE, updated_at=NOW()
      WHERE id=$1 AND revoked_at IS NULL
      RETURNING id`,
    [id, revokedBy || null]
  );
  return rows.length > 0;
}

/**
 * Active (enabled, not revoked) recipients for the notifier fan-out.
 * Returns [{ line_user_id, line_oa_id }]. Fail-soft: a missing table on a
 * legacy deploy returns [] so notifyOwner keeps its old single-owner path.
 */
async function listActiveRecipients(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT line_user_id, line_oa_id, muted_categories FROM admin_line_recipients
        WHERE enabled = TRUE AND revoked_at IS NULL
        ORDER BY id ASC`
    );
    return rows;
  } catch (err) {
    if (err.code === '42P01') return [];          // pre-migration deploy
    if (err.code === '42703') {                   // table exists, column not yet migrated
      const { rows } = await pool.query(
        `SELECT line_user_id, line_oa_id FROM admin_line_recipients
          WHERE enabled = TRUE AND revoked_at IS NULL
          ORDER BY id ASC`
      );
      return rows.map((r) => ({ ...r, muted_categories: [] }));
    }
    throw err;
  }
}

module.exports = {
  generateCode,
  isClaimCode,
  maskLineUserId,
  createToken,
  getToken,
  revokeToken,
  tryClaim,
  listRecipients,
  setEnabled,
  setLabel,
  setMutedCategories,
  revoke,
  listActiveRecipients,
  CATEGORIES,
  validateMutedCategories,
  wantsCategory,
  TTL_MS,
};
