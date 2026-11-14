import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Displayed, type ButtonSpec } from "./display-button.js";
import { useHostStore } from "./host.js";
import { navigationStorage, type NavigationStore } from "./navigation-state.js";
import { Node, type SpecNode } from "./nodes.js";
import { EmbeddedContext, RendererContext, VisibleContext } from "./renderer-context.js";
import { Surface, useHeldInside, type SurfaceSpec } from "./surface.js";
import { useSay, useText, type WireText } from "./texts.js";

/** The `Aside` shape of the wire: what a split view and a page layout both hold. */
export interface AsideSpec {
  side: "start" | "end";
  size: "small" | "medium" | "large";
  frame: "framed" | "flush";
  toggle: ButtonSpec;
  label: WireText;
  collapse: { collapsed: boolean; state: { key: string; store: NavigationStore } | null } | null;
  compact: SurfaceSpec;
  actions: SpecNode[];
  content: SpecNode;
}

/** What an aside tells what it holds about it. */
export interface AsideState {
  /** Folded to its rail: a navigation column draws as a rail of glyphs. */
  folded: boolean;
}

/** Present inside an aside's content; null everywhere else. */
export const AsideContext = createContext<AsideState | null>(null);

const VERSION = 1;

/** A bar entry as the rail draws it: a glyph alone, the text left to the accessible name and tooltip. */
function railEntry(entry: SpecNode): SpecNode {
  const button = entry.button as ButtonSpec | null | undefined;
  if (button == null) return entry;
  return { ...entry, button: button.type === "text" ? { type: "icon", icon: null, label: "hidden" } : { ...button, label: "hidden" } };
}

/** The storage key of an aside's fold: one per mount and key. */
export const asideStorageKey = (mount: string, key: string): string => `telo.ui:${mount === "" ? "/" : mount}:s:${key}`;

/** Whether the aside is folded away: what the store holds, else what the spec starts with. */
function useFold(collapse: AsideSpec["collapse"] | undefined, mount: string): [boolean, (folded: boolean) => void] {
  const state = collapse?.state ?? null;
  const key = state === null ? undefined : asideStorageKey(mount, state.key);
  const storage = useRef<Storage | undefined>(undefined);
  const [folded, setFolded] = useState(() => {
    if (collapse == null) return false;
    storage.current = state === null ? undefined : navigationStorage(state.store);
    try {
      const entry = JSON.parse((key === undefined ? null : storage.current?.getItem(key)) ?? "null") as { v?: unknown; collapsed?: unknown } | null;
      if (entry?.v === VERSION && typeof entry.collapsed === "boolean") return entry.collapsed;
    } catch {
      // Not an entry this renderer wrote: it is left alone, and replaced by the next write.
    }
    return collapse.collapsed;
  });
  return [
    folded,
    (next) => {
      setFolded(next);
      if (key === undefined || state === null) return;
      try {
        storage.current?.setItem(key, JSON.stringify({ v: VERSION, collapsed: next }));
      } catch (error) {
        console.error(`The browser refuses ${state.store.type} storage, so the aside's fold is kept in memory: ${error instanceof Error ? error.message : String(error)}`);
        storage.current = undefined;
      }
    },
  ];
}

/** Takes `element` into itself, wherever the aside is drawn now; the aside's
 *  tree is mounted once, in `element`, and so outlives each move. */
function Place({ element, region }: { element: HTMLElement; region?: string }) {
  const take = useCallback(
    (parent: HTMLElement | null) => {
      if (parent) parent.append(element);
    },
    [element],
  );
  return <div style={{ display: "contents" }} data-telo-region={region} ref={take} />;
}

/** The aside, drawn in its states, in pieces its holder places. */
export interface AsideDrawing {
  side: "start" | "end";
  state: "open" | "collapsed" | "compact";
  /** Where the open or folded aside stands: put it beside the content. */
  place(region?: string): ReactNode;
  /** The compact state's rail, holding the toggle that opens the surface; null in the other states. */
  rail: ReactNode;
  /** The aside's mounted tree and, in the compact state, its surface: put it anywhere, once. */
  mounted: ReactNode;
  /** The top of a flush aside's panel is shared with its content, so what they hold draws no frame of its own. */
  flush: boolean;
}

/**
 * An aside. The aside stays mounted in every state — open, folded to a rail
 * holding only its bar, or in the compact surface, a closed one included — so
 * what it holds keeps its state; while it is not visible it starts no request.
 * With no spec every hook still runs and nothing is drawn. `fill` is the
 * holder's: a filling split view stretches its aside, which then scrolls on its own.
 */
