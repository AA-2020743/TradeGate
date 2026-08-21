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
  DEXUSEU: 10,
  DEXJPUS: 10,
  DEXCHUS: 10,
  DTWEXBGS: 10,
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

export function isDailyCloseStale(timestamp, now = Date.now()) {
  const observedAt = new Date(timestamp).getTime();
  return !Number.isFinite(observedAt) || now - observedAt > 5 * DAY_MS;
}

export function isCryptoHistoryStale(timestamp, now = Date.now()) {
  const observedAt = new Date(timestamp).getTime();
  return !Number.isFinite(observedAt) || now - observedAt > DAY_MS;
}
