// middleware/validate.js
// Zod schema → Express middleware adapter. Each call returns a function
// that parses req.body (or req.query/params) and replaces it with the
// validated, transformed value. On failure responds with a structured
// 400 error containing field-level Thai messages.
//
//   const { schemas } = require('../schemas');
//   const { validateBody } = require('../middleware/validate');
//   app.post('/api/x', validateBody(schemas.createTenant), handler);

function formatZodError(err) {
  return {
    error: 'ข้อมูลไม่ถูกต้อง',
    code: 'VALIDATION_ERROR',
    issues: err.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
      code: i.code,
    })),
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
