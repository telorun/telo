import { ChevronDown, ChevronRight } from "lucide-react";
import { NavigationMenu, Portal } from "radix-ui";
import { Popper } from "radix-ui/internal";
import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import type { CloseReason, NavigationEntry, NavigationProps } from "../../../../ui-react/nodejs/src/contract/ui-react-controls.js";
import { inLaterLayer, leaveClosing, useMarkedContent } from "./layers.js";

/** What every entry of one navigation reads. */
interface Scope {
  layout: NavigationProps["layout"];
  open: string[];
  root: RefObject<HTMLElement | null>;
  /** The open panels, by depth. */
  panels: Map<number, HTMLElement>;
  onOpenChange: NavigationProps["onOpenChange"];
  follow(event: MouseEvent, key: string): void;
  /** A press or the focus outside a panel: the groups holding it stay open. */
  closeOutside(holding: string[]): void;
}

const initial = (label: string) => (Array.from(label.trim())[0] ?? "").toLocaleUpperCase();

const holdsCurrent = (entry: NavigationEntry): boolean => entry.current !== undefined || (entry.items ?? []).some(holdsCurrent);

/** The one group of `entries` listed open: the floating layouts open one group beside others at most. */
const openAmong = (entries: NavigationEntry[], open: string[]) => entries.find((entry) => entry.items !== undefined && open.includes(entry.key))?.key ?? "";

/** A plain press on a link — no modifier key, the main button — is the renderer's to follow. */
const plainPress = (event: MouseEvent) =>
  !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/** Pointer movement opens and closes nothing: a group opens from its button alone. */
const still = (event: { preventDefault(): void }) => event.preventDefault();

/**
 * Site navigation: every entry a link, every group a button. In a row or a
 * rail it is Radix's navigation menu, a group opening its entries in a panel
 * at the end of `<body>`, placed by the primitives' popper; in a column a
 * group opens its entries in place beneath its button. Which groups are open
 * and where a link leads are the renderer's; the control reports intents.
 */
export function Navigation(props: NavigationProps) {
  return props.layout === "vertical" ? <InPlaceNavigation {...props} /> : <FloatingNavigation {...props} />;
}

function InPlaceNavigation({ label, items, open, attributes, onOpenChange, onChange }: NavigationProps) {
  const Root = label === undefined ? "div" : "nav";
  const follow = (event: MouseEvent, key: string) => {
    if (!plainPress(event)) return;
    event.preventDefault();
    onChange(key);
  };
  const entry = (item: NavigationEntry) => (
    <li key={item.key}>
      {item.opens === "dialog" ? (
        <button
          type="button"
          data-telo-part="nav-toggle"
          aria-haspopup="dialog"
          aria-expanded={open.includes(item.key)}
          data-state={open.includes(item.key) ? "open" : "closed"}
          data-current={item.current}
          onClick={() => (open.includes(item.key) ? onOpenChange(open.filter((key) => key !== item.key), "close") : onOpenChange([...open, item.key]))}
        >
          {item.icon}
          {item.label}
        </button>
      ) : item.items === undefined ? (
        <a data-telo-part="nav-item" href={item.href} aria-current={item.current} data-current={item.current} onClick={(event) => follow(event, item.key)}>
          {item.icon}
          {item.label}
        </a>
      ) : (
        <InPlaceGroup entry={item} open={open} onOpenChange={onOpenChange} draw={entry} />
      )}
    </li>
  );
  return (
    <Root {...attributes} data-telo-part="navigation" data-layout="vertical" aria-label={label}>
      <ul>{items.map(entry)}</ul>
    </Root>
  );
}

/** A group of a column: a press toggles its own key alone, and its entries are drawn right after its button. */
function InPlaceGroup({ entry, open, onOpenChange, draw }: { entry: NavigationEntry; open: string[]; onOpenChange: NavigationProps["onOpenChange"]; draw: (entry: NavigationEntry) => ReactNode }) {
  const entriesId = useId();
  const isOpen = open.includes(entry.key);
  const Chevron = isOpen ? ChevronDown : ChevronRight;
  return (
    <>
      <button
        type="button"
        data-telo-part="nav-toggle"
        aria-expanded={isOpen}
        aria-controls={isOpen ? entriesId : undefined}
        data-state={isOpen ? "open" : "closed"}
        data-current={entry.current}
        onClick={() => (isOpen ? onOpenChange(open.filter((key) => key !== entry.key), "close") : onOpenChange([...open, entry.key]))}
      >
        {entry.icon}
        {entry.label}
        <Chevron data-telo-part="icon" aria-hidden="true" focusable="false" />
      </button>
      {isOpen && (
        <ul data-telo-part="nav-group" id={entriesId}>
          {(entry.items ?? []).map(draw)}
        </ul>
      )}
    </>
  );
}

