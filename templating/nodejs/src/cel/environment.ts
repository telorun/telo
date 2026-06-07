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
/** Expand a documented signature that may contain `type?`-marked optional
 *  parameters into one cel-js registration signature per arity. For example,
 *  `"nowIso(string?): string"` produces `["nowIso(): string",
 *  "nowIso(string): string"]`. Required parameters must precede optional ones.
 *  Returns `[signature]` unchanged when no `?` is present or the signature
 *  cannot be parsed. */
export function deriveSignatures(signature: string): string[] {
  const m = signature.match(/^(\w+)\((.*?)\):\s*(.+)$/);
  if (!m) return [signature];
  const name = m[1]!;
  const paramsStr = m[2]!.trim();
  const returnType = m[3]!.trim();
  if (!paramsStr.includes("?")) return [signature];

  const params = paramsStr.split(",").map((p) => p.trim());
  const required: string[] = [];
  const optional: string[] = [];
  for (const p of params) {
    if (p.endsWith("?")) {
      optional.push(p.slice(0, -1));
    } else {
      if (optional.length > 0) return [signature];
      required.push(p);
    }
  }
  if (optional.length === 0) return [signature];

  return Array.from({ length: optional.length + 1 }, (_, i) => {
    const allParams = [...required, ...optional.slice(0, i)];
    return `${name}(${allParams.join(", ")}): ${returnType}`;
  });
}

export function buildCelEnvironment(handlers: Partial<CelHandlers> = {}): Environment {
  const h: CelHandlers = { ...STUB_HANDLERS, ...handlers };
  let env = new Environment({ unlistedVariablesAreDyn: true, enableOptionalTypes: true });
  for (const fn of CEL_FUNCTIONS) {
    const impl = fn.build(h);
    // `register` lists one cel-js signature per arity (overloaded functions).
    // When absent, `deriveSignatures` expands `type?` optional-param notation
    // into one registration per arity — so `nowIso(string?): string` registers
    // both `nowIso(): string` and `nowIso(string): string` automatically.
    for (const sig of fn.register ?? deriveSignatures(fn.signature)) {
      env = env.registerFunction(sig, impl);
    }
  }
  return env.registerType("Stream", Stream as unknown as new (...args: unknown[]) => unknown);
}
