import { useContext, type ReactNode } from "react";
import type { Option, Semantics } from "../contract/ui-react-controls.js";
import { conditionHolds, type Condition } from "./bindings.js";
import { MultiSelectList, SelectList } from "./choice-lists.js";
import { presetRange, rangeLongerThan, rangeReversed, type Preset, type Range, type Unit } from "./date-range.js";
import { useControl, useControls } from "./effective-controls.js";
import { optionKey, useChosenOptions, useOptionPages, type OptionSourceSpec } from "./option-source.js";
import { Picker } from "./picker.js";
import { RendererContext } from "./renderer-context.js";
import type { SurfaceSpec } from "./surface.js";
import { labelFor, useSay, useText, type Say, type ValueLabel, type WireText } from "./texts.js";
import { plainTypes, validate, type JsonSchema } from "./validation.js";

/** The word warning of a range longer than its limit, by unit. */
const LONGER_THAN: Record<Unit, string> = {
  day: "rangeLongerThanDays",
  week: "rangeLongerThanWeeks",
  month: "rangeLongerThanMonths",
  quarter: "rangeLongerThanQuarters",
  year: "rangeLongerThanYears",
};

/** One field of a record being entered, as the page document says: tagged by
 *  `type`, drawn while `shown` holds, in the group it names. */
export interface Field {
  type: "input" | "choice" | "picker" | "dateRange";
  property: string;
  label: WireText;
  /** Drawn under the control as its hint. */
  description?: WireText | null;
  /** What each value the model labels is shown as. */
  labels?: ValueLabel[];
  group?: string;
  shown?: Condition;
  control?: "auto" | "select" | "options" | "toggle" | "slider" | "tags";
  options?: OptionSourceSpec;
  surface?: SurfaceSpec;
  presets?: Preset[];
  weekStart?: "monday" | "sunday";
  /** The index of the preset the field starts at. */
  initialPreset?: number | null;
  warnLongerThan?: { unit: Unit; count: number };
}

/** A labelled section of a form, drawn while `shown` holds. */
export interface Group {
  name: string;
  label: WireText;
  description?: WireText;
  shown?: Condition;
}

type Widget =
  | "checkbox"
  | "switch"
  | "select"
  | "multiselect"
  | "single-options"
  | "options"
  | "slider"
  | "number"
  | "date"
  | "datetime-local"
  | "time"
  | "textarea"
  | "text"
  | "tags";

const itemsOf = (schema: JsonSchema): JsonSchema =>
  schema.items !== null && typeof schema.items === "object" && !Array.isArray(schema.items) ? schema.items : {};

const isList = (schema: JsonSchema) => plainTypes(schema).join() === "array";

/** The control a property is entered with, from what the model says it is. */
export function controlFor(schema: JsonSchema): Widget {
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

/** The control an input field is drawn with: the one it names, or the one the model calls for. */
function widgetOf(field: Field, schema: JsonSchema): Widget {
  const many = isList(schema);
  switch (field.control) {
    case "select":
      return many ? "multiselect" : "select";
    case "options":
      return many ? "options" : "single-options";
    case "toggle":
      return "switch";
    case "slider":
      return "slider";
    case "tags":
      return "tags";
    default:
      return controlFor(schema);
  }
}

/** What a list or a single value is chosen from: the listed values, or yes and no. */
function listedValues(element: JsonSchema): unknown[] {
  return Array.isArray(element.enum) ? element.enum : plainTypes(element).includes("boolean") ? [true, false] : [];
}

/** What a value is shown as among the options: its label, yes or no, or its text. */
export type ShowValue = (value: unknown) => string;

/** The options a list or a single value is chosen from, each shown as `show` says. */
function listedOptions(element: JsonSchema, show: ShowValue = String): { value: unknown; option: Option }[] {
  return listedValues(element).map((value) => ({ value, option: { key: String(value), label: show(value) } }));
}

/** How a field shows a value of its property: the label the model gives it,
 *  yes or no, or its text. */
export function useShowValue(labels: readonly ValueLabel[] | undefined): ShowValue {
  const text = useText();
  const say = useSay();
  return (value) => {
    const label = labelFor(labels, value);
    if (label) return text(label);
    return typeof value === "boolean" ? say(value ? "yes" : "no") : String(value);
  };
}

/** What the controls hold, by property. */
export type EnteredValues = Record<string, unknown>;

const pad = (value: number) => String(value).padStart(2, "0");

const chosenOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]);