function FloatingNavigation({ label, layout, items, more, open, attributes, onOpenChange, onChange }: NavigationProps) {
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
  // Why the primitive is about to close the outermost group.
  const reason = useRef<CloseReason>("close");
  const scope: Scope = {
    layout,
    open,
    root,
    panels: panels.current,
    onOpenChange,
    follow: (event, key) => {
      if (!plainPress(event)) return;
      event.preventDefault();
      onChange(key);
      if (open.length > 0) onOpenChange([], "close");
    },
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
    <NavigationMenu.Root
      asChild
      value={openAmong(shown, open)}
      orientation={layout === "horizontal" ? "horizontal" : "vertical"}
      aria-label={label}
      onValueChange={(value) => {
        // The primitive closes the outermost group on Escape, a press or the
        // focus outside it; every other change is reported where it is made.
        const why = reason.current;
        reason.current = "close";
        if (value === "") onOpenChange([], why);
      }}
    >
      <Root
        {...attributes}
        data-telo-part="navigation"
        data-layout={layout}
        ref={(element: HTMLElement | null) => {
          root.current = element;
        }}
      >
        <NavigationMenu.List ref={row}>
          {shown.map((entry) => (
            <NavigationMenu.Item key={entry.key} value={entry.key} ref={fitting.measure(entry.key === more?.key && hidden.length > 0 ? null : entry.key)}>
              <Entry entry={entry} holding={[]} scope={scope} reason={reason} />
            </NavigationMenu.Item>
          ))}
        </NavigationMenu.List>
      </Root>
    </NavigationMenu.Root>
  );
}

interface EntryProps {
  entry: NavigationEntry;
  /** The groups holding the entry, outermost first. */
  holding: string[];
  scope: Scope;
  reason: RefObject<CloseReason>;
}

function Entry({ entry, holding, scope, reason }: EntryProps) {
  const rail = scope.layout === "rail" && holding.length === 0;
  // A rail draws the entry's glyph, or its first letter when it has none.
  const text = rail ? (entry.icon ?? <span aria-hidden="true">{initial(entry.label)}</span>) : <>{entry.icon}{entry.label}</>;
  if (entry.opens === "dialog") {
    const isOpen = scope.open.includes(entry.key);
    return (
      // A link of the primitive's focus group, drawn as the button it is: the arrow keys reach it.
      <NavigationMenu.Link asChild onSelect={still}>
        <button
          type="button"
          data-telo-part="nav-toggle"
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          aria-current={undefined}
          aria-label={rail ? entry.label : undefined}
          data-state={isOpen ? "open" : "closed"}
          data-current={entry.current}
          onClick={() => (isOpen ? scope.onOpenChange(holding, "close") : scope.onOpenChange([...holding, entry.key]))}
        >
          {text}
        </button>
      </NavigationMenu.Link>
    );
  }
  if (entry.items === undefined) {
    return (
      <NavigationMenu.Link
        data-telo-part="nav-item"
        href={entry.href}
        aria-current={entry.current}
        data-current={entry.current}
        aria-label={rail ? entry.label : undefined}
        onClick={(event) => scope.follow(event, entry.key)}
        // Following a link is reported by the control, so the primitive closes nothing of its own.
        onSelect={still}
      >
        {text}
      </NavigationMenu.Link>
    );
  }
  return <Group entry={entry} holding={holding} scope={scope} reason={reason} text={text} rail={rail} />;
}

