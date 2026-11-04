import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Displayed, type ButtonSpec } from "./display-button.js";
import { useHostStore } from "./host.js";
import { navigationStorage, type NavigationStore } from "./navigation-state.js";
import { Node, type SpecNode } from "./nodes.js";
import { EmbeddedContext, RendererContext, VisibleContext } from "./renderer-context.js";
import { Surface, useHeldInside, type SurfaceSpec } from "./surface.js";
import { useSay, useText, type WireText } from "./texts.js";
import { fillAttribute, styleAttribute, type Style } from "./bindings.js";

/** The `split` node of a page document: every member present. */
export interface SplitNodeSpec {
  side: "start" | "end";
  size: "small" | "medium" | "large";
  frame: "framed" | "flush";
  toggle: ButtonSpec;
  label: WireText;
  aside: { actions: SpecNode[]; content: SpecNode };
  content: SpecNode;
  collapse: { collapsed: boolean; state: { key: string; store: NavigationStore } | null } | null;
  compact: SurfaceSpec;
  style?: Style;
  fill?: boolean;
}

const VERSION = 1;

/** A bar entry as the rail draws it: a glyph alone, the text left to the accessible name and tooltip. */
function railEntry(entry: SpecNode): SpecNode {
  const button = entry.button as ButtonSpec | null | undefined;
  if (button == null) return entry;
  return { ...entry, button: button.type === "text" ? { type: "icon", icon: null, label: "hidden" } : { ...button, label: "hidden" } };
}

/** The storage key of a split view's fold: one per mount and key. */
export const splitStorageKey = (mount: string, key: string): string => `telo.ui:${mount === "" ? "/" : mount}:s:${key}`;

/** Whether the aside is folded away: what the store holds, else what the node starts with. */
function useFold(collapse: SplitNodeSpec["collapse"], mount: string): [boolean, (folded: boolean) => void] {
  const state = collapse?.state ?? null;
  const key = state === null ? undefined : splitStorageKey(mount, state.key);
  const storage = useRef<Storage | undefined>(undefined);
  const [folded, setFolded] = useState(() => {
    if (collapse === null) return false;
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
        console.error(`The browser refuses ${state.store.type} storage, so the split view's fold is kept in memory: ${error instanceof Error ? error.message : String(error)}`);
        storage.current = undefined;
      }
    },
  ];
}

/** Takes `element` into itself, wherever the aside is drawn now; the aside's
 *  tree is mounted once, in `element`, and so outlives each move. */
function Place({ element }: { element: HTMLElement }) {
  const take = useCallback(
    (parent: HTMLElement | null) => {
      if (parent) parent.append(element);
    },
    [element],
  );
  return <div style={{ display: "contents" }} ref={take} />;
}

/**
 * An aside beside its content. The aside stays mounted in every state — open,
 * folded to a rail holding only its bar, or in the compact surface, a closed
 * one included — so what it holds keeps its state; while it is not visible it
 * starts no request.
 */
export function SplitNode({ node }: { node: SplitNodeSpec }) {
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
  const [folded, setFolded] = useFold(node.collapse, prefix);
  const [sheet, setSheet] = useState(false);
  const opened = narrow && sheet;
  const state = narrow ? "compact" : folded ? "collapsed" : "open";
  const showing = narrow ? opened : !folded;
  // A flush split is one framed panel round both halves, so what they hold draws no frame of its own.
  const flush = node.frame === "flush";
  // A filling split stretches both halves to its height; the aside then scrolls on its own.
  const fill = fillAttribute(node);
  const label = text(node.label);
  const inAside = useRef<HTMLButtonElement | null>(null);
  const inRail = useRef<HTMLButtonElement | null>(null);
  const handOver = useRef(false);

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

  const toggle = (ref: RefObject<HTMLButtonElement | null>, onClick: () => void): ReactNode => (
    <Displayed display={node.toggle} text={say(showing ? "splitHide" : "splitShow", { label })} glyph={state === "open" ? "panel-close" : "panel-open"}>
      <button data-telo-part="split-toggle" type="button" ref={ref} aria-expanded={showing} aria-controls={id} onClick={onClick} />
    </Displayed>
  );
  const fold = (next: boolean) => {
    handOver.current = true;
    setFolded(next);
  };

  const aside = createPortal(
    <div style={{ display: "contents" }} onPointerDownCapture={held.mark} onFocusCapture={held.mark} onClickCapture={held.mark}>
      <VisibleContext.Provider value={visible && showing}>
        <aside data-telo-part="split-aside" id={id} data-side={node.side} data-size={node.size} data-frame={node.frame} data-state={state === "collapsed" ? "rail" : state} data-fill={fill} aria-label={label}>
          {state !== "compact" && node.collapse !== null && <div data-telo-part="split-bar">{toggle(inAside, () => fold(state === "open"))}</div>}
          {state !== "compact" && node.aside.actions.length > 0 && (
            <div data-telo-part="split-actions">
              {node.aside.actions.map((entry, index) => (
                <Node key={index} node={state === "collapsed" ? railEntry(entry) : entry} />
              ))}
            </div>
          )}
          <div hidden={state === "collapsed"} style={state === "collapsed" ? undefined : { display: "contents" }}>
            <EmbeddedContext.Provider value={flush && state !== "compact"}>
              <Node node={node.aside.content} />
            </EmbeddedContext.Provider>
          </div>
        </aside>
      </VisibleContext.Provider>
    </div>,
    host,
  );

  // Below the breakpoint the rail is drawn beside the content on its own, holding the toggle that opens the surface.
  const rail =
    state === "compact" ? (
      <div data-telo-part="split-aside" data-side={node.side} data-size={node.size} data-frame={node.frame} data-state="rail" data-fill={fill}>
        <div data-telo-part="split-bar">{toggle(inRail, () => setSheet(true))}</div>
        {node.aside.actions.length > 0 && (
          <div data-telo-part="split-actions">
            {node.aside.actions.map((entry, index) => (
              <Node key={index} node={railEntry(entry)} />
            ))}
          </div>
        )}
      </div>
    ) : null;

  return (
    <div data-telo-part="split" data-side={node.side} data-state={state} data-frame={node.frame} data-fill={fill} data-style={styleAttribute(node.style)}>
      {!narrow && node.side !== "end" && <Place element={host} />}
      {node.side !== "end" && rail}
      <div data-telo-part="split-content" data-fill={fill}>
        <EmbeddedContext.Provider value={flush}>
          <Node node={node.content} />
        </EmbeddedContext.Provider>
      </div>
      {!narrow && node.side === "end" && <Place element={host} />}
      {node.side === "end" && rail}
      {aside}
      {opened && (
        <Surface spec={node.compact} title={label} anchor={inRail} onClose={() => setSheet(false)}>
          <Place element={host} />
        </Surface>
      )}
    </div>
  );
}
