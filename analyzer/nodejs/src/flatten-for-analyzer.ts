import type { ResourceManifest } from "@telorun/sdk";
import type { LoadedGraph, LoadedModule } from "./loaded-types.js";
import type { LoadedFile } from "./loaded-types.js";
import { isModuleKind } from "./module-kinds.js";

/** One parsed `exports.resources` / `exports.kinds` entry. `name` is the exported
 *  instance name or kind suffix (the part after the dot, or the whole entry); `alias`
 *  (when set) is this library's own import the entry RE-EXPORTS from. */
export interface ParsedExportEntry {
  name: string;
  alias?: string;
}

/** Parse a single dotted export entry: `Alias.Name` → `{name: "Name", alias: "Alias"}`,
 *  bare `Name` → `{name: "Name"}`. The single grammar for `exports.resources` and
 *  `exports.kinds`, shared by the kernel's import controller and the analyzer/editor so
 *  the dotted-name split can't drift. A leading dot (`.Name`) has no alias by design —
 *  the empty prefix isn't a valid alias. */
export function parseExportEntry(entry: string): ParsedExportEntry {
  const dot = entry.indexOf(".");
  return dot > 0 ? { name: entry.slice(dot + 1), alias: entry.slice(0, dot) } : { name: entry };
}

/** The import-boundary forwarding rule, shared by `flattenForAnalyzer` (the
 *  CLI / kernel loader path) and the telo-editor's workspace projection so the
 *  two cannot drift. Given one module's stamped manifests and whether that
 *  module is the analysis entry (root), returns the manifests that cross into
 *  the consumer's flat analysis list:
 *
 *  - **Root module** — every manifest is local; returned unchanged. The root's
 *    internals (CEL / schema / refs) are validated in full.
 *  - **Imported module** — only `Telo.Definition` / `Telo.Abstract` /
 *    `Telo.Import` docs cross unconditionally, plus the instances named in the
 *    module's `exports.resources` (stamped `metadata.forwardedExport: true`).
 *    The module doc and internal (unexported) instances are dropped — they
 *    belong to that module's own analysis pass.
 *
 *  `forwardedExport` marks an instance as a cross-module resolution TARGET only
 *  (keyed by `metadata.module`), so `resolveRefSentinels` files it under
 *  `byModuleName` and `!ref Alias.name` resolves, while `validate-references` /
 *  the per-resource validation loop never re-walk or re-validate it against the
 *  consumer's scope. A consumer that instead emits every module doc as a peer
 *  local manifest silently breaks both. */
export function selectModuleManifestsForAnalysis(
  moduleManifests: ResourceManifest[],
  isRoot: boolean,
): ResourceManifest[] {
  if (isRoot) return moduleManifests;

  const libDoc = moduleManifests.find((m) => isModuleKind(m.kind));
  // An `exports.resources` entry is a bare name or a dotted `Alias.Name` (re-export). Only the
  // export NAME matches a local instance below; re-exports are forwarded by `forwardReExports`.
  const exportedResources = new Set<string>();
  for (const entry of (libDoc as { exports?: { resources?: unknown[] } } | undefined)?.exports
    ?.resources ?? []) {
    if (typeof entry !== "string") continue;
    exportedResources.add(parseExportEntry(entry).name);
  }

  const out: ResourceManifest[] = [];
  for (const m of moduleManifests) {
    if (m.kind === "Telo.Definition" || m.kind === "Telo.Abstract" || m.kind === "Telo.Import") {
      out.push(m);
    } else if (
      !isModuleKind(m.kind) &&
      typeof m.metadata?.name === "string" &&
      exportedResources.has(m.metadata.name as string)
    ) {
      out.push({
        ...m,
        metadata: { ...m.metadata, forwardedExport: true } as ResourceManifest["metadata"],
      });
    }
  }
  return out;
}

