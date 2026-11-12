import { useEffect, useRef } from "react";

/**
 * `reloadEvery`: `reload` every `interval` milliseconds while `active` — the
 * node is shown. A tick is skipped while `inFlight` says a read of the node is
 * under way, and is not run while the document is hidden; coming back to
 * visibility runs one read if an interval has passed since the last, and the
 * interval starts again from it. Nothing runs when `interval` is unset.
 */
export function useReloadEvery(interval: number | undefined, active: boolean, inFlight: () => boolean, reload: () => void): void {
  const latest = useRef({ inFlight, reload });
  latest.current = { inFlight, reload };
  useEffect(() => {
    if (interval === undefined || !active) return;
    let last = Date.now();
    const tick = () => {
      if (document.visibilityState === "hidden" || latest.current.inFlight()) return;
      last = Date.now();
      latest.current.reload();
    };
    let timer = setInterval(tick, interval);
    const onVisibility = () => {
      if (document.visibilityState === "hidden" || Date.now() - last < interval) return;
      clearInterval(timer);
      tick();
      timer = setInterval(tick, interval);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [interval, active]);
}
