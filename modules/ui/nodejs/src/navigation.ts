import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource, type TextRecord } from "@telorun/sdk";
import { declaredPage } from "./address-spec.js";
import type { AssetRef } from "./browser-entry-assets.js";
import { mergeAssets, type AssetFile } from "./composite.js";
import { iconAsset, isIcon } from "./icon.js";
import { pagePathVariables } from "./page-path.js";
import { sourceKeys } from "./source-keys.js";
import { declaredText } from "./spec-texts.js";
import { drawerSpec, isSurface, type SurfaceSpec } from "./surface-spec.js";

/** How a navigation tree is drawn, as a renderer receives it. */
export type NavigationPlacementSpec = { type: string } & Record<string, unknown>;

interface NavigationPlacementInstance {
  provide(): Promise<NavigationPlacementSpec>;
}

export const isNavigationPlacement = (candidate: unknown): candidate is NavigationPlacementInstance =>
  typeof (candidate as NavigationPlacementInstance | null)?.provide === "function";

/** What a placement kind may be declared with. A member holding nothing is one left out. */
type PlacementResource = RuntimeResource & {
  compact?: unknown;
  surface?: unknown;
  visible?: number | bigint | null;
};

/** The overlay a placement names, else `fallback`. */
const overlayOf = async (surface: unknown, fallback: SurfaceSpec, ctx: ResourceContext, owner: string): Promise<SurfaceSpec> =>
  surface == null ? fallback : await ctx.resolveRef(surface, isSurface, () => `'surface' of ${owner}`, "Ui.Overlay").provide();

/** The whole tree behind a menu button, in the surface the button opens: a
 *  drawer from the start edge when none is named. */
export const overlayNavigation = async (surface: unknown, ctx: ResourceContext, owner: string): Promise<NavigationPlacementSpec> => ({
  type: "overlay",
  surface: await overlayOf(surface, drawerSpec({ side: "start" }), ctx, owner),
});

/** The placement a narrow viewport uses instead: the one named, else the menu
 *  button opening a drawer from the start edge. */
const compactNavigation = async (compact: unknown, ctx: ResourceContext, owner: string) =>
  compact == null
    ? await overlayNavigation(undefined, ctx, owner)
    : await ctx
        .resolveRef(compact, isNavigationPlacement, () => `'compact' of ${owner}`, "Ui.CompactNavigationPlacement")
        .provide();

/** The tree in the header, and what replaces it on a narrow viewport. */
export const headerNavigation = async (
  compact: unknown,
  ctx: ResourceContext,
  owner: string,
): Promise<NavigationPlacementSpec> => ({ type: "header", compact: await compactNavigation(compact, ctx, owner) });

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
export const OverlayNavigationController = placementController("Ui.OverlayNavigation", (resource, ctx, owner) =>
  overlayNavigation(resource.surface, ctx, owner),
);
export const TabBarNavigationController = placementController("Ui.TabBarNavigation", tabBarNavigation);

/** A navigation entry as written: icons live, pages named. A member holding nothing is one left out. */
export type NavigationEntryConfig =
  | { type: "page"; page: unknown; text?: TextRecord | null; icon?: unknown; when?: unknown }
  | { type: "link"; text: TextRecord; href: string; icon?: unknown; when?: unknown }
  | { type: "group"; text: TextRecord; items: NavigationEntryConfig[]; icon?: unknown; when?: unknown };

/** The `Ui.Navigation` record as written. */
export interface NavigationConfig {
  items: NavigationEntryConfig[];
}

/** An entry as a renderer receives it: a page by its path, every text a record,
 *  its icon, when it has one, as the address of the glyph's file, and its key —
 *  the slug of the source text it was written with, under its group's key and
 *  `/` (see {@link sourceKeys}) — which names it in a stored or addressed state. */
export type NavigationEntrySpec =
  | { type: "page"; key: string; path: string; text: TextRecord; icon?: AssetRef }
  | { type: "link"; key: string; href: string; text: TextRecord; icon?: AssetRef }
  | { type: "group"; key: string; text: TextRecord; items: NavigationEntrySpec[]; icon?: AssetRef };

/** An entry prepared once, its `when` still to evaluate per request. */
type PreparedEntry =
  | { type: "page"; key: string; path: string; text: TextRecord; icon?: AssetRef; when?: unknown }
  | { type: "link"; key: string; href: string; text: TextRecord; icon?: AssetRef; when?: unknown }
  | { type: "group"; key: string; text: TextRecord; items: PreparedEntry[]; icon?: AssetRef; when?: unknown };

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

/** A navigation prepared once: its entries, which a request delivers, and the
 *  files of their glyphs. */
export interface PreparedNavigation {
  /** Literal but for each `when`, which is evaluated per request. */
  items: unknown;
  assets: AssetFile[];
}

/**
 * A navigation tree as a navigation pane draws it, every default filled: a
 * page entry carries its page's path, and its title unless it says otherwise —
 * both read off the page's declaration, so a page is named and never held; a
 * page with no title needs the entry's own text, and a page with a variable in
 * its path cannot be an entry. An entry naming an icon carries the address of
 * its file, which joins `assets`.
 */
export async function preparedNavigation(declared: NavigationConfig, ctx: ResourceContext, owner: string): Promise<PreparedNavigation> {
  const assets: AssetFile[] = [];
  const pageEntry = (written: unknown, where: string, text?: TextRecord | null): Unkeyed => {
    const page = declaredPage(written, ctx, `'${where}.page' of ${owner}`);
    if (text == null && page.title === undefined) {
      throw new RuntimeError(
        "ERR_UI_NAVIGATION_PAGE_UNTITLED",
        `${owner}: '${where}' names a page with no title ('${page.path}') and gives no text of its own, so it has no label. Write the entry's text, or give the page a title.`,
      );
    }
    if (pagePathVariables(page.path).length > 0) {
      throw new RuntimeError(
        "ERR_UI_NAVIGATION_PAGE_HAS_PARAMETERS",
        `${owner}: '${where}' names a page with a variable in its path ('${page.path}'), which a navigation entry cannot fill. Reach the page with a link whose pathParams fill it, or remove the entry.`,
      );
    }
    return { type: "page", path: page.path, text: text ?? declaredText(page.title) };
  };
  const prepare = async (entry: NavigationEntryConfig, where: string): Promise<Unkeyed> => {
    let icon: AssetRef | undefined;
    if (entry.icon != null) {
      const file = await ctx.resolveRef(entry.icon, isIcon, () => `'${where}.icon' of ${owner}`, "Ui.Icon").provide();
      const served = await iconAsset(file, owner, `${where}.icon`);
      assets.push(served.asset);
      icon = served.ref;
    }
    const extra = { ...(icon === undefined ? {} : { icon }), ...(entry.when == null ? {} : { when: entry.when }) };
    if (entry.type === "page") return { ...pageEntry(entry.page, where, entry.text), ...extra };
    if (entry.type === "link") return { type: "link", href: entry.href, text: entry.text, ...extra };
    const items: Unkeyed[] = [];
    for (const [index, item] of entry.items.entries()) items.push(await prepare(item, `${where}.items[${index}]`));
    return { type: "group", text: entry.text, items, ...extra };
  };
  const items: Unkeyed[] = [];
  for (const [index, entry] of declared.items.entries()) items.push(await prepare(entry, `navigation.items[${index}]`));
  return { items: keyed(items, ""), assets: mergeAssets(assets) };
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
