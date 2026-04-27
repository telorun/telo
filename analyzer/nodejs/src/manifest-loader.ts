import type { Environment } from "@marvec/cel-vm";
import { isCompiledValue, type ResourceManifest } from "@telorun/sdk";
import { isMap, isPair, isScalar, isSeq, parseAllDocuments, type Document } from "yaml";
import { HttpSource } from "./sources/http-source.js";
import { RegistrySource } from "./sources/registry-source.js";
import { buildCelEnvironment } from "./cel-environment.js";
import { isModuleKind } from "./module-kinds.js";
import { precompileDoc } from "./precompile.js";
import {
  DEFAULT_MANIFEST_FILENAME,
  type LoadOptions,
  type LoaderInitOptions,
  type ManifestSource,
  type Position,
  type PositionIndex,
} from "./types.js";

const SYSTEM_KINDS = new Set([
  "Telo.Application",
  "Telo.Library",
  "Telo.Import",
  "Telo.Definition",
]);

export class Loader {
  private readonly moduleCache = new Map<
    string,
    { text: string; manifests: ResourceManifest[] }
  >();

  protected sources: ManifestSource[];
  private readonly celEnv: Environment;

  constructor(extraSourcesOrOptions: ManifestSource[] | LoaderInitOptions = []) {
    const options: LoaderInitOptions = Array.isArray(extraSourcesOrOptions)
      ? { extraSources: extraSourcesOrOptions }
      : extraSourcesOrOptions;

    const includeHttpSource = options.includeHttpSource ?? true;
    const includeRegistrySource = options.includeRegistrySource ?? true;

    this.sources = [];
    if (includeHttpSource) this.sources.push(new HttpSource());
    if (includeRegistrySource) this.sources.push(new RegistrySource(options.registryUrl));

    if (options.extraSources?.length) {
      this.sources.unshift(...options.extraSources);
    }

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
    const { source } = await this.pick(url).read(url);
    return source;
  }

