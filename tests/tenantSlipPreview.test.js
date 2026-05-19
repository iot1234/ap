const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const serverSource = () => fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const tenantSource = () => fs.readFileSync(path.join(__dirname, '..', 'project', 'tenant.jsx'), 'utf8');
const tenantHtml = () => fs.readFileSync(path.join(__dirname, '..', 'project', 'tenant.html'), 'utf8');

test('tenant payments list does not return raw slip_url and only flags previewable slips', () => {
  const src = serverSource();
  const m = src.match(
    /app\.get\('\/api\/tenant\/payments',[\s\S]*?const \{ rows \} = await pool\.query\(\s*`([\s\S]*?)`/
  );
  assert.ok(m, 'should find tenant payments list query');
  const sql = m[1];
  assert.ok(!/p\.slip_url\s*(?:,|\bAS\b)/i.test(sql),
    'tenant list must not select raw slip_url');
  assert.match(sql, /has_slip/i,
    'tenant list should expose only a has_slip boolean');
  assert.match(sql, /LEFT JOIN file_uploads sf ON p\.slip_url = '\/files\/' \|\| sf\.id::text/,
    'has_slip must be based on the canonical file_uploads row');
  assert.match(sql, /sf\.category='slip'/,
    'has_slip must only be true for slip files');
  assert.match(sql, /public-pay:/,
    'has_slip must also cover slips uploaded through the tenant public-pay link');
  assert.match(sql, /lower\(COALESCE\(sf\.mime_type, ''\)\) IN \('image\/jpeg','image\/png','image\/webp'\)/,
    'has_slip must only be true for previewable image types');
});

test('tenant slip preview route is ownership checked and inline image only', () => {
  const src = serverSource();
  const m = src.match(
    /app\.get\('\/api\/tenant\/payments\/:id\/slip'[\s\S]*?\n\}\);/
  );
  assert.ok(m, 'should define tenant slip preview endpoint');
  const route = m[0];
  assert.match(route, /p\.id=\$1 AND p\.tenant_id=\$2/,
    'route must scope payment lookup to current tenant');
  assert.match(route, /f\.category !== 'slip'/,
    'route must require slip file category');
  assert.match(route, /allowedUploaders = new Set/,
    'route must build an explicit allow-list of tenant-owned upload sources');
  assert.match(route, /public-pay:\$\{req\.tenant\.tenant_id\}/,
    'route must allow slips submitted through the tenant public-pay link');
  assert.match(route, /!allowedUploaders\.has\(f\.uploaded_by\)/,
    'route must reject uploads not owned by this tenant');
  assert.match(route, /\['image\/jpeg', 'image\/png', 'image\/webp'\]\.includes\(mime\)/,
    'route must only preview supported image MIME types');
  assert.match(route, /Content-Disposition', `inline;/,
    'preview route should render inline instead of attachment/download');
});

test('tenant payment history opens slip in modal, not window.open', () => {
  const src = tenantSource();
  const paymentsStart = src.indexOf('function PaymentsView');
  const contractStart = src.indexOf('// =========================================================== ContractView');
  assert.ok(paymentsStart > -1 && contractStart > paymentsStart, 'should locate PaymentsView block');
  const block = src.slice(paymentsStart, contractStart);
  assert.doesNotMatch(block, /window\.open/,
    'payment history must not open slips in a new tab');
  assert.match(block, /SlipPreviewModal/,
    'payment history should render the slip preview modal');
  assert.match(block, /\/api\/tenant\/payments\/\$\{encodeURIComponent\(payment\.id\)\}\/slip/,
    'modal must load the ownership-checked tenant slip preview endpoint');
});

test('tenant shell and modal layout are locked across desktop and mobile', () => {
  const jsx = tenantSource();
  const html = tenantHtml();
  assert.match(html, /html \{ overflow-y: scroll; scrollbar-gutter: stable; \}/,
    'desktop should always reserve scrollbar width to avoid horizontal jumps');
  assert.match(html, /\.anim-in \{ animation: fade-in \.14s ease both; \}/,
    'page transitions should fade without translating content');
  assert.match(jsx, /className="portal-shell"[\s\S]*?width: '100%'/,
    'portal shell must fill the root grid instead of shrink-wrapping each page');
  assert.match(jsx, /paddingRight: document\.body\.style\.paddingRight/,
    'modal scroll lock should preserve body paddingRight');
  assert.match(jsx, /document\.body\.style\.paddingRight = `\$\{scrollbarGap\}px`/,
    'modal scroll lock should compensate for the removed desktop scrollbar');
  assert.match(jsx, /\.modal-panel \{\s*width: 100vw !important;[\s\S]*?max-width: 100vw !important;/,
    'mobile bottom-sheet modal should use the full viewport width');
  assert.match(jsx, /overflow: state === 'ready' \? 'auto' : 'hidden'/,
    'slip preview should scroll after the image loads instead of clipping tall slips');
  assert.match(jsx, /className="slip-preview-image"[\s\S]*?maxHeight: 'none'/,
    'slip preview image should keep full height available inside the scrollable viewer');
  assert.match(jsx, /\.slip-preview \{[\s\S]*?height: clamp\(240px, 68dvh, 620px\) !important;/,
    'mobile slip preview should reserve a responsive viewer height');
});
