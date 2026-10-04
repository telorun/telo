/**
 * An emitted module: its text, its key, its integrity header, and the one seam a host
 * stores it through.
 *
 * **The runtime is injected, never imported.** The module's default export is a factory
 * taking the runtime support library and answering one synchronous function per
 * expression, and the text names no specifier of any kind. An emitted module that imported
 * `@telorun/cel` would be loadable only where that specifier resolves — which rules out a
 * `data:` URL, a cache directory mounted somewhere else, and a host whose resolver is not
 * Node's — and, worse, it would silently accept a runtime of another version, which is
 * precisely what the key cannot see from the outside.
 *
 * **The key is wider than the source text, and the header is wider than the key.** The key
 * is a hash over the emitter's format generation, the engine version, the environment
 * digest and the canonical ordered list of expression sources. A key is a claim about a
 * *name*; the header is a fact about the *bytes*, and it carries five fields because the
 * provenance three answer only part of the question:
 *
 * - `format`, `engine`, `environment` — **provenance**. These are identical for every module
 *   one engine writes against one environment, so they catch a cache root shared by two
 *   engines and a stale environment, and **nothing else**. Two different modules of one
 *   engine carry byte-identical provenance.
 * - `key` — the module's **identity**: the key this text was written for. It catches a store
 *   that answered one key's lookup with another key's text, which the provenance fields
 *   cannot see at all and which an expression count can only catch by luck.
 * - `body` — the digest of the text **following the header line**, which covers every byte
 *   that is or could be read as code, the `integrity` export included. It catches a text
 *   truncated after its header and a text edited after it was written — and the banner says
 *   *edit the expression, not this*, which is evidence that someone will edit one. A text with
 *   an intact header, an exported factory and a matching function count **runs**, whatever its
 *   body says; that is the one failure here no retry undoes.
 *
 * `body` cannot live in the `integrity` export, because it covers that export: a digest in the
 * bytes it digests has no fixed point. So the header LINE carries all five and the export
 * carries the four that are checkable without the text — which is also the split between the
 * two paths. **Every mismatch on the store-read path is a recompile** that names itself in
 * `refused`; the load path, which has an object and not the bytes, refuses with
 * `emitted_module_rejected`.
 *
 * **There is no loader, and there is no filesystem.** A loader would have to reach a
 * filesystem (which this package may not), or be `eval` (which the closure backend exists
 * to avoid), or be a `data:` URL import (fine under Node, refused under a browser's content
 * security policy). Loading is the host's half; the engine writes the text, verifies what
 * comes back, and wires the loaded factory to the runtime.
 */

import type { CelProgram } from "./cel-program.js";
import { programOfStep } from "./cel-program.js";
import { celNone, celSome, celUint, isCelError, isCelOptional, asyncValueRefused, celError } from "./cel-value.js";
import { CelEngineError } from "./check-diagnostic.js";
import { celMapFromEntries } from "./cel-map-value.js";
import {
  boolOperand,
  callSiteOf,
  hasMember,
  optionalEntry,
  readHostValue,
  readName,
  readNameChain,
  readThrough,
  searchNameChain,
  type CelStep,
  type CompileTarget,
} from "./backend-runtime.js";
import {
  celAll,
  celExists,
  celExistsOne,
  celFilter,
  celMapComprehension,
} from "./comprehension-runtime.js";
import { ENGINE_VERSION } from "./engine-version.js";
import { ModuleEmitter, RUNTIME_BINDINGS, textSource, type RuntimeBinding } from "./js-emitter.js";
import { celIterable } from "./member-read.js";
import { optionalOfNonZero } from "./runtime-library.js";
import { sha256OfText } from "./sha256.js";
import type { CelNode } from "./syntax-tree.js";

