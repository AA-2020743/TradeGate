import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The production server saw DBnomics stuck at 2025-03 while the BIS carried
 * 2026-06; the newer source must win, and either alone must still serve.
 */
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
let bisUp = true;
let mirrorUp = true;
globalThis.fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  if (url.hostname === 'stats.bis.org') {
    return bisUp ? new Response('TIME_PERIOD,OBS_VALUE\n2026-05,48380.69\n2026-06,49433.5\n', { status: 200 }) : new Response('down', { status: 503 });
  }
  if (url.hostname === 'api.db.nomics.world') {
    return mirrorUp ? json({ series: { docs: [{ period: ['2025-02', '2025-03'], value: [45000, 45531.2] }] } }) : new Response('down', { status: 503 });
  }
  return new Response('blocked', { status: 503 });
};
const { getPbocAssets } = await import('./providers.js');

test('the BIS series wins over the stalled mirror and is current', async () => {
  const series = await getPbocAssets();
  assert.equal(series.date, '2026-06-01');
  assert.equal(series.value, 49433.5);
  assert.equal(series.via, 'BIS statistics API');
  assert.equal(series.abandoned, false);
});

test('with the BIS down the mirror still serves, and with both down the reason names both', async () => {
  bisUp = false;
  const fallback = await getPbocAssets();
  assert.equal(fallback.via, 'DBnomics mirror');
  assert.equal(fallback.date, '2025-03-01');
  mirrorUp = false;
  await assert.rejects(getPbocAssets(), /Neither the BIS nor DBnomics.*BIS: .*DBnomics: /);
  bisUp = true;
  mirrorUp = true;
});
