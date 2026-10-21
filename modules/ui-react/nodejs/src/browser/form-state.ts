import { browserStorage } from "./filter-state.js";
import { validate, type JsonSchema } from "./validation.js";

/** Where a form's or an action's values are kept, as the page document says. */
export interface KeptState {
  key?: string;
  address: boolean;
  store: { type: "memory" | "local" | "session" };
  fields: string[];
}

/** What every query key holding a form's or an action's values begins with —
 *  spelled apart from a filter bar's `_telo.f.`, so the two never read each
 *  other's entries under one key. */
export const VALUE_KEYS = "_telo.v.";

const VERSION = 1;

/** The storage key of a form's values, scoped by where the application is mounted. */
export const valueStorageKey = (mount: string, key: string): string => `telo.ui:${mount === "" ? "/" : mount}:v:${key}`;

/** Values read from outside the page, held to what the form keeps and to the
 *  interpreted profile of each property: anything else is dropped. */
function admitted(schema: JsonSchema, state: KeptState, read: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const property of state.fields) {
    if (!Object.hasOwn(read, property)) continue;
    const declared = (schema.properties as Record<string, JsonSchema> | undefined)?.[property] ?? {};
    if (validate(declared, read[property]).length === 0) kept[property] = read[property];
  }
  return kept;
}

/** The values the address carries for a form, or nothing when it carries none. */
export function readValueAddress(search: string, schema: JsonSchema, state: KeptState): Record<string, unknown> | undefined {
  if (state.key === undefined || !state.address) return undefined;
  const query = new URLSearchParams(search);
  const read: Record<string, unknown> = {};
  for (const property of state.fields) {
    const text = query.get(`${VALUE_KEYS}${state.key}.${property}`);
    if (text === null) continue;
    try {
      read[property] = JSON.parse(text);
    } catch {
      // Not a value this renderer wrote: it is left out.
    }
  }
  return Object.keys(read).length === 0 ? undefined : admitted(schema, state, read);
}

/** The query string with a form's kept values written into it, each as its JSON. */
export function writeValueAddress(search: string, state: KeptState, record: Record<string, unknown>): string {
  const query = new URLSearchParams(search);
  for (const property of state.fields) {
    const key = `${VALUE_KEYS}${state.key}.${property}`;
    query.delete(key);
    if (record[property] !== undefined) query.set(key, JSON.stringify(record[property]));
  }
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
}

/** The storage a form's state is kept in, or none: memory, no key, or a store
 *  the browser refuses. */
export function valueStorage(state: KeptState): Storage | undefined {
  return state.key === undefined || state.store.type === "memory" ? undefined : browserStorage(state.store.type);
}

export function readValueStore(storage: Storage, at: string, schema: JsonSchema, state: KeptState): Record<string, unknown> | undefined {
  const text = storage.getItem(at);
  if (text === null) return undefined;
  try {
    const entry = JSON.parse(text) as { v?: unknown; values?: unknown };
    if (entry?.v !== VERSION || entry.values === null || typeof entry.values !== "object") return undefined;
    return admitted(schema, state, entry.values as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

/** Write a form's kept values; `false` when the store takes nothing, which is
 *  then left alone — the values stay in memory. */
export function writeValueStore(storage: Storage, at: string, state: KeptState, record: Record<string, unknown>): boolean {
  const values = Object.fromEntries(state.fields.filter((property) => record[property] !== undefined).map((property) => [property, record[property]]));
  try {
    storage.setItem(at, JSON.stringify({ v: VERSION, values }));
    return true;
  } catch (error) {
    console.error(`The browser refuses ${state.store.type} storage, so values are kept in memory: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
