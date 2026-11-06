import { useState, type ReactElement } from "react";
import type { IconName } from "../contract/ui-react-controls.js";
import { useControl } from "./effective-controls.js";

interface IconButtonProps {
  part: string;
  /** The button's accessible name, and what its tooltip says. */
  label: string;
  /** The look's glyph for a meaning, or a glyph already drawn. */
  icon: IconName | ReactElement;
  type?: "button" | "submit";
  disabled?: boolean;
  /** Announced when its label changes, for a button confirming what it did. */
  live?: boolean;
  /** Given the button, for what opens anchored to it. */
  onClick?: (button: HTMLElement) => void;
}

/** A button that shows only an icon: its name is read out, and shown on hover or focus. */
export function IconButton({ part, label, icon, type = "button", disabled, live, onClick }: IconButtonProps) {
  const Tooltip = useControl("Tooltip");
  const Icon = useControl("Icon");
  const [named, setNamed] = useState(false);
  return (
    <Tooltip open={named} label={label} onOpenChange={setNamed}>
      <button
        data-telo-part={part}
        type={type}
        aria-label={label}
        aria-live={live ? "polite" : undefined}
        disabled={disabled}
        onClick={onClick && ((event) => onClick(event.currentTarget))}
      >
        {typeof icon === "string" ? <Icon name={icon} /> : icon}
      </button>
    </Tooltip>
  );
}
