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

Every key is optional: the platform runs fully keyless, and a model that
cannot reach a feed reports `unavailable` with a reason rather than
substituting a value. Keys buy reliability and, in FRED's case, capability.

```dotenv
HOST=127.0.0.1
PORT=8787
FRED_API_KEY=your_fred_key
COINGECKO_API_KEY=your_coingecko_demo_key
COINGECKO_API_PLAN=demo
CFTC_APP_TOKEN=your_socrata_app_token
TWELVE_DATA_API_KEY=your_twelve_data_key
TWELVE_MINUTE_CREDIT_LIMIT=8
TWELVE_DAILY_CREDIT_LIMIT=760
TWELVE_MAX_INTERACTIVE_WAIT_MS=10000
TWELVE_QUOTE_REFRESH_MS=900000
DATABASE_URL=postgresql://tradegate_app:password@127.0.0.1:5432/tradegate
DATABASE_SSL=false
API_RATE_LIMIT=120
API_WRITE_RATE_LIMIT=20
API_RATE_WINDOW_MS=60000
LOG_LEVEL=info
ALERT_WEBHOOK_URL=
ALERT_WEBHOOK_SEVERITIES=high
INGESTION_ENABLED=true
MARKET_REFRESH_MS=900000
MACRO_REFRESH_MS=21600000
HISTORY_REFRESH_MS=86400000
```

Never prefix these values with `VITE_`; doing so would expose them in the browser bundle. `.env` is ignored by Git.

| Key | Free? | What it changes |
| --- | --- | --- |
| `FRED_API_KEY` | Yes, instant | The highest-value key. Without it the macro ingestion job does not run at all. It is also the only route to ALFRED point-in-time vintages, which is what lets the regime history be scored against what was actually known on each date rather than against revised figures. Request one at `https://fred.stlouisfed.org/docs/api/api_key.html`. |
| `COINGECKO_API_KEY` | Yes, Demo tier | Moves bitcoin quotes, history, and the global aggregates off the shared anonymous pool, which is the first to start returning 429/403 under load. Set `COINGECKO_API_PLAN=pro` only for a paid key. |
| `CFTC_APP_TOKEN` | Yes | Gives Commitments of Traders requests their own rate budget. Socrata issues an App Token *and* a Secret Token; only the App Token belongs in the environment - it is sent as a plain `X-App-Token` header on anonymous reads of a public dataset, so it identifies a rate bucket rather than authenticating anyone. The Secret Token is for OAuth flows this platform never performs. |
| `TWELVE_DATA_API_KEY` | Yes, limited | Redundancy and intraday freshness for equity quotes. Yahoo already covers this keylessly, so it adds resilience rather than new capability. Create one at `https://twelvedata.com/`. |

Some inputs have no free tier at all and are left `unavailable` rather than
approximated: spot Bitcoin ETF flows, dealer gamma and options positioning,
Coin Metrics community data, AAII sentiment, Standing Repo Facility take-up,
and economist-forecast surprise data.

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

Moving-average alignment checks price against the 20-, 50-, and 200-day averages. A history too short to have all three is scored on the checks it can answer, then shrunk toward neutral in proportion to how many that was, and `components.trendCoverage` reports the fraction. Without that shrink a single available average swung the full trend weight, and the same latest bar scored 20 points apart on a short history and a long one. Annualized volatility needs positive prices at both ends of each log return; where none are measurable it publishes `null` and scores neutral rather than reporting 0%, which would have read as the calmest possible tape.

### `us-liquidity-v1`

The US liquidity model uses:

| Driver | Weight |
| --- | ---: |
| Fed net liquidity: Fed assets minus TGA minus reverse repo | 55% |
| US M2 13-week growth | 25% |
| Inverse broad-dollar 13-week change | 20% |

The output is Expansion above `+0.15`, Contraction below `-0.15`, and Neutral between those thresholds.

### `liquidity-runway-v1`

The net-liquidity decomposition shows which leg moved the total; what it cannot say is that one of those legs has a hard floor. A shrinking Fed balance sheet offset by a reverse-repo drawdown looks neutral right up until the facility empties, at which point the same tightening lands on reserves undiluted. This model publishes that constraint: the current reverse-repo balance, the drawdown converted to a monthly pace, the offset ratio against the balance-sheet contraction, and — only while the facility is actually draining, since a flat or rising balance has no exhaustion date — how many months of cushion remain at the current pace.

States are: the balance sheet expanding (nothing needs absorbing), a reverse-repo drawdown covering at least half the contraction, one covering less than half, and a contraction with no drawdown at all, where the tightening reaches reserves directly. The Treasury general account's direction over the same window is carried alongside, since a rebuild is the other drain.

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

The relationship map aligns stored FRED series with stored market histories by calendar date and correlates **daily changes** (not log returns, so weekly levels such as NFCI remain valid) over 20-day, 60-day, and one-year windows. Designed pairs: credit spreads/equities, VIX/equities, broad dollar/BTC, financial conditions/equities, real yields/gold proxy, and broad dollar/gold proxy. A pair publishes only when both legs have at least 22 aligned observations; missing pairs are listed explicitly. Each pair also reports **which side moves first**: its aligned daily changes are cross-correlated across a lag window of ten observations in both directions, ranked by absolute correlation so a genuinely inverse pair (broad dollar against bitcoin, real yields against gold) is not misread as a weak positive blip. A lead is claimed only when the peak beats the synchronous reading by 0.05, and the lag is converted to calendar days using the pair's own observation cadence, so a weekly series such as NFCI reports weeks rather than sessions. Pairs that peak at zero lag are reported as moving together, and `leadSignals` ranks whichever pairs do lead by the strength of the correlation at their peak lag. Asset-sensitivity labels derive from absolute-correlation thresholds of 0.25 and 0.50. The equities macro-sensitivity matrix additionally publishes what stands behind each cell: the number of aligned changes, the date it runs to, and the window in its own units. Sixty aligned observations are sixty sessions only when both legs publish daily — against a weekly driver such as NFCI the same window spans more than a year, so those cells are marked and labelled in weeks rather than presented as sixty days.

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

### `equity-expected-move-v1`

