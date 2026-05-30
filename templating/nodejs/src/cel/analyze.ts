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
  } else if (isASTNode(args)) {
    // Unary operators (`!_`, `-_`) carry their operand as a single node
    // rather than a one-element array, so descend into it directly.
    visitNode(args, chains, boundVars);
  }
}

function isASTNode(v: unknown): v is ASTNode {
  return v !== null && typeof v === "object" && "op" in (v as object);
}

/** Sentinel chain segment emitted for index access (`obj[expr]`) — a dynamic
 *  member that can't be resolved to a static name. Consumers that attribute
 *  chains to declared names treat this as "unknown member". */
export const INDEX_SEGMENT = "[*]";

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

interface NullableIssue {
  /** Dotted path of the nullable value being dereferenced (e.g. "error"). */
  path: string;
  /** The member accessed on it (e.g. "code", or "[index]"). */
  member: string;
}

/** True when a JSON Schema admits `null` — `type: "null"` or a union that
 *  includes it (e.g. `["object", "null"]`). */
function schemaIsNullable(schema: Record<string, any> | undefined): boolean {
  if (!schema || typeof schema !== "object") return false;
  const t = schema.type;
  return t === "null" || (Array.isArray(t) && t.includes("null"));
}

/** Navigate `schema` following a member chain, descending through `properties`.
 *  Returns the schema node at that path, or undefined when it can't be resolved. */
function schemaAtChain(
  chain: string[],
  schema: Record<string, any>,
): Record<string, any> | undefined {
  let current: Record<string, any> | undefined = schema;
  for (const key of chain) {
    if (!current || typeof current !== "object") return undefined;
    const props = current.properties as Record<string, any> | undefined;
    if (!props || !(key in props)) return undefined;
    current = props[key];
  }
  return current;
}

function isNullLiteral(node: ASTNode): boolean {
  return node.op === "value" && (node.args as unknown) === null;
}

/** Dotted form of a static member chain rooted at a free identifier, or null
 *  when the node isn't such a chain (call result, bound var, index, …). */
function dottedChain(node: ASTNode, boundVars: Set<string>): string | null {
  const chain = extractChain(node, boundVars);
  if (chain === null || chain.includes(INDEX_SEGMENT)) return null;
  return chain.join(".");
}

interface Narrowing {
  whenTrue: Set<string>;
  whenFalse: Set<string>;
}

const EMPTY_NARROWING: Narrowing = { whenTrue: new Set(), whenFalse: new Set() };

/** Derive which chains a boolean condition proves non-null in its true / false
 *  branches. Handles `x == null` / `x != null`, negation, and `&&` / `||`. */
function deriveNarrowing(node: ASTNode, boundVars: Set<string>): Narrowing {
  if (node.op === "==" || node.op === "!=") {
    const [l, r] = node.args as [ASTNode, ASTNode];
    const chain = isNullLiteral(r)
      ? dottedChain(l, boundVars)
      : isNullLiteral(l)
        ? dottedChain(r, boundVars)
        : null;
    if (chain === null) return EMPTY_NARROWING;
    const proven = new Set([chain]);
    return node.op === "!="
      ? { whenTrue: proven, whenFalse: new Set() }
      : { whenTrue: new Set(), whenFalse: proven };
  }
  if (node.op === "!_") {
    const inner = deriveNarrowing(node.args as ASTNode, boundVars);
    return { whenTrue: inner.whenFalse, whenFalse: inner.whenTrue };
  }
  if (node.op === "&&") {
    const [a, b] = node.args as [ASTNode, ASTNode];
    const na = deriveNarrowing(a, boundVars);
    const nb = deriveNarrowing(b, boundVars);
    return { whenTrue: union(na.whenTrue, nb.whenTrue), whenFalse: new Set() };
  }
  if (node.op === "||") {
    const [a, b] = node.args as [ASTNode, ASTNode];
    const na = deriveNarrowing(a, boundVars);
    const nb = deriveNarrowing(b, boundVars);
    return { whenTrue: new Set(), whenFalse: union(na.whenFalse, nb.whenFalse) };
  }
  return EMPTY_NARROWING;
}

function union(a: Set<string>, b: Set<string>): Set<string> {
  return new Set([...a, ...b]);
}

