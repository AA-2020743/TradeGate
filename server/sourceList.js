/**
 * The external sources `npm run check:sources` exercises: each loader, a key
 * figure, and the plausible range of the values that matter.
 */
import {
  getAccumulationSchedules,
  getAlertOutcomes,
  getBitcoinCycleWorkspace,
  getCryptoOptionsWorkspace,
  getFactorReturns,
  getIndexValuation,
  getLiquiditySnapshot,
  getMarketSnapshot,
  getPriceCrossCheck,
  getScreenerTrackRecord,
  getTreasuryFunding,
} from './providers.js';

const seriesValue = (payload, key) => {
  const series = (payload.series ?? []).find((entry) => entry.key === key);
  return Number.isFinite(series?.value) ? series.value * (series.multiplier ?? 1) : null;
};
const asset = (payload, key) => (payload.assets ?? []).find((entry) => entry.key === key);
const schedule = (payload, key) => (payload.schedules ?? []).find((entry) => entry.key === key);
const surface = (payload, currency) => (payload.surfaces ?? []).find((entry) => entry.currency === currency);
const tenor = (entry, days) => (entry?.tenors ?? []).find((item) => item.days === days);

export const SOURCES = [
  {
    name: 'FRED macro series',
    endpoint: '/api/macro/liquidity',
    load: getLiquiditySnapshot,
    answered: (payload) => payload.provider.failedSeries === 0 && payload.provider.abandonedSeries === 0,
    figure: (payload) => `${payload.provider.requestedSeries - payload.provider.failedSeries} of ${payload.provider.requestedSeries} series fetched (${payload.provider.mode}), ${payload.provider.staleSeries} stale, ${payload.provider.abandonedSeries} abandoned`,
    plausible: (payload) => [
      { label: 'net liquidity', value: payload.netLiquidity / 1e6, min: 2, max: 12, unit: 'T' },
      { label: '10y yield', value: seriesValue(payload, 'us10yYield'), min: 0, max: 12, unit: '%' },
      { label: 'Fed balance sheet', value: seriesValue(payload, 'fedBalanceSheet') / 1e6, min: 3, max: 12, unit: 'T' },
    ],
  },
  {
    name: 'Market quotes (Twelve Data, CoinGecko)',
    endpoint: '/api/markets/snapshot',
    load: getMarketSnapshot,
    answered: (payload) => (payload.assets ?? []).some((asset) => Number.isFinite(asset.price)),
    figure: (payload) => `${(payload.assets ?? []).filter((asset) => Number.isFinite(asset.price)).length} assets priced`,
    plausible: (payload) => [
      { label: 'SPY', value: asset(payload, 'SPY')?.price, min: 100, max: 3000 },
      { label: 'DXY', value: asset(payload, 'DXY')?.price, min: 60, max: 160 },
      { label: 'BTC', value: asset(payload, 'BTC')?.price, min: 1000, max: 1000000 },
    ],
  },
  {
    name: 'Yahoo 10-year histories (DCA)',
    endpoint: '/api/analytics/accumulation',
    load: getAccumulationSchedules,
    figure: (payload) => `${(payload.schedules ?? []).filter((schedule) => schedule.status !== 'unavailable').length} of ${(payload.schedules ?? []).length} assets ranked, as of ${payload.asOf ?? 'n/a'}`,
    plausible: (payload) => [
      { label: 'gold', value: schedule(payload, 'gold')?.price, min: 500, max: 20000 },
      { label: 'S&P 500', value: schedule(payload, 'spx')?.price, min: 1000, max: 30000 },
      { label: 'gold risk', value: schedule(payload, 'gold')?.risk, min: 0, max: 100 },
    ],
  },
  {
    name: 'Shiller S&P data (valuation)',
    endpoint: '/api/analytics/index-valuation',
    load: getIndexValuation,
    figure: (payload) => (Number.isFinite(payload.cape) ? `CAPE ${payload.cape} for ${payload.asOf}, earnings through ${payload.earningsThrough}; from ${payload.source}` : null),
    plausible: (payload) => [
      { label: 'CAPE', value: payload.cape, min: 5, max: 80 },
      { label: 'earnings yield', value: payload.earningsYield, min: 1, max: 20, unit: '%' },
      { label: 'implied 10y real return', value: payload.outlook?.impliedRealReturn, min: -10, max: 20, unit: '%' },
    ],
  },
  {
    name: 'Deribit options',
    endpoint: '/api/analytics/crypto-options',
    load: getCryptoOptionsWorkspace,
    figure: (payload) => (payload.surfaces ?? []).map((surface) => `${surface.currency} ${surface.status}`).join(', ') || null,
    plausible: (payload) => [
      { label: 'BTC 30d ATM vol', value: tenor(surface(payload, 'BTC'), 30)?.atmIv, min: 10, max: 250, unit: '%' },
      { label: 'ETH 30d ATM vol', value: tenor(surface(payload, 'ETH'), 30)?.atmIv, min: 10, max: 300, unit: '%' },
      { label: 'BTC 30d 25d risk reversal', value: tenor(surface(payload, 'BTC'), 30)?.riskReversal25, min: -40, max: 40, unit: ' vol pts' },
      { label: 'BTC spot', value: surface(payload, 'BTC')?.spot, min: 1000, max: 1000000 },
    ],
  },
  {
    name: 'Treasury Fiscal Data',
    endpoint: '/api/macro/treasury',
    load: getTreasuryFunding,
    figure: () => null,
    plausible: (payload) => [
      { label: 'TGA cash', value: payload.cash?.billions, min: 50, max: 2000, unit: 'B' },
      { label: 'total debt', value: payload.debt?.totalTrillions, min: 20, max: 60, unit: 'T' },
      { label: 'average interest rate', value: payload.interest?.averageRate, min: 0.5, max: 8, unit: '%' },
      { label: 'daily net liquidity', value: payload.net?.trillions, min: 2, max: 12, unit: 'T' },
      { label: 'weighted maturity', value: payload.wall?.weightedYearsToMaturity, min: 2, max: 12, unit: 'y' },
    ],
  },
  {
    name: 'Ken French factors',
    endpoint: '/api/analytics/factors',
    load: getFactorReturns,
    figure: (payload) => (payload.asOf ? `through ${String(payload.asOf).slice(0, 10)}` : null),
    plausible: (payload) => {
      const market = (payload.factors ?? []).find((factor) => factor.key === 'Mkt-RF' || factor.name === 'Mkt-RF');
      return [
        { label: 'market long-run return', value: market?.longRunAnnualPercent, min: 2, max: 16, unit: '%' },
        { label: 'market long-run vol', value: market?.longRunVolatilityPercent, min: 8, max: 30, unit: '%' },
      ];
    },
  },
  {
    name: 'Bitcoin workspace (derivatives venues, on-chain)',
    endpoint: '/api/analytics/bitcoin',
    load: getBitcoinCycleWorkspace,
    figure: (payload) => (payload.leverage?.venue ? `funding from ${payload.leverage.venue}` : null),
    plausible: (payload) => [
      { label: 'funding (annualized)', value: payload.leverage?.annualizedPercent, min: -100, max: 200, unit: '%' },
      { label: 'MVRV Z', value: payload.valuation?.mvrvZ, min: -3, max: 12 },
      { label: 'price', value: payload.trend?.price, min: 1000, max: 1000000 },
    ],
  },
  {
    name: 'Price cross-check (primary vs Yahoo)',
    endpoint: '/api/analytics/price-crosscheck',
    load: getPriceCrossCheck,
    figure: (payload) => `${payload.passed?.length ?? 0} verified, ${payload.review?.length ?? 0} under review, ${payload.notIndependent?.length ?? 0} not independent, ${payload.unavailable?.length ?? 0} unavailable`,
  },
  {
    name: 'Yahoo 5-year constituent closes (screener record)',
    endpoint: '/api/analytics/screener-track-record',
    load: getScreenerTrackRecord,
    figure: (payload) => (Number.isFinite(payload.replayDates) ? `${payload.historiesReceived} of ${payload.universeSize} members, ${payload.replayDates} monthly replays from ${payload.from}` : null),
    plausible: (payload) => [
      { label: 'members with 5y history', value: payload.historiesReceived, min: 300, max: 520 },
      { label: 'monthly replays', value: payload.replayDates, min: 30, max: 70 },
    ],
  },
  {
    name: 'Stored alerts (PostgreSQL) + outcomes',
    endpoint: '/api/analytics/alert-outcomes',
    load: getAlertOutcomes,
    figure: (payload) => (Number.isFinite(payload.alerts) ? `${payload.alerts} alerts stored, ${payload.scoredAlerts ?? 0} scorable` : null),
  },
];
