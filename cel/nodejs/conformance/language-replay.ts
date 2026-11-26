/**
 * Replaying the CEL conformance vectors' language rows, whole.
 *
 * A row's `expect` is `@telorun/cel`'s whole answer, so the driver computes that answer
 * (`languageAnswer`) and deep-compares it with the row — there is no list of rows answered
 * otherwise. Beside the answer it holds every row to the format: the keys a row may carry,
 * the two classes of row (cel-spec's import, then the authored `telo/` rows), the rules of
 * `deviation`, the `celCode` vocabulary, and the round trip of every source that reads.
 *
 * Its blind spot: deep equality pins whatever this engine answered. `deviation.celSpec` is
 * the only check against cel-spec, and only on the rows that carry one.
 */

import { isDeepStrictEqual } from "node:util";
import {
  CelEnvironment,
  hasUnparsed,
  serializeTree,
  treesEqual,
  type CelEnvironmentOptions,
  type CelValue,
  type JsonSchemaNode,
  type NamespaceFunctionDeclaration,
  type NominalTypeDefinition,
  type ResolvedCall,
  type SchemaDependency,
  type SchemaRegistrationReport,
  type SchemaTypeResolver,
  type TypeDeclaration,
  schemaOwnTypesAgree,
  typesEqual,
} from "../src/index.js";
import {
  checkRefusal,
  LANGUAGE_CEL_CODES,
  recordedError,
  recordedRange,
  type RecordedError,
  type RecordedRange,
} from "./conformance-error.js";
import {
  encodeConformanceValue,
  readCanonicalConformanceValue,
  type ConformanceValue,
} from "./conformance-value.js";

/** The one file of the vectors this driver answers for. */
export const DRIVEN_FILE = "language.json";

/** How many rows the file holds. A row deleted leaves every other count true, so it is pinned. */
export const LANGUAGE_ROWS = 2189;

/** The prefix of an authored row's id: a row cel-spec's import did not produce. */
export const AUTHORED_ROW_PREFIX = "telo/";

export interface RecordedDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly range: RecordedRange;
  readonly fix?: { readonly replacement: string };
  /** Present exactly when the check names the schema node the verdict was judged at. */
  readonly schemaNode?: RecordedSchemaDependency;
  /** Present, `true`, exactly on a refusal of a member the schema declares absent. */
  readonly absent?: true;
}

/** A call the checker resolved: every field it reports, its range as `{ start, end }`. */
export interface RecordedCall {
  readonly name: string;
  readonly form: string;
  readonly namespace?: string;
  readonly arity: number;
  readonly range: RecordedRange;
  readonly signature?: string;
  readonly returns?: string;
  readonly deterministic?: boolean;
  readonly hostBacked?: boolean;
  readonly throws?: readonly string[];
  readonly argumentTypeNames?: readonly string[];
}

export interface LanguageCheck {
  readonly diagnostics: readonly RecordedDiagnostic[];
  readonly type?: string;
  readonly calls: readonly RecordedCall[];
  /** Present exactly when the row types a name from a schema. */
  readonly schemaDependencies?: readonly RecordedSchemaDependency[];
  /** Present exactly when the row types a name from a schema: every place the result may have come from. */
  readonly resultOrigins?: readonly RecordedOrigin[];
  /** Present exactly when the row has `variants`: per listed node of a varied document, whether the variant agrees there. */
  readonly variantAgreement?: readonly RecordedAgreement[];
  /** Present exactly when the row has `namedTypes`: what the check environment's conversions could not judge. */
  readonly schemaReports?: readonly RecordedSchemaReport[];
}

/** What one registration's conversion could not judge, and the references it re-entered. */
export interface RecordedSchemaReport {
  readonly name: string;
  readonly unjudged: readonly {
    readonly pointer: string;
    readonly throughReference?: string;
    readonly keywords: readonly string[];
    readonly typeName?: string;
    readonly reason: string;
  }[];
  readonly recursive: readonly { readonly pointer: string; readonly throughReference?: string; readonly reference?: string }[];
}

/** One place the check's result may have come from. */
export interface RecordedOrigin {
  readonly range: RecordedRange;
  readonly type: string;
  readonly schemaNode?: RecordedSchemaDependency;
}

/** What the row's resolver answers for a `$ref` naming a type: a type name and its arguments. */
export interface RowNamedType {
  readonly name: string;
  readonly args?: readonly string[];
}

/** Whether a document's variant agrees with it on the own type of one node the check read. */
export interface RecordedAgreement {
  readonly document: string;
  readonly pointer: string;
  readonly agrees: boolean;
}