/**
 * Find member accesses on a nullable value that are not null-guarded in the
 * surrounding expression. A context field whose schema admits `null` (e.g. the
 * `error` object inside a `finally` block, typed `["object", "null"]`) must be
 * narrowed before its members are read. Recognised guards: `x == null` /
 * `x != null` flowing through `?:` ternaries and `&&` / `||` short-circuits.
 * Returns one issue per unguarded dereference.
 */
export function findNullableAccessIssues(
  node: ASTNode,
  contextSchema: Record<string, any>,
): NullableIssue[] {
  const issues: NullableIssue[] = [];
  walkNullable(node, new Set(), new Set(), issues, contextSchema);
  return issues;
}

function walkNullable(
  node: ASTNode,
  nonNull: Set<string>,
  boundVars: Set<string>,
  issues: NullableIssue[],
  schema: Record<string, any>,
): void {
  // Dereference of an object/array member — check the receiver's nullability.
  if (node.op === "." || node.op === "[]") {
    const [obj, field] = node.args as [ASTNode, unknown];
    const objChain = dottedChain(obj, boundVars);
    if (objChain !== null && !nonNull.has(objChain)) {
      const objSchema = schemaAtChain(objChain.split("."), schema);
      if (schemaIsNullable(objSchema)) {
        issues.push({
          path: objChain,
          member: node.op === "." ? String(field) : "[index]",
        });
      }
    }
    walkNullable(obj, nonNull, boundVars, issues, schema);
    // The index expression (`obj[expr]`) is itself evaluated — descend so a
    // nullable deref used as an index (e.g. `items[error.code]`) is caught.
    if (node.op === "[]" && isASTNode(field)) {
      walkNullable(field as ASTNode, nonNull, boundVars, issues, schema);
    }
    return;
  }

  if (node.op === "?:") {
    const [cond, thenB, elseB] = node.args as [ASTNode, ASTNode, ASTNode];
    walkNullable(cond, nonNull, boundVars, issues, schema);
    const n = deriveNarrowing(cond, boundVars);
    walkNullable(thenB, union(nonNull, n.whenTrue), boundVars, issues, schema);
    walkNullable(elseB, union(nonNull, n.whenFalse), boundVars, issues, schema);
    return;
  }

  if (node.op === "&&" || node.op === "||") {
    const [a, b] = node.args as [ASTNode, ASTNode];
    walkNullable(a, nonNull, boundVars, issues, schema);
    const n = deriveNarrowing(a, boundVars);
    const carried = node.op === "&&" ? n.whenTrue : n.whenFalse;
    walkNullable(b, union(nonNull, carried), boundVars, issues, schema);
    return;
  }

  // Comprehension macros bind a loop variable; mirror extractAccessChains so a
  // bound var is never mistaken for a nullable context field.
  if (
    node.op === "rcall" &&
    Array.isArray(node.args) &&
    typeof node.args[0] === "string" &&
    COMPREHENSION_METHODS.has(node.args[0])
  ) {
    const receiver = node.args[1];
    const comprehensionArgs = node.args[2];
    if (isASTNode(receiver)) walkNullable(receiver, nonNull, boundVars, issues, schema);
    if (
      Array.isArray(comprehensionArgs) &&
      comprehensionArgs.length >= 2 &&
      isASTNode(comprehensionArgs[0]) &&
      (comprehensionArgs[0] as ASTNode).op === "id"
    ) {
      const inner = new Set(boundVars);
      inner.add((comprehensionArgs[0] as ASTNode).args as string);
      for (let i = 1; i < comprehensionArgs.length; i++) {
        const arg = comprehensionArgs[i];
        if (isASTNode(arg)) walkNullable(arg as ASTNode, nonNull, inner, issues, schema);
      }
    }
    return;
  }

  const args = node.args;
  if (Array.isArray(args)) {
    for (const arg of args) {
      if (isASTNode(arg)) walkNullable(arg, nonNull, boundVars, issues, schema);
      else if (Array.isArray(arg)) {
        for (const item of arg) {
          if (isASTNode(item)) walkNullable(item, nonNull, boundVars, issues, schema);
        }
      }
    }
  } else if (isASTNode(args)) {
    walkNullable(args, nonNull, boundVars, issues, schema);
  }
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
