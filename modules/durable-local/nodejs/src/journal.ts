/**
 * What a `DurableLocal.Journal` implementation provides.
 *
 * Duck-typed rather than nominal, the way `Sql.Connection`'s `query()` and
 * `Ai.Model`'s `invoke`/`stream` already are: the abstract declares the CONTRACT
 * in prose and the backend provides the methods. A shared TypeScript interface
 * reached through the module-library seam would be the nominal alternative, and
 * it buys nothing here — there is one consumer (this module) and the surface is
 * six methods.
 *
 * The operations are chosen by what is HARD, not by what a store happens to
 * offer. Claiming due runs without two resumers taking the same one, and waking
 * promptly, are the two that decide whether a journal works; appending and
 * reading back are the easy half. That is also why this is its own contract
 * rather than a reuse of `KvStore.Store`, which is deliberately point-access
 * only — "which runs are due" is a range query, and widening that contract to
 * answer it would weaken something four modules already depend on.
 */

/** One recorded fact about a run. Written on COMPLETION, never on dispatch —
 *  the rule the whole format rests on, and what makes an interrupted step
 *  re-executable rather than skipped. */
export interface JournalEntry {
  /** The step path this records. Deterministic under concurrency, which is why
   *  journaling lives in the step engine at all. */
  path: string;
  kind: "step" | "decision";
  /** For a decision, which kind of decision it was. */
  decision?: string;
  /** Declaration-site identity of a step's target, so a replay that reaches a
   *  different one can say so instead of answering for it. `module` is the
   *  disambiguator two libraries declaring a same-named resource need; it is
   *  optional because an entry written before it was recorded must still
   *  replay. */
  target?: RecordedTarget;
  /** The recorded value — a step's result, or the decision itself. */
  value: unknown;
}

/** A step target as the journal stores it — the declaration site, never the
 *  live instance, whose identity is process-local by construction. */
export interface RecordedTarget {
  kind: string;
  name: string;
  module?: string;
}

/** Where a parked run is waiting, and on what.
 *
 *  Recorded rather than only signalled, because a park has to be RECOVERABLE: a
 *  resume re-enters at `path`, and a delivery writes its payload there — which
 *  is what makes the delivery the step's own result and stops a woken run
 *  needing a second key to reconcile against. */
export interface ParkRecord {
  path: string;
  /** The parking resource's name, so an operator asking why a run is parked
   *  reads what it is waiting for rather than only where. */
  resource: string;
  /** Epoch milliseconds at which the run becomes due with no delivery. */
  at?: number;
  /** The address a delivery must carry to wake this run. */
  token?: string;
}

export interface RunRecord {
  run: string;
  /** `scheduled` is admitted but not yet started — there is no caller, so its
   *  inputs are stored. `parked` is suspended and recoverable. `cancelled` is
   *  terminal and deliberately distinct from `failed`: the work was called off,
   *  which is not a verdict on it. */
  status: "scheduled" | "running" | "parked" | "completed" | "failed" | "cancelled";
  /** When a scheduled or parked run becomes due. */
  dueAt?: number;
  parked?: ParkRecord;
  /** The inputs a scheduled run starts with. A scheduled start has no caller at
   *  the moment it runs, so what it was scheduled WITH has to be stored. */
  inputs?: unknown;
  /** Present once the run has finished, so a later caller with the same id gets
   *  the answer rather than re-running the work. */
  result?: unknown;
  error?: { code: string; message: string };
  /**
   * How many regions of this run were collapsed to one entry, and the author's
   * sentence for each.
   *
   * On the RUN, not on the workflow resource, and that is what the slice-3
   * deviation was reaching for without being able to say it: a workflow serves
   * many runs at once, so observed state on the resource would have one slot for
   * all of them and report whichever finished last. Whether a run got
   * exactly-once or at-least-once is a fact about that run.
   *
   * Reported because it MUST be (spec §8.3): the answer turns on whether the
   * journal's writes land inside the transaction's atomicity, which is a runtime
   * coincidence the manifest cannot show and which degrades silently if someone
   * repoints the journal.
   */
  collapsedRegions?: number;
  collapseReasons?: string[];
}

