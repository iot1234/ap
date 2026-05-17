const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const serverSource = () => fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const tenantSource = () => fs.readFileSync(path.join(__dirname, '..', 'project', 'tenant.jsx'), 'utf8');
const tenantHtml = () => fs.readFileSync(path.join(__dirname, '..', 'project', 'tenant.html'), 'utf8');

test('tenant payments list does not return raw slip_url', () => {
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
  assert.match(route, /f\.uploaded_by !== tenantUploader/,
    'route must require same tenant uploader');
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
  assert.match(jsx, /\.slip-preview \{[\s\S]*?height: clamp\(220px, 62dvh, 560px\) !important;/,
    'slip preview should have a responsive bounded viewport height');
});
