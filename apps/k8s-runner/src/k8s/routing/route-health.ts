import { abortableDelay, type RouteState } from "@telorun/runner-core";

import { apiReason } from "../api-error.js";
import type { PublishedRoute, SessionRouter } from "./session-router.js";

export interface WatchRouteHealthOptions {
  router: SessionRouter;
  sessionId: string;
  /** The hosts `publish` reported. Empty → nothing to watch. */
  routes: PublishedRoute[];
  /** Receives every transition for one host. */
  onState: (route: PublishedRoute, state: RouteState, reason?: string) => void;
  /** Aborts the watch — wire to the session's teardown. */
  signal: AbortSignal;
  /** How long a route may stay unclaimed before it is reported `unprogrammed`. */
  timeoutMs: number;
  /** Poll interval while waiting for a verdict. */
  intervalMs?: number;
  /** Receives a read failure once, so a permanent one (a missing RBAC grant, an
   *  unserved API version) reaches the runner's log and not only the client. */
  onReadError?: (err: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 2_000;

/**
 * Watch whether the routing layer actually programmed each published host.
 *
 * This is the check whose absence made an unroutable cluster indistinguishable
 * from a healthy one: the runner already dials the workload's own address, which
 * proves the app is listening and says nothing about whether traffic can reach
 * it. A session whose routing objects are reconciled by no controller reported
 * every port reachable while every public URL 404'd.
 *
 * REPORTS, never fails the session: a slow controller and an absent one look the
 * same for the first few seconds, and killing a healthy session over routing that
 * arrives late would trade a visible problem for a worse one.
 */
export async function watchRouteHealth(options: WatchRouteHealthOptions): Promise<void> {
  const { router, sessionId, routes, onState, signal } = options;
  if (routes.length === 0) return;
  const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + options.timeoutMs;

  const pending = new Map(routes.map((r) => [r.host, r]));
  for (const route of routes) onState(route, "pending");

  // A read failure is NOT a verdict, but it is also not nothing: a permanent one
  // (no RBAC on the routing objects, an API version this runner did not resolve)
  // polls out the whole deadline and would otherwise be reported as
  // `unclaimedReason()` — sending an operator to inspect the Gateway when the
  // runner could not read its own object. So the last one is retained and wins
  // at the deadline.
  let lastReadError: unknown;
  let reportedReadError = false;

  while (pending.size > 0 && !signal.aborted) {
    for (const [host, route] of [...pending]) {
      if (signal.aborted) return;
      let verdict;
      try {
        verdict = await router.verdictFor(sessionId, route);
      } catch (err) {
        lastReadError = err;
        if (!reportedReadError) {
          reportedReadError = true;
          options.onReadError?.(err);
        }
        continue;
      }
      // A verdict of ANY kind proves the read path works, so an earlier failure
      // was transient and must not decide the message at the deadline.
      lastReadError = undefined;
      if (verdict.kind === "programmed") {
        pending.delete(host);
        onState(route, "programmed");
      } else if (verdict.kind === "rejected") {
        pending.delete(host);
        onState(route, "unprogrammed", verdict.reason);
      }
    }
    if (pending.size === 0) return;
    if (Date.now() >= deadline) break;
    await abortableDelay(interval, signal);
  }

  if (signal.aborted) return;
  const reason =
    lastReadError !== undefined
      ? `route status could not be read: ${apiReason(lastReadError)}`
      : router.unclaimedReason();
  for (const route of pending.values()) {
    onState(route, "unprogrammed", reason);
  }
}
