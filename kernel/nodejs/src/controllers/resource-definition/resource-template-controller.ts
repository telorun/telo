import type { ControllerInstance, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { isCompiledValue } from "@telorun/sdk";

export function createTemplateController(definition: {
  schema: Record<string, any>;
  resources?: any[];
  invoke?: string | { kind?: string; name: string };
  inputs?: Record<string, any>;
  run?: string;
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

      const persistentManifests: any[] = [];
      let ephemeralTemplate: any = null;

      for (const template of definition.resources ?? []) {
        const expandedName = ctx.moduleContext.expandWith(template.metadata?.name ?? "", {
          self,
        }) as string;
        const isTarget = expandedName === invokeTarget || expandedName === runTarget;
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
                `Template '${resource.metadata.name}': no ephemeral resource for invoke target '${invokeTarget}'`,
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
                throw new Error(`Ephemeral resource '${name}' is not invocable`);
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
              return entry.instance.invoke(invokeInputs);
            });
          },
        }),

        ...(runTarget && {
          run: async () => {
            if (!ephemeralTemplate) {
              throw new Error(
                `Template '${resource.metadata.name}': no ephemeral resource for run target '${runTarget}'`,
              );
            }
            const extraContext = { self };
            const expanded = ctx.moduleContext.expandWith(
              ctx.moduleContext.expandWith(ephemeralTemplate, extraContext),
              extraContext,
            );
            return withEphemeral(expanded, async (name) => {
              const entry = ctx.moduleContext.resourceInstances.get(name);
              if (!entry?.instance?.run) {
                throw new Error(`Ephemeral resource '${name}' is not runnable`);
              }
              return entry.instance.run();
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
