import type { ResourceManifest } from "@telorun/sdk";
import { kindDocumentIn } from "./loaded-kind-scope.js";
import type { ApplicationSourceLoad, GraphLoadError, LoadedGraph, LoadedModule } from "./loaded-types.js";
import { isModuleKind } from "./module-kinds.js";
import {
  isNeedTypeDoc,
  readNeeds,
  readNeedTypeShape,
  type NeedDeclaration,
  type NeedTypeShape,
} from "./need-type.js";

/**
 * What a parent's analysis knows about a child application it runs — the
 * child's declared `variables:` / `secrets:` / `ports:` / `needs:` — collected
 * from the loaded graph by `collectApplicationSources` and handed to the
 * analysis beside the flattened set (`AnalysisOptions.applicationSources`, the
 * `moduleDocuments` precedent), never carried on a manifest an author writes.
 *
 * A need's type is resolved here, over the child's own graph, because the
 * child's alias scope is in no registry of the parent's analysis: a built-in
 * `Telo.<Kind>` is named and resolved by the analysis, a type the child declares
 * or reaches through its imports is named canonically with its shape read from
 * the declaring `Telo.NeedType` document.
 *
 * Browser-safe.
 */

/** One need the child declares, its type resolved in the child's scope. */
export interface ChildApplicationNeed extends NeedDeclaration {
  /** Canonical `<module>.<Kind>`, or undefined when it resolves to nothing. */
  type?: string;
  /** The type's shape, for a type a module of the child's graph declares. */
  shape?: NeedTypeShape;
}

export interface ChildApplication {
  /** Canonical source of the child's module document. */
  source: string;
  name: string;
  variables: Record<string, Record<string, unknown>>;
  secrets: Record<string, Record<string, unknown>>;
  ports: Record<string, Record<string, unknown>>;
  needs: ChildApplicationNeed[];
}

export type ApplicationSourceRecord =
  | { application: ChildApplication }
  | { failure: Pick<GraphLoadError, "url" | "source" | "reason"> & { message: string } };

/** Declaring file → source as written → what it names. */
export type ApplicationSourceRecords = Record<string, Record<string, ApplicationSourceRecord>>;

/** Every child application `graph` loaded, by declaring file and source as written. */
export function collectApplicationSources(graph: LoadedGraph): ApplicationSourceRecords {
  const out: ApplicationSourceRecords = {};
  for (const [file, loads] of graph.applicationSources ?? []) {
    const records: Record<string, ApplicationSourceRecord> = {};
    for (const [source, load] of loads) records[source] = recordOf(load);
    out[file] = records;
  }
  return out;
}

function recordOf(load: ApplicationSourceLoad): ApplicationSourceRecord {
  if ("failure" in load) {
    const { url, source, reason, error } = load.failure;
    return {
      failure: { url, ...(source !== undefined ? { source } : {}), ...(reason ? { reason } : {}), message: error.message },
    };
  }
  return { application: childApplicationOf(load.graph) };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function entriesOf(doc: Record<string, unknown>, block: string): Record<string, Record<string, unknown>> {
  const raw = doc[block];
  const out: Record<string, Record<string, unknown>> = {};
  if (!isRecord(raw)) return out;
  for (const [name, entry] of Object.entries(raw)) {
    if (isRecord(entry)) out[name] = entry;
  }
  return out;
}

function childApplicationOf(graph: LoadedGraph): ChildApplication {
  const doc = graph.entry.owner.manifests.find((m) => m && isModuleKind(m.kind)) as
    | (ResourceManifest & Record<string, unknown>)
    | undefined;
  const record = (doc ?? {}) as Record<string, unknown>;
  const name = typeof doc?.metadata?.name === "string" ? doc.metadata.name : "";
  return {
    source: graph.rootSource,
    name,
    variables: entriesOf(record, "variables"),
    secrets: entriesOf(record, "secrets"),
    ports: entriesOf(record, "ports"),
    needs: readNeeds(doc).map((need) => ({
      ...need,
      ...resolveNeedType(graph, graph.entry, need.kind),
    })),
  };
}

/**
 * The need type `kind` names in `mod`'s scope: a built-in by name, or one a
 * module of the child's graph declares — its own, or one an import exports or
 * re-exports, followed to the library that declares it.
 */
function resolveNeedType(
  graph: LoadedGraph,
  mod: LoadedModule,
  kind: string,
): { type?: string; shape?: NeedTypeShape } {
  if (kind.startsWith("Telo.")) return { type: kind };
  const found = kindDocumentIn(graph, mod, kind);
  if (!found || !isNeedTypeDoc(found.doc)) return {};
  return { type: `${found.moduleName}.${String(found.doc.metadata?.name)}`, shape: readNeedTypeShape(found.doc) };
}
