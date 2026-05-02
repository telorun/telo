import type { ResourceContext } from "@telorun/sdk";

/**
 * Build the small ANSI color helpers used by every assert kind. Returns
 * pass-through (uncolored) helpers when stderr isn't a TTY so piped /
 * redirected output stays clean.
 */
export function createColors(ctx: ResourceContext) {
  const useColor = (ctx.stderr as { isTTY?: boolean }).isTTY ?? false;
  const c = (code: string, text: string) =>
    useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
  return {
    bold: (t: string) => c("1", t),
    red: (t: string) => c("31", t),
    green: (t: string) => c("32", t),
    dim: (t: string) => c("2", t),
  };
}
