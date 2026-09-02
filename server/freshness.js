const DAY_MS = 86_400_000;

/**
 * When each series is actually published, rather than how old we are willing to
 * let it get.
 *
 * The tolerances used to be hand-picked per series, and hand-picking them meant
 * six of them landed *inside* the series' own normal release cycle - so the
 * series went stale on schedule, every cycle, and was deleted from the models
 * for the days between its last print and its next one. The H.10 dollar family
 * was found doing this first; auditing the rest turned up the same fault in
 * every monthly series, and worse, because of how monthly observations are
 * dated.
 *
 * The trap is `datedAt`. A weekly series labelled with the last day it covers
 * is at most one cadence plus the publication lag old. A monthly series
 * labelled with the *first* day of the month it covers is one full month older
 * than that before the next print even happens:
 *
 *   datedAt 'end'   -> worst normal age = cadence + lag
 *   datedAt 'start' -> worst normal age = (2 x cadence) + lag
 *
 * BoJ total assets is monthly, dated at month start, published about five days
 * after the month closes. Its worst normal age is therefore 66 days, and the
 * tolerance was 60 - so on any day in the week before the release it was
 * "stale", was dropped, and took the entire global liquidity pool down with it
 * because the BoJ leg is mandatory. That is not an outage; that is the calendar.
 */
const FRED_RELEASE = {
  // Business-daily series: over a long weekend the newest print is legitimately
  // four days old without anything being wrong.
  DGS2: { cadenceDays: 4, lagDays: 1, datedAt: 'end' },
  DGS10: { cadenceDays: 4, lagDays: 1, datedAt: 'end' },
  DGS3MO: { cadenceDays: 4, lagDays: 1, datedAt: 'end' },
  DFII10: { cadenceDays: 4, lagDays: 1, datedAt: 'end' },
  T5YIE: { cadenceDays: 4, lagDays: 1, datedAt: 'end' },
  T5YIFR: { cadenceDays: 4, lagDays: 1, datedAt: 'end' },
  T10YIE: { cadenceDays: 4, lagDays: 1, datedAt: 'end' },
  VIXCLS: { cadenceDays: 4, lagDays: 1, datedAt: 'end' },
  BAMLH0A0HYM2: { cadenceDays: 4, lagDays: 1, datedAt: 'end' },
  RRPONTSYD: { cadenceDays: 4, lagDays: 1, datedAt: 'end' },
  SOFR: { cadenceDays: 4, lagDays: 1, datedAt: 'end' },
  IORB: { cadenceDays: 4, lagDays: 1, datedAt: 'end' },
  THREEFYTP10: { cadenceDays: 4, lagDays: 4, datedAt: 'end' },

  // The H.10 family is daily-frequency but weekly-released: FRED publishes the
  // prior week's daily rates in one batch, so the release cadence rather than
  // the observation cadence is what ages the newest print.
  DEXUSEU: { cadenceDays: 7, lagDays: 4, datedAt: 'end' },
  DEXJPUS: { cadenceDays: 7, lagDays: 4, datedAt: 'end' },
  DEXCHUS: { cadenceDays: 7, lagDays: 4, datedAt: 'end' },
  DTWEXBGS: { cadenceDays: 7, lagDays: 4, datedAt: 'end' },

  // Weekly series, each dated with the day it describes.
  WALCL: { cadenceDays: 7, lagDays: 2, datedAt: 'end' },
  WTREGEN: { cadenceDays: 7, lagDays: 1, datedAt: 'end' },
  NFCI: { cadenceDays: 7, lagDays: 5, datedAt: 'end' },
  ICSA: { cadenceDays: 7, lagDays: 5, datedAt: 'end' },
  // The ECB's weekly financial statement covers Friday and lands the following
  // Tuesday, and it skips prints around the turn of the year.
  ECBASSETSW: { cadenceDays: 7, lagDays: 6, datedAt: 'end' },

  // Monthly series, all dated at the start of the month they describe. These
  // are the ones the old table got wrong.
  JPNASSETS: { cadenceDays: 30.44, lagDays: 5, datedAt: 'start' },
  PAYEMS: { cadenceDays: 30.44, lagDays: 5, datedAt: 'start' },
  CPIAUCSL: { cadenceDays: 30.44, lagDays: 12, datedAt: 'start' },
  INDPRO: { cadenceDays: 30.44, lagDays: 16, datedAt: 'start' },
  RSAFS: { cadenceDays: 30.44, lagDays: 16, datedAt: 'start' },
  M2SL: { cadenceDays: 30.44, lagDays: 25, datedAt: 'start' },
  // OECD long rates are compiled from national sources and land weeks late.
  IRLTLT01DEM156N: { cadenceDays: 30.44, lagDays: 45, datedAt: 'start' },
  IRLTLT01JPM156N: { cadenceDays: 30.44, lagDays: 45, datedAt: 'start' },
  IRLTLT01GBM156N: { cadenceDays: 30.44, lagDays: 45, datedAt: 'start' },
};

