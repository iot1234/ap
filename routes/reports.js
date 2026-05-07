// routes/reports.js
// Real reports backed by bills + tenants + maintenance_tickets. Replaces
// the localStorage-derived numbers in the admin dashboard. Each endpoint
// supports ?format=json|csv|xlsx so admins can export.

const express = require('express');

function rowsToCsv(rows) {
  if (!rows.length) return '';
  const header = Object.keys(rows[0]);
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const lines = [header.join(',')];
  for (const row of rows) lines.push(header.map((h) => escape(row[h])).join(','));
  return lines.join('\n');
}

async function rowsToXlsx(rows, sheetName) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName || 'Report');
  if (rows.length) {
    ws.columns = Object.keys(rows[0]).map((k) => ({ header: k, key: k, width: 18 }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of rows) ws.addRow(r);
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
  const { pool, requireAuth } = ctx;
  const r = express.Router();

  // GET /api/reports/revenue?year=2026&month=5
  // Sum of paid bills per period. If month omitted → 12-month series for the year.
  r.get('/revenue', requireAuth, async (req, res) => {
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
  r.get('/occupancy', requireAuth, async (req, res) => {
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
  r.get('/overdue', requireAuth, async (req, res) => {
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
      res.json({ ok: true, byStatus, ...stats });
    } catch (err) {
      console.error('maintenance stats error:', err);
      res.status(500).json({ error: 'internal error', code: 'DB_ERROR' });
    }
  });

  // GET /api/reports/cashflow?months=12 — naive projection from recent average
  r.get('/cashflow', requireAuth, async (req, res) => {
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
