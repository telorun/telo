/**
 * The type checker: one walk, every verdict.
 *
 * It answers three things at once, because all three come from the same walk and
 * nothing else can derive them: the type of the expression, every mistake in it with a
 * range and a code, and which signature each call resolved to.
 *
 * Two properties are deliberate and worth keeping:
 *
 * - **One mistake is one diagnostic.** A subexpression that failed is typed `dyn`, so
 *   the operator above it does not report a second mistake about the first one. An
 *   editor shows what is wrong, not what is downstream of it.
 * - **Nothing reads a message.** Every code is decided where the cause is known — an
 *   unknown name, a call written in the other form, a type argument that differs — and
 *   a repair, where there is an obvious one, is built by rewriting the tree and writing
 *   it back out, so a fix is always a whole source that parses.
 */

import type { CelExpression } from "./cel-expression.js";
import type { CelType, RecordType } from "./cel-type.js";
import {
  admitsNull,
  assignable,
  BOOL,
  DYN,
  DOUBLE,
  BYTES,
  formatType,
  INT,
  isDyn,
  listOf,
  mapOf,
  NULL,
  optionalOf,
  parameterOf,
  STRING,
  TYPE,
  UINT,
  unify,
  unionOf,
  withoutNull,
  withoutParameters,
} from "./cel-type.js";
import { literalValue } from "./cel-value.js";
import type { CelCheckCode, CelCheckDiagnostic, CelDiagnosticFix } from "./check-diagnostic.js";
import { splitDeclaredChain } from "./declared-chain.js";
import { DiagnosticList } from "./check-diagnostic.js";
import type { FunctionRegistry, RegisteredFunction, ResolutionFailure } from "./function-registry.js";
import { describeArguments, describeCandidates } from "./function-registry.js";
import { checkMacro, isMacroCall, type MacroHost } from "./macro-check.js";
import { macroShapeFindings } from "./macro-shape.js";
import { chainRoot, chainText, provenWhereFalse, provenWhereTrue } from "./nullable-access.js";
import type { ResolvedCall } from "./resolved-call.js";
import { serializeTree } from "./serializer.js";
import type { CallForm, CelSignature } from "./signature.js";
import { formatSignature } from "./signature.js";
import type {
  CelCallNode,
  CelNode,
  CelQualifiedCallNode,
  CelReceiverCallNode,
  SourceRange,
} from "./syntax-tree.js";

/**
 * A namespaced function the host has declared.
 *
 * **The parameter list is optional, and withholding it is structural rather than a flag.**
 * A host whose own signature grammar is richer than this engine's — optional trailing
 * parameters, a declared JSON Schema per parameter — judges arity and arguments itself and
 * declares only what this engine needs to type the call's RESULT. There is deliberately no
 * way to supply parameters and ask for them not to be judged: that shape would let a
 * declaration carry a list nothing reads, which is the state a reader cannot tell from a
 * list that is simply wrong.
 */
export interface NamespaceFunction {
  readonly name: string;
  readonly returns: CelType;
  /** Absent where the host withholds it; the call's arity and arguments are then unjudged. */
  readonly parameters?: readonly CelType[];
  /** How the declaration is written, for a listing; absent with the parameters. */
  readonly signature?: string;
  readonly deterministic?: boolean;
  readonly hostBacked?: boolean;
  readonly throws?: readonly string[];
}

export interface CheckerOptions {
  readonly unlistedVariablesAreDyn: boolean;
  readonly homogeneousAggregateLiterals: boolean;
  readonly enableOptionalTypes: boolean;
}

/** Everything the checker reads about the environment it is checking against. */
export interface CheckerContext {
  readonly registry: FunctionRegistry;
  readonly variable: (name: string) => CelType | undefined;
  readonly declaredVariableNames: () => readonly string[];
  readonly namespaceFunction: (namespace: string, name: string) => NamespaceFunction | undefined;
  /**
   * Whether a namespace declares every function reachable through it. An **open** namespace
   * does not: a name it did not declare types `dyn`, is listed as a call, and is reported by
   * nobody — the host resolves such a name against its own vocabulary (an export gate, a
   * capability, a re-export chain) and words that verdict itself. Refusing it here would be
   * this engine deciding a question only the host can answer, and the host would then have to
   * suppress the refusal, which is the after-the-fact classifier this engine exists to retire.
   */
  readonly namespaceIsOpen: (namespace: string) => boolean;
  readonly options: CheckerOptions;
}

