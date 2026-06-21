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
import { isModuleKind } from "./module-kinds.js";
import { parseLoadedFile } from "./parse-loaded-file.js";
import { reconcileModuleVersions } from "./reconcile-module-versions.js";
import {
  DEFAULT_MANIFEST_FILENAME,
  type LoadOptions,
  type LoaderInitOptions,
  type ManifestSource,
} from "./types.js";

const SYSTEM_KINDS = new Set([
  "Telo.Application",
  "Telo.Library",
  "Telo.Import",
  "Telo.Definition",
]);

/** File cache variant tags: compile (c/r) × desugarImports (d/n). A desugared
 *  and a raw load of the same file are distinct entries so neither sees the
 *  wrong manifest tree. */
const CACHE_VARIANTS = ["rn", "rd", "cn", "cd"] as const;
function variantKey(options?: LoadOptions): string {
  return `${options?.compile ? "c" : "r"}${options?.desugarImports ? "d" : "n"}`;
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
   *  source's `read()` (a `fetch` for `RegistrySource`, a disk read for
   *  `LocalFileSource`). */
  private readonly urlToSource = new Map<string, string>();

  protected sources: ManifestSource[];
  private readonly celEnv: Environment;

  /** Sources are resolved in order — the first whose `supports(url)` matches
   *  wins. The caller (composition root) decides which concrete sources exist
   *  and supplies them; `defaultSources()` bundles the browser-safe built-ins
   *  (HTTP + registry) for the common case. `register()` prepends a source at
   *  runtime. */
  constructor(sources: ManifestSource[] = [], options: LoaderInitOptions = {}) {
    this.sources = [...sources];
    this.celEnv = buildCelEnvironment(options.celHandlers);
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
    // twice (twice over the network for `RegistrySource`).
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
   *  `desugarImports` see synthetic Telo.Import manifests. */
  private parseAndMaybeDesugar(
    source: string,
    requestedUrl: string,
    text: string,
    options?: LoadOptions,
  ): LoadedFile {
    const loaded = parseLoadedFile(source, requestedUrl, text, {
      compile: options?.compile,
      celEnv: this.celEnv,
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
              fromSource: file.source,
              error: err instanceof Error ? err : new Error(String(err)),
            });
            continue;
          }

          // Resolve the file we'll fetch through the source chain to get the
          // canonical `source` URL — same identity used as the modules-map key.
          let targetCanonical: string;
          let targetModule: LoadedModule | undefined;
          if (modules.has(resolvedTarget)) {
            targetCanonical = resolvedTarget;
            targetModule = modules.get(resolvedTarget);
          } else {
            try {
              const loaded = await this.loadModule(resolvedTarget, options);
              targetCanonical = loaded.owner.source;
              if (!modules.has(targetCanonical)) {
                modules.set(targetCanonical, loaded);
                targetModule = loaded;
              } else {
                targetModule = modules.get(targetCanonical);
              }
            } catch (err) {
              const e = err instanceof Error ? err : new Error(String(err));
              (e as { sourceLine?: number }).sourceLine = sourceLine;
              errors.push({ url: resolvedTarget, fromSource: file.source, error: e });
              continue;
            }
          }

          // Resolve target identity from its Telo.Library doc and stamp it
          // on the edge — flattenForAnalyzer reads from the edge directly,
          // never re-deriving from manifest.metadata.
          let targetModuleName: string | null = null;
          let targetNamespace: string | null = null;
          if (targetModule) {
            const lib = targetModule.owner.manifests.find(
              (d) => d?.kind === "Telo.Library",
            );
            const libName = lib?.metadata?.name;
            if (typeof libName === "string") targetModuleName = libName;
            const libNs = (lib?.metadata as { namespace?: string | null } | undefined)
              ?.namespace;
            if (typeof libNs === "string") targetNamespace = libNs;
          }

          aliases.set(alias, {
            targetSource: targetCanonical,
            targetModuleName,
            targetNamespace,
          });

          if (targetModule && !visited.has(targetCanonical)) {
            visited.add(targetCanonical);
            this.assertImportTargetIsLibrary(targetModule, importSource, sourceLine);
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
      versionDiagnostics: diagnostics,
      errors,
    };
  }

  /** Resolve an `import` URL against the file it appears in. Relative /
   *  absolute-path forms run through the owning `ManifestSource`'s
   *  `resolveRelative`; registry refs and full URLs pass through
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

  private assertImportTargetIsLibrary(
    target: LoadedModule,
    importSource: string,
    sourceLine: number,
  ): void {
    const importedLibrary = target.owner.manifests.find((m) => m?.kind === "Telo.Library");
    const importedApplication = target.owner.manifests.find(
      (m) => m?.kind === "Telo.Application",
    );
    if (importedApplication) {
      const e = new Error(
        `Telo.Import target '${importSource}' is a Telo.Application. ` +
          `Only Telo.Library modules may be imported. Applications are run directly, not imported.`,
      );
      (e as { sourceLine?: number }).sourceLine = sourceLine;
      throw e;
    }
    if (!importedLibrary) {
      const kinds = target.owner.manifests
        .map((m) => m?.kind)
        .filter((k): k is string => typeof k === "string");
      const detail = kinds.length
        ? `Fetched ${target.owner.manifests.length} document(s) with kinds [${kinds.join(", ")}].`
        : `Fetched manifest contained no recognizable Telo documents — check that the source ` +
          `serves a Telo.Library manifest and not an upstream error page.`;
      const e = new Error(
        `Telo.Import target '${importSource}' did not resolve to a Telo.Library. ` +
          `Fetched from: ${target.owner.source}. ${detail}`,
      );
      (e as { sourceLine?: number }).sourceLine = sourceLine;
      throw e;
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
