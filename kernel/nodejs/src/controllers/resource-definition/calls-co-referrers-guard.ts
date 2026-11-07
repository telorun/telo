import { coReferrerCallProblems } from "@telorun/analyzer";
import { RuntimeError, type ResourceDefinition } from "@telorun/sdk";
import { CanonicalSlotKinds, type ScopedKindResolver } from "../../canonical-slot-kinds.js";

/**
 * `callsCoReferrers` on a reference slot, refused at definition registration
 * through the analyzer's reader — `telo check` reports the same problems as
 * `X_TELO_REF_INVALID_CALLS_CO_REFERRERS`. Every kind is compared canonical,
 * each read in the module that wrote it. A kind not registered yet defers the
 * definition, since whether it resolves and what its slot holds decide the
 * verdict.
 */
export function refuseInvalidCallsCoReferrers(
  definition: ResourceDefinition,
  ownSchema: Record<string, unknown> | undefined,
  resolveIn: ScopedKindResolver,
): void {
  const canonical = new CanonicalSlotKinds(resolveIn);
  const module = definition.metadata?.module;
  const { problems, pending } = coReferrerCallProblems(
    canonical.definition(definition),
    canonical.schema(ownSchema, module),
    canonical.resolver(module),
    false,
  );
  const [problem] = problems;
  if (problem) {
    throw new RuntimeError(
      `ERR_${problem.code}`,
      `${definition.kind} ${problem.message} (at '${problem.path}')`,
    );
  }
  if (pending.length > 0) {
    throw new RuntimeError(
      "ERR_LOCAL_REF_PENDING",
      `${definition.kind} '${definition.metadata?.name as string}': 'callsCoReferrers' kind ` +
        `'${pending[0]}' is not loaded yet.`,
    );
  }
}
