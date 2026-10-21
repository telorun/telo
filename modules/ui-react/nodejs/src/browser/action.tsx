import { useContext, useId, useRef, useState, type FormEvent } from "react";
import { conditionHolds, styleAttribute } from "./bindings.js";
import { useHost, useHostStore } from "./host.js";
import { Node, type SpecNode } from "./nodes.js";
import { followSuccess, PressQueueContext, runOperation, type ActionSpec, type Outcome } from "./operation.js";
import { useRecordEntry, type EntrySpec } from "./record-entry.js";
import { Fields, refusalOf } from "./record-fields.js";
import { RendererContext, RootsContext } from "./renderer-context.js";
import { useSay, useText } from "./texts.js";

/**
 * A button that runs an operation: the record its fields hold is checked in
 * the page against the input model and sent, and what the operation answered
 * is drawn under the form — the `result` tree over `result`, `input` and
 * `values` for a success, the `failure` tree over `error`, `input` and
 * `values` for anything else, a refusal also marking the fields it names. A
 * success then refreshes and navigates as `onSuccess` says. The fields keep
 * what they hold. The form takes no press while its last is pending or queued,
 * and a serial action's presses on this page run one after another. The
 * answer is cleared when a submission starts and when a property
 * `clearAnswerOn` lists changes. The button is enabled while the node's
 * `enabled` condition holds over the form's `values`.
 */
export function Action({ node }: { node: SpecNode }) {
  const action = node as unknown as ActionSpec;
  const host = useHost();
  const say = useSay();
  const text = useText();
  const store = useHostStore();
  const { pages } = useContext(RendererContext);
  const queues = useContext(PressQueueContext);
  const id = useId();
  const entry = useRecordEntry(action as unknown as EntrySpec);
  const { shown } = entry;
  const [answer, setAnswer] = useState<Outcome>();
  const [state, setState] = useState<"idle" | "submitting" | "error">("idle");
  // Read on the press itself, which can arrive before the disabled button is drawn.
  const pending = useRef(false);
  const roots = useContext(RootsContext);
  const current = entry.record;
  const allowed = action.enabled === undefined || conditionHolds(action.enabled, { ...roots, values: current });

  const run = async (event: FormEvent) => {
    event.preventDefault();
    if (!allowed || pending.current) return;
    setAnswer(undefined);
    // A hidden field's value is neither sent nor checked; the record is still
    // held to the input model, so a property it requires blocks the run.
    const checked = entry.check();
    if (!checked.ok) return setState("error");
    const input = checked.record;
    setState("submitting");
    pending.current = true;
    const outcome = await queues.run(action, () => runOperation(host, action, input, say));
    pending.current = false;
    setAnswer(outcome);
    if (!outcome.ok) {
      if (outcome.error.status === 400) {
        // A refusal still marks the fields it names.
        const { byField, other } = refusalOf(outcome.body, shown, say);
        const body = outcome.body as { details?: unknown } | undefined;
        entry.refuse(byField, Array.isArray(body?.details) ? other.filter((line) => line !== "") : []);
      }
      setState("error");
      return;
    }
    setState("idle");
    followSuccess(action, outcome.result, host, store, pages);
  };

  const change = (property: string, next: unknown) => {
    entry.change(property, next);
    if (action.clearAnswerOn.includes(property)) setAnswer(undefined);
  };

  return (
    <div data-telo-part="action" data-state={state} data-style={styleAttribute(node.style)}>
      <form data-telo-part="form" autoComplete="off" noValidate onSubmit={run}>
        <Fields
          id={id}
          schema={entry.schema}
          fields={shown}
          groups={entry.groups}
          values={entry.values}
          roots={entry.roots}
          errors={entry.errors}
          onChange={change}
        />
        {entry.formError && (
          <div data-telo-part="form-error" role="alert">
            {entry.formError}
          </div>
        )}
        <div data-telo-part="form-actions">
          <button data-telo-part="submit" type="submit" disabled={state === "submitting" || !allowed}>
            {text(action.label)}
          </button>
          {!allowed && action.enabled && (
            <span data-telo-part="disabled-text">{text(action.enabled.disabledText, undefined, { ...roots, values: current })}</span>
          )}
        </div>
      </form>
      {answer?.ok && action.result !== undefined && (
        <div data-telo-part="action-result">
          <RootsContext.Provider value={{ result: answer.result, input: answer.input, values: current }}>
            <Node node={action.result} />
          </RootsContext.Provider>
        </div>
      )}
      {answer && !answer.ok && (
        <div data-telo-part="action-failure">
          <RootsContext.Provider value={{ error: answer.error, input: answer.input, values: current }}>
            <Node node={action.failure} />
          </RootsContext.Provider>
        </div>
      )}
    </div>
  );
}
