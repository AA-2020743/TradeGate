import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReport, formatScorecard, partStates, reasonsFrom, summarizeSource } from './sourceCheck.js';

const fulfilled = (value) => ({ status: 'fulfilled', value });

test('a fully calculated source is OK, with its figure and parts', () => {
  const summary = summarizeSource(
    { name: 'Shiller', endpoint: '/api/x', figure: (payload) => `CAPE ${payload.cape}` },
    fulfilled({ status: 'calculated', cape: 37.1, outlook: { status: 'calculated' } }),
    2345,
  );
  assert.equal(summary.verdict, 'ok');
  assert.equal(summary.figure, 'CAPE 37.1');
  assert.equal(summary.seconds, 2.3);
  assert.deepEqual(summary.parts, ['outlook=calculated']);
  assert.deepEqual(summary.reasons, []);
});

test('a source with some parts published is partial, and names why the rest are not', () => {
  const summary = summarizeSource({ name: 'Deribit' }, fulfilled({
    status: 'provisional',
    surfaces: [{ currency: 'BTC', status: 'calculated' }, { currency: 'ETH', status: 'unavailable', reason: 'ETH chain: 503' }],
    errors: ['ETH chain: 503', 'DVOL history: timeout'],
  }), 100);
  assert.equal(summary.verdict, 'partial');
  assert.deepEqual(summary.parts, ['surfaces: BTC=calculated ETH=unavailable']);
  assert.deepEqual(summary.reasons, ['ETH chain: 503', 'DVOL history: timeout'], 'reasons are de-duplicated');
});

test('an unavailable payload, a rejected loader and a throwing figure all fail cleanly', () => {
  const unavailable = summarizeSource({ name: 'French' }, fulfilled({ status: 'unavailable', reason: 'Upstream request failed with 403' }), 50);
  assert.equal(unavailable.verdict, 'failed');
  assert.deepEqual(unavailable.reasons, ['Upstream request failed with 403']);
  const rejected = summarizeSource({ name: 'Treasury' }, { status: 'rejected', reason: new Error('did not answer within 90s') }, 90_000);
  assert.equal(rejected.verdict, 'failed');
  assert.deepEqual(rejected.reasons, ['did not answer within 90s']);
  const broken = summarizeSource({ name: 'X', figure: (payload) => payload.missing.deep }, fulfilled({ status: 'calculated' }), 1);
  assert.equal(broken.figure, null);
  assert.equal(broken.verdict, 'ok');
});

test('a payload with no status of its own is judged by the source’s own test', () => {
  const answered = (payload) => payload.provider.failedSeries === 0;
  const healthy = summarizeSource({ name: 'FRED', answered }, fulfilled({ provider: { failedSeries: 0 }, model: { status: 'calculated' } }), 1);
  assert.equal(healthy.verdict, 'ok');
  assert.equal(healthy.status, 'answered');
  const someFailed = summarizeSource({ name: 'FRED', answered }, fulfilled({ provider: { failedSeries: 3 }, model: { status: 'calculated' } }), 1);
  assert.equal(someFailed.verdict, 'partial', 'models still published from the series that arrived');
  const none = summarizeSource({ name: 'FRED', answered }, fulfilled({ provider: { failedSeries: 32 }, model: { status: 'unavailable', reason: 'no series' } }), 1);
  assert.equal(none.verdict, 'failed');
});

test('parts and reasons read only one level deep, and long lists are capped', () => {
  const payload = { checks: Array.from({ length: 12 }, (_unused, index) => ({ symbol: `S${index}`, status: 'pass' })), nested: { inner: { status: 'unavailable', reason: 'deep' } } };
  assert.match(partStates(payload)[0], /S7=pass \(\+4\)$/);
  assert.deepEqual(reasonsFrom(payload), []);
});

test('the report ends with a count of what answered', () => {
  const report = formatReport([
    summarizeSource({ name: 'A' }, fulfilled({ status: 'calculated' }), 1),
    summarizeSource({ name: 'B' }, fulfilled({ status: 'provisional' }), 1),
    summarizeSource({ name: 'C' }, fulfilled({ status: 'unavailable', reason: 'x' }), 1),
  ]);
  assert.match(report, /^OK +A/m);
  assert.match(report, /^PART +B/m);
  assert.match(report, /^FAIL +C/m);
  assert.match(report, /1 of 3 sources fully answered, 1 partly, 1 not at all\.$/);
});

