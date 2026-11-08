import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import { isSurface } from "./surface-spec.js";
import { uiText, type SpecText } from "./spec-texts.js";

/** Where a filter bar's controls sit, as a renderer receives it. */
export type FilterPlacementSpec = { type: string } & Record<string, unknown>;

/** How the controls of a bar are drawn, as `Ui.FilterDisplay` declares. */
export interface FilterDisplay {
  show: "all" | "chosen";
  controls: "direct" | "chips";
  summary: "none" | "chips";
}

export interface FilterPlacementInstance {
  provide(): Promise<FilterPlacementSpec>;
}

export function isFilterPlacement(candidate: unknown): candidate is FilterPlacementInstance {
  return typeof (candidate as FilterPlacementInstance | null)?.provide === "function";
}

/** What a placement kind may be declared with. A member holding nothing is one
 *  left out. */
interface PlacementConfig extends Partial<FilterDisplay> {
  side?: string;
  open?: boolean;
  compact?: unknown;
  surface?: unknown;
  placeholder?: SpecText;
}

type PlacementResource = RuntimeResource & PlacementConfig;

const DISPLAY_DEFAULTS: FilterDisplay = { show: "all", controls: "direct", summary: "none" };

const DISPLAY_MEMBERS = ["show", "controls", "summary"] as const;

/** The display a placement is written with, its omitted members defaulted. */
const displayOf = (config: PlacementConfig): FilterDisplay => ({
  show: config.show ?? DISPLAY_DEFAULTS.show,
  controls: config.controls ?? DISPLAY_DEFAULTS.controls,
  summary: config.summary ?? DISPLAY_DEFAULTS.summary,
});

export const abovePlacement = (config: PlacementConfig = {}): FilterPlacementSpec => ({
  type: "above",
  ...displayOf(config),
});
export const asidePlacement = (config: PlacementConfig = {}): FilterPlacementSpec => ({
  type: "aside",
  side: config.side ?? "start",
  ...displayOf(config),
});
export const collapsiblePlacement = (config: PlacementConfig = {}): FilterPlacementSpec => ({
  type: "collapsible",
  open: config.open ?? false,
  ...displayOf(config),
});

/** A placement kind's controller: its own members filled, then the placement
 *  standing in for it on a narrow viewport — the one it names, else its
 *  `fallback`, if it has one. The display members that placement's declaration
 *  leaves out take this one's values, whatever kind it is. */
const withCompact = (
  kind: string,
  own: (config: PlacementConfig) => FilterPlacementSpec,
  fallback?: (config: PlacementConfig) => FilterPlacementSpec,
) => ({
  async create(resource: PlacementResource, ctx: ResourceContext): Promise<ResourceInstance> {
    return {
      provide: async (): Promise<FilterPlacementSpec> => {
        const spec = own(resource);
        const display = displayOf(resource);
        if (resource.compact == null) return fallback ? { ...spec, compact: fallback(display) } : spec;
        const describe = () => `'compact' of ${kind} '${resource.metadata.name}'`;
        const placement = ctx.resolveRef(resource.compact, isFilterPlacement, describe, "Ui.FoldingFilterPlacement");
        const compact = await placement.provide();
        const lookup = ctx.resolveDeclaredManifest?.bind(ctx);
        if (!lookup) {
          throw new RuntimeError(
            "ERR_CONTROLLER_HOST_INCOMPATIBLE",
            `${describe()}: this host cannot read declarations, which filling the members it leaves out needs.`,
          );
        }
        const ref = ctx.ensureKindRef(resource.compact);
        const written = lookup(ref.name, ref.alias) as Partial<FilterDisplay> | undefined;
        if (!written) {
          throw new RuntimeError("ERR_REF_UNRESOLVED", `${describe()} names '${ref.name}', which resolves to no declaration.`);
        }
        const filled = { ...compact };
        for (const member of DISPLAY_MEMBERS) {
          if (member in filled && written[member] == null) filled[member] = display[member];
        }
        return { ...spec, compact: filled };
      },
    };
  },
});

export const AbovePlacementController = withCompact("Ui.AbovePlacement", abovePlacement);
/** A column beside the content has no room on a narrow viewport, so it folds. */
export const AsidePlacementController = withCompact("Ui.AsidePlacement", asidePlacement, collapsiblePlacement);

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
        ...displayOf(resource),
      }),
    };
  },
};

/** The box takes no display: its chips are the summary, its list the controls. */
export const SearchBoxPlacementController = {
  async create(resource: PlacementResource): Promise<ResourceInstance> {
    return { provide: async () => ({ type: "searchBox", placeholder: resource.placeholder ?? uiText("searchAndFilter") }) };
  },
};