/** A namespaced function a row declares: a whole signature, or a name and its result. */
export type RowNamespaceFunction =
  | { readonly signature: string }
  | { readonly name: string; readonly returns: string | { readonly schema: JsonSchemaNode } };

/** A schema node the check read: the row's name for its document, and the pointer. */
export interface RecordedSchemaDependency {
  readonly document: string;
  readonly pointer: string;
}

export interface LanguageExpect {
  readonly check: LanguageCheck;
  readonly value?: ConformanceValue;
  readonly error?: RecordedError;
}

export interface LanguageRow {
  readonly id: string;
  readonly source: string;
  readonly provenance?: { readonly file: string; readonly section: string; readonly test: string };
  /** The types the row registers, as definition data in registration order, none with a builder. */
  readonly types?: readonly NominalTypeDefinition[];
  readonly declarations?: Readonly<Record<string, unknown>>;
  /** Schemas a `$ref` naming one by its key resolves to, read in place of the referring node. */
  readonly documents?: Readonly<Record<string, JsonSchemaNode>>;
  /** Type names a `$ref` naming one by its key resolves to. */
  readonly namedTypes?: Readonly<Record<string, RowNamedType>>;
  readonly functions?: readonly { readonly signature: string }[];
  /** Namespaces the row registers, closed, each with the functions it declares. */
  readonly namespaces?: Readonly<Record<string, readonly RowNamespaceFunction[]>>;
  /** Another version of a document the row hands over, by the row's name for it. */
  readonly variants?: Readonly<Record<string, JsonSchemaNode>>;
  readonly bindings?: Readonly<Record<string, unknown>>;
  /** Conditions known at the source's site, each parsed in the environment it is checked in. */
  readonly assumptions?: readonly RowAssumption[];
  readonly expect: LanguageExpect;
  readonly deviation?: {
    readonly celSpec?: Readonly<Record<string, unknown>>;
    readonly reason?: string;
    readonly uncarried?: readonly string[];
  };
}

export interface RowAssumption {
  readonly condition: string;
  readonly holds: boolean;
  readonly rebound?: readonly string[];
}

const ASSUMPTION_KEYS = ["condition", "holds", "rebound"];

/** The closed set of reasons a row's answer may differ from cel-spec's. */
export const DEVIATION_REASONS = [
  /** The row calls into a cel-go extension library Telo does not ship. */
  "extension-library",
  /** The answer needs a cel-spec typing feature the engine does not carry. */
  "feature-not-carried",
  /** The answer is a name resolved through a container, and Telo declares none. */
  "container-not-declared",
  /** An input of the cel-spec test the row could not carry. */
  "uncarried-input",
] as const;

export type DeviationReason = (typeof DEVIATION_REASONS)[number];

/** The parts of cel-spec's outcome a `deviation.celSpec` may state. */
export const CEL_SPEC_PARTS = ["value", "error", "type", "unknown"] as const;

const ROW_KEYS = [
  "id",
  "source",
  "provenance",
  "types",
  "declarations",
  "documents",
  "namedTypes",
  "functions",
  "namespaces",
  "variants",
  "bindings",
  "assumptions",
  "expect",
  "deviation",
];
/** What a `types` entry may say: a type definition's own keys, and no implementation. */
const TYPE_KEYS = [
  "name",
  "base",
  "parameters",
  "operators",
  "comparisons",
  "conversions",
  "members",
  "fields",
  "constructible",
  "required",
  "description",
];
const EXPECT_KEYS = ["check", "value", "error"];
const ERROR_KEYS = ["code", "celCode", "message", "range"];
const DEVIATION_KEYS = ["celSpec", "reason", "uncarried"];
const PROVENANCE_KEYS = ["file", "section", "test"];

/**
 * The language environment: CEL's own library, with unlisted names reading as `dyn`,
 * optional types on and heterogeneous aggregates allowed. Nothing else — no host
 * catalog, no host type.
 */
export function languageEnvironment(): CelEnvironment {
  return new CelEnvironment({
    unlistedVariablesAreDyn: true,
    enableOptionalTypes: true,
    homogeneousAggregateLiterals: false,
  });
}

/** The row's types registered onto a copy of the environment, in the order the row lists them. */
function withTypes(base: CelEnvironment, row: LanguageRow, options: CelEnvironmentOptions = {}): CelEnvironment {
  const environment = base.clone(options);
  for (const definition of row.types ?? []) environment.registerType(definition);
  return environment;
}

