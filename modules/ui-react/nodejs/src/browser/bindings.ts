import type { Say } from "./texts.js";
import { holds, type JsonSchema, type Read } from "./validation.js";

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

/** What a binding reads: its literal, or what the path from its root reaches —
 *  nothing when a root or a step is missing. */
export function readBinding(binding: Binding, roots: Readonly<Record<string, unknown>>): Read {
  if ("value" in binding) return { present: true, value: binding.value };
  if (!Object.hasOwn(roots, binding.root)) return { present: false };
  let current: unknown = roots[binding.root];
  for (const key of binding.path) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) return { present: false };
    current = (current as Record<string, unknown>)[key];
  }
  return current === undefined ? { present: false } : { present: true, value: current };
}

/** A condition as the renderer receives it. */
export interface Condition {
  at: Binding;
  matches: JsonSchema;
}

/** Whether a condition holds over the roots in scope; none written holds. */
export function conditionHolds(condition: Condition | undefined, roots: Readonly<Record<string, unknown>>): boolean {
  return condition === undefined || holds(condition.matches, readBinding(condition.at, roots));
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
export function presentValue(value: unknown, present: { type?: unknown; format?: unknown } | undefined, say: Say): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return say(value ? "yes" : "no");
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "string" && (present?.format === "date" || present?.format === "date-time")) {
    const date = new Date(present.format === "date" ? `${value}T00:00:00Z` : value);
    if (!Number.isNaN(date.getTime())) return (present.format === "date" ? DATE : DATE_TIME).format(date);
  }
  return String(value);
}
