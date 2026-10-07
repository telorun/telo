import { Label } from "radix-ui";
import { useId, useState, type FormEvent } from "react";
import { styleAttribute } from "./bindings.js";
import { Checkbox } from "./checkbox.js";
import { useHost } from "./host.js";
import { ErrorNode, type SpecNode } from "./nodes.js";
import { Select } from "./select.js";
import { networkError, responseError, type ErrorSpec, errorSpec } from "./ui-error.js";
import { validate, type JsonSchema } from "./validation.js";

interface Field {
  property: string;
  label: string;
}

type Control = "checkbox" | "select" | "number" | "date" | "datetime-local" | "time" | "textarea" | "text";

const plainTypes = (schema: JsonSchema): string[] => [schema.type ?? []].flat().filter((type) => type !== "null");

/** The control a property is edited with, from what the model says it is. */
export function controlFor(schema: JsonSchema): Control {
  const types = plainTypes(schema);
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

type Entered = string | boolean;

const pad = (value: number) => String(value).padStart(2, "0");

/** What a control shows for a stored value. */
function entered(value: unknown, control: Control): Entered {
  if (control === "checkbox") return value === true;
  if (value === null || value === undefined) return "";
  if (control === "datetime-local") {
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  return String(value);
}

/** The value sent for what a control holds; `undefined` leaves the property out. */
function stored(value: Entered, control: Control, schema: JsonSchema): unknown {
  if (control === "checkbox") return value === true;
  if (value === "") return undefined;
  if (control === "number") return Number(value);
  if (control === "datetime-local") return new Date(String(value)).toISOString();
  if (control === "select") return (schema.enum as unknown[]).find((option) => String(option) === value);
  return value;
}

export interface FormTarget {
  method: "POST" | "PUT";
  url: string;
}

interface FormProps {
  node: SpecNode;
  target: FormTarget;
  /** The row being edited. Given, the form sends a whole record: this row's
   *  model properties with each field's entered value over them. */
  initial?: Record<string, unknown>;
  onDone?: () => void;
  onCancel?: () => void;
}

/**
 * A form over a model: checked in the page against the model's own rules
 * before anything is sent, then sent; the fields the API refuses are marked
 * where they are.
 */
export function Form({ node, target, initial, onDone, onCancel }: FormProps) {
  const host = useHost();
  const id = useId();
  const schema = node.schema as JsonSchema;
  const fields = node.fields as Field[];
  const propertyOf = (field: Field): JsonSchema => schema.properties?.[field.property] ?? {};
  const blank = () =>
    Object.fromEntries(fields.map((field) => [field.property, entered(initial?.[field.property], controlFor(propertyOf(field)))]));
  const [values, setValues] = useState<Record<string, Entered>>(blank);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [failure, setFailure] = useState<ErrorSpec>();
  const [state, setState] = useState<"idle" | "submitting" | "error">("idle");

  const refuse = (byField: Record<string, string>, other: string[]) => {
    setFieldErrors(byField);
    setFormError(other.length > 0 ? other.join(" ") : undefined);
    setState("error");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(undefined);
    // An edit replaces the row, so it sends back what the row held: every
    // property of the model that has a value, shown here or not.
    const record: Record<string, unknown> = {};
    if (initial) {
      for (const name of Object.keys(schema.properties ?? {})) {
        if (initial[name] !== null && initial[name] !== undefined) record[name] = initial[name];
      }
    }
    for (const field of fields) {
      const property = propertyOf(field);
      const value = stored(values[field.property], controlFor(property), property);
      if (value === undefined) delete record[field.property];
      else record[field.property] = value;
    }
    const shown = new Set(fields.map((field) => field.property));
    const invalid: Record<string, string> = {};
    for (const finding of validate(schema, record)) {
      // A property the form does not show is the API's to judge.
      if (shown.has(finding.path[0])) invalid[finding.path[0]] ??= finding.message;
    }
    if (Object.keys(invalid).length > 0) return refuse(invalid, []);
    setFieldErrors({});
    setFormError(undefined);
    setState("submitting");
    try {
      const response = await host
        .fetch(target.url, { method: target.method, headers: { "content-type": "application/json" }, body: JSON.stringify(record) })
        .catch((error) => {
          throw networkError(error);
        });
      if (response.status === 400) {
        const body = await response.json();
        const byField: Record<string, string> = {};
        const other: string[] = [];
        for (const detail of (Array.isArray(body?.details) ? body.details : []) as { path?: string; message?: string }[]) {
          const property = String(detail.path ?? "");
          if (shown.has(property)) byField[property] ??= detail.message ?? "Is not valid";
          else other.push([property, detail.message].filter(Boolean).join(" "));
        }
        if (Object.keys(byField).length === 0 && other.length === 0) other.push(body?.message ?? "The record was refused.");
        return refuse(byField, other);
      }
      if (!response.ok) throw await responseError(response);
    } catch (error) {
      setFailure(errorSpec(error, "ERR_UI_REQUEST_FAILED"));
      setState("error");
      return;
    }
    setState("idle");
    host.notifyChanged(node.basePath);
    if (onDone) onDone();
    else setValues(blank());
  };

  return (
    <form data-telo-part="form" data-state={state} data-style={styleAttribute(node.style)} noValidate onSubmit={submit}>
      {failure && <ErrorNode error={failure} />}
      {fields.map((field) => {
        const property = propertyOf(field);
        const control = controlFor(property);
        const error = fieldErrors[field.property];
        const invalid = error ? "true" : undefined;
        const controlId = `${id}-${field.property}`;
        const value = values[field.property];
        const set = (next: Entered) => setValues((current) => ({ ...current, [field.property]: next }));
        const shared = { id: controlId, name: field.property, "data-invalid": invalid, "aria-invalid": error ? true : undefined };
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
      })}
      {formError && (
        <div data-telo-part="form-error" role="alert">
          {formError}
        </div>
      )}
      <div data-telo-part="form-actions">
        {onCancel && (
          <button data-telo-part="cancel" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button data-telo-part="submit" type="submit" disabled={state === "submitting"}>
          Save
        </button>
      </div>
    </form>
  );
}
