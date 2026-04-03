import type { ResourceManifest } from "@telorun/sdk";
import { isMap, isPair, isScalar, isSeq, parseAllDocuments, type Document } from "yaml";
import { HttpAdapter } from "./adapters/http-adapter.js";
import { RegistryAdapter } from "./adapters/registry-adapter.js";
import { precompileDoc } from "./precompile.js";
import type { LoadOptions, ManifestAdapter, Position, PositionIndex } from "./types.js";

export class Loader {
  protected adapters: ManifestAdapter[] = [new HttpAdapter(), new RegistryAdapter()];

  constructor(extraAdapters: ManifestAdapter[] = []) {
    this.adapters.unshift(...extraAdapters);
  }

  register(adapter: ManifestAdapter): this {
    this.adapters.unshift(adapter);
    return this;
  }

  private pick(url: string): ManifestAdapter {
    const a = this.adapters.find((a) => a.supports(url));
    if (!a) throw new Error(`No adapter found for: ${url}`);
    return a;
  }

  async resolveEntryPoint(url: string): Promise<string> {
    const { source } = await this.pick(url).read(url);
    return source;
  }

  async loadModule(url: string, options?: LoadOptions): Promise<ResourceManifest[]> {
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

      let compiledDocs: unknown[];
      if (options?.compile) {
        try {
          const result = precompileDoc(rawDoc);
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

    const moduleManifests = resolved.filter((m) => m.kind === "Kernel.Module");
    if (moduleManifests.length > 1) {
      throw new Error(
        `File '${source}' contains ${moduleManifests.length} Kernel.Module declarations. Maximum one is allowed.`,
      );
    }
    const moduleManifest = moduleManifests[0];
    const moduleName = moduleManifest?.metadata?.name as string | undefined;
    if (moduleName) {
      for (const manifest of resolved) {
        if (manifest.kind !== "Kernel.Module" && !manifest.metadata?.module) {
          manifest.metadata = { ...manifest.metadata, module: moduleName };
        }
      }
    }

    return resolved;
  }

  async loadManifests(entryUrl: string): Promise<ResourceManifest[]> {
    const visited = new Set<string>([entryUrl]);
    const entry = await this.loadModule(entryUrl);

    const importedDefs: ResourceManifest[] = [];
    const queue: ResourceManifest[] = [...entry];

    while (queue.length > 0) {
      const m = queue.shift()!;
      if (m.kind !== "Kernel.Import") continue;
      const importSource = (m as any).source as string | undefined;
      if (!importSource) continue;
      const base = (m.metadata as any)?.source ?? entryUrl;
      const importUrl = this.pick(base).resolveRelative(base, importSource);
      if (visited.has(importUrl)) continue;
      visited.add(importUrl);
      let imported: ResourceManifest[];
      try {
        imported = await this.loadModule(importUrl);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        (e as any).sourceLine = (m.metadata as any)?.sourceLine ?? 0;
        throw e;
      }
      const importedModule = imported.find((im) => im.kind === "Kernel.Module");
      if (importedModule?.metadata?.name) {
        m.metadata = {
          ...m.metadata,
          resolvedModuleName: importedModule.metadata.name as string,
          resolvedNamespace: (importedModule.metadata as any).namespace ?? null,
        };
      }
      for (const im of imported) {
        if (im.kind === "Kernel.Definition") importedDefs.push(im);
        if (im.kind === "Kernel.Import") queue.push(im);
      }
    }

    return [...entry, ...importedDefs];
  }
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
