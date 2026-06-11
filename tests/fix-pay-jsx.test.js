const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'project', 'pay.jsx'),
  'utf8',
);

// Regression guard for the public-pay AMOUNT_MISMATCH trap: the amount
// field was readOnly and load() force-synced it to the CURRENT bill total
// on mount and every 15s, so a tenant who transferred the principal before
// scheduler.tickLateFee bumped bills.total could only ever POST the new
// (higher) total — a guaranteed hard rejection from the slip verifier and
// an unreachable tier='principal' (services/billing.js validatePaymentAmount,
// server.js R2-followup comments around the expected.amount wiring).

test('public pay amount field is editable so the slip-actual amount can be submitted', () => {
  assert.doesNotMatch(src, /value=\{amount\}\s+readOnly/,
    'amount input must not be readOnly — the principal tier is unreachable otherwise');
  assert.match(src, /amountEditedRef\.current = true;\s*\n\s*setAmount\(e\.target\.value\);/,
    'editing the amount must record the edit and update state');
  assert.match(src, /const \{ useEffect, useMemo, useRef, useState \} = React;/,
    'useRef must be pulled from the React global for the edited flag');
  assert.match(src, /const amountEditedRef = useRef\(false\);/,
    'edited flag must be a ref so the 15s interval closure sees it');
});

test('refresh keeps pre-filling the bill total only while the tenant has not edited', () => {
  assert.match(src,
    /if \(next\.bill && !amountEditedRef\.current\) setAmount\(String\(next\.bill\.total \|\| ''\)\);/,
    'load() must gate the bill-total sync on the edited flag');
  assert.doesNotMatch(src, /if \(next\.bill\) setAmount\(/,
    'the unconditional 15s re-sync that clobbered tenant input must be gone');
});

test('upload still POSTs the tenant-entered amount and guides on invalid input', () => {
  assert.match(src, /body: JSON\.stringify\(\{ amount: n, slip \}\)/,
    'POST body must carry the tenant-entered amount, not bill total');
  assert.match(src, /จำนวนเงินไม่ถูกต้อง กรุณาระบุยอดที่โอนจริงตามสลิป/,
    'invalid-amount message should tell the tenant to enter the transferred amount');
  assert.match(src, /ให้แก้เป็นยอดที่โอนจริงตามสลิป/,
    'hint under the amount field should explain when to override the pre-fill');
});
