import type { LucideIcon } from "lucide-react";
import { Tooltip } from "radix-ui";
import { Icon } from "./icon.js";

interface IconButtonProps {
  part: string;
  /** The button's accessible name, and what its tooltip says. */
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  onClick: () => void;
}

/** A button that shows only an icon: its name is read out, and shown on hover or focus. */
export function IconButton({ part, label, icon, disabled, onClick }: IconButtonProps) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button data-telo-part={part} type="button" aria-label={label} disabled={disabled} onClick={onClick}>
          <Icon of={icon} />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content data-telo-part="tooltip" sideOffset={6}>
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
