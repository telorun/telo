import {
  BOOL,
  BYTES,
  DOUBLE,
  DYN,
  INT,
  isDyn,
  MAX_INT,
  MIN_INT,
  schemaType,
  STRING,
  typesEqual,
  UINT,
  type CelType,
  type PrimitiveName,
} from "@telorun/cel";
import { isRefSentinel, isTaggedSentinel, producedTypeOf } from "@telorun/templating";
import { canonicalJson } from "./canonical-json.js";
import { declaredDocument } from "./referenced-shape.js";

/**
 * A pure step's result, typed by what its `value:` is, and the `steps` record
 * the CEL environment holds.
 *
 * `steps` is ONE closed record in the environment for every step body, whatever
 * its steps produce: a misspelled step name is the record's to refuse, once,
 * with its range (`"frist" is not declared here (declared: …)`), and the
 * context schema's `steps` node is open at the name level, so it never judges
 * a step name. A step's `result` in the record is `dyn` unless typed here; the
 * members of a dispatch's contract and of a forwarded schema are the schema
 * chain check's.
 *
 * A LITERAL value is typed by what is written, by the rule the step engine
 * reads it with: an integral number is an `int`, any other number a `double`, a
 * map is a closed record of its members, a list is typed by its elements when
 * they all agree, and a tagged member (`!cel`, `!interpolate`, …) is open. Its
 * shape rides under a marker of its own, so the CEL environment is the one
 * place it is typed and a misspelled member is reported once.
 *
 * A TAGGED value (`!cel`, `!interpolate`, …) is typed by its PRODUCER, judged
 * once in the environment of the step's own site — a step inside a `catch:`
 * sees `error` — and read as that FACT by every reader (the resolver supplies
 * it, {@link stepContextWithFacts}): the pair of the type it records (a scalar,
 * else `dyn`) and the schema a plain chain forwards, as the producer's own
 * navigation resolves it ({@link producerFact}). A forward of a forward carries
 * the schema on, and a forward of a literal its shape, so the record stays
 * closed. The members of one strongly connected group of step reads read each
 * other as `(dyn, none)`, so step order decides nothing. A region a key judges
 * holds a producer it carves as a stand-in carrying that fact
 * ({@link carvedResult}).
 *
 * A NAME is one type only when every step carrying it agrees — a branch pair, a
 * loop's seed and the step advancing it. The alternatives ride under a third
 * marker; a name whose steps disagree claims nothing, and an expression reads
 * its own name as what the OTHER steps of that name produce, since that is what
 * the name holds when it runs.
 *
 * A number an author schema declares stays `dyn` at this layer: whether it
 * arrives as `int` or `double` depends on where it came from, and guessing
 * there would reject manifests that run.
 */
const INFERRED_RESULT = "x-telo-inferred-result-of";
/** Beside an expression's source: where the producing step's value is written. */
const INFERRED_AT = "x-telo-inferred-result-at";
/** Beside an expression's source: the engine of its tag. */
const INFERRED_ENGINE = "x-telo-inferred-result-engine";
/** A computed result's fact: a recorded scalar type's name, or `dyn`. */
const INFERRED_TYPE = "x-telo-inferred-result-type";
/** On a carved producer's stand-in: the schema its fact forwards. */
const FORWARDED_SCHEMA = "x-telo-inferred-result-schema";
const LITERAL_RESULT = "x-telo-inferred-literal-result";
const SAME_NAMED_RESULTS = "x-telo-inferred-results-of-name";
/** On a same-named marker: the alternative the reading site sits inside. */
const READING_ALTERNATIVE = "x-telo-inferred-reading-alternative";
/** On a step context: the environment holds it as the closed `steps` record. */
const STEP_RECORD = "x-telo-step-record";

/** The scalars a fact records, by the primitive each is: a fact names its type by that primitive. */
const RECORDED_TYPES: ReadonlyMap<PrimitiveName, CelType> = new Map<PrimitiveName, CelType>([
  ["int", INT],
  ["uint", UINT],
  ["double", DOUBLE],
  ["string", STRING],
  ["bool", BOOL],
  ["bytes", BYTES],
]);

/** The step-context schema for a pure step's result: a tagged value's source
 *  with its engine and where it is written, a literal's shape under its marker,
 *  or a carved producer's fact; undefined where nothing can be said. */
