import { anchorRef } from "./node-anchors.js";
import { useCallback, useContext, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { segment } from "./address-wire.js";
import { resolveBasePath, unresolvedFailure, type BasePath } from "./base-path.js";
import { fillAttribute, readBinding, styleAttribute, type Binding } from "./bindings.js";
import { useHost, useHostStore, type UnsavedGuard } from "./host.js";
import { ErrorNode, type SpecNode } from "./nodes.js";
import { useRecordEntry, type EntrySpec } from "./record-entry.js";
import { Fields, refusalOf, sameValues, type EnteredValues } from "./record-fields.js";
import { OpenedPageContext, QueryAddressContext, RendererContext, RootsContext, underMount } from "./renderer-context.js";
import { useSay } from "./texts.js";
import { mergePatchOf } from "./merge-patch.js";
import { networkError, responseError, type ErrorSpec, errorSpec } from "./ui-error.js";

/** A form as the page document carries it: the record it writes, what it starts from, and what it does with unsaved input and a saved record. */
interface FormSpec extends EntrySpec {
  record: { basePath: BasePath; key: Binding | null };
  initialValues: Binding | null;
  unsaved: "confirm" | "discard";
  afterSubmit: "close" | "keep" | "again";
}

/** Where the record is sent: a `POST` to the collection, or a `PATCH` to the record the key names. */
interface FormTarget {
  method: "POST" | "PATCH";
  /** The URL, under the mount. */
  url: string;
  /** The address of the record's own path, announced when it is written; nothing for a create. */
  recordPath?: string;
}

/** What a form starts from, read when it is drawn and again only when it starts again. */
interface Basis {
  /** The record it starts from; none where `initialValues` is absent. */
  initial: Record<string, unknown> | undefined;
  /** The key of the record it edits, read from the roots. */
  key: { present: true; value: unknown } | { present: false };
  /** The address of the query its `initialValues` reads, as it was read. */
  address: string | undefined;
  /** Which start it is: each draws the form afresh. */
  generation: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A form over a model that writes a record of a collection: checked in the page
 * against the model's own rules before anything is sent, then sent; the fields
 * the API refuses are marked where they are. It starts from `initialValues`
 * when it has them, else from the address and its store, and starts again —
 * the unsaved input asked about first — when the address of the query those
 * values come from changes; a read again at the same address keeps it.
 */
export function Form({ node }: { node: SpecNode }) {
  const spec = node as unknown as FormSpec;
  const store = useHostStore();
  const roots = useContext(RootsContext);
  const answeredAt = useContext(QueryAddressContext);
  const startsOnQuery = spec.initialValues !== null && "root" in spec.initialValues && spec.initialValues.root === "data";
  const read = (): Omit<Basis, "generation"> => {
    const initial = spec.initialValues === null ? undefined : readBinding(spec.initialValues, roots);
    const key = spec.record.key === null ? undefined : readBinding(spec.record.key, roots);
    return {
      initial: initial?.present && isRecord(initial.value) ? initial.value : undefined,
      key: key?.present ? { present: true, value: key.value } : { present: false },
      address: startsOnQuery ? answeredAt : undefined,
    };
  };
  const latest = useRef(read);
  latest.current = read;
  const [basis, setBasis] = useState<Basis>(() => ({ ...read(), generation: 0 }));
  const unsaved = useRef<UnsavedGuard>(undefined);
  const onGuard = useCallback((guard: UnsavedGuard | undefined) => void (unsaved.current = guard), []);

  useEffect(() => {
    if (!startsOnQuery || answeredAt === basis.address) return;
    const restart = () => setBasis((held) => ({ ...latest.current(), generation: held.generation + 1 }));
    const guard = unsaved.current;
    if (guard === undefined) restart();
    else store.ask([guard], restart);
  }, [answeredAt]);

  return <FormBody key={basis.generation} node={node} spec={spec} basis={basis} onGuard={onGuard} />;
}

function FormBody({ node, spec, basis, onGuard }: { node: SpecNode; spec: FormSpec; basis: Basis; onGuard: (guard: UnsavedGuard | undefined) => void }) {
  const host = useHost();
  const store = useHostStore();
  const say = useSay();
  const { prefix } = useContext(RendererContext);
  const roots = useContext(RootsContext);
  const opened = useContext(OpenedPageContext);
  const base = resolveBasePath(spec.record.basePath, roots, "'form' record basePath");
  let target: FormTarget | undefined;
  let unresolved: ErrorSpec | undefined = unresolvedFailure(base);
  if (base.ok) {
    if (spec.record.key === null) target = { method: "POST", url: underMount(prefix, base.address) };
    else if (basis.key.present) {
      const recordPath = `${base.address}/${segment(String(basis.key.value))}`;
      target = { method: "PATCH", url: underMount(prefix, recordPath), recordPath };
    } else {
      unresolved = { type: "error", code: "ERR_UI_ADDRESS_UNRESOLVED", message: "The form's record key is not there to read, so nothing is sent." };
    }
  }
  const id = useId();
  const { schema, fields } = spec;
  // The record an edit's patch is measured against: the one it started from, then the one last saved.
  const [start, setStart] = useState(basis.initial);
  const editing = target?.method === "PATCH";
  // A form that creates fills what its start leaves out with the model's defaults; one that edits holds the record as it is.
  const entry = useRecordEntry(spec, start, spec.record.key === null);
  const { values, shown } = entry;
  // What the form held when it was last saved, or opened.
  const [saved, setSaved] = useState<EnteredValues>(values);
  const [failure, setFailure] = useState<ErrorSpec>();
  const [state, setState] = useState<"idle" | "submitting" | "error">("idle");
  const dirty = !sameValues(fields, values, saved);

  const held = useRef<() => void>(undefined);
  /** Stop holding the input as unsaved: it was saved, or dropped. */
  const release = () => {
    if (!held.current) return;
    held.current();
    held.current = undefined;
    onGuard(undefined);
  };
  const guarded = spec.unsaved === "confirm";
  useEffect(() => {
    if (!guarded || !dirty) return release();
    if (held.current) return;
    // Shown while the application stays on the path the form is drawn on.
    const guard: UnsavedGuard = { shows: (to) => to.path === store.snapshot().location.path, discard: release };
    held.current = store.guard(guard);
    onGuard(guard);
  }, [guarded, dirty]);
  useEffect(
    () => () => {
      release();
      opened?.busy(false);
    },
    [],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(undefined);
    // The record is held to the whole model, so a property the form does not
    // show counts with the value the record holds.
    const held: Record<string, unknown> = {};
    if (start) {
      for (const name of Object.keys(schema.properties ?? {})) {
        if (start[name] !== null && start[name] !== undefined) held[name] = start[name];
      }
    }
    // A hidden field's value is neither sent nor checked; the record is still
    // held to the model, so a property it requires blocks the submission.
    for (const field of fields) if (!shown.includes(field)) delete held[field.property];
    const checked = entry.check(held);
    if (!checked.ok) return setState("error");
    if (!target || !base.ok) return setState("error");
    // An edit sends what changed, over the properties the form shows.
    const body = editing ? mergePatchOf(shown.map((field) => field.property), start ?? {}, checked.record) : checked.record;
    setState("submitting");
    opened?.busy(true);
    let answered: unknown;
    try {
      const response = await host
        .fetch(target.url, { method: target.method, headers: { "content-type": editing ? "application/merge-patch+json" : "application/json" }, body: JSON.stringify(body) })
        .catch((error) => {
          throw networkError(error);
        });
      if (response.status === 400) {
        const { byField, other } = refusalOf(await response.json(), shown, say);
        entry.refuse(byField, other);
        return setState("error");
      }
      if (response.status === 412) {
        // The record changed since it was read: read it again for its validator, and keep what was typed.
        const refused = await responseError(response);
        await host.fetch(target.url, { headers: { accept: "application/json" } }).catch((error) => {
          throw networkError(error);
        });
        throw refused;
      }
      if (!response.ok) throw await responseError(response);
      // A record the write answered with is drawn from that answer wherever it is shown.
      if (response.headers.get("content-type")?.includes("json")) answered = await response.json();
    } catch (error) {
      setFailure(errorSpec(error, "ERR_UI_REQUEST_FAILED"));
      setState("error");
      return;
    } finally {
      opened?.busy(false);
    }
    setState("idle");
    release();
    const stored = isRecord(answered) ? answered : undefined;
    if (stored) store.written(base.address, stored);
    host.notifyChanged(base.address);
    // A write to one record is a change to the record's own address too.
    let savedRecord: Record<string, unknown> | undefined;
    if (editing && target.recordPath !== undefined) {
      host.notifyChanged(target.recordPath);
      savedRecord = stored ?? Object.fromEntries(Object.entries({ ...start, ...body }).filter(([, value]) => value !== null));
      setStart(savedRecord);
    }
    // Closing is the surface's: a page of its own stays, saved.
    if (spec.afterSubmit === "close" && opened) return opened.close();
    const next = spec.afterSubmit === "again" ? entry.restarted(savedRecord) : values;
    setSaved(next);
    entry.reset(next);
  };

  const shownFailure = unresolved ?? failure;
  return (
    <form ref={anchorRef(node)} data-telo-part="form" autoComplete="off" data-state={state} data-dirty={dirty ? "true" : undefined} data-fill={fillAttribute(node)} data-style={styleAttribute(node.style)} noValidate onSubmit={submit}>
      {shownFailure && <ErrorNode error={shownFailure} />}
      <Fields id={id} schema={schema} fields={shown} groups={spec.groups} values={values} roots={entry.roots} errors={entry.errors} onChange={entry.change} />
      {entry.formError && (
        <div data-telo-part="form-error" role="alert">
          {entry.formError}
        </div>
      )}
      <div data-telo-part="form-actions">
        {opened && (
          <button data-telo-part="cancel" type="button" disabled={state === "submitting"} onClick={opened.close}>
            {say("cancel")}
          </button>
        )}
        <button data-telo-part="submit" type="submit" disabled={state === "submitting"}>
          {say("save")}
        </button>
      </div>
    </form>
  );
}
