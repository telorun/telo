import type { CatchEntry } from "./entry-handler.js";

/** Module-context-shaped surface used by registry dispatch — matches the
 *  shape consumed by http-api-controller's dispatchReturns/dispatchCatches. */
export interface ModuleLikeContext {
  expandWith: (v: unknown, ctx: Record<string, unknown>) => unknown;
}

interface InvokeError {
  code: string;
  message: string;
  data?: unknown;
}

/** Pick the first `catches:` entry that matches the thrown InvokeError. An
 *  entry matches when *every* declared predicate passes: `code:` (if present)
 *  must equal the error's code AND `when:` (if present) must evaluate truthy.
 *  An entry with neither field is the catch-all and matches last. */
export function matchCatch(
  catches: CatchEntry[] | undefined,
  err: InvokeError,
  celCtx: Record<string, unknown>,
  moduleContext: ModuleLikeContext,
): CatchEntry | undefined {
  if (!catches || catches.length === 0) return undefined;
  let fallback: CatchEntry | undefined;
  for (const entry of catches) {
    if (entry.when === undefined && entry.code === undefined) {
      fallback ??= entry;
      continue;
    }
    if (entry.code !== undefined && entry.code !== err.code) continue;
    if (entry.when !== undefined && moduleContext.expandWith(entry.when, celCtx) !== true) {
      continue;
    }
    return entry;
  }
  return fallback;
}
