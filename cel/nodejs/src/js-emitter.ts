/**
 * The JavaScript emitter: a tree compiled to **source**, not to closures.
 *
 * It decides nothing the closure backend decides differently. Every operator and standard
 * function is the runtime library's, every comprehension is `comprehension-runtime.ts`, and
 * every member read, name read, bool operand and call-site dispatch is `backend-runtime.ts`
 * — so what this file produces is a tree of CALLS into those, in the same order, with the
 * same short-circuit. That is why the two backends can be held to one answer case for case:
 * the only thing that differs is how control gets from one call to the next.
 *
 * Three properties the shape of the output exists for:
 *
 * - **The runtime is a parameter, never an import.** The emitted module's default export is
 *   a factory; it names no specifier, so it loads from a `data:` URL, from a cache directory
 *   mounted anywhere, and under a host that resolves nothing. A module naming
 *   `@telorun/cel` would also silently accept a runtime of another version, which the cache
 *   key could not see.
 * - **No bare property access implements a CEL read.** `a.b`, `a['b']`, `a[expr]`, `.?`,
 *   `[?]` and `has()` all emit a call to the member-read seam, so no key an author or a
 *   request wrote reaches a prototype, a method or a function property. The frame's own
 *   fields are the engine's structure and are read directly, as they are in a closure.
 * - **Nothing is asynchronous.** No `async`, no `await`, no promise: a thenable is refused
 *   at the same doors, because the doors are the shared runtime's.
 *
 * Emission is **deterministic**: temporaries are numbered per emitted function in tree
 * order, bindings per module in tree order, and every hoisted constant is keyed by its own
 * text, so the same tree against the same environment is the same bytes.
 */

import {
  CelCompileError,
  plainMemberChain,
  prefixCandidates,
  type CompileTarget,
} from "./backend-runtime.js";
import { namespaceMacroBinding, receiverMacroBinding } from "./comprehension-bindings.js";
import { splitDeclaredChain } from "./declared-chain.js";
import { isMacroCall } from "./macro-check.js";
import { CALL_SITE_DIRECT_ARITY } from "./runtime-library.js";
import type { CelLiteral, CelNode, CelSelectNode, SourceRange } from "./syntax-tree.js";

/**
 * The names an emitted module destructures from the runtime it is handed, in the order it
 * destructures them. It is the module's whole contract with the engine: `emitterRuntime`
 * (`emitted-module.ts`) builds an object with exactly these keys, and a module emitted by
 * one engine against another's runtime fails at load rather than running on a missing
 * binding — which is the second reason the key carries the engine version.
 */
export const RUNTIME_BINDINGS = [
  "asyncValueRefused",
  "boolOperand",
  "callSite",
  "celAll",
  "celError",
  "celExists",
  "celExistsOne",
  "celFilter",
  "celIterable",
  "celMapComprehension",
  "celMapFromEntries",
  "celSome",
  "celUint",
  "constants",
  "hasMember",
  "isCelError",
  "isCelOptional",
  "none",
  "optionalEntry",
  "optionalOfNonZero",
  "readHostValue",
  "readName",
  "readNameChain",
  "readThrough",
  "searchNameChain",
] as const;

export type RuntimeBinding = (typeof RUNTIME_BINDINGS)[number];

/** A name a macro bound, and the JavaScript name its value lives under. */
interface Scope {
  readonly name: string;
  readonly js: string;
  readonly outer: Scope | undefined;
}

function boundName(scope: Scope | undefined, name: string): string | undefined {
  for (let at = scope; at; at = at.outer) if (at.name === name) return at.js;
  return undefined;
}

/**
 * The temporaries one emitted function declares. Each emitted function — the expression's
 * own, and every comprehension or binding body inside it — declares its own, because a
 * body's closure outlives the statement that called it and a name it shares with its caller
 * would clobber a value still in use.
 *
 * **Every name is unique across the MODULE, not within the function**, and that is not
 * tidiness: a body declaring `let t0` would **shadow** the `t0` its caller holds a bound
 * value in, so `cel.bind(n, 2, xs.map(e, e + n))` read the element where it meant the
 * binding and answered `[2, 4, 6]` for `[3, 4, 5]`. Numbering per module makes the shape
 * impossible rather than avoided.
 */
class Temporaries {
  private readonly names: string[] = [];

  constructor(private readonly allocate: () => string) {}

  next(): string {
    const name = this.allocate();
    this.names.push(name);
    return name;
  }

