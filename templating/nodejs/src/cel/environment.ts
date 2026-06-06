import { Environment } from "@marcbachmann/cel-js";
import { Stream } from "@telorun/sdk";
import { CEL_FUNCTIONS, type CelHandlers } from "./catalog.js";

export type { CelHandlers } from "./catalog.js";

const stub = (name: string) => () => {
  throw new Error(
    `${name}() is not available in this environment. ` +
      `Construct StaticAnalyzer or Loader with celHandlers to enable it.`,
  );
};

const STUB_HANDLERS: CelHandlers = {
  sha256: stub("sha256"),
  md5: stub("md5"),
  sha1: stub("sha1"),
  sha512: stub("sha512"),
  hmac: stub("hmac"),
  base64Encode: stub("base64Encode"),
  base64Decode: stub("base64Decode"),
  json: stub("json"),
};

/** Build a CEL `Environment` with Telo's stdlib. Every function comes from the
 *  single-source catalog (`CEL_FUNCTIONS`), so registration and the documented
 *  surface (`telo cel functions`) can never drift. Always registers the same
 *  signatures (so `env.check()` succeeds for type-inference); the host-injected
 *  handlers govern what `hostBacked` functions do at runtime. Analyzer-only
 *  callers can omit handlers (the stubs throw if such a function is evaluated);
 *  runtime callers (kernel) supply real ones.
 *
 *  Also registers the `Stream` object type, backed by the `Stream` class from
 *  `@telorun/sdk`. CEL's type-checker rejects values whose constructor isn't
 *  Object/Map/Array/Set/registered; producers that need to expose an
 *  `AsyncIterable` through a stream-typed property must wrap the iterable in
 *  `new Stream(...)` so its constructor is the registered class. The type has
 *  no fields, so terminal access (passing the value through CEL) succeeds but
 *  member access raises a CEL error at runtime — matching the analyzer's
 *  static check on `x-telo-stream`-marked properties. */
export function buildCelEnvironment(handlers: Partial<CelHandlers> = {}): Environment {
  const h: CelHandlers = { ...STUB_HANDLERS, ...handlers };
  let env = new Environment({ unlistedVariablesAreDyn: true, enableOptionalTypes: true });
  for (const fn of CEL_FUNCTIONS) {
    const impl = fn.build(h);
    // `register` lists one cel-js signature per arity (overloaded functions);
    // it falls back to `signature` for the single-arity common case.
    for (const sig of fn.register ?? [fn.signature]) {
      env = env.registerFunction(sig, impl);
    }
  }
  return env.registerType("Stream", Stream as unknown as new (...args: unknown[]) => unknown);
}
