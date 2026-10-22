import { useContext, useState, type ReactNode } from "react";
import { conditionHolds, styleAttribute, type Condition, type Style } from "./bindings.js";
import { useControl } from "./effective-controls.js";
import { useHost, useHostStore } from "./host.js";
import { linkAddress, pageAddress } from "./link-address.js";
import { ErrorNode, type SpecNode } from "./nodes.js";
import { RendererContext, RootsContext } from "./renderer-context.js";
import { useText, type WireText } from "./texts.js";

interface MenuLink {
  text: WireText;
  href: string;
  style?: Style;
  shown?: Condition;
}

/**
 * A `menu` node: a button opening its links through the `Menu` control. An
 * item is offered while its `shown` holds; choosing one follows its address as
 * clicking the link would — one of the application's pages within it, anything
 * else by a load. An item whose style holds `strong` is the current choice. An
 * item whose address is not one a link may hold makes the menu an error node.
 */
export function MenuNode({ node }: { node: SpecNode }): ReactNode {
  const store = useHostStore();
  const host = useHost();
  const { prefix, pages } = useContext(RendererContext);
  const roots = useContext(RootsContext);
  const text = useText();
  const Menu = useControl("Menu");
  const Icon = useControl("Icon");
  const [open, setOpen] = useState(false);
  const links = node.items as MenuLink[];
  const failing = links.find((link) => linkAddress(store, link.href) === undefined);
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
  const offered = links.flatMap((link, index) =>
    link.shown === undefined || conditionHolds(link.shown, roots) ? [{ link, key: String(index) }] : [],
  );
  if (offered.length === 0) return null;
  const choose = (key: string) => {
    const href = linkAddress(store, links[Number(key)].href) as string;
    const to = pageAddress(prefix, pages, href);
    if (to === undefined) store.leave(href);
    else host.navigate(to);
  };
  return (
    <Menu
      open={open}
      items={offered.map(({ link, key }) => ({
        key,
        label: text(link.text),
        ...([link.style ?? []].flat().includes("strong") ? { current: true } : {}),
      }))}
      onOpenChange={setOpen}
      onChange={choose}
    >
      <button type="button" data-telo-part="menu-trigger" data-style={styleAttribute(node.style)}>
        {text(node.text)}
        <Icon name="next" />
      </button>
    </Menu>
  );
}
