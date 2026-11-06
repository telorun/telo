import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { isCurrentAddress } from "./address-wire.js";
import { useHost } from "./host.js";

/** The test a link draws its `aria-current` by, over the location the viewer is at now. */
export function useCurrentAddress(): (address: string | undefined) => boolean {
  const { location } = useHost();
  return (address) => address !== undefined && isCurrentAddress(address, location);
}

/** A link the renderer draws: `aria-current="page"` while `address` leads to where the viewer is. */
export function CurrentAnchor({ address, ...rest }: { address: string | undefined } & ComponentPropsWithoutRef<"a">): ReactNode {
  const current = useCurrentAddress()(address);
  return <a {...rest} aria-current={current ? "page" : undefined} />;
}
