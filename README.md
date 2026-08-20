# TradeGate Research

TradeGate is an independent multi-asset research platform. It is not affiliated with Tradegate AG.

## Data Status

The application now has a server-side data layer. It never exposes provider credentials to the browser.

| Provider | Coverage | Credential |
| --- | --- | --- |
| CoinGecko | Bitcoin quote and history | None |
| Twelve Data | Equities, ETFs, FX, and market history | `TWELVE_DATA_API_KEY` |
| FRED | Official U.S. macro and liquidity observations | `FRED_API_KEY` |
| PostgreSQL | Observations, revisions, ingestion runs, and model lineage | `DATABASE_URL` |

Technical scores are calculated by `technical-v1` from provider history. The US liquidity regime is calculated by `us-liquidity-v1` from Fed net liquidity, M2 growth, and inverse dollar transmission. UI sections explicitly identify the remaining model previews.

## Local Development

Requirements: Node.js 22 or newer and npm.

```bash
git clone https://github.com/AA-2020743/TradeGate.git
cd TradeGate
npm install
cp .env.example .env
npm run dev
```

`npm run dev` starts both services:

- Web application: `http://localhost:5173`
- Data API: `http://127.0.0.1:8787`

Check the API:

```bash
curl http://127.0.0.1:8787/api/health
curl http://127.0.0.1:8787/api/markets/snapshot
curl "http://127.0.0.1:8787/api/markets/history/BTC?range=1M"
curl http://127.0.0.1:8787/api/analytics/technical/BTC
curl http://127.0.0.1:8787/api/analytics/dxy-btc
curl http://127.0.0.1:8787/api/equities/catalog
curl http://127.0.0.1:8787/api/ingestion/status
```

## Provider Keys

Create `.env` from `.env.example` and set the server-side keys:

```dotenv
HOST=127.0.0.1
PORT=8787
TWELVE_DATA_API_KEY=your_twelve_data_key
FRED_API_KEY=your_fred_key
DATABASE_URL=postgresql://tradegate_app:password@127.0.0.1:5432/tradegate
DATABASE_SSL=false
INGESTION_ENABLED=true
MARKET_REFRESH_MS=60000
MACRO_REFRESH_MS=21600000
HISTORY_REFRESH_MS=86400000
```

Never prefix these values with `VITE_`; doing so would expose them in the browser bundle. `.env` is ignored by Git.

- Twelve Data: create a key at `https://twelvedata.com/`.
- FRED: request a key at `https://fred.stlouisfed.org/docs/api/api_key.html`.

## Ubuntu VPS Deployment

The included examples assume Ubuntu, a domain such as `research.example.com`, and a dedicated `tradegate` service account.

### 1. Install packages

