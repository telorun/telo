import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { presetRange } from "./date-range.js";
import {
  readValueAddress,
  readValueStore,
  valueStorage,
  valueStorageKey,
  writeValueAddress,
  writeValueStore,
  type KeptState,
} from "./form-state.js";
import { useHost, useHostStore } from "./host.js";
import {
  enteredRecord,
  enteredValues,
  fieldFindings,
  hiddenFindings,
  shownFields,
  type EnteredValues,
  type Field,
  type Group,
} from "./record-fields.js";
import { RendererContext, RootsContext } from "./renderer-context.js";
import { validate, type JsonSchema } from "./validation.js";
import { useSay, useText } from "./texts.js";

/** What a form or an action is told of what it enters. */
export interface EntrySpec {
  schema: JsonSchema;
  fields: Field[];
  groups: Group[];
  state: KeptState;
}

/** A new record: the model's defaults and each date range's initial preset —
 *  computed in the viewer's time zone. */
function newRecord(entry: EntrySpec): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const field of entry.fields) {
    const declared = (entry.schema.properties as Record<string, JsonSchema> | undefined)?.[field.property];
    if (declared?.default !== undefined) record[field.property] = declared.default;
    else if (field.type === "dateRange" && field.initialPreset != null) {
      const preset = field.presets?.[field.initialPreset];
      if (preset) record[field.property] = presetRange(preset, field.weekStart ?? "monday", new Date());
    }
  }
  return record;
}

/**
 * The record a form starts from: the one it edits, else what the address
 * keeps, else what the store keeps, else a new record.
 */
function startRecord(entry: EntrySpec, initial: Record<string, unknown> | undefined, search: string, storedAt: string | undefined): Record<string, unknown> {
  if (initial) return initial;
  const storage = valueStorage(entry.state);
  const kept =
    readValueAddress(search, entry.schema, entry.state) ??
    (storage && storedAt ? readValueStore(storage, storedAt, entry.schema, entry.state) : undefined) ??
    {};
  const record = newRecord(entry);
  for (const field of entry.fields) if (Object.hasOwn(kept, field.property)) record[field.property] = kept[field.property];
  return record;
}

/** Each kept property's value as compared between entries: its JSON, `""` for none. */
const keptText = (value: unknown): string => JSON.stringify(value) ?? "";

/**
 * What a form or an action holds while values are entered: the values, the
 * fields drawn now, the record they make, and what is wrong with it — a field's
 * own finding once it has been touched, a server's detail until the field
 * changes again. Every change is kept where the state record says, and the
 * entries sharing its key and a place to keep it — the address, or one store —
 * hold each kept property as one value: a change one makes is followed by
 * every other mounted, except one editing a record, which starts from that record.
 */
