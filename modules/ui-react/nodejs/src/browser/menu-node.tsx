import { useContext, useState, type ReactNode } from "react";
import { conditionHolds, styleAttribute, type Condition, type Style } from "./bindings.js";
import { useLeadsHere } from "./current-location.js";
import { leadOf, openDestination, resolveDestination, useDestinationContext, type DestinationWire } from "./destination.js";
import { useControl } from "./effective-controls.js";
import { linkAddress } from "./link-address.js";
import { type SpecNode } from "./nodes.js";
import { RootsContext } from "./renderer-context.js";
import { useSay, useText, type WireText } from "./texts.js";

interface MenuLink {
  text: WireText;
  to: DestinationWire;
  style?: Style;
  shown?: Condition;
}

/** The key of the menu's one group; its links are keyed by their index. */
const GROUP = "menu";

/**
 * A `menu` node: one group of links drawn by the `Navigation` control, a
 * disclosure that is no landmark. An item is offered while its `shown` holds;
 * following one goes to its destination. An item is the current choice when its destination leads to where the viewer is, or its style holds `strong`. An
 * item whose address is not one a link may hold makes the menu an error node.
 */
export function MenuNode({ node }: { node: SpecNode }): ReactNode {
  const here = useLeadsHere();
  const context = useDestinationContext();
  const roots = useContext(RootsContext);
  const text = useText();
  const say = useSay();
  const Navigation = useControl("Navigation");
  const [open, setOpen] = useState<string[]>([]);
  const links = node.items as MenuLink[];
  // An item whose address does not resolve is left out.
  const expanded = links.map((link) => resolveDestination(link.to, roots, "'menu' item to"));
  const addresses = expanded.map((resolved) => (resolved === undefined ? undefined : linkAddress(context.store, resolved.address)));
  const offered = links.flatMap((link, index) => (addresses[index] !== undefined && (link.shown === undefined || conditionHolds(link.shown, roots)) ? [{ link, index }] : []));
  if (offered.length === 0) return null;
  const follow = (key: string) => {
    const index = Number(key);
    const destination = expanded[index];
    if (destination !== undefined) openDestination(destination.to, { ...context, address: destination.address }, { naming: text(links[index].text) });
  };
  const style = styleAttribute(node.style);
  return (
    <Navigation
      layout="horizontal"
      items={[
        {
          key: GROUP,
          label: text(node.text),
          items: offered.map(({ link, index }) => ({
            key: String(index),
            label: text(link.text),
            href: addresses[index] as string,
            ...(here(expanded[index] && leadOf(expanded[index]))
              ? { current: "page" as const }
              : [link.style ?? []].flat().includes("strong")
                ? { current: "true" as const }
                : {}),
          })),
        },
      ]}
      more={{ key: "more", label: say("more") }}
      open={open}
      onOpenChange={setOpen}
      onChange={follow}
      {...(style === undefined && node.fill !== true ? {} : { attributes: { ...(style === undefined ? {} : { "data-style": style }), ...(node.fill === true ? { "data-fill": "true" } : {}) } })}
    />
  );
}
