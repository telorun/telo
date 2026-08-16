/**
 * The module-owned libraries a module's controller bundles import by bare
 * specifier, resolved to the artifacts that carry them.
 *
 * A bundle imports `@telorun/kv-store`; the manifest declares the dependency as
 * `KvStore: ../kv-store`; the target module's own `library:` block says that its
 * `js` entry point is what `@telorun/kv-store` means. This type is the joined
 * result — computed once per module during `kernel.load()`, where the import
 * graph and every module's artifact are both in hand, and handed to the loader.
 *
 * It is deliberately **not** something the loader derives for itself. Resolution
 * needs the import edges (which module is `KvStore`), the target's manifest (what
 * specifier it declares) and the target's artifact (where its layer is); a loader
 * sees one canonical base URI and none of those.
 */

import type { ArtifactSelector, LoadedGraph } from "@telorun/analyzer";
import type { Logger } from "@telorun/sdk";
import type { ModuleArtifact } from "../bundle/module-artifact.js";
import type { OwnerManifest } from "../bundle/module-manifest.js";

export interface ResolvedSiblingLibrary {
  /** The bare specifier a consumer's bundle imports this library by. */
  readonly specifier: string;
  /** The selector of the library candidate — matched against the consuming
   *  candidate's own, so a `js` bundle resolves the `js` entry point. */
  readonly selector: ArtifactSelector;
  /** Module-root-relative built entry point. */
  readonly path: string;
  /** Module-root-relative TypeScript source, when the target declares one and is
   *  a working copy. */
  readonly localPath?: string;
  /** The owning module's directory: where its layers extract to, or where it
   *  simply sits on disk. `undefined` for a module whose payload has no local
   *  home (a `memory://` manifest), which makes the specifier unresolvable and
   *  is reported as such rather than guessed at. */
  readonly moduleDir: string | undefined;
  /** The owning module's artifact, when it ships one. Absent for a working copy,
   *  which is what selects the build-from-source path. */
  readonly artifact: ModuleArtifact | undefined;
  /** Canonical source URL of the owning module — diagnostics, and the key the
   *  loader reports a version skew against. */
  readonly moduleSource: string;
  /** The owning module's declared version, for the skew report. */
  readonly moduleVersion: string | undefined;
  /** The owning module's OWN sibling libraries. Building a library entry from
   *  source is the same build as building a controller from source, so it needs
   *  the same externals — `kv-store-sql`'s bundle externalizes `@telorun/sql`,
   *  and building `@telorun/sql`'s entry point in turn needs sql's own. Held as
   *  a live reference and filled in a second pass, so an import cycle cannot
   *  make construction recurse. */
  readonly libraries: SiblingLibraryMap;
}

/** Every sibling library one module's bundles may import, by specifier. */
export type SiblingLibraryMap = ReadonlyMap<string, ResolvedSiblingLibrary>;

/** What a controller loader is handed: the libraries of the module that declared
 *  the candidate being resolved. Empty for a module that imports none. */
export const NO_SIBLING_LIBRARIES: SiblingLibraryMap = new Map();

/** What the join needs from the kernel: the already-parsed owner manifests, the
 *  artifacts built from them, and where each module's files live. Passed in
 *  rather than reached for, so the join is a pure function of the graph and is
 *  testable without booting a kernel. */
export interface SiblingLibraryInputs {
  /** Owner manifest per module source. Parsed once in `load()` and shared with
   *  artifact construction — re-reading here would parse every target's whole
   *  `telo.yaml` again, once per import edge, on the boot path. */
  readonly ownerManifests: ReadonlyMap<string, OwnerManifest>;
  readonly artifactFor: (source: string) => ModuleArtifact | undefined;
  readonly directoryFor: (source: string) => string | undefined;
  readonly log?: Logger;
}

