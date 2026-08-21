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

Technical scores are calculated by `technical-v1` from provider history. The US liquidity regime is calculated by `us-liquidity-v1`; `global-liquidity-v1` aggregates US net liquidity with ECB, BoJ, and PBoC (BIS) balance sheets in USD; `regime-correlation-v1` calculates the cross-market relationship map; `usd-strength-v1` and `macro-regime-v1` use additional FRED market and financial-condition histories. UI sections explicitly identify the remaining model previews.

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
curl http://127.0.0.1:8787/api/equities/dashboard/SPY
curl http://127.0.0.1:8787/api/equities/sectors
curl http://127.0.0.1:8787/api/ingestion/status
```

## Provider Keys

Create `.env` from `.env.example` and set the server-side keys:

```dotenv
HOST=127.0.0.1
PORT=8787
TWELVE_DATA_API_KEY=your_twelve_data_key
TWELVE_MINUTE_CREDIT_LIMIT=8
TWELVE_DAILY_CREDIT_LIMIT=760
TWELVE_MAX_INTERACTIVE_WAIT_MS=10000
TWELVE_QUOTE_REFRESH_MS=900000
FRED_API_KEY=your_fred_key
DATABASE_URL=postgresql://tradegate_app:password@127.0.0.1:5432/tradegate
DATABASE_SSL=false
INGESTION_ENABLED=true
MARKET_REFRESH_MS=900000
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

The migration creates raw series, current observations, revision history, ingestion runs, versioned model outputs, and the provider-credit ledger. `ingest:once` backfills one year of supported market history and available FRED history. Scheduled ingestion starts only when both `DATABASE_URL` and `INGESTION_ENABLED=true` are configured.

Default ingestion intervals are:

| Job | Interval |
| --- | --- |
| Current market snapshot | 15 minutes |
| FRED macro and liquidity | 6 hours |
| One-year market and core equity history refresh | 24 hours |

The Twelve Data limiter allows at most eight credits in a rolling minute and 760 credits per UTC day by default. When scheduled ingestion is enabled, interactive requests can use at most 140 of those credits so they cannot consume the backfill allocation. Set `TWELVE_INTERACTIVE_DAILY_LIMIT` explicitly to override that allocation; `0` disables interactive provider calls. PostgreSQL records daily reservations across service restarts; installations without PostgreSQL use the same limits in memory. A six-symbol quote batch is treated as six credits, not one request, and interactive requests fail fast when rolling-minute capacity would exceed the proxy timeout. A completed daily history backfill is not repeated after a same-day service restart. Confirm the exact quotas and licensing terms on your provider account before changing these limits.

The core equity backfill covers priority global-index proxies and the 11 U.S. sector ETFs. Less-liquid secondary index and subsector proxies remain queryable but are not scheduled by default. Every proxy is labeled; the application does not substitute an ETF price while presenting it as an exact local index level.

The Equities workspace reads stored histories only. Selecting an index never triggers an on-demand provider request; Twelve Data access remains serialized inside scheduled ingestion to protect free-plan quotas.

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

The output is Expansion above `+0.15`, Contraction below `-0.15`, and Neutral between those thresholds.

### `global-liquidity-v1`

The global liquidity model aggregates central-bank balance sheets converted to US dollars:

| Driver | Weight |
| --- | ---: |
| Global central-bank impulse (pooled USD total, 13-week change) | 30% |
| US M2 growth | 20% |
| ECB + BoJ combined impulse | 15% |
| PBoC impulse (when BIS history is available) | 15% |
| Inverse broad-dollar 13-week change | 20% |

Unit conversions use FRED H.10 rates matched to each observation date (`DEXUSEU`, `DEXJPUS`, `DEXCHUS`, maximum 35-day gap): the US leg is net liquidity (Fed assets minus TGA minus reverse repo) in USD millions; ECB assets are EUR millions multiplied by USD/EUR; BoJ assets are reported in units of 100 million yen and are divided by the yen rate after scaling; PBoC assets arrive in CNY billions from BIS `WS_CBTA` (via DBnomics, series `M.CN.B.XDC.CNY.N`) and are divided by the yuan rate after scaling. The pool is summed with gap-tolerant alignment so monthly legs no longer create partial-sum artifacts. The pooled history is published in USD millions with a cycle percentile, per-region shares, and 91/365-day changes. The same Expansion/Contraction thresholds as `us-liquidity-v1` apply.

PBoC data carries a structural publication lag (BIS splices national submissions); observations older than roughly 18 months are treated as stale and excluded, and within that window the leg is labeled with its source and lag in the UI. When PBoC history is insufficient the remaining drivers renormalize and the model stays publishable. Documented exclusions: Bank of England assets were discontinued on FRED in 2014, and all broad-money series (OECD MEI M2/M3, IMF IFS) are frozen at stale dates, so none are used.

