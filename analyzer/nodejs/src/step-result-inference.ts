import {
  DYN,
  isDyn,
  MAX_INT,
  MIN_INT,
  schemaType,
  typesEqual,
  type CelEnvironment,
  type CelType,
} from "@telorun/cel";
import { CEL_ENGINE, isTaggedSentinel } from "@telorun/templating";
import { canonicalJson } from "./canonical-json.js";

/**
 * A pure step's result, typed by what its `value:` is.
 *
 * `steps.<name>.result` of a `value:` step used to be untyped, so
 * `steps.a.result + steps.b.result` passed `telo check` whatever the two were
 * and failed at dispatch with `no such overload: dyn<double> + dyn<int>`.
 *
 * A value that is ONE expression is typed by the CEL type it checks to: the
 * step context carries its source under a derived marker, and registering
 * `steps` with the CEL environment checks each marked source against the
 * results it reads and records its scalar type.
 *
 * A LITERAL value is typed by what is written, by the rule the step engine
 * reads it with: an integral number is an `int`, any other number a `double`, a
 * map is a closed record of its members, a list is typed by its elements when
 * they all agree, and a tagged member (`!cel`, `!interpolate`, …) is open. Its
 * shape rides under a marker of its own, so the CEL environment is the one
 * place it is typed and a misspelled member is reported once.
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
const LITERAL_RESULT = "x-telo-inferred-literal-result";
const SAME_NAMED_RESULTS = "x-telo-inferred-results-of-name";
/** On a same-named marker: the alternative the reading site sits inside. */
const READING_ALTERNATIVE = "x-telo-inferred-reading-alternative";

const RECORDED_TYPES = new Set(["int", "uint", "double", "string", "bool", "bytes"]);

/** The step-context schema for a pure step's result: an expression's source or
 *  a literal's shape under its marker, and otherwise open. Undefined for any
 *  other tag. */