function Group({ entry, holding, scope, reason, text, rail }: EntryProps & { text: ReactNode; rail: boolean }) {
  const button = useRef<HTMLButtonElement | null>(null);
  const isOpen = scope.open.includes(entry.key);
  const Chevron = holding.length === 0 && scope.layout === "horizontal" ? ChevronDown : ChevronRight;
  return (
    <Popper.Root>
      <Popper.Anchor virtualRef={button as RefObject<HTMLButtonElement>} />
      <NavigationMenu.Trigger
        data-telo-part="nav-toggle"
        ref={button}
        aria-label={rail ? entry.label : undefined}
        // The primitive names its content whether drawn or not; only an open group's is.
        {...(isOpen ? {} : { "aria-controls": undefined })}
        data-current={entry.current}
        onPointerMove={still}
        onPointerLeave={still}
        onClick={(event) => {
          event.preventDefault();
          // Opening a group asks for its chain, so every group beside it closes.
          if (isOpen) scope.onOpenChange(holding, "close");
          else scope.onOpenChange([...holding, entry.key]);
        }}
      >
        {text}
        <Chevron data-telo-part="icon" aria-hidden="true" focusable="false" />
      </NavigationMenu.Trigger>
      {isOpen && <Panel entries={entry.items ?? []} chain={[...holding, entry.key]} trigger={button} scope={scope} reason={reason} />}
    </Popper.Root>
  );
}

/** A group's entries, at the end of `<body>`, placed against its button. */
function Panel({ entries, chain, trigger, scope, reason }: { entries: NavigationEntry[]; chain: string[]; trigger: RefObject<HTMLButtonElement | null>; scope: Scope; reason: RefObject<CloseReason> }) {
  const { content, ref } = useMarkedContent();
  const depth = chain.length - 1;
  const holding = chain.slice(0, depth);
  const outermost = depth === 0;
  const rightToLeft = typeof document !== "undefined" && document.documentElement.dir === "rtl";
  const side = outermost && scope.layout === "horizontal" ? "bottom" : rightToLeft ? "left" : "right";
  // A panel closing with the focus in it, or in a panel opened from it, gives the focus to its button.
  useLayoutEffect(
    () => () => {
      const active = document.activeElement;
      const holdingFocus = [...scope.panels].some(([at, element]) => at >= depth && element.contains(active));
      leaveClosing(content.current);
      if (holdingFocus) trigger.current?.focus();
    },
    [],
  );
  /** Whether a press or the focus lands in a panel this one was opened from. */
  const beneath = (target: EventTarget | null) =>
    [...scope.panels].some(([at, element]) => at < depth && element.contains(target as Node | null));
  const register = (element: HTMLDivElement | null) => {
    ref(element);
    if (element) scope.panels.set(depth, element);
    else if (scope.panels.get(depth) === content.current) scope.panels.delete(depth);
  };
  const list = (
    <NavigationMenu.List>
      {entries.map((entry) => (
        <NavigationMenu.Item key={entry.key} value={entry.key}>
          <Entry entry={entry} holding={chain} scope={scope} reason={reason} />
        </NavigationMenu.Item>
      ))}
    </NavigationMenu.List>
  );
  const holdsGroups = entries.some((entry) => entry.items !== undefined);
  return (
    <Portal.Root asChild>
      <Popper.Content asChild side={side} align="start" sideOffset={4} collisionPadding={8}>
        <NavigationMenu.Content
          data-telo-part="nav-panel"
          ref={register}
          onPointerEnter={still}
          onPointerLeave={still}
          onEscapeKeyDown={(event) => {
            if (outermost) {
              reason.current = "escape";
              return;
            }
            // A nested panel closes alone; the primitive would close the outermost.
            event.preventDefault();
            scope.onOpenChange(holding, "escape");
          }}
          onPointerDownOutside={(event) => {
            const target = event.target;
            const own = scope.root.current?.contains(target as Node | null) || inLaterLayer(content.current, target);
            if (outermost) {
              if (own) event.preventDefault();
              else reason.current = "outside";
            } else if (!own && beneath(target)) {
              scope.closeOutside(holding);
            }
          }}
          onFocusOutside={(event) => {
            const target = event.target;
            const own = scope.root.current?.contains(target as Node | null) || inLaterLayer(content.current, target);
            if (outermost) {
              if (own) event.preventDefault();
              else reason.current = "outside";
              return;
            }
            event.preventDefault();
            if (!own && beneath(target) && target !== trigger.current) scope.closeOutside(holding);
          }}
        >
          {holdsGroups ? (
            <NavigationMenu.Sub value={openAmong(entries, scope.open)} orientation="vertical">
              {list}
            </NavigationMenu.Sub>
          ) : (
            list
          )}
        </NavigationMenu.Content>
      </Popper.Content>
    </Portal.Root>
  );
}

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