  /** The `let` that declares them, or nothing where the function used none. */
  declaration(): string {
    return this.names.length === 0 ? "" : `let ${this.names.join(", ")}; `;
  }
}

/**
 * One module's worth of emission. The hoist table is shared by every expression in the
 * module, so two expressions reading the same name share one range and one rest-list: a
 * constant allocated per evaluation is the cost the closure backend does not pay, and
 * hoisting is how the emitter does not pay it either.
 */
export class ModuleEmitter {
  private readonly hoisted: string[] = [];
  private readonly hoistedByText = new Map<string, string>();
  private locals = 0;
  private bindings = 0;

  constructor(private readonly target: CompileTarget) {}

  /** The source of one expression's function: a `CelStep` over the evaluation frame. */
  emitFunction(root: CelNode): string {
    const temporaries = this.temporaries();
    const body = this.node(root, undefined, temporaries);
    return `(frame) => { ${temporaries.declaration()}return ${body}; }`;
  }

  /** A fresh function's temporaries, drawing names from the module's own numbering. */
  private temporaries(): Temporaries {
    return new Temporaries(() => {
      const name = `t${this.locals}`;
      this.locals += 1;
      return name;
    });
  }

  /** The `const` lines every emitted expression reads, in first-use order. */
  hoistedLines(): readonly string[] {
    return this.hoisted;
  }

  private hoist(text: string): string {
    const held = this.hoistedByText.get(text);
    if (held !== undefined) return held;
    const name = `h${this.hoisted.length}`;
    this.hoisted.push(`const ${name} = ${text};`);
    this.hoistedByText.set(text, name);
    return name;
  }

  private range(range: SourceRange): string {
    return this.hoist(`[${range[0]}, ${range[1]}]`);
  }

  /**
   * The name a comprehension's element is bound to: a **parameter** of the body function,
   * numbered per module so a nested body can never shadow the one around it.
   */
  private elementName(): string {
    const name = `b${this.bindings}`;
    this.bindings += 1;
    return name;
  }

  // --- the tree -----------------------------------------------------------

  private node(node: CelNode, scope: Scope | undefined, fn: Temporaries): string {
    switch (node.kind) {
      case "literal":
        return this.literal(node.literal);
      case "ident":
        return this.ident(node, scope);
      case "list":
        return this.list(node, scope, fn);
      case "map":
        return this.map(node, scope, fn);
      case "select":
        return this.select(node, scope, fn);
      case "index":
        return this.index(node, scope, fn);
      case "unary":
        return this.call(node.operator, "global", [this.node(node.operand, scope, fn)], node.range, fn);
      case "binary":
        return this.binary(node, scope, fn);
      case "conditional":
        return this.conditional(node, scope, fn);
      case "call":
      case "receiverCall":
        return this.anyCall(node, scope, fn);
      case "qcall":
        return this.qualifiedCall(node, scope, fn);
      case "unparsed":
        throw new CelCompileError("the expression could not be read whole, so it cannot be compiled");
    }
  }

  /**
   * A literal as the source that builds its value. A plain value is written inline; a uint
   * and a bytes literal are **hoisted**, because each is an object and allocating one per
   * evaluation would be work the closure backend does once at compile time.
   */
  private literal(literal: CelLiteral): string {
    switch (literal.type) {
      case "int":
        return integerSource(literal.value);
      case "uint":
        return this.hoist(`celUint(${integerSource(literal.value)})`);
      case "double":
        return doubleSource(literal.value);
      case "string":
        return textSource(literal.value);
      case "bytes":
        return this.hoist(`new Uint8Array([${[...literal.value].join(", ")}])`);
      case "bool":
        return literal.value ? "true" : "false";
      case "null":
        return "null";
    }
  }

  // --- names --------------------------------------------------------------

  private ident(node: Extract<CelNode, { kind: "ident" }>, scope: Scope | undefined): string {
    if (!node.absolute) {
      const held = boundName(scope, node.name);
      if (held !== undefined) return held;
    }
    return `readName(frame.activation, constants, ${textSource(node.name)}, ${this.range(node.range)})`;
  }