export interface CheckResult {
  readonly valid: boolean;
  /** The type of the whole expression; `dyn` where something failed. */
  readonly type: CelType;
  /** How that type is written. */
  readonly typeName: string;
  readonly diagnostics: readonly CelCheckDiagnostic[];
  readonly calls: readonly ResolvedCall[];
}

export function checkExpression(expression: CelExpression, context: CheckerContext): CheckResult {
  const checker = new Checker(expression, context);
  return checker.run();
}

class Checker implements MacroHost {
  private readonly diagnostics = new DiagnosticList();
  private readonly calls: ResolvedCall[] = [];
  private readonly scopes: Map<string, CelType>[] = [];
  private proven: ReadonlySet<string> = new Set();

  constructor(
    private readonly expression: CelExpression,
    private readonly context: CheckerContext,
  ) {}

  run(): CheckResult {
    for (const syntax of this.expression.diagnostics) {
      this.diagnostics.add({ code: "CEL_SYNTAX_ERROR", message: syntax.message, range: syntax.range });
    }
    for (const finding of macroShapeFindings(this.expression.root)) {
      this.report(finding.code, finding.message, finding.range);
    }
    // The type is REPORTED, so an unresolved parameter in it is `dyn`: that is cel-spec's
    // own rule for a parameter nothing resolved, and it is the same rule this checker
    // already applies to every use of one inside an expression. A parameter survives in a
    // declaration — a signature, a nominal type's parameter list — and nowhere else.
    const type = withoutParameters(this.typeOf(this.expression.root));
    return {
      valid: this.diagnostics.length === 0,
      type,
      typeName: formatType(type, true),
      diagnostics: this.diagnostics.list(),
      calls: this.calls,
    };
  }

  // --- MacroHost ----------------------------------------------------------

  report(code: CelCheckCode, message: string, range: SourceRange, fix?: CelDiagnosticFix): void {
    this.diagnostics.add({ code, message, range, ...(fix ? { fix } : {}) });
  }

  typeOfBinding(node: CelNode, bindings: ReadonlyMap<string, CelType>): CelType {
    this.scopes.push(new Map(bindings));
    try {
      return this.typeOf(node);
    } finally {
      this.scopes.pop();
    }
  }

  // --- the walk -----------------------------------------------------------

  typeOf(node: CelNode): CelType {
    switch (node.kind) {
      case "unparsed":
        return DYN;
      case "literal":
        return this.literalType(node.literal.type);
      case "ident":
        return this.identType(node);
      case "list":
        return this.listType(node);
      case "map":
        return this.mapType(node);
      case "select":
        return this.selectType(node);
      case "index":
        return this.indexType(node);
      case "unary":
        return this.operatorType(node.operator, [node.operand], node.range);
      case "binary":
        return this.binaryType(node);
      case "conditional":
        return this.conditionalType(node);
      case "call":
      case "receiverCall":
        return this.callType(node);
      case "qcall":
        return this.qualifiedCallType(node);
    }
  }

  private literalType(type: string): CelType {
    switch (type) {
      case "int":
        return INT;
      case "uint":
        return UINT;
      case "double":
        return DOUBLE;
      case "string":
        return STRING;
      case "bytes":
        return BYTES;
      case "bool":
        return BOOL;
      default:
        return NULL;
    }
  }

  private identType(node: Extract<CelNode, { kind: "ident" }>): CelType {
    // An absolute name is resolved against the environment alone: that is what it is for.
    if (!node.absolute) {
      for (let at = this.scopes.length - 1; at >= 0; at -= 1) {
        const bound = this.scopes[at]!.get(node.name);
        if (bound) return bound;
      }
    }
    const declared = this.context.variable(node.name);
    if (declared) return declared;
    if (this.context.options.unlistedVariablesAreDyn) return DYN;
    this.report(
      "CEL_UNKNOWN_IDENTIFIER",
      `${JSON.stringify(node.name)} is not declared here${this.availableNames()}`,
      node.range,
    );
    return DYN;
  }

  private availableNames(): string {
    const names = this.context.declaredVariableNames();
    return names.length === 0 ? "" : ` (declared: ${[...names].sort().join(", ")})`;
  }

  private listType(node: Extract<CelNode, { kind: "list" }>): CelType {
    if (node.elements.length === 0) return listOf(parameterOf("T"));
    const types = node.elements.map((element) =>
      element.optional
        ? this.heldByOptional(this.typeOf(element.value), element.value, "a list element")
        : this.typeOf(element.value),
    );
    return listOf(
      this.reduce(
        types,
        node.elements.map((element) => element.value),
        "list",
      ),
    );
  }

