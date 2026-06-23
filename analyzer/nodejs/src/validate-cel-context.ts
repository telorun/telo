export { extractAccessChains, validateChainAgainstSchema } from "@telorun/templating";
import { mergeTypeSchemas } from "@telorun/sdk";

export interface ContextResolveOpts {
  /** When provided, used to resolve `x-telo-context-from-root` annotations against the
   *  root manifest. When omitted, defaults to `manifestItem`. */
  manifestRoot?: Record<string, any>;
  /** When provided alongside `aliases`, used to resolve `x-telo-context-from-ref-kind`
   *  annotations: read a kind name from a path on `manifestRoot` and return the
   *  declared definition's `<field>` schema. */
  defs?: {
    resolve(kind: string): Record<string, any> | undefined;
  };
  aliases?: {
    resolveKind(kind: string): string | undefined;
  };
  allManifests?: Record<string, any>[];
}

/**
 * Resolve a type field value (string name, inline type, or raw schema) to a JSON Schema.
 * - String: look up the named type in allManifests (Type.JsonSchema resources)
 * - Object with `kind` + `schema`: inline type definition → return the `schema`
 * - Object with `type` or `properties`: raw JSON Schema, return as-is
 */
export function resolveTypeFieldToSchema(
  value: unknown,
  allManifests: Record<string, any>[],
  ancestry: ReadonlySet<string> = new Set(),
): Record<string, any> | undefined {
  if (!value) return undefined;

  if (typeof value === "string") {
    // Cycle guard: a type already on the resolution path can't extend back into it.
    if (ancestry.has(value)) return undefined;
    // Named type reference — find a Telo.Type resource by name
    const typeManifest = allManifests.find(
      (m) =>
        (m.metadata as any)?.name === value &&
        typeof m.kind === "string" &&
        /\bType\b/.test(m.kind) &&
        typeof m.schema === "object" &&
        m.schema !== null,
    );
    if (!typeManifest) return undefined;
    return applyExtends(
      typeManifest.schema as Record<string, any>,
      typeManifest.extends,
      allManifests,
      new Set(ancestry).add(value),
    );
  }

  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, any>;
    // Inline type resource: { kind: "Type.JsonSchema", schema: {...} }
    if (obj.schema && typeof obj.schema === "object") {
      return applyExtends(obj.schema as Record<string, any>, obj.extends, allManifests, ancestry);
    }
    // Raw JSON Schema (has type or properties)
    if (obj.type || obj.properties) {
      return obj;
    }
    // Named type reference resolved from a `!ref` → { kind, name } — resolve the
    // named Telo.Type the same way as the bare-string form.
    if (typeof obj.name === "string") {
      return resolveTypeFieldToSchema(obj.name, allManifests, ancestry);
    }
  }

  return undefined;
}

/**
 * Fold a `Type.JsonSchema`'s `extends` parents into its own schema, matching the
 * runtime `type` controller exactly — both call the shared `mergeTypeSchemas`, so
 * static analysis and runtime validation can never disagree on a type's effective
 * shape. Without this the analyzer would see only a child type's own properties
 * and reject valid access to an inherited field with a false `CEL_UNKNOWN_FIELD`.
 * `ancestry` carries the resolution path for cycle detection (siblings share it
 * unmutated, so diamond inheritance still re-includes a shared grandparent).
 */
function applyExtends(
  ownSchema: Record<string, any>,
  extendsField: unknown,
  allManifests: Record<string, any>[],
  ancestry: ReadonlySet<string>,
): Record<string, any> {
  if (!extendsField) return ownSchema;
  const parents = Array.isArray(extendsField) ? extendsField : [extendsField];
  const resolved: Record<string, any>[] = [];
  for (const parent of parents) {
    const parentSchema = resolveTypeFieldToSchema(parent, allManifests, ancestry);
    if (parentSchema) resolved.push(parentSchema);
  }
  if (resolved.length === 0) return ownSchema;
  return mergeTypeSchemas([...resolved, ownSchema]) as Record<string, any>;
}

/** Pull the raw expression source from a CEL field value — a compiled value
 *  (`{ source }`), or a string (`!cel "x"` or `"${{ x }}"`). Strips a lone
 *  `${{ }}` wrapper. Returns null when no source is recoverable. */
