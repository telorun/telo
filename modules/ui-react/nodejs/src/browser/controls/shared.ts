import { cloneElement, type ReactElement, type Ref } from "react";
import type { Semantics } from "../../contract/ui-react-controls.js";

/** The relations and conditions a control forwards to its focusable element. */
export function aria(semantics: Pick<Semantics, "label" | "describedBy" | "invalid"> & { required?: boolean }) {
  return {
    "aria-label": semantics.label,
    "aria-describedby": semantics.describedBy || undefined,
    "aria-invalid": semantics.invalid ? true : undefined,
    "aria-required": semantics.required ? true : undefined,
  };
}

export const invalidMark = (invalid: boolean) => (invalid ? "true" : undefined);

/** Whether a scrolled list shows its end. */
export const atEnd = (element: HTMLElement) => element.scrollTop + element.clientHeight >= element.scrollHeight - 8;

/** One ref setting several. */
export function refs<T>(...targets: (Ref<T> | undefined)[]): (node: T | null) => void {
  return (node) => {
    for (const target of targets) {
      if (typeof target === "function") target(node);
      else if (target) (target as { current: T | null }).current = node;
    }
  };
}

type Handler = (event: never) => void;

/**
 * The renderer's own element, drawn as a control's trigger: it keeps its own
 * props and handlers, the control's run after them, and it carries no state of
 * the control's.
 */
export function asTrigger(element: ReactElement, ref: Ref<HTMLElement>, added: Record<string, unknown>): ReactElement {
  const own = element.props as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...added, ref: refs(own.ref as Ref<HTMLElement> | undefined, ref) };
  for (const [name, value] of Object.entries(added)) {
    const held = own[name];
    if (typeof value === "function" && typeof held === "function") {
      merged[name] = (event: never) => {
        (held as Handler)(event);
        (value as Handler)(event);
      };
    }
  }
  return cloneElement(element, merged);
}
