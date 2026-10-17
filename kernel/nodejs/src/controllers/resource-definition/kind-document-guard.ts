import { RuntimeError } from "@telorun/sdk";
import { capabilityProblem } from "@telorun/analyzer";

/**
 * The capability roster's refusal of a `Telo.Definition` / `Telo.Abstract`
 * document — `ERR_CAPABILITY_UNKNOWN` / `ERR_CAPABILITY_NOT_DECLARABLE`.
 *
 * Raised where every resource is created, BEFORE its document is validated
 * against the built-in entry's schema, so a mistaken `capability:` is ONE error
 * naming the role vocabulary rather than that plus the schema's own enum
 * finding. It reads what `telo check` reads (`capabilityProblem`), so the
 * static `CAPABILITY_*` and this refuse the same documents.
 */
export function refuseUndeclarableCapability(resource: Record<string, any>): void {
  if (resource?.kind !== "Telo.Definition" && resource?.kind !== "Telo.Abstract") return;
  const problem = capabilityProblem(resource.capability, resource.extends !== undefined);
  if (!problem) return;
  throw new RuntimeError(
    `ERR_${problem.code}`,
    `${resource.kind} '${resource.metadata?.name}': ${problem.message}`,
  );
}
