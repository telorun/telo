import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { ModuleContext } from "../../evaluation-context.js";
import { Loader } from "../../loader.js";

export async function create(
  resource: any,
  ctx: ResourceContext,
): Promise<ResourceInstance> {
  const alias = resource.metadata.name as string;
  const declaringModule: string = resource.metadata.module ?? "default";
  const loader = new Loader();

  // Load target module manifests. No env — child modules are isolated from host environment.
  const manifests = await loader.loadManifest(
    resource.source as string,
    resource.metadata.source as string,
    {},
  );

  // Find the kind: Module manifest to learn the target module name and contract.
  const moduleManifest = manifests.find((m: any) => m.kind === "Kernel.Module");
  if (!moduleManifest) {
    throw new Error(
      `No kind: Module manifest found in source "${resource.source as string}"`,
    );
  }
  const targetModule: string = moduleManifest.metadata.name;

  // Register all manifests (idempotent — kernel deduplicates by resource key).
  for (const manifest of manifests) {
    ctx.registerManifest(manifest);
  }

  // Validate required inputs before injecting.
  validateRequiredInputs(moduleManifest.variables ?? {}, resource.variables ?? {}, "variables");
  validateRequiredInputs(moduleManifest.secrets ?? {}, resource.secrets ?? {}, "secrets");

  // Inject variable/secret VALUES into the target module context.
  // Idempotent: setVariablesAndSecrets overwrites with the same values each retry.
  (ctx as any).registerModuleContext(
    targetModule,
    resource.variables ?? {},
    resource.secrets ?? {},
  );

  // Try to evaluate the target module's exports.
  // Throws if resources.X is not yet populated — the kernel retry loop catches this and retries.
  const moduleCtx: ModuleContext = (ctx as any).getModuleContext(targetModule);
  const evaluatedExports = evaluateExports(moduleManifest.exports ?? {}, moduleCtx);

  // Register evaluated exports as imports.<alias> in the declaring module context.
  (ctx as any).registerModuleImport(declaringModule, alias, evaluatedExports);

  return {};
}

function validateRequiredInputs(
  schemaDefs: Record<string, any>,
  provided: Record<string, unknown>,
  kind: "variables" | "secrets",
): void {
  for (const [key, def] of Object.entries(schemaDefs)) {
    const isRequired = typeof def === "object" && def !== null && !("default" in def);
    if (isRequired && !(key in provided)) {
      throw new Error(
        `Required ${kind} input "${key}" not provided for module import`,
      );
    }
  }
}

function evaluateExports(
  exportDefs: Record<string, string>,
  moduleCtx: ModuleContext,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [exportKey, expression] of Object.entries(exportDefs)) {
    result[exportKey] = moduleCtx.expand(expression);
  }
  return result;
}

export const schema = {
  type: "object",
  properties: {
    kind: { type: "string" },
    metadata: {
      type: "object",
      properties: {
        name: { type: "string" },
        source: { type: "string" },
        module: { type: "string" },
      },
      required: ["name"],
      additionalProperties: true,
    },
    source: { type: "string" },
    variables: { type: "object" },
    secrets: { type: "object" },
  },
  required: ["metadata", "source"],
  additionalProperties: false,
};
