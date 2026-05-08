import type { Environment } from "@marcbachmann/cel-js";
import { isCompiledValue } from "@telorun/sdk";
import { compileString, defaultRegistry, isTaggedSentinel } from "@telorun/templating";

/**
 * Walks a raw YAML document and replaces all `${{ expr }}` strings (and
 * `!cel`-tagged sentinels) with CompiledValue wrappers. Throws on CEL syntax
 * errors. Intended to be called once per document at load time.
 *
 * Note on Telo.Definition / Telo.Abstract: the walker traverses these too.
 * Their `schema` fields are JSON Schema metadata and don't typically contain
 * `${{ }}` text, so compile is a no-op there. Their `template` fields, on
 * the other hand, *do* carry CEL — Definition-driven templates are expanded
 * by the kernel and rely on the precompiled tree. If a description or
 * example string inside a schema happens to contain `${{ }}`, it will be
 * interpreted as CEL; tag it `!literal` to opt out.
 */
export function precompileDoc(doc: unknown, env: Environment): unknown {
  // Tagged sentinel: dispatch to the engine. The result is decorated with
  // `__tagged` + `engine` + `source` when it's a CompiledValue so the
  // analyzer's diagnostic walk can identify it on compiled trees too;
  // engines returning plain values (e.g. `literal` → a string) pass through
  // verbatim — the runtime contract is "any scalar value is fine."
  if (isTaggedSentinel(doc)) {
    const engine = defaultRegistry().get(doc.engine);
    if (!engine) {
      throw new Error(`Unknown templating engine: !${doc.engine}`);
    }
    const compiled = engine.compile(doc.source, { celEnv: env });
    if (isCompiledValue(compiled)) {
      return {
        __tagged: true,
        __compiled: true,
        engine: doc.engine,
        source: doc.source,
        call: compiled.call.bind(compiled),
      };
    }
    return compiled;
  }
  if (typeof doc === "string") return compileString(doc, env);
  if (Array.isArray(doc)) return doc.map((item) => precompileDoc(item, env));
  // Only recurse into plain objects. Class instances (ResourceInstance, ScopeHandle, etc.)
  // are returned as-is — their prototype methods must not be lost by object reconstruction.
  if (doc !== null && typeof doc === "object" && Object.getPrototypeOf(doc) === Object.prototype) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
      result[k] = precompileDoc(v, env);
    }
    return result;
  }
  return doc;
}
