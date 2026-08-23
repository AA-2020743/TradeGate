const KEYLESS_MODES = ['keyless', 'public', 'app-token', 'credentialed'];

/** A provider serving data without a key is working, not degraded. */
function providerIsServing(provider) {
  const mode = String(provider?.mode ?? '').toLowerCase();
  if (!mode || mode === 'not-configured' || mode === 'unavailable') return false;
  return KEYLESS_MODES.some((candidate) => mode.includes(candidate));
}

/**
 * Why a provider cannot serve, or null when it can. Absence of an optional key
 * is only a problem where the provider has no keyless path: FRED reads its
 * public CSV endpoint without one and is fully functional, so counting it as
 * unconfigured — which the previous check did for every provider lacking a key
 * — made the platform permanently "partial" and the warning meaningless.
 */
export function providerDegradation(name, provider) {
  if (!provider) return null;
  if (provider.configured === true && provider.connected === false) return `${name} is configured but not reachable`;
  if (provider.configured === true && provider.migrated === false) return `${name} is connected but not migrated`;
  if (providerIsServing(provider)) return null;
  if (provider.configured === false || String(provider.mode ?? '').toLowerCase() === 'not-configured') return `${name} needs a key before it can serve`;
  return null;
}

/**
 * The platform's coverage state, and specifically what is missing. "Partial"
 * without naming anything is a warning nobody can act on.
 */
export function derivePlatformStatus({ health = null, markets = null, liquidity = null, failedRequests = [], blockedSources = [] } = {}) {
  if (!health) {
    return { status: 'offline', degraded: [], reasons: [], blocked: [], error: 'The data API is unavailable.' };
  }
  const reasons = [];
  const degraded = [];
  for (const [name, provider] of Object.entries(health.providers ?? {})) {
    const reason = providerDegradation(name, provider);
    if (reason) {
      degraded.push(name);
      reasons.push(reason);
    }
  }
  const providerErrors = [...(markets?.errors ?? []), ...(liquidity?.errors ?? [])];
  const blocked = (blockedSources ?? []).map((entry) => entry?.source).filter(Boolean);
  const hasQuotes = Boolean(markets?.assets?.length);
  const healthy = hasQuotes && !degraded.length && !providerErrors.length && !failedRequests.length;

  const summary = [
    failedRequests.length ? `${failedRequests.length} core request${failedRequests.length === 1 ? '' : 's'} failed` : null,
    !hasQuotes ? 'no live quotes returned' : null,
    reasons.length ? reasons.join('; ') : null,
    providerErrors.length ? `${providerErrors.length} provider error${providerErrors.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean);

  return {
    status: healthy ? 'live' : 'partial',
    degraded,
    reasons,
    blocked,
    providerErrorCount: providerErrors.length,
    error: healthy ? null : `${summary.join(' · ')}.`,
  };
}