/**
 * Join the import graph to each target's declared library entry point, so a
 * controller bundle's bare `@telorun/kv-store` resolves to the module that owns
 * it instead of being copied into the bundle.
 *
 * Called from `kernel.load()` for the same reason the artifacts are built there:
 * that is the only point where all three halves are in hand — which module an
 * alias names (`importEdges`), what specifier that module declares (`library:` on
 * its owner doc), and where its payload lives. A controller loader sees one
 * canonical base URI and none of them. The join itself is pure, so it lives here
 * beside the model rather than in the orchestrator.
 *
 * Keyed by canonical module source, so a definition's `metadata.source` finds the
 * libraries of the module that DECLARED it — never the consumer's. An import edge
 * declared in an `include:` partial is attributed to the module that owns the
 * partial, since the resulting bundle is that module's.
 *
 * Version skew is reported, not prevented: two dependents pinning different
 * versions of one library legitimately resolve two copies, and two module scopes.
 * That is different code, so it is correct — but a shared-state seam that assumed
 * one scope would break silently, which is what the warning is for.
 */
export function buildSiblingLibraries(
  graph: LoadedGraph,
  inputs: SiblingLibraryInputs,
): Map<string, SiblingLibraryMap> {
  // Which module owns each loaded file, so an import declared in a partial is
  // attributed to its module.
  const ownerOf = new Map<string, string>();
  for (const [, module] of graph.modules) {
    ownerOf.set(module.owner.source, module.owner.source);
    for (const partial of module.partials) ownerOf.set(partial.source, module.owner.source);
  }

  // Two passes, so an import cycle cannot make construction recurse: every module
  // gets its (mutable) map first, and each entry then holds a live reference to
  // its target's map rather than a copy built inline.
  const maps = new Map<string, Map<string, ResolvedSiblingLibrary>>();
  for (const [, module] of graph.modules) {
    if (!maps.has(module.owner.source)) maps.set(module.owner.source, new Map());
  }

  /** The module first seen behind each specifier, and the specifiers already
   *  reported as skewed — so one shared library resolved at two versions is one
   *  warning, not one per consumer that imports it. */
  const claimed = new Map<string, { source: string; version: string | undefined }>();
  const reported = new Set<string>();

  for (const [declaringFile, edges] of graph.importEdges) {
    const map = maps.get(ownerOf.get(declaringFile) ?? declaringFile);
    if (!map) continue;
    for (const [, edge] of edges) {
      const target = graph.modules.get(edge.targetSource);
      if (!target) continue;
      const owner = inputs.ownerManifests.get(target.owner.source);
      if (!owner || owner.library.length === 0) continue;
      const moduleDir = inputs.directoryFor(target.owner.source);
      for (const candidate of owner.library) {
        const previous = claimed.get(candidate.specifier);
        if (!previous) {
          claimed.set(candidate.specifier, {
            source: target.owner.source,
            version: owner.version,
          });
        } else if (previous.source !== target.owner.source && !reported.has(candidate.specifier)) {
          reported.add(candidate.specifier);
          inputs.log?.warn(
            `shared module library '${candidate.specifier}' resolves to two modules in this ` +
              `graph, so it runs as two module scopes. A seam that must share state across them ` +
              `has to say so — the honest granularity is the import pin.`,
            {
              "telo.library.specifier": candidate.specifier,
              "telo.library.source": target.owner.source,
              "telo.library.version": owner.version ?? "",
              "telo.library.other_source": previous.source,
              "telo.library.other_version": previous.version ?? "",
            },
          );
        }
        map.set(candidate.specifier, {
          specifier: candidate.specifier,
          selector: candidate.selector,
          path: candidate.path,
          ...(candidate.localPath ? { localPath: candidate.localPath } : {}),
          moduleDir,
          artifact: inputs.artifactFor(target.owner.source),
          moduleSource: target.owner.source,
          moduleVersion: owner.version,
          libraries: maps.get(target.owner.source) ?? new Map(),
        });
      }
    }
  }

  return maps;
}