export function inferredResultSchema(value: unknown, at: string): Record<string, any> | undefined {
  if (isCarvedResult(value)) {
    const schema = value[FORWARDED_SCHEMA];
    return factResult({ type: value[INFERRED_TYPE], ...(schema ? { schema } : {}) });
  }
  if (isTaggedSentinel(value)) {
    return isRefSentinel(value)
      ? undefined
      : { [INFERRED_RESULT]: value.source, [INFERRED_ENGINE]: value.engine, [INFERRED_AT]: at };
  }
  const shape = literalShape(value);
  return shape && { [LITERAL_RESULT]: shape };
}

/** One step's result among the steps sharing its name. `at` is the path of a
 *  pure step's value, which is where its own expressions are written. */
export interface StepResultAlternative {
  result: Record<string, any>;
  at?: string;
}

/**
 * The result schema of a step NAME: the one result where a single step carries
 * it or every step's is the same declaration, and otherwise the alternatives
 * under a marker for the CEL environment to compare by type.
 */
export function sameNamedResult(alternatives: readonly StepResultAlternative[]): Record<string, any> {
  const first = alternatives[0]!.result;
  if (alternatives.length === 1) return first;
  const settled = alternatives.every(
    ({ result }) =>
      !isExpressionResult(result) &&
      (result === first || canonicalJson(result) === canonicalJson(first)),
  );
  return settled ? first : { [SAME_NAMED_RESULTS]: alternatives };
}

/**
 * A tagged step value's result as its producer judged it: the type its
 * expression records — a scalar, else `dyn` — and the schema it forwards, or
 * none.
 */
export interface StepFact {
  readonly type: string;
  readonly schema?: Record<string, any>;
}

/** What a member of a producer's own read group reads it as. */
export const OPEN_FACT: StepFact = { type: "dyn" };

/**
 * A producer's fact from its own judgement, the one derivation both the whole
 * declaration and a key's region read: the type its analysis recorded — or,
 * where the analysis types nothing, the type its tag's engine declares it
 * produces — as a scalar, else `dyn`; and the schema its plain chain resolves
 * to (`produced`) where that is a schema rather than a fact.
 */
export function producerFact(
  engine: string,
  type: CelType | undefined,
  produced: Record<string, any> | undefined,
): StepFact {
  const schema = forwardedSchemaOf(produced);
  return { type: recordedTypeName(type ?? producedType(engine)), ...(schema ? { schema } : {}) };
}

/** The type a tag's engine declares it produces. */
function producedType(engine: string): CelType | undefined {
  const declared = producedTypeOf(engine);
  return declared ? schemaType({ node: declared }).type : undefined;
}

/** What a chain's navigation forwards: a schema, never a fact — an expression
 *  marker or a name's alternatives forward none, and a fact forwards the
 *  schema it carries. */
function forwardedSchemaOf(produced: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!produced || isExpressionResult(produced) || alternativesOf(produced) !== undefined) return undefined;
  if (typeof produced[INFERRED_TYPE] !== "string") return produced;
  const rest: Record<string, any> = { ...produced };
  delete rest[INFERRED_TYPE];
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/**
 * A fact as the step context holds a result: its forwarded schema — its own
 * document, so a pointer left in it resolves against it — with the recorded
 * type beside it, which the closed record reads.
 */
export function factResult(fact: StepFact): Record<string, any> {
  return fact.schema ? declaredDocument({ ...fact.schema, [INFERRED_TYPE]: fact.type }) : { [INFERRED_TYPE]: fact.type };
}

/** Facts as comparable identities: a forwarded schema is interned by its
 *  canonical content, so equal schemas are one identity, compared in O(1). */
export class FactIdentities {
  private readonly schemas = new Map<string, number>();
  private readonly known = new WeakMap<object, number>();

  identity(fact: StepFact): string {
    if (!fact.schema) return fact.type;
    let id = this.known.get(fact.schema);
    if (id === undefined) {
      const content = canonicalJson(fact.schema);
      id = this.schemas.get(content);
      if (id === undefined) this.schemas.set(content, (id = this.schemas.size));
      this.known.set(fact.schema, id);
    }
    return `${fact.type}#${id}`;
  }
}

/**
 * What a region holds in place of a step value another key types: the
 * stand-in of a carved producer, carrying its fact — the result is typed by it
 * as by the producer's own judgement.
 */
