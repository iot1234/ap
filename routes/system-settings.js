// routes/system-settings.js
// DB-backed key/value system settings (replaces ad-hoc localStorage config).
// Each setting is one row in `system_settings`. Values are JSONB so callers
// can store anything that fits — strings, numbers, objects.
//
//   GET  /api/settings              — list all
//   GET  /api/settings/:key         — single
//   PUT  /api/settings/:key         — upsert (manager+; some keys owner-only)
//   POST /api/settings/:key/reset   — delete row → next read returns default

const express = require('express');
const { schemas } = require('../schemas');
const { validateBody } = require('../middleware/validate');

// Defaults shipped with the app. A "reset" sets the row back to whatever
// is here. Editing this object requires a deploy (intentional — these are
// boundaries, not user data).
const DEFAULT_SETTINGS = Object.freeze({
  'building.name':       { value: 'บ้านกาญจน์ เรสซิเดนซ์', description: 'ชื่อตึก/โครงการ' },
  'building.address':    { value: '', description: 'ที่อยู่ตึก' },
  'building.phone':      { value: '', description: 'เบอร์ติดต่อสำนักงาน' },
  'building.lineId':     { value: '', description: 'LINE ID ของสำนักงาน' },
  'billing.dayOfMonth':  { value: 1,  description: 'วันที่ออกบิลรายเดือน' },
  'billing.dueDay':      { value: 15, description: 'วันที่ครบกำหนดชำระ' },
  'billing.lateFeePctPerMonth': { value: 1.5, description: '% ค่าปรับล่าช้า/เดือน' },
  'rates.water':         { value: 18, description: 'ค่าน้ำ บาท/หน่วย' },
  'rates.elec':          { value: 8,  description: 'ค่าไฟ บาท/หน่วย' },
  'rates.wifi':          { value: 250, description: 'ค่า Wi-Fi บาท/เดือน' },
  'notify.bill.template': {
    value: '💰 บิลใหม่\nผู้เช่า: {{tenantName}}\nห้อง: {{roomId}}\nรอบ: {{period}}\nยอด: ฿{{total}}',
    description: 'เทมเพลต LINE/email สำหรับบิลใหม่',
  },
  'pdf.template':        { value: 'default', description: 'PDF template ของบิล' },
});

const OWNER_ONLY = new Set([
  'building.name', 'building.lineId', 'billing.lateFeePctPerMonth',
]);

module.exports = function buildSystemSettingsRouter(ctx) {
  const { pool, requireAuth, requireRole, sameOrigin, csrfGuard, audit } = ctx;
  const r = express.Router();

  r.get('/', requireAuth, async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT key, value, description, updated_by, updated_at FROM system_settings`
      );
      const stored = {};
      for (const row of rows) stored[row.key] = row;
      const out = {};
      // Merge defaults so the response is always complete.
      for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
        out[k] = stored[k] || { key: k, value: def.value, description: def.description };
      }
      // Include any custom keys persisted but not in defaults.
      for (const k of Object.keys(stored)) if (!(k in out)) out[k] = stored[k];
      res.json({ ok: true, settings: out, defaults: DEFAULT_SETTINGS });
    } catch (err) {
      console.error('settings list error:', err);
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    }
  });

  r.get('/:key', requireAuth, async (req, res) => {
    const key = String(req.params.key).slice(0, 128);
    try {
      const { rows } = await pool.query(
        `SELECT key, value, description, updated_by, updated_at FROM system_settings WHERE key=$1`,
        [key]
      );
      if (rows.length) return res.json({ ok: true, setting: rows[0] });
      const def = DEFAULT_SETTINGS[key];
      if (def) return res.json({ ok: true, setting: { key, value: def.value, description: def.description, isDefault: true } });
      res.status(404).json({ error: 'not found', code: 'NOT_FOUND' });
    } catch (err) {
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    }
  });

  // requireRole('owner','manager') front-loaded so the role check is visible
  // alongside the rest of the route's middleware chain (consistent with other
  // routes in the codebase). The OWNER_ONLY per-key check below is still
  // needed because it varies by which key is being written.
  r.put('/:key', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'), validateBody(schemas.systemSettingPut), async (req, res) => {
    const key = String(req.params.key).slice(0, 128);
    const role = req.session.user.role;
    if (OWNER_ONLY.has(key) && role !== 'owner') {
      return res.status(403).json({ error: 'this setting is owner-only', code: 'FORBIDDEN' });
    }
    const { value, description } = req.body;
    try {
      const { rows: prev } = await pool.query(`SELECT value FROM system_settings WHERE key=$1`, [key]);
      const { rows } = await pool.query(
        `INSERT INTO system_settings (key, value, description, updated_by)
         VALUES ($1, $2::jsonb, $3, $4)
         ON CONFLICT (key) DO UPDATE
           SET value=EXCLUDED.value,
               description=COALESCE(EXCLUDED.description, system_settings.description),
               updated_by=EXCLUDED.updated_by, updated_at=NOW()
         RETURNING *`,
        [key, JSON.stringify(value), description || DEFAULT_SETTINGS[key]?.description || null, req.session.user.username]
      );
      audit(req, 'setting.update', 'setting', key, {
        before: prev[0]?.value ?? null, after: value,
      });
      res.json({ ok: true, setting: rows[0] });
    } catch (err) {
      console.error('settings put error:', err);
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    }
  });

  r.post('/:key/reset', sameOrigin, csrfGuard, requireAuth, requireRole('owner', 'manager'), async (req, res) => {
    const key = String(req.params.key).slice(0, 128);
    try {
      await pool.query(`DELETE FROM system_settings WHERE key=$1`, [key]);
      audit(req, 'setting.reset', 'setting', key);
      const def = DEFAULT_SETTINGS[key];
      res.json({ ok: true, setting: def ? { key, value: def.value, isDefault: true } : null });
    } catch (err) {
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    }
  });

  return r;
};

module.exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
