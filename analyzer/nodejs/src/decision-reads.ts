/**
 * What a value decided before boot reads — an `!if`'s condition, a `!switch`'s
 * selector, an import binding feeding one — each name classified by the one
 * decidability rule: a module input read through one of the three projections
 * (its whole value, a member, or its presence) — or a name in the module's
 * `resources` record read through presence or a field's member, which only a
 * need makes decidable — a `module.<field>`, a module
 * function call (its arguments classified as reads of their own; a body sees
 * only its parameters, so the call reads nothing else), or an open read nothing
 * before boot can know. Whether an input read is a dimension is the module's
 * declaration's to say (`configuration-dimensions.ts`), and whether a call can
 * be evaluated before boot is its callee's (`choice-scope.ts`); this reads the
 * expression alone.
 *
 * Browser-safe.
 */
import { parseExpression } from "@telorun/cel";
import { wrapCelAst, type CelNode } from "./cel-ast.js";

/** The two module-input namespaces a projection reads. */
export type InputBlock = "variables" | "secrets";

/** What a projection reads: a module input, or a module's `resources` record —
 *  where only a need's presence and a member of one of its fields can be
 *  decided before boot. */
export type ReadBlock = InputBlock | "resources";

/** How a read reaches its input. */
export type Projection = "whole" | "member" | "presence";

/** An input read through one of the three projections. */
export interface InputRead {
  readonly input: ReadBlock;
  readonly name: string;
  readonly projection: Projection;
  /** For a `resources` read: the field whose member a `member` projection reads
   *  (`resources.databaseAccess.url.scheme`). */
  readonly field?: string;
  /** The member read, for a `member` projection. */
  readonly member?: string;
  /** The chain as written (`secrets.databaseUrl.scheme`). */
  readonly chain: string;
}

/** One name an expression reads, classified. */
export type DecisionRead =
  | { readonly class: "input"; readonly read: InputRead }
  | { readonly class: "module"; readonly field: string; readonly chain: string }
  /** A module function call (`Self.isProd(…)`), by its qualified name. */
  | { readonly class: "call"; readonly qualified: string }
  /** A read nothing before boot can know: a resource's published state, a
   *  port, a request, an input read past a projection. */
  | { readonly class: "open"; readonly chain: string };

export interface DecisionExpression {
  readonly source: string;
  readonly reads: readonly DecisionRead[];
  /** The engine's syntax refusal, when the text does not parse. */
  readonly parseError?: string;
}

const MACROS = new Set(["all", "exists", "exists_one", "map", "filter"]);
const INPUT_BLOCKS: ReadonlySet<string> = new Set(["variables", "secrets"]);
const RESOURCES = "resources";

/** Every name `source` reads, classified. */
export function readDecisionExpression(source: string): DecisionExpression {
  const parsed = parseExpression(source);
  const diagnostic = parsed.diagnostics[0];
  if (diagnostic) return { source, reads: [], parseError: diagnostic.message };
  const reads: DecisionRead[] = [];
  visit(wrapCelAst(parsed.root, 0), reads, new Set());
  return { source, reads };
}

/** The dotted chain a node names (`a.b.c`), or undefined. */
function chainOf(node: CelNode): string[] | undefined {
  if (node.kind === "ident") return [node.name];
  if (node.kind === "member" && !node.optional) {
    const parent = chainOf(node.target);
    return parent ? [...parent, node.property] : undefined;
  }
  return undefined;
}

function isNullLiteral(node: CelNode): boolean {
  return node.kind === "literal" && node.value === null;
}

function classifyChain(chain: readonly string[], bound: ReadonlySet<string>, reads: DecisionRead[]): void {
  const [root, ...rest] = chain;
  if (bound.has(root!)) return;
  const text = chain.join(".");
  if (INPUT_BLOCKS.has(root!)) {
    if (rest.length === 1) {
      reads.push({ class: "input", read: { input: root as InputBlock, name: rest[0]!, projection: "whole", chain: text } });
      return;
    }
    if (rest.length === 2) {
      reads.push({
        class: "input",
        read: { input: root as InputBlock, name: rest[0]!, projection: "member", member: rest[1]!, chain: text },
      });
      return;
    }
    reads.push({ class: "open", chain: text });
    return;
  }
  if (root === "module") {
    reads.push({ class: "module", field: rest[0] ?? "", chain: text });
    return;
  }
  // A member of a field of a resource the module names — decided only when the
  // name is a need (`resources.databaseAccess.url.scheme`).
  if (root === RESOURCES && rest.length === 3) {
    reads.push({
      class: "input",
      read: { input: RESOURCES, name: rest[0]!, projection: "member", field: rest[1]!, member: rest[2]!, chain: text },
    });
    return;
  }
  reads.push({ class: "open", chain: text });
}

