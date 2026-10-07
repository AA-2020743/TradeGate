/**
 * One point per UTC day, the earliest stamped.
 *
 * CoinGecko's daily history ends with a live price stamped with the current
 * time. The history job stored that point every day it ran and nothing
 * removed it, so the stored bitcoin series held each day's 00:00 close plus a
 * stray mid-day price per ingestion day. Moving averages and RSI counted the
 * strays as extra sessions, and the price cross-check set one source's
 * mid-day price against the other's close. The earliest point of a day is the
 * daily one for every provider here: 00:00 for CoinGecko and Twelve Data, the
 * session open stamp for Yahoo.
 */
export function onePointPerDay(points) {
  const byDay = new Map();
  for (const point of points ?? []) {
    const stamp = point?.timestamp ?? point?.date;
    const time = Date.parse(stamp);
    if (!Number.isFinite(time)) continue;
    const day = new Date(time).toISOString().slice(0, 10);
    const existing = byDay.get(day);
    if (!existing || time < existing.time) byDay.set(day, { time, point });
  }
  return [...byDay.values()].sort((left, right) => left.time - right.time).map((entry) => entry.point);
}