```bash
sudo apt update
sudo apt install -y git nginx curl postgresql
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

### 2. Create the service account and deploy

```bash
sudo useradd --system --create-home --shell /bin/bash tradegate
sudo -u tradegate git clone https://github.com/AA-2020743/TradeGate.git /home/tradegate/TradeGate
cd /home/tradegate/TradeGate
sudo -u tradegate npm ci
sudo -u tradegate cp .env.example .env
sudo -u tradegate nano .env
sudo -u tradegate npm run build
```

Create the database and application user:

```bash
sudo -u postgres psql
```

Run the following SQL inside `psql`, replacing the password:

```sql
CREATE USER tradegate_app WITH PASSWORD 'replace-with-a-long-password';
CREATE DATABASE tradegate OWNER tradegate_app;
\q
```

Set the real provider keys and `DATABASE_URL` in `.env`. Keep `HOST=127.0.0.1` so the Node process is accessible only through Nginx. URL-encode special characters in the database password.

Protect the environment file:

```bash
sudo -u tradegate chmod 600 /home/tradegate/TradeGate/.env
```

Apply migrations and run the first backfill:

```bash
cd /home/tradegate/TradeGate
sudo -u tradegate npm run db:migrate
sudo -u tradegate npm run ingest:once
```

The migration creates raw series, current observations, revision history, ingestion runs, and versioned model outputs. `ingest:once` backfills one year of supported market history and available FRED history. Scheduled ingestion starts only when both `DATABASE_URL` and `INGESTION_ENABLED=true` are configured.

Default ingestion intervals are:

| Job | Interval |
| --- | --- |
| Current market snapshot | 60 seconds |
| FRED macro and liquidity | 6 hours |
| One-year market and core equity history refresh | 24 hours |

Provider caches, scheduled intervals, and the serialized Twelve Data history backfill reduce the chance of exceeding free-plan limits. Confirm the exact quotas and licensing terms on your provider account.

The core equity backfill covers priority global-index proxies and the 11 U.S. sector ETFs. Less-liquid secondary index and subsector proxies remain queryable but are not scheduled by default. Every proxy is labeled; the application does not substitute an ETF price while presenting it as an exact local index level.

## Calculation Methodology

All calculated outputs include a version, effective date, observation count, source, and input lineage.

### `technical-v1`

The technical score uses one year of provider close history. It combines moving-average alignment, 20-session momentum, MACD, RSI, and 20-session annualized volatility. It requires at least 30 valid observations and returns no model when history is insufficient.

### `us-liquidity-v1`

The US liquidity model uses:

| Driver | Weight |
| --- | ---: |
| Fed net liquidity: Fed assets minus TGA minus reverse repo | 55% |
| US M2 13-week growth | 25% |
| Inverse broad-dollar 13-week change | 20% |

The output is Expansion above `+0.15`, Contraction below `-0.15`, and Neutral between those thresholds. This is a US foundation model, not yet the proposed full global-liquidity model.

### `cross-market-correlation-v1`

DXY/BTC uses aligned daily log returns rather than price levels. It calculates 20-day, 60-day, and one-year Pearson correlations, momentum alignment, and a 20-session dollar breakout state. Twelve Data DXY is preferred; FRED's broad-dollar index is explicitly labeled as a proxy when used.

### Equity calculation engines

`equity-regime-v1` dynamically changes factor weights, alert thresholds, and expected holding periods. It requires price trend, momentum, and volatility, and remains provisional below 75% driver coverage. `equity-top-risk-v1` and `equity-bottom-signal-v1` require both technical and constituent-breadth confirmation and do not publish from price and liquidity alone.

`equity-breadth-v1` calculates advance/decline participation, McClellan measures, moving-average participation, new highs/lows, and breadth thrusts from constituent histories. `sector-rotation-v1` ranks aligned 20- and 60-session performance relative to SPY together with `technical-v1`. Missing constituent, volume, flow, sentiment, positioning, or credit inputs remain explicitly unavailable.

## Reliability Rules

- Missing provider data returns unavailable; it is never silently replaced with a sample value.
- PostgreSQL provides last-known-good history when an upstream provider fails.
- Stored fallbacks retain their original provider timestamp and source label.
- FRED revisions are preserved in `observation_revisions` rather than overwritten without an audit trail.
- Ingestion runs record status, write count, provider errors, and completion time.
- Model outputs store their version, effective date, JSON output, and input-series lineage.
- Remaining preview modules are visibly labeled until their real input sets and calculation tests exist.

### 3. Install the systemd service

```bash
sudo cp deploy/tradegate.service /etc/systemd/system/tradegate.service
sudo systemctl daemon-reload
sudo systemctl enable --now tradegate
sudo systemctl status tradegate
curl http://127.0.0.1:8787/api/health
curl http://127.0.0.1:8787/api/ingestion/status
```

View server logs with:

```bash
sudo journalctl -u tradegate -f
```

Inspect ingestion health with:

```bash
curl http://127.0.0.1:8787/api/ingestion/status
```

### 4. Configure Nginx

Edit the domain in `deploy/nginx.conf`, then run:

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/tradegate
sudo ln -s /etc/nginx/sites-available/tradegate /etc/nginx/sites-enabled/tradegate
sudo nginx -t
sudo systemctl reload nginx
```

Point the domain's DNS A/AAAA record to the VPS before enabling TLS.

### 5. Enable HTTPS

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d research.example.com
```

Only ports 80 and 443 need to be public. Do not expose port 8787 through the VPS firewall.

## Updating Production

```bash
cd /home/tradegate/TradeGate
sudo -u tradegate git pull --ff-only
sudo -u tradegate npm ci
sudo -u tradegate npm run db:migrate
sudo -u tradegate npm run build
sudo systemctl restart tradegate
curl http://127.0.0.1:8787/api/health
```

## Production Commands

```bash
npm run build
npm start
```

The Express server serves both `/api/*` and the built React application from `dist/`.
