import type { InvokeContext } from "@telorun/sdk";

/** How a take ends. `taken` carries the delivered payload; the other three consumed nothing. */
export type TakeOutcome =
  | { outcome: "taken"; payload: unknown }
  | { outcome: "timedOut" }
  | { outcome: "cancelled" }
  | { outcome: "busy" };

/** How an offer ends: handed to a waiting take, or held for a later one. */
export type OfferOutcome = { outcome: "delivered" } | { outcome: "held" };

/**
 * The `Rendezvous.Point` contract (normative: `docs/point-contract.md`). A point
 * meets one take and one offer per key; whichever arrives first waits for the
 * other. Neither operation rejects on an outcome above — `Await` and `Deliver`
 * own every code.
 */
export interface RendezvousPoint {
  /** Wait for a value under `key` for up to `timeoutMs`, taking a held one at once.
   *  Cancellation arrives through `invokeCtx`. */
  take(key: string, timeoutMs: number, invokeCtx?: InvokeContext): Promise<TakeOutcome>;
  /** Hand `payload` to the take waiting under `key`, or hold it for the point's `hold`
   *  window, replacing a value already held there and restarting the window. */
  offer(key: string, payload: unknown, invokeCtx?: InvokeContext): Promise<OfferOutcome>;
}

/** Duck-typed, not `instanceof`: a point may be implemented in another module,
 *  whose bundle is its own. */
export function isRendezvousPoint(value: unknown): value is RendezvousPoint {
  const point = value as Partial<RendezvousPoint> | undefined;
  return typeof point?.take === "function" && typeof point.offer === "function";
}
