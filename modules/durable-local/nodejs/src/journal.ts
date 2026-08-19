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

export interface RunRecord {
  run: string;
  status: "running" | "completed" | "failed";
  /** Present once the run has finished, so a later caller with the same id gets
   *  the answer rather than re-running the work. */
  result?: unknown;
  error?: { code: string; message: string };
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
  admitRun(run: string): Promise<{ admitted: boolean; existing?: RunRecord }>;
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
  /** Runs that were admitted and never settled — the ones whose process died. */
  interruptedRuns(limit: number): Promise<string[]>;
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
