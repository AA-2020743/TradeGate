# TradeGate Research

TradeGate is an independent multi-asset research platform. It is not affiliated with Tradegate AG.

## Data Status

The application now has a server-side data layer. It never exposes provider credentials to the browser.

| Provider | Coverage | Credential |
| --- | --- | --- |
| CoinGecko | Bitcoin quote, history, and global aggregates | `COINGECKO_API_KEY` (optional) |
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

`.env.example` documents every supported environment variable (server binding, provider keys, Postgres persistence, and ingestion cadences); all are optional and the platform runs fully keyless without them. For containerized deployment, `docker build -t tradegate .` produces an image that serves the built frontend and API from a single process on port 8787.

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

Run the test suite with `npm test`; it covers the server calculation modules, the HTTP surface (`server/api.test.js` boots the exported Express app on an ephemeral port and asserts status codes, validation, security, cache, and rate-limit headers without touching a provider), and the browser-side refresh, routing, and sorting logic (`node --test server/*.test.js src/*.test.js`).

### Workspace routes

Every workspace is addressable from the URL hash, so a tab can be bookmarked, shared, or reloaded in place, and the browser's back and forward buttons walk the workspaces visited:

| Route | Workspace |
| --- | --- |
| `#/overview/NVDA` | Overview, focused on a tracked symbol (`NVDA`, `AAPL`, `GLD`, `BTC`) |
| `#/markets` · `#/equities` · `#/metals` | Multi-asset heatmap, equities research, metals |
| `#/screener` · `#/watchlists` | S&P 500 screener, watchlists |
| `#/macro` · `#/forex` · `#/crypto` | Macro, FX, and bitcoin-cycle research |

An unrecognized route or symbol falls back to the overview and rewrites the address bar rather than rendering an empty workspace.

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
API_RATE_LIMIT=120
API_RATE_WINDOW_MS=60000
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

The relationship map aligns stored FRED series with stored market histories by calendar date and correlates **daily changes** (not log returns, so weekly levels such as NFCI remain valid) over 20-day, 60-day, and one-year windows. Designed pairs: credit spreads/equities, VIX/equities, broad dollar/BTC, financial conditions/equities, real yields/gold proxy, and broad dollar/gold proxy. A pair publishes only when both legs have at least 22 aligned observations; missing pairs are listed explicitly. Each pair also reports **which side moves first**: its aligned daily changes are cross-correlated across a lag window of ten observations in both directions, ranked by absolute correlation so a genuinely inverse pair (broad dollar against bitcoin, real yields against gold) is not misread as a weak positive blip. A lead is claimed only when the peak beats the synchronous reading by 0.05, and the lag is converted to calendar days using the pair's own observation cadence, so a weekly series such as NFCI reports weeks rather than sessions. Pairs that peak at zero lag are reported as moving together, and `leadSignals` ranks whichever pairs do lead by the strength of the correlation at their peak lag. Asset-sensitivity labels derive from absolute-correlation thresholds of 0.25 and 0.50.

### Liquidity narrative

The narrative panel compares the two most recent persisted outputs of `us-liquidity` and `global-liquidity` from `model_outputs`. It reports score moves of one point or more, regime shifts, and pooled-liquidity level changes of 0.05% or more. With fewer than two persisted runs it stays explicitly pending.

### `cross-market-correlation-v1`

DXY/BTC uses aligned daily log returns rather than price levels. It calculates 20-day, 60-day, and one-year Pearson correlations, momentum alignment, and a 20-session dollar breakout state. It also runs the same lead-lag scan as the macro relationship map over those log returns, so the Crypto workspace states plainly whether the dollar moves first and by how many days, with the peak correlation shown against the zero-lag reading. Twelve Data DXY is preferred; FRED's broad-dollar index is explicitly labeled as a proxy when used.

### `dollar-scenarios-v1`

The USD scenario map scores each arm of the dollar smile from live inputs instead of describing them. The arms are separated by what is genuinely different about them rather than by direction alone — a stress bid and a carry bid both lift the dollar:

