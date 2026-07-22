import {
  parseToAst,
  type AstDocument,
  type LoadedFile,
  type LoadedGraph,
  type LoadedModule,
  type Range,
} from "@telorun/analyzer";
import type { DefinitionResult } from "../types.js";
import { resolveNodeAtPosition } from "../completions/resolve-node.js";

/** The module whose owner or partials includes `filePath`. */
function moduleForFile(graph: LoadedGraph, filePath: string): LoadedModule | undefined {
  for (const mod of graph.modules.values()) {
    if (mod.owner.source === filePath) return mod;
    if (mod.partials.some((p) => p.source === filePath)) return mod;
  }
  return undefined;
}

/** First resource named `name` across `files`, located at its `metadata.name`
 *  (or its first line as a fallback). Names are unique within a module scope, so
 *  the first hit is the definition. */
function locateResource(files: LoadedFile[], name: string): DefinitionResult | undefined {
  for (const file of files) {
    for (let i = 0; i < file.manifests.length; i++) {
      const manifest = file.manifests[i];
      if (!manifest || manifest.metadata?.name !== name) continue;
      const pos = file.positions[i];
      const range: Range | undefined =
        pos?.positionIndex.get("metadata.name") ??
        pos?.positionIndex.get("@key:metadata.name") ??
        (pos ? { start: { line: pos.sourceLine, character: 0 }, end: { line: pos.sourceLine, character: 0 } } : undefined);
      if (range) return { uri: file.source, range };
    }
  }
  return undefined;
}

/** The `exports.resources` list of a module's owner doc (empty when absent). */
function exportedResources(mod: LoadedModule): string[] {
  const doc = mod.owner.manifests.find(
    (m) => m?.kind === "Telo.Library" || m?.kind === "Telo.Application",
  ) as { exports?: { resources?: unknown } } | undefined;
  const list = doc?.exports?.resources;
  return Array.isArray(list) ? list.filter((e): e is string => typeof e === "string") : [];
}

/** Follow `name` into `moduleSource` across the export boundary, honoring the
 *  `exports.resources` gate and re-export chains (`app → api → domain → …`). A
 *  terminal match is a locally-owned instance the module actually exports; a
 *  re-export entry `InnerAlias.name` hops through that module's own import edge.
 *  `seen` bounds cyclic import graphs. */
function resolveExported(
  graph: LoadedGraph,
  moduleSource: string,
  name: string,
  seen: Set<string> = new Set(),
): DefinitionResult | undefined {
  if (seen.has(moduleSource)) return undefined;
  seen.add(moduleSource);
  const mod = graph.modules.get(moduleSource);
  if (!mod) return undefined;

  const exports = exportedResources(mod);

  // No `exports.resources` block → ungated (the module hasn't opted into the
  // gate, same as `exports.kinds`): a plain name match keeps navigation working
  // for modules that predate explicit exports.
  if (exports.length === 0) {
    return locateResource([mod.owner, ...mod.partials], name);
  }

  if (exports.includes(name)) {
    const local = locateResource([mod.owner, ...mod.partials], name);
    if (local) return local;
  }

  const reexport = exports.find((e) => e.endsWith(`.${name}`));
  if (!reexport) return undefined;
  const innerAlias = reexport.slice(0, reexport.length - name.length - 1);
  const edge = graph.importEdges.get(mod.owner.source)?.get(innerAlias);
  return edge ? resolveExported(graph, edge.targetSource, name, seen) : undefined;
}

/** Resolve the `!ref` under the cursor to its target resource's definition.
 *
 *  The ref grammar mirrors `resolveRefSentinels`: the tag's value is split on
 *  the first dot — a bare name (or `Self.name`) is a local resource in the
 *  current module; `Alias.name` is an exported instance of the module the import
 *  `Alias` points at, followed transitively through re-exports and gated on each
 *  module's `exports.resources`. Returns `undefined` when the cursor isn't on a
 *  `!ref`, or the target can't be found (e.g. a scope-local name, an unexported
 *  instance, or an import that failed to load). */
export function buildDefinition(
  text: string,
  line: number,
  character: number,
  graph: LoadedGraph,
  currentFilePath: string,
  docs?: AstDocument[],
): DefinitionResult | undefined {
  const astDocs = docs ?? parseToAst(text);
  const node = resolveNodeAtPosition(text, astDocs, line, character)?.node;
  if (!node || node.kind !== "scalar" || node.tag !== "!ref") return undefined;

  // The scalar's range covers the ref target text (the value after `!ref`).
  const source = text.slice(node.range[0], node.range[1]).trim();
  if (!source) return undefined;

  const currentModule = moduleForFile(graph, currentFilePath) ?? graph.entry;
  const dot = source.indexOf(".");
  const alias = dot === -1 ? undefined : source.slice(0, dot);
  const name = dot === -1 ? source : source.slice(dot + 1);

  if (alias === undefined || alias === "Self") {
    return locateResource([currentModule.owner, ...currentModule.partials], name);
  }

  const edge = graph.importEdges.get(currentModule.owner.source)?.get(alias);
  if (!edge) return undefined;
  return resolveExported(graph, edge.targetSource, name);
}
