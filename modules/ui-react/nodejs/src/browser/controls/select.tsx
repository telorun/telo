import { Check, ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import type { MultiSelectProps, SelectProps } from "../../contract/ui-react-controls.js";
import { FloatingList, opensList } from "./floating-list.js";
import { aria, invalidMark } from "./shared.js";

const glyph = <Check data-telo-part="icon" aria-hidden="true" focusable="false" />;

/** One choice from a list, the first entry choosing nothing. */
export function Select({
  id,
  part,
  options,
  value,
  placeholder,
  noneLabel,
  open,
  onOpenChange,
  onChange,
  onEndReached,
  required,
  disabled,
  ...semantics
}: SelectProps) {
  const listId = useId();
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const chosen = options.find((option) => option.key === value);
  const entries = [{ key: "", label: noneLabel }, ...options];
  const choose = (index: number) => {
    onChange(entries[index].key);
    onOpenChange(false, "close");
  };
  return (
    <>
      <button
        {...aria({ ...semantics, required })}
        type="button"
        role="combobox"
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        aria-autocomplete="none"
        data-telo-part={part}
        data-state={open ? "open" : "closed"}
        data-placeholder={chosen ? undefined : ""}
        data-invalid={invalidMark(semantics.invalid)}
        id={id}
        disabled={disabled}
        ref={setTrigger}
        onClick={() => (open ? onOpenChange(false, "close") : onOpenChange(true))}
        onKeyDown={(event) => {
          if (open || !opensList(event)) return;
          event.preventDefault();
          onOpenChange(true);
        }}
      >
        <span>{chosen ? chosen.label : placeholder}</span>
        <ChevronDown data-telo-part="icon" aria-hidden="true" focusable="false" />
      </button>
      {open && (
        <FloatingList part="select-content" id={listId} trigger={trigger} role="listbox" entryRole="option" onOpenChange={onOpenChange} onEndReached={onEndReached} onEntryKey={choose}>
          {(entryProps) =>
            entries.map((entry, index) => {
              // The entry choosing nothing is never the chosen one.
              const on = index > 0 && entry.key === value;
              return (
                <div
                  key={index}
                  {...entryProps(index)}
                  data-telo-part="select-item"
                  role="option"
                  aria-selected={on}
                  data-state={on ? "checked" : "unchecked"}
                  onClick={() => choose(index)}
                >
                  <span>{entry.label}</span>
                  {on && glyph}
                </div>
              );
            })
          }
        </FloatingList>
      )}
    </>
  );
}

/** Any number of choices from a list, which stays open while they are made. */
export function MultiSelect({
  id,
  part,
  options,
  value,
  placeholder,
  open,
  onOpenChange,
  onChange,
  onEndReached,
  required,
  disabled,
  ...semantics
}: MultiSelectProps) {
  const listId = useId();
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const chosen = options.filter((option) => value.includes(option.key));
  // In the options' own order, whatever order they were chosen in.
  const toggle = (index: number) => {
    const key = options[index].key;
    onChange(options.map((each) => each.key).filter((each) => (each === key ? !value.includes(key) : value.includes(each))));
  };
  return (
    <>
      <button
        {...aria({ ...semantics, required })}
        type="button"
        aria-haspopup="menu"
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        data-telo-part={part}
        data-state={open ? "open" : "closed"}
        data-placeholder={chosen.length === 0 ? "" : undefined}
        data-invalid={invalidMark(semantics.invalid)}
        id={id}
        disabled={disabled}
        ref={setTrigger}
        onClick={() => (open ? onOpenChange(false, "close") : onOpenChange(true))}
        onKeyDown={(event) => {
          if (open || !opensList(event)) return;
          event.preventDefault();
          onOpenChange(true);
        }}
      >
        <span>{chosen.length === 0 ? placeholder : chosen.map((option) => option.label).join(", ")}</span>
        <ChevronDown data-telo-part="icon" aria-hidden="true" focusable="false" />
      </button>
      {open && (
        <FloatingList part="select-content" id={listId} trigger={trigger} role="menu" entryRole="menuitemcheckbox" onOpenChange={onOpenChange} onEndReached={onEndReached} onEntryKey={toggle}>
          {(entryProps) =>
            options.map((option, index) => {
              const on = value.includes(option.key);
              return (
                <div
                  key={option.key}
                  {...entryProps(index)}
                  data-telo-part="select-item"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  data-state={on ? "checked" : "unchecked"}
                  onClick={() => toggle(index)}
                >
                  {option.label}
                  {on && glyph}
                </div>
              );
            })
          }
        </FloatingList>
      )}
    </>
  );
}
