const cache = new Map();

export async function withCache(key, ttlMs, loader) {
  const cached = cache.get(key);
  const now = Date.now();

  if (cached?.value && cached.expiresAt > now) return cached.value;
  if (cached?.pending) return cached.pending;

  const pending = loader()
    .then((value) => {
      cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .catch((error) => {
      cache.delete(key);
      throw error;
    });

  cache.set(key, { pending, expiresAt: now + ttlMs });
  return pending;
}
