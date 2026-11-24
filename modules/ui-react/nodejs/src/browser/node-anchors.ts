/**
 * The element each node of a page document is drawn as, for the nodes a page
 * opened cold is placed against: a composite a panel sits beside, a pressed
 * node a popover is anchored to or an inline surface follows. A node that is
 * not mounted has none.
 */
const elements = new WeakMap<object, HTMLElement>();

/** The ref callback registering a node's element while it is drawn. */
export const anchorRef = (node: object) => (element: HTMLElement | null) => {
  if (element) elements.set(node, element);
  else elements.delete(node);
};

/** The element a node is drawn as now, when it is on screen. */
export const anchorOf = (node: object): HTMLElement | null => {
  const element = elements.get(node);
  return element?.isConnected ? element : null;
};
