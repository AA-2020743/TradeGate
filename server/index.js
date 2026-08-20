import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.js';
import { getLiquiditySnapshot, getMarketHistory, getMarketSnapshot, getProviderHealth } from './providers.js';

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

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok', asOf: new Date().toISOString(), providers: getProviderHealth() });
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

app.get('/api/macro/liquidity', async (_request, response, next) => {
  try {
    response.json(await getLiquiditySnapshot());
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

app.listen(config.port, config.host, () => {
  console.log(`TradeGate API listening on http://${config.host}:${config.port}`);
});
