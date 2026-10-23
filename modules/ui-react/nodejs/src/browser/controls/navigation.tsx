import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { NavigationEntry, NavigationProps } from "../../contract/ui-react-controls.js";
import { LAYER, leaveClosing, tabbables, useLayer } from "./layers.js";
import { usePlacement } from "./placement.js";
import { refs } from "./shared.js";

/** What every entry of one navigation reads. */
interface Scope {
  layout: NavigationProps["layout"];
  /** A group opens a panel over the page (a row, a rail), or in place beneath its button (a column). */
  floating: boolean;
  open: string[];
  root: RefObject<HTMLElement | null>;
  /** The open panels, by depth. */
  panels: Map<number, HTMLElement>;
  onOpenChange: NavigationProps["onOpenChange"];
  /** A plain press on a link: the renderer follows it, and every open panel closes. */
  follow(event: MouseEvent, key: string): void;
  /** A press or the focus outside a panel: the groups holding it stay open. */
  closeOutside(holding: string[]): void;
}

/** What a rail draws for a top-level entry: its label's first letter. */
const initial = (label: string) => (Array.from(label.trim())[0] ?? "").toLocaleUpperCase();

/**
 * Site navigation in the disclosure pattern: every entry a link, every group a
 * button opening its entries — in a panel over the page in a row or a rail, in
 * place beneath it in a column. Which groups are open and where a link leads
 * are the renderer's; the control reports intents.
 */
export function Navigation({ label, layout, items, more, open, attributes, onOpenChange, onChange }: NavigationProps) {
  const root = useRef<HTMLElement | null>(null);
  const row = useRef<HTMLUListElement | null>(null);
  const fitting = useFitting(root, row, items, layout === "horizontal" && more !== undefined);
  const latest = useRef({ open, onOpenChange });
  latest.current = { open, onOpenChange };
  const pending = useRef<string[] | null>(null);
  const panels = useRef(new Map<number, HTMLElement>());
  // Panels unmounted with the navigation report no press outside them afterwards.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const floating = layout !== "vertical";
  const scope: Scope = {
    layout,
    floating,
    open,
    root,
    panels: panels.current,
    onOpenChange,
    follow: (event, key) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onChange(key);
      if (floating && open.length > 0) onOpenChange([], "close");
    },
    // Every panel a press passes is told of it at once: they close as one.
    closeOutside: (holding) => {
      if (pending.current !== null) {
        if (holding.length < pending.current.length) pending.current = holding;
        return;
      }
      pending.current = holding;
      queueMicrotask(() => {
        const keep = pending.current ?? holding;
        pending.current = null;
        if (mounted.current) latest.current.onOpenChange(keep, "outside");
      });
    },
  };
  const hidden = items.slice(fitting.count);
  const shown: NavigationEntry[] =
    hidden.length === 0 || more === undefined
      ? items
      : [
          ...items.slice(0, fitting.count),
          { key: more.key, label: more.label, items: hidden, ...(hidden.some(holdsCurrent) ? { current: "true" as const } : {}) },
        ];
  const Root = label === undefined ? "div" : "nav";
  return (
    <Root
      {...attributes}
      data-telo-part="navigation"
      data-layout={layout}
      aria-label={label}
      ref={refs(root)}
      onKeyDown={floating ? flowTab(root) : undefined}
    >
      <ul ref={row}>
        {shown.map((entry) => (
          <li key={entry.key} ref={fitting.measure(entry.key === more?.key && hidden.length > 0 ? null : entry.key)}>
            <Entry entry={entry} holding={[]} scope={scope} />
          </li>
        ))}
      </ul>
    </Root>
  );
}

const holdsCurrent = (entry: NavigationEntry): boolean => entry.current !== undefined || (entry.items ?? []).some(holdsCurrent);