const DEFAULT_RELEASE = { cadenceDays: 4, lagDays: 1, datedAt: 'end' };

/** The oldest the newest observation gets without a release being late. */
export function normalPublicationGapDays(id) {
  const release = FRED_RELEASE[id] ?? DEFAULT_RELEASE;
  const cadences = release.datedAt === 'start' ? 2 : 1;
  return Math.ceil((release.cadenceDays * cadences) + release.lagDays);
}

/**
 * The staleness tolerance, derived rather than chosen: the worst age the normal
 * cycle produces, plus a third again for a release that slips a few days. Being
 * derived is the point - a tolerance can no longer be set to a number that
 * happens to equal the cadence it is supposed to sit outside of.
 */
export function maxObservationAgeDays(id) {
  return Math.ceil(normalPublicationGapDays(id) * 1.35) + 2;
}

/**
 * Far enough past the tolerance that the series is presumed dead rather than
 * late. Between stale and abandoned a series still has usable history - a
 * 91-day change measured over its own last observations is a real change, just
 * an old one - so it keeps feeding the models that read history while its
 * vintage is published. Past this, it is removed.
 */
export function abandonedAfterDays(id) {
  return Math.max(maxObservationAgeDays(id) * 3, 45);
}

function ageDaysOf(date, now) {
  if (!date) return null;
  const timestamp = new Date(`${date}T00:00:00.000Z`).getTime();
  return Number.isFinite(timestamp) ? (now - timestamp) / DAY_MS : null;
}

export function isFredSeriesStale(id, date, now = Date.now()) {
  const age = ageDaysOf(date, now);
  return age === null || age > maxObservationAgeDays(id);
}

/** A series this far behind is not late, it has stopped. */
export function isFredSeriesAbandoned(id, date, now = Date.now()) {
  const age = ageDaysOf(date, now);
  return age === null || age > abandonedAfterDays(id);
}

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


/**
 * Separates a series that is simply between prints from one whose next print is
 * genuinely late. Age alone cannot tell them apart: a monthly series at 45 days
 * is on schedule while a weekly one at 12 is overdue, and rendering both as an
 * age in days makes a data outage look identical to a quiet month.
 */
export function describeSeriesFreshness(id, date, now = Date.now()) {
  const maxAgeDays = maxObservationAgeDays(id);
  const expectedWithinDays = normalPublicationGapDays(id);
  const abandonedDays = abandonedAfterDays(id);
  if (!date) {
    return { id, state: 'stale', ageDays: null, expectedWithinDays, maxAgeDays, abandonedDays, read: 'No observation date was returned.' };
  }
  const timestamp = new Date(`${date}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(timestamp)) {
    return { id, state: 'stale', ageDays: null, expectedWithinDays, maxAgeDays, abandonedDays, read: 'The observation date could not be read.' };
  }
  const ageDays = Math.max(0, Math.floor((now - timestamp) / DAY_MS));
  const state = ageDays > abandonedDays ? 'abandoned'
    : ageDays > maxAgeDays ? 'stale'
      : ageDays > expectedWithinDays ? 'overdue' : 'current';
  const reads = {
    current: `${ageDays} ${ageDays === 1 ? 'day' : 'days'} old, within this series' normal ${expectedWithinDays}-day publication gap.`,
    overdue: `${ageDays} days old against a normal ${expectedWithinDays}-day gap, so the next print is late but the series is still inside the ${maxAgeDays}-day tolerance and remains in the models.`,
    // It is no longer dropped here, so it must not say it is. It keeps feeding
    // the models that read its history, and the reading it carries is dated.
    stale: `${ageDays} days old, past the ${maxAgeDays}-day tolerance. Its latest value is no longer treated as current, but its history still feeds the models that measure change, and their vintage says so.`,
    abandoned: `${ageDays} days old, past the ${abandonedDays}-day point where a series is presumed to have stopped rather than to be running late, so it is excluded from the models.`,
  };
  return { id, state, ageDays, expectedWithinDays, maxAgeDays, abandonedDays, read: reads[state] };
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
