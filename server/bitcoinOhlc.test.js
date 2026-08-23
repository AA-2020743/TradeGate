import test from 'node:test';
import assert from 'node:assert/strict';
import {
  atrSeries,
  calculateAtrExpansion,
  calculateBitcoinRangeModels,
  calculateDonchianChannels,
  calculateOnBalanceVolume,
  calculateTdCountdown,
  normalizeBars,
} from './bitcoinOhlc.js';

const START = Date.UTC(2020, 0, 1);

function bar(index, close, { range = 2, volume = 1000 } = {}) {
  return {
    date: new Date(START + (index * 86_400_000)).toISOString().slice(0, 10),
    open: close,
    high: close + range,
    low: close - range,
    close,
    volume,
  };
}

function bars(closes, options) {
  return closes.map((close, index) => bar(index, close, typeof options === 'function' ? options(index) : options));
}

test('normalizeBars drops bars that cannot be true', () => {
  const rows = normalizeBars([
    { date: '2024-01-02', open: 10, high: 12, low: 9, close: 11, volume: 5 },
    { date: '2024-01-01', open: 10, high: 12, low: 9, close: 11, volume: 5 },
    { date: '2024-01-03', open: 10, high: 8, low: 9, close: 9 },        // high below low
    { date: '2024-01-04', open: 10, high: 12, low: 9, close: 14 },       // close outside range
    { date: '2024-01-05', open: 10, high: 12, low: 9, close: 11, volume: -3 },
    { date: '2024-01-06', open: 10, high: 12, low: 0, close: 11 },       // non-positive low
  ]);
  assert.deepEqual(rows.map((row) => row.date), ['2024-01-01', '2024-01-02', '2024-01-05']);
  assert.equal(rows.at(-1).volume, null, 'a negative volume is dropped, not carried');
});

test('atrSeries uses the true range, not just the bar range', () => {
  // A gap up means the true range is measured against the previous close.
  const rows = normalizeBars([
    ...Array.from({ length: 20 }, (_, index) => bar(index, 100)),
    { date: new Date(START + (20 * 86_400_000)).toISOString().slice(0, 10), open: 130, high: 131, low: 129, close: 130 },
  ]);
  const series = atrSeries(rows, 14);
  const withoutGap = atrSeries(rows.slice(0, -1), 14);
  // The gap bar's own range is 2, but its true range against the previous close
  // is 31, so Wilder smoothing lifts the ATR from 4 to (4*13 + 31)/14 = 6.5.
  assert.equal(withoutGap.at(-1), 4);
  assert.equal(Math.abs(series.at(-1) - (((4 * 13) + 31) / 14)) < 1e-9, true);
});

test('ATR expansion separates a widening tape from a quiet one', () => {
  const varied = (index) => ({ range: 1 + (0.05 * ((index % 5) - 2)) });
  const quiet = calculateAtrExpansion(bars(Array.from({ length: 300 }, () => 100), varied));
  const widening = calculateAtrExpansion(bars(
    Array.from({ length: 300 }, () => 100),
    (index) => (index > 275 ? { range: 8 } : varied(index)),
  ));
  assert.equal(quiet.state, 'steady');
  assert.equal(widening.state, 'expanding');
  assert.equal(widening.ratio >= 1.25, true);
  assert.equal(quiet.ratio, 1);
  assert.equal(widening.percentile, 100);
});

test('ATR is ranked against its own history rather than an absolute width', () => {
  // Volatility that drifts up and back down: the current reading must land in
  // the middle of its own distribution, not at an extreme.
  const result = calculateAtrExpansion(bars(
    Array.from({ length: 400 }, () => 100),
    (index) => ({ range: 2 + (1.5 * Math.sin(index / 40)) }),
  ));
  assert.equal(result.percentile > 5 && result.percentile < 95, true, `percentile was ${result.percentile}`);
  assert.equal(result.status, 'calculated');
});

test('a contracting tape is named as such rather than lumped in with steady', () => {
  const result = calculateAtrExpansion(bars(
    Array.from({ length: 300 }, () => 100),
    (index) => ({ range: index > 275 ? 0.5 : 4 }),
  ));
  assert.equal(result.state, 'contracting');
  assert.equal(result.ratio <= 0.8, true);
});

