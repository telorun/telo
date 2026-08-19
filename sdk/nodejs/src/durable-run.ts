/**
 * The durable-execution replay seam — `kernel/specs/durable-execution.md`.
 *
 * Durable execution is **journal plus deterministic replay**, and Telo can have
 * it because of a property that fell out of `Run.Sequence`'s design: control
 * flow is a finite, DECLARED set of CEL expressions over run state, not
 * arbitrary code. So replay is re-running the step list while returning recorded
 * values instead of computing them. No continuation capture.
 *
 * **What is shared is this narrow seam, not a portable engine vocabulary.** The
 * temptation is to abstract durable execution itself — one surface every backend
 * implements — and it fails the same way twice: the abstraction becomes the
 * union of every engine's lifecycle model (identity policy, schedule overlap,
 * cancel-versus-terminate, deployment pinning), and each backend still loses the
 * half of its own model that did not generalize. Portability is close to
 * worthless here — in-flight runs do not migrate between engines, the
 * configuration shares nothing, and nobody switches durable engines twice.
 *
 * The real constraint is that **the step engine must not fork**. It lives in
 * this package, which is symlinked into every controller bundle rather than
 * inlined, so there is exactly one implementation however many backends exist.
 * What still needs a seam is the other half — *whether and where a step
 * executes* — and that is all this file is.
 *
 * **The kernel is a pure conduit**: it carries the handle on `InvokeContext` and
 * never calls it, which is why the contract lives here rather than in the kernel
 * — the split logging already makes between `Logger` / `RecordBuffer` and the
 * `Telo.LogSink` abstract. The consequence is stated rather than implied: unlike
 * `zones`, this member does NOT cross the ABI, so a second runtime threads a
 * handle it owns.
 */

import type { InvokeContext, ZoneEntry } from "./cancellation.js";
import { InvokeError } from "./invoke-error.js";
import { VALUE_TYPES, VALUE_TYPE_BINDINGS } from "./value-type.js";
import type { OpenZoneAttributes, ZoneAttributes } from "./zone-attribute.js";

/**
 * WHERE a step's target is declared, as opposed to which live object it is.
 *
 * This is the part of `step()` that nothing may move later, and it is what keeps
 * the seam from being theatre. A target arrives at the engine as a **live
 * instance** — Phase-5 injection has already replaced the `!ref` sentinel — and
 * instance identity is process-local by construction (`ResourceHandle.ref` is
 * declaration-site *diagnostics*, and there is deliberately no reverse
 * handle→instance mapping). A backend asked to execute a step somewhere else
 * would therefore have nothing to resolve, which would make the remote half
 * unreachable and reduce `step(path, target, inputs)` to lookup-plus-record
 * under a longer name.
 *
 * The three forms follow the three ways a resource is declared, and each is
 * derivable identically by the analyzer and at runtime. The ENCODING — how one
 * is written into bytes that cross a process boundary — is deliberately not
 * fixed here: nothing in this slice sends one anywhere, and a normative format
 * frozen with no consumer is the failure the sequencing rule exists to prevent.
 */
export interface DurableTarget {
  /** Canonical `<module>.<Kind>` of the target. */
  readonly kind: string;
  /** The target's `metadata.name`. Names are dot-free by the reference
   *  grammar's load-bearing invariant, so `(module, name)` is unambiguous. */
  readonly name: string;
  /** Source of the module that DECLARED the target, when known — the half that
   *  disambiguates two libraries each declaring a `store`. */
  readonly module?: string;
  /** A `with:`-scoped instance: the scope run is what makes it distinct, and
   *  inside a durable run a scope run is opened by a step at a determined path,
   *  so the tuple stays deterministic. */
  readonly scope?: {
    readonly owner: string;
    readonly site: string;
    readonly stepPath: string;
  };
  /** An inline declaration: anonymous in the manifest, not anonymous in the
   *  graph — the call graph already gives one its own node. */
  readonly pointer?: string;
}

/** Why a decision was recorded. Carried for diagnostics and for a backend that
 *  wants to render a run; the engine's own behaviour does not branch on it. */
export type DurableDecisionKind =
  | "inputs"
  | "predicate"
  | "condition"
  | "collection"
  | "switch"
  | "value";

