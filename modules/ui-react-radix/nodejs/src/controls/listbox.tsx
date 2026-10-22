import type { ListboxProps } from "../../../../ui-react/nodejs/src/contract/ui-react-controls.js";
import { atEnd } from "./intents.js";

/** The options read so far, each chosen by a click, Enter or Space; one more
 *  page is asked for at the end of the list. */
export function Listbox({ label, multiple, options, value, loading, onChange, onEndReached }: ListboxProps) {
  const choose = (key: string) =>
    onChange(multiple ? (value.includes(key) ? value.filter((held) => held !== key) : [...value, key]) : [key]);
  return (
    <ul
      data-telo-part="picker-list"
      role="listbox"
      aria-label={label}
      aria-multiselectable={multiple}
      data-state={loading ? "loading" : "idle"}
      onScroll={(event) => atEnd(event.currentTarget) && onEndReached?.()}
    >
      {options.map((option) => {
        const on = value.includes(option.key);
        return (
          <li
            key={option.key}
            data-telo-part="picker-option"
            role="option"
            aria-selected={on}
            data-state={on ? "on" : "off"}
            tabIndex={0}
            onClick={() => choose(option.key)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                choose(option.key);
              }
            }}
          >
            {option.label}
            {option.hint !== undefined && <span data-telo-part="option-hint">{option.hint}</span>}
          </li>
        );
      })}
    </ul>
  );
}