/** A bare chain whose presence `== null` / `!= null` tests: a module input, or
 *  a name in the module's `resources` record. */
function isPresenceSubject(chain: readonly string[] | undefined, bound: ReadonlySet<string>): boolean {
  if (!chain || chain.length !== 2 || bound.has(chain[0]!)) return false;
  return INPUT_BLOCKS.has(chain[0]!) || chain[0] === RESOURCES;
}

function visit(node: CelNode, reads: DecisionRead[], bound: ReadonlySet<string>): void {
  const chain = chainOf(node);
  if (chain) {
    classifyChain(chain, bound, reads);
    return;
  }
  switch (node.kind) {
    case "literal":
      return;
    case "member":
    case "index": {
      // A read past an optional member or an index names no projection.
      const base = node.kind === "member" ? node.target : node.target;
      const baseChain = chainOf(base);
      if (baseChain && !bound.has(baseChain[0]!)) {
        reads.push({ class: "open", chain: `${baseChain.join(".")}${node.kind === "member" ? `.?${node.property}` : "[…]"}` });
      } else {
        visit(base, reads, bound);
      }
      if (node.kind === "index") visit(node.index, reads, bound);
      return;
    }
    case "binary": {
      // `<input> == null` / `!= null` is the presence projection.
      if (node.op === "==" || node.op === "!=") {
        const [subject, other] = isNullLiteral(node.right)
          ? [node.left, node.right]
          : isNullLiteral(node.left)
            ? [node.right, node.left]
            : [undefined, undefined];
        const subjectChain = subject ? chainOf(subject) : undefined;
        if (other && isPresenceSubject(subjectChain, bound)) {
          reads.push({
            class: "input",
            read: {
              input: subjectChain![0] as ReadBlock,
              name: subjectChain![1]!,
              projection: "presence",
              chain: subjectChain!.join("."),
            },
          });
          return;
        }
      }
      visit(node.left, reads, bound);
      visit(node.right, reads, bound);
      return;
    }
    case "unary":
      visit(node.operand, reads, bound);
      return;
    case "ternary":
      visit(node.cond, reads, bound);
      visit(node.then, reads, bound);
      visit(node.else, reads, bound);
      return;
    case "list":
      for (const item of node.items) visit(item, reads, bound);
      return;
    case "map":
      for (const entry of node.entries) {
        visit(entry.key, reads, bound);
        visit(entry.value, reads, bound);
      }
      return;
    case "call":
      for (const arg of node.args) visit(arg, reads, bound);
      return;
    case "methodCall": {
      const receiver = node.receiver;
      // `cel.bind(name, init, body)`: `name` is a local.
      if (receiver.kind === "ident" && receiver.name === "cel" && node.name === "bind" && node.args.length === 3) {
        const name = node.args[0]!;
        visit(node.args[1]!, reads, bound);
        visit(node.args[2]!, reads, name.kind === "ident" ? new Set([...bound, name.name]) : bound);
        return;
      }
      // A comprehension binds its first argument over the rest.
      if (MACROS.has(node.name) && node.args.length >= 2 && node.args[0]!.kind === "ident") {
        visit(receiver, reads, bound);
        const inner = new Set([...bound, (node.args[0] as { name: string }).name]);
        for (const arg of node.args.slice(1)) visit(arg, reads, inner);
        return;
      }
      // A call on a bare identifier that is no value names a module function.
      if (receiver.kind === "ident" && !bound.has(receiver.name) && !INPUT_BLOCKS.has(receiver.name) && receiver.name !== "module") {
        reads.push({ class: "call", qualified: `${receiver.name}.${node.name}` });
        for (const arg of node.args) visit(arg, reads, bound);
        return;
      }
      visit(receiver, reads, bound);
      for (const arg of node.args) visit(arg, reads, bound);
      return;
    }
    case "ident":
      return;
  }
}
