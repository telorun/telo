/**
 * This backend's implementation of the replay seam — `kernel/specs/durable-execution.md`.
 *
 * All three operations land in a `DurableLocal.Journal` with in-process
 * dispatch. Under a hosted engine the same three would be protocol frames on an
 * open invocation, and the step engine cannot tell the difference; that is the
 * entire extent of what the backends share.
 */
import {
  DurableSuspension,
  InvokeError,
  type DurableBaseline,
  type DurableDecisionKind,
  type DurableRunHandle,
  type DurableTarget,
  type Logger,
  type ZoneEntry,
  type ZoneJournalingMode,
} from "@telorun/sdk";
import { writeRecordedValue } from "@telorun/sdk";
import { recordEntry, recordedValue } from "./journal-codec.js";
import type { DurableJournal, JournalEntry, RecordedTarget } from "./journal.js";

/** One recorded fact, with its value already read back out of the record — so a
 *  replay and the execution that WROTE the entry hand out the same value. */
interface ReplayedEntry {
  target?: RecordedTarget;
  value?: unknown;
}

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

/** How a run compacts: after how many body entries, and which paths are the
 *  body's — the entries a baseline replaces. Anything outside it (the workflow's
 *  own `inputs` decision) is never replaced. */
export interface CompactionOptions {
  compactAfter: number;
  body: string;
}

export class LocalRunHandle implements DurableRunHandle {
  /** Entries already on disk when this execution started, by path. A resume
   *  reads them ONCE rather than per step: the journal is append-only within a
   *  run, and re-reading per lookup would turn an N-step replay into N reads.
   *  Decoded once here too, for the same reason. */
  readonly #recorded = new Map<string, ReplayedEntry>();
  /** The baseline this execution resumes from, decoded. */
  #restored: DurableBaseline | undefined;
  /** Where the run's current baseline is stored, so the next one replaces it. */
  #baselinePath: string | undefined;
  /** Body entries the journal holds for this run — what a baseline replaces. */
  readonly #held = new Set<string>();
  /** Body entries read at open that replay has not yet passed. A baseline is due
   *  only once this is empty: removing one would drop a record replay still needs. */
  readonly #unanswered = new Set<string>();
  #compaction: CompactionOptions | undefined;
  readonly observations: RunObservations = {
    replayedSteps: 0,
    collapsedRegions: 0,
    collapseReasons: [],
  };
  /** Regions already reported, so one transaction is one record however many
   *  steps run inside it. */
  readonly #resolved = new Set<string>();

  private constructor(
    readonly runId: string,
    private readonly journal: DurableJournal,
    private readonly log: Logger,
  ) {}

