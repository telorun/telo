/**
 * Suspension — the signal a parking kind raises, and the latch that catches a
 * swallowed one. Slice 4 of `kernel/specs/durable-execution.md`.
 *
 * **Suspension is a distinct signal, not an error.** It unwinds the stack to the
 * workflow boundary, so a `try:` step must not catch it, a composer's
 * `catches:` must not map it, and a retry policy must not re-attempt it. Those
 * three sites rethrow on {@link isSuspension} before they convert anything.
 *
 * **But naming the known swallowers is not a defence.** The signal passes
 * through every controller between the parking kind and the workflow — HTTP
 * handlers, agent tool loops, a cache view, and any third-party controller with
 * a `catch (e)` in it. A swallowed suspension silently converts a park into a
 * completed step and duplicates every effect after it, and a pure-conduit kernel
 * cannot see that happen. Enumerating the swallowers is unbounded and would go
 * stale on the next module.
 *
 * So it is **latched, not just thrown**: {@link parkRun} records the signal
 * against the run handle at the moment it raises, and the workflow kind treats
 * *an invocation that returned normally while a suspension is latched* as a hard
 * error ({@link assertNotSwallowed}). Detection is O(1), needs no cooperation
 * from the swallower, and turns an unbounded-surface silent corruption into one
 * loud failure at the boundary that owns the run.
 *
 * **The latch lives here rather than on the backend's handle**, and the
 * distinction is what makes it a guarantee: a backend that had to set it could
 * forget to, and the failure of forgetting is the silent corruption this exists
 * to catch. It is a `WeakMap` in the SDK — the one package with a single scope
 * per process (`REALM_COLLAPSE_NAMES` symlinks it onto the kernel's copy), so
 * the payload rule's "provider-private state hangs off an injected instance"
 * does not bite: there is exactly one map however many controller bundles are
 * loaded.
 */

import type { InvokeContext } from "./cancellation.js";
import type { DurableRunHandle } from "./durable-run.js";
import { InvokeError } from "./invoke-error.js";

/**
 * The backoff above which a retry PARKS instead of sleeping.
 *
 * A threshold is unavoidable and so is stating where it came from. Below it,
 * sleeping in process is cheaper than a park: a park is a journal write, a
 * process exit and a poller pass, and paying that to save a few seconds of an
 * idle timer is worse on both counts. Above it, holding a process open to wait
 * is precisely what durability exists to stop — and the plan's own retry
 * example (`delay: 10s`, three attempts) sits deliberately below it, while a
 * policy backing off to minutes sits above.
 *
 * Shared with the analyzer, which decides statically whether a step's declared
 * policy COULD suspend, so the check and the behaviour cannot disagree about
 * where the line is.
 */
export const SUSPENDING_BACKOFF_MS = 30_000;

/** The code every suspension carries, so a runtime that only sees a shape can
 *  still recognise one. */
export const ERR_DURABLE_SUSPENDED = "ERR_DURABLE_SUSPENDED";

/** Where a parked run is waiting for. Exactly one half is meaningful to a
 *  backend at a time, but both may be present: an await with a deadline parks on
 *  its token AND is due at a time. */
export interface ParkUntil {
  /** Epoch milliseconds at which the run becomes due. */
  readonly at?: number;
  /** The token a delivery must carry to wake this run. */
  readonly token?: string;
}

/**
 * The signal itself.
 *
 * An `Error` so it unwinds, and deliberately **not** an {@link InvokeError}: an
 * `InvokeError` is the channel a `catches:` list maps by code, and a suspension
 * that could be named there would be catchable by configuration — which is the
 * corruption, spelled as a feature.
 */
export class DurableSuspension extends Error {
  readonly code = ERR_DURABLE_SUSPENDED;

