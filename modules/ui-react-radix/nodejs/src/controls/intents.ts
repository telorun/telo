import { cloneElement, useLayoutEffect, useRef, type ReactElement, type RefObject } from "react";
import type { CloseReason } from "../../../../ui-react/nodejs/src/contract/ui-react-controls.js";
import { inLaterLayer } from "./layers.js";

/** The renderer's own element, given to be a trigger: it keeps no state of the
 *  primitive's, which is the control's to carry on its own parts. */
export const stateless = (anchor: ReactElement) => cloneElement(anchor, { "data-state": undefined } as Record<string, unknown>);

/** Whether a scrolled list shows its end. */
export const atEnd = (element: HTMLElement) => element.scrollTop + element.clientHeight >= element.scrollHeight - 8;

/**
 * The reason the next close is reported with, set by whatever is about to
 * close the layer `content` is drawn in. A press or the focus inside a layer
 * drawn after it closes nothing.
 */
export function useCloseReason(onOpenChange: (open: boolean, reason?: CloseReason) => void, content: RefObject<HTMLElement | null>) {
  const reason = useRef<CloseReason>("close");
  return {
    escape: () => {
      reason.current = "escape";
    },
    outside: (event: Event) => {
      if (inLaterLayer(content.current, event.target)) event.preventDefault();
      else if (!event.defaultPrevented) reason.current = "outside";
    },
    change: (open: boolean) => {
      const why = reason.current;
      reason.current = "close";
      if (open) onOpenChange(true);
      else onOpenChange(false, why);
    },
  };
}

/**
 * Where the focus was when an overlay opened, and the handler that gives it
 * back there when the overlay closes — unless the focus has already gone
 * somewhere of its own, as when a surface is replaced by another holding it.
 */
export function useReturnedFocus(open: boolean): (event: Event) => void {
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, [open]);
  return (event) => {
    event.preventDefault();
    const active = document.activeElement;
    if ((active === null || active === document.body) && opener.current?.isConnected) opener.current.focus();
  };
}
