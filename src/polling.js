const DEFAULT_INTERVAL_MS = 60_000;

function documentVisibility() {
  if (typeof document === 'undefined') return { isVisible: () => true, subscribe: () => () => {} };
  return {
    isVisible: () => document.visibilityState !== 'hidden',
    subscribe: (listener) => {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
  };
}

/**
 * Repeats `load` on an interval without ever running two loads at once and
 * without spending the API rate limit on a tab nobody is looking at. A cycle
 * skipped while hidden is replayed as soon as the tab comes back.
 */
export function createPoller({
  load,
  intervalMs = DEFAULT_INTERVAL_MS,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (handle) => clearTimeout(handle),
  visibility = documentVisibility(),
} = {}) {
  if (typeof load !== 'function') throw new TypeError('createPoller requires a load function.');
  let timer = null;
  let unsubscribe = () => {};
  let stopped = false;
  let running = false;
  let missedWhileHidden = false;

  const cancelPending = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  const schedule = () => {
    if (stopped || timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      run();
    }, intervalMs);
  };

  const run = () => {
    if (stopped || running) return;
    if (!visibility.isVisible()) {
      missedWhileHidden = true;
      schedule();
      return;
    }
    running = true;
    missedWhileHidden = false;
    let settled;
    try {
      settled = Promise.resolve(load());
    } catch (error) {
      settled = Promise.reject(error);
    }
    settled
      .catch(() => {})
      .finally(() => {
        running = false;
        if (stopped) return;
        cancelPending();
        schedule();
      });
  };

  return {
    start() {
      if (stopped) return;
      unsubscribe = visibility.subscribe(() => {
        if (stopped || !visibility.isVisible() || !missedWhileHidden) return;
        cancelPending();
        run();
      });
      run();
    },
    refreshNow() {
      cancelPending();
      run();
    },
    stop() {
      stopped = true;
      cancelPending();
      unsubscribe();
      unsubscribe = () => {};
    },
  };
}