/** Produce the flat manifest list `analyze()` consumes today.
 *
 *  Combines the entry module's manifests with `Telo.Definition`,
 *  `Telo.Abstract`, and `Telo.Import` docs forwarded from imported libraries
 *  (plus their `exports.resources` instances) via `selectModuleManifestsForAnalysis`.
 *  Stamps three flavours of metadata along the way:
 *
 *  - `metadata.source` and `metadata.sourceLine` — already on each manifest
 *    from `parseLoadedFile`, copied here unchanged.
 *  - `metadata.module` — the owning module's `Telo.Application` /
 *    `Telo.Library` `metadata.name`, applied to non-module manifests that
 *    don't already carry one.
 *  - `metadata.resolvedModuleName` / `metadata.resolvedNamespace` — for every
 *    `Telo.Import` manifest, looked up via `graph.importEdges` to find the
 *    target module's own `Telo.Library` identity. Without this, the
 *    analyzer's alias resolver and `validate-extends` fall back to
 *    path-derived identity and produce spurious diagnostics.
 *
 *  Position metadata (`positionIndex`) is NOT stamped on manifests —
 *  callers look it up via `findPositions(graph, ...)` on the LoadedGraph. */
export function flattenForAnalyzer(graph: LoadedGraph): ResourceManifest[] {
  const result: ResourceManifest[] = [];

  result.push(...selectModuleManifestsForAnalysis(collectModuleManifests(graph.entry), true));

  const seen = new Set<string>([graph.rootSource]);
  const queue: string[] = [graph.rootSource];

  while (queue.length > 0) {
    const fromSource = queue.shift()!;
    const edges = graph.importEdges.get(fromSource);
    if (!edges) continue;

    for (const edge of edges.values()) {
      if (seen.has(edge.targetSource)) continue;
      seen.add(edge.targetSource);
      queue.push(edge.targetSource);

      const targetModule = graph.modules.get(edge.targetSource);
      if (!targetModule) continue;

      result.push(...selectModuleManifestsForAnalysis(collectModuleManifests(targetModule), false));
    }
  }

  forwardReExports(graph, result);

  // Stamp resolved import identity on every Telo.Import in the result by
  // reading the edge's pre-resolved name/namespace — no re-derivation from
  // manifest metadata. The edge is keyed by (owner-file, alias) which is
  // exactly the (metadata.source, metadata.name) pair on each Telo.Import.
  for (let i = 0; i < result.length; i++) {
    const m = result[i];
    if (m.kind !== "Telo.Import") continue;
    const owner = (m.metadata as { source?: string } | undefined)?.source;
    const alias = m.metadata?.name as string | undefined;
    if (!owner || !alias) continue;
    const edge = graph.importEdges.get(owner)?.get(alias);
    if (!edge?.targetModuleName) continue;

    const newMetadata: Record<string, unknown> = {
      ...m.metadata,
      resolvedModuleName: edge.targetModuleName,
      resolvedNamespace: edge.targetNamespace,
    };
    result[i] = { ...m, metadata: newMetadata as ResourceManifest["metadata"] };
  }

  return result;
}

/** A re-export declared in a library's `exports.resources` as a dotted `Alias.Name`:
 *  module `module` re-exports the instance `name` reached through its own import
 *  aliased `alias`. */
export interface ReExportSpec {
  module: string;
  alias: string;
  name: string;
}

/** Extract re-export specs from a library doc's `exports.resources` — the dotted `Alias.Name`
 *  entries (bare-name locals are forwarded by the BFS instead). Shared by the CLI graph path
 *  and the editor's workspace projection so the two cannot drift. */
export function reExportSpecsFromExports(
  moduleName: string,
  exportsResources: readonly unknown[] | undefined,
): ReExportSpec[] {
  const specs: ReExportSpec[] = [];
  for (const entry of exportsResources ?? []) {
    if (typeof entry !== "string") continue;
    const { name, alias } = parseExportEntry(entry);
    if (!alias || alias === "Self") continue;
    specs.push({ module: moduleName, alias, name });
  }
  return specs;
}

/** Forward re-exported instances (`exports.resources: [!ref Alias.name]`) transitively so a
 *  consumer's `!ref Consumer.name` resolves in `resolveRefSentinels` (keyed by the RE-EXPORTING
 *  module). The owning instance is already forwarded under its own module; here we emit an
 *  additional copy stamped under each re-exporting module, with an already-canonical kind. A
 *  fixpoint loop forwards chains of arbitrary depth (`app → api → domain → …`): each pass can
 *  resolve a re-export whose source was emitted in a prior pass. Graph-agnostic: `aliasToModule`
 *  maps `(module, alias)` to the imported module's name. Mutates `result` in place. */
