import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import { compile } from "@telorun/yaml-cel-templating";

const TEMPLATE_DIRECTIVES = {
  for: "for",
  do: "do",
  if: "if",
  then: "then",
  else: "else",
  let: "let",
  eval: "eval",
  schema: "schema",
  assert: "assert",
  msg: "msg",
  include: "include",
  with: "with",
  key: "key",
  value: "value",
};

type TemplateDefinitionResource = RuntimeResource & {
  schema?: Record<string, any>;
  templatedResources: any[];
};

export async function create(
  resource: TemplateDefinitionResource,
  ctx: ResourceContext,
): Promise<ResourceInstance> {
  return {
    init: async () => {
      const templateName = resource.metadata.name;
      const moduleName = resource.metadata.module;

      // Register a new resource definition for this template
      ctx.registerDefinition({
        kind: "Kernel.Definition",
        metadata: {
          name: templateName,
          module: moduleName,
        },
        schema: resource.schema || { type: "object" },
      });

      // Register a controller that expands template instances
      await ctx.registerController(moduleName, templateName, {
        schema: normalizeSchema(resource.schema),
        create: (instance: RuntimeResource, instanceCtx: ResourceContext): ResourceInstance => {
          // Extract parameters (everything except kind/metadata)
          const parameters: Record<string, any> = {};
          for (const [key, value] of Object.entries(instance)) {
            if (key !== "kind" && key !== "metadata") {
              parameters[key] = value;
            }
          }

          // Expand template using yaml-cel-templating with runtime directives
          const defaults = extractDefaults(resource.schema);
          const context = { ...defaults, ...parameters };
          const expanded = compile(resource.templatedResources, {
            context,
            directives: TEMPLATE_DIRECTIVES,
            evaluateStringExpressions: true,
            lenientExpressions: true,
          });

          // Register expanded resources, ensuring metadata is present
          const resources = Array.isArray(expanded) ? expanded : [expanded];
          const instanceModule = instance.metadata.module;
          return {
            init: async () => {
              for (const res of resources) {
                if (!res.metadata) {
                  res.metadata = { name: res.kind, module: instanceModule };
                } else if (!res.metadata.module) {
                  res.metadata.module = instanceModule;
                }
                instanceCtx.registerManifest(res);
              }
            },
          };
        },
      });
    },
  };
}

function normalizeSchema(schema: Record<string, any> | undefined): Record<string, any> {
  if (!schema) return { type: "object" };
  if (schema.type) return schema;
  // Shorthand: { port: { type: number }, ... } → { type: "object", properties: ... }
  return { type: "object", properties: schema };
}

function extractDefaults(schema: Record<string, any> | undefined): Record<string, any> {
  const context: Record<string, any> = {};
  const normalized = normalizeSchema(schema);
  const properties = normalized.properties;
  if (!properties || typeof properties !== "object") return context;
  for (const [key, prop] of Object.entries(properties)) {
    if (prop && typeof prop === "object" && "default" in (prop as any)) {
      context[key] = (prop as any).default;
    }
  }
  return context;
}
