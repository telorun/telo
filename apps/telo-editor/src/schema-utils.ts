import { isRecord } from "./lib/utils";

const TOPOLOGY_ROLE_ALIASES: Record<string, string> = {
  branchList: "branch-list",
  caseMap: "case-map",
  condition: "predicate",
};

export function getTopologyRole(schema: unknown): string | null {
  if (!isRecord(schema)) return null;
  const role = schema["x-telo-topology-role"];
  if (typeof role !== "string" || role.length === 0) return null;
  return TOPOLOGY_ROLE_ALIASES[role] ?? role;
}

/**
 * Resolves a single `$ref` against the root schema.
 * Returns the schema node as-is without recursing into nested `$ref`s.
 * Safe to call on circular schemas — expansion is demand-driven by the caller.
 */
export function resolveRef(schema: unknown, root: unknown): unknown {
  if (!isRecord(schema) || typeof schema.$ref !== "string") return schema;
  if (!schema.$ref.startsWith("#/")) {
    throw new Error(`Only local $ref is supported for now: ${schema.$ref}`);
  }
  const path = schema.$ref.replace(/^#\//, "").split("/");
  let node: unknown = root;
  for (const segment of path) {
    if (!isRecord(node)) return undefined;
    node = node[segment];
  }
  return node;
}

// ─── Variant metadata ─────────────────────────────────────────────────────────

export interface VariantMeta {
  title: string;
  schema: Record<string, unknown>;
  requiredFields: string[];
  invokeField: string | null;
  predicateFields: string[];
  discriminatorFields: string[];
  branchFields: string[];
  caseMaps: string[];
  branchLists: string[];
}

// ─── Public utilities ─────────────────────────────────────────────────────────

/**
 * Finds the field annotated `x-telo-topology-role: steps` in the topology
 * schema and returns its resolved items schema (the per-step schema).
 */
export function getStepSchema(
  topologySchema: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!isRecord(topologySchema.properties)) return null;
  for (const prop of Object.values(topologySchema.properties)) {
    if (getTopologyRole(prop) !== "steps" || !isRecord(prop)) continue;
    const items = resolveRef(prop.items, topologySchema);
    return isRecord(items) ? items : null;
  }
  return null;
}

/**
 * Reads the `oneOf` array from a step schema and returns a `VariantMeta` for
 * each variant, with role fields pre-classified.
 */
export function getVariants(
  stepSchema: Record<string, unknown>,
  root: unknown,
): VariantMeta[] {
  if (!Array.isArray(stepSchema.oneOf)) return [];

  return stepSchema.oneOf.flatMap((entry: unknown) => {
    const variant = resolveRef(entry, root);
    if (!isRecord(variant) || !isRecord(variant.properties)) return [];

    const meta: VariantMeta = {
      title: typeof variant.title === "string" ? variant.title : "",
      schema: variant,
      requiredFields: Array.isArray(variant.required)
        ? variant.required.filter((f): f is string => typeof f === "string")
        : [],
      invokeField: null,
      predicateFields: [],
      discriminatorFields: [],
      branchFields: [],
      caseMaps: [],
      branchLists: [],
    };

    for (const [name, prop] of Object.entries(variant.properties)) {
      if (!isRecord(prop)) continue;
      const role = getTopologyRole(prop);
      if (role === "invoke") meta.invokeField = name;
      else if (role === "predicate") meta.predicateFields.push(name);
      else if (role === "discriminator") meta.discriminatorFields.push(name);
      else if (role === "branch") meta.branchFields.push(name);
      else if (role === "case-map") meta.caseMaps.push(name);
      else if (role === "branch-list") meta.branchLists.push(name);
    }

    return [meta];
  });
}

/**
 * Returns the first variant whose required fields are all present in `stepData`.
 */
export function matchVariant(
  stepData: Record<string, unknown>,
  variants: VariantMeta[],
): VariantMeta | null {
  let bestMatch: VariantMeta | null = null;
  let bestScore = -1;

  for (const variant of variants) {
    if (!variant.requiredFields.every((f) => f in stepData)) continue;

    const identifyingFields = new Set([
      ...variant.requiredFields,
      ...variant.predicateFields,
      ...variant.discriminatorFields,
      ...variant.branchFields,
      ...variant.caseMaps,
      ...variant.branchLists,
    ]);

    if (variant.invokeField) identifyingFields.add(variant.invokeField);

    const score = [...identifyingFields].filter((field) => field in stepData).length;
    if (score === 0 && identifyingFields.size > 0) continue;
    if (score <= bestScore) continue;

    bestMatch = variant;
    bestScore = score;
  }

  return bestMatch;
}

/**
 * Builds a flat editable schema for the detail panel by merging the step
 * schema's base properties with the matched variant's properties, excluding
 * any field with a topology role handled by the sequence canvas.
 */
export function buildEditableSchema(
  stepSchema: Record<string, unknown>,
  variant: VariantMeta,
  root: unknown,
): Record<string, unknown> {
  const excluded = new Set([
    "branch",
    "case-map",
    "branch-list",
    "predicate",
    "discriminator",
    "steps",
  ]);

  const editableProps: Record<string, unknown> = {};

  function addProps(source: unknown) {
    if (!isRecord(source)) return;
    for (const [name, prop] of Object.entries(source)) {
      if (!isRecord(prop)) continue;
      const role = getTopologyRole(prop);
      if (typeof role === "string" && excluded.has(role)) continue;
      if (
        variant.branchFields.includes(name) ||
        variant.caseMaps.includes(name) ||
        variant.branchLists.includes(name)
      ) {
        continue;
      }
      editableProps[name] = resolveRef(prop, root);
    }
  }

  addProps(stepSchema.properties);
  addProps(variant.schema.properties);

  const baseRequired = Array.isArray(stepSchema.required) ? stepSchema.required : [];
  const variantRequired = variant.requiredFields;
  const required = [...new Set([...baseRequired, ...variantRequired])].filter(
    (r) => r in editableProps,
  );

  return { type: "object", properties: editableProps, required };
}

/**
 * Returns a symbol character for a variant based on its role pattern.
 * Invoke → null, predicate+branch-list → ◇ (if), predicate only → ↻ (while),
 * discriminator → ◇ (switch), branches only → ⚡ (try).
 */
export function getVariantSymbol(variant: VariantMeta): string | null {
  if (variant.invokeField !== null) return null;
  if (variant.predicateFields.length > 0) {
    return variant.branchLists.length > 0 ? "◇" : "↻";
  }
  if (variant.discriminatorFields.length > 0) return "◇";
  if (variant.branchFields.length > 0 || variant.caseMaps.length > 0) return "⚡";
  return null;
}
