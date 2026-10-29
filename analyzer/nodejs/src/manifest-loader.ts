import type { CelEnvironment } from "@telorun/cel";
import type { ResourceManifest } from "@telorun/sdk";
import { buildCelEnvironment } from "./cel-environment.js";
import {
  applicationSourceCandidates,
  applicationSourceFieldOf,
} from "./application-source-slot.js";
import type {
  ApplicationSourceLoad,
  GraphLoadError,
  ImportEdge,
  LoadedFile,
  LoadedGraph,
  LoadedModule,
} from "./loaded-types.js";
import {
  BUILTIN_VOCABULARY_NOT_A_MODULE,
  builtinVocabularyImportMessage,
  isBuiltinVocabularyRoot,
} from "./builtin-vocabulary.js";
import { desugarLoadedFile } from "./inline-imports.js";
import type { LoadedKindScope } from "./loaded-kind-scope.js";
import type { MigrationEntry } from "./migrations/types.js";
import { moduleCallNamesOfFile } from "./module-call-names.js";
import { collectLocalModuleFileDiagnostics } from "./module-file-existence.js";
import { isModuleKind } from "./module-kinds.js";
import {
  parseLoadedFile,
  parseYamlText,
  restoredYaml,
  type ParsedYaml,
} from "./parse-loaded-file.js";
import type { YamlParseCache } from "./yaml-parse-cache.js";
import { isLocalPathSource } from "./sources/local-path-ref.js";
import { reconcileModuleVersions } from "./reconcile-module-versions.js";
import {
  isReservedKindPrefix,
  reservedImportAliasMessage,
  reservedLibraryNameMessage,
} from "./reserved-kind-prefix.js";
import {
  type AnalysisDiagnostic,
  DEFAULT_MANIFEST_FILENAME,
  DiagnosticSeverity,
  type LoadOptions,
  type LoaderInitOptions,
  type ManifestSource,
} from "./types.js";

/** Project every file's YAML `parseErrors` into fatal Error diagnostics. Each
 *  carries `data.filePath` so `findPositions` routes it to the failing file. */
function collectParseDiagnostics(
  modules: Map<string, LoadedModule>,
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  for (const mod of modules.values()) {
    for (const file of [mod.owner, ...mod.partials]) {
      for (const err of file.parseErrors) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: "MANIFEST_PARSE_FAILED",
          source: "telo-analyzer",
          message: err.message,
          range: err.range,
          data: { filePath: file.source },
        });
      }
    }
  }
  return diagnostics;
}

/** Rewrite always, report locally. Every file in the graph was migrated, but a
 *  published dependency's manifest is not the consumer's to fix and its author
 *  is the only person who can — so only the entry module's own files (owner +
 *  its `include:` partials) report. Same rule `X_TELO_REF_UNRESOLVED` follows. */
function collectMigrationDiagnostics(entry: LoadedModule): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];
  for (const file of [entry.owner, ...entry.partials]) {
    diagnostics.push(...file.migrations.diagnostics);
  }
  return diagnostics;
}

/** The identity an import target contributes to its importer, or the reason it
 *  contributes none.
 *
 *  Every way an import can be unusable answers here, in one place and without
 *  throwing: the target is an application, it carries no library document at
 *  all, or it carries one that never names itself. A name is not decoration —
 *  it is the kind prefix every `Alias.Kind` in the importer resolves through —
 *  so a target that has none is as unusable as one that was never fetched, and
 *  is reported the same way rather than left to surface later as an invented
 *  module nobody declared. Judged inside `loadImportTarget`, the per-import
 *  load step. */
type ImportTargetIdentity =
  | { name: string; namespace: string | null }
  | { unusable: string };

export type ImportTargetRefusal = {
  unusable: string;
  reason: "unusable-target" | "reserved-prefix";
};

export function importTargetIdentity(
  target: LoadedModule,
  importSource: string,
): { name: string; namespace: string | null } | ImportTargetRefusal {
  const identity = libraryIdentity(target, importSource);
  if ("unusable" in identity) return { ...identity, reason: "unusable-target" };
  if (isReservedKindPrefix(identity.name)) {
    return { unusable: reservedLibraryNameMessage(importSource, identity.name), reason: "reserved-prefix" };
  }
  return identity;
}

