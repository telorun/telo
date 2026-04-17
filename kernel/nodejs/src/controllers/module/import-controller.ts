import { DiagnosticSeverity, Loader, StaticAnalyzer } from "@telorun/analyzer";
import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { RuntimeError } from "@telorun/sdk";
import { ModuleContext } from "../../module-context.js";
import { LocalFileAdapter } from "../../manifest-adapters/local-file-adapter.js";

const importAnalysisCache = new Map<
  string,
  { signature: string; errors: string[] }
>();

export async function create(resource: any, ctx: ResourceContext): Promise<ResourceInstance> {
  const alias = resource.metadata.name as string;
  const loader = new Loader([new LocalFileAdapter()]);

  const moduleSource: string = resource.module ?? resource.source;

  // Validate the imported module and all its transitive imports before loading for runtime.
  // loadManifests() follows Kernel.Import chains so definitions from sub-imports are present,
  // preventing false UNDEFINED_KIND errors for kinds that come from the module's own imports.
  const resolvedUrl = new URL(moduleSource, ctx.moduleContext.source).toString();
  const analysisManifests = await loader.loadManifests(resolvedUrl);
  const signature = JSON.stringify(analysisManifests);
  const cached = importAnalysisCache.get(resolvedUrl);
  let errors: string[];

  if (cached && cached.signature === signature) {
    errors = cached.errors;
  } else {
    const diagnostics = new StaticAnalyzer().analyze(analysisManifests);
    errors = diagnostics
      .filter((d) => d.severity === DiagnosticSeverity.Error)
      .map((d) => d.message);
    importAnalysisCache.set(resolvedUrl, { signature, errors });
  }

  if (errors.length > 0) {
    throw new RuntimeError(
      "ERR_MANIFEST_VALIDATION_FAILED",
      errors.join("\n"),
    );
  }

  // Load target module manifests for runtime. Inject variables/secrets as compile context so
  // that ${{ variables.x }} / ${{ secrets.y }} templates in the child module resolve correctly.
  // No env — child modules are isolated from host environment.
  const manifests = await loader.loadModule(
    new URL(moduleSource, ctx.moduleContext.source).toString(),
    {
      compile: true,
    },
  );
  // Import targets must be Kernel.Library — Applications are run directly, not imported.
  const moduleManifest = manifests.find((m: any) => m.kind === "Kernel.Library");
  if (!moduleManifest) {
    const applicationManifest = manifests.find((m: any) => m.kind === "Kernel.Application");
    if (applicationManifest) {
      throw new RuntimeError(
        "ERR_MANIFEST_VALIDATION_FAILED",
        `Kernel.Import target '${resource.source as string}' is a Kernel.Application. Only Kernel.Library modules may be imported. Applications are run directly, not imported.`,
      );
    }
    throw new Error(`No Kernel.Library manifest found in source "${resource.source as string}"`);
  }
  const targetModule: string = moduleManifest.metadata.name;

  // Validate required inputs before injecting.
  validateRequiredInputs(moduleManifest.variables ?? {}, resource.variables ?? {}, "variables");
  validateRequiredInputs(moduleManifest.secrets ?? {}, resource.secrets ?? {}, "secrets");

  // Create child context with the imported variables/secrets baked in, so that
  // ${{ variables.x }} / ${{ secrets.y }} templates resolve correctly at runtime.
  const child = ctx.moduleContext.spawnChild(
    new ModuleContext(
      ctx.moduleContext.source,
      (resource.variables as Record<string, unknown>) ?? {},
      (resource.secrets as Record<string, unknown>) ?? {},
      {},
      [],
      ctx.moduleContext.createInstance,
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
