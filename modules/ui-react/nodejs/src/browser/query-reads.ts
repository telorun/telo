import type { ResponseWatcher } from "./host.js";
import { findingText, type Say } from "./texts.js";
import { ReloadTimer } from "./timed-reload.js";
import { requestErrorOf, unansweredError, type RequestError } from "./ui-error.js";
import { validate, type JsonSchema } from "./validation.js";

/** What holds for every request one query makes: its identity and when it is read again. */
export interface QueryTerms {
  id: string;
  schema: JsonSchema;
  reloadOn: readonly string[];
  /** Milliseconds; absent when the read is not repeated. */
  reloadEvery?: number;
}

/** One request a query resolved to. */
export interface QueryRequest {
  method: "GET" | "QUERY" | "POST";
  /** What is fetched: the address under the application's mount. */
  url: string;
  /** The app-relative path writers announce a change at; absent for an address leaving the application. */
  changeAt?: string;
  /** The JSON body sent; absent when nothing is. */
  body?: { value: unknown };
}

export type Outcome = { ok: true; data: Record<string, unknown> } | { ok: false; error: RequestError };

/** What one read holds: its last outcome — and whether a tick of `reloadEvery`
 *  produced it — and the last answer that succeeded. */
export interface ReadState {
  outcome?: Outcome & { tick: boolean };
  data?: Record<string, unknown>;
}

/** A mounted node drawing a query, as the reads see it. */
export interface Holder {
  /** Whether the node is shown. */
  visible: boolean;
  /** What the node is drawn inside: told each response its read gets. */
  watchers: readonly ResponseWatcher[];
  /** The node's own watcher, given to what it draws; never told of its own read. */
  own: ResponseWatcher;
  say: Say;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
type OnChanged = (path: string, listener: () => void) => () => void;

/** One request of one query and every node drawing it. */
class Read {
  readonly holders = new Set<Holder>();
  state: ReadState = {};
  controller?: AbortController;
  /** A trigger arrived while a read was in flight: read once more after it. */
  again = false;
  /** A trigger arrived while no holder was shown — the first read included. */
  wanted = true;
  timer?: ReloadTimer;
  readonly stops: (() => void)[] = [];

  constructor(
    readonly key: string,
    readonly terms: QueryTerms,
    readonly request: QueryRequest,
  ) {}

  get shown(): boolean {
    for (const holder of this.holders) if (holder.visible) return true;
    return false;
  }

  /** The texts of a shown holder, else of any. */
  get say(): Say {
    const holders = [...this.holders];
    return (holders.find((holder) => holder.visible) ?? holders[0]).say;
  }
}

/**
 * Every query read of one application: one read per query and resolved
 * request, shared by every node drawing it. A read is held while a mounted node
 * resolves to it, reads only while one of them is shown, and is dropped — its
 * request in flight aborted — when the last lets go. At most one request is in
 * flight per read; any number of triggers during it cause exactly one more.
 */
export class QueryReads {
  private readonly reads = new Map<string, Read>();
  private readonly holding = new Map<Holder, Read>();
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(
    private readonly fetch: Fetch,
    private readonly onChanged: OnChanged,
  ) {}

  /** The key one request of one query is read under: two queries are two reads whatever they resolve to. */
  static keyOf(id: string, request: QueryRequest): string {
    return JSON.stringify([id, request.method, request.url, request.body === undefined ? null : [request.body.value]]);
  }

  /** How many reads are held. */
  get size(): number {
    return this.reads.size;
  }

  state(key: string): ReadState | undefined {
    return this.reads.get(key)?.state;
  }

