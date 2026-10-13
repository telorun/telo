import type * as React from "react";

import { cn } from "@/lib/utils";
import { moduleDisplayName } from "@/module-ref";

/** A stable hue for a string, so one category always wears one colour. */
export function hueOf(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.codePointAt(0)!) % 360;
  return hash;
}

/** The first two letters or digits of a name: `HttpServer` → `Ht`. */
function monogram(name: string): string {
  const letters = Array.from(name.replace(/[^\p{L}\p{N}]/gu, "")).slice(0, 2);
  if (letters.length === 0) return "?";
  return letters[0].toUpperCase() + (letters[1] ?? "").toLowerCase();
}

/** A module's monogram tile. Its hue is the module's first category's, falling
 *  back to its own name, so a category reads as one colour down a list without
 *  this app knowing which categories exist. */
export function ModuleAvatar({
  module,
  className,
}: {
  module: { name?: string; ref: string; categories?: { slug: string }[] };
  className?: string;
}) {
  const name = moduleDisplayName(module);
  return (
    <span
      aria-hidden
      style={{ "--h": hueOf(module.categories?.[0]?.slug ?? name) } as React.CSSProperties}
      className={cn(
        "module-avatar flex size-10 shrink-0 items-center justify-center rounded-lg text-sm font-semibold tracking-tight select-none",
        className,
      )}
    >
      {monogram(name)}
    </span>
  );
}
