import { config } from './config.js';
import { observationTimestamp, runIngestionJob } from './ingestionRun.js';
import { buildWorkspaceNarrative, calculateTechnicalSnapshot, isPublished } from './analytics.js';
import {
  acquireIngestionLock,
  finishIngestionRun,
  hasIngestedMarketHistoriesSince,
  insertModelAlerts,
  isDatabaseConfigured,
  getRecentModelOutputs,
  persistModelOutput,
  persistSeries,
  startIngestionRun,
} from './database.js';
import { getBitcoinCycleWorkspace, calculateDollarTransmission, getDxyBitcoinRelationship, getEquityRiskAppetite, getFxWorkspace, getIngestionHistorySymbols, getLiquiditySnapshot, getMarketHeatmap, getMarketHistory, getMarketSnapshot, getMetalsWorkspace, getRegimeCorrelations, getSentimentSnapshot, REGIME_CORRELATION_PAIRS } from './providers.js';

function executeIngestion(jobName, loader) {
  return runIngestionJob(jobName, loader, {
    acquireLock: acquireIngestionLock,
    startRun: startIngestionRun,
    finishRun: finishIngestionRun,
  });
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
      const provider = series.provider ?? 'FRED';
      const written = await persistSeries({
        id: `${provider.toLowerCase()}:${series.id}`,
        provider,
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
      return usableSeries.filter((series) => requested.has(series.key)).map((series) => ({ seriesId: `${(series.provider ?? 'FRED').toLowerCase()}:${series.id}`, asOf: series.date }));
    };
    const contributingDrivers = (model) => new Set((model?.drivers ?? []).filter((driver) => Number.isFinite(driver.score)).map((driver) => driver.key));
    const liquidityKeys = ['fedBalanceSheet', 'treasuryGeneralAccount', 'reverseRepo', 'usM2', 'dxy'];
    const globalKeys = [...new Set([...liquidityKeys, 'ecbBalanceSheet', 'bojBalanceSheet', 'pbocBalanceSheet', 'eurUsd', 'yenPerUsd', 'yuanPerUsd'])];
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
      ...(macroDrivers.has('globalLiquidity') ? globalKeys : []),
    ];
    await persistModelOutput('us-liquidity', snapshot.model, lineageFor(liquidityKeys), runId);
    await persistModelOutput('global-liquidity', snapshot.globalLiquidity, lineageFor(globalKeys), runId);
    await persistModelOutput('usd-strength', snapshot.usdStrength, lineageFor(usdKeys), runId);
    if (snapshot.macroRegime?.status !== 'unavailable') {
      await persistModelOutput('macro-regime', snapshot.macroRegime, lineageFor(macroKeys), runId);
    }

    // Every macro model that publishes a score is stored, not just the three
    // that predate the rest. Without this the narrative and the model
    // correlation matrix have nothing to compare run to run, which is the only
    // reason either exists.
    const MACRO_MODEL_PERSISTENCE = [
      { modelId: 'macro-regime-history', model: snapshot.regimeHistory, keys: ['financialConditions', 'highYieldSpread', 'vix'] },
      { modelId: 'yield-curve', model: snapshot.yieldCurve, keys: ['us10yYield', 'us2yYield', 'us3mYield'] },
      { modelId: 'inflation-nowcast', model: snapshot.inflation, keys: ['breakeven5y', 'breakeven10y', 'forwardInflation5y5y', 'cpi'] },
      { modelId: 'rate-path', model: snapshot.ratePath, keys: ['us2yYield', 'us3mYield', 'us10yYield'] },
      { modelId: 'liquidity-calendar', model: snapshot.liquidityCalendar, keys: ['treasuryGeneralAccount', 'reverseRepo', 'fedBalanceSheet'] },
      { modelId: 'growth-nowcast', model: snapshot.growthNowcast, keys: ['us10yYield', 'breakeven10y'] },
      { modelId: 'nominal-decomposition', model: snapshot.nominalDecomposition, keys: ['us10yYield', 'realYield10y', 'breakeven10y'] },
      { modelId: 'term-premium', model: snapshot.termPremium, keys: ['termPremium10y', 'us10yYield'] },
      { modelId: 'rate-divergence', model: snapshot.rateDivergence, keys: ['us10yYield', 'germany10y', 'japan10y', 'uk10y'] },
      { modelId: 'data-surprise', model: snapshot.dataSurprise, keys: ['payrolls', 'initialClaims', 'industrialProduction', 'retailSales'] },
      { modelId: 'reserve-scarcity', model: snapshot.reserveScarcity, keys: ['sofr', 'iorb'] },
      { modelId: 'liquidity-payoff', model: snapshot.liquidityPayoff, keys: liquidityKeys },
      { modelId: 'macro-consensus', model: snapshot.consensus, keys: macroKeys },
    ];
    const persistedMacroModels = [];
    for (const entry of MACRO_MODEL_PERSISTENCE) {
      if (!entry.model || entry.model.status === 'unavailable') continue;
      await persistModelOutput(entry.modelId, entry.model, lineageFor(entry.keys), runId);
      persistedMacroModels.push(entry.modelId);
    }

    // Only transitions reach the feed. The alerts table's uniqueness constraint
    // includes detected_at, which defaults to now(), so a still-live condition
    // inserted every run conflicts with nothing and duplicates forever.
    let macroAlertsRaised = 0;
    const alertRows = [
      ...(snapshot.macroAlerts?.raised ?? []).map((entry) => ({ key: entry.key, text: `[${entry.severity}] ${entry.text}` })),
      ...(snapshot.macroAlerts?.resolved ?? []).map((entry) => ({ key: `${entry.key}:resolved`, text: `[cleared] ${entry.text}` })),
    ];
    if (alertRows.length) {
      macroAlertsRaised = await insertModelAlerts('macro-alerts-v1', alertRows, runId);
    }
    if (snapshot.macroAlerts) {
      // Stored so the next run knows what was live at this one.
      await persistModelOutput('macro-alerts', { ...snapshot.macroAlerts, asOf: new Date().toISOString() }, lineageFor(macroKeys), runId);
    }

    // Backfilled readings are stored once, keyed by their own vintage, so a
    // model that has only ever run a handful of times still has a history to be
    // correlated against. They are flagged in the stored output so nothing
    // reads them as live runs.
    let backfilledRows = 0;
    for (const entry of snapshot.macroBackfill ?? []) {
      for (const row of entry.rows) {
        await persistModelOutput(`${entry.modelId}-backfill`, row.output, [{ provider: entry.source, asOf: row.asOf }], runId);
        backfilledRows += 1;
      }
    }

    let regimeCorrelationVersion = null;
    const persistenceErrors = [];
    try {
      const regimeCorrelations = await getRegimeCorrelations();
      if (regimeCorrelations.status === 'calculated') {
        regimeCorrelationVersion = regimeCorrelations.version;
        const correlationFredKeys = [...new Set(regimeCorrelations.pairs
          .filter((pair) => pair.status === 'calculated')
          .map((pair) => REGIME_CORRELATION_PAIRS.find((definition) => definition.key === pair.key)?.leftKey)
          .filter(Boolean))];
        await persistModelOutput('regime-correlation', regimeCorrelations, lineageFor(correlationFredKeys), runId);
      }
    } catch (error) {
      persistenceErrors.push(`Regime correlations were not persisted: ${error.message}`);
    }

    return {
      status: snapshot.errors.length || !snapshot.model ? 'partial' : 'completed',
      details: { seriesReceived: snapshot.series.length, modelVersion: snapshot.model?.version ?? null, usdStrengthVersion: snapshot.usdStrength?.version ?? null, macroRegimeVersion: snapshot.macroRegime?.version ?? null, regimeCorrelationVersion, persistedMacroModels, macroAlertsRaised, backfilledRows, providerErrors: [...snapshot.errors, ...persistenceErrors] },
    };
  });
}