/**
 * The three operations a backend implements, and the middle one is the whole
 * design.
 *
 * A fourth member is a **question, not an operation** ({@link writesInside}).
 */
export interface DurableRunHandle {
  /** This run's identity, as the backend minted or accepted it. */
  readonly runId: string;

  /**
   * Hand over an effect to be performed: the backend decides **whether**
   * (replay returns the recorded result) and **where** (in process now, or
   * shipped elsewhere and awaited).
   *
   * `execute` performs the in-process dispatch. Passing it is NOT the
   * lookup-plus-record decomposition this seam rejects — there the CALLER
   * performed the effect between two halves of one operation, which silently
   * fixed the step engine and the resource graph in one process. Here the
   * backend decides; `execute` is merely the local capability it may choose to
   * use, and a relocating backend ignores it and ships `target` instead.
   *
   * Wherever a step ends up running, the executing side MUST dispatch through
   * its kernel's invocation chokepoint, so the invocation contract, tracing,
   * zones and observed state hold identically. A backend may move WHERE a step
   * executes; it may not move it outside the runtime's dispatch.
   */
  step(
    path: string,
    target: DurableTarget | undefined,
    inputs: unknown,
    execute: () => Promise<unknown>,
  ): Promise<unknown>;

  /**
   * Record a control-flow decision on first execution and return it verbatim on
   * replay — a resolved input set, a branch predicate, a loop condition, an
   * iteration collection.
   *
   * **This is the load-bearing half.** The tempting claim — "a run's entire
   * mutable state is the `steps` map" — is FALSE: the CEL scope a step's inputs
   * and a branch's predicate evaluate against also carries `resources.<name>`
   * snapshots, `resources.<name>.status` (a live reading, republished on every
   * dispatch BY DESIGN), provider values, variables and secrets. Re-evaluating
   * any of those in a fresh process against freshly-created resources can yield
   * a different answer, and the sharpest case is silent: an iteration whose
   * collection comes from a resource read returns a different order on resume,
   * index N now names a different element, and the journal hands back the
   * recorded result for that path — with the same target, so no mismatch is
   * detectable. Wrong results, no error.
   *
   * Recording the value rather than a digest is deliberate. Digest-and-detect is
   * equally closed for DETECTION and much cheaper, and it is wrong: observed
   * state is *defined* as a live reading, so a run would fail on every resume
   * where the world had moved, which it usually has. That is not durability; it
   * is fragility with good error messages.
   *
   * Replay is then a pure function of `(journal, manifest)` — a CLOSURE
   * property, and closure is what makes this survive an ambient value source
   * added years from now without anyone re-auditing a list.
   */
  decide<T>(path: string, kind: DurableDecisionKind, compute: () => T): Promise<T>;

  /**
   * Suspend the run until a time or a token.
   *
   * **A park is recorded, not merely thrown.** `where` is what makes it
   * recoverable: the step path is where a resume re-enters and where a delivery
   * writes its payload, so a backend that took only `until` could wake a run
   * without knowing what it was waiting at. The parking resource's name rides
   * along for diagnostics, since "run 41 is parked" is not an operator's answer.
   *
   * Called through {@link parkRun}, never directly — the latch that catches a
   * swallowed suspension is set there, so a backend cannot forget it.
   */
  park(
    where: { readonly path: string; readonly resource: string },
    until: { readonly at?: number; readonly token?: string },
  ): Promise<never>;

  /**
   * Does this handle's own recording land inside the given zone's atomicity?
   *
   * A question, not an operation — and it is what lets the step engine stop
   * collapsing an `atomic` zone when collapsing would be pessimistic. A
   * collapsed atomic zone is at-least-once (the whole zone re-runs on resume,
   * because a crash between COMMIT and the journal write leaves work done and
   * unrecorded) and that is unavoidable ONLY while the journal is somewhere
   * else. When the journal writes into the very transaction whose effects it
   * records, COMMIT is atomic over both and the window closes.
   *
   * So the collapse rule reads the attribute correctly rather than overriding
   * it: `atomic` says *effects inside are discarded together*, and collapse
   * follows only when the journal's own writes are NOT among them.
   *
   * Every backend that cannot answer yes returns false and behaves exactly as it
   * would have without the question existing.
   */
  writesInside(zone: ZoneEntry): boolean;