function libraryIdentity(target: LoadedModule, importSource: string): ImportTargetIdentity {
  // The built-in vocabulary is a document every released runtime refuses to
  // import; this one says what it is and what to write instead.
  const first = target.owner.manifests[0];
  if (isBuiltinVocabularyRoot(first)) {
    return {
      unusable: builtinVocabularyImportMessage(
        importSource,
        (first?.metadata as { version?: unknown } | undefined)?.version,
      ),
    };
  }

  const library = target.owner.manifests.find((m) => m?.kind === "Telo.Library");
  const application = target.owner.manifests.find((m) => m?.kind === "Telo.Application");

  if (!library && application) {
    return {
      unusable:
        `Telo.Import target '${importSource}' is a Telo.Application. ` +
        `Only Telo.Library modules may be imported. Applications are run directly, not imported. ` +
        `Point this import at a library, or drop it and run that application on its own.`,
    };
  }

  if (!library) {
    const kinds = target.owner.manifests
      .map((m) => m?.kind)
      .filter((k): k is string => typeof k === "string");
    const detail = kinds.length
      ? `Fetched ${target.owner.manifests.length} document(s) with kinds [${kinds.join(", ")}].`
      : `Fetched manifest contained no recognizable Telo documents — check that the source ` +
        `serves a Telo.Library manifest and not an upstream error page.`;
    return {
      unusable:
        `Telo.Import target '${importSource}' did not resolve to a Telo.Library. ` +
        `Fetched from: ${target.owner.source}. ${detail}`,
    };
  }

  const name = library.metadata?.name;
  if (typeof name !== "string" || name === "") {
    return {
      unusable:
        `Telo.Import target '${importSource}' resolved to a Telo.Library that declares no ` +
        `'metadata.name'. Fetched from: ${target.owner.source}. A library's name is the kind ` +
        `prefix its importers reference, so it cannot be imported until the target declares one.`,
    };
  }

  const namespace = (library.metadata as { namespace?: string | null } | undefined)?.namespace;
  return { name, namespace: typeof namespace === "string" ? namespace : null };
}

/** One import declaration, as the per-import load step reads it. */
export interface ImportRequest {
  /** The file declaring the import. */
  fromSource: string;
  /** The source exactly as authored. */
  source: string;
  /** Its `imports:` key; absent for an import no `imports:` entry declares (one
   *  in a `with:` scope), whose alias is guarded where it is registered. */
  alias?: string;
  /** Line of the declaring `Telo.Import` document. */
  sourceLine?: number;
}

/** How a host resolves and reads an import target. */
export interface ImportTargetPort {
  resolve(fromSource: string, source: string): string | Promise<string>;
  load(resolvedUrl: string): Promise<LoadedModule>;
}

export type ImportTargetLoad =
  | {
      resolvedUrl: string;
      module: LoadedModule;
      identity: { name: string; namespace: string | null };
    }
  | { failure: GraphLoadError };

/**
 * The per-import load step: the reserved-alias check, resolution, the load and
 * the target's identity, each failure returned as the graph load error it is.
 * The graph walk runs it for every import it reaches, and the kernel for an
 * import the walk never reaches, so one source is read, and refused, one way.
 */
export async function loadImportTarget(
  request: ImportRequest,
  port: ImportTargetPort,
): Promise<ImportTargetLoad> {
  const { fromSource, source, alias, sourceLine } = request;
  const failure = (
    url: string,
    error: Error,
    reason?: GraphLoadError["reason"],
    stampLine = true,
  ): { failure: GraphLoadError } => {
    if (stampLine && sourceLine !== undefined) {
      (error as { sourceLine?: number }).sourceLine = sourceLine;
    }
    return {
      failure: {
        url,
        source,
        fromSource,
        ...(alias !== undefined ? { alias } : {}),
        ...(sourceLine !== undefined ? { sourceLine } : {}),
        ...(reason ? { reason } : {}),
        error,
      },
    };
  };

  // Refused before the target is fetched: the alias alone decides it, and an
  // edge registered under it would replace `Telo.` or `Self.`.
  if (alias !== undefined && isReservedKindPrefix(alias)) {
    return failure(source, new Error(reservedImportAliasMessage(alias)), "reserved-prefix");
  }

  let resolvedUrl: string;
  try {
    resolvedUrl = await port.resolve(fromSource, source);
  } catch (err) {
    return failure(source, err instanceof Error ? err : new Error(String(err)), undefined, false);
  }

  let module: LoadedModule;
  try {
    module = await port.load(resolvedUrl);
  } catch (err) {
    return failure(resolvedUrl, err instanceof Error ? err : new Error(String(err)));
  }

  // Judged per IMPORT rather than per distinct target: an import pointing at a
  // module something else already reached (the entry application above all)
  // would otherwise skip the check and register a nameless edge. An unusable
  // target is recorded exactly like an unfetchable one, so no consumer has to
  // know the difference between the two ways an import can fail.
  const identity = importTargetIdentity(module, source);
  if ("unusable" in identity) {
    return failure(module.owner.source, new Error(identity.unusable), identity.reason);
  }
  return { resolvedUrl, module, identity };
}