const RESEARCH_WORKSPACES = [
  { modelId: 'market-heatmap', load: getMarketHeatmap },
  { modelId: 'metals-workspace', load: getMetalsWorkspace },
  { modelId: 'fx-workspace', load: getFxWorkspace },
  { modelId: 'sentiment-snapshot', load: getSentimentSnapshot },
  { modelId: 'bitcoin-cycle', load: getBitcoinCycleWorkspace },
  { modelId: 'equity-risk', load: getEquityRiskAppetite },
  {
    modelId: 'liquidity-states',
    load: async () => {
      const snapshot = await getLiquiditySnapshot();
      if (!isPublished(snapshot?.model) && !isPublished(snapshot?.globalLiquidity)) {
        throw new Error(`Liquidity models unavailable: ${snapshot?.model?.reason ?? snapshot?.globalLiquidity?.reason ?? 'no reason published'}`);
      }
      return {
        asOf: new Date().toISOString(),
        version: 'liquidity-states-v1',
        status: 'calculated',
        usRegime: snapshot.model?.regime ?? null,
        globalRegime: snapshot.globalLiquidity?.regime ?? null,
        globalMomentum: snapshot.globalLiquidity?.momentum ?? null,
        stablecoinState: snapshot.stablecoins?.state ?? null,
        stablecoinChange30dPct: Number.isFinite(snapshot.stablecoins?.change30dPct) ? Math.round(snapshot.stablecoins.change30dPct * 100) / 100 : null,
        dominantLeg: snapshot.model?.decomposition?.find((window) => window.windowDays === 91)?.dominantLeg ?? null,
        netChange13wUsdBillions: (() => { const quarter = snapshot.model?.decomposition?.find((window) => window.windowDays === 91); return quarter ? Math.round(quarter.netChange / 100) / 10 : null; })(),
      };
    },
  },
  {
    modelId: 'dollar-transmission',
    load: async () => {
      const [liquidity, dxyBtc] = await Promise.all([getLiquiditySnapshot(), getDxyBitcoinRelationship()]);
      return calculateDollarTransmission(liquidity, dxyBtc);
    },
  },
];