| Path | Evidence |
| --- | --- |
| Global stress (USD, CHF, JPY bid) | VIX level, high-yield spread level and its 91-day change, NFCI |
| Strong U.S. growth (USD carry strengthens) | 10Y real-yield and 2Y impulses, credit calm, 60-session U.S. equity leadership over EM |
| Weak global growth (USD defensive premium) | The same U.S. leadership, but requiring that neither rising yields nor a volatility panic is doing the work |

U.S. leadership is the 60-session return of EEM minus SPY from Yahoo closes; the FRED legs come from series the macro snapshot already loads. A path publishes only with at least two of its own calculated legs and lists the ones it is missing, so a blocked provider narrows the evidence rather than inventing it. Shares are each path's score over the calculated total, and a lead narrower than five points is reported as no dominant path rather than naming a winner by a rounding error.

### `usd-strength-v1`

USD strength combines FRED's broad trade-weighted dollar trend and momentum with 10-year real-yield impulse, 2-year Treasury impulse, VIX/NFCI dollar-smile stress, and inverse dollar-liquidity pressure. It is marked provisional below 75% driver coverage. DTWEXBGS is always identified as a broad-dollar proxy and is never displayed as the ICE DXY level.

### `macro-regime-v1`

The macro regime combines US liquidity, global liquidity, Chicago Fed financial conditions, US high-yield spreads, VIX, and inverse dollar pressure (weights 25/15/20/18/12/10). It changes risk budget, alert threshold, preferred factor emphasis, and expected holding period by regime. At least two independent sleeves and 40% coverage are required; full calculated status requires 75% coverage. A stress regime requires simultaneous VIX, credit-spread, and financial-condition confirmation. The model also publishes how far the score is from changing the label: the score bands live in a single classifier (`classifyMacroRegimeByScore`) and the distance is found by probing that same classifier, so the published regime and the distance-to-flip cannot drift apart. Both directions are reported, a call within three points of a boundary is marked borderline, and a confirmed panic publishes no proximity at all because it overrides the score bands entirely. A score one point inside its band is a materially different reading from one in the middle of it, and the label alone hides that.

FRED histories are ingested with up to 2,500 observations per series, so weekly balance-sheet and rate series reach back well beyond five years in the liquidity inspector's `All` range; daily series remain bounded by FRED's own history (for example the broad dollar starts in 2006).

### Equity calculation engines

`equity-regime-v1` dynamically changes factor weights, alert thresholds, and expected holding periods. It requires price trend, momentum, and volatility, and remains provisional below 75% driver coverage. `equity-top-risk-v1` and `equity-bottom-signal-v1` require both technical and constituent-breadth confirmation and do not publish from price and liquidity alone.

`equity-breadth-v1` calculates advance/decline participation, McClellan measures, moving-average participation, new highs/lows, and breadth thrusts from constituent histories. The live constituent path additionally asks whether participation **confirms** the index: an advance/decline line is accumulated over the last 60 sessions from the same constituent closes already loaded, and both it and SPY are percentile-ranked inside that window. An index at the top of its range while the advance/decline line sits at least 20 percentile points lower is reported as a negative divergence — a rally being carried by fewer names — and the mirror case at the bottom of the range as a positive divergence. Percentile ranks are used rather than pivot detection, which is fragile on noisy daily data and can miss or invent a peak depending on where the window starts. A mid-range index is reported as carrying no divergence message rather than being forced into one, and fewer than 40 aligned sessions withholds the reading. `sector-rotation-v1` ranks aligned 20- and 60-session performance relative to SPY together with `technical-v1` across all 11 sectors and 19 subsector ETF proxies; ranks are global across the tracked universe. The relative-rotation quadrant reads the 60-session excess return as how strong a sector already is against the benchmark and the 20-session one as whether that strength is currently building, giving the standard Leading / Weakening / Lagging / Improving placement. Each row is additionally placed where it sat 20 sessions earlier, so a sector rotating **into** leadership is distinguishable from one rolling **out** of it — the static quadrant alone cannot tell those apart — and the workspace names which sectors crossed in each direction. The shift is the change in 20-session excess return over that window; a row without 20 sessions of history beyond the 60-session lookback reports no trajectory rather than a guessed one. Missing constituent, volume, flow, sentiment, positioning, or credit inputs remain explicitly unavailable.