/** What a control shows for a stored value. */
function entered(value: unknown, field: Field, schema: JsonSchema): unknown {
  if (field.type === "choice" || field.type === "picker") return chosenOf(value);
  if (field.type === "dateRange") {
    const range = (value ?? {}) as Partial<Range>;
    return { from: typeof range.from === "string" ? range.from : "", to: typeof range.to === "string" ? range.to : "" };
  }
  const widget = widgetOf(field, schema);
  if (widget === "options" || widget === "tags" || widget === "multiselect") {
    const items = itemsOf(schema);
    // A boolean item has no control of its own: it is typed as its text.
    const text = (item: unknown) => (item === null || item === undefined ? "" : typeof item === "boolean" ? String(item) : (entered(item, { ...field, control: "auto" }, items) as string));
    return Array.isArray(value) ? value.map(text) : [];
  }
  if (widget === "checkbox" || widget === "switch") return value === true;
  if (value === null || value === undefined) return "";
  if (widget === "datetime-local") {
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  return String(value);
}

/** One typed item of a list, as the type its `items` declare. Text that is no
 *  value of that type is kept as typed, for validation to refuse. */
function storedItem(text: string, items: JsonSchema): unknown {
  const widget = controlFor(items);
  if (widget === "checkbox") return text === "true" ? true : text === "false" ? false : text;
  if (widget === "number") return Number.isNaN(Number(text)) ? text : Number(text);
  return stored(text, { type: "input", property: "", label: { word: "none" }, control: "auto" }, items);
}

/** The value sent for what a control holds; `undefined` leaves the property out. */
function stored(value: unknown, field: Field, schema: JsonSchema): unknown {
  if (field.type === "choice" || field.type === "picker") {
    const chosen = value as unknown[];
    if (isList(schema)) return chosen.length > 0 ? chosen : undefined;
    return chosen[0];
  }
  if (field.type === "dateRange") {
    const range = value as Range;
    if (range.from === "" && range.to === "") return undefined;
    return { ...(range.from !== "" ? { from: range.from } : {}), ...(range.to !== "" ? { to: range.to } : {}) };
  }
  const widget = widgetOf(field, schema);
  if (widget === "options" || widget === "tags" || widget === "multiselect") {
    const items = itemsOf(schema);
    const held = value as string[];
    const listed = listedOptions(items);
    // Chosen options are sent in the order the model lists them.
    const list =
      widget !== "tags" && listed.length > 0
        ? listed.filter(({ option }) => held.includes(option.key)).map(({ value: chosen }) => chosen)
        : held.map((text) => storedItem(text, items));
    return list.length > 0 ? list : undefined;
  }
  if (widget === "checkbox" || widget === "switch") return value === true;
  if (value === "") return undefined;
  if (widget === "number" || widget === "slider") return Number(value);
  if (widget === "datetime-local") return new Date(String(value)).toISOString();
  if (widget === "select" || widget === "single-options") return listedOptions(schema).find(({ option }) => option.key === value)?.value;
  return value;
}

const propertyOf = (schema: JsonSchema, field: Field): JsonSchema => schema.properties?.[field.property] ?? {};

/** What each field's control holds over a record, or over none. */
export function enteredValues(schema: JsonSchema, fields: Field[], record?: Record<string, unknown>): EnteredValues {
  return Object.fromEntries(fields.map((field) => [field.property, entered(record?.[field.property], field, propertyOf(schema, field))]));
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
    const value = stored(values[field.property], field, propertyOf(schema, field));
    if (value === undefined) delete record[field.property];
    else record[field.property] = value;
  }
  return record;
}

/**
 * The fields drawn now: those whose condition — and whose group's — holds over
 * the form's current `values`, every field's value in the type the model
 * declares, beside the roots in scope. A hidden field keeps what it holds.
 */
export function shownFields(
  schema: JsonSchema,
  fields: Field[],
  values: EnteredValues,
  roots: Readonly<Record<string, unknown>> = {},
  groups: Group[] = [],
): Field[] {
  const scope = { ...roots, values: enteredRecord(schema, fields, values) };
  const hiddenGroups = new Set(groups.filter((group) => !conditionHolds(group.shown, scope)).map((group) => group.name));
  return fields.filter((field) => conditionHolds(field.shown, scope) && (field.group === undefined || !hiddenGroups.has(field.group)));
}

