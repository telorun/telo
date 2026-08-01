import type {
  ControllerContext,
  ResourceContext,
  ResourceDefinition as ResourceDefinitionManifest,
  ResourceInstance,
  RuntimeResource,
} from "@telorun/sdk";
import { RuntimeError } from "@telorun/sdk";
import {
  controllerBearingAncestor,
  effectiveAuthorSchema,
  effectiveStatusSchema,
  hasOwnControllerOrTemplate,
  inheritedCapability,
  type DefResolver,
} from "@telorun/analyzer";
import type { ModuleArtifact } from "../../bundle/module-artifact.js";
import { ControllerLoader } from "../../controller-loader.js";
import { formatAjvErrors, validateResourceDefinition } from "../../manifest-schemas.js";
import { createTemplateController } from "./resource-template-controller.js";
import { createInheritedController } from "./resource-inherited-controller.js";

type ResourceDefinitionResource = RuntimeResource & {
  kind: "Telo.Definition";
  metadata: {
    [key: string]: any;
    name: string;
    module?: string;
  };
  schema: Record<string, any>;
  status?: Record<string, any>;
  capability?: string;
  extends?: string;
  base?: Record<string, any>;
  controllers?: Array<string>;
  provide?: unknown;
};

/**
 * ResourceDefinition resource - acts as metadata holder for resource type definitions
 * Validates incoming definitions against schema and maintains definition metadata
 */
class ResourceDefinition implements ResourceInstance {
  readonly kind: "ResourceDefinition" = "ResourceDefinition";

  constructor(readonly resource: ResourceDefinitionResource) {}

