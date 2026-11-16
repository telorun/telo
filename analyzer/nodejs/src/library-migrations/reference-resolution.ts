/**
 * What every `!ref` of one module instance resolves to, read as analysis reads
 * a name: through the scoped name resolver, scope first innermost out — a
 * `with:` member, a template body's entries — then the module's own named
 * declarations. A reference a member of the same name shadows resolves to that
 * member, never to the module-level declaration. The stage resolves by
 * position, not by comparing names.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { isExpansionSentinel } from "@telorun/templating";
import type { DefinitionRegistry } from "../definition-registry.js";
import type { NamedShapeLookup } from "../eval-paths.js";
import { isKindDocument } from "../kind-declaration.js";
import { filesOf, moduleNameOf } from "../loaded-kind-scope.js";
import type { LoadedFile, LoadedModule } from "../loaded-types.js";
import { isModuleKind } from "../module-kinds.js";
import { refSentinelTarget } from "../ref-sentinel-target.js";
import { nestedAddress, type WalkHolder } from "../resolve-ref-sentinels.js";
import { scopeAddress, type ScopeAddress } from "../scope-address.js";
import { declaredScopes, scopeMembers, type DeclaredScope } from "../scope-declarations.js";
import { ScopedNameResolver, scopeSiteAt, type DeclarationReading } from "../scoped-name-resolver.js";
import { templateBodyEntries } from "../template-body.js";
import { isMigrationMap } from "./match.js";

/** What the stage lends the resolution: kind identities and the reach of a kind. */
export interface ReferenceReachSource {
  readonly defs: DefinitionRegistry;
  /** The named-shape lookup read off the graph, so the reach sees what analysis sees. */
  readonly shapeLookup: NamedShapeLookup;
  kindIdentity(written: string): { moduleName: string; name: string } | undefined;
}

/** A declaration a `!ref` may resolve to. */
export interface ReferenceTarget {
  readonly name: string;
  /** A named top-level document of the module, never a scope member. */
  readonly topLevel: boolean;
  readonly file: LoadedFile;
  readonly document: number;
}

/** One `!ref` of the module and what it resolves to; undefined when it names
 *  nothing of the module (a foreign reference, or no declaration). */
export interface ResolvedModuleReference {
  readonly file: LoadedFile;
  readonly document: number;
  readonly path: readonly (string | number)[];
  /** The name the `!ref` is written with. */
  readonly name: string;
  readonly target: ReferenceTarget | undefined;
}

/** The synthetic scope a template body's entries are: every position of its
 *  document reads them first. */
function templateScope(doc: ResourceManifest): DeclaredScope {
  return {
    path: "resources",
    keys: ["resources"],
    declarations: Array.isArray((doc as Record<string, unknown>).resources) ? ((doc as Record<string, unknown>).resources as unknown[]) : [],
    regions: [[]],
    openedByDispatch: false,
  };
}

/** Every `!ref` of `mod`, in document order, each with its resolution. */
export function resolveModuleReferences(mod: LoadedModule, source: ReferenceReachSource): ResolvedModuleReference[] {
  const moduleName = moduleNameOf(mod);
  const topLevel: ReferenceTarget[] = [];
  for (const file of filesOf(mod)) {
    file.manifests.forEach((doc, document) => {
      const name = doc?.metadata?.name;
      if (!doc || typeof name !== "string" || typeof doc.kind !== "string") return;
      if (isModuleKind(doc.kind) || doc.kind === "Telo.Import" || isKindDocument(doc)) return;
      topLevel.push({ name, topLevel: true, file, document });
    });
  }
  const reading: DeclarationReading<ReferenceTarget> = { nameOf: (d) => d.name, moduleOf: () => moduleName };
  const names = new ScopedNameResolver(topLevel, reading);
  const out: ResolvedModuleReference[] = [];

  const scopesOf = (obj: Record<string, unknown>): readonly DeclaredScope[] => {
    if (isKindDocument(obj)) return [templateScope(obj as ResourceManifest)];
    const identity = typeof obj.kind === "string" ? source.kindIdentity(obj.kind) : undefined;
    if (!identity) return [];
    const resource = { kind: `${identity.moduleName}.${identity.name}` } as ResourceManifest;
    return declaredScopes(source.defs.referenceSites(resource, undefined, undefined, obj as ResourceManifest, source.shapeLookup));
  };

  const holderFor = (file: LoadedFile, document: number, obj: Record<string, unknown>, address: ScopeAddress): WalkHolder => {
    const scopes = scopesOf(obj);
    for (const scope of scopes) {
      const members = scopeMembers(scope).map((m) => ({ name: m.metadata.name, topLevel: false, file, document }));
      names.declareScope({ holder: address, field: scope.path }, members);
    }
    return { address, scopes };
  };

  const walk = (
    file: LoadedFile,
    document: number,
    value: unknown,
    path: readonly (string | number)[],
    holder: WalkHolder | undefined,
    keys: (string | number)[],
  ): void => {
    const ref = refSentinelTarget(value);
    if (ref) {
      const own = ref.alias === undefined || ref.alias === "Self" || ref.alias === moduleName;
      if (own) {
        const within = holder ? scopeSiteAt(holder.address, holder.scopes, keys) : undefined;
        out.push({ file, document, path, name: ref.name, target: names.resolve(ref.name, moduleName, within) });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        keys.push(i);
        walk(file, document, item, [...path, i], holder, keys);
        keys.pop();
      });
      return;
    }
    if (!isMigrationMap(value) && !isExpansionSentinel(value)) return;
    const obj = value as Record<string, unknown>;
    if (typeof obj.kind === "string" && (holder || path.length === 0)) {
      const doc = path.length === 0;
      const name = (obj.metadata as { name?: unknown } | undefined)?.name;
      const address = doc
        ? scopeAddress(moduleName, typeof name === "string" ? name : `${file.source}#${document}`)
        : nestedAddress(holder!, keys, obj);
      const inner = holderFor(file, document, obj, address);
      for (const [key, child] of Object.entries(obj)) walk(file, document, child, [...path, key], inner, [key]);
      return;
    }
    for (const [key, child] of Object.entries(obj)) {
      keys.push(key);
      walk(file, document, child, [...path, key], holder, keys);
      keys.pop();
    }
  };

  for (const file of filesOf(mod)) {
    file.manifests.forEach((doc, document) => {
      if (!doc || document >= file.documents.length) return;
      walk(file, document, doc, [], undefined, []);
    });
  }
  return out;
}
