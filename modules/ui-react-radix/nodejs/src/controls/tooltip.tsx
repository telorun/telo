import { Tooltip as TooltipPrimitive } from "radix-ui";
import type { TooltipProps } from "../../../../ui-react/nodejs/src/contract/ui-react-controls.js";
import { stateless, useCloseReason } from "./intents.js";
import { useMarkedContent } from "./layers.js";

/** The name of the renderer's element, shown on hover and on focus. */
export function Tooltip({ open, label, onOpenChange, children }: TooltipProps) {
  const { content, ref } = useMarkedContent();
  const closing = useCloseReason(onOpenChange, content);
  return (
    <TooltipPrimitive.Provider delayDuration={300}>
      <TooltipPrimitive.Root open={open} onOpenChange={closing.change}>
        <TooltipPrimitive.Trigger asChild>{stateless(children)}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            data-telo-part="tooltip"
            ref={ref}
            sideOffset={6}
            onEscapeKeyDown={closing.escape}
            onPointerDownOutside={closing.outside}
          >
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