A one-sigma band from realised volatility, together with the hit rate it earned. Sigma is the standard deviation of daily log returns over a 252-session estimation window, scaled by the square root of the horizon; the band is a range centred on spot, not a forecast and not a bound.

The band alone is arithmetic, so the model also tests it: the same rule is walked back through the history, re-estimating sigma from data available at the start of each window and stepping forward in **non-overlapping** blocks, and the published hit rate is what that produced. Overlapping windows would inflate the sample count without adding independent evidence.

Two results are reported that a band on its own hides. A one-sigma band on equity returns usually holds *more* often than the 68.3% a normal claims, not less — the distribution is peaked as well as fat-tailed, so it is the shoulders that are thin. The band therefore understates risk through the *size* of what escapes it rather than the frequency, which is why the median and worst breach are published as multiples of the band beside the hit rate, along with excess kurtosis. The band also carries no drift term, so a strongly trending market breaks it asymmetrically and the hit rate falls below what volatility alone implies.

### `verdict-v1`

Every workspace publishes a dozen honest readings and used to leave the reader to synthesise them. `server/verdict.js` does that synthesis explicitly and shows its working: the call, how much of the evidence was available to make it, which readings carry it, which argue against it, and what would have to change for the call to change.

Three rules keep it from becoming the confident-sounding filler these boxes usually are. Confidence is **derived**, never asserted — thin coverage, split readings, a wide spread, a call near its boundary, or a stale input each hold it back, and the reasons are listed. Dissent is **always published**; a verdict listing only its supporting evidence is an advertisement. And the **margin is published**, because a call two points from its boundary and one thirty points inside it are different claims that must not read alike.

The score is renormalised by the weight that actually reported, so a missing input cannot pull the verdict toward its own absence, and contributions rank by distance from neutral times weight — how much a reading is moving the verdict, not how extreme it is alone. The macro verdict reuses the consensus model's own signals, excluding the composite (macro-regime is built from several of them, so counting it beside its components would let one view of the world vote twice) and excluding cautions, which are risks at either end rather than directions.

Verdicts run on the equity, macro, bitcoin, FX and metals workspaces, each on its own axis with its own bands: risk for equities and macro, "constructive for bitcoin", "firm dollar" for FX, "constructive for gold" for metals.

Two rules govern what is allowed to vote. A composite never sits beside its own components — `macro-regime` is built from several of the macro signals, so counting it with them would let one view of the world vote twice, and the metals verdict leaves real yields out for the same reason, because the broad-dollar model it already carries has a real-yield driver inside it. And a reading whose direction depends on a horizon the verdict does not state is excluded rather than assigned a polarity: MVRV valuation is bearish over a cycle and bullish over a quarter, a drawdown is restrictive to a trend follower and an opportunity to a contrarian, high realized volatility accompanies both capitulation and melt-up, and a crowded net-long is support today and fragility tomorrow. Those stay in their own panels, where the reader supplies the horizon. Perpetual funding is the one crowding measure that is counted, inverted, because leverage paying to stay long is fragile on any horizon.

Confidence is held back by the weakest link, and dissent is measured by weight rather than by count: with three signals, one opposing reading is a 67% "majority" that still leaves a third of the verdict arguing the other way.

Where a section already publishes a weighted model, the verdict is built from **that model's own drivers** rather than from a second set of weights. Two composites over overlapping inputs drift: the equity dashboard briefly carried both, and its banner and its regime panel landed in different bands about one page load in twelve. Feeding the drivers through makes the two numbers identical by construction. For the same reason every composite now rounds each driver *before* weighting, so the drivers a reader sees add up to the score printed beside them.

### `equity-concentration-v1`

A cap-weighted index is its members weighted by size; the equal-weight version of the same members is the average member. The gap between them is the part of the index return that came from its largest holdings rather than from the market — which matters because an index can sit at a new high while most of its members are falling, and nothing about the index level shows that.

The model publishes the spread over 20, 60 and 252 sessions (positive means the index outran its average member), where today's ratio sits in its own history, and each side's drawdown from its own high. When the index is within 3% of its high while the average member is more than 8% below its own, it says so explicitly.

Three limits are published with it. These are two ETFs, so the ratio carries their fee and rebalancing differences as well as the concentration signal — a good relative measure and a poor absolute one. The equal-weight fund rebalances quarterly, so it is not a pure average member in between. And the closes are aligned by position rather than by date, because the batch endpoint returns them without dates, so the observation counts and any mismatch are published rather than hidden.

### `hard-money-v1`

Every tracked asset priced in gold: the S&P 500 and Nasdaq-100 (each read twice, on price and on total return), bitcoin, silver and platinum.

A dollar price mixes two things — how the asset did, and what happened to the unit it is quoted in. Dividing by gold removes the second, so the ratio answers a different question: not "did this go up" but "does it buy more of the oldest monetary asset than it used to". Over long horizons the two answers can point opposite ways.

Each horizon publishes the asset's own move, gold's own move, and the ratio move separately. The wedge between the dollar move and the gold move is the denominator's contribution — deliberately **not** called debasement, because gold rising on its own demand looks identical here and the ratio cannot establish a cause.

Two readings come out of it. *Within* an asset, where its gold ratio sits in its own history says whether today is expensive or cheap on that measure. *Across* assets, ranking those percentiles says which is winning in hard-money terms, and anything up in dollars but down in gold over the same window is flagged, because that is where the dollar chart and the gold chart disagree about direction.

The equity indices are read on price **and** total return because the difference is not cosmetic: a price index can be flat in gold terms over a decade while the same index with dividends reinvested is well ahead — and that gap is the real return, delivered as income rather than as price.

### `price-crosscheck-v1`

Every model trusts the price series it is handed, and a provider that misses a split, stamps a close on the wrong day or freezes a symbol produces a series that looks like a market and scores like one. The cross-check (on the Markets page) puts each core symbol's primary history beside Yahoo's and measures the disagreement over the last 60 shared sessions: the latest close, the median daily-return difference, and the worst single day. Daily returns are compared, not only levels, because a wrong close weeks ago leaves today's level untouched.