/**
 * **Bumped on any change to the text the emitter writes for any tree** — not only when the
 * module's shape changes. It is the first component of the key and the first field of the
 * header, so a module written under one generation is never handed to an engine expecting
 * another.
 *
 * The wider rule is the one that holds, because the narrower one asks whoever makes the
 * change to decide that a text difference is semantically neutral — and that judgement is
 * exactly what produces the unrecoverable failure. The case in point is this emitter's own
 * first defect: temporaries numbered per function let a comprehension body's `let t0` shadow
 * the `t0` its caller held a bound value in, so `cel.bind(n, 2, xs.map(e, e + n))` answered
 * `[2, 4, 6]` for `[3, 4, 5]`. No signature moved, no library entry moved, no shape changed —
 * and a module cached before the fix would have gone on answering `[2, 4, 6]` forever.
 *
 * `tests/emitter-text.test.ts` is what makes the rule checkable: it pins the digest of the
 * code the emitter writes for a corpus drawn from the package's own total enumerations, beside
 * this number, so a change to that text fails naming the bump it owes.
 */
export const EMITTER_FORMAT_GENERATION = 2;

/** The prefix of the one line a stored module's header is read from. */
const HEADER_PREFIX = "//@telo.cel ";

/**
 * What an emitted module declares about itself in its `integrity` export: its provenance and
 * its own key. These are the four a loaded module can be held to, because checking them needs
 * nothing but the object the host imported.
 */
export interface EmittedIdentity {
  readonly format: number;
  readonly engine: string;
  readonly environment: string;
  /** The cache key this text was written for. */
  readonly key: string;
}

/**
 * What the header LINE declares: the identity, plus the digest of the body it precedes. The
 * body digest is here and nowhere else — a digest cannot live in the bytes it covers — so it
 * is verified on the one path that has the bytes in hand.
 */
export interface EmittedHeader extends EmittedIdentity {
  /** The digest of every byte after the header line. */
  readonly body: string;
}

/** One expression to emit: its source text, and the tree it read into. */
export interface EmittedExpression {
  readonly source: string;
  readonly root: CelNode;
}

export interface EmittedModule {
  /** The cache key: 64 hexadecimal characters a host names its stored copy by. */
  readonly key: string;
  readonly header: EmittedHeader;
  readonly text: string;
  /** The expression sources, in the order the factory answers functions for them. */
  readonly sources: readonly string[];
}

/**
 * Where a host keeps emitted module text, keyed by the key the engine computed. It is the
 * engine's only seam to a store, and the engine touches no filesystem itself.
 *
 * **A write is atomic** — written elsewhere and renamed into place — and that is the store's
 * contract rather than a suggestion: several hosts share one cache root. It is still how a
 * half-written entry is *avoided*, and avoiding one is better than detecting it. But the
 * guarantee no longer rests on it: the header's `body` digest **detects** a truncated or
 * edited text, so a host that gets the write wrong costs a recompile rather than running
 * whatever the bytes happen to say.
 *
 * It is **synchronous**, because emission is: a store over a filesystem writes and renames
 * synchronously, and a store over anything slower is a map the host filled before it asked.
 */
export interface EmittedModuleStore {
  read(key: string): string | undefined;
  write(key: string, text: string): void;
}

/** A module taken from the store, or emitted because the store had nothing usable. */
export interface StoredEmittedModule extends EmittedModule {
  /** Why the stored copy was not used, where there was one and it was refused. */
  readonly refused?: string;
  /** Whether the text was emitted now rather than read from the store. */
  readonly emitted: boolean;
}

/** The runtime object an emitted module's factory is handed. */
export type EmittedRuntime = Readonly<Record<RuntimeBinding, unknown>>;

/** What an emitted module's default export is. */
export type EmittedFactory = (runtime: EmittedRuntime) => readonly CelStep[];

// --- the key and the header ------------------------------------------------

/** The four fields the `integrity` export carries, in one fixed order. */
function identityJson(identity: EmittedIdentity): string {
  return (
    `{"format":${identity.format},"engine":${JSON.stringify(identity.engine)},` +
    `"environment":${JSON.stringify(identity.environment)},"key":${JSON.stringify(identity.key)}}`
  );
}

