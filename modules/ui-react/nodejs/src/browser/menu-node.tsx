import { useContext, useState, type ReactNode } from "react";
import { conditionHolds, styleAttribute, type Condition, type Style } from "./bindings.js";
import { useControl } from "./effective-controls.js";
import { useHost, useHostStore } from "./host.js";
import { linkAddress, pageAddress } from "./link-address.js";
import { ErrorNode, type SpecNode } from "./nodes.js";
import { RendererContext, RootsContext } from "./renderer-context.js";
import { useSay, useText, type WireText } from "./texts.js";

interface MenuLink {
  text: WireText;
  href: string;
  style?: Style;
  shown?: Condition;
}

/** The key of the menu's one group; its links are keyed by their index. */
const GROUP = "menu";

/**
 * A `menu` node: one group of links drawn by the `Navigation` control, a
 * disclosure that is no landmark. An item is offered while its `shown` holds;
 * following one moves within the application to one of its pages, and loads
 * anything else. An item whose style holds `strong` is the current choice. An
 * item whose address is not one a link may hold makes the menu an error node.
 */
export function MenuNode({ node }: { node: SpecNode }): ReactNode {
  const store = useHostStore();
  const host = useHost();
  const { prefix, pages } = useContext(RendererContext);
  const roots = useContext(RootsContext);
  const text = useText();
  const say = useSay();
  const Navigation = useControl("Navigation");
  const [open, setOpen] = useState<string[]>([]);
  const links = node.items as MenuLink[];
  const addresses = links.map((link) => linkAddress(store, link.href));
  const failing = links.find((_, index) => addresses[index] === undefined);
  if (failing) {
    return (
      <ErrorNode
        error={{
          type: "error",
          code: "ERR_UI_NODE_INVALID",
          message: `A 'menu' node's item href '${failing.href}' does not resolve inside this application.`,
        }}
      />
    );
  }
  const offered = links.flatMap((link, index) => (link.shown === undefined || conditionHolds(link.shown, roots) ? [{ link, index }] : []));
  if (offered.length === 0) return null;
  const follow = (key: string) => {
    const href = addresses[Number(key)] as string;
    const to = pageAddress(prefix, pages, href);
    if (to === undefined) store.leave(href);
    else host.navigate(to);
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
            ...([link.style ?? []].flat().includes("strong") ? { current: "true" as const } : {}),
          })),
        },
      ]}
      more={{ key: "more", label: say("more") }}
      open={open}
      onOpenChange={setOpen}
      onChange={follow}
      {...(style === undefined ? {} : { attributes: { "data-style": style } })}
    />
  );
}
