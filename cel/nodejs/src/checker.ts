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
import type { CelType, FieldEnumValue, ListType, MapType, NominalType, OptionalType, RecordType, UnionType } from "./cel-type.js";
import {
  admitsNull,
  assignable,
  BOOL,
  compareFieldEnumValues,
  DYN,
  DOUBLE,
  BYTES,
  formatType,
  INT,
  isDyn,
  isNumeric,
  listOf,
  mapOf,
  NULL,
  optionalOf,
  parameterOf,
  recordPatterns,
  STRING,
  TYPE,
  UINT,
  typesEqual,
  unify,
  unionOf,
  withoutNull,
  withoutParameters,
} from "./cel-type.js";
import { literalValue, type CelValue } from "./cel-value.js";
import type { CelCheckCode, CelCheckDiagnostic, CelDiagnosticFix } from "./check-diagnostic.js";
import type { ConstructionTypes } from "./construction.js";
import { constructionTarget, duplicateFieldMessage, unknownFieldMessage } from "./construction.js";
import { splitDeclaredChain } from "./declared-chain.js";
import { DiagnosticList } from "./check-diagnostic.js";
import type { Expansion, FunctionRegistry, RegisteredFunction, ResolutionFailure } from "./function-registry.js";
import { describeArguments, describeCandidates, expandedMembers, UNION_EXPANSION_LIMIT } from "./function-registry.js";
import { checkMacro, isMacroCall, type MacroHost } from "./macro-check.js";
import { macroShapeFindings } from "./macro-shape.js";
import {
  chainText,
  chainTextRoot,
  isTypeCall,
  provenWhereFalse,
  provenWhereTrue,
  typeTestedChain,
  type EqualityProof,
  type Proof,
} from "./nullable-access.js";
import { readRecordMember, recordMemberEdges, recordMembers } from "./record-member.js";
import type { ResolvedCall } from "./resolved-call.js";
import type { EdgeKey, SchemaDependency, SchemaProvenance } from "./schema-dependencies.js";
import { ADDITIONAL_EDGE, ELEMENT_EDGE, keptIn, SchemaDependencyRecorder } from "./schema-dependencies.js";
import { SchemaNodeLocator, type BranchRead, type ResultOrigin } from "./schema-nodes.js";
import { literalSource, memberNameSource, serializeTree } from "./serializer.js";
import type { CallForm, CelSignature } from "./signature.js";
import { formatSignature } from "./signature.js";
import type {
  CelCallNode,
  CelNode,
  CelQualifiedCallNode,
  CelLiteral,
  CelReceiverCallNode,
  SourceRange,
} from "./syntax-tree.js";
import { countTypeVisit } from "./type-visits.js";
import { celEqual } from "./value-equality.js";

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
  /**
   * Types the declaration named that nothing is registered under, in the order written.
   *
   * The declaration is accepted and reads `dyn` where one stands: a host's declaration is
   * data out of someone's manifest, so a name its own registry does not carry is the host
   * disagreeing with itself — reported at the call, where there is a range, rather than
   * thrown at registration, where there is none. Same rule as an unjudged schema node.
   */
  readonly unregisteredTypes?: readonly string[];
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
  /** Where a variable's types came from, where it was typed from a schema. */
  readonly variableProvenance?: (name: string) => SchemaProvenance | undefined;
  /** Whether the check lists the schema nodes it read. */
  readonly schemaDependencies?: boolean;
  /** Whether the check names the schema node each verdict and the result was read from. */
  readonly schemaNodes?: boolean;
  readonly declaredVariableNames: () => readonly string[];
  readonly namespaceFunction: (namespace: string, name: string) => NamespaceFunction | undefined;
  /**
   * Where a namespaced function's result types came from, where the host declared the
   * result as a JSON Schema document: a call reads it as a schema-typed variable is read.
   */
  readonly namespaceResultProvenance?: (namespace: string, name: string) => SchemaProvenance | undefined;
  /**
   * Whether a namespace declares every function reachable through it. An **open** namespace
   * does not: a name it did not declare types `dyn`, is listed as a call, and is reported by
   * nobody — the host resolves such a name against its own vocabulary (an export gate, a
   * capability, a re-export chain) and words that verdict itself. Refusing it here would be
   * this engine deciding a question only the host can answer, and the host would then have to
   * suppress the refusal, which is the after-the-fact classifier this engine exists to retire.
   */
  readonly namespaceIsOpen: (namespace: string) => boolean;
  /** The registered types a construction's name is resolved against. */
  readonly construction: ConstructionTypes;
  /** The type a name denotes as a type value (`string`, `list`, a registered type's name), if any. */
  readonly typeNamed: (name: string) => CelType | undefined;
  readonly options: CheckerOptions;
  /** What is known at the expression's site, in the order the host hands it over. */
  readonly assumptions?: readonly CheckerAssumption[];
}

/**
 * A condition known to have held (`holds`) or failed on the way to the expression, read as
 * if a `?:` enclosed it; a proof rooted at a `rebound` chain — one that may denote another
 * value at the site — is dropped.
 */
export interface CheckerAssumption {
  readonly condition: CelNode;
  readonly holds: boolean;
  readonly rebound: readonly string[];
}

export interface CheckResult {
  readonly valid: boolean;
  /** The type of the whole expression; `dyn` where something failed. */
  readonly type: CelType;
  /** How that type is written. */
  readonly typeName: string;
  readonly diagnostics: readonly CelCheckDiagnostic[];
  readonly calls: readonly ResolvedCall[];
  /**
   * Present exactly when the host asked: every schema node the verdicts and the result type
   * read, each once, in the order first read (`schema-dependencies.ts`).
   */
  readonly schemaDependencies?: readonly SchemaDependency[];
  /**
   * Present exactly when the host asked for schema nodes: every place the result may have
   * come from, in written order (`schema-nodes.ts`), each with the schema node it was read
   * straight from where it was — what a host compares against the schema of a slot the value
   * is forwarded to.
   */
  readonly resultOrigins?: readonly ResultOrigin[];
}

/** What a verdict carries beside its code, message and range. */
interface ReportDetail {
  readonly fix?: CelDiagnosticFix;
  readonly schemaNode?: SchemaDependency;
  readonly absent?: true;
}

export function checkExpression(expression: CelExpression, context: CheckerContext): CheckResult {
  const checker = new Checker(expression, context);
  return checker.run();
}

class Checker implements MacroHost {
  private diagnostics = new DiagnosticList();
  private readonly calls: ResolvedCall[] = [];
  private readonly scopes: Map<string, CelType>[] = [];
  /** Beside each scope, the node each name it binds was read from. */
  private readonly scopeNodes: (ReadonlyMap<string, SchemaDependency | undefined> | undefined)[] = [];
  /** What the guards around the walk prove, by the chain each proof names. */
  private proven: ReadonlyMap<string, readonly Fact[]> = new Map();
  /** The argument type of each `type(x)` call typed so far: what a type test compares. */
  private readonly typeArguments = new Map<CelNode, CelType>();
  /** Per type-test comparison, the runtime type each tested chain is compared with. */
  private readonly typeTestKeys = new Map<CelNode, ReadonlyMap<string, string>>();
  private reads: SchemaDependencyRecorder | undefined;
  private nodes: SchemaNodeLocator | undefined;

  constructor(
    private readonly expression: CelExpression,
    private readonly context: CheckerContext,
  ) {
    this.reads = context.schemaDependencies ? new SchemaDependencyRecorder() : undefined;
    this.nodes = context.schemaNodes ? new SchemaNodeLocator() : undefined;
  }