The sector dashboard also publishes a calculated macro-sensitivity matrix: for every sector and subsector ETF it correlates 60-day daily changes against stored FRED broad-dollar, 10-year real-yield, VIX, and high-yield-spread histories. Volume, valuation, positioning, and ETF flows are not inferred from price data and remain labeled unavailable until a licensed source is connected.

### Multi-asset heatmap

`market-heatmap-v1` scores a 19-asset universe (crypto, US/European/Asian/LatAm index ETFs, EM, metals) with `technical-v1` on stored close histories. Alignment is the absolute 60-day change correlation versus SPY; crowding reuses CFTC COT three-year percentiles where a matching contract exists (SPY/QQQ/gold complex); the summary cards add universe-average score with a risk-on/neutral/stress distribution, peak crowding percentile, and the global liquidity backdrop. Cells without sufficient history stay explicitly unavailable. `heatmap-risk-v1` then names the universe's weakest link from those same measurements instead of the fixed claim that panel used to carry. Positioning at or above the 80th COT percentile is flagged as **crowded and turning** when the technical score has fallen to 45 or below, and as **crowded consensus** when the score is still 60 or above — a trade that is crowded and working is a different risk from one that is crowded and rolling over. A market scoring 35 or below while holding at least 0.6 absolute correlation to SPY is flagged as **transmitting stress**, since weakness that still moves with the complex rarely stays contained, and **broad stress** is raised against the universe when at least 40% of it scores at or below 35. Concerns are ranked by severity with the evidence behind each one; markets with no COT contract contribute no positioning concern rather than an assumed one, and a universe with nothing flagged says so.

Market close histories work without any API key: Twelve Data is preferred when configured, and otherwise Yahoo Finance's public chart endpoint supplies one year of daily closes (BTC continues to use CoinGecko). Source labels reflect whichever provider served the response.

### FX workspace

`fx-workspace-v1` covers six currencies (EUR, JPY, GBP, CAD, AUD, CHF). Currency strength uses Yahoo FX crosses oriented so positive momentum always means currency strength; each pair carries a `technical-v1` score plus CFTC COT net-speculative percentile from verified contract codes (099741 EUR, 097741 JPY, 096742 GBP, 090741 CAD, 232741 AUD, 092741 CHF). Commodity links correlate 60-day daily changes (CAD/WTI, AUD/copper, AUD/gold, CHF/S&P 500) and additionally report which side of each link moves first, using the same lead-lag scan as the macro relationship map, so a currency that follows its commodity is distinguishable from one that leads it. Rotation signals compare 20-session momenta by sign: commodity-FX versus crude, broad USD versus EEM, and yen versus S&P 500. The USD scenario map is now calculated by `dollar-scenarios-v1` rather than asserted.

The metals COT panel also publishes the disaggregated report (dataset `72hh-3qpy`): three-year percentile ranks of net managed-money, producer/merchant, and swap-dealer gold positions with weekly changes, alongside the legacy net-non-commercial percentile. The FX positioning panel additionally carries the ICE US Dollar Index futures contract (`098662`) so USD speculative crowding sits beside the six currency pairs.

