import { Check } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import type { CheckboxProps } from "../../../../ui-react/nodejs/src/contract/ui-react-controls.js";
import { aria, invalidMark } from "./semantics.js";

export function Checkbox({ id, name, checked, onChange, required, disabled, ...semantics }: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      {...aria({ ...semantics, required })}
      data-telo-part="checkbox"
      data-invalid={invalidMark(semantics.invalid)}
      id={id}
      name={name}
      checked={checked}
      required={required}
      disabled={disabled}
      onCheckedChange={(next) => onChange(next === true)}
    >
      {checked && <Check data-telo-part="icon" aria-hidden="true" focusable="false" />}
    </CheckboxPrimitive.Root>
  );
}
