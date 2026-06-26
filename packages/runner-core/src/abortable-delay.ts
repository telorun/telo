/**
 * Resolve after `ms`, or immediately when `signal` aborts. Safe to call in a
 * poll loop on a shared signal: it removes its abort listener on the timer path
 * (so repeated calls can't accumulate listeners) and fast-paths an
 * already-aborted signal (so a loop tears down promptly instead of waiting out
 * one more interval). The timer is `unref`'d so a pending delay can't keep the
 * process alive on its own.
 */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
