import { Check, ChevronDown } from "lucide-react";
import { DropdownMenu, Select as SelectPrimitive } from "radix-ui";
import { Icon } from "./icon.js";

export interface Option {
  /** What choosing the option yields. */
  value: string;
  label: string;
}

interface SelectProps {
  /** The part the trigger is. */
  part: string;
  id: string;
  options: Option[];
  /** The chosen option's value; empty when none is. */
  value: string;
  /** Shown while nothing is chosen. */
  placeholder: string;
  /** The entry that chooses nothing. */
  none: string;
  invalid?: boolean;
  onChange: (value: string) => void;
}

const NONE = "none";

/**
 * One choice from a list. Entries are keyed by their position, because the
 * primitive refuses an empty value and an option may be any text.
 */
export function Select({ part, id, options, value, placeholder, none, invalid, onChange }: SelectProps) {
  const chosen = options.findIndex((option) => option.value === value);
  return (
    <SelectPrimitive.Root
      value={chosen === -1 ? "" : String(chosen)}
      onValueChange={(key) => onChange(key === NONE ? "" : options[Number(key)].value)}
    >
      <SelectPrimitive.Trigger data-telo-part={part} id={id} data-invalid={invalid ? "true" : undefined} aria-invalid={invalid ? true : undefined}>
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon asChild>
          <ChevronDown data-telo-part="icon" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content data-telo-part="select-content" position="popper" sideOffset={4}>
          <SelectPrimitive.Viewport>
            <Item value={NONE} label={none} />
            {options.map((option, index) => (
              <Item key={index} value={String(index)} label={option.label} />
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

function Item({ value, label }: { value: string; label: string }) {
  return (
    <SelectPrimitive.Item data-telo-part="select-item" value={value}>
      <SelectPrimitive.ItemText>{label}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator>
        <Icon of={Check} />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

interface MultiSelectProps {
  part: string;
  id: string;
  options: Option[];
  values: string[];
  placeholder: string;
  onChange: (values: string[]) => void;
}

/** Any number of choices from a list, which stays open while they are made. */
export function MultiSelect({ part, id, options, values, placeholder, onChange }: MultiSelectProps) {
  const chosen = options.filter((option) => values.includes(option.value));
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger data-telo-part={part} id={id} data-placeholder={chosen.length === 0 ? "" : undefined}>
        <span>{chosen.length === 0 ? placeholder : chosen.map((option) => option.label).join(", ")}</span>
        <Icon of={ChevronDown} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content data-telo-part="select-content" align="start" sideOffset={4}>
          {options.map((option) => {
            const checked = values.includes(option.value);
            return (
              <DropdownMenu.CheckboxItem
                key={option.value}
                data-telo-part="select-item"
                checked={checked}
                // In the options' own order, whatever order they were chosen in.
                onCheckedChange={(next) =>
                  onChange(options.map((each) => each.value).filter((each) => (each === option.value ? next : values.includes(each))))
                }
                onSelect={(event) => event.preventDefault()}
              >
                {option.label}
                {checked && <Icon of={Check} />}
              </DropdownMenu.CheckboxItem>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