/** The five fields the header line carries. */
function headerJson(header: EmittedHeader): string {
  return `${identityJson(header).slice(0, -1)},"body":${JSON.stringify(header.body)}}`;
}

/**
 * The key for a set of expressions against an environment.
 *
 * The four components are hashed in one order, each on its own line with its source
 * escaped, so no expression's text can be read as another component. Source alone would
 * serve the wrong module for exactly the capability this package exists for — a host that
 * replaced a standard function has the same text and a different environment.
 */
export function emittedModuleKey(
  environmentDigest: string,
  sources: readonly string[],
): string {
  return sha256OfText(
    [
      `format ${EMITTER_FORMAT_GENERATION}`,
      `engine ${ENGINE_VERSION}`,
      `environment ${environmentDigest}`,
      ...sources.map((source) => `expression ${JSON.stringify(source)}`),
    ].join("\n"),
  );
}

/** What an emission against this environment, for these sources, declares about itself. */
export function emittedModuleIdentity(
  environmentDigest: string,
  sources: readonly string[],
): EmittedIdentity {
  return {
    format: EMITTER_FORMAT_GENERATION,
    engine: ENGINE_VERSION,
    environment: environmentDigest,
    key: emittedModuleKey(environmentDigest, sources),
  };
}

/**
 * The header line's own JSON and the body it precedes — found by position rather than by
 * splitting the text into lines, because the body can be a megabyte and is digested whole.
 */
function headerAndBody(text: string): { readonly json: string; readonly body: string } | undefined {
  const leading = text.startsWith(HEADER_PREFIX);
  const found = leading ? 0 : text.indexOf(`\n${HEADER_PREFIX}`);
  if (!leading && found < 0) return undefined;
  const from = leading ? 0 : found + 1;
  const ends = text.indexOf("\n", from);
  return {
    json: text.slice(from + HEADER_PREFIX.length, ends < 0 ? text.length : ends),
    // Exactly what the emission digested: every byte after the header line's newline.
    body: ends < 0 ? "" : text.slice(ends + 1),
  };
}

/**
 * The header a stored text declares, or nothing where it declares none.
 *
 * It is read from the **text**, before anything is loaded: a text whose header is wrong is
 * never handed to a loader at all, which is the cheapest place to refuse and the only place
 * that works for a text that would not even parse.
 */
export function readEmittedHeader(text: string): EmittedHeader | undefined {
  const held = headerAndBody(text);
  if (!held) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(held.json) as unknown;
  } catch {
    return undefined;
  }
  return asHeader(parsed);
}

function asIdentity(parsed: unknown): EmittedIdentity | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const held = parsed as Record<string, unknown>;
  if (typeof held.format !== "number") return undefined;
  if (typeof held.engine !== "string" || typeof held.environment !== "string") return undefined;
  if (typeof held.key !== "string") return undefined;
  return {
    format: held.format,
    engine: held.engine,
    environment: held.environment,
    key: held.key,
  };
}

function asHeader(parsed: unknown): EmittedHeader | undefined {
  const identity = asIdentity(parsed);
  if (!identity) return undefined;
  const body = (parsed as Record<string, unknown>).body;
  return typeof body === "string" ? { ...identity, body } : undefined;
}

/**
 * Why a stored text is not the module that was asked for, or nothing where it is.
 *
 * This is the **store-read path**, the one that has the bytes, so it is where the body digest
 * is verified as well as the identity — and every answer is a recompile, never a refusal the
 * caller has to handle. Each names what differed, because a host that logs a recompile wants
 * to know whether it was a stale cache, two engines sharing a root, a store that answered the
 * wrong lookup, or a text somebody edited.
 */
