import { getStoredMarketHistories, getStoredSeriesCoverage, isDatabaseConfigured } from './database.js';
import { calculateTechnicalSnapshot } from './analytics.js';
import { calculateBottomSignal, calculateEquityRegime, calculateSectorRotation, calculateTopRisk } from './equityAnalytics.js';
import {
  attachSeriesCoverage,
  breadthRequirements,
  indexCatalog,
  positioningRequirements,
  sectorCatalog,
  sentimentRequirements,
  subsectorCatalog,
} from './equityCatalog.js';
import { getLiquiditySnapshot } from './providers.js';
import { isDailyCloseStale } from './freshness.js';

const unavailableBreadth = {
  version: 'equity-breadth-v1',
  status: 'unavailable',
  score: null,
  topRisk: null,
  bottomScore: null,
  source: null,
  missing: breadthRequirements,
  reason: 'Constituent-level price and volume histories are not connected.',
};

function unavailableDataset(name, requirements) {
  return {
    name,
    status: 'unavailable',
    asOf: null,
    source: null,
    requirements,
  };
}

async function getStoredTechnicalSnapshot(symbol) {
  if (!isDatabaseConfigured()) return { symbol, source: null, configured: false, stored: false, stale: false, asOf: null, model: null };
  const histories = await getStoredMarketHistories([symbol]);
  const points = histories.get(symbol) ?? [];
  const calculatedModel = calculateTechnicalSnapshot(points);
  const asOf = calculatedModel?.asOf ?? points.at(-1)?.timestamp ?? null;
  const latestTimestamp = new Date(asOf).getTime();
  const stale = Boolean(points.length) && isDailyCloseStale(latestTimestamp);
  return {
    symbol,
    source: points.length ? 'PostgreSQL (stored Twelve Data history)' : null,
    configured: true,
    stored: Boolean(points.length),
    stale,
    asOf,
    model: stale ? null : calculatedModel,
  };
}

export async function getEquityDashboard(requestedSymbol = 'SPY') {
  const symbol = requestedSymbol.toUpperCase();
  const index = indexCatalog.find((item) => item.symbol === symbol);
  if (!index) throw new Error(`Unsupported equity index proxy: ${symbol}`);

  const [technicalResult, liquidityResult] = await Promise.allSettled([
    getStoredTechnicalSnapshot(symbol),
    getLiquiditySnapshot(),
  ]);
  const technical = technicalResult.status === 'fulfilled' ? technicalResult.value : null;
  const liquidity = liquidityResult.status === 'fulfilled' ? liquidityResult.value : null;
  const usableTechnical = technical?.stale ? null : technical?.model;
  const regime = calculateEquityRegime({ technical: usableTechnical, liquidity: liquidity?.model, breadth: unavailableBreadth });
  const topRisk = calculateTopRisk({ technical: usableTechnical, breadth: unavailableBreadth, liquidity: liquidity?.model });
  const bottomSignal = calculateBottomSignal({ technical: usableTechnical, breadth: unavailableBreadth, liquidity: liquidity?.model });

  return {
    version: 'equity-dashboard-v1',
    asOf: [technical?.asOf, liquidity?.model?.asOf].filter(Boolean).sort().at(-1) ?? null,
    index,
    technical,
    regime,
    topRisk,
    bottomSignal,
    breadth: unavailableBreadth,
    sentiment: unavailableDataset('Sentiment', sentimentRequirements),
    positioning: unavailableDataset('Positioning', positioningRequirements),
    flows: unavailableDataset('Flows', ['ETF flows', 'Mutual-fund flows', 'Institutional flows', 'Retail flows', 'Options flows']),
    historicalTopStudy: {
      status: 'unavailable',
      reason: 'Point-in-time breadth, sentiment, positioning, and multi-year histories are required. Current-vintage price data alone would not produce a look-ahead-safe warning study.',
    },
    sources: [
      {
        name: 'Index market history',
        status: technical?.stale ? 'stale' : technical?.model ? 'available' : 'unavailable',
        source: technical?.source ?? null,
        asOf: technical?.asOf ?? null,
        disclosure: `${index.name} is represented by ${index.symbol}, a ${index.instrument}.`,
      },
      {
        name: 'US liquidity',
        status: liquidity?.model ? 'available' : 'unavailable',
        source: liquidity?.model?.version ?? null,
        asOf: liquidity?.model?.asOf ?? null,
      },
      { name: 'Constituent breadth', status: 'unavailable', source: null, asOf: null },
      { name: 'Sentiment and positioning', status: 'unavailable', source: null, asOf: null },
    ],
    errors: [
      ...(technicalResult.status === 'rejected' ? [technicalResult.reason.message] : []),
      ...(liquidityResult.status === 'rejected' ? [liquidityResult.reason.message] : []),
      ...(technical?.stale ? [`Stored ${symbol} history is stale; signal models were suppressed`] : []),
    ],
  };
}

