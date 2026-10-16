import { useEffect, useState } from 'react';
import { createPoller } from './polling.js';
import { derivePlatformStatus } from './platformStatus.js';

async function requestJson(path) {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    // The server says why in its error body ("Unsupported history symbol",
    // "At most 50 symbols"); a bare status code left panels unable to tell a
    // ticker it does not track from an outage.
    let detail = '';
    try {
      const body = await response.json();
      detail = typeof body?.error === 'string' ? body.error : '';
    } catch {
      detail = '';
    }
    const error = new Error(detail ? `Request failed with ${response.status}: ${detail}` : `Request failed with ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

const PLATFORM_REQUESTS = [
  ['health', '/api/health'],
  ['markets', '/api/markets/snapshot'],
  ['liquidity', '/api/macro/liquidity'],
  ['dxyBtc', '/api/analytics/dxy-btc'],
  ['regimeCorrelations', '/api/analytics/regime-correlations'],
  ['positioning', '/api/analytics/positioning'],
  ['heatmap', '/api/analytics/heatmap'],
  ['metals', '/api/analytics/metals'],
  ['fx', '/api/analytics/fx'],
  ['hardMoney', '/api/analytics/hard-money'],
  ['accumulation', '/api/analytics/accumulation'],
  ['cryptoOptions', '/api/analytics/crypto-options'],
  ['treasury', '/api/macro/treasury'],
  ['factors', '/api/analytics/factors'],
  ['signalRecords', '/api/analytics/signal-records'],
  ['crossCheck', '/api/analytics/price-crosscheck'],
  ['models', '/api/models'],
  ['sentiment', '/api/analytics/sentiment'],
  ['bitcoin', '/api/analytics/bitcoin'],
  ['equityRisk', '/api/analytics/equity-risk'],
  ['news', '/api/news/wire'],
  ['screener', '/api/analytics/screener'],
  ['alerts', '/api/alerts'],
  ['indexValuation', '/api/analytics/index-valuation'],
];
const PLATFORM_CORE_KEYS = ['health', 'markets', 'liquidity', 'dxyBtc'];

/**
 * Runs a batch of requests and hands each answer over as it arrives.
 *
 * The page used to wait for every request in its batch before drawing any
 * of them, so on a cold server the Overview sat empty until the screener's
 * five-hundred-symbol read and the valuation workbook had finished, though
 * it shows neither. Answers arriving close together are delivered in one
 * update; the derived state (the platform status) is computed as soon as the
 * core requests have settled; and the promise still resolves only when all
 * have, so a poller never starts one batch on top of another. A failed
 * request delivers null, as the all-at-once version did.
 */
export async function loadProgressively({ requests, coreKeys = [], request = requestJson, onUpdate, derive = () => ({}), flushMs = 60, isActive = () => true }) {
  const pending = {};
  let timer = null;
  const flush = () => {
    timer = null;
    const keys = Object.keys(pending);
    if (!keys.length || !isActive()) return;
    const update = {};
    for (const key of keys) {
      update[key] = pending[key];
      delete pending[key];
    }
    onUpdate(update);
  };
  const queue = (key, value) => {
    pending[key] = value;
    if (timer === null) timer = setTimeout(flush, flushMs);
  };
  const keys = requests.map(([key]) => key);
  const settled = requests.map(([key, path]) => Promise.resolve()
    .then(() => request(path))
    .then(
      (value) => { queue(key, value); return { status: 'fulfilled', value }; },
      (reason) => { queue(key, null); return { status: 'rejected', reason }; },
    ));
  const core = await Promise.all(coreKeys.map((key) => settled[keys.indexOf(key)]));
  if (isActive()) {
    for (const [key, value] of Object.entries(derive(Object.fromEntries(coreKeys.map((key, index) => [key, core[index]]))))) queue(key, value);
  }
  const all = await Promise.all(settled);
  if (timer !== null) {
    clearTimeout(timer);
    flush();
  }
  return all;
}

export function usePlatformData() {
  const [state, setState] = useState({
    status: 'loading',
    platform: null,
    health: null,
    markets: null,
    liquidity: null,
    dxyBtc: null,
    regimeCorrelations: null,
    positioning: null,
    heatmap: null,
    metals: null,
    fx: null,
    sentiment: null,
    bitcoin: null,
    equityRisk: null,
    hardMoney: null,
    accumulation: null,
    cryptoOptions: null,
    treasury: null,
    factors: null,
    signalRecords: null,
    indexValuation: null,
    crossCheck: null,
    models: null,
    news: null,
    screener: null,
    alerts: null,
    error: null,
  });

  useEffect(() => {
    let active = true;

    const load = () => loadProgressively({
      requests: PLATFORM_REQUESTS,
      coreKeys: PLATFORM_CORE_KEYS,
      isActive: () => active,
      onUpdate: (update) => setState((current) => ({ ...current, ...update })),
      derive: (core) => {
        const valueOf = (result) => (result.status === 'fulfilled' ? result.value : null);
        const platform = derivePlatformStatus({
          health: valueOf(core.health),
          markets: valueOf(core.markets),
          liquidity: valueOf(core.liquidity),
          failedRequests: PLATFORM_CORE_KEYS.filter((key) => core[key].status === 'rejected'),
          blockedSources: valueOf(core.health)?.blockedSources ?? [],
        });
        return { status: platform.status, platform, error: platform.error };
      },
    });

    const poller = createPoller({ load, intervalMs: 60_000 });
    poller.start();
    return () => {
      active = false;
      poller.stop();
    };
  }, []);

  return state;
}

export function useMarketHistory(symbol, range) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });

  useEffect(() => {
    let active = true;
    setState({ status: 'loading', data: null, error: null });

    requestJson(`/api/markets/history/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}`)
      .then((data) => {
        if (active) setState({ status: data.points?.length ? data.stale ? 'stale' : 'live' : 'unavailable', data, error: null });
      })
      .catch((error) => {
        if (active) setState({ status: 'unavailable', data: null, error: error.message });
      });

    return () => {
      active = false;
    };
  }, [range, symbol]);

  return state;
}

/**
 * A resource fetched when the panel that shows it mounts, not with the page
 * batch. The batch waits for every request before drawing anything, so a
 * slow first computation - a five-year replay of the screener, sixty alert
 * histories - held every page on a cold server.
 */
export function useLazyResource(path) {
  const [state, setState] = useState({ status: path ? 'loading' : 'idle', data: null, error: null });
  useEffect(() => {
    // No path means nothing to load yet, such as an empty watchlist.
    if (!path) {
      setState({ status: 'idle', data: null, error: null });
      return undefined;
    }
    let active = true;
    setState({ status: 'loading', data: null, error: null });
    requestJson(path)
      .then((data) => { if (active) setState({ status: 'loaded', data, error: null }); })
      .catch((error) => { if (active) setState({ status: 'unavailable', data: null, error: error.message }); });
    return () => {
      active = false;
    };
  }, [path]);
  return state;
}

export function useTechnicalAnalytics(symbol) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });

  useEffect(() => {
    let active = true;
    setState({ status: 'loading', data: null, error: null });
    requestJson(`/api/analytics/technical/${encodeURIComponent(symbol)}`)
      .then((data) => {
        if (active) setState({ status: data.model ? data.stale ? 'stale' : 'live' : 'unavailable', data, error: null });
      })
      .catch((error) => {
        if (active) setState({ status: 'unavailable', data: null, error: error.message });
      });

    return () => {
      active = false;
    };
  }, [symbol]);

  return state;
}

export function useEquityResearch(symbol) {
  const [state, setState] = useState({ status: 'loading', catalog: null, dashboard: null, sectors: null, error: null });

  useEffect(() => {
    let active = true;
    const load = async () => {
      setState((current) => ({ ...current, status: 'loading', dashboard: null, error: null }));
      const [catalog, dashboard, sectors] = await Promise.allSettled([
        requestJson('/api/equities/catalog'),
        requestJson(`/api/equities/dashboard/${encodeURIComponent(symbol)}`),
        requestJson('/api/equities/sectors'),
      ]);
      if (!active) return;
      const failed = [catalog, dashboard, sectors].filter((result) => result.status === 'rejected');
      setState({
        status: failed.length ? failed.length === 3 ? 'unavailable' : 'partial' : 'live',
        catalog: catalog.status === 'fulfilled' ? catalog.value : null,
        dashboard: dashboard.status === 'fulfilled' ? dashboard.value : null,
        sectors: sectors.status === 'fulfilled' ? sectors.value : null,
        error: failed.length ? failed.map((result) => result.reason.message).join('; ') : null,
      });
    };
    const poller = createPoller({ load, intervalMs: 5 * 60_000 });
    poller.start();
    return () => {
      active = false;
      poller.stop();
    };
  }, [symbol]);

  return state;
}

export function formatUsd(value) {
  if (!Number.isFinite(value)) return 'Unavailable';
  // Magnitude, not sign, decides whether cents are worth showing: keying off
  // the raw value gave -1234.5 two decimals and +1234.5 one.
  const small = Math.abs(value) < 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: small ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatPercent(value) {
  if (!Number.isFinite(value)) return 'No change data';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export function formatTimestamp(timestamp, now = new Date()) {
  if (!timestamp) return 'Awaiting provider timestamp';
  // Intl throws RangeError on an unparseable date, which would take down the
  // whole panel over one malformed provider field.
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return 'Provider timestamp unreadable';
  // A time alone reads as today: on a Monday morning Friday's close showed as
  // "4:00 PM EDT". Anything not from today carries its date, and its year
  // when that differs too.
  const sameDay = parsed.toDateString() === now.toDateString();
  const sameYear = parsed.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat('en-US', {
    ...(sameDay ? {} : { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }),
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(parsed);
}

/**
 * The change from a chart point back to whatever observation sits closest to
 * `days` before it, together with the span actually covered.
 *
 * Counting a fixed number of points backwards only measures a fixed number of
 * days when the series has one cadence. The global liquidity history unions
 * weekly US dates with weekly ECB dates and lands roughly twice a week, so
 * thirteen points back was about six weeks - and the tooltip said "13W".
 */
export function changeOverSpan(points, index, days, maxSlackDays = 21) {
  const current = points?.[index];
  if (!current || !Number.isFinite(current.value) || current.value <= 0) return null;
  const currentTime = new Date(current.date).getTime();
  if (!Number.isFinite(currentTime)) return null;
  const targetTime = currentTime - (days * 86_400_000);

  let candidate = null;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const point = points[cursor];
    const time = new Date(point?.date).getTime();
    if (!Number.isFinite(time) || time > targetTime) continue;
    candidate = point;
    break;
  }
  if (!candidate || !Number.isFinite(candidate.value) || candidate.value <= 0) return null;

  const spanDays = Math.round((currentTime - new Date(candidate.date).getTime()) / 86_400_000);
  // A history that simply does not reach back far enough must not answer as
  // though it did.
  if (spanDays > days + maxSlackDays) return null;
  return { percent: ((current.value / candidate.value) - 1) * 100, spanDays, fromDate: candidate.date };
}

/** "13W" for 91 days, "26D" for 26 - whichever unit reports the span honestly. */
export function formatSpanLabel(spanDays) {
  if (!Number.isFinite(spanDays) || spanDays <= 0) return '';
  if (spanDays >= 14 && spanDays % 7 === 0) return `${spanDays / 7}W`;
  if (spanDays >= 14) return `${Math.round(spanDays / 7)}W`;
  return `${spanDays}D`;
}