export function emittedModuleRefusal(text: string, expected: EmittedIdentity): string | undefined {
  const verdict = verifyStoredText(text, expected);
  return "refused" in verdict ? verdict.refused : undefined;
}

/**
 * The header a stored text proved, or why it proved none. One pass: the caller that accepts
 * the text wants the header it read rather than a second read of the same bytes.
 */
function verifyStoredText(
  text: string,
  expected: EmittedIdentity,
): { readonly header: EmittedHeader } | { readonly refused: string } {
  const held = headerAndBody(text);
  if (!held) return { refused: "the stored text carries no integrity header" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(held.json) as unknown;
  } catch {
    return { refused: "the stored text's integrity header is not readable" };
  }
  const header = asHeader(parsed);
  if (!header) return { refused: "the stored text's integrity header is not an emitted module's" };
  const mismatch = identityRefusal(header, expected);
  if (mismatch) return { refused: mismatch };
  const body = sha256OfText(held.body);
  if (body !== header.body) {
    return {
      refused: `the stored module's body does not match the digest its header declares (${header.body} against ${body})`,
    };
  }
  return { header };
}

/** Why an identity is not the one asked for, or nothing where it is. */
function identityRefusal(held: EmittedIdentity, expected: EmittedIdentity): string | undefined {
  if (held.format !== expected.format) {
    return `the stored module was emitted in format generation ${held.format} and this engine emits ${expected.format}`;
  }
  if (held.engine !== expected.engine) {
    return `the stored module was emitted by engine ${held.engine} and this engine is ${expected.engine}`;
  }
  if (held.environment !== expected.environment) {
    return `the stored module was emitted against environment ${held.environment} and this environment is ${expected.environment}`;
  }
  if (held.key !== expected.key) {
    return `the stored module declares key ${held.key} and the module asked for is ${expected.key}`;
  }
  return undefined;
}

// --- emission --------------------------------------------------------------

/**
 * One module for a set of expressions. Byte-identical for the same expressions in the same
 * order against the same environment: nothing here reads a clock, a counter outside the
 * emission, or the iteration order of anything the caller did not order.
 */
export function emitModule(
  target: CompileTarget,
  environmentDigest: string,
  expressions: readonly EmittedExpression[],
): EmittedModule {
  const emitter = new ModuleEmitter(target);
  const functions = expressions.map((expression) => emitter.emitFunction(expression.root));
  const sources = expressions.map((expression) => expression.source);
  const identity = emittedModuleIdentity(environmentDigest, sources);
  // The BODY is everything after the header line, and the header declares its digest — so
  // it is built first, and the two banner lines are all the header does not cover.
  const body = [
    ...sources.map((source, at) => `// ${at}: ${textSource(source)}`),
    `export const integrity = ${identityJson(identity)};`,
    "export default function (runtime) {",
    `  const { ${RUNTIME_BINDINGS.join(", ")} } = runtime;`,
    ...emitter.hoistedLines().map((held) => `  ${held}`),
    "  return [",
    ...functions.map((held) => `    ${held},`),
    "  ];",
    "}",
    "",
  ].join("\n");
  const header: EmittedHeader = { ...identity, body: sha256OfText(body) };
  const text = [
    "// @telorun/cel: an emitted module. Generated - edit the expression, not this.",
    "// The runtime is the factory's argument; this module imports nothing.",
    `${HEADER_PREFIX}${headerJson(header)}`,
    body,
  ].join("\n");
  return { key: identity.key, header, text, sources };
}

/**
 * The module for a set of expressions, from the store where it holds a copy whose header
 * matches, and emitted and written where it does not.
 *
 * The header check is what makes this safe to call on a shared cache root: a stored text
 * that does not prove it was emitted by this engine, in this format, against this
 * environment is replaced rather than run.
 */
