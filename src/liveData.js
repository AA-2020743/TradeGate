import { useEffect, useState } from 'react';
import { createPoller } from './polling.js';
import { derivePlatformStatus } from './platformStatus.js';

async function requestJson(path) {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Request failed with ${response.status}`);
  return response.json();
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
    news: null,
    screener: null,
    alerts: null,
    error: null,
  });

  useEffect(() => {
    let active = true;

    const load = async () => {
      const [health, markets, liquidity, dxyBtc, regimeCorrelations, positioning, heatmap, metals, fx, sentiment, bitcoin, equityRisk, news, screener, alerts] = await Promise.allSettled([
        requestJson('/api/health'),
        requestJson('/api/markets/snapshot'),
        requestJson('/api/macro/liquidity'),
        requestJson('/api/analytics/dxy-btc'),
        requestJson('/api/analytics/regime-correlations'),
        requestJson('/api/analytics/positioning'),
        requestJson('/api/analytics/heatmap'),
        requestJson('/api/analytics/metals'),
        requestJson('/api/analytics/fx'),
        requestJson('/api/analytics/sentiment'),
        requestJson('/api/analytics/bitcoin'),
        requestJson('/api/analytics/equity-risk'),
        requestJson('/api/news/wire'),
        requestJson('/api/analytics/screener'),
        requestJson('/api/alerts'),
      ]);
      if (!active) return;

      const healthData = health.status === 'fulfilled' ? health.value : null;
      const marketData = markets.status === 'fulfilled' ? markets.value : null;
      const liquidityData = liquidity.status === 'fulfilled' ? liquidity.value : null;
      const dxyBtcData = dxyBtc.status === 'fulfilled' ? dxyBtc.value : null;
      const regimeCorrelationsData = regimeCorrelations.status === 'fulfilled' ? regimeCorrelations.value : null;
      const positioningData = positioning.status === 'fulfilled' ? positioning.value : null;
      const heatmapData = heatmap.status === 'fulfilled' ? heatmap.value : null;
      const metalsData = metals.status === 'fulfilled' ? metals.value : null;
      const fxData = fx.status === 'fulfilled' ? fx.value : null;
      const sentimentData = sentiment.status === 'fulfilled' ? sentiment.value : null;
      const bitcoinData = bitcoin.status === 'fulfilled' ? bitcoin.value : null;
      const equityRiskData = equityRisk.status === 'fulfilled' ? equityRisk.value : null;
      const newsData = news.status === 'fulfilled' ? news.value : null;
      const screenerData = screener.status === 'fulfilled' ? screener.value : null;
      const alertsData = alerts.status === 'fulfilled' ? alerts.value : null;
      const coreRequests = { health, markets, liquidity, dxyBtc };
      const platform = derivePlatformStatus({
        health: healthData,
        markets: marketData,
        liquidity: liquidityData,
        failedRequests: Object.entries(coreRequests).filter(([, result]) => result.status === 'rejected').map(([name]) => name),
        blockedSources: healthData?.blockedSources ?? [],
      });

      setState({
        status: platform.status,
        platform,
        health: healthData,
        markets: marketData,
        liquidity: liquidityData,
        dxyBtc: dxyBtcData,
        regimeCorrelations: regimeCorrelationsData,
        positioning: positioningData,
        heatmap: heatmapData,
        metals: metalsData,
        fx: fxData,
        sentiment: sentimentData,
        bitcoin: bitcoinData,
        equityRisk: equityRiskData,
        news: newsData,
        screener: screenerData,
        alerts: alertsData,
        error: platform.error,
      });
    };

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

export function formatTimestamp(timestamp) {
  if (!timestamp) return 'Awaiting provider timestamp';
  // Intl throws RangeError on an unparseable date, which would take down the
  // whole panel over one malformed provider field.
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return 'Provider timestamp unreadable';
  return new Intl.DateTimeFormat('en-US', {
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
