const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(...parts) {
  return fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
}

test('embedded admin pages keep stable shells while inputs update', () => {
  const files = [
    'page-access-devices.jsx',
    'page-booking-deposit-settings.jsx',
    'page-features.jsx',
    'page-pricing.jsx',
    'page-reports-v2.jsx',
    'page-secrets.jsx',
  ];
  for (const file of files) {
    const src = read('project', 'admin', file);
    assert.doesNotMatch(src, /const Wrapper = embedded/, `${file} must not create Wrapper inside render`);
    assert.doesNotMatch(src, /const Header = embedded/, `${file} must not create Header inside render`);
    assert.doesNotMatch(src, /<Wrapper[\s>]/, `${file} must not render an inline Wrapper component`);
    assert.doesNotMatch(src, /<Header[\s>]/, `${file} must not render an inline Header component`);
    assert.match(src, /return embedded \? <div>\{content\}<\/div> : <PageContainer>\{content\}<\/PageContainer>/);
  }
});

test('slip verification key inputs are not wrapped by a render-local step component', () => {
  const src = read('project', 'admin', 'page-slip-verify.jsx');
  assert.match(src, /function SlipVerifyStepHeader\(\{ n, done, title, hint, children, C \}\)/);
  assert.doesNotMatch(src, /function StepHeader\(/);
  assert.doesNotMatch(src, /React\.createElement\(StepHeader/);
  assert.match(src, /React\.createElement\(SlipVerifyStepHeader, \{\s*C,\s*n: 4/);
});
