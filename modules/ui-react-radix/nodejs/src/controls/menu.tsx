import { DropdownMenu } from "radix-ui";
import type { MenuProps } from "../../../../ui-react/nodejs/src/contract/ui-react-controls.js";
import { stateless, useCloseReason } from "./intents.js";
import { useMarkedContent } from "./layers.js";

/** A list of things to do, opened from the renderer's button: the button is the trigger. */
export function Menu({ open, items, onOpenChange, onChange, children }: MenuProps) {
  const { content, ref } = useMarkedContent();
  const closing = useCloseReason(onOpenChange, content);
  return (
    <DropdownMenu.Root open={open} onOpenChange={closing.change}>
      <DropdownMenu.Trigger asChild>{stateless(children)}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          data-telo-part="menu"
          ref={ref}
          align="start"
          sideOffset={4}
          onEscapeKeyDown={closing.escape}
          onInteractOutside={closing.outside}
        >
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.key}
              data-telo-part="menu-item"
              aria-current={item.current ? "true" : undefined}
              data-current={item.current ? "true" : undefined}
              onSelect={() => onChange(item.key)}
            >
              {item.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