  /**
   * What an optional entry contributes: the value inside the optional. The entry holds an
   * `optional<T>` and the aggregate holds `T`, because an absent one leaves no entry at
   * all — which is the whole point of writing it that way.
   */
  private heldByOptional(type: CelType, node: CelNode, what: string): CelType {
    if (type.kind === "optional") return type.value;
    if (isDyn(type) || type.kind === "parameter") return DYN;
    this.report(
      "CEL_TYPE_ERROR",
      `${what} written with '?' holds an optional, and this one is ${formatType(type)}`,
      node.range,
    );
    return DYN;
  }

  private mapType(node: Extract<CelNode, { kind: "map" }>): CelType {
    if (node.entries.length === 0) return mapOf(parameterOf("K"), parameterOf("V"));
    const keys = node.entries.map((entry) => this.typeOf(entry.key));
    const values = node.entries.map((entry) =>
      entry.optional
        ? this.heldByOptional(this.typeOf(entry.value), entry.value, "a map entry")
        : this.typeOf(entry.value),
    );
    return mapOf(
      this.reduce(keys, node.entries.map((entry) => entry.key), "map key"),
      this.reduce(values, node.entries.map((entry) => entry.value), "map value"),
    );
  }

  /**
   * One type for several written values. Mixed types are `dyn` — CEL's own reading of a
   * heterogeneous literal — unless the environment asked for homogeneous aggregates, in
   * which case the mixture is the mistake.
   */
  private reduce(types: readonly CelType[], nodes: readonly CelNode[], what: string): CelType {
    let reduced = types[0]!;
    for (let at = 1; at < types.length; at += 1) {
      const next = unify(reduced, types[at]!);
      if (
        this.context.options.homogeneousAggregateLiterals &&
        isDyn(next) &&
        !isDyn(reduced) &&
        !isDyn(types[at]!)
      ) {
        this.report(
          "CEL_TYPE_ERROR",
          `this ${what} is ${formatType(types[at]!)} where the others are ${formatType(reduced)}`,
          nodes[at]!.range,
        );
      }
      reduced = next;
    }
    return reduced;
  }

  private selectType(node: Extract<CelNode, { kind: "select" }>): CelType {
    const qualified = this.qualifiedVariableType(node);
    if (qualified) return qualified;
    const operand = this.typeOf(node.operand);
    if (node.field === "") return DYN;
    const guarded = this.checkNullable(node.operand, operand, `.${node.field}`, node.fieldRange);
    const held = this.memberType(guarded, node.field, node.fieldRange);
    // Reading through an optional answers an optional, whichever form the read is
    // written in: that is what makes a chain of reads over a value that may be absent
    // stay one expression instead of needing a guard at every step.
    return node.optional || guarded.kind === "optional" ? optionalOf(unwrapOptional(held)) : held;
  }

  /**
   * A dotted declaration is **one name**, and the longest one wins.
   *
   * A host may declare `a.b.c`, or `a.b` holding a map, or both. `a.b.c` then reads the
   * variable of that name where it is declared, and the map's entry where only `a.b` is —
   * so the host's own naming decides, not the shape of the expression. A name something
   * inside the expression bound takes precedence over a declaration, as a bare name does,
   * unless the chain is absolute.
   */
  private qualifiedVariableType(node: Extract<CelNode, { kind: "select" }>): CelType | undefined {
    const chain = plainChain(node);
    if (!chain) return undefined;
    if (!chain.root.absolute && this.isBound(chain.root.name)) return undefined;
    // The one split, shared with the backend (`declared-chain.ts`): two readers of "which
    // name is this chain" would let the checker type one name while evaluation reads another.
    const segments = chain.segments.map((segment) => segment.name);
    const split = splitDeclaredChain(segments, (name) => this.context.variable(name) !== undefined);
    if (!split) return undefined;
    // A split at the ROOT alone is the ordinary read of a name and then its members, which the
    // select walk beside this types already — including the nullable-access rule, which is a
    // fact about the expression's shape rather than about which name it reads. Only a DOTTED
    // declaration is this question; the backend uses the whole answer, so neither searches a
    // prefix the other declared.
    if (split.rest.length === segments.length - 1) return undefined;
    let held = this.context.variable(split.name)!;
    for (const segment of chain.segments.slice(chain.segments.length - split.rest.length)) {
      held = this.memberType(held, segment.name, segment.range);
    }
    return held;
  }

