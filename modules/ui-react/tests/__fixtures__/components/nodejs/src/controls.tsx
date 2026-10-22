import type { CheckboxProps } from "../../../../../nodejs/src/contract/ui-react-controls.js";
import "./controls.css";

/** A boolean drawn as the browser's own box. */
export function Checkbox({ id, name, describedBy, invalid, required, disabled, checked, onChange }: CheckboxProps) {
  return (
    <input
      data-telo-part="checkbox"
      className="fixture-checkbox"
      type="checkbox"
      id={id}
      name={name}
      aria-describedby={describedBy || undefined}
      aria-invalid={invalid || undefined}
      required={required}
      disabled={disabled}
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}