/** The environment a row is CHECKED in: its types, its declarations and its functions. */
export function checkEnvironment(base: CelEnvironment, row: LanguageRow): CelEnvironment {
  if (!row.types && !row.declarations && !row.functions && !row.namespaces) return base;
  const environment = withTypes(base, row, resolverOptions(row));
  for (const [name, declaration] of Object.entries(row.declarations ?? {})) {
    environment.registerVariable(name, declaration as TypeDeclaration);
  }
  for (const declared of row.functions ?? []) environment.registerFunction(declared.signature);
  registerNamespaces(environment, row);
  return environment;
}

function resolverOptions(row: LanguageRow): CelEnvironmentOptions {
  const resolver = rowResolver(row);
  return resolver ? { resolveSchemaType: resolver } : {};
}

/** The row's namespaces, each closed, in the order the row writes them. */
function registerNamespaces(environment: CelEnvironment, row: LanguageRow): void {
  for (const [name, functions] of Object.entries(row.namespaces ?? {})) {
    environment.registerNamespace(name, functions as readonly NamespaceFunctionDeclaration[]);
  }
}

/** A namespaced function's result declared as a schema, where it is. */
function resultSchema(declared: RowNamespaceFunction): JsonSchemaNode | undefined {
  return "returns" in declared && typeof declared.returns === "object" ? declared.returns.schema : undefined;
}

/**
 * The row's resolver: a node whose `$ref` is a key of `namedTypes` is that named type, and one
 * whose `$ref` is a key of `documents` is read as that document.
 */
function rowResolver(row: LanguageRow): SchemaTypeResolver | undefined {
  const { documents, namedTypes } = row;
  if (!documents && !namedTypes) return undefined;
  return ({ node }) => {
    const reference = node.$ref;
    if (typeof reference !== "string") return undefined;
    if (namedTypes && Object.hasOwn(namedTypes, reference)) {
      const named = namedTypes[reference]!;
      return { name: named.name, ...(named.args ? { args: named.args } : {}) };
    }
    return documents && Object.hasOwn(documents, reference) ? { document: { node: documents[reference]! } } : undefined;
  };
}

/**
 * Whether the row types a name or a namespaced function's result from a schema, so its check
 * lists the schema nodes it read.
 */
function readsSchemas(row: LanguageRow): boolean {
  const declared = Object.values(row.declarations ?? {}).some(
    (declaration) => typeof declaration === "object" && declaration !== null && "schema" in declaration,
  );
  return declared || Object.values(row.namespaces ?? {}).some((functions) => functions.some((entry) => resultSchema(entry) !== undefined));
}

/** The row's name for each document it hands over: a declaration's schema, or a `documents` key. */
function documentNames(row: LanguageRow): Map<JsonSchemaNode, string> {
  const names = new Map<JsonSchemaNode, string>();
  for (const [name, declaration] of Object.entries(row.declarations ?? {})) {
    if (typeof declaration === "object" && declaration !== null && "schema" in declaration) {
      names.set((declaration as { schema: JsonSchemaNode }).schema, name);
    }
  }
  for (const [namespace, functions] of Object.entries(row.namespaces ?? {})) {
    for (const declared of functions) {
      const schema = resultSchema(declared);
      if (schema) names.set(schema, `${namespace}.${(declared as { name: string }).name}`);
    }
  }
  for (const [name, document] of Object.entries(row.documents ?? {})) names.set(document, name);
  return names;
}

/** Per listed node of a document the row varies, whether its variant agrees with it there. */
function variantAgreement(row: LanguageRow, dependencies: readonly RecordedSchemaDependency[]): RecordedAgreement[] {
  const documents = new Map([...documentNames(row)].map(([document, name]) => [name, document]));
  const resolver = rowResolver(row);
  return dependencies.flatMap(({ document, pointer }) => {
    const variant = row.variants?.[document];
    if (variant === undefined) return [];
    const agrees = schemaOwnTypesAgree({ node: documents.get(document)! }, { node: variant }, pointer, {
      ...(resolver ? { resolveSchemaType: resolver } : {}),
    });
    return [{ document, pointer, agrees }];
  });
}

function recordedReport(report: SchemaRegistrationReport): RecordedSchemaReport {
  return {
    name: report.name,
    unjudged: report.unjudged.map((node) => ({
      pointer: node.pointer,
      ...(node.throughReference === undefined ? {} : { throughReference: node.throughReference }),
      keywords: [...node.keywords],
      ...(node.typeName === undefined ? {} : { typeName: node.typeName }),
      reason: node.reason,
    })),
    recursive: report.recursive.map((node) => ({
      pointer: node.pointer,
      ...(node.throughReference === undefined ? {} : { throughReference: node.throughReference }),
      ...(node.reference === undefined ? {} : { reference: node.reference }),
    })),
  };
}

