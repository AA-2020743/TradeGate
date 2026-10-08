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
    trackRecord: null,
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
    measures: 'Fama-French five factors and momentum, ranked against their history since 1963.',
    inputs: ['Kenneth R. French Data Library'],
    failureModes: [
      'Published monthly with a lag of weeks; describes the regime that was, not this week.',
      'Academic long-short portfolios before costs; no fund earns them exactly.',
    ],
    trackRecord: null,
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
    measures: 'Bitcoin cycle, positioning, funding and macro legs synthesized into a call.',
    inputs: ['Bitcoin workspace legs', 'Liquidity snapshot'],
    failureModes: [
      'Funding falls back across venues; with only one venue answering, the read rests on that venue alone.',
      'On-chain legs depend on bitcoin-data.com, which rate-limits; a reused reading is labelled provisional.',
    ],
    trackRecord: null,
  },
  {
    id: 'metals-verdict-v1',
    name: 'Metals verdict',
    page: 'Metals',
    measures: 'Gold trend, real yields, dollar, global liquidity and positioning synthesized into a call.',
    inputs: ['Metals workspace', 'Liquidity snapshot', 'CFTC COT'],
    failureModes: ['Refuses when fewer than three inputs report, which a late BoJ release used to cause.'],
    trackRecord: null,
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
];

export function registryEntry(id) {
  return MODEL_REGISTRY.find((entry) => entry.id === id) ?? null;
}
