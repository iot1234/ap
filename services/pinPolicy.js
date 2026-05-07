// services/pinPolicy.js
// Trivial-PIN reject list, used by every code path that accepts a PIN
// (admin password rules, tenant portal PIN init / change). Single source of
// truth — server.js and routes/tenant-ops.js both import from here so the
// rules can't drift.

const TRIVIAL_PINS_4 = new Set([
  // Sequences and repeats are handled by the regex below; this list is for
  // "common memorable" 4-digit PINs (years, dates, simple patterns) that
  // don't match those regex shapes.
  '0000','1111','2222','3333','4444','5555','6666','7777','8888','9999',
  '1234','4321','2580','1010','1212','1313','1414','1515','1616',
  '1717','1818','1919','0123','0852','1004','1122','1342',
  '2002','2007','2008','2010','2011','2020','2021','2022','2023',
  '2024','2025','2026','2027','9876',
]);

function isTrivialPin(s) {
  const str = String(s || '');
  if (!/^\d{4,8}$/.test(str)) return false;
  if (str.length === 4 && TRIVIAL_PINS_4.has(str)) return true;
  if (/^(\d)\1+$/.test(str)) return true;                              // all same
  if (/^(0123|1234|2345|3456|4567|5678|6789|9876|8765|7654|6543|5432|4321)/.test(str)) return true;
  return false;
}

module.exports = { TRIVIAL_PINS_4, isTrivialPin };
