import type { DateRangeInputProps } from "../../contract/ui-react-controls.js";
import { invalidMark } from "./shared.js";

/** Two dates and the presets that set them, the one the dates equal shown on. */
export function DateRangeInput({ id, label, describedBy, invalid, required, disabled, fromLabel, toLabel, presets, value, onChange }: DateRangeInputProps) {
  const active = presets.findIndex((preset) => preset.from === value.from && preset.to === value.to);
  const date = (end: "from" | "to") => (
    <input
      data-telo-part={`date-range-${end}`}
      id={`${id}-${end}`}
      type="date"
      autoComplete="off"
      aria-invalid={invalid ? true : undefined}
      aria-required={required ? true : undefined}
      disabled={disabled}
      value={value[end]}
      onChange={(event) => onChange({ ...value, [end]: event.target.value })}
    />
  );
  return (
    <div data-telo-part="date-range" id={id} role="group" aria-label={label} aria-describedby={describedBy || undefined} data-invalid={invalidMark(invalid)}>
      {presets.length > 0 && (
        <div data-telo-part="date-range-presets">
          {presets.map((preset, index) => (
            <button
              key={index}
              data-telo-part="date-range-preset"
              type="button"
              data-state={index === active ? "on" : "off"}
              aria-pressed={index === active}
              disabled={disabled}
              onClick={() => onChange({ from: preset.from, to: preset.to })}
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}
      <label data-telo-part="label" htmlFor={`${id}-from`}>
        {fromLabel}
      </label>
      {date("from")}
      <label data-telo-part="label" htmlFor={`${id}-to`}>
        {toLabel}
      </label>
      {date("to")}
    </div>
  );
}
