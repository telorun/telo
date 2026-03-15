import type { CapabilityDefinition } from "./types.js";
import type { ResourceManifest } from "./resource-manifest.js";

/**
 * Factory that wires the declarative `expand` config on a CapabilityDefinition
 * into the `onManifest` and `onInvoke` lifecycle hooks. The kernel only ever
 * calls these hooks — it has no knowledge of the `expand` config.
 */
export function createCapability(def: CapabilityDefinition): CapabilityDefinition {
  const compile = def.expand?.compile ?? [];
  const runtime = def.expand?.runtime ?? [];

  return {
    ...def,
    onManifest: compile.length
      ? (manifest, ctx) =>
          ctx.expandPaths(
            manifest as Record<string, unknown>,
            compile,
            runtime,
          ) as ResourceManifest
      : def.onManifest,
    onInvoke: runtime.length
      ? async (instance, inputs, ctx) => {
          const expanded = ctx.moduleContext.expandPaths(
            inputs as Record<string, unknown>,
            runtime,
          );
          return instance.invoke!(expanded);
        }
      : def.onInvoke,
  };
}
