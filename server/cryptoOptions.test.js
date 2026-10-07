import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCryptoOptionsSurface, constantMaturity, forwardDelta, maxPain, parseInstrument, realizedVolatility, summarizeExpiry } from './cryptoOptions.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 7, 2, 0);
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function expiryCode(ms) {
  const date = new Date(ms);
  return `${date.getUTCDate()}${MONTHS[date.getUTCMonth()]}${String(date.getUTCFullYear()).slice(2)}`;
}

/**
 * A chain generated from a known smile, iv(k) = base + skew*k + curve*k^2 with
 * k = ln(K/F), so the right answer at any delta can be solved for exactly and
 * compared against what the model interpolates.
 */
function chain({ currency = 'BTC', days, forward = 85_000, base, skew = -25, curve = 40, step = 1000, width = 0.45, openInterest = () => 10 }) {
  const expiry = Date.UTC(new Date(NOW + days * DAY).getUTCFullYear(), new Date(NOW + days * DAY).getUTCMonth(), new Date(NOW + days * DAY).getUTCDate(), 8);
  const rows = [];
  for (let strike = Math.round(forward * (1 - width) / step) * step; strike <= forward * (1 + width); strike += step) {
    const k = Math.log(strike / forward);
    const iv = base + (skew * k) + (curve * k * k);
    for (const type of ['C', 'P']) {
      rows.push({ instrument_name: `${currency}-${expiryCode(expiry)}-${strike}-${type}`, mark_iv: iv, underlying_price: forward, open_interest: openInterest(strike, type) });
    }
  }
  return { rows, expiry };
}

/** Solve the generating smile for the IV at an exact delta, by bisection on strike. */
function trueIvAtDelta({ forward, base, skew, curve, years, target, type }) {
  const ivAt = (strike) => { const k = Math.log(strike / forward); return base + (skew * k) + (curve * k * k); };
  let low = forward * 0.3;
  let high = forward * 3;
  for (let step = 0; step < 200; step += 1) {
    const mid = (low + high) / 2;
    const delta = forwardDelta({ forward, strike: mid, years, ivPercent: ivAt(mid), type });
    // Both call and put deltas fall as strike rises.
    if (delta > target) low = mid; else high = mid;
  }
  return ivAt((low + high) / 2);
}

test('instrument names parse to expiry at 08:00 UTC, strike and type', () => {
  const parsed = parseInstrument('BTC-27DEC26-100000-C');
  assert.equal(parsed.currency, 'BTC');
  assert.equal(parsed.strike, 100000);
  assert.equal(parsed.type, 'C');
  assert.equal(new Date(parsed.expiry).toISOString(), '2026-12-27T08:00:00.000Z');
  assert.equal(parseInstrument('BTC-PERPETUAL'), null);
  assert.equal(parseInstrument('BTC-27DEC26-100000-X'), null);
});

test('an at-the-forward call has delta just above one half, and put = call - 1', () => {
  const call = forwardDelta({ forward: 100, strike: 100, years: 0.25, ivPercent: 60, type: 'C' });
  const put = forwardDelta({ forward: 100, strike: 100, years: 0.25, ivPercent: 60, type: 'P' });
  assert.ok(call > 0.5 && call < 0.6);
  assert.ok(Math.abs((call - 1) - put) < 1e-12);
});

test('25-delta wings are interpolated to exactly 25 delta, not the nearest strike', () => {
  // Wide strike spacing makes the nearest listed strike land well away from
  // 0.25 - the case where a nearest-strike pick compares a 0.27-delta call
  // with a 0.31-delta put and calls the difference skew.
  const spec = { days: 30, base: 55, skew: -30, curve: 50, step: 2500 };
  const { rows, expiry } = chain(spec);
  const parsed = rows.map((row) => ({ ...parseInstrument(row.instrument_name), iv: row.mark_iv, underlying: row.underlying_price, openInterest: row.open_interest }));
  const summary = summarizeExpiry(parsed, expiry, NOW);
  const years = (expiry - NOW) / (365 * DAY);
  const call25 = trueIvAtDelta({ forward: 85_000, base: spec.base, skew: spec.skew, curve: spec.curve, years, target: 0.25, type: 'C' });
  const put25 = trueIvAtDelta({ forward: 85_000, base: spec.base, skew: spec.skew, curve: spec.curve, years, target: -0.25, type: 'P' });
  // Linear interpolation across 2,500-wide strikes on a curved smile is not
  // exact, but it is within a few hundredths of a vol point.
  assert.ok(Math.abs(summary.call25Iv - call25) < 0.1, `call25 ${summary.call25Iv} vs true ${call25.toFixed(3)}`);
  assert.ok(Math.abs(summary.put25Iv - put25) < 0.1, `put25 ${summary.put25Iv} vs true ${put25.toFixed(3)}`);
  assert.ok(Math.abs(summary.riskReversal25 - (call25 - put25)) < 0.15);
  // Negative skew in the generator means puts over calls.
  assert.ok(summary.riskReversal25 < 0);
  assert.ok(Math.abs(summary.atmIv - spec.base) < 0.05, `ATM ${summary.atmIv} vs ${spec.base}`);
});

test('constant maturity interpolates total variance, not vol', () => {
  // 20 days at 70 vol and 40 days at 50 vol. Interpolating vol would say 60 at
  // 30 days; the variance-consistent answer is sqrt((0.49*20 + 0.25*40)/2/30).
  const expiries = [{ days: 20, atmIv: 70 }, { days: 40, atmIv: 50 }];
  const expected = Math.sqrt(((0.49 * 20) + (0.25 * 40)) / 2 / 30) * 100;
  assert.equal(constantMaturity(expiries, 30, 'atmIv'), Math.round(expected * 100) / 100);
  assert.notEqual(constantMaturity(expiries, 30, 'atmIv'), 60);
});