function recordedDependencies(row: LanguageRow, dependencies: readonly SchemaDependency[]): RecordedSchemaDependency[] {
  const names = documentNames(row);
  return dependencies.map((dependency) => recordedNode(names, dependency));
}

function recordedNode(names: ReadonlyMap<JsonSchemaNode, string>, node: SchemaDependency): RecordedSchemaDependency {
  const document = names.get(node.document);
  if (document === undefined) throw new Error(`the check named a document the row did not hand over`);
  return { document, pointer: node.pointer };
}

/**
 * Every schema node a verdict or the result names is one the same check read: a host words
 * a finding from it and compares it, so it must be a node the dependency list covers.
 */
function namedNodesListed(dependencies: readonly SchemaDependency[], named: readonly SchemaDependency[]): void {
  for (const node of named) {
    if (!dependencies.some((listed) => listed.document === node.document && listed.pointer === node.pointer)) {
      throw new Error(`the check names the schema node ${JSON.stringify(node.pointer)}, which it does not list as read`);
    }
  }
}

/**
 * Every schema a row declares a name by is one an intersection with itself leaves as it is:
 * `allOf: [S, S]`, read against S's document, converts to a type equal to S's.
 */
function selfIntersectionsEqual(environment: CelEnvironment, row: LanguageRow): void {
  const declared = new Map(environment.definitions().variables.map((variable) => [variable.name, variable.type]));
  for (const [name, declaration] of Object.entries(row.declarations ?? {})) {
    if (typeof declaration !== "object" || declaration === null || !("schema" in declaration)) continue;
    const { schema, document } = declaration as { schema: JsonSchemaNode; document?: JsonSchemaNode };
    const twice = environment.clone().registerVariable(name, { schema: { allOf: [schema, schema] }, document: document ?? schema });
    const met = twice.definitions().variables.find((variable) => variable.name === name)!.type;
    if (!typesEqual(met, declared.get(name)!)) {
      throw new Error(`the schema of ${JSON.stringify(name)} met with itself converts to another type`);
    }
  }
}

/**
 * The environment a row is EVALUATED in: its types and its functions, and none of its
 * declarations. A
 * declared function is a signature with no implementation, so a call that resolves to it
 * answers `unbound_function`, naming the function and the signature it resolved to; its
 * arguments are evaluated first, since their types choose the overload.
 */
export function evaluationEnvironment(base: CelEnvironment, row: LanguageRow): CelEnvironment {
  if (!row.types && (!row.functions || row.functions.length === 0) && !row.namespaces) return base;
  const environment = withTypes(base, row, row.namespaces ? resolverOptions(row) : {});
  for (const declared of row.functions ?? []) environment.registerFunction(declared.signature);
  registerNamespaces(environment, row);
  return environment;
}

/** The row's bindings as an activation. Throws on a binding not in its canonical writing. */
export function activationOf(row: LanguageRow): Record<string, CelValue> {
  const activation: Record<string, CelValue> = Object.create(null) as Record<string, CelValue>;
  for (const [name, node] of Object.entries(row.bindings ?? {})) {
    activation[name] = readCanonicalConformanceValue(node as ConformanceValue);
  }
  return activation;
}

const CALL_KEYS: readonly (keyof ResolvedCall)[] = [
  "name",
  "form",
  "namespace",
  "arity",
  "range",
  "signature",
  "returns",
  "deterministic",
  "hostBacked",
  "throws",
  "argumentTypeNames",
];

/** The fields a row records through another: the argument types, by the names they print as. */
const CALL_KEYS_RECORDED_AS_NAMES: readonly (keyof ResolvedCall)[] = ["argumentTypes"];

