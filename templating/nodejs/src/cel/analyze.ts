import {
  childNodes,
  namespaceMacroBinding,
  receiverMacroBinding,
  type CelNode,
} from "@telorun/cel";
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
export function extractAccessChains(node: CelNode): string[][] {
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
export function moduleCallArgumentChains(node: CelNode): Map<CelNode, Array<string[] | null>> {
  const out = new Map<CelNode, Array<string[] | null>>();
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
  node: CelNode,
  boundVars: ReadonlySet<string>,
) => void;

/**
 * `cel.bind(name, init, body)`.
 *
 * `cel` is a RESERVED namespace — one a host can never claim, because the standard macros
 * are written on it — so this is **not** a qualified call: it reads as a receiver call on
 * the ident `cel`, which is in no scope and never will be. The engine's own binding table
 * says which argument is the name and which are scoped.
 *
 * The receiver is deliberately not returned: it contributes no chain, and descending into it
 * is what produced a `CEL_UNKNOWN_FIELD` for `cel` itself.
 */
function bindCall(node: CelNode): { name: string; init: CelNode; body: CelNode } | null {
  if (node.kind !== "receiverCall") return null;
  if (node.receiver.kind !== "ident" || node.receiver.name !== "cel") return null;
  const binding = namespaceMacroBinding("cel", node.name, node.args.length);
  if (!binding) return null;
  const nameNode = node.args[binding.variableArgument];
  if (nameNode?.kind !== "ident") return null;
  const scoped = binding.scopedArguments;
  // `cel.bind(name, init, body)`: the body is scoped, everything else before it is not.
  const body = node.args[scoped[scoped.length - 1]!];
  const init = node.args.find(
    (unused, at) => at !== binding.variableArgument && !scoped.includes(at),
  );
  if (!init || !body) return null;
  return { name: nameNode.name, init, body };
}

/** A comprehension macro's iteration variable and the arguments it scopes, from the
 *  engine's own binding table rather than a list of method names kept in step with it. */
function comprehension(
  node: CelNode,
): { receiver: CelNode; bound: string; scoped: readonly CelNode[] } | null {
  if (node.kind !== "receiverCall") return null;
  if (node.receiver.kind === "ident" && node.receiver.name === "cel") return null;
  const binding = receiverMacroBinding(node.name, node.args.length);
  if (!binding) return null;
  const nameNode = node.args[binding.variableArgument];
  if (nameNode?.kind !== "ident") return null;
  return {
    receiver: node.receiver,
    bound: nameNode.name,
    scoped: binding.scopedArguments.flatMap((at) => (node.args[at] ? [node.args[at]!] : [])),
  };
}

function visitNode(
  node: CelNode,
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

  const macro = comprehension(node);
  if (macro) {
    // The receiver is evaluated outside the binding; only the scoped arguments see it.
    visitNode(macro.receiver, chains, boundVars, onModuleCall);
    const inner = new Set(boundVars).add(macro.bound);
    for (const arg of macro.scoped) visitNode(arg, chains, inner, onModuleCall);
    return;
  }

  for (const child of childNodes(node)) visitNode(child, chains, boundVars, onModuleCall);
}

/** Sentinel chain segment emitted for index access (`obj[expr]`) — a dynamic
 *  member that can't be resolved to a static name. Consumers that attribute
 *  chains to declared names treat this as "unknown member". */
export const INDEX_SEGMENT = "[*]";

function extractChain(node: CelNode, boundVars: ReadonlySet<string>): string[] | null {
  if (node.kind === "ident") {
    // An ABSOLUTE name (`.y`) resolves against the environment's declarations and never
    // against a name the expression bound, so a binding of the same spelling cannot hide it.
    if (!node.absolute && boundVars.has(node.name)) return null;
    return [node.name];
  }
  // **An OPTIONAL read ends the chain.** `a.?b` and `a[?0]` answer an `optional<T>`, so what
  // follows is a method on that optional (`.orValue('')`) rather than a member of the
  // context — and the author has said outright that the member may be absent, which is not a
  // claim a context schema has to declare. The engine makes both a real `select`/`index`
  // with `optional: true`, where the replaced engine had no node this walk could chain, so
  // continuing would both invent a read and hand `validateChainAgainstSchema` a path past
  // the point the expression stopped asserting anything.
  if (node.kind === "select") {
    if (node.optional) return null;
    const parent = extractChain(node.operand, boundVars);
    if (parent !== null) return [...parent, node.field];
  }
  if (node.kind === "index") {
    if (node.optional) return null;
    const parent = extractChain(node.operand, boundVars);
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
export function extractCallResultAccesses(node: CelNode): CallResultAccess[] {
  const out: CallResultAccess[] = [];
  visitAccess(node, out);
  return out;
}

function visitAccess(node: CelNode, out: CallResultAccess[]): void {
  if (node.kind === "select" || node.kind === "index") {
    const members: string[] = [];
    let base: CelNode = node;
    while (base.kind === "select" || base.kind === "index") {
      if (base.kind === "select") {
        members.unshift(base.field);
      } else {
        members.unshift(INDEX_SEGMENT);
        // The index is its own expression and may itself read off a call's result.
        visitAccess(base.index, out);
      }
      base = base.operand;
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
  for (const child of childNodes(node)) visitAccess(child, out);
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
  node: CelNode,
  contextSchema: Record<string, any>,
): string | null {
  const chain = dottedChain(node, new Set());
  if (chain === null) return null;
  return schemaIsNullable(schemaAtChain(chain.split("."), contextSchema)) ? chain : null;
}

function isNullLiteral(node: CelNode): boolean {
  return node.kind === "literal" && node.literal.type === "null";
}

/** Dotted form of a static member chain rooted at a free identifier, or null
 *  when the node isn't such a chain (call result, bound var, index, …). */
function dottedChain(node: CelNode, boundVars: Set<string>): string | null {
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
function deriveNarrowing(node: CelNode, boundVars: Set<string>): Narrowing {
  if (node.kind === "unary" && node.operator === "!") {
    const inner = deriveNarrowing(node.operand, boundVars);
    return { whenTrue: inner.whenFalse, whenFalse: inner.whenTrue };
  }
  if (node.kind !== "binary") return EMPTY_NARROWING;
  if (node.operator === "==" || node.operator === "!=") {
    const chain = isNullLiteral(node.right)
      ? dottedChain(node.left, boundVars)
      : isNullLiteral(node.left)
        ? dottedChain(node.right, boundVars)
        : null;
    if (chain === null) return EMPTY_NARROWING;
    const proven = new Set([chain]);
    return node.operator === "!="
      ? { whenTrue: proven, whenFalse: new Set() }
      : { whenTrue: new Set(), whenFalse: proven };
  }
  if (node.operator === "&&") {
    const left = deriveNarrowing(node.left, boundVars);
    const right = deriveNarrowing(node.right, boundVars);
    return { whenTrue: union(left.whenTrue, right.whenTrue), whenFalse: new Set() };
  }
  if (node.operator === "||") {
    const left = deriveNarrowing(node.left, boundVars);
    const right = deriveNarrowing(node.right, boundVars);
    return { whenTrue: new Set(), whenFalse: union(left.whenFalse, right.whenFalse) };
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
  node: CelNode,
  contextSchema: Record<string, any>,
): NullableIssue[] {
  const issues: NullableIssue[] = [];
  walkNullable(node, new Set(), new Set(), issues, contextSchema);
  return issues;
}

function walkNullable(
  node: CelNode,
  nonNull: Set<string>,
  boundVars: Set<string>,
  issues: NullableIssue[],
  schema: Record<string, any>,
): void {
  // Dereference of an object/array member — check the receiver's nullability.
  if (node.kind === "select" || node.kind === "index") {
    const objChain = dottedChain(node.operand, boundVars);
    if (objChain !== null && !nonNull.has(objChain)) {
      if (schemaIsNullable(schemaAtChain(objChain.split("."), schema))) {
        issues.push({
          path: objChain,
          member: node.kind === "select" ? node.field : "[index]",
        });
      }
    }
    walkNullable(node.operand, nonNull, boundVars, issues, schema);
    // The index expression (`obj[expr]`) is itself evaluated — descend so a nullable
    // deref used as an index (`items[error.code]`) is caught.
    if (node.kind === "index") walkNullable(node.index, nonNull, boundVars, issues, schema);
    return;
  }

  if (node.kind === "conditional") {
    walkNullable(node.condition, nonNull, boundVars, issues, schema);
    const narrowed = deriveNarrowing(node.condition, boundVars);
    walkNullable(node.whenTrue, union(nonNull, narrowed.whenTrue), boundVars, issues, schema);
    walkNullable(node.whenFalse, union(nonNull, narrowed.whenFalse), boundVars, issues, schema);
    return;
  }

  if (node.kind === "binary" && (node.operator === "&&" || node.operator === "||")) {
    walkNullable(node.left, nonNull, boundVars, issues, schema);
    const narrowed = deriveNarrowing(node.left, boundVars);
    const carried = node.operator === "&&" ? narrowed.whenTrue : narrowed.whenFalse;
    walkNullable(node.right, union(nonNull, carried), boundVars, issues, schema);
    return;
  }

  // A module call's receiver is a module name, not a value; mirror extractAccessChains so
  // it is never read as a nullable context field.
  const moduleCall = moduleCallOf(node);
  if (moduleCall) {
    for (const arg of moduleCall.args) walkNullable(arg, nonNull, boundVars, issues, schema);
    return;
  }

  // `cel.bind` binds a name for its body; mirror extractAccessChains so a bound name is
  // never read as a nullable context field.
  const bind = bindCall(node);
  if (bind) {
    walkNullable(bind.init, nonNull, boundVars, issues, schema);
    walkNullable(bind.body, nonNull, new Set(boundVars).add(bind.name), issues, schema);
    return;
  }

  // A comprehension binds a loop variable; mirror extractAccessChains so a bound var is
  // never mistaken for a nullable context field.
  const macro = comprehension(node);
  if (macro) {
    walkNullable(macro.receiver, nonNull, boundVars, issues, schema);
    const inner = new Set(boundVars).add(macro.bound);
    for (const arg of macro.scoped) walkNullable(arg, nonNull, inner, issues, schema);
    return;
  }

  for (const child of childNodes(node)) {
    walkNullable(child, nonNull, boundVars, issues, schema);
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
