/**
 * Which definition a declaration's own checks are judged against: its kind
 * resolved through the scope that declared it, exactly as the kernel resolves
 * it — or why it has none. One reader for a configuration's run, which reports
 * each refusal, and for a key's environment, which judges a declaration's own
 * checks only where this answers a definition.
 *
 * Browser-safe.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { scopeResolverForModule, type AliasResolver } from "./alias-resolver.js";
import { isStandInDeclaration } from "./choice-expansion.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { isInjectedDeclaration } from "./resource-input.js";
import { isInstantiableDefinition } from "./instantiable-kind.js";
import { BUILTIN_VOCABULARY_KIND } from "./builtin-vocabulary.js";

/** Every import of a set, by the module it loads. */
export type ImportersByModule = ReadonlyMap<string, readonly { readonly alias: string; readonly entryScoped: boolean }[]>;

/** What the kind of a declaration resolves to, or why its own checks do not run. */
export type DeclaredDefinition =
  /** A stand-in, a forwarded export or an injected input: nothing of its own to judge. */
  | { readonly status: "skip" }
  | { readonly status: "missing"; readonly path: "kind" | "metadata.name" }
  /** A `Telo.Abstract`, held to the built-in schema alone. */
  | { readonly status: "abstract-document" }
  | {
      readonly status: "gated";
      readonly module: string;
      readonly exported: readonly string[];
    }
  /** A kind spelled by the canonical name of a module only an import loads. */
  | { readonly status: "unimported"; readonly prefix: string; readonly ownAliases: readonly string[] }
  | { readonly status: "builtin-vocabulary" }
  | { readonly status: "undefined" }
  | {
      readonly status: "not-instantiable";
      readonly definition: ResourceDefinition;
      readonly resolvedKind: string | undefined;
      readonly scopeResolver: AliasResolver | undefined;
    }
  | {
      readonly status: "ok";
      readonly definition: ResourceDefinition;
      readonly resolvedKind: string | undefined;
      readonly ownModule: string | undefined;
      /** Whether the declaration is the entry's own, not an analysis-only view. */
      readonly entryScoped: boolean;
      readonly scopeResolver: AliasResolver | undefined;
    };

export interface DeclaredDefinitionScope {
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  readonly rootModules: Set<string>;
  readonly importersByModule: ImportersByModule;
  /** Whether a declaration is an analysis-only view (a forward view). */
  readonly analysisOnly: (m: ResourceManifest) => boolean;
}

/** The definition `m`'s own checks are judged against, read in its scope. */
export function declaredDefinitionOf(m: ResourceManifest, scope: DeclaredDefinitionScope): DeclaredDefinition {
  const { defs, aliases, aliasesByModule, rootModules } = scope;
  if (isStandInDeclaration(m)) return { status: "skip" };
  if (!m.kind || !m.metadata?.name) return { status: "missing", path: !m.kind ? "kind" : "metadata.name" };
  if (m.kind === "Telo.Abstract") return { status: "abstract-document" };
  if (isForwardedDeclaration(m) || isInjectedDeclaration(m)) return { status: "skip" };
  const ownModule = (m.metadata as { module?: string } | undefined)?.module;
  const scopeResolver = scopeResolverForModule(ownModule, rootModules, aliasesByModule);
  // Either scope resolving it wins; otherwise a gate rejection is more specific
  // than "unknown alias".
  const scoped = scopeResolver?.resolveKindResult(m.kind);
  const rooted = aliases.resolveKindResult(m.kind);
  const kindResult =
    scoped?.status === "ok" ? scoped : rooted.status === "ok" ? rooted : scoped?.status === "gated" ? scoped : rooted;
  // The gate is checked before any definition lookup: the registry is keyed
  // `<module>.<Kind>`, so an alias equal to its module's name would otherwise
  // reach a kind the module does not export.
  if (kindResult.status === "gated") {
    return { status: "gated", module: kindResult.module, exported: kindResult.exported };
  }
  const resolvedKind = kindResult.status === "ok" ? kindResult.kind : undefined;
  const analysisOnly = scope.analysisOnly(m);
  const entryScoped = !analysisOnly && (!ownModule || rootModules.has(ownModule));
  if (entryScoped && kindResult.status === "unknown") {
    const prefix = m.kind.slice(0, m.kind.indexOf("."));
    const importers = scope.importersByModule.get(prefix);
    if (importers && defs.resolve(m.kind)) {
      return { status: "unimported", prefix, ownAliases: importers.filter((i) => i.entryScoped).map((i) => i.alias) };
    }
  }
  // An alias that resolved names the one kind the kernel will look up.
  const definition = analysisOnly
    ? (defs.resolve(m.kind) ?? (resolvedKind ? defs.resolve(resolvedKind) : undefined))
    : resolvedKind
      ? defs.resolve(resolvedKind)
      : defs.resolve(m.kind);
  if (!definition && m.kind === BUILTIN_VOCABULARY_KIND) return { status: "builtin-vocabulary" };
  if (!definition) return { status: "undefined" };
  if (!isInstantiableDefinition(definition)) {
    return { status: "not-instantiable", definition, resolvedKind, scopeResolver };
  }
  return { status: "ok", definition, resolvedKind, ownModule, entryScoped, scopeResolver };
}

/** Every import of `manifests`, by the module it loads. */
export function importersByModuleOf(manifests: Iterable<ResourceManifest>, rootModules: ReadonlySet<string>): ImportersByModule {
  const out = new Map<string, { alias: string; entryScoped: boolean }[]>();
  for (const m of manifests) {
    if (m.kind !== "Telo.Import") continue;
    const meta = m.metadata as { name?: string; module?: string; resolvedModuleName?: string };
    if (!meta.name || !meta.resolvedModuleName) continue;
    const list = out.get(meta.resolvedModuleName) ?? [];
    list.push({ alias: meta.name, entryScoped: !meta.module || rootModules.has(meta.module) });
    out.set(meta.resolvedModuleName, list);
  }
  return out;
}