  private isBound(name: string): boolean {
    return this.scopes.some((scope) => scope.has(name));
  }

  /** The type of a named member, reported against whatever the operand turned out to be. */
  private memberType(operand: CelType, field: string, range: SourceRange): CelType {
    if (isDyn(operand) || operand.kind === "parameter") return DYN;
    if (operand.kind === "optional") return this.memberType(operand.value, field, range);
    if (operand.kind === "union") {
      return unionOf(operand.members.map((member) => this.memberType(member, field, range)));
    }
    if (operand.kind === "record") return this.recordMemberType(operand, field, range);
    if (operand.kind === "map") {
      if (!assignable(STRING, operand.key)) {
        this.report(
          "CEL_TYPE_ERROR",
          `${formatType(operand)} is keyed by ${formatType(operand.key)}, so ${JSON.stringify(field)} cannot name an entry of it`,
          range,
        );
        return DYN;
      }
      return operand.value;
    }
    this.report("CEL_TYPE_ERROR", `${formatType(operand)} holds no members`, range);
    return DYN;
  }

  private recordMemberType(record: RecordType, field: string, range: SourceRange): CelType {
    const held = record.fields.get(field);
    if (held) return held;
    if (record.open) return DYN;
    const declared = [...record.fields.keys()];
    this.report(
      "CEL_UNKNOWN_FIELD",
      `${JSON.stringify(field)} is not declared here${declared.length === 0 ? "" : ` (declared: ${declared.join(", ")})`}`,
      range,
    );
    return DYN;
  }

  private indexType(node: Extract<CelNode, { kind: "index" }>): CelType {
    const operand = this.typeOf(node.operand);
    const index = this.typeOf(node.index);
    const guarded = this.checkNullable(node.operand, operand, "[…]", node.range);
    const held = this.elementType(guarded, index, node);
    return node.optional || guarded.kind === "optional" ? optionalOf(unwrapOptional(held)) : held;
  }

  private elementType(
    operand: CelType,
    index: CelType,
    node: Extract<CelNode, { kind: "index" }>,
  ): CelType {
    if (isDyn(operand) || operand.kind === "parameter") return DYN;
    if (operand.kind === "optional") return this.elementType(operand.value, index, node);
    if (operand.kind === "union") {
      return unionOf(operand.members.map((member) => this.elementType(member, index, node)));
    }
    if (operand.kind === "list") {
      if (!assignable(index, INT) && !isDyn(index)) {
        this.report(
          "CEL_TYPE_ERROR",
          `a list is indexed by int, and this index is ${formatType(index)}`,
          node.index.range,
        );
      }
      return operand.element;
    }
    if (operand.kind === "map") {
      if (!assignable(index, operand.key) && !isDyn(index)) {
        this.report(
          "CEL_TYPE_ERROR",
          `${formatType(operand)} is indexed by ${formatType(operand.key)}, and this index is ${formatType(index)}`,
          node.index.range,
        );
      }
      return operand.value;
    }
    if (operand.kind === "record") {
      const literal = node.index.kind === "literal" && node.index.literal.type === "string";
      if (literal) {
        return this.recordMemberType(operand, (node.index as { literal: { value: string } }).literal.value, node.index.range);
      }
      return DYN;
    }
    this.report("CEL_TYPE_ERROR", `${formatType(operand)} holds no elements`, node.range);
    return DYN;
  }

  private binaryType(node: Extract<CelNode, { kind: "binary" }>): CelType {
    if (node.operator === "&&" || node.operator === "||") {
      const left = this.typeOf(node.left);
      const proofs = node.operator === "&&" ? provenWhereTrue(node.left) : provenWhereFalse(node.left);
      const right = this.withProven(proofs, () => this.typeOf(node.right));
      for (const type of [left, right]) {
        if (!isDyn(type) && !assignable(type, BOOL)) {
          this.report(
            "CEL_TYPE_ERROR",
            `${node.operator} joins bool values, and ${formatType(type)} is not one`,
            node.range,
          );
        }
      }
      return BOOL;
    }
    return this.operatorType(node.operator, [node.left, node.right], node.range);
  }

