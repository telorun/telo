import { createContext } from "react";
import { addressReads, resolveRefresh, resolveRequest, type AddressWire } from "./address-wire.js";
import type { Binding, Condition } from "./bindings.js";
import { destinationReads, openDestination, resolveDestination, type DestinationContext, type DestinationWire } from "./destination.js";
import type { KeptState } from "./form-state.js";
import type { Host } from "./host.js";
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
  request: { method: RequestMethod; target: AddressWire; consumed: string[] };
  label: WireText;
  fields: Field[];
  /** Where the values its fields enter are kept, its prompts' included. */
  state: KeptState;
  enabled?: Condition & { disabledText: WireText };
  /** What a success's body is held to; absent when no answer is declared. */
  answer?: JsonSchema;
  result?: Node;
  failure: Node;
  onSuccess: { to?: DestinationWire; refreshes: AddressWire[] };
  concurrency: "parallel" | "serial";
  clearAnswerOn: string[];
}

export type RequestMethod = "POST" | "PUT" | "PATCH" | "DELETE";

/** An operation run with bound inputs: a row's, an annotation's or a `button` node's. */
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
  | { ok: true; result: Record<string, unknown> | undefined; input: Record<string, unknown>; target: string }
  | { ok: false; error: RequestError; input: Record<string, unknown>; body?: unknown };

/** Whether a property of the input holds a value the body carries: not nothing, null or an empty list. */
const valued = (value: unknown): boolean => value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);

/**
 * The action contract's request: the method to the target, a `DELETE` with no
 * body, any other with the input's valued properties minus the consumed ones
 * as JSON. Whatever the operation answered is returned; no answer at all is thrown.
 */
export async function requestAction(host: Host, url: string, request: ActionSpec["request"], input: Record<string, unknown>): Promise<Response> {
  if (request.method === "DELETE") return host.fetch(url, { method: "DELETE" });
  const body = Object.fromEntries(Object.entries(input).filter(([property, value]) => !request.consumed.includes(property) && valued(value)));
  return host.fetch(url, { method: request.method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** Whether a binding reads `result`. */
const readsAnswer = (binding: unknown): boolean => (binding as { root?: unknown } | null)?.root === "result";

/**
 * Whether a tree drawn over an answer reads `result`. A node a composite
 * provided reads only its own roots, so only the tree's own nodes are read:
 * containers and their presses, links, menus, values, lists and the
 * conditions on them.
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
      return (
        (node.press != null && (destinationReads(node.press.to, "result") || textReads(node.press.label))) || (node.children as Node[]).some(readsResult)
      );
    case "link":
      return destinationReads(node.to, "result");
    case "menu":
      return (node.items as { to: DestinationWire; text: unknown; shown?: { at: unknown } }[]).some(
        (item) => destinationReads(item.to, "result") || textReads(item.text) || readsAnswer(item.shown?.at),
      );
    case "value":
      return readsAnswer(node.value) || destinationReads(node.to, "result");
    case "time":
      return readsAnswer(node.value);
    case "markdown":
      return readsAnswer(node.value) || (node.annotations !== undefined && (readsAnswer(node.annotations.rows) || boundReads(node.annotations.action)));
    case "button":
      return boundReads(node as unknown as RowActionSpec);
    case "list":
      return (
        readsAnswer(node.rows) ||
        readsAnswer(node.rowStyle?.by) ||
        (node.columns as { value: unknown; header?: unknown; shown?: { at: unknown }; style?: { by: unknown }; to?: DestinationWire }[]).some(
          (column) =>
            readsAnswer(column.value) || readsAnswer(column.shown?.at) || readsAnswer(column.style?.by) || textReads(column.header) || destinationReads(column.to, "result"),
        ) ||
        ((node.rowActions ?? []) as RowActionSpec[]).some(boundReads)
      );
    default:
      return false;
  }
}

/** Whether a bound action's inputs or its condition read the answer. */
const boundReads = (entry: RowActionSpec): boolean => Object.values(entry.inputs).some(readsAnswer) || readsAnswer(entry.enabled?.at);

/** Whether a text's values read the answer. */
function textReads(text: unknown): boolean {
  const values = (text as { values?: Record<string, unknown> } | undefined)?.values;
  return values !== undefined && Object.values(values).some(readsAnswer);
}

/**
 * Send a record to an operation, its path read under the mount `prefix`, and
 * read what it answered. A success's body is
 * read only when what follows reads it — the `result` tree, a destination or
 * a refresh through it — and is then held to the declared answer.
 */
export async function runOperation(
  host: Host,
  prefix: string,
  action: ActionSpec,
  input: Record<string, unknown>,
  say: Say,
): Promise<Outcome> {
  const resolved = resolveRequest(action.request.target, { input }, "action target");
  if (!resolved.ok) return { ok: false, error: { code: resolved.error.code, message: resolved.error.message }, input };
  const target = resolved.address;
  let response: Response;
  try {
    response = await requestAction(host, underMount(prefix, target), action.request, input);
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
  const { to, refreshes } = action.onSuccess;
  // A success with no body (a 204) is a success unless something reads it.
  if (!readsResult(action.result) && !destinationReads(to, "result") && !refreshes.some((each) => addressReads(each, "result"))) {
    return { ok: true, result: undefined, input, target };
  }
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
  return { ok: true, result: body as Record<string, unknown>, input, target };
}

/**
 * What a success does beyond being drawn: every reader over the resolved target
 * path, each resolved `refreshes` path and `also` (a listing's own paths) reads
 * again, then the page goes to the destination `to` names, its address over
 * `result` and `input` — a page it opens named by `naming`, the text of what
 * ran the action. A refresh that does not resolve is skipped; a destination
 * whose address does not goes nowhere.
 */
export function followSuccess(
  action: ActionSpec,
  outcome: Extract<Outcome, { ok: true }>,
  host: Host,
  context: Omit<DestinationContext, "address">,
  naming: string,
  also: readonly string[] = [],
): void {
  const roots = { result: outcome.result, input: outcome.input };
  for (const path of [outcome.target, ...also]) host.notifyChanged(path);
  for (const each of action.onSuccess.refreshes) {
    const refresh = resolveRefresh(each, roots, "action refresh");
    if (refresh !== undefined) context.store.notifyRefresh(refresh);
  }
  const destination = resolveDestination(action.onSuccess.to, roots, "action onSuccess to");
  if (destination !== undefined) openDestination(destination.to, { ...context, address: destination.address }, { naming });
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
    const queue = `${action.request.method} ${JSON.stringify(action.request.target.path)}`;
    const prior = this.tails.get(queue) ?? Promise.resolve();
    const running = prior.then(press);
    const tail = running.then(
      () => {},
      () => {},
    );
    this.tails.set(queue, tail);
    return running;
  }
}

/** The queues of the page being drawn. */
export const PressQueueContext = createContext(new PressQueues());