/** The refusal of an entry file whose first document is the built-in vocabulary
 *  archive: one `UNDEFINED_KIND` at its `kind:` line, since `Telo.Builtins` is
 *  registered nowhere. */
function builtinVocabularyEntryRefusal(file: LoadedFile): AnalysisDiagnostic | undefined {
  if (!isBuiltinVocabularyRoot(file.manifests[0])) return undefined;
  const range = file.positions[0]?.positionIndex.get("kind");
  return {
    severity: DiagnosticSeverity.Error,
    code: "UNDEFINED_KIND",
    source: "telo-analyzer",
    message: BUILTIN_VOCABULARY_NOT_A_MODULE,
    ...(range ? { range } : {}),
    data: { filePath: file.source },
  };
}

const SYSTEM_KINDS = new Set([
  "Telo.Application",
  "Telo.Library",
  "Telo.Import",
  "Telo.Definition",
]);

/** File cache variant tags: compile (c/r) × desugarImports (d/n) × migrate
 *  (m/x), plus the inherited CEL call names a partial compiles with. A desugared
 *  and a raw load of the same file are distinct entries so neither sees the
 *  wrong manifest tree, and the migration axis is there for the same reason —
 *  the editor's round-trip view and `telo migrate` must see the author's
 *  spelling, everything else the current one.
 *
 *  The name axis is OPEN, so the variants are no longer an enumerable set:
 *  `forget` and `findCachedText` locate a source's entries by the LoadedFile
 *  they hold rather than by rebuilding every key. */
function variantKey(options?: LoadOptions, moduleNames?: ReadonlySet<string>): string {
  return `${options?.compile ? "c" : "r"}${options?.desugarImports ? "d" : "n"}${
    options?.migrate ? "m" : "x"
  }${inheritedNamesKey(moduleNames)}`;
}

/** The inherited-name half of a cache key.
 *
 *  A partial compiles with the names of the module that INCLUDED it, so the same
 *  file included by two modules with different `imports:` compiles to two
 *  different programs — one where `Billing.f(x)` is a module call and one where
 *  it is a method call on an unknown receiver. Keying only on the URL would
 *  serve the first module's compilation to the second. Sorted, so a declaration
 *  order change is not a second entry.
 *
 *  Empty for every file that derives its own names (an owner), which is what
 *  keeps the existing eight variants exactly as they were. */
function inheritedNamesKey(moduleNames?: ReadonlySet<string>): string {
  return moduleNames === undefined || moduleNames.size === 0
    ? ""
    : `|${[...moduleNames].sort().join(",")}`;
}

export class Loader {
  /** LoadedFile cache keyed by `${compile ? "compiled" : "raw"}:${source}`.
   *  Same dual-keying as the legacy ResourceManifest[] cache: a compile-mode
   *  caller (kernel) and a raw-mode caller (analyzer/editor) on the same file
   *  get distinct entries, so neither sees the wrong manifest tree. */
  private readonly fileCache = new Map<string, LoadedFile>();

  /** One YAML parse per canonical source, shared by every variant of it. The
   *  load phase reads a module raw and an import reads it again compiled; the
   *  variants differ only in what runs AFTER the parse, and the parse is most
   *  of the cost. Checked against the text so a changed file parses again. */
  private readonly parsedYaml = new Map<string, { text: string; parsed: ParsedYaml }>();

