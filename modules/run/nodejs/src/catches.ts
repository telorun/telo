import { isSuspension, type ResourceContext, toSequenceError } from "@telorun/sdk";

/** The whole-operation error contract the wrapper kinds share: a `catches:` list
 *  maps a throw that escaped the entire body to a fallback result. Distinct from
 *  a step's own `try`/`catch`, which the grammar owns — this one is about the
 *  operation, not a region inside it. */

export interface CatchEntry {
  when?: string;
  value?: unknown;
}

/** Whole-operation error contract shared by the binding-wrapper kinds. Runs
 *  `body`; if it throws and a `catches` entry's `when` matches (CEL over `error`
 *  + `inputs`), resolves to that entry's `value` instead of propagating. An
 *  unmatched throw (or no `catches`) propagates — fail-fast. */
export async function withCatches<T>(
  ctx: ResourceContext,
  catches: CatchEntry[] | undefined,
  inputs: Record<string, unknown>,
  operationName: string,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body();
  } catch (err) {
    // A suspension is the run leaving, not an error the operation can map. A
    // `when:` of `true` would otherwise catch it and hand back a fallback value
    // for work that has not happened.
    if (isSuspension(err)) throw err;
    if (!catches?.length) throw err;
    const error = toSequenceError(err, operationName);
    for (const entry of catches) {
      const matched = entry.when === undefined ? true : ctx.expandValue(entry.when, { error, inputs });
      if (matched) {
        return ctx.expandValue(entry.value ?? null, { error, inputs }) as T;
      }
    }
    throw err;
  }
}