function celExprSource(raw: unknown): string | null {
  let s: string | undefined;
  if (typeof raw === "string") s = raw;
  else if (raw && typeof raw === "object" && typeof (raw as Record<string, any>).source === "string")
    s = (raw as Record<string, any>).source;
  if (s == null) return null;
  const exact = s.match(/^\s*\$\{\{\s*([^}]+?)\s*\}\}\s*$/);
  return (exact ? exact[1] : s).trim();
}

/** Member-access chain for a bare dotted-identifier expression
 *  (`inputs.user.tags` → ["inputs","user","tags"]). Returns null for anything
 *  else (literals, calls, indexing, comprehensions) — those are not statically
 *  reducible to a single typed path. */
function purePathChain(raw: unknown): string[] | null {
  const expr = celExprSource(raw);
  if (expr == null) return null;
  if (!/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(expr)) return null;
  return expr.split(".");
}

/** Walk a member-access chain through a JSON Schema (descending `properties`)
 *  and return the terminal node, or undefined when the path leaves typed schema. */
function schemaAtChain(
  chain: string[],
  root: Record<string, any>,
): Record<string, any> | undefined {
  let cur: Record<string, any> | undefined = root;
  for (const key of chain) {
    if (!cur || typeof cur !== "object") return undefined;
    const props = cur.properties as Record<string, any> | undefined;
    if (!props || !(key in props)) return undefined;
    cur = props[key] as Record<string, any>;
  }
  return cur && typeof cur === "object" ? cur : undefined;
}

/** The element schema of a sibling collection expression, when statically known.
 *  Resolves `inputs.*` chains against the resource's `inputs:` contract and
 *  returns the array's `items`. Returns undefined for non-chain or untyped
 *  collections (caller substitutes `dyn`). */
function resolveCollectionElementSchema(
  manifestRoot: Record<string, any>,
  field: string,
): Record<string, any> | undefined {
  const chain = purePathChain(manifestRoot?.[field]);
  if (!chain || chain[0] !== "inputs") return undefined;
  const contract = manifestRoot.inputs;
  if (!contract || typeof contract !== "object") return undefined;
  const terminal = schemaAtChain(chain.slice(1), { type: "object", properties: contract });
  if (terminal && terminal.type === "array" && terminal.items && typeof terminal.items === "object") {
    return terminal.items as Record<string, any>;
  }
  return undefined;
}

/**
 * Returns true when a CEL expression path (from walkCelExpressions, e.g. "routes[0].inputs.q")
 * falls within the scope of a context (e.g. "$.routes[*].inputs").
 *
 * The scope is matched directly (no sibling sharing): a context at "$.routes[*].inputs" only
 * applies to expressions whose path starts with "routes[N].inputs", not to other sibling fields.
 */
export function pathMatchesScope(exprPath: string, scope: string): boolean {
  const stripped = scope.startsWith("$.") ? scope.slice(2) : scope;
  if (!stripped) return false;

  // Split on wildcard array segments; each [*] must match a concrete [N] in exprPath
  const parts = stripped.split("[*]");
  let remaining = exprPath;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!remaining.startsWith(part)) return false;
    remaining = remaining.slice(part.length);
    if (i < parts.length - 1) {
      // Expect a concrete array index like [0], [12], ...
      const m = remaining.match(/^\[\d+\]/);
      if (!m) return false;
      remaining = remaining.slice(m[0].length);
    }
  }
  // Expression must end here or continue into a child path
  return remaining === "" || remaining[0] === "." || remaining[0] === "[";
}