The Macro tab keeps only macro-connected USD content (the FRED-driven USD strength engine and the qualitative scenario map). Dedicated **Forex** and **Crypto** tabs carry the market-facing workspaces: Forex hosts currency momentum versus the dollar, CFTC net speculative exposure (six pairs plus the ICE Dollar Index), commodity links, and rotation signals; Crypto hosts the DXY/BTC correlation study, the `bitcoin-cycle-v1` crowding panel, an `eth-rotation-v1` leg (ETH versus its 200-day average plus a BTC/ETH ratio percentile for large-cap rotation), a `crypto-global-v1` panel (total market capitalization, 24-hour change, and BTC/ETH dominance from CoinGecko), which now also publishes `crypto-rotation-v1`: bitcoin's 24-hour change minus the whole complex's, read against whether the market rose or fell. Dominance on its own is a level, not a direction — it rises both when bitcoin leads a rally and when altcoins are sold harder in a decline, and those are opposite tapes — so the regime comes from the performance spread paired with the market's direction, giving a bitcoin-led advance, an altcoin-led advance, a flight to bitcoin, or a bitcoin-led decline. A spread inside 0.25 points is reported as a broad move rather than a rotation, and dominance levels are carried for context without deciding the call, an `intraday-rotation-v1` lead/lag scan (BTC/ETH/SOL bar returns cross-correlated across ±4 bars to detect whether altcoins follow or lead bitcoin, switchable between a five-day 30-minute and a one-day 5-minute window), and a dollar-transmission favorability read that combines broad-dollar momentum and level with the measured DXY/BTC link to label bitcoin's dollar backdrop as tailwind, headwind, or neutral. The Macro liquidity snapshot also carries a `stablecoin-issuance-v1` cross-check: aggregate stablecoin supply and its 30-day growth from DefiLlama, read as a real-time dollar-liquidity proxy alongside the central-bank drivers.

The **Screener** tab is fully calculated (`screener-v1`): every S&P 500 constituent from the Wikipedia list is scored from Yahoo batch spark one-year closes on 20/60-session momentum, distance above the 200-day average, 20-day annualized volatility, RSI-14, and fresh 200-day breakouts, with the same momentum windows also expressed as excess return versus SPY. The composite score cross-sectionally ranks momentum (45%), trend position (35%), and inverse volatility (20%), and the response carries index breadth (share of names within 5% of their 52-week high, above their 50-day average, and riding a persistent 90-session trend). Each row also carries a trend-quality reading: an ordinary least-squares fit through the last 90 log closes yields an annualized slope (the fitted daily drift compounded over 252 sessions) and an R-squared, and the published quality figure multiplies the two so that a steep advance the price never respects ranks below a shallower one it tracks closely; that figure is additionally expressed as a cross-sectional percentile (`qualityRank`). Client-side presets cover momentum leaders, uptrend pullbacks, low-volatility uptrends, breakouts, oversold names, names within 5% of their 52-week high (distance computed from the trailing 252-session peak), and the quality-trend screens that isolate well-fitted advances and well-fitted declines (R-squared of at least 0.5), with symbol search, click-to-sort table headers (natural direction, reverse, then back to the screen's own ordering, with rows missing that metric always sinking rather than ranking as zero), and any screen exporting its full match list to CSV (including each name's rank and pool size within its GICS sector by composite score). The same Wikipedia table supplies GICS sector attribution, so the screener also publishes a sector-leadership aggregation: each sector's share of 20-session advancers, average momentum, and its single strongest name. When PostgreSQL is configured, each fresh screener computation also persists its 200-day-breakout roster (`model_outputs`, model id `screener-v1`) and raises a `model_alerts` entry for every symbol newly clearing its 200-day average since the previous run, so the Macro alerts panel surfaces breakout transitions alongside workspace vitals shifts.

The **Watchlists** tab is a local workspace: named lists persist in browser localStorage and each row pulls live market history plus the `technical-v1` snapshot for its symbol, so every tracked name shows a real trend sparkline, latest price, three-month change, and technical score. When PostgreSQL is configured, lists additionally mirror to the server (`GET`/`PUT /api/watchlists`, migration `005`) with localStorage kept as source of truth, so a fresh browser adopts stored lists. No designed or fabricated workspaces remain; the only preview-labeled panels are those whose sources are confirmed blocked (spot ETF flows, CBOE dealer gamma, metals physical/cost data).

