import { config } from './config.js';
import { calculateTechnicalSnapshot } from './analytics.js';
import {
  acquireIngestionLock,
  finishIngestionRun,
  hasIngestedMarketHistoriesSince,
  isDatabaseConfigured,
  persistModelOutput,
  persistSeries,
  startIngestionRun,
} from './database.js';
import { getIngestionHistorySymbols, getLiquiditySnapshot, getMarketHistory, getMarketSnapshot } from './providers.js';

function observationTimestamp(value, fallback) {
  const timestamp = value ? new Date(value) : new Date(fallback);
  return Number.isNaN(timestamp.getTime()) ? new Date(fallback).toISOString() : timestamp.toISOString();
}

async function executeIngestion(jobName, loader) {
  const lock = await acquireIngestionLock(jobName);
  if (!lock.acquired) return { status: 'skipped', observationsWritten: 0, details: { reason: 'Job is active on another process' } };
  let runId = null;
  let observationsWritten = 0;
  const reportWritten = (count) => {
    observationsWritten += count;
  };
  try {
    runId = await startIngestionRun(jobName);
    const result = await loader({ runId, reportWritten });
    const status = result.status ?? 'completed';
    await finishIngestionRun(runId, status, observationsWritten, result.details);
    return { ...result, status, observationsWritten };
  } catch (error) {
    await finishIngestionRun(runId, 'failed', observationsWritten, {}, error.message);
    throw error;
  } finally {
    await lock.release();
  }
}

export async function ingestMarketSnapshot() {
  return executeIngestion('market-snapshot', async ({ runId, reportWritten }) => {
    const snapshot = await getMarketSnapshot({ refresh: true, usage: 'scheduled' });
    const liveAssets = snapshot.assets.filter((item) => !item.stored && !item.cached && !item.stale);
    if (!liveAssets.length) throw new Error('No live market observations were returned');

    for (const asset of liveAssets) {
      const observedAt = observationTimestamp(asset.asOf, snapshot.generatedAt);
      const written = await persistSeries({
        id: `market:${asset.key}:quote:usd`,
        provider: asset.source,
        providerSeriesId: asset.symbol,
        name: asset.name,
        assetClass: asset.kind,
        frequency: 'snapshot',
        unit: 'price',
        currency: 'USD',
        metadata: { symbol: asset.symbol },
        observations: [{
          observedAt,
          providerAsOf: observedAt,
          value: asset.price,
          metadata: { changePercent: asset.changePercent },
        }],
      }, runId);
      reportWritten(written);
    }

    return {
      status: snapshot.errors.length ? 'partial' : 'completed',
      details: { liveAssetsReceived: liveAssets.length, fallbackAssetsIgnored: snapshot.assets.length - liveAssets.length, providerErrors: snapshot.errors },
    };
  });
}

export async function ingestMarketHistory() {
  return executeIngestion('market-history', async ({ runId, reportWritten }) => {
    let symbolsReceived = 0;
    let twelveSymbolsReceived = 0;
    const errors = [];

    for (const symbol of getIngestionHistorySymbols()) {
      if (symbol !== 'BTC' && !config.twelveDataApiKey) continue;
      try {
        const history = await getMarketHistory(symbol, '1Y', { preferStored: false, usage: 'scheduled' });
        if (!history.points.length) {
          errors.push({ symbol, message: 'Provider returned no history' });
          continue;
        }
        if (history.stale) throw new Error(`Provider returned stale history ending ${history.asOf ?? 'without a timestamp'}`);
        const written = await persistSeries({
          id: `market:${symbol}:close:usd`,
          provider: history.source,
          providerSeriesId: symbol,
          name: `${symbol} closing price`,
          assetClass: symbol === 'BTC' ? 'Crypto' : 'Market',
          frequency: '1day',
          unit: 'close',
          currency: 'USD',
          metadata: { range: '1Y', timezone: 'UTC' },
          observations: history.points.map((point) => ({
            observedAt: point.timestamp,
            providerAsOf: point.timestamp,
            value: point.value,
            metadata: {},
          })),
        }, runId);
        reportWritten(written);
        const technicalModel = calculateTechnicalSnapshot(history.points, { annualizationDays: symbol === 'BTC' ? 365 : 252 });
        await persistModelOutput(`technical:${symbol}`, technicalModel, [{
          seriesId: `market:${symbol}:close:usd`,
          from: history.points[0].timestamp,
          to: history.points.at(-1).timestamp,
          observations: history.points.length,
        }], runId);
        symbolsReceived += 1;
        if (symbol !== 'BTC') twelveSymbolsReceived += 1;
      } catch (error) {
        errors.push({ symbol, message: error.message });
      }
    }

    if (!symbolsReceived) throw new Error(`No market histories were ingested: ${JSON.stringify(errors)}`);

    return { status: errors.length ? 'partial' : 'completed', details: { symbolsReceived, twelveSymbolsReceived, errors } };
  });
}

