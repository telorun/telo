import { useCallback, useRef } from "react";

/**
 * What the root of every layer drawn at the end of `<body>` carries. The
 * primitives draw a dialog's surface and its overlay there as they are; a
 * list, a menu, a popover, a navigation panel and a tooltip they draw inside
 * an element placing them, which is the root that carries it.
 */
export const LAYER = "data-telo-layer";

export const marked = { [LAYER]: "" };

const PLACED_BY = "data-radix-popper-content-wrapper";

/** The element at the end of `<body>` a layer's content is drawn in. */
const rootOf = (content: HTMLElement | null) => {
  const placing = content?.parentElement;
  return placing?.hasAttribute(PLACED_BY) ? placing : content;
};

/**
 * The content of a layer the primitive places, and the ref that marks the
 * element placing it as the layer's root as soon as it is drawn: the
 * primitive draws its portal a render after it opens, so only the element's
 * own ref sees it arrive.
 */
export function useMarkedContent() {
  const content = useRef<HTMLDivElement | null>(null);
  const ref = useCallback((element: HTMLDivElement | null) => {
    content.current = element;
    rootOf(element)?.setAttribute(LAYER, "");
  }, []);
  return { content, ref };
}

/**
 * Whether an event a layer would take for one outside it happened inside a
 * layer drawn after it — a list, a menu or a surface opened over it, by these
 * controls or by anything else marking its layer. That is no press or focus
 * outside it: the layer above is the one it reaches.
 */
export function inLaterLayer(content: HTMLElement | null, target: EventTarget | null): boolean {
  const own = rootOf(content);
  const layer = (target as Partial<Element> | null)?.closest?.(`[${LAYER}]`);
  return !!own && !!layer && layer !== own && (own.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/**
 * Leave a closed copy of a layer where it stood, for as long as its closing
 * animation runs: the renderer removes a layer when it closes, so there is
 * nothing left of it to animate. The copy takes no input, carries no layer
 * marker, and none is made where the theme gives a closed layer no animation.
 */
export function leaveClosing(content: HTMLElement | null): void {
  const element = rootOf(content);
  if (!element?.isConnected) return;
  const closing = element.cloneNode(true) as HTMLElement;
  const closed = closing.matches("[data-telo-part]") ? closing : (closing.querySelector<HTMLElement>("[data-telo-part]") ?? closing);
  closed.setAttribute("data-state", "closed");
  closing.setAttribute("inert", "");
  closing.setAttribute("aria-hidden", "true");
  closing.style.pointerEvents = "none";
  for (const layer of [closing, ...closing.querySelectorAll(`[${LAYER}]`)]) layer.removeAttribute(LAYER);
  for (const named of [closing, ...closing.querySelectorAll("[id]")]) named.removeAttribute("id");
  document.body.append(closing);
  const name = getComputedStyle(closed).animationName;
  if (!name || name === "none") return closing.remove();
  const remove = () => closing.remove();
  closed.addEventListener("animationend", remove, { once: true });
  closed.addEventListener("animationcancel", remove, { once: true });
  window.setTimeout(remove, 1000);
}

const TABBABLE = "button, [href], input, select, textarea, [tabindex]";

/** The first element inside `container` the Tab key reaches. */
export function firstTabbable(container: Element): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>(TABBABLE)].find(
    (element) => element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest("[hidden], [inert]"),
  );
}
