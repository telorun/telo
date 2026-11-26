/** The refusal of every stamp an author wrote: the loader's over the loaded
 *  graph, and the one judge of a nested declaration's over written documents. */
import type { ResourceManifest } from "@telorun/sdk";
import { expansionTagLabel, isExpansionSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import { relocatePath } from "./choice-expansion.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { readExpansionSites } from "./expansion-sites.js";
import type { ImportEdge, LoadedFile, LoadedModule, ScopedImportEdge } from "./loaded-types.js";
import {
  bodyEntryStamps,
  holdsNestedStamp,
  METADATA_RESERVED_FIELD,
  metadataStampMessage,
  writtenMetadataStamps,
  writtenStampMessage,
  type WrittenStampPlace,
} from "./metadata-stamps.js";
import type { ModuleDocuments } from "./module-documents.js";
import { isModuleKind } from "./module-kinds.js";
import { normalizeInlineResources } from "./normalize-inline-resources.js";
import { optionViews, type OptionView } from "./option-views.js";
import { withQuotedPath, type WrittenPlace } from "./quoted-place.js";
import { writtenPlaceOf } from "./diagnostic-identity.js";
import { importAnchoredDiagnostic, type ImportReach, type ReachingImport } from "./reaching-import.js";
import { scopedMemberPath } from "./scoped-imports.js";
import { parseKeys, pathText } from "./template-expansion.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

interface StampGraph {
  entry: LoadedModule;
  modules: ReadonlyMap<string, LoadedModule>;
  importEdges: ReadonlyMap<string, ReadonlyMap<string, ImportEdge>>;
  scopedImportEdges: ReadonlyMap<string, readonly ScopedImportEdge[]>;
}

/**
 * Every stamp written in a module the entry runs — on a top-level document or
 * on a scoped `Telo.Import` — the entry's own where it is written, a dependency's at the entry's import that first reaches it — the
 * entry's `imports:` in order, then the imports its declarations hold as scope
 * members, each followed through every library it reaches.
 */
export function metadataStampDiagnostics(graph: StampGraph): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  const filesOf = (mod: LoadedModule): LoadedFile[] => [mod.owner, ...mod.partials];
  const edgesOf = (mod: LoadedModule): (ImportEdge | ScopedImportEdge)[] =>
    filesOf(mod).flatMap((file) => [
      ...(graph.importEdges.get(file.source)?.values() ?? []),
      ...(graph.scopedImportEdges.get(file.source) ?? []),
    ]);

  /** The stamps the author wrote on each scoped `Telo.Import` of `file` — read
   *  off the written text, since the loader stamps a member's identity in place
   *  and a cached file holds it. */
  const scopedStamps = (file: LoadedFile) =>
    (graph.scopedImportEdges.get(file.source) ?? []).flatMap((edge) => {
      const holderIndex = file.manifests.findIndex((m) => m?.metadata?.name === edge.holders[0]!.name);
      const positions = file.positions[holderIndex]?.positionIndex;
      const at = scopedMemberPath(edge.place);
      return writtenMetadataStamps(edge.member)
        .filter((field) => positions?.has(`${at}.metadata.${field}`))
        .map((field) => ({
          edge,
          path: `${at}.metadata.${field}`,
          range: positions!.get(`${at}.metadata.${field}`),
          message: metadataStampMessage(edge.member, field),
        }));
    });

  /** Every stamp `file` writes, refused where it is written. */
  const writtenStamps = (file: LoadedFile): AnalysisDiagnostic[] => {
    const found: AnalysisDiagnostic[] = [];
    for (const stamp of scopedStamps(file)) {
      found.push({
        severity: DiagnosticSeverity.Error,
        code: METADATA_RESERVED_FIELD,
        source: "telo-analyzer",
        message: stamp.message,
        data: {
          resource: { kind: stamp.edge.holderKind, name: stamp.edge.holders[0]!.name },
          filePath: file.source,
          path: stamp.path,
        },
        ...(stamp.range ? { range: stamp.range } : {}),
      });
    }
    file.manifests.forEach((manifest, index) => {
      if (!manifest) return;
      const name = (manifest.metadata as { name?: unknown } | undefined)?.name;
      for (const field of writtenMetadataStamps(manifest)) {
        const path = `metadata.${field}`;
        const range = file.positions[index]?.positionIndex.get(path);
        found.push({
          severity: DiagnosticSeverity.Error,
          code: METADATA_RESERVED_FIELD,
          source: "telo-analyzer",
          message: metadataStampMessage(manifest, field),
          data: {
            resource: { kind: manifest.kind, name: typeof name === "string" ? name : "" },
            filePath: file.source,
            path,
          },
          ...(range ? { range } : {}),
        });
      }
    });
    return found;
  };

  for (const file of filesOf(graph.entry)) out.push(...writtenStamps(file));

  const reached = new Set<string>([graph.entry.owner.source]);
  for (const file of filesOf(graph.entry)) {
    const anchored: { edge: ImportEdge | ScopedImportEdge; via: ReachingImport }[] = [];
    for (const [alias, edge] of graph.importEdges.get(file.source) ?? []) {
      anchored.push({ edge, via: { alias, filePath: file.source, path: `imports.${alias}` } });
    }
    for (const edge of graph.scopedImportEdges.get(file.source) ?? []) {
      anchored.push({
        edge,
        via: {
          alias: edge.alias,
          filePath: file.source,
          path: scopedMemberPath(edge.place),
          resource: { kind: edge.holderKind, name: edge.holders[0]!.name },
        },
      });
    }
    for (const { edge, via } of anchored) {
      const queue = [edge];
      for (let next = queue.shift(); next; next = queue.shift()) {
        if (reached.has(next.targetSource)) continue;
        reached.add(next.targetSource);
        const mod = graph.modules.get(next.targetSource);
        if (!mod) continue;
        for (const dependencyFile of filesOf(mod)) {
          for (const stamp of writtenStamps(dependencyFile)) {
            out.push(
              importAnchoredDiagnostic(METADATA_RESERVED_FIELD, next.targetModuleName, via, stamp.message, writtenPlaceOf(stamp)),
            );
          }
        }
        queue.push(...edgesOf(mod));
      }
    }
  }
  return out;
}

