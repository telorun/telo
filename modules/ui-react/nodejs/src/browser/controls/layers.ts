import { useEffect, useRef } from "react";

/**
 * The layer mechanics every built-in layer control shares: a dialog, a drawer,
 * a popover, a confirmation, a select's or a menu's list, a tooltip.
 *
 * A layer is drawn at the end of `<body>`, each of its roots carrying
 * {@link LAYER}. Layers stack by the DOM alone: one already in the document
 * when another opens is beneath it, one added while it is open is above it —
 * whichever implementation drew it. Toward a layer above it, a layer moves no
 * focus out of it, reports no outside press or focus inside it, and cancels
 * or stops none of its events: every listener here is on the document in the
 * bubble phase, and returns before acting on an event targeted inside one.
 * Among the layers drawn here, only the top one answers Escape; a press or the
 * focus outside reaches each layer it is outside of from the top down, as far
 * as the first that stops it.
 */
export const LAYER = "data-telo-layer";

export interface LayerOptions {
  /** The elements the layer is drawn as, each carrying {@link LAYER}. */
  roots(): (Element | null)[];
  /** Where a press or the focus is the layer's own: its content, and the
   *  element it opened from. */
  inside(): (Element | null)[];
  /** Makes what was beneath it at opening unreachable, keeps the focus inside
   *  it and the page from scrolling. */
  modal: boolean;
  /** Whether a press or the focus outside it reaches no layer beneath it: a
   *  modal layer's, and an open list's. */
  stopsBeneath: boolean;
  onEscape(): void;
  /** A press, or the focus, outside it; left out, nothing outside closes it. */
  onOutside?(cause: "press" | "focus"): void;
  /** Where the focus goes as it opens, unless it is already inside it. */
  initialFocus?(): HTMLElement | null;
  /** Whether the focus goes back to where it was at opening as it closes. */
  returnsFocus: boolean;
}

interface Layer {
  options: { current: LayerOptions };
  /** The marked elements already in the document when it opened. */
  beneath: Set<Element>;
  opener: HTMLElement | null;
  /** What it made inert, given back as it closes. */
  madeInert: Element[];
  /** Whether it has taken the focus it opens with: until then the focus
   *  moving outside it is no reason to close it. */
  settled: boolean;
}

const stack: Layer[] = [];

const TABBABLE = "button, [href], input, select, textarea, [tabindex]";

/** The elements inside `container` the Tab key reaches, in order. */
export function tabbables(container: Element): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) => element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest("[hidden], [inert]"),
  );
}

const elementOf = (target: EventTarget | null): Element | null => {
  const node = target as (Node & Partial<Element>) | null;
  if (!node) return null;
  return typeof node.closest === "function" ? (node as Element) : node.parentElement;
};

const present = (elements: (Element | null)[]): Element[] => elements.filter((element): element is Element => element !== null);

const isInside = (layer: Layer, target: Element | null) => !!target && present(layer.options.current.inside()).some((element) => element.contains(target));

/** Whether the target is inside a layer opened after this one, by anyone. */
function inLaterLayer(layer: Layer, target: Element | null): boolean {
  const marked = target?.closest(`[${LAYER}]`);
  return !!marked && !layer.beneath.has(marked) && !present(layer.options.current.roots()).includes(marked);
}

function onKeyDown(event: KeyboardEvent) {
  const top = stack.at(-1);
  if (!top) return;
  const target = elementOf(event.target);
  if (inLaterLayer(top, target)) return;
  if (event.key === "Escape") top.options.current.onEscape();
  else if (event.key === "Tab" && top.options.current.modal && !event.defaultPrevented) keepTabInside(top, event);
}

/** Tab past either end of a modal layer comes round to its other end. */
function keepTabInside(layer: Layer, event: KeyboardEvent) {
  const container = present(layer.options.current.inside())[0];
  if (!container) return;
  const order = tabbables(container);
  const active = document.activeElement;
  if (order.length === 0) {
    event.preventDefault();
    (container as HTMLElement).focus();
  } else if (!container.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? order[order.length - 1] : order[0]).focus();
  } else if (!event.shiftKey && active === order[order.length - 1]) {
    event.preventDefault();
    order[0].focus();
  } else if (event.shiftKey && active === order[0]) {
    event.preventDefault();
    order[order.length - 1].focus();
  }
}

/** Each layer from the top down that a press or the focus is outside of, as
 *  far as the first that stops it. */
function outsideOf(target: Element | null, cause: "press" | "focus"): Layer[] {
  const reached: Layer[] = [];
  for (const layer of [...stack].reverse()) {
    if (isInside(layer, target) || inLaterLayer(layer, target) || (cause === "focus" && !layer.settled)) break;
    reached.push(layer);
    if (layer.options.current.stopsBeneath) break;
  }
  return reached;
}