export function carvedResult(fact: StepFact): Record<string, unknown> {
  return { [INFERRED_TYPE]: fact.type, ...(fact.schema ? { [FORWARDED_SCHEMA]: fact.schema } : {}) };
}

/** True when `value` is a carved producer's stand-in. */
export function isCarvedResult(
  value: unknown,
): value is { [INFERRED_TYPE]: string; [FORWARDED_SCHEMA]?: Record<string, any> } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record[INFERRED_TYPE] !== "string") return false;
  return Object.keys(record).every(
    (key) => key === INFERRED_TYPE || (key === FORWARDED_SCHEMA && record[key] !== null && typeof record[key] === "object"),
  );
}

/** The `steps` context over `stepProperties`: open at the name level, since
 *  the closed record the environment holds is what says a step name exists. */
export function stepContextOf(stepProperties: Record<string, any>): Record<string, any> {
  return { type: "object", properties: stepProperties, additionalProperties: true, [STEP_RECORD]: true };
}

/** `steps` listing exactly `names`, in their order: a name it does not hold
 *  is `{ result: dyn }` — what a region's record lists beyond the steps it
 *  holds, where its key covers every name. */
export function stepContextOver(steps: Record<string, any>, names: readonly string[]): Record<string, any> {
  const held = (steps.properties ?? {}) as Record<string, any>;
  const properties: Record<string, any> = {};
  for (const name of names) properties[name] = held[name] ?? { type: "object", properties: { result: {} } };
  return { ...steps, properties };
}

/**
 * The step context as the expression at `path` reads it: inside the value of a
 * step that shares its name, that name is what the OTHER steps carrying it
 * produce. Any other path reads the context as it is.
 */
export function stepContextAt(steps: Record<string, any>, path: string): Record<string, any> {
  let sites = readingSites.get(steps);
  if (!sites) readingSites.set(steps, (sites = sameNamedSites(steps)));
  const site = sites.find(
    ({ at }) => path === at || path.startsWith(`${at}.`) || path.startsWith(`${at}[`),
  );
  if (!site) return steps;
  if (!site.view) {
    const others = site.alternatives.filter((_, index) => index !== site.index);
    const settled = sameNamedResult(others);
    site.view = stepContextOf({
        ...steps.properties,
        [site.name]: {
          type: "object",
          properties: {
            result:
              alternativesOf(settled) === undefined && !isExpressionResult(settled)
                ? settled
                : { [SAME_NAMED_RESULTS]: site.alternatives, [READING_ALTERNATIVE]: site.index },
          },
        },
    });
  }
  return site.view;
}

interface ReadingSite {
  at: string;
  name: string;
  index: number;
  alternatives: readonly StepResultAlternative[];
  view?: Record<string, any>;
}

const readingSites = new WeakMap<object, ReadingSite[]>();

function sameNamedSites(steps: Record<string, any>): ReadingSite[] {
  const sites: ReadingSite[] = [];
  for (const [name, step] of Object.entries((steps.properties ?? {}) as Record<string, any>)) {
    const alternatives = alternativesOf(step?.properties?.result);
    alternatives?.forEach(({ at }, index) => {
      if (at !== undefined) sites.push({ at, name, index, alternatives });
    });
  }
  return sites;
}

/** A pure step whose value is tagged: its result is its producer's fact. */
export interface ComputedProducer {
  readonly name: string;
  readonly at: string;
  readonly engine: string;
  readonly source: string;
}

/** Every computed producer of the step context, in walk order. */
export function computedProducers(steps: Record<string, any>): ComputedProducer[] {
  const out: ComputedProducer[] = [];
  const seen = new Set<string>();
  const add = (name: string, result: Record<string, any> | undefined): void => {
    if (!isExpressionResult(result)) return;
    const at = result![INFERRED_AT] as string;
    if (seen.has(at)) return;
    seen.add(at);
    out.push({ name, at, engine: result![INFERRED_ENGINE] as string, source: result![INFERRED_RESULT] as string });
  };
  for (const [name, step] of Object.entries((steps.properties ?? {}) as Record<string, any>)) {
    const result = resultSchemaOf(step);
    const alternatives = alternativesOf(result);
    if (alternatives) for (const alternative of alternatives) add(name, alternative.result);
    else add(name, result);
  }
  return out;
}

