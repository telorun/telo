import type { ResourceContext, ResourceInstance, RuntimeResource, TextRecord } from "@telorun/sdk";
import { isIcon, type IconFile } from "./icon.js";
import { isPage, type PageInstance } from "./page-controller.js";
import { sourceKeys } from "./source-keys.js";
import { isStateStore, memoryStore } from "./state-store.js";
import { drawerSpec, isSurface, type SurfaceSpec } from "./surface-spec.js";

/** How a navigation tree is drawn, as a renderer receives it. */
export type NavigationPlacementSpec = { type: string } & Record<string, unknown>;

interface NavigationPlacementInstance {
  provide(): Promise<NavigationPlacementSpec>;
}

const isNavigationPlacement = (candidate: unknown): candidate is NavigationPlacementInstance =>
  typeof (candidate as NavigationPlacementInstance | null)?.provide === "function";

/** What a placement kind may be declared with. A member holding nothing is one left out. */
type PlacementResource = RuntimeResource & {
  compact?: unknown;
  surface?: unknown;
  side?: string | null;
  rail?: { collapsed?: boolean | null } | null;
  store?: unknown;
  visible?: number | bigint | null;
};

/** The overlay a placement names, else `fallback`. */
const overlayOf = async (surface: unknown, fallback: SurfaceSpec, ctx: ResourceContext, owner: string): Promise<SurfaceSpec> =>
  surface == null ? fallback : await ctx.resolveRef(surface, isSurface, () => `'surface' of ${owner}`, "Ui.Overlay").provide();

/** The whole tree behind a menu button, in the surface the button opens: a
 *  drawer from `side` when none is named. */
export const overlayNavigation = async (
  surface: unknown,
  ctx: ResourceContext,
  owner: string,
  side: string = "start",
): Promise<NavigationPlacementSpec> => ({ type: "overlay", surface: await overlayOf(surface, drawerSpec({ side }), ctx, owner) });

/** The placement a narrow viewport uses instead: the one named, else the menu
 *  button opening a drawer from `side`. */
const compactNavigation = async (compact: unknown, ctx: ResourceContext, owner: string, side: string = "start") =>
  compact == null
    ? await overlayNavigation(undefined, ctx, owner, side)
    : await ctx
        .resolveRef(compact, isNavigationPlacement, () => `'compact' of ${owner}`, "Ui.CompactNavigationPlacement")
        .provide();

/** The tree in the header, and what replaces it on a narrow viewport. */
export const headerNavigation = async (
  compact: unknown,
  ctx: ResourceContext,
  owner: string,
): Promise<NavigationPlacementSpec> => ({ type: "header", compact: await compactNavigation(compact, ctx, owner) });

/** The tree in a column beside the page: its side, its rail when it has one,
 *  where its state is kept, and what replaces it on a narrow viewport — a
 *  drawer from its own side unless another is named. */
export const sidebarNavigation = async (resource: PlacementResource, ctx: ResourceContext, owner: string): Promise<NavigationPlacementSpec> => {
  const side = resource.side ?? "start";
  return {
    type: "sidebar",
    side,
    ...(resource.rail == null ? {} : { rail: { collapsed: resource.rail.collapsed ?? false } }),
    store:
      resource.store == null
        ? memoryStore()
        : await ctx.resolveRef(resource.store, isStateStore, () => `'store' of ${owner}`, "Ui.StateStore").provide(),
    compact: await compactNavigation(resource.compact, ctx, owner, side),
  };
};

/** The top-level entries as tabs along the bottom edge, at most `visible` of
 *  them; a group, or More, opens in a bottom sheet unless another surface is named. */
export const tabBarNavigation = async (resource: PlacementResource, ctx: ResourceContext, owner: string): Promise<NavigationPlacementSpec> => ({
  type: "tab-bar",
  visible: resource.visible == null ? 5 : Number(resource.visible),
  surface: await overlayOf(resource.surface, drawerSpec({ side: "bottom" }), ctx, owner),
});

const placementController = (kind: string, provide: (resource: PlacementResource, ctx: ResourceContext, owner: string) => Promise<NavigationPlacementSpec>) => ({
  async create(resource: PlacementResource, ctx: ResourceContext): Promise<ResourceInstance> {
    const owner = `${kind} '${resource.metadata.name}'`;
    return { provide: () => provide(resource, ctx, owner) };
  },
});

export const HeaderNavigationController = placementController("Ui.HeaderNavigation", (resource, ctx, owner) =>
  headerNavigation(resource.compact, ctx, owner),
);
export const SidebarNavigationController = placementController("Ui.SidebarNavigation", sidebarNavigation);
export const OverlayNavigationController = placementController("Ui.OverlayNavigation", (resource, ctx, owner) =>
  overlayNavigation(resource.surface, ctx, owner),
);
export const TabBarNavigationController = placementController("Ui.TabBarNavigation", tabBarNavigation);

/** A navigation entry as written, references live. A member holding nothing is one left out. */
export type NavigationEntryConfig =
  | { type: "page"; page: unknown; text?: TextRecord | null; icon?: unknown; when?: unknown }
  | { type: "link"; text: TextRecord; href: string; icon?: unknown; when?: unknown }
  | { type: "group"; text: TextRecord; items: NavigationEntryConfig[]; icon?: unknown; when?: unknown };

/** The `Ui.Navigation` record as written. */
export interface NavigationConfig {
  items?: NavigationEntryConfig[] | null;
  placement?: unknown;
}

