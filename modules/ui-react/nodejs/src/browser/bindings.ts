export type Binding = { root: string; path: string[] } | { value: unknown };
export type Style = string | string[];

export interface StyleRule {
  by: Binding;
  cases: Record<string, Style>;
  default?: Style;
}

/** The value a binding names: its literal, or the path followed from its root.
 *  A step that is missing yields nothing. */
export function resolveBinding(binding: Binding, roots: Record<string, unknown>): unknown {
  if ("value" in binding) return binding.value;
  let current: any = roots[binding.root];
  for (const key of binding.path) current = current?.[key];
  return current;
}

/** The style a rule gives a row: the case keyed by the value's plain text,
 *  else the default. Null has no text, so it takes the default. */
export function ruleStyle(rule: StyleRule | undefined, roots: Record<string, unknown>): Style | undefined {
  if (!rule) return undefined;
  const value = resolveBinding(rule.by, roots);
  if (value === null || value === undefined) return rule.default;
  return rule.cases[String(value)] ?? rule.default;
}

/** `data-style`: the names, space-separated; absent when there are none. */
export function styleAttribute(...styles: (Style | undefined)[]): string | undefined {
  const names = [...new Set(styles.flat().filter((name): name is string => typeof name === "string"))];
  return names.length > 0 ? names.join(" ") : undefined;
}

const DATE = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });
const DATE_TIME = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

/** How a cell shows a value, from what the model says the value is. */
export function presentValue(value: unknown, present?: { type?: unknown; format?: unknown }): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "string" && (present?.format === "date" || present?.format === "date-time")) {
    const date = new Date(present.format === "date" ? `${value}T00:00:00Z` : value);
    if (!Number.isNaN(date.getTime())) return (present.format === "date" ? DATE : DATE_TIME).format(date);
  }
  return String(value);
}
