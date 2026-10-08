import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { styleAttribute } from "./bindings.js";
import { useHost, useHostStore, type HostLocation, type UnsavedGuard } from "./host.js";
import { ErrorNode, type SpecNode } from "./nodes.js";
import { enteredRecord, enteredValues, fieldFindings, Fields, refusalOf, sameValues, type EnteredValues, type Field } from "./record-fields.js";
import { networkError, responseError, type ErrorSpec, errorSpec } from "./ui-error.js";
import type { JsonSchema } from "./validation.js";

export interface FormTarget {
  method: "POST" | "PUT";
  url: string;
}

interface FormProps {
  node: SpecNode;
  target: FormTarget;
  /** The record being edited. Given, the form sends back what it held: its
   *  model properties with each field's entered value over them. */
  initial?: Record<string, unknown>;
  /** What the form does once its record is saved: `close` hands over to
   *  `onDone`, `keep` keeps its values, `again` empties it for another record. */
  afterSubmit?: "close" | "again" | "keep";
  /** Given where unsaved input is guarded: whether a location still shows this
   *  form. A move to one that does not waits for the user's answer. */
  shownAt?: (target: HostLocation) => boolean;
  /** Told the guard while the form holds unsaved input, and nothing once it does not. */
  onUnsaved?: (guard: UnsavedGuard | undefined) => void;
  /** Told while a submit is in flight. */
  onBusy?: (busy: boolean) => void;
  /** Told after every record saved. */
  onSaved?: () => void;
  onDone?: () => void;
  onCancel?: () => void;
}

/**
 * A form over a model: checked in the page against the model's own rules
 * before anything is sent, then sent; the fields the API refuses are marked
 * where they are.
 */
export function Form({ node, target, initial, afterSubmit = "again", shownAt, onUnsaved, onBusy, onSaved, onDone, onCancel }: FormProps) {
  const host = useHost();
  const store = useHostStore();
  const id = useId();
  const schema = node.schema as JsonSchema;
  const fields = node.fields as Field[];
  const blank = () => enteredValues(schema, fields, initial);
  // What the form held when it was last saved, or opened.
  const [saved, setSaved] = useState<EnteredValues>(blank);
  const [values, setValues] = useState<EnteredValues>(saved);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [failure, setFailure] = useState<ErrorSpec>();
  const [state, setState] = useState<"idle" | "submitting" | "error">("idle");

  const dirty = !sameValues(fields, values, saved);
  const busy = state === "submitting";

  const callbacks = useRef({ shownAt, onUnsaved });
  callbacks.current = { shownAt, onUnsaved };
  const held = useRef<() => void>(undefined);
  /** Stop holding the input as unsaved: it was saved, or dropped. */
  const release = () => {
    if (!held.current) return;
    held.current();
    held.current = undefined;
    callbacks.current.onUnsaved?.(undefined);
  };
  const guarded = shownAt !== undefined;
  useEffect(() => {
    if (!guarded || !dirty) return release();
    if (held.current) return;
    const guard: UnsavedGuard = { shows: (target) => callbacks.current.shownAt?.(target) ?? true, discard: release };
    held.current = store.guard(guard);
    callbacks.current.onUnsaved?.(guard);
  }, [guarded, dirty]);
  useEffect(() => release, []);

  useEffect(() => {
    if (!busy) return;
    onBusy?.(true);
    return () => onBusy?.(false);
  }, [busy]);

  const refuse = (byField: Record<string, string>, other: string[]) => {
    setFieldErrors(byField);
    setFormError(other.length > 0 ? other.join(" ") : undefined);
    setState("error");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(undefined);
    // An edit replaces what the model declares, so it sends back what the
    // record held: every property of the model that has a value, shown here or not.
    const held: Record<string, unknown> = {};
    if (initial) {
      for (const name of Object.keys(schema.properties ?? {})) {
        if (initial[name] !== null && initial[name] !== undefined) held[name] = initial[name];
      }
    }
    const record = enteredRecord(schema, fields, values, held);
    const invalid = fieldFindings(schema, fields, record);
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
        const { byField, other } = refusalOf(await response.json(), fields);
        return refuse(byField, other);
      }
      if (!response.ok) throw await responseError(response);
    } catch (error) {
      setFailure(errorSpec(error, "ERR_UI_REQUEST_FAILED"));
      setState("error");
      return;
    }
    setState("idle");
    release();
    host.notifyChanged(node.basePath);
    onSaved?.();
    if (afterSubmit === "close") return onDone?.();
    const next = afterSubmit === "keep" ? values : blank();
    setSaved(next);
    setValues(next);
  };

  return (
    <form data-telo-part="form" autoComplete="off" data-state={state} data-dirty={dirty ? "true" : undefined} data-style={styleAttribute(node.style)} noValidate onSubmit={submit}>
      {failure && <ErrorNode error={failure} />}
      <Fields
        id={id}
        schema={schema}
        fields={fields}
        values={values}
        errors={fieldErrors}
        onChange={(property, next) => setValues((current) => ({ ...current, [property]: next }))}
      />
      {formError && (
        <div data-telo-part="form-error" role="alert">
          {formError}
        </div>
      )}
      <div data-telo-part="form-actions">
        {onCancel && (
          <button data-telo-part="cancel" type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
        <button data-telo-part="submit" type="submit" disabled={busy}>
          Save
        </button>
      </div>
    </form>
  );
}
