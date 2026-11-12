import { Fragment, useContext, useId, useRef, useState, type ReactNode } from "react";
import { conditionHolds, readBinding } from "./bindings.js";
import type { KeptState } from "./form-state.js";
import { useHost, useHostStore } from "./host.js";
import { Node } from "./nodes.js";
import { RowMenu, type RowMenuEntry } from "./row-menu.js";
import { followSuccess, PressQueueContext, runOperation, type Outcome, type RowActionSpec } from "./operation.js";
import { useRecordEntry } from "./record-entry.js";
import { Fields, refusalOf } from "./record-fields.js";
import { RendererContext, RootsContext } from "./renderer-context.js";
import { Confirmation } from "./surface.js";
import type { RequestError } from "./ui-error.js";
import { validate } from "./validation.js";
import { useSay, useText } from "./texts.js";

type Row = Record<string, unknown>;
type Roots = Readonly<Record<string, unknown>>;

/** A row action whose confirmation is open: being asked about, sent, or refused. */
interface Asking {
  index: number;
  row: Row;
  key: string;
  /** The roots the press binds beside the row: a move's `to`. */
  extra: Roots;
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

/** What a confirmation with no prompt keeps: nothing. */
const UNKEPT: KeptState = { address: false, store: { type: "memory" }, fields: [] };

/** A button of an entry, as a place drawing it in its own way is told of it. */
export interface EntryButton {
  label: string;
  disabled: boolean;
  /** Whether this entry's press of the row is the one pending. */
  submitting: boolean;
  press(): void;
}

export interface ControlOptions {
  disabled?: boolean;
  /** Draws the button, in place of a `row-action` one. */
  button?: (button: EntryButton) => ReactNode;
  /** Drawn right after the button, and not in place of an answer. */
  beside?: ReactNode;
}

export interface RowActions {
  /** The buttons — or the answers drawn in their place — of one row. */
  cell(row: Row, key: string, disabled?: boolean): ReactNode;
  /** One entry's control for a row: its answer once it succeeded; else its
   *  button, what `beside` holds, why it is disabled and what its last press failed with. */
  control(index: number, row: Row, key: string, options?: ControlOptions): ReactNode;
  /** The same, folded into a menu: the answers of pressed actions, then one button opening each action followed by `after`. */
  menuCell(row: Row, key: string, disabled?: boolean, after?: RowMenuEntry[]): ReactNode;
  /** The confirmation of the press being asked about, when one is open. */
  dialog: ReactNode;
  /** Press an entry for a row, its inputs read over `extra` beside the row: a move's `to`. */
  press(index: number, row: Row, key: string, extra?: Roots): void;
  /** What an entry's last press of a row failed with, drawn as its failure tree; nothing otherwise. */
  failure(index: number, key: string): ReactNode;
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
 * `succeeded` is told about each success, with what it answered and the row's key.
 */
export function useRowActions(
  entries: RowActionSpec[],
  roots: Roots,
  succeeded: (result: Record<string, unknown> | undefined, key: string) => void,
): RowActions {
  const host = useHost();
  const store = useHostStore();
  const say = useSay();
  const text = useText();
  const { pages, prefix } = useContext(RendererContext);
  const queues = useContext(PressQueueContext);
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

  /** Send a press's record; what it came to, or nothing when the row's last press is still pending. */
  const send = async (index: number, row: Row, key: string, extra: Roots, input: Record<string, unknown>, inDialog: boolean): Promise<Outcome | undefined> => {
    if (pending.current.has(key)) return undefined;
    const entry = entries[index];
    const { action } = entry;
    hold(key, index);
    answer(answerKey(index, key), undefined);
    if (inDialog) setAsking({ index, row, key, extra, busy: true });
    const outcome = await queues.run(action, () => runOperation(host, prefix, action, input, say));
    hold(key, undefined);
    if (outcome.ok) {
      setAsking(undefined);
      if (action.result !== undefined) answer(answerKey(index, key), outcome);
      followSuccess(action, outcome, host, store, pages);
      succeeded(outcome.result, key);
      return outcome;
    }
    if (!inDialog) {
      answer(answerKey(index, key), outcome);
      return outcome;
    }
    // A prompt shows a refusal as a form does, on its fields: the dialog draws it.
    const onFields = outcome.error.status === 400 && entry.prompt !== undefined;
    setAsking({ index, row, key, extra, busy: false, ...(onFields ? {} : { failure: outcome.error }) });
    return outcome;
  };

  const press = (index: number, row: Row, key: string, extra: Roots = {}) => {
    if (pending.current.has(key)) return;
    const entry = entries[index];
    if (entry.confirm === undefined && entry.prompt === undefined) return void send(index, row, key, extra, boundRecord(entry, { ...roots, ...extra, row }), false);
    setAsking({ index, row, key, extra, busy: false });
  };

  const failureOf = (index: number, key: string): ReactNode => {
    const outcome = answers.get(answerKey(index, key));
    if (!outcome || outcome.ok) return null;
    return (
      <div data-telo-part="row-failure">
        <RootsContext.Provider value={{ error: outcome.error, input: outcome.input, values: outcome.input }}>
          <Node node={entries[index].action.failure} />
        </RootsContext.Provider>
      </div>
    );
  };

  /** An entry's `result` tree for a row, once its press succeeded; nothing otherwise. */
  const answerOf = (index: number, key: string): ReactNode => {
    const outcome = answers.get(answerKey(index, key));
    const { action } = entries[index];
    if (!outcome?.ok || action.result === undefined) return null;
    return (
      <div data-telo-part="row-answer">
        <RootsContext.Provider value={{ result: outcome.result, input: outcome.input, values: outcome.input }}>
          <Node node={action.result} />
        </RootsContext.Provider>
      </div>
    );
  };

  const control = (index: number, row: Row, key: string, options: ControlOptions = {}): ReactNode => {
    const answered = answerOf(index, key);
    if (answered) return answered;
    const entry = entries[index];
    const rowRoots = { ...roots, row };
    const allowed = conditionHolds(entry.enabled, rowRoots);
    const button: EntryButton = {
      label: text(entry.action.label),
      disabled: busyKeys.has(key) || options.disabled === true || !allowed,
      submitting: busyKeys.get(key) === index,
      press: () => press(index, row, key),
    };
    return (
      <>
        {options.button ? (
          options.button(button)
        ) : (
          <button data-telo-part="row-action" type="button" data-state={button.submitting ? "submitting" : undefined} disabled={button.disabled} onClick={button.press}>
            {button.label}
          </button>
        )}
        {options.beside}
        {!allowed && entry.enabled && <span data-telo-part="disabled-text">{text(entry.enabled.disabledText, undefined, rowRoots)}</span>}
        {failureOf(index, key)}
      </>
    );
  };

  const cell = (row: Row, key: string, disabled = false): ReactNode =>
    entries.map((_, index) => <Fragment key={index}>{control(index, row, key, { disabled })}</Fragment>);

  const menuCell = (row: Row, key: string, disabled = false, after: RowMenuEntry[] = []): ReactNode => {
    const rowRoots = { ...roots, row };
    const busy = busyKeys.has(key);
    const answered: ReactNode[] = [];
    const offered: RowMenuEntry[] = [];
    entries.forEach((entry, index) => {
      const drawn = answerOf(index, key);
      if (drawn) {
        answered.push(<Fragment key={index}>{drawn}</Fragment>);
        return;
      }
      const allowed = conditionHolds(entry.enabled, rowRoots);
      offered.push({
        key: `action:${index}`,
        label: text(entry.action.label),
        disabled: busy || disabled || !allowed,
        ...(!allowed && entry.enabled ? { hint: text(entry.enabled.disabledText, undefined, rowRoots) } : {}),
        run: () => press(index, row, key),
      });
    });
    return (
      <>
        {answered}
        <RowMenu entries={[...offered, ...after]} />
        {[...entries.keys()].map((index) => (
          <Fragment key={index}>{failureOf(index, key)}</Fragment>
        ))}
      </>
    );
  };

  let dialog: ReactNode = null;
  if (asking) {
    const rowRoots = { ...roots, ...asking.extra, row: asking.row };
    dialog = (
      <RootsContext.Provider value={rowRoots}>
        <PressDialog
          key={answerKey(asking.index, asking.key)}
          entry={entries[asking.index]}
          busy={asking.busy}
          failure={asking.failure}
          onSend={(input) => send(asking.index, asking.row, asking.key, asking.extra, input, true)}
          onClose={() => asking.busy || setAsking(undefined)}
        />
      </RootsContext.Provider>
    );
  }

  return {
    cell,
    control,
    menuCell,
    dialog,
    press,
    failure: failureOf,
    busy: (key) => busyKeys.has(key),
    retain: (keys) =>
      setAnswers((current) => {
        const kept = [...current].filter(([held]) => keys.has(held.slice(held.indexOf("\u0000") + 1)));
        return kept.length === current.size ? current : new Map(kept);
      }),
    clear: () => setAnswers((current) => (current.size === 0 ? current : new Map())),
  };
}

interface PressDialogProps {
  entry: RowActionSpec;
  busy: boolean;
  failure?: RequestError;
  /** Send the record; what it came to, or nothing when it was not sent. */
  onSend(input: Record<string, unknown>): Promise<Outcome | undefined>;
  onClose(): void;
}

/**
 * The confirmation of one press, drawn over the row and the roots in scope.
 * With a prompt, its fields enter the action's input model as a form does —
 * kept, and followed across the entries sharing their state key, as the
 * action's own state says — and the entered values and the bound ones make
 * one record, held whole to the input model before anything is sent: a
 * property it refuses that no field enters is named under the fields. The
 * bound values are always sent, and never drawn.
 */
function PressDialog({ entry, busy, failure, onSend, onClose }: PressDialogProps) {
  const roots = useContext(RootsContext);
  const say = useSay();
  const text = useText();
  const id = useId();
  const { action, prompt } = entry;
  const entered = useRecordEntry({ schema: action.schema, fields: prompt?.fields ?? [], groups: [], state: prompt ? action.state : UNKEPT });

  const submit = async () => {
    if (busy) return;
    const bound = boundRecord(entry, roots);
    let input = bound;
    if (prompt) {
      const checked = entered.check(bound);
      if (!checked.ok) return;
      input = { ...checked.record, ...bound };
      const asked = new Set(prompt.fields.map((field) => field.property));
      const labels = new Map(action.fields.map((field) => [field.property, field.label]));
      const unentered = validate(action.schema, input)
        .filter((finding) => !asked.has(finding.path[0]))
        .map((finding) => {
          const why = say(finding.text.key, finding.text.values);
          const property = finding.path[0];
          if (property === undefined) return why;
          const label = labels.get(property);
          return `${label === undefined ? property : text(label)}: ${why}`;
        });
      if (unentered.length > 0) return entered.refuse({}, unentered);
    }
    const outcome = await onSend(input);
    if (prompt && outcome && !outcome.ok && outcome.error.status === 400) {
      const { byField, other } = refusalOf(outcome.body, entered.shown, say);
      entered.refuse(byField, other);
    }
  };

  return (
    <Confirmation
      title={text(entry.confirm ?? action.label)}
      confirm={text(action.label)}
      danger={false}
      busy={busy}
      failure={failure && { type: "error", code: failure.code ?? "", message: failure.message ?? "" }}
      onConfirm={() => void submit()}
      onClose={onClose}
    >
      {prompt && (
        <form
          data-telo-part="form"
          autoComplete="off"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Fields id={id} schema={entered.schema} fields={entered.shown} values={entered.values} roots={entered.roots} errors={entered.errors} onChange={entered.change} />
          {entered.formError && (
            <div data-telo-part="form-error" role="alert">
              {entered.formError}
            </div>
          )}
        </form>
      )}
    </Confirmation>
  );
}
