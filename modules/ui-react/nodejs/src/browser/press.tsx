import { useContext, type ReactNode } from "react";
import { DestinationAnchor, DetailContext, resolveDestination, type DestinationWire } from "./destination.js";
import { useHostStore } from "./host.js";
import { linkAddress } from "./link-address.js";
import { RootsContext } from "./renderer-context.js";
import { useText, type WireText } from "./texts.js";

/** What pressing a region or a record does, as the page document carries it: where it goes, and the text naming it. */
export interface PressSpec {
  to: DestinationWire;
  label: WireText;
}

/**
 * The element a press is drawn as: a real link to the destination's address,
 * named exactly by the press's label over the roots in scope. Its owner draws
 * it as the first child of the element it covers, which the renderer's base
 * layer stretches it across. Nothing is drawn when the address does not
 * resolve, or is not one a link may hold.
 */
export function Press({ press, roots }: { press: PressSpec; roots?: Readonly<Record<string, unknown>> }): ReactNode {
  const store = useHostStore();
  const scope = useContext(RootsContext);
  const text = useText();
  const detailOf = useContext(DetailContext);
  const over = roots ?? scope;
  const destination = resolveDestination(press.to, over, "'press' to");
  const href = destination === undefined ? undefined : linkAddress(store, destination.address);
  if (destination === undefined || href === undefined) return null;
  const label = text(press.label, undefined, over);
  const row = over.row;
  const detail = detailOf !== null && row !== null && typeof row === "object" ? detailOf(row as Record<string, unknown>) : undefined;
  return <DestinationAnchor destination={destination} href={href} naming={label} detail={detail} data-telo-part="press" aria-label={label} />;
}
