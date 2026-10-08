import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import { isSurface } from "./surface-spec.js";

/** Where a filter bar's controls sit, as a renderer receives it. */
export type FilterPlacementSpec = { type: string } & Record<string, unknown>;

export interface FilterPlacementInstance {
  provide(): Promise<FilterPlacementSpec>;
}

export function isFilterPlacement(candidate: unknown): candidate is FilterPlacementInstance {
  return typeof (candidate as FilterPlacementInstance | null)?.provide === "function";
}

/** What a placement kind may be declared with. A member holding nothing is one
 *  left out. */
interface PlacementConfig {
  side?: string;
  open?: boolean;
  compact?: unknown;
  surface?: unknown;
}

type PlacementResource = RuntimeResource & PlacementConfig;

export const abovePlacement = (): FilterPlacementSpec => ({ type: "above" });
export const asidePlacement = (config: PlacementConfig = {}): FilterPlacementSpec => ({ type: "aside", side: config.side ?? "start" });
export const collapsiblePlacement = (config: PlacementConfig = {}): FilterPlacementSpec => ({ type: "collapsible", open: config.open ?? false });

/** A placement kind's controller: its own members filled, then the placement
 *  standing in for it on a narrow viewport. */
const withCompact = (kind: string, own: (config: PlacementConfig) => FilterPlacementSpec) => ({
  async create(resource: PlacementResource, ctx: ResourceContext): Promise<ResourceInstance> {
    return {
      provide: async (): Promise<FilterPlacementSpec> => {
        if (resource.compact === undefined) return own(resource);
        const compact = await ctx
          .resolveRef(
            resource.compact,
            isFilterPlacement,
            () => `'compact' of ${kind} '${resource.metadata.name}'`,
            "Ui.CollapsiblePlacement or Ui.OverlayPlacement",
          )
          .provide();
        return { ...own(resource), compact };
      },
    };
  },
});

export const AbovePlacementController = withCompact("Ui.AbovePlacement", abovePlacement);
export const AsidePlacementController = withCompact("Ui.AsidePlacement", asidePlacement);

export const CollapsiblePlacementController = {
  async create(resource: PlacementResource): Promise<ResourceInstance> {
    return { provide: async () => collapsiblePlacement(resource) };
  },
};

export const OverlayPlacementController = {
  async create(resource: PlacementResource, ctx: ResourceContext): Promise<ResourceInstance> {
    return {
      provide: async (): Promise<FilterPlacementSpec> => ({
        type: "overlay",
        surface: await ctx
          .resolveRef(resource.surface, isSurface, () => `'surface' of Ui.OverlayPlacement '${resource.metadata.name}'`, "Ui.Overlay")
          .provide(),
      }),
    };
  },
};
