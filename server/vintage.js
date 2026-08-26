/**
 * How current a composite actually is.
 *
 * A composite is only as current as its stalest binding input, but the obvious
 * thing to write is `dates.sort().at(-1)` - the newest - and that is what four
 * models here did. It lets one fresh leg hide another that stopped updating: a
 * positioning model whose gold contract last printed in March still claimed
 * today's date, because the FX contracts beside it were current.
 *
 * Dates also arrive in two shapes across this codebase, an ISO timestamp and a
 * plain YYYY-MM-DD, and comparing those as strings gets the same day backwards:
 * "2026-08-20" sorts before "2026-08-20T00:00:00.000Z" because the shorter
 * string is a prefix of the longer. They are compared as instants instead.
 */

const DAY_MS = 86_400_000;

function instantOf(asOf) {
  if (typeof asOf !== 'string' || !asOf) return Number.NaN;
  return Date.parse(asOf.length === 10 ? `${asOf}T00:00:00.000Z` : asOf);
}

/**
 * @param {Array<{ name?: string, asOf?: string|null }>} inputs
 * @returns {{ asOf: string|null, asOfSource: string|null, asOfSpreadDays: number|null }}
 */
export function resolveVintage(inputs) {
  const dated = (inputs ?? [])
    .flatMap((entry) => {
      const at = instantOf(entry?.asOf);
      return Number.isFinite(at) ? [{ name: entry.name ?? null, asOf: entry.asOf, at }] : [];
    })
    .sort((left, right) => left.at - right.at);

  const oldest = dated[0] ?? null;
  return {
    asOf: oldest?.asOf ?? null,
    // Which input is holding the composite back, and how far apart the inputs
    // are - a wide spread is itself worth seeing.
    asOfSource: oldest?.name ?? null,
    asOfSpreadDays: dated.length > 1 ? Math.round((dated.at(-1).at - dated[0].at) / DAY_MS) : null,
  };
}

/** The stalest of a set of dates, for callers that only need the date. */
export function oldestAsOf(dates) {
  return resolveVintage((dates ?? []).map((asOf) => ({ asOf }))).asOf;
}
