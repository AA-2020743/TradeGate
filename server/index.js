import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.js';
import { getLiquiditySnapshot, getMarketSnapshot, getProviderHealth } from './providers.js';

const app = express();
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDirectory = path.join(rootDirectory, 'dist');

app.disable('x-powered-by');

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

app.get('/api/macro/liquidity', async (_request, response, next) => {
  try {
    response.json(await getLiquiditySnapshot());
  } catch (error) {
    next(error);
  }
});

if (existsSync(distDirectory)) {
  app.use(express.static(distDirectory));
  app.get('/{*path}', (_request, response) => response.sendFile(path.join(distDirectory, 'index.html')));
}

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(502).json({ error: 'Unable to fetch data from an upstream provider.' });
});

app.listen(config.port, () => {
  console.log(`TradeGate API listening on http://localhost:${config.port}`);
});
