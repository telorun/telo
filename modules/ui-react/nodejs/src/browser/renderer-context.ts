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
}

export const RendererContext = createContext<RendererEnvironment>({
  prefix: "",
  loadModule: (url) => import(/* @vite-ignore */ url),
  compact: false,
});

/** The row a table cell is drawn for; absent everywhere else. */
export const RowContext = createContext<Record<string, unknown> | undefined>(undefined);

const NO_FILTERS: Param[] = [];

/** The filters every table inside a filter bar obeys. */
export const FilterContext = createContext<Param[]>(NO_FILTERS);

export function assetUrl(environment: RendererEnvironment, asset: { digest: string; name: string }): string {
  return `${environment.prefix}/_telo/ui/assets/${asset.digest}/${asset.name}`;
}