  /** requestUrl → canonical `source`. Lets `loadFile` skip the source read
   *  when a URL it has already canonicalised is requested again — kernel
   *  load → boot and the import-controller each ask the loader for the same
   *  modules. Without this fast path every duplicate request re-runs the
   *  source's `read()` (a `fetch` for `HttpSource`, a disk read for
   *  `LocalFileSource`). */
  private readonly urlToSource = new Map<string, string>();

  protected sources: ManifestSource[];
  private parseCache: YamlParseCache | undefined;
  private readonly celEnv: CelEnvironment;
  private readonly migrations?: readonly MigrationEntry[];

  /** Sources are resolved in order — the first whose `supports(url)` matches
   *  wins. The caller (composition root) decides which concrete sources exist
   *  and supplies them; `defaultSources()` bundles the browser-safe built-ins
   *  (HTTP) for the common case. `register()` prepends a source at runtime. */
  constructor(sources: ManifestSource[] = [], options: LoaderInitOptions = {}) {
    this.sources = [...sources];
    this.celEnv = buildCelEnvironment(options.celHandlers);
    this.migrations = options.migrations;
  }

  /** Restore YAML parses from `cache` instead of parsing, and record the ones
   *  it lacks. Applies to every file read after the call. */
  setParseCache(cache: YamlParseCache | undefined): void {
    this.parseCache = cache;
  }

  register(source: ManifestSource): this {
    this.sources.unshift(source);
    return this;
  }

  private pick(url: string): ManifestSource {
    const s = this.sources.find((s) => s.supports(url));
    if (!s) throw new Error(`No source found for: ${url}`);
    return s;
  }

  async resolveEntryPoint(url: string): Promise<string> {
    // Route through `loadFile` so the resolved source URL and parsed
    // entry are populated in `urlToSource` + `fileCache` in one read.
    // Callers (kernel.load) immediately call `loadGraph(entryUrl)`
    // afterwards — without this priming, the entry file would be read
    // twice (twice over the network for `HttpSource`).
    const file = await this.loadFile(url);
    return file.source;
  }

  /** Returns the canonical source URL the loader has already mapped `url`
   *  to during a prior `loadFile`/`loadModule`/`loadGraph` call, or
   *  `undefined` when the URL has not been seen. Callers use it to test
   *  set-membership against a previous graph walk's modules without
   *  triggering an extra source read. */
  canonicalize(url: string): string | undefined {
    return this.urlToSource.get(url);
  }

  /** Drop every memo for `url` so the next `loadFile` reads it from the source
   *  chain again — the parsed file in each variant, plus every request URL that
   *  canonicalised to it (a module reached under several refs must not stay
   *  reachable through one of them).
   *
   *  `loadFile`'s fast path assumes a file's contents do not change under a
   *  single Loader, which holds until something invalidates one deliberately:
   *  `telo check` dropping a manifest whose upstream tag has moved, and watch
   *  mode when it returns. Without this the only way to un-cache one file is to
   *  discard the whole Loader, taking every unrelated file's memo with it. */
  forget(url: string): void {
    const source = this.urlToSource.get(url) ?? url;
    for (const [requestUrl, canonical] of this.urlToSource) {
      if (canonical === source) this.urlToSource.delete(requestUrl);
    }
    for (const [key, file] of this.fileCache) {
      if (file.source === source) this.fileCache.delete(key);
    }
    this.parsedYaml.delete(source);
  }

  // --- New API: returns LoadedFile / LoadedModule / LoadedGraph ----------

