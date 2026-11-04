import { cloneElement, useContext, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import type { IconName } from "../contract/ui-react-controls.js";
import { useControl } from "./effective-controls.js";
import { assetUrl, RendererContext } from "./renderer-context.js";

/** How one button is drawn, as a `ButtonDisplay` crosses the wire. */
export type ButtonSpec = { type: "text" } | { type: "icon"; icon: { digest: string; name: string } | null; label: "shown" | "hidden" };

interface DisplayedProps {
  display: ButtonSpec;
  /** The button's text: its content, or its accessible name and tooltip when drawn as a glyph alone. */
  text: string;
  /** The look's glyph for what the button does, drawn when the display names no file of its own. */
  glyph: IconName;
  /** The element drawn, given what goes inside it: an `a` or a `button` with its own attributes. */
  children: ReactElement<{ children?: ReactNode; "aria-label"?: string }>;
}

/**
 * A button of any element drawn as its display says: its text, a glyph beside
 * its text, or a glyph alone named to assistive technology and shown as a
 * tooltip. A glyph of the look's own is an `Icon`; a file of the page's is a
 * `glyph` part the look never mirrors.
 */
export function Displayed({ display, text, glyph, children }: DisplayedProps) {
  const environment = useContext(RendererContext);
  const Icon = useControl("Icon");
  const Tooltip = useControl("Tooltip");
  const [named, setNamed] = useState(false);
  if (display.type === "text") return cloneElement(children, { children: text });
  const drawn = display.icon ? (
    <span data-telo-part="glyph" aria-hidden="true" style={{ "--ui-react-glyph": `url(${JSON.stringify(assetUrl(environment, display.icon))})` } as CSSProperties} />
  ) : (
    <Icon name={glyph} />
  );
  if (display.label === "shown") {
    return cloneElement(children, {}, drawn, text);
  }
  return (
    <Tooltip open={named} label={text} onOpenChange={setNamed}>
      {cloneElement(children, { "aria-label": text, children: drawn })}
    </Tooltip>
  );
}