  /**
   * A chain of plain member names rooted at a free name. The split over the names the host
   * declared happens **here, at emit time**, through the same function the checker and the
   * closure backend split it with — so the emitted code performs one activation read and
   * then member reads, and can never read a different name than the one the check typed.
   */
  private chain(segments: readonly string[], range: SourceRange): string {
    const declaredSplit = splitDeclaredChain(segments, this.target.declares);
    const at = this.range(range);
    if (declaredSplit) {
      const rest = this.hoist(`[${declaredSplit.rest.map(textSource).join(", ")}]`);
      return `readNameChain(frame.activation, constants, ${textSource(declaredSplit.name)}, ${rest}, ${at})`;
    }
    // Nothing declares a prefix, so the activation is searched longest prefix first — the
    // same fallback, over the same candidate list, that the closure backend builds.
    const candidates = this.hoist(
      `[${prefixCandidates(segments)
        .map(
          (candidate) =>
            `{ name: ${textSource(candidate.name)}, rest: [${candidate.rest.map(textSource).join(", ")}] }`,
        )
        .join(", ")}]`,
    );
    return `searchNameChain(frame.activation, constants, ${candidates}, ${textSource(segments.join("."))}, ${at})`;
  }

  // --- member reads -------------------------------------------------------

  private select(node: CelSelectNode, scope: Scope | undefined, fn: Temporaries): string {
    const chain = plainMemberChain(node, (name) => boundName(scope, name) !== undefined);
    if (chain) return this.chain(chain, node.range);
    const operand = this.node(node.operand, scope, fn);
    const at = this.range(node.range);
    return this.carrying(
      [operand],
      fn,
      ([held]) => `readThrough(${held}, ${textSource(node.field)}, ${node.optional}, ${at})`,
    );
  }

  private index(
    node: Extract<CelNode, { kind: "index" }>,
    scope: Scope | undefined,
    fn: Temporaries,
  ): string {
    const operand = this.node(node.operand, scope, fn);
    const key = this.node(node.index, scope, fn);
    const at = this.range(node.range);
    return this.carrying(
      [operand, key],
      fn,
      ([held, named]) => `readThrough(${held}, ${named}, ${node.optional}, ${at})`,
    );
  }

  // --- aggregates ---------------------------------------------------------

