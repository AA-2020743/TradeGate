import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverAlerts, selectDeliverableAlerts } from './alertDelivery.js';

const alerts = {
  entries: [
    { key: 'reserves-tightening', severity: 'high', text: 'Reserves scarce', isNew: true },
    { key: 'regime-borderline', severity: 'medium', text: 'One step from flipping', isNew: true },
    { key: 'quarter-end', severity: 'low', text: 'Quarter-end is close', isNew: false },
  ],
  raised: [
    { key: 'reserves-tightening', severity: 'high', text: 'Reserves scarce' },
    { key: 'regime-borderline', severity: 'medium', text: 'One step from flipping' },
  ],
  resolved: [{ key: 'rrp-exhaustion', severity: 'high', text: 'The rrp exhaustion condition is no longer live.' }],
};

test('only transitions at the selected severities are delivered', () => {
  const selected = selectDeliverableAlerts(alerts);
  assert.deepEqual(selected.map((entry) => entry.key), ['reserves-tightening', 'rrp-exhaustion']);
  assert.deepEqual(selected.map((entry) => entry.transition), ['raised', 'cleared']);
  // The still-live low-severity condition is in `entries` but not in `raised`,
  // so it is never delivered — repeating it every run is how a channel dies.
  assert.equal(selected.some((entry) => entry.key === 'quarter-end'), false);
});

test('medium severity is delivered only when asked for', () => {
  const selected = selectDeliverableAlerts(alerts, { severities: ['high', 'medium'] });
  assert.equal(selected.some((entry) => entry.key === 'regime-borderline'), true);
});

test('delivery is off without a configured webhook', async () => {
  const result = await deliverAlerts(alerts, { fetchImplementation: () => { throw new Error('must not be called'); } });
  assert.equal(result.status, 'disabled');
  assert.equal(result.delivered, 0);
});

test('a non-https webhook is refused rather than sent in clear text', async () => {
  for (const url of ['http://example.com/hook', 'ftp://example.com', 'not a url']) {
    const result = await deliverAlerts(alerts, { url, fetchImplementation: () => { throw new Error('must not be called'); } });
    assert.equal(result.status, 'unavailable', `${url} should be refused`);
  }
});

test('a successful post reports what it delivered', async () => {
  const sent = [];
  const result = await deliverAlerts(alerts, {
    url: 'https://example.com/hook',
    fetchImplementation: async (url, options) => {
      sent.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200 };
    },
  });
  assert.equal(result.status, 'delivered');
  assert.equal(result.delivered, 2);
  assert.deepEqual(sent[0].body.transitions.map((entry) => entry.key), ['reserves-tightening', 'rrp-exhaustion']);
  assert.equal(sent[0].body.liveCount, 3);
});

test('a webhook that fails does not take the run down with it', async () => {
  const rejected = await deliverAlerts(alerts, {
    url: 'https://example.com/hook',
    fetchImplementation: async () => ({ ok: false, status: 500 }),
  });
  assert.equal(rejected.status, 'failed');
  assert.match(rejected.reason, /responded 500/);

  const thrown = await deliverAlerts(alerts, {
    url: 'https://example.com/hook',
    fetchImplementation: async () => { throw new Error('socket hang up'); },
  });
  assert.equal(thrown.status, 'failed');
  assert.equal(thrown.reason, 'socket hang up');
  assert.equal(thrown.attempted, 2);
});

test('a webhook that never responds is abandoned rather than hanging the run', async () => {
  const result = await deliverAlerts(alerts, {
    url: 'https://example.com/hook',
    timeoutMs: 20,
    fetchImplementation: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /did not respond within 20ms/);
});

test('nothing is sent when no transition matches', async () => {
  const result = await deliverAlerts({ entries: [], raised: [], resolved: [] }, {
    url: 'https://example.com/hook',
    fetchImplementation: () => { throw new Error('must not be called'); },
  });
  assert.equal(result.status, 'quiet');
});
