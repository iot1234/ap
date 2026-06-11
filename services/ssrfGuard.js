// services/ssrfGuard.js
// Centralised guard against Server-Side Request Forgery (SSRF) for any outbound
// HTTP target whose URL/host is operator-configurable (Slip2Go API URL, R2/S3
// endpoint, etc.). Without this an admin (or anyone who can write a secret) can
// point an outbound call at cloud metadata (169.254.169.254), loopback, or the
// platform's private network (*.railway.internal, 10/8 ...) and turn a tenant
// slip upload / a "test connection" click into a request to internal services
// -- leaking the bearer token and any response back out.
//
// Three layers:
//   assertSafeUrl(raw)          -- sync: require https, reject internal hostnames
//                                 and literal private/reserved IPs. Use at
//                                 config-write time and before client setup.
//   assertSafeUrlResolved(raw)  -- async: the above PLUS a DNS lookup so a public
//                                 hostname that resolves to an internal IP
//                                 (DNS-rebinding) is also rejected. Use right
//                                 before firing an outbound request on a path
//                                 that untrusted input can trigger.
//   safeLookup(host, opts, cb)  -- a `lookup` hook for http(s).request /
//                                 https.Agent that pins the connection to a
//                                 validated address, closing the resolve-then-
//                                 connect TOCTOU the two asserts can't cover.

const net = require('net');
const dns = require('dns').promises;
const dnsCb = require('dns');

