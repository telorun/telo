import { AlertDialog, Dialog as DialogPrimitive, Popover as PopoverPrimitive } from "radix-ui";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { ConfirmationProps, DialogProps, DrawerProps, PopoverProps } from "../../../../ui-react/nodejs/src/contract/ui-react-controls.js";
import { useCloseReason, useReturnedFocus } from "./intents.js";
import { firstTabbable, leaveClosing, marked, useMarkedContent } from "./layers.js";

/** A dialog or a drawer: the two differ only in where the mechanics place them. */
function Modal({ open, modal, labelledBy, describedBy, attributes, onOpenChange, children }: DialogProps) {
  const overlay = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const closing = useCloseReason(onOpenChange, content);
  const returnFocus = useReturnedFocus(open);
  useLayoutEffect(
    () => () => {
      leaveClosing(overlay.current);
      leaveClosing(content.current);
    },
    [],
  );
  return (
    <DialogPrimitive.Root open={open} modal={modal} onOpenChange={closing.change}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay data-telo-part="surface-overlay" {...marked} ref={overlay} />
        <DialogPrimitive.Content
          {...attributes}
          data-telo-part="surface"
          {...marked}
          ref={content}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          onEscapeKeyDown={closing.escape}
          onInteractOutside={closing.outside}
          onCloseAutoFocus={returnFocus}
        >
          {/* The primitive asks for a title and a description of its own; the
              renderer's, which `labelledBy` and `describedBy` name, are the ones read. */}
          <DialogPrimitive.Title hidden />
          <DialogPrimitive.Description hidden />
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Dialog(props: DialogProps) {
  return <Modal {...props} />;
}

export function Drawer({ side, ...props }: DrawerProps) {
  return <Modal {...props} />;
}

/** A side as the primitive places it, which follows the text direction. */
function placedSide(side: PopoverProps["side"]): "top" | "bottom" | "left" | "right" {
  if (side === "top" || side === "bottom") return side;
  const rightToLeft = document.documentElement.dir === "rtl";
  return (side === "start") !== rightToLeft ? "left" : "right";
}

export function Popover({ open, anchor, side, align, labelledBy, attributes, onOpenChange, children }: PopoverProps) {
  const { content, ref } = useMarkedContent();
  const closing = useCloseReason(onOpenChange, content);
  const returnFocus = useReturnedFocus(open);
  const anchored = useMemo(() => ({ current: anchor }), [anchor]);
  useLayoutEffect(() => () => leaveClosing(content.current), []);
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={closing.change}>
      <PopoverPrimitive.Anchor virtualRef={anchored as { current: HTMLElement }} />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          {...attributes}
          data-telo-part="surface"
          ref={ref}
          side={placedSide(side)}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          aria-labelledby={labelledBy}
          onEscapeKeyDown={closing.escape}
          onInteractOutside={closing.outside}
          onCloseAutoFocus={returnFocus}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/** A question only Escape or one of the renderer's buttons answers; the focus
 *  starts on the first thing in it that takes the focus. */
export function Confirmation({ open, labelledBy, describedBy, attributes, onOpenChange, children }: ConfirmationProps) {
  const content = useRef<HTMLDivElement>(null);
  const closing = useCloseReason(onOpenChange, content);
  const returnFocus = useReturnedFocus(open);
  return (
    <AlertDialog.Root open={open} onOpenChange={closing.change}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay data-telo-part="surface-overlay" {...marked} />
        <AlertDialog.Content
          {...attributes}
          data-telo-part="surface"
          {...marked}
          ref={content}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          onEscapeKeyDown={closing.escape}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            firstTabbable(event.currentTarget as Element)?.focus();
          }}
          onCloseAutoFocus={returnFocus}
        >
          <AlertDialog.Title hidden />
          <AlertDialog.Description hidden />
          {children}
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