/**
 * `steps` with every computed result replaced by its producer's fact: `fact`
 * answers it for the steps `reads` names (every step where undefined), and a
 * step it is not asked for is `dyn`. Never alters `steps`.
 */
export function stepContextWithFacts(
  steps: Record<string, any>,
  reads: ReadonlySet<string> | undefined,
  fact: (producer: ComputedProducer) => StepFact,
): Record<string, any> {
  const properties: Record<string, any> = {};
  let changed = false;
  for (const [name, step] of Object.entries((steps.properties ?? {}) as Record<string, any>)) {
    const asked = reads === undefined || reads.has(name);
    const settle = (result: Record<string, any>): Record<string, any> => {
      if (!isExpressionResult(result)) return result;
      changed = true;
      const at = result[INFERRED_AT] as string;
      const producer = { name, at, engine: result[INFERRED_ENGINE] as string, source: result[INFERRED_RESULT] as string };
      return factResult(asked ? fact(producer) : OPEN_FACT);
    };
    properties[name] = mapResult(step, (result) => {
      const alternatives = alternativesOf(result);
      if (!alternatives) return settle(result);
      return {
        ...result,
        [SAME_NAMED_RESULTS]: alternatives.map((alternative) => ({ ...alternative, result: settle(alternative.result) })),
      };
    });
  }
  return changed ? { ...steps, properties } : steps;
}

/** What a producer records of its type: a scalar's primitive, read from its kind, else `dyn`. */
function recordedTypeName(type: CelType | undefined): string {
  return type?.kind === "primitive" && RECORDED_TYPES.has(type.name) ? type.name : "dyn";
}

/** True when `schema` is a step context, which the environment holds as the
 *  closed `steps` record. */
export function isStepRecord(schema: Record<string, any> | undefined): boolean {
  return schema?.[STEP_RECORD] === true;
}

/**
 * The closed `steps` record a step context is held as, written as the schema
 * the CEL engine reads to full depth: each name a closed record of its
 * `result` — a literal's shape, a producer's fact (the schema it forwards, else
 * its scalar), the invoked resource's declared result, the agreement of a
 * shared name, and a node saying nothing otherwise — and a named repeat by its
 * map shape: a map by element key of such records for string keys. A
 * `'<step>' in steps` test reads it as the string-keyed map a record is. A
 * result is the node the context holds, so a reference or pointer in it is read
 * where it was written.
 */
export function stepRecordSchema(steps: Record<string, any>): Record<string, any> {
  const properties: Record<string, any> = {};
  for (const [name, step] of Object.entries((steps.properties ?? {}) as Record<string, any>)) {
    const repeated = repeatEntryOf(step);
    properties[name] = repeated
      ? { type: "object", additionalProperties: resultRecordSchema(repeated) }
      : step?.properties?.result !== undefined
        ? resultRecordSchema(step)
        : OPEN_RESULT;
  }
  return { type: "object", properties, additionalProperties: false };
}

/** A node saying nothing about a result. */
const OPEN_RESULT: Record<string, any> = Object.freeze({});

/** The schema of a scalar fact. */
const FACT_SCHEMAS: ReadonlyMap<string, Record<string, any>> = new Map([
  ["int", { type: "integer" }],
  ["uint", { "x-telo-type": "Telo.Uint64" }],
  ["double", { type: "number" }],
  ["string", { type: "string" }],
  ["bool", { type: "boolean" }],
  ["bytes", { "x-telo-type": "Telo.Bytes" }],
]);

function resultRecordSchema(step: Record<string, any>): Record<string, any> {
  return {
    type: "object",
    properties: { result: nameSchema(step.properties.result) },
    required: ["result"],
    additionalProperties: false,
  };
}

/** The one result every step of a name produces, leaving out the alternative a
 *  reading site sits inside; a node saying nothing when they differ or any
 *  claims nothing. */
function nameSchema(result: Record<string, any> | undefined): Record<string, any> {
  const alternatives = alternativesOf(result);
  if (!alternatives) return resultSchema(result);
  const reading = result![READING_ALTERNATIVE];
  const others = alternatives.filter((_, index) => index !== reading);
  if (others.length === 0) return OPEN_RESULT;
  const first = others[0]!.result;
  const firstType = resultType(first);
  const agreed = others.every(({ result: other }) =>
    isDyn(firstType)
      ? !isExpressionResult(other) && (other === first || canonicalJson(other) === canonicalJson(first))
      : typesEqual(resultType(other), firstType),
  );
  return agreed ? resultSchema(first) : OPEN_RESULT;
}

