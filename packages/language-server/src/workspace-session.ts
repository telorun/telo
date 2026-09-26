import {
  AnalysisRegistry,
  Loader,
  StaticAnalyzer,
  collectModuleDocuments,
  flattenForAnalyzer,
  type AstDocument,
  type LoadOptions,
  type LoadedGraph,
  type ManifestAnalysis,
} from "@telorun/analyzer";
import type { RequirementsParams } from "@telorun/editor-protocol";
import {
  assembleGraphDiagnostics,
  findPositions,
  normalizeDiagnostic,
} from "@telorun/ide-support";
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver/browser";
import { dirnameOf } from "./document-uri.js";
import { errorText } from "./host-client.js";
import type { HostManifestSource } from "./host-manifest-source.js";
import { documentDiagnostic, toLspDiagnostic } from "./lsp-diagnostic.js";
import { requirementsOf } from "./requirements.js";
import type { WorkspaceMarkers } from "./workspace-marker.js";

// A module doc declares `kind: Telo.*`; a partial declares a module-prefixed kind
// (`Run.Sequence`) and is reached through its owner. The narrow pattern decides
// whether an owner-less file is analysed standalone, so unrelated YAML declaring
// a `kind:` (Kubernetes) draws no Telo diagnostics.
const TELO_KIND_RE = /^kind:\s+Telo\./m;
const ANY_KIND_RE = /^kind:\s+/m;

const LOAD: LoadOptions = { desugarImports: true, migrate: true };

/** What every language feature reads for one document: the analysis of the
 *  module it belongs to. Every field is absent before the first analysis, or
 *  for a file no module includes. */
export interface DocumentAnalysis {
  registry?: AnalysisRegistry;
  graph?: LoadedGraph;
  analysis?: ManifestAnalysis;
  /** The owner module's `telo.yaml` — the file itself before the first analysis. */
  moduleRoot: string;
  /** The analysed AST when it was parsed from exactly `text`, else undefined so
   *  the feature parses the buffer itself. */
  docsFor(text: string): AstDocument[] | undefined;
}

interface OwnerAnalysis {
  graph: LoadedGraph;
  registry: AnalysisRegistry;
  analysis: ManifestAnalysis;
  /** Every source the analysis read — a change to any of them changes it. */
  closure: Set<string>;
  diagnostics: Map<string, Diagnostic[]>;
}

export interface SessionEvents {
  publishDiagnostics(source: string, diagnostics: Diagnostic[]): void;
  requirements(params: RequirementsParams): void;
  /** One round of analysis settled; highlighting may now resolve more. */
  analysed(): void;
  /** The engine itself failed while refreshing `source`. */
  failed(source: string, error: unknown): void;
}

/**
 * The open workspace: the documents the host has open, the module each belongs
 * to, one analysis per owner module, and the diagnostics published for every
 * file those analyses reach.
 *
 * **The unit of analysis is the owner module**, found the way `telo check`
 * finds it — a partial's owner is the nearest `telo.yaml` above it that
 * includes it — and analysed over its whole import closure exactly as `telo
 * check` analyses it. A change to one file therefore re-analyses every owner
 * whose closure read it, and diagnostics are republished for every file whose
 * set moved, open or not: editing a library changes its consumers' verdicts.
 *
 * Work is serialized and coalesced: a burst of edits to one document while an
 * analysis runs costs one further analysis, not one per keystroke.
 */
export class WorkspaceSession {
  private readonly texts = new Map<string, string>();
  private readonly owners = new Map<string, OwnerAnalysis>();
  private readonly documentOwner = new Map<string, string>();
  /** Diagnostics about a document as a whole — a load failure, a partial no
   *  module includes, a workspace marker's checks. */
  private readonly documentDiagnostics = new Map<string, Diagnostic[]>();
  private readonly published = new Map<string, string>();
  private readonly pending = new Set<string>();
  private draining: Promise<void> | undefined;

  constructor(
    private readonly source: HostManifestSource,
    private readonly markers: WorkspaceMarkers,
    private readonly events: SessionEvents,
  ) {}

