import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CloseReason, TooltipProps } from "../../contract/ui-react-controls.js";
import { LAYER, useLayer } from "./layers.js";
import { usePlacement } from "./placement.js";
import { asTrigger, refs } from "./shared.js";

/** How long a pointer rests on the trigger before the tooltip asks to open. */
const DELAY = 300;

type Opening = "delayed-open" | "instant-open";

/** The name of the renderer's element, shown on hover and on focus. */
export function Tooltip({ open, label, onOpenChange, children }: TooltipProps) {
  const id = useId();
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const opening = useRef<Opening>("instant-open");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // A press focuses the trigger, and is no reason to name it.
  const pressed = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  const ask = (how: Opening) => {
    clearTimeout(timer.current);
    opening.current = how;
    if (!open) onOpenChange(true);
  };
  const shut = (reason: CloseReason) => {
    clearTimeout(timer.current);
    if (open) onOpenChange(false, reason);
  };
  return (
    <>
      {asTrigger(children, setTrigger, {
        "aria-describedby": open ? id : (children.props as { "aria-describedby"?: string })["aria-describedby"],
        onPointerEnter: (event: PointerEvent) => {
          if (event.pointerType === "touch" || open) return;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => ask("delayed-open"), DELAY);
        },
        onPointerLeave: () => shut("close"),
        onPointerDown: () => {
          pressed.current = true;
          document.addEventListener("pointerup", () => (pressed.current = false), { once: true });
          shut("close");
        },
        onFocus: () => pressed.current || ask("instant-open"),
        onBlur: () => shut("close"),
      })}
      {open && <TooltipContent id={id} label={label} trigger={trigger} opening={opening.current} onOpenChange={onOpenChange} />}
    </>
  );
}

function TooltipContent({
  id,
  label,
  trigger,
  opening,
  onOpenChange,
}: {
  id: string;
  label: string;
  trigger: HTMLElement | null;
  opening: Opening;
  onOpenChange: TooltipProps["onOpenChange"];
}) {
  const content = useRef<HTMLDivElement | null>(null);
  const { setFloating, style } = usePlacement(trigger, "top", "center", 6);
  useLayer(true, {
    roots: () => [content.current],
    inside: () => [content.current, trigger],
    modal: false,
    stopsBeneath: false,
    onEscape: () => onOpenChange(false, "escape"),
    // Leaving the trigger closes it; only a press elsewhere is outside it.
    onOutside: (cause) => cause === "press" && onOpenChange(false, "outside"),
    returnsFocus: false,
  });
  return createPortal(
    <div data-telo-part="tooltip" {...{ [LAYER]: "" }} data-state={opening} role="tooltip" id={id} ref={refs(content, setFloating)} style={style}>
      {label}
    </div>,
    document.body,
  );
}
