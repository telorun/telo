import { DiagnosticSeverity, StaticAnalyzer } from "@telorun/analyzer";
import type { ResourceInstance } from "@telorun/sdk";
import { RuntimeError } from "@telorun/sdk";
import type { BuiltinControllerContext } from "../../internal-context.js";
import { ModuleContext } from "../../module-context.js";
import { isDefaultPolicy, normalizeRuntime } from "../../runtime-registry.js";

export async function create(
  resource: any,
  ctx: BuiltinControllerContext,
): Promise<ResourceInstance> {
  const alias = resource.metadata.name as string;

  const moduleSource: string = resource.module ?? resource.source;

  // Resolve relative source paths against the manifest's OWN file URL (stamped onto
  // `metadata.source` by the loader), not the parent module context's source. When a
  // Telo.Library imports another library via a relative path, that path is written
  // relative to the declaring library's file — not relative to whatever root manifest
  // happens to have imported the chain. Falling back to ctx.moduleContext.source for
  // manifests that somehow lack a stamped source keeps the old behaviour for edge cases.
  const base = (resource.metadata?.source as string | undefined) ?? ctx.moduleContext.source;

  // Validate the imported module and all its transitive imports before loading for runtime.
  // loadManifests() follows Telo.Import chains so definitions from sub-imports are present,
  // preventing false UNDEFINED_KIND errors for kinds that come from the module's own imports.
  //
  // Route URL resolution through the kernel/loader's own helper rather than
  // a hand-rolled `new URL(...).toString()`. For LocalFileSource the
  // outputs match; for any custom `ManifestSource` with a non-trivial
  // `resolveRelative`, only this path produces the canonical URL the
  // loader keyed its caches under — without which fast paths like
  // `isImportValidatedAtLoad` silently miss.
  const resolvedUrl = ctx.resolveImportUrl(base, moduleSource);

  // Fast path: when the kernel's load-time `analyzeErrors` already covered
  // this import's subtree (the common case — every Telo.Import declared in
  // the entry graph is walked by `loadGraph` and validated by
  // `kernel.load`), skip the redundant per-import StaticAnalyzer pass.
  // Falls through to the full analysis for URLs that arrived
  // programmatically after `load()` (e.g. dynamically constructed imports
  // in tests). Two Telo.Imports with the same source but distinct
  // metadata.name would each re-run analysis here — a memoisation hook
  // can be reintroduced if that turns into a measurable cost.
  if (!ctx.isImportValidatedAtLoad(resolvedUrl)) {
    const analysisManifests = await ctx.loadManifests(resolvedUrl);
    const diagnostics = new StaticAnalyzer().analyze(analysisManifests);
    const errors = diagnostics
      .filter((d) => d.severity === DiagnosticSeverity.Error)
      .map((d) => d.message);
    if (errors.length > 0) {
      throw new RuntimeError(
        "ERR_MANIFEST_VALIDATION_FAILED",
        errors.join("\n"),
      );
    }
  }

  // Load target module manifests for runtime. Inject variables/secrets as compile context so
  // that ${{ variables.x }} / ${{ secrets.y }} templates in the child module resolve correctly.
  // No env — child modules are isolated from host environment.
  // `desugarImports` so a child library that itself uses inline `imports:` has
  // those expanded into Telo.Import manifests and registered in its child
  // context — without it, a transitively-imported library's inline imports
  // would load but never execute (the execute-gap, one level down).
  const manifests = await ctx.loadModule(resolvedUrl, {
    compile: true,
    desugarImports: true,
  });
  // Import targets must be Telo.Library — Applications are run directly, not imported.
  const moduleManifest = manifests.find((m: any) => m.kind === "Telo.Library");
  if (!moduleManifest) {
    const applicationManifest = manifests.find((m: any) => m.kind === "Telo.Application");
    if (applicationManifest) {
      throw new RuntimeError(
        "ERR_MANIFEST_VALIDATION_FAILED",
        `Telo.Import target '${resource.source as string}' is a Telo.Application. Only Telo.Library modules may be imported. Applications are run directly, not imported.`,
      );
    }
    throw new Error(`No Telo.Library manifest found in source "${resource.source as string}"`);
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

  // Stamp the resolved controller policy on the child only when the import
  // specifies a `runtime:` field that resolves to something other than the
  // canonical default. Omitted, `auto`, and any list that normalizes to the
  // default shape (e.g. `[nodejs, any]` on the Node.js kernel) all leave the
  // child policy unstamped — they are equivalent forms of "no preference"
  // and stamping would make them observably distinct from the omitted form
  // for no behavioral gain.
  if (resource.runtime !== undefined) {
    const policy = normalizeRuntime(resource.runtime as string | string[]);
    if (!isDefaultPolicy(policy)) {
      (child as ModuleContext).setControllerPolicy(policy);
    }
  }

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
    runtime: {
      oneOf: [
        { type: "string" },
        { type: "array", items: { type: "string" } },
      ],
    },
  },
  required: ["metadata", "source"],
  additionalProperties: false,
};
