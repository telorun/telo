import { X } from "lucide-react";
import { AlertDialog, Dialog, Popover } from "radix-ui";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icon.js";
import { ErrorNode } from "./nodes.js";
import type { ErrorSpec } from "./ui-error.js";

/** Where a form appears and how it is dismissed, as the page document says it. */
export interface SurfaceSpec {
  type: "dialog" | "drawer" | "popover" | "inline" | "panel" | "page";
  side?: "start" | "end" | "top" | "bottom";
  size?: string;
  align?: "start" | "center" | "end";
  modal?: boolean;
  dismiss?: { escape?: boolean; outside?: boolean; closeButton?: boolean };
  address?: { name: string };
  /** The surface used instead on a narrow viewport. */
  compact?: SurfaceSpec;
}

/** Where a surface that replaces the page's content is drawn, and how it says
 *  that it does. */
export interface PageSlot {
  element: HTMLElement | null;
  /** Take the page's place until the returned function is called. */
  claim(): () => void;
}

export const PageSlotContext = createContext<PageSlot>({ element: null, claim: () => () => {} });

interface SurfaceProps {
  spec: SurfaceSpec;
  title: string;
  /** What a popover is anchored to: the control that opened it. */
  anchor: RefObject<HTMLElement | null>;
  /** Where a surface in the page's flow is drawn, when that is not where this
   *  is rendered; `null` until that place exists. */
  container?: HTMLElement | null;
  /** Asked for by every way of dismissing; whoever opened it decides. */
  onClose: () => void;
  children: ReactNode;
}

const attributes = (spec: SurfaceSpec) => ({
  "data-telo-part": "surface",
  "data-surface": spec.type,
  "data-side": spec.side,
  "data-size": spec.size,
  "data-align": spec.align,
  "data-modal": spec.modal === undefined ? undefined : String(spec.modal),
});

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button data-telo-part="surface-close" type="button" aria-label="Close" onClick={onClose}>
      <Icon of={X} />
    </button>
  );
}

/** A side as the primitive places it, which follows the text direction. */
function placedSide(side: SurfaceSpec["side"]): "top" | "bottom" | "left" | "right" {
  if (side === "top" || side === "bottom") return side;
  const rightToLeft = document.documentElement.dir === "rtl";
  return (side === "start") !== rightToLeft ? "left" : "right";
}

/**
 * Leave a closed copy of a surface that is going where it stood, for as long as
 * its closing animation runs: whoever opened a surface removes it when it
 * closes, so there is nothing left of it to animate. The copy takes no input,
 * and none is made where the theme gives a closed surface no animation.
 */
function leaveClosing(element: HTMLElement | null): void {
  if (!element?.isConnected) return;
  const closing = element.cloneNode(true) as HTMLElement;
  const closed = closing.matches("[data-telo-part]") ? closing : (closing.querySelector<HTMLElement>("[data-telo-part]") ?? closing);
  closed.setAttribute("data-state", "closed");
  closing.setAttribute("inert", "");
  closing.setAttribute("aria-hidden", "true");
  closing.style.pointerEvents = "none";
  for (const named of [closing, ...closing.querySelectorAll("[id]")]) named.removeAttribute("id");
  document.body.append(closing);
  const name = getComputedStyle(closed).animationName;
  if (!name || name === "none") return closing.remove();
  const remove = () => closing.remove();
  closed.addEventListener("animationend", remove, { once: true });
  closed.addEventListener("animationcancel", remove, { once: true });
  window.setTimeout(remove, 1000);
}

/** What a primitive says of a press or a focus it takes to be outside it. */
type OutsideEvent = CustomEvent<{ originalEvent: Event }>;

/**
 * A form's surface: a dialog, a drawer or a popover over the page, or a place
 * in it — in line, in a panel beside the list, or instead of the page's
 * content. Its header and the form's actions stay while its body scrolls.
 *
 * What it holds is mounted once, in an element of its own that whichever
 * surface is drawn takes into its body: it outlives a change of surface, with
 * everything entered in it.
 */
