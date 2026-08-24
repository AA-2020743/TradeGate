const DAY_MS = 86_400_000;

const FRED_MAX_OBSERVATION_AGE_DAYS = {
  WALCL: 14,
  WTREGEN: 14,
  RRPONTSYD: 7,
  M2SL: 100,
  DGS2: 7,
  DFII10: 7,
  NFCI: 14,
  BAMLH0A0HYM2: 7,
  VIXCLS: 7,
  ECBASSETSW: 21,
  JPNASSETS: 60,
  // The H.10 family is daily-frequency but weekly-released: FRED publishes the
  // prior week's daily rates in one batch, so the newest observation ages from
  // 3 days just after a release to exactly 10 the day before the next one - and
  // to 11 when a holiday pushes the release to Tuesday. A 10-day tolerance was
  // therefore the worst case of the normal cycle, which meant these went stale
  // every week and silently took the dollar leg out of the liquidity models
  // with them. 16 leaves room for a holiday-shortened week while still
  // catching a genuine outage.
  DEXUSEU: 16,
  DEXJPUS: 16,
  DEXCHUS: 16,
  DTWEXBGS: 16,
  DGS10: 7,
  DGS3MO: 7,
  T5YIFR: 7,
  T5YIE: 7,
  T10YIE: 7,
  // CPI is monthly and released with a two-to-three week lag, so a 60-day
  // ceiling is a genuine outage rather than a slow month.
  CPIAUCSL: 60,
  THREEFYTP10: 14,
  SOFR: 7,
  IORB: 10,
  // OECD long-rate series are monthly and land with a lag of weeks.
  IRLTLT01DEM156N: 90,
  IRLTLT01JPM156N: 90,
  IRLTLT01GBM156N: 90,
  PAYEMS: 60,
  ICSA: 14,
  INDPRO: 60,
  RSAFS: 70,
};

export const PBOC_MAX_OBSERVATION_AGE_DAYS = 560;

export function isPbocObservationStale(date, now = Date.now()) {
  if (!date) return true;
  const timestamp = new Date(`${date}T00:00:00.000Z`).getTime();
  return !Number.isFinite(timestamp) || now - timestamp > (PBOC_MAX_OBSERVATION_AGE_DAYS * DAY_MS);
}