/**
 * Resolves `x-telo-context-*` annotations in a context schema using the concrete
 * manifest item (per-scope) and the manifest root.
 *
 * Annotation forms:
 *
 * - `x-telo-context-from`: navigates `manifestItem.<path>` and treats the resolved
 *   value as a **property map** (keys → sub-schemas) that is merged into the
 *   annotated node's properties. Used for HTTP-style scopes where the navigated
 *   value is itself a map of variable names.
 *
 *   Example: `x-telo-context-from: "request/schema"` reads `manifestItem.request.schema`
 *   (= `{ query: {...}, body: {...}, … }`) and merges those keys as named properties
 *   of the context node.
 *
 * - `x-telo-context-from-root`: navigates `manifestRoot.<path>` and **replaces** the
 *   annotated node's schema with the resolved value. Used on individual property
 *   schemas (e.g. `properties.self`) where the resolved value is a single variable's
 *   full schema, not a property map.
 *
 *   Example: `properties.self.x-telo-context-from-root: "schema"` reads
 *   `manifestRoot.schema` and uses it as the schema of the `self` CEL variable.
 *
 * - `x-telo-context-from-ref-kind`: reads a kind name from `manifestRoot.<refPath>`,
 *   resolves it via the definition registry, and returns that kind's `<field>` schema
 *   (e.g. `outputType`/`inputType`). Used to type `result` against the dispatch
 *   target's declared output shape.
 *
 *   Syntax: `<refPath>#<field>` — slashes traverse the manifest tree.
 *
 *   Example: `x-telo-context-from-ref-kind: "provide/kind#outputType"` reads
 *   `manifestRoot.provide.kind` as a kind name, looks up the kind's Telo.Definition,
 *   and returns the `outputType` schema.
 *
 *   Accepts either a single string or an array of strings. With an array, paths
 *   are tried in order and the first one that resolves to a usable schema wins —
 *   used by `result:` to find its dispatch target under whichever entry-point
 *   field (`provide:` or `invoke:`) the definition declares.
 *
 * - `x-telo-context-ref-from`: existing form — reads `{kind, name}` object from
 *   `manifestItem.<path>`, looks up the named manifest, returns its `<subpath>` field.
 *
 * **Fallback chain.** When both `x-telo-context-from-root` and
 * `x-telo-context-from-ref-kind` are present on the same node, the resolver tries
 * `from-root` first; if that produces no usable schema, it falls back to `from-ref-kind`.
 * This lets a definition declare typing from its own field with a sibling-kind fallback
 * (e.g. `inputType` direct → `extends`-declared abstract's `inputType`).
 */
export function resolveContextAnnotations(
  schema: Record<string, any>,
  manifestItem: Record<string, any>,
  opts?: ContextResolveOpts | Record<string, any>[],
): Record<string, any> {
  if (!schema || typeof schema !== "object") return schema;

  // Back-compat: third positional arg used to be `allManifests: Record<string, any>[]`.
  const normalizedOpts: ContextResolveOpts = Array.isArray(opts)
    ? { allManifests: opts }
    : (opts ?? {});
  const { manifestRoot = manifestItem, defs, aliases, allManifests } = normalizedOpts;

  const from = schema["x-telo-context-from"] as string | undefined;
  if (from) {
    const resolved = navigatePath(manifestItem, from.split("/")) as Record<string, any> | undefined;
    // `resolved` is a map of property names → sub-schemas (e.g. { query: {...}, body: {...} })
    return {
      ...schema,
      properties: { ...(schema.properties ?? {}), ...(resolved ?? {}) },
      additionalProperties: false,
    };
  }

  // Element typing: derive a variable's schema from the element type of a sibling
  // collection expression (e.g. `item` from `collection`). Resolves only when the
  // collection is a member-access chain into the resource's typed `inputs` contract
  // (the common, statically-knowable case); list literals, comprehensions, and
  // untyped sources fall back to `dyn` so a wrong element type is never invented.
  const elementFrom = schema["x-telo-context-element-from"] as string | undefined;
  if (elementFrom) {
    const items = resolveCollectionElementSchema(manifestRoot, elementFrom);
    return items ?? {};
  }

  const fromRoot = schema["x-telo-context-from-root"] as string | undefined;
  const fromRefKindRaw = schema["x-telo-context-from-ref-kind"] as
    | string
    | string[]
    | undefined;
  const fromRefKinds = fromRefKindRaw == null
    ? []
    : Array.isArray(fromRefKindRaw)
      ? fromRefKindRaw
      : [fromRefKindRaw];
  if (fromRoot || fromRefKinds.length > 0) {
    if (fromRoot) {
      const resolved = navigatePath(manifestRoot, fromRoot.split("/")) as
        | Record<string, any>
        | undefined;
      if (resolved && typeof resolved === "object" && !Array.isArray(resolved)) {
        return resolved;
      }
    }
    if (defs) {
      for (const fromRefKind of fromRefKinds) {
        const hashIdx = fromRefKind.indexOf("#");
        if (hashIdx <= 0) continue;
        const refPath = fromRefKind.slice(0, hashIdx);
        const field = fromRefKind.slice(hashIdx + 1);
        const kindValue = navigatePath(manifestRoot, refPath.split("/"));
        if (typeof kindValue !== "string" || kindValue.length === 0) continue;
        const canonical = aliases?.resolveKind(kindValue) ?? kindValue;
        const def = defs.resolve(canonical);
        const typeField = def
          ? (def as Record<string, unknown>)[field]
          : undefined;
        const resolved = resolveTypeFieldToSchema(typeField, allManifests ?? []);
        if (resolved && typeof resolved === "object") {
          return resolved;
        }
      }
    }
    // Open fallback so unresolved types never produce false-positive CEL diagnostics.
    return { type: "object", additionalProperties: true };
  }

  const refFrom = schema["x-telo-context-ref-from"] as string | undefined;
  if (refFrom && allManifests) {
    const slashIdx = refFrom.indexOf("/");
    const refProp = slashIdx === -1 ? refFrom : refFrom.slice(0, slashIdx);
    const subpath = slashIdx === -1 ? undefined : refFrom.slice(slashIdx + 1);
    const ref = manifestItem[refProp] as Record<string, any> | undefined;
    if (
      ref &&
      typeof ref === "object" &&
      typeof ref.kind === "string" &&
      typeof ref.name === "string" &&
      subpath
    ) {
      const refManifest = allManifests.find(
        (m) => m.kind === ref.kind && (m.metadata as any)?.name === ref.name,
      ) as Record<string, any> | undefined;
      if (refManifest) {
        const resolved = resolveTypeFieldToSchema(
          navigatePath(refManifest, subpath.split("/")) as unknown,
          allManifests,
        );
        if (resolved && typeof resolved === "object") {
          return resolved;
        }
      }
    }
    // Fallback: open schema (no false errors when outputType is not declared)
    return { ...schema, additionalProperties: true };
  }

  if (schema.properties) {
    const props: Record<string, any> = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      props[k] = resolveContextAnnotations(v as Record<string, any>, manifestItem, normalizedOpts);
    }
    return { ...schema, properties: props };
  }

  return schema;
}