function ipToLong(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function inCidr4(ip, base, bits) {
  const a = ipToLong(ip), b = ipToLong(base);
  if (a == null || b == null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

// Loopback, private, link-local (incl. cloud metadata 169.254.169.254),
// CGNAT, benchmark, broadcast, "this network".
function isBlockedIPv4(ip) {
  return inCidr4(ip, '0.0.0.0', 8)
    || inCidr4(ip, '10.0.0.0', 8)
    || inCidr4(ip, '100.64.0.0', 10)
    || inCidr4(ip, '127.0.0.0', 8)
    || inCidr4(ip, '169.254.0.0', 16)
    || inCidr4(ip, '172.16.0.0', 12)
    || inCidr4(ip, '192.0.0.0', 24)
    || inCidr4(ip, '192.168.0.0', 16)
    || inCidr4(ip, '198.18.0.0', 15)
    || inCidr4(ip, '255.255.255.255', 32);
}

// Expand an IPv6 literal into its 8 sixteen-bit groups (numbers). Handles
// `::` compression, a zone id (fe80::1%eth0), and a trailing embedded IPv4
// dotted-quad (::ffff:1.2.3.4). Returns null if it isn't a parseable IPv6.
function ipv6ToHextets(input) {
  let s = String(input || '').toLowerCase().trim();
  if (!s) return null;
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct);                          // drop zone id
  // Convert a trailing embedded IPv4 (::ffff:1.2.3.4) into two hex groups so
  // the rest of the parser only deals with hextets.
  const v4m = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4m) {
    const long = ipToLong(v4m[2]);
    if (long == null) return null;
    s = v4m[1] + ((long >>> 16) & 0xffff).toString(16) + ':' + (long & 0xffff).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;                           // at most one '::'
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups;
  if (tail === null) {
    groups = head;                                              // no '::' -- must be 8 groups
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = head.concat(new Array(missing).fill('0'), tail);
  }
  if (groups.length !== 8) return null;
  const out = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

// Extract the embedded IPv4 from the well-known IPv4-in-IPv6 prefixes:
//   - IPv4-mapped       ::ffff:0:0/96
//   - IPv4-compatible   ::0.0.0.0/96 (deprecated, but routers still honour it)
//   - NAT64             64:ff9b::/96
// Returns a dotted-quad string, or null when no IPv4 is embedded.
function embeddedIPv4(h) {
  if (!h) return null;
  const low32 = () => {
    const lng = (((h[6] & 0xffff) << 16) >>> 0) + (h[7] & 0xffff);
    return `${(lng >>> 24) & 0xff}.${(lng >>> 16) & 0xff}.${(lng >>> 8) & 0xff}.${lng & 0xff}`;
  };
  const hi6Zero = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0;
  if (hi6Zero && h[5] === 0xffff) return low32();                       // ::ffff:0:0/96
  if (hi6Zero && h[5] === 0 && (h[6] !== 0 || h[7] !== 0)) return low32(); // ::a.b.c.d
  if (h[0] === 0x64 && h[1] === 0xff9b
      && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) return low32(); // NAT64
  return null;
}

function isBlockedIPv6(ip) {
  const s = String(ip).toLowerCase();
  if (s === '::1' || s === '::') return true;                  // loopback / unspecified
  if (s.startsWith('fe8') || s.startsWith('fe9')
      || s.startsWith('fea') || s.startsWith('feb')) return true; // link-local fe80::/10
  if (s.startsWith('fc') || s.startsWith('fd')) return true;   // unique-local fc00::/7
  // IPv4-in-IPv6: the WHATWG URL parser normalises ::ffff:127.0.0.1 to the
  // compressed hex form ::ffff:7f00:1, so the old dotted-decimal regex never
  // matched and loopback/metadata/NAT64 targets slipped through. Expand the
  // address and re-check any embedded IPv4 against the v4 block list.
  const v4 = embeddedIPv4(ipv6ToHextets(s));
  if (v4) return isBlockedIPv4(v4);
  return false;
}

function isBlockedIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) return isBlockedIPv4(ip);
  if (v === 6) return isBlockedIPv6(ip);
  return true; // not a literal IP -- let hostname rules in assertSafeUrl decide
}

function assertSafeUrl(raw, { allowHttp = false } = {}) {
  let u;
  try { u = new URL(String(raw)); }
  catch { throw new Error('invalid URL'); }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) {
    throw new Error('URL must use https');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase(); // strip IPv6 [ ]
  if (!host) throw new Error('URL has no host');
  if (host === 'localhost'
      || host.endsWith('.localhost')
      || host.endsWith('.local')
      || host.endsWith('.internal')) {
    throw new Error('URL points to an internal/reserved host');
  }
  if (net.isIP(host) && isBlockedIp(host)) {
    throw new Error('URL points to a private/reserved IP address');
  }
  return u;
}

async function assertSafeUrlResolved(raw, opts) {
  const u = assertSafeUrl(raw, opts);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!net.isIP(host)) {
    let addrs;
    try { addrs = await dns.lookup(host, { all: true }); }
    catch { throw new Error('could not resolve outbound host'); }
    for (const a of addrs) {
      if (isBlockedIp(a.address)) {
        throw new Error('outbound host resolves to a private/reserved IP address');
      }
    }
  }
  return u;
}

// A drop-in `lookup` for http(s).request / https.Agent options. It resolves the
// host and only ever hands the socket an address that passes the SSRF block
// list. Because the address the socket connects to is the SAME one we just
// validated (not a second, independent OS resolution), this closes the
// DNS-rebinding TOCTOU window that an assert-then-connect sequence leaves open.
// Use this on every outbound request whose host is operator/tenant-influenced
// (Slip2Go verify, R2/S3 endpoint).
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const opts = options || {};
  // Literal IP: no DNS to do -- validate the literal directly.
  if (net.isIP(hostname)) {
    const fam = net.isIP(hostname);
    if (isBlockedIp(hostname)) {
      return process.nextTick(callback, new Error('outbound host is a private/reserved IP address'));
    }
    return process.nextTick(
      callback, null,
      opts.all ? [{ address: hostname, family: fam }] : hostname,
      fam
    );
  }
  dnsCb.lookup(hostname, { all: true, verbatim: opts.verbatim !== false }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [addresses];
    const safe = list.filter((a) => a && a.address && !isBlockedIp(a.address));
    if (!safe.length) {
      return callback(new Error('outbound host resolves to a private/reserved IP address'));
    }
    if (opts.all) return callback(null, safe);
    return callback(null, safe[0].address, safe[0].family);
  });
}

module.exports = { assertSafeUrl, assertSafeUrlResolved, isBlockedIp, safeLookup };