  private conditionalType(node: Extract<CelNode, { kind: "conditional" }>): CelType {
    const condition = this.typeOf(node.condition);
    if (!isDyn(condition) && !assignable(condition, BOOL)) {
      this.report(
        "CEL_TYPE_ERROR",
        `a condition must be bool, and this one is ${formatType(condition)}`,
        node.condition.range,
      );
    }
    const whenTrue = this.withProven(provenWhereTrue(node.condition), () => this.typeOf(node.whenTrue));
    const whenFalse = this.withProven(provenWhereFalse(node.condition), () => this.typeOf(node.whenFalse));
    const unified = unify(whenTrue, whenFalse);
    // A value read out of a conditional has one type, so two branches that share none
    // is a mistake rather than a `dyn`: whoever reads it would be reading two things.
    if (isDyn(unified) && !isDyn(whenTrue) && !isDyn(whenFalse)) {
      this.report(
        "CEL_TYPE_ERROR",
        `the branches of a condition answer ${formatType(whenTrue)} and ${formatType(whenFalse)}, which are not one type`,
        node.range,
      );
    }
    return unified;
  }

  private withProven<T>(proofs: readonly string[], body: () => T): T {
    if (proofs.length === 0) return body();
    const outer = this.proven;
    this.proven = new Set([...outer, ...proofs]);
    try {
      return body();
    } finally {
      this.proven = outer;
    }
  }

  /**
   * A dereference of something that may be null. The type is answered with null taken
   * out either way, so one missing guard is one diagnostic rather than a cascade.
   */
  private checkNullable(operand: CelNode, type: CelType, access: string, range: SourceRange): CelType {
    if (!admitsNull(type)) return type;
    const chain = chainText(operand);
    if (chain === undefined || this.proven.has(chain)) return withoutNull(type);
    // **A chain rooted at a name the expression BOUND is not a subject of this verdict.** The
    // guard constructs are only half the rule: the walk this replaces skipped such a chain
    // entirely, so `xs.map(e, e.code)` over a nullable element is accepted today, and
    // reporting it after the swap would newly reject a manifest — which is exactly what the
    // guard set is held to its three forms to prevent.
    const root = chainRoot(operand);
    if (root !== undefined && this.isBound(root)) return withoutNull(type);
    if (type.kind === "primitive") {
      this.report("CEL_TYPE_ERROR", `null holds no members`, range);
      return DYN;
    }
    this.report(
      "CEL_NULLABLE_ACCESS",
      `${JSON.stringify(chain)} may be null — guard it (e.g. '${chain} != null && …' or '${chain} == null ? … : ${chain}${access}') before reading ${access}`,
      range,
    );
    return withoutNull(type);
  }

  private operatorType(operator: string, operands: readonly CelNode[], range: SourceRange): CelType {
    const args = operands.map((operand) => this.typeOf(operand));
    // A value whose declared type admits null may always be tested against null —
    // otherwise declaring it nullable would make it untestable, and the guard that
    // clears a nullable read would itself be a type error.
    if ((operator === "==" || operator === "!=") && isNullTest(args)) return BOOL;
    const resolution = this.context.registry.resolve(operator, "global", args);
    if ("resolved" in resolution) return resolution.returns;
    const mismatch = this.typeArgumentMismatch([...args, ...this.candidateTypes(resolution)]);
    this.report(
      mismatch ? "CEL_TYPE_ARGUMENT_MISMATCH" : "CEL_TYPE_ERROR",
      mismatch ?? `no ${JSON.stringify(operator)} is declared over ${describeArguments(args)}`,
      range,
    );
    return DYN;
  }

  /**
   * Two named types of one name whose arguments differ: invariance, so a mistake of its
   * own rather than a plain type error. Only fully resolved types are compared — a
   * signature's own parameter says nothing about what the call wanted.
   */
  private typeArgumentMismatch(types: readonly CelType[]): string | undefined {
    const nominals = types.filter(
      (type): type is Extract<CelType, { kind: "nominal" }> =>
        type.kind === "nominal" && type.args.every((argument) => argument.kind !== "parameter"),
    );
    for (const [at, left] of nominals.entries()) {
      for (const right of nominals.slice(at + 1)) {
        if (left.name === right.name && !sameArguments(left.args, right.args)) {
          return `${formatType(left)} and ${formatType(right)} are the same type with different type arguments, which never match`;
        }
      }
    }
    return undefined;
  }

