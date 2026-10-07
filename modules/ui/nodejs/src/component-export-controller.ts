import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import { entryAssets, type AssetRef } from "./browser-entry-assets.js";
import type { AssetFile } from "./composite.js";

type ComponentExportResource = RuntimeResource & { entry: string; export: string };

/** What a placed component needs to know about the code behind it. */
export interface ExportedComponent {
  export: string;
  module: AssetRef;
  stylesheets: AssetRef[];
  abi?: string;
  external: string[];
  assets: AssetFile[];
}

export interface ComponentExportInstance {
  provide(): Promise<ExportedComponent>;
}

export function isComponentExport(candidate: unknown): candidate is ComponentExportInstance {
  return typeof (candidate as ComponentExportInstance | null)?.provide === "function";
}

class ComponentExport implements ResourceInstance {
  private resolved?: Promise<ExportedComponent>;

  constructor(
    private readonly resource: ComponentExportResource,
    private readonly ctx: ResourceContext,
  ) {}

  provide(): Promise<ExportedComponent> {
    this.resolved ??= this.resolve();
    return this.resolved;
  }

  private async resolve(): Promise<ExportedComponent> {
    const entry = await this.ctx.resolveBrowserEntry(this.resource.entry);
    const { module, assets } = entryAssets(entry);
    return {
      export: this.resource.export,
      module,
      stylesheets: assets
        .filter((asset) => asset.mediaType === "text/css")
        .map(({ digest, name }) => ({ digest, name })),
      ...(entry.abi === undefined ? {} : { abi: entry.abi }),
      external: entry.external,
      assets,
    };
  }
}

export async function create(resource: ComponentExportResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new ComponentExport(resource, ctx);
}