/** What the model refuses of a hidden field's property — its value is neither
 *  sent nor checked, so a property it requires — read for under the form. */
export function hiddenFindings(
  schema: JsonSchema,
  hidden: Field[],
  record: Record<string, unknown>,
  say: Say,
  text: (label: WireText) => string,
): string[] {
  const labels = new Map(hidden.map((field) => [field.property, field.label]));
  return validate(schema, record)
    .filter((finding) => labels.has(finding.path[0]))
    .map((finding) => `${text(labels.get(finding.path[0])!)}: ${say(finding.word.id, finding.word.values)}`);
}

/** What is wrong with a record, by shown field: what the model refuses of its
 *  property, and a date range that starts after it ends. A property no field
 *  shows is the API's to judge. */
export function fieldFindings(
  schema: JsonSchema,
  fields: Field[],
  record: Record<string, unknown>,
  values: EnteredValues,
  say: Say,
): Record<string, string> {
  const shown = new Set(fields.map((field) => field.property));
  const invalid: Record<string, string> = {};
  for (const field of fields) {
    if (field.type === "dateRange" && values[field.property] && rangeReversed(values[field.property] as Range)) {
      invalid[field.property] = say("rangeStartsAfterEnd");
    }
  }
  for (const finding of validate(schema, record)) {
    if (shown.has(finding.path[0])) invalid[finding.path[0]] ??= say(finding.word.id, finding.word.values);
  }
  return invalid;
}

/** A 400's validation envelope, read for a set of fields. */
export interface Refusal {
  /** The message of each detail whose path begins with a shown field's property. */
  byField: Record<string, string>;
  /** Every other detail, or the envelope's bare message when it carries none. */
  other: string[];
}

/** The property a detail is about: the first segment of its path, `period`
 *  for `period.from`. */
