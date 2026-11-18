import { coReferrerCallProblems, type DefResolver } from "@telorun/analyzer";
import { RuntimeError, type ResourceDefinition } from "@telorun/sdk";

/** What the guard reads of the kernel: the copy the analysis registry would
 *  register for a definition, and a kind as written in a module's scope. */
export interface CoReferrerGuardHost {
  registeredFormOf(definition: ResourceDefinition, canonicalExtends?: string): ResourceDefinition;
  resolveDefinitionIn(kind: string, module: string | undefined): ResourceDefinition | undefined;
}

/**
 * `callsCoReferrers` on a reference slot, refused at definition registration
 * through the analyzer's reader — `telo check` reports the same problems as
 * `X_TELO_REF_INVALID_CALLS_CO_REFERRERS`. Judged on the copy the registry
 * would register, whose kinds are canonical in the module that wrote each, as
 * every registered kind it is compared with is. A kind not registered yet
 * defers the definition, since whether it resolves and what its slot holds
 * decide the verdict.
 */
export function refuseInvalidCallsCoReferrers(
  definition: ResourceDefinition,
  canonicalExtends: string | undefined,
  host: CoReferrerGuardHost,
): void {
  const registered = host.registeredFormOf(definition, canonicalExtends);
  const module = definition.metadata?.module;
  const resolve: DefResolver = (kind, from) => host.resolveDefinitionIn(kind, from?.metadata?.module ?? module);
  const { problems, pending } = coReferrerCallProblems(
    registered,
    registered.schema as Record<string, unknown> | undefined,
    resolve,
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
