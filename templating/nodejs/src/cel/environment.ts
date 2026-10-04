/**
 * The two environments, now built on `@telorun/cel`.
 *
 * **The dialect is no longer declared here.** Telo's 67 functions and their 86 signatures
 * ship inside the engine as data plus implementations, registered through the very
 * `registerFunction` a host uses, so this package no longer carries a catalog table of its
 * own: `registerFunctionCatalog` is what the dialect IS, and `functionCatalog()` is the one
 * listing surface `telo cel functions` reads. What is left here is the pair of environments
 * and the host handlers — the only part that was ever this package's.
 *
 * A second engine reproduces the two separately, so they stay named separately:
 * `buildCelLanguageEnvironment()` is CEL under Telo's options and nothing else, and
 * `buildCelEnvironment(handlers?)` is the dialect built on it.
 */
import {
  CelEnvironment,
  functionCatalog,
  registerFunctionCatalog,
  type CelCatalogHandlers,
} from "@telorun/cel";

/** The nine functions the host answers for. The engine's own seam, re-exported so a
 *  consumer naming it does not have to name the engine. */
export type CelHandlers = CelCatalogHandlers;

const stub = (name: string) => () => {
  throw new Error(
    `${name}() is not available in this environment. ` +
      `Construct StaticAnalyzer or Loader with celHandlers to enable it.`,
  );
};

/**
 * What a host-backed function does where the host supplied nothing.
 *
 * The engine's own answer for a missing handler is the `unbound_function` error VALUE,
 * naming the function — which is what an analyzer wants, since it never evaluates. These
 * throw instead, keeping the message this package has always produced for a caller that
 * built an analyzer-only environment and then evaluated through it.
 */
const STUB_HANDLERS: CelHandlers = {
  sha256: stub("sha256"),
  md5: stub("md5"),
  sha1: stub("sha1"),
  sha512: stub("sha512"),
  hmac: stub("hmac"),
  base64Encode: stub("base64Encode"),
  base64Decode: stub("base64Decode"),
  json: stub("json"),
  joinPath: stub("joinPath"),
};

/**
 * cel-go defaults HomogeneousAggregateLiterals OFF: heterogeneous list/map literals unify
 * to `dyn` rather than erroring, which is what a manifest needs (`request`, rows, …).
 * `unlistedVariablesAreDyn` is on because a host types only part of what a site may read,
 * and optional types are on because the manifest surface uses them.
 */
const ENVIRONMENT_OPTIONS = {
  unlistedVariablesAreDyn: true,
  enableOptionalTypes: true,
  homogeneousAggregateLiterals: false,
} as const;

/**
 * The bare CEL language under Telo's options: the standard library and nothing else — no
 * catalog, no `Stream`. The dialect is built on it, and the language conformance vectors
 * run against it.
 */
export function buildCelLanguageEnvironment(): CelEnvironment {
  return new CelEnvironment(ENVIRONMENT_OPTIONS);
}

/**
 * Every function the LANGUAGE declares, for documentation that must tell the language and
 * the dialect apart. Subtracting by signature text does not work — a declared `list` is
 * normalized — so the base set is asked for directly.
 */
export function celBuiltinFunctions(): ReturnType<CelEnvironment["definitions"]>["functions"] {
  return buildCelLanguageEnvironment().definitions().functions;
}

/** Telo's dialect: the language, the function catalog, and the live `Stream` type. */
export function buildCelEnvironment(handlers: Partial<CelHandlers> = {}): CelEnvironment {
  const environment = buildCelLanguageEnvironment();
  registerFunctionCatalog(environment, { handlers: { ...STUB_HANDLERS, ...handlers } });
  // A live handle: `dyn` underneath with no conversion and no member, so reading anything
  // off one is refused at check. It needs no constructor — identity by class is what the
  // engine replaced, and at runtime a stream is whatever the producer handed over.
  return environment.registerType({ name: "Stream", base: "dyn" });
}

/** The dialect's functions as the one listing surface answers them. */
export function celFunctionCatalog(): ReturnType<typeof functionCatalog> {
  return functionCatalog();
}
