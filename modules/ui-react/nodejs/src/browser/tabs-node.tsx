import { useState, type ReactNode } from "react";
import { useControl } from "./effective-controls.js";
import { useHost, useHostStore } from "./host.js";
import { Nodes, type SpecNode } from "./nodes.js";
import { openValue } from "./open-address.js";
import { useText, type WireText } from "./texts.js";

interface Tab {
  /** The slug of the source text the tab was written with. */
  key: string;
  text: WireText;
  children: SpecNode[];
}

/**
 * A `tabs` node: its tabs drawn by the `Tabs` control, each by its key, and
 * the chosen tab's children in its panel — another tab's are drawn anew when
 * it is chosen. With an address, the chosen tab is in the page's address under
 * its name, as an open surface is: the first choice adds a history entry and
 * later ones take it; without one, it is held in memory. The first tab is
 * chosen while nothing else is.
 */
export function TabsNode({ node }: { node: SpecNode }): ReactNode {
  const store = useHostStore();
  const host = useHost();
  const text = useText();
  const Tabs = useControl("Tabs");
  const [held, setHeld] = useState<string>();
  const tabs = node.tabs as Tab[];
  const address = (node.address as { name: string } | undefined)?.name;
  const asked = address === undefined ? held : openValue(host.location.search, address);
  // An address naming no tab of this node chooses the first.
  const chosen = tabs.find((tab) => tab.key === asked) ?? tabs[0];
  return (
    <Tabs
      tabs={tabs.map((tab) => ({ key: tab.key, label: text(tab.text) }))}
      value={chosen.key}
      onChange={(key) => (address === undefined ? setHeld(key) : store.open(address, key, [address]))}
    >
      <Nodes key={chosen.key} nodes={chosen.children} />
    </Tabs>
  );
}
