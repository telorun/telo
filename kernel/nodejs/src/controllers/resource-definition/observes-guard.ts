import { observesProblems, type DefResolver } from "@telorun/analyzer";
import { RuntimeError, type ResourceDefinition } from "@telorun/sdk";

/**
 * `observes` on a reference slot, refused at definition registration through
 * the analyzer's reader — `telo check` reports the same problems as
 * `X_TELO_REF_INVALID_OBSERVES`, and this is what refuses them in a dependency's
 * kind, which the entry-scoped check never reports. A slot kind not registered
 * yet defers the definition, since whether it is a need type decides the verdict.
 */
export function refuseInvalidObserves(
  definition: ResourceDefinition,
  ownSchema: Record<string, unknown> | undefined,
  mergedSchema: Record<string, unknown> | undefined,
  resolve: DefResolver,
): void {
  const { problems, pending } = observesProblems(definition, ownSchema, mergedSchema, resolve);
  const [problem] = problems;
  if (problem) {
    throw new RuntimeError(`ERR_${problem.code}`, `${problem.message} (at '${problem.path}')`);
  }
  if (pending.length > 0) {
    throw new RuntimeError(
      "ERR_LOCAL_REF_PENDING",
      `${definition.kind} '${definition.metadata?.name as string}': observing slot kind ` +
        `'${pending[0]}' is not loaded yet.`,
    );
  }
}
