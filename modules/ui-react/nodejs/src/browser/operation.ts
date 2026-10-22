import { createContext } from "react";
import { readBinding, type Binding, type Condition } from "./bindings.js";
import type { Host, HostStore } from "./host.js";
import { linkAddress } from "./link-address.js";
import type { Field } from "./record-fields.js";
import { underMount } from "./renderer-context.js";
import { requestErrorOf, unansweredError, type RequestError } from "./ui-error.js";
import { validate, type JsonSchema } from "./validation.js";
import { findingText, type Say, type WireText } from "./texts.js";

type Node = { type: string } & Record<string, any>;

/** An operation as a renderer receives it. */
export interface ActionSpec {
  type: "action";
  schema: JsonSchema;
  path: string;
  label: WireText;
  fields: Field[];
  enabled?: Condition & { disabledText: WireText };
  /** What a success's body is held to; absent when no answer is declared. */
  answer?: JsonSchema;
  result?: Node;
  failure: Node;
  onSuccess: { navigate?: Binding; refreshes: string[] };
  concurrency: "parallel" | "serial";
  clearAnswerOn: string[];
}

/** An operation a row offers. */
export interface RowActionSpec {
  action: ActionSpec;
  inputs: Record<string, Binding>;
  /** The question asked before it runs. */
  confirm?: WireText;
  /** What its dialog enters before it runs, as fields of the input model. */
  prompt?: { fields: Field[] };
  enabled?: Condition & { disabledText: WireText };
}

/** What a press came to: the answer it drew from, or why it did not succeed.
 *  `input` is the record that was sent. */
export type Outcome =
  | { ok: true; result: Record<string, unknown> | undefined; input: Record<string, unknown> }
  | { ok: false; error: RequestError; input: Record<string, unknown>; body?: unknown };

/** The action contract's request: one `POST` with a JSON body. Whatever the
 *  operation answered is returned; no answer at all is thrown. */
export async function requestAction(host: Host, path: string, record: Record<string, unknown>): Promise<Response> {
  return host.fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(record) });
}

/** Whether a binding reads `result`. */
const readsAnswer = (binding: unknown): boolean => (binding as { root?: unknown } | null)?.root === "result";

/**
 * Whether a tree drawn over an answer reads `result`. A node a composite
 * provided reads only its own roots, so only the tree's own nodes are read:
 * containers, values, lists and the conditions on them.
 */
export function readsResult(node: Node | undefined): boolean {
  if (!node) return false;
  if (readsAnswer(node.shown?.at)) return true;
  // A text formatted with values reads what they name.
  if (["text", "heading", "alt"].some((member) => textReads(node[member]))) return true;
  switch (node.type) {
    case "box":
    case "stack":
    case "columns":
      return (node.children as Node[]).some(readsResult);
    case "value":
      return readsAnswer(node.value);
    case "list":
      return (
        readsAnswer(node.rows) ||
        (node.columns as { value: unknown; header?: unknown; shown?: { at: unknown } }[]).some(
          (column) => readsAnswer(column.value) || readsAnswer(column.shown?.at) || textReads(column.header),
        ) ||
        ((node.rowActions ?? []) as RowActionSpec[]).some(
          (entry) => Object.values(entry.inputs).some(readsAnswer) || readsAnswer(entry.enabled?.at),
        )
      );
    default:
      return false;
  }
}

/** Whether a text's values read the answer. */
function textReads(text: unknown): boolean {
  const values = (text as { values?: Record<string, unknown> } | undefined)?.values;
  return values !== undefined && Object.values(values).some(readsAnswer);
}

/**
 * Send a record to an operation, its path read under the mount `prefix`, and
 * read what it answered. A success's body is
 * read only when what follows reads it — the `result` tree or a navigation
 * through it — and is then held to the declared answer.
 */
export async function runOperation(
  host: Host,
  prefix: string,
  action: ActionSpec,
  input: Record<string, unknown>,
  say: Say,
): Promise<Outcome> {
  let response: Response;
  try {
    response = await requestAction(host, underMount(prefix, action.path), input);
  } catch (error) {
    return { ok: false, error: unansweredError(error, say), input };
  }
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // A body that is not JSON: the status alone is the report.
    }
    return { ok: false, error: requestErrorOf(response.status, body, say), input, body };
  }
  const navigate = action.onSuccess.navigate;
  if (!readsResult(action.result) && !(navigate !== undefined && "root" in navigate)) return { ok: true, result: undefined, input };
  const invalid = (message: string): Outcome => ({ ok: false, error: { status: response.status, code: "ERR_UI_RESPONSE_INVALID", message }, input });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return invalid(say("answerNotJson"));
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return invalid(say("answerNotObject"));
  const findings = action.answer ? validate(action.answer, body) : [];
  if (findings.length > 0) return invalid(say("answerNotModel", { detail: findingText(findings[0], say) }));
  return { ok: true, result: body as Record<string, unknown>, input };
}

/**
 * What a success does beyond being drawn: every reader and table over a path
 * `refreshes` names reads again, then the page goes where `navigate` says — a
 * declared page within the application, any other app-relative address by a
 * load, an absolute one replacing the page. A value that is no such address
 * navigates nowhere.
 */
export function followSuccess(action: ActionSpec, result: Record<string, unknown> | undefined, host: Host, store: HostStore, pages: string[]): void {
  for (const path of action.onSuccess.refreshes) host.notifyChanged(path);
  const navigate = action.onSuccess.navigate;
  if (navigate === undefined) return;
  const read = readBinding(navigate, { result });
  if (!read.present || typeof read.value !== "string") return;
  const address = read.value;
  const href = linkAddress(store, address);
  if (href === undefined) return;
  if (address.startsWith("/")) {
    const path = new URL(address, "http://telo.invalid").pathname;
    if (pages.includes(path)) host.navigate(address);
    else store.leave(href);
    return;
  }
  store.leave(href);
}

/**
 * The presses of serial actions on one page, one queue per operation path: a
 * press runs once every press of the same operation made before it has
 * finished. A parallel press runs at once.
 */
export class PressQueues {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(action: ActionSpec, press: () => Promise<T>): Promise<T> {
    if (action.concurrency !== "serial") return press();
    const prior = this.tails.get(action.path) ?? Promise.resolve();
    const running = prior.then(press);
    const tail = running.then(
      () => {},
      () => {},
    );
    this.tails.set(action.path, tail);
    return running;
  }
}

/** The queues of the page being drawn. */
export const PressQueueContext = createContext(new PressQueues());
