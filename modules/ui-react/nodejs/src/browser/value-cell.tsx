import { useContext, type ReactNode } from "react";
import { presentValue } from "./bindings.js";
import { useHostStore } from "./host.js";
import { applicationPath, linkAddress } from "./link-address.js";
import { RendererContext } from "./renderer-context.js";

interface PresentedProps {
  value: unknown;
  /** What the model says the value is. */
  present?: { type?: unknown; format?: unknown };
}

/**
 * A value as a cell shows it. A string the model calls an address is a link
 * to it, where it is an address a link may hold, and plain text otherwise. A
 * link to a page of the application moves within it; any other — a file the
 * origin serves, another site — opens beside the application.
 */
export function Presented({ value, present }: PresentedProps): ReactNode {
  const store = useHostStore();
  const { prefix, pages } = useContext(RendererContext);
  if (typeof value === "string" && (present?.format === "uri" || present?.format === "uri-reference")) {
    const href = linkAddress(store, value);
    if (href !== undefined) {
      const path = value.startsWith("/") ? applicationPath(prefix, href) : undefined;
      const page = path !== undefined && pages.includes(path);
      return (
        <a data-telo-part="link" href={href} target={page ? undefined : "_blank"} rel={page ? undefined : "noopener"}>
          {value}
        </a>
      );
    }
  }
  return presentValue(value, present);
}
