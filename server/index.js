import express from 'express';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.js';
import { closeDatabase, getDatabaseHealth, getIngestionStatus, getRecentModelAlerts, getRecentModelOutputs, getStoredSeriesCoverage, getWatchlists, insertModelAlerts, isDatabaseConfigured, persistModelOutput, replaceWatchlists } from './database.js';
import {
  attachSeriesCoverage,
  breadthRequirements,
  getAllEquityHistorySymbols,
  indexCatalog,
  positioningRequirements,
  sectorCatalog,
  sentimentRequirements,
  subsectorCatalog,
} from './equityCatalog.js';
import { getEquityDashboard, getSectorDashboard } from './equities.js';
import { logger } from './log.js';
import { startIngestionScheduler } from './ingestion.js';
import { createRateLimiter } from './rateLimit.js';
import { calculateDollarTransmission, getBitcoinCycleWorkspace, getBlockedSources, getCryptoGlobal, getDxyBitcoinRelationship, getEquityRiskAppetite, getEquityScreener, getEthereumRotation, getFxWorkspace, getHardMoneyValuation, getIntradayRotation, getLiquiditySnapshot, getMarketHeatmap, getMarketHistory, getMarketPositioning, getMarketSnapshot, getMetalsWorkspace, getNewsWire, getProviderHealth, getRegimeCorrelations, getSentimentSnapshot, getStablecoinLeadLag, getTechnicalSnapshot } from './providers.js';
import { buildAtomFeed } from './analytics.js';

const app = express();
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDirectory = path.join(rootDirectory, 'dist');
const distIndexFile = path.join(distDirectory, 'index.html');
const distAssetsPrefix = path.join(distDirectory, 'assets') + path.sep;
const rateLimiter = createRateLimiter({ limit: config.apiRateLimit, windowMs: config.apiRateWindowMs });

