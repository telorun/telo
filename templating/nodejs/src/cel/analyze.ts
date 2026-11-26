import {
  childNodes,
  namespaceMacroBinding,
  RESERVED_NAMESPACES,
  receiverMacroBinding,
  type CelNode,
} from "@telorun/cel";
import { isLiveSlot, membersOf } from "@telorun/sdk";
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

function onReservedNamespace(node: CelNode): node is Extract<CelNode, { kind: "receiverCall" }> {
  return node.kind === "receiverCall" && node.receiver.kind === "ident" && RESERVED_NAMESPACES.includes(node.receiver.name);
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

  // A call on a reserved namespace (`optional.of(x)`) names a function, never a
  // value: its receiver is no read.
  if (onReservedNamespace(node)) {
    for (const arg of node.args) visitNode(arg, chains, boundVars, onModuleCall);
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

/** The dotted form of a static member chain rooted at a free identifier, or
 *  null when the node is no such chain (a call result, an index, …). */
export function plainDottedChain(node: CelNode): string | null {
  const chain = extractChain(node, new Set());
  if (chain === null || chain.includes(INDEX_SEGMENT)) return null;
  return chain.join(".");
}

/** The chain a member read's operand is, its segments joined as a chain is
 *  written in a finding (`items.[*].amount`), or null where it is not one. A
 *  module call's result is written as the call (`Billing.total(…)`). */
export function memberReadPath(node: CelNode): string | null {
  const call = moduleCallOf(node);
  if (call) return `${call.qualified}(…)`;
  if (node.kind === "ident") return node.name;
  if ((node.kind === "select" || node.kind === "index") && !node.optional) {
    const parent = memberReadPath(node.operand);
    if (parent === null) return null;
    return `${parent}.${node.kind === "select" ? node.field : INDEX_SEGMENT}`;
  }
  return null;
}

/** Chain segment for "each element of the collection reached so far": what a
 *  comprehension's iteration variable stands for. */
export const EACH_SEGMENT = "[]";

/** Chain segment for "whether the member exists": the last segment of a chain a
 *  presence test (`has(a.b)`) reads, which depends on the KEYS of what the chain
 *  before it reaches and on none of its values. */
export const PRESENCE_SEGMENT = "?";

/** Chain segment for "each element of the range, read whole", after
 *  {@link EACH_SEGMENT}: a bare use of the iteration variable, or the range of an
 *  `in` test. Over a list it reads every element; over a map it reads only the
 *  KEYS, because a comprehension's variable and an `in` test stand for a key
 *  there, so no value of the map is read. Which of the two a range is, is known
 *  only to the reader holding the data. */
export const ELEMENT_SEGMENT = "[]!";

/**
 * What an expression READS of the values its roots name, as member chains —
 * {@link extractAccessChains} with a comprehension's iteration variable followed
 * instead of dropped.
 *
 * - A member read through the variable is a read of THAT member on each element
 *   of the range: `xs.all(x, x.path != "")` reads `xs.[].path`.
 * - A range that is only iterated is read as a range — its own node, none of
 *   its elements: the chain ends in {@link EACH_SEGMENT}.
 * - A bare use of the variable reads the element whole, so the range is read
 *   whole, as it is by any other use of the collection.
 * - A `cel.bind` name is followed to the value it binds: `cel.bind(t,
 *   self.table, t.size)` reads `self.table.size`, and a bare use reads the
 *   bound value whole.
 * - A presence test reads only whether the member exists: `has(a.b)` reads
 *   `a.b.?` ({@link PRESENCE_SEGMENT}), never the value of `a.b`.
 *
 * A variable whose range is not a plain chain (a call's result, another macro's
 * output) names nothing a root holds, and a read through it contributes nothing.
 */
export function extractReadChains(node: CelNode): string[][] {
  const chains: string[][] = [];
  visitReads(node, chains, new Map(), false);
  return chains;
}

/**
 * {@link extractReadChains} told apart by what a range holds: a bare use of an
 * iteration variable and the range of an `in` test read `<range>.[].[]!`
 * ({@link ELEMENT_SEGMENT}) — each element whole over a list, and over a map
 * nothing but its keys — where {@link extractReadChains} reads the range whole.
 * The one question it answers is which VALUES an expression reads, which a
 * caller holding the data answers per range: a rule iterating a map's keys must
 * not be taken for one reading its values.
 */
export function extractValueReadChains(node: CelNode): string[][] {
  const chains: string[][] = [];
  visitReads(node, chains, new Map(), true);
  return chains;
}

/** What a bound name stands for as a chain — each element of a range, or the
 *  value a `cel.bind` binds — or null where it has none. */
type BoundRanges = ReadonlyMap<string, BoundRange | null>;

interface BoundRange {
  readonly chain: readonly string[];
  readonly each: boolean;
  /** Whether anything read through the name. */
  used: boolean;
}

function readChainOf(node: CelNode, bound: BoundRanges): string[] | null {
  if (node.kind === "ident") {
    if (!node.absolute && bound.has(node.name)) {
      const range = bound.get(node.name);
      if (!range) return null;
      range.used = true;
      return range.each ? [...range.chain, EACH_SEGMENT] : [...range.chain];
    }
    return [node.name];
  }
  if (node.kind === "select") {
    if (node.optional) return null;
    const parent = readChainOf(node.operand, bound);
    if (parent !== null) return [...parent, node.field];
  }
  if (node.kind === "index") {
    if (node.optional) return null;
    const parent = readChainOf(node.operand, bound);
    if (parent !== null) return [...parent, INDEX_SEGMENT];
  }
  return null;
}

function visitReads(node: CelNode, chains: string[][], bound: BoundRanges, valueReads: boolean): void {
  const chain = readChainOf(node, bound);
  if (chain !== null) {
    // The variable itself, with no member read off it: the whole element.
    if (chain[chain.length - 1] === EACH_SEGMENT) {
      chains.push(valueReads ? [...chain, ELEMENT_SEGMENT] : chain.slice(0, -1));
    } else {
      chains.push(chain);
    }
    return;
  }

  if (valueReads && node.kind === "binary" && node.operator === "in") {
    // `k in m` tests a key of a map and an element of a list.
    const range = readChainOf(node.right, bound);
    if (range !== null && range[range.length - 1] !== EACH_SEGMENT) {
      chains.push([...range, EACH_SEGMENT, ELEMENT_SEGMENT]);
      visitReads(node.left, chains, bound, valueReads);
      return;
    }
  }

  const presence = presenceOperand(node);
  if (presence) {
    const owner = readChainOf(presence.operand, bound);
    if (owner !== null) {
      chains.push([...owner, presence.field, PRESENCE_SEGMENT]);
      return;
    }
  }

  const moduleCall = moduleCallOf(node);
  if (moduleCall) {
    for (const arg of moduleCall.args) visitReads(arg, chains, bound, valueReads);
    return;
  }

  const bind = bindCall(node);
  if (bind) {
    // A plain chain is read through the name it binds, and whole where nothing
    // reads through it: the value is still evaluated.
    const value = readChainOf(bind.init, bound);
    if (value === null) visitReads(bind.init, chains, bound, valueReads);
    const range: BoundRange | null = value && { chain: value, each: false, used: false };
    visitReads(bind.body, chains, new Map(bound).set(bind.name, range), valueReads);
    if (range && !range.used) chains.push(value!);
    return;
  }

  const macro = comprehension(node);
  if (macro) {
    const range = readChainOf(macro.receiver, bound);
    if (range !== null) chains.push([...range, EACH_SEGMENT]);
    else visitReads(macro.receiver, chains, bound, valueReads);
    const inner = new Map(bound).set(macro.bound, range && { chain: range, each: true, used: false });
    for (const arg of macro.scoped) visitReads(arg, chains, inner, valueReads);
    return;
  }

  for (const child of childNodes(node)) visitReads(child, chains, bound, valueReads);
}

/** A presence test `has(<operand>.<field>)`: what it asks the keys of, and the member. */
function presenceOperand(node: CelNode): { operand: CelNode; field: string } | undefined {
  if (node.kind !== "call" || node.name !== "has" || node.args.length !== 1) return undefined;
  const arg = node.args[0]!;
  return arg.kind === "select" && !arg.optional ? { operand: arg.operand, field: arg.field } : undefined;
}

/**
 * Check whether a member-access chain accesses only fields declared in a JSON Schema.
 * Returns an error string if a field is unknown in a schema that declares explicit
 * properties without `additionalProperties: true`, or if the chain attempts to
 * reach inside a `live` value type — one whose consumption has effects, so its
 * contents exist only for a consumer that drains it.
 * Returns null when the chain is valid or the schema is too open to judge.
 *
 * A node is read with its `allOf` conjuncts ({@link schemaConjuncts}), and a
 * document-local `$ref` (`#…`) is followed against the nearest node on the walk
 * that holds its target — the innermost document a contract embedded whole
 * carries its reached types in. A union (`anyOf` / `oneOf`) is read in every
 * alternative: one that cannot hold an object (a null or scalar type, a value
 * type with no members) or a closed object not declaring the member contributes
 * nothing, and the chain continues through every alternative declaring it. A
 * member is unknown only when every alternative is read and none declares it
 * nor is open; an alternative, conjunct or reference that cannot be read leaves
 * the chain unjudged.
 */
export function validateChainAgainstSchema(
  chain: string[],
  schema: Record<string, any>,
): string | null {
  return chainFailureAgainstSchema(chain, schema)?.message ?? null;
}

/** {@link validateChainAgainstSchema}, with the path of the read that failed. */
function chainFailureAgainstSchema(
  chain: string[],
  schema: Record<string, any>,
): { path: string; message: string } | null {
  const walked: Record<string, any>[] = [];
  let current: Record<string, any>[] = [schema];
  for (let i = 0; i < chain.length; i++) {
    const key = chain[i]!;
    const alternatives = alternativesOf(
      current,
      walked,
      key === INDEX_SEGMENT ? holdsCollection : holdsObject,
    );
    if (!alternatives || alternatives.length === 0) return null;
    walked.push(...alternatives);
    // An index reads an ELEMENT: an array's `items`, or a map's value schema. What
    // is below it is checked like any member access, which is what reaches a
    // typo inside a list of records (`items[0].amont`). An object that also
    // declares `properties` may be indexed by one of those names, which the
    // chain does not record, so nothing below it is judged.
    if (key === INDEX_SEGMENT) {
      const elements: Record<string, any>[] = [];
      for (const alternative of alternatives) {
        const element =
          alternative.items && typeof alternative.items === "object" && !Array.isArray(alternative.items)
            ? alternative.items
            : !alternative.properties &&
                alternative.additionalProperties &&
                typeof alternative.additionalProperties === "object"
              ? alternative.additionalProperties
              : undefined;
        if (!element) return null;
        elements.push(element);
      }
      current = elements;
      continue;
    }
    const found: Record<string, any>[] = [];
    let declares = false;
    const available: string[] = [];
    for (const alternative of alternatives) {
      const conjuncts = schemaConjuncts(
        alternative,
        (node) => node,
        (_, raw) => followLocalRef(raw as Record<string, any>, walked),
      );
      if (!conjuncts) return null;
      let declared: Record<string, any> | undefined;
      let groupDeclares = false;
      for (const conjunct of conjuncts) {
        // A value type declaring members is read by those members alone: they are
        // its fields, closed as the CEL type the type registers.
        const members = membersOf(conjunct);
        const props: Record<string, any> | undefined = members ?? conjunct.properties;
        if (!props) continue;
        groupDeclares = true;
        if (key in props) {
          declared = props[key];
          break;
        }
        if (!members && conjunct.additionalProperties === true) return null;
        for (const name of Object.keys(props)) if (!available.includes(name)) available.push(name);
      }
      // An alternative saying nothing about its members could hold this one.
      if (!groupDeclares) return null;
      declares = true;
      if (declared !== undefined) found.push(declared);
    }
    if (found.length > 0) {
      if (i < chain.length - 1 && found.some((node) => isLiveSlot(node))) {
        const path = chain.slice(0, i + 1).join(".");
        return {
          path,
          message: `'${path}' is a Telo.Stream, which holds no members: hand it to a step that consumes a stream and read that step's result`,
        };
      }
      current = found;
      continue;
    }
    if (!declares) return null;
    const path = chain.slice(0, i + 1).join(".");
    return {
      path,
      message: `'${path}' is not defined (available: ${available.length > 0 ? available.join(", ") : "none"})`,
    };
  }
  return null;
}

/**
 * The alternatives a value at `nodes` may be read through: each node with its
 * references followed and every union split into its branches, recursively,
 * keeping only those `holds` accepts — what can hold the member or element the
 * chain reads next. Undefined when a reference cannot be read.
 */
function alternativesOf(
  nodes: readonly Record<string, any>[],
  walked: readonly Record<string, any>[],
  holds: (node: Record<string, any>) => boolean,
): Record<string, any>[] | undefined {
  const out: Record<string, any>[] = [];
  const visit = (raw: Record<string, any>, depth: number): boolean => {
    if (depth > 32) return false;
    const node = followLocalRef(raw, [...walked, ...out]);
    if (!node || typeof node !== "object") return false;
    const branches = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined;
    if (branches && !node.properties && !node.allOf) {
      for (const branch of branches as Record<string, any>[]) {
        if (!branch || typeof branch !== "object" || !visit(branch, depth + 1)) return false;
      }
      return true;
    }
    if (holds(node)) out.push(node);
    return true;
  };
  for (const node of nodes) if (!visit(node, 0)) return undefined;
  return out;
}

/** Whether a value at `node` can be a list or a map a chain indexes into. */
function holdsCollection(node: Record<string, any>): boolean {
  if (node["x-telo-type"] !== undefined) return false;
  const types = Array.isArray(node.type) ? node.type : node.type === undefined ? undefined : [node.type];
  return !types || types.includes("array") || types.includes("object");
}

/** Whether a value at `node` can be an object whose members a chain reads: a
 *  node typed as no object (null, a scalar, a list) or a value type with no
 *  members cannot. */
function holdsObject(node: Record<string, any>): boolean {
  if (membersOf(node)) return true;
  if (node["x-telo-type"] !== undefined) return false;
  const types = Array.isArray(node.type) ? node.type : node.type === undefined ? undefined : [node.type];
  if (types && !types.includes("object")) return false;
  if ("const" in node && (node.const === null || typeof node.const !== "object")) return false;
  return true;
}

/**
 * A schema node and each of its `allOf` members, recursively — or undefined when
 * a member cannot be read, which leaves the node unjudged. `schemaOf` reads the
 * schema off whatever the caller carries per node (a node alone, or a node with
 * the document its references resolve against), and `member` reads one written
 * member in its parent's context, following its references.
 *
 * Shared by every walk reading a node as the conjunction it is — the CEL chain
 * check and the analyzer's plain-literal decoding.
 */
export function schemaConjuncts<N>(
  node: N,
  schemaOf: (node: N) => Record<string, any>,
  member: (parent: N, raw: unknown) => N | undefined,
): N[] | undefined {
  const out = [node];
  const all = schemaOf(node).allOf;
  if (!Array.isArray(all)) return out;
  for (const raw of all as unknown[]) {
    const read = member(node, raw);
    if (read === undefined) return undefined;
    const nested = schemaConjuncts(read, schemaOf, member);
    if (!nested) return undefined;
    out.push(...nested);
  }
  return out;
}

/** `node` with every document-local `$ref` it is followed through, resolved
 *  against the nearest node of `walked` holding the target. A reference that is
 *  not local, or whose target no walked node holds, yields undefined. */
function followLocalRef(
  node: Record<string, any> | undefined,
  walked: readonly Record<string, any>[],
): Record<string, any> | undefined {
  const seen = new Set<object>();
  let current = node;
  while (current && typeof current === "object" && typeof current.$ref === "string") {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const ref = current.$ref as string;
    if (!ref.startsWith("#")) return undefined;
    let target: Record<string, any> | undefined;
    for (let i = walked.length - 1; i >= 0 && target === undefined; i--) {
      target = schemaAtPointer(walked[i]!, ref.slice(1));
    }
    current = target;
  }
  return current;
}

/** The node a JSON Pointer (the part of a reference after `#`) names in `root`. */
function schemaAtPointer(root: Record<string, any>, pointer: string): Record<string, any> | undefined {
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) return undefined;
  let current: unknown = root;
  for (const raw of pointer.slice(1).split("/")) {
    const segment = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current && typeof current === "object" && !Array.isArray(current)
    ? (current as Record<string, any>)
    : undefined;
}
