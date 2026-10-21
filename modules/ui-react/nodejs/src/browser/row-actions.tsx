import { Fragment, useContext, useId, useRef, useState, type ReactNode } from "react";
import { conditionHolds, readBinding } from "./bindings.js";
import { useHost, useHostStore } from "./host.js";
import { Node } from "./nodes.js";
import { followSuccess, PressQueueContext, runOperation, type Outcome, type RowActionSpec } from "./operation.js";
import {
  enteredRecord,
  enteredValues,
  fieldFindings,
  Fields,
  hiddenFindings,
  refusalOf,
  shownFields,
  type EnteredValues,
} from "./record-fields.js";
import { RendererContext, RootsContext } from "./renderer-context.js";
import { Confirmation } from "./surface.js";
import type { RequestError } from "./ui-error.js";
import { useSay, useText } from "./texts.js";

type Row = Record<string, unknown>;
type Roots = Readonly<Record<string, unknown>>;

/** A row action whose confirmation is open: being asked about, sent, or refused. */
interface Asking {
  index: number;
  row: Row;
  key: string;
  /** What its prompt's fields hold, and what was refused of them. */
  values: EnteredValues;
  fieldErrors: Record<string, string>;
  formError?: string;
  busy: boolean;
  failure?: RequestError;
}

/** The record a row action sends: each input it binds, read over the row and
 *  the roots in scope when it is pressed; a path that leads nowhere is left out. */
function boundRecord(entry: RowActionSpec, roots: Roots): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [property, binding] of Object.entries(entry.inputs)) {
    const read = readBinding(binding, roots);
    if ("value" in binding || (read.present && read.value !== null)) record[property] = read.present ? read.value : undefined;
  }
  return record;
}

const answerKey = (index: number, key: string) => `${index}\u0000${key}`;

export interface RowActions {
  /** The buttons — or the answers drawn in their place — of one row. */
  cell(row: Row, key: string, disabled?: boolean): ReactNode;
  /** The confirmation of the press being asked about, when one is open. */
  dialog: ReactNode;
  /** Whether a press of a row is pending or queued. */
  busy(key: string): boolean;
  /** Keep only the answers of these rows. */
  retain(keys: Set<string>): void;
  /** Drop every answer. */
  clear(): void;
}

/**
 * The row actions of one table or list. A row is one entry: it takes no press
 * while its last is pending or queued. A pressed action's `result` tree is
 * drawn in place of its button, over `result`, `input` and `values` (the
 * record sent); a failure is drawn beside the button, or in the confirmation
 * when one is open. `roots` are the roots the rows are drawn under;
 * `succeeded` is told about each success.
 */
