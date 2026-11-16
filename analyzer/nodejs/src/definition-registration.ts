import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { isExpansionSentinel } from "@telorun/templating";
import { AliasResolver } from "./alias-resolver.js";
import type { AnalysisRegistry } from "./analysis-registry.js";
import { capabilityProblem, type CapabilityProblem } from "./capability-roster.js";
import { inheritedCapability } from "./extends-resolution.js";
import { keyedTranslationsOf } from "./keyed-translations.js";
import { isKindDocument, kindDeclarationOf } from "./kind-declaration.js";
import { libraryDeclarations, type LibraryDeclarations } from "./library-declarations.js";
import { declaringModuleScope } from "./module-alias-scope.js";
import type { ModuleDocuments } from "./module-documents.js";
import { isModuleKind } from "./module-kinds.js";
import { needTypeOf } from "./need-type.js";
import { readReferrerRules, type ReferrerRule } from "./referrer-rule.js";
import { pointerToPath } from "./resource-rule.js";
import { resolveSchemaRefKinds, type RefConstraintIssue } from "./resolve-schema-ref-kinds.js";
import { withCanonicalSchemaTypeRefs } from "./resolve-schema-type-refs.js";
import { retryForProblems } from "./retry-for-slot.js";
import { serializableAnnotationProblems } from "./serializable-slot.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import { validateRefSlotDeclarations, type RefSlotIssue } from "./validate-ref-slots.js";
import { scopeOpenedByProblems, scopeSlotProblems } from "./validate-scope-slots.js";
import { validateZoneSlotDeclarations, type ZoneSlotIssue } from "./validate-zone-slots.js";

const SOURCE = "telo-analyzer";

/** The built-in namespace: globally resolvable, crossing no import boundary. */
const TELO_BUILTIN_MODULE = "Telo";

/** What registration found about one `Telo.Definition` / `Telo.Abstract`,
 *  tagged with the module declaring it: the analysis reports a definition's
 *  own findings for the entry's modules alone, and its capability refusal for
 *  every module. */
export interface RegisteredDefinition {
  readonly manifest: ResourceManifest;
  readonly module: string | undefined;
  readonly capability: CapabilityProblem | undefined;
  readonly refConstraintIssues: readonly RefConstraintIssue[];
  readonly refSlotIssues: readonly RefSlotIssue[];
  /** `SERIALIZABLE_ANNOTATION_INVALID`, `RETRY_FOR_INVALID`,
   *  `SCOPE_SLOT_MISPLACED` and `SCOPE_OPENED_BY_INVALID`, in that order. */
  readonly slotDiagnostics: readonly AnalysisDiagnostic[];
  readonly zoneSlotIssues: readonly ZoneSlotIssue[];
  readonly referrerRules: readonly ReferrerRule[];
}

/**
 * One registration of a manifest set's declaration plane — its module docs,
 * its stamped `Telo.Import` docs and its kind documents — into a registry: the
 * module identities, every module scope's aliases and every definition. What
 * every analysis of the set consumes, made once per analysed root.
 */
export interface DefinitionRegistration {
  readonly registry: AnalysisRegistry;
  /** The modules whose own docs the set holds: the entry's. */
  readonly rootModules: ReadonlySet<string>;
  readonly libraries: LibraryDeclarations;
  /** `DUPLICATE_IMPORT_ALIAS`, at each repeat, in the order written. */
  readonly duplicateAliases: readonly AnalysisDiagnostic[];
  /** Every definition registered, need types and keyed declarations aside, in
   *  the order written. */
  readonly definitions: readonly RegisteredDefinition[];
  /** The definitions registered as a copy of their document (their `extends`
   *  canonicalized or a schema shape reference made canonical). */
  readonly registeredCopies: readonly ResourceManifest[];
}

let registrationObserver: (() => void) | undefined;

