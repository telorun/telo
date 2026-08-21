/**
 * Structural traversal over a kind's JSON Schema and the step arrays it
 * declares. Nothing here analyzes: these answer "what does this schema node
 * point at" and "how do steps nest", the two questions every analyzer pass
 * asks before it can say anything.
 *
 * Its own file so the CEL scope rule (`cel-scope.ts`) and the analysis pass
 * (`analyzer.ts`) can both reach it without either importing the other — the
 * scope rule is consumed by the IDE, which must not pull the pass in behind it.
 */
import { MANIFEST_SCHEMA_URI, ManifestRootSchema } from "./manifest-schemas.js";

/** Resolve a local `$ref` (only `#/$defs/<name>` form) against the root schema.
 *  Non-refs and unresolved refs pass through unchanged. */
export function resolveLocalRef(
  schema: Record<string, any> | undefined,
  root: Record<string, any>,
): Record<string, any> | undefined {
  if (!schema) return undefined;
  const ref = schema.$ref;
  if (typeof ref === "string" && ref.startsWith("#/$defs/")) {
    const defName = ref.slice("#/$defs/".length);
    const resolved = root.$defs?.[defName];
    if (resolved && typeof resolved === "object") return resolved as Record<string, any>;
  }
  // A kernel-owned structural fragment (`telo://manifest#/$defs/InvokeStep`).
  // Resolved HERE rather than by each walker: this is the one chokepoint every
  // structural walk already goes through — the step-array walks, the call graph,
  // the zone projection, the eval-path collector — so a composer that points at a
  // shared shape stays legible to all of them at once. Nothing is inlined into
  // the stored schema, which keeps validator-cache identity stable and matches
  // what `resolveSchemaTypeRefs` does for a named user type.
  if (typeof ref === "string" && ref.startsWith(BUILTIN_FRAGMENT_PREFIX)) {
    const defName = ref.slice(BUILTIN_FRAGMENT_PREFIX.length);
    const resolved = (ManifestRootSchema.$defs as Record<string, unknown>)[defName];
    if (resolved && typeof resolved === "object") return resolved as Record<string, any>;
  }
  return schema;
}

const BUILTIN_FRAGMENT_PREFIX = `${MANIFEST_SCHEMA_URI}#/$defs/`;

/** Gather property schemas from a (possibly variant-bearing) object schema:
 *  top-level `properties` plus every `oneOf` / `anyOf` / `allOf` branch.
 *
 *  Each branch is resolved through {@link resolveLocalRef} first, so a branch
 *  that points at a shared shape — a `oneOf` arm that IS the kernel's dispatch
 *  site — contributes its properties like an inline one. Without that, pointing a
 *  composer at a shared shape would silently empty every role-driven lookup that
 *  reads this (the inputs slot, the retry policy, the eval paths), which is a
 *  failure with no diagnostic attached to it. */
export function gatherPropertySchemas(
  schema: Record<string, any>,
  root?: Record<string, any>,
): Array<[string, Record<string, any>]> {
  const out: Array<[string, Record<string, any>]> = [];
  const base = resolveLocalRef(schema, root ?? schema) ?? schema;
  if (base.properties && typeof base.properties === "object") {
    for (const [k, v] of Object.entries(base.properties as Record<string, any>)) {
      out.push([k, v as Record<string, any>]);
    }
  }
  for (const variantKey of ["oneOf", "anyOf", "allOf"] as const) {
    const arr = base[variantKey];
    if (!Array.isArray(arr)) continue;
    for (const raw of arr) {
      if (!raw || typeof raw !== "object") continue;
      const variant = resolveLocalRef(raw as Record<string, any>, root ?? schema) ?? raw;
      if (variant.properties) {
        for (const [k, v] of Object.entries(variant.properties as Record<string, any>)) {
          out.push([k, v as Record<string, any>]);
        }
      }
    }
  }
  return out;
}

/**
 * Generic, role-driven walk over a step array. Calls
 * `visit(step, stepPath)` for every step — top-level and nested through the
 * `x-telo-topology-role` forms (`branch`, `branch-list`, `case-map`). This is
 * the single definition of how steps nest, shared by `buildStepContextSchema`
 * (which types `steps.<name>.result`) and `validateStepInvokeReferences` (which
 * checks invoke refs), so the topology contract lives in one place — adding a
 * role or nesting form updates both consumers at once. No resource kind is
 * hardcoded; recursion is driven entirely by the schema annotations.
 */
export function walkStepArray(
  steps: unknown[],
  stepItemSchema: Record<string, any> | undefined,
  rootSchema: Record<string, any>,
  basePath: string,
  visit: (step: Record<string, any>, stepPath: string) => void,
): void {
  const dispatchRole = (
    data: unknown,
    role: string,
    itemsSchema: Record<string, any> | undefined,
    path: string,
  ): void => {
    if (role === "branch" && Array.isArray(data)) {
      walkStepArray(data, stepItemSchema, rootSchema, path, visit);
    } else if (role === "case-map" && data && typeof data === "object" && !Array.isArray(data)) {
      for (const [caseKey, arr] of Object.entries(data as Record<string, unknown>)) {
        if (Array.isArray(arr)) walkStepArray(arr, stepItemSchema, rootSchema, `${path}.${caseKey}`, visit);
      }
    } else if (role === "branch-list" && Array.isArray(data)) {
      const entrySchema = resolveLocalRef(itemsSchema, rootSchema);
      if (!entrySchema) return;
      data.forEach((entry, i) => {
        if (!entry || typeof entry !== "object") return;
        for (const [subKey, subSchema] of gatherPropertySchemas(entrySchema)) {
          const subRole = subSchema["x-telo-topology-role"];
          if (typeof subRole !== "string") continue;
          dispatchRole(
            (entry as Record<string, any>)[subKey],
            subRole,
            subSchema.items as Record<string, any> | undefined,
            `${path}[${i}].${subKey}`,
          );
        }
      });
    }
  };

  steps.forEach((step, i) => {
    if (!step || typeof step !== "object") return;
    const s = step as Record<string, any>;
    const stepPath = `${basePath}[${i}]`;
    visit(s, stepPath);
    if (!stepItemSchema) return;
    for (const [propKey, propSchema] of gatherPropertySchemas(stepItemSchema)) {
      const role = propSchema["x-telo-topology-role"];
      if (typeof role !== "string") continue;
      dispatchRole(
        s[propKey],
        role,
        propSchema.items as Record<string, any> | undefined,
        `${stepPath}.${propKey}`,
      );
    }
  });
}
