import { Environment, EvaluationError, type ASTNode } from "@marcbachmann/cel-js";
import { RuntimeError, type CompiledValue } from "@telorun/sdk";
import { nullableValueChain } from "../cel/analyze.js";
import { literalFragments, type InterpolationHole } from "../cel/interpolation-holes.js";
import type { AnalyzeEnv, AnalyzeResult, EngineDiagnostic, TemplatingEngine } from "../engine.js";
import { analyzeHoles, compileHoles, holeRegions, requireHoles } from "./hole-analysis.js";

const INTERPOLATE_ENGINE = "interpolate";

/**
 * The `!interpolate` engine: literal text with `${{ expr }}` holes, always a
 * string. Its meaning is exactly the CEL expression that joins the text with
 * `string(<hole>)` for each hole — every hole converts through CEL's own
 * `string()` overloads (RFC 3339 for a timestamp, `5400s` for a duration, UTF-8
 * for bytes), never the host language's conversion, so any CEL engine renders
 * the same text. A hole whose type has no `string()` overload is refused
 * statically, and a `dyn` hole that turns out null, a list or a map is refused
 * at runtime with the hole it came from.
 */
export const interpolateEngine: TemplatingEngine = {
  name: INTERPOLATE_ENGINE,
  language: "cel",

  compile(source, env) {
    const holes = requireHoles(INTERPOLATE_ENGINE, source);
    const fragments = literalFragments(source, holes);
    const { compiled, refs, calls, volatile } = compileHoles(holes, env);
    const convert = stringConversion(env.celEnv);
    return {
      __compiled: true,
      source,
      refs,
      calls,
      ...(volatile ? { volatile: true as const } : {}),
      call: (ctx: Record<string, unknown>): string => {
        let out = fragments[0]!;
        for (let i = 0; i < holes.length; i++) {
          out += convert(compiled[i]!.call(ctx), holes[i]!, source) + fragments[i + 1]!;
        }
        return out;
      },
    } satisfies CompiledValue;
  },

  analyze(source, env) {
    return analyzeHoles(source, env, (hole, result, ast) => holeVerdict(hole, result, ast, env));
  },

  producedType() {
    return { type: "string" };
  },

  expressionRegions(source) {
    return holeRegions(source);
  },
};

/** A clean hole's own checks, over the tree its analysis already built:
 *  whether it may be null, and whether CEL can turn its type into text at all. */
function holeVerdict(
  hole: InterpolationHole,
  result: AnalyzeResult,
  ast: ASTNode | undefined,
  env: AnalyzeEnv,
): readonly EngineDiagnostic[] {
  if (ast && env.contextSchema) {
    const chain = nullableValueChain(ast, env.contextSchema as Record<string, any>);
    if (chain !== null) {
      return [
        {
          code: "CEL_NULLABLE_ACCESS",
          message:
            `'${chain}' may be null, and a null has no text — guard it in the hole ` +
            `(e.g. '\${{ ${chain} != null ? ${chain} : "" }}').`,
        },
      ];
    }
  }
  if (result.type === undefined || convertibleTypes(env.celEnv).has(result.type)) return [];
  return [
    {
      code: "INTERPOLATION_HOLE_NOT_CONVERTIBLE",
      message:
        `the hole '\${{ ${hole.expr} }}' is ${result.type}, which CEL's string() cannot convert to text. ` +
        `Convert it inside the hole (e.g. join a list, or read the field you meant), or write the whole value as !cel.`,
    },
  ];
}

const CONVERTIBLE = new WeakMap<Environment, ReadonlySet<string>>();

/** The types a `string()` overload of `env` accepts, `dyn` among them — read
 *  off the registered overloads, so the check is the one evaluation applies. */
function convertibleTypes(env: Environment): ReadonlySet<string> {
  const cached = CONVERTIBLE.get(env);
  if (cached) return cached;
  const types = new Set<string>(["dyn"]);
  for (const fn of env.getDefinitions().functions) {
    if (fn.name === "string" && fn.receiverType === null && fn.params?.length === 1) {
      types.add(fn.params[0]!.type);
    }
  }
  CONVERTIBLE.set(env, types);
  return types;
}

type Conversion = (value: unknown, hole: InterpolationHole, source: string) => string;

const CONVERSIONS = new WeakMap<Environment, Conversion>();

/** CEL's `string(v)` in `env`, with every overload the environment registers. */
function stringConversion(env: Environment): Conversion {
  const cached = CONVERSIONS.get(env);
  if (cached) return cached;
  const program = env.parse("string(value)") as (ctx: { value: unknown }) => unknown;
  const conversion: Conversion = (value, hole, source) => {
    if (typeof value === "string") return value;
    try {
      return program({ value }) as string;
    } catch (error) {
      if (!(error instanceof EvaluationError)) throw error;
      throw new RuntimeError(
        "ERR_INTERPOLATION_HOLE_NOT_CONVERTIBLE",
        `the hole '\${{ ${hole.expr} }}' at offset ${hole.start} of !interpolate ${JSON.stringify(source)} ` +
          `evaluated to ${runtimeTypeOf(value)}, which CEL's string() cannot convert to text. ` +
          `Declare outputType on the resource producing it so the check sees its type, or guard it inside the hole.`,
      );
    }
  };
  CONVERSIONS.set(env, conversion);
  return conversion;
}

function runtimeTypeOf(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "a list";
  if (value instanceof Map || Object.getPrototypeOf(value) === Object.prototype) return "a map";
  return `a value of type ${(value as object).constructor?.name ?? typeof value}`;
}
