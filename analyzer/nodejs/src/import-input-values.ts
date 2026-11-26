import { isTaggedSentinel } from "@telorun/templating";
import { readSuppliedNeeds } from "./need-type.js";

/**
 * The values a `Telo.Import` hands its library, each with its dotted path: its
 * `variables:`, its `secrets:` and every need it supplies field by field. They
 * are read when the import initializes, in the importing module, so a file tag
 * written there (`!module-path`, `!include-*`) is a value as at a resource field
 * — anchored at the importer — and every other field of the import is not one.
 * Browser-safe.
 */
export function importInputValues(importDoc: unknown): [string, unknown][] {
  const doc = (importDoc ?? {}) as Record<string, unknown>;
  const out: [string, unknown][] = [];
  for (const block of ["variables", "secrets"] as const) {
    if (doc[block] !== undefined) out.push([block, doc[block]]);
  }
  for (const [name, supply] of Object.entries(readSuppliedNeeds(importDoc))) {
    // A whole supply is a `!ref`; a field-by-field one is a map of fields.
    if (!supply || typeof supply !== "object" || Array.isArray(supply) || isTaggedSentinel(supply)) continue;
    out.push([`needs.${name}`, supply]);
  }
  return out;
}

/** The dotted paths of {@link importInputValues}. */
export function importInputValuePaths(importDoc: unknown): string[] {
  return importInputValues(importDoc).map(([path]) => path);
}
