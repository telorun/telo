import { Loader as BaseLoader } from "@telorun/analyzer";
import { ResourceManifest, RuntimeResource } from "@telorun/sdk";
import * as path from "path";
import { LocalFileAdapter } from "./manifest-adapters/local-file-adapter.js";
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

  /**
   * Resolve a path-or-URL to its canonical file source URL.
   * If the path refers to a directory, returns the URL of module.yaml inside it.
   */
  async resolveEntryPoint(pathOrUrl: string): Promise<string> {
    const { source } = await this.localAdapter.read(pathOrUrl);
    return source;
  }

  async loadDirectory(pathOrUrl: string): Promise<ResourceManifest[]> {
    const sources = await this.localAdapter.readAll(pathOrUrl);
    const firstPath = sources[0] ? new URL(sources[0]).pathname : process.cwd();
    Loader.ensureProjectRoot(path.dirname(firstPath));
    const resources: RuntimeResource[] = [];
    for (const source of sources) {
      const manifests = await this.loadModule(source);
      for (const m of manifests) {
        if (!m.metadata?.name) continue;
        const resource = m as RuntimeResource;
        if (!validateRuntimeResource(resource)) {
          throw new Error(
            `Resource validation failed for ${m.kind}.${m.metadata.name}: ${formatAjvErrors(validateRuntimeResource.errors)}`,
          );
        }
        const filePath = new URL(m.metadata.source as string).pathname;
        const uriBase = `file://localhost${filePath.replace(/\\/g, "/")}`;
        resource.metadata.uri = `${uriBase}#${m.kind}.${m.metadata.name as string}`;
        resource.metadata.generationDepth = 0;
        resources.push(resource);
      }
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
      Loader.ensureProjectRoot(path.dirname(new URL(url).pathname));
    }
    return this.loadModule(url, { compile: true });
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
