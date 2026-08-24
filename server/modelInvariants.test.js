import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * A property sweep across every single-series model in the platform.
 *
 * Two invariants hold for all of them, on any input: a published number is
 * finite, and a published sentence contains no interpolation artifact. A model
 * that cannot answer says so through `status`/`reason` - it does not answer
 * with NaN, and it does not describe itself with the word "undefined" where a
 * value should have been.
 *
 * This found `calculateTechnicalSnapshot` publishing `score: NaN` on an
 * all-zero series (0/0 in the momentum base) and `calculateDrawdownProfile`
 * publishing "NaN% below the peak", neither of which any fixture-based test
 * had reached.
 *
 * Each function is calibrated first - fed a healthy series in each candidate
 * shape to learn which one it takes - so a model is never judged on input it
 * was never meant to accept.
 */

const MODULES = ['analytics', 'equityAnalytics', 'macroModels', 'macroRates', 'bitcoinTechnicals', 'bitcoinOhlc'];
const DAY_MS = 86_400_000;
const iso = (index) => new Date(Date.UTC(2021, 0, 1) + (index * DAY_MS)).toISOString();
const ymd = (index) => iso(index).slice(0, 10);

const SHAPES = {
  timestampValue: (index, value) => ({ timestamp: iso(index), value }),
  dateValue: (index, value) => ({ date: ymd(index), value }),
  numbers: (index, value) => value,
  ohlc: (index, value) => ({ date: ymd(index), open: value * 0.99, high: value * 1.02, low: value * 0.97, close: value, volume: 1_000 + index }),
};

const healthy = (make) => Array.from({ length: 500 }, (_, index) => make(index, 100 + (index * 0.2) + (Math.sin(index / 9) * 4)));

const hostileCases = (make) => ({
  empty: [],
  one: [make(0, 100)],
  two: [make(0, 100), make(1, 101)],
  identical: Array.from({ length: 500 }, (_, index) => make(index, 100)),
  zeros: Array.from({ length: 500 }, (_, index) => make(index, 0)),
  negatives: Array.from({ length: 500 }, (_, index) => make(index, -50 + Math.sin(index / 7))),
  crossesZero: Array.from({ length: 500 }, (_, index) => make(index, Math.sin(index / 11) * 3)),
  tiny: Array.from({ length: 500 }, (_, index) => make(index, 1e-12 * (1 + Math.sin(index / 5)))),
  huge: Array.from({ length: 500 }, (_, index) => make(index, 1e15 + (index * 1e9))),
  duplicateDates: Array.from({ length: 500 }, (_, index) => make(Math.floor(index / 2), 100 + index)),
  reversed: Array.from({ length: 500 }, (_, index) => make(500 - index, 100 + index)),
  singleSpike: Array.from({ length: 500 }, (_, index) => make(index, index === 250 ? 1e6 : 100)),
  flatThenJump: Array.from({ length: 500 }, (_, index) => make(index, index < 250 ? 100 : 400)),
});

const ARTIFACT = /undefined|\bNaN\b|\[object |Infinity/;

function collect(node, trail, found) {
  if (node === null || node === undefined) return found;
  if (typeof node === 'number') {
    if (!Number.isFinite(node)) found.push(`${trail} = ${node}`);
  } else if (typeof node === 'string') {
    if (ARTIFACT.test(node)) found.push(`${trail} = ${JSON.stringify(node.slice(0, 130))}`);
  } else if (Array.isArray(node)) {
    node.forEach((item, index) => collect(item, `${trail}[${index}]`, found));
  } else if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) collect(value, trail ? `${trail}.${key}` : key, found);
  }
  return found;
}

const healthyPair = (make) => Array.from({ length: 500 }, (_, index) => make(index, 50 + (index * 0.1) + (Math.cos(index / 7) * 3)));