  textOf(source: string): string | undefined {
    return this.texts.get(source);
  }

  /** A document opened or edited — the host sends the whole text either way. */
  changed(source: string, text: string): void {
    this.texts.set(source, text);
    this.schedule(source);
  }

  closed(source: string): void {
    this.texts.delete(source);
    this.documentOwner.delete(source);
    this.documentDiagnostics.delete(source);
    // The buffer no longer stands in for the file, so whatever read it reads
    // the host's copy again.
    this.schedule(source);
  }

  /** Files the host saw change on disk. `structural` when a module appeared or
   *  disappeared, which moves what every open workspace marker reports. */
  filesChanged(sources: string[], structural: boolean): void {
    for (const source of sources) this.schedule(source);
    if (!structural) return;
    for (const source of this.texts.keys()) {
      if (this.markers.isMarker(source)) this.schedule(source);
    }
  }

  documentAnalysis(source: string): DocumentAnalysis {
    const owner = this.documentOwner.get(source);
    const state = owner === undefined ? undefined : this.owners.get(owner);
    const loaded = state
      ? [...state.graph.modules.values()]
          .flatMap((m) => [m.owner, ...m.partials])
          .find((file) => file.source === source)
      : undefined;
    return {
      registry: state?.registry,
      graph: state?.graph,
      analysis: state?.analysis,
      moduleRoot: dirnameOf(owner ?? source),
      docsFor: (text) => (loaded && loaded.text === text ? loaded.astDocuments : undefined),
    };
  }

  private schedule(source: string): void {
    this.pending.add(source);
    this.draining ??= this.drain().finally(() => (this.draining = undefined));
  }

  private async drain(): Promise<void> {
    while (this.pending.size > 0) {
      const batch = [...this.pending];
      this.pending.clear();
      const done = new Set<string>();
      for (const source of batch) {
        try {
          await this.refresh(source, done);
        } catch (error) {
          // An analysis that throws is a defect in this engine, reported on the
          // document that triggered it rather than lost with the batch.
          this.events.failed(source, error);
          this.documentDiagnostics.set(source, [
            documentDiagnostic(
              `telo: the language server failed while analysing this file — ${errorText(error)}`,
              DiagnosticSeverity.Error,
            ),
          ]);
        }
      }
      this.collectUnusedOwners();
      this.publish();
      this.events.analysed();
    }
  }

  /** Re-derive everything `source` feeds: its own document when open, then
   *  every owner whose closure read it. */
  private async refresh(source: string, done: Set<string>): Promise<void> {
    if (this.texts.has(source)) {
      if (this.markers.isMarker(source)) {
        this.documentDiagnostics.set(source, await this.markers.diagnostics(source, this.texts.get(source)!));
        return;
      }
      await this.analyzeDocument(source, done);
    }
    for (const [owner, state] of [...this.owners]) {
      if (done.has(owner) || !state.closure.has(source)) continue;
      const member = [...this.documentOwner].find(([, o]) => o === owner)?.[0];
      if (member === undefined) this.owners.delete(owner);
      else await this.analyzeDocument(member, done);
    }
  }