export function Surface({ spec, title, anchor, container, onClose, children }: SurfaceProps) {
  const id = useId();
  const dismiss = spec.dismiss ?? {};
  const [content] = useState(() => {
    const element = document.createElement("div");
    element.style.display = "contents";
    return element;
  });
  const focused = useRef<HTMLElement | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const floating = useRef<HTMLDivElement>(null);
  // When the surface itself goes — not when another is drawn in its place.
  useLayoutEffect(
    () => () => {
      leaveClosing(overlay.current);
      // A popover is placed by the element around it.
      const placed = floating.current?.parentElement;
      leaveClosing(placed?.hasAttribute("data-radix-popper-content-wrapper") ? placed : floating.current);
    },
    [],
  );
  const take = useCallback(
    (element: HTMLElement | null) => {
      if (!element) {
        // The surface drawn is going: the control that has the focus gets it back in the next.
        focused.current = content.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
        return;
      }
      element.append(content);
      focused.current?.focus();
      focused.current = null;
    },
    [content],
  );

  // A primitive tells inside from outside by what its own tree handles. What is
  // held here is in that tree only as far as it is drawn in the surface: a list
  // it opens elsewhere is not, so a press or a focus that began in it is marked.
  // Every one is: a touch press is judged at its click, after the focus it moved.
  const [within] = useState(() => new WeakSet<Event>());
  const mark = (event: SyntheticEvent) => {
    within.add(event.nativeEvent);
  };
  const outside = (event: OutsideEvent) => {
    if (!dismiss.outside || within.has(event.detail.originalEvent)) event.preventDefault();
  };

  const held = createPortal(
    <div style={{ display: "contents" }} onPointerDownCapture={mark} onFocusCapture={mark}>
      {children}
    </div>,
    content,
  );
  const bodyPart = <div data-telo-part="surface-body" ref={take} />;
  let drawn: ReactNode;
  if (spec.type === "dialog" || spec.type === "drawer") {
    drawn = (
      <Dialog.Root open modal={spec.modal !== false} onOpenChange={(open) => !open && onClose()}>
        <Dialog.Portal>
          <Dialog.Overlay data-telo-part="surface-overlay" ref={overlay} />
          <Dialog.Content
            {...attributes(spec)}
            ref={floating}
            aria-describedby={undefined}
            onEscapeKeyDown={(event) => !dismiss.escape && event.preventDefault()}
            onInteractOutside={outside}
          >
            <div data-telo-part="surface-header">
              <Dialog.Title data-telo-part="surface-title">{title}</Dialog.Title>
            </div>
            {bodyPart}
            {dismiss.closeButton && <CloseButton onClose={onClose} />}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  } else if (spec.type === "popover") {
    drawn = (
      <Popover.Root open onOpenChange={(open) => !open && onClose()}>
        <Popover.Anchor virtualRef={anchor as RefObject<HTMLElement>} />
        <Popover.Portal>
          <Popover.Content
            {...attributes(spec)}
            ref={floating}
            side={placedSide(spec.side)}
            align={spec.align}
            sideOffset={6}
            collisionPadding={8}
            aria-labelledby={id}
            onEscapeKeyDown={(event) => !dismiss.escape && event.preventDefault()}
            onInteractOutside={outside}
          >
            <Placed title={title} id={id}>
              {bodyPart}
            </Placed>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    );
  } else if (spec.type === "page") {
    drawn = (
      <PageSurface spec={spec} title={title}>
        {bodyPart}
      </PageSurface>
    );
  } else {
    const placed = (
      <InPage spec={spec} title={title} onClose={onClose}>
        {bodyPart}
      </InPage>
    );
    drawn = container === undefined ? placed : container && createPortal(placed, container);
  }
  return (
    <>
      {drawn}
      {held}
    </>
  );
}

/** The header of a surface no primitive names. */
function Placed({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <>
      <div data-telo-part="surface-header">
        <h2 data-telo-part="surface-title" id={id}>
          {title}
        </h2>
      </div>
      {children}
    </>
  );
}

/** A surface in the page's own flow: in line, or a panel beside the list. */
function InPage({ spec, title, onClose, children }: { spec: SurfaceSpec; title: string; onClose: () => void; children: ReactNode }) {
  const id = useId();
  const element = useRef<HTMLElement>(null);
  const escapes = spec.dismiss?.escape === true;
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!element.current?.contains(document.activeElement)) element.current?.focus();
  }, []);
  // Escape typed inside it, wherever in it that is drawn from; a choice list
  // open over it is drawn elsewhere and takes its own.
  useEffect(() => {
    const section = element.current;
    if (!section || !escapes) return;
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) close.current();
    };
    section.addEventListener("keydown", escape);
    return () => section.removeEventListener("keydown", escape);
  }, [escapes]);
  return (
    <section {...attributes(spec)} ref={element} tabIndex={-1} aria-labelledby={id}>
      <Placed title={title} id={id}>
        {children}
      </Placed>
      {spec.dismiss?.closeButton && <CloseButton onClose={onClose} />}
    </section>
  );
}

/** A surface in place of the page's content, which returns when it closes. */
function PageSurface({ spec, title, children }: { spec: SurfaceSpec; title: string; children: ReactNode }) {
  const id = useId();
  const slot = useContext(PageSlotContext);
  useLayoutEffect(() => slot.claim(), [slot.claim]);
  if (!slot.element) return null;
  return createPortal(
    <section {...attributes(spec)} aria-labelledby={id}>
      <Placed title={title} id={id}>
        {children}
      </Placed>
    </section>,
    slot.element,
  );
}

interface ConfirmationProps {
  title: string;
  description: string;
  /** What the confirming button says. */
  confirm: string;
  /** What the button that backs out says. */
  cancel?: string;
  busy?: boolean;
  /** Why the last confirmation was refused. */
  failure?: ErrorSpec;
  onConfirm: () => void;
  onClose: () => void;
}

/** A question that interrupts: only Escape or one of its two buttons answers
 *  it, and confirming leaves it open for whoever asked to close. */
export function Confirmation({ title, description, confirm, cancel = "Cancel", busy = false, failure, onConfirm, onClose }: ConfirmationProps) {
  return (
    <AlertDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay data-telo-part="surface-overlay" />
        <AlertDialog.Content data-telo-part="surface" data-surface="confirmation">
          <div data-telo-part="surface-header">
            <AlertDialog.Title data-telo-part="surface-title">{title}</AlertDialog.Title>
            <AlertDialog.Description data-telo-part="surface-description">{description}</AlertDialog.Description>
          </div>
          {failure && <ErrorNode error={failure} />}
          <div data-telo-part="form-actions">
            <AlertDialog.Cancel data-telo-part="cancel">{cancel}</AlertDialog.Cancel>
            <button data-telo-part="submit" data-style="danger" type="button" disabled={busy} onClick={onConfirm}>
              {confirm}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