/**
 * Extracts the concrete manifest array item for a given expression path + scope.
 * e.g. exprPath="routes[0].inputs.q", scope="$.routes[*].inputs" → manifest.routes[0]
 */
export function getManifestItem(
  exprPath: string,
  scope: string,
  manifest: Record<string, any>,
): Record<string, any> {
  const stripped = scope.startsWith("$.") ? scope.slice(2) : scope;
  const wildcardIdx = stripped.indexOf("[*]");
  if (wildcardIdx === -1) return manifest;
  const arrayProp = stripped.slice(0, wildcardIdx); // e.g. "routes"
  const m = exprPath.match(new RegExp(`^${arrayProp}\\[(\\d+)\\]`));
  if (!m) return manifest;
  return (manifest as any)[arrayProp]?.[Number(m[1])] ?? manifest;
}

function navigatePath(obj: unknown, segments: string[]): unknown {
  let cur = obj;
  for (const seg of segments) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Walk a JSON Schema tree and collect all `x-telo-context` annotations,
 * returning them as `{ scope, schema }` pairs using JSONPath-style scopes —
 * the same format the analyzer uses for CEL context validation.
 *
 * Result is sorted by scope specificity (longer scope first) so that the
 * per-expression resolver's first-match-wins logic picks the most-specific
 * context. Without this, a broader ancestor scope (e.g. `$.resources[*]`)
 * could shadow a narrower descendant scope whose activation differs.
 */
export function extractContextsFromSchema(
  schema: Record<string, any>,
  path = "$",
): Array<{ scope: string; schema: Record<string, any> }> {
  const all = collectContexts(schema, path);
  return all.sort((a, b) => b.scope.length - a.scope.length);
}

function collectContexts(
  schema: Record<string, any>,
  path: string,
): Array<{ scope: string; schema: Record<string, any> }> {
  if (!schema || typeof schema !== "object") return [];
  const results: Array<{ scope: string; schema: Record<string, any> }> = [];

  if (schema["x-telo-context"]) {
    results.push({ scope: path, schema: schema["x-telo-context"] });
  }

  if (schema.properties) {
    for (const [key, value] of Object.entries(schema.properties as Record<string, any>)) {
      results.push(...collectContexts(value, `${path}.${key}`));
    }
  }

  if (schema.items && typeof schema.items === "object") {
    results.push(...collectContexts(schema.items, `${path}[*]`));
  }

  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(schema[key])) {
      for (const subschema of schema[key]) {
        results.push(...collectContexts(subschema, path));
      }
    }
  }

  return results;
}
