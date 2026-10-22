import { useId, useState, type KeyboardEvent } from "react";
import type { MenuProps } from "../../contract/ui-react-controls.js";
import { FloatingList, opensList } from "./floating-list.js";
import { asTrigger } from "./shared.js";

/** A list of things to do, opened from the renderer's button: the button is the trigger. */
export function Menu({ open, items, onOpenChange, onChange, children }: MenuProps) {
  const listId = useId();
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const choose = (index: number) => {
    onChange(items[index].key);
    onOpenChange(false, "close");
  };
  return (
    <>
      {asTrigger(children, setTrigger, {
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": open ? listId : undefined,
        onClick: () => (open ? onOpenChange(false, "close") : onOpenChange(true)),
        onKeyDown: (event: KeyboardEvent) => {
          if (open || !opensList(event)) return;
          event.preventDefault();
          onOpenChange(true);
        },
      })}
      {open && (
        <FloatingList part="menu" id={listId} trigger={trigger} role="menu" entryRole="menuitem" onOpenChange={onOpenChange} onEntryKey={choose}>
          {(entryProps) =>
            items.map((item, index) => (
              <div
                key={item.key}
                {...entryProps(index)}
                data-telo-part="menu-item"
                role="menuitem"
                aria-current={item.current ? "true" : undefined}
                data-current={item.current ? "true" : undefined}
                onClick={() => choose(index)}
              >
                {item.label}
              </div>
            ))
          }
        </FloatingList>
      )}
    </>
  );
}