function recordedCall(call: ResolvedCall): RecordedCall {
  const unknown = Object.keys(call).filter(
    (key) => !(CALL_KEYS as readonly string[]).includes(key) && !(CALL_KEYS_RECORDED_AS_NAMES as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new Error(`the checker reports call fields the format does not carry: ${unknown.join(", ")}`);
  }
  const recorded: Record<string, unknown> = {};
  for (const key of CALL_KEYS) {
    const value = call[key];
    if (value === undefined) continue;
    recorded[key] = key === "range" ? recordedRange(call.range) : value;
  }
  return recorded as unknown as RecordedCall;
}

/**
 * The engine's whole answer for a row. The check half runs in the check environment; the
 * evaluation half checks first in the evaluation environment, recording a refusal as the
 * first diagnostic, and otherwise evaluates with the row's bindings.
 */
export function languageAnswer(base: CelEnvironment, row: LanguageRow): LanguageExpect {
  const activation = activationOf(row);
  const asked = readsSchemas(row);
  const environment = checkEnvironment(base, row);
  const checked = environment.check(row.source, {
    schemaDependencies: asked,
    schemaNodes: asked,
    ...(row.assumptions ? { assumptions: row.assumptions } : {}),
  });
  const names = documentNames(row);
  const check: LanguageCheck = {
    diagnostics: checked.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      range: recordedRange(diagnostic.range),
      ...(diagnostic.fix ? { fix: { replacement: diagnostic.fix.replacement } } : {}),
      ...(diagnostic.schemaNode ? { schemaNode: recordedNode(names, diagnostic.schemaNode) } : {}),
      ...(diagnostic.absent ? { absent: true as const } : {}),
    })),
    ...(checked.diagnostics.length === 0 ? { type: checked.typeName } : {}),
    calls: checked.calls.map(recordedCall),
  };
  if (asked) {
    const origins = checked.resultOrigins!;
    const named = [
      ...checked.diagnostics.flatMap((diagnostic) => (diagnostic.schemaNode ? [diagnostic.schemaNode] : [])),
      ...origins.flatMap((origin) => (origin.schemaNode ? [origin.schemaNode] : [])),
    ];
    namedNodesListed(checked.schemaDependencies!, named);
    selfIntersectionsEqual(environment, row);
    const dependencies = recordedDependencies(row, checked.schemaDependencies!);
    Object.assign(check, {
      schemaDependencies: dependencies,
      resultOrigins: origins.map((origin) => ({
        range: recordedRange(origin.range),
        type: origin.typeName,
        ...(origin.schemaNode ? { schemaNode: recordedNode(names, origin.schemaNode) } : {}),
      })),
      ...(row.variants ? { variantAgreement: variantAgreement(row, dependencies) } : {}),
    });
  }
  if (row.namedTypes) Object.assign(check, { schemaReports: environment.schemaReports().map(recordedReport) });

  const evaluating = evaluationEnvironment(base, row);
  const expression = evaluating.parse(row.source);
  const refusal = evaluating.check(expression, row.assumptions ? { assumptions: row.assumptions } : {}).diagnostics[0];
  if (refusal) return { check, error: checkRefusal(refusal) };
  let value: CelValue;
  try {
    value = evaluating.compile(expression).evaluate(activation);
  } catch (cause) {
    return { check, error: recordedError(cause) };
  }
  return { check, value: encodeConformanceValue(value) };
}

/** A conformance value as cel-spec's equality sees it: `-0` is `0`. */
function celSpecText(node: ConformanceValue): string {
  const zeroed = (held: ConformanceValue): ConformanceValue => {
    if (Array.isArray(held)) return held.map(zeroed);
    if (held === null || typeof held !== "object") return held;
    if (held["$telo"] === "double" && held.value === "-0") return 0;
    return Object.fromEntries(Object.entries(held).map(([key, inner]) => [key, zeroed(inner)]));
  };
  return JSON.stringify(zeroed(encodeConformanceValue(readCanonicalConformanceValue(node))));
}

/**
 * Whether the answer agrees with one part of cel-spec's outcome, by the vectors' cel-spec
 * rule: values by CEL equality including the type (NaN equals NaN, `-0` equals `0`, maps
 * regardless of order), any error agreeing with an error, a type against `check.type`.
 * No answer of this engine is an unknown set.
 */
export function celSpecPartAgrees(part: string, stated: unknown, answer: LanguageExpect): boolean {
  switch (part) {
    case "value":
      return "value" in answer && celSpecText(stated as ConformanceValue) === celSpecText(answer.value!);
    case "error":
      return answer.error !== undefined;
    case "type":
      return answer.check.type === stated;
    case "unknown":
      return false;
    default:
      throw new Error(`${JSON.stringify(part)} is not a part of cel-spec's outcome`);
  }
}

export interface ReplayFailure {
  readonly id: string;
  readonly reason: string;
}

export interface LanguageReplayReport {
  readonly rows: number;
  /** Rows whose answer was computed and compared. */
  readonly driven: number;
  readonly roundTripped: number;
  readonly unreadable: number;
  /** A row breaking the format: its keys, its class, an input that cannot be built. */
  readonly malformed: readonly ReplayFailure[];
  /** A row whose `expect` is not the engine's answer. */
  readonly answers: readonly ReplayFailure[];
  readonly deviations: readonly ReplayFailure[];
  readonly celCodes: readonly ReplayFailure[];
  readonly roundTrip: readonly ReplayFailure[];
}