test('ingestion is reported off, stale, or current - a six-week stall cannot pass silently', async () => {
  const { summarizeIngestion } = await import('./sourceCheck.js');
  const now = Date.parse('2026-10-07T21:00:00Z');
  const jobs = [
    { job_name: 'fred-liquidity', status: 'partial', started_at: '2026-08-24T12:37:00Z', finished_at: '2026-08-24T12:37:57Z', error_message: null },
    { job_name: 'market-history', status: 'running', started_at: '2026-08-24T12:30:00Z', finished_at: null, error_message: null },
  ];
  const off = summarizeIngestion({ enabled: false, databaseConfigured: true, jobs, now });
  assert.equal(off.verdict, 'failed');
  assert.match(off.lines[0], /INGESTION_ENABLED is not true/);
  assert.match(off.lines[1], /fred-liquidity: partial, 44 days ago/);
  assert.match(off.lines[2], /market-history: running, started 2026-08-24T12:30 and never finished/);
  const stale = summarizeIngestion({ enabled: true, databaseConfigured: true, jobs, now });
  assert.equal(stale.verdict, 'partial');
  const current = summarizeIngestion({ enabled: true, databaseConfigured: true, jobs: [{ job_name: 'fred-liquidity', status: 'completed', started_at: '2026-10-07T19:00:00Z', finished_at: '2026-10-07T19:01:00Z' }], now });
  assert.equal(current.verdict, 'ok');
  assert.match(current.lines[0], /completed, 2h ago/);
  assert.equal(summarizeIngestion({ enabled: true, databaseConfigured: false, now }).verdict, 'failed');
});