  readonly subscribe = (key: string, listener: () => void): (() => void) => {
    const listeners = this.listeners.get(key) ?? new Set();
    this.listeners.set(key, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  };

  /** Hold the read at `key` for a node, creating it; the returned function lets go. */
  hold(key: string, terms: QueryTerms, request: QueryRequest, holder: Holder): () => void {
    let read = this.reads.get(key);
    if (!read) {
      read = new Read(key, terms, request);
      this.reads.set(key, read);
      this.arm(read);
    }
    read.holders.add(holder);
    this.holding.set(holder, read);
    this.follow(read);
    const held = read;
    return () => this.release(held, holder);
  }

  /** Say that a holder was shown or hidden. */
  shown(holder: Holder): void {
    const read = this.holding.get(holder);
    if (read) this.follow(read);
  }

  /** Read the query at `key` again. */
  trigger(key: string): void {
    const read = this.reads.get(key);
    if (read) this.run(read, false);
  }

  /** What reads a read again besides its nodes: a change at its path, focus, a timer. */
  private arm(read: Read): void {
    const { terms, request } = read;
    if (request.changeAt !== undefined) read.stops.push(this.onChanged(request.changeAt, () => this.run(read, false)));
    if (terms.reloadOn.includes("focus")) {
      const onFocus = () => this.run(read, false);
      const onShow = (event: PageTransitionEvent) => event.persisted && this.run(read, false);
      window.addEventListener("focus", onFocus);
      window.addEventListener("pageshow", onShow);
      read.stops.push(() => {
        window.removeEventListener("focus", onFocus);
        window.removeEventListener("pageshow", onShow);
      });
    }
    if (terms.reloadEvery !== undefined) {
      read.timer = new ReloadTimer(
        terms.reloadEvery,
        () => read.controller !== undefined,
        () => this.run(read, true),
      );
    }
  }

  /** Bring a read up to its holders: its timer runs while one is shown, and a trigger that waited is read. */
  private follow(read: Read): void {
    if (!read.shown) {
      read.timer?.stop();
      return;
    }
    read.timer?.start();
    if (read.wanted) this.run(read, false);
  }

  private release(read: Read, holder: Holder): void {
    read.holders.delete(holder);
    if (this.holding.get(holder) === read) this.holding.delete(holder);
    if (read.holders.size > 0) return this.follow(read);
    read.controller?.abort();
    read.timer?.stop();
    for (const stop of read.stops) stop();
    this.reads.delete(read.key);
  }

  private run(read: Read, tick: boolean): void {
    if (this.reads.get(read.key) !== read) return;
    if (!read.shown) {
      read.wanted = true;
      return;
    }
    if (read.controller) {
      read.again = true;
      return;
    }
    read.wanted = false;
    const controller = new AbortController();
    read.controller = controller;
    const settled = this.answer(read, controller.signal, read.say).catch(
      (error): Outcome => ({
        ok: false,
        error: { code: "ERR_UI_RESPONSE_INVALID", message: error instanceof Error ? error.message : String(error) },
      }),
    );
    void settled.then((outcome) => {
      if (controller.signal.aborted || this.reads.get(read.key) !== read) return;
      read.controller = undefined;
      read.state = { outcome: { ...outcome, tick }, data: outcome.ok ? outcome.data : read.state.data };
      for (const listener of [...(this.listeners.get(read.key) ?? [])]) listener();
      if (read.again) {
        read.again = false;
        this.run(read, false);
      }
    });
  }

  /** The record contract's read: a 2xx JSON object valid against the model; anything else is a failure. */
  private async answer(read: Read, signal: AbortSignal, say: Say): Promise<Outcome> {
    const { method, url, body } = read.request;
    let response: Response;
    try {
      response = await this.fetch(url, {
        method,
        headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body.value) }),
        signal,
      });
    } catch (error) {
      return { ok: false, error: unansweredError(error, say) };
    }
    if (signal.aborted) return { ok: false, error: unansweredError(signal.reason, say) };
    this.tell(read, response);
    let answer: unknown;
    let parsed = true;
    try {
      answer = await response.json();
    } catch {
      // Not JSON: a failure keeps its status, a success is refused below.
      parsed = false;
    }
    if (!response.ok) return { ok: false, error: requestErrorOf(response.status, answer, say) };
    const invalid = (message: string): Outcome => ({ ok: false, error: { status: response.status, code: "ERR_UI_RESPONSE_INVALID", message } });
    if (!parsed) return invalid(say("answerNotJson"));
    if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return invalid(say("answerNotObject"));
    const findings = validate(read.terms.schema, answer, [], { formats: false });
    if (findings.length > 0) return invalid(say("answerNotModel", { detail: findingText(findings[0], say) }));
    return { ok: true, data: answer as Record<string, unknown> };
  }

  /** Tell what the read's nodes are drawn inside of its response, once each — never a node drawing this read. */
  private tell(read: Read, response: Response): void {
    const own = new Set([...read.holders].map((holder) => holder.own));
    const told = new Set<ResponseWatcher>();
    for (const holder of read.holders) {
      for (const watcher of holder.watchers) {
        if (own.has(watcher) || told.has(watcher)) continue;
        told.add(watcher);
        watcher(response);
      }
    }
  }
}