  /** Every type a set of candidates mentions, for naming a type-argument mismatch. */
  private candidateTypes(failure: ResolutionFailure): readonly CelType[] {
    return failure.candidates.flatMap((candidate) => [
      ...(candidate.signature.receiver ? [candidate.signature.receiver] : []),
      ...candidate.signature.parameters,
    ]);
  }

  private callType(node: CelCallNode | CelReceiverCallNode): CelType {
    if (isMacroCall(node)) {
      if (!this.context.options.enableOptionalTypes && isOptionalMacro(node)) {
        this.report(
          "CEL_UNKNOWN_FUNCTION",
          "optional types are not enabled in this environment",
          node.range,
        );
        return DYN;
      }
      return checkMacro(node, this);
    }
    const form: CallForm = node.kind === "call" ? "global" : "receiver";
    const receiver = node.kind === "receiverCall" ? this.typeOf(node.receiver) : undefined;
    const args = node.args.map((argument) => this.typeOf(argument));
    const resolution = this.context.registry.resolve(node.name, form, args, receiver);
    if ("resolved" in resolution) {
      this.calls.push(this.dispatched(node, form, args.length, resolution.resolved, resolution.returns));
      this.checkLiteralArguments(node, resolution.resolved);
      return resolution.returns;
    }
    this.calls.push({ name: node.name, form, arity: args.length, range: node.range });
    this.reportCallFailure(node, form, args, receiver, resolution);
    return DYN;
  }

  /**
   * A registration's own guard over the arguments written as literals.
   *
   * It is asked here, where the call has just resolved, and nowhere else: a refusal over a
   * VALUE is a verdict about the expression, so the component that decides every other
   * verdict decides this one too — an implementation that refused the same argument at
   * evaluation would leave a defect the source states behind a run. The refusal names the
   * call as it was written, which is the one thing a reader needs to find it.
   */
  private checkLiteralArguments(
    node: CelCallNode | CelReceiverCallNode,
    resolved: RegisteredFunction,
  ): void {
    const check = resolved.metadata.checkArguments;
    if (check === undefined) return;
    const written = node.kind === "receiverCall" ? [node.receiver, ...node.args] : node.args;
    const refusal = check(
      written.map((argument) => (argument.kind === "literal" ? literalValue(argument.literal) : undefined)),
    );
    if (refusal === undefined) return;
    const source = this.expression.source.slice(node.range[0], node.range[1]);
    this.report("CEL_INVALID_ARGUMENT", `${refusal} (in \`${source}\`)`, node.range);
  }

  private dispatched(
    node: CelCallNode | CelReceiverCallNode,
    form: CallForm,
    arity: number,
    resolved: RegisteredFunction,
    returns: CelType,
  ): ResolvedCall {
    const { metadata } = resolved;
    return {
      name: node.name,
      form,
      arity,
      range: node.range,
      signature: formatSignature(resolved.signature),
      returns: formatType(withoutParameters(returns)),
      deterministic: metadata.deterministic ?? true,
      hostBacked: metadata.hostBacked ?? false,
      ...(metadata.throws ? { throws: metadata.throws } : {}),
    };
  }

  private reportCallFailure(
    node: CelCallNode | CelReceiverCallNode,
    form: CallForm,
    args: readonly CelType[],
    receiver: CelType | undefined,
    failure: ResolutionFailure,
  ): void {
    const written = `${node.name}(${describeArguments(args)})`;
    if (failure.reason === "unknown") {
      this.report(
        "CEL_UNKNOWN_FUNCTION",
        `no function named ${JSON.stringify(node.name)} is registered`,
        node.range,
        this.renameFix(node),
      );
      return;
    }
    if (failure.reason === "wrong-form") {
      const wanted = form === "global" ? "on a value" : "without a receiver";
      this.report(
        "CEL_WRONG_CALL_FORM",
        `${JSON.stringify(node.name)} is called ${wanted}: ${describeCandidates(failure.candidates)}`,
        node.range,
        this.formFix(node),
      );
      return;
    }
    const mismatch = this.typeArgumentMismatch([
      ...(receiver ? [receiver] : []),
      ...args,
      ...this.candidateTypes(failure),
    ]);
    this.report(
      mismatch ? "CEL_TYPE_ARGUMENT_MISMATCH" : "CEL_TYPE_ERROR",
      mismatch ??
        `no overload of ${JSON.stringify(node.name)} takes ${
          form === "receiver" ? `${formatType(receiver ?? DYN)}.` : ""
        }${written}: ${describeCandidates(failure.candidates)}`,
      node.range,
    );
  }

