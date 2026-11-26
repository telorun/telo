import { Settling, type ChangeKind } from "./typing-pause.js";
import { equal, validate, type JsonSchema } from "./validation.js";

type Record_ = Record<string, unknown>;

/** What a form's `autosave` is doing: `submitting` while a write is in flight or held behind one, `error` after a failure until the next change or retry. */
export type AutosaveState = "idle" | "submitting" | "error";

/** What sends a write and hears of every change to the writes. */
export interface AutosaveHost {
  /**
   * Send one write, its record taken by `take` as the request starts — a
   * write waiting in a queue first is sent with the newest record by then;
   * resolves with whether the server acknowledged it. Never rejects.
   */
  send(take: () => Record_): Promise<boolean>;
  /** Something the form draws of its writes changed. */
  changed(): void;
}

/**
 * The writes of one form's `autosave`, as a renderer-neutral rule. A record is
 * sent when it is valid against the mutation's input model, differs from the
 * baseline and is not the record in flight. The baseline is the newest record
 * acknowledged — the starting record at first — and a failure clears it, since
 * the outcome is unknown. A choice sends at once, typed text after `debounce`,
 * the page becoming hidden sends what waits. A change made while a write is
 * pending is held, the newest replacing older, and sent when the pending write
 * answers: a write is never aborted and never reordered, and nothing is
 * retried but by `retry` or a submit flushing it. A write still waiting in a
 * queue to start takes every change made meanwhile, so it goes as one. Held to
 * `conformance/form-writes.json`.
 */
export class AutosaveWrites {
  private baseline: Record_ | null;
  private current: Record_;
  private inFlight?: Record_;
  /** The write in flight has not started yet: it takes the newest record when it does. */
  private queued = false;
  private held?: Record_;
  /** No write acknowledged since the last failure. */
  private failed = false;
  /** The last failure is drawn, until a change or a retry. */
  private failing = false;
  private readonly settling: Settling;
  private readonly idle: ((acknowledged: boolean) => void)[] = [];

  constructor(
    private readonly schema: JsonSchema,
    start: Record_,
    debounce: number,
    private readonly host: AutosaveHost,
  ) {
    this.baseline = start;
    this.current = start;
    this.settling = new Settling(() => this.offer(this.current), debounce);
  }

  get state(): AutosaveState {
    if (this.inFlight !== undefined || this.held !== undefined) return "submitting";
    return this.failing ? "error" : "idle";
  }

  /** Whether the form holds what is not saved: a record other than the baseline, a write waiting or in flight, or a failure with none acknowledged since. */
  get unsaved(): boolean {
    return this.failed || this.baseline === null || !equal(this.current, this.baseline) || this.settling.waiting || this.inFlight !== undefined || this.held !== undefined;
  }

  /** The record the inputs bind now changed, by a choice or by typing. */
  change(record: Record_, kind: ChangeKind): void {
    this.current = record;
    this.failing = false;
    if (!this.sendable(record)) {
      this.settling.cancel();
      this.held = undefined;
    } else if (this.inFlight !== undefined) {
      // Taken by the write waiting to start, or held at once to be sent when the pending write answers.
      this.settling.cancel();
      this.offer(record);
    } else this.settling.change(kind);
    this.host.changed();
  }

  /** A commit of typed text: what waits is sent now. */
  commit(): void {
    if (this.settling.waiting) this.settling.now();
  }

  /** The page became hidden: what waits is sent now. */
  hidden(): void {
    this.commit();
  }

  /** The retry button: the record held now is sent, whatever was sent before. */
  retry(): void {
    this.failing = false;
    this.offer(this.current);
    this.host.changed();
  }

  /** Drop what waits to be sent; a write in flight still answers. */
  discard(): void {
    this.settling.cancel();
    this.held = undefined;
    this.host.changed();
  }

  /** Send what is not saved — what waits, or the record held since a failure — and wait for every write: resolves with whether the last write answered was acknowledged, true when none was needed. */
  flush(): Promise<boolean> {
    this.commit();
    if (this.failed && this.inFlight === undefined && this.held === undefined) this.offer(this.current);
    if (this.inFlight === undefined && this.held === undefined) return Promise.resolve(!this.failed);
    return new Promise((resolve) => this.idle.push(resolve));
  }

  dispose(): void {
    this.settling.cancel();
  }

  private sendable(record: Record_): boolean {
    if (validate(this.schema, record).length > 0) return false;
    if (this.inFlight !== undefined) return !equal(record, this.inFlight);
    return this.baseline === null || !equal(record, this.baseline);
  }

  private offer(record: Record_): void {
    if (!this.sendable(record)) return;
    if (this.queued) this.inFlight = record;
    else if (this.inFlight !== undefined) this.held = record;
    else this.start(record);
  }

  private start(first: Record_): void {
    this.inFlight = first;
    this.queued = true;
    this.host.changed();
    const take = (): Record_ => {
      this.queued = false;
      return this.inFlight ?? first;
    };
    void this.host.send(take).then((acknowledged) => {
      const record = this.inFlight ?? first;
      this.inFlight = undefined;
      if (acknowledged) {
        this.baseline = record;
        this.failed = false;
        this.failing = false;
      } else {
        this.baseline = null;
        this.failed = true;
        this.failing = true;
      }
      const next = this.held;
      this.held = undefined;
      if (next !== undefined) this.offer(next);
      if (this.inFlight === undefined) for (const resolve of this.idle.splice(0)) resolve(acknowledged);
      this.host.changed();
    });
  }
}
