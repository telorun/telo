import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { styleAttribute } from "./bindings.js";
import { useHost, useHostStore, type HostLocation, type UnsavedGuard } from "./host.js";
import { ErrorNode, type SpecNode } from "./nodes.js";
import { useRecordEntry, type EntrySpec } from "./record-entry.js";
import { Fields, refusalOf, sameValues, type EnteredValues } from "./record-fields.js";
import { useSay } from "./texts.js";
import { networkError, responseError, type ErrorSpec, errorSpec } from "./ui-error.js";

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
   *  `onDone`, `keep` keeps its values, `again` returns it to the values it starts from —
   *  the address and the store aside — for another record. */
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
  const say = useSay();
  const id = useId();
  const spec = node as unknown as EntrySpec;
  const { schema, fields } = spec;
  const entry = useRecordEntry(spec, initial);
  const { values, shown } = entry;
  // What the form held when it was last saved, or opened.
  const [saved, setSaved] = useState<EnteredValues>(values);
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
    // A hidden field's value is neither sent nor checked; the record is still
    // held to the model, so a property it requires blocks the submission.
    for (const field of fields) if (!shown.includes(field)) delete held[field.property];
    const checked = entry.check(held);
    if (!checked.ok) return setState("error");
    setState("submitting");
    let answered: unknown;
    try {
      const response = await host
        .fetch(target.url, { method: target.method, headers: { "content-type": "application/json" }, body: JSON.stringify(checked.record) })
        .catch((error) => {
          throw networkError(error);
        });
      if (response.status === 400) {
        const { byField, other } = refusalOf(await response.json(), shown, say);
        entry.refuse(byField, other);
        return setState("error");
      }
      if (!response.ok) throw await responseError(response);
      // A record the write answered with is drawn from that answer wherever it is shown.
      if (response.headers.get("content-type")?.includes("json")) answered = await response.json();
    } catch (error) {
      setFailure(errorSpec(error, "ERR_UI_REQUEST_FAILED"));
      setState("error");
      return;
    }
    setState("idle");
    release();
    if (answered !== null && typeof answered === "object" && !Array.isArray(answered)) store.written(node.basePath, answered as Record<string, unknown>);
    host.notifyChanged(node.basePath);
    onSaved?.();
    if (afterSubmit === "close") return onDone?.();
    const next = afterSubmit === "keep" ? values : entry.restarted();
    setSaved(next);
    entry.reset(next);
  };

  return (
    <form data-telo-part="form" autoComplete="off" data-state={state} data-dirty={dirty ? "true" : undefined} data-style={styleAttribute(node.style)} noValidate onSubmit={submit}>
      {failure && <ErrorNode error={failure} />}
      <Fields id={id} schema={schema} fields={shown} groups={spec.groups} values={values} roots={entry.roots} errors={entry.errors} onChange={entry.change} />
      {entry.formError && (
        <div data-telo-part="form-error" role="alert">
          {entry.formError}
        </div>
      )}
      <div data-telo-part="form-actions">
        {onCancel && (
          <button data-telo-part="cancel" type="button" disabled={busy} onClick={onCancel}>
            {say("cancel")}
          </button>
        )}
        <button data-telo-part="submit" type="submit" disabled={busy}>
          {say("save")}
        </button>
      </div>
    </form>
  );
}
