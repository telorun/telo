import { Check } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { useEffect, useId, useLayoutEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { ComboboxEntry, ComboboxProps } from "../../../../ui-react/nodejs/src/contract/ui-react-controls.js";
import { useCloseReason } from "./intents.js";
import { leaveClosing, useMarkedContent } from "./layers.js";
import { aria, invalidMark } from "./semantics.js";

/** An entry's id: the input names the highlighted one by it. */
const entryId = (list: string, index: number) => `${list}-${index}`;

/**
 * A text box that keeps the focus while a list of labelled sections opens
 * under it, on Radix's popover placed against the box (or the renderer's
 * anchor) and never given the focus. The highlight is the renderer's: the
 * arrows and the pointer ask to move it, the box announces it as
 * `aria-activedescendant`, and Enter picks it.
 */
export function Combobox({
  id,
  placeholder,
  value,
  open,
  anchor,
  groups,
  highlighted,
  onChange,
  onOpenChange,
  onHighlight,
  onPick,
  onBackspace,
  disabled,
  ...semantics
}: ComboboxProps) {
  const listId = useId();
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  const { content, ref } = useMarkedContent();
  const closing = useCloseReason(onOpenChange, content);
  const keys = groups.flatMap((group) => group.entries.map((entry) => entry.key));
  const listed = open && keys.length > 0;
  const active = keys.indexOf(highlighted);
  const against = anchor ?? input;
  const anchored = useMemo(() => ({ current: against }), [against]);
  useLayoutEffect(() => () => leaveClosing(content.current), [content]);
  useEffect(() => {
    if (listed && active !== -1) document.getElementById(entryId(listId, active))?.scrollIntoView?.({ block: "nearest" });
  }, [listed, listId, active]);

  const move = (event: KeyboardEvent) => {
    event.preventDefault();
    if (!open) return onOpenChange(true);
    if (keys.length === 0) return;
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = active === -1 ? (step === 1 ? 0 : keys.length - 1) : (active + step + keys.length) % keys.length;
    onHighlight(keys[next]);
  };

  const checkable = groups.some((group) => group.entries.some((entry) => entry.checked !== undefined));
  let index = 0;
  return (
    <>
      <input
        {...aria(semantics)}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={listed}
        aria-controls={listed ? listId : undefined}
        aria-activedescendant={listed && active !== -1 ? entryId(listId, active) : undefined}
        data-telo-part="search-input"
        data-state={listed ? "open" : "closed"}
        data-invalid={invalidMark(semantics.invalid)}
        id={id}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        placeholder={placeholder}
        value={value}
        ref={setInput}
        onChange={(event) => {
          onChange(event.target.value);
          if (!open) onOpenChange(true);
        }}
        onClick={() => open || onOpenChange(true)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") move(event);
          else if (event.key === "Enter" && listed && active !== -1) {
            event.preventDefault();
            onPick(highlighted);
          } else if (event.key === "Backspace" && value === "") onBackspace();
        }}
      />
      <PopoverPrimitive.Root open={listed} onOpenChange={closing.change}>
        <PopoverPrimitive.Anchor virtualRef={anchored as { current: HTMLElement }} />
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            data-telo-part="combobox-content"
            ref={ref}
            id={listId}
            role="listbox"
            aria-multiselectable={checkable ? true : undefined}
            side="bottom"
            align="start"
            sideOffset={4}
            collisionPadding={8}
            onEscapeKeyDown={closing.escape}
            // The box and its anchor are where the focus and the presses of a person typing happen.
            onInteractOutside={(event) => {
              const target = event.target as Node | null;
              if (target && (input?.contains(target) || anchor?.contains(target))) event.preventDefault();
              else closing.outside(event);
            }}
            // The focus stays in the box: the layer neither takes it nor gives it back.
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            // A press on the list must not take the focus from the box.
            onMouseDown={(event) => event.preventDefault()}
          >
            {groups.map((group) => {
              const heading = `${listId}-group-${group.key}`;
              return (
                <div key={group.key} data-telo-part="combobox-group" role="group" aria-labelledby={group.label === undefined ? undefined : heading}>
                  {group.label !== undefined && <div id={heading}>{group.label}</div>}
                  {group.entries.map((entry) => (
                    <Entry key={entry.key} id={entryId(listId, index++)} entry={entry} highlighted={entry.key === highlighted} onHighlight={onHighlight} onPick={onPick} />
                  ))}
                </div>
              );
            })}
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    </>
  );
}

function Entry({
  id,
  entry,
  highlighted,
  onHighlight,
  onPick,
}: {
  id: string;
  entry: ComboboxEntry;
  highlighted: boolean;
  onHighlight: ComboboxProps["onHighlight"];
  onPick: ComboboxProps["onPick"];
}) {
  const checked = entry.checked;
  return (
    <div
      id={id}
      data-telo-part="combobox-item"
      role="option"
      aria-selected={highlighted}
      aria-checked={checked}
      data-state={checked === undefined ? undefined : checked ? "checked" : "unchecked"}
      data-highlighted={highlighted ? "" : undefined}
      onMouseMove={() => highlighted || onHighlight(entry.key)}
      onClick={() => onPick(entry.key)}
    >
      <span>{entry.label}</span>
      {entry.hint !== undefined && <span>{entry.hint}</span>}
      {checked && <Check data-telo-part="icon" aria-hidden="true" focusable="false" />}
    </div>
  );
}