/** An entry as a renderer receives it: a page by its path, every text a record,
 *  its icon, when it has one, as the address the renderer serves the glyph at,
 *  and its key — the slug of the source text it was written with, under its
 *  group's key and `/` (see {@link sourceKeys}) — which names it in a stored
 *  or addressed state. */
export type NavigationEntrySpec =
  | { type: "page"; key: string; path: string; text: TextRecord; icon?: string }
  | { type: "link"; key: string; href: string; text: TextRecord; icon?: string }
  | { type: "group"; key: string; text: TextRecord; items: NavigationEntrySpec[]; icon?: string };

/** An entry prepared once, its `when` still to evaluate per request. */
type PreparedEntry =
  | { type: "page"; key: string; path: string; text: TextRecord; icon?: string; when?: unknown }
  | { type: "link"; key: string; href: string; text: TextRecord; icon?: string; when?: unknown }
  | { type: "group"; key: string; text: TextRecord; items: PreparedEntry[]; icon?: string; when?: unknown };

/** An entry prepared but not yet keyed. */
type Unkeyed = DistributiveOmit<PreparedEntry, "key" | "items"> & { items?: Unkeyed[] };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Every entry keyed from its siblings' source texts, whatever their `when`. */
function keyed(entries: Unkeyed[], prefix: string): PreparedEntry[] {
  const keys = sourceKeys(entries.map((entry) => entry.text), "entry", prefix);
  return entries.map((entry, index) =>
    entry.items === undefined
      ? ({ ...entry, key: keys[index] } as PreparedEntry)
      : ({ ...entry, key: keys[index], items: keyed(entry.items, `${keys[index]}/`) } as PreparedEntry),
  );
}

/** Where a renderer serves the file of the icon at `where`: the address an entry carries. */
export type IconAddress = (icon: IconFile, where: string) => Promise<string>;

/** A navigation prepared once: its entries, which a request delivers, and its placement. */
export interface PreparedNavigation {
  /** Literal but for each `when`, which is evaluated per request. */
  items: unknown;
  placement: NavigationPlacementSpec;
}

/**
 * The navigation a renderer draws, every default filled: with no `navigation`,
 * one page entry per page in order; with no placement, the header, behind a
 * menu button on a narrow viewport. A page entry carries its page's path, and
 * its title unless it says otherwise; an entry naming an icon carries the
 * address `iconAddress` serves its file at.
 */
export async function preparedNavigation(
  declared: NavigationConfig | null | undefined,
  pages: readonly PageInstance[],
  ctx: ResourceContext,
  owner: string,
  iconAddress: IconAddress,
): Promise<PreparedNavigation> {
  const pageEntry = (page: PageInstance, text?: TextRecord | null): Unkeyed => {
    const reading = page.snapshot();
    return { type: "page", path: reading.path, text: text ?? reading.title };
  };
  const prepare = async (entry: NavigationEntryConfig, where: string): Promise<Unkeyed> => {
    const extra = {
      ...(entry.icon == null
        ? {}
        : {
            icon: await iconAddress(
              await ctx.resolveRef(entry.icon, isIcon, () => `'${where}.icon' of ${owner}`, "Ui.Icon").provide(),
              `${where}.icon`,
            ),
          }),
      ...(entry.when == null ? {} : { when: entry.when }),
    };
    if (entry.type === "page") {
      const page = ctx.resolveRef(entry.page, isPage, () => `'${where}.page' of ${owner}`, "Ui.Page");
      return { ...pageEntry(page, entry.text), ...extra };
    }
    if (entry.type === "link") return { type: "link", href: entry.href, text: entry.text, ...extra };
    const items: Unkeyed[] = [];
    for (const [index, item] of entry.items.entries()) items.push(await prepare(item, `${where}.items[${index}]`));
    return { type: "group", text: entry.text, items, ...extra };
  };
  const items: Unkeyed[] = [];
  if (declared?.items == null) items.push(...pages.map((page) => pageEntry(page)));
  else for (const [index, entry] of declared.items.entries()) items.push(await prepare(entry, `navigation.items[${index}]`));
  const placement =
    declared?.placement == null
      ? await headerNavigation(undefined, ctx, owner)
      : await ctx
          .resolveRef(declared.placement, isNavigationPlacement, () => `'navigation.placement' of ${owner}`, "Ui.NavigationPlacement")
          .provide();
  return { items: keyed(items, ""), placement };
}

/** The entries one request is delivered: an entry whose `when` is false left
 *  out, and a group none of whose entries is delivered left out with it. */
export function deliveredNavigation(evaluated: unknown): NavigationEntrySpec[] {
  const delivered = (entries: PreparedEntry[]): NavigationEntrySpec[] =>
    entries.flatMap((entry): NavigationEntrySpec[] => {
      if (entry.when === false) return [];
      const icon = entry.icon === undefined ? {} : { icon: entry.icon };
      if (entry.type === "page") return [{ type: "page", key: entry.key, path: entry.path, text: entry.text, ...icon }];
      if (entry.type === "link") return [{ type: "link", key: entry.key, href: entry.href, text: entry.text, ...icon }];
      const items = delivered(entry.items);
      return items.length === 0 ? [] : [{ type: "group", key: entry.key, text: entry.text, items, ...icon }];
    });
  return delivered(evaluated as PreparedEntry[]);
}
