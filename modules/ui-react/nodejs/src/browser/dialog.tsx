import { X } from "lucide-react";
import { AlertDialog, Dialog as DialogPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { Icon } from "./icon.js";
import { ErrorNode } from "./nodes.js";
import type { ErrorSpec } from "./ui-error.js";

/** A modal panel over the page: it holds the focus, and Escape, its close
 *  button or a click outside it closes it. */
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay data-telo-part="dialog-overlay" />
        <DialogPrimitive.Content data-telo-part="dialog" aria-describedby={undefined}>
          <div data-telo-part="dialog-header">
            <DialogPrimitive.Title data-telo-part="dialog-title">{title}</DialogPrimitive.Title>
          </div>
          {children}
          <DialogPrimitive.Close data-telo-part="dialog-close" aria-label="Close">
            <Icon of={X} />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

interface ConfirmDialogProps {
  title: string;
  description: string;
  /** What the confirming button says. */
  confirm: string;
  busy: boolean;
  /** Why the last confirmation was refused. */
  failure?: ErrorSpec;
  onConfirm: () => void;
  onClose: () => void;
}

/** A question that interrupts: only Escape or one of its two buttons answers
 *  it, and confirming leaves it open for whoever asked to close. */
export function ConfirmDialog({ title, description, confirm, busy, failure, onConfirm, onClose }: ConfirmDialogProps) {
  return (
    <AlertDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay data-telo-part="dialog-overlay" />
        <AlertDialog.Content data-telo-part="dialog">
          <div data-telo-part="dialog-header">
            <AlertDialog.Title data-telo-part="dialog-title">{title}</AlertDialog.Title>
            <AlertDialog.Description data-telo-part="dialog-description">{description}</AlertDialog.Description>
          </div>
          {failure && <ErrorNode error={failure} />}
          <div data-telo-part="form-actions">
            <AlertDialog.Cancel data-telo-part="cancel">Cancel</AlertDialog.Cancel>
            <button data-telo-part="submit" data-style="danger" type="button" disabled={busy} onClick={onConfirm}>
              {confirm}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
