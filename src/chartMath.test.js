import test from 'node:test';
import assert from 'node:assert/strict';
import { divergingPosition, divergingTicks, niceLimit, pullBar, scalePosition } from './chartMath.js';

test('a reading pulls from the neutral line toward the side it favours', () => {
  assert.deepEqual(pullBar(72), { side: 'pos', left: 50, width: 22 });
  assert.deepEqual(pullBar(38), { side: 'neg', left: 38, width: 12 });
  assert.deepEqual(pullBar(50), { side: 'flat', left: 50, width: 0 });
  // Out-of-range scores are drawn at the edge, never past it.
  assert.deepEqual(pullBar(130), { side: 'pos', left: 50, width: 50 });
  assert.equal(pullBar(null), null);
});

test('axis limits round up to a readable number', () => {
  assert.equal(niceLimit(3.2), 4);
  assert.equal(niceLimit(13), 15);
  assert.equal(niceLimit(-7.4), 8);
  assert.equal(niceLimit(0.27), 0.3);
  assert.equal(niceLimit(0), 1);
  assert.deepEqual(divergingTicks(4), [-4, -2, 0, 2, 4]);
});

test('signed values sit on a symmetric axis around the centre', () => {
  assert.deepEqual(divergingPosition(2, 4), { left: 50, width: 25, at: 75, side: 'pos' });
  assert.deepEqual(divergingPosition(-4, 4), { left: 0, width: 50, at: 0, side: 'neg' });
  assert.deepEqual(divergingPosition(-9, 4), { left: 0, width: 50, at: 0, side: 'neg' });
  assert.equal(divergingPosition(1, 0), null);
});

test('a scale marker is placed by value and kept on its track', () => {
  assert.equal(scalePosition(97), 97);
  assert.equal(scalePosition(15, 10, 20), 50);
  assert.equal(scalePosition(-5), 0);
  assert.equal(scalePosition(Number.NaN), null);
});
