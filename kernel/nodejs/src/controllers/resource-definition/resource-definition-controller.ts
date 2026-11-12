import { declaredContractShape, type ContractShapeHost } from "./declared-contract-shape.js";
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
  hasOwnControllerOrTemplate,
  inheritedCapability,
  nearestName,
  templateTargetProblems,
  valueSchemaFromProblems,
  type DefResolver,
  type NamedShapeLookup,
} from "@telorun/analyzer";
import type { ModuleArtifact } from "../../bundle/module-artifact.js";
import type { NativeFileModule } from "../../module-file-resolution.js";
import type { SiblingLibraryMap } from "../../controller-loaders/sibling-libraries.js";
import type { ArchiveReader } from "../../bundle/source-staging.js";
import type { BundlePreparations } from "../../controller-loaders/bundle-preparations.js";
import { ControllerLoader } from "../../controller-loader.js";
import { refuseInvalidCallable, type DefinitionScopeHost } from "./callable-guard.js";
import { refuseThrowsOutsideCeiling } from "./throws-ceiling-guard.js";
import { refuseInvalidObserves } from "./observes-guard.js";
import { refuseInvalidCompletedWhen } from "./completed-when-guard.js";
import { refuseInvalidCallsCoReferrers } from "./calls-co-referrers-guard.js";
import { createTemplateController, type TemplateHost } from "./resource-template-controller.js";
import type { RefPositionHost } from "../../refuse-computed-ref-slots.js";
import {
  forgetRegisteredDefinition,
  recordRegisteredDefinition,
} from "./registered-definitions.js";

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

  init(ctx: ResourceContext) {
    return ctx.effect(`${this.resource.kind} ${this.resource.metadata.name}`, async () => {
      await this.registerKind(ctx);
      return {
        result: undefined,
        inverse: () =>
          forgetRegisteredDefinition(ctx.moduleContext, this.resource, ctx.getControllerPolicy()),
      };
    });
  }

  private async registerKind(ctx: ResourceContext) {
    // Every hop resolves in the module that declared the definition it was read
    // off: an ancestor's `extends` alias is its own library's, which this module
    // may never have imported. A kind named by no definition (a slot's) resolves
    // in this definition's module.
    const resolveDef: DefResolver = (kind, from) =>
      (
        ctx as unknown as {
          resolveDefinitionIn(kind: string, module: string | undefined): ResourceDefinitionManifest | undefined;
        }
      ).resolveDefinitionIn(kind, (from ?? this.resource).metadata?.module);

    // Parent not loaded yet — defer rather than silently merging nothing, which
    // would cache a schema missing every inherited field. Answered BEFORE the
    // callable guard: a capability reached through `extends` reads as absent
    // until the ancestor is loaded, and a guard that ran then would report a
    // correct callable as having declared a signature on a non-callable kind.
    if (this.resource.extends && !resolveDef(this.resource.extends)) {
      throw new RuntimeError(
        "ERR_LOCAL_REF_PENDING",
        `Telo.Definition '${this.resource.metadata.name}': 'extends' target '${this.resource.extends}' is not loaded yet.`,
      );
    }

    // What a callable kind may declare, judged on what the kind wrote itself. The
    // rules are the analyzer's (`validate-callable-kinds.ts`), read rather than
    // restated, so a dependency's kind — outside the consumer's entry-scoped
    // `telo check` — is refused here for everyone who imports it.
    refuseInvalidCallable(
      this.resource as ResourceDefinitionManifest,
      ctx as unknown as DefinitionScopeHost,
    );
    refuseThrowsOutsideCeiling(this.resource as ResourceDefinitionManifest, resolveDef);

    // The declaration stays as written; what it means along `extends` is the
    // analysis registry's answer, folded through the canonical kind `extends`
    // names in THIS (the declaring) module's scope — an alias belongs to the file
    // that wrote it. The guards below that judge the combination read the same
    // fold, computed here because the kind is not registered yet.
    const ownSchema = this.resource.schema as Record<string, unknown> | undefined;
    const effectiveSchema = this.resource.extends
      ? (effectiveAuthorSchema(this.resource as ResourceDefinitionManifest, resolveDef) as
          | Record<string, unknown>
          | undefined)
      : ownSchema;
    const canonicalExtends = this.resource.extends
      ? registeredKindOf(resolveDef(this.resource.extends))
      : undefined;
    const register = (): void => {
      kernelContext(ctx).registerDefinition(this.resource, canonicalExtends);
    };

    // `telo check`'s twin is `VALUE_SCHEMA_FROM_INVALID`, through the same
    // reader — refused here so a dependency's kind, which the entry-scoped check
    // never reports, fails at registration. Over the effective schema: a location
    // may name a field an ancestor declares.
    const [valueSchemaProblem] = valueSchemaFromProblems(
      this.resource as unknown as Record<string, any>,
      effectiveSchema as Record<string, any> | undefined,
      declaredContractShape(
        ctx as unknown as ContractShapeHost,
        this.resource as unknown as Record<string, any>,
      ),
    );
    if (valueSchemaProblem) {
      throw new RuntimeError(
        "ERR_VALUE_SCHEMA_FROM_INVALID",
        `Telo.Definition ${valueSchemaProblem.message}`,
      );
    }
    refuseInvalidObserves(
      this.resource as ResourceDefinitionManifest,
      ownSchema,
      effectiveSchema,
      resolveDef,
    );
    refuseInvalidCompletedWhen(this.resource, ownSchema, ctx);
    refuseInvalidCallsCoReferrers(
      this.resource as ResourceDefinitionManifest,
      ownSchema,
      (kind, module) =>
        (
          ctx as unknown as {
            resolveDefinitionIn(kind: string, module: string | undefined): ResourceDefinitionManifest | undefined;
          }
        ).resolveDefinitionIn(kind, module),
    );

    // `base:` is the construction mapping of a kind that has NO body of its own:
    // it is evaluated only on the inherited-controller path below, and a
    // `resources:` block (or any dispatch slot / controller) selects the
    // template path, which never reads it. Declaring both used to flip the kind
    // silently — an empty template that dispatched nothing and published
    // nothing, failing in the CONSUMER's resource as `Got: {}`. The analyzer's
    // twin is `BASE_WITH_TEMPLATE_BODY`.
    if (
      (this.resource as { base?: unknown }).base != null &&
      hasOwnControllerOrTemplate(this.resource as ResourceDefinitionManifest)
    ) {
      throw new RuntimeError(
        "ERR_BASE_WITH_TEMPLATE_BODY",
        `Telo.Definition '${this.resource.metadata.name}': 'base:' maps this kind's config onto ` +
          `the inherited controller of '${this.resource.extends ?? "<no extends>"}', so the ` +
          `definition may not also declare 'resources:', 'controllers:' or a dispatch slot ` +
          `('invoke:' / 'run:' / 'targets:' / 'provide:' / 'mount:'). A kind that stands up its own children ` +
          `is a template: drop 'base:' and dispatch to a child with '!ref'.`,
      );
    }

    // Inherited-controller delegation: a definition that `extends` a concrete
    // kind and declares no own `controllers:` / template body is served by the
    // controller of its nearest ancestor that has one, registered under its own
    // kind and loaded on first use. A resource of it is one instance, created by
    // that controller in the context that owns the resource.
    if (this.resource.extends && !hasOwnControllerOrTemplate(this.resource as ResourceDefinitionManifest)) {
      const ancestor = controllerBearingAncestor(this.resource as ResourceDefinitionManifest, resolveDef);
      if (ancestor) {
        register();
        kernelContext(ctx).registerDelegatedController(
          this.resource.metadata.module!,
          this.resource.metadata.name,
          `${ancestor.metadata.module}.${ancestor.metadata.name}`,
        );
        recordRegisteredDefinition(ctx.moduleContext, this.resource, ctx.getControllerPolicy());
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
      // `telo check`'s twin (`validate-template-body`), through the same reader,
      // so a malformed `targets:` in a dependency — which the entry-scoped check
      // never reports — fails at registration rather than at the first run.
      const [targetProblem] = templateTargetProblems(
        this.resource as unknown as Record<string, unknown>,
        inheritedCapability(this.resource as ResourceDefinitionManifest, resolveDef),
        nearestName,
        (kind) => {
          const host = ctx as unknown as {
            resolveDefinitionIn(kind: string, module: string | undefined): ResourceDefinitionManifest | undefined;
            effectiveKindOf(definition: ResourceDefinitionManifest | undefined): { capability?: string } | undefined;
          };
          return host.effectiveKindOf(host.resolveDefinitionIn(kind, this.resource.metadata.module))?.capability;
        },
      );
      if (targetProblem) {
        throw new RuntimeError(
          `ERR_${targetProblem.code}`,
          `Telo.Definition '${this.resource.metadata.name}': ${targetProblem.message}`,
        );
      }
      // Each instance's child scope is spawned from the context that declares
      // its kind as the instance spelled it, so the template's internal kind
      // aliases / `!ref`s resolve against the defining library's imports — and
      // against the IMPORT that instance came through, not whichever import
      // registered the kind.
      const controllerInstance = createTemplateController(
        this.resource as any,
        ctx as unknown as RefPositionHost & TemplateHost,
      );
      register();
      await ctx.registerController(
        this.resource.metadata.module,
        this.resource.metadata.name,
        controllerInstance,
      );
      recordRegisteredDefinition(ctx.moduleContext, this.resource, ctx.getControllerPolicy());
      return;
    }
    const host = kernelContext(ctx);
    const loader = new ControllerLoader({
      entryUrl: ctx.getEntryUrl(),
      installRoot: ctx.getInstallRoot(),
      cacheRoot: host.getCacheRoot?.(),
      bundlePreparations: host.getBundlePreparations?.(),
      archives: host.getArchiveReader?.(),
      log: ctx.log,
      // What resolution reports on its own: the work branches it enters, and
      // the candidates it skipped. Routed through `ctx.emit` so they carry the
      // same `<kind>.` namespace as the load events emitted below — a consumer
      // pairs a wait with its outcome by that namespace.
      emit: (event) => ctx.emit(event.name, event.payload as Record<string, unknown>),
    });
    // The artifact of the module that DECLARED this kind — a bundled controller
    // ships in its own module's payload, not the consumer's. It owns the pinned
    // ref and the verified layer index, so the loader picks a candidate and asks
    // it for that selector's directory rather than fetching anything itself.
    const artifact = host.getModuleArtifact?.(this.resource.metadata.source);
    // The libraries of the module that declared this kind, for the same reason:
    // a bundle's bare `@telorun/kv-store` means whatever THAT module's imports
    // say it means, never the consumer's.
    const libraries = host.getSiblingLibraries?.(this.resource.metadata.source);
    // Its `sources:` block, so a staged prebuilt candidate is checked against
    // its pin before it loads from a source checkout.
    const sources = host.getDeclaringModule?.(this.resource.metadata.source)?.sources;
    register();

    const moduleName = this.resource.metadata.module;
    const kindName = this.resource.metadata.name;
    const controllers = this.resource.controllers;
    const source = this.resource.metadata.source;
    const policy = ctx.getControllerPolicy();
    // Resolution AND import are deferred to the kind's first instantiation,
    // matching the Rust kernel: a definition whose candidate list nothing in
    // this environment can host registers fine and errors — naming the kind —
    // only when a resource of it is declared. That is what lets both kernels
    // load a partially-covered module (e.g. console's stream kinds with no Rust
    // controller) instead of rejecting it over kinds nobody uses.
    // Lifecycle events are emitted here (not in the loader) so ControllerLoading
    // / ControllerLoaded / ControllerLoadFailed — and the import duration —
    // surface when the load actually happens, with the resolved PURL + source.
    host.registerLazyController(
      moduleName,
      kindName,
      async () => {
        const resolved = await loader
          .resolve(controllers, source, policy, artifact, libraries, sources)
          .catch((err) => {
            if (err instanceof RuntimeError) {
              throw new RuntimeError(err.code, `kind '${moduleName}.${kindName}': ${err.message}`);
            }
            throw err;
          });
        await ctx.emit("ControllerLoading", { purl: resolved.purl, source: resolved.source });
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
          durationMs: resolved.waitedMs(),
        });
      },
    );
    recordRegisteredDefinition(ctx.moduleContext, this.resource, policy);
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
  getSiblingLibraries?(source: string | undefined): SiblingLibraryMap | undefined;
  getDeclaringModule?(source: string | undefined): NativeFileModule | undefined;
  getCacheRoot?(): string | undefined;
  getBundlePreparations?(): BundlePreparations;
  getArchiveReader?(): ArchiveReader;
  registerLazyController(
    moduleName: string,
    kindName: string,
    load: () => Promise<void>,
  ): void;
  registerDelegatedController(moduleName: string, kindName: string, ancestorKind: string): void;
  registerDefinition(definition: unknown, canonicalExtends?: string): void;
}

/** The registry key a resolved definition is registered under. */
export function registeredKindOf(definition: ResourceDefinitionManifest | undefined): string | undefined {
  if (!definition) return undefined;
  const { module, name } = definition.metadata;
  return module ? `${module}.${name}` : name;
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
  // Validated against the built-in `Telo.Definition` entry where every resource
  // is created — the capability roster first, then the schema.
  const definition = resource as unknown as ResourceDefinitionResource;
  return new ResourceDefinition(definition);
}

