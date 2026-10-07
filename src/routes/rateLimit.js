import crypto from 'node:crypto';

// In-memory limiter. Client addresses are hashed with a per-process random salt and never written
// to disk or logs, so they cannot be tied back to a report.
const SALT = crypto.randomBytes(16);

export function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();

  return (req, res, next) => {
    const key = crypto.createHmac('sha256', SALT).update(String(req.socket.remoteAddress)).digest('hex');
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) return res.status(429).json({ error: message });
    next();
  };
}
