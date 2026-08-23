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
 * Posts the selected transitions, retrying transport failures and 5xx with
 * exponential backoff. Never throws: a webhook that is down must not take an
 * ingestion run with it, so the failure is returned for the run's own details
 * rather than propagated. A 4xx is not retried — the receiver is saying the
 * request is wrong, and repeating it will not make it right.
 */
export async function deliverAlerts(alerts, {
  url = '',
  severities = DEFAULT_SEVERITIES,
  fetchImplementation = fetch,
  timeoutMs = 5_000,
  attempts = 3,
  backoffMs = 500,
  wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  now = () => new Date().toISOString(),
} = {}) {
  if (!url) return { status: 'disabled', reason: 'No alert webhook is configured.', delivered: 0 };
  if (!isDeliverableUrl(url)) {
    return { status: 'unavailable', reason: 'The alert webhook URL must be an absolute https URL.', delivered: 0 };
  }
  const entries = selectDeliverableAlerts(alerts, { severities });
  if (!entries.length) return { status: 'quiet', reason: 'No transition matched the delivery severities.', delivered: 0 };

  const body = JSON.stringify({
    source: 'tradegate',
    asOf: now(),
    // The full set is included so a receiver can render context without a
    // second call, but only the transitions above are counted as delivered.
    transitions: entries.map((entry) => ({ key: entry.key, severity: entry.severity, transition: entry.transition, text: entry.text })),
    liveCount: alerts?.entries?.length ?? 0,
  });

  // A 4xx is the receiver telling us the request is wrong; repeating it will
  // not make it right, so only transport failures and 5xx are retried.
  const worthRetrying = (status) => !Number.isFinite(status) || status >= 500 || status === 429;
  let lastReason = null;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImplementation(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body,
      });
      if (response?.ok) {
        return { status: 'delivered', delivered: entries.length, keys: entries.map((entry) => entry.key), attempts: attempt };
      }
      lastReason = `The webhook responded ${response?.status ?? 'with no status'}.`;
      if (!worthRetrying(response?.status)) {
        return { status: 'failed', reason: lastReason, delivered: 0, attempted: entries.length, attempts: attempt, retryable: false };
      }
    } catch (error) {
      lastReason = error.name === 'AbortError' ? `The webhook did not respond within ${timeoutMs}ms.` : error.message;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < Math.max(1, attempts)) await wait(backoffMs * (2 ** (attempt - 1)));
  }
  return { status: 'failed', reason: lastReason, delivered: 0, attempted: entries.length, attempts: Math.max(1, attempts), retryable: true };
}

/**
 * Transitions that were selected for delivery but never got there.
 *
 * A webhook down for an entire run used to lose those transitions permanently:
 * they are raised once by construction, so the next run has nothing to send.
 * Holding the undelivered ones and prepending them to the next attempt closes
 * that, and each carries the run it was first raised in so a receiver can see
 * it is catching up rather than being told something happened just now.
 */
export function pendingAfterDelivery(alerts, result, { previousPending = [], severities = DEFAULT_SEVERITIES, maxPending = 50, runAt = new Date().toISOString() } = {}) {
  const attempted = selectDeliverableAlerts(alerts, { severities });
  if (result?.status === 'delivered' || result?.status === 'disabled') return [];
  // A 4xx will not succeed on a retry either, so holding it forever would grow
  // a queue that can never drain.
  if (result?.retryable === false) return previousPending;
  const carried = [
    ...previousPending,
    ...attempted.map((entry) => ({ ...entry, firstAttemptedAt: entry.firstAttemptedAt ?? runAt })),
  ];
  // Newest kept when the queue is over its ceiling: an alert from three weeks
  // ago is history, not news, and delivering it would be worse than dropping it.
  const deduped = [...new Map(carried.map((entry) => [`${entry.key}:${entry.transition}`, entry])).values()];
  return deduped.slice(-maxPending);
}

/** Prepends anything still owed before sending this run's own transitions. */
export function withPending(alerts, pending = []) {
  if (!pending.length) return alerts;
  const keys = new Set((alerts?.raised ?? []).map((entry) => `${entry.key}:raised`));
  const resolvedKeys = new Set((alerts?.resolved ?? []).map((entry) => `${entry.key}:cleared`));
  const owedRaised = pending.filter((entry) => entry.transition === 'raised' && !keys.has(`${entry.key}:raised`));
  const owedResolved = pending.filter((entry) => entry.transition === 'cleared' && !resolvedKeys.has(`${entry.key}:cleared`));
  return {
    ...alerts,
    raised: [...owedRaised, ...(alerts?.raised ?? [])],
    resolved: [...owedResolved, ...(alerts?.resolved ?? [])],
    replayed: owedRaised.length + owedResolved.length,
  };
}
