import { Environment } from "@marvec/cel-vm";
import type { ResourceManifest } from "@telorun/sdk";

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

/** Build a CEL `Environment` with Telo's stdlib of functions. cel-vm's `registerFunction`
 *  takes (name, arity, impl) — there are no typed signatures and no `env.check()` for
 *  type inference, so all CEL type-checking is delegated to the VM at compile time
 *  (which only validates arity / undeclared identifiers in strict mode). */
export function buildCelEnvironment(handlers: CelHandlers = STUB_HANDLERS): Environment {
  const env = new Environment();
  env.registerFunction("join", 2, (list: unknown, sep: unknown) =>
    (list as unknown[]).map(String).join(String(sep)),
  );
  env.registerFunction("keys", 1, (map: unknown) => {
    if (map instanceof Map) return [...map.keys()];
    return Object.keys(map as Record<string, unknown>);
  });
  env.registerFunction("values", 1, (map: unknown) => {
    if (map instanceof Map) return [...map.values()];
    return Object.values(map as Record<string, unknown>);
  });
  env.registerFunction("sha256", 1, (s: unknown) => handlers.sha256(String(s)));
  return env;
}

/** Stub: cel-vm has no `env.check()` for return-type inference, and no `env.clone()`,
 *  so per-manifest typed environments aren't built. Returned env is the base env;
 *  callers that previously relied on `env.check()` should treat results as if the
 *  expression were untyped. */
export function buildTypedCelEnvironment(
  baseEnv: Environment,
  _manifest: ResourceManifest,
  _extraContextSchema?: Record<string, any> | null,
): Environment {
  return baseEnv;
}