/** A stamp an author wrote on a nested declaration, judged where it is written:
 *  the message, labelled by the nearest enclosing declaration its author named,
 *  and the place it quotes from that declaration. */
export interface NestedStamp {
  root: ResourceManifest;
  /** `steps[0].invoke.then.metadata.module`. */
  path: string;
  message: string;
  quoted: WrittenPlace;
}

/**
 * Every stamp an author wrote on a declaration nested in `written` — inline at
 * a reference slot or a step's `invoke:`, a scope member, a template body entry
 * — in EVERY option of every choice, as written: each where it is written
 * (`steps[0].invoke.then.metadata.module`), whatever any configuration takes,
 * its message labelled by the nearest enclosing declaration the author named
 * (`Telo.Sequence/job: 'steps[0].invoke.then.metadata.module' …`).
 * The one judge of a nested stamp: the analysis reads the entry's documents and
 * each library's through it, and the kernel an import's library through the
 * analysis of it. A construct the expansion reader refuses is left as written.
 */
export function writtenNestedStampPlaces(
  written: readonly ResourceManifest[],
  registry: DefinitionRegistry,
  aliases?: AliasResolver,
  aliasesByModule?: Map<string, AliasResolver>,
): NestedStamp[] {
  const judged = written.filter(holdsNestedStamp);
  if (judged.length === 0) return [];
  // The module documents say which whole-document tag stands first in its file.
  const read = [...new Set([...written.filter((m) => isModuleKind(m.kind)), ...judged])];
  const sites = new Map<object, ReturnType<typeof readExpansionSites>["sites"][number]>();
  const reading = readExpansionSites(
    read.filter((m) => !isExpansionSentinel(m)),
    read.filter(isExpansionSentinel),
    registry,
    aliases,
    aliasesByModule,
    true,
  );
  for (const site of reading.sites) if (site.value && typeof site.value === "object") sites.set(site.value, site);
  const views = judged.map((document) => optionViews(document, sites));
  const found = new Map<string, NestedStamp>();
  const add = (view: OptionView, place: WrittenStampPlace) => {
    const at = relocatePath(place.path, view.mappings);
    // A declaration a choice makes writes its fields in the branch and may write
    // its own `metadata` at the tag: its stamps are quoted from where that is.
    const own = place.path === `${place.labelAt ? `${place.labelAt}.` : ""}metadata.${place.field}`;
    const base = own
      ? parseKeys(relocatePath(`${place.labelAt ? `${place.labelAt}.` : ""}metadata`, view.mappings)).slice(0, -1)
      : parseKeys(relocatePath(place.labelAt, view.mappings));
    const keys = parseKeys(at);
    if (!base.every((key, i) => String(key) === String(keys[i]))) {
      throw new Error(`internal: the stamp at '${at}' is not written beneath its declaration '${pathText(base)}'.`);
    }
    const text = pathText(keys.slice(base.length));
    const message = writtenStampMessage(place.label, text, place.field);
    const quoted: WrittenPlace = base.length === 0 ? { text } : { text, relativeTo: pathText(base) };
    found.set(JSON.stringify([judged.indexOf(view.written), at, message]), { root: view.written, path: at, message, quoted });
  };
  for (let i = 0; ; i++) {
    const layer = views.flatMap((each) => (each[i] ? [each[i]!] : []));
    if (layer.length === 0) break;
    const places: WrittenStampPlace[] = [];
    const normalized = normalizeInlineResources(
      layer.map((view) => view.manifest),
      registry,
      aliases,
      aliasesByModule,
      undefined,
      (place) => places.push(place),
    );
    const viewOf = new Map<object, OptionView>(layer.map((view, k) => [normalized[k]!, view]));
    for (const place of places) {
      const view = viewOf.get(place.root);
      if (view) add(view, place);
    }
    for (const view of layer) {
      if (view.manifest.kind !== "Telo.Definition") continue;
      for (const place of bodyEntryStamps(view.manifest)) add(view, place);
    }
  }
  return [...found.values()];
}