  private async analyzeDocument(source: string, done: Set<string>): Promise<void> {
    const text = this.texts.get(source)!;
    this.documentDiagnostics.delete(source);
    // Unrelated YAML (a CI config beside a telo.yaml) is not a partial of it.
    if (!ANY_KIND_RE.test(text)) {
      this.documentOwner.delete(source);
      return;
    }

    const loader = new Loader([this.source]);
    let owner: string;
    let graph: LoadedGraph;
    try {
      const found = await loader.loadGraphForFile(source, LOAD);
      if (found) {
        ({ graph } = found);
        owner = found.ownerUrl;
      } else {
        if (!TELO_KIND_RE.test(text)) {
          this.documentOwner.delete(source);
          return;
        }
        // Neither an owner nor included by one: analysed as its own module.
        graph = await loader.loadGraph(source, LOAD);
        owner = graph.rootSource;
      }
    } catch (error) {
      this.documentOwner.delete(source);
      const line = (error as { sourceLine?: number }).sourceLine ?? 0;
      this.documentDiagnostics.set(source, [
        documentDiagnostic(errorText(error), DiagnosticSeverity.Error, line),
      ]);
      return;
    }

    const module = graph.modules.get(owner);
    const members = new Set([owner, ...(module?.partials.map((p) => p.source) ?? [])]);
    if (!members.has(source)) {
      this.documentOwner.delete(source);
      this.documentDiagnostics.set(source, [
        documentDiagnostic(
          `This file is not listed in the 'include' field of ${owner}. It will not be loaded at runtime.`,
          DiagnosticSeverity.Warning,
        ),
      ]);
      return;
    }

    // Every open member is bound now, so a partial opened beside its owner is
    // answered from this analysis without waiting for its own turn.
    for (const member of members) {
      if (!this.texts.has(member)) continue;
      this.documentOwner.set(member, owner);
      this.documentDiagnostics.delete(member);
    }
    if (done.has(owner)) return;
    done.add(owner);
    this.analyzeGraph(owner, graph);
  }

  /** The analysis `telo check` performs, over the same graph, with its
   *  diagnostics located the same way. No host versions: an editor is not the
   *  machine that will run the manifest. */
  private analyzeGraph(owner: string, graph: LoadedGraph): void {
    const manifests = flattenForAnalyzer(graph);
    const registry = new AnalysisRegistry();
    const raw = new StaticAnalyzer().analyze(
      manifests,
      { moduleDocuments: collectModuleDocuments(graph) },
      registry,
    );
    const { diagnostics: assembled } = assembleGraphDiagnostics(graph, raw);

    const diagnostics = new Map<string, Diagnostic[]>();
    for (const d of assembled) {
      const located = findPositions(graph, d.data);
      const file = located?.file ?? owner;
      const normalized = normalizeDiagnostic(d, {
        registry,
        positionIndex: located?.positionIndex,
        sourceLine: located?.sourceLine,
      });
      const bucket = diagnostics.get(file) ?? [];
      bucket.push(toLspDiagnostic(normalized));
      diagnostics.set(file, bucket);
    }

    const closure = new Set<string>();
    for (const [source, module] of graph.modules) {
      closure.add(source);
      for (const file of [module.owner, ...module.partials]) closure.add(file.source);
    }

    this.owners.set(owner, {
      graph,
      registry,
      analysis: registry.analysisOf(manifests),
      closure,
      diagnostics,
    });
    this.events.requirements(requirementsOf(owner, graph));
  }

  /** An owner no open document belongs to any more stops being analysed, and
   *  its diagnostics are withdrawn. */
  private collectUnusedOwners(): void {
    const used = new Set(this.documentOwner.values());
    for (const owner of [...this.owners.keys()]) {
      if (!used.has(owner)) this.owners.delete(owner);
    }
  }

  /** Publish every file whose diagnostic set moved — including a file that has
   *  none any more, which is published empty. Two owners reaching one file
   *  report its diagnostics once. */
  private publish(): void {
    const merged = new Map<string, Map<string, Diagnostic>>();
    const add = (file: string, list: Diagnostic[]) => {
      const bucket = merged.get(file) ?? new Map<string, Diagnostic>();
      for (const d of list) bucket.set(JSON.stringify(d), d);
      merged.set(file, bucket);
    };
    for (const state of this.owners.values()) {
      for (const [file, list] of state.diagnostics) add(file, list);
    }
    for (const [file, list] of this.documentDiagnostics) add(file, list);
    for (const source of this.texts.keys()) add(source, []);

    for (const [file, bucket] of merged) {
      const list = [...bucket.values()];
      const key = JSON.stringify(list);
      if (this.published.get(file) === key) continue;
      this.published.set(file, key);
      this.events.publishDiagnostics(file, list);
    }
    for (const file of [...this.published.keys()]) {
      if (merged.has(file)) continue;
      this.published.delete(file);
      this.events.publishDiagnostics(file, []);
    }
  }
}