export async function ingestLiquiditySnapshot() {
  return executeIngestion('fred-liquidity', async ({ runId, reportWritten }) => {
    const snapshot = await getLiquiditySnapshot({ refresh: true });
    if (!snapshot.series.length) throw new Error('No FRED series were returned');

    for (const series of snapshot.series) {
      const written = await persistSeries({
        id: `fred:${series.id}`,
        provider: 'FRED',
        providerSeriesId: series.id,
        name: series.name,
        assetClass: 'Macro',
        frequency: 'provider-defined',
        unit: series.unit,
        currency: series.unit.startsWith('USD') ? 'USD' : null,
        metadata: { key: series.key, multiplier: series.multiplier },
        observations: series.history.map((observation) => ({
          observedAt: `${observation.date}T00:00:00.000Z`,
          providerAsOf: observation.realtimeStart ? `${observation.realtimeStart}T00:00:00.000Z` : null,
          value: observation.value,
          metadata: { realtimeEnd: observation.realtimeEnd ?? null },
        })),
      }, runId);
      reportWritten(written);
    }
    const usableSeries = snapshot.series.filter((series) => !series.stale);
    const lineageFor = (keys) => {
      const requested = new Set(keys);
      return usableSeries.filter((series) => requested.has(series.key)).map((series) => ({ seriesId: `fred:${series.id}`, asOf: series.date }));
    };
    const contributingDrivers = (model) => new Set((model?.drivers ?? []).filter((driver) => Number.isFinite(driver.score)).map((driver) => driver.key));
    const liquidityKeys = ['fedBalanceSheet', 'treasuryGeneralAccount', 'reverseRepo', 'usM2', 'dxy'];
    const usdDrivers = contributingDrivers(snapshot.usdStrength);
    const usdKeys = [
      ...(usdDrivers.has('dollarTrend') || usdDrivers.has('dollarMomentum') ? ['dxy'] : []),
      ...(usdDrivers.has('realYield') ? ['realYield10y'] : []),
      ...(usdDrivers.has('frontEnd') ? ['us2yYield'] : []),
      ...(usdDrivers.has('stress') ? ['financialConditions', 'vix'] : []),
      ...(usdDrivers.has('liquidity') ? liquidityKeys : []),
    ];
    const macroDrivers = contributingDrivers(snapshot.macroRegime);
    const macroKeys = [
      ...(macroDrivers.has('liquidity') ? liquidityKeys : []),
      ...(macroDrivers.has('financialConditions') ? ['financialConditions'] : []),
      ...(macroDrivers.has('credit') ? ['highYieldSpread'] : []),
      ...(macroDrivers.has('volatility') ? ['vix'] : []),
      ...(macroDrivers.has('dollar') ? usdKeys : []),
    ];
    await persistModelOutput('us-liquidity', snapshot.model, lineageFor(liquidityKeys), runId);
    await persistModelOutput('usd-strength', snapshot.usdStrength, lineageFor(usdKeys), runId);
    if (snapshot.macroRegime?.status !== 'unavailable') {
      await persistModelOutput('macro-regime', snapshot.macroRegime, lineageFor(macroKeys), runId);
    }

    return {
      status: snapshot.errors.length || !snapshot.model ? 'partial' : 'completed',
      details: { seriesReceived: snapshot.series.length, modelVersion: snapshot.model?.version ?? null, usdStrengthVersion: snapshot.usdStrength?.version ?? null, macroRegimeVersion: snapshot.macroRegime?.version ?? null, providerErrors: snapshot.errors },
    };
  });
}

export async function runAllIngestion() {
  if (!isDatabaseConfigured()) throw new Error('DATABASE_URL is not configured');
  const results = [];
  results.push(await ingestMarketSnapshot());
  results.push(await ingestMarketHistory());
  if (config.fredApiKey) results.push(await ingestLiquiditySnapshot());
  return results;
}

export function startIngestionScheduler() {
  if (!config.ingestionEnabled || !isDatabaseConfigured()) return async () => {};
  let marketRunning = false;
  let macroRunning = false;
  let historyRunning = false;
  const activeJobs = new Set();

  const track = async (job) => {
    activeJobs.add(job);
    try {
      return await job;
    } finally {
      activeJobs.delete(job);
    }
  };

  const runMarket = async () => {
    if (marketRunning) return;
    marketRunning = true;
    try {
      await track(ingestMarketSnapshot());
    } catch (error) {
      console.error('Market ingestion failed:', error.message);
    } finally {
      marketRunning = false;
    }
  };

  const runMacro = async () => {
    if (macroRunning || !config.fredApiKey) return;
    macroRunning = true;
    try {
      await track(ingestLiquiditySnapshot());
    } catch (error) {
      console.error('Macro ingestion failed:', error.message);
    } finally {
      macroRunning = false;
    }
  };

  const runHistory = async (options = {}) => {
    if (historyRunning) return;
    historyRunning = true;
    try {
      if (options.skipCompletedToday) {
        const utcDayStart = new Date();
        utcDayStart.setUTCHours(0, 0, 0, 0);
        const minimumTwelveSymbols = config.twelveDataApiKey ? getIngestionHistorySymbols().filter((symbol) => symbol !== 'BTC').length : 0;
        if (await hasIngestedMarketHistoriesSince(utcDayStart.toISOString(), minimumTwelveSymbols)) return;
      }
      await track(ingestMarketHistory());
    } catch (error) {
      console.error('History ingestion failed:', error.message);
    } finally {
      historyRunning = false;
    }
  };

  void runMarket();
  void runMacro();
  void runHistory({ skipCompletedToday: true });
  const marketTimer = setInterval(runMarket, Math.max(config.marketRefreshMs, config.twelveQuoteRefreshMs));
  const macroTimer = setInterval(runMacro, config.macroRefreshMs);
  const historyTimer = setInterval(() => runHistory({ skipCompletedToday: true }), config.historyRefreshMs);
  marketTimer.unref();
  macroTimer.unref();
  historyTimer.unref();

  return async () => {
    clearInterval(marketTimer);
    clearInterval(macroTimer);
    clearInterval(historyTimer);
    await Promise.allSettled([...activeJobs]);
  };
}