  /** @param compaction Omitted, the run never takes a baseline. */
  static async open(
    runId: string,
    journal: DurableJournal,
    log: Logger,
    compaction?: CompactionOptions,
  ): Promise<LocalRunHandle> {
    const handle = new LocalRunHandle(runId, journal, log);
    handle.#compaction = compaction;
    for (const entry of await journal.readEntries(runId)) {
      if (entry.kind === "baseline") {
        if (handle.#baselinePath !== undefined) {
          throw new InvokeError(
            "ERR_DURABLE_JOURNAL_CORRUPT",
            `Run '${runId}': the journal holds two baselines ('${handle.#baselinePath}' and ` +
              `'${entry.path}'), and a run has at most one. Resuming from either would ` +
              `ignore what the other records.`,
            { run: runId },
          );
        }
        handle.#baselinePath = entry.path;
        handle.#restored = recordedValue(runId, entry).value as DurableBaseline;
        continue;
      }
      // First write wins here too, mirroring the store's own rule — so a journal
      // that somehow holds two entries at one path replays the same one the
      // store would return.
      if (handle.#recorded.has(entry.path)) continue;
      // Decoded HERE, which is where a journal this runtime cannot read is
      // refused: opening the handle is what a resume does first, so an entry in
      // an unknown codec version stops the run before any step is answered for.
      handle.#recorded.set(entry.path, {
        ...(entry.target === undefined ? {} : { target: entry.target }),
        ...recordedValue(runId, entry),
      });
      if (handle.#inBody(entry.path)) {
        handle.#held.add(entry.path);
        handle.#unanswered.add(entry.path);
      }
    }
    return handle;
  }

  /** The baseline a resume starts the body at, when the run has one. */
  get restored(): DurableBaseline | undefined {
    return this.#restored;
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
      // Answered from the record, the step's own body never runs again, so what
      // that body recorded is passed with it.
      this.#passed(path, true);
      return recorded.value;
    }

    // Nothing recorded: perform the effect HERE, which is this backend's answer
    // to the seam's "where" — a relocating backend would ignore `execute` and
    // ship `target` instead. Recorded on COMPLETION, so a step interrupted
    // mid-flight has no entry and re-executes rather than being skipped.
    const result = await execute();
    return this.#write(
      {
        path,
        kind: "step",
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
      },
      result,
    );
  }

  async decide<T>(path: string, kind: DurableDecisionKind, compute: () => T): Promise<T> {
    const recorded = this.#recorded.get(path);
    if (recorded) {
      this.#passed(path, false);
      return recorded.value as T;
    }
    return (await this.#write({ path, kind: "decision", decision: kind }, compute())) as T;
  }

  /**
   * Take a baseline when one is due: the body holds `compactAfter` entries or
   * more, and replay has passed every entry it was opened with. The baseline and
   * the removal of every body entry it replaces are one journal write.
   */
  baseline(capture: () => DurableBaseline, completed: string): Promise<void> | undefined {
    // The step finished, so whatever its body recorded beneath it is behind
    // replay — including entries a resumed execution took another branch past.
    this.#passed(completed, true);
    const compaction = this.#compaction;
    const replace = this.journal.replaceWithBaseline?.bind(this.journal);
    if (
      !compaction ||
      !replace ||
      this.#held.size < compaction.compactAfter ||
      this.#unanswered.size > 0
    ) {
      return undefined;
    }
    const { position, steps } = capture();
    const path = position[position.length - 1]!.step;
    // The step's own entry is among those replaced, so the baseline takes its path.
    const frame = writeRecordedValue({ position, steps }, { run: this.runId, path });
    const replaced = [...this.#held, ...(this.#baselinePath === undefined ? [] : [this.#baselinePath])];
    return replace(this.runId, recordEntry({ path, kind: "baseline" }, frame), replaced).then(() => {
        for (const held of this.#held) this.#recorded.delete(held);
        this.#held.clear();
        this.#baselinePath = path;
      });
  }

  #inBody(path: string): boolean {
    const body = this.#compaction?.body;
    return body !== undefined && isWithin(path, body);
  }

  /** Replay has passed `path` — and, for a step answered from the record, every
   *  entry its own body recorded beneath it. */
  #passed(path: string, nested: boolean): void {
    if (this.#unanswered.size === 0) return;
    this.#unanswered.delete(path);
    if (!nested) return;
    for (const entry of this.#unanswered) {
      if (isWithin(entry, path)) this.#unanswered.delete(entry);
    }
  }

  /**
   * Record the park, then unwind.
   *
   * Recorded FIRST, and that ordering is the whole of whether a park is
   * recoverable: the signal only unwinds this process's stack, so a park that
   * threw before writing would leave a run marked `running` with nothing
   * executing it — recovered eventually by the resumer, but as an interrupted
   * run replayed from its last step rather than as a run waiting at a known
   * point, and with its wake token lost.
   *
   * The throw here is what the seam's own guard makes redundant — `parkRun`
   * throws its latched signal if this returns — and it is kept because a
   * backend's park should be correct on its own terms, not only inside the
   * helper that calls it.
   */
  async park(
    where: { path: string; resource: string },
    until: { at?: number; token?: string },
  ): Promise<never> {
    await this.journal.parkRun(this.runId, {
      path: where.path,
      resource: where.resource,
      ...(until.at === undefined ? {} : { at: until.at }),
      ...(until.token === undefined ? {} : { token: until.token }),
    });
    throw new DurableSuspension(this.runId, where.path, where.resource, until);
  }

  /**
   * Report how one region resolved — the conformance requirement in spec §8.3.
   *
   * Recorded per DISTINCT region rather than per suppressed step: the reported
   * number answers "how many regions of this run re-run whole on a resume", and
   * counting steps would make one collapsed transaction look like five. The log
   * record follows the same rule, so a hot loop inside a collapsed transaction
   * does not emit one line per turn.
   *
   * `perStep` is reported at the same level as `collapsed`, deliberately: under
   * a file journal collapse is the correct and expected resolution, so warning
   * on it would be noise on every development run. What an operator wants is one
   * field to filter on.
   */
  noteZoneMode(info: ZoneJournalingMode): void {
    if (this.#resolved.has(info.zone)) return;
    this.#resolved.add(info.zone);
    this.log.info("durable.zone.mode", {
      "durable.run": this.runId,
      "durable.zone": info.zone,
      "durable.zone.attribute": info.attribute,
      "durable.zone.mode": info.mode,
      ...(info.attestation === undefined
        ? {}
        : { "durable.zone.attestation": info.attestation }),
    });
    if (info.mode !== "collapsed") return;
    this.observations.collapsedRegions++;
    this.observations.collapseReasons.push(`${info.zone} (${info.attribute}): ${info.reason}`);
  }

  writesInside(zone: ZoneEntry): boolean {
    // Delegated rather than answered here: whether the journal's writes land
    // inside someone's atomicity is a property of the STORE, not of the run. A
    // journal that writes somewhere else says no and gets collapse.
    return this.journal.writesInside?.(zone) ?? false;
  }

  /**
   * Record an entry and return the value that WON.
   *
   * First-writer-wins is the store's rule, so the caller must use what came back
   * rather than assume its own was kept — two processes racing on one step
   * converge on one result instead of each continuing with its own.
   *
   * The value handed back is the DECODE of what was stored, never the value that
   * went in, and that is what keeps a first pass and a replay agreeing about
   * what a step produced: both read the record. Returning the live value here
   * would let a `Map` become a plain object one execution later, at a step whose
   * result nothing else had changed.
   */
  async #write(entry: Omit<JournalEntry, "v" | "value">, value: unknown): Promise<unknown> {
    // The shared assertion, not a local `JSON.stringify` — a live handle has no
    // enumerable state, so stringifying one succeeds and returns `{}`, and every
    // value with a `toJSON` stringifies happily while reading back as something
    // else. The frame it produced to decide is the one recorded.
    const frame = writeRecordedValue(value, { run: this.runId, path: entry.path });
    // Read off what was STORED rather than off what was offered, target
    // included: the entry that won may be another execution's.
    const stored = await this.journal.append(this.runId, recordEntry(entry, frame));
    const recorded = {
      ...(stored.target === undefined ? {} : { target: stored.target }),
      ...recordedValue(this.runId, stored),
    };
    this.#recorded.set(entry.path, recorded);
    if (this.#inBody(stored.path)) this.#held.add(stored.path);
    return recorded.value;
  }
}

/** Is `path` beneath `ancestor`? A nested body hangs its paths under the step
 *  that dispatched it, either as `/`-joined segments or as a qualifier on the
 *  step's own segment (a composer's turn, `steps/each[2]/…`) — spec §5.1. */
function isWithin(path: string, ancestor: string): boolean {
  return (
    path.length > ancestor.length &&
    path.startsWith(ancestor) &&
    (path[ancestor.length] === "/" || path[ancestor.length] === "[")
  );
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
