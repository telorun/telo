import type { Style } from "./composite.js";

/** What an accessor field arrives as: a path from a named root, or a literal. */
export type Binding = { root: string; path: string[] } | { value: unknown };

export interface StyleRule {
  by: Binding;
  cases: Record<string, Style>;
  default?: Style;
}

export function isChain(binding: Binding): binding is { root: string; path: string[] } {
  return !("value" in binding);
}