export function storedEmittedModule(
  target: CompileTarget,
  environmentDigest: string,
  sources: readonly string[],
  /** The trees, read only where there is something to emit — a hit parses nothing. */
  expressions: () => readonly EmittedExpression[],
  store: EmittedModuleStore,
): StoredEmittedModule {
  const identity = emittedModuleIdentity(environmentDigest, sources);
  const held = store.read(identity.key);
  const verdict = held === undefined ? undefined : verifyStoredText(held, identity);
  if (verdict && "header" in verdict) {
    // The stored text proved itself whole, so it is the module — carrying the header read
    // back from the bytes rather than one reconstructed, since those bytes are what loads.
    return { key: identity.key, header: verdict.header, text: held!, sources, emitted: false };
  }
  const written = emitModule(target, environmentDigest, expressions());
  store.write(written.key, written.text);
  return { ...written, ...(verdict ? { refused: verdict.refused } : {}), emitted: true };
}

// --- what a loaded module is handed, and what it answers --------------------

/**
 * The runtime support library an emitted module's factory takes: every operation the
 * emitted code calls, bound to this environment.
 *
 * Each entry is the function the **closure backend** calls for the same operation —
 * literally the same reference — which is what makes "the two backends answer identically"
 * a property of the wiring rather than a hope the tests confirm.
 */
export function emitterRuntime(target: CompileTarget): EmittedRuntime {
  return {
    asyncValueRefused,
    boolOperand,
    callSite: (name: string, form: "global" | "receiver", range: [number, number]) =>
      callSiteOf(target, name, form, range),
    celAll,
    celError,
    celExists,
    celExistsOne,
    celFilter,
    celIterable,
    celMapComprehension,
    celMapFromEntries,
    celSome,
    celUint,
    constants: target.constants,
    hasMember,
    isCelError,
    isCelOptional,
    none: celNone(),
    optionalEntry,
    optionalOfNonZero,
    readHostValue,
    readName,
    readNameChain,
    readThrough,
    searchNameChain,
  };
}

/**
 * The programs a loaded emitted module answers, after its header is verified.
 *
 * This is the **load path**: it has an object the host imported and not the bytes, so it
 * checks the four fields the `integrity` export carries. A module that declares no header,
 * declares another format, engine or environment, declares **another key** — which is a host
 * that imported bytes this engine never hashed — exports no factory, or answers a different
 * number of functions than the expressions asked for is refused with
 * `emitted_module_rejected`. The function count stays as the cheap backstop; the `key` field
 * is what actually distinguishes two modules of one engine.
 *
 * The body digest is **not** checked here, and cannot be: it covers the `integrity` export,
 * so it lives only in the header line and is verified where the bytes are
 * (`emittedModuleRefusal`, on the store-read path). Nothing here imports or evaluates
 * anything; the module arrived already loaded, by whatever means the host loads one.
 */
export function programsFromEmittedModule(
  loaded: { readonly integrity?: unknown; readonly default?: unknown },
  expected: EmittedModule,
  runtime: EmittedRuntime,
): readonly CelProgram[] {
  const identity = asIdentity(loaded.integrity);
  if (!identity) {
    throw new CelEngineError(
      "emitted_module_rejected",
      "the loaded module declares no integrity header, so it is not an emitted CEL module",
    );
  }
  const refusal = identityRefusal(identity, expected.header);
  if (refusal) throw new CelEngineError("emitted_module_rejected", refusal);
  if (typeof loaded.default !== "function") {
    throw new CelEngineError(
      "emitted_module_rejected",
      "an emitted module's default export is the factory that takes the runtime",
    );
  }
  const steps = (loaded.default as EmittedFactory)(runtime);
  if (!Array.isArray(steps) || steps.length !== expected.sources.length) {
    throw new CelEngineError(
      "emitted_module_rejected",
      `the loaded module answers ${Array.isArray(steps) ? steps.length : "no"} functions and ${expected.sources.length} expressions were emitted`,
    );
  }
  return expected.sources.map((source, at) => programOfStep(source, steps[at]!));
}
