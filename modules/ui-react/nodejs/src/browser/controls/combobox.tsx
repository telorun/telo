import { Check } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { ComboboxEntry, ComboboxGroup, ComboboxProps } from "../../contract/ui-react-controls.js";
import { LAYER, useLayer } from "./layers.js";
import { usePlacement } from "./placement.js";
import { aria, invalidMark, refs } from "./shared.js";

const glyph = <Check data-telo-part="icon" aria-hidden="true" focusable="false" />;

/** An entry's id: the input names the highlighted one by it. */
const entryId = (list: string, index: number) => `${list}-${index}`;

/**
 * A text box that keeps the focus while a list of labelled sections opens
 * under it. The highlight is the renderer's: the arrows and the pointer ask to
 * move it, the box announces it as `aria-activedescendant`, and Enter picks it.
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
  const keys = groups.flatMap((group) => group.entries.map((entry) => entry.key));
  const listed = open && keys.length > 0;
  const active = keys.indexOf(highlighted);

  const move = (event: KeyboardEvent) => {
    event.preventDefault();
    if (!open) return onOpenChange(true);
    if (keys.length === 0) return;
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = active === -1 ? (step === 1 ? 0 : keys.length - 1) : (active + step + keys.length) % keys.length;
    onHighlight(keys[next]);
  };

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
      {listed && (
        <ComboboxList
          id={listId}
          groups={groups}
          active={active}
          highlighted={highlighted}
          input={input}
          anchor={anchor ?? null}
          onOpenChange={onOpenChange}
          onHighlight={onHighlight}
          onPick={onPick}
        />
      )}
    </>
  );
}

function ComboboxList({
  id,
  groups,
  active,
  highlighted,
  input,
  anchor,
  onOpenChange,
  onHighlight,
  onPick,
}: {
  id: string;
  groups: ComboboxGroup[];
  active: number;
  highlighted: string;
  input: HTMLInputElement | null;
  anchor: HTMLElement | null;
  onOpenChange: ComboboxProps["onOpenChange"];
  onHighlight: ComboboxProps["onHighlight"];
  onPick: ComboboxProps["onPick"];
}) {
  const list = useRef<HTMLDivElement | null>(null);
  const against = anchor ?? input;
  const { setFloating, style } = usePlacement(against, "bottom", "start", 4);
  // The focus stays in the box: the layer neither takes it nor gives it back.
  useLayer(true, {
    roots: () => [list.current],
    inside: () => [list.current, input, anchor],
    modal: false,
    stopsBeneath: true,
    onEscape: () => onOpenChange(false, "escape"),
    onOutside: () => onOpenChange(false, "outside"),
    returnsFocus: false,
  });
  useEffect(() => {
    document.getElementById(entryId(id, active))?.scrollIntoView?.({ block: "nearest" });
  }, [id, active]);
  const checkable = groups.some((group) => group.entries.some((entry) => entry.checked !== undefined));
  let index = 0;
  return createPortal(
    <div
      data-telo-part="combobox-content"
      {...{ [LAYER]: "" }}
      data-state="open"
      role="listbox"
      aria-multiselectable={checkable ? true : undefined}
      id={id}
      ref={refs(list, setFloating)}
      style={style}
      // A press on the list must not take the focus from the box.
      onMouseDown={(event) => event.preventDefault()}
    >
      {groups.map((group) => {
        const heading = `${id}-group-${group.key}`;
        return (
          <div key={group.key} data-telo-part="combobox-group" role="group" aria-labelledby={group.label === undefined ? undefined : heading}>
            {group.label !== undefined && <div id={heading}>{group.label}</div>}
            {group.entries.map((entry) => (
              <Entry key={entry.key} id={entryId(id, index++)} entry={entry} highlighted={entry.key === highlighted} onHighlight={onHighlight} onPick={onPick} />
            ))}
          </div>
        );
      })}
    </div>,
    document.body,
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
      {checked && glyph}
    </div>
  );
}
