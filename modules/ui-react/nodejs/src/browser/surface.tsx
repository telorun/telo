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
import type { CloseReason } from "../contract/ui-react-controls.js";
import { useControl, useControls } from "./effective-controls.js";
import { ErrorNode } from "./nodes.js";
import type { ErrorSpec } from "./ui-error.js";
import { useSay } from "./texts.js";

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

/** The state a surface's root carries, as the styling contract documents it. */
const attributes = (spec: SurfaceSpec): Record<string, string> => {
  const held: Record<string, string | undefined> = {
    "data-surface": spec.type,
    "data-side": spec.side,
    "data-size": spec.size,
    "data-align": spec.align,
    "data-modal": spec.modal === undefined ? undefined : String(spec.modal),
  };
  return Object.fromEntries(Object.entries(held).filter((entry): entry is [string, string] => entry[1] !== undefined));
};

function CloseButton({ onClose }: { onClose: () => void }) {
  const say = useSay();
  const Icon = useControl("Icon");
  return (
    <button data-telo-part="surface-close" type="button" aria-label={say("close")} onClick={onClose}>
      <Icon name="close" />
    </button>
  );
}

/** The events being dispatched now, outermost first, as far as a window has
 *  said: the innermost is what an overlay's report that it would close was
 *  caused by. A handler moving the focus dispatches a focus event inside the
 *  event it handles, which is the outer one again once that has finished. */
const dispatching: Event[] = [];
const watched = new WeakSet<Window>();

const finished = (event: Event) => {
  const at = dispatching.lastIndexOf(event);
  if (at !== -1) dispatching.splice(at, 1);
};

function current(): Event | undefined {
  // An event whose propagation was stopped never reaches the window's bubble listener.
  while (dispatching.length > 0 && dispatching[dispatching.length - 1].eventPhase === Event.NONE) dispatching.pop();
  return dispatching[dispatching.length - 1];
}

function watchDispatch(view: Window): void {
  if (watched.has(view)) return;
  watched.add(view);
  for (const type of ["pointerdown", "click", "focusin", "keydown"]) {
    view.addEventListener(
      type,
      (event) => {
        dispatching.push(event);
        view.setTimeout(() => finished(event), 0);
      },
      true,
    );
    view.addEventListener(type, finished);
  }
}

/**
 * The presses and the focus that begin in what a surface holds, wherever that
 * is drawn: a list its form opens is drawn elsewhere, and is still inside it.
 * A press is marked at its click too, since a touch press is judged then.
 */
export function useHeldInside(): { mark: (event: SyntheticEvent) => void; inside: () => boolean } {
  const [within] = useState(() => new WeakSet<Event>());
  useEffect(() => watchDispatch(window), []);
  return {
    mark: (event) => {
      within.add(event.nativeEvent);
    },
    inside: () => {
      const event = current();
      return event !== undefined && within.has(event);
    },
  };
}

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
  const held = useHeldInside();
  const control = useControls();

  // An overlay says why it would close; whether it does is this surface's policy.
  const closing = (open: boolean, reason?: CloseReason) => {
    if (open) return;
    if (reason === "escape" && !dismiss.escape) return;
    if (reason === "outside" && (!dismiss.outside || held.inside())) return;
    onClose();
  };

  const kept = createPortal(
    <div style={{ display: "contents" }} onPointerDownCapture={held.mark} onFocusCapture={held.mark} onClickCapture={held.mark}>
      {children}
    </div>,
    content,
  );
  const bodyPart = <div data-telo-part="surface-body" ref={take} />;
  const header = (
    <div data-telo-part="surface-header">
      <h2 data-telo-part="surface-title" id={id}>
        {title}
      </h2>
    </div>
  );
  let drawn: ReactNode;
  if (spec.type === "dialog" || spec.type === "drawer") {
    const inside = (
      <>
        {header}
        {bodyPart}
        {dismiss.closeButton && <CloseButton onClose={onClose} />}
      </>
    );
    const shared = { open: true, modal: spec.modal !== false, labelledBy: id, attributes: attributes(spec), onOpenChange: closing };
    if (spec.type === "dialog") {
      const Dialog = control("Dialog");
      drawn = <Dialog {...shared}>{inside}</Dialog>;
    } else {
      const Drawer = control("Drawer");
      drawn = (
        <Drawer {...shared} side={spec.side ?? "end"}>
          {inside}
        </Drawer>
      );
    }
  } else if (spec.type === "popover") {
    const Popover = control("Popover");
    drawn = (
      <Popover open anchor={anchor.current} side={spec.side ?? "bottom"} align={spec.align} labelledBy={id} attributes={attributes(spec)} onOpenChange={closing}>
        {header}
        {bodyPart}
      </Popover>
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
      {kept}
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
    <section {...attributes(spec)} data-telo-part="surface" ref={element} tabIndex={-1} aria-labelledby={id}>
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
    <section {...attributes(spec)} data-telo-part="surface" aria-labelledby={id}>
      <Placed title={title} id={id}>
        {children}
      </Placed>
    </section>,
    slot.element,
  );
}

interface ConfirmationProps {
  title: string;
  description?: string;
  /** What the confirming button says. */
  confirm: string;
  /** Whether confirming destroys something: its button is styled `danger`. */
  danger?: boolean;
  /** What the button that backs out says. */
  cancel?: string;
  busy?: boolean;
  /** Why the last confirmation was refused. */
  failure?: ErrorSpec;
  /** What is entered before confirming, drawn under the question. */
  children?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}

/** A question that interrupts: only Escape or one of its two buttons answers
 *  it, and confirming leaves it open for whoever asked to close. */
export function Confirmation({ title, description, confirm, danger = true, cancel, busy = false, failure, children, onConfirm, onClose }: ConfirmationProps) {
  const say = useSay();
  const Question = useControl("Confirmation");
  const id = useId();
  const titleId = `${id}-title`;
  // A question with nothing under it is its own description.
  const describedBy = description === undefined ? `${id}-header` : `${id}-description`;
  return (
    <Question open labelledBy={titleId} describedBy={describedBy} attributes={{ "data-surface": "confirmation" }} onOpenChange={(open) => open || onClose()}>
      <div data-telo-part="surface-header" id={`${id}-header`}>
        <h2 data-telo-part="surface-title" id={titleId}>
          {title}
        </h2>
        {description !== undefined && (
          <p data-telo-part="surface-description" id={`${id}-description`}>
            {description}
          </p>
        )}
      </div>
      {children}
      {failure && <ErrorNode error={failure} />}
      <div data-telo-part="form-actions">
        <button data-telo-part="cancel" type="button" onClick={onClose}>
          {cancel ?? say("cancel")}
        </button>
        <button data-telo-part="submit" data-style={danger ? "danger" : undefined} type="button" disabled={busy} onClick={onConfirm}>
          {confirm}
        </button>
      </div>
    </Question>
  );
}
