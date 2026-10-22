import { autoUpdate, flip, offset, shift, size, useFloating, type Placement } from "@floating-ui/react-dom";
import type { CSSProperties } from "react";

/** A side as the page places it: `start` and `end` follow the text direction. */
export type PlacedSide = "start" | "end" | "top" | "bottom";

function placementOf(side: PlacedSide, align: "start" | "center" | "end"): Placement {
  const rightToLeft = document.documentElement.dir === "rtl";
  const physical = side === "top" || side === "bottom" ? side : (side === "start") !== rightToLeft ? "left" : "right";
  return (align === "center" ? physical : `${physical}-${align}`) as Placement;
}

/**
 * Where a layer is placed against what it opens from: beside it, flipped and
 * shifted to stay in the viewport. The placement's own values — the anchor's
 * width, the height left in the viewport, the corner it grows from — are set
 * on the layer as `--ui-react-control-anchor-width`, `--ui-react-control-available-height`
 * and `--ui-react-control-origin` for its mechanics to read.
 */
export function usePlacement(anchor: Element | null, side: PlacedSide, align: "start" | "center" | "end", gap: number) {
  const placement = placementOf(side, align);
  const { refs, floatingStyles, placement: placed } = useFloating({
    placement,
    strategy: "fixed",
    transform: false,
    elements: { reference: anchor },
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(gap),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, rects, elements }) {
          elements.floating.style.setProperty("--ui-react-control-anchor-width", `${rects.reference.width}px`);
          elements.floating.style.setProperty("--ui-react-control-available-height", `${Math.max(0, availableHeight)}px`);
        },
      }),
    ],
  });
  const [placedSide, placedAlign] = placed.split("-");
  const along = (start: string, end: string) => (placedAlign === "start" ? start : placedAlign === "end" ? end : "center");
  const origin =
    placedSide === "top" ? `${along("left", "right")} bottom`
    : placedSide === "bottom" ? `${along("left", "right")} top`
    : placedSide === "left" ? `right ${along("top", "bottom")}`
    : `left ${along("top", "bottom")}`;
  const style = { ...floatingStyles, "--ui-react-control-origin": origin } as CSSProperties;
  return { setFloating: refs.setFloating, style };
}
