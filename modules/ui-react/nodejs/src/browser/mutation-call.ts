import { createContext } from "react";
import { addressReads, resolveRefresh, resolveRequest, type AddressWire } from "./address-wire.js";
import type { Binding, Condition } from "./bindings.js";
import { destinationReads, openDestination, resolveDestination, type DestinationContext, type DestinationWire } from "./destination.js";
import type { Host } from "./host.js";
import type { Field, Group } from "./record-fields.js";
import { underMount } from "./renderer-context.js";
import { errorSpec, requestErrorOf, unansweredError, type RequestError } from "./ui-error.js";
import { validate, type JsonSchema } from "./validation.js";
import { findingText, type Say, type WireText } from "./texts.js";
import type { ToastWire } from "./toasts.js";

type Node = { type: string } & Record<string, any>;

export type RequestMethod = "POST" | "PUT" | "PATCH" | "DELETE";

/** A declared write as a renderer receives it: the same for every call of it on the page. */
export interface MutationSpec {
  /** The declaration's identity: every call of it shares one `concurrency` queue. */
  id: string;
  /** The record the inputs make, which every request is judged against. */
  schema: JsonSchema;
  /** What a success's body is held to; absent when no answer is declared. */
  answer?: JsonSchema;
  method: RequestMethod;
  url: AddressWire;
  /** The input properties the url reads whole, which the body leaves out. */
  consumed: string[];
  /** The request targets announced after a success. */
  invalidates: AddressWire[];
  concurrency: "parallel" | "serial";
}

/** What a call asks before it runs: the shape of the entries and the fields entering them. */
export interface PromptSpec {
  schema: JsonSchema;
  fields: Field[];
  groups: Group[];
}

/** What follows an answer: a destination, a toast, or closing the surface the call ran in. */
export type EffectSpec = DestinationWire | ToastWire | { type: "close" };

/** Whether an effect reads the named root: a destination's address, or a toast's text, link and call inputs. */
export function effectReads(effect: EffectSpec, root: string): boolean {
  if (effect.type === "close") return false;
  if (effect.type !== "toast") return destinationReads(effect, root);
  const reads = (binding: unknown) => (binding as { root?: unknown } | null)?.root === root;
  const textReadsRoot = (text: unknown) => Object.values((text as { values?: Record<string, unknown> }).values ?? {}).some(reads);
  return (
    textReadsRoot(effect.text) ||
    (effect.link !== undefined && (destinationReads(effect.link.to, root) || textReadsRoot(effect.link.label))) ||
    (effect.call !== undefined && (Object.values(effect.call.inputs).some(reads) || textReadsRoot(effect.call.label)))
  );
}

/** What a call is, wherever it is held: a row's, an annotation's, a `button` node's or a layout's move. */
export interface MutationCallSpec {
  mutation: MutationSpec;
  inputs: Record<string, Binding>;
  /** The press's accessible name; a layout's move has none. */
  label?: WireText;
  /** The question asked before it runs. */
  confirm?: WireText;
  /** What its dialog enters before it runs; null when it asks nothing. */
  prompt: PromptSpec | null;
  enabled?: Condition & { disabledText: WireText };
  /** Run in order once the answer arrives. */
  onSuccess: EffectSpec[];
  /** Run in order when the write does not succeed, over `error` and `input`. */
  onFailure: EffectSpec[];
  /** What is drawn of a success; a layout's move draws none. */
  result?: Node;
  failure: Node;
}

/** What a press came to: the answer it drew from, or why it did not succeed.
 *  `input` is the record that was sent. */
export type Outcome =
  | { ok: true; result: Record<string, unknown> | undefined; input: Record<string, unknown>; target: string }
  | { ok: false; error: RequestError; input: Record<string, unknown>; body?: unknown };

/** Whether a property of the input holds a value the body carries: not nothing, null or an empty list. */
const valued = (value: unknown): boolean => value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);

/**
 * The mutation contract's request: the method to the target, a `DELETE` with no
 * body, any other with the input's valued properties minus the consumed ones
 * as JSON. Whatever the mutation answered is returned; no answer at all is thrown.
 */
