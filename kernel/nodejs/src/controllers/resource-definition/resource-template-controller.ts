import type { ControllerInstance, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { isCompiledValue } from "@telorun/sdk";

/** Reports the resources: entries available to dispatch against, by expanded
 *  name and kind. Used in error messages to guide the developer back to the
 *  template's `resources:` array when a dispatch target doesn't match. */
function describeAvailableTargets(
  ctx: ResourceContext,
  resources: any[] | undefined,
  self: Record<string, unknown>,
): string {
  if (!resources || resources.length === 0) return "<none>";
  return resources
    .map((r) => {
      const expanded = ctx.moduleContext.expandWith(r?.metadata?.name ?? "", { self }) as string;
      const kind = typeof r?.kind === "string" ? r.kind : "<unknown-kind>";
      return `'${expanded || "<unnamed>"}' (${kind})`;
    })
    .join(", ");
}

export function createTemplateController(definition: {
  schema: Record<string, any>;
  resources?: any[];
  invoke?: string | { kind?: string; name: string };
  inputs?: Record<string, any>;
  run?: string;
  provide?: { kind: string; name: string };
  result?: Record<string, any>;
}): ControllerInstance {
  return {
    schema: definition.schema ?? { type: "object", additionalProperties: true },

    create: async (resource: any, ctx: ResourceContext): Promise<ResourceInstance> => {
      const self = { ...resource, name: resource.metadata.name };

      // `invoke` describes the dispatch target: a string name template (legacy
      // shorthand) or an object `{ kind?, name }` for explicit kind-typed
      // dispatch. `inputs:` lives as a sibling on the definition (same shape
      // as Run.Sequence steps) — the values passed to the dispatch target's
      // invoke() after CEL expansion.
      const objectInvoke =
        definition.invoke !== null &&
        typeof definition.invoke === "object" &&
        !isCompiledValue(definition.invoke)
          ? (definition.invoke as { kind?: string; name: string })
          : null;
      const invokeNameTemplate = objectInvoke ? objectInvoke.name : (definition.invoke ?? null);
      const invokeTarget = invokeNameTemplate
        ? (ctx.moduleContext.expandWith(invokeNameTemplate, { self }) as string)
        : null;
      const runTarget = definition.run
        ? (ctx.moduleContext.expandWith(definition.run, { self }) as string)
        : null;
      const provideTarget = definition.provide?.name
        ? (ctx.moduleContext.expandWith(definition.provide.name, { self }) as string)
        : null;

      const persistentManifests: any[] = [];
      let ephemeralTemplate: any = null;

      for (const template of definition.resources ?? []) {
        const expandedName = ctx.moduleContext.expandWith(template.metadata?.name ?? "", {
          self,
        }) as string;
        const isTarget =
          expandedName === invokeTarget ||
          expandedName === runTarget ||
          expandedName === provideTarget;
        if (isTarget) {
          ephemeralTemplate = template;
        } else {
          persistentManifests.push(ctx.moduleContext.expandWith(template, { self }));
        }
      }

      const childContext = ctx.spawnChildContext();

      // Registers an ephemeral manifest on ctx.moduleContext so it shares the same
      // resource scope (and can access connections, etc. via getInstance).
      // Tears down and removes the resource after fn() completes.
      const withEphemeral = async (expandedManifest: any, fn: (name: string) => Promise<any>) => {
        const uniqueName = `${expandedManifest.metadata?.name ?? "eph"}__${Math.random().toString(16).slice(2, 8)}`;
        const manifest = {
          ...expandedManifest,
          metadata: {
            ...expandedManifest.metadata,
            name: uniqueName,
            module: resource.metadata.module,
          },
        };
        ctx.moduleContext.registerManifest(manifest);
        await ctx.moduleContext.initializeResources();
        const entry = ctx.moduleContext.resourceInstances.get(uniqueName);
        try {
          return await fn(uniqueName);
        } finally {
          if (entry?.instance?.teardown) await entry.instance.teardown();
          ctx.moduleContext.resourceInstances.delete(uniqueName);
        }
      };

      return {
        init: async () => {
          for (const m of persistentManifests) childContext.registerManifest(m);
          await childContext.initializeResources();
        },

        ...(invokeTarget && {
          invoke: async (inputs: any) => {
            if (!ephemeralTemplate) {
              throw new Error(
                `Template '${resource.metadata.name}': 'invoke:' targets '${invokeTarget}' ` +
                  `but no entry in 'resources:' has that metadata.name. Available: ${describeAvailableTargets(ctx, definition.resources, self)}.`,
              );
            }
            const extraContext = { self, inputs };
            const expanded = ctx.moduleContext.expandWith(
              ctx.moduleContext.expandWith(ephemeralTemplate, extraContext),
              extraContext,
            ) as any;
            return withEphemeral(expanded, async (name) => {
              const entry = ctx.moduleContext.resourceInstances.get(name);
              if (!entry?.instance?.invoke) {
                const targetKind = (entry?.resource?.kind ?? expanded?.kind ?? "<unknown-kind>") as string;
                const targetDef = ctx.moduleContext.getDefinition?.(targetKind);
                const actualCap = typeof targetDef?.capability === "string" ? targetDef.capability : "<unknown>";
                throw new Error(
                  `Template '${resource.metadata.name}': 'invoke:' target '${targetKind}/${invokeTarget}' ` +
                    `has capability '${actualCap}', not Telo.Invocable. Update 'invoke:' to a Telo.Invocable kind, or change the target's kind in 'resources:'.`,
                );
              }
              // Top-level `inputs:` (sibling of `invoke:`) carries the values passed
              // to the dispatch target's invoke(). When absent, fall back to the
              // expanded resource entry's own `inputs` field (legacy string-form
              // shape where the inputs live on the resource declaration), then
              // finally to the caller's `inputs` arg.
              const invokeInputs = definition.inputs != null
                ? ctx.moduleContext.expandWith(
                    ctx.moduleContext.expandWith(definition.inputs, extraContext),
                    extraContext,
                  )
                : expanded.inputs ?? inputs;
              const raw = await entry.instance.invoke(invokeInputs);
              if (definition.result == null) return raw;
              const resultContext = { self, result: raw };
              return ctx.moduleContext.expandWith(
                ctx.moduleContext.expandWith(definition.result, resultContext),
                resultContext,
              );
            });
          },
        }),

        ...(runTarget && {
          run: async () => {
            if (!ephemeralTemplate) {
              throw new Error(
                `Template '${resource.metadata.name}': 'run:' targets '${runTarget}' ` +
                  `but no entry in 'resources:' has that metadata.name. Available: ${describeAvailableTargets(ctx, definition.resources, self)}.`,
              );
            }
            const extraContext = { self };
            const expanded = ctx.moduleContext.expandWith(
              ctx.moduleContext.expandWith(ephemeralTemplate, extraContext),
              extraContext,
            ) as any;
            return withEphemeral(expanded, async (name) => {
              const entry = ctx.moduleContext.resourceInstances.get(name);
              if (!entry?.instance?.run) {
                const targetKind = (entry?.resource?.kind ?? expanded?.kind ?? "<unknown-kind>") as string;
                const targetDef = ctx.moduleContext.getDefinition?.(targetKind);
                const actualCap = typeof targetDef?.capability === "string" ? targetDef.capability : "<unknown>";
                throw new Error(
                  `Template '${resource.metadata.name}': 'run:' target '${targetKind}/${runTarget}' ` +
                    `has capability '${actualCap}', not Telo.Runnable. Update 'run:' to a Telo.Runnable kind, or change the target's kind in 'resources:'.`,
                );
              }
              return entry.instance.run();
            });
          },
        }),

        ...(provideTarget && {
          provide: async () => {
            if (!ephemeralTemplate) {
              throw new Error(
                `Template '${resource.metadata.name}': 'provide:' targets '${provideTarget}' ` +
                  `but no entry in 'resources:' has that metadata.name. Available: ${describeAvailableTargets(ctx, definition.resources, self)}.`,
              );
            }
            const extraContext = { self };
            const expanded = ctx.moduleContext.expandWith(
              ctx.moduleContext.expandWith(ephemeralTemplate, extraContext),
              extraContext,
            ) as any;
            return withEphemeral(expanded, async (name) => {
              const entry = ctx.moduleContext.resourceInstances.get(name);
              if (!entry?.instance?.invoke) {
                const targetKind = (entry?.resource?.kind ?? expanded?.kind ?? "<unknown-kind>") as string;
                const targetDef = ctx.moduleContext.getDefinition?.(targetKind);
                const actualCap = typeof targetDef?.capability === "string" ? targetDef.capability : "<unknown>";
                throw new Error(
                  `Template '${resource.metadata.name}': 'provide:' target '${targetKind}/${provideTarget}' ` +
                    `has capability '${actualCap}', not Telo.Invocable. Update 'provide:' to a Telo.Invocable kind, or change the target's kind in 'resources:'.`,
                );
              }
              const provideInputs: any =
                definition.inputs != null
                  ? ctx.moduleContext.expandWith(
                      ctx.moduleContext.expandWith(definition.inputs, extraContext),
                      extraContext,
                    )
                  : {};
              const raw = await entry.instance.invoke(provideInputs);
              if (definition.result == null) return raw;
              const resultContext = { self, result: raw };
              return ctx.moduleContext.expandWith(
                ctx.moduleContext.expandWith(definition.result, resultContext),
                resultContext,
              );
            });
          },
        }),

        teardown: async () => {
          await childContext.teardownResources();
        },
      };
    },
  };
}
