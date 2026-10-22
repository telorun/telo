import { Check, ChevronDown } from "lucide-react";
import { DropdownMenu, Select as SelectPrimitive } from "radix-ui";
import type { MultiSelectProps, SelectProps } from "../../../../ui-react/nodejs/src/contract/ui-react-controls.js";
import { atEnd, useCloseReason } from "./intents.js";
import { useMarkedContent } from "./layers.js";
import { aria, invalidMark } from "./semantics.js";

const NONE = "none";

/**
 * One choice from a list. Entries are keyed by their position, because the
 * primitive refuses an empty value and an option's key may be any text.
 */
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
  const chosen = options.findIndex((option) => option.key === value);
  const { content, ref } = useMarkedContent();
  const closing = useCloseReason(onOpenChange, content);
  return (
    <SelectPrimitive.Root
      open={open}
      disabled={disabled}
      value={chosen === -1 ? "" : String(chosen)}
      onOpenChange={closing.change}
      onValueChange={(key) => onChange(key === NONE ? "" : options[Number(key)].key)}
    >
      <SelectPrimitive.Trigger
        {...aria({ ...semantics, required })}
        data-telo-part={part}
        data-invalid={invalidMark(semantics.invalid)}
        id={id}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon asChild>
          <ChevronDown data-telo-part="icon" aria-hidden="true" focusable="false" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          data-telo-part="select-content"
          ref={ref}
          position="popper"
          sideOffset={4}
          onEscapeKeyDown={closing.escape}
          onPointerDownOutside={closing.outside}
        >
          <SelectPrimitive.Viewport onScroll={(event) => atEnd(event.currentTarget) && onEndReached?.()}>
            <Item value={NONE} label={noneLabel} />
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
        <Check data-telo-part="icon" aria-hidden="true" focusable="false" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
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
  const chosen = options.filter((option) => value.includes(option.key));
  const { content, ref } = useMarkedContent();
  const closing = useCloseReason(onOpenChange, content);
  return (
    <DropdownMenu.Root open={open} onOpenChange={closing.change}>
      <DropdownMenu.Trigger
        {...aria({ ...semantics, required })}
        data-telo-part={part}
        data-invalid={invalidMark(semantics.invalid)}
        data-placeholder={chosen.length === 0 ? "" : undefined}
        id={id}
        disabled={disabled}
      >
        <span>{chosen.length === 0 ? placeholder : chosen.map((option) => option.label).join(", ")}</span>
        <ChevronDown data-telo-part="icon" aria-hidden="true" focusable="false" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          data-telo-part="select-content"
          ref={ref}
          align="start"
          sideOffset={4}
          onEscapeKeyDown={closing.escape}
          onInteractOutside={closing.outside}
          onScroll={(event) => atEnd(event.currentTarget) && onEndReached?.()}
        >
          {options.map((option) => {
            const checked = value.includes(option.key);
            return (
              <DropdownMenu.CheckboxItem
                key={option.key}
                data-telo-part="select-item"
                checked={checked}
                // In the options' own order, whatever order they were chosen in.
                onCheckedChange={(next) =>
                  onChange(options.map((each) => each.key).filter((each) => (each === option.key ? next : value.includes(each))))
                }
                onSelect={(event) => event.preventDefault()}
              >
                {option.label}
                {checked && <Check data-telo-part="icon" aria-hidden="true" focusable="false" />}
              </DropdownMenu.CheckboxItem>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