  /** Read one file via the source chain and parse it into a LoadedFile.
   *  The result is shared with `Loader.fileCache`. Callers that want a
   *  private mutable copy must call `parseLoadedFile` directly with the
   *  LoadedFile's `text`.
   *
   *  `moduleNames` is the INCLUDING module's CEL call names and belongs to
   *  `loadModule`'s walk over an `include:` list — a partial has no module doc
   *  of its own to derive them from. A file loaded on its own derives its own,
   *  so every other caller omits it. */
  async loadFile(
    url: string,
    options?: LoadOptions,
    moduleNames?: ReadonlySet<string>,
  ): Promise<LoadedFile> {
    const variant = variantKey(options, moduleNames);
    const knownSource = this.urlToSource.get(url);
    if (knownSource) {
      const cached = this.fileCache.get(`${variant}:${knownSource}`);
      if (cached) return cached;
      // Another variant of this source is cached — reparse from its text
      // instead of re-reading the source.
      //
      // NOTE for watch-mode reactivation (cli/nodejs/src/commands/run.ts
      // currently has `setupWatchMode` commented out): this branch
      // assumes file contents don't change underneath a single Loader.
      // Reviving watch mode will need a public `invalidate(url)` (or
      // similar) that drops both `urlToSource[url]` and every cached
      // variant entry for its canonical source before the loader serves
      // the file again.
      const altText = this.findCachedText(knownSource);
      if (altText !== undefined) {
        const reparsed = this.parseAndMaybeDesugar(knownSource, url, altText, options, moduleNames);
        this.fileCache.set(`${variant}:${knownSource}`, reparsed);
        return reparsed;
      }
    }

    const { text, source } = await this.pick(url).read(url);
    this.urlToSource.set(url, source);
    // Also map the canonical source to itself so subsequent `loadFile`
    // calls that already received a canonical URL — `kernel.load` passes
    // the result of `resolveEntryPoint` to `loadGraph`, which then asks
    // for that exact URL — hit the urlToSource fast path instead of
    // falling through to a redundant `pick(url).read(url)`.
    this.urlToSource.set(source, source);
    const cacheKey = `${variant}:${source}`;
    const cached = this.fileCache.get(cacheKey);
    if (cached && cached.text === text) return cached;

    const loaded = this.parseAndMaybeDesugar(source, url, text, options, moduleNames);
    this.fileCache.set(cacheKey, loaded);
    return loaded;
  }

  /** Parse `text` into a LoadedFile, then desugar inline `imports:` when the
   *  caller opted in. Desugaring lives here, not in the pure `parseLoadedFile`,
   *  so round-trip consumers (the editor) keep a raw manifest/AST/position
   *  triple they can pair by index; only resolved consumers that pass
   *  `desugarImports` see synthetic Telo.Import manifests.
 *
 *  The migration phase runs inside `parseLoadedFile`, i.e. before desugaring —
 *  a rule must only ever match author-written nodes, and the position is what
 *  makes that structural rather than a convention. Nothing needs the later
 *  position: the `imports:` map is read straight off the module manifest and is
 *  equally available before desugaring. */
  private parseAndMaybeDesugar(
    source: string,
    requestedUrl: string,
    text: string,
    options?: LoadOptions,
    moduleNames?: ReadonlySet<string>,
  ): LoadedFile {
    let yaml = this.parsedYaml.get(source);
    if (yaml?.text !== text) {
      yaml = { text, parsed: this.parseYaml(source, text) };
      this.parsedYaml.set(source, yaml);
    }
    const loaded = parseLoadedFile(
      source,
      requestedUrl,
      text,
      {
        compile: options?.compile,
        celEnv: this.celEnv,
        migrate: options?.migrate,
        migrations: this.migrations,
        moduleNames,
      },
      yaml.parsed,
    );
    return options?.desugarImports ? desugarLoadedFile(loaded) : loaded;
  }

  private parseYaml(source: string, text: string): ParsedYaml {
    const cached = this.parseCache?.read(source, text);
    if (cached) return restoredYaml(text, cached);
    const parsed = parseYamlText(text);
    if (parsed.parseErrors.length === 0) {
      this.parseCache?.write(source, text, {
        manifests: parsed.manifests,
        positions: parsed.positions,
      });
    }
    return parsed;
  }

  /** Raw text of any already-cached variant for `source`, so a cache miss on
   *  one (compile, desugar, inherited names) variant reparses without a second
   *  source read. */
  private findCachedText(source: string): string | undefined {
    for (const file of this.fileCache.values()) {
      if (file.source === source) return file.text;
    }
    return undefined;
  }