### `regime-correlation-v1`

The relationship map aligns stored FRED series with stored market histories by calendar date and correlates **daily changes** (not log returns, so weekly levels such as NFCI remain valid) over 20-day, 60-day, and one-year windows. Designed pairs: credit spreads/equities, VIX/equities, broad dollar/BTC, financial conditions/equities, real yields/gold proxy, and broad dollar/gold proxy. A pair publishes only when both legs have at least 22 aligned observations; missing pairs are listed explicitly. Asset-sensitivity labels derive from absolute-correlation thresholds of 0.25 and 0.50.

### Liquidity narrative

The narrative panel compares the two most recent persisted outputs of `us-liquidity` and `global-liquidity` from `model_outputs`. It reports score moves of one point or more, regime shifts, and pooled-liquidity level changes of 0.05% or more. With fewer than two persisted runs it stays explicitly pending.

### `cross-market-correlation-v1`

DXY/BTC uses aligned daily log returns rather than price levels. It calculates 20-day, 60-day, and one-year Pearson correlations, momentum alignment, and a 20-session dollar breakout state. Twelve Data DXY is preferred; FRED's broad-dollar index is explicitly labeled as a proxy when used.

### `usd-strength-v1`

USD strength combines FRED's broad trade-weighted dollar trend and momentum with 10-year real-yield impulse, 2-year Treasury impulse, VIX/NFCI dollar-smile stress, and inverse dollar-liquidity pressure. It is marked provisional below 75% driver coverage. DTWEXBGS is always identified as a broad-dollar proxy and is never displayed as the ICE DXY level.

### `macro-regime-v1`

The macro regime combines US liquidity, global liquidity, Chicago Fed financial conditions, US high-yield spreads, VIX, and inverse dollar pressure (weights 25/15/20/18/12/10). It changes risk budget, alert threshold, preferred factor emphasis, and expected holding period by regime. At least two independent sleeves and 40% coverage are required; full calculated status requires 75% coverage. A stress regime requires simultaneous VIX, credit-spread, and financial-condition confirmation.

FRED histories are ingested with up to 2,500 observations per series, so weekly balance-sheet and rate series reach back well beyond five years in the liquidity inspector's `All` range; daily series remain bounded by FRED's own history (for example the broad dollar starts in 2006).

### Equity calculation engines

`equity-regime-v1` dynamically changes factor weights, alert thresholds, and expected holding periods. It requires price trend, momentum, and volatility, and remains provisional below 75% driver coverage. `equity-top-risk-v1` and `equity-bottom-signal-v1` require both technical and constituent-breadth confirmation and do not publish from price and liquidity alone.

`equity-breadth-v1` calculates advance/decline participation, McClellan measures, moving-average participation, new highs/lows, and breadth thrusts from constituent histories. `sector-rotation-v1` ranks aligned 20- and 60-session performance relative to SPY together with `technical-v1` across all 11 sectors and 19 subsector ETF proxies; ranks are global across the tracked universe. Missing constituent, volume, flow, sentiment, positioning, or credit inputs remain explicitly unavailable.

The sector dashboard also publishes a calculated macro-sensitivity matrix: for every sector and subsector ETF it correlates 60-day daily changes against stored FRED broad-dollar, 10-year real-yield, VIX, and high-yield-spread histories. Volume, valuation, positioning, and ETF flows are not inferred from price data and remain labeled unavailable until a licensed source is connected.

## Reliability Rules

- Missing provider data returns unavailable; it is never silently replaced with a sample value.
- FRED works with or without an API key: the authenticated observations API is preferred, and without a key the public `fredgraph.csv` endpoint supplies full-history CSV per series. H.10 FX and broad-dollar series allow a 10-day observation age to absorb the Fed's Monday release cadence.
- PostgreSQL provides last-known-good history when an upstream provider fails.
- Stored fallbacks retain their original provider timestamp and source label.
- Successful provider responses are also freshness-checked; stale observations remain labeled and may be retained as raw history, but are excluded from current models.
- Partial quote refreshes retain missing last-known-good assets as explicitly stale cache fallbacks.
- FRED revisions are preserved in `observation_revisions` rather than overwritten without an audit trail.
- Ingestion runs record status, write count, provider errors, and completion time.
- Model outputs store their version, effective date, JSON output, and input-series lineage.
- Remaining preview modules are visibly labeled at the navigation, tab, and individual-section level until their real input sets and calculation tests exist.
- Calculated sections show their model version or coverage status instead of a Preview badge.

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
