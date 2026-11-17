import { createContext, useContext, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { isCurrentAddress, type CurrentLocation } from "./address-wire.js";
import { useHost } from "./host.js";

/** Where the viewer is: the application's location, and the address of the page open in a surface over it. */
export interface Viewer {
  location: CurrentLocation;
  opened?: CurrentLocation;
}

/** Where the viewer is, as the application shell says; absent outside one. */
export const ViewerContext = createContext<Viewer | null>(null);

/** Where something leads: a destination's kind and the address it resolved to. */
export interface Lead {
  type: "navigate" | "openPage";
  address: string;
}

/**
 * Whether going somewhere leads to where the viewer is: an address moved to
 * leads there while it is the application's location, a page opened in a
 * surface while it is the open page's — `_telo*` parameters set aside.
 */
export function leadsHere(lead: Lead, viewer: Viewer): boolean {
  if (lead.type === "openPage") return viewer.opened !== undefined && isCurrentAddress(lead.address, viewer.opened);
  return isCurrentAddress(lead.address, viewer.location);
}

/** Where the viewer is now: the shell's say, else the location the host holds. */
export function useViewer(): Viewer {
  const viewer = useContext(ViewerContext);
  const { location } = useHost();
  return viewer ?? { location };
}

/** The test a link draws its `aria-current` by, over where the viewer is now. */
export function useLeadsHere(): (lead: Lead | undefined) => boolean {
  const viewer = useViewer();
  return (lead) => lead !== undefined && leadsHere(lead, viewer);
}

/** A link the renderer draws: `aria-current="page"` while `lead` leads to where the viewer is. */
export function CurrentAnchor({ lead, ...rest }: { lead: Lead | undefined } & ComponentPropsWithoutRef<"a">): ReactNode {
  const current = useLeadsHere()(lead);
  return <a {...rest} aria-current={current ? "page" : undefined} />;
}
