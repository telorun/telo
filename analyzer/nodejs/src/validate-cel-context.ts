import type { ASTNode } from "@marcbachmann/cel-js";

/**
 * Resolve a type field value (string name, inline type, or raw schema) to a JSON Schema.
 * - String: look up the named type in allManifests (Type.JsonSchema resources)
 * - Object with `kind` + `schema`: inline type definition → return the `schema`
 * - Object with `type` or `properties`: raw JSON Schema, return as-is
 */
export function resolveTypeFieldToSchema(
  value: unknown,
  allManifests: Record<string, any>[],
): Record<string, any> | undefined {
  if (!value) return undefined;

  if (typeof value === "string") {
    // Named type reference — find a Kernel.Type resource by name
    const typeManifest = allManifests.find(
      (m) =>
        (m.metadata as any)?.name === value &&
        typeof m.kind === "string" &&
        /\bType\b/.test(m.kind) &&
        typeof m.schema === "object" &&
        m.schema !== null,
    );
    return typeManifest?.schema as Record<string, any> | undefined;
  }

  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, any>;
    // Inline type resource: { kind: "Type.JsonSchema", schema: {...} }
    if (obj.schema && typeof obj.schema === "object") {
      return obj.schema as Record<string, any>;
    }
    // Raw JSON Schema (has type or properties)
    if (obj.type || obj.properties) {
      return obj;
    }
  }

  return undefined;
}

/**
 * Extract all member-access chains from a CEL AST.
 * Returns arrays like ["request", "query", "name"] for `request.query.name`.
 * Chains that start with a call or non-identifier root are ignored.
 * Bound variables in comprehension macros (filter, map, exists, all, exists_one) are excluded.
 */
export function extractAccessChains(node: ASTNode): string[][] {
  const chains: string[][] = [];
  visitNode(node, chains, new Set());
  return chains;
}

// CEL comprehension macros that bind a variable: list.filter(x, ...), list.map(x, ...), etc.
const COMPREHENSION_METHODS = new Set(["filter", "map", "exists", "all", "exists_one"]);

function visitNode(node: ASTNode, chains: string[][], boundVars: Set<string>): void {
  const chain = extractChain(node, boundVars);
  if (chain !== null) {
    chains.push(chain);
    return; // don't recurse into parts of an already-collected chain
  }

  // Comprehension macros bind a variable in their body — handle them specially
  // AST shape: { op: "rcall", args: [methodName, receiver, [boundVarId, body, ...]] }
  if (
    node.op === "rcall" &&
    Array.isArray(node.args) &&
    typeof node.args[0] === "string" &&
    COMPREHENSION_METHODS.has(node.args[0])
  ) {
    const receiver = node.args[1];
    const comprehensionArgs = node.args[2];
    if (isASTNode(receiver)) visitNode(receiver, chains, boundVars);
    if (
      Array.isArray(comprehensionArgs) &&
      comprehensionArgs.length >= 2 &&
      isASTNode(comprehensionArgs[0]) &&
      (comprehensionArgs[0] as ASTNode).op === "id"
    ) {
      const newBoundVars = new Set(boundVars);
      newBoundVars.add((comprehensionArgs[0] as ASTNode).args as string);
      for (let i = 1; i < comprehensionArgs.length; i++) {
        const arg = comprehensionArgs[i];
        if (isASTNode(arg)) visitNode(arg as ASTNode, chains, newBoundVars);
      }
    }
    return;
  }

  const args = node.args;
  if (Array.isArray(args)) {
    for (const arg of args) {
      if (isASTNode(arg)) {
        visitNode(arg, chains, boundVars);
      } else if (Array.isArray(arg)) {
        for (const item of arg) {
          if (isASTNode(item)) visitNode(item, chains, boundVars);
        }
      }
    }
  }
}

function isASTNode(v: unknown): v is ASTNode {
  return v !== null && typeof v === "object" && "op" in (v as object);
}

/** Returns the member-access chain for a node if it is purely an id or "." chain; else null. */
function extractChain(node: ASTNode, boundVars: Set<string>): string[] | null {
  if (node.op === "id") {
    const name = node.args as string;
    if (boundVars.has(name)) return null; // bound by a comprehension macro, not a free access
    return [name];
  }
  if (node.op === ".") {
    const [obj, field] = node.args as [ASTNode, string];
    const parent = extractChain(obj, boundVars);
    if (parent !== null) return [...parent, field];
  }
  return null;
}

/**
 * Check whether a member-access chain accesses only fields declared in a JSON Schema.
 * Returns an error string if a field is unknown in a schema that declares explicit
 * properties without `additionalProperties: true`.
 * Returns null when the chain is valid or the schema is too open to judge.
 */
export function validateChainAgainstSchema(
  chain: string[],
  schema: Record<string, any>,
): string | null {
  let current: Record<string, any> = schema;
  for (let i = 0; i < chain.length; i++) {
    const key = chain[i]!;
    if (!current || typeof current !== "object") return null;
    const props: Record<string, any> | undefined = current.properties;
    if (!props) return null;
    if (key in props) {
      // Known property — drill into it even if additionalProperties is true
      current = props[key];
      continue;
    }
    // Unknown property — only flag if schema is closed
    if (current.additionalProperties === true) return null;
    const path = chain.slice(0, i + 1).join(".");
    const available = Object.keys(props).join(", ");
    return `'${path}' is not defined (available: ${available})`;
  }
  return null;
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
 * Resolves `x-telo-context-from` annotations in a context schema using the concrete
 * manifest item. Navigates the manifest item at the given slash-separated path and merges
 * the result as named properties into the annotated node (locking additionalProperties: false).
 *
 * Example: `x-telo-context-from: "request/schema"` on the `request` context node replaces
 * the open `request` schema with a closed schema whose properties are the keys of
 * `manifestItem.request.schema` (e.g. `query`, `body`, `params`, `headers`).
 */
export function resolveContextAnnotations(
  schema: Record<string, any>,
  manifestItem: Record<string, any>,
  allManifests?: Record<string, any>[],
): Record<string, any> {
  if (!schema || typeof schema !== "object") return schema;

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
      props[k] = resolveContextAnnotations(v as Record<string, any>, manifestItem, allManifests);
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