export function useAside(spec: AsideSpec | undefined, fill?: "true"): AsideDrawing | undefined {
  const text = useText();
  const say = useSay();
  const store = useHostStore();
  const { prefix, compact: narrow } = useContext(RendererContext);
  const visible = useContext(VisibleContext);
  const id = useId();
  const held = useHeldInside();
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.style.display = "contents";
    return element;
  });
  const [folded, setFolded] = useFold(spec?.collapse, prefix);
  const [sheet, setSheet] = useState(false);
  const inAside = useRef<HTMLButtonElement | null>(null);
  const inRail = useRef<HTMLButtonElement | null>(null);
  const handOver = useRef(false);
  const opened = narrow && sheet && spec !== undefined;

  // A move within the application that began inside the surface leaves it.
  useEffect(() => {
    if (!opened) return;
    return store.subscribe(() => {
      if (held.inside()) setSheet(false);
    });
  }, [opened, store]);

  // The toggle keeps its place in the aside's bar when folding; the focus is kept on it.
  useLayoutEffect(() => {
    if (!handOver.current) return;
    handOver.current = false;
    inAside.current?.focus();
  }, [folded]);

  if (spec === undefined) return undefined;
  const state = narrow ? "compact" : folded ? "collapsed" : "open";
  const showing = narrow ? opened : !folded;
  const flush = spec.frame === "flush";
  const label = text(spec.label);

  const toggle = (ref: RefObject<HTMLButtonElement | null>, onClick: () => void): ReactNode => (
    <Displayed display={spec.toggle} text={say(showing ? "splitHide" : "splitShow", { label })} glyph={state === "open" ? "panel-close" : "panel-open"}>
      <button data-telo-part="aside-toggle" type="button" ref={ref} aria-expanded={showing} aria-controls={id} onClick={onClick} />
    </Displayed>
  );
  const fold = (next: boolean) => {
    handOver.current = true;
    setFolded(next);
  };
  // A column draws its own rail, so a folded aside keeps one on show.
  const holdsRail = spec.content.type === "navigation-column";

  const aside = createPortal(
    <div style={{ display: "contents" }} onPointerDownCapture={held.mark} onFocusCapture={held.mark} onClickCapture={held.mark}>
      <VisibleContext.Provider value={visible && showing}>
        <aside data-telo-part="aside" id={id} data-side={spec.side} data-size={spec.size} data-frame={spec.frame} data-state={state === "collapsed" ? "rail" : state} data-fill={fill} aria-label={label}>
          {state !== "compact" && spec.collapse !== null && <div data-telo-part="aside-bar">{toggle(inAside, () => fold(state === "open"))}</div>}
          {state !== "compact" && spec.actions.length > 0 && (
            <div data-telo-part="aside-actions">
              {spec.actions.map((entry, index) => (
                <Node key={index} node={state === "collapsed" ? railEntry(entry) : entry} />
              ))}
            </div>
          )}
          <div hidden={state === "collapsed" && !holdsRail} style={state === "collapsed" && !holdsRail ? undefined : { display: "contents" }}>
            <AsideContext.Provider value={{ folded: state === "collapsed" }}>
              <EmbeddedContext.Provider value={flush && state !== "compact"}>
                <Node node={spec.content} />
              </EmbeddedContext.Provider>
            </AsideContext.Provider>
          </div>
        </aside>
      </VisibleContext.Provider>
    </div>,
    host,
  );

  // Below the breakpoint the rail is drawn on its own, holding the toggle that opens the surface.
  const rail =
    state === "compact" ? (
      <div data-telo-part="aside" data-side={spec.side} data-size={spec.size} data-frame={spec.frame} data-state="rail" data-fill={fill}>
        <div data-telo-part="aside-bar">{toggle(inRail, () => setSheet(true))}</div>
        {spec.actions.length > 0 && (
          <div data-telo-part="aside-actions">
            {spec.actions.map((entry, index) => (
              <Node key={index} node={railEntry(entry)} />
            ))}
          </div>
        )}
      </div>
    ) : null;

  return {
    side: spec.side,
    state,
    flush,
    place: (region) => (narrow ? null : <Place element={host} region={region} />),
    rail,
    mounted: (
      <>
        {aside}
        {opened && (
          <Surface spec={spec.compact} title={label} anchor={inRail} onClose={() => setSheet(false)}>
            <Place element={host} />
          </Surface>
        )}
      </>
    ),
  };
}
