/**
 * Every model that makes a call, with what it reads and how it is known to
 * fail.
 *
 * A version string on a payload says which logic produced a number; this
 * says what that logic is. The failure modes are the important part: each is
 * a way the model can publish a wrong answer that looks right, written down
 * so a reader can check whether today is one of those days. Most of them
 * were found the hard way and are pinned by a test.
 *
 * The `id` must match the version string the model publishes - an invariant
 * test fails if a registered id no longer appears in the source.
 */

export const MODEL_REGISTRY = [
  {
    id: 'technical-v1',
    name: 'Technical score',
    page: 'Markets, Metals, asset cards',
    measures: 'Trend (price vs 20/50/200-day averages), momentum (20-session change and MACD), RSI and realized volatility, blended 0-100; Constructive at 65+, Guarded at 35 and below.',
    inputs: ['Daily closes (Twelve Data, stored history, or Yahoo)'],
    failureModes: [
      'Shrinks toward neutral when history is too short for the 200-day average, so a young series reads milder than its trend.',
      'Trend-following by construction: it lags turns and reads a sharp reversal as continuation for weeks.',
      'A description of the trend, not a forecast; its track record measures whether its states have ordered what followed, and the scorecard reports the verdict.',
      'Scores whatever prices it is given; a provider error flows straight into the score unless the cross-check flags it.',
    ],
    trackRecord: 'technical-track-record-v1',
  },
  {
    id: 'accumulation-v1',
    name: 'Risk-tiered DCA',
    page: 'Metals, Crypto, Equities',
    measures: 'Where an asset sits in its own history on stretch above its 1Y mean, position against its 3Y high, and 1Y momentum; five tiers whose multiples average 1.0.',
    inputs: ['10-year daily closes from Yahoo'],
    failureModes: [
      'Ranks against the asset’s own past only: an asset that has spent its history near highs shows mid-range risk near highs again.',
      'Contains a momentum component, so "deep value" is often reached on the way down, and has preceded weak 30-90 day returns on cyclical series.',
      'Short histories (under a year of ranks) refuse rather than tier.',
    ],
    trackRecord: 'accumulation-v1',
  },
  {
    id: 'macro-regime-v1',
    name: 'Macro regime',
    page: 'Macro',
    measures: 'Financial conditions, high-yield spreads and volatility (plus liquidity and dollar when published), bucketed into Expansion, Constructive, Transition and Contraction.',
    inputs: ['FRED: NFCI, BAMLH0A0HYM2, VIXCLS and liquidity/dollar models'],
    failureModes: [
      'Without a FRED key the historical record is scored on revised data - hindsight, not a backtest.',
      'Financial conditions and credit move together, so their agreement is partly one signal counted twice.',
    ],
    trackRecord: 'macro-regime-history-v1',
  },
  {
    id: 'us-liquidity-v1',
    name: 'US liquidity',
    page: 'Macro',
    measures: 'Fed net liquidity (balance sheet less TGA and reverse repo), M2 growth and inverted dollar momentum over 91 days.',
    inputs: ['FRED: WALCL, WTREGEN, RRPONTSYD, M2SL, DTWEXBGS'],
    failureModes: [
      'Weekly Fed data: between prints the TGA and reverse repo move alone, so the level is carried while part of it changes.',
      'Monthly M2 lags by about a month and moves the score in steps.',
    ],
    trackRecord: 'liquidity-impulse-record-v1',
  },
  {
    id: 'global-liquidity-v1',
    name: 'Global liquidity',
    page: 'Macro',
    measures: 'Fed, ECB, BoJ and (when deep enough) PBoC balance sheets in USD, with M2 and inverted dollar.',
    inputs: ['FRED: WALCL, ECBASSETSW, JPNASSETS, DEXUSEU, DEXJPUS, DEXCHUS', 'BIS: PBoC total assets'],
    failureModes: [
      'BoJ is monthly and mandatory: its publication lag sets the pool’s effective resolution.',
      'PBoC is conditional; when absent the other weights renormalize, so the composite’s mix changes between readings.',
      'Currency moves change the USD pool without any central bank acting.',
    ],
    trackRecord: null,
  },
  {
    id: 'usd-strength-v1',
    name: 'Dollar strength',
    page: 'Macro, FX',
    measures: 'Broad dollar momentum, rate differentials and their divergence.',
    inputs: ['FRED: DTWEXBGS and H.10 pairs, US and foreign yields'],
    failureModes: [
      'H.10 rates are released weekly, so the newest observation is routinely ten days old.',
    ],
    trackRecord: null,
  },
  {
    id: 'hard-money-v1',
    name: 'Priced in gold',
    page: 'Metals',
    measures: 'S&P 500, Nasdaq-100 (price and total return), bitcoin, silver and platinum divided by gold, ranked against their own history.',
    inputs: ['Yahoo: ^GSPC, ^SP500TR, ^NDX, ^XNDX, BTC-USD, GC=F, SI=F, PL=F'],
    failureModes: [
      'A falling ratio can be gold strength rather than asset weakness; both legs are published so they can be separated.',
      'Front-month gold futures roll, which adds small jumps to the denominator.',
    ],
    trackRecord: null,
  },
  {
    id: 'crypto-options-v1',
    name: 'Options surface',
    page: 'Crypto',
    measures: 'Constant-maturity ATM implied vol, exact 25-delta risk reversal and butterfly, term slope, implied minus realized.',
    inputs: ['Deribit book summaries and DVOL', 'Yahoo closes for realized vol'],
    failureModes: [
      'Deribit only; CME open interest is absent.',
      'Mark IV is the exchange’s model mark, not a traded price.',
      'A tenor outside the listed expiries is missing rather than extrapolated.',
    ],
    trackRecord: null,
  },
  {
    id: 'treasury-funding-v1',
    name: 'Treasury funding',
    page: 'Macro',
    measures: 'Auction demand per tenor against its own history, daily TGA, daily net liquidity, debt growth, interest cost and maturity wall.',
    inputs: ['Treasury Fiscal Data: auctions, Daily Treasury Statement, Debt to the Penny, average rates, MSPD', 'FRED: WALCL, RRPONTSYD'],
    failureModes: [
      'Auction tails against the when-issued yield are not measured.',
      'A demand measure whose field is absent from the response is reported missing, not read as no signal.',
    ],
    trackRecord: null,
  },
  {
    id: 'factor-returns-v1',
    name: 'Factor returns',
    page: 'Equities',
    measures: 'Fama-French five factors and momentum, ranked against their history since 1963, with a track record of factor momentum: whether a factor coming off a positive year outperformed one coming off a negative year over the next one and three months.',
    inputs: ['Kenneth R. French Data Library'],
    failureModes: [
      'Published monthly with a lag of weeks; describes the regime that was, not this week.',
      'Academic long-short portfolios before costs; no fund earns them exactly.',
    ],
    trackRecord: 'factor-momentum-v1',
  },
  {
    id: 'price-crosscheck-v1',
    name: 'Price cross-check',
    page: 'Markets',
    measures: 'Each core symbol’s primary history against Yahoo: latest close, median and worst daily-return difference.',
    inputs: ['Twelve Data or stored history, CoinGecko', 'Yahoo'],
    failureModes: [
      'Without a Twelve Data key or database the primary is Yahoo itself and nothing is independently checked.',
      'Flags only; a disagreeing symbol is not yet withheld from models.',
    ],
    trackRecord: null,
  },
  {
    id: 'equity-verdict-v1',
    name: 'Equity verdict',
    page: 'Equities',
    measures: 'The equity regime’s own drivers, synthesized into a call with confidence from coverage, agreement and vintage.',
    inputs: ['equity-regime-v1 drivers'],
    failureModes: ['Inherits every failure mode of the regime drivers it summarizes.'],
    trackRecord: null,
  },
  {
    id: 'crypto-verdict-v1',
    name: 'Crypto verdict',
    page: 'Crypto',
    measures: 'Bitcoin price technicals (30%), perpetual funding inverted (18%), stablecoin supply growth (15%), the global liquidity impulse (20%) and the dollar inverted (17%) synthesized into a call. Valuation, drawdown and volatility are left out because their direction depends on the horizon.',
    inputs: ['Bitcoin technicals', 'Perpetual funding', 'DefiLlama stablecoin supply', 'Liquidity snapshot'],
    failureModes: [
      'Funding falls back across venues; with only one venue answering, the read rests on that venue alone.',
      'The technicals count only once every module is fully backed, so a short or gappy price history drops the heaviest leg.',
      'Its record is replayed without funding and stablecoin supply, which have no long history: it tests the three legs that do.',
    ],
    trackRecord: 'verdict-record-v1',
  },
  {
    id: 'metals-verdict-v1',
    name: 'Metals verdict',
    page: 'Metals',
    measures: 'Gold technicals (50%), the dollar model inverted (30%) and the global liquidity impulse (20%) synthesized into a call. Real yields enter through the dollar model rather than twice, and positioning is left out because a crowded long is support today and fragility tomorrow.',
    inputs: ['Gold futures technicals', 'Dollar strength model', 'Global liquidity model'],
    failureModes: ['Needs all three inputs: it refuses when fewer than three report, which a late BoJ release used to cause.'],
    trackRecord: 'verdict-record-v1',
  },
  {
    id: 'alert-outcomes-v1',
    name: 'Alert outcomes',
    page: 'Macro',
    measures: 'Each stored alert scored on the claim it implicitly makes - macro warnings against SPY lagging its typical return, screener breakouts against beating SPY, everything else against a larger-than-usual move - over 30 and 90 days.',
    inputs: ['Stored model alerts (PostgreSQL)', '5-year daily closes from Yahoo for SPY and each alerted asset'],
    failureModes: [
      'The claims are assigned here, not stated by the alerts: a warning scored as risk-off may have been meant as a timing note.',
      'The record starts when alert storage did, so for months it holds too few independent outcomes to say anything.',
      'Screener breakouts beyond the 60 most recent symbols are not loaded and go unscored.',
    ],
    trackRecord: null,
  },
  {
    id: 'index-valuation-v1',
    name: 'S&P 500 valuation (CAPE)',
    page: 'Equities',
    measures: 'CAPE computed from Shiller\u2019s raw monthly price, earnings and CPI since 1871, ranked against its own history, set against the real 10-year rate as an excess yield, and mapped to the ten-year real returns that followed similar excess yields.',
    inputs: ['Shiller monthly S&P Composite workbook (shillerdata.com)', 'FRED DFII10 10-year TIPS yield, for comparison'],
    failureModes: [
      'Ten-year windows overlap, so 150 years hold about fifteen independent decades; the fit statistics overstate the evidence and the out-of-sample test is a single split.',
      'Earnings lag the price by two to three quarters, so a fast fall in earnings is not yet in the multiple.',
      'Accounting, buybacks and sector mix have changed what a unit of earnings means; the since-1950 rank is shown for that reason.',
    ],
    trackRecord: null,
  },
  {
    id: 'screener-track-record-v1',
    name: 'Screener track record',
    page: 'Screener',
    measures: 'The screener score replayed monthly over five years: every S&P 500 member scored on closes available that day, split into fifths, each fifth\u2019s equal-weighted return over 30 and 90 days measured against SPY.',
    inputs: ['Five years of daily S&P 500 constituent closes and SPY (Yahoo spark)'],
    failureModes: [
      'Survivorship: today\u2019s index members only, so stocks that left the index after falling are missing from every past date.',
      'Equal-weighted and before costs; a top fifth that turns over every month would pay for it.',
      'Five years is one market regime or two; a momentum-heavy score has had long losing stretches in other decades.',
    ],
    trackRecord: 'screener-track-record-v1',
  },
  {
    id: 'fx-momentum-record-v1',
    name: 'Forex 20-session move track record',
    page: 'Forex',
    measures: 'The Forex outlook\u2019s rule - a currency\u2019s 20-session move against the dollar beyond \u00b10.5% labels it USD weak or USD strong - replayed on ten years of spot and followed 30 and 90 days, testing whether the move carries forward.',
    inputs: ['Ten years of daily Yahoo spot rates for seven currencies against the dollar'],
    failureModes: [
      'The currencies share the dollar leg; a dollar trend moves every label together.',
      'Spot only, before carry, so a high-yielder\u2019s steady drift lower can be paid for by its interest.',
    ],
    trackRecord: 'fx-momentum-record-v1',
  },
  {
    id: 'bitcoin-cycle-record-v1',
    name: 'Bitcoin cycle phase track record',
    page: 'Crypto',
    measures: 'The live cycle-phase model replayed weekly since bitcoin has 200 weeks of closes, each leg rebuilt from data up to that week, and followed 90, 180 and 365 days, testing whether capitulation has been followed by the best returns and euphoria by the worst.',
    inputs: ['Yahoo BTC-USD daily closes since 2014', 'bitcoin-data.com MVRV-Z and short-term-holder realized price histories'],
    failureModes: [
      'Replayed without the funding and stablecoin legs, which have no long history, so expansion and euphoria lean more on valuation and price than the live read.',
      'Two or three cycles in the replayable history: each phase rests on a handful of episodes.',
      'On-chain series are today\u2019s vintage.',
    ],
    trackRecord: 'bitcoin-cycle-record-v1',
  },
  {
    id: 'gold-silver-record-v1',
    name: 'Gold/silver ratio track record',
    page: 'Metals',
    measures: 'Every session since 2000 labeled by the metals panel\u2019s rule - the gold/silver ratio\u2019s percentile within its trailing year - and followed 30 and 90 days by silver\u2019s return minus gold\u2019s, testing whether extremes revert or persist.',
    inputs: ['Daily COMEX gold (GC) and silver (SI) front-month closes (Yahoo), since 2000'],
    failureModes: [
      'Year-long percentiles reach their extremes in runs; the extreme labels come in a few dozen episodes.',
      'Front-month futures roll each contract month.',
      'Mean reversion that held for two decades can stop when silver\u2019s industrial demand or gold\u2019s official buying shifts.',
    ],
    trackRecord: 'gold-silver-record-v1',
  },
  {
    id: 'vix-term-record-v1',
    name: 'VIX term structure track record',
    page: 'Equities',
    measures: 'Every session since 2007 labeled by VIX/VIX3M (contango, flat, backwardation) with the risk dashboard\u2019s thresholds, followed forward 30 and 90 days by SPY\u2019s return and its worst fall, through the shared track-record evaluator.',
    inputs: ['Daily CBOE VIX and VIX3M index closes and SPY (Yahoo), since December 2007'],
    failureModes: [
      'Backwardation comes in a handful of sell-offs; its sessions are many and its independent readings few.',
      'Each episode\u2019s path dominates its state: one crash that kept falling, or one that rebounded fast, moves the median.',
      'Price returns only, before dividends.',
    ],
    trackRecord: 'vix-term-record-v1',
  },
  {
    id: 'fx-carry-v1',
    name: 'Currency carry',
    page: 'Forex',
    measures: 'Each major currency\u2019s 3-month rate gap to the dollar, its carry per unit of realized volatility, and a monthly track record of the high-, middle- and low-carry groups\u2019 returns against the dollar including carry, with the high-minus-low trade\u2019s worst months.',
    inputs: ['FRED OECD 3-month interbank rates (IR3TIB01 series) for the U.S. and seven currencies, spliced after a 3-month series stops to the OECD overnight rate (IRSTCI01), for the euro then to the ECB deposit facility rate (ECBDFR), and for the U.S. to the 3-month T-bill (TB3MS)', 'Ten years of daily Yahoo spot rates against the dollar'],
    failureModes: [
      'Interbank rates are a proxy for the forward points a trade earns, and OECD publishes them weeks late.',
      'Seven currencies make two-currency groups; one central bank moves a whole group.',
      'Carry loses in sudden risk-off unwinds, which a decade holds only a few of.',
    ],
    trackRecord: 'fx-carry-v1',
  },
  {
    id: 'diversification-regime-v1',
    name: 'Diversification regime',
    page: 'Markets',
    measures: 'The 63- and 252-session stock-bond correlation (SPY, IEF) and the effective number of independent bets among six asset-class ETFs, with a track record of the 60/40 portfolio\u2019s worst drawdown over the next 30 and 90 days by stock-bond regime.',
    inputs: ['Ten years of daily SPY, EFA, EEM, IEF, GLD and DBC closes (Yahoo spark)'],
    failureModes: [
      'Ten years hold one shift from hedging to falling together (2022); the positive regime rests on few episodes.',
      'Correlations change fastest in the sell-offs a hedge is meant for.',
      'Intermediate Treasuries only; longer bonds hedge, and fail, by more.',
    ],
    trackRecord: 'diversification-regime-v1',
  },
  {
    id: 'bitcoin-cross-asset-v1',
    name: 'Bitcoin cross-asset regime',
    page: 'Crypto',
    measures: 'Rolling 90- and 252-session correlations of bitcoin\u2019s daily returns with the Nasdaq-100 and gold, a regime label from them, up- and down-day betas to QQQ, and how bitcoin moved on every Nasdaq fall of 2% or more, grouped by the regime of the session before.',
    inputs: ['Ten years of daily BTC-USD, QQQ and GLD closes (Yahoo spark)'],
    failureModes: [
      'Regimes change without warning; the label describes the last 90 sessions, not the next.',
      'Bitcoin\u2019s close is stamped four hours after the U.S. close, muting daily correlations slightly.',
      'Stress days cluster in a few sell-offs, so their count overstates the independent evidence.',
    ],
    trackRecord: null,
  },
  {
    id: 'gold-real-yield-v1',
    name: 'Gold against real yields',
    page: 'Metals',
    measures: 'Log gold regressed on the 10-year TIPS yield over the oldest 70% of months since 2003 and applied to the newest 30% it never saw: the gap between gold and the level real yields imply, whether that gap has left the fit\u2019s error band, and the 36-month correlation of monthly gold returns with real-yield changes.',
    inputs: ['Yahoo GC=F daily closes (COMEX front-month gold)', 'FRED DFII10 daily 10-year TIPS yield'],
    failureModes: [
      'A regression on the levels of two trending series flatters the fit; the held-out gap and the change correlation are the tests.',
      'One driver: the dollar and official-sector buying move gold too and are not in the model.',
      'Front-month futures roll each contract month, adding small steps that spot gold does not have.',
    ],
    trackRecord: null,
  },
  {
    id: 'recession-probability-v1',
    name: 'Recession probability from the yield curve',
    page: 'Macro',
    measures: 'The New York Fed\u2019s probit on the monthly 10-year less 3-month bill spread: the chance the U.S. is in recession twelve months ahead, refit here on NBER dates for 1959-2009 and on every month dated since, with each past signal judged by whether a recession followed within two years.',
    inputs: ['FRED GS10 monthly 10-year Treasury yield', 'FRED TB3MS monthly 3-month bill rate (discount basis, converted to bond-equivalent)', 'FRED USREC NBER recession months'],
    failureModes: [
      'Nine or so recessions since 1959: the evidence is a handful of episodes, however many months it spans.',
      'NBER dates recessions months late, so the latest year of outcomes cannot be scored and a recession already underway would not show.',
      'Term premia and policy regimes change what a given spread means; a deep inversion has been followed by no recession before.',
    ],
    trackRecord: null,
  },
  {
    id: 'portfolio-risk-v1',
    name: 'Watchlist as a portfolio',
    page: 'Watchlists',
    measures: 'A watchlist held in equal weights over the last year: how many independent bets it amounts to (N\u00b2 over the summed squared correlations), each position\u2019s share of the list\u2019s variance, beta and correlation to SPY, and the pairs that move most and least alike.',
    inputs: ['One to two years of daily closes for each listed symbol and SPY (Yahoo spark)'],
    failureModes: [
      'Equal weights, not actual position sizes: a small holding in a volatile name reads as a large share of the risk.',
      'Correlations measured in a calm year understate how alike positions become in a sell-off.',
      'Only dates every symbol shares count, so one recent listing shortens the window for the whole list.',
    ],
    trackRecord: null,
  },
];

export function registryEntry(id) {
  return MODEL_REGISTRY.find((entry) => entry.id === id) ?? null;
}
