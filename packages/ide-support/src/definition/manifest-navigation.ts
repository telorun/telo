import type { LoadedFile, LoadedGraph, LoadedModule, Range } from "@telorun/analyzer";
import type { DefinitionResult } from "../types.js";

/** The shape every navigation lookup reads off a `LoadedFile.manifests` entry.
 *  Narrower than `ResourceManifest` on purpose — navigation only ever asks what
 *  kind a doc is and what it is named. */
export interface NavigableManifest {
  kind?: string;
  metadata?: { name?: string };
}

const MODULE_DOC_KINDS = new Set(["Telo.Application", "Telo.Library"]);
const KIND_DOC_KINDS = new Set(["Telo.Definition", "Telo.Abstract"]);

/** The module whose owner or partials includes `filePath`. */
export function moduleForFile(graph: LoadedGraph, filePath: string): LoadedModule | undefined {
  for (const mod of graph.modules.values()) {
    if (mod.owner.source === filePath) return mod;
    if (mod.partials.some((p) => p.source === filePath)) return mod;
  }
  return undefined;
}

/** Every file in a module's scope, owner first. */
export function moduleFiles(mod: LoadedModule): LoadedFile[] {
  return [mod.owner, ...mod.partials];
}

function rangeAt(file: LoadedFile, docIndex: number, key: string): Range | undefined {
  return file.positions[docIndex]?.positionIndex.get(key);
}

/** The value span of `path`, falling back to its key when the value has none. */
function valueRange(file: LoadedFile, docIndex: number, path: string): Range | undefined {
  return rangeAt(file, docIndex, path) ?? rangeAt(file, docIndex, `@key:${path}`);
}

/** The key span of `path` — what a declaration jump underlines, so the target
 *  reads as `variables:` / `imports.Http`, not the whole block that follows. */
function keyRange(file: LoadedFile, docIndex: number, path: string): Range | undefined {
  return rangeAt(file, docIndex, `@key:${path}`) ?? rangeAt(file, docIndex, path);
}

function docStartRange(file: LoadedFile, docIndex: number): Range | undefined {
  const pos = file.positions[docIndex];
  if (!pos) return undefined;
  return {
    start: { line: pos.sourceLine, character: 0 },
    end: { line: pos.sourceLine, character: 0 },
  };
}

/** First manifest across `files` satisfying `match`, located at its
 *  `metadata.name` (or its first line as a fallback). Names are unique within a
 *  module scope, so the first hit is the definition. */
export function locateManifest(
  files: LoadedFile[],
  match: (manifest: NavigableManifest) => boolean,
): DefinitionResult | undefined {
  for (const file of files) {
    for (let i = 0; i < file.manifests.length; i++) {
      const manifest = file.manifests[i] as NavigableManifest | null;
      if (!manifest || !match(manifest)) continue;
      const range = valueRange(file, i, "metadata.name") ?? docStartRange(file, i);
      if (range) return { uri: file.source, range };
    }
  }
  return undefined;
}

/** The resource instance named `name` in a module scope. */
export function locateResource(files: LoadedFile[], name: string): DefinitionResult | undefined {
  return locateManifest(files, (m) => m.metadata?.name === name);
}

/** The `Telo.Definition` / `Telo.Abstract` doc registering kind suffix `name`.
 *  Filtered by doc kind so an instance sharing the name never shadows it. */
export function locateKindDefinition(
  files: LoadedFile[],
  name: string,
): DefinitionResult | undefined {
  return locateManifest(files, (m) => KIND_DOC_KINDS.has(m.kind ?? "") && m.metadata?.name === name);
}

/** Index of the module's `Telo.Application` / `Telo.Library` doc in its owner
 *  file — where `imports`, `variables`, `secrets` and `ports` are declared. */
function moduleDocIndex(mod: LoadedModule): number {
  return mod.owner.manifests.findIndex((m) =>
    MODULE_DOC_KINDS.has((m as NavigableManifest | null)?.kind ?? ""),
  );
}

/** The module doc's JSON projection, for reading its `exports` block. */
export function moduleDoc(mod: LoadedModule): Record<string, unknown> | undefined {
  const index = moduleDocIndex(mod);
  return index < 0 ? undefined : (mod.owner.manifests[index] as Record<string, unknown> | null) ?? undefined;
}

/** The module's `metadata.name` — the identity a canonical kind (`<module>.<Kind>`)
 *  and an `ImportEdge.targetModuleName` are expressed in. */
export function moduleName(mod: LoadedModule): string | undefined {
  return (moduleDoc(mod) as NavigableManifest | undefined)?.metadata?.name;
}

/** A dotted key path on the module doc (`imports.Http`, `variables.port`),
 *  located at the key itself. */
export function locateModuleDocKey(
  mod: LoadedModule,
  path: string,
): DefinitionResult | undefined {
  const index = moduleDocIndex(mod);
  if (index < 0) return undefined;
  const range = keyRange(mod.owner, index, path);
  return range ? { uri: mod.owner.source, range } : undefined;
}

/** Where the import bound to `alias` is declared: the `imports:` map entry, or
 *  the legacy standalone `Telo.Import` doc named after the alias. */
export function locateImport(mod: LoadedModule, alias: string): DefinitionResult | undefined {
  return (
    locateModuleDocKey(mod, `imports.${alias}`) ??
    locateManifest(moduleFiles(mod), (m) => m.kind === "Telo.Import" && m.metadata?.name === alias)
  );
}