const firstSegment = (path: string): string => path.replace(/^\//, "").split(/[./]/)[0];

export function refusalOf(body: any, fields: Field[], say: Say): Refusal {
  const shown = new Set(fields.map((field) => field.property));
  const byField: Record<string, string> = {};
  const other: string[] = [];
  for (const detail of (Array.isArray(body?.details) ? body.details : []) as { path?: string; message?: string }[]) {
    const path = String(detail.path ?? "");
    const property = firstSegment(path);
    if (shown.has(property)) byField[property] ??= detail.message ?? say("invalid");
    else other.push([path, detail.message].filter(Boolean).join(" "));
  }
  if (Object.keys(byField).length === 0 && other.length === 0) other.push(body?.message ?? say("recordRefused"));
  return { byField, other };
}

interface FieldsProps {
  /** What makes the controls' ids unique in the document. */
  id: string;
  schema: JsonSchema;
  fields: Field[];
  groups?: Group[];
  values: EnteredValues;
  /** The roots in scope, `values` among them: what option sources read. */
  roots: Readonly<Record<string, unknown>>;
  /** What is wrong with a field, by property. */
  errors: Record<string, string>;
  onChange: (property: string, value: unknown) => void;
}

const TYPED = ["number", "date", "datetime-local", "time"] as const;

/** A choice from what a source offers: a list, or options side by side. */
function Choice({ semantics, field, schema, roots, value, onChange }: ControlProps) {
  const text = useText();
  const say = useSay();
  const control = useControls();
  const source = field.options!;
  const many = isList(schema);
  const pages = useOptionPages(source, roots);
  const chosen = value as unknown[];
  const shown = useChosenOptions(source, roots, chosen, pages.options, onChange);
  // The chosen ones stay listed, labelled, while their page is not read.
  const all = [...pages.options, ...shown.filter((option) => !pages.options.some((offered) => optionKey(offered.value) === optionKey(option.value)))];
  const options: Option[] = all.map((option) => ({ key: optionKey(option.value), label: option.label }));
  const valueOf = (key: string) => all.find((option) => optionKey(option.value) === key)?.value;
  const keys = chosen.map(optionKey);
  const set = (next: string[]) => onChange(next.map(valueOf).filter((each) => each !== undefined));
  if (field.control === "options") {
    const OptionGroup = control("OptionGroup");
    return (
      <>
        <OptionGroup {...semantics} label={text(field.label)} parts={{ root: "options", option: "option" }} multiple={many} options={options} value={keys} onChange={set} />
        {pages.more && (
          <button data-telo-part="options-more" type="button" disabled={pages.loading} onClick={pages.next}>
            {say("more")}
          </button>
        )}
      </>
    );
  }
  const list = { ...semantics, part: "select" as const, options, loading: pages.loading, hasMore: pages.more, onEndReached: pages.next };
  return many ? (
    <MultiSelectList {...list} value={keys} placeholder={say("select")} onChange={set} />
  ) : (
    <SelectList {...list} value={keys[0] ?? ""} placeholder={say("select")} noneLabel={say("none")} onChange={(next) => set(next === "" ? [] : [next])} />
  );
}

interface ControlProps {
  /** What the control forwards to the element a person focuses. */
  semantics: Semantics;
  field: Field;
  schema: JsonSchema;
  roots: Readonly<Record<string, unknown>>;
  value: unknown;
  onChange: (next: any) => void;
}

/** An input field's control, as it names it or as its property calls for. */
function Input({ semantics, field, schema, value, onChange }: ControlProps) {
  const text = useText();
  const say = useSay();
  const show = useShowValue(field.labels);
  const { lang } = useContext(RendererContext);
  const name = text(field.label);
  const widget = widgetOf(field, schema);
  const element = isList(schema) ? itemsOf(schema) : schema;
  const options = listedOptions(element, show).map(({ option }) => option);
  const control = useControls();
  const entry = { ...semantics, name: field.property, value: String(value), onChange };
  switch (widget) {
    case "checkbox": {
      const Checkbox = control("Checkbox");
      return <Checkbox {...semantics} name={field.property} checked={value === true} onChange={onChange} />;
    }
    case "switch": {
      const Switch = control("Switch");
      return <Switch {...semantics} part="switch" checked={value === true} onChange={onChange} />;
    }
    case "select":
      return <SelectList {...semantics} part="select" options={options} value={String(value)} placeholder={say("select")} noneLabel={say("none")} onChange={onChange} />;
    case "multiselect":
      return <MultiSelectList {...semantics} part="select" options={options} value={value as string[]} placeholder={say("select")} onChange={onChange} />;
    case "options":
    case "single-options": {
      const OptionGroup = control("OptionGroup");
      const many = widget === "options";
      return (
        <OptionGroup
          {...semantics}
          label={name}
          parts={{ root: "options", option: "option" }}
          multiple={many}
          options={options}
          value={many ? (value as string[]) : value === "" ? [] : [String(value)]}
          onChange={(next) => onChange(many ? next : (next[0] ?? ""))}
        />
      );
    }
    case "slider": {
      const Slider = control("Slider");
      const { minimum, maximum, multipleOf } = schema;
      return (
        <Slider
          {...semantics}
          label={name}
          part="slider"
          min={minimum}
          max={maximum}
          step={multipleOf ?? (plainTypes(schema).includes("integer") ? 1 : (maximum - minimum) / 100)}
          value={value === "" ? String(minimum) : String(value)}
          valueText={value === "" ? undefined : String(value)}
          onChange={onChange}
          // A field holds every position it is moved to: letting go means nothing more.
          onCommit={() => undefined}
        />
      );
    }
    case "tags": {
      const TagsInput = control("TagsInput");
      const values = value as string[];
      return (
        <TagsInput
          {...semantics}
          parts={{ root: "tags", tag: "tag", remove: "tag-remove", input: "input" }}
          type={TYPED.find((type) => type === controlFor(itemsOf(schema))) ?? "text"}
          values={values}
          removeLabels={values.map((each) => say("remove", { label: each }))}
          onChange={onChange}
        />
      );
    }
    case "textarea": {
      const TextArea = control("TextArea");
      return <TextArea {...entry} />;
    }
    case "number": {
      const NumberInput = control("NumberInput");
      return <NumberInput {...entry} part="input" integer={plainTypes(schema).includes("integer")} />;
    }
    case "date": {
      const DateInput = control("DateInput");
      return <DateInput {...entry} part="input" lang={lang} />;
    }
    case "datetime-local": {
      const DateTimeInput = control("DateTimeInput");
      return <DateTimeInput {...entry} lang={lang} />;
    }
    case "time": {
      const TimeInput = control("TimeInput");
      return <TimeInput {...entry} lang={lang} />;
    }
    default: {
      const TextInput = control("TextInput");
      return <TextInput {...entry} part="input" type="text" />;
    }
  }
}

/** A date range field's control: its presets as the ranges they set today, in
 *  the viewer's time zone. */
function DateRangeField({ semantics, field, value, onChange }: ControlProps) {
  const text = useText();
  const say = useSay();
  const { lang } = useContext(RendererContext);
  const DateRangeInput = useControl("DateRangeInput");
  const weekStart = field.weekStart ?? "monday";
  const today = new Date();
  return (
    <DateRangeInput
      id={semantics.id}
      label={text(field.label)}
      describedBy={semantics.describedBy}
      invalid={semantics.invalid}
      required={semantics.required}
      disabled={semantics.disabled}
      fromLabel={say("rangeFrom")}
      toLabel={say("rangeTo")}
      presets={(field.presets ?? []).map((preset) => ({ label: text(preset.label), ...presetRange(preset, weekStart, today) }))}
      lang={lang}
      weekStart={weekStart}
      value={value as Range}
      onChange={onChange}
    />
  );
}

/** One labelled field. */
function FieldControl({ id, schema, field, values, roots, errors, onChange }: Omit<FieldsProps, "fields" | "groups"> & { field: Field }) {
  const text = useText();
  const say = useSay();
  const name = text(field.label);
  const property = propertyOf(schema, field);
  const error = errors[field.property];
  const controlId = `${id}-${field.property}`;
  const value = values[field.property];
  const set = (next: unknown) => onChange(field.property, next);
  const range = field.type === "dateRange" ? (value as Range) : undefined;
  const longer = range && field.warnLongerThan && rangeLongerThan(range, field.warnLongerThan);
  const described = field.description != null;
  const semantics: Semantics = {
    id: controlId,
    describedBy: [described && `${controlId}-description`, error !== undefined && `${controlId}-error`].filter(Boolean).join(" ") || undefined,
    invalid: error !== undefined,
    required: Array.isArray(schema.required) && schema.required.includes(field.property),
    disabled: false,
  };
  const props: ControlProps = { semantics, field, schema: property, roots, value, onChange: set };
  const ownLabel = field.type === "input" && ["checkbox", "switch"].includes(widgetOf(field, property));
  const label = (
    <label data-telo-part="label" htmlFor={controlId}>
      {name}
    </label>
  );
  return (
    <div data-telo-part="field" data-invalid={error ? "true" : undefined}>
      {!ownLabel && field.type !== "dateRange" && label}
      {field.type === "choice" ? (
        <Choice {...props} />
      ) : field.type === "picker" ? (
        <Picker
          id={controlId}
          label={name}
          source={field.options!}
          surface={field.surface!}
          many={isList(property)}
          roots={roots}
          chosen={value as unknown[]}
          invalid={error !== undefined}
          onChange={set}
        />
      ) : field.type === "dateRange" ? (
        <DateRangeField {...props} />
      ) : (
        <Input {...props} />
      )}
      {ownLabel && label}
      {described && (
        <span data-telo-part="field-description" id={`${controlId}-description`}>
          {text(field.description!)}
        </span>
      )}
      {error && (
        <span data-telo-part="field-error" id={`${controlId}-error`}>
          {error}
        </span>
      )}
      {!error && longer && (
        <span data-telo-part="field-warning">
          {say(LONGER_THAN[field.warnLongerThan!.unit], { count: field.warnLongerThan!.count })}
        </span>
      )}
    </div>
  );
}

/** A labelled control per field, each in the group it names; a group is drawn
 *  where its fields are, under its label. */
export function Fields({ groups = [], fields, ...shared }: FieldsProps) {
  const text = useText();
  const drawn: ReactNode[] = [];
  for (let at = 0; at < fields.length; ) {
    const group = groups.find((each) => each.name === fields[at].group);
    if (!group) {
      drawn.push(<FieldControl key={fields[at].property} {...shared} field={fields[at]} />);
      at++;
      continue;
    }
    const members: Field[] = [];
    while (at < fields.length && fields[at].group === group.name) members.push(fields[at++]);
    drawn.push(
      <fieldset key={`group-${group.name}`} data-telo-part="field-group">
        <legend data-telo-part="field-group-label">{text(group.label)}</legend>
        {group.description !== undefined && <p data-telo-part="field-group-description">{text(group.description)}</p>}
        {members.map((field) => (
          <FieldControl key={field.property} {...shared} field={field} />
        ))}
      </fieldset>,
    );
  }
  return drawn;
}
