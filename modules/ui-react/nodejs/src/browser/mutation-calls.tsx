import { Fragment, useContext, useId, useRef, useState, type ReactNode } from "react";
import { conditionHolds, readBinding } from "./bindings.js";
import type { KeptState } from "./form-state.js";
import { useDestinationContext } from "./destination.js";
import { useHost } from "./host.js";
import { MutationRunnerContext, type MutationCallSpec, type Outcome } from "./mutation-call.js";
import { Node } from "./nodes.js";
import { RowMenu, type RowMenuEntry } from "./row-menu.js";
import { useRecordEntry } from "./record-entry.js";
import { Fields, refusalOf } from "./record-fields.js";
import { RendererContext, RootsContext } from "./renderer-context.js";
import { Confirmation } from "./surface.js";
import type { RequestError } from "./ui-error.js";
import { useSay, useText } from "./texts.js";

type Row = Record<string, unknown>;
type Roots = Readonly<Record<string, unknown>>;

/** A call whose confirmation is open: being asked about, sent, or refused. */
interface Asking {
  index: number;
  row: Row;
  key: string;
  /** The roots the press binds beside the row: a move's `to`. */
  extra: Roots;
  busy: boolean;
  failure?: RequestError;
}

/** The record a call sends: each input it binds, read over the row and the
 *  roots in scope when it is pressed — what its prompt entered as `prompt`; a
 *  path that leads nowhere is left out. */
export function boundRecord(entry: Pick<MutationCallSpec, "inputs">, roots: Roots): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [property, binding] of Object.entries(entry.inputs)) {
    const read = readBinding(binding, roots);
    if ("value" in binding || (read.present && read.value !== null)) record[property] = read.present ? read.value : undefined;
  }
  return record;
}

const answerKey = (index: number, key: string) => `${index}\u0000${key}`;

/** What a prompt keeps: nothing, since the dialog is its only place. */
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

export interface MutationCalls {
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
 * The calls of one table, list, annotated text or button: each runs its
 * mutation through the page's runner, so a `serial` mutation queues across
 * every place it is run from. A row is one entry: it takes no press while its
 * last is pending or queued. A pressed call's `result` tree is drawn in place
 * of its button, in a `mutation-result`, over `result` and `input` (the record
 * sent); a failure is drawn beside the button in a `mutation-failure`, or in
 * the confirmation when one is open. `roots` are the roots the rows are drawn
 * under; `succeeded` is told about each success, with what it answered and the
 * row's key, and about a refused precondition with nothing, so the listing reads again.
 */
export function useMutationCalls(
  entries: MutationCallSpec[],
  roots: Roots,
  succeeded: (result: Record<string, unknown> | undefined, key: string) => void,
  /** The element a page the success opens is placed against, where the entries are drawn as one element. */
  opener?: () => HTMLElement | null,
): MutationCalls {
  const host = useHost();
  const destinations = useDestinationContext();
  const say = useSay();
  const text = useText();
  const { prefix } = useContext(RendererContext);
  /** What names a call: its label; a layout's move has none and is the "Move to" gesture. */
  const labelOf = (entry: MutationCallSpec): string => (entry.label === undefined ? say("moveTo") : text(entry.label));
  const runner = useContext(MutationRunnerContext);
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
    hold(key, index);
    answer(answerKey(index, key), undefined);
    if (inDialog) setAsking({ index, row, key, extra, busy: true });
    // What follows a success is the runner's, so it happens whether or not this place is still drawn.
    const outcome = await runner.execute(entry, input, { host, prefix, say, destinations, naming: labelOf(entry), opener, placed: { ...roots, ...extra, row } });
    hold(key, undefined);
    if (outcome.ok) {
      setAsking(undefined);
      if (entry.result !== undefined) answer(answerKey(index, key), outcome);
      succeeded(outcome.result, key);
      return outcome;
    }
    // A record changed since it was read: the listing reads it again.
    if (outcome.error.status === 412) succeeded(undefined, key);
    if (!inDialog) {
      answer(answerKey(index, key), outcome);
      return outcome;
    }
    // A prompt shows a refusal as a form does, on its fields: the dialog draws it.
    const onFields = outcome.error.status === 400 && entry.prompt !== null;
    setAsking({ index, row, key, extra, busy: false, ...(onFields ? {} : { failure: outcome.error }) });
    return outcome;
  };

  const press = (index: number, row: Row, key: string, extra: Roots = {}) => {
    if (pending.current.has(key)) return;
    const entry = entries[index];
    if (entry.confirm === undefined && entry.prompt === null) return void send(index, row, key, extra, boundRecord(entry, { ...roots, ...extra, row }), false);
    setAsking({ index, row, key, extra, busy: false });
  };

  const failureOf = (index: number, key: string): ReactNode => {
    const outcome = answers.get(answerKey(index, key));
    if (!outcome || outcome.ok) return null;
    return (
      <div data-telo-part="mutation-failure">
        <RootsContext.Provider value={{ error: outcome.error, input: outcome.input }}>
          <Node node={entries[index].failure} />
        </RootsContext.Provider>
      </div>
    );
  };

  /** An entry's `result` tree for a row, once its press succeeded; nothing otherwise. */
  const answerOf = (index: number, key: string): ReactNode => {
    const outcome = answers.get(answerKey(index, key));
    const { result } = entries[index];
    if (!outcome?.ok || result === undefined) return null;
    return (
      <div data-telo-part="mutation-result">
        <RootsContext.Provider value={{ result: outcome.result, input: outcome.input }}>
          <Node node={result} />
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
      label: labelOf(entry),
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
        label: labelOf(entry),
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
  entry: MutationCallSpec;
  busy: boolean;
  failure?: RequestError;
  /** Send the record; what it came to, or nothing when it was not sent. */
  onSend(input: Record<string, unknown>): Promise<Outcome | undefined>;
  onClose(): void;
}

/**
 * The question or prompt of one press, drawn over the row and the roots in
 * scope. A prompt's fields enter its own schema as a form's do, and only an
 * entry that fits it goes on: what was entered is then read as `prompt` where
 * the inputs bind, the record they make is sent, and a refusal that names an
 * entered property lands on its field. The bound values are always sent, and
 * never drawn.
 */
function PressDialog({ entry, busy, failure, onSend, onClose }: PressDialogProps) {
  const roots = useContext(RootsContext);
  const say = useSay();
  const text = useText();
  const id = useId();
  const { prompt } = entry;
  const entered = useRecordEntry({ schema: prompt?.schema ?? {}, fields: prompt?.fields ?? [], groups: prompt?.groups ?? [], state: UNKEPT });
  const label = entry.label === undefined ? say("moveTo") : text(entry.label);

  const submit = async () => {
    if (busy) return;
    let scope = roots;
    if (prompt) {
      const checked = entered.check();
      if (!checked.ok) return;
      scope = { ...roots, prompt: checked.record };
    }
    const outcome = await onSend(boundRecord(entry, scope));
    if (prompt && outcome && !outcome.ok && outcome.error.status === 400) {
      const { byField, other } = refusalOf(outcome.body, entered.shown, say);
      entered.refuse(byField, other);
    }
  };

  return (
    <Confirmation
      title={entry.confirm === undefined ? label : text(entry.confirm)}
      confirm={entry.label === undefined ? say("save") : label}
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
          <Fields id={id} schema={entered.schema} fields={entered.shown} groups={entered.groups} values={entered.values} roots={entered.roots} errors={entered.errors} onChange={entered.change} />
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