test('a tenor outside the listed range is missing, not extrapolated', () => {
  const expiries = [{ days: 10, atmIv: 50 }, { days: 20, atmIv: 52 }];
  assert.equal(constantMaturity(expiries, 30, 'atmIv'), null);
  assert.equal(constantMaturity(expiries, 7, 'atmIv'), null);
});

test('an expiry inside two days never anchors a tenor', () => {
  // A one-day expiry at a pinned 120 vol would otherwise drag the 7-day read.
  const expiries = [{ days: 1, atmIv: 120 }, { days: 5, atmIv: 50 }, { days: 12, atmIv: 52 }];
  const seven = constantMaturity(expiries, 7, 'atmIv');
  assert.ok(seven > 50 && seven < 52, `7-day ${seven}`);
});

test('the full surface publishes all three tenors from a well-populated chain', () => {
  const summaries = [5, 9, 16, 23, 37, 65, 100, 130].flatMap((days, index) => chain({ days, base: 60 - (index * 1.5) }).rows);
  const closes = Array.from({ length: 60 }, (_, index) => 85_000 * Math.exp((index % 2 ? 0.02 : -0.02)));
  const surface = calculateCryptoOptionsSurface({ currency: 'BTC', summaries, closes, now: NOW });
  assert.equal(surface.status, 'calculated');
  assert.deepEqual(surface.tenors.map((tenor) => tenor.days), [7, 30, 90]);
  for (const tenor of surface.tenors) {
    assert.ok(Number.isFinite(tenor.atmIv), `${tenor.days}-day ATM`);
    assert.ok(tenor.riskReversal25 < 0, `${tenor.days}-day skew follows the generator`);
  }
  // Base vol falls with expiry in the generator, so the curve is inverted.
  assert.ok(surface.termSlope > 0);
  assert.ok(Number.isFinite(surface.realized30));
  assert.equal(surface.varianceRiskPremium, Math.round((surface.tenors[1].atmIv - surface.realized30) * 100) / 100);
  assert.ok(surface.read.length > 20);
  // Only expiries at or beyond two days are shown.
  assert.ok(surface.expiries.every((entry) => entry.days >= 2));
});

test('options from another currency are ignored, and a thin chain refuses', () => {
  const eth = chain({ currency: 'ETH', days: 30, base: 70, forward: 3000, step: 50 }).rows;
  const surface = calculateCryptoOptionsSurface({ currency: 'BTC', summaries: eth, now: NOW });
  assert.equal(surface.status, 'unavailable');
  assert.match(surface.reason, /0 live BTC options/);
});

test('max pain is the strike where open holders collect least', () => {
  const rows = [
    { strike: 80, type: 'P', openInterest: 100 },
    { strike: 90, type: 'P', openInterest: 10 },
    { strike: 100, type: 'C', openInterest: 10 },
    { strike: 110, type: 'C', openInterest: 100 },
  ];
  // Between the heavy put at 80 and heavy call at 110, every strike from 90
  // to 100 pays almost nothing; 90 pays the 100-call nothing and the 90-put
  // nothing, leaving only the 80-put out of the money too.
  const strike = maxPain(rows);
  assert.ok(strike === 90 || strike === 100, `max pain ${strike}`);
});

test('realized vol annualizes over 365 days for a 24/7 market', () => {
  const closes = [100];
  for (let index = 0; index < 30; index += 1) closes.push(closes.at(-1) * Math.exp(index % 2 ? 0.01 : -0.01));
  const expected = 0.01 * Math.sqrt(30 / 29) * Math.sqrt(365) * 100;
  assert.ok(Math.abs(realizedVolatility(closes, 30) - expected) < 0.05);
  assert.equal(realizedVolatility([100, 101], 30), null);
});

test('implied vol is ranked against its year only when there is a year to rank against', () => {
  const summaries = [5, 9, 16, 23, 37, 65, 100, 130].flatMap((days) => chain({ days, base: 55 }).rows);
  const thin = calculateCryptoOptionsSurface({ currency: 'BTC', summaries, dvolHistory: [{ value: 50 }, { value: 60 }], now: NOW });
  assert.equal(thin.dvol.percentile, null);
  const year = Array.from({ length: 365 }, (_, index) => ({ value: 40 + (index % 30) }));
  const full = calculateCryptoOptionsSurface({ currency: 'BTC', summaries, dvolHistory: year, now: NOW });
  assert.ok(Number.isFinite(full.dvol.percentile));
});

test('a near tenor above the far one is called inverted however small, and the read uses real ordinals', () => {
  // A 30-day vol 1.9 points over 90-day was labelled "normal" because the
  // label keyed off the 2-point threshold the narrative uses for emphasis.
  const summaries = [5, 9, 16, 23, 37, 65, 100, 130].flatMap((days, index) => chain({ days, base: 50 - (index * 0.4) }).rows);
  // 198 readings of 1..99 then today at 31.5: 63 of 199 at or below -> 32nd.
  const year = [...Array.from({ length: 99 }, (_, i) => ({ value: i + 1 })), ...Array.from({ length: 99 }, (_, i) => ({ value: i + 1 })), { value: 31.5 }];
  const surface = calculateCryptoOptionsSurface({ currency: 'BTC', summaries, dvolHistory: year, now: NOW });
  assert.ok(surface.termSlope > 0.5 && surface.termSlope < 2, `slope ${surface.termSlope}`);
  assert.equal(surface.termShape, 'inverted');
  assert.equal(surface.dvol.percentile, 32);
  assert.match(surface.read, /32nd percentile/);
  assert.doesNotMatch(surface.read, /32th/);
});
