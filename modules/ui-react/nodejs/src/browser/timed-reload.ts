import { useEffect, useRef } from "react";

/**
 * `reloadEvery` outside a component: `reload` every `interval` milliseconds
 * between `start` and `stop`. A tick is skipped while `inFlight` says a read is
 * under way, and is not run while the document is hidden; coming back to
 * visibility runs one read if an interval has passed since the last, and the
 * interval starts again from it.
 */
export class ReloadTimer {
  private stopping?: () => void;

  constructor(
    private readonly interval: number,
    private readonly inFlight: () => boolean,
    private readonly reload: () => void,
  ) {}

  get running(): boolean {
    return this.stopping !== undefined;
  }

  start(): void {
    if (this.stopping) return;
    const interval = this.interval;
    let last = Date.now();
    const tick = () => {
      if (document.visibilityState === "hidden" || this.inFlight()) return;
      last = Date.now();
      this.reload();
    };
    let timer = setInterval(tick, interval);
    const onVisibility = () => {
      if (document.visibilityState === "hidden" || Date.now() - last < interval) return;
      clearInterval(timer);
      tick();
      timer = setInterval(tick, interval);
    };
    document.addEventListener("visibilitychange", onVisibility);
    this.stopping = () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }

  stop(): void {
    this.stopping?.();
    this.stopping = undefined;
  }
}

/**
 * `reloadEvery` in a component: a {@link ReloadTimer} running while `active` —
 * the node is shown. Nothing runs when `interval` is unset.
 */
export function useReloadEvery(interval: number | undefined, active: boolean, inFlight: () => boolean, reload: () => void): void {
  const latest = useRef({ inFlight, reload });
  latest.current = { inFlight, reload };
  useEffect(() => {
    if (interval === undefined || !active) return;
    const timer = new ReloadTimer(
      interval,
      () => latest.current.inFlight(),
      () => latest.current.reload(),
    );
    timer.start();
    return () => timer.stop();
  }, [interval, active]);
}