export function useRowActions(entries: RowActionSpec[], roots: Roots, succeeded: () => void): RowActions {
  const host = useHost();
  const store = useHostStore();
  const say = useSay();
  const text = useText();
  const { pages } = useContext(RendererContext);
  const queues = useContext(PressQueueContext);
  const promptId = useId();
  const [answers, setAnswers] = useState<ReadonlyMap<string, Outcome>>(new Map());
  // The row action pending or queued per row, by row key. Read on the press
  // itself, which can arrive before the disabled button is drawn.
  const [busyKeys, setBusyKeys] = useState<ReadonlyMap<string, number>>(new Map());
  const pending = useRef(new Map<string, number>());
  const [asking, setAsking] = useState<Asking>();

  const answer = (key: string, outcome: Outcome | undefined) =>
    setAnswers((current) => {
      const next = new Map(current);
      if (outcome === undefined) next.delete(key);
      else next.set(key, outcome);
      return next;
    });
  const hold = (key: string, index: number | undefined) => {
    if (index !== undefined) pending.current.set(key, index);
    else pending.current.delete(key);
    setBusyKeys(new Map(pending.current));
  };

  const send = async (index: number, row: Row, key: string, values: EnteredValues, inDialog: boolean) => {
    if (pending.current.has(key)) return;
    const entry = entries[index];
    const { action } = entry;
    const rowRoots = { ...roots, row };
    const prompted = entry.prompt?.fields ?? [];
    const asked = entry.prompt ? shownFields(action.schema, prompted, values, rowRoots) : [];
    // What the dialog entered, with the row's own values over it, bound now.
    const input = { ...(entry.prompt ? enteredRecord(action.schema, asked, values) : {}), ...boundRecord(entry, rowRoots) };
    if (entry.prompt) {
      const invalid = fieldFindings(action.schema, asked, input, {}, say);
      const unshown = hiddenFindings(action.schema, prompted.filter((field) => !asked.includes(field)), input, say, (label) => text(label));
      if (Object.keys(invalid).length > 0 || unshown.length > 0) {
        setAsking({ index, row, key, values, busy: false, fieldErrors: invalid, ...(unshown.length > 0 ? { formError: unshown.join(" ") } : {}) });
        return;
      }
    }
    hold(key, index);
    answer(answerKey(index, key), undefined);
    if (inDialog) setAsking({ index, row, key, values, busy: true, fieldErrors: {} });
    const outcome = await queues.run(action, () => runOperation(host, action, input, say));
    hold(key, undefined);
    if (outcome.ok) {
      setAsking(undefined);
      if (action.result !== undefined) answer(answerKey(index, key), outcome);
      followSuccess(action, outcome.result, host, store, pages);
      succeeded();
      return;
    }
    if (!inDialog) return answer(answerKey(index, key), outcome);
    if (outcome.error.status === 400 && entry.prompt) {
      // A prompt shows a refusal as a form does: on its fields, and under them.
      const { byField, other } = refusalOf(outcome.body, asked, say);
      setAsking({ index, row, key, values, busy: false, fieldErrors: byField, ...(other.length > 0 ? { formError: other.join(" ") } : {}) });
      return;
    }
    setAsking({ index, row, key, values, busy: false, fieldErrors: {}, failure: outcome.error });
  };

  const press = (index: number, row: Row, key: string) => {
    if (pending.current.has(key)) return;
    const entry = entries[index];
    if (entry.confirm === undefined && entry.prompt === undefined) return void send(index, row, key, {}, false);
    const values = entry.prompt ? enteredValues(entry.action.schema, entry.prompt.fields) : {};
    setAsking({ index, row, key, values, busy: false, fieldErrors: {} });
  };

  const cell = (row: Row, key: string, disabled = false): ReactNode =>
    entries.map((entry, index) => {
      const outcome = answers.get(answerKey(index, key));
      const { action } = entry;
      if (outcome?.ok && action.result !== undefined) {
        return (
          <div key={index} data-telo-part="row-answer">
            <RootsContext.Provider value={{ result: outcome.result, input: outcome.input, values: outcome.input }}>
              <Node node={action.result} />
            </RootsContext.Provider>
          </div>
        );
      }
      const rowRoots = { ...roots, row };
      const allowed = conditionHolds(entry.enabled, rowRoots);
      const busy = busyKeys.has(key);
      return (
        <Fragment key={index}>
          <button
            data-telo-part="row-action"
            type="button"
            data-state={busyKeys.get(key) === index ? "submitting" : undefined}
            disabled={busy || disabled || !allowed}
            onClick={() => press(index, row, key)}
          >
            {text(action.label)}
          </button>
          {!allowed && entry.enabled && <span data-telo-part="disabled-text">{text(entry.enabled.disabledText, undefined, rowRoots)}</span>}
          {outcome && !outcome.ok && (
            <div data-telo-part="row-failure">
              <RootsContext.Provider value={{ error: outcome.error, input: outcome.input, values: outcome.input }}>
                <Node node={action.failure} />
              </RootsContext.Provider>
            </div>
          )}
        </Fragment>
      );
    });

  let dialog: ReactNode = null;
  if (asking) {
    const entry = entries[asking.index];
    const prompt = entry.prompt;
    const rowRoots = { ...roots, row: asking.row };
    const submit = () => void send(asking.index, asking.row, asking.key, asking.values, true);
    dialog = (
      <Confirmation
        title={text(entry.confirm ?? entry.action.label, undefined, rowRoots)}
        confirm={text(entry.action.label)}
        danger={false}
        busy={asking.busy}
        failure={asking.failure && { type: "error", code: asking.failure.code ?? "", message: asking.failure.message ?? "" }}
        onConfirm={submit}
        onClose={() => asking.busy || setAsking(undefined)}
      >
        {prompt && (
          <form
            data-telo-part="form"
            autoComplete="off"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Fields
              id={promptId}
              schema={entry.action.schema}
              fields={shownFields(entry.action.schema, prompt.fields, asking.values, rowRoots)}
              values={asking.values}
              roots={{ ...rowRoots, values: enteredRecord(entry.action.schema, prompt.fields, asking.values) }}
              errors={asking.fieldErrors}
              onChange={(property, next) => setAsking((current) => current && { ...current, values: { ...current.values, [property]: next } })}
            />
            {asking.formError && (
              <div data-telo-part="form-error" role="alert">
                {asking.formError}
              </div>
            )}
          </form>
        )}
      </Confirmation>
    );
  }

  return {
    cell,
    dialog,
    busy: (key) => busyKeys.has(key),
    retain: (keys) =>
      setAnswers((current) => {
        const kept = [...current].filter(([held]) => keys.has(held.slice(held.indexOf("\u0000") + 1)));
        return kept.length === current.size ? current : new Map(kept);
      }),
    clear: () => setAnswers((current) => (current.size === 0 ? current : new Map())),
  };
}
