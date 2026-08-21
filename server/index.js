import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.js';
import { closeDatabase, getDatabaseHealth, getIngestionStatus, getRecentModelAlerts, getStoredSeriesCoverage, isDatabaseConfigured } from './database.js';
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
import { getBitcoinCycleWorkspace, getCryptoGlobal, getDxyBitcoinRelationship, getEquityRiskAppetite, getEquityScreener, getEthereumRotation, getFxWorkspace, getIntradayRotation, getLiquiditySnapshot, getMarketHeatmap, getMarketHistory, getMarketPositioning, getMarketSnapshot, getMetalsWorkspace, getNewsWire, getProviderHealth, getRegimeCorrelations, getSentimentSnapshot, getTechnicalSnapshot } from './providers.js';

const app = express();
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDirectory = path.join(rootDirectory, 'dist');
const apiRateLimits = new Map();

app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use((_request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use('/api', (request, response, next) => {
  const now = Date.now();
  const key = request.ip;
  const current = apiRateLimits.get(key);
  const entry = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + 60_000 }
    : current;
  entry.count += 1;
  apiRateLimits.set(key, entry);
  response.setHeader('RateLimit-Limit', '120');
  response.setHeader('RateLimit-Remaining', String(Math.max(0, 120 - entry.count)));
  response.setHeader('RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

  if (entry.count > 120) {
    response.status(429).json({ error: 'API rate limit exceeded. Try again shortly.' });
    return;
  }
  next();
});

const rateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of apiRateLimits) {
    if (entry.resetAt <= now) apiRateLimits.delete(key);
  }
}, 60_000);
rateLimitCleanup.unref();

app.get('/api/health', async (_request, response) => {
  const database = await getDatabaseHealth();
  const databaseDegraded = database.configured && (!database.connected || !database.migrated);
  response.json({ status: databaseDegraded ? 'degraded' : 'ok', asOf: new Date().toISOString(), providers: { ...getProviderHealth(), database } });
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
    response.json(await getDxyBitcoinRelationship());
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
    const [workspace, ethRotation, cryptoGlobal, intraday] = await Promise.all([
      getBitcoinCycleWorkspace(),
      getEthereumRotation().catch(() => null),
      getCryptoGlobal().catch(() => null),
      getIntradayRotation().catch(() => null),
    ]);
    response.json({ ...workspace, ethRotation, cryptoGlobal, intraday });
  } catch (error) {
    next(error);
  }
});

app.get('/api/analytics/screener', async (_request, response, next) => {
  try {
    response.json(await getEquityScreener());
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
  app.use(express.static(distDirectory));
  app.get('/{*path}', (_request, response) => response.sendFile(path.join(distDirectory, 'index.html')));
}

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(502).json({ error: 'Unable to fetch data from an upstream provider.' });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`TradeGate API listening on http://${config.host}:${config.port}`);
});
const stopIngestion = startIngestionScheduler();
let shutdownStarted = false;

async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  await stopIngestion();
  await new Promise((resolve) => server.close(resolve));
  await closeDatabase();
  process.exitCode = 0;
}

function requestShutdown() {
  void shutdown().catch((error) => {
    console.error('Graceful shutdown failed:', error);
    process.exitCode = 1;
  });
}

process.on('SIGTERM', requestShutdown);
process.on('SIGINT', requestShutdown);
