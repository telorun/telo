import {
  accessorBindingOf,
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
 * literal — with no brand and nothing to call.
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

/** `resource` with each accessor field replaced by its binding. Every container
 *  on the way to a field is copied, so the manifest the resource is re-created
 *  from keeps what its author wrote. */
export function withAccessorBindings<T extends Record<string, unknown>>(
  resource: T,
  fields: readonly AccessorField[],
): T {
  if (fields.length === 0) return resource;
  const copied = new Set<object>();
  const copy = (holder: Record<string | number, unknown>, key: string | number) => {
    const child = holder[key] as object;
    if (copied.has(child)) return child as Record<string | number, unknown>;
    const fresh = (Array.isArray(child) ? [...child] : { ...child }) as Record<string | number, unknown>;
    copied.add(fresh);
    holder[key] = fresh;
    return fresh;
  };
  const root = { ...resource } as Record<string | number, unknown>;
  for (const { keys, value } of fields) {
    let holder = root;
    for (const key of keys.slice(0, -1)) holder = copy(holder, key);
    holder[keys[keys.length - 1]!] = accessorBindingOf(value);
  }
  return root as T;
}