/** A stamp an author wrote on a nested declaration of the entry's own modules,
 *  about the document holding it, at the stamp's place there. */
export function nestedStampDiagnostic(place: NestedStamp): AnalysisDiagnostic {
  const meta = place.root.metadata as { name?: unknown; source?: unknown } | undefined;
  return withQuotedPath({
    severity: DiagnosticSeverity.Error,
    code: METADATA_RESERVED_FIELD,
    source: "telo-analyzer",
    message: place.message,
    data: {
      resource: { kind: place.root.kind ?? expansionTagLabel(place.root), name: typeof meta?.name === "string" ? meta.name : "" },
      ...(typeof meta?.source === "string" ? { filePath: meta.source } : {}),
      path: place.path,
    },
  }, place.quoted);
}

/**
 * Every stamp an author wrote on a nested declaration of a library the entry
 * loads, at the entry's import first reaching it — judged once per library over
 * the library's own documents (its `moduleDocuments` entry, which the
 * omitted-input reader reads too), every option of each of its choices,
 * whatever an import gives it.
 */
export function dependencyNestedStampDiagnostics(input: {
  libraries: readonly ModuleDocuments[];
  rootModules: ReadonlySet<string>;
  reach: ImportReach;
  judged: (manifests: ResourceManifest[]) => NestedStamp[];
}): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  for (const library of input.libraries) {
    if (input.rootModules.has(library.module) || !input.reach.loads(library)) continue;
    const via = input.reach.of(library.module);
    if (!via) continue;
    for (const place of input.judged(library.manifests)) {
      out.push(
        importAnchoredDiagnostic(METADATA_RESERVED_FIELD, library.module, via, place.message, writtenPlaceOf(nestedStampDiagnostic(place))),
      );
    }
  }
  return out;
}
