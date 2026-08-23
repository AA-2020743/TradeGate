import express from 'express';
import { existsSync } from 'node:fs';
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
import { startIngestionScheduler } from './ingestion.js';
import { createRateLimiter } from './rateLimit.js';
import { getBitcoinCycleWorkspace, getBlockedSources, calculateDollarTransmission, getCryptoGlobal, getDxyBitcoinRelationship, getEquityRiskAppetite, getEquityScreener, getEthereumRotation, getFxWorkspace, getIntradayRotation, getLiquiditySnapshot, getMarketHeatmap, getMarketHistory, getMarketPositioning, getMarketSnapshot, getMetalsWorkspace, getNewsWire, getProviderHealth, getRegimeCorrelations, getSentimentSnapshot, getStablecoinLeadLag, getTechnicalSnapshot } from './providers.js';
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
app.use('/api', (_request, response, next) => {
  // Market data must never come back from a heuristic browser cache. no-cache
  // still permits a conditional revalidation rather than forbidding storage.
  response.setHeader('Cache-Control', 'no-cache');
  next();
});
app.use('/api', rateLimiter.middleware);

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
    if (error.message.startsWith('Unsupported history symbol')) {
      response.status(400).json({ error: error.message });
      return;
    }
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
        console.error('Screener persistence failed:', persistenceError.message);
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

app.get('/api/macro/liquidity', async (_request, response, next) => {
  try {
    response.json(await getLiquiditySnapshot());
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
    if (error.message.startsWith('Unsupported equity index proxy')) {
      response.status(400).json({ error: error.message });
      return;
    }
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

app.use((error, _request, response, _next) => {
  if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
    response.status(400).json({ error: 'Request body is not valid JSON.' });
    return;
  }
  console.error(error);
  response.status(502).json({ error: 'Unable to fetch data from an upstream provider.' });
});

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
    console.error('Unhandled rejection (server continuing):', reason instanceof Error ? reason.stack ?? reason.message : reason);
  });

  const server = app.listen(config.port, config.host, () => {
    console.log(`TradeGate API listening on http://${config.host}:${config.port}`);
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
      console.error('Graceful shutdown failed:', error);
      process.exitCode = 1;
    });
  };

  process.on('SIGTERM', requestShutdown);
  process.on('SIGINT', requestShutdown);
}