export async function ingestResearchWorkspaces() {
  return executeIngestion('research-workspaces', async ({ runId }) => {
    const persisted = [];
    const skipped = [];
    const errors = [];
    let alertsRaised = 0;
    for (const workspace of RESEARCH_WORKSPACES) {
      try {
        const output = await workspace.load();
        if (!output || output.status === 'unavailable') {
          skipped.push(workspace.modelId);
          continue;
        }
        const previousOutputs = await getRecentModelOutputs(workspace.modelId, 1);
        await persistModelOutput(workspace.modelId, output, [{ provider: 'aggregated-workspace', asOf: output.asOf }], runId);
        persisted.push(workspace.modelId);
        const narrative = buildWorkspaceNarrative({ [workspace.modelId]: [{ output }, ...previousOutputs] });
        if (narrative.status === 'updated' && narrative.entries.length) {
          alertsRaised += await insertModelAlerts(workspace.modelId, narrative.entries, runId);
        }
      } catch (error) {
        errors.push({ modelId: workspace.modelId, message: error.message });
      }
    }
    if (!persisted.length) throw new Error(`No research workspaces were persisted (skipped: ${skipped.join(', ') || 'none'}; errors: ${errors.map((error) => `${error.modelId}: ${error.message}`).join(' | ') || 'none'})`);
    return { status: errors.length ? 'partial' : 'completed', details: { persisted, skipped, alertsRaised, errors } };
  });
}

export async function runAllIngestion() {
  if (!isDatabaseConfigured()) throw new Error('DATABASE_URL is not configured');
  const results = [];
  results.push(await ingestMarketSnapshot());
  results.push(await ingestMarketHistory());
  if (config.fredApiKey) results.push(await ingestLiquiditySnapshot());
  results.push(await ingestResearchWorkspaces());
  return results;
}

export function startIngestionScheduler() {
  if (!config.ingestionEnabled || !isDatabaseConfigured()) return async () => {};
  let marketRunning = false;
  let macroRunning = false;
  let historyRunning = false;
  let researchRunning = false;
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

  const runResearch = async () => {
    if (researchRunning) return;
    researchRunning = true;
    try {
      await track(ingestResearchWorkspaces());
    } catch (error) {
      console.error('Research workspace ingestion failed:', error.message);
    } finally {
      researchRunning = false;
    }
  };

  void runMarket();
  void runMacro();
  void runHistory({ skipCompletedToday: true });
  void runResearch();
  const marketTimer = setInterval(runMarket, Math.max(config.marketRefreshMs, config.twelveQuoteRefreshMs));
  const macroTimer = setInterval(runMacro, config.macroRefreshMs);
  const historyTimer = setInterval(() => runHistory({ skipCompletedToday: true }), config.historyRefreshMs);
  const researchTimer = setInterval(runResearch, config.macroRefreshMs);
  marketTimer.unref();
  macroTimer.unref();
  historyTimer.unref();
  researchTimer.unref();

  return async () => {
    clearInterval(marketTimer);
    clearInterval(macroTimer);
    clearInterval(historyTimer);
    clearInterval(researchTimer);
    await Promise.allSettled([...activeJobs]);
  };
}