  /** Load an owner file plus every partial reachable through its `include:`
   *  list. Globs are expanded via the owning source's `expandGlob`. The
   *  partials list is empty when the owner declares no `include:`. */
  async loadModule(url: string, options?: LoadOptions): Promise<LoadedModule> {
    const owner = await this.loadFile(url, options);
    this.assertSingleModuleDeclaration(owner);
    this.assertNoSystemKindsInPartialContext(owner, /*isPartial*/ false);

    const moduleManifest = owner.manifests.find((m) => m && isModuleKind(m.kind));
    const includePatterns = (moduleManifest as { include?: string[] } | undefined)?.include;

    if (!includePatterns?.length) return { owner, partials: [] };

    const picked = this.pick(owner.source);
    const includedFiles = await this.resolveIncludes(owner.source, includePatterns, picked);
    // A partial's CEL is written in the INCLUDING module's scope, so it compiles
    // with that module's call names — the owner's `imports:` keys, `Self`, its
    // `metadata.name` and `Telo`. Derived from the owner alone: a partial may
    // declare no module doc, no import and no definition.
    const moduleNames = moduleCallNamesOfFile(owner.manifests);
    const partials: LoadedFile[] = [];
    for (const includedUrl of includedFiles) {
      const partial = await this.loadFile(includedUrl, options, moduleNames);
      this.assertNoSystemKindsInPartialContext(partial, /*isPartial*/ true);
      partials.push(partial);
    }

    return { owner, partials };
  }

  /** Load a module and every transitively-imported library. Returns the full
   *  LoadedGraph: `entry`, `modules` keyed by canonical source, and
   *  `importEdges` mapping each importing file's PascalCase aliases to their
   *  target's canonical source. */
  async loadGraph(entryUrl: string, options?: LoadOptions): Promise<LoadedGraph> {
    return this.loadGraphWith(entryUrl, options, true);
  }

  /** `loadGraph`, following the entry's child applications only when asked: a
   *  child's graph is loaded for its declarations, never for children of its own. */
  private async loadGraphWith(
    entryUrl: string,
    options: LoadOptions | undefined,
    followApplications: boolean,
  ): Promise<LoadedGraph> {
    const entry = await this.loadModule(entryUrl, options);
    const rootSource = entry.owner.source;

    const modules = new Map<string, LoadedModule>();
    modules.set(rootSource, entry);

    // The built-in vocabulary is read, never run or checked as a module: the
    // whole file is refused with one diagnostic, and nothing it holds is walked.
    const refusal = builtinVocabularyEntryRefusal(entry.owner);
    if (refusal) {
      return {
        rootSource,
        entry,
        modules,
        importEdges: new Map(),
        overrides: new Map(),
        migrationDiagnostics: [],
        versionDiagnostics: [],
        moduleFileDiagnostics: [],
        parseDiagnostics: [...collectParseDiagnostics(modules), refusal],
        errors: [],
        applicationSources: new Map(),
      };
    }
    const importEdges = new Map<string, Map<string, ImportEdge>>();
    const errors: GraphLoadError[] = [];

    const queue: LoadedModule[] = [entry];
    const visited = new Set<string>([rootSource]);

    while (queue.length > 0) {
      const mod = queue.shift()!;

      for (const file of [mod.owner, ...mod.partials]) {
        const aliases = importEdges.get(file.source) ?? new Map<string, ImportEdge>();

        for (let i = 0; i < file.manifests.length; i++) {
          const m = file.manifests[i];
          if (!m || m.kind !== "Telo.Import") continue;
          const importSource = (m as { source?: string }).source;
          if (!importSource) continue;
          const alias = m.metadata?.name as string | undefined;
          if (!alias) continue;
          // Source line of this Telo.Import doc — read from the LoadedFile's
          // position table since `parseLoadedFile` doesn't stamp `sourceLine`
          // onto manifest metadata. Used to pin import-resolution diagnostics
          // to the line where the import was declared.
          const sourceLine = file.positions[i]?.sourceLine ?? 0;

          // The target is keyed by its canonical `source` — the modules-map key
          // — so a module several imports reach is loaded once. A failure is
          // recorded against this import, with no edge, and the rest of the
          // graph still loads.
          const loaded = await loadImportTarget(
            { fromSource: file.source, source: importSource, alias, sourceLine },
            {
              resolve: (from, source) => this.resolveImportUrl(from, source),
              load: async (url) => {
                const known = modules.get(url);
                if (known) return known;
                const target = await this.loadModule(url, options);
                const canonical = target.owner.source;
                if (!modules.has(canonical)) modules.set(canonical, target);
                return modules.get(canonical)!;
              },
            },
          );
          if ("failure" in loaded) {
            errors.push(loaded.failure);
            continue;
          }
          const { module: targetModule, identity } = loaded;
          const targetCanonical = targetModule.owner.source;

          // The identity is stamped on the edge — flattenForAnalyzer reads it
          // from there, never re-deriving it from manifest.metadata.
          aliases.set(alias, {
            targetSource: targetCanonical,
            targetRef: importSource,
            targetModuleName: identity.name,
            targetNamespace: identity.namespace,
          });

          if (!visited.has(targetCanonical)) {
            visited.add(targetCanonical);
            queue.push(targetModule);
          }
        }

        if (aliases.size > 0) importEdges.set(file.source, aliases);
      }
    }

    // Collapse multiple versions of the same module identity onto one version
    // before any consumer walks the edges: repoints losing `importEdges` in
    // place and yields the runtime override map + hoist/conflict diagnostics.
    const { overrides, diagnostics } = reconcileModuleVersions(modules, importEdges);

    return {
      rootSource,
      entry,
      modules,
      importEdges,
      overrides,
      migrationDiagnostics: collectMigrationDiagnostics(entry),
      versionDiagnostics: diagnostics,
      moduleFileDiagnostics: await collectLocalModuleFileDiagnostics(
        entry,
        modules,
        importEdges,
        (url) => this.sources.find((s) => s.supports(url)),
      ),
      parseDiagnostics: collectParseDiagnostics(modules),
      errors,
      applicationSources: followApplications
        ? await this.loadApplicationSources(entry, { modules, importEdges }, options)
        : new Map(),
    };
  }

