// middleware/rateLimit.js
// Generic IP-based limiter factory. Each instance keeps its own Map so two
// limiters can have different policies. Sweep cleanup runs probabilistically
// every ~5 minutes so a flood of unique IPs cannot grow the Map without bound.

function clientIp(req) {
  if (req.ip) return req.ip;
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff.split(',')[0].trim();
  return null;
}

function makeIpLimiter({ windowMs, max, message = 'too many requests' } = {}) {
  const hits = new Map();
  let lastSweep = Date.now();
  return function limiter(req, res, next) {
    const ip = clientIp(req) || 'unknown';
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    // Set rate limit headers (best-effort; matches express-rate-limit shape).
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - arr.length - 1));
    if (arr.length >= max) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: message, code: 'RATE_LIMIT' });
    }
    arr.push(now);
    hits.set(ip, arr);
    if (now - lastSweep > 5 * 60_000) {
      lastSweep = now;
      for (const [k, v] of hits) {
        if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
      }
    }
    next();
  };
}

/**
 * Add a small random latency (200–500ms by default) to a response. Used on
 * username/phone enumeration paths so timing attacks can't reliably tell
 * "exists" from "doesn't exist".
 */
function jitter(req, res, next) {
  const ms = 200 + Math.floor(Math.random() * 300);
  setTimeout(next, ms);
}

module.exports = { makeIpLimiter, clientIp, jitter };