const pairCases = (make) => ({
  ...hostileCases(make),
  shorter: Array.from({ length: 40 }, (_, index) => make(index, 100 + index)),
  // Two series whose dates never meet.
  disjointDates: Array.from({ length: 500 }, (_, index) => make(index + 5_000, 100 + index)),
});

async function singleSeriesModels() {
  const models = [];
  for (const name of MODULES) {
    const loaded = await import(`./${name}.js`);
    for (const [fnName, fn] of Object.entries(loaded)) {
      if (typeof fn !== 'function' || fn.length !== 1) continue;
      const firstParam = (fn.toString().match(/^[^(]*\(\s*([A-Za-z_$][\w$]*)/) ?? [])[1] ?? '';
      if (!/point|value|histor|series|bar|close|price|input|row/i.test(firstParam)) continue;

      // Calibrate against a healthy series so a model is only fuzzed with the
      // shape it understands.
      let shape = null;
      for (const make of Object.values(SHAPES)) {
        let output;
        try { output = fn(healthy(make)); } catch { continue; }
        if (output === null || output === undefined) continue;
        if (collect(output, '', []).length === 0) { shape = make; break; }
      }
      if (shape) models.push({ id: `${name}.${fnName}`, fn, shape });
    }
  }
  return models;
}

test('no single-series model publishes a non-finite number or an interpolation artifact', async () => {
  const models = await singleSeriesModels();
  // Guard the harness itself: a refactor that renames exports must not quietly
  // reduce this to testing nothing.
  assert.ok(models.length >= 40, `expected to calibrate 40+ models, calibrated ${models.length}`);

  const failures = [];
  for (const { id, fn, shape } of models) {
    for (const [caseName, input] of Object.entries(hostileCases(shape))) {
      let result;
      try {
        result = fn(input);
      } catch (error) {
        failures.push(`${id}(${caseName}) threw ${error.constructor.name}: ${error.message}`);
        continue;
      }
      for (const finding of collect(result, '', [])) failures.push(`${id}(${caseName}) :: ${finding}`);
    }
  }
  assert.deepEqual(failures, []);
});

async function twoSeriesModels() {
  const models = [];
  for (const name of MODULES) {
    const loaded = await import(`./${name}.js`);
    for (const [fnName, fn] of Object.entries(loaded)) {
      if (typeof fn !== 'function' || fn.length !== 2) continue;
      const declared = (fn.toString().match(/^[^(]*\(([^)]*)\)/) ?? [])[1] ?? '';
      const [first = '', second = ''] = declared.split(',').map((entry) => entry.trim());
      const seriesLike = /point|value|histor|series|bar|close|price|row/i;
      if (!seriesLike.test(first) || !seriesLike.test(second)) continue;

      let shape = null;
      for (const make of Object.values(SHAPES)) {
        let output;
        try { output = fn(healthy(make), healthyPair(make)); } catch { continue; }
        if (output === null || output === undefined) continue;
        if (collect(output, '', []).length === 0) { shape = make; break; }
      }
      if (shape) models.push({ id: `${name}.${fnName}`, fn, shape });
    }
  }
  return models;
}

test('no two-series model publishes a non-finite number, whichever leg is degenerate', async () => {
  const models = await twoSeriesModels();
  assert.ok(models.length >= 6, `expected to calibrate 6+ paired models, calibrated ${models.length}`);

  const failures = [];
  for (const { id, fn, shape } of models) {
    for (const [caseName, input] of Object.entries(pairCases(shape))) {
      // A degenerate leg must be survivable on either side, and on both.
      const pairings = [
        ['left', [input, healthyPair(shape)]],
        ['right', [healthy(shape), input]],
        ['both', [input, input]],
      ];
      for (const [side, args] of pairings) {
        let result;
        try {
          result = fn(...args);
        } catch (error) {
          failures.push(`${id}(${caseName}/${side}) threw ${error.constructor.name}: ${error.message}`);
          continue;
        }
        for (const finding of collect(result, '', [])) failures.push(`${id}(${caseName}/${side}) :: ${finding}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});
