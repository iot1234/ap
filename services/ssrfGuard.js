// services/ssrfGuard.js
// Centralised guard against Server-Side Request Forgery (SSRF) for any outbound
// HTTP target whose URL/host is operator-configurable (Slip2Go API URL, R2/S3
// endpoint, etc.). Without this an admin (or anyone who can write a secret) can
// point an outbound call at cloud metadata (169.254.169.254), loopback, or the
// platform's private network (*.railway.internal, 10/8 …) and turn a tenant
// slip upload / a "test connection" click into a request to internal services
// — leaking the bearer token and any response back out.
//
// Two layers:
//   assertSafeUrl(raw)          — sync: require https, reject internal hostnames
//                                 and literal private/reserved IPs. Use at
//                                 config-write time and before client setup.
//   assertSafeUrlResolved(raw)  — async: the above PLUS a DNS lookup so a public
//                                 hostname that resolves to an internal IP
//                                 (DNS-rebinding) is also rejected. Use right
//                                 before firing an outbound request on a path
//                                 that untrusted input can trigger.

const net = require('net');
const dns = require('dns').promises;

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

function isBlockedIPv6(ip) {
  const s = String(ip).toLowerCase();
  if (s === '::1' || s === '::') return true;                  // loopback / unspecified
  if (s.startsWith('fe8') || s.startsWith('fe9')
      || s.startsWith('fea') || s.startsWith('feb')) return true; // link-local fe80::/10
  if (s.startsWith('fc') || s.startsWith('fd')) return true;   // unique-local fc00::/7
  const m = s.match(/(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/);       // IPv4-mapped
  if (m) return isBlockedIPv4(m[1]);
  return false;
}

function isBlockedIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) return isBlockedIPv4(ip);
  if (v === 6) return isBlockedIPv6(ip);
  return true; // not a literal IP — let hostname rules in assertSafeUrl decide
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

module.exports = { assertSafeUrl, assertSafeUrlResolved, isBlockedIp };
