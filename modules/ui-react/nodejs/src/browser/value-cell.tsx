import { useContext, type ReactNode } from "react";
import { CurrentAnchor } from "./current-location.js";
import { presentValue } from "./bindings.js";
import { useHostStore } from "./host.js";
import { applicationPath, linkAddress } from "./link-address.js";
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
  /** Where the value links to, already resolved; nothing links without one
   *  unless the model calls the value an address. */
  href?: string;
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
export function Presented({ value, present, labels, text, href: given }: PresentedProps): ReactNode {
  const store = useHostStore();
  const { prefix, pages } = useContext(RendererContext);
  const ofRecord = useContext(RecordLinkContext);
  const format = useText();
  const say = useSay();
  const label = labelFor(labels, value);
  const shown = label ? format(label) : presentValue(value, present, say);
  const address = presentedAddress(value, present, labels, given);
  const href = address === undefined ? undefined : linkAddress(store, address);
  if (href === undefined) return shown;
  const path = address?.startsWith("/") ? applicationPath(prefix, href) : undefined;
  const page = path !== undefined && pages.includes(path);
  return (
    <CurrentAnchor address={address} data-telo-part="link" data-record={ofRecord ? "true" : undefined} href={href} target={page ? undefined : "_blank"} rel={page ? undefined : "noopener"}>
      {text ?? shown}
    </CurrentAnchor>
  );
}