export function forwardReExportManifests(
  result: ResourceManifest[],
  specs: readonly ReExportSpec[],
  aliasToModule: (module: string, alias: string) => string | undefined,
): void {
  // Index forwarded instances by `module\0name` (only re-export TARGETS are forwarded).
  const forwarded = new Map<string, ResourceManifest>();
  for (const m of result) {
    const meta = m.metadata as { module?: string; name?: string; forwardedExport?: boolean };
    if (meta?.forwardedExport && meta.module && meta.name) {
      forwarded.set(`${meta.module}\0${meta.name}`, m);
    }
  }

  // Canonicalize an authored/forwarded kind to a scope-independent `<module>.<Kind>` using the
  // owning module's own import aliases. Idempotent: an already-canonical kind whose prefix isn't
  // an alias of `ownerModule` is returned unchanged, so re-exports of re-exports stay stable.
  const canonicalKind = (kind: string, ownerModule: string): string => {
    if (kind.startsWith("Self.")) return `${ownerModule}.${kind.slice("Self.".length)}`;
    const dot = kind.indexOf(".");
    if (dot <= 0) return kind;
    const target = aliasToModule(ownerModule, kind.slice(0, dot));
    return target ? `${target}.${kind.slice(dot + 1)}` : kind;
  };

  // Fixpoint — bounded by the number of specs (each can be satisfied at most once).
  for (let pass = 0; pass <= specs.length; pass++) {
    let added = false;
    for (const spec of specs) {
      const key = `${spec.module}\0${spec.name}`;
      if (forwarded.has(key)) continue;
      const sourceModule = aliasToModule(spec.module, spec.alias);
      if (!sourceModule) continue;
      const src = forwarded.get(`${sourceModule}\0${spec.name}`);
      if (!src) continue; // source not forwarded yet — a later pass may satisfy it
      const kind = canonicalKind(src.kind as string, sourceModule);
      const manifest: ResourceManifest = {
        ...src,
        kind,
        metadata: {
          ...src.metadata,
          name: spec.name,
          module: spec.module,
          forwardedExport: true,
        } as ResourceManifest["metadata"],
      };
      result.push(manifest);
      forwarded.set(key, manifest);
      added = true;
    }
    if (!added) break;
  }
}

/** Resolve every library's `exports.kinds` to a per-module map `suffix → canonical
 *  <owningModule>.<Kind>`, following re-exports (`Alias.Kind`) transitively via a fixpoint.
 *  `modules` lists each library's name + its raw `exports.kinds`; `aliasToModule(module, alias)`
 *  maps one of that module's import aliases to the imported module's name. Graph-agnostic —
 *  shared by the CLI graph path and the editor's workspace projection. */
