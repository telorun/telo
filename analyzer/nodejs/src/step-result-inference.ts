import type { CelEnvironment } from "@telorun/cel";
import { CEL_ENGINE, isTaggedSentinel } from "@telorun/templating";

/**
 * A pure step's result, typed by the CEL type its own expression checks to.
 *
 * `steps.<name>.result` of a `value:` step that computes (a call, arithmetic, a
 * ternary) used to be untyped, so `steps.a.result + steps.b.result` passed
 * `telo check` whatever the two were and failed at dispatch with
 * `no such overload: dyn<double> + dyn<int>`. The step context carries the
 * expression's source under a derived marker; registering `steps` with the CEL
 * environment checks each marked source in step order — every earlier result
 * already typed — and records its type.
 *
 * Only scalar types the analyzer infers ITSELF are recorded. A number an author
 * schema declares stays `dyn` at this layer: whether it arrives as `int` or
 * `double` depends on where it came from, and guessing there would reject
 * manifests that run.
 */
const INFERRED_RESULT = "x-telo-inferred-result-of";

const RECORDED_TYPES = new Set(["int", "uint", "double", "string", "bool", "bytes"]);

/** The step-context schema for a pure step's result: the expression's source
 *  under the marker, and otherwise open. Undefined when the value is not a CEL
 *  expression. */
export function inferredResultSchema(value: unknown): Record<string, any> | undefined {
  if (!isTaggedSentinel(value) || value.engine !== CEL_ENGINE) return undefined;
  return { [INFERRED_RESULT]: value.source };
}

type StepsCelSchema = Record<string, Record<string, string>>;

const inferredByContext = new WeakMap<object, Map<string, StepsCelSchema | null>>();

/**
 * The `steps` variable's CEL schema — one closed type per step whose `result` is
 * the inferred scalar, `dyn` elsewhere — or undefined when no step carries an
 * inferred result.
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
  const marked = Object.values(properties).some(
    (step) => typeof step?.properties?.result?.[INFERRED_RESULT] === "string",
  );
  if (!marked) {
    bySignature.set(scopeSignature, null);
    return undefined;
  }

  const schema: Record<string, Record<string, string>> = {};
  for (const [name, step] of Object.entries(properties)) {
    const source = step?.properties?.result?.[INFERRED_RESULT];
    let type = "dyn";
    if (typeof source === "string") {
      const probe = env.clone();
      registerTypedSteps(probe, { ...schema });
      // An expression the probe cannot type (a module call, a name only the full
      // scope binds) keeps its result `dyn`; the full check of that expression
      // reports whatever is wrong with it.
      const checked = probe.check(source);
      if (checked.valid && RECORDED_TYPES.has(checked.typeName)) type = checked.typeName;
    }
    schema[name] = { result: type };
  }
  bySignature.set(scopeSignature, schema);
  return schema;
}

/**
 * Register `steps` as a closed record carrying each step's result type, keeping
 * the map reads a manifest writes over it: `'<step>' in steps` asks whether a
 * step ran (a branch that may not have), which the standard library's
 * `K in map<K, V>` answers for a record, since a record is a map with named
 * keys. No named type and no operator of its own — the shape IS the
 * declaration.
 */
export function registerTypedSteps(env: CelEnvironment, schema: StepsCelSchema): void {
  const fields: Record<string, { fields: Record<string, string> }> = {};
  for (const [name, step] of Object.entries(schema)) fields[name] = { fields: step };
  env.registerVariable("steps", { fields });
}