/** One entry, under the groups `holding` it, outermost first. */
function Entry({ entry, holding, scope }: { entry: NavigationEntry; holding: string[]; scope: Scope }) {
  const rail = scope.layout === "rail" && holding.length === 0;
  // A rail draws the entry's glyph, or its first letter when it has none.
  const text = rail ? (entry.icon ?? <span aria-hidden="true">{initial(entry.label)}</span>) : <>{entry.icon}{entry.label}</>;
  if (entry.opens === "dialog") return <Opener entry={entry} holding={holding} scope={scope} text={text} rail={rail} />;
  if (entry.items === undefined) {
    return (
      <a
        data-telo-part="nav-item"
        href={entry.href}
        aria-current={entry.current}
        data-current={entry.current}
        aria-label={rail ? entry.label : undefined}
        onClick={(event) => scope.follow(event, entry.key)}
      >
        {text}
      </a>
    );
  }
  return <Group entry={entry} holding={holding} scope={scope} text={text} rail={rail} />;
}

/** What a press on the button of a group, or of an entry opening a dialog, asks for:
 *  floating, opening one closes every group beside it; in place, a press toggles that one key. */
function pressed(entry: NavigationEntry, holding: string[], scope: Scope, isOpen: boolean): void {
  if (scope.floating) {
    if (isOpen) scope.onOpenChange(holding, "close");
    else scope.onOpenChange([...holding, entry.key]);
  } else if (isOpen) scope.onOpenChange(scope.open.filter((key) => key !== entry.key), "close");
  else scope.onOpenChange([...scope.open, entry.key]);
}

/** An entry whose button opens a dialog the renderer draws: expanded while its key is open. */
function Opener({ entry, holding, scope, text, rail }: { entry: NavigationEntry; holding: string[]; scope: Scope; text: ReactNode; rail: boolean }) {
  const isOpen = scope.open.includes(entry.key);
  return (
    <button
      type="button"
      data-telo-part="nav-toggle"
      aria-haspopup="dialog"
      aria-expanded={isOpen}
      aria-label={rail ? entry.label : undefined}
      data-state={isOpen ? "open" : "closed"}
      data-current={entry.current}
      onClick={() => pressed(entry, holding, scope, isOpen)}
    >
      {text}
    </button>
  );
}

function Group({ entry, holding, scope, text, rail }: { entry: NavigationEntry; holding: string[]; scope: Scope; text: ReactNode; rail: boolean }) {
  const entriesId = useId();
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const isOpen = scope.open.includes(entry.key);
  const Chevron = (holding.length === 0 && scope.layout === "horizontal") || (isOpen && !scope.floating) ? ChevronDown : ChevronRight;
  const press = () => pressed(entry, holding, scope, isOpen);
  const chain = [...holding, entry.key];
  return (
    <>
      <button
        type="button"
        data-telo-part="nav-toggle"
        ref={setButton}
        aria-expanded={isOpen}
        aria-controls={isOpen ? entriesId : undefined}
        aria-label={rail ? entry.label : undefined}
        data-state={isOpen ? "open" : "closed"}
        data-current={entry.current}
        onClick={press}
      >
        {text}
        <Chevron data-telo-part="icon" aria-hidden="true" focusable="false" />
      </button>
      {isOpen &&
        (scope.floating ? (
          <Panel id={entriesId} entries={entry.items ?? []} chain={chain} trigger={button} scope={scope} />
        ) : (
          <ul data-telo-part="nav-group" id={entriesId}>
            {(entry.items ?? []).map((item) => (
              <li key={item.key}>
                <Entry entry={item} holding={chain} scope={scope} />
              </li>
            ))}
          </ul>
        ))}
    </>
  );
}

/** A group's entries over the page, at the end of `<body>`, placed against its button. */
function Panel({ id, entries, chain, trigger, scope }: { id: string; entries: NavigationEntry[]; chain: string[]; trigger: HTMLElement | null; scope: Scope }) {
  const panel = useRef<HTMLDivElement | null>(null);
  const depth = chain.length - 1;
  const holding = chain.slice(0, depth);
  const { setFloating, style } = usePlacement(trigger, depth === 0 && scope.layout === "horizontal" ? "bottom" : "end", "start", 4, true);
  useLayer(true, {
    roots: () => [panel.current],
    // What the navigation itself draws is no press or focus outside a panel of it.
    inside: () => [panel.current, scope.root.current, trigger],
    modal: false,
    stopsBeneath: false,
    onEscape: () => scope.onOpenChange(holding, "escape"),
    onOutside: () => scope.closeOutside(holding),
    returnsFocus: false,
  });
  // A panel closing with the focus in it, or in a panel opened from it, gives the focus to its button.
  const button = useRef(trigger);
  button.current = trigger;
  useLayoutEffect(
    () => () => {
      const active = document.activeElement;
      const holdingFocus = [...scope.panels].some(([at, element]) => at >= depth && element.contains(active));
      leaveClosing(panel.current);
      if (holdingFocus) button.current?.focus();
    },
    [],
  );
  const register = (element: HTMLDivElement | null) => {
    if (element) scope.panels.set(depth, element);
    else if (scope.panels.get(depth) === panel.current) scope.panels.delete(depth);
  };
  return createPortal(
    <div data-telo-part="nav-panel" {...{ [LAYER]: "" }} data-state="open" id={id} ref={refs(register, panel, setFloating)} style={style}>
      <ul>
        {entries.map((entry) => (
          <li key={entry.key}>
            <Entry entry={entry} holding={chain} scope={scope} />
          </li>
        ))}
      </ul>
    </div>,
    document.body,
  );
}

