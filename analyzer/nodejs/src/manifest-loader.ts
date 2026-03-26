import * as yaml from "js-yaml";
import type { ResourceManifest } from "@telorun/sdk";
import type { ManifestAdapter, LoadOptions } from "./types.js";
import { HttpAdapter } from "./adapters/http-adapter.js";
import { RegistryAdapter } from "./adapters/registry-adapter.js";

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

  async loadModule(url: string, options?: LoadOptions): Promise<ResourceManifest[]> {
    const { text, source } = await this.pick(url).read(url);
    const rawDocs = yaml.loadAll(text) as unknown[];
    const offsets = documentLineOffsets(text);

    const resolved: ResourceManifest[] = [];
    let docIdx = 0;
    for (const rawDoc of rawDocs) {
      const sourceLine = offsets[docIdx++] ?? 0;
      if (rawDoc === null || rawDoc === undefined) continue;

      let compiledDocs: unknown[];
      if (options?.compile) {
        try {
          const result = options.compile(rawDoc, options.compileContext ?? {});
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
        resolved.push({
          ...manifest,
          metadata: { ...manifest.metadata, source, sourceLine },
        });
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

    if (moduleManifest && Array.isArray((moduleManifest as any).include)) {
      const insertAt = resolved.indexOf(moduleManifest) + 1;
      let offset = 0;
      for (const includePath of (moduleManifest as any).include as string[]) {
        const includeUrl = this.pick(source).resolveRelative(source, includePath);
        const included = await this.loadModule(includeUrl, options);
        for (const manifest of included) {
          if (manifest.kind === "Kernel.Module") continue;
          if (!manifest.metadata?.module) {
            manifest.metadata = { ...manifest.metadata, module: moduleName };
          }
          resolved.splice(insertAt + offset, 0, manifest);
          offset++;
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
