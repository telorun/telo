import type { ResourceInstance } from "@telorun/sdk";

/** Single catches: entry on a tool/resource/prompt entry. `when` is typed
 *  loosely because the manifest schema says `type: boolean` but the value at
 *  this point is a `CompiledValue` (when the user wrote `${{ ... }}`) or a
 *  bare boolean literal (when the user wrote `when: true`/`when: false`).
 *  Truthiness checks would mis-classify the literal `false` case as "no
 *  when field" — see matchCatch below. */
export interface CatchEntry {
  code?: string;
  when?: unknown;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** Resolved entry handed to the registry — handler ref is captured before
 *  Phase 5 injection (kind/name) and the live instance is read after. */
export interface ResolvedToolEntry {
  name: string;
  description?: string;
  argumentsSchema: Record<string, unknown>;
  inputs: Record<string, unknown>;
  result: Record<string, unknown>;
  catches?: CatchEntry[];
  handlerKind: string;
  handlerName: string;
  handler: ResourceInstance;
}

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