/** The order Tab moves in: each open group's panel right after its button. */
function flow(container: Element): HTMLElement[] {
  return tabbables(container).flatMap((element) => {
    const opened = element.getAttribute("data-telo-part") === "nav-toggle" && element.getAttribute("aria-expanded") === "true";
    const panel = opened ? element.ownerDocument.getElementById(element.getAttribute("aria-controls") ?? "") : null;
    return panel ? [element, ...flow(panel)] : [element];
  });
}

/**
 * Tab and Shift+Tab move through the navigation as if every open panel stood
 * right after its button; past either end, the browser moves on from the
 * navigation's own first or last entry.
 */
const flowTab = (root: RefObject<HTMLElement | null>) => (event: KeyboardEvent) => {
  if (event.key !== "Tab" || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || !root.current) return;
  const order = flow(root.current);
  const at = order.indexOf(event.target as HTMLElement);
  if (at === -1) return;
  const next = order[at + (event.shiftKey ? -1 : 1)];
  if (next) {
    event.preventDefault();
    next.focus();
    return;
  }
  const own = tabbables(root.current);
  own[event.shiftKey ? 0 : own.length - 1]?.focus();
};

/**
 * How many top-level entries fit a horizontal row; the More group holds the
 * rest. Every entry's width is measured while it is drawn, so a changed list
 * is drawn whole once, and the row is measured again whenever it resizes.
 */
function useFitting(root: RefObject<HTMLElement | null>, row: RefObject<HTMLUListElement | null>, items: NavigationEntry[], measuring: boolean) {
  const keys = items.map((item) => item.key);
  const signature = keys.join("\u0000");
  const [count, setCount] = useState(keys.length);
  const widths = useRef(new Map<string, number>());
  const elements = useRef(new Map<string, HTMLElement>());
  const moreElement = useRef<HTMLElement | null>(null);
  const moreWidth = useRef(0);
  const held = useRef(count);
  held.current = count;
  useLayoutEffect(() => {
    widths.current = new Map();
    setCount(keys.length);
  }, [signature, measuring]);
  useLayoutEffect(() => {
    if (!measuring || !root.current || !row.current) return;
    const container = root.current;
    const list = row.current;
    const fit = () => {
      const gap = parseFloat(getComputedStyle(list).columnGap) || 0;
      for (const [key, element] of elements.current) widths.current.set(key, element.getBoundingClientRect().width + gap);
      if (moreElement.current) moreWidth.current = moreElement.current.getBoundingClientRect().width + gap;
      const available = container.clientWidth;
      const needed = keys.map((key) => widths.current.get(key) ?? 0);
      let fits = keys.length;
      // A lone entry is never traded for a More group holding it alone.
      if (keys.length > 1 && needed.reduce((sum, width) => sum + width, 0) > available) {
        let used = moreWidth.current;
        fits = 0;
        while (fits < needed.length && used + needed[fits] <= available) used += needed[fits++];
      }
      if (fits !== held.current) setCount(fits);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    return () => observer.disconnect();
  }, [signature, measuring, count]);
  return {
    count: measuring ? count : keys.length,
    /** The ref of a row entry: an entry by its key, the More group by `null`. */
    measure: (key: string | null) => (element: HTMLElement | null) => {
      if (key === null) moreElement.current = element;
      else if (element) elements.current.set(key, element);
      else elements.current.delete(key);
    },
  };
}