export function inferredResultSchema(value: unknown): Record<string, any> | undefined {
  if (isTaggedSentinel(value)) {
    return value.engine === CEL_ENGINE ? { [INFERRED_RESULT]: value.source } : undefined;
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

/** True when a chain ending at `result` can carry it to another step as it is:
 *  an expression's type, and a name's alternatives, depend on the site reading
 *  them. */
export function isForwardableResult(result: Record<string, any>): boolean {
  return !isExpressionResult(result) && alternativesOf(result) === undefined;
}

/**
 * The `steps` context over `stepProperties`. Where a result is typed by the CEL
 * environment, `steps` is registered there as a closed record, so whether a
 * step name exists is that record's to say and the schema leaves it open — a
 * misspelled step is reported once.
 */
export function stepContextOf(stepProperties: Record<string, any>): Record<string, any> {
  return {
    type: "object",
    properties: stepProperties,
    ...(hasInferredResult(stepProperties) ? { additionalProperties: true } : {}),
  };
}

/** True when some step's result is typed by the CEL environment. */
function hasInferredResult(stepProperties: Record<string, any>): boolean {
  return Object.values(stepProperties).some((step) => {
    const result = step?.properties?.result;
    return isExpressionResult(result) || isLiteralResult(result) || alternativesOf(result) !== undefined;
  });
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

type StepsCelSchema = Record<string, CelType>;

const inferredByContext = new WeakMap<object, Map<string, StepsCelSchema | null>>();

/**
 * Each step name's `result` as a CEL type — the inferred scalar or the literal's
 * shape where every step of that name agrees, `dyn` elsewhere — or undefined
 * when no step carries an inferred result.
 *
 * Memoized per step context AND per `scopeSignature` — the names and types the
 * site binds beside the resource-wide globals (`item`, `error`, a kind's named
 * bindings). An expression's type depends on them, so two sites of one resource
 * binding a name differently must not share an answer.
 */
export function inferredStepsCelSchema(
  stepsSchema: Record<string, any>,
  env: CelEnvironment,
  scopeSignature: string,
): StepsCelSchema | undefined {
  let bySignature = inferredByContext.get(stepsSchema);
  if (!bySignature) inferredByContext.set(stepsSchema, (bySignature = new Map()));
  const cached = bySignature.get(scopeSignature);
  if (cached !== undefined) return cached ?? undefined;

  const properties = (stepsSchema.properties ?? {}) as Record<string, any>;
  if (!hasInferredResult(properties)) {
    bySignature.set(scopeSignature, null);
    return undefined;
  }

  const types = stepResultTypes(properties, env);
  const schema: StepsCelSchema = {};
  for (const name of Object.keys(properties)) {
    const reading = properties[name]?.properties?.result?.[READING_ALTERNATIVE];
    schema[name] = types.ofName(name, typeof reading === "number" ? reading : undefined);
  }
  bySignature.set(scopeSignature, schema);
  return schema;
}

/**
 * The type of each step name, resolved on demand: an expression is checked
 * against the results it reads, whichever order the steps are written in. A
 * result still being resolved when it is read again — two steps reading each
 * other — is `dyn` there.
 */
function stepResultTypes(properties: Record<string, any>, env: CelEnvironment) {
  const names = Object.keys(properties);
  const byName = new Map<string, CelType>();
  const byAlternative = new Map<string, CelType>();
  const resolving = new Set<string>();

  const alternatives = (name: string): readonly StepResultAlternative[] => {
    const result = properties[name]?.properties?.result as Record<string, any> | undefined;
    return alternativesOf(result) ?? (result ? [{ result }] : []);
  };

  /** The one type every step of `name` produces, leaving out alternative
   *  `except`; `dyn` when they differ or any claims nothing. */
  const ofName = (name: string, except?: number): CelType => {
    const key = `${name}\0${except ?? ""}`;
    const known = byName.get(key);
    if (known) return known;
    let agreed: CelType | undefined;
    let differ = false;
    alternatives(name).forEach(({ result }, index) => {
      if (index === except) return;
      const type = ofAlternative(name, index, result);
      if (agreed === undefined) agreed = type;
      else if (!typesEqual(agreed, type)) differ = true;
    });
    const type = agreed === undefined || differ || isDyn(agreed) ? DYN : agreed;
    byName.set(key, type);
    return type;
  };

  const ofAlternative = (name: string, index: number, result: Record<string, any>): CelType => {
    if (isLiteralResult(result)) return schemaType({ node: result[LITERAL_RESULT] }).type;
    const source = result[INFERRED_RESULT];
    if (typeof source !== "string") return DYN;
    const key = `${name}\0${index}`;
    const known = byAlternative.get(key);
    if (known) return known;
    if (resolving.has(key)) return DYN;
    resolving.add(key);
    const steps: StepsCelSchema = {};
    for (const other of names) {
      // Only a result the expression names is resolved; the rest exist untyped.
      steps[other] = !mentions(source, other)
        ? DYN
        : other === name
          ? ofName(name, index)
          : ofName(other);
    }
    const probe = env.clone();
    registerTypedSteps(probe, steps);
    // An expression the probe cannot type (a module call, a name only the full
    // scope binds) keeps its result `dyn`; the full check of that expression
    // reports whatever is wrong with it.
    const checked = probe.check(source);
    const type = checked.valid && RECORDED_TYPES.has(checked.typeName) ? checked.type : DYN;
    resolving.delete(key);
    byAlternative.set(key, type);
    return type;
  };

  return { ofName };
}

/** True when `source` writes `name` as a whole word. */
function mentions(source: string, name: string): boolean {
  let from = source.indexOf(name);
  while (from !== -1) {
    const before = source[from - 1];
    const after = source[from + name.length];
    if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
    from = source.indexOf(name, from + 1);
  }
  return false;
}

const isWordCharacter = (character: string | undefined): boolean =>
  character !== undefined && /[A-Za-z0-9_]/.test(character);

/**
 * Register `steps` as a closed record carrying each step's result type, keeping
 * the map reads a manifest writes over it: `'<step>' in steps` asks whether a
 * step ran (a branch that may not have), which the standard library's
 * `K in map<K, V>` answers for a record, since a record is a map with named
 * keys. No named type and no operator of its own — the shape IS the
 * declaration.
 */
export function registerTypedSteps(env: CelEnvironment, schema: StepsCelSchema): void {
  const fields = new Map<string, CelType>();
  for (const [name, result] of Object.entries(schema)) {
    fields.set(name, { kind: "record", fields: new Map([["result", result]]), open: false });
  }
  env.registerVariable("steps", { kind: "record", fields, open: false });
}
