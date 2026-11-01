/**
 * EcoWing Ingestion Rate Limiter Middleware (E7)
 * Implements an in-memory sliding window rate limiter per client/drone.
 */

function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || parseInt(process.env.INGESTION_RATE_LIMIT_WINDOW_MS || '60000', 10);
  const max = options.max || parseInt(process.env.INGESTION_RATE_LIMIT_MAX || '180', 10);
  const message = options.message || 'Ingestion rate limit exceeded. Please slow down.';

  const keyGenerator = options.keyGenerator || ((req) => {
    return req.authenticated_drone_id || (req.body && req.body.drone_id) || req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
  });

  const hits = new Map(); // key -> Array of timestamps

  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of hits.entries()) {
      const valid = timestamps.filter(ts => now - ts < windowMs);
      if (valid.length === 0) {
        hits.delete(key);
      } else {
        hits.set(key, valid);
      }
    }
  }, Math.max(windowMs, 5000));
  if (cleanupInterval.unref) cleanupInterval.unref();

  const middleware = (req, res, next) => {
    const key = keyGenerator(req);
    const now = Date.now();
    let timestamps = hits.get(key) || [];
    timestamps = timestamps.filter(ts => now - ts < windowMs);

    if (timestamps.length >= max) {
      const oldest = timestamps[0];
      const resetSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      res.setHeader('Retry-After', resetSeconds);
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', 0);
      return res.status(429).json({
        status: 'error',
        error: 'Too Many Requests',
        message: message,
        retry_after_seconds: resetSeconds
      });
    }

    timestamps.push(now);
    hits.set(key, timestamps);

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - timestamps.length));
    next();
  };

  middleware.reset = () => hits.clear();
  middleware.getHits = (key) => hits.get(key) || [];
  middleware.cleanup = () => clearInterval(cleanupInterval);
  middleware.max = max;
  middleware.windowMs = windowMs;

  return middleware;
}

const ingestionRateLimiter = createRateLimiter({
  windowMs: parseInt(process.env.INGESTION_RATE_LIMIT_WINDOW_MS || '60000', 10),
  max: parseInt(process.env.INGESTION_RATE_LIMIT_MAX || '180', 10),
  message: 'Ingestion rate limit exceeded. Reduce telemetry and frame upload frequency.'
});

module.exports = {
  createRateLimiter,
  ingestionRateLimiter
};