  /**
   * Told when a region was collapsed to one entry, and why.
   *
   * Optional, and a NOTIFICATION rather than a question: the collapse decision
   * is the step engine's, and the handle is being informed so it can report.
   * That reporting is a conformance requirement rather than a nicety — whether a
   * deployment got exactly-once or at-least-once turns on whether the journal's
   * writes land inside the transaction's atomicity, which is a runtime
   * coincidence the manifest cannot show. A durability feature whose guarantee
   * is decided invisibly has to say which way it resolved.
   */
  noteCollapsed?(info: {
    readonly zone: string;
    readonly attribute: "atomic" | "idempotent";
    readonly reason: string;
  }): void;
}

/**
 * Compose a step path — the journal's key, and the reason journaling lives in
 * the step engine at all.
 *
 * A step path is the only naturally deterministic key available, and it survives
 * CONCURRENCY where a per-run call ordinal would not: two branches of a
 * concurrent fan-out interleave their dispatches, so an ordinal would number
 * them differently on every run while their paths stay fixed. It is also what
 * makes each branch of a fan-out an independently resumable subtree.
 *
 * Segments are joined with `/`; a repetition (a loop turn, an iteration element)
 * qualifies its segment with `[index]`. Both are properties of the WRITTEN
 * structure plus the run's own decisions, never of wall-clock order.
 */