export function monthsBetween(date, now = Date.now()) {
  if (!date) return null;
  const timestamp = new Date(`${date}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.round((now - timestamp) / (30.44 * DAY_MS)));
}

export function isCotReportStale(date, now = Date.now()) {
  if (!date) return true;
  const timestamp = new Date(`${date}T00:00:00.000Z`).getTime();
  return !Number.isFinite(timestamp) || now - timestamp > (21 * DAY_MS);
}

export function isFredSeriesStale(id, date, now = Date.now()) {
  if (!date) return true;
  const timestamp = new Date(`${date}T00:00:00.000Z`).getTime();
  return !Number.isFinite(timestamp) || now - timestamp > ((FRED_MAX_OBSERVATION_AGE_DAYS[id] ?? 14) * DAY_MS);
}

// How long a series can normally go between prints before the next one is
// genuinely late. These are wider than the nominal cadence on purpose: a
// business-daily series is four days old over a long weekend without anything
// being wrong, and the Fed's H.10 releases land weekly for the prior week.
const FRED_EXPECTED_WITHIN_DAYS = {
  WALCL: 9,
  WTREGEN: 4,
  RRPONTSYD: 4,
  M2SL: 40,
  DGS2: 4,
  DFII10: 4,
  NFCI: 9,
  BAMLH0A0HYM2: 4,
  VIXCLS: 4,
  ECBASSETSW: 12,
  JPNASSETS: 45,
  // Weekly release of daily rates: 10 days between prints is the normal top of
  // the cycle, not a late print.
  DEXUSEU: 11,
  DEXJPUS: 11,
  DEXCHUS: 11,
  DTWEXBGS: 11,
  DGS10: 4,
  DGS3MO: 4,
  T5YIFR: 4,
  T5YIE: 4,
  T10YIE: 4,
  CPIAUCSL: 45,
  THREEFYTP10: 9,
  SOFR: 4,
  IORB: 7,
  IRLTLT01DEM156N: 60,
  IRLTLT01JPM156N: 60,
  IRLTLT01GBM156N: 60,
  PAYEMS: 45,
  ICSA: 9,
  INDPRO: 45,
  RSAFS: 50,
};

/**
 * Separates a series that is simply between prints from one whose next print is
 * genuinely late. Age alone cannot tell them apart: a monthly series at 45 days
 * is on schedule while a weekly one at 12 is overdue, and rendering both as an
 * age in days makes a data outage look identical to a quiet month.
 */
export function describeSeriesFreshness(id, date, now = Date.now()) {
  const maxAgeDays = FRED_MAX_OBSERVATION_AGE_DAYS[id] ?? 14;
  const expectedWithinDays = FRED_EXPECTED_WITHIN_DAYS[id] ?? Math.max(1, Math.round(maxAgeDays / 2));
  if (!date) {
    return { id, state: 'stale', ageDays: null, expectedWithinDays, maxAgeDays, read: 'No observation date was returned.' };
  }
  const timestamp = new Date(`${date}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(timestamp)) {
    return { id, state: 'stale', ageDays: null, expectedWithinDays, maxAgeDays, read: 'The observation date could not be read.' };
  }
  const ageDays = Math.max(0, Math.floor((now - timestamp) / DAY_MS));
  const state = ageDays >= maxAgeDays ? 'stale' : ageDays > expectedWithinDays ? 'overdue' : 'current';
  const reads = {
    current: `${ageDays} ${ageDays === 1 ? 'day' : 'days'} old, within this series' normal ${expectedWithinDays}-day publication gap.`,
    overdue: `${ageDays} days old against a normal ${expectedWithinDays}-day gap, so the next print is late but the series is still inside the ${maxAgeDays}-day tolerance and remains in the models.`,
    stale: `${ageDays} days old, past the ${maxAgeDays}-day tolerance, so it is excluded from the models.`,
  };
  return { id, state, ageDays, expectedWithinDays, maxAgeDays, read: reads[state] };
}

export function isDailyCloseStale(timestamp, now = Date.now()) {
  const observedAt = new Date(timestamp).getTime();
  return !Number.isFinite(observedAt) || now - observedAt > 5 * DAY_MS;
}

/**
 * CoinGecko's market_chart picks its own granularity from the window asked
 * for: five-minute inside a day, hourly out to 90 days, and daily beyond that,
 * stamped at 00:00 UTC. A staleness tolerance has to exceed the cadence of
 * whatever actually came back.
 */
export function cryptoHistoryGranularity(days) {
  if (days === 'max') return 'daily';
  const window = Number(days);
  if (!Number.isFinite(window)) return 'daily';
  if (window <= 1) return 'intraday';
  return window <= 90 ? 'hourly' : 'daily';
}

const CRYPTO_MAX_OBSERVATION_AGE_HOURS = {
  intraday: 6,
  hourly: 12,
  // A daily series is up to 24 hours old the moment it arrives, so a 24-hour
  // tolerance is the cadence itself and trips near the end of every UTC day -
  // the same fault the H.10 tolerance had. 48 leaves a full cycle of room.
  daily: 48,
};

export function isCryptoHistoryStale(timestamp, now = Date.now(), granularity = 'daily') {
  const observedAt = new Date(timestamp).getTime();
  if (!Number.isFinite(observedAt)) return true;
  const maxAgeHours = CRYPTO_MAX_OBSERVATION_AGE_HOURS[granularity] ?? CRYPTO_MAX_OBSERVATION_AGE_HOURS.daily;
  return now - observedAt > (maxAgeHours * 60 * 60_000);
}