  async init(ctx: ResourceContext) {
    const definingCtx = ctx.moduleContext;
    // Resolve an `extends`/kind target (alias or canonical form) to its
    // definition against the DEFINING library's scope — where the `extends`
    // alias was declared.
    const resolveDef: DefResolver = (kind) => {
      let canonical = kind;
      try {
        canonical = definingCtx.resolveKind(kind);
      } catch {
        // ungated / unqualified — fall back to the raw kind below
      }
      return definingCtx.getDefinition?.(canonical) ?? definingCtx.getDefinition?.(kind);
    };

    // Stamp the inheritance-resolved author schema, mirroring the capability
    // stamping below: without `base:`, an `extends` child is authored against
    // merge(parent, own), so a field the parent declares is legal on the child.
    // Every consumer validating a resource against `definition.schema` must see
    // that merged view — otherwise the analyzer accepts an inherited field and
    // the kernel rejects it at create(). Shares `effectiveAuthorSchema` with the
    // analyzer so `telo check` and the runtime cannot drift.
    if (this.resource.extends) {
      if (!resolveDef(this.resource.extends)) {
        // Parent not loaded yet — defer rather than silently merging nothing,
        // which would cache a schema missing every inherited field.
        throw new RuntimeError(
          "ERR_LOCAL_REF_PENDING",
          `Telo.Definition '${this.resource.metadata.name}': 'extends' target '${this.resource.extends}' is not loaded yet.`,
        );
      }
      this.resource.schema = effectiveAuthorSchema(
        this.resource as ResourceDefinitionManifest,
        resolveDef,
      );
      // Same for the observed-state contract: a child without `base:` merges its
      // parent's `status:`, one with `base:` publishes the parent's unchanged.
      // Stamped here, in the DEFINING library's scope, because an `extends` alias
      // belongs to the file that declared it — a consumer that imports only the
      // backend (the sanctioned "one import instead of two") has no alias for the
      // abstract's library and would resolve the parent to nothing. Stamping also
      // makes the folded schema a stable object, so the publication path's AJV
      // validator cache hits instead of recompiling on every snapshot.
      this.resource.status = effectiveStatusSchema(
        this.resource as ResourceDefinitionManifest,
        resolveDef,
      );
    }

    // Inherited-controller delegation: a definition that `extends` a concrete
    // kind, declares no own `controllers:` / template body, inherits the parent
    // controller by delegation and maps its config via `base:`.
    if (this.resource.extends && !hasOwnControllerOrTemplate(this.resource as ResourceDefinitionManifest)) {
      const parentDef = resolveDef(this.resource.extends);
      if (!parentDef) {
        // The parent's Telo.Definition (and thus its controller) isn't loaded
        // yet — defer; the multi-pass init loop retries once its import resolves.
        throw new RuntimeError(
          "ERR_LOCAL_REF_PENDING",
          `Telo.Definition '${this.resource.metadata.name}': 'extends' target '${this.resource.extends}' is not loaded yet.`,
        );
      }
      if (controllerBearingAncestor(this.resource as ResourceDefinitionManifest, resolveDef)) {
        // Capability is inherited and immutable — stamp the resolved capability
        // so every consumer that reads `definition.capability` (compile-CEL eval
        // paths, `capabilityOf`, lifecycle role) sees the effective role without
        // re-walking `extends`.
        if (!this.resource.capability) {
          const inherited = inheritedCapability(this.resource as ResourceDefinitionManifest, resolveDef);
          if (inherited) this.resource.capability = inherited;
        }
        const controllerInstance = createInheritedController(
          this.resource as ResourceDefinitionManifest,
          definingCtx,
          resolveDef,
        );
        ctx.registerDefinition(this.resource);
        await ctx.registerController(
          this.resource.metadata.module,
          this.resource.metadata.name,
          controllerInstance,
        );
        return;
      }
      // Otherwise the chain reaches no controller-bearing concrete ancestor
      // (e.g. it implements a pure abstract) — fall through to the normal
      // template / controller handling below.
    }

    if (!this.resource.controllers?.length) {
      if (this.resource.capability === "Telo.Provider" && this.resource.provide == null) {
        throw new Error(
          `Telo.Definition '${this.resource.metadata.name}': 'capability: Telo.Provider' requires either 'controllers:' (TS-backed) or 'provide:' (template-backed).`,
        );
      }
      // ctx.moduleContext here is the context that DEFINED this kind (the
      // library the Telo.Definition lives in). The template controller spawns
      // its child scope from this context so the template's internal kind
      // aliases / `!ref`s resolve against the defining library's imports — not
      // the consumer module that instantiates the kind.
      const controllerInstance = createTemplateController(this.resource as any, ctx.moduleContext);
      ctx.registerDefinition(this.resource);
      await ctx.registerController(
        this.resource.metadata.module,
        this.resource.metadata.name,
        controllerInstance,
      );
      return;
    }
    const host = kernelContext(ctx);
    const loader = new ControllerLoader({
      entryUrl: ctx.getEntryUrl(),
      installRoot: ctx.getInstallRoot(),
      cacheRoot: host.getCacheRoot?.(),
      log: ctx.log,
    });
    // Eager resolve — verify the controller is hostable now (so a broken
    // `controllers:` candidate fails fast at boot), but defer the expensive
    // import/eval and the controller's `register()` to the kind's first
    // instantiation. Definitions whose kind is never instantiated never import.
    // The artifact of the module that DECLARED this kind — a bundled controller
    // ships in its own module's payload, not the consumer's. It owns the pinned
    // ref and the verified layer index, so the loader picks a candidate and asks
    // it for that selector's directory rather than fetching anything itself.
    const artifact = host.getModuleArtifact?.(this.resource.metadata.source);
    const resolved = await loader.resolve(
      this.resource.controllers,
      this.resource.metadata.source,
      ctx.getControllerPolicy(),
      artifact,
    );
    ctx.registerDefinition(this.resource);

    const moduleName = this.resource.metadata.module;
    const kindName = this.resource.metadata.name;
    // Emitted here (not in the loader) so ControllerLoading / ControllerLoaded /
    // ControllerLoadFailed — and the import duration — surface when the load
    // actually happens (first instantiation), with the resolved PURL + source.
    host.registerLazyController(
      moduleName,
      kindName,
      async () => {
        await ctx.emit("ControllerLoading", { purl: resolved.purl });
        const startedAt = Date.now();
        const instance = await resolved.importInstance().catch(async (err) => {
          await ctx.emit("ControllerLoadFailed", {
            purl: resolved.purl,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        });
        await ctx.registerController(moduleName, kindName, instance);
        await ctx.emit("ControllerLoaded", {
          purl: resolved.purl,
          source: resolved.source,
          durationMs: Date.now() - startedAt,
        });
      },
    );
  }
}

/**
 * What the concrete `ResourceContextImpl` offers this controller **beyond** the
 * public SDK `ResourceContext`.
 *
 * One interface rather than one per need, and narrowed once at the top of
 * `init()` rather than at each call site. Each of these is deliberately off the
 * SDK surface — `getModuleArtifact` hands back a kernel class, `getCacheRoot`
 * names a cache directory, `registerLazyController` is a scheduling detail — but
 * "off the SDK surface" is a property of the members, not a reason to grow a
 * fresh interface and a fresh double cast for every one of them. Module authors
 * reach a module's files through `ctx.resolveModuleFile`, which returns a plain
 * URI, and never see any of this.
 */
interface KernelResourceContext {
  getModuleArtifact?(source: string | undefined): ModuleArtifact | undefined;
  getCacheRoot?(): string | undefined;
  registerLazyController(
    moduleName: string,
    kindName: string,
    load: () => Promise<void>,
  ): void;
}

/** Narrow a `ResourceContext` to the kernel-internal surface its concrete
 *  implementation carries. The cast is the seam; it lives here once. */
function kernelContext(ctx: ResourceContext): KernelResourceContext {
  return ctx as unknown as KernelResourceContext;
}

export function register(ctx: ControllerContext): void {
  // ResourceDefinition is a passive resource - no registration needed
}

export async function create(resource: any, ctx: ResourceContext): Promise<ResourceDefinition> {
  // Validate incoming resource definition against schema
  if (!validateResourceDefinition(resource)) {
    throw new Error(
      `Invalid ResourceDefinition "${resource.metadata.name}": ${formatAjvErrors(validateResourceDefinition.errors)}`,
    );
  }

  // Return a fully-formed ResourceDefinition instance
  const definition = resource as unknown as ResourceDefinitionResource;
  return new ResourceDefinition(definition);
}