export function stepPath(...segments: (string | number)[]): string {
  return segments
    .map((s) => (typeof s === "number" ? `[${s}]` : s))
    .join("/")
    .replace(/\/\[/g, "[");
}

/** True when a run handle is ambient — the test the step engine makes before it
 *  journals anything, so a non-durable sequence pays nothing. */
export function durableHandleOf(ctx: InvokeContext | undefined): DurableRunHandle | undefined {
  return ctx?.durable;
}

/**
 * What the step engine consults before journaling anything — the collapse rule,
 * read off the ambient zone stack.
 *
 * > A region collapses to one entry when **re-running it is safe** — because its
 * > effects are discarded together, or because re-running is a no-op.
 *
 * The rule has no fields in it, at either end. It used to be a caller-side
 * `checkpoint: collapse` plus a callee-side `requireCheckpoints:` veto, which
 * was wrong four ways at once: a boolean where every neighbouring annotation
 * carries a reason; the opposite polarity from *everything journaled by
 * default*, so forgetting to veto was silent; a veto available only on
 * `Run.Sequence`, leaving a collapsed script or imported invocable unprotected;
 * and a contradiction check to reconcile it with atomicity. Underneath all four,
 * collapse was sold as a cost lever while being a CORRECTNESS decision — it
 * silently converts exactly-once into at-least-once.
 *
 * A region with a property is a zone, so it is declared the way every other
 * region property is. Nothing collapses a sequence because nothing wrapped it.
 */
export function collapsesJournalEntries(
  zones: readonly { kind: string; attributes: ZoneAttributes; entry: ZoneEntry }[],
  handle: DurableRunHandle,
): { collapsed: boolean; zone?: string; attribute?: "atomic" | "idempotent"; reason?: string } {
  for (const zone of zones) {
    // `idempotent` collapses FULL STOP: there is nothing for the journal to be
    // inside, and re-running is a no-op either way.
    if (zone.attributes.idempotent) {
      return {
        collapsed: true,
        zone: zone.kind,
        attribute: "idempotent",
        reason: zone.attributes.idempotent,
      };
    }
    // `atomic` collapses UNLESS the handle attests its own writes land inside
    // that atomicity. This is not an override of the attribute; it is the
    // attribute read correctly — *effects inside are discarded together*, so
    // collapse follows only when the journal's writes are not among them. When
    // they are, per-step journaling is consistent by construction AND strictly
    // better: finer replay granularity, and no re-running a committed
    // transaction.
    if (zone.attributes.atomic) {
      if (handle.writesInside(zone.entry)) continue;
      return {
        collapsed: true,
        zone: zone.kind,
        attribute: "atomic",
        reason: zone.attributes.atomic,
      };
    }
  }
  return { collapsed: false };
}

/** The zone-reading half of a step context — declared here so both the leaf and
 *  the engine read the collapse rule through one signature. */
export interface ZoneReadingContext {
  zoneAttributes?(ctx?: InvokeContext): readonly OpenZoneAttributes[];
}

/**
 * Should the step engine record nothing of its own right here?
 *
 * True inside a collapsed region, where per-step entries would describe work
 * that is about to happen again — the region re-runs whole on resume, which is
 * exactly what its author's attribute claims is safe.
 *
 * A host with no zone machinery reads as "no zone open", which journals MORE
 * rather than less: the safe direction, since an unjournaled effect re-executes
 * silently while a redundant entry costs a write.
 */
export function journalingSuppressed(
  ctx: ZoneReadingContext,
  invokeCtx: InvokeContext | undefined,
  handle: DurableRunHandle,
): boolean {
  const zones = ctx.zoneAttributes?.(invokeCtx);
  if (!zones || zones.length === 0) return false;
  const verdict = collapsesJournalEntries(zones, handle);
  if (verdict.collapsed && verdict.zone && verdict.attribute && verdict.reason) {
    handle.noteCollapsed?.({
      zone: verdict.zone,
      attribute: verdict.attribute,
      reason: verdict.reason,
    });
  }
  return verdict.collapsed;
}

/**
 * Reject a value that cannot survive being recorded and read back.
 *
 * **`JSON.stringify` is not the test, and believing it was left the gate open.**
 * A live handle has no enumerable state, so `JSON.stringify(stream)` returns
 * `{}` and throws nothing — the one case the spec names first would have been
 * recorded as an empty object and replayed as one, which is silent corruption
 * rather than the loud failure §6 requires. The static half is deliberately only
 * a warning ("the runtime is the gate"), so a gate that cannot see the case
 * leaves it unenforced end to end.
 *
 * So a live value is detected STRUCTURALLY, by the value-type vocabulary's own
 * binding table: an entry declaring `live: true` names a binding, and the host's
 * table maps that binding to the constructor an assertion tests against. No type
 * name is written here, so a live type added later is covered by its entry
 * alone — the same reason the static rule reads the `live` field rather than
 * naming `Telo.Stream`.
 *
 * Lives in the SDK rather than in a backend because it is a property of the
 * CONTRACT (spec §6), not of one journal: a backend that skipped it would be
 * non-conforming in a way nothing else could catch.
 */
export function assertJournalable(value: unknown, where: { run: string; path: string }): void {
  const live = findLiveValue(value, new Set());
  if (live) {
    throw new InvokeError(
      "ERR_DURABLE_UNJOURNALABLE_VALUE",
      `Run '${where.run}': the value produced at '${where.path}' contains a ${live} handle, ` +
        `which cannot be recorded. A live value is produced by CONSUMING it, so it exists ` +
        `exactly once and a record of it would be a record of nothing — a replay would hand ` +
        `the next step an empty value instead of the data. Read what you need out of it ` +
        `inside the step and return that, or move the streaming work outside the durable body.`,
      { run: where.run, path: where.path, valueType: live },
    );
  }
  try {
    JSON.stringify(value);
  } catch (err) {
    throw new InvokeError(
      "ERR_DURABLE_UNJOURNALABLE_VALUE",
      `Run '${where.run}': the value produced at '${where.path}' cannot be serialized ` +
        `(${(err as Error).message}). A durable step's result and every decision it reaches ` +
        `must survive being written and read back.`,
      { run: where.run, path: where.path },
      { cause: err },
    );
  }
}

/** The name of the first live value type found anywhere in `value`, or
 *  undefined. Walks plain containers only — a class instance that is not a live
 *  type is left to the serializer to judge, since `toJSON` may well make it
 *  recordable. */
function findLiveValue(value: unknown, seen: Set<object>): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  for (const entry of VALUE_TYPES.values()) {
    if (!entry.live || !entry.binding) continue;
    const binding = VALUE_TYPE_BINDINGS[entry.binding];
    if (binding && value instanceof binding.constructor) return entry.name;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findLiveValue(item, seen);
      if (found) return found;
    }
    return undefined;
  }
  // Only plain objects are descended into: walking an arbitrary instance's
  // fields would report a live handle a `toJSON` was about to drop anyway.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return undefined;
  for (const item of Object.values(value as Record<string, unknown>)) {
    const found = findLiveValue(item, seen);
    if (found) return found;
  }
  return undefined;
}
