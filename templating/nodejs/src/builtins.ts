import { celEngine } from "./engines/cel.js";
import { literalEngine } from "./engines/literal.js";
import { refEngine } from "./engines/ref.js";
import { sqlEngine } from "./engines/sql.js";
import { TemplatingEngineRegistry } from "./registry.js";
import type { TemplatingEngine } from "./engine.js";

/** Single source of truth for the built-in templating engines. Every host
 *  (kernel, analyzer, editor, vscode extension) calls `createDefaultRegistry`
 *  so the parse-side YAML tag set, the precompile dispatch, and the analyzer
 *  agree on which engines exist. Per-host à-la-carte registration would let
 *  a manifest validate clean in one host (e.g. `cel` only) and crash in
 *  another (e.g. `cel + literal`); always ship the same set. */
export const builtinEngines: readonly TemplatingEngine[] = [
  celEngine,
  literalEngine,
  refEngine,
  sqlEngine,
];

export function createDefaultRegistry(): TemplatingEngineRegistry {
  const registry = new TemplatingEngineRegistry();
  for (const engine of builtinEngines) {
    registry.register(engine);
  }
  return registry;
}

let defaultRegistryCache: TemplatingEngineRegistry | undefined;

/** Memoized singleton: returns the default registry. Hosts that don't need
 *  per-instance isolation (precompile, the analyzer's tagged-value walker)
 *  should use this so they share the same registry instance the YAML tag
 *  factory uses. */
export function defaultRegistry(): TemplatingEngineRegistry {
  if (!defaultRegistryCache) {
    defaultRegistryCache = createDefaultRegistry();
  }
  return defaultRegistryCache;
}
