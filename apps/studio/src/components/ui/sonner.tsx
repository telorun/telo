import type { CSSProperties } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

import { useColorMode } from "@/theme/color-mode";

/** Sonner's toaster, bridged to the editor's own color mode rather than
 *  `next-themes` (which shadcn's stock wrapper assumes and this app does not
 *  use). Colors come from the same CSS variables every other primitive reads,
 *  so a toast matches the surface it appears over in both modes. */
function Toaster({ ...props }: ToasterProps) {
  const mode = useColorMode();

  return (
    <Sonner
      theme={mode}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