function onPointerDown(event: Event) {
  for (const layer of outsideOf(elementOf(event.target), "press")) layer.options.current.onOutside?.("press");
}

function onFocusIn(event: FocusEvent) {
  for (const layer of outsideOf(elementOf(event.target), "focus")) {
    if (!layer.options.current.modal) {
      layer.options.current.onOutside?.("focus");
      continue;
    }
    // A modal layer keeps the focus inside it.
    const container = present(layer.options.current.inside())[0] as HTMLElement | undefined;
    if (container) (tabbables(container)[0] ?? container).focus();
  }
}

let scrollLocks = 0;
let heldOverflow = "";

function lockScroll() {
  if (scrollLocks++ > 0) return;
  heldOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = "hidden";
}

function unlockScroll() {
  if (--scrollLocks > 0) return;
  document.documentElement.style.overflow = heldOverflow;
}

function listen(on: boolean) {
  if (on) {
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
  } else {
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("focusin", onFocusIn);
  }
}

function openLayer(options: { current: LayerOptions }): Layer {
  const own = present(options.current.roots());
  const active = document.activeElement;
  const layer: Layer = {
    options,
    beneath: new Set([...document.querySelectorAll(`[${LAYER}]`)].filter((element) => !own.includes(element))),
    opener: active && active !== document.body && typeof (active as HTMLElement).focus === "function" ? (active as HTMLElement) : null,
    madeInert: [],
    settled: false,
  };
  if (options.current.modal) {
    for (const child of document.body.children) {
      if (own.includes(child) || child.hasAttribute("inert")) continue;
      child.setAttribute("inert", "");
      layer.madeInert.push(child);
    }
    lockScroll();
  }
  if (stack.length === 0) listen(true);
  stack.push(layer);
  return layer;
}

function closeLayer(layer: Layer) {
  const at = stack.indexOf(layer);
  if (at !== -1) stack.splice(at, 1);
  if (stack.length === 0) listen(false);
  for (const element of layer.madeInert) element.removeAttribute("inert");
  if (layer.options.current.modal) unlockScroll();
  if (!layer.options.current.returnsFocus) return;
  // The focus goes back unless it has gone somewhere of its own.
  const active = document.activeElement;
  const lost = active === null || active === document.body || present(layer.options.current.roots()).some((root) => root.contains(active));
  if (lost && layer.opener?.isConnected) layer.opener.focus();
}

/**
 * Hold a layer open while `open` is: once it is drawn it joins the stack, and
 * takes the focus a turn later — after whatever opened with it has moved the
 * focus, unless that put it inside this layer or a later one — and it leaves
 * the stack, giving back what it made inert and the focus, as it closes.
 */
export function useLayer(open: boolean, options: LayerOptions): void {
  const held = useRef(options);
  held.current = options;
  useEffect(() => {
    if (!open) return;
    const layer = openLayer(held);
    const settling = window.setTimeout(() => {
      const active = document.activeElement;
      const placed = present(held.current.roots()).some((root) => root.contains(active)) || inLaterLayer(layer, active);
      if (!placed) held.current.initialFocus?.()?.focus();
      layer.settled = true;
    }, 0);
    return () => {
      window.clearTimeout(settling);
      closeLayer(layer);
    };
  }, [open]);
}

/**
 * Leave a closed copy of a layer where it stood, for as long as its closing
 * animation runs: the renderer removes a layer when it closes, so there is
 * nothing left of it to animate. The copy takes no input, carries no layer
 * marker, and none is made where the theme gives a closed layer no animation.
 */
export function leaveClosing(element: HTMLElement | null): void {
  if (!element?.isConnected) return;
  const closing = element.cloneNode(true) as HTMLElement;
  const closed = closing.matches("[data-telo-part]") ? closing : (closing.querySelector<HTMLElement>("[data-telo-part]") ?? closing);
  closed.setAttribute("data-state", "closed");
  closing.setAttribute("inert", "");
  closing.setAttribute("aria-hidden", "true");
  closing.style.pointerEvents = "none";
  for (const marked of [closing, ...closing.querySelectorAll(`[${LAYER}]`)]) marked.removeAttribute(LAYER);
  for (const named of [closing, ...closing.querySelectorAll("[id]")]) named.removeAttribute("id");
  document.body.append(closing);
  const name = getComputedStyle(closed).animationName;
  if (!name || name === "none") return closing.remove();
  const remove = () => closing.remove();
  closed.addEventListener("animationend", remove, { once: true });
  closed.addEventListener("animationcancel", remove, { once: true });
  window.setTimeout(remove, 1000);
}