  /** The one registered name this call might have meant, as a whole-source repair. */
  private renameFix(node: CelCallNode | CelReceiverCallNode): CelDiagnosticFix | undefined {
    const wanted = node.name.toLowerCase();
    const form: CallForm = node.kind === "call" ? "global" : "receiver";
    const candidates = new Set(
      this.context.registry
        .list()
        .filter(
          (entry) =>
            entry.signature.form === form &&
            entry.signature.parameters.length === node.args.length &&
            entry.signature.name.toLowerCase() === wanted &&
            entry.signature.name !== node.name,
        )
        .map((entry) => entry.signature.name),
    );
    if (candidates.size !== 1) return undefined;
    return this.replacement(node, { ...node, name: [...candidates][0]! });
  }

  /** The same call written in its other form, parenthesized as the tree requires. */
  private formFix(node: CelCallNode | CelReceiverCallNode): CelDiagnosticFix | undefined {
    if (node.kind === "call") {
      if (node.args.length === 0) return undefined;
      const [receiver, ...rest] = node.args;
      return this.replacement(node, {
        kind: "receiverCall",
        receiver: receiver!,
        name: node.name,
        nameRange: node.nameRange,
        args: rest,
        range: node.range,
      });
    }
    return this.replacement(node, {
      kind: "call",
      name: node.name,
      nameRange: node.nameRange,
      args: [node.receiver, ...node.args],
      range: node.range,
    });
  }

  /** The whole expression with one node replaced, written back out. */
  private replacement(from: CelNode, to: CelNode): CelDiagnosticFix | undefined {
    const rewritten = replaceNode(this.expression.root, from, to);
    if (!rewritten) return undefined;
    try {
      return { replacement: serializeTree(rewritten) };
    } catch {
      // A tree with an unreadable part cannot be written back, so no fix is offered;
      // the diagnostic itself stands.
      return undefined;
    }
  }

  private qualifiedCallType(node: CelQualifiedCallNode): CelType {
    const args = node.args.map((argument) => this.typeOf(argument));
    const qualified = `${node.namespace}.${node.name}`;
    const declared = this.context.namespaceFunction(node.namespace, node.name);
    if (!declared) {
      this.calls.push({
        name: qualified,
        form: "receiver",
        namespace: node.namespace,
        arity: args.length,
        range: node.range,
      });
      // An OPEN namespace declares only part of what it reaches, so a name it does not
      // carry is not this engine's to refuse — it is listed and left to the host.
      if (this.context.namespaceIsOpen(node.namespace)) return DYN;
      this.report(
        "FUNCTION_UNRESOLVED",
        `${JSON.stringify(node.namespace)} declares no function named ${JSON.stringify(node.name)}`,
        node.range,
      );
      return DYN;
    }
    const { parameters } = declared;
    this.calls.push({
      name: qualified,
      form: "receiver",
      namespace: node.namespace,
      arity: args.length,
      range: node.range,
      ...(declared.signature === undefined ? {} : { signature: declared.signature }),
      returns: formatType(withoutParameters(declared.returns)),
      deterministic: declared.deterministic ?? true,
      hostBacked: declared.hostBacked ?? false,
      ...(declared.throws ? { throws: declared.throws } : {}),
    });
    // Parameters withheld: the host judges arity and arguments against its own, richer
    // signature grammar, and this engine types the result and says nothing else.
    if (parameters === undefined) return declared.returns;
    if (args.length !== parameters.length) {
      this.report(
        "FUNCTION_ARITY_MISMATCH",
        `${qualified} takes ${parameters.length} argument${parameters.length === 1 ? "" : "s"}, and ${args.length} ${args.length === 1 ? "is" : "are"} written`,
        node.range,
      );
      return declared.returns;
    }
    for (const [at, argument] of args.entries()) {
      const wanted = parameters[at]!;
      if (assignable(argument, wanted)) continue;
      const mismatch = this.typeArgumentMismatch([argument, wanted]);
      this.report(
        mismatch ? "CEL_TYPE_ARGUMENT_MISMATCH" : "FUNCTION_ARGUMENT_MISMATCH",
        mismatch ??
          `${qualified} takes ${formatType(wanted)} here, and this argument is ${formatType(argument)}`,
        node.args[at]!.range,
      );
    }
    return declared.returns;
  }
}

