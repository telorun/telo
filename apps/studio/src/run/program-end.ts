import type { RunRecord } from "./context";

/** How the run's program ended while the runner keeps the run alive (watching
 *  for changes). */
export interface ProgramEnd {
  outcome: "finished" | "failed";
  endedAt: number;
  /** What the chip's tooltip says. */
  detail: string;
}

const WATCHING = "watching for changes; edits run it again";

/**
 * The end of the run's program, read from the app's latest `run` outcome: a
 * live run whose current generation has completed or failed is a program that
 * ended under watch. Null while the program runs, and for a run that is over.
 */
export function programEnd(
  run: Pick<RunRecord, "status" | "app" | "runs" | "outcomeAt">,
): ProgramEnd | null {
  if (run.status.kind !== "running") return null;
  const outcome = run.runs[run.app];
  const endedAt = run.outcomeAt[run.app];
  if (!outcome || endedAt === undefined) return null;
  if (outcome.phase === "completed") {
    return {
      outcome: outcome.code === 0 ? "finished" : "failed",
      endedAt,
      detail: `Exited with code ${outcome.code} — ${WATCHING}`,
    };
  }
  if (outcome.phase === "failed") {
    return { outcome: "failed", endedAt, detail: `${outcome.reason} — ${WATCHING}` };
  }
  return null;
}
