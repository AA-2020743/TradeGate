/**
 * Attaches a handler to `promise` immediately and reports its outcome as a
 * value. Starting work early and awaiting it later is only safe if nothing in
 * between can throw: an early return leaves the in-flight promise with no
 * rejection handler, and Node terminates the process for that — so a single
 * provider 403 could end the whole server.
 */
export function settle(promise) {
  return Promise.resolve(promise).then(
    (value) => ({ ok: true, value, error: null }),
    (error) => ({ ok: false, value: null, error }),
  );
}

/** Re-raises a settled failure at the point the caller actually needs the value. */
export function unwrap(result) {
  if (!result?.ok) throw result?.error ?? new Error('Settled result carried no value.');
  return result.value;
}