/** Observe every registration until the returned function is called. */
export function observeDefinitionRegistrations(listener: () => void): () => void {
  registrationObserver = listener;
  return () => {
    if (registrationObserver === listener) registrationObserver = undefined;
  };
}

/** A library's own alias table, which names the built-ins as every module's does. */
function libraryAliasTable(tables: Map<string, AliasResolver>, module: string): AliasResolver {
  const table = new AliasResolver();
  table.registerUngatedAlias(TELO_BUILTIN_MODULE, TELO_BUILTIN_MODULE);
  tables.set(module, table);
  return table;
}

/**
 * Registers the declaration plane of `manifests` into `registry`, adding to
 * what it already holds. Reads module docs, `Telo.Import` docs and kind
 * documents only; a document written behind an expansion tag declares nothing.
 */
export function registerDefinitions(
  manifests: readonly ResourceManifest[],
  registry: AnalysisRegistry,
  moduleDocuments: readonly ModuleDocuments[] = [],
): DefinitionRegistration {
  registrationObserver?.();
  const plane = manifests.filter((m) => !isExpansionSentinel(m));
  const ctx = registry._context();
  const aliases = ctx.aliases!;
  // `Telo` crosses no import boundary — the kernel built-ins are globally
  // resolvable, which is what lets `kind: Telo.ConsoleSink` and
  // `extends: Telo.LogSink` work with no `imports:` entry (§10.2). The kernel
  // registers the same ungated alias at boot.
  aliases.registerUngatedAlias(TELO_BUILTIN_MODULE, TELO_BUILTIN_MODULE);
  const defs = ctx.definitions!;
  const aliasesByModule = ctx.aliasesByModule!;
  const duplicateAliases: AnalysisDiagnostic[] = [];

  // Two alias scopes: `aliases`, the entry's own, from the `Telo.Import`s its
  // module declares; and `aliasesByModule`, one per imported library, from the
  // `Telo.Import`s the loader forwards from inside it — a library may alias a
  // dependency differently, so each forwarded definition is normalized in its
  // own library's scope.
  const rootModules = new Set<string>();
  for (const m of plane) {
    if (isModuleKind(m.kind) && m.metadata?.name) rootModules.add(m.metadata.name as string);
  }
  // Every imported library's own declarations, read by a projection hop into
  // a library's internals. Shared with the registry so an editor's contract
  // query resolves the same hops `telo check` does.
  const libraries = libraryDeclarations(moduleDocuments);
  registry._setLibraries(libraries, moduleDocuments);
  // Per-module-scope seen aliases for DUPLICATE_IMPORT_ALIAS. Authored
  // Telo.Import docs and synthetic-from-inline-`imports:` share one alias
  // namespace per module, so a repeat — across either form — is an error
  // rather than the silent last-writer-wins the resolver would otherwise do.
  const seenAliasByScope = new Map<string, Set<string>>();
  for (const m of plane) {
    if (isModuleKind(m.kind)) {
      const namespace = ((m.metadata as any).namespace as string | undefined) ?? null;
      const moduleName = m.metadata.name as string;
      if (moduleName) defs.registerModuleIdentity(namespace, moduleName);
      // `Self` and the module's own name resolve its kinds UNGATED — a module
      // may reference its own kinds regardless of `exports.kinds`, which gates
      // importers, not internal use. `<module>.<Kind>` is the canonical
      // identity every diagnostic prints, and the kernel registers both in
      // every context.
      if (moduleName) {
        if (rootModules.has(moduleName)) {
          aliases.registerUngatedAlias("Self", moduleName);
          aliases.registerUngatedAlias(moduleName, moduleName);
        } else {
          let libResolver = aliasesByModule.get(moduleName);
          if (!libResolver) {
            libResolver = new AliasResolver();
            libResolver.registerUngatedAlias(TELO_BUILTIN_MODULE, TELO_BUILTIN_MODULE);
            aliasesByModule.set(moduleName, libResolver);
          }
          libResolver.registerUngatedAlias("Self", moduleName);
          libResolver.registerUngatedAlias(moduleName, moduleName);
        }
      }
    }
    if (m.kind === "Telo.Import") {
      const alias = m.metadata.name as string;
      const source = (m as any).source as string | undefined;
      // The target's `exports.kinds` gate, stamped onto this import by
      // `stampExportedKinds`. Undefined means the target declares no gate.
      const exportedKinds = (m.metadata as { exportedKinds?: string[] } | undefined)?.exportedKinds;
      const resolvedModuleName = (m.metadata as any).resolvedModuleName as string | undefined;
      const resolvedNamespace = (m.metadata as any).resolvedNamespace as string | null | undefined;
      const ownModule = (m.metadata as { module?: string } | undefined)?.module;
      // A module NAME is not a module INSTANCE: one library may be reached
      // through two sources, and each instance's `imports:` is declared in its
      // own file, so the declaring file's `source` is folded into the scope key.
      const ownSource = (m.metadata as { source?: string } | undefined)?.source;
      if (alias) {
        const scopeKey = ownModule ? `${ownModule}\0${ownSource ?? ""}` : "";
        let seen = seenAliasByScope.get(scopeKey);
        if (!seen) {
          seen = new Set<string>();
          seenAliasByScope.set(scopeKey, seen);
        }
        if (seen.has(alias)) {
          duplicateAliases.push({
            severity: DiagnosticSeverity.Error,
            code: "DUPLICATE_IMPORT_ALIAS",
            source: SOURCE,
            message:
              `Duplicate import alias '${alias}'. An alias may be declared once per module — ` +
              `across both inline 'imports:' entries and 'Telo.Import' documents. ` +
              `Rename or remove the duplicate.`,
            data: {
              resource: { kind: "Telo.Import", name: alias },
              filePath: ownSource,
              path: "metadata.name",
            },
          });
          // The first alias→target mapping stays: last-writer-wins would shadow
          // it and cascade misleading follow-on diagnostics.
          continue;
        }
        seen.add(alias);
      }
      // An import whose target identity was never established registers NO
      // alias, and the name is never guessed from the source string: every use
      // degrades to "cannot resolve alias '<X>'", pointing at the import.
      if (alias && source && resolvedModuleName) {
        // Module identity is registered globally so x-telo-ref resolution sees
        // transitively-imported modules regardless of which scope brought them in.
        defs.registerModuleIdentity(resolvedNamespace ?? null, resolvedModuleName);
        // `metadata.reExportedKinds` maps an exported suffix to the true owning
        // module's canonical kind for kinds this import transitively re-exports.
        const reExportedKinds = ((m.metadata as any)?.reExportedKinds ?? {}) as Record<string, string>;
        const resolver =
          !ownModule || rootModules.has(ownModule)
            ? aliases
            : (aliasesByModule.get(ownModule) ?? libraryAliasTable(aliasesByModule, ownModule));
        resolver.registerImport(alias, resolvedModuleName, exportedKinds);
        for (const [suffix, canonical] of Object.entries(reExportedKinds)) {
          resolver.registerKindReExport(alias, suffix, canonical);
        }
      }
    }
  }

  // `Self` for every module contributing definitions whose own module doc the
  // set does not hold — flatten forwards a library's kind documents but not its
  // module doc — so a forwarded `extends: Self.X` resolves and its `extendedBy`
  // edge is keyed canonically.
  for (const m of plane) {
    if (!isKindDocument(m)) continue;
    const ownModule = (m.metadata as { module?: string } | undefined)?.module;
    if (!ownModule || rootModules.has(ownModule)) continue;
    let libResolver = aliasesByModule.get(ownModule);
    if (!libResolver) {
      libResolver = new AliasResolver();
      libResolver.registerUngatedAlias(TELO_BUILTIN_MODULE, TELO_BUILTIN_MODULE);
      aliasesByModule.set(ownModule, libResolver);
    }
    if (!libResolver.hasAlias("Self")) libResolver.registerUngatedAlias("Self", ownModule);
    if (!libResolver.hasAlias(ownModule)) libResolver.registerUngatedAlias(ownModule, ownModule);
  }

  // Every `Telo.Definition`, `Telo.Abstract` and synthesized kind, with
  // alias-form `capability` / `extends` / `x-telo-ref` canonicalized in the
  // DECLARING module's scope, so `extendedBy` is keyed by canonical kind.
  const definitions: RegisteredDefinition[] = [];
  const registeredCopies: ResourceManifest[] = [];
  for (const m of plane) {
    const declared = kindDeclarationOf(m);
    if (!declared) continue;
    // A need type registers the Provider kind its fulfilments are, and a keyed
    // declaration the translations kind of its keys.
    if (needTypeOf(declared) || keyedTranslationsOf(declared)) {
      defs.register(declared);
      continue;
    }
    const def = m as unknown as ResourceDefinition;
    const ownModule = (def.metadata as { module?: string } | undefined)?.module;
    const scopeResolver = declaringModuleScope(ownModule, aliases, { aliasesByModule, rootModules });
    const refConstraintIssues = resolveSchemaRefKinds(m, scopeResolver);
    const at = (code: string, message: string, path: string): AnalysisDiagnostic => ({
      severity: DiagnosticSeverity.Error,
      code,
      source: SOURCE,
      message,
      data: {
        resource: { kind: m.kind, name: def.metadata?.name as string },
        filePath: (def.metadata as { source?: string } | undefined)?.source,
        path,
      },
    });
    const slotDiagnostics: AnalysisDiagnostic[] = [];
    for (const problem of serializableAnnotationProblems((def as { schema?: unknown }).schema)) {
      slotDiagnostics.push(at("SERIALIZABLE_ANNOTATION_INVALID", problem.message, pointerToPath(`/schema${problem.pointer}`)));
    }
    for (const problem of retryForProblems(def)) {
      slotDiagnostics.push(at("RETRY_FOR_INVALID", problem.message, problem.path));
    }
    for (const problem of scopeSlotProblems(def)) {
      slotDiagnostics.push(at("SCOPE_SLOT_MISPLACED", `${m.kind} ${problem.message}`, problem.path));
    }
    // Read against what is registered so far, so a parent declared later in
    // the set is not yet known here.
    const capability = inheritedCapability(def, (k) => defs.resolve(scopeResolver.resolveKind(k) ?? k) ?? defs.resolve(k));
    for (const problem of scopeOpenedByProblems(def, capability)) {
      slotDiagnostics.push(at("SCOPE_OPENED_BY_INVALID", `${m.kind} ${problem.message}`, problem.path));
    }
    definitions.push({
      manifest: m,
      module: ownModule,
      // The closed roster: a `capability:` names a lifecycle role a kernel
      // implements, or the kernel refuses the definition at registration.
      capability: capabilityProblem(def.capability, def.extends !== undefined),
      refConstraintIssues,
      refSlotIssues: validateRefSlotDeclarations(m),
      slotDiagnostics,
      zoneSlotIssues: validateZoneSlotDeclarations(m),
      referrerRules: readReferrerRules((m as Record<string, unknown>).schema),
    });
    const resolvedExtends = def.extends ? (scopeResolver.resolveKind(def.extends) ?? def.extends) : def.extends;
    // A named shape the schema names is canonical in THIS module's scope
    // before a kind of another module can inherit it.
    const normalized = withCanonicalSchemaTypeRefs(
      resolvedExtends !== def.extends ? { ...def, extends: resolvedExtends } : def,
      aliases,
      aliasesByModule,
    );
    if (normalized !== def) registeredCopies.push(normalized as unknown as ResourceManifest);
    defs.register(normalized);
  }

  return { registry, rootModules, libraries, duplicateAliases, definitions, registeredCopies };
}