export function resolveExportedKinds(
  modules: ReadonlyArray<{ module: string; exportsKinds: readonly string[] }>,
  aliasToModule: (module: string, alias: string) => string | undefined,
): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const tableFor = (m: string): Map<string, string> => {
    let t = out.get(m);
    if (!t) out.set(m, (t = new Map()));
    return t;
  };
  for (let pass = 0; pass <= modules.length; pass++) {
    let changed = false;
    for (const { module, exportsKinds } of modules) {
      const table = tableFor(module);
      for (const entry of exportsKinds) {
        const { name: suffix, alias } = parseExportEntry(entry);
        if (table.has(suffix)) continue;
        if (!alias) {
          table.set(suffix, `${module}.${suffix}`);
          changed = true;
          continue;
        }
        const source = aliasToModule(module, alias);
        const canonical = source ? out.get(source)?.get(suffix) : undefined;
        if (canonical) {
          table.set(suffix, canonical);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return out;
}

/** Stamp `metadata.reExportedKinds` (suffix → canonical kind) onto every `Telo.Import` whose
 *  target re-exports kinds, so the analyzer can register the re-export mappings. Only entries
 *  that point at a module OTHER than the import's own target are stamped (genuine re-exports;
 *  a locally-defined kind resolves through the normal alias path). Stamped on `metadata` (which
 *  permits additional properties, like `resolvedModuleName`) since the `Telo.Import` schema
 *  forbids extra top-level fields. Shared by both paths. */
export function stampReExportedKinds(
  imports: ReadonlyArray<{ manifest: ResourceManifest; targetModule: string }>,
  exportedKinds: Map<string, Map<string, string>>,
): void {
  for (const { manifest, targetModule } of imports) {
    const table = exportedKinds.get(targetModule);
    if (!table) continue;
    const reExported: Record<string, string> = {};
    for (const [suffix, canonical] of table) {
      if (canonical !== `${targetModule}.${suffix}`) reExported[suffix] = canonical;
    }
    if (Object.keys(reExported).length === 0) continue;
    (manifest.metadata as Record<string, unknown>).reExportedKinds = reExported;
  }
}

/** CLI/kernel adapter: collect re-export specs + alias map from a LoadedGraph. */
function forwardReExports(graph: LoadedGraph, result: ResourceManifest[]): void {
  const ownerSourceOf = new Map<string, string>();
  const specs: ReExportSpec[] = [];
  const kindModules: Array<{ module: string; exportsKinds: string[] }> = [];
  for (const [source, mod] of graph.modules) {
    if (source === graph.rootSource) continue; // root is an Application — no exports
    const libDoc = mod.owner.manifests.find((m) => m && isModuleKind(m.kind)) as
      | (ResourceManifest & { exports?: { resources?: unknown[]; kinds?: string[] } })
      | undefined;
    const moduleName = libDoc?.metadata?.name as string | undefined;
    if (!libDoc || !moduleName) continue;
    ownerSourceOf.set(moduleName, mod.owner.source);
    specs.push(...reExportSpecsFromExports(moduleName, libDoc.exports?.resources));
    kindModules.push({ module: moduleName, exportsKinds: libDoc.exports?.kinds ?? [] });
  }
  const aliasToModule = (module: string, alias: string): string | undefined => {
    const ownerSource = ownerSourceOf.get(module);
    return ownerSource
      ? (graph.importEdges.get(ownerSource)?.get(alias)?.targetModuleName ?? undefined)
      : undefined;
  };
  forwardReExportManifests(result, specs, aliasToModule);

  // Resolve every library's re-exported kinds and stamp them onto the consumer-facing
  // Telo.Import manifests so the analyzer can register the re-export mappings.
  const exportedKinds = resolveExportedKinds(kindModules, aliasToModule);
  const imports: Array<{ manifest: ResourceManifest; targetModule: string }> = [];
  for (const m of result) {
    if (m.kind !== "Telo.Import") continue;
    const owner = (m.metadata as { source?: string } | undefined)?.source;
    const alias = m.metadata?.name as string | undefined;
    const target = owner && alias ? graph.importEdges.get(owner)?.get(alias)?.targetModuleName : undefined;
    if (target) imports.push({ manifest: m, targetModule: target });
  }
  stampReExportedKinds(imports, exportedKinds);
}

/** Project a LoadedModule (owner + partials) to a flat ResourceManifest[]
 *  with `metadata.module` stamped on non-module docs. The kernel's runtime
 *  entry load uses this to convert a `Loader.loadModule` result into the
 *  classic ResourceManifest[] shape it iterates over. Imports are not
 *  followed — the kernel's import-controller loads each import's module
 *  separately at runtime. */
export function flattenLoadedModule(mod: LoadedModule): ResourceManifest[] {
  return collectModuleManifests(mod);
}

function collectModuleManifests(mod: LoadedModule): ResourceManifest[] {
  const owner = stampFile(mod.owner, ownerModuleName(mod.owner));
  const partials: ResourceManifest[] = [];
  for (const p of mod.partials) {
    partials.push(...stampFile(p, ownerModuleName(mod.owner)));
  }
  return [...owner, ...partials];
}

function ownerModuleName(file: LoadedFile): string | undefined {
  for (const m of file.manifests) {
    if (m && isModuleKind(m.kind)) {
      const name = m.metadata?.name;
      if (typeof name === "string") return name;
    }
  }
  return undefined;
}

function stampFile(
  file: LoadedFile,
  ownerModule: string | undefined,
): ResourceManifest[] {
  const out: ResourceManifest[] = [];
  for (let i = 0; i < file.manifests.length; i++) {
    const m = file.manifests[i];
    if (m === null || m === undefined) continue;
    const { sourceLine } = file.positions[i];

    const metadata: Record<string, unknown> = {
      ...m.metadata,
      source: file.source,
      sourceLine,
    };
    if (ownerModule && !isModuleKind(m.kind) && !metadata.module) {
      metadata.module = ownerModule;
    }

    out.push({ ...m, metadata: metadata as ResourceManifest["metadata"] });
  }
  return out;
}
