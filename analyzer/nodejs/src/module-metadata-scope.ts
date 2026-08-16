/**
 * What `module.<field>` may read: the metadata an AUTHOR wrote, never the
 * loader's own stamps.
 *
 * A manifest reaching its own `metadata` is a small binding with one sharp edge.
 * By the time analysis or the runtime sees a module doc, its `metadata` also
 * carries fields nothing authored — `source` and `sourceLine` (the loader's
 * provenance), `module`, `moduleGlobals`, `exportedKinds`, `reExportedKinds`,
 * `forwardedExport` (derived indices the analyzer stamps). Exposing those would
 * publish loader internals as a manifest surface, where they would be read,
 * depended on, and then unchangeable.
 *
 * A DENYLIST rather than an allowlist, because the metadata vocabulary is
 * deliberately open: a module may declare a field the standard library has never
 * heard of, and an allowlist would silently hide it. The stamps, by contrast,
 * are a closed set this repo controls — so the thing that can be enumerated is
 * the thing enumerated.
 */

/** Fields written by the loader or the analyzer, not by the module's author. */
export const DERIVED_METADATA_FIELDS: ReadonlySet<string> = new Set([
  "source",
  "sourceLine",
  "module",
  "moduleGlobals",
  "exportedKinds",
  "reExportedKinds",
  "forwardedExport",
]);

/** The author-written half of a module doc's `metadata`. */
export function authoredModuleMetadata(
  metadata: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const authored: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (DERIVED_METADATA_FIELDS.has(key)) continue;
    authored[key] = value;
  }
  return authored;
}

/**
 * The `module` namespace as a JSON Schema, or `undefined` when there is nothing
 * to type it from.
 *
 * **One derivation, two consumers.** `cel-environment.ts` needs CEL type strings
 * and `kernel-globals.ts` needs JSON Schema, and they used to reach the same
 * conclusion through two hand-written ternary chains that had to agree forever
 * about which values are open and which are closed. The schema is the richer of
 * the two shapes, so it is what is derived; the CEL side converts with
 * `jsonSchemaToCelType`, which every other namespace already goes through.
 *
 * Typed from the VALUES because a module doc's metadata is literals, not a
 * schema map — the module a resource belongs to is fixed, so there is nothing to
 * resolve.
 *
 * `undefined` means **open**, and the distinction matters in the rejecting
 * direction: a set with no module doc must leave `module.*` unconstrained rather
 * than close it over whatever metadata happened to be at hand, or a valid
 * `module.version` becomes a hard error nobody can act on.
 */
export function moduleMetadataSchema(
  metadata: Record<string, unknown> | undefined | null,
): Record<string, any> | undefined {
  const authored = authoredModuleMetadata(metadata);
  const keys = Object.keys(authored);
  if (keys.length === 0) return undefined;

  const properties: Record<string, any> = {};
  for (const key of keys) {
    const value = authored[key];
    properties[key] = Array.isArray(value)
      ? { type: "array" }
      : value !== null && typeof value === "object"
        ? { type: "object", additionalProperties: true }
        : {
            type:
              typeof value === "number"
                ? "number"
                : typeof value === "boolean"
                  ? "boolean"
                  : "string",
          };
  }
  return { type: "object", properties, additionalProperties: false };
}