  run(): CheckResult {
    for (const syntax of this.expression.diagnostics) {
      this.diagnostics.add({ code: "CEL_SYNTAX_ERROR", message: syntax.message, range: syntax.range });
    }
    for (const finding of macroShapeFindings(this.expression.root)) {
      this.report(finding.code, finding.message, finding.range);
    }
    for (const assumption of this.context.assumptions ?? []) this.assume(assumption);
    // The type is REPORTED, so an unresolved parameter in it is `dyn`: that is cel-spec's
    // own rule for a parameter nothing resolved, and it is the same rule this checker
    // already applies to every use of one inside an expression. A parameter survives in a
    // declaration — a signature, a nominal type's parameter list — and nowhere else.
    const checked = this.typeOf(this.expression.root);
    const type = withoutParameters(checked);
    return {
      valid: this.diagnostics.length === 0,
      type,
      typeName: formatType(type, true),
      diagnostics: this.diagnostics.list(),
      calls: this.calls,
      ...(this.reads ? { schemaDependencies: this.reads.dependencies() } : {}),
      ...(this.nodes ? { resultOrigins: this.nodes.origins(this.expression.root, checked) } : {}),
    };
  }

  /**
   * What an assumption proves, from here on: its condition is typed — so a type test it holds
   * is decided — under what the assumptions before it prove, with nothing it says reported or
   * recorded, since it is the host's own site to judge.
   */
  private assume(assumption: CheckerAssumption): void {
    const [diagnostics, calls, reads, nodes] = [this.diagnostics, this.calls.length, this.reads, this.nodes];
    this.diagnostics = new DiagnosticList();
    this.reads = undefined;
    this.nodes = undefined;
    try {
      this.typeOf(assumption.condition);
    } finally {
      [this.diagnostics, this.reads, this.nodes] = [diagnostics, reads, nodes];
      this.calls.length = calls;
    }
    const proofs = (assumption.holds ? provenWhereTrue : provenWhereFalse)(assumption.condition).filter(
      (proof) => !assumption.rebound.some((chain) => proof.chain === chain || proof.chain.startsWith(`${chain}.`)),
    );
    this.proven = this.withProofs(this.proven, proofs);
  }

  // --- MacroHost ----------------------------------------------------------

  report(code: CelCheckCode, message: string, range: SourceRange, detail: ReportDetail = {}): void {
    this.diagnostics.add({
      code,
      message,
      range,
      ...(detail.fix ? { fix: detail.fix } : {}),
      ...(detail.schemaNode ? { schemaNode: detail.schemaNode } : {}),
      ...(detail.absent ? { absent: true as const } : {}),
    });
  }

  typeOfBinding(
    node: CelNode,
    bindings: ReadonlyMap<string, CelType>,
    passedOn = false,
    nodes?: ReadonlyMap<string, SchemaDependency | undefined>,
    proofs: readonly Proof[] = [],
  ): CelType {
    this.scopes.push(new Map(bindings));
    this.scopeNodes.push(nodes);
    const outer = this.proven;
    this.proven = this.withProofs(this.unboundProofs(bindings), proofs);
    try {
      return passedOn ? this.typeOfOperand(node) : this.typeOf(node);
    } finally {
      this.scopes.pop();
      this.scopeNodes.pop();
      this.proven = outer;
    }
  }

  /** The proofs that still hold beneath a scope binding these names: none about a name it rebinds. */
  private unboundProofs(bindings: ReadonlyMap<string, CelType>): ReadonlyMap<string, readonly Fact[]> {
    if (this.proven.size === 0) return this.proven;
    let kept: Map<string, readonly Fact[]> | undefined;
    for (const chain of this.proven.keys()) {
      const root = chainTextRoot(chain);
      if (root === undefined || !bindings.has(root)) continue;
      kept ??= new Map(this.proven);
      kept.delete(chain);
    }
    return kept ?? this.proven;
  }

  nodeAt(node: CelNode): SchemaDependency | undefined {
    return this.nodes?.at(node);
  }

  memberNode(container: CelType, key: EdgeKey): SchemaDependency | undefined {
    return this.nodes?.member(container, key);
  }

  unionMemberNode(union: CelType, at: number): SchemaDependency | undefined {
    return this.nodes?.unionMember(union, at);
  }

  locate(node: CelNode, at: SchemaDependency | undefined): void {
    this.nodes?.locate(node, at);
  }

  relay(node: CelNode, answers: readonly (readonly [CelNode, CelType])[]): void {
    this.nodes?.relay(node, answers);
  }

  /** The first of several subexpressions located at a schema node: what a verdict over them names. */
  private firstNode(nodes: readonly CelNode[]): SchemaDependency | undefined {
    if (!this.nodes) return undefined;
    for (const node of nodes) {
      const at = this.nodes.at(node);
      if (at) return at;
    }
    return undefined;
  }

  /**
   * The node a type narrowed from another was read from: the narrowed member's own node,
   * where the narrowing kept one member of a union, else the node the whole was read from.
   */
  private narrowedNode(from: CelType, to: CelType, whole: SchemaDependency | undefined): SchemaDependency | undefined {
    if (!this.nodes || from === to || from.kind !== "union") return whole;
    const at = from.members.indexOf(to);
    return (at >= 0 ? this.nodes.unionMember(from, at) : undefined) ?? whole;
  }

  /**
   * The node a member read was read from: a member or element of a type a conversion built,
   * through one optional layer — a tuple's position or rest where a literal `position` names
   * one. Nothing for a union's members read together.
   */
  private readNode(operand: CelType, key: string | undefined, position?: number): SchemaDependency | undefined {
    if (!this.nodes) return undefined;
    const held = operand.kind === "optional" ? operand.value : operand;
    if (held.kind === "record") {
      if (key === undefined) return undefined;
      const reading = readRecordMember(held, key);
      return reading.absent || reading.placed === undefined ? undefined : this.nodes.member(held, reading.placed);
    }
    if (held.kind === "list") return this.nodes.member(held, tupleEdge(held, position) ?? ELEMENT_EDGE);
    if (held.kind === "map") return assignable(STRING, held.key) ? this.nodes.member(held, ELEMENT_EDGE) : undefined;
    return undefined;
  }

  typeOfPresence(node: Extract<CelNode, { kind: "select" }>): CelType {
    return this.selectType(node, true);
  }

  readMember(container: CelType, key: string): void {
    this.reads?.readMember(container, key);
  }

  // --- the walk -----------------------------------------------------------

  /** The type of a subexpression its parent uses: everything beneath it is read. */
  typeOf(node: CelNode): CelType {
    const type = this.typeOfOperand(node);
    this.reads?.readWhole(type);
    return type;
  }