  async loadModule(url: string, options?: LoadOptions): Promise<ResourceManifest[]> {
    const { text, source } = await this.pick(url).read(url);
    const cacheKey = `${options?.compile ? "compiled" : "raw"}:${source}`;
    const cached = this.moduleCache.get(cacheKey);
    if (cached && cached.text === text) {
      return cloneManifestArray(cached.manifests);
    }

    const parsedDocuments = parseAllDocuments(text);
    const rawDocs = parsedDocuments.map((d) => d.toJSON());
    const offsets = documentLineOffsets(text);
    const lineOffsets = buildLineOffsets(text);

    const resolved: ResourceManifest[] = [];
    let docIdx = 0;
    for (const rawDoc of rawDocs) {
      const currentDocIdx = docIdx++;
      const sourceLine = offsets[currentDocIdx] ?? 0;
      const positionIndex = buildPositionIndex(parsedDocuments[currentDocIdx], lineOffsets);
      if (rawDoc === null || rawDoc === undefined) continue;

      let compiledDocs: unknown[];
      if (options?.compile) {
        try {
          const result = precompileDoc(rawDoc, this.celEnv);
          compiledDocs = Array.isArray(result) ? result : [result];
        } catch (error) {
          throw new Error(
            `Failed to compile manifest in ${source}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else {
        compiledDocs = [rawDoc];
      }

      for (const doc of compiledDocs) {
        if (doc === null || doc === undefined) continue;
        const manifest = doc as ResourceManifest;
        const metadata = { ...manifest.metadata, source, sourceLine };
        // positionIndex is non-enumerable so it is invisible to spread, JSON.stringify,
        // and schema validation — but still accessible via (m.metadata as any).positionIndex.
        Object.defineProperty(metadata, "positionIndex", {
          value: positionIndex,
          enumerable: false,
          writable: true,
          configurable: true,
        });
        resolved.push({ ...manifest, metadata });
      }
    }

    const moduleManifests = resolved.filter((m) => isModuleKind(m.kind));
    if (moduleManifests.length > 1) {
      const kinds = moduleManifests.map((m) => m.kind).join(", ");
      throw new Error(
        `File '${source}' contains ${moduleManifests.length} module declarations (${kinds}). ` +
          `A file may declare at most one Telo.Application or Telo.Library.`,
      );
    }
    const moduleManifest = moduleManifests[0];
    const moduleName = moduleManifest?.metadata?.name as string | undefined;
    if (moduleName) {
      for (const manifest of resolved) {
        if (!isModuleKind(manifest.kind) && !manifest.metadata?.module) {
          const pi = (manifest.metadata as any)?.positionIndex;
          manifest.metadata = { ...manifest.metadata, module: moduleName };
          if (pi) {
            Object.defineProperty(manifest.metadata, "positionIndex", {
              value: pi,
              enumerable: false,
              writable: true,
              configurable: true,
            });
          }
        }
      }
    }

    // Expand include directives — load partial files into the same module scope.
    // Results with includes are NOT cached because partial file content is not
    // tracked in the cache key — the cache would serve stale data if a partial changes.
    let hasIncludes = false;
    if (moduleManifest) {
      const includePatterns = (moduleManifest as any).include as string[] | undefined;
      if (includePatterns?.length) {
        hasIncludes = true;
        const picked = this.pick(source);
        const includedFiles = await this.resolveIncludes(source, includePatterns, picked);
        for (const includedUrl of includedFiles) {
          const partialManifests = await this.loadPartialFile(includedUrl, moduleName, options);
          resolved.push(...partialManifests);
        }
      }
    }

    if (!hasIncludes) {
      this.moduleCache.set(cacheKey, { text, manifests: resolved });
    }
    return cloneManifestArray(resolved);
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
    // Literal relative paths — deduplicate in case the same file appears under multiple patterns.
    return [...new Set(patterns.map((p) => source.resolveRelative(ownerSource, p)))];
  }

  private async loadPartialFile(
    url: string,
    ownerModuleName: string | undefined,
    options?: LoadOptions,
  ): Promise<ResourceManifest[]> {
    const { text, source } = await this.pick(url).read(url);

    const parsedDocuments = parseAllDocuments(text);
    const rawDocs = parsedDocuments.map((d) => d.toJSON());
    const offsets = documentLineOffsets(text);
    const lineOffsets = buildLineOffsets(text);
    const resolved: ResourceManifest[] = [];
    let docIdx = 0;

    for (const rawDoc of rawDocs) {
      const currentDocIdx = docIdx++;
      const sourceLine = offsets[currentDocIdx] ?? 0;
      const positionIndex = buildPositionIndex(parsedDocuments[currentDocIdx], lineOffsets);
      if (rawDoc === null || rawDoc === undefined) continue;

      const kind = rawDoc.kind as string | undefined;
      if (kind && SYSTEM_KINDS.has(kind)) {
        throw new Error(
          `Included file '${source}' contains '${kind}' which is not allowed in partial files. ` +
            `Only the owner telo.yaml may declare ${kind} resources.`,
        );
      }

      let compiledDocs: unknown[];
      if (options?.compile) {
        try {
          const result = precompileDoc(rawDoc, this.celEnv);
          compiledDocs = Array.isArray(result) ? result : [result];
        } catch (error) {
          throw new Error(
            `Failed to compile manifest in ${source}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else {
        compiledDocs = [rawDoc];
      }

      for (const doc of compiledDocs) {
        if (doc === null || doc === undefined) continue;
        const manifest = doc as ResourceManifest;
        const metadata = {
          ...manifest.metadata,
          source,
          sourceLine,
          ...(ownerModuleName && !manifest.metadata?.module ? { module: ownerModuleName } : {}),
        };
        Object.defineProperty(metadata, "positionIndex", {
          value: positionIndex,
          enumerable: false,
          writable: true,
          configurable: true,
        });
        resolved.push({ ...manifest, metadata });
      }
    }

    return resolved;
  }

  async loadModuleForFile(
    fileUrl: string,
  ): Promise<{
    ownerUrl: string;
    manifests: ResourceManifest[];
    sourceManifests: Map<string, ResourceManifest[]>;
  } | null> {
    // Try loading as a regular module first (it might be a telo.yaml itself).
    // Use loadManifests (not loadModule) so imported definitions are included —
    // otherwise the analyzer won't know about kinds from Telo.Import sources.
    try {
      const docs = await this.loadModule(fileUrl);
      const hasModule = docs.some((d) => isModuleKind(d.kind));
      if (hasModule) {
        const { source } = await this.pick(fileUrl).read(fileUrl);
        const manifests = await this.loadManifests(fileUrl);
        return { ownerUrl: source, manifests, sourceManifests: groupBySource(manifests) };
      }
    } catch (err) {
      // If the file looks like an owner manifest (named telo.yaml), rethrow —
      // a broken owner shouldn't silently fall through to parent lookup.
      const normalized = fileUrl.replace(/\\/g, "/");
      if (normalized.endsWith(`/${DEFAULT_MANIFEST_FILENAME}`) || normalized === DEFAULT_MANIFEST_FILENAME) {
        throw err;
      }
      // Otherwise fall through to owner lookup — this is likely a partial file
    }

    // Find the owning telo.yaml via parent-directory traversal
    const source = this.pick(fileUrl);
    if (!source.resolveOwnerOf) return null;
    const ownerUrl = await source.resolveOwnerOf(fileUrl);
    if (!ownerUrl) return null;

    // Load the owner module (which will load included files via include expansion)
    const manifests = await this.loadManifests(ownerUrl);
    return { ownerUrl, manifests, sourceManifests: groupBySource(manifests) };
  }

  async loadModuleGraph(
    entryUrl: string,
    onError?: (url: string, error: Error) => void,
  ): Promise<Map<string, ResourceManifest[]>> {
    const visited = new Set<string>([entryUrl]);
    const result = new Map<string, ResourceManifest[]>();

    const entry = await this.loadModule(entryUrl);
    result.set(entryUrl, entry);

    const queue: ResourceManifest[] = [...entry];

    while (queue.length > 0) {
      const m = queue.shift()!;
      if (m.kind !== "Telo.Import") continue;
      const importSource = (m as any).source as string | undefined;
      if (!importSource) continue;
      const base = (m.metadata as any)?.source ?? entryUrl;
      const importUrl =
        importSource.startsWith(".") || importSource.startsWith("/")
          ? this.pick(base).resolveRelative(base, importSource)
          : importSource;
      if (visited.has(importUrl)) continue;
      visited.add(importUrl);
      let imported: ResourceManifest[];
      try {
        imported = await this.loadModule(importUrl);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        onError?.(importUrl, error);
        continue;
      }
      result.set(importUrl, imported);
      for (const im of imported) {
        if (im.kind === "Telo.Import") queue.push(im);
      }
    }

    return result;
  }

  async loadManifests(entryUrl: string): Promise<ResourceManifest[]> {
    const visited = new Set<string>([entryUrl]);
    // Cache resolved library identity per import URL so a Telo.Import re-encountered
    // through a different chain still gets `resolvedModuleName` / `resolvedNamespace`
    // stamped — without re-loading the target. The early `visited` short-circuit used
    // to silently leave duplicate Telo.Imports unstamped, which broke alias resolution
    // when the same library was imported by two different files in the same analysis set.
    const libraryIdentityByUrl = new Map<
      string,
      { name: string; namespace: string | null }
    >();
    const entry = await this.loadModule(entryUrl);

    // Forward Telo.Definition, Telo.Abstract, AND Telo.Import docs from imported
    // libraries to the analyzer so its downstream passes can see them:
    //  - Definitions / Abstracts feed cross-package `x-telo-ref` resolution and
    //    `extends` target validation.
    //  - Imports feed the per-library alias resolver — alias-form `extends` inside
    //    a library (e.g. ai-openai's `extends: Ai.Model`) resolves against THAT
    //    library's own `Telo.Import` declarations, not the root manifest's. Without
    //    forwarding the imports, importing such a library would surface a spurious
    //    EXTENDS_MALFORMED for an alias the library legitimately uses internally.
    // Alias resolution itself stays in the analyzer; the loader's only semantic
    // action is stamping `resolvedModuleName` / `resolvedNamespace` — recording the
    // result of loading. Identity is cached per URL (see libraryIdentityByUrl above)
    // because the same library can be reached through multiple chains, and every
    // Telo.Import doc — including the duplicates short-circuited by `visited` —
    // must end up stamped, otherwise per-scope alias resolution falls back to a
    // path-derived string (e.g. "abstract-lib.yaml") and produces wrong canonical
    // kinds.
    const importedDefs: ResourceManifest[] = [];
    const queue: ResourceManifest[] = [...entry];

    while (queue.length > 0) {
      const m = queue.shift()!;
      if (m.kind !== "Telo.Import") continue;
      const importSource = (m as any).source as string | undefined;
      if (!importSource) continue;
      const base = (m.metadata as any)?.source ?? entryUrl;
      const importUrl =
        importSource.startsWith(".") || importSource.startsWith("/")
          ? this.pick(base).resolveRelative(base, importSource)
          : importSource;

      if (!visited.has(importUrl)) {
        visited.add(importUrl);
        let imported: ResourceManifest[];
        try {
          imported = await this.loadModule(importUrl);
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          (e as any).sourceLine = (m.metadata as any)?.sourceLine ?? 0;
          throw e;
        }
        // Import target must be a Telo.Library. Check the Library branch
        // explicitly rather than "anything that's a module kind" so that a
        // future third kind can't silently slip past as a valid import target.
        const importedLibrary = imported.find((im) => im.kind === "Telo.Library");
        const importedApplication = imported.find((im) => im.kind === "Telo.Application");
        if (importedApplication) {
          const e = new Error(
            `Telo.Import target '${importSource}' is a Telo.Application. ` +
              `Only Telo.Library modules may be imported. Applications are run directly, not imported.`,
          );
          (e as any).sourceLine = (m.metadata as any)?.sourceLine ?? 0;
          throw e;
        }
        if (importedLibrary?.metadata?.name) {
          libraryIdentityByUrl.set(importUrl, {
            name: importedLibrary.metadata.name as string,
            namespace: ((importedLibrary.metadata as any).namespace as string | null) ?? null,
          });
        }
        for (const im of imported) {
          if (
            im.kind === "Telo.Definition" ||
            im.kind === "Telo.Abstract" ||
            im.kind === "Telo.Import"
          ) {
            importedDefs.push(im);
          }
          if (im.kind === "Telo.Import") queue.push(im);
        }
      }

      // Stamp m with cached identity (works for both fresh and duplicate visits).
      const identity = libraryIdentityByUrl.get(importUrl);
      if (identity) {
        const pi = (m.metadata as any)?.positionIndex;
        m.metadata = {
          ...m.metadata,
          resolvedModuleName: identity.name,
          resolvedNamespace: identity.namespace,
        };
        if (pi) {
          Object.defineProperty(m.metadata, "positionIndex", {
            value: pi,
            enumerable: false,
            writable: true,
            configurable: true,
          });
        }
      }
    }

    return [...entry, ...importedDefs];
  }
}

function cloneManifestArray(manifests: ResourceManifest[]): ResourceManifest[] {
  return manifests.map((manifest) => cloneManifestValue(manifest));
}

function cloneManifestValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneManifestValue(entry)) as T;
  }
  if (isCompiledValue(value)) {
    return value;
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const clone: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      clone[key] = cloneManifestValue(entry);
    }
    const positionIndex = Object.getOwnPropertyDescriptor(source, "positionIndex");
    if (positionIndex) {
      Object.defineProperty(clone, "positionIndex", positionIndex);
    }
    return clone as T;
  }
  return value;
}

