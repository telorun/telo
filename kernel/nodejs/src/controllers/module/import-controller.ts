import {
  AnalysisRegistry,
  DiagnosticSeverity,
  authoredModuleMetadata,
  foldIntegrity,
  isInjectedDeclaration,
  parseExportEntry,
  readLibraryLifecycle,
  readResourceInputs,
  readSuppliedResources,
  StaticAnalyzer,
} from "@telorun/analyzer";
import type { ParsedExportEntry } from "@telorun/analyzer";
import type { ResourceInstance, ResourceManifest } from "@telorun/sdk";
import { RuntimeError, TEARDOWN_LAST } from "@telorun/sdk";
import { publishedPropsOf } from "../../evaluation-context.js";
import type { BuiltinControllerContext } from "../../internal-context.js";
import { buildScopeConfig, type LoggingManifestBlock } from "../../logging/kernel-logging.js";
import { ModuleContext } from "../../module-context.js";
import { isDefaultPolicy, normalizeRuntime } from "../../runtime-registry.js";
import {
  assertNoSharedOverride,
  assertSharedInputsAgree,
  rootContextOf,
  sharedLibraries,
  type SharedLibrary,
} from "./shared-libraries.js";

export async function create(
  resource: any,
  ctx: BuiltinControllerContext,
): Promise<ResourceInstance> {
  const alias = resource.metadata.name as string;

  // Resolve the instances this import hands DOWN to the target library's
  // declared `resources:` inputs BEFORE any loading happens. A borrowed
  // instance that is registered but not yet initialized is a DEFERRAL, not a
  // failure — raised as `ERR_LOCAL_REF_PENDING` so the multi-pass loop retries
  // and the init-failure classifier reads it as derived rather than as a root
  // cause. Resolving first is what keeps a deferral cheap: a fetch, a parse and
  // a full analysis pass would otherwise be redone on every pass.
  const borrowed = resolveBorrowedResources(resource, ctx);

  const rawSource: string = resource.module ?? resource.source;
  // A directly-authored Telo.Import may carry integrity as a sibling field;
  // fold it into the ref as a `#sha256-...` fragment (the desugared inline
  // imports already inline it) so the source chain verifies the fetched bytes.
  const moduleSource: string = foldIntegrity(rawSource, resource.integrity);

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

  // A `lifecycle: shared` library is instantiated ONCE per application. Only a
  // shared library is ever registered, so the registry HIT is itself the answer
  // to "is this one shared" — which is what makes a second import of it cost no
  // fetch, no parse and no analysis pass at all.
  const registry = sharedLibraries(ctx.moduleContext);
  const alreadyShared = registry.get(resolvedUrl);
  if (alreadyShared) {
    return borrowSharedLibrary(alreadyShared, alias, resource, borrowed, ctx);
  }

  // The analysis-flattened graph (follows Telo.Import chains, includes forwarded
  // sub-import exports) serves two purposes here: validating the imported subtree,
  // and populating a CHILD-SCOPED analysis registry whose top-level alias scope is
  // the imported library's own. That child scope is required to normalize the
  // library's `!ref` sentinels (resolve them to `{kind, name}`) before its
  // resources are registered below — the same step the root load performs via
  // `analyzer.normalize`. Without it a `!ref` inside the library reaches its
  // controller as a raw sentinel and Phase-5 injection (which only recognizes
  // `{kind, name}`) silently skips it.
  const analysisManifests = await ctx.loadManifests(resolvedUrl);
  const analyzer = new StaticAnalyzer();
  const childRegistry = new AnalysisRegistry();

  // Fast path: when the kernel's load-time `analyzeErrors` already covered this
  // import's subtree (the common case — every Telo.Import declared in the entry
  // graph is walked by `loadGraph` and validated by `kernel.load`), skip the
  // per-resource diagnostic passes. Registration of identities / aliases /
  // definitions still runs (it precedes the skipValidation early-return), so the
  // child registry is populated for normalization either way. The full analysis
  // runs for URLs that arrived programmatically after `load()` (e.g. dynamically
  // constructed imports in tests).
  const validatedAtLoad = ctx.isImportValidatedAtLoad(resolvedUrl);
  const diagnostics = analyzer.analyze(
    analysisManifests,
    { skipValidation: validatedAtLoad },
    childRegistry,
  );
  if (!validatedAtLoad) {
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
  const rawManifests = await ctx.loadModule(resolvedUrl, {
    compile: true,
    desugarImports: true,
    migrate: true,
  });

  // Normalize in the library's own scope: extract inline resources and resolve
  // `!ref` sentinels to `{kind, name}` (mirrors the root load at kernel.ts).
  // `analysisManifests` are passed as cross-module resolution targets so a library
  // that references its OWN sub-imports' exported instances (`!ref SubAlias.name`)
  // resolves across that inner boundary too.
  const manifests = analyzer.normalize(rawManifests, childRegistry, analysisManifests);
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
  const declaredInputs = readResourceInputs(moduleManifest);
  validateResourceInputs(declaredInputs, borrowed, targetModule);

  // Evaluate the import's variables/secrets ONCE against the IMPORTER's config
  // scope, instead of baking the raw compiled-value objects verbatim. Resolution
  // is eager and per-hop: each importer resolves its child's inputs from its own
  // already-settled config, so config flows app -> lib -> lib at any nesting depth
  // and a leaf reads `variables.X` as an O(1) concrete lookup with no chain-walk.
  // The single concrete result seeds both the child scope and the snapshot value-
  // flow surface, so they can never diverge.
  //
  // NOTE: `expandValue` evaluates against the importer's FULL context (variables /
  // secrets, plus env/resources for a root app). The config-only import contract —
  // no resources/env/ports in import inputs — is enforced by the analyzer, not here;
  // a `${{ resources.X }}` slipping past analysis (skipValidation / programmatic
  // load) would evaluate at runtime rather than being rejected.
  // Defaults declared on the library's own `variables` / `secrets` contract fill
  // any input the importer didn't override — the import-time analogue of the root
  // Application's env defaulting (`resolveApplicationEnv`). Child modules are
  // isolated from the host environment, so there is no env lookup here: the value
  // is the importer's override, else the library default. Without this a contract
  // var with a default but no override reaches a `${{ variables.X }}` template as
  // a missing key, even though analysis validated the reference against the
  // (defaulted) contract.
  const importVariables = applyDefaults(
    (ctx.expandValue(resource.variables, {}) as Record<string, unknown>) ?? {},
    moduleManifest.variables ?? {},
  );
  const importSecrets = applyDefaults(
    (ctx.expandValue(resource.secrets, {}) as Record<string, unknown>) ?? {},
    moduleManifest.secrets ?? {},
  );
  const childCtx = new ModuleContext(
    // The LIBRARY's own manifest URL, not the importer's. `source` is what every
    // module-relative file reference is measured from — `ctx.resolveModuleFile`
    // for a controller, an `!include-*` embed for a manifest value — so carrying
    // the parent's here made a library read the CONSUMER's directory. That is
    // worse than a hard error: a consumer who happens to have a file at the same
    // relative path gets theirs silently. It also contradicted packaging, which
    // is per-module and had already put the library's file in the library's own
    // artifact.
    //
    // The MANIFEST URL, stamped by the loader — not `resolvedUrl`, which is the
    // import source as written (`./lib`, a directory). Resolving `assets/x` against
    // a directory URL with no trailing slash drops its last segment, which is how
    // the consumer's directory got read in the first place.
    ((moduleManifest.metadata as { source?: string } | undefined)?.source ?? resolvedUrl),
    importVariables,
    importSecrets,
    {},
    [],
    ctx.moduleContext.createInstance,
    ctx.moduleContext.emit,
  );
  // `module.<field>` inside the library reads the LIBRARY's own metadata. Its
  // version is its own — carrying the importer's would make a library reporting
  // `module.version` report whatever happened to import it.
  childCtx.setModuleMetadata(
    authoredModuleMetadata(moduleManifest.metadata as Record<string, unknown> | undefined),
  );

  // A singleton is spawned under the ROOT, never under whichever import reached
  // it first: otherwise tearing that importer down would close a library two
  // others still hold, and which importer that is depends on init order. It is
  // pinned last in the root's cascade so a borrower's own inverses still find it
  // alive — the context-level form of `TEARDOWN_LAST`.
  const isShared = readLibraryLifecycle(moduleManifest) === "shared";
  if (isShared) {
    assertNoSharedOverride(resource, alias, targetModule);
    childCtx.teardownPriority = TEARDOWN_LAST;
  }
  const child = isShared
    ? rootContextOf(ctx.moduleContext).spawnChild(childCtx)
    : ctx.moduleContext.spawnChild(childCtx);

  // A library references its own kinds via `Self.<Kind>` (e.g. when it declares an
  // instance to export). Register `Self` → the library's own module in the child context
  // so those resolve at runtime — ungated, since this is internal use, not an importer.
  childCtx.registerUngatedAlias("Self", targetModule);

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

  // Resolve this import's effective logging configuration once, here, and stamp
  // it as a plain value on the child context — the same shape as the controller
  // policy above.
  //
  // The threshold attaches to the *import* rather than to a map keyed by module
  // name because module names collide (`std/sql` and `acme/sql` share
  // `metadata.name: sql`; the same module imported twice is two subsystems with
  // one name), while an alias is already uniqueness-enforced as a hard
  // DUPLICATE_IMPORT_ALIAS diagnostic. Resolving here means a leaf reads its
  // threshold as an O(1) lookup with no walk up the import chain at emit time —
  // and it is the same scalar a guest runtime caches across an FFI boundary, so
  // scoping and the FFI threshold cache are one mechanism. See §9 and §12.2.
  const parentScope =
    (ctx.moduleContext as unknown as ModuleContext).getLoggingConfig?.() ??
    ctx.kernelLoggingRootScope();
  // A singleton's scope is the LIBRARY's own name: it sits under the root rather
  // than under an importer, and naming it after whichever import was created
  // first would make a log line's scope depend on init order.
  const scopePath = isShared
    ? targetModule
    : parentScope.scope
      ? `${parentScope.scope}.${alias}`
      : alias;
  const importLogging = resource.logging
    ? (ctx.expandValue(resource.logging, {}) as LoggingManifestBlock)
    : undefined;
  (child as ModuleContext).setLoggingConfig({
    ...buildScopeConfig(importLogging, parentScope),
    scope: scopePath,
    module: targetModule,
    secretValues: child.secretValues,
  });

  // A borrowed instance is bound under the library's own name for it BEFORE its
  // resources are registered, so `!ref connection` and `resources.connection`
  // resolve exactly as a locally declared resource does — and so a library
  // declaring a resource that collides with an input name fails as the
  // duplicate it is.
  //
  // An EFFECT on the create frame, not bare statements: binding a borrowed
  // instance registers a publication mirror on the OWNER, and an import whose
  // `init()` fails is discarded and re-created on the next pass. Left
  // unregistered, each pass would append another mirror for the same pair and
  // keep the abandoned child context reachable from the live owner.
  if (borrowed.size > 0) {
    await ctx
      .effect(`borrowed resources ${alias}`, async () => {
        const inverses = [...borrowed].map(([name, entry]) =>
          childCtx.adoptBorrowedResource(
            name,
            entry.manifest,
            entry.instance,
            ctx.moduleContext as unknown as ModuleContext,
          ),
        );
        return {
          result: undefined,
          inverse: () => {
            for (const undo of inverses) undo?.();
          },
        };
      })
      .perform();
  }

  for (const manifest of manifests) {
    // The kind-only stand-ins the loader synthesizes behind a `resources:` entry
    // are a DECLARATION for the analyzer, never an instantiation: the instance
    // is the importer's, already bound above.
    if (isInjectedDeclaration(manifest)) continue;
    child.registerManifest(manifest);
  }

  // Initialize the child's resources in dependency order, mirroring the root
  // context (kernel.boot → setInitOrder). Without this, an imported library's
  // resources init in registration order, so a dependent can run Phase 5
  // injection before its dependency exists — e.g. an Http.Api whose inline route
  // handler is appended after it during inline-resource extraction would init,
  // and inject, before the handler is created, leaving the handler ref
  // unresolved. The order is computed in the library's OWN scope (childRegistry),
  // so an anonymous child resolves against the declaring library, not the
  // consumer. setInitOrder ignores names it doesn't recognize, so a partial order
  // is safe. A cycle purely among a library's own resources is invisible to the
  // root graph (which stops at the import boundary), so this is the only place it
  // surfaces — throw it the same way the root does rather than silently falling
  // back to registration order (which would re-manifest as a confusing runtime
  // ERR_RESOURCE_NOT_INVOKABLE). `prepare` returns null order on a ref-validation
  // error too (already reported by analyze above); those we leave to fall back.
  const { order, cycleError } = analyzer.prepare(manifests, childRegistry);
  if (cycleError) {
    throw new RuntimeError(
      "ERR_CIRCULAR_DEPENDENCY",
      `Circular dependency in imported library '${targetModule}': ${cycleError}`,
    );
  }
  if (order) (child as ModuleContext).setInitOrder(order);

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

  // `exports.kinds` entries are a bare kind name (locally defined) or `Alias.Kind` (a re-export
  // of an imported library's kind). `parseExportEntry` (shared with the analyzer) yields
  // `{name, alias?}` — `name` is the exported kind suffix, `alias` (when set) names this
  // library's own import it re-exports from.
  // A library that declares `exports.kinds` is gated to exactly that list (an empty list
  // exports nothing). One that declares none registers an unrestricted gate (`undefined`)
  // — the legacy permissive default, kept so already-published module versions, whose
  // manifests can no longer gain an `exports.kinds` block, stay importable. Flipping this
  // to a gated `[]` makes kinds private by default and is a breaking change for every such
  // version; it needs the ecosystem republished with explicit exports first.
  const declaredKinds = moduleManifest.exports?.kinds as string[] | undefined;
  const kindEntries = (declaredKinds ?? []).map(parseExportEntry);
  const exportedKindSuffixes =
    declaredKinds === undefined ? undefined : kindEntries.map((k) => k.name);
  // `exports.resources` entries are a bare name (`Db`, a locally-owned export) or a dotted
  // `Alias.Name` (re-export of an imported instance, under name `Name`) — same grammar as
  // `exports.kinds`.
  const exportEntries = ((moduleManifest.exports?.resources ?? []) as unknown[]).map((e) => {
    if (typeof e !== "string") {
      throw new RuntimeError(
        "ERR_INVALID_EXPORT",
        `Library '${targetModule}' exports.resources entries must be plain names ('Name' or ` +
          `'Alias.Name'); the '!ref' tag is not allowed in exports.resources.`,
      );
    }
    return parseExportEntry(e);
  });
  const exportedResourceNames = exportEntries.map((e) => e.name);
  for (const name of exportedResourceNames) {
    if (name === "variables" || name === "secrets") {
      throw new RuntimeError(
        "ERR_INVALID_EXPORT",
        `Library exports.resources may not include the reserved name '${name}' — it would overwrite the import's '${name}' value-flow surface under resources.${alias}.`,
      );
    }
  }
  /** Build this library's resources and its export tables — the work an
   *  `init()` performs, hoisted so a SINGLETON can carry it on its registry
   *  entry rather than in one import's closure. Whichever import's `init()`
   *  runs first calls it; every other awaits the same promise. */
  const buildLibrary = async (): Promise<void> => {
    // Publish each borrowed reading into the child's `resources` scope before
    // anything reads it: a library resource's compile-eval fields are expanded
    // at CREATE time, inside `initializeResources` below.
    for (const name of borrowed.keys()) await childCtx.publishSnapshot(name);
    await child.initializeResources();
    // Build this import's flattened export tables now that its own imports are
    // registered (leaves-first), so a re-export (`!ref Alias.name` /
    // `Alias.Kind`) copies the source import's terminal getter / canonical kind
    // by reference — O(1) resolution at any depth.
    childCtx.buildExportTable(exportEntries, kindEntries, targetModule);
  };

  // The singleton, registered before any alias so a second import created in
  // the same pass finds it. `initialized` is filled by whichever import's
  // `init()` runs first — which is NOT necessarily the one that registered it,
  // so the builder travels with the entry.
  const entry: SharedLibrary | undefined = isShared
    ? {
        build: buildLibrary,
        url: resolvedUrl,
        module: targetModule,
        owner: alias,
        context: childCtx,
        child,
        variables: importVariables,
        secrets: importSecrets,
        resources: new Map([...borrowed].map(([name, b]) => [name, b.instance])),
        declaredVariables: (moduleManifest.variables ?? {}) as Record<string, any>,
        declaredSecrets: (moduleManifest.secrets ?? {}) as Record<string, any>,
        exportEntries,
        kindEntries,
        exportedResourceNames,
        exportedKindSuffixes,
      }
    : undefined;
  if (entry) registry.set(resolvedUrl, entry);

  // The alias registrations are an EFFECT on the create frame, not bare calls:
  // an import whose `init()` fails is discarded and re-created on the next pass,
  // so an alias left registered would be re-registered against a module context
  // that already has it — and the abandoned child context would linger with no
  // owner. One effect, because the four registrations are one act: an alias
  // resolving kinds through a module whose instances are gone is not a state
  // this controller should be able to produce.
  await ctx
    .effect(`import alias ${alias}`, async () => {
      ctx.registerModuleImport(alias, targetModule, exportedKindSuffixes);

      // Publish the child's exported instances to the parent so cross-module `!ref Alias.name`
      // (Phase 5 injection / boot targets) and `${{ resources.Alias.name }}` (CEL value-flow)
      // resolve. The gate is `exports.resources`; the child's terminal getter is read lazily —
      // it exists after this import's init() built the child's export table. Handing the parent
      // the child's TERMINAL getter (not a wrapper) keeps resolution O(1) across re-export hops.
      (ctx.moduleContext as ModuleContext).registerImportedScope(
        alias,
        exportedResourceNames,
        (name) => childCtx.getTerminalExport(name),
      );
      // Same for kinds: `kind: Alias.Kind` resolves through the child's exported-kind table,
      // covering both locally-defined and transitively re-exported kinds in O(1).
      (ctx.moduleContext as ModuleContext).registerImportedKindScope(alias, (suffix) =>
        childCtx.getExportedKind(suffix),
      );

      return {
        result: undefined,
        inverse: () => {
          (ctx.moduleContext as ModuleContext).unregisterImport(alias);
          // The child context goes with the alias: it was spawned for this
          // import and nothing else can reach it once the alias is gone. A
          // SINGLETON is the exception — the root owns it and other imports may
          // still hold it, so only the alias is given up.
          if (!isShared) ctx.moduleContext.detachChild(child);
        },
      };
    })
    .perform();

  // Return a ResourceInstance whose snapshot() surfaces the exported values under
  // resources.<alias>: the import's variables/secrets plus each exported instance's own
  // snapshot keyed by name (the CEL value-flow surface for Provider-style exports).
  // The kernel's generic setResource() stores the result under resources.<alias>.
  return {
    snapshot: async () => {
      const exported: Record<string, unknown> = {};
      for (const name of exportedResourceNames) {
        // Through the shared publication policy, not the raw snapshot: an
        // exported instance's observed state stays withheld until it starts and
        // is validated against its `status:` on this side of the boundary too.
        const target = childCtx.getExported(name);
        if (target?.instance) {
          exported[name] = await publishedPropsOf(
            target.kind,
            name,
            target.instance,
            childCtx.getDefinition,
          );
        }
      }
      return {
        variables: importVariables,
        secrets: importSecrets,
        ...exported,
      };
    },
    // The library's resources ARE this import's allocation, and tearing the
    // child context down is what undoes it — so the two are one effect rather
    // than an init/teardown pair the kernel had to trust were inverses.
    init: (importCtx) =>
      importCtx.effect("library resources", async () => {
        if (entry) {
          // Memoized on the ENTRY, so whichever import's `init()` runs first
          // does the work and every other awaits the same promise. It is not
          // necessarily the import that registered it: a root import registers
          // the singleton during the create sub-phase, while a nested import
          // inside another library borrows it during that library's init — and
          // the nested one's `init()` can then run first.
          await (entry.initialized ??= entry.build());
          // No inverse: the ROOT owns a singleton, and an import that gave it up
          // would close a library its siblings still hold.
          return { result: undefined };
        }
        await buildLibrary();
        return { result: undefined, inverse: () => child.teardownResources() };
      }),
  };
}

/**
 * A second (or third) import of a library already instantiated as a singleton.
 *
 * Nothing is fetched, parsed or analyzed: the registry hit means the library is
 * built and shared, so this import only has to agree with it and register its
 * own alias. What it must NOT do is re-register the manifests, re-initialize the
 * resources, or claim any part of the teardown.
 */
function borrowSharedLibrary(
  entry: SharedLibrary,
  alias: string,
  resource: any,
  borrowed: Map<string, BorrowedResource>,
  ctx: BuiltinControllerContext,
): ResourceInstance {
  assertNoSharedOverride(resource, alias, entry.module);
  const importVariables = applyDefaults(
    (ctx.expandValue(resource.variables, {}) as Record<string, unknown>) ?? {},
    entry.declaredVariables,
  );
  const importSecrets = applyDefaults(
    (ctx.expandValue(resource.secrets, {}) as Record<string, unknown>) ?? {},
    entry.declaredSecrets,
  );
  validateRequiredInputs(entry.declaredVariables, importVariables, "variables");
  validateRequiredInputs(entry.declaredSecrets, importSecrets, "secrets");
  assertSharedInputsAgree(entry, alias, importVariables, importSecrets, borrowed);

  const childCtx = entry.context;
  const exportedResourceNames = [...entry.exportedResourceNames];

  return {
    snapshot: async () => {
      const exported: Record<string, unknown> = {};
      for (const name of exportedResourceNames) {
        const target = childCtx.getExported(name);
        if (target?.instance) {
          exported[name] = await publishedPropsOf(
            target.kind,
            name,
            target.instance,
            childCtx.getDefinition,
          );
        }
      }
      return { variables: importVariables, secrets: importSecrets, ...exported };
    },
    init: (importCtx) =>
      importCtx
        .effect(`import alias ${alias}`, async () => {
          ctx.registerModuleImport(
            alias,
            entry.module,
            entry.exportedKindSuffixes ? [...entry.exportedKindSuffixes] : undefined,
          );
          (ctx.moduleContext as ModuleContext).registerImportedScope(
            alias,
            exportedResourceNames,
            (name) => childCtx.getTerminalExport(name),
          );
          (ctx.moduleContext as ModuleContext).registerImportedKindScope(alias, (suffix) =>
            childCtx.getExportedKind(suffix),
          );
          return {
            result: undefined,
            // Only the alias: the root owns the library and the imports that
            // instantiated it are still holding it.
            inverse: () => (ctx.moduleContext as ModuleContext).unregisterImport(alias),
          };
        })
        // The singleton may not be built yet — this import's `init()` can run
        // before the one that registered it. Start it if nobody has; otherwise
        // await the one promise everybody shares.
        .effect("shared library", async () => {
          await (entry.initialized ??= entry.build());
          return { result: undefined };
        }),
  };
}

/**
 * Fill in library-declared `default:` values for any input the importer left
 * unset. Mirrors the root Application's env defaulting: a provided value (incl.
 * an explicit `null`) wins; otherwise the contract default applies. Returns a new
 * object — the resolved input map is never mutated in place.
 */
function applyDefaults(
  provided: Record<string, unknown>,
  schemaDefs: Record<string, any>,
): Record<string, unknown> {
  const out = { ...provided };
  for (const [key, def] of Object.entries(schemaDefs)) {
    if (typeof def !== "object" || def === null || !("default" in def)) continue;
    if (out[key] === undefined || out[key] === null) {
      out[key] = def.default;
    }
  }
  return out;
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


/** One instance handed down to a library's declared `resources:` input, with the
 *  manifest it was DECLARED with — the declaration is what a projected contract
 *  and a `status:` reading are resolved against, so it travels with the
 *  instance rather than being re-derived on the far side. */
interface BorrowedResource {
  manifest: ResourceManifest;
  instance: ResourceInstance;
}

/**
 * Resolve every `resources:` entry this import supplies to a live instance, in
 * the IMPORTER's scope.
 *
 * A name that is registered here but not yet initialized defers
 * (`ERR_LOCAL_REF_PENDING`); one that names nothing at all is a hard
 * `ERR_REF_UNRESOLVED`, since no later pass will produce it. The two are kept
 * apart because the init-failure classifier reads the first as derived — the
 * import never ran — and the second as the root cause it is.
 */
function resolveBorrowedResources(
  resource: any,
  ctx: BuiltinControllerContext,
): Map<string, BorrowedResource> {
  const out = new Map<string, BorrowedResource>();
  const alias = resource.metadata.name as string;
  for (const [name, value] of Object.entries(readSuppliedResources(resource))) {
    const ref = value as { name?: unknown; alias?: unknown } | undefined;
    const targetName = typeof ref?.name === "string" ? ref.name : undefined;
    if (!targetName) {
      throw new RuntimeError(
        "ERR_REF_UNRESOLVED",
        `Import '${alias}': resource input '${name}' must be a '!ref' to a resource this module declares.`,
      );
    }
    const targetAlias = typeof ref?.alias === "string" ? ref.alias : undefined;
    const instance =
      targetAlias && targetAlias !== "Self"
        ? ctx.moduleContext.resolveImportedInstance(targetAlias, targetName)
        : ctx.moduleContext.getInstance?.(targetName);
    if (!instance) {
      const label = targetAlias ? `${targetAlias}.${targetName}` : targetName;
      throw new RuntimeError(
        targetAlias && targetAlias !== "Self"
          ? "ERR_CROSS_MODULE_REF_PENDING"
          : "ERR_LOCAL_REF_PENDING",
        `Import '${alias}': resource input '${name}' → '${label}' is not available yet ` +
          `(deferring to a later init pass).`,
      );
    }
    const manifest =
      ctx.moduleContext.resolveDeclaredManifest?.(targetName, targetAlias) ??
      ({ kind: (ref as { kind?: string }).kind ?? "", metadata: { name: targetName } } as ResourceManifest);
    out.set(name, { manifest, instance });
  }
  return out;
}

/** The runtime half of `validate-resource-inputs`: a library reached through a
 *  programmatic load never passed `telo check`, so the boundary is enforced
 *  here too. Kind acceptance is deliberately NOT re-tested — that is a static
 *  question about declarations, and the kernel holds instances. */
function validateResourceInputs(
  declared: ReadonlyArray<{ name: string; kind: string }>,
  supplied: ReadonlyMap<string, BorrowedResource>,
  targetModule: string,
): void {
  for (const entry of declared) {
    if (supplied.has(entry.name)) continue;
    throw new RuntimeError(
      "ERR_MANIFEST_VALIDATION_FAILED",
      `Required resource input "${entry.name}" (kind '${entry.kind}') not provided for import of ` +
        `module '${targetModule}'.`,
    );
  }
  const names = new Set(declared.map((d) => d.name));
  for (const name of supplied.keys()) {
    if (names.has(name)) continue;
    throw new RuntimeError(
      "ERR_MANIFEST_VALIDATION_FAILED",
      `Resource input "${name}" is not declared by module '${targetModule}'. Declared inputs: ` +
        `${declared.map((d) => d.name).join(", ") || "(none)"}.`,
    );
  }
}