  /** The type of a subexpression its parent descends into or hands on unread. */
  typeOfOperand(node: CelNode): CelType {
    switch (node.kind) {
      case "unparsed":
        return DYN;
      case "literal":
        return this.literalType(node.literal.type);
      case "ident":
        return this.narrowed(node, this.identType(node));
      case "list":
        return this.listType(node);
      case "map":
        return this.mapType(node);
      case "struct":
        return this.structType(node);
      case "select":
        return node.optional ? this.selectType(node, true) : this.narrowed(node, this.selectType(node, false));
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
        if (bound) {
          this.nodes?.locate(node, this.scopeNodes[at]?.get(node.name));
          return bound;
        }
      }
    }
    const declared = this.context.variable(node.name);
    if (declared) {
      const provenance = this.context.variableProvenance?.(node.name);
      this.reads?.readRegistration(provenance);
      this.nodes?.locate(node, this.nodes.registration(provenance));
      return declared;
    }
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
      { schemaNode: this.nodeAt(node) },
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
   * `Name{field: value, …}`: a value of the named type, each field written checked against
   * the type's declaration. A refused name types the construction `dyn`, its values still
   * checked for what is wrong inside them.
   */
  private structType(node: Extract<CelNode, { kind: "struct" }>): CelType {
    const target = constructionTarget(node.typeName, this.context.construction);
    if (target.refusal) {
      this.report(target.refusal.code, target.refusal.message, node.typeNameRange);
      for (const entry of node.entries) this.typeOf(entry.value);
      return DYN;
    }
    const type = target.type.self;
    const fields = type.fields!;
    const required = target.type.required;
    const written = new Set<string>();
    for (const entry of node.entries) {
      const valueType = entry.optional
        ? this.heldByOptional(this.typeOf(entry.value), entry.value, "a field")
        : this.typeOf(entry.value);
      if (written.has(entry.field)) {
        this.report("CEL_INVALID_ARGUMENT", duplicateFieldMessage(type, entry.field), entry.fieldRange);
        continue;
      }
      written.add(entry.field);
      const declared = fields.get(entry.field);
      if (!declared) {
        this.report("CEL_UNKNOWN_FIELD", unknownFieldMessage(type, entry.field), entry.fieldRange);
        continue;
      }
      if (entry.optional && required.includes(entry.field)) {
        this.report(
          "CEL_MISSING_FIELD",
          `${formatType(type)} requires the field ${JSON.stringify(entry.field)}, which an entry written with '?' may leave unset`,
          entry.fieldRange,
        );
      }
      if (!assignable(valueType, declared)) {
        this.report(
          "CEL_TYPE_ERROR",
          `field ${JSON.stringify(entry.field)} of ${formatType(type)} is ${formatType(declared)}, and this value is ${formatType(valueType)}`,
          entry.value.range,
          { schemaNode: this.nodeAt(entry.value) },
        );
      }
    }
    for (const field of required) {
      if (written.has(field)) continue;
      this.report(
        "CEL_MISSING_FIELD",
        `${formatType(type)} requires the field ${JSON.stringify(field)}, and this construction does not write it`,
        node.range,
      );
    }
    return type;
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
          { schemaNode: this.nodeAt(nodes[at]!) },
        );
      }
      reduced = next;
    }
    return reduced;
  }

  /**
   * `presence` is whether the read asks whether the member is THERE — written `.?b`, or
   * standing as the argument of `has()`. It decides nothing about a type that is known to
   * hold no members, which both forms refuse; it decides what a UNION's member-less
   * branches are, which is the absence case a presence-shaped read answers for.
   */
  private selectType(node: Extract<CelNode, { kind: "select" }>, presence: boolean): CelType {
    const qualified = this.qualifiedVariableType(node);
    if (qualified) return qualified;
    const operand = this.typeOfOperand(node.operand);
    if (node.field === "") return DYN;
    const guarded = this.checkNullable(node.operand, operand, `.${node.field}`, node.fieldRange);
    const subject = this.narrowedNode(operand, guarded, this.nodeAt(node.operand));
    const branches: BranchRead[] | undefined = this.nodes ? [] : undefined;
    const held = this.memberType(guarded, node.field, node.fieldRange, presence, false, guarded, subject, subject, branches, node.operand);
    this.nodes?.locate(node, this.readNode(guarded, node.field));
    // Reading through an optional answers an optional, whichever form the read is
    // written in: that is what makes a chain of reads over a value that may be absent
    // stay one expression instead of needing a guard at every step.
    // A read through an optional is one value, the optional, whichever branch it read.
    const wrapped = node.optional || guarded.kind === "optional";
    if (branches && !wrapped) this.nodes!.unionRead(node, branches);
    return wrapped ? optionalOf(held) : held;
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
    const provenance = this.context.variableProvenance?.(split.name);
    this.reads?.readRegistration(provenance);
    let at = this.nodes?.registration(provenance);
    for (const segment of chain.segments.slice(chain.segments.length - split.rest.length)) {
      const read = this.memberType(held, segment.name, segment.range, false, false, held, at);
      at = this.readNode(held, segment.name);
      // Reading through an optional answers an optional, as a select does.
      held = held.kind === "optional" ? optionalOf(read) : read;
    }
    this.nodes?.locate(node, at);
    return held;
  }

  private isBound(name: string): boolean {
    return this.scopes.some((scope) => scope.has(name));
  }

  /**
   * The key a chain's proofs are held under here: the absolute spelling wherever its root is
   * bound by nothing, so a guard on `x.a` outside a binding of `x` proves `.x.a` and the
   * reverse, while one rooted at a bound name stays that binding's.
   */
  private proofKey(chain: string): string {
    const root = chainTextRoot(chain);
    return root === undefined || this.isBound(root) ? chain : `.${chain}`;
  }

  /**
   * The type of a named member, reported against whatever the operand turned out to be.
   * `subject` is the node the operand was read from, and `wholeSubject` the node `whole` was.
   * `branches` collects what each branch of a union operand answered, and `operandNode` is the
   * operand as written, where the read has one.
   */
  private memberType(
    operand: CelType,
    field: string,
    range: SourceRange,
    presence = false,
    layered = false,
    whole = operand,
    subject?: SchemaDependency,
    wholeSubject = subject,
    branches?: BranchRead[],
    operandNode?: CelNode,
  ): CelType {
    if (isDyn(operand) || operand.kind === "parameter") return DYN;
    if (operand.kind === "optional") {
      // Exactly one optional layer is read through, as at runtime.
      if (layered || operand.value.kind === "optional") {
        this.report("CEL_TYPE_ERROR", nestedOptionalMessage(whole), range, { schemaNode: wholeSubject });
        return DYN;
      }
      return this.memberType(operand.value, field, range, presence, true, whole, subject, wholeSubject, branches, operandNode);
    }
    if (operand.kind === "union") {
      const judged = this.partlyDeclared(operand, field, layered, presence, range, subject, (type) => holdsMembers(type, layered), operandNode);
      return this.joined(
        judged.map((member) => {
          const type = this.memberType(member, field, range, presence, layered, whole, this.branchNode(operand, member, subject), wholeSubject, undefined, operandNode);
          branches?.push({ type, schemaNode: this.readNode(member, field) });
          return type;
        }),
      );
    }
    if (operand.kind === "record") return this.recordMemberType(operand, field, range, presence, subject);
    if (operand.kind === "nominal" && operand.fields) return this.fieldType(operand, field, range, subject);
    if (operand.kind === "map") {
      if (!assignable(STRING, operand.key)) {
        this.report(
          "CEL_TYPE_ERROR",
          `${formatType(operand)} is keyed by ${formatType(operand.key)}, so ${JSON.stringify(field)} cannot name an entry of it`,
          range,
          { schemaNode: subject },
        );
        return DYN;
      }
      this.reads?.readMember(operand, ELEMENT_EDGE);
      return operand.value;
    }
    this.report("CEL_TYPE_ERROR", `${formatType(operand)} holds no members`, range, { schemaNode: subject });
    return DYN;
  }

  /**
   * The branches of a union a read of a named member is judged against. A member only some
   * shapes declare is absent from the closed shapes lacking it: a presence read asks that,
   * and any other read of it is one refusal in their place, at the node holding the union.
   */
  private partlyDeclared(
    union: Extract<CelType, { kind: "union" }>,
    member: string,
    layered: boolean,
    presence: boolean,
    range: SourceRange,
    subject: SchemaDependency | undefined,
    holds: (type: CelType) => boolean,
    operandNode?: CelNode,
  ): readonly CelType[] {
    const judged = presenceBranches(union, holds, presence);
    if (!union.members.some((branch) => canHoldMember(branch, member, layered))) return judged;
    const lacking = union.members.filter((branch) => lacksMember(branch, member, layered));
    if (lacking.length === 0) return judged;
    if (!presence) {
      this.report("CEL_UNKNOWN_FIELD", partlyDeclaredMessage(member) + discriminantHint(union, member, operandNode), range, {
        schemaNode: subject,
      });
    }
    return judged.filter((branch) => !lacking.includes(branch));
  }

  /** The node a union's branch was read from, else the node the union was. */
  private branchNode(union: Extract<CelType, { kind: "union" }>, member: CelType, subject: SchemaDependency | undefined): SchemaDependency | undefined {
    if (!this.nodes) return undefined;
    return this.nodes.unionMember(union, union.members.indexOf(member)) ?? subject;
  }

  /**
   * The members a read over a union's branches answers. A member the union drops as equal
   * to another is read whole: the answer would differ if it differed.
   */
  private joined(members: readonly CelType[]): CelType {
    const type = unionOf(members);
    if (this.reads) {
      for (const member of members) if (!keptIn(type, member)) this.reads.readWhole(member);
    }
    return type;
  }

  /**
   * A named member of a record: a declared field as declared; a member declared absent, or
   * matched by a pattern admitting no value, absent to a presence read and refused otherwise;
   * one patterns match, typed as their meet; any other, typed as the record's undeclared
   * members, or refused where the record is closed.
   */
  private recordMemberType(
    record: RecordType,
    field: string,
    range: SourceRange,
    presence: boolean,
    subject?: SchemaDependency,
  ): CelType {
    const reading = readRecordMember(record, field);
    // A member's node is read either way: typed, or admitting no value.
    if (this.reads) {
      for (const edge of reading.edges) this.reads.readMember(record, edge);
      for (const type of reading.whole) this.reads.readWhole(type);
    }
    if (reading.type !== undefined) return reading.type;
    if (reading.absent) {
      if (presence) return DYN;
      this.report(
        "CEL_UNKNOWN_FIELD",
        `${JSON.stringify(field)} is declared absent here — its schema admits no value — so only a presence test (has(…), .?${field}) reads it`,
        range,
        { schemaNode: (reading.placed === undefined ? undefined : this.nodes?.member(record, reading.placed)) ?? subject, absent: true },
      );
      return DYN;
    }
    const declared = [...record.fields.keys()];
    const patterns = recordPatterns(record);
    this.report(
      "CEL_UNKNOWN_FIELD",
      `${JSON.stringify(field)} is not declared here${declared.length === 0 ? "" : ` (declared: ${declared.join(", ")})`}${
        patterns.length === 0 ? "" : `${declared.length === 0 ? "" : ","} and matches none of its patterns (${patterns.join(", ")})`
      }`,
      range,
      { schemaNode: subject },
    );
    return DYN;
  }

  /**
   * A record read by a key no literal names: any member it may hold, so the union of every
   * field, pattern and undeclared member type — `dyn` where one is, or where it holds none —
   * each read from its own node.
   */
  private computedMemberType(record: RecordType, branches?: BranchRead[]): CelType {
    if (this.reads) for (const edge of recordMemberEdges(record)) this.reads.readMember(record, edge);
    const members = recordMembers(record);
    if (branches && this.nodes) {
      for (const [edge, type] of members) branches.push({ type, schemaNode: this.nodes.member(record, edge) });
    }
    return unionOf(members.map(([, type]) => type));
  }

  /**
   * A field of a host's named type: the type its definition declares, and any other name is
   * unknown — the definition is the type's whole member set, as a closed record's
   * properties are.
   */
  private fieldType(type: NominalType, field: string, range: SourceRange, subject?: SchemaDependency): CelType {
    const held = type.fields!.get(field);
    if (held) return held;
    this.report("CEL_UNKNOWN_FIELD", unknownFieldMessage(type, field), range, { schemaNode: subject });
    return DYN;
  }

  private indexType(node: Extract<CelNode, { kind: "index" }>): CelType {
    const operand = this.typeOfOperand(node.operand);
    const index = this.typeOf(node.index);
    const guarded = this.checkNullable(node.operand, operand, "[…]", node.range);
    const subject = this.narrowedNode(operand, guarded, this.nodeAt(node.operand));
    const branches: BranchRead[] | undefined = this.nodes ? [] : undefined;
    const held = this.elementType(guarded, index, node, node.optional, false, guarded, subject, subject, branches);
    this.nodes?.locate(node, this.readNode(guarded, literalKey(node), literalPosition(node)));
    const wrapped = node.optional || guarded.kind === "optional";
    if (branches && !wrapped) this.nodes!.unionRead(node, branches);
    return wrapped ? optionalOf(held) : held;
  }

  private elementType(
    operand: CelType,
    index: CelType,
    node: Extract<CelNode, { kind: "index" }>,
    presence = false,
    layered = false,
    whole = operand,
    subject?: SchemaDependency,
    wholeSubject = subject,
    branches?: BranchRead[],
  ): CelType {
    if (isDyn(operand) || operand.kind === "parameter") return DYN;
    if (operand.kind === "optional") {
      // Exactly one optional layer is read through, as at runtime.
      if (layered || operand.value.kind === "optional") {
        this.report("CEL_TYPE_ERROR", nestedOptionalMessage(whole), node.range, { schemaNode: wholeSubject });
        return DYN;
      }
      return this.elementType(operand.value, index, node, presence, true, whole, subject, wholeSubject, branches);
    }
    if (operand.kind === "union") {
      const key = literalKey(node);
      const holds = (type: CelType) => holdsElements(type, layered);
      const judged =
        key === undefined
          ? presenceBranches(operand, holds, presence)
          : this.partlyDeclared(operand, key, layered, presence, node.index.range, subject, holds, node.operand);
      return this.joined(
        judged.map((member) => {
          const type = this.elementType(member, index, node, presence, layered, whole, this.branchNode(operand, member, subject), wholeSubject);
          branches?.push({ type, schemaNode: this.readNode(member, literalKey(node), literalPosition(node)) });
          return type;
        }),
      );
    }
    if (operand.kind === "list") {
      if (!assignable(index, INT) && !isDyn(index)) {
        this.report(
          "CEL_TYPE_ERROR",
          `a list is indexed by int, and this index is ${formatType(index)}`,
          node.index.range,
          { schemaNode: this.nodeAt(node.index) },
        );
      }
      return this.positionType(operand, literalPosition(node), presence, node.index.range, subject);
    }
    if (operand.kind === "map") {
      if (!assignable(index, operand.key) && !isDyn(index)) {
        this.report(
          "CEL_TYPE_ERROR",
          `${formatType(operand)} is indexed by ${formatType(operand.key)}, and this index is ${formatType(index)}`,
          node.index.range,
          { schemaNode: this.nodeAt(node.index) },
        );
      }
      this.reads?.readMember(operand, ELEMENT_EDGE);
      return operand.value;
    }
    if (operand.kind === "record") {
      const literal = node.index.kind === "literal" && node.index.literal.type === "string";
      if (literal) {
        return this.recordMemberType(
          operand,
          (node.index as { literal: { value: string } }).literal.value,
          node.index.range,
          presence,
          subject,
        );
      }
      return this.computedMemberType(operand, branches);
    }
    if (operand.kind === "nominal" && operand.fields) {
      if (node.index.kind === "literal" && node.index.literal.type === "string") {
        return this.fieldType(operand, (node.index as { literal: { value: string } }).literal.value, node.index.range, subject);
      }
      if (!assignable(index, STRING) && !isDyn(index)) {
        this.report(
          "CEL_TYPE_ERROR",
          `${formatType(operand)} is read by field name, and this index is ${formatType(index)}`,
          node.index.range,
          { schemaNode: this.nodeAt(node.index) },
        );
      }
      return DYN;
    }
    this.report("CEL_TYPE_ERROR", `${formatType(operand)} holds no elements`, node.range, { schemaNode: subject });
    return DYN;
  }

  /**
   * An element of a list: a tuple's position where a literal index names one, its rest past
   * them — refused where it has none, unless the read asks for presence — and the element
   * for any other index.
   */
  private positionType(
    list: ListType,
    position: number | undefined,
    presence: boolean,
    range: SourceRange,
    subject: SchemaDependency | undefined,
  ): CelType {
    const edge = tupleEdge(list, position);
    if (edge === undefined) {
      this.reads?.readMember(list, ELEMENT_EDGE);
      return list.element;
    }
    this.reads?.readMember(list, edge);
    if (edge !== ADDITIONAL_EDGE) return list.prefixElements![Number(edge)]!;
    if (list.additionalElements !== undefined) return list.additionalElements;
    if (!presence) {
      this.report(
        "CEL_TYPE_ERROR",
        `${formatType(list)} holds ${list.prefixElements!.length} positions, and index ${position} is past them`,
        range,
        { schemaNode: subject },
      );
    }
    return DYN;
  }

  private binaryType(node: Extract<CelNode, { kind: "binary" }>): CelType {
    if (node.operator === "&&" || node.operator === "||") {
      const left = this.typeOf(node.left);
      const proofs = node.operator === "&&" ? provenWhereTrue(node.left) : provenWhereFalse(node.left);
      const right = this.withProven(proofs, () => this.typeOf(node.right));
      for (const [type, operand] of [
        [left, node.left],
        [right, node.right],
      ] as const) {
        if (!isDyn(type) && !assignable(type, BOOL)) {
          this.report(
            "CEL_TYPE_ERROR",
            `${node.operator} joins bool values, and ${formatType(type)} is not one`,
            node.range,
            { schemaNode: this.nodeAt(operand) },
          );
        }
      }
      return BOOL;
    }
    return this.operatorType(node.operator, [node.left, node.right], node.range, node);
  }

  private conditionalType(node: Extract<CelNode, { kind: "conditional" }>): CelType {
    const condition = this.typeOf(node.condition);
    if (!isDyn(condition) && !assignable(condition, BOOL)) {
      this.report(
        "CEL_TYPE_ERROR",
        `a condition must be bool, and this one is ${formatType(condition)}`,
        node.condition.range,
        { schemaNode: this.nodeAt(node.condition) },
      );
    }
    const whenTrue = this.withProven(provenWhereTrue(node.condition), () => this.typeOf(node.whenTrue));
    const whenFalse = this.withProven(provenWhereFalse(node.condition), () => this.typeOf(node.whenFalse));
    this.nodes?.relay(node, [
      [node.whenTrue, whenTrue],
      [node.whenFalse, whenFalse],
    ]);
    const unified = unify(whenTrue, whenFalse);
    // A value read out of a conditional has one type, so two branches that share none
    // is a mistake rather than a `dyn`: whoever reads it would be reading two things.
    if (isDyn(unified) && !isDyn(whenTrue) && !isDyn(whenFalse)) {
      this.report(
        "CEL_TYPE_ERROR",
        `the branches of a condition answer ${formatType(whenTrue)} and ${formatType(whenFalse)}, which are not one type`,
        node.range,
        { schemaNode: this.firstNode([node.whenTrue, node.whenFalse]) },
      );
    }
    return unified;
  }

  private withProven<T>(proofs: readonly Proof[], body: () => T): T {
    if (proofs.length === 0) return body();
    const outer = this.proven;
    this.proven = this.withProofs(outer, proofs);
    try {
      return body();
    } finally {
      this.proven = outer;
    }
  }

  private withProofs(
    held: ReadonlyMap<string, readonly Fact[]>,
    proofs: readonly Proof[],
  ): ReadonlyMap<string, readonly Fact[]> {
    if (proofs.length === 0) return held;
    const next = new Map(held);
    for (const proof of proofs) {
      const fact = this.factOf(proof);
      if (!fact) continue;
      const key = this.proofKey(fact.chain);
      next.set(key, [...(next.get(key) ?? []), fact]);
    }
    return next;
  }

  /**
   * What a proof says once its comparison is typed: a type test names the runtime type its
   * chain was compared with, and is no proof where the other side named none.
   */
  private factOf(proof: Proof): Fact | undefined {
    if (proof.equals !== undefined) return { chain: proof.chain, equals: proof.equals };
    if (proof.typeTest === undefined) return proof.member === undefined ? { chain: proof.chain } : { chain: proof.chain, member: proof.member };
    const typeKey = this.typeTestKeys.get(proof.typeTest.comparison)?.get(proof.chain);
    return typeKey === undefined ? undefined : { chain: proof.chain, typeKey, holds: proof.typeTest.holds };
  }

  /**
   * Which runtime type each chain a comparison tests with `type(chain)` is compared with: the
   * other side is a name denoting a type value, or `type(e)` over a single known type.
   */
  private recordTypeTest(comparison: CelNode, operands: readonly CelNode[], args: readonly CelType[]): void {
    const keys = new Map<string, string>();
    for (const [side, other] of [
      [0, 1],
      [1, 0],
    ] as const) {
      const chain = typeTestedChain(operands[side]!);
      if (chain === undefined || !isTypeValue(args[side]!)) continue;
      const key = this.comparedTypeKey(operands[other]!, args[other]!);
      if (key !== undefined && !keys.has(chain)) keys.set(chain, key);
    }
    if (keys.size > 0) this.typeTestKeys.set(comparison, keys);
  }

  /** The runtime type a type test's other side names, where it names exactly one. */
  private comparedTypeKey(node: CelNode, type: CelType): string | undefined {
    if (!isTypeValue(type)) return undefined;
    if (isTypeCall(node)) {
      const argument = this.typeArguments.get(node);
      return argument === undefined ? undefined : runtimeTypeKey(argument);
    }
    const chain = chainText(node);
    const root = chain === undefined ? undefined : chainTextRoot(chain);
    if (chain === undefined || (root !== undefined && this.isBound(root))) return undefined;
    const named = this.context.typeNamed(root === undefined ? chain.slice(1) : chain);
    return named === undefined ? undefined : runtimeTypeKey(named);
  }

  private provenNonNull(chain: string): boolean {
    return (
      this.proven.get(this.proofKey(chain))?.some((proof) => proof.member === undefined && proof.typeKey === undefined && proof.equals === undefined) ?? false
    );
  }

  /**
   * A plain chain's type where a guard proved something of it: without null where it is
   * proven non-null, only the shapes holding a member `has()` proved it holds, only the
   * members a type test left, and only those an equality or membership test left. A narrowing
   * leaving nothing leaves the type as it is. It is located at the remaining branch's node.
   */
  private narrowed(node: CelNode, type: CelType): CelType {
    if (this.proven.size === 0 || type.kind !== "union") return type;
    const chain = chainText(node);
    const proofs = chain === undefined ? undefined : this.proven.get(this.proofKey(chain));
    if (!proofs) return type;
    let narrowed: CelType = type;
    for (const proof of proofs) {
      if (proof.typeKey !== undefined) {
        if (narrowed.kind !== "union") continue;
        const { typeKey, holds } = proof;
        const kept = narrowed.members.filter((member) => {
          const key = runtimeTypeKey(member);
          return key === undefined || (key === typeKey) === holds;
        });
        if (kept.length > 0 && kept.length < narrowed.members.length) narrowed = unionOf(kept);
      } else if (proof.equals !== undefined) {
        if (narrowed.kind !== "union") continue;
        const equals = proof.equals;
        const kept = narrowed.members.filter((member) =>
          equals.member === undefined ? mayEqualAny(member, equals.values) : discriminantKeeps(member, equals.member, equals),
        );
        if (kept.length > 0 && kept.length < narrowed.members.length) narrowed = unionOf(kept);
      } else if (proof.member === undefined) {
        narrowed = withoutNull(narrowed);
      } else if (narrowed.kind === "union") {
        const member = proof.member;
        const holding = narrowed.members.filter((branch) => canHoldMember(branch, member));
        if (holding.length > 0) narrowed = unionOf(holding);
      }
    }
    if (narrowed !== type) this.nodes?.locate(node, this.narrowedNode(type, narrowed, this.nodeAt(node)));
    return narrowed;
  }

  /**
   * A dereference of something that may be null. The type is answered with null taken
   * out either way, so one missing guard is one diagnostic rather than a cascade.
   */
  private checkNullable(operand: CelNode, type: CelType, access: string, range: SourceRange): CelType {
    if (!admitsNull(type)) return type;
    const chain = chainText(operand);
    if (chain === undefined || this.provenNonNull(chain)) return withoutNull(type);
    if (type.kind === "primitive") {
      this.report("CEL_TYPE_ERROR", `null holds no members`, range, { schemaNode: this.nodeAt(operand) });
      return DYN;
    }
    this.report(
      "CEL_NULLABLE_ACCESS",
      `${JSON.stringify(chain)} may be null — guard it (e.g. '${chain} != null && …' or '${chain} == null ? … : ${chain}${access}') before reading ${access}`,
      range,
      { schemaNode: this.nodeAt(operand) },
    );
    return withoutNull(type);
  }

  private operatorType(operator: string, operands: readonly CelNode[], range: SourceRange, node?: CelNode): CelType {
    const args = operands.map((operand) => this.typeOf(operand));
    const equality = operator === "==" || operator === "!=";
    if (equality && node !== undefined && operands.some(isTypeCall)) this.recordTypeTest(node, operands, args);
    // Null is comparable with every type: otherwise declaring a value nullable would make it
    // untestable, and the guard that clears a nullable read would itself be a type error.
    if (equality && args.some(isNullType)) return BOOL;
    const resolution = this.context.registry.resolve(operator, "global", args);
    if ("resolved" in resolution) return resolution.returns;
    // An equality, or membership in a list, is defined when either side is null, so it is
    // resolved on the values besides null.
    const nonNull = withoutNullCompared(operator, args);
    if (nonNull) {
      const compared = this.context.registry.resolve(operator, "global", nonNull);
      if ("resolved" in compared) return compared.returns;
    }
    if (equality) {
      const overlap = this.overlapping(operator, args);
      if (overlap) return overlap;
    }
    // An equality is judged by overlap alone; membership expands its container.
    const expansion = equality
      ? undefined
      : operator === "in" && args.length === 2
        ? this.membership(args[0]!, args[1]!)
        : this.context.registry.resolveExpanded(operator, "global", args);
    if (expansion?.kind === "resolved") return expansion.returns;
    const mismatch = this.typeArgumentMismatch([...args, ...this.candidateTypes(resolution)]);
    const described = describeArguments(args);
    this.report(
      mismatch ? "CEL_TYPE_ARGUMENT_MISMATCH" : "CEL_TYPE_ERROR",
      mismatch ??
        expansionMessage(
          `no ${JSON.stringify(operator)} is declared over ${described}`,
          `${JSON.stringify(operator)} over ${described}`,
          expansion,
          describeArguments,
        ),
      range,
      mismatch ? {} : { schemaNode: this.expansionNode(expansion, args, operands) ?? this.firstNode(operands) },
    );
    return DYN;
  }

  /**
   * An equality whose sides share a type: some member of one side and some member of the
   * other resolve it. `1 == 'a'` shares none.
   */
  private overlapping(operator: string, args: readonly CelType[]): CelType | undefined {
    if (args.length !== 2) return undefined;
    for (const left of expandedMembers(args[0]!)) {
      for (const right of expandedMembers(args[1]!)) {
        if (left === args[0] && right === args[1]) continue;
        const resolution = this.context.registry.resolve(operator, "global", [left, right]);
        if ("resolved" in resolution) return resolution.returns;
      }
    }
    return undefined;
  }

  /**
   * Membership over each member of the container: every one must take the element, as a call
   * over a union does, and each judges it by overlap against what it holds — a list's element
   * members, a map's key members.
   */
  private membership(element: CelType, container: CelType): Expansion | undefined {
    const containers = expandedMembers(container);
    if (containers.length > UNION_EXPANSION_LIMIT) return { kind: "limit" };
    const returns: CelType[] = [];
    for (const [at, held] of containers.entries()) {
      const returned = this.memberIn(element, held);
      if (returned === undefined) {
        return container.kind === "union" ? { kind: "untaken", combination: [element, held], members: [0, at] } : undefined;
      }
      returns.push(returned);
    }
    return { kind: "resolved", overloads: [], returns: returns.some(isDyn) ? DYN : unionOf(returns) };
  }

  /** `in` over one container: as written, else by overlap of the element's members with what it holds. */
  private memberIn(element: CelType, container: CelType): CelType | undefined {
    const written = this.context.registry.resolve("in", "global", [element, container]);
    if ("resolved" in written) return written.returns;
    const held =
      container.kind === "list"
        ? expandedMembers(container.element).map(listOf)
        : container.kind === "map"
          ? expandedMembers(container.key).map((key) => mapOf(key, container.value))
          : [container];
    for (const member of expandedMembers(element)) {
      for (const holding of held) {
        const resolution = this.context.registry.resolve("in", "global", [member, holding]);
        if ("resolved" in resolution) return resolution.returns;
      }
    }
    return undefined;
  }

  /**
   * The node a refusal over a union's combination names: that of the first member the failing
   * combination took, else of the operand holding it.
   */
  private expansionNode(
    expansion: Expansion | undefined,
    positions: readonly CelType[],
    operands: readonly CelNode[],
  ): SchemaDependency | undefined {
    if (!this.nodes || expansion?.kind !== "untaken") return undefined;
    for (const [at, position] of positions.entries()) {
      if (position.kind !== "union" || expansion.combination[at] === position) continue;
      return this.nodes.unionMember(position, expansion.members[at]!) ?? this.nodeAt(operands[at]!);
    }
    return undefined;
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
    if (isTypeCall(node)) this.typeArguments.set(node, args[0]!);
    const resolution = this.context.registry.resolve(node.name, form, args, receiver);
    if ("resolved" in resolution) {
      this.calls.push(this.dispatched(node, form, args.length, resolution.resolved, resolution.returns));
      this.checkLiteralArguments(node, resolution.resolved);
      return resolution.returns;
    }
    const expansion =
      resolution.reason === "no-overload" ? this.context.registry.resolveExpanded(node.name, form, args, receiver) : undefined;
    if (expansion?.kind === "resolved") {
      // Each distinct overload is listed once, in combination order; one literal refusal is enough.
      for (const overload of expansion.overloads) {
        this.calls.push(this.dispatched(node, form, args.length, overload.resolved, overload.returns));
      }
      for (const overload of expansion.overloads) if (this.checkLiteralArguments(node, overload.resolved)) break;
      return expansion.returns;
    }
    this.calls.push({ name: node.name, form, arity: args.length, range: node.range });
    this.reportCallFailure(node, form, args, receiver, resolution, expansion);
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
  ): boolean {
    const check = resolved.metadata.checkArguments;
    if (check === undefined) return false;
    const written = node.kind === "receiverCall" ? [node.receiver, ...node.args] : node.args;
    const refusal = check(
      written.map((argument) => (argument.kind === "literal" ? literalValue(argument.literal) : undefined)),
    );
    if (refusal === undefined) return false;
    const source = this.expression.source.slice(node.range[0], node.range[1]);
    this.report("CEL_INVALID_ARGUMENT", `${refusal} (in \`${source}\`)`, node.range);
    return true;
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
    expansion?: Expansion,
  ): void {
    const written = `${node.name}(${describeArguments(args)})`;
    if (failure.reason === "unknown") {
      this.report(
        "CEL_UNKNOWN_FUNCTION",
        `no function named ${JSON.stringify(node.name)} is registered${this.closestNames(node.name, form, args.length)}`,
        node.range,
        { fix: this.renameFix(node) },
      );
      return;
    }
    if (failure.reason === "wrong-form") {
      const wanted = form === "global" ? "on a value" : "without a receiver";
      this.report(
        "CEL_WRONG_CALL_FORM",
        `${JSON.stringify(node.name)} is called ${wanted}: ${describeCandidates(failure.candidates)}`,
        node.range,
        { fix: this.formFix(node) },
      );
      return;
    }
    const mismatch = this.typeArgumentMismatch([
      ...(receiver ? [receiver] : []),
      ...args,
      ...this.candidateTypes(failure),
    ]);
    const on = form === "receiver" ? `${formatType(receiver ?? DYN)}.` : "";
    const combinationText = (combination: readonly CelType[]) =>
      receiver === undefined
        ? `${node.name}(${describeArguments(combination)})`
        : `${formatType(combination[0]!)}.${node.name}(${describeArguments(combination.slice(1))})`;
    const operands = node.kind === "receiverCall" ? [node.receiver, ...node.args] : node.args;
    this.report(
      mismatch ? "CEL_TYPE_ARGUMENT_MISMATCH" : "CEL_TYPE_ERROR",
      mismatch ??
        expansionMessage(
          `no overload of ${JSON.stringify(node.name)} takes ${on}${written}: ${describeCandidates(failure.candidates)}`,
          `${on}${written}`,
          expansion,
          combinationText,
        ),
      node.range,
      mismatch
        ? {}
        : {
            schemaNode:
              this.expansionNode(expansion, receiver === undefined ? args : [receiver, ...args], operands) ??
              this.firstNode(operands),
          },
    );
  }

  /**
   * What a call on an unregistered name is offered instead: the registered names that
   * accept its form and arity, nearest first, as a clause to hang off the refusal.
   *
   * **The alternatives belong in the MESSAGE, and the fix stays singular.** A reader of
   * `no('x')` is one name away from the five functions that would have worked, and the
   * engine this one replaces said so; losing it is a real loss of help. A list of five
   * repairs, though, is not a repair — an editor applying one would be guessing which
   * function the author meant — so the single rename fix is still offered only where
   * exactly one name is a case-insensitive match.
   *
   * It names no command and no tool: which listing a host offers is the host's, and an
   * engine embedded in one with no CLI would be pointing at nothing.
   */
  private closestNames(name: string, form: CallForm, arity: number): string {
    const candidates = this.context.registry.candidateNames(name, form, arity);
    if (candidates.length === 0) return "";
    const written = arity === 0 ? "no arguments" : arity === 1 ? "1 argument" : `${arity} arguments`;
    const shape = form === "receiver" ? `written on a value with ${written}` : `taking ${written}`;
    return ` — the closest ${shape}: ${candidates.join(", ")}`;
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
        ...argumentTypesOf(args),
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
      ...argumentTypesOf(args),
      ...(declared.signature === undefined ? {} : { signature: declared.signature }),
      returns: formatType(withoutParameters(declared.returns)),
      deterministic: declared.deterministic ?? true,
      hostBacked: declared.hostBacked ?? false,
      ...(declared.throws ? { throws: declared.throws } : {}),
    });
    // A type the host named and its own registry does not carry: the declaration stands,
    // reads `dyn` where that type stood, and the disagreement is a verdict HERE — this is
    // the only place the name has a range.
    const unregistered = declared.unregisteredTypes ?? [];
    if (unregistered.length > 0) {
      const names = unregistered.map((name) => JSON.stringify(name)).join(", ");
      this.report(
        "CEL_TYPE_ERROR",
        unregistered.length === 1
          ? `${qualified} is declared over the type ${names}, and no type is registered under that name`
          : `${qualified} is declared over the types ${names}, and no type is registered under those names`,
        node.range,
      );
    }
    const resultProvenance = this.context.namespaceResultProvenance?.(node.namespace, node.name);
    this.reads?.readRegistration(resultProvenance);
    this.nodes?.locate(node, this.nodes.registration(resultProvenance));
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

