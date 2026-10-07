import type { LucideIcon } from "lucide-react";

/** A decorative icon, as the part every icon is. */
export function Icon({ of: Glyph }: { of: LucideIcon }) {
  return <Glyph data-telo-part="icon" aria-hidden="true" focusable="false" />;
}
