/**
 * Where author-written JSON Schema lives in a manifest — one definition, read by
 * every surface that has to bound itself to schema.
 *
 * The keys are the KERNEL's own schema-valued manifest keys, which no resource
 * kind owns. That is what makes the rule generic: a surface using it learns no
 * resource kind, and a module that invents a schema-bearing field of its own
 * reaches it through one of these or not at all — against the topology-driven
 * constraint, an enumeration of the standard library's kinds would be both
 * incomplete and knowledge the analyzer must not hold.
 *
 * A schema fragment is NOT confined to kind documents. An inline `inputType:` /
 * `outputType:` sits on any kind that declares one, an API route carries
 * `request.schema.body`, a `Telo.JsonSchema` carries `schema`. So a check that
 * walks a manifest's ROOT keys covers a fraction of the sites an author writes —
 * which is a silent hole in exactly the checks that exist to stop a silent
 * degrade. Containment is by ANCESTRY instead: a node is in a schema region when
 * some key on the path to it is one of these.
 *
 * Browser-safe: no Node built-ins.
 */

/** The kernel's schema-valued manifest keys. */
export const SCHEMA_REGION_KEYS: readonly string[] = [
  "schema",
  "status",
  "inputType",
  "outputType",
  "itemType",
];

/**
 * True when `path` reaches into a schema region — some ANCESTOR segment is a
 * schema-valued key.
 *
 * Ancestors only, so a rule keyed on a region key itself still means "inside a
 * schema" rather than "is one". `path` is the walk's own segment list; numeric
 * segments (array indices) never equal a key name, so they need no special case.
 */
export function isInSchemaRegion(path: readonly (string | number)[]): boolean {
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i];
    if (typeof segment === "string" && SCHEMA_REGION_KEYS.includes(segment)) return true;
  }
  return false;
}
