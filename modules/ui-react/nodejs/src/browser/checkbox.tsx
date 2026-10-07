import { Check } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { Icon } from "./icon.js";

interface CheckboxProps {
  id: string;
  name: string;
  checked: boolean;
  invalid: boolean;
  onChange: (checked: boolean) => void;
}

export function Checkbox({ id, name, checked, invalid, onChange }: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      data-telo-part="checkbox"
      id={id}
      name={name}
      checked={checked}
      data-invalid={invalid ? "true" : undefined}
      aria-invalid={invalid ? true : undefined}
      onCheckedChange={(next) => onChange(next === true)}
    >
      {checked && <Icon of={Check} />}
    </CheckboxPrimitive.Root>
  );
}
