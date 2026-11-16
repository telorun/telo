import { useContext, type ReactNode } from "react";
import { CurrentAnchor } from "./current-location.js";
import { presentValue } from "./bindings.js";
import { DestinationAnchor, type ResolvedDestination } from "./destination.js";
import { useHostStore } from "./host.js";
import { applicationPath, linkAddress } from "./link-address.js";
import { matchPage } from "./page-route.js";
import { RecordLinkContext, RendererContext } from "./renderer-context.js";
import { labelFor, useSay, useText, type ValueLabel } from "./texts.js";

interface PresentedProps {
  value: unknown;
  /** What the model says the value is. */
  present?: { type?: unknown; format?: unknown };
  /** What each value the model labels is shown as. */
  labels?: readonly ValueLabel[];
  /** Drawn for a link in place of its address. */
  text?: string;
  /** Where the value leads, already resolved; nothing links without one
   *  unless the model calls the value an address. */
  to?: ResolvedDestination;
}

/** The address a value links to: the one it was given, else its own text where the model calls it an address and no label stands for it. */
export function presentedAddress(value: unknown, present: PresentedProps["present"], labels: readonly ValueLabel[] | undefined, given?: string): string | undefined {
  return given ?? (typeof value === "string" && (present?.format === "uri" || present?.format === "uri-reference") && !labelFor(labels, value) ? value : undefined);
}

/**
 * A value as a cell shows it. A string the model calls an address is a link
 * to it, where it is an address a link may hold, and plain text otherwise. A
 * link to a page of the application moves within it; any other — a file the
 * origin serves, another site — opens beside the application.
 */
export function Presented({ value, present, labels, text, to }: PresentedProps): ReactNode {
  const format = useText();
  const say = useSay();
  const label = labelFor(labels, value);
  const shown = label ? format(label) : presentValue(value, present, say);
  const drawn = text ?? shown;
  return (
    <ValueLink address={presentedAddress(value, present, labels, to?.address)} to={to} plain={shown} naming={drawn}>
      {drawn}
    </ValueLink>
  );
}

/**
 * A link drawing `children` — to the destination `to`, else to `address` —
 * where its address is one a link may hold; `plain` otherwise, else
 * `children`. A click on a destination's link goes to the destination;
 * `naming` is the text the link is drawn with.
 */
export function ValueLink({
  address,
  to,
  plain,
  naming,
  children,
}: {
  address?: string;
  to?: ResolvedDestination;
  plain?: ReactNode;
  naming: string;
  children: ReactNode;
}): ReactNode {
  const store = useHostStore();
  const { prefix, pages } = useContext(RendererContext);
  const ofRecord = useContext(RecordLinkContext);
  const at = to?.address ?? address;
  const href = at === undefined ? undefined : linkAddress(store, at);
  if (href === undefined) return plain ?? children;
  const path = at?.startsWith("/") ? applicationPath(prefix, href) : undefined;
  const page = path !== undefined && matchPage(pages, path) !== undefined;
  const attributes = { "data-telo-part": "link", "data-record": ofRecord ? "true" : undefined, target: page ? undefined : "_blank", rel: page ? undefined : "noopener" };
  if (to !== undefined) {
    return (
      <DestinationAnchor destination={to} href={href} naming={naming} {...attributes}>
        {children}
      </DestinationAnchor>
    );
  }
  return (
    <CurrentAnchor lead={at === undefined ? undefined : { type: "navigate", address: at }} href={href} {...attributes}>
      {children}
    </CurrentAnchor>
  );
}