  private list(
    node: Extract<CelNode, { kind: "list" }>,
    scope: Scope | undefined,
    fn: Temporaries,
  ): string {
    const out = fn.next();
    const at = this.range(node.range);
    const entries = node.elements.map((element) => ({
      value: this.node(element.value, scope, fn),
      optional: element.optional,
    }));
    let body = out;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      const value = fn.next();
      if (!entry.optional) {
        body = `(${value} = ${entry.value}, isCelError(${value}) ? ${value} : (${out}.push(${value}), ${body}))`;
        continue;
      }
      // An absent optional entry leaves no element: the aggregate shrinks, which is the
      // whole reason to write one.
      const held = fn.next();
      body =
        `(${value} = ${entry.value}, isCelError(${value}) ? ${value} : ` +
        `(${held} = optionalEntry(${value}, ${at}), isCelError(${held}) ? ${held} : ` +
        `(${held}.present && ${out}.push(${held}.held), ${body})))`;
    }
    return `(${out} = [], ${body})`;
  }

  private map(
    node: Extract<CelNode, { kind: "map" }>,
    scope: Scope | undefined,
    fn: Temporaries,
  ): string {
    const out = fn.next();
    const at = this.range(node.range);
    const entries = node.entries.map((entry) => ({
      key: this.node(entry.key, scope, fn),
      value: this.node(entry.value, scope, fn),
      optional: entry.optional,
    }));
    let body = `celMapFromEntries(${out}, ${at})`;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      const key = fn.next();
      const value = fn.next();
      const kept = entry.optional ? fn.next() : undefined;
      const written = kept
        ? `(${kept} = optionalEntry(${value}, ${at}), isCelError(${kept}) ? ${kept} : ` +
          `(${kept}.present && ${out}.push(${key}, ${kept}.held), ${body}))`
        : `(${out}.push(${key}, ${value}), ${body})`;
      body =
        `(${key} = ${entry.key}, isCelError(${key}) ? ${key} : ` +
        `(${value} = ${entry.value}, isCelError(${value}) ? ${value} : ${written}))`;
    }
    return `(${out} = [], ${body})`;
  }

  // --- operators ----------------------------------------------------------

  /**
   * `&&` and `||` carry an error-valued operand through: `false && <error>` is `false` and
   * `true || <error>` is `true`, whichever side the error is on. The emitted form is the
   * closure backend's branch order written out, so an error on one side and a non-bool on
   * the other decide the same way.
   */
  private binary(
    node: Extract<CelNode, { kind: "binary" }>,
    scope: Scope | undefined,
    fn: Temporaries,
  ): string {
    if (node.operator !== "&&" && node.operator !== "||") {
      return this.call(
        node.operator,
        "global",
        [this.node(node.left, scope, fn), this.node(node.right, scope, fn)],
        node.range,
        fn,
      );
    }
    const left = this.node(node.left, scope, fn);
    const right = this.node(node.right, scope, fn);
    const at = this.range(node.range);
    const decided = node.operator === "&&" ? "false" : "true";
    const undecided = node.operator === "&&" ? "true" : "false";
    const a = fn.next();
    const b = fn.next();
    return (
      `(${a} = boolOperand(${left}, ${at}), ${a} === ${decided} ? ${decided} : ` +
      `(${b} = boolOperand(${right}, ${at}), ${b} === ${decided} ? ${decided} : ` +
      `isCelError(${a}) ? ${a} : isCelError(${b}) ? ${b} : ${undecided}))`
    );
  }

  private conditional(
    node: Extract<CelNode, { kind: "conditional" }>,
    scope: Scope | undefined,
    fn: Temporaries,
  ): string {
    const condition = this.node(node.condition, scope, fn);
    const whenTrue = this.node(node.whenTrue, scope, fn);
    const whenFalse = this.node(node.whenFalse, scope, fn);
    const at = this.range(node.range);
    const held = fn.next();
    return (
      `(${held} = boolOperand(${condition}, ${at}), isCelError(${held}) ? ${held} : ` +
      `${held} ? ${whenTrue} : ${whenFalse})`
    );
  }

  // --- calls --------------------------------------------------------------

  private anyCall(
    node: Extract<CelNode, { kind: "call" | "receiverCall" }>,
    scope: Scope | undefined,
    fn: Temporaries,
  ): string {
    // The same question the checker asks, in the same place: a macro is not a function, and
    // it is recognised before any overload is looked for.
    if (isMacroCall(node)) return this.macro(node, scope, fn);
    const args = [
      ...(node.kind === "receiverCall" ? [this.node(node.receiver, scope, fn)] : []),
      ...node.args.map((argument) => this.node(argument, scope, fn)),
    ];
    return this.call(node.name, node.kind === "call" ? "global" : "receiver", args, node.range, fn);
  }

  /**
   * One dispatch: evaluate the arguments, carry the first error out, then hand the values to
   * the site **positionally**. The site is hoisted, so it is built once per loaded module and
   * holds the overloads it resolved — exactly as a compiled closure's does. The arity is the
   * dispatch key's, so the entry point is chosen here and no argument array is built.
   */
  private call(
    name: string,
    form: "global" | "receiver",
    args: readonly string[],
    range: SourceRange,
    fn: Temporaries,
  ): string {
    const site = this.hoist(
      `callSite(${textSource(name)}, ${textSource(form)}, ${this.range(range)})`,
    );
    // A call written wider than the bound takes the array form — the arity is the SOURCE's,
    // so a width no signature can declare is still something an author may write.
    return this.carrying(args, fn, (values) =>
      values.length <= CALL_SITE_DIRECT_ARITY
        ? `${site}.call${values.length}(${values.join(", ")})`
        : `${site}.call([${values.join(", ")}])`,
    );
  }

  private qualifiedCall(
    node: Extract<CelNode, { kind: "qcall" }>,
    scope: Scope | undefined,
    fn: Temporaries,
  ): string {
    const args = node.args.map((argument) => this.node(argument, scope, fn));
    const at = this.range(node.range);
    const context = this.hoist(`{ range: ${at} }`);
    const bound = fn.next();
    // The arguments are evaluated only once something IS bound, which is the closure
    // backend's order: a call nothing bound is `unbound_function` even where an argument
    // would have failed.
    const dispatched = this.carrying(
      args,
      fn,
      (values) => `readHostValue(${bound}([${values.join(", ")}], ${context}), ${at})`,
    );
    const refusal = `celError("unbound_function", ${textSource(
      `unbound function '${node.namespace}.${node.name}' — nothing is bound under that name here`,
    )}, ${at})`;
    return (
      `(${bound} = frame.namespaceFunction ? frame.namespaceFunction(${textSource(node.namespace)}, ` +
      `${textSource(node.name)}) : undefined, !${bound} ? ${refusal} : ${dispatched})`
    );
  }

  // --- macros -------------------------------------------------------------

  private macro(
    node: Extract<CelNode, { kind: "call" | "receiverCall" }>,
    scope: Scope | undefined,
    fn: Temporaries,
  ): string {
    if (node.kind === "call") return this.has(node, scope, fn);
    const receiver = node.receiver;
    if (receiver.kind === "ident" && receiver.name === "cel" && node.name === "bind") {
      return this.celBind(node, scope, fn);
    }
    if (receiver.kind === "ident" && receiver.name === "optional") {
      return this.optionalNamespace(node, scope, fn);
    }
    if ((node.name === "optMap" || node.name === "optFlatMap") && node.args.length === 2) {
      return this.optionalBinding(node, scope, fn);
    }
    return this.comprehension(node, scope, fn);
  }

  /** `has(a.b)` — presence, which a missing key answers `false` rather than erroring. */
  private has(
    node: Extract<CelNode, { kind: "call" }>,
    scope: Scope | undefined,
    fn: Temporaries,
  ): string {
    const argument = node.args[0]!;
    if (argument.kind !== "select") {
      throw new CelCompileError("has() asks about a member, so its argument ends in a select");
    }
    const operand = this.node(argument.operand, scope, fn);
    const at = this.range(node.range);
    return this.carrying(
      [operand],
      fn,
      ([held]) => `hasMember(${held}, ${textSource(argument.field)}, ${at})`,
    );
  }

  private celBind(
    node: Extract<CelNode, { kind: "receiverCall" }>,
    scope: Scope | undefined,
    fn: Temporaries,
  ): string {
    const binding = namespaceMacroBinding("cel", node.name, node.args.length);
    if (!binding) {
      throw new CelCompileError("cel.bind(name, value, body) takes a name, its value and a body");
    }
    const name = node.args[binding.variableArgument]!;
    if (name.kind !== "ident") throw new CelCompileError("cel.bind binds a name");
    const value = this.node(node.args[1]!, scope, fn);
    // The bound value lives in a temporary of the enclosing function, so it is DECLARED
    // there: a body nested inside this one captures it as a closure captures any `let`.
    const held = fn.next();
    const body = this.node(node.args[2]!, { name: name.name, js: held, outer: scope }, fn);
    const at = this.range(node.range);
    const refused = fn.next();
    // A name is bound to a VALUE, so a value that must be awaited is refused here rather
    // than inside the body, where every read of the name would meet it again.
    return (
      `(${held} = ${value}, isCelError(${held}) ? ${held} : ` +
      `(${refused} = asyncValueRefused(${held}, ${at}), ${refused} ? ${refused} : ${body}))`
    );
  }

  /** `optional.of(v)`, `optional.ofNonZeroValue(v)` and `optional.none()`. */
  private optionalNamespace(
    node: Extract<CelNode, { kind: "receiverCall" }>,
    scope: Scope | undefined,
    fn: Temporaries,
  ): string {
    if (node.name === "none") return "none";
    if (node.args.length !== 1) {
      throw new CelCompileError(`optional.${node.name}(value) takes one argument`);
    }
    const value = this.node(node.args[0]!, scope, fn);
    const wrap = node.name === "ofNonZeroValue" ? "optionalOfNonZero" : "celSome";
    return this.carrying([value], fn, ([held]) => `${wrap}(${held})`);
  }

  /** `opt.optMap(v, body)` wraps what the body answers; `optFlatMap` does not. */
  private optionalBinding(
    node: Extract<CelNode, { kind: "receiverCall" }>,
    scope: Scope | undefined,
    fn: Temporaries,
  ): string {
    const name = node.args[0]!;
    if (name.kind !== "ident") throw new CelCompileError(`${node.name} binds a name`);
    const receiver = this.node(node.receiver, scope, fn);
    const at = this.range(node.range);
    const optional = fn.next();
    const refused = fn.next();
    const answered = fn.next();
    const held = fn.next();
    const body = this.node(node.args[1]!, { name: name.name, js: held, outer: scope }, fn);
    const wrong = `celError("no_matching_overload", ${textSource(`${JSON.stringify(node.name)} reads an optional`)}, ${at})`;
    const result =
      node.name === "optMap"
        ? `celSome(${answered})`
        : `isCelOptional(${answered}) ? ${answered} : celError("no_matching_overload", ` +
          `${textSource("optFlatMap's body answers an optional")}, ${at})`;
    // A host may hand over the optional itself, so what it HOLDS is a door of its own.
    return (
      `(${optional} = ${receiver}, isCelError(${optional}) ? ${optional} : ` +
      `!isCelOptional(${optional}) ? ${wrong} : ` +
      `!${optional}.present ? none : ` +
      `(${refused} = asyncValueRefused(${optional}.held, ${at}), ${refused} ? ${refused} : ` +
      `(${held} = ${optional}.held, ${answered} = ${body}, isCelError(${answered}) ? ${answered} : ${result})))`
    );
  }

  /**
   * A comprehension. The body becomes a function of the element, exactly as the closure
   * backend passes one, so the macro's meaning — including which error outranks which
   * decided answer — stays `comprehension-runtime.ts`'s alone.
   */
  private comprehension(
    node: Extract<CelNode, { kind: "receiverCall" }>,
    scope: Scope | undefined,
    fn: Temporaries,
  ): string {
    const binding = receiverMacroBinding(node.name, node.args.length);
    if (!binding) throw new CelCompileError(`${node.name} is not a comprehension`);
    const name = node.args[binding.variableArgument]!;
    if (name.kind !== "ident") throw new CelCompileError(`${node.name} binds a name`);
    const receiver = this.node(node.receiver, scope, fn);
    const at = this.range(node.range);
    const element = this.elementName();
    const inner: Scope = { name: name.name, js: element, outer: scope };
    const bodies = binding.scopedArguments.map((argument) => this.body(node.args[argument]!, inner, element));
    const elements = fn.next();
    const call = ((): string => {
      switch (node.name) {
        case "all":
          return `celAll(${elements}, ${bodies[0]}, ${at})`;
        case "exists":
          return `celExists(${elements}, ${bodies[0]}, ${at})`;
        case "exists_one":
          return `celExistsOne(${elements}, ${bodies[0]}, ${at})`;
        case "filter":
          return `celFilter(${elements}, ${bodies[0]}, ${at})`;
        default:
          return bodies.length === 2
            ? `celMapComprehension(${elements}, ${bodies[1]}, ${bodies[0]}, ${at})`
            : `celMapComprehension(${elements}, ${bodies[0]}, undefined, ${at})`;
      }
    })();
    return this.carrying(
      [receiver],
      fn,
      ([held]) =>
        `(${elements} = celIterable(${held}, ${at}), isCelError(${elements}) ? ${elements} : ${call})`,
    );
  }

  /** A body a comprehension calls per element: its own function, with its own temporaries. */
  private body(node: CelNode, scope: Scope, parameter: string): string {
    const temporaries = this.temporaries();
    const text = this.node(node, scope, temporaries);
    return `(${parameter}) => { ${temporaries.declaration()}return ${text}; }`;
  }

  // --- the one sequencing rule --------------------------------------------

  /**
   * Evaluate each expression in order and carry the first error out, then build the answer
   * from the values. Every form that evaluates more than one thing goes through here, so a
   * later operand is never evaluated after an earlier one failed — which is what makes an
   * error a value that short-circuits rather than an exception.
   */
  private carrying(
    expressions: readonly string[],
    fn: Temporaries,
    answer: (values: readonly string[]) => string,
  ): string {
    const values = expressions.map(() => fn.next());
    let out = answer(values);
    for (let at = expressions.length - 1; at >= 0; at -= 1) {
      out = `(${values[at]} = ${expressions[at]}, isCelError(${values[at]}) ? ${values[at]} : ${out})`;
    }
    return out;
  }
}

