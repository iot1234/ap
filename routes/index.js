// routes/index.js
// Mounts every routes/* router under their canonical prefix. server.js
// passes a context object containing the shared dependencies (pool,
// middlewares, helpers) so the routers don't need to require server.js.

module.exports = function mountRoutes(app, ctx) {
  const rooms = require('./rooms')(ctx);
  const settings = require('./system-settings')(ctx);
  const reports = require('./reports')(ctx);
  const tenantOps = require('./tenant-ops')(ctx);
  const billsExtras = require('./bills-extras')(ctx);
  const webhooks = require('./webhooks')(ctx);
  const adminSecrets = require('./admin-secrets')(ctx);
  const adminLineBindings = require('./admin-line-bindings')(ctx);
  const adminLineOas = require('./admin-line-oas')(ctx);
  const recurring = require('./recurring-charges')(ctx);

  // Run any per-router bootstrap (e.g. table creation for rooms_v2)
  const bootstraps = [rooms.bootstrap].filter(Boolean);

  app.use('/api/rooms', rooms);
  app.use('/api/settings', settings);
  app.use('/api/reports', reports);
  app.use('/api/tenants', tenantOps);
  app.use('/api/bills', billsExtras);
  app.use('/api/recurring-charges', recurring);
  app.use('/api/admin/secrets', adminSecrets);
  app.use('/api/admin/line-bindings', adminLineBindings);
  app.use('/api/admin/line-oas', adminLineOas);
  app.use('/webhook', webhooks);

  return { bootstraps };
};
