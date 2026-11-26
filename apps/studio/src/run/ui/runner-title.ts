/**
 * The name a runner is titled by: the stored one, unless it is only the
 * adapter's generic label (a runner added before it answered with its own
 * name), in which case the advertised name wins once known.
 */
export function runnerTitle(stored: string | undefined, advertised: string | undefined, adapterLabel: string): string {
  if (stored && stored !== adapterLabel) return stored;
  return advertised ?? stored ?? adapterLabel;
}

/** Capabilities an address answered, held for exactly that address: a new URL has none until it answers. */
export interface AnsweredCapabilities<T> {
  url: string;
  caps: T | null;
}

export function capabilitiesAt<T>(url: string, answered: AnsweredCapabilities<T> | null): T | null {
  return answered && answered.url === url ? answered.caps : null;
}
