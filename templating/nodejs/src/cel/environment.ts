import { Environment } from "@marcbachmann/cel-js";
import { Stream } from "@telorun/sdk";

export interface CelHandlers {
  sha256: (s: string) => string;
  json: (value: unknown) => string;
}

const stub = (name: string) => () => {
  throw new Error(
    `${name}() is not available in this environment. ` +
      `Construct StaticAnalyzer or Loader with celHandlers to enable it.`,
  );
};

const STUB_HANDLERS: CelHandlers = {
  sha256: stub("sha256"),
  json: stub("json"),
};

/** Build a CEL `Environment` with Telo's stdlib of functions. Always registers the
 *  same function signatures (so `env.check()` succeeds for type-inference) — the
 *  handlers govern what the function does when called at runtime. Analyzer-only
 *  callers can omit handlers; runtime callers (kernel) must supply real ones.
 *
 *  Also registers the `Stream` object type, backed by the `Stream` class from
 *  `@telorun/sdk`. CEL's type-checker rejects values whose constructor isn't
 *  Object/Map/Array/Set/registered; producers that need to expose an
 *  `AsyncIterable` through a stream-typed property must wrap the iterable in
 *  `new Stream(...)` so its constructor is the registered class. The type has
 *  no fields, so terminal access (passing the value through CEL) succeeds but
 *  member access raises a CEL error at runtime — matching the analyzer's
 *  static check on `x-telo-stream`-marked properties. */
export function buildCelEnvironment(handlers: CelHandlers = STUB_HANDLERS): Environment {
  return new Environment({ unlistedVariablesAreDyn: true, enableOptionalTypes: true })
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
    .registerFunction("sha256(string): string", (s: string) => handlers.sha256(s))
    .registerFunction("json(dyn): string", (value: unknown) => handlers.json(value))
    .registerType("Stream", Stream as unknown as new (...args: unknown[]) => unknown);
}
