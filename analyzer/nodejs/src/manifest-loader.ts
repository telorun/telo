import type { Environment } from "@marcbachmann/cel-js";
import type { ResourceManifest } from "@telorun/sdk";
import { buildCelEnvironment } from "./cel-environment.js";
import type {
  GraphLoadError,
  ImportEdge,
  LoadedFile,
  LoadedGraph,
  LoadedModule,
} from "./loaded-types.js";
import { desugarLoadedFile } from "./inline-imports.js";
import type { MigrationEntry } from "./migrations/types.js";
import { isModuleKind } from "./module-kinds.js";
import { parseLoadedFile } from "./parse-loaded-file.js";
import { reconcileModuleVersions } from "./reconcile-module-versions.js";
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
 *  module nobody declared. */
type ImportTargetIdentity =
  | { name: string; namespace: string | null }
  | { unusable: string };

function importTargetIdentity(target: LoadedModule, importSource: string): ImportTargetIdentity {
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

const SYSTEM_KINDS = new Set([
  "Telo.Application",
  "Telo.Library",
  "Telo.Import",
  "Telo.Definition",
]);

/** File cache variant tags: compile (c/r) × desugarImports (d/n) × migrate
 *  (m/x). A desugared and a raw load of the same file are distinct entries so
 *  neither sees the wrong manifest tree, and the migration axis is there for
 *  the same reason — the editor's round-trip view and `telo migrate` must see
 *  the author's spelling, everything else the current one. */
const CACHE_VARIANTS = [
  "rnx", "rdx", "cnx", "cdx",
  "rnm", "rdm", "cnm", "cdm",
] as const;
function variantKey(options?: LoadOptions): string {
  return `${options?.compile ? "c" : "r"}${options?.desugarImports ? "d" : "n"}${
    options?.migrate ? "m" : "x"
  }`;
}

export class Loader {
  /** LoadedFile cache keyed by `${compile ? "compiled" : "raw"}:${source}`.
   *  Same dual-keying as the legacy ResourceManifest[] cache: a compile-mode
   *  caller (kernel) and a raw-mode caller (analyzer/editor) on the same file
   *  get distinct entries, so neither sees the wrong manifest tree. */
  private readonly fileCache = new Map<string, LoadedFile>();

  /** requestUrl → canonical `source`. Lets `loadFile` skip the source read
   *  when a URL it has already canonicalised is requested again — kernel
   *  load → boot and the import-controller each ask the loader for the same
   *  modules. Without this fast path every duplicate request re-runs the
   *  source's `read()` (a `fetch` for `HttpSource`, a disk read for
   *  `LocalFileSource`). */
  private readonly urlToSource = new Map<string, string>();

  protected sources: ManifestSource[];
  private readonly celEnv: Environment;
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
    for (const variant of CACHE_VARIANTS) {
      this.fileCache.delete(`${variant}:${source}`);
    }
  }

  // --- New API: returns LoadedFile / LoadedModule / LoadedGraph ----------

  /** Read one file via the source chain and parse it into a LoadedFile.
   *  The result is shared with `Loader.fileCache`. Callers that want a
   *  private mutable copy must call `parseLoadedFile` directly with the
   *  LoadedFile's `text`. */
  async loadFile(url: string, options?: LoadOptions): Promise<LoadedFile> {
    const variant = variantKey(options);
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
        const reparsed = this.parseAndMaybeDesugar(knownSource, url, altText, options);
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

    const loaded = this.parseAndMaybeDesugar(source, url, text, options);
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
  ): LoadedFile {
    const loaded = parseLoadedFile(source, requestedUrl, text, {
      compile: options?.compile,
      celEnv: this.celEnv,
      migrate: options?.migrate,
      migrations: this.migrations,
    });
    return options?.desugarImports ? desugarLoadedFile(loaded) : loaded;
  }

  /** Raw text of any already-cached variant for `source`, so a cache miss on
   *  one (compile, desugar) variant reparses without a second source read. */
  private findCachedText(source: string): string | undefined {
    for (const v of CACHE_VARIANTS) {
      const cached = this.fileCache.get(`${v}:${source}`);
      if (cached) return cached.text;
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
    const partials: LoadedFile[] = [];
    for (const includedUrl of includedFiles) {
      const partial = await this.loadFile(includedUrl, options);
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
    const entry = await this.loadModule(entryUrl, options);
    const rootSource = entry.owner.source;

    const modules = new Map<string, LoadedModule>();
    modules.set(rootSource, entry);
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

          let resolvedTarget: string;
          try {
            resolvedTarget = this.resolveImportUrl(file.source, importSource);
          } catch (err) {
            errors.push({
              url: importSource,
              source: importSource,
              fromSource: file.source,
              alias,
              sourceLine,
              error: err instanceof Error ? err : new Error(String(err)),
            });
            continue;
          }

          // Resolve the file we'll fetch through the source chain to get the
          // canonical `source` URL — same identity used as the modules-map key.
          let targetCanonical: string;
          let targetModule: LoadedModule;
          if (modules.has(resolvedTarget)) {
            targetCanonical = resolvedTarget;
            targetModule = modules.get(resolvedTarget)!;
          } else {
            try {
              const loaded = await this.loadModule(resolvedTarget, options);
              targetCanonical = loaded.owner.source;
              if (!modules.has(targetCanonical)) {
                modules.set(targetCanonical, loaded);
                targetModule = loaded;
              } else {
                targetModule = modules.get(targetCanonical)!;
              }
            } catch (err) {
              const e = err instanceof Error ? err : new Error(String(err));
              (e as { sourceLine?: number }).sourceLine = sourceLine;
              errors.push({
                url: resolvedTarget,
                source: importSource,
                fromSource: file.source,
                alias,
                sourceLine,
                error: e,
              });
              continue;
            }
          }

          // Resolve target identity from its Telo.Library doc and stamp it on
          // the edge — flattenForAnalyzer reads from the edge directly, never
          // re-deriving from manifest.metadata.
          //
          // Checked per IMPORT rather than per distinct target: an import
          // pointing at a module something else already reached (the entry
          // application above all) would otherwise skip the check entirely and
          // register a nameless edge. An unusable target is recorded exactly
          // like an unfetchable one — an error against this import, no edge,
          // and the rest of the graph still loads — so no consumer has to know
          // the difference between the two ways an import can fail.
          const identity = importTargetIdentity(targetModule, importSource);
          if ("unusable" in identity) {
            const e = new Error(identity.unusable);
            (e as { sourceLine?: number }).sourceLine = sourceLine;
            errors.push({
              url: targetCanonical,
              source: importSource,
              fromSource: file.source,
              alias,
              sourceLine,
              reason: "unusable-target",
              error: e,
            });
            continue;
          }

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
      parseDiagnostics: collectParseDiagnostics(modules),
      errors,
    };
  }

  /** Resolve an `import` URL against the file it appears in. Relative /
   *  absolute-path forms run through the owning `ManifestSource`'s
   *  `resolveRelative`; scheme-qualified refs and full URLs pass through
   *  unchanged. Exposed so the import-controller (and any other
   *  caller-side resolver) lands on the *exact same* canonical URL the
   *  loader used when walking the entry graph — divergent resolution
   *  would silently break optimizations like `canonicalize()`-keyed
   *  cache hits whenever a non-trivial `ManifestSource.resolveRelative`
   *  is in play. */
  resolveImportUrl(fromSource: string, importSource: string): string {
    if (importSource.startsWith(".") || importSource.startsWith("/")) {
      return this.pick(fromSource).resolveRelative(fromSource, importSource);
    }
    return importSource;
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
