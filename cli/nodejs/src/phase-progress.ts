import { output } from "./output.js";

/** Elapsed time as the controller progress lines show it: `605ms`, `2.1s`. */
export function formatElapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Report a phase that can take noticeable time on the human surface (stderr),
 * in TTY and piped runs alike: `⬇ <subject> <doing>…` when it starts and
 * `✓ <subject> (<done>, <time>)` when it ends, so a cold start never looks
 * hung. A failure closes the line with `✗` and is rethrown unchanged.
 */
export async function reportPhase<T>(
  subject: string,
  words: { doing: string; done: string },
  work: () => Promise<T>,
): Promise<T> {
  const out = output();
  const palette = out.stderr;
  out.errLine(`  ${palette.dim("⬇")} ${subject} ${palette.dim(`${words.doing}…`)}`);
  const started = performance.now();
  try {
    const result = await work();
    out.errLine(
      `  ${palette.ok("✓")} ${subject} ${palette.dim(`(${words.done}, ${formatElapsed(performance.now() - started)})`)}`,
    );
    return result;
  } catch (error) {
    out.errLine(
      `  ${palette.error("✗")} ${subject} ${palette.dim(`(failed after ${formatElapsed(performance.now() - started)})`)}`,
    );
    throw error;
  }
}