/** Whether a comparison is a test against null of something that may be null. */
function isNullTest(args: readonly CelType[]): boolean {
  if (args.length !== 2) return false;
  const [left, right] = args as [CelType, CelType];
  const isNull = (type: CelType) => type.kind === "primitive" && type.name === "null";
  return (isNull(left) && admitsNull(right)) || (isNull(right) && admitsNull(left));
}

/** An optional of an optional is one optional; a chain of reads does not nest them. */
function unwrapOptional(type: CelType): CelType {
  return type.kind === "optional" ? unwrapOptional(type.value) : type;
}

/**
 * The dotted path a select spells, when every step is a plain named member of a name.
 * An optional step or an index makes it no longer one name.
 */
function plainChain(
  node: Extract<CelNode, { kind: "select" }>,
): { root: Extract<CelNode, { kind: "ident" }>; segments: { name: string; range: SourceRange }[] } | undefined {
  const segments: { name: string; range: SourceRange }[] = [];
  let at: CelNode = node;
  while (at.kind === "select") {
    if (at.optional || at.field === "") return undefined;
    segments.unshift({ name: at.field, range: at.fieldRange });
    at = at.operand;
  }
  if (at.kind !== "ident") return undefined;
  segments.unshift({ name: at.name, range: at.range });
  return { root: at, segments };
}

function sameArguments(left: readonly CelType[], right: readonly CelType[]): boolean {
  return left.length === right.length && left.every((type, at) => formatType(type) === formatType(right[at]!));
}

function isOptionalMacro(node: CelCallNode | CelReceiverCallNode): boolean {
  if (node.kind !== "receiverCall") return false;
  if (node.name === "optMap" || node.name === "optFlatMap") return true;
  return node.receiver.kind === "ident" && node.receiver.name === "optional";
}

/** The tree with one node swapped, or nothing when the node is not in it. */
function replaceNode(root: CelNode, from: CelNode, to: CelNode): CelNode | undefined {
  if (root === from) return to;
  switch (root.kind) {
    case "literal":
    case "ident":
    case "unparsed":
      return undefined;
    case "list": {
      for (const [at, element] of root.elements.entries()) {
        const value = replaceNode(element.value, from, to);
        if (!value) continue;
        const elements = [...root.elements];
        elements[at] = { ...element, value };
        return { ...root, elements };
      }
      return undefined;
    }
    case "map": {
      for (const [at, entry] of root.entries.entries()) {
        const key = replaceNode(entry.key, from, to);
        const value = replaceNode(entry.value, from, to);
        if (!key && !value) continue;
        const entries = [...root.entries];
        entries[at] = { ...entry, key: key ?? entry.key, value: value ?? entry.value };
        return { ...root, entries };
      }
      return undefined;
    }
    case "select": {
      const operand = replaceNode(root.operand, from, to);
      return operand ? { ...root, operand } : undefined;
    }
    case "index": {
      const operand = replaceNode(root.operand, from, to);
      if (operand) return { ...root, operand };
      const index = replaceNode(root.index, from, to);
      return index ? { ...root, index } : undefined;
    }
    case "call":
    case "qcall": {
      const args = replaceInList(root.args, from, to);
      return args ? { ...root, args } : undefined;
    }
    case "receiverCall": {
      const receiver = replaceNode(root.receiver, from, to);
      if (receiver) return { ...root, receiver };
      const args = replaceInList(root.args, from, to);
      return args ? { ...root, args } : undefined;
    }
    case "unary": {
      const operand = replaceNode(root.operand, from, to);
      return operand ? { ...root, operand } : undefined;
    }
    case "binary": {
      const left = replaceNode(root.left, from, to);
      if (left) return { ...root, left };
      const right = replaceNode(root.right, from, to);
      return right ? { ...root, right } : undefined;
    }
    case "conditional": {
      const condition = replaceNode(root.condition, from, to);
      if (condition) return { ...root, condition };
      const whenTrue = replaceNode(root.whenTrue, from, to);
      if (whenTrue) return { ...root, whenTrue };
      const whenFalse = replaceNode(root.whenFalse, from, to);
      return whenFalse ? { ...root, whenFalse } : undefined;
    }
  }
}

function replaceInList(nodes: readonly CelNode[], from: CelNode, to: CelNode): CelNode[] | undefined {
  for (const [at, node] of nodes.entries()) {
    const replaced = replaceNode(node, from, to);
    if (!replaced) continue;
    const copy = [...nodes];
    copy[at] = replaced;
    return copy;
  }
  return undefined;
}
