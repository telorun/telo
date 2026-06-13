import { Monitor, Moon, Sun } from "lucide-react";
import type { DebugTheme } from "../theme.js";

const NEXT: Record<DebugTheme, DebugTheme> = {
  system: "light",
  light: "dark",
  dark: "system",
};
const ICON: Record<DebugTheme, typeof Monitor> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

export interface ThemeToggleProps {
  value: DebugTheme;
  onChange: (theme: DebugTheme) => void;
}

/** Cycles system → light → dark. Shown only when the host hasn't supplied a
 *  `theme` (i.e. the panel owns its own mode). */
export function ThemeToggle({ value, onChange }: ThemeToggleProps) {
  const Icon = ICON[value];
  return (
    <button
      className="tdbg-btn tdbg-icon-btn"
      onClick={() => onChange(NEXT[value])}
      title={`Theme: ${value} (click to change)`}
      aria-label={`Theme: ${value}`}
    >
      <Icon size={14} aria-hidden />
    </button>
  );
}
