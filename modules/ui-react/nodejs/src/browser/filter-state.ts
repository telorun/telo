import { filterParam, type Operator, type Param } from "./collection.js";
import { FILTER_KEYS } from "./open-address.js";
import { plainTypes, type JsonSchema } from "./validation.js";

type Scalar = string | number | boolean;

export type Control = "auto" | "select" | "options" | "toggle" | "slider" | "tags" | "none";

export interface FilterField {
  property: string;
  operator: Operator;
  label: string;
  schema: JsonSchema;
  /** Kept outside whatever the bar folds into, and never removable. */
  pinned: boolean;
  control: Control;
  default?: Scalar[];
}

export interface FilterPreset {
  label: string;
  values: { property: string; operator: Operator; value: Scalar[] }[];
}

/**
 * What a bar's filters hold, by filter. A filter that is not in it holds its
 * nothing and was never touched; one in it with no values is on show holding
 * nothing, or had a default the user cleared.
 */
export type Values = Record<string, string[]>;

/** A filter's name in a bar's state: its property, with its operator unless it is `eq`. */
export const filterKey = (filter: { property: string; operator: Operator }): string =>
  filter.operator === "eq" ? filter.property : `${filter.property}.${filter.operator}`;

/** Whether a filter can hold a value, by its property's type and listed values. */
function holds(field: FilterField, value: string): boolean {
  if (value === "") return false;
  // A switch is on or holds nothing.
  if (field.control === "toggle" && value === "false") return false;
  const listed = Array.isArray(field.schema.enum) && (field.operator === "eq" || field.operator === "in");
  if (listed && !field.schema.enum.some((allowed: unknown) => String(allowed) === value)) return false;
  const declared = plainTypes(field.schema);
  if (declared.length !== 1) return true;
  if (declared[0] === "boolean") return value === "true" || value === "false";
  if (declared[0] === "integer") return Number.isInteger(Number(value));
  if (declared[0] === "number") return Number.isFinite(Number(value));
  return true;
}

/**
 * Values read from outside the page, held to what the bar declares: an entry
 * for a filter it does not show, or holding a value the filter cannot, is
 * dropped. `dropped` says whether anything was.
 */
export function admitted(fields: FilterField[], read: unknown): { values: Values; dropped: boolean } {
  const values: Values = {};
  let dropped = false;
  for (const [key, held] of Object.entries((read ?? {}) as Record<string, unknown>)) {
    const field = fields.find((candidate) => filterKey(candidate) === key);
    const fits =
      field !== undefined &&
      Array.isArray(held) &&
      (held.length <= 1 || field.operator === "in") &&
      held.every((value) => typeof value === "string" && holds(field, value));
    if (fits) values[key] = held as string[];
    else dropped = true;
  }
  return { values, dropped };
}

/** What every filter holds before the user changes anything. */
export function declaredDefaults(fields: FilterField[]): Values {
  const values: Values = {};
  for (const field of fields) if (field.default) values[filterKey(field)] = field.default.map(String);
  return values;
}

/** The parameters a bar's values send. */
export function paramsOf(fields: FilterField[], values: Values): Param[] {
  return fields.flatMap((field) =>
    (values[filterKey(field)] ?? [])
      .map((value) => value.trim())
      .filter((value) => value !== "")
      .map((value) => filterParam(field.property, field.operator, value)),
  );
}

export const sameValues = (one: Values, other: Values): boolean => {
  const text = (values: Values) => JSON.stringify(Object.keys(values).sort().map((key) => [key, values[key]]));
  return text(one) === text(other);
};

/** How many of the filters the bar draws hold a value. */
export const activeCount = (fields: FilterField[], values: Values): number =>
  fields.filter((field) => field.control !== "none" && (values[filterKey(field)] ?? []).length > 0).length;

/** The filters the presets name between them. */
const presetKeys = (presets: FilterPreset[]): string[] => [...new Set(presets.flatMap((preset) => preset.values.map(filterKey)))];

/** A bar's values with a preset chosen: the filters the presets name between
 *  them set to what this one says — or cleared — and the rest as they were. */
export function withPreset(presets: FilterPreset[], chosen: FilterPreset, values: Values): Values {
  const next = { ...values };
  for (const key of presetKeys(presets)) next[key] = [];
  for (const entry of chosen.values) next[filterKey(entry)] = entry.value.map(String);
  return next;
}

