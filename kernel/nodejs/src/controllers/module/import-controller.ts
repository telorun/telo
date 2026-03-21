import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { EvaluationContext, RuntimeError } from "@telorun/sdk";
import { DiagnosticSeverity, StaticAnalyzer } from "@telorun/analyzer";
import { Loader } from "../../loader.js";

export async function create(resource: any, ctx: ResourceContext): Promise<ResourceInstance> {
  const alias = resource.metadata.name as string;
  const loader = new Loader();

  const moduleSource: string = resource.module ?? resource.source;

  // Validate the imported module and all its transitive imports before loading for runtime.
  // loadManifests() follows Kernel.Import chains so definitions from sub-imports are present,
  // preventing false UNDEFINED_KIND errors for kinds that come from the module's own imports.
  const resolvedUrl = new URL(moduleSource, ctx.moduleContext.source).toString();
  const analysisManifests = await loader.loadManifests(resolvedUrl);
  const diagnostics = new StaticAnalyzer().analyze(analysisManifests);
  const errors = diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error);
  if (errors.length > 0) {
    throw new RuntimeError(
      "ERR_MANIFEST_VALIDATION_FAILED",
      errors.map((d) => d.message).join("\n"),
    );
  }

  // Load target module manifests for runtime. Inject variables/secrets as compile context so
  // that ${{ variables.x }} / ${{ secrets.y }} templates in the child module resolve correctly.
  // No env — child modules are isolated from host environment.
  const manifests = await loader.loadManifest(moduleSource, ctx.moduleContext.source, {
    // Potentially not needed
    variables: (resource.variables as Record<string, unknown>) ?? {},
    secrets: (resource.secrets as Record<string, unknown>) ?? {},
  });
  // Find the kind: Module manifest to learn the target module name and contract.
  const moduleManifest = manifests.find((m: any) => m.kind === "Kernel.Module");
  if (!moduleManifest) {
    throw new Error(`No kind: Module manifest found in source "${resource.source as string}"`);
  }
  const targetModule: string = moduleManifest.metadata.name;

  // Validate required inputs before injecting.
  validateRequiredInputs(moduleManifest.variables ?? {}, resource.variables ?? {}, "variables");
  validateRequiredInputs(moduleManifest.secrets ?? {}, resource.secrets ?? {}, "secrets");

  // Create child context with the imported variables/secrets baked in, so that
  // ${{ variables.x }} / ${{ secrets.y }} templates resolve correctly at runtime.
  const child = ctx.moduleContext.spawnChild(
    new EvaluationContext(
      ctx.moduleContext.source,
      {
        variables: (resource.variables as Record<string, unknown>) ?? {},
        secrets: (resource.secrets as Record<string, unknown>) ?? {},
        resources: {},
      },
      ctx.moduleContext.createInstance,
      ctx.moduleContext.secretValues,
      ctx.moduleContext.emit,
    ),
  );

  for (const manifest of manifests) {
    child.registerManifest(manifest);
  }

  // Link the target module context as a child of the declaring module context in
  // the lifecycle tree. This enables cascading teardown (parent → child order)
  // and makes the import hierarchy visible at runtime.
  // const declaringCtx: ModuleContext = ctx.getModuleContext(declaringModule);
  // const targetCtx: ModuleContext = (ctx as any).getModuleContext(targetModule);
  // if (!targetCtx.parent) {
  //   declaringCtx.spawnChild(targetCtx);
  // }

  // Try to evaluate the target module's exports.
  // Throws if resources.X is not yet populated — the kernel retry loop catches this and retries.
  // const evaluatedExports: any = child.expand(moduleManifest.exports ?? {});

  const exportedKinds: string[] = moduleManifest.exports?.kinds ?? [];
  ctx.registerModuleImport(alias, targetModule, exportedKinds);
  // Return a ResourceInstance whose snapshot() surfaces the exported values.
  // The kernel's generic setResource() call stores them under resources.<alias>
  // in the declaring module's evaluation context — no separate imports namespace needed.
  return {
    snapshot: () => ({
      variables: ctx.expandValue(resource.variables, {}) ?? {},
      secrets: ctx.expandValue(resource.secrets, {}) ?? {},
    }),
    run: async () => {
      // Proxy run to target module
      for (const target of (moduleManifest.targets as string[]) ?? []) {
        await child.run(target);
      }
    },
    invoke: async () => {
      // Proxy run to target module
      // for (const target of (moduleManifest.targets as string[]) ?? []) {
      //   child.invoke(target);
      // }
      console.log("invoking");
    },
    init: async () => {
      await child.initializeResources();
    },
    teardown: async () => {
      await child.teardownResources();
    },
  };
}

function validateRequiredInputs(
  schemaDefs: Record<string, any>,
  provided: Record<string, unknown>,
  kind: "variables" | "secrets",
): void {
  for (const [key, def] of Object.entries(schemaDefs)) {
    const isRequired = typeof def === "object" && def !== null && !("default" in def);
    if (isRequired && !(key in provided)) {
      throw new Error(`Required ${kind} input "${key}" not provided for module import`);
    }
  }
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
