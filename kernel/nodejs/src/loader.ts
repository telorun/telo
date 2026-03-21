import { ResourceManifest, RuntimeResource } from "@telorun/sdk";
import { Loader as BaseLoader, precompileDoc } from "@telorun/analyzer";
import * as path from "path";
import { LocalFileAdapter } from "./manifest-adapters/local-file-adapter.js";
import type { ManifestSourceData } from "./manifest-adapters/manifest-adapter.js";
import { formatAjvErrors, validateRuntimeResource } from "./manifest-schemas.js";

export class Loader extends BaseLoader {
  private static projectRoot: string | null = null;
  private readonly localAdapter: LocalFileAdapter;

  constructor() {
    super();
    this.localAdapter = new LocalFileAdapter();
    this.register(this.localAdapter);
  }

  private static ensureProjectRoot(baseDir: string): void {
    if (!Loader.projectRoot) {
      Loader.projectRoot = path.resolve(baseDir);
    }
  }

  resolvePath(base: string, relative: string): string {
    return this.localAdapter.resolveRelative(base, relative);
  }

  async loadDirectory(pathOrUrl: string): Promise<ResourceManifest[]> {
    const files = await this.localAdapter.readAll(pathOrUrl);
    Loader.ensureProjectRoot(files[0]?.baseDir ?? process.cwd());
    const resources: RuntimeResource[] = [];
    for (const file of files) {
      await this.processFile(file, resources);
    }
    return this.orderResourcesByKindDependencies(resources);
  }

  async loadManifest(
    pathOrUrl: string,
    baseUrl: string,
    compileContext: Record<string, unknown> = {},
  ): Promise<ResourceManifest[]> {
    if (!baseUrl) {
      throw new Error("Base URL is required to load target manifest");
    }
    const url = new URL(pathOrUrl, baseUrl).toString();
    if (!Loader.projectRoot) {
      const file = await this.localAdapter.read(url);
      Loader.ensureProjectRoot(file.baseDir);
    }
    return this.loadModule(url, { compile: (doc) => precompileDoc(doc) });
  }

  private async processFile(
    file: ManifestSourceData,
    resources: RuntimeResource[],
  ): Promise<void> {
    for (const doc of file.documents) {
      const resource = this.normalizeResource(doc);
      if (!resource) continue;
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

  private normalizeResource(doc: any): RuntimeResource | null {
    if (!doc || typeof doc !== "object" || typeof doc.kind !== "string") return null;
    if (doc.metadata && typeof doc.metadata === "object" && typeof doc.metadata.name === "string") {
      return doc as RuntimeResource;
    }
    return null;
  }

  private orderResourcesByKindDependencies(resources: RuntimeResource[]): RuntimeResource[] {
    if (resources.length <= 1) return resources;

    const indicesByName = new Map<string, number[]>();
    for (let i = 0; i < resources.length; i++) {
      const name = resources[i]?.metadata?.name;
      if (!name) continue;
      const list = indicesByName.get(name);
      if (list) list.push(i);
      else indicesByName.set(name, [i]);
    }

    const edges = new Map<number, Set<number>>();
    const indegree = new Map<number, number>();
    for (let i = 0; i < resources.length; i++) indegree.set(i, 0);

    for (let i = 0; i < resources.length; i++) {
      const kind = resources[i]?.kind;
      if (!kind) continue;
      const definers = indicesByName.get(kind);
      if (!definers) continue;
      for (const definerIndex of definers) {
        if (definerIndex === i) continue;
        let set = edges.get(definerIndex);
        if (!set) { set = new Set(); edges.set(definerIndex, set); }
        if (!set.has(i)) {
          set.add(i);
          indegree.set(i, (indegree.get(i) || 0) + 1);
        }
      }
    }

    const ready: number[] = [];
    for (let i = 0; i < resources.length; i++) {
      if ((indegree.get(i) || 0) === 0) ready.push(i);
    }
    ready.sort((a, b) => a - b);

    const ordered: RuntimeResource[] = [];
    while (ready.length > 0) {
      const index = ready.shift() as number;
      ordered.push(resources[index]);
      const next = edges.get(index);
      if (!next) continue;
      for (const dependent of next) {
        const count = (indegree.get(dependent) || 0) - 1;
        indegree.set(dependent, count);
        if (count === 0) ready.push(dependent);
      }
      if (ready.length > 1) ready.sort((a, b) => a - b);
    }

    if (ordered.length !== resources.length) throw new Error("Resource dependency cycle detected");
    return ordered;
  }
}