`bitcoin-cycle-v1` assembles seven crowding legs: 200-day/200-week trend regime (Yahoo BTC-USD), MVRV Z-score and short-term-holder realized price (bitcoin-data.com), aggregate Binance+Bybit funding with a history percentile, a 7-day open-interest-versus-price quadrant, aggregate stablecoin supply change (DefiLlama), and spot ETF flows, which remain unavailable without a licensed source. Same-host calls are serialized and last-known-good values are memoized because bitcoin-data.com rate-limits aggressively.

`bitcoin-cycle-phase-v1` then places bitcoin in its cycle from those same legs, which the workspace had previously published side by side without ever answering the question the page asks. Four phases each score their own evidence 0-100: capitulation reads deep drawdown, a negative MVRV Z-score, price under the 200-week average and recent buyers underwater; early recovery reads a drawdown around 30%, a Z-score near 1, price just above the 200-week average and expanding stablecoin supply; expansion reads a shallow drawdown, a mid-cycle Z-score, price above the 200-day average and funding that is not yet stretched; euphoria reads a Z-score beyond 3, price at the highs, and both funding and realized volatility in their upper percentiles. A phase needs at least two of its own calculated legs to appear and reports its coverage and what it is missing, and a lead narrower than five points is published as genuinely ambiguous rather than resolved.

