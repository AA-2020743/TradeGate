import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoller } from './polling.js';

function harness({ intervalMs = 1000, visible = true } = {}) {
  const timers = new Map();
  let nextHandle = 1;
  let hidden = !visible;
  const listeners = new Set();
  const calls = [];
  let resolveCurrent = null;

  const poller = createPoller({
    load: () => {
      calls.push(Date.now());
      return new Promise((resolve) => { resolveCurrent = resolve; });
    },
    intervalMs,
    setTimer: (callback, delay) => {
      const handle = nextHandle;
      nextHandle += 1;
      timers.set(handle, { callback, delay });
      return handle;
    },
    clearTimer: (handle) => timers.delete(handle),
    visibility: {
      isVisible: () => !hidden,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });

  return {
    poller,
    calls,
    pendingTimers: () => timers.size,
    fireTimers: () => {
      const scheduled = [...timers.values()];
      timers.clear();
      for (const entry of scheduled) entry.callback();
    },
    settleLoad: async () => {
      resolveCurrent?.();
      resolveCurrent = null;
      await new Promise((resolve) => setImmediate(resolve));
    },
    setHidden: (value) => {
      hidden = value;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

test('poller loads immediately and reschedules only after the load settles', async () => {
  const context = harness();
  context.poller.start();
  assert.equal(context.calls.length, 1);
  assert.equal(context.pendingTimers(), 0);
  await context.settleLoad();
  assert.equal(context.pendingTimers(), 1);
  context.fireTimers();
  assert.equal(context.calls.length, 2);
  context.poller.stop();
});

test('a tick that fires during a slow load does not start a second load', async () => {
  const context = harness();
  context.poller.start();
  await context.settleLoad();
  context.fireTimers();
  assert.equal(context.calls.length, 2);
  context.fireTimers();
  context.fireTimers();
  assert.equal(context.calls.length, 2);
  await context.settleLoad();
  assert.equal(context.pendingTimers(), 1);
  context.poller.stop();
});

test('a hidden tab skips its cycles and replays one when it returns', async () => {
  const context = harness();
  context.poller.start();
  await context.settleLoad();
  context.setHidden(true);
  context.fireTimers();
  context.fireTimers();
  assert.equal(context.calls.length, 1);
  context.setHidden(false);
  assert.equal(context.calls.length, 2);
  await context.settleLoad();
  context.poller.stop();
});

test('returning to a visible tab that missed nothing does not force a load', async () => {
  const context = harness();
  context.poller.start();
  await context.settleLoad();
  context.setHidden(true);
  context.setHidden(false);
  assert.equal(context.calls.length, 1);
  context.poller.stop();
});

test('a rejected load still schedules the next cycle', async () => {
  let attempts = 0;
  const timers = [];
  const poller = createPoller({
    load: () => {
      attempts += 1;
      return Promise.reject(new Error('offline'));
    },
    intervalMs: 1000,
    setTimer: (callback) => timers.push(callback),
    clearTimer: () => {},
    visibility: { isVisible: () => true, subscribe: () => () => {} },
  });
  poller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(timers.length, 1);
  timers.pop()();
  assert.equal(attempts, 2);
  poller.stop();
});

test('stopping cancels the pending timer and unsubscribes from visibility', async () => {
  const context = harness();
  context.poller.start();
  await context.settleLoad();
  assert.equal(context.listenerCount(), 1);
  context.poller.stop();
  assert.equal(context.pendingTimers(), 0);
  assert.equal(context.listenerCount(), 0);
  context.fireTimers();
  assert.equal(context.calls.length, 1);
});

test('a load settling after stop does not resurrect the loop', async () => {
  const context = harness();
  context.poller.start();
  context.poller.stop();
  await context.settleLoad();
  assert.equal(context.pendingTimers(), 0);
});

test('createPoller rejects a missing load function', () => {
  assert.throws(() => createPoller({}), TypeError);
});
