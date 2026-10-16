const cache = new Map();

// How long an unavailable or error-carrying answer is kept before trying
// again. The long TTLs (6-24 hours) are for good answers: a provider that
// timed out on the first request after a restart used to leave its panel
// "unavailable" for a day after the provider recovered.
export const DEGRADED_TTL_MS = 10 * 60_000;

/** An answer worth retrying soon: it could not compute, or it says a provider failed. */
export function isDegraded(value) {
  return value?.status === 'unavailable' || (Array.isArray(value?.errors) && value.errors.length > 0);
}

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
  const degradedTtl = Math.min(ttlMs, options.degradedTtlMs ?? DEGRADED_TTL_MS);
  const pending = loader()
    .then((value) => {
      const nextValue = previousValue !== undefined && options.merge ? options.merge(previousValue, value) : value;
      // A good answer is not replaced by an unavailable one: the last good
      // answer keeps being served - it carries its own dates - and the
      // computation is retried soon.
      if (nextValue?.status === 'unavailable' && previousValue !== undefined && previousValue?.status !== 'unavailable') {
        cache.set(key, { value: previousValue, expiresAt: Date.now() + degradedTtl });
        return previousValue;
      }
      cache.set(key, { value: nextValue, expiresAt: Date.now() + (isDegraded(nextValue) ? degradedTtl : ttlMs) });
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
