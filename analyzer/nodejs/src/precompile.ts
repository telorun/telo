import type { Environment } from "@marcbachmann/cel-js";
import { isCompiledValue, RuntimeError } from "@telorun/sdk";
import {
  defaultRegistry,
  interpolationShape,
  isRefSentinel,
  isTaggedSentinel,
} from "@telorun/templating";
import { untaggedInterpolationMessage } from "./untagged-interpolation.js";

/**
 * Walks a raw YAML document and replaces every tagged scalar an engine compiles
 * (`!cel`, `!interpolate`, `!sql`, …) with a CompiledValue wrapper. Throws on
 * CEL syntax errors. Intended to be called once per document at load time.
 *
 * A plain string is never an expression. One still holding `${{` is the
 * untagged interpolation spelling the `untagged-interpolation` migration
 * rewrites at load; reaching here means it was read without migrations, and it
 * is refused (`ERR_UNTAGGED_INTERPOLATION`) rather than silently read as text.
 */
export function precompileDoc(
  doc: unknown,
  env: Environment,
  moduleNames?: ReadonlySet<string>,
  path = "",
): unknown {
  // Tagged sentinel: dispatch to the engine. The result is decorated with
  // `__tagged` + `engine` + `source` when it's a CompiledValue so the
  // analyzer's diagnostic walk can identify it on compiled trees too;
  // engines returning plain values (e.g. `literal` → a string) pass through
  // verbatim — the runtime contract is "any scalar value is fine."
  // `!ref` sentinels are identity markers, not templating values. They must
  // survive precompile intact so the analyzer's `resolveRefSentinels` pass
  // can substitute them with `{kind, name}` objects against the resolved
  // resource manifest. Running the engine's `compile` here would prematurely
  // collapse the sentinel into its source string and the ref slot would
  // arrive at the controller as a bare name with no kind.
  if (isRefSentinel(doc)) return doc;
  if (isTaggedSentinel(doc)) {
    const engine = defaultRegistry().get(doc.engine);
    if (!engine) {
      throw new Error(`Unknown templating engine: !${doc.engine}`);
    }
    const compiled = engine.compile(doc.source, { celEnv: env, moduleNames });
    if (isCompiledValue(compiled)) {
      return {
        __tagged: true,
        __compiled: true,
        engine: doc.engine,
        source: doc.source,
        // The AST-derived root identifiers the engine computed, carried through
        // rather than dropped. This rebuild is where EVERY tagged sentinel's
        // compiled value is produced, so losing `refs` here lost them for every
        // `!cel` in every manifest — leaving a consumer that asks what an
        // expression READS (a template body deciding which nodes survive its
        // `init()`) with nothing but the source text to scan, which cannot tell
        // an identifier from a word inside a string literal.
        ...(compiled.refs ? { refs: compiled.refs } : {}),
        // The qualified module calls the engine resolved, carried for the same
        // reason `refs` is: re-deriving them needs the declaring module's name
        // set, which a consumer holding one expression does not have.
        ...(compiled.calls ? { calls: compiled.calls } : {}),
        ...(compiled.volatile ? { volatile: true } : {}),
        call: compiled.call.bind(compiled),
      };
    }
    return compiled;
  }
  if (typeof doc === "string") {
    if (interpolationShape(doc) !== "none") {
      throw new RuntimeError("ERR_UNTAGGED_INTERPOLATION", untaggedInterpolationMessage(path));
    }
    return doc;
  }
  if (Array.isArray(doc)) {
    return doc.map((item, i) => precompileDoc(item, env, moduleNames, `${path}[${i}]`));
  }
  // Only recurse into plain objects. Class instances (ResourceInstance, ScopeHandle, etc.)
  // are returned as-is — their prototype methods must not be lost by object reconstruction.
  if (doc !== null && typeof doc === "object" && Object.getPrototypeOf(doc) === Object.prototype) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
      result[k] = precompileDoc(v, env, moduleNames, path ? `${path}.${k}` : k);
    }
    return result;
  }
  return doc;
}
