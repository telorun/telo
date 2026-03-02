import { RuntimeResource } from "@telorun/sdk";
import { compile } from "@telorun/yaml-cel-templating";
import * as path from "path";
import { HttpAdapter } from "./manifest-adapters/http-adapter.js";
import { LocalFileAdapter } from "./manifest-adapters/local-file-adapter.js";
import type { ManifestAdapter, ManifestSourceData } from "./manifest-adapters/manifest-adapter.js";
import { RegistryAdapter } from "./manifest-adapters/registry-adapter.js";
import { formatAjvErrors, validateRuntimeResource } from "./manifest-schemas.js";
import { ResourceManifest } from "./types.js";

/**
 * Loader: Ingests resolved YAML manifests from disk or remote URLs into memory
 */
export class Loader {
  private static projectRoot: string | null = null;

  private readonly adapters: ManifestAdapter[] = [
    new HttpAdapter(),
    new RegistryAdapter(),
    new LocalFileAdapter(),
  ];

  private getAdapter(pathOrUrl: string): ManifestAdapter {
    const adapter = this.adapters.find((a) => a.supports(pathOrUrl));
    if (!adapter) {
      throw new Error(`No manifest adapter found for: ${pathOrUrl}`);
    }
    return adapter;
  }

  private static ensureProjectRoot(baseDir: string): void {
    if (!Loader.projectRoot) {
      Loader.projectRoot = path.resolve(baseDir);
    }
  }

  resolvePath(base: string, relative: string): string {
    return this.getAdapter(base).resolveRelative(base, relative);
  }

  async loadDirectory(pathOrUrl: string): Promise<ResourceManifest[]> {
    const files = await this.getAdapter(pathOrUrl).readAll(pathOrUrl);
    Loader.ensureProjectRoot(files[0]?.baseDir ?? process.cwd());
    const resources: RuntimeResource[] = [];
    for (const file of files) {
      await this.processFile(file, resources, { env: process.env });
    }
    return this.orderResourcesByKindDependencies(resources);
  }

  async loadManifest(
    pathOrUrl: string,
    baseUrl: string,
    compileContext: Record<string, unknown> = {},
  ): Promise<ResourceManifest[]> {
    const url = new URL(pathOrUrl, baseUrl).toString();
    const file = await this.getAdapter(url).read(url);
    if (!Loader.projectRoot) {
      Loader.ensureProjectRoot(file.baseDir);
    }

    const resolved: ResourceManifest[] = [];
    for (const rawDoc of file.documents) {
      let compiled: any;
      try {
        compiled = compile(rawDoc, { context: compileContext });
      } catch (error) {
        throw new Error(
          `Failed to compile manifest in ${file.source}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const compiledDocs = Array.isArray(compiled) ? compiled : [compiled];
      for (const manifest of compiledDocs) {
        const resource: ResourceManifest = {
          ...manifest,
          metadata: {
            ...manifest.metadata,
            source: file.source,
          },
        };
        resolved.push(resource);
      }
    }
    return resolved;
  }

  private async processFile(
    file: ManifestSourceData,
    resources: RuntimeResource[],
    compileContext: Record<string, unknown> = {},
  ): Promise<void> {
    const documents = file.documents;

    for (const rawDoc of documents) {
      let compiled: any;
      try {
        compiled = compile(rawDoc, { context: compileContext });
      } catch (error) {
        throw new Error(
          `Failed to compile manifest in ${file.source}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const compiledDocs = Array.isArray(compiled) ? compiled : [compiled];
      for (const doc of compiledDocs) {
        const resource = this.normalizeResource(doc);
        if (!resource) {
          continue;
        }
        if (!validateRuntimeResource(resource)) {
          const kind = (resource as any).kind;
          const name = (resource as any).metadata?.name;
          throw new Error(
            `Resource validation failed for ${kind}.${name}: ${formatAjvErrors(validateRuntimeResource.errors)}`,
          );
        }

        const { kind, name } = resource.metadata;
        resource.metadata.source = file.source;
        resource.metadata.uri = `${file.uriBase}#${kind}.${name}`;
        resource.metadata.generationDepth = 0;

        resources.push(resource);
      }
    }
  }

  private normalizeResource(doc: any): RuntimeResource | null {
    if (!doc || typeof doc !== "object" || typeof doc.kind !== "string") {
      return null;
    }

    // Already in correct format
    if (doc.metadata && typeof doc.metadata === "object" && typeof doc.metadata.name === "string") {
      return doc as RuntimeResource;
    }

    return null;
  }

  // Validation handled by TypeBox + Ajv schemas.

  private orderResourcesByKindDependencies(resources: RuntimeResource[]): RuntimeResource[] {
    if (resources.length <= 1) {
      return resources;
    }

    const indicesByName = new Map<string, number[]>();
    for (let i = 0; i < resources.length; i += 1) {
      const name = resources[i]?.metadata?.name;
      if (!name) {
        continue;
      }
      const list = indicesByName.get(name);
      if (list) {
        list.push(i);
      } else {
        indicesByName.set(name, [i]);
      }
    }

    const edges = new Map<number, Set<number>>();
    const indegree = new Map<number, number>();
    for (let i = 0; i < resources.length; i += 1) {
      indegree.set(i, 0);
    }

    for (let i = 0; i < resources.length; i += 1) {
      const kind = resources[i]?.kind;
      if (!kind) {
        continue;
      }
      const definers = indicesByName.get(kind);
      if (!definers) {
        continue;
      }
      for (const definerIndex of definers) {
        if (definerIndex === i) {
          continue;
        }
        let set = edges.get(definerIndex);
        if (!set) {
          set = new Set();
          edges.set(definerIndex, set);
        }
        if (!set.has(i)) {
          set.add(i);
          indegree.set(i, (indegree.get(i) || 0) + 1);
        }
      }
    }

    const ready: number[] = [];
    for (let i = 0; i < resources.length; i += 1) {
      if ((indegree.get(i) || 0) === 0) {
        ready.push(i);
      }
    }
    ready.sort((a, b) => a - b);

    const ordered: RuntimeResource[] = [];
    while (ready.length > 0) {
      const index = ready.shift() as number;
      ordered.push(resources[index]);
      const next = edges.get(index);
      if (!next) {
        continue;
      }
      for (const dependent of next) {
        const count = (indegree.get(dependent) || 0) - 1;
        indegree.set(dependent, count);
        if (count === 0) {
          ready.push(dependent);
        }
      }
      if (ready.length > 1) {
        ready.sort((a, b) => a - b);
      }
    }

    if (ordered.length !== resources.length) {
      throw new Error("Resource dependency cycle detected");
    }

    return ordered;
  }
}
