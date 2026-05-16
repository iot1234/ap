// routes/reports.js
// Real reports backed by bills + tenants + maintenance_tickets. Replaces
// the localStorage-derived numbers in the admin dashboard. Each endpoint
// supports ?format=json|csv|xlsx so admins can export.

const express = require('express');

// Spreadsheet formula injection: a cell beginning with =, +, -, @, or tab/CR
// is interpreted by Excel/Sheets as a formula. Prefixing a single-quote (or
// in CSV, an apostrophe) tells the spreadsheet to treat it as text.
// Mitigates the "tenant submits =HYPERLINK(...) in a notes field, admin
// exports CSV, opens in Excel, browser opens malicious URL" attack.
const FORMULA_INJECTION_RE = /^[=+\-@\t\r]/;
function neutraliseFormula(s) {
  return FORMULA_INJECTION_RE.test(s) ? `'${s}` : s;
}

function rowsToCsv(rows) {
  if (!rows.length) return '';
  const header = Object.keys(rows[0]);
  const escape = (v) => {
    if (v == null) return '';
    let s = String(v).replace(/"/g, '""');
    s = neutraliseFormula(s);
    // Quote when the value contains a delimiter, quote, or any line break
    // (\r, \n, or \r\n). Without \r in the regex, Notes fields with bare
    // CR ended up split across multiple "rows" in Excel's CSV import.
    return /[",\r\n]/.test(s) ? `"${s}"` : s;
  };
  const lines = [header.join(',')];
  for (const row of rows) lines.push(header.map((h) => escape(row[h])).join(','));
  // CRLF for max-compat with Excel on Windows.
  return lines.join('\r\n');
}

async function rowsToXlsx(rows, sheetName) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName || 'Report');
  if (rows.length) {
    ws.columns = Object.keys(rows[0]).map((k) => ({ header: k, key: k, width: 18 }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    // Sanitise formula-leaders on string cells before adding the row. Numbers,
    // dates, booleans pass through unchanged so summable columns remain numeric.
    for (const r of rows) {
      const safe = {};
      for (const [k, v] of Object.entries(r)) {
        if (typeof v === 'string') safe[k] = neutraliseFormula(v);
        else safe[k] = v;
      }
      ws.addRow(safe);
    }
  }
  return wb.xlsx.writeBuffer();
}

function send(req, res, rows, sheetName) {
  const format = String(req.query.format || 'json').toLowerCase();
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${sheetName || 'report'}.csv"`);
    return res.send('﻿' + rowsToCsv(rows));
  }
  if (format === 'xlsx') {
    return rowsToXlsx(rows, sheetName).then((buf) => {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${sheetName || 'report'}.xlsx"`);
      res.end(Buffer.from(buf));
    });
  }
  res.json({ ok: true, rows });
}

module.exports = function buildReportsRouter(ctx) {
  const { pool, requireAuth, requireRole } = ctx;
  const r = express.Router();
  // All financial endpoints below require manager+. Revenue and cashflow
  // numbers are commercially sensitive and shouldn't be visible to staff or
  // readonly accounts. Maintenance stats are kept open since they're needed
  // for day-to-day work.
  const managerOrOwner = requireRole ? requireRole('owner', 'manager') : (_req, _res, next) => next();

  // GET /api/reports/overview — high-level counts/revenue snapshot from the
  // rooms + bookings blobs. Used by the admin overview page.
  r.get('/overview', requireAuth, managerOrOwner, async (_req, res) => {
    try {
      const [roomsRow, bookingsRow] = await Promise.all([
        pool.query(`SELECT value FROM app_data WHERE key='baankarn_rooms_v1'`),
        pool.query(`SELECT value FROM app_data WHERE key='baankarn_bookings_v1'`),
      ]);
      // Defensive parse: a corrupted JSONB blob (e.g. a debug write stored a
      // string instead of an object) would crash Object.values otherwise.
      const rawRooms = roomsRow.rows.length ? roomsRow.rows[0].value : {};
      const roomsObj = rawRooms && typeof rawRooms === 'object' && !Array.isArray(rawRooms)
        ? rawRooms : {};
      const bookings = bookingsRow.rows.length && Array.isArray(bookingsRow.rows[0].value)
        ? bookingsRow.rows[0].value : [];
      const rooms = Object.values(roomsObj);
      const occupied = rooms.filter((x) => x.status === 'occupied').length;
      const overdue = rooms.filter((x) => x.status === 'overdue').length;
      const reserved = rooms.filter((x) => x.status === 'reserved').length;
      const vacant = rooms.filter((x) => x.status === 'vacant').length;
      const maintenance = rooms.filter((x) => x.status === 'maintenance').length;
      const totalRent = rooms.reduce((s, x) => s + (Number(x.rent) || 0), 0);
      const occupiedRevenue = rooms
        .filter((x) => x.status === 'occupied' || x.status === 'overdue')
        .reduce((s, x) => s + (Number(x.rent) || 0), 0);
      const pendingBookings = bookings.filter((b) => b.status === 'pending').length;
      res.json({
        ok: true,
        counts: { occupied, overdue, reserved, vacant, maintenance, total: rooms.length },
        revenue: { potential: totalRent, occupied: occupiedRevenue },
        bookings: { pending: pendingBookings, total: bookings.length },
      });
    } catch (err) {
      console.error('reports overview error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // GET /api/reports/aged-receivable — buckets overdue rooms by days late
  // using the overdueDays field already maintained in the rooms blob.
  r.get('/aged-receivable', requireAuth, managerOrOwner, async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT value FROM app_data WHERE key='baankarn_rooms_v1'`
      );
      const roomsObj = rows.length ? rows[0].value : {};
      const buckets = {
        'current': { range: '0-30', rooms: 0, amount: 0 },
        'late_30': { range: '31-60', rooms: 0, amount: 0 },
        'late_60': { range: '61-90', rooms: 0, amount: 0 },
        'late_90': { range: '90+',   rooms: 0, amount: 0 },
      };
      Object.values(roomsObj || {}).forEach((rm) => {
        if (rm.status !== 'overdue') return;
        const days = Number(rm.overdueDays) || 0;
        const amt = Number(rm.rent) || 0;
        let key = 'current';
        if (days > 90)      key = 'late_90';
        else if (days > 60) key = 'late_60';
        else if (days > 30) key = 'late_30';
        buckets[key].rooms += 1;
        buckets[key].amount += amt;
      });
      res.json({ ok: true, buckets: Object.values(buckets) });
    } catch (err) {
      console.error('reports aged-receivable error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // GET /api/reports/bills.xlsx — current-month bill estimate workbook.
  r.get('/bills.xlsx', requireAuth, managerOrOwner, async (_req, res) => {
    let ExcelJS;
    try { ExcelJS = require('exceljs'); }
    catch { return res.status(500).json({ error: 'exceljs not installed' }); }
    try {
      const [roomsRow, configRow] = await Promise.all([
        pool.query(`SELECT value FROM app_data WHERE key='baankarn_rooms_v1'`),
        pool.query(`SELECT value FROM app_data WHERE key='baankarn_config_v1'`),
      ]);
      const rooms = Object.values(roomsRow.rows.length ? roomsRow.rows[0].value : {});
      const config = configRow.rows.length ? configRow.rows[0].value : {};
      const waterRate = config?.utilities?.waterRate ?? 18;
      const elecRate  = config?.utilities?.elecRate  ?? 8;
      const wifiFee   = config?.utilities?.wifi      ?? 250;

      const wb = new ExcelJS.Workbook();
      wb.creator = config?.building?.name || 'บ้านกาญจน์ เรสซิเดนซ์';
      wb.created = new Date();
      const ws = wb.addWorksheet('บิลรอบนี้');
      ws.columns = [
        { header: 'ห้อง', key: 'room', width: 8 },
        { header: 'ผู้เช่า', key: 'tenant', width: 28 },
        { header: 'สถานะ', key: 'status', width: 12 },
        { header: 'ค่าเช่า', key: 'rent', width: 12, style: { numFmt: '#,##0.00' } },
        { header: 'ค่าน้ำ', key: 'water', width: 12, style: { numFmt: '#,##0.00' } },
        { header: 'ค่าไฟ', key: 'elec', width: 12, style: { numFmt: '#,##0.00' } },
        { header: 'Wi-Fi', key: 'wifi', width: 10, style: { numFmt: '#,##0.00' } },
        { header: 'รวม', key: 'total', width: 14, style: { numFmt: '#,##0.00' } },
      ];
      ws.getRow(1).font = { bold: true };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAF6EE' } };
      ws.views = [{ state: 'frozen', ySplit: 1 }];

      rooms
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .forEach((rm) => {
          const water = (Number(rm.waterUnits) || 0) * waterRate;
          const elec  = (Number(rm.elecUnits)  || 0) * elecRate;
          const total = (Number(rm.rent) || 0) + water + elec + wifiFee;
          ws.addRow({
            room: rm.id,
            tenant: rm.tenant?.name || '—',
            status: rm.status || '—',
            rent: Number(rm.rent) || 0,
            water,
            elec,
            wifi: wifiFee,
            total,
          });
        });

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', `attachment; filename="bills-${new Date().toISOString().slice(0,10)}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (err) {
      console.error('reports xlsx error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    }
  });

  // GET /api/reports/maintenance — ticket counts/cost aggregates. Optional
  // ?period=YYYY-MM. Open to staff (day-to-day visibility).
  r.get('/maintenance', requireAuth, async (req, res) => {
    // The regex below already constrains period to YYYY-MM (no SQL metachars
    // can pass), but we still parameterise so any future regex relaxation
    // doesn't silently open an injection vector.
    const period = String(req.query.period || '').match(/^\d{4}-\d{2}$/) ? req.query.period : null;
    const where = period ? `WHERE to_char(created_at, 'YYYY-MM') = $1` : '';
    const params = period ? [period] : [];
    try {
      const [byStatus, ratings, costs, byCategory] = await Promise.all([
        pool.query(`SELECT status, COUNT(*) AS n FROM maintenance_tickets ${where} GROUP BY status`, params),
        pool.query(
          `SELECT AVG(rating)::numeric(3,2) AS avg_rating, COUNT(rating) AS rated
             FROM maintenance_tickets ${period ? where + ' AND ' : 'WHERE '} rating IS NOT NULL`,
          params
        ),
        pool.query(`SELECT
                      SUM(cost)::numeric(12,2) AS total_cost,
                      (AVG(cost) FILTER (WHERE cost > 0))::numeric(10,2) AS avg_cost,
                      COUNT(*) FILTER (WHERE cost > 0) AS billed_count,
                      (SUM(cost) FILTER (WHERE status='completed'))::numeric(12,2) AS completed_cost
                    FROM maintenance_tickets ${where}`, params),
        pool.query(
          `SELECT category, COUNT(*) AS n, SUM(cost)::numeric(12,2) AS cost_total
             FROM maintenance_tickets ${where} GROUP BY category ORDER BY n DESC`,
          params
        ),
      ]);
      const counts = {};
      byStatus.rows.forEach((x) => { counts[x.status] = Number(x.n); });
      const c = costs.rows[0] || {};
      res.json({
        ok: true,
        period: period || 'all',
        counts,
        avgRating: ratings.rows[0]?.avg_rating != null ? Number(ratings.rows[0].avg_rating) : null,
        ratedCount: Number(ratings.rows[0]?.rated || 0),
        cost: {
          total: Number(c.total_cost || 0),
          avg: Number(c.avg_cost || 0),
          billedCount: Number(c.billed_count || 0),
          completedTotal: Number(c.completed_cost || 0),
        },
        byCategory: byCategory.rows.map((x) => ({
          category: x.category, count: Number(x.n), cost: Number(x.cost_total || 0),
        })),
      });
    } catch (err) {
      console.error('reports maintenance error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // GET /api/reports/revenue?year=2026&month=5
  // Sum of paid bills per period. If month omitted → 12-month series for the year.
  r.get('/revenue', requireAuth, managerOrOwner, async (req, res) => {
    const year = Number(req.query.year) || new Date().getFullYear();
    const month = req.query.month ? Number(req.query.month) : null;
    try {
      let rows;
      if (month) {
        const period = `${year}-${String(month).padStart(2, '0')}`;
        const q = await pool.query(
          `SELECT period, COUNT(*)::int AS bills,
                  COALESCE(SUM(total)::numeric, 0)::numeric(12,2) AS total_amount,
                  COALESCE(SUM(CASE WHEN status='paid' THEN total ELSE 0 END), 0)::numeric(12,2) AS paid_amount,
                  COALESCE(SUM(CASE WHEN status='overdue' THEN total ELSE 0 END), 0)::numeric(12,2) AS overdue_amount
             FROM bills WHERE deleted_at IS NULL AND period=$1 GROUP BY period`,
          [period]
        );
        rows = q.rows;
      } else {
        const periods = [];
        for (let m = 1; m <= 12; m++) periods.push(`${year}-${String(m).padStart(2, '0')}`);
        const q = await pool.query(
          `SELECT period, COUNT(*)::int AS bills,
                  COALESCE(SUM(total), 0)::numeric(12,2) AS total_amount,
                  COALESCE(SUM(CASE WHEN status='paid' THEN total ELSE 0 END), 0)::numeric(12,2) AS paid_amount,
                  COALESCE(SUM(CASE WHEN status='overdue' THEN total ELSE 0 END), 0)::numeric(12,2) AS overdue_amount
             FROM bills WHERE deleted_at IS NULL AND period = ANY($1)
             GROUP BY period ORDER BY period ASC`,
          [periods]
        );
        // Fill missing months with zeros so charts have a full series.
        const byPeriod = Object.fromEntries(q.rows.map((r) => [r.period, r]));
        rows = periods.map((p) => byPeriod[p] || {
          period: p, bills: 0, total_amount: 0, paid_amount: 0, overdue_amount: 0,
        });
      }
      send(req, res, rows, `revenue-${year}${month ? '-' + month : ''}`);
    } catch (err) {
      console.error('revenue report error:', err);
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    }
  });

  // GET /api/reports/occupancy?year=2026
  // Months count rooms occupied at any point during the month; vs. total
  // active rooms snapshot. Without history table we approximate using
  // current rooms blob + bills count.
  r.get('/occupancy', requireAuth, managerOrOwner, async (req, res) => {
    const year = Number(req.query.year) || new Date().getFullYear();
    try {
      const totalRoomsRow = await pool.query(
        `SELECT COALESCE(jsonb_object_keys_count(value), 0)::int AS n
           FROM (SELECT value FROM app_data WHERE key='baankarn_rooms_v1') s`
      ).catch(async () => {
        // Fallback if the helper function doesn't exist
        const r = await pool.query(`SELECT value FROM app_data WHERE key='baankarn_rooms_v1'`);
        const n = r.rows.length ? Object.keys(r.rows[0].value || {}).length : 0;
        return { rows: [{ n }] };
      });
      const totalRooms = totalRoomsRow.rows[0]?.n || 0;

      const periods = [];
      for (let m = 1; m <= 12; m++) periods.push(`${year}-${String(m).padStart(2, '0')}`);
      const q = await pool.query(
        `SELECT period, COUNT(DISTINCT room_id)::int AS occupied
           FROM bills WHERE deleted_at IS NULL AND period = ANY($1)
           GROUP BY period`,
        [periods]
      );
      const byPeriod = Object.fromEntries(q.rows.map((x) => [x.period, x.occupied]));
      const rows = periods.map((p) => {
        const occ = byPeriod[p] || 0;
        return {
          period: p,
          total_rooms: totalRooms,
          occupied: occ,
          rate_pct: totalRooms > 0 ? Math.round((occ / totalRooms) * 1000) / 10 : 0,
        };
      });
      send(req, res, rows, `occupancy-${year}`);
    } catch (err) {
      console.error('occupancy report error:', err);
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    }
  });

  // GET /api/reports/overdue — aged-receivable on real bills (replaces the
  // app_data-derived /api/reports/aged-receivable from server.js).
  r.get('/overdue', requireAuth, managerOrOwner, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          CASE
            WHEN due_date >= CURRENT_DATE THEN 'current'
            WHEN due_date >= CURRENT_DATE - INTERVAL '30 days' THEN 'late_0_30'
            WHEN due_date >= CURRENT_DATE - INTERVAL '60 days' THEN 'late_31_60'
            WHEN due_date >= CURRENT_DATE - INTERVAL '90 days' THEN 'late_61_90'
            ELSE 'late_over_90'
          END AS bucket,
          COUNT(*)::int AS bills,
          COALESCE(SUM(total), 0)::numeric(12,2) AS amount
        FROM bills
        WHERE deleted_at IS NULL AND status IN ('pending','overdue')
        GROUP BY 1 ORDER BY 1
      `);
      const buckets = ['current','late_0_30','late_31_60','late_61_90','late_over_90'];
      const byKey = Object.fromEntries(rows.map((x) => [x.bucket, x]));
      const filled = buckets.map((b) => byKey[b] || { bucket: b, bills: 0, amount: 0 });
      send(req, res, filled, 'overdue');
    } catch (err) {
      console.error('overdue report error:', err);
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    }
  });

  // GET /api/reports/maintenance/stats — SLA + avg resolve time
  r.get('/maintenance/stats', requireAuth, async (req, res) => {
    try {
      const counts = await pool.query(
        `SELECT status, COUNT(*)::int AS n FROM maintenance_tickets GROUP BY status`
      );
      const slaQ = await pool.query(`
        SELECT
          AVG(EXTRACT(EPOCH FROM (completed_at - created_at))/3600)::numeric(8,2) AS avg_hours_to_resolve,
          AVG(rating)::numeric(3,2) AS avg_rating,
          COUNT(rating)::int AS rated,
          COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
          COUNT(*) FILTER (WHERE priority = 'critical' AND status NOT IN ('completed','cancelled'))::int AS open_critical
        FROM maintenance_tickets
      `);
      const stats = slaQ.rows[0];
      const byStatus = {};
      for (const r of counts.rows) byStatus[r.status] = r.n;
      const format = String(req.query.format || 'json').toLowerCase();
      if (format === 'csv' || format === 'xlsx') {
        const exportRows = [{
          total: Number(stats.completed || 0)
            + Number(byStatus.open || 0)
            + Number(byStatus.in_progress || 0)
            + Number(byStatus.assigned || 0)
            + Number(byStatus.cancelled || 0),
          completed: Number(stats.completed || 0),
          assigned: Number(byStatus.assigned || 0),
          in_progress: Number(byStatus.in_progress || 0),
          open: Number(byStatus.open || 0),
          cancelled: Number(byStatus.cancelled || 0),
          open_critical: Number(stats.open_critical || 0),
          avg_hours_to_resolve: stats.avg_hours_to_resolve || '',
          avg_rating: stats.avg_rating || '',
          rated: Number(stats.rated || 0),
        }];
        return send(req, res, exportRows, 'maintenance-stats');
      }
      res.json({ ok: true, byStatus, ...stats });
    } catch (err) {
      console.error('maintenance stats error:', err);
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    }
  });

  // GET /api/reports/cashflow?months=12 — naive projection from recent average
  r.get('/cashflow', requireAuth, managerOrOwner, async (req, res) => {
    const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 24);
    try {
      const avg = await pool.query(`
        SELECT AVG(total)::numeric(12,2) AS avg_per_bill,
               COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '90 days')::int AS recent_count
          FROM bills WHERE deleted_at IS NULL AND status = 'paid'
      `);
      const a = avg.rows[0];
      const monthlyRevenueEst = (Number(a.avg_per_bill) || 0) * (a.recent_count / 3);  // rough monthly
      const rows = [];
      const now = new Date();
      for (let i = 0; i < months; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
        rows.push({
          period: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
          projected: Math.round(monthlyRevenueEst * 100) / 100,
        });
      }
      send(req, res, rows, 'cashflow');
    } catch (err) {
      console.error('cashflow report error:', err);
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    }
  });

  return r;
};
