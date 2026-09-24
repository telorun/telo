import type { ASTNode } from "@marcbachmann/cel-js";
import { isLiveSlot } from "@telorun/sdk";
import { moduleCallOf } from "./module-call.js";

/**
 * Extract all member-access chains from a CEL AST.
 * Returns arrays like ["request", "query", "name"] for `request.query.name`.
 * Chains that start with a call or non-identifier root are ignored.
 * Bound variables in comprehension macros (filter, map, exists, all, exists_one) are excluded.
 *
 * A RESOLVED module call contributes no chain for its receiver: `Billing` in
 * `Billing.format(x)` names a module, not a value, so reading it as a root
 * would invent a dependency, an undeclared identifier and a `resources` read
 * that the expression never states. Resolution is `resolveModuleCalls`, on the
 * tree, before this walk — an unresolved tree still reports the receiver, which
 * is the right answer for a caller that supplied no module names.
 */
export function extractAccessChains(node: ASTNode): string[][] {
  const chains: string[][] = [];
  visitNode(node, chains, new Set());
  return chains;
}

/**
 * Each resolved module call's arguments as plain member chains, keyed by the
 * call's node — `null` for an argument that is not one, or that is rooted at a
 * name the expression itself binds (`xs.map(item, Billing.total(item))`), which
 * no context schema describes.
 */
export function moduleCallArgumentChains(node: ASTNode): Map<ASTNode, Array<string[] | null>> {
  const out = new Map<ASTNode, Array<string[] | null>>();
  visitNode(node, [], new Set(), (call, callNode, boundVars) => {
    out.set(
      callNode,
      call.args.map((arg) => extractChain(arg, boundVars)),
    );
  });
  return out;
}

type ModuleCallVisitor = (
  call: NonNullable<ReturnType<typeof moduleCallOf>>,
  node: ASTNode,
  boundVars: ReadonlySet<string>,
) => void;

const COMPREHENSION_METHODS = new Set(["filter", "map", "exists", "all", "exists_one"]);

/** `cel.bind(name, init, body)` — CEL's only binding form, and the one the
 *  parser expands rather than dispatching, so it appears as a receiver call on a
 *  bare `cel` identifier that is in no scope and never will be. Both walks below
 *  need the same three facts out of it, so the shape is read once here.
 *
 *  The receiver is deliberately not returned: it contributes no chain, and
 *  descending into it is what produced a `CEL_UNKNOWN_FIELD` for `cel` itself. */
function bindCall(node: ASTNode): { name: string; init: ASTNode; body: ASTNode } | null {
  if (node.op !== "rcall" || !Array.isArray(node.args)) return null;
  const [method, receiver, callArgs] = node.args as [unknown, unknown, unknown];
  if (method !== "bind") return null;
  if (!isASTNode(receiver) || receiver.op !== "id" || receiver.args !== "cel") return null;
  if (!Array.isArray(callArgs) || callArgs.length !== 3) return null;
  const [nameNode, init, body] = callArgs as [unknown, unknown, unknown];
  if (!isASTNode(nameNode) || nameNode.op !== "id") return null;
  if (!isASTNode(init) || !isASTNode(body)) return null;
  return { name: nameNode.args as string, init, body };
}

function visitNode(
  node: ASTNode,
  chains: string[][],
  boundVars: Set<string>,
  onModuleCall?: ModuleCallVisitor,
): void {
  const chain = extractChain(node, boundVars);
  if (chain !== null) {
    chains.push(chain);
    return;
  }

  const moduleCall = moduleCallOf(node);
  if (moduleCall) {
    onModuleCall?.(moduleCall, node, boundVars);
    for (const arg of moduleCall.args) visitNode(arg, chains, boundVars, onModuleCall);
    return;
  }

  // The bound name is in scope for the body ONLY; `init` is evaluated in the
  // enclosing scope, so a name used there still has to resolve there.
  const bind = bindCall(node);
  if (bind) {
    visitNode(bind.init, chains, boundVars, onModuleCall);
    visitNode(bind.body, chains, new Set(boundVars).add(bind.name), onModuleCall);
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
    if (isASTNode(receiver)) visitNode(receiver, chains, boundVars, onModuleCall);
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
        if (isASTNode(arg)) visitNode(arg as ASTNode, chains, newBoundVars, onModuleCall);
      }
    }
    return;
  }

  const args = node.args;
  if (Array.isArray(args)) {
    for (const arg of args) {
      if (isASTNode(arg)) {
        visitNode(arg, chains, boundVars, onModuleCall);
      } else if (Array.isArray(arg)) {
        for (const item of arg) {
          if (isASTNode(item)) visitNode(item, chains, boundVars, onModuleCall);
        }
      }
    }
  } else if (isASTNode(args)) {
    // Unary operators (`!_`, `-_`) carry their operand as a single node
    // rather than a one-element array, so descend into it directly.
    visitNode(args, chains, boundVars, onModuleCall);
  }
}