export function useRecordEntry(entry: EntrySpec, initial?: Record<string, unknown>) {
  const host = useHost();
  const store = useHostStore();
  const { prefix } = useContext(RendererContext);
  const roots = useContext(RootsContext);
  const say = useSay();
  const text = useText();
  const { schema, fields, groups, state } = entry;
  const storedAt = state.key === undefined ? undefined : valueStorageKey(prefix, state.key);
  const started = useMemo(() => enteredValues(schema, fields, startRecord(entry, initial, host.location.search, storedAt)), []);
  const [values, setValues] = useState<EnteredValues>(started);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [served, setServed] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();

  const shown = shownFields(schema, fields, values, roots, groups);
  const record = enteredRecord(schema, shown, values);
  const live = fieldFindings(schema, shown, record, values, say);
  const errors: Record<string, string> = {};
  for (const field of shown) {
    const message = served[field.property] ?? (touched.has(field.property) ? live[field.property] : undefined);
    if (message !== undefined) errors[field.property] = message;
  }

  // Kept as it changes, the address replaced and never pushed.
  const refused = useRef(false);
  const first = useRef(true);
  const self = useRef({}).current;
  // What this entry knows each kept property to hold: what it wrote, or followed.
  const known = useRef<Record<string, string>>({});
  const keptRecord = enteredRecord(schema, fields, values);
  const keptKey = JSON.stringify(state.fields.map((property) => keptRecord[property]));
  useEffect(() => {
    if (first.current) {
      first.current = false;
      for (const property of state.fields) known.current[property] = keptText(keptRecord[property]);
      return;
    }
    if (state.key === undefined) return;
    if (state.address) {
      const location = store.snapshot().location;
      const search = writeValueAddress(location.search, state, keptRecord);
      if (search.slice(1) !== new URLSearchParams(location.search).toString()) host.navigate(location.path + search + location.hash, { replace: true });
    }
    const storage = valueStorage(state);
    if (storage && storedAt && !refused.current) refused.current = !writeValueStore(storage, storedAt, state, keptRecord);
    // What this entry changed, told to the others: what it followed is not told again.
    const changed: Record<string, unknown> = {};
    for (const property of state.fields) {
      const text = keptText(keptRecord[property]);
      if (known.current[property] === text) continue;
      known.current[property] = text;
      changed[property] = keptRecord[property];
    }
    if (Object.keys(changed).length > 0) store.kept({ from: self, key: state.key, values: changed, address: state.address, store: state.store.type });
  }, [keptKey]);

  // Follow what another entry of the key changes, where the two keep it in one place.
  useEffect(() => {
    if (state.key === undefined || initial) return;
    return store.onKept((change) => {
      if (change.from === self || change.key !== state.key) return;
      const shared = (state.address && change.address) || (state.store.type !== "memory" && state.store.type === change.store);
      if (!shared) return;
      const followed = fields.filter((field) => {
        if (!state.fields.includes(field.property) || !Object.hasOwn(change.values, field.property)) return false;
        const value = change.values[field.property];
        const declared = (schema.properties as Record<string, JsonSchema> | undefined)?.[field.property] ?? {};
        return value === undefined || validate(declared, value).length === 0;
      });
      if (followed.length === 0) return;
      for (const field of followed) known.current[field.property] = keptText(change.values[field.property]);
      setValues((held) => ({ ...held, ...enteredValues(schema, followed, change.values) }));
    });
  }, [state.key]);

  return {
    schema,
    groups,
    values,
    shown,
    record,
    errors,
    formError,
    roots: { ...roots, values: record },
    /** Change one field's value: it is touched, and a server's word on it is gone. */
    change(property: string, next: unknown) {
      setValues((held) => ({ ...held, [property]: next }));
      setTouched((held) => (held.has(property) ? held : new Set([...held, property])));
      setServed((held) => {
        if (!(property in held)) return held;
        const rest = { ...held };
        delete rest[property];
        return rest;
      });
    },
    /** Hold the record to the model before it is sent: every field counts as
     *  touched, and a hidden required property blocks it under the form. */
    check(held: Record<string, unknown> = {}): { ok: true; record: Record<string, unknown> } | { ok: false } {
      setTouched(new Set(fields.map((field) => field.property)));
      const hidden = fields.filter((field) => !shown.includes(field));
      const sent = enteredRecord(schema, shown, values, held);
      const invalid = fieldFindings(schema, shown, sent, values, say);
      const unshown = hiddenFindings(schema, hidden, sent, say, (label) => text(label));
      if (Object.keys(invalid).length > 0 || unshown.length > 0) {
        setFormError(unshown.length > 0 ? unshown.join(" ") : undefined);
        return { ok: false };
      }
      setFormError(undefined);
      setServed({});
      return { ok: true, record: sent };
    },
    /** A refusal: the issues naming a field land on it, the rest under the form. */
    refuse(byField: Record<string, string>, other: string[]) {
      setServed(byField);
      setFormError(other.length > 0 ? other.join(" ") : undefined);
    },
    /** The values the form starts from with neither the address nor the store:
     *  the record it edits, else a new record. */
    restarted(): EnteredValues {
      return enteredValues(schema, fields, initial ?? newRecord(entry));
    },
    /** Start again from these values, nothing touched. */
    reset(next: EnteredValues) {
      setValues(next);
      setTouched(new Set());
      setServed({});
      setFormError(undefined);
    },
  };
}