export interface DurableJournal {
  /**
   * Record the run BEFORE anything executes, returning whether this caller
   * admitted it.
   *
   * Admit-before-execute is the one rule every backend keeps: a start that
   * executes before it is durably recorded is unrecoverable if the process dies
   * in between, while recording first is what lets recovery find a run with no
   * progress and replay it.
   */
  admitRun(
    run: string,
    init?: { status?: "running" | "scheduled"; dueAt?: number; inputs?: unknown },
  ): Promise<{ admitted: boolean; existing?: RunRecord }>;
  /** This run's current record, or undefined if it was never admitted. */
  readRun(run: string): Promise<RunRecord | undefined>;
  /** Every entry for a run, in write order. */
  readEntries(run: string): Promise<JournalEntry[]>;
  /**
   * Append one entry, FIRST WRITER WINS: if an entry already exists at that
   * path, the stored one is returned and the caller's is discarded. That is what
   * makes two processes racing on the same step converge rather than both
   * recording it — and it is why the caller must use the returned entry rather
   * than assume its own was kept.
   */
  append(run: string, entry: JournalEntry): Promise<JournalEntry>;
  /** Settle a run. */
  completeRun(run: string, outcome: Omit<RunRecord, "run">): Promise<void>;
  /**
   * Record that a run suspended, and where.
   *
   * Separate from `completeRun` because a park is not a settlement: the run is
   * still live, it simply is not executing. Collapsing the two would make a
   * parked run indistinguishable from a finished one to everything that reads
   * status — including the resumer, which must pick it up and must not pick up
   * the other.
   */
  parkRun(run: string, park: ParkRecord): Promise<void>;
  /**
   * Clear a park and mark the run runnable again.
   *
   * The wake half of `parkRun`, used by a delivery, by an operator's force
   * resume, and by a deadline elapsing.
   */
  unparkRun(run: string): Promise<void>;
  /**
   * Find the run parked on this token.
   *
   * A token is minted inside the run and recorded with its park, so this is a
   * reverse lookup rather than a second index the caller has to maintain.
   * Returns undefined when no run is parked on it — an address that is stale,
   * already delivered, or simply wrong, all of which are the same answer to a
   * caller.
   */
  runParkedOn(token: string): Promise<{ run: string; park: ParkRecord } | undefined>;
  /**
   * Runs that are ready to be picked up: one whose process died mid-execution,
   * one whose park deadline has passed, one that was woken by a delivery, and
   * one scheduled for a time that has arrived.
   *
   * ONE query rather than four, because they are one question — *what should a
   * poller work on now* — and four would be four chances for a run to be in a
   * state no query returns.
   *
   * **A parked run whose park position ALREADY HOLDS AN ENTRY is due**, whatever
   * its deadline says, and this is a correctness requirement rather than an
   * optimisation. A delivery writes the payload and then clears the park, and a
   * store that cannot do both atomically leaves a window: a crash in between
   * strands a run that holds its answer and has no deadline to wake it, forever.
   * Treating the entry as the wake signal closes that window with no atomicity
   * needed, because the entry IS the fact that matters — the payload is already
   * recorded, so the run has everything it needs to continue. A store that can
   * write both in one transaction satisfies this trivially.
   */
  dueRuns(now: number, limit: number): Promise<string[]>;
  /**
   * Take exclusive ownership of a run before continuing it, so several pollers
   * against one store do not both resume it. False means someone else has it.
   */
  claimRun(run: string, holder: string, ttlMs: number): Promise<boolean>;
  /**
   * Do this journal's own writes land inside the given zone's atomicity?
   *
   * The attestation the collapse rule reads. A journal that writes somewhere
   * else answers false and gets today's collapse; one that writes into the very
   * transaction whose effects it records answers true, and its region is
   * journaled per step — which is what closes the at-least-once window.
   */
  writesInside?(zone: unknown): boolean;
}

/** Structural test, so a mis-wired `journal:` fails with a message naming the
 *  slot rather than as an undefined-is-not-a-function three frames in. */
export function isDurableJournal(value: unknown): value is DurableJournal {
  const j = value as Partial<DurableJournal> | null;
  return (
    !!j &&
    typeof j.admitRun === "function" &&
    typeof j.readEntries === "function" &&
    typeof j.append === "function" &&
    typeof j.completeRun === "function"
  );
}