function isASTNode(v: unknown): v is ASTNode {
  return v !== null && typeof v === "object" && "op" in (v as object);
}

/** Sentinel chain segment emitted for index access (`obj[expr]`) — a dynamic
 *  member that can't be resolved to a static name. Consumers that attribute
 *  chains to declared names treat this as "unknown member". */
export const INDEX_SEGMENT = "[*]";

function extractChain(node: ASTNode, boundVars: ReadonlySet<string>): string[] | null {
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

/** A member access on a module call's result: the call, and the members read
 *  off it in order (`Billing.total(xs).amount` → `amount`). */
export interface CallResultAccess {
  readonly qualified: string;
  readonly members: readonly string[];
}

/**
 * Every member access whose base is a module call, longest first — the chains
 * {@link extractAccessChains} deliberately skips, since their root is a value
 * no context schema describes. The caller supplies the call's result schema.
 */
export function extractCallResultAccesses(node: ASTNode): CallResultAccess[] {
  const out: CallResultAccess[] = [];
  visitAccess(node, out);
  return out;
}

function visitAccess(node: ASTNode, out: CallResultAccess[]): void {
  if (node.op === "." || node.op === "[]") {
    const members: string[] = [];
    let base: ASTNode = node;
    while (base.op === "." || base.op === "[]") {
      const [obj, field] = base.args as [ASTNode, unknown];
      members.unshift(base.op === "." ? String(field) : INDEX_SEGMENT);
      if (base.op === "[]" && isASTNode(field)) visitAccess(field, out);
      base = obj;
    }
    const call = moduleCallOf(base);
    if (call) {
      out.push({ qualified: call.qualified, members });
      for (const arg of call.args) visitAccess(arg, out);
      return;
    }
    visitAccess(base, out);
    return;
  }
  const moduleCall = moduleCallOf(node);
  if (moduleCall) {
    for (const arg of moduleCall.args) visitAccess(arg, out);
    return;
  }
  const args = node.args;
  if (Array.isArray(args)) {
    for (const arg of args) {
      if (isASTNode(arg)) visitAccess(arg, out);
      else if (Array.isArray(arg)) for (const item of arg) if (isASTNode(item)) visitAccess(item, out);
    }
  } else if (isASTNode(args)) {
    visitAccess(args, out);
  }
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

/** The dotted chain an expression IS, when it is a plain chain whose schema
 *  admits null — a value that may itself be null, rather than one dereferenced
 *  through a null. */
export function nullableValueChain(
  node: ASTNode,
  contextSchema: Record<string, any>,
): string | null {
  const chain = dottedChain(node, new Set());
  if (chain === null) return null;
  return schemaIsNullable(schemaAtChain(chain.split("."), contextSchema)) ? chain : null;
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

  // A module call's receiver is a module name, not a value; mirror
  // extractAccessChains so it is never read as a nullable context field.
  const moduleCall = moduleCallOf(node);
  if (moduleCall) {
    for (const arg of moduleCall.args) walkNullable(arg, nonNull, boundVars, issues, schema);
    return;
  }

  // `cel.bind` binds a name for its body; mirror extractAccessChains so a bound
  // name is never read as a nullable context field.
  const bind = bindCall(node);
  if (bind) {
    walkNullable(bind.init, nonNull, boundVars, issues, schema);
    walkNullable(bind.body, nonNull, new Set(boundVars).add(bind.name), issues, schema);
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
 * reach inside a `live` value type — one whose consumption has effects, so its
 * contents exist only for a consumer that drains it.
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
    // An index reads an ELEMENT: an array's `items`, or a map's value schema. What
    // is below it is checked like any member access, which is what reaches a
    // typo inside a list of records (`items[0].amont`). An object that also
    // declares `properties` may be indexed by one of those names, which the
    // chain does not record, so nothing below it is judged.
    if (key === INDEX_SEGMENT) {
      const element =
        current.items && typeof current.items === "object" && !Array.isArray(current.items)
          ? current.items
          : !current.properties &&
              current.additionalProperties &&
              typeof current.additionalProperties === "object"
            ? current.additionalProperties
            : undefined;
      if (!element) return null;
      current = element;
      continue;
    }
    const props: Record<string, any> | undefined = current.properties;
    if (!props) return null;
    if (key in props) {
      const propSchema = props[key];
      if (isLiveSlot(propSchema) && i < chain.length - 1) {
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
