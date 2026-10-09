import { Label } from "radix-ui";
import { Checkbox } from "./checkbox.js";
import { OptionGroup, Tags } from "./list-controls.js";
import { Select } from "./select.js";
import { plainTypes, validate, type JsonSchema } from "./validation.js";

/** One field of a record being entered. */
export interface Field {
  property: string;
  label: string;
}

type Control = "checkbox" | "select" | "number" | "date" | "datetime-local" | "time" | "textarea" | "text" | "options" | "tags";

const itemsOf = (schema: JsonSchema): JsonSchema =>
  schema.items !== null && typeof schema.items === "object" && !Array.isArray(schema.items) ? schema.items : {};

/** The control a property is entered with, from what the model says it is. */
export function controlFor(schema: JsonSchema): Control {
  const types = plainTypes(schema);
  // A list is entered whole: chosen from its items' values, or typed one item at a time.
  if (types.includes("array")) return Array.isArray(itemsOf(schema).enum) ? "options" : "tags";
  if (types.includes("boolean")) return "checkbox";
  if (Array.isArray(schema.enum)) return "select";
  if (types.includes("number") || types.includes("integer")) return "number";
  if (schema.format === "date") return "date";
  if (schema.format === "date-time") return "datetime-local";
  if (schema.format === "time") return "time";
  // Multi-line only where the model says the text is a document.
  if (typeof schema.contentMediaType === "string" && schema.contentMediaType.startsWith("text/")) return "textarea";
  return "text";
}

/** What a control holds: text, a checkbox's state, or a list's items as text. */
export type Entered = string | boolean | string[];
export type EnteredValues = Record<string, Entered>;

const pad = (value: number) => String(value).padStart(2, "0");

