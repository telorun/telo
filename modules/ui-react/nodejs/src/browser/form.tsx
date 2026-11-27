import { anchorRef } from "./node-anchors.js";
import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { segment } from "./address-wire.js";
import { AutosaveWrites } from "./autosave-writes.js";
import { resolveBasePath, unresolvedFailure, type BasePath } from "./base-path.js";
import { conditionHolds, fillAttribute, readBinding, styleAttribute, type Binding, type Condition } from "./bindings.js";
import { useDestinationContext } from "./destination.js";
import { FormRecordsContext, type FormWriteName } from "./form-records.js";
import { placedFindings, placedIssues, type PlacedFindings } from "./form-write-findings.js";
import { useHost, useHostStore, type UnsavedGuard } from "./host.js";
import { MutationRunnerContext, effectReads, runMutation, type CallEnvironment, type EffectSpec, type MutationSpec } from "./mutation-call.js";
import { boundRecord } from "./mutation-calls.js";
import { ErrorNode, Node, type SpecNode } from "./nodes.js";
import { useRecordEntry, type EntrySpec } from "./record-entry.js";
import { Fields, refusalOf, sameValues, type EnteredValues } from "./record-fields.js";
import { OpenedPageContext, QueryAddressContext, RendererContext, RootsContext, underMount } from "./renderer-context.js";
import { Confirmation } from "./surface.js";
import { findingText, useSay, useText, type WireText } from "./texts.js";
import { mergePatchOf } from "./merge-patch.js";
import { Settling, type ChangeKind } from "./typing-pause.js";
import { networkError, requestErrorOf, responseError, type ErrorSpec, errorSpec, type RequestError } from "./ui-error.js";
import { validate, type JsonSchema } from "./validation.js";

/** A write a form runs: its mutation, the record its inputs bind, and the trees drawn from its answer. */
interface FormWriteSpec {
  mutation: MutationSpec;
  inputs: Record<string, Binding>;
  result?: SpecNode;
  failure: SpecNode;
}

/** `onSubmit`: run when the form is submitted. */
interface SubmitSpec extends FormWriteSpec {
  label: WireText;
  confirm?: WireText;
  enabled?: Condition & { disabledText: WireText };
}

/** `autosave`: run as the values settle. */
interface AutosaveSpec extends FormWriteSpec {
  /** Milliseconds typed text rests before it is sent. */
  debounce: number;
}