  constructor(
    /** The run that parked. */
    readonly runId: string,
    /** The step path it parked at — the journal key its park is recorded under. */
    readonly path: string,
    /** The parking resource's `metadata.name`, so the diagnostic names what
     *  waited rather than only where. */
    readonly resource: string,
    readonly until: ParkUntil,
  ) {
    super(
      `Run '${runId}' parked at '${path}' (${resource}). This is a suspension signal, not a ` +
        `failure: it must reach the workflow that owns the run.`,
    );
    this.name = "DurableSuspension";
  }
}

/** Is this the suspension signal? Structural rather than `instanceof`, for the
 *  same reason every other cross-boundary test here is: the SDK is one scope per
 *  process today, and a runtime that threads a handle it owns should still be
 *  recognised. */
export function isSuspension(err: unknown): err is DurableSuspension {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === ERR_DURABLE_SUSPENDED
  );
}

const LATCHED = new WeakMap<DurableRunHandle, DurableSuspension>();

/**
 * Park the run — the one way a parking kind suspends.
 *
 * Latches first, then asks the backend to record the park, then throws. Each of
 * the three is load-bearing. Latching FIRST means a backend whose `park()`
 * itself throws something else still leaves the evidence behind. Throwing here
 * rather than trusting `park()`'s `Promise<never>` means a backend that returns
 * — the one bug that would convert a wait into a completed step — is caught by
 * the seam instead of by whatever ran next.
 */
export async function parkRun(
  handle: DurableRunHandle,
  where: { readonly path: string; readonly resource: string },
  until: ParkUntil,
): Promise<never> {
  const signal = new DurableSuspension(handle.runId, where.path, where.resource, until);
  LATCHED.set(handle, signal);
  await handle.park(where, until);
  throw signal;
}

/** The suspension latched against this run, if one was raised during this
 *  execution. */
export function latchedSuspension(handle: DurableRunHandle): DurableSuspension | undefined {
  return LATCHED.get(handle);
}

/**
 * The workflow boundary's check: a body that returned normally while a
 * suspension is latched swallowed one.
 *
 * Raised rather than repaired, because there is nothing to repair: every effect
 * after the swallow already ran, un-parked and un-recorded, and the run's own
 * record would say it completed. What is actionable is the pair of names — the
 * resource that parked and the step path — since the swallower is somewhere
 * between them.
 */
export function assertNotSwallowed(handle: DurableRunHandle): void {
  const signal = LATCHED.get(handle);
  if (!signal) return;
  throw new InvokeError(
    "ERR_DURABLE_SUSPENSION_SWALLOWED",
    `Run '${signal.runId}': '${signal.resource}' parked the run at step '${signal.path}', but ` +
      `the body returned normally — something between them caught the suspension signal and ` +
      `continued. Every step after the park has now run outside the journal, and the run would ` +
      `have been recorded as completed. A controller in that path has a 'catch' that swallows ` +
      `unknown errors; it must rethrow anything it did not recognise.`,
    { run: signal.runId, path: signal.path, resource: signal.resource },
  );
}

/**
 * Refuse to park inside a zone that forbids it.
 *
 * The runtime half of `noSuspend` — one rule rather than an enumeration of
 * forbidden kinds, so a parking kind added later is covered without touching
 * anything here. The zone's own declared sentence is printed verbatim: it is the
 * author's statement of what is being held open, and nothing generated says it
 * better.
 */
export function assertMaySuspend(
  ctx: { zoneAttributes?(ctx?: InvokeContext): readonly { kind: string; attributes: { noSuspend?: string } }[] },
  invokeCtx: InvokeContext | undefined,
  where: { readonly resource: string },
): void {
  for (const zone of ctx.zoneAttributes?.(invokeCtx) ?? []) {
    const reason = zone.attributes.noSuspend;
    if (!reason) continue;
    throw new InvokeError(
      "ERR_DURABLE_SUSPEND_FORBIDDEN",
      `'${where.resource}' would park the run, but it is inside a ${zone.kind} zone that ` +
        `cannot be held open across a suspension: ${reason}`,
      { resource: where.resource, zone: zone.kind, reason },
    );
  }
}
