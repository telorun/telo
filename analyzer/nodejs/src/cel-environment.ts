import { Environment } from "@marcbachmann/cel-js";
import type { ResourceManifest } from "@telorun/sdk";
import { jsonSchemaToCelType } from "./schema-compat.js";

export interface CelHandlers {
  sha256: (s: string) => string;
}

const stub = (name: string) => () => {
  throw new Error(
    `${name}() is not available in this environment. ` +
      `Construct StaticAnalyzer or Loader with celHandlers to enable it.`,
  );
};

const STUB_HANDLERS: CelHandlers = {
  sha256: stub("sha256"),
};

/** Build a CEL `Environment` with Telo's stdlib of functions. Always registers the
 *  same function signatures (so `env.check()` succeeds for type-inference) — the
 *  handlers govern what the function does when called at runtime. Analyzer-only
 *  callers can omit handlers; runtime callers (kernel) must supply real ones. */
export function buildCelEnvironment(handlers: CelHandlers = STUB_HANDLERS): Environment {
  return new Environment({ unlistedVariablesAreDyn: true })
    .registerFunction("join(list, string): string", (list: unknown[], sep: string) =>
      list.map(String).join(sep),
    )
    .registerFunction("keys(map): list", (map: unknown) => {
      if (map instanceof Map) return [...map.keys()];
      return Object.keys(map as Record<string, unknown>);
    })
    .registerFunction("values(map): list", (map: unknown) => {
      if (map instanceof Map) return [...map.values()];
      return Object.values(map as Record<string, unknown>);
    })
    .registerFunction("sha256(string): string", (s: string) => handlers.sha256(s));
}

/** Clone `baseEnv` and register typed variable declarations so that
 *  `env.check(expr)` can infer return types for expressions referencing known variables.
 *
 *  - `variables`: typed from the manifest's `variables` field if it is a schema map
 *    (only module-identity docs — `Telo.Application` / `Telo.Library` — carry this); otherwise registered as `map` (dyn).
 *  - `secrets`, `resources`, `env`: always `map` (dyn — output schemas unknown).
 *  - `extraContextSchema`: additional variables from an `x-telo-context` annotation.
 *
 *  NOTE: The set of kernel globals registered here must match `KERNEL_GLOBAL_NAMES`
 *  in kernel-globals.ts, which is used for chain-access validation. */
export function buildTypedCelEnvironment(
  baseEnv: Environment,
  manifest: ResourceManifest,
  extraContextSchema?: Record<string, any> | null,
): Environment {
  try {
    const env = baseEnv.clone();

    // Build typed ObjectSchema from manifest.variables if it looks like a schema map
    const vars = (manifest as Record<string, unknown>).variables;
    if (vars !== null && typeof vars === "object" && !Array.isArray(vars)) {
      const entries = Object.entries(vars as Record<string, unknown>).filter(
        ([, v]) => v !== null && typeof v === "object" && !Array.isArray(v),
      );
      if (entries.length > 0) {
        const schema: Record<string, string> = {};
        for (const [k, v] of entries) {
          schema[k] = jsonSchemaToCelType(v as Record<string, any>);
        }
        (env as any).registerVariable({ name: "variables", schema });
      } else {
        env.registerVariable("variables", "map");
      }
    } else {
      env.registerVariable("variables", "map");
    }

    env.registerVariable("secrets", "map");
    env.registerVariable("resources", "map");
    env.registerVariable("env", "map");

    if (extraContextSchema?.properties) {
      for (const [name, propSchema] of Object.entries(
        extraContextSchema.properties as Record<string, any>,
      )) {
        if (!env.hasVariable(name)) {
          env.registerVariable(name, jsonSchemaToCelType(propSchema as Record<string, any>));
        }
      }
    }

    return env;
  } catch {
    return baseEnv.clone();
  }
}