/** The position an index names when it is written as an int literal at or past zero. */
function literalPosition(node: Extract<CelNode, { kind: "index" }>): number | undefined {
  if (node.index.kind !== "literal" || node.index.literal.type !== "int") return undefined;
  const value = (node.index as { literal: { value: bigint } }).literal.value;
  return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

/** The member edge a literal position reads of a tuple: the position's, or the rest's past them. */
function tupleEdge(list: ListType, position: number | undefined): EdgeKey | undefined {
  if (!list.prefixElements || position === undefined) return undefined;
  return position < list.prefixElements.length ? String(position) : ADDITIONAL_EDGE;
}

/** The member an index names when it is written as a string literal. */
function literalKey(node: Extract<CelNode, { kind: "index" }>): string | undefined {
  return node.index.kind === "literal" && node.index.literal.type === "string"
    ? (node.index as { literal: { value: string } }).literal.value
    : undefined;
}

/**
 * The operands of an equality, or of membership in a list, with null taken out at every
 * depth, when either may hold a null; nothing for any other operator. Both are defined
 * whatever null either side holds.
 */
function withoutNullCompared(operator: string, args: readonly CelType[]): readonly CelType[] | undefined {
  if (args.length !== 2) return undefined;
  if (operator !== "==" && operator !== "!=" && !(operator === "in" && args[1]!.kind === "list")) return undefined;
  const compared = args.map(withoutNullAtDepth);
  return compared.every((type, at) => type === args[at]) ? undefined : compared;
}

/** The type with null taken out of every union in it, through lists, maps and optionals. */
function withoutNullAtDepth(type: CelType): CelType {
  return nullTakenOut(type, new Map());
}

/** {@link withoutNullAtDepth}, each type object answered once per call. */
function nullTakenOut(type: CelType, answered: Map<CelType, CelType>): CelType {
  countTypeVisit();
  if (type.kind !== "union" && type.kind !== "list" && type.kind !== "map" && type.kind !== "optional") return type;
  const held = answered.get(type);
  if (held !== undefined) return held;
  const answer = nullTakenOutOnce(type, answered);
  answered.set(type, answer);
  return answer;
}

function nullTakenOutOnce(type: UnionType | ListType | MapType | OptionalType, answered: Map<CelType, CelType>): CelType {
  const beneath = (held: CelType) => nullTakenOut(held, answered);
  switch (type.kind) {
    case "union": {
      const members = type.members.filter((member) => !(member.kind === "primitive" && member.name === "null"));
      if (members.length === 0) return type;
      const held = members.map(beneath);
      return held.length === type.members.length && held.every((member, at) => member === type.members[at]) ? type : unionOf(held);
    }
    case "list": {
      const element = beneath(type.element);
      return element === type.element ? type : listOf(element);
    }
    case "map": {
      const key = beneath(type.key);
      const value = beneath(type.value);
      return key === type.key && value === type.value ? type : mapOf(key, value);
    }
    case "optional": {
      const value = beneath(type.value);
      return value === type.value ? type : optionalOf(value);
    }
  }
}

/** Whether a type is null itself. */
function isNullType(type: CelType): boolean {
  return type.kind === "primitive" && type.name === "null";
}

/** A value whose `type()` answers a type, as `string` or `type(1)` does. */
function isTypeValue(type: CelType): boolean {
  return type.kind === "primitive" && type.name === "type";
}

/**
 * What `type()` answers for a value of a type, where one answer holds for all of them: `list`
 * for any list, `map` for any map or record, the primitive or well-known type, a registered
 * type's name. Nothing for `dyn`, a bare parameter or a union.
 */
function runtimeTypeKey(type: CelType): string | undefined {
  switch (type.kind) {
    case "primitive":
      return type.name;
    case "list":
      return "list";
    case "map":
    case "record":
      return "map";
    case "optional":
      return "optional";
    case "nominal":
      return `nominal:${type.name}`;
    default:
      return undefined;
  }
}

/**
 * A refusal over a union's combinations: past the limit its own sentence, a combination no
 * overload takes named after the refusal as written.
 */
function expansionMessage(
  written: string,
  call: string,
  expansion: Expansion | undefined,
  combinationText: (combination: readonly CelType[]) => string,
): string {
  if (expansion?.kind === "limit") {
    return `${call} holds more than ${UNION_EXPANSION_LIMIT} combinations of its arguments' types; narrow one with a type test`;
  }
  if (expansion?.kind === "untaken") return `${written}; ${combinationText(expansion.combination)} is taken by none`;
  return written;
}

/** What the guards around a walk know of a chain: a proof, its type test typed. */
interface Fact {
  readonly chain: string;
  readonly member?: string;
  readonly typeKey?: string;
  readonly holds?: boolean;
  readonly equals?: EqualityProof;
}

/** Whether a value of the type may equal one of the values: by the runtime type each value has. */
function mayEqualAny(type: CelType, values: readonly CelValue[]): boolean {
  return values.some((value) => mayEqual(type, value));
}

function mayEqual(type: CelType, value: CelValue): boolean {
  if (isDyn(type) || type.kind === "parameter") return true;
  if (type.kind === "union") return type.members.some((member) => mayEqual(member, value));
  if (type.kind !== "primitive") return false;
  if (value === null) return type.name === "null";
  if (typeof value === "boolean") return type.name === "bool";
  if (typeof value === "string") return type.name === "string";
  return isNumeric(type);
}

/**
 * Whether a member of a union stays where `<chain>.<member>` equals one of the values
 * (`holds`) or none of them: a shape declaring the member by its finite set — a value the
 * runtime's `==` finds equal to a listed one, or one outside them — or, with none, where the
 * test holds by whether its type can have a listed value's; a shape that cannot hold the
 * member, or holds no members, dropped; an open record not declaring it, a map, an optional
 * and `dyn` kept.
 */
function discriminantKeeps(type: CelType, member: string, equals: EqualityProof): boolean {
  const listed = (value: FieldEnumValue) => equals.values.some((other) => celEqual(value, other));
  if (type.kind === "record") {
    const reading = readRecordMember(type, member);
    if (reading.absent) return false;
    const declared = type.fields.has(member);
    if (!declared && type.additionalFields !== undefined) return true;
    if (reading.type === undefined) return false;
    const set = declared ? type.fieldEnums?.get(member) : undefined;
    if (set) return equals.holds ? set.some(listed) : set.some((value) => !listed(value));
    return !equals.holds || mayEqualAny(reading.type, equals.values);
  }
  if (type.kind === "nominal") {
    const field = type.fields?.get(member);
    return field !== undefined && (!equals.holds || mayEqualAny(field, equals.values));
  }
  return type.kind !== "primitive" && type.kind !== "list";
}

/**
 * The test telling the shapes of a union holding a member from the others, where a field
 * every shape declares with a finite set does — the first such in the first shape's written
 * order — as the tail of the refusal naming `.?<member>`.
 */
function discriminantHint(union: UnionType, member: string, operand: CelNode | undefined): string {
  const read = memberNameSource(member);
  if (operand === undefined || chainText(operand) === undefined || read === undefined) return "";
  if (!union.members.every((shape) => shape.kind === "record")) return "";
  const shapes = union.members as readonly RecordType[];
  const holding = shapes.filter((shape) => canHoldMember(shape, member));
  const others = shapes.filter((shape) => !canHoldMember(shape, member));
  if (holding.length === 0 || others.length === 0) return "";
  for (const field of shapes[0]!.fields.keys()) {
    const tested = memberNameSource(field);
    if (field === member || tested === undefined || !shapes.every((shape) => shape.fieldEnums?.has(field))) continue;
    const held = unitedSets(holding, field);
    const rest = unitedSets(others, field);
    if (held.some((value) => rest.some((other) => celEqual(value, other)))) continue;
    const chain = serializeTree(operand);
    const test =
      held.length === 1
        ? `${chain}.${tested} == ${enumValueSource(held[0]!)}`
        : `${chain}.${tested} in [${held.map(enumValueSource).join(", ")}]`;
    return `, or read it behind the test that tells the shapes apart (${test} ? ${chain}.${read} : …)`;
  }
  return "";
}

/** Every value the shapes' sets of a field hold, each once, in canonical order. */
function unitedSets(shapes: readonly RecordType[], field: string): FieldEnumValue[] {
  const values = shapes.flatMap((shape) => shape.fieldEnums!.get(field)!).sort(compareFieldEnumValues);
  return values.filter((value, at) => at === 0 || compareFieldEnumValues(values[at - 1]!, value) !== 0);
}

function enumValueSource(value: FieldEnumValue): string {
  const literal: CelLiteral =
    value === null
      ? { type: "null" }
      : typeof value === "string"
        ? { type: "string", value }
        : typeof value === "bigint"
          ? { type: "int", value }
          : typeof value === "number"
            ? { type: "double", value }
            : { type: "bool", value };
  return literalSource(literal);
}

/**
 * Which branches of a union a read is judged against.
 *
 * A **presence-shaped** read — `a.?b`, `a[?k]`, `has(a.b)` — asks whether the member is
 * THERE, so a branch that can hold no member at all is the absence case it answers
 * `optional.none()` / `false` for at runtime, not a mistake in the expression: that is how
 * a two-shape field is discriminated without a type test. Where **no** branch can hold one
 * the read is judged against them all, so an operand that is known to hold no members is
 * still refused in the presence form exactly as in the plain one.
 */
function presenceBranches(
  union: Extract<CelType, { kind: "union" }>,
  holds: (type: CelType) => boolean,
  presence: boolean,
): readonly CelType[] {
  if (!presence) return union.members;
  const holding = union.members.filter(holds);
  return holding.length > 0 ? holding : union.members;
}

function partlyDeclaredMessage(field: string): string {
  return `${JSON.stringify(field)} is declared by only some of the shapes this value may have — read it as '.?${field}' to handle the others`;
}

/**
 * Whether a value of this type can hold the named member: a record declaring it, a pattern of it matching it or open
 * and not declaring it absent, a string-keyed map, a named type with that field, or `dyn`. It is what `has()` proves.
 */
function canHoldMember(type: CelType, member: string, layered = false): boolean {
  if (isDyn(type) || type.kind === "parameter") return true;
  if (type.kind === "record") return readRecordMember(type, member).type !== undefined;
  if (type.kind === "map") return assignable(STRING, type.key);
  if (type.kind === "nominal") return type.fields?.has(member) ?? false;
  if (type.kind === "optional") return !layered && type.value.kind !== "optional" && canHoldMember(type.value, member, true);
  return false;
}

/** Whether a type holds named members, but not this one: a closed shape not declaring it. */
function lacksMember(type: CelType, member: string, layered = false): boolean {
  if (type.kind === "record") return readRecordMember(type, member).type === undefined;
  if (type.kind === "nominal") return type.fields !== undefined && !type.fields.has(member);
  if (type.kind === "optional") return !layered && type.value.kind !== "optional" && lacksMember(type.value, member, true);
  return false;
}

function nestedOptionalMessage(whole: CelType): string {
  return `${formatType(whole)} is read through one optional only; unwrap the inner optional (.value(), .orValue(…) or optFlatMap) first`;
}

/** Whether a type can hold a named member at all — what `memberType` reads one of. */
function holdsMembers(type: CelType, layered = false): boolean {
  if (isDyn(type) || type.kind === "parameter") return true;
  if (type.kind === "record" || type.kind === "map") return true;
  if (type.kind === "nominal") return type.fields !== undefined;
  if (type.kind === "optional") {
    return !layered && type.value.kind !== "optional" && holdsMembers(type.value, true);
  }
  if (type.kind === "union") return type.members.some((member) => holdsMembers(member, layered));
  return false;
}

/** Whether a type can hold an element at all — what `elementType` reads one of. */
function holdsElements(type: CelType, layered = false): boolean {
  if (isDyn(type) || type.kind === "parameter") return true;
  if (type.kind === "record" || type.kind === "map" || type.kind === "list") return true;
  if (type.kind === "nominal") return type.fields !== undefined;
  if (type.kind === "optional") {
    return !layered && type.value.kind !== "optional" && holdsElements(type.value, true);
  }
  if (type.kind === "union") return type.members.some((member) => holdsElements(member, layered));
  return false;
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

/** Whether two named types' arguments are the same types: they are invariant, compared as types and never by their text. */
function sameArguments(left: readonly CelType[], right: readonly CelType[]): boolean {
  return left.length === right.length && left.every((type, at) => typesEqual(type, right[at]!));
}

/** A namespaced call's argument types as the host reads them, and the text each prints as. */
function argumentTypesOf(args: readonly CelType[]): Pick<ResolvedCall, "argumentTypes" | "argumentTypeNames"> {
  const argumentTypes = args.map(withoutParameters);
  return { argumentTypes, argumentTypeNames: argumentTypes.map((type) => formatType(type)) };
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
    case "struct": {
      for (const [at, entry] of root.entries.entries()) {
        const value = replaceNode(entry.value, from, to);
        if (!value) continue;
        const entries = [...root.entries];
        entries[at] = { ...entry, value };
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
