/**
 * The single reader of `x-telo-caught-member` — the annotation marking which
 * members of a catch list's context bindings carry the caught failure's `code`
 * and its `data`. Browser-safe: no Node built-ins.
 *
 * Two readers act on the marks, and both read them here: the CEL scope rule
 * types every `data`-marked node at a site inside catch entry *i* as the data
 * of the codes that entry matches, and the catch ladder's `when:` proof accepts
 * a comparison of any chain reaching a `code`-marked node against a string
 * literal. Nothing in catch-list analysis reads a binding by its NAME.
 *
 * A mark is legal on a node reached through `properties`, at any depth, from a
 * binding of the `x-telo-context` declared on a field annotated
 * `x-telo-outcome-list: catches`; the strict half is `validate-caught-members.ts`.
 */

export const X_TELO_CAUGHT_MEMBER = "x-telo-caught-member";

export const CAUGHT_MEMBERS = ["code", "data"] as const;
export type CaughtMember = (typeof CAUGHT_MEMBERS)[number];

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The member a schema node is marked as, or undefined for no mark or a value
 *  outside the vocabulary. */
export function caughtMemberOf(node: unknown): CaughtMember | undefined {
  if (!isPlainObject(node)) return undefined;
  const value = node[X_TELO_CAUGHT_MEMBER];
  return value === "code" || value === "data" ? value : undefined;
}

/** Whether a field schema is a catch list. */
export function isCatchListSchema(schema: unknown): boolean {
  return isPlainObject(schema) && schema["x-telo-outcome-list"] === "catches";
}

/** The context a catch list's entries are typed against, as the field declares it. */
export function catchListContext(listSchema: unknown): Record<string, any> | undefined {
  if (!isPlainObject(listSchema)) return undefined;
  const context = listSchema["x-telo-context"];
  return isPlainObject(context) ? context : undefined;
}

/** Every member a context's bindings reach through `properties`, with the
 *  chain naming it from its binding (`["error", "code"]`). The bindings
 *  themselves are not members. */
export function caughtMemberNodes(
  context: Record<string, any> | undefined,
): Array<{ chain: string[]; node: Record<string, any> }> {
  const out: Array<{ chain: string[]; node: Record<string, any> }> = [];
  const visit = (node: Record<string, any>, chain: string[], seen: Set<object>): void => {
    if (seen.has(node)) return;
    seen.add(node);
    const properties = node.properties;
    if (!isPlainObject(properties)) return;
    for (const [name, child] of Object.entries(properties)) {
      if (!isPlainObject(child)) continue;
      const next = [...chain, name];
      out.push({ chain: next, node: child });
      visit(child, next, seen);
    }
  };
  const bindings = context?.properties;
  if (!isPlainObject(bindings)) return out;
  for (const [name, binding] of Object.entries(bindings)) {
    if (isPlainObject(binding)) visit(binding, [name], new Set());
  }
  return out;
}

/** The chains reaching every `code`-marked member of a catch list's context —
 *  what a coverage-proving `when:` compares against a string literal. */
export function caughtCodeChains(context: Record<string, any> | undefined): string[][] {
  return caughtMemberNodes(context)
    .filter(({ node }) => caughtMemberOf(node) === "code")
    .map(({ chain }) => chain);
}

/**
 * `context` with every `data`-marked node reached through `properties` replaced
 * by `data` — the data schema of the codes a catch entry matches. Returned by
 * identity when nothing is marked.
 */
export function withCaughtData(
  context: Record<string, any>,
  data: Record<string, any>,
): Record<string, any> {
  const replace = (node: Record<string, any>, seen: Set<object>): Record<string, any> => {
    if (caughtMemberOf(node) === "data") return data;
    if (seen.has(node)) return node;
    const properties = node.properties;
    if (!isPlainObject(properties)) return node;
    seen.add(node);
    let next: Record<string, any> | undefined;
    for (const [name, child] of Object.entries(properties)) {
      if (!isPlainObject(child)) continue;
      const replaced = replace(child, seen);
      if (replaced === child) continue;
      next ??= { ...properties };
      next[name] = replaced;
    }
    seen.delete(node);
    return next ? { ...node, properties: next } : node;
  };
  return replace(context, new Set());
}

/** Intersection of data schemas (object type, explicit properties only): only
 *  properties present in every input survive, closed, so a member one of the
 *  matched codes lacks is an unknown field. */
export function intersectDataSchemas(schemas: Record<string, any>[]): Record<string, any> {
  if (schemas.length === 1) return schemas[0]!;
  const commonProps: Record<string, Record<string, any>> = {};
  const firstProps = (schemas[0]!.properties ?? {}) as Record<string, Record<string, any>>;
  for (const propName of Object.keys(firstProps)) {
    const sub = schemas.map((s) => (s.properties ?? {})[propName]);
    if (sub.some((p) => p === undefined)) continue;
    commonProps[propName] = intersectPropertySchemas(sub);
  }
  return { type: "object", properties: commonProps, additionalProperties: false };
}

function intersectPropertySchemas(schemas: Record<string, any>[]): Record<string, any> {
  const types = new Set(schemas.map((s) => s?.type).filter(Boolean));
  if (types.size === 1) {
    const type = [...types][0];
    if (type === "object") return intersectDataSchemas(schemas);
    return { type };
  }
  return {};
}