test('ATR expansion refuses a history it cannot rank and marks a thin one provisional', () => {
  assert.equal(calculateAtrExpansion(bars(Array.from({ length: 20 }, () => 100))).status, 'unavailable');
  const thin = calculateAtrExpansion(bars(Array.from({ length: 90 }, (_, index) => 100 + index)));
  assert.equal(thin.status, 'provisional');
  assert.equal(thin.rankedAgainst < 252, true);
});

test('the Donchian channel excludes the current bar, so a new high reads as a breakout only when it is one', () => {
  const flat = bars(Array.from({ length: 80 }, () => 100), { range: 2 });
  const inside = calculateDonchianChannels(flat);
  assert.equal(inside.channels.every((channel) => channel.state === 'inside'), true);

  const breaking = [...flat, bar(80, 110, { range: 2 })];
  const out = calculateDonchianChannels(breaking);
  assert.equal(out.channels.every((channel) => channel.state === 'breakout up'), true);
  assert.equal(out.channels[0].upper, 102, 'the channel must not contain the breakout bar itself');
});

test('the Donchian channel reports a downside break and where price sits inside the range', () => {
  const rows = [...bars(Array.from({ length: 80 }, (_, index) => 100 + (index % 5)), { range: 1 }), bar(80, 80, { range: 1 })];
  const result = calculateDonchianChannels(rows);
  assert.equal(result.channels[0].state, 'breakout down');
  const mid = calculateDonchianChannels(bars(Array.from({ length: 80 }, (_, index) => 100 + (index % 10)), { range: 1 }));
  assert.equal(mid.channels[0].positionPercent >= 0 && mid.channels[0].positionPercent <= 100, true);
});

test('the Donchian model refuses a history shorter than its longest channel', () => {
  const result = calculateDonchianChannels(bars(Array.from({ length: 30 }, () => 100)));
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.channels, []);
});

test('no completed setup means no countdown rather than a countdown from nowhere', () => {
  const result = calculateTdCountdown(bars(Array.from({ length: 40 }, (_, index) => 100 + ((index % 4) * 2))));
  assert.equal(result.status, 'calculated');
  assert.equal(result.setup, null);
  assert.equal(result.countdown, null);
  assert.match(result.read, /No TD setup has completed/);
});

test('a buy countdown starts from the completed setup and counts closes under the low two bars back', () => {
  const closes = [
    ...Array.from({ length: 10 }, () => 100),
    ...Array.from({ length: 30 }, (_, index) => 99 - (index * 1.5)),
  ];
  const result = calculateTdCountdown(bars(closes, { range: 0.4 }));
  assert.equal(result.setup.direction, 'buy');
  assert.equal(result.countdown.direction, 'buy');
  assert.equal(result.countdown.count > 0, true);
  assert.equal(result.countdown.cancelledPrior, null);
  assert.equal(result.tdst.side, 'resistance');
  assert.equal(result.tdst.level > Math.min(...closes), true);
});

test('a setup is perfected only when bar 8 or 9 exceeds the extremes of bars 6 and 7', () => {
  const closes = [...Array.from({ length: 10 }, () => 100), ...Array.from({ length: 9 }, (_, index) => 99 - index)];
  const perfect = calculateTdCountdown(bars(closes, { range: 0.4 }));
  assert.equal(perfect.setup.perfected, true, 'a steady decline puts the lowest lows on the final bars');

  // Bars 8 and 9 hold above the lows of bars 6 and 7: a plain, unperfected setup.
  const rows = bars(closes, { range: 0.4 });
  rows[16].low = 60;
  rows[17].low = 90;
  rows[18].low = 90;
  const plain = calculateTdCountdown(rows);
  assert.equal(plain.setup.perfected, false);
});

test('the bar-13 close must clear the bar-8 extreme or the countdown is deferred', () => {
  const closes = [...Array.from({ length: 10 }, () => 100), ...Array.from({ length: 40 }, (_, index) => 99 - (index * 2))];
  const completed = calculateTdCountdown(bars(closes, { range: 0.4 }));
  assert.equal(completed.countdown.count, 13);
  assert.equal(completed.countdown.qualifierMet, true);
  assert.equal(completed.countdown.complete, true);
  assert.equal(completed.countdown.deferred, false);
});