// --- writing a value as source ---------------------------------------------

/** An int or uint literal as a `bigint`, parenthesized where it is negative. */
function integerSource(value: bigint): string {
  return value < 0n ? `(${value}n)` : `${value}n`;
}

/**
 * A double as source. `-0` is a value CEL tells apart from `0`, and an overflowing literal
 * reads as an infinity, so neither may go through the shortest decimal form.
 */
function doubleSource(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "(-Infinity)";
  if (Object.is(value, -0)) return "(-0)";
  return value < 0 ? `(${value})` : `${value}`;
}

const ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\\\",
  '"': '\\"',
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
  "\v": "\\v",
};

/**
 * Text as a JavaScript string literal. Every character outside printable ASCII is written
 * as an escape — a lone surrogate, a line separator and a zero-width joiner all read back
 * as themselves, and the emitted module is pure ASCII however its expressions were written,
 * so no encoding assumption about the file it is stored in can change its meaning.
 */
export function textSource(text: string): string {
  let out = '"';
  for (const unit of text) {
    const held = ESCAPES[unit];
    if (held !== undefined) {
      out += held;
      continue;
    }
    const code = unit.codePointAt(0)!;
    if (code >= 0x20 && code <= 0x7e) {
      out += unit;
      continue;
    }
    if (code > 0xffff) {
      out += `\\u{${code.toString(16)}}`;
      continue;
    }
    out += `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return `${out}"`;
}
