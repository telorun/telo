import { ResourceManifest, RuntimeError, RuntimeResource } from "@telorun/sdk";
import { ResourceURI } from "./resource-uri.js";

/**
 * Registry: Indexes resources by composite key of Kind and Name
 * Maintains URI-based lookup for tracking resource origins and lineage
 */
export class ManifestRegistry {
  private resources: Map<string, Map<string, ResourceManifest>> = new Map();
  private kindInheritance: Map<string, string> = new Map(); // derivedKind -> parentKind
  private uriIndex: Map<string, ResourceManifest> = new Map(); // URI -> Resource
  private sourceIndex: Map<string, ResourceManifest[]> = new Map(); // source path -> Resources
  private depthIndex: Map<number, ResourceManifest[]> = new Map(); // generation depth -> Resources

  register(resource: RuntimeResource): void {
    const { kind, metadata } = resource;
    const { name } = metadata;
    console.log("Registering resource:", kind, name);
    if (!this.resources.has(kind)) {
      this.resources.set(kind, new Map());
    }

    const kindMap = this.resources.get(kind)!;

    if (kindMap.has(name)) {
      throw new RuntimeError("ERR_DUPLICATE_RESOURCE", `Duplicate resource: ${kind}.${name}`);
    }

    kindMap.set(name, resource);

    // Index by URI if available
    if (metadata.uri) {
      this.uriIndex.set(metadata.uri, resource);

      // Index by source file/path
      try {
        const uri = ResourceURI.parse(metadata.uri);
        if (uri.isFileSource()) {
          const sourcePath = uri.path;
          if (!this.sourceIndex.has(sourcePath)) {
            this.sourceIndex.set(sourcePath, []);
          }
          this.sourceIndex.get(sourcePath)!.push(resource);
        }
      } catch {
        // URI parsing failed, skip indexing
      }
    }

    // Index by generation depth
    const depth = metadata.generationDepth ?? 0;
    if (!this.depthIndex.has(depth)) {
      this.depthIndex.set(depth, []);
    }
    this.depthIndex.get(depth)!.push(resource);

    // Check if this is a Kernel.KindDefinition that creates a new kind
    // if (kind === 'Kernel.KindDefinition') {
    //   const newKind = name;
    //   const parentKind = resource?.extends;
    //   if (parentKind) {
    //     this.kindInheritance.set(newKind, parentKind);
    //   }
    // }
  }

  getParentKind(kind: string): string | undefined {
    return this.kindInheritance.get(kind);
  }

  resolveKindChain(kind: string): string[] {
    const chain: string[] = [kind];
    let current = kind;
    while (this.kindInheritance.has(current)) {
      current = this.kindInheritance.get(current)!;
      chain.push(current);
    }
    return chain;
  }

  get(kind: string, name: string): ResourceManifest | undefined {
    return this.resources.get(kind)?.get(name);
  }

  getByKind(kind: string): ResourceManifest[] {
    const kindMap = this.resources.get(kind);
    return kindMap ? Array.from(kindMap.values()) : [];
  }

  /**
   * Get resource by its URI
   */
  getByUri(uri: string): ResourceManifest | undefined {
    return this.uriIndex.get(uri);
  }

  /**
   * Get all resources from a specific source file
   */
  getBySourceFile(sourceFilePath: string): ResourceManifest[] {
    return this.sourceIndex.get(sourceFilePath) ?? [];
  }

  /**
   * Get all resources at a specific generation depth
   * 0 = directly from files, 1+ = template-generated
   */
  getByGenerationDepth(depth: number): ResourceManifest[] {
    return this.depthIndex.get(depth) ?? [];
  }

  /**
   * Get all template-generated resources (depth > 0)
   */
  getTemplateGenerated(): ResourceManifest[] {
    const results: ResourceManifest[] = [];
    for (const [depth, resources] of this.depthIndex) {
      if (depth > 0) {
        results.push(...resources);
      }
    }
    return results;
  }

  /**
   * Get all directly-loaded resources (depth = 0)
   */
  getDirectlyLoaded(): ResourceManifest[] {
    return this.depthIndex.get(0) ?? [];
  }

  getAll(): ResourceManifest[] {
    return Array.from(this.resources.values())
      .map((kindMap) => Array.from(kindMap.values()))
      .flat();
  }
}
