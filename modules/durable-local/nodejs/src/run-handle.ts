/**
 * This backend's implementation of the replay seam — `kernel/specs/durable-execution.md`.
 *
 * All three operations land in a `DurableLocal.Journal` with in-process
 * dispatch. Under a hosted engine the same three would be protocol frames on an
 * open invocation, and the step engine cannot tell the difference; that is the
 * entire extent of what the backends share.
 */
import {
  InvokeError,
  assertJournalable,
  type DurableDecisionKind,
  type DurableRunHandle,
  type DurableTarget,
  type ZoneEntry,
} from "@telorun/sdk";
import type { DurableJournal, JournalEntry, RecordedTarget } from "./journal.js";

/** What a run learns about itself while executing — reported as observed state
 *  by the workflow, because whether a deployment got exactly-once or
 *  at-least-once is decided by a runtime coincidence the manifest cannot show. */
export interface RunObservations {
  replayedSteps: number;
  collapsedRegions: number;
  /** The author's own sentence for each collapsed region, so an operator asking
   *  "why is this at-least-once" reads the manifest's reason rather than a
   *  generic message. */
  collapseReasons: string[];
}

export class LocalRunHandle implements DurableRunHandle {
  /** Entries already on disk when this execution started, by path. A resume
   *  reads them ONCE rather than per step: the journal is append-only within a
   *  run, and re-reading per lookup would turn an N-step replay into N reads. */
  readonly #recorded = new Map<string, JournalEntry>();
  readonly observations: RunObservations = {
    replayedSteps: 0,
    collapsedRegions: 0,
    collapseReasons: [],
  };
  readonly #collapsed = new Set<string>();

  private constructor(
    readonly runId: string,
    private readonly journal: DurableJournal,
  ) {}

  static async open(runId: string, journal: DurableJournal): Promise<LocalRunHandle> {
    const handle = new LocalRunHandle(runId, journal);
    for (const entry of await journal.readEntries(runId)) {
      // First write wins here too, mirroring the store's own rule — so a journal
      // that somehow holds two entries at one path replays the same one the
      // store would return.
      if (!handle.#recorded.has(entry.path)) handle.#recorded.set(entry.path, entry);
    }
    return handle;
  }

  async step(
    path: string,
    target: DurableTarget | undefined,
    _inputs: unknown,
    execute: () => Promise<unknown>,
  ): Promise<unknown> {
    const recorded = this.#recorded.get(path);
    if (recorded) {
      // A replay that reaches a DIFFERENT target than the entry records is
      // divergence — the manifest moved under a live run — and answering for it
      // would hand this step someone else's result. There is nothing to record
      // against, so it raises rather than repairing.
      if (target && recorded.target && !sameTarget(recorded.target, target)) {
        throw new InvokeError(
          "ERR_JOURNAL_ENTRY_MISMATCH",
          `Run '${this.runId}': the journal records ${recorded.target.kind} ` +
            `'${recorded.target.name}' at step '${path}', but this execution reached ` +
            `${target.kind} '${target.name}'. The body changed under a live run; replaying ` +
            `would give this step a result produced by a different resource.`,
          { run: this.runId, path, recorded: recorded.target, reached: target },
        );
      }
      this.observations.replayedSteps++;
      return recorded.value;
    }

    // Nothing recorded: perform the effect HERE, which is this backend's answer
    // to the seam's "where" — a relocating backend would ignore `execute` and
    // ship `target` instead. Recorded on COMPLETION, so a step interrupted
    // mid-flight has no entry and re-executes rather than being skipped.
    const result = await execute();
    return this.#write({
      path,
      kind: "step",
      value: result,
      // The whole identity is recorded, `module` included: it is what
      // distinguishes two libraries that each declare a resource of the same
      // name, and a mismatch check that never had it could not see the case.
      ...(target
        ? {
            target: {
              kind: target.kind,
              name: target.name,
              ...(target.module === undefined ? {} : { module: target.module }),
            },
          }
        : {}),
    });
  }

  async decide<T>(path: string, kind: DurableDecisionKind, compute: () => T): Promise<T> {
    const recorded = this.#recorded.get(path);
    if (recorded) return recorded.value as T;
    return (await this.#write({ path, kind: "decision", decision: kind, value: compute() })) as T;
  }

  async park(): Promise<never> {
    // Suspension is v1.1. Refusing loudly is the only honest answer: a park that
    // silently returned would convert a wait into a completed step and duplicate
    // every effect after it, which is the exact corruption durability exists to
    // prevent.
    throw new InvokeError(
      "ERR_DURABLE_PARK_UNSUPPORTED",
      `Run '${this.runId}': this backend cannot park a run yet. Suspension is not part ` +
        `of durable execution v1.0 — a run that cannot park can still crash and resume, ` +
        `which is what this version provides.`,
      { run: this.runId },
    );
  }

  /** Counted per DISTINCT region rather than per suppressed step: the reported
   *  number answers "how many regions of this run re-run whole on a resume",
   *  and counting steps would make one collapsed transaction look like five. */
  noteCollapsed(info: { zone: string; attribute: "atomic" | "idempotent"; reason: string }): void {
    if (this.#collapsed.has(info.zone)) return;
    this.#collapsed.add(info.zone);
    this.observations.collapsedRegions++;
    this.observations.collapseReasons.push(`${info.zone} (${info.attribute}): ${info.reason}`);
  }

  writesInside(zone: ZoneEntry): boolean {
    // Delegated rather than answered here: whether the journal's writes land
    // inside someone's atomicity is a property of the STORE, not of the run. A
    // journal that writes somewhere else says no and gets collapse.
    return this.journal.writesInside?.(zone) ?? false;
  }

  /** Record an entry and return the value that WON. First-writer-wins is the
   *  store's rule, so the caller must use what came back rather than assume its
   *  own was kept — two processes racing on one step converge on one result
   *  instead of each continuing with its own. */
  async #write(entry: JournalEntry): Promise<unknown> {
    // The shared assertion, not a local `JSON.stringify` — a live handle has no
    // enumerable state, so stringifying one succeeds and returns `{}`. Every
    // backend needs the same check, and it is a property of the contract rather
    // than of this journal.
    assertJournalable(entry.value, { run: this.runId, path: entry.path });
    const stored = await this.journal.append(this.runId, entry);
    this.#recorded.set(entry.path, stored);
    return stored.value;
  }
}

/** Do a recorded target and a reached one name the same declaration site?
 *
 *  `module` is compared when BOTH sides carry it, and ignored when either does
 *  not. It is the documented disambiguator — two libraries may each declare a
 *  `store` — so dropping it would let a replay answer for a same-named resource
 *  in another module. Ignoring it when absent is the gradual direction: an entry
 *  written before the field was recorded must still replay, and inventing a
 *  mismatch from a missing field would strand exactly the runs this check exists
 *  to protect. */
function sameTarget(a: RecordedTarget, b: DurableTarget): boolean {
  if (a.kind !== b.kind || a.name !== b.name) return false;
  if (a.module !== undefined && b.module !== undefined) return a.module === b.module;
  return true;
}
