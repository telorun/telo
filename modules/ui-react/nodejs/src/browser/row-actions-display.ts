import { useCallback, useLayoutEffect, useRef, useState, type RefCallback } from "react";

/** What a listing or a `list` node says: `auto` is judged here, the others are as written. */
export type ActionsSetting = "auto" | "inline" | "menu";

/** How a record's actions are drawn: each a button, or one button opening a menu. */
export type ActionsDisplay = "inline" | "menu";

/** The part of a record's width the actions may take when they share a line with its content; the content keeps the rest. */
export const ACTIONS_SHARE = 0.5;

/** What was measured when a display is judged. */
export interface ActionsMeasure {
  /** The container's inline size. */
  width: number;
  /** By how much the inline set outgrows the room its widest-pressed record gives it, or the layout overflows its container; 0 when it fits or they are not inline. */
  shortage: number;
}

/**
 * The display of a listing's actions, judged once for all its records. Inline
 * while every record's actions fit the room their layout gives them; once one
 * does not, a menu, until the container is wider than it was by the shortage.
 * Only a wider container lifts that bound, so a menu never flips back to
 * inline at the width that made it a menu, and a container that narrows and
 * widens again switches once each way.
 *
 * `needs` is the container width inline is known to need, as the last
 * judgement left it; the new one is returned with the display.
 */
export function judgeRowActions(held: ActionsDisplay, measure: ActionsMeasure, needs: number): { display: ActionsDisplay; needs: number } {
  const short = held === "inline" && measure.shortage > 0 ? measure.width + measure.shortage : 0;
  const required = Math.max(needs, short);
  return { display: measure.width >= required ? "inline" : "menu", needs: required };
}

/** The natural width of an actions area: its children side by side with their margins, whatever room the layout gave it. */
export function inlineWidth(area: HTMLElement): number {
  const children = [...area.children];
  if (children.length === 0) return 0;
  const gap = Number.parseFloat(getComputedStyle(area).columnGap) || 0;
  const margins = (child: Element) => {
    const style = getComputedStyle(child);
    return (Number.parseFloat(style.marginLeft) || 0) + (Number.parseFloat(style.marginRight) || 0);
  };
  return children.reduce((sum, child) => sum + child.getBoundingClientRect().width + margins(child), 0) + gap * (children.length - 1);
}

const px = (value: string) => Number.parseFloat(value) || 0;

/** Whether something else of the record is drawn on the line the actions are. */
function sharesLine(area: HTMLElement): boolean {
  const mine = area.getBoundingClientRect();
  return [...(area.parentElement?.children ?? [])].some((sibling) => {
    if (sibling === area) return false;
    const other = sibling.getBoundingClientRect();
    return other.top < mine.bottom && mine.top < other.bottom;
  });
}

/**
 * The inline room the record gives its actions: the record's content box, or
 * a share of it when the content sits on the same line. A table cell is given
 * what the grid does, which the frame's overflow judges; a record not laid out
 * yet gives all.
 */
export function roomFor(area: HTMLElement): number {
  const record = area.parentElement;
  if (!record || record.clientWidth === 0 || area.tagName === "TD") return Number.POSITIVE_INFINITY;
  const style = getComputedStyle(record);
  const inner = record.clientWidth - px(style.paddingLeft) - px(style.paddingRight);
  return sharesLine(area) ? inner * ACTIONS_SHARE : inner;
}

/** By how much a container, or a table frame in it, is scrolled wider than it is. */
function overflowOf(container: HTMLElement): number {
  const scrolling = [container, ...container.querySelectorAll<HTMLElement>('[data-telo-part="table-frame"]')];
  return Math.max(...scrolling.map((element) => element.scrollWidth - element.clientWidth), 0);
}

export interface RowActionsArea {
  display: ActionsDisplay;
  /** Given the container the records are drawn in (its width is the room), measured and watched. */
  container: RefCallback<HTMLElement>;
  /** Given each element holding one record's actions, measured for their natural width. */
  area: RefCallback<HTMLElement>;
}

/**
 * Judges how a listing's record actions are drawn. `signature` names what is
 * drawn — the records and the actions each offers — and a change of it is
 * judged afresh, from inline, before the page is painted.
 */
export function useRowActionsDisplay(setting: ActionsSetting, signature: string): RowActionsArea {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [display, setDisplay] = useState<ActionsDisplay>("inline");
  const [observed, setObserved] = useState(0);
  const [areaCount, setAreaCount] = useState(0);
  const areas = useRef(new Set<HTMLElement>());
  const memory = useRef({ signature, needs: 0 });

  const area = useCallback((element: HTMLElement | null) => {
    if (element) areas.current.add(element);
    setAreaCount((count) => count + 1);
  }, []);

  useLayoutEffect(() => {
    if (!container || setting !== "auto" || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => setObserved((count) => count + 1));
    watch.observe(container);
    return () => watch.disconnect();
  }, [container, setting]);

  useLayoutEffect(() => {
    if (setting !== "auto") return;
    if (memory.current.signature !== signature) {
      memory.current = { signature, needs: 0 };
      if (display === "menu") return setDisplay("inline");
    }
    const width = container?.clientWidth ?? 0;
    for (const held of areas.current) if (!held.isConnected) areas.current.delete(held);
    const outgrown = [...areas.current].map((held) => (display === "inline" ? inlineWidth(held) - roomFor(held) : 0));
    const shortage = Math.max(0, display === "inline" && container ? overflowOf(container) : 0, ...outgrown);
    const judged = judgeRowActions(display, { width, shortage }, memory.current.needs);
    memory.current.needs = judged.needs;
    if (judged.display !== display) setDisplay(judged.display);
  }, [setting, display, signature, container, observed, areaCount]);

  return { display: setting === "auto" ? display : setting, container: setContainer, area };
}