A source compared with itself proves nothing, so the check refuses to call that a pass. Stored history is attributed to the provider that last wrote it — ingestion falls back to Yahoo when Twelve Data fails, so stored history can be Yahoo's — and an unknown writer is not assumed to be anyone. Bitcoin's sources stamp daily closes on different days (CoinGecko at 00:00 UTC, Yahoo on the close's own date), so a one-day offset is tried each way and the alignment used is reported rather than every day being flagged. A disagreement is a review trigger, not proof of error: session cutoffs, dividend adjustments and venue differences move closes legitimately.

The check also gates the models built on those series. It covers the 19 heatmap markets plus NVDA and AAPL, each cached separately. A symbol whose primary history disagrees with Yahoo beyond tolerance has its technical score and heatmap row downgraded from calculated to provisional. The numbers stay visible, flagged "price review", with the disagreement named, and a row under review still counts toward the heatmap's aggregates. A symbol that agrees is marked verified. One that could not be compared independently, or whose check did not finish within 8 seconds, is marked unverified, never passed.

### Derivatives venues

BTC perpetual funding is read from Binance, Bybit and OKX, and open interest from Binance with OKX as the fallback. Every venue restricts some region — Binance's futures API answers US addresses with 451 and Bybit's CDN refuses some cloud ranges with 403 — so each venue is its own result and the funding read names the venues it was built from and the ones that did not answer. The cross-venue spread is published, and the percentile names the venue whose history it is ranked against (Binance's ~330 days, or OKX's three months when Binance refuses). OKX publishes daily open interest in dollars only, so its coin-equivalent is rebuilt from the same day's close before the price/open-interest quadrant reads it. A leg that fails on a refresh reuses its last good reading, labelled provisional with the reason, never as live.

### `factor-returns-v1`

Which equity factors are working, from the Kenneth R. French Data Library — the reference source for academic factor returns, no key. Six long-short US factors: market, size, value, profitability, investment and momentum. A factor's return is what the tilt earned, not what the market did.

Each factor's 1-, 3- and 12-month return, its drawdown from its own high, and its 63-session volatility are ranked against its full history since 1963, because a number alone means little: value losing 8% in a year is unremarkable in one decade and historic in another. The 63-session value-momentum correlation is published because the pair is held together for its usually negative correlation, and when that breaks down the diversification is not there.

Momentum carries one extra reading: its worst losses have historically clustered in a sharp market rebound after a prolonged decline, when the losers it is short are the high-beta names that rebound hardest. The two conditions (a negative two-year market return and a one-month gain of at least 8%) are published with their thresholds, as a known hazard rather than a forecast.

The library publishes monthly with a lag of several weeks, so the final observation is routinely one to two months old; the vintage is printed on the panel and only past 100 days is the data called stale. The archives are zip files, read by a small dependency-free reader (`server/zip.js`) tested against fixtures written by an independent implementation, including the streaming layout in which the local header's sizes are zero.

### Track records

A model that says "deep value" or "stretched" is making an implicit claim about what comes next. `server/trackRecord.js` measures that claim: for every week a signal was in a given state, what did the asset do over the following 30, 90 and 180 days — and was that any different from what an ordinary week was followed by? It is applied first to the accumulation tiers, per asset and pooled across all six assets.

Three disciplines keep it from being the flattering backtest these usually are:

- **Held out.** The newest 30% of observations form a block reported separately. A pattern that exists only in the earlier block is a pattern in that block, not a property of the signal.
- **Against the base rate, not zero.** An asset that rose in 80% of quarters makes every state look predictive of gains, so each state is compared with the median for all weeks in the same block.
- **Effective sample size.** Weekly readings of a 90-day return overlap eleven weeks in twelve, so 52 of them carry roughly four independent observations. Every cell shows both counts; under four effective observations it publishes no statistics, under ten it is marked thin.

Tier ordering is scored from −1 (exactly reversed) to +1 (cheaper tiers followed by better returns, as the ladder assumes). The per-asset read uses the longest horizon at which the current tier's held-out cell has evidence and the table opens on that same horizon, because a single asset's held-out block rarely holds enough independent 90-day windows per tier. The track record can contradict the model it describes, and is built to say so: on a momentum-driven series, deep-value weeks were followed by worse 30-day returns than stretched ones, even while the tiered schedule bought cheaper units over the full cycle. Both are true; they answer different questions.

The same engine audits **technical-v1** (`server/technicalTrackRecord.js`, on the Markets page). The score is trend and momentum, so its claim is that a Constructive week precedes better returns than a Guarded one. Every past week is re-scored from a fixed trailing window of the closes available that week — fixed so every historical score is comparable, at the cost of differing by a point or two from a live score computed on more history — and today's regime is computed from the same window so the current state and its record are one measurement. Records are published per asset and pooled across the six. On a cyclical test series the two models behave as opposites, which is the point of measuring them: the momentum score ranked its regimes as it assumes, while the accumulation tiers, which buy weakness, ranked in reverse over the following months.

The **macro regime** has the same audit, on the Macro page's regime tab. Its weekly history was already recomputed from financial conditions, high-yield spreads and volatility (on point-in-time FRED vintages when an API key is set) and listed transition by transition; those weekly samples now also feed the track-record engine against SPY, so each regime's average aftermath is shown with a held-out block and effective sample size rather than inferred from a handful of transitions. Without vintages the record inherits the hindsight of the scores it describes, and says so beside the numbers, not only in the methodology.

Tier or regime ordering needs evidence in at least two states for a three-state signal and three for the five-tier ladder; a three-regime score often leaves its middle state thin, and its two extremes are still a real test of the order.

### `treasury-funding-v1`

Whether the US Treasury is finding buyers for its debt, and what its cash management is doing to bank reserves — from the Treasury's own Fiscal Data API, no key.

- **Auction demand.** For each coupon tenor (2, 3, 5, 7, 10, 20, 30 years): bid-to-cover, the indirect share, and the primary-dealer takedown — dealers absorb what end investors did not take, so a high takedown is a weak auction. Each is ranked against **that tenor's own previous 24 auctions** (a rank needs 12); a 2-year routinely covers higher than a 30-year, so ranking across tenors would call every long-bond auction weak. Three tenors auctioned within 60 days sitting in the bottom quarter of their own history is soft demand; three in the top quarter is firm.
- **The cash balance (TGA), daily** from the Daily Treasury Statement. Building cash drains bank reserves dollar for dollar; spending it down adds them. The weekly FRED series smears this across the week while tax dates move it by a hundred billion in days.
- **Daily net liquidity**: the Fed balance sheet (carried forward at most seven days) less the daily TGA and overnight reverse repo, so the nowcast ends rather than freezing if a series stops.
- **Debt growth** (last quarter annualized against the last year), the **average rate on marketable debt** and its 12-month change, and the share of marketable debt **maturing within a year**.

Three rules come from failures found in an earlier implementation of the same idea, and each is tested. An announced auction is not a result: the dataset lists upcoming auctions with an offering size and no outcome, and reading the newest row as "latest" silently dropped the tenor. A percentile needs a history: ranking against the newest 200 auctions of every kind leaves about five per coupon tenor once weekly bills take their share, so the request is restricted to notes and bonds. And a measure whose field is absent says so: that implementation read an indirect-bidder field that does not exist in the dataset, so its indirect-demand signal had been null on every auction without anything reporting it. Here, each demand measure publishes whether its field was present at all.

Auction tails against the when-issued yield are not measured: the dataset carries no pre-auction market yield, and the prior day's close is contaminated by the session's own move.

### `crypto-options-v1`

The BTC and ETH option surfaces from Deribit's public API (no key). Options do not say where price goes; they say what the market will pay to be protected, and against what. Four readings carry most of it: implied vol at fixed tenors, the 25-delta risk reversal (negative means downside protection costs more than upside), the term structure (near above far means something is priced soon), and implied minus realized (whether options are rich or cheap against what the asset has actually done). DVOL history places today's 30-day implied vol in its past year.

Two conventions are deliberate, and both are where simpler summaries go wrong:

- **Constant maturity.** Listed expiries drift — "the front month" is 29 days out one week and 22 the next — so a raw front-month IV changes when nothing in the market did. Each tenor (7, 30, 90 days) is interpolated linearly in **total variance** between the two listed expiries that bracket it; interpolating vol directly understates the far tenor whenever the curve is steep. Expiries inside two days are excluded as settlement noise, and a tenor outside the listed range is reported missing rather than extrapolated.
- **Exact 25-delta.** Taking the listed strike nearest 0.25 compares, on a typical chain, a 0.27-delta call with a 0.31-delta put, so part of the "skew" is just the smile. Wings are interpolated to exactly ±0.25 forward delta (Black-76 on each expiry's own underlying, so carry is not counted twice). On the test chain the nearest-strike method is off by 0.3 vol points; an expiry that does not bracket 0.25 publishes no wing.

Limits, published with it: Deribit carries most crypto options open interest, not all (CME is absent); mark IV is the exchange's model mark, not a traded price; open interest is in coins, so put/call counts contracts rather than notional; the max-pain strike is a mechanical reading of open interest, a reference level and not a target.

### `accumulation-v1`

A dynamic dollar-cost-averaging rule for bitcoin, gold, silver, platinum, the S&P 500 and the Nasdaq-100 — one engine, because the question it asks (where is this asset in its own history?) does not change with the asset class.

Flat dollar-cost averaging buys the same amount every period and therefore buys the most units when price is low purely by accident. This makes that accident deliberate: three price-derived components — stretch above the one-year mean, position against the three-year running high, and one-year momentum — are each ranked against that asset's own history, so an 80th percentile reading means the same thing for bitcoin as for platinum. The weighted rank places the asset in one of five tiers, each a multiple of a baseline contribution.

**The multiples average exactly 1.0** (1.75× / 1.4× / 1× / 0.6× / 0.25×). That is a constraint, not a coincidence: without it the schedule would beat a flat one simply by deploying more capital, and every comparison below would be measuring the budget rather than the rule. Nothing goes to zero either — an accumulation rule that stops buying at a high and never restarts is a market call wearing a schedule's clothing.

Windows are stated in calendar days and converted to sessions from each asset's own observation density. A fixed session count would make "one year" mean 365 sessions for bitcoin and 365 sessions for the S&P — seventeen calendar months for the market that trades five days a week. Note that the median gap between rows is one day for *both* markets, so median spacing is the wrong statistic here; the density over the actual span is the right one.

**The price ladder is the part a reader actually acts on.** A percentile says where an asset sits; it does not say what has to happen next, and the rule already knows. Each tier is published with the price that would put the asset in it — found by bisecting on price, since the blend of three percentile ranks has no closed form, and valid because all three components rise with price so the read is monotonic in it. A boundary the price cannot reach (above its own running high the distance-to-high component saturates and the read stops climbing) is reported as out of reach rather than extrapolated, and every published price is settled toward the side that still qualifies so that display rounding cannot print a price that misses the tier it names.

The rule is backtested against a flat schedule on the asset's own history, weekly, recomputing the tier from data available at each step only. The legs are compared on **cost per unit**, not ending value, because the tiered leg deploys a different amount of capital. The capital ratio is published alongside, so a cost advantage that came from spending more is visible rather than hidden. One asset over one history is one path: buying weakness beats a flat schedule in a market that mean-reverts and roughly ties it in one that only trends, and the backtest measures which of those the asset has been — not which it will be.

Realized volatility is deliberately excluded. High volatility marks both blow-off tops and capitulation lows, so its direction depends on an unstated horizon; giving it a sign would assert a view the measure cannot support. The three components that *are* used are not independent — all three rise together in a sustained advance — so agreement between them is one piece of evidence seen three ways, which is why the ladder is gentle rather than 5× to 0×.

The cross-asset split (each asset's multiple over the sum of the multiples) is published separately from the per-asset tiers, because it adds an assumption the tiers do not make: that the baselines were equal to begin with. It is not a portfolio weight and says nothing about position sizing. Six assets across five tiers means ties on the multiple are the normal case, so the split is ordered by risk within a tier and the cheapest and dearest are named by their risk reads — otherwise the sentence names whichever tied asset the sort reached first, which is how a panel showing Gold at the 28th percentile came to announce Bitcoin at the 33rd as the cheapest holding.

Its main limit is published with it: every component is ranked against the asset's *own* history, so an asset that has spent most of that history near its highs shows a mid-range risk while near its highs again. The rank says where today sits among this asset's past, not whether that past was cheap in absolute terms.

This is a spending rule, not advice and not a forecast. It never signals a sale and carries no view on whether an asset should be held at all.

### Equity calculation engines

`equity-regime-v1` dynamically changes factor weights, alert thresholds, and expected holding periods. It requires price trend, momentum, and volatility, and remains provisional below 75% driver coverage. `equity-top-risk-v1` and `equity-bottom-signal-v1` require both technical and constituent-breadth confirmation and do not publish from price and liquidity alone.

`equity-top-risk-v1` and `equity-bottom-signal-v1` build their technical leg from RSI, distance to the 200-day average, and the MACD histogram. An input that is absent is excluded rather than scored: defaulting the distance to zero and the MACD to its calm value made an incomplete technical picture read as *lower* risk, which is the one direction a risk score must not fail in. At least two of the three legs are required, so no single indicator carries the read.

`equity-breadth-v1` calculates advance/decline participation, McClellan measures, moving-average participation, new highs/lows, and breadth thrusts from constituent histories. The live constituent path additionally asks whether participation **confirms** the index: an advance/decline line is accumulated over the last 60 sessions from the same constituent closes already loaded, and both it and SPY are percentile-ranked inside that window. An index at the top of its range while the advance/decline line sits at least 20 percentile points lower is reported as a negative divergence — a rally being carried by fewer names — and the mirror case at the bottom of the range as a positive divergence. Percentile ranks are used rather than pivot detection, which is fragile on noisy daily data and can miss or invent a peak depending on where the window starts. A mid-range index is reported as carrying no divergence message rather than being forced into one, and fewer than 40 aligned sessions withholds the reading. `style-rotation-v1` compares equal-weight basket returns over 20 and 60 synchronized sessions. It names leadership from the 60-session spread, but when the 20-session spread is decisively the other way the pair is reported as changing hands rather than as the older window alone would have it — both horizons are measured, so a basket ahead by two points over 60 sessions while behind by two over 20 is a live rotation, not simply "leading". A spread inside one point either way is treated as noise and the pair reads balanced.

`sector-rotation-v1` ranks aligned 20- and 60-session performance relative to SPY together with `technical-v1` across all 11 sectors and 19 subsector ETF proxies; ranks are global across the tracked universe. The relative-rotation quadrant reads the 60-session excess return as how strong a sector already is against the benchmark and the 20-session one as whether that strength is currently building, giving the standard Leading / Weakening / Lagging / Improving placement. Each row is additionally placed where it sat 20 sessions earlier, so a sector rotating **into** leadership is distinguishable from one rolling **out** of it — the static quadrant alone cannot tell those apart — and the workspace names which sectors crossed in each direction. The shift is the change in 20-session excess return over that window; a row without 20 sessions of history beyond the 60-session lookback reports no trajectory rather than a guessed one. Missing constituent, volume, flow, sentiment, positioning, or credit inputs remain explicitly unavailable.

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

`bitcoin-cycle-v1` assembles seven crowding legs: 200-day/200-week trend regime (Yahoo BTC-USD), MVRV Z-score and short-term-holder realized price (bitcoin-data.com), aggregate Binance+Bybit funding with a history percentile, a 7-day open-interest-versus-price quadrant (price is recovered as Binance's published notional divided by its contract total, because that notional is itself contracts times price and would otherwise follow open interest rather than the tape), aggregate stablecoin supply change (DefiLlama), and spot ETF flows, which remain unavailable without a licensed source. Same-host calls are serialized and last-known-good values are memoized because bitcoin-data.com rate-limits aggressively.

`bitcoin-cycle-phase-v1` then places bitcoin in its cycle from those same legs, which the workspace had previously published side by side without ever answering the question the page asks. Four phases each score their own evidence 0-100: capitulation reads deep drawdown, a negative MVRV Z-score, price under the 200-week average and recent buyers underwater; early recovery reads a drawdown around 30%, a Z-score near 1, price just above the 200-week average and expanding stablecoin supply; expansion reads a shallow drawdown, a mid-cycle Z-score, price above the 200-day average and funding that is not yet stretched; euphoria reads a Z-score beyond 3, price at the highs, and both funding and realized volatility in their upper percentiles. A phase needs at least two of its own calculated legs to appear and reports its coverage and what it is missing, and a lead narrower than five points is published as genuinely ambiguous rather than resolved.

`equity-risk-v1` publishes S&P 500 breadth (% of constituents above 200-day and 50-day averages from Wikipedia's constituent list plus Yahoo batch spark closes), RSP/SPY equal-weight participation slope, FRED high-yield OAS with a 20-observation change, an equity-risk-premium proxy (trailing earnings yield from multpl.com minus the 10-year TIPS real yield), and 3-month relative strength for all 11 sector SPDRs versus SPY. A CNN Fear & Greed snapshot card sits alongside CFTC positioning on the equities tab.

The home news card aggregates live RSS wires (`news-wire-v1`): Federal Reserve press releases, CNBC top news, and MarketWatch top stories, sorted newest first. Every headline is keyword-classified as positive, negative, or neutral through a transparent lexicon, with wire-wide tone counts on the card. Constituent breadth (`spx-constituent-breadth-v1`) feeds the index-level top-risk and bottom-detection models directly, with the live provider technical snapshot as fallback when stored histories are absent, so those signals publish without a database. The last remaining previews are source-blocked: spot ETF flows (Farside is Cloudflare-blocked), metals ETF holdings/physical premia/producer cost curves, and dealer-gamma options positioning (CBOE is Akamai-blocked).

`equity-risk-v1` also carries a VIX term-structure leg (spot VIX divided by VIX3M from Yahoo index histories, percentile-ranked over six months) and a 10Y-2Y Treasury-curve leg (FRED T10Y2Y with a 20-observation change), for seven calculated legs in total. The metals workspace publishes gold/silver and gold/copper cross-ratios with one-year percentiles. `metals-cost-structure-v1` replaces what had been a hardcoded cost panel: WTI crude and natural gas carry their level, 20-session change, and one-year percentile as the fast-moving input costs, and the GDX/GLD ratio serves as the market's own running verdict on whether the metal price is outpacing the cost of producing it — the only margin read available without company filings. All-in sustaining cost stays explicitly unavailable and names the feed it needs rather than being approximated into a number that would look reported. The physical-versus-paper panel likewise names the licensed or filings-based source each row requires instead of showing readings nobody measured.

With PostgreSQL configured, the scheduled `research-workspaces` ingestion job persists the heatmap, metals, FX, sentiment, bitcoin-cycle, equity-risk, `liquidity-states`, and `dollar-transmission` workspaces as versioned model outputs on the macro cadence. The liquidity-states entry is a compact derived snapshot of the regime calls — US net-liquidity regime, global liquidity regime and momentum, and the stablecoin supply state with its 30-day growth — so transitions such as Expansion→Contraction or Flat→Expanding raise alerts like any other vital. The dollar-transmission entry is calculated once server-side and rendered by the Crypto tab, so the browser and the persisted alerts cannot disagree. It applies broad-dollar momentum and level **through the measured DXY/BTC correlation rather than an assumed one**: a falling dollar reads as a tailwind only while the link is inverse, the identical move reads as a headwind under a positive link, and inside a ±0.2 correlation band the dollar transmits nothing and the model says so instead of naming a direction. Flips between Dollar tailwind, Neutral dollar, Dollar headwind, and Link too weak to transmit are alerted with the same machinery. The liquidity narrative then merges `buildWorkspaceNarrative` change detection over those stored outputs, so the Macro tab narrates movements in Fear & Greed, breadth, high-yield OAS, MVRV-Z, funding, COT percentiles, cross-ratios, liquidity regimes, and bitcoin's dollar backdrop between runs. The same detection runs at ingestion time: any detected vitals shift is written to a `model_alerts` table (migration `004`) and served from `/api/alerts`, giving a persisted alert history rather than only an ephemeral narrative. Both the alert history and the news wire are also published as Atom feeds (`/api/alerts/feed` and `/api/news/feed`, `application/atom+xml`), so model alerts and headline tones can be subscribed from any feed reader or automation tool without scraping; the alerts feed requires PostgreSQL and responds 503 without it.

A consolidated `/api/digest` endpoint returns one JSON snapshot of every headline regime call — US and global net-liquidity regimes, dollar transmission label, equity breadth and screener leader, Fear & Greed, and bitcoin valuation/funding bands — composed live from the same cached computations the dashboards use, suitable for cron-driven daily digests or external monitoring.

## Model Registry and Build Lineage

`GET /api/models` lists every published model (id and version, the page it appears on, what it measures, the inputs it reads, its known failure modes, and whether it carries a track record). The Markets page renders the same list in the Model registry panel. Model ids such as `technical-v1` or `accumulation-v1` change when the model's logic changes, so a value captured from the page names the logic that produced it.

Every API response carries an `X-TradeGate-Build` header with the short commit of the running code, and `/api/health` reports `build { commit, shortCommit, startedAt, node }`. The commit is read from the `GIT_SHA` environment variable when set, otherwise from the checkout's `.git` directory. Docker images have no `.git`, so pass it at build time:

```bash
docker build --build-arg GIT_SHA=$(git rev-parse HEAD) -t tradegate .
```

## Workspace Snapshots

`GET /api/snapshot` records every published reading in one pass: each model's version, status, state, score and the date of the data behind it, the observation date of every macro input series, the build commit, and any section that failed to load. `?download=1` serves it as a JSON file and `?format=csv` as a spreadsheet, one row per reading with the snapshot time and commit on every row. Cells that a spreadsheet would run as a formula are defused.

The Workspace snapshot panel on the Markets page downloads both. Its compare button takes a saved JSON snapshot and lists what has changed since, with a cause for each change:

- **new data**: the date behind the reading moved, or for a macro reading, one of its input series printed;
- **model changed**: the version differs, so the two numbers come from different logic and are not comparable;
- **same data**: same version and data date but a different answer, usually an upstream revision;
- **undated**: the reading carries no date of its own, so nothing says whether its data moved.

Readings are found by walking the payloads rather than from a hand-kept list, so a new model appears in snapshots without being registered anywhere.

## S&P 500 Valuation

`GET /api/analytics/index-valuation` (the S&P 500 valuation panel on the Equities page) reads Robert Shiller's monthly workbook, which goes back to 1871. It is free and needs no key. The download link is read from shillerdata.com on each refresh, because the file's hosting path changes between uploads; the old Yale address is the fallback. The result is cached for a day.

The workbook is a legacy `.xls` file. `server/xls.js` reads it with no dependencies: the OLE2 container, shared strings that span continuation records, and number, RK, MULRK, formula and label cells. Its tests compare it cell for cell against `xlrd`'s reading of the same fixtures.

CAPE is computed here from the raw price (P), earnings (E) and CPI columns, which are found by their headers. The file's own derived columns have moved between editions, so they are not used. The model publishes:

- **CAPE's rank:** today's CAPE against its whole history, and against the years since 1950.
- **The excess CAPE yield:** the earnings yield less the real 10-year rate. Today's figure is ranked using the same definition as the history (the 10-year Treasury yield less trailing ten-year inflation). The TIPS-based figure is shown beside it as a comparison, not ranked.
- **The ten-year real returns that followed similar excess yields:** a fitted line plus a table by fifth of history. The evidence amounts to about fifteen independent decades. The fit is tested out of sample: trained on windows that began before 1981, scored on windows that began after 1990, and compared with simply guessing the historical average.

## Alert Outcomes

`GET /api/analytics/alert-outcomes` scores every stored alert from the last two years against what followed, at 30 and 90 days. It is shown at the foot of the Macro page and needs PostgreSQL, since alerts are only stored there. Alerts carry no direction, so each kind is scored on the claim it implicitly makes:

- **Macro warnings** (curve un-inversion or inversion, reserve tightening, reverse-repo exhaustion, quarter-end, term-premium repricing) are right when SPY then returned less than its own typical return over the horizon.
- **Screener breakouts** are right when the stock then beat SPY by more than it usually does.
- **Everything else** (workspace state shifts, divided models, a regime near a boundary, cleared conditions) is right when a larger-than-usual move followed.

The entry is the first close after the detection day. Alerts of one kind that fire within a horizon of each other count once in the effective sample. With fewer than 4 effective alerts no rate is shown, and fewer than 10 is marked thin. A kind of alert is described as beating chance, or as worse than chance, only when its right-rate is more than two standard errors from 50% on the effective count. The summary names only those kinds, never simply the best-scoring one.

## Dark Theme

The stylesheet is written light-first with literal colours. At build time `src/darkTheme.js`, a Vite plugin, derives a dark counterpart for every light colour that has no hand-written `html[data-theme='dark']` rule:

- text is lightened to at least 5.5:1 against the dark surfaces;
- light surfaces become dark ones of the same hue;
- light borders become dark hairlines;
- data marks are held to 3:1;
- text dimmed with opacity is floored at 0.8.

Hand-written dark rules always take precedence. A test fails if a hand-written dark text colour drops below 4.5:1.

## Reliability Rules

- Missing provider data returns unavailable; it is never silently replaced with a sample value.
- Watchlist validation is shared with the server rather than approximated. `src/watchlistRules.js` mirrors the `PUT /api/watchlists` rules exactly — uppercase, `[A-Z0-9.-]` only, ten characters, fifty symbols a list, twenty lists — so a symbol the browser accepts is stored byte-identically, and a list at the cap refuses the next symbol with a reason instead of letting the server reject the whole payload and silently strand every other list.
- The coverage indicator distinguishes a provider that cannot serve from one merely running without an optional key. FRED reads its public CSV endpoint keylessly and is fully functional, so counting every keyless provider as unconfigured — which the old check did — left the platform permanently "partial" and the warning meaningless. `derivePlatformStatus` marks a provider degraded only when it has no keyless path and no key, or is configured but unreachable or unmigrated, and the indicator names what is missing rather than reporting a generic fault.
- FRED works with or without an API key: the authenticated observations API is preferred, and without a key the public `fredgraph.csv` endpoint supplies full-history CSV per series. H.10 FX and broad-dollar series allow a 10-day observation age to absorb the Fed's Monday release cadence.
- PostgreSQL provides last-known-good history when an upstream provider fails.
- Stored fallbacks retain their original provider timestamp and source label.
- Successful provider responses are also freshness-checked, against a **derived** tolerance rather than a hand-picked one. Each FRED series declares its release shape — cadence, publication lag, and whether the observation is dated at the **start** or the **end** of the period it covers — and the tolerance falls out of it. That last field is the trap: a weekly series dated with the last day it covers is at most one cadence plus the lag old, but a monthly series dated with the *first* day of the month it covers is a full extra month older than that before the next print even happens (`2 × cadence + lag`). BoJ total assets is monthly, dated at month start, published about five days after the month closes, so its worst normal age is 66 days — and the tolerance was 60. Every monthly series in the table was configured the same way.
- The invariant test meant to catch exactly this had been passing, because it compared a hand-picked tolerance against a hand-picked "expected gap" — two numbers from the same guess, agreeing with each other. Deriving both from the release calendar gives the check something real to test against.
- Freshness has three states above current, not one. **Overdue** is a late print inside tolerance. **Stale** means the latest value is no longer treated as today's level — it is dropped from spot readings — but the series still feeds the models that measure change over its own history, because a 91-day change ending at its last observation is a real change, just an old one. **Abandoned** (roughly three times the tolerance) means the series has stopped rather than slipped, and only then is it removed. Deleting stale series outright is what turned one late BoJ release into a total outage of global liquidity, the macro regime read, and every verdict downstream of them, since the BoJ leg is mandatory in the global pool.
- Partial quote refreshes retain missing last-known-good assets as explicitly stale cache fallbacks.
- FRED revisions are preserved in `observation_revisions` rather than overwritten without an audit trail.
- Ingestion runs record status, write count, provider errors, and completion time. The run lifecycle lives in `server/ingestionRun.js` behind injected database calls so it is covered by tests: a job already held elsewhere is skipped without starting a run, the cross-process lock is released on every path including a failure inside `startIngestionRun`, and neither a failed bookkeeping write nor a lock that cannot be released is allowed to replace the job's own error — the caller needs that error, and the next run's lock acquisition recovers a stranded lock.
- CFTC Commitments of Traders requests go through Socrata and are built by `buildSocrataRequest`. An optional free application token (`CFTC_APP_TOKEN`) moves them off the shared anonymous rate pool onto their own budget; it travels as an `X-App-Token` header rather than a query parameter so it stays out of proxy and server logs, and without it the requests are simply anonymous.
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
sudo -u tradegate -H /home/tradegate/TradeGate/deploy/update.sh
```

`deploy/update.sh` fetches, fast-forwards, installs from the lockfile, migrates
(skipped when `DATABASE_URL` is unset, since keyless mode has nothing to
migrate), builds, restarts the unit, and then polls `/api/health` until the
service answers rather than racing it with a fixed sleep. Any step failing
stops the deploy.

The `-H` matters: without it `sudo -u` leaves `$HOME` pointing at the invoking
user, so git reads the wrong `.gitconfig` and npm writes its cache into the
wrong home directory.

The script re-executes itself from a private copy before touching the
repository, because it lives in the repository it updates and a deploy that
changes it would otherwise rewrite the file that is currently running. Bash
reads a script lazily by byte offset, so replacing it mid-run makes the shell
resume at an offset that now points into different text and execute whatever
is there — a silent, arbitrary failure that only occurs on the deploys that
change this file. Demonstrated with and without the guard: without it, bash
resumed inside the replacement and tried to run a line of it as a command.

If the merge stops on untracked files that the incoming commit also creates
(the usual case being a hand-placed copy of this script from before it was
tracked), the script names them and prints the `rm` for each rather than
leaving you with git's message, which says what is in the way but not whether
it is safe to delete.

### If the deploy asks for a GitHub login, or fails with HTTP 401

```
error: RPC failed; HTTP 401 curl 22 The requested URL returned error: 401
fatal: expected flush after ref listing
```

**First, check whether it is an authentication problem at all.** Run the trace:

```bash
env GIT_TERMINAL_PROMPT=0 GIT_CURL_VERBOSE=1 git -c credential.helper= ls-remote origin 2>&1 \
  | grep -Ei 'Send header: (GET|Authorization)|Recv header: HTTP|netrc|fatal'
```

If it shows a **200 followed by a 401**, like this:

```
=> Send header: GET /AA-2020743/TradeGate.git/info/refs?service=git-upload-pack HTTP/2
<= Recv header: HTTP/2 200
<= Recv header: HTTP/2 401
fatal: could not read Username for 'https://github.com'
fatal: expected flush after ref listing
```

then **no credential is missing and none was rejected**. The ref listing
succeeded — that is the 200. Git then failed to parse the smart-HTTP response
(`expected flush after ref listing`), fell back to the *dumb* HTTP protocol,
and GitHub does not serve the dumb protocol anonymously — that is the 401, and
the username prompt is git asking for the credential the fallback needs. The
401 is a symptom of the parse failure, not its cause, which is why every
credential you check comes back clean.

The usual trigger is HTTP/2 negotiation between the host's curl build and
GitHub. Pin HTTP/1.1 for github.com:

```bash
git config --global http.https://github.com.version HTTP/1.1
```

`deploy/update.sh` retries the fetch over HTTP/1.1 automatically before it
blames anything, so the deploy completes and then tells you to make the pin
permanent.

If instead the trace shows a **401 on the first request**, it really is a
credential or URL problem, and the rest of this section applies.

**GitHub answers a request for a repository it will not serve you with 401,
never 404.** That is deliberate — a 404 would leak whether a private repository
exists to anyone guessing URLs. The consequence is that *"your credential was
rejected"* and *"there is no such repository"* are the **same response**, which
is why this error sends people hunting for a token that was never the problem:

| Remote URL | Response |
| --- | --- |
| `AA-2020743/TradeGate.git` | 200 — served anonymously, no credential needed |
| `AA-2020743/tradegate.git` (wrong case) | 200 — GitHub is case-insensitive here |
| `AA-2020743/TradeGate-typo.git` | **401** |
| `AA2020743/TradeGate.git` (missing hyphen) | **401** |

TradeGate is public, so a correct URL needs no credential at all. Run
`deploy/update.sh` and it distinguishes the two cases for you: on a fetch
failure it prints the URL git *actually requested*, probes it anonymously, and
names the cause. Or check by hand:

```bash
# The URL git actually uses. `git remote -v` shows the configured URL; --get-url
# applies insteadOf rewrites, which is the one failure that leaves the
# configured URL looking perfectly correct while the request goes elsewhere.
git -C /home/tradegate/TradeGate ls-remote --get-url origin

# 200 = public and reachable, no credential required.
# 401 = wrong URL, or genuinely private.
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://github.com/AA-2020743/TradeGate.git/info/refs?service=git-upload-pack
```

**If the probe returns 200**, the URL is right and no credential is needed, so
something local is injecting a rejected one — or sending the request somewhere
other than where curl sent it. List every setting with the file it came from:

```bash
sudo -u tradegate -H git -C /home/tradegate/TradeGate config --list --show-origin \
  | grep -Ei 'credential|http\.|url\.|proxy'
sudo -u tradegate -H cat /home/tradegate/.git-credentials 2>/dev/null    # stored, expired PAT
sudo -u tradegate -H grep -l github.com /home/tradegate/.netrc /etc/netrc 2>/dev/null
```

That last one is the sneaky one. curl reads `~/.netrc` automatically in most git
builds, so a stale login there is sent on every request **without any git config
mentioning it** — invisible to every other check on this page.

When configuration explains nothing, stop reading it and watch the exchange:

```bash
sudo -u tradegate -H env GIT_TERMINAL_PROMPT=0 GIT_CURL_VERBOSE=1 \
  git -C /home/tradegate/TradeGate -c credential.helper= ls-remote origin 2>&1 \
  | grep -Ei 'Send header: (GET|Authorization)|Recv header: HTTP|netrc|fatal'
```

This prints the exact URL git requested, the status it got back, and any
`Authorization` header it sent — which settles in one command what the
configuration audit can only infer.

```bash
# Remote carries a token: point it back at the anonymous URL.
sudo -u tradegate -H git -C /home/tradegate/TradeGate \
  remote set-url origin https://github.com/AA-2020743/TradeGate.git

# Stored credential is expired: drop the github.com entry.
sudo -u tradegate -H sed -i '/github\.com/d' /home/tradegate/.git-credentials
```

**If the probe returns 401**, the URL is not reaching the repository. Compare it
against `https://github.com/AA-2020743/TradeGate.git` and reset it with
`git remote set-url`.

`deploy/update.sh` fetches with the credential helper chain emptied
(`-c credential.helper=`) so no stale token can be offered, and with
`GIT_TERMINAL_PROMPT=0` so it fails with a message instead of blocking forever
on a username prompt no one is there to answer.

If you later make the repository private, the fetch does need credentials, and
the right mechanism for an unattended server is a read-only **deploy key**
(`ssh-keygen -t ed25519`, add the public half under the repo's Deploy keys,
switch the remote to `git@github.com:AA-2020743/TradeGate.git`) rather than a
personal access token, which expires and takes the deploy down when it does.

## Production Commands

```bash
npm run build
npm start
```

The Express server serves both `/api/*` and the built React application from `dist/`.

### Checking data sources

After a deploy, check that every external source answers from the server:

```bash
cd ~/TradeGate && npm run check:sources
```

It calls each source-backed loader once, using the app's own `.env`, keys and database, and prints one block per source:

- **verdict:** `OK`, `PART` or `FAIL`;
- **one key figure**, such as the CAPE and its date, or how many FRED series arrived;
- **the state of each sub-part;**
- **the upstream reason for anything that failed**, for example `403`, a timeout, or no database.

Sources run one at a time, so a shared upstream's rate limit is not mistaken for a failure.

The report ends with the state of ingestion. Scheduled ingestion is off unless `.env` sets `INGESTION_ENABLED=true` and a database is configured. Without it the app still serves every model from live calls, but stored history, model outputs, the consensus history and the alert record stop updating. `/api/health` also reports whether ingestion is on. Runs left open by a process that stopped mid-run are closed as failed (abandoned) the next time the scheduler starts. Each source also prints its key figures, such as Bitcoin's 30-day option volatility, the Treasury cash balance, CAPE and the market's long-run factor volatility, each against a generous plausible range. Several readers were written from documentation without a live response to check against, so a figure outside its range turns the source from `OK` to `PART` and names the value. That catches a reader that parsed the data but misread its units, such as a percentage read as a fraction or millions read as billions. Add `-- --json` for machine-readable output. The check changes nothing except the in-memory cache.
