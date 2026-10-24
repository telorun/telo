import type { RunRecord } from "./context";

/** How much of a run's output accompanies a question about its failure. */
export const FAILURE_OUTPUT_LINES = 40;
export const FAILURE_OUTPUT_CHARS = 4000;

/**
 * What the dock shows as this run's failure, a line per fact: the run's own
 * failed start, non-zero exit or killing signal, and its application's failed
 * or non-zero latest generation. Null for a run that shows none.
 */
export function describeRunFailure(run: Pick<RunRecord, "status" | "runs">): string[] | null {
  const lines: string[] = [];
  if (run.status.kind === "failed") lines.push(`Run failed: ${run.status.message}`);
  if (run.status.kind === "exited" && run.status.code !== 0) lines.push(`Exited with code ${run.status.code}`);
  if (run.status.kind === "signalled") lines.push(`Ended by signal ${run.status.signal}`);
  for (const outcome of Object.values(run.runs)) {
    if (outcome.phase === "failed") lines.push(`${outcome.app} (run #${outcome.generation}) failed: ${outcome.reason}`);
    if (outcome.phase === "completed" && outcome.code !== 0) {
      lines.push(`${outcome.app} (run #${outcome.generation}) exited with code ${outcome.code}`);
    }
  }
  return lines.length === 0 ? null : lines;
}

const ESCAPE_SEQUENCES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

/** The end of a run's output as plain text: terminal escapes removed, bounded
 *  to the last lines and characters. Null when there is nothing to show. */
export function outputTail(output: string): string | null {
  const lines = output
    .replace(ESCAPE_SEQUENCES, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "")
    .split("\n")
    .slice(-FAILURE_OUTPUT_LINES);
  let tail = lines.join("\n");
  if (tail.length > FAILURE_OUTPUT_CHARS) tail = tail.slice(-FAILURE_OUTPUT_CHARS);
  return tail.trim() === "" ? null : tail;
}
