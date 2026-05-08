import type { ASTNode } from "@marcbachmann/cel-js";

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

const COMPREHENSION_METHODS = new Set(["filter", "map", "exists", "all", "exists_one"]);

function visitNode(node: ASTNode, chains: string[][], boundVars: Set<string>): void {
  const chain = extractChain(node, boundVars);
  if (chain !== null) {
    chains.push(chain);
    return;
  }

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

const INDEX_SEGMENT = "[*]";

function extractChain(node: ASTNode, boundVars: Set<string>): string[] | null {
  if (node.op === "id") {
    const name = node.args as string;
    if (boundVars.has(name)) return null;
    return [name];
  }
  if (node.op === ".") {
    const [obj, field] = node.args as [ASTNode, string];
    const parent = extractChain(obj, boundVars);
    if (parent !== null) return [...parent, field];
  }
  if (node.op === "[]") {
    const [obj] = node.args as [ASTNode, ASTNode];
    const parent = extractChain(obj, boundVars);
    if (parent !== null) return [...parent, INDEX_SEGMENT];
  }
  return null;
}

/**
 * Check whether a member-access chain accesses only fields declared in a JSON Schema.
 * Returns an error string if a field is unknown in a schema that declares explicit
 * properties without `additionalProperties: true`, or if the chain attempts to
 * reach inside an `x-telo-stream: true` property.
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
      const propSchema = props[key];
      if (
        propSchema &&
        typeof propSchema === "object" &&
        propSchema["x-telo-stream"] === true &&
        i < chain.length - 1
      ) {
        const path = chain.slice(0, i + 1).join(".");
        return `'${path}' yields a stream — pipe it through an Encoder or iterate in a JS.Script step (no member access on stream-typed values)`;
      }
      current = propSchema;
      continue;
    }
    if (current.additionalProperties === true) return null;
    const path = chain.slice(0, i + 1).join(".");
    const available = Object.keys(props).join(", ");
    return `'${path}' is not defined (available: ${available})`;
  }
  return null;
}