export async function getSectorDashboard() {
  const symbols = ['SPY', ...sectorCatalog.map((sector) => sector.symbol), ...subsectorCatalog.map((subsector) => subsector.symbol)];
  let histories = new Map(symbols.map((symbol) => [symbol, []]));
  let coverage = [];
  let storageAvailable = false;
  let coverageAvailable = false;
  let liquidity = null;
  if (isDatabaseConfigured()) {
    const [historiesResult, coverageResult, liquidityResult] = await Promise.allSettled([
      getStoredMarketHistories(symbols),
      getStoredSeriesCoverage(symbols),
      getLiquiditySnapshot(),
    ]);
    if (historiesResult.status === 'fulfilled') {
      histories = historiesResult.value;
      storageAvailable = true;
    }
    if (coverageResult.status === 'fulfilled') {
      coverage = coverageResult.value;
      coverageAvailable = true;
    }
    if (liquidityResult.status === 'fulfilled') liquidity = liquidityResult.value;
  }
  const historyIsFresh = (points) => {
    const timestamp = new Date(points.at(-1)?.timestamp).getTime();
    return points.length > 0 && !isDailyCloseStale(timestamp);
  };
  const benchmarkHistory = histories.get('SPY') ?? [];
  const usableBenchmarkHistory = historyIsFresh(benchmarkHistory) ? benchmarkHistory : [];
  const rotationInputs = [
    ...sectorCatalog.map((sector) => ({ ...sector, kind: 'sector', points: historyIsFresh(histories.get(sector.symbol) ?? []) ? histories.get(sector.symbol) : [] })),
    ...subsectorCatalog.map((subsector) => ({ ...subsector, kind: 'subsector', points: historyIsFresh(histories.get(subsector.symbol) ?? []) ? histories.get(subsector.symbol) : [] })),
  ];
  const rotation = calculateSectorRotation(rotationInputs, usableBenchmarkHistory);
  const sectorMetadata = new Map([...sectorCatalog, ...subsectorCatalog].map((item) => [item.symbol, item]));

  const fredHistoryByKey = Object.fromEntries((liquidity?.series ?? [])
    .filter((series) => !series.stale && series.history?.length)
    .map((series) => [series.key, series.history]));
  const macroSeries = {
    dollar: fredHistoryByKey.dxy ?? [],
    realYield: fredHistoryByKey.realYield10y ?? [],
    vix: fredHistoryByKey.vix ?? [],
    credit: fredHistoryByKey.highYieldSpread ?? [],
  };
  const macroSources = Object.fromEntries(Object.entries(macroSeries).map(([key, history]) => [key, history.length ? 'FRED stored history' : null]));
  const withSensitivities = rotation.sectors.map((row) => ({
    ...row,
    sensitivity: sectorMetadata.get(row.symbol)?.sensitivity ?? null,
    macroSensitivity: calculateMacroSensitivities(normalizeStoredPoints(histories.get(row.symbol) ?? []), macroSeries),
  }));
  const sectors = withSensitivities.filter((row) => row.group === null);
  const subsectors = withSensitivities.filter((row) => row.group !== null);

  return {
    version: 'equity-sector-dashboard-v1',
    asOf: rotation.asOf,
    storage: { configured: isDatabaseConfigured(), available: storageAvailable, coverageAvailable },
    rotation: { ...rotation, sectors, subsectors },
    macroSensitivity: { sources: macroSources, window: '60D changes' },
    sectors: attachSeriesCoverage(sectorCatalog, coverage),
    subsectors: attachSeriesCoverage(subsectorCatalog, coverage),
    sectorBreadth: {
      status: 'unavailable',
      reason: 'Sector and subsector constituent histories are required for participation breadth.',
    },
    flows: unavailableDataset('Sector flows', ['ETF creations/redemptions', 'Mutual-fund flows', 'Institutional flows', 'Options flows']),
    methodology: 'Rotation uses fresh, aligned 20- and 60-session ETF proxy performance relative to SPY together with technical-v1. Macro sensitivities correlate 60-day daily ETF changes against FRED broad-dollar, real-yield, VIX, and high-yield-spread histories. Stale histories are excluded; holdings breadth, volume, valuation, positioning, and flows are not inferred.',
  };
}

function normalizeStoredPoints(points) {
  return points
    .filter((point) => Number.isFinite(point.value) && point.timestamp)
    .map((point) => ({ date: String(point.timestamp).slice(0, 10), value: point.value }))
    .sort((left, right) => left.date.localeCompare(right.date));
}
