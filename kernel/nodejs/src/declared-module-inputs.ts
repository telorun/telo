import { declaredScalarPaths, normalizeDeclaredScalars } from "@telorun/analyzer";

/**
 * A module's `variables` / `secrets` in the numeric representation each entry
 * declares — `integer` an int64, `number` a double when that is lossless.
 *
 * Applied once, where the values are bound to the module, so CEL and host code
 * read the same value the analyzer typed. An entry declaring no type is left
 * as it arrived.
 */
export function normalizeModuleInputs(
  values: Record<string, unknown>,
  declared: Record<string, unknown>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(declared)) {
    if (entry && typeof entry === "object") properties[name] = entry;
  }
  const paths = declaredScalarPaths({ type: "object", properties });
  return normalizeDeclaredScalars(values, paths) as Record<string, unknown>;
}
