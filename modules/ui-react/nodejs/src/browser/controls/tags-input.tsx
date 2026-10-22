import { X } from "lucide-react";
import { useState } from "react";
import type { TagsInputProps } from "../../contract/ui-react-controls.js";
import { separated } from "../separated.js";
import { aria, invalidMark } from "./shared.js";

/** Values typed one at a time: Enter, a comma or leaving the box adds what was
 *  typed, Backspace in an empty box takes the last one off, and each value is
 *  removed on its own. */
export function TagsInput({ id, parts, type, values, removeLabels, onChange, disabled, ...semantics }: TagsInputProps) {
  const [text, setText] = useState("");
  const add = () => {
    const added = separated(text).filter((value) => !values.includes(value));
    setText("");
    if (added.length > 0) onChange([...values, ...added]);
  };
  return (
    <div data-telo-part={parts.root} data-invalid={invalidMark(semantics.invalid)}>
      {values.map((value, index) => (
        <span key={value} data-telo-part={parts.tag}>
          {value}
          <button
            data-telo-part={parts.remove}
            type="button"
            aria-label={removeLabels[index]}
            disabled={disabled}
            onClick={() => onChange(values.filter((other) => other !== value))}
          >
            <X data-telo-part="icon" aria-hidden="true" focusable="false" />
          </button>
        </span>
      ))}
      <input
        {...aria(semantics)}
        data-telo-part={parts.input}
        id={id}
        autoComplete="off"
        type={type}
        disabled={disabled}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={add}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            add();
          } else if (event.key === "Backspace" && text === "" && values.length > 0) {
            onChange(values.slice(0, -1));
          }
        }}
      />
    </div>
  );
}
