import type { InvokeContext, ResourceContext, ResourceInstance, RuntimeResource, TextRecord } from "@telorun/sdk";
import { keptState, type KeptState, type KeptStateConfig } from "./aside.js";
import { mergeAssets, type AssetFile, type SpecNode } from "./composite.js";
import { RequestNodes } from "./delivered-nodes.js";
import { filledNode } from "./fill-marking.js";
import {
  deliveredNavigation,
  headerNavigation,
  isNavigationPlacement,
  preparedNavigation,
  type NavigationConfig,
  type NavigationPlacementSpec,
  type PreparedNavigation,
} from "./navigation.js";
import type { AssetsReading, PaneAnswer, PaneInputs, PaneRequest } from "./pane.js";

/** The entries `navigation` delivers for `request`, null where the pane is
 *  resolved once, at creation. */
function navigationFor(prepared: PreparedNavigation, request: PaneRequest | null, ctx: ResourceContext) {
  return { items: deliveredNavigation(ctx.expandValue(prepared.items, { request })) };
}

type NavbarResource = RuntimeResource & {
  title?: TextRecord | null;
  start?: unknown[] | null;
  end?: unknown[] | null;
  navigation: NavigationConfig;
  placement?: unknown;
};

/** A title and a navigation drawn by its placement, with the nodes before and
 *  after them, every one delivered per request. */
class Navbar implements ResourceInstance {
  constructor(
    private readonly title: TextRecord | undefined,
    private readonly start: RequestNodes,
    private readonly end: RequestNodes,
    private readonly navigation: PreparedNavigation,
    private readonly placement: NavigationPlacementSpec,
    private readonly ctx: ResourceContext,
    private readonly assets: AssetFile[],
  ) {}

  async invoke({ request }: PaneInputs, context?: InvokeContext): Promise<PaneAnswer> {
    const asked = request ?? null;
    const node: SpecNode = {
      type: "navbar",
      ...(this.title === undefined ? {} : { title: this.title }),
      start: await this.start.deliver(asked, context),
      end: await this.end.deliver(asked, context),
      navigation: navigationFor(this.navigation, asked, this.ctx),
      placement: this.placement,
      fill: false,
    };
    return { node: filledNode(node) };
  }

  snapshot(): AssetsReading {
    return { assets: this.assets };
  }
}

export const NavbarController = {
  async create(resource: NavbarResource, ctx: ResourceContext): Promise<ResourceInstance> {
    const owner = `Ui.Navbar '${resource.metadata.name}'`;
    const navigation = await preparedNavigation(resource.navigation, ctx, owner);
    const start = await RequestNodes.prepare(resource.start ?? [], {}, ctx, `${owner} start`);
    const end = await RequestNodes.prepare(resource.end ?? [], {}, ctx, `${owner} end`);
    const placement =
      resource.placement == null
        ? await headerNavigation(undefined, ctx, owner)
        : await ctx.resolveRef(resource.placement, isNavigationPlacement, () => `'placement' of ${owner}`, "Ui.NavigationPlacement").provide();
    return new Navbar(
      resource.title ?? undefined,
      start,
      end,
      navigation,
      placement,
      ctx,
      mergeAssets(navigation.assets, start.assets, end.assets),
    );
  },
};

type NavigationColumnResource = RuntimeResource & {
  navigation: NavigationConfig;
  state?: KeptStateConfig | null;
};

/** A navigation drawn as a column, its open groups kept by `state`. */
class NavigationColumn implements ResourceInstance {
  constructor(
    private readonly navigation: PreparedNavigation,
    private readonly state: KeptState,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke({ request }: PaneInputs): Promise<PaneAnswer> {
    const node: SpecNode = {
      type: "navigation-column",
      navigation: navigationFor(this.navigation, request ?? null, this.ctx),
      state: this.state,
      fill: false,
    };
    return { node };
  }

  snapshot(): AssetsReading {
    return { assets: this.navigation.assets };
  }
}

export const NavigationColumnController = {
  async create(resource: NavigationColumnResource, ctx: ResourceContext): Promise<ResourceInstance> {
    const owner = `Ui.NavigationColumn '${resource.metadata.name}'`;
    return new NavigationColumn(
      await preparedNavigation(resource.navigation, ctx, owner),
      await keptState(resource.state, ctx, () => `'state.store' of ${owner}`),
      ctx,
    );
  },
};
