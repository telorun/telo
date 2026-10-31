import type { EvaluationContext as IEvaluationContext } from "@telorun/sdk";
import { rootContextOf } from "./shared-libraries.js";

/**
 * The fields the environment holds for each library need reaching the root
 * unsupplied, read once at load by need path — what an import binds such a need
 * to, building the fulfilment in the library's own context.
 *
 * Hung off the ROOT context, as the shared-library registry is, so two
 * in-process kernels never read each other's environment.
 */
const registries = new WeakMap<object, ReadonlyMap<string, Record<string, unknown> | null>>();

export function setEnvironmentNeeds(
  root: IEvaluationContext,
  values: ReadonlyMap<string, Record<string, unknown> | null>,
): void {
  registries.set(root as unknown as object, values);
}

/** What the environment holds for the need at `path`: its fields, `null` for an
 *  optional need with nothing set or one the running configuration does not
 *  require, `undefined` when the load read nothing for it. */
export function environmentNeed(
  ctx: IEvaluationContext,
  path: readonly string[],
): Record<string, unknown> | null | undefined {
  return registries.get(rootContextOf(ctx) as unknown as object)?.get(path.join("."));
}
