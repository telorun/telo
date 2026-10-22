import { useState } from "react";
import type { IconName } from "../contract/ui-react-controls.js";
import { useControl } from "./effective-controls.js";

interface IconButtonProps {
  part: string;
  /** The button's accessible name, and what its tooltip says. */
  label: string;
  icon: IconName;
  disabled?: boolean;
  /** Given the button, for what opens anchored to it. */
  onClick: (button: HTMLElement) => void;
}

/** A button that shows only an icon: its name is read out, and shown on hover or focus. */
export function IconButton({ part, label, icon, disabled, onClick }: IconButtonProps) {
  const Tooltip = useControl("Tooltip");
  const Icon = useControl("Icon");
  const [named, setNamed] = useState(false);
  return (
    <Tooltip open={named} label={label} onOpenChange={setNamed}>
      <button data-telo-part={part} type="button" aria-label={label} disabled={disabled} onClick={(event) => onClick(event.currentTarget)}>
        <Icon name={icon} />
      </button>
    </Tooltip>
  );
}