`equity-risk-v1` publishes S&P 500 breadth (% of constituents above 200-day and 50-day averages from Wikipedia's constituent list plus Yahoo batch spark closes), RSP/SPY equal-weight participation slope, FRED high-yield OAS with a 20-observation change, an equity-risk-premium proxy (trailing earnings yield from multpl.com minus the 10-year TIPS real yield), and 3-month relative strength for all 11 sector SPDRs versus SPY. A CNN Fear & Greed snapshot card sits alongside CFTC positioning on the equities tab.

The home news card aggregates live RSS wires (`news-wire-v1`): Federal Reserve press releases, CNBC top news, and MarketWatch top stories, sorted newest first. Every headline is keyword-classified as positive, negative, or neutral through a transparent lexicon, with wire-wide tone counts on the card. Constituent breadth (`spx-constituent-breadth-v1`) feeds the index-level top-risk and bottom-detection models directly, with the live provider technical snapshot as fallback when stored histories are absent, so those signals publish without a database. The last remaining previews are source-blocked: spot ETF flows (Farside is Cloudflare-blocked), metals ETF holdings/physical premia/producer cost curves, and dealer-gamma options positioning (CBOE is Akamai-blocked).

`equity-risk-v1` also carries a VIX term-structure leg (spot VIX divided by VIX3M from Yahoo index histories, percentile-ranked over six months) and a 10Y-2Y Treasury-curve leg (FRED T10Y2Y with a 20-observation change), for seven calculated legs in total. The metals workspace publishes gold/silver and gold/copper cross-ratios with one-year percentiles. `metals-cost-structure-v1` replaces what had been a hardcoded cost panel: WTI crude and natural gas carry their level, 20-session change, and one-year percentile as the fast-moving input costs, and the GDX/GLD ratio serves as the market's own running verdict on whether the metal price is outpacing the cost of producing it — the only margin read available without company filings. All-in sustaining cost stays explicitly unavailable and names the feed it needs rather than being approximated into a number that would look reported. The physical-versus-paper panel likewise names the licensed or filings-based source each row requires instead of showing readings nobody measured.

With PostgreSQL configured, the scheduled `research-workspaces` ingestion job persists the heatmap, metals, FX, sentiment, bitcoin-cycle, equity-risk, `liquidity-states`, and `dollar-transmission` workspaces as versioned model outputs on the macro cadence. The liquidity-states entry is a compact derived snapshot of the regime calls — US net-liquidity regime, global liquidity regime and momentum, and the stablecoin supply state with its 30-day growth — so transitions such as Expansion→Contraction or Flat→Expanding raise alerts like any other vital. The dollar-transmission entry is calculated once server-side and rendered by the Crypto tab, so the browser and the persisted alerts cannot disagree. It applies broad-dollar momentum and level **through the measured DXY/BTC correlation rather than an assumed one**: a falling dollar reads as a tailwind only while the link is inverse, the identical move reads as a headwind under a positive link, and inside a ±0.2 correlation band the dollar transmits nothing and the model says so instead of naming a direction. Flips between Dollar tailwind, Neutral dollar, Dollar headwind, and Link too weak to transmit are alerted with the same machinery. The liquidity narrative then merges `buildWorkspaceNarrative` change detection over those stored outputs, so the Macro tab narrates movements in Fear & Greed, breadth, high-yield OAS, MVRV-Z, funding, COT percentiles, cross-ratios, liquidity regimes, and bitcoin's dollar backdrop between runs. The same detection runs at ingestion time: any detected vitals shift is written to a `model_alerts` table (migration `004`) and served from `/api/alerts`, giving a persisted alert history rather than only an ephemeral narrative. Both the alert history and the news wire are also published as Atom feeds (`/api/alerts/feed` and `/api/news/feed`, `application/atom+xml`), so model alerts and headline tones can be subscribed from any feed reader or automation tool without scraping; the alerts feed requires PostgreSQL and responds 503 without it.

A consolidated `/api/digest` endpoint returns one JSON snapshot of every headline regime call — US and global net-liquidity regimes, dollar transmission label, equity breadth and screener leader, Fear & Greed, and bitcoin valuation/funding bands — composed live from the same cached computations the dashboards use, suitable for cron-driven daily digests or external monitoring.

## Reliability Rules

- Missing provider data returns unavailable; it is never silently replaced with a sample value.
- FRED works with or without an API key: the authenticated observations API is preferred, and without a key the public `fredgraph.csv` endpoint supplies full-history CSV per series. H.10 FX and broad-dollar series allow a 10-day observation age to absorb the Fed's Monday release cadence.
- PostgreSQL provides last-known-good history when an upstream provider fails.
- Stored fallbacks retain their original provider timestamp and source label.
- Successful provider responses are also freshness-checked; stale observations remain labeled and may be retained as raw history, but are excluded from current models.
- Partial quote refreshes retain missing last-known-good assets as explicitly stale cache fallbacks.
- FRED revisions are preserved in `observation_revisions` rather than overwritten without an audit trail.
- Ingestion runs record status, write count, provider errors, and completion time.
- CoinGecko requests are built in one place (`buildCoingeckoRequest`) so the host and key header always match the tier: keyless stays on the public host with no header, a free demo key adds `x-cg-demo-api-key`, and a paid key moves to the pro host with `x-cg-pro-api-key`. Asking for the pro plan without a key falls back to keyless rather than calling a host that would reject it.
- A render failure never blanks the application. Each workspace renders inside an error boundary, so a payload the view cannot handle stops that panel with the underlying error shown, leaves the sidebar usable, and clears when the user navigates elsewhere. Panels additionally guard the fields they format, so a leg that is marked calculated but arrives without one of its values renders an em dash in that cell rather than taking the workspace down.
- A provider failure never ends the process. Work started early and awaited later is settled through `server/settled.js` so an early return cannot abandon an in-flight request, and the server additionally logs any unhandled rejection and keeps serving instead of terminating every in-flight request on the box.
- `/api` is rate-limited per client address (`API_RATE_LIMIT` requests per `API_RATE_WINDOW_MS`, 120 a minute by default). Every response advertises `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset`, and a rejection adds `Retry-After`. Counters are per process, so behind more than one Node instance each replica enforces its own share.
- Hashed bundle assets are served `immutable` for a year, while `index.html` and every `/api` response are served `no-cache`, so a deploy can never leave a cached document asking for an asset hash that no longer exists and quotes are never read back from a heuristic browser cache.
- The browser refresh loop (`src/polling.js`) never runs two loads concurrently, so a slow response — the screener sweeps the whole index — delays the next cycle instead of stacking requests against the API rate limit. Cycles are skipped entirely while the tab is hidden and one replay runs as soon as it is visible again.
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