/** A form as the page document carries it: the record it writes, what it starts from, and what it does with unsaved input and a saved record. */
interface FormSpec extends EntrySpec {
  /** The declaration's identity: the session every placement of it on a page shares. */
  id: string;
  /** The collection written, the binding of the stored record's key when it edits one, and the collection's model the stored record it answers with is held to; null for a form with no collection. */
  record: { basePath: BasePath; key: Binding | null; answer: JsonSchema } | null;
  initialValues: Binding | null;
  unsaved: "confirm" | "discard";
  afterSubmit: "close" | "keep" | "again";
  onSubmit: SubmitSpec | null;
  autosave: AutosaveSpec | null;
  onSuccess: EffectSpec[];
  /** Run when a submit write was sent and did not succeed, over `values` and `error`. */
  onFailure: EffectSpec[];
  clearAnswerOn: string[];
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
 * A form over a model. With `record` it writes a record of a collection; with
 * `onSubmit` and `autosave` it runs mutations; with neither it holds values
 * that its conditions, forms sharing its state and every query or listing
 * naming it read. It starts from `initialValues` when it has them, else from
 * the address and its store, and starts again — the unsaved input asked about
 * first — when the address of the query those values come from changes; a
 * read again at the same address keeps it and what was typed since.
 */
export function Form({ node }: { node: SpecNode }) {
  const spec = node as unknown as FormSpec;
  const store = useHostStore();
  const forms = useContext(FormRecordsContext);
  const roots = useContext(RootsContext);
  const answeredAt = useContext(QueryAddressContext);
  const startsOnQuery = spec.initialValues !== null && "root" in spec.initialValues && spec.initialValues.root === "data";
  const read = (): Omit<Basis, "generation"> => {
    const initial = spec.initialValues === null ? undefined : readBinding(spec.initialValues, roots);
    const key = spec.record?.key == null ? undefined : readBinding(spec.record.key, roots);
    return {
      initial: initial?.present && isRecord(initial.value) ? initial.value : undefined,
      key: key?.present ? { present: true, value: key.value } : { present: false },
      address: startsOnQuery ? answeredAt : undefined,
    };
  };
  const latest = useRef(read);
  latest.current = read;
  const [basis, setBasis] = useState<Basis>(() => ({ ...read(), generation: 0 }));
  // The session every placement of the form on this page shares belongs to this start.
  forms.started(spec.id, basis.address ?? "");
  const unsaved = useRef<UnsavedGuard>(undefined);
  const onGuard = useCallback((guard: UnsavedGuard | undefined) => void (unsaved.current = guard), []);

  useEffect(() => {
    if (!startsOnQuery || answeredAt === basis.address) return;
    const restart = () => {
      const next = latest.current();
      forms.started(spec.id, next.address ?? "");
      setBasis((held) => ({ ...next, generation: held.generation + 1 }));
    };
    const guard = unsaved.current;
    if (guard === undefined) restart();
    else store.ask([guard], restart);
  }, [answeredAt]);

  return <FormBody key={basis.generation} node={node} spec={spec} basis={basis} onGuard={onGuard} />;
}

/** The writes a form runs, by name, where it has them: `onSubmit`, then `autosave`. */
const writesOf = (spec: FormSpec): [FormWriteName, FormWriteSpec][] => [
  ...(spec.onSubmit ? [["submit", spec.onSubmit] as [FormWriteName, FormWriteSpec]] : []),
  ...(spec.autosave ? [["autosave", spec.autosave] as [FormWriteName, FormWriteSpec]] : []),
];

function FormBody({ node, spec, basis, onGuard }: { node: SpecNode; spec: FormSpec; basis: Basis; onGuard: (guard: UnsavedGuard | undefined) => void }) {
  const host = useHost();
  const store = useHostStore();
  const say = useSay();
  const text = useText();
  const { prefix } = useContext(RendererContext);
  const roots = useContext(RootsContext);
  const placed = roots;
  const opened = useContext(OpenedPageContext);
  const forms = useContext(FormRecordsContext);
  const runner = useContext(MutationRunnerContext);
  const destinations = useDestinationContext();
  const { record: written } = spec;
  const base = written === null ? undefined : resolveBasePath(written.basePath, roots, "'form' record basePath");
  let target: FormTarget | undefined;
  let unresolved: ErrorSpec | undefined = base === undefined ? undefined : unresolvedFailure(base);
  if (written !== null && base?.ok) {
    if (written.key === null) target = { method: "POST", url: underMount(prefix, base.address) };
    else if (basis.key.present) {
      const recordPath = `${base.address}/${segment(String(basis.key.value))}`;
      target = { method: "PATCH", url: underMount(prefix, recordPath), recordPath };
    } else {
      unresolved = { type: "error", code: "ERR_UI_ADDRESS_UNRESOLVED", message: "The form's record key is not there to read, so nothing is sent." };
    }
  }
  const id = useId();
  const { schema, fields } = spec;

  // The session every placement of the form on this page shares.
  const session = forms.session(spec.id);
  const subscribe = useCallback((listener: () => void) => forms.subscribe(spec.id, listener), [forms, spec.id]);
  useSyncExternalStore(subscribe, () => forms.session(spec.id).version);
  const self = useRef({}).current;

  // The record an edit's patch is measured against: the one it started from, then the one last saved.
  const [start, setStart] = useState(basis.initial);
  const editing = target?.method === "PATCH";
  // A form that creates, or runs mutations, fills what its start leaves out with the model's defaults; one that edits holds the record as it is.
  const entry = useRecordEntry(spec, start, written === null || written.key === null, session.values?.held as EnteredValues | undefined);
  const { values, shown } = entry;
  // What the form held when it was last saved, or opened.
  const [saved, setSaved] = useState<EnteredValues>(values);
  const [failure, setFailure] = useState<ErrorSpec>();
  const [refused, setRefused] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Issues of each write's last 400 that name no field, drawn in its answer region until the next change.
  const [issues, setIssues] = useState<Partial<Record<FormWriteName, string[]>>>({});
  const [pressed, setPressed] = useState(false);

  // Where the bindings of a write read `values`: the record the form holds now, a hidden or empty field left out.
  const writeRoots = entry.roots;
  const writes = writesOf(spec);
  const environment = (): CallEnvironment => ({ host, prefix, say, destinations, naming: spec.onSubmit ? text(spec.onSubmit.label) : say("save") });
  const env = useRef(environment);
  env.current = environment;
  const refusing = useRef<(name: FormWriteName, write: FormWriteSpec, body: unknown) => void>(() => undefined);

  // The writes of `autosave`, made once per session from the record the form starts from.
  if (spec.autosave && !session.autosave) {
    const autosave = spec.autosave;
    session.autosave = new AutosaveWrites(autosave.mutation.schema, boundRecord(autosave, writeRoots), autosave.debounce, {
      changed: () => forms.notify(spec.id),
      send: async (take) => {
        const at = env.current();
        // Queued behind other writes of a serial mutation, the write takes the newest record when it starts.
        const outcome = await runner.enqueue(autosave.mutation, () => runMutation(at.host, at.prefix, { mutation: autosave.mutation, onSuccess: [], result: autosave.result }, take(), at.say));
        // A form taken off the page meanwhile draws nothing of it; what the write invalidates still reads again.
        const current = forms.find(spec.id);
        if (current) current.answers = { ...current.answers, autosave: outcome };
        if (outcome.ok) runner.invalidate(autosave.mutation, outcome, at);
        else if (outcome.error.status === 400) refusing.current("autosave", autosave, outcome.body);
        return outcome.ok;
      },
    });
  }
  const autosave = session.autosave;

  // What `form` reads: the record, once it settles — typed text after the typing pause.
  const recordNow = useRef(entry.record);
  recordNow.current = entry.record;
  const settling = useMemo(() => new Settling(() => forms.settle(spec.id, schema, recordNow.current)), []);
  useEffect(() => {
    const unplace = forms.place(spec.id);
    forms.settle(spec.id, schema, recordNow.current);
    return () => {
      settling.cancel();
      unplace();
    };
  }, []);

  // A change here is every placement's, settled and offered to `autosave`; one another placement made is followed, and is that placement's.
  const valuesKey = JSON.stringify(values);
  const changedBy = useRef<ChangeKind | undefined>(undefined);
  const drawn = useRef(false);
  useEffect(() => {
    const how = changedBy.current ?? "choice";
    changedBy.current = undefined;
    if (!drawn.current) {
      drawn.current = true;
      return;
    }
    const edited = forms.session(spec.id).values;
    if (edited !== undefined && edited.from !== self && JSON.stringify(edited.held) === valuesKey) return;
    forms.edit(spec.id, values, self);
    settling.change(how);
    if (spec.autosave) forms.session(spec.id).autosave?.change(boundRecord(spec.autosave, writeRoots), how);
  }, [valuesKey]);
  useEffect(
    () =>
      forms.subscribe(spec.id, () => {
        const edited = forms.session(spec.id).values;
        if (edited !== undefined && edited.from !== self && JSON.stringify(edited.held) !== JSON.stringify(entryValues.current)) entry.adopt(edited.held as EnteredValues);
      }),
    [],
  );
  const entryValues = useRef(values);
  entryValues.current = values;

  // A hidden page sends what waits to be saved.
  useEffect(() => {
    if (!autosave) return;
    const onHide = () => document.visibilityState === "hidden" && autosave.hidden();
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [autosave]);

  const change = (property: string, value: unknown, how: ChangeKind) => {
    changedBy.current = how;
    entry.change(property, value);
    setRefused(false);
    setIssues({});
    if (spec.clearAnswerOn.includes(property) && Object.keys(session.answers).length > 0) {
      session.answers = {};
      forms.notify(spec.id);
    }
  };
  const commit = () => {
    settling.now();
    forms.session(spec.id).autosave?.commit();
  };

  // Unsaved: a record editor's or a submit form's values other than the saved ones; an autosave form's writes not acknowledged. A form with no write never is.
  const dirty = autosave ? autosave.unsaved : written !== null || spec.onSubmit !== null ? !sameValues(fields, values, saved) : false;
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
    // Shown while the application stays on the path the form is drawn on; leaving drops what waits to be saved.
    const guard: UnsavedGuard = {
      shows: (to) => to.path === store.snapshot().location.path,
      discard: () => {
        forms.find(spec.id)?.autosave?.discard();
        release();
      },
    };
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

  /** What each write's input model refuses of the record its inputs bind now. */
  const judged: Partial<Record<FormWriteName, PlacedFindings>> = {};
  for (const [name, write] of writes) {
    judged[name] = placedFindings(validate(write.mutation.schema, boundRecord(write, writeRoots)), write.inputs, shown, say);
  }

  /** Put a 400's issues on the fields their inputs name, and the rest in the write's answer region. */
  function refuseFor(name: FormWriteName, write: FormWriteSpec, body: unknown) {
    const placed = placedIssues(body, write.inputs, shown, say);
    entry.refuse(placed.byField, []);
    setIssues((current) => ({ ...current, [name]: placed.other }));
  }
  refusing.current = refuseFor;

  const busy = (submitting: boolean) => {
    const current = forms.find(spec.id);
    if (current) current.submitting = submitting;
    forms.notify(spec.id);
    opened?.busy(submitting);
  };

  /** What follows a submit write that succeeded: its result is drawn, `afterSubmit` applies, then the effects run over `values` and `result`. */
  const submitted = (result: Record<string, unknown> | undefined, savedRecord?: Record<string, unknown>) => {
    release();
    // The roots where the form is placed stay in scope beside its own.
    const roots = { ...placed, values: entry.record, result };
    // Closing is the surface's: a page of its own stays, saved.
    if (spec.afterSubmit === "close" && opened) opened.close();
    else {
      const next = spec.afterSubmit === "again" ? entry.restarted(savedRecord) : values;
      setSaved(next);
      entry.reset(next);
    }
    runner.run(spec.onSuccess, roots, env.current());
  };

  /** What follows a submit write that was sent and did not succeed: the effects run over `values` and `error`. */
  const failedWrite = (error: RequestError | ErrorSpec) => runner.run(spec.onFailure, { ...placed, values: entry.record, error }, env.current());

  const sendSubmit = async (write: SubmitSpec, input: Record<string, unknown>) => {
    busy(true);
    // A submit waits for what `autosave` has to save, and is not sent when that fails.
    if (autosave && !(await autosave.flush())) return busy(false);
    const at = env.current();
    const outcome = await runner.enqueue(write.mutation, () => runMutation(at.host, at.prefix, { mutation: write.mutation, onSuccess: spec.onSuccess, result: write.result }, input, at.say));
    busy(false);
    const current = forms.find(spec.id);
    if (current) current.answers = { ...current.answers, submit: outcome };
    forms.notify(spec.id);
    if (!outcome.ok) {
      if (outcome.error.status === 400) refuseFor("submit", write, outcome.body);
      failedWrite(outcome.error);
      return;
    }
    runner.invalidate(write.mutation, outcome, at);
    submitted(outcome.result);
  };

  const submitWrite = (write: SubmitSpec) => {
    setPressed(true);
    const checked = entry.check();
    const input = boundRecord(write, writeRoots);
    // Refused in the page: the findings go on the fields, and nothing is sent.
    if (!checked.ok || validate(write.mutation.schema, input).length > 0) return setRefused(true);
    setRefused(false);
    const current = forms.session(spec.id);
    if (current.answers.submit !== undefined) {
      current.answers = { ...current.answers, submit: undefined };
      forms.notify(spec.id);
    }
    if (write.confirm !== undefined) return setConfirming(true);
    void sendSubmit(write, input);
  };

  const submitRecord = async () => {
    if (written === null) return;
    setFailure(undefined);
    // The record is held to the whole model, so a property the form does not
    // show counts with the value the record holds.
    const kept: Record<string, unknown> = {};
    if (start) {
      for (const name of Object.keys(schema.properties ?? {})) {
        if (start[name] !== null && start[name] !== undefined) kept[name] = start[name];
      }
    }
    // A hidden field's value is neither sent nor checked; the record is still
    // held to the model, so a property it requires blocks the submission.
    for (const field of fields) if (!shown.includes(field)) delete kept[field.property];
    const checked = entry.check(kept);
    if (!checked.ok || !target || !base?.ok) return setRefused(true);
    setRefused(false);
    // An edit sends what changed, over the properties the form shows.
    const body = editing ? mergePatchOf(shown.map((field) => field.property), start ?? {}, checked.record) : checked.record;
    busy(true);
    let answered: unknown;
    let answeredJson = false;
    try {
      const response = await host
        .fetch(target.url, { method: target.method, headers: { "content-type": editing ? "application/merge-patch+json" : "application/json" }, body: JSON.stringify(body) })
        .catch((error) => {
          throw networkError(error);
        });
      if (response.status === 400) {
        const refusal = await response.json();
        const { byField, other } = refusalOf(refusal, shown, say);
        entry.refuse(byField, other);
        setRefused(true);
        failedWrite(requestErrorOf(400, refusal, say));
        return;
      }
      if (response.status === 412) {
        // The record changed since it was read: read it again for its validator, and keep what was typed.
        const refusal = await responseError(response);
        await host.fetch(target.url, { headers: { accept: "application/json" } }).catch((error) => {
          throw networkError(error);
        });
        throw refusal;
      }
      if (!response.ok) throw await responseError(response);
      // A record the write answered with is drawn from that answer wherever it is shown.
      if (response.headers.get("content-type")?.includes("json")) {
        answered = await response.json();
        answeredJson = true;
      }
    } catch (error) {
      const failed = errorSpec(error, "ERR_UI_REQUEST_FAILED");
      setFailure(failed);
      failedWrite(failed);
      return;
    } finally {
      busy(false);
    }
    // The stored record a write answers with is held to the collection's model; one it refuses is a failure, and nothing follows.
    if (answeredJson) {
      const findings = isRecord(answered) ? validate(written.answer, answered, [], { formats: false }) : [];
      const refusal = !isRecord(answered) ? say("answerNotObject") : findings.length > 0 ? say("answerNotModel", { detail: findingText(findings[0], say) }) : undefined;
      if (refusal !== undefined) {
        const invalid = { type: "error" as const, code: "ERR_UI_RESPONSE_INVALID", message: refusal };
        setFailure(invalid);
        failedWrite(invalid);
        return;
      }
    } else if (spec.onSuccess.some((effect) => effectReads(effect, "result"))) {
      const invalid = { type: "error" as const, code: "ERR_UI_RESPONSE_INVALID", message: say("answerNotJson") };
      setFailure(invalid);
      failedWrite(invalid);
      return;
    }
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
    submitted(stored ?? savedRecord, savedRecord);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // One submission at a time: a press while one is pending is not taken.
    if (forms.find(spec.id)?.submitting) return;
    if (spec.onSubmit) return submitWrite(spec.onSubmit);
    void submitRecord();
  };

  const submitting = session.submitting || autosave?.state === "submitting";
  const failed = refused || failure !== undefined || unresolved !== undefined || (session.answers.submit !== undefined && !session.answers.submit.ok) || autosave?.state === "error";
  const state = submitting ? "submitting" : failed ? "error" : "idle";

  // A field shows what the model refuses first, then what each write refuses, each wording once.
  const errors: Record<string, string> = {};
  for (const field of shown) {
    const messages = [entry.errors[field.property]];
    if (entry.touched(field.property)) for (const [name] of writes) messages.push(...(judged[name]?.byField[field.property] ?? []));
    const distinct = [...new Set(messages.filter((message): message is string => message !== undefined))];
    if (distinct.length > 0) errors[field.property] = distinct.join(" ");
  }
  // What a write refuses that no field shows is drawn in its answer region, once the form has been edited or pressed.
  const edited = pressed || shown.some((field) => entry.touched(field.property));

  const region = (name: FormWriteName, write: FormWriteSpec): ReactNode => {
    const answer = session.answers[name];
    const other = [...(edited ? (judged[name]?.other ?? []) : []), ...(issues[name] ?? [])];
    const awaited = name === "autosave" && autosave?.state === "submitting";
    return (
      <div key={name} aria-busy={awaited ? true : undefined}>
        {other.length > 0 && (
          <div data-telo-part="form-error" role="alert">
            {other.join(" ")}
          </div>
        )}
        {answer?.ok && write.result !== undefined && (
          <div data-telo-part="mutation-result">
            <RootsContext.Provider value={{ result: answer.result, input: answer.input, values: entry.record }}>
              <Node node={write.result} />
            </RootsContext.Provider>
          </div>
        )}
        {answer !== undefined && !answer.ok && (
          <div data-telo-part="mutation-failure">
            <RootsContext.Provider value={{ error: answer.error, input: answer.input, values: entry.record }}>
              <Node node={write.failure} />
            </RootsContext.Provider>
          </div>
        )}
        {name === "autosave" && autosave?.state === "error" && (
          <button data-telo-part="retry" type="button" onClick={() => autosave.retry()}>
            {say("retry")}
          </button>
        )}
        {awaited && <span data-telo-part="saving">{say("saving")}</span>}
      </div>
    );
  };

  const onSubmit = spec.onSubmit;
  const allowed = onSubmit === null || conditionHolds(onSubmit.enabled, writeRoots);
  const submits = written !== null || onSubmit !== null;
  const shownFailure = unresolved ?? failure;
  return (
    <form
      ref={anchorRef(node)}
      data-telo-part="form"
      autoComplete="off"
      data-state={state}
      data-dirty={dirty ? "true" : undefined}
      data-fill={fillAttribute(node)}
      data-style={styleAttribute(node.style)}
      noValidate
      onSubmit={submit}
    >
      {shownFailure && <ErrorNode error={shownFailure} />}
      <Fields id={id} schema={schema} fields={shown} groups={spec.groups} values={values} roots={entry.roots} errors={errors} onChange={change} onCommit={commit} />
      {entry.formError && (
        <div data-telo-part="form-error" role="alert">
          {entry.formError}
        </div>
      )}
      {spec.autosave && region("autosave", spec.autosave)}
      {(submits || opened) && (
        <div data-telo-part="form-actions">
          {opened && (
            <button data-telo-part="cancel" type="button" disabled={submitting} onClick={opened.close}>
              {say("cancel")}
            </button>
          )}
          {submits && (
            <button data-telo-part="submit" type="submit" disabled={session.submitting || !allowed}>
              {onSubmit ? text(onSubmit.label, undefined, writeRoots) : say("save")}
            </button>
          )}
          {onSubmit?.enabled && !allowed && <span data-telo-part="disabled-text">{text(onSubmit.enabled.disabledText, undefined, writeRoots)}</span>}
        </div>
      )}
      {onSubmit && region("submit", onSubmit)}
      {confirming && onSubmit && (
        <Confirmation
          title={text(onSubmit.confirm!, undefined, writeRoots)}
          confirm={text(onSubmit.label, undefined, writeRoots)}
          danger={false}
          busy={session.submitting}
          onConfirm={() => {
            setConfirming(false);
            void sendSubmit(onSubmit, boundRecord(onSubmit, writeRoots));
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </form>
  );
}