/** What a control shows for a stored value. */
function entered(value: unknown, schema: JsonSchema): Entered {
  const control = controlFor(schema);
  if (control === "options" || control === "tags") {
    const items = itemsOf(schema);
    // A boolean item has no control of its own: it is typed as its text.
    const text = (item: unknown) => (controlFor(items) === "checkbox" ? String(item) : (entered(item, items) as string));
    return Array.isArray(value) ? value.map(text) : [];
  }
  if (control === "checkbox") return value === true;
  if (value === null || value === undefined) return "";
  if (control === "datetime-local") {
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  return String(value);
}

/** One typed item of a list, as the type its `items` declare. Text that is no
 *  value of that type is kept as typed, for validation to refuse. */
function storedItem(text: string, items: JsonSchema): unknown {
  const control = controlFor(items);
  if (control === "checkbox") return text === "true" ? true : text === "false" ? false : text;
  if (control === "number") return Number.isNaN(Number(text)) ? text : Number(text);
  return stored(text, items);
}

/** The value sent for what a control holds; `undefined` leaves the property out. */
function stored(value: Entered, schema: JsonSchema): unknown {
  const control = controlFor(schema);
  if (control === "options" || control === "tags") {
    const items = itemsOf(schema);
    const held = value as string[];
    // Chosen options are sent in the order the model lists them.
    const list =
      control === "options"
        ? (items.enum as unknown[]).filter((option) => held.includes(String(option)))
        : held.map((text) => storedItem(text, items));
    return list.length > 0 ? list : undefined;
  }
  if (control === "checkbox") return value === true;
  if (value === "") return undefined;
  if (control === "number") return Number(value);
  if (control === "datetime-local") return new Date(String(value)).toISOString();
  if (control === "select") return (schema.enum as unknown[]).find((option) => String(option) === value);
  return value;
}

const propertyOf = (schema: JsonSchema, field: Field): JsonSchema => schema.properties?.[field.property] ?? {};

/** What each field's control holds over a record, or over none. */
export function enteredValues(schema: JsonSchema, fields: Field[], record?: Record<string, unknown>): EnteredValues {
  return Object.fromEntries(fields.map((field) => [field.property, entered(record?.[field.property], propertyOf(schema, field))]));
}

/** Whether two sets of entered values hold the same in every field. */
export function sameValues(fields: Field[], a: EnteredValues, b: EnteredValues): boolean {
  return fields.every((field) => JSON.stringify(a[field.property]) === JSON.stringify(b[field.property]));
}

/**
 * The record sent for what the fields hold: each field that has a value, in
 * the type the model declares, over `held`. A field with no value — an empty
 * control, a list with nothing in it — is left out.
 */
export function enteredRecord(schema: JsonSchema, fields: Field[], values: EnteredValues, held: Record<string, unknown> = {}): Record<string, unknown> {
  const record = { ...held };
  for (const field of fields) {
    const value = stored(values[field.property], propertyOf(schema, field));
    if (value === undefined) delete record[field.property];
    else record[field.property] = value;
  }
  return record;
}

/** What the model refuses in a record, by shown field. A property no field
 *  shows is the API's to judge. */
export function fieldFindings(schema: JsonSchema, fields: Field[], record: Record<string, unknown>): Record<string, string> {
  const shown = new Set(fields.map((field) => field.property));
  const invalid: Record<string, string> = {};
  for (const finding of validate(schema, record)) {
    if (shown.has(finding.path[0])) invalid[finding.path[0]] ??= finding.message;
  }
  return invalid;
}

/** A 400's validation envelope, read for a set of fields. */
export interface Refusal {
  /** The message of each detail whose path is exactly a shown field's property. */
  byField: Record<string, string>;
  /** Every other detail, or the envelope's bare message when it carries none. */
  other: string[];
}

export function refusalOf(body: any, fields: Field[]): Refusal {
  const shown = new Set(fields.map((field) => field.property));
  const byField: Record<string, string> = {};
  const other: string[] = [];
  for (const detail of (Array.isArray(body?.details) ? body.details : []) as { path?: string; message?: string }[]) {
    const property = String(detail.path ?? "");
    if (shown.has(property)) byField[property] ??= detail.message ?? "Is not valid";
    else other.push([property, detail.message].filter(Boolean).join(" "));
  }
  if (Object.keys(byField).length === 0 && other.length === 0) other.push(body?.message ?? "The record was refused.");
  return { byField, other };
}

interface FieldsProps {
  /** What makes the controls' ids unique in the document. */
  id: string;
  schema: JsonSchema;
  fields: Field[];
  values: EnteredValues;
  /** What is wrong with a field, by property. */
  errors: Record<string, string>;
  onChange: (property: string, value: Entered) => void;
}

const TYPED = ["number", "date", "datetime-local", "time"];

/** A labelled control per field, each derived from its model property. */
export function Fields({ id, schema, fields, values, errors, onChange }: FieldsProps) {
  return fields.map((field) => {
    const property = propertyOf(schema, field);
    const control = controlFor(property);
    const error = errors[field.property];
    const invalid = error ? "true" : undefined;
    const controlId = `${id}-${field.property}`;
    const value = values[field.property];
    const set = (next: Entered) => onChange(field.property, next);
    const shared = { id: controlId, name: field.property, autoComplete: "off", "data-invalid": invalid, "aria-invalid": error ? true : undefined };
    const label = (
      <Label.Root data-telo-part="label" htmlFor={controlId}>
        {field.label}
      </Label.Root>
    );
    return (
      <div key={field.property} data-telo-part="field" data-invalid={invalid}>
        {control !== "checkbox" && label}
        {control === "checkbox" ? (
          <Checkbox id={controlId} name={field.property} checked={value === true} invalid={error !== undefined} onChange={set} />
        ) : control === "select" ? (
          <Select
            part="select"
            id={controlId}
            options={(property.enum as unknown[]).map((option) => ({ value: String(option), label: String(option) }))}
            value={String(value)}
            placeholder="Select…"
            none="None"
            invalid={error !== undefined}
            onChange={set}
          />
        ) : control === "options" ? (
          <OptionGroup
            parts={{ group: "options", option: "option" }}
            id={controlId}
            name={field.label}
            options={(itemsOf(property).enum as unknown[]).map((option) => ({ value: String(option), label: String(option) }))}
            values={value as string[]}
            invalid={error !== undefined}
            onChange={set}
          />
        ) : control === "tags" ? (
          <Tags
            parts={{ tags: "tags", tag: "tag", remove: "tag-remove", input: "input" }}
            id={controlId}
            type={TYPED.find((type) => type === controlFor(itemsOf(property))) ?? "text"}
            values={value as string[]}
            invalid={error !== undefined}
            onChange={set}
          />
        ) : control === "textarea" ? (
          <textarea {...shared} data-telo-part="textarea" value={String(value)} onChange={(event) => set(event.target.value)} />
        ) : (
          <input
            {...shared}
            data-telo-part="input"
            type={control}
            step={control === "number" && !plainTypes(property).includes("integer") ? "any" : undefined}
            value={String(value)}
            onChange={(event) => set(event.target.value)}
          />
        )}
        {control === "checkbox" && label}
        {error && <span data-telo-part="field-error">{error}</span>}
      </div>
    );
  });
}
