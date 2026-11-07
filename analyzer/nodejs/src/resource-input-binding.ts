import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import { moduleAliasScope } from "./module-alias-scope.js";
import { refSentinelTarget } from "./ref-sentinel-target.js";
import { isResolvedReference } from "./resolved-reference.js";
import { readSuppliedResources } from "./resource-input.js";

/**
 * What a library's RESOURCE INPUT names in one module instance: the declaration
 * its importer supplied for it, followed through every library that forwards
 * an input of its own (`resources: { connection: !ref connection }`), since a
 * borrowed instance is the importer's declaration and never a copy of it.
 *
 * Read off the flattened set, where a library's forwarded declarations carry
 * their instance's import path (`metadata.importPath`, when the library is
 * imported as several instances) and each `Telo.Import` carries the inputs its
 * target declares (`metadata.requiredResources`, `metadata.optionalResources`).
 * A library analysed as the entry has no importer: its input is the injected
 * stand-in, which the caller's own name lookup already finds.
 *
 * Browser-safe.
 */

/** How the binding finds a declaration among the caller's nodes. */
export interface InputBindingLookup<T> {
  /** The module-level declaration `name` of `module` read in the instance at
   *  `importPath` (undefined for the analysed modules' own). */
  inModule(name: string, module: string, importPath: readonly string[] | undefined): T | undefined;
}

/** `name` is no resource input of the module it was read in. */
export const NOT_AN_INPUT: unique symbol = Symbol("not-an-input");

export interface ResourceInputBinding<T> {
  /**
   * The declaration resource input `name` of `module` names in the instance at
   * `importPath`, undefined when it names none — an omitted optional input, a
   * supply that does not resolve, or two importers of one instance supplying
   * different declarations — or {@link NOT_AN_INPUT} when no import in the set
   * says `module` declares such an input (an analysed library's own input is
   * then its stand-in).
   */
  bound(name: string, module: string | undefined, importPath: readonly string[] | undefined): T | undefined | typeof NOT_AN_INPUT;
}

const declaringModule = (m: ResourceManifest): string | undefined =>
  (m.metadata as { module?: string } | undefined)?.module;

export function resourceInputBinding<T>(
  manifests: readonly ResourceManifest[],
  lookup: InputBindingLookup<T>,
  aliases: AliasResolver,
  aliasesByModule: ReadonlyMap<string, AliasResolver>,
): ResourceInputBinding<T> {
  const importsOf = new Map<string, ResourceManifest[]>();
  const inputs = new Set<string>();
  const key = (module: string, name: string) => `${module}\0${name}`;
  for (const m of manifests) {
    if (m.kind !== "Telo.Import") continue;
    const meta = m.metadata as {
      resolvedModuleName?: unknown;
      requiredResources?: Record<string, unknown>;
    };
    if (typeof meta.resolvedModuleName !== "string") continue;
    const module = meta.resolvedModuleName;
    const list = importsOf.get(module);
    if (list) list.push(m);
    else importsOf.set(module, [m]);
    for (const name of Object.keys(meta.requiredResources ?? {})) inputs.add(key(module, name));
  }

  const resolveIn = (
    value: unknown,
    module: string | undefined,
    importPath: readonly string[] | undefined,
    seen: ReadonlySet<string>,
  ): T | undefined => {
    const target = refSentinelTarget(value) ?? (isResolvedReference(value) ? value : undefined);
    if (!target || module === undefined) return undefined;
    if (target.alias === undefined || target.alias === "Self") {
      const forwarded = bindingOf(target.name, module, importPath, seen);
      if (forwarded !== NOT_AN_INPUT) return forwarded;
      return lookup.inModule(target.name, module, importPath);
    }
    const reached = moduleAliasScope({ module }, aliases, aliasesByModule).moduleForAlias(target.alias);
    return reached === undefined
      ? undefined
      : lookup.inModule(target.name, reached, [...(importPath ?? []), target.alias]);
  };

  const bindingOf = (
    name: string,
    module: string | undefined,
    importPath: readonly string[] | undefined,
    seen: ReadonlySet<string>,
  ): T | undefined | typeof NOT_AN_INPUT => {
    if (module === undefined || !inputs.has(key(module, name))) return NOT_AN_INPUT;
    const visit = `${module}\0${(importPath ?? []).join("/")}\0${name}`;
    if (seen.has(visit)) return undefined;
    const within = new Set([...seen, visit]);
    const reaching = importPath?.at(-1);
    // A `shared` library's instance is named by the library itself, so any of
    // its imports may be the one that supplied it.
    const shared = reaching === module;
    const candidates = (importsOf.get(module) ?? []).filter(
      (m) => shared || reaching === undefined || m.metadata?.name === reaching,
    );
    if (candidates.length === 0) return undefined;
    const importerPath = shared || !importPath || importPath.length <= 1 ? undefined : importPath.slice(0, -1);
    let found: T | undefined;
    for (const candidate of candidates) {
      const supplied = readSuppliedResources(candidate)[name];
      const declaration =
        supplied === undefined ? undefined : resolveIn(supplied, declaringModule(candidate), importerPath, within);
      if (declaration === undefined) return undefined;
      if (found !== undefined && found !== declaration) return undefined;
      found = declaration;
    }
    return found;
  };

  return {
    bound: (name, module, importPath) => bindingOf(name, module, importPath, new Set()),
  };
}
