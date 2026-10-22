import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ConfirmationProps, DialogProps, DrawerProps, PopoverProps } from "../../contract/ui-react-controls.js";
import { LAYER, leaveClosing, tabbables, useLayer } from "./layers.js";
import { usePlacement } from "./placement.js";
import { refs } from "./shared.js";

const marked = { [LAYER]: "" };

/** Where the focus goes as an overlay opens: the first thing in it the Tab key reaches, else the overlay. */
const firstInside = (surface: HTMLElement | null) => surface && (tabbables(surface)[0] ?? surface);

interface SurfaceLayerProps {
  role: "dialog" | "alertdialog";
  modal: boolean;
  attributes: Record<string, string>;
  labelledBy: string;
  describedBy?: string;
  onEscape(): void;
  /** Left out, nothing outside it closes it. */
  onOutside?(): void;
  /** Whether a closed copy is left for the theme's closing animation. */
  animatesClosing: boolean;
  children: ReactNode;
}

/** A surface over the page, in its middle or against an edge, and a modal one's
 *  overlay beneath it. */
function SurfaceLayer({ role, modal, attributes, labelledBy, describedBy, onEscape, onOutside, animatesClosing, children }: SurfaceLayerProps) {
  const overlay = useRef<HTMLDivElement | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  useLayer(true, {
    roots: () => [overlay.current, surface.current],
    inside: () => [surface.current],
    modal,
    stopsBeneath: modal,
    onEscape,
    onOutside,
    initialFocus: () => firstInside(surface.current),
    returnsFocus: true,
  });
  useLayoutEffect(
    () => () => {
      if (!animatesClosing) return;
      leaveClosing(overlay.current);
      leaveClosing(surface.current);
    },
    [],
  );
  return createPortal(
    <>
      {modal && <div data-telo-part="surface-overlay" {...marked} data-state="open" ref={overlay} />}
      <div
        {...attributes}
        data-telo-part="surface"
        {...marked}
        data-state="open"
        role={role}
        aria-modal={modal || undefined}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        ref={surface}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

/** A dialog or a drawer: the two differ only in where their mechanics place them. */
function Modal({ open, modal, labelledBy, describedBy, attributes, onOpenChange, children }: DialogProps) {
  if (!open) return null;
  return (
    <SurfaceLayer
      role="dialog"
      modal={modal}
      attributes={attributes}
      labelledBy={labelledBy}
      describedBy={describedBy}
      onEscape={() => onOpenChange(false, "escape")}
      onOutside={() => onOpenChange(false, "outside")}
      animatesClosing
    >
      {children}
    </SurfaceLayer>
  );
}

export function Dialog(props: DialogProps) {
  return <Modal {...props} />;
}

export function Drawer({ side, ...props }: DrawerProps) {
  return <Modal {...props} />;
}

/** A question only Escape or one of the renderer's buttons answers; the focus
 *  starts on the first thing in it that takes the focus. */
export function Confirmation({ open, labelledBy, describedBy, attributes, onOpenChange, children }: ConfirmationProps) {
  if (!open) return null;
  return (
    <SurfaceLayer
      role="alertdialog"
      modal
      attributes={attributes}
      labelledBy={labelledBy}
      describedBy={describedBy}
      onEscape={() => onOpenChange(false, "escape")}
      animatesClosing={false}
    >
      {children}
    </SurfaceLayer>
  );
}

export function Popover({ open, ...props }: PopoverProps) {
  return open ? <PopoverLayer {...props} /> : null;
}

/** A surface placed against what opened it, leaving the page uncovered. */
function PopoverLayer({ anchor, side, align, labelledBy, attributes, onOpenChange, children }: Omit<PopoverProps, "open">) {
  const surface = useRef<HTMLDivElement | null>(null);
  const { setFloating, style } = usePlacement(anchor, side, align ?? "center", 6);
  useLayer(true, {
    roots: () => [surface.current],
    inside: () => [surface.current],
    modal: false,
    stopsBeneath: false,
    onEscape: () => onOpenChange(false, "escape"),
    onOutside: () => onOpenChange(false, "outside"),
    initialFocus: () => firstInside(surface.current),
    returnsFocus: true,
  });
  useLayoutEffect(() => () => leaveClosing(surface.current), []);
  return createPortal(
    <div
      {...attributes}
      data-telo-part="surface"
      {...marked}
      data-state="open"
      role="dialog"
      aria-labelledby={labelledBy}
      tabIndex={-1}
      ref={refs(surface, setFloating)}
      style={style}
    >
      {children}
    </div>,
    document.body,
  );
}
