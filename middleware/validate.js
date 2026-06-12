// middleware/validate.js
// Zod schema → Express middleware adapter. Each call returns a function
// that parses req.body (or req.query/params) and replaces it with the
// validated, transformed value. On failure responds with a structured
// 400 error containing field-level Thai messages.
//
//   const { schemas } = require('../schemas');
//   const { validateBody } = require('../middleware/validate');
//   app.post('/api/x', validateBody(schemas.createTenant), handler);

function formatZodIssue(issue) {
  const path = issue.path.join('.');
  if (issue.code === 'unrecognized_keys') {
    const keys = Array.isArray(issue.keys) ? issue.keys : [];
    const keyText = keys.length ? keys.join(', ') : 'ฟิลด์ส่วนเกิน';
    return {
      path: path || 'ข้อมูล',
      message: `มีข้อมูลส่วนเกินที่ระบบไม่รับ: ${keyText}`,
      code: issue.code,
      keys,
      fix: 'รีเฟรชหน้าเว็บแล้วลองบันทึกใหม่ หากยังขึ้นซ้ำให้ตรวจว่าหน้านี้เป็นเวอร์ชันล่าสุด',
    };
  }
  return {
    path,
    message: issue.message,
    code: issue.code,
  };
}

function formatZodError(err) {
  return {
    error: 'ข้อมูลที่กรอกไม่ถูกต้อง',
    code: 'VALIDATION_ERROR',
    hint: 'ตรวจช่องที่ระบบแจ้ง แล้วลองบันทึกอีกครั้ง',
    issues: err.issues.map(formatZodIssue),
  };
}

function validateBody(schema) {
  return function (req, res, next) {
    const r = schema.safeParse(req.body || {});
    if (!r.success) return res.status(400).json(formatZodError(r.error));
    req.body = r.data;
    next();
  };
}

function validateQuery(schema) {
  return function (req, res, next) {
    const r = schema.safeParse(req.query || {});
    if (!r.success) return res.status(400).json(formatZodError(r.error));
    req.validatedQuery = r.data;
    next();
  };
}

function validateParams(schema) {
  return function (req, res, next) {
    const r = schema.safeParse(req.params || {});
    if (!r.success) return res.status(400).json(formatZodError(r.error));
    req.params = { ...req.params, ...r.data };
    next();
  };
}

module.exports = { validateBody, validateQuery, validateParams, formatZodError };
