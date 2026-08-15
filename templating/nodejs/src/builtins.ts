import { celEngine } from "./engines/cel.js";
import { includeBytesEngine, includeTextEngine } from "./engines/include.js";
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
  includeBytesEngine,
  includeTextEngine,
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

/**
 * The type a tag always produces, or undefined when its produced type is a
 * function of the slot rather than of the tag (`!cel`, `!ref`).
 *
 * The single reader of `TemplatingEngine.producedType`, so a consumer asks the
 * registry what a tag produces instead of recognising tag names — the same seam
 * `fileClaims` opened for payload membership. Reads the default registry
 * because a produced type is a property of the engine, not of a host's
 * configuration, and every host ships the same built-in set.
 */
export function producedTypeOf(engineName: string): Record<string, unknown> | undefined {
  return defaultRegistry().get(engineName)?.producedType?.();
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