/** Why a row's `assumptions` break the format: a non-empty list of `{ condition, holds, rebound? }`. */
function assumptionProblems(row: LanguageRow): string[] {
  const assumptions = (row as { assumptions?: unknown }).assumptions;
  if (assumptions === undefined) return [];
  if (!Array.isArray(assumptions) || assumptions.length === 0) return ["carries `assumptions` that is not a non-empty list"];
  return assumptions.flatMap((assumption: unknown) =>
    isPlainObject(assumption) &&
    unknownKeys(assumption, ASSUMPTION_KEYS).length === 0 &&
    typeof assumption.condition === "string" &&
    typeof assumption.holds === "boolean" &&
    (assumption.rebound === undefined ||
      (Array.isArray(assumption.rebound) && assumption.rebound.every((chain) => typeof chain === "string")))
      ? []
      : [`carries an assumption that is not \`{ condition, holds, rebound? }\`: ${JSON.stringify(assumption)}`],
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

/** Why a row breaks the format, before its answer is computed; nothing when it does not. */
export function rowShapeProblems(row: LanguageRow, afterAuthored: boolean): string[] {
  const problems: string[] = [];
  const raw = row as unknown as Record<string, unknown>;
  if ("divergence" in raw) problems.push("carries `divergence`, which the format no longer has");
  const extra = unknownKeys(raw, ROW_KEYS).filter((key) => key !== "divergence");
  if (extra.length > 0) problems.push(`carries keys the format does not define: ${extra.join(", ")}`);
  if (typeof row.id !== "string") problems.push("has no string `id`");
  if (typeof row.source !== "string") problems.push("has no string `source`");
  const authored = typeof row.id === "string" && row.id.startsWith(AUTHORED_ROW_PREFIX);
  if (authored) {
    if (row.provenance !== undefined) problems.push("is authored and carries `provenance`");
    if (row.deviation !== undefined) problems.push("is authored and carries `deviation`");
  } else {
    if (afterAuthored) problems.push("is a cel-spec row after an authored row; authored rows follow the import");
    const provenance = row.provenance as unknown;
    if (
      !isPlainObject(provenance) ||
      unknownKeys(provenance, PROVENANCE_KEYS).length > 0 ||
      PROVENANCE_KEYS.some((key) => typeof provenance[key] !== "string")
    ) {
      problems.push("is a cel-spec row without a `provenance` of `file`, `section` and `test`");
    }
  }
  const types = (row as { types?: unknown }).types;
  if (types !== undefined) {
    if (!Array.isArray(types) || types.length === 0) problems.push("carries `types` that is not a non-empty list");
    else {
      for (const definition of types as unknown[]) {
        if (
          !isPlainObject(definition) ||
          unknownKeys(definition, TYPE_KEYS).length > 0 ||
          typeof definition.name !== "string" ||
          typeof definition.base !== "string"
        ) {
          problems.push(`declares a type that is not definition data with a \`name\` and a \`base\`: ${JSON.stringify(definition)}`);
        }
      }
    }
  }
  for (const declared of row.functions ?? []) {
    if (!isPlainObject(declared) || unknownKeys(declared, ["signature"]).length > 0 || typeof declared.signature !== "string") {
      problems.push(`declares a function that is not \`{ signature }\` alone: ${JSON.stringify(declared)}`);
    }
  }
  problems.push(...namespaceProblems(row), ...variantProblems(row), ...namedTypeProblems(row), ...assumptionProblems(row));
  if (!isPlainObject(row.expect)) {
    problems.push("has no `expect`");
    return problems;
  }
  const expectExtra = unknownKeys(row.expect, EXPECT_KEYS);
  if (expectExtra.length > 0) problems.push(`\`expect\` carries ${expectExtra.join(", ")}`);
  if (!isPlainObject(row.expect.check)) problems.push("`expect` has no `check`");
  if (("value" in row.expect) === (row.expect.error !== undefined)) {
    problems.push("`expect` carries neither or both of `value` and `error`");
  }
  const error = row.expect.error as unknown;
  if (error !== undefined) {
    if (
      !isPlainObject(error) ||
      unknownKeys(error, ERROR_KEYS).length > 0 ||
      !("code" in error) ||
      !("celCode" in error) ||
      typeof error.message !== "string"
    ) {
      problems.push(`\`expect.error\` is not \`{ code, celCode, message, range? }\`: ${JSON.stringify(error)}`);
    }
  }
  if (row.deviation !== undefined) {
    const deviation = row.deviation as unknown;
    if (!isPlainObject(deviation) || Object.keys(deviation).length === 0) {
      problems.push("carries an empty or malformed `deviation`");
    } else {
      const deviationExtra = unknownKeys(deviation, DEVIATION_KEYS);
      if (deviationExtra.length > 0) problems.push(`\`deviation\` carries ${deviationExtra.join(", ")}`);
      const uncarried = deviation.uncarried;
      if (
        uncarried !== undefined &&
        (!Array.isArray(uncarried) || uncarried.length === 0 || uncarried.some((input) => typeof input !== "string"))
      ) {
        problems.push("`deviation.uncarried` is not a non-empty list of inputs");
      }
      const celSpec = deviation.celSpec;
      if (
        celSpec !== undefined &&
        (!isPlainObject(celSpec) ||
          Object.keys(celSpec).length === 0 ||
          unknownKeys(celSpec, CEL_SPEC_PARTS).length > 0)
      ) {
        problems.push(`\`deviation.celSpec\` is not a non-empty set of ${CEL_SPEC_PARTS.join(", ")}`);
      }
    }
  }
  return problems;
}

/** Why a row's `namespaces` break the format. */
function namespaceProblems(row: LanguageRow): string[] {
  const namespaces = (row as { namespaces?: unknown }).namespaces;
  if (namespaces === undefined) return [];
  if (!isPlainObject(namespaces) || Object.keys(namespaces).length === 0) return ["carries `namespaces` that is not a non-empty map"];
  const problems: string[] = [];
  for (const [name, functions] of Object.entries(namespaces)) {
    if (!Array.isArray(functions)) {
      problems.push(`declares the namespace ${JSON.stringify(name)} with no list of functions`);
      continue;
    }
    for (const declared of functions as unknown[]) {
      const whole =
        isPlainObject(declared) && unknownKeys(declared, ["signature"]).length === 0 && typeof declared.signature === "string";
      const returns = isPlainObject(declared) ? declared.returns : undefined;
      const withheld =
        isPlainObject(declared) &&
        unknownKeys(declared, ["name", "returns"]).length === 0 &&
        typeof declared.name === "string" &&
        (typeof returns === "string" ||
          (isPlainObject(returns) && unknownKeys(returns, ["schema"]).length === 0 && isPlainObject(returns.schema)));
      if (!whole && !withheld) {
        problems.push(
          `declares a namespaced function that is neither \`{ signature }\` nor \`{ name, returns }\`: ${JSON.stringify(declared)}`,
        );
      }
    }
  }
  return problems;
}

/** Why a row's `namedTypes` break the format: each a `{ name, args? }` of type text. */
function namedTypeProblems(row: LanguageRow): string[] {
  const namedTypes = (row as { namedTypes?: unknown }).namedTypes;
  if (namedTypes === undefined) return [];
  if (!isPlainObject(namedTypes) || Object.keys(namedTypes).length === 0) return ["carries `namedTypes` that is not a non-empty map"];
  return Object.entries(namedTypes).flatMap(([reference, named]) => {
    const args = isPlainObject(named) ? named.args : undefined;
    const valid =
      isPlainObject(named) &&
      unknownKeys(named, ["name", "args"]).length === 0 &&
      typeof named.name === "string" &&
      (args === undefined || (Array.isArray(args) && args.every((arg) => typeof arg === "string")));
    return valid ? [] : [`names the type of ${JSON.stringify(reference)} with a value that is not \`{ name, args? }\``];
  });
}

/** Why a row's `variants` break the format: each names a document the row hands over. */
function variantProblems(row: LanguageRow): string[] {
  const variants = (row as { variants?: unknown }).variants;
  if (variants === undefined) return [];
  if (!isPlainObject(variants) || Object.keys(variants).length === 0) return ["carries `variants` that is not a non-empty map"];
  const named = new Set(documentNames(row).values());
  return Object.entries(variants).flatMap(([name, variant]) => {
    if (!named.has(name)) return [`varies ${JSON.stringify(name)}, which names no document the row hands over`];
    return isPlainObject(variant) ? [] : [`varies ${JSON.stringify(name)} with a value that is not a schema`];
  });
}

/** Q4's rules for a row's `deviation`, against the engine's answer. */
export function deviationProblems(row: LanguageRow, answer: LanguageExpect): string[] {
  const deviation = row.deviation;
  if (!deviation) return [];
  const problems: string[] = [];
  const { celSpec, reason, uncarried } = deviation;
  if ((celSpec === undefined) !== (reason === undefined)) {
    problems.push(
      celSpec === undefined
        ? `states the reason ${JSON.stringify(reason)} with no \`celSpec\``
        : "states cel-spec's outcome with no `reason`",
    );
  }
  if (reason !== undefined && !(DEVIATION_REASONS as readonly string[]).includes(reason)) {
    problems.push(`states the reason ${JSON.stringify(reason)}, which is not one of ${DEVIATION_REASONS.join(", ")}`);
  }
  for (const [part, stated] of Object.entries(celSpec ?? {})) {
    if (celSpecPartAgrees(part, stated, answer)) {
      problems.push(`\`deviation.celSpec.${part}\` agrees with the answer — drop it`);
    }
  }
  if (reason === "uncarried-input" && (uncarried?.length ?? 0) === 0) {
    problems.push("states `uncarried-input` with nothing in `uncarried`");
  }
  if (reason === "container-not-declared" && !(uncarried ?? []).includes("container")) {
    problems.push("states `container-not-declared` and `uncarried` does not hold `container`");
  }
  return problems;
}

/** The `celCode` vocabulary of a language row's error. */
export function celCodeProblems(row: LanguageRow): string[] {
  const error = row.expect.error;
  if (!error) return [];
  const problems: string[] = [];
  if (error.celCode !== null && !LANGUAGE_CEL_CODES.has(error.celCode)) {
    problems.push(`records the celCode ${JSON.stringify(error.celCode)}, which no language answer can carry`);
  }
  if (error.code !== null && error.celCode !== null) problems.push("records both a Telo code and a celCode");
  if (error.code === null && error.celCode === null) {
    problems.push("records an error with no code — the engine failing, never an answer");
  }
  return problems;
}

function roundTripProblem(environment: CelEnvironment, source: string): string | "unreadable" | undefined {
  const expression = environment.parse(source);
  if (expression.diagnostics.length > 0) return "unreadable";
  if (hasUnparsed(expression.root)) return "read with no diagnostic but left an unparsed hole in the tree";
  const written = serializeTree(expression.root);
  const reread = environment.parse(written);
  if (reread.diagnostics.length > 0) return `wrote ${JSON.stringify(written)}, which does not read back`;
  if (!treesEqual(expression.root, reread.root)) {
    return `wrote ${JSON.stringify(written)}, which reads back as a different expression`;
  }
  return undefined;
}

export function replayLanguageRows(rows: readonly LanguageRow[]): LanguageReplayReport {
  const malformed: ReplayFailure[] = [];
  const answers: ReplayFailure[] = [];
  const deviations: ReplayFailure[] = [];
  const celCodes: ReplayFailure[] = [];
  const roundTrip: ReplayFailure[] = [];
  const ids = new Set<string>();
  const base = languageEnvironment();
  let afterAuthored = false;
  let driven = 0;
  let roundTripped = 0;
  let unreadable = 0;

  for (const row of rows) {
    const shape = rowShapeProblems(row, afterAuthored);
    if (typeof row.id === "string" && row.id.startsWith(AUTHORED_ROW_PREFIX)) afterAuthored = true;
    if (ids.has(row.id)) shape.push("repeats an id");
    ids.add(row.id);
    if (shape.length > 0) {
      for (const reason of shape) malformed.push({ id: row.id, reason });
      continue;
    }

    let answer: LanguageExpect;
    try {
      answer = languageAnswer(base, row);
    } catch (cause) {
      malformed.push({ id: row.id, reason: `its answer cannot be computed: ${(cause as Error).message}` });
      continue;
    }
    driven += 1;
    if (!isDeepStrictEqual(answer, row.expect)) {
      answers.push({
        id: row.id,
        reason: `the engine answers ${JSON.stringify(answer)} where the row records ${JSON.stringify(row.expect)}`,
      });
    }
    for (const reason of deviationProblems(row, answer)) deviations.push({ id: row.id, reason });
    for (const reason of celCodeProblems(row)) celCodes.push({ id: row.id, reason });

    const trip = roundTripProblem(checkEnvironment(base, row), row.source);
    if (trip === "unreadable") unreadable += 1;
    else if (trip === undefined) roundTripped += 1;
    else roundTrip.push({ id: row.id, reason: trip });
  }

  return { rows: rows.length, driven, roundTripped, unreadable, malformed, answers, deviations, celCodes, roundTrip };
}
