import { useContext, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import type { NavigationEntry } from "../contract/ui-react-controls.js";
import { useControl } from "./effective-controls.js";
import { useHost, useHostStore } from "./host.js";
import { linkAddress, pageAddress } from "./link-address.js";
import {
  navigationStorage,
  navigationStorageKey,
  readNavigationStore,
  writeNavigationStore,
  type NavigationStore,
  type SidebarState,
} from "./navigation-state.js";
import { ErrorNode } from "./nodes.js";
import { openValue } from "./open-address.js";
import { RendererContext } from "./renderer-context.js";
import { Surface, type SurfaceSpec } from "./surface.js";
import { useSay, useText, type WireText } from "./texts.js";

/** An entry of the application's navigation, as the application document
 *  says it: `key` is the slug of its source text under its group's key — what
 *  a stored or addressed state names it by — and `icon` the address its
 *  glyph's file is served at. */
export type NavigationEntrySpec =
  | { type: "page"; key: string; path: string; text: WireText; icon?: string }
  | { type: "link"; key: string; href: string; text: WireText; icon?: string }
  | { type: "group"; key: string; text: WireText; items: NavigationEntrySpec[]; icon?: string };

/** The whole tree behind a menu button. */
type OverlayPlacement = { type: "overlay"; surface: SurfaceSpec };
/** The top-level entries as tabs along the bottom edge. */
type TabBarPlacement = { type: "tab-bar"; visible: number; surface: SurfaceSpec };
type CompactPlacement = OverlayPlacement | TabBarPlacement;

/** How the navigation is drawn: in the header, in a sidebar, behind a menu button, or as a tab bar. */
export type NavigationPlacementSpec =
  | { type: "header"; compact: CompactPlacement }
  | {
      type: "sidebar";
      side: "start" | "end";
      rail?: { collapsed: boolean };
      store: NavigationStore;
      compact: CompactPlacement;
    }
  | CompactPlacement;

export interface NavigationSpec {
  items: NavigationEntrySpec[];
  placement: NavigationPlacementSpec;
}

/** Where in the application the navigation may be drawn: the header's start,
 *  middle and end, a column before or after `main`, and the bottom edge. */
export type NavigationSlot = "start" | "middle" | "end" | "before" | "after" | "bottom";

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

/** The entries with their addresses, the shown page's entry and every group on
 *  the way to it marked current. An entry whose address does not resolve is
 *  left out, and a group left with nothing with it. */
function drawn(items: NavigationEntrySpec[], path: string, address: (href: string) => string | undefined, label: (text: WireText) => string): Drawn {
  const addresses = new Map<string, string>();
  const failing: string[] = [];
  const entries = (list: NavigationEntrySpec[]): NavigationEntry[] =>
    list.flatMap((entry): NavigationEntry[] => {
      const key = entry.key;
      const icon = entry.icon === undefined ? {} : { icon: glyph(entry.icon) };
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
      const current = entry.type === "page" && entry.path === path;
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

/** The slot a placement is drawn in. */
function slotOf(placement: NavigationPlacementSpec): NavigationSlot {
  switch (placement.type) {
    case "header":
      return "middle";
    case "sidebar":
      return placement.side === "end" ? "after" : "before";
    case "tab-bar":
      return "bottom";
    case "overlay":
      return placement.surface.type === "drawer" && placement.surface.side === "end" ? "end" : "start";
  }
}

/** The tree drawn, and how following one of its links moves the page. */
interface Tree {
  drawn: Drawn;
  /** Follow the link under `key`; `then` runs first, when the move is to happen. */
  follow(key: string, then?: () => void): void;
}

/**
 * The application's navigation where its placement says: a row in the header
 * — a group a dropdown, a nested group a submenu — a column beside the page
 * whose groups open in place, collapsible to a rail, a menu button opening the
 * whole tree in a surface, or a tab bar along the bottom edge. Below the
 * breakpoint a header row or a sidebar is replaced by its compact placement.
 * `side` is the slot this part is drawn in; it draws only in its placement's.
 */
export function SiteNavigation({ navigation, path, side }: { navigation: NavigationSpec; path: string; side: NavigationSlot }): ReactNode {
  const store = useHostStore();
  const host = useHost();
  const { prefix, pages, compact } = useContext(RendererContext);
  const text = useText();
  const declared = navigation.placement;
  const placement = compact && (declared.type === "header" || declared.type === "sidebar") ? declared.compact : declared;
  if (slotOf(placement) !== side) return null;

  // A navigation with nothing delivered draws nothing, not even its button.
  if (navigation.items.length === 0) return null;
  const tree: Tree = {
    drawn: drawn(navigation.items, path, (href) => linkAddress(store, href), text),
    follow: (key, then) => {
      const href = tree.drawn.addresses.get(key);
      if (href === undefined) return;
      then?.();
      const to = pageAddress(prefix, pages, href);
      if (to === undefined) store.leave(href);
      else host.navigate(to);
    },
  };
  // Two entries may hold one failing address: each is keyed by its place among them.
  const failing = tree.drawn.failing.map((href, index) => <Unresolved key={index} href={href} />);
  switch (placement.type) {
    case "header":
      return <HeaderRow tree={tree}>{failing}</HeaderRow>;
    case "sidebar":
      return <Sidebar placement={placement} tree={tree}>{failing}</Sidebar>;
    case "overlay":
      return <MenuButton placement={placement} tree={tree}>{failing}</MenuButton>;
    case "tab-bar":
      return <TabBar placement={placement} tree={tree}>{failing}</TabBar>;
  }
}

/** The tree in a row in the header: a group opens as a dropdown, what does not fit moves under More. */
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
 * The tree in a column beside the page, its groups opening in place, several
 * at once. With a rail it collapses to one, whose groups float beside it. The
 * open groups and whether it is collapsed are kept in its store.
 */
function Sidebar({ placement, tree, children }: { placement: Extract<NavigationPlacementSpec, { type: "sidebar" }>; tree: Tree; children: ReactNode }) {
  const { prefix } = useContext(RendererContext);
  const say = useSay();
  const Navigation = useControl("Navigation");
  const Icon = useControl("Icon");
  const id = useId();
  const groups = useMemo(() => new Set(groupKeys(tree.drawn.entries)), [tree.drawn.entries]);
  const kept = useRef<{ storage?: Storage; key: string }>({ key: navigationStorageKey(prefix) });
  const [state, setState] = useState<SidebarState>(() => {
    const storage = navigationStorage(placement.store);
    kept.current.storage = storage;
    const stored = storage ? readNavigationStore(storage, kept.current.key, groups) : undefined;
    return { open: stored?.open ?? [], collapsed: stored?.collapsed ?? placement.rail?.collapsed ?? false };
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
    if (storage && !writeNavigationStore(storage, placement.store, key, state)) kept.current.storage = undefined;
  }, [state]);
  const collapsed = placement.rail !== undefined && state.collapsed;
  return (
    <div data-telo-part="sidebar" data-side={placement.side} data-state={collapsed ? "closed" : "open"}>
      {placement.rail !== undefined && (
        <button
          data-telo-part="sidebar-toggle"
          type="button"
          aria-label={say(collapsed ? "expandNavigation" : "collapseNavigation")}
          aria-expanded={!collapsed}
          aria-controls={id}
          onClick={() => {
            setFloating([]);
            setState((now) => ({ ...now, collapsed: !now.collapsed }));
          }}
        >
          <Icon name={collapsed ? "expand" : "collapse"} />
        </button>
      )}
      <Navigation
        label={say("siteNavigation")}
        layout={collapsed ? "rail" : "vertical"}
        items={tree.drawn.entries}
        more={{ key: MORE, label: say("more") }}
        open={collapsed ? floating : state.open.filter((key) => groups.has(key))}
        onOpenChange={(next) =>
          collapsed ? setFloating([...new Set(next)]) : setState((now) => ({ ...now, open: [...new Set(next)].filter((key) => groups.has(key)) }))
        }
        onChange={(key) => tree.follow(key)}
        attributes={{ id }}
      />
      {children}
    </div>
  );
}

/**
 * The top-level entries as tabs along the bottom edge, at most `visible` of
 * them: with more, the last tab is More, holding the rest. A group's tab, and
 * More, opens its entries in the placement's surface, in a column whose groups
 * open in place; its tab is expanded while that surface is open.
 */
function TabBar({ placement, tree, children }: { placement: TabBarPlacement; tree: Tree; children: ReactNode }) {
  const { compact } = useContext(RendererContext);
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
  return (
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
    </div>
  );
}

const holdsCurrent = (entry: NavigationEntry): boolean => entry.current !== undefined || (entry.items ?? []).some(holdsCurrent);