export async function requestMutation(host: Host, url: string, mutation: MutationSpec, input: Record<string, unknown>): Promise<Response> {
  if (mutation.method === "DELETE") return host.fetch(url, { method: "DELETE" });
  const body = Object.fromEntries(Object.entries(input).filter(([property, value]) => !mutation.consumed.includes(property) && valued(value)));
  return host.fetch(url, { method: mutation.method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
      return boundReads(node.action as MutationCallSpec);
    case "list":
      return (
        readsAnswer(node.rows) ||
        readsAnswer(node.rowStyle?.by) ||
        (node.columns as { value: unknown; header?: unknown; shown?: { at: unknown }; style?: { by: unknown }; to?: DestinationWire }[]).some(
          (column) =>
            readsAnswer(column.value) || readsAnswer(column.shown?.at) || readsAnswer(column.style?.by) || textReads(column.header) || destinationReads(column.to, "result"),
        ) ||
        ((node.rowActions ?? []) as MutationCallSpec[]).some(boundReads)
      );
    default:
      return false;
  }
}

/** Whether a nested call's inputs or its condition read the enclosing answer. */
const boundReads = (call: MutationCallSpec): boolean => Object.values(call.inputs).some(readsAnswer) || readsAnswer(call.enabled?.at);

/** Whether a text's values read the answer. */
function textReads(text: unknown): boolean {
  const values = (text as { values?: Record<string, unknown> } | undefined)?.values;
  return values !== undefined && Object.values(values).some(readsAnswer);
}

/** What a call reads of the answer, for deciding whether its body is read at all. */
type Reads = Pick<MutationCallSpec, "mutation" | "onSuccess" | "result">;

/** A call, as the runner executes it. */
type Answered = Reads & Pick<MutationCallSpec, "onFailure">;

const readsBody = (call: Reads): boolean =>
  readsResult(call.result) || call.onSuccess.some((effect) => effectReads(effect, "result")) || call.mutation.invalidates.some((each) => addressReads(each, "result"));

/**
 * Send a record to a mutation, its path read under the mount `prefix`, and
 * read what it answered. The record is judged against the mutation's schema
 * first: one it refuses is not sent. A success's body is read only when what
 * follows reads it — the `result` tree, an effect or an invalidation through
 * it — and is then held to the declared answer.
 */
export async function runMutation(host: Host, prefix: string, call: Reads, input: Record<string, unknown>, say: Say): Promise<Outcome> {
  const { mutation } = call;
  const findings = validate(mutation.schema, input);
  if (findings.length > 0) {
    return { ok: false, error: { code: "ERR_UI_MUTATION_INPUT_INVALID", message: findingText(findings[0], say) }, input };
  }
  const resolved = resolveRequest(mutation.url, { input }, "mutation url");
  if (!resolved.ok) return { ok: false, error: { code: resolved.error.code, message: resolved.error.message }, input };
  const target = resolved.address;
  let response: Response;
  try {
    response = await requestMutation(host, underMount(prefix, target), mutation, input);
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
  // A success with no body (a 204) is a success unless something reads it.
  if (!readsBody(call)) return { ok: true, result: undefined, input, target };
  const invalid = (message: string): Outcome => ({ ok: false, error: { status: response.status, code: "ERR_UI_RESPONSE_INVALID", message }, input });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return invalid(say("answerNotJson"));
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return invalid(say("answerNotObject"));
  const answerFindings = mutation.answer ? validate(mutation.answer, body, [], { formats: false }) : [];
  if (answerFindings.length > 0) return invalid(say("answerNotModel", { detail: findingText(answerFindings[0], say) }));
  return { ok: true, result: body as Record<string, unknown>, input, target };
}

/** What a call runs in: the application it is pressed in, and what names it. */
export interface CallEnvironment {
  host: Host;
  /** Mount path with no trailing slash; empty at the root. */
  prefix: string;
  say: Say;
  destinations: Omit<DestinationContext, "address">;
  /** The text of what ran the call: the title of a page it opens that has none. */
  naming: string;
  /** Listings' own paths that read again beside the mutation's targets. */
  also?: readonly string[];
  /** The element a page the success opens is placed against, read when it opens. */
  opener?: () => HTMLElement | null;
  /** Where nothing is pressed (a toast's button), a page it opens is placed against no element. */
  unplaced?: boolean;
  /** Closes the opened surface the call ran in, if it is still open; absent where it ran in none. */
  close?: () => void;
  /** The roots the call is placed under; its effects read them beside `result` / `error` and `input`, which shadow them. */
  placed?: Readonly<Record<string, unknown>>;
  /** Told whether the write succeeded, before its lists run. */
  answered?: (ok: boolean) => void;
}

/**
 * The page shell's side of calls, one per page drawn. It owns what must not
 * follow the component that made a call: the queue of a `serial` mutation —
 * one per mutation `id`, shared by every call of it from a row, a button, an
 * annotation, a move or a form's write — and what a success does, which runs
 * here, from the request's answer, so it still happens once the surface the
 * call was pressed in has closed.
 */
export class MutationRunner {
  private readonly tails = new Map<string, Promise<void>>();

  /** `close` closes the opened surface the runner's calls are pressed in, if it is still open. */
  constructor(private readonly close?: () => void) {}

  /**
   * Run `work` — one request — once every earlier one of the same serial
   * mutation has finished; a parallel mutation's runs at once. This is the
   * entry for anything that writes a mutation, a form's `onSubmit` and
   * `autosave` included.
   */
  enqueue<T>(mutation: Pick<MutationSpec, "id" | "concurrency">, work: () => Promise<T>): Promise<T> {
    if (mutation.concurrency !== "serial") return work();
    const prior = this.tails.get(mutation.id) ?? Promise.resolve();
    const running = prior.then(work);
    const tail = running.then(
      () => {},
      () => {},
    );
    this.tails.set(mutation.id, tail);
    return running;
  }

  /**
   * What a success tells the page: every reader over the resolved target path,
   * each resolved `invalidates` path and `also` (a listing's own paths) reads
   * again. An invalidation that does not resolve is skipped.
   */
  invalidate(mutation: Pick<MutationSpec, "invalidates">, outcome: Extract<Outcome, { ok: true }>, env: CallEnvironment): void {
    const roots = { result: outcome.result, input: outcome.input };
    for (const path of [outcome.target, ...(env.also ?? [])]) env.host.notifyChanged(path);
    for (const each of mutation.invalidates) {
      const invalidated = resolveRefresh(each, roots, "mutation invalidates");
      if (invalidated !== undefined) env.destinations.store.notifyRefresh(invalidated);
    }
  }

  /**
   * Run effects in the order written over `roots`, each once the one before
   * has happened; a move the user chose to stay for ends the sequence. An
   * effect whose address does not resolve goes nowhere and the next runs. A
   * toast is posted into the application's toaster over the same roots, and
   * `close` closes the surface the call ran in.
   */
  async follow(effects: readonly EffectSpec[], roots: Readonly<Record<string, unknown>>, env: Pick<CallEnvironment, "destinations" | "naming" | "opener" | "unplaced" | "close">): Promise<void> {
    const close = env.close ?? this.close;
    for (const effect of effects) {
      if (effect.type === "toast") {
        env.destinations.store.toasts.post(effect, roots, close);
        continue;
      }
      if (effect.type === "close") {
        close?.();
        continue;
      }
      const destination = resolveDestination(effect, roots, "effect");
      if (destination === undefined) continue;
      const gone = await openDestination(
        destination.to,
        { ...env.destinations, address: destination.address },
        { naming: env.naming, opener: env.opener?.(), unplaced: env.unplaced },
      );
      if (!gone) return;
    }
  }

  /** What a call's success does beyond being drawn: its invalidations, then its effects over `result` and `input`. */
  async succeed(call: Pick<MutationCallSpec, "mutation" | "onSuccess">, outcome: Extract<Outcome, { ok: true }>, env: CallEnvironment): Promise<void> {
    this.invalidate(call.mutation, outcome, env);
    await this.follow(call.onSuccess, { ...env.placed, result: outcome.result, input: outcome.input }, env);
  }

  /** What a write that did not succeed does: its `onFailure` effects over `error` and `input`. */
  fail(call: Pick<MutationCallSpec, "onFailure">, outcome: Extract<Outcome, { ok: false }>, env: CallEnvironment): Promise<void> {
    return this.follow(call.onFailure, { ...env.placed, error: outcome.error, input: outcome.input }, env);
  }

  /** Run a call with its record: queued as its mutation says, then followed by its `onSuccess` or its `onFailure`. */
  async execute(call: Answered, input: Record<string, unknown>, env: CallEnvironment): Promise<Outcome> {
    const outcome = await this.enqueue(call.mutation, () => runMutation(env.host, env.prefix, call, input, env.say));
    env.answered?.(outcome.ok);
    const followed = outcome.ok ? this.succeed(call, outcome, env) : this.fail(call, outcome, env);
    followed.catch((error) => this.report(error, env));
    return outcome;
  }

  /** Follow `effects` where nothing awaits them, a list that could not run reported rather than lost. */
  run(effects: readonly EffectSpec[], roots: Readonly<Record<string, unknown>>, env: Parameters<MutationRunner["follow"]>[2]): void {
    this.follow(effects, roots, env).catch((error) => this.report(error, env));
  }

  /** A list that could not run is shown as a danger toast, which outlasts the place that pressed the call. */
  private report(error: unknown, env: Pick<CallEnvironment, "destinations">): void {
    const failure = errorSpec(error, "ERR_UI_EFFECT_FAILED");
    env.destinations.store.toast({ text: `${failure.code}: ${failure.message}`, tone: "danger" });
  }
}

/** The runner of the page being drawn. */
export const MutationRunnerContext = createContext(new MutationRunner());
