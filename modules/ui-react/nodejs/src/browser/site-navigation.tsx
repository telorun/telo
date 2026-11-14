import { useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { NavigationEntry } from "../contract/ui-react-controls.js";
import { isCurrentAddress, type CurrentLocation } from "./address-wire.js";
import { useControl } from "./effective-controls.js";
import { useHost, useHostStore } from "./host.js";
import { linkAddress, pageAddress } from "./link-address.js";
import { AsideContext } from "./aside.js";
import {
  navigationStorage,
  navigationStorageKey,
  readNavigationStore,
  writeNavigationStore,
  type NavigationStore,
} from "./navigation-state.js";
import { ErrorNode, Nodes, type SpecNode } from "./nodes.js";
import { openValue } from "./open-address.js";
import { assetUrl, BottomSlotContext, RendererContext, type RendererEnvironment } from "./renderer-context.js";
import { Surface, type SurfaceSpec } from "./surface.js";
import { useSay, useText, type WireText } from "./texts.js";

/** An entry of a navigation tree, as the layout document says it: `key` is the
 *  slug of its source text under its group's key — what a stored or addressed
 *  state names it by — and `icon` the file its glyph is drawn from. */
export type NavigationEntrySpec =
  | { type: "page"; key: string; path: string; text: WireText; icon?: AssetRef }
  | { type: "link"; key: string; href: string; text: WireText; icon?: AssetRef }
  | { type: "group"; key: string; text: WireText; items: NavigationEntrySpec[]; icon?: AssetRef };

type AssetRef = { digest: string; name: string };

/** The whole tree behind a menu button. */
type OverlayPlacement = { type: "overlay"; surface: SurfaceSpec };
/** The top-level entries as tabs along the bottom edge. */
type TabBarPlacement = { type: "tab-bar"; visible: number; surface: SurfaceSpec };
type CompactPlacement = OverlayPlacement | TabBarPlacement;

/** How a navbar draws its navigation: in a row, behind a menu button, or as a tab bar. */
export type NavigationPlacementSpec = { type: "header"; compact: CompactPlacement } | CompactPlacement;

/** The `navbar` node: a title and its navigation, with nodes of its own before and after. */
export interface NavbarNodeSpec {
  title?: WireText;
  start: SpecNode[];
  end: SpecNode[];
  navigation: { items: NavigationEntrySpec[] };
  placement: NavigationPlacementSpec;
}

/** The `navigation-column` node: the tree as a column, its open groups kept under `state`. */
export interface NavigationColumnNodeSpec {
  navigation: { items: NavigationEntrySpec[] };
  state: { key: string; store: NavigationStore } | null;
}

/** The key of the group what does not fit moves into: no entry's key starts with `~`. */
const MORE = "~more";

/** An entry as the `Navigation` control draws it, with where following it leads. */
interface Drawn {
  entries: NavigationEntry[];
  /** By key: the address a link leads to. */
  addresses: Map<string, string>;
  /** The addresses no link may hold, each left out of the tree. */
  failing: string[];
}

/** An icon's glyph: its file as a mask over the text's colour, never its markup. */
function glyph(address: string): ReactElement {
  const style = { "--ui-react-glyph": `url(${JSON.stringify(address)})` } as CSSProperties;
  return <span data-telo-part="glyph" aria-hidden="true" style={style} />;
}

/** The entries with their addresses, the shown page's entry, a link leading to where the viewer is
 *  and every group on the way to either marked current. An entry whose address does not resolve is
 *  left out, and a group left with nothing with it. */
function drawn(
  items: NavigationEntrySpec[],
  location: CurrentLocation,
  address: (href: string) => string | undefined,
  label: (text: WireText) => string,
  environment: RendererEnvironment,
): Drawn {
  const addresses = new Map<string, string>();
  const failing: string[] = [];
  const entries = (list: NavigationEntrySpec[]): NavigationEntry[] =>
    list.flatMap((entry): NavigationEntry[] => {
      const key = entry.key;
      const icon = entry.icon === undefined ? {} : { icon: glyph(assetUrl(environment, entry.icon)) };
      if (entry.type === "group") {
        const items = entries(entry.items);
        if (items.length === 0) return [];
        const current = items.some((item) => item.current !== undefined);
        return [{ key, label: label(entry.text), items, ...icon, ...(current ? { current: "true" as const } : {}) }];
      }
      const href = entry.type === "page" ? entry.path : entry.href;
      const resolved = address(href);
      if (resolved === undefined) {
        failing.push(href);
        return [];
      }
      addresses.set(key, resolved);
      const current = entry.type === "page" ? entry.path === location.path : isCurrentAddress(entry.href, location);
      return [{ key, label: label(entry.text), href: resolved, ...icon, ...(current ? { current: "page" as const } : {}) }];
    });
  return { entries: entries(items), addresses, failing };
}

/** Every group's key, at any depth. */
const groupKeys = (entries: NavigationEntry[]): string[] =>
  entries.flatMap((entry) => (entry.items === undefined ? [] : [entry.key, ...groupKeys(entry.items)]));

/** What stands for an entry whose address does not resolve inside the application. */
function Unresolved({ href }: { href: string }): ReactNode {
  return (
    <ErrorNode
      error={{ type: "error", code: "ERR_UI_NODE_INVALID", message: `The navigation address '${href}' does not resolve inside this application.` }}
    />
  );
}

/** The tree drawn, and how following one of its links moves the page. */
interface Tree {
  drawn: Drawn;
  /** Follow the link under `key`; `then` runs first, when the move is to happen. */
  follow(key: string, then?: () => void): void;
}

/** The tree of a navigation: drawn as `Navigation` takes it, and following one of its links. */
function useTree(items: NavigationEntrySpec[], path: string): Tree {
  const store = useHostStore();
  const host = useHost();
  const environment = useContext(RendererContext);
  const { prefix, pages } = environment;
  const text = useText();
  const tree: Tree = {
    drawn: drawn(items, { path, search: host.location.search }, (href) => linkAddress(store, href), text, environment),
    follow: (key, then) => {
      const href = tree.drawn.addresses.get(key);
      if (href === undefined) return;
      then?.();
      const to = pageAddress(prefix, pages, href);
      if (to === undefined) store.leave(href);
      else host.navigate(to);
    },
  };
  return tree;
}

/**
 * A title and its navigation where the placement says: a row between the
 * title and the end — a group a dropdown, a nested group a submenu — a menu
 * button opening the whole tree in a surface, or a tab bar along the bottom
 * edge. Below the breakpoint a header row is replaced by its compact placement.
 * The node's own `start` stands before the title and its `end` after the
 * navigation. A navigation with nothing delivered draws nothing, not even its button.
 */
export function NavbarNode({ node }: { node: NavbarNodeSpec }): ReactNode {
  const host = useHost();
  const { compact } = useContext(RendererContext);
  const text = useText();
  const tree = useTree(node.navigation.items, host.location.path);
  const placement = compact && node.placement.type === "header" ? node.placement.compact : node.placement;
  const empty = node.navigation.items.length === 0;
  // Two entries may hold one failing address: each is keyed by its place among them.
  const failing = tree.drawn.failing.map((href, index) => <Unresolved key={index} href={href} />);
  const menuAtEnd = placement.type === "overlay" && placement.surface.type === "drawer" && placement.surface.side === "end";
  const menu = placement.type === "overlay" && !empty ? <MenuButton placement={placement} tree={tree}>{failing}</MenuButton> : null;
  return (
    <div data-telo-part="navbar">
      {!menuAtEnd && menu}
      {node.start.length > 0 && (
        <div data-telo-part="navbar-start">
          <Nodes nodes={node.start} />
        </div>
      )}
      {node.title !== undefined && <span data-telo-part="navbar-title">{text(node.title)}</span>}
      {placement.type === "header" && !empty && <HeaderRow tree={tree}>{failing}</HeaderRow>}
      {node.end.length > 0 && (
        <div data-telo-part="navbar-end">
          <Nodes nodes={node.end} />
        </div>
      )}
      {menuAtEnd && menu}
      {placement.type === "tab-bar" && !empty && <TabBar placement={placement} tree={tree}>{failing}</TabBar>}
    </div>
  );
}

/** The tree in a row in the navbar: a group opens as a dropdown, what does not fit moves under More. */
function HeaderRow({ tree, children }: { tree: Tree; children: ReactNode }) {
  const say = useSay();
  const Navigation = useControl("Navigation");
  const [open, setOpen] = useState<string[]>([]);
  return (
    <div data-telo-part="nav">
      <Navigation
        label={say("siteNavigation")}
        layout="horizontal"
        items={tree.drawn.entries}
        more={{ key: MORE, label: say("more") }}
        open={open}
        onOpenChange={(next) => setOpen([...new Set(next)])}
        onChange={(key) => tree.follow(key)}
      />
      {children}
    </div>
  );
}

/** Opening and closing a surface: under its address when it declares one —
 *  holding `value` there — else in memory. */
function useOpened(surface: SurfaceSpec): { opened: string | undefined; open(value: string): void; close(): void } {
  const store = useHostStore();
  const host = useHost();
  const [held, setHeld] = useState<string>();
  const address = surface.address?.name;
  return {
    opened: address === undefined ? held : openValue(host.location.search, address),
    open: (value) => (address === undefined ? setHeld(value) : store.open(address, value, [address])),
    close: () => (address === undefined ? setHeld(undefined) : store.close(address)),
  };
}

/** The surface a narrow viewport uses: the compact one a surface names, else itself. */
function shownSurface(surface: SurfaceSpec, compact: boolean): SurfaceSpec {
  return compact && surface.compact ? (surface.compact as SurfaceSpec) : surface;
}

/** The whole tree behind a menu button, in a column whose groups open in place. */
function MenuButton({ placement, tree, children }: { placement: OverlayPlacement; tree: Tree; children: ReactNode }) {
  const { compact } = useContext(RendererContext);
  const say = useSay();
  const Navigation = useControl("Navigation");
  const Icon = useControl("Icon");
  const [open, setOpen] = useState<string[]>([]);
  const button = useRef<HTMLButtonElement | null>(null);
  const overlay = useOpened(placement.surface);
  const close = () => {
    setOpen([]);
    overlay.close();
  };
  return (
    <>
      <button
        data-telo-part="nav-menu"
        type="button"
        ref={button}
        aria-label={say("menu")}
        aria-expanded={overlay.opened === ""}
        onClick={() => overlay.open("")}
      >
        <Icon name="menu" />
      </button>
      {overlay.opened === "" && (
        <Surface spec={shownSurface(placement.surface, compact)} title={say("menu")} anchor={button} onClose={close}>
          <Navigation
            label={say("siteNavigation")}
            layout="vertical"
            items={tree.drawn.entries}
            more={{ key: MORE, label: say("more") }}
            open={open}
            onOpenChange={(next) => setOpen([...new Set(next)])}
            onChange={(key) => tree.follow(key, close)}
          />
          {children}
        </Surface>
      )}
    </>
  );
}

/**
 * The tree as a column whose groups open in place, several at once. In a
 * folded aside it is a rail, whose groups float beside it. The open groups are
 * kept under the column's own `state.key`.
 */
export function NavigationColumnNode({ node }: { node: NavigationColumnNodeSpec }): ReactNode {
  const host = useHost();
  const { prefix } = useContext(RendererContext);
  const say = useSay();
  const Navigation = useControl("Navigation");
  const aside = useContext(AsideContext);
  const tree = useTree(node.navigation.items, host.location.path);
  const groups = useMemo(() => new Set(groupKeys(tree.drawn.entries)), [tree.drawn.entries]);
  const kept = useRef<{ storage?: Storage; key?: string }>({});
  const [open, setOpen] = useState<string[]>(() => {
    if (node.state === null) return [];
    kept.current = { storage: navigationStorage(node.state.store), key: navigationStorageKey(prefix, node.state.key) };
    const stored = kept.current.storage && kept.current.key ? readNavigationStore(kept.current.storage, kept.current.key, groups) : undefined;
    return stored ?? [];
  });
  // A rail's floating panels are not kept: they close as the viewer moves on.
  const [floating, setFloating] = useState<string[]>([]);
  const written = useRef(false);
  useEffect(() => {
    // What was read back is written only once the viewer changes something.
    if (!written.current) {
      written.current = true;
      return;
    }
    const { storage, key } = kept.current;
    if (storage && key !== undefined && node.state && !writeNavigationStore(storage, node.state.store, key, open)) kept.current.storage = undefined;
  }, [open]);
  if (node.navigation.items.length === 0) return null;
  const rail = aside?.folded === true;
  const failing = tree.drawn.failing.map((href, index) => <Unresolved key={index} href={href} />);
  return (
    <div data-telo-part="nav-column">
      <Navigation
        label={say("siteNavigation")}
        layout={rail ? "rail" : "vertical"}
        items={tree.drawn.entries}
        more={{ key: MORE, label: say("more") }}
        open={rail ? floating : open.filter((key) => groups.has(key))}
        onOpenChange={(next) => (rail ? setFloating([...new Set(next)]) : setOpen([...new Set(next)].filter((key) => groups.has(key))))}
        onChange={(key) => tree.follow(key)}
      />
      {failing}
    </div>
  );
}

/**
 * The top-level entries as tabs along the application's bottom edge, at most `visible` of
 * them: with more, the last tab is More, holding the rest. A group's tab, and
 * More, opens its entries in the placement's surface, in a column whose groups
 * open in place; its tab is expanded while that surface is open.
 */
function TabBar({ placement, tree, children }: { placement: TabBarPlacement; tree: Tree; children: ReactNode }) {
  const { compact } = useContext(RendererContext);
  const bottom = useContext(BottomSlotContext);
  const say = useSay();
  const Navigation = useControl("Navigation");
  const bar = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState<string[]>([]);
  const sheet = useOpened(placement.surface);
  const top = tree.drawn.entries;
  const hidden = top.length > placement.visible ? top.slice(placement.visible - 1) : [];
  const shown: NavigationEntry[] =
    hidden.length === 0
      ? top
      : [
          ...top.slice(0, placement.visible - 1),
          { key: MORE, label: say("more"), items: hidden, ...(hidden.some(holdsCurrent) ? { current: "true" as const } : {}) },
        ];
  // A group's tab opens the surface, never a panel: the control draws it as a button opening a dialog.
  const tabs = shown.map(({ items, ...tab }): NavigationEntry => (items === undefined ? tab : { ...tab, opens: "dialog" }));
  const group = shown.find((tab) => tab.items !== undefined && tab.key === sheet.opened);
  const close = () => {
    setOpen([]);
    sheet.close();
  };
  if (bottom === null) return null;
  return createPortal(
    <div data-telo-part="tab-bar" ref={bar}>
      <Navigation
        label={say("siteNavigation")}
        layout="horizontal"
        items={tabs}
        open={group === undefined ? [] : [group.key]}
        onOpenChange={(next) => {
          const key = next[next.length - 1];
          if (key === undefined) close();
          else sheet.open(key);
        }}
        onChange={(key) => tree.follow(key)}
      />
      {children}
      {group?.items !== undefined && (
        <Surface spec={shownSurface(placement.surface, compact)} title={group.label} anchor={bar} onClose={close}>
          <Navigation
            layout="vertical"
            items={group.items}
            more={{ key: MORE, label: say("more") }}
            open={open}
            onOpenChange={(next) => setOpen([...new Set(next)])}
            onChange={(key) => tree.follow(key, close)}
          />
        </Surface>
      )}
    </div>,
    bottom,
  );
}

const holdsCurrent = (entry: NavigationEntry): boolean => entry.current !== undefined || (entry.items ?? []).some(holdsCurrent);
