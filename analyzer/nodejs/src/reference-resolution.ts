/**
 * The resolution seam: how a builder that reads ANOTHER declaration through a
 * name learns what the name resolves to — one outcome per request, never a list
 * of declarations to search.
 *
 * Four builders take it: `!ref` resolution (`resolveRefSentinels`,
 * `resolveShapeRefs`), the consumer expander's `declarationAt`
 * (`readTemplateConsumers`), and a forward view's `fromSelf` crossing
 * (`buildTemplateForwardViews`). The kernel and the analysis of one
 * configuration fill it with the full-list resolver ({@link listResolution});
 * a per-key environment fills it from the conditioned name index
 * (`conditioned-name-index.ts`) at its witness.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { isStandInDeclaration } from "./choice-expansion.js";
import { isForwardedDeclaration, isForwardedExport } from "./forwarded-declaration.js";
import { scopeAddress, type ScopeAddress, type ScopeSite } from "./scope-address.js";
import {
  importPathThrough,
  MANIFEST_READING,
  ScopedNameResolver,
  type ScopedResolution,
} from "./scoped-name-resolver.js";
import { isKindDocumentOrImport } from "./system-kinds.js";

/** What resolving one name yields. */
export type ResolutionOutcome =
  | { readonly status: "resolved"; readonly declaration: ResourceManifest; readonly address: ScopeAddress }
  /** A choice nothing decides: its name, with no kind. */
  | { readonly status: "stand-in"; readonly declaration: ResourceManifest; readonly address: ScopeAddress }
  | { readonly status: "unresolved" };

export const UNRESOLVED: ResolutionOutcome = { status: "unresolved" };

/** The outcome a scoped lookup's answer is. */
export function outcomeOf(found: ScopedResolution<ResourceManifest> | undefined): ResolutionOutcome {
  if (!found) return UNRESOLVED;
  return {
    status: isStandInDeclaration(found.declaration) ? "stand-in" : "resolved",
    declaration: found.declaration,
    address: found.address,
  };
}

/** The declaration an outcome names, stand-ins included. */
export function declarationOf(outcome: ResolutionOutcome): ResourceManifest | undefined {
  return outcome.status === "unresolved" ? undefined : outcome.declaration;
}

/**
 * Name resolution over one population of declarations: the scoped rule of
 * {@link ScopedNameResolver} — scope first, innermost out, then the module —
 * answered one outcome at a time.
 */
export interface NameResolution {
  /** What `name`, read in `fromModule` inside `within`, resolves to. */
  locate(
    name: string,
    fromModule: string | undefined,
    within?: ScopeSite,
    accept?: (declaration: ResourceManifest) => boolean,
  ): ResolutionOutcome;
  /** The module-level declaration of `name` by `module` itself — of the
   *  instance at `importPath` when the module is imported as several. */
  inModule(name: string, module: string | undefined, importPath?: readonly string[]): ResolutionOutcome;
  /** Record the members a scope a walked declaration holds declares. */
  declareScope(site: ScopeSite, members: Iterable<ResourceManifest>): void;
}

/** The three populations `!ref` resolution reads: the analysed modules' own
 *  declarations (a bare or `Self` name), the instances imported libraries
 *  export (`<Alias>.<name>`), and every declaration by the module that declared
 *  it (a shape named in a dependency's contract). */
export interface RefResolution {
  readonly local: NameResolution;
  readonly exported: NameResolution;
  readonly declared: NameResolution;
}

/** A {@link NameResolution} answered by a resolver over a list. */
export function resolutionOver(resolver: ScopedNameResolver<ResourceManifest>): NameResolution {
  return {
    locate: (name, fromModule, within, accept) => outcomeOf(resolver.locate(name, fromModule, within, accept)),
    inModule: (name, module, importPath) => {
      const declaration = resolver.inModule(name, module, importPath);
      return declaration === undefined
        ? UNRESOLVED
        : outcomeOf({ declaration, address: scopeAddress(module, name) });
    },
    declareScope: (site, members) => resolver.declareScope(site, members),
  };
}

/** Every named declaration of `manifests` as one population. */
export function namesResolution(manifests: readonly ResourceManifest[]): NameResolution {
  return resolutionOver(new ScopedNameResolver(manifests, MANIFEST_READING));
}

/**
 * The full-list resolution `!ref` resolution reads: `resources` resolve a bare
 * name (a dependency's forwarded code excluded), their forwarded exports and
 * `crossModuleTargets`' an aliased one, and every one of `resources` a shape a
 * dependency's contract names.
 */
export function listResolution(
  resources: readonly ResourceManifest[],
  crossModuleTargets: readonly ResourceManifest[] = [],
): RefResolution {
  const local: ResourceManifest[] = [];
  const exported: ResourceManifest[] = [];
  const declared: ResourceManifest[] = [];
  for (const r of resources) {
    if (!r.metadata?.name || isKindDocumentOrImport(r)) continue;
    declared.push(r);
    if (!isForwardedDeclaration(r)) local.push(r);
    else if (isForwardedExport(r)) exported.push(r);
  }
  for (const r of crossModuleTargets) {
    if (!r.metadata?.name || isKindDocumentOrImport(r) || !isForwardedExport(r)) continue;
    exported.push(r);
  }
  return {
    local: namesResolution(local),
    exported: namesResolution(exported),
    declared: namesResolution(declared),
  };
}

/**
 * What a `{ name, alias? }` reference written in `fromModule` (inside `within`
 * when given) names — `resolveReference`'s rule over a {@link NameResolution}:
 * a bare name, or one through `Self`, the scoped read; one through an import
 * alias, the module-level declaration of the module that alias reaches in
 * `fromModule`'s own alias table, of the instance `writer`'s import reaches.
 */
export function resolveReferenceOutcome(
  resolution: NameResolution,
  ref: { readonly name: string; readonly alias?: string },
  fromModule: string | undefined,
  moduleForAlias: (alias: string) => string | undefined,
  within?: ScopeSite,
  writer?: unknown,
): ResolutionOutcome {
  if (ref.alias === undefined || ref.alias === "Self") return resolution.locate(ref.name, fromModule, within);
  const target = moduleForAlias(ref.alias);
  return target === undefined
    ? UNRESOLVED
    : resolution.inModule(ref.name, target, importPathThrough(writer, ref.alias));
}