test('an opposing setup replaces the running countdown and says which one it killed', () => {
  const closes = [
    ...Array.from({ length: 10 }, () => 100),
    ...Array.from({ length: 12 }, (_, index) => 99 - (index * 2)),
    ...Array.from({ length: 14 }, (_, index) => 76 + (index * 3)),
  ];
  const result = calculateTdCountdown(bars(closes, { range: 0.4 }));
  assert.equal(result.setup.direction, 'sell', 'the model tracks the most recent completed setup');
  assert.equal(result.countdown.cancelledPrior.direction, 'buy');
  assert.match(result.read, /buy countdown from .* was cancelled/);
  const clean = calculateTdCountdown(bars([
    ...Array.from({ length: 10 }, () => 100),
    ...Array.from({ length: 14 }, (_, index) => 101 + (index * 2)),
  ], { range: 0.4 }));
  assert.equal(clean.countdown.cancelledPrior, null);
});

test('the countdown refuses a history too short to hold a setup', () => {
  assert.equal(calculateTdCountdown(bars(Array.from({ length: 10 }, () => 100))).status, 'unavailable');
});

test('on-balance volume confirms a rally and diverges when volume drains out of it', () => {
  const confirming = calculateOnBalanceVolume(bars(
    Array.from({ length: 90 }, (_, index) => 100 + index),
    () => ({ volume: 1000 }),
  ));
  assert.equal(confirming.agreement, 'confirming');
  assert.equal(confirming.obvDirection, 'rising');

  // Price grinds up, but the up days carry less and less volume and the down
  // days carry more, so OBV rolls over while price does not.
  const closes = Array.from({ length: 90 }, (_, index) => 100 + index + (index % 2 ? 3 : 0));
  const rows = bars(closes, (index) => ({ volume: index % 2 ? 50 : 4000 }));
  const diverging = calculateOnBalanceVolume(rows);
  assert.equal(diverging.priceDirection, 'rising');
  assert.equal(diverging.obvDirection, 'falling');
  assert.equal(diverging.agreement, 'diverging');
});

test('a bar re-normalized twice does not gain a volume of zero it never had', () => {
  const stripped = bars(Array.from({ length: 5 }, () => 100)).map(({ volume, ...rest }) => rest);
  assert.equal(normalizeBars(stripped)[0].volume, null);
  assert.equal(normalizeBars(normalizeBars(stripped))[0].volume, null);
});

test('on-balance volume refuses bars that carry no volume rather than assuming any', () => {
  const withoutVolume = bars(Array.from({ length: 120 }, (_, index) => 100 + index)).map(({ volume, ...rest }) => rest);
  const result = calculateOnBalanceVolume(withoutVolume);
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /carrying volume/);
  assert.equal(result.observations, 0);
});

test('the range bundle publishes every OHLCV model and names what is missing', () => {
  const full = calculateBitcoinRangeModels(bars(
    Array.from({ length: 400 }, (_, index) => 100 + (index * 0.5) + (5 * Math.sin(index / 7))),
    { range: 2, volume: 1000 },
  ));
  assert.equal(full.unavailableModules.length, 0);
  assert.equal(full.withVolume, 400);
  assert.equal(full.modules.donchian.status, 'calculated');

  const noVolume = calculateBitcoinRangeModels(
    bars(Array.from({ length: 400 }, (_, index) => 100 + index)).map(({ volume, ...rest }) => rest),
  );
  assert.equal(noVolume.status, 'provisional');
  assert.equal(noVolume.unavailableModules.includes('onBalanceVolume'), true);
  assert.equal(noVolume.withVolume, 0);
});

test('a close-only feed leaves every range model unavailable instead of substituting closes', () => {
  const closeOnly = Array.from({ length: 400 }, (_, index) => ({
    date: new Date(START + (index * 86_400_000)).toISOString().slice(0, 10),
    close: 100 + index,
  }));
  const result = calculateBitcoinRangeModels(closeOnly);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.observations, 0);
  assert.equal(result.unavailableModules.length, 4);
  assert.match(result.reason, /high, low and close/);
});
