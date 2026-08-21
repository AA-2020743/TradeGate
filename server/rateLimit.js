/**
 * Fixed-window per-client limiter. Counters live in memory, so the window is
 * per process: behind more than one Node instance each replica enforces its own
 * share rather than a shared ceiling.
 */
export function createRateLimiter({ limit, windowMs, now = () => Date.now() } = {}) {
  const ceiling = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 120;
  const window = Number.isFinite(windowMs) && windowMs > 0 ? Math.floor(windowMs) : 60_000;
  const counters = new Map();

  const sweep = () => {
    const currentTime = now();
    for (const [key, entry] of counters) {
      if (entry.resetAt <= currentTime) counters.delete(key);
    }
  };

  const middleware = (request, response, next) => {
    const currentTime = now();
    const key = request.ip ?? 'unknown';
    const current = counters.get(key);
    const entry = !current || current.resetAt <= currentTime
      ? { count: 0, resetAt: currentTime + window }
      : current;
    entry.count += 1;
    counters.set(key, entry);
    response.setHeader('RateLimit-Limit', String(ceiling));
    response.setHeader('RateLimit-Remaining', String(Math.max(0, ceiling - entry.count)));
    response.setHeader('RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > ceiling) {
      response.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - currentTime) / 1000))));
      response.status(429).json({ error: 'API rate limit exceeded. Try again shortly.' });
      return;
    }
    next();
  };

  const cleanup = setInterval(sweep, window);
  cleanup.unref?.();

  return {
    limit: ceiling,
    windowMs: window,
    middleware,
    trackedClients: () => counters.size,
    stop: () => clearInterval(cleanup),
  };
}