function groupBySource(manifests: ResourceManifest[]): Map<string, ResourceManifest[]> {
  const map = new Map<string, ResourceManifest[]>();
  for (const m of manifests) {
    const src = (m.metadata?.source as string) ?? "unknown";
    let list = map.get(src);
    if (!list) {
      list = [];
      map.set(src, list);
    }
    list.push(m);
  }
  return map;
}

function documentLineOffsets(text: string): number[] {
  const offsets = [0];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimEnd();
    if (t === "---" || t.startsWith("--- ")) offsets.push(i + 1);
  }
  return offsets;
}

/** Builds a byte-offset-to-line/character lookup table from raw text. */
function buildLineOffsets(text: string): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

function offsetToPosition(offset: number, lineOffsets: number[]): Position {
  let lo = 0;
  let hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineOffsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: offset - lineOffsets[lo] };
}

/** Walks the YAML AST and records source ranges for every field value, keyed by
 *  dotted path (e.g. "kind", "config.handler", "config.routes[0].path"). */
function buildPositionIndex(doc: Document, lineOffsets: number[]): PositionIndex {
  const index: PositionIndex = new Map();

  function recordNode(node: any, path: string): void {
    if (!node || !node.range) return;
    const [start, , end] = node.range as [number, number, number];
    index.set(path, {
      start: offsetToPosition(start, lineOffsets),
      end: offsetToPosition(end, lineOffsets),
    });
  }

  function walk(node: any, path: string): void {
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isPair(pair)) continue;
        const key = isScalar(pair.key) ? String(pair.key.value) : null;
        if (key == null) continue;
        const childPath = path ? `${path}.${key}` : key;
        if (pair.value != null) {
          recordNode(pair.value, childPath);
          walk(pair.value, childPath);
        }
      }
    } else if (isSeq(node)) {
      for (let i = 0; i < node.items.length; i++) {
        const item = node.items[i];
        const childPath = `${path}[${i}]`;
        recordNode(item, childPath);
        walk(item, childPath);
      }
    }
  }

  if (doc.contents) {
    walk(doc.contents, "");
  }

  return index;
}
