const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('parcel feature flag is registered and returns a clear disabled payload', () => {
  const features = require('../services/features');
  assert.equal(features.DEFAULTS.parcelNotifications.enabled, false);
  const payload = features.disabledPayload('parcelNotifications', { id: 'req-1' });
  assert.equal(payload.code, 'FEATURE_DISABLED');
  assert.equal(payload.feature, 'parcelNotifications');
  assert.equal(payload.enabled, false);
  assert.match(payload.message, /Parcel notifications/);
  assert.equal(payload.requestId, 'req-1');
});

test('parcel request schemas normalize optional strings and reject bad status', () => {
  const { schemas } = require('../schemas');
  const create = schemas.createParcel.parse({
    roomId: ' 101 ',
    trackingNo: '',
    shelfLocation: ' Shelf A ',
    notify: true,
  });
  assert.equal(create.roomId, '101');
  assert.equal(create.trackingNo, undefined);
  assert.equal(create.shelfLocation, 'Shelf A');
  assert.throws(() => schemas.createParcel.parse({ roomId: '' }));
  assert.throws(() => schemas.updateParcel.parse({ status: 'waiting' }));
  assert.equal(schemas.updateParcel.parse({ status: 'picked_up' }).status, 'picked_up');
});

test('parcel routes are mounted behind feature gates and tenant isolation', () => {
  const index = read('routes', 'index.js');
  assert.match(index, /require\('\.\/parcels'\)\(ctx\)/);
  assert.match(index, /app\.use\('\/api\/parcels', parcels\.admin\)/);
  assert.match(index, /app\.use\('\/api\/tenant\/parcels', parcels\.tenant\)/);

  const route = read('routes', 'parcels.js');
  assert.match(route, /admin\.get\('\/rooms'/);
  assert.match(route, /admin\.delete\('\/:id'/);
  assert.match(route, /features\.requireFeature\('parcelNotifications'\)/);
  assert.match(route, /notifier\.notifyTenant/);
  assert.match(route, /notify_attempt_count/);
  assert.match(route, /notify_success_count/);
  assert.match(route, /notify_channels/);
  assert.match(route, /ACTIVE_TENANT_NOT_FOUND/);
  assert.match(route, /AMBIGUOUS_ACTIVE_TENANT/);
  assert.match(route, /PARCEL_TERMINAL/);
  assert.match(route, /PARCEL_ALREADY_CLOSED/);
  assert.match(route, /parcel\.delete/);
  assert.match(route, /p\.tenant_id=\$1/);
  assert.match(route, /req\.tenant\.tenant_id/);
});

test('parcel table is migrated, backed up, and restored', () => {
  const migration = read('db', 'migrate.js');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS parcels/);
  assert.match(migration, /parcel_no\s+TEXT UNIQUE NOT NULL/);
  assert.match(migration, /notify_attempt_count INT NOT NULL DEFAULT 0/);
  assert.match(migration, /notify_success_count INT NOT NULL DEFAULT 0/);
  assert.match(migration, /notify_channels\s+TEXT\[\] NOT NULL DEFAULT '\{\}'::TEXT\[\]/);
  assert.match(migration, /idx_parcels_tenant/);
  assert.match(migration, /chk_parcels_status_valid/);

  const backup = read('scripts', 'backup.js');
  assert.match(backup, /'recurring_charges', 'parcels'/);
  assert.match(backup, /'maintenance_tickets', 'parcels', 'file_uploads'/);

  const server = read('server.js');
  assert.match(server, /'payments', 'parcels', 'access_cards'/);
});

test('admin and tenant UIs expose parcels only through the feature-aware paths', () => {
  const adminShell = read('project', 'admin', 'shell.jsx');
  assert.match(adminShell, /id: 'parcels'/);
  assert.match(adminShell, /window\.PageParcels/);

  const adminPage = read('project', 'admin', 'page-parcels.jsx');
  assert.match(adminPage, /\/api\/parcels/);
  assert.match(adminPage, /\/api\/parcels\/rooms/);
  assert.match(adminPage, /method: 'DELETE'/);
  assert.match(adminPage, /notifySummary/);
  assert.match(adminPage, /roomOptions\.map/);
  assert.match(adminPage, /FEATURE_DISABLED/);
  assert.match(adminPage, /window\.PageParcels = PageParcels/);

  const featurePage = read('project', 'admin', 'page-features.jsx');
  assert.match(featurePage, /Row id="parcelNotifications"/);

  const tenant = read('project', 'tenant.jsx');
  assert.match(tenant, /feature: 'parcelNotifications'/);
  assert.match(tenant, /function tenantNavItems\(features\)/);
  assert.match(tenant, /tenantNavItems\(features\)\.map/);
  assert.match(tenant, /tenantNavItems\(features\)\.filter/);
  assert.match(tenant, /parcelEnabled \? api\('\/api\/tenant\/parcels'\) : Promise\.resolve\(\{ parcels: \[\] \}\)/);
  assert.match(tenant, /page === 'parcels' && features\?\.parcelNotifications\?\.enabled !== true/);
});
