import { getStoredMarketHistories, getStoredSeriesCoverage, isDatabaseConfigured } from './database.js';
import { calculateTechnicalSnapshot, isPublished } from './analytics.js';
import { calculateBottomSignal, calculateBasketRotation, calculateCaptureProfile, calculateDrawdownProfile, calculateExpectedMove, calculateEquityRegime, calculateMacroSensitivities, calculateSectorBreadthProxy, calculateSectorDispersion, calculateSectorRotation, calculateTopRisk, calculateVolatilityTermStructure } from './equityAnalytics.js';
import {
  attachSeriesCoverage,
  breadthRequirements,
  indexCatalog,
  positioningRequirements,
  sectorCatalog,
  sentimentRequirements,
  subsectorCatalog,
} from './equityCatalog.js';
import { getEarningsRevisionBreadth, getEquityLongHistory, getEquityRiskAppetite, getLiquiditySnapshot, getMarketHistory, getTechnicalSnapshot } from './providers.js';
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

  const [technicalResult, liquidityResult, riskAppetiteResult, liveTechnicalResult, longHistoryResult, revisionsResult] = await Promise.allSettled([
    getStoredTechnicalSnapshot(symbol),
    getLiquiditySnapshot(),
    getEquityRiskAppetite(),
    getMarketHistory(symbol, '1Y', { preferStored: false }),
    getEquityLongHistory(symbol),
    getEarningsRevisionBreadth(),
  ]);
  const technical = technicalResult.status === 'fulfilled' ? technicalResult.value : null;
  const liquidity = liquidityResult.status === 'fulfilled' ? liquidityResult.value : null;
  const riskAppetite = riskAppetiteResult.status === 'fulfilled' ? riskAppetiteResult.value : null;
  let usableTechnical = technical?.stale ? null : technical?.model;
  if (!usableTechnical && liveTechnicalResult.status === 'fulfilled' && liveTechnicalResult.value?.points?.length) {
    usableTechnical = calculateTechnicalSnapshot(liveTechnicalResult.value.points);
  }
  // A partial breadth read is kept. The signal models mark themselves
  // provisional when they lean on one, which is more useful than publishing
  // nothing at all on a slightly incomplete universe.
  const breadthStatus = riskAppetite?.spxBreadth?.status;
  const constituentBreadth = breadthStatus === 'calculated' || breadthStatus === 'partial'
    ? { ...riskAppetite.spxBreadth }
    : unavailableBreadth;
  // Prefer the multi-year history: a drawdown ranked against twelve months of
  // sessions is barely ranked at all. The one-year feed is the fallback, and
  // whichever is used is named in the published profile.
  const longHistory = longHistoryResult.status === 'fulfilled' ? longHistoryResult.value.points ?? [] : [];
  const oneYearHistory = liveTechnicalResult.status === 'fulfilled' ? liveTechnicalResult.value?.points ?? [] : [];
  const drawdownHistory = longHistory.length >= oneYearHistory.length ? longHistory : oneYearHistory;
  const drawdownSource = drawdownHistory === longHistory && longHistory.length
    ? `${longHistoryResult.value.years}-year Yahoo ${symbol} daily closes`
    : oneYearHistory.length ? `one-year ${symbol} daily closes` : null;
  const drawdown = drawdownHistory.length
    ? { ...calculateDrawdownProfile(drawdownHistory), source: drawdownSource }
    : { version: 'equity-drawdown-profile-v1', status: 'unavailable', reason: `A ${symbol} daily close history is required to place the current drawdown against its own past: ${longHistoryResult.reason?.message ?? 'no history responded'}`, observations: 0, source: null };
  const volatility = drawdownHistory.length
    ? calculateVolatilityTermStructure(drawdownHistory)
    : { version: 'equity-volatility-term-v1', status: 'unavailable', reason: `A ${symbol} daily close history is required for the volatility term structure.`, observations: 0, terms: [] };
  const expectedMove = drawdownHistory.length
    ? { ...calculateExpectedMove(drawdownHistory), source: drawdownSource }
    : { version: 'equity-expected-move-v1', status: 'unavailable', reason: `A ${symbol} daily close history is required to draw a band and test it.`, observations: 0, horizons: [], source: null };
  const revisions = revisionsResult.status === 'fulfilled'
    ? { ...revisionsResult.value.model, source: revisionsResult.value.source, universeRequested: revisionsResult.value.universeRequested, reason: revisionsResult.value.model.reason ?? revisionsResult.value.reason }
    : { version: 'equity-revision-breadth-v1', status: 'unavailable', reason: `Analyst revision counts are unreachable: ${revisionsResult.reason?.message ?? revisionsResult.reason}`, source: null };
  const regime = calculateEquityRegime({ technical: usableTechnical, liquidity: liquidity?.model, breadth: constituentBreadth });
  const topRisk = calculateTopRisk({ technical: usableTechnical, breadth: constituentBreadth, liquidity: liquidity?.model });
  const bottomSignal = calculateBottomSignal({ technical: usableTechnical, breadth: constituentBreadth, liquidity: liquidity?.model });

  return {
    version: 'equity-dashboard-v1',
    asOf: [technical?.asOf, liquidity?.model?.asOf].filter(Boolean).sort().at(-1) ?? null,
    index,
    technical,
    regime,
    drawdown,
    volatility,
    expectedMove,
    revisions,
    topRisk,
    bottomSignal,
    breadth: constituentBreadth,
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
        status: isPublished(liquidity?.model) ? 'available' : 'unavailable',
        source: liquidity?.model?.version ?? null,
        asOf: liquidity?.model?.asOf ?? null,
        disclosure: isPublished(liquidity?.model) ? undefined : liquidity?.model?.reason ?? undefined,
      },
      {
        name: 'Analyst EPS revisions',
        status: revisions.status === 'calculated' ? 'available' : revisions.status === 'provisional' ? 'partial' : 'unavailable',
        source: revisions.source ?? null,
        asOf: null,
        disclosure: revisions.status === 'unavailable' ? revisions.reason : `${revisions.covered} of ${revisions.universeRequested ?? revisions.universe} sampled S&P 500 names carried a revision count.`,
      },
      {
        name: 'Constituent breadth',
        status: constituentBreadth.status === 'calculated' ? 'available' : constituentBreadth.status === 'partial' || constituentBreadth.status === 'provisional' ? 'partial' : 'unavailable',
        source: constituentBreadth.source ?? null,
        asOf: constituentBreadth.asOf ?? null,
      },
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
  const usableBreadth = breadthProxy.status === 'unavailable' ? unavailableBreadth : breadthProxy;
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
  // Rotation drops stale ETF histories; the sensitivity matrix must drop the
  // same ones. Correlating a driver against a history that stopped updating
  // reports a relationship that no longer has a current side to it.
  const freshPointsBySymbol = new Map(rotationInputs.map((input) => [input.symbol, input.points]));
  const withSensitivities = rotation.sectors.map((row) => ({
    ...row,
    sensitivity: sectorMetadata.get(row.symbol)?.sensitivity ?? null,
    macroSensitivity: calculateMacroSensitivities(normalizeStoredPoints(freshPointsBySymbol.get(row.symbol) ?? []), macroSeries),
  }));
  const sectors = withSensitivities.filter((row) => row.group === null);
  const subsectors = withSensitivities.filter((row) => row.group !== null);

  const dispersion = calculateSectorDispersion(
    sectorCatalog.map((sector) => ({ ...sector, points: normalizeStoredPoints(histories.get(sector.symbol) ?? []) }))
      .filter((sector) => historyIsFresh(histories.get(sector.symbol) ?? [])),
    normalizeStoredPoints(usableBenchmarkHistory),
  );

  // Capture is measured against the same fresh benchmark rotation uses, so a
  // sector's defensive claim is checked on the days the benchmark actually fell.
  const captureBenchmark = normalizeStoredPoints(usableBenchmarkHistory);
  const captureProfiles = sectorCatalog.map((sector) => {
    const points = historyIsFresh(histories.get(sector.symbol) ?? []) ? normalizeStoredPoints(histories.get(sector.symbol)) : [];
    return { symbol: sector.symbol, name: sector.name, ...calculateCaptureProfile(points, captureBenchmark) };
  });

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
    // Each driver publishes its own window label, because 60 observations
    // against a weekly series is not 60 sessions. The dashboard-level label
    // says what is common to all of them and no more.
    macroSensitivity: { sources: macroSources, window: '60 aligned changes per driver' },
    sectors: attachSeriesCoverage(sectorCatalog, coverage),
    subsectors: attachSeriesCoverage(subsectorCatalog, coverage),
    sectorBreadth: breadthProxy.status === 'unavailable' ? {
      status: 'unavailable',
      reason: breadthProxy.reason ?? 'Fresh sector and subsector ETF histories are required for the participation proxy.',
    } : breadthProxy,
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