app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '64kb' }));
app.use((_request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
/**
 * Cache policy per route, matched to how often the thing behind it can change.
 *
 * Every response used to say `no-cache`, which asks a client to revalidate on
 * every request. The payloads behind most of these are already cached
 * server-side for fifteen minutes or six hours, so a client polling every five
 * minutes was re-downloading a body the server had not recomputed. A window
 * shorter than the server's own cache keeps a stale answer from outliving it.
 *
 * Anything owned by a caller is `no-store`: those are not the same for everyone
 * and must never sit in a shared cache.
 */
const CACHE_SECONDS = [
  [/^\/api\/watchlists/, null],
  [/^\/api\/health/, 30],
  [/^\/api\/ingestion\/status/, 60],
  [/^\/api\/markets\/(snapshot|history)/, 60],
  [/^\/api\/analytics\/intraday/, 60],
  [/^\/api\/(alerts|news)/, 120],
  [/^\/api\/(macro|analytics|equities|digest)/, 300],
];

export function cacheSecondsFor(pathname) {
  for (const [pattern, seconds] of CACHE_SECONDS) {
    if (pattern.test(pathname)) return seconds;
  }
  return 0;
}

app.use('/api', (request, response, next) => {
  const seconds = cacheSecondsFor(request.baseUrl + request.path);
  if (seconds === null) {
    // Caller-owned data: never stored anywhere, by anyone.
    response.setHeader('Cache-Control', 'no-store');
  } else if (seconds > 0) {
    // These payloads are identical for every caller, so a shared cache may hold
    // them; stale-while-revalidate lets a client show the last answer while it
    // fetches the next rather than blocking on a slow upstream.
    response.setHeader('Cache-Control', `public, max-age=${seconds}, stale-while-revalidate=${seconds}`);
  } else {
    response.setHeader('Cache-Control', 'no-cache');
  }
  next();
});
app.use('/api', rateLimiter.middleware);
// A write is far more expensive than a read and there is only one of them, so
// it gets its own, much tighter budget on top of the shared one. Sharing a
// single limiter let a caller spend the whole read allowance on writes.
const writeLimiter = createRateLimiter({ limit: config.apiWriteRateLimit, windowMs: config.apiRateWindowMs });
app.use('/api', (request, response, next) => {
  if (request.method === 'GET' || request.method === 'HEAD') return next();
  return writeLimiter.middleware(request, response, next);
});

/**
 * Conditional requests. The cache windows tell a client how long it may reuse a
 * response, but a revalidation still transferred the whole body — up to a few
 * hundred kilobytes of macro payload for an answer the server had not
 * recomputed. A weak ETag over the serialised body turns that into a 304.
 */
function sendJsonWithEtag(request, response, payload) {
  const body = JSON.stringify(payload);
  const etag = `W/"${createHash('sha1').update(body).digest('base64url')}"`;
  response.setHeader('ETag', etag);
  const requested = request.headers['if-none-match'];
  if (requested && requested.split(',').some((candidate) => candidate.trim() === etag)) {
    // 304 carries no body by definition, so the headers a cache needs must
    // already be set by the time this returns.
    response.status(304).end();
    return;
  }
  response.type('application/json').send(body);
}

app.use('/api', (request, response, next) => {
  // Only reads: a write's response is a receipt for something that just
  // happened and must never be answered from a cache.
  if (request.method !== 'GET' && request.method !== 'HEAD') return next();
  response.json = (payload) => {
    sendJsonWithEtag(request, response, payload);
    return response;
  };
  return next();
});

app.get('/api/health', async (_request, response) => {
  const database = await getDatabaseHealth();
  const databaseDegraded = database.configured && (!database.connected || !database.migrated);
  response.json({ status: databaseDegraded ? 'degraded' : 'ok', asOf: new Date().toISOString(), providers: { ...getProviderHealth(), database }, blockedSources: getBlockedSources() });
});

app.get('/api/markets/snapshot', async (_request, response, next) => {
  try {
    response.json(await getMarketSnapshot());
  } catch (error) {
    next(error);
  }
});

app.get('/api/markets/history/:symbol', async (request, response, next) => {
  try {
    response.json(await getMarketHistory(request.params.symbol, request.query.range));
  } catch (error) {
    // The shared classifier answers "Unsupported ..." with a 404. Keeping a
    // route-local 400 here gave the same condition two different statuses
    // depending on which endpoint the caller happened to hit.
    next(error);
  }
});

app.get('/api/analytics/technical/:symbol', async (request, response, next) => {
  try {
    response.json(await getTechnicalSnapshot(request.params.symbol));
  } catch (error) {
    if (error.message.startsWith('Unsupported history symbol')) {
      response.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.get('/api/analytics/dxy-btc', async (_request, response, next) => {
  try {
    // The transmission read needs the dollar model too, so it is composed here
    // rather than duplicated in the browser: one calculation, one answer.
    const [relationshipResult, liquidityResult] = await Promise.allSettled([getDxyBitcoinRelationship(), getLiquiditySnapshot()]);
    if (relationshipResult.status === 'rejected') throw relationshipResult.reason;
    const relationship = relationshipResult.value;
    const liquidity = liquidityResult.status === 'fulfilled' ? liquidityResult.value : null;
    response.json({ ...relationship, dollarTransmission: calculateDollarTransmission(liquidity, relationship) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/analytics/regime-correlations', async (_request, response, next) => {
  try {
    response.json(await getRegimeCorrelations());
  } catch (error) {
    next(error);
  }
});

app.get('/api/analytics/positioning', async (_request, response, next) => {
  try {
    response.json(await getMarketPositioning());
  } catch (error) {
    next(error);
  }
});

app.get('/api/analytics/heatmap', async (_request, response, next) => {
  try {
    response.json(await getMarketHeatmap());
  } catch (error) {
    next(error);
  }
});

app.get('/api/analytics/hard-money', async (request, response, next) => {
  try {
    sendJsonWithEtag(request, response, await getHardMoneyValuation());
  } catch (error) {
    next(error);
  }
});

app.get('/api/analytics/metals', async (_request, response, next) => {
  try {
    response.json(await getMetalsWorkspace());
  } catch (error) {
    next(error);
  }
});

app.get('/api/analytics/sentiment', async (_request, response, next) => {
  try {
    response.json(await getSentimentSnapshot());
  } catch (error) {
    next(error);
  }
});

app.get('/api/analytics/bitcoin', async (_request, response, next) => {
  try {
    const [workspace, ethRotation, cryptoGlobal, intraday, stablecoinLead] = await Promise.all([
      getBitcoinCycleWorkspace(),
      getEthereumRotation().catch(() => null),
      getCryptoGlobal().catch(() => null),
      getIntradayRotation().catch(() => null),
      getStablecoinLeadLag().catch(() => null),
    ]);
    response.json({ ...workspace, ethRotation, cryptoGlobal, intraday, stablecoinLead });
  } catch (error) {
    next(error);
  }
});

app.get('/api/analytics/intraday', async (request, response, next) => {
  try {
    const range = ['1d', '5d'].includes(String(request.query.range ?? '')) ? String(request.query.range) : '5d';
    response.json(await getIntradayRotation(range));
  } catch (error) {
    next(error);
  }
});

let lastPersistedScreenerAsOf = null;

app.get('/api/analytics/screener', async (_request, response, next) => {
  try {
    const payload = await getEquityScreener();
    let alertsRaised;
    if (isDatabaseConfigured() && payload?.status === 'calculated' && payload.asOf !== lastPersistedScreenerAsOf) {
      try {
        const breakouts = (payload.rows ?? []).filter((row) => row.breakout).map((row) => row.symbol);
        const previous = await getRecentModelOutputs('screener-v1', 1);
        const previousBreakouts = Array.isArray(previous[0]?.output?.breakouts) ? previous[0].output.breakouts : null;
        if (Array.isArray(previousBreakouts)) {
          const fresh = breakouts.filter((symbol) => !previousBreakouts.includes(symbol)).slice(0, 25);
          if (fresh.length) {
            const bySymbol = new Map((payload.rows ?? []).map((row) => [row.symbol, row]));
            alertsRaised = await insertModelAlerts('screener-v1', fresh.map((symbol) => {
              const row = bySymbol.get(symbol);
              return { key: symbol, text: `${symbol}${row?.sector ? ` (${row.sector})` : ''} cleared its 200-day average Â· screener score ${row?.score ?? 'n/a'}` };
            }));
          }
        }
        await persistModelOutput('screener-v1', { version: payload.version ?? 'screener-v1', asOf: payload.asOf, breakouts }, ['equity:spx-universe', 'analytics:screener']);
        lastPersistedScreenerAsOf = payload.asOf;
      } catch (persistenceError) {
        logger.warn('Screener persistence failed', { route: '/api/equities/screener', error: persistenceError });
      }
    }
    response.json(alertsRaised === undefined ? payload : { ...payload, alertsRaised });
  } catch (error) {
    next(error);
  }
});

app.get('/api/watchlists', async (_request, response, next) => {
  try {
    if (!isDatabaseConfigured()) {
      response.json({ status: 'unconfigured', lists: [] });
      return;
    }
    const lists = await getWatchlists();
    response.json({ asOf: new Date().toISOString(), status: 'calculated', lists: lists ?? [] });
  } catch (error) {
    next(error);
  }
});

app.put('/api/watchlists', async (request, response, next) => {
  try {
    const payload = request.body ?? {};
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      response.status(400).json({ error: 'Watchlist payload must be an object of name to symbol arrays.' });
      return;
    }
    const entries = Object.entries(payload);
    if (entries.length > 20) {
      response.status(400).json({ error: 'At most 20 watchlists are supported.' });
      return;
    }
    const normalized = {};
    for (const [name, symbols] of entries) {
      const cleanName = String(name).trim().slice(0, 40);
      if (!cleanName || !Array.isArray(symbols) || symbols.length > 50) {
        response.status(400).json({ error: `Invalid watchlist "${cleanName || name}".` });
        return;
      }
      const cleanSymbols = [...new Set(symbols.map((symbol) => String(symbol).toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 10)))].filter(Boolean);
      normalized[cleanName] = cleanSymbols;
    }
    if (!isDatabaseConfigured()) {
      response.json({ status: 'unconfigured', saved: false });
      return;
    }
    // The return value used to be discarded, so a failed write was reported to
    // the caller as a successful save and the next read quietly served the old
    // lists back.
    const saved = await replaceWatchlists(normalized);
    if (!saved) {
      response.status(503).json({ asOf: new Date().toISOString(), status: 'error', saved: false, reason: 'The watchlists could not be written; the previous lists are unchanged.' });
      return;
    }
    response.json({ asOf: new Date().toISOString(), status: 'calculated', saved: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/alerts', async (_request, response, next) => {
  try {
    if (!isDatabaseConfigured()) {
      response.json({ asOf: new Date().toISOString(), status: 'unconfigured', alerts: [] });
      return;
    }
    response.json({ asOf: new Date().toISOString(), status: 'calculated', alerts: await getRecentModelAlerts(50) });
  } catch (error) {
    next(error);
  }
});

const MODEL_FEED_LABELS = {
  'market-heatmap': 'Heatmap',
  'metals-workspace': 'Metals',
  'fx-workspace': 'FX',
  'sentiment-snapshot': 'Sentiment',
  'bitcoin-cycle': 'Bitcoin cycle',
  'equity-risk': 'Equity risk',
  'liquidity-states': 'Liquidity states',
  'dollar-transmission': 'Dollar transmission',
  'screener-v1': 'Screener',
  'macro-alerts-v1': 'Macro alert',
};

function respondAtom(response, feed, entries) {
  response.set('Content-Type', 'application/atom+xml; charset=utf-8');
  response.send(buildAtomFeed(feed, entries));
}

app.get('/api/alerts/feed', async (_request, response, next) => {
  try {
    if (!isDatabaseConfigured()) {
      response.status(503).json({ status: 'unconfigured' });
      return;
    }
    const alerts = await getRecentModelAlerts(50);
    const updated = alerts[0]?.detectedAt ?? new Date().toISOString();
    respondAtom(response, {
      title: 'TradeGate model alerts',
      id: 'urn:tradegate:feed:alerts',
      updated,
      link: '/api/alerts/feed',
    }, alerts.map((alert) => ({
      title: `${MODEL_FEED_LABELS[alert.modelId] ?? alert.modelId}: ${alert.text.slice(0, 80)}`,
      id: `urn:tradegate:alert:${alert.modelId}:${alert.key}:${new Date(alert.detectedAt).toISOString()}`,
      updated: new Date(alert.detectedAt).toISOString(),
      content: alert.text,
    })));
  } catch (error) {
    next(error);
  }
});

app.get('/api/news/feed', async (_request, response, next) => {
  try {
    const wire = await getNewsWire();
    const items = wire?.items ?? [];
    if (wire?.status !== 'calculated') {
      response.status(503).json({ status: wire?.status ?? 'unavailable' });
      return;
    }
    const updated = items[0]?.publishedAt ?? new Date().toISOString();
    respondAtom(response, {
      title: 'TradeGate news wire',
      id: 'urn:tradegate:feed:news',
      updated,
      link: '/api/news/feed',
    }, items.map((item, index) => ({
      title: item.title,
      id: `urn:tradegate:news:${Buffer.from(String(item.title)).toString('base64url').slice(0, 40)}:${item.publishedAt ?? index}`,
      updated: item.publishedAt ?? updated,
      content: `${item.tone ? `Tone: ${item.tone}. ` : ''}${item.title}`,
    })));
  } catch (error) {
    next(error);
  }
});

app.get('/api/digest', async (_request, response, next) => {
  try {
    const [liquidityResult, dxyBtcResult, screenerResult, sentimentResult, bitcoinResult] = await Promise.allSettled([
      getLiquiditySnapshot(),
      getDxyBitcoinRelationship(),
      getEquityScreener(),
      getSentimentSnapshot(),
      getBitcoinCycleWorkspace(),
    ]);
    const asOf = new Date().toISOString();
    if (liquidityResult.status !== 'fulfilled') {
      response.status(503).json({ asOf, status: 'unavailable', reason: `Core liquidity computation failed: ${liquidityResult.reason?.message ?? liquidityResult.reason}` });
      return;
    }
    const liquidity = liquidityResult.value;
    const dxyBtc = dxyBtcResult.status === 'fulfilled' ? dxyBtcResult.value : null;
    const screener = screenerResult.status === 'fulfilled' ? screenerResult.value : null;
    const sentiment = sentimentResult.status === 'fulfilled' ? sentimentResult.value : null;
    const bitcoin = bitcoinResult.status === 'fulfilled' ? bitcoinResult.value : null;
    const leader = screener?.rows?.length
      ? screener.rows.reduce((best, row) => ((row.score ?? -Infinity) > (best.score ?? -Infinity) ? row : best), screener.rows[0])
      : null;
    response.json({
      asOf,
      status: 'calculated',
      liquidity: {
        usRegime: liquidity.model?.regime ?? null,
        globalRegime: liquidity.globalLiquidity?.regime ?? null,
        globalMomentum: liquidity.globalLiquidity?.momentum ?? null,
        stablecoinState: liquidity.stablecoins?.state ?? null,
        stablecoinChange30dPct: Number.isFinite(liquidity.stablecoins?.change30dPct) ? Math.round(liquidity.stablecoins.change30dPct * 100) / 100 : null,
      },
      dollarTransmission: calculateDollarTransmission(liquidity, dxyBtc),
      equities: screener ? {
        calculatedCount: screener.calculatedCount ?? null,
        universeSize: screener.universeSize ?? null,
        near52wHighPct: screener.breadth?.near52wHighPct ?? null,
        above50Pct: screener.breadth?.above50Pct ?? null,
        leader: leader ? { symbol: leader.symbol, score: leader.score, sector: leader.sector ?? null, momentum20d: leader.mom20 ?? null, vsIndexMom20: leader.vsIndexMom20 ?? null, sectorRank: leader.sectorRank ?? null, sectorCount: leader.sectorCount ?? null } : null,
      } : { status: 'unavailable' },
      sentiment: sentiment?.fearGreed ? { score: sentiment.fearGreed.score, rating: sentiment.fearGreed.rating } : { status: 'unavailable' },
      bitcoin: bitcoin ? {
        price: bitcoin.trend?.status === 'calculated' ? bitcoin.trend.price : null,
        pctVsSma200d: bitcoin.trend?.pctVsSma200d ?? null,
        mvrvZ: bitcoin.valuation?.status === 'calculated' ? bitcoin.valuation.mvrvZ : null,
        valuationBand: bitcoin.valuation?.band ?? null,
        fundingAnnualizedPercent: bitcoin.leverage?.status === 'calculated' ? bitcoin.leverage.annualizedPercent ?? null : null,
      } : { status: 'unavailable' },
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/analytics/equity-risk', async (_request, response, next) => {
  try {
    response.json(await getEquityRiskAppetite());
  } catch (error) {
    next(error);
  }
});

app.get('/api/news/wire', async (_request, response, next) => {
  try {
    response.json(await getNewsWire());
  } catch (error) {
    next(error);
  }
});

app.get('/api/analytics/fx', async (_request, response, next) => {
  try {
    response.json(await getFxWorkspace());
  } catch (error) {
    next(error);
  }
});

// Twenty-two FRED series at up to 2,500 observations each is about four
// megabytes of history on every page load. The client reads five headline
// values from `series` and the last twenty-one points of three FX pairs, so the
// response carries a year of each series and says what it trimmed. The
// snapshot object itself is untouched: the models and the regime-correlation
// pass that read it internally still see every observation.
const SNAPSHOT_SERIES_HISTORY_POINTS = 260;

function trimSnapshotForResponse(snapshot) {
  if (!Array.isArray(snapshot?.series)) return snapshot;
  return {
    ...snapshot,
    series: snapshot.series.map((series) => {
      const history = series.history ?? [];
      if (history.length <= SNAPSHOT_SERIES_HISTORY_POINTS) return series;
      return {
        ...series,
        history: history.slice(-SNAPSHOT_SERIES_HISTORY_POINTS),
        historyTruncated: { kept: SNAPSHOT_SERIES_HISTORY_POINTS, total: history.length },
      };
    }),
    seriesHistoryNote: `Series histories are trimmed to their most recent ${SNAPSHOT_SERIES_HISTORY_POINTS} observations for transport; the models run on the full history server-side.`,
  };
}

app.get('/api/macro/liquidity', async (_request, response, next) => {
  try {
    response.json(trimSnapshotForResponse(await getLiquiditySnapshot()));
  } catch (error) {
    next(error);
  }
});

/**
 * The cross-model layer alone. The liquidity snapshot carries around thirty
 * models with their full histories in one object, which is a heavy payload for
 * what is now the section's landing view — the overview needs a small fraction
 * of it and nothing else on the page needs the rest to render.
 */
app.get('/api/macro/consensus', async (_request, response, next) => {
  try {
    const snapshot = await getLiquiditySnapshot();
    response.json({
      asOf: snapshot.asOf,
      consensus: snapshot.consensus ?? null,
      consensusHistory: snapshot.consensusHistory ?? null,
      macroAlerts: snapshot.macroAlerts ?? null,
      modelCorrelation: snapshot.modelCorrelation ?? null,
      weightOverlap: snapshot.weightOverlap ?? null,
      // Named so a caller can tell an unavailable model from one this endpoint
      // simply does not carry.
      omitted: 'Model histories, series observations and the individual macro models are served by /api/macro/liquidity.',
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/equities/catalog', async (_request, response, next) => {
  try {
    let coverage = [];
    let coverageAvailable = false;
    if (isDatabaseConfigured()) {
      try {
        coverage = await getStoredSeriesCoverage(getAllEquityHistorySymbols());
        coverageAvailable = true;
      } catch {
        coverageAvailable = false;
      }
    }
    response.json({
      version: 'equity-coverage-v1',
      asOf: new Date().toISOString(),
      provider: 'Twelve Data',
      storage: { configured: isDatabaseConfigured(), available: coverageAvailable },
      methodology: 'US-listed ETFs are explicitly labeled as investable proxies; they are not presented as exact local index levels.',
      indices: attachSeriesCoverage(indexCatalog, coverage),
      sectors: attachSeriesCoverage(sectorCatalog, coverage),
      subsectors: attachSeriesCoverage(subsectorCatalog, coverage),
      requiredFeeds: {
        breadth: breadthRequirements,
        sentiment: sentimentRequirements,
        positioning: positioningRequirements,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/equities/dashboard/:symbol', async (request, response, next) => {
  try {
    response.json(await getEquityDashboard(request.params.symbol));
  } catch (error) {
    // Same as the history route: the shared classifier owns this condition now.
    next(error);
  }
});

app.get('/api/equities/sectors', async (_request, response, next) => {
  try {
    response.json(await getSectorDashboard());
  } catch (error) {
    next(error);
  }
});

app.get('/api/ingestion/status', async (_request, response, next) => {
  try {
    const database = await getDatabaseHealth();
    response.json({ database, jobs: database.migrated ? await getIngestionStatus() : [] });
  } catch (error) {
    next(error);
  }
});

app.use('/api', (_request, response) => {
  response.status(404).json({ error: 'API endpoint not found.' });
});

if (existsSync(distDirectory)) {
  // Bundle filenames carry a content hash, so they can be cached forever; the
  // document that names them must be revalidated or a deploy leaves clients
  // asking for assets that no longer exist.
  app.use(express.static(distDirectory, {
    setHeaders: (response, filePath) => {
      response.setHeader('Cache-Control', filePath.startsWith(distAssetsPrefix) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  }));
  app.get('/{*path}', (_request, response) => response.sendFile(distIndexFile, { headers: { 'Cache-Control': 'no-cache' } }));
}

/**
 * Classifies a failure before answering.
 *
 * Every error used to be answered 502 "unable to fetch data from an upstream
 * provider". A body over the size limit, a symbol this deployment does not
 * track, and a TypeError in a route handler are none of them an upstream
 * problem, and telling a caller otherwise sends them to look in the wrong
 * place — including whoever is debugging the server.
 */
function classifyRequestError(error) {
  if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
    return { status: 400, body: { error: 'Request body is not valid JSON.', kind: 'bad-request' } };
  }
  // Express and body-parser set these on their own errors: 413 for a body over
  // the limit, 400 for a malformed one.
  const declared = Number(error?.status ?? error?.statusCode);
  if (Number.isFinite(declared) && declared >= 400 && declared < 500) {
    return { status: declared, body: { error: error.message ?? 'The request could not be accepted.', kind: 'bad-request' } };
  }
  // A request for something this deployment does not track is the caller asking
  // for the wrong thing, not a provider being down.
  if (/^Unsupported /.test(error?.message ?? '')) {
    return { status: 404, body: { error: error.message, kind: 'not-supported' } };
  }
  // A programming fault must not be dressed as a provider outage.
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError) {
    return { status: 500, body: { error: 'The server failed to build this response.', kind: 'server-error' } };
  }
  return { status: 502, body: { error: 'Unable to fetch data from an upstream provider.', kind: 'upstream' } };
}

app.use((error, request, response, _next) => {
  const { status, body } = classifyRequestError(error);
  // A 4xx is the caller's business and does not belong in the server log.
  if (status >= 500) {
    logger.error('Request failed', { method: request.method, path: request.path, status, kind: body.kind, error });
  }
  response.status(status).json(body);
});

export { classifyRequestError };

export { app };

// Importing this module â€” the API tests do â€” must not bind a port or start
// ingestion; only running it as a program should.
const startedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (startedDirectly) {
  // This platform fans out to a dozen keyless public providers, several of
  // which the README already documents as intermittently 403ing. A background
  // rejection that slips past a request handler must be logged and survived,
  // not answered by terminating every in-flight request on the box.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection (server continuing)', reason instanceof Error ? { error: reason } : { reason: String(reason) });
  });

  const server = app.listen(config.port, config.host, () => {
    logger.info('TradeGate API listening', { url: `http://${config.host}:${config.port}` });
  });
  const stopIngestion = startIngestionScheduler();
  let shutdownStarted = false;

  const shutdown = async () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    await stopIngestion();
    rateLimiter.stop();
    await new Promise((resolve) => server.close(resolve));
    await closeDatabase();
    process.exitCode = 0;
  };

  const requestShutdown = () => {
    void shutdown().catch((error) => {
      logger.error('Graceful shutdown failed', { error });
      process.exitCode = 1;
    });
  };

  process.on('SIGTERM', requestShutdown);
  process.on('SIGINT', requestShutdown);
}
