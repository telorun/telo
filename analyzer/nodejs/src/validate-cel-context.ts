import type { ASTNode } from "@marcbachmann/cel-js";

/**
 * Extract all member-access chains from a CEL AST.
 * Returns arrays like ["request", "query", "name"] for `request.query.name`.
 * Chains that start with a call or non-identifier root are ignored.
 */
export function extractAccessChains(node: ASTNode): string[][] {
  const chains: string[][] = [];
  visitNode(node, chains);
  return chains;
}

function visitNode(node: ASTNode, chains: string[][]): void {
  const chain = extractChain(node);
  if (chain !== null) {
    chains.push(chain);
    return; // don't recurse into parts of an already-collected chain
  }
  const args = node.args;
  if (Array.isArray(args)) {
    for (const arg of args) {
      if (isASTNode(arg)) {
        visitNode(arg, chains);
      } else if (Array.isArray(arg)) {
        for (const item of arg) {
          if (isASTNode(item)) visitNode(item, chains);
        }
      }
    }
  }
}

function isASTNode(v: unknown): v is ASTNode {
  return v !== null && typeof v === "object" && "op" in (v as object);
}

/** Returns the member-access chain for a node if it is purely an id or "." chain; else null. */
function extractChain(node: ASTNode): string[] | null {
  if (node.op === "id") return [node.args as string];
  if (node.op === ".") {
    const [obj, field] = node.args as [ASTNode, string];
    const parent = extractChain(obj);
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
    // Open schema: no properties declared or explicitly allows additional properties
    const props: Record<string, any> | undefined = current.properties;
    if (!props) return null;
    if (current.additionalProperties === true) return null;
    if (!(key in props)) {
      const path = chain.slice(0, i + 1).join(".");
      const available = Object.keys(props).join(", ");
      return `'${path}' is not defined (available: ${available})`;
    }
    current = props[key];
  }
  return null;
}

/**
 * Returns true when a CEL expression path (from walkCelExpressions, e.g. "routes[0].handler.inputs.name")
 * falls within the container region of a context scope (e.g. "$.routes[*].handler").
 *
 * The container is derived by stripping the last dot-separated segment from the scope, so that
 * sibling fields within the same parent (e.g. routes[*].response) also match.
 */
export function pathMatchesScope(exprPath: string, scope: string): boolean {
  const stripped = scope.startsWith("$.") ? scope.slice(2) : scope;
  const lastDot = stripped.lastIndexOf(".");
  if (lastDot <= 0) return false;
  const container = stripped.slice(0, lastDot); // e.g. "routes[*]"

  // Split on wildcard array segments; each [*] must match a concrete [N] in exprPath
  const parts = container.split("[*]");
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
