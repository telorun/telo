import { X } from "lucide-react";
import { ToggleGroup } from "radix-ui";
import { useState } from "react";
import { Icon } from "./icon.js";
import type { Option } from "./select.js";

interface OptionGroupProps {
  /** The parts of the group and of one option in it. */
  parts: { group: string; option: string };
  id: string;
  /** The group's accessible name where no label points at it alone. */
  name?: string;
  options: Option[];
  values: string[];
  invalid?: boolean;
  onChange: (values: string[]) => void;
}

/** Options side by side, any number of them chosen. */
export function OptionGroup({ parts, id, name, options, values, invalid, onChange }: OptionGroupProps) {
  return (
    <ToggleGroup.Root
      data-telo-part={parts.group}
      id={id}
      type="multiple"
      aria-label={name}
      data-invalid={invalid ? "true" : undefined}
      aria-invalid={invalid ? true : undefined}
      value={values}
      onValueChange={onChange}
    >
      {options.map((option) => (
        <ToggleGroup.Item key={option.value} data-telo-part={parts.option} value={option.value}>
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

/** What was typed, as the values a comma separates. */
export const separated = (text: string): string[] =>
  text
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");

interface TagsProps {
  /** The parts of the box, of one value, of its remove button and of what is typed into. */
  parts: { tags: string; tag: string; remove: string; input: string };
  id: string;
  name?: string;
  /** The type of the input a value is typed into. */
  type?: string;
  values: string[];
  invalid?: boolean;
  onChange: (values: string[]) => void;
}

/** Values typed one at a time: Enter or a comma adds what was typed, and each
 *  value is removed on its own. */
export function Tags({ parts, id, name, type = "text", values, invalid, onChange }: TagsProps) {
  const [text, setText] = useState("");
  const add = () => {
    const added = separated(text).filter((value) => !values.includes(value));
    setText("");
    if (added.length > 0) onChange([...values, ...added]);
  };
  return (
    <div data-telo-part={parts.tags} data-invalid={invalid ? "true" : undefined}>
      {values.map((value) => (
        <span key={value} data-telo-part={parts.tag}>
          {value}
          <button
            data-telo-part={parts.remove}
            type="button"
            aria-label={`Remove ${value}`}
            onClick={() => onChange(values.filter((other) => other !== value))}
          >
            <Icon of={X} />
          </button>
        </span>
      ))}
      <input
        data-telo-part={parts.input}
        id={id}
        aria-label={name}
        aria-invalid={invalid ? true : undefined}
        autoComplete="off"
        type={type}
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
