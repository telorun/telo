/**
 * One call per dispatch key, written from the registry's own listing.
 *
 * Two gates read it — the backend-identity comparison over every registered call, and the
 * emitted-text pin — and they must generate the **same** sources from the same listing: two
 * generators would be two corpora, and the pin would then be over text no identity gate ever
 * compared.
 */

import {
  CelEnvironment,
  isIdentifierSpelling,
  registerFunctionCatalog,
  type CelCatalogHandlers,
  type FunctionDefinition,
} from "../src/index.js";

/** Deterministic stand-ins for the nine the host answers, so their calls compare by value. */
export const HANDLERS: CelCatalogHandlers = {
  sha256: (text) => `sha256:${text}`,
  md5: (text) => `md5:${text}`,
  sha1: (text) => `sha1:${text}`,
  sha512: (text) => `sha512:${text}`,
  hmac: (algorithm, key, message) => `hmac:${algorithm}:${key}:${message}`,
  base64Encode: (text) => `base64:${text}`,
  base64Decode: (text) => `plain:${text}`,
  json: () => "json",
  joinPath: (base, relative) => `${base}/${relative}`,
};

/** An environment holding CEL's own library and the function catalog beside it. */
export function catalogEnvironment(options: { readonly unlistedVariablesAreDyn?: boolean } = {}): CelEnvironment {
  const environment = new CelEnvironment({ enableOptionalTypes: true, ...options });
  registerFunctionCatalog(environment, { handlers: HANDLERS });
  return environment;
}

/** One value of each type the registrations are written over. */
const SAMPLES: Readonly<Record<string, string>> = {
  bool: "true",
  bytes: "b'ab'",
  double: "2.5",
  int: "3",
  uint: "3u",
  string: "'ab'",
  null: "null",
  type: "int",
  dyn: "dyn(2.5)",
  "google.protobuf.Timestamp": "timestamp('2024-03-04T05:06:07.008009010Z')",
  "google.protobuf.Duration": "duration('90.5s')",
  "list<A>": "[1, 2]",
  "list<dyn>": "[1, 2]",
  "list<string>": "['a', 'b']",
  "map<K, V>": "{'a': 1}",
  "map<dyn, dyn>": "{'a': 1}",
  "optional<A>": "optional.of(1)",
  // A type parameter is unresolved, so a value of any type stands for it. `K` is a map's
  // key type, where only the four key types stand.
  A: "1",
  K: "'a'",
};

function sample(type: string): string {
  const held = SAMPLES[type];
  if (held === undefined) throw new Error(`no sample value for the type ${JSON.stringify(type)}`);
  return held;
}

/**
 * The source that calls one signature. An operator is written in operator syntax, because
 * that is the only syntax the parser reads it in — `+(1, 2)` is a call to a function named
 * `+`, which nothing registers. A volatile call is wrapped in `type(…)`, which is what
 * makes its answer comparable at all.
 */
export function callSource(held: FunctionDefinition): string {
  const args = held.parameters.map(sample);
  const call =
    held.receiverType !== null
      ? `(${sample(held.receiverType)}).${held.name}(${args.join(", ")})`
      : written(held.name, args);
  return held.deterministic ? call : `type(${call})`;
}

function written(name: string, args: readonly string[]): string {
  const infix = name === "in" || !isIdentifierSpelling(name);
  if (!infix) return `${name}(${args.join(", ")})`;
  if (args.length === 1) return `${name}(${args[0]})`;
  return `(${args[0]}) ${name} (${args[1]})`;
}

/** A registration's dispatch key, for a count that proves one call per key. */
export function keyOf(held: FunctionDefinition): string {
  return `${held.receiverType === null ? "" : `${held.receiverType}.`}${held.name}(${held.parameters.join(", ")})`;
}
