import { getStoredMarketHistories, getStoredSeriesCoverage, isDatabaseConfigured } from './database.js';
import { calculateTechnicalSnapshot } from './analytics.js';
import { calculateBottomSignal, calculateBasketRotation, calculateEquityRegime, calculateMacroSensitivities, calculateSectorBreadthProxy, calculateSectorRotation, calculateTopRisk } from './equityAnalytics.js';
import {
  attachSeriesCoverage,
  breadthRequirements,
  indexCatalog,
  positioningRequirements,
  sectorCatalog,
  sentimentRequirements,
  subsectorCatalog,
} from './equityCatalog.js';
import { getEquityRiskAppetite, getLiquiditySnapshot, getMarketHistory, getTechnicalSnapshot } from './providers.js';
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

  const [technicalResult, liquidityResult, riskAppetiteResult, liveTechnicalResult] = await Promise.allSettled([
    getStoredTechnicalSnapshot(symbol),
    getLiquiditySnapshot(),
    getEquityRiskAppetite(),
    getMarketHistory(symbol, '1Y', { preferStored: false }),
  ]);
  const technical = technicalResult.status === 'fulfilled' ? technicalResult.value : null;
  const liquidity = liquidityResult.status === 'fulfilled' ? liquidityResult.value : null;
  const riskAppetite = riskAppetiteResult.status === 'fulfilled' ? riskAppetiteResult.value : null;
  let usableTechnical = technical?.stale ? null : technical?.model;
  if (!usableTechnical && liveTechnicalResult.status === 'fulfilled' && liveTechnicalResult.value?.points?.length) {
    usableTechnical = calculateTechnicalSnapshot(liveTechnicalResult.value.points);
  }
  const constituentBreadth = riskAppetite?.spxBreadth?.status === 'calculated'
    ? { ...riskAppetite.spxBreadth }
    : unavailableBreadth;
  const regime = calculateEquityRegime({ technical: usableTechnical, liquidity: liquidity?.model, breadth: constituentBreadth });
  const topRisk = calculateTopRisk({ technical: usableTechnical, breadth: constituentBreadth, liquidity: liquidity?.model });
  const bottomSignal = calculateBottomSignal({ technical: usableTechnical, breadth: constituentBreadth, liquidity: liquidity?.model });

  return {
    version: 'equity-dashboard-v1',
    asOf: [technical?.asOf, liquidity?.model?.asOf].filter(Boolean).sort().at(-1) ?? null,
    index,
    technical,
    regime,
    topRisk,
    bottomSignal,
    breadth: constituentBreadth.status === 'calculated' ? constituentBreadth : unavailableBreadth,
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
  let spyTechnical = null;
  if (isDatabaseConfigured()) {
    const [historiesResult, coverageResult, liquidityResult, technicalResult] = await Promise.allSettled([
      getStoredMarketHistories(symbols),
      getStoredSeriesCoverage(symbols),
      getLiquiditySnapshot(),
      getStoredTechnicalSnapshot('SPY'),
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
    if (technicalResult.status === 'fulfilled') spyTechnical = technicalResult.value;
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
  const breadthProxy = calculateSectorBreadthProxy(
    rotationInputs
      .filter((input) => input.points.length)
      .map((input) => ({ symbol: input.symbol, points: normalizeStoredPoints(input.points) })),
  );
  const usableBreadth = breadthProxy.status === 'calculated' ? breadthProxy : unavailableBreadth;
  const usableSectorTechnical = spyTechnical?.stale ? null : spyTechnical?.model ?? null;
  const sectorTopRisk = calculateTopRisk({ technical: usableSectorTechnical, breadth: usableBreadth, liquidity: liquidity?.model });
  const sectorBottomSignal = calculateBottomSignal({ technical: usableSectorTechnical, breadth: usableBreadth, liquidity: liquidity?.model });
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

  const stylePairs = [
    { key: 'growthValue', leftName: 'Growth (QQQ)', rightName: 'Value tilt (DIA)', leftSymbols: ['QQQ'], rightSymbols: ['DIA'], leftLeader: 'Growth', rightLeader: 'Value' },
    { key: 'cyclicalDefensive', leftName: 'Cyclicals (XLY/XLI/XLE/XLB)', rightName: 'Defensives (XLP/XLU/XLV)', leftSymbols: ['XLY', 'XLI', 'XLE', 'XLB'], rightSymbols: ['XLP', 'XLU', 'XLV'], leftLeader: 'Cyclicals', rightLeader: 'Defensives' },
    { key: 'usInternational', leftName: 'US (SPY)', rightName: 'Developed intl (EWG/EWU/EWQ/EWJ)', leftSymbols: ['SPY'], rightSymbols: ['EWG', 'EWU', 'EWQ', 'EWJ'], leftLeader: 'US', rightLeader: 'International DM' },
    { key: 'dmEmerging', leftName: 'Emerging markets (EEM)', rightName: 'US (SPY)', leftSymbols: ['EEM'], rightSymbols: ['SPY'], leftLeader: 'EM', rightLeader: 'DM/US' },
    { key: 'smallLarge', leftName: 'Small caps (IWM)', rightName: 'Large caps (SPY)', leftSymbols: ['IWM'], rightSymbols: ['SPY'], leftLeader: 'Small caps', rightLeader: 'Large caps' },
  ];
  const styles = calculateBasketRotation(stylePairs, histories);

  return {
    version: 'equity-sector-dashboard-v1',
    asOf: rotation.asOf,
    storage: { configured: isDatabaseConfigured(), available: storageAvailable, coverageAvailable },
    rotation: { ...rotation, sectors, subsectors },
    styles,
    macroSensitivity: { sources: macroSources, window: '60D changes' },
    sectors: attachSeriesCoverage(sectorCatalog, coverage),
    subsectors: attachSeriesCoverage(subsectorCatalog, coverage),
    sectorBreadth: breadthProxy.status === 'calculated' ? breadthProxy : {
      status: 'unavailable',
      reason: 'Fresh sector and subsector ETF histories are required for the participation proxy.',
    },
    topRisk: sectorTopRisk,
    bottomSignal: sectorBottomSignal,
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