  /** Every child application a resource of the entry's own files names at an
   *  annotated field, by declaring file and source as written — each resource's
   *  kind resolved through the entry's own import edges. */
  private async loadApplicationSources(
    entry: LoadedModule,
    graph: LoadedKindScope,
    options: LoadOptions | undefined,
  ): Promise<Map<string, Map<string, ApplicationSourceLoad>>> {
    const out = new Map<string, Map<string, ApplicationSourceLoad>>();
    const fields = new Map<string, string | undefined>();
    const fieldOf = (kind: string): string | undefined => {
      if (!fields.has(kind)) fields.set(kind, applicationSourceFieldOf(graph, entry, kind));
      return fields.get(kind);
    };
    for (const file of [entry.owner, ...entry.partials]) {
      const sources = applicationSourceCandidates(file.manifests, fieldOf);
      if (sources.size === 0) continue;
      const loads = new Map<string, ApplicationSourceLoad>();
      for (const source of sources) {
        loads.set(source, await this.loadApplicationSource(file.source, source, options));
      }
      out.set(file.source, loads);
    }
    return out;
  }

  /** One child application: resolved like an import's source, loaded with its
   *  imports, and refused unless its module document is a `Telo.Application`. */
  private async loadApplicationSource(
    fromSource: string,
    source: string,
    options: LoadOptions | undefined,
  ): Promise<ApplicationSourceLoad> {
    const failure = (
      url: string,
      error: unknown,
      reason?: GraphLoadError["reason"],
    ): ApplicationSourceLoad => ({
      failure: {
        url,
        source,
        fromSource,
        ...(reason ? { reason } : {}),
        error: error instanceof Error ? error : new Error(String(error)),
      },
    });
    let url: string;
    try {
      url = await this.resolveImportUrl(fromSource, source);
    } catch (err) {
      return failure(source, err);
    }
    let graph: LoadedGraph;
    try {
      graph = await this.loadGraphWith(url, options, false);
    } catch (err) {
      return failure(url, err);
    }
    const manifests = graph.entry.owner.manifests;
    const moduleDoc = manifests.find((m) => m && isModuleKind(m.kind));
    if (isBuiltinVocabularyRoot(manifests[0])) {
      return failure(
        graph.rootSource,
        new Error(`it is the built-in vocabulary archive, which is read, never run.`),
        "unusable-target",
      );
    }
    if (moduleDoc?.kind !== "Telo.Application") {
      return failure(
        graph.rootSource,
        new Error(
          moduleDoc
            ? `it is a ${moduleDoc.kind}, which is imported, never run. Name the source of a ` +
                `Telo.Application.`
            : `it holds no Telo.Application document. Fetched from: ${graph.rootSource}.`,
        ),
        "unusable-target",
      );
    }
    return { graph };
  }

