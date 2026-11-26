import {
  declaredScalarPaths,
  inputValueSchema,
  liftFragmentDefs,
  normalizeDeclaredScalars,
  slotAtPointer,
  type ExternalSchemaResolver,
} from "@telorun/analyzer";

/**
 * A module's `variables` / `secrets` in the numeric representation each entry
 * declares — `integer` an int64, `number` a double when that is lossless.
 *
 * Applied once, where the values are bound to the module, so CEL and host code
 * read the same value the analyzer typed. Each entry is its own schema root, so
 * its `#/$defs/…` names the entry, and a canonical `telo:<module>/<Type>`
 * reference is read through `resolveRef`. An entry declaring no type is left
 * as it arrived.
 */
export function normalizeModuleInputs(
  values: Record<string, unknown>,
  declared: Record<string, unknown>,
  resolveRef: ExternalSchemaResolver,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(declared)) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      properties[name] = slotAtPointer(
        inputValueSchema(entry as Record<string, unknown>),
        `#/properties/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`,
      );
    }
  }
  const paths = declaredScalarPaths(liftFragmentDefs({ type: "object", properties }), resolveRef);
  return normalizeDeclaredScalars(values, paths) as Record<string, unknown>;
}
