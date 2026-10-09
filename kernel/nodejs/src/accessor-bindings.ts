import {
  accessorFields,
  accessorProblems,
  type AccessorField,
  type AccessorSite,
} from "@telorun/analyzer";
import { RuntimeError, type ResourceManifest } from "@telorun/sdk";

/**
 * AN ACCESSOR FIELD IS DELIVERED AS A BINDING, NEVER EVALUATED.
 *
 * The runtime half of `x-telo-eval: accessor`, from the reader the static
 * verdict uses (`accessor-binding.ts` in the analyzer). A value the field cannot
 * hold is refused at creation as `ERR_ACCESSOR_NOT_PLAIN_CHAIN`, before any
 * field of the resource is expanded; what the controller then receives at the
 * field is a plain map — `{ root, path }` for a chain, `{ value }` for a
 * literal — with no brand and nothing to call, written by the analyzer's
 * `withAccessorBindings`.
 */
export function refuseNonChainAccessors(
  subject: string,
  resource: ResourceManifest,
  sites: readonly AccessorSite[],
): AccessorField[] {
  if (sites.length === 0) return [];
  const fields = accessorFields(resource as Record<string, unknown>, {
    compile: [],
    runtime: [],
    regions: [],
    accessor: sites,
  });
  for (const field of fields) {
    for (const problem of accessorProblems(field)) {
      throw new RuntimeError("ERR_ACCESSOR_NOT_PLAIN_CHAIN", `${subject}: ${problem.message}`);
    }
  }
  return fields;
}

/** The delivery itself: the analyzer's writer, with no tag resolved earlier. */
export { withAccessorBindings } from "@telorun/analyzer";
