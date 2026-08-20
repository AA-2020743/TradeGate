const cache = new Map();

export async function withCache(key, ttlMs, loader, options = {}) {
  const cached = cache.get(key);
  const now = Date.now();

  if (cached?.pending) {
    if (options.force && !cached.forced) {
      return cached.pending.catch(() => undefined).then(() => withCache(key, ttlMs, loader, options));
    }
    return !options.force && cached.value !== undefined ? cached.value : cached.pending;
  }
  if (!options.force && cached?.value !== undefined && cached.expiresAt > now) return cached.value;

  const previousValue = cached?.value;
  const previousExpiry = cached?.expiresAt;
  const pending = loader()
    .then((value) => {
      const nextValue = previousValue !== undefined && options.merge ? options.merge(previousValue, value) : value;
      cache.set(key, { value: nextValue, expiresAt: Date.now() + ttlMs });
      return nextValue;
    })
    .catch((error) => {
      if (previousValue !== undefined) cache.set(key, { value: previousValue, expiresAt: previousExpiry ?? now });
      else cache.delete(key);
      throw error;
    });

  cache.set(key, { pending, forced: options.force === true, value: previousValue, expiresAt: previousExpiry ?? now + ttlMs });
  return pending;
}