function resultSchema(result: Record<string, any> | undefined): Record<string, any> {
  if (!result || typeof result !== "object") return OPEN_RESULT;
  if (isLiteralResult(result)) return result[LITERAL_RESULT];
  if (isExpressionResult(result)) return OPEN_RESULT;
  const fact = result[INFERRED_TYPE];
  if (typeof fact === "string") {
    if (Object.keys(result).some((key) => key !== INFERRED_TYPE)) return result;
    return FACT_SCHEMAS.get(fact) ?? OPEN_RESULT;
  }
  return isOpenResult(result) ? OPEN_RESULT : result;
}

/** An undeclared result: open, the absence of a claim. */
function isOpenResult(result: Record<string, any>): boolean {
  const keys = Object.keys(result);
  return (
    result.type === "object" &&
    result.additionalProperties === true &&
    keys.every((key) => key === "type" || key === "additionalProperties")
  );
}

/** The CEL type a result says it is, when it says one: what step names of
 *  one result are compared by. */
function resultType(result: Record<string, any> | undefined): CelType {
  if (isLiteralResult(result)) return schemaType({ node: result![LITERAL_RESULT] }).type;
  const fact = result?.[INFERRED_TYPE];
  return typeof fact === "string" ? (RECORDED_TYPES.get(fact as PrimitiveName) ?? DYN) : DYN;
}

/** A named repeat's entry: results by element key, string-keyed. */
function repeatEntryOf(step: Record<string, any> | undefined): Record<string, any> | undefined {
  const entry = step?.additionalProperties;
  return entry && typeof entry === "object" && entry.properties?.result !== undefined ? entry : undefined;
}

function resultSchemaOf(step: Record<string, any> | undefined): Record<string, any> | undefined {
  return (repeatEntryOf(step) ?? step)?.properties?.result;
}

/** `step` with its result (a repeat's entry's) mapped by `f`. */
function mapResult(
  step: Record<string, any>,
  f: (result: Record<string, any>) => Record<string, any>,
): Record<string, any> {
  const repeated = repeatEntryOf(step);
  const holder = repeated ?? step;
  const result = holder?.properties?.result as Record<string, any> | undefined;
  if (!result) return step;
  const mapped = f(result);
  if (mapped === result) return step;
  const next = { ...holder, properties: { ...holder.properties, result: mapped } };
  return repeated ? { ...step, additionalProperties: next } : next;
}

function isLiteralResult(schema: Record<string, any> | undefined): boolean {
  return schema?.[LITERAL_RESULT] !== undefined;
}

function isExpressionResult(schema: Record<string, any> | undefined): boolean {
  return typeof schema?.[INFERRED_RESULT] === "string";
}

function alternativesOf(
  schema: Record<string, any> | undefined,
): readonly StepResultAlternative[] | undefined {
  const alternatives = schema?.[SAME_NAMED_RESULTS];
  return Array.isArray(alternatives) ? alternatives : undefined;
}

/** The JSON Schema a written value has; undefined where nothing can be said. */
function literalShape(value: unknown): Record<string, any> | undefined {
  if (value === null) return { type: "null" };
  switch (typeof value) {
    case "string":
      return { type: "string" };
    case "boolean":
      return { type: "boolean" };
    case "number":
      return { type: isLiteralInteger(value) ? "integer" : "number" };
    case "object":
      break;
    default:
      return undefined;
  }
  // A tagged member is evaluated or resolved later: open.
  if (isTaggedSentinel(value)) return {};
  if (Array.isArray(value)) {
    const items = value.map((item) => literalShape(item) ?? {});
    const first = items[0];
    const agree =
      first !== undefined &&
      Object.keys(first).length > 0 &&
      items.every((item) => canonicalJson(item) === canonicalJson(first));
    return agree ? { type: "array", items: first } : { type: "array" };
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const properties: Record<string, any> = {};
  for (const [key, member] of Object.entries(value)) properties[key] = literalShape(member) ?? {};
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/** The step engine's rule: an integral number CEL's int can hold is an int. */
function isLiteralInteger(value: number): boolean {
  if (!Number.isInteger(value)) return false;
  const integer = BigInt(value);
  return integer >= MIN_INT && integer <= MAX_INT;
}
