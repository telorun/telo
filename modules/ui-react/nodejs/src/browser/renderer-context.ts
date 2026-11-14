import { createContext } from "react";
import type { Param } from "./collection.js";

/** What every node of one rendered application shares. */
export interface RendererEnvironment {
  /** Mount path with no trailing slash; empty at the root. */
  prefix: string;
  /** Load a browser module by URL. */
  loadModule: (url: string) => Promise<Record<string, unknown>>;
  /** Whether the viewport is below the application's breakpoint. */
  compact: boolean;
  /** The paths of the pages the application declares. */
  pages: string[];
  /** The language the documents are in; `und` when they declare none. */
  lang: string;
}

export const RendererContext = createContext<RendererEnvironment>({
  prefix: "",
  loadModule: (url) => import(/* @vite-ignore */ url),
  compact: false,
  pages: [],
  lang: "und",
});

/** The values the roots of a data scope hold — `data`, `query`, `error`,
 *  `row`, `values` — by name, for the bindings drawn beneath. */
export const RootsContext = createContext<Readonly<Record<string, unknown>>>({});

/** Where a tab bar is drawn: the bottom edge of the application, whatever region its navbar stands in. */
export const BottomSlotContext = createContext<HTMLElement | null>(null);

/** Whether what is drawn here is shown. Hidden content keeps its state and
 *  starts no request until it is shown. */
export const VisibleContext = createContext(true);

/** Whether the node drawn next is the direct content of a flush split view, whose frame it then does not draw itself. */
export const EmbeddedContext = createContext(false);

/** The row a table cell is drawn for; absent everywhere else. */
export const RowContext = createContext<Record<string, unknown> | undefined>(undefined);

/** Whether a link drawn here leads from a record's own content (a layout's content, a column's value), not from a relation's label, an action's answer or a form. */
export const RecordLinkContext = createContext(false);

const NO_FILTERS: Param[] = [];

/** The filters every table inside a filter bar obeys. */
export const FilterContext = createContext<Param[]>(NO_FILTERS);

/** The URL an app-relative path is requested at: under the mount. Any other
 *  reference is requested as written. */
export function underMount(prefix: string, path: string): string {
  return path.startsWith("/") ? prefix + path : path;
}

export function assetUrl(environment: RendererEnvironment, asset: { digest: string; name: string }): string {
  return `${environment.prefix}/_telo/ui/assets/${asset.digest}/${asset.name}`;
}
