import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { CloseReason } from "../../contract/ui-react-controls.js";
import { LAYER, useLayer } from "./layers.js";
import { useListFocus } from "./list-navigation.js";
import { usePlacement } from "./placement.js";
import { atEnd, refs } from "./shared.js";

type OpenChange = (open: boolean, reason?: CloseReason) => void;

/** Whether a key on a closed trigger opens its list; Enter and Space press it. */
export const opensList = (event: KeyboardEvent) => event.key === "ArrowDown" || event.key === "ArrowUp";

/**
 * A list over the page, placed under its trigger: the focus moves into it as it
 * opens and back to the trigger as it closes.
 */
export function FloatingList({
  part,
  id,
  trigger,
  role,
  entryRole,
  onOpenChange,
  onEndReached,
  children,
  onEntryKey,
}: {
  part: "select-content" | "menu";
  id: string;
  trigger: HTMLElement | null;
  role: "listbox" | "menu";
  entryRole: "option" | "menuitemcheckbox" | "menuitem";
  onOpenChange: OpenChange;
  onEndReached?: () => void;
  children: (entryProps: ReturnType<typeof useListFocus>["entryProps"]) => ReactNode;
  /** Enter or Space on the entry at an index. */
  onEntryKey: (index: number) => void;
}) {
  const list = useRef<HTMLDivElement | null>(null);
  const { setFloating, style } = usePlacement(trigger, "bottom", "start", 4);
  const entry = `[role="${entryRole}"]`;
  const { onKeyDown, entryProps } = useListFocus(list, entry);
  useLayer(true, {
    roots: () => [list.current],
    inside: () => [list.current, trigger],
    modal: false,
    stopsBeneath: true,
    onEscape: () => onOpenChange(false, "escape"),
    onOutside: () => onOpenChange(false, "outside"),
    initialFocus: () =>
      list.current?.querySelector<HTMLElement>(`${entry}[aria-checked="true"], ${entry}[aria-selected="true"]`) ?? list.current?.querySelector<HTMLElement>(entry) ?? list.current,
    returnsFocus: true,
  });
  return createPortal(
    <div
      data-telo-part={part}
      {...{ [LAYER]: "" }}
      data-state="open"
      role={role}
      id={id}
      tabIndex={-1}
      ref={refs(list, setFloating)}
      style={style}
      onScroll={(event) => atEnd(event.currentTarget) && onEndReached?.()}
      onKeyDown={(event) => {
        // The list keeps the focus: Tab leaves it through Escape or a choice.
        if (event.key === "Tab") return event.preventDefault();
        const target = (event.target as HTMLElement).closest<HTMLElement>(entry);
        if (target && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          return onEntryKey([...event.currentTarget.querySelectorAll(entry)].indexOf(target));
        }
        onKeyDown(event);
      }}
    >
      {children(entryProps)}
    </div>,
    document.body,
  );
}

