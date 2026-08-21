import { useEffect, useState } from 'react';

async function requestJson(path) {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Request failed with ${response.status}`);
  return response.json();
}

export function usePlatformData() {
  const [state, setState] = useState({
    status: 'loading',
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
    error: null,
  });

  useEffect(() => {
    let active = true;

    const load = async () => {
      const [health, markets, liquidity, dxyBtc, regimeCorrelations, positioning, heatmap, metals, fx, sentiment, bitcoin, equityRisk] = await Promise.allSettled([
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
      const hasQuotes = Boolean(marketData?.assets?.length);
      const hasUnconfiguredProviders = Object.values(healthData?.providers ?? {}).some((provider) => !provider.configured || (provider.connected === false && provider.mode === 'unavailable') || provider.migrated === false && provider.configured);
      const hasErrors = [health, markets, liquidity, dxyBtc].some((result) => result.status === 'rejected') || Boolean(marketData?.errors?.length) || Boolean(liquidityData?.errors?.length) || hasUnconfiguredProviders;

      setState({
        status: !healthData ? 'offline' : hasQuotes && !hasErrors ? 'live' : 'partial',
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
        error: !healthData ? 'The data API is unavailable.' : hasErrors ? 'Some data providers are unavailable.' : null,
      });
    };

    load();
    const interval = window.setInterval(load, 60_000);
    return () => {
      active = false;
      window.clearInterval(interval);
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
    load();
    const interval = window.setInterval(load, 5 * 60_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [symbol]);

  return state;
}

export function formatUsd(value) {
  if (!Number.isFinite(value)) return 'Unavailable';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 100 ? 2 : 0,
    maximumFractionDigits: value < 100 ? 2 : 2,
  }).format(value);
}

export function formatPercent(value) {
  if (!Number.isFinite(value)) return 'No change data';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export function formatTimestamp(timestamp) {
  if (!timestamp) return 'Awaiting provider timestamp';
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(timestamp));
}
