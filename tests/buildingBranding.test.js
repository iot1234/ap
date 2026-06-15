const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const fixedBrandRe = /บ้านกาญจน์|เรสซิเดนซ์|Baan Karn/;

test('public dashboard derives branding from baankarn_config_v1', () => {
  const src = read('project', 'app.jsx');
  assert.match(src, /fetch\('\/api\/data\/baankarn_config_v1'/);
  assert.match(src, /function normalizeBuildingName/);
  assert.match(src, /function buildingLogoUrl/);
  assert.match(src, /building=\{building\}/);
  assert.doesNotMatch(src, fixedBrandRe);
});

test('tenant portal uses configured building branding before and after login', () => {
  const src = read('project', 'tenant.jsx');
  assert.match(src, /function storedPublicBuilding/);
  assert.match(src, /function extractPublicBuilding/);
  assert.match(src, /function buildingLogoOf/);
  assert.match(src, /fetch\('\/api\/data\/baankarn_config_v1'/);
  assert.match(src, /function LoginView\([\s\S]*building/);
  assert.match(src, /function Sidebar\([\s\S]*building/);
  assert.match(src, /function DrawerNav\([\s\S]*building/);
  assert.match(src, /function LogoMark\(\{[\s\S]*logo/);
  assert.match(src, /building=\{effectiveBuilding\}/);
  assert.doesNotMatch(src, fixedBrandRe);
});

test('static branding helper renders configured logo safely', () => {
  const src = read('project', 'building-branding.js');
  assert.match(src, /function cleanLogoUrl/);
  assert.match(src, /\^\\\/files\\\/\\d\+\$/);
  assert.match(src, /data-building-logo-img/);
  assert.match(src, /data-building-logo-active/);
  assert.match(src, /return \{ name, initials: mark, logo \}/);
});

test('static entry pages load public building branding helper', () => {
  const pages = [
    ['project', 'Admin Dashboard.html'],
    ['project', 'Dorm Status Dashboard.html'],
    ['project', 'tenant.html'],
    ['project', 'login.html'],
    ['project', 'booking.html'],
    ['project', 'maintenance.html'],
  ];
  for (const parts of pages) {
    const src = read(...parts);
    assert.match(src, /\/building-branding\.js/, `${parts.join('/')} should load branding helper`);
    assert.match(src, /data-building-title-template/, `${parts.join('/')} should declare a title template`);
    assert.doesNotMatch(src, fixedBrandRe, `${parts.join('/')} must not hardcode the legacy building name`);
  }

  for (const parts of [
    ['project', 'login.html'],
    ['project', 'booking.html'],
    ['project', 'maintenance.html'],
  ]) {
    const src = read(...parts);
    assert.match(src, /data-building-name/);
    assert.match(src, /data-building-initials/);
  }
});

test('contract-fill title follows the invitation building payload', () => {
  const src = read('project', 'contract-fill.html');
  assert.doesNotMatch(src, fixedBrandRe);
  assert.match(src, /document\.title = `กรอกสัญญาเช่า · \$\{name\}`/);
  assert.match(src, /view\.building\?\.name \|\| 'ที่พักของคุณ'/);
});

test('backend-generated artifacts fall back to generic building name only', () => {
  for (const parts of [
    ['server.js'],
    ['routes', 'bills-extras.js'],
    ['project', 'admin', 'shared.jsx'],
    ['project', 'admin', 'page-billing.jsx'],
    ['project', 'admin', 'page-line-oas.jsx'],
    ['project', 'admin', 'page-production-readiness.jsx'],
    ['services', 'billPayments.js'],
    ['services', 'pdf.js'],
    ['services', 'contractPdf.js'],
    ['routes', 'reports.js'],
    ['routes', 'system-settings.js'],
  ]) {
    const src = read(...parts);
    assert.doesNotMatch(src, fixedBrandRe, `${parts.join('/')} must not use the legacy brand fallback`);
  }
});

test('public config API exposes only safe building branding fields', () => {
  const server = read('server.js');
  const block = server.match(/function maskConfigPublic\(cfg\) \{[\s\S]+?\n\}/);
  assert.ok(block, 'maskConfigPublic must be present');
  assert.match(block[0], /name:\s*cfg\.building\.name/);
  assert.match(block[0], /logo:\s*normalizeBuildingLogoUrl\(cfg\.building\.logo\)/);
  assert.match(block[0], /address:\s*cfg\.building\.address/);
  assert.match(block[0], /phone:\s*cfg\.building\.phone/);
  assert.doesNotMatch(block[0], /notify|secrets|automation|lineOa/i);
});

test('backend manages building logo through a restricted upload flow', () => {
  const server = read('server.js');
  assert.match(server, /app\.post\('\/api\/admin\/building-logo'/);
  assert.match(server, /app\.delete\('\/api\/admin\/building-logo'/);
  assert.match(server, /requireRole\('owner', 'manager'\)/);
  assert.match(server, /category:\s*'building_logo'/);
  assert.match(server, /maxBytes:\s*750_000/);
  assert.match(server, /const PUBLIC_FILE_CATEGORIES = new Set\(\['room_photo', 'building_logo'\]\)/);
  assert.match(server, /normalizeBuildingLogoUrl\(cfg\.building\.logo\)/);
  assert.match(server, /fileUrlHasCategory\(logo, 'building_logo'\)/);
  assert.match(server, /removeFileUrlIfCategory\(oldLogo, 'building_logo'/);
  assert.match(server, /building\.logo ต้องเป็นไฟล์โลโก้/);
});

test('admin settings can upload and clear the dorm logo', () => {
  const settings = read('project', 'admin', 'page-settings.jsx');
  const shell = read('project', 'admin', 'shell.jsx');
  const shared = read('project', 'admin', 'shared.jsx');
  assert.match(settings, /normalizeBuildingLogoInput/);
  assert.match(settings, /value:\s*'branding'[\s\S]*label:\s*'โลโก้'/);
  assert.match(settings, /tab === 'branding'/);
  assert.match(settings, /setTab\('branding'\)/);
  assert.match(settings, /function TabBranding/);
  assert.match(settings, /function LogoSettingsPanel/);
  assert.match(settings, /\/api\/admin\/building-logo/);
  assert.match(settings, /accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(settings, /canManageBrand/);
  assert.match(shared, /logo:\s+''/);
  assert.match(shell, /function normalizeAdminLogoUrl/);
  assert.match(shell, /buildingLogo=\{config\?\.building\?\.logo\}/);
});

test('admin seed includes a neutral editable default building name', () => {
  const shared = read('project', 'admin', 'shared.jsx');
  const settings = read('routes', 'system-settings.js');
  assert.match(shared, /name:\s+'ที่พักของคุณ'/);
  assert.match(settings, /'building\.name':\s+\{\s*value:\s+'ที่พักของคุณ'/);
  assert.doesNotMatch(shared, fixedBrandRe);
});
