import { isAppRelative } from "./address-wire.js";
import type { SurfaceSpec } from "./surface.js";
import type { WireText } from "./texts.js";

/**
 * What every query key holding an opened page's address begins with. Tabs,
 * filter overlays and tab bars keep their own values under their own names in
 * the same space: an entry holds a page only where its value is an app-relative address.
 */
const PAGE_KEYS = "_telo.open.";

const holdsPage = (key: string, value: string): boolean => key.startsWith(PAGE_KEYS) && isAppRelative(value);

/** The query key the page open in the surface named `name` is kept under. */
export const pageKey = (name: string): string => `${PAGE_KEYS}${name}`;

const textOf = (query: URLSearchParams): string => {
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
};

/** The page keys a query holds, in query order: the surface each names and the value under it. */
export function pageEntries(search: string): { name: string; value: string }[] {
  return [...new URLSearchParams(search)].flatMap(([key, value]) => (holdsPage(key, value) ? [{ name: key.slice(PAGE_KEYS.length), value }] : []));
}

/** The query with every page key dropped, and — given one — the page `opened` names kept under its surface's name. */
export function withPage(search: string, opened?: { name: string; value: string }): string {
  const query = new URLSearchParams(search);
  for (const [key, value] of [...query]) if (holdsPage(key, value)) query.delete(key);
  if (opened) query.set(pageKey(opened.name), opened.value);
  return textOf(query);
}

/** The query with every page key dropped but the one under `kept`, which stays where it is. */
export function withOnlyPage(search: string, kept: string | undefined): string {
  const query = new URLSearchParams(search);
  for (const [key, value] of [...query]) if (holdsPage(key, value) && key !== (kept === undefined ? undefined : pageKey(kept))) query.delete(key);
  return textOf(query);
}

/** A destination opening a page, as the page document carries it. */
interface OpenPageWire {
  type: "openPage";
  surface: SurfaceSpec;
}

const isOpenPage = (value: Record<string, unknown>): value is Record<string, unknown> & OpenPageWire =>
  value.type === "openPage" && typeof value.surface === "object" && value.surface !== null && "href" in value;

/** Whether a member holds a text: a message with its language, or a key of a keyed set. */
const isWireText = (value: unknown): value is WireText =>
  value !== null && typeof value === "object" && ("message" in value || ("set" in value && "key" in value));

/** The surface a page under a name is restored into, and the text naming what declares it. */
export interface DeclaredSurface {
  surface: SurfaceSpec;
  /** The label or text of the nearest holder of the destination, where one holds one. */
  naming?: WireText;
  /** The document the destination is declared in, by its place in the list searched. */
  document: number;
  /**
   * What a page opened cold is placed against, known from the documents alone:
   * the nearest composite holding the declaration, for a panel; the declaring
   * node itself where it is the pressed element, for a popover and an inline
   * surface. Each is absent where a region binding `row` is in the way.
   */
  anchors: { composite?: object; pressed?: object };
}

/** The nodes a panel is drawn beside: the composites holding what is pressed. */
const COMPOSITE_TYPES = new Set(["listing", "split", "form", "filters", "chat"]);
/** The nodes whose own regions bind `row`. */
const ROW_TYPES = new Set(["listing", "list"]);
/** The nodes that are the element pressed when they hold a `to`, or a press. */
const PRESSED_TYPES = new Set(["link", "button", "box", "stack", "columns"]);

const typeOf = (node: object | undefined): string | undefined => (typeof (node as { type?: unknown } | undefined)?.type === "string" ? (node as { type: string }).type : undefined);

/** What the nodes above a declaration place a page against. */
function anchorsOf(path: readonly object[]): DeclaredSurface["anchors"] {
  const anchors: DeclaredSurface["anchors"] = {};
  const nodes = path.filter((each) => typeOf(each) !== undefined);
  // The composite is the nearest one holding the declaration, outside every row region.
  const at = nodes.findLastIndex((each) => COMPOSITE_TYPES.has(typeOf(each) as string));
  if (at >= 0 && !nodes.slice(0, at).some((each) => ROW_TYPES.has(typeOf(each) as string))) anchors.composite = nodes[at];
  // The declaring node is the pressed element: it holds the `to` itself (a link) or its press (a box, stack, columns, button).
  // A `button` node holds its call, which is no node of its own: the button is the pressed element.
  const holder = path[path.length - 1];
  const pressed = typeOf(holder) !== undefined ? holder : path[path.length - 2];
  if (pressed !== undefined && PRESSED_TYPES.has(typeOf(pressed) as string) && !nodes.some((each) => ROW_TYPES.has(typeOf(each) as string))) anchors.pressed = pressed;
  return anchors;
}

/**
 * The surface the first destination opening a page under `name` declares,
 * searching each document in turn, each in tree order: every member in the
 * order the document holds it, a node before what it holds.
 */
export function surfaceDeclaring(name: string, documents: readonly unknown[]): DeclaredSurface | undefined {
  const walk = (at: unknown, naming: WireText | undefined, document: number, path: readonly object[]): DeclaredSurface | undefined => {
    if (at === null || typeof at !== "object") return undefined;
    if (Array.isArray(at)) {
      for (const each of at) {
        const found = walk(each, naming, document, path);
        if (found) return found;
      }
      return undefined;
    }
    const held = at as Record<string, unknown>;
    if (isOpenPage(held)) return held.surface.address?.name === name ? { surface: held.surface, naming, document, anchors: anchorsOf(path) } : undefined;
    const own = isWireText(held.label) ? held.label : isWireText(held.text) ? held.text : naming;
    for (const child of Object.values(held)) {
      const found = walk(child, own, document, [...path, held]);
      if (found) return found;
    }
    return undefined;
  };
  for (const [index, document] of documents.entries()) {
    const found = walk(document, undefined, index, []);
    if (found) return found;
  }
  return undefined;
}

/** Whether two surfaces are one by value: the same members holding the same values, in any order. */
export function sameSurface(one: unknown, other: unknown): boolean {
  if (one === other) return true;
  if (one === null || other === null || typeof one !== "object" || typeof other !== "object") return false;
  if (Array.isArray(one) !== Array.isArray(other)) return false;
  const left = Object.entries(one as Record<string, unknown>).filter(([, value]) => value !== undefined);
  const right = Object.entries(other as Record<string, unknown>).filter(([, value]) => value !== undefined);
  if (left.length !== right.length) return false;
  const byKey = new Map(right);
  return left.every(([key, value]) => byKey.has(key) && sameSurface(value, byKey.get(key)));
}