/** The first preset the bar's values are exactly; none when they are no preset's. */
export function activePreset(presets: FilterPreset[], values: Values): number {
  const keys = presetKeys(presets);
  const held = (from: Values) => JSON.stringify(keys.map((key) => from[key] ?? []));
  return presets.findIndex((preset) => held(withPreset(presets, preset, {})) === held(values));
}

/* ----------------------------------------------------------------- address */

const addressKey = (stateKey: string, field: FilterField) => `${FILTER_KEYS}${stateKey}.${filterKey(field)}`;

/** A bar's values as the address carries them; nothing when it carries none of
 *  the bar's keys. A key is matched whole against a declared filter. */
export function readAddress(search: string, stateKey: string, fields: FilterField[]): Values | undefined {
  const query = new URLSearchParams(search);
  const read: Values = {};
  for (const field of fields) {
    const key = addressKey(stateKey, field);
    if (query.has(key)) read[filterKey(field)] = query.getAll(key).filter((value) => value !== "");
  }
  return Object.keys(read).length === 0 ? undefined : admitted(fields, read).values;
}

/** The query string with the bar's values written into it: a key per value,
 *  and one empty key for a filter holding none. */
export function writeAddress(search: string, stateKey: string, fields: FilterField[], values: Values): string {
  const query = new URLSearchParams(search);
  for (const field of fields) {
    const key = addressKey(stateKey, field);
    query.delete(key);
    const held = values[filterKey(field)];
    if (!held) continue;
    if (held.length === 0) query.append(key, "");
    for (const value of held) query.append(key, value);
  }
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
}

/* ----------------------------------------------------------------- storage */

const VERSION = 1;

export interface Stored {
  values: Values;
  /** The fold of a collapsible bar: as its placement declares it until the
   *  viewer folds or unfolds it, their choice from then on. */
  open?: boolean;
}

/** The storage key of a bar's state: scoped by where the application is
 *  mounted, so two applications on one origin keep theirs apart. */
export const storageKey = (mount: string, stateKey: string): string => `telo.ui:${mount === "" ? "/" : mount}:f:${stateKey}`;

const refused = new Set<string>();

/** Say, once per kind of storage, that the browser refuses it. */
function reportRefused(type: "local" | "session", error: unknown): void {
  if (refused.has(type)) return;
  refused.add(type);
  console.error(`The browser refuses ${type} storage, so filters are kept in memory: ${error instanceof Error ? error.message : String(error)}`);
}

/** The browser's storage of a kind, or nothing — said once — where the browser
 *  refuses it. */
export function browserStorage(type: "local" | "session"): Storage | undefined {
  try {
    const storage = type === "local" ? window.localStorage : window.sessionStorage;
    // A browser may hand the object over and refuse every use of it.
    storage.getItem("telo.ui");
    return storage;
  } catch (error) {
    reportRefused(type, error);
    return undefined;
  }
}

/** What a store holds for a bar, held to what the bar declares. `stale` says
 *  the entry held something it should not, and is to be rewritten. */
export function readStore(storage: Storage, key: string, fields: FilterField[]): { stored?: Stored; stale: boolean } {
  const text = storage.getItem(key);
  if (text === null) return { stale: false };
  let entry: { v?: unknown; values?: unknown; open?: unknown };
  try {
    entry = JSON.parse(text);
  } catch {
    // Not an entry this renderer wrote: it is discarded.
    return { stale: true };
  }
  if (entry === null || typeof entry !== "object" || entry.v !== VERSION) return { stale: true };
  const { values, dropped } = admitted(fields, entry.values);
  return { stored: { values, ...(typeof entry.open === "boolean" ? { open: entry.open } : {}) }, stale: dropped };
}

/** Write a bar's entry. A store may be read and still take nothing — a full
 *  quota, a private mode: that is said once, and answered with `false`. */
export function writeStore(storage: Storage, type: "local" | "session", key: string, stored: Required<Stored>): boolean {
  try {
    storage.setItem(key, JSON.stringify({ v: VERSION, values: stored.values, open: stored.open }));
    return true;
  } catch (error) {
    reportRefused(type, error);
    return false;
  }
}
