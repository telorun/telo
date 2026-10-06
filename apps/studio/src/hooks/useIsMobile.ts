import { useSyncExternalStore } from "react";

/** Below Tailwind's `md`: the width at which the side columns stop fitting
 *  beside the content. The same boundary the `max-md:` classes use. */
const MOBILE_QUERY = "(max-width: 767.98px)";

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(MOBILE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Whether the window is phone-width. Only for what CSS cannot do — moving a
 *  column into an overlay; spacing and visibility use `max-md:` classes. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  );
}
