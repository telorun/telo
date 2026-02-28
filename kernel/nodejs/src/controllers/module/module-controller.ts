import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import * as path from "path";
import { Loader } from "../../loader.js";

type ModuleResource = RuntimeResource & {
  source?: string;
  imports?: string[];
  definitions?: string[];
  resources?: (string | { path: string })[];
};

/**
 * Check if a path is a URL (http:// or https://)
 */
function isUrl(pathOrUrl: string): boolean {
  return pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://");
}

/**
 * Resolve a path relative to a base, handling both local paths and URLs
 */
function resolvePath(loader: Loader, base: string, relative: string): string {
  // If the relative path is actually a URL, return it as-is
  if (isUrl(relative)) {
    return relative;
  }
  // Otherwise, resolve it relative to the base
  return loader.resolvePath(base, relative);
}

export async function create(
  resource: ModuleResource,
  ctx: ResourceContext,
): Promise<ResourceInstance> {
  // Get the module base path from the resource's URI or source
  const moduleBasePath = resource.metadata.source
    ? path.dirname(resource.metadata.source)
    : getModuleBasePath(resource.metadata.uri);
  const loader = new Loader();
  try {
    // Load and register resource definitions from imports
    if (resource.imports && Array.isArray(resource.imports)) {
      for (const importPath of resource.imports) {
        const defResources = await loader.loadManifest(importPath, resource.metadata.source);
        for (const defResource of defResources) {
          ctx.registerManifest(defResource);
        }
      }
    }
    // Load and register resources from definitions and resources paths
    // if (resource.definitions && Array.isArray(resource.definitions)) {
    //   for (const defPath of resource.definitions) {
    //     const resolvedPath = resolvePath(loader, moduleBasePath, defPath);
    //     const defResources = await loader.loadManifest(resolvedPath);
    //     for (const defResource of defResources) {
    //       ctx.registerManifest(defResource);
    //     }
    //   }
    // }

    // if (resource.resources && Array.isArray(resource.resources)) {
    //   for (const defPath of resource.resources) {
    //     const rawPath = typeof defPath === "string" ? defPath : defPath.path;
    //     const resolvedPath = resolvePath(loader, moduleBasePath, rawPath);
    //     const defResources = await loader.loadManifest(resolvedPath);
    //     for (const defResource of defResources) {
    //       ctx.registerManifest(defResource);
    //     }
    //   }
    // }

    return {};
  } catch (error) {
    throw new Error(
      `Failed to process Module "${resource.metadata.name}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function getModuleBasePath(uri?: string): string {
  if (!uri) {
    return process.cwd();
  }

  try {
    // URI format: file://localhost/path/to/file.yaml#kind.name
    // Extract the file path part (before the #)
    const hashIndex = uri.indexOf("#");
    const filePath = hashIndex > 0 ? uri.substring(0, hashIndex) : uri;

    // Parse as URL to handle file:// scheme
    if (filePath.startsWith("file://")) {
      // Remove 'file://localhost' and get the path
      let pathPart = filePath.substring("file://".length);
      if (pathPart.startsWith("localhost/")) {
        pathPart = pathPart.substring("localhost".length);
      } else if (pathPart.startsWith("localhost\\")) {
        pathPart = pathPart.substring("localhost".length);
      }
      return path.dirname(pathPart);
    }

    // Fallback: treat as regular path
    return path.dirname(filePath);
  } catch {
    return process.cwd();
  }
}

export const schema = {
  type: "object",
  additionalProperties: true,
};
