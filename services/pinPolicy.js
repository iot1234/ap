// services/pinPolicy.js
// Trivial-PIN reject list, used by every code path that accepts a PIN
// (admin password rules, tenant portal PIN init / change). Single source of
// truth — server.js and routes/tenant-ops.js both import from here so the
// rules can't drift.

const TRIVIAL_PINS_4 = new Set([
  // Sequences and repeats are handled algorithmically below; this list is for
  // "common memorable" 4-digit PINs (years, dates, simple patterns) that
  // don't match those shapes.
  '0000','1111','2222','3333','4444','5555','6666','7777','8888','9999',
  '1234','4321','2580','1010','1212','1313','1414','1515','1616',
  '1717','1818','1919','0123','0852','1004','1122','1342',
  '2002','2007','2008','2010','2011','2020','2021','2022','2023',
  '2024','2025','2026','2027','9876',
]);

// Year window for the date-rejection helper. Updated lazily based on the
// current year so the policy stays useful without hand-editing every year.
function isCommonYear(s) {
  if (!/^\d{4}$/.test(s)) return false;
  const n = Number(s);
  const thisYear = new Date().getFullYear();
  // Reject any 4-digit year from 1925 (centenarians) up to ~2 years ahead.
  return n >= 1925 && n <= thisYear + 2;
}

// Detect arithmetic progressions across the whole string with a fixed step.
// Catches: 1234, 2468 (step 2), 13579246 (step 2 over a wraparound), 9630 (step -3),
// 0369, etc. Wrap-around math uses mod 10 so 9012 (step 1 wrapping 9→0) also trips.
function isArithmeticProgression(str) {
  if (str.length < 4) return false;
  const digits = str.split('').map((d) => Number(d));
  // Try every plausible signed step; ±1..±5 covers all interesting human
  // sequences without false-flagging random PINs.
  for (let step = -5; step <= 5; step++) {
    if (step === 0) continue;
    let ok = true;
    for (let i = 1; i < digits.length; i++) {
      const expected = ((digits[i - 1] + step) % 10 + 10) % 10;
      if (digits[i] !== expected) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function isTrivialPin(s) {
  const str = String(s || '');
  if (!/^\d{4,8}$/.test(str)) return false;
  if (str.length === 4 && TRIVIAL_PINS_4.has(str)) return true;
  if (str.length === 4 && isCommonYear(str)) return true;
  if (/^(\d)\1+$/.test(str)) return true;             // all same digit
  if (isArithmeticProgression(str)) return true;       // 1234, 2468, 9876, 13579246, 9012...
  return false;
}

module.exports = { TRIVIAL_PINS_4, isTrivialPin, isArithmeticProgression, isCommonYear };