  /** Resolve an `import` URL against the file it appears in. Relative /
   *  absolute-path forms run through the owning `ManifestSource`'s
   *  `resolveRelative`; scheme-qualified refs and full URLs pass through
   *  unchanged. Exposed so the import-controller (and any other
   *  caller-side resolver) lands on the *exact same* canonical URL the
   *  loader used when walking the entry graph — divergent resolution
   *  would silently break optimizations like `canonicalize()`-keyed
   *  cache hits whenever a non-trivial `ManifestSource.resolveRelative`
   *  is in play.
   *
   *  A source that knows how imports inside `fromSource` resolve answers first
   *  (`ManifestSource.resolveRelativeImport`): a module read out of an artifact
   *  may import a module shipped inside that artifact, which no path rule over
   *  the file's own location can name. */
  async resolveImportUrl(fromSource: string, importSource: string): Promise<string> {
    if (!isLocalPathSource(importSource)) return importSource;
    for (const source of this.sources) {
      const resolved = await source.resolveRelativeImport?.(fromSource, importSource);
      if (resolved !== undefined) return resolved;
    }
    return this.pick(fromSource).resolveRelative(fromSource, importSource);
  }

  private assertSingleModuleDeclaration(file: LoadedFile): void {
    const moduleManifests = file.manifests.filter(
      (m): m is ResourceManifest => !!m && isModuleKind(m.kind),
    );
    if (moduleManifests.length > 1) {
      const kinds = moduleManifests.map((m) => m.kind).join(", ");
      throw new Error(
        `File '${file.source}' contains ${moduleManifests.length} module declarations (${kinds}). ` +
          `A file may declare at most one Telo.Application or Telo.Library.`,
      );
    }
  }

  private assertNoSystemKindsInPartialContext(file: LoadedFile, isPartial: boolean): void {
    if (!isPartial) return;
    for (const m of file.manifests) {
      if (!m) continue;
      const kind = m.kind;
      if (typeof kind === "string" && SYSTEM_KINDS.has(kind)) {
        throw new Error(
          `Included file '${file.source}' contains '${kind}' which is not allowed in partial files. ` +
            `Only the owner telo.yaml may declare ${kind} resources.`,
        );
      }
    }
  }

  private async resolveIncludes(
    ownerSource: string,
    patterns: string[],
    source: ManifestSource,
  ): Promise<string[]> {
    const hasGlobs = patterns.some((p) => /[*?{}\[\]]/.test(p));
    if (hasGlobs) {
      if (!source.expandGlob) {
        throw new Error(
          `Include patterns in '${ownerSource}' contain globs but the source for this URL ` +
            `does not support glob expansion. Use explicit file paths instead of patterns like: ` +
            patterns.filter((p) => /[*?{}\[\]]/.test(p)).join(", "),
        );
      }
      return source.expandGlob(ownerSource, patterns);
    }
    return [...new Set(patterns.map((p) => source.resolveRelative(ownerSource, p)))];
  }

  /** Find the owning telo.yaml for `fileUrl` (or use it directly if it's an
   *  owner) and return the `LoadedGraph` rooted at that owner. Returns
   *  `null` only when `fileUrl` is neither an owner nor reachable from one
   *  via parent-directory traversal. */
  async loadGraphForFile(
    fileUrl: string,
    options?: LoadOptions,
  ): Promise<{ graph: LoadedGraph; ownerUrl: string } | null> {
    try {
      const owner = await this.loadFile(fileUrl, options);
      const isOwner = owner.manifests.some((m) => m && isModuleKind(m.kind));
      if (isOwner) {
        const graph = await this.loadGraph(fileUrl, options);
        return { graph, ownerUrl: graph.rootSource };
      }
    } catch (err) {
      const normalized = fileUrl.replace(/\\/g, "/");
      if (
        normalized.endsWith(`/${DEFAULT_MANIFEST_FILENAME}`) ||
        normalized === DEFAULT_MANIFEST_FILENAME
      ) {
        throw err;
      }
    }

    const source = this.pick(fileUrl);
    if (!source.resolveOwnerOf) return null;
    const ownerUrl = await source.resolveOwnerOf(fileUrl);
    if (!ownerUrl) return null;
    const graph = await this.loadGraph(ownerUrl, options);
    return { graph, ownerUrl: graph.rootSource };
  }

}
