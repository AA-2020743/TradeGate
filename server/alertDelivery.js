/**
 * Delivers high-severity alert transitions to a webhook.
 *
 * Opt-in and off by default: the URL comes from configuration and nothing is
 * sent without one. Only transitions are delivered, never the standing set — a
 * still-live condition is not news, and a webhook that repeats it every run is
 * the fastest way to make an alert channel ignored.
 */

const DEFAULT_SEVERITIES = ['high'];

function isDeliverableUrl(value) {
  try {
    const url = new URL(value);
    // Plain HTTP would put alert contents on the wire in clear text, and a
    // non-HTTP scheme is not something to hand to a fetch implementation.
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function selectDeliverableAlerts(alerts, { severities = DEFAULT_SEVERITIES, includeResolved = true } = {}) {
  const raised = (alerts?.raised ?? []).filter((entry) => severities.includes(entry.severity));
  const resolved = includeResolved
    ? (alerts?.resolved ?? []).filter((entry) => severities.includes(entry.severity))
    : [];
  return [
    ...raised.map((entry) => ({ ...entry, transition: 'raised' })),
    ...resolved.map((entry) => ({ ...entry, transition: 'cleared' })),
  ];
}

/**
 * Posts the selected transitions. Never throws: a webhook that is down must not
 * take an ingestion run with it, so the failure is returned for the run's own
 * details rather than propagated.
 */
export async function deliverAlerts(alerts, {
  url = '',
  severities = DEFAULT_SEVERITIES,
  fetchImplementation = fetch,
  timeoutMs = 5_000,
  now = () => new Date().toISOString(),
} = {}) {
  if (!url) return { status: 'disabled', reason: 'No alert webhook is configured.', delivered: 0 };
  if (!isDeliverableUrl(url)) {
    return { status: 'unavailable', reason: 'The alert webhook URL must be an absolute https URL.', delivered: 0 };
  }
  const entries = selectDeliverableAlerts(alerts, { severities });
  if (!entries.length) return { status: 'quiet', reason: 'No transition matched the delivery severities.', delivered: 0 };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImplementation(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        source: 'tradegate',
        asOf: now(),
        // The full set is included so a receiver can render context without a
        // second call, but only the transitions above are counted as delivered.
        transitions: entries.map((entry) => ({ key: entry.key, severity: entry.severity, transition: entry.transition, text: entry.text })),
        liveCount: alerts?.entries?.length ?? 0,
      }),
    });
    if (!response?.ok) {
      return { status: 'failed', reason: `The webhook responded ${response?.status ?? 'with no status'}.`, delivered: 0, attempted: entries.length };
    }
    return { status: 'delivered', delivered: entries.length, keys: entries.map((entry) => entry.key) };
  } catch (error) {
    return {
      status: 'failed',
      reason: error.name === 'AbortError' ? `The webhook did not respond within ${timeoutMs}ms.` : error.message,
      delivered: 0,
      attempted: entries.length,
    };
  } finally {
    clearTimeout(timer);
  }
}
