import type { KeyboardEvent } from "react";
import type {
  DateInputProps,
  DateTimeInputProps,
  NumberInputProps,
  TextAreaProps,
  TextInputProps,
  TimeInputProps,
} from "../../contract/ui-react-controls.js";
import { aria, invalidMark } from "./shared.js";

/** Enter and leaving the control both mean the text, where the renderer listens for that. */
const committing = (onCommit: (() => void) | undefined) =>
  onCommit && {
    onBlur: () => onCommit(),
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      onCommit();
    },
  };

export function TextInput({ id, part, name, type, value, onChange, onCommit, disabled, ...semantics }: TextInputProps) {
  return (
    <input
      {...aria(semantics)}
      data-telo-part={part}
      data-invalid={invalidMark(semantics.invalid)}
      id={id}
      name={name}
      type={type}
      autoComplete="off"
      disabled={disabled}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      {...committing(onCommit)}
    />
  );
}

export function NumberInput({ id, part, name, integer, value, onChange, onCommit, disabled, ...semantics }: NumberInputProps) {
  return (
    <input
      {...aria(semantics)}
      data-telo-part={part}
      data-invalid={invalidMark(semantics.invalid)}
      id={id}
      name={name}
      type="number"
      step={integer ? undefined : "any"}
      autoComplete="off"
      disabled={disabled}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      {...committing(onCommit)}
    />
  );
}

export function TextArea({ id, name, value, onChange, disabled, ...semantics }: TextAreaProps) {
  return (
    <textarea
      {...aria(semantics)}
      data-telo-part="textarea"
      data-invalid={invalidMark(semantics.invalid)}
      id={id}
      name={name}
      autoComplete="off"
      disabled={disabled}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function DateInput({ id, part, name, lang, value, onChange, onCommit, disabled, ...semantics }: DateInputProps) {
  return (
    <input
      {...aria(semantics)}
      data-telo-part={part}
      data-invalid={invalidMark(semantics.invalid)}
      id={id}
      name={name}
      type="date"
      autoComplete="off"
      disabled={disabled}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      {...committing(onCommit)}
    />
  );
}

export function DateTimeInput({ id, name, lang, value, onChange, disabled, ...semantics }: DateTimeInputProps) {
  return (
    <input
      {...aria(semantics)}
      data-telo-part="input"
      data-invalid={invalidMark(semantics.invalid)}
      id={id}
      name={name}
      type="datetime-local"
      autoComplete="off"
      disabled={disabled}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function TimeInput({ id, name, lang, value, onChange, disabled, ...semantics }: TimeInputProps) {
  return (
    <input
      {...aria(semantics)}
      data-telo-part="input"
      data-invalid={invalidMark(semantics.invalid)}
      id={id}
      name={name}
      type="time"
      autoComplete="off"
      disabled={disabled}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