test('a value outside its plausible range turns OK into PART and names the value - a scale error cannot pass', async () => {
  const { plausibilityOf } = await import('./sourceCheck.js');
  const source = {
    name: 'Deribit',
    plausible: (payload) => [
      { label: 'BTC 30d ATM vol', value: payload.iv, min: 10, max: 250, unit: '%' },
      { label: 'missing', value: payload.nothing, min: 0, max: 1 },
    ],
  };
  const right = summarizeSource(source, fulfilled({ status: 'calculated', iv: 54.2 }), 1);
  assert.equal(right.verdict, 'ok');
  assert.deepEqual(right.values.map((value) => [value.label, value.ok]), [['BTC 30d ATM vol', true]], 'a missing value is skipped, not flagged');
  // A fraction where a percent belongs: the reader parsed, but misread.
  const misread = summarizeSource(source, fulfilled({ status: 'calculated', iv: 0.542 }), 1);
  assert.equal(misread.verdict, 'partial');
  assert.match(misread.reasons[0], /BTC 30d ATM vol = 0\.542% is outside the plausible 10-250%: check the reader's units/);
  assert.match(formatReport([misread]), /values: BTC 30d ATM vol 0\.542% \(!\)/);
  // A failed source stays failed; a broken extractor yields no values rather than a crash.
  assert.equal(summarizeSource(source, fulfilled({ status: 'unavailable', reason: 'x', iv: 0.5 }), 1).verdict, 'failed');
  assert.deepEqual(plausibilityOf({ plausible: () => { throw new Error('bad'); } }, {}), []);
});

test('a running app is read through its endpoints; errors name the endpoint and status', async () => {
  const { findRunningApp, servedLoader } = await import('./sourceCheck.js');
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/api/health')) return Response.json({ status: 'ok', build: { shortCommit: 'abc1234' } });
    if (url.endsWith('/api/macro/treasury')) return Response.json({ status: 'calculated', cash: { billions: 885.4 } });
    return Response.json({ error: 'Unable to fetch data from an upstream provider.' }, { status: 502 });
  };
  assert.deepEqual(await findRunningApp('http://127.0.0.1:8787', { fetchImpl }), { baseUrl: 'http://127.0.0.1:8787', commit: 'abc1234' });
  assert.equal((await servedLoader('http://127.0.0.1:8787', '/api/macro/treasury', { fetchImpl })()).cash.billions, 885.4);
  await assert.rejects(servedLoader('http://127.0.0.1:8787', '/api/analytics/factors', { fetchImpl })(), /\/api\/analytics\/factors answered 502: Unable to fetch data/);
  // Nothing listening: the check falls back to calling the loaders itself.
  assert.equal(await findRunningApp('http://127.0.0.1:1', { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), null);
  assert.equal(calls.filter((url) => url.endsWith('/api/health')).length, 1);
});

test('a job started minutes ago is running, not stuck; one left open for hours is', async () => {
  const { summarizeIngestion } = await import('./sourceCheck.js');
  const now = Date.parse('2026-10-07T23:58:00Z');
  const result = summarizeIngestion({
    enabled: true,
    databaseConfigured: true,
    now,
    jobs: [
      { job_name: 'fred-liquidity', status: 'running', started_at: '2026-10-07T23:56:00Z', finished_at: null },
      { job_name: 'market-history', status: 'completed', started_at: '2026-10-07T22:50:00Z', finished_at: '2026-10-07T22:52:00Z' },
    ],
  });
  assert.equal(result.verdict, 'ok');
  assert.equal(result.lines[0], 'fred-liquidity: running, started 2 min ago');
  const stuck = summarizeIngestion({ enabled: true, databaseConfigured: true, now, jobs: [{ job_name: 'market-history', status: 'running', started_at: '2026-10-07T18:00:00Z', finished_at: null }] });
  assert.equal(stuck.verdict, 'partial');
  assert.match(stuck.lines[0], /never finished/);
});

test('a source short of its own test that still published parts reads incomplete, not empty', async () => {
  const { summarizeSource } = await import('./sourceCheck.js');
  const source = { name: 'FRED', answered: (payload) => payload.failed === 0 };
  const partly = summarizeSource(source, { status: 'fulfilled', value: { failed: 1, model: { status: 'calculated' } } }, 100);
  assert.equal(partly.status, 'incomplete');
  assert.equal(partly.verdict, 'partial');
  const nothing = summarizeSource(source, { status: 'fulfilled', value: { failed: 32 } }, 100);
  assert.equal(nothing.status, 'empty');
  assert.equal(nothing.verdict, 'failed');
});

test('the scorecard prints one line per track record with its verdict and orderings', () => {
  const lines = formatScorecard({
    status: 'calculated',
    read: 'Of 2 track records, 2 have a held-out block large enough to judge; 1 ranked as assumed both before and after their cutoff; 1 ran against the order assumed.',
    rows: [
      { name: 'Currency carry groups', status: 'calculated', verdict: 'held', verdictLabel: 'Held up out of sample', developmentOrdering: 1, heldOutOrdering: 0.67, holdoutFrom: '2023-07-31', horizonDays: 90 },
      { name: 'Macro regime', status: 'calculated', verdict: 'reversed', verdictLabel: 'Ran against its assumed order since', developmentOrdering: 0.33, heldOutOrdering: -1, holdoutFrom: '2024-01-08', horizonDays: 90 },
      { name: 'Screener score fifths', status: 'unavailable', verdict: 'unavailable', verdictLabel: 'Did not load', reason: 'timed out' },
    ],
  });
  assert.match(lines[0], /^Track records \(held-out verdicts\): Of 2 track records/);
  assert.equal(lines[1], 'HELD  Currency carry groups: held up out of sample (before +1, held out +0.67 since 2023-07-31, 90 days)');
  assert.equal(lines[2], 'REV   Macro regime: ran against its assumed order since (before +0.33, held out -1 since 2024-01-08, 90 days)');
  assert.equal(lines[3], 'N/A   Screener score fifths: did not load (timed out)');
  assert.match(formatScorecard({ status: 'unavailable', reason: 'x' })[0], /^Track records: x/);
});

test('each input of a composite record prints indented under its row', () => {
  const lines = formatScorecard({
    status: 'calculated',
    read: 'Of 1 track record, 1 has a held-out block large enough to judge.',
    rows: [{
      name: 'Gold verdict, replayed', status: 'calculated', verdict: 'reversed', verdictLabel: 'Ran against its assumed order since', developmentOrdering: -0.33, heldOutOrdering: -1, holdoutFrom: '2024-01-16', horizonDays: 90,
      components: [
        { label: 'Gold technicals', weight: 50, days: 90, developmentOrdering: -1, heldOutOrdering: -1, verdict: 'reversed', verdictLabel: 'Ran against its assumed order since' },
        { label: 'RSI', weight: null, days: 90, developmentOrdering: 1, heldOutOrdering: null, verdict: 'untested', verdictLabel: 'Held-out block too thin to judge' },
      ],
    }],
  });
  assert.equal(lines[2], '        · Gold technicals (50%): ran against its assumed order since (before -1, held out -1, 90 days)');
  assert.equal(lines[3], '        · RSI: held-out block too thin to judge (before +1, held out n/a, 90 days)');
});
